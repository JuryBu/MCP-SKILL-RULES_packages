import { createHash } from "node:crypto";
import path from "node:path";
import { projectCodexCorpusRound, codexCorpusAttachmentReferences } from "./conversation-corpus-reader-projection.js";
import type { CorpusConversation, CorpusFastReadRequest, CorpusMessageRole, CorpusProjection, CorpusReadControl, CorpusSearchRequest } from "./conversation-corpus-types.js";
import type { ConversationRound } from "./trajectory.js";

export const HOST_CORPUS_VERSION = "host-corpus/v4";

export interface HostCorpusSnapshot {
    conversation?: CorpusConversation;
    rounds: ConversationRound[];
    revision: string;
    cacheGeneration?: string;
    partial?: boolean;
    warnings?: string[];
    sourceBytes?: number;
    timings?: Record<string, number>;
    totalRounds?: number;
    roundNumbering?: "absolute" | "relative";
    rangeComplete?: boolean;
    sourceComplete?: boolean;
}

export function hostCorpusDigest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertHostReadActive(control: CorpusReadControl = {}): void {
    if (!control.isCancelled?.()) return;
    const error = new Error("Host conversation read cancelled");
    error.name = "AbortError";
    throw error;
}

export function hostConversationMatches(conversation: CorpusConversation, request: CorpusSearchRequest): boolean {
    if (request.conversationIds?.length && !request.conversationIds.some(id => [conversation.id, conversation.canonicalId, ...(conversation.aliases || [])].includes(id))) return false;
    if (!request.workspaces?.length) return true;
    if (!conversation.workspace.trim()) return false;
    const normalize = (value: string) => path.resolve(value).replace(/\\/gu, "/").replace(/\/$/u, "").toLowerCase();
    const workspace = normalize(conversation.workspace || ".");
    const matches = request.workspaces.map(value => {
        const selected = normalize(value);
        return request.workspaceMode === "exact" ? workspace === selected
            : request.workspaceMode === "under" ? workspace === selected || workspace.startsWith(`${selected}/`)
                : workspace.includes(selected);
    });
    return request.workspaceMode === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

export function validateHostRange(request: CorpusFastReadRequest): void {
    for (const name of ["startRound", "endRound", "lastRounds"] as const) {
        const value = request[name];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
    }
    if (request.lastRounds !== undefined && (request.startRound !== undefined || request.endRound !== undefined)) throw new Error("Use lastRounds or startRound/endRound, not both");
    if (request.startRound !== undefined && request.endRound !== undefined && request.startRound > request.endRound) throw new Error("startRound must not exceed endRound");
}

export function projectHostCorpus(conversation: CorpusConversation, snapshot: HostCorpusSnapshot, request: CorpusFastReadRequest | undefined, control: CorpusReadControl): CorpusProjection {
    assertHostReadActive(control);
    const origin = snapshot.conversation || conversation;
    if (origin.source !== conversation.source) throw new Error("Host source changed while reading");
    if (snapshot.conversation && ![origin.id, origin.canonicalId, ...(origin.aliases || [])].some(id => id === (conversation.canonicalId || conversation.id) || id === conversation.id)) throw new Error("Host conversation identity changed without a verified alias");
    if (!snapshot.revision || /^pending(?:$|:)/u.test(snapshot.revision)) throw new Error("Host source has no verified revision");
    const roundNumbering = snapshot.roundNumbering || "absolute";
    const totalRounds = snapshot.totalRounds ?? (roundNumbering === "absolute" && snapshot.sourceComplete !== false ? snapshot.rounds.at(-1)?.roundIndex || 0 : undefined);
    const start = request?.lastRounds === undefined ? request?.startRound || 1
        : totalRounds === undefined ? Math.max(1, snapshot.rounds.length - request.lastRounds + 1) : Math.max(1, totalRounds - request.lastRounds + 1);
    const end = request?.lastRounds === undefined ? request?.endRound ?? totalRounds ?? Infinity : totalRounds ?? Infinity;
    const rounds = snapshot.rounds.filter(round => round.roundIndex >= start && round.roundIndex <= end).map(round => ({
        ...round, ...codexCorpusAttachmentReferences(round),
        userMessages: round.userMessages?.map(message => ({ ...message, ...codexCorpusAttachmentReferences(message) })),
        semanticEvents: round.semanticEvents?.map(event => ({ ...event, ...codexCorpusAttachmentReferences(event) })),
        subagentSummaries: round.subagentSummaries.map(child => ({ ...child, ...codexCorpusAttachmentReferences(child) })),
    }));
    const roles: CorpusMessageRole[] = control.messageRoles || ["user", "assistant"];
    const origins = origin.rolloutPath ? new Map([[origin.rolloutPath, { sourceThreadId: origin.canonicalId || origin.id, isChildThread: Boolean(origin.isChildThread) }]]) : undefined;
    const messages = rounds.flatMap(round => projectCodexCorpusRound(
        `${origin.source}:${origin.canonicalId || origin.id}`,
        { ...round, semanticEvents: round.semanticEvents?.map(event => event.semanticRole === "assistant" ? { ...event, semanticRole: "model" as const } : event) },
        new Map(), roles, origin.rolloutPath, origins,
    ).map(message => ({ ...message, sourceThreadId: origin.canonicalId || origin.id })));
    const actualStart = snapshot.rounds[0]?.roundIndex;
    const actualEnd = snapshot.rounds.at(-1)?.roundIndex;
    const inferredRangeComplete = roundNumbering === "absolute" && (totalRounds === 0
        ? start === 1 && request?.endRound === undefined
        : actualStart !== undefined && actualStart <= start && actualEnd !== undefined && actualEnd >= Math.min(end, totalRounds || 0) && start <= (totalRounds || 0));
    const expectedEnd = totalRounds === undefined ? request?.endRound : Math.min(end, totalRounds);
    const contiguous = roundNumbering !== "absolute" || expectedEnd === undefined || (rounds.length === Math.max(0, expectedEnd - start + 1) && rounds.every((round, index) => round.roundIndex === start + index));
    const rangeComplete = !snapshot.partial && contiguous && (snapshot.rangeComplete ?? inferredRangeComplete);
    return {
        conversation: origin,
        revision: hostCorpusDigest([HOST_CORPUS_VERSION, origin.source, origin.canonicalId || origin.id, snapshot.revision]),
        cacheGeneration: snapshot.cacheGeneration,
        messages,
        rounds,
        roundNumbering,
        totalRounds,
        complete: snapshot.sourceComplete !== false && !snapshot.partial && roundNumbering === "absolute" && (totalRounds === 0 || (start === 1 && end >= (totalRounds || Infinity))) && rangeComplete,
        requestedRangeComplete: rangeComplete,
        warnings: [...new Set([...(origin.sourceWarnings || []), ...(snapshot.warnings || []), ...(snapshot.partial ? ["host_source_partial"] : [])])],
        sourceBytes: snapshot.sourceBytes,
        timings: snapshot.timings,
    };
}
