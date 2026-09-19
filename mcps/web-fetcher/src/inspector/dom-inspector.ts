import type { Page } from "playwright";
import { browserManager } from "../browser.js";
import { applyExplicitViewport, type ResponsiveViewport } from "../viewport.js";
import { throwIfRequestExpired } from "../request-context.js";
import { extractVisibleDomElements, type RawDomElement } from "./dom-evidence.js";
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
    InspectMetadataValue,
    InspectResult,
    PageStructure,
    Rect,
} from "./types.js";

export type DomCheck = "overlap" | "overflow" | "readability" | "alignment" | (string & {});

export interface DomInspectorOptions {
    viewport?: ResponsiveViewport;
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

const DEFAULT_OVERLAP_THRESHOLD_PERCENT = 15;
const DEFAULT_MAX_DEPTH = 20;
const MIN_VISIBLE_ELEMENT_SIZE = 5;
const SMALL_FONT_THRESHOLD_PX = 10;
const MIN_CONTRAST_RATIO = 4.5;
const ISSUE_BOUNDS_PADDING = 12;
const MAX_DOM_OVERLAP_ISSUES = 200;
const MAX_DOM_PAIR_CHECKS = 30_000;
const MAX_DOM_RECT_CHECKS = 100_000;
const MAX_DOM_ISSUE_SCREENSHOTS = 10;

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
    let readinessNote: string | undefined;
    try {
        const readiness = await browserManager.waitForVisualReady(page, 3_000, { fullPage: false });
        if (readiness.complete === false) readinessNote = readiness.note;
    } catch (error) {
        throwIfRequestExpired();
        const code = (error as { code?: string })?.code;
        if (code === "request_cancelled" || code === "request_deadline_exceeded" || (error instanceof Error && error.name === "AbortError")) throw error;
        readinessNote = `视觉资源就绪检查失败，结构可能不完整：${error instanceof Error ? error.message : String(error)}`;
    }
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
                inspectionLimitations: raw.inspectionLimitations,
                ...(readinessNote ? { readinessNote } : {}),
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
            const overlap = detectOverlapIssues(page.page, elements, page.dimensions.width, page.dimensions.height, autoScreenshot, scale, options);
            issues.push(...overlap.issues);
            if (overlap.truncated) {
                page.metadata ??= {};
                const existing = page.metadata.inspectionLimitations;
                page.metadata.inspectionLimitations = [...(Array.isArray(existing) ? existing : []), "Overlap analysis reached its 200-issue / 30000-pair / 100000-rectangle budget; unexamined pairs are not confirmed clean."];
                page.metadata.detectionTruncated = true;
            }
        }
        if (enabled.has("overflow")) {
            issues.push(...detectOverflowIssues(page.page, elements, autoScreenshot, scale));
        }
        if (enabled.has("readability")) {
            issues.push(...detectReadabilityIssues(page.page, elements, autoScreenshot, scale, options)
                .filter(issue => !enabled.has("overflow") || issue.type !== "clipped"));
        }
        if (enabled.has("alignment")) {
            page.metadata ??= {};
            const existing = page.metadata.inspectionLimitations;
            page.metadata.inspectionLimitations = [...(Array.isArray(existing) ? existing : []), "DOM alignment is not inferred across unrelated layout groups; use visual review for alignment."];
        }
    }

    if (issues.length > 200) {
        issues.splice(200);
        for (const page of structure) {
            page.metadata ??= {};
            const existing = page.metadata.inspectionLimitations;
            page.metadata.inspectionLimitations = [...(Array.isArray(existing) ? existing : []), "Only the first 200 rule findings are returned; additional findings were omitted."];
            page.metadata.detectionTruncated = true;
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
            viewport: options.viewport,
            timeout: options.timeout,
            scrollCount: options.scrollCount,
        });
        await applyExplicitViewport(page, options.viewport);
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

    const prioritized = issues.map((issue, index) => ({ issue, index })).sort((first, second) =>
        Number(second.issue.metadata?.assessment === "confirmed") - Number(first.issue.metadata?.assessment === "confirmed"));
    let captured = 0;
    for (const { issue, index } of prioritized) {
        if (!issue.bounds) {
            continue;
        }
        if (captured >= MAX_DOM_ISSUE_SCREENSHOTS) {
            issue.metadata = { ...issue.metadata, screenshotPending: false, screenshotStatus: "budget_exceeded", screenshotReason: "At most 10 issue screenshots per DOM inspection; narrow the page or inspect a smaller region." };
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
        captured += 1;
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
            evidenceVersion: 2,
            ownText: raw.ownText,
            textRects: raw.textRects.map(rectToMetadata),
            contentKind: raw.contentKind,
            visualImage: raw.visualImage,
            opaqueFill: raw.opaqueFill,
            pointerEvents: raw.pointerEvents,
            parentPath: raw.parentPath,
            complexPaint: raw.complexPaint,
            occludedBy: raw.occludedBy,
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
): { issues: InspectIssue[]; truncated: boolean } {
    const threshold = options.overlapThresholdPercent ?? DEFAULT_OVERLAP_THRESHOLD_PERCENT;
    const candidates = elements.filter(element => isRenderableElement(element));
    const issues: InspectIssue[] = [];
    let pairChecks = 0;
    const budget = { remaining: MAX_DOM_RECT_CHECKS };

    for (let firstIndex = 0; firstIndex < candidates.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex++) {
            if (pairChecks++ >= MAX_DOM_PAIR_CHECKS || budget.remaining <= 0 || issues.length >= MAX_DOM_OVERLAP_ISSUES) return { issues, truncated: true };
            const first = candidates[firstIndex];
            const second = candidates[secondIndex];
            if (areDomRelatives(first, second) && !sampledCover(first, second) && !sampledCover(second, first)
                && !possibleImageCover(first, second) && !possibleImageCover(second, first)) {
                continue;
            }

            if (overlapArea(first.bounds, second.bounds) <= 0) continue;
            const evidence = overlapEvidence(first, second, budget);
            if (!evidence) continue;
            const { area, percent } = evidence;
            if (percent < threshold) {
                continue;
            }

            const bounds = clampToPage(unionBounds(first.bounds, second.bounds), pageWidth, pageHeight, scale);
            issues.push({
                type: "overlap",
                severity: evidence.confirmed ? "warning" : "info",
                page,
                description: evidence.confirmed
                    ? `Opaque paint covers sampled content positions between "${first.name}" and "${second.name}"; review whether this layer is intentional.`
                    : `Content-region overlap candidate between "${first.name}" and "${second.name}" (${percent.toFixed(1)}%); geometry alone does not prove unreadable content.`,
                elements: [first, second],
                bounds: autoScreenshot ? bounds : undefined,
                metadata: {
                    overlapArea: area,
                    overlapPercent: Number(percent.toFixed(2)),
                    screenshotPending: autoScreenshot,
                    confidence: evidence.confirmed ? "high" : "medium",
                    assessment: evidence.confirmed ? "confirmed" : "candidate",
                    evidenceKind: evidence.confirmed ? "sampled-opaque-paint" : "content-rectangles",
                    reasonCodes: [evidence.reason],
                },
            });
        }
    }

    return { issues, truncated: false };
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

        const contentBounds = elementContentBounds(element);
        if (!contentBounds) continue;
        const overflow = contentOverflow(contentBounds, clippingBounds);
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
                confidence: "medium",
                assessment: "candidate",
                evidenceKind: "content-rectangles",
                reasonCodes: ["CONTENT_EXCEEDS_NON_SCROLLING_CLIP"],
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
        if (!isRenderableElement(element) || !(element.metadata?.evidenceVersion === 2 ? stringMetadata(element, "ownText") : element.text)) {
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
                    confidence: "high",
                    assessment: "candidate",
                    evidenceKind: "computed-font-size",
                    reasonCodes: ["FONT_BELOW_CONFIGURED_THRESHOLD"],
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
                    confidence: "medium",
                    assessment: "candidate",
                    evidenceKind: "computed-style-contrast",
                    reasonCodes: ["STYLE_CONTRAST_BELOW_THRESHOLD"],
                },
            });
        }

        const clippingBounds = rectMetadata(element, "clippingBounds");
        if (clippingBounds) {
            const contentBounds = elementContentBounds(element);
            if (!contentBounds) continue;
            const overflow = contentOverflow(contentBounds, clippingBounds);
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
                        confidence: "medium",
                        assessment: "candidate",
                        evidenceKind: "text-line-rectangles",
                        reasonCodes: ["TEXT_EXCEEDS_NON_SCROLLING_CLIP"],
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

function contentRects(element: DomInspectElement): Rect[] {
    if (element.metadata?.evidenceVersion !== 2) return [element.bounds];
    if (stringMetadata(element, "contentKind") === "image") return [element.bounds];
    const values = element.metadata?.textRects;
    if (!Array.isArray(values)) return [];
    return values.filter(value => value && typeof value === "object" && !Array.isArray(value)
        && ["x0", "y0", "x1", "y1"].every(key => typeof value[key] === "number")) as unknown as Rect[];
}

function elementContentBounds(element: DomInspectElement): Rect | null {
    const rectangles = contentRects(element);
    return rectangles.length ? rectangles.reduce(unionBounds) : null;
}

function contentOverflow(bounds: Rect, clip: Rect) {
    return isOverflowing(bounds, expandRect(clip, 2));
}

function sampledCover(content: DomInspectElement, cover: DomInspectElement): boolean {
    const values = content.metadata?.occludedBy;
    return Array.isArray(values) && values.some(value => value && typeof value === "object" && !Array.isArray(value)
        && value.domPath === stringMetadata(cover, "domPath") && typeof value.samples === "number" && value.samples >= 2);
}

function possibleImageCover(content: DomInspectElement, cover: DomInspectElement): boolean {
    return stringMetadata(content, "contentKind") === "text" && cover.metadata?.visualImage === true
        && cover.position !== "static" && (stringMetadata(cover, "domPath") ?? "").startsWith(`${stringMetadata(content, "domPath")}/`);
}

function overlapEvidence(first: DomInspectElement, second: DomInspectElement, budget: { remaining: number }) {
    const firstRects = contentRects(first);
    const secondRects = contentRects(second);
    const firstCovered = sampledCover(first, second);
    const secondCovered = sampledCover(second, first);
    const confirmed = firstCovered || secondCovered;
    const known = first.metadata?.evidenceVersion === 2 && second.metadata?.evidenceVersion === 2;
    if (known && !firstRects.length && !secondRects.length) return null;
    let reason = "CONTENT_RECTS_INTERSECT";
    let left = secondCovered ? [first.bounds] : firstRects;
    let right = firstCovered ? [second.bounds] : secondRects;
    if (confirmed) reason = "OPAQUE_COVER_SAMPLED";
    if (!left.length || !right.length) {
        const cover = left.length ? second : first;
        const content = left.length ? first : second;
        if (!confirmed) {
            const sameParent = stringMetadata(content, "parentPath") === stringMetadata(cover, "parentPath");
            const positioned = content.position !== "static" && cover.position !== "static";
            const later = cover.zOrder > content.zOrder || (cover.zOrder === content.zOrder
                && Number(cover.metadata?.domIndex) > Number(content.metadata?.domIndex));
            if (possibleImageCover(content, cover)) {
                reason = "IMAGE_FRONT_LAYER_GEOMETRY";
            } else if (!(cover.metadata?.opaqueFill === true || cover.metadata?.visualImage === true) || !sameParent || !positioned || !later) return null;
        }
        reason = confirmed ? "OPAQUE_COVER_SAMPLED" : cover.metadata?.visualImage === true ? "IMAGE_FRONT_LAYER_GEOMETRY" : "OPAQUE_FRONT_LAYER_GEOMETRY";
        if (!left.length) left = [first.bounds];
        if (!right.length) right = [second.bounds];
    }
    let area = 0;
    let percent = 0;
    for (const leftRect of left) for (const rightRect of right) {
        if (budget.remaining-- <= 0) return null;
        const intersection = overlapArea(leftRect, rightRect);
        if (intersection <= 0) continue;
        area += intersection;
        percent = Math.max(percent, overlapPercent(leftRect, rightRect));
    }
    return area > 0 ? { area, percent, confirmed, reason } : null;
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
