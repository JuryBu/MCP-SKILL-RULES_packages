import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { parseRounds, type ConversationRound } from "../trajectory.js";
import { fuseSearch } from "../search.js";
import { readWorkspaceIndex, readGeneralIndex, listWorkspaceHashes, workspaceHash } from "../store.js";
import { type MemoryIndexEntry } from "../cache.js";
import { loadConversationData } from "../conversation-bridge.js";
import { callModelResponse } from "../model-bridge.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";
import { DATA_CHAIN_INPUT_VALUES, resolveChainSplit, formatChainSplit, type ChainInput, type DataChainInput } from "../chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "../ls-model-defaults.js";
import { modelChainInputSchema } from "./schema-utils.js";

/**
 * conversation_golden_extract — 黄金片段提取
 * 
 * 从对话 trajectory 中提取关键决策、发现、踩坑经验，
 * 然后与现有记忆对比，标注已有/疑似重复/全新。
 * 
 * v1.5 新增工具
 */
export function registerGoldenExtract(server: McpServer): void {
    server.tool(
        "conversation_golden_extract",
        "从对话中提取关键信息（决策、发现、踩坑经验），并与现有记忆对比去重。帮助发现对话中值得持久化但尚未保存的知识。",
        {
            conversationId: z.string().optional().describe("对话 ID（不填默认当前对话）"),
            stepStart: z.number().optional().describe("起始步骤偏移（从对话的特定位置开始分析）"),
            stepEnd: z.number().optional().describe("结束步骤偏移"),
            autoCompare: z.boolean().optional().describe("是否自动与记忆对比去重（默认 true）"),
            workspace: z.string().optional().describe("搜索去重的目标工作区（默认搜索全部）"),
            chain: z.enum(DATA_CHAIN_INPUT_VALUES).optional().describe("兼容旧参数：dataChain/modelChain 未填时沿用此链路；chain=\"windsurf\" 只作为 dataChain"),
            dataChain: z.enum(DATA_CHAIN_INPUT_VALUES).optional().describe("读取对话数据的宿主链路；未填用 chain，支持 windsurf"),
            modelChain: modelChainInputSchema("modelChain", "调用模型提取片段的链路；未填用 chain。Windsurf 只支持 dataChain"),
            background: z.boolean().optional().describe("Codex 链路长模型调用建议设为 true，立即返回 taskId，后续用 taskId 查询"),
            taskId: z.string().optional().describe("查询后台提取任务的 taskId"),
            waitSeconds: z.number().optional().describe("查询后台任务时等待秒数(1-300)，任务完成时提前返回"),
        },
        async (args) => {
            touchActivity();
            const startTime = Date.now();
            if (args.taskId) {
                const task = await waitForBackgroundTask(args.taskId, args.waitSeconds || 0);
                return appendTiming({
                    content: [{ type: "text" as const, text: formatBackgroundTask(task) }],
                }, startTime);
            }
            if (args.background) {
                const task = startBackgroundTask("golden-extract", async () => {
                    const result = await runGoldenExtract({ ...args, background: false, taskId: undefined, waitSeconds: undefined }, Date.now());
                    return result.content.map((item: { text: string }) => item.text).join("\n");
                });
                const chains = resolveChainSplit(args);
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: [
                            "🚀 黄金片段提取已转入后台任务",
                            `🆔 taskId: ${task.id}`,
                            `🔗 ${formatChainSplit(chains)}`,
                            "💡 后续调用 conversation_golden_extract(taskId=\"...\") 查询结果",
                        ].join("\n"),
                    }],
                }, startTime);
            }

            return runGoldenExtract(args, startTime);
        }
    );
}

type GoldenExtractArgs = {
    conversationId?: string;
    stepStart?: number;
    stepEnd?: number;
    autoCompare?: boolean;
    workspace?: string;
    chain?: ChainInput | DataChainInput;
    dataChain?: DataChainInput;
    modelChain?: ChainInput;
    background?: boolean;
    taskId?: string;
    waitSeconds?: number;
};

async function runGoldenExtract(
    { conversationId, stepStart, stepEnd, autoCompare, workspace, chain, dataChain, modelChain }: GoldenExtractArgs,
    startTime: number,
) {
    try {
                const chains = resolveChainSplit({ chain, dataChain, modelChain });
                const loaded = await loadConversationData(chains.dataChain, conversationId, { link: "summary" });
                if (!loaded) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 无法通过 dataChain=${chains.dataChain} 获取对话数据` }],
                    }, startTime);
                }

                const cascadeId = loaded.conversationId;
                let rounds = loaded.rounds;

                // 截取轮次范围（兼容旧 stepStart/stepEnd 参数名）
                if (stepStart !== undefined || stepEnd !== undefined) {
                    const start = stepStart || 0;
                    const end = stepEnd || rounds.length;
                    rounds = rounds.slice(start, end);
                }

                if (rounds.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "⚠️ 对话步骤中未解析到有效轮次。" }],
                    }, startTime);
                }

                // 从轮次中提取对话文本
                const dialogueText = extractDialogueFromRounds(rounds);
                if (dialogueText.length < 50) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "⚠️ 对话内容过短，无法提取有价值的片段。" }],
                    }, startTime);
                }

                // 截断到合理长度（Flash prompt 限制）
                const truncatedText = dialogueText.slice(0, 8000);

                // 调用 Flash 提取关键信息
                const prompt = `分析以下对话片段，提取值得长期记忆的关键信息。
                
请从以下维度提取：
1. [决策] 重要的技术决策和设计选择
2. [发现] 验证过的技术发现和结论  
3. [踩坑] 遇到的问题和解决方案
4. [知识] 值得记录的技术知识和经验

每条一行，格式：[类型] 简短描述（50字以内）

对话内容：
${truncatedText}

请直接输出提取结果，每行一条，不要加序号或其他格式。如果没有值得提取的信息，输出"无"。`;

                const flashResponse = await callModelResponse(
                    process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL,
                    prompt,
                    chains.modelChain,
                    30_000,
                    { allowClaudeCodeFallback: chains.dataChain === "claude-code" },
                );
                if (!flashResponse.text || flashResponse.text.trim() === "无") {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "ℹ️ 对话中未发现需要提取的关键信息。" }],
                    }, startTime);
                }

                // 解析 Flash 输出
                const fragments = parseFragments(flashResponse.text);
                if (fragments.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: "ℹ️ 对话中未发现需要提取的关键信息。" }],
                    }, startTime);
                }

                // 构建结果
                const shouldCompare = autoCompare !== false;
                let resultText = `🔍 黄金片段提取 — ${cascadeId.slice(0, 8)}... (data=${loaded.chainUsed}, model=${chains.modelChain}, ${loaded.totalSteps}步, ${rounds.length}轮)\n\n`;
                resultText += `提取到 ${fragments.length} 条关键信息:\n\n`;

                if (shouldCompare) {
                    const allEntries = collectAllEntries(workspace);
                    let existing = 0, suspicious = 0, novel = 0;

                    for (const frag of fragments) {
                        const matches = fuseSearch(allEntries, frag.content, 3);
                        const bestMatch = matches.length > 0 ? matches[0] : null;

                        resultText += `[${frag.type}] ${frag.content}\n`;

                        if (bestMatch && bestMatch.score < 0.3) {
                            resultText += `  ↳ 📦 已有: [${bestMatch.entry.id}] "${bestMatch.entry.title}" (相似度 ${(1 - bestMatch.score).toFixed(2)})\n\n`;
                            existing++;
                        } else if (bestMatch && bestMatch.score < 0.6) {
                            resultText += `  ↳ ❓ 疑似重复: [${bestMatch.entry.id}] "${bestMatch.entry.title}" (相似度 ${(1 - bestMatch.score).toFixed(2)})\n\n`;
                            suspicious++;
                        } else {
                            resultText += `  ↳ 🆕 全新 — 建议写入记忆\n\n`;
                            novel++;
                        }
                    }

                    resultText += `📊 汇总: ${existing} 已有 / ${suspicious} 疑似重复 / ${novel} 🆕 全新`;
                    if (novel > 0) {
                        resultText += `\n💡 建议: 将 ${novel} 条全新信息写入 memory`;
                    }
                } else {
                    for (const frag of fragments) {
                        resultText += `[${frag.type}] ${frag.content}\n`;
                    }
                }

                return appendTiming({
                    content: [{ type: "text" as const, text: resultText }],
                }, startTime);
    } catch (error) {
        return appendTiming({
            content: [{
                type: "text" as const,
                text: `❌ 黄金片段提取失败: ${error instanceof Error ? error.message : String(error)}`,
            }],
        }, startTime);
    }
}

// ============= 辅助函数 =============

interface Fragment {
    type: string;
    content: string;
}

/**
 * 从解析后的 ConversationRound 中提取对话文本
 * 使用 trajectory.ts 的 parseRounds 输出，确保字段路径正确
 */
function extractDialogueFromRounds(rounds: ConversationRound[]): string {
    const parts: string[] = [];

    for (const round of rounds) {
        // 用户消息
        if (round.userMessage && round.userMessage.trim()) {
            parts.push(`[用户] ${round.userMessage.slice(0, 500)}`);
        }

        // AI 响应（可能多条）
        for (const ai of round.aiResponses) {
            if (ai.response && ai.response.trim()) {
                parts.push(`[AI] ${ai.response.slice(0, 800)}`);
            }
        }

        // 任务状态变更（包含有价值的上下文）
        for (const tb of round.taskBoundaries) {
            if (tb.taskName) {
                parts.push(`[任务] ${tb.taskName}: ${tb.taskStatus}`);
            }
        }
    }

    return parts.join("\n\n");
}

/**
 * 解析 Flash 输出为结构化片段
 */
function parseFragments(text: string): Fragment[] {
    const fragments: Fragment[] = [];
    const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    for (const line of lines) {
        const match = line.match(/^\[(\S+)\]\s*(.+)$/);
        if (match) {
            fragments.push({
                type: match[1],
                content: match[2],
            });
        }
    }

    return fragments;
}

/**
 * 收集所有可搜索的记忆条目
 */
function collectAllEntries(targetWorkspace?: string): MemoryIndexEntry[] {
    const allEntries: MemoryIndexEntry[] = [];

    if (targetWorkspace) {
        if (targetWorkspace === "general") {
            const index = readGeneralIndex();
            allEntries.push(...index.entries);
        } else {
            const h = workspaceHash(targetWorkspace);
            const idx = readWorkspaceIndex(h);
            allEntries.push(...idx.entries);
        }
    } else {
        // 搜索全部
        const generalIndex = readGeneralIndex();
        allEntries.push(...generalIndex.entries);

        const hashes = listWorkspaceHashes();
        for (const hash of hashes) {
            const wsIndex = readWorkspaceIndex(hash);
            allEntries.push(...wsIndex.entries);
        }
    }

    return allEntries;
}
