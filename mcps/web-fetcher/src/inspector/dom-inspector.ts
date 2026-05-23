import type { Page } from "playwright";
import { browserManager } from "../browser.js";
import { ensureTempDirs, generateCacheKey, TEMP_DIRS } from "../temp-store.js";
import {
    expandRect,
    isOverflowing,
    overlapArea,
    overlapPercent,
} from "./overlap.js";
import type {
    InspectElement,
    InspectIssue,
    InspectIssueSeverity,
    InspectMetadataValue,
    InspectResult,
    PageStructure,
    Rect,
} from "./types.js";

export type DomCheck = "overlap" | "overflow" | "readability" | "alignment" | (string & {});

export interface DomInspectorOptions {
    timeout?: number;
    scrollCount?: number;
    maxDepth?: number;
    overlapThresholdPercent?: number;
    smallFontThresholdPx?: number;
    contrastRatioThreshold?: number;
}

export interface DomInspectElement extends InspectElement {
    tag: string;
    zIndex: string;
    visibility: string;
    overflow: string;
    position: string;
    backgroundColor: string;
}

interface RawDomElement {
    tag: string;
    id: string;
    className: string;
    text: string;
    bounds: Rect;
    zIndex: string;
    zOrder: number;
    visibility: string;
    opacity: number;
    overflow: string;
    position: string;
    fontSize: number;
    color: string;
    backgroundColor: string;
    domPath: string;
    clippingBounds: Rect | null;
}

const DEFAULT_OVERLAP_THRESHOLD_PERCENT = 15;
const DEFAULT_MAX_DEPTH = 20;
const MIN_VISIBLE_ELEMENT_SIZE = 5;
const SMALL_FONT_THRESHOLD_PX = 10;
const MIN_CONTRAST_RATIO = 4.5;
const ISSUE_BOUNDS_PADDING = 12;

export async function extractDomStructure(url: string, options: DomInspectorOptions = {}): Promise<PageStructure[]> {
    return await withDomPage(url, options, async page => await extractDomStructureFromPage(page, options));
}

export async function detectDomIssues(
    url: string,
    checks: DomCheck[] = ["overlap", "overflow"],
    autoScreenshot = true,
    scale = 1.4,
    options: DomInspectorOptions = {},
): Promise<InspectResult> {
    return await withDomPage(url, options, async page => {
        const structure = await extractDomStructureFromPage(page, options);
        const result = detectDomIssuesFromStructure(structure, checks, autoScreenshot, scale, options);
        if (autoScreenshot) {
            await captureDomIssueScreenshots(page, result.issues, scale);
        }
        return result;
    });
}

export async function extractDomStructureFromPage(page: Page, options: DomInspectorOptions = {}): Promise<PageStructure[]> {
    await browserManager.waitForVisualReady(page, 3_000).catch(() => undefined);
    const raw = await page.evaluate(extractVisibleDomElements, {
        maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
        minElementSize: MIN_VISIBLE_ELEMENT_SIZE,
    });
    const elements = raw.elements.map(toInspectElement);

    return [
        {
            page: 1,
            dimensions: {
                width: raw.dimensions.width,
                height: raw.dimensions.height,
                unit: "px",
            },
            elements,
            source: "dom",
            metadata: {
                url: raw.url,
                title: raw.title,
                viewportWidth: raw.dimensions.viewportWidth,
                viewportHeight: raw.dimensions.viewportHeight,
            },
        },
    ];
}

export function detectDomIssuesFromStructure(
    structure: PageStructure[],
    checks: DomCheck[] = ["overlap", "overflow"],
    autoScreenshot = true,
    scale = 1.4,
    options: DomInspectorOptions = {},
): InspectResult {
    const enabled = new Set(checks);
    const issues: InspectIssue[] = [];

    for (const page of structure) {
        const elements = page.elements as DomInspectElement[];
        if (enabled.has("overlap")) {
            issues.push(...detectOverlapIssues(page.page, elements, page.dimensions.width, page.dimensions.height, autoScreenshot, scale, options));
        }
        if (enabled.has("overflow")) {
            issues.push(...detectOverflowIssues(page.page, elements, autoScreenshot, scale));
        }
        if (enabled.has("readability")) {
            issues.push(...detectReadabilityIssues(page.page, elements, autoScreenshot, scale, options));
        }
    }

    const errors = issues.filter(issue => issue.severity === "error").length;
    const warnings = issues.filter(issue => issue.severity === "warning").length;
    const elementsCount = structure.reduce((sum, page) => sum + page.elements.length, 0);

    return {
        summary: {
            pages: structure.length,
            elements: elementsCount,
            issues: issues.length,
            warnings,
            errors,
        },
        issues,
        structure,
    };
}

async function withDomPage<T>(url: string, options: DomInspectorOptions, callback: (page: Page) => Promise<T>): Promise<T> {
    let page: Page | undefined;
    try {
        page = await browserManager.navigateTo(url, {
            timeout: options.timeout,
            scrollCount: options.scrollCount,
        });
        return await callback(page);
    } finally {
        if (page) {
            await page.close().catch(() => undefined);
        }
    }
}

async function captureDomIssueScreenshots(page: Page, issues: InspectIssue[], scale: number): Promise<void> {
    ensureTempDirs();
    const pageBounds = await page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight),
    }));

    for (const [index, issue] of issues.entries()) {
        if (!issue.bounds) {
            continue;
        }
        const clip = clampToPage(issue.bounds, pageBounds.width, pageBounds.height, Math.max(1, scale));
        const width = Math.max(1, clip.x1 - clip.x0);
        const height = Math.max(1, clip.y1 - clip.y0);
        const key = generateCacheKey("dom-issue", page.url(), issue.page, issue.type, index, clip.x0, clip.y0, width, height);
        const outputPath = `${TEMP_DIRS.screenshots}\\${key}_dom_issue.jpg`;
        await page.screenshot({
            path: outputPath,
            type: "jpeg",
            quality: 85,
            clip: {
                x: clip.x0,
                y: clip.y0,
                width,
                height,
            },
        });
        issue.screenshotPath = outputPath;
        if (issue.metadata) {
            issue.metadata.screenshotPending = false;
        }
    }
}

function toInspectElement(raw: RawDomElement, index: number): DomInspectElement {
    const name = elementName(raw);
    return {
        type: elementType(raw),
        name,
        text: raw.text,
        bounds: raw.bounds,
        zOrder: raw.zOrder,
        fontSize: raw.fontSize,
        color: raw.color,
        opacity: raw.opacity,
        source: "dom",
        id: raw.id || undefined,
        className: raw.className || undefined,
        tag: raw.tag,
        zIndex: raw.zIndex,
        visibility: raw.visibility,
        overflow: raw.overflow,
        position: raw.position,
        backgroundColor: raw.backgroundColor,
        metadata: {
            tag: raw.tag,
            zIndex: raw.zIndex,
            visibility: raw.visibility,
            overflow: raw.overflow,
            position: raw.position,
            backgroundColor: raw.backgroundColor,
            domPath: raw.domPath,
            clippingBounds: raw.clippingBounds ? rectToMetadata(raw.clippingBounds) : null,
            domIndex: index,
        },
    };
}

function elementName(element: RawDomElement): string {
    const id = element.id ? `#${element.id}` : "";
    const className = element.className
        ? `.${element.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")}`
        : "";
    return `${element.tag}${id}${className}`;
}

function elementType(element: RawDomElement): InspectElement["type"] {
    if (element.tag === "img" || element.tag === "picture" || element.tag === "svg" || element.tag === "canvas" || element.tag === "video") {
        return "image";
    }
    if (element.tag === "a") {
        return "link";
    }
    if (element.tag === "table") {
        return "table";
    }
    if (element.text) {
        return "text";
    }
    if (["div", "section", "main", "article", "header", "footer", "nav", "aside"].includes(element.tag)) {
        return "container";
    }
    return "unknown";
}

function detectOverlapIssues(
    page: number,
    elements: DomInspectElement[],
    pageWidth: number,
    pageHeight: number,
    autoScreenshot: boolean,
    scale: number,
    options: DomInspectorOptions,
): InspectIssue[] {
    const threshold = options.overlapThresholdPercent ?? DEFAULT_OVERLAP_THRESHOLD_PERCENT;
    const candidates = elements.filter(element => isRenderableElement(element));
    const issues: InspectIssue[] = [];

    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const first = candidates[i];
            const second = candidates[j];
            if (areDomRelatives(first, second)) {
                continue;
            }

            const area = overlapArea(first.bounds, second.bounds);
            if (area <= 0) {
                continue;
            }

            const percent = overlapPercent(first.bounds, second.bounds);
            if (percent < threshold) {
                continue;
            }

            const bounds = clampToPage(unionBounds(first.bounds, second.bounds), pageWidth, pageHeight, scale);
            issues.push({
                type: "overlap",
                severity: overlapSeverity(percent),
                page,
                description: `DOM elements "${first.name}" and "${second.name}" overlap by ${percent.toFixed(1)}% of the smaller element.`,
                elements: [first, second],
                bounds: autoScreenshot ? bounds : undefined,
                metadata: {
                    overlapArea: area,
                    overlapPercent: Number(percent.toFixed(2)),
                    screenshotPending: autoScreenshot,
                },
            });
        }
    }

    return issues;
}

function detectOverflowIssues(
    page: number,
    elements: DomInspectElement[],
    autoScreenshot: boolean,
    scale: number,
): InspectIssue[] {
    const issues: InspectIssue[] = [];

    for (const element of elements) {
        const clippingBounds = rectMetadata(element, "clippingBounds");
        if (!clippingBounds || !isRenderableElement(element)) {
            continue;
        }

        const overflow = isOverflowing(element.bounds, clippingBounds);
        if (!overflow.overflowing) {
            continue;
        }

        issues.push({
            type: "overflow",
            severity: "warning",
            page,
            description: `DOM element "${element.name}" overflows its clipping container on: ${overflow.sides.join(", ")}.`,
            elements: [element],
            bounds: autoScreenshot ? expandRect(element.bounds, ISSUE_BOUNDS_PADDING * scale) : undefined,
            metadata: {
                sides: overflow.sides,
                clippingBounds: rectToMetadata(clippingBounds),
                screenshotPending: autoScreenshot,
            },
        });
    }

    return issues;
}

function detectReadabilityIssues(
    page: number,
    elements: DomInspectElement[],
    autoScreenshot: boolean,
    scale: number,
    options: DomInspectorOptions,
): InspectIssue[] {
    const issues: InspectIssue[] = [];
    const smallFontThreshold = options.smallFontThresholdPx ?? SMALL_FONT_THRESHOLD_PX;
    const contrastThreshold = options.contrastRatioThreshold ?? MIN_CONTRAST_RATIO;

    for (const element of elements) {
        if (!isRenderableElement(element) || !element.text) {
            continue;
        }

        const fontSize = element.fontSize ?? 0;
        if (fontSize > 0 && fontSize < smallFontThreshold) {
            issues.push({
                type: "small-font",
                severity: "warning",
                page,
                description: `DOM element "${element.name}" font size ${fontSize.toFixed(1)}px is below ${smallFontThreshold}px.`,
                elements: [element],
                bounds: autoScreenshot ? expandRect(element.bounds, ISSUE_BOUNDS_PADDING * scale) : undefined,
                metadata: {
                    check: "small-font",
                    fontSize,
                    threshold: smallFontThreshold,
                    screenshotPending: autoScreenshot,
                },
            });
        }

        const contrast = contrastRatioForElement(element);
        if (contrast !== null && contrast < contrastThreshold) {
            issues.push({
                type: "low-contrast",
                severity: "warning",
                page,
                description: `DOM element "${element.name}" contrast ratio ${contrast.toFixed(2)} is below ${contrastThreshold}.`,
                elements: [element],
                bounds: autoScreenshot ? expandRect(element.bounds, ISSUE_BOUNDS_PADDING * scale) : undefined,
                metadata: {
                    check: "contrast",
                    contrastRatio: Number(contrast.toFixed(2)),
                    threshold: contrastThreshold,
                    color: element.color ?? "",
                    backgroundColor: element.backgroundColor ?? "",
                    screenshotPending: autoScreenshot,
                },
            });
        }

        const clippingBounds = rectMetadata(element, "clippingBounds");
        if (clippingBounds) {
            const overflow = isOverflowing(element.bounds, clippingBounds);
            if (overflow.overflowing) {
                issues.push({
                    type: "clipped",
                    severity: "warning",
                    page,
                    description: `DOM text element "${element.name}" may be clipped by its container on: ${overflow.sides.join(", ")}.`,
                    elements: [element],
                    bounds: autoScreenshot ? expandRect(element.bounds, ISSUE_BOUNDS_PADDING * scale) : undefined,
                    metadata: {
                        check: "text-clipping",
                        sides: overflow.sides,
                        clippingBounds: rectToMetadata(clippingBounds),
                        screenshotPending: autoScreenshot,
                    },
                });
            }
        }
    }

    return issues;
}

function isRenderableElement(element: DomInspectElement): boolean {
    const width = element.bounds.x1 - element.bounds.x0;
    const height = element.bounds.y1 - element.bounds.y0;
    return width > 0 && height > 0 && element.visibility !== "hidden" && element.visibility !== "collapse" && (element.opacity ?? 1) > 0;
}

function areDomRelatives(first: DomInspectElement, second: DomInspectElement): boolean {
    const firstPath = stringMetadata(first, "domPath");
    const secondPath = stringMetadata(second, "domPath");
    return Boolean(firstPath && secondPath && (firstPath.startsWith(`${secondPath}/`) || secondPath.startsWith(`${firstPath}/`)));
}

function overlapSeverity(percent: number): InspectIssueSeverity {
    if (percent >= 60) {
        return "error";
    }
    return "warning";
}

function unionBounds(first: Rect, second: Rect): Rect {
    return {
        x0: Math.min(first.x0, second.x0),
        y0: Math.min(first.y0, second.y0),
        x1: Math.max(first.x1, second.x1),
        y1: Math.max(first.y1, second.y1),
    };
}

function clampToPage(rect: Rect, width: number, height: number, scale: number): Rect {
    const expanded = expandRect(rect, ISSUE_BOUNDS_PADDING * scale);
    return {
        x0: Math.max(0, Math.min(expanded.x0, width)),
        y0: Math.max(0, Math.min(expanded.y0, height)),
        x1: Math.max(0, Math.min(expanded.x1, width)),
        y1: Math.max(0, Math.min(expanded.y1, height)),
    };
}

function stringMetadata(element: DomInspectElement, key: string): string | null {
    const value = element.metadata?.[key];
    return typeof value === "string" ? value : null;
}

function rectMetadata(element: DomInspectElement, key: string): Rect | null {
    const value = element.metadata?.[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const maybeRect = value as Record<string, unknown>;
    if (
        typeof maybeRect.x0 === "number"
        && typeof maybeRect.y0 === "number"
        && typeof maybeRect.x1 === "number"
        && typeof maybeRect.y1 === "number"
    ) {
        return {
            x0: maybeRect.x0,
            y0: maybeRect.y0,
            x1: maybeRect.x1,
            y1: maybeRect.y1,
        };
    }
    return null;
}

function rectToMetadata(rect: Rect): Record<string, InspectMetadataValue> {
    return {
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: rect.y1,
    };
}

interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

function parseCssColor(value: string): Rgba | null {
    const match = value.match(/rgba?\(([^)]+)\)/iu);
    if (!match) return null;
    const parts = match[1].split(",").map(part => Number(part.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(part => !Number.isFinite(part))) {
        return null;
    }
    return {
        r: parts[0],
        g: parts[1],
        b: parts[2],
        a: Number.isFinite(parts[3]) ? parts[3] : 1,
    };
}

function relativeLuminance(channel: number): number {
    const normalized = Math.max(0, Math.min(255, channel)) / 255;
    return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
}

function contrastRatioForElement(element: DomInspectElement): number | null {
    if (!element.color || !element.backgroundColor) {
        return null;
    }
    const foreground = parseCssColor(element.color);
    const background = parseCssColor(element.backgroundColor);
    if (!foreground || !background || background.a < 0.95) {
        return null;
    }
    const fgLuminance = 0.2126 * relativeLuminance(foreground.r)
        + 0.7152 * relativeLuminance(foreground.g)
        + 0.0722 * relativeLuminance(foreground.b);
    const bgLuminance = 0.2126 * relativeLuminance(background.r)
        + 0.7152 * relativeLuminance(background.g)
        + 0.0722 * relativeLuminance(background.b);
    const lighter = Math.max(fgLuminance, bgLuminance);
    const darker = Math.min(fgLuminance, bgLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

function extractVisibleDomElements(args: { maxDepth: number; minElementSize: number }) {
    const excludedTags = new Set(["script", "style", "noscript", "meta", "link", "title", "head", "template"]);
    const maxDepth = Math.max(1, args.maxDepth || 20);
    const minElementSize = Math.max(1, args.minElementSize || 5);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, viewportWidth);
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, viewportHeight);

    const toRect = (rect: DOMRect): Rect => ({
        x0: rect.left + window.scrollX,
        y0: rect.top + window.scrollY,
        x1: rect.right + window.scrollX,
        y1: rect.bottom + window.scrollY,
    });

    const isVisible = (element: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean => {
        if (excludedTags.has(element.tagName.toLowerCase())) return false;
        if (style.display === "none") return false;
        if (style.visibility === "hidden" || style.visibility === "collapse") return false;
        if (Number.parseFloat(style.opacity || "1") <= 0) return false;
        if (rect.width < minElementSize || rect.height < minElementSize) return false;
        return true;
    };

    const domPathParts = (element: Element): string[] => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.documentElement) {
            const parent = current.parentElement as Element | null;
            if (!parent) break;
            const index = Array.prototype.indexOf.call(parent.children, current);
            parts.push(`${current.tagName.toLowerCase()}[${index}]`);
            current = parent;
        }
        return parts.reverse();
    };

    const domPath = (element: Element): string => {
        return domPathParts(element).join("/");
    };

    const clippingBounds = (element: Element, position: string): Rect | null => {
        if (position === "fixed" || position === "sticky") {
            return {
                x0: window.scrollX,
                y0: window.scrollY,
                x1: window.scrollX + viewportWidth,
                y1: window.scrollY + viewportHeight,
            };
        }

        let current = element.parentElement;
        while (current && current !== document.documentElement) {
            const style = getComputedStyle(current);
            const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
            if (/(hidden|clip|auto|scroll)/.test(overflow)) {
                const rect = current.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return toRect(rect);
                }
            }
            current = current.parentElement;
        }
        return { x0: 0, y0: 0, x1: width, y1: height };
    };

    const elements = Array.from(document.body?.querySelectorAll("*") ?? [])
        .map(element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (!isVisible(element, style, rect)) {
                return null;
            }
            if (domPathParts(element).length > maxDepth) {
                return null;
            }

            const zIndex = style.zIndex || "auto";
            const parsedZIndex = Number.parseInt(zIndex, 10);
            const position = style.position || "static";
            const text = ((element as HTMLElement).innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 100);

            return {
                tag: element.tagName.toLowerCase(),
                id: element.id || "",
                className: typeof element.className === "string" ? element.className : "",
                text,
                bounds: toRect(rect),
                zIndex,
                zOrder: Number.isFinite(parsedZIndex) ? parsedZIndex : 0,
                visibility: style.visibility,
                opacity: Number.parseFloat(style.opacity || "1"),
                overflow: `${style.overflow} ${style.overflowX} ${style.overflowY}`,
                position,
                fontSize: Number.parseFloat(style.fontSize || "0") || 0,
                color: style.color,
                backgroundColor: style.backgroundColor,
                domPath: domPath(element),
                clippingBounds: clippingBounds(element, position),
            };
        })
        .filter((element): element is RawDomElement => element !== null);

    return {
        url: window.location.href,
        title: document.title,
        dimensions: {
            width,
            height,
            viewportWidth,
            viewportHeight,
        },
        elements,
    };
}
