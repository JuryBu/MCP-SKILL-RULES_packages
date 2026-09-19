import type { Rect } from "./types.js";

export interface RawDomElement {
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
    ownText: string;
    textRects: Rect[];
    contentKind: "text" | "image" | "none";
    visualImage: boolean;
    opaqueFill: boolean;
    pointerEvents: string;
    parentPath: string;
    complexPaint: boolean;
    occludedBy: Array<{ domPath: string; samples: number }>;
}

export function extractVisibleDomElements(args: { maxDepth: number; minElementSize: number }) {
    const excludedTags = new Set(["script", "style", "noscript", "meta", "link", "title", "head", "template"]);
    const maxDepth = Math.max(1, args.maxDepth || 20);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, viewportWidth);
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, viewportHeight);
    const inspectionLimitations = new Set<string>(["Text line rectangles are not glyph pixels; visual review is required for candidates."]);
    const toRect = (rect: DOMRect): Rect => ({ x0: rect.left + scrollX, y0: rect.top + scrollY, x1: rect.right + scrollX, y1: rect.bottom + scrollY });
    const domPath = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.documentElement) {
            const parent: Element | null = current.parentElement;
            if (!parent) break;
            parts.push(`${current.tagName.toLowerCase()}[${Array.prototype.indexOf.call(parent.children, current)}]`);
            current = parent;
        }
        return parts.reverse().join("/");
    };
    const alpha = (color: string): number | null => {
        const parts = color.match(/^rgba?\(([^)]+)\)$/)?.[1]?.split(",").map(Number);
        return parts ? (parts.length === 4 ? parts[3] : 1) : color === "transparent" ? 0 : null;
    };
    const clippingBounds = (element: Element, ownText: boolean): Rect | null => {
        const result = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
        let clipped = false;
        let current: Element | null = ownText ? element : element.parentElement;
        while (current && current !== document.documentElement) {
            const style = getComputedStyle(current);
            const clipX = /^(hidden|clip)$/.test(style.overflowX);
            const clipY = /^(hidden|clip)$/.test(style.overflowY);
            if (clipX || clipY) {
                const box = toRect(current.getBoundingClientRect());
                if (clipX) { result.x0 = Math.max(result.x0, box.x0); result.x1 = Math.min(result.x1, box.x1); }
                if (clipY) { result.y0 = Math.max(result.y0, box.y0); result.y1 = Math.min(result.y1, box.y1); }
                clipped = true;
            }
            if (/^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)) break;
            current = current.parentElement;
        }
        return clipped ? result : null;
    };
    const entries: Array<{ node: Element; data: RawDomElement }> = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let scanned = 0;
    let node = walker.nextNode() as Element | null;
    while (node && scanned < 2000) {
        const element = node;
        scanned += 1;
        node = walker.nextNode() as Element | null;
        const tag = element.tagName.toLowerCase();
        if (excludedTags.has(tag)) continue;
        if (tag === "iframe" || element.shadowRoot) inspectionLimitations.add("Frame and shadow-root internals are not included in this DOM inspection.");
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility !== "visible" || box.width < args.minElementSize || box.height < args.minElementSize) continue;
        let opacity = 1;
        let ancestor: Element | null = element;
        while (ancestor) { opacity *= Number.parseFloat(getComputedStyle(ancestor).opacity || "1"); ancestor = ancestor.parentElement; }
        if (opacity <= 0) continue;
        const path = domPath(element);
        if (path.split("/").length > maxDepth) { inspectionLimitations.add("Elements beyond maxDepth were not inspected."); continue; }
        const textNodes = Array.from(element.childNodes).filter(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim());
        const rawOwnText = textNodes.map(child => child.textContent).join(" ").replace(/\s+/g, " ").trim();
        const textFill = style.getPropertyValue("-webkit-text-fill-color") || style.color;
        const visibleText = alpha(textFill) !== 0 || style.textShadow !== "none"
            || Number.parseFloat(style.getPropertyValue("-webkit-text-stroke-width")) > 0
            || (style.backgroundClip === "text" && style.backgroundImage !== "none");
        const ownText = visibleText ? rawOwnText : "";
        const textRects: Rect[] = [];
        for (const textNode of visibleText ? textNodes : []) {
            const range = document.createRange();
            range.selectNodeContents(textNode);
            for (const rectangle of Array.from(range.getClientRects())) {
                if (rectangle.width > 0 && rectangle.height > 0) textRects.push(toRect(rectangle));
                if (textRects.length >= 80) break;
            }
            if (textRects.length >= 80) { inspectionLimitations.add("Text-line sampling was capped at 80 rectangles per element."); break; }
        }
        const visualImage = ["img", "canvas", "video", "svg"].includes(tag);
        const meaningfulImage = visualImage
            && element.getAttribute("aria-hidden") !== "true" && element.getAttribute("role") !== "presentation"
            && !(tag === "img" && element.hasAttribute("alt") && element.getAttribute("alt") === "");
        const contentKind = ownText ? "text" : meaningfulImage ? "image" : "none";
        const complexPaint = style.transform !== "none" || style.clipPath !== "none" || style.maskImage !== "none"
            || style.filter !== "none" || style.mixBlendMode !== "normal" || Number.parseFloat(style.borderRadius) > 0;
        const opaqueFill = (alpha(style.backgroundColor) ?? 0) >= 0.98 && opacity >= 0.98 && !complexPaint;
        if (style.backgroundImage !== "none" || complexPaint) inspectionLimitations.add("Image backgrounds, transparency, transforms, masks and rounded corners are not pixel-verified.");
        for (const pseudo of ["::before", "::after"]) {
            const content = getComputedStyle(element, pseudo).content;
            if (content && content !== "none" && content !== "normal") inspectionLimitations.add("Generated pseudo-element content is not structurally inspected.");
        }
        entries.push({ node: element, data: {
            tag, id: element.id || "", className: typeof element.className === "string" ? element.className : "",
            text: ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
            bounds: toRect(box), zIndex: style.zIndex || "auto", zOrder: Number.parseInt(style.zIndex, 10) || 0,
            visibility: style.visibility, opacity, overflow: `${style.overflow} ${style.overflowX} ${style.overflowY}`,
            position: style.position, fontSize: Number.parseFloat(style.fontSize) || 0, color: style.color,
            backgroundColor: style.backgroundColor, domPath: path, clippingBounds: clippingBounds(element, Boolean(ownText)),
            ownText: ownText.slice(0, 500), textRects, contentKind, visualImage, opaqueFill, pointerEvents: style.pointerEvents,
            parentPath: element.parentElement ? domPath(element.parentElement) : "", complexPaint, occludedBy: [],
        } });
    }
    if (node) inspectionLimitations.add("DOM scan stopped at 2000 elements; the remaining document was not inspected.");
    const byNode = new Map(entries.map(entry => [entry.node, entry.data]));
    let sampledPoints = 0;
    for (const entry of entries) {
        if (entry.data.contentKind === "none") continue;
        const counts = new Map<string, number>();
        const rectangles = entry.data.contentKind === "text" ? entry.data.textRects : [entry.data.bounds];
        for (const rectangle of rectangles.slice(0, 12)) {
            for (const fraction of [0.2, 0.5, 0.8]) {
                const pointX = rectangle.x0 + (rectangle.x1 - rectangle.x0) * fraction - scrollX;
                const pointY = (rectangle.y0 + rectangle.y1) / 2 - scrollY;
                if (pointX < 0 || pointY < 0 || pointX >= viewportWidth || pointY >= viewportHeight) continue;
                if (sampledPoints >= 1200) { inspectionLimitations.add("Paint-order sampling reached 1200 points; unsampled candidates remain unconfirmed."); break; }
                sampledPoints += 1;
                for (const hit of document.elementsFromPoint(pointX, pointY)) {
                    if (hit === entry.node) break;
                    if (hit.contains(entry.node)) continue;
                    const cover = byNode.get(hit);
                    if (cover?.opaqueFill) { counts.set(cover.domPath, (counts.get(cover.domPath) ?? 0) + 1); break; }
                }
            }
        }
        entry.data.occludedBy = Array.from(counts, ([path, samples]) => ({ domPath: path, samples }));
    }
    inspectionLimitations.add("Paint-order confirmation is limited to sampled points in the current viewport; pointer-events:none overlays remain geometric candidates.");
    return { url: location.href, title: document.title, dimensions: { width, height, viewportWidth, viewportHeight },
        elements: entries.map(entry => entry.data), inspectionLimitations: [...inspectionLimitations] };
}
