import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
    RECORD_SCHEDULER_FAIRNESS_STATE_VERSION,
    RecordSchedulerFairness,
    type FairnessCandidate,
    type FairnessGrantResult,
    type FairnessRecordSnapshot,
    type FairnessUnitSnapshot,
    type FairnessUnitStatus,
    type RecordSchedulerFairnessConfigInput,
    type RecordSchedulerFairnessSnapshot,
    type SettleUnitInput,
} from "./record-scheduler-fairness.js";
import {
    RecordSchedulerQueue,
    type RecordSchedulerPromptRecipe,
    type RecordSchedulerQueueClock,
    type RecordSchedulerQueueResources,
    type RecordSchedulerQueueSnapshot,
    type RecordSchedulerQueueTimer,
    type RecordSchedulerQueueUnitView,
    type RecordSchedulerQueueWaitingReason,
    type RecordSchedulerQueueWakeReason,
} from "./record-scheduler-queue.js";
import type {
    RecordSchedulerLedger,
    SchedulerAttemptAdmission,
    SchedulerAttemptDispatchPhase,
    SchedulerAttemptLedger,
    SchedulerUnitLedger,
} from "./record-scheduler-contracts.js";
import type { ProviderLeaseIdentity } from "./provider-control-contracts.js";

export const RECORD_SCHEDULER_COORDINATOR_STATE_VERSION = 4 as const;
export const RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION = 2 as const;

export type RecordSchedulerCoordinatorRecoveryIssueCode =
    | "missing-bound-fairness-snapshot"
    | "ledger-binding-mismatch"
    | "missing-claim-dispatch-seq"
    | "invalid-claim-dispatch-seq"
    | "receipt-unit-state-mismatch"
    | "running-without-dispatch-receipt"
    | "unknown-outcome-without-receipt"
    | "claim-release-failed"
    | "claim-transfer-failed"
    | "claim-reconcile-required"
    | "claim-ledger-direction-mismatch"
    | "claim-recovery-required"
    | "claim-attempt-binding-mismatch"
    | "invalid-persisted-claim"
    | "snapshot-repair-state-mismatch";

export interface RecordSchedulerCoordinatorRecoveryIssue {
    code: RecordSchedulerCoordinatorRecoveryIssueCode;
    taskId: string;
    unitId?: string;
    detail: string;
}

export interface RecordSchedulerCoordinatorLedgerBinding {
    taskId: string;
    revision: number;
    persistedHash: string;
}

export type RecordSchedulerCoordinatorLifecycleAction = "release" | "transfer";

export type RecordSchedulerCoordinatorPersistedDisposition =
    | "active"
    | "releasing"
    | "release-failed"
    | "released"
    | "transferring"
    | "transfer-failed"
    | "recovery-required"
    | "recovery";

export interface RecordSchedulerCoordinatorLifecycleEvidence {
    schemaVersion: typeof RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION;
    direction: RecordSchedulerCoordinatorLifecycleAction;
    claimId: string;
    permitId: string;
    dispatchSeq: number;
    reconcileGeneration: number;
    evidenceHash: string;
}

export interface RecordSchedulerCoordinatorPersistedClaim {
    schemaVersion: typeof RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION;
    claimId: string;
    permitId: string;
    taskId: string;
    recordId: string;
    unitId: string;
    dispatchSeq: number;
    disposition: RecordSchedulerCoordinatorPersistedDisposition;
    lifecycleDirection?: RecordSchedulerCoordinatorLifecycleAction;
    reconcileGeneration?: number;
    lifecycleError?: string;
    reconcileRequired: boolean;
    releaseEvidence?: RecordSchedulerCoordinatorLifecycleEvidence;
    transferEvidence?: RecordSchedulerCoordinatorLifecycleEvidence;
    stateHash: string;
    attemptId?: string;
    dispatchPhase?: SchedulerAttemptDispatchPhase;
    providerAdmission?: SchedulerAttemptAdmission;
    providerEvidence?: string;
    providerLeaseIdentity?: ProviderLeaseIdentity;
}

export interface RecordSchedulerProviderPermit {
    granted: boolean;
    permitId?: string;
    release?: (claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>) => void | Promise<void>;
    transferToRecovery?: (claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>) => void | Promise<void>;
    attemptId?: string;
    dispatchPhase?: SchedulerAttemptDispatchPhase;
    providerAdmission?: SchedulerAttemptAdmission;
    providerEvidence?: string;
    providerLeaseIdentity?: ProviderLeaseIdentity;
}

export type RecordSchedulerProviderPermitResult = boolean | RecordSchedulerProviderPermit;

export type RecordSchedulerProviderPermitRequest = (
    candidate: Readonly<FairnessCandidate>,
) => RecordSchedulerProviderPermitResult | Promise<RecordSchedulerProviderPermitResult>;

export interface RecordSchedulerCoordinatorClaim {
    claimId: string;
    permitId: string;
    taskId: string;
    recordId: string;
    unitId: string;
    candidate: FairnessCandidate;
    dispatchSeq: number;
    recipe: RecordSchedulerPromptRecipe;
    prompt: unknown;
    attemptId?: string;
    dispatchPhase?: SchedulerAttemptDispatchPhase;
    providerAdmission?: SchedulerAttemptAdmission;
    providerEvidence?: string;
    providerLeaseIdentity?: ProviderLeaseIdentity;
}

export interface RecordSchedulerCoordinatorAttemptBinding {
    claimId: string;
    permitId: string;
    dispatchSeq: number;
    attemptId: string;
    dispatchPhase: Extract<SchedulerAttemptDispatchPhase, "attempt-bound" | "invoking">;
    providerAdmission: SchedulerAttemptAdmission;
    providerEvidence: string;
    providerLeaseIdentity?: ProviderLeaseIdentity;
}

export interface RecordSchedulerCoordinatorWakeEvent {
    reason: RecordSchedulerQueueWakeReason | "settled";
    nextWakeAt?: number;
    waitingReasons: readonly RecordSchedulerQueueWaitingReason[];
}

export interface RecordSchedulerCoordinatorOptions {
    clock?: RecordSchedulerQueueClock;
    timer?: RecordSchedulerQueueTimer;
    fairness?: RecordSchedulerFairnessConfigInput;
    maxMaterializedPrompts?: number;
    materializePrompt?: (recipe: RecordSchedulerPromptRecipe) => unknown;
    onWake?: (event: RecordSchedulerCoordinatorWakeEvent) => void;
}

export interface RecordSchedulerCoordinatorRebuildOptions {
    snapshot?: Readonly<RecordSchedulerCoordinatorSnapshot>;
    restartElapsedMs?: number;
}

export interface RecordSchedulerCoordinatorSnapshot {
    version: typeof RECORD_SCHEDULER_COORDINATOR_STATE_VERSION;
    fairness: RecordSchedulerFairnessSnapshot;
    ledgerBindings: readonly RecordSchedulerCoordinatorLedgerBinding[];
    activeClaims: readonly RecordSchedulerCoordinatorPersistedClaim[];
    repairRequired: boolean;
    recoveryIssues: readonly RecordSchedulerCoordinatorRecoveryIssue[];
    logicalUnitCount: number;
    activeClaimCount: number;
    materializedPromptCount: number;
    nextWakeAt?: number;
    waitingReasons: readonly RecordSchedulerQueueWaitingReason[];
}

export type RecordSchedulerCoordinatorStepResult =
    | { dispatched: true; claim: RecordSchedulerCoordinatorClaim }
    | {
        dispatched: false;
        reason: "no-eligible" | "waiting-provider" | "prompt-unavailable" | "candidate-stale" | "waiting-resource" | "waiting-prompt-window" | "repair-required";
        nextWakeAt?: number;
        waitingReasons: readonly RecordSchedulerQueueWaitingReason[];
    };

export interface RecordSchedulerCoordinatorLifecycleSuccess {
    action: RecordSchedulerCoordinatorLifecycleAction;
    claim: RecordSchedulerCoordinatorPersistedClaim;
}

export interface RecordSchedulerCoordinatorLifecycleFailure {
    action: RecordSchedulerCoordinatorLifecycleAction;
    claim: RecordSchedulerCoordinatorPersistedClaim;
    error: string;
    retryable: true;
}

export interface RecordSchedulerCoordinatorDrainResult {
    complete: boolean;
    releasedClaimCount: number;
    transferredClaimCount: number;
    successes: readonly RecordSchedulerCoordinatorLifecycleSuccess[];
    failures: readonly RecordSchedulerCoordinatorLifecycleFailure[];
    recoveryRequiredClaims: readonly RecordSchedulerCoordinatorPersistedClaim[];
}

export class CoordinatorReentrancyError extends Error {
    public readonly code = "COORDINATOR_REENTRANCY";

    public constructor(
        public readonly operation: string,
        public readonly callbackKind: string,
        public readonly claimId?: string,
    ) {
        super(`Coordinator operation ${operation} cannot re-enter from ${callbackKind} callback${claimId === undefined ? "" : ` for ${claimId}`}`);
        this.name = "CoordinatorReentrancyError";
    }
}

interface InternalClaim extends RecordSchedulerCoordinatorClaim {
    releaseProvider?: (claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>) => void | Promise<void>;
    transferToRecovery?: (claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>) => void | Promise<void>;
    recovered: boolean;
    materialized: boolean;
    disposition: RecordSchedulerCoordinatorPersistedDisposition;
    lifecycleDirection?: RecordSchedulerCoordinatorLifecycleAction;
    reconcileGeneration?: number;
    lifecycleError?: string;
    reconcileRequired: boolean;
    releaseEvidence?: RecordSchedulerCoordinatorLifecycleEvidence;
    transferEvidence?: RecordSchedulerCoordinatorLifecycleEvidence;
}

interface CoordinatorCallbackContext {
    kind: "permit" | "materialize" | "release" | "transfer";
    claimId?: string;
}

type ClaimLifecycleOutcome =
    | { status: "success"; result: RecordSchedulerCoordinatorLifecycleSuccess; reconcileRequired: boolean }
    | { status: "failure"; result: RecordSchedulerCoordinatorLifecycleFailure }
    | { status: "noop" };

interface AttemptClaimEvidence {
    taskId: string;
    recordId: string;
    unitId: string;
    attemptId: string;
    attempt: SchedulerAttemptLedger;
    kind: "active" | "unknown";
    unit: SchedulerUnitLedger;
    ledger: RecordSchedulerLedger;
}

interface LedgerRecoveryAssessment {
    evidenceByIdentity: Map<string, AttemptClaimEvidence>;
    issues: RecordSchedulerCoordinatorRecoveryIssue[];
}

const defaultClock: RecordSchedulerQueueClock = {
    now: () => Date.now(),
};

function identityKey(taskId: string, recordId: string, unitId: string): string {
    return JSON.stringify([taskId, recordId, unitId]);
}

function timestampMs(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteTimestamp(value: string | undefined): number {
    return timestampMs(value) ?? 0;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareLedger(left: RecordSchedulerLedger, right: RecordSchedulerLedger): number {
    return compareText(left.task.taskId, right.task.taskId);
}

function compareUnit(left: SchedulerUnitLedger, right: SchedulerUnitLedger): number {
    return compareText(left.recordId, right.recordId)
        || left.composeOrder - right.composeOrder
        || compareText(left.unitId, right.unitId);
}

function normalizePermit(result: RecordSchedulerProviderPermitResult): RecordSchedulerProviderPermit {
    return typeof result === "boolean" ? { granted: result } : result;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type PersistedClaimState = Omit<RecordSchedulerCoordinatorPersistedClaim, "stateHash">;
type LifecycleEvidenceState = Omit<RecordSchedulerCoordinatorLifecycleEvidence, "evidenceHash">;

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function lifecycleEvidenceHash(evidence: LifecycleEvidenceState): string {
    return sha256(JSON.stringify([
        evidence.schemaVersion,
        evidence.direction,
        evidence.claimId,
        evidence.permitId,
        evidence.dispatchSeq,
        evidence.reconcileGeneration,
    ]));
}

function evidenceState(evidence: RecordSchedulerCoordinatorLifecycleEvidence | undefined): unknown {
    if (evidence === undefined) return null;
    return [
        evidence.schemaVersion,
        evidence.direction,
        evidence.claimId,
        evidence.permitId,
        evidence.dispatchSeq,
        evidence.reconcileGeneration,
        evidence.evidenceHash,
    ];
}

function persistedClaimStateHash(claim: PersistedClaimState): string {
    return sha256(JSON.stringify([
        claim.schemaVersion,
        claim.claimId,
        claim.permitId,
        claim.taskId,
        claim.recordId,
        claim.unitId,
        claim.dispatchSeq,
        claim.disposition,
        claim.lifecycleDirection ?? null,
        claim.reconcileGeneration ?? null,
        claim.lifecycleError ?? null,
        claim.reconcileRequired,
        evidenceState(claim.releaseEvidence),
        evidenceState(claim.transferEvidence),
        claim.attemptId ?? null,
        claim.dispatchPhase ?? null,
        claim.providerAdmission ?? null,
        claim.providerEvidence ?? null,
        providerLeaseIdentityState(claim.providerLeaseIdentity),
    ]));
}

function providerLeaseIdentityState(identity: ProviderLeaseIdentity | undefined): unknown {
    if (identity === undefined) return null;
    return [
        identity.provider,
        identity.trafficClass,
        identity.attemptId,
        identity.leaseId,
        identity.ownerEpoch,
        identity.capacityGeneration,
        identity.acquiredAt,
        identity.expiresAt,
    ];
}

function cloneProviderLeaseIdentity(identity: ProviderLeaseIdentity | undefined): ProviderLeaseIdentity | undefined {
    return identity === undefined ? undefined : { ...identity };
}

function sameProviderLeaseIdentity(left: ProviderLeaseIdentity | undefined, right: ProviderLeaseIdentity | undefined): boolean {
    return providerLeaseIdentityState(left) !== null
        ? JSON.stringify(providerLeaseIdentityState(left)) === JSON.stringify(providerLeaseIdentityState(right))
        : providerLeaseIdentityState(right) === null;
}

function isValidProviderLeaseIdentity(value: unknown): value is ProviderLeaseIdentity {
    if (typeof value !== "object" || value === null) return false;
    const identity = value as Partial<ProviderLeaseIdentity>;
    return (identity.provider === "grok" || identity.provider === "agy")
        && (identity.trafficClass === "foreground" || identity.trafficClass === "record"
            || identity.trafficClass === "agy-first-run-overflow" || identity.trafficClass === "agy-fallback")
        && typeof identity.attemptId === "string" && identity.attemptId.length > 0
        && typeof identity.leaseId === "string" && identity.leaseId.length > 0
        && Number.isSafeInteger(identity.ownerEpoch) && (identity.ownerEpoch ?? -1) >= 0
        && Number.isSafeInteger(identity.capacityGeneration) && (identity.capacityGeneration ?? -1) >= 0
        && Number.isFinite(identity.acquiredAt) && (identity.acquiredAt ?? -1) >= 0
        && Number.isFinite(identity.expiresAt) && (identity.expiresAt ?? -1) >= (identity.acquiredAt ?? Number.POSITIVE_INFINITY);
}

function cloneLifecycleEvidence(
    evidence: RecordSchedulerCoordinatorLifecycleEvidence | undefined,
): RecordSchedulerCoordinatorLifecycleEvidence | undefined {
    return evidence === undefined ? undefined : { ...evidence };
}

function cloneCandidate(candidate: Readonly<FairnessCandidate>): FairnessCandidate {
    return {
        ...candidate,
        factors: { ...candidate.factors },
    };
}

function cloneRecipe(recipe: RecordSchedulerPromptRecipe): RecordSchedulerPromptRecipe {
    return {
        sourceSnapshotId: recipe.sourceSnapshotId,
        sourceSpool: { ...recipe.sourceSpool },
        recipe: { ...recipe.recipe },
    };
}

function hasPersistedDispatchReceipt(attempt: SchedulerAttemptLedger, taskId: string): boolean {
    return attempt.activeTaskIds.includes(taskId)
        && (attempt.state === "Dispatched" || (attempt.state === "DispatchIntentPersisted" && attempt.managedByProductionPump !== true))
        && attempt.dispatchIntentAt !== undefined
        && attempt.dispatchIntentLedgerRevision !== undefined
        && attempt.dispatchIntentRef !== undefined;
}

function hasUnknownOutcomeReceipt(attempt: SchedulerAttemptLedger, taskId: string): boolean {
    return attempt.managedByProductionPump !== true
        && attempt.originTaskIds.includes(taskId)
        && (attempt.state === "UnknownOutcome" || attempt.outcome === "unknown_outcome")
        && attempt.dispatchIntentAt !== undefined
        && attempt.dispatchIntentLedgerRevision !== undefined
        && attempt.dispatchIntentRef !== undefined;
}

function hasSettledProductionUnknownOutcome(attempt: SchedulerAttemptLedger, taskId: string): boolean {
    return attempt.managedByProductionPump === true
        && attempt.originTaskIds.includes(taskId)
        && attempt.state === "UnknownOutcome"
        && attempt.dispatchIntentAt !== undefined
        && attempt.dispatchIntentLedgerRevision !== undefined
        && attempt.dispatchIntentRef !== undefined
        && attempt.claimId !== undefined
        && attempt.permitId !== undefined
        && attempt.dispatchSeq !== undefined
        && attempt.dispatchPhase === "invoking"
        && attempt.providerAdmission !== undefined
        && attempt.providerEvidence !== undefined;
}

function projectTerminalStatus(unit: SchedulerUnitLedger): FairnessUnitStatus | undefined {
    if (unit.state === "Succeeded") return "done";
    if (unit.state === "Cancelled") return "cancelled";
    if (unit.state === "FailedFinal" || unit.state === "Discarded" || unit.state === "Superseded") return "failed";
    return undefined;
}

function isCandidateState(unit: SchedulerUnitLedger): boolean {
    return unit.state === "Materialized" || unit.state === "Blocked" || unit.state === "Queued" || unit.state === "WaitingRetry";
}

export class RecordSchedulerCoordinator {
    private readonly clock: RecordSchedulerQueueClock;
    private readonly timer?: RecordSchedulerQueueTimer;
    private readonly fairnessConfig: RecordSchedulerFairnessConfigInput;
    private readonly maxMaterializedPrompts: number;
    private readonly materializePrompt: (recipe: RecordSchedulerPromptRecipe) => unknown;
    private readonly onWake?: (event: RecordSchedulerCoordinatorWakeEvent) => void;
    private readonly claims = new Map<string, InternalClaim>();
    private readonly resources: RecordSchedulerQueueResources = { memorySoftLimit: false, diskSoftLimit: false };
    private readonly callbackContext = new AsyncLocalStorage<CoordinatorCallbackContext>();
    private fairness: RecordSchedulerFairness;
    private queue: RecordSchedulerQueue;
    private ledgers: RecordSchedulerLedger[] = [];
    private evidenceByIdentity = new Map<string, AttemptClaimEvidence>();
    private recoveryIssues: RecordSchedulerCoordinatorRecoveryIssue[] = [];
    private lastObservedClockMs: number;
    private generation = 0;
    private reconcileGeneration = 0;
    private rebuilding = false;
    private stepInProgress = false;
    private disposed = false;
    private deferredWake?: RecordSchedulerQueueWakeReason;
    private operationChain: Promise<void> = Promise.resolve();

    public constructor(options: RecordSchedulerCoordinatorOptions = {}) {
        this.clock = options.clock ?? defaultClock;
        this.timer = options.timer;
        this.fairnessConfig = options.fairness ?? {};
        this.maxMaterializedPrompts = options.maxMaterializedPrompts ?? 32;
        if (!Number.isInteger(this.maxMaterializedPrompts) || this.maxMaterializedPrompts < 1) {
            throw new Error("maxMaterializedPrompts 必须是正整数");
        }
        this.materializePrompt = options.materializePrompt ?? (() => undefined);
        this.onWake = options.onWake;
        this.fairness = new RecordSchedulerFairness(this.fairnessConfig);
        this.lastObservedClockMs = this.clock.now();
        this.queue = this.createQueue();
    }

    public rebuild(ledgers: Iterable<RecordSchedulerLedger>, options: RecordSchedulerCoordinatorRebuildOptions = {}): Promise<void> {
        this.ensureNotReentrant("rebuild");
        const nextLedgers = [...ledgers].sort(compareLedger);
        this.generation += 1;
        this.reconcileGeneration += 1;
        return this.enqueueOperation(() => this.rebuildSerial(nextLedgers, options));
    }

    public reconcile(ledgers: Iterable<RecordSchedulerLedger>, options: RecordSchedulerCoordinatorRebuildOptions = {}): Promise<void> {
        this.ensureNotReentrant("reconcile");
        return this.rebuild(ledgers, options);
    }

    private async rebuildSerial(ledgers: RecordSchedulerLedger[], options: RecordSchedulerCoordinatorRebuildOptions): Promise<void> {
        this.ensureNotDisposed();
        const restartElapsedMs = options.restartElapsedMs ?? 0;
        if (!Number.isFinite(restartElapsedMs) || restartElapsedMs < 0) throw new Error("restartElapsedMs 必须是非负有限数");
        if (options.snapshot !== undefined && options.snapshot.version !== RECORD_SCHEDULER_COORDINATOR_STATE_VERSION) {
            throw new Error("Unsupported record scheduler coordinator snapshot version");
        }
        const assessment = this.assessLedgerRecovery(ledgers);
        const reconciled = await this.reconcileClaims(assessment, options.snapshot, ledgers);
        const carriedFairness = options.snapshot?.fairness ?? this.fairness.snapshot();
        this.rebuilding = true;
        try {
            this.ledgers = ledgers;
            this.claims.clear();
            for (const [key, claim] of reconciled.claims) this.claims.set(key, claim);
            this.evidenceByIdentity = assessment.evidenceByIdentity;
            this.recoveryIssues = [...assessment.issues, ...reconciled.issues];
            this.queue.dispose();
            this.queue = this.createQueue();
            this.queue.rebuild(this.ledgers);
            this.fairness = RecordSchedulerFairness.restore(
                this.projectFairnessSnapshot(carriedFairness),
                this.fairnessConfig,
                restartElapsedMs,
            );
            this.lastObservedClockMs = this.clock.now();
            this.generation += 1;
        } finally {
            this.rebuilding = false;
        }
        this.emitWake("rebuild");
    }

    public setResources(resources: Partial<RecordSchedulerQueueResources>): void {
        this.ensureNotReentrant("setResources");
        this.resources.memorySoftLimit = resources.memorySoftLimit ?? this.resources.memorySoftLimit;
        this.resources.diskSoftLimit = resources.diskSoftLimit ?? this.resources.diskSoftLimit;
        this.generation += 1;
        this.queue.setResources(resources);
    }

    public notifyProviderChanged(): void {
        this.ensureNotReentrant("notifyProviderChanged");
        this.generation += 1;
        this.queue.notifyProviderChanged();
    }

    public notifyDependenciesChanged(): void {
        this.ensureNotReentrant("notifyDependenciesChanged");
        this.generation += 1;
        this.queue.notifyDependenciesChanged();
    }

    public notifyDependencySucceeded(taskId: string, unitId: string): void {
        this.ensureNotReentrant("notifyDependencySucceeded");
        this.generation += 1;
        this.queue.notifyDependencySucceeded(taskId, unitId);
    }

    public notifyCancelled(taskId: string): void {
        this.ensureNotReentrant("notifyCancelled");
        this.generation += 1;
        this.queue.notifyCancelled(taskId);
    }

    public advance(elapsedMs: number): void {
        this.ensureNotReentrant("advance");
        if (this.stepInProgress) throw new Error("Cannot advance scheduler coordinator while a permit grant is in progress");
        this.fairness.advance(elapsedMs);
        this.lastObservedClockMs = Math.max(this.lastObservedClockMs + elapsedMs, this.clock.now());
        this.synchronizeFairness();
    }

    public snapshot(): RecordSchedulerCoordinatorSnapshot {
        if (!this.stepInProgress) {
            this.advanceToClock();
            this.synchronizeFairness();
        }
        return this.snapshotFromQueue(this.queue.snapshot());
    }

    public step(requestPermit: RecordSchedulerProviderPermitRequest): Promise<RecordSchedulerCoordinatorStepResult> {
        this.ensureNotReentrant("step");
        return this.enqueueOperation(() => this.stepSerial(requestPermit));
    }

    public settle(
        taskId: string,
        recordId: string,
        unitId: string,
        input: SettleUnitInput,
    ): Promise<void> {
        this.ensureNotReentrant("settle");
        return this.enqueueOperation(() => this.settleSerial(taskId, recordId, unitId, input));
    }

    public bindClaim(
        claim: Pick<RecordSchedulerCoordinatorClaim, "taskId" | "recordId" | "unitId">,
        binding: RecordSchedulerCoordinatorAttemptBinding,
    ): Promise<RecordSchedulerCoordinatorClaim> {
        this.ensureNotReentrant("bindClaim");
        return this.enqueueOperation(() => this.bindClaimSerial(claim, binding));
    }

    private async bindClaimSerial(
        identity: Pick<RecordSchedulerCoordinatorClaim, "taskId" | "recordId" | "unitId">,
        binding: RecordSchedulerCoordinatorAttemptBinding,
    ): Promise<RecordSchedulerCoordinatorClaim> {
        this.ensureNotDisposed();
        const claim = this.claims.get(identityKey(identity.taskId, identity.recordId, identity.unitId));
        if (!claim) throw new Error("Cannot bind missing coordinator claim");
        if (claim.claimId !== binding.claimId || claim.permitId !== binding.permitId || claim.dispatchSeq !== binding.dispatchSeq) {
            throw new Error("Coordinator claim binding does not match the active claim identity");
        }
        if (claim.attemptId !== undefined && claim.attemptId !== binding.attemptId) {
            throw new Error("Coordinator claim cannot be rebound to a different attempt");
        }
        if (claim.providerAdmission !== undefined && claim.providerAdmission !== binding.providerAdmission
            || claim.providerEvidence !== undefined && claim.providerEvidence !== binding.providerEvidence
            || !sameProviderLeaseIdentity(claim.providerLeaseIdentity, binding.providerLeaseIdentity)) {
            throw new Error("Coordinator claim provider binding does not match the granted permit");
        }
        if (binding.providerAdmission === "provider-transport" && !isValidProviderLeaseIdentity(binding.providerLeaseIdentity)) {
            throw new Error("Provider-transport claim binding requires a lease identity");
        }
        if (binding.providerAdmission !== "provider-transport" && binding.providerLeaseIdentity !== undefined) {
            throw new Error("Synthetic or local coordinator claim must not carry a provider lease identity");
        }
        const phaseAdvanceAllowed = claim.dispatchPhase === undefined
            || claim.dispatchPhase === "permit-granted"
            || claim.dispatchPhase === binding.dispatchPhase
            || (claim.dispatchPhase === "attempt-bound" && binding.dispatchPhase === "invoking");
        if (!phaseAdvanceAllowed) {
            throw new Error("Coordinator claim dispatch phase cannot move backwards or fork");
        }
        claim.attemptId = binding.attemptId;
        claim.dispatchPhase = binding.dispatchPhase;
        claim.providerAdmission = binding.providerAdmission;
        claim.providerEvidence = binding.providerEvidence;
        claim.providerLeaseIdentity = cloneProviderLeaseIdentity(binding.providerLeaseIdentity);
        return this.publicClaim(claim);
    }

    private async settleSerial(taskId: string, recordId: string, unitId: string, input: SettleUnitInput): Promise<void> {
        this.ensureNotDisposed();
        const key = identityKey(taskId, recordId, unitId);
        const claim = this.claims.get(key);
        let settleError: unknown;
        try {
            this.fairness.settleUnit(taskId, recordId, unitId, input);
        } catch (error) {
            settleError = error;
        }
        if (claim !== undefined) {
            const outcome = await this.releaseClaim(claim);
            if (outcome.status === "failure") this.retainLifecycleFailure(key, claim, outcome.result);
            else {
                this.clearLifecycleIssues(claim);
                this.claims.delete(key);
            }
        }
        this.generation += 1;
        this.emitWake("settled");
        if (settleError !== undefined) throw settleError;
    }

    public async settleClaim(claim: Pick<RecordSchedulerCoordinatorClaim, "taskId" | "recordId" | "unitId">, input: SettleUnitInput): Promise<void> {
        await this.settle(claim.taskId, claim.recordId, claim.unitId, input);
    }

    public drain(): Promise<RecordSchedulerCoordinatorDrainResult> {
        this.ensureNotReentrant("drain");
        return this.enqueueOperation(() => this.drainSerial());
    }

    public dispose(): Promise<RecordSchedulerCoordinatorDrainResult> {
        this.ensureNotReentrant("dispose");
        return this.drain();
    }

    private async drainSerial(): Promise<RecordSchedulerCoordinatorDrainResult> {
        if (this.disposed) return this.emptyDrainResult(true);
        const successes: RecordSchedulerCoordinatorLifecycleSuccess[] = [];
        const failures: RecordSchedulerCoordinatorLifecycleFailure[] = [];
        const recoveryRequiredClaims: RecordSchedulerCoordinatorPersistedClaim[] = [];
        for (const [key, claim] of [...this.claims]) {
            const hasEvidence = this.evidenceByIdentity.has(key);
            if (claim.reconcileRequired) {
                this.retainClaimIssue(key, claim, this.reconcileRequiredIssue(claim));
                continue;
            }
            const direction = claim.lifecycleDirection ?? (hasEvidence ? "transfer" : "release");
            if (direction === "release") {
                if (claim.disposition === "released") {
                    if (hasEvidence) {
                        recoveryRequiredClaims.push(this.persistedClaim(claim));
                        this.retainClaimIssue(key, claim, this.directionMismatchIssue(claim, true));
                    } else {
                        this.clearLifecycleIssues(claim);
                        this.claims.delete(key);
                    }
                    continue;
                }
                const outcome = await this.releaseClaim(claim);
                if (outcome.status === "success") {
                    successes.push(outcome.result);
                    this.clearLifecycleIssues(claim);
                    if (outcome.reconcileRequired) {
                        this.retainClaimIssue(key, claim, this.reconcileRequiredIssue(claim));
                    } else if (hasEvidence) {
                        recoveryRequiredClaims.push(this.persistedClaim(claim));
                        this.retainClaimIssue(key, claim, this.directionMismatchIssue(claim, true));
                    } else {
                        this.claims.delete(key);
                    }
                } else if (outcome.status === "failure") {
                    failures.push(outcome.result);
                    this.retainLifecycleFailure(key, claim, outcome.result);
                }
                continue;
            }
            if (claim.disposition === "recovery") {
                if (!hasEvidence) this.claims.delete(key);
                continue;
            }
            if (claim.transferToRecovery !== undefined) {
                const outcome = await this.transferClaim(claim);
                if (outcome.status === "success") {
                    successes.push(outcome.result);
                    this.clearLifecycleIssues(claim);
                    claim.materialized = false;
                    claim.prompt = undefined;
                    if (outcome.reconcileRequired) {
                        this.retainClaimIssue(key, claim, this.reconcileRequiredIssue(claim));
                    } else if (!hasEvidence) {
                        this.claims.delete(key);
                    }
                } else if (outcome.status === "failure") {
                    failures.push(outcome.result);
                    this.retainLifecycleFailure(key, claim, outcome.result);
                }
            } else {
                claim.lifecycleDirection = "transfer";
                claim.reconcileGeneration ??= this.reconcileGeneration;
                claim.disposition = "recovery-required";
                claim.reconcileRequired = false;
                claim.materialized = false;
                claim.prompt = undefined;
                recoveryRequiredClaims.push(this.persistedClaim(claim));
                this.retainClaimIssue(key, claim, this.recoveryRequiredIssue(claim));
            }
        }
        const pendingClaimCount = [...this.claims.values()].filter(claim => claim.reconcileRequired
            || claim.disposition === "active"
            || claim.disposition === "releasing"
            || claim.disposition === "release-failed"
            || claim.disposition === "transferring"
            || claim.disposition === "transfer-failed").length;
        const complete = failures.length === 0 && pendingClaimCount === 0;
        if (complete) {
            this.claims.clear();
            this.queue.dispose();
            this.disposed = true;
        }
        return {
            complete,
            releasedClaimCount: successes.filter(success => success.action === "release").length,
            transferredClaimCount: successes.filter(success => success.action === "transfer").length,
            successes,
            failures,
            recoveryRequiredClaims,
        };
    }

    private createQueue(): RecordSchedulerQueue {
        return new RecordSchedulerQueue({
            clock: this.clock,
            timer: this.timer,
            mode: "eligibility-only",
            onWake: reason => this.handleQueueWake(reason),
        });
    }

    private async stepSerial(requestPermit: RecordSchedulerProviderPermitRequest): Promise<RecordSchedulerCoordinatorStepResult> {
        this.ensureNotDisposed();
        this.stepInProgress = true;
        try {
            this.advanceToClock();
            this.synchronizeFairness();
            const queueSnapshot = this.queue.snapshot();
            if (this.recoveryIssues.length > 0) {
                return this.waitingResult("repair-required", queueSnapshot);
            }
            if (this.resources.memorySoftLimit || this.resources.diskSoftLimit) {
                return this.waitingResult("waiting-resource", queueSnapshot);
            }
            if (this.claims.size >= this.maxMaterializedPrompts) {
                return this.waitingResult("waiting-prompt-window", queueSnapshot);
            }
            const eligibleByIdentity = new Map(
                this.queue.getEligibleUnits().map(unit => [identityKey(unit.taskId, unit.recordId, unit.unitId), unit]),
            );
            if (eligibleByIdentity.size === 0) return this.waitingResult("no-eligible", this.queue.snapshot());
            const selectionGeneration = this.generation;
            let deniedReason: "waiting-provider" | "prompt-unavailable" | "candidate-stale" | "waiting-prompt-window" | "waiting-resource" = "waiting-provider";
            let dispatchedClaim: InternalClaim | undefined;
            let grant: FairnessGrantResult;
            try {
                grant = await this.fairness.grantNext(async candidate => {
                    const key = identityKey(candidate.taskId, candidate.recordId, candidate.unitId);
                    const unit = eligibleByIdentity.get(key);
                    if (unit?.promptRecipe === undefined || this.claims.size >= this.maxMaterializedPrompts) {
                        deniedReason = unit === undefined ? "candidate-stale" : "waiting-prompt-window";
                        return false;
                    }
                    const permit = normalizePermit(await this.invokeExternalCallback(
                        "permit",
                        key,
                        () => requestPermit(candidate),
                    ));
                    if (!permit.granted) {
                        deniedReason = "waiting-provider";
                        return { granted: false, continueHandoff: true };
                    }
                    const claimId = randomUUID();
                    const permitClaim: InternalClaim = {
                        claimId,
                        permitId: permit.permitId === undefined || permit.permitId.trim().length === 0 ? claimId : permit.permitId,
                        taskId: candidate.taskId,
                        recordId: candidate.recordId,
                        unitId: candidate.unitId,
                        candidate: cloneCandidate(candidate),
                        dispatchSeq: 0,
                        recipe: cloneRecipe(unit.promptRecipe),
                        prompt: undefined,
                        releaseProvider: permit.release,
                        transferToRecovery: permit.transferToRecovery,
                        recovered: false,
                        materialized: false,
                        disposition: "active",
                        reconcileRequired: false,
                        attemptId: permit.attemptId,
                        dispatchPhase: permit.dispatchPhase,
                        providerAdmission: permit.providerAdmission,
                        providerEvidence: permit.providerEvidence,
                        providerLeaseIdentity: cloneProviderLeaseIdentity(permit.providerLeaseIdentity),
                    };
                    const ineligibleReason = this.postPermitIneligibleReason(unit, selectionGeneration);
                    if (ineligibleReason !== undefined) {
                        deniedReason = ineligibleReason;
                        const outcome = await this.releaseClaim(permitClaim);
                        if (outcome.status === "failure") this.retainLifecycleFailure(key, permitClaim, outcome.result);
                        return false;
                    }
                    try {
                        permitClaim.prompt = this.invokeExternalSync(
                            "materialize",
                            claimId,
                            () => this.materializePrompt(unit.promptRecipe!),
                        );
                        permitClaim.materialized = true;
                        dispatchedClaim = permitClaim;
                        return true;
                    } catch {
                        deniedReason = "prompt-unavailable";
                        const outcome = await this.releaseClaim(permitClaim);
                        if (outcome.status === "failure") this.retainLifecycleFailure(key, permitClaim, outcome.result);
                        return false;
                    }
                });
            } catch (error) {
                if (dispatchedClaim !== undefined) {
                    const key = identityKey(dispatchedClaim.taskId, dispatchedClaim.recordId, dispatchedClaim.unitId);
                    const outcome = await this.releaseClaim(dispatchedClaim);
                    if (outcome.status === "failure") this.retainLifecycleFailure(key, dispatchedClaim, outcome.result);
                }
                throw error;
            }
            if (!grant.granted) return this.waitingResult(deniedReason, this.queue.snapshot());
            if (dispatchedClaim === undefined) throw new Error("Fairness granted a permit without a coordinator claim");
            dispatchedClaim.dispatchSeq = grant.dispatchSeq;
            this.claims.set(identityKey(dispatchedClaim.taskId, dispatchedClaim.recordId, dispatchedClaim.unitId), dispatchedClaim);
            return {
                dispatched: true,
                claim: this.publicClaim(dispatchedClaim),
            };
        } finally {
            this.stepInProgress = false;
            if (this.deferredWake !== undefined) {
                const reason = this.deferredWake;
                this.deferredWake = undefined;
                this.handleQueueWake(reason);
            }
        }
    }

    private waitingResult(
        reason: Extract<RecordSchedulerCoordinatorStepResult, { dispatched: false }>['reason'],
        queueSnapshot: RecordSchedulerQueueSnapshot,
    ): Extract<RecordSchedulerCoordinatorStepResult, { dispatched: false }> {
        return {
            dispatched: false,
            reason,
            nextWakeAt: queueSnapshot.nextWakeAt,
            waitingReasons: queueSnapshot.waitingReasons,
        };
    }

    private handleQueueWake(reason: RecordSchedulerQueueWakeReason): void {
        if (this.rebuilding) return;
        if (this.stepInProgress) {
            this.deferredWake = reason;
            return;
        }
        this.advanceToClock();
        this.synchronizeFairness();
        this.generation += 1;
        this.emitWake(reason);
    }

    private emitWake(reason: RecordSchedulerQueueWakeReason | "settled"): void {
        if (this.onWake === undefined) return;
        const snapshot = this.queue.snapshot();
        this.onWake({
            reason,
            nextWakeAt: snapshot.nextWakeAt,
            waitingReasons: snapshot.waitingReasons,
        });
    }

    private advanceToClock(): void {
        const now = this.clock.now();
        if (!Number.isFinite(now)) throw new Error("Coordinator clock must return a finite number");
        if (now <= this.lastObservedClockMs) return;
        this.fairness.advance(now - this.lastObservedClockMs);
        this.lastObservedClockMs = now;
    }

    private synchronizeFairness(): void {
        if (this.stepInProgress) return;
        this.fairness = RecordSchedulerFairness.restore(
            this.projectFairnessSnapshot(this.fairness.snapshot()),
            this.fairnessConfig,
        );
    }

    private projectFairnessSnapshot(previous: Readonly<RecordSchedulerFairnessSnapshot>): RecordSchedulerFairnessSnapshot {
        const previousRecords = new Map(previous.records.map(record => [this.recordKey(record.taskId, record.recordId), record]));
        const eligible = new Set(this.queue.getEligibleUnits().map(unit => identityKey(unit.taskId, unit.recordId, unit.unitId)));
        const records: FairnessRecordSnapshot[] = [];
        for (const ledger of this.ledgers) {
            const attemptFailures = this.failureCounts(ledger);
            const unitsByRecord = new Map<string, SchedulerUnitLedger[]>();
            for (const unit of ledger.units) {
                const bucket = unitsByRecord.get(unit.recordId) ?? [];
                bucket.push(unit);
                unitsByRecord.set(unit.recordId, bucket);
            }
            for (const [recordId, units] of [...unitsByRecord.entries()].sort(([left], [right]) => compareText(left, right))) {
                const oldRecord = previousRecords.get(this.recordKey(ledger.task.taskId, recordId));
                const oldUnits = new Map((oldRecord?.units ?? []).map(unit => [unit.unitId, unit]));
                const projectedUnits = [...units]
                    .sort(compareUnit)
                    .map(unit => this.projectUnit(ledger, unit, oldUnits.get(unit.unitId), eligible, attemptFailures.get(unit.unitId) ?? 0));
                const newlyCharged = projectedUnits.reduce((total, unit) => {
                    const old = oldUnits.get(unit.unitId);
                    return total + (unit.status === "running" && old?.status !== "running" ? unit.estimatedCost : 0);
                }, 0);
                records.push({
                    taskId: ledger.task.taskId,
                    recordId,
                    taskCreatedAt: finiteTimestamp(ledger.task.createdAt),
                    serviceDebt: (oldRecord?.serviceDebt ?? 0) + newlyCharged,
                    waitingCredit: oldRecord?.waitingCredit ?? 0,
                    cumulativeWaitingMs: oldRecord?.cumulativeWaitingMs ?? 0,
                    lastServedSeq: oldRecord?.lastServedSeq,
                    baselinePending: oldRecord?.baselinePending ?? true,
                    window: oldRecord?.window === undefined ? undefined : { ...oldRecord.window },
                    units: projectedUnits,
                });
            }
        }
        return {
            version: RECORD_SCHEDULER_FAIRNESS_STATE_VERSION,
            logicalNowMs: previous.logicalNowMs,
            dispatchSeq: previous.dispatchSeq,
            records,
        };
    }

    private projectUnit(
        ledger: RecordSchedulerLedger,
        unit: SchedulerUnitLedger,
        old: FairnessUnitSnapshot | undefined,
        eligible: ReadonlySet<string>,
        failureCount: number,
    ): FairnessUnitSnapshot {
        const key = identityKey(ledger.task.taskId, unit.recordId, unit.unitId);
        const claimed = (this.claims.get(key)?.dispatchSeq ?? 0) > 0;
        const terminal = projectTerminalStatus(unit);
        const status: FairnessUnitStatus = terminal
            ?? (claimed ? "running" : eligible.has(key) && isCandidateState(unit) ? "queued" : "failed");
        return {
            unitId: unit.unitId,
            layer: unit.layer,
            estimatedCost: unit.estimatedCost,
            dependencies: [],
            nextEligibleAt: timestampMs(unit.nextEligibleAt),
            enqueueAt: old?.enqueueAt ?? finiteTimestamp(unit.enqueueTime),
            layerEnteredAt: old?.layerEnteredAt ?? finiteTimestamp(unit.layerEnterTime),
            layerFailures: failureCount,
            totalFailures: failureCount,
            status,
            chargedCost: status === "running" ? old?.chargedCost ?? unit.estimatedCost : undefined,
            parentUnitId: unit.parentUnitId,
        };
    }

    private assessLedgerRecovery(ledgers: readonly RecordSchedulerLedger[]): LedgerRecoveryAssessment {
        const evidenceByIdentity = new Map<string, AttemptClaimEvidence>();
        const issues: RecordSchedulerCoordinatorRecoveryIssue[] = [];
        for (const ledger of ledgers) {
            const unitsById = new Map(ledger.units.map(unit => [unit.unitId, unit]));
            for (const attempt of ledger.attempts) {
                const kind = hasPersistedDispatchReceipt(attempt, ledger.task.taskId)
                    ? "active"
                    : hasUnknownOutcomeReceipt(attempt, ledger.task.taskId) ? "unknown" : undefined;
                if (kind === undefined) continue;
                const unit = unitsById.get(attempt.unitId);
                if (unit === undefined) {
                    issues.push({
                        code: "receipt-unit-state-mismatch",
                        taskId: ledger.task.taskId,
                        unitId: attempt.unitId,
                        detail: `Attempt ${attempt.attemptId} has persisted dispatch evidence but its Unit is missing`,
                    });
                    continue;
                }
                const expectedState = kind === "active" ? "Running" : "UnknownOutcome";
                if (unit.state !== expectedState) {
                    issues.push({
                        code: "receipt-unit-state-mismatch",
                        taskId: ledger.task.taskId,
                        unitId: unit.unitId,
                        detail: `Attempt ${attempt.attemptId} is ${kind} but Unit state is ${unit.state}, expected ${expectedState}`,
                    });
                }
                const key = identityKey(ledger.task.taskId, unit.recordId, unit.unitId);
                if (!evidenceByIdentity.has(key)) {
                    evidenceByIdentity.set(key, {
                        taskId: ledger.task.taskId,
                        recordId: unit.recordId,
                        unitId: unit.unitId,
                        attemptId: attempt.attemptId,
                        attempt,
                        kind,
                        unit,
                        ledger,
                    });
                }
            }
            for (const unit of ledger.units) {
                const key = identityKey(ledger.task.taskId, unit.recordId, unit.unitId);
                const evidence = evidenceByIdentity.get(key);
                if (unit.state === "Running" && evidence?.kind !== "active") {
                    issues.push({
                        code: "running-without-dispatch-receipt",
                        taskId: ledger.task.taskId,
                        unitId: unit.unitId,
                        detail: "Running Unit has no persisted DispatchIntent/Dispatched receipt",
                    });
                }
                const hasSettledPumpUnknown = ledger.attempts.some(attempt => attempt.unitId === unit.unitId
                    && hasSettledProductionUnknownOutcome(attempt, ledger.task.taskId));
                if (unit.state === "UnknownOutcome" && evidence?.kind !== "unknown" && !hasSettledPumpUnknown) {
                    issues.push({
                        code: "unknown-outcome-without-receipt",
                        taskId: ledger.task.taskId,
                        unitId: unit.unitId,
                        detail: "UnknownOutcome Unit has no persisted unknown-outcome receipt",
                    });
                }
            }
        }
        return { evidenceByIdentity, issues };
    }

    private async reconcileClaims(
        assessment: LedgerRecoveryAssessment,
        snapshot: Readonly<RecordSchedulerCoordinatorSnapshot> | undefined,
        ledgers: readonly RecordSchedulerLedger[],
    ): Promise<{ claims: Map<string, InternalClaim>; issues: RecordSchedulerCoordinatorRecoveryIssue[] }> {
        const claims = new Map<string, InternalClaim>();
        const issues: RecordSchedulerCoordinatorRecoveryIssue[] = [];
        const persistedClaims = new Map<string, Readonly<RecordSchedulerCoordinatorPersistedClaim>>();
        if (snapshot !== undefined) {
            const persistedRepairRequired = snapshot.activeClaims.some(claim => claim.reconcileRequired
                || claim.disposition === "releasing"
                || claim.disposition === "release-failed"
                || claim.disposition === "transferring"
                || claim.disposition === "transfer-failed"
                || claim.disposition === "recovery-required");
            const expectedRepairRequired = snapshot.recoveryIssues.length > 0 || persistedRepairRequired;
            if (snapshot.repairRequired !== expectedRepairRequired) {
                issues.push({
                    code: "snapshot-repair-state-mismatch",
                    taskId: ledgers[0]?.task.taskId ?? "<snapshot>",
                    detail: `snapshot repairRequired=${snapshot.repairRequired} does not match persisted repair evidence=${expectedRepairRequired}`,
                });
            }
            for (const persisted of snapshot.activeClaims) {
                const validationError = this.validatePersistedClaim(persisted);
                if (validationError !== undefined) {
                    issues.push({
                        code: "invalid-persisted-claim",
                        taskId: typeof persisted.taskId === "string" ? persisted.taskId : "<snapshot>",
                        unitId: typeof persisted.unitId === "string" ? persisted.unitId : undefined,
                        detail: validationError,
                    });
                    continue;
                }
                const key = identityKey(persisted.taskId, persisted.recordId, persisted.unitId);
                if (persistedClaims.has(key)) {
                    issues.push({
                        code: "invalid-persisted-claim",
                        taskId: persisted.taskId,
                        unitId: persisted.unitId,
                        detail: `duplicate persisted claim identity ${key}`,
                    });
                    persistedClaims.delete(key);
                    continue;
                }
                persistedClaims.set(key, persisted);
            }
        }
        for (const [key, claim] of this.claims) {
            const hasEvidence = assessment.evidenceByIdentity.has(key);
            claim.reconcileRequired = false;
            if (claim.disposition === "releasing") {
                claim.disposition = "release-failed";
                claim.lifecycleError = claim.lifecycleError ?? "release callback was interrupted before reconciliation";
            } else if (claim.disposition === "transferring") {
                claim.disposition = "transfer-failed";
                claim.lifecycleError = claim.lifecycleError ?? "transfer callback was interrupted before reconciliation";
            }
            if (claim.lifecycleDirection === "release") {
                if (claim.disposition === "released") {
                    if (hasEvidence) {
                        claims.set(key, claim);
                        issues.push(this.directionMismatchIssue(claim, true));
                    }
                    continue;
                }
                if (hasEvidence) {
                    claims.set(key, claim);
                    const lifecycleIssue = this.lifecycleIssueForClaim(claim);
                    if (lifecycleIssue !== undefined) issues.push(lifecycleIssue);
                    issues.push(this.directionMismatchIssue(claim, true));
                    continue;
                }
                const outcome = await this.releaseClaim(claim);
                if (outcome.status === "failure") {
                    claims.set(key, claim);
                    issues.push(this.lifecycleIssue(claim, outcome.result));
                } else if (outcome.status === "success" && outcome.reconcileRequired) {
                    claims.set(key, claim);
                    issues.push(this.reconcileRequiredIssue(claim));
                }
                continue;
            }
            if (claim.lifecycleDirection === "transfer") {
                if (claim.disposition === "recovery") {
                    if (hasEvidence) claims.set(key, claim);
                    continue;
                }
                claims.set(key, claim);
                const issue = this.lifecycleIssueForClaim(claim);
                if (issue !== undefined) issues.push(issue);
                continue;
            }
            if (hasEvidence) {
                claims.set(key, claim);
                continue;
            }
            const outcome = await this.releaseClaim(claim);
            if (outcome.status === "failure") {
                claims.set(key, claim);
                issues.push(this.lifecycleIssue(claim, outcome.result));
            } else if (outcome.status === "success" && outcome.reconcileRequired) {
                claims.set(key, claim);
                issues.push(this.reconcileRequiredIssue(claim));
            }
        }
        const missingEvidence = [...assessment.evidenceByIdentity.entries()].filter(([key]) => !claims.has(key));
        if (missingEvidence.length === 0) return { claims, issues };
        if (snapshot === undefined) {
            for (const [, evidence] of missingEvidence) {
                issues.push({
                    code: "missing-bound-fairness-snapshot",
                    taskId: evidence.taskId,
                    unitId: evidence.unitId,
                    detail: `Attempt ${evidence.attemptId} requires a ledger-bound fairness snapshot for cold recovery`,
                });
            }
            return { claims, issues };
        }
        const exactLedgerBindings = this.snapshotBindsLedgers(snapshot, ledgers);
        for (const [key, evidence] of missingEvidence) {
            const persisted = persistedClaims.get(key);
            if (persisted === undefined) {
                issues.push({
                    code: "missing-claim-dispatch-seq",
                    taskId: evidence.taskId,
                    unitId: evidence.unitId,
                    detail: `Attempt ${evidence.attemptId} has no persisted claim dispatchSeq`,
                });
                continue;
            }
            if (!exactLedgerBindings && !this.snapshotSafelyBindsAttempt(persisted, evidence)) {
                issues.push({
                    code: "ledger-binding-mismatch",
                    taskId: evidence.taskId,
                    unitId: evidence.unitId,
                    detail: `Attempt ${evidence.attemptId} is not covered by the supplied snapshot ledger binding or an explicit attempt-bound claim`,
                });
                continue;
            }
            if (!this.persistedClaimMatchesAttempt(persisted, evidence)) {
                issues.push({
                    code: "claim-attempt-binding-mismatch",
                    taskId: evidence.taskId,
                    unitId: evidence.unitId,
                    detail: `Attempt ${evidence.attemptId} does not bidirectionally match claim ${persisted.claimId}`,
                });
                continue;
            }
            if (!Number.isInteger(persisted.dispatchSeq)
                || persisted.dispatchSeq < 1
                || persisted.dispatchSeq > snapshot.fairness.dispatchSeq
                || persisted.claimId.length === 0
                || persisted.permitId.length === 0
                || !this.snapshotHasRunningUnit(snapshot.fairness, persisted)) {
                issues.push({
                    code: "invalid-claim-dispatch-seq",
                    taskId: evidence.taskId,
                    unitId: evidence.unitId,
                    detail: `Persisted dispatchSeq ${persisted.dispatchSeq} is not valid for fairness dispatchSeq ${snapshot.fairness.dispatchSeq}`,
                });
                continue;
            }
            const recovered = this.recoveredClaim(evidence, persisted);
            claims.set(key, recovered);
            const lifecycleIssue = this.lifecycleIssueForClaim(recovered);
            if (lifecycleIssue !== undefined) issues.push(lifecycleIssue);
            if (recovered.lifecycleDirection === "release") issues.push(this.directionMismatchIssue(recovered, true));
        }
        return { claims, issues };
    }

    private snapshotBindsLedgers(snapshot: Readonly<RecordSchedulerCoordinatorSnapshot>, ledgers: readonly RecordSchedulerLedger[]): boolean {
        const expected = this.ledgerBindings(ledgers);
        if (snapshot.ledgerBindings.length !== expected.length) return false;
        return expected.every((binding, index) => {
            const actual = snapshot.ledgerBindings[index];
            return actual !== undefined
                && actual.taskId === binding.taskId
                && actual.revision === binding.revision
                && actual.persistedHash === binding.persistedHash;
        });
    }

    private snapshotSafelyBindsAttempt(
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
        evidence: AttemptClaimEvidence,
    ): boolean {
        return claim.dispatchPhase === "attempt-bound" || claim.dispatchPhase === "invoking"
            ? this.persistedClaimMatchesAttempt(claim, evidence)
            : false;
    }

    private persistedClaimMatchesAttempt(
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
        evidence: AttemptClaimEvidence,
    ): boolean {
        const attempt = evidence.attempt;
        const hasExtendedBinding = claim.attemptId !== undefined
            || claim.dispatchPhase !== undefined
            || claim.providerAdmission !== undefined
            || claim.providerEvidence !== undefined;
        if (!hasExtendedBinding) return true;
        return claim.attemptId === evidence.attemptId
            && claim.claimId === attempt.claimId
            && claim.permitId === attempt.permitId
            && claim.dispatchSeq === attempt.dispatchSeq
            && claim.dispatchPhase === attempt.dispatchPhase
            && claim.providerAdmission === attempt.providerAdmission
            && claim.providerEvidence === attempt.providerEvidence
            && sameProviderLeaseIdentity(claim.providerLeaseIdentity, attempt.providerLeaseIdentity)
            && (attempt.dispatchPhase === "attempt-bound" || attempt.dispatchPhase === "invoking");
    }

    private snapshotHasRunningUnit(
        snapshot: Readonly<RecordSchedulerFairnessSnapshot>,
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    ): boolean {
        const record = snapshot.records.find(candidate => candidate.taskId === claim.taskId && candidate.recordId === claim.recordId);
        const unit = record?.units.find(candidate => candidate.unitId === claim.unitId);
        return unit?.status === "running" && unit.chargedCost !== undefined;
    }

    private recoveredClaim(
        evidence: AttemptClaimEvidence,
        persisted: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    ): InternalClaim {
        const interruptedRelease = persisted.disposition === "releasing";
        const interruptedTransfer = persisted.disposition === "transferring";
        const disposition: RecordSchedulerCoordinatorPersistedDisposition = interruptedRelease
            ? "release-failed"
            : interruptedTransfer ? "transfer-failed" : persisted.disposition;
        return {
            claimId: persisted.claimId,
            permitId: persisted.permitId,
            taskId: evidence.taskId,
            recordId: evidence.recordId,
            unitId: evidence.unitId,
            candidate: {
                ...this.candidateForRecoveredUnit(evidence.ledger, evidence.unit),
                factors: {
                    layerWait: 0,
                    taskAge: 0,
                    unitQueueCredit: 0,
                    sizeBonus: 0,
                    layerFailure: 0,
                    totalFailure: 0,
                    completionProgress: 0,
                },
            },
            dispatchSeq: persisted.dispatchSeq,
            recipe: this.recipeForUnit(evidence.ledger, evidence.unit),
            prompt: undefined,
            recovered: true,
            materialized: false,
            disposition,
            lifecycleDirection: persisted.lifecycleDirection,
            reconcileGeneration: persisted.reconcileGeneration,
            lifecycleError: interruptedRelease
                ? persisted.lifecycleError ?? "release callback was interrupted by restart"
                : interruptedTransfer ? persisted.lifecycleError ?? "transfer callback was interrupted by restart" : persisted.lifecycleError,
            reconcileRequired: false,
            releaseEvidence: cloneLifecycleEvidence(persisted.releaseEvidence),
            transferEvidence: cloneLifecycleEvidence(persisted.transferEvidence),
            attemptId: persisted.attemptId,
            dispatchPhase: persisted.dispatchPhase,
            providerAdmission: persisted.providerAdmission,
            providerEvidence: persisted.providerEvidence,
            providerLeaseIdentity: cloneProviderLeaseIdentity(persisted.providerLeaseIdentity),
        };
    }

    private candidateForRecoveredUnit(ledger: RecordSchedulerLedger, unit: SchedulerUnitLedger): Omit<FairnessCandidate, "factors"> {
        return {
            taskId: ledger.task.taskId,
            recordId: unit.recordId,
            unitId: unit.unitId,
            estimatedCost: unit.estimatedCost,
            outerScore: 0,
            innerScore: 0,
        };
    }

    private recipeForUnit(ledger: RecordSchedulerLedger, unit: SchedulerUnitLedger): RecordSchedulerPromptRecipe {
        const source = ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === unit.sourceSnapshotId);
        if (source === undefined) throw new Error(`Missing source snapshot for recovered Unit: ${ledger.task.taskId}/${unit.unitId}`);
        return {
            sourceSnapshotId: source.sourceSnapshotId,
            sourceSpool: { ...source.contentRef },
            recipe: {
                unitId: unit.unitId,
                layer: unit.layer,
                continuationKey: unit.continuationKey,
                composeOrder: unit.composeOrder,
                inputHash: unit.inputHash,
            },
        };
    }

    private failureCounts(ledger: RecordSchedulerLedger): Map<string, number> {
        const counts = new Map<string, number>();
        for (const attempt of ledger.attempts) {
            if (attempt.state !== "KnownFailure" && attempt.outcome !== "known_failure") continue;
            counts.set(attempt.unitId, (counts.get(attempt.unitId) ?? 0) + 1);
        }
        return counts;
    }

    private isStillEligible(unit: RecordSchedulerQueueUnitView): boolean {
        return this.queue.getEligibleUnits().some(candidate => candidate.taskId === unit.taskId
            && candidate.recordId === unit.recordId
            && candidate.unitId === unit.unitId);
    }

    private postPermitIneligibleReason(
        unit: RecordSchedulerQueueUnitView,
        selectionGeneration: number,
    ): "waiting-resource" | "candidate-stale" | undefined {
        if (this.resources.memorySoftLimit || this.resources.diskSoftLimit) return "waiting-resource";
        if (selectionGeneration !== this.generation || this.recoveryIssues.length > 0 || !this.isStillEligible(unit)) return "candidate-stale";
        return undefined;
    }

    private recordKey(taskId: string, recordId: string): string {
        return JSON.stringify([taskId, recordId]);
    }

    private snapshotFromQueue(queueSnapshot: RecordSchedulerQueueSnapshot): RecordSchedulerCoordinatorSnapshot {
        const activeClaims = [...this.claims.values()]
            .map(claim => this.persistedClaim(claim))
            .sort((left, right) => left.dispatchSeq - right.dispatchSeq || compareText(identityKey(left.taskId, left.recordId, left.unitId), identityKey(right.taskId, right.recordId, right.unitId)));
        const recoveryIssues = this.recoveryIssues.map(issue => ({ ...issue }));
        for (const claim of this.claims.values()) {
            const lifecycleIssue = this.lifecycleIssueForClaim(claim);
            if (lifecycleIssue !== undefined) this.appendUniqueIssue(recoveryIssues, lifecycleIssue);
            if (claim.lifecycleDirection === "release" && this.evidenceByIdentity.has(identityKey(claim.taskId, claim.recordId, claim.unitId))) {
                this.appendUniqueIssue(recoveryIssues, this.directionMismatchIssue(claim, true));
            }
        }
        return {
            version: RECORD_SCHEDULER_COORDINATOR_STATE_VERSION,
            fairness: this.fairness.snapshot(),
            ledgerBindings: this.ledgerBindings(this.ledgers),
            activeClaims,
            repairRequired: recoveryIssues.length > 0,
            recoveryIssues,
            logicalUnitCount: queueSnapshot.logicalUnitCount,
            activeClaimCount: this.claims.size,
            materializedPromptCount: [...this.claims.values()].filter(claim => claim.materialized).length,
            nextWakeAt: queueSnapshot.nextWakeAt,
            waitingReasons: queueSnapshot.waitingReasons,
        };
    }

    private publicClaim(claim: InternalClaim): RecordSchedulerCoordinatorClaim {
        return {
            claimId: claim.claimId,
            permitId: claim.permitId,
            taskId: claim.taskId,
            recordId: claim.recordId,
            unitId: claim.unitId,
            candidate: cloneCandidate(claim.candidate),
            dispatchSeq: claim.dispatchSeq,
            recipe: cloneRecipe(claim.recipe),
            prompt: claim.prompt,
            attemptId: claim.attemptId,
            dispatchPhase: claim.dispatchPhase,
            providerAdmission: claim.providerAdmission,
            providerEvidence: claim.providerEvidence,
            providerLeaseIdentity: cloneProviderLeaseIdentity(claim.providerLeaseIdentity),
        };
    }

    private ledgerBindings(ledgers: readonly RecordSchedulerLedger[]): RecordSchedulerCoordinatorLedgerBinding[] {
        return ledgers.map(ledger => ({
            taskId: ledger.task.taskId,
            revision: ledger.revision,
            persistedHash: ledger.persistedHash,
        })).sort((left, right) => compareText(left.taskId, right.taskId));
    }

    private persistedClaim(claim: InternalClaim): RecordSchedulerCoordinatorPersistedClaim {
        const state: PersistedClaimState = {
            schemaVersion: RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION,
            claimId: claim.claimId,
            permitId: claim.permitId,
            taskId: claim.taskId,
            recordId: claim.recordId,
            unitId: claim.unitId,
            dispatchSeq: claim.dispatchSeq,
            disposition: claim.disposition,
            lifecycleDirection: claim.lifecycleDirection,
            reconcileGeneration: claim.reconcileGeneration,
            lifecycleError: claim.lifecycleError,
            reconcileRequired: claim.reconcileRequired,
            releaseEvidence: cloneLifecycleEvidence(claim.releaseEvidence),
            transferEvidence: cloneLifecycleEvidence(claim.transferEvidence),
            attemptId: claim.attemptId,
            dispatchPhase: claim.dispatchPhase,
            providerAdmission: claim.providerAdmission,
            providerEvidence: claim.providerEvidence,
            providerLeaseIdentity: cloneProviderLeaseIdentity(claim.providerLeaseIdentity),
        };
        return { ...state, stateHash: persistedClaimStateHash(state) };
    }

    private createLifecycleEvidence(
        claim: InternalClaim,
        direction: RecordSchedulerCoordinatorLifecycleAction,
        reconcileGeneration: number,
    ): RecordSchedulerCoordinatorLifecycleEvidence {
        const state: LifecycleEvidenceState = {
            schemaVersion: RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION,
            direction,
            claimId: claim.claimId,
            permitId: claim.permitId,
            dispatchSeq: claim.dispatchSeq,
            reconcileGeneration,
        };
        return { ...state, evidenceHash: lifecycleEvidenceHash(state) };
    }

    private validatePersistedClaim(value: unknown): string | undefined {
        if (typeof value !== "object" || value === null) return "persisted claim must be an object";
        const claim = value as Partial<RecordSchedulerCoordinatorPersistedClaim>;
        if (claim.schemaVersion !== RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION) return "unsupported persisted claim schemaVersion";
        for (const [field, candidate] of [["claimId", claim.claimId], ["permitId", claim.permitId], ["taskId", claim.taskId], ["recordId", claim.recordId], ["unitId", claim.unitId]] as const) {
            if (typeof candidate !== "string" || candidate.length === 0) return `${field} must be a non-empty string`;
        }
        if (!Number.isInteger(claim.dispatchSeq) || (claim.dispatchSeq ?? -1) < 0) return "dispatchSeq must be a non-negative integer";
        const dispositions: readonly RecordSchedulerCoordinatorPersistedDisposition[] = [
            "active", "releasing", "release-failed", "released", "transferring", "transfer-failed", "recovery-required", "recovery",
        ];
        if (!dispositions.includes(claim.disposition as RecordSchedulerCoordinatorPersistedDisposition)) return "invalid claim disposition";
        if (claim.lifecycleDirection !== undefined && claim.lifecycleDirection !== "release" && claim.lifecycleDirection !== "transfer") return "invalid lifecycleDirection";
        if (claim.reconcileGeneration !== undefined && (!Number.isInteger(claim.reconcileGeneration) || claim.reconcileGeneration < 0)) return "invalid reconcileGeneration";
        if (claim.lifecycleError !== undefined && (typeof claim.lifecycleError !== "string" || claim.lifecycleError.length === 0)) return "invalid lifecycleError";
        if (typeof claim.reconcileRequired !== "boolean") return "reconcileRequired must be boolean";
        const hasAttemptBinding = claim.attemptId !== undefined || claim.dispatchPhase !== undefined
            || claim.providerAdmission !== undefined || claim.providerEvidence !== undefined || claim.providerLeaseIdentity !== undefined;
        if (hasAttemptBinding) {
            if (typeof claim.attemptId !== "string" || claim.attemptId.length === 0
                || !["permit-granted", "attempt-bound", "invoking"].includes(claim.dispatchPhase as SchedulerAttemptDispatchPhase)
                || !["provider-transport", "synthetic", "local"].includes(claim.providerAdmission as SchedulerAttemptAdmission)
                || typeof claim.providerEvidence !== "string" || claim.providerEvidence.length === 0) {
                return "incomplete persisted attempt claim binding";
            }
            if (claim.providerAdmission === "provider-transport") {
                if (!isValidProviderLeaseIdentity(claim.providerLeaseIdentity)
                    || claim.providerLeaseIdentity.attemptId !== claim.attemptId
                    || claim.providerLeaseIdentity.leaseId !== claim.permitId) {
                    return "provider-transport claim is missing or contradicts its lease identity";
                }
            } else if (claim.providerLeaseIdentity !== undefined) {
                return "non-provider coordinator claim carries a provider lease identity";
            }
        }
        if (typeof claim.stateHash !== "string" || !/^[a-f0-9]{64}$/.test(claim.stateHash)) return "invalid stateHash";
        const typed = claim as RecordSchedulerCoordinatorPersistedClaim;
        if (persistedClaimStateHash(typed) !== typed.stateHash) return "persisted claim stateHash mismatch";
        const releaseEvidenceError = this.validateLifecycleEvidence(typed.releaseEvidence, "release", typed);
        if (releaseEvidenceError !== undefined) return releaseEvidenceError;
        const transferEvidenceError = this.validateLifecycleEvidence(typed.transferEvidence, "transfer", typed);
        if (transferEvidenceError !== undefined) return transferEvidenceError;
        const hasGeneration = typed.reconcileGeneration !== undefined;
        switch (typed.disposition) {
            case "active":
                if (typed.lifecycleDirection !== undefined || hasGeneration || typed.lifecycleError !== undefined || typed.releaseEvidence !== undefined || typed.transferEvidence !== undefined) return "active claim carries lifecycle state";
                break;
            case "releasing":
                if (typed.lifecycleDirection !== "release" || !hasGeneration || typed.lifecycleError !== undefined || typed.releaseEvidence !== undefined || typed.transferEvidence !== undefined) return "invalid releasing claim state";
                break;
            case "release-failed":
                if (typed.lifecycleDirection !== "release" || !hasGeneration || typed.lifecycleError === undefined || typed.releaseEvidence !== undefined || typed.transferEvidence !== undefined) return "invalid release-failed claim state";
                break;
            case "released":
                if (typed.lifecycleDirection !== "release" || !hasGeneration || typed.lifecycleError !== undefined || typed.releaseEvidence === undefined || typed.transferEvidence !== undefined) return "invalid released claim state";
                break;
            case "transferring":
                if (typed.lifecycleDirection !== "transfer" || !hasGeneration || typed.lifecycleError !== undefined || typed.releaseEvidence !== undefined || typed.transferEvidence !== undefined) return "invalid transferring claim state";
                break;
            case "transfer-failed":
                if (typed.lifecycleDirection !== "transfer" || !hasGeneration || typed.lifecycleError === undefined || typed.releaseEvidence !== undefined || typed.transferEvidence !== undefined) return "invalid transfer-failed claim state";
                break;
            case "recovery-required":
                if (typed.lifecycleDirection !== "transfer" || !hasGeneration || typed.releaseEvidence !== undefined || typed.transferEvidence !== undefined) return "invalid recovery-required claim state";
                break;
            case "recovery":
                if (typed.lifecycleDirection !== "transfer" || !hasGeneration || typed.lifecycleError !== undefined || typed.releaseEvidence !== undefined || typed.transferEvidence === undefined) return "invalid recovery claim state";
                break;
        }
        return undefined;
    }

    private validateLifecycleEvidence(
        value: unknown,
        direction: RecordSchedulerCoordinatorLifecycleAction,
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    ): string | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== "object" || value === null) return `${direction} evidence must be an object`;
        const evidence = value as Partial<RecordSchedulerCoordinatorLifecycleEvidence>;
        if (evidence.schemaVersion !== RECORD_SCHEDULER_COORDINATOR_CLAIM_STATE_VERSION
            || evidence.direction !== direction
            || evidence.claimId !== claim.claimId
            || evidence.permitId !== claim.permitId
            || evidence.dispatchSeq !== claim.dispatchSeq
            || evidence.reconcileGeneration !== claim.reconcileGeneration
            || !Number.isInteger(evidence.reconcileGeneration)
            || (evidence.reconcileGeneration ?? -1) < 0
            || typeof evidence.evidenceHash !== "string") return `invalid ${direction} evidence binding`;
        const typed = evidence as RecordSchedulerCoordinatorLifecycleEvidence;
        if (lifecycleEvidenceHash(typed) !== typed.evidenceHash) return `${direction} evidenceHash mismatch`;
        return undefined;
    }

    private async releaseClaim(claim: InternalClaim): Promise<ClaimLifecycleOutcome> {
        if (claim.disposition === "released") return { status: "noop" };
        if (claim.lifecycleDirection !== undefined && claim.lifecycleDirection !== "release") {
            return this.lifecycleFailure("release", claim, `claim direction is irreversibly ${claim.lifecycleDirection}`);
        }
        if (claim.disposition !== "active" && claim.disposition !== "release-failed") {
            return this.lifecycleFailure("release", claim, `claim is ${claim.disposition}, not releasable`);
        }
        claim.lifecycleDirection = "release";
        claim.reconcileGeneration = this.reconcileGeneration;
        claim.reconcileRequired = false;
        claim.materialized = false;
        claim.prompt = undefined;
        claim.disposition = "releasing";
        claim.lifecycleError = undefined;
        const preparedGeneration = this.reconcileGeneration;
        const persisted = Object.freeze(this.persistedClaim(claim));
        try {
            if (claim.releaseProvider !== undefined) {
                await this.invokeExternalCallback(
                    "release",
                    claim.claimId,
                    () => claim.releaseProvider!(persisted),
                );
            }
            if (claim.disposition !== "releasing") {
                const detail = `release result lost its irreversible claim state while disposition is ${claim.disposition}`;
                claim.disposition = "release-failed";
                claim.lifecycleError = detail;
                claim.reconcileRequired = preparedGeneration !== this.reconcileGeneration;
                return this.lifecycleFailure("release", claim, detail);
            }
            claim.releaseEvidence = this.createLifecycleEvidence(claim, "release", preparedGeneration);
            claim.disposition = "released";
            claim.lifecycleError = undefined;
            claim.reconcileRequired = preparedGeneration !== this.reconcileGeneration;
            return {
                status: "success",
                result: { action: "release", claim: this.persistedClaim(claim) },
                reconcileRequired: claim.reconcileRequired,
            };
        } catch (error) {
            const detail = errorMessage(error);
            if (claim.disposition === "releasing") claim.disposition = "release-failed";
            claim.lifecycleError = detail;
            claim.reconcileRequired = preparedGeneration !== this.reconcileGeneration;
            return this.lifecycleFailure("release", claim, detail);
        }
    }

    private async transferClaim(claim: InternalClaim): Promise<ClaimLifecycleOutcome> {
        if (claim.disposition === "recovery") return { status: "noop" };
        if (claim.lifecycleDirection !== undefined && claim.lifecycleDirection !== "transfer") {
            return this.lifecycleFailure("transfer", claim, `claim direction is irreversibly ${claim.lifecycleDirection}`);
        }
        if (claim.transferToRecovery === undefined) {
            return this.lifecycleFailure("transfer", claim, "claim has no recovery transfer callback");
        }
        if (claim.disposition !== "active" && claim.disposition !== "transfer-failed") {
            return this.lifecycleFailure("transfer", claim, `claim is ${claim.disposition}, not transferable`);
        }
        claim.lifecycleDirection = "transfer";
        claim.reconcileGeneration = this.reconcileGeneration;
        claim.reconcileRequired = false;
        claim.materialized = false;
        claim.prompt = undefined;
        claim.disposition = "transferring";
        claim.lifecycleError = undefined;
        const preparedGeneration = this.reconcileGeneration;
        const persisted = Object.freeze(this.persistedClaim(claim));
        try {
            await this.invokeExternalCallback(
                "transfer",
                claim.claimId,
                () => claim.transferToRecovery!(persisted),
            );
            if (claim.disposition !== "transferring") {
                const detail = `transfer result lost its irreversible claim state while disposition is ${claim.disposition}`;
                claim.disposition = "transfer-failed";
                claim.lifecycleError = detail;
                claim.reconcileRequired = preparedGeneration !== this.reconcileGeneration;
                return this.lifecycleFailure("transfer", claim, detail);
            }
            claim.transferEvidence = this.createLifecycleEvidence(claim, "transfer", preparedGeneration);
            claim.disposition = "recovery";
            claim.lifecycleError = undefined;
            claim.reconcileRequired = preparedGeneration !== this.reconcileGeneration;
            return {
                status: "success",
                result: { action: "transfer", claim: this.persistedClaim(claim) },
                reconcileRequired: claim.reconcileRequired,
            };
        } catch (error) {
            const detail = errorMessage(error);
            if (claim.disposition === "transferring") claim.disposition = "transfer-failed";
            claim.lifecycleError = detail;
            claim.reconcileRequired = preparedGeneration !== this.reconcileGeneration;
            return this.lifecycleFailure("transfer", claim, detail);
        }
    }

    private lifecycleFailure(
        action: RecordSchedulerCoordinatorLifecycleAction,
        claim: InternalClaim,
        error: string,
    ): Extract<ClaimLifecycleOutcome, { status: "failure" }> {
        return {
            status: "failure",
            result: {
                action,
                claim: this.persistedClaim(claim),
                error,
                retryable: true,
            },
        };
    }

    private retainLifecycleFailure(
        key: string,
        claim: InternalClaim,
        failure: RecordSchedulerCoordinatorLifecycleFailure,
    ): void {
        this.retainClaimIssue(key, claim, this.lifecycleIssue(claim, failure));
    }

    private retainClaimIssue(
        key: string,
        claim: InternalClaim,
        issue: RecordSchedulerCoordinatorRecoveryIssue,
    ): void {
        this.claims.set(key, claim);
        this.clearLifecycleIssues(claim);
        this.recoveryIssues.push(issue);
    }

    private lifecycleIssue(
        claim: InternalClaim,
        failure: RecordSchedulerCoordinatorLifecycleFailure,
    ): RecordSchedulerCoordinatorRecoveryIssue {
        return {
            code: failure.action === "release" ? "claim-release-failed" : "claim-transfer-failed",
            taskId: claim.taskId,
            unitId: claim.unitId,
            detail: `${failure.action} failed for claim ${claim.claimId} / permit ${claim.permitId}: ${failure.error}`,
        };
    }

    private lifecycleIssueForClaim(claim: InternalClaim): RecordSchedulerCoordinatorRecoveryIssue | undefined {
        if (claim.disposition === "releasing" || claim.disposition === "transferring") {
            return {
                code: "claim-reconcile-required",
                taskId: claim.taskId,
                unitId: claim.unitId,
                detail: `Claim ${claim.claimId} snapshot captured ${claim.disposition} callback in progress`,
            };
        }
        if (claim.reconcileRequired) return this.reconcileRequiredIssue(claim);
        if (claim.disposition === "recovery-required") return this.recoveryRequiredIssue(claim);
        if (claim.disposition !== "release-failed" && claim.disposition !== "transfer-failed") return undefined;
        const action = claim.disposition === "release-failed" ? "release" : "transfer";
        return this.lifecycleIssue(claim, {
            action,
            claim: this.persistedClaim(claim),
            error: claim.lifecycleError ?? `${action} requires retry`,
            retryable: true,
        });
    }

    private reconcileRequiredIssue(claim: InternalClaim): RecordSchedulerCoordinatorRecoveryIssue {
        return {
            code: "claim-reconcile-required",
            taskId: claim.taskId,
            unitId: claim.unitId,
            detail: `Claim ${claim.claimId} completed ${claim.lifecycleDirection ?? "unknown"} against reconcile generation ${claim.reconcileGeneration ?? "unknown"} and requires ledger reconciliation`,
        };
    }

    private directionMismatchIssue(claim: InternalClaim, hasEvidence: boolean): RecordSchedulerCoordinatorRecoveryIssue {
        return {
            code: "claim-ledger-direction-mismatch",
            taskId: claim.taskId,
            unitId: claim.unitId,
            detail: `Irreversible ${claim.lifecycleDirection ?? "unknown"} claim ${claim.claimId} conflicts with ledger evidence=${hasEvidence}`,
        };
    }

    private recoveryRequiredIssue(claim: InternalClaim): RecordSchedulerCoordinatorRecoveryIssue {
        return {
            code: "claim-recovery-required",
            taskId: claim.taskId,
            unitId: claim.unitId,
            detail: `Claim ${claim.claimId} requires provider recovery in ${claim.lifecycleDirection ?? "transfer"} direction${claim.lifecycleError === undefined ? "" : `: ${claim.lifecycleError}`}`,
        };
    }

    private clearLifecycleIssue(claim: InternalClaim, code: RecordSchedulerCoordinatorRecoveryIssueCode): void {
        this.recoveryIssues = this.recoveryIssues.filter(issue => issue.code !== code
            || issue.taskId !== claim.taskId
            || issue.unitId !== claim.unitId);
    }

    private appendUniqueIssue(
        issues: RecordSchedulerCoordinatorRecoveryIssue[],
        issue: RecordSchedulerCoordinatorRecoveryIssue,
    ): void {
        if (!issues.some(candidate => candidate.code === issue.code
            && candidate.taskId === issue.taskId
            && candidate.unitId === issue.unitId)) issues.push(issue);
    }

    private clearLifecycleIssues(claim: InternalClaim): void {
        this.clearLifecycleIssue(claim, "claim-release-failed");
        this.clearLifecycleIssue(claim, "claim-transfer-failed");
        this.clearLifecycleIssue(claim, "claim-reconcile-required");
        this.clearLifecycleIssue(claim, "claim-ledger-direction-mismatch");
        this.clearLifecycleIssue(claim, "claim-recovery-required");
    }

    private emptyDrainResult(complete: boolean): RecordSchedulerCoordinatorDrainResult {
        return {
            complete,
            releasedClaimCount: 0,
            transferredClaimCount: 0,
            successes: [],
            failures: [],
            recoveryRequiredClaims: [],
        };
    }

    private invokeExternalCallback<Result>(
        kind: CoordinatorCallbackContext["kind"],
        claimId: string | undefined,
        callback: () => Result | Promise<Result>,
    ): Promise<Result> {
        return this.callbackContext.run({ kind, claimId }, async () => callback());
    }

    private invokeExternalSync<Result>(
        kind: CoordinatorCallbackContext["kind"],
        claimId: string | undefined,
        callback: () => Result,
    ): Result {
        return this.callbackContext.run({ kind, claimId }, callback);
    }

    private enqueueOperation<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
        const run = async (): Promise<Result> => operation();
        const result = this.operationChain.then(run, run);
        this.operationChain = result.then(() => undefined, () => undefined);
        return result;
    }

    private ensureNotDisposed(): void {
        if (this.disposed) throw new Error("Record scheduler coordinator has been disposed");
    }

    private ensureNotReentrant(operation: string): void {
        const context = this.callbackContext.getStore();
        if (context !== undefined) throw new CoordinatorReentrancyError(operation, context.kind, context.claimId);
    }
}

export function createRecordSchedulerCoordinator(options: RecordSchedulerCoordinatorOptions = {}): RecordSchedulerCoordinator {
    return new RecordSchedulerCoordinator(options);
}
