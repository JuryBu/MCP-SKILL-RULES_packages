import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ROOT } from "./store.js";
import {
    isEnvelopeBoundAdmission,
    isAttemptDispatchAllowed,
    isTerminalTaskState,
    readRecordSchedulerLedger as parseRecordSchedulerLedger,
    type AttemptDispatchDurabilityReceipt,
    type EnvelopeBoundAdmission,
    type ImmutableBlobReference,
    type RecordSchedulerAdmissionReceipt,
    type RecordSchedulerFaultPoint,
    type RecordSchedulerLedger,
    type SchedulerAdmissionCapsule,
    type SchedulerAdmissionBackgroundProjection,
    type SchedulerAdmissionIdentity,
    type SchedulerLedgerAnchor,
    type SchedulerLedgerReadResult,
} from "./record-scheduler-contracts.js";

const RECORD_RECOVERY_DIR = path.join(DATA_ROOT, "record-recovery");
const RECORD_SCHEDULER_ADMISSION_NAMESPACE_LOCK_ID = "record-scheduler-admission-namespace";
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MIN_OWNER_LEASE_MS = 1_000;
const SCHEDULER_OWNER_PROCESS_QUERY_TIMEOUT_MS = 750;
const SCHEDULER_OWNER_START_TIME_MATCH_TOLERANCE_MS = 2_000;
const CURRENT_SCHEDULER_OWNER_STARTED_AT_MS = Math.max(1, Math.round(performance.timeOrigin));

export interface SchedulerOwnerLease {
    ownerId: string;
    leaseId: string;
    schedulerEpoch: number;
    fencingToken: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
    ownerPid?: number;
    ownerStartedAtMs?: number;
}

export type SchedulerOwnerProcessProbeResult =
    | { kind: "alive"; startedAtMs: number }
    | { kind: "dead" }
    | { kind: "unknown" };

export type SchedulerOwnerProcessProbeForTest = (pid: number) => Promise<SchedulerOwnerProcessProbeResult> | SchedulerOwnerProcessProbeResult;

export interface SchedulerOwnerRecoveryState {
    required: true;
    reason: "registry-lease-reacquire";
    previousTaskState: RecordSchedulerLedger["task"]["state"];
    claimedAt: string;
    pendingRecordWorkKeys: string[];
}

export type PersistedRecordSchedulerLedger = RecordSchedulerLedger & {
    schedulerOwner?: SchedulerOwnerLease;
    schedulerOwnerRecovery?: SchedulerOwnerRecoveryState;
};

export interface SchedulerLedgerFaultContext {
    point: RecordSchedulerFaultPoint;
    taskId: string;
    operation: "create" | "mutation" | "owner-claim" | "owner-heartbeat" | "admission-capsule";
    revision?: number;
    path: string;
}

export type SchedulerLedgerFaultInjector = (context: SchedulerLedgerFaultContext) => void | Promise<void>;

export interface SchedulerLedgerLockOptions {
    timeoutMs?: number;
    staleMs?: number;
}

export type SchedulerLedgerLockTestPhase = "before-acquire" | "before-lock-write" | "before-stale-read" | "stale-observed" | "stale-claim-acquired" | "stale-quarantined";

export interface SchedulerLedgerLockTestContext {
    phase: SchedulerLedgerLockTestPhase;
    taskId: string;
    lockPath: string;
    token: string;
    ownerPid: number;
}

export type SchedulerLedgerLockTestHook = (context: SchedulerLedgerLockTestContext) => void | Promise<void>;

export interface SchedulerLedgerDurabilityReceipt {
    scope: "process-crash-hot-restart";
    temporaryFileSynced: true;
    atomicReplaceCompleted: true;
    targetFileSynced: true;
    parentDirectory: {
        method: "directory-fsync" | "windows-target-file-flush";
        directoryFsyncSupported: boolean;
        durableBarrierCompleted: true;
    };
}

export interface ReadSchedulerLedgerOptions {
    expectPublished?: boolean;
    nowMs?: number;
}

export type SchedulerLedgerStoreReadResult =
    | { kind: "missing"; path: string; canCreate: true }
    | { kind: "current"; path: string; ledger: PersistedRecordSchedulerLedger; parsed: Extract<SchedulerLedgerReadResult, { kind: "current" }> }
    | { kind: "legacy"; path: string; parsed: Extract<SchedulerLedgerReadResult, { kind: "legacy" }> }
    | { kind: "repair_required"; path: string; reason: "missing_published_ledger" | "invalid_json" | "ledger_hash_mismatch" | "invalid_scheduler_owner_lease" | "invalid_scheduler_owner_recovery" | "invalid_current_ledger" }
    | { kind: "rejected"; path: string; parsed: Extract<SchedulerLedgerReadResult, { kind: "rejected" }> };

export interface StoredSchedulerLedger {
    path: string;
    ledger: PersistedRecordSchedulerLedger;
    revision: number;
    hash: string;
    durability: SchedulerLedgerDurabilityReceipt;
}

export type RecordSchedulerAttemptDispatchDurabilityReceipt = AttemptDispatchDurabilityReceipt & {
    storeDurability: SchedulerLedgerDurabilityReceipt;
};

export interface StoredSchedulerAdmissionCapsule {
    path: string;
    capsule: SchedulerAdmissionCapsule;
    ref: ImmutableBlobReference;
    durability: SchedulerLedgerDurabilityReceipt;
}

export type SchedulerTaskAdmissionVerification =
    | { kind: "unadmitted"; taskId: string; ledger: PersistedRecordSchedulerLedger; reason: "capsule_missing" }
    | { kind: "verified"; taskId: string; ledger: PersistedRecordSchedulerLedger; capsule: SchedulerAdmissionCapsule; receipt: RecordSchedulerAdmissionReceipt }
    | { kind: "repair_required"; taskId: string; ledger?: PersistedRecordSchedulerLedger; reason: string };

export interface SchedulerLedgerMutationOptions {
    lock?: SchedulerLedgerLockOptions;
}

export interface SchedulerOwnerLeaseOptions extends SchedulerLedgerMutationOptions {
    nowMs?: number;
    leaseMs?: number;
}

interface SchedulerOwnerTakeoverApproval {
    leaseId: string;
    ownerPid: number;
    ownerStartedAtMs: number;
}

export interface CompleteSchedulerOwnerRecoveryOptions extends SchedulerLedgerMutationOptions {
    nowMs?: number;
    recoveredRecordWorkKeys: readonly string[];
}

export interface CreateAttemptDispatchReceiptOptions extends SchedulerLedgerMutationOptions {
    expectedRevision?: number;
    ownerLease?: SchedulerOwnerLease;
    nowMs?: number;
}

export class SchedulerLedgerStoreError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = "SchedulerLedgerStoreError";
    }
}

export class SchedulerLedgerConflictError extends SchedulerLedgerStoreError {
    constructor(readonly taskId: string, readonly expectedRevision: number, readonly actualRevision: number) {
        super(`scheduler ledger ${taskId} revision 冲突：期望 ${expectedRevision}，实际 ${actualRevision}`, "REVISION_CONFLICT");
        this.name = "SchedulerLedgerConflictError";
    }
}

export class SchedulerLedgerMissingError extends SchedulerLedgerStoreError {
    constructor(readonly taskId: string) {
        super(`已发布 scheduler ledger ${taskId} 缺失，必须进入 RepairRequired，禁止当作首次创建`, "PUBLISHED_LEDGER_MISSING");
        this.name = "SchedulerLedgerMissingError";
    }
}

export class SchedulerLedgerRepairRequiredError extends SchedulerLedgerStoreError {
    constructor(readonly taskId: string, readonly reason: string) {
        super(`scheduler ledger ${taskId} 需要修复：${reason}`, "REPAIR_REQUIRED");
        this.name = "SchedulerLedgerRepairRequiredError";
    }
}

export class SchedulerLedgerLockTimeoutError extends SchedulerLedgerStoreError {
    constructor(readonly taskId: string, readonly timeoutMs: number) {
        super(`scheduler ledger ${taskId} 文件锁在 ${timeoutMs}ms 内未释放`, "LOCK_TIMEOUT");
        this.name = "SchedulerLedgerLockTimeoutError";
    }
}

export class SchedulerOwnerLeaseError extends SchedulerLedgerStoreError {
    constructor(readonly taskId: string, message: string, readonly code: "OWNER_LEASE_HELD" | "OWNER_FENCED" | "OWNER_LEASE_REQUIRED") {
        super(message, code);
        this.name = "SchedulerOwnerLeaseError";
    }
}

export class SchedulerLedgerDurabilityError extends SchedulerLedgerStoreError {
    constructor(message: string, code: "TARGET_FILE_SYNC_FAILED" | "PARENT_DIRECTORY_SYNC_FAILED") {
        super(message, code);
        this.name = "SchedulerLedgerDurabilityError";
    }
}

let faultInjector: SchedulerLedgerFaultInjector | undefined;
let lockTestHook: SchedulerLedgerLockTestHook | undefined;
let schedulerOwnerProcessProbeForTest: SchedulerOwnerProcessProbeForTest | undefined;

export function setRecordSchedulerStoreFaultInjectorForTest(injector?: SchedulerLedgerFaultInjector): void {
    faultInjector = injector;
}

export function setRecordSchedulerLockTestHookForTest(hook?: SchedulerLedgerLockTestHook): void {
    lockTestHook = hook;
}

export function setSchedulerOwnerProcessProbeForTest(probe?: SchedulerOwnerProcessProbeForTest): void {
    schedulerOwnerProcessProbeForTest = probe;
}

export function recordSchedulerRecoveryDir(): string {
    return RECORD_RECOVERY_DIR;
}

export function recordSchedulerLedgerPath(taskId: string): string {
    assertSafeTaskId(taskId);
    return path.join(RECORD_RECOVERY_DIR, `record-scheduler-${taskId}.json`);
}

export function recordSchedulerAdmissionCapsulePath(taskId: string): string {
    assertSafeTaskId(taskId);
    return path.resolve(RECORD_RECOVERY_DIR, "admissions", `${taskId}.admission.json`);
}

export function recordSchedulerAdmissionNamespaceLockPath(): string {
    return path.resolve(RECORD_RECOVERY_DIR, `${RECORD_SCHEDULER_ADMISSION_NAMESPACE_LOCK_ID}.lock`);
}

export function recordSchedulerLedgerLockPath(taskId: string): string {
    return `${recordSchedulerLedgerPath(taskId)}.lock`;
}

export function createRecordSchedulerTaskId(): string {
    return `record-scheduler-${crypto.randomUUID()}`;
}

export function listRecordSchedulerLedgerTaskIds(): string[] {
    if (!fs.existsSync(RECORD_RECOVERY_DIR)) return [];
    return fs.readdirSync(RECORD_RECOVERY_DIR, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.startsWith("record-scheduler-") && entry.name.endsWith(".json"))
        .map(entry => entry.name.slice("record-scheduler-".length, -".json".length))
        .filter(taskId => {
            try {
                assertSafeTaskId(taskId);
                return true;
            } catch {
                return false;
            }
        })
        .sort();
}

export function listRecordSchedulerAdmissionCapsuleTaskIds(): string[] {
    const admissionDirectory = path.resolve(RECORD_RECOVERY_DIR, "admissions");
    const suffix = ".admission.json";
    if (!fs.existsSync(admissionDirectory)) return [];
    return fs.readdirSync(admissionDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
        .map(entry => entry.name.slice(0, -suffix.length))
        .filter(taskId => {
            try {
                assertSafeTaskId(taskId);
                return true;
            } catch {
                return false;
            }
        })
        .sort();
}

export function calculateRecordSchedulerAdmissionRequestHash(
    taskKind: RecordSchedulerAdmissionReceipt["taskKind"],
    requestSummary: Record<string, unknown>,
    backgroundProjection: SchedulerAdmissionBackgroundProjection,
): string {
    return sha256(stableJsonStringify({ taskKind, requestSummary, backgroundProjection }));
}

export function calculateRecordSchedulerLedgerHash(ledger: RecordSchedulerLedger): string {
    const payload = structuredClone(ledger) as unknown as Record<string, unknown>;
    delete payload.persistedHash;
    return crypto.createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

export function createSchedulerLedgerAnchor(stored: Pick<StoredSchedulerLedger, "path" | "revision" | "hash">): SchedulerLedgerAnchor {
    if (stored.revision !== 1) {
        throw new SchedulerLedgerRepairRequiredError("unknown", "admission anchor 只能绑定 revision=1 的 L1 ledger");
    }
    if (!isSha256(stored.hash)) {
        throw new SchedulerLedgerRepairRequiredError("unknown", "admission anchor 必须使用真实 sha256 ledger hash");
    }
    return { path: path.resolve(stored.path), revision: 1, hash: stored.hash };
}

export async function readRecordSchedulerLedgerStore(
    taskId: string,
    options: ReadSchedulerLedgerOptions = {},
): Promise<SchedulerLedgerStoreReadResult> {
    const ledgerPath = recordSchedulerLedgerPath(taskId);
    let raw: string;
    try {
        raw = await fs.promises.readFile(ledgerPath, "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            if (options.expectPublished) {
                return { kind: "repair_required", path: ledgerPath, reason: "missing_published_ledger" };
            }
            return { kind: "missing", path: ledgerPath, canCreate: true };
        }
        throw asStoreError(`读取 scheduler ledger ${taskId} 失败`, "READ_FAILED", error);
    }
    return parseStoredLedger(taskId, ledgerPath, raw, options.nowMs);
}

export function readRecordSchedulerLedgerStoreSync(
    taskId: string,
    options: ReadSchedulerLedgerOptions = {},
): SchedulerLedgerStoreReadResult {
    const ledgerPath = recordSchedulerLedgerPath(taskId);
    let raw: string;
    try {
        raw = fs.readFileSync(ledgerPath, "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            if (options.expectPublished) {
                return { kind: "repair_required", path: ledgerPath, reason: "missing_published_ledger" };
            }
            return { kind: "missing", path: ledgerPath, canCreate: true };
        }
        throw asStoreError(`读取 scheduler ledger ${taskId} 失败`, "READ_FAILED", error);
    }
    return parseStoredLedger(taskId, ledgerPath, raw, options.nowMs);
}

export async function createRecordSchedulerLedger(
    initialLedger: PersistedRecordSchedulerLedger,
    options: SchedulerLedgerMutationOptions = {},
): Promise<StoredSchedulerLedger> {
    const taskId = initialLedger.task?.taskId;
    if (typeof taskId !== "string") {
        throw new SchedulerLedgerStoreError("首次创建 scheduler ledger 必须带 task.taskId", "INVALID_TASK_ID");
    }
    const ledgerPath = recordSchedulerLedgerPath(taskId);
    return withSchedulerLedgerFileLock(taskId, async lock => {
        const existing = await readRawFile(ledgerPath);
        if (existing !== null) {
            throw new SchedulerLedgerStoreError(`scheduler ledger ${taskId} 已存在，首次创建必须使用互斥 create`, "LEDGER_ALREADY_EXISTS");
        }
        const prepared = prepareLedgerForPersistence(initialLedger, 1, taskId, false);
        const durability = await persistSchedulerLedger(lock, prepared, {
            taskId,
            operation: "create",
            before: "before-task-ledger-write",
            after: "after-task-ledger-write",
        });
        return storedLedger(ledgerPath, prepared, durability);
    }, options.lock);
}

export async function writeRecordSchedulerAdmissionCapsule(
    capsule: SchedulerAdmissionCapsule,
): Promise<StoredSchedulerAdmissionCapsule> {
    assertValidAdmissionCapsule(capsule);
    const capsulePath = recordSchedulerAdmissionCapsulePath(capsule.taskId);
    const content = stableJsonStringify(capsule);
    const expectedRef: ImmutableBlobReference = {
        path: capsulePath,
        hash: sha256(content),
        byteLength: Buffer.byteLength(content, "utf8"),
    };
    await runFault({
        point: "before-admission-capsule-publish",
        taskId: capsule.taskId,
        operation: "admission-capsule",
        path: capsulePath,
    });
    const durability = await publishImmutableJson(capsulePath, content, expectedRef.hash, capsule.taskId);
    const readBack = await readRecordSchedulerAdmissionCapsule(capsule.taskId);
    if (readBack.kind !== "current"
        || !sameBlobReference(readBack.ref, expectedRef)
        || stableJsonStringify(readBack.capsule) !== content) {
        throw new SchedulerLedgerRepairRequiredError(capsule.taskId, "admission capsule 发布后回读校验失败");
    }
    await runFault({
        point: "after-admission-capsule-publish",
        taskId: capsule.taskId,
        operation: "admission-capsule",
        path: capsulePath,
    });
    return { path: capsulePath, capsule: readBack.capsule, ref: expectedRef, durability };
}

export type SchedulerAdmissionCapsuleReadResult =
    | { kind: "missing"; path: string }
    | { kind: "current"; path: string; capsule: SchedulerAdmissionCapsule; ref: ImmutableBlobReference }
    | { kind: "repair_required"; path: string; reason: string };

export async function readRecordSchedulerAdmissionCapsule(taskId: string): Promise<SchedulerAdmissionCapsuleReadResult> {
    const capsulePath = recordSchedulerAdmissionCapsulePath(taskId);
    let raw: string;
    try {
        raw = await fs.promises.readFile(capsulePath, "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "missing", path: capsulePath };
        throw asStoreError(`读取 scheduler admission capsule ${taskId} 失败`, "ADMISSION_CAPSULE_READ_FAILED", error);
    }
    const ref: ImmutableBlobReference = {
        path: capsulePath,
        hash: sha256(raw),
        byteLength: Buffer.byteLength(raw, "utf8"),
    };
    let capsule: unknown;
    try {
        capsule = JSON.parse(raw);
    } catch {
        return { kind: "repair_required", path: capsulePath, reason: "invalid_capsule_json" };
    }
    if (!isValidAdmissionCapsule(capsule) || capsule.taskId !== taskId) {
        return { kind: "repair_required", path: capsulePath, reason: "invalid_capsule" };
    }
    if (stableJsonStringify(capsule) !== raw) {
        return { kind: "repair_required", path: capsulePath, reason: "noncanonical_capsule" };
    }
    return { kind: "current", path: capsulePath, capsule, ref };
}

export function readRecordSchedulerAdmissionCapsuleSync(taskId: string): SchedulerAdmissionCapsuleReadResult {
    const capsulePath = recordSchedulerAdmissionCapsulePath(taskId);
    let raw: string;
    try {
        raw = fs.readFileSync(capsulePath, "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "missing", path: capsulePath };
        throw asStoreError(`读取 scheduler admission capsule ${taskId} 失败`, "ADMISSION_CAPSULE_READ_FAILED", error);
    }
    const ref: ImmutableBlobReference = {
        path: capsulePath,
        hash: sha256(raw),
        byteLength: Buffer.byteLength(raw, "utf8"),
    };
    let capsule: unknown;
    try {
        capsule = JSON.parse(raw);
    } catch {
        return { kind: "repair_required", path: capsulePath, reason: "invalid_capsule_json" };
    }
    if (!isValidAdmissionCapsule(capsule) || capsule.taskId !== taskId) {
        return { kind: "repair_required", path: capsulePath, reason: "invalid_capsule" };
    }
    if (stableJsonStringify(capsule) !== raw) {
        return { kind: "repair_required", path: capsulePath, reason: "noncanonical_capsule" };
    }
    return { kind: "current", path: capsulePath, capsule, ref };
}

export async function bindRecordSchedulerAdmission(
    taskId: string,
    expectedRevision: number,
    ledgerAnchor: SchedulerLedgerAnchor,
    capsuleRef: ImmutableBlobReference,
    boundAt = new Date().toISOString(),
    options: SchedulerLedgerMutationOptions = {},
): Promise<StoredSchedulerLedger> {
    return mutateRecordSchedulerLedgerInternal(taskId, expectedRevision, async ledger => {
        if (ledger.task.admission.state !== "LedgerCreated") {
            throw new SchedulerLedgerRepairRequiredError(taskId, "L1→L2 接纳绑定只能从 LedgerCreated 执行一次");
        }
        const expectedAnchor = {
            path: path.resolve(recordSchedulerLedgerPath(taskId)),
            revision: 1 as const,
            hash: ledger.persistedHash,
        };
        if (!sameLedgerAnchor(ledgerAnchor, expectedAnchor)) {
            throw new SchedulerLedgerRepairRequiredError(taskId, "admission ledgerAnchor 与真实 L1 不一致");
        }
        await assertAdmissionCapsuleBinding(taskId, ledgerAnchor, capsuleRef, ledger);
        ledger.task.admission = {
            state: "EnvelopeBound",
            ledgerAnchor: structuredClone(ledgerAnchor),
            capsuleRef: structuredClone(capsuleRef),
            boundAt,
        };
    }, {
        lock: options.lock,
        operation: "mutation",
        authority: "admission-system",
        before: "before-task-ledger-write",
        after: "after-task-ledger-write",
    });
}

export async function verifyOrRecoverTaskAdmission(taskId: string): Promise<SchedulerTaskAdmissionVerification> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const stored = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
        if (stored.kind !== "current") {
            const reason = stored.kind === "repair_required"
                ? stored.reason
                : stored.kind === "rejected"
                    ? stored.parsed.reason
                    : stored.kind;
            return { kind: "repair_required", taskId, reason: `ledger_${reason}` };
        }
        const admission = stored.ledger.task.admission;
        if (admission.state === "LedgerCreated") {
            const capsule = await readRecordSchedulerAdmissionCapsule(taskId);
            if (capsule.kind === "missing") {
                return { kind: "unadmitted", taskId, ledger: stored.ledger, reason: "capsule_missing" };
            }
            if (capsule.kind !== "current") {
                return { kind: "repair_required", taskId, ledger: stored.ledger, reason: capsule.reason };
            }
            const anchor = createSchedulerLedgerAnchor({
                path: stored.path,
                revision: stored.ledger.revision,
                hash: stored.ledger.persistedHash,
            });
            try {
                await assertAdmissionCapsuleBinding(taskId, anchor, capsule.ref);
                await bindRecordSchedulerAdmission(taskId, stored.ledger.revision, anchor, capsule.ref);
            } catch (error) {
                if (error instanceof SchedulerLedgerConflictError) continue;
                return { kind: "repair_required", taskId, ledger: stored.ledger, reason: errorMessage(error) };
            }
            continue;
        }
        let capsule: SchedulerAdmissionCapsule;
        try {
            capsule = await assertAdmissionCapsuleBinding(taskId, admission.ledgerAnchor, admission.capsuleRef, stored.ledger);
        } catch (error) {
            return { kind: "repair_required", taskId, ledger: stored.ledger, reason: errorMessage(error) };
        }
        return {
            kind: "verified",
            taskId,
            ledger: stored.ledger,
            capsule,
            receipt: createAdmissionReceipt(stored.path, stored.ledger, admission),
        };
    }
    return { kind: "repair_required", taskId, reason: "admission_bind_conflict" };
}

export async function verifyRecordSchedulerAdmissionReceipt(
    receipt: RecordSchedulerAdmissionReceipt,
    expectedTaskKind?: RecordSchedulerAdmissionReceipt["taskKind"],
): Promise<RecordSchedulerAdmissionReceipt> {
    if (!isValidAdmissionReceipt(receipt)) {
        throw new SchedulerLedgerRepairRequiredError("unknown", "Record scheduler admission receipt 格式或 sha256 非法");
    }
    if (expectedTaskKind && receipt.taskKind !== expectedTaskKind) {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt taskKind 与请求不一致");
    }
    const verified = await verifyOrRecoverTaskAdmission(receipt.taskId);
    if (verified.kind !== "verified") {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, `admission receipt 未能验证：${verified.reason}`);
    }
    if (!sameAdmissionReceipt(receipt, verified.receipt)) {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt 与真实 ledger/capsule binding 不一致或已陈旧");
    }
    return verified.receipt;
}

export function verifyRecordSchedulerAdmissionReceiptSync(
    receipt: RecordSchedulerAdmissionReceipt,
    expectedTaskKind?: RecordSchedulerAdmissionReceipt["taskKind"],
): RecordSchedulerAdmissionReceipt {
    if (!isValidAdmissionReceipt(receipt)) {
        throw new SchedulerLedgerRepairRequiredError("unknown", "Record scheduler admission receipt 格式或 sha256 非法");
    }
    if (expectedTaskKind && receipt.taskKind !== expectedTaskKind) {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt taskKind 与请求不一致");
    }
    const stored = readRecordSchedulerLedgerStoreSync(receipt.taskId, { expectPublished: true });
    if (stored.kind !== "current" || stored.ledger.task.admission.state !== "EnvelopeBound") {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt 对应的 L2 ledger 不可验证");
    }
    assertAdmissionCapsuleBindingSync(
        receipt.taskId,
        stored.ledger.task.admission.ledgerAnchor,
        stored.ledger.task.admission.capsuleRef,
        stored.ledger,
    );
    const verified = createAdmissionReceipt(stored.path, stored.ledger, stored.ledger.task.admission);
    if (!sameAdmissionReceipt(receipt, verified)) {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt 与真实 ledger/capsule binding 不一致或已陈旧");
    }
    return verified;
}

export function refreshRecordSchedulerAdmissionReceiptSync(
    receipt: RecordSchedulerAdmissionReceipt,
    expectedTaskKind?: RecordSchedulerAdmissionReceipt["taskKind"],
): RecordSchedulerAdmissionReceipt {
    if (!isValidAdmissionReceipt(receipt)) {
        throw new SchedulerLedgerRepairRequiredError("unknown", "Record scheduler admission receipt 格式或 sha256 非法");
    }
    if (expectedTaskKind && receipt.taskKind !== expectedTaskKind) {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt taskKind 与请求不一致");
    }
    const stored = readRecordSchedulerLedgerStoreSync(receipt.taskId, { expectPublished: true });
    if (stored.kind !== "current" || stored.ledger.task.admission.state !== "EnvelopeBound") {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt 对应的 L2 ledger 不可验证");
    }
    assertAdmissionCapsuleBindingSync(
        receipt.taskId,
        stored.ledger.task.admission.ledgerAnchor,
        stored.ledger.task.admission.capsuleRef,
        stored.ledger,
    );
    const verified = createAdmissionReceipt(stored.path, stored.ledger, stored.ledger.task.admission);
    if (!sameImmutableAdmissionReceiptBinding(receipt, verified)) {
        throw new SchedulerLedgerRepairRequiredError(receipt.taskId, "admission receipt 的 immutable ledger/capsule binding 与真实 L2 不一致");
    }
    return verified;
}

export async function markRecordSchedulerAdmissionRepairRequired(
    taskId: string,
    reason: string,
    options: SchedulerLedgerMutationOptions = {},
): Promise<PersistedRecordSchedulerLedger> {
    const current = await requireCurrentLedger(taskId);
    if (current.ledger.task.state === "RepairRequired") return current.ledger;
    if (isTerminalTaskState(current.ledger.task.state)) {
        throw new SchedulerLedgerRepairRequiredError(taskId, `终态 ${current.ledger.task.state} 的 admission 损坏，拒绝覆盖权威终态：${reason}`);
    }
    const stored = await mutateRecordSchedulerLedgerInternal(taskId, current.ledger.revision, ledger => {
        ledger.task.state = "RepairRequired";
        ledger.task.terminalState = "RepairRequired";
        ledger.task.repairState = "Required";
        ledger.task.updatedAt = new Date().toISOString();
    }, {
        lock: options.lock,
        operation: "mutation",
        authority: "repair-system",
        before: "before-task-ledger-write",
        after: "after-task-ledger-write",
    });
    return stored.ledger;
}

export async function mutateRecordSchedulerLedger(
    taskId: string,
    expectedRevision: number,
    mutate: (ledger: PersistedRecordSchedulerLedger) => PersistedRecordSchedulerLedger | void | Promise<PersistedRecordSchedulerLedger | void>,
    options: SchedulerLedgerMutationOptions = {},
): Promise<StoredSchedulerLedger> {
    return mutateRecordSchedulerLedgerInternal(taskId, expectedRevision, mutate, {
        lock: options.lock,
        operation: "mutation",
        authority: "unowned",
        before: "before-task-ledger-write",
        after: "after-task-ledger-write",
    });
}

export async function claimSchedulerOwnerLease(
    taskId: string,
    expectedRevision: number,
    ownerId: string,
    options: SchedulerOwnerLeaseOptions = {},
): Promise<StoredSchedulerLedger & { ownerLease: SchedulerOwnerLease }> {
    if (!isNonEmptyString(ownerId)) throw new SchedulerLedgerStoreError("scheduler ownerId 不能为空", "INVALID_OWNER_ID");
    const nowMs = options.nowMs ?? Date.now();
    const leaseMs = normalizeLeaseMs(options.leaseMs);
    const activeOwnerTakeoverApproval = await resolveActiveSchedulerOwnerTakeoverApproval(taskId, expectedRevision, nowMs);
    let ownerLease: SchedulerOwnerLease | undefined;
    const stored = await mutateRecordSchedulerLedgerInternal(taskId, expectedRevision, ledger => {
        const current = ledger.schedulerOwner;
        if (current
            && Date.parse(current.expiresAt) > nowMs
            && !isApprovedActiveSchedulerOwnerTakeover(current, activeOwnerTakeoverApproval)) {
            throw new SchedulerOwnerLeaseError(taskId, `scheduler owner ${current.ownerId} 的 lease 仍有效，禁止并发接管`, "OWNER_LEASE_HELD");
        }
        const schedulerEpoch = Math.max(
            ledger.task.schedulerEpoch,
            current?.schedulerEpoch ?? 0,
            ...ledger.recordWork.map(work => work.schedulerEpoch),
        ) + 1;
        beginSchedulerOwnerRecovery(taskId, ledger, schedulerEpoch, nowMs);
        const acquiredAt = new Date(nowMs).toISOString();
        ownerLease = {
            ownerId,
            leaseId: crypto.randomUUID(),
            schedulerEpoch,
            fencingToken: (current?.fencingToken ?? 0) + 1,
            acquiredAt,
            heartbeatAt: acquiredAt,
            expiresAt: new Date(nowMs + leaseMs).toISOString(),
            ownerPid: process.pid,
            ownerStartedAtMs: CURRENT_SCHEDULER_OWNER_STARTED_AT_MS,
        };
        ledger.schedulerOwner = ownerLease;
    }, {
        lock: options.lock,
        operation: "owner-claim",
        authority: "owner-system",
        before: "before-record-work-lease-write",
        after: "after-record-work-lease-write",
    });
    return { ...stored, ownerLease: ownerLease! };
}

export async function heartbeatSchedulerOwnerLease(
    taskId: string,
    expectedRevision: number,
    lease: SchedulerOwnerLease,
    options: SchedulerOwnerLeaseOptions = {},
): Promise<StoredSchedulerLedger & { ownerLease: SchedulerOwnerLease }> {
    const nowMs = options.nowMs ?? Date.now();
    const leaseMs = normalizeLeaseMs(options.leaseMs);
    let renewed: SchedulerOwnerLease | undefined;
    const stored = await mutateRecordSchedulerLedgerInternal(taskId, expectedRevision, ledger => {
        assertCurrentSchedulerOwnerLease(taskId, ledger, lease, nowMs);
        renewed = {
            ...ledger.schedulerOwner!,
            heartbeatAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + leaseMs).toISOString(),
        };
        ledger.schedulerOwner = renewed;
    }, {
        lock: options.lock,
        operation: "owner-heartbeat",
        authority: "owner-system",
        before: "before-record-work-lease-write",
        after: "after-record-work-lease-write",
    });
    return { ...stored, ownerLease: renewed! };
}

export async function completeSchedulerOwnerRecovery(
    taskId: string,
    expectedRevision: number,
    lease: SchedulerOwnerLease,
    options: CompleteSchedulerOwnerRecoveryOptions,
): Promise<StoredSchedulerLedger> {
    const nowMs = options.nowMs ?? Date.now();
    return mutateRecordSchedulerLedgerInternal(taskId, expectedRevision, ledger => {
        assertCurrentSchedulerOwnerLease(taskId, ledger, lease, nowMs);
        const recovery = ledger.schedulerOwnerRecovery;
        if (!recovery) {
            throw new SchedulerLedgerRepairRequiredError(taskId, "scheduler owner recovery barrier 不存在，禁止提前放行 dispatch");
        }
        const expected = [...new Set(recovery.pendingRecordWorkKeys)].sort();
        const recovered = [...new Set(options.recoveredRecordWorkKeys)].sort();
        if (expected.length !== recovered.length || expected.some((key, index) => key !== recovered[index])) {
            throw new SchedulerLedgerRepairRequiredError(taskId, "scheduler owner recovery 未覆盖全部 record work，禁止提前放行 dispatch");
        }
        ledger.schedulerOwnerRecovery = undefined;
        ledger.task.repairState = "None";
        ledger.task.state = recovery.previousTaskState;
        ledger.task.updatedAt = new Date(nowMs).toISOString();
    }, {
        lock: options.lock,
        operation: "mutation",
        authority: "owner-system",
        before: "before-record-work-lease-write",
        after: "after-record-work-lease-write",
    });
}

export async function mutateRecordSchedulerLedgerAsOwner(
    taskId: string,
    expectedRevision: number,
    lease: SchedulerOwnerLease,
    mutate: (ledger: PersistedRecordSchedulerLedger) => PersistedRecordSchedulerLedger | void | Promise<PersistedRecordSchedulerLedger | void>,
    options: SchedulerLedgerMutationOptions & { nowMs?: number } = {},
): Promise<StoredSchedulerLedger> {
    const nowMs = options.nowMs ?? Date.now();
    return mutateRecordSchedulerLedgerInternal(taskId, expectedRevision, async ledger => {
        assertCurrentSchedulerOwnerLease(taskId, ledger, lease, nowMs);
        return mutate(ledger);
    }, {
        lock: options.lock,
        operation: "mutation",
        authority: "owner",
        before: "before-task-ledger-write",
        after: "after-task-ledger-write",
    });
}

export function assertCurrentSchedulerOwnerLease(
    taskId: string,
    ledger: PersistedRecordSchedulerLedger,
    lease: SchedulerOwnerLease,
    nowMs = Date.now(),
): void {
    const current = ledger.schedulerOwner;
    if (!current
        || current.ownerId !== lease.ownerId
        || current.leaseId !== lease.leaseId
        || current.schedulerEpoch !== lease.schedulerEpoch
        || current.fencingToken !== lease.fencingToken) {
        throw new SchedulerOwnerLeaseError(taskId, "旧 scheduler owner 已被 fencing，禁止继续派发或提交", "OWNER_FENCED");
    }
    if (Date.parse(current.expiresAt) <= nowMs) {
        throw new SchedulerOwnerLeaseError(taskId, "scheduler owner lease 已过期，必须重新 claim，禁止续命或继续派发", "OWNER_FENCED");
    }
}

async function resolveActiveSchedulerOwnerTakeoverApproval(
    taskId: string,
    expectedRevision: number,
    nowMs: number,
): Promise<SchedulerOwnerTakeoverApproval | undefined> {
    const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
    if (current.kind !== "current" || current.ledger.revision !== expectedRevision) return undefined;
    const owner = current.ledger.schedulerOwner;
    if (!owner || Date.parse(owner.expiresAt) <= nowMs || !hasSchedulerOwnerProcessIdentity(owner)) return undefined;
    const processState = await probeSchedulerOwnerProcess(owner.ownerPid);
    if (processState.kind === "dead") {
        return { leaseId: owner.leaseId, ownerPid: owner.ownerPid, ownerStartedAtMs: owner.ownerStartedAtMs };
    }
    if (processState.kind === "alive" && !sameSchedulerOwnerProcessStartTime(processState.startedAtMs, owner.ownerStartedAtMs)) {
        return { leaseId: owner.leaseId, ownerPid: owner.ownerPid, ownerStartedAtMs: owner.ownerStartedAtMs };
    }
    return undefined;
}

function isApprovedActiveSchedulerOwnerTakeover(
    owner: SchedulerOwnerLease,
    approval: SchedulerOwnerTakeoverApproval | undefined,
): boolean {
    return approval !== undefined
        && owner.leaseId === approval.leaseId
        && owner.ownerPid === approval.ownerPid
        && owner.ownerStartedAtMs === approval.ownerStartedAtMs;
}

function hasSchedulerOwnerProcessIdentity(
    lease: SchedulerOwnerLease,
): lease is SchedulerOwnerLease & Required<Pick<SchedulerOwnerLease, "ownerPid" | "ownerStartedAtMs">> {
    return isPositiveInteger(lease.ownerPid) && isPositiveInteger(lease.ownerStartedAtMs);
}

function sameSchedulerOwnerProcessStartTime(observedStartedAtMs: number, persistedStartedAtMs: number): boolean {
    return Math.abs(observedStartedAtMs - persistedStartedAtMs) <= SCHEDULER_OWNER_START_TIME_MATCH_TOLERANCE_MS;
}

async function probeSchedulerOwnerProcess(pid: number): Promise<SchedulerOwnerProcessProbeResult> {
    if (schedulerOwnerProcessProbeForTest) {
        return normalizeSchedulerOwnerProcessProbeResult(await schedulerOwnerProcessProbeForTest(pid));
    }
    if (!isPositiveInteger(pid)) return { kind: "unknown" };
    if (pid === process.pid) return { kind: "alive", startedAtMs: CURRENT_SCHEDULER_OWNER_STARTED_AT_MS };
    const initialExistence = getSchedulerOwnerProcessExistence(pid);
    if (initialExistence !== "alive") {
        return initialExistence === "dead" ? { kind: "dead" } : { kind: "unknown" };
    }
    const startedAtMs = await readSchedulerOwnerProcessStartedAtMs(pid);
    if (startedAtMs !== undefined) return { kind: "alive", startedAtMs };
    return getSchedulerOwnerProcessExistence(pid) === "dead" ? { kind: "dead" } : { kind: "unknown" };
}

function normalizeSchedulerOwnerProcessProbeResult(value: SchedulerOwnerProcessProbeResult): SchedulerOwnerProcessProbeResult {
    if (value.kind === "alive" && isPositiveInteger(value.startedAtMs)) return value;
    if (value.kind === "dead" || value.kind === "unknown") return value;
    return { kind: "unknown" };
}

function getSchedulerOwnerProcessExistence(pid: number): "alive" | "dead" | "unknown" {
    try {
        process.kill(pid, 0);
        return "alive";
    } catch (error) {
        return isErrno(error, "ESRCH") ? "dead" : "unknown";
    }
}

async function readSchedulerOwnerProcessStartedAtMs(pid: number): Promise<number | undefined> {
    const command = process.platform === "win32" ? "powershell.exe" : "ps";
    const args = process.platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$ErrorActionPreference='Stop'; try { $owner = Get-Process -Id ${pid}; [Console]::Out.Write([Math]::Floor(($owner.StartTime.ToUniversalTime() - [DateTime]'1970-01-01').TotalMilliseconds)); exit 0 } catch { if ($_.Exception -is [System.ArgumentException]) { exit 3 }; exit 4 }`,
        ]
        : ["-o", "lstart=", "-p", String(pid)];
    return runSchedulerOwnerProcessStartedAtMsCommand(command, args);
}

function runSchedulerOwnerProcessStartedAtMsCommand(command: string, args: string[]): Promise<number | undefined> {
    return new Promise(resolve => {
        let settled = false;
        let output = "";
        let child: ReturnType<typeof spawn> | undefined;
        const finish = (value: number | undefined): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (value === undefined) child?.kill();
            resolve(value);
        };
        const timeout = setTimeout(() => { finish(undefined); }, SCHEDULER_OWNER_PROCESS_QUERY_TIMEOUT_MS);
        try {
            child = spawn(command, args, {
                env: process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C" },
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
            });
        } catch {
            finish(undefined);
            return;
        }
        child.stdout?.on("data", chunk => {
            if (output.length <= 512) output += String(chunk);
        });
        child.once("error", () => { finish(undefined); });
        child.once("close", code => {
            if (code !== 0 || output.length > 512) {
                finish(undefined);
                return;
            }
            const text = output.trim();
            const startedAtMs = process.platform === "win32" ? Number(text) : Date.parse(text);
            finish(isPositiveInteger(startedAtMs) ? startedAtMs : undefined);
        });
    });
}

function beginSchedulerOwnerRecovery(
    taskId: string,
    ledger: PersistedRecordSchedulerLedger,
    schedulerEpoch: number,
    nowMs: number,
): void {
    if (isTerminalTaskState(ledger.task.state)) {
        throw new SchedulerLedgerRepairRequiredError(taskId, `终态 Task ${ledger.task.state} 不允许重新 claim scheduler owner`);
    }
    const previousTaskState = ledger.task.state;
    ledger.task.schedulerEpoch = schedulerEpoch;
    ledger.task.state = "Preparing";
    ledger.task.repairState = "Blocked";
    ledger.schedulerOwnerRecovery = {
        required: true,
        reason: "registry-lease-reacquire",
        previousTaskState,
        claimedAt: new Date(nowMs).toISOString(),
        pendingRecordWorkKeys: ledger.recordWork.map(work => work.recordWorkKey),
    };
}

export async function createAttemptDispatchDurabilityReceipt(
    taskId: string,
    attemptId: string,
    options: CreateAttemptDispatchReceiptOptions = {},
): Promise<RecordSchedulerAttemptDispatchDurabilityReceipt> {
    return withSchedulerLedgerFileLock(taskId, async () => {
        const current = await requireCurrentLedger(taskId);
        if (options.expectedRevision !== undefined && current.ledger.revision !== options.expectedRevision) {
            throw new SchedulerLedgerConflictError(taskId, options.expectedRevision, current.ledger.revision);
        }
        if (current.ledger.schedulerOwner && !options.ownerLease) {
            throw new SchedulerOwnerLeaseError(
                taskId,
                "scheduler owner 已建立，签发 dispatch durability receipt 必须提供当前 owner lease",
                "OWNER_LEASE_REQUIRED",
            );
        }
        if (options.ownerLease) {
            assertCurrentSchedulerOwnerLease(taskId, current.ledger, options.ownerLease, options.nowMs ?? Date.now());
        }
        const attempt = current.ledger.attempts.find(candidate => candidate.attemptId === attemptId);
        const unit = attempt ? current.ledger.units.find(candidate => candidate.unitId === attempt.unitId) : undefined;
        const source = unit ? current.ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === unit.sourceSnapshotId) : undefined;
        const work = unit ? current.ledger.recordWork.find(candidate => candidate.recordWorkKey === unit.recordWorkKey) : undefined;
        if (!attempt || !unit || !source || !work || !attempt.dispatchIntentRef || !attempt.dispatchIntentLedgerRevision) {
            throw new SchedulerLedgerRepairRequiredError(taskId, `Attempt ${attemptId} 的 durability receipt 依赖不完整`);
        }
        if (!isEnvelopeBoundAdmission(current.ledger.task.admission)) {
            throw new SchedulerLedgerRepairRequiredError(taskId, `Attempt ${attemptId} 不能在 L1 未接纳状态签发 dispatch receipt`);
        }
        await assertAdmissionCapsuleBinding(
            taskId,
            current.ledger.task.admission.ledgerAnchor,
            current.ledger.task.admission.capsuleRef,
            current.ledger,
        );
        const storeDurability = await establishPersistedFileDurability(current.path);
        const receipt: RecordSchedulerAttemptDispatchDurabilityReceipt = {
            verifier: "record-scheduler-store",
            verifiedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
            ledgerRevision: current.ledger.revision,
            ledgerHash: current.ledger.persistedHash,
            admissionLedgerAnchor: structuredClone(current.ledger.task.admission.ledgerAnchor),
            admissionCapsuleRef: structuredClone(current.ledger.task.admission.capsuleRef),
            candidateSnapshotId: current.ledger.candidateSnapshot.snapshotId,
            candidateSnapshotRevision: current.ledger.candidateSnapshot.snapshotRevision,
            candidateSnapshotRef: structuredClone(current.ledger.candidateSnapshot.snapshotRef),
            sourceSnapshotId: source.sourceSnapshotId,
            sourceSnapshotRevision: source.snapshotRevision,
            sourceSnapshotRef: structuredClone(source.snapshotRef),
            recordWorkKey: work.recordWorkKey,
            registryRevision: work.registryRevision,
            registryRef: structuredClone(work.registryRef),
            workLeaseId: work.workLeaseId,
            attemptId: attempt.attemptId,
            attemptIntentLedgerRevision: attempt.dispatchIntentLedgerRevision,
            attemptIntentRef: structuredClone(attempt.dispatchIntentRef),
            inputHash: attempt.inputHash,
            fence: structuredClone(attempt.fence),
            storeDurability,
        };
        if (!isAttemptDispatchAllowed({
            ledger: current.ledger,
            attemptId,
            durabilityReceipt: receipt,
            nowMs: options.nowMs,
        })) {
            throw new SchedulerLedgerRepairRequiredError(taskId, `Attempt ${attemptId} 未满足 dispatch durability barrier`);
        }
        return receipt;
    }, options.lock);
}

export async function withSchedulerLedgerFileLock<Value>(
    taskId: string,
    callback: (lock: SchedulerLedgerFileLock) => Promise<Value> | Value,
    options: SchedulerLedgerLockOptions = {},
): Promise<Value> {
    return withSchedulerFileLock(taskId, recordSchedulerLedgerLockPath(taskId), callback, options);
}

export async function withRecordSchedulerAdmissionNamespaceLock<Value>(
    callback: (lock: SchedulerLedgerFileLock) => Promise<Value> | Value,
    options: SchedulerLedgerLockOptions = {},
): Promise<Value> {
    return withSchedulerFileLock(
        RECORD_SCHEDULER_ADMISSION_NAMESPACE_LOCK_ID,
        recordSchedulerAdmissionNamespaceLockPath(),
        callback,
        options,
    );
}

async function withSchedulerFileLock<Value>(
    lockId: string,
    lockPath: string,
    callback: (lock: SchedulerLedgerFileLock) => Promise<Value> | Value,
    options: SchedulerLedgerLockOptions,
): Promise<Value> {
    const lock = await acquireSchedulerLedgerFileLock(lockId, options, lockPath);
    const staleMs = normalizePositiveMs(options.staleMs, DEFAULT_LOCK_STALE_MS, "lock stale");
    const heartbeatIntervalMs = Math.max(25, Math.min(1_000, Math.floor(staleMs / 3)));
    let heartbeatFailure: unknown;
    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || heartbeatFailure) return;
        heartbeatInFlight = true;
        void lock.heartbeat()
            .catch(error => { heartbeatFailure = error; })
            .finally(() => { heartbeatInFlight = false; });
    }, heartbeatIntervalMs);
    try {
        const result = await callback(lock);
        if (heartbeatFailure) {
            throw asStoreError(`scheduler ledger ${lockId} lock heartbeat 中断`, "LOCK_HEARTBEAT_FAILED", heartbeatFailure);
        }
        return result;
    } finally {
        clearInterval(heartbeatTimer);
        await lock.release();
    }
}

export interface SchedulerLedgerFileLock {
    readonly taskId: string;
    readonly path: string;
    heartbeat(): Promise<void>;
    assertHeld(): Promise<void>;
    release(): Promise<void>;
}

async function mutateRecordSchedulerLedgerInternal(
    taskId: string,
    expectedRevision: number,
    mutate: (ledger: PersistedRecordSchedulerLedger) => PersistedRecordSchedulerLedger | void | Promise<PersistedRecordSchedulerLedger | void>,
    options: SchedulerLedgerMutationOptions & {
        operation: SchedulerLedgerFaultContext["operation"];
        authority: "unowned" | "owner" | "owner-system" | "admission-system" | "repair-system";
        before: RecordSchedulerFaultPoint;
        after: RecordSchedulerFaultPoint;
    },
): Promise<StoredSchedulerLedger> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw new SchedulerLedgerStoreError("scheduler ledger mutation 必须带正整数 expectedRevision", "INVALID_EXPECTED_REVISION");
    }
    return withSchedulerLedgerFileLock(taskId, async lock => {
        const current = await requireCurrentLedger(taskId);
        if (current.ledger.revision !== expectedRevision) {
            throw new SchedulerLedgerConflictError(taskId, expectedRevision, current.ledger.revision);
        }
        if (options.authority === "unowned" && current.ledger.schedulerOwner !== undefined) {
            throw new SchedulerOwnerLeaseError(
                taskId,
                "scheduler owner 已建立，通用 mutation 必须改用带当前 lease/epoch/fence 的 owner API",
                "OWNER_LEASE_REQUIRED",
            );
        }
        const previousOwner = current.ledger.schedulerOwner ? structuredClone(current.ledger.schedulerOwner) : undefined;
        const draft = structuredClone(current.ledger) as PersistedRecordSchedulerLedger;
        const result = await mutate(draft);
        const candidate = (result ?? draft) as PersistedRecordSchedulerLedger;
        if (candidate.task.taskId !== taskId) {
            throw new SchedulerLedgerStoreError("scheduler ledger mutation 不得改变 taskId", "TASK_ID_MUTATION_FORBIDDEN");
        }
        if (options.authority !== "owner-system" && !sameSchedulerOwnerLease(previousOwner, candidate.schedulerOwner)) {
            throw new SchedulerLedgerStoreError("scheduler owner lease 只能通过 claim/heartbeat API 修改", "OWNER_LEASE_MUTATION_FORBIDDEN");
        }
        const prepared = prepareLedgerForPersistence(candidate, expectedRevision + 1, taskId, true);
        const durability = await persistSchedulerLedger(lock, prepared, {
            taskId,
            operation: options.operation,
            before: options.before,
            after: options.after,
        });
        return storedLedger(recordSchedulerLedgerPath(taskId), prepared, durability);
    }, options.lock);
}

async function requireCurrentLedger(taskId: string): Promise<Extract<SchedulerLedgerStoreReadResult, { kind: "current" }>> {
    const result = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
    if (result.kind === "current") return result;
    if (result.kind === "repair_required" && result.reason === "missing_published_ledger") {
        throw new SchedulerLedgerMissingError(taskId);
    }
    if (result.kind === "legacy") {
        throw new SchedulerLedgerRepairRequiredError(taskId, "legacy ledger 仅可只读迁移，禁止直接 mutation/dispatch");
    }
    if (result.kind === "rejected") {
        throw new SchedulerLedgerRepairRequiredError(taskId, `ledger 被拒绝：${result.parsed.reason}`);
    }
    throw new SchedulerLedgerRepairRequiredError(taskId, result.kind === "repair_required" ? result.reason : "unexpected_missing");
}

function parseStoredLedger(taskId: string, ledgerPath: string, raw: string, nowMs?: number): SchedulerLedgerStoreReadResult {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return { kind: "repair_required", path: ledgerPath, reason: "invalid_json" };
    }
    const parsed = parseRecordSchedulerLedger(value, { nowMs });
    if (parsed.kind === "current") {
        const ledger = parsed.ledger as PersistedRecordSchedulerLedger;
        if (ledger.task.taskId !== taskId) {
            return { kind: "repair_required", path: ledgerPath, reason: "invalid_current_ledger" };
        }
        if (ledger.persistedHash !== calculateRecordSchedulerLedgerHash(ledger)) {
            return { kind: "repair_required", path: ledgerPath, reason: "ledger_hash_mismatch" };
        }
        if (ledger.schedulerOwner !== undefined && !isValidSchedulerOwnerLease(ledger.schedulerOwner)) {
            return { kind: "repair_required", path: ledgerPath, reason: "invalid_scheduler_owner_lease" };
        }
        if (ledger.schedulerOwnerRecovery !== undefined && !isValidSchedulerOwnerRecoveryState(ledger.schedulerOwnerRecovery)) {
            return { kind: "repair_required", path: ledgerPath, reason: "invalid_scheduler_owner_recovery" };
        }
        return { kind: "current", path: ledgerPath, ledger, parsed };
    }
    if (parsed.kind === "legacy") return { kind: "legacy", path: ledgerPath, parsed };
    if (parsed.kind === "repair_required") return { kind: "repair_required", path: ledgerPath, reason: parsed.reason };
    return { kind: "rejected", path: ledgerPath, parsed };
}

function prepareLedgerForPersistence(
    candidate: PersistedRecordSchedulerLedger,
    revision: number,
    taskId: string,
    updateTimestamp: boolean,
): PersistedRecordSchedulerLedger {
    const prepared = structuredClone(candidate) as PersistedRecordSchedulerLedger;
    if (prepared.task?.taskId !== taskId) {
        throw new SchedulerLedgerStoreError("ledger taskId 与文件 taskId 不一致", "TASK_ID_MISMATCH");
    }
    prepared.revision = revision;
    if (updateTimestamp) prepared.task.updatedAt = new Date().toISOString();
    prepared.persistedHash = "";
    prepared.persistedHash = calculateRecordSchedulerLedgerHash(prepared);
    const parsed = parseRecordSchedulerLedger(prepared);
    if (parsed.kind !== "current") {
        const reason = parsed.kind === "repair_required" || parsed.kind === "rejected" ? parsed.reason : parsed.kind;
        const stateSummary = JSON.stringify({
            task: {
                state: prepared.task.state,
                schedulerEpoch: prepared.task.schedulerEpoch,
                taskId: prepared.task.taskId,
                units: prepared.task.units,
                recordItems: prepared.task.recordItems,
                sourceResolution: prepared.task.sourceResolution,
            },
            candidateSnapshot: {
                id: prepared.candidateSnapshot.snapshotId,
                revision: prepared.candidateSnapshot.snapshotRevision,
                enumerations: prepared.candidateSnapshot.enumerations.map(entry => ({
                    chain: entry.chain,
                    complete: entry.complete,
                    paginationExhausted: entry.paginationExhausted,
                    truncated: entry.truncated,
                    error: entry.error,
                })),
                candidates: prepared.candidateSnapshot.candidates.map(candidate => ({
                    conversationId: candidate.conversationId,
                    chain: candidate.chain,
                    workspaceHash: candidate.workspaceHash,
                    state: candidate.state,
                    evidenceCount: candidate.evidence.length,
                })),
            },
            sources: prepared.sourceSnapshots.map(source => ({
                id: source.sourceSnapshotId,
                conversationId: source.conversationId,
                chain: source.chain,
                workspaceHash: source.workspaceHash,
                desiredRevision: source.desiredRevision,
                complete: source.complete,
                readRange: source.readRange,
                gaps: source.gaps,
            })),
            work: prepared.recordWork.map(work => ({
                key: work.recordWorkKey,
                schedulerEpoch: work.schedulerEpoch,
                leaseOwnerId: work.leaseOwnerId,
                workLeaseId: work.workLeaseId,
                fencingToken: work.currentFencingToken,
                activeTaskIds: work.activeTaskIds,
            })),
            units: prepared.units.map(unit => ({
                id: unit.unitId,
                state: unit.state,
                layer: unit.layer,
                work: unit.recordWorkKey,
                sourceSnapshotId: unit.sourceSnapshotId,
                inputHash: unit.inputHash,
                routePlan: unit.routePlan,
                routeCursor: unit.routeCursor,
                attemptedProviders: unit.attemptedProviders,
                unitAttempts: unit.unitAttempts,
                providerAttemptCounts: unit.providerAttemptCounts,
                promptRecipe: unit.promptRecipe,
            })),
            attempts: prepared.attempts.map(attempt => ({
                id: attempt.attemptId,
                unitId: attempt.unitId,
                state: attempt.state,
                work: attempt.recordWorkKey,
                inputHash: attempt.inputHash,
                fence: attempt.fence,
            })),
            commits: prepared.commits.map(commit => ({ id: commit.commitId, state: commit.state, unitId: commit.unitId, attemptId: commit.attemptId, work: commit.recordWorkKey, fence: commit.fence })),
        });
        throw new SchedulerLedgerRepairRequiredError(taskId, `待写 ledger 未通过 contracts parser：${reason}；state=${stateSummary}`);
    }
    if (prepared.schedulerOwner !== undefined && !isValidSchedulerOwnerLease(prepared.schedulerOwner)) {
        throw new SchedulerLedgerRepairRequiredError(taskId, "待写 ledger 的 scheduler owner lease 非法");
    }
    if (prepared.schedulerOwnerRecovery !== undefined && !isValidSchedulerOwnerRecoveryState(prepared.schedulerOwnerRecovery)) {
        throw new SchedulerLedgerRepairRequiredError(taskId, "待写 ledger 的 scheduler owner recovery 状态非法");
    }
    return prepared;
}

async function persistSchedulerLedger(
    lock: SchedulerLedgerFileLock,
    ledger: PersistedRecordSchedulerLedger,
    fault: Omit<SchedulerLedgerFaultContext, "point" | "path" | "revision"> & { before: RecordSchedulerFaultPoint; after: RecordSchedulerFaultPoint },
): Promise<SchedulerLedgerDurabilityReceipt> {
    const ledgerPath = recordSchedulerLedgerPath(fault.taskId);
    await runFault({ ...fault, point: fault.before, revision: ledger.revision, path: ledgerPath });
    await lock.heartbeat();
    await lock.assertHeld();
    const durability = await writeDurableJsonAtomic(ledgerPath, ledger);
    const readBack = await readRecordSchedulerLedgerStore(fault.taskId, { expectPublished: true });
    if (readBack.kind !== "current"
        || readBack.ledger.revision !== ledger.revision
        || readBack.ledger.persistedHash !== ledger.persistedHash) {
        throw new SchedulerLedgerRepairRequiredError(fault.taskId, "ledger 原子写入后回读校验失败");
    }
    await runFault({ ...fault, point: fault.after, revision: ledger.revision, path: ledgerPath });
    return durability;
}

async function runFault(context: SchedulerLedgerFaultContext): Promise<void> {
    await faultInjector?.(context);
}

async function acquireSchedulerLedgerFileLock(
    taskId: string,
    options: SchedulerLedgerLockOptions,
    lockPath = recordSchedulerLedgerLockPath(taskId),
): Promise<SchedulerLedgerFileLock> {
    const timeoutMs = normalizePositiveMs(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lock timeout");
    const staleMs = normalizePositiveMs(options.staleMs, DEFAULT_LOCK_STALE_MS, "lock stale");
    const deadline = Date.now() + timeoutMs;
    const token = crypto.randomUUID();
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    let acquisitionAttempt = 0;
    for (;;) {
        if (acquisitionAttempt > 0 && Date.now() >= deadline) throw new SchedulerLedgerLockTimeoutError(taskId, timeoutMs);
        acquisitionAttempt += 1;
        try {
            await lockTestHook?.({
                phase: "before-acquire",
                taskId,
                lockPath,
                token,
                ownerPid: process.pid,
            });
            const handle = await fs.promises.open(lockPath, "wx");
            const payload = JSON.stringify({ taskId, token, ownerPid: process.pid, acquiredAt: new Date().toISOString() });
            try {
                await writeSchedulerLedgerLockPayload(handle, payload, { taskId, lockPath, token, deadline });
            } catch (error) {
                await handle.close().catch(() => undefined);
                await removeFailedSchedulerLedgerLock(lockPath, deadline);
                throw asStoreError(`写入 scheduler ledger lock ${taskId} 失败`, "LOCK_WRITE_FAILED", error);
            }
            return createFileLock(taskId, lockPath, token, handle);
        } catch (error) {
            const existingLock = isErrno(error, "EEXIST");
            if (!existingLock && !isTransientWindowsSchedulerLockRace(error)) {
                if (error instanceof SchedulerLedgerStoreError) throw error;
                throw asStoreError(`获取 scheduler ledger lock ${taskId} 失败`, "LOCK_ACQUIRE_FAILED", error);
            }
            if (existingLock) await breakStaleLock(taskId, lockPath, staleMs);
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw new SchedulerLedgerLockTimeoutError(taskId, timeoutMs);
            await sleep(Math.min(40, remainingMs));
        }
    }
}

async function writeSchedulerLedgerLockPayload(
    handle: fs.promises.FileHandle,
    payload: string,
    context: { taskId: string; lockPath: string; token: string; deadline: number },
): Promise<void> {
    const bytes = Buffer.from(payload, "utf8");
    for (;;) {
        try {
            await lockTestHook?.({
                phase: "before-lock-write",
                taskId: context.taskId,
                lockPath: context.lockPath,
                token: context.token,
                ownerPid: process.pid,
            });
            await handle.truncate(0);
            const written = await handle.write(bytes, 0, bytes.length, 0);
            if (written.bytesWritten !== bytes.length) throw new Error(`scheduler ledger lock 短写：${written.bytesWritten}/${bytes.length}`);
            await handle.truncate(bytes.length);
            await handle.sync();
            return;
        } catch (error) {
            const remainingMs = context.deadline - Date.now();
            if (!isTransientWindowsSchedulerLockRace(error) || remainingMs <= 0) throw error;
            await sleep(Math.min(40, remainingMs));
        }
    }
}

async function removeFailedSchedulerLedgerLock(lockPath: string, deadline: number): Promise<void> {
    for (;;) {
        try {
            await fs.promises.rm(lockPath, { force: true });
            return;
        } catch (error) {
            const remainingMs = deadline - Date.now();
            if (!isTransientWindowsSchedulerLockRace(error) || remainingMs <= 0) throw error;
            await sleep(Math.min(40, remainingMs));
        }
    }
}

function createFileLock(
    taskId: string,
    lockPath: string,
    token: string,
    handle: fs.promises.FileHandle,
): SchedulerLedgerFileLock {
    let released = false;
    const assertHeld = async (): Promise<void> => {
        if (released) throw new SchedulerLedgerStoreError(`scheduler ledger ${taskId} lock 已释放`, "LOCK_RELEASED");
        let payload: unknown;
        try {
            payload = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
        } catch (error) {
            throw asStoreError(`scheduler ledger ${taskId} lock 丢失`, "LOCK_LOST", error);
        }
        if (!isPlainObject(payload) || payload.token !== token || payload.taskId !== taskId) {
            throw new SchedulerLedgerStoreError(`scheduler ledger ${taskId} lock 已被其他 owner 接管`, "LOCK_LOST");
        }
    };
    return {
        taskId,
        path: lockPath,
        async heartbeat(): Promise<void> {
            try {
                const now = new Date();
                await handle.utimes(now, now);
                await handle.sync();
                await assertHeld();
            } catch (error) {
                throw asStoreError(`scheduler ledger ${taskId} lock heartbeat 失败`, "LOCK_HEARTBEAT_FAILED", error);
            }
        },
        assertHeld,
        async release(): Promise<void> {
            if (released) return;
            released = true;
            try {
                await handle.close();
            } finally {
                try {
                    const payload = JSON.parse(await fs.promises.readFile(lockPath, "utf8"));
                    if (isPlainObject(payload) && payload.token === token && payload.taskId === taskId) {
                        await fs.promises.unlink(lockPath);
                    }
                } catch (error) {
                    if (!isErrno(error, "ENOENT")) throw asStoreError(`释放 scheduler ledger ${taskId} lock 失败`, "LOCK_RELEASE_FAILED", error);
                }
            }
        },
    };
}

interface SchedulerLedgerLockMetadata {
    taskId: string;
    token: string;
    ownerPid: number;
    acquiredAt: string;
}

interface SchedulerLedgerLockSnapshot {
    metadata: SchedulerLedgerLockMetadata;
    raw: string;
    mtimeMs: number;
    size: number;
}

async function breakStaleLock(taskId: string, lockPath: string, staleMs: number): Promise<void> {
    const observed = await readSchedulerLedgerLockSnapshot(taskId, lockPath);
    if (!observed) return;
    const observedOwnerAlive = isProcessAlive(observed.metadata.ownerPid);
    if (observedOwnerAlive && Date.now() - observed.mtimeMs < staleMs) return;
    await lockTestHook?.({
        phase: "stale-observed",
        taskId,
        lockPath,
        token: observed.metadata.token,
        ownerPid: observed.metadata.ownerPid,
    });
    const confirmed = await readSchedulerLedgerLockSnapshot(taskId, lockPath);
    if (!confirmed || !sameLockSnapshot(observed, confirmed)) return;
    if (isProcessAlive(confirmed.metadata.ownerPid)) return;

    const tokenHash = crypto.createHash("sha256").update(confirmed.metadata.token).digest("hex").slice(0, 20);
    const claimDirectory = `${lockPath}.stale-claim-${tokenHash}`;
    try {
        await fs.promises.mkdir(claimDirectory);
    } catch (error) {
        if (isErrno(error, "EEXIST")) return;
        if (isTransientWindowsSchedulerLockRace(error)) return;
        throw asStoreError("创建 stale lock 原子 claim 失败", "LOCK_STALE_CLAIM_FAILED", error);
    }

    const quarantinePath = path.join(claimDirectory, "quarantined.lock");
    try {
        await lockTestHook?.({
            phase: "stale-claim-acquired",
            taskId,
            lockPath,
            token: confirmed.metadata.token,
            ownerPid: confirmed.metadata.ownerPid,
        });
        const beforeRename = await readSchedulerLedgerLockSnapshot(taskId, lockPath);
        if (!beforeRename
            || !sameLockSnapshot(confirmed, beforeRename)
            || isProcessAlive(beforeRename.metadata.ownerPid)) return;
        try {
            await fs.promises.rename(lockPath, quarantinePath);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return;
            if (isTransientWindowsSchedulerLockRace(error)) return;
            throw asStoreError("原子隔离 stale scheduler ledger lock 失败", "LOCK_STALE_QUARANTINE_FAILED", error);
        }
        await lockTestHook?.({
            phase: "stale-quarantined",
            taskId,
            lockPath,
            token: confirmed.metadata.token,
            ownerPid: confirmed.metadata.ownerPid,
        });
        const quarantined = await readSchedulerLedgerLockSnapshot(taskId, quarantinePath);
        if (!quarantined || !sameLockSnapshot(beforeRename, quarantined) || isProcessAlive(quarantined.metadata.ownerPid)) {
            await restoreQuarantinedLock(quarantinePath, lockPath);
            return;
        }
        await fs.promises.unlink(quarantinePath);
    } finally {
        try {
            await fs.promises.rmdir(claimDirectory);
        } catch (error) {
            if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY")) {
                throw asStoreError("清理 stale lock claim 目录失败", "LOCK_STALE_CLAIM_CLEANUP_FAILED", error);
            }
        }
    }
}

async function readSchedulerLedgerLockSnapshot(taskId: string, lockPath: string): Promise<SchedulerLedgerLockSnapshot | null> {
    try {
        await lockTestHook?.({
            phase: "before-stale-read",
            taskId,
            lockPath,
            token: "snapshot-read",
            ownerPid: process.pid,
        });
        const handle = await fs.promises.open(lockPath, "r");
        try {
            const raw = await handle.readFile("utf8");
            const stat = await handle.stat();
            let value: unknown;
            try {
                value = JSON.parse(raw);
            } catch {
                return null;
            }
            if (!isPlainObject(value)
                || !isNonEmptyString(value.taskId)
                || !isNonEmptyString(value.token)
                || !isPositiveInteger(value.ownerPid)
                || !isTimestamp(value.acquiredAt)) {
                throw new SchedulerLedgerStoreError(`scheduler ledger lock 元数据非法：${lockPath}`, "LOCK_METADATA_INVALID");
            }
            return {
                metadata: {
                    taskId: value.taskId,
                    token: value.token,
                    ownerPid: value.ownerPid,
                    acquiredAt: value.acquiredAt,
                },
                raw,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
            };
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        if (isTransientWindowsSchedulerLockRace(error)) return null;
        if (error instanceof SchedulerLedgerStoreError) throw error;
        throw asStoreError("读取 scheduler ledger lock 快照失败", "LOCK_STALE_READ_FAILED", error);
    }
}

function sameLockSnapshot(left: SchedulerLedgerLockSnapshot, right: SchedulerLedgerLockSnapshot): boolean {
    return left.raw === right.raw
        && left.mtimeMs === right.mtimeMs
        && left.size === right.size
        && left.metadata.taskId === right.metadata.taskId
        && left.metadata.token === right.metadata.token
        && left.metadata.ownerPid === right.metadata.ownerPid;
}

function isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !isErrno(error, "ESRCH");
    }
}

function isTransientWindowsSchedulerLockRace(error: unknown): boolean {
    return process.platform === "win32"
        && (isErrno(error, "EPERM") || isErrno(error, "EACCES") || isErrno(error, "EBUSY"));
}

async function restoreQuarantinedLock(quarantinePath: string, lockPath: string): Promise<void> {
    try {
        await fs.promises.link(quarantinePath, lockPath);
        await fs.promises.unlink(quarantinePath);
    } catch (error) {
        if (!isErrno(error, "EEXIST")) {
            throw asStoreError("恢复被错误隔离的 scheduler ledger lock 失败", "LOCK_STALE_RESTORE_FAILED", error);
        }
    }
}

async function writeDurableJsonAtomic(filePath: string, value: unknown): Promise<SchedulerLedgerDurabilityReceipt> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const content = `${JSON.stringify(value, null, 2)}\n`;
    let temporaryHandle: fs.promises.FileHandle | undefined;
    try {
        temporaryHandle = await fs.promises.open(temporaryPath, "wx");
        await temporaryHandle.writeFile(content, "utf8");
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        await renameWithRetry(temporaryPath, filePath);
        return await establishPersistedFileDurability(filePath);
    } catch (error) {
        if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof SchedulerLedgerDurabilityError) throw error;
        throw asStoreError(`原子持久化 scheduler ledger 失败：${filePath}`, "PERSIST_FAILED", error);
    }
}

async function establishPersistedFileDurability(filePath: string): Promise<SchedulerLedgerDurabilityReceipt> {
    let persistedHandle: fs.promises.FileHandle | undefined;
    try {
        persistedHandle = await fs.promises.open(filePath, "r+");
        await persistedHandle.sync();
    } catch (error) {
        throw new SchedulerLedgerDurabilityError(
            `scheduler ledger 目标文件同步失败：${filePath}${error instanceof Error ? `：${error.message}` : ""}`,
            "TARGET_FILE_SYNC_FAILED",
        );
    } finally {
        await persistedHandle?.close().catch(() => undefined);
    }

    if (process.platform === "win32") {
        return {
            scope: "process-crash-hot-restart",
            temporaryFileSynced: true,
            atomicReplaceCompleted: true,
            targetFileSynced: true,
            parentDirectory: {
                method: "windows-target-file-flush",
                directoryFsyncSupported: false,
                durableBarrierCompleted: true,
            },
        };
    }

    let directoryHandle: fs.promises.FileHandle | undefined;
    try {
        directoryHandle = await fs.promises.open(path.dirname(filePath), "r");
        await directoryHandle.sync();
    } catch (error) {
        throw new SchedulerLedgerDurabilityError(
            `scheduler ledger 父目录同步失败：${path.dirname(filePath)}${error instanceof Error ? `：${error.message}` : ""}`,
            "PARENT_DIRECTORY_SYNC_FAILED",
        );
    } finally {
        await directoryHandle?.close().catch(() => undefined);
    }
    return {
        scope: "process-crash-hot-restart",
        temporaryFileSynced: true,
        atomicReplaceCompleted: true,
        targetFileSynced: true,
        parentDirectory: {
            method: "directory-fsync",
            directoryFsyncSupported: true,
            durableBarrierCompleted: true,
        },
    };
}

async function renameWithRetry(sourcePath: string, targetPath: string): Promise<void> {
    const transientCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fs.promises.rename(sourcePath, targetPath);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !transientCodes.has(code) || attempt === 4) throw error;
            await sleep(10 * 2 ** attempt);
        }
    }
}

async function readRawFile(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw asStoreError(`读取 scheduler ledger 文件失败：${filePath}`, "READ_FAILED", error);
    }
}

function storedLedger(
    ledgerPath: string,
    ledger: PersistedRecordSchedulerLedger,
    durability: SchedulerLedgerDurabilityReceipt,
): StoredSchedulerLedger {
    return { path: ledgerPath, ledger, revision: ledger.revision, hash: ledger.persistedHash, durability };
}

function createAdmissionReceipt(
    ledgerPath: string,
    ledger: PersistedRecordSchedulerLedger,
    admission: EnvelopeBoundAdmission,
): RecordSchedulerAdmissionReceipt {
    return {
        verifier: "record-scheduler-admission",
        verifiedAt: new Date().toISOString(),
        taskId: ledger.task.taskId,
        taskKind: taskKindForRequestMode(ledger.task.requestMode),
        admissionIdentity: structuredClone(ledger.task.admissionIdentity),
        ledgerPath: path.resolve(ledgerPath),
        ledgerRevision: ledger.revision,
        ledgerHash: ledger.persistedHash,
        ledgerAnchor: structuredClone(admission.ledgerAnchor),
        capsuleRef: structuredClone(admission.capsuleRef),
    };
}

async function assertAdmissionCapsuleBinding(
    taskId: string,
    ledgerAnchor: SchedulerLedgerAnchor,
    capsuleRef: ImmutableBlobReference,
    ledger?: PersistedRecordSchedulerLedger,
): Promise<SchedulerAdmissionCapsule> {
    const expectedLedgerPath = path.resolve(recordSchedulerLedgerPath(taskId));
    const expectedCapsulePath = recordSchedulerAdmissionCapsulePath(taskId);
    if (!isValidLedgerAnchor(ledgerAnchor)
        || path.resolve(ledgerAnchor.path) !== expectedLedgerPath
        || !isValidImmutableSha256Reference(capsuleRef)
        || path.resolve(capsuleRef.path) !== expectedCapsulePath) {
        throw new SchedulerLedgerRepairRequiredError(taskId, "admission anchor 或 capsule reference 非法");
    }
    const read = await readRecordSchedulerAdmissionCapsule(taskId);
    if (read.kind !== "current") {
        throw new SchedulerLedgerRepairRequiredError(taskId, `admission capsule 不可验证：${read.kind === "missing" ? "missing" : read.reason}`);
    }
    return assertAdmissionCapsuleReadBinding(taskId, ledgerAnchor, capsuleRef, read, ledger);
}

function assertAdmissionCapsuleBindingSync(
    taskId: string,
    ledgerAnchor: SchedulerLedgerAnchor,
    capsuleRef: ImmutableBlobReference,
    ledger?: PersistedRecordSchedulerLedger,
): SchedulerAdmissionCapsule {
    const expectedLedgerPath = path.resolve(recordSchedulerLedgerPath(taskId));
    const expectedCapsulePath = recordSchedulerAdmissionCapsulePath(taskId);
    if (!isValidLedgerAnchor(ledgerAnchor)
        || path.resolve(ledgerAnchor.path) !== expectedLedgerPath
        || !isValidImmutableSha256Reference(capsuleRef)
        || path.resolve(capsuleRef.path) !== expectedCapsulePath) {
        throw new SchedulerLedgerRepairRequiredError(taskId, "admission anchor 或 capsule reference 非法");
    }
    const read = readRecordSchedulerAdmissionCapsuleSync(taskId);
    if (read.kind !== "current") {
        throw new SchedulerLedgerRepairRequiredError(taskId, `admission capsule 不可验证：${read.kind === "missing" ? "missing" : read.reason}`);
    }
    return assertAdmissionCapsuleReadBinding(taskId, ledgerAnchor, capsuleRef, read, ledger);
}

function assertAdmissionCapsuleReadBinding(
    taskId: string,
    ledgerAnchor: SchedulerLedgerAnchor,
    capsuleRef: ImmutableBlobReference,
    read: Extract<SchedulerAdmissionCapsuleReadResult, { kind: "current" }>,
    ledger?: PersistedRecordSchedulerLedger,
): SchedulerAdmissionCapsule {
    if (!sameBlobReference(read.ref, capsuleRef)) {
        throw new SchedulerLedgerRepairRequiredError(taskId, "admission capsule 的真实 hash/path/byteLength 与 ledger binding 不一致");
    }
    const capsule = read.capsule;
    if (!sameLedgerAnchor(capsule.ledgerAnchor, ledgerAnchor)) {
        throw new SchedulerLedgerRepairRequiredError(taskId, "admission capsule ledgerAnchor 与 ledger binding 不一致");
    }
    if (ledger) {
        if (capsule.taskKind !== taskKindForRequestMode(ledger.task.requestMode)) {
            throw new SchedulerLedgerRepairRequiredError(taskId, "admission capsule taskKind 与 ledger requestMode 不一致");
        }
        if (!sameAdmissionIdentity(capsule.admissionIdentity, ledger.task.admissionIdentity)) {
            throw new SchedulerLedgerRepairRequiredError(taskId, "admission capsule identity 与 ledger L1 identity 不一致");
        }
        const bound = ledger.task.admission;
        if (bound.state === "EnvelopeBound"
            && (!sameLedgerAnchor(bound.ledgerAnchor, ledgerAnchor) || !sameBlobReference(bound.capsuleRef, capsuleRef))) {
            throw new SchedulerLedgerRepairRequiredError(taskId, "ledger EnvelopeBound 与待验证 admission binding 不一致");
        }
    }
    return capsule;
}

function assertValidAdmissionCapsule(capsule: SchedulerAdmissionCapsule): void {
    if (!isValidAdmissionCapsule(capsule)) {
        throw new SchedulerLedgerRepairRequiredError("unknown", "admission capsule 格式、路径或 sha256 anchor 非法");
    }
    const expectedLedgerPath = path.resolve(recordSchedulerLedgerPath(capsule.taskId));
    if (path.resolve(capsule.ledgerAnchor.path) !== expectedLedgerPath) {
        throw new SchedulerLedgerRepairRequiredError(capsule.taskId, "admission capsule ledgerAnchor path 必须是 task 的规范 ledger path");
    }
}

function isValidAdmissionCapsule(value: unknown): value is SchedulerAdmissionCapsule {
    if (!(isPlainObject(value)
        && value.schemaVersion === 2
        && value.kind === "record-scheduler-admission-capsule"
        && isNonEmptyString(value.taskId)
        && (value.taskKind === "record-update" || value.taskKind === "record-batch-update")
        && isValidAdmissionIdentity(value.admissionIdentity)
        && isValidLedgerAnchor(value.ledgerAnchor)
        && isPlainObject(value.requestSummary)
        && isValidAdmissionBackgroundProjection(value.backgroundProjection))) return false;
    return value.admissionIdentity.requestHash === calculateRecordSchedulerAdmissionRequestHash(
        value.taskKind,
        value.requestSummary,
        value.backgroundProjection,
    );
}

function isValidAdmissionReceipt(value: unknown): value is RecordSchedulerAdmissionReceipt {
    return isPlainObject(value)
        && value.verifier === "record-scheduler-admission"
        && isTimestamp(value.verifiedAt)
        && isNonEmptyString(value.taskId)
        && (value.taskKind === "record-update" || value.taskKind === "record-batch-update")
        && isValidAdmissionIdentity(value.admissionIdentity)
        && isNonEmptyString(value.ledgerPath)
        && isPositiveInteger(value.ledgerRevision)
        && isSha256(value.ledgerHash)
        && isValidLedgerAnchor(value.ledgerAnchor)
        && isValidImmutableSha256Reference(value.capsuleRef);
}

function sameAdmissionReceipt(left: RecordSchedulerAdmissionReceipt, right: RecordSchedulerAdmissionReceipt): boolean {
    return left.verifier === right.verifier
        && left.taskId === right.taskId
        && left.taskKind === right.taskKind
        && sameAdmissionIdentity(left.admissionIdentity, right.admissionIdentity)
        && path.resolve(left.ledgerPath) === path.resolve(right.ledgerPath)
        && left.ledgerRevision === right.ledgerRevision
        && left.ledgerHash === right.ledgerHash
        && sameLedgerAnchor(left.ledgerAnchor, right.ledgerAnchor)
        && sameBlobReference(left.capsuleRef, right.capsuleRef);
}

function sameImmutableAdmissionReceiptBinding(left: RecordSchedulerAdmissionReceipt, right: RecordSchedulerAdmissionReceipt): boolean {
    return left.verifier === right.verifier
        && left.taskId === right.taskId
        && left.taskKind === right.taskKind
        && sameAdmissionIdentity(left.admissionIdentity, right.admissionIdentity)
        && path.resolve(left.ledgerPath) === path.resolve(right.ledgerPath)
        && sameLedgerAnchor(left.ledgerAnchor, right.ledgerAnchor)
        && sameBlobReference(left.capsuleRef, right.capsuleRef);
}

function taskKindForRequestMode(requestMode: PersistedRecordSchedulerLedger["task"]["requestMode"]): RecordSchedulerAdmissionReceipt["taskKind"] {
    return requestMode === "update" ? "record-update" : "record-batch-update";
}

async function publishImmutableJson(
    filePath: string,
    content: string,
    contentHash: string,
    taskId: string,
): Promise<SchedulerLedgerDurabilityReceipt> {
    const directory = path.dirname(filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = `${filePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    let temporaryHandle: fs.promises.FileHandle | undefined;
    try {
        temporaryHandle = await fs.promises.open(temporaryPath, "wx");
        await temporaryHandle.writeFile(content, "utf8");
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        await runFault({
            point: "after-admission-capsule-temp-sync",
            taskId,
            operation: "admission-capsule",
            path: filePath,
        });
        try {
            await fs.promises.link(temporaryPath, filePath);
        } catch (error) {
            if (!isErrno(error, "EEXIST")) throw error;
            const existing = await fs.promises.readFile(filePath, "utf8");
            if (sha256(existing) !== contentHash || existing !== content) {
                throw new SchedulerLedgerRepairRequiredError("unknown", `immutable admission capsule 已存在但内容不一致：${filePath}`);
            }
        }
        return await establishPersistedFileDurability(filePath);
    } catch (error) {
        if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
        if (error instanceof SchedulerLedgerStoreError) throw error;
        throw asStoreError(`原子发布 immutable admission capsule 失败：${filePath}`, "ADMISSION_CAPSULE_PERSIST_FAILED", error);
    } finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
}

function isValidLedgerAnchor(value: unknown): value is SchedulerLedgerAnchor {
    return isPlainObject(value)
        && isNonEmptyString(value.path)
        && value.revision === 1
        && isSha256(value.hash);
}

function isValidImmutableSha256Reference(value: unknown): value is ImmutableBlobReference {
    return isPlainObject(value)
        && isNonEmptyString(value.path)
        && isSha256(value.hash)
        && typeof value.byteLength === "number"
        && Number.isInteger(value.byteLength)
        && value.byteLength >= 0;
}

function sameLedgerAnchor(left: SchedulerLedgerAnchor, right: SchedulerLedgerAnchor): boolean {
    return path.resolve(left.path) === path.resolve(right.path)
        && left.revision === right.revision
        && left.hash === right.hash;
}

function sameBlobReference(left: ImmutableBlobReference, right: ImmutableBlobReference): boolean {
    return path.resolve(left.path) === path.resolve(right.path)
        && left.hash === right.hash
        && left.byteLength === right.byteLength;
}

function sha256(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function isSha256(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isValidAdmissionIdentity(value: unknown): value is SchedulerAdmissionIdentity {
    return isPlainObject(value)
        && isNonEmptyString(value.requestKey)
        && value.requestKey.length <= 512
        && isSha256(value.requestHash);
}

function sameAdmissionIdentity(left: SchedulerAdmissionIdentity, right: SchedulerAdmissionIdentity): boolean {
    return left.requestKey === right.requestKey && left.requestHash === right.requestHash;
}

function isValidAdmissionBackgroundProjection(value: unknown): value is SchedulerAdmissionBackgroundProjection {
    if (!isPlainObject(value)) return false;
    const allowedKeys = new Set(["projection", "resumePayload", "resumeVersion", "resumeHash"]);
    if (Object.keys(value).some(key => !allowedKeys.has(key))) return false;
    try {
        if (value.projection !== undefined) stableJsonStringify(value.projection);
        if (value.resumePayload === undefined) {
            return value.resumeVersion === undefined && value.resumeHash === undefined;
        }
        stableJsonStringify(value.resumePayload);
        return isPositiveInteger(value.resumeVersion)
            && isSha256(value.resumeHash)
            && sha256(stableJsonStringify(value.resumePayload)) === value.resumeHash;
    } catch {
        return false;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isValidSchedulerOwnerLease(value: unknown): value is SchedulerOwnerLease {
    return isPlainObject(value)
        && isNonEmptyString(value.ownerId)
        && isNonEmptyString(value.leaseId)
        && isPositiveInteger(value.schedulerEpoch)
        && isPositiveInteger(value.fencingToken)
        && isTimestamp(value.acquiredAt)
        && isTimestamp(value.heartbeatAt)
        && isTimestamp(value.expiresAt)
        && ((value.ownerPid === undefined && value.ownerStartedAtMs === undefined)
            || (isPositiveInteger(value.ownerPid) && isPositiveInteger(value.ownerStartedAtMs)))
        && Date.parse(value.acquiredAt) <= Date.parse(value.heartbeatAt)
        && Date.parse(value.heartbeatAt) <= Date.parse(value.expiresAt);
}

function isValidSchedulerOwnerRecoveryState(value: unknown): value is SchedulerOwnerRecoveryState {
    return isPlainObject(value)
        && value.required === true
        && value.reason === "registry-lease-reacquire"
        && isNonEmptyString(value.previousTaskState)
        && isTimestamp(value.claimedAt)
        && Array.isArray(value.pendingRecordWorkKeys)
        && value.pendingRecordWorkKeys.every(isNonEmptyString)
        && new Set(value.pendingRecordWorkKeys).size === value.pendingRecordWorkKeys.length;
}

function sameSchedulerOwnerLease(left: SchedulerOwnerLease | undefined, right: SchedulerOwnerLease | undefined): boolean {
    return stableJsonStringify(left) === stableJsonStringify(right);
}

function normalizeLeaseMs(leaseMs: number | undefined): number {
    return normalizePositiveMs(leaseMs, 30_000, "owner lease") < MIN_OWNER_LEASE_MS
        ? MIN_OWNER_LEASE_MS
        : normalizePositiveMs(leaseMs, 30_000, "owner lease");
}

function normalizePositiveMs(value: number | undefined, fallback: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved <= 0) throw new SchedulerLedgerStoreError(`${label} 必须是正数`, "INVALID_DURATION");
    return resolved;
}

function assertSafeTaskId(taskId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(taskId)) {
        throw new SchedulerLedgerStoreError("taskId 只能包含字母、数字、点、下划线和连字符，且不得为空", "INVALID_TASK_ID");
    }
}

function stableJsonStringify(value: unknown): string {
    return stableJsonValue(value, false);
}

function stableJsonValue(value: unknown, arrayEntry: boolean): string {
    if (value === null) return "null";
    if (value === undefined) return arrayEntry ? "null" : "";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new SchedulerLedgerStoreError("ledger hash 不支持非有限 number", "INVALID_HASH_VALUE");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(entry => stableJsonValue(entry, true)).join(",")}]`;
    if (!isPlainObject(value)) throw new SchedulerLedgerStoreError("ledger hash 只支持 JSON 值", "INVALID_HASH_VALUE");
    return `{${Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableJsonValue(value[key], false)}`)
        .join(",")}}`;
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

function isTimestamp(value: unknown): value is string {
    return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isErrno(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function asStoreError(message: string, code: string, cause: unknown): SchedulerLedgerStoreError {
    const suffix = cause instanceof Error ? `：${cause.message}` : "";
    return new SchedulerLedgerStoreError(`${message}${suffix}`, code);
}
