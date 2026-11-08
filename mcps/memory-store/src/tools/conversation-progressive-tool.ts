import type { CorpusMessageRole, CorpusSearchExpression } from "../conversation-corpus-types.js";
import type { ConversationLinkMode } from "../chain.js";
import { normalizeProgressiveProjection, type ProgressiveRequest } from "../conversation-progressive-task-types.js";
import { availableProgressiveRoles } from "../conversation-progressive-projection.js";
import type { ProgressiveSource } from "../conversation-progressive-types.js";
import { normalizeCodexCorpusConversationId } from "../conversation-corpus-search.js";
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
    return normalizeProgressiveProjection(params.messageRoles, params.depth).messageRoles;
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
            read: { action: "read_ready", conversationId: ownerId, dataChain, taskId: started.taskId, lastRounds: params.lastRounds ?? 5, messageRoles: effectiveRoles, depth: request.depth },
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
    const selectedRoles = params.messageRoles === undefined && status.source.conversation?.isChildThread
        ? availableMessageRoles.filter(role => role === "subagent" || (params.depth === "full" && role === "tool")) : roles(params);
    if ((params.depth === "full" || params.extraTypes?.length) && preparation.request.depth !== "full") {
        throw new Error("此任务按normal准备，尚无完整思考和工具详情。请用prepare、depth=full及所需messageRoles准备对应范围，再沿返回的taskId读取");
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
    const selection: ProgressiveSelection = { blockId: params.blockId, startRound: params.startRound, endRound: params.endRound, direction: "oldest" };
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
        return { taskId, phase: ready.phase, availableMessageRoles, ...result,
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
        const amount = params.lastRounds ?? 5;
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000) throw new Error("lastRounds must be a positive bounded integer");
        const latest = await cache.readLatest({ ...selection, direction: "latest" }, amount);
        const rows = latest.rows.slice().reverse();
        result = { ...latest, rows, rounds: rows.map(item => item.round), messages: rows.flatMap(item => item.messages),
            requestedRangeComplete: latest.requestedRangeComplete || latest.status.complete };
    } else result = await cache.read(selection);
    const messages = result.messages.filter(message => selectedRoles.includes(message.role));
    const sourceRangeVerified = verifiedSourceRange(result.status.source);
    return {
        taskId, phase: ready.phase, requestedRangeComplete: result.requestedRangeComplete && sourceRangeVerified,
        publishedRangeComplete: result.requestedRangeComplete, sourceRangeVerified,
        fullSourceComplete: result.status.complete, coverage: result.status.completeRanges,
        source: result.status.source, availableMessageRoles,
        rounds: result.rows.map(item => ({ ref: item.ref, blockId: item.blockId, round: item.round.roundIndex, roundNumbering: item.kind })),
        messages, ...(params.action === "extract_ready" ? { text: messages.map(message => "[" + message.role + "] " + message.text).join("\n\n") } : {}),
        warnings: ready.warnings,
    };
}

