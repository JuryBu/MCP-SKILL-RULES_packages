import { spawn, execSync, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import pidusage from "pidusage";
import { saveTempScript, saveTempOutput, removeTempFile } from "./temp-store.js";
import { resolveInterpreter, getCachedEnvInfo } from "./env-detector.js";
import { formatElapsed } from "./lifecycle.js";

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

export type KillReason = "timeout" | "memory" | "vram" | "manual" | "crash";
export type OutputMode = "full" | "tail" | "head" | "silent";

export interface ExecOptions {
    code?: string;
    command?: string;
    language?: string;
    cwd?: string;
    env?: string;
    timeout?: number;
    maxMemoryMB?: number;
    maxOutput?: number;
    outputMode?: OutputMode;
    tailLines?: number;
    maxLines?: number;
    gpu?: boolean;
    maxVRAM_MB?: number;
}

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    elapsed: string;
    killed: boolean;
    killReason: KillReason | null;
    peakMemoryMB: number;
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    tempFile: string | null;
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
        peakMemoryMB: 0,
        truncated: false,
        originalBytes: 0,
        returnedBytes: 0,
        tempFile: null,
    };
}

// 默认值
const DEFAULTS = {
    language: "python",
    timeout: 30000,       // 30秒
    maxTimeout: 300000,   // 5分钟
    maxMemoryMB: 256,
    maxMemoryLimit: 1024,
    maxOutput: 8000,
    outputMode: "full" as OutputMode,
    tailLines: 20,
    maxVRAM_MB: 2048,
    memoryCheckInterval: 2000,  // 2秒采样
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
    if (text.length > maxOutput) {
        text = text.slice(0, maxOutput) + `\n... (截断，总计 ${originalBytes} bytes)`;
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
        maxOutput = DEFAULTS.maxOutput,
        outputMode = DEFAULTS.outputMode,
        tailLines = DEFAULTS.tailLines,
        maxLines,
        gpu,
    } = options;

    const normalizedInput = normalizeExecutionInput(code, command);
    if (normalizedInput.error) {
        return makeParamErrorResult(normalizedInput.error);
    }
    const normalizedCode = normalizedInput.code;
    const normalizedCommand = normalizedInput.command;

    const effectiveTimeout = timeout === 0 ? 0 : Math.min(timeout, DEFAULTS.maxTimeout);
    const effectiveMemory = Math.min(maxMemoryMB, DEFAULTS.maxMemoryLimit);

    const startTime = Date.now();
    let scriptPath: string | null = null;
    let killed = false;
    let killReason: KillReason | null = null;
    let peakMemoryMB = 0;

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

    return new Promise<ExecResult>((resolve) => {
        // 构造环境变量 — 强制 IO 使用 UTF-8（不设 PYTHONUTF8 以兼容 Python 3.9 site-packages）
        const spawnEnv: Record<string, string | undefined> = {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
        };
        if (gpu) {
            spawnEnv.CUDA_VISIBLE_DEVICES = "0";
        }

        const proc: ChildProcess = spawn(execCmd, execArgs, {
            cwd: effectiveCwd || process.cwd(),
            env: spawnEnv,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });

        let stdoutBuf = "";
        let stderrBuf = "";
        let resolved = false;
        // StringDecoder 安全处理 UTF-8 多字节字符的流切分
        const stdoutDecoder = new StringDecoder("utf-8");
        const stderrDecoder = new StringDecoder("utf-8");

        const finalize = () => {
            if (resolved) return;
            resolved = true;

            if (timeoutTimer) clearTimeout(timeoutTimer);
            clearInterval(memoryMonitor);

            // 清理临时脚本文件
            if (scriptPath) {
                removeTempFile(scriptPath);
            }

            const elapsed = formatElapsed(Date.now() - startTime);

            // 处理输出
            const stdoutResult = processOutput(stdoutBuf, outputMode, maxOutput, tailLines, maxLines);
            const stderrResult = processOutput(stderrBuf, outputMode === "silent" ? "silent" : "full", maxOutput, tailLines);

            // 大输出写临时文件
            let tempFile: string | null = null;
            if (stdoutResult.truncated || stderrResult.truncated) {
                tempFile = saveTempOutput([
                    "--- stdout ---",
                    stdoutBuf,
                    "--- stderr ---",
                    stderrBuf,
                ].join("\n"));
            }

            const result: ExecResult = {
                stdout: stdoutResult.text,
                stderr: stderrResult.text,
                exitCode: proc.exitCode,
                elapsed,
                killed,
                killReason,
                peakMemoryMB: Math.round(peakMemoryMB),
                truncated: stdoutResult.truncated || stderrResult.truncated,
                originalBytes: stdoutResult.originalBytes + stderrResult.originalBytes,
                returnedBytes: Buffer.byteLength(stdoutResult.text + stderrResult.text, "utf-8"),
                tempFile,
            };

            resolve(result);
        };

        // 收集输出（使用 StringDecoder 安全处理 UTF-8 多字节字符切分）
        proc.stdout?.on("data", (data: Buffer) => {
            stdoutBuf += stdoutDecoder.write(data);
        });

        proc.stderr?.on("data", (data: Buffer) => {
            stderrBuf += stderrDecoder.write(data);
        });

        // 进程退出
        proc.on("exit", () => {
            // 给一点时间收集剩余的输出
            setTimeout(finalize, 50);
        });

        proc.on("error", (err: Error) => {
            stderrBuf += `\n进程错误: ${err.message}`;
            killed = true;
            killReason = "crash";
            finalize();
        });

        // 硬超时（timeout=0 时不设超时，进程运行到自然结束）
        let timeoutTimer: NodeJS.Timeout | null = null;
        if (effectiveTimeout > 0) {
            timeoutTimer = setTimeout(() => {
                if (!resolved && proc.pid) {
                    killed = true;
                    killReason = "timeout";
                    killProcessTree(proc.pid);
                    // 给进程树杀留一点时间
                    setTimeout(finalize, 200);
                }
            }, effectiveTimeout);
        }

        // 内存监控（2秒采样）
        const memoryMonitor = setInterval(async () => {
            if (resolved || !proc.pid) return;

            try {
                const memMB = await getProcessTreeMemoryMB(proc.pid);
                if (memMB > peakMemoryMB) {
                    peakMemoryMB = memMB;
                }

                // 超内存限制
                if (memMB > effectiveMemory) {
                    killed = true;
                    killReason = "memory";
                    killProcessTree(proc.pid);
                    setTimeout(finalize, 200);
                }
            } catch {
                // pidusage 可能在进程退出后失败，忽略
            }
        }, DEFAULTS.memoryCheckInterval);
    });
}
