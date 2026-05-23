import { randomUUID } from "crypto";

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
}

export interface StartBackgroundTaskOptions {
    maxRunMs?: number;
    deadlineAt?: string | number | Date;
    timeoutMessage?: string;
}

const tasks = new Map<string, BackgroundTask>();
const TASK_TTL_MS = Number(process.env.WEB_FETCHER_BACKGROUND_TASK_TTL || 30 * 60 * 1000);

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
    const task: BackgroundTask = {
        id: makeTaskId(kind),
        kind,
        status: "running",
        startedAt: nowIso(),
        updatedAt: nowIso(),
        ...(deadlineMs ? { deadlineAt: new Date(deadlineMs).toISOString() } : {}),
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
        task.timedOut = timedOut || undefined;
        if (status === "done") {
            task.result = value;
        } else {
            task.error = value;
        }
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
    };

    if (deadlineMs !== undefined) {
        const delay = Math.max(0, deadlineMs - Date.now());
        timeout = setTimeout(() => {
            settle("error", options?.timeoutMessage || `后台任务超时（maxRunMs=${maxRunMs ?? delay}）`, true);
        }, delay);
        timeout.unref?.();
    }

    void (async () => {
        try {
            settle("done", await run());
        } catch (err) {
            settle("error", err instanceof Error ? err.message : String(err));
        }
    })();

    return task;
}

export async function waitForBackgroundTask(taskId: string, waitSeconds = 0): Promise<BackgroundTask | null> {
    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
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
            "⏳ 后台任务运行中",
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
