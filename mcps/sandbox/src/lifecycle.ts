import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { formatAdmissionDiagnostic } from "./admission-diagnostics.js";

/**
 * MCP Sandbox 进程生命周期管理 v1.6
 * 
 * - isParentAlive: 检测父 LS 进程存活（ppid 绑定）
 * - checkParentAliveWithTolerance: 带连续失败容错的 ppid 检测
 * - isAntigravityLS: 检测父进程是否为 Antigravity LS
 * - touchActivity: 每个工具调用入口更新时间戳
 * - getIdleTime: 空闲时间（非 LS 环境兜底用）
 * - logStdinEvent: stdin 事件日志（调试用）
 * - appendTiming: 返回结果追加耗时信息
 */

// 最后一次 MCP 工具调用的时间戳
let lastMcpActivity = Date.now();

// stdin 日志路径（使用系统临时目录，避免硬编码）
const STDIN_LOG_FILE = path.join(os.tmpdir(), "mcp-sandbox-stdin-log.txt");

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
 * 通过有界的 Windows 进程快照查询父进程名称与创建时间。
 * 已知结果缓存，未知时保留 ppid 管理，避免空闲保护误退。
 * 
 * 非 LS 环境（其他 IDE、手动启动等）会启用空闲超时兜底。
 */
let cachedIsLS: boolean | null = null;

interface WindowsProcessIdentity {
    pid: number;
    parentPid: number;
    name: string;
    executablePath: string | null;
    commandLine: string | null;
    startedAt: number | null;
}

type WindowsProcessSnapshot = { status: "known"; processes: WindowsProcessIdentity[] } | { status: "unknown" };

async function readWindowsProcessSnapshot(filter: string): Promise<WindowsProcessSnapshot> {
    const script = [
        "$ErrorActionPreference='Stop'",
        "$ProgressPreference='SilentlyContinue'",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        "$items=@(& {",
        "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {",
        `Get-CimInstance -ClassName Win32_Process -Filter '${filter}' -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate -ErrorAction Stop`,
        "} else {",
        `Get-WmiObject -Class Win32_Process -Filter '${filter}' -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate -ErrorAction Stop`,
        "}",
        "})",
        "$identities=@($items | ForEach-Object {",
        "$processInfo=$_",
        "$creationDate=$processInfo.CreationDate",
        "if ($creationDate -is [string]) { $creationDate=$processInfo.ConvertToDateTime($creationDate) }",
        "[pscustomobject]@{pid=[int]$processInfo.ProcessId;parentPid=[int]$processInfo.ParentProcessId;name=$processInfo.Name;executablePath=$processInfo.ExecutablePath;commandLine=$processInfo.CommandLine;startedAt=if ($creationDate) {$creationDate.ToUniversalTime().ToString('o')} else {$null}}",
        "})",
        "ConvertTo-Json -InputObject $identities -Depth 3 -Compress",
    ].join("\n");
    const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe";
    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            execFile(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
                { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true },
                (error, output) => error ? reject(error) : resolve(output));
        });
        const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/u, "").trim());
        if (!Array.isArray(parsed)) return { status: "unknown" };
        const processes: WindowsProcessIdentity[] = [];
        for (const entry of parsed) {
            if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 0
                || !Number.isInteger(entry.parentPid) || entry.parentPid < 0 || typeof entry.name !== "string") {
                return { status: "unknown" };
            }
            const startedAt = typeof entry.startedAt === "string" ? Date.parse(entry.startedAt) : NaN;
            processes.push({ pid: entry.pid, parentPid: entry.parentPid, name: entry.name,
                executablePath: typeof entry.executablePath === "string" ? entry.executablePath : null,
                commandLine: typeof entry.commandLine === "string" ? entry.commandLine : null,
                startedAt: Number.isFinite(startedAt) ? startedAt : null });
        }
        return { status: "known", processes };
    } catch {
        return { status: "unknown" };
    }
}

function windowsCommandArguments(commandLine: string): string[] {
    const argumentsList: string[] = [];
    let argument = "";
    let quoted = false;
    let started = false;
    let backslashes = 0;
    for (const character of commandLine) {
        if (character === "\\") {
            backslashes++;
            started = true;
            continue;
        }
        if (character === '"') {
            argument += "\\".repeat(Math.floor(backslashes / 2));
            if (backslashes % 2) argument += '"';
            else quoted = !quoted;
            backslashes = 0;
            started = true;
            continue;
        }
        argument += "\\".repeat(backslashes);
        backslashes = 0;
        if (/\s/u.test(character) && !quoted) {
            if (started) argumentsList.push(argument);
            argument = "";
            started = false;
        } else {
            argument += character;
            started = true;
        }
    }
    argument += "\\".repeat(backslashes);
    if (started) argumentsList.push(argument);
    return argumentsList;
}

function normalizeWindowsPath(filePath: string): string {
    return path.win32.normalize(filePath).toLowerCase();
}

export async function isAntigravityLS(): Promise<boolean> {
    if (cachedIsLS !== null) return cachedIsLS;

    if (process.platform !== "win32") {
        // 非 Windows 暂时默认非 LS（未来可扩展）
        cachedIsLS = false;
        return false;
    }

    const snapshot = await readWindowsProcessSnapshot(`ProcessId=${process.ppid} OR ProcessId=${process.pid}`);
    const parent = snapshot.status === "known" ? snapshot.processes.find((entry) => entry.pid === process.ppid) : undefined;
    const current = snapshot.status === "known" ? snapshot.processes.find((entry) => entry.pid === process.pid) : undefined;
    if (!parent || !current || current.parentPid !== process.ppid || parent.startedAt === null
        || current.startedAt === null || parent.startedAt > current.startedAt) {
        console.error("[sandbox] Windows parent process identity unknown; retaining ppid-only lifecycle management");
        return true;
    }
    cachedIsLS = /^language_server(?:[-_.]|$)/iu.test(parent.name);
    return cachedIsLS;
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

    const currentScript = process.argv[1] || "";
    if (!currentScript) return false;
    const snapshot = await readWindowsProcessSnapshot(`ParentProcessId=${process.ppid}`);
    if (snapshot.status === "unknown") return false;
    const current = snapshot.processes.find((entry) => entry.pid === process.pid && entry.parentPid === process.ppid);
    const executablePath = normalizeWindowsPath(process.execPath);
    if (!current?.commandLine || !current.executablePath || current.startedAt === null
        || normalizeWindowsPath(current.executablePath) !== executablePath) return false;
    const currentArguments = windowsCommandArguments(current.commandLine);
    let scriptPosition = process.execArgv.length + 1;
    if (currentArguments[scriptPosition] === "--") scriptPosition++;
    if (!currentArguments[scriptPosition]
        || normalizeWindowsPath(currentArguments[scriptPosition]) !== normalizeWindowsPath(currentScript)) return false;
    const currentStartedAt = current.startedAt;
    return snapshot.processes.some((entry) => {
        if (entry.pid === process.pid || entry.parentPid !== process.ppid || !entry.commandLine || !entry.executablePath
            || entry.startedAt === null || entry.startedAt <= currentStartedAt
            || normalizeWindowsPath(entry.executablePath) !== executablePath) return false;
        const argumentsList = windowsCommandArguments(entry.commandLine);
        return argumentsList.length > scriptPosition
            && normalizeWindowsPath(argumentsList[scriptPosition]) === normalizeWindowsPath(currentScript)
            && currentArguments.slice(1, scriptPosition).every((argument, index) => argumentsList[index + 1] === argument);
    });
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

/**
 * 在 MCP 工具返回结果的最后一个 text content 追加耗时信息
 */
const STRUCTURED_TEXT_MIRROR_BYTE_LIMIT = 480 * 1024;
const configuredHardResponseByteLimit = Number(process.env.SANDBOX_OUTPUT_HARD_RESPONSE_BYTES);
const MODEL_VISIBLE_HARD_RESPONSE_BYTE_LIMIT = Number.isFinite(configuredHardResponseByteLimit) && configuredHardResponseByteLimit >= 64 * 1024
    ? Math.floor(configuredHardResponseByteLimit)
    : 1024 * 1024;
const MODEL_VISIBLE_METADATA_RESERVE_BYTES = 16 * 1024;
const STRUCTURED_TEXT_TRANSFER_NOTICE = "完整工具文本已放入 structuredContent.text，以避免大响应重复编码。";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ensureModelVisibleToolResult(result: any): any {
    if (!result?.structuredContent || typeof result.structuredContent !== "object") return result;
    let textContent = [...(result.content || [])]
        .reverse()
        .find((item) => item?.type === "text" && typeof item.text === "string" && item.text.length > 0);
    const admissionDiagnostic = formatAdmissionDiagnostic(result.structuredContent.error);
    if (admissionDiagnostic) {
        if (!textContent) {
            textContent = { type: "text", text: admissionDiagnostic };
            result.content = [...(result.content || []), textContent];
        } else if (!textContent.text.startsWith(admissionDiagnostic)) {
            textContent.text = admissionDiagnostic;
        }
    }
    if (!textContent) return result;
    const serializedTextBytes = Buffer.byteLength(JSON.stringify(textContent.text), "utf8");
    const serializedMetadataBytes = Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8");
    const mirroredResponseBytes = serializedTextBytes * 2 + serializedMetadataBytes + MODEL_VISIBLE_METADATA_RESERVE_BYTES;
    if (serializedTextBytes <= STRUCTURED_TEXT_MIRROR_BYTE_LIMIT
        && mirroredResponseBytes <= MODEL_VISIBLE_HARD_RESPONSE_BYTE_LIMIT) {
        result.structuredContent = { ...result.structuredContent, text: textContent.text };
    } else if (serializedTextBytes + serializedMetadataBytes + MODEL_VISIBLE_METADATA_RESERVE_BYTES
        <= MODEL_VISIBLE_HARD_RESPONSE_BYTE_LIMIT) {
        result.structuredContent = { ...result.structuredContent, text: textContent.text };
        textContent.text = STRUCTURED_TEXT_TRANSFER_NOTICE;
    } else {
        result.structuredContent = {
            ...result.structuredContent,
            textPreview: `${textContent.text.slice(0, 4096)}\n... (工具文本超过响应保护线) ...\n${textContent.text.slice(-4096)}`,
            textTruncated: true,
        };
    }
    return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appendTiming(result: any, startTime: number): any {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const timingStr = `\n⏱ 耗时 ${elapsed}s`;
    for (let i = result.content.length - 1; i >= 0; i--) {
        if (result.content[i].type === "text" && result.content[i].text) {
            result.content[i].text += timingStr;
            break;
        }
    }
    return ensureModelVisibleToolResult(result);
}

/**
 * 格式化毫秒为人类可读的时间字符串
 */
export function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const min = Math.floor(ms / 60000);
    const sec = ((ms % 60000) / 1000).toFixed(0);
    return `${min}m${sec}s`;
}
