import type { ConversationAttachment } from "./conversation-attachments.js";
import type { CorpusSource } from "./conversation-corpus-sources.js";
import type { ConversationRound } from "./trajectory.js";

export type CorpusMessageRole = "user" | "assistant" | "tool" | "subagent";

export interface CorpusVerifiedIdentity {
    authority: "devin-sqlite";
    source: "windsurf";
    canonicalId: string;
    aliases: string[];
    evidence: string;
    sourceRevision: string;
}

export interface CorpusSourcePosition {
    path?: string;
    startByte?: number;
    endByte?: number;
    ordinal?: number;
    messageId?: string;
}

export interface CorpusMessage {
    id: string;
    round: number;
    role: CorpusMessageRole;
    text: string;
    timestamp?: string;
    position: CorpusSourcePosition;
    sourceThreadId?: string;
    authorKind?: "user" | "assistant" | "subagent" | "tool";
    attachments?: Array<Omit<ConversationAttachment, "dataUrl">>;
    mediaAttachments?: string[];
    annotations?: Array<{ selectedText: string; comment: string }>;
}

export interface CorpusConversation {
    id: string;
    title: string;
    workspace: string;
    updatedAt?: string;
    rolloutPath?: string;
    archived?: boolean;
    source: CorpusSource;
    canonicalId?: string;
    aliases?: string[];
    sourceKind?: string;
    sourceWarnings?: string[];
    parentConversationId?: string;
    rootConversationId?: string;
    isChildThread?: boolean;
    agentRole?: string;
    agentNickname?: string;
}

export interface CorpusProjection {
    conversation: CorpusConversation;
    revision: string;
    cacheGeneration?: string;
    messages: CorpusMessage[];
    complete: boolean;
    partial?: boolean;
    requestedRangeComplete?: boolean;
    warnings: string[];
    sourceBytes?: number;
    timings?: Record<string, number>;
    rounds?: ConversationRound[];
    roundNumbering?: "absolute" | "relative";
    totalRounds?: number;
    readableRangeVerified?: boolean;
    fullSourceComplete?: boolean;
    readableRange?: {
        kind: "relative";
        startRound: number;
        endRound: number;
        segments: Array<{ path: string; startOrdinal: number; endOrdinalExclusive: number; endByte: number; prefixSha256: string }>;
        missingHistoryBase?: { rolloutId: string; endOrdinalExclusive: number; endByte: number };
    };
}

export interface CorpusSearchExpression {
    term?: string;
    all?: CorpusSearchExpression[];
    any?: CorpusSearchExpression[];
    not?: CorpusSearchExpression;
}

export interface CorpusSearchRequest {
    dataChains?: CorpusSource[];
    sourceFailureMode?: "warn" | "fail";
    purpose?: "prepare";
    query?: string;
    allTerms?: string[];
    anyTerms?: string[];
    excludeTerms?: string[];
    expression?: CorpusSearchExpression;
    conversationIds?: string[];
    parentConversationId?: string;
    parentDataChain?: CorpusSource;
    threadMode?: "main" | "children" | "all";
    maxFiles?: number;
    maxBytes?: number;
    maxHits?: number;
    deadlineMs?: number;
    workspaces?: string[];
    workspaceMode?: "contains" | "exact" | "under" | "any" | "all";
    messageRoles?: CorpusMessageRole[];
    intersectionScope?: "conversation" | "round" | "message";
    sort?: "latest_match" | "activity" | "occurrences" | "messages";
    caseSensitive?: boolean;
    forceRefresh?: boolean;
}

export interface CorpusReadControl {
    allowPartialSource?: boolean;
    deadlineAt?: number;
    messageRoles?: CorpusMessageRole[];
    forceRefresh?: boolean;
    isCancelled?: () => boolean;
    onProgress?: (progress: { phase: string; bytes?: number; totalBytes?: number }) => void;
    onChunk?: (chunk: CorpusProjectionChunk) => void | Promise<void>;
}

export interface CorpusProjectionChunk {
    conversation: CorpusConversation;
    revision: string;
    messages: CorpusMessage[];
    warnings: string[];
    sourceBytes?: number;
    replaceFromRound?: number;
    verified?: boolean;
    rounds?: ConversationRound[];
    roundNumbering?: "absolute" | "relative";
}

export interface CorpusProvider {
    semanticVersion?: string;
    sourceStatuses?: () => CorpusSourceStatus[];
    list(request: CorpusSearchRequest, control: CorpusReadControl): Promise<CorpusConversation[]>;
    readCached?(conversation: CorpusConversation, control: CorpusReadControl): Promise<CorpusProjection | null>;
    read(conversation: CorpusConversation, control: CorpusReadControl): Promise<CorpusProjection>;
}

export interface CorpusSourceStatus {
    source: CorpusSource;
    status: "ok" | "partial" | "error";
    candidateCount: number;
    warnings: string[];
    error?: string;
}

export interface CorpusRoundReadRequest {
    messageRoles?: CorpusMessageRole[];
    startRound?: number;
    endRound?: number;
    lastRounds?: number;
    revision: string;
}

export type CorpusFastReadRequest = Omit<CorpusRoundReadRequest, "revision">;

export interface CorpusRangeProvider extends CorpusProvider {
    readRounds(conversation: CorpusConversation, request: CorpusRoundReadRequest, control?: CorpusReadControl): Promise<CorpusProjection>;
    readFast(conversation: CorpusConversation, request: CorpusFastReadRequest, control?: CorpusReadControl): Promise<CorpusProjection>;
}
