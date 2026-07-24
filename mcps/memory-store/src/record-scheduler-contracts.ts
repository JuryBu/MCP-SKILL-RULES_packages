import type { Chain, DataChain } from "./chain.js";
import {
    PROVIDER_TRAFFIC_CLASSES,
    type ProviderLeaseIdentity,
    type ProviderTrafficClass,
} from "./provider-control-contracts.js";

export const RECORD_SCHEDULER_SCHEMA_VERSION = 5 as const;
export const LEGACY_BATCH_LEDGER_VERSIONS = [1, 2] as const;

export type SourceChain = Exclude<DataChain, "auto">;
export type ModelProvider = Exclude<Chain, "auto"> | "agy";
export type ModelRoute = "auto" | ModelProvider;
export type SchedulerAttemptProvider = ModelProvider | "local";
export type SchedulerAttemptAdmission = "provider-transport" | "synthetic" | "local";
export type SchedulerAttemptDispatchPhase = "permit-granted" | "attempt-bound" | "invoking";
export type SchedulerProvider = SchedulerAttemptProvider;
export const SOURCE_CHAINS: readonly SourceChain[] = ["antigravity", "codex", "claude-code", "windsurf"];
export const MODEL_PROVIDERS: readonly ModelProvider[] = ["antigravity", "codex", "claude-code", "grok", "agy"];
export const MODEL_ROUTES: readonly ModelRoute[] = ["auto", ...MODEL_PROVIDERS];
export type CandidateState = "Fresh" | "Stale" | "Missing" | "Unresolved" | "Lost" | "Conflict";
export type FailureClass = "Congestion" | "Availability" | "Quality" | "Complexity" | "LocalResource" | "UnknownOutcome" | "DeterministicInput" | "Persistence";
export type RepairState = "None" | "Required" | "Repairing" | "Blocked";
export type TaskState = "Accepted" | "Preparing" | "Queued" | "Running" | "Committing" | "CancelRequested" | "Cancelling" | "Succeeded" | "Deferred" | "FailedFinal" | "Cancelled" | "RepairRequired";
export type UnitState = "Materialized" | "Blocked" | "Queued" | "Running" | "WaitingRetry" | "ResultReady" | "Committing" | "Succeeded" | "FailedFinal" | "UnknownOutcome" | "Cancelled" | "Discarded" | "Superseded";
export type AttemptState = "Created" | "DispatchIntentPersisted" | "Dispatched" | "KnownSuccess" | "KnownFailure" | "UnknownOutcome" | "Discarded";
export type AttemptOutcome = "dispatched" | "known_success" | "known_failure" | "unknown_outcome" | "discarded";
export const UNKNOWN_OUTCOME_GRACE_MS = 30_000;
export type CommitState = "NotStarted" | "ResultReady" | "BodyStaged" | "PublishIntent" | "BodyPublished" | "MainIndexWritten" | "ReaderIndexWritten" | "Verified" | "CleanupPending" | "Compensated" | "RepairRequired" | "Abandoned";
export type CleanupState = "NotRequired" | "CleanupIntentPersisted" | "Compensating" | "Verified" | "RepairRequired";

type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>;

export const CANDIDATE_STATES: readonly CandidateState[] = ["Fresh", "Stale", "Missing", "Unresolved", "Lost", "Conflict"];
export const FAILURE_CLASSES: readonly FailureClass[] = ["Congestion", "Availability", "Quality", "Complexity", "LocalResource", "UnknownOutcome", "DeterministicInput", "Persistence"];
export const TASK_STATES: readonly TaskState[] = ["Accepted", "Preparing", "Queued", "Running", "Committing", "CancelRequested", "Cancelling", "Succeeded", "Deferred", "FailedFinal", "Cancelled", "RepairRequired"];
export const UNIT_STATES: readonly UnitState[] = ["Materialized", "Blocked", "Queued", "Running", "WaitingRetry", "ResultReady", "Committing", "Succeeded", "FailedFinal", "UnknownOutcome", "Cancelled", "Discarded", "Superseded"];
export const ATTEMPT_STATES: readonly AttemptState[] = ["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess", "KnownFailure", "UnknownOutcome", "Discarded"];
export const COMMIT_STATES: readonly CommitState[] = ["NotStarted", "ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending", "Compensated", "RepairRequired", "Abandoned"];
export const CLEANUP_STATES: readonly CleanupState[] = ["NotRequired", "CleanupIntentPersisted", "Compensating", "Verified", "RepairRequired"];

export const CANDIDATE_TRANSITIONS: TransitionMap<CandidateState> = {
    Fresh: ["Fresh", "Stale", "Unresolved", "Lost", "Conflict"],
    Stale: ["Fresh", "Stale", "Unresolved", "Lost", "Conflict"],
    Missing: ["Fresh", "Missing", "Unresolved", "Lost", "Conflict"],
    Unresolved: ["Fresh", "Stale", "Missing", "Unresolved", "Lost", "Conflict"],
    Lost: ["Fresh", "Stale", "Missing", "Unresolved", "Lost", "Conflict"],
    Conflict: ["Fresh", "Stale", "Missing", "Unresolved", "Lost", "Conflict"],
};

export const TASK_TRANSITIONS: TransitionMap<TaskState> = {
    Accepted: ["Preparing", "CancelRequested", "FailedFinal", "RepairRequired"],
    Preparing: ["Queued", "CancelRequested", "FailedFinal", "RepairRequired"],
    Queued: ["Running", "CancelRequested", "FailedFinal", "RepairRequired"],
    Running: ["Committing", "Queued", "CancelRequested", "FailedFinal", "RepairRequired"],
    Committing: ["Running", "Succeeded", "Deferred", "CancelRequested", "FailedFinal", "RepairRequired"],
    CancelRequested: ["Cancelling"],
    Cancelling: ["Cancelled"],
    Succeeded: [],
    Deferred: [],
    FailedFinal: [],
    Cancelled: [],
    RepairRequired: [],
};

export const UNIT_TRANSITIONS: TransitionMap<UnitState> = {
    Materialized: ["Blocked", "Queued", "Cancelled", "Superseded", "FailedFinal"],
    Blocked: ["Queued", "Cancelled", "Superseded", "FailedFinal"],
    Queued: ["Running", "Cancelled", "Superseded", "FailedFinal"],
    Running: ["ResultReady", "WaitingRetry", "UnknownOutcome", "Discarded", "FailedFinal", "Superseded"],
    WaitingRetry: ["Queued", "Cancelled", "FailedFinal", "Superseded"],
    ResultReady: ["Committing", "Discarded", "Superseded"],
    Committing: ["Succeeded", "FailedFinal", "Superseded", "Discarded"],
    Succeeded: [],
    FailedFinal: [],
    UnknownOutcome: ["WaitingRetry", "FailedFinal", "Superseded", "Discarded"],
    Cancelled: [],
    Discarded: [],
    Superseded: [],
};

export const ATTEMPT_TRANSITIONS: TransitionMap<AttemptState> = {
    Created: ["DispatchIntentPersisted", "Discarded"],
    DispatchIntentPersisted: ["Dispatched", "Discarded"],
    Dispatched: ["KnownSuccess", "KnownFailure", "UnknownOutcome"],
    KnownSuccess: ["Discarded"],
    KnownFailure: [],
    UnknownOutcome: ["Discarded"],
    Discarded: [],
};

export const COMMIT_TRANSITIONS: TransitionMap<CommitState> = {
    NotStarted: ["ResultReady", "Abandoned"],
    ResultReady: ["BodyStaged", "Abandoned"],
    BodyStaged: ["PublishIntent", "CleanupPending", "RepairRequired"],
    PublishIntent: ["BodyPublished", "CleanupPending", "RepairRequired"],
    BodyPublished: ["MainIndexWritten", "CleanupPending", "RepairRequired"],
    MainIndexWritten: ["ReaderIndexWritten", "CleanupPending", "RepairRequired"],
    ReaderIndexWritten: ["Verified", "CleanupPending", "RepairRequired"],
    Verified: ["CleanupPending"],
    CleanupPending: ["Compensated", "RepairRequired"],
    Compensated: [],
    RepairRequired: [],
    Abandoned: [],
};

export const CLEANUP_TRANSITIONS: TransitionMap<CleanupState> = {
    NotRequired: ["CleanupIntentPersisted"],
    CleanupIntentPersisted: ["Compensating", "RepairRequired"],
    Compensating: ["Verified", "RepairRequired"],
    Verified: [],
    RepairRequired: ["Compensating"],
};

export interface TaskTransitionContext {
    cancellationEvidence?: CancellationCompletionEvidence;
}

export function canTransition<State extends string>(transitions: TransitionMap<State>, from: State, to: State): boolean {
    return transitions[from].includes(to);
}

export const LOST_SECOND_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface LostObservation {
    scanId: string;
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
    completedAt: string;
    complete: boolean;
    exactLookupSucceeded: boolean;
    found: boolean;
}

export interface LostTargetIdentity {
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
}

export interface AuthoritativeTombstoneEvidence extends LostTargetIdentity {
    observedAt: string;
    exactLookupSucceeded: true;
}

export interface CandidateTransitionContext {
    target?: LostTargetIdentity;
    tombstone?: AuthoritativeTombstoneEvidence;
    observations?: readonly LostObservation[];
}

export function isLostEvidenceSufficient(context: CandidateTransitionContext = {}): boolean {
    const target = context.target;
    if (!target) return false;
    const matchesTarget = (evidence: LostTargetIdentity) => evidence.chain === target.chain
        && evidence.workspaceHash === target.workspaceHash
        && evidence.conversationId === target.conversationId;
    if (context.tombstone
        && matchesTarget(context.tombstone)
        && context.tombstone.exactLookupSucceeded
        && Number.isFinite(Date.parse(context.tombstone.observedAt))) return true;
    const observations = context.observations || [];
    if (observations.length < 2) return false;
    const sorted = [...observations]
        .filter(observation => matchesTarget(observation) && observation.complete && observation.exactLookupSucceeded && !observation.found)
        .sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
    if (sorted.length < 2) return false;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const firstTime = Date.parse(first.completedAt);
    const lastTime = Date.parse(last.completedAt);
    return first.scanId !== last.scanId
        && Number.isFinite(firstTime)
        && Number.isFinite(lastTime)
        && lastTime - firstTime >= LOST_SECOND_CHECK_INTERVAL_MS;
}

export function canTransitionCandidate(from: CandidateState, to: CandidateState, context: CandidateTransitionContext = {}): boolean {
    if (!canTransition(CANDIDATE_TRANSITIONS, from, to)) return false;
    if (to !== "Lost" || from === "Lost") return true;
    return isLostEvidenceSufficient(context);
}

export function canTransitionTask(from: TaskState, to: TaskState, context: TaskTransitionContext = {}): boolean {
    if (!canTransition(TASK_TRANSITIONS, from, to)) return false;
    if (from !== "Cancelling" || to !== "Cancelled") return true;
    return context.cancellationEvidence !== undefined && isCancellationCleanupComplete(context.cancellationEvidence);
}

export function canTransitionUnit(from: UnitState, to: UnitState): boolean {
    return canTransition(UNIT_TRANSITIONS, from, to);
}

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
    return canTransition(ATTEMPT_TRANSITIONS, from, to);
}

export function canTransitionCommit(from: CommitState, to: CommitState): boolean {
    return canTransition(COMMIT_TRANSITIONS, from, to);
}

export function canTransitionCleanup(from: CleanupState, to: CleanupState): boolean {
    return canTransition(CLEANUP_TRANSITIONS, from, to);
}

function assertTransition<State extends string>(kind: string, allowed: boolean, from: State, to: State): void {
    if (!allowed) throw new Error(`${kind} 非法状态迁移：${from} → ${to}`);
}

export function assertTaskTransition(from: TaskState, to: TaskState, context: TaskTransitionContext = {}): void {
    assertTransition("Task", canTransitionTask(from, to, context), from, to);
}

export function assertCandidateTransition(from: CandidateState, to: CandidateState, context: CandidateTransitionContext = {}): void {
    assertTransition("Candidate", canTransitionCandidate(from, to, context), from, to);
}

export function assertUnitTransition(from: UnitState, to: UnitState): void {
    assertTransition("Unit", canTransitionUnit(from, to), from, to);
}

export function assertAttemptTransition(from: AttemptState, to: AttemptState): void {
    assertTransition("Attempt", canTransitionAttempt(from, to), from, to);
}

export function assertCommitTransition(from: CommitState, to: CommitState): void {
    assertTransition("Commit", canTransitionCommit(from, to), from, to);
}

export function assertCleanupTransition(from: CleanupState, to: CleanupState): void {
    assertTransition("Cleanup", canTransitionCleanup(from, to), from, to);
}

export const TERMINAL_TASK_STATES: readonly TaskState[] = ["Succeeded", "Deferred", "FailedFinal", "Cancelled", "RepairRequired"];

export function isTerminalTaskState(state: TaskState): boolean {
    return TERMINAL_TASK_STATES.includes(state);
}

export function blocksNewDispatch(state: TaskState, repairState: RepairState): boolean {
    return repairState !== "None" || state === "CancelRequested" || state === "Cancelling" || isTerminalTaskState(state);
}

export function canDispatchTask(state: TaskState, repairState: RepairState): boolean {
    return repairState === "None" && (state === "Queued" || state === "Running");
}

export interface CandidateStatePolicy {
    mayAutoUpdate: boolean;
    mayAutoCleanup: boolean;
    countsAsDefiniteFailure: boolean;
    requiresManualReview: boolean;
}

export const CANDIDATE_STATE_POLICIES: Readonly<Record<CandidateState, CandidateStatePolicy>> = {
    Fresh: { mayAutoUpdate: false, mayAutoCleanup: false, countsAsDefiniteFailure: false, requiresManualReview: false },
    Stale: { mayAutoUpdate: true, mayAutoCleanup: false, countsAsDefiniteFailure: false, requiresManualReview: false },
    Missing: { mayAutoUpdate: true, mayAutoCleanup: false, countsAsDefiniteFailure: false, requiresManualReview: false },
    Unresolved: { mayAutoUpdate: false, mayAutoCleanup: false, countsAsDefiniteFailure: false, requiresManualReview: false },
    Lost: { mayAutoUpdate: false, mayAutoCleanup: false, countsAsDefiniteFailure: false, requiresManualReview: false },
    Conflict: { mayAutoUpdate: false, mayAutoCleanup: false, countsAsDefiniteFailure: false, requiresManualReview: true },
};

export function candidateStatePolicy(state: CandidateState): CandidateStatePolicy {
    return CANDIDATE_STATE_POLICIES[state];
}

export function isDefiniteFailureClass(failureClass: FailureClass | null | undefined): boolean {
    return failureClass === "DeterministicInput";
}

export interface ImmutableBlobReference {
    path: string;
    hash: string;
    byteLength: number;
}

export interface SnapshotReadRange {
    startRound: number;
    endRound: number;
    totalRounds: number;
}

export interface SnapshotRevisionReference {
    snapshotId: string;
    snapshotRevision: number;
}

export interface CandidateEnumerationSnapshot {
    chain: SourceChain;
    complete: boolean;
    paginationExhausted: boolean;
    truncated: boolean;
    watermark?: string;
    error?: string;
}

export interface CandidateSnapshotEntry {
    conversationId: string;
    chain: SourceChain;
    workspaceHash: string;
    state: CandidateState;
    evidence: string[];
    evidenceHash: string;
    recordIndexRevision?: string;
}

export interface CandidateSnapshot {
    schemaVersion: typeof RECORD_SCHEDULER_SCHEMA_VERSION;
    snapshotId: string;
    snapshotRevision: number;
    snapshotHash: string;
    snapshotRef: ImmutableBlobReference;
    createdAt: string;
    requestMode: "normal" | "force" | "stale_only";
    filters: Record<string, unknown>;
    selectionLimit?: number;
    enumerations: CandidateEnumerationSnapshot[];
    candidates: CandidateSnapshotEntry[];
    recordIndexRevision?: string;
}

export interface RecordSourceSnapshot {
    schemaVersion: typeof RECORD_SCHEDULER_SCHEMA_VERSION;
    sourceSnapshotId: string;
    snapshotRevision: number;
    snapshotHash: string;
    snapshotRef: ImmutableBlobReference;
    conversationId: string;
    chain: SourceChain;
    workspaceHash: string;
    sourceRevision: string;
    desiredRevision: string;
    sourceRevisionSequence?: number;
    eventWatermark?: string;
    contentHash: string;
    contentRef: ImmutableBlobReference;
    formatterVersion: string;
    readRange: SnapshotReadRange;
    complete: boolean;
    gaps: string[];
    parseWarnings: string[];
}

export interface SourceMaterializationSelection {
    sourceKey: string;
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
    candidateState: CandidateState;
    evidenceHash: string;
}

export type SourceMaterializationOutcomeKind = "accepted" | "unresolved" | "conflict";

export interface SourceMaterializationOutcome {
    sourceKey: string;
    kind: SourceMaterializationOutcomeKind;
    observedAt: string;
    sourceSnapshotId?: string;
    sourceRevision?: string;
    contentHash?: string;
    previousContentHash?: string;
    evidenceHash?: string;
    scanId?: string;
    reason?: string;
}

export interface SourceMaterializationLedger {
    schemaVersion: 1;
    phase: "intent" | "sealed";
    candidateSnapshotId: string;
    candidateSnapshotHash: string;
    selectionHash: string;
    selected: SourceMaterializationSelection[];
    outcomes: SourceMaterializationOutcome[];
    markerRef?: ImmutableBlobReference;
}

export interface SchedulerSourceResolutionIssue {
    host: SourceChain;
    conversationId?: string;
    code: string;
    message: string;
    evidenceHashes: string[];
}

export interface SchedulerSourceResolution {
    phase: "pending" | "frozen" | "materialized" | "deferred";
    selectedCount: number | null;
    materializedCount: number;
    unresolvedCount: number;
    deferredReason?: "source_unresolved";
    issues: SchedulerSourceResolutionIssue[];
}

export function candidateSnapshotRevision(snapshot: Pick<CandidateSnapshot, "snapshotId" | "snapshotRevision">): SnapshotRevisionReference {
    return { snapshotId: snapshot.snapshotId, snapshotRevision: snapshot.snapshotRevision };
}

export function sourceSnapshotRevision(snapshot: Pick<RecordSourceSnapshot, "sourceSnapshotId" | "snapshotRevision">): SnapshotRevisionReference {
    return { snapshotId: snapshot.sourceSnapshotId, snapshotRevision: snapshot.snapshotRevision };
}

export function matchesSnapshotRevision(expected: SnapshotRevisionReference, actual: SnapshotRevisionReference): boolean {
    return expected.snapshotId === actual.snapshotId && expected.snapshotRevision === actual.snapshotRevision;
}

export function assertSnapshotRevision(expected: SnapshotRevisionReference, actual: SnapshotRevisionReference): void {
    if (!matchesSnapshotRevision(expected, actual)) throw new Error("快照 revision 不匹配，禁止复用或提交");
}

export interface FencingToken {
    schedulerEpoch: number;
    recordCommitEpoch: number;
    fencingToken: number;
    workLeaseId: string;
}

export interface ConditionalBeforeImage {
    path: string;
    existed: boolean;
    revision?: string;
    hash?: string;
    contentRef?: ImmutableBlobReference;
}

export interface CommitBeforeImageBundle {
    commitId: string;
    capturedAt: string;
    body: ConditionalBeforeImage;
    mainIndexEntry: ConditionalBeforeImage;
    readerIndexEntry: ConditionalBeforeImage;
    fence: FencingToken;
}

export interface PendingRefreshReference {
    refreshKey: string;
    refreshTaskId: string;
    sourceSnapshotId: string;
    recordWorkKey: string;
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
    fromRevision: string;
    desiredRevision: string;
    persistedAt: string;
    ledgerRevision: number;
    ledgerRef: ImmutableBlobReference;
    state: "Queued" | "Running";
}

export interface CommitReadBackVerification {
    verifiedAt: string;
    bodyHash: string;
    mainIndexRevision: string;
    readerIndexRevision: string;
    mainIndexEntry: PublishedIndexEntryEvidence;
    readerIndexEntry: PublishedIndexEntryEvidence;
}

export interface PublishedIndexEntryEvidence {
    revision: string;
    entryHash: string;
    commitId: string;
    recordWorkKey: string;
    sourceSnapshotId: string;
    bodyHash: string;
    coveredRevision: string;
}

export type CommitOwnership =
    | { mode: "task_exclusive"; ownerTaskId: string }
    | { mode: "shared"; ownerTaskIds: string[] };

export interface CleanupTargetReadBack {
    path: string;
    taskCommitVisible: false;
    disposition: "absent" | "restored_before_image" | "superseded_by_higher_epoch";
    observedHash?: string;
    observedRevision?: string;
    observedRecordCommitEpoch?: number;
    observedCommitId?: string;
    observedRecordWorkKey?: string;
}

export interface SupersedingCommitEvidence {
    commitId: string;
    recordWorkKey: string;
    recordCommitEpoch: number;
    bodyHash: string;
    mainIndexEntryHash: string;
    readerIndexEntryHash: string;
}

export interface CleanupReadBackVerification {
    commitId: string;
    taskId: string;
    recordWorkKey: string;
    verifiedAt: string;
    registryRevision: number;
    body: CleanupTargetReadBack;
    mainIndexEntry: CleanupTargetReadBack;
    readerIndexEntry: CleanupTargetReadBack;
    supersedingCommit?: SupersedingCommitEvidence;
    fence: FencingToken;
}

export interface CommitSnapshot {
    schemaVersion: typeof RECORD_SCHEDULER_SCHEMA_VERSION;
    commitId: string;
    taskId: string;
    unitId: string;
    attemptId: string;
    recordWorkKey: string;
    sourceSnapshotId: string;
    inputHash: string;
    outputHash: string;
    qualityResult: { accepted: boolean; reason?: string };
    bodyRef: ImmutableBlobReference;
    bodyHash: string;
    mainIndexRevision?: string;
    readerIndexRevision?: string;
    mainIndexEntry?: PublishedIndexEntryEvidence;
    readerIndexEntry?: PublishedIndexEntryEvidence;
    ownership: CommitOwnership;
    beforeImage?: CommitBeforeImageBundle;
    coveredRevision?: string;
    observedSourceRevisionAtCommit: string;
    pendingRefresh?: PendingRefreshReference;
    state: CommitState;
    cleanupPhase: CleanupState;
    verifiedAt?: string;
    readBack?: CommitReadBackVerification;
    cleanupReadBack?: CleanupReadBackVerification;
    successConditions: Partial<RecordSuccessConditions>;
    fence: FencingToken;
}

export interface SchedulerRecordWork {
    recordWorkKey: string;
    conversationId: string;
    chain: SourceChain;
    workspaceHash: string;
    desiredRevision: string;
    recordCommitEpoch: number;
    registryRevision: number;
    registryRef: ImmutableBlobReference;
    schedulerEpoch: number;
    workLeaseId: string;
    leaseOwnerId: string;
    leaseExpiresAt: string;
    activeTaskIds: string[];
    currentFencingToken: number;
}

export interface SchedulerLedgerAnchor {
    path: string;
    revision: 1;
    hash: string;
}

export interface SchedulerAdmissionIdentity {
    requestKey: string;
    requestHash: string;
}

export interface SchedulerAdmissionBackgroundProjection {
    projection?: unknown;
    resumePayload?: unknown;
    resumeVersion?: number;
    resumeHash?: string;
}

export interface LedgerCreatedAdmission {
    state: "LedgerCreated";
}

export interface EnvelopeBoundAdmission {
    state: "EnvelopeBound";
    ledgerAnchor: SchedulerLedgerAnchor;
    capsuleRef: ImmutableBlobReference;
    boundAt: string;
}

export type SchedulerTaskAdmission = LedgerCreatedAdmission | EnvelopeBoundAdmission;

export function isEnvelopeBoundAdmission(admission: SchedulerTaskAdmission): admission is EnvelopeBoundAdmission {
    return admission.state === "EnvelopeBound";
}

export interface SchedulerAdmissionCapsule {
    schemaVersion: 2;
    kind: "record-scheduler-admission-capsule";
    taskId: string;
    taskKind: "record-update" | "record-batch-update";
    admissionIdentity: SchedulerAdmissionIdentity;
    ledgerAnchor: SchedulerLedgerAnchor;
    requestSummary: Record<string, unknown>;
    backgroundProjection: SchedulerAdmissionBackgroundProjection;
}

export interface RecordSchedulerAdmissionReceipt {
    verifier: "record-scheduler-admission";
    verifiedAt: string;
    taskId: string;
    taskKind: "record-update" | "record-batch-update";
    admissionIdentity: SchedulerAdmissionIdentity;
    ledgerPath: string;
    ledgerRevision: number;
    ledgerHash: string;
    ledgerAnchor: SchedulerLedgerAnchor;
    capsuleRef: ImmutableBlobReference;
}

export interface SchedulerTaskLedger {
    taskId: string;
    schedulerEpoch: number;
    state: TaskState;
    requestMode: "update" | "batch_update";
    candidateSnapshotId: string;
    candidateSnapshotRevision: number;
    admissionIdentity: SchedulerAdmissionIdentity;
    admission: SchedulerTaskAdmission;
    createdAt: string;
    updatedAt: string;
    cancelRequestedAt?: string;
    terminalState?: Extract<TaskState, "Succeeded" | "Deferred" | "FailedFinal" | "Cancelled" | "RepairRequired">;
    repairState: RepairState;
    sourceResolution?: SchedulerSourceResolution;
    recordItems: { total: number; succeeded: number; failed: number; unresolved: number };
    units: { materialized: number; eligible: number; running: number; done: number; failed: number };
    aheadTaskCount: number;
}

export interface SchedulerUnitLedger {
    unitId: string;
    taskId: string;
    recordId: string;
    state: UnitState;
    layer: string;
    parentUnitId?: string;
    splitDepth: number;
    recordWorkKey: string;
    recordCommitEpoch: number;
    dependencies: string[];
    continuationKey?: string;
    composeOrder: number;
    sourceSnapshotId: string;
    inputHash: string;
    estimatedCost: number;
    routePlan: ModelRoute[];
    attemptedProviders: SchedulerAttemptProvider[];
    retryBudget: number;
    routeCursor?: number;
    unitAttempts?: number;
    providerAttemptCounts?: Partial<Record<ModelProvider, number>>;
    promptRecipe?: SchedulerUnitPromptRecipe;
    childUnitIds?: string[];
    composeProvenance?: SchedulerUnitComposeProvenance;
    nextEligibleAt?: string;
    enqueueTime: string;
    layerEnterTime: string;
    failureClass?: FailureClass;
    resultRef?: ImmutableBlobReference;
    coveredRevision?: string;
    commitId?: string;
}

export interface SchedulerUnitPromptRecipe {
    recipeVersion: 1;
    templateId: string;
    range: {
        axis: "round" | "step";
        start: number;
        end: number;
    };
    composeOrder: number;
    continuationKey?: string;
}

export interface SchedulerUnitComposeProvenance {
    childUnitIds: string[];
    outputHash: string;
    composedAt: string;
}

export interface SchedulerAttemptLedger {
    attemptId: string;
    unitId: string;
    recordWorkKey: string;
    originTaskIds: string[];
    activeTaskIds: string[];
    state: AttemptState;
    outcome?: AttemptOutcome;
    provider: SchedulerAttemptProvider;
    model: string;
    retryOrdinal?: number;
    trafficClass?: ProviderTrafficClass;
    dispatchIntentAt?: string;
    dispatchIntentLedgerRevision?: number;
    dispatchIntentRef?: ImmutableBlobReference;
    startedAt?: string;
    leaseExpiresAt?: string;
    unknownOutcomeUntil?: string;
    unknownOutcomeAt?: string;
    unknownOutcomeGraceMs?: number;
    providerEvidence?: string;
    capacityGeneration?: number;
    managedByProductionPump?: boolean;
    providerAdmission?: SchedulerAttemptAdmission;
    providerLeaseIdentity?: ProviderLeaseIdentity;
    dispatchPhase?: SchedulerAttemptDispatchPhase;
    claimId?: string;
    permitId?: string;
    dispatchSeq?: number;
    inputHash: string;
    idempotencyKey?: string | null;
    outputRef?: ImmutableBlobReference;
    errorClass?: FailureClass;
    elapsedMs?: number;
    fence: FencingToken;
}

export interface RecordSchedulerLedger {
    schemaVersion: typeof RECORD_SCHEDULER_SCHEMA_VERSION;
    kind: "record-scheduler-ledger";
    revision: number;
    persistedHash: string;
    task: SchedulerTaskLedger;
    candidateSnapshot: CandidateSnapshot;
    sourceSnapshots: RecordSourceSnapshot[];
    sourceMaterialization?: SourceMaterializationLedger;
    recordWork: SchedulerRecordWork[];
    units: SchedulerUnitLedger[];
    attempts: SchedulerAttemptLedger[];
    commits: CommitSnapshot[];
}

export const RECORD_SUCCESS_CONDITION_KEYS = [
    "candidateSnapshotFrozen",
    "sourceSnapshotPersisted",
    "modelOutputBoundAndQualified",
    "bodyAtomicallyWritten",
    "mainIndexPublished",
    "readerIndexConsistent",
    "ledgerConsistent",
    "readBackVerified",
] as const;

export type RecordSuccessConditionKey = typeof RECORD_SUCCESS_CONDITION_KEYS[number];

export interface RecordSuccessConditions {
    candidateSnapshotFrozen: boolean;
    sourceSnapshotPersisted: boolean;
    modelOutputBoundAndQualified: boolean;
    bodyAtomicallyWritten: boolean;
    mainIndexPublished: boolean;
    readerIndexConsistent: boolean;
    ledgerConsistent: boolean;
    readBackVerified: boolean;
}

export interface RecordSuccessAssessment {
    success: boolean;
    conditions: RecordSuccessConditions;
    missingConditions: RecordSuccessConditionKey[];
}

function allRecordedSuccessConditionsTrue(conditions: Partial<RecordSuccessConditions>): boolean {
    return RECORD_SUCCESS_CONDITION_KEYS.every(key => conditions[key] === true);
}

function isCompleteSourceSnapshot(source: RecordSourceSnapshot | undefined): source is RecordSourceSnapshot {
    return source !== undefined
        && source.complete
        && source.contentHash.length > 0
        && source.contentRef.hash === source.contentHash
        && source.contentRef.byteLength >= 0
        && source.readRange.startRound <= 1
        && source.readRange.endRound >= source.readRange.totalRounds
        && source.gaps.length === 0;
}

function isPersistedRefreshForCurrentRevision(commit: CommitSnapshot, source: RecordSourceSnapshot): boolean {
    if (commit.observedSourceRevisionAtCommit === source.desiredRevision) return true;
    const refresh = commit.pendingRefresh;
    return refresh !== undefined
        && refresh.sourceSnapshotId === source.sourceSnapshotId
        && refresh.recordWorkKey === commit.recordWorkKey
        && refresh.chain === source.chain
        && refresh.workspaceHash === source.workspaceHash
        && refresh.conversationId === source.conversationId
        && refresh.fromRevision === source.desiredRevision
        && refresh.desiredRevision === commit.observedSourceRevisionAtCommit
        && refresh.ledgerRevision > 0
        && refresh.ledgerRef.hash.length > 0
        && (refresh.state === "Queued" || refresh.state === "Running")
        && Number.isFinite(Date.parse(refresh.persistedAt));
}

function indexEntryBindsCommit(entry: PublishedIndexEntryEvidence | undefined, commit: CommitSnapshot, source: RecordSourceSnapshot): boolean {
    return entry !== undefined
        && entry.commitId === commit.commitId
        && entry.recordWorkKey === commit.recordWorkKey
        && entry.sourceSnapshotId === source.sourceSnapshotId
        && entry.bodyHash === commit.bodyHash
        && entry.coveredRevision === source.desiredRevision;
}

export function evaluateRecordSuccess(ledger: RecordSchedulerLedger, commitId: string): RecordSuccessAssessment {
    if (!isCurrentRecordSchedulerLedger(ledger)) {
        const conditions = Object.fromEntries(RECORD_SUCCESS_CONDITION_KEYS.map(key => [key, false])) as unknown as RecordSuccessConditions;
        return { success: false, conditions, missingConditions: [...RECORD_SUCCESS_CONDITION_KEYS] };
    }
    const commit = ledger.commits.find(candidate => candidate.commitId === commitId);
    const source = commit ? ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === commit.sourceSnapshotId) : undefined;
    const unit = commit ? ledger.units.find(candidate => candidate.unitId === commit.unitId) : undefined;
    const attempt = commit ? ledger.attempts.find(candidate => candidate.attemptId === commit.attemptId) : undefined;
    const work = commit ? ledger.recordWork.find(candidate => candidate.recordWorkKey === commit.recordWorkKey) : undefined;
    const candidate = source
        ? ledger.candidateSnapshot.candidates.find(entry => entry.conversationId === source.conversationId
            && entry.chain === source.chain
            && entry.workspaceHash === source.workspaceHash)
        : undefined;
    const enumeration = source ? ledger.candidateSnapshot.enumerations.find(entry => entry.chain === source.chain) : undefined;

    const candidateSnapshotFrozen = source !== undefined
        && ledger.task.candidateSnapshotId === ledger.candidateSnapshot.snapshotId
        && ledger.task.candidateSnapshotRevision === ledger.candidateSnapshot.snapshotRevision
        && candidate !== undefined
        && isCandidateSelectedForExecution(ledger.candidateSnapshot, candidate)
        && candidate.evidence.length > 0
        && candidate.evidenceHash.length > 0
        && enumeration !== undefined
        && enumeration.complete
        && enumeration.paginationExhausted
        && !enumeration.truncated
        && !enumeration.error;
    const sourceSnapshotPersisted = isCompleteSourceSnapshot(source);
    const modelOutputBoundAndQualified = commit !== undefined
        && source !== undefined
        && unit !== undefined
        && attempt !== undefined
        && commit.qualityResult.accepted
        && unit.state === "Succeeded"
        && unit.commitId === commit.commitId
        && unit.coveredRevision === source.desiredRevision
        && unit.sourceSnapshotId === source.sourceSnapshotId
        && unit.inputHash === commit.inputHash
        && attempt.unitId === unit.unitId
        && attempt.recordWorkKey === commit.recordWorkKey
        && attempt.inputHash === commit.inputHash
        && attempt.state === "KnownSuccess"
        && attempt.outcome === "known_success"
        && unit.attemptedProviders.includes(attempt.provider)
        && attempt.outputRef?.hash === commit.outputHash;
    const bodyAtomicallyWritten = commit !== undefined
        && commit.bodyHash.length > 0
        && commit.bodyRef.hash === commit.bodyHash
        && commit.bodyRef.byteLength >= 0;
    const mainIndexPublished = commit !== undefined
        && source !== undefined
        && commit.mainIndexRevision !== undefined
        && commit.mainIndexRevision.length > 0
        && commit.mainIndexEntry?.revision === commit.mainIndexRevision
        && indexEntryBindsCommit(commit.mainIndexEntry, commit, source)
        && commit.coveredRevision === source.desiredRevision;
    const readerIndexConsistent = commit !== undefined
        && commit.readerIndexRevision !== undefined
        && commit.readerIndexRevision.length > 0
        && commit.readerIndexEntry?.revision === commit.readerIndexRevision
        && source !== undefined
        && indexEntryBindsCommit(commit.readerIndexEntry, commit, source);
    const currentFence = work ? {
        schedulerEpoch: work.schedulerEpoch,
        recordCommitEpoch: work.recordCommitEpoch,
        fencingToken: work.currentFencingToken,
        workLeaseId: work.workLeaseId,
    } : undefined;
    const ledgerConsistent = commit !== undefined
        && source !== undefined
        && unit !== undefined
        && attempt !== undefined
        && work !== undefined
        && commit.taskId === ledger.task.taskId
        && unit.taskId === ledger.task.taskId
        && unit.state === "Succeeded"
        && unit.commitId === commit.commitId
        && unit.recordWorkKey === work.recordWorkKey
        && unit.recordCommitEpoch === work.recordCommitEpoch
        && unit.sourceSnapshotId === source.sourceSnapshotId
        && work.conversationId === source.conversationId
        && work.chain === source.chain
        && work.workspaceHash === source.workspaceHash
        && work.desiredRevision === source.desiredRevision
        && ledger.task.schedulerEpoch === work.schedulerEpoch
        && currentFence !== undefined
        && hasCurrentFencingToken(currentFence, attempt.fence)
        && hasCurrentFencingToken(currentFence, commit.fence)
        && commit.state === "Verified"
        && commit.cleanupPhase === "NotRequired"
        && allRecordedSuccessConditionsTrue(commit.successConditions);
    const readBackVerified = commit !== undefined
        && source !== undefined
        && commit.verifiedAt !== undefined
        && commit.readBack !== undefined
        && commit.readBack.verifiedAt === commit.verifiedAt
        && commit.readBack.bodyHash === commit.bodyHash
        && commit.readBack.mainIndexRevision === commit.mainIndexRevision
        && commit.readBack.readerIndexRevision === commit.readerIndexRevision
        && isPersistedRefreshForCurrentRevision(commit, source);
    const conditions: RecordSuccessConditions = {
        candidateSnapshotFrozen,
        sourceSnapshotPersisted,
        modelOutputBoundAndQualified,
        bodyAtomicallyWritten,
        mainIndexPublished,
        readerIndexConsistent,
        ledgerConsistent,
        readBackVerified,
    };
    const missingConditions = RECORD_SUCCESS_CONDITION_KEYS.filter(key => !conditions[key]);
    return { success: missingConditions.length === 0, conditions, missingConditions };
}

export function isRecordSuccess(ledger: RecordSchedulerLedger, commitId: string): boolean {
    return evaluateRecordSuccess(ledger, commitId).success;
}

function hasOnlyAcceptedSourceMaterialization(ledger: RecordSchedulerLedger): boolean {
    const materialization = ledger.sourceMaterialization;
    return materialization === undefined
        || (materialization.phase === "sealed" && materialization.outcomes.every(outcome => outcome.kind === "accepted"));
}

function isSourceSnapshotMaterializationAccepted(ledger: RecordSchedulerLedger, source: RecordSourceSnapshot | undefined): boolean {
    const materialization = ledger.sourceMaterialization;
    if (materialization === undefined) return true;
    if (source === undefined || materialization.phase !== "sealed") return false;
    return materialization.outcomes.some(outcome => {
        if (outcome.kind !== "accepted" || outcome.sourceSnapshotId !== source.sourceSnapshotId) return false;
        const selection = materialization.selected.find(candidate => candidate.sourceKey === outcome.sourceKey);
        return selection !== undefined && sourceSnapshotMatchesMaterializationSelection(source, selection);
    });
}

export function canReportSchedulerLedgerSuccess(ledger: RecordSchedulerLedger): boolean {
    if (!isCurrentRecordSchedulerLedger(ledger)) return false;
    if (ledger.task.state !== "Succeeded") return false;
    if (!hasOnlyAcceptedSourceMaterialization(ledger)) return false;
    const counts = ledger.task.recordItems;
    if (counts.total !== counts.succeeded + counts.failed + counts.unresolved || counts.failed !== 0 || counts.unresolved !== 0) return false;
    if (ledger.task.units.running !== 0 || ledger.task.units.eligible !== 0 || ledger.task.units.failed !== 0 || ledger.task.units.done !== ledger.units.length) return false;
    if (ledger.units.some(unit => unit.state !== "Succeeded" && unit.state !== "Superseded")) return false;
    if (counts.total === 0) return ledger.units.length === 0 && ledger.attempts.length === 0 && ledger.commits.length === 0;
    const verifiedCommits = ledger.commits.filter(commit => commit.state === "Verified");
    const distinctWork = new Set(verifiedCommits.map(commit => commit.recordWorkKey));
    return verifiedCommits.length === ledger.commits.length
        && verifiedCommits.length === counts.succeeded
        && distinctWork.size === counts.succeeded
        && verifiedCommits.every(commit => isRecordSuccess(ledger, commit.commitId));
}

export function isSourceSnapshotCovered(
    sourceSnapshot: Pick<RecordSourceSnapshot, "complete" | "contentHash" | "desiredRevision">,
    coveredRevision: string | null | undefined,
): boolean {
    return sourceSnapshot.complete && sourceSnapshot.contentHash.length > 0 && coveredRevision === sourceSnapshot.desiredRevision;
}

export function hasCurrentFencingToken(current: FencingToken, candidate: FencingToken): boolean {
    return current.schedulerEpoch === candidate.schedulerEpoch
        && current.recordCommitEpoch === candidate.recordCommitEpoch
        && current.fencingToken === candidate.fencingToken
        && current.workLeaseId === candidate.workLeaseId;
}

export function assertCurrentFencingToken(current: FencingToken, candidate: FencingToken): void {
    if (!hasCurrentFencingToken(current, candidate)) throw new Error("过期 fencing token 不得派发或提交");
}

export const PERSISTENCE_BARRIERS = [
    "TaskLedgerCreated",
    "TaskEnvelopePublished",
    "CandidateSnapshotFrozen",
    "SourceSnapshotPersisted",
    "RecordWorkLeasePersisted",
    "AttemptDispatchIntentPersisted",
    "OutputSpoolPersisted",
    "BodyStageIntentPersisted",
    "PublishIntentPersisted",
    "BodyPublished",
    "MainIndexWritten",
    "ReaderIndexWritten",
    "CommitVerified",
    "CleanupIntentPersisted",
    "CleanupVerified",
] as const;

export type PersistenceBarrier = typeof PERSISTENCE_BARRIERS[number];

export interface AttemptDispatchDurabilityReceipt {
    verifier: "record-scheduler-store";
    verifiedAt: string;
    ledgerRevision: number;
    ledgerHash: string;
    admissionLedgerAnchor: SchedulerLedgerAnchor;
    admissionCapsuleRef: ImmutableBlobReference;
    candidateSnapshotId: string;
    candidateSnapshotRevision: number;
    candidateSnapshotRef: ImmutableBlobReference;
    sourceSnapshotId: string;
    sourceSnapshotRevision: number;
    sourceSnapshotRef: ImmutableBlobReference;
    recordWorkKey: string;
    registryRevision: number;
    registryRef: ImmutableBlobReference;
    workLeaseId: string;
    attemptId: string;
    attemptIntentLedgerRevision: number;
    attemptIntentRef: ImmutableBlobReference;
    inputHash: string;
    fence: FencingToken;
}

export interface AttemptDispatchBarrier {
    ledger: RecordSchedulerLedger;
    attemptId: string;
    durabilityReceipt: AttemptDispatchDurabilityReceipt;
    nowMs?: number;
}

export function isAttemptDispatchAllowed(barrier: AttemptDispatchBarrier): boolean {
    const { ledger } = barrier;
    if (!isCurrentRecordSchedulerLedger(ledger)) return false;
    const attempt = ledger.attempts.find(candidate => candidate.attemptId === barrier.attemptId);
    const unit = attempt ? ledger.units.find(candidate => candidate.unitId === attempt.unitId) : undefined;
    const source = unit ? ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === unit.sourceSnapshotId) : undefined;
    const work = unit ? ledger.recordWork.find(candidate => candidate.recordWorkKey === unit.recordWorkKey) : undefined;
    const candidate = source ? ledger.candidateSnapshot.candidates.find(entry => entry.conversationId === source.conversationId
        && entry.chain === source.chain
        && entry.workspaceHash === source.workspaceHash) : undefined;
    const enumeration = source ? ledger.candidateSnapshot.enumerations.find(entry => entry.chain === source.chain) : undefined;
    const nowMs = barrier.nowMs ?? Date.now();
    const currentFence = work ? {
        schedulerEpoch: work.schedulerEpoch,
        recordCommitEpoch: work.recordCommitEpoch,
        fencingToken: work.currentFencingToken,
        workLeaseId: work.workLeaseId,
    } : undefined;
    const receipt = barrier.durabilityReceipt;
    return ledger.revision > 0
        && canDispatchTask(ledger.task.state, ledger.task.repairState)
        && attempt?.state === "DispatchIntentPersisted"
        && attempt.activeTaskIds.includes(ledger.task.taskId)
        && unit?.state === "Running"
        && candidate !== undefined
        && isCandidateSelectedForExecution(ledger.candidateSnapshot, candidate)
        && candidate.evidence.length > 0
        && isCompleteSourceSnapshot(source)
        && isSourceSnapshotMaterializationAccepted(ledger, source)
        && enumeration !== undefined
        && enumeration.complete
        && enumeration.paginationExhausted
        && !enumeration.truncated
        && !enumeration.error
        && work !== undefined
        && work.activeTaskIds.includes(ledger.task.taskId)
        && Date.parse(work.leaseExpiresAt) > nowMs
        && currentFence !== undefined
        && hasCurrentFencingToken(currentFence, attempt.fence)
        && !hasBlockingUnknownOutcome(ledger, nowMs)
        && !hasExpiredUnknownOutcomeAwaitingFenceAdvance(ledger, nowMs)
        && receipt.verifier === "record-scheduler-store"
        && Number.isFinite(Date.parse(receipt.verifiedAt))
        && receipt.ledgerRevision === ledger.revision
        && receipt.ledgerHash === ledger.persistedHash
        && isEnvelopeBoundAdmission(ledger.task.admission)
        && sameLedgerAnchor(receipt.admissionLedgerAnchor, ledger.task.admission.ledgerAnchor)
        && sameBlobReference(receipt.admissionCapsuleRef, ledger.task.admission.capsuleRef)
        && receipt.candidateSnapshotId === ledger.candidateSnapshot.snapshotId
        && receipt.candidateSnapshotRevision === ledger.candidateSnapshot.snapshotRevision
        && sameBlobReference(receipt.candidateSnapshotRef, ledger.candidateSnapshot.snapshotRef)
        && receipt.sourceSnapshotId === source.sourceSnapshotId
        && receipt.sourceSnapshotRevision === source.snapshotRevision
        && sameBlobReference(receipt.sourceSnapshotRef, source.snapshotRef)
        && receipt.recordWorkKey === work.recordWorkKey
        && receipt.registryRevision === work.registryRevision
        && sameBlobReference(receipt.registryRef, work.registryRef)
        && receipt.workLeaseId === work.workLeaseId
        && receipt.attemptId === attempt.attemptId
        && receipt.attemptIntentLedgerRevision === attempt.dispatchIntentLedgerRevision
        && attempt.dispatchIntentRef !== undefined
        && sameBlobReference(receipt.attemptIntentRef, attempt.dispatchIntentRef)
        && receipt.inputHash === attempt.inputHash
        && hasCurrentFencingToken(receipt.fence, attempt.fence);
}

export const RECORD_SCHEDULER_FAULT_POINTS = [
    "before-task-ledger-write",
    "after-task-ledger-write",
    "before-admission-capsule-publish",
    "after-admission-capsule-temp-sync",
    "after-admission-capsule-publish",
    "before-task-envelope-publish",
    "after-task-envelope-publish",
    "before-candidate-snapshot-write",
    "after-candidate-snapshot-write",
    "before-source-snapshot-write",
    "after-source-snapshot-write",
    "before-record-work-lease-write",
    "after-record-work-lease-write",
    "before-attempt-dispatch-intent",
    "after-attempt-dispatch-intent",
    "after-rpc-send-before-response",
    "before-output-spool-write",
    "after-output-spool-write",
    "before-body-write",
    "after-body-write",
    "before-publish-intent",
    "after-publish-intent",
    "before-main-index-write",
    "after-main-index-write",
    "before-reader-index-write",
    "after-reader-index-write",
    "before-commit-verified",
    "after-commit-verified",
    "before-cleanup-intent",
    "after-cleanup-intent",
    "before-cleanup-compensation",
    "after-cleanup-compensation",
    "before-cleanup-verify",
    "after-cleanup-verified",
] as const;

export type RecordSchedulerFaultPoint = typeof RECORD_SCHEDULER_FAULT_POINTS[number];

export interface CancellationCompletionEvidence {
    ledger: RecordSchedulerLedger;
    taskSpoolVisible: boolean;
    nowMs?: number;
}

function isCancellationUnitSettled(state: UnitState): boolean {
    return state === "Succeeded"
        || state === "FailedFinal"
        || state === "Cancelled"
        || state === "Discarded"
        || state === "Superseded";
}

function isCancellationAttemptSettled(attempt: Pick<SchedulerAttemptLedger, "state" | "unknownOutcomeUntil">, nowMs: number): boolean {
    if (attempt.state === "KnownFailure" || attempt.state === "Discarded") return true;
    if (attempt.state !== "UnknownOutcome" || !attempt.unknownOutcomeUntil) return false;
    const unknownUntil = Date.parse(attempt.unknownOutcomeUntil);
    return Number.isFinite(unknownUntil) && unknownUntil <= nowMs;
}

function isCancellationCommitInvisible(commit: CommitSnapshot): boolean {
    if (commit.state === "Compensated") return commit.cleanupPhase === "Verified" && cleanupReadBackProvesCommitInvisible(commit);
    return (commit.state === "NotStarted" || commit.state === "ResultReady" || commit.state === "BodyStaged" || commit.state === "Abandoned")
        && commit.cleanupPhase === "NotRequired";
}

export function isCancellationCleanupComplete(evidence: CancellationCompletionEvidence): boolean {
    if (!isCurrentRecordSchedulerLedger(evidence.ledger)) return false;
    const nowMs = evidence.nowMs ?? Date.now();
    const { task, units, attempts, recordWork, commits } = evidence.ledger;
    const commitsById = new Map(commits.map(commit => [commit.commitId, commit]));
    const workByKey = new Map(recordWork.map(work => [work.recordWorkKey, work]));
    const commitSafeForCancellation = (commit: CommitSnapshot): boolean => {
        const work = workByKey.get(commit.recordWorkKey);
        if (!work) return false;
        if (commit.ownership.mode === "task_exclusive") {
            return commit.ownership.ownerTaskId === task.taskId
                && work.activeTaskIds.length === 0
                && isCancellationCommitInvisible(commit);
        }
        if (commit.state === "Compensated" || commit.state === "CleanupPending") return false;
        return work.activeTaskIds.some(taskId => taskId !== task.taskId && commit.ownership.mode === "shared" && commit.ownership.ownerTaskIds.includes(taskId));
    };
    return task.state === "Cancelling"
        && task.repairState === "None"
        && !evidence.taskSpoolVisible
        && units.every(unit => isCancellationUnitSettled(unit.state))
        && units.every(unit => {
            if (unit.state !== "Succeeded" || unit.commitId === undefined) return unit.state !== "Succeeded";
            const commit = commitsById.get(unit.commitId);
            return commit !== undefined && commitSafeForCancellation(commit);
        })
        && attempts.every(attempt => !attempt.activeTaskIds.includes(task.taskId)
            && (attempt.activeTaskIds.length > 0 || isCancellationAttemptSettled(attempt, nowMs)))
        && recordWork.every(work => !work.activeTaskIds.includes(task.taskId))
        && commits.every(commit => commit.taskId === task.taskId && commitSafeForCancellation(commit));
}

export interface LegacyBatchLedger {
    version: 1 | 2;
    resumeKey: string;
    updatedAt?: string;
    candidates: unknown[];
    completed: unknown[];
    skipped: unknown[];
    failed: unknown[];
    inFlight: unknown[];
}

export type ReadonlyLegacyBatchLedger = Readonly<Omit<LegacyBatchLedger, "candidates" | "completed" | "skipped" | "failed" | "inFlight">> & {
    readonly candidates: readonly unknown[];
    readonly completed: readonly unknown[];
    readonly skipped: readonly unknown[];
    readonly failed: readonly unknown[];
    readonly inFlight: readonly unknown[];
};

export interface LegacyBatchLedgerMigrationBoundary {
    sourceVersion: 1 | 2;
    readOnly: true;
    canDispatch: false;
    canRecoverDispatch: false;
    canReportSuccess: false;
    requiresCandidateSnapshot: true;
    requiresSourceSnapshots: true;
}

export type SchedulerLedgerReadResult =
    | { kind: "current"; ledger: RecordSchedulerLedger; canDispatch: boolean; canRecoverDispatch: boolean; canReportSuccess: boolean }
    | { kind: "legacy"; ledger: ReadonlyLegacyBatchLedger; boundary: LegacyBatchLedgerMigrationBoundary; canDispatch: false; canRecoverDispatch: false; canReportSuccess: false }
    | { kind: "repair_required"; reason: "invalid_current_ledger"; canDispatch: false; canRecoverDispatch: false; canReportSuccess: false }
    | { kind: "rejected"; reason: "invalid" | "unsupported_schema" | "future_schema" | "future_legacy_version"; canDispatch: false; canRecoverDispatch: false; canReportSuccess: false };

export interface SchedulerLedgerReadOptions {
    nowMs?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
    return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
    return value === undefined || isNonEmptyString(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isUnique(values: readonly string[]): boolean {
    return new Set(values).size === values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every(value => right.includes(value));
}

function hasSortedUniqueSourceKeys(entries: readonly { sourceKey: string }[]): boolean {
    return entries.every((entry, index) => index === 0 || entries[index - 1].sourceKey < entry.sourceKey);
}

function includesValue<Value extends string>(values: readonly Value[], value: unknown): value is Value {
    return typeof value === "string" && values.includes(value as Value);
}

function isValidBlobReference(value: unknown): value is ImmutableBlobReference {
    return isPlainObject(value)
        && isNonEmptyString(value.path)
        && isNonEmptyString(value.hash)
        && isNonNegativeInteger(value.byteLength);
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sameBlobReference(left: ImmutableBlobReference, right: ImmutableBlobReference): boolean {
    return left.path === right.path && left.hash === right.hash && left.byteLength === right.byteLength;
}

function isValidLedgerAnchor(value: unknown): value is SchedulerLedgerAnchor {
    return isPlainObject(value)
        && isNonEmptyString(value.path)
        && value.revision === 1
        && isSha256(value.hash);
}

function isValidAdmissionIdentity(value: unknown): value is SchedulerAdmissionIdentity {
    return isPlainObject(value)
        && isNonEmptyString(value.requestKey)
        && value.requestKey.length <= 512
        && isSha256(value.requestHash);
}

function sameLedgerAnchor(left: SchedulerLedgerAnchor, right: SchedulerLedgerAnchor): boolean {
    return left.path === right.path && left.revision === right.revision && left.hash === right.hash;
}

function isValidTaskAdmission(value: unknown): value is SchedulerTaskAdmission {
    if (!isPlainObject(value) || typeof value.state !== "string") return false;
    if (value.state === "LedgerCreated") return Object.keys(value).length === 1;
    return value.state === "EnvelopeBound"
        && isValidLedgerAnchor(value.ledgerAnchor)
        && isValidBlobReference(value.capsuleRef)
        && isSha256(value.capsuleRef.hash)
        && isTimestamp(value.boundAt);
}

function isValidCounterObject(value: unknown, keys: readonly string[]): value is Record<string, number> {
    return isPlainObject(value) && keys.every(key => isNonNegativeInteger(value[key]));
}

function isValidSuccessConditions(value: unknown): value is RecordSuccessConditions {
    return isPlainObject(value) && RECORD_SUCCESS_CONDITION_KEYS.every(key => typeof value[key] === "boolean");
}

function isValidConditionalBeforeImage(value: unknown): value is ConditionalBeforeImage {
    if (!isPlainObject(value) || !isNonEmptyString(value.path) || typeof value.existed !== "boolean") return false;
    if (value.contentRef !== undefined && !isValidBlobReference(value.contentRef)) return false;
    if (!value.existed) return value.revision === undefined && value.hash === undefined && value.contentRef === undefined;
    return isNonEmptyString(value.revision)
        && isNonEmptyString(value.hash)
        && isValidBlobReference(value.contentRef)
        && value.contentRef.hash === value.hash;
}

function isValidCommitBeforeImageBundle(value: unknown): value is CommitBeforeImageBundle {
    return isPlainObject(value)
        && isNonEmptyString(value.commitId)
        && isTimestamp(value.capturedAt)
        && isValidConditionalBeforeImage(value.body)
        && isValidConditionalBeforeImage(value.mainIndexEntry)
        && isValidConditionalBeforeImage(value.readerIndexEntry)
        && isValidFence(value.fence);
}

function isValidPendingRefresh(value: unknown): value is PendingRefreshReference {
    return isPlainObject(value)
        && isNonEmptyString(value.refreshKey)
        && isNonEmptyString(value.refreshTaskId)
        && isNonEmptyString(value.sourceSnapshotId)
        && isNonEmptyString(value.recordWorkKey)
        && includesValue(SOURCE_CHAINS, value.chain)
        && isNonEmptyString(value.workspaceHash)
        && isNonEmptyString(value.conversationId)
        && isNonEmptyString(value.fromRevision)
        && isNonEmptyString(value.desiredRevision)
        && isTimestamp(value.persistedAt)
        && isPositiveInteger(value.ledgerRevision)
        && isValidBlobReference(value.ledgerRef)
        && includesValue(["Queued", "Running"], value.state);
}

function isValidPublishedIndexEntry(value: unknown): value is PublishedIndexEntryEvidence {
    return isPlainObject(value)
        && isNonEmptyString(value.revision)
        && isNonEmptyString(value.entryHash)
        && isNonEmptyString(value.commitId)
        && isNonEmptyString(value.recordWorkKey)
        && isNonEmptyString(value.sourceSnapshotId)
        && isNonEmptyString(value.bodyHash)
        && isNonEmptyString(value.coveredRevision);
}

function samePublishedIndexEntry(left: PublishedIndexEntryEvidence, right: PublishedIndexEntryEvidence): boolean {
    return left.revision === right.revision
        && left.entryHash === right.entryHash
        && left.commitId === right.commitId
        && left.recordWorkKey === right.recordWorkKey
        && left.sourceSnapshotId === right.sourceSnapshotId
        && left.bodyHash === right.bodyHash
        && left.coveredRevision === right.coveredRevision;
}

function isValidCommitOwnership(value: unknown): value is CommitOwnership {
    if (!isPlainObject(value)) return false;
    if (value.mode === "task_exclusive") return isNonEmptyString(value.ownerTaskId);
    return value.mode === "shared"
        && Array.isArray(value.ownerTaskIds)
        && value.ownerTaskIds.length > 0
        && value.ownerTaskIds.every(isNonEmptyString)
        && isUnique(value.ownerTaskIds);
}

function isValidReadBack(value: unknown): value is CommitReadBackVerification {
    return isPlainObject(value)
        && isTimestamp(value.verifiedAt)
        && isNonEmptyString(value.bodyHash)
        && isNonEmptyString(value.mainIndexRevision)
        && isNonEmptyString(value.readerIndexRevision)
        && isValidPublishedIndexEntry(value.mainIndexEntry)
        && isValidPublishedIndexEntry(value.readerIndexEntry);
}

function isValidCleanupTargetReadBack(value: unknown): value is CleanupTargetReadBack {
    return isPlainObject(value)
        && isNonEmptyString(value.path)
        && value.taskCommitVisible === false
        && includesValue(["absent", "restored_before_image", "superseded_by_higher_epoch"], value.disposition)
        && isOptionalString(value.observedHash)
        && isOptionalString(value.observedRevision)
        && isOptionalString(value.observedCommitId)
        && isOptionalString(value.observedRecordWorkKey)
        && (value.observedRecordCommitEpoch === undefined || isPositiveInteger(value.observedRecordCommitEpoch));
}

function isValidSupersedingCommit(value: unknown): value is SupersedingCommitEvidence {
    return isPlainObject(value)
        && isNonEmptyString(value.commitId)
        && isNonEmptyString(value.recordWorkKey)
        && isPositiveInteger(value.recordCommitEpoch)
        && isNonEmptyString(value.bodyHash)
        && isNonEmptyString(value.mainIndexEntryHash)
        && isNonEmptyString(value.readerIndexEntryHash);
}

function isValidCleanupReadBack(value: unknown): value is CleanupReadBackVerification {
    return isPlainObject(value)
        && isNonEmptyString(value.commitId)
        && isNonEmptyString(value.taskId)
        && isNonEmptyString(value.recordWorkKey)
        && isTimestamp(value.verifiedAt)
        && isPositiveInteger(value.registryRevision)
        && isValidCleanupTargetReadBack(value.body)
        && isValidCleanupTargetReadBack(value.mainIndexEntry)
        && isValidCleanupTargetReadBack(value.readerIndexEntry)
        && (value.supersedingCommit === undefined || isValidSupersedingCommit(value.supersedingCommit))
        && isValidFence(value.fence);
}

function cleanupTargetProvesInvisible(target: CleanupTargetReadBack, beforeImage: ConditionalBeforeImage): boolean {
    if (target.path !== beforeImage.path || target.taskCommitVisible !== false) return false;
    if (target.disposition === "absent") return !beforeImage.existed;
    if (target.disposition === "restored_before_image") {
        return beforeImage.existed
            && target.observedHash === beforeImage.hash
            && target.observedRevision === beforeImage.revision;
    }
    return true;
}

function cleanupReadBackProvesCommitInvisible(commit: CommitSnapshot): boolean {
    const proof = commit.cleanupReadBack;
    const beforeImage = commit.beforeImage;
    return proof !== undefined
        && beforeImage !== undefined
        && proof.commitId === commit.commitId
        && proof.taskId === commit.taskId
        && proof.recordWorkKey === commit.recordWorkKey
        && proof.registryRevision > 0
        && hasCurrentFencingToken(proof.fence, commit.fence)
        && cleanupTargetProvesInvisible(proof.body, beforeImage.body)
        && cleanupTargetProvesInvisible(proof.mainIndexEntry, beforeImage.mainIndexEntry)
        && cleanupTargetProvesInvisible(proof.readerIndexEntry, beforeImage.readerIndexEntry)
        && (() => {
            const targets = [proof.body, proof.mainIndexEntry, proof.readerIndexEntry];
            const superseded = targets.some(target => target.disposition === "superseded_by_higher_epoch");
            if (!superseded) return proof.supersedingCommit === undefined;
            const successor = proof.supersedingCommit;
            return successor !== undefined
                && successor.recordCommitEpoch > commit.fence.recordCommitEpoch
                && targets.every(target => target.disposition === "superseded_by_higher_epoch"
                    && target.observedRecordCommitEpoch === successor.recordCommitEpoch
                    && target.observedCommitId === successor.commitId
                    && target.observedRecordWorkKey === successor.recordWorkKey)
                && proof.body.observedHash === successor.bodyHash
                && proof.mainIndexEntry.observedHash === successor.mainIndexEntryHash
                && proof.readerIndexEntry.observedHash === successor.readerIndexEntryHash;
        })();
}

function isValidCandidateSnapshot(value: unknown): value is CandidateSnapshot {
    if (!isPlainObject(value)
        || value.schemaVersion !== RECORD_SCHEDULER_SCHEMA_VERSION
        || !isNonEmptyString(value.snapshotId)
        || !isPositiveInteger(value.snapshotRevision)
        || !isNonEmptyString(value.snapshotHash)
        || !isValidBlobReference(value.snapshotRef)
        || value.snapshotRef.hash !== value.snapshotHash
        || !isTimestamp(value.createdAt)
        || !includesValue(["normal", "force", "stale_only"], value.requestMode)
        || !isPlainObject(value.filters)
        || !Array.isArray(value.enumerations)
        || !Array.isArray(value.candidates)) return false;

    return value.enumerations.every(entry => isPlainObject(entry)
        && includesValue(SOURCE_CHAINS, entry.chain)
        && typeof entry.complete === "boolean"
        && typeof entry.paginationExhausted === "boolean"
        && typeof entry.truncated === "boolean"
        && isOptionalString(entry.watermark)
        && isOptionalString(entry.error))
        && value.candidates.every(candidate => isPlainObject(candidate)
            && isNonEmptyString(candidate.conversationId)
            && includesValue(SOURCE_CHAINS, candidate.chain)
            && isNonEmptyString(candidate.workspaceHash)
            && includesValue(CANDIDATE_STATES, candidate.state)
            && isStringArray(candidate.evidence)
            && isNonEmptyString(candidate.evidenceHash)
            && isOptionalString(candidate.recordIndexRevision));
}

function isValidTaskLedger(value: unknown): value is SchedulerTaskLedger {
    return isPlainObject(value)
        && isNonEmptyString(value.taskId)
        && isPositiveInteger(value.schedulerEpoch)
        && includesValue(TASK_STATES, value.state)
        && includesValue(["update", "batch_update"], value.requestMode)
        && isNonEmptyString(value.candidateSnapshotId)
        && isPositiveInteger(value.candidateSnapshotRevision)
        && isValidAdmissionIdentity(value.admissionIdentity)
        && isValidTaskAdmission(value.admission)
        && isTimestamp(value.createdAt)
        && isTimestamp(value.updatedAt)
        && (value.cancelRequestedAt === undefined || isTimestamp(value.cancelRequestedAt))
        && includesValue(["None", "Required", "Repairing", "Blocked"], value.repairState)
        && (value.sourceResolution === undefined || isValidSourceResolution(value.sourceResolution, value.state))
        && isValidCounterObject(value.recordItems, ["total", "succeeded", "failed", "unresolved"])
        && value.recordItems.succeeded + value.recordItems.failed + value.recordItems.unresolved <= value.recordItems.total
        && isValidCounterObject(value.units, ["materialized", "eligible", "running", "done", "failed"])
        && isNonNegativeInteger(value.aheadTaskCount)
        && (isTerminalTaskState(value.state) ? value.terminalState === value.state : value.terminalState === undefined)
        && (value.cancelRequestedAt === undefined || value.state === "CancelRequested" || value.state === "Cancelling" || value.state === "Cancelled");
}

function isValidSourceResolution(value: unknown, taskState: TaskState): value is SchedulerSourceResolution {
    if (!isPlainObject(value)
        || !includesValue(["pending", "frozen", "materialized", "deferred"], value.phase)
        || !(value.selectedCount === null || isNonNegativeInteger(value.selectedCount))
        || !isNonNegativeInteger(value.materializedCount)
        || !isNonNegativeInteger(value.unresolvedCount)
        || !Array.isArray(value.issues)
        || value.unresolvedCount !== value.issues.length
        || !value.issues.every(issue => isPlainObject(issue)
            && includesValue(SOURCE_CHAINS, issue.host)
            && (issue.conversationId === undefined || isNonEmptyString(issue.conversationId))
            && isNonEmptyString(issue.code)
            && isNonEmptyString(issue.message)
            && isStringArray(issue.evidenceHashes))) return false;
    if (value.selectedCount !== null && value.materializedCount > value.selectedCount) return false;
    if (value.phase === "pending") {
        return value.selectedCount === null
            && value.materializedCount === 0
            && value.unresolvedCount === 0
            && value.deferredReason === undefined;
    }
    if (value.phase === "deferred") {
        return taskState === "Deferred"
            && value.deferredReason === "source_unresolved"
            && value.unresolvedCount > 0;
    }
    return value.deferredReason === undefined;
}

function isValidSourceSnapshot(value: unknown): value is RecordSourceSnapshot {
    return isPlainObject(value)
        && value.schemaVersion === RECORD_SCHEDULER_SCHEMA_VERSION
        && isNonEmptyString(value.sourceSnapshotId)
        && isPositiveInteger(value.snapshotRevision)
        && isNonEmptyString(value.snapshotHash)
        && isValidBlobReference(value.snapshotRef)
        && value.snapshotRef.hash === value.snapshotHash
        && isNonEmptyString(value.conversationId)
        && includesValue(SOURCE_CHAINS, value.chain)
        && isNonEmptyString(value.workspaceHash)
        && isNonEmptyString(value.sourceRevision)
        && isNonEmptyString(value.desiredRevision)
        && isNonEmptyString(value.contentHash)
        && isValidBlobReference(value.contentRef)
        && value.contentRef.hash === value.contentHash
        && isNonEmptyString(value.formatterVersion)
        && isPlainObject(value.readRange)
        && isNonNegativeInteger(value.readRange.startRound)
        && isNonNegativeInteger(value.readRange.endRound)
        && isNonNegativeInteger(value.readRange.totalRounds)
        && value.readRange.endRound >= value.readRange.startRound
        && typeof value.complete === "boolean"
        && isStringArray(value.gaps)
        && isStringArray(value.parseWarnings)
        && isOptionalString(value.eventWatermark)
        && (!value.complete || (value.sourceRevision === value.desiredRevision
            && value.readRange.startRound <= 1
            && value.readRange.endRound >= value.readRange.totalRounds
            && value.gaps.length === 0));
}

function isValidSourceMaterializationSelection(value: unknown): value is SourceMaterializationSelection {
    return isPlainObject(value)
        && isNonEmptyString(value.sourceKey)
        && includesValue(SOURCE_CHAINS, value.chain)
        && isNonEmptyString(value.workspaceHash)
        && isNonEmptyString(value.conversationId)
        && includesValue(CANDIDATE_STATES, value.candidateState)
        && isNonEmptyString(value.evidenceHash);
}

function isValidSourceMaterializationOutcome(value: unknown): value is SourceMaterializationOutcome {
    return isPlainObject(value)
        && isNonEmptyString(value.sourceKey)
        && includesValue(["accepted", "unresolved", "conflict"] as const, value.kind)
        && isTimestamp(value.observedAt)
        && isOptionalNonEmptyString(value.sourceSnapshotId)
        && isOptionalNonEmptyString(value.sourceRevision)
        && isOptionalNonEmptyString(value.contentHash)
        && isOptionalNonEmptyString(value.previousContentHash)
        && isOptionalNonEmptyString(value.evidenceHash)
        && isOptionalNonEmptyString(value.scanId)
        && isOptionalNonEmptyString(value.reason);
}

function sourceSnapshotMatchesMaterializationSelection(source: RecordSourceSnapshot, selection: SourceMaterializationSelection): boolean {
    return source.chain === selection.chain
        && source.workspaceHash === selection.workspaceHash
        && source.conversationId === selection.conversationId;
}

function isValidSourceMaterializationLedger(value: unknown, ledger: RecordSchedulerLedger): value is SourceMaterializationLedger {
    if (!isPlainObject(value)
        || value.schemaVersion !== 1
        || !includesValue(["intent", "sealed"] as const, value.phase)
        || !isNonEmptyString(value.candidateSnapshotId)
        || !isNonEmptyString(value.candidateSnapshotHash)
        || !isNonEmptyString(value.selectionHash)
        || !Array.isArray(value.selected)
        || !value.selected.every(isValidSourceMaterializationSelection)
        || !Array.isArray(value.outcomes)
        || !value.outcomes.every(isValidSourceMaterializationOutcome)
        || (value.markerRef !== undefined && !isValidBlobReference(value.markerRef))) return false;

    if (value.candidateSnapshotId !== ledger.candidateSnapshot.snapshotId
        || value.candidateSnapshotHash !== ledger.candidateSnapshot.snapshotHash
        || !hasSortedUniqueSourceKeys(value.selected)
        || !hasSortedUniqueSourceKeys(value.outcomes)) return false;

    const selections = new Map(value.selected.map(selection => [selection.sourceKey, selection]));
    const sources = new Map(ledger.sourceSnapshots.map(source => [source.sourceSnapshotId, source]));
    for (const selection of value.selected) {
        const candidate = ledger.candidateSnapshot.candidates.find(entry => entry.chain === selection.chain
            && entry.workspaceHash === selection.workspaceHash
            && entry.conversationId === selection.conversationId
            && entry.state === selection.candidateState
            && entry.evidenceHash === selection.evidenceHash);
        if (!candidate) return false;
    }

    for (const outcome of value.outcomes) {
        const selection = selections.get(outcome.sourceKey);
        if (!selection) return false;
        const source = outcome.sourceSnapshotId === undefined ? undefined : sources.get(outcome.sourceSnapshotId);
        if (outcome.sourceSnapshotId !== undefined && (!source || !sourceSnapshotMatchesMaterializationSelection(source, selection))) return false;
        if (source && ((outcome.sourceRevision !== undefined && outcome.sourceRevision !== source.sourceRevision)
            || (outcome.contentHash !== undefined && outcome.contentHash !== source.contentHash))) return false;
        if (outcome.kind === "accepted" && !source) return false;
        if (outcome.kind === "unresolved" && outcome.sourceSnapshotId !== undefined) return false;
        if (outcome.kind === "conflict" && !source
            && (!isNonEmptyString(outcome.sourceRevision)
                || !isNonEmptyString(outcome.contentHash)
                || !isNonEmptyString(outcome.previousContentHash)
                || !isNonEmptyString(outcome.evidenceHash)
                || !isNonEmptyString(outcome.scanId)
                || !isNonEmptyString(outcome.reason))) return false;
    }

    if (value.phase === "intent") return value.markerRef === undefined;
    return value.markerRef !== undefined && value.outcomes.length === value.selected.length;
}

function isValidRecordWork(value: unknown): value is SchedulerRecordWork {
    return isPlainObject(value)
        && isNonEmptyString(value.recordWorkKey)
        && isNonEmptyString(value.conversationId)
        && includesValue(SOURCE_CHAINS, value.chain)
        && isNonEmptyString(value.workspaceHash)
        && isNonEmptyString(value.desiredRevision)
        && isPositiveInteger(value.recordCommitEpoch)
        && isPositiveInteger(value.registryRevision)
        && isValidBlobReference(value.registryRef)
        && isPositiveInteger(value.schedulerEpoch)
        && isNonEmptyString(value.workLeaseId)
        && isNonEmptyString(value.leaseOwnerId)
        && isTimestamp(value.leaseExpiresAt)
        && Array.isArray(value.activeTaskIds)
        && value.activeTaskIds.every(isNonEmptyString)
        && isUnique(value.activeTaskIds)
        && isPositiveInteger(value.currentFencingToken);
}

function isValidUnit(value: unknown): value is SchedulerUnitLedger {
    return isPlainObject(value)
        && isNonEmptyString(value.unitId)
        && isNonEmptyString(value.taskId)
        && isNonEmptyString(value.recordId)
        && includesValue(UNIT_STATES, value.state)
        && isNonEmptyString(value.layer)
        && isOptionalString(value.parentUnitId)
        && isNonNegativeInteger(value.splitDepth)
        && isNonEmptyString(value.recordWorkKey)
        && isPositiveInteger(value.recordCommitEpoch)
        && isStringArray(value.dependencies)
        && isUnique(value.dependencies)
        && isOptionalString(value.continuationKey)
        && isNonNegativeInteger(value.composeOrder)
        && isNonEmptyString(value.sourceSnapshotId)
        && isNonEmptyString(value.inputHash)
        && isNonNegativeFiniteNumber(value.estimatedCost)
        && Array.isArray(value.routePlan)
        && value.routePlan.every((provider: unknown) => includesValue(MODEL_ROUTES, provider))
        && Array.isArray(value.attemptedProviders)
        && value.attemptedProviders.every((provider: unknown) => provider === "local" || includesValue(MODEL_PROVIDERS, provider))
        && isNonNegativeInteger(value.retryBudget)
        && (value.routeCursor === undefined || isNonNegativeInteger(value.routeCursor))
        && (value.unitAttempts === undefined || isNonNegativeInteger(value.unitAttempts))
        && (value.providerAttemptCounts === undefined || isValidProviderAttemptCounts(value.providerAttemptCounts))
        && (value.promptRecipe === undefined || isValidSchedulerUnitPromptRecipe(value.promptRecipe))
        && (value.childUnitIds === undefined || isStringArray(value.childUnitIds) && isUnique(value.childUnitIds))
        && (value.composeProvenance === undefined || isValidSchedulerUnitComposeProvenance(value.composeProvenance))
        && isTimestamp(value.enqueueTime)
        && isTimestamp(value.layerEnterTime)
        && (value.nextEligibleAt === undefined || isTimestamp(value.nextEligibleAt))
        && (value.failureClass === undefined || includesValue(FAILURE_CLASSES, value.failureClass))
        && (value.resultRef === undefined || isValidBlobReference(value.resultRef))
        && isOptionalString(value.coveredRevision)
        && isOptionalString(value.commitId);
}

function isValidProviderAttemptCounts(value: unknown): value is Partial<Record<ModelProvider, number>> {
    if (!isPlainObject(value)) return false;
    return Object.entries(value).every(([provider, count]) => includesValue(MODEL_PROVIDERS, provider) && isNonNegativeInteger(count));
}

function isValidSchedulerUnitPromptRecipe(value: unknown): value is SchedulerUnitPromptRecipe {
    if (!isPlainObject(value) || value.recipeVersion !== 1 || !isNonEmptyString(value.templateId) || !isNonNegativeInteger(value.composeOrder)) return false;
    if (!isPlainObject(value.range)
        || !includesValue(["round", "step"] as const, value.range.axis)
        || !isNonNegativeInteger(value.range.start)
        || !isNonNegativeInteger(value.range.end)
        || value.range.end < value.range.start) return false;
    return value.continuationKey === undefined || isNonEmptyString(value.continuationKey);
}

function isValidSchedulerUnitComposeProvenance(value: unknown): value is SchedulerUnitComposeProvenance {
    return isPlainObject(value)
        && isStringArray(value.childUnitIds)
        && value.childUnitIds.length > 0
        && isUnique(value.childUnitIds)
        && isNonEmptyString(value.outputHash)
        && isTimestamp(value.composedAt);
}

function isValidFence(value: unknown): value is FencingToken {
    return isPlainObject(value)
        && isPositiveInteger(value.schedulerEpoch)
        && isPositiveInteger(value.recordCommitEpoch)
        && isPositiveInteger(value.fencingToken)
        && isNonEmptyString(value.workLeaseId);
}

function isValidAttempt(value: unknown): value is SchedulerAttemptLedger {
    if (!isPlainObject(value)) return false;
    const originTaskIds = value.originTaskIds;
    const activeTaskIds = value.activeTaskIds;
    if (!isNonEmptyString(value.attemptId)
        || !isNonEmptyString(value.unitId)
        || !isNonEmptyString(value.recordWorkKey)
        || !Array.isArray(originTaskIds)
        || originTaskIds.length === 0
        || !originTaskIds.every(isNonEmptyString)
        || !isUnique(originTaskIds)
        || !Array.isArray(activeTaskIds)
        || !activeTaskIds.every(isNonEmptyString)
        || !isUnique(activeTaskIds)
        || activeTaskIds.some(taskId => !originTaskIds.includes(taskId))
        || !includesValue(ATTEMPT_STATES, value.state)
        || (value.provider !== "local" && !includesValue(MODEL_PROVIDERS, value.provider))
        || !isNonEmptyString(value.model)
        || (value.retryOrdinal !== undefined && !isNonNegativeInteger(value.retryOrdinal))
        || (value.trafficClass !== undefined && !includesValue(PROVIDER_TRAFFIC_CLASSES, value.trafficClass))
        || !isNonEmptyString(value.inputHash)
        || !isValidFence(value.fence)
        || (value.dispatchIntentAt !== undefined && !isTimestamp(value.dispatchIntentAt))
        || (value.dispatchIntentLedgerRevision !== undefined && !isPositiveInteger(value.dispatchIntentLedgerRevision))
        || (value.dispatchIntentRef !== undefined && !isValidBlobReference(value.dispatchIntentRef))
        || (value.startedAt !== undefined && !isTimestamp(value.startedAt))
        || (value.leaseExpiresAt !== undefined && !isTimestamp(value.leaseExpiresAt))
        || (value.unknownOutcomeUntil !== undefined && !isTimestamp(value.unknownOutcomeUntil))
        || (value.unknownOutcomeAt !== undefined && !isTimestamp(value.unknownOutcomeAt))
        || (value.unknownOutcomeGraceMs !== undefined && !isPositiveInteger(value.unknownOutcomeGraceMs))
        || (value.providerEvidence !== undefined && !isNonEmptyString(value.providerEvidence))
        || (value.capacityGeneration !== undefined && !isNonNegativeInteger(value.capacityGeneration))
        || (value.managedByProductionPump !== undefined && value.managedByProductionPump !== true)
        || (value.providerAdmission !== undefined && !includesValue(["provider-transport", "synthetic", "local"] as const, value.providerAdmission))
        || (value.providerLeaseIdentity !== undefined && !isValidProviderLeaseIdentity(value.providerLeaseIdentity))
        || (value.dispatchPhase !== undefined && !includesValue(["permit-granted", "attempt-bound", "invoking"] as const, value.dispatchPhase))
        || (value.claimId !== undefined && !isNonEmptyString(value.claimId))
        || (value.permitId !== undefined && !isNonEmptyString(value.permitId))
        || (value.dispatchSeq !== undefined && !isPositiveInteger(value.dispatchSeq))
        || (value.idempotencyKey !== undefined && value.idempotencyKey !== null && !isNonEmptyString(value.idempotencyKey))
        || (value.outputRef !== undefined && !isValidBlobReference(value.outputRef))
        || (value.errorClass !== undefined && !includesValue(FAILURE_CLASSES, value.errorClass))
        || (value.elapsedMs !== undefined && !isNonNegativeFiniteNumber(value.elapsedMs))) return false;

    const expectedOutcome: Record<AttemptState, AttemptOutcome | undefined> = {
        Created: undefined,
        DispatchIntentPersisted: undefined,
        Dispatched: "dispatched",
        KnownSuccess: "known_success",
        KnownFailure: "known_failure",
        UnknownOutcome: "unknown_outcome",
        Discarded: "discarded",
    };
    if (value.outcome !== expectedOutcome[value.state]) return false;
    if (["DispatchIntentPersisted", "Dispatched", "KnownSuccess", "KnownFailure", "UnknownOutcome"].includes(value.state)
        && (!isTimestamp(value.dispatchIntentAt) || !isPositiveInteger(value.dispatchIntentLedgerRevision) || !isValidBlobReference(value.dispatchIntentRef))) return false;
    if (["Dispatched", "KnownSuccess", "KnownFailure", "UnknownOutcome"].includes(value.state)
        && (!isTimestamp(value.startedAt) || !isTimestamp(value.leaseExpiresAt))) return false;
    if (value.state === "KnownSuccess" && !isValidBlobReference(value.outputRef)) return false;
    if (value.state === "KnownFailure" && !includesValue(FAILURE_CLASSES, value.errorClass)) return false;
    const hasClaimBinding = value.dispatchPhase !== undefined
        || value.claimId !== undefined
        || value.permitId !== undefined
        || value.dispatchSeq !== undefined
        || value.providerAdmission !== undefined
        || value.providerLeaseIdentity !== undefined;
    if (hasClaimBinding) {
        if (value.providerAdmission === undefined || value.dispatchPhase === undefined
            || !isNonEmptyString(value.claimId) || !isNonEmptyString(value.permitId)
            || !isPositiveInteger(value.dispatchSeq) || !isNonEmptyString(value.providerEvidence)) return false;
        if (value.provider === "local" && value.providerAdmission !== "local") return false;
        if (value.provider !== "local" && value.providerAdmission === "local") return false;
        if (value.providerAdmission === "provider-transport") {
            if (!isValidProviderLeaseIdentity(value.providerLeaseIdentity)
                || value.providerLeaseIdentity.provider !== value.provider
                || value.providerLeaseIdentity.attemptId !== value.attemptId
                || value.providerLeaseIdentity.leaseId !== value.permitId) return false;
        } else if (value.providerLeaseIdentity !== undefined) {
            return false;
        }
        if (value.dispatchPhase === "permit-granted" && value.state !== "DispatchIntentPersisted") return false;
        if (value.dispatchPhase === "attempt-bound" && value.state !== "Dispatched") return false;
        if (value.dispatchPhase === "invoking" && !["Dispatched", "KnownSuccess", "KnownFailure", "UnknownOutcome", "Discarded"].includes(value.state)) return false;
    }
    if (value.state === "UnknownOutcome") {
        if (!isTimestamp(value.unknownOutcomeAt)
            || !isTimestamp(value.unknownOutcomeUntil)
            || !isPositiveInteger(value.unknownOutcomeGraceMs)
            || Date.parse(value.unknownOutcomeUntil) - Date.parse(value.unknownOutcomeAt) !== value.unknownOutcomeGraceMs
            || Date.parse(value.unknownOutcomeAt) < Date.parse(value.startedAt!)
            || value.errorClass !== "UnknownOutcome"
            || value.outputRef !== undefined
            || !isNonEmptyString(value.providerEvidence)) return false;
    }
    return true;
}

function isValidProviderLeaseIdentity(value: unknown): value is ProviderLeaseIdentity {
    if (!isPlainObject(value)) return false;
    return (value.provider === "grok" || value.provider === "agy")
        && (value.trafficClass === "foreground" || value.trafficClass === "record"
            || value.trafficClass === "agy-first-run-overflow" || value.trafficClass === "agy-fallback")
        && isNonEmptyString(value.attemptId)
        && isNonEmptyString(value.leaseId)
        && isNonNegativeInteger(value.ownerEpoch)
        && isNonNegativeInteger(value.capacityGeneration)
        && isNonNegativeFiniteNumber(value.acquiredAt)
        && isNonNegativeFiniteNumber(value.expiresAt)
        && value.expiresAt >= value.acquiredAt;
}

function isValidCommit(value: unknown): value is CommitSnapshot {
    if (!isPlainObject(value)
        || value.schemaVersion !== RECORD_SCHEDULER_SCHEMA_VERSION
        || !isNonEmptyString(value.commitId)
        || !isNonEmptyString(value.taskId)
        || !isNonEmptyString(value.unitId)
        || !isNonEmptyString(value.attemptId)
        || !isNonEmptyString(value.recordWorkKey)
        || !isNonEmptyString(value.sourceSnapshotId)
        || !isNonEmptyString(value.inputHash)
        || !isNonEmptyString(value.outputHash)
        || !isPlainObject(value.qualityResult)
        || typeof value.qualityResult.accepted !== "boolean"
        || (value.qualityResult.reason !== undefined && typeof value.qualityResult.reason !== "string")
        || !isValidBlobReference(value.bodyRef)
        || !isNonEmptyString(value.bodyHash)
        || !isValidCommitOwnership(value.ownership)
        || !isNonEmptyString(value.observedSourceRevisionAtCommit)
        || !includesValue(COMMIT_STATES, value.state)
        || !includesValue(CLEANUP_STATES, value.cleanupPhase)
        || !isValidSuccessConditions(value.successConditions)
        || !isValidFence(value.fence)
        || isOptionalString(value.mainIndexRevision) === false
        || isOptionalString(value.readerIndexRevision) === false
        || (value.mainIndexEntry !== undefined && !isValidPublishedIndexEntry(value.mainIndexEntry))
        || (value.readerIndexEntry !== undefined && !isValidPublishedIndexEntry(value.readerIndexEntry))
        || isOptionalString(value.coveredRevision) === false
        || (value.verifiedAt !== undefined && !isTimestamp(value.verifiedAt))
        || (value.beforeImage !== undefined && !isValidCommitBeforeImageBundle(value.beforeImage))
        || (value.pendingRefresh !== undefined && !isValidPendingRefresh(value.pendingRefresh))
        || (value.readBack !== undefined && !isValidReadBack(value.readBack))
        || (value.cleanupReadBack !== undefined && !isValidCleanupReadBack(value.cleanupReadBack))) return false;

    const requiresBeforeImage = ["PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending", "Compensated", "RepairRequired"].includes(value.state);
    if (requiresBeforeImage && !isValidCommitBeforeImageBundle(value.beforeImage)) return false;
    if (value.beforeImage && (value.beforeImage.commitId !== value.commitId || !hasCurrentFencingToken(value.beforeImage.fence, value.fence))) return false;
    if (value.state === "Verified") {
        if (!value.qualityResult.accepted
            || value.cleanupPhase !== "NotRequired"
            || value.bodyRef.hash !== value.bodyHash
            || !isNonEmptyString(value.mainIndexRevision)
            || !isNonEmptyString(value.readerIndexRevision)
            || !isValidPublishedIndexEntry(value.mainIndexEntry)
            || !isValidPublishedIndexEntry(value.readerIndexEntry)
            || value.mainIndexEntry.revision !== value.mainIndexRevision
            || value.readerIndexEntry.revision !== value.readerIndexRevision
            || value.mainIndexEntry.commitId !== value.commitId
            || value.readerIndexEntry.commitId !== value.commitId
            || value.mainIndexEntry.recordWorkKey !== value.recordWorkKey
            || value.readerIndexEntry.recordWorkKey !== value.recordWorkKey
            || value.mainIndexEntry.sourceSnapshotId !== value.sourceSnapshotId
            || value.readerIndexEntry.sourceSnapshotId !== value.sourceSnapshotId
            || value.mainIndexEntry.bodyHash !== value.bodyHash
            || value.readerIndexEntry.bodyHash !== value.bodyHash
            || value.mainIndexEntry.coveredRevision !== value.coveredRevision
            || value.readerIndexEntry.coveredRevision !== value.coveredRevision
            || !isNonEmptyString(value.coveredRevision)
            || !isTimestamp(value.verifiedAt)
            || !isValidReadBack(value.readBack)
            || value.readBack.verifiedAt !== value.verifiedAt
            || value.readBack.bodyHash !== value.bodyHash
            || value.readBack.mainIndexRevision !== value.mainIndexRevision
            || value.readBack.readerIndexRevision !== value.readerIndexRevision
            || !samePublishedIndexEntry(value.readBack.mainIndexEntry, value.mainIndexEntry)
            || !samePublishedIndexEntry(value.readBack.readerIndexEntry, value.readerIndexEntry)) return false;
    }
    if ((value.state === "CleanupPending" || value.state === "Compensated")
        && (value.ownership.mode !== "task_exclusive" || value.ownership.ownerTaskId !== value.taskId)) return false;
    if (value.state === "Compensated" && (value.cleanupPhase !== "Verified" || !cleanupReadBackProvesCommitInvisible(value as unknown as CommitSnapshot))) return false;
    return true;
}

function hasBlockingUnknownOutcome(ledger: RecordSchedulerLedger, nowMs: number): boolean {
    return ledger.attempts.some(attempt => attempt.state === "UnknownOutcome"
        && attempt.unknownOutcomeUntil !== undefined
        && Date.parse(attempt.unknownOutcomeUntil) > nowMs);
}

function hasExpiredUnknownOutcomeAwaitingFenceAdvance(ledger: RecordSchedulerLedger, nowMs: number): boolean {
    return ledger.attempts.some(attempt => {
        if (attempt.state !== "UnknownOutcome" || attempt.unknownOutcomeUntil === undefined || Date.parse(attempt.unknownOutcomeUntil) > nowMs) return false;
        const work = ledger.recordWork.find(candidate => candidate.recordWorkKey === attempt.recordWorkKey);
        return work === undefined || work.currentFencingToken <= attempt.fence.fencingToken;
    });
}

export function isRecordSchedulerLedgerGraphConsistent(ledger: RecordSchedulerLedger): boolean {
    if (ledger.task.candidateSnapshotId !== ledger.candidateSnapshot.snapshotId
        || ledger.task.candidateSnapshotRevision !== ledger.candidateSnapshot.snapshotRevision) return false;
    if (!isUnique(ledger.candidateSnapshot.enumerations.map(entry => entry.chain))) return false;
    if (!isUnique(ledger.candidateSnapshot.candidates.map(entry => `${entry.chain}:${entry.workspaceHash}:${entry.conversationId}`))) return false;
    if (!isUnique(ledger.sourceSnapshots.map(source => source.sourceSnapshotId))) return false;
    if (!isUnique(ledger.recordWork.map(work => work.recordWorkKey))) return false;
    if (!isUnique(ledger.units.map(unit => unit.unitId))) return false;
    if (!isUnique(ledger.attempts.map(attempt => attempt.attemptId))) return false;
    if (!isUnique(ledger.commits.map(commit => commit.commitId))) return false;

    const sources = new Map(ledger.sourceSnapshots.map(source => [source.sourceSnapshotId, source]));
    const workItems = new Map(ledger.recordWork.map(work => [work.recordWorkKey, work]));
    const units = new Map(ledger.units.map(unit => [unit.unitId, unit]));
    const attempts = new Map(ledger.attempts.map(attempt => [attempt.attemptId, attempt]));
    const commits = new Map(ledger.commits.map(commit => [commit.commitId, commit]));

    if (ledger.sourceMaterialization !== undefined && !isValidSourceMaterializationLedger(ledger.sourceMaterialization, ledger)) return false;

    for (const source of ledger.sourceSnapshots) {
        if (!ledger.candidateSnapshot.candidates.some(candidate => candidate.conversationId === source.conversationId
            && candidate.chain === source.chain
            && candidate.workspaceHash === source.workspaceHash)) return false;
    }
    for (const unit of ledger.units) {
        const source = sources.get(unit.sourceSnapshotId);
        const work = workItems.get(unit.recordWorkKey);
        if (!source || !work || unit.taskId !== ledger.task.taskId || unit.recordCommitEpoch !== work.recordCommitEpoch) return false;
        if (source.conversationId !== work.conversationId || source.chain !== work.chain || source.workspaceHash !== work.workspaceHash || source.desiredRevision !== work.desiredRevision) return false;
        if (unit.recordId !== source.conversationId) return false;
        const candidate = ledger.candidateSnapshot.candidates.find(entry => entry.conversationId === source.conversationId
            && entry.chain === source.chain
            && entry.workspaceHash === source.workspaceHash);
        if (!candidate) return false;
        const enumeration = ledger.candidateSnapshot.enumerations.find(entry => entry.chain === source.chain);
        if (["Queued", "Running", "WaitingRetry", "ResultReady", "Committing"].includes(unit.state)
            && (!isCandidateSelectedForExecution(ledger.candidateSnapshot, candidate)
                || candidate.evidence.length === 0
                || enumeration === undefined
                || !enumeration.complete
                || !enumeration.paginationExhausted
                || enumeration.truncated
                || Boolean(enumeration.error)
                || !isCompleteSourceSnapshot(source))) return false;
        if (unit.dependencies.some(dependency => dependency === unit.unitId || !units.has(dependency))) return false;
        if (unit.promptRecipe !== undefined) {
            if (unit.layer !== "provider-attempt"
                || unit.routePlan.length === 0
                || !isUnique(unit.routePlan)
                || unit.routePlan.some(provider => provider === "auto")
                || unit.attemptedProviders.some(provider => provider === "local" || !unit.routePlan.includes(provider))) return false;
            if (unit.routeCursor !== undefined && unit.routeCursor >= unit.routePlan.length) return false;
            if (unit.promptRecipe.composeOrder !== unit.composeOrder) return false;
            if ((unit.promptRecipe.continuationKey || undefined) !== (unit.continuationKey || undefined)) return false;
        }
        if (unit.parentUnitId !== undefined) {
            const parent = units.get(unit.parentUnitId);
            if (!parent || !parent.childUnitIds?.includes(unit.unitId) || unit.splitDepth !== parent.splitDepth + 1) return false;
        }
        if (unit.childUnitIds !== undefined) {
            if (unit.childUnitIds.some(childUnitId => units.get(childUnitId)?.parentUnitId !== unit.unitId)) return false;
            if (unit.composeProvenance && !sameStringSet(unit.composeProvenance.childUnitIds, unit.childUnitIds)) return false;
        } else if (unit.composeProvenance !== undefined) {
            return false;
        }
        if (unit.commitId !== undefined && commits.get(unit.commitId)?.unitId !== unit.unitId) return false;
    }
    if ((ledger.task.state === "Queued" || ledger.task.state === "Running")
        && ledger.recordWork.some(work => work.schedulerEpoch !== ledger.task.schedulerEpoch || !work.activeTaskIds.includes(ledger.task.taskId))) return false;
    if (!isUnique(ledger.attempts.map(attempt => `${attempt.unitId}:${attempt.fence.fencingToken}`))) return false;
    const cancellationInProgress = ["CancelRequested", "Cancelling", "Cancelled"].includes(ledger.task.state);
    for (const unit of ledger.units) {
        const liveAttempts = ledger.attempts.filter(attempt => attempt.unitId === unit.unitId
            && !["KnownFailure", "Discarded"].includes(attempt.state));
        const unknownAttempts = liveAttempts.filter(attempt => attempt.state === "UnknownOutcome");
        if (liveAttempts.length > 1 || unknownAttempts.length > 1) return false;
        if (unit.state === "UnknownOutcome" && unknownAttempts.length !== 1) return false;
        if (!cancellationInProgress && unknownAttempts.length === 1 && unit.state !== "UnknownOutcome") return false;
        const orderedAttempts = ledger.attempts
            .filter(attempt => attempt.unitId === unit.unitId && attempt.dispatchIntentAt !== undefined)
            .sort((left, right) => Date.parse(left.dispatchIntentAt!) - Date.parse(right.dispatchIntentAt!));
        for (let index = 1; index < orderedAttempts.length; index += 1) {
            if (orderedAttempts[index].fence.fencingToken <= orderedAttempts[index - 1].fence.fencingToken) return false;
        }
        if (unit.unitAttempts !== undefined && unit.unitAttempts !== ledger.attempts.filter(attempt => attempt.unitId === unit.unitId).length) return false;
        if (unit.providerAttemptCounts !== undefined) {
            for (const provider of MODEL_PROVIDERS) {
                const actual = ledger.attempts.filter(attempt => attempt.unitId === unit.unitId && attempt.provider === provider).length;
                if ((unit.providerAttemptCounts[provider] || 0) !== actual) return false;
            }
        }
    }
    for (const attempt of ledger.attempts) {
        const unit = units.get(attempt.unitId);
        const work = workItems.get(attempt.recordWorkKey);
        if (!unit || !work || unit.recordWorkKey !== work.recordWorkKey || attempt.inputHash !== unit.inputHash || !attempt.originTaskIds.includes(ledger.task.taskId)) return false;
        if (attempt.fence.recordCommitEpoch !== work.recordCommitEpoch
            || attempt.fence.schedulerEpoch > work.schedulerEpoch
            || attempt.fence.fencingToken > work.currentFencingToken) return false;
        if (["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(attempt.state)) {
            const currentFence = { schedulerEpoch: work.schedulerEpoch, recordCommitEpoch: work.recordCommitEpoch, fencingToken: work.currentFencingToken, workLeaseId: work.workLeaseId };
            if (!hasCurrentFencingToken(currentFence, attempt.fence)) return false;
        }
        if (attempt.state === "UnknownOutcome") {
            const currentFence = { schedulerEpoch: work.schedulerEpoch, recordCommitEpoch: work.recordCommitEpoch, fencingToken: work.currentFencingToken, workLeaseId: work.workLeaseId };
            if (attempt.fence.fencingToken === currentFence.fencingToken) {
                if (!hasCurrentFencingToken(currentFence, attempt.fence)) return false;
            } else if (attempt.fence.workLeaseId === currentFence.workLeaseId) {
                return false;
            }
        }
    }
    for (const commit of ledger.commits) {
        const source = sources.get(commit.sourceSnapshotId);
        const work = workItems.get(commit.recordWorkKey);
        const unit = units.get(commit.unitId);
        const attempt = attempts.get(commit.attemptId);
        if (!source || !work || !unit || !attempt) return false;
        if (commit.taskId !== ledger.task.taskId
            || unit.taskId !== ledger.task.taskId
            || unit.recordWorkKey !== commit.recordWorkKey
            || attempt.unitId !== unit.unitId
            || attempt.recordWorkKey !== commit.recordWorkKey
            || unit.sourceSnapshotId !== commit.sourceSnapshotId
            || unit.inputHash !== commit.inputHash
            || attempt.inputHash !== commit.inputHash) return false;
        if (commit.ownership.mode === "task_exclusive" && commit.ownership.ownerTaskId !== commit.taskId) return false;
        if (commit.ownership.mode === "shared" && !commit.ownership.ownerTaskIds.includes(commit.taskId)) return false;
        if (commit.fence.recordCommitEpoch !== work.recordCommitEpoch
            || commit.fence.schedulerEpoch > work.schedulerEpoch
            || commit.fence.fencingToken > work.currentFencingToken) return false;
        if (["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) {
            const currentFence = { schedulerEpoch: work.schedulerEpoch, recordCommitEpoch: work.recordCommitEpoch, fencingToken: work.currentFencingToken, workLeaseId: work.workLeaseId };
            if (!hasCurrentFencingToken(currentFence, commit.fence)) return false;
        }
        if (commit.state === "Verified") {
            if (attempt.state !== "KnownSuccess"
                || attempt.outcome !== "known_success"
                || attempt.outputRef?.hash !== commit.outputHash
                || unit.state !== "Succeeded"
                || unit.commitId !== commit.commitId
                || unit.coveredRevision !== source.desiredRevision
                || commit.coveredRevision !== source.desiredRevision
                || !isPersistedRefreshForCurrentRevision(commit, source)) return false;
        }
        if (commit.beforeImage && (commit.beforeImage.commitId !== commit.commitId || !hasCurrentFencingToken(commit.beforeImage.fence, commit.fence))) return false;
        if (commit.cleanupReadBack && commit.cleanupReadBack.registryRevision > work.registryRevision) return false;
    }

    const runningUnits = ledger.units.filter(unit => unit.state === "Running" || unit.state === "Committing").length;
    const doneUnits = ledger.units.filter(unit => isCancellationUnitSettled(unit.state)).length;
    const failedUnits = ledger.units.filter(unit => unit.state === "FailedFinal").length;
    return ledger.task.units.materialized === ledger.units.length
        && ledger.task.units.running === runningUnits
        && ledger.task.units.done === doneUnits
        && ledger.task.units.failed === failedUnits;
}

function isCandidateSelectedForExecution(snapshot: CandidateSnapshot, candidate: CandidateSnapshotEntry): boolean {
    return candidate.state === "Missing"
        || candidate.state === "Stale"
        || snapshot.requestMode === "force" && candidate.state === "Fresh";
}

function hasUsableDispatchLeases(ledger: RecordSchedulerLedger, nowMs: number): boolean {
    const dispatchableWorkKeys = new Set(ledger.units
        .filter(unit => unit.state === "Queued" || unit.state === "WaitingRetry" || unit.state === "Running")
        .map(unit => unit.recordWorkKey));
    return [...dispatchableWorkKeys].every(recordWorkKey => {
        const work = ledger.recordWork.find(candidate => candidate.recordWorkKey === recordWorkKey);
        return work !== undefined
            && work.schedulerEpoch === ledger.task.schedulerEpoch
            && work.activeTaskIds.includes(ledger.task.taskId)
            && Date.parse(work.leaseExpiresAt) > nowMs;
    });
}

export function isCurrentRecordSchedulerLedger(value: unknown): value is RecordSchedulerLedger {
    if (!(isPlainObject(value)
        && value.schemaVersion === RECORD_SCHEDULER_SCHEMA_VERSION
        && value.kind === "record-scheduler-ledger"
        && isPositiveInteger(value.revision)
        && isNonEmptyString(value.persistedHash)
        && isValidTaskLedger(value.task)
        && isValidCandidateSnapshot(value.candidateSnapshot)
        && Array.isArray(value.sourceSnapshots)
        && value.sourceSnapshots.every(isValidSourceSnapshot)
        && Array.isArray(value.recordWork)
        && value.recordWork.every(isValidRecordWork)
        && Array.isArray(value.units)
        && value.units.every(isValidUnit)
        && Array.isArray(value.attempts)
        && value.attempts.every(isValidAttempt)
        && Array.isArray(value.commits)
        && value.commits.every(isValidCommit))) return false;
    return isRecordSchedulerLedgerGraphConsistent(value as unknown as RecordSchedulerLedger);
}

export function isLegacyBatchLedger(value: unknown): value is LegacyBatchLedger {
    return isPlainObject(value)
        && (value.version === 1 || value.version === 2)
        && isNonEmptyString(value.resumeKey)
        && Array.isArray(value.candidates)
        && Array.isArray(value.completed)
        && Array.isArray(value.skipped)
        && Array.isArray(value.failed)
        && (value.inFlight === undefined || Array.isArray(value.inFlight));
}

export function legacyBatchLedgerMigrationBoundary(ledger: Pick<LegacyBatchLedger, "version">): LegacyBatchLedgerMigrationBoundary {
    return {
        sourceVersion: ledger.version,
        readOnly: true,
        canDispatch: false,
        canRecoverDispatch: false,
        canReportSuccess: false,
        requiresCandidateSnapshot: true,
        requiresSourceSnapshots: true,
    };
}

function deepFreeze<Value>(value: Value): Value {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    return Object.freeze(value);
}

export function readRecordSchedulerLedger(value: unknown, options: SchedulerLedgerReadOptions = {}): SchedulerLedgerReadResult {
    if (!isPlainObject(value)) {
        return { kind: "rejected", reason: "invalid", canDispatch: false, canRecoverDispatch: false, canReportSuccess: false };
    }

    if (typeof value.schemaVersion === "number") {
        if (value.schemaVersion > RECORD_SCHEDULER_SCHEMA_VERSION) {
            return { kind: "rejected", reason: "future_schema", canDispatch: false, canRecoverDispatch: false, canReportSuccess: false };
        }
        if (value.schemaVersion !== RECORD_SCHEDULER_SCHEMA_VERSION) {
            return { kind: "rejected", reason: "unsupported_schema", canDispatch: false, canRecoverDispatch: false, canReportSuccess: false };
        }
        if (!isCurrentRecordSchedulerLedger(value)) {
            return { kind: "repair_required", reason: "invalid_current_ledger", canDispatch: false, canRecoverDispatch: false, canReportSuccess: false };
        }
        const nowMs = options.nowMs ?? Date.now();
        const canDispatch = canDispatchTask(value.task.state, value.task.repairState)
            && !hasBlockingUnknownOutcome(value, nowMs)
            && !hasExpiredUnknownOutcomeAwaitingFenceAdvance(value, nowMs)
            && hasUsableDispatchLeases(value, nowMs);
        return {
            kind: "current",
            ledger: value,
            canDispatch,
            canRecoverDispatch: canDispatch,
            canReportSuccess: canReportSchedulerLedgerSuccess(value),
        };
    }

    if (typeof value.version === "number" && value.version > LEGACY_BATCH_LEDGER_VERSIONS[LEGACY_BATCH_LEDGER_VERSIONS.length - 1]) {
        return { kind: "rejected", reason: "future_legacy_version", canDispatch: false, canRecoverDispatch: false, canReportSuccess: false };
    }

    if (!isLegacyBatchLedger(value)) {
        return { kind: "rejected", reason: "invalid", canDispatch: false, canRecoverDispatch: false, canReportSuccess: false };
    }

    const ledger = deepFreeze(structuredClone({
        ...value,
        inFlight: value.inFlight || [],
    })) as ReadonlyLegacyBatchLedger;
    return {
        kind: "legacy",
        ledger,
        boundary: legacyBatchLedgerMigrationBoundary(ledger),
        canDispatch: false,
        canRecoverDispatch: false,
        canReportSuccess: false,
    };
}
