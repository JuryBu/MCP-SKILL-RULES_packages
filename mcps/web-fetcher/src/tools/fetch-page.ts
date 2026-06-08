import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserManager } from "../browser.js";
import { extractContent, truncateContent, compactContent, cleanFooterGarbage, detectSPAIssue, detectEncodingIssue, safePageContent, type OutputMode } from "../extractor.js";
import { pageCache } from "../cache.js";
import { touchActivity } from "../lifecycle.js";
import { SUMMARY_CHAIN_VALUES, SUMMARY_PREVIEW_LENGTH, TEMP_PAGE_PREFIX, appendTiming, resolveSummaryModelChain, type SummaryChain } from "../constants.js";
import { buildSummaryPrompt, generateSummaryText } from "../model-bridge.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";
import TurndownService from "turndown";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

function envMs(name: string): number | undefined {
    const value = process.env[name];
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const WEB_AI_BACKGROUND_MAX_RUN_MS =
    envMs("WEB_FETCHER_WEB_AI_BACKGROUND_MAX_RUN_MS")
    ?? envMs("WEB_FETCHER_WEB_AI_BACKGROUND_TIMEOUT_MS")
    ?? 15 * 60_000;

const FetchPageInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .optional()
        .describe("要抓取的网页 URL（支持 file:// 本地文件）"),
    waitFor: z
        .string()
        .optional()
        .describe("可选的 CSS 选择器，等待该元素出现后再提取内容"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("页面加载超时时间（毫秒），默认 30000"),
    scrollCount: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .describe("页面滚动次数，用于加载懒加载内容（如评论区），默认 0 不滚动"),
    outputMode: z
        .enum(["summary", "full", "compact", "minimal", "headings", "ai_summary"])
        .optional()
        .describe(
            "输出模式控制返回内容量:\n" +
            "- summary (默认): 完整内容写入临时文件，只返回前1500字摘要+文件路径，最省上下文\n" +
            "- full: 完整内容直接返回(最多50000字)\n" +
            "- compact: 压缩到8000字，保留标题+每段3行\n" +
            "- minimal: 压缩到3000字，保留标题+每段1行\n" +
            "- headings: 只保留标题大纲(1500字)\n" +
            "- ai_summary: 🤖 AI 智能摘要，按模型链路优先级尝试 Antigravity/Codex/Claude Code"
        ),
    modelChain: z
        .enum(SUMMARY_CHAIN_VALUES)
        .optional()
        .describe("AI Summary 模型链路选择，仅 outputMode=ai_summary 时生效。未填时回退到 chain，再默认 auto"),
    chain: z
        .enum(SUMMARY_CHAIN_VALUES)
        .optional()
        .describe("兼容旧参数：AI Summary 模型链路选择。modelChain 未填时使用；未填默认 auto"),
    background: z
        .boolean()
        .optional()
        .describe("ai_summary 模式可设为 true，先返回 taskId，后续用 taskId 查询摘要结果"),
    taskId: z
        .string()
        .optional()
        .describe("查询 ai_summary 后台任务的 taskId"),
    waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe("查询后台任务时等待秒数，任务完成时提前返回"),
});

type FetchPageInput = z.infer<typeof FetchPageInputSchema>;

/**
 * 根据 URL 生成临时文件路径
 */
function getTempFilePath(url: string): string {
    const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 10);
    const safeName = url
        .replace(/https?:\/\//, "")
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")
        .slice(0, 40);
    return path.join(os.tmpdir(), `${TEMP_PAGE_PREFIX}${safeName}_${hash}.md`);
}

export function registerFetchPage(server: McpServer): void {
    server.registerTool(
        "web_fetch_page",
        {
            title: "抓取网页内容",
            description: `使用带 Cookie 的浏览器抓取网页，返回 Markdown 格式的正文内容。
适用于需要登录态才能查看的页面（如知乎、X/推特、B站等）。
会自动提取页面正文，去除导航栏、广告等噪音。
支持 file:// 协议打开本地文件（如 HTML）。

参数:
  - url (string, 必须): 要抓取的网页 URL（支持 http/https/file 协议）
- waitFor (string, 可选): CSS 选择器，等待该元素出现后再提取
- timeout (number, 可选): 超时毫秒数，默认 30000
- scrollCount (number, 可选): 滚动次数，用于加载评论区等懒加载内容，默认 0
- outputMode (string, 可选): 输出模式 summary(默认)/full/compact/minimal/headings/ai_summary
- modelChain (string, 可选): 仅 ai_summary 生效，可选 auto/antigravity/codex/claude-code；未填回退到 chain，再默认 auto
- chain (string, 可选): 兼容旧参数，仅 ai_summary 生效；modelChain 未填时使用

⚠️ 注意: PPTX 文本提取可能为空（幻灯片内容多为图形化排版），建议用 web_fetch_screenshot 截图查看 PPTX 内容。DOCX 文本提取正常。

返回: 取决于 outputMode:
  - summary: 摘要 + 临时文件路径（用 view_file 查看完整内容）
  - full: 完整内容直接返回(最多50000字)
  - compact: 压缩到8000字，保留标题+每段3行
  - minimal: 压缩到3000字，保留标题+每段1行
  - headings: 只保留标题大纲(1500字)
  - ai_summary: 🤖 AI 智能摘要（支持 Antigravity LS / Codex / Claude Code 三链路），精炼中文概括+完整内容临时文件路径`,
            inputSchema: {
                url: FetchPageInputSchema.shape.url,
                waitFor: FetchPageInputSchema.shape.waitFor,
                timeout: FetchPageInputSchema.shape.timeout,
                scrollCount: FetchPageInputSchema.shape.scrollCount,
                outputMode: FetchPageInputSchema.shape.outputMode,
                modelChain: FetchPageInputSchema.shape.modelChain,
                chain: FetchPageInputSchema.shape.chain,
                background: FetchPageInputSchema.shape.background,
                taskId: FetchPageInputSchema.shape.taskId,
                waitSeconds: FetchPageInputSchema.shape.waitSeconds,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: FetchPageInput) => {
            touchActivity();
            const startTime = Date.now();
            if (params.taskId) {
                const task = await waitForBackgroundTask(params.taskId, params.waitSeconds || 0);
                return appendTiming({
                    content: [{ type: "text" as const, text: formatBackgroundTask(task) }],
                }, startTime);
            }
            if (!params.url) {
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: "web_fetch_page 需要 url 参数；查询后台任务时只需 taskId。" }],
                };
            }

            const outputMode = params.outputMode || "summary";
            const modelChain = resolveSummaryModelChain(params.chain, params.modelChain);

            // v4.0: 本地文件快捷通道 — xlsx/纯文本文件无需浏览器
            if (params.url.startsWith("file://")) {
                const filePath = decodeURIComponent(params.url.replace(/^file:\/\/\/?/, ''));
                const { categorizeFile } = await import("../converter.js");
                const category = categorizeFile(filePath);

                if (category === "ebook") {
                    try {
                        const { extractEpubDocument, formatEpubAsMarkdown } = await import("../ebook/epub.js");
                        const document = extractEpubDocument(filePath);
                        const markdown = formatEpubAsMarkdown(document);
                        return appendTiming(await formatOutput(markdown, params.url, outputMode, modelChain, params.background), startTime);
                    } catch (e: any) {
                        const code = e?.code ? `${e.code}: ` : "";
                        const stage = e?.stage ? `\n阶段: ${e.stage}` : "";
                        const suggestion = e?.suggestion ? `\n建议: ${e.suggestion}` : "";
                        return {
                            isError: true,
                            content: [{
                                type: "text" as const,
                                text: `EPUB 解析失败: ${code}${e.message || String(e)}${stage}${suggestion}`,
                            }],
                        };
                    }
                }

                if (category === "text") {
                    // 纯文本文件：直接读取返回
                    try {
                        const textContent = fs.readFileSync(filePath, "utf-8");
                        const ext = path.extname(filePath);
                        const name = path.basename(filePath);
                        const header = `# ${name}\n\n\`\`\`${ext.slice(1)}\n${textContent}\n\`\`\``;
                        return appendTiming(await formatOutput(header, params.url, outputMode, modelChain, params.background), startTime);
                    } catch (e: any) {
                        return { isError: true, content: [{ type: "text" as const, text: `读取文件失败: ${e.message}` }] };
                    }
                }

                if (category === "office" && path.extname(filePath).toLowerCase().match(/\.xlsx?$/)) {
                    // Excel 文件：CSV 文本摘要
                    try {
                        const { xlsxToTextSummary } = await import("../converter.js");
                        const summary = await xlsxToTextSummary(filePath);
                        return appendTiming(await formatOutput(summary, params.url, outputMode, modelChain, params.background), startTime);
                    } catch (e: any) {
                        return { isError: true, content: [{ type: "text" as const, text: `Excel 解析失败: ${e.message}` }] };
                    }
                }

                // DOCX / PPTX 文件：LibreOffice 转文本提取
                if (category === "office" && path.extname(filePath).toLowerCase().match(/\.(docx?|pptx?)$/)) {
                    try {
                        const { detectConversionTools } = await import("../converter.js");
                        const tools = await detectConversionTools();
                        if (tools.libreoffice) {
                            const outDir = path.join(os.tmpdir(), "mcp-web-fetcher", "text-export");
                            fs.mkdirSync(outDir, { recursive: true });

                            const isPptx = path.extname(filePath).toLowerCase().match(/\.pptx?$/);

                            if (isPptx) {
                                // PPTX: 转 HTML 保留更多结构信息，再用 TurndownService 转 Markdown
                                await execFileAsync(
                                    tools.libreoffice,
                                    ["--headless", "--convert-to", "html:impress_html_Export", "--outdir", outDir, filePath],
                                    { timeout: 30000 }
                                );
                                const baseName = path.basename(filePath).replace(/\.[^.]+$/, "");
                                const htmlPath = path.join(outDir, `${baseName}.html`);

                                if (fs.existsSync(htmlPath)) {
                                    const htmlContent = fs.readFileSync(htmlPath, "utf-8");
                                    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
                                    td.remove(["script", "style", "noscript"]);
                                    const mdContent = td.turndown(htmlContent).trim();
                                    const name = path.basename(filePath);
                                    const header = `# ${name}\n\n${mdContent || "(空文档)"}`;
                                    try { fs.unlinkSync(htmlPath); } catch { }
                                    return appendTiming(await formatOutput(header, params.url, outputMode, modelChain, params.background), startTime);
                                }
                            } else {
                                // DOCX: 转 txt 已经足够好
                                await execFileAsync(
                                    tools.libreoffice,
                                    ["--headless", "--convert-to", "txt:Text (encoded):UTF8", "--outdir", outDir, filePath],
                                    { timeout: 30000 }
                                );
                                const baseName = path.basename(filePath).replace(/\.[^.]+$/, "");
                                const txtPath = path.join(outDir, `${baseName}.txt`);

                                if (fs.existsSync(txtPath)) {
                                    const textContent = fs.readFileSync(txtPath, "utf-8").trim();
                                    const name = path.basename(filePath);
                                    const header = `# ${name}\n\n${textContent || "(空文档)"}`;
                                    try { fs.unlinkSync(txtPath); } catch { }
                                    return appendTiming(await formatOutput(header, params.url, outputMode, modelChain, params.background), startTime);
                                }
                            }
                        }
                        // LibreOffice 不可用或转换失败 → 回退到浏览器渲染路径
                        console.error("[web-fetcher] DOCX/PPTX 文本提取回退到浏览器路径");
                    } catch (e: any) {
                        console.error(`[web-fetcher] DOCX/PPTX 文本提取失败: ${e.message}，回退到浏览器路径`);
                    }
                }
            }

            // PageCache: 无特殊参数时使用缓存（scrollCount/waitFor 跳过）
            const useCache = !params.scrollCount && !params.waitFor;
            if (useCache) {
                const cached = pageCache.get(params.url);
                if (cached) {
                    // 缓存命中也需要按 outputMode 处理
                return appendTiming(await formatOutput(cached, params.url, outputMode, modelChain, params.background), startTime);
                }
            }

            let page;
            try {
                page = await browserManager.navigateTo(params.url, {
                    waitFor: params.waitFor,
                    timeout: params.timeout,
                    scrollCount: params.scrollCount,
                });

                // === iframe 内容智能提取 ===
                let iframeHtmlParts: string[] = [];
                try {
                    const iframeNames = await page.evaluate(() => {
                        const iframes = document.querySelectorAll("iframe");
                        return Array.from(iframes)
                            .map((el) => (el as HTMLIFrameElement).name || (el as HTMLIFrameElement).id)
                            .filter((n) => n.length > 0);
                    });

                    if (iframeNames.length > 0) {
                        console.error(`[web-fetcher] 检测到 ${iframeNames.length} 个 iframe: ${iframeNames.join(", ")}`);

                        for (const frameName of iframeNames) {
                            try {
                                const frame = page.frame({ name: frameName });
                                if (!frame) continue;

                                // 智能轮询等待 iframe 内容就绪
                                let contentLoaded = false;
                                for (let round = 0; round < 2 && !contentLoaded; round++) {
                                    if (round === 1) {
                                        const pageUrl = page.url();
                                        if (pageUrl.includes("#")) {
                                            await page.evaluate(() => {
                                                const hash = window.location.hash;
                                                window.location.hash = "";
                                                window.location.hash = hash;
                                                window.dispatchEvent(new HashChangeEvent("hashchange"));
                                            });
                                            await page.waitForTimeout(2000);
                                        } else {
                                            break;
                                        }
                                    }

                                    let lastLength = 0;
                                    let stableCount = 0;
                                    for (let attempt = 0; attempt < 16; attempt++) {
                                        try {
                                            const currentLength = await frame.evaluate(
                                                () => document.body?.innerHTML?.length || 0
                                            );
                                            if (currentLength > 200) {
                                                if (currentLength === lastLength) {
                                                    stableCount++;
                                                    if (stableCount >= 2) {
                                                        contentLoaded = true;
                                                        break;
                                                    }
                                                } else {
                                                    stableCount = 0;
                                                }
                                            }
                                            lastLength = currentLength;
                                        } catch { /* frame 尚不可访问 */ }
                                        await page.waitForTimeout(500);
                                    }
                                }

                                // 提取并清理 iframe 内容
                                try {
                                    const frameHtml = await frame.evaluate(() => {
                                        const cleanSelectors = [
                                            "script", "style", "noscript", "textarea",
                                            "input", "select", "button",
                                            '[style*="display:none"]', '[style*="display: none"]',
                                            '[style*="visibility:hidden"]', '[style*="visibility: hidden"]',
                                            ".f-hide", ".f-dn",
                                            ".m-layer", ".m-login",
                                            '[data-action="login"]',
                                        ];
                                        const clone = document.body.cloneNode(true) as HTMLElement;
                                        for (const sel of cleanSelectors) {
                                            clone.querySelectorAll(sel).forEach((el) => el.remove());
                                        }
                                        return clone.innerHTML;
                                    });
                                    if (frameHtml.length > 100) {
                                        iframeHtmlParts.push(frameHtml);
                                    }
                                } catch { /* 跨域或不可访问 */ }
                            } catch { /* 跳过 */ }
                        }
                    }
                } catch { /* iframe 检测出错不影响正常功能 */ }

                // === 内容提取 ===
                let resultContent: string;

                // PDF 文件：优先使用 pdf.js getTextContent 精确提取的文本
                const pdfTexts = await page.evaluate(() => (window as any).__mcpPdfInfo?.texts).catch(() => null);
                if (pdfTexts && typeof pdfTexts === 'object' && Object.keys(pdfTexts).length > 0) {
                    const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo);
                    const totalPages = pdfInfo?.totalPages || 0;
                    const pageNums = Object.keys(pdfTexts).map(Number).sort((a, b) => a - b);
                    const textParts = pageNums.map(pn =>
                        `## 第 ${pn} 页\n\n${pdfTexts[pn]}`
                    );
                    const fileName = params.url.split('/').pop() || 'PDF';
                    resultContent = `# ${decodeURIComponent(fileName)}\n\n> PDF 文档，共 ${totalPages} 页，提取了 ${pageNums.length} 页文本\n\n${textParts.join('\n\n---\n\n')}`;
                } else if (iframeHtmlParts.length > 0) {
                    const td = new TurndownService({
                        headingStyle: "atx",
                        codeBlockStyle: "fenced",
                        bulletListMarker: "-",
                    });
                    td.remove(["script", "style", "noscript"]);
                    const iframeMarkdown = iframeHtmlParts
                        .map((h) => td.turndown(h))
                        .join("\n\n");
                    const pageTitle = await page.title() || "无标题";
                    resultContent = cleanFooterGarbage(truncateContent(`# ${pageTitle}\n\n${iframeMarkdown}`));
                } else {
                    const html = await safePageContent(page);
                    let { content } = extractContent(html, params.url);

                    // v5.2: NGA 等 GBK 编码站点修复 — 检测到锟斤拷乱码时，
                    // 用 Node.js HTTP 请求获取原始字节流，iconv-lite 解码 GBK→UTF-8
                    if (detectEncodingIssue(content)) {
                        try {
                            const iconv = (await import('iconv-lite')).default;
                            const https = await import('https');
                            const http = await import('http');
                            // 从浏览器 context 获取 Cookie 传给独立 HTTP 请求
                            const context = page.context();
                            const cookies = await context.cookies(params.url);
                            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                            const rawHtml = await new Promise<string>((resolve, reject) => {
                                const mod = params.url!.startsWith('https') ? https : http;
                                const req = mod.get(params.url!, {
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                        'Accept-Language': 'zh-CN,zh;q=0.9',
                                        ...(cookieStr ? { 'Cookie': cookieStr } : {}),
                                    },
                                }, (res) => {
                                    const chunks: Buffer[] = [];
                                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                                    res.on('end', () => {
                                        const raw = Buffer.concat(chunks);
                                        // 检测 charset：优先 HTTP 头，其次 HTML meta
                                        const ctHeader = res.headers['content-type'] || '';
                                        let charset = 'utf-8';
                                        const headerMatch = ctHeader.match(/charset\s*=\s*([\w-]+)/i);
                                        if (headerMatch) charset = headerMatch[1];
                                        else {
                                            // 从原始字节中搜索 meta charset（ASCII 安全）
                                            const head = raw.slice(0, 2048).toString('ascii');
                                            const metaMatch = head.match(/charset\s*=\s*["']?([\w-]+)/i);
                                            if (metaMatch) charset = metaMatch[1];
                                        }
                                        try {
                                            resolve(iconv.decode(raw, charset));
                                        } catch {
                                            resolve(raw.toString('utf-8'));
                                        }
                                    });
                                    res.on('error', reject);
                                });
                                req.on('error', reject);
                                req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
                            });
                            const reDecoded = extractContent(rawHtml, params.url);
                            if (!detectEncodingIssue(reDecoded.content)) {
                                content = reDecoded.content;
                            }
                        } catch { /* HTTP 重取失败时保留原始内容 */ }
                    }

                    resultContent = content;
                }

                // v6.1: UAV 人机验证检测已下沉到 navigateTo 层级统一处理
                // 所有工具（screenshot/rich/page/html/interact）自动受益

                // v5.2: SPA 空壳检测 — 内容过少时提示用户添加 scrollCount
                const spaHint = detectSPAIssue(resultContent, params.url);
                if (spaHint) {
                    resultContent += spaHint;
                }

                // v5.2: URL 跳转诊断 — 检测 B站视频页等被重定向的情况
                const finalUrl = page.url();
                if (finalUrl !== params.url) {
                    const requestedVideo = params.url.match(/bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/);
                    if (requestedVideo && !finalUrl.includes('/video/')) {
                        resultContent += `\n\n⚠️ URL 跳转检测：请求的视频页 ${requestedVideo[1]} 被重定向到了 ${finalUrl}，BV 号可能不正确或视频已下架。`;
                    }
                }

                // 缓存成功结果（仅内容足够丰富时）
                if (useCache && resultContent && resultContent.length > 100) {
                    pageCache.set(params.url, resultContent);
                }

                return appendTiming(await formatOutput(resultContent, params.url, outputMode, modelChain, params.background), startTime, browserManager.lastRetryCount);
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);

                let hint = "可能的原因:\n- URL 无效或无法访问\n- 页面加载超时（可尝试增加 timeout 参数）\n- 指定的 waitFor 选择器未找到";

                if (message.includes("ERR_CONNECTION_CLOSED") || message.includes("ERR_CONNECTION_RESET")) {
                    hint = "⚠️ 连接被目标网站关闭，最常见的原因是 Cookie/登录态过期。\n\n建议操作:\n1. 使用 web_login_browser 工具重新登录该网站\n2. 登录完成后关闭浏览器窗口\n3. 然后重试此请求";
                } else if (message.includes("ERR_SSL") || message.includes("ERR_CERT")) {
                    hint = "⚠️ SSL/证书错误，网站可能存在安全问题或被拦截。";
                } else if (message.includes("Timeout") || message.includes("timeout")) {
                    hint = "⏱️ 页面加载超时。建议:\n- 增加 timeout 参数（如 60000）\n- 某些网站首次访问较慢，可重试一次";
                }

                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: `抓取页面失败: ${message}\n\n${hint}`,
                        },
                    ],
                };
            } finally {
                if (page) {
                    await page.close().catch(() => { });
                }
            }
        }
    );
}

/**
 * 根据 outputMode 格式化输出
 */
async function formatOutput(content: string, url: string, outputMode: string, modelChain: SummaryChain = "auto", background = false) {
    // ai_summary 模式：调用 Flash 模型生成智能摘要
    if (outputMode === "ai_summary") {
        return formatAiSummary(content, url, modelChain, background);
    }

    if (outputMode === "summary") {
        // 写入临时文件，返回摘要 + 文件路径
        const filePath = getTempFilePath(url);
        try {
            fs.writeFileSync(filePath, content.endsWith('\n') ? content : content + '\n', "utf-8");
        } catch (e) {
            // 写入失败则降级为 compact 模式内联返回
            console.error(`[web-fetcher] 临时文件写入失败: ${e}`);
            return {
                content: [{
                    type: "text" as const,
                    text: compactContent(content, "compact"),
                }],
            };
        }

        // 生成摘要预览
        const preview = content.slice(0, SUMMARY_PREVIEW_LENGTH);
        const lastNewline = preview.lastIndexOf("\n");
        const cutPreview = lastNewline > SUMMARY_PREVIEW_LENGTH * 0.6 ? preview.slice(0, lastNewline) : preview;

        const summaryText = [
            cutPreview,
            "",
            "---",
            `📄 完整内容 (${content.length} 字符) 已保存到: ${filePath}`,
            "使用 view_file 工具查看完整内容。",
        ].join("\n");

        return {
            content: [{
                type: "text" as const,
                text: summaryText,
            }],
        };
    }

    // 其他模式：内联返回
    let outputContent = content;
    if (outputMode !== "full") {
        outputContent = compactContent(content, outputMode as OutputMode);
    }

    return {
        content: [{
            type: "text" as const,
            text: outputContent,
        }],
    };
}

/**
 * AI Summary 模式：调用模型桥生成智能摘要
 * 指定链路不可用或调用失败时降级为 compact 模式
 */
async function formatAiSummary(content: string, url: string, modelChain: SummaryChain = "auto", background = false) {
    // 1. 先写完整内容到临时文件（无论 AI 是否可用都保留原文）
    const filePath = getTempFilePath(url);
    try {
        fs.writeFileSync(filePath, content.endsWith('\n') ? content : content + '\n', "utf-8");
    } catch { /* non-critical */ }

    // 2. 构造统一 prompt 并通过桥接调用
    const { prompt } = buildSummaryPrompt(content, url);
    if (background) {
        const task = startBackgroundTask("web-fetch-ai-summary", async () => {
            const result = await generateSummaryText(prompt, modelChain, getAiSummaryBackgroundTimeoutMs());
            if (result.text && result.providerLabel && result.chainUsed) {
                const summaryChars = result.text.length;
                const ratio = ((1 - summaryChars / content.length) * 100).toFixed(0);
                return [
                    `🤖 AI 摘要 (by ${result.providerLabel})`,
                    "",
                    result.text,
                    "",
                    "---",
                    `📄 完整内容保存于: ${filePath}`,
                    `🔗 使用链路: ${result.chainUsed}`,
                    `📊 原文 ${content.length} 字 → 摘要 ${summaryChars} 字 (压缩 ${ratio}%)`,
                ].join("\n");
            }
            return [
                `⚠️ AI Summary 后台任务失败（modelChain=${modelChain}）`,
                result.error ? `📋 ${result.error}` : "",
                `📄 完整内容保存于: ${filePath}`,
            ].filter(Boolean).join("\n");
        }, {
            maxRunMs: WEB_AI_BACKGROUND_MAX_RUN_MS,
            timeoutMessage: `Web AI Summary 后台任务超时（${Math.round(WEB_AI_BACKGROUND_MAX_RUN_MS / 1000)}s）`,
        });
        return {
            content: [{
                type: "text" as const,
                text: [
                    "🚀 AI Summary 已转入后台任务",
                    `🆔 taskId: ${task.id}`,
                    `🔗 modelChain: ${modelChain}`,
                    `⏳ deadlineAt: ${task.deadlineAt}`,
                    `📄 完整内容保存于: ${filePath}`,
                    "💡 后续调用 web_fetch_page(taskId=\"...\", waitSeconds=30-45) 查询结果",
                ].join("\n"),
            }],
        };
    }

    let lastAiSummaryError: string | undefined;
    try {
        const result = await generateSummaryText(prompt, modelChain);

        if (result.text && result.providerLabel && result.chainUsed) {
            // AI 摘要成功
            const summaryChars = result.text.length;
            const ratio = ((1 - summaryChars / content.length) * 100).toFixed(0);

            const resultText = [
                `🤖 AI 摘要 (by ${result.providerLabel})`,
                "",
                result.text,
                "",
                "---",
                `📄 完整内容保存于: ${filePath}`,
                `🔗 使用链路: ${result.chainUsed}`,
                `📊 原文 ${content.length} 字 → 摘要 ${summaryChars} 字 (压缩 ${ratio}%)`,
            ].join("\n");

            return {
                content: [{
                    type: "text" as const,
                    text: resultText,
                }],
            };
        }
        if (result.error) {
            console.error(`[web-fetcher] AI Summary 调用失败: ${result.error}`);
            lastAiSummaryError = result.error;
        }
    } catch (err) {
        lastAiSummaryError = err instanceof Error ? err.message : String(err);
        console.error(`[web-fetcher] AI Summary 调用失败: ${lastAiSummaryError}`);
    }

    // 3. 降级：链路不可用或调用失败 → 回退到 compact 模式
    console.error("[web-fetcher] AI Summary 降级为 compact 模式");
    const compactText = compactContent(content, "compact");
    const fallbackText = [
        `⚠️ AI Summary 不可用（modelChain=${modelChain}），已降级为 compact 模式`,
        lastAiSummaryError ? `📋 ${lastAiSummaryError}` : "",
        "",
        compactText,
        "",
        "---",
        fs.existsSync(filePath) ? `📄 完整内容保存于: ${filePath}` : "",
    ].filter(Boolean).join("\n");

    return {
        content: [{
            type: "text" as const,
            text: fallbackText,
        }],
    };
}

function getAiSummaryBackgroundTimeoutMs(): number {
    const candidates = [
        process.env.WEB_FETCHER_WEB_AI_BACKGROUND_MODEL_TIMEOUT_MS,
        process.env.WEB_FETCHER_CLAUDE_CODE_BACKGROUND_TIMEOUT_MS,
        process.env.WEB_FETCHER_CODEX_BACKGROUND_TIMEOUT,
    ];
    for (const value of candidates) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 5 * 60_000;
}
