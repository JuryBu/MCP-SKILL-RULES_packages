import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCodexRoundCollector, rebaseCodexRoundTail, type CodexRoundTailCheckpoint } from "./codex-client.js";
import type { CodexHistoryArchiveOptions } from "./codex-history-archive.js";
import { proveCodexAdoptedPrefix } from "./codex-adopted-prefix-proof.js";
import { assertCodexHistoryManifest, codexHistoryPhysicalIdentity, readCodexStreamingSessionMeta, resolveCodexStreamingHistorySource, scanCodexStreamingHistory, type CodexHistorySource, type CodexStreamingHistoryVerification } from "./codex-history-source.js";
import { CodexHistorySourceMismatchError, throwIfCodexReadCancelled } from "./codex-history-integrity.js";
import { iterateCachedConversationSourceCacheRounds, readConversationSourceCacheMetadata } from "./conversation-source-cache.js";
import { createConsecutiveHumanRoundMerger, getRoundUserMessages, type ConversationRound } from "./trajectory.js";
import { codexCorpusThreadOrigin, projectCodexCorpusRound } from "./conversation-corpus-reader-projection.js";
import { CODEX_CORPUS_CACHE_FORMAT, type CodexCorpusCacheEntry } from "./conversation-corpus-reader-cache.js";
import type { CorpusConversation, CorpusMessage, CorpusReadControl, CorpusSourcePosition } from "./conversation-corpus-types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const logicalPath = (value: string) => path.resolve(value).replace(/\\/gu, "/").replace(/\.zst$/iu, "").toLowerCase();
const sameIdentity = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function readLegacyCodexCorpus(
    conversation: CorpusConversation,
    control: CorpusReadControl,
    options: { roots: string[]; pathsByRolloutId?: Map<string, string[]>; archive?: CodexHistoryArchiveOptions; prefixProofCacheRoot: string },
    requestedRange?: { startRound?: number; endRound?: number; lastRounds?: number },
): Promise<CodexCorpusCacheEntry | null> {
    if (!conversation.rolloutPath || control.messageRoles?.includes("tool")) return null;
    const started = performance.now();
    const key = { source: "codex:link=summary", conversationId: conversation.id };
    const cached = readConversationSourceCacheMetadata<{ codexData?: { historySource?: CodexHistorySource; sourceCheckpoint?: CodexRoundTailCheckpoint } }>({ key, maxMetadataBytes: 4 * 1024 * 1024 });
    const history = cached?.snapshot.codexData?.historySource;
    const checkpoint = cached?.snapshot.codexData?.sourceCheckpoint;
    if (!cached || !history || !checkpoint || logicalPath(history.leafPath) !== logicalPath(conversation.rolloutPath)) return null;
    const range = requestedRange;
    try { assertCodexHistoryManifest(history); } catch { return null; }
    const oldLeaf = history.segments.at(-1)!;
    const createdAt = Date.parse(cached.createdAt);
    if (!Number.isFinite(createdAt) || !checkpoint.prefixSha256 || checkpoint.prefixSha256 !== oldLeaf.prefixSha256 || checkpoint.sourceSize !== oldLeaf.endByte || !Number.isSafeInteger(checkpoint.replayStartOrdinal) || checkpoint.replayStartOrdinal !== checkpoint.replayStartStep - 1 || checkpoint.replayStartByte < 0 || checkpoint.replayStartByte > checkpoint.sourceSize || checkpoint.replaceFromRound < 1 || checkpoint.replaceFromRound > cached.roundCount) return null;
    const anchor = iterateCachedConversationSourceCacheRounds<ConversationRound>({ key, generation: cached.generation, startRound: checkpoint.replaceFromRound, endRound: checkpoint.replaceFromRound });
    if (!anchor || [...anchor.rounds][0]?.startStep !== checkpoint.replayStartStep) return null;
    const source = await resolveCodexStreamingHistorySource(conversation.rolloutPath, { ...options, isCancelled: control.isCancelled });
    if (source.segments.length !== history.segments.length) return null;
    const origins = new Map<string, ReturnType<typeof codexCorpusThreadOrigin>>();
    const previous: CodexStreamingHistoryVerification = { revision: history.revision, sourceBytes: 0, segments: [] };
    let proofBytes = 0;
    let proofCacheHits = 0;
    let sharedProofFlights = 0;
    for (let index = 0; index < source.segments.length; index += 1) {
        throwIfCodexReadCancelled(control.isCancelled);
        const segment = source.segments[index]!;
        const old = history.segments[index]!;
        const leaf = index === source.segments.length - 1;
        if (logicalPath(segment.path) !== logicalPath(old.path) || segment.headerSha256 !== old.headerSha256 || segment.startOrdinal !== old.startOrdinal || segment.endOrdinalExclusive !== old.endOrdinalExclusive || (!leaf && segment.endByte !== old.endByte) || segment.replicas.length || old.replicas?.length || !old.prefixSha256) return null;
        origins.set(segment.path, codexCorpusThreadOrigin(await readCodexStreamingSessionMeta(segment.path, { ...options.archive, isCancelled: control.isCancelled }), conversation.id));
        let physicalSha256 = old.archive?.sourceSha256;
        if (!leaf) {
            const unchanged = segment.path === old.path && segment.physical.size === (old.archive?.sourceSize ?? old.size) && segment.physical.mtimeMs === (old.archive?.sourceMtimeMs ?? old.mtimeMs) && segment.physical.ctimeMs <= createdAt && segment.physical.birthtimeMs <= createdAt;
            if (!unchanged) {
                if (!/\.zst$/iu.test(segment.path)) return null;
                const completedBytes = proofBytes;
                const proof = await proveCodexAdoptedPrefix({ cacheRoot: options.prefixProofCacheRoot, segment, endByte: old.endByte, expectedSha256: old.prefixSha256, archive: options.archive, isCancelled: control.isCancelled, onProgress: bytes => control.onProgress?.({ phase: "codex_legacy_prefix_proof", bytes: completedBytes + bytes }) });
                physicalSha256 = proof.physicalSha256;
                proofBytes += proof.decodedBytes;
                proofCacheHits += Number(proof.cacheHit);
                sharedProofFlights += Number(proof.sharedFlight);
            }
        }
        previous.segments.push({ ...segment, endByte: old.endByte, prefixSha256: old.prefixSha256, physicalSha256, nextOrdinal: segment.endOrdinalExclusive ?? checkpoint.replayStartOrdinal!, replicaIdentities: [], adoptedPrefixCache: { generation: cached.generation, sourceRevision: history.revision } });
    }
    const proofMs = performance.now() - started;
    const prefixProofBytes = proofBytes;
    const positions = new Map<number, { position: CorpusSourcePosition; timestamp?: string }>();
    const messages: CorpusMessage[] = [];
    let pending: CorpusMessage[] = [];
    let chunkStarted = false;
    const firstRound = range && checkpoint.roundIndexSpace === "normalized-cache-v1" ? Math.min(checkpoint.replaceFromRound, range.lastRounds === undefined ? range.startRound ?? 1 : Math.max(1, cached.roundCount - range.lastRounds + 1)) : 1;
    let lastRound = firstRound - 1;
    const pendingRevision = `pending:${digest({ legacy: cached.generation, source })}`;
    const roles = control.messageRoles || ["user", "assistant"];
    const flush = (): void | Promise<void> => {
        if (!control.onChunk || !pending.length) return;
        const chunk = pending;
        pending = [];
        throwIfCodexReadCancelled(control.isCancelled);
        const completion = control.onChunk({ conversation, revision: pendingRevision, messages: chunk.filter(message => roles.includes(message.role)), warnings: ["unverified_source_projection", "legacy_cache_body_browsing_only"], sourceBytes: proofBytes, ...(chunkStarted ? {} : { replaceFromRound: range ? chunk[0]!.round : 1 }) });
        chunkStarted = true;
        if (completion && typeof completion.then === "function") return Promise.resolve(completion).then(() => { throwIfCodexReadCancelled(control.isCancelled); });
    };
    const merger = createConsecutiveHumanRoundMerger(round => {
        lastRound = round.roundIndex;
        const minimum = range?.lastRounds === undefined ? range?.startRound ?? 1 : Math.max(1, lastRound - range.lastRounds + 1);
        if (round.roundIndex >= minimum && round.roundIndex <= (range?.endRound ?? Number.POSITIVE_INFINITY)) {
            const remember = (step: number, timestamp?: string): void => {
                if (positions.has(step)) return;
                const ordinal = step - 1;
                const segment = source.segments.find(candidate => ordinal >= candidate.startOrdinal && ordinal < (candidate.endOrdinalExclusive ?? Number.POSITIVE_INFINITY));
                if (!segment) throw new CodexHistorySourceMismatchError("Codex legacy message has no adopted source segment");
                positions.set(step, { position: { path: segment.path, ordinal, messageId: `cache:${cached.generation}:S${step}` }, timestamp });
            };
            for (const message of getRoundUserMessages(round)) remember(message.stepIndex ?? round.startStep, message.createdAt);
            for (const response of round.aiResponses) remember(response.stepIndex);
            for (const event of round.semanticEvents || []) remember(event.stepIndex ?? round.startStep, event.createdAt);
            const projected = projectCodexCorpusRound(conversation.id, round, positions, ["user", "assistant", "subagent"], undefined, origins);
            messages.push(...projected);
            if (!range) pending.push(...projected);
        }
        if (range?.lastRounds !== undefined) {
            const keep = messages.findIndex(message => message.round >= minimum);
            if (keep < 0) messages.length = 0;
            else if (keep > 0) messages.splice(0, keep);
        }
        for (const step of positions.keys()) if (step < round.endStep) positions.delete(step);
    }, firstRound);
    const hasPrefix = checkpoint.replaceFromRound > firstRound;
    const prefix = hasPrefix ? iterateCachedConversationSourceCacheRounds<ConversationRound>({ key, generation: cached.generation, startRound: firstRound, endRound: checkpoint.replaceFromRound - 1 }) : null;
    if (hasPrefix && !prefix) return null;
    if (hasPrefix) for (const round of prefix!.rounds) {
        throwIfCodexReadCancelled(control.isCancelled);
        merger.append(round);
        const completion = flush();
        if (completion && typeof completion.then === "function") await completion;
    }
    const prefixMs = performance.now() - started - proofMs;
    const offset = checkpoint.replayStartStep - 1;
    let step = offset;
    const collector = createCodexRoundCollector({ cwd: conversation.workspace, bodyOnly: true, retainRounds: false, onRound: round => { rebaseCodexRoundTail([round], 0, offset); merger.append(round); } });
    const leaf = source.segments.at(-1)!;
    const verification = await scanCodexStreamingHistory(source, (event, position) => {
        step += 1;
        const payload = event?.payload || {};
        const messageId = payload.message_id || payload.messageId || payload.item_id || payload.itemId || payload.id || event?.message_id || event?.id;
        if (event?.type === "response_item" || event?.type === "event_msg") positions.set(step, { position: { ...position, ...(typeof messageId === "string" ? { messageId } : {}) }, timestamp: typeof event?.timestamp === "string" ? event.timestamp : typeof payload.timestamp === "string" ? payload.timestamp : undefined });
        collector.addEvent(event, position.startByte);
        return flush();
    }, { archive: options.archive, isCancelled: control.isCancelled, previousVerification: previous, replayFrom: { path: leaf.path, startByte: checkpoint.replayStartByte, endByte: checkpoint.replayStartByte, ordinal: checkpoint.replayStartOrdinal! }, onProgress: bytes => { proofBytes = prefixProofBytes + bytes; control.onProgress?.({ phase: "codex_legacy_tail", bytes: proofBytes }); } });
    collector.finish();
    merger.finish();
    if (range && control.onChunk) pending = messages;
    const completion = flush();
    if (completion && typeof completion.then === "function") await completion;
    for (const segment of source.segments.slice(0, -1)) if (!sameIdentity(segment.physical, codexHistoryPhysicalIdentity(await fs.stat(segment.path)))) throw new CodexHistorySourceMismatchError("Codex legacy base changed during projection");
    throwIfCodexReadCancelled(control.isCancelled);
    return { format: CODEX_CORPUS_CACHE_FORMAT, projection: { conversation, revision: digest({ format: "codex-legacy-corpus/v2", generation: cached.generation, source: verification.revision }), messages, complete: !range, ...(range ? { requestedRangeComplete: true } : {}), warnings: ["legacy_cache_body_browsing_only", ...(range ? ["requested_round_range_complete", "full_source_projection_not_built"] : []), ...(messages.some(message => !message.timestamp) ? ["message_timestamps_unavailable_in_legacy_projection"] : [])], sourceBytes: prefixProofBytes + verification.sourceBytes, timings: { legacyPrefixProofMs: proofMs, legacyRoundProjectionMs: prefixMs, legacyTailMs: performance.now() - started - proofMs - prefixMs, legacyProofBytes: prefixProofBytes, legacyPrefixProofCacheHits: proofCacheHits, legacyPrefixProofSharedFlights: sharedProofFlights, legacyRoundCount: lastRound } }, verification, sourceIdentities: verification.segments.map(segment => ({ path: segment.path, physical: segment.physical })) };
}
