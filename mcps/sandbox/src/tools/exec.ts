import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming, ensureModelVisibleToolResult } from "../lifecycle.js";
import { execute } from "../executor.js";
import { serializeResourceAdmissionError } from "../resource-admission-runtime.js";
import { PROCESS_TREE_MAX_MEMORY_MB } from "../memory-limits.js";

/**
 * sandbox_exec 工具 — 代码/命令执行
 *
 * 支持 code（直接代码字符串）和 command（系统命令）两种模式。
 * 提供硬超时、内存限制、输出截断等保护。
 */

// 参数 schema（注册工具用 shape，运行时在 handler 内做 code/command 非空互斥校验）
const ExecParamsShape = {
    code: z.string().optional().describe("代码字符串。和 command 互斥，二选一，另一个请勿传（空串也视为未提供）。"),
    command: z.string().optional().describe("系统命令。和 code 互斥，二选一，另一个请勿传（空串也视为未提供）。"),
    language: z.enum(["python", "node", "powershell", "cmd", "bash"]).optional()
        .describe("语言：python(默认)/node/powershell/cmd/bash(需 Git Bash)"),
    cwd: z.string().optional().describe("工作目录"),
    env: z.string().optional().describe("环境：conda:名称 / venv:路径"),
    timeout: z.number().min(0).optional()
        .describe("执行超时(ms)，默认30000；0 表示 Sandbox 不主动超时"),
    maxMemoryMB: z.number().int().min(16).max(PROCESS_TREE_MAX_MEMORY_MB).optional()
        .describe(`进程树提交内存硬上限(MB)，默认256、服务端最高${PROCESS_TREE_MAX_MEMORY_MB}；Windows 从进程恢复运行前开始强制执行`),
    memoryRequestMB: z.number().int().min(16).max(PROCESS_TREE_MAX_MEMORY_MB).optional()
        .describe("启动预计内存(MB)，16～maxMemoryMB；显式24MB按24MB，不提升到64MB。省略时取min(硬上限,max(64,ceil(硬上限/4)))；不等于硬上限，不应为绕过等待而低报"),
    maxOutput: z.number().min(100).optional()
        .describe("兼容参数：调用方希望的内联字符预算；最终仍受服务端响应保护线约束"),
    outputMode: z.enum(["full", "tail", "head", "silent"]).optional()
        .describe("输出模式：full(默认)/tail(最后N行)/head(前N行)/silent(只返回exitCode)"),
    deliveryMode: z.enum(["auto", "inline", "file", "manifest"]).optional()
        .describe("交付模式：auto 默认按100K估算token、2000行、1MiB响应线自动选择"),
    tailLines: z.number().min(1).optional()
        .describe("tail/head模式取多少行，默认20"),
    maxLines: z.number().min(1).optional()
        .describe("兼容参数：调用方希望的内联行数预算，不再硬限制为200"),
    ownerId: z.string().min(1).max(200).optional()
        .describe("稳定调用方标识，用于多对话公平调度"),
    admissionBudgetMs: z.number().min(0).max(10000).optional()
        .describe("启动前接纳等待预算(ms)，不是运行时限；默认8～10秒、最多10秒。超时先看admissionDecision.blockedBy，可能是水位、采样或恢复等待，不等于电脑缺内存"),
    retryAttempt: z.number().int().min(0).max(4).optional()
        .describe("调用方重试级别，用于生成随机指数退避建议"),
    gpu: z.boolean().optional()
        .describe("允许使用GPU，默认false"),
    maxVRAM_MB: z.number().optional()
        .describe("GPU VRAM限制(MB)，默认2048"),
};

/**
 * 注册 sandbox_exec 工具
 */
export function registerExec(server: McpServer): void {
    server.tool(
        "sandbox_exec",
        `执行代码片段或系统命令。支持硬超时、内存限制、输出截断。

code 模式：直接传代码字符串，无需写临时文件
command 模式：执行系统命令，自动用 shell 包装

默认按实时物理/提交水位接纳，固定预估总额不会在安全水位下单独阻断；短请求可在黄色水位前进，危险水位、过期采样和后台恢复仍会等待。
maxMemoryMB限制整棵进程树，memoryRequestMB只是启动估计；小估计不能替代硬保护。
admission_timeout表示尚未启动，先看错误正文和admissionDecision.blockedBy；执行/通信超时先核对commandStarted、mayHaveStarted及副作用，勿并发重发或盲目低报估计。
小输出完整返回，大输出保留完整artifact及预览。`,
        ExecParamsShape,
        async (params, extra) => {
            const startTime = Date.now();
            touchActivity();

            // 参数校验（含 code/command 非空互斥检查，空串视为未提供）
            const codeRaw = params.code as string | undefined;
            const commandRaw = params.command as string | undefined;
            const hasCode = typeof codeRaw === "string" && codeRaw.trim().length > 0;
            const hasCommand = typeof commandRaw === "string" && commandRaw.trim().length > 0;

            if (hasCode === hasCommand) {  // XOR: 都没提供 或 都提供了 → 报错
                return {
                    content: [{ type: "text" as const, text: `❌ 参数错误: 必须且只能提供 code 或 command 之一（空串视为未提供）` }],
                };
            }

            // 归一：空串归并为 undefined 往下传，统一 handler/executor 两层口径
            const code = codeRaw?.trim() ? codeRaw : undefined;
            const command = commandRaw?.trim() ? commandRaw : undefined;

            const language = (params.language as string) || undefined;
            const cwd = params.cwd as string | undefined;
            const env = params.env as string | undefined;
            const timeout = params.timeout as number | undefined;
            const maxMemoryMB = params.maxMemoryMB as number | undefined;
            const memoryRequestMB = params.memoryRequestMB as number | undefined;
            const maxOutput = params.maxOutput as number | undefined;
            const outputMode = params.outputMode as "full" | "tail" | "head" | "silent" | undefined;
            const deliveryMode = params.deliveryMode as "auto" | "inline" | "file" | "manifest" | undefined;
            const tailLines = params.tailLines as number | undefined;
            const maxLines = params.maxLines as number | undefined;
            const gpu = params.gpu as boolean | undefined;
            const maxVRAM_MB = params.maxVRAM_MB as number | undefined;
            const ownerId = params.ownerId as string | undefined;
            const admissionBudgetMs = params.admissionBudgetMs as number | undefined;
            const retryAttempt = params.retryAttempt as number | undefined;
            const progressToken = extra?._meta?.progressToken;
            const onQueueProgress = progressToken === undefined || !extra?.sendNotification
                ? undefined
                : (progress: {
                    queueWaitMs: number;
                    queuePosition: number;
                    queued: number;
                    pressureLevel: string;
                }) => {
                    void extra.sendNotification?.({
                        method: "notifications/progress",
                        params: {
                            progressToken,
                            progress: progress.queueWaitMs,
                            total: 10000,
                            message: `命令尚未启动：排队 ${progress.queuePosition}/${progress.queued}，已等待 ${progress.queueWaitMs}ms，资源压力 ${progress.pressureLevel}`,
                        },
                    }).catch(() => undefined);
                };

            try {
                const result = await execute({
                    code,
                    command,
                    language,
                    cwd,
                    env,
                    timeout,
                    maxMemoryMB,
                    memoryRequestMB,
                    maxOutput,
                    outputMode,
                    deliveryMode,
                    tailLines,
                    maxLines,
                    gpu,
                    maxVRAM_MB,
                    ownerId: ownerId ?? extra?.sessionId,
                    signal: extra?.signal,
                    admissionBudgetMs,
                    retryAttempt,
                    onQueueProgress,
                });

                // 构建返回信息
                const parts: string[] = [];

                // 状态行
                const statusIcon = result.exitCode === 0 ? "✅" : result.killed ? "💀" : "❌";
                const errorType = result.errorType || (result.killReason === "timeout" ? "execution_timeout" : undefined);
                const statusDesc = errorType
                    ? result.commandStarted
                        ? `${errorType}（命令已启动）`
                        : `${errorType}（命令未启动）`
                    : result.killed
                    ? `被杀 (${result.killReason})`
                    : result.exitCode === 0 ? "成功" : `失败 (exit ${result.exitCode})`;
                const peakMemory = result.peakMemoryMB === null ? "未取得可信样本" : `${result.peakMemoryMB}MB`;
                parts.push(`${statusIcon} ${statusDesc} | 执行 ${result.elapsed} | 排队 ${result.queueWaitMs}ms | 内存峰值 ${peakMemory}`);

                // stdout
                if (result.stdout) {
                    parts.push("");
                    parts.push("📤 stdout:");
                    parts.push(result.stdout);
                }

                // stderr
                if (result.stderr) {
                    parts.push("");
                    parts.push("⚠️ stderr:");
                    parts.push(result.stderr);
                }

                if (result.artifact && result.outputStats) {
                    parts.push("");
                    parts.push(`📦 输出交付: ${result.deliveryMode} | complete=${result.outputComplete} | status=${result.outputStatus}`);
                    parts.push(`  artifactId: ${result.artifact.artifactId}`);
                    parts.push(`  manifest: ${result.artifact.manifestPath}`);
                    parts.push(`  stdout: ${result.outputStats.stdout.rawBytes} bytes / ${result.outputStats.stdout.lines} lines / sha256=${result.outputStats.stdout.sha256}`);
                    parts.push(`  stderr: ${result.outputStats.stderr.rawBytes} bytes / ${result.outputStats.stderr.lines} lines / sha256=${result.outputStats.stderr.sha256}`);
                    parts.push(`  estimatedTokens: ${result.outputStats.combined.estimatedTokens} | expiresAt: ${result.artifact.expiresAt}`);
                    if (result.outputReasons.length > 0) parts.push(`  reasons: ${result.outputReasons.join(", ")}`);
                    if (result.outputReadHint) parts.push(`  readHint: ${result.outputReadHint}`);
                }

                const output = {
                    content: [{ type: "text" as const, text: parts.join("\n") }],
                    ...((result.exitCode !== 0 || result.killed || result.artifact) ? { structuredContent: {
                        errorType,
                        commandStarted: result.commandStarted,
                        mayHaveStarted: result.mayHaveStarted,
                        queueWaitMs: result.queueWaitMs,
                        runMs: result.runMs,
                        totalMs: Date.now() - startTime,
                        exitCode: result.exitCode,
                        killed: result.killed,
                        killReason: result.killReason,
                        artifact: result.artifact,
                    } } : {}),
                };

                return appendTiming(output, startTime);
            } catch (err) {
                const admissionError = serializeResourceAdmissionError(err);
                if (admissionError) {
                    return ensureModelVisibleToolResult({
                        isError: true,
                        structuredContent: { error: admissionError },
                        content: [{
                            type: "text" as const,
                            text: `❌ ${admissionError.type}: 命令尚未启动；资源调度等待 ${admissionError.queueWaitMs}ms 后失败，建议 ${admissionError.retryAfterMs}ms 后随机重试`,
                        }],
                    });
                }
                return {
                    content: [{ type: "text" as const, text: `❌ 执行异常: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        }
    );
}
