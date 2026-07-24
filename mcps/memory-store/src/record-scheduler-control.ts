import path from "node:path";
import { RecordCommitProtocol } from "./record-commit-protocol.js";
import { reopenRecordCommitStorageAdapterForCleanup } from "./record-commit-storage-adapter.js";
import { DATA_ROOT } from "./store.js";
import {
    assertAttemptTransition,
    assertTaskTransition,
    assertUnitTransition,
    isCancellationCleanupComplete,
    isEnvelopeBoundAdmission,
    isTerminalTaskState,
    type ImmutableBlobReference,
    type RecordSchedulerLedger,
    type RepairState,
    type SchedulerAttemptLedger,
    type SchedulerRecordWork,
    type TaskState,
    type UnitState,
} from "./record-scheduler-contracts.js";
import {
    SchedulerLedgerConflictError,
    SchedulerOwnerLeaseError,
    completeSchedulerOwnerRecovery,
    claimSchedulerOwnerLease,
    listRecordSchedulerLedgerTaskIds,
    mutateRecordSchedulerLedger,
    mutateRecordSchedulerLedgerAsOwner,
    readRecordSchedulerLedgerStore,
    readRecordSchedulerLedgerStoreSync,
    verifyOrRecoverTaskAdmission,
    type PersistedRecordSchedulerLedger,
    type SchedulerOwnerLease,
    type StoredSchedulerLedger,
} from "./record-scheduler-store.js";
import {
    createRecordSchedulerSpool,
    calculateRecordSchedulerSpoolCancellationEvidenceId,
    calculateRecordSchedulerSpoolReleaseEvidenceId,
    type RecordSchedulerSpool,
    type RecordSchedulerSpoolProofVerifier,
    type RecordSchedulerSpoolReleaseProof,
    type RecordSchedulerTaskCancellationProof,
} from "./record-scheduler-spool.js";
import {
    detachRecordWorkTask,
    readRecordWorkRegistry,
    recoverRecordWorkLease,
    type RecordWorkRegistryLocation,
} from "./record-work-registry.js";

const CONTROL_SCHEMA_VERSION = 1 as const;
const MAX_CAS_RETRIES = 5;
const cancellationFlights = new Map<string, Promise<CancelRecordSchedulerTaskResult>>();

export type RecordSchedulerControlState = TaskState | "RepairRequired";

export interface RecordSchedulerTaskStatus {
    kind: "current" | "missing" | "repair_required";
    taskId: string;
    state: RecordSchedulerControlState;
    taskState?: TaskState;
    repairState?: RepairState;
    aheadTaskCount: number | null;
    namespaceRepair: boolean;
    namespaceRepairReasons: string[];
    sourceResolution?: RecordSchedulerLedger["task"]["sourceResolution"];
    recordItems?: RecordSchedulerLedger["task"]["recordItems"];
    units?: RecordSchedulerLedger["task"]["units"];
    runningAttemptCount?: number;
    unknownOutcomeAttemptCount?: number;
    ledgerRevision?: number;
    ledgerHash?: string;
    reason?: string;
}

export interface RecordSchedulerCancellationEvidence {
    schemaVersion: typeof CONTROL_SCHEMA_VERSION;
    taskId: string;
    evidenceId: string;
    ledgerAnchor: RecordSchedulerTaskCancellationProof;
}

export interface CancelRecordSchedulerTaskResult {
    disposition: "cancelled" | "cancelling" | "already_cancelled" | "already_terminal" | "repair_required" | "missing";
    status: RecordSchedulerTaskStatus;
    evidence?: RecordSchedulerCancellationEvidence;
    reason?: string;
}

export interface DiscardLateRecordSchedulerAttemptInput {
    taskId: string;
    attemptId: string;
    outputRef?: ImmutableBlobReference;
    nowMs?: number;
}

export interface RecoverRecordSchedulerOwnerInput {
    taskId: string;
    ownerId: string;
    nowMs?: number;
    leaseMs?: number;
    workLeaseMs?: number;
}

export type RecoverRecordSchedulerOwnerResult =
    | { kind: "recovered"; ownerLease: SchedulerOwnerLease; status: RecordSchedulerTaskStatus }
    | { kind: "blocked" | "repair_required" | "missing"; status: RecordSchedulerTaskStatus; reason: string };

export interface RecordSchedulerControlOptions {
    dataRoot?: string;
    spool?: RecordSchedulerSpool;
    faultInjector?: RecordSchedulerControlFaultInjector;
}

export interface RecordSchedulerControlFaultEvent {
    point: "before-cancellation-request";
    taskId: string;
    ledgerRevision: number;
    taskState: TaskState;
}

export type RecordSchedulerControlFaultInjector = (event: Readonly<RecordSchedulerControlFaultEvent>) => void | Promise<void>;

export function cancellationEvidenceForLedger(ledger: Pick<RecordSchedulerLedger, "task">): RecordSchedulerCancellationEvidence | null {
    if (!isEnvelopeBoundAdmission(ledger.task.admission)) return null;
    const anchor = ledger.task.admission.ledgerAnchor;
    const dataRoot = ledgerDataRoot(ledger);
    if (!dataRoot) return null;
    const evidenceId = calculateRecordSchedulerSpoolCancellationEvidenceId({
        dataRoot,
        taskId: ledger.task.taskId,
        ledgerRevision: anchor.revision,
        ledgerHash: anchor.hash,
    });
    return {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        taskId: ledger.task.taskId,
        evidenceId,
        ledgerAnchor: {
            taskId: ledger.task.taskId,
            ledgerRevision: anchor.revision,
            ledgerHash: anchor.hash,
            cancellationEvidenceId: evidenceId,
            verifiedAt: ledger.task.cancelRequestedAt || ledger.task.admission.boundAt,
        },
    };
}

export async function verifyLedgerBackedTaskCancellationProof(
    proof: Readonly<RecordSchedulerTaskCancellationProof>,
): Promise<boolean> {
    const admission = await verifyOrRecoverTaskAdmission(proof.taskId);
    if (admission.kind !== "verified") return false;
    const evidence = cancellationEvidenceForLedger(admission.ledger);
    return evidence !== null
        && admission.ledger.task.state === "Cancelling"
        && admission.ledger.task.repairState === "None"
        && sameCancellationProof(evidence.ledgerAnchor, proof);
}

export async function verifyLedgerBackedSpoolReleaseProof(
    proof: Readonly<RecordSchedulerSpoolReleaseProof>,
): Promise<boolean> {
    const admission = await verifyOrRecoverTaskAdmission(proof.taskId);
    if (admission.kind !== "verified") return false;
    const evidence = cancellationEvidenceForLedger(admission.ledger);
    const dataRoot = ledgerDataRoot(admission.ledger);
    if (evidence === null
        || !dataRoot
        || admission.ledger.task.state !== "Cancelling"
        || admission.ledger.task.repairState !== "None"
        || !sameCancellationProof(evidence.ledgerAnchor, proof)
        || proof.releaseEvidenceId !== calculateRecordSchedulerSpoolReleaseEvidenceId({
            dataRoot,
            taskId: proof.taskId,
            kind: proof.kind,
            reference: proof.reference,
            ledgerRevision: proof.ledgerRevision,
            ledgerHash: proof.ledgerHash,
            cancellationEvidenceId: proof.cancellationEvidenceId,
            verifiedAt: proof.verifiedAt,
        })) {
        return false;
    }
    return releaseReferences(admission.ledger).some(candidate => candidate.kind === proof.kind && sameReference(candidate.reference, proof.reference));
}

export function createLedgerBackedSpoolProofVerifier(): RecordSchedulerSpoolProofVerifier {
    return {
        verifyTaskCancellation: verifyLedgerBackedTaskCancellationProof,
        verifyBlobRelease: verifyLedgerBackedSpoolReleaseProof,
    };
}

export class RecordSchedulerControl {
    readonly dataRoot: string;
    readonly spool: RecordSchedulerSpool;
    private readonly faultInjector?: RecordSchedulerControlFaultInjector;

    constructor(options: RecordSchedulerControlOptions = {}) {
        this.dataRoot = options.dataRoot || DATA_ROOT;
        this.faultInjector = options.faultInjector;
        this.spool = options.spool || createRecordSchedulerSpool({
            dataRoot: this.dataRoot,
            proofVerifier: createLedgerBackedSpoolProofVerifier(),
        });
    }

    status(taskId: string): RecordSchedulerTaskStatus {
        let target;
        try {
            target = readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: true });
        } catch (error) {
            return repairStatus(taskId, errorMessage(error));
        }
        if (target.kind === "repair_required") return repairStatus(taskId, target.reason);
        if (target.kind !== "current") {
            return {
                kind: "missing",
                taskId,
                state: "RepairRequired",
                aheadTaskCount: null,
                namespaceRepair: true,
                namespaceRepairReasons: [`target:${target.kind}`],
                reason: `scheduler ledger ${taskId} 不存在或不可读`,
            };
        }

        const currentLedgers: PersistedRecordSchedulerLedger[] = [];
        const namespaceRepairReasons: string[] = [];
        for (const candidateTaskId of listRecordSchedulerLedgerTaskIds()) {
            try {
                const candidate = readRecordSchedulerLedgerStoreSync(candidateTaskId, { expectPublished: true });
                if (candidate.kind === "current") {
                    currentLedgers.push(candidate.ledger);
                } else {
                    namespaceRepairReasons.push(`${candidateTaskId}:${candidate.kind === "repair_required" ? candidate.reason : candidate.kind}`);
                }
            } catch (error) {
                namespaceRepairReasons.push(`${candidateTaskId}:${errorMessage(error)}`);
            }
        }
        const namespaceRepair = namespaceRepairReasons.length > 0;
        const ordered = currentLedgers.sort(compareLedgerOrder);
        const targetIndex = ordered.findIndex(ledger => ledger.task.taskId === taskId);
        const aheadTaskCount = namespaceRepair || targetIndex < 0
            ? null
            : ordered.slice(0, targetIndex).filter(ledger => !isTerminalTaskState(ledger.task.state)).length;
        return statusFromLedger(target.ledger, aheadTaskCount, namespaceRepair, namespaceRepairReasons);
    }

    async cancel(taskId: string): Promise<CancelRecordSchedulerTaskResult> {
        const key = `${path.resolve(this.dataRoot).replace(/\\/gu, "/").toLowerCase()}\u0000${taskId}`;
        const existing = cancellationFlights.get(key);
        if (existing) return existing;
        const operation = this.cancelSingleFlight(taskId);
        cancellationFlights.set(key, operation);
        try {
            return await operation;
        } finally {
            if (cancellationFlights.get(key) === operation) cancellationFlights.delete(key);
        }
    }

    private async cancelSingleFlight(taskId: string): Promise<CancelRecordSchedulerTaskResult> {
        const initial = await this.readCurrent(taskId);
        if (initial.kind !== "current") return this.cancelReadFailure(taskId, initial);
        const initialTerminal = this.terminalCancellationResult(taskId, initial.ledger);
        if (initialTerminal) return initialTerminal;
        if (!isLedgerBoundToDataRoot(initial.ledger, this.dataRoot)) {
            return {
                disposition: "repair_required",
                status: this.status(taskId),
                reason: "scheduler ledger admission root 与 control spool root 不一致",
            };
        }
        const admission = await verifyOrRecoverTaskAdmission(taskId);
        if (admission.kind !== "verified") {
            return this.cancellationRepair(taskId, `取消 admission capsule 不可验证：${admission.reason}`);
        }
        if (!isLedgerBoundToDataRoot(admission.ledger, this.dataRoot)) {
            return {
                disposition: "repair_required",
                status: this.status(taskId),
                reason: "scheduler ledger admission root 与 control spool root 不一致",
            };
        }
        await this.faultInjector?.({
            point: "before-cancellation-request",
            taskId,
            ledgerRevision: admission.ledger.revision,
            taskState: admission.ledger.task.state,
        });
        const requested = await this.requestCancellation(taskId);
        if (requested.kind !== "current") return this.cancelReadFailure(taskId, requested);
        const requestedTerminal = this.terminalCancellationResult(taskId, requested.ledger);
        if (requestedTerminal) return requestedTerminal;
        if (requested.ledger.task.state === "RepairRequired" || requested.ledger.task.repairState !== "None") {
            return { disposition: "repair_required", status: this.status(taskId), reason: "ledger 已要求修复，取消不能伪造完成" };
        }

        const evidence = cancellationEvidenceForLedger(requested.ledger);
        if (!evidence) return this.cancellationRepair(taskId, "取消缺少 immutable admission ledger anchor");

        let cleanupLedger = requested.ledger;
        for (let cleanupAttempt = 0; cleanupAttempt < MAX_CAS_RETRIES; cleanupAttempt += 1) {
            const commitCleanup = await this.cancelTaskExclusiveCommits(cleanupLedger);
            if (commitCleanup.kind === "failed") return this.cancellationRepair(taskId, commitCleanup.reason, evidence);
            if (commitCleanup.kind === "retry") {
                const latest = await this.readCurrent(taskId);
                if (latest.kind !== "current") return this.cancelReadFailure(taskId, latest, evidence);
                const latestTerminal = this.terminalCancellationResult(taskId, latest.ledger, evidence);
                if (latestTerminal) return latestTerminal;
                cleanupLedger = latest.ledger;
                await new Promise(resolve => setTimeout(resolve, 5));
                continue;
            }

            const afterCommit = await this.readCurrent(taskId);
            if (afterCommit.kind !== "current") return this.cancelReadFailure(taskId, afterCommit, evidence);
            const afterCommitTerminal = this.terminalCancellationResult(taskId, afterCommit.ledger, evidence);
            if (afterCommitTerminal) return afterCommitTerminal;
            const detached = await this.detachTaskFromRecordWork(afterCommit.ledger);
            if (detached !== null) return this.cancellationRepair(taskId, detached, evidence);

            const afterDetach = await this.readCurrent(taskId);
            if (afterDetach.kind !== "current") return this.cancelReadFailure(taskId, afterDetach, evidence);
            const afterDetachTerminal = this.terminalCancellationResult(taskId, afterDetach.ledger, evidence);
            if (afterDetachTerminal) return afterDetachTerminal;
            if (hasLiveAttempt(afterDetach.ledger, Date.now())) {
                return { disposition: "cancelling", status: this.status(taskId), evidence };
            }

            const settled = await this.mutateUntilCurrent(
                taskId,
                ledger => cancelNonRunningWork(ledger, Date.now()),
                undefined,
                ledger => isTerminalTaskState(ledger.task.state),
            );
            if (settled.kind !== "current") return this.cancelReadFailure(taskId, settled, evidence);
            const settledTerminal = this.terminalCancellationResult(taskId, settled.ledger, evidence);
            if (settledTerminal) return settledTerminal;

            const spoolResult = await this.cancelSpool(settled.ledger, evidence);
            if (spoolResult.kind === "failed") return this.cancellationRepair(taskId, spoolResult.reason, evidence);
            const afterSpool = await this.readCurrent(taskId);
            if (afterSpool.kind !== "current") return this.cancelReadFailure(taskId, afterSpool, evidence);
            const afterSpoolTerminal = this.terminalCancellationResult(taskId, afterSpool.ledger, evidence);
            if (afterSpoolTerminal) return afterSpoolTerminal;
            if (isCancellationCleanupComplete({ ledger: afterSpool.ledger, taskSpoolVisible: spoolResult.spoolVisible })) {
                const final = await this.mutateUntilCurrent(taskId, ledger => {
                    if (ledger.task.state === "Cancelling") {
                        assertTaskTransition("Cancelling", "Cancelled", {
                            cancellationEvidence: {
                                ledger: afterSpool.ledger,
                                taskSpoolVisible: spoolResult.spoolVisible,
                            },
                        });
                        ledger.task.state = "Cancelled";
                        ledger.task.terminalState = "Cancelled";
                        ledger.task.updatedAt = new Date().toISOString();
                    }
                }, undefined, ledger => isTerminalTaskState(ledger.task.state));
                if (final.kind !== "current") return this.cancelReadFailure(taskId, final, evidence);
                if (!final.mutationApplied) {
                    const finalTerminal = this.terminalCancellationResult(taskId, final.ledger, evidence);
                    if (finalTerminal) return finalTerminal;
                }
                return { disposition: "cancelled", status: this.status(taskId), evidence };
            }
            cleanupLedger = afterSpool.ledger;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        return this.cancellationRepair(taskId, "取消所需的 commit、attempt 或 spool 回读证据不完整", evidence);
    }

    async discardLateAttempt(input: DiscardLateRecordSchedulerAttemptInput): Promise<RecordSchedulerTaskStatus> {
        const now = new Date(input.nowMs ?? Date.now()).toISOString();
        const result = await this.mutateUntilCurrent(input.taskId, ledger => {
            if (ledger.task.state !== "Cancelling" && ledger.task.state !== "Cancelled") {
                throw new Error("仅 Cancelling/Cancelled Task 可以隔离迟到 Attempt 结果");
            }
            const attempt = ledger.attempts.find(candidate => candidate.attemptId === input.attemptId);
            if (!attempt) throw new Error(`Attempt ${input.attemptId} 不存在`);
            if (attempt.state !== "Discarded") {
                if (attempt.state === "Dispatched") {
                    assertAttemptTransition("Dispatched", "KnownSuccess");
                    attempt.state = "KnownSuccess";
                }
                if (attempt.state === "KnownSuccess" || attempt.state === "UnknownOutcome" || attempt.state === "DispatchIntentPersisted" || attempt.state === "Created") {
                    assertAttemptTransition(attempt.state, "Discarded");
                    attempt.state = "Discarded";
                }
                attempt.outcome = "discarded";
                attempt.elapsedMs = attempt.elapsedMs;
                if (input.outputRef) attempt.outputRef = structuredClone(input.outputRef);
            }
            attempt.activeTaskIds = attempt.activeTaskIds.filter(taskId => taskId !== input.taskId);
            const unit = ledger.units.find(candidate => candidate.unitId === attempt.unitId);
            if (unit && unit.state !== "Discarded") {
                if (["Running", "ResultReady", "Committing", "UnknownOutcome"].includes(unit.state)) {
                    assertUnitTransition(unit.state, "Discarded");
                    unit.state = "Discarded";
                }
                if (input.outputRef) unit.resultRef = structuredClone(input.outputRef);
            }
            ledger.task.updatedAt = now;
            refreshUnitCounters(ledger);
        }, input.nowMs);
        if (result.kind !== "current") return this.status(input.taskId);
        return this.status(input.taskId);
    }

    async recoverOwner(input: RecoverRecordSchedulerOwnerInput): Promise<RecoverRecordSchedulerOwnerResult> {
        const current = await this.readCurrent(input.taskId);
        if (current.kind !== "current") return this.ownerReadFailure(input.taskId, current);
        if (isTerminalTaskState(current.ledger.task.state)) {
            return {
                kind: "blocked",
                status: this.status(input.taskId),
                reason: `Task 已处于权威终态 ${current.ledger.task.state}，owner recovery 只读返回`,
            };
        }
        let claimed: StoredSchedulerLedger & { ownerLease: SchedulerOwnerLease };
        try {
            claimed = await claimSchedulerOwnerLease(input.taskId, current.ledger.revision, input.ownerId, {
                nowMs: input.nowMs,
                leaseMs: input.leaseMs,
            });
        } catch (error) {
            return { kind: "blocked", status: this.status(input.taskId), reason: errorMessage(error) };
        }
        try {
            const references = releaseReferences(claimed.ledger);
            if (references.length > 0) {
                await this.spool.initializeRoot({ mode: "open" });
                await this.spool.initializeTask({ taskId: input.taskId, mode: "open" });
                for (const reference of references) {
                    await this.spool.readImmutable({ taskId: input.taskId, kind: reference.kind, reference: reference.reference });
                }
            }
            const reacquired = new Map<string, { schedulerEpoch: number; workLeaseId: string; leaseExpiresAt: string; currentFencingToken: number; activeTaskIds: string[]; registryRevision: number }>();
            for (const work of claimed.ledger.recordWork) {
                const location = recordWorkLocation(this.dataRoot, work);
                const registry = await readRecordWorkRegistry(location);
                if (registry.kind !== "ready") throw new Error(`record work registry ${work.recordWorkKey} ${registry.reason}`);
                const lease = await recoverRecordWorkLease({
                    ...location,
                    recordWorkKey: work.recordWorkKey,
                    taskId: input.taskId,
                    ownerId: input.ownerId,
                    schedulerEpoch: claimed.ownerLease.schedulerEpoch,
                    expectedFence: {
                        schedulerEpoch: work.schedulerEpoch,
                        recordCommitEpoch: work.recordCommitEpoch,
                        fencingToken: work.currentFencingToken,
                        workLeaseId: work.workLeaseId,
                    },
                    expectedRegistryRevision: registry.registry.registryRevision,
                    leaseDurationMs: input.workLeaseMs,
                    nowMs: input.nowMs,
                });
                if (lease.kind !== "recovered") {
                    const reason = lease.kind === "rejected" ? `:${lease.reason}` : "";
                    throw new Error(`record work ${work.recordWorkKey} 无法重获 lease: ${lease.kind}${reason}`);
                }
                reacquired.set(work.recordWorkKey, {
                    schedulerEpoch: claimed.ownerLease.schedulerEpoch,
                    workLeaseId: lease.lease.workLeaseId,
                    leaseExpiresAt: lease.lease.expiresAt,
                    currentFencingToken: lease.fence.fencingToken,
                    activeTaskIds: [...lease.work.activeTaskIds],
                    registryRevision: lease.registry.registryRevision,
                });
            }
            const synchronized = await mutateRecordSchedulerLedgerAsOwner(input.taskId, claimed.revision, claimed.ownerLease, ledger => {
                const recoveredFences = new Map<string, {
                    schedulerEpoch: number;
                    recordCommitEpoch: number;
                    fencingToken: number;
                    workLeaseId: string;
                }>();
                for (const work of ledger.recordWork) {
                    const recovered = reacquired.get(work.recordWorkKey);
                    if (!recovered) throw new Error(`缺少 record work ${work.recordWorkKey} 的 recovery evidence`);
                    work.schedulerEpoch = recovered.schedulerEpoch;
                    work.workLeaseId = recovered.workLeaseId;
                    work.leaseOwnerId = input.ownerId;
                    work.leaseExpiresAt = recovered.leaseExpiresAt;
                    work.currentFencingToken = recovered.currentFencingToken;
                    work.activeTaskIds = recovered.activeTaskIds;
                    work.registryRevision = recovered.registryRevision;
                    recoveredFences.set(work.recordWorkKey, {
                        schedulerEpoch: work.schedulerEpoch,
                        recordCommitEpoch: work.recordCommitEpoch,
                        fencingToken: work.currentFencingToken,
                        workLeaseId: work.workLeaseId,
                    });
                }
                for (const attempt of ledger.attempts) {
                    if (!["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess", "UnknownOutcome"].includes(attempt.state)) continue;
                    const fence = recoveredFences.get(attempt.recordWorkKey);
                    if (!fence) throw new Error(`缺少 attempt ${attempt.attemptId} 的 recovery fence`);
                    attempt.fence = { ...fence };
                }
                for (const commit of ledger.commits) {
                    if (!["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
                    const fence = recoveredFences.get(commit.recordWorkKey);
                    if (!fence) throw new Error(`缺少 commit ${commit.commitId} 的 recovery fence`);
                    commit.fence = { ...fence };
                    if (commit.beforeImage) commit.beforeImage.fence = { ...fence };
                    if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...fence };
                }
                ledger.task.updatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
            }, { nowMs: input.nowMs });
            await completeSchedulerOwnerRecovery(input.taskId, synchronized.revision, claimed.ownerLease, {
                nowMs: input.nowMs,
                recoveredRecordWorkKeys: [...reacquired.keys()],
            });
            return { kind: "recovered", ownerLease: claimed.ownerLease, status: this.status(input.taskId) };
        } catch (error) {
            await this.markRepair(input.taskId, `owner recovery failed: ${errorMessage(error)}`, claimed.ownerLease, input.nowMs, false);
            return { kind: "repair_required", status: this.status(input.taskId), reason: errorMessage(error) };
        }
    }

    private async requestCancellation(taskId: string) {
        for (let phase = 0; phase < 2; phase += 1) {
            const result = await this.mutateUntilCurrent(taskId, ledger => {
                if (ledger.task.state !== "CancelRequested" && ledger.task.state !== "Cancelling") {
                    assertTaskTransition(ledger.task.state, "CancelRequested");
                    ledger.task.state = "CancelRequested";
                    ledger.task.cancelRequestedAt ||= new Date().toISOString();
                    ledger.task.updatedAt = ledger.task.cancelRequestedAt;
                    return;
                }
                if (ledger.task.state === "CancelRequested") {
                    assertTaskTransition("CancelRequested", "Cancelling");
                    ledger.task.state = "Cancelling";
                    ledger.task.updatedAt = new Date().toISOString();
                }
            }, undefined, ledger => isTerminalTaskState(ledger.task.state));
            if (result.kind !== "current" || result.ledger.task.state !== "CancelRequested") return result;
        }
        return this.readCurrent(taskId);
    }

    private async cancelTaskExclusiveCommits(
        ledger: PersistedRecordSchedulerLedger,
    ): Promise<{ kind: "ok" | "retry" } | { kind: "failed"; reason: string }> {
        const ownerLease = ledger.schedulerOwner;
        const candidates = ledger.commits
            .filter(commit => commit.taskId === ledger.task.taskId
                && commit.ownership.mode === "task_exclusive"
                && commit.ownership.ownerTaskId === ledger.task.taskId
                && !isCancellationCommitAlreadyInvisible(commit))
            .sort((left, right) => left.commitId.localeCompare(right.commitId));
        if (candidates.length === 0) return { kind: "ok" };
        if (!ownerLease) return { kind: "failed", reason: "取消 task-exclusive commit 时缺少 scheduler owner lease" };

        for (const commit of candidates) {
            if (!(commit as typeof commit & { protocolLedger?: unknown }).protocolLedger) {
                return { kind: "failed", reason: `commit ${commit.commitId} 缺少可恢复的 protocol ledger` };
            }
            const work = ledger.recordWork.find(candidate => candidate.recordWorkKey === commit.recordWorkKey);
            if (!work) return { kind: "failed", reason: `commit ${commit.commitId} 缺少 record work` };
            try {
                const adapter = await reopenRecordCommitStorageAdapterForCleanup({
                    taskId: ledger.task.taskId,
                    work: {
                        identity: {
                            chain: work.chain,
                            workspaceHash: work.workspaceHash,
                            conversationId: work.conversationId,
                        },
                        desiredRevision: work.desiredRevision,
                    },
                    paths: { dataRoot: this.dataRoot, recordStoreHash: work.workspaceHash },
                    clock: {
                        now: () => new Date().toISOString(),
                        nowMs: () => Date.now(),
                    },
                    schedulerOwnerLease: ownerLease,
                    spool: this.spool,
                });
                const result = await new RecordCommitProtocol(adapter).cancel(commit.commitId);
                if (result.kind === "repair_required") {
                    return { kind: "failed", reason: `commit ${commit.commitId} cleanup failed: ${result.ledger.repairState || result.kind}` };
                }
                if (result.kind === "audited_stale") return { kind: "retry" };
                if (result.kind !== "cancelled" && result.kind !== "detached") {
                    return { kind: "retry" };
                }
            } catch (error) {
                if ((error as { code?: unknown })?.code === "STALE") return { kind: "retry" };
                return { kind: "failed", reason: `commit ${commit.commitId} cleanup threw: ${errorMessage(error)}` };
            }
        }
        return { kind: "ok" };
    }

    private async detachTaskFromRecordWork(ledger: PersistedRecordSchedulerLedger): Promise<string | null> {
        const detached = new Map<string, string[]>();
        for (const work of ledger.recordWork) {
            const location = recordWorkLocation(this.dataRoot, work);
            let complete = false;
            for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
                const registry = await readRecordWorkRegistry(location);
                if (registry.kind !== "ready") return `record work registry ${work.recordWorkKey} ${registry.reason}`;
                const result = await detachRecordWorkTask({
                    ...location,
                    recordWorkKey: work.recordWorkKey,
                    taskId: ledger.task.taskId,
                    expectedRegistryRevision: registry.registry.registryRevision,
                });
                if (result.kind === "repair_required" || result.kind === "work_missing") {
                    return `record work ${work.recordWorkKey} detach ${result.kind}`;
                }
                if (result.kind === "detached") {
                    detached.set(work.recordWorkKey, result.remainingActiveTaskIds);
                    complete = true;
                    break;
                }
                const latest = await readRecordWorkRegistry(location);
                if (latest.kind !== "ready") return `record work ${work.recordWorkKey} detach readback failed`;
                const entry = latest.registry.works.find(candidate => candidate.recordWorkKey === work.recordWorkKey);
                if (!entry) return `record work ${work.recordWorkKey} missing after detach`;
                if (!entry.activeTaskIds.includes(ledger.task.taskId)) {
                    detached.set(work.recordWorkKey, [...entry.activeTaskIds]);
                    complete = true;
                    break;
                }
                if (result.kind !== "cas_conflict") {
                    return `record work ${work.recordWorkKey} still attached after detach ${result.kind}`;
                }
            }
            if (!complete) return `record work ${work.recordWorkKey} detach CAS retry exhausted`;
        }
        const synchronized = await this.mutateUntilCurrent(ledger.task.taskId, current => {
            for (const work of current.recordWork) {
                const remaining = detached.get(work.recordWorkKey);
                if (remaining) work.activeTaskIds = [...remaining];
            }
        });
        return synchronized.kind === "current" ? null : "ledger CAS failed while recording detach evidence";
    }

    private async cancelSpool(ledger: PersistedRecordSchedulerLedger, evidence: RecordSchedulerCancellationEvidence): Promise<{ kind: "ok"; spoolVisible: boolean } | { kind: "failed"; reason: string }> {
        try {
            const references = releaseReferences(ledger);
            if (references.length === 0) return { kind: "ok", spoolVisible: false };
            await this.spool.initializeRoot({ mode: "open" });
            await this.spool.initializeTask({ taskId: ledger.task.taskId, mode: "open" });
            const releaseProofs = references.map(({ kind, reference }) => ({
                ...evidence.ledgerAnchor,
                kind,
                reference: structuredClone(reference),
                releaseEvidenceId: calculateRecordSchedulerSpoolReleaseEvidenceId({
                    dataRoot: this.dataRoot,
                    taskId: ledger.task.taskId,
                    kind,
                    reference,
                    ledgerRevision: evidence.ledgerAnchor.ledgerRevision,
                    ledgerHash: evidence.ledgerAnchor.ledgerHash,
                    cancellationEvidenceId: evidence.ledgerAnchor.cancellationEvidenceId,
                    verifiedAt: evidence.ledgerAnchor.verifiedAt,
                }),
            }));
            const cancelled = await this.spool.cancelTask({
                taskId: ledger.task.taskId,
                cancellationProof: evidence.ledgerAnchor,
                releaseProofs,
            });
            return { kind: "ok", spoolVisible: cancelled.spoolVisible };
        } catch (error) {
            return { kind: "failed", reason: errorMessage(error) };
        }
    }

    private async mutateUntilCurrent(
        taskId: string,
        mutate: (ledger: PersistedRecordSchedulerLedger) => void | Promise<void>,
        nowMs?: number,
        skipMutation?: (ledger: PersistedRecordSchedulerLedger) => boolean,
    ) {
        for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
            const current = await this.readCurrent(taskId);
            if (current.kind !== "current") return current;
            if (skipMutation?.(current.ledger)) return { ...current, mutationApplied: false as const };
            try {
                return {
                    kind: "current" as const,
                    ...(await this.mutateCurrentLedger(taskId, current, mutate, nowMs)),
                    mutationApplied: true as const,
                };
            } catch (error) {
                if (error instanceof SchedulerLedgerConflictError || error instanceof SchedulerOwnerLeaseError) continue;
                throw error;
            }
        }
        const final = await this.readCurrent(taskId);
        if (final.kind === "current" && (final.ledger.task.state === "Cancelled" || skipMutation?.(final.ledger))) {
            return { ...final, mutationApplied: false as const };
        }
        return { kind: "repair_required" as const, reason: "ledger CAS retry exhausted" };
    }

    private async mutateCurrentLedger(
        taskId: string,
        current: { ledger: PersistedRecordSchedulerLedger },
        mutate: (ledger: PersistedRecordSchedulerLedger) => void | Promise<void>,
        nowMs?: number,
    ) {
        const ownerLease = current.ledger.schedulerOwner;
        if (ownerLease) {
            return mutateRecordSchedulerLedgerAsOwner(taskId, current.ledger.revision, ownerLease, mutate, { nowMs });
        }
        return mutateRecordSchedulerLedger(taskId, current.ledger.revision, mutate);
    }

    private async readCurrent(taskId: string) {
        const read = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (read.kind === "current") {
            return {
                kind: "current" as const,
                path: read.path,
                ledger: read.ledger,
            };
        }
        return { kind: read.kind, reason: read.kind === "repair_required" ? read.reason : read.kind };
    }

    private async cancellationRepair(taskId: string, reason: string, evidence?: RecordSchedulerCancellationEvidence): Promise<CancelRecordSchedulerTaskResult> {
        const beforeRepair = await this.readCurrent(taskId);
        if (beforeRepair.kind === "current") {
            const terminal = this.terminalCancellationResult(taskId, beforeRepair.ledger, evidence);
            if (terminal) return terminal;
        }
        await this.markRepair(taskId, reason, undefined, undefined, true);
        const status = this.status(taskId);
        if (status.taskState === "Cancelled") return { disposition: "already_cancelled", status, evidence };
        if (status.taskState && isTerminalTaskState(status.taskState)) {
            return {
                disposition: "already_terminal",
                status,
                evidence,
                reason: `Task 已处于权威终态 ${status.taskState}，未修改 ledger 或清理证据`,
            };
        }
        return { disposition: "repair_required", status, evidence, reason };
    }

    private terminalCancellationResult(
        taskId: string,
        ledger: PersistedRecordSchedulerLedger,
        evidence?: RecordSchedulerCancellationEvidence,
    ): CancelRecordSchedulerTaskResult | null {
        if (ledger.task.state === "Cancelled") {
            return { disposition: "already_cancelled", status: this.status(taskId), evidence };
        }
        if (!isTerminalTaskState(ledger.task.state)) return null;
        return {
            disposition: "already_terminal",
            status: this.status(taskId),
            evidence,
            reason: `Task 已处于权威终态 ${ledger.task.state}，未修改 ledger 或清理证据`,
        };
    }

    private async markRepair(taskId: string, reason: string, ownerLease?: SchedulerOwnerLease, nowMs?: number, preserveCancelling = false): Promise<void> {
        try {
            const current = await this.readCurrent(taskId);
            if (current.kind !== "current") return;
            if (isTerminalTaskState(current.ledger.task.state)) return;
            const mutate = (ledger: PersistedRecordSchedulerLedger) => {
                ledger.task.repairState = "Required";
                ledger.task.updatedAt = new Date(nowMs ?? Date.now()).toISOString();
                if (!preserveCancelling && ledger.task.state !== "Cancelling" && ledger.task.state !== "Cancelled") {
                    ledger.task.state = "RepairRequired";
                    ledger.task.terminalState = "RepairRequired";
                }
                void reason;
            };
            if (ownerLease) {
                await mutateRecordSchedulerLedgerAsOwner(taskId, current.ledger.revision, ownerLease, mutate, { nowMs });
            } else {
                await this.mutateCurrentLedger(taskId, current, mutate, nowMs);
            }
        } catch {
        }
    }

    private cancelReadFailure(taskId: string, read: { kind: string; reason?: string }, evidence?: RecordSchedulerCancellationEvidence): CancelRecordSchedulerTaskResult {
        if (read.kind === "missing") return { disposition: "missing", status: this.status(taskId), evidence, reason: read.reason };
        return { disposition: "repair_required", status: this.status(taskId), evidence, reason: read.reason };
    }

    private ownerReadFailure(taskId: string, read: { kind: string; reason?: string }): RecoverRecordSchedulerOwnerResult {
        return {
            kind: read.kind === "missing" ? "missing" : "repair_required",
            status: this.status(taskId),
            reason: read.reason || read.kind,
        };
    }
}

export function createRecordSchedulerControl(options: RecordSchedulerControlOptions = {}): RecordSchedulerControl {
    return new RecordSchedulerControl(options);
}

function cancelNonRunningWork(ledger: PersistedRecordSchedulerLedger, nowMs: number): void {
    for (const unit of ledger.units) {
        if (["Materialized", "Blocked", "Queued", "WaitingRetry"].includes(unit.state)) {
            assertUnitTransition(unit.state, "Cancelled");
            unit.state = "Cancelled";
        } else if (["ResultReady", "Committing", "UnknownOutcome"].includes(unit.state)) {
            assertUnitTransition(unit.state, "Discarded");
            unit.state = "Discarded";
        }
    }
    for (const attempt of ledger.attempts) {
        const remainsLive = attempt.state === "Dispatched"
            || (attempt.state === "UnknownOutcome"
                && (attempt.unknownOutcomeUntil === undefined || Date.parse(attempt.unknownOutcomeUntil) > nowMs));
        if (["Created", "DispatchIntentPersisted"].includes(attempt.state)) {
            assertAttemptTransition(attempt.state, "Discarded");
            attempt.state = "Discarded";
            attempt.outcome = "discarded";
        } else if (attempt.state === "KnownSuccess") {
            assertAttemptTransition("KnownSuccess", "Discarded");
            attempt.state = "Discarded";
            attempt.outcome = "discarded";
        }
        if (!remainsLive) {
            attempt.activeTaskIds = attempt.activeTaskIds.filter(taskId => taskId !== ledger.task.taskId);
        }
    }
    refreshUnitCounters(ledger);
}

function refreshUnitCounters(ledger: PersistedRecordSchedulerLedger): void {
    ledger.task.units.materialized = ledger.units.length;
    ledger.task.units.eligible = ledger.units.filter(unit => unit.state === "Queued").length;
    ledger.task.units.running = ledger.units.filter(unit => unit.state === "Running").length;
    ledger.task.units.done = ledger.units.filter(unit => ["Succeeded", "Cancelled", "Discarded", "Superseded"].includes(unit.state)).length;
    ledger.task.units.failed = ledger.units.filter(unit => unit.state === "FailedFinal").length;
}

function hasLiveAttempt(ledger: PersistedRecordSchedulerLedger, nowMs: number): boolean {
    return ledger.attempts.some(attempt => attempt.state === "Dispatched"
        || (attempt.state === "UnknownOutcome"
            && (attempt.unknownOutcomeUntil === undefined || Date.parse(attempt.unknownOutcomeUntil) > nowMs)));
}

function isCancellationCommitAlreadyInvisible(commit: RecordSchedulerLedger["commits"][number]): boolean {
    return ["NotStarted", "ResultReady", "BodyStaged", "Abandoned"].includes(commit.state)
        && commit.cleanupPhase === "NotRequired";
}

function ledgerDataRoot(ledger: Pick<RecordSchedulerLedger, "task">): string | null {
    if (!isEnvelopeBoundAdmission(ledger.task.admission)) return null;
    const ledgerPath = path.resolve(ledger.task.admission.ledgerAnchor.path);
    return path.dirname(path.dirname(ledgerPath));
}

function isLedgerBoundToDataRoot(ledger: Pick<RecordSchedulerLedger, "task">, dataRoot: string): boolean {
    const evidence = cancellationEvidenceForLedger(ledger);
    if (!evidence) return false;
    return evidence.evidenceId === calculateRecordSchedulerSpoolCancellationEvidenceId({
        dataRoot,
        taskId: evidence.taskId,
        ledgerRevision: evidence.ledgerAnchor.ledgerRevision,
        ledgerHash: evidence.ledgerAnchor.ledgerHash,
    });
}

function releaseReferences(ledger: RecordSchedulerLedger): Array<{ kind: "source" | "output"; reference: ImmutableBlobReference }> {
    const references = new Map<string, { kind: "source" | "output"; reference: ImmutableBlobReference }>();
    const add = (kind: "source" | "output", reference: ImmutableBlobReference | undefined) => {
        if (!reference) return;
        const key = `${kind}:${reference.path}:${reference.hash}:${reference.byteLength}`;
        references.set(key, { kind, reference });
    };
    if (!ledger.candidateSnapshot.snapshotId.endsWith(":pending")) {
        add("source", ledger.candidateSnapshot.snapshotRef);
    }
    add("source", ledger.sourceMaterialization?.markerRef);
    for (const source of ledger.sourceSnapshots) {
        add("source", source.snapshotRef);
        add("source", source.contentRef);
    }
    for (const unit of ledger.units) add("output", unit.resultRef);
    for (const attempt of ledger.attempts) {
        add("source", attempt.dispatchIntentRef);
        add("output", attempt.outputRef);
    }
    return [...references.values()];
}

function recordWorkLocation(dataRoot: string, work: SchedulerRecordWork): RecordWorkRegistryLocation {
    return {
        dataRoot,
        identity: {
            chain: work.chain,
            workspaceHash: work.workspaceHash,
            conversationId: work.conversationId,
        },
    };
}

function statusFromLedger(ledger: PersistedRecordSchedulerLedger, aheadTaskCount: number | null, namespaceRepair: boolean, namespaceRepairReasons: string[]): RecordSchedulerTaskStatus {
    const taskState = ledger.task.state;
    const state: RecordSchedulerControlState = taskState === "RepairRequired" || ledger.task.repairState !== "None" ? "RepairRequired" : taskState;
    return {
        kind: "current",
        taskId: ledger.task.taskId,
        state,
        taskState,
        repairState: ledger.task.repairState,
        aheadTaskCount,
        namespaceRepair,
        namespaceRepairReasons,
        ...(ledger.task.sourceResolution ? { sourceResolution: structuredClone(ledger.task.sourceResolution) } : {}),
        recordItems: structuredClone(ledger.task.recordItems),
        units: structuredClone(ledger.task.units),
        runningAttemptCount: ledger.attempts.filter(attempt => attempt.state === "Dispatched").length,
        unknownOutcomeAttemptCount: ledger.attempts.filter(attempt => attempt.state === "UnknownOutcome").length,
        ledgerRevision: ledger.revision,
        ledgerHash: ledger.persistedHash,
        ...(taskState === "Deferred" && ledger.task.sourceResolution?.deferredReason === "source_unresolved"
            ? {
                reason: ledger.task.sourceResolution.materializedCount === 0
                    ? "来源证据不足，任务已终止且未生成 Record"
                    : `部分来源证据不足，已完成 ${ledger.task.sourceResolution.materializedCount} 个来源，其余来源未生成`,
            }
            : {}),
    };
}

function repairStatus(taskId: string, reason: string): RecordSchedulerTaskStatus {
    return {
        kind: "repair_required",
        taskId,
        state: "RepairRequired",
        aheadTaskCount: null,
        namespaceRepair: true,
        namespaceRepairReasons: [reason],
        reason,
    };
}

function compareLedgerOrder(left: PersistedRecordSchedulerLedger, right: PersistedRecordSchedulerLedger): number {
    const createdDifference = Date.parse(left.task.createdAt) - Date.parse(right.task.createdAt);
    if (createdDifference !== 0) return createdDifference;
    return left.task.taskId < right.task.taskId ? -1 : left.task.taskId > right.task.taskId ? 1 : 0;
}

function sameCancellationProof(left: RecordSchedulerTaskCancellationProof, right: Pick<RecordSchedulerTaskCancellationProof, "taskId" | "ledgerRevision" | "ledgerHash" | "cancellationEvidenceId">): boolean {
    return left.taskId === right.taskId
        && left.ledgerRevision === right.ledgerRevision
        && left.ledgerHash === right.ledgerHash
        && left.cancellationEvidenceId === right.cancellationEvidenceId;
}

function sameReference(left: ImmutableBlobReference, right: ImmutableBlobReference): boolean {
    return left.path === right.path && left.hash === right.hash && left.byteLength === right.byteLength;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
