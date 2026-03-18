import { z } from "zod";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { QUALITY_PRESETS, SCREENSHOT_MIME_TYPE, appendTiming, } from "../constants.js";
import { saveTempFile, getTempFile, generateCacheKey, splitOversizedImage } from "../temp-store.js";
// ========== pages 参数解析器 ==========
// 支持: "all", "1-5", "1,4,5", "1-3,6-9,18" 等格式
function parsePages(pagesStr, totalPages) {
    if (pagesStr.trim().toLowerCase() === "all") {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages = new Set();
    const parts = pagesStr.split(",").map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        if (part.includes("-")) {
            const [startStr, endStr] = part.split("-").map(s => s.trim());
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
                throw new Error(`无效的页码范围: "${part}"，格式应为 "起始-结束"（如 "1-5"）`);
            }
            for (let i = start; i <= Math.min(end, totalPages); i++) {
                pages.add(i);
            }
        }
        else {
            const num = parseInt(part, 10);
            if (isNaN(num) || num < 1) {
                throw new Error(`无效的页码: "${part}"`);
            }
            if (num <= totalPages) {
                pages.add(num);
            }
        }
    }
    if (pages.size === 0) {
        throw new Error(`解析后无有效页码（文档共 ${totalPages} 页）`);
    }
    return Array.from(pages).sort((a, b) => a - b);
}
const FetchScreenshotInputSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL（支持 http/https/file 协议）")
        .describe("要截图的网页 URL（支持 http/https/file 协议，如 file:///C:/path/to/file.pdf）"),
    fullPage: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否截取完整页面（包括滚动区域），默认 false"),
    selector: z
        .string()
        .optional()
        .describe("可选的 CSS 选择器，只截取指定元素"),
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
        .describe("截图前页面滚动次数，用于加载懒加载内容，默认 0 不滚动"),
    quality: z
        .enum(["hd", "clear", "default", "compact", "fast"])
        .optional()
        .describe("图片质量: hd(~400KB高清)/clear(~180KB清晰)/default(~80KB标准)/compact(~40KB概览)/fast(~20KB缩略)，默认 default"),
    saveMode: z
        .enum(["file", "inline"])
        .optional()
        .describe("输出模式: file(保存临时文件返回路径，默认)/inline(返回base64图片)"),
    page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("PDF/Office文件的页码（默认1），如 page:3 截取第3页"),
    pages: z
        .string()
        .optional()
        .describe("PDF/Office文件的多页截取，支持: \"all\"(全部), \"1-5\"(范围), \"1,4,5\"(指定), \"1-3,6-9,18\"(混合)。与 page 互斥，优先使用 pages"),
    autoSplit: z
        .boolean()
        .optional()
        .default(true)
        .describe("是否自动分片超大截图（默认 true）。IDE 限制图片任何维度不能超过 8000px，开启时超限图片会自动切割为多张。设为 false 可保留原始完整图片（用于保存到文件等场景）"),
});
export function registerFetchScreenshot(server) {
    server.registerTool("web_fetch_screenshot", {
        title: "网页截图",
        description: `使用带 Cookie 的浏览器对网页截图。
支持全页截图和指定元素截图。
支持 file:// 协议打开本地文件（HTML、PDF、DOCX、PPTX、XLSX、图片等）进行截图。

参数:
  - url (string, 必须): 要截图的网页 URL（支持 http/https/file 协议）
  - fullPage (boolean, 可选): 是否全页截图，默认 false
  - selector (string, 可选): CSS 选择器，截取指定元素
  - timeout (number, 可选): 超时毫秒数，默认 30000
  - scrollCount (number, 可选): 截图前滚动次数，默认 0
  - quality (string, 可选): 图片质量 hd/clear/default/compact/fast，默认 default
  - saveMode (string, 可选): file(临时文件,默认)/inline(base64)
  - page (number, 可选): PDF/Office文件的页码（默认1），截取指定页
  - pages (string, 可选): PDF/Office多页截取: "all"(全部), "1-5"(范围), "1,4,5"(指定), "1-3,6-9,18"(混合)

返回: 
  - file 模式: 临时文件路径 + 元信息（用 view_file 查看图片）
  - inline 模式: JPEG 图片（base64）
  - 多页模式: 各页独立保存，返回清单文件路径`,
        inputSchema: {
            url: FetchScreenshotInputSchema.shape.url,
            fullPage: FetchScreenshotInputSchema.shape.fullPage,
            selector: FetchScreenshotInputSchema.shape.selector,
            timeout: FetchScreenshotInputSchema.shape.timeout,
            scrollCount: FetchScreenshotInputSchema.shape.scrollCount,
            quality: FetchScreenshotInputSchema.shape.quality,
            saveMode: FetchScreenshotInputSchema.shape.saveMode,
            page: FetchScreenshotInputSchema.shape.page,
            pages: FetchScreenshotInputSchema.shape.pages,
            autoSplit: FetchScreenshotInputSchema.shape.autoSplit,
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
        const quality = params.quality || "default";
        const saveMode = params.saveMode || "file";
        const qConfig = QUALITY_PRESETS[quality];
        // ========== 多页模式 ==========
        if (params.pages) {
            return handleMultiPageScreenshot(params, quality, qConfig, startTime);
        }
        // ========== 单页模式（原有逻辑）==========
        const cacheKey = generateCacheKey(params.url, quality, params.fullPage, params.selector, params.scrollCount, params.page);
        if (saveMode === "file") {
            const cached = getTempFile("screenshots", cacheKey, ".jpg");
            if (cached) {
                const stat = (await import("fs")).statSync(cached);
                const sizeKB = (stat.size / 1024).toFixed(1);
                console.error(`[web-fetcher] 截图缓存命中: ${cached}`);
                return {
                    content: [{
                            type: "text",
                            text: `截图完成 (${sizeKB} KB, 缓存命中)\n质量: ${quality} | 文件: ${cached}\n\n使用 view_file 工具查看此图片`,
                        }],
                };
            }
        }
        let page;
        try {
            page = await browserManager.navigateTo(params.url, {
                waitFor: params.selector,
                timeout: params.timeout,
                scrollCount: params.scrollCount,
                fullPage: params.fullPage,
                pageNumber: params.page,
            });
            // 根据 quality 调整视口宽度
            const isLocalFile = params.url.startsWith("file://");
            if (!isLocalFile && !params.selector && qConfig.viewportWidth !== 1920) {
                const currentSize = page.viewportSize();
                if (currentSize && currentSize.width !== qConfig.viewportWidth) {
                    await page.setViewportSize({
                        width: qConfig.viewportWidth,
                        height: currentSize.height,
                    });
                    await page.waitForTimeout(200);
                }
            }
            let screenshotBuffer;
            if (params.selector) {
                const element = await page.$(params.selector);
                if (!element) {
                    return {
                        isError: true,
                        content: [{
                                type: "text",
                                text: `未找到选择器 "${params.selector}" 匹配的元素`,
                            }],
                    };
                }
                screenshotBuffer = await element.screenshot({
                    type: "jpeg",
                    quality: qConfig.jpegQuality,
                });
            }
            else {
                screenshotBuffer = await page.screenshot({
                    type: "jpeg",
                    quality: qConfig.jpegQuality,
                    fullPage: params.fullPage ?? false,
                });
            }
            // 截图有效性验证
            if (screenshotBuffer.length < 5 * 1024) {
                console.error(`[web-fetcher] 截图过小 (${screenshotBuffer.length} bytes)，等待 3s 重试...`);
                await page.waitForTimeout(3000);
                screenshotBuffer = await page.screenshot({
                    type: "jpeg",
                    quality: qConfig.jpegQuality,
                    fullPage: params.fullPage ?? false,
                });
            }
            const sizeKB = (screenshotBuffer.length / 1024).toFixed(1);
            const warning = screenshotBuffer.length < 5 * 1024
                ? "\n⚠️ 截图可能为空白页面（文件极小），页面可能未完成渲染或被反爬拦截"
                : "";
            // 读取 PDF 页码信息（如有）
            let pageInfo = "";
            try {
                const pdfInfo = await page.evaluate(() => window.__mcpPdfInfo);
                if (pdfInfo) {
                    pageInfo = ` — 第${pdfInfo.currentPage}页/共${pdfInfo.totalPages}页`;
                }
            }
            catch { }
            // 根据 saveMode 返回
            if (saveMode === "file") {
                const autoSplit = params.autoSplit !== false;
                if (autoSplit) {
                    const splitResult = await splitOversizedImage(screenshotBuffer, "screenshots", cacheKey, ".jpg");
                    if (splitResult.wasSplit) {
                        const fileList = splitResult.paths.map((p, i) => `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`).join("\n");
                        return appendTiming({
                            content: [{
                                    type: "text",
                                    text: `📐 ${splitResult.description}${pageInfo}${warning}\n质量: ${quality}\n\n${fileList}\n\n使用 view_file 工具按顺序查看各片`,
                                }],
                        }, startTime, browserManager.lastRetryCount);
                    }
                    // 未超限，splitResult.paths[0] 就是保存的文件
                    return appendTiming({
                        content: [{
                                type: "text",
                                text: `截图完成 (${splitResult.sizes[0]} KB)${pageInfo}${warning}\n质量: ${quality} | 文件: ${splitResult.paths[0]}\n\n使用 view_file 工具查看此图片`,
                            }],
                    }, startTime, browserManager.lastRetryCount);
                }
                else {
                    const filePath = saveTempFile("screenshots", cacheKey, ".jpg", screenshotBuffer);
                    return appendTiming({
                        content: [{
                                type: "text",
                                text: `截图完成 (${sizeKB} KB)${pageInfo}${warning}\n质量: ${quality} | 文件: ${filePath}\n\n使用 view_file 工具查看此图片`,
                            }],
                    }, startTime, browserManager.lastRetryCount);
                }
            }
            else {
                const base64 = screenshotBuffer.toString("base64");
                return appendTiming({
                    content: [
                        {
                            type: "text",
                            text: `截图完成 (${sizeKB} KB)${pageInfo}${warning}`,
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
                        text: `截图失败: ${message}${hint}`,
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
// ========== 多页批量截图处理 ==========
async function handleMultiPageScreenshot(params, quality, qConfig, startTime) {
    const saveMode = params.saveMode || "file";
    // 多页模式只支持 file 保存
    if (saveMode === "inline") {
        return {
            isError: true,
            content: [{
                    type: "text",
                    text: `多页截图不支持 inline 模式（图片过多），请使用 file 模式`,
                }],
        };
    }
    let page;
    try {
        // 第一步：先用 pageNumber:1 导航以获取总页数
        page = await browserManager.navigateTo(params.url, {
            timeout: params.timeout,
            pageNumber: 1,
        });
        const pdfInfo = await page.evaluate(() => window.__mcpPdfInfo);
        if (!pdfInfo || !pdfInfo.totalPages) {
            return {
                isError: true,
                content: [{
                        type: "text",
                        text: `pages 参数仅支持 PDF/Office/TeX 文件，此文件不支持分页截图`,
                    }],
            };
        }
        const totalPages = pdfInfo.totalPages;
        // 解析 pages 参数为具体页码数组
        const requestedPages = parsePages(params.pages, totalPages);
        console.error(`[web-fetcher] 多页截图: 解析 "${params.pages}" → [${requestedPages.join(',')}] (${requestedPages.length}页/${totalPages}页)`);
        // 关闭第一次导航的页面
        await page.close().catch(() => { });
        page = null;
        // 第二步：用完整页码列表一次性渲染所有需要的页
        page = await browserManager.navigateTo(params.url, {
            timeout: params.timeout,
            pageNumbers: requestedPages,
        });
        // 逐页截图：对每个 canvas 使用 element.screenshot()
        const results = [];
        let totalSize = 0;
        for (const pageNum of requestedPages) {
            const canvas = await page.$(`#pdf-page-${pageNum}`);
            if (!canvas) {
                console.error(`[web-fetcher] 警告: 未找到第 ${pageNum} 页的 canvas`);
                continue;
            }
            const buffer = await canvas.screenshot({
                type: "jpeg",
                quality: qConfig.jpegQuality,
            });
            const cacheKey = generateCacheKey(params.url, quality, "multi", pageNum);
            const filePath = saveTempFile("screenshots", cacheKey, ".jpg", buffer);
            const sizeKB = (buffer.length / 1024).toFixed(1);
            totalSize += buffer.length;
            results.push({ pageNum, filePath, sizeKB });
        }
        if (results.length === 0) {
            return {
                isError: true,
                content: [{
                        type: "text",
                        text: `截图失败: 未能截取任何页面`,
                    }],
            };
        }
        const totalSizeStr = totalSize > 1024 * 1024
            ? `${(totalSize / 1024 / 1024).toFixed(1)}MB`
            : `${(totalSize / 1024).toFixed(1)}KB`;
        // ≤3 页: 直接返回路径列表
        if (results.length <= 3) {
            const lines = results.map(r => `第${r.pageNum}页 (${r.sizeKB}KB): ${r.filePath}`).join("\n");
            return appendTiming({
                content: [{
                        type: "text",
                        text: `${results.length}页截图完成 (共${totalSizeStr}, ${quality}质量) — 文档共${totalPages}页\n\n${lines}\n\n使用 view_file 工具查看图片`,
                    }],
            }, startTime, browserManager.lastRetryCount);
        }
        // >3 页: 写 manifest.txt
        const manifestLines = [
            `# 文档截图清单`,
            `# 来源: ${params.url}`,
            `# 文档总页数: ${totalPages}`,
            `# 截取页码: ${params.pages} (${results.length}页)`,
            `# 质量: ${quality} | 总大小: ${totalSizeStr}`,
            ``,
            ...results.map(r => `p${r.pageNum}\t${r.sizeKB}KB\t${r.filePath}`),
        ].join("\n");
        const manifestKey = generateCacheKey(params.url, quality, "manifest", params.pages);
        const manifestPath = saveTempFile("screenshots", manifestKey, ".txt", Buffer.from(manifestLines, "utf-8"));
        return appendTiming({
            content: [{
                    type: "text",
                    text: `${results.length}页截图完成 (共${totalSizeStr}, ${quality}质量) — 文档共${totalPages}页\n清单文件: ${manifestPath}\n\n使用 view_file 查看清单，或直接 view_file 查看指定页的截图`,
                }],
        }, startTime, browserManager.lastRetryCount);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            isError: true,
            content: [{
                    type: "text",
                    text: `多页截图失败: ${message}`,
                }],
        };
    }
    finally {
        if (page) {
            await page.close().catch(() => { });
        }
    }
}
//# sourceMappingURL=fetch-screenshot.js.map