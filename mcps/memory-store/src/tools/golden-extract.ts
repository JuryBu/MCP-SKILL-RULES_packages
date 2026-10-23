import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { formatRoundForMessageRoles, type ConversationRound, type ConversationMessageRole } from "../trajectory.js";
import { fuseSearch } from "../search.js";
import { readWorkspaceIndex, readGeneralIndex, listWorkspaceHashes, workspaceHash } from "../store.js";
import { type MemoryIndexEntry } from "../cache.js";
import { loadConversationData, resolveConversationChain, resolveConversationId } from "../conversation-bridge.js";
import { callModelResponse } from "../model-bridge.js";
import {
    formatBackgroundTask,
    registerBackgroundTaskRecoveryHandler,
    startBackgroundTask,
    waitForBackgroundTask,
} from "../background-tasks.js";
import type { BackgroundTaskContext } from "../background-tasks.js";
import { CHAIN_COMPAT_INPUT_VALUES, DATA_CHAIN_INPUT_VALUES, resolveChainSplit, formatChainSplit, decideBackground, type Chain, type ChainInput, type DataChain, type DataChainInput } from "../chain.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "../ls-model-defaults.js";
import { formatToolError } from "../error-format.js";
import { dataChainInputSchema, modelChainInputSchema } from "./schema-utils.js";
import type { ResumePayloadValue } from "../background-recovery.js";
import { assertConversationConsumerSourceComplete } from "../devin-source-evidence.js";
import { openProgressiveTaskCache } from "../conversation-progressive-task.js";
import type { ProgressiveSource, ProgressiveRow } from "../conversation-progressive-types.js";

export interface GoldenExtractDependencies {
    loadConversation?: typeof loadConversationData;
    openProgressiveCache?: typeof openProgressiveTaskCache;
    callModel?: typeof callModelResponse;
}

const goldenExtractDefaults = {
    loadConversation: loadConversationData,
    openProgressiveCache: openProgressiveTaskCache,
    callModel: callModelResponse,
};

/**
 * conversation_golden_extract — 黄金片段提取
 * 
 * 从对话 trajectory 中提取关键决策、发现、踩坑经验，
 * 然后与现有记忆对比，标注已有/疑似重复/全新。
 * 
 * v1.5 新增工具
 */

interface GoldenExtractResumePayload {
    version: 1;
    conversationId: string;
    progressiveTaskId?: string;
    rangeRefs?: string[];
    stepStart?: number;
    stepEnd?: number;
    autoCompare?: boolean;
    workspace?: string;
    dataChain: DataChain;
    modelChain: Chain;
}

async function buildGoldenExtractResumePayload(args: GoldenExtractArgs): Promise<GoldenExtractResumePayload | null> {
    assertGoldenProgressiveSelection(args);
    const chains = resolveChainSplit(args);
    if (args.rangeRefs?.length) {
        return {
            version: 1, conversationId: args.conversationId!, progressiveTaskId: args.progressiveTaskId,
            rangeRefs: [...args.rangeRefs], autoCompare: args.autoCompare, workspace: args.workspace,
            dataChain: chains.dataChain, modelChain: chains.modelChain,
        };
    }
    const dataChain = await resolveConversationChain(chains.dataChain);
    if (!dataChain) return null;
    const conversationId = await resolveConversationId(args.conversationId, dataChain);
    if (!conversationId) return null;
    return {
        version: 1,
        conversationId,
        stepStart: args.stepStart,
        stepEnd: args.stepEnd,
        autoCompare: args.autoCompare,
        workspace: args.workspace,
        dataChain,
        modelChain: chains.modelChain,
    };
}

function isGoldenExtractResumePayload(value: unknown): value is GoldenExtractResumePayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as Partial<GoldenExtractResumePayload>;
    return payload.version === 1
        && typeof payload.conversationId === "string"
        && typeof payload.dataChain === "string"
        && typeof payload.modelChain === "string"
        && (payload.rangeRefs === undefined || (Array.isArray(payload.rangeRefs)
            && payload.rangeRefs.every(ref => typeof ref === "string" && Boolean(ref.trim()))
            && (!payload.rangeRefs.length || typeof payload.progressiveTaskId === "string")));
}

registerBackgroundTaskRecoveryHandler("golden-extract", async (task) => {
    if (!isGoldenExtractResumePayload(task.resumePayload)) {
        throw new Error("golden-extract 缺少可恢复的最小 resumePayload");
    }
    const payload = task.resumePayload as GoldenExtractResumePayload;
    return {
        mode: "restart",
        run: async (taskContext) => {
            const result = await runGoldenExtract(
                {
                    ...payload,
                    background: false,
                    taskId: undefined,
                    waitSeconds: undefined,
                },
                Date.now(),
                taskContext,
            );
            return result.content.map((item: { text: string }) => item.text).join("\n");
        },
    };
});

export function registerGoldenExtract(server: McpServer, overrides: GoldenExtractDependencies = {}): void {
    const dependencies = { ...goldenExtractDefaults, ...overrides };
    server.tool(
        "conversation_golden_extract",
        "从对话中提取关键信息（决策、发现、踩坑经验），并与现有记忆对比去重。帮助发现对话中值得持久化但尚未保存的知识。",
        {
            conversationId: z.string().optional().describe("对话 ID；选择progressive范围时必须显式填写当前调用者conversationId，用于任务归属核验"),
            progressiveTaskId: z.string().optional().describe("已发布范围所属的progressive任务ID，必须与非空rangeRefs配套；两者均未提供时保留原完整缓存路线"),
            rangeRefs: z.array(z.string().min(1)).optional().describe("明确选择的已发布pcache轮次引用；只提取所选范围，来源与partial标记随结果返回"),
            stepStart: z.number().optional().describe("起始步骤偏移（从对话的特定位置开始分析）"),
            stepEnd: z.number().optional().describe("结束步骤偏移"),
            autoCompare: z.boolean().optional().describe("是否自动与记忆对比去重（默认 true）"),
            workspace: z.string().optional().describe("搜索去重的目标工作区（默认搜索全部）"),
            chain: z.enum(CHAIN_COMPAT_INPUT_VALUES).optional().describe("兼容旧参数：dataChain/modelChain 未填时沿用此链路；chain=\"windsurf\" 只作为 dataChain，chain=\"grok\"/\"agy\" 只作为 modelChain"),
            dataChain: dataChainInputSchema("dataChain", "读取对话数据的宿主链路；未填用 chain，支持 windsurf；agy 与 Grok 只支持 modelChain"),
            modelChain: modelChainInputSchema("modelChain", "调用模型提取片段的链路；未填用 chain；agy=本地 CLI 的三模型内部 fallback，Grok=本机 progrok proxy。Windsurf 只支持 dataChain"),
            background: z.boolean().optional().describe("三态后台：true=强制后台立即返回 taskId / false=强制同步 / 不传时自动后台排队，后续用 taskId 查询"),
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
            try { assertGoldenProgressiveSelection(args); }
            catch (error) {
                return appendTiming({ isError: true, content: [{ type: "text" as const,
                    text: formatToolError("conversation_golden_extract", error, { conversationId: args.conversationId }) }] }, startTime);
            }
            // C3 块B：三态 background 语义（详见 chain.ts decideBackground）。
            const chains = resolveChainSplit(args);
            const decision = decideBackground(args.background, chains.modelChain, "always");
            if (decision.useBackground) {
                const resumePayload = await buildGoldenExtractResumePayload(args);
                if (!resumePayload) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 无法为 dataChain=${chains.dataChain} 冻结可恢复的 conversationId` }],
                    }, startTime);
                }
                const task = startBackgroundTask("golden-extract", async (taskContext) => {
                    const result = await runGoldenExtract(
                        { ...args, background: false, taskId: undefined, waitSeconds: undefined },
                        Date.now(),
                        taskContext,
                        dependencies,
                    );
                    return result.content.map((item: { text: string }) => item.text).join("\n");
                }, {
                    resumePayload: resumePayload as unknown as ResumePayloadValue,
                });
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: [
                            "🚀 黄金片段提取已转入后台任务",
                            decision.auto ? "（未显式指定 background，已自动转后台排队；如需同步请传 background=false）" : "",
                            `🆔 taskId: ${task.id}`,
                            `🔗 ${formatChainSplit(chains)}`,
                            "💡 后续调用 conversation_golden_extract(taskId=\"...\") 查询结果",
                        ].filter(Boolean).join("\n"),
                    }],
                }, startTime);
            }

            return runGoldenExtract(args, startTime, undefined, dependencies);
        }
    );
}

type GoldenExtractArgs = {
    conversationId?: string;
    progressiveTaskId?: string;
    rangeRefs?: string[];
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

function assertGoldenProgressiveSelection(args: GoldenExtractArgs): void {
    if (args.progressiveTaskId === undefined && args.rangeRefs === undefined) return;
    if (!args.conversationId?.trim() || !args.progressiveTaskId?.trim()) {
        throw new Error("已发布范围提取必须显式提供当前conversationId、progressiveTaskId和rangeRefs");
    }
    if (!args.rangeRefs?.length || args.rangeRefs.some(ref => !ref.trim())) {
        throw new Error("rangeRefs必须明确选择已发布的轮次引用");
    }
    if (args.stepStart !== undefined || args.stepEnd !== undefined) {
        throw new Error("rangeRefs与stepStart/stepEnd请选择一种范围输入");
    }
}

async function loadGoldenProgressiveSelection(args: GoldenExtractArgs, dependencies: typeof goldenExtractDefaults) {
    assertGoldenProgressiveSelection(args);
    const rows: ProgressiveRow[] = [];
    let source: ProgressiveSource | undefined;
    let sourceKey: string | undefined;
    let fullSourceComplete = true;
    const refs = [...new Set(args.rangeRefs!)];
    for (const ref of refs) {
        const opened = await dependencies.openProgressiveCache({ ownerId: args.conversationId!, taskId: args.progressiveTaskId! }, ref);
        const row = opened.row;
        if (!row || row.ref !== ref) throw new Error("范围引用尚未发布或未返回对应完整轮次");
        const status = await opened.cache.status();
        const published = status.blocks.some(block => block.blockId === row.blockId && block.anchorId === row.anchorId
            && block.coverage.kind === row.kind && block.coverage.startRound <= row.round.roundIndex
            && block.coverage.endRound >= row.round.roundIndex);
        if (!published) throw new Error("所选范围尚未完成发布，请继续查询原progressiveTaskId");
        if (source && (sourceKey !== status.sourceKey || source.conversationId !== status.source.conversationId
            || source.host !== status.source.host || source.revision !== status.source.revision)) {
            throw new Error("rangeRefs必须来自同一对话的同一来源版本");
        }
        source = status.source;
        sourceKey = status.sourceKey;
        fullSourceComplete &&= status.complete;
        rows.push(row);
    }
    const selectedSource = source!;
    const scopeText = `partial=true; source=${selectedSource.host}:${selectedSource.conversationId}; revision=${selectedSource.revision}; `
        + `progressiveTaskId=${args.progressiveTaskId}; fullSourceComplete=${fullSourceComplete}\n`
        + `rangeRefs=${JSON.stringify(refs)}\n选定范围=${JSON.stringify(rows.map(row => ({ kind: row.kind,
            anchorId: row.anchorId, round: row.round.roundIndex, startStep: row.round.startStep, endStep: row.round.endStep })))}\n`
        + "本次提取的结论范围限定为上述已发布轮次。";
    return { conversationId: selectedSource.conversationId, chainUsed: selectedSource.host,
        totalSteps: rows.reduce((total, row) => total + Math.max(0, row.round.endStep - row.round.startStep + 1), 0),
        rounds: rows.map(row => row.round), scopeText };
}

function isGoldenTaskAborted(taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">): boolean {
    return Boolean(taskContext?.isCancelled() || taskContext?.isSettled());
}

function formatGoldenTaskAborted(startTime: number, taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">) {
    return appendTiming({
        content: [{
            type: "text" as const,
            text: taskContext?.isCancelled()
                ? "🛑 黄金片段提取后台任务已取消，已跳过后续模型提取"
                : "🛑 黄金片段提取后台任务已结束，已跳过后续模型提取",
        }],
    }, startTime);
}

async function runGoldenExtract(
    args: GoldenExtractArgs,
    startTime: number,
    taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">,
    dependencies: typeof goldenExtractDefaults = goldenExtractDefaults,
) {
    const { conversationId, stepStart, stepEnd, autoCompare, workspace, chain, dataChain, modelChain } = args;
    try {
                assertGoldenProgressiveSelection(args);
                const chains = resolveChainSplit({ chain, dataChain, modelChain });
                const progressive = args.rangeRefs?.length ? await loadGoldenProgressiveSelection(args, dependencies) : undefined;
                const full = progressive ? undefined : await dependencies.loadConversation(chains.dataChain, conversationId, { link: "summary" });
                const loaded = progressive || full;
                if (!loaded) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 无法通过 dataChain=${chains.dataChain} 获取对话数据` }],
                    }, startTime);
                }

                const cascadeId = loaded.conversationId;
                if (full?.windsurfData?.thread.sourceKind) assertConversationConsumerSourceComplete(full);
                const scopeText = progressive?.scopeText;
                const scoped = (text: string): string => scopeText ? `${scopeText}\n\n${text}` : text;
                let rounds = loaded.rounds;

                // 截取轮次范围（兼容旧 stepStart/stepEnd 参数名）
                if (stepStart !== undefined || stepEnd !== undefined) {
                    const start = stepStart || 0;
                    const end = stepEnd || rounds.length;
                    rounds = rounds.slice(start, end);
                }

                if (rounds.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: scoped("⚠️ 对话步骤中未解析到有效轮次。") }],
                    }, startTime);
                }

                // 从轮次中提取对话文本
                const dialogueText = progressive
                    ? rounds.map(round => formatRoundForMessageRoles(round, "full",
                        ["tool_results", "code_actions", "code_diffs", "file_views"],
                        new Set<ConversationMessageRole>(["user", "model", "assistant", "tool", "system", "subagent"]), "folded")).join("\n\n")
                    : extractDialogueFromRounds(rounds);
                if (dialogueText.length < 50) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: scoped("⚠️ 对话内容过短，无法提取有价值的片段。") }],
                    }, startTime);
                }

                // 截断到合理长度（Flash prompt 限制）
                const truncatedText = dialogueText.slice(0, 8000);

                // 调用 Flash 提取关键信息
                const prompt = `${scopeText ? `${scopeText}\ninputTruncated=${dialogueText.length > 8000}\n\n` : ""}分析以下对话片段，提取值得长期记忆的关键信息。
                
请从以下维度提取：
1. [决策] 重要的技术决策和设计选择
2. [发现] 验证过的技术发现和结论  
3. [踩坑] 遇到的问题和解决方案
4. [知识] 值得记录的技术知识和经验

每条一行，格式：[类型] 简短描述（50字以内）

对话内容：
${truncatedText}

请直接输出提取结果，每行一条，不要加序号或其他格式。如果没有值得提取的信息，输出"无"。`;
                if (isGoldenTaskAborted(taskContext)) {
                    return formatGoldenTaskAborted(startTime, taskContext);
                }

                const flashResponse = await dependencies.callModel(
                    process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL,
                    prompt,
                    chains.modelChain,
                    30_000,
                    { allowClaudeCodeFallback: chains.dataChain === "claude-code", grokContext: "default" },
                );
                if (isGoldenTaskAborted(taskContext)) {
                    return formatGoldenTaskAborted(startTime, taskContext);
                }
                if (!flashResponse.text || flashResponse.text.trim() === "无") {
                    return appendTiming({
                        content: [{ type: "text" as const, text: scoped("ℹ️ 对话中未发现需要提取的关键信息。") }],
                    }, startTime);
                }

                // 解析 Flash 输出
                const fragments = parseFragments(flashResponse.text);
                if (fragments.length === 0) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: scoped("ℹ️ 对话中未发现需要提取的关键信息。") }],
                    }, startTime);
                }

                // 构建结果
                const shouldCompare = autoCompare !== false;
                const modelLabel = flashResponse.chainUsed
                    ? `${chains.modelChain}/${flashResponse.chainUsed}:${flashResponse.modelUsed || "unknown"}`
                    : chains.modelChain;
                let resultText = `🔍 黄金片段提取 — ${cascadeId.slice(0, 8)}... (data=${loaded.chainUsed}, model=${modelLabel}, grokContext=default, ${loaded.totalSteps}步, ${rounds.length}轮)\n\n`;
                if (scopeText) resultText += `${scopeText}\ninputTruncated=${dialogueText.length > 8000}\n\n`;
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
            isError: true,
            content: [{
                type: "text" as const,
                text: formatToolError("conversation_golden_extract", error, { conversationId, workspace }),
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
