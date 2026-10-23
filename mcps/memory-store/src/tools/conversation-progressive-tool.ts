import type { CorpusMessageRole, CorpusSearchExpression } from "../conversation-corpus-types.js";
import type { ConversationLinkMode } from "../chain.js";
import { normalizeProgressiveProjection, type ProgressiveRequest } from "../conversation-progressive-task-types.js";
import { availableProgressiveRoles } from "../conversation-progressive-projection.js";
import type { ProgressiveSource } from "../conversation-progressive-types.js";
import { normalizeCodexCorpusConversationId } from "../conversation-corpus-search.js";
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
    allTerms?: string[];
    anyTerms?: string[];
    excludeTerms?: string[];
    searchExpression?: CorpusSearchExpression;
    intersectionScope?: "conversation" | "round" | "message";
    searchSort?: "latest_match" | "activity" | "occurrences" | "messages";
    caseSensitive?: boolean;
    messageRoles?: string[];
    dataChain?: string;
    depth?: string;
    link?: ConversationLinkMode;
}

export function isProgressiveAction(params: ProgressiveToolParams): boolean {
    return ["prepare", "prepare_status", "prepare_cancel", "prepare_resume", "read_ready", "search_ready", "locate_ready", "extract_ready"].includes(params.action)
        || (Boolean(params.progressiveTaskId) && ["read", "search"].includes(params.action));
}

function roles(params: ProgressiveToolParams): CorpusMessageRole[] {
    return normalizeProgressiveProjection(params.messageRoles, params.depth).messageRoles;
}

function withAvailableRoles(value: unknown): unknown {
    const status = value as { request?: ProgressiveRequest; ready?: { source: ProgressiveSource } };
    const projection = normalizeProgressiveProjection(status.request?.messageRoles, status.request?.depth);
    return { ...status, availableMessageRoles: status.ready?.source ? availableProgressiveRoles(status.ready.source) : projection.messageRoles,
        preparedDepth: projection.depth };
}

export async function runProgressiveAction(params: ProgressiveToolParams): Promise<unknown> {
    const ownerId = params.conversationId?.trim();
    if (!ownerId) throw new Error("Progressive operations require conversationId for the caller");
    if (params.dataChain && !["codex", "auto"].includes(params.dataChain)) throw new Error("Progressive raw preparation currently uses Codex; other hosts retain their verified original entry");
    if (params.action === "prepare" || params.action === "read_fast") {
        if (params.conversationIds && params.conversationIds.length !== 1) throw new Error("Preparation accepts exactly one target conversationIds entry");
        const request = {
            ownerId, conversationId: normalizeCodexCorpusConversationId(params.conversationIds?.[0] || ownerId),
            direction: params.buildOrder || "latest", initialRounds: params.lastRounds ?? 100,
            buildFull: params.prepareCache !== false, dataChain: "codex" as const, link: params.link || "reference",
            ...normalizeProgressiveProjection(params.messageRoles, params.depth),
        };
        const started = await startProgressivePreparation(request) as { taskId: string };
        const status = await getProgressiveTaskStatus({ ownerId, taskId: started.taskId,
            waitMs: Math.min(45000, Math.max(0, (params.waitSeconds ?? (params.action === "read_fast" ? 1 : 0)) * 1000)) });
        return { ...(withAvailableRoles(status) as object), next: {
            status: { action: "prepare_status", conversationId: ownerId, taskId: started.taskId, waitSeconds: 30,
                afterProgressRevision: (status as { revision?: string }).revision },
            read: { action: "read_ready", conversationId: ownerId, taskId: started.taskId, lastRounds: params.lastRounds ?? 5, messageRoles: request.messageRoles, depth: request.depth },
            search: { action: "search_ready", conversationId: ownerId, taskId: started.taskId, query: "<word>", messageRoles: request.messageRoles, depth: request.depth },
        } };
    }
    const taskId = params.progressiveTaskId || params.taskId;
    if (!taskId) throw new Error("Use the original progressive taskId");
    const identity = { ownerId, taskId };
    if (params.action === "prepare_status") return withAvailableRoles(await getProgressiveTaskStatus({ ...identity, afterRevision: params.afterProgressRevision,
        waitMs: Math.min(45000, Math.max(0, (params.waitSeconds || 0) * 1000)) }));
    if (params.action === "prepare_cancel") return cancelProgressivePreparation(identity);
    if (params.action === "prepare_resume") return resumeProgressivePreparation(identity);
    const { cache, ready, row } = await openProgressiveTaskCache(identity, params.rangeRef);
    const selectedRoles = roles(params);
    const status = await cache.status();
    const availableMessageRoles = availableProgressiveRoles(status.source);
    const missingRoles = selectedRoles.filter(role => !availableMessageRoles.includes(role));
    if (missingRoles.length) throw new Error("Requested message roles were not prepared: " + missingRoles.join(", ") + ". Available message roles: " + availableMessageRoles.join(", ")
        + ". Next call: " + JSON.stringify({ action: "prepare", conversationId: ownerId, conversationIds: [status.source.conversationId],
            lastRounds: params.lastRounds ?? 5, prepareCache: false, dataChain: "codex", messageRoles: selectedRoles, depth: params.depth || "normal" }));
    if (params.action === "locate_ready") {
        if (!params.rangeRef || !row) throw new Error("locate_ready requires a previously returned rangeRef");
        return { taskId, source: status.source, availableMessageRoles, ref: row.ref, blockId: row.blockId,
            round: row.round.roundIndex, roundNumbering: row.kind, messages: row.messages.filter(message => selectedRoles.includes(message.role)) };
    }
    const selection: ProgressiveSelection = { blockId: params.blockId, startRound: params.startRound, endRound: params.endRound, direction: "oldest" };
    if ((params.startRound !== undefined || params.endRound !== undefined) && !params.blockId
        && status.completeRanges.some(range => range.kind === "relative")) {
        throw new Error("Accurate global round numbers are still being prepared; use the returned blockId with local bounds, or rangeRef");
    }
    if (params.action === "search_ready" || params.action === "search") {
        return { taskId, phase: ready.phase, availableMessageRoles, ...(await cache.search({
            query: params.query, allTerms: params.allTerms, anyTerms: params.anyTerms, excludeTerms: params.excludeTerms,
            expression: params.searchExpression, intersectionScope: params.intersectionScope, sort: params.searchSort,
            caseSensitive: params.caseSensitive, messageRoles: selectedRoles,
        }, selection)) };
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
    return {
        taskId, phase: ready.phase, requestedRangeComplete: result.requestedRangeComplete,
        fullSourceComplete: result.status.complete, coverage: result.status.completeRanges,
        source: result.status.source, availableMessageRoles,
        rounds: result.rows.map(item => ({ ref: item.ref, blockId: item.blockId, round: item.round.roundIndex, roundNumbering: item.kind })),
        messages, ...(params.action === "extract_ready" ? { text: messages.map(message => "[" + message.role + "] " + message.text).join("\n\n") } : {}),
        warnings: ready.warnings,
    };
}

