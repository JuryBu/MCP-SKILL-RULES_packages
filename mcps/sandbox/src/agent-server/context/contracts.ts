import type { JsonObject, JsonValue } from '../protocol.js';
import type { NativeSendView, ProviderProtocol } from '../providers/types.js';
import type { HistoryItem, HistoryPage, HistoryQuery, ReceiptKey } from '../storage/port.js';

export interface ContextPolicy {
    localContextWindowTokens: number | null;
    bpcThreshold: number;
    hardThreshold: number;
    keepCompleteRounds: number;
    deltaSteps: number;
    chunkInputTokens: number;
    referenceTokens: number;
    readFrameBytes: number;
    stableHeadBatches: number;
    stableTailBatches: number;
    middleSkeletonBatches: number;
    foldAfterBatches: number;
    maxActiveNodes: number;
    cooldownMs: number;
    immediateRetriggerSteps: number;
    immediateRetriggerLimit: number;
}

export interface CompressionModelSelection {
    profileId?: string;
    provider: string;
    endpoint: string;
    model: string;
    protocol: string;
    adapterVersion: string;
    capabilityVersion: string;
    profileRevision: number;
    routing: JsonObject;
    parameters: JsonObject;
    accountFingerprint: string;
    credentialRef: string | null;
    credentialGeneration: number;
    contextWindow: number;
    maxOutputTokens: number;
}

export interface FrozenCompressionConfig {
    policy: Readonly<ContextPolicy>;
    model: Readonly<CompressionModelSelection>;
    modelSource: 'conversation' | 'global' | 'current';
    modelFingerprint: string;
    configFingerprint: string;
    revision: number;
    rules: string;
}

export interface ExecutionLease {
    kind: 'task' | 'maintenance';
    conversationId: string;
    runId: string;
    runEpoch: number;
    rootBudgetId: string;
    roundId: string | null;
    stepId: string;
    deadlineAt: string;
}

export interface UnknownContextCleanupInput {
    conversationId: string;
    runId: string;
    runEpoch: number;
    rootBudgetId: string;
}

export interface RoundBoundary {
    roundId: string;
    roundNumber?: number;
    itemIds: string[];
    complete: boolean;
    firstSeq: number;
    lastSeq: number;
    lastStepSeq: number;
    nativePairing: 'complete' | 'pending' | 'conflict';
}

export interface SourceBlock {
    itemId: string;
    blockId: string;
    contentId: string;
    seq: number;
    roundId: string;
    kind: 'text' | 'nativeAnchor';
    byteLength: number;
    sha256: string;
    mediaType?: string;
    retrieval: JsonObject;
}

export interface SourceSpan {
    itemId: string;
    blockId: string;
    startByte: number;
    endByte: number;
    sha256: string;
    blockHash: string;
    purpose: 'target' | 'reference' | 'nativeAnchor';
}

export interface SourceRead {
    block: SourceBlock;
    startByte: number;
    endByte: number;
    maxBytes: number;
    signal?: AbortSignal;
}

export interface ContextVersionState {
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
}

export interface ContextHistoryPort {
    readVersionState?(conversationId: string): Promise<ContextVersionState | undefined>;
    readHistory(query: HistoryQuery): Promise<HistoryPage>;
    readContent(conversationId: string, contentId: string): Promise<JsonValue | undefined>;
}

export interface ContextSourcePort {
    describe(item: HistoryItem, signal?: AbortSignal): Promise<SourceBlock[]>;
    read(request: SourceRead): Promise<Uint8Array>;
    releaseCached?(blocks: readonly SourceBlock[]): void;
}

export interface SourceManifest {
    blocks: SourceBlock[];
    rounds: RoundBoundary[];
    hash: string;
    prefixHash: string;
}

export type CompactionReason = 'background' | 'hard' | 'manual' | 'fold';
export type CandidateState = 'snapshotting' | 'generating' | 'ready' | 'publishing'
    | 'published' | 'discarded' | 'cancelled' | 'failed' | 'unknown';
export type SchedulerState = 'idle' | 'cooldown' | 'circuitBroken' | 'hardPaused';

export interface CompactionSnapshot {
    candidateId: string;
    conversationId: string;
    runId: string;
    runEpoch: number;
    compressionGeneration: string;
    historyEpoch: number;
    snapshotAppendSeq: number;
    parentViewRevision: number;
    startRoundId: string;
    endRoundId: string;
    coveredStartSeq: number;
    coveredEndSeq: number;
    snapshotStepSeq: number;
    targetReplaceStep: number;
    sourceManifestHash: string;
    sourcePrefixHash: string;
    sourceSpans: SourceSpan[];
    parentBatchIds: string[];
    compressionProfileRevision: number;
    effectiveModelFingerprint: string;
    configFingerprint: string;
    sourceHistoryRoot: string;
    workspaceRevision: number;
    createdAt: string;
    manifest: SourceManifest;
    referenceBlocks: SourceBlock[];
    execution: ExecutionLease;
    config: FrozenCompressionConfig;
}

export interface CoverageEntry {
    span: SourceSpan;
    status: 'complete' | 'partial' | 'anchorOnly';
    gaps: { startByte: number; endByte: number }[];
}

export interface RequirementAnchor {
    id: string;
    quote: string;
    source: SourceSpan;
    resolvedBy?: SourceSpan[];
}

export interface DigestText {
    body: string;
    skeleton: string;
    title: string;
    unresolved: RequirementAnchor[];
}

export interface CompressionChunk {
    chunkId: string;
    roundId: string;
    sourceSpans: SourceSpan[];
    referenceSpans: SourceSpan[];
    anchors: SourceBlock[];
    body: string;
    inputBodyHash: string;
    inputTokens: number;
}

export interface CompressionRequest {
    attemptId: string;
    actionId: string;
    stepId: string;
    reason: CompactionReason;
    originReason?: CompactionReason;
    execution: ExecutionLease;
    snapshot: CompactionSnapshot;
    model: Readonly<CompressionModelSelection>;
    chunk: CompressionChunk;
    maxOutputTokens: number;
    inputBodyHash: string;
}

export interface CompressionResult {
    attemptId: string;
    requestAttemptId?: string;
    inputBodyHash: string;
    modelFingerprint: string;
    complete: boolean;
    digest: DigestText;
    coverage: CoverageEntry[];
    usage: JsonValue | null;
}

export interface ChunkDigest extends CompressionResult {
    chunkId: string;
    roundId: string;
    sourceSpans: SourceSpan[];
    anchors: SourceBlock[];
}

export interface CompressionModelPort {
    generate(request: CompressionRequest, signal: AbortSignal): Promise<CompressionResult>;
    lookup(request: CompressionRequest): Promise<
        { status: 'found'; result: CompressionResult }
        | { status: 'notAccepted' | 'pending' | 'unknown' }
    >;
    cancel(request: CompressionRequest): Promise<'cancelled' | 'completed' | 'unknown'>;
}

export interface SummaryBatch extends DigestText {
    kind: 'batch';
    nodeId: string;
    hash: string;
    firstSeq: number;
    lastSeq: number;
    roundIds: string[];
    sourceSpans: SourceSpan[];
    chunkIds: string[];
    parentBatchIds: string[];
    modelFingerprint: string;
    anchors: SourceBlock[];
}

export interface FoldNode extends Omit<SummaryBatch, 'kind'> {
    kind: 'fold';
    children: { nodeId: string; hash: string; firstSeq: number; lastSeq: number }[];
}

export type SummaryNode = SummaryBatch | FoldNode;

export interface SummaryView {
    revision: number;
    historyEpoch: number;
    coveredEndSeq: number;
    nodes: SummaryNode[];
}

export interface ContextCapture {
    conversationId: string;
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
    workspaceRevision: number;
    compressionGeneration: string;
    effectiveModelFingerprint: string;
    historyRoot: string;
    stepSeq: number;
    activeRoundId: string | null;
    rounds: RoundBoundary[];
    view: SummaryView;
    execution: ExecutionLease | null;
    candidateId: string | null;
}

export interface CoverageReport {
    completeRoundIds: string[];
    coveredEndSeq: number;
    gaps: { itemId: string; blockId: string; startByte: number; endByte: number; reason: string }[];
    anchorOnly: SourceBlock[];
}

export interface CompactionCandidate {
    candidateId: string;
    conversationId: string;
    state: CandidateState;
    reason: CompactionReason;
    snapshot: CompactionSnapshot;
    chunks: ChunkDigest[];
    pendingRequest: CompressionRequest | null;
    failedResult: CompressionResult | null;
    batch: SummaryBatch | null;
    folds: FoldNode[];
    nextView: SummaryView | null;
    coverage: CoverageReport | null;
    error: ContextFailure | null;
    publishedViewRevision: number | null;
    publicationReceiptKey: ReceiptKey | null;
}

export interface ContextFailure {
    code: string;
    message: string;
    mayHaveStarted: boolean;
    attemptId?: string;
    details?: Record<string, unknown>;
}

export interface Publication {
    candidateId: string;
    viewRevision: number;
    coveredEndSeq: number;
    appendSeq: number;
    replayed: boolean;
}

export interface SchedulerCheckpoint {
    state: SchedulerState;
    cooldownUntil: number | null;
    lastPublishStep: number | null;
    immediateRetriggers: number;
    lastFailure: ContextFailure | null;
    lastPublishRevision: number | null;
    lastRetriggeredRevision: number | null;
}

export interface CompactionPort extends ContextHistoryPort {
    inspect(conversationId: string): Promise<ContextCapture>;
    claim(input: {
        conversationId: string;
        expectedHistoryEpoch: number;
        expectedViewRevision: number;
        expectedGeneration: string;
        compressionGeneration: string;
        execution: ExecutionLease;
    }): Promise<ContextCapture>;
    saveCandidate(candidate: CompactionCandidate): Promise<void>;
    getCandidate(conversationId: string, candidateId: string): Promise<CompactionCandidate | null>;
    publishCandidate(input: { candidate: CompactionCandidate; receiptKey: ReceiptKey }): Promise<Publication>;
    getPublication(receiptKey: ReceiptKey): Promise<Publication | null>;
    discardCandidate(input: { conversationId: string; candidateId: string; generation: string; state: 'cancelled' | 'discarded' }): Promise<void>;
    loadScheduler(conversationId: string): Promise<SchedulerCheckpoint | null>;
    saveScheduler(conversationId: string, checkpoint: SchedulerCheckpoint): Promise<void>;
}

export interface MaintenanceCallbacks {
    createRun(input: { conversationId: string; budget?: JsonObject; config?: FrozenCompressionConfig; operationId?: string }): Promise<ExecutionLease>;
    prepareRun?(input: { execution: ExecutionLease; config: FrozenCompressionConfig; recoveredAttemptId?: string }): Promise<FrozenCompressionConfig>;
    finishRun(input: { execution: ExecutionLease; result: 'published' | 'cancelled' | 'failed' | 'unknown'; failure?: ContextFailure }): Promise<void>;
}

export type TokenCounter = (text: string) => number;

export interface ContextTokenCountEvidence {
    source: 'provider_native_count_tokens';
    scope: 'complete_native_input';
    protocol: ProviderProtocol;
    profileId: string;
    profileRevision: number;
    credentialGeneration: number;
    modelId: string;
    adapterVersion: string;
    viewHash: string;
    parametersHash: string;
    requestHash: string;
    countRequestBodyHash: string;
    sourceRef: string;
    observedAt: string;
    deadlineAt: string;
}

export interface ContextEstimate {
    rules: number | null;
    schema: number | null;
    native: number | null;
    summary: number | null;
    retained: number | null;
    media: number | null;
    protocol: number | null;
    confidence: 'actual' | 'estimated' | 'conservative' | 'unknown';
    totalInputTokens?: number;
    tokenCountEvidence?: ContextTokenCountEvidence;
}

export type ContextViewEstimator = (view: NativeSendView, details: { baseView: NativeSendView; summaryTokens: number }) => ContextEstimate | Promise<ContextEstimate>;
export type ContextEstimateBasis = 'native_view_utf8_upper_bound' | 'injected_estimator' | 'provider_native_count_tokens';

export interface ContextLimits {
    contextWindow: number;
    outputReserve: number;
    margin: number;
    inputBudget: number;
    summaryBudget: number;
    target: number;
}

export interface ConversationContextLimits extends ContextLimits {
    providerContextWindow: number;
    localContextWindowTokens: number | null;
    windowSource: 'provider' | 'local';
}
