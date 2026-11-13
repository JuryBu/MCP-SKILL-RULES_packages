import type { CorpusConversation, CorpusMessage, CorpusMessageRole, CorpusSearchExpression } from "../conversation-corpus-types.js";
import { formatCorpusReadProjection } from "../conversation-corpus-output.js";
import type { Depth, ExtraType } from "../trajectory.js";
import type { ConversationLinkMode } from "../chain.js";
import { normalizeProgressiveProjection, type ProgressiveRequest } from "../conversation-progressive-task-types.js";
import { availableProgressiveRoles } from "../conversation-progressive-projection.js";
import type { ProgressiveSource } from "../conversation-progressive-types.js";
import { selectedProgressiveStatus } from "../conversation-progressive-presentation.js";
import { isRequestHeadingAttachment } from "../conversation-attachments.js";
import { normalizeCodexCorpusConversationId } from "../conversation-corpus-search.js";
import { getCodexThreadMetadataByIdAsync } from "../codex-client.js";
import { resolveCorpusSources } from "../conversation-corpus-sources.js";
import type { ProgressiveSelection, ProgressiveReadResult } from "../conversation-progressive-types.js";
import {
    cancelProgressivePreparation, getProgressiveTaskStatus, openProgressiveTaskCache,
    resumeProgressivePreparation, startProgressivePreparation,
} from "../conversation-progressive-task.js";

export interface ProgressiveToolParams {
    action: string;
    conversationId?: string;
    conversationIds?: string[];
    taskId?: string;
    progressiveTaskId?: string;
    buildOrder?: "latest" | "oldest";
    blockId?: string;
    rangeRef?: string;
    lastRounds?: number;
    startRound?: number;
    endRound?: number;
    prepareCache?: boolean;
    waitSeconds?: number;
    afterProgressRevision?: string;
    query?: string;
    maxHits?: number;
    allTerms?: string[];
    anyTerms?: string[];
    excludeTerms?: string[];
    searchExpression?: CorpusSearchExpression;
    intersectionScope?: "conversation" | "round" | "message";
    searchSort?: "latest_match" | "activity" | "occurrences" | "messages";
    caseSensitive?: boolean;
    messageRoles?: string[];
    dataChain?: string;
    dataChains?: string[];
    chain?: string;
    depth?: string;
    extraTypes?: string[];
    link?: ConversationLinkMode;
    deadlineMs?: number;
    fullFetchCache?: boolean;
    forceRawCacheRebuild?: boolean;
}

export function isProgressiveAction(params: ProgressiveToolParams): boolean {
    return ["prepare", "prepare_status", "prepare_cancel", "prepare_resume", "read_ready", "search_ready", "locate_ready", "extract_ready"].includes(params.action)
        || (Boolean(params.progressiveTaskId) && ["read", "search"].includes(params.action));
}

function roles(params: ProgressiveToolParams): CorpusMessageRole[] {
    const selection = normalizeProgressiveProjection(params.messageRoles, params.depth).messageRoles;
    if (params.messageRoles === undefined && params.extraTypes?.some(type => type !== "thinking") && !selection.includes("tool")) selection.push("tool");
    return selection;
}

export function progressiveReadRoles(params: ProgressiveToolParams, available: readonly CorpusMessageRole[]): CorpusMessageRole[] {
    return params.messageRoles === undefined ? [...available] : roles(params);
}

export function formatProgressiveReadRows(result: Pick<ProgressiveReadResult, "rows" | "messages" | "status">, params: ProgressiveToolParams, selectedRoles = roles(params)) {
    const source = result.status.source;
    const presentedMessages = result.messages.map(message => message.attachments
        ? { ...message, attachments: message.attachments.filter(attachment => !isRequestHeadingAttachment(attachment)) } : message);
    const userOnly = selectedRoles.length === 1 && selectedRoles[0] === "user";
    const formatted = formatCorpusReadProjection({
        conversation: source.conversation || { source: source.host as CorpusConversation["source"], id: source.conversationId, title: "", workspace: "" },
        revision: source.revision, complete: result.status.complete, warnings: [],
        messages: presentedMessages, rounds: result.rows.map(item => item.round),
    }, {
        depth: params.depth as Depth | undefined, messageRoles: selectedRoles,
        extraTypes: userOnly ? [] : params.extraTypes as ExtraType[] | undefined,
    }) as { messages: CorpusMessage[]; rounds: Array<Record<string, unknown>> };
    const showToolSummary = params.depth !== "full" && selectedRoles.some(role => role === "assistant" || role === "tool" || role === "subagent");
    const rounds = result.rows.map((item, index) => {
        const counts = new Map<string, number>();
        if (showToolSummary) {
            if (!item.round.toolCalls.length && item.round.toolSummary) for (const tool of item.round.toolSummary) counts.set(tool.name, tool.count);
            const names = item.round.toolCalls.length ? item.round.toolCalls.map(tool => tool.name)
                : item.round.toolSummary ? []
                : result.messages.filter(message => message.round === item.round.roundIndex && message.role === "tool").map(message => message.text.split("\n", 1)[0]!);
            for (const name of names) if (name) counts.set(name, (counts.get(name) || 0) + 1);
        }
        const details = formatted.rounds[index];
        const visibleMessages = presentedMessages.filter(message => message.round === item.round.roundIndex && selectedRoles.includes(message.role));
        const visibleSteps = new Set(visibleMessages.flatMap(message => [message.position?.ordinal,
            ...(message.attachments || []).map(attachment => attachment.stepIndex)]).filter((step): step is number => typeof step === "number"));
        const visibleReferences = new Set(visibleMessages.flatMap(message => [...(message.mediaAttachments || []),
            ...(message.attachments || []).flatMap(attachment => [attachment.reference, attachment.originalPath, attachment.tempPath].filter((value): value is string => Boolean(value)))]).map(value => value.replace(/\\/gu, "/")));
        const attachments = (item.round.attachments || visibleMessages.flatMap(message => message.attachments || [])).filter(attachment => !isRequestHeadingAttachment(attachment)).filter(attachment => typeof attachment.stepIndex === "number"
            ? visibleSteps.has(attachment.stepIndex)
            : [attachment.reference, attachment.originalPath, attachment.tempPath].some(value => typeof value === "string" && visibleReferences.has(value.replace(/\\/gu, "/"))));
        const mediaAttachments = item.round.mediaAttachments.filter(value => visibleReferences.has(value.replace(/\\/gu, "/")));
        return { ...details, ...(attachments ? { attachments } : {}), ...(mediaAttachments ? { mediaAttachments } : {}), ...(userOnly ? { compactionSummaries: undefined } : {}),
            ref: item.ref, blockId: item.blockId, round: item.round.roundIndex, roundNumbering: item.kind,
            ...(showToolSummary ? { toolSummary: [...counts].map(([name, count]) => ({ name, count })),
                toolSummaryAvailable: item.round.toolSummary !== undefined || availableProgressiveRoles(source).includes("tool") || counts.size > 0 } : {}) };
    });
    return { rounds, messages: formatted.messages };
}

function verifiedSourceRange(source: ProgressiveSource): boolean {
    return (source.snapshot as { source?: { sourceRangeVerified?: boolean } })?.source?.sourceRangeVerified !== false;
}

function withAvailableRoles(value: unknown): unknown {
    const status = value as { request?: ProgressiveRequest; ready?: { source: ProgressiveSource }; next?: { action?: string } };
    const projection = normalizeProgressiveProjection(status.request?.messageRoles, status.request?.depth);
    const availableMessageRoles = status.ready?.source ? availableProgressiveRoles(status.ready.source) : undefined;
    return { ...status, requestedMessageRoles: projection.messageRoles, availableMessageRoles,
        messageRolesVerified: availableMessageRoles !== undefined,
        next: status.next?.action === "read_ready" && availableMessageRoles
            ? { ...status.next, messageRoles: availableMessageRoles, depth: projection.depth } : status.next,
        preparedDepth: projection.depth };
}

export async function runProgressiveAction(params: ProgressiveToolParams): Promise<unknown> {
    const ownerId = params.conversationId?.trim();
    if (!ownerId) throw new Error("Progressive operations require conversationId for the caller");
    if (params.action === "prepare" || params.action === "read_fast") {
        if (params.action === "prepare" && (params.startRound !== undefined || params.endRound !== undefined)) throw new Error("prepare按lastRounds与buildOrder准备近期或早期范围；指定绝对startRound/endRound请用read_fast，同样可返回后续缓存准备入口");
        const sources = resolveCorpusSources(params);
        if (sources.length !== 1) throw new Error("prepare/read_fast一次准备一个来源的一个对话，请给具体dataChain");
        const dataChain = sources[0]!;
        if (params.conversationIds && params.conversationIds.length !== 1) throw new Error("Preparation accepts exactly one target conversationIds entry");
        const target = params.conversationIds?.[0] || ownerId;
        const request = {
            ownerId, conversationId: dataChain === "codex" ? normalizeCodexCorpusConversationId(target) : target.trim(),
            direction: params.buildOrder || "latest", initialRounds: params.lastRounds ?? 100,
            buildFull: params.prepareCache !== false, dataChain, link: params.link || "reference", deadlineMs: params.deadlineMs,
            messageRolesExplicit: params.messageRoles !== undefined,
            ...(params.fullFetchCache ? { fullFetchCache: true, forceRawCacheRebuild: params.forceRawCacheRebuild === true } : {}),
            ...normalizeProgressiveProjection(params.messageRoles, params.depth),
        };
        const started = await startProgressivePreparation(request) as { taskId: string };
        const status = await getProgressiveTaskStatus({ ownerId, taskId: started.taskId,
            waitMs: Math.min(45000, Math.max(0, (params.waitSeconds ?? (params.action === "read_fast" ? 1 : 0)) * 1000)) });
        const readySource = (status as { ready?: { source?: ProgressiveSource } }).ready?.source;
        const effectiveRoles = params.messageRoles === undefined && readySource?.conversation?.isChildThread
            ? availableProgressiveRoles(readySource) : request.messageRoles;
        return { ...(withAvailableRoles(status) as object), next: (status as { rangeAvailable?: boolean }).rangeAvailable ? {
            status: { action: "prepare_status", conversationId: ownerId, dataChain, taskId: started.taskId, waitSeconds: 30,
                afterProgressRevision: (status as { revision?: string }).revision },
            read: { ...(status as { next?: object }).next, action: "read_ready", conversationId: ownerId, dataChain, taskId: started.taskId, lastRounds: request.initialRounds,
                ...(request.direction === "oldest" ? { buildOrder: "oldest" } : {}), messageRoles: effectiveRoles, depth: request.depth },
            search: { action: "search_ready", conversationId: ownerId, dataChain, taskId: started.taskId, query: "<word>", messageRoles: effectiveRoles, depth: request.depth },
        } : (status as { next?: unknown }).next };
    }
    const taskId = params.progressiveTaskId || params.taskId;
    if (!taskId) throw new Error("Use the original progressive taskId");
    const identity = { ownerId, taskId };
    let preparation: { request: ProgressiveRequest; rangeAvailable?: boolean } | undefined;
    if (params.dataChain !== undefined || params.dataChains !== undefined || (params.chain !== undefined && params.chain !== "auto")) {
        const sources = resolveCorpusSources(params);
        preparation = await getProgressiveTaskStatus({ ...identity, waitMs: 0 }) as { request: ProgressiveRequest; rangeAvailable?: boolean };
        if (sources.length !== 1 || sources[0] !== preparation.request.dataChain) throw new Error("请求来源与原渐进taskId不同，请沿用原任务的dataChain");
    }
    if (params.action === "prepare_status") return withAvailableRoles(await getProgressiveTaskStatus({ ...identity, afterRevision: params.afterProgressRevision,
        waitMs: Math.min(45000, Math.max(0, (params.waitSeconds || 0) * 1000)) }));
    if (params.action === "prepare_cancel") return cancelProgressivePreparation(identity);
    if (params.action === "prepare_resume") return resumeProgressivePreparation({ ...identity, deadlineMs: params.deadlineMs });
    preparation ??= await getProgressiveTaskStatus({ ...identity, waitMs: 0 }) as { request: ProgressiveRequest; rangeAvailable?: boolean };
    if (!preparation.rangeAvailable && !params.rangeRef) return withAvailableRoles(preparation);
    const { cache, ready, row } = await openProgressiveTaskCache(identity, params.rangeRef);
    const status = await cache.status();
    const availableMessageRoles = availableProgressiveRoles(status.source);
    const selectedRoles = progressiveReadRoles(params, availableMessageRoles);
    if ((params.depth === "full" || params.extraTypes?.length) && preparation.request.depth !== "full") {
        const selectedBlock = params.blockId ? status.blocks.find(block => block.blockId === params.blockId) : undefined;
        const relativeSelection = row?.kind === "relative" || selectedBlock?.coverage.kind === "relative"
            || (!params.blockId && (params.startRound !== undefined || params.endRound !== undefined)
                && status.completeRanges.some(range => range.kind === "relative"));
        const absoluteStart = relativeSelection ? undefined : row?.kind === "absolute" ? row.round.roundIndex : params.startRound;
        const absoluteEnd = relativeSelection ? undefined : row?.kind === "absolute" ? row.round.roundIndex : params.endRound;
        const next = absoluteStart !== undefined || absoluteEnd !== undefined
            ? { action: "read_fast", conversationId: ownerId, conversationIds: [preparation.request.conversationId],
                dataChain: preparation.request.dataChain, startRound: absoluteStart, endRound: absoluteEnd,
                depth: "full", messageRoles: selectedRoles, extraTypes: params.extraTypes, prepareCache: false }
            : { action: "prepare", conversationId: ownerId, conversationIds: [preparation.request.conversationId],
                dataChain: preparation.request.dataChain, lastRounds: params.lastRounds ?? preparation.request.initialRounds,
                buildOrder: params.buildOrder || preparation.request.direction, depth: "full", messageRoles: selectedRoles, prepareCache: false };
        return { taskId, status: "needs_preparation", phase: "details-not-prepared", rangeAvailable: true,
            preparedDepth: preparation.request.depth || "normal", requestedDepth: "full",
            detail: "已有正文仍可读取；完整思考和工具详情需要补充准备，请按下一步参数继续。原任务和固定引用保留。",
            ...(relativeSelection ? { requestedSelection: { originalRangeRef: params.rangeRef, blockId: params.blockId,
                startRound: params.startRound, endRound: params.endRound, relativeRound: row?.round.roundIndex,
                detail: "这是原窗口中的相对轮次；补充准备后按新窗口的覆盖信息选择详情，原引用继续指向原正文。" } } : {}),
            next };
    }
    const missingRoles = selectedRoles.filter(role => !availableMessageRoles.includes(role));
    if (missingRoles.length) throw new Error("Requested message roles were not prepared: " + missingRoles.join(", ") + ". Available message roles: " + availableMessageRoles.join(", ")
        + ". Next call: " + JSON.stringify(status.source.conversation?.isChildThread
            ? { action: "read_ready", conversationId: ownerId, taskId, dataChain: status.source.host,
                lastRounds: params.lastRounds ?? 5, messageRoles: availableMessageRoles, depth: preparation.request.depth || "normal" }
            : { action: "prepare", conversationId: ownerId, conversationIds: [status.source.conversationId],
                lastRounds: params.lastRounds ?? 5, prepareCache: false, dataChain: status.source.host, messageRoles: selectedRoles, depth: params.depth || "normal" }));
    if (params.action === "locate_ready") {
        if (!params.rangeRef || !row) throw new Error("locate_ready requires a previously returned rangeRef");
        return { taskId, source: status.source, availableMessageRoles, ref: row.ref, blockId: row.blockId,
            publishedRangeComplete: true, sourceRangeVerified: verifiedSourceRange(status.source),
            requestedRangeComplete: verifiedSourceRange(status.source), warnings: ready.warnings,
            round: row.round.roundIndex, roundNumbering: row.kind, messages: row.messages.filter(message => selectedRoles.includes(message.role)) };
    }
    const preferredBlockIds = !params.blockId && !row
        ? ready.preferredBlockIds?.filter(blockId => status.blocks.some(block => block.blockId === blockId)) : undefined;
    const selection: ProgressiveSelection = { blockId: params.blockId, startRound: params.startRound, endRound: params.endRound, direction: "oldest",
        ...(preferredBlockIds?.length ? { blockIds: preferredBlockIds } : {}) };
    if ((params.startRound !== undefined || params.endRound !== undefined) && !params.blockId
        && status.completeRanges.some(range => range.kind === "relative")) {
        throw new Error("Accurate global round numbers are still being prepared; use the returned blockId with local bounds, or rangeRef");
    }
    if (params.action === "search_ready" || params.action === "search") {
        const result = await cache.search({
            query: params.query, allTerms: params.allTerms, anyTerms: params.anyTerms, excludeTerms: params.excludeTerms,
            expression: params.searchExpression, intersectionScope: params.intersectionScope, sort: params.searchSort,
            caseSensitive: params.caseSensitive, messageRoles: selectedRoles, maxHits: params.maxHits,
        }, selection);
        const sourceRangeVerified = verifiedSourceRange(result.status.source);
        const originRevision = (result.status.source.snapshot as { source?: { revision?: string } })?.source?.revision;
        const cacheRevision = result.status.source.revision;
        const sourceRevision = originRevision;
        const referenceCall = (rangeRef: string) => ({ action: "read_ready", conversationId: ownerId,
            dataChain: preparation!.request.dataChain, taskId, rangeRef, messageRoles: selectedRoles, depth: params.depth || "normal" });
        return { taskId, phase: ready.phase, availableMessageRoles, ...result, status: selectedProgressiveStatus(result.status, selection.blockIds),
            cacheRevision, originRevision,
            match: result.match ? { ...result.match, sourceRevision,
                snippets: result.match.snippets.map(snippet => ({ ...snippet, sourceRevision })) } : null,
            hits: result.hits.map(hit => ({ ...hit, next: referenceCall(hit.ref) })),
            publishedRangeComplete: result.requestedRangeComplete, sourceRangeVerified,
            requestedRangeComplete: result.requestedRangeComplete && sourceRangeVerified,
            provisional: result.provisional || !sourceRangeVerified, warnings: ready.warnings };
    }
    if (params.lastRounds !== undefined && (params.startRound !== undefined || params.endRound !== undefined)) throw new Error("lastRounds and explicit round bounds are mutually exclusive");
    let result: ProgressiveReadResult;
    if (row) result = { rows: [row], rounds: [row.round], messages: row.messages, status, requestedRangeComplete: true };
    else if (params.lastRounds !== undefined || (params.startRound === undefined && params.endRound === undefined)) {
        const amount = params.lastRounds ?? preparation.request.initialRounds;
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000) throw new Error("lastRounds must be a positive bounded integer");
        if ((params.buildOrder || preparation.request.direction) === "oldest") {
            let initialBlocks = status.blocks.filter(block => selection.blockId ? block.blockId === selection.blockId
                : !ready.preferredBlockIds?.length || ready.preferredBlockIds.includes(block.blockId));
            if (!initialBlocks.length && !selection.blockId) initialBlocks = status.blocks.filter(block => block.coverage.kind === "absolute");
            if (!initialBlocks.length) throw new Error("The initial oldest range is unavailable in this cache generation; use its original rangeRef");
            const startRound = Math.min(...initialBlocks.map(block => block.coverage.startRound));
            const earliest = await cache.read({ ...selection, blockIds: initialBlocks.map(block => block.blockId),
                startRound, endRound: startRound + amount - 1, direction: "oldest" });
            const expectedRounds = status.complete && status.source.totalRounds !== undefined
                ? Math.min(amount, Math.max(0, status.source.totalRounds - startRound + 1)) : amount;
            result = { ...earliest, requestedRangeComplete: earliest.rows.length === expectedRounds };
        } else {
            const latest = await cache.readLatest({ ...selection, direction: "latest",
                ...(selection.blockIds ? { blockIds: [...selection.blockIds].reverse() } : {}) }, amount);
            const rows = latest.rows.slice().reverse();
            result = { ...latest, rows, rounds: rows.map(item => item.round), messages: rows.flatMap(item => item.messages),
                requestedRangeComplete: latest.requestedRangeComplete || latest.status.complete };
        }
    } else result = await cache.read(selection);
    result = { ...result, status: selectedProgressiveStatus(result.status, selection.blockIds) };
    const { messages, rounds } = formatProgressiveReadRows(result, params, selectedRoles);
    const sourceRangeVerified = verifiedSourceRange(result.status.source);
    let conversation = result.status.source.conversation;
    if (result.status.source.host === "codex" && !conversation?.title) {
        const thread = await getCodexThreadMetadataByIdAsync(result.status.source.conversationId).catch(() => null);
        if (thread) conversation = { ...conversation, id: thread.id, source: "codex", title: thread.title || thread.id,
            workspace: conversation?.workspace || thread.cwd || "" };
    }
    return {
        taskId, phase: ready.phase, requestedRangeComplete: result.requestedRangeComplete && sourceRangeVerified,
        publishedRangeComplete: result.requestedRangeComplete, sourceRangeVerified,
        fullSourceComplete: result.status.complete, coverage: result.status.completeRanges,
        source: result.status.source, ...(conversation ? { conversation } : {}), availableMessageRoles,
        rounds,
        messages, ...(params.action === "extract_ready" ? { text: messages.map(message => "[" + message.role + "] " + message.text).join("\n\n") } : {}),
        warnings: ready.warnings,
    };
}

