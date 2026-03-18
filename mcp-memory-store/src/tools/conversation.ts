import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { saveTempFile } from "../temp-store.js";
import { fetchTrajectory, getCurrentCascadeId } from "../ls-client.js";
import {
    parseRounds,
    formatRound,
    formatOverview,
    saveConversationToTemp,
    searchInRounds,
    type Depth,
    type ExtraType,
    type ConversationRound,
} from "../trajectory.js";

/**
 * conversation_read_original — 读取对话原文
 *
 * 三种模式：
 *   fetch  — 拉取对话数据到缓存并返回概览
 *   search — 在对话中关键词搜索
 *   read   — 读取指定轮次范围的对话内容
 */
export function registerConversation(server: McpServer): void {
    server.tool(
        "conversation_read_original",
        `读取对话的原始完整内容（绕过上下文压缩机制）。
三种操作模式:
  fetch — 拉取对话数据到缓存，返回概览统计
  search — 在对话中关键词搜索，返回匹配的上下文
  read — 读取指定轮次范围的对话内容
不填 conversationId 默认读取当前对话。`,
        {
            action: z.enum(["fetch", "search", "read"]).default("search")
                .describe("操作模式：fetch=拉取缓存 / search=关键词搜索 / read=范围阅读"),
            conversationId: z.string().optional()
                .describe("对话 UUID（不填默认当前对话）"),
            query: z.string().optional()
                .describe("search 模式：搜索关键词"),
            depth: z.enum(["brief", "normal", "full"]).default("normal")
                .describe("返回详细度：brief=截断100字 / normal=完整文本 / full=含思考+工具结果"),
            contextRounds: z.number().default(2).optional()
                .describe("search 模式：匹配位置前后显示多少轮对话"),
            limit: z.number().default(8).optional()
                .describe("search 模式：最多返回多少个匹配"),
            startRound: z.number().optional()
                .describe("read 模式：起始轮次（1-indexed）"),
            endRound: z.number().optional()
                .describe("read 模式：结束轮次"),
            extraTypes: z.array(z.enum(["thinking", "tool_results", "code_actions", "code_diffs", "file_views"])).optional()
                .describe("额外拉取的内容类型"),
        },
        async (params) => {
            touchActivity();
            const startTime = Date.now();

            try {
                const {
                    action,
                    conversationId,
                    query,
                    depth = "normal",
                    contextRounds = 2,
                    limit = 8,
                    startRound,
                    endRound,
                    extraTypes = [],
                } = params;

                // 确定对话 ID
                const cascadeId = conversationId || await getCurrentCascadeId();
                if (!cascadeId) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "❌ 未指定 conversationId 且无法推断当前对话" }],
                    }, startTime);
                }

                // 拉取 trajectory 数据
                let result;
                try {
                    result = await fetchTrajectory(cascadeId, action === "fetch");
                } catch (err: any) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 获取对话数据失败: ${err.message}` }],
                    }, startTime);
                }

                if (!result) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 对话数据为空: ${cascadeId}` }],
                    }, startTime);
                }

                const { trajectory, fromCache } = result;
                const steps = trajectory.steps || [];
                const rounds = parseRounds(steps);

                // === fetch 模式 ===
                if (action === "fetch") {
                    const tempPath = saveConversationToTemp(cascadeId, rounds, steps.length);
                    const overview = formatOverview(cascadeId, rounds, steps.length);
                    const cacheNote = fromCache ? " (从缓存)" : " (新拉取)";

                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `${overview}${cacheNote}\n📁 临时文件: ${tempPath}\n💡 使用 search(query="关键词") 搜索或 read(startRound=1, endRound=3) 阅读`,
                        }],
                    }, startTime);
                }

                // === search 模式 ===
                if (action === "search") {
                    if (!query) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ search 模式需要提供 query 参数" }],
                        }, startTime);
                    }

                    const matches = searchInRounds(rounds, query, limit);
                    if (matches.length === 0) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `🔍 搜索 "${query}" — 未找到匹配` }],
                        }, startTime);
                    }

                    const output: string[] = [];
                    output.push(`🔍 搜索 "${query}" — 命中 ${matches.length} 处\n`);

                    // 收集需要展示的轮次（去重 + 上下文）
                    const roundsToShow = new Set<number>();
                    for (const m of matches) {
                        const ctx = contextRounds ?? 1;
                        for (let r = Math.max(1, m.roundIndex - ctx); r <= Math.min(rounds.length, m.roundIndex + ctx); r++) {
                            roundsToShow.add(r);
                        }
                    }

                    const sortedRounds = [...roundsToShow].sort((a, b) => a - b);
                    for (const ri of sortedRounds) {
                        const round = rounds[ri - 1];
                        if (!round) continue;
                        output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[]));
                        output.push("");
                    }

                    // 上下文大小控制
                    let text = output.join("\n");
                    const MAX_SEARCH = 8000;
                    if (depth === "full" && text.length > MAX_SEARCH) {
                        // full 深度不截断，写入临时文件
                        const slug = cascadeId.slice(0, 8);
                        const tmpPath = saveTempFile("search", slug, text);
                        const summary = text.slice(0, 2000) + `\n\n📄 完整搜索结果已写入: ${tmpPath}\n(共 ${text.length} 字)`;
                        return appendTiming({
                            content: [{ type: "text" as const, text: summary }],
                        }, startTime);
                    } else if (text.length > MAX_SEARCH) {
                        text = text.slice(0, MAX_SEARCH) + `\n\n⚠️ 结果过长已截断（${text.length}→${MAX_SEARCH}字），请用更精确的关键词或 depth=brief`;
                    }

                    return appendTiming({
                        content: [{ type: "text" as const, text }],
                    }, startTime);
                }

                // === read 模式 ===
                if (action === "read") {
                    const start = startRound || 1;
                    const end = endRound || rounds.length;

                    if (start > rounds.length) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ startRound ${start} 超出范围（共 ${rounds.length} 轮）` }],
                        }, startTime);
                    }

                    const output: string[] = [];
                    const overview = formatOverview(cascadeId, rounds, steps.length);
                    output.push(overview);
                    output.push(`📖 读取轮次 ${start}-${Math.min(end, rounds.length)}\n`);

                    for (let i = start; i <= Math.min(end, rounds.length); i++) {
                        output.push(formatRound(rounds[i - 1], depth as Depth, extraTypes as ExtraType[]));
                        output.push("");
                    }

                    // 上下文大小控制
                    let text = output.join("\n");
                    const MAX_READ = 15000;
                    if (depth === "full" && text.length > MAX_READ) {
                        // full 深度不截断，写入临时文件供完整阅读
                        const slug = cascadeId.slice(0, 8);
                        const tmpPath = saveTempFile("read", slug, text);
                        const summary = text.slice(0, 2000) + `\n\n📄 完整内容已写入: ${tmpPath}\n(共 ${text.length} 字，${output.length} 段)`;
                        return appendTiming({
                            content: [{ type: "text" as const, text: summary }],
                        }, startTime);
                    } else if (text.length > MAX_READ) {
                        text = text.slice(0, MAX_READ) + `\n\n⚠️ 结果过长已截断（${text.length}→${MAX_READ}字），请用更小的轮次范围或 brief 深度`;
                    }

                    return appendTiming({
                        content: [{ type: "text" as const, text }],
                    }, startTime);
                }

                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ 未知 action: ${action}` }],
                }, startTime);

            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: `❌ conversation_read_original 失败: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                }, startTime);
            }
        }
    );
}
