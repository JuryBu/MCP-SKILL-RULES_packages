import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ROOT } from "./store.js";
import type { RecordSchedulerCoordinatorSnapshot } from "./record-scheduler-coordinator.js";

export const RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION = 1 as const;
export const RECORD_SCHEDULER_COORDINATOR_SNAPSHOT_FILE_NAME = "record-scheduler-coordinator.snapshot.json";

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const MAX_OWNER_LEASE_MS = 24 * 60 * 60_000;
const MIN_OPAQUE_LOCK_STALE_MS = 30_000;
const FILE_LOCK_SCHEMA_VERSION = 1 as const;
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const PROCESS_INSTANCE_ID = crypto.randomUUID();
const PROCESS_STARTED_AT_MS = Math.max(0, Math.floor(Date.now() - process.uptime() * 1_000));
const TEST_CLOCK_BRAND: unique symbol = Symbol("record-scheduler-coordinator-test-clock");

export interface RecordSchedulerCoordinatorTestClock {
    readonly [TEST_CLOCK_BRAND]: true;
    now(): number;
}

export function createRecordSchedulerCoordinatorTestClockForTest(now: () => number): RecordSchedulerCoordinatorTestClock {
    if (typeof now !== "function") throw new RecordSchedulerCoordinatorStoreError("test clock now 必须是函数", "INVALID_TEST_CLOCK");
    return Object.freeze({ [TEST_CLOCK_BRAND]: true as const, now });
}

export interface RecordSchedulerCoordinatorStoreLockOptions {
    timeoutMs?: number;
    staleMs?: number;
    retryMs?: number;
}

export interface RecordSchedulerCoordinatorStoreOptions {
    dataRoot?: string;
    snapshotFilePath?: string;
    lock?: RecordSchedulerCoordinatorStoreLockOptions;
    testClock?: RecordSchedulerCoordinatorTestClock;
}

export interface RecordSchedulerCoordinatorStorePaths {
    dataRoot: string;
    snapshotPath: string;
    lockPath: string;
}

export interface RecordSchedulerCoordinatorOwnerLease {
    ownerId: string;
    leaseId: string;
    epoch: number;
    acquiredAtMs: number;
    heartbeatAtMs: number;
    expiresAtMs: number;
}

export interface RecordSchedulerCoordinatorStoreEnvelope {
    schemaVersion: typeof RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION;
    revision: number;
    persistedHash: string;
    updatedAt: string;
    ownerEpoch: number;
    ownerLease: RecordSchedulerCoordinatorOwnerLease | null;
    snapshot: RecordSchedulerCoordinatorSnapshot;
}

export interface RecordSchedulerCoordinatorCurrentRead {
    kind: "current";
    paths: RecordSchedulerCoordinatorStorePaths;
    envelope: RecordSchedulerCoordinatorStoreEnvelope;
    snapshot: RecordSchedulerCoordinatorSnapshot;
}

export interface RecordSchedulerCoordinatorMissingRead {
    kind: "missing";
    paths: RecordSchedulerCoordinatorStorePaths;
}

export interface RecordSchedulerCoordinatorCorruptRead {
    kind: "corrupt";
    paths: RecordSchedulerCoordinatorStorePaths;
    reason: string;
    detail: string;
}

export interface RecordSchedulerCoordinatorUnsupportedRead {
    kind: "unsupported";
    paths: RecordSchedulerCoordinatorStorePaths;
    schemaVersion: unknown;
    detail: string;
}

export interface RecordSchedulerCoordinatorRepairRequiredRead {
    kind: "repair_required";
    paths: RecordSchedulerCoordinatorStorePaths;
    reason: "snapshot_repair_required" | "unsafe_path";
    detail: string;
    envelope?: RecordSchedulerCoordinatorStoreEnvelope;
    snapshot?: RecordSchedulerCoordinatorSnapshot;
}

export type RecordSchedulerCoordinatorStoreReadResult =
    | RecordSchedulerCoordinatorCurrentRead
    | RecordSchedulerCoordinatorMissingRead
    | RecordSchedulerCoordinatorCorruptRead
    | RecordSchedulerCoordinatorUnsupportedRead
    | RecordSchedulerCoordinatorRepairRequiredRead;

export interface RecordSchedulerCoordinatorFileLock {
    readonly path: string;
    readonly token: string;
    heartbeat(): Promise<void>;
    assertHeld(): Promise<void>;
    release(): Promise<void>;
}

export interface RecordSchedulerCoordinatorOwnerFence {
    ownerEpoch: number;
    ownerLeaseId: string;
}

export interface CreateRecordSchedulerCoordinatorStoreInput extends RecordSchedulerCoordinatorStoreOptions {
    snapshot: RecordSchedulerCoordinatorSnapshot;
}

export interface InitializeRecordSchedulerCoordinatorStoreInput extends CreateRecordSchedulerCoordinatorStoreInput {}

export interface MutateRecordSchedulerCoordinatorSnapshotInput<Value>
    extends RecordSchedulerCoordinatorStoreOptions, RecordSchedulerCoordinatorOwnerFence {
    expectedRevision: number;
    mutate(snapshot: RecordSchedulerCoordinatorSnapshot): Promise<Value> | Value;
}

export interface RecordSchedulerCoordinatorMutationResult<Value> {
    envelope: RecordSchedulerCoordinatorStoreEnvelope;
    snapshot: RecordSchedulerCoordinatorSnapshot;
    value: Value;
}

export interface AcquireRecordSchedulerCoordinatorOwnerInput extends RecordSchedulerCoordinatorStoreOptions {
    ownerId: string;
    ownerLeaseId?: string;
    leaseDurationMs: number;
    expectedRevision?: number;
}

export interface RecoverRecordSchedulerCoordinatorOwnerInput extends AcquireRecordSchedulerCoordinatorOwnerInput {}

export interface RenewRecordSchedulerCoordinatorOwnerInput extends RecordSchedulerCoordinatorStoreOptions, RecordSchedulerCoordinatorOwnerFence {
    leaseDurationMs: number;
    expectedRevision?: number;
}

export interface ReleaseRecordSchedulerCoordinatorOwnerInput extends RecordSchedulerCoordinatorStoreOptions, RecordSchedulerCoordinatorOwnerFence {
    expectedRevision?: number;
}

export type RecordSchedulerCoordinatorLockTestPhase =
    | "before-release-unlink"
    | "after-lock-lstat-before-open"
    | "after-lock-read-before-lstat";

export type RecordSchedulerCoordinatorLockTestContext =
    | {
        phase: "before-release-unlink";
        lockPath: string;
        token: string;
    }
    | {
        phase: "after-lock-lstat-before-open" | "after-lock-read-before-lstat";
        lockPath: string;
        reader: "structured" | "opaque";
    };

export type RecordSchedulerCoordinatorLockTestHook = (
    context: RecordSchedulerCoordinatorLockTestContext,
) => void | Promise<void>;

export interface RecordSchedulerCoordinatorOwnerMutationResult {
    envelope: RecordSchedulerCoordinatorStoreEnvelope;
    snapshot: RecordSchedulerCoordinatorSnapshot;
    lease: RecordSchedulerCoordinatorOwnerLease | null;
    recoveredLease?: RecordSchedulerCoordinatorOwnerLease;
}

export class RecordSchedulerCoordinatorStoreError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = "RecordSchedulerCoordinatorStoreError";
    }
}

export class RecordSchedulerCoordinatorConflictError extends RecordSchedulerCoordinatorStoreError {
    constructor(expectedRevision: number, actualRevision: number) {
        super(`record scheduler coordinator revision 冲突：expected=${expectedRevision} actual=${actualRevision}`, "REVISION_CONFLICT");
        this.name = "RecordSchedulerCoordinatorConflictError";
    }
}

export class RecordSchedulerCoordinatorFencedError extends RecordSchedulerCoordinatorStoreError {
    constructor(message: string) {
        super(message, "OWNER_FENCED");
        this.name = "RecordSchedulerCoordinatorFencedError";
    }
}

export class RecordSchedulerCoordinatorClockRollbackError extends RecordSchedulerCoordinatorStoreError {
    constructor(observedNowMs: number, lowerBoundMs: number) {
        super(`record scheduler coordinator clock 回拨：observed=${observedNowMs} lowerBound=${lowerBoundMs}`, "CLOCK_ROLLBACK");
        this.name = "RecordSchedulerCoordinatorClockRollbackError";
    }
}

export class RecordSchedulerCoordinatorOwnerBusyError extends RecordSchedulerCoordinatorStoreError {
    constructor(expiresAtMs: number) {
        super(`record scheduler coordinator owner lease 尚未过期：expiresAtMs=${expiresAtMs}`, "OWNER_BUSY");
        this.name = "RecordSchedulerCoordinatorOwnerBusyError";
    }
}

export class RecordSchedulerCoordinatorLockTimeoutError extends RecordSchedulerCoordinatorStoreError {
    constructor(timeoutMs: number) {
        super(`record scheduler coordinator 文件锁在 ${timeoutMs}ms 内未释放`, "LOCK_TIMEOUT");
        this.name = "RecordSchedulerCoordinatorLockTimeoutError";
    }
}

export class RecordSchedulerCoordinatorPathSafetyError extends RecordSchedulerCoordinatorStoreError {
    constructor(message: string) {
        super(message, "PATH_UNSAFE");
        this.name = "RecordSchedulerCoordinatorPathSafetyError";
    }
}

export class RecordSchedulerCoordinatorRepairRequiredError extends RecordSchedulerCoordinatorStoreError {
    constructor(readonly read: Exclude<RecordSchedulerCoordinatorStoreReadResult, RecordSchedulerCoordinatorCurrentRead | RecordSchedulerCoordinatorMissingRead>) {
        super(`record scheduler coordinator 需要修复：${read.kind}，${read.detail}`, "REPAIR_REQUIRED");
        this.name = "RecordSchedulerCoordinatorRepairRequiredError";
    }
}

let lockTestHook: RecordSchedulerCoordinatorLockTestHook | undefined;

export function setRecordSchedulerCoordinatorLockTestHookForTest(
    hook?: RecordSchedulerCoordinatorLockTestHook,
): void {
    lockTestHook = hook;
}

export function resolveRecordSchedulerCoordinatorStorePaths(
    options: RecordSchedulerCoordinatorStoreOptions = {},
): RecordSchedulerCoordinatorStorePaths {
    const dataRoot = path.resolve(options.dataRoot ?? DATA_ROOT);
    const snapshotPath = path.resolve(options.snapshotFilePath ?? path.join(dataRoot, RECORD_SCHEDULER_COORDINATOR_SNAPSHOT_FILE_NAME));
    if (path.dirname(snapshotPath) !== dataRoot || path.basename(snapshotPath) !== RECORD_SCHEDULER_COORDINATOR_SNAPSHOT_FILE_NAME) {
        throw new RecordSchedulerCoordinatorPathSafetyError(
            `record scheduler coordinator 路径必须是 DATA_ROOT 下的 ${RECORD_SCHEDULER_COORDINATOR_SNAPSHOT_FILE_NAME}`,
        );
    }
    return { dataRoot, snapshotPath, lockPath: `${snapshotPath}.lock` };
}

export function recordSchedulerCoordinatorSnapshotPath(options: RecordSchedulerCoordinatorStoreOptions = {}): string {
    return resolveRecordSchedulerCoordinatorStorePaths(options).snapshotPath;
}

export function recordSchedulerCoordinatorLockPath(options: RecordSchedulerCoordinatorStoreOptions = {}): string {
    return resolveRecordSchedulerCoordinatorStorePaths(options).lockPath;
}

export function calculateRecordSchedulerCoordinatorEnvelopeHash(
    envelope: RecordSchedulerCoordinatorStoreEnvelope,
): string {
    const payload = structuredClone(envelope) as unknown as Record<string, unknown>;
    delete payload.persistedHash;
    return crypto.createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

export async function readRecordSchedulerCoordinatorStore(
    options: RecordSchedulerCoordinatorStoreOptions = {},
): Promise<RecordSchedulerCoordinatorStoreReadResult> {
    const paths = resolveRecordSchedulerCoordinatorStorePaths(options);
    try {
        return await readRecordSchedulerCoordinatorStoreAt(paths);
    } catch (error) {
        if (error instanceof RecordSchedulerCoordinatorPathSafetyError) {
            return { kind: "repair_required", paths, reason: "unsafe_path", detail: error.message };
        }
        if (isErrno(error, "ENOENT")) return { kind: "missing", paths };
        return {
            kind: "corrupt",
            paths,
            reason: "snapshot_read_failed",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function createRecordSchedulerCoordinatorStore(
    input: CreateRecordSchedulerCoordinatorStoreInput,
): Promise<RecordSchedulerCoordinatorCurrentRead> {
    assertNoLegacyNowMs(input);
    const paths = resolveRecordSchedulerCoordinatorStorePaths(input);
    const snapshot = cloneAndValidateSnapshot(input.snapshot);
    return withRecordSchedulerCoordinatorFileLock(async lock => {
        const existing = await readRecordSchedulerCoordinatorStoreAt(paths);
        if (existing.kind !== "missing") {
            if (existing.kind === "current") {
                throw new RecordSchedulerCoordinatorStoreError("record scheduler coordinator snapshot 已存在，create 不得覆盖 current 状态", "ALREADY_EXISTS");
            }
            throw new RecordSchedulerCoordinatorRepairRequiredError(existing);
        }
        const nowMs = resolveOperationNow(input, "create clock");
        const envelope = finalizeEnvelope({
            schemaVersion: RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION,
            revision: 1,
            persistedHash: "",
            updatedAt: new Date(nowMs).toISOString(),
            ownerEpoch: 0,
            ownerLease: null,
            snapshot,
        });
        await publishEnvelope(paths, envelope, lock);
        return requireCurrent(paths);
    }, input);
}

export async function initializeRecordSchedulerCoordinatorStore(
    input: InitializeRecordSchedulerCoordinatorStoreInput,
): Promise<RecordSchedulerCoordinatorCurrentRead> {
    assertNoLegacyNowMs(input);
    const paths = resolveRecordSchedulerCoordinatorStorePaths(input);
    const snapshot = cloneAndValidateSnapshot(input.snapshot);
    return withRecordSchedulerCoordinatorFileLock(async lock => {
        const existing = await readRecordSchedulerCoordinatorStoreAt(paths);
        if (existing.kind === "current") return existing;
        if (existing.kind !== "missing") throw new RecordSchedulerCoordinatorRepairRequiredError(existing);
        const nowMs = resolveOperationNow(input, "initialize clock");
        const envelope = finalizeEnvelope({
            schemaVersion: RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION,
            revision: 1,
            persistedHash: "",
            updatedAt: new Date(nowMs).toISOString(),
            ownerEpoch: 0,
            ownerLease: null,
            snapshot,
        });
        await publishEnvelope(paths, envelope, lock);
        return requireCurrent(paths);
    }, input);
}

export async function mutateRecordSchedulerCoordinatorSnapshot<Value>(
    input: MutateRecordSchedulerCoordinatorSnapshotInput<Value>,
): Promise<RecordSchedulerCoordinatorMutationResult<Value>> {
    assertNoLegacyNowMs(input);
    assertPositiveInteger(input.expectedRevision, "expectedRevision");
    const paths = resolveRecordSchedulerCoordinatorStorePaths(input);
    return withRecordSchedulerCoordinatorFileLock(async lock => {
        const current = await requireCurrent(paths);
        const nowMs = resolveOperationNow(input, "mutation clock", envelopeClockFloor(current.envelope));
        assertExpectedRevision(current.envelope, input.expectedRevision);
        assertCurrentOwnerFence(current.envelope, input, nowMs);
        const nextSnapshot = cloneAndValidateSnapshot(current.snapshot);
        const value = await input.mutate(nextSnapshot);
        const envelope = finalizeEnvelope({
            ...current.envelope,
            revision: current.envelope.revision + 1,
            persistedHash: "",
            updatedAt: new Date(nowMs).toISOString(),
            ownerLease: cloneLease(current.envelope.ownerLease),
            snapshot: cloneAndValidateSnapshot(nextSnapshot),
        });
        await publishEnvelope(paths, envelope, lock);
        return { envelope, snapshot: envelope.snapshot, value };
    }, input);
}

export async function acquireRecordSchedulerCoordinatorOwner(
    input: AcquireRecordSchedulerCoordinatorOwnerInput,
): Promise<RecordSchedulerCoordinatorOwnerMutationResult> {
    return claimOwner(input, false);
}

export async function recoverRecordSchedulerCoordinatorOwner(
    input: RecoverRecordSchedulerCoordinatorOwnerInput,
): Promise<RecordSchedulerCoordinatorOwnerMutationResult> {
    return claimOwner(input, true);
}

export async function renewRecordSchedulerCoordinatorOwner(
    input: RenewRecordSchedulerCoordinatorOwnerInput,
): Promise<RecordSchedulerCoordinatorOwnerMutationResult> {
    assertNoLegacyNowMs(input);
    assertLeaseDuration(input.leaseDurationMs);
    const paths = resolveRecordSchedulerCoordinatorStorePaths(input);
    return withRecordSchedulerCoordinatorFileLock(async lock => {
        const current = await requireCurrent(paths);
        const nowMs = resolveOperationNow(input, "renew clock", envelopeClockFloor(current.envelope));
        assertExpectedRevision(current.envelope, input.expectedRevision);
        assertCurrentOwnerFence(current.envelope, input, nowMs);
        const lease = current.envelope.ownerLease!;
        const expiresAtMs = nowMs + input.leaseDurationMs;
        assertSafeTimestamp(expiresAtMs, "renew expiresAtMs");
        if (expiresAtMs <= lease.expiresAtMs) {
            return { envelope: current.envelope, snapshot: current.snapshot, lease };
        }
        const renewedLease: RecordSchedulerCoordinatorOwnerLease = {
            ...lease,
            heartbeatAtMs: nowMs,
            expiresAtMs,
        };
        const envelope = finalizeEnvelope({
            ...current.envelope,
            revision: current.envelope.revision + 1,
            persistedHash: "",
            updatedAt: new Date(nowMs).toISOString(),
            ownerLease: renewedLease,
            snapshot: cloneAndValidateSnapshot(current.snapshot),
        });
        await publishEnvelope(paths, envelope, lock);
        return { envelope, snapshot: envelope.snapshot, lease: renewedLease };
    }, input);
}

export async function releaseRecordSchedulerCoordinatorOwner(
    input: ReleaseRecordSchedulerCoordinatorOwnerInput,
): Promise<RecordSchedulerCoordinatorOwnerMutationResult> {
    assertNoLegacyNowMs(input);
    const paths = resolveRecordSchedulerCoordinatorStorePaths(input);
    return withRecordSchedulerCoordinatorFileLock(async lock => {
        const current = await requireCurrent(paths);
        const nowMs = resolveOperationNow(input, "release clock", envelopeClockFloor(current.envelope));
        assertExpectedRevision(current.envelope, input.expectedRevision);
        assertCurrentOwnerFence(current.envelope, input, nowMs);
        const envelope = finalizeEnvelope({
            ...current.envelope,
            revision: current.envelope.revision + 1,
            persistedHash: "",
            updatedAt: new Date(nowMs).toISOString(),
            ownerLease: null,
            snapshot: cloneAndValidateSnapshot(current.snapshot),
        });
        await publishEnvelope(paths, envelope, lock);
        return { envelope, snapshot: envelope.snapshot, lease: null };
    }, input);
}

export async function withRecordSchedulerCoordinatorFileLock<Value>(
    action: (lock: RecordSchedulerCoordinatorFileLock) => Promise<Value> | Value,
    options: RecordSchedulerCoordinatorStoreOptions = {},
): Promise<Value> {
    assertNoLegacyNowMs(options);
    const paths = resolveRecordSchedulerCoordinatorStorePaths(options);
    const lock = await acquireFileLock(paths, options.lock ?? {});
    try {
        return await action(lock);
    } finally {
        await lock.release();
    }
}

async function claimOwner(
    input: AcquireRecordSchedulerCoordinatorOwnerInput,
    requireExpiredLease: boolean,
): Promise<RecordSchedulerCoordinatorOwnerMutationResult> {
    assertNoLegacyNowMs(input);
    assertNonEmpty(input.ownerId, "ownerId");
    if (input.ownerLeaseId !== undefined) assertNonEmpty(input.ownerLeaseId, "ownerLeaseId");
    assertLeaseDuration(input.leaseDurationMs);
    const paths = resolveRecordSchedulerCoordinatorStorePaths(input);
    return withRecordSchedulerCoordinatorFileLock(async lock => {
        const current = await requireCurrent(paths);
        const nowMs = resolveOperationNow(
            input,
            requireExpiredLease ? "recover clock" : "acquire clock",
            envelopeClockFloor(current.envelope),
        );
        assertExpectedRevision(current.envelope, input.expectedRevision);
        const previousLease = current.envelope.ownerLease;
        if (requireExpiredLease && (previousLease === null || nowMs < previousLease.expiresAtMs)) {
            throw new RecordSchedulerCoordinatorFencedError("owner recover 只能接管已经过期的 owner lease");
        }
        if (!requireExpiredLease && previousLease !== null && nowMs < previousLease.expiresAtMs) {
            throw new RecordSchedulerCoordinatorOwnerBusyError(previousLease.expiresAtMs);
        }
        const epoch = current.envelope.ownerEpoch + 1;
        assertPositiveInteger(epoch, "next ownerEpoch");
        const lease: RecordSchedulerCoordinatorOwnerLease = {
            ownerId: input.ownerId,
            leaseId: input.ownerLeaseId ?? crypto.randomUUID(),
            epoch,
            acquiredAtMs: nowMs,
            heartbeatAtMs: nowMs,
            expiresAtMs: nowMs + input.leaseDurationMs,
        };
        assertSafeTimestamp(lease.expiresAtMs, "owner expiresAtMs");
        const envelope = finalizeEnvelope({
            ...current.envelope,
            revision: current.envelope.revision + 1,
            persistedHash: "",
            updatedAt: new Date(nowMs).toISOString(),
            ownerEpoch: epoch,
            ownerLease: lease,
            snapshot: cloneAndValidateSnapshot(current.snapshot),
        });
        await publishEnvelope(paths, envelope, lock);
        return {
            envelope,
            snapshot: envelope.snapshot,
            lease,
            ...(requireExpiredLease && previousLease !== null ? { recoveredLease: cloneLease(previousLease)! } : {}),
        };
    }, input);
}

async function readRecordSchedulerCoordinatorStoreAt(
    paths: RecordSchedulerCoordinatorStorePaths,
): Promise<RecordSchedulerCoordinatorStoreReadResult> {
    const layout = await inspectSafeLayout(paths, false);
    if (layout.kind === "missing-root") return { kind: "missing", paths };
    const raw = await readRawSnapshot(paths, layout.safety);
    if (raw === null) return { kind: "missing", paths };
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        return {
            kind: "corrupt",
            paths,
            reason: "invalid_json",
            detail: error instanceof Error ? `JSON 解析失败：${error.message}` : "JSON 解析失败",
        };
    }
    if (isPlainObject(value) && value.schemaVersion !== RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION) {
        return {
            kind: "unsupported",
            paths,
            schemaVersion: value.schemaVersion,
            detail: `不支持 record scheduler coordinator schemaVersion=${String(value.schemaVersion)}`,
        };
    }
    let envelope: RecordSchedulerCoordinatorStoreEnvelope;
    try {
        envelope = validateEnvelope(value);
    } catch (error) {
        return {
            kind: "corrupt",
            paths,
            reason: "invalid_envelope",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
    if (envelope.snapshot.repairRequired) {
        return {
            kind: "repair_required",
            paths,
            reason: "snapshot_repair_required",
            detail: "coordinator snapshot 已标记 repairRequired，拒绝自动覆盖其 active claim/recovery 证据",
            envelope,
            snapshot: envelope.snapshot,
        };
    }
    return { kind: "current", paths, envelope, snapshot: envelope.snapshot };
}

async function requireCurrent(paths: RecordSchedulerCoordinatorStorePaths): Promise<RecordSchedulerCoordinatorCurrentRead> {
    const read = await readRecordSchedulerCoordinatorStoreAt(paths);
    if (read.kind === "current") return read;
    if (read.kind === "missing") {
        throw new RecordSchedulerCoordinatorStoreError("record scheduler coordinator snapshot 不存在", "SNAPSHOT_MISSING");
    }
    throw new RecordSchedulerCoordinatorRepairRequiredError(read);
}

async function publishEnvelope(
    paths: RecordSchedulerCoordinatorStorePaths,
    envelope: RecordSchedulerCoordinatorStoreEnvelope,
    lock: RecordSchedulerCoordinatorFileLock,
): Promise<void> {
    await lock.assertHeld();
    const finalized = finalizeEnvelope(envelope);
    await writeDurableJsonAtomic(paths, finalized, lock);
    await lock.assertHeld();
    const readBack = await readPublishedEnvelope(paths);
    if (readBack.revision !== finalized.revision
        || readBack.persistedHash !== finalized.persistedHash
        || readBack.ownerEpoch !== finalized.ownerEpoch) {
        throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot 原子发布后的回读 hash/revision/epoch 不一致", "READBACK_MISMATCH");
    }
}

async function writeDurableJsonAtomic(
    paths: RecordSchedulerCoordinatorStorePaths,
    envelope: RecordSchedulerCoordinatorStoreEnvelope,
    lock: RecordSchedulerCoordinatorFileLock,
): Promise<void> {
    await lock.assertHeld();
    const initialSafety = await assertSafeWritableLayout(paths);
    const temporaryPath = `${paths.snapshotPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    let temporaryHandle: fs.promises.FileHandle | undefined;
    try {
        temporaryHandle = await fs.promises.open(temporaryPath, "wx", 0o600);
        await assertSafeWritableLayout(paths, initialSafety);
        await temporaryHandle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        await lock.assertHeld();
        await assertSafeWritableLayout(paths, initialSafety);
        await renameWithRetry(temporaryPath, paths.snapshotPath);
        await assertSafeWritableLayout(paths, initialSafety);
        await fsyncFile(paths, paths.snapshotPath, initialSafety);
        await fsyncDirectory(paths.dataRoot);
        await assertSafeWritableLayout(paths, initialSafety);
    } catch (error) {
        await temporaryHandle?.close().catch(() => undefined);
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof RecordSchedulerCoordinatorStoreError) throw error;
        throw new RecordSchedulerCoordinatorStoreError(
            `coordinator snapshot 原子持久化失败：${error instanceof Error ? error.message : String(error)}`,
            "ATOMIC_PUBLISH_FAILED",
        );
    }
}

async function acquireFileLock(
    paths: RecordSchedulerCoordinatorStorePaths,
    options: RecordSchedulerCoordinatorStoreLockOptions,
): Promise<RecordSchedulerCoordinatorFileLock> {
    const timeoutMs = positiveDuration(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lock timeoutMs");
    const staleMs = positiveDuration(options.staleMs, DEFAULT_LOCK_STALE_MS, "lock staleMs");
    const retryMs = positiveDuration(options.retryMs, DEFAULT_LOCK_RETRY_MS, "lock retryMs");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const initialSafety = await assertSafeWritableLayout(paths);
        const token = crypto.randomUUID();
        const createdAtMs = Date.now();
        try {
            const handle = await fs.promises.open(paths.lockPath, "wx", 0o600);
            const metadata: FileLockMetadata = {
                schemaVersion: FILE_LOCK_SCHEMA_VERSION,
                token,
                ownerPid: process.pid,
                processInstanceId: PROCESS_INSTANCE_ID,
                processStartedAtMs: PROCESS_STARTED_AT_MS,
                createdAtMs,
                heartbeatAtMs: createdAtMs,
            };
            try {
                await assertSafeWritableLayout(paths, initialSafety);
                await overwriteFileHandleAtStart(handle, JSON.stringify(metadata));
                await assertSafeWritableLayout(paths, initialSafety);
                return createFileLock(paths, metadata, handle);
            } catch (error) {
                await handle.close().catch(() => undefined);
                await releaseOwnedLock(paths, token).catch(() => undefined);
                throw error;
            }
        } catch (error) {
            if (!isErrno(error, "EEXIST") && !isTransientWindowsLockRace(error)) {
                throw new RecordSchedulerCoordinatorStoreError(
                    `获取 coordinator snapshot lock 失败：${error instanceof Error ? error.message : String(error)}`,
                    "LOCK_ACQUIRE_FAILED",
                );
            }
            await reclaimStaleFileLock(paths, staleMs);
            if (Date.now() >= deadline) throw new RecordSchedulerCoordinatorLockTimeoutError(timeoutMs);
            await sleep(retryMs);
        }
    }
}

function createFileLock(
    paths: RecordSchedulerCoordinatorStorePaths,
    initialMetadata: FileLockMetadata,
    handle: fs.promises.FileHandle,
): RecordSchedulerCoordinatorFileLock {
    let released = false;
    let handleClosed = false;
    let lastHeartbeatAtMs = initialMetadata.heartbeatAtMs;
    let operationTail: Promise<void> = Promise.resolve();
    const metadataLength = Buffer.byteLength(JSON.stringify(initialMetadata), "utf8");
    const serialize = <Value>(operation: () => Promise<Value>): Promise<Value> => {
        const result = operationTail.then(operation, operation);
        operationTail = result.then(() => undefined, () => undefined);
        return result;
    };
    const assertHeldUnsafe = async (): Promise<void> => {
        if (released) throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot lock 已释放", "LOCK_RELEASED");
        const snapshot = await readLockSnapshot(paths);
        if (snapshot === null
            || snapshot.metadata.token !== initialMetadata.token
            || snapshot.metadata.processInstanceId !== PROCESS_INSTANCE_ID
            || snapshot.metadata.processStartedAtMs !== PROCESS_STARTED_AT_MS) {
            throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot lock 已被其他进程接管", "LOCK_LOST");
        }
        const handleStat = await handle.stat();
        if (!sameObject(snapshot.stat, handleStat)) {
            throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot lock 文件对象已变更", "LOCK_LOST");
        }
    };
    return {
        path: paths.lockPath,
        token: initialMetadata.token,
        assertHeld(): Promise<void> {
            return serialize(assertHeldUnsafe);
        },
        async heartbeat(): Promise<void> {
            return serialize(async () => {
                await assertHeldUnsafe();
                lastHeartbeatAtMs = Math.max(lastHeartbeatAtMs, Date.now());
                const metadata: FileLockMetadata = { ...initialMetadata, heartbeatAtMs: lastHeartbeatAtMs };
                try {
                    await overwriteFileHandleAtStart(handle, JSON.stringify(metadata), metadataLength);
                    await assertHeldUnsafe();
                } catch (error) {
                    if (error instanceof RecordSchedulerCoordinatorStoreError) throw error;
                    throw new RecordSchedulerCoordinatorStoreError(
                        `coordinator snapshot lock heartbeat 失败：${error instanceof Error ? error.message : String(error)}`,
                        "LOCK_HEARTBEAT_FAILED",
                    );
                }
            });
        },
        async release(): Promise<void> {
            return serialize(async () => {
                if (released) return;
                if (!handleClosed) {
                    await handle.close();
                    handleClosed = true;
                }
                await releaseOwnedLock(paths, initialMetadata.token);
                released = true;
            });
        },
    };
}

interface FileLockMetadata {
    schemaVersion: typeof FILE_LOCK_SCHEMA_VERSION;
    token: string;
    ownerPid: number;
    processInstanceId: string;
    processStartedAtMs: number;
    createdAtMs: number;
    heartbeatAtMs: number;
}

interface FileLockSnapshot {
    metadata: FileLockMetadata;
    raw: string;
    stat: fs.Stats;
}

async function reclaimStaleFileLock(paths: RecordSchedulerCoordinatorStorePaths, staleMs: number): Promise<void> {
    const observed = await readLockSnapshot(paths);
    if (observed === null) {
        await reclaimOpaqueStaleFileLock(paths, staleMs);
        return;
    }
    if (!isStaleLock(observed, staleMs) || isLockOwnerInstanceAlive(observed.metadata)) return;
    const confirmed = await readLockSnapshot(paths);
    if (confirmed === null
        || !sameLockSnapshot(observed, confirmed)
        || !isStaleLock(confirmed, staleMs)
        || isLockOwnerInstanceAlive(confirmed.metadata)) return;
    const claimPath = `${paths.lockPath}.stale-claim.${crypto.createHash("sha256").update(confirmed.metadata.token).digest("hex").slice(0, 20)}`;
    try {
        await fs.promises.mkdir(claimPath);
    } catch (error) {
        if (isErrno(error, "EEXIST")) return;
        throw new RecordSchedulerCoordinatorStoreError(
            `创建 stale lock 原子 claim 失败：${error instanceof Error ? error.message : String(error)}`,
            "LOCK_STALE_CLAIM_FAILED",
        );
    }
    const quarantinePath = path.join(claimPath, "quarantined.lock");
    try {
        const beforeRename = await readLockSnapshot(paths);
        if (beforeRename === null
            || !sameLockSnapshot(confirmed, beforeRename)
            || !isStaleLock(beforeRename, staleMs)
            || isLockOwnerInstanceAlive(beforeRename.metadata)) return;
        try {
            await fs.promises.rename(paths.lockPath, quarantinePath);
        } catch (error) {
            if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) return;
            throw error;
        }
        const quarantined = await readLockSnapshot(paths, quarantinePath);
        if (quarantined === null || !sameLockSnapshot(beforeRename, quarantined) || isLockOwnerInstanceAlive(quarantined.metadata)) {
            await restoreQuarantinedLock(paths, quarantinePath, paths.lockPath);
            return;
        }
        await fs.promises.unlink(quarantinePath);
        await fsyncDirectory(claimPath);
    } finally {
        await fs.promises.rmdir(claimPath).catch(error => {
            if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) throw error;
        });
    }
}

interface OpaqueFileLockSnapshot {
    raw: string;
    stat: fs.Stats;
}

async function reclaimOpaqueStaleFileLock(paths: RecordSchedulerCoordinatorStorePaths, staleMs: number): Promise<void> {
    const opaqueStaleMs = Math.max(staleMs, MIN_OPAQUE_LOCK_STALE_MS);
    const observed = await readOpaqueLockSnapshot(paths);
    if (observed === null || Date.now() - observed.stat.mtimeMs < opaqueStaleMs) return;
    const confirmed = await readOpaqueLockSnapshot(paths);
    if (confirmed === null || !sameOpaqueLockSnapshot(observed, confirmed) || Date.now() - confirmed.stat.mtimeMs < opaqueStaleMs) return;
    const claimPath = `${paths.lockPath}.stale-opaque-claim.${crypto.createHash("sha256").update(confirmed.raw).digest("hex").slice(0, 20)}`;
    try {
        await fs.promises.mkdir(claimPath);
    } catch (error) {
        if (isErrno(error, "EEXIST")) return;
        throw new RecordSchedulerCoordinatorStoreError(
            `创建 opaque stale lock 原子 claim 失败：${error instanceof Error ? error.message : String(error)}`,
            "LOCK_STALE_CLAIM_FAILED",
        );
    }
    const quarantinePath = path.join(claimPath, "quarantined.lock");
    try {
        const beforeRename = await readOpaqueLockSnapshot(paths);
        if (beforeRename === null || !sameOpaqueLockSnapshot(confirmed, beforeRename) || Date.now() - beforeRename.stat.mtimeMs < opaqueStaleMs) return;
        try {
            await fs.promises.rename(paths.lockPath, quarantinePath);
        } catch (error) {
            if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) return;
            throw error;
        }
        const quarantined = await readOpaqueLockSnapshot(paths, quarantinePath);
        if (quarantined === null || !sameOpaqueLockSnapshot(beforeRename, quarantined)) {
            await restoreQuarantinedLock(paths, quarantinePath, paths.lockPath);
            return;
        }
        await fs.promises.unlink(quarantinePath);
        await fsyncDirectory(claimPath);
    } finally {
        await fs.promises.rmdir(claimPath).catch(error => {
            if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) throw error;
        });
    }
}

async function restoreQuarantinedLock(
    paths: RecordSchedulerCoordinatorStorePaths,
    quarantinePath: string,
    lockPath: string,
): Promise<void> {
    const safety = await assertSafeWritableLayout(paths);
    try {
        await fs.promises.link(quarantinePath, lockPath);
        await fs.promises.unlink(quarantinePath);
        await assertSafeWritableLayout(paths, safety);
    } catch (error) {
        if (!isErrno(error, "EEXIST")) {
            throw new RecordSchedulerCoordinatorStoreError(
                `恢复被错误隔离的 coordinator lock 失败：${error instanceof Error ? error.message : String(error)}`,
                "LOCK_STALE_RESTORE_FAILED",
            );
        }
    }
}

async function releaseOwnedLock(paths: RecordSchedulerCoordinatorStorePaths, token: string): Promise<void> {
    const snapshot = await readLockSnapshot(paths);
    if (snapshot === null || snapshot.metadata.token !== token) return;
    await lockTestHook?.({ phase: "before-release-unlink", lockPath: paths.lockPath, token });
    const safety = await assertSafeWritableLayout(paths);
    await fs.promises.unlink(paths.lockPath);
    await fsyncDirectory(paths.dataRoot);
    await assertSafeWritableLayout(paths, safety);
}

async function readLockSnapshot(
    paths: RecordSchedulerCoordinatorStorePaths,
    lockPath = paths.lockPath,
): Promise<FileLockSnapshot | null> {
    const layout = await inspectSafeLayout(paths, false);
    if (layout.kind === "missing-root") return null;
    let before: fs.Stats;
    try {
        before = await fs.promises.lstat(lockPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
    assertSafeRegularFile(before, lockPath);
    await lockTestHook?.({ phase: "after-lock-lstat-before-open", lockPath, reader: "structured" });
    let handle: fs.promises.FileHandle;
    try {
        handle = await openNoFollow(lockPath, fs.constants.O_RDONLY);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!sameObject(before, stat)) throw new RecordSchedulerCoordinatorPathSafetyError(`coordinator lock 在打开时发生路径替换：${lockPath}`);
        const raw = await handle.readFile("utf8");
        await lockTestHook?.({ phase: "after-lock-read-before-lstat", lockPath, reader: "structured" });
        let after: fs.Stats;
        try {
            after = await fs.promises.lstat(lockPath);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return null;
            throw error;
        }
        if (!sameObject(stat, after)) throw new RecordSchedulerCoordinatorPathSafetyError(`coordinator lock 在读取时发生路径替换：${lockPath}`);
        await inspectSafeLayout(paths, false, layout.safety);
        let value: unknown;
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
        if (!isFileLockMetadata(value)) return null;
        return { metadata: value, raw, stat };
    } finally {
        await handle.close();
    }
}

async function readOpaqueLockSnapshot(
    paths: RecordSchedulerCoordinatorStorePaths,
    lockPath = paths.lockPath,
): Promise<OpaqueFileLockSnapshot | null> {
    const layout = await inspectSafeLayout(paths, false);
    if (layout.kind === "missing-root") return null;
    let before: fs.Stats;
    try {
        before = await fs.promises.lstat(lockPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
    assertSafeRegularFile(before, lockPath);
    await lockTestHook?.({ phase: "after-lock-lstat-before-open", lockPath, reader: "opaque" });
    let handle: fs.promises.FileHandle;
    try {
        handle = await openNoFollow(lockPath, fs.constants.O_RDONLY);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!sameObject(before, stat)) throw new RecordSchedulerCoordinatorPathSafetyError(`coordinator lock 在打开时发生路径替换：${lockPath}`);
        const raw = await handle.readFile("utf8");
        await lockTestHook?.({ phase: "after-lock-read-before-lstat", lockPath, reader: "opaque" });
        let after: fs.Stats;
        try {
            after = await fs.promises.lstat(lockPath);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return null;
            throw error;
        }
        if (!sameObject(stat, after)) throw new RecordSchedulerCoordinatorPathSafetyError(`coordinator lock 在读取时发生路径替换：${lockPath}`);
        await inspectSafeLayout(paths, false, layout.safety);
        return { raw, stat };
    } finally {
        await handle.close();
    }
}

interface SafeLayoutSnapshot {
    dataRootRealPath: string;
    dataRootIdentity: string;
    parentRealPath: string;
    parentIdentity: string;
}

type SafeLayoutRead = { kind: "current"; safety: SafeLayoutSnapshot } | { kind: "missing-root" };

async function inspectSafeLayout(
    paths: RecordSchedulerCoordinatorStorePaths,
    createRoot: boolean,
    expected?: SafeLayoutSnapshot,
): Promise<SafeLayoutRead> {
    if (createRoot) await fs.promises.mkdir(paths.dataRoot, { recursive: true });
    const parentPath = path.dirname(paths.dataRoot);
    const parent = await fs.promises.lstat(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
        throw new RecordSchedulerCoordinatorPathSafetyError(`DATA_ROOT 父目录不是安全普通目录：${parentPath}`);
    }
    const parentRealPath = await fs.promises.realpath(parentPath);
    if (!samePath(parentRealPath, parentPath)) {
        throw new RecordSchedulerCoordinatorPathSafetyError(`DATA_ROOT 父目录含 junction/symlink 祖先：${parentPath} -> ${parentRealPath}`);
    }
    let root: fs.Stats;
    try {
        root = await fs.promises.lstat(paths.dataRoot);
    } catch (error) {
        if (isErrno(error, "ENOENT") && !createRoot) return { kind: "missing-root" };
        throw error;
    }
    if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new RecordSchedulerCoordinatorPathSafetyError(`DATA_ROOT 不是安全普通目录：${paths.dataRoot}`);
    }
    const dataRootRealPath = await fs.promises.realpath(paths.dataRoot);
    if (!samePath(dataRootRealPath, paths.dataRoot) || !samePath(path.dirname(dataRootRealPath), parentRealPath)) {
        throw new RecordSchedulerCoordinatorPathSafetyError(`DATA_ROOT realpath 不稳定或含 junction/symlink 祖先：${paths.dataRoot} -> ${dataRootRealPath}`);
    }
    const safety: SafeLayoutSnapshot = {
        dataRootRealPath,
        dataRootIdentity: objectIdentity(root),
        parentRealPath,
        parentIdentity: objectIdentity(parent),
    };
    if (expected !== undefined && !sameSafeLayout(expected, safety)) {
        throw new RecordSchedulerCoordinatorPathSafetyError("DATA_ROOT 或父目录身份在文件操作期间发生变化");
    }
    await assertOptionalSafeFile(paths.snapshotPath);
    await assertOptionalSafeFile(paths.lockPath);
    return { kind: "current", safety };
}

async function assertSafeWritableLayout(
    paths: RecordSchedulerCoordinatorStorePaths,
    expected?: SafeLayoutSnapshot,
): Promise<SafeLayoutSnapshot> {
    const layout = await inspectSafeLayout(paths, true, expected);
    if (layout.kind !== "current") throw new RecordSchedulerCoordinatorPathSafetyError("DATA_ROOT 创建后仍不存在");
    if (path.dirname(paths.snapshotPath) !== paths.dataRoot || path.dirname(paths.lockPath) !== paths.dataRoot) {
        throw new RecordSchedulerCoordinatorPathSafetyError("coordinator snapshot 目标父目录越出 DATA_ROOT");
    }
    return layout.safety;
}

async function assertOptionalSafeFile(filePath: string): Promise<void> {
    try {
        const stat = await fs.promises.lstat(filePath);
        assertSafeRegularFile(stat, filePath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
    }
}

async function readRawSnapshot(
    paths: RecordSchedulerCoordinatorStorePaths,
    expectedSafety?: SafeLayoutSnapshot,
): Promise<string | null> {
    const layout = await inspectSafeLayout(paths, false, expectedSafety);
    if (layout.kind === "missing-root") return null;
    const snapshotPath = paths.snapshotPath;
    let before: fs.Stats;
    try {
        before = await fs.promises.lstat(snapshotPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
    }
    assertSafeRegularFile(before, snapshotPath);
    const handle = await openNoFollow(snapshotPath, fs.constants.O_RDONLY);
    try {
        const stat = await handle.stat();
        if (!sameObject(before, stat)) throw new RecordSchedulerCoordinatorPathSafetyError(`snapshot 在打开时发生路径替换：${snapshotPath}`);
        const raw = await handle.readFile("utf8");
        const after = await fs.promises.lstat(snapshotPath);
        if (!sameObject(stat, after)) throw new RecordSchedulerCoordinatorPathSafetyError(`snapshot 在读取时发生路径替换：${snapshotPath}`);
        await inspectSafeLayout(paths, false, layout.safety);
        return raw;
    } finally {
        await handle.close();
    }
}

async function readPublishedEnvelope(paths: RecordSchedulerCoordinatorStorePaths): Promise<RecordSchedulerCoordinatorStoreEnvelope> {
    const raw = await readRawSnapshot(paths);
    if (raw === null) throw new RecordSchedulerCoordinatorStoreError("原子发布后 snapshot 文件缺失", "READBACK_MISMATCH");
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw new RecordSchedulerCoordinatorStoreError(
            `原子发布后 snapshot JSON 无法解析：${error instanceof Error ? error.message : String(error)}`,
            "READBACK_MISMATCH",
        );
    }
    return validateEnvelope(value);
}

async function overwriteFileHandleAtStart(
    handle: fs.promises.FileHandle,
    content: string,
    expectedLength?: number,
): Promise<void> {
    const buffer = Buffer.from(content, "utf8");
    if (expectedLength !== undefined && buffer.byteLength !== expectedLength) {
        throw new RecordSchedulerCoordinatorStoreError("lock heartbeat 元数据长度发生变化，拒绝非原位完整覆盖", "LOCK_METADATA_SIZE_CHANGED");
    }
    let written = 0;
    while (written < buffer.byteLength) {
        const result = await handle.write(buffer, written, buffer.byteLength - written, written);
        if (result.bytesWritten <= 0) throw new RecordSchedulerCoordinatorStoreError("lock 元数据位置写入未取得进展", "LOCK_WRITE_FAILED");
        written += result.bytesWritten;
    }
    await handle.truncate(buffer.byteLength);
    await handle.sync();
}

async function openNoFollow(filePath: string, flags: number): Promise<fs.promises.FileHandle> {
    const noFollow = fs.constants.O_NOFOLLOW;
    try {
        return await fs.promises.open(filePath, flags | noFollow);
    } catch (error) {
        if (isNoFollowUnsupported(error)) return fs.promises.open(filePath, flags);
        throw error;
    }
}

async function fsyncFile(
    paths: RecordSchedulerCoordinatorStorePaths,
    filePath: string,
    expectedSafety: SafeLayoutSnapshot,
): Promise<void> {
    await inspectSafeLayout(paths, false, expectedSafety);
    const handle = await openNoFollow(filePath, fs.constants.O_RDWR);
    try {
        await handle.sync();
        await inspectSafeLayout(paths, false, expectedSafety);
    } finally {
        await handle.close();
    }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await fs.promises.open(directoryPath, fs.constants.O_RDONLY);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function renameWithRetry(sourcePath: string, targetPath: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fs.promises.rename(sourcePath, targetPath);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt === 4) throw error;
            await sleep(10 * 2 ** attempt);
        }
    }
}

function validateEnvelope(value: unknown): RecordSchedulerCoordinatorStoreEnvelope {
    if (!isPlainObject(value)
        || value.schemaVersion !== RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION
        || !isPositiveInteger(value.revision)
        || !isSha256(value.persistedHash)
        || !isIsoTimestamp(value.updatedAt)
        || !isNonNegativeInteger(value.ownerEpoch)
        || !(value.ownerLease === null || isOwnerLease(value.ownerLease))
        || !isPlainObject(value.snapshot)) {
        throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot envelope 字段非法", "INVALID_ENVELOPE");
    }
    const envelope = value as unknown as RecordSchedulerCoordinatorStoreEnvelope;
    if (envelope.ownerLease !== null && envelope.ownerLease.epoch !== envelope.ownerEpoch) {
        throw new RecordSchedulerCoordinatorStoreError("owner lease epoch 与 envelope ownerEpoch 不一致", "INVALID_ENVELOPE");
    }
    const snapshot = cloneAndValidateSnapshot(envelope.snapshot);
    const normalized: RecordSchedulerCoordinatorStoreEnvelope = {
        schemaVersion: envelope.schemaVersion,
        revision: envelope.revision,
        persistedHash: envelope.persistedHash,
        updatedAt: envelope.updatedAt,
        ownerEpoch: envelope.ownerEpoch,
        ownerLease: cloneLease(envelope.ownerLease),
        snapshot,
    };
    if (calculateRecordSchedulerCoordinatorEnvelopeHash(normalized) !== normalized.persistedHash) {
        throw new RecordSchedulerCoordinatorStoreError("persistedHash 与 coordinator snapshot envelope 内容不匹配", "HASH_MISMATCH");
    }
    return normalized;
}

function finalizeEnvelope(envelope: RecordSchedulerCoordinatorStoreEnvelope): RecordSchedulerCoordinatorStoreEnvelope {
    const snapshot = cloneAndValidateSnapshot(envelope.snapshot);
    const normalized: RecordSchedulerCoordinatorStoreEnvelope = {
        schemaVersion: RECORD_SCHEDULER_COORDINATOR_STORE_SCHEMA_VERSION,
        revision: envelope.revision,
        persistedHash: "",
        updatedAt: envelope.updatedAt,
        ownerEpoch: envelope.ownerEpoch,
        ownerLease: cloneLease(envelope.ownerLease),
        snapshot,
    };
    assertEnvelopeShape(normalized);
    normalized.persistedHash = calculateRecordSchedulerCoordinatorEnvelopeHash(normalized);
    return normalized;
}

function assertEnvelopeShape(envelope: RecordSchedulerCoordinatorStoreEnvelope): void {
    if (!isPositiveInteger(envelope.revision)) throw new RecordSchedulerCoordinatorStoreError("revision 必须是正整数", "INVALID_ENVELOPE");
    if (!isIsoTimestamp(envelope.updatedAt)) throw new RecordSchedulerCoordinatorStoreError("updatedAt 必须是 ISO 时间", "INVALID_ENVELOPE");
    if (!isNonNegativeInteger(envelope.ownerEpoch)) throw new RecordSchedulerCoordinatorStoreError("ownerEpoch 必须是非负整数", "INVALID_ENVELOPE");
    if (envelope.ownerLease !== null && (!isOwnerLease(envelope.ownerLease) || envelope.ownerLease.epoch !== envelope.ownerEpoch)) {
        throw new RecordSchedulerCoordinatorStoreError("owner lease 非法或 epoch 不匹配", "INVALID_ENVELOPE");
    }
}

function cloneAndValidateSnapshot(snapshot: RecordSchedulerCoordinatorSnapshot): RecordSchedulerCoordinatorSnapshot {
    let json: string;
    try {
        json = JSON.stringify(snapshot);
    } catch (error) {
        throw new RecordSchedulerCoordinatorStoreError(
            `coordinator snapshot 不可 JSON 序列化：${error instanceof Error ? error.message : String(error)}`,
            "SNAPSHOT_NOT_JSON",
        );
    }
    if (json === undefined) throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot 不可 JSON 序列化", "SNAPSHOT_NOT_JSON");
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot JSON 重解析失败", "SNAPSHOT_NOT_JSON");
    }
    if (!isJsonValue(snapshot) || !isCoordinatorSnapshotShape(parsed)) {
        throw new RecordSchedulerCoordinatorStoreError("coordinator snapshot 必须是纯 JSON 数据并包含 coordinator snapshot 必填结构", "INVALID_SNAPSHOT");
    }
    return parsed as RecordSchedulerCoordinatorSnapshot;
}

function isCoordinatorSnapshotShape(value: unknown): value is RecordSchedulerCoordinatorSnapshot {
    if (!isPlainObject(value)
        || !isPositiveInteger(value.version)
        || !isPlainObject(value.fairness)
        || !isNonNegativeInteger(value.fairness.dispatchSeq)
        || !Array.isArray(value.ledgerBindings)
        || !Array.isArray(value.activeClaims)
        || typeof value.repairRequired !== "boolean"
        || !Array.isArray(value.recoveryIssues)
        || !isNonNegativeInteger(value.logicalUnitCount)
        || !isNonNegativeInteger(value.activeClaimCount)
        || !isNonNegativeInteger(value.materializedPromptCount)
        || !Array.isArray(value.waitingReasons)) return false;
    return value.nextWakeAt === undefined || (typeof value.nextWakeAt === "number" && Number.isFinite(value.nextWakeAt));
}

function assertExpectedRevision(envelope: RecordSchedulerCoordinatorStoreEnvelope, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && envelope.revision !== expectedRevision) {
        throw new RecordSchedulerCoordinatorConflictError(expectedRevision, envelope.revision);
    }
}

function assertCurrentOwnerFence(
    envelope: RecordSchedulerCoordinatorStoreEnvelope,
    fence: RecordSchedulerCoordinatorOwnerFence,
    nowMs: number,
): void {
    const lease = envelope.ownerLease;
    if (lease === null || lease.epoch !== fence.ownerEpoch || lease.leaseId !== fence.ownerLeaseId) {
        throw new RecordSchedulerCoordinatorFencedError("owner epoch 或 lease token 不匹配，旧 production pump 被 fencing 拒绝");
    }
    if (nowMs >= lease.expiresAtMs) {
        throw new RecordSchedulerCoordinatorFencedError("owner lease 已过期，拒绝旧 production pump 写入");
    }
}

function cloneLease(lease: RecordSchedulerCoordinatorOwnerLease | null): RecordSchedulerCoordinatorOwnerLease | null {
    return lease === null ? null : { ...lease };
}

function isOwnerLease(value: unknown): value is RecordSchedulerCoordinatorOwnerLease {
    return isPlainObject(value)
        && isNonEmptyString(value.ownerId)
        && isNonEmptyString(value.leaseId)
        && isPositiveInteger(value.epoch)
        && isSafeTimestamp(value.acquiredAtMs)
        && isSafeTimestamp(value.heartbeatAtMs)
        && isSafeTimestamp(value.expiresAtMs)
        && value.acquiredAtMs <= value.heartbeatAtMs
        && value.heartbeatAtMs < value.expiresAtMs;
}

function isFileLockMetadata(value: unknown): value is FileLockMetadata {
    return isPlainObject(value)
        && value.schemaVersion === FILE_LOCK_SCHEMA_VERSION
        && isNonEmptyString(value.token)
        && isPositiveInteger(value.ownerPid)
        && isNonEmptyString(value.processInstanceId)
        && isSafeTimestamp(value.processStartedAtMs)
        && isSafeTimestamp(value.createdAtMs)
        && isSafeTimestamp(value.heartbeatAtMs)
        && value.createdAtMs <= value.heartbeatAtMs;
}

function isStaleLock(snapshot: FileLockSnapshot, staleMs: number): boolean {
    return Date.now() - Math.max(snapshot.metadata.heartbeatAtMs, snapshot.stat.mtimeMs) >= staleMs;
}

function isJsonValue(value: unknown): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    if (!isPlainObject(value)) return false;
    return Object.values(value).every(entry => entry !== undefined && isJsonValue(entry));
}

function stableJsonStringify(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new RecordSchedulerCoordinatorStoreError("hash 不支持非有限 number", "INVALID_HASH_VALUE");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
    if (!isPlainObject(value)) throw new RecordSchedulerCoordinatorStoreError("hash 只支持纯 JSON 值", "INVALID_HASH_VALUE");
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertSafeRegularFile(stat: fs.Stats, filePath: string): void {
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new RecordSchedulerCoordinatorPathSafetyError(`不接受符号链接或非普通文件：${filePath}`);
    }
}

function sameObject(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function objectIdentity(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function sameSafeLayout(left: SafeLayoutSnapshot, right: SafeLayoutSnapshot): boolean {
    return samePath(left.dataRootRealPath, right.dataRootRealPath)
        && left.dataRootIdentity === right.dataRootIdentity
        && samePath(left.parentRealPath, right.parentRealPath)
        && left.parentIdentity === right.parentIdentity;
}

function samePath(left: string, right: string): boolean {
    const normalizedLeft = path.resolve(left).replace(/[\\/]+$/u, "");
    const normalizedRight = path.resolve(right).replace(/[\\/]+$/u, "");
    return process.platform === "win32"
        ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
        : normalizedLeft === normalizedRight;
}

function sameLockSnapshot(left: FileLockSnapshot, right: FileLockSnapshot): boolean {
    return left.raw === right.raw
        && sameObject(left.stat, right.stat)
        && left.stat.mtimeMs === right.stat.mtimeMs
        && left.stat.size === right.stat.size
        && left.metadata.token === right.metadata.token
        && left.metadata.ownerPid === right.metadata.ownerPid
        && left.metadata.processInstanceId === right.metadata.processInstanceId
        && left.metadata.processStartedAtMs === right.metadata.processStartedAtMs
        && left.metadata.heartbeatAtMs === right.metadata.heartbeatAtMs;
}

function sameOpaqueLockSnapshot(left: OpaqueFileLockSnapshot, right: OpaqueFileLockSnapshot): boolean {
    return left.raw === right.raw
        && sameObject(left.stat, right.stat)
        && left.stat.mtimeMs === right.stat.mtimeMs
        && left.stat.size === right.stat.size;
}

function isLockOwnerInstanceAlive(metadata: FileLockMetadata): boolean {
    if (metadata.ownerPid === process.pid) {
        return metadata.processInstanceId === PROCESS_INSTANCE_ID
            && metadata.processStartedAtMs === PROCESS_STARTED_AT_MS;
    }
    try {
        process.kill(metadata.ownerPid, 0);
        return true;
    } catch (error) {
        return !isErrno(error, "ESRCH");
    }
}

function isNoFollowUnsupported(error: unknown): boolean {
    return isErrno(error, "EINVAL") || isErrno(error, "ENOTSUP") || isErrno(error, "EOPNOTSUPP");
}

function isTransientWindowsLockRace(error: unknown): boolean {
    return process.platform === "win32" && (isErrno(error, "EACCES") || isErrno(error, "EPERM"));
}

function isErrno(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
    if (!isNonEmptyString(value)) throw new RecordSchedulerCoordinatorStoreError(`${name} 必须是非空字符串`, "INVALID_STRING");
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
    if (!isPositiveInteger(value)) throw new RecordSchedulerCoordinatorStoreError(`${name} 必须是正安全整数`, "INVALID_INTEGER");
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
    return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!isPositiveInteger(resolved)) throw new RecordSchedulerCoordinatorStoreError(`${name} 必须是正安全整数`, "INVALID_DURATION");
    return resolved;
}

function assertLeaseDuration(value: number): void {
    if (!isPositiveInteger(value) || value > MAX_OWNER_LEASE_MS) {
        throw new RecordSchedulerCoordinatorStoreError(`leaseDurationMs 必须是 1 到 ${MAX_OWNER_LEASE_MS} 的安全整数`, "INVALID_LEASE_DURATION");
    }
}

function assertNoLegacyNowMs(value: object): void {
    if (Object.prototype.hasOwnProperty.call(value, "nowMs")) {
        throw new RecordSchedulerCoordinatorStoreError(
            "公开 nowMs 已禁用；测试必须显式使用 createRecordSchedulerCoordinatorTestClockForTest",
            "LEGACY_NOW_MS_FORBIDDEN",
        );
    }
}

function resolveOperationNow(
    options: RecordSchedulerCoordinatorStoreOptions,
    name: string,
    lowerBoundMs = 0,
): number {
    const testClock = options.testClock;
    if (testClock !== undefined && testClock[TEST_CLOCK_BRAND] !== true) {
        throw new RecordSchedulerCoordinatorStoreError("testClock 缺少 test-only 类型标记", "INVALID_TEST_CLOCK");
    }
    const nowMs = testClock?.now() ?? Date.now();
    assertSafeTimestamp(nowMs, name);
    if (nowMs < lowerBoundMs) throw new RecordSchedulerCoordinatorClockRollbackError(nowMs, lowerBoundMs);
    return nowMs;
}

function envelopeClockFloor(envelope: RecordSchedulerCoordinatorStoreEnvelope): number {
    return Math.max(
        Date.parse(envelope.updatedAt),
        envelope.ownerLease?.acquiredAtMs ?? 0,
        envelope.ownerLease?.heartbeatAtMs ?? 0,
    );
}

function assertSafeTimestamp(value: unknown, name: string): asserts value is number {
    if (!isSafeTimestamp(value)) throw new RecordSchedulerCoordinatorStoreError(`${name} 必须是非负安全整数`, "INVALID_TIMESTAMP");
}
