import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { execute, ExecResult, normalizeExecutionInput } from "../executor.js";
import { serializeResourceAdmissionError } from "../resource-admission-runtime.js";

/**
 * sandbox_batch 工具 — 并行执行多任务
 *
 * 每个任务独立计时、独立超时、独立内存限制。
 * 返回每个任务的完整独立状态。
 */

const TaskItemSchema = z.object({
    code: z.string().optional().describe("代码字符串。和 command 互斥，只填其一；空串或纯空白视为未提供。"),
    command: z.string().optional().describe("系统命令。和 code 互斥，只填其一；空串或纯空白视为未提供。"),
    language: z.enum(["python", "node", "powershell", "cmd", "bash"]).optional(),
    cwd: z.string().optional(),
    env: z.string().optional(),
    timeout: z.number().min(0).optional(),
    maxMemoryMB: z.number().min(16).max(1536).optional(),
    maxOutput: z.number().min(100).optional(),
    outputMode: z.enum(["full", "tail", "head", "silent"]).optional(),
    deliveryMode: z.enum(["auto", "inline", "file", "manifest"]).optional(),
    tailLines: z.number().min(1).optional(),
    maxLines: z.number().min(1).optional(),
});

const BatchParamsSchema = z.object({
    tasks: z.array(TaskItemSchema).min(1).max(20)
        .describe("任务列表（最多20个），每个含 code/command 等"),
    parallel: z.boolean().optional()
        .describe("true=并行(默认) false=顺序"),
    maxParallel: z.number().min(1).max(20).optional()
        .describe("最大并行数，默认3"),
    maxTotalMemoryMB: z.number().min(64).max(1536).optional()
        .describe("全部任务总内存上限(MB)，默认768"),
    ownerId: z.string().min(1).max(200).optional()
        .describe("稳定调用方标识，用于全局公平调度"),
    admissionBudgetMs: z.number().min(0).optional()
        .describe("资源不足时单个任务最多等待多久"),
    retryAttempt: z.number().int().min(0).max(4).optional(),
});

type BatchTask = z.infer<typeof TaskItemSchema>;

interface EffectiveBatchTask extends BatchTask {
    reservationMB: number;
    ownerId?: string;
    admissionBudgetMs?: number;
    retryAttempt?: number;
    signal?: AbortSignal;
}

interface BatchTaskResult {
    index: number;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    elapsed: string;
    killed: boolean;
    killReason: string | null;
    peakMemoryMB: number;
    truncated: boolean;
    tempFile: string | null;
    queueWaitMs: number;
    errorType?: string;
    retryAfterMs?: number;
    deliveryMode?: ExecResult["deliveryMode"];
    artifact?: ExecResult["artifact"];
    outputStats?: ExecResult["outputStats"];
}

export function registerBatch(server: McpServer): void {
    server.tool(
        "sandbox_batch",
        `一次调用并行执行多个代码片段或命令。适用于同时安装依赖、批量测试、多文件编译等场景。

每个任务独立计时、独立超时、独立内存限制，结果互不影响。
最多 20 个任务，默认并行（maxParallel=3）；全局内存调度仍会限制真正同时启动的任务。`,
        BatchParamsSchema.shape,
        async (params, extra?: { signal?: AbortSignal }) => {
            const startTime = Date.now();
            touchActivity();

            const parsed = BatchParamsSchema.safeParse(params);
            if (!parsed.success) {
                return {
                    content: [{ type: "text" as const, text: `❌ 参数错误: ${parsed.error.message}` }],
                };
            }

            const {
                tasks,
                parallel = true,
                maxParallel = 3,
            } = parsed.data;

            try {
                let results: BatchTaskResult[];

                // 计算每个任务的有效内存限制（受 maxTotalMemoryMB 约束）
                const maxTotalMemoryMB = parsed.data.maxTotalMemoryMB || 768;
                const perTaskMemDefault = Math.floor(maxTotalMemoryMB / tasks.length);
                const effectiveTasks: EffectiveBatchTask[] = tasks.map(t => ({
                    ...t,
                    maxMemoryMB: t.maxMemoryMB ? Math.min(t.maxMemoryMB, maxTotalMemoryMB) : Math.min(Math.max(perTaskMemDefault, 64), 256),
                    reservationMB: t.maxMemoryMB ? Math.min(t.maxMemoryMB, maxTotalMemoryMB) : 64,
                    ownerId: parsed.data.ownerId,
                    admissionBudgetMs: parsed.data.admissionBudgetMs,
                    retryAttempt: parsed.data.retryAttempt,
                    signal: extra?.signal,
                }));

                if (parallel) {
                    // 并行执行（受 maxParallel 限制）
                    results = await executeParallel(effectiveTasks, maxParallel, maxTotalMemoryMB);
                } else {
                    // 顺序执行
                    results = await executeSequential(effectiveTasks);
                }

                const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
                const allSuccess = results.every(r => r.exitCode === 0 && !r.killed);

                // 格式化输出
                const parts: string[] = [];
                const overallIcon = allSuccess ? "✅" : "❌";
                parts.push(`${overallIcon} 批量执行完成: ${results.length} 个任务 | 总耗时 ${totalElapsed} | ${allSuccess ? "全部成功" : "有失败"}`);
                parts.push("");

                for (const r of results) {
                    const icon = r.exitCode === 0 && !r.killed ? "✅" : r.killed ? "💀" : "❌";
                    const status = r.errorType === "execution_timeout"
                        ? "execution_timeout（命令已启动后运行超时）"
                        : r.killed ? `被杀(${r.killReason})` : r.exitCode === 0 ? "成功" : `失败(exit ${r.exitCode})`;
                    parts.push(`--- 任务 #${r.index} ${icon} ${status} | 执行 ${r.elapsed} | 排队 ${r.queueWaitMs}ms | ${r.peakMemoryMB}MB ---`);
                    if (r.errorType) parts.push(`调度错误: ${r.errorType}${r.retryAfterMs ? ` | 建议 ${r.retryAfterMs}ms 后重试` : ""}`);
                    if (r.stdout) parts.push(r.stdout);
                    if (r.stderr) parts.push(`⚠️ ${r.stderr}`);
                    if (r.truncated && r.tempFile) parts.push(`📁 完整输出: ${r.tempFile}`);
                    if (r.artifact && r.outputStats) {
                        parts.push(`📦 ${r.deliveryMode} artifact=${r.artifact.artifactId} expires=${r.artifact.expiresAt}`);
                        parts.push(`   stdout sha256=${r.outputStats.stdout.sha256} | stderr sha256=${r.outputStats.stderr.sha256}`);
                    }
                    parts.push("");
                }

                const output = {
                    content: [{ type: "text" as const, text: parts.join("\n").trim() }],
                    structuredContent: {
                        tasks: results.map((result) => ({
                            index: result.index,
                            errorType: result.errorType,
                            commandStarted: !result.errorType?.startsWith("admission_")
                                && !result.errorType?.startsWith("reservation_exceeds_"),
                            queueWaitMs: result.queueWaitMs,
                            exitCode: result.exitCode,
                            killed: result.killed,
                            killReason: result.killReason,
                            retryAfterMs: result.retryAfterMs,
                            artifact: result.artifact,
                        })),
                    },
                };
                return appendTiming(output, startTime);
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: `❌ 批量执行异常: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        }
    );
}

/**
 * 并行执行（受 maxParallel 限制）
 */
async function executeParallel(
    tasks: EffectiveBatchTask[],
    maxParallel: number,
    maxTotalMemoryMB: number,
): Promise<BatchTaskResult[]> {
    const results: BatchTaskResult[] = new Array(tasks.length);
    let running = 0;
    let runningReservedMB = 0;
    const pending = tasks.map((_, index) => index);

    return new Promise((resolve) => {
        function tryStartNext() {
            while (running < maxParallel && pending.length > 0) {
                const pendingPosition = pending.findIndex((index) =>
                    runningReservedMB + tasks[index].reservationMB <= maxTotalMemoryMB
                );
                if (pendingPosition < 0) break;
                const [idx] = pending.splice(pendingPosition, 1);
                running++;
                runningReservedMB += tasks[idx].reservationMB;

                executeTask(tasks[idx], idx).then((result) => {
                    results[idx] = result;
                    running--;
                    runningReservedMB -= tasks[idx].reservationMB;

                    if (pending.length === 0 && running === 0) {
                        resolve(results);
                    } else {
                        tryStartNext();
                    }
                }).catch((err) => {
                    // 任务级异常：记录为失败结果而非整体崩溃
                    results[idx] = {
                        index: idx,
                        exitCode: 1,
                        stdout: "",
                        stderr: `任务异常: ${err instanceof Error ? err.message : String(err)}`,
                        elapsed: "0ms",
                        killed: false,
                        killReason: null,
                        peakMemoryMB: 0,
                        truncated: false,
                        tempFile: null,
                        queueWaitMs: 0,
                    };
                    running--;
                    runningReservedMB -= tasks[idx].reservationMB;
                    if (pending.length === 0 && running === 0) {
                        resolve(results);
                    } else {
                        tryStartNext();
                    }
                });
            }
        }

        tryStartNext();
    });
}

/**
 * 顺序执行
 */
async function executeSequential(
    tasks: EffectiveBatchTask[]
): Promise<BatchTaskResult[]> {
    const results: BatchTaskResult[] = [];
    for (let i = 0; i < tasks.length; i++) {
        results.push(await executeTask(tasks[i], i));
    }
    return results;
}

/**
 * 执行单个任务
 */
async function executeTask(
    task: EffectiveBatchTask,
    index: number
): Promise<BatchTaskResult> {
    const normalizedInput = normalizeExecutionInput(task.code, task.command);
    if (normalizedInput.error) {
        return {
            index,
            exitCode: 1,
            stdout: "",
            stderr: `任务 #${index} 参数错误: ${normalizedInput.error}`,
            elapsed: "0ms",
            killed: false,
            killReason: null,
            peakMemoryMB: 0,
            truncated: false,
            tempFile: null,
            queueWaitMs: 0,
        };
    }

    let result: ExecResult;
    try {
        result = await execute({
            code: normalizedInput.code,
            command: normalizedInput.command,
            language: task.language,
            cwd: task.cwd,
            env: task.env,
            timeout: task.timeout,
            maxMemoryMB: task.maxMemoryMB,
            maxOutput: task.maxOutput,
            outputMode: task.outputMode,
            deliveryMode: task.deliveryMode,
            tailLines: task.tailLines,
            maxLines: task.maxLines,
            reservationMB: task.reservationMB,
            ownerId: task.ownerId,
            admissionBudgetMs: task.admissionBudgetMs,
            retryAttempt: task.retryAttempt,
            signal: task.signal,
        });
    } catch (error) {
        const admissionError = serializeResourceAdmissionError(error);
        if (!admissionError) throw error;
        return {
            index,
            exitCode: 1,
            stdout: "",
            stderr: `${admissionError.type}: 命令尚未启动`,
            elapsed: "0ms",
            killed: false,
            killReason: null,
            peakMemoryMB: 0,
            truncated: false,
            tempFile: null,
            queueWaitMs: admissionError.queueWaitMs,
            errorType: admissionError.type,
            retryAfterMs: admissionError.retryAfterMs,
        };
    }

    return {
        index,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        elapsed: result.elapsed,
        killed: result.killed,
        killReason: result.killReason,
        peakMemoryMB: result.peakMemoryMB,
        truncated: result.truncated,
        tempFile: result.tempFile,
        queueWaitMs: result.queueWaitMs,
        errorType: result.killReason === "timeout" ? "execution_timeout" : undefined,
        deliveryMode: result.deliveryMode,
        artifact: result.artifact,
        outputStats: result.outputStats,
    };
}
