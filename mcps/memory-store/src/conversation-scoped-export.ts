import { normalizeDataChain, type DataChain } from "./chain.js";
import {
    describeConversationCacheReadFailure,
    loadConversationData,
    type ConversationLoadOptions,
    type ConversationLoadResult,
} from "./conversation-bridge.js";
import {
    conversationExportSourceMetadata,
    exportConversation,
    type ConversationExportOptions,
    type ConversationExportResult,
} from "./conversation-exporter.js";
import { runIsolatedSource, type IsolatedSourceControl } from "./conversation-isolated-source.js";
import { assertConversationStrictCacheState, type ConversationSearchReadRequest } from "./conversation-search-policy.js";
import type { CorpusProjection, CorpusReadControl } from "./conversation-corpus-types.js";
import type { exportProgressiveReadyRange } from "./conversation-progressive-export.js";

type ExportSelection = Omit<ConversationExportOptions, "conversationId" | "chainUsed" | "rounds" | "totalSteps" | "isCancelled" | "isSettled">;

export type ConversationSourceExportRequest = {
    kind: "source";
    dataChain: DataChain;
    conversationId: string;
    loadOptions: ConversationLoadOptions;
    cacheRequest: ConversationSearchReadRequest;
    selection: ExportSelection;
} | {
    kind: "progressive";
    params: Parameters<typeof exportProgressiveReadyRange>[0];
};

export function runConversationSourceExport(request: ConversationSourceExportRequest,
    control: IsolatedSourceControl = {}): Promise<ConversationExportResult> {
    return runIsolatedSource("conversation-export", request, control);
}

function partialWarning(loaded: ConversationLoadResult): string {
    const skipped = loaded.windsurfData?.skippedSteps || [];
    if (!loaded.windsurfData?.partial || !skipped.length) return "";
    const shown = skipped.slice(0, 5).map(item => `offset ${item.offset}`).join(", ");
    const more = skipped.length > 5 ? ` 等 ${skipped.length} 个` : "";
    return [
        `⚠️ WSF 读取已降级：跳过超大 step ${shown}${more}`,
        "这些 step 超过 Windsurf LS 单步 4MB 限制，正文中会显示占位轮次；本次 fetch 不会自动触发 Record 更新，避免把不完整原文写成正式 Record。",
    ].join("\n");
}

async function readScopedProjection(request: Extract<ConversationSourceExportRequest, { kind: "source" }>,
    control: CorpusReadControl): Promise<CorpusProjection | null> {
    const { loadOptions, selection, conversationId } = request;
    const source = normalizeDataChain(request.dataChain);
    if (selection.scope !== "rounds" || selection.endRound === undefined || source === "auto"
        || loadOptions.source === "cache" || loadOptions.source === "ls" || loadOptions.cacheGeneration
        || loadOptions.publishedCacheOnly || loadOptions.logicalChain && loadOptions.logicalChain !== "off"
        || source === "codex" && loadOptions.link === "expand_children") return null;
    if (source === "windsurf" && loadOptions.link === "expand_children") {
        const { splitDevinSubagentId } = await import("./devin-conversation.js");
        if (!splitDevinSubagentId(conversationId)) return null;
    }
    const startRound = selection.startRound ?? 1;
    const endRound = selection.endRound;
    if (!Number.isSafeInteger(startRound) || startRound < 1 || !Number.isSafeInteger(endRound) || endRound < startRound) {
        throw new Error("导出轮次范围需要正整数，且startRound不能大于endRound");
    }
    const messageRoles = ["user", "assistant", "tool", "subagent"] as const;
    if (source === "codex") {
        const { getCodexThreadAsync } = await import("./codex-client.js");
        const { readCodexHistoryWindow } = await import("./codex-history-window.js");
        const { normalizeCodexCorpusConversationId } = await import("./conversation-corpus-search.js");
        const targetId = normalizeCodexCorpusConversationId(conversationId);
        const thread = await getCodexThreadAsync(targetId);
        if (!thread?.rolloutPath) throw new Error("Codex conversation source is unavailable");
        const range = await readCodexHistoryWindow({
            conversationId: targetId, sourcePath: thread.rolloutPath, cwd: thread.cwd,
            direction: "oldest", maxRounds: endRound, rangeRounds: endRound,
            continueHistory: false, fillRequestedRange: true,
            messageRoles: [...messageRoles], isCancelled: control.isCancelled,
            onProgress: progress => control.onProgress?.({ phase: `codex-export-${progress.phase}`, bytes: progress.bytesRead }),
        });
        if (!range.coverage.historyStartReached || range.source.snapshot.sourceRangeVerified === false) {
            throw new Error("Codex导出范围的绝对轮次尚未核实，请沿原prepare任务的rangeRef导出");
        }
        const fullSourceComplete = range.coverage.snapshotEndReached;
        return {
            conversation: { source, id: targetId, canonicalId: targetId, title: thread.title,
                workspace: thread.cwd, rolloutPath: thread.rolloutPath, isChildThread: thread.isChildThread,
                parentConversationId: thread.parentConversationId || undefined },
            revision: range.source.revision, messages: [],
            rounds: range.rounds.filter(round => round.roundIndex >= startRound && round.roundIndex <= endRound),
            roundNumbering: "absolute", totalRounds: fullSourceComplete ? range.rounds.length : undefined,
            complete: fullSourceComplete && startRound === 1, fullSourceComplete,
            requestedRangeComplete: range.coverage.requestedRangeComplete || fullSourceComplete,
            readableRangeVerified: true,
            warnings: fullSourceComplete ? [] : ["requested_round_range_complete", "full_source_projection_not_built"],
            sourceBytes: range.progress.bytesRead,
        };
    }
    const { createMultiCorpusProvider } = await import("./conversation-corpus-reader-multi.js");
    const provider = createMultiCorpusProvider();
    const candidates = await provider.list({ dataChains: [source], conversationIds: [conversationId],
        sourceFailureMode: request.loadOptions.sourceFailureMode, messageRoles: [...messageRoles] }, control);
    const candidatesForTarget = candidates.filter(candidate => [candidate.id, candidate.canonicalId,
        ...(candidate.aliases || [])].includes(conversationId));
    if (candidatesForTarget.length !== 1) throw new Error(`范围导出需要唯一的${source}来源，实际匹配${candidatesForTarget.length}个`);
    const projection = await provider.readFast(candidatesForTarget[0]!, { startRound, endRound,
        messageRoles: [...messageRoles] }, { ...control, messageRoles: [...messageRoles] });
    if (!projection.rounds) throw new Error("范围来源未提供canonical rounds，完整详情尚未就绪");
    if (projection.roundNumbering === "relative") throw new Error("所选来源仅有相对轮号，请沿原prepare任务的rangeRef导出");
    return projection;
}

export async function executeConversationSourceExport(request: ConversationSourceExportRequest,
    control: IsolatedSourceControl): Promise<ConversationExportResult> {
    const isCancelled = (): boolean => {
        if (control.deadlineAt !== undefined && Date.now() >= control.deadlineAt) {
            throw Object.assign(new Error("Conversation export deadline exceeded"), { code: "SOURCE_WORKER_DEADLINE" });
        }
        return Boolean(control.signal?.aborted || control.isCancelled?.());
    };
    if (request.kind === "progressive") {
        const { exportProgressiveReadyRange } = await import("./conversation-progressive-export.js");
        return exportProgressiveReadyRange(request.params);
    }
    const projection = await readScopedProjection(request, { ...control, isCancelled });
    if (projection) {
        const rounds = projection.rounds!;
        const fullSourceComplete = projection.fullSourceComplete ?? projection.complete;
        const sourceRangeVerified = projection.readableRangeVerified !== false;
        const partial = projection.partial === true || !fullSourceComplete || !sourceRangeVerified
            || projection.requestedRangeComplete !== true;
        return exportConversation({
            ...request.selection, conversationId: projection.conversation.canonicalId || projection.conversation.id,
            chainUsed: projection.conversation.source, rounds,
            totalSteps: rounds.reduce((maximum, round) => Math.max(maximum, round.endStep + 1), 0),
            totalStepsKnown: false, totalRounds: projection.totalRounds ?? rounds.length,
            totalRoundsKnown: projection.totalRounds !== undefined, isCancelled,
            sourceMetadata: { partial, mode: request.loadOptions.source || "auto", cacheReadPolicy: "verified",
                diagnostics: [...projection.warnings, `sourceRevision=${projection.revision}`,
                    `roundNumbering=${projection.roundNumbering || "absolute"}`,
                    `requestedRangeComplete=${projection.requestedRangeComplete === true}`,
                    `fullSourceComplete=${fullSourceComplete}`, `sourceRangeVerified=${sourceRangeVerified}`],
                isSubagent: Boolean(projection.conversation.isChildThread || projection.conversation.parentConversationId) },
        });
    }
    const loadOptions: ConversationLoadOptions = { ...request.loadOptions, isCancelled,
        sourceReadBudget: { ...request.loadOptions.sourceReadBudget, deadlineMs: control.deadlineAt, isCancelled },
        ...(request.selection.scope === "rounds" ? { includeRounds: false,
            roundRange: { startRound: request.selection.startRound, endRound: request.selection.endRound } } : {}),
    };
    let loaded = await loadConversationData(request.dataChain, request.conversationId, loadOptions);
    if (loadOptions.publishedCacheOnly && loaded && loaded.chainUsed !== "codex") {
        loaded = await loadConversationData(loaded.chainUsed, loaded.conversationId, { ...loadOptions, publishedCacheOnly: false });
    }
    if (!loaded) throw new Error(describeConversationCacheReadFailure(request.dataChain, request.conversationId, loadOptions));
    assertConversationStrictCacheState(loaded, "export", request.cacheRequest);
    if (loadOptions.cacheGeneration && loaded.cacheGeneration !== loadOptions.cacheGeneration) {
        throw new Error(`请求固定 cacheGeneration=${loadOptions.cacheGeneration}，实际 generation=${loaded.cacheGeneration || "unknown"}；请使用 source=cache 固定同代，或重新 fetch 后使用新的 generation`);
    }
    return exportConversation({
        ...request.selection, conversationId: loaded.conversationId, chainUsed: loaded.chainUsed,
        rounds: loaded.rounds, totalSteps: loaded.totalSteps, cacheKey: loaded.cacheKey,
        cacheGeneration: loaded.cacheGeneration, expandedChildren: loaded.codexData?.expandedChildren || [],
        childDiagnostics: loaded.codexData?.childDiagnostics || [], partialWarning: partialWarning(loaded),
        sourceMetadata: conversationExportSourceMetadata(loaded), isCancelled,
    });
}
