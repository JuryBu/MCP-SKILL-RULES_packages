import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { browserManager } from "../browser.js";
import { touchActivity } from "../lifecycle.js";
import { QUALITY_PRESETS, type ImageQuality, appendTiming } from "../constants.js";
import { saveTempFile, generateCacheKey, splitOversizedImage } from "../temp-store.js";

const BatchItemSchema = z.object({
    url: z
        .string()
        .refine(s => /^(https?|file):\/\//i.test(s), "请提供有效的 URL")
        .describe("文件或网页 URL"),
    pages: z
        .string()
        .optional()
        .describe("PDF/Office 多页: \"all\"/\"1-3\"/\"1,4,5\""),
});

const BatchScreenshotInputSchema = z.object({
    items: z
        .array(BatchItemSchema)
        .min(1)
        .max(20)
        .describe("要截图的文件/网页列表（最多20项）"),
    quality: z
        .enum(["hd", "clear", "default", "compact", "fast"])
        .optional()
        .default("default")
        .describe("图片质量，默认 default"),
    timeout: z
        .number()
        .int()
        .min(1000)
        .max(120000)
        .optional()
        .describe("每项超时毫秒数，默认 30000"),
});

type BatchScreenshotInput = z.infer<typeof BatchScreenshotInputSchema>;

export function registerBatchScreenshot(server: McpServer): void {
    server.registerTool(
        "web_batch_screenshot",
        {
            title: "批量截图",
            description: `一次性对多个文件/网页进行截图。
适合需要同时截取多个文件的场景（MCP 串行执行，批量比逐个调用更高效）。

参数:
  - items (array, 必须): 要截图的列表，每项含 url 和可选的 pages
  - quality (string, 可选): 图片质量 hd/clear/default/compact/fast，默认 default
  - timeout (number, 可选): 每项超时毫秒数，默认 30000

返回: 所有截图的清单（文件路径+大小），用 view_file 查看`,
            inputSchema: {
                items: BatchScreenshotInputSchema.shape.items,
                quality: BatchScreenshotInputSchema.shape.quality,
                timeout: BatchScreenshotInputSchema.shape.timeout,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async (params: BatchScreenshotInput) => {
            touchActivity();
            const startTime = Date.now();

            const quality: ImageQuality = params.quality || "default";
            const qConfig = QUALITY_PRESETS[quality];
            const timeout = params.timeout ?? 30000;
            const results: Array<{ url: string; success: boolean; path?: string; sizeKB?: string; error?: string; pages?: number }> = [];

            for (const item of params.items) {
                try {
                    touchActivity();

                    // 解析页码
                    let pageNumbers: number[] | undefined;
                    if (item.pages) {
                        pageNumbers = parsePages(item.pages);
                    }

                    // 处理 "all"：parsePages("all") 返回空数组，需先导航获取总页数再展开
                    if (pageNumbers && pageNumbers.length === 0) {
                        const probePage = await browserManager.navigateTo(item.url, { timeout });
                        try {
                            const totalPages = await probePage.evaluate(() => (window as any).__mcpPdfInfo?.totalPages || 1);
                            pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);
                        } finally {
                            await probePage.close().catch(() => { });
                        }
                    }

                    if (pageNumbers && pageNumbers.length > 1) {
                        // 多页截图
                        const page = await browserManager.navigateTo(item.url, {
                            timeout,
                            pageNumbers,
                        });

                        try {
                            const isLocalFile = item.url.startsWith("file://");
                            const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo).catch(() => null);
                            const firstPage = pageNumbers[0];

                            if (isLocalFile && pdfInfo) {
                                // 本地 PDF：保持渲染宽度 1920，使用精确页面高度
                                const pdfHeight = pdfInfo.heights?.[firstPage] || pdfInfo.firstPageHeight || 1080;
                                await page.setViewportSize({ width: 1920, height: Math.round(pdfHeight) });
                            } else if (!isLocalFile) {
                                // 网页：应用 quality 缩放
                                await page.setViewportSize({ width: qConfig.viewportWidth, height: 800 });
                            }
                            // 本地非 PDF 文件（图片等）：不改视口，保持 navigateTo 设置的

                            const totalPages = pdfInfo?.totalPages || await page.evaluate(() => (window as any).__mcpPdfInfo?.totalPages || 1);

                            for (const pn of pageNumbers) {
                                if (pn > totalPages) continue;
                                // 跳转到指定页
                                await page.evaluate(async (p: number) => {
                                    const info = (window as any).__mcpPdfInfo;
                                    if (info?.goToPage) await info.goToPage(p);
                                }, pn);

                                if (isLocalFile && pdfInfo) {
                                    const pdfHeight = await page.evaluate((p: number) => (window as any).__mcpPdfInfo?.heights?.[p] || 1080, pn);
                                    await page.setViewportSize({ width: 1920, height: Math.round(pdfHeight) });
                                }

                                // v6.1: 截图前等待视觉资源就绪
                                await browserManager.waitForVisualReady(page);
                                const buffer = await page.screenshot({ type: "jpeg", quality: qConfig.jpegQuality, fullPage: false });
                                const cacheKey = generateCacheKey(item.url, quality, "batch", pn);
                                const splitResult = await splitOversizedImage(buffer, "screenshots", cacheKey, ".jpg");
                                for (let si = 0; si < splitResult.paths.length; si++) {
                                    results.push({
                                        url: item.url,
                                        success: true,
                                        path: splitResult.paths[si],
                                        sizeKB: splitResult.sizes[si],
                                        pages: pn,
                                    });
                                }
                            }
                        } finally {
                            await page.close().catch(() => { });
                        }
                    } else {
                        // 单页截图
                        const pageNum = pageNumbers?.[0];
                        const page = await browserManager.navigateTo(item.url, {
                            timeout,
                            pageNumber: pageNum,
                        });

                        try {
                            const isLocalFile = item.url.startsWith("file://");
                            const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo).catch(() => null);

                            if (isLocalFile && pdfInfo) {
                                // 本地 PDF：保持渲染宽度 1920，使用精确页面高度
                                const targetPage = pageNum || 1;
                                const pdfHeight = pdfInfo.heights?.[targetPage] || pdfInfo.firstPageHeight || 1080;
                                await page.setViewportSize({ width: 1920, height: Math.round(pdfHeight) });
                            } else if (!isLocalFile) {
                                // 网页：应用 quality 缩放
                                await page.setViewportSize({ width: qConfig.viewportWidth, height: 800 });
                            }
                            // 本地非 PDF 文件（图片等）：不改视口
                            // v6.1: 截图前等待视觉资源就绪
                            await browserManager.waitForVisualReady(page);
                            const buffer = await page.screenshot({ type: "jpeg", quality: qConfig.jpegQuality, fullPage: false });
                            const cacheKey = generateCacheKey(item.url, quality, "batch", pageNum);
                            const splitResult = await splitOversizedImage(buffer, "screenshots", cacheKey, ".jpg");
                            for (let si = 0; si < splitResult.paths.length; si++) {
                                results.push({
                                    url: item.url,
                                    success: true,
                                    path: splitResult.paths[si],
                                    sizeKB: splitResult.sizes[si],
                                    pages: pageNum,
                                });
                            }
                        } finally {
                            await page.close().catch(() => { });
                        }
                    }
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    results.push({ url: item.url, success: false, error: msg });
                }
            }

            // 格式化输出
            const successCount = results.filter(r => r.success).length;
            const failCount = results.filter(r => !r.success).length;
            const totalSize = results.filter(r => r.success).reduce((sum, r) => sum + parseFloat(r.sizeKB || "0"), 0);

            let output = `📸 批量截图完成: ${successCount} 成功`;
            if (failCount > 0) output += `, ${failCount} 失败`;
            output += ` (共 ${totalSize.toFixed(1)} KB, ${quality} 质量)\n\n`;

            for (const r of results) {
                if (r.success) {
                    const pageStr = r.pages ? ` [第${r.pages}页]` : '';
                    output += `✅ ${r.sizeKB} KB${pageStr}: ${r.path}\n`;
                } else {
                    output += `❌ ${r.url}: ${r.error}\n`;
                }
            }

            output += "\n使用 view_file 工具查看截图";

            return appendTiming({
                content: [{ type: "text" as const, text: output }],
            }, startTime, browserManager.lastRetryCount);
        }
    );
}

/**
 * 解析页码字符串: "all" / "1-3" / "1,4,5" / "1-3,6-9,18"
 */
function parsePages(pagesStr: string): number[] {
    if (pagesStr.toLowerCase() === "all") {
        // 返回空数组表示 "all"，调用者需要特殊处理
        return [];
    }

    const pages = new Set<number>();
    const parts = pagesStr.split(",").map(s => s.trim());

    for (const part of parts) {
        if (part.includes("-")) {
            const [start, end] = part.split("-").map(Number);
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end && i <= 999; i++) {
                    pages.add(i);
                }
            }
        } else {
            const n = Number(part);
            if (!isNaN(n)) pages.add(n);
        }
    }

    return [...pages].sort((a, b) => a - b);
}
