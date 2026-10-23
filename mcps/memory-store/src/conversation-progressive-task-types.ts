import type { ProgressiveSource } from "./conversation-progressive-types.js";
import type { ConversationLinkMode } from "./chain.js";
import type { CorpusMessageRole } from "./conversation-corpus-types.js";
import type { Depth } from "./trajectory.js";

export const PROGRESSIVE_MESSAGE_ROLES: readonly CorpusMessageRole[] = ["user", "assistant", "tool", "subagent"];

export function normalizeProgressiveProjection(messageRoles?: readonly string[], depth: string = "normal"): { messageRoles: CorpusMessageRole[]; depth: Depth } {
    if (!["brief", "normal", "full"].includes(depth)) throw new Error("Invalid progressive depth; use brief, normal or full");
    if (messageRoles !== undefined && (!Array.isArray(messageRoles) || !messageRoles.length || messageRoles.some(role => ![...PROGRESSIVE_MESSAGE_ROLES, "model"].includes(role)))) {
        throw new Error("Progressive messageRoles must contain user/assistant/model/tool/subagent; use the legacy full-cache read for system views");
    }
    const selected = messageRoles?.map(role => role === "model" ? "assistant" : role)
        ?? (depth === "full" ? PROGRESSIVE_MESSAGE_ROLES : ["user", "assistant"]);
    return { messageRoles: PROGRESSIVE_MESSAGE_ROLES.filter(role => selected.includes(role)), depth: depth as Depth };
}

export interface ProgressiveRequest {
    ownerId: string;
    conversationId: string;
    direction: "latest" | "oldest";
    initialRounds: number;
    buildFull: boolean;
    dataChain: "codex";
    link?: ConversationLinkMode;
    messageRoles?: CorpusMessageRole[];
    depth?: Depth;
}

export interface ProgressiveTaskPayload {
    version: 1;
    taskId: string;
    directory: string;
    request: ProgressiveRequest;
}

export interface ProgressiveReadyGeneration {
    directory: string;
    source: ProgressiveSource;
}

export interface ProgressiveReadyState {
    version: 1;
    phase: string;
    current?: ProgressiveReadyGeneration;
    preferredBlockIds?: string[];
    previous: ProgressiveReadyGeneration[];
    requestedRangeComplete: boolean;
    fullCacheGeneration?: string;
    updatedAt: string;
    warnings: string[];
}

export function isProgressiveRequest(value: unknown): value is ProgressiveRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as ProgressiveRequest;
    return typeof request.ownerId === "string" && Boolean(request.ownerId.trim()) && request.ownerId.length <= 4096
        && typeof request.conversationId === "string" && Boolean(request.conversationId.trim()) && request.conversationId.length <= 4096
        && request.dataChain === "codex"
        && (request.link === undefined || ["reference", "summary", "expand_children"].includes(request.link))
        && (request.depth === undefined || ["brief", "normal", "full"].includes(request.depth))
        && (request.messageRoles === undefined || (Array.isArray(request.messageRoles)
            && request.messageRoles.length > 0 && request.messageRoles.length <= PROGRESSIVE_MESSAGE_ROLES.length
            && new Set(request.messageRoles).size === request.messageRoles.length
            && request.messageRoles.every(role => PROGRESSIVE_MESSAGE_ROLES.includes(role))))
        && ["latest", "oldest"].includes(request.direction)
        && Number.isSafeInteger(request.initialRounds)
        && request.initialRounds > 0 && request.initialRounds <= 100000
        && typeof request.buildFull === "boolean";
}

export function isProgressiveTaskPayload(value: unknown): value is ProgressiveTaskPayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as ProgressiveTaskPayload;
    return payload.version === 1 && /^progressive-[a-f0-9-]{36}$/.test(payload.taskId)
        && typeof payload.directory === "string" && Boolean(payload.directory)
        && isProgressiveRequest(payload.request);
}

