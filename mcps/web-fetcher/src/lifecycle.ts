import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";

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
export interface LifecycleProcess {
    ProcessId?: number;
    ParentProcessId?: number;
    Name?: string;
    CommandLine?: string;
}

interface LifecycleProbeOptions {
    platform?: NodeJS.Platform;
    parentPid?: number;
    pid?: number;
    scriptPath?: string;
    query?: (filter: string) => Promise<LifecycleProcess[] | null>;
}

export async function queryLifecycleProcesses(filter: string, execute: typeof execFile = execFile): Promise<LifecycleProcess[] | null> {
    try {
        const output = await new Promise<string>((resolve, reject) => {
            const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
                + `@(Get-CimInstance -ClassName Win32_Process -Filter '${filter.replace(/'/g, "''")}' | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress`;
            execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
                (error, stdout) => error ? reject(error) : resolve(String(stdout)));
        });
        const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/u, "").trim() || "[]");
        if (parsed === null) return [];
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) return null;
        return rows as LifecycleProcess[];
    } catch { return null; }
}

export async function hasNewerSiblingInstance(options: LifecycleProbeOptions = {}): Promise<boolean> {
    if ((options.platform ?? process.platform) !== "win32") return false;
    const normalize = (value: string) => value.replace(/[\\/]+/g, "/").toLowerCase();
    const currentScript = normalize(options.scriptPath ?? process.argv[1] ?? "");
    if (!currentScript) return false;
    const parentPid = options.parentPid ?? process.ppid;
    const pid = options.pid ?? process.pid;
    try {
        const siblings = await (options.query ?? queryLifecycleProcesses)(`ParentProcessId=${parentPid} AND Name='node.exe'`);
        return siblings?.some(sibling => Number.isSafeInteger(sibling.ProcessId) && Number(sibling.ProcessId) > pid
            && sibling.ParentProcessId === parentPid && typeof sibling.CommandLine === "string"
            && normalize(sibling.CommandLine).includes(currentScript)) ?? false;
    } catch { return false; }
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
 * 通过 CIM 查询父进程名称，匹配 language_server 前缀。
 * 仅启动时调用一次，结果缓存。
 * 
 * 非 LS 环境（其他 IDE、手动启动等）会启用空闲超时兜底。
 */
let cachedParentHost: "antigravity-ls" | "other" | undefined;

export async function detectParentHost(options: LifecycleProbeOptions = {}): Promise<"antigravity-ls" | "other" | "unknown"> {
    if ((options.platform ?? process.platform) !== "win32") return "other";
    const parentPid = options.parentPid ?? process.ppid;
    try {
        const parents = await (options.query ?? queryLifecycleProcesses)(`ProcessId=${parentPid}`);
        const parent = parents?.find(candidate => candidate.ProcessId === parentPid);
        if (!parent || typeof parent.Name !== "string" || !parent.Name.trim()) return "unknown";
        return /^language_server(?:[_\-.]|$)/iu.test(parent.Name) ? "antigravity-ls" : "other";
    } catch { return "unknown"; }
}

export async function isAntigravityLS(): Promise<boolean> {
    const kind = cachedParentHost ?? await detectParentHost();
    if (kind === "unknown") {
        logStdinEvent("父宿主 CIM 查询未确认，保留父进程管理，暂不启用非 LS 空闲退出");
        return true;
    }
    cachedParentHost = kind;
    return kind === "antigravity-ls";
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
