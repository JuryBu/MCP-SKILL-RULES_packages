import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { CorpusConversation, CorpusProvider, CorpusProjection, CorpusSearchRequest, CorpusSourceStatus, CorpusVerifiedIdentity } from "./conversation-corpus-types.js";
import { corpusProjectionIdentityMatches, verifiedCorpusIdentity } from "./conversation-host-binary.js";
import { corpusConversationKey, resolveCorpusSources, type CorpusSource } from "./conversation-corpus-sources.js";
import {
    compileCorpusSearch, CorpusSearchAccumulator, corpusConversationMatchesScope, sortCorpusMatches, CORPUS_QUERY_SEMANTIC_VERSION,
    type CorpusConversationMatch,
} from "./conversation-corpus-search.js";
import {
    acquireCorpusLease, corpusCommitKey, corpusCommitSource, corpusCoverage, corpusCurrentRecords, corpusCursor, corpusPreparationDirectory, corpusOwnerHash, corpusTaskDirectory, corpusTaskError,
    corpusTaskSources, validateCorpusSourceStatuses, corpusResultRecords,
    corpusSemanticVersionsEqual,
    loadCorpusTask, parseCorpusCursor, readCorpusJson, readCorpusTaskCommitRange, writeCorpusJson, writeCorpusTaskCommits,
    type CorpusTaskCommit, type CorpusTaskCoverage, type CorpusTaskLoaded, type CorpusTaskSnapshot,
    type CorpusTaskState, type CorpusTaskStoredState, type CorpusSemanticVersion, type CorpusPreparedEvidence,
} from "./conversation-corpus-task-store.js";

export type { CorpusTaskCoverage, CorpusTaskState } from "./conversation-corpus-task-store.js";
export type { CorpusConversationMatch, CorpusMatchSnippet } from "./conversation-corpus-search.js";

export interface CorpusSearchIdentity { ownerId: string; taskId: string; root?: string; dataChain?: CorpusSource; dataChains?: CorpusSource[]; }
export interface CorpusSearchStatusOptions extends CorpusSearchIdentity {
    limit?: number;
    cursor?: string;
    afterRevision?: number;
    waitMs?: number;
}
export interface CorpusSearchStatus {
    taskId: string;
    ownerId: string;
    status: CorpusTaskState;
    phase: CorpusTaskStoredState["phase"];
    revision: number;
    viewRevision: number;
    semanticVersion: CorpusSemanticVersion;
    viewSemanticVersion: CorpusSemanticVersion;
    request: CorpusSearchRequest;
    results: CorpusConversationMatch[];
    totalMatches: number;
    hasMore: boolean;
    nextCursor?: string;
    snapshotId?: string;
    snapshotStatus?: CorpusTaskState;
    coverage: CorpusTaskCoverage;
    changes?: {
        upserts: CorpusConversationMatch[];
        removedConversationIds: string[];
        removedConversations: Array<{ source: CorpusSource; conversationId: string }>;
        removedConversationKeys: string[];
        throughRevision: number;
        hasMore: boolean;
    };
    progress?: { source?: CorpusSource; conversationId?: string; phase: string; bytes?: number; totalBytes?: number };
    timings: { queryComputeMs: number; taskWallMs: number };
    error?: string;
    prepared?: CorpusPreparedEvidence;
}

export interface StartCorpusSearchOptions {
    ownerId: string;
    request: CorpusSearchRequest;
    provider: CorpusProvider;
    root?: string;
    checkpointEveryMessages?: number;
    checkpointIntervalMs?: number;
    commitBatchSize?: number;
}

type PendingCorpusCommit = Omit<CorpusTaskCommit, "revision" | "changed">;

interface CorpusRuntime {
    task: CorpusTaskLoaded;
    cancelled: boolean;
    lastCancelCheck: number;
    lastStateSave: number;
    progress?: CorpusSearchStatus["progress"];
    waiters: Set<() => void>;
    release: () => Promise<void>;
    promise?: Promise<void>;
    settleRead?: () => Promise<void>;
    commitQueue?: Promise<void>;
    pendingCommits: PendingCorpusCommit[];
    pendingCommitBytes: number;
    commitTimer?: ReturnType<typeof setTimeout>;
    commitError?: unknown;
    deadlineAt?: number;
    processedConversations: number;
    processedSourceBytes: number;
    currentSourceBytes: number;
    initialMatchingConversations: number;
    budgetReason?: string;
}

const runtimes = new Map<string, CorpusRuntime>();
const isTerminal = (status: CorpusTaskState): boolean => !["running", "cancelling", "resumable"].includes(status);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function notify(runtime: CorpusRuntime): void {
    for (const waiter of runtime.waiters) waiter();
    runtime.waiters.clear();
}

function cancelled(runtime: CorpusRuntime): boolean {
    if (runtime.cancelled) return true;
    if (Date.now() - runtime.lastCancelCheck >= 100) {
        runtime.lastCancelCheck = Date.now();
        runtime.cancelled = fs.existsSync(path.join(runtime.task.directory, "cancel.json"));
    }
    return runtime.cancelled;
}

function budgetExceeded(runtime: CorpusRuntime): boolean {
    if (runtime.budgetReason) return true;
    const request = runtime.task.request;
    if (runtime.deadlineAt !== undefined && Date.now() >= runtime.deadlineAt) runtime.budgetReason = `deadlineMs=${request.deadlineMs}`;
    else if (request.maxBytes !== undefined && runtime.processedSourceBytes + runtime.currentSourceBytes >= request.maxBytes) runtime.budgetReason = `maxBytes=${request.maxBytes}`;
    return Boolean(runtime.budgetReason);
}

function stopped(runtime: CorpusRuntime): boolean {
    return cancelled(runtime) || budgetExceeded(runtime);
}

function canStartCandidate(runtime: CorpusRuntime): boolean {
    if (stopped(runtime)) return false;
    const request = runtime.task.request;
    if (request.maxFiles !== undefined && runtime.processedConversations >= request.maxFiles) runtime.budgetReason = `maxFiles=${request.maxFiles}`;
    else if (request.maxHits !== undefined && [...runtime.task.records.values()].filter(record => record.result).length - runtime.initialMatchingConversations >= request.maxHits) runtime.budgetReason = `maxHits=${request.maxHits}`;
    return !runtime.budgetReason;
}

function recordBudgetStop(runtime: CorpusRuntime): void {
    if (runtime.budgetReason) runtime.task.state.error = `Search paused at ${runtime.budgetReason}; verified results are retained. Continue with search_all_resume using the same taskId.`;
}

async function saveState(task: CorpusTaskLoaded): Promise<void> {
    task.state.updatedAt = new Date().toISOString();
    await writeCorpusJson(path.join(task.directory, "state.json"), task.state);
}

async function flushCommits(runtime: CorpusRuntime): Promise<void> {
    if (runtime.commitTimer) clearTimeout(runtime.commitTimer);
    runtime.commitTimer = undefined;
    if (runtime.commitError) throw runtime.commitError;
    const entries = runtime.pendingCommits.splice(0);
    runtime.pendingCommitBytes = 0;
    if (entries.length) {
        const work = (runtime.commitQueue ?? Promise.resolve()).then(async () => {
            if (runtime.commitError) throw runtime.commitError;
            await writeConversationCommit(runtime, entries);
        });
        runtime.commitQueue = work.catch(error => { runtime.commitError = error; });
        await work;
    } else await runtime.commitQueue;
    if (runtime.commitError) throw runtime.commitError;
}

async function commitConversation(runtime: CorpusRuntime, entry: PendingCorpusCommit, defer = false): Promise<void> {
    if (runtime.commitError) throw runtime.commitError;
    runtime.pendingCommits.push(entry);
    runtime.pendingCommitBytes += Buffer.byteLength(JSON.stringify(entry));
    if (!defer || runtime.pendingCommits.length >= (runtime.task.state.commitBatchSize ?? 1) || runtime.pendingCommitBytes >= 256 * 1024) {
        await flushCommits(runtime);
    } else if (!runtime.commitTimer) {
        runtime.commitTimer = setTimeout(() => {
            runtime.commitTimer = undefined;
            void flushCommits(runtime).catch(error => { runtime.commitError = error; notify(runtime); });
        }, 50);
    }
}

async function writeConversationCommit(runtime: CorpusRuntime, entries: PendingCorpusCommit[]): Promise<void> {
    const task = runtime.task;
    const staged = new Map<string, CorpusTaskCommit>();
    const commits = entries.map((entry, index): CorpusTaskCommit => {
        const key = corpusCommitKey(entry);
        const previous = staged.get(key) ?? task.records.get(key);
        const commit: CorpusTaskCommit = {
            ...entry, revision: task.state.revision + index + 1,
            queryComputeMs: task.state.computeMs, semanticVersion: task.state.semanticVersion,
            changed: JSON.stringify(previous?.result ?? null) !== JSON.stringify(entry.result),
        };
        staged.set(key, commit);
        return commit;
    });
    await writeCorpusTaskCommits(task, commits);
    for (const commit of commits) task.records.set(corpusCommitKey(commit), commit);
    task.commits.push(...commits);
    task.state.revision = commits.at(-1)!.revision;
    task.state.updatedAt = new Date().toISOString();
    if (Date.now() - runtime.lastStateSave >= 250) {
        await saveState(task);
        runtime.lastStateSave = Date.now();
    }
    notify(runtime);
}

async function finishTask(task: CorpusTaskLoaded, status: CorpusTaskState): Promise<void> {
    task.state.phase = "finalizing";
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const snapshot: CorpusTaskSnapshot = {
        snapshotId, revision: task.state.revision, status,
        results: sortCorpusMatches(corpusResultRecords(task).flatMap(record => record.result ? [record.result] : []), task.request.sort),
        coverage: corpusCoverage(task),
        semanticVersion: task.state.semanticVersion, prepared: preparedEvidence(task),
    };
    await writeCorpusJson(path.join(task.directory, "snapshots", `${snapshotId}.json`), snapshot);
    task.state.status = status;
    task.state.phase = "idle";
    task.state.snapshotId = snapshotId;
    task.state.snapshotHash = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    await saveState(task);
}

function preparedEvidence(task: CorpusTaskLoaded): CorpusPreparedEvidence | undefined {
    const record = corpusCurrentRecords(task).find(record => record.prepared);
    return record?.prepared ? { ...record.prepared, source: record.prepared.source ?? corpusCommitSource(record),
        commitPath: path.join(task.directory, "commits", `${String(record.revision).padStart(12, "0")}.json`) } : undefined;
}

function semanticVersion(provider: CorpusProvider): CorpusSemanticVersion {
    if (provider.semanticVersion !== undefined && (typeof provider.semanticVersion !== "string" || !provider.semanticVersion.trim())) {
        throw new Error("Provider semanticVersion must be a nonempty string when specified");
    }
    return { query: CORPUS_QUERY_SEMANTIC_VERSION, provider: provider.semanticVersion ?? null };
}

function validateProjection(projection: CorpusProjection, candidate: CorpusConversation): void {
    if (!projection || !projection.conversation || !corpusProjectionIdentityMatches(projection.conversation, candidate)
        || typeof projection.revision !== "string" || !projection.revision.trim() || !Array.isArray(projection.messages)
        || typeof projection.complete !== "boolean" || !Array.isArray(projection.warnings)
        || projection.warnings.some(warning => typeof warning !== "string")) {
        throw new Error("Provider returned an invalid corpus projection or a different conversation");
    }
    if (projectionComplete(projection) && /^pending(?:[:/-]|$)/u.test(projection.revision)) throw new Error("A complete projection requires a verified source revision");
}

function projectionComplete(projection: CorpusProjection): boolean {
    return projection.complete && !("partial" in projection && projection.partial === true);
}

function validateSourceBinding(task: CorpusTaskLoaded, options: Pick<CorpusSearchIdentity, "dataChain" | "dataChains">): void {
    if (options.dataChain === undefined && options.dataChains === undefined) return;
    const sources = resolveCorpusSources(options);
    if (JSON.stringify([...sources].sort()) !== JSON.stringify([...corpusTaskSources(task.request)].sort())) {
        throw corpusTaskError("CORPUS_SOURCE_MISMATCH", "Requested sources do not match this task; resume the original task with its bound sources");
    }
}

function captureSourceStatuses(task: CorpusTaskLoaded, provider: CorpusProvider, candidates?: CorpusConversation[]): void {
    const sources = corpusTaskSources(task.request);
    const statuses = provider.sourceStatuses?.();
    if (statuses !== undefined) validateCorpusSourceStatuses(statuses, sources);
    task.state.sourceStatuses = sources.map((source): CorpusSourceStatus => {
        const status = statuses?.find(status => status.source === source);
        if (status) return { ...status, warnings: [...status.warnings] };
        if (statuses !== undefined) return { source, status: "error", candidateCount: 0, warnings: [], error: "Provider omitted source coverage" };
        return { source, status: "ok", candidateCount: candidates?.filter(candidate => candidate?.source === source).length ?? 0, warnings: [] };
    });
}

async function scanProjection(runtime: CorpusRuntime, projection: CorpusProjection, candidate: CorpusConversation, verifiedIdentity?: CorpusVerifiedIdentity): Promise<void> {
    const task = runtime.task;
    const complete = projectionComplete(projection);
    const sourceBytes = Number.isFinite(projection.sourceBytes) && projection.sourceBytes! >= 0 ? projection.sourceBytes! : 0;
    if (task.request.purpose === "prepare") {
        if (projection.messages.some(message => !message || typeof message.id !== "string" || !message.id
            || !Number.isInteger(message.round) || message.round < 1 || typeof message.text !== "string"
            || !task.request.messageRoles!.includes(message.role))) throw new Error("Provider returned invalid preparation messages");
        if (!cancelled(runtime)) await commitConversation(runtime, {
            source: candidate.source, conversationId: candidate.id, complete, result: null, verifiedIdentity,
            scannedMessages: projection.messages.length, mirrorMessagesSkipped: 0, sourceBytes, warnings: projection.warnings,
            prepared: { kind: "conversation_body_projection", conversationId: projection.conversation.id,
                source: projection.conversation.source, sourceRevision: projection.revision, cacheGeneration: projection.cacheGeneration, complete, sourceBytes },
        });
        return;
    }
    const accumulator = new CorpusSearchAccumulator(projection.conversation, task.request, projection);
    let lastCheckpoint = -Infinity;
    const commit = async (complete: boolean, defer = false): Promise<void> => {
        const computeStart = performance.now();
        const result = accumulator.snapshot(complete);
        task.state.computeMs += performance.now() - computeStart;
        await commitConversation(runtime, {
            source: candidate.source, conversationId: candidate.id, complete, result, verifiedIdentity,
            scannedMessages: accumulator.scannedMessages, mirrorMessagesSkipped: accumulator.mirrorMessagesSkipped,
            sourceBytes, warnings: projection.warnings,
        }, defer);
        lastCheckpoint = Date.now();
    };
    for (let offset = 0; offset < projection.messages.length;) {
        if (cancelled(runtime)) return;
        if (runtime.deadlineAt !== undefined && Date.now() >= runtime.deadlineAt) {
            budgetExceeded(runtime);
            await commit(false);
            return;
        }
        const end = Math.min(projection.messages.length, offset + task.state.checkpointEveryMessages);
        const computeStart = performance.now();
        for (; offset < end; offset++) accumulator.append(projection.messages[offset]);
        task.state.computeMs += performance.now() - computeStart;
        if (offset < projection.messages.length) {
            if (Date.now() - lastCheckpoint >= task.state.checkpointIntervalMs) await commit(false);
            await yieldImmediate();
        }
    }
    if (!cancelled(runtime)) await commit(complete, true);
}

async function retractUnverified(runtime: CorpusRuntime, candidate: CorpusConversation): Promise<void> {
    if (!runtime.task.records.get(corpusConversationKey(candidate))?.unverified) return;
    await commitConversation(runtime, { source: candidate.source, conversationId: candidate.id, complete: false, result: null,
        scannedMessages: 0, mirrorMessagesSkipped: 0, sourceBytes: 0, warnings: [] });
}

async function readProjection(runtime: CorpusRuntime, provider: CorpusProvider, candidate: CorpusConversation): Promise<CorpusProjection> {
    const task = runtime.task;
    let accepting = true;
    let queue = Promise.resolve();
    let streamError: unknown;
    let accumulator: CorpusSearchAccumulator | undefined;
    let lastCommit = -Infinity;
    let sourceBytes = 0;
    const warnings = new Set<string>(candidate.sourceWarnings);
    let dirty = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const clearFlush = (): void => { if (flushTimer) clearTimeout(flushTimer); flushTimer = undefined; };
    const flush = async (): Promise<void> => {
        if (!accepting || !dirty || !accumulator || cancelled(runtime)) return;
        const snapshotStart = performance.now();
        const result = accumulator.snapshot(false);
        task.state.computeMs += performance.now() - snapshotStart;
        if (result) result.warnings = [...warnings];
        const identity = verifiedCorpusIdentity(accumulator.conversation);
        const verifiedIdentity = identity ? { ...identity, sourceRevision: accumulator.source.revision } : undefined;
        dirty = false;
        await commitConversation(runtime, { source: candidate.source, conversationId: candidate.id, complete: false, result,
            scannedMessages: accumulator.scannedMessages, mirrorMessagesSkipped: accumulator.mirrorMessagesSkipped,
            sourceBytes, warnings: [...warnings], unverified: true, verifiedIdentity });
        lastCommit = Date.now();
    };
    const settle = async (): Promise<void> => { clearFlush(); await queue; await retractUnverified(runtime, candidate); };
    runtime.settleRead = settle;
    try {
        const projection = await provider.read(candidate, {
            messageRoles: [...task.request.messageRoles!], forceRefresh: task.request.forceRefresh,
            allowPartialSource: task.request.purpose !== "prepare",
            deadlineAt: runtime.deadlineAt,
            isCancelled: () => stopped(runtime),
            onProgress: progress => {
                if (!accepting || cancelled(runtime)) return;
                if (Number.isFinite(progress.bytes) && progress.bytes! >= 0) runtime.currentSourceBytes = Math.max(runtime.currentSourceBytes, progress.bytes!);
                runtime.progress = { ...progress, source: candidate.source, conversationId: candidate.id };
                notify(runtime);
            },
            onChunk: chunk => {
                if (!accepting || cancelled(runtime)) return Promise.resolve();
                const work = queue.then(async () => {
                    if (streamError || cancelled(runtime)) return;
                    validateProjection({ ...chunk, complete: false }, candidate);
                    if (Number.isFinite(chunk.sourceBytes) && chunk.sourceBytes! >= 0) sourceBytes = chunk.sourceBytes!;
                    runtime.currentSourceBytes = Math.max(runtime.currentSourceBytes, sourceBytes);
                    runtime.progress = { ...runtime.progress, phase: task.request.purpose === "prepare" ? "preparing" : "query_stream",
                        source: candidate.source, conversationId: candidate.id, bytes: sourceBytes };
                    if (task.request.purpose === "prepare") { notify(runtime); return; }
                    for (const warning of chunk.warnings) warnings.add(warning);
                    const revision = /^pending(?:[:/-]|$)/u.test(chunk.revision) ? chunk.revision : `pending:${chunk.revision}`;
                    accumulator ??= new CorpusSearchAccumulator(chunk.conversation, task.request, { ...chunk, revision });
                    const computeStart = performance.now();
                    if (chunk.replaceFromRound !== undefined) accumulator.replaceFromRound(chunk.replaceFromRound, chunk.messages, { revision });
                    else {
                        Object.assign(accumulator.source, { revision });
                        for (const message of chunk.messages) accumulator.append(message);
                    }
                    task.state.computeMs += performance.now() - computeStart;
                    dirty = true;
                    if (cancelled(runtime)) return;
                    if (Date.now() - lastCommit >= 250) { clearFlush(); await flush(); }
                    else if (!flushTimer) flushTimer = setTimeout(() => {
                        flushTimer = undefined;
                        queue = queue.then(flush).catch(error => { streamError = error; });
                    }, Math.max(1, 250 - (Date.now() - lastCommit)));
                });
                queue = work.catch(error => { streamError = error; });
                return work;
            },
        });
        accepting = false;
        clearFlush();
        await queue;
        if (streamError) throw streamError;
        return projection;
    } finally {
        accepting = false;
        clearFlush();
        await queue;
        if (cancelled(runtime)) await retractUnverified(runtime, candidate);
        if (runtime.settleRead === settle) runtime.settleRead = undefined;
    }
}

async function executeSearch(runtime: CorpusRuntime, provider: CorpusProvider): Promise<void> {
    const task = runtime.task;
    type CachedRead = { projection: CorpusProjection | null } | { error: unknown };
    const prefetched = new Map<string, Promise<void>>();
    const completedPrefetch: Array<{ candidateId: string; cached: CachedRead }> = [];
    let wakePrefetch: (() => void) | undefined;
    let stopPrefetch = false;
    const publishPrefetch = (candidateId: string, cached: CachedRead): void => {
        if (stopPrefetch) return;
        completedPrefetch.push({ candidateId, cached });
        const wake = wakePrefetch;
        wakePrefetch = undefined;
        wake?.();
    };
    const settlePrefetch = async (): Promise<void> => {
        stopPrefetch = true;
        await Promise.all(prefetched.values());
        prefetched.clear();
        completedPrefetch.length = 0;
        wakePrefetch = undefined;
    };
    try {
        for (const record of [...task.records.values()]) {
            if (corpusSemanticVersionsEqual(record.semanticVersion, task.state.semanticVersion)) continue;
            await commitConversation(runtime, { source: corpusCommitSource(record), conversationId: record.conversationId, complete: false, result: null,
                scannedMessages: 0, mirrorMessagesSkipped: 0, sourceBytes: 0, warnings: ["Semantic version changed; source revalidation pending"] });
        }
        if (!task.state.discoveryComplete || task.state.sourceStatuses?.some(status => status.status !== "ok")) {
            runtime.progress = { phase: "listing" };
            let candidates: CorpusConversation[];
            try { candidates = await provider.list(JSON.parse(JSON.stringify(task.request)), { deadlineAt: runtime.deadlineAt, isCancelled: () => stopped(runtime) }); }
            catch (error) {
                captureSourceStatuses(task, provider);
                if (!provider.sourceStatuses) task.state.sourceStatuses = task.state.sourceStatuses!.map(status => ({ ...status, status: "error", error: messageOf(error) }));
                await saveState(task);
                throw error;
            }
            captureSourceStatuses(task, provider, candidates);
            if (cancelled(runtime)) { await finishTask(task, "cancelled"); return; }
            if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || typeof candidate.id !== "string" || !candidate.id
                || !corpusTaskSources(task.request).includes(candidate.source) || typeof candidate.workspace !== "string"
                || (candidate.sourceWarnings !== undefined && (!Array.isArray(candidate.sourceWarnings) || candidate.sourceWarnings.some(warning => typeof warning !== "string"))))) throw new Error("Provider returned an invalid corpus candidate list");
            const byKey = new Map(task.candidates.map(candidate => [corpusConversationKey(candidate), candidate]));
            for (const candidate of candidates.filter(candidate => corpusConversationMatchesScope(candidate, task.request))) {
                const key = corpusConversationKey(candidate);
                byKey.set(key, { ...candidate, sourceWarnings: [...new Set([...(byKey.get(key)?.sourceWarnings ?? []), ...(candidate.sourceWarnings ?? [])])] });
            }
            task.candidates = [...byKey.values()].sort((left, right) => corpusConversationKey(left).localeCompare(corpusConversationKey(right)));
            if (task.request.purpose === "prepare" && task.candidates.length !== 1) throw new Error("Corpus preparation target was not found");
            await writeCorpusJson(path.join(task.directory, "candidates.json"), task.candidates);
            task.state.discoveryComplete = true;
            task.state.phase = "scanning";
            await saveState(task);
            notify(runtime);
            const failures = task.state.sourceStatuses!.filter(status => status.status === "error");
            if (task.request.sourceFailureMode === "fail" && failures.length) {
                throw new Error(failures.map(status => `${status.source}: ${status.error ?? "Source discovery failed"}`).join("; "));
            }
        }
        const pending = task.candidates.filter(candidate => {
            const committed = task.records.get(corpusConversationKey(candidate));
            return !(committed?.complete && corpusSemanticVersionsEqual(committed.semanticVersion, task.state.semanticVersion));
        }).sort((left, right) => (task.records.get(corpusConversationKey(left))?.revision ?? 0)
            - (task.records.get(corpusConversationKey(right))?.revision ?? 0));
        let nextPrefetch = 0;
        const bounded = [task.request.maxFiles, task.request.maxBytes, task.request.maxHits, task.request.deadlineMs].some(value => value !== undefined);
        const useCached = !bounded && Boolean(provider.readCached) && task.request.purpose !== "prepare" && !task.request.forceRefresh;
        const fillPrefetch = (): void => {
            if (!useCached) return;
            while (!stopPrefetch && !cancelled(runtime) && prefetched.size < 4 && nextPrefetch < pending.length) {
                const candidate = pending[nextPrefetch++]!;
                const cached = Promise.resolve().then(() => provider.readCached!(candidate, {
                    messageRoles: [...task.request.messageRoles!], isCancelled: () => stopPrefetch || cancelled(runtime),
                    allowPartialSource: task.request.purpose !== "prepare",
                })).then(projection => { publishPrefetch(corpusConversationKey(candidate), { projection }); },
                    error => { publishPrefetch(corpusConversationKey(candidate), { error }); });
                prefetched.set(corpusConversationKey(candidate), cached);
            }
        };
        const deferred = new Set<string>();
        const pendingById = new Map(pending.map(candidate => [corpusConversationKey(candidate), candidate]));
        const processCandidate = async (candidate: CorpusConversation, cached?: CachedRead): Promise<boolean> => {
            if (!canStartCandidate(runtime)) return false;
            runtime.processedConversations++;
            runtime.currentSourceBytes = 0;
            runtime.progress = { phase: "reading", source: candidate.source, conversationId: candidate.id };
            notify(runtime);
            try {
                if (cached && "error" in cached) throw cached.error;
                const projection = cached?.projection ?? await readProjection(runtime, provider, candidate);
                if (cancelled(runtime)) { await retractUnverified(runtime, candidate); return false; }
                validateProjection(projection, candidate);
                const identity = verifiedCorpusIdentity(projection.conversation);
                const verifiedIdentity = identity ? { ...identity, sourceRevision: projection.revision } : undefined;
                projection.conversation = { ...candidate, ...projection.conversation,
                    sourceWarnings: [...new Set([...(candidate.sourceWarnings ?? []), ...(projection.conversation.sourceWarnings ?? [])])] };
                projection.warnings = [...new Set([...(projection.conversation.sourceWarnings ?? []), ...projection.warnings])];
                runtime.progress = { phase: task.request.purpose === "prepare" ? "preparing" : "query", source: candidate.source, conversationId: candidate.id };
                await scanProjection(runtime, projection, candidate, verifiedIdentity);
                runtime.processedSourceBytes += Math.max(runtime.currentSourceBytes, projection.sourceBytes ?? 0);
                runtime.currentSourceBytes = 0;
                if (task.request.maxHits !== undefined) await flushCommits(runtime);
            } catch (error) {
                if (cancelled(runtime)) { await retractUnverified(runtime, candidate); return false; }
                if (budgetExceeded(runtime)) { await retractUnverified(runtime, candidate); return false; }
                runtime.processedSourceBytes += runtime.currentSourceBytes;
                runtime.currentSourceBytes = 0;
                await commitConversation(runtime, {
                    source: candidate.source, conversationId: candidate.id, complete: false,
                    result: null, scannedMessages: 0, mirrorMessagesSkipped: 0,
                    sourceBytes: 0, warnings: candidate.sourceWarnings ?? [], error: messageOf(error),
                });
                if (task.request.sourceFailureMode === "fail") throw error;
            }
            return true;
        };
        if (useCached) {
            fillPrefetch();
            while (!cancelled(runtime) && prefetched.size) {
                if (!completedPrefetch.length) await new Promise<void>(resolve => { wakePrefetch = resolve; });
                const { candidateId, cached } = completedPrefetch.shift()!;
                prefetched.delete(candidateId);
                fillPrefetch();
                if ("projection" in cached && !cached.projection) {
                    deferred.add(candidateId);
                    continue;
                }
                if (!await processCandidate(pendingById.get(candidateId)!, cached)) break;
            }
            await flushCommits(runtime);
        }
        for (const candidate of pending) {
            if (useCached && !deferred.has(corpusConversationKey(candidate))) continue;
            if (cancelled(runtime) || !await processCandidate(candidate)) break;
        }
        await settlePrefetch();
        await flushCommits(runtime);
        budgetExceeded(runtime);
        recordBudgetStop(runtime);
        const complete = corpusCoverage(task).complete;
        if (complete) task.state.error = undefined;
        await finishTask(task, cancelled(runtime) ? "cancelled" : complete ? "completed" : "partial");
    } catch (error) {
        await settlePrefetch();
        try { await flushCommits(runtime); } catch (commitError) { error = commitError; }
        task.state.error = messageOf(error);
        budgetExceeded(runtime);
        recordBudgetStop(runtime);
        await finishTask(task, cancelled(runtime) ? "cancelled" : budgetExceeded(runtime) ? "partial" : "failed");
    } finally {
        await settlePrefetch();
        if (runtime.commitTimer) clearTimeout(runtime.commitTimer);
        await runtime.commitQueue;
        runtime.pendingCommits.length = 0;
        runtime.progress = undefined;
        notify(runtime);
        await runtime.release();
        runtimes.delete(task.directory);
    }
}

function run(task: CorpusTaskLoaded, provider: CorpusProvider, release: () => Promise<void>): void {
    const runtime: CorpusRuntime = { task, cancelled: false, lastCancelCheck: 0, lastStateSave: Date.now(), waiters: new Set(), release,
        pendingCommits: [], pendingCommitBytes: 0, processedConversations: 0, processedSourceBytes: 0, currentSourceBytes: 0,
        initialMatchingConversations: [...task.records.values()].filter(record => record.result).length,
        deadlineAt: task.request.deadlineMs === undefined ? undefined : Date.now() + task.request.deadlineMs };
    runtimes.set(task.directory, runtime);
    runtime.promise = executeSearch(runtime, provider).catch(error => {
        task.state.status = "failed";
        task.state.phase = "idle";
        task.state.error = `Corpus task persistence failed: ${messageOf(error)}`;
        notify(runtime);
    });
}

async function acquireSearchLease(directory: string, options: CorpusSearchIdentity, request: CorpusSearchRequest): Promise<() => Promise<void>> {
    const release = await acquireCorpusLease(directory);
    if (request.purpose !== "prepare") return release;
    try {
        const execution = path.join(corpusPreparationDirectory({ ...options, conversationId: request.conversationIds![0]!, source: corpusTaskSources(request)[0]! }), "execution");
        await fsp.mkdir(execution, { recursive: true });
        const deadline = Date.now() + 500;
        for (;;) {
            try {
                const releasePreparation = await acquireCorpusLease(execution);
                return async () => { try { await release(); } finally { await releasePreparation(); } };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "CORPUS_TASK_RUNNING" || Date.now() >= deadline) throw error;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    } catch (error) { await release(); throw error; }
}

export async function startCorpusSearch(options: StartCorpusSearchOptions): Promise<CorpusSearchStatus> {
    corpusOwnerHash(options.ownerId);
    const request = compileCorpusSearch(options.request).request;
    request.dataChains = resolveCorpusSources({ dataChains: request.dataChains });
    request.sourceFailureMode ??= "warn";
    const semantics = semanticVersion(options.provider);
    const every = options.checkpointEveryMessages ?? 256;
    const interval = options.checkpointIntervalMs ?? 250;
    const commitBatchSize = options.commitBatchSize ?? 1;
    if (!Number.isInteger(every) || every < 1 || every > 65536 || !Number.isFinite(interval) || interval < 0 || interval > 10000) {
        throw new Error("Invalid corpus checkpoint policy");
    }
    if (!Number.isInteger(commitBatchSize) || commitBatchSize < 1 || commitBatchSize > 32) throw new Error("Invalid corpus commit batch size");
    const taskId = `corpus-${crypto.randomUUID()}`;
    const directory = corpusTaskDirectory({ ...options, taskId });
    await fsp.mkdir(path.join(directory, "commits"), { recursive: true });
    const release = await acquireSearchLease(directory, { ...options, taskId }, request);
    try {
        const now = new Date().toISOString();
        const state: CorpusTaskStoredState = {
            version: 1, taskId, ownerId: options.ownerId, requestHash: crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex"),
            secret: crypto.randomBytes(32).toString("hex"), status: "running", phase: "listing", revision: 0,
            discoveryComplete: false, createdAt: now, updatedAt: now, checkpointEveryMessages: every, checkpointIntervalMs: interval, computeMs: 0,
            semanticVersion: semantics, commitBatchSize, dataChains: request.dataChains,
        };
        const task: CorpusTaskLoaded = { directory, state, request, candidates: [], records: new Map(), commits: [] };
        await writeCorpusJson(path.join(directory, "request.json"), request);
        await saveState(task);
        run(task, options.provider, release);
        return getCorpusSearchStatus({ ownerId: options.ownerId, taskId, root: options.root });
    } catch (error) { await release(); throw error; }
}

async function statusTask(options: CorpusSearchIdentity, preferSnapshot = false): Promise<CorpusTaskLoaded> {
    const directory = corpusTaskDirectory(options);
    const task = runtimes.get(directory)?.task ?? await loadCorpusTask(options, preferSnapshot);
    validateSourceBinding(task, options);
    return task;
}

export async function getCorpusSearchStatus(options: CorpusSearchStatusOptions): Promise<CorpusSearchStatus> {
    const limit = options.limit ?? 20;
    const waitMs = options.waitMs ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
    if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 45000) throw new Error("waitMs must be between 0 and 45000");
    if (options.cursor && options.afterRevision !== undefined) throw corpusTaskError("CORPUS_CURSOR_INVALID", "Use cursor or afterRevision, not both");
    let task = await statusTask(options, true);
    if (options.afterRevision !== undefined && (!Number.isInteger(options.afterRevision) || options.afterRevision < 0 || options.afterRevision > task.state.revision)) {
        throw corpusTaskError("CORPUS_REVISION_INVALID", "afterRevision is outside the committed task history");
    }
    const runtime = runtimes.get(task.directory);
    if (waitMs && runtime && !isTerminal(task.state.status) && (options.afterRevision ?? task.state.revision) === task.state.revision) {
        await new Promise<void>(resolve => {
            const timer = setTimeout(wake, waitMs);
            function wake(): void { clearTimeout(timer); runtime!.waiters.delete(wake); resolve(); }
            runtime.waiters.add(wake);
        });
        task = await statusTask(options, true);
    }
    let results = sortCorpusMatches(corpusResultRecords(task).flatMap(record => record.result ? [record.result] : []), task.request.sort);
    const semantics = task.state.semanticVersion ?? { query: null, provider: null };
    let viewSemanticVersion = semantics;
    let prepared = preparedEvidence(task);
    let coverage = corpusCoverage(task);
    let viewRevision = task.state.revision;
    let snapshotId = task.state.snapshotId;
    let snapshotHash = task.state.snapshotHash;
    let snapshotStatus: CorpusTaskState | undefined;
    let offset = 0;
    if (options.cursor) ({ snapshotId, snapshotHash, offset } = parseCorpusCursor(task, options.cursor));
    if (snapshotId) {
        const snapshot = await readCorpusJson<CorpusTaskSnapshot>(path.join(task.directory, "snapshots", `${snapshotId}.json`), snapshotHash);
        if (snapshot.snapshotId !== snapshotId || !Number.isInteger(snapshot.revision) || snapshot.revision > task.state.revision) {
            throw corpusTaskError("CORPUS_CURSOR_INVALID", "Final snapshot identity or revision is invalid");
        }
        results = snapshot.results.map(result => ({ ...result, snippets: result.snippets.map(snippet => ({
            ...snippet, source: result.conversation.source, conversationId: result.conversation.id, canonicalId: result.conversation.canonicalId,
        })) }));
        if (snapshot.coverage.sourceStatuses === undefined && JSON.stringify(corpusTaskSources(task.request)) !== '["codex"]') {
            throw corpusTaskError("CORPUS_TASK_CORRUPT", "Multi-source snapshot is missing source coverage");
        }
        coverage = { ...snapshot.coverage, sourceStatuses: snapshot.coverage.sourceStatuses ?? [{
            source: "codex", status: snapshot.coverage.complete ? "ok" : "partial", candidateCount: snapshot.coverage.candidateConversations, warnings: snapshot.coverage.warnings,
        }] };
        validateCorpusSourceStatuses(coverage.sourceStatuses, corpusTaskSources(task.request));
        if (coverage.sourceStatuses.length !== corpusTaskSources(task.request).length) throw corpusTaskError("CORPUS_TASK_CORRUPT", "Snapshot source coverage is incomplete");
        viewRevision = snapshot.revision;
        snapshotStatus = snapshot.status;
        viewSemanticVersion = snapshot.semanticVersion ?? { query: null, provider: null };
        prepared = snapshot.prepared ? { ...snapshot.prepared, source: snapshot.prepared.source ?? "codex" } : undefined;
        snapshotHash ??= crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
        if (offset > results.length) throw corpusTaskError("CORPUS_CURSOR_INVALID", "Cursor offset is outside the final snapshot");
    }
    const currentRuntime = runtimes.get(task.directory);
    const status = !isTerminal(task.state.status) && task.state.status !== "resumable"
        && (currentRuntime?.cancelled || fs.existsSync(path.join(task.directory, "cancel.json"))) ? "cancelling" : task.state.status;
    const response: CorpusSearchStatus = {
        taskId: task.state.taskId, ownerId: task.state.ownerId, status, phase: task.state.phase, revision: task.state.revision,
        viewRevision, request: JSON.parse(JSON.stringify(task.request)), results: results.slice(offset, offset + limit),
        semanticVersion: semantics, viewSemanticVersion, prepared,
        totalMatches: results.length, hasMore: offset + limit < results.length,
        nextCursor: snapshotId && offset + limit < results.length ? corpusCursor(task, snapshotId, offset + limit, snapshotHash!) : undefined,
        snapshotId, snapshotStatus, coverage, progress: currentRuntime?.progress,
        timings: { queryComputeMs: task.state.computeMs, taskWallMs: Math.max(0, (isTerminal(task.state.status) ? Date.parse(task.state.updatedAt) : Date.now()) - Date.parse(task.state.createdAt)) },
        error: task.state.error,
    };
    if (options.afterRevision !== undefined) {
        const throughRevision = Math.min(task.state.revision, options.afterRevision + limit);
        let page: CorpusTaskCommit[];
        if (task.commits.length === task.state.revision) page = task.commits.slice(options.afterRevision, throughRevision);
        else {
            try {
                page = await readCorpusTaskCommitRange(task, options.afterRevision + 1, throughRevision);
            } catch { throw corpusTaskError("CORPUS_TASK_CORRUPT", "Requested corpus revision history is missing or invalid"); }
        }
        const changed = new Map(page.filter(commit => commit.changed).map(commit => [corpusCommitKey(commit), commit]));
        const removed = [...changed.values()].filter(commit => !commit.result || !corpusSemanticVersionsEqual(commit.semanticVersion, task.state.semanticVersion));
        response.changes = {
            upserts: [...changed.values()].flatMap(commit => commit.result && corpusSemanticVersionsEqual(commit.semanticVersion, task.state.semanticVersion) ? [commit.result] : []),
            removedConversationIds: corpusTaskSources(task.request).length === 1 ? removed.map(commit => commit.conversationId) : [],
            removedConversations: removed.map(commit => ({ source: corpusCommitSource(commit), conversationId: commit.conversationId })),
            removedConversationKeys: removed.map(corpusCommitKey),
            throughRevision, hasMore: throughRevision < task.state.revision,
        };
    }
    return JSON.parse(JSON.stringify(response)) as CorpusSearchStatus;
}

export async function cancelCorpusSearch(options: CorpusSearchIdentity): Promise<CorpusSearchStatus> {
    let task = await statusTask(options);
    if (isTerminal(task.state.status)) return getCorpusSearchStatus(options);
    await writeCorpusJson(path.join(task.directory, "cancel.json"), { requestedAt: new Date().toISOString() });
    const runtime = runtimes.get(task.directory);
    if (runtime) { runtime.cancelled = true; await runtime.settleRead?.(); notify(runtime); }
    else if (task.state.status === "resumable") {
        const release = await acquireCorpusLease(task.directory);
        try { task = await loadCorpusTask(options); await finishTask(task, "cancelled"); }
        finally { await release(); }
    }
    return getCorpusSearchStatus(options);
}

export async function resumeCorpusSearch(options: CorpusSearchIdentity & { provider: CorpusProvider }): Promise<CorpusSearchStatus> {
    let task = await statusTask(options);
    const semantics = semanticVersion(options.provider);
    if (task.state.status === "completed" && corpusSemanticVersionsEqual(task.state.semanticVersion, semantics)) return getCorpusSearchStatus(options);
    const existing = runtimes.get(task.directory);
    if (existing) {
        if (!isTerminal(existing.task.state.status)) throw corpusTaskError("CORPUS_TASK_RUNNING", "Corpus task is already running");
        await existing.promise;
    }
    const release = await acquireSearchLease(task.directory, options, task.request);
    try {
        task = await loadCorpusTask(options);
        if (task.state.status === "completed" && corpusSemanticVersionsEqual(task.state.semanticVersion, semantics)) { await release(); return getCorpusSearchStatus(options); }
        task.state.semanticVersion = semantics;
        task.state.status = "running";
        task.state.phase = task.state.discoveryComplete ? "scanning" : "listing";
        task.state.error = undefined;
        task.state.snapshotId = undefined;
        task.state.snapshotHash = undefined;
        await fsp.rm(path.join(task.directory, "cancel.json"), { force: true });
        await saveState(task);
        run(task, options.provider, release);
        return getCorpusSearchStatus(options);
    } catch (error) { await release(); throw error; }
}
