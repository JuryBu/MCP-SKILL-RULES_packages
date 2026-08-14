import { execFile, spawn, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import pidusage from "pidusage";
import { resolveInterpreter } from "./env-detector.js";
import { killProcessTree } from "./executor.js";
import { formatElapsed } from "./lifecycle.js";
import { hasOwnerAccess, newUuid, normalizeOwnerId, ownerMismatchText } from "./owner.js";
import { acquireResourceLease, type ManagedResourceLease } from "./resource-admission-runtime.js";
import {
    createOutputDeliveryCollector,
    type OutputDeliveryCollector,
    type OutputDeliveryMode,
    type OutputDeliveryResult,
} from "./output-delivery.js";
import {
    createWindowsJobLaunch,
    readWindowsJobMetadata,
    removeWindowsJobMetadata,
} from "./windows-job-runner.js";
import {
    inferMemoryRequestMB,
    PROCESS_TREE_MAX_MEMORY_MB,
    readConfiguredMemoryMB,
    validateProcessTreeMemory,
} from "./memory-limits.js";

/**
 * MCP Sandbox REPL 会话管理器
 *
 * 核心设计：
 * - Sentinel 标记法输出边界检测
 * - 持续读取 stdout/stderr 防管道堵塞
 * - 进程崩溃检测 + 僵尸会话清理
 * - 每会话独立内存限制
 * - 空闲 5 分钟自动关闭
 */

function readPositiveIntegerEnv(name: string, fallback: number, minimum: number = 1): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

export interface SessionLimits {
    maxSessions: number;
    maxTotalMemoryMB: number;
    defaultMemoryMB: number;
    idleTimeoutMs: number;
}

const SESSION_LIMITS: Readonly<SessionLimits> = Object.freeze({
    maxSessions: readPositiveIntegerEnv("SANDBOX_SESSION_MAX_COUNT", 5),
    maxTotalMemoryMB: readPositiveIntegerEnv("SANDBOX_SESSION_MAX_TOTAL_MEMORY_MB", 1536, 16),
    defaultMemoryMB: readConfiguredMemoryMB(
        "SANDBOX_SESSION_DEFAULT_MEMORY_MB",
        256,
        16,
        PROCESS_TREE_MAX_MEMORY_MB,
    ),
    idleTimeoutMs: readPositiveIntegerEnv("SANDBOX_SESSION_IDLE_TIMEOUT_MS", 5 * 60 * 1000, 1000),
});

async function readProcessMemoryMB(pid: number): Promise<number> {
    try {
        const stats = await pidusage(pid);
        return stats.memory / (1024 * 1024);
    } catch (error) {
        if (process.platform !== "win32") throw error;
        return await new Promise<number>((resolve, reject) => {
            const command = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
            execFile(
                "powershell.exe",
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
                { encoding: "utf8", timeout: 3000, windowsHide: true },
                (fallbackError, stdout) => {
                    if (fallbackError) {
                        reject(fallbackError);
                        return;
                    }
                    const workingSetBytes = Number(String(stdout).trim());
                    if (!Number.isFinite(workingSetBytes) || workingSetBytes < 0) {
                        reject(new Error(`Invalid WorkingSet64 for PID ${pid}`));
                        return;
                    }
                    resolve(workingSetBytes / (1024 * 1024));
                },
            );
        });
    }
}

const IDLE_CHECK_INTERVAL_MS = Math.max(1000, Math.min(30000, Math.floor(SESSION_LIMITS.idleTimeoutMs / 2)));
const MEMORY_CHECK_INTERVAL = 100;
const SESSION_ROLLING_BUFFER_CHARS = 1024 * 1024;

function appendRollingBuffer(current: string, chunk: string): string {
    const combined = current + chunk;
    return combined.length <= SESSION_ROLLING_BUFFER_CHARS
        ? combined
        : combined.slice(-SESSION_ROLLING_BUFFER_CHARS);
}

export function getSessionLimits(): SessionLimits {
    return { ...SESSION_LIMITS };
}

export interface Session {
    id: string;
    ownerId: string;
    language: string;
    process: ChildProcess;
    pid: number;
    cwd: string;
    maxMemoryMB: number;
    reservationMB: number;
    memoryMetadataPath: string | null;
    createdAt: number;
    lastActivity: number;
    execCount: number;
    alive: boolean;
    currentMemoryMB: number;
    // 输出缓冲（持续收集）
    stdoutBuffer: string;
    stderrBuffer: string;
    execQueue: Promise<void>;
    executing: boolean;
    resourceLease: ManagedResourceLease;
    activeOutputCollector: OutputDeliveryCollector | null;
}

export interface SessionExecResult {
    stdout: string;
    stderr: string;
    elapsed: string;
    killed: boolean;
    killReason: string | null;
    outputDelivery: OutputDeliveryResult | null;
}

export interface SessionStatus {
    id: string;
    ownerId: string;
    language: string;
    alive: boolean;
    memoryMB: number;
    uptime: string;
    execCount: number;
}

// 会话存储
const sessions = new Map<string, Session>();
let pendingSessionCount = 0;
let pendingSessionMemoryMB = 0;

// 空闲检查定时器
let idleChecker: ReturnType<typeof setInterval> | null = null;

/**
 * 生成唯一的 sentinel 标记
 */
function generateSentinel(): string {
    const rand = Math.random().toString(36).slice(2, 10);
    return `__SANDBOX_SENTINEL_${rand}__`;
}

/**
 * 生成注入 sentinel 的代码
 */
function wrapWithSentinel(code: string, sentinel: string, language: string): string {
    if (language === "python") {
        // 使用 exec 包装确保多行代码正确执行
        // 然后打印 sentinel 标记
        const escapedCode = code.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        return `exec('${escapedCode}')\nprint("${sentinel}")\n`;
    } else if (language === "node") {
        const escapedCode = code.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");
        return `eval(\`${escapedCode}\`); console.log("${sentinel}");\n`;
    }
    return code + `\n echo "${sentinel}"\n`;
}

/**
 * 启动 REPL 进程
 */
function spawnREPL(language: string, cwd: string, maxMemoryMB: number, envParam?: string): {
    process: ChildProcess;
    memoryMetadataPath: string | null;
} {
    const customInterpreter = resolveInterpreter(envParam, language);

    let cmd: string;
    let args: string[];

    if (language === "python") {
        cmd = customInterpreter || "python";
        args = ["-u", "-i", "-q"]; // unbuffered, interactive, quiet
    } else if (language === "node") {
        cmd = customInterpreter || "node";
        args = ["-i"]; // interactive
    } else {
        cmd = language;
        args = [];
    }

    const windowsJobLaunch = createWindowsJobLaunch(cmd, args, cwd, maxMemoryMB);
    const proc = spawn(windowsJobLaunch?.command ?? cmd, windowsJobLaunch?.args ?? args, {
        cwd: windowsJobLaunch?.spawnCwd ?? cwd,
        env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    return { process: proc, memoryMetadataPath: windowsJobLaunch?.metadataPath ?? null };
}

function waitForProcessSpawn(proc: ChildProcess): Promise<Error | null> {
    return new Promise((resolve) => {
        const onSpawn = () => {
            proc.removeListener("error", onError);
            resolve(null);
        };
        const onError = (error: Error) => {
            proc.removeListener("spawn", onSpawn);
            resolve(error);
        };
        proc.once("spawn", onSpawn);
        proc.once("error", onError);
    });
}

async function waitForWindowsJobReady(
    proc: ChildProcess,
    metadataPath: string | null,
): Promise<{ ready: boolean; errorType: string | null }> {
    if (!metadataPath) return { ready: true, errorType: null };
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
        const metadata = readWindowsJobMetadata(metadataPath);
        if (metadata) return { ready: metadata.commandStarted, errorType: metadata.startErrorType };
        if (proc.exitCode !== null || proc.signalCode !== null) return { ready: false, errorType: "payload_start_failed" };
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { ready: false, errorType: "windows_job_runner_not_ready" };
}

/**
 * 创建新会话
 */
export async function createSession(
    language: string = "python",
    cwd: string = process.cwd(),
    maxMemoryMB: number = SESSION_LIMITS.defaultMemoryMB,
    envParam?: string,
    ownerId?: string,
    signal?: AbortSignal,
    memoryRequestMB?: number,
): Promise<{ session: Session } | { error: string }> {
    // 清理僵尸会话
    cleanDeadSessions();

    if (sessions.size + pendingSessionCount >= SESSION_LIMITS.maxSessions) {
        return { error: `已达最大会话数量限制 (${SESSION_LIMITS.maxSessions})。请先关闭不需要的会话。` };
    }

    const effectiveMemoryRequestMB = memoryRequestMB ?? inferMemoryRequestMB(maxMemoryMB);
    const memoryValidationError = validateProcessTreeMemory(maxMemoryMB, effectiveMemoryRequestMB, "会话");
    if (memoryValidationError) return { error: memoryValidationError };

    // 会话用预期量参与调度，Job Object 继续按 maxMemoryMB 执行硬限制。
    const reservedMemory = getReservedSessionMemory() + pendingSessionMemoryMB;
    if (reservedMemory + effectiveMemoryRequestMB > SESSION_LIMITS.maxTotalMemoryMB) {
        return { error: `总内存请求量将超限：当前 ${Math.round(reservedMemory)}MB + 新会话 ${effectiveMemoryRequestMB}MB > 上限 ${SESSION_LIMITS.maxTotalMemoryMB}MB` };
    }

    pendingSessionCount += 1;
    pendingSessionMemoryMB += effectiveMemoryRequestMB;
    let pendingReservationActive = true;
    let resourceLease: ManagedResourceLease | null = null;

    try {
        resourceLease = await acquireResourceLease({
            ownerId,
            reservationMB: effectiveMemoryRequestMB,
            signal,
        });
        if (signal?.aborted) {
            resourceLease.release();
            return { error: "资源等待已取消，Session 进程未启动" };
        }
        const id = newUuid();
        let proc: ChildProcess;
        try {
            const spawned = spawnREPL(language, cwd, maxMemoryMB, envParam);
            proc = spawned.process;
            var memoryMetadataPath = spawned.memoryMetadataPath;
        } catch (error) {
            resourceLease.release();
            return { error: `进程启动失败: ${error instanceof Error ? error.message : String(error)}` };
        }

        const spawnError = await waitForProcessSpawn(proc);
        const windowsJobReady = !spawnError && proc.pid
            ? await waitForWindowsJobReady(proc, memoryMetadataPath)
            : { ready: false, errorType: null };
        if (spawnError || !proc.pid || !windowsJobReady.ready) {
            removeWindowsJobMetadata(memoryMetadataPath);
            if (proc.pid) await killProcessTree(proc.pid);
            resourceLease.release();
            const detail = spawnError?.message
                || windowsJobReady.errorType
                || (memoryMetadataPath ? "Windows Job Object 未确认子进程启动" : "未知启动错误");
            return { error: `进程启动失败: ${detail}` };
        }
        if (signal?.aborted) {
            if (proc.pid) await killProcessTree(proc.pid);
            removeWindowsJobMetadata(memoryMetadataPath);
            resourceLease.release();
            return { error: "Session 启动期间调用已取消，进程已终止" };
        }

        const session: Session = {
            id,
            ownerId: normalizeOwnerId(ownerId),
            language,
            process: proc,
            pid: proc.pid,
            cwd,
            maxMemoryMB,
            reservationMB: effectiveMemoryRequestMB,
            memoryMetadataPath,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            execCount: 0,
            alive: true,
            currentMemoryMB: 0,
            stdoutBuffer: "",
            stderrBuffer: "",
            execQueue: Promise.resolve(),
            executing: false,
            resourceLease,
            activeOutputCollector: null,
        };

        // StringDecoder 安全处理 UTF-8 多字节字符的流切分
        const stdoutDecoder = new StringDecoder("utf-8");
        const stderrDecoder = new StringDecoder("utf-8");

        // 持续读取输出（防管道堵塞）
        proc.stdout?.on("data", (data: Buffer) => {
            session.stdoutBuffer = appendRollingBuffer(session.stdoutBuffer, stdoutDecoder.write(data));
            const collector = session.activeOutputCollector;
            if (collector && !collector.stdout.write(data)) {
                proc.stdout?.pause();
                collector.stdout.once("drain", () => proc.stdout?.resume());
            }
        });

        proc.stderr?.on("data", (data: Buffer) => {
            session.stderrBuffer = appendRollingBuffer(session.stderrBuffer, stderrDecoder.write(data));
            const collector = session.activeOutputCollector;
            if (collector && !collector.stderr.write(data)) {
                proc.stderr?.pause();
                collector.stderr.once("drain", () => proc.stderr?.resume());
            }
        });

        // 进程退出检测
        proc.on("exit", (code, signal) => {
            session.alive = false;
            session.resourceLease.release();
            removeWindowsJobMetadata(session.memoryMetadataPath);
            console.error(`[sandbox] 会话 ${id} 退出: code=${code} signal=${signal}`);
        });

        proc.on("error", (err) => {
            session.alive = false;
            session.resourceLease.release();
            removeWindowsJobMetadata(session.memoryMetadataPath);
            console.error(`[sandbox] 会话 ${id} 错误: ${err.message}`);
        });

        sessions.set(id, session);

        // 启动空闲检查器（如果未启动）
        startIdleChecker();

        console.error(`[sandbox] 新会话 ${id}: ${language} @ ${cwd} (maxMem: ${maxMemoryMB}MB)`);

        return { session };
    } catch (error) {
        resourceLease?.release();
        throw error;
    } finally {
        if (pendingReservationActive) {
            pendingReservationActive = false;
            pendingSessionCount -= 1;
            pendingSessionMemoryMB -= effectiveMemoryRequestMB;
        }
    }
}

/**
 * 在会话中执行代码（Sentinel 标记法）
 */
export async function execInSession(
    sessionId: string,
    code: string,
    timeout: number = 15000,
    ownerId?: string,
    signal?: AbortSignal,
    deliveryMode: OutputDeliveryMode = "auto",
    maxLines?: number,
    maxOutput?: number,
): Promise<SessionExecResult> {
    const session = sessions.get(sessionId);
    const requestOwner = normalizeOwnerId(ownerId);

    if (!session) {
        return {
            stdout: "",
            stderr: `会话 ${sessionId} 不存在`,
            elapsed: "0ms",
            killed: false,
            killReason: null,
            outputDelivery: null,
        };
    }

    if (!hasOwnerAccess(session.ownerId, requestOwner)) {
        return {
            stdout: "",
            stderr: ownerMismatchText("会话", sessionId),
            elapsed: "0ms",
            killed: false,
            killReason: "owner",
            outputDelivery: null,
        };
    }

    const cancelledBeforeStart = (): SessionExecResult => ({
        stdout: "",
        stderr: `会话 ${sessionId} 的排队执行已取消，代码未运行`,
        elapsed: "0ms",
        killed: true,
        killReason: "cancelled",
        outputDelivery: null,
    });

    if (signal?.aborted) return cancelledBeforeStart();

    let started = false;
    const run = () => {
        started = true;
        if (signal?.aborted) return cancelledBeforeStart();
        return execInSessionUnlocked(session, code, timeout, signal, deliveryMode, maxLines, maxOutput);
    };
    const queued = session.execQueue.then(run, run);
    session.execQueue = queued.then(() => undefined, () => undefined);

    if (!signal) return queued;

    return new Promise<SessionExecResult>((resolve) => {
        let settled = false;
        const finish = (result: SessionExecResult) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const onAbort = () => {
            if (!started) finish(cancelledBeforeStart());
        };

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        queued.then(finish, (error) => finish({
            stdout: "",
            stderr: `会话 ${sessionId} 执行异常: ${error instanceof Error ? error.message : String(error)}`,
            elapsed: "0ms",
            killed: true,
            killReason: "crash",
            outputDelivery: null,
        }));
    });
}

async function execInSessionUnlocked(
    session: Session,
    code: string,
    timeout: number,
    signal?: AbortSignal,
    deliveryMode: OutputDeliveryMode = "auto",
    maxLines?: number,
    maxOutput?: number,
): Promise<SessionExecResult> {
    const sessionId = session.id;

    if (!session.alive) {
        sessions.delete(sessionId);
        return {
            stdout: "",
            stderr: `会话 ${sessionId} 已死亡（进程已退出）`,
            elapsed: "0ms",
            killed: false,
            killReason: "crash",
            outputDelivery: null,
        };
    }

    const outputCollector = await createOutputDeliveryCollector({
        mode: deliveryMode,
        combinedLineLimit: maxLines,
        inlineCharacterLimit: maxOutput,
        inlineLineLimit: maxLines,
    });
    session.activeOutputCollector = outputCollector;

    session.lastActivity = Date.now();
    session.execCount++;
    session.executing = true;
    const startTime = Date.now();

    const sentinel = generateSentinel();

    // 清空缓冲区
    session.stdoutBuffer = "";
    session.stderrBuffer = "";

    // 注入 sentinel 的代码
    const wrappedCode = wrapWithSentinel(code, sentinel, session.language);

    return new Promise<SessionExecResult>((resolve) => {
        let resolved = false;
        let killed = false;
        let killReason: string | null = null;
        let timeoutTimer: NodeJS.Timeout | null = null;
        let memoryChecker: NodeJS.Timeout | null = null;
        let sentinelChecker: NodeJS.Timeout | null = null;

        const finalize = async () => {
            if (resolved) return;
            resolved = true;

            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (memoryChecker) clearInterval(memoryChecker);
            if (sentinelChecker) clearInterval(sentinelChecker);
            signal?.removeEventListener("abort", onAbort);
            session.executing = false;
            session.lastActivity = Date.now();
            session.activeOutputCollector = null;

            let outputDelivery: OutputDeliveryResult | null = null;
            try {
                outputDelivery = await outputCollector.finalize({
                    mode: deliveryMode,
                    status: killed ? "interrupted" : "done",
                    error: killed ? killReason || undefined : undefined,
                    readHint: "This is raw REPL stdout/stderr; internal sentinel and prompt text may appear near command boundaries.",
                });
            } catch (error) {
                session.stderrBuffer = appendRollingBuffer(session.stderrBuffer, `\n输出artifact写入失败: ${error instanceof Error ? error.message : String(error)}`);
            }

            // 从输出中去除 sentinel 标记及之后的内容
            const previewText = (channel: "stdout" | "stderr"): string => {
                if (!outputDelivery) return channel === "stdout" ? session.stdoutBuffer : session.stderrBuffer;
                const inline = channel === "stdout" ? outputDelivery.stdout : outputDelivery.stderr;
                if (inline !== undefined) return inline;
                const preview = outputDelivery.preview?.[channel];
                if (!preview) return "";
                if (!preview.head) return preview.tail;
                if (!preview.tail || preview.tail === preview.head) return preview.head;
                return `${preview.head}\n... (完整输出见 artifact) ...\n${preview.tail}`;
            };
            let stdout = previewText("stdout");
            const sentinelIdx = stdout.indexOf(sentinel);
            if (sentinelIdx !== -1) {
                stdout = stdout.slice(0, sentinelIdx).trim();
            }

            // 清理 Python/Node REPL 提示符
            stdout = stdout.replace(/^>>>\s*/gm, "").replace(/^\.\.\.\s*/gm, "").trim();

            // 清理 stderr 中的 REPL 提示符
            let stderr = previewText("stderr")
                .replace(/^>>>\s*/gm, "")
                .replace(/^\.\.\.\s*/gm, "")
                .replace(/^>\s*$/gm, "")
                .trim();
            // 如果 stderr 只剩空白/提示符，清空
            if (/^[>\s.]*$/.test(stderr)) stderr = "";
            const elapsed = formatElapsed(Date.now() - startTime);

            resolve({
                stdout,
                stderr,
                elapsed,
                killed,
                killReason,
                outputDelivery,
            });
        };

        let terminationPromise: Promise<void> | null = null;
        const terminate = (reason: string) => {
            if (resolved || terminationPromise) return;
            killed = true;
            killReason = reason;
            terminationPromise = killProcessTree(session.pid);
            void terminationPromise.finally(() => {
                session.alive = false;
                session.resourceLease.release();
                void finalize();
            });
        };

        const onAbort = () => terminate("cancelled");

        // 监听 sentinel 出现
        sentinelChecker = setInterval(() => {
            if (session.stdoutBuffer.includes(sentinel)) {
                if (sentinelChecker) clearInterval(sentinelChecker);
                // 给一点时间收集剩余输出
                setTimeout(() => void finalize(), 50);
            }
            // REPL 崩溃检测：进程已死但 sentinel 未出现
            if (!session.alive && !resolved) {
                if (sentinelChecker) clearInterval(sentinelChecker);
                killed = true;
                killReason = "crash";
                void finalize();
            }
        }, 30);

        // 超时：杀死进程防止后台资源泄漏
        timeoutTimer = setTimeout(() => terminate("timeout"), timeout);

        // 内存检查
        memoryChecker = setInterval(async () => {
            if (resolved || !session.alive) return;
            try {
                const metadata = session.memoryMetadataPath
                    ? readWindowsJobMetadata(session.memoryMetadataPath)
                    : null;
                if (session.memoryMetadataPath) {
                    if (!metadata) return;
                    session.currentMemoryMB = metadata.peakMemoryBytes / 1024 / 1024;
                } else {
                    session.currentMemoryMB = await readProcessMemoryMB(session.pid);
                }
                session.resourceLease.updateObservedMemoryMB(session.currentMemoryMB);
                if (metadata?.memoryLimitHit || session.currentMemoryMB > session.maxMemoryMB) {
                    terminate("memory");
                }
            } catch { /* 忽略 */ }
        }, MEMORY_CHECK_INTERVAL);

        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }

        // 发送代码到 REPL
        try {
            if (!session.process.stdin) throw new Error("REPL stdin 不可用");
            session.process.stdin.write(wrappedCode);
        } catch (err) {
            session.stderrBuffer += `\n写入 REPL stdin 失败: ${err instanceof Error ? err.message : String(err)}`;
            terminate("crash");
        }
    });
}

/**
 * 获取会话状态
 */
export async function getSessionStatus(sessionId: string): Promise<SessionStatus | null> {
    const session = sessions.get(sessionId);
    if (!session) return null;

    // 更新内存信息
    if (session.alive) {
        try {
            const metadata = session.memoryMetadataPath
                ? readWindowsJobMetadata(session.memoryMetadataPath)
                : null;
            if (session.memoryMetadataPath) {
                if (metadata) session.currentMemoryMB = metadata.peakMemoryBytes / 1024 / 1024;
            } else {
                session.currentMemoryMB = await readProcessMemoryMB(session.pid);
            }
            session.resourceLease.updateObservedMemoryMB(session.currentMemoryMB);
        } catch {
            if (session.process.exitCode !== null || session.process.signalCode !== null) {
                session.alive = false;
            }
        }
    }

    return {
        id: session.id,
        ownerId: session.ownerId,
        language: session.language,
        alive: session.alive,
        memoryMB: Math.round(session.currentMemoryMB),
        uptime: formatElapsed(Date.now() - session.createdAt),
        execCount: session.execCount,
    };
}

/**
 * 关闭会话
 */
export async function closeSession(sessionId: string): Promise<boolean> {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.alive) {
        try {
            await killProcessTree(session.pid);
        } catch { /* 忽略 */ }
        session.alive = false;
        session.resourceLease.release();
    }

    sessions.delete(sessionId);
    removeWindowsJobMetadata(session.memoryMetadataPath);
    console.error(`[sandbox] 会话 ${sessionId} 已关闭`);
    return true;
}

export function canAccessSession(sessionId: string, ownerId?: string): boolean | null {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return hasOwnerAccess(session.ownerId, normalizeOwnerId(ownerId));
}

export async function closeSessionForOwner(sessionId: string, ownerId?: string): Promise<{ closed: boolean; error?: string }> {
    const access = canAccessSession(sessionId, ownerId);
    if (access === null) return { closed: false };
    if (!access) return { closed: false, error: ownerMismatchText("会话", sessionId) };
    return { closed: await closeSession(sessionId) };
}

/**
 * 列出所有活跃会话
 */
export async function listSessions(ownerId?: string): Promise<SessionStatus[]> {
    cleanDeadSessions();
    const result: SessionStatus[] = [];
    const requestOwner = normalizeOwnerId(ownerId);
    for (const [id] of sessions) {
        const session = sessions.get(id);
        if (session && !hasOwnerAccess(session.ownerId, requestOwner)) continue;
        const status = await getSessionStatus(id);
        if (status) result.push(status);
    }
    return result;
}

/**
 * 清理僵尸会话
 */
function cleanDeadSessions(): void {
    for (const [id, session] of sessions) {
        if (!session.alive) {
            sessions.delete(id);
            session.resourceLease.release();
            removeWindowsJobMetadata(session.memoryMetadataPath);
            console.error(`[sandbox] 清理僵尸会话 ${id}`);
        }
    }
}

/**
 * 获取活跃会话的总内存预留额度
 */
function getReservedSessionMemory(): number {
    let total = 0;
    for (const [, session] of sessions) {
        if (session.alive) {
            total += session.reservationMB;
        }
    }
    return total;
}

/**
 * 启动空闲检查器
 */
function startIdleChecker(): void {
    if (idleChecker) return;

    idleChecker = setInterval(() => {
        const now = Date.now();
        for (const [id, session] of sessions) {
            if (session.alive && !session.executing && (now - session.lastActivity) > SESSION_LIMITS.idleTimeoutMs) {
                console.error(`[sandbox] 会话 ${id} 空闲超时 (${formatElapsed(now - session.lastActivity)})，自动关闭`);
                void closeSession(id);
            }
        }

        // 没有会话了就停止检查器
        if (sessions.size === 0) {
            clearInterval(idleChecker!);
            idleChecker = null;
        }
    }, IDLE_CHECK_INTERVAL_MS);

    idleChecker.unref(); // 不阻塞 Node.js 退出
}

/**
 * 关闭所有会话（MCP 退出时调用）
 */
export function closeAllSessions(): void {
    for (const [id] of sessions) {
        void closeSession(id);
    }
    if (idleChecker) {
        clearInterval(idleChecker);
        idleChecker = null;
    }
    console.error("[sandbox] 所有会话已关闭");
}

/**
 * 获取活跃会话数量
 */
export function getActiveSessionCount(): number {
    cleanDeadSessions();
    return sessions.size;
}
