import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendTiming } from "../constants.js";
import { browserManager } from "../browser.js";
import { formatPoolPressureHint, formatSessionList, normalizeOwnerId, sessionManager } from "../session.js";

const ListSessionsInputSchema = z.object({
    ownerId: z
        .string()
        .optional()
        .describe("会话所有者标识。未传时只列出 global owner 的会话"),
    includeAllOwners: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否列出所有 ownerId 的会话。用于排查最大并发页面占用，默认 false"),
});

const CloseSessionsInputSchema = z.object({
    sessionId: z
        .string()
        .optional()
        .describe("要关闭的单个 sessionId。未传时可配合 closeAllForOwner=true 关闭当前 owner 的所有会话"),
    ownerId: z
        .string()
        .optional()
        .describe("会话所有者标识。关闭 session 时会按 ownerId 校验，未传时使用 global"),
    closeAllForOwner: z
        .boolean()
        .optional()
        .default(false)
        .describe("是否关闭指定 ownerId 下的所有会话。不会跨 owner 关闭"),
});

type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>;
type CloseSessionsInput = z.infer<typeof CloseSessionsInputSchema>;

export function registerSessionTools(server: McpServer): void {
    server.registerTool(
        "web_list_sessions",
        {
            title: "列出网页会话",
            description: `列出 web_interact / web_pipeline / desktop_register_window 保留的页面会话。

用于排查已有 sessionId、最大并发页面占用、弹窗 session 和 Electron renderer 注册后的 web session。
默认只列出当前 ownerId（未传为 global）；需要诊断共享 broker 下的占用时可传 includeAllOwners=true。`,
            inputSchema: {
                ownerId: ListSessionsInputSchema.shape.ownerId,
                includeAllOwners: ListSessionsInputSchema.shape.includeAllOwners,
            },
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async (params: ListSessionsInput) => {
            const startTime = Date.now();
            const sessions = sessionManager.list(params.ownerId, { includeAllOwners: params.includeAllOwners });
            const scope = params.includeAllOwners
                ? "全部 ownerId"
                : `ownerId="${normalizeOwnerId(params.ownerId)}"`;
            const pool = browserManager.getPoolStats();
            const pressureHint = formatPoolPressureHint(params.ownerId, {
                includeAllOwners: params.includeAllOwners,
                includeSessionList: false,
            });
            return appendTiming({
                content: [{
                    type: "text" as const,
                    text: `活跃会话 (${sessions.length}) - ${scope}\n页面池: ${pool.activePages}/${pool.maxConcurrentPages}\n\n${formatSessionList(sessions)}${pressureHint ? `\n${pressureHint}` : ""}`,
                }],
            }, startTime);
        },
    );

    server.registerTool(
        "web_close_sessions",
        {
            title: "关闭网页会话",
            description: `关闭 web_interact / web_pipeline 保留的页面会话。

可关闭单个 sessionId，也可传 closeAllForOwner=true 清理指定 ownerId 下的所有会话。不会跨 ownerId 强制关闭。`,
            inputSchema: {
                sessionId: CloseSessionsInputSchema.shape.sessionId,
                ownerId: CloseSessionsInputSchema.shape.ownerId,
                closeAllForOwner: CloseSessionsInputSchema.shape.closeAllForOwner,
            },
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        async (params: CloseSessionsInput) => {
            const startTime = Date.now();
            if (params.sessionId) {
                const closed = await sessionManager.close(params.sessionId, params.ownerId);
                if (!closed) {
                    return appendTiming({
                        isError: true,
                        content: [{
                            type: "text" as const,
                            text: `会话 "${params.sessionId}" 不存在、已过期或 ownerId 不匹配`,
                        }],
                    }, startTime);
                }
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `已关闭会话: ${params.sessionId}`,
                    }],
                }, startTime);
            }

            if (params.closeAllForOwner) {
                const ownerId = normalizeOwnerId(params.ownerId);
                const count = await sessionManager.closeAllForOwner(ownerId);
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `已关闭 ownerId="${ownerId}" 下的 ${count} 个会话`,
                    }],
                }, startTime);
            }

            return appendTiming({
                isError: true,
                content: [{
                    type: "text" as const,
                    text: "请提供 sessionId，或传 closeAllForOwner=true 清理当前 ownerId 的全部会话",
                }],
            }, startTime);
        },
    );
}
