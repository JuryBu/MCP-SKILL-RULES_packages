import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { execute, ExecResult } from "../executor.js";

/**
 * sandbox_batch 工具 — 并行执行多任务
 * 
 * 每个任务独立计时、独立超时、独立内存限制。
 * 返回每个任务的完整独立状态。
 */

const TaskItemSchema = z.object({
    code: z.string().optional(),
    command: z.string().optional(),
    language: z.enum(["python", "node", "powershell", "cmd", "bash"]).optional(),
    cwd: z.string().optional(),
    env: z.string().optional(),
    timeout: z.number().min(1000).max(300000).optional(),
    maxMemoryMB: z.number().min(16).max(1024).optional(),
    maxOutput: z.number().min(100).max(50000).optional(),
    outputMode: z.enum(["full", "tail", "head", "silent"]).optional(),
    tailLines: z.number().min(1).max(200).optional(),
    maxLines: z.number().min(1).max(200).optional(),
});

const BatchParamsSchema = z.object({
    tasks: z.array(TaskItemSchema).min(1).max(5)
        .describe("任务列表（最多5个），每个含 code/command 等"),
    parallel: z.boolean().optional()
        .describe("true=并行(默认) false=顺序"),
    maxParallel: z.number().min(1).max(5).optional()
        .describe("最大并行数，默认3"),
    maxTotalMemoryMB: z.number().min(64).max(1536).optional()
        .describe("全部任务总内存上限(MB)，默认768"),
});

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
}

export function registerBatch(server: McpServer): void {
    server.tool(
        "sandbox_batch",
        `一次调用并行执行多个代码片段或命令。适用于同时安装依赖、批量测试、多文件编译等场景。

每个任务独立计时、独立超时、独立内存限制，结果互不影响。
最多 5 个任务，默认并行（maxParallel=3）。`,
        BatchParamsSchema.shape,
        async (params) => {
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
                const effectiveTasks = tasks.map(t => ({
                    ...t,
                    // 单个任务内存不超过总限制的均分值（如果未指定）
                    maxMemoryMB: t.maxMemoryMB ? Math.min(t.maxMemoryMB, maxTotalMemoryMB) : Math.min(perTaskMemDefault, 256),
                }));

                if (parallel) {
                    // 并行执行（受 maxParallel 限制）
                    results = await executeParallel(effectiveTasks, maxParallel);
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
                    const status = r.killed ? `被杀(${r.killReason})` : r.exitCode === 0 ? "成功" : `失败(exit ${r.exitCode})`;
                    parts.push(`--- 任务 #${r.index} ${icon} ${status} | ${r.elapsed} | ${r.peakMemoryMB}MB ---`);
                    if (r.stdout) parts.push(r.stdout);
                    if (r.stderr) parts.push(`⚠️ ${r.stderr}`);
                    if (r.truncated && r.tempFile) parts.push(`📁 完整输出: ${r.tempFile}`);
                    parts.push("");
                }

                const output = {
                    content: [{ type: "text" as const, text: parts.join("\n").trim() }],
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
    tasks: z.infer<typeof TaskItemSchema>[],
    maxParallel: number
): Promise<BatchTaskResult[]> {
    const results: BatchTaskResult[] = new Array(tasks.length);
    let running = 0;
    let nextIndex = 0;

    return new Promise((resolve, reject) => {
        function tryStartNext() {
            while (running < maxParallel && nextIndex < tasks.length) {
                const idx = nextIndex++;
                running++;

                executeTask(tasks[idx], idx).then((result) => {
                    results[idx] = result;
                    running--;

                    if (nextIndex >= tasks.length && running === 0) {
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
                    };
                    running--;
                    if (nextIndex >= tasks.length && running === 0) {
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
    tasks: z.infer<typeof TaskItemSchema>[]
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
    task: z.infer<typeof TaskItemSchema>,
    index: number
): Promise<BatchTaskResult> {
    const result: ExecResult = await execute({
        code: task.code,
        command: task.command,
        language: task.language,
        cwd: task.cwd,
        env: task.env,
        timeout: task.timeout,
        maxMemoryMB: task.maxMemoryMB,
        maxOutput: task.maxOutput,
        outputMode: task.outputMode,
        tailLines: task.tailLines,
        maxLines: task.maxLines,
    });

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
    };
}
