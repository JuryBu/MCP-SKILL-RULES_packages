import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";

export interface DevinReadOptions {
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    maxNodes?: number;
    maxBytes?: number;
    maxDesktopFiles?: number;
    deadlineMs?: number;
}

export interface DevinConversationSummary {
    id: string;
    canonicalId: string;
    sessionId?: string;
    uuid?: string;
    aliases: string[];
    title: string;
    cwd?: string;
    workspaceUris: string[];
    createdAt?: string;
    updatedAt?: string;
    sourcePath: string;
    desktopPaths: string[];
    sourceKind: "devin-cli" | "devin-desktop";
    matchedMessageIds: number;
    mainChainId?: number;
    partial: boolean;
    warnings: string[];
    isChildThread?: boolean;
    parentConversationId?: string;
    agentId?: string;
}

export interface DevinMessageNode {
    nodeId: number;
    parentNodeId: number | null;
    createdAt: number | string;
    message: Record<string, any>;
    metadata: Record<string, any>;
}

export interface DevinDesktopMessage {
    position: number;
    kind: string;
    payload: Record<string, any>;
    sourcePath?: string;
}

export interface DevinCompaction {
    nodeId: number;
    summarizedFrom: number;
    summary: string;
    createdAt?: string;
    restored: boolean;
}

export interface DevinRawConversation {
    summary: DevinConversationSummary;
    nodes: DevinMessageNode[];
    desktopMessages: DevinDesktopMessage[];
    compactions: DevinCompaction[];
    fingerprint: ConversationSourceFingerprint;
    partial: boolean;
    warnings: string[];
}
