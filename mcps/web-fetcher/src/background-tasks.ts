import { randomUUID } from "crypto";
import { performance } from 'node:perf_hooks';
import { getRequestContext, OperationGate, runWithRequestContext, throwIfRequestExpired } from './request-context.js';

export type BackgroundTaskStatus = "running" | "cancelling" | "cancelled" | "done" | "error";

export type BackgroundTaskMetadata = Record<string, unknown>;

export interface BackgroundTaskRunContext {
    signal: AbortSignal;
    updateMetadata: (patch: BackgroundTaskMetadata) => void;
    startDeadline: (ms: number) => void;
}

export interface BackgroundTask {
    id: string;
    kind: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    updatedAt: string;
    deadlineAt?: string;
    maxRunMs?: number;
    timedOut?: boolean;
    finishedAt?: string;
    result?: string;
    error?: string;
    phase?: 'queued' | 'running' | 'finished';
    executionStartedAt?: string;
    ownerId?: string;
    strictOwner?: boolean;
    metadata?: BackgroundTaskMetadata;
    setupDeadlineAt?: string;
    cleanupStatus?: 'pending' | 'done' | 'failed';
    cleanupError?: string;
}

export interface StartBackgroundTaskOptions {
    maxRunMs?: number;
    deadlineAt?: string | number | Date;
    timeoutMessage?: string;
    ownerId?: string;
    strictOwner?: boolean;
    metadata?: BackgroundTaskMetadata;
    onCancel?: () => void | Promise<void>;
    deferDeadlineUntilReady?: boolean;
    setupTimeoutMs?: number;
    cleanupTimeoutMs?: number;
}

const tasks = new Map<string, BackgroundTask>();
const runtimeKey = Symbol('background-task-runtime');
type RuntimeTask = BackgroundTask & { [runtimeKey]?: { cancel: (reason?: 'cancel' | 'timeout' | 'error', message?: string) => Promise<BackgroundTask> } };
const TASK_TTL_MS = Number(process.env.WEB_FETCHER_BACKGROUND_TASK_TTL || 30 * 60 * 1000);
const MAX_WAIT_SECONDS = 600;
const backgroundGate = new OperationGate(2, 16, 'background-work');
const manualGate = new OperationGate(2, 8, 'background-login');

function isManualTask(kind: string): boolean { return kind === 'web-login' || kind === 'human-browser-open' || kind === 'human-verification'; }

export function runBackgroundWork<Result>(kind: string, run: () => Promise<Result>, maxRunMs = 30 * 60_000, onStarted?: () => void, signal?: AbortSignal, ownerId?: string, exposeSignal = false): Promise<Result> {
    const parent = getRequestContext();
    const manual = isManualTask(kind);
    return runWithRequestContext({
        ownerId: ownerId ?? parent?.ownerId,
        signal: exposeSignal ? signal : undefined,
        viewport: parent?.viewport,
        toolName: `${kind}.background`,
        intent: `${kind}.background`,
        timeoutMs: manual ? 10_000 : maxRunMs,
    }, async () => {
        const context = getRequestContext()!;
        const gate = manual ? manualGate : backgroundGate;
        const release = await gate.acquire({ ownerId: context.ownerId, signal, deadline: context.deadline, queueTimeoutMs: manual ? 10_000 : maxRunMs });
        try {
            throwIfRequestExpired();
            if (manual) context.deadline = performance.now() + maxRunMs;
            onStarted?.();
            throwIfRequestExpired();
            return await run();
        }
        finally { release(); }
    });
}

function nowIso(): string {
    return new Date().toISOString();
}

function makeTaskId(kind: string): string {
    return `${kind}-${randomUUID()}`;
}

function cleanupTasks(): void {
    const now = Date.now();
    for (const [id, task] of tasks) {
        if (task.status === "running" || task.status === 'cancelling') continue;
        const updatedMs = new Date(task.updatedAt).getTime();
        if (Number.isFinite(updatedMs) && now - updatedMs > TASK_TTL_MS) {
            tasks.delete(id);
        }
    }
}

function resolveDeadline(options?: StartBackgroundTaskOptions): { deadlineMs?: number; maxRunMs?: number } {
    if (options?.deadlineAt !== undefined) {
        const deadlineMs = new Date(options.deadlineAt).getTime();
        if (Number.isFinite(deadlineMs)) {
            return {
                deadlineMs,
                maxRunMs: Math.max(0, deadlineMs - Date.now()),
            };
        }
    }
    if (options?.maxRunMs !== undefined) {
        const maxRunMs = Math.max(0, options.maxRunMs);
        return {
            deadlineMs: Date.now() + maxRunMs,
            maxRunMs,
        };
    }
    return {};
}

function copyMetadata(metadata: BackgroundTaskMetadata): BackgroundTaskMetadata {
    const copy = JSON.parse(JSON.stringify(metadata));
    if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('后台任务 metadata 必须是可序列化对象');
    return copy;
}

function mayAccess(task: BackgroundTask, ownerId?: string): boolean {
    return !task.strictOwner || (!!ownerId?.trim() && ownerId.trim() === task.ownerId);
}

export function startBackgroundTask(
    kind: string,
    run: (context: BackgroundTaskRunContext) => Promise<string>,
    options?: StartBackgroundTaskOptions
): BackgroundTask {
    cleanupTasks();
    const { deadlineMs, maxRunMs } = resolveDeadline(options);
    const deferredManualDeadline = isManualTask(kind) && options?.deadlineAt === undefined;
    const deferredUntilReady = options?.deferDeadlineUntilReady === true;
    const setupTimeoutMs = options?.setupTimeoutMs ?? 60_000;
    if (deferredUntilReady && (!Number.isFinite(setupTimeoutMs) || setupTimeoutMs <= 0)) throw new Error('setupTimeoutMs 必须是正数');
    const task: RuntimeTask = {
        id: makeTaskId(kind),
        kind,
        status: "running",
        phase: 'queued',
        startedAt: nowIso(),
        updatedAt: nowIso(),
        ownerId: options?.ownerId?.trim() || getRequestContext()?.ownerId || 'global',
        strictOwner: options?.strictOwner || undefined,
        ...(options?.metadata ? { metadata: copyMetadata(options.metadata) } : {}),
        ...(deadlineMs && !deferredManualDeadline && !deferredUntilReady ? { deadlineAt: new Date(deadlineMs).toISOString() } : {}),
        ...(maxRunMs !== undefined ? { maxRunMs } : {}),
    };
    tasks.set(task.id, task);

    let lifecycle: 'active' | 'stopping' | 'finished' = 'active';
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let stopPromise: Promise<BackgroundTask> | undefined;
    let readyDeadlineStarted = false;
    const settle = (status: 'done' | 'error' | 'cancelled', value: string, timedOut = false) => {
        if (lifecycle === 'finished') return;
        lifecycle = 'finished';
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        task.status = status;
        task.phase = 'finished';
        task.timedOut = timedOut || undefined;
        if (status === "done") {
            task.result = value;
        } else if (status === 'error') {
            task.error = value;
        }
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
    };

    const armDeadline = (absoluteDeadline: number) => {
        if (timeout) clearTimeout(timeout);
        const delay = Math.max(0, absoluteDeadline - Date.now());
        timeout = setTimeout(() => {
            void terminate('timeout', options?.timeoutMessage || `后台任务超时（maxRunMs=${maxRunMs ?? delay}）`);
        }, delay);
        timeout.unref?.();
    };
    const terminate = (reason: 'cancel' | 'timeout' | 'error' = 'cancel', message?: string): Promise<BackgroundTask> => {
        if (reason === 'cancel' && lifecycle === 'finished' && task.cleanupStatus === 'failed') {
            lifecycle = 'active';
            stopPromise = undefined;
            task.cleanupError = undefined;
            task.error = undefined;
        }
        if (lifecycle === 'finished') return Promise.resolve(task);
        if (stopPromise) return stopPromise;
        lifecycle = 'stopping';
        task.status = 'cancelling';
        task.metadata = { ...task.metadata, phase: reason === 'timeout' ? 'expired' : reason === 'cancel' ? 'cancelled' : 'failed' };
        task.updatedAt = nowIso();
        if (timeout) { clearTimeout(timeout); timeout = null; }
        controller.abort();
        if (options?.onCancel) task.cleanupStatus = 'pending';
        stopPromise = (async () => {
            await Promise.resolve();
            let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                if (options?.onCancel) await Promise.race([
                    Promise.resolve().then(options.onCancel),
                    new Promise<never>((_, reject) => {
                        cleanupTimer = setTimeout(() => reject(new Error('资源清理超过期限；清理结果未确认，不应重开同一操作')), options.cleanupTimeoutMs ?? 60_000);
                        cleanupTimer.unref?.();
                    }),
                ]);
                if (options?.onCancel) task.cleanupStatus = 'done';
                settle(reason === 'cancel' ? 'cancelled' : 'error', message || '后台任务已取消', reason === 'timeout');
            } catch (error) {
                task.cleanupStatus = 'failed';
                task.cleanupError = error instanceof Error ? error.message : String(error);
                if (reason !== 'timeout') task.metadata = { ...task.metadata, phase: 'failed' };
                settle('error', `${message || '后台任务取消'}；清理失败: ${task.cleanupError}`, reason === 'timeout');
            } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
            return task;
        })();
        return stopPromise;
    };
    const controller = new AbortController();
    Object.defineProperty(task, runtimeKey, { value: { cancel: terminate } });
    if (deadlineMs !== undefined && !deferredManualDeadline && !deferredUntilReady) armDeadline(deadlineMs);

    const runContext: BackgroundTaskRunContext = {
        signal: controller.signal,
        updateMetadata: patch => {
            if (lifecycle !== 'active') return;
            task.metadata = { ...task.metadata, ...copyMetadata(patch) };
            task.updatedAt = nowIso();
        },
        startDeadline: ms => {
            if (!deferredUntilReady) throw new Error('此后台任务未启用就绪后计时');
            if (lifecycle !== 'active' || readyDeadlineStarted) throw new Error('后台任务期限已启动或任务已结束');
            if (!Number.isFinite(ms) || ms <= 0 || (maxRunMs !== undefined && ms > maxRunMs)) throw new Error('就绪后期限必须是有效且不超过 maxRunMs 的正数');
            readyDeadlineStarted = true;
            const readyDeadline = Date.now() + ms;
            task.deadlineAt = new Date(readyDeadline).toISOString();
            task.setupDeadlineAt = undefined;
            task.updatedAt = nowIso();
            const context = getRequestContext();
            if (context) context.deadline = performance.now() + ms;
            armDeadline(readyDeadline);
        },
    };

    void (async () => {
        try {
            const result = await runBackgroundWork(kind, () => run(runContext), deferredUntilReady ? setupTimeoutMs : maxRunMs, () => {
                if (lifecycle !== 'active') throw new Error('后台任务已在排队期间结束，未启动操作');
                task.phase = 'running';
                task.executionStartedAt = nowIso();
                task.updatedAt = task.executionStartedAt;
                if (deferredUntilReady) {
                    const setupDeadline = Date.now() + setupTimeoutMs;
                    task.setupDeadlineAt = new Date(setupDeadline).toISOString();
                    armDeadline(setupDeadline);
                } else if (deferredManualDeadline && maxRunMs !== undefined) {
                    const manualDeadline = Date.now() + maxRunMs;
                    task.deadlineAt = new Date(manualDeadline).toISOString();
                    armDeadline(manualDeadline);
                } else if (deadlineMs !== undefined) {
                    const context = getRequestContext();
                    if (context) context.deadline = performance.now() + Math.max(0, deadlineMs - Date.now());
                }
            }, controller.signal, task.ownerId, kind === 'human-verification' || !!options?.strictOwner || !!options?.onCancel || deferredUntilReady);
            if (lifecycle === 'active') {
                if (deferredUntilReady && readyDeadlineStarted) {
                    task.result = result;
                    task.updatedAt = nowIso();
                } else {
                    settle("done", result);
                }
            }
        } catch (err) {
            if (lifecycle === 'active') {
                const message = err instanceof Error ? err.message : String(err);
                if (options?.onCancel) await terminate('error', message);
                else settle('error', message);
            }
        }
    })();

    return task;
}

export async function waitForBackgroundTask(taskId: string, waitSeconds = 0, ownerId?: string): Promise<BackgroundTask | null> {
    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, MAX_WAIT_SECONDS)) * 1000;
    while (Date.now() < deadline) {
        const task = tasks.get(taskId) || null;
        if (!task || !mayAccess(task, ownerId)) return null;
        if (task.status !== "running" && task.status !== 'cancelling') return task;
        if (task.status === 'running' && task.metadata?.phase === 'ready') return task;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    cleanupTasks();
    const task = tasks.get(taskId) || null;
    return task && mayAccess(task, ownerId) ? task : null;
}

export async function cancelBackgroundTask(taskId: string, ownerId?: string): Promise<BackgroundTask | null> {
    cleanupTasks();
    const task = tasks.get(taskId) as RuntimeTask | undefined;
    if (!task || !mayAccess(task, ownerId)) return null;
    return task[runtimeKey]?.cancel() ?? task;
}

export function listBackgroundTasks(kind: string, ownerId: string): BackgroundTask[] {
    cleanupTasks();
    const owner = ownerId.trim();
    if (!owner) return [];
    return [...tasks.values()].filter(task => task.kind === kind && task.ownerId === owner);
}

export function formatBackgroundTask(task: BackgroundTask | null): string {
    if (!task) return "❌ 未找到后台任务";
    if (task.status === "running") {
        const elapsed = ((Date.now() - new Date(task.startedAt).getTime()) / 1000).toFixed(0);
        const deadlineLine = task.deadlineAt ? [`⏳ 截止: ${task.deadlineAt}`] : [];
        return [
            task.phase === 'queued' ? '⏳ 后台任务排队中（尚未开始操作）' : "⏳ 后台任务运行中",
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `⏱ 已用: ${elapsed}s`,
            ...deadlineLine,
        ].join("\n");
    }
    if (task.status === 'cancelling') return `⏳ 后台任务取消及资源清理中\n🆔 taskId: ${task.id}`;
    if (task.status === 'cancelled') return `🚫 后台任务已取消\n🆔 taskId: ${task.id}`;
    if (task.status === "error") {
        return [
            task.timedOut ? "⏱ 后台任务超时" : "❌ 后台任务失败",
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `📋 错误: ${task.error || "unknown error"}`,
        ].join("\n");
    }
    return task.result || `✅ 后台任务完成: ${task.id}`;
}
