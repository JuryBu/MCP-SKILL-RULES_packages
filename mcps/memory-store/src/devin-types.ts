import type { ConversationSourceFingerprint } from "./conversation-source-cache.js";

export interface DevinReadOptions {
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    maxNodes?: number;
    maxBytes?: number;
    maxDesktopFiles?: number;
    deadlineMs?: number;
    roundRange?: DevinRoundRange;
    identityCache?: import("./devin-identity-cache.js").DevinIdentityCache;
    identityMode?: "verified" | "physical";
    physicalSourceKind?: "devin-cli" | "devin-desktop";
    childDiscoveryOnly?: boolean;
    childAgentId?: string;
    messageRoles?: string[];
}

export type DevinRoundRange = { tailRounds: number } | { startRound: number; endRound?: number };

export interface DevinRoundCoverage {
    unit: "round";
    startRound: number;
    endRound: number;
    totalRounds: number;
    startStep: number;
    endStepExclusive: number;
    totalSteps: number;
    complete: boolean;
    sourceRevision?: string;
}

export interface DevinRelativeCoverage {
    unit: "round";
    startRound: number;
    endRound: number;
    startStep: number;
    endStepExclusive: number;
    requestedRangeComplete: boolean;
    sourceRevision?: string;
}

export interface DevinSqliteValidation {
    sourcePath: string;
    identity: string;
    dataVersion: number;
    epoch: string;
}

export interface DevinDiscoveryDiagnostic {
    code: string;
    message: string;
    sourceKind: "devin-cli" | "devin-desktop";
    sourcePath: string;
    conversationId?: string;
}

export interface DevinDiscoveryOptions extends DevinReadOptions {
    conversationIds?: string[];
    query?: string;
    workspaces?: string[];
    workspaceMode?: "contains" | "exact" | "under" | "any" | "all";
    workspaceScope?: "any" | "primary";
    limit?: number;
    verifyAliases?: boolean;
}

export interface DevinDiscoveryResult {
    conversations: DevinConversationSummary[];
    partial: boolean;
    diagnostics: DevinDiscoveryDiagnostic[];
    scannedSessions: number;
    scannedDesktopFiles: number;
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
    matchedToolCallIds?: number;
    identityEvidence?: "client-message-id" | "tool-call-id";
    identityStatus?: "pending";
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
    coverage?: DevinRoundCoverage;
    relativeCoverage?: DevinRelativeCoverage;
    sourceEvidence?: { method: "content-digest" | "sqlite-data-version"; revision: string; validationRevision?: string; sources?: DevinSqliteValidation[] };
    readMetrics?: { identityMs: number; bodyReadMs: number; totalMs: number; bytesRead: number; recordsRead: number; identityCacheHit: boolean };
}
