import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";

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
    /** 任务是否已结算（done/error/超时/cancelled 任一）。长任务在「写回前」自查，避免超时后仍幽灵写回。 */
    isSettled: () => boolean;
}

export interface BackgroundTaskOptions {
    maxRunMs?: number;
    timeoutMessage?: string;
}

const tasks = new Map<string, BackgroundTask>();
const DEFAULT_TTL_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_TTL || 30 * 60 * 1000);
const DEFAULT_MAX_RUN_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_MAX_RUN_MS || 15 * 60 * 1000);

// ============= 文件持久化（跨进程可见） =============
// 内存 Map 仍是「本进程活任务」的真相源；这里叠一层文件态，让同机同 DATA_ROOT
// 的另一个进程也能查到任务状态（A 源拿 taskId、B 源查得到；进程重启后历史可见）。
// 边界：仅解决「同机、同 DATA_ROOT、不同进程」可见；跨进程取消仍不生效。

const TASKS_DIR = path.join(DATA_ROOT, "tasks");
// 进度落盘节流间隔：高频 updateProgress 不必每次写盘，~1s 落一次即可。
const PERSIST_THROTTLE_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_PERSIST_THROTTLE_MS || 1000);
// 孤儿陈旧判定的额外宽限倍数：文件态 running 但 updatedAt 距今超过 maxRunMs × 此倍数，
// 视为「进程已退出/超时、状态陈旧」，转 error。倍数 >1 留足余量，避免误杀慢任务。
const STALE_FACTOR = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_STALE_FACTOR || 1.5);
// 即便 maxRunMs=0（不限时）或异常，也至少给一个保守的兜底陈旧阈值。
const STALE_FLOOR_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_STALE_FLOOR_MS || 60 * 60 * 1000);

// 记录每个任务上次落盘时间戳，用于进度节流（settle 时无视此节流强制落盘）。
const lastPersistMs = new Map<string, number>();

function taskFilePath(taskId: string): string {
    return path.join(TASKS_DIR, `${taskId}.json`);
}

/** 把任务最新态原子落盘。任何 IO 异常都吞掉——持久化是「尽力而为」，绝不影响任务主流程。 */
function persistTask(task: BackgroundTask): void {
    try {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        writeJsonAtomic(taskFilePath(task.id), task);
        lastPersistMs.set(task.id, Date.now());
    } catch {
        // 落盘失败不致命：内存态仍是本进程真相源，下次 settle/进度还会再试。
    }
}

/** 进度落盘：按 PERSIST_THROTTLE_MS 节流，避免高频 updateProgress 打爆磁盘。 */
function persistTaskThrottled(task: BackgroundTask): void {
    const last = lastPersistMs.get(task.id) || 0;
    if (Date.now() - last < PERSIST_THROTTLE_MS) return;
    persistTask(task);
}

/** 从文件读取任务态（跨进程兜底）。文件不存在或解析失败均返回 null。 */
function readPersistedTask(taskId: string): BackgroundTask | null {
    try {
        const raw = fs.readFileSync(taskFilePath(taskId), "utf-8");
        const parsed = JSON.parse(raw) as BackgroundTask;
        if (parsed && typeof parsed.id === "string" && typeof parsed.status === "string") {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 孤儿陈旧判定：文件态 status=running 的任务在本进程没有对应定时器/协程，
 * 若它由一个已退出/崩溃的进程留下，会永远卡在 running 永不 settle。
 * 这里在「读到文件态 running」时，若 updatedAt 距今超过 STALE_MS（该 kind 的 maxRunMs × 余量），
 * 就把它当 error 返回，避免「查不到」恶化成「永远卡 running」。
 * 注意：内存优先已保证「本进程仍在跑的活任务」走内存态，不会被这里误杀。
 */
function reconcileStaleTask(task: BackgroundTask): BackgroundTask {
    if (task.status !== "running") return task;
    const baseMaxRun = task.maxRunMs && task.maxRunMs > 0 ? task.maxRunMs : getBackgroundTaskMaxRunMs(task.kind);
    const staleMs = Math.max(baseMaxRun * STALE_FACTOR, STALE_FLOOR_MS);
    const updatedMs = new Date(task.updatedAt).getTime();
    if (!Number.isFinite(updatedMs)) return task;
    if (Date.now() - updatedMs <= staleMs) return task;
    return {
        ...task,
        status: "error",
        timedOut: true,
        error: task.error || "任务进程已退出或超时，状态陈旧（孤儿任务）",
        finishedAt: task.finishedAt || nowIso(),
    };
}

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
            lastPersistMs.delete(id);
            // 连带删除落盘文件，避免 tasks/ 无限堆积。删失败不致命。
            try {
                fs.rmSync(taskFilePath(id), { force: true });
            } catch {
                // ignore
            }
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
    // 创建即落盘：让另一进程在任务一开始就能查到 running 态。
    persistTask(task);

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
        // 进度落盘节流：~1s 一次，避免高频进度更新打爆磁盘 IO。
        persistTaskThrottled(task);
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
        // settle 必须立即落盘（无视进度节流），保证最终态 done/error/cancelled + result 跨进程可见。
        persistTask(task);
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
                isSettled: () => task.status !== "running",
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
    // 内存优先：本进程的活任务（含 running 的真活任务）以内存态为真相源，不会被孤儿判定误杀。
    const inMemory = tasks.get(taskId);
    if (inMemory) return inMemory;
    // 文件兜底：本进程没有 → 可能是另一进程创建的任务，或本进程重启前的历史任务。
    const persisted = readPersistedTask(taskId);
    if (!persisted) return null;
    // 文件态 running 的孤儿任务（无对应定时器/协程、永不 settle）按陈旧判定转 error。
    return reconcileStaleTask(persisted);
}

export function cancelBackgroundTask(taskId: string, reason = "用户取消"): BackgroundTask | null {
    const task = getBackgroundTask(taskId);
    if (!task) return null;
    if (task.status !== "running") return task;
    task.status = "cancelled";
    task.error = reason;
    task.finishedAt = nowIso();
    task.updatedAt = task.finishedAt;
    // 取消态落盘（仅对本进程内存中的任务生效；跨进程取消仍不生效——这是已知局限）。
    persistTask(task);
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

// ============= 测试专用钩子（仅供单测模拟「另一进程」场景，勿在业务代码使用） =============

/** 把任务从内存 Map 逐出，仅保留文件态——模拟「在另一进程查询该任务」。 */
export function __testEvictFromMemory(taskId: string): void {
    tasks.delete(taskId);
    lastPersistMs.delete(taskId);
}

/** 直接往 tasks/{id}.json 写入一个任意文件态——模拟「另一进程/重启前残留」的孤儿任务。 */
export function __testWritePersistedTask(task: BackgroundTask): void {
    persistTask(task);
}
