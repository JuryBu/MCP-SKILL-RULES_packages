import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_TASK_RESUME_VERSION, normalizeResumePayload, stableJsonHash } from "./background-recovery.js";
import type { BackgroundTaskContext } from "./background-tasks.js";
import { createBackgroundTaskSuspension, isBackgroundTaskSuspension } from "./background-task-suspension.js";
import {
    assertTaskTransition,
    isTerminalTaskState,
    SOURCE_CHAINS,
    type CandidateState,
    type CandidateSnapshot as SchedulerCandidateSnapshot,
    type ImmutableBlobReference,
    type PendingRefreshReference,
    type RecordSchedulerLedger,
    type RecordSourceSnapshot as SchedulerRecordSourceSnapshot,
    type SchedulerSourceResolution,
    type SchedulerSourceResolutionIssue,
    type SourceMaterializationLedger,
    type SourceMaterializationOutcome,
    type SourceMaterializationSelection,
    type SourceChain,
    type TaskState,
} from "./record-scheduler-contracts.js";
import { DATA_ROOT, listWorkspaceHashes } from "./store.js";
import { listRecords } from "./record-store.js";
import {
    admitRecordSchedulerTask,
    type AdmitRecordSchedulerTaskResult,
    type RecordSchedulerAdmissionInitialLedger,
} from "./record-scheduler-admission.js";
import {
    createRecordSchedulerControl,
    type CancelRecordSchedulerTaskResult,
    type RecordSchedulerControl,
    type RecordSchedulerTaskStatus,
    type RecoverRecordSchedulerOwnerResult,
} from "./record-scheduler-control.js";
import {
    calculateRecordSchedulerAdmissionRequestHash,
    claimSchedulerOwnerLease,
    completeSchedulerOwnerRecovery,
    createRecordSchedulerTaskId,
    heartbeatSchedulerOwnerLease,
    listRecordSchedulerLedgerTaskIds,
    mutateRecordSchedulerLedger,
    mutateRecordSchedulerLedgerAsOwner,
    recordSchedulerLedgerPath,
    readRecordSchedulerLedgerStore,
    readRecordSchedulerLedgerStoreSync,
    verifyOrRecoverTaskAdmission,
} from "./record-scheduler-store.js";
import {
    buildRecordIndexEntry,
    buildRecordIndexScope,
    CandidateSnapshotSchema,
    createRecordSourceSnapshot,
    discoverRecordCandidates,
    selectRecordDiscoveryCandidates,
    type CandidateSnapshot as DiscoveryCandidateSnapshot,
    type Immutable as DiscoveryImmutable,
    type RecordDiscoveryInput,
    type RecordDiscoverySelector,
    type SourceAbsenceObservation,
    type RecordSourceSnapshot as DiscoveryRecordSourceSnapshot,
    type RecordSourceSnapshotResult,
} from "./record-discovery.js";
import { createRecordSchedulerCoordinator, type RecordSchedulerCoordinator, type RecordSchedulerProviderPermitRequest } from "./record-scheduler-coordinator.js";
import { createRecordUnitPlan, type RecordUnitPlan, type RecordUnitPlanningInput } from "./record-unit-engine.js";
import {
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    SOURCE_EVIDENCE_HOSTS,
    buildExactFetchEvidence,
    buildLostObservation,
    buildSourceEnumerationEvidence,
    canonicalSourceIdentityKey,
    type ExactFetchEvidence,
    type LostObservation,
    type SourceConversationIdentity,
    type SourceEnumerationEvidence,
    type SourceEvidenceHost,
} from "./source-evidence-contracts.js";
import { enumerateCodexSourceEvidence, fetchCodexSourceEvidence, listRecentCodexThreads } from "./codex-client.js";
import { enumerateClaudeCodeSourceEvidence, fetchClaudeCodeSourceEvidence, listRecentClaudeCodeThreads } from "./claude-code-client.js";
import { listRecentWindsurfThreads, scanWindsurfSourceEvidence } from "./windsurf-client.js";
import {
    createAntigravityLsSourceEvidenceAdapter,
    listConversationsByMtime,
    type AntigravityEvidenceCallResult,
    type AntigravityLsEvidenceExactValue,
    type AntigravityLsEvidenceFullValue,
    type AntigravityLsEvidencePage,
    type AntigravityLsEvidenceReader,
} from "./ls-client.js";
import {
    createProductionSourceReader,
    type ProductionSourceAuthorityVerification,
    type ProductionSourceCanonicalDocument,
    type ProductionSourceReader,
    type ProductionSourceReadRequest,
} from "./record-production-source-readers.js";
import {
    calculateRecordConversationStateAuthorityHash,
    canonicalConversationStateKey,
    readRecordConversationStateStore,
    repairRecordConversationStateStore,
    resolveRecordConversationStateRootBinding,
    upsertRecordConversationState,
    type ConversationState,
    type ConversationStateAuthoritySnapshots,
    type ConversationStateCompleteEvidenceSnapshot,
    type ConversationStateEntry,
    type ConversationStateEvidence,
    type ConversationStateIdentity,
    type ConversationStatePatch,
    type ConversationStateRecordIndexSnapshot,
    type ConversationStateSchedulerLedgerSnapshot,
    type ConversationStateWorkRegistrySnapshot,
} from "./record-conversation-state.js";
import {
    RecordSourceRefreshCoordinator,
    createPendingRefreshKey,
    createPendingRefreshRecordHash,
    type AuthoritativeRevisionOrder,
    type RecordSourceRefreshBackend,
    type RecordSourceRefreshDecision,
    type RecordSourceRefreshDurabilityReceipt,
    type RecordSourceRefreshEnsureRequest,
    type RecordSourceRefreshEnsureResult,
    type RecordSourceRefreshReadBackRequest,
    type RecordSourceRefreshReadBackResult,
    type RecordSourceRefreshReread,
    type RecordSourceRefreshRootBinding,
    type RecordSourceRefreshSchedulerLedgerCasBarrier,
} from "./record-source-refresh.js";
import { readRecordWorkRegistry, recordWorkKey } from "./record-work-registry.js";

export const RECORD_SCHEDULER_RUNTIME_MODES = ["legacy", "shadow", "test", "enforced"] as const;
const PRODUCTION_DISCOVERY_HARD_LIMIT = 20_000;
const LOST_RECHECK_INTERVAL_MS = 60 * 60 * 1000;
const RUNTIME_SOURCE_MATERIALIZATION_MARKER_KIND = "record-runtime-source-materialization";
const RUNTIME_SOURCE_MATERIALIZATION_MARKER_VERSION = 2;
const DEFAULT_RUNTIME_OWNER_LEASE_MS = 30_000;
const MIN_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS = 50;
const MAX_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
const EXECUTION_OWNER_HEARTBEAT_RETRY_LIMIT = 5;

export type RecordSchedulerRuntimeMode = typeof RECORD_SCHEDULER_RUNTIME_MODES[number];
export type RecordSchedulerRuntimeTaskKind = "record-update" | "record-batch-update";

export class RecordSchedulerRepairRequiredError extends Error {
    readonly code = "SCHEDULER_REPAIR_REQUIRED";

    constructor(message: string) {
        super(message);
        this.name = "RecordSchedulerRepairRequiredError";
    }
}

class RecordSchedulerRuntimeOwnerUnavailableError extends Error {
    readonly code = "OWNER_UNAVAILABLE";

    constructor(message: string) {
        super(message);
        this.name = "RecordSchedulerRuntimeOwnerUnavailableError";
    }
}

class RecordSchedulerRuntimeOwnerFencedError extends Error {
    readonly code = "OWNER_FENCED";

    constructor(message: string) {
        super(message);
        this.name = "RecordSchedulerRuntimeOwnerFencedError";
    }
}

function isSchedulerOwnerAuthorityError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    return code === "OWNER_UNAVAILABLE"
        || code === "OWNER_FENCED"
        || code === "OWNER_LEASE_HELD"
        || code === "OWNER_LEASE_REQUIRED";
}

function isSchedulerRepairRequiredError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    return code === "SCHEDULER_REPAIR_REQUIRED" || code === "REPAIR_REQUIRED";
}

export interface RecordSchedulerRuntimeDiscoveryRecord {
    conversationId: string;
    title: string;
    workspaceHash: string;
    workspacePath: string | null;
    host?: SourceEvidenceHost;
    lastUpdatedAt: string;
    recordBodyHash: string;
    coveredRevision?: string;
    coveredRevisionSequence?: number | null;
}

export interface RecordSchedulerRuntimeDiscoveryRequest {
    kind: RecordSchedulerRuntimeTaskKind | "stale_check";
    selector: RecordDiscoverySelector;
    requestKey?: string;
    workspaceHash?: string;
    workspacePath?: string | null;
    hosts?: SourceEvidenceHost[];
    limit?: number;
    selectionLimit?: number;
    filters?: Record<string, unknown>;
    records?: RecordSchedulerRuntimeDiscoveryRecord[];
    targets?: Array<{
        conversationId: string;
        host: SourceEvidenceHost;
        workspaceHash: string;
        workspacePath: string | null;
        title?: string;
    }>;
    input?: RecordDiscoveryInput;
    snapshot?: DiscoveryCandidateSnapshot;
}

export interface FrozenRuntimeSource {
    snapshot: SchedulerRecordSourceSnapshot;
    discoverySnapshot: DiscoveryImmutable<DiscoveryRecordSourceSnapshot>;
    request: ProductionSourceReadRequest;
    document: ProductionSourceCanonicalDocument;
    scanId: string;
    authority: ProductionSourceAuthorityVerification;
}

export interface FrozenRuntimeSourceIssue {
    kind: "unresolved" | "conflict";
    conversationId?: string;
    chain: SourceChain;
    workspaceHash?: string;
    code: string;
    reason: string;
    evidenceHashes: string[];
}

export interface FrozenRuntimeSourceSet {
    sources: FrozenRuntimeSource[];
    unresolved: FrozenRuntimeSourceIssue[];
    selectedCount: number | null;
    materializedCount: number;
    selectionHash?: string;
    phase: "sealed";
}

export interface RecordSchedulerSourceCommitGuardInput {
    taskId: string;
    sourceSnapshotId: string;
    recordWorkKey?: string;
    schedulerLedgerCas?: RecordSourceRefreshSchedulerLedgerCasBarrier;
}

export interface RecordSchedulerSourceEvidenceAdapter {
    buildDiscoveryInput(
        request: RecordSchedulerRuntimeDiscoveryRequest,
    ): Promise<RecordDiscoveryInput | RecordSchedulerDiscoveryBuildResult>;
}

export interface RecordSchedulerDiscoveryBuildResult {
    input: RecordDiscoveryInput;
    enumerations: SchedulerCandidateSnapshot["enumerations"];
}

export interface RecordSchedulerProductionSourceApis {
    listCodexThreads: typeof listRecentCodexThreads;
    enumerateCodex: typeof enumerateCodexSourceEvidence;
    fetchCodex: typeof fetchCodexSourceEvidence;
    listClaudeCodeThreads: typeof listRecentClaudeCodeThreads;
    enumerateClaudeCode: typeof enumerateClaudeCodeSourceEvidence;
    fetchClaudeCode: typeof fetchClaudeCodeSourceEvidence;
    listWindsurfThreads: typeof listRecentWindsurfThreads;
    scanWindsurf: typeof scanWindsurfSourceEvidence;
    listAntigravityConversations: typeof listConversationsByMtime;
    createAntigravityAdapter: typeof createAntigravityLsSourceEvidenceAdapter;
}

export interface RecordSchedulerProductionScanIdInput {
    requestKey: string;
    host: SourceEvidenceHost;
    conversationId: string;
    startedAt: string;
}

export type RecordSchedulerProductionScanIdFactory = (input: RecordSchedulerProductionScanIdInput) => string;

export interface RecordSchedulerProductionSourceEvidenceAdapterOptions {
    now?: () => Date;
    scanIdFactory?: RecordSchedulerProductionScanIdFactory;
}

export interface RecordSchedulerRuntimeExecutionRequest {
    kind: RecordSchedulerRuntimeTaskKind;
    taskId: string;
    requestKey: string;
    requestSummary: Record<string, unknown>;
    resumePayload: unknown;
    context: BackgroundTaskContext;
    sourceSnapshots?: FrozenRuntimeSourceSet;
}

export interface RecordSchedulerRuntimeAdmitRequest {
    kind: RecordSchedulerRuntimeTaskKind;
    requestKey: string;
    requestSummary: Record<string, unknown>;
    resumePayload: unknown;
    requestMode: "normal" | "force" | "stale_only";
    backgroundProjection?: Record<string, unknown>;
    replayTerminal?: boolean;
    discovery?: RecordSchedulerRuntimeDiscoveryRequest;
    validateLegacyState?: (snapshot?: DiscoveryCandidateSnapshot) => Promise<void>;
    execute: (
        context: BackgroundTaskContext,
        snapshot?: DiscoveryCandidateSnapshot,
        sourceSnapshots?: FrozenRuntimeSourceSet,
    ) => Promise<string>;
}

export interface RecordSchedulerRuntimeAdmitted {
    outcome: "Admitted" | "Replayed";
    taskId: string;
    status: RecordSchedulerTaskStatus;
    admission: Exclude<AdmitRecordSchedulerTaskResult, { outcome: "UnknownOutcome" }>;
}

export interface RecordSchedulerRuntimeUnknownOutcome {
    outcome: "UnknownOutcome";
    candidateTaskIds: string[];
    reasons: string[];
}

export type RecordSchedulerRuntimeAdmissionResult = RecordSchedulerRuntimeAdmitted | RecordSchedulerRuntimeUnknownOutcome;

export type RecordSchedulerRuntimeResumeExecute = (
    context: BackgroundTaskContext,
    snapshot?: DiscoveryCandidateSnapshot,
    sourceSnapshots?: FrozenRuntimeSourceSet,
) => Promise<string>;

export type RecordSchedulerRuntimeRecoveryDescriptor = Omit<
    RecordSchedulerRuntimeAdmitRequest,
    "discovery" | "execute" | "replayTerminal"
> & {
    discovery: RecordSchedulerRuntimeDiscoveryRequest;
};

export type RecordSchedulerRuntimeRecoveryDescriptorFactory = () =>
    Promise<RecordSchedulerRuntimeRecoveryDescriptor> | RecordSchedulerRuntimeRecoveryDescriptor;

export type RecordSchedulerRuntimeRecoveryDescriptorInput =
    RecordSchedulerRuntimeRecoveryDescriptor | RecordSchedulerRuntimeRecoveryDescriptorFactory;

type RecoveredRecordSchedulerOwner = Extract<RecoverRecordSchedulerOwnerResult, { kind: "recovered" }>;
type RecordSchedulerRuntimeExecutionOwnerLease = RecoveredRecordSchedulerOwner["ownerLease"];

function sameExecutionOwnerIdentity(
    left: RecordSchedulerRuntimeExecutionOwnerLease,
    right: RecordSchedulerRuntimeExecutionOwnerLease,
): boolean {
    return left.ownerId === right.ownerId
        && left.leaseId === right.leaseId
        && left.schedulerEpoch === right.schedulerEpoch
        && left.fencingToken === right.fencingToken;
}

function executionOwnerLeaseDurationMs(lease: RecordSchedulerRuntimeExecutionOwnerLease): number {
    const durationMs = Date.parse(lease.expiresAt) - Date.parse(lease.heartbeatAt);
    return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : DEFAULT_RUNTIME_OWNER_LEASE_MS;
}

function executionOwnerHeartbeatIntervalMs(leaseMs: number): number {
    return Math.max(
        MIN_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS,
        Math.min(MAX_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS, Math.floor(leaseMs / 3)),
    );
}

function isSchedulerLedgerConflictError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    return code === "SCHEDULER_LEDGER_CONFLICT" || code === "REVISION_CONFLICT";
}

export type RecordSchedulerRuntimeResumeResult =
    | {
        kind: "resumed" | "settled";
        ownerLease: RecoveredRecordSchedulerOwner["ownerLease"];
        status: RecordSchedulerTaskStatus;
        result: string;
    }
    | {
        kind: "terminal";
        status: RecordSchedulerTaskStatus;
    }
    | {
        kind: "cancelled";
        ownerLease?: RecoveredRecordSchedulerOwner["ownerLease"];
        cancellation: CancelRecordSchedulerTaskResult;
        status: RecordSchedulerTaskStatus;
    }
    | {
        kind: "blocked" | "repair_required" | "missing";
        status: RecordSchedulerTaskStatus;
        reason?: string;
        result?: string;
    };

interface FrozenExecutionLoopResult {
    disposition: "executed" | "deferred" | "repair_required" | "cancelled";
    result: string;
    ownerLease: RecordSchedulerRuntimeExecutionOwnerLease;
}

interface PreparedRuntimeRecovery {
    discovery: FrozenRuntimeDiscovery;
    sourceSnapshots: FrozenRuntimeSourceSet;
    validateLegacyState?: RecordSchedulerRuntimeAdmitRequest["validateLegacyState"];
}

function authoritativeSchedulerTaskState(status: RecordSchedulerTaskStatus): RecordSchedulerTaskStatus["state"] {
    return status.repairState === "Blocked" && status.taskState
        ? status.taskState
        : status.state;
}

export interface RecordSchedulerRuntimeOptions {
    mode?: RecordSchedulerRuntimeMode;
    control?: RecordSchedulerControl;
    ownerId?: string;
    ownerLeaseMs?: number;
    now?: () => Date;
    executeForTest?: (request: RecordSchedulerRuntimeExecutionRequest) => Promise<string>;
    discover?: (request: RecordSchedulerRuntimeDiscoveryRequest) => Promise<DiscoveryCandidateSnapshot>;
    sourceEvidenceAdapter?: RecordSchedulerSourceEvidenceAdapter;
    /**
     * 默认 production 路径必须由统一 reader 做精确读取与完整读取。旧的 API
     * 覆盖只保留给既有 fixture，不能作为生产默认实现。
     */
    productionSourceReader?: ProductionSourceReader;
    productionSourceApis?: Partial<RecordSchedulerProductionSourceApis>;
    productionScanIdFactory?: RecordSchedulerProductionScanIdFactory;
    coordinator?: RecordSchedulerCoordinator;
}

function hash(value: unknown): string {
    return crypto.createHash("sha256").update(stableJsonHash(value), "utf8").digest("hex");
}

function stableObject(value: Record<string, unknown>): Record<string, unknown> {
    const normalized = normalizeResumePayload(value);
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
        throw new Error("Record scheduler runtime 请求摘要必须是 JSON 对象");
    }
    return normalized as Record<string, unknown>;
}

function schedulerContentHash(contentHash: string): string {
    return contentHash.startsWith("sha256:") ? contentHash.slice("sha256:".length) : contentHash;
}

function rawSha256(content: string | Uint8Array): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function pathIsWithin(rootPath: string, candidatePath: string): boolean {
    const root = path.resolve(rootPath);
    const relative = path.relative(root, path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function schedulerLedgerBelongsToRoot(ledger: RecordSchedulerLedger, dataRoot: string): boolean {
    return ledger.task.admission.state === "EnvelopeBound"
        && pathIsWithin(dataRoot, ledger.task.admission.ledgerAnchor.path);
}

function conversationStateIdentity(input: {
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
}): ConversationStateIdentity {
    return {
        chain: input.chain,
        workspaceHash: input.workspaceHash,
        conversationId: input.conversationId,
    };
}

function candidatePendingRefreshKey(
    state: CandidateState,
    identity: ConversationStateIdentity,
    latestObservedRevision: string | null,
): string | null {
    if ((state !== "Stale" && state !== "Missing") || !latestObservedRevision) return null;
    return createPendingRefreshKey(identity, latestObservedRevision);
}

function isCompleteEnumerationEvidence(evidence: SourceEnumerationEvidence): boolean {
    return evidence.enumerationComplete
        && evidence.cacheBypassed
        && evidence.errors.length === 0
        && evidence.pagination.cursor === null
        && evidence.pagination.limit === null
        && !evidence.pagination.truncated;
}

function durableRefreshIndexHash(index: Omit<DurableRefreshIndex, "persistedHash"> | DurableRefreshIndex): string {
    const serializable = { ...index } as Record<string, unknown>;
    delete serializable.persistedHash;
    return stableJsonHash(serializable);
}

function durableRefreshAttachmentKey(input: {
    sourceSnapshotId: string;
    recordWorkKey: string;
    fromRevision: string;
    desiredRevision: string;
}): string {
    return rawSha256(JSON.stringify([
        input.sourceSnapshotId,
        input.recordWorkKey,
        input.fromRevision,
        input.desiredRevision,
    ]));
}

function durableRefreshStorageKey(refreshKey: string): string {
    const match = /^sha256:([0-9a-f]{64})$/u.exec(refreshKey);
    if (!match) throw new RecordSchedulerRepairRequiredError("refresh durable key 格式无效");
    return match[1];
}

function durableRefreshTaskId(refreshKey: string): string {
    return `record-source-refresh-${durableRefreshStorageKey(refreshKey)}`;
}

function sameImmutableReference(left: Readonly<ImmutableBlobReference>, right: Readonly<ImmutableBlobReference>): boolean {
    return left.path === right.path && left.hash === right.hash && left.byteLength === right.byteLength;
}

function samePendingRefresh(left: PendingRefreshReference, right: PendingRefreshReference): boolean {
    return left.refreshKey === right.refreshKey
        && left.refreshTaskId === right.refreshTaskId
        && left.sourceSnapshotId === right.sourceSnapshotId
        && left.recordWorkKey === right.recordWorkKey
        && left.chain === right.chain
        && left.workspaceHash === right.workspaceHash
        && left.conversationId === right.conversationId
        && left.fromRevision === right.fromRevision
        && left.desiredRevision === right.desiredRevision
        && left.persistedAt === right.persistedAt
        && left.ledgerRevision === right.ledgerRevision
        && sameImmutableReference(left.ledgerRef, right.ledgerRef)
        && left.state === right.state;
}

function sourceMaterializationSourceKey(input: {
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
}): string {
    return `source:${stableJsonHash({
        kind: "record-source-materialization-key-v1",
        chain: input.chain,
        workspaceHash: input.workspaceHash,
        conversationId: input.conversationId,
    })}`;
}

function sourceMaterializationSelection(
    candidate: DiscoveryImmutable<DiscoveryCandidateSnapshot["candidates"][number]>,
    selector: RecordDiscoverySelector,
): SourceMaterializationSelection {
    const identity = {
        chain: candidate.source.host,
        workspaceHash: candidate.source.identity.workspace.workspaceId,
        conversationId: candidate.source.identity.conversationId,
    };
    return {
        sourceKey: sourceMaterializationSourceKey(identity),
        ...identity,
        candidateState: schedulerCandidateState(candidate, selector),
        evidenceHash: hash(candidate),
    };
}

function schedulerCandidateState(
    candidate: DiscoveryImmutable<DiscoveryCandidateSnapshot["candidates"][number]>,
    selector: RecordDiscoverySelector,
): SchedulerCandidateSnapshot["candidates"][number]["state"] {
    return selector === "force"
        && candidate.classification === "Unresolved"
        && candidate.classificationReason.code === "record-covered-revision-missing"
        ? "Stale"
        : candidate.classification;
}

function sourceMaterializationSelectionHash(selected: readonly SourceMaterializationSelection[]): string {
    return stableJsonHash([...selected].sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)));
}

function sourceMaterializationMarker(
    ledger: Pick<RecordSchedulerLedger, "task" | "candidateSnapshot" | "sourceSnapshots" | "sourceMaterialization">,
): RuntimeSourceMaterializationMarker {
    const materialization = ledger.sourceMaterialization;
    if (!materialization) throw new RecordSchedulerRepairRequiredError("source materialization ledger 缺失");
    return {
        kind: RUNTIME_SOURCE_MATERIALIZATION_MARKER_KIND,
        schemaVersion: RUNTIME_SOURCE_MATERIALIZATION_MARKER_VERSION,
        taskId: ledger.task.taskId,
        candidateSnapshotId: ledger.candidateSnapshot.snapshotId,
        candidateSnapshotHash: ledger.candidateSnapshot.snapshotHash,
        selectionHash: materialization.selectionHash,
        selected: materialization.selected.map(item => structuredClone(item)),
        outcomes: materialization.outcomes.map(item => structuredClone(item)),
        sourceSnapshotIds: ledger.sourceSnapshots.map(snapshot => snapshot.sourceSnapshotId).sort(),
    };
}

function sourceMaterializationMarkerBytes(
    ledger: Pick<RecordSchedulerLedger, "task" | "candidateSnapshot" | "sourceSnapshots" | "sourceMaterialization">,
): Buffer {
    return Buffer.from(JSON.stringify(sourceMaterializationMarker(ledger)), "utf8");
}

function conversationAbsenceObservations(evidence: readonly ConversationStateEvidence[]): ConversationAbsenceObservation[] {
    const observations: ConversationAbsenceObservation[] = [];
    for (const item of evidence) {
        const details = item.details;
        if (!details || typeof details !== "object") continue;
        const candidates = [
            details.absenceObservation,
            ...(Array.isArray(details.absenceObservations) ? details.absenceObservations : []),
        ];
        for (const candidate of candidates) {
            if (!candidate || typeof candidate !== "object") continue;
            const value = candidate as Record<string, unknown>;
            const scanId = typeof value.scanId === "string" ? value.scanId : null;
            const observedAtMs = typeof value.observedAtMs === "number" ? value.observedAtMs : Number.NaN;
            if (scanId && Number.isFinite(observedAtMs)) observations.push({ scanId, observedAtMs });
        }
    }
    return observations;
}

function hasQualifiedLostObservation(evidence: readonly ConversationStateEvidence[]): boolean {
    const byScan = new Map<string, number>();
    for (const observation of conversationAbsenceObservations(evidence)) {
        const existing = byScan.get(observation.scanId);
        if (existing === undefined || observation.observedAtMs < existing) byScan.set(observation.scanId, observation.observedAtMs);
    }
    const observations = [...byScan.entries()]
        .map(([scanId, observedAtMs]) => ({ scanId, observedAtMs }))
        .sort((left, right) => left.observedAtMs - right.observedAtMs || left.scanId.localeCompare(right.scanId));
    return observations.length >= 2
        && observations[observations.length - 1].observedAtMs - observations[0].observedAtMs >= LOST_RECHECK_INTERVAL_MS;
}

function contentHashesForRevision(entry: ConversationStateEntry | null, revision: string): string[] {
    if (!entry) return [];
    const hashes = new Set<string>();
    for (const evidence of entry.evidence) {
        const details = evidence.details;
        if (!details || typeof details !== "object") continue;
        if (details.sourceRevision !== revision || typeof details.contentHash !== "string" || !details.contentHash) continue;
        hashes.add(details.contentHash);
    }
    return [...hashes];
}

function sameRefreshRootBinding(left: RecordSourceRefreshRootBinding, right: RecordSourceRefreshRootBinding): boolean {
    return left.dataRootId === right.dataRootId && left.rootPathHash === right.rootPathHash;
}

function relativeDataRootPath(dataRoot: string, filePath: string): string {
    const relative = path.relative(path.resolve(dataRoot), path.resolve(filePath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new RecordSchedulerRepairRequiredError(`refresh durable path 超出 data root：${filePath}`);
    }
    return relative.replace(/\\/gu, "/");
}

function parseRuntimeMode(value: string | undefined): RecordSchedulerRuntimeMode {
    if (value === "legacy" || value === "shadow" || value === "test" || value === "enforced") return value;
    return "enforced";
}

interface ProductionDiscoverySeed {
    host: SourceEvidenceHost;
    conversationId: string;
    title: string;
    workspaceHash: string;
    workspacePath: string | null;
    sourceUpdatedAtMs: number | null;
    record?: RecordSchedulerRuntimeDiscoveryRecord;
    discoveryError?: string;
}

interface ProductionEvidenceResult {
    seed: ProductionDiscoverySeed;
    enumeration: SourceEnumerationEvidence;
    exactFetch?: ExactFetchEvidence;
    fullSourceRead?: Awaited<ReturnType<ProductionSourceReader["readFull"]>>;
    qualifiedAbsence?: LostObservation | null;
}

interface ProductionDiscoveryListing {
    seeds: ProductionDiscoverySeed[];
    enumerations: SchedulerCandidateSnapshot["enumerations"];
}

interface FrozenRuntimeDiscovery {
    snapshot: DiscoveryCandidateSnapshot;
    enumerations: SchedulerCandidateSnapshot["enumerations"];
}

interface FrozenRuntimeSourceCapsule {
    kind: "record-runtime-source-capsule";
    discoverySnapshot: DiscoveryImmutable<DiscoveryRecordSourceSnapshot>;
    request: ProductionSourceReadRequest;
    scanId: string;
    authority: ProductionSourceAuthorityVerification;
}

interface DurableRefreshAttachment {
    pendingRefresh: PendingRefreshReference;
    durabilityReceipt: RecordSourceRefreshDurabilityReceipt;
}

interface DurableRefreshIndex {
    schemaVersion: 1;
    kind: "record-source-refresh-index";
    refreshKey: string;
    identity: ConversationStateIdentity;
    rootBinding: RecordSourceRefreshRootBinding;
    refreshTaskId: string;
    revision: number;
    attachments: DurableRefreshAttachment[];
    createdAt: string;
    updatedAt: string;
    persistedHash: string;
}

interface DurableRefreshReceiptPayload {
    schemaVersion: 1;
    kind: "record-source-refresh-receipt";
    refreshKey: string;
    identity: ConversationStateIdentity;
    sourceSnapshotId: string;
    recordWorkKey: string;
    fromRevision: string;
    desiredRevision: string;
    refreshTaskId: string;
    persistedAt: string;
}

interface RuntimeSourceMaterializationMarker {
    kind: typeof RUNTIME_SOURCE_MATERIALIZATION_MARKER_KIND;
    schemaVersion: typeof RUNTIME_SOURCE_MATERIALIZATION_MARKER_VERSION;
    taskId: string;
    candidateSnapshotId: string;
    candidateSnapshotHash: string;
    selectionHash: string;
    selected: SourceMaterializationSelection[];
    outcomes: SourceMaterializationOutcome[];
    sourceSnapshotIds: string[];
}

interface ConversationAbsenceObservation {
    scanId: string;
    observedAtMs: number;
}

function productionDiscoveryKey(request: RecordSchedulerRuntimeDiscoveryRequest): string {
    return request.requestKey || `record-discovery:${stableJsonHash({
        selector: request.selector,
        workspaceHash: request.workspaceHash || "general",
        workspacePath: request.workspacePath || null,
        hosts: request.hosts || SOURCE_EVIDENCE_HOSTS,
        limit: request.limit || 50,
        selectionLimit: request.selectionLimit || null,
        filters: request.filters || {},
        records: request.records || [],
        targets: request.targets || [],
    })}`;
}

function normalizedWorkspacePath(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        return path.resolve(value).replace(/[\\/]+$/u, "").toLowerCase();
    } catch {
        return null;
    }
}

function matchesRequestedWorkspace(candidatePath: string | null | undefined, requestedPath: string | null | undefined): boolean {
    const requested = normalizedWorkspacePath(requestedPath);
    if (!requested) return true;
    const candidate = normalizedWorkspacePath(candidatePath);
    return candidate === requested;
}

function productionSeedKey(seed: Pick<ProductionDiscoverySeed, "host" | "conversationId" | "workspaceHash">): string {
    return `${seed.host}\u0000${seed.workspaceHash}\u0000${seed.conversationId}`;
}

function matchesDiscoveryTime(seed: ProductionDiscoverySeed, filters: Record<string, unknown> | undefined): boolean {
    if (!seed.sourceUpdatedAtMs || !filters) return true;
    const after = typeof filters.after === "string" ? Date.parse(filters.after) : Number.NaN;
    const before = typeof filters.before === "string" ? Date.parse(filters.before) : Number.NaN;
    if (Number.isFinite(after) && seed.sourceUpdatedAtMs < after) return false;
    if (Number.isFinite(before) && seed.sourceUpdatedAtMs > before) return false;
    return true;
}

function sourceIdentityForSeed(seed: ProductionDiscoverySeed): SourceConversationIdentity {
    return {
        workspace: {
            workspaceId: seed.workspaceHash,
            canonicalPath: seed.workspacePath,
        },
        source: {
            kind: "endpoint",
            authority: `${seed.host}-production`,
            authoritativeRoot: `${seed.host}-production`,
            canonicalPath: seed.workspacePath,
        },
        conversationId: seed.conversationId,
    };
}

function productionSourceRequestForCandidate(
    candidate: DiscoveryImmutable<DiscoveryCandidateSnapshot["candidates"][number]>,
): ProductionSourceReadRequest {
    const identity = candidate.source.identity;
    const workspacePath = identity.workspace.canonicalPath;
    if (candidate.source.host === "codex") {
        return {
            host: "codex",
            conversationId: identity.conversationId,
            workspace: {
                workspaceId: identity.workspace.workspaceId,
                canonicalPath: workspacePath,
            },
        };
    }
    if (candidate.source.host === "claude-code") {
        return {
            host: "claude-code",
            conversationId: identity.conversationId,
            workspaceId: identity.workspace.workspaceId,
            workspacePath,
        };
    }
    if (candidate.source.host === "windsurf") {
        return {
            host: "windsurf",
            conversationId: identity.conversationId,
            workspaceId: identity.workspace.workspaceId,
            workspacePath,
            sourceAuthority: identity.source.authority,
            authoritativeRoot: identity.source.authoritativeRoot,
            sourceCanonicalPath: identity.source.canonicalPath,
            requestClass: "background",
        };
    }
    return {
        host: "antigravity",
        conversationId: identity.conversationId,
        workspaceId: identity.workspace.workspaceId,
        workspacePath,
        source: {
            endpoint: identity.source.authority,
            pbRoot: identity.source.authoritativeRoot,
            vscdbPath: identity.source.canonicalPath || identity.source.authoritativeRoot,
        },
    };
}

function parseFrozenSourceDocument(
    content: Uint8Array,
    expected: Pick<SchedulerRecordSourceSnapshot, "chain" | "conversationId">,
): ProductionSourceCanonicalDocument {
    const parsed = JSON.parse(Buffer.from(content).toString("utf8")) as ProductionSourceCanonicalDocument;
    if (!parsed || typeof parsed !== "object"
        || !parsed.source
        || parsed.source.host !== expected.chain
        || parsed.source.conversationId !== expected.conversationId
        || !Array.isArray(parsed.messages)
        || parsed.messages.some((message, index) => (
            !message
            || message.order !== index + 1
            || (message.role !== "user" && message.role !== "assistant")
            || typeof message.content !== "string"
        ))) {
        throw new Error("source content spool 与 scheduler snapshot 身份或 canonical message 顺序不一致");
    }
    return parsed;
}

function schedulerSourceSnapshot(
    candidate: DiscoveryImmutable<DiscoveryCandidateSnapshot["candidates"][number]>,
    discoverySnapshot: DiscoveryImmutable<DiscoveryRecordSourceSnapshot>,
    snapshotRef: ImmutableBlobReference,
    contentRef: ImmutableBlobReference,
): SchedulerRecordSourceSnapshot {
    const fullRead = discoverySnapshot.contractSnapshot.fullSourceRead;
    const range = fullRead.content.roundRange;
    return {
        schemaVersion: 5,
        sourceSnapshotId: discoverySnapshot.sourceSnapshotId,
        snapshotRevision: 1,
        snapshotHash: snapshotRef.hash,
        snapshotRef: structuredClone(snapshotRef),
        conversationId: candidate.source.identity.conversationId,
        chain: candidate.source.host,
        workspaceHash: candidate.source.identity.workspace.workspaceId,
        sourceRevision: discoverySnapshot.desiredRevision.revision,
        desiredRevision: discoverySnapshot.desiredRevision.revision,
        ...(isSafeRevisionSequence(discoverySnapshot.desiredRevision.sequence)
            ? { sourceRevisionSequence: discoverySnapshot.desiredRevision.sequence }
            : {}),
        ...(discoverySnapshot.desiredRevision.eventWatermark
            ? { eventWatermark: discoverySnapshot.desiredRevision.eventWatermark }
            : {}),
        contentHash: contentRef.hash,
        contentRef: structuredClone(contentRef),
        formatterVersion: discoverySnapshot.formatterVersion,
        readRange: {
            startRound: range.start,
            endRound: range.end,
            totalRounds: range.end,
        },
        complete: true,
        gaps: [],
        parseWarnings: [],
    };
}

function isSafeRevisionSequence(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function selectionLimitFromSnapshot(snapshot: Pick<SchedulerCandidateSnapshot, "selectionLimit">): number | undefined {
    return isSafeRevisionSequence(snapshot.selectionLimit) && snapshot.selectionLimit > 0 && snapshot.selectionLimit <= 200
        ? snapshot.selectionLimit
        : undefined;
}

function selectedMaterializationCandidates(
    discovery: DiscoveryCandidateSnapshot,
    selector: RecordDiscoverySelector,
    snapshot: Pick<SchedulerCandidateSnapshot, "selectionLimit">,
): readonly DiscoveryImmutable<DiscoveryCandidateSnapshot["candidates"][number]>[] {
    const candidates = selectRecordDiscoveryCandidates(discovery, selector);
    const selectionLimit = selectionLimitFromSnapshot(snapshot);
    return selectionLimit === undefined ? candidates : candidates.slice(0, selectionLimit);
}

function blockingDiscoverySourceIssues(
    discovery: DiscoveryCandidateSnapshot,
    selector: RecordDiscoverySelector,
): FrozenRuntimeSourceIssue[] {
    const selectedCandidateIds = new Set(
        selectRecordDiscoveryCandidates(discovery, selector).map(candidate => candidate.candidateId),
    );
    return discovery.candidates
        .filter(candidate => !selectedCandidateIds.has(candidate.candidateId)
            && (candidate.classification === "Unresolved" || candidate.classification === "Conflict"))
        .map(candidate => ({
            kind: candidate.classification === "Conflict" ? "conflict" as const : "unresolved" as const,
            conversationId: candidate.source.identity.conversationId,
            chain: candidate.source.host,
            workspaceHash: candidate.source.identity.workspace.workspaceId,
            code: candidate.classificationReason.code,
            reason: candidate.classificationReason.code,
            evidenceHashes: [...new Set([
                candidate.evidenceHash,
                ...candidate.classificationReason.evidenceRefs,
            ])].sort(),
        }));
}

function sourceIssueKey(issue: Pick<FrozenRuntimeSourceIssue, "chain" | "conversationId" | "code" | "reason" | "evidenceHashes">): string {
    return stableJsonHash({
        host: issue.chain,
        conversationId: issue.conversationId || null,
        code: issue.code,
        message: issue.reason,
        evidenceHashes: [...issue.evidenceHashes].sort(),
    });
}

function dedupeSourceIssues(issues: readonly FrozenRuntimeSourceIssue[]): FrozenRuntimeSourceIssue[] {
    const unique = new Map<string, FrozenRuntimeSourceIssue>();
    for (const issue of issues) unique.set(sourceIssueKey(issue), structuredClone(issue));
    return [...unique.values()].sort((left, right) => sourceIssueKey(left).localeCompare(sourceIssueKey(right)));
}

function schedulerSourceIssue(issue: FrozenRuntimeSourceIssue): SchedulerSourceResolutionIssue {
    return {
        host: issue.chain,
        ...(issue.conversationId ? { conversationId: issue.conversationId } : {}),
        code: issue.code,
        message: issue.reason,
        evidenceHashes: [...issue.evidenceHashes],
    };
}

function frozenSourceIssue(issue: SchedulerSourceResolutionIssue): FrozenRuntimeSourceIssue {
    return {
        kind: issue.code.includes("conflict") ? "conflict" : "unresolved",
        chain: issue.host,
        ...(issue.conversationId ? { conversationId: issue.conversationId } : {}),
        code: issue.code,
        reason: issue.message,
        evidenceHashes: [...issue.evidenceHashes],
    };
}

function frozenDiscoverySourceResolution(input: {
    discovery: DiscoveryCandidateSnapshot;
    schedulerSnapshot: SchedulerCandidateSnapshot;
    selector: RecordDiscoverySelector;
    request: RecordSchedulerRuntimeDiscoveryRequest;
}): { resolution: SchedulerSourceResolution; knownSelectedCount: number; candidateIssueCount: number } {
    const explicitTargetHosts = new Set((input.request.targets || []).map(target => target.host));
    const hostEnumerations = new Map(input.schedulerSnapshot.enumerations.map(enumeration => [enumeration.chain, enumeration]));
    const candidateIssues = blockingDiscoverySourceIssues(input.discovery, input.selector).map(issue => {
        const hostError = hostEnumerations.get(issue.chain)?.error;
        return hostError && !issue.reason.includes(hostError)
            ? { ...issue, reason: `${issue.reason}; ${hostError}` }
            : issue;
    });
    const scopeIssues: FrozenRuntimeSourceIssue[] = input.schedulerSnapshot.enumerations
        .filter(enumeration => !explicitTargetHosts.has(enumeration.chain)
            && (!enumeration.complete || !enumeration.paginationExhausted || enumeration.truncated || Boolean(enumeration.error)))
        .map(enumeration => ({
            kind: "unresolved",
            chain: enumeration.chain,
            code: "source-list-incomplete",
            reason: enumeration.error || `${enumeration.chain} source list 未完整枚举请求范围`,
            evidenceHashes: [input.schedulerSnapshot.snapshotHash],
        }));
    const issues = dedupeSourceIssues([...candidateIssues, ...scopeIssues]);
    const knownSelectedCount = selectedMaterializationCandidates(
        input.discovery,
        input.selector,
        input.schedulerSnapshot,
    ).length + candidateIssues.length;
    return {
        resolution: {
            phase: "frozen",
            selectedCount: scopeIssues.length > 0 ? null : knownSelectedCount,
            materializedCount: 0,
            unresolvedCount: issues.length,
            issues: issues.map(schedulerSourceIssue),
        },
        knownSelectedCount,
        candidateIssueCount: candidateIssues.length,
    };
}

function candidateIssueCountForMaterialization(ledger: Pick<RecordSchedulerLedger, "task" | "sourceMaterialization">): number {
    if (ledger.task.sourceResolution?.phase === "frozen") {
        return ledger.task.sourceResolution.issues.filter(issue => issue.conversationId !== undefined).length;
    }
    const selectedCount = ledger.sourceMaterialization?.selected.length || 0;
    return Math.max(0, ledger.task.recordItems.total - selectedCount);
}

function discoverySequence(value: number | null | undefined): number {
    const normalized = Math.floor(value || Date.now());
    return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, normalized));
}

function buildUnresolvedEnumeration(seed: ProductionDiscoverySeed, requestKey: string, reason: string): SourceEnumerationEvidence {
    const completedAt = new Date().toISOString();
    const sequence = discoverySequence(seed.sourceUpdatedAtMs);
    return buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: seed.host,
        identity: sourceIdentityForSeed(seed),
        sourceRevision: {
            revision: `unresolved:${stableJsonHash({ requestKey, host: seed.host, conversationId: seed.conversationId })}`,
            contentCursor: null,
            eventWatermark: null,
            sequence,
        },
        pagination: { cursor: "unresolved", pages: 1, limit: null, truncated: true },
        enumerationComplete: false,
        cacheBypassed: true,
        exactFetchResult: "unresolved",
        errors: [{ code: "source_unavailable", message: reason }],
        warnings: [],
        observedAt: {
            scanId: `record-discovery:${stableJsonHash({ requestKey, host: seed.host, conversationId: seed.conversationId })}`,
            sequence,
            startedAt: completedAt,
            completedAt,
        },
        targetStatus: "unknown",
    });
}

function antigravityUnavailable<T>(message: string): AntigravityEvidenceCallResult<T> {
    return { kind: "error", failure: { code: "unavailable", message }, cache: "bypassed" };
}

function createProductionAntigravityReader(ids: string[], revision: string): AntigravityLsEvidenceReader {
    const unavailable = "生产 discovery 当前无法证明 .pb/vscdb 与 LS 枚举一致";
    return {
        listLsPage: async input => ({
            kind: "ok",
            value: { ids: input.cursor === null ? ids : [], nextCursor: null, truncated: false },
            revision,
            contentCursor: null,
            cache: "bypassed",
        }),
        listPb: async () => antigravityUnavailable<AntigravityLsEvidencePage>(unavailable),
        listVscdb: async () => antigravityUnavailable<AntigravityLsEvidencePage>(unavailable),
        fetchLs: async () => antigravityUnavailable<AntigravityLsEvidenceExactValue>(unavailable),
        fetchPb: async () => antigravityUnavailable<AntigravityLsEvidenceExactValue>(unavailable),
        fetchVscdb: async () => antigravityUnavailable<AntigravityLsEvidenceExactValue>(unavailable),
        readFullLs: async () => antigravityUnavailable<AntigravityLsEvidenceFullValue>(unavailable),
    };
}

const DEFAULT_PRODUCTION_SOURCE_APIS: RecordSchedulerProductionSourceApis = {
    listCodexThreads: listRecentCodexThreads,
    enumerateCodex: enumerateCodexSourceEvidence,
    fetchCodex: fetchCodexSourceEvidence,
    listClaudeCodeThreads: listRecentClaudeCodeThreads,
    enumerateClaudeCode: enumerateClaudeCodeSourceEvidence,
    fetchClaudeCode: fetchClaudeCodeSourceEvidence,
    listWindsurfThreads: listRecentWindsurfThreads,
    scanWindsurf: scanWindsurfSourceEvidence,
    listAntigravityConversations: listConversationsByMtime,
    createAntigravityAdapter: createAntigravityLsSourceEvidenceAdapter,
};

function productionSourceApis(overrides: Partial<RecordSchedulerProductionSourceApis>): RecordSchedulerProductionSourceApis {
    const resolved = { ...DEFAULT_PRODUCTION_SOURCE_APIS };
    for (const key of Object.keys(overrides) as Array<keyof RecordSchedulerProductionSourceApis>) {
        const value = overrides[key];
        if (value) Object.assign(resolved, { [key]: value });
    }
    return resolved;
}

async function listProductionDiscoverySeeds(
    request: RecordSchedulerRuntimeDiscoveryRequest,
    apis: RecordSchedulerProductionSourceApis,
): Promise<ProductionDiscoveryListing> {
    const hosts = request.hosts && request.hosts.length > 0 ? [...new Set(request.hosts)] : [...SOURCE_EVIDENCE_HOSTS];
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit || 50)));
    const scanLimit = PRODUCTION_DISCOVERY_HARD_LIMIT;
    const workspaceHash = request.workspaceHash || "general";
    const seeds = new Map<string, ProductionDiscoverySeed>();
    const enumerations = new Map<SourceEvidenceHost, SchedulerCandidateSnapshot["enumerations"][number]>();
    const add = (seed: ProductionDiscoverySeed) => {
        if (!hosts.includes(seed.host) || !seed.conversationId.trim() || !matchesDiscoveryTime(seed, request.filters)) return;
        const key = productionSeedKey(seed);
        const existing = seeds.get(key);
        seeds.set(key, {
            ...(existing || seed),
            ...seed,
            record: seed.record || existing?.record,
            sourceUpdatedAtMs: seed.sourceUpdatedAtMs ?? existing?.sourceUpdatedAtMs ?? null,
            discoveryError: seed.discoveryError || existing?.discoveryError,
        });
    };
    const markHostDiscoveryError = (host: SourceEvidenceHost, error: unknown) => {
        const message = `${host} source discovery 失败：${error instanceof Error ? error.message : String(error)}`;
        enumerations.set(host, {
            chain: host,
            complete: false,
            paginationExhausted: false,
            truncated: true,
            error: message,
        });
        for (const [key, seed] of seeds) {
            if (seed.host === host) seeds.set(key, { ...seed, discoveryError: message });
        }
    };
    const markHostDiscoverySuccess = (host: SourceEvidenceHost, observedCount: number) => {
        const truncated = observedCount >= scanLimit;
        enumerations.set(host, {
            chain: host,
            complete: !truncated,
            paginationExhausted: !truncated,
            truncated,
            ...(truncated ? { error: `${host} source discovery 达到扫描上限 ${scanLimit}` } : {}),
        });
    };

    for (const record of request.records || []) {
        const recordHosts = record.host ? [record.host] : hosts;
        for (const host of recordHosts) {
            add({
                host,
                conversationId: record.conversationId,
                title: record.title,
                workspaceHash: record.workspaceHash,
                workspacePath: record.workspacePath,
                sourceUpdatedAtMs: null,
                record,
            });
        }
    }

    for (const target of request.targets || []) {
        add({
            host: target.host,
            conversationId: target.conversationId,
            title: target.title || target.conversationId,
            workspaceHash: target.workspaceHash,
            workspacePath: target.workspacePath,
            sourceUpdatedAtMs: null,
            record: (request.records || []).find(record => record.conversationId === target.conversationId
                && (!record.host || record.host === target.host)),
        });
    }

    if (hosts.includes("codex")) {
        try {
            const threads = apis.listCodexThreads(scanLimit);
            markHostDiscoverySuccess("codex", threads.length);
            for (const thread of threads) {
                if (!matchesRequestedWorkspace(thread.cwd, request.workspacePath)) continue;
                add({ host: "codex", conversationId: thread.id, title: thread.title, workspaceHash, workspacePath: thread.cwd || request.workspacePath || null, sourceUpdatedAtMs: thread.updatedAtMs || null });
            }
        } catch (error) {
            markHostDiscoveryError("codex", error);
        }
    }
    if (hosts.includes("claude-code")) {
        try {
            const threads = apis.listClaudeCodeThreads(scanLimit);
            markHostDiscoverySuccess("claude-code", threads.length);
            for (const thread of threads) {
                if (!matchesRequestedWorkspace(thread.cwd, request.workspacePath)) continue;
                add({ host: "claude-code", conversationId: thread.id, title: thread.title, workspaceHash, workspacePath: thread.cwd || request.workspacePath || null, sourceUpdatedAtMs: thread.updatedAtMs || null });
            }
        } catch (error) {
            markHostDiscoveryError("claude-code", error);
        }
    }
    if (hosts.includes("windsurf")) {
        try {
            const threads = await apis.listWindsurfThreads(scanLimit, { requestClass: "background" });
            markHostDiscoverySuccess("windsurf", threads.length);
            for (const thread of threads) {
                if (!matchesRequestedWorkspace(thread.cwd, request.workspacePath)) continue;
                add({ host: "windsurf", conversationId: thread.cascadeId || thread.id, title: thread.title, workspaceHash, workspacePath: thread.cwd || request.workspacePath || null, sourceUpdatedAtMs: Date.parse(thread.lastModifiedTime || thread.createdTime || "") || null });
            }
        } catch (error) {
            markHostDiscoveryError("windsurf", error);
        }
    }
    if (hosts.includes("antigravity")) {
        try {
            const conversations = apis.listAntigravityConversations({
                ...(typeof request.filters?.after === "string" ? { after: request.filters.after } : {}),
                ...(typeof request.filters?.before === "string" ? { before: request.filters.before } : {}),
                limit: scanLimit,
            });
            markHostDiscoverySuccess("antigravity", conversations.length);
            for (const conversation of conversations) {
                add({ host: "antigravity", conversationId: conversation.id, title: conversation.title || conversation.id, workspaceHash, workspacePath: request.workspacePath || null, sourceUpdatedAtMs: conversation.mtime.getTime() });
            }
        } catch (error) {
            markHostDiscoveryError("antigravity", error);
        }
    }
    const requestedTargetKeys = new Set((request.targets || []).map(target => productionSeedKey({
        host: target.host,
        conversationId: target.conversationId,
        workspaceHash: target.workspaceHash,
    })));
    const seedsByHost = new Map(hosts.map(host => [host, [...seeds.values()]
        .filter(seed => seed.host === host)
        .sort((left, right) => {
            const targetOrder = Number(requestedTargetKeys.has(productionSeedKey(right)))
                - Number(requestedTargetKeys.has(productionSeedKey(left)));
            const recordOrder = Number(Boolean(right.record)) - Number(Boolean(left.record));
            return targetOrder || recordOrder || productionSeedKey(left).localeCompare(productionSeedKey(right));
        })] as const));
    const selected: ProductionDiscoverySeed[] = [];
    for (let index = 0; selected.length < limit; index += 1) {
        let added = false;
        for (const host of hosts) {
            const seed = seedsByHost.get(host)?.[index];
            if (!seed) continue;
            selected.push(seed);
            added = true;
            if (selected.length >= limit) break;
        }
        if (!added) break;
    }
    return {
        seeds: selected,
        enumerations: hosts.map(host => enumerations.get(host) || ({
            chain: host,
            complete: false,
            paginationExhausted: false,
            truncated: true,
            error: `${host} source discovery 未产生可判定摘要`,
        })),
    };
}

async function collectProductionEvidence(
    seed: ProductionDiscoverySeed,
    requestKey: string,
    antigravityIds: string[],
    apis: RecordSchedulerProductionSourceApis,
    scanOptions: Required<RecordSchedulerProductionSourceEvidenceAdapterOptions>,
    sourceReader?: ProductionSourceReader,
): Promise<ProductionEvidenceResult> {
    const sequence = discoverySequence(seed.sourceUpdatedAtMs);
    const finalize = (result: ProductionEvidenceResult): ProductionEvidenceResult => {
        if (!seed.sourceUpdatedAtMs || result.enumeration.sourceRevision.sequence !== null) return result;
        const revisionSequence = discoverySequence(seed.sourceUpdatedAtMs);
        const sourceRevision = { ...result.enumeration.sourceRevision, sequence: revisionSequence };
        const enumeration = buildSourceEnumerationEvidence({
            adapterVersion: result.enumeration.adapterVersion,
            host: result.enumeration.host,
            identity: result.enumeration.identity,
            sourceRevision,
            pagination: result.enumeration.pagination,
            enumerationComplete: result.enumeration.enumerationComplete,
            cacheBypassed: result.enumeration.cacheBypassed,
            exactFetchResult: result.enumeration.exactFetchResult,
            errors: result.enumeration.errors,
            warnings: result.enumeration.warnings,
            observedAt: result.enumeration.observedAt,
            targetStatus: result.enumeration.targetStatus,
        });
        const exactFetch = result.exactFetch ? buildExactFetchEvidence({
            adapterVersion: result.exactFetch.adapterVersion,
            host: result.exactFetch.host,
            identity: result.exactFetch.identity,
            sourceRevision: { ...result.exactFetch.sourceRevision, sequence: revisionSequence },
            pagination: result.exactFetch.pagination,
            enumerationComplete: result.exactFetch.enumerationComplete,
            cacheBypassed: result.exactFetch.cacheBypassed,
            exactFetchResult: result.exactFetch.exactFetchResult,
            errors: result.exactFetch.errors,
            warnings: result.exactFetch.warnings,
            observedAt: result.exactFetch.observedAt,
        }) : undefined;
        const qualifiedAbsence = result.qualifiedAbsence && exactFetch
            ? buildLostObservation({ enumeration, exactFetch })
            : result.qualifiedAbsence;
        return {
            seed,
            enumeration,
            ...(exactFetch ? { exactFetch } : {}),
            ...(result.fullSourceRead ? { fullSourceRead: result.fullSourceRead } : {}),
            ...(qualifiedAbsence ? { qualifiedAbsence } : {}),
        };
    };
    try {
        if (sourceReader) {
            const readerRequest: ProductionSourceReadRequest = seed.host === "codex"
                ? {
                    host: "codex",
                    conversationId: seed.conversationId,
                    workspace: { workspaceId: seed.workspaceHash, canonicalPath: seed.workspacePath },
                }
                : seed.host === "claude-code"
                    ? {
                        host: "claude-code",
                        conversationId: seed.conversationId,
                        workspaceId: seed.workspaceHash,
                        workspacePath: seed.workspacePath,
                    }
                    : seed.host === "windsurf"
                        ? {
                            host: "windsurf",
                            conversationId: seed.conversationId,
                            workspaceId: seed.workspaceHash,
                            workspacePath: seed.workspacePath,
                            requestClass: "background",
                        }
                        : {
                            host: "antigravity",
                            conversationId: seed.conversationId,
                            workspaceId: seed.workspaceHash,
                            workspacePath: seed.workspacePath,
                            source: {
                                endpoint: "antigravity-production",
                                pbRoot: seed.workspacePath || "antigravity-production-pb",
                                vscdbPath: seed.workspacePath || "antigravity-production-vscdb",
                            },
                        };
            const result = await sourceReader.scan(readerRequest);
            return finalize({
                seed,
                enumeration: result.enumeration,
                exactFetch: result.exactFetch,
                fullSourceRead: result.fullSourceRead,
                qualifiedAbsence: result.qualifiedAbsence,
            });
        }
        const startedAt = scanOptions.now().toISOString();
        const scanId = scanOptions.scanIdFactory({
            requestKey,
            host: seed.host,
            conversationId: seed.conversationId,
            startedAt,
        });
        if (seed.host === "codex") {
            const options = {
                conversationId: seed.conversationId,
                workspace: { workspaceId: seed.workspaceHash, canonicalPath: seed.workspacePath },
                scanId,
                sequence,
                cacheBypassed: true,
            };
            const result = await apis.enumerateCodex(options);
            const exactFetch = result.evidence.targetStatus === "absent"
                ? (await apis.fetchCodex(options)).evidence
                : undefined;
            return finalize({ seed, enumeration: result.evidence, exactFetch });
        }
        if (seed.host === "claude-code") {
            const options = {
                conversationId: seed.conversationId,
                workspaceId: seed.workspaceHash,
                workspacePath: seed.workspacePath,
                scanId,
                sequence,
                cacheBypassed: true,
                limit: 200,
            };
            const result = apis.enumerateClaudeCode(options);
            const exactFetch = result.enumeration.targetStatus === "absent"
                ? apis.fetchClaudeCode(options).exactFetch
                : undefined;
            return finalize({ seed, enumeration: result.enumeration, exactFetch });
        }
        if (seed.host === "windsurf") {
            const result = await apis.scanWindsurf(seed.conversationId, {
                workspaceId: seed.workspaceHash,
                workspacePath: seed.workspacePath,
                scanId,
                sequence,
                requestClass: "background",
            });
            return finalize({ seed, enumeration: result.enumeration, exactFetch: result.exactFetch });
        }
        const adapter = apis.createAntigravityAdapter(createProductionAntigravityReader(
            antigravityIds,
            `antigravity:${stableJsonHash({ requestKey, antigravityIds })}`,
        ));
        const evidenceRequest = {
            cascadeId: seed.conversationId,
            workspaceId: seed.workspaceHash,
            workspacePath: seed.workspacePath,
            source: {
                endpoint: "antigravity-production",
                pbRoot: seed.workspacePath || "antigravity-pb-unavailable",
                vscdbPath: seed.workspacePath || "antigravity-vscdb-unavailable",
            },
            scan: { scanId, sequence, startedAt, completedAt: scanOptions.now().toISOString() },
            pageLimit: 200,
        };
        const enumeration = await adapter.enumerate(evidenceRequest);
        const exactFetch = enumeration.targetStatus === "absent"
            ? await adapter.fetchExact(evidenceRequest)
            : undefined;
        return finalize({ seed, enumeration, exactFetch });
    } catch (error) {
        return {
            seed,
            enumeration: buildUnresolvedEnumeration(seed, requestKey, [
                seed.discoveryError,
                error instanceof Error ? error.message : String(error),
            ].filter(Boolean).join("; ")),
        };
    }
}

function recordCoveredRevision(result: ProductionEvidenceResult) {
    const record = result.seed.record;
    if (!record) return null;
    if (record.coveredRevision) {
        const sequence = record.coveredRevisionSequence;
        return {
            revision: record.coveredRevision,
            sequence: sequence === null || (Number.isSafeInteger(sequence) && (sequence ?? -1) >= 0) ? sequence ?? null : null,
        };
    }
    const recordUpdatedAtMs = Date.parse(record.lastUpdatedAt);
    const sourceUpdatedAtMs = result.seed.sourceUpdatedAtMs;
    const sourceSequence = result.enumeration.sourceRevision.sequence;
    if (!sourceUpdatedAtMs
        || !Number.isFinite(recordUpdatedAtMs)
        || sourceSequence !== discoverySequence(sourceUpdatedAtMs)
        || recordUpdatedAtMs >= sourceUpdatedAtMs) return null;
    return {
        revision: `record-unbound:${stableJsonHash({ conversationId: record.conversationId, lastUpdatedAt: record.lastUpdatedAt })}`,
        sequence: Math.max(0, Math.floor(recordUpdatedAtMs)),
    };
}

export function createProductionRecordSchedulerSourceEvidenceAdapter(
    overrides: Partial<RecordSchedulerProductionSourceApis> = {},
    sourceReader?: ProductionSourceReader,
    options: RecordSchedulerProductionSourceEvidenceAdapterOptions = {},
): RecordSchedulerSourceEvidenceAdapter {
    const apis = productionSourceApis(overrides);
    const productionReader = sourceReader || (Object.keys(overrides).length === 0 ? createProductionSourceReader() : undefined);
    const now = options.now || (() => new Date());
    const configuredScanIdFactory = options.scanIdFactory || (() => `record-discovery:${crypto.randomUUID()}`);
    const issuedScanIds = new Set<string>();
    const scanIdFactory: RecordSchedulerProductionScanIdFactory = input => {
        const scanId = configuredScanIdFactory(input);
        if (typeof scanId !== "string" || scanId.trim().length === 0 || issuedScanIds.has(scanId)) {
            throw new Error(`production source fallback 生成了无效或重复的 scanId: ${String(scanId)}`);
        }
        issuedScanIds.add(scanId);
        return scanId;
    };
    return {
        async buildDiscoveryInput(request) {
            const requestKey = productionDiscoveryKey(request);
            const listing = await listProductionDiscoverySeeds(request, apis);
            const seeds = listing.seeds;
            const antigravityIds = seeds.filter(seed => seed.host === "antigravity").map(seed => seed.conversationId);
            const evidence = await Promise.all(seeds.map(seed => collectProductionEvidence(
                seed,
                requestKey,
                antigravityIds,
                apis,
                { now, scanIdFactory },
                productionReader,
            )));
            const indexRevision = `record-index:${stableJsonHash((request.records || []).map(record => ({
                conversationId: record.conversationId,
                workspaceHash: record.workspaceHash,
                lastUpdatedAt: record.lastUpdatedAt,
                recordBodyHash: record.recordBodyHash,
                coveredRevision: record.coveredRevision || null,
                coveredRevisionSequence: record.coveredRevisionSequence ?? null,
            })))}`;
            const scopes = new Map<string, ReturnType<typeof buildRecordIndexScope>>();
            const entries = [];
            const absenceObservations = [];
            for (const result of evidence) {
                const workspace = result.enumeration.identity.workspace;
                if (!scopes.has(workspace.workspaceId)) {
                    scopes.set(workspace.workspaceId, buildRecordIndexScope({
                        workspace,
                        snapshotId: `record-index:${workspace.workspaceId}`,
                        indexRevision,
                        complete: true,
                        paginationComplete: true,
                        error: null,
                        extensions: {},
                    }));
                }
                if (result.seed.record) {
                    entries.push(buildRecordIndexEntry({
                        recordId: `record:${result.seed.host}:${result.seed.record.conversationId}`,
                        source: { host: result.seed.host, identity: result.enumeration.identity },
                        indexSnapshotId: `record-index:${workspace.workspaceId}`,
                        indexRevision,
                        coveredRevision: recordCoveredRevision(result),
                        recordBodyHash: result.seed.record.recordBodyHash,
                        extensions: {},
                    }));
                }
                if (result.enumeration.targetStatus === "absent" && result.exactFetch?.exactFetchResult === "not_found") {
                    const lost = result.qualifiedAbsence || buildLostObservation({ enumeration: result.enumeration, exactFetch: result.exactFetch });
                    absenceObservations.push({
                        confirmation: "absence_recheck" as const,
                        evidence: lost,
                        observedAtMs: Date.parse(lost.observedAt.completedAt),
                    });
                }
            }
            const sequence = discoverySequence(now().getTime());
            return {
                input: {
                    request: {
                        snapshotId: `record-discovery:${stableJsonHash({
                            requestKey,
                            evidence: evidence.map(item => ({
                                enumeration: item.enumeration.evidenceHash,
                                exactFetch: item.exactFetch?.evidenceHash || null,
                            })),
                        })}`,
                        discoveredAtSequence: sequence,
                        filters: {
                            hosts: request.hosts || [...SOURCE_EVIDENCE_HOSTS],
                            workspace: request.workspacePath || null,
                            extensions: normalizeResumePayload(request.filters || {}) as RecordDiscoveryInput["request"]["filters"]["extensions"],
                        },
                    },
                    sourceEnumerations: evidence.map(result => ({
                        evidence: result.enumeration,
                        ...(result.exactFetch ? { exactFetch: result.exactFetch } : {}),
                        revisionSequence: result.enumeration.sourceRevision.sequence,
                        title: result.seed.title || null,
                    })),
                    recordIndex: { scopes: [...scopes.values()], entries },
                    absenceObservations,
                },
                enumerations: listing.enumerations,
            } as unknown as RecordSchedulerDiscoveryBuildResult;
        },
    };
}

function sourceChainFromSummary(summary: Record<string, unknown>): SourceChain {
    const dataChain = summary.dataChain;
    if (dataChain === "antigravity" || dataChain === "codex" || dataChain === "claude-code" || dataChain === "windsurf") {
        return dataChain;
    }
    return "codex";
}

function workspaceHashFromSummary(summary: Record<string, unknown>): string {
    const value = summary.workspaceHash;
    return typeof value === "string" && value.length > 0 ? value : "general";
}

function schedulerEnumerationsFromDiscovery(
    snapshot: DiscoveryCandidateSnapshot,
    hostEnumerations: SchedulerCandidateSnapshot["enumerations"] = [],
): SchedulerCandidateSnapshot["enumerations"] {
    const grouped = new Map<SourceChain, DiscoveryCandidateSnapshot["sourceEnumerations"][number][]>();
    for (const envelope of snapshot.sourceEnumerations) {
        const chain = envelope.evidence.host;
        const existing = grouped.get(chain) || [];
        existing.push(envelope);
        grouped.set(chain, existing);
    }
    const merged = new Map<SourceChain, SchedulerCandidateSnapshot["enumerations"][number]>();
    for (const enumeration of hostEnumerations) merged.set(enumeration.chain, structuredClone(enumeration));
    for (const [chain, envelopes] of grouped) {
        const errors = [...new Set(envelopes.flatMap(envelope => envelope.evidence.errors.map(error => error.message)))];
        const watermarks = envelopes.map(envelope => (
            envelope.evidence.sourceRevision.eventWatermark || envelope.evidence.sourceRevision.revision
        )).sort();
        const evidenceEnumeration: SchedulerCandidateSnapshot["enumerations"][number] = {
            chain,
            complete: envelopes.every(envelope => (
                envelope.evidence.enumerationComplete
                && envelope.evidence.errors.length === 0
                && envelope.evidence.cacheBypassed
            )),
            paginationExhausted: envelopes.every(envelope => !envelope.evidence.pagination.truncated),
            truncated: envelopes.some(envelope => envelope.evidence.pagination.truncated),
            watermark: watermarks.length === 1 ? watermarks[0] : stableJsonHash(watermarks),
            ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
        };
        const hostEnumeration = merged.get(chain);
        const combinedErrors = [...new Set([hostEnumeration?.error, evidenceEnumeration.error].filter((value): value is string => Boolean(value)))];
        merged.set(chain, hostEnumeration ? {
            chain,
            complete: hostEnumeration.complete && evidenceEnumeration.complete,
            paginationExhausted: hostEnumeration.paginationExhausted && evidenceEnumeration.paginationExhausted,
            truncated: hostEnumeration.truncated || evidenceEnumeration.truncated,
            ...(evidenceEnumeration.watermark ? { watermark: evidenceEnumeration.watermark } : {}),
            ...(combinedErrors.length > 0 ? { error: combinedErrors.join("; ") } : {}),
        } : evidenceEnumeration);
    }
    return [...merged.values()].sort((left, right) => left.chain.localeCompare(right.chain));
}

function schedulerSnapshotFromDiscovery(
    snapshot: DiscoveryCandidateSnapshot,
    requestMode: RecordSchedulerRuntimeAdmitRequest["requestMode"],
    now: string,
    hostEnumerations: SchedulerCandidateSnapshot["enumerations"],
    snapshotRef: ImmutableBlobReference,
    selectionLimit?: number,
): SchedulerCandidateSnapshot {
    const enumerations = schedulerEnumerationsFromDiscovery(snapshot, hostEnumerations);
    return {
        schemaVersion: 5,
        snapshotId: snapshot.snapshotId,
        snapshotRevision: 2,
        snapshotHash: snapshotRef.hash,
        snapshotRef: structuredClone(snapshotRef),
        createdAt: now,
        requestMode,
        filters: stableObject(snapshot.request.filters),
        ...(isSafeRevisionSequence(selectionLimit) && selectionLimit > 0 && selectionLimit <= 200
            ? { selectionLimit }
            : {}),
        enumerations,
        candidates: snapshot.candidates.map(candidate => ({
            conversationId: candidate.source.identity.conversationId,
            chain: candidate.source.host,
            workspaceHash: candidate.source.identity.workspace.workspaceId,
            state: schedulerCandidateState(candidate, requestMode),
            evidence: [...candidate.sourceEvidenceRefs, ...candidate.recordIndexEvidenceRefs, ...candidate.absenceEvidenceRefs],
            evidenceHash: hash(candidate),
        })),
        recordIndexRevision: snapshot.recordIndex.scopes.map(scope => scope.indexRevision).sort().join(",") || undefined,
    };
}

function pendingSchedulerSnapshot(
    taskId: string,
    request: RecordSchedulerRuntimeAdmitRequest,
    now: string,
): SchedulerCandidateSnapshot {
    const requestedChains = request.discovery?.hosts && request.discovery.hosts.length > 0
        ? [...new Set(request.discovery.hosts)]
        : [sourceChainFromSummary(request.requestSummary)];
    const binding = {
        phase: request.discovery ? "pending-discovery" : "direct-runtime-adapter",
        taskId,
        requestMode: request.requestMode,
        requestSummary: request.requestSummary,
        requestedChains,
        selectionLimit: request.discovery?.selectionLimit || null,
    };
    const snapshotHash = hash(binding);
    return {
        schemaVersion: 5,
        snapshotId: `runtime:${taskId}:candidate:pending`,
        snapshotRevision: 1,
        snapshotHash,
        snapshotRef: {
            path: `record-scheduler-runtime/${taskId}/candidate-snapshot.json`,
            hash: snapshotHash,
            byteLength: Buffer.byteLength(JSON.stringify(binding), "utf8"),
        },
        createdAt: now,
        requestMode: request.requestMode,
        filters: stableObject(request.requestSummary),
        ...(isSafeRevisionSequence(request.discovery?.selectionLimit)
            && request.discovery.selectionLimit > 0
            && request.discovery.selectionLimit <= 200
            ? { selectionLimit: request.discovery.selectionLimit }
            : {}),
        enumerations: requestedChains.map(chain => ({
            chain,
            complete: false,
            paginationExhausted: false,
            truncated: true,
            error: request.discovery
                ? "record discovery pending after durable admission"
                : "record runtime adapter does not require candidate enumeration",
        })),
        candidates: [],
    };
}

function createInitialLedger(
    taskId: string,
    request: RecordSchedulerRuntimeAdmitRequest,
    now: string,
): RecordSchedulerAdmissionInitialLedger {
    const candidateSnapshot = pendingSchedulerSnapshot(taskId, request, now);
    return {
        schemaVersion: 5,
        kind: "record-scheduler-ledger",
        revision: 1,
        persistedHash: "placeholder",
        task: {
            taskId,
            schedulerEpoch: 1,
            state: "Accepted",
            requestMode: request.kind === "record-update" ? "update" : "batch_update",
            candidateSnapshotId: candidateSnapshot.snapshotId,
            candidateSnapshotRevision: candidateSnapshot.snapshotRevision,
            admission: { state: "LedgerCreated" },
            createdAt: now,
            updatedAt: now,
            repairState: "None",
            sourceResolution: {
                phase: "pending",
                selectedCount: null,
                materializedCount: 0,
                unresolvedCount: 0,
                issues: [],
            },
            recordItems: { total: 0, succeeded: 0, failed: 0, unresolved: 0 },
            units: { materialized: 0, eligible: 0, running: 0, done: 0, failed: 0 },
            aheadTaskCount: 0,
        },
        candidateSnapshot,
        sourceSnapshots: [],
        recordWork: [],
        units: [],
        attempts: [],
        commits: [],
    };
}

function nextTaskState(state: TaskState, target: TaskState): TaskState[] {
    if (target === "RepairRequired" && !isTerminalTaskState(state)) return ["RepairRequired"];
    const completesNormally = target === "Succeeded" || target === "Deferred";
    const paths: Partial<Record<TaskState, TaskState[]>> = {
        Accepted: completesNormally ? ["Preparing", "Queued", "Running", "Committing", target] : ["Preparing", "Queued", "Running", target],
        Preparing: completesNormally ? ["Queued", "Running", "Committing", target] : ["Queued", "Running", target],
        Queued: completesNormally ? ["Running", "Committing", target] : ["Running", target],
        Running: completesNormally ? ["Committing", target] : [target],
        Committing: [target],
    };
    return paths[state] || [];
}

export class RecordSchedulerRuntime {
    readonly mode: RecordSchedulerRuntimeMode;
    readonly control: RecordSchedulerControl;
    readonly ownerId: string;
    readonly coordinator: RecordSchedulerCoordinator;
    private readonly now: () => Date;
    private readonly ownerLeaseMs?: number;
    private readonly executeForTest?: RecordSchedulerRuntimeOptions["executeForTest"];
    private readonly discoverForRuntime?: RecordSchedulerRuntimeOptions["discover"];
    private readonly sourceEvidenceAdapter: RecordSchedulerSourceEvidenceAdapter;
    private readonly productionSourceReader?: ProductionSourceReader;
    private readonly discoverySnapshots = new Map<string, Promise<FrozenRuntimeDiscovery>>();
    private readonly refreshLocks = new Map<string, Promise<void>>();

    constructor(options: RecordSchedulerRuntimeOptions = {}) {
        this.mode = options.mode || parseRuntimeMode(process.env.MEMORY_STORE_RECORD_SCHEDULER_RUNTIME_MODE);
        this.control = options.control || createRecordSchedulerControl();
        this.ownerId = options.ownerId || `record-scheduler-runtime:${process.pid}:${crypto.randomUUID()}`;
        this.coordinator = options.coordinator || createRecordSchedulerCoordinator();
        this.now = options.now || (() => new Date());
        this.ownerLeaseMs = options.ownerLeaseMs;
        this.executeForTest = options.executeForTest;
        this.discoverForRuntime = options.discover;
        this.productionSourceReader = options.productionSourceReader
            || (!options.discover
                && !options.sourceEvidenceAdapter
                && Object.keys(options.productionSourceApis || {}).length === 0
                ? createProductionSourceReader()
                : undefined);
        this.sourceEvidenceAdapter = options.sourceEvidenceAdapter || createProductionRecordSchedulerSourceEvidenceAdapter(
            options.productionSourceApis,
            this.productionSourceReader,
            { now: this.now, scanIdFactory: options.productionScanIdFactory },
        );
    }

    async admit(request: RecordSchedulerRuntimeAdmitRequest): Promise<RecordSchedulerRuntimeAdmissionResult> {
        const requestSummary = stableObject(request.requestSummary);
        const resumePayload = normalizeResumePayload(request.resumePayload);
        if (this.mode === "test" && !this.executeForTest) {
            throw new Error("Record scheduler test 模式只能配合 fake executor 使用");
        }
        if (typeof request.requestKey !== "string"
            || request.requestKey.length === 0
            || request.requestKey.length > 512
            || request.requestKey.trim() !== request.requestKey) {
            throw new Error("Record scheduler runtime 无法从无效 requestKey 构造稳定 admission identity");
        }
        const taskId = createRecordSchedulerTaskId();
        const normalizedRequest = { ...request, requestSummary, resumePayload };
        const initialLedger = createInitialLedger(taskId, normalizedRequest, this.now().toISOString());
        let admission: AdmitRecordSchedulerTaskResult;
        try {
            admission = await admitRecordSchedulerTask({
                kind: request.kind,
                requestKey: request.requestKey,
                initialLedger,
                immutableRequestSummary: requestSummary,
                resumePayload,
                resumeVersion: BACKGROUND_TASK_RESUME_VERSION,
                resumeHash: stableJsonHash(resumePayload),
                projection: request.backgroundProjection,
                replayTerminal: request.replayTerminal,
                run: async context => this.runAdmittedTask({
                    kind: request.kind,
                    taskId: context.taskId,
                    requestKey: request.requestKey,
                    requestSummary,
                    resumePayload,
                    context,
                }, normalizedRequest),
            });
        } catch (error) {
            const stored = readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: false });
            return {
                outcome: "UnknownOutcome",
                candidateTaskIds: stored.kind === "missing" ? [] : [taskId],
                reasons: [error instanceof Error ? error.message : String(error)],
            };
        }
        if (admission.outcome === "UnknownOutcome") {
            return {
                outcome: "UnknownOutcome",
                candidateTaskIds: admission.candidateTaskIds,
                reasons: admission.reasons,
            };
        }
        return {
            outcome: admission.outcome,
            taskId: admission.taskId,
            status: this.control.status(admission.taskId),
            admission,
        };
    }

    async discover(request: RecordSchedulerRuntimeDiscoveryRequest): Promise<DiscoveryCandidateSnapshot> {
        const discovery = await this.resolveDiscovery(request);
        await this.syncConversationStateFromDiscovery(discovery.snapshot);
        return discovery.snapshot;
    }

    private async resolveDiscovery(request: RecordSchedulerRuntimeDiscoveryRequest): Promise<FrozenRuntimeDiscovery> {
        if (request.snapshot !== undefined) {
            const snapshot = CandidateSnapshotSchema.parse(request.snapshot) as DiscoveryCandidateSnapshot;
            return { snapshot, enumerations: schedulerEnumerationsFromDiscovery(snapshot) };
        }
        const requestKey = productionDiscoveryKey(request);
        const existing = this.discoverySnapshots.get(requestKey);
        if (existing) return existing;
        const pending = (async () => {
            try {
                if (this.discoverForRuntime) {
                    const snapshot = CandidateSnapshotSchema.parse(await this.discoverForRuntime(request)) as DiscoveryCandidateSnapshot;
                    return { snapshot, enumerations: schedulerEnumerationsFromDiscovery(snapshot) };
                }
                const built = request.input !== undefined
                    ? request.input
                    : await this.sourceEvidenceAdapter.buildDiscoveryInput(request);
                const buildResult = built && typeof built === "object" && "input" in built && "enumerations" in built
                    ? built as RecordSchedulerDiscoveryBuildResult
                    : undefined;
                const input = buildResult?.input || built as RecordDiscoveryInput | undefined;
                if (!input) throw new RecordSchedulerRepairRequiredError(`Record discovery ${requestKey} 缺少生产 input`);
                const durableInput = await this.mergeDurableAbsenceHistory(input);
                const snapshot = CandidateSnapshotSchema.parse(discoverRecordCandidates(durableInput)) as DiscoveryCandidateSnapshot;
                return {
                    snapshot,
                    enumerations: buildResult?.enumerations
                        ? buildResult.enumerations.map(enumeration => structuredClone(enumeration))
                        : schedulerEnumerationsFromDiscovery(snapshot),
                };
            } catch (error) {
                if (error instanceof RecordSchedulerRepairRequiredError) throw error;
                throw new RecordSchedulerRepairRequiredError(
                    `Record discovery ${requestKey} 无法冻结候选快照：${error instanceof Error ? error.message : String(error)}`,
                );
            }
        })();
        this.discoverySnapshots.set(requestKey, pending);
        try {
            return await pending;
        } finally {
            if (this.discoverySnapshots.get(requestKey) === pending) this.discoverySnapshots.delete(requestKey);
        }
    }

    private async mergeDurableAbsenceHistory(input: RecordDiscoveryInput): Promise<RecordDiscoveryInput> {
        const currentAbsenceObservations = input.absenceObservations ?? [];
        if (currentAbsenceObservations.length === 0) return input;
        const targetKeys = new Set(currentAbsenceObservations.map(observation => canonicalSourceIdentityKey({
            host: observation.evidence.host,
            identity: observation.evidence.identity,
        })));
        const targetSummaryKeys = new Set(currentAbsenceObservations.map(observation => productionSeedKey({
            host: observation.evidence.host,
            conversationId: observation.evidence.identity.conversationId,
            workspaceHash: observation.evidence.identity.workspace.workspaceId,
        })));
        const sourceEnumerations = [...input.sourceEnumerations];
        const absenceObservations = [...currentAbsenceObservations];
        const enumerationHashes = new Set(sourceEnumerations.map(envelope => envelope.evidence.evidenceHash));
        const observationHashes = new Set(absenceObservations.map(observation => observation.evidence.evidenceHash));
        for (const taskId of listRecordSchedulerLedgerTaskIds()) {
            const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (stored.kind !== "current"
                || !schedulerLedgerBelongsToRoot(stored.ledger, this.control.dataRoot)
                || stored.ledger.candidateSnapshot.snapshotId.endsWith(":pending")
                || !stored.ledger.candidateSnapshot.candidates.some(candidate => targetSummaryKeys.has(productionSeedKey({
                    host: candidate.chain,
                    conversationId: candidate.conversationId,
                    workspaceHash: candidate.workspaceHash,
                })))) continue;
            let historical: FrozenRuntimeDiscovery;
            try {
                historical = await this.readFrozenDiscovery(taskId);
            } catch (error) {
                throw new RecordSchedulerRepairRequiredError(
                    `Lost observation 历史 ledger ${taskId} 的 CandidateSnapshot 不可回读：${error instanceof Error ? error.message : String(error)}`,
                );
            }
            const matchingEnumerations = historical.snapshot.sourceEnumerations.filter(envelope => targetKeys.has(
                canonicalSourceIdentityKey({ host: envelope.evidence.host, identity: envelope.evidence.identity }),
            ));
            const matchingHashes = new Set(matchingEnumerations.map(envelope => envelope.evidence.evidenceHash));
            for (const envelope of matchingEnumerations) {
                if (!enumerationHashes.has(envelope.evidence.evidenceHash)) {
                    sourceEnumerations.push(structuredClone(envelope));
                    enumerationHashes.add(envelope.evidence.evidenceHash);
                }
            }
            for (const observation of historical.snapshot.absenceObservations ?? []) {
                if (!matchingHashes.has(observation.evidence.enumerationEvidenceHash)
                    || observationHashes.has(observation.evidence.evidenceHash)) continue;
                absenceObservations.push(structuredClone(observation));
                observationHashes.add(observation.evidence.evidenceHash);
            }
        }
        return {
            ...input,
            sourceEnumerations,
            absenceObservations,
        };
    }

    private async syncConversationStateFromDiscovery(
        snapshot: DiscoveryCandidateSnapshot,
        taskId?: string,
    ): Promise<void> {
        await this.ensureConversationStateStore(snapshot);
        for (const candidate of snapshot.candidates) {
            const identity = conversationStateIdentity({
                chain: candidate.source.host,
                workspaceHash: candidate.source.identity.workspace.workspaceId,
                conversationId: candidate.source.identity.conversationId,
            });
            const sourceKey = canonicalSourceIdentityKey(candidate.source);
            const enumerations = snapshot.sourceEnumerations.filter(envelope => (
                canonicalSourceIdentityKey({ host: envelope.evidence.host, identity: envelope.evidence.identity }) === sourceKey
            ));
            const enumeration = [...enumerations].sort((left, right) => (
                Date.parse(right.evidence.observedAt.completedAt) - Date.parse(left.evidence.observedAt.completedAt)
            ))[0];
            const indexEntries = snapshot.recordIndex.entries.filter(entry => canonicalSourceIdentityKey(entry.source) === sourceKey);
            const coveredRevision = indexEntries.length === 1 ? indexEntries[0].coveredRevision?.revision ?? null : null;
            const recordBodyHash = indexEntries.length === 1 ? indexEntries[0].recordBodyHash : null;
            const latestObservedRevision = enumeration?.evidence.sourceRevision.revision
                || candidate.sourceRevision?.revision
                || null;
            const complete = enumeration ? isCompleteEnumerationEvidence(enumeration.evidence) : false;
            const observedAt = enumeration?.evidence.observedAt.completedAt || this.now().toISOString();
            const evidence: ConversationStateEvidence = {
                source: "record-discovery",
                complete,
                observedAt,
                evidenceHash: candidate.evidenceHash,
                ...(enumeration ? { scanId: enumeration.evidence.observedAt.scanId } : {}),
                details: {
                    candidateState: candidate.classification,
                    classificationReason: structuredClone(candidate.classificationReason),
                    sourceRevision: latestObservedRevision,
                    absenceObservations: snapshot.absenceObservations
                        .filter(observation => canonicalSourceIdentityKey({
                            host: observation.evidence.host,
                            identity: observation.evidence.identity,
                        }) === sourceKey)
                        .map(observation => ({
                            confirmation: observation.confirmation,
                            observedAtMs: observation.observedAtMs,
                            scanId: observation.evidence.observedAt.scanId,
                            evidenceHash: observation.evidence.evidenceHash,
                        })),
                },
            };
            await this.upsertConversationStateWithRetry(identity, existing => {
                const activeTaskIds = new Set(existing?.activeTaskIds || []);
                if (taskId) activeTaskIds.add(taskId);
                const evidenceHistory = this.mergeConversationEvidence(existing?.evidence || [], evidence);
                const requestedState = candidate.classification as ConversationState;
                const state = existing?.state === "Conflict"
                    ? "Conflict"
                    : requestedState === "Lost" && !hasQualifiedLostObservation(evidenceHistory)
                        ? "Unresolved"
                        : requestedState;
                return {
                    workspace: candidate.source.identity.workspace.canonicalPath,
                    titleBestEffort: enumeration?.title || existing?.titleBestEffort || null,
                    latestObservedRevision,
                    latestEvidenceHash: candidate.evidenceHash,
                    lastCompleteScanId: complete ? enumeration?.evidence.observedAt.scanId || null : existing?.lastCompleteScanId || null,
                    recordCoveredRevision: coveredRevision,
                    recordBodyHash,
                    state,
                    evidence: evidenceHistory,
                    stateReason: state === "Unresolved" && requestedState === "Lost"
                        ? "lost-awaits-two-independent-complete-absences"
                        : candidate.classificationReason.code,
                    activeTaskIds: [...activeTaskIds],
                    recordWorkKey: existing?.recordWorkKey || null,
                    pendingRefreshKey: candidatePendingRefreshKey(state, identity, latestObservedRevision),
                    sourceObservedAt: observedAt,
                };
            });
        }
    }

    private mergeConversationEvidence(
        existing: readonly ConversationStateEvidence[],
        next: ConversationStateEvidence,
    ): ConversationStateEvidence[] {
        const unique = new Map<string, ConversationStateEvidence>();
        for (const evidence of [...existing, next]) {
            const key = evidence.evidenceHash || `${evidence.source}\u0000${evidence.scanId || ""}\u0000${evidence.observedAt}`;
            unique.set(key, structuredClone(evidence));
        }
        return [...unique.values()]
            .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
            .slice(-32);
    }

    private async upsertConversationStateWithRetry(
        identity: ConversationStateIdentity,
        patchFor: (existing: ConversationStateEntry | null) => ConversationStatePatch,
    ): Promise<ConversationStateEntry> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const read = await readRecordConversationStateStore({ dataRoot: this.control.dataRoot });
            if (read.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`conversation-state upsert 前不可读取：${read.kind}`);
            }
            const existing = read.index.entries[canonicalConversationStateKey(identity)] || null;
            const result = await upsertRecordConversationState({
                dataRoot: this.control.dataRoot,
                identity,
                patch: patchFor(existing ? structuredClone(existing) : null),
                expectedEntryRevision: existing?.entryRevision ?? null,
                nowMs: this.now().getTime(),
            });
            if (result.kind === "updated") return result.entry;
        }
        throw new RecordSchedulerRepairRequiredError(`conversation-state ${identity.chain}/${identity.conversationId} 五次 CAS 均冲突`);
    }

    private async ensureConversationStateStore(snapshot?: DiscoveryCandidateSnapshot): Promise<void> {
        const read = await readRecordConversationStateStore({ dataRoot: this.control.dataRoot });
        if (read.kind === "current") return;
        const authority = await this.buildConversationStateRepairAuthority(snapshot);
        await this.writeConversationStateAuthority(authority);
        try {
            await repairRecordConversationStateStore({
                dataRoot: this.control.dataRoot,
                authority,
                nowMs: this.now().getTime(),
            });
        } catch (error) {
            const repairedByPeer = await readRecordConversationStateStore({ dataRoot: this.control.dataRoot });
            if (repairedByPeer.kind === "current") {
                await fs.promises.rm(authority.authorityRef, { force: true }).catch(() => undefined);
                return;
            }
            throw new RecordSchedulerRepairRequiredError(
                `conversation-state ${read.kind} 权威重建失败：${error instanceof Error ? error.message : String(error)}`,
            );
        }
        const repaired = await readRecordConversationStateStore({ dataRoot: this.control.dataRoot });
        if (repaired.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`conversation-state ${read.kind} 权威重建后不可读取：${repaired.kind}`);
        }
    }

    private async buildConversationStateRepairAuthority(
        snapshot?: DiscoveryCandidateSnapshot,
    ): Promise<ConversationStateAuthoritySnapshots> {
        const rootBinding = await resolveRecordConversationStateRootBinding({ dataRoot: this.control.dataRoot });
        const capturedAt = this.now().toISOString();
        const canonicalRecordIndex = new Map<string, ConversationStateRecordIndexSnapshot>();
        const recordCoveredByIdentity = new Map<string, string | null>();
        if (path.resolve(DATA_ROOT) === path.resolve(this.control.dataRoot)) {
            for (const workspaceHash of ["general", ...listWorkspaceHashes()]) {
                for (const entry of listRecords(workspaceHash)) {
                    if (!entry.chain || !SOURCE_CHAINS.includes(entry.chain as SourceChain)) continue;
                    const identity = conversationStateIdentity({
                        chain: entry.chain as SourceChain,
                        workspaceHash,
                        conversationId: entry.conversationId,
                    });
                    const artifactIdentity = entry.commitArtifact?.identity;
                    const mainIndex = entry.commitArtifact?.mainIndex;
                    const artifactBound = artifactIdentity
                        && mainIndex
                        && artifactIdentity.conversationId === entry.conversationId
                        && mainIndex.conversationId === entry.conversationId
                        && artifactIdentity.recordId === mainIndex.recordId
                        && artifactIdentity.commitId === mainIndex.commitId
                        && artifactIdentity.coveredRevision === mainIndex.coveredRevision;
                    const record: ConversationStateRecordIndexSnapshot = {
                        identity,
                        workspace: null,
                        titleBestEffort: entry.title || null,
                        recordCoveredRevision: artifactBound ? artifactIdentity.coveredRevision : null,
                        recordBodyHash: artifactBound ? artifactIdentity.bodyHash : null,
                        observedAt: entry.lastUpdatedAt,
                    };
                    const key = canonicalConversationStateKey(identity);
                    canonicalRecordIndex.set(key, record);
                    recordCoveredByIdentity.set(key, record.recordCoveredRevision);
                }
            }
        }
        for (const entry of snapshot?.recordIndex.entries || []) {
            const identity = conversationStateIdentity({
                chain: entry.source.host,
                workspaceHash: entry.source.identity.workspace.workspaceId,
                conversationId: entry.source.identity.conversationId,
            });
            const key = canonicalConversationStateKey(identity);
            const envelope = snapshot?.sourceEnumerations.find(candidate => canonicalSourceIdentityKey({
                host: candidate.evidence.host,
                identity: candidate.evidence.identity,
            }) === canonicalSourceIdentityKey(entry.source));
            const record = {
                identity,
                workspace: entry.source.identity.workspace.canonicalPath,
                titleBestEffort: envelope?.title || null,
                recordCoveredRevision: entry.coveredRevision?.revision ?? null,
                recordBodyHash: entry.recordBodyHash,
                observedAt: capturedAt,
            };
            canonicalRecordIndex.set(key, record);
            recordCoveredByIdentity.set(key, record.recordCoveredRevision);
        }
        const recordIndex = [...canonicalRecordIndex.values()]
            .sort((left, right) => canonicalConversationStateKey(left.identity).localeCompare(canonicalConversationStateKey(right.identity)));

        const schedulerLedgers: ConversationStateSchedulerLedgerSnapshot[] = [];
        const workRegistry: ConversationStateWorkRegistrySnapshot[] = [];
        const recentCompleteEvidence: ConversationStateCompleteEvidenceSnapshot[] = [];
        const registryKeys = new Set<string>();
        await this.control.spool.initializeRoot({ mode: "open" }).catch(() => undefined);
        for (const taskId of listRecordSchedulerLedgerTaskIds()) {
            const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (stored.kind !== "current" || !schedulerLedgerBelongsToRoot(stored.ledger, this.control.dataRoot)) continue;
            const active = !isTerminalTaskState(stored.ledger.task.state);
            const identities = new Map<string, ConversationStateIdentity>();
            for (const candidate of stored.ledger.candidateSnapshot.candidates) {
                const identity = conversationStateIdentity({
                    chain: candidate.chain,
                    workspaceHash: candidate.workspaceHash,
                    conversationId: candidate.conversationId,
                });
                identities.set(canonicalConversationStateKey(identity), identity);
            }
            for (const source of stored.ledger.sourceSnapshots) {
                const identity = conversationStateIdentity(source);
                const identityKey = canonicalConversationStateKey(identity);
                identities.set(identityKey, identity);
                const work = stored.ledger.recordWork.find(candidate => (
                    candidate.chain === identity.chain
                    && candidate.workspaceHash === identity.workspaceHash
                    && candidate.conversationId === identity.conversationId
                ));
                const pendingRefresh = stored.ledger.commits
                    .filter(commit => commit.sourceSnapshotId === source.sourceSnapshotId && commit.pendingRefresh)
                    .map(commit => commit.pendingRefresh!)[0] || null;
                await this.control.spool.initializeTask({ taskId, mode: "open" });
                const capsuleBytes = await this.control.spool.readImmutable({
                    taskId,
                    kind: "source",
                    reference: source.snapshotRef,
                });
                const capsule = JSON.parse(capsuleBytes.toString("utf8")) as FrozenRuntimeSourceCapsule;
                if (capsule.kind !== "record-runtime-source-capsule"
                    || capsule.discoverySnapshot.sourceSnapshotId !== source.sourceSnapshotId) {
                    throw new RecordSchedulerRepairRequiredError(`conversation-state repair 无法验证 source capsule ${source.sourceSnapshotId}`);
                }
                const fullEvidence = capsule.discoverySnapshot.contractSnapshot.fullSourceRead;
                const coveredRevision = recordCoveredByIdentity.get(identityKey) ?? null;
                const latestObservedRevision = pendingRefresh?.desiredRevision || source.desiredRevision;
                let state: ConversationState = "Unresolved";
                if (pendingRefresh && coveredRevision !== null && coveredRevision !== latestObservedRevision) state = "Stale";
                else if (pendingRefresh && coveredRevision === null) state = "Missing";
                else if (!pendingRefresh && coveredRevision !== null && coveredRevision === latestObservedRevision) state = "Fresh";
                recentCompleteEvidence.push({
                    identity,
                    latestObservedRevision,
                    state,
                    evidence: {
                        source: "scheduler-source-spool",
                        complete: true,
                        observedAt: fullEvidence.observedAt.completedAt,
                        evidenceHash: fullEvidence.evidenceHash,
                        scanId: fullEvidence.observedAt.scanId,
                        details: {
                            contentHash: source.contentHash.startsWith("sha256:") ? source.contentHash : `sha256:${source.contentHash}`,
                            sourceRevision: source.desiredRevision,
                            sourceSnapshotId: source.sourceSnapshotId,
                            pendingRefreshKey: pendingRefresh?.refreshKey || null,
                        },
                    },
                    workspace: capsule.discoverySnapshot.source.identity.workspace.canonicalPath,
                    titleBestEffort: null,
                    observedAt: fullEvidence.observedAt.completedAt,
                });
                if (work) {
                    const registryKey = `${identityKey}\u0000${work.recordWorkKey}`;
                    if (!registryKeys.has(registryKey)) {
                        const registry = await readRecordWorkRegistry({ identity, dataRoot: this.control.dataRoot });
                        if (registry.kind !== "ready") {
                            throw new RecordSchedulerRepairRequiredError(`conversation-state repair 无法读取 work registry ${work.recordWorkKey}: ${registry.reason}`);
                        }
                        const registryWork = registry.registry.works.find(candidate => candidate.recordWorkKey === work.recordWorkKey);
                        if (!registryWork) throw new RecordSchedulerRepairRequiredError(`conversation-state repair work registry 缺少 ${work.recordWorkKey}`);
                        workRegistry.push({
                            identity,
                            activeTaskIds: [...registryWork.activeTaskIds],
                            recordWorkKey: registryWork.recordWorkKey,
                            pendingRefreshKey: pendingRefresh?.refreshKey || null,
                            observedAt: registry.registry.updatedAt,
                        });
                        registryKeys.add(registryKey);
                    }
                }
            }
            for (const outcome of stored.ledger.sourceMaterialization?.outcomes || []) {
                if (outcome.kind !== "conflict" || !outcome.sourceRevision || !outcome.contentHash) continue;
                const selection = stored.ledger.sourceMaterialization?.selected.find(candidate => candidate.sourceKey === outcome.sourceKey);
                if (!selection) {
                    throw new RecordSchedulerRepairRequiredError(`conversation-state repair conflict outcome ${outcome.sourceKey} 缺少 selection`);
                }
                const identity = conversationStateIdentity(selection);
                identities.set(canonicalConversationStateKey(identity), identity);
                recentCompleteEvidence.push({
                    identity,
                    latestObservedRevision: outcome.sourceRevision,
                    state: "Conflict",
                    evidence: {
                        source: "scheduler-source-conflict-observation",
                        complete: true,
                        observedAt: outcome.observedAt,
                        evidenceHash: outcome.evidenceHash || stableJsonHash(outcome),
                        ...(outcome.scanId ? { scanId: outcome.scanId } : {}),
                        details: {
                            sourceRevision: outcome.sourceRevision,
                            contentHash: outcome.contentHash.startsWith("sha256:") ? outcome.contentHash : `sha256:${outcome.contentHash}`,
                            previousContentHash: outcome.previousContentHash || null,
                            reason: outcome.reason || "same revision produced different source bytes",
                        },
                    },
                    workspace: null,
                    titleBestEffort: null,
                    observedAt: outcome.observedAt,
                });
            }
            for (const [identityKey, identity] of identities) {
                const work = stored.ledger.recordWork.find(candidate => (
                    candidate.chain === identity.chain
                    && candidate.workspaceHash === identity.workspaceHash
                    && candidate.conversationId === identity.conversationId
                ));
                const pendingRefresh = stored.ledger.commits
                    .filter(commit => commit.recordWorkKey === work?.recordWorkKey && commit.pendingRefresh)
                    .map(commit => commit.pendingRefresh!)[0] || null;
                schedulerLedgers.push({
                    identity,
                    taskId,
                    active,
                    recordWorkKey: work?.recordWorkKey || null,
                    pendingRefreshKey: pendingRefresh?.refreshKey || null,
                    observedAt: stored.ledger.task.updatedAt,
                });
                if (!recordCoveredByIdentity.has(identityKey)) recordCoveredByIdentity.set(identityKey, null);
            }
        }

        const snapshotId = `record-conversation-state-repair:${crypto.randomUUID()}`;
        const authorityRef = path.join(this.control.dataRoot, `record-conversation-state-authority-${crypto.randomUUID()}.json`);
        const unsigned = {
            kind: "record-conversation-state-authority-snapshots" as const,
            snapshotId,
            capturedAt,
            rootBinding,
            authorityRevision: 1,
            authorityRef,
            authorityHash: "",
            recordIndex,
            schedulerLedgers,
            workRegistry,
            recentCompleteEvidence,
        };
        return {
            ...unsigned,
            authorityHash: calculateRecordConversationStateAuthorityHash(unsigned),
        };
    }

    private async writeConversationStateAuthority(authority: ConversationStateAuthoritySnapshots): Promise<void> {
        const finalPath = path.resolve(authority.authorityRef);
        if (path.dirname(finalPath) !== path.resolve(this.control.dataRoot)) {
            throw new RecordSchedulerRepairRequiredError("conversation-state repair authorityRef 逃逸 DATA_ROOT");
        }
        const temporaryPath = path.join(this.control.dataRoot, `.record-conversation-state-authority.${crypto.randomUUID()}.tmp`);
        const payload = `${JSON.stringify(authority, null, 2)}\n`;
        let handle: fs.promises.FileHandle | undefined;
        try {
            handle = await fs.promises.open(temporaryPath, "wx", 0o600);
            await handle.writeFile(payload, "utf8");
            await handle.sync();
        } finally {
            await handle?.close();
        }
        try {
            await fs.promises.rename(temporaryPath, finalPath);
            const target = await fs.promises.open(finalPath, "r+");
            try {
                await target.sync();
            } finally {
                await target.close();
            }
            if (process.platform !== "win32") {
                const directory = await fs.promises.open(this.control.dataRoot, "r");
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
            }
        } catch (error) {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    createSourceSnapshot(input: unknown): RecordSourceSnapshotResult {
        return createRecordSourceSnapshot(input) as RecordSourceSnapshotResult;
    }

    createUnitPlan(input: RecordUnitPlanningInput): RecordUnitPlan {
        return createRecordUnitPlan(input);
    }

    selectDiscoveryCandidates(snapshot: DiscoveryCandidateSnapshot, selector: RecordDiscoverySelector) {
        return selectRecordDiscoveryCandidates(snapshot, selector);
    }

    async driveTestCoordinator(
        ledgers: Iterable<RecordSchedulerLedger>,
        requestPermit: RecordSchedulerProviderPermitRequest,
    ) {
        if (this.mode !== "test") throw new Error("coordinator fake execution 仅允许 test runtime mode");
        await this.coordinator.rebuild(ledgers);
        return this.coordinator.step(requestPermit);
    }

    status(taskId: string): RecordSchedulerTaskStatus | null {
        const stored = readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: false });
        if (stored.kind === "missing") return null;
        return this.control.status(taskId);
    }

    async waitForTerminal(taskId: string, waitSeconds?: number): Promise<RecordSchedulerTaskStatus | null> {
        const deadline = waitSeconds === undefined
            ? Number.POSITIVE_INFINITY
            : Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
        while (true) {
            const status = this.status(taskId) || this.control.status(taskId);
            if (!status || isTerminalTaskState(authoritativeSchedulerTaskState(status)) || Date.now() >= deadline) return status;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    async cancel(taskId: string): Promise<CancelRecordSchedulerTaskResult | null> {
        if (!this.status(taskId)) return null;
        return this.control.cancel(taskId);
    }

    async recover(taskId: string): Promise<RecoverRecordSchedulerOwnerResult | null> {
        if (!this.status(taskId)) return null;
        await this.readSealedExecutionRecovery(taskId);
        return this.getOrRecoverExecutionOwner(taskId);
    }

    async resumeExecution(
        taskId: string,
        context: BackgroundTaskContext,
        execute: RecordSchedulerRuntimeResumeExecute,
        recoveryDescriptor?: RecordSchedulerRuntimeRecoveryDescriptorInput,
    ): Promise<RecordSchedulerRuntimeResumeResult | null> {
        const initialStatus = this.status(taskId);
        if (!initialStatus) return null;
        const initialTaskState = authoritativeSchedulerTaskState(initialStatus);
        if (isTerminalTaskState(initialTaskState)) {
            return { kind: "terminal", status: initialStatus };
        }
        if (initialTaskState === "CancelRequested" || initialTaskState === "Cancelling") {
            const cancellation = await this.control.cancel(taskId);
            if (cancellation.disposition === "repair_required") {
                return { kind: "repair_required", status: cancellation.status, reason: cancellation.reason };
            }
            return { kind: "cancelled", cancellation, status: cancellation.status };
        }
        let executionStarted = false;
        let ownerLease: RecoveredRecordSchedulerOwner["ownerLease"] | undefined;
        try {
            const ownerRecovery = await this.getOrRecoverExecutionOwner(taskId);
            if (ownerRecovery.kind !== "recovered") return ownerRecovery;
            ownerLease = ownerRecovery.ownerLease;

            const ownerStatus = this.status(taskId) || this.control.status(taskId);
            const ownerTaskState = authoritativeSchedulerTaskState(ownerStatus);
            if (isTerminalTaskState(ownerTaskState)) {
                return { kind: "terminal", status: ownerStatus };
            }
            if (ownerTaskState === "CancelRequested" || ownerTaskState === "Cancelling") {
                const cancellation = await this.control.cancel(taskId);
                if (cancellation.disposition === "repair_required") {
                    return {
                        kind: "repair_required",
                        status: cancellation.status,
                        reason: cancellation.reason,
                    };
                }
                return {
                    kind: "cancelled",
                    ownerLease,
                    cancellation,
                    status: cancellation.status,
                };
            }
            if (!recoveryDescriptor) {
                throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 缺少 matching admission descriptor`);
            }
            const prepared = await this.runWithExecutionOwnerHeartbeat(
                taskId,
                ownerLease,
                async () => {
                    const descriptor = await this.resolveRecoveryDescriptor(taskId, recoveryDescriptor);
                    return this.prepareExecutionRecovery(taskId, execute, descriptor, ownerLease!);
                },
                { heartbeatImmediately: true },
            );
            ownerLease = prepared.ownerLease;
            const recovery = prepared.value;

            const status = this.status(taskId) || this.control.status(taskId);
            const taskState = authoritativeSchedulerTaskState(status);
            if (isTerminalTaskState(taskState)) {
                return { kind: "terminal", status };
            }
            if (taskState === "CancelRequested" || taskState === "Cancelling") {
                const cancellation = await this.control.cancel(taskId);
                if (cancellation.disposition === "repair_required") {
                    return {
                        kind: "repair_required",
                        status: cancellation.status,
                        reason: cancellation.reason,
                    };
                }
                return {
                    kind: "cancelled",
                    ownerLease,
                    cancellation,
                    status: cancellation.status,
                };
            }
            const loop = await this.executeFrozenTask({
                taskId,
                context,
                discoverySnapshot: recovery.discovery.snapshot,
                sourceSnapshots: recovery.sourceSnapshots,
                ownerLease,
                validateLegacyState: recovery.validateLegacyState,
                execute: async (executionContext, discoverySnapshot, sourceSnapshots) => {
                    executionStarted = true;
                    return execute(executionContext, discoverySnapshot, sourceSnapshots);
                },
            });
            ownerLease = loop.ownerLease;
            const settledStatus = this.status(taskId) || this.control.status(taskId);
            if (loop.disposition === "repair_required") {
                return { kind: "repair_required", status: settledStatus, result: loop.result };
            }
            if (loop.disposition === "cancelled") {
                return {
                    kind: "cancelled",
                    ownerLease,
                    cancellation: await this.control.cancel(taskId),
                    status: this.status(taskId) || this.control.status(taskId),
                };
            }
            return {
                kind: loop.disposition === "executed" ? "resumed" : "settled",
                ownerLease,
                status: settledStatus,
                result: loop.result,
            };
        } catch (error) {
            if (isBackgroundTaskSuspension(error)) throw error;
            if (isSchedulerOwnerAuthorityError(error)) throw error;
            const repairRequired = !executionStarted || isSchedulerRepairRequiredError(error);
            await this.advanceTask(taskId, repairRequired ? "RepairRequired" : "FailedFinal", ownerLease);
            throw error;
        }
    }

    private async prepareExecutionRecovery(
        taskId: string,
        execute: RecordSchedulerRuntimeResumeExecute,
        descriptor: RecordSchedulerRuntimeRecoveryDescriptor,
        ownerLease: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<PreparedRuntimeRecovery> {
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 scheduler ledger 不可读取：${stored.kind}`);
        }
        const recoveryRequest = await this.bindRecoveryDescriptor(taskId, stored.ledger, descriptor, execute);
        if (stored.ledger.candidateSnapshot.snapshotId.endsWith(":pending")) {
            if (stored.ledger.task.state !== "Accepted" && stored.ledger.task.state !== "Preparing") {
                throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 在 ${stored.ledger.task.state} 保留 pending CandidateSnapshot，拒绝重新枚举`);
            }
            this.assertPendingRecoveryBinding(taskId, stored.ledger, recoveryRequest);
            const shouldRunDiscovery = await this.beginDiscovery(taskId, ownerLease);
            if (!shouldRunDiscovery) {
                throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 在 discovery 恢复边界已取消或结算`);
            }
            const discovery = await this.resolveDiscovery(recoveryRequest.discovery!);
            await this.freezeDiscoverySnapshot(taskId, recoveryRequest, discovery, ownerLease);
            await this.syncConversationStateFromDiscovery(discovery.snapshot, taskId);
            const sourceSnapshots = await this.materializeSelectedSources(
                taskId,
                recoveryRequest.discovery!.selector,
                discovery.snapshot,
                ownerLease,
            );
            await this.assertPendingRefreshReceipts(taskId);
            return {
                discovery,
                sourceSnapshots,
                validateLegacyState: recoveryRequest.validateLegacyState,
            };
        }
        await this.control.spool.initializeRoot({ mode: "open" });
        await this.control.spool.initializeTask({ taskId, mode: "open" });
        const discovery = await this.readFrozenDiscovery(taskId);
        const sourceSnapshots = stored.ledger.sourceMaterialization?.phase === "sealed"
            ? await this.readFrozenSources(taskId, { snapshot: discovery })
            : await (async () => {
                await this.syncConversationStateFromDiscovery(discovery.snapshot, taskId);
                    return this.materializeSelectedSources(
                        taskId,
                        stored.ledger.candidateSnapshot.requestMode,
                        discovery.snapshot,
                        ownerLease,
                        { recovery: true },
                    );
            })();
        await this.assertPendingRefreshReceipts(taskId);
        return {
            discovery,
            sourceSnapshots,
            validateLegacyState: recoveryRequest.validateLegacyState,
        };
    }

    private async resolveRecoveryDescriptor(
        taskId: string,
        input: RecordSchedulerRuntimeRecoveryDescriptorInput,
    ): Promise<RecordSchedulerRuntimeRecoveryDescriptor> {
        const descriptor: unknown = typeof input === "function" ? await input() : input;
        if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 descriptor factory 返回无效 descriptor`);
        }
        return descriptor as RecordSchedulerRuntimeRecoveryDescriptor;
    }

    private async readSealedExecutionRecovery(taskId: string): Promise<PreparedRuntimeRecovery> {
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`owner recovery ${taskId} 的 scheduler ledger 不可读取：${stored.kind}`);
        }
        if (stored.ledger.candidateSnapshot.snapshotId.endsWith(":pending")
            || stored.ledger.sourceMaterialization?.phase !== "sealed") {
            throw new RecordSchedulerRepairRequiredError(`owner recovery ${taskId} 尚未形成 sealed execution evidence`);
        }
        await this.control.spool.initializeRoot({ mode: "open" });
        await this.control.spool.initializeTask({ taskId, mode: "open" });
        const discovery = await this.readFrozenDiscovery(taskId);
        const sourceSnapshots = await this.readFrozenSources(taskId, { snapshot: discovery });
        await this.assertPendingRefreshReceipts(taskId);
        return { discovery, sourceSnapshots };
    }

    private async assertPendingRefreshReceipts(taskId: string): Promise<void> {
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 校验 pending refresh 时 ledger 不可读取：${stored.kind}`);
        }
        for (const commit of stored.ledger.commits) {
            const pendingRefresh = commit.pendingRefresh;
            if (!pendingRefresh) continue;
            const receiptPath = path.resolve(this.control.dataRoot, pendingRefresh.ledgerRef.path);
            if (!pathIsWithin(this.control.dataRoot, receiptPath)) {
                throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 refresh receipt 路径越界`);
            }
            const receipt = await fs.promises.readFile(receiptPath);
            if (receipt.byteLength !== pendingRefresh.ledgerRef.byteLength || rawSha256(receipt) !== pendingRefresh.ledgerRef.hash) {
                throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 refresh receipt 损坏`);
            }
        }
    }

    private async bindRecoveryDescriptor(
        taskId: string,
        ledger: RecordSchedulerLedger,
        descriptor: RecordSchedulerRuntimeRecoveryDescriptor,
        execute: RecordSchedulerRuntimeResumeExecute,
    ): Promise<RecordSchedulerRuntimeAdmitRequest> {
        const verified = await verifyOrRecoverTaskAdmission(taskId);
        if (verified.kind !== "verified") {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 admission capsule 不可验证：${verified.kind}`);
        }
        if (descriptor.resumePayload === undefined) {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 descriptor 缺少原 resumePayload`);
        }
        const requestSummary = stableObject(descriptor.requestSummary);
        const resumePayload = normalizeResumePayload(descriptor.resumePayload);
        const backgroundProjection = descriptor.backgroundProjection === undefined
            ? undefined
            : stableObject(descriptor.backgroundProjection);
        const admissionBackgroundProjection = {
            ...(backgroundProjection === undefined ? {} : { projection: backgroundProjection }),
            resumePayload,
            resumeVersion: BACKGROUND_TASK_RESUME_VERSION,
            resumeHash: stableJsonHash(resumePayload),
        };
        const requestHash = calculateRecordSchedulerAdmissionRequestHash(
            descriptor.kind,
            requestSummary,
            admissionBackgroundProjection,
        );
        const expectedTaskKind = ledger.task.requestMode === "update" ? "record-update" : "record-batch-update";
        const identityMismatch = descriptor.requestKey !== verified.capsule.admissionIdentity.requestKey
            || requestHash !== verified.capsule.admissionIdentity.requestHash
            || descriptor.requestKey !== ledger.task.admissionIdentity.requestKey
            || requestHash !== ledger.task.admissionIdentity.requestHash
            || descriptor.kind !== expectedTaskKind
            || descriptor.kind !== verified.capsule.taskKind
            || stableJsonHash(requestSummary) !== stableJsonHash(verified.capsule.requestSummary)
            || stableJsonHash(admissionBackgroundProjection) !== stableJsonHash(verified.capsule.backgroundProjection)
            || descriptor.requestMode !== ledger.candidateSnapshot.requestMode
            || descriptor.discovery.kind !== descriptor.kind
            || descriptor.discovery.selector !== descriptor.requestMode;
        if (identityMismatch) {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 descriptor 与 admission identity/ledger request 不一致`);
        }
        return {
            ...descriptor,
            requestSummary,
            resumePayload,
            ...(backgroundProjection === undefined ? {} : { backgroundProjection }),
            execute,
        };
    }

    private assertPendingRecoveryBinding(
        taskId: string,
        ledger: RecordSchedulerLedger,
        request: RecordSchedulerRuntimeAdmitRequest,
    ): void {
        const expected = pendingSchedulerSnapshot(taskId, request, ledger.candidateSnapshot.createdAt);
        const actual = ledger.candidateSnapshot;
        if (actual.snapshotId !== expected.snapshotId
            || actual.snapshotHash !== expected.snapshotHash
            || actual.snapshotRef.path !== expected.snapshotRef.path
            || actual.snapshotRef.hash !== expected.snapshotRef.hash
            || actual.snapshotRef.byteLength !== expected.snapshotRef.byteLength
            || actual.requestMode !== expected.requestMode
            || stableJsonHash(actual.filters) !== stableJsonHash(expected.filters)
            || stableJsonHash(actual.enumerations) !== stableJsonHash(expected.enumerations)
            || actual.candidates.length !== 0
            || ledger.task.candidateSnapshotId !== actual.snapshotId
            || ledger.task.candidateSnapshotRevision !== actual.snapshotRevision) {
            throw new RecordSchedulerRepairRequiredError(`execution recovery ${taskId} 的 pending CandidateSnapshot 与 descriptor binding 不一致`);
        }
    }

    async readFrozenDiscovery(taskId: string): Promise<FrozenRuntimeDiscovery> {
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 恢复时权威 ledger 不可读取：${stored.kind}`);
        }
        const candidateSnapshot = stored.ledger.candidateSnapshot;
        if (candidateSnapshot.snapshotId.endsWith(":pending")) {
            throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 尚未完成候选快照冻结，拒绝重新枚举`);
        }
        try {
            await this.control.spool.initializeRoot({ mode: "open" });
            await this.control.spool.initializeTask({ taskId, mode: "open" });
            const raw = await this.control.spool.readImmutable({
                taskId,
                kind: "source",
                reference: candidateSnapshot.snapshotRef,
            });
            const parsed = JSON.parse(raw.toString("utf8")) as { snapshot?: unknown; enumerations?: unknown };
            const snapshot = CandidateSnapshotSchema.parse(parsed.snapshot) as DiscoveryCandidateSnapshot;
            if (!Array.isArray(parsed.enumerations)) {
                throw new Error("candidate spool 缺少 enumerations");
            }
            if (candidateSnapshot.snapshotHash !== candidateSnapshot.snapshotRef.hash
                || candidateSnapshot.snapshotId !== snapshot.snapshotId) {
                throw new Error("candidate spool 与 scheduler ledger binding 不一致");
            }
            return {
                snapshot,
                enumerations: structuredClone(parsed.enumerations) as SchedulerCandidateSnapshot["enumerations"],
            };
        } catch (error) {
            throw new RecordSchedulerRepairRequiredError(
                `Record discovery ${taskId} 冻结 CandidateSnapshot 缺失或损坏：${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async readFrozenSourceSnapshot(taskId: string, snapshot: SchedulerRecordSourceSnapshot): Promise<FrozenRuntimeSource> {
        const capsuleBytes = await this.control.spool.readImmutable({
            taskId,
            kind: "source",
            reference: snapshot.snapshotRef,
        });
        const capsule = JSON.parse(capsuleBytes.toString("utf8")) as FrozenRuntimeSourceCapsule;
        if (capsule.kind !== "record-runtime-source-capsule"
            || capsule.discoverySnapshot?.sourceSnapshotId !== snapshot.sourceSnapshotId
            || capsule.discoverySnapshot?.snapshotHash.length === 0
            || capsule.discoverySnapshot.contentBinding.kind !== "spool"
            || capsule.discoverySnapshot.contentBinding.ref !== snapshot.contentRef.path
            || schedulerContentHash(capsule.discoverySnapshot.contentBinding.contentHash) !== snapshot.contentHash
            || capsule.discoverySnapshot.contentBinding.byteLength !== snapshot.contentRef.byteLength
            || capsule.request?.host !== snapshot.chain
            || capsule.request?.conversationId !== snapshot.conversationId
            || typeof capsule.scanId !== "string"
            || !capsule.scanId
            || !capsule.authority) {
            throw new Error(`source capsule ${snapshot.sourceSnapshotId} 与 scheduler ledger binding 不一致`);
        }
        const content = await this.control.spool.readImmutable({
            taskId,
            kind: "source",
            reference: snapshot.contentRef,
        });
        return {
            snapshot: structuredClone(snapshot),
            discoverySnapshot: structuredClone(capsule.discoverySnapshot),
            request: structuredClone(capsule.request),
            document: parseFrozenSourceDocument(content, snapshot),
            scanId: capsule.scanId,
            authority: structuredClone(capsule.authority),
        };
    }

    private async assertDurableMaterializationMarker(taskId: string, ledger: RecordSchedulerLedger): Promise<void> {
        const materialization = ledger.sourceMaterialization;
        if (!materialization || materialization.phase !== "sealed" || !materialization.markerRef) {
            throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} materialization 尚未 sealed`);
        }
        try {
            const bytes = await this.control.spool.readImmutable({ taskId, kind: "source", reference: materialization.markerRef });
            const marker = JSON.parse(bytes.toString("utf8")) as RuntimeSourceMaterializationMarker;
            const expected = sourceMaterializationMarker(ledger);
            if (stableJsonHash(marker) !== stableJsonHash(expected)) {
                throw new Error("materialization marker 与 scheduler ledger binding 不一致");
            }
        } catch (error) {
            throw new RecordSchedulerRepairRequiredError(
                `Record source ${taskId} materialization marker 缺失或损坏：${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async readFrozenSources(
        taskId: string,
        input?: { snapshot: FrozenRuntimeDiscovery },
    ): Promise<FrozenRuntimeSourceSet> {
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} 恢复时权威 ledger 不可读取：${stored.kind}`);
        }
        try {
            await this.control.spool.initializeRoot({ mode: "open" });
            await this.control.spool.initializeTask({ taskId, mode: "open" });
            await this.assertDurableMaterializationMarker(taskId, stored.ledger);
            const materialization = stored.ledger.sourceMaterialization!;
            const discovery = input?.snapshot || await this.readFrozenDiscovery(taskId);
            const selected = selectedMaterializationCandidates(
                discovery.snapshot,
                stored.ledger.candidateSnapshot.requestMode,
                stored.ledger.candidateSnapshot,
            )
                .map(candidate => sourceMaterializationSelection(candidate, stored.ledger.candidateSnapshot.requestMode))
                .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
            if (sourceMaterializationSelectionHash(selected) !== materialization.selectionHash
                || stableJsonHash(selected) !== stableJsonHash(materialization.selected)) {
                throw new Error("source materialization selection 与冻结 CandidateSnapshot 不一致");
            }
            const snapshots = new Map(stored.ledger.sourceSnapshots.map(snapshot => [snapshot.sourceSnapshotId, snapshot]));
            const referencedSnapshotIds = new Set<string>();
            const sources: FrozenRuntimeSource[] = [];
            const discoveryIssues = stored.ledger.task.sourceResolution
                ? stored.ledger.task.sourceResolution.issues.map(frozenSourceIssue)
                : blockingDiscoverySourceIssues(
                    discovery.snapshot,
                    stored.ledger.candidateSnapshot.requestMode,
                );
            const unresolved: FrozenRuntimeSourceIssue[] = [...discoveryIssues];
            for (const outcome of materialization.outcomes) {
                const selection = materialization.selected.find(item => item.sourceKey === outcome.sourceKey);
                if (!selection) throw new Error(`source materialization outcome ${outcome.sourceKey} 没有 selected binding`);
                if (outcome.kind === "unresolved") {
                    unresolved.push({
                        kind: "unresolved",
                        conversationId: selection.conversationId,
                        chain: selection.chain,
                        workspaceHash: selection.workspaceHash,
                        code: "source-materialization-unresolved",
                        reason: outcome.reason || "source materialization unresolved",
                        evidenceHashes: [outcome.evidenceHash || selection.evidenceHash],
                    });
                    continue;
                }
                if (!outcome.sourceSnapshotId) {
                    unresolved.push({
                        kind: "conflict",
                        conversationId: selection.conversationId,
                        chain: selection.chain,
                        workspaceHash: selection.workspaceHash,
                        code: "source-materialization-conflict",
                        reason: outcome.reason || "source materialization conflict",
                        evidenceHashes: [outcome.evidenceHash || selection.evidenceHash],
                    });
                    continue;
                }
                const snapshot = snapshots.get(outcome.sourceSnapshotId);
                if (!snapshot) throw new Error(`source materialization 缺少 snapshot ${outcome.sourceSnapshotId}`);
                referencedSnapshotIds.add(snapshot.sourceSnapshotId);
                const frozen = await this.readFrozenSourceSnapshot(taskId, snapshot);
                if (outcome.kind === "conflict") {
                    unresolved.push({
                        kind: "conflict",
                        conversationId: selection.conversationId,
                        chain: selection.chain,
                        workspaceHash: selection.workspaceHash,
                        code: "source-materialization-conflict",
                        reason: outcome.reason || "same revision produced different source bytes",
                        evidenceHashes: [outcome.evidenceHash || snapshot.snapshotHash],
                    });
                } else {
                    sources.push(frozen);
                }
            }
            if (referencedSnapshotIds.size !== stored.ledger.sourceSnapshots.length) {
                throw new Error("scheduler ledger 存在未被 materialization outcome 引用的 source snapshot");
            }
            await this.ensureConversationStateStore(discovery.snapshot);
            const stateRead = await readRecordConversationStateStore({ dataRoot: this.control.dataRoot });
            if (stateRead.kind !== "current") throw new Error(`conversation-state ${stateRead.kind}`);
            const executable: FrozenRuntimeSource[] = [];
            for (const source of sources) {
                const state = stateRead.index.entries[canonicalConversationStateKey(conversationStateIdentity(source.snapshot))];
                if (state?.state === "Conflict" || state?.state === "Lost" || state?.state === "Unresolved") {
                    unresolved.push({
                        kind: state.state === "Conflict" ? "conflict" : "unresolved",
                        conversationId: source.snapshot.conversationId,
                        chain: source.snapshot.chain,
                        workspaceHash: source.snapshot.workspaceHash,
                        code: `conversation-state-${state.state.toLowerCase()}`,
                        reason: `conversation-state-${state.state.toLowerCase()}`,
                        evidenceHashes: [source.snapshot.snapshotHash],
                    });
                } else {
                    executable.push(source);
                }
            }
            const unresolvedIssues = dedupeSourceIssues(unresolved);
            const selectedCount = stored.ledger.task.sourceResolution?.selectedCount;
            return {
                sources: executable,
                unresolved: unresolvedIssues,
                selectedCount: selectedCount === undefined
                    ? materialization.selected.length + discoveryIssues.filter(issue => issue.conversationId !== undefined).length
                    : selectedCount,
                materializedCount: executable.length,
                selectionHash: materialization.selectionHash,
                phase: "sealed",
            };
        } catch (error) {
            if (error instanceof RecordSchedulerRepairRequiredError) throw error;
            throw new RecordSchedulerRepairRequiredError(
                `Record source ${taskId} 冻结 spool 缺失或损坏：${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async persistFullSourceReadState(input: {
        taskId: string;
        identity: ConversationStateIdentity;
        snapshot: SchedulerRecordSourceSnapshot;
        scanId: string;
        evidenceHash: string;
        observedAt: string;
        contentHash: string;
        title: string | null;
        authority: ProductionSourceAuthorityVerification;
    }): Promise<ConversationStateEntry> {
        await this.ensureConversationStateStore();
        return this.upsertConversationStateWithRetry(input.identity, existing => {
            const existingHashes = contentHashesForRevision(existing, input.snapshot.desiredRevision);
            const sameRevisionDifferentBytes = existingHashes.some(hashValue => hashValue !== input.contentHash)
                || Boolean(input.authority.contradiction);
            const activeTaskIds = new Set(existing?.activeTaskIds || []);
            activeTaskIds.add(input.taskId);
            const evidence: ConversationStateEvidence = {
                source: "record-source-full-read",
                complete: true,
                observedAt: input.observedAt,
                evidenceHash: input.evidenceHash,
                scanId: input.scanId,
                details: {
                    sourceRevision: input.snapshot.desiredRevision,
                    contentHash: input.contentHash,
                    sourceSnapshotId: input.snapshot.sourceSnapshotId,
                    authority: structuredClone(input.authority),
                },
            };
            const evidenceHistory = this.mergeConversationEvidence(existing?.evidence || [], evidence);
            if (sameRevisionDifferentBytes) {
                return {
                    workspace: existing?.workspace || null,
                    titleBestEffort: input.title || existing?.titleBestEffort || null,
                    latestObservedRevision: input.snapshot.desiredRevision,
                    latestEvidenceHash: input.evidenceHash,
                    lastCompleteScanId: input.scanId,
                    recordCoveredRevision: existing?.recordCoveredRevision || null,
                    recordBodyHash: existing?.recordBodyHash || null,
                    state: "Conflict",
                    evidence: evidenceHistory,
                    stateReason: "same-revision-different-source-bytes",
                    activeTaskIds: [...activeTaskIds],
                    recordWorkKey: existing?.recordWorkKey || null,
                    pendingRefreshKey: null,
                    sourceObservedAt: input.observedAt,
                };
            }
            const recordCoveredRevision = existing?.recordCoveredRevision || null;
            const state: ConversationState = recordCoveredRevision === input.snapshot.desiredRevision
                ? "Fresh"
                : recordCoveredRevision
                    ? "Stale"
                    : "Missing";
            return {
                workspace: existing?.workspace || null,
                titleBestEffort: input.title || existing?.titleBestEffort || null,
                latestObservedRevision: input.snapshot.desiredRevision,
                latestEvidenceHash: input.evidenceHash,
                lastCompleteScanId: input.scanId,
                recordCoveredRevision,
                recordBodyHash: existing?.recordBodyHash || null,
                state,
                evidence: evidenceHistory,
                stateReason: sameRevisionDifferentBytes ? "same-revision-different-source-bytes" : "full-source-read-persisted",
                activeTaskIds: [...activeTaskIds],
                recordWorkKey: existing?.recordWorkKey || null,
                pendingRefreshKey: candidatePendingRefreshKey(state, input.identity, input.snapshot.desiredRevision),
                sourceObservedAt: input.observedAt,
            };
        });
    }

    private async persistUnresolvedSourceState(input: {
        taskId: string;
        candidate: DiscoveryImmutable<DiscoveryCandidateSnapshot["candidates"][number]>;
        reason: string;
        scan?: Awaited<ReturnType<ProductionSourceReader["scan"]>>;
    }): Promise<ConversationStateEntry> {
        await this.ensureConversationStateStore();
        const identity = conversationStateIdentity({
            chain: input.candidate.source.host,
            workspaceHash: input.candidate.source.identity.workspace.workspaceId,
            conversationId: input.candidate.source.identity.conversationId,
        });
        const sourceRevision = input.scan?.enumeration.sourceRevision.revision
            || input.candidate.sourceRevision?.revision
            || null;
        const observedAt = input.scan?.enumeration.observedAt.completedAt || this.now().toISOString();
        const evidenceHash = input.scan?.fullSourceRead.evidence?.evidenceHash
            || input.scan?.enumeration.evidenceHash
            || input.candidate.evidenceHash;
        const evidence: ConversationStateEvidence = {
            source: "record-source-full-read-unresolved",
            complete: false,
            observedAt,
            evidenceHash,
            ...(input.scan?.scanId ? { scanId: input.scan.scanId } : {}),
            details: {
                candidateState: input.candidate.classification,
                sourceRevision,
                reason: input.reason,
            },
        };
        return this.upsertConversationStateWithRetry(identity, existing => {
            const activeTaskIds = new Set(existing?.activeTaskIds || []);
            activeTaskIds.add(input.taskId);
            const conflict = existing?.state === "Conflict";
            return {
                workspace: input.candidate.source.identity.workspace.canonicalPath,
                titleBestEffort: existing?.titleBestEffort || null,
                latestObservedRevision: sourceRevision || existing?.latestObservedRevision || null,
                latestEvidenceHash: evidenceHash,
                lastCompleteScanId: existing?.lastCompleteScanId || null,
                recordCoveredRevision: existing?.recordCoveredRevision || null,
                recordBodyHash: existing?.recordBodyHash || null,
                state: conflict ? "Conflict" : "Unresolved",
                evidence: this.mergeConversationEvidence(existing?.evidence || [], evidence),
                stateReason: conflict ? existing?.stateReason || "conversation-state-conflict" : input.reason,
                activeTaskIds: [...activeTaskIds],
                recordWorkKey: existing?.recordWorkKey || null,
                pendingRefreshKey: null,
                sourceObservedAt: observedAt,
            };
        });
    }

    private async mutateSchedulerLedgerForExecution(
        taskId: string,
        expectedRevision: number,
        ownerLease: RecordSchedulerRuntimeExecutionOwnerLease | undefined,
        mutate: (ledger: RecordSchedulerLedger) => void | Promise<void>,
    ): Promise<void> {
        if (ownerLease) {
            await mutateRecordSchedulerLedgerAsOwner(taskId, expectedRevision, ownerLease, mutate, { nowMs: this.now().getTime() });
            return;
        }
        await mutateRecordSchedulerLedger(taskId, expectedRevision, mutate);
    }

    private async ensureSourceMaterializationIntent(
        taskId: string,
        discovery: DiscoveryCandidateSnapshot,
        selector: RecordDiscoverySelector,
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<SourceMaterializationLedger> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} intent 前 ledger 不可判定：${current.kind}`);
            }
            if (current.ledger.candidateSnapshot.snapshotId !== discovery.snapshotId) {
                throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} materialization intent 与冻结候选 ID 不一致`);
            }
            const selected = selectedMaterializationCandidates(
                discovery,
                selector,
                current.ledger.candidateSnapshot,
            ).map(candidate => sourceMaterializationSelection(candidate, selector)).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
            const intended: SourceMaterializationLedger = {
                schemaVersion: 1,
                phase: "intent",
                candidateSnapshotId: current.ledger.candidateSnapshot.snapshotId,
                candidateSnapshotHash: current.ledger.candidateSnapshot.snapshotHash,
                selectionHash: sourceMaterializationSelectionHash(selected),
                selected,
                outcomes: [],
            };
            if (current.ledger.sourceMaterialization) {
                const existing = current.ledger.sourceMaterialization;
                if (existing.candidateSnapshotId !== intended.candidateSnapshotId
                    || existing.candidateSnapshotHash !== intended.candidateSnapshotHash
                    || existing.selectionHash !== intended.selectionHash
                    || stableJsonHash(existing.selected) !== stableJsonHash(intended.selected)) {
                    throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} materialization intent 与冻结候选不一致`);
                }
                return structuredClone(existing);
            }
            try {
                await this.mutateSchedulerLedgerForExecution(taskId, current.ledger.revision, ownerLease, ledger => {
                    ledger.sourceMaterialization = structuredClone(intended);
                    ledger.task.updatedAt = this.now().toISOString();
                });
                return intended;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} 无法在五次 CAS 内持久化 materialization intent`);
    }

    private async persistSourceMaterializationOutcome(input: {
        taskId: string;
        outcome: SourceMaterializationOutcome;
        snapshot?: SchedulerRecordSourceSnapshot;
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease;
    }): Promise<void> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(input.taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`Record source ${input.taskId} outcome 前 ledger 不可判定：${current.kind}`);
            }
            const materialization = current.ledger.sourceMaterialization;
            if (!materialization) throw new RecordSchedulerRepairRequiredError(`Record source ${input.taskId} 缺少 materialization intent`);
            const existing = materialization.outcomes.find(candidate => candidate.sourceKey === input.outcome.sourceKey);
            if (existing) {
                if (stableJsonHash(existing) !== stableJsonHash(input.outcome)) {
                    throw new RecordSchedulerRepairRequiredError(`Record source ${input.taskId} outcome ${input.outcome.sourceKey} 已被不同结果占用`);
                }
                return;
            }
            if (materialization.phase !== "intent") {
                throw new RecordSchedulerRepairRequiredError(`Record source ${input.taskId} sealed 后拒绝新增 outcome`);
            }
            if (!materialization.selected.some(candidate => candidate.sourceKey === input.outcome.sourceKey)) {
                throw new RecordSchedulerRepairRequiredError(`Record source ${input.taskId} outcome 不属于 selected set`);
            }
            try {
                await this.mutateSchedulerLedgerForExecution(input.taskId, current.ledger.revision, input.ownerLease, ledger => {
                    const target = ledger.sourceMaterialization;
                    if (!target || target.phase !== "intent") throw new RecordSchedulerRepairRequiredError("source materialization CAS target 无效");
                    if (input.snapshot) {
                        const duplicate = ledger.sourceSnapshots.find(snapshot => snapshot.sourceSnapshotId === input.snapshot!.sourceSnapshotId);
                        if (duplicate && stableJsonHash(duplicate) !== stableJsonHash(input.snapshot)) {
                            throw new RecordSchedulerRepairRequiredError(`source snapshot ${input.snapshot.sourceSnapshotId} collision`);
                        }
                        if (!duplicate) ledger.sourceSnapshots.push(structuredClone(input.snapshot));
                        ledger.sourceSnapshots.sort((left, right) => left.sourceSnapshotId.localeCompare(right.sourceSnapshotId));
                    }
                    target.outcomes.push(structuredClone(input.outcome));
                    target.outcomes.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
                    ledger.task.recordItems.unresolved = candidateIssueCountForMaterialization(ledger)
                        + target.outcomes.filter(outcome => outcome.kind !== "accepted").length;
                    ledger.task.updatedAt = this.now().toISOString();
                });
                return;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record source ${input.taskId} 无法在五次 CAS 内持久化 materialization outcome`);
    }

    private async sealSourceMaterialization(
        taskId: string,
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<FrozenRuntimeSourceSet> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} seal 前 ledger 不可判定：${current.kind}`);
            }
            const materialization = current.ledger.sourceMaterialization;
            if (!materialization) throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} 缺少 materialization intent`);
            if (materialization.phase === "sealed") {
                const frozen = await this.readFrozenSources(taskId);
                await this.persistMaterializedSourceResolution(taskId, frozen, ownerLease);
                return frozen;
            }
            if (materialization.outcomes.length !== materialization.selected.length
                || materialization.selected.some(selection => !materialization.outcomes.some(outcome => outcome.sourceKey === selection.sourceKey))) {
                throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} outcomes 尚未完整覆盖 selected set`);
            }
            const markerWrite = await this.control.spool.writeImmutable({
                taskId,
                kind: "source",
                content: sourceMaterializationMarkerBytes(current.ledger),
            });
            try {
                await this.mutateSchedulerLedgerForExecution(taskId, current.ledger.revision, ownerLease, ledger => {
                    const target = ledger.sourceMaterialization;
                    if (!target || target.phase !== "intent") throw new RecordSchedulerRepairRequiredError("source materialization seal CAS target 无效");
                    target.phase = "sealed";
                    target.markerRef = structuredClone(markerWrite.reference);
                    ledger.task.recordItems.unresolved = candidateIssueCountForMaterialization(ledger)
                        + target.outcomes.filter(outcome => outcome.kind !== "accepted").length;
                    ledger.task.updatedAt = this.now().toISOString();
                });
                const frozen = await this.readFrozenSources(taskId);
                await this.persistMaterializedSourceResolution(taskId, frozen, ownerLease);
                return frozen;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} 无法在五次 CAS 内 seal materialization`);
    }

    private async persistMaterializedSourceResolution(
        taskId: string,
        sources: FrozenRuntimeSourceSet,
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<void> {
        const issues = sources.unresolved.map(schedulerSourceIssue);
        const resolution: SchedulerSourceResolution = {
            phase: "materialized",
            selectedCount: sources.selectedCount,
            materializedCount: sources.materializedCount,
            unresolvedCount: issues.length,
            issues,
        };
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} materialized projection 前 ledger 不可判定：${current.kind}`);
            }
            if (isTerminalTaskState(current.ledger.task.state)) return;
            const candidateUnresolved = sources.unresolved.filter(issue => issue.conversationId !== undefined).length;
            if (stableJsonHash(current.ledger.task.sourceResolution || null) === stableJsonHash(resolution)
                && current.ledger.task.recordItems.unresolved === candidateUnresolved) return;
            try {
                await this.mutateSchedulerLedgerForExecution(taskId, current.ledger.revision, ownerLease, ledger => {
                    ledger.task.sourceResolution = structuredClone(resolution);
                    ledger.task.recordItems.unresolved = candidateUnresolved;
                    ledger.task.updatedAt = this.now().toISOString();
                });
                return;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} 无法在五次 CAS 内持久化 materialized projection`);
    }

    private async withRefreshLock<Value>(refreshKey: string, work: () => Promise<Value>): Promise<Value> {
        const previous = this.refreshLocks.get(refreshKey) || Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        const queued = previous.then(() => current);
        this.refreshLocks.set(refreshKey, queued);
        await previous;
        try {
            return await work();
        } finally {
            release();
            if (this.refreshLocks.get(refreshKey) === queued) this.refreshLocks.delete(refreshKey);
        }
    }

    private async refreshRootBinding(): Promise<RecordSourceRefreshRootBinding> {
        const dataRoot = path.resolve(this.control.dataRoot);
        const realDataRoot = await fs.promises.realpath(dataRoot);
        return {
            dataRootId: rawSha256(realDataRoot),
            rootPathHash: `sha256:${rawSha256(dataRoot)}`,
        };
    }

    private refreshStorageDirectory(): string {
        return path.join(this.control.dataRoot, "record-recovery", "record-source-refresh");
    }

    private refreshIndexPath(refreshKey: string, attachmentKey: string): string {
        if (!/^[0-9a-f]{64}$/u.test(attachmentKey)) {
            throw new RecordSchedulerRepairRequiredError("refresh durable key 格式无效");
        }
        return path.join(this.refreshStorageDirectory(), durableRefreshStorageKey(refreshKey), `${attachmentKey}.json`);
    }

    private refreshReceiptPath(refreshKey: string, attachmentKey: string): string {
        return path.join(this.refreshStorageDirectory(), durableRefreshStorageKey(refreshKey), "receipts", `${attachmentKey}.json`);
    }

    private parseDurableRefreshIndex(
        value: unknown,
        refreshKey: string,
        rootBinding: RecordSourceRefreshRootBinding,
    ): DurableRefreshIndex {
        const parsed = value as DurableRefreshIndex;
        if (!parsed || typeof parsed !== "object"
            || parsed.schemaVersion !== 1
            || parsed.kind !== "record-source-refresh-index"
            || parsed.refreshKey !== refreshKey
            || !sameRefreshRootBinding(parsed.rootBinding, rootBinding)
            || !Array.isArray(parsed.attachments)
            || parsed.attachments.length !== 1
            || parsed.persistedHash !== durableRefreshIndexHash(parsed)) {
            throw new RecordSchedulerRepairRequiredError(`refresh index ${refreshKey} 绑定或 hash 无效`);
        }
        return parsed;
    }

    private async readDurableRefreshIndex(
        request: {
            refreshKey: string;
            sourceSnapshotId: string;
            recordWorkKey: string;
            fromRevision: string;
            desiredRevision: string;
        },
        rootBinding: RecordSourceRefreshRootBinding,
    ): Promise<DurableRefreshIndex | null> {
        const attachmentKey = durableRefreshAttachmentKey({
            sourceSnapshotId: request.sourceSnapshotId,
            recordWorkKey: request.recordWorkKey,
            fromRevision: request.fromRevision,
            desiredRevision: request.desiredRevision,
        });
        const indexPath = this.refreshIndexPath(request.refreshKey, attachmentKey);
        let raw: string;
        try {
            raw = await fs.promises.readFile(indexPath, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
        }
        try {
            return this.parseDurableRefreshIndex(JSON.parse(raw), request.refreshKey, rootBinding);
        } catch (error) {
            if (error instanceof RecordSchedulerRepairRequiredError) throw error;
            throw new RecordSchedulerRepairRequiredError(`refresh index ${request.refreshKey} 无法解析：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async publishDurableRefreshJsonOnce<Value>(
        filePath: string,
        candidate: Value,
        parse: (value: unknown) => Value,
    ): Promise<{
        value: Value;
        reference: ImmutableBlobReference;
        durability: RecordSourceRefreshDurabilityReceipt["durability"];
        created: boolean;
    }> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const candidateContent = Buffer.from(JSON.stringify(candidate), "utf8");
        const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let created = false;
        try {
            let exists = true;
            try {
                await fs.promises.lstat(filePath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                exists = false;
            }
            if (!exists) {
                const handle = await fs.promises.open(temporaryPath, "wx");
                try {
                    await handle.writeFile(candidateContent);
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                try {
                    await fs.promises.link(temporaryPath, filePath);
                    created = true;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                }
            }
            const stat = await fs.promises.lstat(filePath);
            if (stat.isSymbolicLink() || !stat.isFile()) {
                throw new RecordSchedulerRepairRequiredError(`refresh durable file 不是安全普通文件：${filePath}`);
            }
            if (created) {
                const target = await fs.promises.open(filePath, "r+");
                try {
                    await target.sync();
                } finally {
                    await target.close();
                }
                if (process.platform !== "win32") {
                    const directory = await fs.promises.open(path.dirname(filePath), "r");
                    try {
                        await directory.sync();
                    } finally {
                        await directory.close();
                    }
                }
            }
            const readBack = await fs.promises.readFile(filePath);
            let parsed: Value;
            try {
                parsed = parse(JSON.parse(readBack.toString("utf8")));
            } catch (error) {
                if (error instanceof RecordSchedulerRepairRequiredError) throw error;
                throw new RecordSchedulerRepairRequiredError(`refresh durable file ${filePath} 无法解析：${error instanceof Error ? error.message : String(error)}`);
            }
            return {
                value: parsed,
                reference: {
                    path: relativeDataRootPath(this.control.dataRoot, filePath),
                    hash: rawSha256(readBack),
                    byteLength: readBack.byteLength,
                },
                durability: {
                    scope: "process-crash-hot-restart",
                    temporaryFileSynced: true,
                    atomicReplaceCompleted: true,
                    targetFileSynced: true,
                    parentDirectory: {
                        method: process.platform === "win32" ? "windows-target-file-flush" : "directory-fsync",
                        durableBarrierCompleted: true,
                    },
                },
                created,
            };
        } finally {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        }
    }

    private async writeDurableRefreshIndex(
        index: Omit<DurableRefreshIndex, "persistedHash">,
        attachmentKey: string,
    ): Promise<{ index: DurableRefreshIndex; created: boolean }> {
        const persisted: DurableRefreshIndex = { ...index, persistedHash: "" };
        persisted.persistedHash = durableRefreshIndexHash(persisted);
        const published = await this.publishDurableRefreshJsonOnce(
            this.refreshIndexPath(persisted.refreshKey, attachmentKey),
            persisted,
            value => this.parseDurableRefreshIndex(value, persisted.refreshKey, persisted.rootBinding),
        );
        return { index: published.value, created: published.created };
    }

    private async writeRefreshReceipt(input: {
        refreshKey: string;
        identity: ConversationStateIdentity;
        sourceSnapshotId: string;
        recordWorkKey: string;
        fromRevision: string;
        desiredRevision: string;
        refreshTaskId: string;
    }): Promise<{
        payload: DurableRefreshReceiptPayload;
        reference: ImmutableBlobReference;
        durability: RecordSourceRefreshDurabilityReceipt["durability"];
    }> {
        const attachmentKey = durableRefreshAttachmentKey(input);
        const payload: DurableRefreshReceiptPayload = {
            schemaVersion: 1 as const,
            kind: "record-source-refresh-receipt" as const,
            ...input,
            persistedAt: this.now().toISOString(),
        };
        const published = await this.publishDurableRefreshJsonOnce(
            this.refreshReceiptPath(input.refreshKey, attachmentKey),
            payload,
            value => {
                const parsed = value as DurableRefreshReceiptPayload;
                if (!parsed || typeof parsed !== "object"
                    || parsed.schemaVersion !== 1
                    || parsed.kind !== "record-source-refresh-receipt"
                    || parsed.refreshKey !== input.refreshKey
                    || stableJsonHash(parsed.identity) !== stableJsonHash(input.identity)
                    || parsed.sourceSnapshotId !== input.sourceSnapshotId
                    || parsed.recordWorkKey !== input.recordWorkKey
                    || parsed.fromRevision !== input.fromRevision
                    || parsed.desiredRevision !== input.desiredRevision
                    || parsed.refreshTaskId !== input.refreshTaskId
                    || !Number.isFinite(Date.parse(parsed.persistedAt))) {
                    throw new RecordSchedulerRepairRequiredError(`refresh receipt ${input.refreshKey}/${attachmentKey} 绑定无效`);
                }
                return parsed;
            },
        );
        return { payload: published.value, reference: published.reference, durability: published.durability };
    }

    private async bindPendingRefreshToSchedulerLedger(
        barrier: RecordSourceRefreshSchedulerLedgerCasBarrier,
        pendingRefresh: PendingRefreshReference,
    ): Promise<void> {
        const current = await readRecordSchedulerLedgerStore(barrier.ledgerId, { expectPublished: true });
        if (current.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`refresh scheduler ledger ${barrier.ledgerId} 不可读取：${current.kind}`);
        }
        const committed = current.ledger.commits.find(commit => commit.commitId === barrier.commitId);
        if (committed?.pendingRefresh && samePendingRefresh(committed.pendingRefresh, pendingRefresh)) return;
        const ownerLease = current.ledger.schedulerOwner;
        if (ownerLease && (
            ownerLease.ownerId !== this.ownerId
            || Date.parse(ownerLease.expiresAt) <= this.now().getTime()
            || current.ledger.schedulerOwnerRecovery !== undefined
        )) {
            throw new RecordSchedulerRuntimeOwnerUnavailableError(
                `refresh scheduler ledger ${barrier.ledgerId} 缺少当前 scheduler owner authority`,
            );
        }
        const mutate = (ledger: RecordSchedulerLedger) => {
            const commit = ledger.commits.find(candidate => candidate.commitId === barrier.commitId);
            if (!commit
                || commit.sourceSnapshotId !== pendingRefresh.sourceSnapshotId
                || commit.recordWorkKey !== pendingRefresh.recordWorkKey) {
                throw new RecordSchedulerRepairRequiredError(`refresh commit ${barrier.commitId} 与 source/work binding 不一致`);
            }
            commit.observedSourceRevisionAtCommit = pendingRefresh.desiredRevision;
            commit.coveredRevision ||= pendingRefresh.fromRevision;
            commit.pendingRefresh = structuredClone(pendingRefresh);
        };
        const stored = ownerLease
            ? await mutateRecordSchedulerLedgerAsOwner(
                barrier.ledgerId,
                barrier.expectedRevision,
                ownerLease,
                mutate,
                { nowMs: this.now().getTime() },
            )
            : await mutateRecordSchedulerLedger(barrier.ledgerId, barrier.expectedRevision, mutate);
        if (stored.revision !== barrier.expectedRevision + 1) {
            throw new RecordSchedulerRepairRequiredError(`refresh scheduler ledger ${barrier.ledgerId} CAS revision 不连续`);
        }
    }

    private async ensureProductionPendingRefresh(request: RecordSourceRefreshEnsureRequest): Promise<RecordSourceRefreshEnsureResult> {
        return this.withRefreshLock(request.refreshKey, async () => {
            const binding = {
                refreshKey: request.refreshKey,
                sourceSnapshotId: request.sourceSnapshot.sourceSnapshotId,
                recordWorkKey: request.recordWorkKey,
                fromRevision: request.fromRevision,
                desiredRevision: request.desiredRevision,
            };
            const attachmentKey = durableRefreshAttachmentKey(binding);
            const existing = await this.readDurableRefreshIndex(binding, request.persistenceRoot);
            const refreshTaskId = durableRefreshTaskId(request.refreshKey);
            const existingAttachment = existing?.attachments.find(attachment => (
                attachment.pendingRefresh.sourceSnapshotId === request.sourceSnapshot.sourceSnapshotId
                && attachment.pendingRefresh.recordWorkKey === request.recordWorkKey
                && attachment.pendingRefresh.fromRevision === request.fromRevision
                && attachment.pendingRefresh.desiredRevision === request.desiredRevision
            ));
            if (existingAttachment) {
                if (request.schedulerLedgerCas) {
                    await this.bindPendingRefreshToSchedulerLedger(request.schedulerLedgerCas, existingAttachment.pendingRefresh);
                }
                return {
                    disposition: "attached",
                    pendingRefresh: structuredClone(existingAttachment.pendingRefresh),
                    durabilityReceipt: structuredClone(existingAttachment.durabilityReceipt),
                };
            }

            const receipt = await this.writeRefreshReceipt({
                refreshKey: request.refreshKey,
                identity: request.identity,
                sourceSnapshotId: request.sourceSnapshot.sourceSnapshotId,
                recordWorkKey: request.recordWorkKey,
                fromRevision: request.fromRevision,
                desiredRevision: request.desiredRevision,
                refreshTaskId,
            });
            const ledgerRevision = request.schedulerLedgerCas
                ? request.schedulerLedgerCas.expectedRevision + 1
                : 1;
            const pendingRefresh: PendingRefreshReference = {
                refreshKey: request.refreshKey,
                refreshTaskId,
                sourceSnapshotId: request.sourceSnapshot.sourceSnapshotId,
                recordWorkKey: request.recordWorkKey,
                chain: request.identity.chain,
                workspaceHash: request.identity.workspaceHash,
                conversationId: request.identity.conversationId,
                fromRevision: request.fromRevision,
                desiredRevision: request.desiredRevision,
                persistedAt: receipt.payload.persistedAt,
                ledgerRevision,
                ledgerRef: receipt.reference,
                state: "Queued",
            };
            const durabilityReceipt: RecordSourceRefreshDurabilityReceipt = {
                version: 1,
                refreshKey: request.refreshKey,
                rootBinding: structuredClone(request.persistenceRoot),
                ledger: {
                    revision: ledgerRevision,
                    ref: structuredClone(receipt.reference),
                    persistedHash: receipt.reference.hash,
                },
                refreshRecordHash: createPendingRefreshRecordHash(pendingRefresh),
                durability: receipt.durability,
                cas: request.schedulerLedgerCas
                    ? {
                        scope: "scheduler-ledger",
                        ledgerId: request.schedulerLedgerCas.ledgerId,
                        expectedRevision: request.schedulerLedgerCas.expectedRevision,
                        committedRevision: ledgerRevision,
                        transactionId: `record-source-refresh:${request.refreshKey}:${request.schedulerLedgerCas.commitId}`,
                        commitId: request.schedulerLedgerCas.commitId,
                        commitSourceFieldsIncluded: true,
                    }
                    : {
                        scope: "refresh-ledger",
                        ledgerId: request.refreshKey,
                        expectedRevision: 0,
                        committedRevision: ledgerRevision,
                        transactionId: `record-source-refresh:${request.refreshKey}`,
                    },
            };
            const persisted = await this.writeDurableRefreshIndex({
                schemaVersion: 1,
                kind: "record-source-refresh-index",
                refreshKey: request.refreshKey,
                identity: structuredClone(request.identity),
                rootBinding: structuredClone(request.persistenceRoot),
                refreshTaskId,
                revision: 1,
                attachments: [{ pendingRefresh: structuredClone(pendingRefresh), durabilityReceipt: structuredClone(durabilityReceipt) }],
                createdAt: receipt.payload.persistedAt,
                updatedAt: receipt.payload.persistedAt,
            }, attachmentKey);
            const durableAttachment = persisted.index.attachments[0];
            if (!durableAttachment) throw new RecordSchedulerRepairRequiredError(`refresh index ${request.refreshKey} 缺少 attachment`);
            if (request.schedulerLedgerCas) {
                await this.bindPendingRefreshToSchedulerLedger(request.schedulerLedgerCas, durableAttachment.pendingRefresh);
            }
            return {
                disposition: persisted.created ? "created" : "attached",
                pendingRefresh: structuredClone(durableAttachment.pendingRefresh),
                durabilityReceipt: structuredClone(durableAttachment.durabilityReceipt),
            };
        });
    }

    private async readBackProductionPendingRefresh(request: RecordSourceRefreshReadBackRequest): Promise<RecordSourceRefreshReadBackResult> {
        let index: DurableRefreshIndex | null;
        try {
            index = await this.readDurableRefreshIndex(request, request.persistenceRoot);
        } catch (error) {
            return { kind: "corrupt", reason: error instanceof Error ? error.message : String(error) };
        }
        if (!index) return { kind: "missing", reason: "refresh index missing" };
        const attachment = index.attachments.find(candidate => (
            candidate.pendingRefresh.sourceSnapshotId === request.sourceSnapshotId
            && candidate.pendingRefresh.recordWorkKey === request.recordWorkKey
            && candidate.pendingRefresh.fromRevision === request.fromRevision
            && candidate.pendingRefresh.desiredRevision === request.desiredRevision
        ));
        if (!attachment) {
            return { kind: "missing", reason: "refresh attachment missing" };
        }
        const ledgerPath = path.resolve(this.control.dataRoot, attachment.pendingRefresh.ledgerRef.path);
        if (!pathIsWithin(this.control.dataRoot, ledgerPath)) return { kind: "corrupt", reason: "refresh receipt path escapes data root" };
        try {
            const receipt = await fs.promises.readFile(ledgerPath);
            if (receipt.byteLength !== attachment.pendingRefresh.ledgerRef.byteLength
                || rawSha256(receipt) !== attachment.pendingRefresh.ledgerRef.hash
                || createPendingRefreshRecordHash(attachment.pendingRefresh) !== attachment.durabilityReceipt.refreshRecordHash
                || stableJsonHash(attachment.durabilityReceipt) !== stableJsonHash(request.durabilityReceipt)) {
                return { kind: "corrupt", reason: "refresh receipt readback mismatch" };
            }
        } catch (error) {
            return { kind: "missing", reason: error instanceof Error ? error.message : String(error) };
        }
        return {
            kind: "verified",
            readFrom: "durable-storage",
            refreshKey: request.refreshKey,
            rootBinding: structuredClone(index.rootBinding),
            pendingRefresh: structuredClone(attachment.pendingRefresh),
            durabilityReceipt: structuredClone(attachment.durabilityReceipt),
            ledger: structuredClone(attachment.durabilityReceipt.ledger),
            refreshRecordHash: attachment.durabilityReceipt.refreshRecordHash,
            observedAt: this.now().toISOString(),
        };
    }

    private createProductionRefreshBackend(source: FrozenRuntimeSource): {
        backend: RecordSourceRefreshBackend;
        latestScan: () => Awaited<ReturnType<ProductionSourceReader["scan"]>> | null;
    } {
        if (!this.productionSourceReader) throw new RecordSchedulerRepairRequiredError("production source reader 不可用，拒绝 source commit");
        let scan: Awaited<ReturnType<ProductionSourceReader["scan"]>> | null = null;
        const identity = conversationStateIdentity(source.snapshot);
        return {
            latestScan: () => scan,
            backend: {
                rereadCurrentSource: async () => {
                    scan = await this.productionSourceReader!.scan(source.request);
                    const fullRead = scan.fullSourceRead;
                    if (fullRead.status === "complete") {
                        return {
                            kind: "current" as const,
                            identity,
                            currentRevision: fullRead.evidence.sourceRevision.revision,
                            ...(isSafeRevisionSequence(fullRead.evidence.sourceRevision.sequence)
                                ? { currentRevisionSequence: fullRead.evidence.sourceRevision.sequence }
                                : {}),
                            contentHash: schedulerContentHash(fullRead.payload.contentHash),
                            contentEvidence: { authority: "independent-content-hash" as const, verified: true as const },
                            complete: true,
                            partial: false,
                            cacheBypassed: fullRead.authority.cacheBypassed,
                            errors: [],
                        };
                    }
                    if (scan.qualifiedAbsence
                        && isCompleteEnumerationEvidence(scan.enumeration)
                        && scan.exactFetch.exactFetchResult === "not_found") {
                        return {
                            kind: "lost" as const,
                            identity,
                            complete: true,
                            partial: false,
                            cacheBypassed: true,
                            errors: [],
                        };
                    }
                    return {
                        kind: "unresolved" as const,
                        identity,
                        complete: false,
                        partial: true,
                        cacheBypassed: scan.enumeration.cacheBypassed && scan.exactFetch.cacheBypassed,
                        errors: [
                            ...scan.enumeration.errors.map(issue => `${issue.code}:${issue.message}`),
                            ...scan.exactFetch.errors.map(issue => `${issue.code}:${issue.message}`),
                            ...fullRead.issues.map(issue => `${issue.code}:${issue.message}`),
                        ],
                    };
                },
                compareAuthoritativeRevisions: async request => {
                    const expectedSequence = request.expectedRevisionSequence;
                    const currentSequence = request.currentRevisionSequence;
                    if (request.expectedRevision === request.currentRevision && expectedSequence === currentSequence) return "equal";
                    if (isSafeRevisionSequence(expectedSequence) && isSafeRevisionSequence(currentSequence)) {
                        if (currentSequence > expectedSequence) return "advanced";
                        if (currentSequence < expectedSequence) return "behind";
                        return "unresolved";
                    }
                    return request.expectedRevision === request.currentRevision ? "equal" : "unresolved";
                },
                ensurePendingRefresh: request => this.ensureProductionPendingRefresh(request),
                readBackPendingRefresh: request => this.readBackProductionPendingRefresh(request),
            },
        };
    }

    private async persistRefreshDecisionState(input: {
        taskId: string;
        recordWorkKey: string;
        source: FrozenRuntimeSource;
        decision: RecordSourceRefreshDecision;
        scan: Awaited<ReturnType<ProductionSourceReader["scan"]>> | null;
    }): Promise<RecordSourceRefreshDecision> {
        await this.ensureConversationStateStore();
        const identity = conversationStateIdentity(input.source.snapshot);
        const observedAt = input.scan?.enumeration.observedAt.completedAt || this.now().toISOString();
        const observedAtMs = Date.parse(observedAt);
        const evidenceHash = input.scan?.fullSourceRead.evidence?.evidenceHash
            || input.scan?.qualifiedAbsence?.evidenceHash
            || input.scan?.enumeration.evidenceHash
            || hash({ taskId: input.taskId, decision: input.decision.reason, observedAt });
        let effectiveState = input.decision.candidateState as ConversationState;
        await this.upsertConversationStateWithRetry(identity, existing => {
            const activeTaskIds = new Set(existing?.activeTaskIds || []);
            activeTaskIds.add(input.taskId);
            const evidence: ConversationStateEvidence = {
                source: "record-source-refresh",
                complete: input.decision.reread?.complete || false,
                observedAt,
                evidenceHash,
                ...(input.scan ? { scanId: input.scan.scanId } : {}),
                details: {
                    sourceRevision: input.decision.conversationState.observedSourceRevision,
                    contentHash: input.decision.conversationState.observedContentHash,
                    sourceSnapshotId: input.source.snapshot.sourceSnapshotId,
                    decisionReason: input.decision.reason,
                    rereadKind: input.decision.reread?.kind || "unresolved",
                    ...(input.decision.reread?.kind === "lost" && input.scan && Number.isFinite(observedAtMs)
                        ? { absenceObservation: { scanId: input.scan.scanId, observedAtMs } }
                        : {}),
                },
            };
            const evidenceHistory = this.mergeConversationEvidence(existing?.evidence || [], evidence);
            effectiveState = existing?.state === "Conflict"
                ? "Conflict"
                : input.decision.candidateState === "Lost" && !hasQualifiedLostObservation(evidenceHistory)
                    ? "Unresolved"
                    : input.decision.candidateState;
            return {
                workspace: existing?.workspace || null,
                titleBestEffort: existing?.titleBestEffort || null,
                latestObservedRevision: input.decision.conversationState.observedSourceRevision,
                latestEvidenceHash: evidenceHash,
                lastCompleteScanId: evidence.complete && input.scan ? input.scan.scanId : existing?.lastCompleteScanId || null,
                recordCoveredRevision: input.decision.conversationState.recordCoveredRevision,
                recordBodyHash: existing?.recordBodyHash || null,
                state: effectiveState,
                evidence: evidenceHistory,
                stateReason: effectiveState === "Unresolved" && input.decision.candidateState === "Lost"
                    ? "lost-awaits-two-independent-complete-absences"
                    : input.decision.reason,
                activeTaskIds: [...activeTaskIds],
                recordWorkKey: input.recordWorkKey,
                pendingRefreshKey: effectiveState === "Stale" || effectiveState === "Missing"
                    ? input.decision.conversationState.pendingRefreshKey
                    : null,
                sourceObservedAt: observedAt,
            };
        });
        if (effectiveState === input.decision.candidateState) return input.decision;
        return {
            ...input.decision,
            commitAllowed: false,
            candidateState: effectiveState,
            reason: effectiveState === "Conflict"
                ? "conversation-state-conflict"
                : "source-lost-awaits-independent-recheck",
            ledgerCommit: null,
            conversationState: {
                ...input.decision.conversationState,
                candidateState: effectiveState,
                pendingRefreshKey: null,
            },
            refreshPersistence: null,
        };
    }

    async guardSourceCommit(input: RecordSchedulerSourceCommitGuardInput): Promise<RecordSourceRefreshDecision> {
        const stored = await readRecordSchedulerLedgerStore(input.taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`source commit ${input.taskId} 的 scheduler ledger 不可读取：${stored.kind}`);
        }
        const source = (await this.readFrozenSources(input.taskId)).sources
            .find(candidate => candidate.snapshot.sourceSnapshotId === input.sourceSnapshotId);
        if (!source) throw new RecordSchedulerRepairRequiredError(`source commit 缺少冻结 source snapshot：${input.sourceSnapshotId}`);
        const matchingCommits = stored.ledger.commits.filter(commit => (
            commit.sourceSnapshotId === input.sourceSnapshotId
            && (!input.recordWorkKey || commit.recordWorkKey === input.recordWorkKey)
        ));
        if (matchingCommits.length !== 1) {
            throw new RecordSchedulerRepairRequiredError(`source commit ${input.sourceSnapshotId} 无法唯一绑定 scheduler commit`);
        }
        const commit = matchingCommits[0];
        const recordWorkKeyValue = input.recordWorkKey || commit.recordWorkKey || recordWorkKey({
            chain: source.snapshot.chain,
            workspaceHash: source.snapshot.workspaceHash,
            conversationId: source.snapshot.conversationId,
        }, source.snapshot.desiredRevision);
        const schedulerLedgerCas = input.schedulerLedgerCas || {
            mode: "scheduler-ledger-cas" as const,
            ledgerId: input.taskId,
            expectedRevision: stored.ledger.revision,
            commitId: commit.commitId,
        };
        if (schedulerLedgerCas.ledgerId !== input.taskId
            || schedulerLedgerCas.expectedRevision !== stored.ledger.revision
            || schedulerLedgerCas.commitId !== commit.commitId) {
            throw new RecordSchedulerRepairRequiredError(`source commit ${input.sourceSnapshotId} 的 scheduler CAS barrier 与当前 ledger 不一致`);
        }
        const refresh = this.createProductionRefreshBackend(source);
        const decision = await new RecordSourceRefreshCoordinator(refresh.backend).coordinate({
            taskId: input.taskId,
            recordWorkKey: recordWorkKeyValue,
            sourceSnapshot: source.snapshot,
            persistenceRoot: await this.refreshRootBinding(),
            schedulerLedgerCas,
        });
        return this.persistRefreshDecisionState({
            taskId: input.taskId,
            recordWorkKey: recordWorkKeyValue,
            source,
            decision,
            scan: refresh.latestScan(),
        });
    }

    private async materializeSelectedSources(
        taskId: string,
        selector: RecordDiscoverySelector,
        discovery: DiscoveryCandidateSnapshot,
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease,
        options: { recovery?: boolean } = {},
    ): Promise<FrozenRuntimeSourceSet> {
        await this.control.spool.initializeRoot({ mode: "open" });
        await this.control.spool.initializeTask({ taskId, mode: "open" });
        const intent = await this.ensureSourceMaterializationIntent(taskId, discovery, selector, ownerLease);
        if (intent.phase === "sealed") {
            const frozen = await this.readFrozenSources(taskId);
            await this.persistMaterializedSourceResolution(taskId, frozen, ownerLease);
            return frozen;
        }
        const completed = new Set(intent.outcomes.map(outcome => outcome.sourceKey));
        const candidatesByKey = new Map(
            selectRecordDiscoveryCandidates(discovery, selector).map(candidate => [
                sourceMaterializationSelection(candidate, selector).sourceKey,
                candidate,
            ]),
        );
        for (const selection of intent.selected) {
            const candidate = candidatesByKey.get(selection.sourceKey);
            if (!candidate) {
                throw new RecordSchedulerRepairRequiredError(`Record source ${taskId} materialization intent 引用了冻结 CandidateSnapshot 外的来源`);
            }
            if (completed.has(selection.sourceKey)) continue;
            const identity = {
                conversationId: candidate.source.identity.conversationId,
                chain: candidate.source.host,
                workspaceHash: candidate.source.identity.workspace.workspaceId,
            };
            if (options.recovery) {
                const reason = "source materialization recovery refused live reread without a durable outcome";
                await this.persistUnresolvedSourceState({ taskId, candidate, reason });
                await this.persistSourceMaterializationOutcome({
                    taskId,
                    ownerLease,
                    outcome: {
                        sourceKey: selection.sourceKey,
                        kind: "unresolved",
                        observedAt: this.now().toISOString(),
                        sourceRevision: candidate.sourceRevision?.revision,
                        evidenceHash: selection.evidenceHash,
                        reason,
                    },
                });
                completed.add(selection.sourceKey);
                continue;
            }
            if (!this.productionSourceReader) {
                const reason = "production source reader unavailable";
                await this.persistUnresolvedSourceState({ taskId, candidate, reason });
                await this.persistSourceMaterializationOutcome({
                    taskId,
                    ownerLease,
                    outcome: {
                        sourceKey: selection.sourceKey,
                        kind: "unresolved",
                        observedAt: this.now().toISOString(),
                        sourceRevision: candidate.sourceRevision?.revision,
                        evidenceHash: candidate.evidenceHash,
                        reason,
                    },
                });
                completed.add(selection.sourceKey);
                continue;
            }
            const sourceRequest = productionSourceRequestForCandidate(candidate);
            let scan: Awaited<ReturnType<ProductionSourceReader["scan"]>>;
            try {
                scan = await this.productionSourceReader.scan(sourceRequest);
            } catch (error) {
                const reason = `production source full read failed: ${error instanceof Error ? error.message : String(error)}`;
                await this.persistUnresolvedSourceState({ taskId, candidate, reason });
                await this.persistSourceMaterializationOutcome({
                    taskId,
                    ownerLease,
                    outcome: {
                        sourceKey: selection.sourceKey,
                        kind: "unresolved",
                        observedAt: this.now().toISOString(),
                        sourceRevision: candidate.sourceRevision?.revision,
                        evidenceHash: candidate.evidenceHash,
                        reason,
                    },
                });
                completed.add(selection.sourceKey);
                continue;
            }
            if (scan.fullSourceRead.status !== "complete") {
                const reason = scan.fullSourceRead.issues.map(issue => `${issue.code}:${issue.message}`).join("; ")
                    || "production source full read unresolved";
                if (scan.fullSourceRead.authority.contradiction) {
                    await this.persistFullSourceReadState({
                        taskId,
                        identity: conversationStateIdentity(identity),
                        snapshot: {
                            schemaVersion: 5,
                            sourceSnapshotId: `conflict:${candidate.candidateId}`,
                            snapshotRevision: 1,
                            snapshotHash: "conflict",
                            snapshotRef: { path: "conflict", hash: "conflict", byteLength: 0 },
                            conversationId: identity.conversationId,
                            chain: identity.chain,
                            workspaceHash: identity.workspaceHash,
                            sourceRevision: scan.enumeration.sourceRevision.revision,
                            desiredRevision: scan.enumeration.sourceRevision.revision,
                            contentHash: scan.fullSourceRead.authority.contradiction.observedContentHash,
                            contentRef: { path: "conflict", hash: "conflict", byteLength: 0 },
                            formatterVersion: "unresolved",
                            readRange: { startRound: 0, endRound: 0, totalRounds: 0 },
                            complete: false,
                            gaps: [],
                            parseWarnings: [],
                        },
                        scanId: scan.scanId,
                        evidenceHash: scan.fullSourceRead.authority.fullReadEvidenceHash || scan.enumeration.evidenceHash,
                        observedAt: scan.enumeration.observedAt.completedAt,
                        contentHash: scan.fullSourceRead.authority.contradiction.observedContentHash,
                        title: null,
                        authority: scan.fullSourceRead.authority,
                    });
                    await this.persistSourceMaterializationOutcome({
                        taskId,
                        ownerLease,
                        outcome: {
                            sourceKey: selection.sourceKey,
                            kind: "conflict",
                            observedAt: scan.enumeration.observedAt.completedAt,
                            sourceRevision: scan.enumeration.sourceRevision.revision,
                            contentHash: scan.fullSourceRead.authority.contradiction.observedContentHash,
                            previousContentHash: scan.fullSourceRead.authority.contradiction.previousContentHash,
                            evidenceHash: scan.fullSourceRead.authority.fullReadEvidenceHash || scan.enumeration.evidenceHash,
                            scanId: scan.scanId,
                            reason,
                        },
                    });
                } else {
                    await this.persistUnresolvedSourceState({ taskId, candidate, reason, scan });
                    await this.persistSourceMaterializationOutcome({
                        taskId,
                        ownerLease,
                        outcome: {
                            sourceKey: selection.sourceKey,
                            kind: "unresolved",
                            observedAt: scan.enumeration.observedAt.completedAt,
                            sourceRevision: scan.enumeration.sourceRevision.revision,
                            evidenceHash: scan.fullSourceRead.evidence?.evidenceHash || scan.enumeration.evidenceHash,
                            scanId: scan.scanId,
                            reason,
                        },
                    });
                }
                completed.add(selection.sourceKey);
                continue;
            }
            const fullRead = scan.fullSourceRead;
            const contentWrite = await this.control.spool.writeImmutable({
                taskId,
                kind: "source",
                content: fullRead.payload.bytes,
            });
            if (contentWrite.reference.hash !== schedulerContentHash(fullRead.payload.contentHash)
                || contentWrite.reference.byteLength !== fullRead.payload.byteLength) {
                throw new RecordSchedulerRepairRequiredError(`Record source ${identity.conversationId} payload spool 回读 hash/length 不一致`);
            }
            const sourceResult = createRecordSourceSnapshot({
                candidateId: candidate.candidateId,
                source: candidate.source,
                fullSourceRead: fullRead.evidence,
                revisionSequence: fullRead.evidence.sourceRevision.sequence,
                contentBinding: {
                    kind: "spool",
                    ref: contentWrite.reference.path,
                    byteLength: contentWrite.reference.byteLength,
                    contentHash: fullRead.payload.contentHash,
                },
                formatterVersion: fullRead.payload.formatterVersion,
                capturedAtSequence: fullRead.evidence.observedAt.sequence,
            });
            if (sourceResult.status !== "accepted") {
                const reason = `createRecordSourceSnapshot rejected: ${sourceResult.reason}: ${sourceResult.issues.join("; ")}`;
                await this.persistUnresolvedSourceState({ taskId, candidate, reason, scan });
                await this.persistSourceMaterializationOutcome({
                    taskId,
                    ownerLease,
                    outcome: {
                        sourceKey: selection.sourceKey,
                        kind: "unresolved",
                        observedAt: scan.enumeration.observedAt.completedAt,
                        sourceRevision: scan.enumeration.sourceRevision.revision,
                        evidenceHash: fullRead.evidence.evidenceHash,
                        scanId: scan.scanId,
                        reason,
                    },
                });
                completed.add(selection.sourceKey);
                continue;
            }
            const capsule: FrozenRuntimeSourceCapsule = {
                kind: "record-runtime-source-capsule",
                discoverySnapshot: structuredClone(sourceResult.snapshot),
                request: structuredClone(sourceRequest),
                scanId: scan.scanId,
                authority: structuredClone(fullRead.authority),
            };
            const capsuleWrite = await this.control.spool.writeImmutable({
                taskId,
                kind: "source",
                content: JSON.stringify(capsule),
            });
            const snapshot = schedulerSourceSnapshot(candidate, sourceResult.snapshot, capsuleWrite.reference, contentWrite.reference);
            const conversationState = await this.persistFullSourceReadState({
                taskId,
                identity: conversationStateIdentity(identity),
                snapshot,
                scanId: scan.scanId,
                evidenceHash: fullRead.evidence.evidenceHash,
                observedAt: fullRead.evidence.observedAt.completedAt,
                contentHash: fullRead.payload.contentHash,
                title: null,
                authority: fullRead.authority,
            });
            const conflict = conversationState.state === "Conflict";
            await this.persistSourceMaterializationOutcome({
                taskId,
                ownerLease,
                snapshot,
                outcome: {
                    sourceKey: selection.sourceKey,
                    kind: conflict ? "conflict" : "accepted",
                    observedAt: fullRead.evidence.observedAt.completedAt,
                    sourceSnapshotId: snapshot.sourceSnapshotId,
                    sourceRevision: snapshot.desiredRevision,
                    contentHash: snapshot.contentHash,
                    evidenceHash: fullRead.evidence.evidenceHash,
                    scanId: scan.scanId,
                    ...(conflict ? { reason: "same revision produced different source bytes" } : {}),
                },
            });
            completed.add(selection.sourceKey);
        }
        return this.sealSourceMaterialization(taskId, ownerLease);
    }

    private async getOrRecoverExecutionOwner(taskId: string): Promise<RecoverRecordSchedulerOwnerResult> {
        const nowMs = this.now().getTime();
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs });
        if (stored.kind === "current") {
            const activeOwner = stored.ledger.schedulerOwner;
            if (activeOwner && Date.parse(activeOwner.expiresAt) > nowMs) {
                if (activeOwner.ownerId === this.ownerId && stored.ledger.schedulerOwnerRecovery === undefined) {
                    return { kind: "recovered", ownerLease: activeOwner, status: this.control.status(taskId) };
                }
                return {
                    kind: "blocked",
                    status: this.control.status(taskId),
                    reason: activeOwner.ownerId === this.ownerId
                        ? `execution owner ${taskId} 的同 owner recovery barrier 尚未完成`
                        : `execution owner ${taskId} 已由有效 owner ${activeOwner.ownerId} 持有`,
                };
            }
            if (!activeOwner && stored.ledger.recordWork.length === 0) {
                try {
                    const claimed = await claimSchedulerOwnerLease(taskId, stored.ledger.revision, this.ownerId, {
                        nowMs,
                        leaseMs: this.ownerLeaseMs,
                    });
                    await completeSchedulerOwnerRecovery(taskId, claimed.revision, claimed.ownerLease, {
                        nowMs,
                        recoveredRecordWorkKeys: [],
                    });
                    return { kind: "recovered", ownerLease: claimed.ownerLease, status: this.control.status(taskId) };
                } catch (error) {
                    return {
                        kind: "blocked",
                        status: this.control.status(taskId),
                        reason: error instanceof Error ? error.message : String(error),
                    };
                }
            }
        }
        return this.control.recoverOwner({ taskId, ownerId: this.ownerId, nowMs, leaseMs: this.ownerLeaseMs });
    }

    private async requireExecutionOwner(taskId: string): Promise<RecoveredRecordSchedulerOwner["ownerLease"]> {
        const recovered = await this.getOrRecoverExecutionOwner(taskId);
        if (recovered.kind === "recovered") return recovered.ownerLease;
        if (recovered.kind === "repair_required") {
            throw new RecordSchedulerRepairRequiredError(`execution owner ${taskId} 恢复失败：${recovered.reason}`);
        }
        throw new RecordSchedulerRuntimeOwnerUnavailableError(`execution owner ${taskId} 不可用：${recovered.reason}`);
    }

    private async heartbeatExecutionOwnerLease(
        taskId: string,
        expectedOwnerLease: RecordSchedulerRuntimeExecutionOwnerLease,
        leaseMs: number,
    ): Promise<RecordSchedulerRuntimeExecutionOwnerLease> {
        for (let attempt = 0; attempt < EXECUTION_OWNER_HEARTBEAT_RETRY_LIMIT; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRuntimeOwnerUnavailableError(
                    `execution owner heartbeat ${taskId} 无法读取权威 ledger：${current.kind}`,
                );
            }
            const currentOwner = current.ledger.schedulerOwner;
            const heartbeatNowMs = Math.max(this.now().getTime(), Date.parse(currentOwner?.heartbeatAt || ""));
            if (!currentOwner
                || !sameExecutionOwnerIdentity(currentOwner, expectedOwnerLease)
                || Date.parse(currentOwner.expiresAt) <= heartbeatNowMs
                || current.ledger.schedulerOwnerRecovery !== undefined) {
                throw new RecordSchedulerRuntimeOwnerFencedError(
                    `execution owner heartbeat ${taskId} 已失去原 lease/epoch/fence authority`,
                );
            }
            try {
                const renewed = await heartbeatSchedulerOwnerLease(
                    taskId,
                    current.ledger.revision,
                    currentOwner,
                    { leaseMs, nowMs: heartbeatNowMs },
                );
                return renewed.ownerLease;
            } catch (error) {
                if (isSchedulerLedgerConflictError(error)) continue;
                if (isSchedulerOwnerAuthorityError(error)) throw error;
                throw new RecordSchedulerRuntimeOwnerUnavailableError(
                    `execution owner heartbeat ${taskId} 失败：${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        throw new RecordSchedulerRuntimeOwnerUnavailableError(
            `execution owner heartbeat ${taskId} 在 ${EXECUTION_OWNER_HEARTBEAT_RETRY_LIMIT} 次 CAS 重试后仍冲突`,
        );
    }

    private async readExecutionOwnerLease(
        taskId: string,
        expectedOwnerLease: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<RecordSchedulerRuntimeExecutionOwnerLease> {
        const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (current.kind !== "current") {
            throw new RecordSchedulerRuntimeOwnerUnavailableError(
                `execution owner ${taskId} 无法读取权威 ledger：${current.kind}`,
            );
        }
        const currentOwner = current.ledger.schedulerOwner;
        if (!currentOwner
            || !sameExecutionOwnerIdentity(currentOwner, expectedOwnerLease)
            || Date.parse(currentOwner.expiresAt) <= this.now().getTime()
            || current.ledger.schedulerOwnerRecovery !== undefined) {
            throw new RecordSchedulerRuntimeOwnerFencedError(
                `execution owner ${taskId} 已失去原 lease/epoch/fence authority`,
            );
        }
        return currentOwner;
    }

    private async runWithExecutionOwnerHeartbeat<T>(
        taskId: string,
        ownerLease: RecordSchedulerRuntimeExecutionOwnerLease,
        execute: () => Promise<T>,
        options: { heartbeatImmediately?: boolean } = {},
    ): Promise<{ value: T; ownerLease: RecordSchedulerRuntimeExecutionOwnerLease }> {
        const leaseMs = executionOwnerLeaseDurationMs(ownerLease);
        const intervalMs = executionOwnerHeartbeatIntervalMs(leaseMs);
        let currentOwnerLease = options.heartbeatImmediately
            ? await this.heartbeatExecutionOwnerLease(taskId, ownerLease, leaseMs)
            : await this.readExecutionOwnerLease(taskId, ownerLease);
        let stopped = false;
        let wakeHeartbeatTimer: (() => void) | undefined;
        let heartbeatFailed = false;
        let heartbeatError: unknown;

        const waitForHeartbeatInterval = () => new Promise<void>(resolve => {
            const wake = () => {
                clearTimeout(timer);
                if (wakeHeartbeatTimer === wake) wakeHeartbeatTimer = undefined;
                resolve();
            };
            const timer = setTimeout(() => {
                if (wakeHeartbeatTimer === wake) wakeHeartbeatTimer = undefined;
                resolve();
            }, intervalMs);
            wakeHeartbeatTimer = wake;
        });

        const heartbeatLoop = (async () => {
            while (!stopped) {
                await waitForHeartbeatInterval();
                if (stopped) return;
                try {
                    currentOwnerLease = await this.heartbeatExecutionOwnerLease(taskId, currentOwnerLease, leaseMs);
                } catch (error) {
                    heartbeatFailed = true;
                    heartbeatError = error;
                    stopped = true;
                    return;
                }
            }
        })();

        let executeFailed = false;
        let executeError: unknown;
        let value!: T;
        try {
            value = await execute();
        } catch (error) {
            executeFailed = true;
            executeError = error;
        } finally {
            stopped = true;
            wakeHeartbeatTimer?.();
            await heartbeatLoop;
        }
        if (heartbeatFailed) throw heartbeatError;
        if (executeFailed) throw executeError;
        if (options.heartbeatImmediately) {
            currentOwnerLease = await this.readExecutionOwnerLease(taskId, currentOwnerLease);
        }
        return { value, ownerLease: currentOwnerLease };
    }

    private async executeFrozenTask(input: {
        taskId: string;
        context: BackgroundTaskContext;
        discoverySnapshot?: DiscoveryCandidateSnapshot;
        sourceSnapshots?: FrozenRuntimeSourceSet;
        ownerLease: RecoveredRecordSchedulerOwner["ownerLease"];
        validateLegacyState?: (snapshot?: DiscoveryCandidateSnapshot) => Promise<void>;
        execute: RecordSchedulerRuntimeResumeExecute;
    }): Promise<FrozenExecutionLoopResult> {
        const sourceConflicts = input.sourceSnapshots?.unresolved.filter(issue => issue.kind === "conflict") || [];
        if (sourceConflicts.length > 0) {
            await this.advanceTask(input.taskId, "RepairRequired", input.ownerLease);
            return {
                disposition: "repair_required",
                result: `❌ Record source materialization conflict：${sourceConflicts.length} 个候选的修订证据自相矛盾，已阻断执行并标记 RepairRequired`,
                ownerLease: input.ownerLease,
            };
        }
        if (input.sourceSnapshots
            && input.sourceSnapshots.selectedCount === 0
            && input.sourceSnapshots.sources.length === 0
            && input.sourceSnapshots.unresolved.length === 0) {
            await this.advanceTask(input.taskId, "Succeeded", input.ownerLease);
            return {
                disposition: "executed",
                result: "✅ Record source discovery 完整且没有需要更新的候选，任务以持久 no-op 成功结束",
                ownerLease: input.ownerLease,
            };
        }
        if (input.sourceSnapshots
            && input.sourceSnapshots.sources.length === 0
            && input.sourceSnapshots.unresolved.length > 0) {
            await this.advanceTask(input.taskId, "Deferred", input.ownerLease);
            return {
                disposition: "deferred",
                result: `⚠️ Record source materialization deferred：${input.sourceSnapshots.unresolved.length} 个候选缺少可安全执行的完整来源`,
                ownerLease: input.ownerLease,
            };
        }
        const execution = await this.runWithExecutionOwnerHeartbeat(input.taskId, input.ownerLease, async () => {
            await input.validateLegacyState?.(input.discoverySnapshot);
            await this.advanceTask(input.taskId, "Running", input.ownerLease);
            if (input.context.isCancelled() || input.context.isSettled()) {
                return { cancelled: true, result: "🛑 Record scheduler task 已在执行前取消或结算" };
            }
            return {
                cancelled: false,
                result: await input.execute(input.context, input.discoverySnapshot, input.sourceSnapshots),
            };
        });
        if (execution.value.cancelled) {
            return {
                disposition: "cancelled",
                result: execution.value.result,
                ownerLease: execution.ownerLease,
            };
        }
        if (!input.context.isCancelled() && !input.context.isSettled()) {
            if (this.mode === "test") {
                await this.advanceTask(
                    input.taskId,
                    input.sourceSnapshots?.unresolved.length ? "Deferred" : "Succeeded",
                    execution.ownerLease,
                );
            } else {
                await this.settleProductionExecution(
                    input.taskId,
                    execution.value.result,
                    execution.ownerLease,
                    Boolean(input.sourceSnapshots?.unresolved.length),
                );
            }
        }
        return {
            disposition: input.sourceSnapshots?.unresolved.length ? "deferred" : "executed",
            result: execution.value.result,
            ownerLease: execution.ownerLease,
        };
    }

    private async settleProductionExecution(
        taskId: string,
        executionResult: string,
        ownerLease: RecoveredRecordSchedulerOwner["ownerLease"],
        sourceUnresolved: boolean,
    ): Promise<void> {
        const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (current.kind !== "current") {
            throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 执行返回后 ledger 不可判定：${current.kind}`);
        }
        const ledger = current.ledger;
        if (ledger.task.state === "RepairRequired") {
            throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 已由执行层标记 RepairRequired：${executionResult}`);
        }
        if (ledger.task.state === "FailedFinal") {
            throw new Error(`Record scheduler ${taskId} 执行失败：${executionResult}`);
        }
        if (ledger.task.state === "Cancelled" || ledger.task.state === "Deferred") return;

        const unknownAttempts = ledger.attempts.filter(attempt => attempt.state === "UnknownOutcome");
        if (unknownAttempts.length > 0) {
            const wakeTimes = unknownAttempts.map(attempt => Date.parse(attempt.unknownOutcomeUntil || ""));
            if (wakeTimes.some(wakeAtMs => !Number.isFinite(wakeAtMs))) {
                throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 的 UnknownOutcome Attempt 缺少有效宽限期`);
            }
            const wakeAtMs = Math.max(...wakeTimes);
            if (wakeAtMs <= this.now().getTime()) {
                throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 执行返回后仍残留已过期 UnknownOutcome`);
            }
            throw createBackgroundTaskSuspension({
                taskId,
                wakeAt: new Date(wakeAtMs).toISOString(),
                waitingReason: `record-scheduler:unknown-outcome:${unknownAttempts.map(attempt => attempt.attemptId).join(",")}`,
                ledgerRevision: ledger.revision,
            });
        }

        const waitingRetryUnits = ledger.units.filter(unit => unit.state === "WaitingRetry");
        if (waitingRetryUnits.length > 0) {
            const wakeTimes = waitingRetryUnits.map(unit => Date.parse(unit.nextEligibleAt || ""));
            if (wakeTimes.some(wakeAtMs => !Number.isFinite(wakeAtMs))) {
                throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 的 WaitingRetry Unit 缺少有效 nextEligibleAt`);
            }
            const wakeAtMs = Math.min(...wakeTimes);
            if (wakeAtMs <= this.now().getTime()) {
                throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 执行返回后仍残留已到期 WaitingRetry`);
            }
            throw createBackgroundTaskSuspension({
                taskId,
                wakeAt: new Date(wakeAtMs).toISOString(),
                waitingReason: `record-scheduler:waiting-retry:${waitingRetryUnits.map(unit => unit.unitId).join(",")}`,
                ledgerRevision: ledger.revision,
            });
        }

        if (sourceUnresolved) {
            await this.advanceTask(taskId, "Deferred", ownerLease);
            return;
        }

        const failedUnit = ledger.units.find(unit => unit.state === "FailedFinal");
        if (failedUnit || ledger.task.recordItems.failed > 0) {
            throw new Error(`Record scheduler ${taskId} 未完成 Record：${failedUnit ? `Unit ${failedUnit.unitId} FailedFinal` : `${ledger.task.recordItems.failed} 个 Record 失败`}；${executionResult}`);
        }

        const activeAttempt = ledger.attempts.find(attempt => ["Created", "DispatchIntentPersisted", "Dispatched"].includes(attempt.state));
        const activeUnit = ledger.units.find(unit => !["Succeeded", "FailedFinal", "Cancelled", "Discarded", "Superseded"].includes(unit.state));
        if (activeAttempt || activeUnit) {
            throw new RecordSchedulerRepairRequiredError(
                `Record scheduler ${taskId} 执行回调提前返回：${activeAttempt ? `Attempt ${activeAttempt.attemptId}=${activeAttempt.state}` : `Unit ${activeUnit!.unitId}=${activeUnit!.state}`}`,
            );
        }

        const finalizedRecords = ledger.units.filter(unit => unit.layer === "local-finalize" && unit.state === "Succeeded").length;
        const expectedRecords = ledger.task.recordItems.total;
        if (expectedRecords <= 0
            || ledger.task.recordItems.succeeded !== expectedRecords
            || finalizedRecords !== expectedRecords
            || ledger.task.recordItems.unresolved > 0) {
            throw new Error(
                `Record scheduler ${taskId} 缺少完整 durable local-finalize：expected=${expectedRecords}, counters=${ledger.task.recordItems.succeeded}/${ledger.task.recordItems.failed}/${ledger.task.recordItems.unresolved}, finalized=${finalizedRecords}；${executionResult}`,
            );
        }
        await this.advanceTask(taskId, "Succeeded", ownerLease);
    }

    private async runAdmittedTask(
        request: RecordSchedulerRuntimeExecutionRequest,
        admittedRequest: RecordSchedulerRuntimeAdmitRequest,
    ): Promise<string> {
        let executionStarted = false;
        let discoveryFrozen = false;
        let discoverySnapshot: DiscoveryCandidateSnapshot | undefined;
        let sourceSnapshots: FrozenRuntimeSourceSet | undefined;
        let ownerLease: RecoveredRecordSchedulerOwner["ownerLease"] | undefined;
        try {
            if (admittedRequest.discovery) {
                const stored = await readRecordSchedulerLedgerStore(request.taskId, { expectPublished: true });
                if (stored.kind !== "current") {
                    throw new RecordSchedulerRepairRequiredError(
                        `Record discovery ${request.taskId} 无法读取权威 ledger：${stored.kind}`,
                    );
                }
                if (stored.ledger.candidateSnapshot.snapshotId.endsWith(":pending")) {
                    const shouldRunDiscovery = await this.beginDiscovery(request.taskId);
                    if (!shouldRunDiscovery || request.context.isCancelled() || request.context.isSettled()) {
                        return "🛑 Record scheduler task 已在 discovery 前取消或结算";
                    }
                    const discovery = await this.resolveDiscovery(admittedRequest.discovery);
                    const discoveredStatus = this.status(request.taskId) || this.control.status(request.taskId);
                    const discoveredState = authoritativeSchedulerTaskState(discoveredStatus);
                    if (request.context.isCancelled()
                        || request.context.isSettled()
                        || isTerminalTaskState(discoveredState)
                        || discoveredState === "CancelRequested"
                        || discoveredState === "Cancelling") {
                        return "🛑 Record scheduler task 已在 discovery 返回后取消或结算";
                    }
                    discoverySnapshot = discovery.snapshot;
                    await this.freezeDiscoverySnapshot(request.taskId, admittedRequest, discovery);
                    discoveryFrozen = true;
                    await this.syncConversationStateFromDiscovery(discoverySnapshot, request.taskId);
                    sourceSnapshots = await this.materializeSelectedSources(
                        request.taskId,
                        admittedRequest.discovery.selector,
                        discoverySnapshot,
                    );
                } else {
                    discoveryFrozen = true;
                    await this.control.spool.initializeRoot({ mode: "open" });
                    await this.control.spool.initializeTask({ taskId: request.taskId, mode: "open" });
                    const discovery = await this.readFrozenDiscovery(request.taskId);
                    discoverySnapshot = discovery.snapshot;
                    sourceSnapshots = stored.ledger.sourceMaterialization?.phase === "sealed"
                        ? await this.readFrozenSources(request.taskId, { snapshot: discovery })
                        : await this.materializeSelectedSources(
                            request.taskId,
                            stored.ledger.candidateSnapshot.requestMode,
                            discoverySnapshot,
                            undefined,
                            { recovery: true },
                        );
                    await this.assertPendingRefreshReceipts(request.taskId);
                }
            }
            ownerLease = await this.requireExecutionOwner(request.taskId);
            const loop = await this.executeFrozenTask({
                taskId: request.taskId,
                context: request.context,
                discoverySnapshot,
                sourceSnapshots,
                ownerLease,
                validateLegacyState: admittedRequest.validateLegacyState,
                execute: async (context, snapshot, frozenSources) => {
                    executionStarted = true;
                    return this.mode === "test"
                        ? this.executeForTest!({ ...request, context, sourceSnapshots: frozenSources })
                        : admittedRequest.execute(context, snapshot, frozenSources);
                },
            });
            ownerLease = loop.ownerLease;
            return loop.result;
        } catch (error) {
            if (isBackgroundTaskSuspension(error)) throw error;
            let discoveryFailurePersistenceError: unknown;
            if (admittedRequest.discovery && !discoveryFrozen) {
                try {
                    await this.markPendingDiscoveryFailure(request.taskId, error);
                } catch (persistenceError) {
                    discoveryFailurePersistenceError = persistenceError;
                }
            }
            if (isSchedulerOwnerAuthorityError(error)) throw error;
            const repairRequired = !executionStarted || isSchedulerRepairRequiredError(error);
            await this.advanceTask(
                request.taskId,
                repairRequired ? "RepairRequired" : "FailedFinal",
                ownerLease,
            );
            if (discoveryFailurePersistenceError) {
                throw new RecordSchedulerRepairRequiredError(
                    `Record discovery ${request.taskId} 失败后证据持久化异常：${discoveryFailurePersistenceError instanceof Error ? discoveryFailurePersistenceError.message : String(discoveryFailurePersistenceError)}`,
                );
            }
            throw error;
        }
    }

    private async beginDiscovery(
        taskId: string,
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<boolean> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 无法读取权威 ledger：${current.kind}`);
            }
            if (isTerminalTaskState(current.ledger.task.state)
                || current.ledger.task.state === "CancelRequested"
                || current.ledger.task.state === "Cancelling") return false;
            if (!current.ledger.candidateSnapshot.snapshotId.endsWith(":pending")) {
                throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 已离开 pending envelope，拒绝实时重枚举`);
            }
            if (current.ledger.task.state === "Preparing") return true;
            if (current.ledger.task.state !== "Accepted") {
                throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 已在 ${current.ledger.task.state} 开始但未冻结，必须人工修复`);
            }
            try {
                await this.mutateSchedulerLedgerForExecution(taskId, current.ledger.revision, ownerLease, ledger => {
                    assertTaskTransition(ledger.task.state, "Preparing");
                    ledger.task.state = "Preparing";
                    ledger.task.updatedAt = this.now().toISOString();
                });
                return true;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 无法在五次 CAS 内建立 Preparing 边界`);
    }

    private async freezeDiscoverySnapshot(
        taskId: string,
        request: RecordSchedulerRuntimeAdmitRequest,
        discovery: FrozenRuntimeDiscovery,
        ownerLease?: RecordSchedulerRuntimeExecutionOwnerLease,
    ): Promise<void> {
        let snapshotRef: ImmutableBlobReference;
        try {
            await this.control.spool.initializeRoot({ mode: "create" });
            await this.control.spool.initializeTask({ taskId, mode: "create" });
            const binding = {
                snapshot: discovery.snapshot,
                enumerations: schedulerEnumerationsFromDiscovery(discovery.snapshot, discovery.enumerations),
            };
            snapshotRef = (await this.control.spool.writeImmutable({
                taskId,
                kind: "source",
                content: JSON.stringify(binding),
            })).reference;
        } catch (error) {
            throw new RecordSchedulerRepairRequiredError(
                `Record discovery ${taskId} 无法将 CandidateSnapshot 写入 immutable spool：${error instanceof Error ? error.message : String(error)}`,
            );
        }
        const candidateSnapshot = schedulerSnapshotFromDiscovery(
            discovery.snapshot,
            request.requestMode,
            this.now().toISOString(),
            discovery.enumerations,
            snapshotRef,
            request.discovery?.selectionLimit,
        );
        const sourceResolution = frozenDiscoverySourceResolution({
            discovery: discovery.snapshot,
            schedulerSnapshot: candidateSnapshot,
            selector: request.discovery?.selector || "normal",
            request: request.discovery!,
        });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") {
                throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 冻结前 ledger 不可判定：${current.kind}`);
            }
            if (current.ledger.candidateSnapshot.snapshotHash === candidateSnapshot.snapshotHash) return;
            if (!current.ledger.candidateSnapshot.snapshotId.endsWith(":pending")) {
                throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 已绑定不同候选快照`);
            }
            try {
                await this.mutateSchedulerLedgerForExecution(taskId, current.ledger.revision, ownerLease, ledger => {
                    ledger.candidateSnapshot = structuredClone(candidateSnapshot);
                    ledger.task.candidateSnapshotId = candidateSnapshot.snapshotId;
                    ledger.task.candidateSnapshotRevision = candidateSnapshot.snapshotRevision;
                    ledger.task.sourceResolution = structuredClone(sourceResolution.resolution);
                    ledger.task.recordItems.total = sourceResolution.knownSelectedCount;
                    ledger.task.recordItems.unresolved = sourceResolution.candidateIssueCount;
                });
                return;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 无法在五次 CAS 内冻结候选快照`);
    }

    private async markPendingDiscoveryFailure(taskId: string, error: unknown): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current" || !current.ledger.candidateSnapshot.snapshotId.endsWith(":pending")) return;
            try {
                await mutateRecordSchedulerLedger(taskId, current.ledger.revision, ledger => {
                    const snapshot = ledger.candidateSnapshot;
                    const enumerations = snapshot.enumerations.map(enumeration => ({
                        ...enumeration,
                        complete: false,
                        paginationExhausted: false,
                        truncated: true,
                        error: [...new Set([enumeration.error, message].filter((value): value is string => Boolean(value)))].join("; "),
                    }));
                    const binding = { previousHash: snapshot.snapshotHash, failure: message, enumerations };
                    const snapshotHash = hash(binding);
                    snapshot.snapshotId = `${snapshot.snapshotId}:repair-required`;
                    snapshot.snapshotRevision += 1;
                    snapshot.snapshotHash = snapshotHash;
                    snapshot.snapshotRef = {
                        ...snapshot.snapshotRef,
                        hash: snapshotHash,
                        byteLength: Buffer.byteLength(JSON.stringify(binding), "utf8"),
                    };
                    snapshot.enumerations = enumerations;
                    ledger.task.candidateSnapshotId = snapshot.snapshotId;
                    ledger.task.candidateSnapshotRevision = snapshot.snapshotRevision;
                });
                return;
            } catch (mutationError) {
                if (!isSchedulerLedgerConflictError(mutationError)) throw mutationError;
            }
        }
        throw new RecordSchedulerRepairRequiredError(`Record discovery ${taskId} 失败证据无法在五次 CAS 内持久化`);
    }

    private async advanceTask(
        taskId: string,
        target: TaskState,
        ownerLease?: RecoveredRecordSchedulerOwner["ownerLease"],
    ): Promise<void> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
            if (current.kind !== "current") return;
            if (current.ledger.task.state === target || isTerminalTaskState(current.ledger.task.state)) return;
            const transitions = nextTaskState(current.ledger.task.state, target);
            if (transitions.length === 0) return;
            try {
                const mutate = (ledger: RecordSchedulerLedger) => {
                    for (const next of transitions) {
                        if (isTerminalTaskState(ledger.task.state)) break;
                        if (ledger.task.state === next) continue;
                        assertTaskTransition(ledger.task.state, next);
                        ledger.task.state = next;
                        ledger.task.updatedAt = this.now().toISOString();
                        if (next === "Succeeded" || next === "Deferred" || next === "FailedFinal" || next === "Cancelled" || next === "RepairRequired") {
                            ledger.task.terminalState = next;
                            if (next === "RepairRequired") ledger.task.repairState = "Required";
                            if (next === "Deferred" && ledger.task.sourceResolution?.issues.length) {
                                ledger.task.sourceResolution.phase = "deferred";
                                ledger.task.sourceResolution.deferredReason = "source_unresolved";
                            }
                        }
                    }
                };
                let mutationOwnerLease = ownerLease;
                if (!mutationOwnerLease && current.ledger.schedulerOwner) {
                    const activeOwner = current.ledger.schedulerOwner;
                    if (activeOwner.ownerId !== this.ownerId
                        || Date.parse(activeOwner.expiresAt) <= this.now().getTime()
                        || current.ledger.schedulerOwnerRecovery !== undefined) {
                        throw new RecordSchedulerRuntimeOwnerUnavailableError(`task transition ${taskId} 缺少当前 scheduler owner authority`);
                    }
                    mutationOwnerLease = activeOwner;
                }
                if (mutationOwnerLease) {
                    await mutateRecordSchedulerLedgerAsOwner(
                        taskId,
                        current.ledger.revision,
                        mutationOwnerLease,
                        mutate,
                        { nowMs: this.now().getTime() },
                    );
                } else {
                    await mutateRecordSchedulerLedger(taskId, current.ledger.revision, mutate);
                }
                return;
            } catch (error) {
                if (!isSchedulerLedgerConflictError(error)) throw error;
            }
        }
    }
}

export function createRecordSchedulerRuntime(options: RecordSchedulerRuntimeOptions = {}): RecordSchedulerRuntime {
    return new RecordSchedulerRuntime(options);
}

export function recordSchedulerRequestKey(kind: RecordSchedulerRuntimeTaskKind, requestSummary: Record<string, unknown>): string {
    return `${kind}:${stableJsonHash(stableObject(requestSummary))}`;
}

export function formatRecordSchedulerTaskStatus(status: RecordSchedulerTaskStatus | null, terminalDetail?: string): string {
    if (!status) return "❌ 未找到后台任务";
    const lines = [
        status.kind === "repair_required" || status.state === "RepairRequired" ? "⚠️ Record scheduler 任务需要修复" : `📋 Record scheduler 任务：${status.state}`,
        `🆔 taskId: ${status.taskId}`,
        `⏭ 前方未终态任务: ${status.aheadTaskCount === null ? "未知（namespace 需要修复）" : status.aheadTaskCount}`,
        status.sourceResolution
            ? `🔎 来源: phase=${status.sourceResolution.phase} selected=${status.sourceResolution.selectedCount === null ? "未知" : status.sourceResolution.selectedCount} materialized=${status.sourceResolution.materializedCount} unresolved=${status.sourceResolution.unresolvedCount}`
            : "",
        status.recordItems ? `📦 Record: ${status.recordItems.succeeded}/${status.recordItems.total} 成功，失败 ${status.recordItems.failed}，未决 ${status.recordItems.unresolved}` : "",
        status.units ? `🧩 Unit: materialized=${status.units.materialized} eligible=${status.units.eligible} running=${status.units.running} done=${status.units.done} failed=${status.units.failed}` : "",
        status.runningAttemptCount !== undefined ? `🔄 Attempt: running=${status.runningAttemptCount} unknown=${status.unknownOutcomeAttemptCount || 0}` : "",
        status.reason ? `⚠️ ${status.reason}` : "",
        status.sourceResolution?.issues.length
            ? `⚠️ 来源问题: ${status.sourceResolution.issues.slice(0, 3).map(issue => `${issue.host}${issue.conversationId ? `/${issue.conversationId}` : ""} ${issue.code}: ${issue.message}`).join("; ")}${status.sourceResolution.issues.length > 3 ? `; 另有 ${status.sourceResolution.issues.length - 3} 项` : ""}`
            : "",
        terminalDetail ? `❌ ${terminalDetail}` : "",
        status.namespaceRepairReasons.length > 0 ? `⚠️ namespace: ${status.namespaceRepairReasons.join("; ")}` : "",
    ].filter(Boolean);
    return lines.join("\n");
}

export function formatRecordSchedulerCancel(result: CancelRecordSchedulerTaskResult): string {
    return [
        `🛑 Record scheduler cancel: ${result.disposition}`,
        formatRecordSchedulerTaskStatus(result.status),
        result.reason ? `⚠️ ${result.reason}` : "",
    ].filter(Boolean).join("\n");
}

export function formatRecordSchedulerRecovery(result: RecoverRecordSchedulerOwnerResult): string {
    return [
        result.kind === "recovered" ? `♻️ Record scheduler owner 已恢复：${result.status.taskId}` : `⚠️ Record scheduler recovery: ${result.kind}`,
        formatRecordSchedulerTaskStatus(result.status),
        "reason" in result && result.reason ? `⚠️ ${result.reason}` : "",
    ].filter(Boolean).join("\n");
}

let defaultRuntime: RecordSchedulerRuntime | undefined;

export function getRecordSchedulerRuntime(): RecordSchedulerRuntime {
    defaultRuntime ||= createRecordSchedulerRuntime();
    return defaultRuntime;
}

export function __setRecordSchedulerRuntimeForTest(runtime: RecordSchedulerRuntime | undefined): void {
    defaultRuntime = runtime;
}
