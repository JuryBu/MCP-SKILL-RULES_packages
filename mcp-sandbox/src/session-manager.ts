import { spawn, ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import pidusage from "pidusage";
import { resolveInterpreter } from "./env-detector.js";
import { killProcessTree } from "./executor.js";
import { formatElapsed } from "./lifecycle.js";

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

// 限制常量
const MAX_SESSIONS = 3;
const MAX_TOTAL_MEMORY_MB = 768;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const MEMORY_CHECK_INTERVAL = 5000;     // 5 秒采样

// 计数器
let sessionCounter = 0;

export interface Session {
    id: string;
    language: string;
    process: ChildProcess;
    pid: number;
    cwd: string;
    maxMemoryMB: number;
    createdAt: number;
    lastActivity: number;
    execCount: number;
    alive: boolean;
    currentMemoryMB: number;
    // 输出缓冲（持续收集）
    stdoutBuffer: string;
    stderrBuffer: string;
}

export interface SessionExecResult {
    stdout: string;
    stderr: string;
    elapsed: string;
    killed: boolean;
    killReason: string | null;
}

export interface SessionStatus {
    id: string;
    language: string;
    alive: boolean;
    memoryMB: number;
    uptime: string;
    execCount: number;
}

// 会话存储
const sessions = new Map<string, Session>();

// 空闲检查定时器
let idleChecker: ReturnType<typeof setInterval> | null = null;

/**
 * 生成会话 ID（语言-序号格式）
 */
function generateSessionId(language: string): string {
    sessionCounter++;
    const prefix = language === "python" ? "py" : language === "node" ? "node" : language;
    return `${prefix}-${String(sessionCounter).padStart(3, "0")}`;
}

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
function spawnREPL(language: string, cwd: string, envParam?: string): ChildProcess {
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

    const proc = spawn(cmd, args, {
        cwd,
        env: {
            ...process.env,
            PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    return proc;
}

/**
 * 创建新会话
 */
export function createSession(
    language: string = "python",
    cwd: string = process.cwd(),
    maxMemoryMB: number = 256,
    envParam?: string
): { session: Session } | { error: string } {
    // 清理僵尸会话
    cleanDeadSessions();

    // 检查会话数量限制
    if (sessions.size >= MAX_SESSIONS) {
        return { error: `已达最大会话数量限制 (${MAX_SESSIONS})。请先关闭不需要的会话。` };
    }

    // 检查总内存限制
    const currentTotalMemory = getTotalMemoryUsage();
    if (currentTotalMemory + maxMemoryMB > MAX_TOTAL_MEMORY_MB) {
        return { error: `总内存将超限：当前 ${Math.round(currentTotalMemory)}MB + 新会话 ${maxMemoryMB}MB > 上限 ${MAX_TOTAL_MEMORY_MB}MB` };
    }

    const id = generateSessionId(language);
    const proc = spawnREPL(language, cwd, envParam);

    if (!proc.pid) {
        return { error: "进程启动失败" };
    }

    const session: Session = {
        id,
        language,
        process: proc,
        pid: proc.pid,
        cwd,
        maxMemoryMB,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        execCount: 0,
        alive: true,
        currentMemoryMB: 0,
        stdoutBuffer: "",
        stderrBuffer: "",
    };

    // StringDecoder 安全处理 UTF-8 多字节字符的流切分
    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");

    // 持续读取输出（防管道堵塞）
    proc.stdout?.on("data", (data: Buffer) => {
        session.stdoutBuffer += stdoutDecoder.write(data);
    });

    proc.stderr?.on("data", (data: Buffer) => {
        session.stderrBuffer += stderrDecoder.write(data);
    });

    // 进程退出检测
    proc.on("exit", (code, signal) => {
        session.alive = false;
        console.error(`[sandbox] 会话 ${id} 退出: code=${code} signal=${signal}`);
    });

    proc.on("error", (err) => {
        session.alive = false;
        console.error(`[sandbox] 会话 ${id} 错误: ${err.message}`);
    });

    sessions.set(id, session);

    // 启动空闲检查器（如果未启动）
    startIdleChecker();

    console.error(`[sandbox] 新会话 ${id}: ${language} @ ${cwd} (maxMem: ${maxMemoryMB}MB)`);

    return { session };
}

/**
 * 在会话中执行代码（Sentinel 标记法）
 */
export async function execInSession(
    sessionId: string,
    code: string,
    timeout: number = 15000
): Promise<SessionExecResult> {
    const session = sessions.get(sessionId);

    if (!session) {
        return {
            stdout: "",
            stderr: `会话 ${sessionId} 不存在`,
            elapsed: "0ms",
            killed: false,
            killReason: null,
        };
    }

    if (!session.alive) {
        sessions.delete(sessionId);
        return {
            stdout: "",
            stderr: `会话 ${sessionId} 已死亡（进程已退出）`,
            elapsed: "0ms",
            killed: false,
            killReason: "crash",
        };
    }

    session.lastActivity = Date.now();
    session.execCount++;
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

        const finalize = () => {
            if (resolved) return;
            resolved = true;

            clearTimeout(timeoutTimer);
            clearInterval(memoryChecker);

            // 从输出中去除 sentinel 标记及之后的内容
            let stdout = session.stdoutBuffer;
            const sentinelIdx = stdout.indexOf(sentinel);
            if (sentinelIdx !== -1) {
                stdout = stdout.slice(0, sentinelIdx).trim();
            }

            // 清理 Python/Node REPL 提示符
            stdout = stdout.replace(/^>>>\s*/gm, "").replace(/^\.\.\.\s*/gm, "").trim();

            // 清理 stderr 中的 REPL 提示符
            let stderr = session.stderrBuffer
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
            });
        };

        // 监听 sentinel 出现
        const sentinelChecker = setInterval(() => {
            if (session.stdoutBuffer.includes(sentinel)) {
                clearInterval(sentinelChecker);
                // 给一点时间收集剩余输出
                setTimeout(finalize, 50);
            }
            // REPL 崩溃检测：进程已死但 sentinel 未出现
            if (!session.alive && !resolved) {
                clearInterval(sentinelChecker);
                killed = true;
                killReason = "crash";
                finalize();
            }
        }, 30);

        // 超时：杀死进程防止后台资源泄漏
        const timeoutTimer = setTimeout(() => {
            if (!resolved) {
                clearInterval(sentinelChecker);
                killed = true;
                killReason = "timeout";
                // 必须杀死进程！否则用户代码继续后台运行
                killProcessTree(session.pid);
                session.alive = false;
                finalize();
            }
        }, timeout);

        // 内存检查
        const memoryChecker = setInterval(async () => {
            if (resolved || !session.alive) return;
            try {
                const stats = await pidusage(session.pid);
                session.currentMemoryMB = stats.memory / (1024 * 1024);
                if (session.currentMemoryMB > session.maxMemoryMB) {
                    clearInterval(sentinelChecker);
                    killed = true;
                    killReason = "memory";
                    // 杀进程
                    killProcessTree(session.pid);
                    session.alive = false;
                    finalize();
                }
            } catch { /* 忽略 */ }
        }, MEMORY_CHECK_INTERVAL);

        // 发送代码到 REPL
        try {
            session.process.stdin?.write(wrappedCode);
        } catch (err) {
            session.alive = false;
            clearInterval(sentinelChecker);
            resolve({
                stdout: "",
                stderr: `写入 REPL stdin 失败: ${err}`,
                elapsed: formatElapsed(Date.now() - startTime),
                killed: true,
                killReason: "crash",
            });
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
            const stats = await pidusage(session.pid);
            session.currentMemoryMB = stats.memory / (1024 * 1024);
        } catch {
            session.alive = false;
        }
    }

    return {
        id: session.id,
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
export function closeSession(sessionId: string): boolean {
    const session = sessions.get(sessionId);
    if (!session) return false;

    if (session.alive) {
        try {
            killProcessTree(session.pid);
        } catch { /* 忽略 */ }
        session.alive = false;
    }

    sessions.delete(sessionId);
    console.error(`[sandbox] 会话 ${sessionId} 已关闭`);
    return true;
}

/**
 * 列出所有活跃会话
 */
export async function listSessions(): Promise<SessionStatus[]> {
    cleanDeadSessions();
    const result: SessionStatus[] = [];
    for (const [id] of sessions) {
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
            console.error(`[sandbox] 清理僵尸会话 ${id}`);
        }
    }
}

/**
 * 获取总内存使用量
 */
function getTotalMemoryUsage(): number {
    let total = 0;
    for (const [, session] of sessions) {
        if (session.alive) {
            total += session.currentMemoryMB;
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
            if (session.alive && (now - session.lastActivity) > IDLE_TIMEOUT_MS) {
                console.error(`[sandbox] 会话 ${id} 空闲超时 (${formatElapsed(now - session.lastActivity)})，自动关闭`);
                closeSession(id);
            }
        }

        // 没有会话了就停止检查器
        if (sessions.size === 0) {
            clearInterval(idleChecker!);
            idleChecker = null;
        }
    }, 30000); // 每 30 秒检查

    idleChecker.unref(); // 不阻塞 Node.js 退出
}

/**
 * 关闭所有会话（MCP 退出时调用）
 */
export function closeAllSessions(): void {
    for (const [id] of sessions) {
        closeSession(id);
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
