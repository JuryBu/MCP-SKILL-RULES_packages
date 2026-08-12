import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, ensureModelVisibleToolResult, formatElapsed } from "../lifecycle.js";
import { killProcessTree } from "../executor.js";
import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "../owner.js";
import { acquireResourceLease, adoptResourceLease, serializeResourceAdmissionError, type ManagedResourceLease } from "../resource-admission-runtime.js";
import { getWindowsJobRunnerPath, hasWindowsJobRunner, readWindowsJobMetadata } from "../windows-job-runner.js";

/**
 * MCP Sandbox Launch — 长任务脱离执行
 *
 * 适用于训练模型、大规模数据处理等需要数小时~数天的任务。
 * 进程完全脱离 MCP 生命周期，日志写磁盘，注册表持久化。
 *
 * 核心特性：
 * - bootstrap 先退出，再由 detached worker 托管命令，避免 backend 进程树回收误杀长任务
 * - stdout/stderr 重定向到磁盘日志文件
 * - 注册表存 JSON 文件，跨 MCP 重启持久化
 * - status 支持 waitSeconds（sleep + 早退）
 */

// ── 常量 ──

const DATA_ROOT = process.env.SANDBOX_DATA_ROOT
    || path.join(process.env.CODEX_TOOLKIT_DATA_ROOT || path.join(os.homedir(), ".codex-toolkit"), "sandbox-data");
const LAUNCH_DIR = process.env.SANDBOX_LAUNCH_DIR || path.join(DATA_ROOT, "launches");
const REGISTRY_FILE = path.join(LAUNCH_DIR, "registry.json");
const TASK_REGISTRY_DIR = path.join(LAUNCH_DIR, "tasks");
const WRAPPER_FILE = path.join(LAUNCH_DIR, "launch-wrapper.cjs");
const BOOTSTRAP_FILE = path.join(LAUNCH_DIR, "launch-bootstrap.cjs");

// ── 类型 ──

interface LaunchTask {
    id: string;
    pid: number;
    command: string;
    commandHash?: string;
    processIdentity?: LaunchProcessIdentity;
    ownerId?: string;
    cwd: string;
    stdoutLog: string;
    stderrLog: string;
    specPath?: string;
    exitMarkerPath?: string;
    createdAtMs?: number;
    finishedAtMs?: number;
    missingPidSinceMs?: number;
    startTime: number;
    status: "running" | "done" | "failed";
    exitCode: number | null;
    reservationMB?: number;
    maxMemoryMB?: number;
    memoryMetadataPath?: string;
    peakMemoryMB?: number;
    memoryLimitHit?: boolean;
    statusReason?: string;
}

const launchLeases = new Map<string, ManagedResourceLease>();

function releaseLaunchLease(taskId: string): void {
    launchLeases.get(taskId)?.release();
    launchLeases.delete(taskId);
}

interface LaunchTombstone {
    id: string;
    deleted: true;
    deletedAtMs: number;
}

interface ExitMarker {
    done?: boolean;
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    error?: string;
    startedAtMs?: number;
    finishedAtMs?: number;
    peakMemoryBytes?: number;
    memoryLimitHit?: boolean;
}

interface ProcessInfo {
    commandLine?: string;
    createdAtMs?: number;
    startId?: string;
}

export interface LaunchProcessIdentity {
    pid: number;
    startId: string;
}

export interface LaunchProcessIdentityDependencies {
    observeIdentity?: (pid: number) => LaunchProcessIdentity | undefined;
    observeProcessInfo?: (pid: number) => ProcessInfo | null;
}

export type LaunchProcessIdentityValidationResult = "matching" | "not_running" | "identity_missing" | "identity_mismatch";

const LAUNCH_REAPER_INTERVAL_MS = 15_000;
const LAUNCH_EXIT_MARKER_GRACE_MS = 2_000;
let launchReaperStarted = false;

// ── 注册表管理 ──

function ensureLaunchDir(): void {
    if (!fs.existsSync(LAUNCH_DIR)) {
        fs.mkdirSync(LAUNCH_DIR, { recursive: true });
    }
}

function ensureTaskRegistryDir(): void {
    ensureLaunchDir();
    if (!fs.existsSync(TASK_REGISTRY_DIR)) {
        fs.mkdirSync(TASK_REGISTRY_DIR, { recursive: true });
    }
}

function safeTaskFileName(taskId: string): string {
    return taskId.replace(/[^a-zA-Z0-9._-]/gu, "_") || "unknown";
}

function taskRegistryPath(taskId: string): string {
    return path.join(TASK_REGISTRY_DIR, `${safeTaskFileName(taskId)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLaunchTask(value: unknown): LaunchTask | null {
    if (!isRecord(value) || value.deleted === true) return null;
    if (typeof value.id !== "string" || !value.id) return null;
    if (typeof value.pid !== "number") return null;
    if (typeof value.command !== "string") return null;
    if (typeof value.cwd !== "string") return null;
    if (typeof value.stdoutLog !== "string" || typeof value.stderrLog !== "string") return null;
    if (typeof value.startTime !== "number") return null;
    if (value.status !== "running" && value.status !== "done" && value.status !== "failed") return null;
    if (typeof value.exitCode !== "number" && value.exitCode !== null) return null;
    return value as unknown as LaunchTask;
}

function readLegacyRegistry(): LaunchTask[] {
    try {
        if (fs.existsSync(REGISTRY_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
            if (!Array.isArray(parsed)) return [];
            return parsed.map(normalizeLaunchTask).filter((task): task is LaunchTask => Boolean(task));
        }
    } catch { /* 损坏则重建 */ }
    return [];
}

function readTaskRegistryFiles(): { tasks: LaunchTask[]; tombstones: Set<string> } {
    const tasks: LaunchTask[] = [];
    const tombstones = new Set<string>();
    try {
        if (!fs.existsSync(TASK_REGISTRY_DIR)) return { tasks, tombstones };
        for (const entry of fs.readdirSync(TASK_REGISTRY_DIR, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(TASK_REGISTRY_DIR, entry.name), "utf-8"));
                if (isRecord(parsed) && parsed.deleted === true && typeof parsed.id === "string") {
                    tombstones.add(parsed.id);
                    continue;
                }
                const task = normalizeLaunchTask(parsed);
                if (task) tasks.push(task);
            } catch {
                // 单个 task 文件损坏时跳过，避免影响其它任务。
            }
        }
    } catch {
        // 注册目录不可读时回退到 legacy registry。
    }
    return { tasks, tombstones };
}

function readAllTasks(): LaunchTask[] {
    const current = readTaskRegistryFiles();
    const byId = new Map<string, LaunchTask>();
    for (const task of current.tasks) byId.set(task.id, task);
    for (const task of readLegacyRegistry()) {
        if (current.tombstones.has(task.id) || byId.has(task.id)) continue;
        byId.set(task.id, task);
    }
    return [...byId.values()];
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    ensureTaskRegistryDir();
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
}

function writeTask(task: LaunchTask): void {
    writeJsonAtomic(taskRegistryPath(task.id), task);
}

function deleteTask(taskId: string): void {
    const tombstone: LaunchTombstone = {
        id: taskId,
        deleted: true,
        deletedAtMs: Date.now(),
    };
    writeJsonAtomic(taskRegistryPath(taskId), tombstone);
}

function generateId(): string {
    return newUuid();
}

function commandHash(command: string, cwd: string): string {
    return createHash("sha256").update(command).update("\0").update(cwd).digest("hex");
}

function validateLaunchCwd(cwd: string): string | null {
    try {
        const stat = fs.statSync(cwd, { throwIfNoEntry: false });
        if (!stat) return `工作目录不存在: ${cwd}`;
        if (!stat.isDirectory()) return `工作目录不是目录: ${cwd}`;
        return null;
    } catch (err) {
        return `工作目录不可访问: ${cwd} (${err instanceof Error ? err.message : String(err)})`;
    }
}

function ensureWrapperFile(): void {
    ensureLaunchDir();
    const worker = `const fs = require("fs");
const { spawn } = require("child_process");

const specPath = process.argv[2];
const handshakePath = process.argv[3];
if (!specPath || !handshakePath) {
  process.exit(125);
}

function writeMarker(markerPath, data) {
  const tmp = markerPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, markerPath);
}

function writeHandshake(value) {
  const tmp = handshakePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, handshakePath);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const startedAtMs = Date.now();
let stdoutFd;
let stderrFd;
try {
  stdoutFd = fs.openSync(spec.stdoutLog, "a");
  stderrFd = fs.openSync(spec.stderrLog, "a");
  const useJobRunner = process.platform === "win32" && spec.windowsJobRunner;
  const child = useJobRunner ? spawn(spec.windowsJobRunner, [
    "--memory-mb", String(spec.maxMemoryMB),
    "--metadata", spec.memoryMetadataPath,
    "--cwd", spec.cwd,
    "--shell-base64", Buffer.from(spec.command, "utf8").toString("base64"),
  ], {
    cwd: spec.cwd,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
    env: { ...process.env, ...(spec.env || {}) },
  }) : spawn(spec.command, [], {
    cwd: spec.cwd,
    shell: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
    env: { ...process.env, ...(spec.env || {}) },
  });

  child.on("error", (err) => {
    try { writeHandshake({ error: err.message }); } catch {}
    writeMarker(spec.exitMarkerPath, {
      done: true,
      exitCode: null,
      signal: null,
      error: err.message,
      startedAtMs,
      finishedAtMs: Date.now(),
    });
    process.exit(124);
  });

  child.on("spawn", () => {
    if (!child.pid) {
      try { writeHandshake({ error: "command PID missing" }); } catch {}
      return;
    }
    writeHandshake({ pid: child.pid });
  });

  child.on("close", (code, signal) => {
    let memory = null;
    try { memory = spec.memoryMetadataPath ? JSON.parse(fs.readFileSync(spec.memoryMetadataPath, "utf8")) : null; } catch {}
    writeMarker(spec.exitMarkerPath, {
      done: true,
      exitCode: code,
      signal,
      startedAtMs,
      finishedAtMs: Date.now(),
      peakMemoryBytes: memory && memory.peakMemoryBytes,
      memoryLimitHit: Boolean(memory && memory.memoryLimitHit),
    });
    process.exit(typeof code === "number" ? code : 1);
  });
} catch (err) {
  try {
    writeMarker(spec.exitMarkerPath, {
      done: true,
      exitCode: null,
      signal: null,
      error: err && err.message ? err.message : String(err),
      startedAtMs,
      finishedAtMs: Date.now(),
    });
  } catch {}
  process.exit(123);
} finally {
  if (stdoutFd !== undefined) {
    try { fs.closeSync(stdoutFd); } catch {}
  }
  if (stderrFd !== undefined) {
    try { fs.closeSync(stderrFd); } catch {}
  }
}
`;
    const bootstrap = `const fs = require("fs");
const { spawn } = require("child_process");

const workerPath = process.argv[2];
const specPath = process.argv[3];
const handshakePath = process.argv[4];

function writeHandshake(value) {
  const tmp = handshakePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
  fs.renameSync(tmp, handshakePath);
}

try {
  const child = spawn(process.execPath, [workerPath, specPath, handshakePath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  child.once("error", (err) => {
    try { writeHandshake({ error: err.message }); } catch {}
    process.exit(124);
  });
  child.once("spawn", () => {
    child.unref();
    process.exit(0);
  });
} catch (err) {
  try { writeHandshake({ error: err && err.message ? err.message : String(err) }); } catch {}
  process.exit(122);
}
`;
    if (!fs.existsSync(WRAPPER_FILE) || fs.readFileSync(WRAPPER_FILE, "utf-8") !== worker) {
        fs.writeFileSync(WRAPPER_FILE, worker, "utf-8");
    }
    if (!fs.existsSync(BOOTSTRAP_FILE) || fs.readFileSync(BOOTSTRAP_FILE, "utf-8") !== bootstrap) {
        fs.writeFileSync(BOOTSTRAP_FILE, bootstrap, "utf-8");
    }
}

/**
 * 检查 PID 是否存活
 */
function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readExitMarker(task: LaunchTask): ExitMarker | null {
    if (!task.exitMarkerPath) return null;
    try {
        if (!fs.existsSync(task.exitMarkerPath)) return null;
        return JSON.parse(fs.readFileSync(task.exitMarkerPath, "utf-8")) as ExitMarker;
    } catch {
        return null;
    }
}

function getProcessInfo(pid: number): ProcessInfo | null {
    try {
        if (process.platform === "win32") {
            const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { @{CreationDate=$p.CreationDate.ToUniversalTime().ToString('o'); StartId=$p.CreationDate.ToUniversalTime().Ticks.ToString(); CommandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
            const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
                encoding: "utf-8",
                windowsHide: true,
                timeout: 5000,
            }).trim();
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const createdAtMs = parsed.CreationDate ? new Date(parsed.CreationDate).getTime() : undefined;
            return {
                commandLine: typeof parsed.CommandLine === "string" ? parsed.CommandLine : undefined,
                createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
                startId: typeof parsed.StartId === "string" && parsed.StartId ? parsed.StartId : undefined,
            };
        }

        const cmdlinePath = `/proc/${pid}/cmdline`;
        const statPath = `/proc/${pid}/stat`;
        if (fs.existsSync(cmdlinePath) && fs.existsSync(statPath)) {
            const commandLine = fs.readFileSync(cmdlinePath, "utf-8").replace(/\0/g, " ").trim();
            const stat = fs.readFileSync(statPath, "utf-8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
            return { commandLine, startId: fields[19] || undefined };
        }

        const startId = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 3000,
        }).trim();
        if (!startId) return null;
        const commandLine = execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 3000,
        }).trim();
        const createdAtMs = new Date(startId).getTime();
        return {
            commandLine: commandLine || undefined,
            createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
            startId,
        };
    } catch {
        return null;
    }
    return null;
}

export function readLaunchProcessIdentity(pid: number): LaunchProcessIdentity | undefined {
    if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return undefined;
    const info = getProcessInfo(pid);
    return info?.startId ? { pid, startId: info.startId } : undefined;
}

async function waitForLaunchProcessIdentity(pid: number, timeoutMs = 3_000): Promise<LaunchProcessIdentity | undefined> {
    const deadline = Date.now() + timeoutMs;
    do {
        const identity = readLaunchProcessIdentity(pid);
        if (identity) return identity;
        if (!isPidAlive(pid)) return undefined;
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return readLaunchProcessIdentity(pid);
}

async function waitForLaunchWorkerHandshake(
    handshakePath: string,
    timeoutMs = 3_000,
): Promise<{ pid?: number; error?: string } | undefined> {
    const deadline = Date.now() + timeoutMs;
    do {
        try {
            if (fs.existsSync(handshakePath)) {
                return JSON.parse(fs.readFileSync(handshakePath, "utf-8")) as { pid?: number; error?: string };
            }
        } catch {
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return undefined;
}

export function validateLaunchProcessIdentity(
    expected: LaunchProcessIdentity | undefined,
    dependencies: LaunchProcessIdentityDependencies = {},
): LaunchProcessIdentityValidationResult {
    if (!expected) return "identity_missing";
    const observed = (dependencies.observeIdentity || readLaunchProcessIdentity)(expected.pid);
    if (!observed) return isPidAlive(expected.pid) ? "identity_missing" : "not_running";
    if (observed.pid !== expected.pid || observed.startId !== expected.startId) return "identity_mismatch";
    return "matching";
}

function migrateLegacyLaunchIdentity(
    task: LaunchTask,
    dependencies: LaunchProcessIdentityDependencies,
): LaunchProcessIdentityValidationResult {
    const info = (dependencies.observeProcessInfo || getProcessInfo)(task.pid);
    if (!info) return isPidAlive(task.pid) ? "identity_missing" : "not_running";
    if (!info.startId) return "identity_missing";

    const commandLine = info.commandLine || "";
    const hash = task.commandHash || commandHash(task.command, task.cwd);
    const markerName = task.exitMarkerPath ? path.basename(task.exitMarkerPath) : "";
    if (!commandLine || (!commandLine.includes(hash) && (!markerName || !commandLine.includes(markerName)))) {
        return "identity_missing";
    }

    const createdAtMs = task.createdAtMs ?? task.startTime;
    if (!info.createdAtMs || Math.abs(info.createdAtMs - createdAtMs) > 60_000) {
        return "identity_mismatch";
    }

    task.processIdentity = { pid: task.pid, startId: info.startId };
    return "matching";
}

function validatePidForTask(
    task: LaunchTask,
    dependencies: LaunchProcessIdentityDependencies = {},
): { ok: boolean; reason?: string } {
    const validation = task.processIdentity
        ? validateLaunchProcessIdentity(task.processIdentity, dependencies)
        : migrateLegacyLaunchIdentity(task, dependencies);
    if (validation === "matching") return { ok: true };
    if (validation === "not_running") return { ok: false, reason: "PID 已不存在" };
    if (validation === "identity_mismatch") return { ok: false, reason: "PID 启动标识不匹配当前任务" };
    return { ok: false, reason: "无法读取或安全迁移 PID 启动标识，拒绝继续以避免 PID 复用误杀" };
}

/**
 * 刷新任务状态（检查 PID 是否还在）
 */
function refreshTaskStatus(task: LaunchTask, dependencies: LaunchProcessIdentityDependencies = {}): void {
    if (task.status !== "running") return;

    const marker = readExitMarker(task);
    if (marker?.done) {
        task.exitCode = typeof marker.exitCode === "number" ? marker.exitCode : null;
        task.finishedAtMs = marker.finishedAtMs;
        task.status = task.exitCode === 0 ? "done" : "failed";
        task.peakMemoryMB = Number.isFinite(marker.peakMemoryBytes)
            ? Math.round(Number(marker.peakMemoryBytes) / 1024 / 1024)
            : undefined;
        task.memoryLimitHit = marker.memoryLimitHit === true;
        task.statusReason = task.memoryLimitHit ? "memory_limit" : undefined;
        task.missingPidSinceMs = undefined;
        releaseLaunchLease(task.id);
        return;
    }

    const validation = validatePidForTask(task, dependencies);
    if (!validation.ok) {
        const pidMissing = validation.reason === "PID 已不存在";
        if (pidMissing && task.exitMarkerPath) {
            const now = Date.now();
            task.missingPidSinceMs ??= now;
            task.statusReason = "PID 已退出，等待完成标记落盘";
            if (now - task.missingPidSinceMs < LAUNCH_EXIT_MARKER_GRACE_MS) return;
        }
        task.status = pidMissing && !task.exitMarkerPath ? "done" : "failed";
        task.exitCode = task.status === "done" ? 0 : null;
        task.finishedAtMs = Date.now();
        task.statusReason = pidMissing
            ? undefined
            : `无法确认任务 PID 身份: ${validation.reason || "未知原因"}`;
        releaseLaunchLease(task.id);
    }
}

export function reapLaunchTasksOnce(
    dependencies: LaunchProcessIdentityDependencies = {},
    adoptMissingLeases = true,
): { running: number; terminal: number; adopted: number } {
    const tasks = readAllTasks();
    let adopted = 0;
    for (const task of tasks) {
        refreshTaskStatus(task, dependencies);
        if (task.status === "running" && adoptMissingLeases && !launchLeases.has(task.id)) {
            launchLeases.set(task.id, adoptResourceLease(task.reservationMB || 256));
            adopted += 1;
        }
        writeTask(task);
    }
    return {
        running: tasks.filter(task => task.status === "running").length,
        terminal: tasks.filter(task => task.status !== "running").length,
        adopted,
    };
}

function ensureLaunchReaper(): void {
    if (launchReaperStarted) return;
    launchReaperStarted = true;
    const timer = setInterval(() => {
        try {
            reapLaunchTasksOnce();
        } catch (err) {
            console.warn(`[launch] resource reaper failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, LAUNCH_REAPER_INTERVAL_MS);
    timer.unref?.();
}

async function waitForLaunchTask(task: LaunchTask, waitSeconds: number): Promise<void> {
    const waitMs = Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    refreshTaskStatus(task);
    if (waitMs <= 0 || task.status !== "running") return;

    await new Promise<void>((resolve) => {
        let done = false;
        let timer: NodeJS.Timeout;
        let interval: NodeJS.Timeout;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearInterval(interval);
            resolve();
        };

        timer = setTimeout(finish, waitMs);
        interval = setInterval(() => {
            refreshTaskStatus(task);
            if (task.status !== "running") finish();
        }, 2000);
        timer.unref?.();
        interval.unref?.();
    });
}

/**
 * 读取文件尾部 N 行
 */
function tailFile(filePath: string, lines: number): string {
    try {
        if (!fs.existsSync(filePath)) return "(日志文件尚未创建)";
        const content = fs.readFileSync(filePath, "utf-8");
        if (!content.trim()) return "(日志为空)";
        const allLines = content.trimEnd().split("\n");
        if (allLines.length <= lines) return allLines.join("\n");
        return allLines.slice(-lines).join("\n");
    } catch (err) {
        return `(读取失败: ${err})`;
    }
}

/**
 * 获取文件大小
 */
function getFileSize(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

// ── 导出（供 status 工具调用） ──

export function getLaunchTaskCount(): { running: number; total: number } {
    const tasks = readAllTasks();
    tasks.forEach(task => refreshTaskStatus(task));
    return {
        running: tasks.filter(t => t.status === "running").length,
        total: tasks.length,
    };
}

// ── 注册 MCP 工具 ──

const LaunchParamsShape = {
    command: z.string().optional()
        .describe("要执行的命令（启动时必须）"),
    cwd: z.string().optional()
        .describe("工作目录，默认为当前目录"),
    logDir: z.string().optional()
        .describe("日志存放目录（可选，默认 sandbox-data/launches/）"),
    action: z.enum(["status", "kill", "list", "clean"]).optional()
        .describe("管理任务：status=查看进度，kill=终止，list=列表，clean=清理已完成任务"),
    taskId: z.string().optional()
        .describe("任务 ID（status/kill/clean 时使用）"),
    tailLines: z.number().min(1).max(200).optional()
        .describe("status 时显示日志尾部行数，默认 10"),
    waitSeconds: z.number().min(1).max(300).optional()
        .describe("status 前等待秒数（1-300），任务完成时提前返回"),
    ownerId: z.string().optional()
        .describe("任务归属 ID；未传时优先使用当前 MCP session 身份"),
    maxMemoryMB: z.number().int().min(16).max(1536).optional()
        .describe("长期任务进程树提交内存硬上限，默认256MB"),
    memoryRequestMB: z.number().int().min(16).max(1536).optional()
        .describe("长期任务调度预期内存，必须不大于 maxMemoryMB"),
};

export function registerLaunch(server: McpServer): void {
    reapLaunchTasksOnce();
    ensureLaunchReaper();
    server.tool(
        "sandbox_launch",
        `长任务脱离执行。进程完全独立于 MCP，可跑数小时~数天。
适合：模型训练、大规模数据处理、长时间编译等。

启动：sandbox_launch(command="python train.py", cwd="项目目录")
查看：sandbox_launch(action="status", taskId="launch-001", tailLines=5, waitSeconds=60)
终止：sandbox_launch(action="kill", taskId="launch-001")
列表：sandbox_launch(action="list")
清理：sandbox_launch(action="clean")

特性：
- 进程脱离 MCP，关闭 IDE / 换对话不影响
- 日志写磁盘，按需读取尾部几行
- 注册表持久化，新对话可用 list 找回任务
- waitSeconds 主动等待后返回，避免频繁轮询`,
        LaunchParamsShape,
        async (params: Record<string, unknown>, extra?: { signal?: AbortSignal; sessionId?: string }) => {
            const startTime = Date.now();
            touchActivity();

            const action = params.action as string | undefined;
            const ownerId = normalizeOwnerId(params.ownerId ?? extra?.sessionId);

            const appendTiming = (result: { content: Array<{ type: "text"; text: string }> }) => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                result.content[0].text += ` ⏱ 耗时 ${elapsed}s`;
                return result;
            };

            // ── list ──
            if (action === "list") {
                const tasks = readAllTasks();
                tasks.forEach(task => refreshTaskStatus(task));
                tasks.forEach(writeTask);
                const visibleTasks = tasks.filter(t => hasOwnerAccess(t.ownerId, ownerId));

                if (visibleTasks.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "📋 无活跃任务\n" }],
                    });
                }

                const lines = visibleTasks.map(t => {
                    const elapsed = formatElapsed(Date.now() - t.startTime);
                    const statusIcon = t.status === "running" ? "🔄" : t.status === "done" ? "✅" : "❌";
                    return `  ${statusIcon} ${t.id} | owner=${t.ownerId || "global"} | ${t.command.slice(0, 60)} | ${t.status} | ${elapsed} | PID ${t.pid}`;
                });

                return appendTiming({
                    content: [{ type: "text" as const, text: `📋 任务列表 (${visibleTasks.length}):\n${lines.join("\n")}\n` }],
                });
            }

            // ── clean ──
            if (action === "clean") {
                const tasks = readAllTasks();
                tasks.forEach(task => refreshTaskStatus(task));
                const taskId = params.taskId as string | undefined;

                const toClean = taskId
                    ? tasks.filter(t => t.id === taskId && t.status !== "running" && hasOwnerAccess(t.ownerId, ownerId))
                    : tasks.filter(t => t.status !== "running" && hasOwnerAccess(t.ownerId, ownerId));

                let cleaned = 0;
                for (const t of toClean) {
                    try { fs.unlinkSync(t.stdoutLog); } catch { /* */ }
                    try { fs.unlinkSync(t.stderrLog); } catch { /* */ }
                    try { if (t.exitMarkerPath) fs.unlinkSync(t.exitMarkerPath); } catch { /* */ }
                    try { if (t.specPath) fs.unlinkSync(t.specPath); } catch { /* */ }
                    try { if (t.memoryMetadataPath) fs.unlinkSync(t.memoryMetadataPath); } catch { /* */ }
                    deleteTask(t.id);
                    cleaned++;
                }

                const remaining = tasks.filter(t => !toClean.includes(t));
                remaining.forEach(writeTask);

                return appendTiming({
                    content: [{ type: "text" as const, text: `🧹 清理了 ${cleaned} 个已完成任务（剩余 ${remaining.length} 个）\n` }],
                });
            }

            // ── 需要 taskId 的操作 ──
            if (action === "status" || action === "kill") {
                const taskId = params.taskId as string | undefined;
                if (!taskId) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "❌ 需要 taskId 参数\n" }],
                    });
                }

                const tasks = readAllTasks();
                const task = tasks.find(t => t.id === taskId);
                if (!task) {
                    const available = tasks.map(t => t.id);
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `❌ 未找到任务 ${taskId}\n可用任务: ${available.length > 0 ? available.join(", ") : "(无)"}`,
                        }],
                    });
                }
                if (!hasOwnerAccess(task.ownerId, ownerId)) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: ownerMismatchText("launch 任务", taskId) }],
                    });
                }

                // ── kill ──
                if (action === "kill") {
                    refreshTaskStatus(task);
                    writeTask(task);
                    if (task.status !== "running") {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `⚠️ 任务 ${taskId} 已结束 (${task.status})\n` }],
                        });
                    }

                    const validation = validatePidForTask(task);
                    if (!validation.ok) {
                        task.status = "failed";
                        task.exitCode = null;
                        task.finishedAtMs = Date.now();
                        task.statusReason = `无法确认任务 PID 身份: ${validation.reason || "未知原因"}`;
                        releaseLaunchLease(task.id);
                        writeTask(task);
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ 终止前校验失败: ${validation.reason}\n` }],
                        });
                    }

                    try {
                        killProcessTree(task.pid);
                        task.status = "failed";
                        task.exitCode = -1;
                        task.finishedAtMs = Date.now();
                        releaseLaunchLease(task.id);
                        writeTask(task);
                        return appendTiming({
                            content: [{ type: "text" as const, text: `🛑 已终止任务 ${taskId} (PID ${task.pid})\n` }],
                        });
                    } catch (err) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ 终止失败: ${err}\n` }],
                        });
                    }
                }

                // ── status ──
                const waitSeconds = (params.waitSeconds as number | undefined) || 0;
                const tailLines = (params.tailLines as number | undefined) || 10;

                // 主动等待
                await waitForLaunchTask(task, waitSeconds);

                // 刷新状态
                refreshTaskStatus(task);
                writeTask(task);

                const elapsed = formatElapsed(Date.now() - task.startTime);
                const logTail = tailFile(task.stdoutLog, tailLines);
                const stdoutSize = getFileSize(task.stdoutLog);
                const stderrSize = getFileSize(task.stderrLog);

                if (task.status === "running") {
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `🔄 ${taskId} 运行中 | owner=${task.ownerId || "global"} | ${elapsed} | PID ${task.pid}\n📄 stdout ${stdoutSize} bytes | stderr ${stderrSize} bytes\n📋 最近 ${tailLines} 行:\n${logTail}\n`,
                        }],
                    });
                } else {
                    const icon = task.status === "done" ? "✅" : "❌";
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `${icon} ${taskId} ${task.status === "done" ? "已完成" : "已失败"} | ${elapsed} | exitCode=${task.exitCode}${task.statusReason ? `\n⚠️ 状态说明: ${task.statusReason}` : ""}\n📄 stdout ${stdoutSize} bytes | stderr ${stderrSize} bytes\n📋 最近 ${tailLines} 行:\n${logTail}\n`,
                        }],
                    });
                }
            }

            // ── 启动新任务 ──
            const command = params.command as string | undefined;
            if (!command) {
                return appendTiming({
                    content: [{ type: "text" as const, text: "❌ 启动需要 command 参数\n" }],
                });
            }

            const cwd = (params.cwd as string | undefined) || process.cwd();
            const cwdError = validateLaunchCwd(cwd);
            if (cwdError) {
                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ ${cwdError}\n` }],
                });
            }

            ensureLaunchDir();
            ensureWrapperFile();
            const taskId = generateId();
            const logDirParam = params.logDir as string | undefined;
            const logDir = logDirParam || LAUNCH_DIR;

            // 确保日志目录存在
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const stdoutLog = path.join(logDir, `${taskId}.stdout.log`);
            const stderrLog = path.join(logDir, `${taskId}.stderr.log`);
            const exitMarkerPath = path.join(logDir, `${taskId}.done.json`);
            const specPath = path.join(logDir, `${taskId}.spec.json`);
            const handshakePath = path.join(logDir, `${taskId}.worker.json`);
            const memoryMetadataPath = path.join(logDir, `${taskId}.memory.json`);
            const hash = commandHash(command, cwd);
            const maxMemoryMB = (params.maxMemoryMB as number | undefined) || 256;
            const reservationMB = (params.memoryRequestMB as number | undefined)
                ?? Math.min(maxMemoryMB, Math.max(64, Math.ceil(maxMemoryMB / 4)));
            if (reservationMB > maxMemoryMB) {
                return appendTiming({
                    content: [{ type: "text" as const, text: "❌ memoryRequestMB 不能大于 maxMemoryMB\n" }],
                });
            }
            fs.writeFileSync(specPath, JSON.stringify({
                command,
                cwd,
                stdoutLog,
                stderrLog,
                exitMarkerPath,
                memoryMetadataPath,
                windowsJobRunner: hasWindowsJobRunner() ? getWindowsJobRunnerPath() : null,
                maxMemoryMB,
                env: { PYTHONUNBUFFERED: "1" },
            }, null, 2), "utf-8");

            let resourceLease: ManagedResourceLease | null = null;
            let workerPid: number | null = null;
            try {
                const acquiredLease = await acquireResourceLease({
                    ownerId,
                    reservationMB,
                    signal: extra?.signal,
                });
                resourceLease = acquiredLease;
                if (extra?.signal?.aborted) {
                    acquiredLease.release();
                    try { fs.unlinkSync(specPath); } catch { }
                    try { fs.unlinkSync(memoryMetadataPath); } catch { }
                    return appendTiming({
                        content: [{ type: "text" as const, text: "⏹️ launch 调用已取消，任务未启动\n" }],
                    });
                }
                const createdAtMs = Date.now();
                const bootstrap = spawn(process.execPath, [BOOTSTRAP_FILE, WRAPPER_FILE, specPath, handshakePath], {
                    cwd,
                    stdio: "ignore",
                    windowsHide: true,
                    env: { ...process.env, PYTHONUNBUFFERED: "1" },
                });
                bootstrap.unref();

                const handshake = await waitForLaunchWorkerHandshake(handshakePath);
                workerPid = Number(handshake?.pid);
                if (!Number.isInteger(workerPid) || workerPid <= 0) {
                    throw new Error(`launch bootstrap 未返回 worker PID${handshake?.error ? `: ${handshake.error}` : ""}`);
                }
                const bootstrapExited = bootstrap.exitCode !== null || await Promise.race([
                    new Promise<boolean>(resolve => bootstrap.once("close", () => resolve(true))),
                    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
                ]);
                if (!bootstrapExited) {
                    killProcessTree(workerPid);
                    if (bootstrap.pid) killProcessTree(bootstrap.pid);
                    throw new Error("launch bootstrap 未在 1 秒内退出，已停止 worker 以避免 backend 重拉误伤");
                }
                const processIdentity = await waitForLaunchProcessIdentity(workerPid);
                if (!processIdentity) {
                    const memory = readWindowsJobMetadata(memoryMetadataPath);
                    killProcessTree(workerPid);
                    if (memory?.memoryLimitHit) {
                        throw new Error(`任务启动阶段触发 ${maxMemoryMB}MB 进程树内存硬上限`);
                    }
                    throw new Error("无法读取新任务的 PID 启动标识，已停止任务以避免后续 PID 复用误杀");
                }
                try { fs.unlinkSync(handshakePath); } catch { }

                const task: LaunchTask = {
                    id: taskId,
                    pid: workerPid,
                    command,
                    commandHash: hash,
                    processIdentity,
                    ownerId,
                    cwd,
                    stdoutLog,
                    stderrLog,
                    specPath,
                    exitMarkerPath,
                    createdAtMs,
                    startTime: createdAtMs,
                    status: "running",
                    exitCode: null,
                    reservationMB,
                    maxMemoryMB,
                    memoryMetadataPath,
                };

                launchLeases.set(taskId, acquiredLease);

                writeTask(task);

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `🚀 长任务已启动\n📋 taskId: ${taskId}\n👤 ownerId: ${ownerId}\n📂 PID: ${task.pid}\n📁 cwd: ${cwd}\n调度请求: ${reservationMB}MB\n内存硬上限: ${maxMemoryMB}MB\n📄 stdout: ${stdoutLog}\n📄 stderr: ${stderrLog}\n📄 exitMarker: ${exitMarkerPath}\n\n💡 用法:\n  sandbox_launch(action="status", taskId="${taskId}", tailLines=5, waitSeconds=60)\n  sandbox_launch(action="kill", taskId="${taskId}")\n`,
                    }],
                });
            } catch (err) {
                resourceLease?.release();
                if (workerPid) killProcessTree(workerPid);
                try { fs.unlinkSync(specPath); } catch { /* */ }
                try { fs.unlinkSync(handshakePath); } catch { /* */ }
                try { fs.unlinkSync(memoryMetadataPath); } catch { /* */ }
                const admissionError = serializeResourceAdmissionError(err);
                if (admissionError) {
                    return ensureModelVisibleToolResult({
                        isError: true,
                        structuredContent: { error: admissionError },
                        content: [{ type: "text" as const, text: `❌ ${admissionError.type}: launch 尚未启动；等待 ${admissionError.queueWaitMs}ms 后仍无资源，建议 ${admissionError.retryAfterMs}ms 后重试` }],
                    });
                }
                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ 启动失败: ${err}\n` }],
                });
            }
        }
    );
}
