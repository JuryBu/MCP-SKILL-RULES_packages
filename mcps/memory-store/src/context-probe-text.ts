const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function canonicalProbeText(text: string): string {
    return text.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]/gu, "");
}

export function matchContextProbeText(text: string, probe: string): string | null {
    const needle = canonicalProbeText(probe);
    if (!needle) return null;
    const offset = canonicalProbeText(text).indexOf(needle);
    if (offset < 0) return null;
    const matchEnd = offset + needle.length;
    let position = 0;
    let start = -1;
    let end = -1;
    for (const part of segments.segment(text)) {
        const width = canonicalProbeText(part.segment).length;
        if (width && start < 0 && position + width > offset) start = part.index;
        position += width;
        if (width && position >= matchEnd) {
            end = part.index + part.segment.length;
            break;
        }
    }
    if (start < 0 || end < start) return null;
    return text.slice(Math.max(0, start - 80), Math.min(text.length, end + 100, start + 340));
}
