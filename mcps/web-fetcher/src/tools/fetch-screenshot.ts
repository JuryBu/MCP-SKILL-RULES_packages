import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { browserManager } from "../browser.js";
import { categorizeFile } from "../converter.js";
import { extractPdfStructure, resolvePdfPathFromUrl, renderPdfRegion, searchPdfTextRegion } from "../inspector/pdf-inspector.js";
import { searchPptxTextRegion } from "../inspector/pptx-inspector.js";
import type { Rect } from "../inspector/types.js";
import { touchActivity } from "../lifecycle.js";
import {
    QUALITY_PRESETS, SCREENSHOT_MIME_TYPE,
    type ImageQuality, type QualityConfig, type SaveMode,
    appendTiming,
} from "../constants.js";
import {
    ensureTempDirs,
    saveTempFile,
    getTempFile,
    generateCacheKey,
    splitOversizedImage,
    TEMP_DIRS,
} from "../temp-store.js";

// ========== pages 参数解析器 ==========
// 支持: "all", "1-5", "1,4,5", "1-3,6-9,18" 等格式
function parsePages(pagesStr: string, totalPages: number): number[] {
    if (pagesStr.trim().toLowerCase() === "all") {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages = new Set<number>();
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
        } else {
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
    target: z
        .string()
        .optional()
        .describe("按文本内容语义定位目标元素，并截取目标周边区域；与 selector 互斥"),
    scale: z
        .number()
        .min(1.0)
        .max(3.0)
        .optional()
        .describe("target 局域截图放大比例，默认 1.4"),
    diff: z
        .string()
        .optional()
        .refine(s => !s || /^(https?|file):\/\//i.test(s), "diff 必须是有效 URL（支持 http/https/file 协议）")
        .describe("对比基准 URL；提供后返回当前 URL 与 diff URL 的差异高亮截图"),
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

type FetchScreenshotInput = z.infer<typeof FetchScreenshotInputSchema>;

interface CaptureResult {
    buffer: Buffer;
    pageInfo?: string;
    warning?: string;
    detail?: string;
}

function pageForTargetSearch(params: FetchScreenshotInput): number | "all" | null {
    return params.page ?? null;
}

function isPdfInspectableUrl(url: string): boolean {
    if (!url.startsWith("file://")) return false;
    try {
        const localPath = fileURLToPath(url);
        const category = categorizeFile(localPath);
        return category === "pdf" || category === "office" || category === "tex";
    } catch {
        return false;
    }
}

function isPptxUrl(url: string): boolean {
    if (!url.startsWith("file://")) return false;
    try {
        return path.extname(fileURLToPath(url)).toLowerCase() === ".pptx";
    } catch {
        return false;
    }
}

function isEpubUrl(url: string): boolean {
    if (!url.startsWith("file://")) return false;
    try {
        return path.extname(fileURLToPath(url)).toLowerCase() === ".epub";
    } catch {
        return false;
    }
}

function mapRectBetweenCoordinateSpaces(rect: Rect, from: { width: number; height: number }, to: { width: number; height: number }): Rect {
    return {
        x0: rect.x0 / from.width * to.width,
        y0: rect.y0 / from.height * to.height,
        x1: rect.x1 / from.width * to.width,
        y1: rect.y1 / from.height * to.height,
    };
}

function clampClip(
    box: { x: number; y: number; width: number; height: number },
    bounds: { width: number; height: number },
    scale: number,
) {
    const safeScale = Number.isFinite(scale) ? Math.max(1, Math.min(scale, 3)) : 1.4;
    const scaledWidth = box.width * safeScale;
    const scaledHeight = box.height * safeScale;
    const x = Math.max(0, Math.min(box.x - (scaledWidth - box.width) / 2, bounds.width - 1));
    const y = Math.max(0, Math.min(box.y - (scaledHeight - box.height) / 2, bounds.height - 1));
    const w = Math.max(1, Math.min(scaledWidth, bounds.width - x));
    const h = Math.max(1, Math.min(scaledHeight, bounds.height - y));
    return { x, y, width: w, height: h };
}

async function captureDomTarget(page: Page, target: string, scale: number, jpegQuality: number): Promise<Buffer | null> {
    // Strategy: find ALL elements matching the text, pick the smallest by area
    // Then use Range API to get tight text bounds (block elements have 100% width)
    const allMatches = page.getByText(target, { exact: false });
    const count = await allMatches.count();
    if (count === 0) return null;

    let bestBox: { x: number; y: number; width: number; height: number } | null = null;
    let bestArea = Infinity;

    for (let i = 0; i < Math.min(count, 20); i++) {
        try {
            const locator = allMatches.nth(i);
            const visible = await locator.isVisible().catch(() => false);
            if (!visible) continue;
            const box = await locator.boundingBox();
            if (!box || box.width <= 0 || box.height <= 0) continue;
            const area = box.width * box.height;
            if (area < bestArea && box.width > 10 && box.height > 10) {
                bestArea = area;
                bestBox = box;
            }
        } catch {
            continue;
        }
    }

    if (!bestBox) return null;

    // Use Range API to get tight text bounding rect (avoids block-level 100% width)
    const tightBox = await page.evaluate((targetText) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const lowerTarget = targetText.toLowerCase();
        let bestRect: DOMRect | null = null;
        let bestArea = Infinity;

        let textNode: Node | null;
        while ((textNode = walker.nextNode())) {
            const content = (textNode.textContent || "").trim();
            if (!content || !content.toLowerCase().includes(lowerTarget)) continue;
            try {
                const range = document.createRange();
                range.selectNodeContents(textNode);
                const rect = range.getBoundingClientRect();
                const area = rect.width * rect.height;
                if (area > 0 && area < bestArea && rect.width > 5 && rect.height > 5) {
                    bestArea = area;
                    bestRect = rect;
                }
            } catch { /* skip */ }
        }

        if (!bestRect) return null;
        return { x: bestRect.x, y: bestRect.y, width: bestRect.width, height: bestRect.height };
    }, target);

    const bounds = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight),
    }));

    // Auto-upscale: ensure the crop is large enough to be readable
    // If both dimensions after scale are very small, boost scale to reach minimum 300px on smallest side
    const MIN_OUTPUT_DIM = 300;
    // Try tight text bounds first, fallback to element bounds if screenshot fails
    for (const box of [tightBox, bestBox].filter(Boolean) as Array<{ x: number; y: number; width: number; height: number }>) {
        const minSide = Math.min(box.width, box.height);
        const effectiveScale = (minSide * scale < MIN_OUTPUT_DIM && minSide > 0)
            ? Math.min(Math.max(scale, MIN_OUTPUT_DIM / minSide), 3)
            : scale;
        const clip = clampClip(box, bounds, effectiveScale);
        try {
            return await page.screenshot({ type: "jpeg", quality: jpegQuality, clip });
        } catch {
            continue;
        }
    }
    return null;
}


async function capturePdfTarget(params: FetchScreenshotInput, quality: ImageQuality, qConfig: QualityConfig): Promise<CaptureResult | null> {
    if (!params.target || !isPdfInspectableUrl(params.url)) return null;

    const pdfPath = await resolvePdfPathFromUrl(params.url);
    ensureTempDirs();
    const scale = params.scale ?? 1.4;
    const key = generateCacheKey(params.url, quality, "pdf-target", params.target, params.page, scale);

    if (isPptxUrl(params.url)) {
        const pptxPath = fileURLToPath(params.url);
        const pptxSearch = await searchPptxTextRegion(pptxPath, params.target, params.page ?? null);
        if (pptxSearch.found && pptxSearch.rect && pptxSearch.page) {
            const pdfStructure = await extractPdfStructure(pdfPath, pptxSearch.page);
            const dimensions = pdfStructure[0]?.dimensions;
            if (dimensions?.width && dimensions?.height) {
                const mappedRect = mapRectBetweenCoordinateSpaces(
                    pptxSearch.rect,
                    pptxSearch.dimensions,
                    { width: dimensions.width, height: dimensions.height },
                );
                const pngPath = path.join(TEMP_DIRS.screenshots, `${key}_pptx_region.png`);
                const rendered = await renderPdfRegion(pdfPath, pptxSearch.page, mappedRect, scale, pngPath);
                const sourcePath = rendered.path || rendered.outputPath || pngPath;
                const pngBuffer = fs.readFileSync(sourcePath);
                try {
                    fs.unlinkSync(sourcePath);
                } catch {
                    // ignore cleanup failure
                }
                const sharp = (await import("sharp")).default;
                return {
                    buffer: await sharp(pngBuffer).jpeg({ quality: qConfig.jpegQuality }).toBuffer(),
                    pageInfo: ` — 第${pptxSearch.page}页`,
                    detail: `target="${params.target}" | pptx-native=true | matches=${pptxSearch.matches} | scale=${scale}`,
                };
            }
        }
    }

    const search = await searchPdfTextRegion(pdfPath, params.target, pageForTargetSearch(params));
    if (!search.found || !search.rect || !search.page) {
        return null;
    }

    const pngPath = path.join(TEMP_DIRS.screenshots, `${key}_region.png`);
    const rendered = await renderPdfRegion(pdfPath, search.page, search.rect, scale, pngPath);
    const sourcePath = rendered.path || rendered.outputPath || pngPath;
    const pngBuffer = fs.readFileSync(sourcePath);
    try {
        fs.unlinkSync(sourcePath);
    } catch {
        // ignore cleanup failure
    }

    const sharp = (await import("sharp")).default;
    const buffer = await sharp(pngBuffer).jpeg({ quality: qConfig.jpegQuality }).toBuffer();
    return {
        buffer,
        pageInfo: ` — 第${search.page}页`,
        detail: `target="${params.target}" | matches=${search.matches} | scale=${scale}`,
    };
}

async function captureWithBrowser(params: FetchScreenshotInput, qConfig: QualityConfig): Promise<CaptureResult> {
    let page: Page | undefined;
    try {
        page = await browserManager.navigateTo(params.url, {
            waitFor: params.selector,
            timeout: params.timeout,
            scrollCount: params.scrollCount,
            fullPage: params.fullPage,
            pageNumber: params.page,
        });

        const isLocalFile = params.url.startsWith("file://");
        if (!isLocalFile && !params.selector && !params.target && qConfig.viewportWidth !== 1920) {
            const currentSize = page.viewportSize();
            if (currentSize && currentSize.width !== qConfig.viewportWidth) {
                await page.setViewportSize({
                    width: qConfig.viewportWidth,
                    height: currentSize.height,
                });
                await page.waitForTimeout(200);
            }
        }

        let buffer: Buffer | null = null;
        let warning = "";

        if (params.selector) {
            const element = await page.$(params.selector);
            if (!element) {
                throw new Error(`未找到选择器 "${params.selector}" 匹配的元素`);
            }
            buffer = await element.screenshot({
                type: "jpeg",
                quality: qConfig.jpegQuality,
            });
        } else if (params.target) {
            buffer = await captureDomTarget(page, params.target, params.scale ?? 1.4, qConfig.jpegQuality);
            if (!buffer) {
                warning = `\n⚠️ 未找到文本 "${params.target}"，已返回全页截图`;
            }
        }

        if (!buffer) {
            await browserManager.waitForVisualReady(page);
            buffer = await page.screenshot({
                type: "jpeg",
                quality: qConfig.jpegQuality,
                fullPage: params.fullPage ?? false,
            });
        }
        // Small-buffer retry guard: only for full-page/viewport shots, NOT for target/selector crops
        const isTargetCrop = !!(params.target || params.selector) && buffer.length > 0;
        if (!isTargetCrop && buffer.length < 5 * 1024) {
            console.error(`[web-fetcher] 截图过小 (${buffer.length} bytes)，等待 3s 重试...`);
            await page.waitForTimeout(3000);
            buffer = await page.screenshot({
                type: "jpeg",
                quality: qConfig.jpegQuality,
                fullPage: params.fullPage ?? false,
            });
        }

        let pageInfo = "";
        try {
            const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo);
            if (pdfInfo) {
                pageInfo = ` — 第${pdfInfo.currentPage}页/共${pdfInfo.totalPages}页`;
            }
        } catch { }

        const smallWarning = (!isTargetCrop && buffer.length < 5 * 1024)
            ? "\n⚠️ 截图可能为空白页面（文件极小），页面可能未完成渲染或被反爬拦截"
            : "";

        return { buffer, pageInfo, warning: `${warning}${smallWarning}` };
    } finally {
        if (page) {
            await page.close().catch(() => { });
        }
    }
}

async function captureSingle(params: FetchScreenshotInput, quality: ImageQuality, qConfig: QualityConfig): Promise<CaptureResult> {
    const pdfTarget = await capturePdfTarget(params, quality, qConfig);
    if (pdfTarget) return pdfTarget;
    return await captureWithBrowser(params, qConfig);
}

async function normalizeToRgba(buffer: Buffer, width: number, height: number): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    const pngBuffer = await sharp(buffer).ensureAlpha().png().toBuffer();
    return await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
    })
        .composite([{ input: pngBuffer, left: 0, top: 0 }])
        .raw()
        .toBuffer();
}

async function createDiffBuffer(base: Buffer, current: Buffer, jpegQuality: number) {
    const sharp = (await import("sharp")).default;
    const [baseMeta, currentMeta] = await Promise.all([
        sharp(base).metadata(),
        sharp(current).metadata(),
    ]);
    const baseWidth = baseMeta.width || 0;
    const baseHeight = baseMeta.height || 0;
    const currentWidth = currentMeta.width || 0;
    const currentHeight = currentMeta.height || 0;
    const width = Math.max(baseWidth, currentWidth);
    const height = Math.max(baseHeight, currentHeight);
    if (width <= 0 || height <= 0) {
        throw new Error("无法读取截图尺寸，不能生成 diff");
    }

    const [baseRaw, currentRaw] = await Promise.all([
        normalizeToRgba(base, width, height),
        normalizeToRgba(current, width, height),
    ]);

    const out = Buffer.alloc(width * height * 4);
    let changedPixels = 0;
    const threshold = 36;

    for (let i = 0; i < out.length; i += 4) {
        const dr = Math.abs(baseRaw[i] - currentRaw[i]);
        const dg = Math.abs(baseRaw[i + 1] - currentRaw[i + 1]);
        const db = Math.abs(baseRaw[i + 2] - currentRaw[i + 2]);
        const changed = dr + dg + db > threshold;
        if (changed) {
            changedPixels++;
            out[i] = 255;
            out[i + 1] = 32;
            out[i + 2] = 32;
            out[i + 3] = 255;
        } else {
            out[i] = Math.round(currentRaw[i] * 0.65 + 255 * 0.35);
            out[i + 1] = Math.round(currentRaw[i + 1] * 0.65 + 255 * 0.35);
            out[i + 2] = Math.round(currentRaw[i + 2] * 0.65 + 255 * 0.35);
            out[i + 3] = 255;
        }
    }

    const buffer = await sharp(out, { raw: { width, height, channels: 4 } })
        .jpeg({ quality: jpegQuality })
        .toBuffer();

    return {
        buffer,
        changedPixels,
        changePercent: changedPixels / (width * height) * 100,
        dimensionsWarning: baseWidth !== currentWidth || baseHeight !== currentHeight
            ? `\n⚠️ 两张截图尺寸不一致 (${baseWidth}x${baseHeight} vs ${currentWidth}x${currentHeight})，已自动补白对齐`
            : "",
    };
}

async function formatScreenshotResult(
    screenshotBuffer: Buffer,
    params: FetchScreenshotInput,
    quality: ImageQuality,
    cacheKey: string,
    startTime: number,
    pageInfo = "",
    warning = "",
    detail = "",
) {
    const saveMode: SaveMode = params.saveMode || "file";
    const sizeKB = (screenshotBuffer.length / 1024).toFixed(1);

    if (saveMode === "file") {
        const autoSplit = params.autoSplit !== false;
        if (autoSplit) {
            const splitResult = await splitOversizedImage(screenshotBuffer, "screenshots", cacheKey, ".jpg");
            if (splitResult.wasSplit) {
                const fileList = splitResult.paths.map((p, i) =>
                    `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`
                ).join("\n");
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `📐 ${splitResult.description}${pageInfo}${warning}\n质量: ${quality}${detail ? ` | ${detail}` : ""}\n\n${fileList}\n\n使用 view_file 工具按顺序查看各片`,
                    }],
                }, startTime, browserManager.lastRetryCount);
            }
            return appendTiming({
                content: [{
                    type: "text" as const,
                    text: `截图完成 (${splitResult.sizes[0]} KB)${pageInfo}${warning}\n质量: ${quality}${detail ? ` | ${detail}` : ""} | 文件: ${splitResult.paths[0]}\n\n使用 view_file 工具查看此图片`,
                }],
            }, startTime, browserManager.lastRetryCount);
        }

        const filePath = saveTempFile("screenshots", cacheKey, ".jpg", screenshotBuffer);
        return appendTiming({
            content: [{
                type: "text" as const,
                text: `截图完成 (${sizeKB} KB)${pageInfo}${warning}\n质量: ${quality}${detail ? ` | ${detail}` : ""} | 文件: ${filePath}\n\n使用 view_file 工具查看此图片`,
            }],
        }, startTime, browserManager.lastRetryCount);
    }

    return appendTiming({
        content: [
            {
                type: "text" as const,
                text: `截图完成 (${sizeKB} KB)${pageInfo}${warning}${detail ? `\n${detail}` : ""}`,
            },
            {
                type: "image" as const,
                data: screenshotBuffer.toString("base64"),
                mimeType: SCREENSHOT_MIME_TYPE,
            },
        ],
    }, startTime, browserManager.lastRetryCount);
}

async function handleDiffScreenshot(
    params: FetchScreenshotInput,
    quality: ImageQuality,
    qConfig: QualityConfig,
    cacheKey: string,
    startTime: number,
) {
    if (!params.diff) {
        throw new Error("diff 参数为空");
    }
    const current = await captureSingle({ ...params, diff: undefined }, quality, qConfig);
    const base = await captureSingle({ ...params, url: params.diff, diff: undefined }, quality, qConfig);
    const diff = await createDiffBuffer(base.buffer, current.buffer, qConfig.jpegQuality);
    const detail = `diff=${params.diff} | changedPixels=${diff.changedPixels} | changePercent=${diff.changePercent.toFixed(3)}%`;
    return await formatScreenshotResult(
        diff.buffer,
        params,
        quality,
        `${cacheKey}_diff`,
        startTime,
        current.pageInfo || base.pageInfo || "",
        `${current.warning || ""}${base.warning || ""}${diff.dimensionsWarning}`,
        detail,
    );
}

export function registerFetchScreenshot(server: McpServer): void {
    server.registerTool(
        "web_fetch_screenshot",
        {
            title: "网页截图",
            description: `使用带 Cookie 的浏览器对网页截图。
支持全页截图和指定元素截图。
支持按文本内容语义定位局域截图，以及与另一 URL 做截图差异对比。
支持 file:// 协议打开本地文件（HTML、PDF、DOCX、PPTX、XLSX、图片等）进行截图。

参数:
  - url (string, 必须): 要截图的网页 URL（支持 http/https/file 协议）
  - fullPage (boolean, 可选): 是否全页截图，默认 false
  - selector (string, 可选): CSS 选择器，截取指定元素
  - target (string, 可选): 按文本内容定位局域截图，与 selector 互斥
  - scale (number, 可选): target 局域截图放大比例，默认 1.4
  - diff (string, 可选): 对比基准 URL，返回差异高亮图
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
                target: FetchScreenshotInputSchema.shape.target,
                scale: FetchScreenshotInputSchema.shape.scale,
                diff: FetchScreenshotInputSchema.shape.diff,
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
        },
        async (params: FetchScreenshotInput) => {
            touchActivity();
            const startTime = Date.now();
            const quality: ImageQuality = params.quality || "default";
            const saveMode: SaveMode = params.saveMode || "file";
            const qConfig = QUALITY_PRESETS[quality];

            if (isEpubUrl(params.url)) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: "ERR_UNSUPPORTED_SCREENSHOT_ROUTE: EPUB 截图需要后续 HTML preview renderer；当前阶段请先使用 web_fetch_page 提取正文，或 web_inspect(mode=\"structure\") 查看目录和章节结构。",
                    }],
                };
            }

            if (params.selector && params.target) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: `selector 与 target 不能同时使用；请只选择一种定位方式`,
                    }],
                };
            }

            if (params.pages && (params.target || params.diff)) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: `pages 模式暂不支持 target 或 diff，请改用 page 指定单页`,
                    }],
                };
            }

            // ========== 多页模式 ==========
            if (params.pages) {
                return handleMultiPageScreenshot(params, quality, qConfig, startTime);
            }

            // ========== 单页模式（原有逻辑）==========
            const cacheKey = generateCacheKey(
                params.url,
                quality,
                params.fullPage,
                params.selector,
                params.target,
                params.scale,
                params.diff,
                params.scrollCount,
                params.page,
            );
            if (saveMode === "file") {
                const cached = getTempFile("screenshots", cacheKey, ".jpg");
                if (cached) {
                    const stat = (await import("fs")).statSync(cached);
                    const sizeKB = (stat.size / 1024).toFixed(1);
                    console.error(`[web-fetcher] 截图缓存命中: ${cached}`);
                    return {
                        content: [{
                            type: "text" as const,
                            text: `截图完成 (${sizeKB} KB, 缓存命中)\n质量: ${quality} | 文件: ${cached}\n\n使用 view_file 工具查看此图片`,
                        }],
                    };
                }
            }

            if (params.diff) {
                try {
                    return await handleDiffScreenshot(params, quality, qConfig, cacheKey, startTime);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return {
                        isError: true,
                        content: [{
                            type: "text" as const,
                            text: `Diff 截图失败: ${message}`,
                        }],
                    };
                }
            }

            if (params.target) {
                try {
                    const capture = await captureSingle(params, quality, qConfig);
                    return await formatScreenshotResult(
                        capture.buffer,
                        params,
                        quality,
                        cacheKey,
                        startTime,
                        capture.pageInfo,
                        capture.warning,
                        capture.detail,
                    );
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return {
                        isError: true,
                        content: [{
                            type: "text" as const,
                            text: `语义局域截图失败: ${message}`,
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

                let screenshotBuffer: Buffer;

                if (params.selector) {
                    const element = await page.$(params.selector);
                    if (!element) {
                        return {
                            isError: true,
                            content: [{
                                type: "text" as const,
                                text: `未找到选择器 "${params.selector}" 匹配的元素`,
                            }],
                        };
                    }
                    screenshotBuffer = await element.screenshot({
                        type: "jpeg",
                        quality: qConfig.jpegQuality,
                    });
                } else {
                    // v6.1: 截图前等待视觉资源就绪
                    await browserManager.waitForVisualReady(page);
                    screenshotBuffer = await page.screenshot({
                        type: "jpeg",
                        quality: qConfig.jpegQuality,
                        fullPage: params.fullPage ?? false,
                    });
                }

                // 截图有效性验证
                if (screenshotBuffer.length < 5 * 1024) {
                    console.error(
                        `[web-fetcher] 截图过小 (${screenshotBuffer.length} bytes)，等待 3s 重试...`
                    );
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
                    const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo);
                    if (pdfInfo) {
                        pageInfo = ` — 第${pdfInfo.currentPage}页/共${pdfInfo.totalPages}页`;
                    }
                } catch { }

                // 根据 saveMode 返回
                if (saveMode === "file") {
                    const autoSplit = params.autoSplit !== false;
                    if (autoSplit) {
                        const splitResult = await splitOversizedImage(screenshotBuffer, "screenshots", cacheKey, ".jpg");
                        if (splitResult.wasSplit) {
                            const fileList = splitResult.paths.map((p, i) =>
                                `  片 ${i + 1}/${splitResult.paths.length} (${splitResult.sizes[i]} KB): ${p}`
                            ).join("\n");
                            return appendTiming({
                                content: [{
                                    type: "text" as const,
                                    text: `📐 ${splitResult.description}${pageInfo}${warning}\n质量: ${quality}\n\n${fileList}\n\n使用 view_file 工具按顺序查看各片`,
                                }],
                            }, startTime, browserManager.lastRetryCount);
                        }
                        // 未超限，splitResult.paths[0] 就是保存的文件
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `截图完成 (${splitResult.sizes[0]} KB)${pageInfo}${warning}\n质量: ${quality} | 文件: ${splitResult.paths[0]}\n\n使用 view_file 工具查看此图片`,
                            }],
                        }, startTime, browserManager.lastRetryCount);
                    } else {
                        const filePath = saveTempFile("screenshots", cacheKey, ".jpg", screenshotBuffer);
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `截图完成 (${sizeKB} KB)${pageInfo}${warning}\n质量: ${quality} | 文件: ${filePath}\n\n使用 view_file 工具查看此图片`,
                            }],
                        }, startTime, browserManager.lastRetryCount);
                    }
                } else {
                    const base64 = screenshotBuffer.toString("base64");
                    return appendTiming({
                        content: [
                            {
                                type: "text" as const,
                                text: `截图完成 (${sizeKB} KB)${pageInfo}${warning}`,
                            },
                            {
                                type: "image" as const,
                                data: base64,
                                mimeType: SCREENSHOT_MIME_TYPE,
                            },
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
                        text: `截图失败: ${message}${hint}`,
                    }],
                };
            } finally {
                if (page) {
                    await page.close().catch(() => { });
                }
            }
        }
    );
}

// ========== 多页批量截图处理 ==========
async function handleMultiPageScreenshot(
    params: FetchScreenshotInput,
    quality: ImageQuality,
    qConfig: typeof QUALITY_PRESETS[ImageQuality],
    startTime: number,
) {
    const saveMode: SaveMode = params.saveMode || "file";

    // 多页模式只支持 file 保存
    if (saveMode === "inline") {
        return {
            isError: true,
            content: [{
                type: "text" as const,
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

        const pdfInfo = await page.evaluate(() => (window as any).__mcpPdfInfo);
        if (!pdfInfo || !pdfInfo.totalPages) {
            return {
                isError: true,
                content: [{
                    type: "text" as const,
                    text: `pages 参数仅支持 PDF/Office/TeX 文件，此文件不支持分页截图`,
                }],
            };
        }

        const totalPages = pdfInfo.totalPages;

        // 解析 pages 参数为具体页码数组
        const requestedPages = parsePages(params.pages!, totalPages);

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
        const results: Array<{ pageNum: number; filePath: string; sizeKB: string }> = [];
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
                    type: "text" as const,
                    text: `截图失败: 未能截取任何页面`,
                }],
            };
        }

        const totalSizeStr = totalSize > 1024 * 1024
            ? `${(totalSize / 1024 / 1024).toFixed(1)}MB`
            : `${(totalSize / 1024).toFixed(1)}KB`;

        // ≤3 页: 直接返回路径列表
        if (results.length <= 3) {
            const lines = results.map(r =>
                `第${r.pageNum}页 (${r.sizeKB}KB): ${r.filePath}`
            ).join("\n");
            return appendTiming({
                content: [{
                    type: "text" as const,
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
        ].join("\n") + "\n";

        const manifestKey = generateCacheKey(params.url, quality, "manifest", params.pages);
        const manifestPath = saveTempFile("screenshots", manifestKey, ".txt", Buffer.from(manifestLines, "utf-8"));

        return appendTiming({
            content: [{
                type: "text" as const,
                text: `${results.length}页截图完成 (共${totalSizeStr}, ${quality}质量) — 文档共${totalPages}页\n清单文件: ${manifestPath}\n\n使用 view_file 查看清单，或直接 view_file 查看指定页的截图`,
            }],
        }, startTime, browserManager.lastRetryCount);

    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            isError: true,
            content: [{
                type: "text" as const,
                text: `多页截图失败: ${message}`,
            }],
        };
    } finally {
        if (page) {
            await page.close().catch(() => { });
        }
    }
}
