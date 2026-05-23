import { execFileSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, formatElapsed } from "../lifecycle.js";
import { killProcessTree } from "../executor.js";
import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "../owner.js";

/**
 * MCP Sandbox Launch — 长任务脱离执行
 *
 * 适用于训练模型、大规模数据处理等需要数小时~数天的任务。
 * 进程完全脱离 MCP 生命周期，日志写磁盘，注册表持久化。
 *
 * 核心特性：
 * - spawn + unref()：进程独立于 MCP（Windows 不用 detached 避免断开 fd 继承）
 * - stdout/stderr 重定向到磁盘日志文件
 * - 注册表存 JSON 文件，跨 MCP 重启持久化
 * - status 支持 waitSeconds（sleep + 早退）
 */

// ── 常量 ──

const DATA_ROOT = process.env.SANDBOX_DATA_ROOT
    || (process.env.CODEX_TOOLKIT_DATA_ROOT
        ? path.join(process.env.CODEX_TOOLKIT_DATA_ROOT, "sandbox-data")
        : path.join(os.homedir(), ".codex-toolkit", "sandbox-data"));
const LAUNCH_DIR = path.join(DATA_ROOT, "launches");
const REGISTRY_FILE = path.join(LAUNCH_DIR, "registry.json");
const WRAPPER_FILE = path.join(LAUNCH_DIR, "launch-wrapper.cjs");

// ── 类型 ──

interface LaunchTask {
    id: string;
    pid: number;
    command: string;
    commandHash?: string;
    ownerId?: string;
    cwd: string;
    stdoutLog: string;
    stderrLog: string;
    specPath?: string;
    exitMarkerPath?: string;
    createdAtMs?: number;
    finishedAtMs?: number;
    startTime: number;
    status: "running" | "done" | "failed";
    exitCode: number | null;
}

interface ExitMarker {
    done?: boolean;
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    error?: string;
    startedAtMs?: number;
    finishedAtMs?: number;
}

interface ProcessInfo {
    commandLine?: string;
    createdAtMs?: number;
}

// ── 注册表管理 ──

function ensureLaunchDir(): void {
    if (!fs.existsSync(LAUNCH_DIR)) {
        fs.mkdirSync(LAUNCH_DIR, { recursive: true });
    }
}

function loadRegistry(): LaunchTask[] {
    try {
        if (fs.existsSync(REGISTRY_FILE)) {
            return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
        }
    } catch { /* 损坏则重建 */ }
    return [];
}

function saveRegistry(tasks: LaunchTask[]): void {
    ensureLaunchDir();
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

function generateId(): string {
    return newUuid();
}

function commandHash(command: string, cwd: string): string {
    return createHash("sha256").update(command).update("\0").update(cwd).digest("hex");
}

function ensureWrapperFile(): void {
    ensureLaunchDir();
    const wrapper = `const fs = require("fs");
const { spawn } = require("child_process");

const specPath = process.argv[2];
if (!specPath) {
  process.exit(125);
}

function writeMarker(markerPath, data) {
  const tmp = markerPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, markerPath);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const startedAtMs = Date.now();
let stdoutFd;
let stderrFd;
try {
  stdoutFd = fs.openSync(spec.stdoutLog, "a");
  stderrFd = fs.openSync(spec.stderrLog, "a");
  const child = spawn(spec.command, [], {
    cwd: spec.cwd,
    shell: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
    env: { ...process.env, ...(spec.env || {}) },
  });

  child.on("error", (err) => {
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

  child.on("close", (code, signal) => {
    writeMarker(spec.exitMarkerPath, {
      done: true,
      exitCode: code,
      signal,
      startedAtMs,
      finishedAtMs: Date.now(),
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
    if (!fs.existsSync(WRAPPER_FILE) || fs.readFileSync(WRAPPER_FILE, "utf-8") !== wrapper) {
        fs.writeFileSync(WRAPPER_FILE, wrapper, "utf-8");
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
            const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { @{CreationDate=$p.CreationDate.ToUniversalTime().ToString('o'); CommandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
            const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
                encoding: "utf-8",
                windowsHide: true,
                timeout: 5000,
            }).trim();
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const createdAtMs = parsed.CreationDate ? new Date(parsed.CreationDate).getTime() : undefined;
            return { commandLine: parsed.CommandLine, createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined };
        }

        const cmdlinePath = `/proc/${pid}/cmdline`;
        if (fs.existsSync(cmdlinePath)) {
            const commandLine = fs.readFileSync(cmdlinePath, "utf-8").replace(/\0/g, " ").trim();
            return { commandLine };
        }
    } catch {
        return null;
    }
    return null;
}

function validatePidForTask(task: LaunchTask): { ok: boolean; reason?: string } {
    if (!isPidAlive(task.pid)) {
        return { ok: false, reason: "PID 已不存在" };
    }

    const info = getProcessInfo(task.pid);
    if (!info) {
        return { ok: false, reason: "无法读取 PID 创建时间/命令行，拒绝终止以避免 PID 复用误杀" };
    }

    const createdAtMs = task.createdAtMs ?? task.startTime;
    if (info.createdAtMs && info.createdAtMs < createdAtMs - 60_000) {
        return { ok: false, reason: `PID 创建时间早于任务创建时间 (${new Date(info.createdAtMs).toISOString()} < ${new Date(createdAtMs).toISOString()})` };
    }

    const commandLine = info.commandLine || "";
    const hash = task.commandHash || commandHash(task.command, task.cwd);
    if (commandLine && !commandLine.includes(hash) && task.exitMarkerPath && !commandLine.includes(path.basename(task.exitMarkerPath))) {
        return { ok: false, reason: "PID 命令行特征不匹配当前任务" };
    }

    return { ok: true };
}

/**
 * 刷新任务状态（检查 PID 是否还在）
 */
function refreshTaskStatus(task: LaunchTask): void {
    if (task.status !== "running") return;

    const marker = readExitMarker(task);
    if (marker?.done) {
        task.exitCode = typeof marker.exitCode === "number" ? marker.exitCode : null;
        task.finishedAtMs = marker.finishedAtMs;
        task.status = task.exitCode === 0 ? "done" : "failed";
        return;
    }

    if (!isPidAlive(task.pid)) {
        task.status = task.exitMarkerPath ? "failed" : "done";
        task.exitCode = task.exitMarkerPath ? null : 0;
    }
}

async function waitForLaunchTask(task: LaunchTask, waitSeconds: number): Promise<void> {
    const waitMs = Math.max(0, Math.min(waitSeconds, 300)) * 1000;
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
    const tasks = loadRegistry();
    tasks.forEach(refreshTaskStatus);
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
        .describe("任务归属 ID；未传按 global 兼容旧调用"),
};

export function registerLaunch(server: McpServer): void {
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
        async (params: Record<string, unknown>) => {
            const startTime = Date.now();
            touchActivity();

            const action = params.action as string | undefined;
            const ownerId = normalizeOwnerId(params.ownerId);

            const appendTiming = (result: { content: Array<{ type: "text"; text: string }> }) => {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                result.content[0].text += ` ⏱ 耗时 ${elapsed}s`;
                return result;
            };

            // ── list ──
            if (action === "list") {
                const tasks = loadRegistry();
                tasks.forEach(refreshTaskStatus);
                saveRegistry(tasks);
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
                const tasks = loadRegistry();
                tasks.forEach(refreshTaskStatus);
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
                    cleaned++;
                }

                const remaining = tasks.filter(t => !toClean.includes(t));
                saveRegistry(remaining);

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

                const tasks = loadRegistry();
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
                    if (task.status !== "running") {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `⚠️ 任务 ${taskId} 已结束 (${task.status})\n` }],
                        });
                    }

                    const validation = validatePidForTask(task);
                    if (!validation.ok) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ 终止前校验失败: ${validation.reason}\n` }],
                        });
                    }

                    try {
                        killProcessTree(task.pid);
                        task.status = "failed";
                        task.exitCode = -1;
                        saveRegistry(tasks);
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
                saveRegistry(tasks);

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
                            text: `${icon} ${taskId} ${task.status === "done" ? "已完成" : "已失败"} | ${elapsed} | exitCode=${task.exitCode}\n📄 stdout ${stdoutSize} bytes | stderr ${stderrSize} bytes\n📋 最近 ${tailLines} 行:\n${logTail}\n`,
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

            ensureLaunchDir();
            ensureWrapperFile();
            const taskId = generateId();
            const cwd = (params.cwd as string | undefined) || process.cwd();
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
            const createdAtMs = Date.now();
            const hash = commandHash(command, cwd);
            fs.writeFileSync(specPath, JSON.stringify({
                command,
                cwd,
                stdoutLog,
                stderrLog,
                exitMarkerPath,
                env: { PYTHONUNBUFFERED: "1" },
            }, null, 2), "utf-8");

            try {
                const proc = spawn(process.execPath, [WRAPPER_FILE, specPath, hash], {
                    cwd,
                    stdio: "ignore",
                    windowsHide: true,
                    env: { ...process.env, PYTHONUNBUFFERED: "1" },
                });

                proc.unref();

                const task: LaunchTask = {
                    id: taskId,
                    pid: proc.pid || 0,
                    command,
                    commandHash: hash,
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
                };

                // 追加到注册表
                const tasks = loadRegistry();
                tasks.push(task);
                saveRegistry(tasks);

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `🚀 长任务已启动\n📋 taskId: ${taskId}\n👤 ownerId: ${ownerId}\n📂 PID: ${task.pid}\n📁 cwd: ${cwd}\n📄 stdout: ${stdoutLog}\n📄 stderr: ${stderrLog}\n📄 exitMarker: ${exitMarkerPath}\n\n💡 用法:\n  sandbox_launch(action="status", taskId="${taskId}", tailLines=5, waitSeconds=60)\n  sandbox_launch(action="kill", taskId="${taskId}")\n`,
                    }],
                });
            } catch (err) {
                try { fs.unlinkSync(specPath); } catch { /* */ }
                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ 启动失败: ${err}\n` }],
                });
            }
        }
    );
}
