import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
    RecordCommitVerificationError,
    type JsonValue,
    type RecordCommitBinding,
    type RecordCommitAdvanceResult,
    type RecordCommitBodyImage,
    type RecordCommitBodyReadResult,
    type RecordCommitBodyRef,
    type RecordCommitConditionalMutationResult,
    type RecordCommitDurableStateAdapter,
    type RecordCommitIoAdapter,
    type RecordCommitJsonImage,
    type RecordCommitLedger,
    type RecordCommitPayload,
    type RecordCommitPayloadMetadata,
    type RecordCommitInitialLedgerCasResult,
    type RecordCommitRegistryAdapter,
    type RecordCommitRegistryEvidence,
    type RecordCommitSharedWorkEvidence,
    type RecordCommitTarget,
    type RecordCommitTargetKind,
    type RecordCommitProtocolAdapter,
    type RecordCommitProtocolHooks,
} from "./record-commit-protocol.js";
import {
    calculateRecordCommitArtifactJsonHash,
    calculateRecordIndexEntryMetadataHash,
    createRecordIndexEntryMetadataSnapshot,
    getRecordCommitArtifactRelativePath,
    readRecordCommitBodyArtifact,
    readRecordCommitBodyArtifactLocked,
    readRecordCommitMainIndexArtifact,
    readRecordCommitMainIndexArtifactLocked,
    restoreRecordCommitBodyIfOwned,
    restoreRecordCommitMainIndexIfOwned,
    isRecordCommitArtifactIdentity,
    isRecordIndexEntryMetadataSnapshot,
    validateRecordCommitArtifactTarget,
    validateRecordCommitMainIndexStorageBinding,
    withRecordCommitArtifactLock,
    writeRecordCommitBodyConditionally,
    writeRecordCommitMainIndexConditionally,
    type RecordCommitArtifactIdentity,
    type RecordCommitArtifactTarget,
    type RecordCommitBodyArtifactImage,
    type RecordCommitJsonArtifactImage,
    type RecordIndexEntry,
    type RecordIndexEntryMetadataSnapshot,
} from "./record-store.js";
import {
    readRecordCommitReaderIndexArtifact,
    readRecordCommitReaderIndexArtifactLocked,
    rebuildRecordCommitReaderIndexFromBody,
    writeRecordCommitReaderIndexConditionally,
    type RecordCommitReaderIndexEntry,
} from "./record-update-coordination.js";
import {
    assertCurrentSchedulerOwnerLease,
    mutateRecordSchedulerLedgerAsOwner,
    readRecordSchedulerLedgerStore,
    type PersistedRecordSchedulerLedger,
    type SchedulerOwnerLease,
} from "./record-scheduler-store.js";
import {
    createRecordSchedulerSpool,
    type RecordSchedulerSpool,
} from "./record-scheduler-spool.js";
import { RECORD_SCHEDULER_SCHEMA_VERSION } from "./record-scheduler-contracts.js";
import type {
    CleanupReadBackVerification,
    CommitSnapshot,
    FencingToken,
    ImmutableBlobReference,
    RecordSchedulerLedger,
} from "./record-scheduler-contracts.js";
import {
    acquireRecordWorkLease,
    authorizeRecordWorkCommit,
    createRecordWorkRegistry,
    detachRecordWorkTask,
    initializeRecordWorkRegistryIdentity,
    readRecordWorkRegistry,
    rolloverRecordWorkPublication,
    startOrAttachRecordWork,
    withRecordWorkCommitAuthority,
    claimRecordWorkPublication,
    withRecordWorkPublicationAuthority,
    type CanonicalConversationIdentity,
    type ConditionalCommitAuthorization,
    type ConditionalCommitAuthorizationInput,
    type RecordWorkRegistry,
    type RecordWorkRegistryEntry,
    type RecordWorkRegistryLocation,
    type RecordWorkOwnerLease,
    type RecordWorkPublicationClaim,
    type RecordWorkPublicationClaimInput,
    type RecordWorkPublicationRolloverVerification,
} from "./record-work-registry.js";

const BODY_REF_SEPARATOR = ":";
const LEGACY_BEFORE_IMAGE_REVISION = "legacy-before-image";
const MAX_SCHEDULER_SYNC_RETRIES = 16;

export interface RecordCommitStorageAdapterClock {
    now(): string;
    nowMs(): number;
}

export interface RecordCommitStorageAdapterPaths {
    dataRoot: string;
    recordStoreHash: string;
    lateResultDirectory?: string;
}

export interface RecordCommitStorageAdapterWork {
    identity: CanonicalConversationIdentity;
    desiredRevision: string;
    firstPublicationToken?: string;
    leaseDurationMs?: number;
}

export interface RecordCommitStorageAdapterOptions {
    taskId: string;
    work: RecordCommitStorageAdapterWork;
    paths: RecordCommitStorageAdapterPaths;
    clock: RecordCommitStorageAdapterClock;
    schedulerOwnerLease: SchedulerOwnerLease;
    initializationMode?: "attach" | "cleanup_reopen";
    spool?: RecordSchedulerSpool;
    recordMeta?: Partial<RecordIndexEntry>;
    hooks?: RecordCommitStorageAdapterHooks;
}

export interface RecordCommitStorageAdapterHooks extends RecordCommitProtocolHooks {
    onProtocolCasPoint?(input: {
        commitId: string;
        expectedRevision: number | null;
        initialGuard: boolean;
        point: "after_scheduler_read" | "owner_lock_acquired";
    }): Promise<void> | void;
    onCommitAuthorityHeld?(input: {
        recordWorkKey: string;
        recordCommitEpoch: number;
        detachedCleanup: boolean;
    }): Promise<void> | void;
    onArtifactLockHeldBeforeRegistryAuthority?(input: {
        recordWorkKey: string;
        recordCommitEpoch: number;
        detachedCleanup: boolean;
    }): Promise<void> | void;
    onReaderIndexWritePoint?(input: {
        commitId: string;
        point: "before_replace";
    }): Promise<void> | void;
}

export interface RecordCommitSchedulerRecoveryCallbacks {
    recoverCommit(commitId: string): Promise<RecordCommitAdvanceResult>;
    dispatchProvider(attemptId: string): Promise<unknown>;
}

type StoredProtocolCommit = CommitSnapshot & {
    protocolLedger?: RecordCommitLedger;
};

type CurrentSchedulerLedger = Extract<Awaited<ReturnType<typeof readRecordSchedulerLedgerStore>>, { kind: "current" }>;

export interface RecordWorkPublicationGenerationInput {
    taskId: string;
    recordWorkKey: string;
    identity: CanonicalConversationIdentity;
    dataRoot: string;
    recordStoreHash: string;
    schedulerOwnerLease: SchedulerOwnerLease;
    leaseDurationMs: number;
    nowMsProvider: () => number;
}

export interface RecordWorkPublicationGenerationResult {
    kind: "unchanged" | "rolled_over";
    path: string;
    registry: RecordWorkRegistry;
    work: RecordWorkRegistryEntry;
    lease: RecordWorkOwnerLease;
    fence: FencingToken;
}

export class RecordCommitStorageAdapterError extends Error {
    constructor(message: string, readonly code: "REPAIR_REQUIRED" | "STALE" | "NOT_INITIALIZED") {
        super(message);
        this.name = "RecordCommitStorageAdapterError";
    }
}

export async function reconcileRecordWorkPublicationGeneration(
    input: RecordWorkPublicationGenerationInput,
): Promise<RecordWorkPublicationGenerationResult> {
    if (!isNonEmptyString(input.taskId) || !isNonEmptyString(input.recordWorkKey)) {
        throw new TypeError("publication generation reconciliation 需要 taskId/recordWorkKey");
    }
    if (!path.isAbsolute(input.dataRoot) || !isNonEmptyString(input.recordStoreHash)) {
        throw new TypeError("publication generation reconciliation 需要绝对 dataRoot 与 recordStoreHash");
    }
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
        throw new TypeError("publication generation reconciliation leaseDurationMs 必须为正安全整数");
    }
    if (typeof input.nowMsProvider !== "function") {
        throw new TypeError("publication generation reconciliation 需要 nowMsProvider");
    }
    const readNowMs = (): number => {
        const nowMs = input.nowMsProvider();
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
            throw new TypeError("publication generation reconciliation nowMsProvider 必须返回非负安全整数");
        }
        return nowMs;
    };
    const location: RecordWorkRegistryLocation = { identity: structuredClone(input.identity), dataRoot: path.resolve(input.dataRoot) };
    for (let attempt = 0; attempt < MAX_SCHEDULER_SYNC_RETRIES; attempt += 1) {
        const current = await readRecordWorkRegistry(location);
        if (current.kind !== "ready") {
            throw new RecordCommitStorageAdapterError(`publication generation registry 无法读取: ${current.reason}`, "REPAIR_REQUIRED");
        }
        const work = current.registry.works.find(candidate => candidate.recordWorkKey === input.recordWorkKey);
        if (!work || work.state !== "Active" || !work.ownerLease || !work.activeTaskIds.includes(input.taskId)) {
            throw new RecordCommitStorageAdapterError("publication generation work 缺失、已 superseded、无 lease 或 Task 未挂接", "REPAIR_REQUIRED");
        }
        if (work.ownerLease.ownerId !== input.schedulerOwnerLease.ownerId
            || work.ownerLease.schedulerEpoch !== input.schedulerOwnerLease.schedulerEpoch) {
            throw new RecordCommitStorageAdapterError("publication generation work owner 与 scheduler owner 不一致", "REPAIR_REQUIRED");
        }
        const fence: FencingToken = {
            schedulerEpoch: work.ownerLease.schedulerEpoch,
            recordCommitEpoch: work.recordCommitEpoch,
            fencingToken: work.currentFencingToken,
            workLeaseId: work.ownerLease.workLeaseId,
        };
        if (!work.publicationClaim) {
            return {
                kind: "unchanged",
                path: current.path,
                registry: current.registry,
                work,
                lease: work.ownerLease,
                fence,
            };
        }
        const rolled = await withRecordCommitArtifactLock(input.recordStoreHash, async () => {
            const nowMs = readNowMs();
            return await rolloverRecordWorkPublication({
                ...location,
                recordWorkKey: input.recordWorkKey,
                taskId: input.taskId,
                ownerId: input.schedulerOwnerLease.ownerId,
                fence,
                expectedRegistryRevision: current.registry.registryRevision,
                leaseDurationMs: input.leaseDurationMs,
                nowMs,
                rolloverMode: "force_refresh",
                withArtifactVerification: async (claim, apply) => {
                    const verification = await verifyVisiblePublicationArtifacts(input.recordStoreHash, input.identity, claim);
                    return await apply(verification);
                },
            });
        });
        if (rolled.kind === "rolled_over") {
            return {
                kind: "rolled_over",
                path: rolled.path,
                registry: rolled.registry,
                work: rolled.work,
                lease: rolled.lease,
                fence: rolled.fence,
            };
        }
        if (rolled.kind === "not_required") {
            const lease = rolled.work.ownerLease;
            if (!lease) throw new RecordCommitStorageAdapterError("publication generation no-op 后 lease 丢失", "REPAIR_REQUIRED");
            return {
                kind: "unchanged",
                path: rolled.path,
                registry: rolled.registry,
                work: rolled.work,
                lease,
                fence: {
                    schedulerEpoch: lease.schedulerEpoch,
                    recordCommitEpoch: rolled.work.recordCommitEpoch,
                    fencingToken: rolled.work.currentFencingToken,
                    workLeaseId: lease.workLeaseId,
                },
            };
        }
        if (rolled.kind === "rejected" && rolled.reason === "registry_revision_mismatch") continue;
        if (rolled.kind === "rejected" && rolled.reason === "lease_expired") {
            const reacquired = await acquireRecordWorkLease({
                ...location,
                recordWorkKey: input.recordWorkKey,
                taskId: input.taskId,
                ownerId: input.schedulerOwnerLease.ownerId,
                schedulerEpoch: input.schedulerOwnerLease.schedulerEpoch,
                expectedRegistryRevision: rolled.registryRevision,
                workLeaseId: fence.workLeaseId,
                leaseDurationMs: input.leaseDurationMs,
                nowMs: readNowMs(),
            });
            if (reacquired.kind === "cas_conflict" || reacquired.kind === "acquired") continue;
            throw new RecordCommitStorageAdapterError(`publication generation 过期 lease 续租失败: ${reacquired.kind}`, "REPAIR_REQUIRED");
        }
        const reason = rolled.kind === "rejected"
            ? `${rolled.reason}${rolled.detail ? `: ${rolled.detail}` : ""}`
            : rolled.reason;
        throw new RecordCommitStorageAdapterError(`publication generation rollover 失败: ${reason}`, "REPAIR_REQUIRED");
    }
    throw new RecordCommitStorageAdapterError("publication generation rollover CAS 重试耗尽", "REPAIR_REQUIRED");
}

class RecordCommitInitialGuardError extends Error {
    constructor(
        readonly guard: "cancelled" | "stale" | "repair_required",
        readonly reason: string,
    ) {
        super(reason);
        this.name = "RecordCommitInitialGuardError";
    }
}

export class RecordCommitStorageAdapter implements RecordCommitProtocolAdapter {
    readonly durable: RecordCommitDurableStateAdapter;
    readonly registry: RecordCommitRegistryAdapter;
    readonly io: RecordCommitIoAdapter;
    readonly hooks: RecordCommitStorageAdapterHooks | undefined;

    private readonly taskId: string;
    private readonly work: RecordCommitStorageAdapterWork;
    private readonly paths: Required<RecordCommitStorageAdapterPaths>;
    private readonly clock: RecordCommitStorageAdapterClock;
    private readonly schedulerOwnerLease: SchedulerOwnerLease;
    private readonly initializationMode: "attach" | "cleanup_reopen";
    private readonly spool: RecordSchedulerSpool;
    private readonly recordMeta: Partial<RecordIndexEntry> | undefined;
    private readonly registryLocation: RecordWorkRegistryLocation;
    private readonly artifactIdentities = new Map<string, RecordCommitArtifactIdentity>();
    private readonly reusablePublicationClaims = new Map<string, RecordWorkPublicationClaim>();
    private readonly synchronizedPublicationClaims = new Set<string>();
    private initialized = false;

    constructor(options: RecordCommitStorageAdapterOptions) {
        if (!isNonEmptyString(options.taskId)) throw new TypeError("taskId 必须由调用方显式注入");
        if (!isNonEmptyString(options.work.desiredRevision)) throw new TypeError("work.desiredRevision 必须由调用方显式注入");
        if (!path.isAbsolute(options.paths.dataRoot)) throw new TypeError("paths.dataRoot 必须是绝对路径");
        if (!isNonEmptyString(options.paths.recordStoreHash)) throw new TypeError("paths.recordStoreHash 必须由调用方显式注入");
        if (!options.clock || typeof options.clock.now !== "function" || typeof options.clock.nowMs !== "function") {
            throw new TypeError("clock.now/clock.nowMs 必须由调用方显式注入");
        }
        this.taskId = options.taskId;
        this.work = structuredClone(options.work);
        this.paths = {
            dataRoot: path.resolve(options.paths.dataRoot),
            recordStoreHash: options.paths.recordStoreHash,
            lateResultDirectory: path.resolve(options.paths.lateResultDirectory || path.join(options.paths.dataRoot, "record-commit-late")),
        };
        this.clock = options.clock;
        this.schedulerOwnerLease = structuredClone(options.schedulerOwnerLease);
        this.initializationMode = options.initializationMode || "attach";
        this.hooks = options.hooks;
        this.spool = options.spool || createRecordSchedulerSpool({ dataRoot: this.paths.dataRoot });
        this.recordMeta = options.recordMeta ? structuredClone(options.recordMeta) : undefined;
        this.registryLocation = { identity: structuredClone(this.work.identity), dataRoot: this.paths.dataRoot };
        this.durable = {
            readLedger: commitId => this.readProtocolLedger(commitId),
            compareAndSwapInitialLedger: (commitId, next) => this.compareAndSwapInitialProtocolLedger(commitId, next),
            compareAndSwapLedger: (commitId, expectedRevision, next) => this.compareAndSwapProtocolLedger(commitId, expectedRevision, next),
        };
        this.registry = {
            validate: (binding, purpose) => this.validateRegistry(binding, purpose),
            readSharedWork: binding => this.readSharedWork(binding),
            detachTask: binding => this.detachTask(binding),
        };
        this.io = {
            validateTarget: input => this.validateTarget(input.binding, input.target, input.expectedKind),
            validateBodyRef: input => this.validateBodyRef(input.binding, input.bodyRef),
            readBodyRef: input => this.readBodyRef(input.binding, input.bodyRef, input.maxBytes),
            captureBodyBeforeImage: input => this.captureBodyBeforeImage(input.commitId, input.binding, input.target, input.maxBytes),
            stageBody: input => this.stageBody(input.commitId, input.binding, input.bodyRef, input.bodyHash, input.byteLength, input.maxBytes),
            readStagedBody: commitId => this.readStagedBody(commitId),
            publishBody: input => this.publishBody(input),
            readBody: target => this.readBody(target),
            writeMainIndex: input => this.writeMainIndex(input),
            readMainIndex: target => this.readMainIndex(target),
            writeReaderIndex: input => this.writeReaderIndex(input),
            readReaderIndex: target => this.readReaderIndex(target),
            discardStagedBodyIfOwned: input => this.discardStagedBodyIfOwned(input.commitId, input.binding),
            restoreBodyIfOwned: input => this.restoreBodyIfOwned(input),
            restoreMainIndexIfOwned: input => this.restoreMainIndexIfOwned(input),
            rebuildReaderIndexFromBody: input => this.rebuildReaderIndexFromBody(input),
            verifyTaskExclusiveResultsInvisible: input => this.verifyTaskExclusiveResultsInvisible(input),
            isolateLateOutput: input => this.isolateLateOutput(input),
        };
    }

    hash(value: string): string {
        return sha256(value);
    }

    byteLength(value: string): number {
        return Buffer.byteLength(value, "utf8");
    }

    now(): string {
        return this.clock.now();
    }

    async materializeCommitPayloadMetadata(input: {
        binding: RecordCommitBinding;
        payload: Omit<RecordCommitPayload, "mainIndexMetadata">;
    }): Promise<RecordCommitPayloadMetadata> {
        this.assertInitialized();
        const ready = await this.requireReadyRegistry();
        const work = ready.registry.works.find(candidate => candidate.recordWorkKey === input.binding.recordWorkKey);
        const existingClaim = work?.publicationClaim;
        if (existingClaim
            && existingClaim.inputHash === input.binding.inputHash
            && existingClaim.bodyHash === input.payload.bodyHash
            && existingClaim.coveredRevision === input.payload.coveredRevision) {
            const identity = this.artifactIdentityFromPublicationClaim(input.binding, existingClaim, input.payload.byteLength);
            if (!identity.recordIndexMetadata || !identity.recordIndexMetadataHash) {
                throw new RecordCommitVerificationError("publication_claim_metadata_missing");
            }
            return {
                snapshot: structuredClone(identity.recordIndexMetadata) as unknown as JsonValue,
                hash: identity.recordIndexMetadataHash,
            };
        }
        const identity = this.artifactIdentity(
            input.binding,
            input.payload.mainIndexEntry.commitId,
            input.payload.coveredRevision,
            input.payload.bodyHash,
            input.payload.byteLength,
        );
        if (!identity.recordIndexMetadata || !identity.recordIndexMetadataHash) {
            throw new RecordCommitVerificationError("publication_identity_metadata_missing");
        }
        return {
            snapshot: structuredClone(identity.recordIndexMetadata) as unknown as JsonValue,
            hash: identity.recordIndexMetadataHash,
        };
    }

    async isTaskCancelled(taskId: string): Promise<boolean> {
        if (taskId !== this.taskId) return true;
        const current = await this.readSchedulerLedger();
        if (!current) return true;
        return ["CancelRequested", "Cancelling", "Cancelled"].includes(current.ledger.task.state);
    }

    async initialize(): Promise<this> {
        if (this.initialized) return this;
        const spoolMode = this.initializationMode === "cleanup_reopen" ? "open" : "create";
        await this.spool.initializeRoot({ mode: spoolMode });
        await this.spool.initializeTask({ taskId: this.taskId, mode: spoolMode });
        if (this.initializationMode === "cleanup_reopen") {
            const scheduler = await this.requireSchedulerLedger();
            this.assertSchedulerOwner(scheduler.ledger);
            const schedulerWork = this.requireSchedulerWork(scheduler.ledger);
            const registry = await this.requireReadyRegistry();
            const registryWork = registry.registry.works.find(candidate => candidate.recordWorkKey === schedulerWork.recordWorkKey);
            if (!registryWork
                || registryWork.recordCommitEpoch !== schedulerWork.recordCommitEpoch
                || registryWork.currentFencingToken !== schedulerWork.currentFencingToken
                || registry.registry.registryRevision !== schedulerWork.registryRevision) {
                throw new RecordCommitStorageAdapterError("cleanup reopen 的 scheduler/registry work authority 不一致", "STALE");
            }
            this.initialized = true;
            return this;
        }
        await this.ensureRegistryPublished();
        const scheduler = await this.requireSchedulerLedger();
        this.assertSchedulerOwner(scheduler.ledger);
        const schedulerWork = this.requireSchedulerWork(scheduler.ledger);
        const registry = await this.requireReadyRegistry();
        const started = await startOrAttachRecordWork({
            ...this.registryLocation,
            desiredRevision: this.work.desiredRevision,
            taskId: this.taskId,
            expectedRegistryRevision: registry.registry.registryRevision,
            nowMs: this.clock.nowMs(),
        });
        if (started.kind !== "started") throw this.registryFailure("start_or_attach", started);
        if (started.work.recordWorkKey !== schedulerWork.recordWorkKey || started.work.recordCommitEpoch !== schedulerWork.recordCommitEpoch) {
            throw new RecordCommitStorageAdapterError("registry start/attach 与 scheduler record work 的 key/epoch 不一致", "REPAIR_REQUIRED");
        }
        const nowMs = this.clock.nowMs();
        const reusableLease = started.work.ownerLease;
        const workLeaseId = reusableLease
            && reusableLease.ownerId === this.schedulerOwnerLease.ownerId
            && reusableLease.schedulerEpoch === this.schedulerOwnerLease.schedulerEpoch
            && Date.parse(reusableLease.expiresAt) > nowMs
            ? reusableLease.workLeaseId
            : schedulerWork.workLeaseId;
        let acquired = await acquireRecordWorkLease({
            ...this.registryLocation,
            recordWorkKey: started.work.recordWorkKey,
            taskId: this.taskId,
            ownerId: this.schedulerOwnerLease.ownerId,
            schedulerEpoch: this.schedulerOwnerLease.schedulerEpoch,
            expectedRegistryRevision: started.registry.registryRevision,
            workLeaseId,
            leaseDurationMs: this.work.leaseDurationMs,
            nowMs,
        });
        if (acquired.kind === "lease_held"
            && acquired.lease.ownerId === this.schedulerOwnerLease.ownerId
            && acquired.lease.schedulerEpoch === this.schedulerOwnerLease.schedulerEpoch
            && acquired.work.activeTaskIds.includes(this.taskId)) {
            acquired = await acquireRecordWorkLease({
                ...this.registryLocation,
                recordWorkKey: acquired.work.recordWorkKey,
                taskId: this.taskId,
                ownerId: this.schedulerOwnerLease.ownerId,
                schedulerEpoch: this.schedulerOwnerLease.schedulerEpoch,
                expectedRegistryRevision: acquired.registry.registryRevision,
                workLeaseId: acquired.lease.workLeaseId,
                leaseDurationMs: this.work.leaseDurationMs,
                nowMs,
            });
        }
        if (acquired.kind !== "acquired") throw this.registryFailure("acquire_lease", acquired);
        await this.syncRegistryWorkIntoScheduler(acquired.registry, acquired.work, acquired.lease, acquired.fence);
        this.initialized = true;
        return this;
    }

    async recoverFromSchedulerLedger(
        callbacks: RecordCommitSchedulerRecoveryCallbacks,
    ): Promise<Array<{ commitId: string; result: RecordCommitAdvanceResult }>> {
        this.assertInitialized();
        const current = await this.requireSchedulerLedger();
        this.assertSchedulerOwner(current.ledger);
        const commitIds = current.ledger.commits
            .filter(commit => isProtocolLedger((commit as StoredProtocolCommit).protocolLedger))
            .map(commit => commit.commitId)
            .sort();
        const recovered: Array<{ commitId: string; result: RecordCommitAdvanceResult }> = [];
        for (const commitId of commitIds) {
            recovered.push({ commitId, result: await callbacks.recoverCommit(commitId) });
        }
        return recovered;
    }

    private async ensureRegistryPublished(): Promise<void> {
        if (!this.work.firstPublicationToken) {
            throw new RecordCommitStorageAdapterError("record work registry 未注入 firstPublicationToken，拒绝信任 ready registry", "REPAIR_REQUIRED");
        }
        const prepared = await initializeRecordWorkRegistryIdentity(this.registryLocation, {
            firstPublicationToken: this.work.firstPublicationToken,
            nowMs: this.clock.nowMs(),
        });
        if (prepared.kind === "repair_required" || prepared.kind === "publication_rejected") {
            throw this.registryFailure("initialize_registry", prepared);
        }
        const created = await createRecordWorkRegistry(this.registryLocation, {
            firstPublicationToken: this.work.firstPublicationToken,
            nowMs: this.clock.nowMs(),
        });
        if (created.kind !== "created" && created.kind !== "already_exists") {
            throw this.registryFailure("create_registry", created);
        }
        const existing = await readRecordWorkRegistry(this.registryLocation);
        if (existing.kind !== "ready") throw this.registryFailure("read_published_registry", existing);
    }

    private async syncRegistryWorkIntoScheduler(
        registry: RecordWorkRegistry,
        work: { recordWorkKey: string; recordCommitEpoch: number; activeTaskIds: string[]; currentFencingToken: number },
        lease: { workLeaseId: string; ownerId: string; schedulerEpoch: number; expiresAt: string },
        fence: FencingToken,
    ): Promise<void> {
        const registryRef = await this.registryReference(registry.persistedHash, registry.registryRevision);
        for (let index = 0; index < MAX_SCHEDULER_SYNC_RETRIES; index += 1) {
            const current = await this.requireSchedulerLedger();
            this.assertSchedulerOwner(current.ledger);
            try {
                await mutateRecordSchedulerLedgerAsOwner(this.taskId, current.ledger.revision, this.schedulerOwnerLease, ledger => {
                    const item = this.requireSchedulerWork(ledger);
                    if (item.recordWorkKey !== work.recordWorkKey || item.recordCommitEpoch !== work.recordCommitEpoch) {
                        throw new RecordCommitStorageAdapterError("registry lease 回写时 record work 已切换", "STALE");
                    }
                    item.registryRevision = registry.registryRevision;
                    item.registryRef = registryRef;
                    item.schedulerEpoch = lease.schedulerEpoch;
                    item.workLeaseId = lease.workLeaseId;
                    item.leaseOwnerId = lease.ownerId;
                    item.leaseExpiresAt = lease.expiresAt;
                    item.activeTaskIds = [...work.activeTaskIds];
                    item.currentFencingToken = fence.fencingToken;
                    const currentFence = {
                        schedulerEpoch: lease.schedulerEpoch,
                        recordCommitEpoch: item.recordCommitEpoch,
                        fencingToken: fence.fencingToken,
                        workLeaseId: lease.workLeaseId,
                    };
                    for (const attempt of ledger.attempts) {
                        if (attempt.recordWorkKey !== item.recordWorkKey || !["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(attempt.state)) continue;
                        attempt.fence = { ...currentFence };
                    }
                    for (const commit of ledger.commits) {
                        if (commit.recordWorkKey !== item.recordWorkKey
                            || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
                        commit.fence = { ...currentFence };
                        if (commit.beforeImage) commit.beforeImage.fence = { ...currentFence };
                        if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...currentFence };
                    }
                }, { nowMs: this.clock.nowMs() });
                return;
            } catch (error) {
                if (isSchedulerRevisionConflict(error)) continue;
                throw error;
            }
        }
        throw new RecordCommitStorageAdapterError("registry lease 已持久化，但 scheduler ledger 同步 CAS 重试耗尽", "REPAIR_REQUIRED");
    }

    private async registryReference(hash: string, revision: number): Promise<ImmutableBlobReference> {
        const ready = await this.requireReadyRegistry();
        if (ready.registry.registryRevision !== revision || ready.registry.persistedHash !== hash) {
            throw new RecordCommitStorageAdapterError("registry 回读 revision/hash 与待同步值不一致", "REPAIR_REQUIRED");
        }
        const stat = await fs.stat(ready.path);
        return {
            path: toPortableRelative(this.paths.dataRoot, ready.path),
            hash,
            byteLength: stat.size,
        };
    }

    private async readProtocolLedger(commitId: string): Promise<unknown | null> {
        this.assertInitialized();
        const current = await this.readSchedulerLedger();
        if (!current) return { kind: "repair_required" };
        const commit = current.ledger.commits.find(candidate => candidate.commitId === commitId) as StoredProtocolCommit | undefined;
        return commit?.protocolLedger ? structuredClone(commit.protocolLedger) : null;
    }

    private async compareAndSwapInitialProtocolLedger(
        commitId: string,
        next: RecordCommitLedger,
    ): Promise<RecordCommitInitialLedgerCasResult> {
        return this.compareAndSwapProtocolLedgerInternal(commitId, null, next, true);
    }

    private async compareAndSwapProtocolLedger(
        commitId: string,
        expectedRevision: number | null,
        next: RecordCommitLedger,
    ): Promise<{ kind: "written" } | { kind: "conflict" }> {
        const result = await this.compareAndSwapProtocolLedgerInternal(commitId, expectedRevision, next, false);
        if (result.kind === "rejected") throw new Error("非 initial protocol CAS 不应返回 initial guard 拒绝");
        return result;
    }

    private async compareAndSwapProtocolLedgerInternal(
        commitId: string,
        expectedRevision: number | null,
        next: RecordCommitLedger,
        initialGuard: boolean,
    ): Promise<RecordCommitInitialLedgerCasResult> {
        this.assertInitialized();
        if (next.commitId !== commitId) throw new TypeError("CAS commitId 与 ledger.commitId 不一致");
        const current = await this.readSchedulerLedger();
        if (!current) {
            if (initialGuard) return { kind: "rejected", guard: "repair_required", reason: "scheduler ledger 损坏，拒绝首次 protocol ledger 写入" };
            throw new RecordCommitStorageAdapterError("scheduler ledger 损坏，拒绝写入 protocol ledger", "REPAIR_REQUIRED");
        }
        await this.hooks?.onProtocolCasPoint?.({ commitId, expectedRevision, initialGuard, point: "after_scheduler_read" });
        try {
            const stored = await mutateRecordSchedulerLedgerAsOwner(this.taskId, current.ledger.revision, this.schedulerOwnerLease, async ledger => {
                this.assertSchedulerOwner(ledger);
                await this.hooks?.onProtocolCasPoint?.({ commitId, expectedRevision, initialGuard, point: "owner_lock_acquired" });
                const existing = ledger.commits.find(candidate => candidate.commitId === commitId) as StoredProtocolCommit | undefined;
                const actualRevision = existing?.protocolLedger?.revision ?? null;
                if (actualRevision !== expectedRevision) {
                    throw new RecordCommitStorageAdapterError("protocol ledger revision CAS 冲突", "STALE");
                }
                if (initialGuard) this.assertInitialSchedulerGuard(ledger, next);
                const auditOnlyTransition = existing?.protocolLedger !== undefined
                    && next.audit.length > existing.protocolLedger.audit.length;
                const safetyTransition = next.repairState !== null || next.lifecycle !== "Active" || auditOnlyTransition;
                let authority: ConditionalCommitAuthorization | null;
                try {
                    authority = await this.authorizeBinding(next.binding);
                } catch (error) {
                    if (!(safetyTransition && error instanceof RecordCommitStorageAdapterError && error.code === "REPAIR_REQUIRED")) throw error;
                    authority = null;
                }
                if (!authority && !safetyTransition) {
                    if (initialGuard) throw new RecordCommitInitialGuardError("stale", "registry owner lease、epoch 或 fencing 已变化");
                    throw new RecordCommitStorageAdapterError("scheduler/registry owner lease、epoch 或 fencing 已变化", "STALE");
                }
                const schedulerWork = this.requireSchedulerWork(ledger);
                const effectiveAuthority = authority || {
                    path: "scheduler-owner-safety-transition",
                    registryRevision: schedulerWork.registryRevision,
                    identity: structuredClone(this.work.identity),
                    recordWorkKey: schedulerWork.recordWorkKey,
                    recordCommitEpoch: schedulerWork.recordCommitEpoch,
                    fence: {
                        schedulerEpoch: schedulerWork.schedulerEpoch,
                        recordCommitEpoch: schedulerWork.recordCommitEpoch,
                        fencingToken: schedulerWork.currentFencingToken,
                        workLeaseId: schedulerWork.workLeaseId,
                    },
                };
                const snapshot = await this.materializeCommitSnapshot(ledger, existing, next, effectiveAuthority);
                const index = ledger.commits.findIndex(candidate => candidate.commitId === commitId);
                if (index < 0) ledger.commits.push(snapshot);
                else ledger.commits[index] = snapshot;
                this.updateUnitProjection(ledger, snapshot);
            }, { nowMs: this.clock.nowMs() });
            if (!stored.ledger.commits.some(candidate => candidate.commitId === commitId)) {
                throw new RecordCommitStorageAdapterError("scheduler ledger CAS 写后未找到目标 commit", "REPAIR_REQUIRED");
            }
            return { kind: "written" };
        } catch (error) {
            if (isSchedulerRevisionConflict(error)) return { kind: "conflict" };
            if (initialGuard && error instanceof RecordCommitInitialGuardError) {
                return { kind: "rejected", guard: error.guard, reason: error.reason };
            }
            if (initialGuard && error instanceof RecordCommitStorageAdapterError) {
                return {
                    kind: "rejected",
                    guard: error.code === "REPAIR_REQUIRED" ? "repair_required" : "stale",
                    reason: error.message,
                };
            }
            if (error instanceof RecordCommitStorageAdapterError && error.code === "STALE") return { kind: "conflict" };
            throw error;
        }
    }

    private assertInitialSchedulerGuard(ledger: PersistedRecordSchedulerLedger, next: RecordCommitLedger): void {
        if (next.revision !== 1
            || next.stage !== "ResultReady"
            || next.lifecycle !== "Active"
            || next.confirmedStages.length !== 1
            || next.confirmedStages[0] !== "ResultReady") {
            throw new RecordCommitInitialGuardError("repair_required", "首次 protocol ledger 不是规范的 Active/ResultReady revision 1");
        }
        if (["CancelRequested", "Cancelling", "Cancelled"].includes(ledger.task.state)) {
            throw new RecordCommitInitialGuardError("cancelled", `scheduler task 已处于 ${ledger.task.state}`);
        }
        const binding = next.binding;
        const work = ledger.recordWork.find(candidate => candidate.recordWorkKey === binding.recordWorkKey);
        const source = ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === binding.sourceSnapshotId);
        const unit = ledger.units.find(candidate => candidate.unitId === binding.unitId);
        const attempt = ledger.attempts.find(candidate => candidate.attemptId === binding.attemptId);
        const leaseExpired = work ? Date.parse(work.leaseExpiresAt) <= this.clock.nowMs() : true;
        if (!this.bindingMatchesInjectedWork(binding)
            || ledger.task.taskId !== binding.taskId
            || !work
            || work.conversationId !== binding.conversationId
            || work.recordWorkKey !== binding.recordWorkKey
            || work.workLeaseId !== binding.workLeaseId
            || work.recordCommitEpoch !== binding.recordCommitEpoch
            || work.currentFencingToken !== binding.fencingToken
            || work.schedulerEpoch !== this.schedulerOwnerLease.schedulerEpoch
            || work.leaseOwnerId !== this.schedulerOwnerLease.ownerId
            || leaseExpired
            || !work.activeTaskIds.includes(binding.taskId)
            || !source
            || source.conversationId !== binding.conversationId
            || source.chain !== this.work.identity.chain
            || source.workspaceHash !== this.work.identity.workspaceHash
            || source.desiredRevision !== work.desiredRevision
            || next.payload.coveredRevision !== work.desiredRevision
            || !unit
            || unit.taskId !== binding.taskId
            || unit.recordWorkKey !== binding.recordWorkKey
            || unit.sourceSnapshotId !== binding.sourceSnapshotId
            || unit.inputHash !== binding.inputHash
            || !attempt
            || attempt.unitId !== binding.unitId
            || attempt.recordWorkKey !== binding.recordWorkKey
            || attempt.inputHash !== binding.inputHash
            || !attempt.activeTaskIds.includes(binding.taskId)
            || attempt.fence.schedulerEpoch !== work.schedulerEpoch
            || attempt.fence.recordCommitEpoch !== binding.recordCommitEpoch
            || attempt.fence.fencingToken !== binding.fencingToken
            || attempt.fence.workLeaseId !== binding.workLeaseId) {
            throw new RecordCommitInitialGuardError("stale", "scheduler work lease、epoch、fencing、sourceSnapshot 或 inputHash 已变化");
        }
    }

    private async materializeCommitSnapshot(
        ledger: PersistedRecordSchedulerLedger,
        previous: StoredProtocolCommit | undefined,
        protocol: RecordCommitLedger,
        authorization: ConditionalCommitAuthorization,
    ): Promise<StoredProtocolCommit> {
        const source = ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === protocol.binding.sourceSnapshotId);
        const work = this.requireSchedulerWork(ledger);
        const unit = ledger.units.find(candidate => candidate.unitId === protocol.binding.unitId);
        const attempt = ledger.attempts.find(candidate => candidate.attemptId === protocol.binding.attemptId);
        if (!source || !unit || !attempt
            || work.recordWorkKey !== protocol.binding.recordWorkKey
            || unit.recordWorkKey !== protocol.binding.recordWorkKey
            || unit.sourceSnapshotId !== protocol.binding.sourceSnapshotId
            || unit.inputHash !== protocol.binding.inputHash
            || attempt.recordWorkKey !== protocol.binding.recordWorkKey
            || attempt.unitId !== unit.unitId
            || attempt.inputHash !== protocol.binding.inputHash) {
            throw new RecordCommitStorageAdapterError("scheduler commit 与 unit/attempt/source/work 绑定不完整", "REPAIR_REQUIRED");
        }
        const bodyRef = this.spoolReferenceFromBodyRef(protocol.payload.bodyRef);
        if (bodyRef.hash !== protocol.payload.bodyHash || bodyRef.byteLength !== protocol.payload.byteLength) {
            throw new RecordCommitStorageAdapterError("protocol bodyRef 与 payload hash/bytes 不一致", "REPAIR_REQUIRED");
        }
        if (attempt.state !== "KnownSuccess" || attempt.outputRef === undefined
            || !sameBlobReference(attempt.outputRef, bodyRef)) {
            throw new RecordCommitStorageAdapterError("提交前 attempt 必须是绑定同一 spool output 的 KnownSuccess", "REPAIR_REQUIRED");
        }
        const state = await this.schedulerCommitState(protocol, previous);
        const ownership = state === "CleanupPending" || state === "Compensated"
            ? { mode: "task_exclusive" as const, ownerTaskId: this.taskId }
            : work.activeTaskIds.length > 1
                ? { mode: "shared" as const, ownerTaskIds: [...work.activeTaskIds].sort() }
                : { mode: "task_exclusive" as const, ownerTaskId: this.taskId };
        const fence: FencingToken = {
            schedulerEpoch: work.schedulerEpoch,
            recordCommitEpoch: protocol.binding.recordCommitEpoch,
            fencingToken: protocol.binding.fencingToken,
            workLeaseId: protocol.binding.workLeaseId,
        };
        const beforeImage = protocol.beforeImages
            ? await this.materializeBeforeImage(protocol, fence)
            : undefined;
        const indexEvidence = this.indexEvidence(protocol);
        const snapshot: StoredProtocolCommit = {
            schemaVersion: RECORD_SCHEDULER_SCHEMA_VERSION,
            commitId: protocol.commitId,
            taskId: this.taskId,
            unitId: protocol.binding.unitId,
            attemptId: protocol.binding.attemptId,
            recordWorkKey: protocol.binding.recordWorkKey,
            sourceSnapshotId: protocol.binding.sourceSnapshotId,
            inputHash: protocol.binding.inputHash,
            outputHash: protocol.payload.bodyHash,
            qualityResult: { accepted: true },
            bodyRef,
            bodyHash: protocol.payload.bodyHash,
            ownership,
            observedSourceRevisionAtCommit: source.desiredRevision,
            state,
            cleanupPhase: state === "Compensated" ? "Verified" : state === "CleanupPending" ? "CleanupIntentPersisted" : "NotRequired",
            successConditions: state === "Verified" ? {
                candidateSnapshotFrozen: true,
                sourceSnapshotPersisted: true,
                modelOutputBoundAndQualified: true,
                bodyAtomicallyWritten: true,
                mainIndexPublished: true,
                readerIndexConsistent: true,
                ledgerConsistent: true,
                readBackVerified: true,
            } : {
                candidateSnapshotFrozen: false,
                sourceSnapshotPersisted: false,
                modelOutputBoundAndQualified: false,
                bodyAtomicallyWritten: false,
                mainIndexPublished: false,
                readerIndexConsistent: false,
                ledgerConsistent: false,
                readBackVerified: false,
            },
            fence,
            protocolLedger: structuredClone(protocol),
        };
        if (beforeImage) snapshot.beforeImage = beforeImage;
        if (state === "Verified") {
            snapshot.coveredRevision = protocol.payload.coveredRevision;
            snapshot.mainIndexRevision = protocol.payload.coveredRevision;
            snapshot.readerIndexRevision = protocol.payload.coveredRevision;
            snapshot.mainIndexEntry = indexEvidence.main;
            snapshot.readerIndexEntry = indexEvidence.reader;
            snapshot.verifiedAt = protocol.updatedAt;
            snapshot.readBack = {
                verifiedAt: protocol.updatedAt,
                bodyHash: protocol.payload.bodyHash,
                mainIndexRevision: protocol.payload.coveredRevision,
                readerIndexRevision: protocol.payload.coveredRevision,
                mainIndexEntry: structuredClone(indexEvidence.main),
                readerIndexEntry: structuredClone(indexEvidence.reader),
            };
        }
        if (state === "Compensated") {
            const cleanup = await this.buildCleanupReadBack(protocol, beforeImage, authorization.registryRevision, fence);
            if (!cleanup) {
                snapshot.state = "CleanupPending";
                snapshot.cleanupPhase = "CleanupIntentPersisted";
            } else {
                snapshot.cleanupReadBack = cleanup;
            }
        }
        return snapshot;
    }

    private async schedulerCommitState(protocol: RecordCommitLedger, previous: StoredProtocolCommit | undefined): Promise<CommitSnapshot["state"]> {
        if (protocol.repairState) return protocol.beforeImages ? "RepairRequired" : protocol.stage;
        if (protocol.lifecycle === "Detached") return "Abandoned";
        if (protocol.lifecycle === "Cancelling") return protocol.beforeImages ? "CleanupPending" : "Abandoned";
        if (protocol.lifecycle === "Cancelled") return protocol.beforeImages ? "Compensated" : "Abandoned";
        if (previous?.state === "CleanupPending" || previous?.state === "Compensated") return previous.state;
        return protocol.stage;
    }

    private indexEvidence(protocol: RecordCommitLedger) {
        const base = {
            revision: protocol.payload.coveredRevision,
            commitId: protocol.commitId,
            recordWorkKey: protocol.binding.recordWorkKey,
            sourceSnapshotId: protocol.binding.sourceSnapshotId,
            bodyHash: protocol.payload.bodyHash,
            coveredRevision: protocol.payload.coveredRevision,
        };
        return {
            main: { ...base, entryHash: calculateRecordCommitArtifactJsonHash(protocol.payload.mainIndexEntry) },
            reader: { ...base, entryHash: calculateRecordCommitArtifactJsonHash(protocol.payload.readerIndex) },
        };
    }

    private async materializeBeforeImage(protocol: RecordCommitLedger, fence: FencingToken): Promise<NonNullable<CommitSnapshot["beforeImage"]>> {
        const images = protocol.beforeImages!;
        return {
            commitId: protocol.commitId,
            capturedAt: images.capturedAt,
            body: images.body.bodyRef === null ? {
                path: protocol.payload.bodyTarget.relativePath,
                existed: false,
            } : {
                path: protocol.payload.bodyTarget.relativePath,
                existed: true,
                revision: images.body.revision || LEGACY_BEFORE_IMAGE_REVISION,
                hash: images.body.bodyHash!,
                contentRef: this.spoolReferenceFromBodyRef(images.body.bodyRef),
            },
            mainIndexEntry: await this.jsonBeforeImage(protocol.payload.mainIndexTarget.relativePath, images.mainIndex),
            readerIndexEntry: await this.jsonBeforeImage(protocol.payload.readerIndexTarget.relativePath, images.readerIndex),
            fence,
        };
    }

    private async jsonBeforeImage(targetPath: string, image: RecordCommitJsonImage) {
        if (image.value === null) return { path: targetPath, existed: false };
        const content = canonicalJson(image.value);
        const reference = await this.writeSpoolObject("output", content);
        if (reference.hash !== image.hash) {
            throw new RecordCommitStorageAdapterError("JSON before-image spool hash 与 artifact hash 不一致", "REPAIR_REQUIRED");
        }
        return {
            path: targetPath,
            existed: true,
            revision: image.revision || LEGACY_BEFORE_IMAGE_REVISION,
            hash: image.hash!,
            contentRef: reference,
        };
    }

    private async buildCleanupReadBack(
        protocol: RecordCommitLedger,
        beforeImage: CommitSnapshot["beforeImage"] | undefined,
        registryRevision: number,
        fence: FencingToken,
    ): Promise<CleanupReadBackVerification | null> {
        if (!beforeImage) return null;
        const [body, main, reader] = await Promise.all([
            this.readBody(protocol.payload.bodyTarget),
            this.readMainIndex(protocol.payload.mainIndexTarget),
            this.readReaderIndex(protocol.payload.readerIndexTarget),
        ]);
        const bodyProof = cleanupTarget(beforeImage.body, body.bodyHash, body.revision, body.ownerCommitId);
        const mainProof = cleanupTarget(beforeImage.mainIndexEntry, main.hash, main.revision, main.ownerCommitId);
        const readerProof = cleanupTarget(beforeImage.readerIndexEntry, reader.hash, reader.revision, reader.ownerCommitId);
        if (!bodyProof || !mainProof || !readerProof) return null;
        return {
            commitId: protocol.commitId,
            taskId: this.taskId,
            recordWorkKey: protocol.binding.recordWorkKey,
            verifiedAt: protocol.updatedAt,
            registryRevision,
            body: bodyProof,
            mainIndexEntry: mainProof,
            readerIndexEntry: readerProof,
            fence,
        };
    }

    private updateUnitProjection(ledger: PersistedRecordSchedulerLedger, snapshot: CommitSnapshot): void {
        const unit = ledger.units.find(candidate => candidate.unitId === snapshot.unitId);
        if (!unit) return;
        if (snapshot.state === "Verified") {
            unit.state = "Succeeded";
            unit.commitId = snapshot.commitId;
            unit.coveredRevision = snapshot.coveredRevision;
            ledger.task.recordItems.succeeded = ledger.units.filter(candidate => candidate.state === "Succeeded" && candidate.layer === "local-finalize").length;
            ledger.task.units.done = ledger.units.filter(candidate => candidate.state === "Succeeded" || candidate.state === "Cancelled" || candidate.state === "Discarded" || candidate.state === "Superseded").length;
            ledger.task.units.running = ledger.units.filter(candidate => candidate.state === "Running" || candidate.state === "Committing").length;
        }
    }

    private async validateRegistry(binding: RecordCommitBinding, purpose: "commit" | "cleanup"): Promise<RecordCommitRegistryEvidence> {
        this.assertInitialized();
        let authorization: ConditionalCommitAuthorization | null;
        try {
            authorization = await this.authorizeBinding(binding, { allowDetachedCleanup: purpose === "cleanup" });
        } catch (error) {
            if (error instanceof RecordCommitStorageAdapterError && error.code === "REPAIR_REQUIRED") {
                return { kind: "repair_required", reason: error.message };
            }
            throw error;
        }
        if (!authorization) return { kind: "stale", reason: "scheduler_owner_or_registry_fence_changed" };
        return {
            kind: "authorized",
            recordWorkKey: binding.recordWorkKey,
            workLeaseId: binding.workLeaseId,
            recordCommitEpoch: binding.recordCommitEpoch,
            fencingToken: binding.fencingToken,
            sourceSnapshotId: binding.sourceSnapshotId,
            inputHash: binding.inputHash,
        };
    }

    private async authorizeBinding(
        binding: RecordCommitBinding,
        options: { allowDetachedCleanup?: boolean; detachedCleanupMustBeExclusive?: boolean } = {},
    ): Promise<ConditionalCommitAuthorization | null> {
        const input = await this.commitAuthorityInput(binding);
        if (!input) return null;
        const authorized = await authorizeRecordWorkCommit(input);
        if (authorized.kind === "authorized") return authorized.authorization;
        if (authorized.kind === "repair_required") return this.throwRegistryRepair(authorized.reason);
        if (!options.allowDetachedCleanup) return null;
        return this.authorizeDetachedCleanup({ ...input, nowMs: this.clock.nowMs() }, Boolean(options.detachedCleanupMustBeExclusive));
    }

    private async commitAuthorityInput(binding: RecordCommitBinding): Promise<ConditionalCommitAuthorizationInput | null> {
        if (!this.bindingMatchesInjectedWork(binding)) return null;
        const scheduler = await this.readSchedulerLedger();
        if (!scheduler) throw new RecordCommitStorageAdapterError("scheduler ledger 读取失败", "REPAIR_REQUIRED");
        try {
            this.assertSchedulerOwner(scheduler.ledger);
        } catch (error) {
            if (error instanceof RecordCommitStorageAdapterError && error.code === "STALE") return null;
            throw error;
        }
        const work = scheduler.ledger.recordWork.find(candidate => candidate.recordWorkKey === binding.recordWorkKey);
        if (!work
            || work.registryRevision === undefined
            || work.workLeaseId !== binding.workLeaseId
            || work.recordCommitEpoch !== binding.recordCommitEpoch
            || work.currentFencingToken !== binding.fencingToken
            || work.schedulerEpoch !== this.schedulerOwnerLease.schedulerEpoch) return null;
        const fence: FencingToken = {
            schedulerEpoch: work.schedulerEpoch,
            recordCommitEpoch: binding.recordCommitEpoch,
            fencingToken: binding.fencingToken,
            workLeaseId: binding.workLeaseId,
        };
        const input = {
            ...this.registryLocation,
            recordWorkKey: binding.recordWorkKey,
            taskId: this.taskId,
            ownerId: this.schedulerOwnerLease.ownerId,
            fence,
            expectedRegistryRevision: work.registryRevision,
            nowMs: this.clock.nowMs(),
        };
        return input;
    }

    private async withPhysicalArtifactAuthority<Value>(
        binding: RecordCommitBinding,
        operation: () => Promise<Value>,
        options: { allowDetachedCleanup?: boolean; detachedCleanupMustBeExclusive?: boolean } = {},
        publication?: RecordWorkPublicationClaimInput,
    ): Promise<Value> {
        await this.hooks?.onArtifactLockHeldBeforeRegistryAuthority?.({
            recordWorkKey: binding.recordWorkKey,
            recordCommitEpoch: binding.recordCommitEpoch,
            detachedCleanup: Boolean(options.allowDetachedCleanup),
        });
        const input = await this.commitAuthorityInput(binding);
        if (!input) throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
        const execute = async () => {
            if (!await this.commitAuthorityInput(binding)) throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
            await this.hooks?.onCommitAuthorityHeld?.({
                recordWorkKey: binding.recordWorkKey,
                recordCommitEpoch: binding.recordCommitEpoch,
                detachedCleanup: Boolean(options.allowDetachedCleanup),
            });
            const value = await operation();
            if (!await this.commitAuthorityInput(binding)) throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
            return value;
        };
        if (publication) {
            const committed = await withRecordWorkPublicationAuthority(publication, async () => execute(), options);
            if (committed.kind === "committed") return committed.value;
            if (committed.kind === "repair_required") this.throwRegistryRepair(committed.reason);
            if (committed.kind === "reused") throw new RecordCommitVerificationError("already_published_reused");
            if (committed.kind === "conflict") throw new RecordCommitVerificationError("already_published_conflict");
            if (committed.kind === "claim_missing") throw new RecordCommitVerificationError("publication_claim_missing");
            throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
        }
        const committed = await withRecordWorkCommitAuthority(input, async () => execute(), options);
        if (committed.kind === "committed") return committed.value;
        if (committed.kind === "repair_required") this.throwRegistryRepair(committed.reason);
        throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
    }

    private publicationIdentityKey(binding: RecordCommitBinding, commitId: string): string {
        return `${binding.recordWorkKey}\u0000${commitId}`;
    }

    private artifactIdentity(
        binding: RecordCommitBinding,
        commitId: string,
        coveredRevision: string,
        bodyHash: string,
        byteLength: number,
        persistedMetadata?: RecordCommitPayloadMetadata,
    ): RecordCommitArtifactIdentity {
        const key = this.publicationIdentityKey(binding, commitId);
        const metadata = persistedMetadata
            ? this.metadataSnapshotFromPersistedPayload(binding, byteLength, persistedMetadata)
            : createRecordIndexEntryMetadataSnapshot(
                binding.conversationId,
                byteLength,
                this.recordMeta,
                this.clock.now(),
            );
        const metadataHash = persistedMetadata?.hash || calculateRecordIndexEntryMetadataHash(metadata);
        const cached = this.artifactIdentities.get(key);
        if (cached) {
            if (cached.coveredRevision !== coveredRevision
                || cached.bodyHash !== bodyHash
                || cached.recordIndexMetadataHash !== metadataHash
                || !cached.recordIndexMetadata
                || calculateRecordIndexEntryMetadataHash(cached.recordIndexMetadata) !== metadataHash) {
                throw new RecordCommitVerificationError("publication_identity_descriptor_changed");
            }
            return structuredClone(cached);
        }
        const identity: RecordCommitArtifactIdentity = {
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            commitId,
            coveredRevision,
            bodyHash,
            recordCommitEpoch: binding.recordCommitEpoch,
            recordIndexMetadata: metadata,
            recordIndexMetadataHash: metadataHash,
        };
        this.artifactIdentities.set(key, structuredClone(identity));
        return identity;
    }

    private metadataSnapshotFromPersistedPayload(
        binding: RecordCommitBinding,
        byteLength: number,
        metadata: RecordCommitPayloadMetadata,
    ): RecordIndexEntryMetadataSnapshot {
        const snapshot = structuredClone(metadata.snapshot) as unknown;
        if (!isRecordIndexEntryMetadataSnapshot(snapshot)
            || calculateRecordIndexEntryMetadataHash(snapshot) !== metadata.hash
            || snapshot.conversationId !== binding.conversationId
            || snapshot.sizeBytes !== byteLength) {
            throw new RecordCommitVerificationError("persisted_payload_metadata_mismatch");
        }
        return snapshot;
    }

    private artifactIdentityFromPublicationClaim(
        binding: RecordCommitBinding,
        claim: RecordWorkPublicationClaim,
        byteLength: number,
    ): RecordCommitArtifactIdentity {
        const metadata = structuredClone(claim.metadataSnapshot) as unknown as RecordIndexEntryMetadataSnapshot;
        if (calculateRecordIndexEntryMetadataHash(metadata) !== claim.metadataHash
            || metadata.conversationId !== binding.conversationId
            || metadata.sizeBytes !== byteLength) {
            throw new RecordCommitVerificationError("publication_claim_metadata_mismatch");
        }
        const identity: RecordCommitArtifactIdentity = {
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            commitId: claim.commitId,
            coveredRevision: claim.coveredRevision,
            bodyHash: claim.bodyHash,
            recordCommitEpoch: claim.recordCommitEpoch,
            recordIndexMetadata: metadata,
            recordIndexMetadataHash: claim.metadataHash,
        };
        this.artifactIdentities.set(this.publicationIdentityKey(binding, claim.commitId), structuredClone(identity));
        return identity;
    }

    private async publicationClaimInput(
        binding: RecordCommitBinding,
        commitId: string,
        coveredRevision: string,
        bodyHash: string,
        byteLength: number,
        metadata: RecordCommitPayloadMetadata,
    ): Promise<RecordWorkPublicationClaimInput> {
        const authority = await this.commitAuthorityInput(binding);
        if (!authority) throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
        const identity = this.artifactIdentity(binding, commitId, coveredRevision, bodyHash, byteLength, metadata);
        if (!identity.recordIndexMetadata || !identity.recordIndexMetadataHash) {
            throw new RecordCommitVerificationError("publication_identity_metadata_missing");
        }
        return {
            ...authority,
            commitId,
            inputHash: binding.inputHash,
            bodyHash,
            coveredRevision,
            metadataHash: identity.recordIndexMetadataHash,
            metadataSnapshot: structuredClone(identity.recordIndexMetadata) as unknown as Record<string, unknown>,
        };
    }

    private async preparePublicationClaim(
        binding: RecordCommitBinding,
        commitId: string,
        coveredRevision: string,
        bodyHash: string,
        byteLength: number,
        metadata: RecordCommitPayloadMetadata,
    ): Promise<{ kind: "publish"; input: RecordWorkPublicationClaimInput } | { kind: "reused"; claim: RecordWorkPublicationClaim }> {
        const proposed = await this.publicationClaimInput(binding, commitId, coveredRevision, bodyHash, byteLength, metadata);
        const claimed = await claimRecordWorkPublication(proposed);
        if (claimed.kind === "repair_required") this.throwRegistryRepair(claimed.reason);
        if (claimed.kind === "rejected") throw new RecordCommitVerificationError(`publication_claim_authority_${claimed.reason}`);
        if (claimed.kind === "conflict") throw new RecordCommitVerificationError("already_published_conflict");
        this.artifactIdentityFromPublicationClaim(binding, claimed.claim, byteLength);
        if (claimed.kind === "reused") {
            this.reusablePublicationClaims.set(commitId, structuredClone(claimed.claim));
            return { kind: "reused", claim: structuredClone(claimed.claim) };
        }
        const synchronizationKey = this.publicationIdentityKey(binding, commitId);
        if (!this.synchronizedPublicationClaims.has(synchronizationKey)) {
            if (!claimed.work.ownerLease) throw new RecordCommitVerificationError("publication_claim_lease_missing");
            await this.syncRegistryWorkIntoScheduler(claimed.registry, claimed.work, claimed.work.ownerLease, claimed.authorization.fence);
            this.synchronizedPublicationClaims.add(synchronizationKey);
        }
        return {
            kind: "publish",
            input: await this.publicationClaimInput(binding, commitId, coveredRevision, bodyHash, byteLength, metadata),
        };
    }

    private async authorizeDetachedCleanup(input: {
        recordWorkKey: string;
        ownerId: string;
        fence: FencingToken;
        expectedRegistryRevision?: number;
        nowMs: number;
    }, requireNoActiveTasks: boolean): Promise<ConditionalCommitAuthorization | null> {
        const ready = await this.requireReadyRegistry();
        const work = ready.registry.works.find(candidate => candidate.recordWorkKey === input.recordWorkKey);
        if (!work
            || input.expectedRegistryRevision === undefined
            || ready.registry.registryRevision !== input.expectedRegistryRevision
            || work.state !== "Active"
            || (requireNoActiveTasks && work.activeTaskIds.length !== 0)
            || !work.ownerLease
            || Date.parse(work.ownerLease.expiresAt) <= input.nowMs
            || work.ownerLease.workLeaseId !== input.fence.workLeaseId
            || work.ownerLease.ownerId !== input.ownerId
            || work.ownerLease.schedulerEpoch !== input.fence.schedulerEpoch
            || work.recordCommitEpoch !== input.fence.recordCommitEpoch
            || work.currentFencingToken !== input.fence.fencingToken) return null;
        return {
            path: ready.path,
            registryRevision: ready.registry.registryRevision,
            identity: structuredClone(ready.registry.identity),
            recordWorkKey: work.recordWorkKey,
            recordCommitEpoch: work.recordCommitEpoch,
            fence: structuredClone(input.fence),
        };
    }

    private throwRegistryRepair(reason: string): never {
        throw new RecordCommitStorageAdapterError(`record work registry 需要修复: ${reason}`, "REPAIR_REQUIRED");
    }

    private async readSharedWork(binding: RecordCommitBinding): Promise<RecordCommitSharedWorkEvidence> {
        this.assertInitialized();
        if (!this.bindingMatchesInjectedWork(binding)) return { activeTaskIds: [] };
        const registry = await this.requireReadyRegistry();
        const work = registry.registry.works.find(candidate => candidate.recordWorkKey === binding.recordWorkKey);
        if (!work) throw new RecordCommitStorageAdapterError("shared work 在 registry 中丢失", "REPAIR_REQUIRED");
        return { activeTaskIds: [...work.activeTaskIds] };
    }

    private async detachTask(binding: RecordCommitBinding): Promise<void> {
        this.assertInitialized();
        const scheduler = await this.requireSchedulerLedger();
        this.assertSchedulerOwner(scheduler.ledger);
        const work = this.requireSchedulerWork(scheduler.ledger);
        if (work.recordWorkKey !== binding.recordWorkKey) throw new RecordCommitStorageAdapterError("detach 的 record work 已被替换", "STALE");
        const detached = await detachRecordWorkTask({
            ...this.registryLocation,
            recordWorkKey: binding.recordWorkKey,
            taskId: this.taskId,
            expectedRegistryRevision: work.registryRevision,
            nowMs: this.clock.nowMs(),
        });
        if (detached.kind !== "detached") {
            if (detached.kind === "repair_required") this.throwRegistryRepair(detached.reason);
            if (detached.kind === "cas_conflict") throw new RecordCommitStorageAdapterError("detach registry revision 冲突", "STALE");
            return;
        }
        await this.syncRegistryWorkIntoScheduler(detached.registry, detached.work, detached.work.ownerLease || {
            workLeaseId: work.workLeaseId,
            ownerId: work.leaseOwnerId,
            schedulerEpoch: work.schedulerEpoch,
            expiresAt: work.leaseExpiresAt,
        }, {
            schedulerEpoch: work.schedulerEpoch,
            recordCommitEpoch: detached.work.recordCommitEpoch,
            fencingToken: detached.work.currentFencingToken,
            workLeaseId: detached.work.ownerLease?.workLeaseId || work.workLeaseId,
        });
    }

    private async validateTarget(binding: RecordCommitBinding, target: RecordCommitTarget, expectedKind: RecordCommitTargetKind): Promise<boolean> {
        if (!this.bindingMatchesInjectedWork(binding)) return false;
        const artifactTarget = toArtifactTarget(target);
        return validateRecordCommitArtifactTarget(this.paths.recordStoreHash, artifactTarget, expectedKind);
    }

    private async validateBodyRef(binding: RecordCommitBinding, bodyRef: RecordCommitBodyRef): Promise<boolean> {
        if (!this.bindingMatchesInjectedWork(binding)) return false;
        try {
            const reference = this.spoolReferenceFromBodyRef(bodyRef);
            return reference.path === bodyRef.relativePath && reference.hash === bodyRef.objectId.slice(0, bodyRef.objectId.lastIndexOf(BODY_REF_SEPARATOR));
        } catch {
            return false;
        }
    }

    private async readBodyRef(binding: RecordCommitBinding, bodyRef: RecordCommitBodyRef, maxBytes: number): Promise<RecordCommitBodyReadResult> {
        if (!await this.authorizeBinding(binding, { allowDetachedCleanup: true, detachedCleanupMustBeExclusive: true })) return { kind: "missing" };
        const reference = this.spoolReferenceFromBodyRef(bodyRef);
        if (reference.byteLength > maxBytes) return { kind: "found", body: "", truncated: true };
        try {
            const bytes = await this.spool.readImmutable({ taskId: this.taskId, kind: "output", reference });
            if (bytes.byteLength !== reference.byteLength || sha256Buffer(bytes) !== reference.hash) {
                throw new RecordCommitStorageAdapterError("spool body readback hash/bytes 不一致", "REPAIR_REQUIRED");
            }
            const body = bytes.toString("utf8");
            if (!Buffer.from(body, "utf8").equals(bytes)) throw new RecordCommitStorageAdapterError("spool body 不是可逆 UTF-8 文本", "REPAIR_REQUIRED");
            return { kind: "found", body, truncated: false };
        } catch (error) {
            if (error instanceof RecordCommitStorageAdapterError) throw error;
            return { kind: "missing" };
        }
    }

    private async captureBodyBeforeImage(
        _commitId: string,
        binding: RecordCommitBinding,
        target: RecordCommitTarget,
        maxBytes: number,
    ): Promise<RecordCommitBodyImage> {
        await this.requirePhysicalAuthority(binding, target);
        const image = await readRecordCommitBodyArtifact(this.paths.recordStoreHash, toArtifactTarget(target));
        if (image.body === null) return emptyBodyImage();
        const bytes = Buffer.byteLength(image.body, "utf8");
        if (bytes > maxBytes) throw new RecordCommitVerificationError("before_body_exceeded_bound");
        const reference = await this.writeSpoolObject("output", image.body, binding, target);
        await this.requirePhysicalAuthority(binding, target);
        return {
            bodyRef: this.bodyRefFromSpool(binding, reference),
            bodyHash: image.hash,
            byteLength: bytes,
            ownerCommitId: image.ownerCommitId,
            revision: image.revision,
        };
    }

    private async stageBody(
        _commitId: string,
        binding: RecordCommitBinding,
        bodyRef: RecordCommitBodyRef,
        bodyHash: string,
        byteLength: number,
        maxBytes: number,
    ): Promise<void> {
        await this.requirePhysicalAuthority(binding);
        const read = await this.readBodyRef(binding, bodyRef, maxBytes);
        if (read.kind !== "found" || read.truncated || this.byteLength(read.body) !== byteLength || this.hash(read.body) !== bodyHash) {
            throw new RecordCommitVerificationError("stage_body_spool_descriptor_mismatch");
        }
        await this.requirePhysicalAuthority(binding);
    }

    private async readStagedBody(commitId: string): Promise<RecordCommitBodyImage> {
        const ledger = await this.readProtocolLedger(commitId);
        if (!isProtocolLedger(ledger)) return emptyBodyImage();
        if (["Cancelling", "Cancelled", "Detached"].includes(ledger.lifecycle)) return emptyBodyImage();
        const staged = ledger.stage === "BodyStaged" || ledger.confirmedStages.includes("BodyStaged") || ledger.intent?.targetStage === "BodyStaged";
        return staged ? {
            bodyRef: structuredClone(ledger.payload.bodyRef),
            bodyHash: ledger.payload.bodyHash,
            byteLength: ledger.payload.byteLength,
            ownerCommitId: ledger.commitId,
            revision: ledger.payload.coveredRevision,
        } : emptyBodyImage();
    }

    private async publishBody(input: {
        commitId: string;
        binding: RecordCommitBinding;
        target: RecordCommitTarget;
        bodyRef: RecordCommitBodyRef;
        bodyHash: string;
        byteLength: number;
        maxBytes: number;
        coveredRevision: string;
    }): Promise<void> {
        const expected = await this.expectedBeforeBody(input.commitId);
        const read = await this.readBodyRef(input.binding, input.bodyRef, input.maxBytes);
        if (read.kind !== "found" || read.truncated) throw new RecordCommitVerificationError("publish_body_spool_missing");
        const protocol = await this.requireProtocolLedger(input.commitId);
        const publication = await this.preparePublicationClaim(
            input.binding,
            input.commitId,
            input.coveredRevision,
            input.bodyHash,
            input.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        if (publication.kind === "reused") return;
        const identity = this.artifactIdentity(
            input.binding,
            input.commitId,
            input.coveredRevision,
            input.bodyHash,
            input.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        const result = await writeRecordCommitBodyConditionally({
            hash: this.paths.recordStoreHash,
            target: toArtifactTarget(input.target),
            identity,
            body: read.body,
            expected,
            withCommitAuthority: operation => this.withPhysicalArtifactAuthority(input.binding, operation, {}, publication.input),
            validateOwnership: context => this.ownershipValidatorWithinAuthority(input.binding, context.target),
        });
        this.requireApplied(result, "publish_body");
    }

    private async readBody(target: RecordCommitTarget): Promise<RecordCommitBodyImage> {
        const image = await readRecordCommitBodyArtifact(this.paths.recordStoreHash, toArtifactTarget(target));
        if (image.body === null) return emptyBodyImage();
        const reusable = await this.reusablePublicationForTarget(target, "record_body");
        if (reusable) {
            if (image.ownerCommitId !== reusable.claim.commitId
                || image.hash !== reusable.claim.bodyHash
                || image.revision !== reusable.claim.coveredRevision) {
                throw new RecordCommitVerificationError("reused_publication_body_mismatch");
            }
            return {
                bodyRef: structuredClone(reusable.ledger.payload.bodyRef),
                bodyHash: reusable.ledger.payload.bodyHash,
                byteLength: reusable.ledger.payload.byteLength,
                ownerCommitId: reusable.ledger.commitId,
                revision: reusable.ledger.payload.coveredRevision,
            };
        }
        const ref = await this.findBodyRefForVisibleArtifact(image);
        return {
            bodyRef: ref,
            bodyHash: image.hash,
            byteLength: this.byteLength(image.body),
            ownerCommitId: image.ownerCommitId,
            revision: image.revision,
        };
    }

    private async writeMainIndex(input: {
        commitId: string;
        binding: RecordCommitBinding;
        target: RecordCommitTarget;
        entry: { commitId: string; coveredRevision: string; conversationId: string; recordId: string };
        entryHash: string;
    }): Promise<void> {
        const expected = await this.expectedBeforeJson(input.commitId, "mainIndex");
        const protocol = await this.requireProtocolLedger(input.commitId);
        const publication = await this.preparePublicationClaim(
            input.binding,
            input.commitId,
            protocol.payload.coveredRevision,
            protocol.payload.bodyHash,
            protocol.payload.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        if (publication.kind === "reused") return;
        const identity = this.artifactIdentity(
            input.binding,
            input.commitId,
            protocol.payload.coveredRevision,
            protocol.payload.bodyHash,
            protocol.payload.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        const result = await writeRecordCommitMainIndexConditionally({
            hash: this.paths.recordStoreHash,
            target: toArtifactTarget(input.target),
            identity,
            entry: structuredClone(input.entry),
            recordMeta: this.recordMeta,
            expected: expected as RecordCommitJsonArtifactImage<{ commitId: string; coveredRevision: string; conversationId: string; recordId: string }>,
            withCommitAuthority: operation => this.withPhysicalArtifactAuthority(input.binding, operation, {}, publication.input),
            validateOwnership: context => this.ownershipValidatorWithinAuthority(input.binding, context.target),
        });
        this.requireApplied(result, "write_main_index");
    }

    private async readMainIndex(target: RecordCommitTarget): Promise<RecordCommitJsonImage> {
        const image = await readRecordCommitMainIndexArtifact(this.paths.recordStoreHash, toArtifactTarget(target));
        if (!validateRecordCommitMainIndexStorageBinding(image)) {
            throw new RecordCommitVerificationError("main_index_full_storage_metadata_mismatch");
        }
        const reusable = await this.reusablePublicationForTarget(target, "main_index");
        if (reusable) {
            if (image.ownerCommitId !== reusable.claim.commitId
                || image.revision !== reusable.claim.coveredRevision
                || image.identity?.recordIndexMetadataHash !== reusable.claim.metadataHash) {
                throw new RecordCommitVerificationError("reused_publication_main_index_mismatch");
            }
            return {
                value: structuredClone(reusable.ledger.payload.mainIndexEntry) as unknown as JsonValue,
                hash: calculateRecordCommitArtifactJsonHash(reusable.ledger.payload.mainIndexEntry),
                ownerCommitId: reusable.ledger.commitId,
                revision: reusable.ledger.payload.coveredRevision,
            };
        }
        return jsonImage(image);
    }

    private async writeReaderIndex(input: {
        commitId: string;
        binding: RecordCommitBinding;
        target: RecordCommitTarget;
        index: RecordCommitReaderIndexEntry;
        indexHash: string;
    }): Promise<void> {
        const expected = await this.expectedBeforeJson(input.commitId, "readerIndex");
        const protocol = await this.requireProtocolLedger(input.commitId);
        const publication = await this.preparePublicationClaim(
            input.binding,
            input.commitId,
            protocol.payload.coveredRevision,
            protocol.payload.bodyHash,
            protocol.payload.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        if (publication.kind === "reused") return;
        const identity = this.artifactIdentity(
            input.binding,
            input.commitId,
            protocol.payload.coveredRevision,
            protocol.payload.bodyHash,
            protocol.payload.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        const result = await writeRecordCommitReaderIndexConditionally({
            hash: this.paths.recordStoreHash,
            target: toArtifactTarget(input.target),
            identity,
            index: structuredClone(input.index),
            expected: expected as RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>,
            withCommitAuthority: operation => this.withPhysicalArtifactAuthority(input.binding, operation, {}, publication.input),
            validateOwnership: context => this.ownershipValidatorWithinAuthority(input.binding, context.target),
            beforeWrite: () => this.hooks?.onReaderIndexWritePoint?.({ commitId: input.commitId, point: "before_replace" }),
        });
        this.requireApplied(result, "write_reader_index");
    }

    private async readReaderIndex(target: RecordCommitTarget): Promise<RecordCommitJsonImage> {
        const image = await readRecordCommitReaderIndexArtifact(this.paths.recordStoreHash, toArtifactTarget(target));
        const reusable = await this.reusablePublicationForTarget(target, "reader_index");
        if (reusable) {
            if (image.ownerCommitId !== reusable.claim.commitId
                || image.revision !== reusable.claim.coveredRevision
                || image.identity?.bodyHash !== reusable.claim.bodyHash) {
                throw new RecordCommitVerificationError("reused_publication_reader_index_mismatch");
            }
            return {
                value: structuredClone(reusable.ledger.payload.readerIndex) as unknown as JsonValue,
                hash: calculateRecordCommitArtifactJsonHash(reusable.ledger.payload.readerIndex),
                ownerCommitId: reusable.ledger.commitId,
                revision: reusable.ledger.payload.coveredRevision,
            };
        }
        return jsonImage(image);
    }

    private async reusablePublicationForTarget(
        target: RecordCommitTarget,
        kind: RecordCommitTargetKind,
    ): Promise<{ ledger: RecordCommitLedger; claim: RecordWorkPublicationClaim } | null> {
        for (const [commitId, claim] of this.reusablePublicationClaims) {
            const ledger = await this.requireProtocolLedger(commitId);
            const candidate = kind === "record_body"
                ? ledger.payload.bodyTarget
                : kind === "main_index"
                    ? ledger.payload.mainIndexTarget
                    : ledger.payload.readerIndexTarget;
            if (candidate.conversationId !== target.conversationId
                || candidate.recordId !== target.recordId
                || candidate.relativePath !== target.relativePath
                || ledger.payload.bodyHash !== claim.bodyHash
                || ledger.payload.coveredRevision !== claim.coveredRevision
                || ledger.binding.inputHash !== claim.inputHash) continue;
            return { ledger, claim: structuredClone(claim) };
        }
        return null;
    }

    private async discardStagedBodyIfOwned(_commitId: string, binding: RecordCommitBinding): Promise<RecordCommitConditionalMutationResult> {
        await this.requirePhysicalAuthority(binding, undefined, true);
        await this.requirePhysicalAuthority(binding, undefined, true);
        return { kind: "already_applied" };
    }

    private async restoreBodyIfOwned(input: {
        commitId: string;
        binding: RecordCommitBinding;
        target: RecordCommitTarget;
        expected: RecordCommitBodyImage;
        before: RecordCommitBodyImage;
        maxBytes: number;
    }): Promise<RecordCommitConditionalMutationResult> {
        const before = await this.toArtifactBodyImage(input.before, input.binding, input.maxBytes);
        const protocol = await this.requireProtocolLedger(input.commitId);
        const identity = this.artifactIdentity(
            input.binding,
            input.commitId,
            input.expected.revision || "cleanup",
            input.expected.bodyHash || "cleanup",
            input.expected.byteLength || 0,
            protocol.payload.mainIndexMetadata,
        );
        const result = await restoreRecordCommitBodyIfOwned({
            hash: this.paths.recordStoreHash,
            target: toArtifactTarget(input.target),
            identity,
            expectedBodyHash: input.expected.bodyHash || "",
            before,
            withCommitAuthority: operation => this.withPhysicalArtifactAuthority(input.binding, operation, { allowDetachedCleanup: true, detachedCleanupMustBeExclusive: true }),
            validateOwnership: context => this.ownershipValidatorWithinAuthority(input.binding, context.target),
        });
        return result.kind === "expected_mismatch" ? { kind: "ownership_changed", reason: "expected_body_mismatch" } : result.kind === "ownership_changed"
            ? { kind: "ownership_changed", reason: "body_owner_changed" }
            : { kind: result.kind };
    }

    private async restoreMainIndexIfOwned(input: {
        commitId: string;
        binding: RecordCommitBinding;
        target: RecordCommitTarget;
        expectedEntryHash: string;
        before: RecordCommitJsonImage;
    }): Promise<RecordCommitConditionalMutationResult> {
        const protocol = await this.requireProtocolLedger(input.commitId);
        const identity = this.artifactIdentity(
            input.binding,
            input.commitId,
            protocol.payload.coveredRevision,
            protocol.payload.bodyHash,
            protocol.payload.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        const result = await restoreRecordCommitMainIndexIfOwned({
            hash: this.paths.recordStoreHash,
            target: toArtifactTarget(input.target),
            identity,
            expectedEntryHash: input.expectedEntryHash,
            before: jsonArtifactImage(input.before),
            withCommitAuthority: operation => this.withPhysicalArtifactAuthority(input.binding, operation, { allowDetachedCleanup: true, detachedCleanupMustBeExclusive: true }),
            validateOwnership: context => this.ownershipValidatorWithinAuthority(input.binding, context.target),
        });
        return result.kind === "expected_mismatch" ? { kind: "ownership_changed", reason: "expected_main_index_mismatch" } : result.kind === "ownership_changed"
            ? { kind: "ownership_changed", reason: "main_index_owner_changed" }
            : { kind: result.kind };
    }

    private async rebuildReaderIndexFromBody(input: {
        commitId: string;
        binding: RecordCommitBinding;
        bodyTarget: RecordCommitTarget;
        mainIndexTarget: RecordCommitTarget;
        readerIndexTarget: RecordCommitTarget;
        expectedBody: RecordCommitBodyImage;
        expectedMainIndex: RecordCommitJsonImage;
        expectedReaderIndex: RecordCommitJsonImage;
        maxBytes: number;
    }): Promise<RecordCommitConditionalMutationResult> {
        const protocol = await this.requireProtocolLedger(input.commitId);
        const identity = this.artifactIdentity(
            input.binding,
            input.commitId,
            protocol.payload.coveredRevision,
            protocol.payload.bodyHash,
            protocol.payload.byteLength,
            protocol.payload.mainIndexMetadata,
        );
        const expectedBody = await this.toArtifactBodyImage(input.expectedBody, input.binding, input.maxBytes);
        const result = await rebuildRecordCommitReaderIndexFromBody({
            hash: this.paths.recordStoreHash,
            identity,
            bodyTarget: toArtifactTarget(input.bodyTarget),
            mainIndexTarget: toArtifactTarget(input.mainIndexTarget),
            readerIndexTarget: toArtifactTarget(input.readerIndexTarget),
            expectedBody,
            expectedMainIndex: jsonArtifactImage(input.expectedMainIndex),
            expectedReaderIndex: jsonArtifactImage(input.expectedReaderIndex),
            withCommitAuthority: operation => this.withPhysicalArtifactAuthority(input.binding, operation, { allowDetachedCleanup: true, detachedCleanupMustBeExclusive: true }),
            validateOwnership: context => this.ownershipValidatorWithinAuthority(input.binding, context.target),
        });
        return result.kind === "expected_mismatch" ? { kind: "ownership_changed", reason: "expected_reader_index_mismatch" } : result.kind === "ownership_changed"
            ? { kind: "ownership_changed", reason: "reader_index_owner_changed" }
            : { kind: result.kind };
    }

    private async verifyTaskExclusiveResultsInvisible(input: {
        commitId: string;
        binding: RecordCommitBinding;
        bodyTarget: RecordCommitTarget;
        mainIndexTarget: RecordCommitTarget;
        readerIndexTarget: RecordCommitTarget;
    }): Promise<boolean> {
        const [body, main, reader] = await Promise.all([
            this.readBody(input.bodyTarget),
            this.readMainIndex(input.mainIndexTarget),
            this.readReaderIndex(input.readerIndexTarget),
        ]);
        return body.ownerCommitId !== input.commitId && main.ownerCommitId !== input.commitId && reader.ownerCommitId !== input.commitId;
    }

    private async isolateLateOutput(input: {
        commitId: string;
        binding: RecordCommitBinding;
        bodyRef: RecordCommitBodyRef;
        bodyHash: string;
        byteLength: number;
        reason: string;
    }): Promise<void> {
        await this.requirePhysicalAuthority(input.binding);
        const reference = this.spoolReferenceFromBodyRef(input.bodyRef);
        if (reference.hash !== input.bodyHash || reference.byteLength !== input.byteLength) {
            throw new RecordCommitVerificationError("late_output_descriptor_mismatch");
        }
        const key = sha256(`${this.taskId}\u0000${input.commitId}\u0000${reference.hash}\u0000${reference.byteLength}`);
        await fs.mkdir(this.paths.lateResultDirectory, { recursive: true });
        const destination = path.join(this.paths.lateResultDirectory, `${key}.json`);
        const payload = JSON.stringify({
            schemaVersion: 1,
            kind: "record-commit-late-output",
            taskId: this.taskId,
            commitId: input.commitId,
            binding: input.binding,
            bodyRef: input.bodyRef,
            bodyHash: input.bodyHash,
            byteLength: input.byteLength,
            reason: input.reason,
            isolatedAt: this.now(),
        });
        try {
            const handle = await fs.open(destination, "wx", 0o600);
            try {
                await handle.writeFile(payload, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await this.requirePhysicalAuthority(input.binding);
    }

    private async expectedBeforeBody(commitId: string): Promise<RecordCommitBodyArtifactImage> {
        const ledger = await this.requireProtocolLedger(commitId);
        return this.toArtifactBodyImage(ledger.beforeImages?.body || emptyBodyImage(), ledger.binding, Number.MAX_SAFE_INTEGER);
    }

    private async expectedBeforeJson(commitId: string, key: "mainIndex" | "readerIndex"): Promise<RecordCommitJsonArtifactImage> {
        const ledger = await this.requireProtocolLedger(commitId);
        const before = ledger.beforeImages?.[key] || emptyJsonImage();
        const expected = jsonArtifactImage(before);
        if (before.identity !== undefined) return expected;
        const target = key === "mainIndex" ? ledger.payload.mainIndexTarget : ledger.payload.readerIndexTarget;
        const visible = key === "mainIndex"
            ? await readRecordCommitMainIndexArtifact(this.paths.recordStoreHash, toArtifactTarget(target))
            : await readRecordCommitReaderIndexArtifact(this.paths.recordStoreHash, toArtifactTarget(target));
        return sameJsonArtifactCore(visible, expected) ? visible : expected;
    }

    private async toArtifactBodyImage(
        image: RecordCommitBodyImage,
        binding: RecordCommitBinding,
        maxBytes: number,
    ): Promise<RecordCommitBodyArtifactImage> {
        if (image.bodyRef === null) return { body: null, hash: null, ownerCommitId: null, revision: null, identity: null };
        const read = await this.readBodyRef(binding, image.bodyRef, maxBytes);
        if (read.kind !== "found" || read.truncated || image.bodyHash === null || image.byteLength === null) {
            throw new RecordCommitVerificationError("before_body_spool_missing");
        }
        const visible = await readRecordCommitBodyArtifact(this.paths.recordStoreHash, {
            kind: "record_body",
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: getRecordCommitArtifactRelativePath("record_body", binding.conversationId),
        });
        const matchesVisible = visible.body === read.body
            && visible.hash === image.bodyHash
            && visible.ownerCommitId === image.ownerCommitId
            && visible.revision === image.revision;
        if (matchesVisible) {
            return {
                body: read.body,
                hash: image.bodyHash,
                ownerCommitId: image.ownerCommitId,
                revision: image.revision,
                identity: visible.identity ? structuredClone(visible.identity) : null,
            };
        }
        if (!image.ownerCommitId || !image.revision) {
            throw new RecordCommitVerificationError("before_body_identity_unrecoverable");
        }
        return {
            body: read.body,
            hash: image.bodyHash,
            ownerCommitId: image.ownerCommitId,
            revision: image.revision,
            identity: this.artifactIdentity(binding, image.ownerCommitId, image.revision, image.bodyHash, image.byteLength),
        };
    }

    private async findBodyRefForVisibleArtifact(image: RecordCommitBodyArtifactImage): Promise<RecordCommitBodyRef | null> {
        if (!image.identity || !image.body || !image.hash) return null;
        const current = await this.readSchedulerLedger();
        if (!current) return null;
        const commit = current.ledger.commits.find(candidate => candidate.commitId === image.identity!.commitId) as StoredProtocolCommit | undefined;
        const bodyRef = commit?.protocolLedger?.payload.bodyRef;
        if (!bodyRef || bodyRef.objectId.split(BODY_REF_SEPARATOR)[0] !== image.hash) return null;
        return structuredClone(bodyRef);
    }

    private async ownershipValidatorWithinAuthority(
        binding: RecordCommitBinding,
        target: RecordCommitArtifactTarget,
    ): Promise<boolean> {
        if (!validateRecordCommitArtifactTarget(this.paths.recordStoreHash, target, target.kind)) return false;
        return Boolean(await this.commitAuthorityInput(binding));
    }

    private async requirePhysicalAuthority(
        binding: RecordCommitBinding,
        target?: RecordCommitTarget,
        allowDetachedCleanup = false,
    ): Promise<void> {
        if (target && !await this.validateTarget(binding, target, target.kind)) {
            throw new RecordCommitVerificationError("artifact_target_rejected");
        }
        if (!await this.authorizeBinding(binding, {
            allowDetachedCleanup,
            detachedCleanupMustBeExclusive: allowDetachedCleanup,
        })) throw new RecordCommitVerificationError("scheduler_or_registry_authority_changed");
    }

    private requireApplied(result: { kind: string }, label: string): void {
        if (result.kind !== "applied" && result.kind !== "already_applied") {
            throw new RecordCommitVerificationError(`${label}_${result.kind}`);
        }
    }

    private bodyRefFromSpool(binding: RecordCommitBinding, reference: ImmutableBlobReference): RecordCommitBodyRef {
        return {
            kind: "immutable_record_body",
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            objectId: `${reference.hash}${BODY_REF_SEPARATOR}${reference.byteLength}`,
            relativePath: reference.path,
        };
    }

    private spoolReferenceFromBodyRef(bodyRef: RecordCommitBodyRef): ImmutableBlobReference {
        const separator = bodyRef.objectId.lastIndexOf(BODY_REF_SEPARATOR);
        const hash = bodyRef.objectId.slice(0, separator);
        const byteLength = Number(bodyRef.objectId.slice(separator + BODY_REF_SEPARATOR.length));
        if (!/^[a-f0-9]{64}$/u.test(hash) || !Number.isInteger(byteLength) || byteLength < 0 || separator <= 0) {
            throw new RecordCommitStorageAdapterError("bodyRef.objectId 不是 scheduler spool 的 hash:bytes 编码", "REPAIR_REQUIRED");
        }
        return { path: bodyRef.relativePath, hash, byteLength };
    }

    private async writeSpoolObject(kind: "output", content: string, binding?: RecordCommitBinding, target?: RecordCommitTarget): Promise<ImmutableBlobReference> {
        if (binding) await this.requirePhysicalAuthority(binding, target);
        const written = await this.spool.writeImmutable({ taskId: this.taskId, kind, content });
        if (binding) await this.requirePhysicalAuthority(binding, target);
        return written.reference;
    }

    private async requireProtocolLedger(commitId: string): Promise<RecordCommitLedger> {
        const ledger = await this.readProtocolLedger(commitId);
        if (!isProtocolLedger(ledger)) throw new RecordCommitStorageAdapterError(`commit ${commitId} 的嵌入 protocol ledger 缺失或损坏`, "REPAIR_REQUIRED");
        return ledger;
    }

    private async requireReadyRegistry() {
        const current = await readRecordWorkRegistry(this.registryLocation);
        if (current.kind !== "ready") this.throwRegistryRepair(current.reason);
        return current;
    }

    private async readSchedulerLedger(): Promise<CurrentSchedulerLedger | null> {
        const current = await readRecordSchedulerLedgerStore(this.taskId, { expectPublished: true, nowMs: this.clock.nowMs() });
        return current.kind === "current" ? current : null;
    }

    private async requireSchedulerLedger(): Promise<CurrentSchedulerLedger> {
        const current = await this.readSchedulerLedger();
        if (!current) throw new RecordCommitStorageAdapterError("scheduler ledger 缺失、损坏或需要修复", "REPAIR_REQUIRED");
        return current;
    }

    private assertSchedulerOwner(ledger: PersistedRecordSchedulerLedger): void {
        try {
            assertCurrentSchedulerOwnerLease(this.taskId, ledger, this.schedulerOwnerLease, this.clock.nowMs());
        } catch (error) {
            if (error instanceof Error && /fencing|过期|lease/i.test(error.message)) {
                throw new RecordCommitStorageAdapterError(error.message, "STALE");
            }
            throw error;
        }
    }

    private requireSchedulerWork(ledger: RecordSchedulerLedger) {
        const work = ledger.recordWork.find(candidate => candidate.conversationId === this.work.identity.conversationId
            && candidate.chain === this.work.identity.chain
            && candidate.workspaceHash === this.work.identity.workspaceHash
            && candidate.desiredRevision === this.work.desiredRevision);
        if (!work) throw new RecordCommitStorageAdapterError("scheduler ledger 中找不到注入的 record work", "REPAIR_REQUIRED");
        return work;
    }

    private bindingMatchesInjectedWork(binding: RecordCommitBinding): boolean {
        return binding.taskId === this.taskId
            && binding.conversationId === this.work.identity.conversationId
            && binding.recordId === this.work.identity.conversationId;
    }

    private registryFailure(operation: string, value: {
        kind: string;
        reason?: string;
        work?: { recordWorkKey?: string };
        lease?: { workLeaseId?: string; ownerId?: string; schedulerEpoch?: number; expiresAt?: string };
    }): RecordCommitStorageAdapterError {
        const leaseDetail = value.kind === "lease_held"
            ? `; work=${value.work?.recordWorkKey || this.work.identity.conversationId}; requested=${this.schedulerOwnerLease.ownerId}/${this.schedulerOwnerLease.schedulerEpoch}; current=${value.lease?.ownerId || "unknown"}/${value.lease?.schedulerEpoch ?? "unknown"}/${value.lease?.workLeaseId || "unknown"}/${value.lease?.expiresAt || "unknown"}`
            : "";
        return new RecordCommitStorageAdapterError(`${operation} 失败: ${value.kind}${value.reason ? ` (${value.reason})` : ""}${leaseDetail}`, value.kind === "cas_conflict" ? "STALE" : "REPAIR_REQUIRED");
    }

    private assertInitialized(): void {
        if (!this.initialized) throw new RecordCommitStorageAdapterError("必须先显式调用 adapter.initialize()，禁止自动接入 live 流量", "NOT_INITIALIZED");
    }
}

export async function createRecordCommitStorageAdapter(options: RecordCommitStorageAdapterOptions): Promise<RecordCommitStorageAdapter> {
    return new RecordCommitStorageAdapter(options).initialize();
}

export async function reopenRecordCommitStorageAdapterForCleanup(
    options: Omit<RecordCommitStorageAdapterOptions, "initializationMode" | "recordMeta">,
): Promise<RecordCommitStorageAdapter> {
    return new RecordCommitStorageAdapter({ ...options, initializationMode: "cleanup_reopen" }).initialize();
}

function emptyBodyImage(): RecordCommitBodyImage {
    return { bodyRef: null, bodyHash: null, byteLength: null, ownerCommitId: null, revision: null };
}

function emptyJsonImage(): RecordCommitJsonImage {
    return { value: null, hash: null, ownerCommitId: null, revision: null };
}

function toArtifactTarget(target: RecordCommitTarget): RecordCommitArtifactTarget {
    return { kind: target.kind, conversationId: target.conversationId, recordId: target.recordId, relativePath: target.relativePath };
}

function jsonImage(image: RecordCommitJsonArtifactImage): RecordCommitJsonImage {
    return {
        value: image.value as JsonValue | null,
        hash: image.hash,
        ownerCommitId: image.ownerCommitId,
        revision: image.revision,
        identity: image.identity ? structuredClone(image.identity) as unknown as JsonValue : null,
    };
}

function jsonArtifactImage(image: RecordCommitJsonImage): RecordCommitJsonArtifactImage<any> {
    return {
        value: image.value,
        hash: image.hash,
        ownerCommitId: image.ownerCommitId,
        revision: image.revision,
        identity: image.identity && isRecordCommitArtifactIdentity(image.identity)
            ? structuredClone(image.identity)
            : null,
        storageValue: image.value,
    };
}

function sameJsonArtifactCore(left: RecordCommitJsonArtifactImage, right: RecordCommitJsonArtifactImage): boolean {
    return left.hash === right.hash
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision
        && canonicalJson((left.value ?? null) as JsonValue) === canonicalJson((right.value ?? null) as JsonValue);
}

function cleanupTarget(
    before: { path: string; existed: boolean; hash?: string; revision?: string },
    hash: string | null,
    revision: string | null,
    ownerCommitId: string | null,
) {
    if (!before.existed && hash === null) return { path: before.path, taskCommitVisible: false as const, disposition: "absent" as const };
    const observedRevision = revision ?? (before.revision === LEGACY_BEFORE_IMAGE_REVISION ? LEGACY_BEFORE_IMAGE_REVISION : null);
    if (before.existed && hash === before.hash && observedRevision === before.revision) {
        return {
            path: before.path,
            taskCommitVisible: false as const,
            disposition: "restored_before_image" as const,
            observedHash: hash || undefined,
            observedRevision: observedRevision || undefined,
            observedCommitId: ownerCommitId || undefined,
        };
    }
    return null;
}

function isProtocolLedger(value: unknown): value is RecordCommitLedger {
    return Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "record-commit-protocol";
}

async function verifyVisiblePublicationArtifacts(
    recordStoreHash: string,
    identity: CanonicalConversationIdentity,
    claim: Readonly<RecordWorkPublicationClaim>,
): Promise<RecordWorkPublicationRolloverVerification> {
    const target = { conversationId: identity.conversationId, recordId: identity.conversationId };
    const [body, mainIndex, readerIndex] = await Promise.all([
        readRecordCommitBodyArtifactLocked(recordStoreHash, {
            kind: "record_body",
            ...target,
            relativePath: getRecordCommitArtifactRelativePath("record_body", target.conversationId),
        }),
        readRecordCommitMainIndexArtifactLocked(recordStoreHash, {
            kind: "main_index",
            ...target,
            relativePath: getRecordCommitArtifactRelativePath("main_index", target.conversationId),
        }),
        readRecordCommitReaderIndexArtifactLocked(recordStoreHash, {
            kind: "reader_index",
            ...target,
            relativePath: getRecordCommitArtifactRelativePath("reader_index", target.conversationId),
        }),
    ]);
    if (!validateRecordCommitMainIndexStorageBinding(mainIndex)) {
        return { kind: "unresolved", reason: "main_index_storage_binding_mismatch" };
    }
    const mainValue = isPlainRecord(mainIndex.value) ? mainIndex.value : null;
    const readerValue = isPlainRecord(readerIndex.value) ? readerIndex.value : null;
    const consistent = body.body !== null
        && body.hash === claim.bodyHash
        && body.ownerCommitId === claim.commitId
        && body.revision === claim.coveredRevision
        && artifactIdentityMatchesClaim(body.identity, identity, claim)
        && mainValue?.commitId === claim.commitId
        && mainValue.coveredRevision === claim.coveredRevision
        && mainValue.conversationId === identity.conversationId
        && mainValue.recordId === identity.conversationId
        && mainIndex.ownerCommitId === claim.commitId
        && mainIndex.revision === claim.coveredRevision
        && artifactIdentityMatchesClaim(mainIndex.identity, identity, claim)
        && readerValue?.commitId === claim.commitId
        && readerValue.bodyHash === claim.bodyHash
        && readerValue.coveredRevision === claim.coveredRevision
        && readerValue.conversationId === identity.conversationId
        && readerValue.recordId === identity.conversationId
        && readerIndex.ownerCommitId === claim.commitId
        && readerIndex.revision === claim.coveredRevision
        && artifactIdentityMatchesClaim(readerIndex.identity, identity, claim);
    if (consistent) {
        return {
            kind: "consistent",
            artifactStateHash: sha256(JSON.stringify({
                version: 1,
                bodyHash: body.hash,
                mainIndexHash: mainIndex.hash,
                readerIndexHash: readerIndex.hash,
                visibleArtifactState: "consistent_claim",
                claimCommitId: claim.commitId,
                claimRecordCommitEpoch: claim.recordCommitEpoch,
            })),
        };
    }
    const bodyAndMainOwnerlessLegacy = body.body !== null
        && body.hash !== null
        && body.identity === null
        && body.ownerCommitId === null
        && body.revision === null
        && mainIndex.storageValue !== null
        && mainIndex.identity === null
        && mainIndex.ownerCommitId === null
        && mainIndex.revision === null;
    const readerOwnerlessLegacy = readerIndex.storageValue !== null
        && readerIndex.identity === null
        && readerIndex.ownerCommitId === null
        && readerIndex.revision === null;
    const readerAbsent = readerIndex.storageValue === null
        && readerIndex.identity === null
        && readerIndex.ownerCommitId === null
        && readerIndex.revision === null;
    const readerMatchesPreviousClaim = readerValue?.commitId === claim.commitId
        && readerValue.bodyHash === claim.bodyHash
        && readerValue.coveredRevision === claim.coveredRevision
        && readerValue.conversationId === identity.conversationId
        && readerValue.recordId === identity.conversationId
        && readerIndex.ownerCommitId === claim.commitId
        && readerIndex.revision === claim.coveredRevision
        && artifactIdentityMatchesClaim(readerIndex.identity, identity, claim);
    const ownerlessLegacy = bodyAndMainOwnerlessLegacy
        && (readerOwnerlessLegacy || readerAbsent || readerMatchesPreviousClaim);
    const coherentlyAbsent = body.body === null
        && body.hash === null
        && body.identity === null
        && body.ownerCommitId === null
        && body.revision === null
        && mainIndex.storageValue === null
        && mainIndex.identity === null
        && mainIndex.ownerCommitId === null
        && mainIndex.revision === null
        && readerIndex.storageValue === null
        && readerIndex.identity === null
        && readerIndex.ownerCommitId === null
        && readerIndex.revision === null;
    if (!ownerlessLegacy && !coherentlyAbsent) {
        return { kind: "unresolved", reason: "visible_artifacts_are_partial_or_owned_by_another_commit" };
    }
    return {
        kind: "diverged",
        artifactStateHash: sha256(JSON.stringify({
            version: 1,
            bodyHash: body.hash,
            mainIndexHash: mainIndex.hash,
            readerIndexHash: readerIndex.hash,
            visibleArtifactState: coherentlyAbsent
                ? "absent"
                : readerMatchesPreviousClaim
                    ? "ownerless_body_main_with_previous_reader"
                    : readerAbsent
                        ? "ownerless_body_main_without_reader"
                        : "ownerless_legacy",
            claimCommitId: claim.commitId,
            claimRecordCommitEpoch: claim.recordCommitEpoch,
        })),
    };
}

function artifactIdentityMatchesClaim(
    artifact: RecordCommitArtifactIdentity | null,
    identity: CanonicalConversationIdentity,
    claim: Readonly<RecordWorkPublicationClaim>,
): boolean {
    return artifact !== null
        && artifact.conversationId === identity.conversationId
        && artifact.recordId === identity.conversationId
        && artifact.commitId === claim.commitId
        && artifact.bodyHash === claim.bodyHash
        && artifact.coveredRevision === claim.coveredRevision
        && artifact.recordCommitEpoch === claim.recordCommitEpoch
        && artifact.recordIndexMetadataHash === claim.metadataHash;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchedulerRevisionConflict(error: unknown): boolean {
    return error instanceof Error && /revision.*冲突|REVISION_CONFLICT/u.test(`${error.name} ${error.message}`);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value: Uint8Array): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function sameBlobReference(left: ImmutableBlobReference, right: ImmutableBlobReference): boolean {
    return left.path === right.path && left.hash === right.hash && left.byteLength === right.byteLength;
}

function toPortableRelative(root: string, filePath: string): string {
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new RecordCommitStorageAdapterError("registry path 越出 dataRoot", "REPAIR_REQUIRED");
    return relative.split(path.sep).join("/");
}

function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("commit JSON 不能含非有限数字");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
