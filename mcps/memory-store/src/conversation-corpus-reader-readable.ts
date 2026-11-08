import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexHistoryArchiveOptions } from "./codex-history-archive.js";
import { CodexHistorySourceMismatchError, throwIfCodexReadCancelled } from "./codex-history-integrity.js";
import { readCodexStreamingSessionMeta, resolveCodexStreamingHistorySource, scanCodexStreamingReadableRange } from "./codex-history-source.js";
import { CODEX_READABLE_RANGE_CACHE_FORMAT, CodexCorpusCacheSizeLimitError, codexCorpusSourceIdentitiesMatch, publishCodexCorpusCache, readCodexCorpusCache, type CodexCorpusCacheEntry } from "./conversation-corpus-reader-cache.js";
import { codexCorpusThreadOrigin, createCodexCorpusCollector, type CodexCorpusThreadOrigin } from "./conversation-corpus-reader-projection.js";
import type { CorpusConversation, CorpusMessageRole, CorpusProjection, CorpusReadControl, CorpusRoundReadRequest } from "./conversation-corpus-types.js";

interface ReadableCodexOptions {
    roots: string[];
    pathsByRolloutId?: Map<string, string[]>;
    archive?: CodexHistoryArchiveOptions;
    cacheRoot: string;
    cacheMaxBytes?: number;
}

const storedRoles: CorpusMessageRole[] = ["user", "assistant", "subagent"];
const comparablePath = (value: string) => path.resolve(value).replace(/\\/gu, "/").toLowerCase();

export function isCodexReadableSourceFallback(error: unknown): boolean {
    return (error instanceof CodexHistorySourceMismatchError && /Codex history archive exceeds the (?:compressed|decompressed) size limit/u.test(error.message))
        || (error instanceof Error && /^Missing Codex history_base rollout:/u.test(error.message));
}

function selectRoles(projection: CorpusProjection, control: CorpusReadControl): CorpusProjection {
    const roles = control.messageRoles || ["user", "assistant"];
    return { ...projection, messages: projection.messages.filter(message => roles.includes(message.role)) };
}

export async function readCodexReadableCache(conversation: CorpusConversation, control: CorpusReadControl, options: ReadableCodexOptions): Promise<CorpusProjection | null> {
    if (control.forceRefresh || control.messageRoles?.includes("tool") || !conversation.rolloutPath) return null;
    const cached = await readCodexCorpusCache(path.join(options.cacheRoot, "readable-ranges"), conversation.id, control, CODEX_READABLE_RANGE_CACHE_FORMAT);
    if (!cached?.projection.conversation.rolloutPath || comparablePath(cached.projection.conversation.rolloutPath) !== comparablePath(conversation.rolloutPath)
        || !cached.projection.readableRangeVerified || cached.projection.fullSourceComplete !== false || !cached.projection.partial
        || !await codexCorpusSourceIdentitiesMatch(cached, options.pathsByRolloutId)) return null;
    throwIfCodexReadCancelled(control.isCancelled);
    return selectRoles({ ...cached.projection, conversation, timings: { readableRangeCacheHit: 1 } }, control);
}

export async function readCodexReadableProjection(conversation: CorpusConversation, control: CorpusReadControl, options: ReadableCodexOptions): Promise<CorpusProjection> {
    throwIfCodexReadCancelled(control.isCancelled);
    if (!conversation.rolloutPath || control.messageRoles?.includes("tool")) throw new Error("Codex readable body ranges require a rollout path and body message roles");
    const source = await resolveCodexStreamingHistorySource(conversation.rolloutPath, { ...options, isCancelled: control.isCancelled, deferAncestors: true });
    if (!source.unverifiedHistoryBase) throw new CodexHistorySourceMismatchError("Codex source has no deferred readable range");
    const origins = new Map<string, CodexCorpusThreadOrigin>();
    for (const segment of source.segments) origins.set(segment.path, codexCorpusThreadOrigin(await readCodexStreamingSessionMeta(segment.path, { ...options.archive, isCancelled: control.isCancelled }), conversation.id));
    const collector = createCodexCorpusCollector({ conversationId: conversation.id, cwd: conversation.workspace, roles: storedRoles, originsByPath: origins });
    const verification = await scanCodexStreamingReadableRange(source, (event, position) => collector.addEvent(event, position), {
        archive: options.archive, isCancelled: control.isCancelled,
        onProgress: bytes => control.onProgress?.({ phase: "codex_readable_range", bytes }),
    });
    const projected = collector.finish();
    throwIfCodexReadCancelled(control.isCancelled);
    const revision = `readable:${createHash("sha256").update(JSON.stringify({ format: CODEX_READABLE_RANGE_CACHE_FORMAT, source: verification.revision, missingHistoryBase: source.unverifiedHistoryBase })).digest("hex")}`;
    const projection: CorpusProjection = {
        conversation, revision, messages: projected.messages, complete: false, partial: true, requestedRangeComplete: false,
        readableRangeVerified: true, fullSourceComplete: false, roundNumbering: "relative",
        warnings: ["CODEX_HISTORY_ANCESTRY_PENDING", "verified_readable_range_only", "relative_round_numbering",
            `verified_readable_relative_rounds:${projected.roundCount ? `1-${projected.roundCount}` : "empty"}`,
            `missing_history_base:${source.unverifiedHistoryBase.rolloutId}:${source.unverifiedHistoryBase.endOrdinalExclusive}`], sourceBytes: verification.sourceBytes,
        readableRange: { kind: "relative", startRound: projected.roundCount ? 1 : 0, endRound: projected.roundCount, missingHistoryBase: source.unverifiedHistoryBase,
            segments: verification.segments.map(segment => ({ path: segment.path, startOrdinal: segment.startOrdinal, endOrdinalExclusive: segment.nextOrdinal, endByte: segment.endByte, prefixSha256: segment.prefixSha256 })) },
    };
    const entry: CodexCorpusCacheEntry = { format: CODEX_READABLE_RANGE_CACHE_FORMAT, projection, verification,
        sourceIdentities: verification.segments.flatMap(segment => [{ path: segment.path, physical: segment.physical }, ...segment.replicaIdentities.map(replica => ({ path: replica.path, physical: replica.physical }))]) };
    try { await publishCodexCorpusCache(path.join(options.cacheRoot, "readable-ranges"), entry, control, options.cacheMaxBytes); }
    catch (error) {
        if (!(error instanceof CodexCorpusCacheSizeLimitError)) throw error;
        projection.warnings.push("readable_range_cache_limit_projection_returned");
    }
    return selectRoles(projection, control);
}

export async function readCodexReadableRounds(conversation: CorpusConversation, request: CorpusRoundReadRequest, control: CorpusReadControl, options: ReadableCodexOptions): Promise<CorpusProjection> {
    const roles = request.messageRoles || control.messageRoles;
    const selectedControl = { ...control, messageRoles: roles };
    const projection = await readCodexReadableCache(conversation, selectedControl, options) ?? await readCodexReadableProjection(conversation, selectedControl, options);
    if (projection.revision !== request.revision) throw new CodexHistorySourceMismatchError("Codex readable range changed; repeat the search before expanding its relative rounds");
    const last = projection.readableRange!.endRound;
    const start = request.lastRounds === undefined ? request.startRound ?? 1 : Math.max(1, last - request.lastRounds + 1);
    const end = request.endRound ?? last;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || end > last
        || request.lastRounds !== undefined && (!Number.isSafeInteger(request.lastRounds) || request.lastRounds < 1)) throw new Error("Codex readable relative round range is invalid");
    return { ...projection, requestedRangeComplete: true, messages: projection.messages.filter(message => message.round >= start && message.round <= end) };
}
