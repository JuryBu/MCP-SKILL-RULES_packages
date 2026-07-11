import fs from "fs";
import path from "path";
import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "./owner.js";
import { DATA_ROOT } from "./temp-store.js";

export type BackgroundTaskStatus = "running" | "done" | "error" | "interrupted";

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
const BG_TASKS_DIR = process.env.SANDBOX_BG_TASKS_DIR
    ? path.resolve(process.env.SANDBOX_BG_TASKS_DIR)
    : path.join(DATA_ROOT, "bg-tasks");

export interface StartBackgroundTaskOptions {
    ownerId?: string;
    maxRunMs?: number;
}

export type BackgroundTaskProgress = (progress: string) => void;

function nowIso(): string {
    return new Date().toISOString();
}

function ensureBgTasksDir(): void {
    fs.mkdirSync(BG_TASKS_DIR, { recursive: true });
}

function getTaskPath(taskId: string): string {
    return path.join(BG_TASKS_DIR, `${taskId}.json`);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(temp, filePath);
}

function writeTask(task: BackgroundTask): void {
    writeJsonAtomic(getTaskPath(task.id), task);
}

function readTaskFile(taskId: string): BackgroundTask | null {
    try {
        const filePath = getTaskPath(taskId);
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as BackgroundTask;
    } catch {
        return null;
    }
}

function markInterrupted(task: BackgroundTask, reason = "后台任务进程已退出，无法恢复执行"): BackgroundTask {
    if (task.status !== "running") return task;
    const updatedAt = nowIso();
    const updated: BackgroundTask = {
        ...task,
        status: "interrupted",
        error: reason,
        finishedAt: updatedAt,
        updatedAt,
    };
    tasks.set(updated.id, updated);
    writeTask(updated);
    return updated;
}

function hydrateDiskTask(task: BackgroundTask): BackgroundTask {
    if (task.status === "running") {
        return markInterrupted(task);
    }
    tasks.set(task.id, task);
    return task;
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

export function cleanOldBgTasks(maxAgeDays = 15): number {
    ensureBgTasksDir();
    const cutoffMs = Date.now() - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const entry of fs.readdirSync(BG_TASKS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const filePath = path.join(BG_TASKS_DIR, entry.name);
        const taskId = path.basename(entry.name, ".json");
        const preservePaths = [
            path.join(BG_TASKS_DIR, `${taskId}.preserve`),
            path.join(BG_TASKS_DIR, `${entry.name}.preserve`),
        ];
        if (preservePaths.some((preservePath) => fs.existsSync(preservePath))) continue;
        const task = readTaskFile(taskId);
        if (!task || task.status === "running") continue;
        const updatedMs = Date.parse(task.finishedAt || task.updatedAt);
        if (!Number.isFinite(updatedMs) || updatedMs >= cutoffMs) continue;
        try {
            fs.rmSync(filePath, { force: true });
            tasks.delete(task.id);
            removed += 1;
        } catch {
            // Best-effort cleanup.
        }
    }
    return removed;
}

export function restoreBackgroundTasksOnStartup(logger: (message: string) => void = console.error): { restored: number; interrupted: number } {
    ensureBgTasksDir();
    const summary = { restored: 0, interrupted: 0 };
    for (const entry of fs.readdirSync(BG_TASKS_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const task = readTaskFile(path.basename(entry.name, ".json"));
        if (!task) continue;
        if (task.status === "running") {
            markInterrupted(task);
            summary.interrupted += 1;
        } else {
            tasks.set(task.id, task);
            summary.restored += 1;
        }
    }
    logger(`[sandbox] 恢复 ${summary.restored} 个后台任务状态，${summary.interrupted} 个标记中断`);
    return summary;
}

export function startBackgroundTask(
    kind: string,
    run: (progress: BackgroundTaskProgress, signal: AbortSignal) => Promise<string>,
    options: StartBackgroundTaskOptions = {},
): BackgroundTask {
    cleanupTasks();
    cleanOldBgTasks();
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
    writeTask(task);

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
        writeTask(task);
    };
    const updateProgress: BackgroundTaskProgress = (progress: string) => {
        if (settled) return;
        task.progress = progress;
        task.updatedAt = nowIso();
        writeTask(task);
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
    let initialTask = tasks.get(taskId) || readTaskFile(taskId);
    if (initialTask && !tasks.has(taskId)) {
        initialTask = hydrateDiskTask(initialTask);
    }
    if (initialTask && !hasOwnerAccess(initialTask.ownerId, requestOwner)) {
        return { forbidden: true, text: ownerMismatchText("后台任务", taskId) };
    }

    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    while (Date.now() < deadline) {
        let task = tasks.get(taskId) || readTaskFile(taskId);
        if (task && !tasks.has(taskId)) {
            task = hydrateDiskTask(task);
        }
        if (task && !hasOwnerAccess(task.ownerId, requestOwner)) {
            return { forbidden: true, text: ownerMismatchText("后台任务", taskId) };
        }
        if (!task || task.status !== "running") return task;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    cleanupTasks();
    let task = tasks.get(taskId) || readTaskFile(taskId);
    if (task && !tasks.has(taskId)) {
        task = hydrateDiskTask(task);
    }
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
    if (task.status === "error" || task.status === "interrupted") {
        return [
            task.status === "interrupted" ? "⚠️ 后台任务中断" : task.timedOut ? "⏱ 后台任务超时" : "❌ 后台任务失败",
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `👤 ownerId: ${task.ownerId}`,
            `📋 错误: ${task.error || "unknown error"}`,
        ].join("\n");
    }
    return task.result || `✅ 后台任务完成: ${task.id}`;
}
