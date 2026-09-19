import { z } from "zod";
import type { Page } from "playwright";

export const MAX_VIEWPORT_PIXELS = 8_388_608;

export const viewportSchema = z.object({
    width: z.number().int().min(240).max(4096).describe("网页 CSS 视口宽度，240–4096 px"),
    height: z.number().int().min(240).max(4096).describe("网页 CSS 视口高度，240–4096 px"),
}).strict().refine(value => value.width * value.height <= MAX_VIEWPORT_PIXELS, {
    message: `viewport 面积不能超过 ${MAX_VIEWPORT_PIXELS} CSS 像素`,
}).describe("仅网页响应式 CSS 视口；总面积最多 8,388,608 px。省略保留原默认或已有会话尺寸。与 fullPage（滚动范围）、scale（输出放大）不同，不模拟设备 UA、触摸或 DPR；不适用于 PDF/Office/EPUB 等文件预览");

export type ResponsiveViewport = z.infer<typeof viewportSchema>;

const DOCUMENT_EXTENSION = /\.(?:pdf|docx?|pptx?|xlsx?|ods|odt|odp|rtf|epub|tex|csv|tsv|txt|md|json|ya?ml|xml|zip|jpe?g|png|gif|webp|bmp|tiff?|avif)$/i;

export function assertViewportTarget(url: string, viewport?: ResponsiveViewport): void {
    if (!viewport) return;
    viewportSchema.parse(viewport);
    const parsed = new URL(url);
    const pathname = decodeURIComponent(parsed.pathname);
    if ((parsed.protocol === "file:" && !/\.(?:html?|xhtml)$/i.test(pathname)) || DOCUMENT_EXTENSION.test(pathname)) {
        throw new Error("ERR_VIEWPORT_UNSUPPORTED_TARGET: viewport 仅适用于网页/HTML 响应式布局，不适用于 PDF、Office、EPUB 或其他文件预览；请省略 viewport，文件页码和输出 scale 保持原用法");
    }
}

export async function applyExplicitViewport(page: Page, viewport?: ResponsiveViewport): Promise<void> {
    if (!viewport) return;
    viewportSchema.parse(viewport);
    const currentUrl = page.url();
    if (currentUrl !== "about:blank") {
        assertViewportTarget(currentUrl, viewport);
        const supportsViewport = await page.evaluate(() => {
            const documentPreview = (window as unknown as { __mcpPdfInfo?: unknown }).__mcpPdfInfo;
            return !documentPreview && ["text/html", "application/xhtml+xml"].includes(document.contentType);
        });
        if (!supportsViewport) {
            throw new Error("ERR_VIEWPORT_UNSUPPORTED_TARGET: 当前页面是文档/媒体预览，不支持响应式网页 viewport");
        }
    }
    const current = page.viewportSize();
    if (current?.width !== viewport.width || current?.height !== viewport.height) {
        await page.setViewportSize(viewport);
    }
}
