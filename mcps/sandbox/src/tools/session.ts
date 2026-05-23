import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity, appendTiming } from "../lifecycle.js";
import {
    createSession,
    execInSession,
    getSessionStatus,
    canAccessSession,
    closeSessionForOwner,
    listSessions,
} from "../session-manager.js";
import { normalizeOwnerId, ownerMismatchText } from "../owner.js";

/**
 * sandbox_session 工具 — 持久 REPL 会话
 */

const SessionParamsSchema = z.object({
    action: z.enum(["start", "exec", "status", "close", "list"]).optional()
        .describe("操作：start/exec(默认)/status/close/list"),
    sessionId: z.string().optional()
        .describe("会话ID（exec/status/close时使用）"),
    language: z.enum(["python", "node"]).optional()
        .describe("语言：python(默认)/node（start时使用）"),
    code: z.string().optional()
        .describe("要执行的代码（exec时使用）"),
    cwd: z.string().optional()
        .describe("工作目录（start时使用）"),
    env: z.string().optional()
        .describe("环境（start时使用）"),
    timeout: z.number().min(1000).max(60000).optional()
        .describe("单次执行超时(ms)，默认15000"),
    maxMemoryMB: z.number().min(16).max(512).optional()
        .describe("会话内存上限(MB)，默认256"),
    maxLines: z.number().min(1).max(200).optional()
        .describe("输出行数上限，超过时保留头尾、折叠中间"),
    ownerId: z.string().optional()
        .describe("会话归属 ID；未传按 global 兼容旧调用"),
});

export function registerSession(server: McpServer): void {
    server.tool(
        "sandbox_session",
        `管理持久 REPL 会话。变量状态跨调用保持，适合交互式开发和调试。

action:
- start: 创建新会话（返回 sessionId）
- exec: 在会话中执行代码（默认，需要 sessionId + code）
- status: 查看会话状态
- close: 关闭会话
- list: 列出所有活跃会话

限制：同一 MCP 进程内最多 3 个并发会话，空闲 5 分钟自动关闭。`,
        SessionParamsSchema.shape,
        async (params) => {
            const startTime = Date.now();
            touchActivity();

            const parsed = SessionParamsSchema.safeParse(params);
            if (!parsed.success) {
                return {
                    content: [{ type: "text" as const, text: `❌ 参数错误: ${parsed.error.message}` }],
                };
            }

            const { action = "exec", sessionId, language, code, cwd, env, timeout, maxMemoryMB, maxLines, ownerId } = parsed.data;
            const requestOwner = normalizeOwnerId(ownerId);

            try {
                switch (action) {
                    case "start": {
                        const result = createSession(language || "python", cwd, maxMemoryMB, env, requestOwner);
                        if ("error" in result) {
                            return {
                                content: [{ type: "text" as const, text: `❌ ${result.error}` }],
                            };
                        }
                        const output = {
                            content: [{
                                type: "text" as const,
                                text: `✅ 会话已创建\nID: ${result.session.id}\nownerId: ${result.session.ownerId}\n语言: ${result.session.language}\n工作目录: ${result.session.cwd}\n内存上限: ${result.session.maxMemoryMB}MB`,
                            }],
                        };
                        return appendTiming(output, startTime);
                    }

                    case "exec": {
                        if (!sessionId) {
                            return {
                                content: [{ type: "text" as const, text: "❌ exec 操作需要 sessionId" }],
                            };
                        }
                        if (!code) {
                            return {
                                content: [{ type: "text" as const, text: "❌ exec 操作需要 code" }],
                            };
                        }

                        const result = await execInSession(sessionId, code, timeout, requestOwner);

                        // maxLines 行数截断
                        let stdout = result.stdout;
                        if (maxLines && maxLines > 0 && stdout) {
                            const lines = stdout.split("\n");
                            if (lines.length > maxLines) {
                                const headCount = Math.min(5, Math.floor(maxLines / 3));
                                const tailCount = Math.min(15, maxLines - headCount);
                                const head = lines.slice(0, headCount);
                                const tail = lines.slice(-tailCount);
                                const omitted = lines.length - headCount - tailCount;
                                stdout = head.join("\n") + `\n... (省略 ${omitted} 行，共 ${lines.length} 行)\n` + tail.join("\n");
                            }
                        }

                        const parts: string[] = [];

                        const statusIcon = result.killed ? "💀" : "✅";
                        parts.push(`${statusIcon} ${result.killed ? `被杀 (${result.killReason})` : "执行完成"} | ${result.elapsed}`);

                        if (stdout) {
                            parts.push("");
                            parts.push(stdout);
                        }

                        if (result.stderr) {
                            parts.push("");
                            parts.push(`⚠️ ${result.stderr}`);
                        }

                        const output = {
                            content: [{ type: "text" as const, text: parts.join("\n") }],
                        };
                        return appendTiming(output, startTime);
                    }

                    case "status": {
                        if (!sessionId) {
                            return {
                                content: [{ type: "text" as const, text: "❌ status 操作需要 sessionId" }],
                            };
                        }

                        const status = await getSessionStatus(sessionId);
                        if (!status) {
                            return {
                                content: [{ type: "text" as const, text: `❌ 会话 ${sessionId} 不存在` }],
                            };
                        }
                        if (!canAccessSession(sessionId, requestOwner)) {
                            return {
                                content: [{ type: "text" as const, text: ownerMismatchText("会话", sessionId) }],
                            };
                        }

                        const output = {
                            content: [{
                                type: "text" as const,
                                text: `📊 会话 ${status.id}\nownerId: ${status.ownerId}\n状态: ${status.alive ? "🟢 活跃" : "🔴 已死亡"}\n语言: ${status.language}\n内存: ${status.memoryMB}MB\n运行时间: ${status.uptime}\n执行次数: ${status.execCount}`,
                            }],
                        };
                        return appendTiming(output, startTime);
                    }

                    case "close": {
                        if (!sessionId) {
                            return {
                                content: [{ type: "text" as const, text: "❌ close 操作需要 sessionId" }],
                            };
                        }

                        const closeResult = closeSessionForOwner(sessionId, requestOwner);
                        if (closeResult.error) {
                            return {
                                content: [{ type: "text" as const, text: closeResult.error }],
                            };
                        }
                        const output = {
                            content: [{
                                type: "text" as const,
                                text: closeResult.closed ? `✅ 会话 ${sessionId} 已关闭` : `❌ 会话 ${sessionId} 不存在`,
                            }],
                        };
                        return appendTiming(output, startTime);
                    }

                    case "list": {
                        const sessions = await listSessions(requestOwner);
                        if (sessions.length === 0) {
                            const output = {
                                content: [{ type: "text" as const, text: "📋 当前没有活跃会话" }],
                            };
                            return appendTiming(output, startTime);
                        }

                        const lines = ["📋 活跃会话:"];
                        for (const s of sessions) {
                            lines.push(`  ${s.id} | owner=${s.ownerId} | ${s.language} | ${s.memoryMB}MB | 运行 ${s.uptime} | 执行 ${s.execCount} 次`);
                        }

                        const output = {
                            content: [{ type: "text" as const, text: lines.join("\n") }],
                        };
                        return appendTiming(output, startTime);
                    }

                    default:
                        return {
                            content: [{ type: "text" as const, text: `❌ 未知操作: ${action}` }],
                        };
                }
            } catch (err) {
                return {
                    content: [{ type: "text" as const, text: `❌ 异常: ${err instanceof Error ? err.message : String(err)}` }],
                };
            }
        }
    );
}
