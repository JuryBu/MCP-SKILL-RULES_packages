export function sliceUnicodeSafe(text: string, start = 0, end = text.length): string {
    let startIndex = Math.max(0, Math.min(text.length, Math.trunc(start) || 0));
    let endIndex = Math.max(0, Math.min(text.length, Math.trunc(end) || 0));
    if (startIndex >= endIndex) return "";
    if (startIndex > 0 && isHighSurrogate(text.charCodeAt(startIndex - 1)) && isLowSurrogate(text.charCodeAt(startIndex))) startIndex += 1;
    if (endIndex < text.length && isHighSurrogate(text.charCodeAt(endIndex - 1)) && isLowSurrogate(text.charCodeAt(endIndex))) endIndex -= 1;
    return text.slice(startIndex, Math.max(startIndex, endIndex));
}

export function escapeUnpairedUnicode(text: string): string {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
        codeUnit => `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function isHighSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}
