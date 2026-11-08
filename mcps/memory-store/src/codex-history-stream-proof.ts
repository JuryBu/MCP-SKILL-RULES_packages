import fs from "node:fs/promises";
import { codexHistoryPhysicalIdentity, type CodexHistoryPhysicalIdentity, type CodexStreamingHistorySource } from "./codex-history-source.js";
import { CodexHistorySourceMismatchError, hashCodexPrefix, throwIfCodexReadCancelled } from "./codex-history-integrity.js";

function appended(before: CodexHistoryPhysicalIdentity, after: CodexHistoryPhysicalIdentity): boolean {
    return after.size > before.size && after.dev === before.dev && after.ino === before.ino && after.birthtimeMs === before.birthtimeMs;
}

export async function createCodexHistoryWindowSourceGuard(source: CodexStreamingHistorySource, isCancelled?: () => boolean): Promise<() => Promise<void>> {
    const verified = new Map<string, CodexHistoryPhysicalIdentity>();
    const prefixes = new Map<string, string>();
    for (const segment of source.segments) {
        throwIfCodexReadCancelled(isCancelled);
        const current = codexHistoryPhysicalIdentity(await fs.stat(segment.path));
        if (JSON.stringify(current) !== JSON.stringify(segment.physical)) throw new CodexHistorySourceMismatchError(`Codex window source changed before capture: ${segment.path}`);
        verified.set(segment.path, current);
    }
    for (const segment of source.segments) {
        if (!/\.zst$/iu.test(segment.path)) prefixes.set(segment.path, await hashCodexPrefix(segment.path, segment.endByte ?? segment.physical.size, isCancelled));
    }
    return async () => {
        for (const segment of source.segments) {
            throwIfCodexReadCancelled(isCancelled);
            const before = verified.get(segment.path)!;
            const current = codexHistoryPhysicalIdentity(await fs.stat(segment.path));
            if (JSON.stringify(current) === JSON.stringify(before)) continue;
            if (/\.zst$/iu.test(segment.path) || !appended(before, current)
                || await hashCodexPrefix(segment.path, segment.endByte ?? segment.physical.size, isCancelled) !== prefixes.get(segment.path)) {
                throw new CodexHistorySourceMismatchError(`Codex window source changed: ${segment.path}`);
            }
            const after = codexHistoryPhysicalIdentity(await fs.stat(segment.path));
            if (JSON.stringify(after) !== JSON.stringify(current) && !appended(current, after)) throw new CodexHistorySourceMismatchError(`Codex window source changed during prefix verification: ${segment.path}`);
            verified.set(segment.path, after);
        }
    };
}
