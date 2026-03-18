import { z } from "zod";
import { browserManager } from "../browser.js";
import { extractContent, compactContent, detectSPAIssue, detectEncodingIssue } from "../extractor.js";
import { touchActivity } from "../lifecycle.js";
import { QUALITY_PRESETS, SCREENSHOT_MIME_TYPE, appendTiming, AI_SUMMARY_MAX_INPUT, AI_SUMMARY_PROMPT_TEMPLATE, } from "../constants.js";
import { generateCacheKey, splitOversizedImage } from "../temp-store.js";
import { callGetModelResponse } from "../ls-client.js";
const FetchRichInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
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
    quality: z
        .enum(["hd", "clear", "default", "compact", "fast"])
        .optional()
        .describe("图片质量: hd/clear/default/compact/fast，默认 default"),
    saveMode: z
        .enum(["file", "inline"])
        .optional()
        .describe("截图输出模式: file(临时文件,默认)/inline(base64)"),
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
export function registerFetchRich(server) {
    server.registerTool("web_fetch_rich", {
        title: "截图+文本一次获取",
        description: `一次调用同时获取网页截图和 Markdown 文本内容。
减少往返次数，适合需要"看一眼页面 + 拿到可搜索文本"的常见场景。
支持 file:// 协议打开本地文件（HTML、PDF、DOCX 等）。

参数:
  - url (string, 必须): 要抓取的网页 URL（支持 http/https/file 协议）
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - scrollCount (number, 可选): 滚动次数，默认 0
  - compact (string, 可选): 文本压缩模式 full/compact/minimal/headings/ai_summary，默认 compact
  - quality (string, 可选): 图片质量 hd/clear/default/compact/fast，默认 default
  - saveMode (string, 可选): file(临时文件,默认)/inline(base64)
  - page (number, 可选): PDF/Office文件的页码（默认1），截取指定页
  - pages (string, 可选): PDF/Office多页截取: "all"/"1-5"/"1,4,5"/"1-3,6-9,18"

返回: 同时包含截图和 Markdown 文本`,
        inputSchema: {
            url: FetchRichInputSchema.shape.url,
            timeout: FetchRichInputSchema.shape.timeout,
            scrollCount: FetchRichInputSchema.shape.scrollCount,
            compact: FetchRichInputSchema.shape.compact,
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
    }, async (params) => {
        touchActivity();
        const startTime = Date.now();
        const quality = (params.quality || "default");
        const saveMode = params.saveMode || "file";
        const qConfig = QUALITY_PRESETS[quality];
        let page;
        try {
            // 解析多页参数
            let pageNumbers;
            if (params.pages) {
                const parsePagesStr = (s) => {
                    if (s.toLowerCase() === "all")
                        return [];
                    const pages = new Set();
                    for (const part of s.split(",").map(p => p.trim())) {
                        if (part.includes("-")) {
                            const [start, end] = part.split("-").map(Number);
                            if (!isNaN(start) && !isNaN(end)) {
                                for (let i = start; i <= end && i <= 999; i++)
                                    pages.add(i);
                            }
                        }
                        else {
                            const n = Number(part);
                            if (!isNaN(n))
                                pages.add(n);
                        }
                    }
                    return [...pages].sort((a, b) => a - b);
                };
                pageNumbers = parsePagesStr(params.pages);
                // pages="all" 返回空数组，需先导航获取总页数再展开
                if (pageNumbers.length === 0) {
                    const probePage = await browserManager.navigateTo(params.url, {
                        timeout: params.timeout,
                    });
                    try {
                        const totalPages = await probePage.evaluate(() => window.__mcpPdfInfo?.totalPages || 1);
                        pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
                    }
                    finally {
                        await probePage.close().catch(() => { });
                    }
                }
            }
            page = await browserManager.navigateTo(params.url, {
                timeout: params.timeout,
                scrollCount: params.scrollCount,
                pageNumber: params.page,
                pageNumbers: pageNumbers && pageNumbers.length > 0 ? pageNumbers : undefined,
            });
            // 根据 quality 调整视口（file:// 跳过，防止裁剪）
            const isLocalFile = params.url.startsWith("file://");
            if (!isLocalFile && qConfig.viewportWidth !== 1920) {
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
            let screenshotBuffer = await page.screenshot({
                type: "jpeg",
                quality: qConfig.jpegQuality,
                fullPage: false,
            });
            // 截图有效性验证
            if (screenshotBuffer.length < 5 * 1024) {
                await page.waitForTimeout(3000);
                screenshotBuffer = await page.screenshot({
                    type: "jpeg",
                    quality: qConfig.jpegQuality,
                    fullPage: false,
                });
            }
            const sizeKB = (screenshotBuffer.length / 1024).toFixed(1);
            // 读取 PDF 页码信息（如有）
            let pageInfo = "";
            try {
                const pdfInfo = await page.evaluate(() => window.__mcpPdfInfo);
                if (pdfInfo) {
                    pageInfo = ` — 第${pdfInfo.currentPage}页/共${pdfInfo.totalPages}页`;
                }
            }
            catch { }
            // 2) 文本提取
            const html = await page.content();
            let { content } = extractContent(html, params.url);
            // v5.2: NGA 等 GBK 编码站点修复 — Node.js HTTP + iconv
            if (detectEncodingIssue(content)) {
                try {
                    const iconv = (await import('iconv-lite')).default;
                    const https = await import('https');
                    const http = await import('http');
                    // 从浏览器 context 获取 Cookie
                    const context = page.context();
                    const cookies = await context.cookies(params.url);
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    const rawHtml = await new Promise((resolve, reject) => {
                        const mod = params.url.startsWith('https') ? https : http;
                        const req = mod.get(params.url, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                'Accept': 'text/html',
                                ...(cookieStr ? { 'Cookie': cookieStr } : {}),
                            },
                        }, (res) => {
                            const chunks = [];
                            res.on('data', (chunk) => chunks.push(chunk));
                            res.on('end', () => {
                                const raw = Buffer.concat(chunks);
                                const ctHeader = res.headers['content-type'] || '';
                                let charset = 'utf-8';
                                const headerMatch = ctHeader.match(/charset\s*=\s*([\w-]+)/i);
                                if (headerMatch)
                                    charset = headerMatch[1];
                                else {
                                    const head = raw.slice(0, 2048).toString('ascii');
                                    const metaMatch = head.match(/charset\s*=\s*["']?([\w-]+)/i);
                                    if (metaMatch)
                                        charset = metaMatch[1];
                                }
                                try {
                                    resolve(iconv.decode(raw, charset));
                                }
                                catch {
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
                }
                catch { /* HTTP 重取失败时保留原始内容 */ }
            }
            // v5.2: SPA 空壳检测
            const spaHint = detectSPAIssue(content, params.url);
            if (spaHint) {
                content += spaHint;
            }
            const compactMode = params.compact || "compact";
            let finalContent;
            if (compactMode === "ai_summary") {
                // AI Summary 模式：调用 Flash 模型生成智能摘要
                let aiResult = null;
                try {
                    const titleMatch = content.match(/^#\s+(.+)$/m);
                    const pageTitle = titleMatch ? titleMatch[1].trim() : params.url.split('/').pop() || '未知页面';
                    const truncated = content.slice(0, AI_SUMMARY_MAX_INPUT);
                    const prompt = AI_SUMMARY_PROMPT_TEMPLATE
                        .replace('{pageTitle}', pageTitle)
                        .replace('{url}', params.url)
                        .replace('{content}', truncated);
                    aiResult = await callGetModelResponse(prompt);
                }
                catch (err) {
                    console.error(`[web-fetcher] fetch-rich AI Summary 失败: ${err instanceof Error ? err.message : err}`);
                }
                if (aiResult) {
                    const ratio = ((1 - aiResult.length / content.length) * 100).toFixed(0);
                    finalContent = `🤖 AI 摘要 (by Gemini 3 Flash)\n\n${aiResult}\n\n---\n📊 原文 ${content.length} 字 → 摘要 ${aiResult.length} 字 (压缩 ${ratio}%)`;
                }
                else {
                    // AI 不可用，降级为 compact
                    finalContent = `⚠️ AI Summary 降级为 compact\n\n${compactContent(content, "compact")}`;
                }
            }
            else {
                finalContent = compactMode === "full" ? content : compactContent(content, compactMode);
            }
            // 根据 saveMode 返回截图
            if (saveMode === "file") {
                const cacheKey = generateCacheKey(params.url, quality, "rich", params.scrollCount, params.page);
                const splitResult = await splitOversizedImage(screenshotBuffer, "screenshots", cacheKey, ".jpg");
                if (splitResult.wasSplit) {
                    const fileList = splitResult.paths.map((p, i) => `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`).join("\n");
                    return appendTiming({
                        content: [{
                                type: "text",
                                text: `📐 ${splitResult.description}${pageInfo} + 文本提取完成 [${compactMode}]\n\n${fileList}\n\n使用 view_file 按顺序查看截图\n\n${finalContent}`,
                            }],
                    }, startTime, browserManager.lastRetryCount);
                }
                return appendTiming({
                    content: [{
                            type: "text",
                            text: `截图 (${splitResult.sizes[0]} KB)${pageInfo} + 文本提取完成 [${compactMode}]\n截图: ${splitResult.paths[0]} (用 view_file 查看)\n\n${finalContent}`,
                        }],
                }, startTime, browserManager.lastRetryCount);
            }
            else {
                const base64 = screenshotBuffer.toString("base64");
                return appendTiming({
                    content: [
                        {
                            type: "text",
                            text: `截图 (${sizeKB} KB)${pageInfo} + 文本提取完成 [${compactMode}]\n\n${finalContent}`,
                        },
                        {
                            type: "image",
                            data: base64,
                            mimeType: SCREENSHOT_MIME_TYPE,
                        },
                    ],
                }, startTime, browserManager.lastRetryCount);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            let hint = "";
            if (message.includes("ERR_CONNECTION_CLOSED") || message.includes("ERR_CONNECTION_RESET")) {
                hint = "\n\n⚠️ 连接被关闭，可能是登录态过期。建议使用 web_login_browser 重新登录。";
            }
            else if (message.includes("Timeout") || message.includes("timeout")) {
                hint = "\n\n⏱️ 建议增加 timeout 参数（如 60000）或重试。";
            }
            return {
                isError: true,
                content: [{
                        type: "text",
                        text: `抓取失败: ${message}${hint}`,
                    }],
            };
        }
        finally {
            if (page) {
                await page.close().catch(() => { });
            }
        }
    });
}
//# sourceMappingURL=fetch-rich.js.map