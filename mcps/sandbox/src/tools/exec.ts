import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { execute } from "../executor.js";

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
    timeout: z.number().min(1000).max(300000).optional()
        .describe("硬超时(ms)，默认30000，最大300000(5分钟)"),
    maxMemoryMB: z.number().min(16).max(1024).optional()
        .describe("最大内存(MB)，默认256，最大1024"),
    maxOutput: z.number().min(100).max(50000).optional()
        .describe("输出截断上限(字符)，默认8000"),
    outputMode: z.enum(["full", "tail", "head", "silent"]).optional()
        .describe("输出模式：full(默认)/tail(最后N行)/head(前N行)/silent(只返回exitCode)"),
    tailLines: z.number().min(1).max(200).optional()
        .describe("tail/head模式取多少行，默认20"),
    maxLines: z.number().min(1).max(200).optional()
        .describe("输出行数上限，超过时保留头尾、折叠中间。和 maxOutput 并存取更严格的"),
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

比 run_command 更安全高效：
- 硬超时自动杀进程（不会卡死）
- 内存超限自动杀（不会吃光内存）
- 输出智能截断（不爆上下文）
- 失败原因清晰（killed + killReason）`,
        ExecParamsShape,
        async (params: Record<string, unknown>) => {
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
            const maxOutput = params.maxOutput as number | undefined;
            const outputMode = params.outputMode as "full" | "tail" | "head" | "silent" | undefined;
            const tailLines = params.tailLines as number | undefined;
            const maxLines = params.maxLines as number | undefined;
            const gpu = params.gpu as boolean | undefined;
            const maxVRAM_MB = params.maxVRAM_MB as number | undefined;

            try {
                const result = await execute({
                    code,
                    command,
                    language,
                    cwd,
                    env,
                    timeout,
                    maxMemoryMB,
                    maxOutput,
                    outputMode,
                    tailLines,
                    maxLines,
                    gpu,
                    maxVRAM_MB,
                });

                // 构建返回信息
                const parts: string[] = [];

                // 状态行
                const statusIcon = result.exitCode === 0 ? "✅" : result.killed ? "💀" : "❌";
                const statusDesc = result.killed
                    ? `被杀 (${result.killReason})`
                    : result.exitCode === 0 ? "成功" : `失败 (exit ${result.exitCode})`;
                parts.push(`${statusIcon} ${statusDesc} | ${result.elapsed} | 内存峰值 ${result.peakMemoryMB}MB`);

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

                // 截断提示
                if (result.truncated) {
                    parts.push("");
                    parts.push(`📎 输出被截断: ${result.returnedBytes} / ${result.originalBytes} bytes`);
                    if (result.tempFile) {
                        parts.push(`📁 完整输出: ${result.tempFile}`);
                    }
                }

                const output = {
                    content: [{ type: "text" as const, text: parts.join("\n") }],
                };

                return appendTiming(output, startTime);
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: `❌ 执行异常: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        }
    );
}
