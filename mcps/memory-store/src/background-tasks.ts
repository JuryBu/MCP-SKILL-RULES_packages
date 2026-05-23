export type BackgroundTaskStatus = "running" | "done" | "error" | "cancelled";

export interface BackgroundTaskProgress {
    stage?: string;
    detail?: string;
    current?: number;
    total?: number;
    unit?: string;
    updatedAt?: string;
    stageStartedAt?: string;
}

export interface BackgroundTask {
    id: string;
    kind: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    updatedAt: string;
    finishedAt?: string;
    deadlineAt?: string;
    maxRunMs?: number;
    timedOut?: boolean;
    progress?: BackgroundTaskProgress;
    result?: string;
    error?: string;
}

export interface BackgroundTaskContext {
    updateProgress: (progress: BackgroundTaskProgress) => void;
    isCancelled: () => boolean;
}

export interface BackgroundTaskOptions {
    maxRunMs?: number;
    timeoutMessage?: string;
}

const tasks = new Map<string, BackgroundTask>();
const DEFAULT_TTL_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_TTL || 30 * 60 * 1000);
const DEFAULT_MAX_RUN_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_MAX_RUN_MS || 15 * 60 * 1000);

function nowIso(): string {
    return new Date().toISOString();
}

function makeTaskId(kind: string): string {
    return `${kind}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function getBackgroundTaskMaxRunMs(kind: string): number {
    const key = `MEMORY_STORE_${kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BACKGROUND_MAX_RUN_MS`;
    const value = Number(process.env[key]);
    if (Number.isFinite(value) && value > 0) return value;
    if (kind === "record-update") {
        const recordValue = Number(process.env.MEMORY_STORE_RECORD_UPDATE_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(recordValue) && recordValue > 0 ? recordValue : 60 * 60 * 1000;
    }
    if (kind === "stage-guard-check") {
        const guardValue = Number(process.env.MEMORY_STORE_STAGE_GUARD_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(guardValue) && guardValue > 0 ? guardValue : 15 * 60 * 1000;
    }
    if (kind === "golden-extract") {
        const goldenValue = Number(process.env.MEMORY_STORE_GOLDEN_EXTRACT_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(goldenValue) && goldenValue > 0 ? goldenValue : 15 * 60 * 1000;
    }
    return DEFAULT_MAX_RUN_MS;
}

function cleanupOldTasks(): void {
    const now = Date.now();
    for (const [id, task] of tasks) {
        if (task.status === "running") continue;
        const updatedMs = new Date(task.updatedAt).getTime();
        if (Number.isFinite(updatedMs) && now - updatedMs > DEFAULT_TTL_MS) {
            tasks.delete(id);
        }
    }
}

export function startBackgroundTask(
    kind: string,
    run: (context: BackgroundTaskContext) => Promise<string>,
    options: BackgroundTaskOptions = {},
): BackgroundTask {
    cleanupOldTasks();
    const maxRunMs = options.maxRunMs ?? getBackgroundTaskMaxRunMs(kind);
    const startedAtMs = Date.now();
    const task: BackgroundTask = {
        id: makeTaskId(kind),
        kind,
        status: "running",
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: new Date(startedAtMs).toISOString(),
        maxRunMs,
        deadlineAt: maxRunMs > 0 ? new Date(startedAtMs + maxRunMs).toISOString() : undefined,
    };
    tasks.set(task.id, task);

    const updateProgress = (progress: BackgroundTaskProgress) => {
        if (task.status !== "running") return;
        const updatedAt = nowIso();
        const previous = task.progress;
        const stageChanged = progress.stage !== undefined && progress.stage !== previous?.stage;
        const progressShapeChanged = progress.total !== undefined && previous?.total !== undefined && progress.total !== previous.total;
        task.progress = {
            ...(previous || {}),
            ...progress,
            stageStartedAt: progress.stageStartedAt
                || (stageChanged || progressShapeChanged ? updatedAt : previous?.stageStartedAt)
                || updatedAt,
            updatedAt,
        };
        task.updatedAt = updatedAt;
    };

    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (status: Exclude<BackgroundTaskStatus, "running">, payload: { result?: string; error?: string; timedOut?: boolean }) => {
        if (settled || task.status !== "running") return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        task.status = status;
        task.result = payload.result;
        task.error = payload.error;
        task.timedOut = payload.timedOut;
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
    };

    if (maxRunMs > 0) {
        timeout = setTimeout(() => {
            settle("error", {
                timedOut: true,
                error: options.timeoutMessage || `后台任务超时（${Math.round(maxRunMs / 1000)}s）`,
            });
        }, maxRunMs);
        if (typeof (timeout as { unref?: () => void }).unref === "function") {
            (timeout as { unref: () => void }).unref();
        }
    }

    void (async () => {
        try {
            const result = await run({
                updateProgress,
                isCancelled: () => task.status === "cancelled",
            });
            settle("done", { result });
        } catch (err) {
            settle("error", { error: err instanceof Error ? err.message : String(err) });
        }
    })();

    return task;
}

export function getBackgroundTask(taskId: string): BackgroundTask | null {
    cleanupOldTasks();
    return tasks.get(taskId) || null;
}

export function cancelBackgroundTask(taskId: string, reason = "用户取消"): BackgroundTask | null {
    const task = getBackgroundTask(taskId);
    if (!task) return null;
    if (task.status !== "running") return task;
    task.status = "cancelled";
    task.error = reason;
    task.finishedAt = nowIso();
    task.updatedAt = task.finishedAt;
    return task;
}

export async function waitForBackgroundTask(taskId: string, waitSeconds = 0): Promise<BackgroundTask | null> {
    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    while (Date.now() < deadline) {
        const task = getBackgroundTask(taskId);
        if (!task || task.status !== "running") return task;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return getBackgroundTask(taskId);
}

function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = Math.ceil(seconds % 60);
    if (minutes < 60) return restSeconds > 0 ? `${minutes}m${restSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function formatProgress(task: BackgroundTask): string[] {
    const progress = task.progress;
    if (!progress) return [];

    const lines: string[] = [];
    if (progress.stage) lines.push(`🔄 阶段: ${progress.stage}`);
    if (progress.total !== undefined && progress.current !== undefined && progress.total > 0) {
        const unit = progress.unit || "项";
        const current = Math.min(Math.max(progress.current, 0), progress.total);
        const percent = ((current / progress.total) * 100).toFixed(1);
        lines.push(`📈 进度: ${current}/${progress.total} ${unit} (${percent}%)`);

        if (current > 0 && current < progress.total) {
            const etaBase = progress.stageStartedAt || task.startedAt;
            const elapsedSeconds = (Date.now() - new Date(etaBase).getTime()) / 1000;
            const etaSeconds = (elapsedSeconds / current) * (progress.total - current);
            lines.push(`⏳ 预计剩余: ${formatDuration(etaSeconds)}`);
        }
    }
    if (progress.detail) lines.push(`🧩 当前: ${progress.detail}`);
    if (progress.updatedAt) lines.push(`🕒 进度更新时间: ${progress.updatedAt}`);
    return lines;
}

export function formatBackgroundTask(task: BackgroundTask | null): string {
    if (!task) return "❌ 未找到后台任务";
    if (task.status === "running") {
        const elapsed = ((Date.now() - new Date(task.startedAt).getTime()) / 1000).toFixed(0);
        return [
            `⏳ 后台任务运行中`,
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `⏱ 已用: ${elapsed}s`,
            ...formatProgress(task),
            task.deadlineAt ? `⏳ 截止: ${task.deadlineAt}` : "",
        ].filter(Boolean).join("\n");
    }
    if (task.status === "error") {
        return [
            `❌ 后台任务失败`,
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            task.timedOut ? `⏰ timedOut: true` : "",
            task.deadlineAt ? `⏳ 截止: ${task.deadlineAt}` : "",
            `📋 错误: ${task.error || "unknown error"}`,
        ].filter(Boolean).join("\n");
    }
    if (task.status === "cancelled") {
        return [
            `🛑 后台任务已取消`,
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            task.error ? `📋 原因: ${task.error}` : "",
        ].filter(Boolean).join("\n");
    }
    return task.result || `✅ 后台任务完成: ${task.id}`;
}
