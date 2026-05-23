import type { Page } from "playwright";
import { browserManager } from "../browser.js";
import { safePageEvaluate } from "../extractor.js";
import { extractDomStructureFromPage } from "../inspector/dom-inspector.js";
import { QUALITY_PRESETS } from "../constants.js";
import { generateCacheKey, splitOversizedImage } from "../temp-store.js";
import type { InspectElement } from "../inspector/types.js";

export interface PageSnapshotOptions {
    sessionId?: string;
    fullPage?: boolean;
    maxVisibleChars?: number;
    maxDomElements?: number;
}

export async function buildPageSnapshot(page: Page, options: PageSnapshotOptions = {}): Promise<string> {
    const maxVisibleChars = options.maxVisibleChars ?? 8000;
    const maxDomElements = options.maxDomElements ?? 30;

    await browserManager.waitForVisualReady(page);
    const qConfig = QUALITY_PRESETS.default;
    const buffer = await page.screenshot({
        type: "jpeg",
        quality: qConfig.jpegQuality,
        fullPage: options.fullPage ?? false,
    });
    const cacheKey = generateCacheKey(page.url(), "snapshot", Date.now(), options.fullPage ?? false);
    const splitResult = await splitOversizedImage(buffer, "screenshots", cacheKey, ".jpg");
    const screenshotText = splitResult.wasSplit
        ? `${splitResult.description}\n${splitResult.paths.map((path, index) => `  ${index + 1}. ${path} (${splitResult.sizes[index]} KB)`).join("\n")}`
        : `${splitResult.paths[0]} (${splitResult.sizes[0]} KB)`;

    const visibleText = await safePageEvaluate(page, () => {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    const tag = parent.tagName;
                    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
                        return NodeFilter.FILTER_REJECT;
                    }
                    const rect = parent.getBoundingClientRect();
                    if (
                        rect.top < vh && rect.bottom > 0 &&
                        rect.left < vw && rect.right > 0 &&
                        rect.width > 0 && rect.height > 0
                    ) {
                        return NodeFilter.FILTER_ACCEPT;
                    }
                    return NodeFilter.FILTER_REJECT;
                },
            },
        );

        const lines: string[] = [];
        const seen = new Set<string>();
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const text = (node.textContent || "").trim().replace(/\s+/g, " ");
            if (text.length > 1 && !seen.has(text)) {
                seen.add(text);
                lines.push(text);
            }
        }
        return lines.join("\n");
    });

    const structure = await extractDomStructureFromPage(page, { maxDepth: 12 }).catch(() => []);
    const pageStructure = structure[0];
    const domElements = pageStructure?.elements ?? [];
    const domSummary = domElements
        .slice(0, maxDomElements)
        .map((element, index) => `${index + 1}. ${describeElement(element)}`)
        .join("\n");
    const truncatedVisible = visibleText.length > maxVisibleChars
        ? `${visibleText.slice(0, maxVisibleChars)}\n...[截断 ${visibleText.length - maxVisibleChars} 字符]`
        : visibleText;

    return [
        options.sessionId ? `SessionId: ${options.sessionId}` : "",
        `当前 URL: ${page.url()}`,
        "",
        `## 截图文件`,
        screenshotText,
        "",
        `## 视口可见文本 (${visibleText.length} 字符)`,
        truncatedVisible || "(无可见文本)",
        "",
        `## DOM 摘要 (${domElements.length} 个可见元素，显示前 ${Math.min(maxDomElements, domElements.length)} 个)`,
        domSummary || "(未提取到 DOM 元素)",
    ].filter(Boolean).join("\n");
}

function describeElement(element: InspectElement): string {
    const parts: string[] = [];
    const name = element.name || element.type || "element";
    const selectorBits = [
        element.id ? `#${element.id}` : "",
        element.className ? `.${String(element.className).trim().split(/\s+/).slice(0, 2).join(".")}` : "",
    ].join("");
    parts.push(`${name}${selectorBits}`);
    if (element.role) parts.push(`role=${element.role}`);
    const text = (element.text || "").trim().replace(/\s+/g, " ");
    if (text) parts.push(`text="${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`);
    const width = Math.round(element.bounds.x1 - element.bounds.x0);
    const height = Math.round(element.bounds.y1 - element.bounds.y0);
    parts.push(`bounds=${Math.round(element.bounds.x0)},${Math.round(element.bounds.y0)},${width}x${height}`);
    return parts.join(" ");
}
