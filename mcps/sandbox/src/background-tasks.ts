import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "./owner.js";

export type BackgroundTaskStatus = "running" | "done" | "error";

export interface BackgroundTask {
    id: string;
    kind: string;
    ownerId: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    updatedAt: string;
    maxRunMs?: number;
    deadlineAt?: string;
    timedOut?: boolean;
    finishedAt?: string;
    result?: string;
    error?: string;
    progress?: string;
}

const tasks = new Map<string, BackgroundTask>();
const TASK_TTL_MS = Number(process.env.SANDBOX_BACKGROUND_TASK_TTL || 30 * 60 * 1000);

export interface StartBackgroundTaskOptions {
    ownerId?: string;
    maxRunMs?: number;
}

export type BackgroundTaskProgress = (progress: string) => void;

function nowIso(): string {
    return new Date().toISOString();
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

export function startBackgroundTask(
    kind: string,
    run: (progress: BackgroundTaskProgress, signal: AbortSignal) => Promise<string>,
    options: StartBackgroundTaskOptions = {},
): BackgroundTask {
    cleanupTasks();
    const startedMs = Date.now();
    const maxRunMs = options.maxRunMs && options.maxRunMs > 0 ? options.maxRunMs : undefined;
    const task: BackgroundTask = {
        id: newUuid(),
        kind,
        ownerId: normalizeOwnerId(options.ownerId),
        status: "running",
        startedAt: new Date(startedMs).toISOString(),
        updatedAt: new Date(startedMs).toISOString(),
        maxRunMs,
        deadlineAt: maxRunMs ? new Date(startedMs + maxRunMs).toISOString() : undefined,
        timedOut: false,
    };
    tasks.set(task.id, task);

    const abortController = new AbortController();
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const settle = (patch: Partial<BackgroundTask>) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        Object.assign(task, patch);
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
    };
    const updateProgress: BackgroundTaskProgress = (progress: string) => {
        if (settled) return;
        task.progress = progress;
        task.updatedAt = nowIso();
    };

    if (maxRunMs) {
        timeoutTimer = setTimeout(() => {
            abortController.abort(new Error(`后台任务超过最大运行时间 ${maxRunMs}ms，已取消底层任务`));
            settle({
                status: "error",
                timedOut: true,
                error: `后台任务超过最大运行时间 ${maxRunMs}ms，已取消底层任务`,
            });
        }, maxRunMs);
        timeoutTimer.unref?.();
    }

    void (async () => {
        try {
            const result = await run(updateProgress, abortController.signal);
            settle({ status: "done", result });
        } catch (err) {
            settle({
                status: "error",
                error: err instanceof Error ? err.message : String(err),
            });
        }
    })();

    return task;
}

export async function waitForBackgroundTask(
    taskId: string,
    waitSeconds = 0,
    ownerId?: string,
): Promise<BackgroundTask | null | { forbidden: true; text: string }> {
    const requestOwner = normalizeOwnerId(ownerId);
    const initialTask = tasks.get(taskId) || null;
    if (initialTask && !hasOwnerAccess(initialTask.ownerId, requestOwner)) {
        return { forbidden: true, text: ownerMismatchText("后台任务", taskId) };
    }

    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    while (Date.now() < deadline) {
        const task = tasks.get(taskId) || null;
        if (task && !hasOwnerAccess(task.ownerId, requestOwner)) {
            return { forbidden: true, text: ownerMismatchText("后台任务", taskId) };
        }
        if (!task || task.status !== "running") return task;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    cleanupTasks();
    const task = tasks.get(taskId) || null;
    if (task && !hasOwnerAccess(task.ownerId, requestOwner)) {
        return { forbidden: true, text: ownerMismatchText("后台任务", taskId) };
    }
    return task;
}

export function formatBackgroundTask(task: BackgroundTask | null | { forbidden: true; text: string }): string {
    if (task && "forbidden" in task) return task.text;
    if (!task) return "❌ 未找到后台任务";
    if (task.status === "running") {
        const elapsed = ((Date.now() - new Date(task.startedAt).getTime()) / 1000).toFixed(0);
        return [
            "⏳ 后台任务运行中",
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `👤 ownerId: ${task.ownerId}`,
            `⏱ 已用: ${elapsed}s`,
            ...(task.deadlineAt ? [`⏳ deadlineAt: ${task.deadlineAt}`] : []),
            task.progress ? `\n## 当前进度\n${task.progress}` : "",
        ].join("\n");
    }
    if (task.status === "error") {
        return [
            task.timedOut ? "⏱ 后台任务超时" : "❌ 后台任务失败",
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `👤 ownerId: ${task.ownerId}`,
            `📋 错误: ${task.error || "unknown error"}`,
        ].join("\n");
    }
    return task.result || `✅ 后台任务完成: ${task.id}`;
}
