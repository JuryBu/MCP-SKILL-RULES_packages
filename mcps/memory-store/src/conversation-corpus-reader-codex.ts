import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCodexThreadAsync, listCodexThreadsForMetadataAsync, type CodexThreadInfo } from "./codex-client.js";
import { assertCodexHistoryManifest, assertCodexStreamingRangeSource, codexHistoryPhysicalIdentity, indexCodexHistorySourcePaths, parseCodexRolloutFilename, readCodexStreamingSessionMeta, resolveCodexStreamingHistorySource, scanCodexStreamingHistory, type CodexHistorySource, type CodexStreamingHistoryVerification, type CodexStreamingPrefixProof } from "./codex-history-source.js";
import { throwIfCodexReadCancelled, CodexHistorySourceMismatchError } from "./codex-history-integrity.js";
import type { CodexHistoryArchiveOptions } from "./codex-history-archive.js";
import { iterateCachedConversationSourceCacheRounds, readConversationSourceCacheMetadata, readConversationSourceCacheRecordProjection } from "./conversation-source-cache.js";
import type { ConversationRecordProjectionRound } from "./conversation-record-projection.js";
import type { ConversationRound } from "./trajectory.js";
import { DATA_ROOT } from "./store.js";
import { codexCorpusAttachmentReferences, codexCorpusThreadOrigin, createCodexCorpusCollector, projectCodexCorpusRound, type CodexCorpusThreadOrigin } from "./conversation-corpus-reader-projection.js";
import { CODEX_CORPUS_CACHE_FORMAT, CODEX_ROLE_PROOF_CACHE_FORMAT, CodexCorpusCacheSizeLimitError, codexCorpusSourceIdentitiesMatch, publishCodexCorpusCache, readCodexCorpusCache, type CodexCorpusCacheEntry } from "./conversation-corpus-reader-cache.js";
import { readLegacyCodexCorpus } from "./conversation-corpus-reader-legacy.js";
import { readRoleExcludedCodexProjection, type CodexRoleExcludedProjection } from "./conversation-corpus-reader-role-proof.js";
import type { CorpusConversation, CorpusMessageRole, CorpusProjection, CorpusProvider, CorpusReadControl, CorpusSearchRequest } from "./conversation-corpus-types.js";
import { normalizeCodexCorpusConversationId } from "./conversation-corpus-search.js";

export interface CodexCorpusReaderOptions {
    codexHome?: string;
    cacheRoot?: string;
    cacheMaxBytes?: number;
    archive?: CodexHistoryArchiveOptions;
    listThreads?: () => Promise<CodexThreadInfo[]>;
}

export interface CodexCorpusRoundRequest {
    revision: string;
    startRound?: number;
    endRound?: number;
    lastRounds?: number;
    messageRoles?: CorpusMessageRole[];
}

export type CodexCorpusFastReadRequest = Omit<CodexCorpusRoundRequest, "revision">;

const bodyRoles: CorpusMessageRole[] = ["user", "assistant"];
const storedRoles: CorpusMessageRole[] = ["user", "assistant", "subagent"];
const SEMANTIC_VERSION = "codex-corpus-reader/v5";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const projectionRevision = (revision: string) => digest({ format: CODEX_CORPUS_CACHE_FORMAT, source: revision });
const comparablePath = (value: string) => path.resolve(value).replace(/\\/gu, "/").replace(/\/$/u, "").toLowerCase();

function inWorkspace(conversation: CorpusConversation, request: CorpusSearchRequest): boolean {
    if (!request.workspaces?.length) return true;
    const workspace = comparablePath(conversation.workspace || ".");
    const matches = request.workspaces.map(value => {
        const selected = comparablePath(value);
        return request.workspaceMode === "exact" ? workspace === selected : request.workspaceMode === "under" ? workspace === selected || workspace.startsWith(`${selected}/`) : workspace.includes(selected);
    });
    return request.workspaceMode === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

function selectRoles(projection: CorpusProjection, control: CorpusReadControl): CorpusProjection {
    const roles = control.messageRoles || bodyRoles;
    return { ...projection, messages: projection.messages.filter(message => roles.includes(message.role)) };
}

function fromThread(thread: CodexThreadInfo): CorpusConversation {
    const origin = codexCorpusThreadOrigin({ source: thread.source }, thread.id);
    return { id: thread.id, title: thread.title || thread.id, workspace: thread.cwd || "", rolloutPath: thread.rolloutPath, updatedAt: typeof thread.updatedAtMs === "number" ? new Date(thread.updatedAtMs).toISOString() : undefined, archived: /(?:^|[\\/])archived_sessions[\\/]/u.test(thread.rolloutPath), source: "codex", parentConversationId: thread.parentConversationId || origin.parentConversationId, rootConversationId: thread.rootConversationId || undefined, isChildThread: origin.isChildThread, agentNickname: thread.agentNickname || origin.agentNickname, agentRole: thread.agentRole || origin.agentRole };
}

async function sourceIdentities(verification: CodexStreamingHistoryVerification): Promise<CodexCorpusCacheEntry["sourceIdentities"]> {
    return verification.segments.flatMap(segment => [{ path: segment.path, physical: segment.physical }, ...segment.replicaIdentities.map(replica => ({ path: replica.path, physical: replica.physical }))]);
}

export function createCodexCorpusProvider(options: CodexCorpusReaderOptions = {}): CorpusProvider & {
    readRounds(conversation: CorpusConversation, request: CodexCorpusRoundRequest, control?: CorpusReadControl): Promise<CorpusProjection>;
    readFast(conversation: CorpusConversation, request: CodexCorpusFastReadRequest, control?: CorpusReadControl): Promise<CorpusProjection>;
} {
    const home = options.codexHome || path.join(os.homedir(), ".codex");
    const roots = [path.join(home, "sessions"), path.join(home, "archived_sessions")];
    const cacheRoot = options.cacheRoot || path.join(DATA_ROOT, "conversation-corpus", "codex");
    const proofCacheRoot = path.join(cacheRoot, "role-proofs");
    let pathsByRolloutId: Map<string, string[]> | undefined;
    let inventoryTask: Promise<Map<string, string[]>> | undefined;
    const ensureSourceInventory = async (control: CorpusReadControl, conversation: CorpusConversation): Promise<void> => {
        throwIfCodexReadCancelled(control.isCancelled);
        const rollout = conversation.rolloutPath && parseCodexRolloutFilename(conversation.rolloutPath);
        if (!pathsByRolloutId || (rollout && !pathsByRolloutId.has(rollout.rolloutId))) {
            inventoryTask ??= indexCodexHistorySourcePaths(roots, control.isCancelled);
            try { pathsByRolloutId = await inventoryTask; }
            finally { inventoryTask = undefined; }
        }
        throwIfCodexReadCancelled(control.isCancelled);
    };
    const roleProof = (entry: CodexCorpusCacheEntry) => (entry.projection as Partial<CodexRoleExcludedProjection>).roleExclusion;
    const supportsCachedRoles = (entry: CodexCorpusCacheEntry, control: CorpusReadControl): boolean => {
        const proof = roleProof(entry);
        if (!proof) return true;
        if (proof.version !== "codex-role-exclusion/v1" || !pathsByRolloutId || !Array.isArray(proof.requestedRoles) || !Array.isArray(proof.segments)
            || !(control.messageRoles || bodyRoles).every(role => proof.requestedRoles.includes(role))) return false;
        return proof.segments.every(segment => {
            const current = pathsByRolloutId!.get(segment.rolloutId);
            const expected = [segment.path, ...segment.replicas].map(comparablePath).sort();
            return current && JSON.stringify(current.map(comparablePath).sort()) === JSON.stringify(expected);
        });
    };
    const persist = async (entry: CodexCorpusCacheEntry, control: CorpusReadControl, root = cacheRoot): Promise<CodexCorpusCacheEntry> => {
        try { await publishCodexCorpusCache(root, entry, control, options.cacheMaxBytes); }
        catch (error) {
            if (!(error instanceof CodexCorpusCacheSizeLimitError)) throw error;
            throwIfCodexReadCancelled(control.isCancelled);
            entry.projection.warnings.push("persistent_body_cache_limit_streamed_projection_returned");
        }
        return entry;
    };
    const sourceOrigins = async (source: { segments: Array<{ path: string }> }, conversationId: string, control: CorpusReadControl): Promise<Map<string, CodexCorpusThreadOrigin>> => {
        const origins = new Map<string, CodexCorpusThreadOrigin>();
        for (const segment of source.segments) origins.set(segment.path, codexCorpusThreadOrigin(await readCodexStreamingSessionMeta(segment.path, { ...options.archive, isCancelled: control.isCancelled }), conversationId));
        return origins;
    };

    const enumerate = async (control: CorpusReadControl): Promise<Map<string, string[]>> => {
        const byThread = new Map<string, string[]>();
        const byRollout = new Map<string, string[]>();
        const visit = async (directory: string): Promise<void> => {
            throwIfCodexReadCancelled(control.isCancelled);
            let entries;
            try { entries = await fs.readdir(directory, { withFileTypes: true }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
            for (const entry of entries) {
                throwIfCodexReadCancelled(control.isCancelled);
                const candidate = path.join(directory, entry.name);
                if (entry.isDirectory()) await visit(candidate);
                else if (entry.isFile()) {
                    const identity = parseCodexRolloutFilename(candidate);
                    if (!identity) continue;
                    byThread.set(identity.threadId, [...(byThread.get(identity.threadId) || []), candidate]);
                    byRollout.set(identity.rolloutId, [...(byRollout.get(identity.rolloutId) || []), candidate]);
                }
            }
        };
        for (const root of roots) await visit(root);
        pathsByRolloutId = byRollout;
        return byThread;
    };

    const list = async (request: CorpusSearchRequest, control: CorpusReadControl = {}): Promise<CorpusConversation[]> => {
        throwIfCodexReadCancelled(control.isCancelled);
        control.onProgress?.({ phase: "codex_inventory" });
        const explicit = request.conversationIds?.map(normalizeCodexCorpusConversationId);
        const threads = options.listThreads ? await options.listThreads() : explicit?.length ? (await Promise.all(explicit.map(id => getCodexThreadAsync(id)))).filter((thread): thread is CodexThreadInfo => thread !== null) : await listCodexThreadsForMetadataAsync(Number.MAX_SAFE_INTEGER, true);
        const conversations = new Map(threads.map(thread => [thread.id.toLowerCase(), fromThread(thread)]));
        const paths = await enumerate(control);
        for (const [id, rollouts] of paths) {
            if ((explicit?.length && !explicit.includes(id)) || conversations.has(id)) continue;
            const selected = [...rollouts].sort((left, right) => right.replace(/\.zst$/iu, "").localeCompare(left.replace(/\.zst$/iu, "")) || Number(/\.zst$/iu.test(left)) - Number(/\.zst$/iu.test(right)))[0]!;
            const metadata = await readCodexStreamingSessionMeta(selected, { ...options.archive, isCancelled: control.isCancelled });
            const physical = await fs.stat(selected);
            const origin = codexCorpusThreadOrigin(metadata, id);
            conversations.set(id, { id, title: typeof metadata.title === "string" ? metadata.title : id, workspace: typeof metadata.cwd === "string" ? metadata.cwd : "", updatedAt: physical.mtime.toISOString(), rolloutPath: selected, archived: selected.startsWith(roots[1]!), source: "codex", isChildThread: origin.isChildThread, parentConversationId: origin.parentConversationId, agentNickname: origin.agentNickname, agentRole: origin.agentRole });
        }
        throwIfCodexReadCancelled(control.isCancelled);
        return [...conversations.values()].filter(conversation => (!explicit?.length || explicit.includes(conversation.id.toLowerCase())) && inWorkspace(conversation, request));
    };

    const reusePublished = async (conversation: CorpusConversation, control: CorpusReadControl, allowMissingTimestamps = false): Promise<CodexCorpusCacheEntry | null> => {
        if (control.messageRoles?.includes("subagent")) return null;
        const key = { source: "codex:link=summary", conversationId: conversation.id };
        const cached = readConversationSourceCacheMetadata<{ codexData?: { historySource?: CodexHistorySource }; rounds?: ConversationRound[] }>({ key, maxMetadataBytes: 1024 * 1024 });
        const history = cached?.snapshot.codexData?.historySource;
        if (!cached || !history || !conversation.rolloutPath || comparablePath(history.leafPath).replace(/\.zst$/u, "") !== comparablePath(conversation.rolloutPath).replace(/\.zst$/u, "")) return null;
        if (conversation.isChildThread) return null;
        try { assertCodexHistoryManifest(history); } catch { return null; }
        const sourceIdentities: CodexCorpusCacheEntry["sourceIdentities"] = [];
        const createdAt = Date.parse(cached.createdAt);
        if (!Number.isFinite(createdAt)) return null;
        for (const segment of history.segments) {
            throwIfCodexReadCancelled(control.isCancelled);
            const sources = [{ path: segment.path, size: segment.archive?.sourceSize ?? segment.size, mtimeMs: segment.archive?.sourceMtimeMs ?? segment.mtimeMs }, ...(segment.replicas || []).map(replica => ({ path: replica.path, size: replica.archive?.sourceSize ?? replica.size, mtimeMs: replica.archive?.sourceMtimeMs }))];
            for (const source of sources) {
                let physical;
                try { physical = codexHistoryPhysicalIdentity(await fs.stat(source.path)); } catch { return null; }
                if (physical.size !== source.size || (source.mtimeMs !== undefined && physical.mtimeMs !== source.mtimeMs) || physical.ctimeMs > createdAt) return null;
                sourceIdentities.push({ path: source.path, physical });
            }
        }
        try {
            if ([...(await sourceOrigins(history, conversation.id, control)).values()].some(origin => origin.isChildThread)) return null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
        }
        const record = readConversationSourceCacheRecordProjection<ConversationRecordProjectionRound>({ key, generation: cached.generation });
        if (!record || record.projections.some(round => round.bodyMetadataVersion !== 2)) return null;
        const revision = digest({ format: "published-codex-corpus/v3", generation: cached.generation, history: history.revision });
        const messages = record.projections.flatMap(round => round.messages.map((message, index) => ({ id: digest([conversation.id, cached.generation, round.roundIndex, index]), round: round.roundIndex, role: message.role, authorKind: message.role, sourceThreadId: conversation.id, text: message.text, ...codexCorpusAttachmentReferences(message), ...(message.annotations?.length ? { annotations: message.annotations.map(annotation => ({ ...annotation })) } : {}), timestamp: typeof (message as { timestamp?: unknown }).timestamp === "string" ? (message as { timestamp?: string }).timestamp : undefined, position: { messageId: `cache:${cached.generation}:R${round.roundIndex}:M${index}` } })));
        const missingTimestamps = messages.some(message => !message.timestamp);
        if (missingTimestamps && !allowMissingTimestamps) return null;
        const entry: CodexCorpusCacheEntry = { format: CODEX_CORPUS_CACHE_FORMAT, publishedProjectionVersion: 2, projection: { conversation, revision, cacheGeneration: cached.generation, messages, complete: true, warnings: ["published_cache_snapshot", ...(missingTimestamps ? ["message_timestamps_unavailable_in_legacy_projection"] : [])], sourceBytes: record.bytes }, sourceIdentities };
        return await codexCorpusSourceIdentitiesMatch(entry, pathsByRolloutId) ? entry : null;
    };

    const build = async (conversation: CorpusConversation, control: CorpusReadControl, previous?: CodexCorpusCacheEntry | null): Promise<CodexCorpusCacheEntry> => {
        if (!conversation.rolloutPath) throw new Error("Codex corpus conversation has no rollout path");
        const started = performance.now();
        const source = await resolveCodexStreamingHistorySource(conversation.rolloutPath, { roots, pathsByRolloutId, archive: options.archive, isCancelled: control.isCancelled });
        const discoverMs = performance.now() - started;
        const leaf = source.segments.at(-1)!;
        const oldLeaf = previous?.verification?.segments.at(-1);
        const unchangedReplicas = source.segments.every(segment => {
            const before = previous?.verification?.segments.find(candidate => candidate.path === segment.path);
            return before && JSON.stringify(segment.replicas.map(comparablePath).sort()) === JSON.stringify(before.replicaIdentities.map(replica => comparablePath(replica.path)).sort());
        });
        const canReplay = Boolean(unchangedReplicas && previous?.replay && previous.verification && previous.replay.position.path === leaf.path && !/\.zst$/iu.test(leaf.path) && oldLeaf?.path === leaf.path && oldLeaf.headerSha256 === leaf.headerSha256 && oldLeaf.physical.size < leaf.physical.size && oldLeaf.physical.ino === leaf.physical.ino && oldLeaf.physical.dev === leaf.physical.dev && oldLeaf.physical.birthtimeMs === leaf.physical.birthtimeMs);
        const replay = canReplay ? previous!.replay : undefined;
        const retained = replay ? previous!.projection.messages.filter(message => message.round < replay.round) : [];
        const projectedMessages: CorpusProjection["messages"] = [];
        const pendingRevision = `pending:${digest({ semanticVersion: SEMANTIC_VERSION, source })}`;
        const roles = control.messageRoles || bodyRoles;
        let pendingMessages: CorpusProjection["messages"] = [];
        let chunkStarted = false;
        let sourceBytes = 0;
        const emitChunk = (messages: CorpusProjection["messages"], replaceFromRound?: number): void | Promise<void> => {
            throwIfCodexReadCancelled(control.isCancelled);
            const completion = control.onChunk?.({ conversation, revision: pendingRevision, messages: messages.filter(message => roles.includes(message.role)), warnings: ["unverified_source_projection"], sourceBytes, ...(replaceFromRound !== undefined ? { replaceFromRound } : {}) });
            chunkStarted = true;
            if (completion && typeof completion.then === "function") return Promise.resolve(completion).then(() => { throwIfCodexReadCancelled(control.isCancelled); });
            throwIfCodexReadCancelled(control.isCancelled);
        };
        const flushChunk = (): void | Promise<void> => {
            if (!control.onChunk || !pendingMessages.length) return;
            const messages = pendingMessages;
            pendingMessages = [];
            return emitChunk(messages, chunkStarted ? undefined : 1);
        };
        if (control.onChunk && replay) {
            const completion = emitChunk(retained, 1);
            if (completion && typeof completion.then === "function") await completion;
        }
        const collector = createCodexCorpusCollector({ conversationId: conversation.id, cwd: conversation.workspace, roles: storedRoles, startRound: replay?.round, originsByPath: await sourceOrigins(source, conversation.id, control), onRound: control.onChunk ? (_round, messages) => { projectedMessages.push(...messages); pendingMessages.push(...messages); } : undefined });
        let lastProgressAt = 0;
        const verification = await scanCodexStreamingHistory(source, (event, position) => { collector.addEvent(event, position); return flushChunk(); }, {
            archive: options.archive,
            isCancelled: control.isCancelled,
            replayFrom: replay?.position,
            previousVerification: replay ? previous!.verification : undefined,
            onProgress: bytes => {
                sourceBytes = bytes;
                if (performance.now() - lastProgressAt >= 250) { control.onProgress?.({ phase: "codex_body_projection", bytes }); lastProgressAt = performance.now(); }
            },
        });
        const projected = collector.finish();
        const completion = flushChunk();
        if (completion && typeof completion.then === "function") await completion;
        const messages = [...retained, ...(control.onChunk ? projectedMessages : projected.messages)];
        return { format: CODEX_CORPUS_CACHE_FORMAT, projection: { conversation, revision: projectionRevision(verification.revision), messages, complete: true, warnings: messages.some(message => !message.timestamp) ? ["source_message_timestamps_unavailable"] : [], sourceBytes: verification.sourceBytes, timings: { discoveryMs: discoverMs, scanMs: performance.now() - started - discoverMs, incrementalReplay: replay ? 1 : 0 } }, verification, replay: projected.lastRoundStart ? { round: projected.roundCount, position: projected.lastRoundStart } : undefined, sourceIdentities: await sourceIdentities(verification) };
    };

    const readEntry = async (conversation: CorpusConversation, control: CorpusReadControl, allowMissingTimestamps = false): Promise<CodexCorpusCacheEntry> => {
        throwIfCodexReadCancelled(control.isCancelled);
        await ensureSourceInventory(control, conversation);
        let previous: CodexCorpusCacheEntry | null = null;
        if (!control.forceRefresh) {
            const cached = await readCodexCorpusCache(cacheRoot, conversation.id, control);
            const browsingOnly = cached?.projection.warnings.includes("legacy_cache_body_browsing_only") || cached?.projection.warnings.includes("message_timestamps_unavailable_in_legacy_projection");
            if (cached && !((cached.projection.cacheGeneration && control.messageRoles?.includes("subagent")) || (!allowMissingTimestamps && browsingOnly)) && cached.projection.conversation.rolloutPath && conversation.rolloutPath && comparablePath(cached.projection.conversation.rolloutPath).replace(/\.zst$/u, "") === comparablePath(conversation.rolloutPath).replace(/\.zst$/u, "") && await codexCorpusSourceIdentitiesMatch(cached, pathsByRolloutId)) return { ...cached, projection: { ...cached.projection, conversation, timings: { cacheHit: 1 } } };
            previous = browsingOnly ? null : cached;
            const published = await reusePublished(conversation, control, allowMissingTimestamps);
            if (published) {
                return persist(published, control);
            }
            if (allowMissingTimestamps) {
                const legacy = await readLegacyCodexCorpus(conversation, control, { roots, pathsByRolloutId, archive: options.archive, prefixProofCacheRoot: path.join(cacheRoot, "prefix-proofs") });
                if (legacy) return persist(legacy, control);
            }
        }
        let built: CodexCorpusCacheEntry;
        try { built = await build(conversation, control, previous); }
        catch (error) {
            if (control.onChunk || !previous?.verification || !(error instanceof CodexHistorySourceMismatchError) || !/incremental|replay/u.test(error.message)) throw error;
            built = await build(conversation, control);
        }
        control.onProgress?.({ phase: "codex_projection_publish", bytes: built.projection.sourceBytes });
        throwIfCodexReadCancelled(control.isCancelled);
        return persist(built, control);
    };

    const readRounds = async (conversation: CorpusConversation, request: CodexCorpusRoundRequest, control: CorpusReadControl = {}, requireRequestedRange = false): Promise<CorpusProjection> => {
        if (!request.revision) throw new Error("Codex round expansion requires its projection revision");
        const requestedRoles = request.messageRoles || control.messageRoles;
        const entry = await readEntry(conversation, requestedRoles?.includes("tool") ? { ...control, messageRoles: bodyRoles, onChunk: undefined } : { ...control, messageRoles: requestedRoles }, true);
        if (entry.projection.revision !== request.revision) throw new CodexHistorySourceMismatchError("Codex corpus revision changed; repeat the search before expanding rounds");
        const last = entry.projection.messages.reduce((latest, message) => Math.max(latest, message.round), 0);
        const start = request.lastRounds === undefined ? request.startRound ?? 1 : Math.max(1, last - request.lastRounds + 1);
        const end = request.endRound ?? last;
        if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || (request.lastRounds !== undefined && (!Number.isSafeInteger(request.lastRounds) || request.lastRounds < 1))) throw new Error("Codex corpus round range is invalid");
        if (requireRequestedRange && request.lastRounds === undefined && end > last) throw new Error("Codex requested round range exceeds the available canonical rounds");
        const roles = request.messageRoles || control.messageRoles || bodyRoles;
        if (roles.some(role => role === "tool" || role === "subagent") && entry.projection.cacheGeneration) {
            const key = { source: "codex:link=summary", conversationId: conversation.id };
            const rounds = iterateCachedConversationSourceCacheRounds<ConversationRound>({ key, generation: entry.projection.cacheGeneration, startRound: start, endRound: end });
            if (!rounds) throw new Error("Codex published cache generation is unavailable");
            const extra = [];
            for (const round of rounds.rounds) { throwIfCodexReadCancelled(control.isCancelled); extra.push(...projectCodexCorpusRound(conversation.id, round, new Map(), roles.filter(role => role === "tool" || role === "subagent"))); }
            return { ...entry.projection, messages: [...entry.projection.messages.filter(message => message.round >= start && message.round <= end && bodyRoles.includes(message.role) && roles.includes(message.role)), ...extra].sort((left, right) => left.round - right.round) };
        }
        if (roles.includes("tool")) {
            const source = await resolveCodexStreamingHistorySource(conversation.rolloutPath!, { roots, pathsByRolloutId, archive: options.archive, isCancelled: control.isCancelled });
            const selected: CorpusProjection["messages"] = [];
            const collector = createCodexCorpusCollector({ conversationId: conversation.id, cwd: conversation.workspace, roles, originsByPath: await sourceOrigins(source, conversation.id, control), onRound: (round, messages) => { if (round >= start && round <= end) selected.push(...messages); } });
            const verification = await scanCodexStreamingHistory(source, (event, position) => collector.addEvent(event, position), { archive: options.archive, isCancelled: control.isCancelled });
            collector.finish();
            const browseVerification = entry.projection.warnings.includes("legacy_cache_body_browsing_only") ? entry.verification : undefined;
            const comparableVerification = (value: CodexStreamingHistoryVerification) => value.segments.map(segment => ({ path: segment.path, physical: segment.physical, header: segment.headerSha256, start: segment.startOrdinal, end: segment.endOrdinalExclusive, bytes: segment.endByte, hash: segment.prefixSha256, next: segment.nextOrdinal }));
            if (browseVerification ? JSON.stringify(comparableVerification(browseVerification)) !== JSON.stringify(comparableVerification(verification)) : projectionRevision(verification.revision) !== request.revision) throw new CodexHistorySourceMismatchError("Codex corpus revision changed during round expansion");
            return { ...entry.projection, messages: selected };
        }
        return { ...entry.projection, messages: entry.projection.messages.filter(message => message.round >= start && message.round <= end && roles.includes(message.role)) };
    };

    const readFast = async (conversation: CorpusConversation, request: CodexCorpusFastReadRequest, control: CorpusReadControl = {}): Promise<CorpusProjection> => {
        throwIfCodexReadCancelled(control.isCancelled);
        await ensureSourceInventory(control, conversation);
        const roles = request.messageRoles || control.messageRoles || bodyRoles;
        const start = request.startRound ?? 1;
        const end = request.endRound ?? (request.lastRounds === undefined ? start : Number.POSITIVE_INFINITY);
        if (!Number.isSafeInteger(start) || start < 1 || (Number.isFinite(end) && (!Number.isSafeInteger(end) || end < start)) || (request.lastRounds !== undefined && (!Number.isSafeInteger(request.lastRounds) || request.lastRounds < 1))) throw new Error("Codex corpus fast round range is invalid");
        const range = { ...request, ...(request.lastRounds === undefined ? { endRound: end } : {}) };
        if (!control.forceRefresh) {
            const cached = await readCodexCorpusCache(cacheRoot, conversation.id, control);
            if (cached && !(cached.projection.cacheGeneration && roles.includes("subagent")) && conversation.rolloutPath && cached.projection.conversation.rolloutPath && comparablePath(conversation.rolloutPath).replace(/\.zst$/u, "") === comparablePath(cached.projection.conversation.rolloutPath).replace(/\.zst$/u, "") && await codexCorpusSourceIdentitiesMatch(cached, pathsByRolloutId)) return readRounds(conversation, { ...range, revision: cached.projection.revision }, control, true);
            const published = await reusePublished(conversation, { ...control, messageRoles: roles }, true);
            if (published) {
                await persist(published, control);
                return readRounds(conversation, { ...range, revision: published.projection.revision }, control, true);
            }
            const legacy = await readLegacyCodexCorpus(conversation, { ...control, messageRoles: roles }, { roots, pathsByRolloutId, archive: options.archive, prefixProofCacheRoot: path.join(cacheRoot, "prefix-proofs") }, range);
            if (legacy) {
                if (legacy.projection.complete) await persist(legacy, control);
                const last = legacy.projection.timings?.legacyRoundCount ?? legacy.projection.messages.reduce((latest, message) => Math.max(latest, message.round), 0);
                if (request.lastRounds === undefined && end > last) throw new Error("Codex requested round range exceeds the available canonical rounds");
                const first = request.lastRounds === undefined ? start : Math.max(1, last - request.lastRounds + 1);
                return { ...legacy.projection, messages: legacy.projection.messages.filter(message => message.round >= first && message.round <= end && roles.includes(message.role)), requestedRangeComplete: true };
            }
        }
        if (!conversation.rolloutPath) throw new Error("Codex corpus conversation has no rollout path");
        const started = performance.now();
        const source = await resolveCodexStreamingHistorySource(conversation.rolloutPath, { roots, pathsByRolloutId, archive: options.archive, isCancelled: control.isCancelled });
        const selected: CorpusProjection["messages"] = [];
        const recent: Array<{ round: number; messages: CorpusProjection["messages"] }> = [];
        const rangeDone = new Error("Codex requested round range completed");
        let stopped = false;
        let roundCount = 0;
        let sourceBytes = 0;
        const collector = createCodexCorpusCollector({ conversationId: conversation.id, cwd: conversation.workspace, roles, originsByPath: await sourceOrigins(source, conversation.id, control), onRound: (round, messages) => {
            roundCount = round;
            if (request.lastRounds !== undefined) {
                recent.push({ round, messages });
                if (recent.length > request.lastRounds) recent.shift();
            } else {
                if (round >= start && round <= end) selected.push(...messages);
                if (round >= end) { stopped = true; throw rangeDone; }
            }
        } });
        let verification: CodexStreamingHistoryVerification | undefined;
        const proofs: CodexStreamingPrefixProof[] = [];
        try {
            verification = await scanCodexStreamingHistory(source, (event, position) => collector.addEvent(event, position), { archive: options.archive, isCancelled: control.isCancelled, onPrefixProof: proof => proofs.push(proof), onProgress: bytes => { sourceBytes = bytes; control.onProgress?.({ phase: "codex_requested_rounds", bytes }); } });
            collector.finish();
        } catch (error) { if (error !== rangeDone) throw error; }
        throwIfCodexReadCancelled(control.isCancelled);
        await assertCodexStreamingRangeSource(source, proofs, control.isCancelled, options.archive);
        if (request.lastRounds === undefined && roundCount < end) throw new Error("Codex requested round range exceeds the available canonical rounds");
        const messages = request.lastRounds === undefined ? selected : recent.flatMap(item => item.messages);
        return { conversation, revision: verification ? projectionRevision(verification.revision) : `range:${digest({ source, start, end, messages })}`, messages, complete: Boolean(verification), requestedRangeComplete: true, warnings: verification ? [] : ["requested_round_range_complete", "full_source_projection_not_built"], sourceBytes: verification?.sourceBytes ?? sourceBytes, timings: { rangeReadMs: performance.now() - started, earlyRangeStop: stopped && !verification ? 1 : 0 } };
    };

    const readCached = async (conversation: CorpusConversation, control: CorpusReadControl): Promise<CorpusProjection | null> => {
        if (control.forceRefresh || control.messageRoles?.includes("tool")) return null;
        await ensureSourceInventory(control, conversation);
        const cached = await readCodexCorpusCache(cacheRoot, conversation.id, control);
        const browsingOnly = cached?.projection.warnings.includes("legacy_cache_body_browsing_only") || cached?.projection.warnings.includes("message_timestamps_unavailable_in_legacy_projection");
        if (cached && !browsingOnly && !(cached.projection.cacheGeneration && control.messageRoles?.includes("subagent")) && conversation.rolloutPath && cached.projection.conversation.rolloutPath
            && comparablePath(conversation.rolloutPath).replace(/\.zst$/u, "") === comparablePath(cached.projection.conversation.rolloutPath).replace(/\.zst$/u, "")
            && await codexCorpusSourceIdentitiesMatch(cached, pathsByRolloutId)) return selectRoles({ ...cached.projection, conversation, timings: { cacheHit: 1 } }, control);
        const proof = await readCodexCorpusCache(proofCacheRoot, conversation.id, control, CODEX_ROLE_PROOF_CACHE_FORMAT);
        if (proof && roleProof(proof) && supportsCachedRoles(proof, control) && conversation.rolloutPath && proof.projection.conversation.rolloutPath
            && comparablePath(conversation.rolloutPath) === comparablePath(proof.projection.conversation.rolloutPath)
            && await codexCorpusSourceIdentitiesMatch(proof, pathsByRolloutId)) return selectRoles({ ...proof.projection, conversation, timings: { cacheHit: 1 } }, control);
        return null;
    };

    return {
        semanticVersion: SEMANTIC_VERSION,
        list,
        readCached,
        async read(conversation, control = {}) {
            await ensureSourceInventory(control, conversation);
            if (control.messageRoles?.includes("tool")) {
                if (!conversation.rolloutPath) throw new Error("Codex corpus conversation has no rollout path");
                const source = await resolveCodexStreamingHistorySource(conversation.rolloutPath, { roots, pathsByRolloutId, archive: options.archive, isCancelled: control.isCancelled });
                const messages: CorpusProjection["messages"] = [];
                let pending: CorpusProjection["messages"] = [];
                let chunkStarted = false;
                const revision = `pending:${digest({ semanticVersion: SEMANTIC_VERSION, source, roles: control.messageRoles })}`;
                const flush = (): void | Promise<void> => {
                    if (!control.onChunk || !pending.length) return;
                    const chunk = pending;
                    pending = [];
                    const completion = control.onChunk({ conversation, revision, messages: chunk, warnings: ["unverified_source_projection"], ...(chunkStarted ? {} : { replaceFromRound: 1 }) });
                    chunkStarted = true;
                    if (completion && typeof completion.then === "function") return Promise.resolve(completion).then(() => { throwIfCodexReadCancelled(control.isCancelled); });
                };
                const collector = createCodexCorpusCollector({ conversationId: conversation.id, cwd: conversation.workspace, roles: control.messageRoles, originsByPath: await sourceOrigins(source, conversation.id, control), onRound: (_round, projected) => { messages.push(...projected); pending.push(...projected); } });
                const verification = await scanCodexStreamingHistory(source, (event, position) => { collector.addEvent(event, position); return flush(); }, { archive: options.archive, isCancelled: control.isCancelled, onProgress: bytes => control.onProgress?.({ phase: "codex_requested_roles", bytes }) });
                collector.finish();
                const completion = flush();
                if (completion && typeof completion.then === "function") await completion;
                throwIfCodexReadCancelled(control.isCancelled);
                return { conversation, revision: projectionRevision(verification.revision), messages, complete: true, warnings: messages.some(message => !message.timestamp) ? ["source_message_timestamps_unavailable"] : [], sourceBytes: verification.sourceBytes };
            }
            if (!control.forceRefresh) {
                const cached = await readCached(conversation, control);
                if (cached) return cached;
                const excluded = await readRoleExcludedCodexProjection(conversation, control, { roots, pathsByRolloutId, archive: options.archive });
                if (excluded) {
                    await persist({ format: CODEX_ROLE_PROOF_CACHE_FORMAT, projection: excluded,
                        sourceIdentities: excluded.roleExclusion.segments.flatMap(segment => [
                            { path: segment.path, physical: segment.physical },
                            ...segment.replicaIdentities.map(replica => ({ path: replica.path, physical: replica.physical })),
                        ]) }, control, proofCacheRoot);
                    return excluded;
                }
            }
            const entry = await readEntry(conversation, control);
            return selectRoles(entry.projection, control);
        },
        readRounds,
        readFast,
    };
}

export const codexCorpusProvider = createCodexCorpusProvider();
export const listCodexCorpusConversations = (request: CorpusSearchRequest, control: CorpusReadControl = {}): Promise<CorpusConversation[]> => codexCorpusProvider.list(request, control);
export const readCodexCorpusProjection = (conversation: CorpusConversation, control: CorpusReadControl = {}): Promise<CorpusProjection> => codexCorpusProvider.read(conversation, control);
export const readCodexCorpusRounds = (conversation: CorpusConversation, request: CodexCorpusRoundRequest, control: CorpusReadControl = {}): Promise<CorpusProjection> => codexCorpusProvider.readRounds(conversation, request, control);
export const readCodexCorpusFast = (conversation: CorpusConversation, request: CodexCorpusFastReadRequest, control: CorpusReadControl = {}): Promise<CorpusProjection> => codexCorpusProvider.readFast(conversation, request, control);
