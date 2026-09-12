export function isPreviousBootZeroRecord(
    content: Uint8Array,
    stat: { mtimeMs: number; birthtimeMs: number },
    bootStartedAtMs: number,
): boolean {
    const cutoff = bootStartedAtMs - 60_000;
    return Number.isFinite(cutoff)
        && Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0 && stat.mtimeMs < cutoff
        && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 && stat.birthtimeMs < cutoff
        && content.length > 0
        && content.every(byte => byte === 0);
}
