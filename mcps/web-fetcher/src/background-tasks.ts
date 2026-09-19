import { randomUUID } from "crypto";
import { performance } from 'node:perf_hooks';
import { getRequestContext, OperationGate, runWithRequestContext, throwIfRequestExpired } from './request-context.js';

export type BackgroundTaskStatus = "running" | "done" | "error";

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
}

export interface StartBackgroundTaskOptions {
    maxRunMs?: number;
    deadlineAt?: string | number | Date;
    timeoutMessage?: string;
}

const tasks = new Map<string, BackgroundTask>();
const TASK_TTL_MS = Number(process.env.WEB_FETCHER_BACKGROUND_TASK_TTL || 30 * 60 * 1000);
const MAX_WAIT_SECONDS = 600;
const backgroundGate = new OperationGate(2, 16, 'background-work');
const manualGate = new OperationGate(2, 8, 'background-login');

function isManualTask(kind: string): boolean { return kind === 'web-login' || kind === 'human-browser-open'; }

export function runBackgroundWork<Result>(kind: string, run: () => Promise<Result>, maxRunMs = 30 * 60_000, onStarted?: () => void): Promise<Result> {
    const parent = getRequestContext();
    const manual = isManualTask(kind);
    return runWithRequestContext({
        ownerId: parent?.ownerId,
        viewport: parent?.viewport,
        toolName: `${kind}.background`,
        intent: `${kind}.background`,
        timeoutMs: manual ? 10_000 : maxRunMs,
    }, async () => {
        const context = getRequestContext()!;
        const gate = manual ? manualGate : backgroundGate;
        const release = await gate.acquire({ ownerId: context.ownerId, deadline: context.deadline, queueTimeoutMs: manual ? 10_000 : maxRunMs });
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
        if (task.status === "running") continue;
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

export function startBackgroundTask(
    kind: string,
    run: () => Promise<string>,
    options?: StartBackgroundTaskOptions
): BackgroundTask {
    cleanupTasks();
    const { deadlineMs, maxRunMs } = resolveDeadline(options);
    const deferredManualDeadline = isManualTask(kind) && options?.deadlineAt === undefined;
    const task: BackgroundTask = {
        id: makeTaskId(kind),
        kind,
        status: "running",
        phase: 'queued',
        startedAt: nowIso(),
        updatedAt: nowIso(),
        ...(deadlineMs && !deferredManualDeadline ? { deadlineAt: new Date(deadlineMs).toISOString() } : {}),
        ...(maxRunMs !== undefined ? { maxRunMs } : {}),
    };
    tasks.set(task.id, task);

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (status: Exclude<BackgroundTaskStatus, "running">, value: string, timedOut = false) => {
        if (settled) return;
        settled = true;
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
        task.status = status;
        task.phase = 'finished';
        task.timedOut = timedOut || undefined;
        if (status === "done") {
            task.result = value;
        } else {
            task.error = value;
        }
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
    };

    const armDeadline = (absoluteDeadline: number) => {
        const delay = Math.max(0, absoluteDeadline - Date.now());
        timeout = setTimeout(() => {
            settle("error", options?.timeoutMessage || `后台任务超时（maxRunMs=${maxRunMs ?? delay}）`, true);
        }, delay);
        timeout.unref?.();
    };
    if (deadlineMs !== undefined && !deferredManualDeadline) armDeadline(deadlineMs);

    void (async () => {
        try {
            const result = await runBackgroundWork(kind, run, maxRunMs, () => {
                if (settled) throw new Error('后台任务已在排队期间结束，未启动操作');
                task.phase = 'running';
                task.executionStartedAt = nowIso();
                task.updatedAt = task.executionStartedAt;
                if (deferredManualDeadline && maxRunMs !== undefined) {
                    const manualDeadline = Date.now() + maxRunMs;
                    task.deadlineAt = new Date(manualDeadline).toISOString();
                    armDeadline(manualDeadline);
                } else if (deadlineMs !== undefined) {
                    const context = getRequestContext();
                    if (context) context.deadline = performance.now() + Math.max(0, deadlineMs - Date.now());
                }
            });
            settle("done", result);
        } catch (err) {
            settle("error", err instanceof Error ? err.message : String(err));
        }
    })();

    return task;
}

export async function waitForBackgroundTask(taskId: string, waitSeconds = 0): Promise<BackgroundTask | null> {
    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, MAX_WAIT_SECONDS)) * 1000;
    while (Date.now() < deadline) {
        const task = tasks.get(taskId) || null;
        if (!task || task.status !== "running") return task;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    cleanupTasks();
    return tasks.get(taskId) || null;
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
