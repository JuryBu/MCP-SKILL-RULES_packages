import type { ConversationAttachment } from "./conversation-attachments.js";

export type CorpusMessageRole = "user" | "assistant" | "tool" | "subagent";

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
    source: "codex";
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
    requestedRangeComplete?: boolean;
    warnings: string[];
    sourceBytes?: number;
    timings?: Record<string, number>;
}

export interface CorpusSearchExpression {
    term?: string;
    all?: CorpusSearchExpression[];
    any?: CorpusSearchExpression[];
    not?: CorpusSearchExpression;
}

export interface CorpusSearchRequest {
    purpose?: "prepare";
    query?: string;
    allTerms?: string[];
    anyTerms?: string[];
    excludeTerms?: string[];
    expression?: CorpusSearchExpression;
    conversationIds?: string[];
    workspaces?: string[];
    workspaceMode?: "contains" | "exact" | "under" | "any" | "all";
    messageRoles?: CorpusMessageRole[];
    intersectionScope?: "conversation" | "round" | "message";
    sort?: "latest_match" | "activity" | "occurrences" | "messages";
    caseSensitive?: boolean;
    forceRefresh?: boolean;
}

export interface CorpusReadControl {
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
}

export interface CorpusProvider {
    semanticVersion?: string;
    list(request: CorpusSearchRequest, control: CorpusReadControl): Promise<CorpusConversation[]>;
    readCached?(conversation: CorpusConversation, control: CorpusReadControl): Promise<CorpusProjection | null>;
    read(conversation: CorpusConversation, control: CorpusReadControl): Promise<CorpusProjection>;
}
