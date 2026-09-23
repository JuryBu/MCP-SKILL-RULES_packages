import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inlineImageContent } from "../image-output.js";
import { browserManager } from "../browser.js";
import { sessionManager } from "../session.js";
import { samePageTarget } from "../page-access.js";
import { randomUUID } from "node:crypto";
import { viewportSchema, assertViewportTarget, applyExplicitViewport } from "../viewport.js";
import { extractContent, compactContent, truncateContent, cleanFooterGarbage, detectSPAIssue, detectEncodingIssue, safePageContent, type OutputMode } from "../extractor.js";
import { touchActivity } from "../lifecycle.js";
import {
    QUALITY_PRESETS,
    type ImageQuality, type SaveMode,
    appendTiming,
    resolveSummaryModelChain,
    SUMMARY_CHAIN_VALUES,
} from "../constants.js";
import { saveTempFile, generateCacheKey, splitOversizedImage } from "../temp-store.js";
import { buildSummaryPrompt, generateSummaryText } from "../model-bridge.js";

const FetchRichInputSchema = z.object({
    viewport: viewportSchema.optional(),
    sessionId: z.string().optional().describe("已有网页会话 ID；借用当前页，不导航、不使用缓存"),
    ownerId: z.string().optional().describe("会话所属 ownerId"),
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .optional()
        .describe("要抓取的网页 URL"),
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
        .describe("截图/提取前滚动次数，默认 0"),
    compact: z
        .enum(["full", "compact", "minimal", "headings", "ai_summary"])
        .optional()
        .describe("文本压缩模式: full(完整)/compact(8000字)/minimal(3000字)/headings(纯标题)/ai_summary(🤖AI智能摘要)，默认 compact"),
    modelChain: z
        .enum(SUMMARY_CHAIN_VALUES)
        .optional()
        .describe("AI Summary 模型链路选择，仅 compact=ai_summary 时生效。未填时回退到 chain，再默认 auto"),
    chain: z
        .enum(SUMMARY_CHAIN_VALUES)
        .optional()
        .describe("兼容旧参数：AI Summary 模型链路选择。modelChain 未填时使用；未填默认 auto"),
    quality: z
        .enum(["hd", "clear", "default", "compact", "fast"])
        .optional()
        .describe("图片质量: hd/clear/default/compact/fast，默认 default"),
    saveMode: z
        .enum(["file", "inline"])
        .optional()
        .describe("截图输出模式: inline(默认，直接图片+文本)/file(显式返回临时文件路径)"),
    page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("PDF/Office文件的页码（默认1），如 page:3 截取第3页"),
    pages: z
        .string()
        .optional()
        .describe("PDF/Office多页截取: \"all\"/\"1-5\"/\"1,4,5\"/\"1-3,6-9,18\"。多页截图建议用 web_fetch_screenshot"),
});

type FetchRichInput = z.infer<typeof FetchRichInputSchema>;

export function registerFetchRich(server: McpServer): void {
    server.registerTool(
        "web_fetch_rich",
        {
            title: "截图+文本一次获取",
            description: `一次调用同时获取网页截图和 Markdown 文本内容。
减少往返次数，适合需要"看一眼页面 + 拿到可搜索文本"的常见场景。
支持 file:// 协议打开本地文件（HTML、PDF、DOCX 等）。

参数:
  - url (string, 可选): 要抓取的网页 URL（支持 http/https/file 协议）；与 sessionId 至少提供一个
  - sessionId (string, 可选): 从已有网页会话当前页读取，不导航；不支持文档路线
  - ownerId (string, 可选): 借用会话的 ownerId
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - scrollCount (number, 可选): 滚动次数，默认 0
  - compact (string, 可选): 文本压缩模式 full/compact/minimal/headings/ai_summary，默认 compact
  - modelChain (string, 可选): 仅 ai_summary 生效，可选 auto/antigravity/codex/claude-code；未填回退到 chain，再默认 auto
  - chain (string, 可选): 兼容旧参数，仅 ai_summary 生效；modelChain 未填时使用
  - quality (string, 可选): 图片质量 hd/clear/default/compact/fast，默认 default
  - viewport (object, 可选): 网页 CSS 视口 {width,height}，显式指定时不会被 quality 重设；不模拟设备 UA/触摸，文件预览不适用
  - saveMode (string, 可选): inline(默认，直接图片+文本，最多10张含分片、base64总长12MiB)/file(显式返回临时文件路径)
  - page (number, 可选): PDF/Office文件的页码（默认1），截取指定页
  - pages (string, 可选): PDF/Office多页截取: "all"/"1-5"/"1,4,5"/"1-3,6-9,18"

返回: 同时包含截图和 Markdown 文本`,
            inputSchema: {
                viewport: FetchRichInputSchema.shape.viewport,
                url: FetchRichInputSchema.shape.url,
                sessionId: FetchRichInputSchema.shape.sessionId,
                ownerId: FetchRichInputSchema.shape.ownerId,
                timeout: FetchRichInputSchema.shape.timeout,
                scrollCount: FetchRichInputSchema.shape.scrollCount,
                compact: FetchRichInputSchema.shape.compact,
                modelChain: FetchRichInputSchema.shape.modelChain,
                chain: FetchRichInputSchema.shape.chain,
                quality: FetchRichInputSchema.shape.quality,
                saveMode: FetchRichInputSchema.shape.saveMode,
                page: FetchRichInputSchema.shape.page,
                pages: FetchRichInputSchema.shape.pages,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: FetchRichInput) => {
            touchActivity();
            const startTime = Date.now();
            const quality: ImageQuality = (params.quality || "default") as ImageQuality;
            const saveMode: SaveMode = params.saveMode || "inline";
            const modelChain = resolveSummaryModelChain(params.chain, params.modelChain);
            const qConfig = QUALITY_PRESETS[quality];

            let page;
            let borrowedPage = false;
            let sourceUrl = params.url ?? "";
            try {
                if (!params.url && !params.sessionId) throw new Error("需要 url 或 sessionId 参数");
                if (params.sessionId && (params.page || params.pages)) throw new Error("sessionId 不支持 PDF/Office 文档页码路线");
                if (params.url && !params.sessionId) assertViewportTarget(params.url, params.viewport);
                // 解析多页参数
                let pageNumbers: number[] | undefined;
                if (params.pages && params.url) {
                    const parsePagesStr = (s: string): number[] => {
                        if (s.toLowerCase() === "all") return [];
                        const pages = new Set<number>();
                        for (const part of s.split(",").map(p => p.trim())) {
                            if (part.includes("-")) {
                                const [start, end] = part.split("-").map(Number);
                                if (!isNaN(start) && !isNaN(end)) {
                                    for (let i = start; i <= end && i <= 999; i++) pages.add(i);
                                }
                            } else {
                                const n = Number(part);
                                if (!isNaN(n)) pages.add(n);
                            }
                        }
                        return [...pages].sort((a, b) => a - b);
                    };
                    pageNumbers = parsePagesStr(params.pages);

                    // pages="all" 返回空数组，需先导航获取总页数再展开
                    if (pageNumbers.length === 0) {
                        const probePage = await browserManager.navigateTo(params.url, {
                            viewport: params.viewport,
                            timeout: params.timeout,
                        });
                        try {
                            const totalPages = await probePage.evaluate(
                                () => (window as any).__mcpPdfInfo?.totalPages || 1
                            );
                            pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
                        } finally {
                            await probePage.close().catch(() => { });
                        }
                    }
                }

                if (params.sessionId) {
                    page = sessionManager.get(params.sessionId, params.ownerId);
                    if (!page) throw new Error("会话不存在、已关闭或 ownerId 不匹配");
                    borrowedPage = true;
                    sourceUrl = page.url();
                    if (!/^https?:\/\//i.test(sourceUrl) || /\.(?:pdf|docx?|pptx?|xlsx?|epub)(?:[?#]|$)/i.test(sourceUrl)) {
                        throw new Error("sessionId 只支持已打开的普通 http(s) 网页，不支持 file/Office/PDF/EPUB 文档路线");
                    }
                    if (params.url && !samePageTarget(sourceUrl, params.url)) throw new Error(`url 与现有会话页面不匹配：当前为 ${sourceUrl}`);
                    await browserManager.checkAndHandleVerification(page, sourceUrl);
                    if (params.scrollCount) await browserManager.scrollPage(page, params.scrollCount);
                } else {
                    page = await browserManager.navigateTo(sourceUrl, {
                        viewport: params.viewport,
                        timeout: params.timeout,
                        scrollCount: params.scrollCount,
                        pageNumber: params.page,
                        pageNumbers: pageNumbers && pageNumbers.length > 0 ? pageNumbers : undefined,
                    });
                }

                // 根据 quality 调整视口（file:// 跳过，防止裁剪）
                const isLocalFile = sourceUrl.startsWith("file://");
                await applyExplicitViewport(page, params.viewport);
                if (!borrowedPage && !params.viewport && !isLocalFile && qConfig.viewportWidth !== 1920) {
                    const currentSize = page.viewportSize();
                    if (currentSize && currentSize.width !== qConfig.viewportWidth) {
                        await page.setViewportSize({
                            width: qConfig.viewportWidth,
                            height: currentSize.height,
                        });
                        await page.waitForTimeout(200);
                    }
                }

                // 1) 截图
                // v6.1: 截图前等待视觉资源就绪
                const readiness = await browserManager.waitForVisualReady(page, undefined, { fullPage: false });
                const readinessWarning = readiness.complete === false && readiness.note ? `\n⚠️ ${readiness.note}` : "";
                await browserManager.checkAndHandleVerification(page, page.url?.() ?? sourceUrl);
                let screenshotBuffer = await page.screenshot({
                    type: "jpeg",
                    quality: qConfig.jpegQuality,
                    fullPage: false,
                });

                // 截图有效性验证
                if (!readiness.complete && screenshotBuffer.length < 5 * 1024) {
                    await page.waitForTimeout(3000);
                    screenshotBuffer = await page.screenshot({
                        type: "jpeg",
                        quality: qConfig.jpegQuality,
                        fullPage: false,
                    });
                }

                const sizeKB = (screenshotBuffer.length / 1024).toFixed(1);

                // 读取 PDF 页码信息（如有）
                let pageInfo = readinessWarning;
                try {
                    const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo);
                    if (pdfInfo) {
                        pageInfo = ` — 第${pdfInfo.currentPage}页/共${pdfInfo.totalPages}页${readinessWarning}`;
                    }
                } catch { }

                // 2) 文本提取
                const html = await safePageContent(page);
                let { content } = extractContent(html, sourceUrl);

                // v5.2: NGA 等 GBK 编码站点修复 — Node.js HTTP + iconv
                if (!borrowedPage && detectEncodingIssue(content)) {
                    try {
                        const iconv = (await import('iconv-lite')).default;
                        const https = await import('https');
                        const http = await import('http');
                        // 从浏览器 context 获取 Cookie
                        const context = page.context();
                        const cookies = await context.cookies(sourceUrl);
                        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        const rawHtml = await new Promise<string>((resolve, reject) => {
                            const mod = sourceUrl.startsWith('https') ? https : http;
                            const req = mod.get(sourceUrl, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    'Accept': 'text/html',
                                    ...(cookieStr ? { 'Cookie': cookieStr } : {}),
                                },
                            }, (res) => {
                                const chunks: Buffer[] = [];
                                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                                res.on('end', () => {
                                    const raw = Buffer.concat(chunks);
                                    const ctHeader = res.headers['content-type'] || '';
                                    let charset = 'utf-8';
                                    const headerMatch = ctHeader.match(/charset\s*=\s*([\w-]+)/i);
                                    if (headerMatch) charset = headerMatch[1];
                                    else {
                                        const head = raw.slice(0, 2048).toString('ascii');
                                        const metaMatch = head.match(/charset\s*=\s*["']?([\w-]+)/i);
                                        if (metaMatch) charset = metaMatch[1];
                                    }
                                    try { resolve(iconv.decode(raw, charset)); }
                                    catch { resolve(raw.toString('utf-8')); }
                                });
                                res.on('error', reject);
                            });
                            req.on('error', reject);
                            req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
                        });
                        const reDecoded = extractContent(rawHtml, sourceUrl);
                        if (!detectEncodingIssue(reDecoded.content)) {
                            content = reDecoded.content;
                        }
                    } catch { /* HTTP 重取失败时保留原始内容 */ }
                }

                // v6.1: UAV 人机验证检测已下沉到 navigateTo 层级统一处理
                // 所有工具（screenshot/rich/page/html/interact）自动受益

                // v5.2: SPA 空壳检测
                await browserManager.checkAndHandleVerification(page, page.url?.() ?? sourceUrl);
                sourceUrl = page.url?.() ?? sourceUrl;
                const spaHint = detectSPAIssue(content, sourceUrl);
                if (spaHint) {
                    content += spaHint;
                }
                const compactMode = params.compact || "compact";
                let finalContent: string;

                if (compactMode === "ai_summary") {
                    // AI Summary 模式：通过模型桥生成智能摘要
                    try {
                        const { prompt } = buildSummaryPrompt(content, sourceUrl);
                        const result = await generateSummaryText(prompt, modelChain);
                        if (result.text && result.providerLabel && result.chainUsed) {
                            const ratio = ((1 - result.text.length / content.length) * 100).toFixed(0);
                            finalContent = `🤖 AI 摘要 (by ${result.providerLabel})\n\n${result.text}\n\n---\n🔗 使用链路: ${result.chainUsed}\n📊 原文 ${content.length} 字 → 摘要 ${result.text.length} 字 (压缩 ${ratio}%)`;
                        } else {
                            finalContent = `⚠️ AI Summary 不可用（modelChain=${modelChain}），已降级为 compact${result.error ? `\n📋 ${result.error}` : ""}\n\n${compactContent(content, "compact")}`;
                        }
                    } catch (err) {
                        console.error(`[web-fetcher] fetch-rich AI Summary 失败: ${err instanceof Error ? err.message : err}`);
                        finalContent = `⚠️ AI Summary 不可用（modelChain=${modelChain}），已降级为 compact\n\n${compactContent(content, "compact")}`;
                    }
                } else {
                    finalContent = compactMode === "full" ? content : compactContent(content, compactMode as OutputMode);
                }

                // 根据 saveMode 返回截图
                if (saveMode === "file") {
                    const cacheKey = borrowedPage ? randomUUID() : generateCacheKey(params.url ?? sourceUrl, quality, "rich", params.scrollCount, params.page, ...(params.viewport ? [params.viewport.width, params.viewport.height] : []));
                    const splitResult = await splitOversizedImage(screenshotBuffer, "screenshots", cacheKey, ".jpg");
                    if (splitResult.wasSplit) {
                        const fileList = splitResult.paths.map((p, i) =>
                            `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`
                        ).join("\n");
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `📐 ${splitResult.description}${pageInfo} + 文本提取完成 [${compactMode}]\n\n${fileList}\n\n使用 view_file 按顺序查看截图\n\n${finalContent}`,
                            }],
                        }, startTime, browserManager.lastRetryCount);
                    }
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `截图 (${splitResult.sizes[0]} KB)${pageInfo} + 文本提取完成 [${compactMode}]\n截图: ${splitResult.paths[0]} (用 view_file 查看)\n\n${finalContent}`,
                        }],
                    }, startTime, browserManager.lastRetryCount);
                } else {
                    return appendTiming({
                        content: [
                            { type: "text" as const, text: `截图 (${sizeKB} KB)${pageInfo} + 文本提取完成 [${compactMode}]\n\n${finalContent}` },
                            ...await inlineImageContent(screenshotBuffer, `截图${pageInfo}`),
                        ],
                    }, startTime, browserManager.lastRetryCount);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                let hint = "";
                if (message.includes("ERR_CONNECTION_CLOSED") || message.includes("ERR_CONNECTION_RESET")) {
                    hint = "\n\n⚠️ 连接被关闭，可能是登录态过期。建议使用 web_login_browser 重新登录。";
                } else if (message.includes("Timeout") || message.includes("timeout")) {
                    hint = "\n\n⏱️ 建议增加 timeout 参数（如 60000）或重试。";
                }
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: `抓取失败: ${message}${hint}`,
                    }],
                };
            } finally {
                if (page && !borrowedPage) {
                    await page.close().catch(() => { });
                }
            }
        }
    );
}
