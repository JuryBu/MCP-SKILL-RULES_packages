import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, formatElapsed } from "../lifecycle.js";
import { killProcessTree } from "../executor.js";

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

const DATA_ROOT = path.join(os.homedir(), ".gemini", "antigravity", "sandbox-data");
const LAUNCH_DIR = path.join(DATA_ROOT, "launches");
const REGISTRY_FILE = path.join(LAUNCH_DIR, "registry.json");

// ── 类型 ──

interface LaunchTask {
    id: string;
    pid: number;
    command: string;
    cwd: string;
    stdoutLog: string;
    stderrLog: string;
    startTime: number;
    status: "running" | "done" | "failed";
    exitCode: number | null;
}

// ── 注册表管理 ──

let taskCounter = 0;

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
    // 从注册表中找最大 ID 号
    const tasks = loadRegistry();
    const maxNum = tasks.reduce((max, t) => {
        const m = t.id.match(/^launch-(\d+)$/);
        return m ? Math.max(max, parseInt(m[1])) : max;
    }, taskCounter);
    taskCounter = maxNum + 1;
    return `launch-${String(taskCounter).padStart(3, "0")}`;
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

/**
 * 刷新任务状态（检查 PID 是否还在）
 */
function refreshTaskStatus(task: LaunchTask): void {
    if (task.status !== "running") return;

    if (!isPidAlive(task.pid)) {
        // 进程已退出，尝试通过一些启示判断退出码
        // 无法从脱离进程获取退出码，默认为 0（成功）
        task.status = "done";
        task.exitCode = 0;
    }
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

                if (tasks.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "📋 无活跃任务\n" }],
                    });
                }

                const lines = tasks.map(t => {
                    const elapsed = formatElapsed(Date.now() - t.startTime);
                    const statusIcon = t.status === "running" ? "🔄" : t.status === "done" ? "✅" : "❌";
                    return `  ${statusIcon} ${t.id} | ${t.command.slice(0, 60)} | ${t.status} | ${elapsed} | PID ${t.pid}`;
                });

                return appendTiming({
                    content: [{ type: "text" as const, text: `📋 任务列表 (${tasks.length}):\n${lines.join("\n")}\n` }],
                });
            }

            // ── clean ──
            if (action === "clean") {
                const tasks = loadRegistry();
                tasks.forEach(refreshTaskStatus);
                const taskId = params.taskId as string | undefined;

                const toClean = taskId
                    ? tasks.filter(t => t.id === taskId && t.status !== "running")
                    : tasks.filter(t => t.status !== "running");

                let cleaned = 0;
                for (const t of toClean) {
                    try { fs.unlinkSync(t.stdoutLog); } catch { /* */ }
                    try { fs.unlinkSync(t.stderrLog); } catch { /* */ }
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

                // ── kill ──
                if (action === "kill") {
                    if (task.status !== "running") {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `⚠️ 任务 ${taskId} 已结束 (${task.status})\n` }],
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
                if (waitSeconds > 0 && task.status === "running") {
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, waitSeconds * 1000);
                        const checkInterval = setInterval(() => {
                            if (!isPidAlive(task.pid)) {
                                clearTimeout(timer);
                                clearInterval(checkInterval);
                                resolve();
                            }
                        }, 2000);
                        timer.unref?.();
                    });
                }

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
                            text: `🔄 ${taskId} 运行中 | ${elapsed} | PID ${task.pid}\n📄 stdout ${stdoutSize} bytes | stderr ${stderrSize} bytes\n📋 最近 ${tailLines} 行:\n${logTail}\n`,
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

            // 用文件描述符做 stdio 重定向
            const stdoutFd = fs.openSync(stdoutLog, "w");
            const stderrFd = fs.openSync(stderrLog, "w");

            try {
                const proc = spawn(command, [], {
                    cwd,
                    shell: true,
                    stdio: ["ignore", stdoutFd, stderrFd],
                    windowsHide: true,
                    env: { ...process.env, PYTHONUNBUFFERED: "1" },
                });

                proc.unref();

                const task: LaunchTask = {
                    id: taskId,
                    pid: proc.pid || 0,
                    command,
                    cwd,
                    stdoutLog,
                    stderrLog,
                    startTime: Date.now(),
                    status: "running",
                    exitCode: null,
                };

                // 追加到注册表
                const tasks = loadRegistry();
                tasks.push(task);
                saveRegistry(tasks);

                // 关闭文件描述符（进程已接管）
                fs.closeSync(stdoutFd);
                fs.closeSync(stderrFd);

                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `🚀 长任务已启动\n📋 taskId: ${taskId}\n📂 PID: ${task.pid}\n📁 cwd: ${cwd}\n📄 stdout: ${stdoutLog}\n📄 stderr: ${stderrLog}\n\n💡 用法:\n  sandbox_launch(action="status", taskId="${taskId}", tailLines=5, waitSeconds=60)\n  sandbox_launch(action="kill", taskId="${taskId}")\n`,
                    }],
                });
            } catch (err) {
                // 启动失败，关闭文件描述符
                try { fs.closeSync(stdoutFd); } catch { /* */ }
                try { fs.closeSync(stderrFd); } catch { /* */ }
                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ 启动失败: ${err}\n` }],
                });
            }
        }
    );
}
