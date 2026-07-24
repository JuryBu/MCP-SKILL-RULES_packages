import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
    RecordCommitInitialGuardRejectedError,
    RecordCommitProtocol,
    type RecordCommitAdvanceResult,
    type RecordCommitBinding,
    type RecordCommitLedger,
    type RecordCommitPayload,
} from "./record-commit-protocol.js";
import {
    createRecordCommitStorageAdapter,
    reconcileRecordWorkPublicationGeneration,
    type RecordCommitStorageAdapterClock,
    type RecordCommitStorageAdapterHooks,
} from "./record-commit-storage-adapter.js";
import { getRecordCommitArtifactRelativePath, type RecordIndexEntry } from "./record-store.js";
import type { FrozenRuntimeSource, FrozenRuntimeSourceSet } from "./record-scheduler-runtime.js";
import type { RecordSchedulerControl, RecordSchedulerTaskStatus } from "./record-scheduler-control.js";
import {
    assertAttemptTransition,
    assertUnitTransition,
    UNKNOWN_OUTCOME_GRACE_MS,
    type ImmutableBlobReference,
    type RecordSchedulerLedger,
    type SchedulerAttemptLedger,
    type SchedulerRecordWork,
    type SchedulerUnitLedger,
} from "./record-scheduler-contracts.js";
import {
    createAttemptDispatchDurabilityReceipt,
    mutateRecordSchedulerLedger,
    mutateRecordSchedulerLedgerAsOwner,
    readRecordSchedulerLedgerStore,
    type SchedulerOwnerLease,
} from "./record-scheduler-store.js";
import type { RecordSchedulerSpool } from "./record-scheduler-spool.js";
import {
    canonicalRecordUnitHash,
    createRecordUnitPlan,
    startRecordUnit,
    succeedRecordUnit,
    type RecordUnitProvider,
} from "./record-unit-engine.js";
import {
    acquireRecordWorkLease,
    advanceRecordWorkFence,
    createRecordWorkRegistry,
    initializeRecordWorkRegistryIdentity,
    readRecordWorkRegistry,
    recordWorkKey,
    startOrAttachRecordWork,
    type CanonicalConversationIdentity,
    type RecordWorkOwnerLease,
    type RecordWorkRegistry,
    type RecordWorkRegistryEntry,
} from "./record-work-registry.js";

const DRIVER_SCHEMA_VERSION = 1 as const;
const MAX_CAS_RETRIES = 16;
type AcquiredRecordWorkLease = Extract<Awaited<ReturnType<typeof acquireRecordWorkLease>>, { kind: "acquired" }>;
type ResolvedRecordWorkFence = {
    path: string;
    registry: RecordWorkRegistry;
    work: RecordWorkRegistryEntry;
    lease: RecordWorkOwnerLease;
    fence: SchedulerAttemptLedger["fence"];
};

export class RecordSchedulerExecutionDriverError extends Error {
    constructor(
        readonly code: "AMBIGUOUS_WORK" | "FROZEN_SOURCE_MISMATCH" | "OWNER_UNAVAILABLE" | "REPAIR_REQUIRED" | "UNKNOWN_OUTCOME",
        message: string,
    ) {
        super(message);
        this.name = "RecordSchedulerExecutionDriverError";
    }
}

export interface RecordSchedulerUnitProviderContext {
    taskId: string;
    source: FrozenRuntimeSource;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    inputHash: string;
    idempotencyKey: string;
    provider: RecordUnitProvider;
    model: string;
}

export type RecordSchedulerUnitProviderResult = string | {
    content: string;
    model?: string;
    qualityHash?: string;
};

export interface RecordSchedulerUnitCommitMetadata {
    firstPublicationToken: string;
    provider: RecordUnitProvider;
    model: string;
    recordMeta?: Partial<RecordIndexEntry>;
    inputMetadata?: unknown;
    qualityHash?: string;
    leaseMs?: number;
    workLeaseMs?: number;
    clock?: RecordCommitStorageAdapterClock;
    hooks?: RecordCommitStorageAdapterHooks;
}

export interface RecordSchedulerUnitExecutionDriverInput {
    taskId: string;
    frozenSources: FrozenRuntimeSourceSet;
    sourceSnapshotId?: string;
    recordStoreHash: string;
    schedulerOwner: {
        ownerId: string;
        leaseMs?: number;
        workLeaseMs?: number;
    };
    control: RecordSchedulerControl;
    spool: RecordSchedulerSpool;
    generateRecord: (context: RecordSchedulerUnitProviderContext) => Promise<RecordSchedulerUnitProviderResult>;
    commit: RecordSchedulerUnitCommitMetadata;
    unknownOutcomeGraceMs?: number;
}

export interface RecordSchedulerFinalizedCommitInput {
    taskId: string;
    source: FrozenRuntimeSource;
    recordStoreHash: string;
    schedulerOwner: {
        ownerId: string;
        leaseMs?: number;
        workLeaseMs?: number;
    };
    control: RecordSchedulerControl;
    spool: RecordSchedulerSpool;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    commitId: string;
    outputRef: ImmutableBlobReference;
    commit: Pick<RecordSchedulerUnitCommitMetadata, "firstPublicationToken" | "recordMeta" | "leaseMs" | "workLeaseMs" | "clock" | "hooks">;
}

export interface RecordSchedulerFinalizedCommitVerifiedResult {
    kind: "verified";
    taskId: string;
    sourceSnapshotId: string;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    commitId: string;
    content: string;
    outputRef: ImmutableBlobReference;
    commit: RecordCommitAdvanceResult;
    commitLedger: RecordCommitLedger;
}

export interface RecordSchedulerFinalizedCommitCancelledResult {
    kind: "cancelled";
    taskId: string;
    reason: string;
}

export type RecordSchedulerFinalizedCommitResult =
    | RecordSchedulerFinalizedCommitVerifiedResult
    | RecordSchedulerFinalizedCommitCancelledResult;

interface RecordSchedulerUnitExecutionDriverResultBase {
    taskId: string;
    sourceSnapshotId: string;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    commitId: string;
    idempotencyKey: string;
    inputHash: string;
    content: string;
    outputRef: ImmutableBlobReference;
}

export interface RecordSchedulerUnitExecutionDriverVerifiedResult extends RecordSchedulerUnitExecutionDriverResultBase {
    kind: "verified";
    commit: RecordCommitAdvanceResult;
    commitLedger: RecordCommitLedger;
}

export interface RecordSchedulerUnitExecutionDriverDiscardedResult extends RecordSchedulerUnitExecutionDriverResultBase {
    kind: "discarded";
    cancellation: RecordSchedulerTaskStatus;
}

export type RecordSchedulerUnitExecutionDriverResult =
    | RecordSchedulerUnitExecutionDriverVerifiedResult
    | RecordSchedulerUnitExecutionDriverDiscardedResult;

interface WorkIdentity {
    source: FrozenRuntimeSource;
    identity: CanonicalConversationIdentity;
    desiredRevision: string;
    inputHash: string;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    commitId: string;
    idempotencyKey: string;
}

interface PreparedWork {
    ownerLease: SchedulerOwnerLease;
    work: SchedulerRecordWork;
    unit: SchedulerUnitLedger;
    attempt: SchedulerAttemptLedger;
}

type KnownOutputResult =
    | { kind: "known_success"; content: string; reference: ImmutableBlobReference }
    | { kind: "discarded"; content: string; reference: ImmutableBlobReference; cancellation: RecordSchedulerTaskStatus };

export async function executeRecordSchedulerUnitCommit(
    input: RecordSchedulerUnitExecutionDriverInput,
): Promise<RecordSchedulerUnitExecutionDriverResult> {
    assertInput(input);
    const clock = input.commit.clock || systemClock;
    const source = selectFrozenSource(input.frozenSources, input.sourceSnapshotId);
    const identity = canonicalIdentity(source);
    const initialWorkIdentity = deriveWorkIdentity(input, source, identity);

    if (input.control.spool !== input.spool) {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            "execution driver 要求 control 与 provider 共用同一个 RecordSchedulerSpool 实例，避免恢复时读取不同 spool",
        );
    }

    await input.spool.initializeRoot({ mode: "create" });
    await input.spool.initializeTask({ taskId: input.taskId, mode: "create" });
    await assertFrozenSourceMatchesLedger(input.taskId, source, clock.nowMs());
    const ownerLease = await getOrRecoverOwner(input, clock);
    await ensureSchedulerWork(input, initialWorkIdentity, ownerLease, clock);
    const workIdentity = await resolveWorkIdentity(input, source, identity, ownerLease, clock);
    const adapter = await createRecordCommitStorageAdapter({
        taskId: input.taskId,
        work: {
            identity,
            desiredRevision: workIdentity.desiredRevision,
            firstPublicationToken: input.commit.firstPublicationToken,
            leaseDurationMs: input.commit.workLeaseMs || input.schedulerOwner.workLeaseMs,
        },
        paths: {
            dataRoot: input.control.dataRoot,
            recordStoreHash: input.recordStoreHash,
        },
        clock,
        schedulerOwnerLease: ownerLease,
        spool: input.spool,
        recordMeta: input.commit.recordMeta,
        hooks: input.commit.hooks,
    });
    const prepared = await ensureUnitAndAttempt(input, workIdentity, ownerLease, clock);
    const output = await ensureKnownOutput(input, workIdentity, prepared, clock);

    const resultBase = {
        taskId: input.taskId,
        sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
        recordWorkKey: workIdentity.recordWorkKey,
        unitId: workIdentity.unitId,
        attemptId: workIdentity.attemptId,
        commitId: workIdentity.commitId,
        idempotencyKey: workIdentity.idempotencyKey,
        inputHash: workIdentity.inputHash,
        content: output.content,
        outputRef: output.reference,
    };
    if (output.kind === "discarded") {
        return { kind: "discarded", ...resultBase, cancellation: output.cancellation };
    }
    const beforeCommitCancellation = await discardLateOutputIfCancelled(input, workIdentity, output.reference, clock);
    if (beforeCommitCancellation) {
        return { kind: "discarded", ...resultBase, cancellation: beforeCommitCancellation };
    }

    const binding = {
        conversationKey: `${workIdentity.identity.chain}:${workIdentity.identity.workspaceHash}:${workIdentity.identity.conversationId}`,
        conversationId: workIdentity.identity.conversationId,
        recordId: workIdentity.identity.conversationId,
        taskId: input.taskId,
        unitId: workIdentity.unitId,
        attemptId: workIdentity.attemptId,
        recordWorkKey: workIdentity.recordWorkKey,
        workLeaseId: prepared.work.workLeaseId,
        recordCommitEpoch: prepared.work.recordCommitEpoch,
        fencingToken: prepared.work.currentFencingToken,
        contentHash: output.reference.hash,
        sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
        inputHash: workIdentity.inputHash,
    };
    const payload = {
        bodyRef: {
            kind: "immutable_record_body" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            objectId: `${output.reference.hash}:${output.reference.byteLength}`,
            relativePath: output.reference.path,
        },
        bodyHash: output.reference.hash,
        byteLength: output.reference.byteLength,
        coveredRevision: workIdentity.desiredRevision,
        bodyTarget: {
            kind: "record_body" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("record_body", binding.conversationId),
        },
        mainIndexTarget: {
            kind: "main_index" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("main_index", binding.conversationId),
        },
        mainIndexEntry: {
            commitId: workIdentity.commitId,
            coveredRevision: workIdentity.desiredRevision,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
        },
        readerIndexTarget: {
            kind: "reader_index" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("reader_index", binding.conversationId),
        },
        readerIndex: {
            commitId: workIdentity.commitId,
            bodyHash: output.reference.hash,
            coveredRevision: workIdentity.desiredRevision,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
        },
    };
    const protocol = new RecordCommitProtocol(adapter);
    await protocol.create({ commitId: workIdentity.commitId, binding, payload });
    const commit = await protocol.recover(workIdentity.commitId);
    if (commit.kind !== "verified") {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `Record commit ${workIdentity.commitId} 未达到 Verified，而是 ${commit.kind}${commit.ledger.repairState ? `：${commit.ledger.repairState}` : ""}`,
        );
    }
    const commitLedger = await protocol.read(workIdentity.commitId);

    return { kind: "verified", ...resultBase, commit, commitLedger };
}

export async function commitRecordSchedulerFinalizedRecord(
    input: RecordSchedulerFinalizedCommitInput,
): Promise<RecordSchedulerFinalizedCommitResult> {
    if (!isNonEmptyString(input.taskId) || !isNonEmptyString(input.recordStoreHash)) {
        throw new TypeError("finalized commit 需要 taskId 与 recordStoreHash");
    }
    if (input.control.spool !== input.spool) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "finalized commit 要求 control 与提交方共享同一个 RecordSchedulerSpool 实例");
    }
    const clock = input.commit.clock || systemClock;
    await input.spool.initializeRoot({ mode: "create" });
    await input.spool.initializeTask({ taskId: input.taskId, mode: "create" });
    await assertFrozenSourceMatchesLedger(input.taskId, input.source, clock.nowMs());
    const ownerInput: RecordSchedulerUnitExecutionDriverInput = {
        taskId: input.taskId,
        frozenSources: {
            phase: "sealed",
            sources: [input.source],
            unresolved: [],
            selectedCount: 1,
            materializedCount: 1,
        },
        sourceSnapshotId: input.source.snapshot.sourceSnapshotId,
        recordStoreHash: input.recordStoreHash,
        schedulerOwner: input.schedulerOwner,
        control: input.control,
        spool: input.spool,
        generateRecord: async () => {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "commit-only API 不允许执行 generateRecord");
        },
        commit: {
            firstPublicationToken: input.commit.firstPublicationToken,
            provider: "codex",
            model: "local-finalize",
            leaseMs: input.commit.leaseMs,
            workLeaseMs: input.commit.workLeaseMs,
            clock,
            hooks: input.commit.hooks,
            recordMeta: input.commit.recordMeta,
        },
    };
    const ownerLease = await getOrRecoverOwner(ownerInput, clock);
    const ledger = await requireLedger(input.taskId, clock.nowMs());
    const initialCancellation = finalizedCommitCancellation(ledger, input.taskId, "finalized commit 在读取提交证据前观察到取消");
    if (initialCancellation) return initialCancellation;
    const work = requireWork(ledger, input.recordWorkKey);
    const unit = requireUnit(ledger, input.unitId);
    const attempt = requireAttempt(ledger, input.attemptId);
    const expectedFence = currentFence(work);
    const verifiedProjection = unit.state === "Succeeded" && unit.commitId === input.commitId;
    if (unit.taskId !== input.taskId
        || unit.recordWorkKey !== work.recordWorkKey
        || unit.sourceSnapshotId !== input.source.snapshot.sourceSnapshotId
        || attempt.unitId !== unit.unitId
        || attempt.recordWorkKey !== work.recordWorkKey
        || attempt.provider !== "local"
        || attempt.state !== "KnownSuccess"
        || !attempt.outputRef
        || !sameReference(attempt.outputRef, input.outputRef)
        || (unit.state !== "ResultReady" && !verifiedProjection)
        || unit.dependencies.some(dependency => {
            const dependencyUnit = ledger.units.find(candidate => candidate.unitId === dependency);
            const dependencyAttempt = ledger.attempts.find(candidate => candidate.unitId === dependency && candidate.state === "KnownSuccess");
            return (dependencyUnit?.state !== "ResultReady" && (!verifiedProjection || dependencyUnit?.state !== "Succeeded"))
                || !dependencyAttempt
                || dependencyAttempt.provider === "local";
        })
        || !sameFence(attempt.fence, expectedFence)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "finalized commit 的 local Unit/Attempt/work fence 或依赖不完整");
    }
    assertFinalizedLocalCommitInputs({ ledger, work, unit, attempt, input, expectedFence });
    const output = await readOutput(input.spool, input.taskId, input.outputRef);
    const identity = canonicalIdentity(input.source);
    const adapter = await createRecordCommitStorageAdapter({
        taskId: input.taskId,
        work: {
            identity,
            desiredRevision: input.source.snapshot.desiredRevision,
            firstPublicationToken: input.commit.firstPublicationToken,
            leaseDurationMs: input.commit.workLeaseMs || input.schedulerOwner.workLeaseMs,
        },
        paths: { dataRoot: input.control.dataRoot, recordStoreHash: input.recordStoreHash },
        clock,
        schedulerOwnerLease: ownerLease,
        spool: input.spool,
        recordMeta: input.commit.recordMeta,
        hooks: input.commit.hooks,
    });
    const synchronized = await requireLedger(input.taskId, clock.nowMs());
    const synchronizedCancellation = finalizedCommitCancellation(synchronized, input.taskId, "finalized commit 初始化后观察到取消");
    if (synchronizedCancellation) return synchronizedCancellation;
    const synchronizedWork = requireWork(synchronized, input.recordWorkKey);
    const synchronizedUnit = requireUnit(synchronized, input.unitId);
    const synchronizedAttempt = requireAttempt(synchronized, input.attemptId);
    const synchronizedFence = currentFence(synchronizedWork);
    const synchronizedVerifiedProjection = synchronizedUnit.state === "Succeeded" && synchronizedUnit.commitId === input.commitId;
    if ((synchronizedUnit.state !== "ResultReady" && !synchronizedVerifiedProjection)
        || synchronizedAttempt.state !== "KnownSuccess"
        || !synchronizedAttempt.outputRef
        || !sameReference(synchronizedAttempt.outputRef, input.outputRef)
        || !sameFence(synchronizedAttempt.fence, synchronizedFence)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "finalized commit 初始化后 local Unit/Attempt/work fence 已变化");
    }
    assertFinalizedLocalCommitInputs({
        ledger: synchronized,
        work: synchronizedWork,
        unit: synchronizedUnit,
        attempt: synchronizedAttempt,
        input,
        expectedFence: synchronizedFence,
    });
    const binding = {
        conversationKey: `${identity.chain}:${identity.workspaceHash}:${identity.conversationId}`,
        conversationId: identity.conversationId,
        recordId: identity.conversationId,
        taskId: input.taskId,
        unitId: synchronizedUnit.unitId,
        attemptId: synchronizedAttempt.attemptId,
        recordWorkKey: synchronizedWork.recordWorkKey,
        workLeaseId: synchronizedWork.workLeaseId,
        recordCommitEpoch: synchronizedWork.recordCommitEpoch,
        fencingToken: synchronizedWork.currentFencingToken,
        contentHash: output.reference.hash,
        sourceSnapshotId: input.source.snapshot.sourceSnapshotId,
        inputHash: unit.inputHash,
    };
    const payloadWithoutMetadata = {
        bodyRef: {
            kind: "immutable_record_body" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            objectId: `${output.reference.hash}:${output.reference.byteLength}`,
            relativePath: output.reference.path,
        },
        bodyHash: output.reference.hash,
        byteLength: output.reference.byteLength,
        coveredRevision: input.source.snapshot.desiredRevision,
        bodyTarget: {
            kind: "record_body" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("record_body", binding.conversationId),
        },
        mainIndexTarget: {
            kind: "main_index" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("main_index", binding.conversationId),
        },
        mainIndexEntry: {
            commitId: input.commitId,
            coveredRevision: input.source.snapshot.desiredRevision,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
        },
        readerIndexTarget: {
            kind: "reader_index" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("reader_index", binding.conversationId),
        },
        readerIndex: {
            commitId: input.commitId,
            bodyHash: output.reference.hash,
            coveredRevision: input.source.snapshot.desiredRevision,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
        },
    };
    const protocol = new RecordCommitProtocol(adapter);
    if (synchronizedVerifiedProjection) {
        const protocolLedger = await protocol.read(input.commitId);
        const payload: RecordCommitPayload = {
            ...payloadWithoutMetadata,
            mainIndexMetadata: protocolLedger.payload.mainIndexMetadata,
        };
        const snapshot = synchronized.commits.find(candidate => candidate.commitId === input.commitId);
        if (!isVerifiedFinalizedCommitRetry({
            snapshot,
            protocolLedger,
            binding,
            payload,
            unit: synchronizedUnit,
            attempt: synchronizedAttempt,
            work: synchronizedWork,
            source: input.source,
            outputRef: input.outputRef,
            expectedFence: synchronizedFence,
        })) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "finalized local commit Succeeded projection is not a matching Verified commit");
        }
        return {
            kind: "verified",
            taskId: input.taskId,
            sourceSnapshotId: input.source.snapshot.sourceSnapshotId,
            recordWorkKey: synchronizedWork.recordWorkKey,
            unitId: synchronizedUnit.unitId,
            attemptId: synchronizedAttempt.attemptId,
            commitId: input.commitId,
            content: output.content,
            outputRef: output.reference,
            commit: { kind: "verified", ledger: protocolLedger },
            commitLedger: protocolLedger,
        };
    }
    try {
        await protocol.create({ commitId: input.commitId, binding, payload: payloadWithoutMetadata });
    } catch (error) {
        if (error instanceof RecordCommitInitialGuardRejectedError && error.guard === "cancelled") {
            return { kind: "cancelled", taskId: input.taskId, reason: error.message };
        }
        const current = await requireLedger(input.taskId, clock.nowMs());
        const cancellation = finalizedCommitCancellation(current, input.taskId, "finalized commit 创建 protocol 时观察到取消");
        if (cancellation) return cancellation;
        throw error;
    }
    const commit = await protocol.recover(input.commitId);
    if (commit.kind === "cancelled" || commit.kind === "detached" || commit.kind === "audited_stale") {
        const current = await requireLedger(input.taskId, clock.nowMs());
        const cancellation = finalizedCommitCancellation(current, input.taskId, `finalized Record commit ${input.commitId} 已被取消边界截住`);
        if (cancellation) return cancellation;
    }
    if (commit.kind !== "verified") {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `finalized Record commit ${input.commitId} 未达到 Verified，而是 ${commit.kind}${commit.ledger.repairState ? `：${commit.ledger.repairState}` : ""}`,
        );
    }
    const commitLedger = await protocol.read(input.commitId);
    return {
        kind: "verified",
        taskId: input.taskId,
        sourceSnapshotId: input.source.snapshot.sourceSnapshotId,
        recordWorkKey: work.recordWorkKey,
        unitId: unit.unitId,
        attemptId: attempt.attemptId,
        commitId: input.commitId,
        content: output.content,
        outputRef: output.reference,
        commit,
        commitLedger,
    };
}

function finalizedCommitCancellation(
    ledger: Pick<RecordSchedulerLedger, "task">,
    taskId: string,
    reason: string,
): RecordSchedulerFinalizedCommitCancelledResult | null {
    return ["CancelRequested", "Cancelling", "Cancelled"].includes(ledger.task.state)
        ? { kind: "cancelled", taskId, reason }
        : null;
}

const systemClock: RecordCommitStorageAdapterClock = {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
};

function assertInput(input: RecordSchedulerUnitExecutionDriverInput): void {
    if (!isNonEmptyString(input.taskId)) throw new TypeError("taskId 必须是非空字符串");
    if (!isNonEmptyString(input.recordStoreHash)) throw new TypeError("recordStoreHash 必须是非空字符串");
    if (!isNonEmptyString(input.schedulerOwner.ownerId)) throw new TypeError("schedulerOwner.ownerId 必须是非空字符串");
    if (!isNonEmptyString(input.commit.firstPublicationToken)) throw new TypeError("commit.firstPublicationToken 必须是非空字符串");
    if (!isNonEmptyString(input.commit.model)) throw new TypeError("commit.model 必须是非空字符串");
    const unknownOutcomeGraceMs = input.unknownOutcomeGraceMs ?? UNKNOWN_OUTCOME_GRACE_MS;
    if (!Number.isSafeInteger(unknownOutcomeGraceMs) || unknownOutcomeGraceMs <= 0) {
        throw new TypeError("unknownOutcomeGraceMs 必须是正安全整数");
    }
}

function assertFinalizedLocalCommitInputs(input: {
    ledger: RecordSchedulerLedger;
    work: SchedulerRecordWork;
    unit: SchedulerUnitLedger;
    attempt: SchedulerAttemptLedger;
    input: RecordSchedulerFinalizedCommitInput;
    expectedFence: ReturnType<typeof currentFence>;
}): void {
    const { ledger, work, unit, attempt, input: finalized, expectedFence } = input;
    const verifiedProjection = unit.state === "Succeeded" && unit.commitId === finalized.commitId;
    const validDependencyState = (state: SchedulerUnitLedger["state"] | undefined): boolean => state === "ResultReady" || (verifiedProjection && state === "Succeeded");
    if (unit.taskId !== finalized.taskId
        || unit.recordWorkKey !== work.recordWorkKey
        || unit.recordCommitEpoch !== work.recordCommitEpoch
        || unit.sourceSnapshotId !== finalized.source.snapshot.sourceSnapshotId
        || !unit.resultRef
        || !sameReference(unit.resultRef, finalized.outputRef)
        || (unit.state !== "ResultReady" && !verifiedProjection)
        || attempt.unitId !== unit.unitId
        || attempt.recordWorkKey !== work.recordWorkKey
        || attempt.provider !== "local"
        || attempt.state !== "KnownSuccess"
        || !attempt.outputRef
        || !sameReference(attempt.outputRef, finalized.outputRef)
        || attempt.inputHash !== unit.inputHash
        || unit.dependencies.some(dependency => {
            const dependencyUnit = ledger.units.find(candidate => candidate.unitId === dependency);
            const dependencyAttempt = ledger.attempts.find(candidate => candidate.unitId === dependency && candidate.state === "KnownSuccess");
            return !validDependencyState(dependencyUnit?.state) || !dependencyAttempt || dependencyAttempt.provider === "local";
        })
        || !sameFence(attempt.fence, expectedFence)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "finalized local commit input does not match the current ledger");
    }
}

function isVerifiedFinalizedCommitRetry(input: {
    snapshot: RecordSchedulerLedger["commits"][number] | undefined;
    protocolLedger: RecordCommitLedger;
    binding: RecordCommitBinding;
    payload: RecordCommitPayload;
    unit: SchedulerUnitLedger;
    attempt: SchedulerAttemptLedger;
    work: SchedulerRecordWork;
    source: FrozenRuntimeSource;
    outputRef: ImmutableBlobReference;
    expectedFence: ReturnType<typeof currentFence>;
}): boolean {
    const { snapshot, protocolLedger, binding, payload, unit, attempt, work, source, outputRef, expectedFence } = input;
    return snapshot?.state === "Verified"
        && snapshot.commitId === protocolLedger.commitId
        && snapshot.taskId === binding.taskId
        && snapshot.unitId === unit.unitId
        && snapshot.attemptId === attempt.attemptId
        && snapshot.recordWorkKey === work.recordWorkKey
        && snapshot.sourceSnapshotId === source.snapshot.sourceSnapshotId
        && snapshot.inputHash === unit.inputHash
        && snapshot.outputHash === outputRef.hash
        && snapshot.bodyHash === outputRef.hash
        && sameReference(snapshot.bodyRef, outputRef)
        && snapshot.coveredRevision === source.snapshot.desiredRevision
        && snapshot.qualityResult.accepted
        && sameFence(snapshot.fence, expectedFence)
        && protocolLedger.commitId === snapshot.commitId
        && protocolLedger.stage === "Verified"
        && protocolLedger.confirmedStages.includes("Verified")
        && protocolLedger.lifecycle === "Active"
        && protocolLedger.repairState === null
        && sameCommitBinding(protocolLedger.binding, binding)
        && sameCommitPayload(protocolLedger.payload, payload);
}

function sameCommitBinding(left: RecordCommitBinding, right: RecordCommitBinding): boolean {
    return left.conversationKey === right.conversationKey
        && left.conversationId === right.conversationId
        && left.recordId === right.recordId
        && left.taskId === right.taskId
        && left.unitId === right.unitId
        && left.attemptId === right.attemptId
        && left.recordWorkKey === right.recordWorkKey
        && left.workLeaseId === right.workLeaseId
        && left.recordCommitEpoch === right.recordCommitEpoch
        && left.fencingToken === right.fencingToken
        && left.contentHash === right.contentHash
        && left.sourceSnapshotId === right.sourceSnapshotId
        && left.inputHash === right.inputHash;
}

function sameCommitPayload(left: RecordCommitPayload, right: RecordCommitPayload): boolean {
    return left.bodyRef.kind === right.bodyRef.kind
        && left.bodyRef.conversationId === right.bodyRef.conversationId
        && left.bodyRef.recordId === right.bodyRef.recordId
        && left.bodyRef.objectId === right.bodyRef.objectId
        && left.bodyRef.relativePath === right.bodyRef.relativePath
        && left.bodyHash === right.bodyHash
        && left.byteLength === right.byteLength
        && left.coveredRevision === right.coveredRevision
        && sameCommitTarget(left.bodyTarget, right.bodyTarget)
        && sameCommitTarget(left.mainIndexTarget, right.mainIndexTarget)
        && left.mainIndexEntry.commitId === right.mainIndexEntry.commitId
        && left.mainIndexEntry.coveredRevision === right.mainIndexEntry.coveredRevision
        && left.mainIndexEntry.conversationId === right.mainIndexEntry.conversationId
        && left.mainIndexEntry.recordId === right.mainIndexEntry.recordId
        && sameCommitTarget(left.readerIndexTarget, right.readerIndexTarget)
        && left.readerIndex.commitId === right.readerIndex.commitId
        && left.readerIndex.bodyHash === right.readerIndex.bodyHash
        && left.readerIndex.coveredRevision === right.readerIndex.coveredRevision
        && left.readerIndex.conversationId === right.readerIndex.conversationId
        && left.readerIndex.recordId === right.readerIndex.recordId;
}

function sameCommitTarget(left: RecordCommitPayload["bodyTarget"], right: RecordCommitPayload["bodyTarget"]): boolean {
    return left.kind === right.kind
        && left.conversationId === right.conversationId
        && left.recordId === right.recordId
        && left.relativePath === right.relativePath;
}

function selectFrozenSource(sources: FrozenRuntimeSourceSet, sourceSnapshotId?: string): FrozenRuntimeSource {
    if (sources.phase !== "sealed") {
        throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", "单 Unit 执行只能使用 sealed FrozenRuntimeSourceSet");
    }
    const matches = sourceSnapshotId
        ? sources.sources.filter(source => source.snapshot.sourceSnapshotId === sourceSnapshotId)
        : sources.sources;
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
        throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", `冻结来源中不存在 sourceSnapshotId=${sourceSnapshotId || "<implicit>"}`);
    }
    throw new RecordSchedulerExecutionDriverError(
        "AMBIGUOUS_WORK",
        "一个 scheduler task 含多个冻结来源时，必须显式传 sourceSnapshotId 选择要执行的 record work",
    );
}

function canonicalIdentity(source: FrozenRuntimeSource): CanonicalConversationIdentity {
    return {
        chain: source.snapshot.chain,
        workspaceHash: source.snapshot.workspaceHash,
        conversationId: source.snapshot.conversationId,
    };
}

function deriveWorkIdentity(
    input: RecordSchedulerUnitExecutionDriverInput,
    source: FrozenRuntimeSource,
    identity: CanonicalConversationIdentity,
    attemptOrdinal = 1,
): WorkIdentity {
    const desiredRevision = source.snapshot.desiredRevision;
    const inputHash = canonicalRecordUnitHash({
        schemaVersion: DRIVER_SCHEMA_VERSION,
        kind: "record-scheduler-unit-provider-input",
        identity,
        sourceSnapshotId: source.snapshot.sourceSnapshotId,
        sourceContentHash: source.snapshot.contentHash,
        desiredRevision,
        inputMetadata: input.commit.inputMetadata ?? null,
    });
    const stableWorkKey = recordWorkKey(identity, desiredRevision);
    const unitId = stableId("record-unit", { stableWorkKey, sourceSnapshotId: source.snapshot.sourceSnapshotId, inputHash });
    const attemptId = `${unitId}:attempt:${attemptOrdinal}`;
    const idempotencyKey = stableId("record-provider", {
        stableWorkKey,
        unitId,
        attemptId,
        inputHash,
        provider: input.commit.provider,
        model: input.commit.model,
    });
    const commitId = stableId("record-commit", {
        taskId: input.taskId,
        stableWorkKey,
        unitId,
        attemptId,
        inputHash,
    });
    return { source, identity, desiredRevision, inputHash, recordWorkKey: stableWorkKey, unitId, attemptId, commitId, idempotencyKey };
}

async function resolveWorkIdentity(
    input: RecordSchedulerUnitExecutionDriverInput,
    source: FrozenRuntimeSource,
    identity: CanonicalConversationIdentity,
    ownerLease: SchedulerOwnerLease,
    clock: RecordCommitStorageAdapterClock,
): Promise<WorkIdentity> {
    const initial = deriveWorkIdentity(input, source, identity);
    await advanceExpiredUnknownOutcome(input, initial, ownerLease, clock);
    const ledger = await requireLedger(input.taskId, clock.nowMs());
    const attempts = ledger.attempts.filter(candidate => candidate.unitId === initial.unitId);
    if (attempts.length === 0) return initial;
    const latest = attempts.reduce((selected, candidate) => attemptOrdinal(candidate.attemptId, initial.unitId) > attemptOrdinal(selected.attemptId, initial.unitId)
        ? candidate
        : selected);
    const unit = requireUnit(ledger, initial.unitId);
    const ordinal = attemptOrdinal(latest.attemptId, initial.unitId);
    return deriveWorkIdentity(
        input,
        source,
        identity,
        latest.state === "Discarded" && latest.errorClass === "UnknownOutcome" && unit.state === "Queued"
            ? ordinal + 1
            : ordinal,
    );
}

async function advanceExpiredUnknownOutcome(
    input: RecordSchedulerUnitExecutionDriverInput,
    workIdentity: WorkIdentity,
    ownerLease: SchedulerOwnerLease,
    clock: RecordCommitStorageAdapterClock,
): Promise<void> {
    const now = clock.nowMs();
    const initial = await requireLedger(input.taskId, now);
    const unit = initial.units.find(candidate => candidate.unitId === workIdentity.unitId);
    const unknownAttempts = initial.attempts.filter(candidate => candidate.unitId === workIdentity.unitId
        && candidate.recordWorkKey === workIdentity.recordWorkKey
        && candidate.state === "UnknownOutcome");
    if (unknownAttempts.length === 0) {
        if (unit?.state === "FailedFinal" && unit.failureClass === "UnknownOutcome" && unit.retryBudget === 0) {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Unit ${workIdentity.unitId} 的 UnknownOutcome 重试预算已耗尽`);
        }
        return;
    }
    if (unknownAttempts.length !== 1 || !unit) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit ${workIdentity.unitId} 的 UnknownOutcome attempt 关系不唯一`);
    }
    const attempt = unknownAttempts[0];
    if (!attempt.unknownOutcomeUntil) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 缺少截止时间`);
    }
    const until = Date.parse(attempt.unknownOutcomeUntil);
    if (!Number.isFinite(until)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 截止时间无效`);
    }
    if (until > now) {
        throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `UnknownOutcome Attempt ${attempt.attemptId} 仍在宽限期内`);
    }
    if (unit.state !== "UnknownOutcome") {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 的 Unit 已变为 ${unit.state}`);
    }
    const expectedWork = requireWork(initial, workIdentity.recordWorkKey);
    const resolved = await resolveExpiredUnknownOutcomeFence(input, ownerLease, expectedWork, attempt, initial, clock);
    const registryRef = await registryReference(input.control.dataRoot, resolved.path, resolved.registry);
    await mutateOwnerLedger(input.taskId, ownerLease, ledger => {
        const work = requireWork(ledger, workIdentity.recordWorkKey);
        const currentUnit = requireUnit(ledger, workIdentity.unitId);
        const currentAttempt = ledger.attempts.find(candidate => candidate.attemptId === attempt.attemptId);
        if (!currentAttempt || currentAttempt.state !== "UnknownOutcome") {
            if (currentUnit.state === "Queued" || currentUnit.state === "FailedFinal") return;
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 在 fence 结算前发生非法变化`);
        }
        const beforeFence = currentFence(work);
        const expectedFence = currentFence(expectedWork);
        if (!sameFence(beforeFence, expectedFence) && !sameFence(beforeFence, resolved.fence)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 的 scheduler fence 与 registry 漂移`);
        }
        if (ledger.attempts.some(candidate => candidate.attemptId !== currentAttempt.attemptId
            && candidate.unitId === workIdentity.unitId
            && sameFence(candidate.fence, resolved.fence)
            && !["KnownFailure", "Discarded"].includes(candidate.state))) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `新 fence 已绑定到 Unit ${workIdentity.unitId} 的其他 Attempt`);
        }
        work.registryRevision = resolved.registry.registryRevision;
        work.registryRef = registryRef;
        work.schedulerEpoch = resolved.fence.schedulerEpoch;
        work.workLeaseId = resolved.fence.workLeaseId;
        work.leaseOwnerId = resolved.lease.ownerId;
        work.leaseExpiresAt = resolved.lease.expiresAt;
        work.activeTaskIds = [...resolved.work.activeTaskIds];
        work.currentFencingToken = resolved.fence.fencingToken;
        for (const candidate of ledger.attempts) {
            if (candidate.attemptId === currentAttempt.attemptId
                || candidate.recordWorkKey !== work.recordWorkKey
                || !["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(candidate.state)) continue;
            if (!sameFence(candidate.fence, beforeFence) && !sameFence(candidate.fence, resolved.fence)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${candidate.attemptId} 无法迁移到 UnknownOutcome 新 fence`);
            }
            candidate.fence = { ...resolved.fence };
            if (candidate.leaseExpiresAt) candidate.leaseExpiresAt = resolved.lease.expiresAt;
        }
        for (const commit of ledger.commits) {
            if (commit.recordWorkKey !== work.recordWorkKey
                || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
            if (!sameFence(commit.fence, beforeFence) && !sameFence(commit.fence, resolved.fence)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Commit ${commit.commitId} 无法迁移到 UnknownOutcome 新 fence`);
            }
            commit.fence = { ...resolved.fence };
            if (commit.beforeImage) commit.beforeImage.fence = { ...resolved.fence };
            if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...resolved.fence };
        }
        assertAttemptTransition(currentAttempt.state, "Discarded");
        currentAttempt.state = "Discarded";
        currentAttempt.outcome = "discarded";
        currentAttempt.activeTaskIds = currentAttempt.activeTaskIds.filter(taskId => taskId !== input.taskId);
        currentAttempt.providerEvidence = `${currentAttempt.providerEvidence || "unknown"};unknown-window-expired`;
        if (currentUnit.retryBudget > 0) {
            currentUnit.retryBudget -= 1;
            assertUnitTransition(currentUnit.state, "WaitingRetry");
            currentUnit.state = "WaitingRetry";
            currentUnit.failureClass = undefined;
            currentUnit.nextEligibleAt = undefined;
            currentUnit.enqueueTime = clock.now();
            currentUnit.layerEnterTime = clock.now();
            assertUnitTransition(currentUnit.state, "Queued");
            currentUnit.state = "Queued";
        } else {
            assertUnitTransition(currentUnit.state, "FailedFinal");
            currentUnit.state = "FailedFinal";
            currentUnit.failureClass = "UnknownOutcome";
            currentUnit.nextEligibleAt = undefined;
            currentAttempt.providerEvidence += ";retry-budget-exhausted";
        }
        refreshUnitCounters(ledger);
    }, clock);
    const settled = await requireLedger(input.taskId, clock.nowMs());
    const settledUnit = requireUnit(settled, workIdentity.unitId);
    if (settledUnit.state === "FailedFinal") {
        throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Unit ${workIdentity.unitId} 的 UnknownOutcome 重试预算已耗尽`);
    }
}

async function resolveExpiredUnknownOutcomeFence(
    input: RecordSchedulerUnitExecutionDriverInput,
    ownerLease: SchedulerOwnerLease,
    schedulerWork: SchedulerRecordWork,
    unknownAttempt: SchedulerAttemptLedger,
    ledger: RecordSchedulerLedger,
    clock: RecordCommitStorageAdapterClock,
): Promise<ResolvedRecordWorkFence> {
    const location = { identity: workIdentityFromSchedulerWork(schedulerWork), dataRoot: input.control.dataRoot };
    for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
        const current = await readRecordWorkRegistry(location);
        if (current.kind !== "ready") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome registry 无法读取: ${current.reason}`);
        }
        const work = current.registry.works.find(candidate => candidate.recordWorkKey === schedulerWork.recordWorkKey);
        if (!work || work.state !== "Active" || !work.ownerLease || !work.activeTaskIds.includes(input.taskId)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "UnknownOutcome registry work 缺失、已 superseded、无 lease 或 Task 已脱离");
        }
        if (work.publicationClaim) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "UnknownOutcome work 已存在 publication claim，禁止换发 fence");
        }
        const registryFence = {
            schedulerEpoch: work.ownerLease.schedulerEpoch,
            recordCommitEpoch: work.recordCommitEpoch,
            fencingToken: work.currentFencingToken,
            workLeaseId: work.ownerLease.workLeaseId,
        };
        if (work.ownerLease.ownerId !== ownerLease.ownerId
            || work.ownerLease.schedulerEpoch !== ownerLease.schedulerEpoch
            || work.recordCommitEpoch !== schedulerWork.recordCommitEpoch) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "UnknownOutcome registry owner 或 epoch 与当前 scheduler owner 不一致");
        }
        const schedulerFence = currentFence(schedulerWork);
        const registryMatchesScheduler = sameFence(registryFence, schedulerFence);
        const registryLeadsScheduler = registryFence.fencingToken > schedulerFence.fencingToken
            && registryFence.recordCommitEpoch === schedulerFence.recordCommitEpoch
            && registryFence.workLeaseId !== schedulerFence.workLeaseId;
        if (!registryMatchesScheduler && !registryLeadsScheduler) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "UnknownOutcome registry fence 未与 scheduler 对齐且不是可恢复的领先 fence");
        }
        if (!sameFence(registryFence, unknownAttempt.fence)) {
            if (registryFence.fencingToken <= unknownAttempt.fence.fencingToken
                || registryFence.workLeaseId === unknownAttempt.fence.workLeaseId
                || ledger.attempts.some(candidate => candidate.attemptId !== unknownAttempt.attemptId
                    && candidate.unitId === unknownAttempt.unitId
                    && sameFence(candidate.fence, registryFence)
                    && !["KnownFailure", "Discarded"].includes(candidate.state))) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "UnknownOutcome 领先 fence 无法安全复用");
            }
            return { path: current.path, registry: current.registry, work, lease: work.ownerLease, fence: registryFence };
        }
    const advanced = await advanceRecordWorkFence({
            ...location,
            recordWorkKey: schedulerWork.recordWorkKey,
            taskId: input.taskId,
            ownerId: ownerLease.ownerId,
            fence: registryFence,
            expectedRegistryRevision: current.registry.registryRevision,
            leaseDurationMs: input.commit.workLeaseMs || input.schedulerOwner.workLeaseMs || 1_000,
            nowMs: clock.nowMs(),
        });
        if (advanced.kind === "cas_conflict") continue;
        if (advanced.kind === "advanced") return advanced;
        const reason = advanced.kind === "rejected" ? advanced.reason : advanced.kind;
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome fence 换发失败: ${reason}`);
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "UnknownOutcome fence 换发 CAS 重试耗尽");
}

function workIdentityFromSchedulerWork(work: SchedulerRecordWork): CanonicalConversationIdentity {
    return {
        chain: work.chain,
        workspaceHash: work.workspaceHash,
        conversationId: work.conversationId,
    };
}

async function assertFrozenSourceMatchesLedger(taskId: string, source: FrozenRuntimeSource, nowMs: number): Promise<void> {
    const current = await requireLedger(taskId, nowMs);
    const stored = current.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === source.snapshot.sourceSnapshotId);
    if (!stored
        || stored.snapshotHash !== source.snapshot.snapshotHash
        || stored.contentHash !== source.snapshot.contentHash
        || stored.desiredRevision !== source.snapshot.desiredRevision
        || stored.conversationId !== source.snapshot.conversationId
        || stored.chain !== source.snapshot.chain
        || stored.workspaceHash !== source.snapshot.workspaceHash) {
        throw new RecordSchedulerExecutionDriverError(
            "FROZEN_SOURCE_MISMATCH",
            `scheduler ledger ${taskId} 与 FrozenRuntimeSource ${source.snapshot.sourceSnapshotId} 的身份、内容哈希或 revision 不一致`,
        );
    }
}

async function ensureSchedulerWork(
    input: RecordSchedulerUnitExecutionDriverInput,
    workIdentity: WorkIdentity,
    ownerLease: SchedulerOwnerLease,
    clock: RecordCommitStorageAdapterClock,
): Promise<void> {
    const location = { identity: workIdentity.identity, dataRoot: input.control.dataRoot };
    const initialized = await initializeRecordWorkRegistryIdentity(location, {
        firstPublicationToken: input.commit.firstPublicationToken,
        nowMs: clock.nowMs(),
    });
    if (initialized.kind === "repair_required" || initialized.kind === "publication_rejected") {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法准备 record work identity manifest: ${initialized.kind}`);
    }
    const created = await createRecordWorkRegistry(location, {
        firstPublicationToken: input.commit.firstPublicationToken,
        nowMs: clock.nowMs(),
    });
    if (created.kind === "repair_required" || created.kind === "publication_rejected") {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法建立 record work registry: ${created.kind}`);
    }
    const started = await startOrAttachWithRetry(location, workIdentity.desiredRevision, input.taskId, clock.nowMs());
    if (started.kind !== "started") {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法建立或附着 record work: ${started.kind}`);
    }
    if (started.work.recordWorkKey !== workIdentity.recordWorkKey) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "registry 返回的 recordWorkKey 与稳定派生值不一致");
    }
    const acquired = await acquireRecordWorkLeaseWithRetry(
        location,
        workIdentity.recordWorkKey,
        input.taskId,
        ownerLease,
        input.commit.workLeaseMs || input.schedulerOwner.workLeaseMs || 1_000,
        clock.nowMs(),
    );
    const taskLedger = await requireLedger(input.taskId, clock.nowMs());
    const resolved: ResolvedRecordWorkFence = taskLedger.candidateSnapshot.requestMode === "force"
        ? await reconcileRecordWorkPublicationGeneration({
            taskId: input.taskId,
            recordWorkKey: workIdentity.recordWorkKey,
            identity: workIdentity.identity,
            dataRoot: input.control.dataRoot,
            recordStoreHash: input.recordStoreHash,
            schedulerOwnerLease: ownerLease,
            leaseDurationMs: input.commit.workLeaseMs || input.schedulerOwner.workLeaseMs || 1_000,
            nowMsProvider: () => clock.nowMs(),
        })
        : acquired;
    const registryRef = await registryReference(input.control.dataRoot, resolved.path, resolved.registry);

    await mutateTaskLedger(input, async ledger => {
        const existing = ledger.recordWork.find(work => work.recordWorkKey === workIdentity.recordWorkKey);
        if (existing) {
            if (existing.conversationId !== workIdentity.identity.conversationId
                || existing.chain !== workIdentity.identity.chain
                || existing.workspaceHash !== workIdentity.identity.workspaceHash
                || existing.desiredRevision !== workIdentity.desiredRevision
                    || (existing.recordCommitEpoch !== resolved.work.recordCommitEpoch
                        && !isPublicationGenerationAdvanceForTask(resolved.work, input.taskId, existing))) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "已持久化 recordWork 与当前冻结来源不兼容");
            }
            synchronizeSchedulerWorkFromRegistry(ledger, existing, resolved, registryRef);
            return;
        }
        ledger.recordWork.push({
            recordWorkKey: resolved.work.recordWorkKey,
            conversationId: workIdentity.identity.conversationId,
            chain: workIdentity.identity.chain,
            workspaceHash: workIdentity.identity.workspaceHash,
            desiredRevision: workIdentity.desiredRevision,
            recordCommitEpoch: resolved.work.recordCommitEpoch,
            registryRevision: resolved.registry.registryRevision,
            registryRef,
            schedulerEpoch: resolved.fence.schedulerEpoch,
            workLeaseId: resolved.fence.workLeaseId,
            leaseOwnerId: resolved.lease.ownerId,
            leaseExpiresAt: resolved.lease.expiresAt,
            activeTaskIds: [...resolved.work.activeTaskIds],
            currentFencingToken: resolved.fence.fencingToken,
        });
    }, clock);
}

async function getOrRecoverOwner(
    input: RecordSchedulerUnitExecutionDriverInput,
    clock: RecordCommitStorageAdapterClock,
): Promise<SchedulerOwnerLease> {
    const current = await requireLedger(input.taskId, clock.nowMs());
    if (current.schedulerOwner
        && current.schedulerOwner.ownerId === input.schedulerOwner.ownerId
        && Date.parse(current.schedulerOwner.expiresAt) > clock.nowMs()
        && current.schedulerOwnerRecovery === undefined) {
        return current.schedulerOwner;
    }
    const recovered = await input.control.recoverOwner({
        taskId: input.taskId,
        ownerId: input.schedulerOwner.ownerId,
        nowMs: clock.nowMs(),
        leaseMs: input.commit.leaseMs || input.schedulerOwner.leaseMs,
        workLeaseMs: input.commit.workLeaseMs || input.schedulerOwner.workLeaseMs,
    });
    if (recovered.kind !== "recovered") {
        throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", `无法取得 scheduler owner: ${recovered.reason}`);
    }
    return recovered.ownerLease;
}

async function ensureUnitAndAttempt(
    input: RecordSchedulerUnitExecutionDriverInput,
    workIdentity: WorkIdentity,
    ownerLease: SchedulerOwnerLease,
    clock: RecordCommitStorageAdapterClock,
): Promise<PreparedWork> {
    const plan = createRecordUnitPlan({
        schemaVersion: 1,
        kind: "record-unit-plan-input",
        taskId: input.taskId,
        recordId: workIdentity.identity.conversationId,
        sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
        route: input.commit.provider,
        autoPolicy: null,
        budgets: { unitAttempts: 1, routeAttempts: 1, providerAttempts: 1 },
        maxUnits: 1,
        units: [{
            unitId: workIdentity.unitId,
            unitKind: "compose-window",
            inputHash: workIdentity.inputHash,
            provenance: {
                sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
                sourceContentHash: canonicalFrozenContentHash(workIdentity.source.snapshot.contentHash),
                promptHash: canonicalRecordUnitHash({ kind: "record-scheduler-unit-prompt", inputHash: workIdentity.inputHash }),
                formatterVersion: workIdentity.source.snapshot.formatterVersion,
            },
            range: {
                axis: "round",
                start: Math.max(1, workIdentity.source.snapshot.readRange.startRound),
                end: Math.max(1, workIdentity.source.snapshot.readRange.endRound),
            },
            composeOrder: 0,
            continuationKey: stableId("compose-window-continuation", {
                recordWorkKey: workIdentity.recordWorkKey,
                unitId: workIdentity.unitId,
            }),
            dependencies: [],
            stepCount: Math.max(1, workIdentity.source.snapshot.readRange.totalRounds),
            estimatedCost: 1,
        }],
    });
    const started = startRecordUnit(plan, workIdentity.unitId, { now: clock.nowMs() });
    if (started.action !== "dispatch" || !started.attempt || started.attempt.attemptId !== workIdentity.attemptId) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit state machine 未生成预期的首个 dispatch attempt: ${started.action}`);
    }

    await mutateOwnerLedger(input.taskId, ownerLease, async ledger => {
        const work = requireWork(ledger, workIdentity.recordWorkKey);
        const existingUnit = ledger.units.find(unit => unit.unitId === workIdentity.unitId);
        if (!existingUnit) {
            ledger.units.push({
                unitId: workIdentity.unitId,
                taskId: input.taskId,
                recordId: workIdentity.identity.conversationId,
                state: "Queued",
                layer: "compose-window",
                splitDepth: 0,
                recordWorkKey: work.recordWorkKey,
                recordCommitEpoch: work.recordCommitEpoch,
                dependencies: [],
                composeOrder: 0,
                sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
                inputHash: workIdentity.inputHash,
                estimatedCost: 1,
                routePlan: [input.commit.provider],
                attemptedProviders: [],
                retryBudget: 1,
                enqueueTime: clock.now(),
                layerEnterTime: clock.now(),
            });
        } else if (existingUnit.recordWorkKey !== work.recordWorkKey
            || existingUnit.sourceSnapshotId !== workIdentity.source.snapshot.sourceSnapshotId
            || existingUnit.inputHash !== workIdentity.inputHash) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "已存在 Unit 与稳定 work identity 不兼容");
        }
        const existingAttempt = ledger.attempts.find(attempt => attempt.attemptId === workIdentity.attemptId);
        if (!existingAttempt) {
            ledger.attempts.push({
                attemptId: workIdentity.attemptId,
                unitId: workIdentity.unitId,
                recordWorkKey: work.recordWorkKey,
                originTaskIds: [input.taskId],
                activeTaskIds: [input.taskId],
                state: "Created",
                provider: input.commit.provider,
                model: input.commit.model,
                inputHash: workIdentity.inputHash,
                idempotencyKey: workIdentity.idempotencyKey,
                fence: currentFence(work),
            });
        } else if (existingAttempt.unitId !== workIdentity.unitId
            || existingAttempt.recordWorkKey !== work.recordWorkKey
            || existingAttempt.inputHash !== workIdentity.inputHash
            || existingAttempt.idempotencyKey !== workIdentity.idempotencyKey) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "已存在 Attempt 与稳定 work identity 不兼容");
        }
        refreshUnitCounters(ledger);
    }, clock);

    const current = await requireLedger(input.taskId, clock.nowMs());
    return {
        ownerLease: requireOwner(current, ownerLease),
        work: requireWork(current, workIdentity.recordWorkKey),
        unit: requireUnit(current, workIdentity.unitId),
        attempt: requireAttempt(current, workIdentity.attemptId),
    };
}

async function ensureKnownOutput(
    input: RecordSchedulerUnitExecutionDriverInput,
    workIdentity: WorkIdentity,
    prepared: PreparedWork,
    clock: RecordCommitStorageAdapterClock,
): Promise<KnownOutputResult> {
    let current = await requireLedger(input.taskId, clock.nowMs());
    let attempt = requireAttempt(current, workIdentity.attemptId);
    if (attempt.state === "KnownSuccess" && attempt.outputRef) {
        const output = await readOutput(input.spool, input.taskId, attempt.outputRef);
        return { kind: "known_success", ...output };
    }
    if (attempt.state === "Dispatched" || attempt.state === "UnknownOutcome") {
        throw new RecordSchedulerExecutionDriverError(
            "UNKNOWN_OUTCOME",
            `Attempt ${attempt.attemptId} 已处于 ${attempt.state} 且没有 KnownSuccess/outputRef，禁止重发 provider`,
        );
    }
    if (!["Created", "DispatchIntentPersisted"].includes(attempt.state)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} 无法进入 provider dispatch: ${attempt.state}`);
    }

    if (attempt.state === "Created") {
        const intent = await input.spool.writeImmutable({
            taskId: input.taskId,
            kind: "source",
            content: JSON.stringify({
                schemaVersion: DRIVER_SCHEMA_VERSION,
                kind: "record-scheduler-unit-dispatch-intent",
                taskId: input.taskId,
                sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
                recordWorkKey: workIdentity.recordWorkKey,
                unitId: workIdentity.unitId,
                attemptId: workIdentity.attemptId,
                inputHash: workIdentity.inputHash,
                idempotencyKey: workIdentity.idempotencyKey,
                provider: input.commit.provider,
                model: input.commit.model,
            }),
        });
        await mutateOwnerLedger(input.taskId, prepared.ownerLease, ledger => {
            const unit = requireUnit(ledger, workIdentity.unitId);
            const target = requireAttempt(ledger, workIdentity.attemptId);
            if (target.state === "Created") {
                assertUnitTransition(unit.state, "Running");
                assertAttemptTransition(target.state, "DispatchIntentPersisted");
                unit.state = "Running";
                unit.attemptedProviders = unit.attemptedProviders.includes(input.commit.provider)
                    ? unit.attemptedProviders
                    : [...unit.attemptedProviders, input.commit.provider];
                target.state = "DispatchIntentPersisted";
                target.dispatchIntentAt = clock.now();
                target.dispatchIntentLedgerRevision = ledger.revision + 1;
                target.dispatchIntentRef = intent.reference;
                target.idempotencyKey = workIdentity.idempotencyKey;
                target.fence = currentFence(requireWork(ledger, workIdentity.recordWorkKey));
            }
            refreshUnitCounters(ledger);
        }, clock);
        current = await requireLedger(input.taskId, clock.nowMs());
        attempt = requireAttempt(current, workIdentity.attemptId);
    }

    const receipt = await createAttemptDispatchDurabilityReceipt(input.taskId, workIdentity.attemptId, {
        expectedRevision: current.revision,
        ownerLease: prepared.ownerLease,
        nowMs: clock.nowMs(),
    });
    await mutateOwnerLedger(input.taskId, prepared.ownerLease, ledger => {
        const unit = requireUnit(ledger, workIdentity.unitId);
        const target = requireAttempt(ledger, workIdentity.attemptId);
        if (target.state === "DispatchIntentPersisted") {
            assertAttemptTransition(target.state, "Dispatched");
            target.state = "Dispatched";
            target.outcome = "dispatched";
            target.startedAt = clock.now();
            target.leaseExpiresAt = requireWork(ledger, workIdentity.recordWorkKey).leaseExpiresAt;
            target.providerEvidence = receipt.ledgerHash;
            target.idempotencyKey = workIdentity.idempotencyKey;
            target.fence = currentFence(requireWork(ledger, workIdentity.recordWorkKey));
            unit.state = "Running";
        }
        refreshUnitCounters(ledger);
    }, clock);

    const startedAt = clock.nowMs();
    let providerResult: RecordSchedulerUnitProviderResult;
    try {
        providerResult = await input.generateRecord({
            taskId: input.taskId,
            source: workIdentity.source,
            recordWorkKey: workIdentity.recordWorkKey,
            unitId: workIdentity.unitId,
            attemptId: workIdentity.attemptId,
            inputHash: workIdentity.inputHash,
            idempotencyKey: workIdentity.idempotencyKey,
            provider: input.commit.provider,
            model: input.commit.model,
        });
    } catch (error) {
        await markUnknownProviderOutcome(input, workIdentity, prepared.ownerLease, clock, error);
        throw error;
    }
    const content = typeof providerResult === "string" ? providerResult : providerResult.content;
    if (!isNonEmptyString(content)) throw new TypeError("generateRecord 必须返回非空正文");
    const output = await input.spool.writeImmutable({ taskId: input.taskId, kind: "output", content });

    const afterSpoolCancellation = await discardLateOutputIfCancelled(input, workIdentity, output.reference, clock);
    if (afterSpoolCancellation) {
        return { kind: "discarded", content, reference: output.reference, cancellation: afterSpoolCancellation };
    }

    const model = typeof providerResult === "string" ? input.commit.model : providerResult.model || input.commit.model;
    const qualityHash = typeof providerResult === "string"
        ? input.commit.qualityHash || canonicalRecordUnitHash({ accepted: true, content })
        : providerResult.qualityHash || input.commit.qualityHash || canonicalRecordUnitHash({ accepted: true, content });
    let cancellationObservedDuringOwnerMutation = false;

    await mutateOwnerLedger(input.taskId, prepared.ownerLease, ledger => {
        if (isCancellationRequested(ledger.task.state)) {
            cancellationObservedDuringOwnerMutation = true;
            return;
        }
        const work = requireWork(ledger, workIdentity.recordWorkKey);
        const unit = requireUnit(ledger, workIdentity.unitId);
        const target = requireAttempt(ledger, workIdentity.attemptId);
        if (!sameFence(target.fence, currentFence(work))) {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Attempt ${target.attemptId} 的 fence 已过期，禁止写入 provider 结果`);
        }
        if (target.state === "KnownSuccess" && target.outputRef) {
            if (!sameReference(target.outputRef, output.reference)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "KnownSuccess 已绑定到不同 immutable spool output");
            }
            return;
        }
        if (target.state !== "Dispatched") {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `provider 返回后 Attempt 已变为 ${target.state}，禁止覆盖结果`);
        }
        assertAttemptTransition(target.state, "KnownSuccess");
        assertUnitTransition(unit.state, "ResultReady");
        const enginePlan = createRecordUnitPlan({
            schemaVersion: 1,
            kind: "record-unit-plan-input",
            taskId: input.taskId,
            recordId: workIdentity.identity.conversationId,
            sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
            route: input.commit.provider,
            autoPolicy: null,
            budgets: { unitAttempts: 1, routeAttempts: 1, providerAttempts: 1 },
            maxUnits: 1,
            units: [{
                unitId: workIdentity.unitId,
                unitKind: "compose-window",
                inputHash: workIdentity.inputHash,
                provenance: {
                    sourceSnapshotId: workIdentity.source.snapshot.sourceSnapshotId,
                    sourceContentHash: canonicalFrozenContentHash(workIdentity.source.snapshot.contentHash),
                    promptHash: canonicalRecordUnitHash({ kind: "record-scheduler-unit-prompt", inputHash: workIdentity.inputHash }),
                    formatterVersion: workIdentity.source.snapshot.formatterVersion,
                },
                range: {
                    axis: "round",
                    start: Math.max(1, workIdentity.source.snapshot.readRange.startRound),
                    end: Math.max(1, workIdentity.source.snapshot.readRange.endRound),
                },
                composeOrder: 0,
                continuationKey: stableId("compose-window-continuation", {
                    recordWorkKey: workIdentity.recordWorkKey,
                    unitId: workIdentity.unitId,
                }),
                dependencies: [],
                stepCount: Math.max(1, workIdentity.source.snapshot.readRange.totalRounds),
                estimatedCost: 1,
            }],
        });
        const engineStarted = startRecordUnit(enginePlan, workIdentity.unitId, { now: startedAt });
        if (engineStarted.action !== "dispatch" || !engineStarted.attempt) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "纯 Unit 状态机拒绝已持久化的 provider attempt");
        }
        succeedRecordUnit(engineStarted.plan, workIdentity.unitId, {
            attemptId: engineStarted.attempt.attemptId,
            fence: engineStarted.attempt.fence,
            model,
            outputHash: canonicalRecordUnitHash({ spoolHash: output.reference.hash, byteLength: output.reference.byteLength }),
            qualityHash,
        });
        target.state = "KnownSuccess";
        target.outcome = "known_success";
        target.outputRef = output.reference;
        target.elapsedMs = Math.max(0, clock.nowMs() - startedAt);
        target.model = model;
        target.fence = currentFence(work);
        unit.state = "ResultReady";
        unit.resultRef = output.reference;
        unit.coveredRevision = work.desiredRevision;
        refreshUnitCounters(ledger);
    }, clock);
    const afterKnownSuccessCancellation = cancellationObservedDuringOwnerMutation
        ? await discardLateOutputIfCancelled(input, workIdentity, output.reference, clock, true)
        : await discardLateOutputIfCancelled(input, workIdentity, output.reference, clock);
    if (afterKnownSuccessCancellation) {
        return { kind: "discarded", content, reference: output.reference, cancellation: afterKnownSuccessCancellation };
    }
    return { kind: "known_success", content, reference: output.reference };
}

async function markUnknownProviderOutcome(
    input: RecordSchedulerUnitExecutionDriverInput,
    workIdentity: WorkIdentity,
    ownerLease: SchedulerOwnerLease,
    clock: RecordCommitStorageAdapterClock,
    error: unknown,
): Promise<void> {
    const now = clock.nowMs();
    const graceMs = input.unknownOutcomeGraceMs ?? UNKNOWN_OUTCOME_GRACE_MS;
    await mutateOwnerLedger(input.taskId, ownerLease, ledger => {
        const work = requireWork(ledger, workIdentity.recordWorkKey);
        const unit = requireUnit(ledger, workIdentity.unitId);
        const attempt = requireAttempt(ledger, workIdentity.attemptId);
        if (attempt.state !== "Dispatched") return;
        if (!sameFence(attempt.fence, currentFence(work))) {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Attempt ${attempt.attemptId} 的 fence 已过期，禁止标记新的 UnknownOutcome`);
        }
        assertAttemptTransition(attempt.state, "UnknownOutcome");
        assertUnitTransition(unit.state, "UnknownOutcome");
        attempt.state = "UnknownOutcome";
        attempt.outcome = "unknown_outcome";
        attempt.errorClass = "UnknownOutcome";
        attempt.unknownOutcomeAt = new Date(now).toISOString();
        attempt.unknownOutcomeUntil = new Date(now + graceMs).toISOString();
        attempt.unknownOutcomeGraceMs = graceMs;
        attempt.providerEvidence = `${attempt.providerEvidence || "provider"};unknown:${errorMessage(error)}`;
        unit.state = "UnknownOutcome";
        unit.failureClass = "UnknownOutcome";
        refreshUnitCounters(ledger);
    }, clock);
}

async function discardLateOutputIfCancelled(
    input: RecordSchedulerUnitExecutionDriverInput,
    workIdentity: WorkIdentity,
    outputRef: ImmutableBlobReference,
    clock: RecordCommitStorageAdapterClock,
    requireCancellation = false,
): Promise<RecordSchedulerTaskStatus | undefined> {
    const current = await requireLedger(input.taskId, clock.nowMs());
    if (!isCancellationRequested(current.task.state)) {
        if (!requireCancellation) return undefined;
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `Attempt ${workIdentity.attemptId} 观察到取消竞态但 Task 已回到 ${current.task.state}`,
        );
    }

    const requested = await input.control.cancel(input.taskId);
    if (requested.disposition === "repair_required" || requested.disposition === "missing") {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `迟到 provider output 无法建立取消边界: ${requested.reason || requested.disposition}`,
        );
    }
    const afterRequest = await requireLedger(input.taskId, clock.nowMs());
    if (afterRequest.task.state !== "Cancelling" && afterRequest.task.state !== "Cancelled") {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `迟到 provider output 的 Task 未进入 Cancelling/Cancelled: ${afterRequest.task.state}`,
        );
    }

    const discarded = await input.control.discardLateAttempt({
        taskId: input.taskId,
        attemptId: workIdentity.attemptId,
        outputRef,
        nowMs: clock.nowMs(),
    });
    if (discarded.state !== "Cancelling" && discarded.state !== "Cancelled") {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `迟到 provider output 丢弃后 Task 状态异常: ${discarded.state}`,
        );
    }
    return discarded;
}

function isCancellationRequested(state: RecordSchedulerLedger["task"]["state"]): boolean {
    return state === "CancelRequested" || state === "Cancelling" || state === "Cancelled";
}

async function readOutput(
    spool: RecordSchedulerSpool,
    taskId: string,
    reference: ImmutableBlobReference,
): Promise<{ content: string; reference: ImmutableBlobReference }> {
    const bytes = await spool.readImmutable({ taskId, kind: "output", reference });
    if (bytes.byteLength !== reference.byteLength || sha256(bytes) !== reference.hash) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "KnownSuccess outputRef 的 spool 回读哈希或字节数不一致");
    }
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "KnownSuccess outputRef 不是可逆 UTF-8 正文");
    }
    return { content, reference };
}

function canonicalFrozenContentHash(value: string): string {
    const canonical = value.startsWith("sha256:") ? value : `sha256:${value}`;
    if (!/^sha256:[0-9a-f]{64}$/u.test(canonical)) {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            "FrozenRuntimeSource contentHash 不是可转换为 canonical sha256 的不可变内容哈希",
        );
    }
    return canonical;
}

async function startOrAttachWithRetry(
    location: { identity: CanonicalConversationIdentity; dataRoot: string },
    desiredRevision: string,
    taskId: string,
    nowMs: number,
) {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
        const registry = await readRecordWorkRegistry(location);
        if (registry.kind !== "ready") return registry;
        const started = await startOrAttachRecordWork({
            ...location,
            desiredRevision,
            taskId,
            expectedRegistryRevision: registry.registry.registryRevision,
            nowMs,
        });
        if (started.kind !== "cas_conflict") return started;
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "startOrAttachRecordWork CAS 重试耗尽");
}

async function acquireRecordWorkLeaseWithRetry(
    location: { identity: CanonicalConversationIdentity; dataRoot: string },
    recordWorkKeyValue: string,
    taskId: string,
    ownerLease: SchedulerOwnerLease,
    leaseDurationMs: number,
    nowMs: number,
): Promise<AcquiredRecordWorkLease> {
    for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
        const current = await readRecordWorkRegistry(location);
        if (current.kind !== "ready") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `record work registry 无法读取: ${current.reason}`);
        }
        const work = current.registry.works.find(candidate => candidate.recordWorkKey === recordWorkKeyValue);
        const reusableLeaseId = work?.ownerLease
            && work.ownerLease.ownerId === ownerLease.ownerId
            && work.ownerLease.schedulerEpoch === ownerLease.schedulerEpoch
            ? work.ownerLease.workLeaseId
            : undefined;
        const acquired = await acquireRecordWorkLease({
            ...location,
            recordWorkKey: recordWorkKeyValue,
            taskId,
            ownerId: ownerLease.ownerId,
            schedulerEpoch: ownerLease.schedulerEpoch,
            expectedRegistryRevision: current.registry.registryRevision,
            ...(reusableLeaseId ? { workLeaseId: reusableLeaseId } : {}),
            leaseDurationMs,
            nowMs,
        });
        if (acquired.kind === "cas_conflict") continue;
        if (acquired.kind === "acquired") return acquired;
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `record work lease 无法取得: ${acquired.kind}`);
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "record work lease CAS 重试耗尽");
}

function isPublicationGenerationAdvanceForTask(
    work: RecordWorkRegistryEntry,
    taskId: string,
    previous: SchedulerRecordWork,
): boolean {
    return (work.publicationHistory || []).some(entry => entry.supersededByTaskId === taskId
        && entry.claim.schedulerEpoch === previous.schedulerEpoch
        && entry.claim.recordCommitEpoch === previous.recordCommitEpoch
        && entry.claim.fencingToken === previous.currentFencingToken
        && entry.claim.workLeaseId === previous.workLeaseId
        && entry.nextRecordCommitEpoch === work.recordCommitEpoch);
}

function synchronizeSchedulerWorkFromRegistry(
    ledger: RecordSchedulerLedger,
    work: SchedulerRecordWork,
    acquired: ResolvedRecordWorkFence,
    registryRef: ImmutableBlobReference,
): void {
    const previousFence = currentFence(work);
    const nextFence = acquired.fence;
    const generationAdvanced = work.recordCommitEpoch !== acquired.work.recordCommitEpoch;
    if (generationAdvanced) {
        const hasBoundExecution = ledger.units.some(unit => unit.recordWorkKey === work.recordWorkKey)
            || ledger.attempts.some(attempt => attempt.recordWorkKey === work.recordWorkKey)
            || ledger.commits.some(commit => commit.recordWorkKey === work.recordWorkKey);
        if (hasBoundExecution) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "publication generation 推进前 scheduler ledger 已存在绑定旧 epoch 的 Unit/Attempt/Commit");
        }
        work.recordCommitEpoch = acquired.work.recordCommitEpoch;
    }
    work.registryRevision = acquired.registry.registryRevision;
    work.registryRef = registryRef;
    work.schedulerEpoch = nextFence.schedulerEpoch;
    work.workLeaseId = nextFence.workLeaseId;
    work.leaseOwnerId = acquired.lease.ownerId;
    work.leaseExpiresAt = acquired.lease.expiresAt;
    work.activeTaskIds = [...acquired.work.activeTaskIds];
    work.currentFencingToken = nextFence.fencingToken;
    for (const attempt of ledger.attempts) {
        if (attempt.recordWorkKey !== work.recordWorkKey) continue;
        if (["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(attempt.state)) {
            if (!sameFence(attempt.fence, previousFence) && !sameFence(attempt.fence, nextFence)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} 的 fence 无法与 registry 同步`);
            }
            attempt.fence = { ...nextFence };
            if (attempt.leaseExpiresAt) attempt.leaseExpiresAt = acquired.lease.expiresAt;
        } else if (attempt.state === "UnknownOutcome"
            && attempt.fence.fencingToken === nextFence.fencingToken
            && sameFence(attempt.fence, previousFence)) {
            attempt.fence = { ...nextFence };
        }
    }
    for (const commit of ledger.commits) {
        if (commit.recordWorkKey !== work.recordWorkKey
            || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
        if (!sameFence(commit.fence, previousFence) && !sameFence(commit.fence, nextFence)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Commit ${commit.commitId} 的 fence 无法与 registry 同步`);
        }
        commit.fence = { ...nextFence };
        if (commit.beforeImage) commit.beforeImage.fence = { ...nextFence };
        if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...nextFence };
    }
}

async function registryReference(dataRoot: string, registryPath: string, registry: RecordWorkRegistry): Promise<ImmutableBlobReference> {
    const relativePath = path.relative(dataRoot, registryPath).replace(/\\/gu, "/");
    if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "record work registry 路径越出 dataRoot");
    }
    const stat = await fs.stat(registryPath);
    return { path: relativePath, hash: registry.persistedHash, byteLength: stat.size };
}

async function mutateTaskLedger(
    input: RecordSchedulerUnitExecutionDriverInput,
    mutate: (ledger: RecordSchedulerLedger) => void | Promise<void>,
    clock: RecordCommitStorageAdapterClock,
): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
        const current = await requireLedger(input.taskId, clock.nowMs());
        try {
            if (current.schedulerOwner) {
                if (current.schedulerOwner.ownerId !== input.schedulerOwner.ownerId) {
                    throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "已有不同 scheduler owner 持有任务，拒绝创建新的 record work");
                }
                await mutateRecordSchedulerLedgerAsOwner(input.taskId, current.revision, current.schedulerOwner, mutate, { nowMs: clock.nowMs() });
            } else {
                await mutateRecordSchedulerLedger(input.taskId, current.revision, mutate);
            }
            return;
        } catch (error) {
            if (isSchedulerLedgerConflict(error)) continue;
            throw error;
        }
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "scheduler ledger CAS 重试耗尽");
}

async function mutateOwnerLedger(
    taskId: string,
    ownerLease: SchedulerOwnerLease,
    mutate: (ledger: RecordSchedulerLedger) => void | Promise<void>,
    clock: RecordCommitStorageAdapterClock,
): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
        const current = await requireLedger(taskId, clock.nowMs());
        const currentOwner = requireOwner(current, ownerLease);
        try {
            await mutateRecordSchedulerLedgerAsOwner(taskId, current.revision, currentOwner, mutate, { nowMs: clock.nowMs() });
            return;
        } catch (error) {
            if (isSchedulerLedgerConflict(error)) continue;
            throw error;
        }
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "owner scheduler ledger CAS 重试耗尽");
}

async function requireLedger(taskId: string, nowMs: number): Promise<RecordSchedulerLedger & {
    schedulerOwner?: SchedulerOwnerLease;
    schedulerOwnerRecovery?: unknown;
}> {
    const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs });
    if (current.kind !== "current") {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法读取 scheduler ledger ${taskId}: ${current.kind}`);
    }
    return current.ledger;
}

function requireOwner(
    ledger: RecordSchedulerLedger & { schedulerOwner?: SchedulerOwnerLease },
    expected: SchedulerOwnerLease,
): SchedulerOwnerLease {
    const current = ledger.schedulerOwner;
    if (!current
        || current.ownerId !== expected.ownerId
        || current.leaseId !== expected.leaseId
        || current.schedulerEpoch !== expected.schedulerEpoch
        || current.fencingToken !== expected.fencingToken) {
        throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "scheduler owner lease 已被 fencing 或替换");
    }
    return current;
}

function requireWork(ledger: RecordSchedulerLedger, recordWorkKeyValue: string): SchedulerRecordWork {
    const work = ledger.recordWork.find(candidate => candidate.recordWorkKey === recordWorkKeyValue);
    if (!work) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `缺少 record work ${recordWorkKeyValue}`);
    return work;
}

function requireUnit(ledger: RecordSchedulerLedger, unitId: string): SchedulerUnitLedger {
    const unit = ledger.units.find(candidate => candidate.unitId === unitId);
    if (!unit) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `缺少 Unit ${unitId}`);
    return unit;
}

function requireAttempt(ledger: RecordSchedulerLedger, attemptId: string): SchedulerAttemptLedger {
    const attempt = ledger.attempts.find(candidate => candidate.attemptId === attemptId);
    if (!attempt) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `缺少 Attempt ${attemptId}`);
    return attempt;
}

function currentFence(work: SchedulerRecordWork) {
    return {
        schedulerEpoch: work.schedulerEpoch,
        recordCommitEpoch: work.recordCommitEpoch,
        fencingToken: work.currentFencingToken,
        workLeaseId: work.workLeaseId,
    };
}

function refreshUnitCounters(ledger: RecordSchedulerLedger): void {
    ledger.task.units.materialized = ledger.units.length;
    ledger.task.units.eligible = ledger.units.filter(unit => unit.state === "Queued").length;
    ledger.task.units.running = ledger.units.filter(unit => unit.state === "Running").length;
    ledger.task.units.done = ledger.units.filter(unit => ["Succeeded", "Cancelled", "Discarded", "Superseded"].includes(unit.state)).length;
    ledger.task.units.failed = ledger.units.filter(unit => unit.state === "FailedFinal").length;
}

function stableId(prefix: string, value: unknown): string {
    return `${prefix}-${sha256(Buffer.from(JSON.stringify(value), "utf8")).slice(0, 32)}`;
}

function sha256(value: Uint8Array): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function sameReference(left: ImmutableBlobReference, right: ImmutableBlobReference): boolean {
    return left.path === right.path && left.hash === right.hash && left.byteLength === right.byteLength;
}

function sameFence(
    left: SchedulerAttemptLedger["fence"],
    right: SchedulerAttemptLedger["fence"],
): boolean {
    return left.schedulerEpoch === right.schedulerEpoch
        && left.recordCommitEpoch === right.recordCommitEpoch
        && left.fencingToken === right.fencingToken
        && left.workLeaseId === right.workLeaseId;
}

function attemptOrdinal(attemptId: string, unitId: string): number {
    const prefix = `${unitId}:attempt:`;
    if (!attemptId.startsWith(prefix)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attemptId} 不属于 Unit ${unitId}`);
    }
    const ordinal = Number(attemptId.slice(prefix.length));
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attemptId} 缺少有效代际 ordinal`);
    }
    return ordinal;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isSchedulerLedgerConflict(error: unknown): boolean {
    const code = errorCode(error);
    return code === "SCHEDULER_LEDGER_CONFLICT" || code === "REVISION_CONFLICT";
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
