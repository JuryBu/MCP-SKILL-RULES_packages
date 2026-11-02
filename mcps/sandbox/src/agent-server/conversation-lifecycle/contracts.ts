import type { ClientIdentity, JsonValue, RetainPolicy, RpcResult } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { StoreCommitResult, StoredReceipt, StoreRecord, TransitionExpected, ReceiptKey } from '../storage/port.js';
import type { BranchToolOutcomeProvenance } from './branch-tool-outcome-contracts.js';

export interface LifecycleFence {
    conversationId: string;
    revision: number;
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
    workspaceRevision: number;
    policyRevision: number;
    configRevision: number;
}

export interface LifecycleInventory {
    schemaVersion: 1;
    fence: LifecycleFence;
    inventoryHash: string;
    totalBytes: number;
    contentCount: number;
    originalCount: number;
    retentionRootConversationId: string;
    dependentConversationIds: string[];
    retainedSharedObjects: number;
    unknownAttemptIds: string[];
    activeResourceIds: string[];
    complete: boolean;
}

export interface BranchHistoryItem {
    itemId: string;
    sourceSeq: number;
    localSeq: number;
    contentId: string;
    kind: string;
    objectHash: string;
    rawBytes: number;
    roundId: string | null;
    role: 'user' | 'assistant' | 'tool' | 'system';
    view: 'raw' | 'summary';
    effective: boolean;
    stepId: string | null;
    runId: string | null;
    runEpoch: number | null;
    actionId?: string | null;
    attemptId?: string | null;
    callId?: string | null;
    providerProtocol?: string | null;
}

export interface BranchHistoryManifest {
    schemaVersion: 1;
    sourceConversationId: string;
    sourceHistoryEpoch: number;
    sourceViewRevision: number;
    sourceAppendSeq: number;
    throughSeq: number;
    selectedRoundId: string;
    selectedRoundNumber: number;
    firstSeq: number;
    lastSeq: number;
    sourceHash: string;
    items: BranchHistoryItem[];
    roundMap: { roundId: string; sourceRound: number; localRound: number }[];
    workspaceFiles: 'unchanged';
    contextPolicy: 'rebuild_from_selected_raw';
    toolOutcomeProvenance?: BranchToolOutcomeProvenance;
}

export type LifecycleCommit = {
    schemaVersion: 1;
    operationId: string;
    source: LifecycleFence;
    inventoryHash: string;
    expected: TransitionExpected[];
    target: StoreRecord<ConversationData>;
    receipt: StoredReceipt;
    confirmedAt: string;
} & ({ kind: 'retention'; removeDurableSources: boolean; preserveFinancialFacts: true }
    | { kind: 'branch'; manifest: BranchHistoryManifest; preserveSource: true; copyOriginals: true });

export interface ConversationLifecycleStoragePort {
    inspectConversationLifecycle(input: { source: LifecycleFence; throughSeq?: number; targetRetention?: RetainPolicy }): Promise<LifecycleInventory>;
    commitConversationLifecycle(input: LifecycleCommit): Promise<StoreCommitResult>;
    resumeConversationLifecycle?(key: ReceiptKey, operationHash: string): Promise<StoreCommitResult | undefined>;
}

export interface LifecycleCaller extends ClientIdentity {
    signal?: AbortSignal;
}

export interface PreviewRetentionInput extends RetainPolicy {
    conversationId: string;
    expectedPolicyRevision: number;
}

export interface SetRetentionInput extends PreviewRetentionInput {
    clientCommandId: string;
    previewToken: string;
}

export interface PreviewBranchInput {
    conversationId: string;
    roundId: string;
    expectedHistoryEpoch: number;
    title?: string;
    ttlDurationMs?: number;
    writeRoots: string[];
}

export interface BranchInput extends PreviewBranchInput {
    clientCommandId: string;
    previewToken?: string;
}

export interface BranchPreview {
    preview: true;
    conversationId: string;
    source: LifecycleFence;
    roundId: string;
    roundNumber: number;
    throughSeq: number;
    historyManifestHash: string;
    historyItems: number;
    retention: RetainPolicy;
    title: string | null;
    writeRoots: string[];
    workspaceFiles: 'unchanged';
    contextPolicy: 'rebuild_from_selected_raw';
    unknownAttemptIds: string[];
    previewToken: string;
}

export interface RetentionPreview {
    preview: true;
    conversationId: string;
    source: LifecycleFence;
    from: RetainPolicy;
    to: RetainPolicy;
    previewToken: string;
    effects: {
        contentCount: number;
        originalCount: number;
        bytes: number;
        dependentConversationIds: string[];
        retainedSharedObjects: number;
        unknownAttemptIds: string[];
        durableSources: 'preserve' | 'remove_after_memory_verified';
        workspaceFiles: 'unchanged';
        ttlAnchor: 'confirmation_time' | null;
    };
}

export interface LifecycleDispatchResult extends RpcResult<JsonValue> {}
