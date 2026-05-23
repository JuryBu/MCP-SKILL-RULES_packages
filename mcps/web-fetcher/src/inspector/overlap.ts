import type { Rect } from "./types.js";

export type OverflowSide = "left" | "right" | "top" | "bottom";

export interface OverflowResult {
    overflowing: boolean;
    sides: OverflowSide[];
    left: boolean;
    right: boolean;
    top: boolean;
    bottom: boolean;
}

function normalizeRect(rect: Rect): Rect {
    return {
        x0: Math.min(rect.x0, rect.x1),
        y0: Math.min(rect.y0, rect.y1),
        x1: Math.max(rect.x0, rect.x1),
        y1: Math.max(rect.y0, rect.y1),
    };
}

export function rectArea(rect: Rect): number {
    const normalized = normalizeRect(rect);
    return Math.max(0, normalized.x1 - normalized.x0) * Math.max(0, normalized.y1 - normalized.y0);
}

export function overlapArea(a: Rect, b: Rect): number {
    const rectA = normalizeRect(a);
    const rectB = normalizeRect(b);
    const width = Math.min(rectA.x1, rectB.x1) - Math.max(rectA.x0, rectB.x0);
    const height = Math.min(rectA.y1, rectB.y1) - Math.max(rectA.y0, rectB.y0);

    return Math.max(0, width) * Math.max(0, height);
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
    return overlapArea(a, b) > 0;
}

export function overlapPercent(a: Rect, b: Rect): number {
    const smallerArea = Math.min(rectArea(a), rectArea(b));
    if (smallerArea <= 0) {
        return 0;
    }

    return (overlapArea(a, b) / smallerArea) * 100;
}

export function expandRect(rect: Rect, padding: number): Rect {
    const normalized = normalizeRect(rect);
    return {
        x0: normalized.x0 - padding,
        y0: normalized.y0 - padding,
        x1: normalized.x1 + padding,
        y1: normalized.y1 + padding,
    };
}

export function clampRect(rect: Rect, container: Rect): Rect {
    const normalized = normalizeRect(rect);
    const normalizedContainer = normalizeRect(container);

    return {
        x0: Math.max(normalizedContainer.x0, Math.min(normalized.x0, normalizedContainer.x1)),
        y0: Math.max(normalizedContainer.y0, Math.min(normalized.y0, normalizedContainer.y1)),
        x1: Math.max(normalizedContainer.x0, Math.min(normalized.x1, normalizedContainer.x1)),
        y1: Math.max(normalizedContainer.y0, Math.min(normalized.y1, normalizedContainer.y1)),
    };
}

export function isOverflowing(element: Rect, container: Rect): OverflowResult {
    const rect = normalizeRect(element);
    const bounds = normalizeRect(container);
    const left = rect.x0 < bounds.x0;
    const right = rect.x1 > bounds.x1;
    const top = rect.y0 < bounds.y0;
    const bottom = rect.y1 > bounds.y1;
    const sides: OverflowSide[] = [];

    if (left) {
        sides.push("left");
    }
    if (right) {
        sides.push("right");
    }
    if (top) {
        sides.push("top");
    }
    if (bottom) {
        sides.push("bottom");
    }

    return {
        overflowing: sides.length > 0,
        sides,
        left,
        right,
        top,
        bottom,
    };
}
