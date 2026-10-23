import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import type { CorpusConversation, CorpusProvider, CorpusProjection, CorpusSearchRequest } from "./conversation-corpus-types.js";
import {
    compileCorpusSearch, CorpusSearchAccumulator, corpusConversationMatchesScope, sortCorpusMatches, CORPUS_QUERY_SEMANTIC_VERSION,
    type CorpusConversationMatch,
} from "./conversation-corpus-search.js";
import {
    acquireCorpusLease, corpusCoverage, corpusCurrentRecords, corpusCursor, corpusOwnerDirectory, corpusOwnerHash, corpusTaskDirectory, corpusTaskError,
    corpusSemanticVersionsEqual,
    loadCorpusTask, parseCorpusCursor, readCorpusJson, readCorpusTaskCommitRange, writeCorpusJson, writeCorpusTaskCommits,
    type CorpusTaskCommit, type CorpusTaskCoverage, type CorpusTaskLoaded, type CorpusTaskSnapshot,
    type CorpusTaskState, type CorpusTaskStoredState, type CorpusSemanticVersion, type CorpusPreparedEvidence,
} from "./conversation-corpus-task-store.js";

export type { CorpusTaskCoverage, CorpusTaskState } from "./conversation-corpus-task-store.js";
export type { CorpusConversationMatch, CorpusMatchSnippet } from "./conversation-corpus-search.js";

export interface CorpusSearchIdentity { ownerId: string; taskId: string; root?: string; }
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
        throughRevision: number;
        hasMore: boolean;
    };
    progress?: { conversationId?: string; phase: string; bytes?: number; totalBytes?: number };
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
        const previous = staged.get(entry.conversationId) ?? task.records.get(entry.conversationId);
        const commit: CorpusTaskCommit = {
            ...entry, revision: task.state.revision + index + 1,
            queryComputeMs: task.state.computeMs, semanticVersion: task.state.semanticVersion,
            changed: JSON.stringify(previous?.result ?? null) !== JSON.stringify(entry.result),
        };
        staged.set(entry.conversationId, commit);
        return commit;
    });
    await writeCorpusTaskCommits(task, commits);
    for (const commit of commits) task.records.set(commit.conversationId, commit);
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
        results: sortCorpusMatches(corpusCurrentRecords(task).flatMap(record => record.result ? [record.result] : []), task.request.sort),
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
    return record?.prepared ? { ...record.prepared, commitPath: path.join(task.directory, "commits", `${String(record.revision).padStart(12, "0")}.json`) } : undefined;
}

function semanticVersion(provider: CorpusProvider): CorpusSemanticVersion {
    if (provider.semanticVersion !== undefined && (typeof provider.semanticVersion !== "string" || !provider.semanticVersion.trim())) {
        throw new Error("Provider semanticVersion must be a nonempty string when specified");
    }
    return { query: CORPUS_QUERY_SEMANTIC_VERSION, provider: provider.semanticVersion ?? null };
}

function validateProjection(projection: CorpusProjection, conversationId: string): void {
    if (!projection || projection.conversation?.id !== conversationId || projection.conversation.source !== "codex"
        || typeof projection.revision !== "string" || !projection.revision || !Array.isArray(projection.messages)
        || typeof projection.complete !== "boolean" || !Array.isArray(projection.warnings)
        || projection.warnings.some(warning => typeof warning !== "string")) {
        throw new Error("Provider returned an invalid corpus projection or a different conversation");
    }
    if (projection.complete && /^pending(?:[:/-]|$)/u.test(projection.revision)) throw new Error("A complete projection requires a verified source revision");
}

async function scanProjection(runtime: CorpusRuntime, projection: CorpusProjection): Promise<void> {
    const task = runtime.task;
    const sourceBytes = Number.isFinite(projection.sourceBytes) && projection.sourceBytes! >= 0 ? projection.sourceBytes! : 0;
    if (task.request.purpose === "prepare") {
        if (projection.messages.some(message => !message || typeof message.id !== "string" || !message.id
            || !Number.isInteger(message.round) || message.round < 1 || typeof message.text !== "string"
            || !task.request.messageRoles!.includes(message.role))) throw new Error("Provider returned invalid preparation messages");
        if (!cancelled(runtime)) await commitConversation(runtime, {
            conversationId: projection.conversation.id, complete: projection.complete, result: null,
            scannedMessages: projection.messages.length, mirrorMessagesSkipped: 0, sourceBytes, warnings: projection.warnings,
            prepared: { kind: "conversation_body_projection", conversationId: projection.conversation.id,
                sourceRevision: projection.revision, cacheGeneration: projection.cacheGeneration, complete: projection.complete, sourceBytes },
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
            conversationId: projection.conversation.id, complete, result,
            scannedMessages: accumulator.scannedMessages, mirrorMessagesSkipped: accumulator.mirrorMessagesSkipped,
            sourceBytes, warnings: projection.warnings,
        }, defer);
        lastCheckpoint = Date.now();
    };
    for (let offset = 0; offset < projection.messages.length;) {
        if (cancelled(runtime)) return;
        const end = Math.min(projection.messages.length, offset + task.state.checkpointEveryMessages);
        const computeStart = performance.now();
        for (; offset < end; offset++) accumulator.append(projection.messages[offset]);
        task.state.computeMs += performance.now() - computeStart;
        if (offset < projection.messages.length) {
            if (Date.now() - lastCheckpoint >= task.state.checkpointIntervalMs) await commit(false);
            await yieldImmediate();
        }
    }
    if (!cancelled(runtime)) await commit(projection.complete, true);
}

async function retractUnverified(runtime: CorpusRuntime, conversationId: string): Promise<void> {
    if (!runtime.task.records.get(conversationId)?.unverified) return;
    await commitConversation(runtime, { conversationId, complete: false, result: null,
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
    const warnings = new Set<string>();
    let dirty = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const clearFlush = (): void => { if (flushTimer) clearTimeout(flushTimer); flushTimer = undefined; };
    const flush = async (): Promise<void> => {
        if (!accepting || !dirty || !accumulator || cancelled(runtime)) return;
        const snapshotStart = performance.now();
        const result = accumulator.snapshot(false);
        task.state.computeMs += performance.now() - snapshotStart;
        if (result) result.warnings = [...warnings];
        dirty = false;
        await commitConversation(runtime, { conversationId: candidate.id, complete: false, result,
            scannedMessages: accumulator.scannedMessages, mirrorMessagesSkipped: accumulator.mirrorMessagesSkipped,
            sourceBytes, warnings: [...warnings], unverified: true });
        lastCommit = Date.now();
    };
    const settle = async (): Promise<void> => { clearFlush(); await queue; await retractUnverified(runtime, candidate.id); };
    runtime.settleRead = settle;
    try {
        const projection = await provider.read(candidate, {
            messageRoles: [...task.request.messageRoles!], forceRefresh: task.request.forceRefresh,
            isCancelled: () => cancelled(runtime),
            onProgress: progress => {
                if (!accepting || cancelled(runtime)) return;
                runtime.progress = { ...progress, conversationId: candidate.id };
                notify(runtime);
            },
            onChunk: chunk => {
                if (!accepting || cancelled(runtime)) return Promise.resolve();
                const work = queue.then(async () => {
                    if (streamError || cancelled(runtime)) return;
                    validateProjection({ ...chunk, complete: false }, candidate.id);
                    if (Number.isFinite(chunk.sourceBytes) && chunk.sourceBytes! >= 0) sourceBytes = chunk.sourceBytes!;
                    runtime.progress = { ...runtime.progress, phase: task.request.purpose === "prepare" ? "preparing" : "query_stream",
                        conversationId: candidate.id, bytes: sourceBytes };
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
        if (cancelled(runtime)) await retractUnverified(runtime, candidate.id);
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
            await commitConversation(runtime, { conversationId: record.conversationId, complete: false, result: null,
                scannedMessages: 0, mirrorMessagesSkipped: 0, sourceBytes: 0, warnings: ["Semantic version changed; source revalidation pending"] });
        }
        if (!task.state.discoveryComplete) {
            runtime.progress = { phase: "listing" };
            const candidates = await provider.list(JSON.parse(JSON.stringify(task.request)), { isCancelled: () => cancelled(runtime) });
            if (cancelled(runtime)) { await finishTask(task, "cancelled"); return; }
            if (!Array.isArray(candidates) || candidates.some(candidate => !candidate || typeof candidate.id !== "string" || !candidate.id
                || candidate.source !== "codex" || typeof candidate.workspace !== "string")) throw new Error("Provider returned an invalid corpus candidate list");
            task.candidates = [...new Map(candidates.filter(candidate => corpusConversationMatchesScope(candidate, task.request))
                .map(candidate => [candidate.id, { ...candidate }])).values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
            if (task.request.purpose === "prepare" && task.candidates.length !== 1) throw new Error("Corpus preparation target was not found");
            await writeCorpusJson(path.join(task.directory, "candidates.json"), task.candidates);
            task.state.discoveryComplete = true;
            task.state.phase = "scanning";
            await saveState(task);
            notify(runtime);
        }
        const pending = task.candidates.filter(candidate => {
            const committed = task.records.get(candidate.id);
            return !(committed?.complete && corpusSemanticVersionsEqual(committed.semanticVersion, task.state.semanticVersion));
        });
        let nextPrefetch = 0;
        const useCached = Boolean(provider.readCached) && task.request.purpose !== "prepare" && !task.request.forceRefresh;
        const fillPrefetch = (): void => {
            if (!useCached) return;
            while (!stopPrefetch && !cancelled(runtime) && prefetched.size < 4 && nextPrefetch < pending.length) {
                const candidate = pending[nextPrefetch++]!;
                const cached = Promise.resolve().then(() => provider.readCached!(candidate, {
                    messageRoles: [...task.request.messageRoles!], isCancelled: () => stopPrefetch || cancelled(runtime),
                })).then(projection => { publishPrefetch(candidate.id, { projection }); },
                    error => { publishPrefetch(candidate.id, { error }); });
                prefetched.set(candidate.id, cached);
            }
        };
        const deferred = new Set<string>();
        const pendingById = new Map(pending.map(candidate => [candidate.id, candidate]));
        const processCandidate = async (candidate: CorpusConversation, cached?: CachedRead): Promise<boolean> => {
            runtime.progress = { phase: "reading", conversationId: candidate.id };
            notify(runtime);
            try {
                if (cached && "error" in cached) throw cached.error;
                const projection = cached?.projection ?? await readProjection(runtime, provider, candidate);
                if (cancelled(runtime)) { await retractUnverified(runtime, candidate.id); return false; }
                validateProjection(projection, candidate.id);
                runtime.progress = { phase: task.request.purpose === "prepare" ? "preparing" : "query", conversationId: candidate.id };
                await scanProjection(runtime, projection);
            } catch (error) {
                if (cancelled(runtime)) { await retractUnverified(runtime, candidate.id); return false; }
                await commitConversation(runtime, {
                    conversationId: candidate.id, complete: false,
                    result: null, scannedMessages: 0, mirrorMessagesSkipped: 0,
                    sourceBytes: 0, warnings: [], error: messageOf(error),
                });
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
            if (useCached && !deferred.has(candidate.id)) continue;
            if (cancelled(runtime) || !await processCandidate(candidate)) break;
        }
        await settlePrefetch();
        await flushCommits(runtime);
        await finishTask(task, cancelled(runtime) ? "cancelled" : corpusCoverage(task).complete ? "completed" : "partial");
    } catch (error) {
        await settlePrefetch();
        try { await flushCommits(runtime); } catch (commitError) { error = commitError; }
        task.state.error = messageOf(error);
        await finishTask(task, cancelled(runtime) ? "cancelled" : "failed");
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
        pendingCommits: [], pendingCommitBytes: 0 };
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
        const execution = path.join(corpusOwnerDirectory(options), "preparations",
            crypto.createHash("sha256").update(request.conversationIds![0]).digest("hex"), "execution");
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
            semanticVersion: semantics, commitBatchSize,
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
    return runtimes.get(directory)?.task ?? loadCorpusTask(options, preferSnapshot);
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
    let results = sortCorpusMatches(corpusCurrentRecords(task).flatMap(record => record.result ? [record.result] : []), task.request.sort);
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
        results = snapshot.results;
        coverage = snapshot.coverage;
        viewRevision = snapshot.revision;
        snapshotStatus = snapshot.status;
        viewSemanticVersion = snapshot.semanticVersion ?? { query: null, provider: null };
        prepared = snapshot.prepared;
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
        const changed = new Map(page.filter(commit => commit.changed).map(commit => [commit.conversationId, commit]));
        response.changes = {
            upserts: [...changed.values()].flatMap(commit => commit.result && corpusSemanticVersionsEqual(commit.semanticVersion, task.state.semanticVersion) ? [commit.result] : []),
            removedConversationIds: [...changed.values()].filter(commit => !commit.result || !corpusSemanticVersionsEqual(commit.semanticVersion, task.state.semanticVersion)).map(commit => commit.conversationId),
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
