import { spawn, execSync, ChildProcess } from "child_process";
import pidusage from "pidusage";
import { saveTempScript, removeTempFile } from "./temp-store.js";
import { resolveInterpreter, getCachedEnvInfo } from "./env-detector.js";
import { formatElapsed } from "./lifecycle.js";
import { acquireResourceLease } from "./resource-admission-runtime.js";
import {
    createWindowsJobLaunch,
    readWindowsJobMetadata,
    removeWindowsJobMetadata,
} from "./windows-job-runner.js";
import type { ResourceWaitProgress } from "./resource-admission.js";
import {
    createOutputDeliveryCollector,
    countTextCharacters,
    sliceTextCharacters,
    type OutputArtifactReference,
    type OutputDeliveryMode,
    type OutputDeliveryResult,
} from "./output-delivery.js";

/**
 * MCP Sandbox 子进程执行引擎
 *
 * 核心职责：
 * - spawn 子进程执行代码/命令
 * - 硬超时管理（自动杀进程树）
 * - 内存监控（pidusage 2秒采样）
 * - 输出收集和截断（outputMode）
 * - 大输出写临时文件
 * - Windows 进程树杀（taskkill /T /F）
 */

export type KillReason = "timeout" | "memory" | "vram" | "manual" | "cancelled" | "crash";
export type OutputMode = "full" | "tail" | "head" | "silent";

export interface ExecOptions {
    code?: string;
    command?: string;
    language?: string;
    cwd?: string;
    env?: string;
    timeout?: number;
    maxMemoryMB?: number;
    memoryRequestMB?: number;
    maxOutput?: number;
    responseByteLimit?: number;
    outputMode?: OutputMode;
    tailLines?: number;
    maxLines?: number;
    gpu?: boolean;
    maxVRAM_MB?: number;
    ownerId?: string;
    signal?: AbortSignal;
    admissionBudgetMs?: number;
    retryAttempt?: number;
    reservationMB?: number;
    onQueueProgress?: (progress: ResourceWaitProgress) => void;
    deliveryMode?: OutputDeliveryMode;
    artifactTtlMs?: number;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    elapsed: string;
    killed: boolean;
    killReason: KillReason | null;
    peakMemoryMB: number | null;
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    tempFile: string | null;
    queueWaitMs: number;
    deliveryMode: OutputDeliveryResult["mode"] | null;
    artifact: OutputArtifactReference | null;
    outputReasons: string[];
    outputStats: OutputDeliveryResult["stats"] | null;
    outputStatus: OutputDeliveryResult["status"] | null;
    outputComplete: boolean;
    outputReadHint: string | null;
}

export interface NormalizedExecutionInput {
    code?: string;
    command?: string;
    error?: string;
}

export function normalizeExecutionInput(code?: string, command?: string): NormalizedExecutionInput {
    const normalizedCode = typeof code === "string" && code.trim().length > 0 ? code : undefined;
    const normalizedCommand = typeof command === "string" && command.trim().length > 0 ? command : undefined;
    const hasCode = normalizedCode !== undefined;
    const hasCommand = normalizedCommand !== undefined;

    if (hasCode && hasCommand) {
        return { error: "错误：code 和 command 不能同时提供，请只填其一" };
    }
    if (!hasCode && !hasCommand) {
        return { error: "错误：必须提供 code 或 command 之一" };
    }

    return { code: normalizedCode, command: normalizedCommand };
}

export function makeParamErrorResult(stderr: string): ExecResult {
    return {
        stdout: "",
        stderr,
        exitCode: 1,
        elapsed: "0ms",
        killed: false,
        killReason: null,
        peakMemoryMB: null,
        truncated: false,
        originalBytes: 0,
        returnedBytes: 0,
        tempFile: null,
        queueWaitMs: 0,
        deliveryMode: null,
        artifact: null,
        outputReasons: [],
        outputStats: null,
        outputStatus: null,
        outputComplete: false,
        outputReadHint: null,
    };
}

function makeCancelledBeforeSpawnResult(queueWaitMs: number): ExecResult {
    return {
        ...makeParamErrorResult("执行已取消，进程未启动"),
        killed: true,
        killReason: "cancelled",
        queueWaitMs,
    };
}

// 默认值
const DEFAULTS = {
    language: "python",
    timeout: 30000,       // 30秒
    maxTimeout: Number(process.env.SANDBOX_EXEC_MAX_TIMEOUT_MS || 6 * 60 * 60 * 1000),
    maxMemoryMB: 256,
    maxMemoryLimit: 1536,
    maxOutput: 1024 * 1024,
    outputMode: "full" as OutputMode,
    tailLines: 20,
    maxVRAM_MB: 2048,
    memoryCheckInterval: 100,
};

/**
 * Windows 下杀进程树（taskkill /T /F），Linux 下用 kill
 */
export function killProcessTree(pid: number): void {
    try {
        if (process.platform === "win32") {
            execSync(`taskkill /T /F /PID ${pid}`, {
                stdio: "pipe",
                windowsHide: true,
            });
        } else {
            process.kill(-pid, "SIGKILL");
        }
    } catch {
        // 进程可能已退出
        try {
            process.kill(pid, "SIGKILL");
        } catch { /* 已退出 */ }
    }
}

function getProcessTreePids(rootPid: number): number[] {
    const seen = new Set<number>([rootPid]);
    try {
        if (process.platform === "win32") {
            const psScript = [
                `$ProgressPreference = 'SilentlyContinue'`,
                `$root = ${rootPid}`,
                `$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId`,
                `$children = @{}`,
                `foreach ($row in $rows) {`,
                `  $ppid = [int]$row.ParentProcessId`,
                `  if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[int] }`,
                `  $children[$ppid].Add([int]$row.ProcessId)`,
                `}`,
                `$queue = New-Object System.Collections.Generic.Queue[int]`,
                `$visited = New-Object System.Collections.Generic.HashSet[int]`,
                `$queue.Enqueue($root)`,
                `while ($queue.Count -gt 0) {`,
                `  $currentPid = $queue.Dequeue()`,
                `  if ($visited.Add($currentPid) -and $children.ContainsKey($currentPid)) {`,
                `    foreach ($child in $children[$currentPid]) { $queue.Enqueue($child) }`,
                `  }`,
                `}`,
                `[string]::Join(',', $visited)`,
            ].join("\n");
            const encodedCmd = Buffer.from(psScript, "utf16le").toString("base64");
            const stdout = execSync(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, {
                encoding: "utf-8",
                timeout: 3000,
                windowsHide: true,
            }).trim();
            for (const item of stdout.split(",")) {
                const pid = Number(item.trim());
                if (Number.isInteger(pid) && pid > 0) seen.add(pid);
            }
            return [...seen];
        }

        const stdout = execSync("ps -eo pid=,ppid=", {
            encoding: "utf-8",
            timeout: 3000,
            windowsHide: true,
        });
        const children = new Map<number, number[]>();
        for (const line of stdout.split(/\r?\n/u)) {
            const [pidRaw, ppidRaw] = line.trim().split(/\s+/u);
            const pid = Number(pidRaw);
            const ppid = Number(ppidRaw);
            if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
            const list = children.get(ppid) || [];
            list.push(pid);
            children.set(ppid, list);
        }
        const queue = [rootPid];
        for (let index = 0; index < queue.length; index++) {
            const pid = queue[index];
            for (const childPid of children.get(pid) || []) {
                if (!seen.has(childPid)) {
                    seen.add(childPid);
                    queue.push(childPid);
                }
            }
        }
    } catch (err) {
        console.warn(`[executor] process tree enumeration failed, fallback to root PID only: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [...seen];
}

async function getProcessTreeMemoryMB(rootPid: number): Promise<number> {
    try {
        if (process.platform === "win32") {
            const psScript = [
                `$ProgressPreference = 'SilentlyContinue'`,
                `$root = ${rootPid}`,
                `$rows = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId`,
                `$workingSet = @{}`,
                `Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $workingSet[[int]$_.Id] = [int64]$_.WorkingSet64 }`,
                `$children = @{}`,
                `foreach ($row in $rows) {`,
                `  $ppid = [int]$row.ParentProcessId`,
                `  if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[int] }`,
                `  $children[$ppid].Add([int]$row.ProcessId)`,
                `}`,
                `$queue = New-Object System.Collections.Generic.Queue[int]`,
                `$visited = New-Object System.Collections.Generic.HashSet[int]`,
                `$total = [int64]0`,
                `$queue.Enqueue($root)`,
                `while ($queue.Count -gt 0) {`,
                `  $currentPid = $queue.Dequeue()`,
                `  if ($visited.Add($currentPid)) {`,
                `    if ($workingSet.ContainsKey($currentPid)) { $total += [int64]$workingSet[$currentPid] }`,
                `    if ($children.ContainsKey($currentPid)) {`,
                `      foreach ($child in $children[$currentPid]) { $queue.Enqueue($child) }`,
                `    }`,
                `  }`,
                `}`,
                `$total`,
            ].join("\n");
            const encodedCmd = Buffer.from(psScript, "utf16le").toString("base64");
            const stdout = execSync(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, {
                encoding: "utf-8",
                timeout: 3000,
                windowsHide: true,
            }).trim();
            const totalBytes = Number(stdout.split(/\r?\n/u).pop()?.trim());
            if (Number.isFinite(totalBytes) && totalBytes > 0) {
                return totalBytes / (1024 * 1024);
            }
        } else {
            const stdout = execSync("ps -eo pid=,ppid=,rss=", {
                encoding: "utf-8",
                timeout: 3000,
                windowsHide: true,
            });
            const children = new Map<number, number[]>();
            const rssByPid = new Map<number, number>();
            for (const line of stdout.split(/\r?\n/u)) {
                const [pidRaw, ppidRaw, rssRaw] = line.trim().split(/\s+/u);
                const pid = Number(pidRaw);
                const ppid = Number(ppidRaw);
                const rssKb = Number(rssRaw);
                if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rssKb)) continue;
                rssByPid.set(pid, rssKb);
                const list = children.get(ppid) || [];
                list.push(pid);
                children.set(ppid, list);
            }
            const seen = new Set<number>();
            const queue = [rootPid];
            let totalKb = 0;
            for (let index = 0; index < queue.length; index++) {
                const pid = queue[index];
                if (seen.has(pid)) continue;
                seen.add(pid);
                totalKb += rssByPid.get(pid) || 0;
                for (const childPid of children.get(pid) || []) {
                    if (!seen.has(childPid)) queue.push(childPid);
                }
            }
            if (totalKb > 0) return totalKb / 1024;
        }
    } catch (err) {
        console.warn(`[executor] process tree memory snapshot failed, fallback to pidusage: ${err instanceof Error ? err.message : String(err)}`);
    }

    const pids = getProcessTreePids(rootPid);
    const stats = await Promise.all(pids.map(async (pid) => {
        try {
            return await pidusage(pid);
        } catch {
            return null;
        }
    }));
    const totalBytes = stats.reduce((sum, stat) => sum + (stat?.memory || 0), 0);
    return totalBytes / (1024 * 1024);
}

/**
 * 获取解释器命令和参数
 */
function getInterpreterArgs(
    language: string,
    scriptPath: string | null,
    code: string | null,
    envParam?: string
): { cmd: string; args: string[] } {
    // 检查是否有 env 指定的解释器路径
    const customInterpreter = resolveInterpreter(envParam, language);

    switch (language) {
        case "python": {
            const pythonCmd = customInterpreter || "python";
            if (scriptPath) {
                return { cmd: pythonCmd, args: ["-u", scriptPath] };
            }
            // 短代码直接 -c 执行
            return { cmd: pythonCmd, args: ["-u", "-c", code || ""] };
        }
        case "node": {
            const nodeCmd = customInterpreter || "node";
            if (scriptPath) {
                return { cmd: nodeCmd, args: [scriptPath] };
            }
            return { cmd: nodeCmd, args: ["-e", code || ""] };
        }
        case "powershell":
            if (scriptPath) {
                return { cmd: "powershell", args: ["-NoProfile", "-NonInteractive", "-File", scriptPath] };
            }
            // 代码模式：双变量强制 UTF-8（无 BOM）+ 执行代码
            return {
                cmd: "powershell",
                args: ["-NoProfile", "-NonInteractive", "-Command",
                    `$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ${code || ""}`]
            };
        case "cmd":
            if (scriptPath) {
                return { cmd: "cmd", args: ["/c", `chcp 65001 >nul & ${scriptPath}`] };
            }
            // 强制 UTF-8 代码页
            return { cmd: "cmd", args: ["/c", `chcp 65001 >nul & ${code || ""}`] };
        case "bash": {
            const bashInfo = getCachedEnvInfo()?.bash;
            const bashCmd = bashInfo?.available ? bashInfo.path : "bash";
            if (scriptPath) {
                return { cmd: bashCmd, args: [scriptPath] };
            }
            return { cmd: bashCmd, args: ["-c", code || ""] };
        }
        default:
            return { cmd: language, args: scriptPath ? [scriptPath] : ["-c", code || ""] };
    }
}

/**
 * 判断代码是否为"短代码"，可直接用 -c/-e 执行
 */
function isShortCode(code: string): boolean {
    return !code.includes("\n") && code.length < 200;
}

/**
 * 折叠连续重复的输出块
 *
 * 检测连续相同的行或多行块（如 PowerShell 管道中每个元素重复报错），
 * 将 N 次重复折叠为 1 次 + 折叠提示行。
 */
export function foldRepeatedBlocks(text: string): string {
    if (!text) return text;
    const lines = text.split("\n");
    if (lines.length < 2) return text;

    const result: string[] = [];
    let i = 0;
    const maxBlockSize = Math.min(20, Math.floor(lines.length / 2));

    while (i < lines.length) {
        let folded = false;

        // 从大块到小块尝试匹配连续重复
        for (let blockSize = maxBlockSize; blockSize >= 1; blockSize--) {
            if (i + blockSize * 2 > lines.length) continue;

            const block = lines.slice(i, i + blockSize);
            const blockText = block.join("\n");
            // 跳过空块（全空行不折叠）
            if (!blockText.trim()) continue;

            let count = 1;
            let j = i + blockSize;
            while (j + blockSize <= lines.length) {
                const nextBlock = lines.slice(j, j + blockSize).join("\n");
                if (nextBlock === blockText) {
                    count++;
                    j += blockSize;
                } else {
                    break;
                }
            }

            if (count >= 2) {
                result.push(...block);
                result.push(`[× ${count} 重复，已折叠 ${(count - 1) * blockSize} 行]`);
                i = j;
                folded = true;
                break;
            }
        }

        if (!folded) {
            result.push(lines[i]);
            i++;
        }
    }

    return result.join("\n");
}

/**
 * 按 outputMode 处理输出
 */
export function processOutput(
    raw: string,
    mode: OutputMode,
    maxOutput: number,
    tailLines: number,
    maxLines?: number
): { text: string; truncated: boolean; originalBytes: number } {
    const originalBytes = Buffer.byteLength(raw, "utf-8");

    if (mode === "silent") {
        return { text: "", truncated: false, originalBytes };
    }

    // 第一步：折叠连续重复块
    let text = foldRepeatedBlocks(raw);
    let truncated = false;

    // 第二步：outputMode 处理
    if (mode === "tail") {
        const lines = text.split("\n");
        if (lines.length > tailLines) {
            text = `... (省略 ${lines.length - tailLines} 行)\n` + lines.slice(-tailLines).join("\n");
            truncated = true;
        }
    } else if (mode === "head") {
        const lines = text.split("\n");
        if (lines.length > tailLines) {
            text = lines.slice(0, tailLines).join("\n") + `\n... (省略 ${lines.length - tailLines} 行)`;
            truncated = true;
        }
    }

    // 第三步：maxLines 行数截断
    if (maxLines && maxLines > 0) {
        const lines = text.split("\n");
        if (lines.length > maxLines) {
            const headCount = Math.min(5, Math.floor(maxLines / 3));
            const tailCount = Math.min(tailLines, maxLines - headCount);
            const head = lines.slice(0, headCount);
            const tail = lines.slice(-tailCount);
            const omitted = lines.length - headCount - tailCount;
            text = head.join("\n") + `\n... (省略 ${omitted} 行，共 ${lines.length} 行)\n` + tail.join("\n");
            truncated = true;
        }
    }

    // 第四步：maxOutput 字符截断
    if (countTextCharacters(text) > maxOutput) {
        text = sliceTextCharacters(text, maxOutput) + `\n... (截断，总计 ${originalBytes} bytes)`;
        truncated = true;
    }

    return { text, truncated, originalBytes };
}

/**
 * 核心执行函数
 */
export async function execute(options: ExecOptions): Promise<ExecResult> {
    const {
        code,
        command,
        language = DEFAULTS.language,
        cwd,
        env: envParam,
        timeout = DEFAULTS.timeout,
        maxMemoryMB = DEFAULTS.maxMemoryMB,
        memoryRequestMB,
        maxOutput = DEFAULTS.maxOutput,
        responseByteLimit,
        outputMode = DEFAULTS.outputMode,
        tailLines = DEFAULTS.tailLines,
        maxLines,
        gpu,
        ownerId,
        signal,
        admissionBudgetMs,
        retryAttempt,
        reservationMB,
        onQueueProgress,
        deliveryMode = "auto",
        artifactTtlMs,
    } = options;

    const normalizedInput = normalizeExecutionInput(code, command);
    if (normalizedInput.error) {
        return makeParamErrorResult(normalizedInput.error);
    }
    const normalizedCode = normalizedInput.code;
    const normalizedCommand = normalizedInput.command;

    const effectiveTimeout = timeout === 0 ? 0 : Math.min(timeout, DEFAULTS.maxTimeout);
    if (!Number.isFinite(maxMemoryMB) || maxMemoryMB < 16 || maxMemoryMB > DEFAULTS.maxMemoryLimit) {
        return makeParamErrorResult(`错误：maxMemoryMB 必须在 16～${DEFAULTS.maxMemoryLimit} 之间`);
    }
    if (memoryRequestMB !== undefined
        && (!Number.isFinite(memoryRequestMB) || memoryRequestMB < 16 || memoryRequestMB > maxMemoryMB)) {
        return makeParamErrorResult("错误：memoryRequestMB 必须在 16 与 maxMemoryMB 之间");
    }
    const effectiveMemory = maxMemoryMB;
    const inferredMemoryRequestMB = Math.min(
        effectiveMemory,
        Math.max(64, Math.ceil(effectiveMemory / 4)),
    );

    let scriptPath: string | null = null;
    let killed = false;
    let killReason: KillReason | null = null;
    let peakMemoryMB: number | null = null;

    // 确定执行方式
    let execCmd: string;
    let execArgs: string[];
    let effectiveCwd = cwd;

    if (normalizedCommand !== undefined) {
        let effectiveCommand = normalizedCommand;

        // === 层1: 自动检测 cd/pushd 开头 + && 模式，拆分为 cwd + command ===
        if (!effectiveCwd) {
            const cdPattern = /^(?:cd(?:\s+\/d)?|pushd)\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*(.+)$/is;
            const cdMatch = effectiveCommand.match(cdPattern);
            if (cdMatch) {
                effectiveCwd = cdMatch[1] || cdMatch[2] || cdMatch[3];
                effectiveCommand = cdMatch[4].trim();
            }
        }

        // === 层2+3: 选择执行 shell ===
        if (process.platform === "win32") {
            if (language === "cmd") {
                // 显式指定 cmd → 用 cmd
                execCmd = "cmd";
                execArgs = ["/c", `chcp 65001 >nul & ${effectiveCommand}`];
            } else if (language === "bash") {
                // 显式指定 bash → 用 Git Bash
                const bashInfo = getCachedEnvInfo()?.bash;
                const bashCmd = bashInfo?.available ? bashInfo.path : "bash";
                execCmd = bashCmd;
                execArgs = ["-c", effectiveCommand];
            } else if (language === "powershell") {
                // 显式指定 powershell → 用 PowerShell
                execCmd = "powershell";
                execArgs = ["-NoProfile", "-NonInteractive", "-Command",
                    `$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ${effectiveCommand}`];
            } else if (effectiveCommand.includes("&&") || effectiveCommand.includes("||")) {
                // 层3: 命令含 && 或 || → 自动用 cmd（PS 5.1 不支持这些操作符）
                execCmd = "cmd";
                execArgs = ["/c", `chcp 65001 >nul & ${effectiveCommand}`];
            } else {
                // 层4: 兜底 PowerShell（UTF-8 兼容最好）
                execCmd = "powershell";
                execArgs = ["-NoProfile", "-NonInteractive", "-Command",
                    `$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ${effectiveCommand}`];
            }
        } else {
            execCmd = "sh";
            execArgs = ["-c", effectiveCommand];
        }
    } else if (normalizedCode !== undefined) {
        // code 模式
        if (language === "powershell" && normalizedCode.length < 8000) {
            // PowerShell 必须走 -Command 内联执行（-File 的 stdout 输出仍用 GBK）
            const interp = getInterpreterArgs(language, null, normalizedCode, envParam);
            execCmd = interp.cmd;
            execArgs = interp.args;
        } else if (isShortCode(normalizedCode) && (language === "python" || language === "node")) {
            // Python/Node 短代码直接 -c/-e 执行
            const interp = getInterpreterArgs(language, null, normalizedCode, envParam);
            execCmd = interp.cmd;
            execArgs = interp.args;
        } else {
            // 长代码写临时文件
            scriptPath = saveTempScript(language, normalizedCode);
            const interp = getInterpreterArgs(language, scriptPath, null, envParam);
            execCmd = interp.cmd;
            execArgs = interp.args;
        }
    } else {
        return makeParamErrorResult("错误：必须提供 code 或 command 之一");
    }

    const lease = await acquireResourceLease({
        ownerId,
        reservationMB: memoryRequestMB ?? reservationMB ?? inferredMemoryRequestMB,
        admissionBudgetMs,
        retryAttempt,
        signal,
        onWaitProgress: onQueueProgress,
    });
    const cancelBeforeSpawn = (): ExecResult => {
        lease.release();
        if (scriptPath) removeTempFile(scriptPath);
        return makeCancelledBeforeSpawnResult(lease.queueWaitMs);
    };
    if (signal?.aborted) return cancelBeforeSpawn();
    const startTime = Date.now();
    let collector;
    try {
        collector = await createOutputDeliveryCollector({
            mode: deliveryMode,
            combinedLineLimit: maxLines,
            inlineCharacterLimit: maxOutput,
            inlineLineLimit: maxLines,
            responseByteLimit,
            previewHeadBytes: Math.max(4096, tailLines * 256),
            previewTailBytes: Math.max(4096, tailLines * 256),
            artifactTtlMs,
        });
    } catch (error) {
        lease.release();
        throw error;
    }
    if (signal?.aborted) {
        try {
            await collector.finalize({
                mode: deliveryMode,
                status: "interrupted",
                error: "cancelled_before_spawn",
            });
        } catch {
        }
        return cancelBeforeSpawn();
    }

    return new Promise<ExecResult>((resolve) => {
        // 构造环境变量 — 强制 IO 使用 UTF-8（不设 PYTHONUTF8 以兼容 Python 3.9 site-packages）
        const spawnEnv: Record<string, string | undefined> = {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
        };
        if (gpu) {
            spawnEnv.CUDA_VISIBLE_DEVICES = "0";
        }

        const targetCwd = effectiveCwd || process.cwd();
        const windowsJobLaunch = createWindowsJobLaunch(execCmd, execArgs, targetCwd, effectiveMemory);
        let proc: ChildProcess;
        try {
            proc = spawn(
                windowsJobLaunch?.command ?? execCmd,
                windowsJobLaunch?.args ?? execArgs,
                {
                cwd: targetCwd,
                env: spawnEnv,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
        } catch (error) {
            removeWindowsJobMetadata(windowsJobLaunch?.metadataPath ?? null);
            const errorMessage = error instanceof Error ? error.message : String(error);
            void collector.finalize({ status: "error", error: `spawn_failed: ${errorMessage}` }).catch(() => undefined).then(() => {
                lease.release();
                resolve({
                    ...makeParamErrorResult(`进程启动失败: ${errorMessage}`),
                    elapsed: formatElapsed(Date.now() - startTime),
                    killed: true,
                    killReason: "crash",
                    queueWaitMs: lease.queueWaitMs,
                });
            });
            return;
        }

        let resolved = false;
        let finalizing = false;
        let memoryMonitor: NodeJS.Timeout | null = null;

        const applyWindowsJobMetadata = (): boolean => {
            if (!windowsJobLaunch) return false;
            const metadata = readWindowsJobMetadata(windowsJobLaunch.metadataPath);
            if (!metadata) return false;
            const memoryMB = metadata.peakMemoryBytes / 1024 / 1024;
            peakMemoryMB = peakMemoryMB === null ? memoryMB : Math.max(peakMemoryMB, memoryMB);
            lease.updateObservedMemoryMB(memoryMB);
            if (metadata.memoryLimitHit) {
                killed = true;
                killReason = "memory";
            }
            return true;
        };

        const finalize = async () => {
            if (resolved || finalizing) return;
            finalizing = true;

            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (memoryMonitor) clearInterval(memoryMonitor);
            applyWindowsJobMetadata();
            signal?.removeEventListener("abort", onAbort);

            // 清理临时脚本文件
            if (scriptPath) {
                removeTempFile(scriptPath);
            }

            const elapsed = formatElapsed(Date.now() - startTime);

            let delivery: OutputDeliveryResult;
            try {
                delivery = await collector.finalize({
                    mode: deliveryMode,
                status: killed ? "interrupted" : proc.exitCode === 0 ? "done" : "error",
                error: killed ? killReason || undefined : proc.exitCode === 0 ? undefined : `exitCode=${proc.exitCode}`,
                });
            } catch (error) {
                lease.release();
                resolved = true;
                resolve({
                    ...makeParamErrorResult(`输出产物写入失败: ${error instanceof Error ? error.message : String(error)}`),
                    elapsed,
                    killed: true,
                    killReason: "crash",
                    queueWaitMs: lease.queueWaitMs,
                });
                return;
            }

            const previewText = (channel: "stdout" | "stderr"): string => {
                const preview = delivery.preview?.[channel];
                if (!preview) return "";
                if (!preview.head) return preview.tail;
                if (!preview.tail || preview.tail === preview.head) return preview.head;
                return `${preview.head}\n... (完整输出见 artifact) ...\n${preview.tail}`;
            };
            let stdoutText = delivery.stdout ?? previewText("stdout");
            let stderrText = delivery.stderr ?? previewText("stderr");
            let displayTruncated = false;
            if (outputMode === "silent") {
                stdoutText = "";
                stderrText = "";
            } else {
                const processedStdout = processOutput(stdoutText, outputMode, maxOutput, tailLines, maxLines);
                const processedStderr = processOutput(stderrText, "full", maxOutput, tailLines, maxLines);
                stdoutText = processedStdout.text;
                stderrText = processedStderr.text;
                displayTruncated = processedStdout.truncated || processedStderr.truncated;
            }

            lease.release();
            resolved = true;

            const result: ExecResult = {
                stdout: stdoutText,
                stderr: stderrText,
                exitCode: proc.exitCode,
                elapsed,
                killed,
                killReason,
                peakMemoryMB: peakMemoryMB === null ? null : Math.round(peakMemoryMB),
                truncated: delivery.mode !== "inline" || displayTruncated,
                originalBytes: delivery.stats.combined.rawBytes,
                returnedBytes: Buffer.byteLength(stdoutText + stderrText, "utf-8"),
                tempFile: delivery.artifact?.manifestPath ?? null,
                queueWaitMs: lease.queueWaitMs,
                deliveryMode: delivery.mode,
                artifact: delivery.artifact ?? null,
                outputReasons: delivery.reasons,
                outputStats: delivery.stats,
                outputStatus: delivery.status,
                outputComplete: delivery.complete,
                outputReadHint: delivery.readHint ?? null,
            };

            removeWindowsJobMetadata(windowsJobLaunch?.metadataPath ?? null);
            resolve(result);
        };

        proc.stdout?.pipe(collector.stdout);
        proc.stderr?.pipe(collector.stderr);

        proc.on("close", () => void finalize());

        proc.on("error", (err: Error) => {
            killed = true;
            killReason = "crash";
            void collector.write("stderr", `\n进程错误: ${err.message}`).finally(() => void finalize());
        });

        const onAbort = () => {
            if (resolved || !proc.pid) return;
            killed = true;
            killReason = "cancelled";
            killProcessTree(proc.pid);
            setTimeout(() => void finalize(), 200);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();

        // 硬超时（timeout=0 时不设超时，进程运行到自然结束）
        let timeoutTimer: NodeJS.Timeout | null = null;
        if (effectiveTimeout > 0) {
            timeoutTimer = setTimeout(() => {
                if (!resolved && proc.pid) {
                    killed = true;
                    killReason = "timeout";
                    killProcessTree(proc.pid);
                    // 给进程树杀留一点时间
                    setTimeout(() => void finalize(), 200);
                }
            }, effectiveTimeout);
        }

        // Windows Job Object 从进程恢复前即执行硬限制；轮询只负责实时状态。
        // 非 Windows 或辅助程序缺失时保留快速采样降级，未知峰值返回 null 而不是伪造 0MB。
        const sampleMemory = async () => {
            if (resolved || !proc.pid) return;

            try {
                if (windowsJobLaunch) {
                    applyWindowsJobMetadata();
                    return;
                }
                const memMB = await getProcessTreeMemoryMB(proc.pid);
                if (peakMemoryMB === null || memMB > peakMemoryMB) {
                    peakMemoryMB = memMB;
                }
                lease.updateObservedMemoryMB(memMB);

                // 超内存限制
                if (memMB > effectiveMemory) {
                    killed = true;
                    killReason = "memory";
                    killProcessTree(proc.pid);
                    setTimeout(() => void finalize(), 200);
                }
            } catch {
                // pidusage 可能在进程退出后失败，忽略
            }
        };
        void sampleMemory();
        memoryMonitor = setInterval(() => void sampleMemory(), DEFAULTS.memoryCheckInterval);
    });
}
