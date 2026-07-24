import {
    FifoConcurrencyGate,
    type ConcurrencyGateAcquireOptions,
    type ConcurrencyGatePermit,
    type ConcurrencyGateSnapshot,
} from "./concurrency-gate.js";
import {
    AdaptiveConcurrencyGate,
    type AdaptiveConcurrencySnapshot,
} from "./adaptive-concurrency.js";
import type { BackgroundTaskProgress } from "./background-tasks.js";
import { buildRecordReaderIndex, type RecordReaderIndex } from "./record-reader.js";
import {
    calculateRecordCommitArtifactJsonHash,
    deleteRecordSidecar,
    getRecordCommitArtifactRelativePath,
    readRecordCommitBodyArtifactLocked,
    readRecordCommitMainIndexArtifactLocked,
    readRecordSidecarAsync,
    validateRecordCommitArtifactTarget,
    withRecordCommitArtifactLock,
    writeRecordSidecar,
    type RecordCommitArtifactIdentity,
    type RecordCommitArtifactTarget,
    type RecordCommitAuthorityScope,
    type RecordCommitConditionalMutationResult,
    type RecordCommitJsonArtifactImage,
    type RecordCommitMainIndexEntry,
    type RecordCommitOwnershipValidator,
} from "./record-store.js";

const DEFAULT_RECORD_PERSISTENCE_CONCURRENCY = 8;
const INITIAL_RECORD_PERSISTENCE_CONCURRENCY = 2;
const RECORD_PERSISTENCE_CONGESTION_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);
const RECORD_READER_SIDECAR = "record_index.json";
const RECORD_READER_REBUILD_SIDECAR = "record_index.rebuild.json";

export type RecordUpdateAbortReason = "cancelled" | "settled";

export type RecordUpdateSharedPermit = {
    queueWaitMs: number;
    snapshot: RecordPersistenceConcurrencySnapshot;
    release: () => void;
};

export type RecordPersistenceConcurrencySnapshot = ConcurrencyGateSnapshot & AdaptiveConcurrencySnapshot;

export type RecordGateAcquireOptions = {
    isCancelled?: () => boolean;
    isSettled?: () => boolean;
    onProgress?: (progress: BackgroundTaskProgress) => void;
    waitingStage: string;
    acquiredStage: string;
    waitingDetail: string;
    acquiredDetail: string;
};

export class RecordUpdatePoolAbortError extends Error {
    constructor(
        readonly reason: RecordUpdateAbortReason,
        readonly snapshot: ConcurrencyGateSnapshot,
    ) {
        super(
            reason === "cancelled"
                ? "Record 更新在共享池排队时已取消"
                : "Record 更新在共享池排队时已结算",
        );
        this.name = "RecordUpdatePoolAbortError";
    }
}

export class RecordSingleFlightAbortError extends Error {
    constructor(
        readonly reason: RecordUpdateAbortReason,
        readonly snapshot: ConcurrencyGateSnapshot,
    ) {
        super(
            reason === "cancelled"
                ? "同一 Record 更新排队时已取消"
                : "同一 Record 更新排队时已结算",
        );
        this.name = "RecordSingleFlightAbortError";
    }
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = Number(process.env[name] || "");
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    return fallback;
}

export function getRecordUpdateConcurrencyLimit(): number {
    return readPositiveIntEnv("MEMORY_STORE_RECORD_UPDATE_CONCURRENCY", DEFAULT_RECORD_PERSISTENCE_CONCURRENCY);
}

export function getRecordTaskAbortReason(
    options: Pick<RecordGateAcquireOptions, "isCancelled" | "isSettled"> = {},
): RecordUpdateAbortReason | null {
    if (options.isCancelled?.()) return "cancelled";
    if (options.isSettled?.()) return "settled";
    return null;
}

let recordPersistenceAdaptiveGate: { max: number; gate: AdaptiveConcurrencyGate } | null = null;
const recordPersistenceGate = new FifoConcurrencyGate(() => getRecordPersistenceAdaptiveGate().limit);
const recordSingleFlightGates = new Map<string, FifoConcurrencyGate>();

function getRecordPersistenceAdaptiveGate(): AdaptiveConcurrencyGate {
    const max = getRecordUpdateConcurrencyLimit();
    if (!recordPersistenceAdaptiveGate || recordPersistenceAdaptiveGate.max !== max) {
        recordPersistenceAdaptiveGate = {
            max,
            gate: new AdaptiveConcurrencyGate(max, 1, INITIAL_RECORD_PERSISTENCE_CONCURRENCY),
        };
    }
    return recordPersistenceAdaptiveGate.gate;
}

function recordPersistenceStats(): RecordPersistenceConcurrencySnapshot {
    const adaptive = getRecordPersistenceAdaptiveGate();
    return {
        ...recordPersistenceGate.stats(),
        ...adaptive.snapshot(),
        limit: adaptive.limit,
    };
}

export function getRecordPersistenceConcurrencySnapshot(): RecordPersistenceConcurrencySnapshot {
    return recordPersistenceStats();
}

export function isRecordPersistenceCongestionError(error: unknown): boolean {
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const code = "code" in current ? (current as { code?: unknown }).code : undefined;
        if (typeof code === "string" && RECORD_PERSISTENCE_CONGESTION_CODES.has(code)) return true;
        current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return false;
}

export type RecordReaderIndexPersistenceResult = {
    index: RecordReaderIndex | null;
    error: unknown | null;
};

export interface RecordCommitReaderIndexEntry {
    commitId: string;
    bodyHash: string;
    coveredRevision: string;
    conversationId: string;
    recordId: string;
}

export interface WriteRecordCommitReaderIndexConditionallyInput {
    hash: string;
    target: RecordCommitArtifactTarget;
    identity: RecordCommitArtifactIdentity;
    index: RecordCommitReaderIndexEntry;
    expected: RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>;
    validateOwnership: RecordCommitOwnershipValidator;
    withCommitAuthority?: RecordCommitAuthorityScope;
    beforeWrite?: () => Promise<void> | void;
}

export interface RebuildRecordCommitReaderIndexFromBodyInput {
    hash: string;
    identity: RecordCommitArtifactIdentity;
    bodyTarget: RecordCommitArtifactTarget;
    mainIndexTarget: RecordCommitArtifactTarget;
    readerIndexTarget: RecordCommitArtifactTarget;
    expectedBody: Awaited<ReturnType<typeof readRecordCommitBodyArtifactLocked>>;
    expectedMainIndex: RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>;
    expectedReaderIndex: RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>;
    validateOwnership: RecordCommitOwnershipValidator;
    withCommitAuthority?: RecordCommitAuthorityScope;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function invalidateRecordReaderIndex(
    hash: string,
    conversationId: string,
    reason: unknown,
): Promise<void> {
    let deleteError: unknown = null;
    try {
        await deleteRecordSidecar(hash, conversationId, RECORD_READER_SIDECAR);
    } catch (error) {
        if (isRecordPersistenceCongestionError(error)) throw error;
        deleteError = error;
    }

    try {
        await writeRecordSidecar(hash, conversationId, RECORD_READER_REBUILD_SIDECAR, {
            invalidatedAt: new Date().toISOString(),
            reason: errorMessage(reason),
        });
    } catch (error) {
        if (isRecordPersistenceCongestionError(error)) throw error;
        if (deleteError) {
            throw Object.assign(
                new Error(`Reader Index 失效标记失败: ${errorMessage(deleteError)}; ${errorMessage(error)}`),
                { cause: error },
            );
        }
    }
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function sameIdentity(left: RecordCommitArtifactIdentity | null, right: RecordCommitArtifactIdentity | null): boolean {
    return left?.conversationId === right?.conversationId
        && left?.recordId === right?.recordId
        && left?.commitId === right?.commitId
        && left?.coveredRevision === right?.coveredRevision
        && left?.bodyHash === right?.bodyHash
        && left?.recordCommitEpoch === right?.recordCommitEpoch;
}

function isReaderIndexEntry(value: unknown): value is RecordCommitReaderIndexEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Partial<RecordCommitReaderIndexEntry>;
    return isNonEmptyString(entry.commitId)
        && isNonEmptyString(entry.bodyHash)
        && isNonEmptyString(entry.coveredRevision)
        && isNonEmptyString(entry.conversationId)
        && isNonEmptyString(entry.recordId);
}

function sameReaderImage(
    left: RecordCommitJsonArtifactImage,
    right: RecordCommitJsonArtifactImage,
): boolean {
    return left.hash === right.hash
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision
        && sameIdentity(left.identity, right.identity)
        && calculateRecordCommitArtifactJsonHash(left.value) === calculateRecordCommitArtifactJsonHash(right.value);
}

function emptyReaderImage(): RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry> {
    return { value: null, hash: null, ownerCommitId: null, revision: null, identity: null, storageValue: null };
}

function assertReaderTarget(
    hash: string,
    target: RecordCommitArtifactTarget,
    identity?: RecordCommitArtifactIdentity,
): void {
    if (!validateRecordCommitArtifactTarget(hash, target, "reader_index")) {
        throw new TypeError("reader_index target 必须映射到规范 Record 根内的当前 artifact 路径");
    }
    if (identity && (target.conversationId !== identity.conversationId || target.recordId !== identity.recordId)) {
        throw new TypeError("reader_index target identity 与 commit identity 不匹配");
    }
}

export async function readRecordCommitReaderIndexArtifactLocked(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>> {
    const stored = await readRecordSidecarAsync<RecordReaderIndex>(hash, target.conversationId, RECORD_READER_SIDECAR);
    if (!stored) return emptyReaderImage();
    const artifact = stored.commitArtifact;
    if (artifact
        && isReaderIndexEntry(artifact.readerIndex)
        && artifact.identity.conversationId === target.conversationId
        && artifact.identity.recordId === target.recordId
        && artifact.readerIndex.conversationId === target.conversationId
        && artifact.readerIndex.recordId === target.recordId) {
        return {
            value: structuredClone(artifact.readerIndex),
            hash: calculateRecordCommitArtifactJsonHash(artifact.readerIndex),
            ownerCommitId: artifact.identity.commitId,
            revision: artifact.identity.coveredRevision,
            identity: structuredClone(artifact.identity),
            storageValue: structuredClone(stored),
        };
    }
    return {
        value: structuredClone(stored) as unknown as RecordCommitReaderIndexEntry,
        hash: calculateRecordCommitArtifactJsonHash(stored),
        ownerCommitId: null,
        revision: null,
        identity: null,
        storageValue: structuredClone(stored),
    };
}

export async function readRecordCommitReaderIndexArtifact(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>> {
    assertReaderTarget(hash, target);
    return withRecordCommitArtifactLock(hash, () => readRecordCommitReaderIndexArtifactLocked(hash, target));
}

async function ownershipApproved(
    callback: RecordCommitOwnershipValidator,
    phase: "before_write" | "after_write",
    target: RecordCommitArtifactTarget,
    identity: RecordCommitArtifactIdentity,
    current: RecordCommitJsonArtifactImage,
): Promise<boolean> {
    return Boolean(await callback({
        phase,
        target,
        identity: structuredClone(identity),
        current: structuredClone(current),
    }));
}

function readerEntryForIdentity(identity: RecordCommitArtifactIdentity): RecordCommitReaderIndexEntry {
    return {
        commitId: identity.commitId,
        bodyHash: identity.bodyHash,
        coveredRevision: identity.coveredRevision,
        conversationId: identity.conversationId,
        recordId: identity.recordId,
    };
}

async function withCommitAuthority<Value>(scope: RecordCommitAuthorityScope | undefined, operation: () => Promise<Value>): Promise<Value> {
    return scope ? scope(operation) : operation();
}

export async function writeRecordCommitReaderIndexConditionally(
    input: WriteRecordCommitReaderIndexConditionallyInput,
): Promise<RecordCommitConditionalMutationResult<RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>>> {
    assertReaderTarget(input.hash, input.target, input.identity);
    if (!isReaderIndexEntry(input.index)
        || input.index.commitId !== input.identity.commitId
        || input.index.bodyHash !== input.identity.bodyHash
        || input.index.coveredRevision !== input.identity.coveredRevision
        || input.index.conversationId !== input.identity.conversationId
        || input.index.recordId !== input.identity.recordId) {
        throw new TypeError("Reader Index entry 与 commit identity 不匹配");
    }
    return withRecordCommitArtifactLock(input.hash, () => withCommitAuthority(input.withCommitAuthority, async () => {
        const bodyTarget: RecordCommitArtifactTarget = {
            kind: "record_body",
            conversationId: input.target.conversationId,
            recordId: input.target.recordId,
            relativePath: getRecordCommitArtifactRelativePath("record_body", input.target.conversationId),
        };
        const body = await readRecordCommitBodyArtifactLocked(input.hash, bodyTarget);
        if (body.body === null || body.hash !== input.identity.bodyHash || !sameIdentity(body.identity, input.identity)) {
            throw new TypeError("Reader Index 写入前正文 identity/bodyHash 不匹配");
        }
        const current = await readRecordCommitReaderIndexArtifactLocked(input.hash, input.target);
        if (!await ownershipApproved(input.validateOwnership, "before_write", input.target, input.identity, current)) {
            return { kind: "ownership_changed", current };
        }
        const desired: RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry> = {
            value: structuredClone(input.index),
            hash: calculateRecordCommitArtifactJsonHash(input.index),
            ownerCommitId: input.identity.commitId,
            revision: input.identity.coveredRevision,
            identity: structuredClone(input.identity),
        };
        if (sameReaderImage(current, desired)) {
            await deleteRecordSidecar(input.hash, input.target.conversationId, RECORD_READER_REBUILD_SIDECAR);
            return { kind: "already_applied", current };
        }
        if (!sameReaderImage(current, input.expected) && !sameReaderImage(current, emptyReaderImage())) {
            return { kind: "expected_mismatch", current };
        }
        const built = buildRecordReaderIndex(input.target.recordId, body.body);
        built.commitArtifact = {
            identity: structuredClone(input.identity),
            readerIndex: structuredClone(input.index),
        };
        try {
            await input.beforeWrite?.();
            await writeRecordSidecar(input.hash, input.target.conversationId, RECORD_READER_SIDECAR, built);
            const written = await readRecordCommitReaderIndexArtifactLocked(input.hash, input.target);
            if (!sameReaderImage(written, desired)) throw new Error("Record commit Reader Index 回读与条件写入内容不一致");
            if (!await ownershipApproved(input.validateOwnership, "after_write", input.target, input.identity, written)) {
                return { kind: "ownership_changed", current: written };
            }
            await deleteRecordSidecar(input.hash, input.target.conversationId, RECORD_READER_REBUILD_SIDECAR);
            return { kind: "applied", current: written };
        } catch (error) {
            await invalidateRecordReaderIndex(input.hash, input.target.conversationId, error);
            throw error;
        }
    }));
}

export async function rebuildRecordCommitReaderIndexFromBody(
    input: RebuildRecordCommitReaderIndexFromBodyInput,
): Promise<RecordCommitConditionalMutationResult<RecordCommitJsonArtifactImage<RecordCommitReaderIndexEntry>>> {
    assertReaderTarget(input.hash, input.readerIndexTarget, input.identity);
    if (!validateRecordCommitArtifactTarget(input.hash, input.bodyTarget, "record_body")
        || !validateRecordCommitArtifactTarget(input.hash, input.mainIndexTarget, "main_index")
        || input.bodyTarget.conversationId !== input.identity.conversationId
        || input.bodyTarget.recordId !== input.identity.recordId
        || input.mainIndexTarget.conversationId !== input.identity.conversationId
        || input.mainIndexTarget.recordId !== input.identity.recordId) {
        throw new TypeError("Reader Index 重建 target identity/path 不匹配");
    }
    return withRecordCommitArtifactLock(input.hash, () => withCommitAuthority(input.withCommitAuthority, async () => {
        const [body, mainIndex, readerIndex] = await Promise.all([
            readRecordCommitBodyArtifactLocked(input.hash, input.bodyTarget),
            readRecordCommitMainIndexArtifactLocked(input.hash, input.mainIndexTarget),
            readRecordCommitReaderIndexArtifactLocked(input.hash, input.readerIndexTarget),
        ]);
        if (body.body !== input.expectedBody.body
            || body.hash !== input.expectedBody.hash
            || body.ownerCommitId !== input.expectedBody.ownerCommitId
            || body.revision !== input.expectedBody.revision
            || !sameIdentity(body.identity, input.expectedBody.identity)
            || !sameReaderImage(mainIndex, input.expectedMainIndex)) {
            return { kind: "ownership_changed", current: readerIndex };
        }
        if (readerIndex.ownerCommitId !== input.identity.commitId && !sameReaderImage(readerIndex, input.expectedReaderIndex)) {
            return { kind: "ownership_changed", current: readerIndex };
        }
        if (!await ownershipApproved(input.validateOwnership, "before_write", input.readerIndexTarget, input.identity, readerIndex)) {
            return { kind: "ownership_changed", current: readerIndex };
        }
        if (body.body === null) {
            await deleteRecordSidecar(input.hash, input.readerIndexTarget.conversationId, RECORD_READER_SIDECAR);
        } else {
            const rebuilt = buildRecordReaderIndex(input.readerIndexTarget.recordId, body.body);
            if (body.identity) {
                rebuilt.commitArtifact = {
                    identity: structuredClone(body.identity),
                    readerIndex: readerEntryForIdentity(body.identity),
                };
            }
            await writeRecordSidecar(input.hash, input.readerIndexTarget.conversationId, RECORD_READER_SIDECAR, rebuilt);
        }
        const rebuilt = await readRecordCommitReaderIndexArtifactLocked(input.hash, input.readerIndexTarget);
        if (rebuilt.ownerCommitId === input.identity.commitId) {
            throw new Error("Reader Index 重建后仍属于待清理的旧 commit");
        }
        if (!await ownershipApproved(input.validateOwnership, "after_write", input.readerIndexTarget, input.identity, rebuilt)) {
            return { kind: "ownership_changed", current: rebuilt };
        }
        return { kind: "applied", current: rebuilt };
    }));
}

export async function buildAndPersistRecordReaderIndex(
    hash: string,
    conversationId: string,
    content: string,
    options: { beforeWrite?: () => void | Promise<void> } = {},
): Promise<RecordReaderIndexPersistenceResult> {
    let index: RecordReaderIndex | null = null;
    try {
        index = buildRecordReaderIndex(conversationId, content);
        await options.beforeWrite?.();
        await writeRecordSidecar(hash, conversationId, RECORD_READER_SIDECAR, index);
    } catch (error) {
        if (isRecordPersistenceCongestionError(error)) throw error;
        await invalidateRecordReaderIndex(hash, conversationId, error);
        return { index, error };
    }

    try {
        await deleteRecordSidecar(hash, conversationId, RECORD_READER_REBUILD_SIDECAR);
    } catch (error) {
        if (isRecordPersistenceCongestionError(error)) throw error;
        return { index, error };
    }
    return { index, error: null };
}

function recordSuccessfulPersistenceTransaction(): void {
    const adaptive = getRecordPersistenceAdaptiveGate();
    if (adaptive.onSuccess()) recordPersistenceGate.notifyCapacityIncrease();
}

function recordFailedPersistenceTransaction(error: unknown): void {
    if (isRecordPersistenceCongestionError(error)) getRecordPersistenceAdaptiveGate().onFailure();
}

function removeSingleFlightGateIfIdle(key: string, gate: FifoConcurrencyGate): void {
    const stats = gate.stats();
    if (stats.active === 0 && stats.pending === 0 && recordSingleFlightGates.get(key) === gate) {
        recordSingleFlightGates.delete(key);
    }
}

export function formatRecordUpdatePoolDetail(
    snapshot: ConcurrencyGateSnapshot | RecordPersistenceConcurrencySnapshot,
    queueWaitMs?: number,
): string {
    let out = `active=${snapshot.active} pending=${snapshot.pending} limit=${snapshot.limit}`;
    if ("current" in snapshot) {
        out += ` current=${snapshot.current} max=${snapshot.max} min=${snapshot.min}`;
        out += ` successes=${snapshot.successes} failures=${snapshot.failures}`;
    }
    if (queueWaitMs !== undefined) out += ` queueWaitMs=${queueWaitMs}ms`;
    return out;
}

export async function acquireRecordSingleFlightPermit(
    conversationId: string,
    options: Pick<RecordGateAcquireOptions, "isCancelled" | "isSettled" | "onProgress"> = {},
): Promise<{ permit: ConcurrencyGatePermit; release: () => void }> {
    const key = conversationId;
    let gate = recordSingleFlightGates.get(key);
    if (!gate) {
        gate = new FifoConcurrencyGate(() => 1);
        recordSingleFlightGates.set(key, gate);
    }
    const waitingSnapshot = gate.stats();
    options.onProgress?.({
        stage: "等待同一 Record 更新",
        detail: `等待同一 Record single-flight | ${formatRecordUpdatePoolDetail(waitingSnapshot)}`,
    });
    try {
        const permit = await gate.acquire({
            shouldCancel: () => Boolean(options.isCancelled?.() || options.isSettled?.()),
            cancelMessage: "record single-flight cancelled",
        });
        options.onProgress?.({
            stage: "同一 Record 更新",
            detail: `已获取同一 Record single-flight | ${formatRecordUpdatePoolDetail(permit.snapshot, permit.queueWaitMs)}`,
        });
        return {
            permit,
            release: () => {
                permit.release();
                removeSingleFlightGateIfIdle(key, gate);
            },
        };
    } catch (error) {
        removeSingleFlightGateIfIdle(key, gate);
        const reason = getRecordTaskAbortReason(options);
        if (reason) throw new RecordSingleFlightAbortError(reason, gate.stats());
        throw error;
    }
}

export async function acquireRecordPersistencePermit(options: RecordGateAcquireOptions): Promise<RecordUpdateSharedPermit> {
    const waitingSnapshot = recordPersistenceStats();
    options.onProgress?.({
        stage: options.waitingStage,
        detail: `${options.waitingDetail} | ${formatRecordUpdatePoolDetail(waitingSnapshot)}`,
    });
    try {
        const permit = await recordPersistenceGate.acquire({
            shouldCancel: () => Boolean(options.isCancelled?.() || options.isSettled?.()),
            cancelMessage: "record update shared gate cancelled",
        });
        const snapshot = recordPersistenceStats();
        options.onProgress?.({
            stage: options.acquiredStage,
            detail: `${options.acquiredDetail} | ${formatRecordUpdatePoolDetail(snapshot, permit.queueWaitMs)}`,
        });
        return { ...permit, snapshot };
    } catch (error) {
        const reason = getRecordTaskAbortReason(options);
        if (reason) throw new RecordUpdatePoolAbortError(reason, recordPersistenceStats());
        throw error;
    }
}

export async function withRecordUpdateSharedPermit<T>(
    options: RecordGateAcquireOptions,
    operation: (permit: RecordUpdateSharedPermit) => Promise<T>,
): Promise<{ value: T; permit: RecordUpdateSharedPermit }> {
    const permit = await acquireRecordPersistencePermit(options);
    try {
        const value = await operation(permit);
        recordSuccessfulPersistenceTransaction();
        return { value, permit };
    } catch (error) {
        recordFailedPersistenceTransaction(error);
        throw error;
    } finally {
        permit.release();
    }
}

export async function withRecordPersistenceWrite<T>(
    operation: (permit: RecordUpdateSharedPermit) => Promise<T>,
    options: Partial<RecordGateAcquireOptions> = {},
): Promise<T> {
    const result = await withRecordUpdateSharedPermit({
        waitingStage: options.waitingStage || "等待 Record 写入许可",
        acquiredStage: options.acquiredStage || "写入 Record",
        waitingDetail: options.waitingDetail || "等待 Record 持久化写入许可",
        acquiredDetail: options.acquiredDetail || "已获取 Record 持久化写入许可",
        isCancelled: options.isCancelled,
        isSettled: options.isSettled,
        onProgress: options.onProgress,
    }, operation);
    return result.value;
}

export const __recordUpdateCoordinationTest = {
    persistenceStats(): RecordPersistenceConcurrencySnapshot {
        return recordPersistenceStats();
    },
    resetPersistencePeak(): void {
        recordPersistenceGate.resetPeakForTest();
    },
    acquirePersistenceGate(options: ConcurrencyGateAcquireOptions = {}): Promise<ConcurrencyGatePermit> {
        return recordPersistenceGate.acquire(options);
    },
    singleFlightStats(conversationId: string): ConcurrencyGateSnapshot | null {
        return recordSingleFlightGates.get(conversationId)?.stats() || null;
    },
    singleFlightGateCount(): number {
        return recordSingleFlightGates.size;
    },
};
