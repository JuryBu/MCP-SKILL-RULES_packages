import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";

/**
 * MCP Web-Fetcher 进程生命周期管理 v6.2
 * 
 * - isParentAlive: 基础 ppid 存活检测（供 stdin 诊断用）
 * - checkParentAliveWithTolerance: 带连续失败容错的 ppid 检测
 * - isAntigravityLS: 检测父进程是否为 Antigravity LS
 * - touchActivity: 每个工具调用入口更新时间戳
 * - getIdleTime: 空闲时间（非 LS 环境兜底用）
 * - logStdinEvent: stdin 事件日志（调试用）
 */

// 最后一次 MCP 工具调用的时间戳
let lastMcpActivity = Date.now();

// stdin 实验日志路径（使用系统临时目录，避免硬编码路径）
const STDIN_LOG_FILE = path.join(os.tmpdir(), "mcp-web-fetcher-stdin-log.txt");

// ppid 连续失败计数
let consecutivePpidFailures = 0;
const PPID_FAILURE_THRESHOLD = 3;

/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export function touchActivity(): void {
    lastMcpActivity = Date.now();
}

/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export function getIdleTime(): number {
    return Date.now() - lastMcpActivity;
}

/**
 * 检测同一父进程下是否已有更新的同类 MCP 实例。
 *
 * Codex app-server 在重连 / 切线程 / 刷新时，可能重复拉起同一 MCP，
 * 但旧实例的 stdin 不一定立刻断开。这里用于让旧实例在空闲时主动让位。
 */
export async function hasNewerSiblingInstance(): Promise<boolean> {
    if (process.platform !== "win32") return false;

    const currentScript = (process.argv[1] || "").replace(/\\/g, "\\\\");
    if (!currentScript) return false;

    const escapedScript = currentScript.replace(/'/g, "''");

    try {
        const result = await new Promise<string | null>((resolve) => {
            exec(
                `wmic process where "ParentProcessId=${process.ppid} and name='node.exe'" get ProcessId,CommandLine /format:csv`,
                { encoding: "utf-8", timeout: 5000, windowsHide: true },
                (error, stdout) => {
                    if (error) resolve(null);
                    else resolve(stdout || null);
                }
            );
        });

        if (!result) return false;

        const lines = result
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean);

        for (const line of lines) {
            if (!line.includes(escapedScript)) continue;
            const parts = line.split(",");
            const pid = Number(parts[parts.length - 1]);
            if (Number.isFinite(pid) && pid > process.pid) {
                return true;
            }
        }
    } catch {
        return false;
    }

    return false;
}

/**
 * 检测父 LS 进程是否还活着
 * 
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）。
 * signal 0 不发真信号，只检查进程存活，微秒级开销。
 */
export function isParentAlive(): boolean {
    try {
        process.kill(process.ppid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * 带容错的 ppid 检测
 * 
 * 单次失败不判死，连续 N 次失败才确认死亡。
 * 应对 LS 短暂抖动（进程瞬间不可达但随后恢复）。
 * 
 * @returns "alive" | "degraded" | "dead"
 */
export function checkParentAliveWithTolerance(): "alive" | "degraded" | "dead" {
    if (isParentAlive()) {
        if (consecutivePpidFailures > 0) {
            logStdinEvent(`ppid 检测恢复正常（之前连续失败 ${consecutivePpidFailures} 次）`);
        }
        consecutivePpidFailures = 0;
        return "alive";
    }

    consecutivePpidFailures++;

    if (consecutivePpidFailures >= PPID_FAILURE_THRESHOLD) {
        return "dead";
    }

    return "degraded";
}

/**
 * 检测父进程是否为 Antigravity LS
 * 
 * 通过 wmic 查询父进程名称，匹配 language_server 前缀。
 * 仅启动时调用一次，结果缓存。
 * 
 * 非 LS 环境（其他 IDE、手动启动等）会启用空闲超时兜底。
 */
let cachedIsLS: boolean | null = null;

export async function isAntigravityLS(): Promise<boolean> {
    if (cachedIsLS !== null) return cachedIsLS;

    if (process.platform !== "win32") {
        // 非 Windows 暂时默认非 LS（未来可扩展）
        cachedIsLS = false;
        return false;
    }

    try {
        const result = await new Promise<string | null>((resolve) => {
            exec(
                `wmic process where ProcessId=${process.ppid} get Name /value`,
                { encoding: "utf-8", timeout: 5000, windowsHide: true },
                (error, stdout) => {
                    if (error) resolve(null);
                    else resolve(stdout?.trim() || null);
                }
            );
        });

        if (result) {
            // LS 进程名通常为 language_server_amd64.exe 或类似
            cachedIsLS = result.toLowerCase().includes("language_server");
            return cachedIsLS;
        }
    } catch { /* 查询失败，保守认定为非 LS */ }

    cachedIsLS = false;
    return false;
}

/**
 * 记录 stdin 事件到日志（调试用）
 */
export function logStdinEvent(event: string): void {
    try {
        const msg = `[${new Date().toISOString()}] PID ${process.pid} ${event}\n`;
        fs.appendFileSync(STDIN_LOG_FILE, msg);
    } catch { /* 写入失败不影响运行 */ }
}
