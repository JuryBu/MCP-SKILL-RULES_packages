import { exportConversation, type ConversationExportOptions } from "./conversation-exporter.js";
import { openProgressiveTaskCache } from "./conversation-progressive-task.js";
import { availableProgressiveRoles } from "./conversation-progressive-projection.js";
import { normalizeProgressiveProjection } from "./conversation-progressive-task-types.js";
import { resolveCorpusSources } from "./conversation-corpus-sources.js";
import type { ProgressiveReadResult } from "./conversation-progressive-types.js";

interface ReadyExportRequest {
    conversationId?: string;
    conversationIds?: string[];
    progressiveTaskId?: string;
    rangeRef?: string;
    blockId?: string;
    startRound?: number;
    endRound?: number;
    lastRounds?: number;
    dataChain?: string;
    dataChains?: string[];
    chain?: string;
    depth?: "brief" | "normal" | "full";
    messageRoles?: string[];
    extraTypes?: ConversationExportOptions["extraTypes"];
    exportFormat?: ConversationExportOptions["format"];
    exportScope?: ConversationExportOptions["scope"];
    outputDir?: string;
    overwrite?: boolean;
    includeAssets?: boolean;
    pdfEmbedAttachments?: ConversationExportOptions["pdfEmbedAttachments"];
    compactionMode?: ConversationExportOptions["compactionMode"];
    cacheGeneration?: string;
}

export async function exportProgressiveReadyRange(params: ReadyExportRequest) {
    const ownerId = params.conversationId?.trim();
    const taskId = params.progressiveTaskId;
    if (!ownerId || !taskId) throw new Error("就绪范围导出需要调用者conversationId和原progressiveTaskId");
    if (params.exportScope === "search") throw new Error("就绪范围请先search_ready取得命中rangeRef，再按该引用导出；exportScope=search使用完整fetch缓存入口");
    if (params.cacheGeneration) throw new Error("progressiveTaskId和完整fetch的cacheGeneration请分别使用");
    const sources = resolveCorpusSources(params);
    const identity = { ownerId, taskId };
    const { cache, ready, row } = await openProgressiveTaskCache(identity, params.rangeRef);
    const status = await cache.status();
    if (sources.length !== 1 || sources[0] !== status.source.host) throw new Error("导出dataChain与原准备任务来源不同");
    if (params.conversationIds && (params.conversationIds.length !== 1 || ![status.source.conversationId,
        status.source.conversation?.canonicalId, ...(status.source.conversation?.aliases || [])].includes(params.conversationIds[0]))) {
        throw new Error("导出目标与原准备任务不同");
    }
    const projection = normalizeProgressiveProjection(params.messageRoles === undefined && status.source.conversation?.isChildThread ? ["subagent"] : params.messageRoles, params.depth);
    const available = availableProgressiveRoles(status.source);
    if (projection.messageRoles.some(role => !available.includes(role))) throw new Error("本准备范围尚无所选角色，请先用prepare准备这些messageRoles，再导出原任务范围");
    const prepared = (status.source.snapshot as { projection?: { depth?: string } })?.projection;
    if ((projection.depth === "full" || params.extraTypes?.length) && prepared?.depth !== "full") {
        throw new Error("本范围按normal准备，思考和工具详情尚未准备；请用prepare、depth=full及所需messageRoles准备对应范围");
    }
    if (!row && params.startRound === undefined && params.endRound === undefined && params.lastRounds === undefined) {
        throw new Error("就绪范围导出请传rangeRef、明确轮次或lastRounds；完整原文导出继续使用fetch的缓存入口");
    }
    if (params.lastRounds !== undefined && (params.startRound !== undefined || params.endRound !== undefined)) throw new Error("lastRounds与明确轮次请只选一种");
    if (!row && !params.blockId && (params.startRound !== undefined || params.endRound !== undefined)
        && status.completeRanges.some(range => range.kind === "relative")) throw new Error("相对轮次请带原blockId或rangeRef导出，绝对轮次仍待核实");
    let result: ProgressiveReadResult;
    const selection = { blockId: params.blockId,
        ...(!params.blockId && !row && ready.preferredBlockIds?.length ? { blockIds: ready.preferredBlockIds } : {}) };
    if (row) {
        if ((params.startRound !== undefined && params.startRound !== row.round.roundIndex)
            || (params.endRound !== undefined && params.endRound !== row.round.roundIndex)) throw new Error("rangeRef与导出轮次不一致");
        result = { status, rows: [row], rounds: [row.round], messages: row.messages, requestedRangeComplete: true };
    } else if (params.lastRounds !== undefined) {
        const latest = await cache.readLatest({ ...selection, direction: "latest" }, params.lastRounds);
        const rows = latest.rows.slice().reverse();
        result = { ...latest, rows, rounds: rows.map(item => item.round), messages: rows.flatMap(item => item.messages) };
    } else result = await cache.read({ ...selection, startRound: params.startRound, endRound: params.endRound, direction: "oldest" });
    if (!result.rounds.length) throw new Error("所选范围尚未就绪，请沿原taskId查询prepare_status");
    const sourceRangeVerified = (status.source.snapshot as { source?: { sourceRangeVerified?: boolean } })?.source?.sourceRangeVerified !== false;
    const partial = !status.complete || !sourceRangeVerified || !result.requestedRangeComplete;
    const ranges = result.rows.map(item => ({ round: item.round.roundIndex, kind: item.kind, ref: item.ref, blockId: item.blockId }));
    const rounds = result.rows.map(item => {
        const replies = item.messages.filter(message => message.role === "subagent");
        if (!replies.length) return item.round;
        return { ...item.round, subagentSummaries: replies.map(message => {
            const threadId = message.sourceThreadId || `message:${message.id}`;
            const previous = item.round.subagentSummaries.find(summary => summary.threadId === threadId);
            return { ...previous, threadId, nickname: previous?.nickname || "subagent", summary: message.text };
        }) };
    });
    const exported = await exportConversation({
        conversationId: status.source.conversationId, chainUsed: status.source.host,
        rounds, totalSteps: Math.max(...result.rounds.map(round => round.endStep)) + 1,
        totalStepsKnown: false, totalRounds: status.source.totalRounds ?? result.rounds.length,
        totalRoundsKnown: status.source.totalRounds !== undefined,
        startRound: Math.min(...result.rounds.map(round => round.roundIndex)), endRound: Math.max(...result.rounds.map(round => round.roundIndex)),
        scope: "rounds", depth: projection.depth, messageRoles: projection.messageRoles,
        extraTypes: params.extraTypes, compactionMode: params.compactionMode,
        format: params.exportFormat, outputDir: params.outputDir, overwrite: params.overwrite,
        includeAssets: params.includeAssets, pdfEmbedAttachments: params.pdfEmbedAttachments,
        sourceMetadata: { partial, mode: "cache", cacheReadPolicy: "published", diagnostics: [...ready.warnings],
            isSubagent: status.source.conversation?.isChildThread,
            progressive: { taskId, fullSourceComplete: status.complete, sourceRangeVerified, ranges } },
    });
    return exported;
}
