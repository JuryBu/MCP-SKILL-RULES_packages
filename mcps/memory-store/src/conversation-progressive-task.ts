import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ROOT } from "./store.js";
import {
    cancelBackgroundTask, getBackgroundTask, registerBackgroundTaskRecoveryHandler,
    checkpointBackgroundTaskResumePayload, suspendBackgroundTask,
    startBackgroundTask, stableJsonHash, type BackgroundTask, type BackgroundTaskContext,
} from "./background-tasks.js";
import { acquireCorpusLease } from "./conversation-corpus-task-store.js";
import { withConversationSourcePressure } from "./conversation-source-pressure.js";
import { openProgressiveCache, ProgressiveCacheError } from "./conversation-progressive-cache.js";
import { runProgressiveWorker } from "./conversation-progressive-worker-client.js";
import {
    isProgressiveRequest, isProgressiveTaskPayload, type ProgressiveReadyState,
    type ProgressiveRequest, type ProgressiveTaskPayload,
} from "./conversation-progressive-task-types.js";

interface TaskRecord { version: 1; payload: ProgressiveTaskPayload; attempt: number; backgroundTaskId: string }
export interface ProgressiveTaskIdentity { ownerId: string; taskId: string; root?: string }
const running = new Map<string, Promise<string>>();
const starts = new Map<string, Promise<unknown>>();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

function ownerDirectory(ownerId: string, root = path.join(DATA_ROOT, "progressive-tasks")): string {
    if (!ownerId?.trim() || ownerId.length > 4096) throw new Error("A stable owner conversationId is required");
    return path.resolve(root, hash(ownerId));
}

function taskDirectory(identity: ProgressiveTaskIdentity): string {
    if (!/^progressive-[a-f0-9-]{36}$/.test(identity.taskId)) throw new Error("Invalid progressive taskId");
    return path.join(ownerDirectory(identity.ownerId, identity.root), identity.taskId);
}

async function rejectLinks(filename: string): Promise<void> {
    let current = path.resolve(filename);
    for (;;) {
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) throw new ProgressiveCacheError("unsafe_path", "Progressive task paths must not contain symlinks");
        } catch (error) { if (!missing(error)) throw error; }
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

async function readJson<Value>(filename: string): Promise<Value> {
    await rejectLinks(filename);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid progressive task state");
    try { return JSON.parse(await fs.readFile(filename, "utf8")) as Value; }
    catch (error) {
        if (error instanceof SyntaxError) throw new ProgressiveCacheError("corrupt_cache", "Invalid progressive task JSON");
        throw error;
    }
}

export async function writeProgressiveState(filename: string, value: unknown): Promise<void> {
    await rejectLinks(filename);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = filename + "." + randomUUID() + ".tmp";
    const handle = await fs.open(temporary, "wx");
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, filename); return; }
        catch (error) {
            if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code || "")) {
                await fs.rm(temporary, { force: true });
                throw error;
            }
            await sleep(10 * 2 ** attempt);
        }
    }
}

async function recordFor(identity: ProgressiveTaskIdentity): Promise<TaskRecord> {
    const directory = taskDirectory(identity);
    const record = await readJson<TaskRecord>(path.join(directory, "request.json"));
    if (record.version !== 1 || !isProgressiveTaskPayload(record.payload)
        || record.payload.request.ownerId !== identity.ownerId || record.payload.taskId !== identity.taskId
        || path.resolve(record.payload.directory) !== path.resolve(directory)
        || !Number.isSafeInteger(record.attempt) || record.attempt < 1
        || record.backgroundTaskId !== identity.taskId + "-" + record.attempt) throw new Error("Progressive task owner or state mismatch");
    return record;
}

async function runRegisteredWorker(record: TaskRecord, context: BackgroundTaskContext): Promise<string> {
    const { payload } = record;
    if (running.has(payload.taskId)) throw new Error("Cancellation cleanup is still running; keep the original taskId");
    const phase = payload.phase ?? "initial";
    const deadlineAt = phase === "initial" ? payload.initialDeadlineAt : undefined;
    const work = withConversationSourcePressure(phase === "initial" ? "foreground" : "background", async () => {
        await readyFor(record);
        return runProgressiveWorker({ ...payload, phase }, context, { deadlineAt });
    }, { deadlineAt, shouldCancel: () => context.isCancelled() || context.isSettled(),
        timeoutMessage: "Initial progressive range deadline exceeded; published ranges remain readable" });
    running.set(payload.taskId, work);
    try {
        const result = await work;
        if (phase === "initial" && payload.request.buildFull && JSON.parse(result).continueFull === true) {
            if (context.isCancelled() || context.isSettled()) throw new Error("Progressive preparation cancelled before full-history continuation");
            record.payload = { ...payload, phase: "full" };
            await writeProgressiveState(path.join(payload.directory, "request.json"), record);
            checkpointBackgroundTaskResumePayload(context.taskId, record.payload);
            suspendBackgroundTask({ taskId: context.taskId, wakeAt: new Date(Date.now() + 1).toISOString(),
                ledgerRevision: record.attempt, waitingReason: "Initial range preparation finished; full history queued separately" });
        }
        return result;
    }
    finally { if (running.get(payload.taskId) === work) running.delete(payload.taskId); }
}

function launch(record: TaskRecord): BackgroundTask {
    return startBackgroundTask("conversation-progressive", context => runRegisteredWorker(record, context),
        { taskId: record.backgroundTaskId, resumePayload: record.payload, maxRunMs: 30 * 60 * 1000 });
}

registerBackgroundTaskRecoveryHandler("conversation-progressive", async task => {
    if (!isProgressiveTaskPayload(task.resumePayload)) throw new Error("Invalid progressive recovery payload");
    const payload = task.resumePayload;
    const expected = taskDirectory({ ownerId: payload.request.ownerId, taskId: payload.taskId });
    if (path.resolve(payload.directory) !== path.resolve(expected)) throw new Error("Progressive recovery path mismatch");
    const record = await recordFor({ ownerId: payload.request.ownerId, taskId: payload.taskId });
    if (record.backgroundTaskId !== task.id || stableJsonHash(record.payload.request) !== stableJsonHash(payload.request)) throw new Error("Progressive recovery attempt mismatch");
    task.resumePayload = JSON.parse(JSON.stringify(record.payload));
    task.resumeHash = stableJsonHash(record.payload);
    return { mode: "resume", run: context => runRegisteredWorker(record, context) };
});

export async function startProgressivePreparation(request: ProgressiveRequest, options: { root?: string } = {}): Promise<unknown> {
    if (!isProgressiveRequest(request)) throw new Error("Invalid progressive preparation request");
    request = { ...request, ownerId: request.ownerId.trim(), conversationId: request.conversationId.trim() };
    const owner = ownerDirectory(request.ownerId, options.root);
    const indexDirectory = path.join(owner, "requests", hash(JSON.stringify(request)));
    const existingStart = starts.get(indexDirectory);
    if (existingStart) return existingStart;
    const work = (async () => {
        await rejectLinks(indexDirectory);
        await fs.mkdir(indexDirectory, { recursive: true });
        const release = await acquireCorpusLease(indexDirectory);
        try {
            try {
                const previous = await readJson<{ taskId: string }>(path.join(indexDirectory, "current.json"));
                const record = await recordFor({ ownerId: request.ownerId, taskId: previous.taskId, ...options });
                const task = getBackgroundTask(record.backgroundTaskId);
                if (task?.status === "running" || task?.status === "suspended") {
                    return getProgressiveTaskStatus({ ownerId: request.ownerId, taskId: previous.taskId, ...options });
                }
            } catch (error) { if (!missing(error)) throw error; }
            const taskId = "progressive-" + randomUUID();
            const directory = taskDirectory({ ownerId: request.ownerId, taskId, ...options });
            const initialDeadlineAt = request.deadlineMs === undefined ? undefined : Date.now() + request.deadlineMs;
            if (initialDeadlineAt !== undefined && !Number.isSafeInteger(initialDeadlineAt)) throw new Error("Progressive deadlineMs exceeds the supported clock range");
            const payload: ProgressiveTaskPayload = { version: 1, taskId, directory, request, phase: "initial",
                initialDeadlineAt };
            const record: TaskRecord = { version: 1, payload, attempt: 1, backgroundTaskId: taskId + "-1" };
            await writeProgressiveState(path.join(directory, "request.json"), record);
            launch(record);
            await writeProgressiveState(path.join(indexDirectory, "current.json"), { taskId });
            return getProgressiveTaskStatus({ ownerId: request.ownerId, taskId, ...options });
        } finally { await release(); }
    })();
    starts.set(indexDirectory, work);
    try { return await work; }
    finally { if (starts.get(indexDirectory) === work) starts.delete(indexDirectory); }
}

async function readyFor(record: TaskRecord): Promise<ProgressiveReadyState | undefined> {
    let ready: ProgressiveReadyState;
    try { ready = await readJson<ProgressiveReadyState>(path.join(record.payload.directory, "ready.json")); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    if (ready?.version !== 1 || !Array.isArray(ready.previous) || typeof ready.phase !== "string"
        || typeof ready.updatedAt !== "string" || !Number.isFinite(Date.parse(ready.updatedAt))
        || typeof ready.requestedRangeComplete !== "boolean" || !Array.isArray(ready.warnings)
        || ready.warnings.some(warning => typeof warning !== "string")) throw new ProgressiveCacheError("corrupt_cache", "Invalid progressive ready state");
    for (const generation of [ready.current, ...ready.previous].filter(item => item !== undefined)) {
        if (!generation || typeof generation.directory !== "string") throw new ProgressiveCacheError("corrupt_cache", "Invalid progressive ready generation");
        const relative = path.relative(record.payload.directory, generation.directory);
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new ProgressiveCacheError("unsafe_path", "Progressive generation path mismatch");
        if (generation.source?.conversationId !== record.payload.request.conversationId || generation.source.host !== record.payload.request.dataChain) throw new ProgressiveCacheError("owner_mismatch", "Progressive ready source does not belong to this task");
        const manifest = path.join(generation.directory, "manifest.json");
        await rejectLinks(manifest);
        try {
            const directory = await fs.lstat(generation.directory);
            const file = await fs.lstat(manifest);
            if (!directory.isDirectory() || !file.isFile()) throw new ProgressiveCacheError("corrupt_cache", "Published progressive generation is not a regular cache");
        } catch (error) {
            if (missing(error)) throw new ProgressiveCacheError("corrupt_cache", "Published progressive generation is missing");
            throw error;
        }
    }
    return ready;
}

async function openReadyGeneration(generation: NonNullable<ProgressiveReadyState["current"]>) {
    try { return await openProgressiveCache({ root: generation.directory, source: generation.source }); }
    catch (error) {
        if (error instanceof SyntaxError) throw new ProgressiveCacheError("corrupt_cache", "Invalid progressive generation JSON");
        throw error;
    }
}

export async function getProgressiveTaskStatus(identity: ProgressiveTaskIdentity & { waitMs?: number; afterRevision?: string }): Promise<unknown> {
    if (identity.waitMs !== undefined && (!Number.isFinite(identity.waitMs) || identity.waitMs < 0)) throw new Error("Invalid progressive status waitMs");
    if (identity.afterRevision !== undefined && !/^[a-f0-9]{64}$/.test(identity.afterRevision)) throw new Error("Invalid progressive status afterRevision");
    const record = await recordFor(identity);
    const deadline = Date.now() + Math.min(45000, Math.max(0, identity.waitMs || 0));
    let afterRevision = identity.afterRevision;
    for (;;) {
        const task = getBackgroundTask(record.backgroundTaskId);
        const ready = await readyFor(record);
        const cache = ready?.current ? await openReadyGeneration(ready.current) : undefined;
        const status = cache ? await cache.status() : undefined;
        const cancellationPending = task?.status === "cancelled" && running.has(identity.taskId);
        const rangeAvailable = Boolean(status?.blocks.length);
        const partialFailure = rangeAvailable && task?.status === "error";
        const updatedAt = [ready?.updatedAt, task?.updatedAt].filter((value): value is string => Boolean(value))
            .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
        const revision = hash(JSON.stringify({ backgroundTaskId: record.backgroundTaskId, task, ready, version: status?.version, sourceKey: status?.sourceKey, running: running.has(identity.taskId) }));
        afterRevision ??= revision;
        if (revision !== afterRevision || (!cancellationPending && task?.status !== "running" && task?.status !== "suspended") || Date.now() >= deadline) return {
            taskId: identity.taskId, backgroundTaskId: record.backgroundTaskId, request: record.payload.request,
            status: partialFailure ? "partial" : task?.status || "unknown", phase: ready?.phase || task?.progress?.stage || "queued",
            progress: partialFailure && task?.progress ? { ...task.progress,
                detail: "完整历史准备已结束并返回错误，已经就绪的范围仍可使用", updatedAt: task.updatedAt } : task?.progress,
            error: partialFailure ? undefined : task?.error,
            preparationError: partialFailure ? task?.error : undefined,
            backgroundPreparation: { status: task?.status || "unknown", error: task?.error },
            updatedAt, revision,
            ready: status, requestedRangeComplete: ready?.requestedRangeComplete === true,
            fullSourceComplete: status?.complete === true, fullCacheGeneration: ready?.fullCacheGeneration,
            ...(ready?.fullFetchCache ? { fullFetchCache: { ...ready.fullFetchCache,
                next: { action: "read", conversationId: identity.ownerId, conversationIds: [ready.fullFetchCache.conversationId],
                    dataChain: record.payload.request.dataChain, source: "cache", cacheGeneration: ready.fullFetchCache.cacheGeneration,
                    link: record.payload.request.link || "reference", startRound: 1, endRound: Math.min(3, ready.fullFetchCache.roundCount) || 1 } } } : {}),
            rangeAvailable, cancellationPending,
            warnings: [...(ready?.warnings || []), ...(partialFailure ? [`PREPARATION_FAILED_WITH_READABLE_RANGE: ${task?.error}`] : [])],
            next: rangeAvailable
                ? { action: "read_ready", conversationId: identity.ownerId, dataChain: record.payload.request.dataChain, taskId: identity.taskId }
                : task?.status === "running" || task?.status === "suspended"
                    ? { action: "prepare_status", conversationId: identity.ownerId, dataChain: record.payload.request.dataChain, taskId: identity.taskId, waitSeconds: 1, afterProgressRevision: revision }
                    : task?.status === "cancelled"
                        ? { action: "prepare_resume", conversationId: identity.ownerId, dataChain: record.payload.request.dataChain, taskId: identity.taskId }
                        : undefined,
        };
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
}

export async function openProgressiveTaskCache(identity: ProgressiveTaskIdentity, ref?: string) {
    const record = await recordFor(identity);
    const ready = await readyFor(record);
    if (!ready) throw new Error("No range is ready yet; poll prepare_status with the same taskId");
    const generations = [ready.current, ...ready.previous].filter(item => item !== undefined);
    if (!generations.length) throw new Error("No range is ready yet; poll prepare_status with the same taskId");
    for (const generation of generations) {
        const cache = await openReadyGeneration(generation);
        if (!ref) return { cache, ready };
        try { const row = await cache.locate(ref); return { cache, ready, row }; }
        catch (error) {
            if (!["invalid_ref", "unpublished_ref"].includes((error as { code?: string }).code || "")) throw error;
        }
    }
    throw new ProgressiveCacheError("invalid_ref", "The range reference is not part of this task");
}

export async function cancelProgressivePreparation(identity: ProgressiveTaskIdentity): Promise<unknown> {
    const record = await recordFor(identity);
    cancelBackgroundTask(record.backgroundTaskId, "Progressive preparation cancelled; ready ranges retained");
    return getProgressiveTaskStatus(identity);
}

export async function resumeProgressivePreparation(identity: ProgressiveTaskIdentity & { deadlineMs?: number }): Promise<unknown> {
    const directory = taskDirectory(identity);
    await recordFor(identity);
    const release = await acquireCorpusLease(directory);
    try {
        const record = await recordFor(identity);
        const previous = getBackgroundTask(record.backgroundTaskId);
        if (previous?.status === "running" || previous?.status === "suspended") return getProgressiveTaskStatus(identity);
        if (running.has(identity.taskId)) throw new Error("Cancellation cleanup is still running; keep the original taskId");
        if (previous?.status === "done") return getProgressiveTaskStatus(identity);
        await readyFor(record);
        record.attempt++;
        if (identity.deadlineMs !== undefined) {
            if (!Number.isSafeInteger(identity.deadlineMs) || identity.deadlineMs < 1) throw new Error("deadlineMs must be a positive integer");
            record.payload.request = { ...record.payload.request, deadlineMs: identity.deadlineMs };
        }
        if (record.payload.phase !== "full" && record.payload.request.deadlineMs !== undefined) {
            const initialDeadlineAt = Date.now() + record.payload.request.deadlineMs;
            if (!Number.isSafeInteger(initialDeadlineAt)) throw new Error("Progressive deadlineMs exceeds the supported clock range");
            record.payload = { ...record.payload, initialDeadlineAt };
        }
        record.backgroundTaskId = identity.taskId + "-" + record.attempt;
        await writeProgressiveState(path.join(directory, "request.json"), record);
        launch(record);
        return getProgressiveTaskStatus(identity);
    } finally { await release(); }
}

