import type { AgentEvent, JsonValue, RetainPolicy, RpcResult } from '../protocol.js';

export type StoreKind = 'conversation' | 'run' | 'input' | 'step' | 'interaction' | 'control' | 'eventAck';

export type InteractionState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'executing' | 'completed' | 'outcome_unknown';

export interface InteractionData extends Record<string, unknown> {
    interactionId: string;
    kind: 'approval';
    conversationId: string;
    principalId: string;
    targetClientId: string;
    runId: string;
    runEpoch: number;
    sourceRunEpoch: number;
    historyEpoch: number;
    policyRevision: number;
    approvalId: string;
    pendingToolId: string;
    actionId: string;
    attemptId: string;
    stepId: string;
    callId: string;
    toolName: string;
    argsHash: string;
    actionHash: string;
    scopeHash: string;
    scope: { paths: string[]; effects: string[]; reason: string };
    state: InteractionState;
    decision?: 'approve' | 'deny';
    modelContentId: string;
    continuationContentId: string;
    createdAt: string;
    expiresAt: string;
    resolvedAt: string | null;
}

export interface StoreKey {
    conversationId: string | null;
    kind: StoreKind;
    id: string;
}

export interface StoreRecord<Value = Record<string, unknown>> {
    key: StoreKey;
    revision: number;
    value: Value;
}

export type ModelStepPairing = 'complete' | 'pending' | 'conflict' | 'incomplete';

export interface ModelStepPairingQuery {
    conversationId: string;
    stepIds: string[];
}

export interface ReceiptKey {
    principalId: string;
    clientId: string;
    conversationId?: string;
    serverScope?: string;
    clientCommandId: string;
}

export interface StoredReceipt {
    key: ReceiptKey;
    operationHash: string;
    result: RpcResult;
    createdAt: string;
    temporaryCreate?: { conversationId: string; expiresAt: string };
}

export interface TemporaryMetadataUsage {
    closedConversations: number;
    recordCount: number;
    receiptCount: number;
    createReceiptCount: number;
    contentBytes: number;
    nextExpiryAt: string | null;
}

export interface TemporaryMetadataSweepOptions {
    now: number;
    canCollect?: (conversationId: string) => Promise<boolean>;
}

export interface TemporaryMetadataSweepResult {
    collectedConversationIds: string[];
    bytesReleased: number;
    hasMore: boolean;
}

export interface ContentWrite {
    conversationId: string;
    contentId: string;
    kind: string;
    value: JsonValue;
    indexHistory?: boolean;
    history?: HistoryMetadata;
}

export interface HistoryMetadata {
    view: 'raw' | 'summary';
    effective: boolean;
    role: 'user' | 'assistant' | 'tool' | 'system';
    roundId: string | null;
    stepId: string | null;
    runId: string | null;
    runEpoch: number | null;
    actionId?: string | null;
    attemptId?: string | null;
    callId?: string | null;
    providerProtocol?: string | null;
}

export interface HistoryQuery {
    conversationId: string;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
    direction?: 'forward' | 'backward';
    startRound?: number;
    endRound?: number;
    view?: 'raw' | 'summary' | 'all';
    effectiveOnly?: boolean;
    includeValues?: boolean;
    expectedHistoryEpoch?: number;
    throughSeq?: number;
}

export interface HistoryItem extends HistoryMetadata {
    itemId: string;
    seq: number;
    contentId: string;
    kind: string;
    objectRef: { hash: string; rawBytes: number };
    value?: JsonValue;
}

export interface HistoryPage extends StorePage<HistoryItem> {
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
}

export const DEFAULT_ARTIFACT_BYTES = 256 * 1024;
export const MAX_ARTIFACT_BYTES = 512 * 1024;

export interface ArtifactQuery {
    conversationId: string;
    artifactId: string;
    offset?: number;
    maxBytes?: number;
}

export interface ArtifactChunk {
    artifactId: string;
    mime: 'application/json';
    offset: number;
    totalBytes: number;
    sha256: string;
    dataBase64: string;
    nextOffset: number | null;
    complete: boolean;
}

export interface TransitionExpected {
    key: StoreKey;
    revision: number | null;
}

export interface StoreTransition {
    expected: TransitionExpected[];
    records?: StoreRecord[];
    remove?: StoreKey[];
    contents?: ContentWrite[];
    events?: AgentEvent[];
    receipt?: StoredReceipt;
    purgeConversationId?: string;
    retainReceiptKeys?: ReceiptKey[];
}

export interface StoreCommitResult {
    replayed: boolean;
    receipt?: StoredReceipt;
}

export interface StorePage<Value> {
    items: Value[];
    nextCursor: string | null;
    hasMore: boolean;
}

export interface StoreRecordQuery {
    kind: StoreKind;
    conversationId?: string | null;
    cursor?: string;
    limit?: number;
}

export interface StoreEventQuery {
    conversationId: string;
    afterSeq: string;
    limit: number;
    maxBytes: number;
}

export interface StoreCapabilities {
    persistent: boolean;
    retentionModes: RetainPolicy['mode'][];
    maxConversationBytes: number;
}

export interface RetentionSweepOptions { limit?: number; maxFiles?: number }

export interface RetentionSweepConversation {
    conversationId: string;
    policyRevision: number;
    expiresAt: string | null;
    state: 'deleted' | 'deferred';
    conversationIds: string[];
    reason?: string;
}

export interface RetentionGarbageResult {
    objectsRemoved: number;
    segmentsRemoved: number;
    bytesRemoved: number;
    pending: number;
    retained: number;
    failures: { kind: string; id: string; code: string }[];
}

export interface RetentionSweepResult {
    scannedAt: string;
    conversations: RetentionSweepConversation[];
    garbage: RetentionGarbageResult;
}

export interface RetentionMaintenancePort {
    sweepRetention(options?: RetentionSweepOptions): Promise<RetentionSweepResult>;
}

export interface StorePort {
    readonly capabilities: StoreCapabilities;
    getRecord<Value = Record<string, unknown>>(key: StoreKey): Promise<StoreRecord<Value> | undefined>;
    readModelStepPairings?(query: ModelStepPairingQuery): Promise<ModelStepPairing[]>;
    listRecords<Value = Record<string, unknown>>(query: StoreRecordQuery): Promise<StorePage<StoreRecord<Value>>>;
    getReceipt(key: ReceiptKey): Promise<StoredReceipt | undefined>;
    readContent(conversationId: string, contentId: string): Promise<JsonValue | undefined>;
    readEvents(query: StoreEventQuery): Promise<StorePage<AgentEvent>>;
    readHistory(query: HistoryQuery): Promise<HistoryPage>;
    readArtifact(query: ArtifactQuery): Promise<ArtifactChunk>;
    commitTransition(transition: StoreTransition): Promise<StoreCommitResult>;
    mutateState?<Value>(scope: StateMutationScope, operation: (port: StateMutationPort) => Promise<Value>): Promise<Value>;
    collectTemporaryMetadata?(options: TemporaryMetadataSweepOptions): Promise<TemporaryMetadataSweepResult>;
    temporaryMetadataUsage?(): TemporaryMetadataUsage;
    close(): Promise<void>;
}

export type StateMutationPort = Pick<StorePort, 'getRecord' | 'commitTransition'>;

export interface StateMutationScope { conversationId: string | null }

export function storeKey(key: StoreKey): string {
    return JSON.stringify([key.conversationId, key.kind, key.id]);
}

export function receiptKey(key: ReceiptKey): string {
    if (Boolean(key.conversationId) === Boolean(key.serverScope)) {
        throw new TypeError('ReceiptKey requires exactly one conversationId or serverScope');
    }
    return JSON.stringify([key.principalId, key.clientId, key.conversationId ? 'conversation' : 'server',
        key.conversationId ?? key.serverScope, key.clientCommandId]);
}
