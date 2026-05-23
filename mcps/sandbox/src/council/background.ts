import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { TEMP_DIR } from "../temp-store.js";
import { formatElapsed } from "../lifecycle.js";
import { hasOwnerAccess, normalizeOwnerId, ownerMismatchText, newUuid } from "../owner.js";
import type { CouncilRunParams, CouncilTranscript } from "./types.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));
const SERVER_ROOT = path.resolve(path.dirname(WORKER_PATH), "..", "..");
const COUNCIL_TEMP_DIR = path.join(SERVER_ROOT, "sandbox-data", "temp");
const TASK_ROOT = path.join(COUNCIL_TEMP_DIR, "council-tasks");
const LEGACY_WORKER_CWD_TASK_ROOT = path.join(path.dirname(WORKER_PATH), "sandbox-data", "temp", "council-tasks");
const LEGACY_PROCESS_CWD_TASK_ROOT = path.join(TEMP_DIR, "council-tasks");
const LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT = path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity", "sandbox-data", "temp", "council-tasks");
const DEFAULT_BACKGROUND_MAX_RUN_MS = Number(process.env.SANDBOX_COUNCIL_BACKGROUND_MAX_RUN_MS || 45 * 60_000);

interface PersistentCouncilSpec {
    taskId: string;
    ownerId: string;
    startedAt: string;
    deadlineAt?: string;
    transcriptPath?: string;
    outputDir?: string;
    params: Omit<CouncilRunParams, "onProgress">;
}

interface PersistentCouncilProgress {
    status: "running" | "done" | "error";
    taskId: string;
    ownerId: string;
    pid?: number;
    startedAt: string;
    updatedAt: string;
    deadlineAt?: string;
    progressText?: string;
}

interface PersistentCouncilDone {
    status: "done" | "error" | "interrupted";
    taskId: string;
    ownerId: string;
    startedAt: string;
    finishedAt: string;
    resultText?: string;
    transcript?: CouncilTranscript;
    error?: string;
    pid?: number;
}

export interface PersistentCouncilQueryResult {
    taskId: string;
    ownerId: string;
    status: "running" | "done" | "error" | "interrupted" | "missing" | "owner_mismatch";
    startedAt?: string;
    finishedAt?: string;
    deadlineAt?: string;
    progressText?: string;
    resultText?: string;
    transcript?: CouncilTranscript;
    error?: string;
    pid?: number;
}

function ensureTaskRoot(): void {
    fs.mkdirSync(COUNCIL_TEMP_DIR, { recursive: true });
    fs.mkdirSync(TASK_ROOT, { recursive: true });
}

function getTaskDir(taskId: string): string {
    return path.join(TASK_ROOT, taskId);
}

function getTaskPaths(taskId: string) {
    const dir = getTaskDir(taskId);
    return {
        dir,
        spec: path.join(dir, "spec.json"),
        progress: path.join(dir, "progress.json"),
        done: path.join(dir, "done.json"),
    };
}

function getLegacyWorkerCwdTaskPaths(taskId: string) {
    const dir = path.join(LEGACY_WORKER_CWD_TASK_ROOT, taskId);
    return {
        dir,
        spec: path.join(dir, "spec.json"),
        progress: path.join(dir, "progress.json"),
        done: path.join(dir, "done.json"),
    };
}

function getLegacyProcessCwdTaskPaths(taskId: string) {
    const dir = path.join(LEGACY_PROCESS_CWD_TASK_ROOT, taskId);
    return {
        dir,
        spec: path.join(dir, "spec.json"),
        progress: path.join(dir, "progress.json"),
        done: path.join(dir, "done.json"),
    };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(temp, filePath);
}

function readJson<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
        return null;
    }
}

function copyIfMissing(source: string, target: string): boolean {
    try {
        if (!fs.existsSync(source) || fs.existsSync(target)) return false;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        return true;
    } catch {
        return false;
    }
}

function recoverLegacyWorkerCwdTask(taskId: string): void {
    const paths = getTaskPaths(taskId);
    const legacyRoots = [
        getLegacyWorkerCwdTaskPaths(taskId),
        getLegacyProcessCwdTaskPaths(taskId),
        {
            dir: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId),
            spec: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId, "spec.json"),
            progress: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId, "progress.json"),
            done: path.join(LEGACY_ANTIGRAVITY_APP_CWD_TASK_ROOT, taskId, "done.json"),
        },
    ];
    for (const legacy of legacyRoots) {
        if (!fs.existsSync(legacy.dir) || path.resolve(legacy.dir) === path.resolve(paths.dir)) continue;
        copyIfMissing(legacy.spec, paths.spec);
        copyIfMissing(legacy.done, paths.done);
        copyIfMissing(legacy.progress, paths.progress);
    }
}

function isPidAlive(pid?: number): boolean {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function killProcessTree(pid?: number): void {
    if (!pid) return;
    try {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        killer.unref();
    } catch {
        // Best-effort deadline cleanup.
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
    return new Date().toISOString();
}

export function writeCouncilTaskProgress(taskId: string, ownerId: string, progressText: string, pid?: number, startedAt?: string, deadlineAt?: string): void {
    const paths = getTaskPaths(taskId);
    const current = readJson<PersistentCouncilProgress>(paths.progress);
    const payload: PersistentCouncilProgress = {
        status: "running",
        taskId,
        ownerId,
        pid: pid ?? current?.pid,
        startedAt: startedAt || current?.startedAt || nowIso(),
        updatedAt: nowIso(),
        deadlineAt: deadlineAt || current?.deadlineAt,
        progressText,
    };
    writeJsonAtomic(paths.progress, payload);
}

export function finalizeCouncilTask(taskId: string, ownerId: string, result: {
    status: "done" | "error" | "interrupted";
    transcript?: CouncilTranscript;
    resultText?: string;
    error?: string;
    pid?: number;
    startedAt?: string;
}): void {
    const paths = getTaskPaths(taskId);
    const current = readJson<PersistentCouncilProgress>(paths.progress);
    const payload: PersistentCouncilDone = {
        status: result.status,
        taskId,
        ownerId,
        startedAt: result.startedAt || current?.startedAt || nowIso(),
        finishedAt: nowIso(),
        transcript: result.transcript,
        resultText: result.resultText,
        error: result.error,
        pid: result.pid ?? current?.pid,
    };
    writeJsonAtomic(paths.done, payload);
    const progressPayload: PersistentCouncilProgress = {
        status: result.status === "done" ? "done" : "error",
        taskId,
        ownerId,
        pid: payload.pid,
        startedAt: payload.startedAt,
        updatedAt: payload.finishedAt,
        progressText: result.error || result.resultText,
    };
    writeJsonAtomic(paths.progress, progressPayload);
}

export function startPersistentCouncilTask(runParams: CouncilRunParams, ownerIdInput?: string, maxRunMs = DEFAULT_BACKGROUND_MAX_RUN_MS): { id: string; ownerId: string; deadlineAt: string } {
    ensureTaskRoot();
    const taskId = `council-${newUuid()}`;
    const ownerId = normalizeOwnerId(ownerIdInput || runParams.ownerId);
    const startedAt = nowIso();
    const deadlineAt = new Date(Date.now() + maxRunMs).toISOString();
    const paths = getTaskPaths(taskId);
    const transcriptPath = runParams.transcriptPath || path.join(paths.dir, "transcript.md");
    const spec: PersistentCouncilSpec = {
        taskId,
        ownerId,
        startedAt,
        deadlineAt,
        transcriptPath,
        outputDir: runParams.outputDir || paths.dir,
        params: {
            ...runParams,
            ownerId,
            transcriptPath,
            outputDir: runParams.outputDir || paths.dir,
        },
    };
    writeJsonAtomic(paths.spec, spec);
    writeCouncilTaskProgress(taskId, ownerId, "任务已启动，等待 worker 接管。", undefined, startedAt, deadlineAt);
    const child = spawn(process.execPath, [WORKER_PATH, paths.spec], {
        cwd: SERVER_ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    writeCouncilTaskProgress(taskId, ownerId, "worker 已启动，准备执行 council。", child.pid, startedAt, deadlineAt);
    return { id: taskId, ownerId, deadlineAt };
}

function readTask(taskId: string, requestOwnerId: string): PersistentCouncilQueryResult {
    const ownerId = normalizeOwnerId(requestOwnerId);
    const paths = getTaskPaths(taskId);
    recoverLegacyWorkerCwdTask(taskId);
    const spec = readJson<PersistentCouncilSpec>(paths.spec);
    if (!spec) {
        return { taskId, ownerId, status: "missing", error: `❌ 未找到后台任务 ${taskId}` };
    }
    if (!hasOwnerAccess(spec.ownerId, ownerId)) {
        return { taskId, ownerId, status: "owner_mismatch", error: ownerMismatchText("后台任务", taskId) };
    }
    const done = readJson<PersistentCouncilDone>(paths.done);
    if (done) {
        return {
            taskId,
            ownerId: done.ownerId,
            status: done.status,
            startedAt: done.startedAt,
            finishedAt: done.finishedAt,
            resultText: done.resultText,
            transcript: done.transcript,
            error: done.error,
            pid: done.pid,
        };
    }
    const progress = readJson<PersistentCouncilProgress>(paths.progress);
    if (progress) {
        if (progress.deadlineAt && Date.now() > new Date(progress.deadlineAt).getTime()) {
            killProcessTree(progress.pid);
            return {
                taskId,
                ownerId: progress.ownerId,
                status: "interrupted",
                startedAt: progress.startedAt,
                deadlineAt: progress.deadlineAt,
                pid: progress.pid,
                error: "后台任务已超过 deadline，已按超时中断处理",
                progressText: progress.progressText,
            };
        }
        if (progress.pid && !isPidAlive(progress.pid)) {
            return {
                taskId,
                ownerId: progress.ownerId,
                status: "interrupted",
                startedAt: progress.startedAt,
                deadlineAt: progress.deadlineAt,
                pid: progress.pid,
                error: "后台 worker 已退出，但未写入完成标记",
                progressText: progress.progressText,
            };
        }
        return {
            taskId,
            ownerId: progress.ownerId,
            status: "running",
            startedAt: progress.startedAt,
            deadlineAt: progress.deadlineAt,
            progressText: progress.progressText,
            pid: progress.pid,
        };
    }
    return {
        taskId,
        ownerId,
        status: "missing",
        error: `❌ 后台任务 ${taskId} 缺少状态文件`,
    };
}

export async function waitForPersistentCouncilTask(taskId: string, waitSeconds: number, ownerIdInput?: string): Promise<PersistentCouncilQueryResult> {
    const ownerId = normalizeOwnerId(ownerIdInput);
    const maxWaitMs = Math.max(0, Math.min(waitSeconds || 0, 300)) * 1000;
    const deadline = Date.now() + maxWaitMs;
    while (true) {
        const snapshot = readTask(taskId, ownerId);
        if (snapshot.status !== "running") return snapshot;
        if (Date.now() >= deadline) return snapshot;
        await sleep(Math.min(1000, deadline - Date.now()));
    }
}

export function formatPersistentCouncilTask(result: PersistentCouncilQueryResult): string {
    if (result.status === "missing" || result.status === "owner_mismatch") {
        return result.error || `❌ 后台任务 ${result.taskId} 不可用`;
    }
    if (result.status === "running") {
        return [
            "⏳ 后台任务运行中",
            `🆔 taskId: ${result.taskId}`,
            `👤 ownerId: ${result.ownerId}`,
            result.pid ? `🧵 pid: ${result.pid}` : "",
            result.startedAt ? `⏱️ 已用: ${formatElapsed(Date.now() - new Date(result.startedAt).getTime())}` : "",
            result.deadlineAt ? `⏳ deadlineAt: ${result.deadlineAt}` : "",
            "",
            "## 当前进度",
            result.progressText || "暂无进度文本",
        ].filter(Boolean).join("\n");
    }
    if (result.status === "interrupted") {
        return [
            "⚠️ 后台任务中断",
            `🆔 taskId: ${result.taskId}`,
            `👤 ownerId: ${result.ownerId}`,
            result.pid ? `🧵 pid: ${result.pid}` : "",
            result.error || "worker 已退出",
            result.progressText ? `\n## 最后进度\n${result.progressText}` : "",
        ].filter(Boolean).join("\n");
    }
    return result.resultText || result.error || `✅ 后台任务 ${result.taskId} 已完成`;
}
