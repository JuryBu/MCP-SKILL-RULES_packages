import fs from "node:fs";
import { iterateCachedConversationSourceCacheRounds, type ConversationSourceCacheKey } from "./conversation-source-cache.js";
import { createTempFilePathAsync } from "./temp-store.js";
import { formatRound, type ConversationRound } from "./trajectory.js";

export interface StreamedFetchArtifact {
    tempPath: string;
    roundCount: number;
    aiResponseCount: number;
    toolCallCount: number;
    attachmentCount: number;
}

export interface FetchArtifactConversation {
    conversationId: string;
    totalSteps: number;
    rounds: ConversationRound[];
    roundCount?: number;
    cacheKey?: ConversationSourceCacheKey;
    cacheGeneration?: string;
}

export interface FetchArtifactWriteOptions {
    isCancelled?: () => boolean;
    onArtifactPath?: (path: string) => Promise<void> | void;
}

const CONVERSATION_FORMAT_YIELD_INTERVAL = 5;

function yieldConversationEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function yieldConversationFormatIfNeeded(processed: number): Promise<void> {
    if (processed > 0 && processed % CONVERSATION_FORMAT_YIELD_INTERVAL === 0) {
        await yieldConversationEventLoop();
    }
}

export async function writeFetchedConversationArtifact(
    loaded: FetchArtifactConversation,
    expandedChildren: Array<{ thread: { id: string; title: string }; rounds: ConversationRound[] }>,
    childDiagnostics: Array<{ threadId: string; nickname?: string; reason: string; detail: string }>,
    options: FetchArtifactWriteOptions = {},
): Promise<StreamedFetchArtifact> {
    const cached = loaded.cacheKey && loaded.cacheGeneration
        ? iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: loaded.cacheKey,
            generation: loaded.cacheGeneration,
        })
        : null;
    if (loaded.cacheKey && loaded.cacheGeneration && !cached) throw new Error("fetch 缓存轮次文件缺失或损坏");
    const parentRounds = cached?.rounds || loaded.rounds;
    const roundCount = cached?.roundCount ?? loaded.roundCount ?? loaded.rounds.length;

    const tempPath = await createTempFilePathAsync("conv", loaded.conversationId.slice(0, 8));
    const handle = await fs.promises.open(tempPath, "wx");
    let aiResponseCount = 0;
    let toolCallCount = 0;
    let attachmentCount = 0;
    let index = 0;
    try {
        await options.onArtifactPath?.(tempPath);
        if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
        await handle.write(`# 对话原文: ${loaded.conversationId}\n> 步骤: ${loaded.totalSteps} | 轮次: ${roundCount}\n\n`);
        for (const round of parentRounds) {
            if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
            aiResponseCount += round.aiResponses.length;
            toolCallCount += round.toolCalls.length;
            attachmentCount += round.attachments?.length || 0;
            await handle.write(`${formatRound(round, "normal", [], { compactionMode: "omit" })}\n\n`);
            if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
            index += 1;
            await yieldConversationFormatIfNeeded(index);
        }
        if (expandedChildren.length > 0) {
            await handle.write("# 子代理线程展开\n\n");
            for (const child of expandedChildren) {
                if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
                await handle.write(`## 子线程 ${child.thread.id.slice(0, 8)}... ${child.thread.title ? `| ${child.thread.title}` : ""}\n\n`);
                for (const round of child.rounds) {
                    if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
                    await handle.write(`${formatRound(round, "normal", [], { compactionMode: "omit" })}\n\n`);
                    index += 1;
                    await yieldConversationFormatIfNeeded(index);
                }
            }
        }
        if (childDiagnostics.length > 0) {
            if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
            await handle.write("# 子代理线程诊断\n\n");
            for (const item of childDiagnostics) {
                const label = item.nickname ? `${item.nickname} (${item.threadId.slice(0, 8)}...)` : item.threadId;
                await handle.write(`- ${label}: ${item.reason} — ${item.detail}\n`);
            }
        }
        if (options.isCancelled?.()) throw new Error("conversation fetch artifact cancelled");
        await handle.sync();
        return { tempPath, roundCount, aiResponseCount, toolCallCount, attachmentCount };
    } catch (error) {
        await handle.close().catch(() => undefined);
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        await handle.close().catch(() => undefined);
    }
}
