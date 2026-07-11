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
import { deleteRecordSidecar, writeRecordSidecar } from "./record-store.js";

const DEFAULT_RECORD_PERSISTENCE_CONCURRENCY = 8;
const INITIAL_RECORD_PERSISTENCE_CONCURRENCY = 2;
const DEFAULT_RECORD_UPDATE_QUEUE_TIMEOUT_MS = 30 * 60_000;
const RECORD_PERSISTENCE_QUEUE_TIMEOUT_MESSAGE = "record update shared gate timed out";
const RECORD_PERSISTENCE_CONGESTION_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE"]);
const RECORD_READER_SIDECAR = "record_index.json";
const RECORD_READER_REBUILD_SIDECAR = "record_index.rebuild.json";

export type RecordUpdateAbortReason = "cancelled" | "settled" | "timeout";

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
                : reason === "settled"
                    ? "Record 更新在共享池排队时已结算"
                    : "Record 更新在共享池排队时已超时",
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
                : reason === "settled"
                    ? "同一 Record 更新排队时已结算"
                    : "同一 Record 更新排队时已超时",
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

export function getRecordUpdateQueueTimeoutMs(): number {
    return readPositiveIntEnv("MEMORY_STORE_RECORD_UPDATE_QUEUE_TIMEOUT_MS", DEFAULT_RECORD_UPDATE_QUEUE_TIMEOUT_MS);
}

export function getRecordTaskAbortReason(
    options: Pick<RecordGateAcquireOptions, "isCancelled" | "isSettled"> = {},
): Exclude<RecordUpdateAbortReason, "timeout"> | null {
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function invalidateRecordReaderIndex(
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
            timeoutMs: getRecordUpdateQueueTimeoutMs(),
            shouldCancel: () => Boolean(options.isCancelled?.() || options.isSettled?.()),
            cancelMessage: "record single-flight cancelled",
            timeoutMessage: "record single-flight timed out",
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
        if (error instanceof Error && error.message === "record single-flight timed out") {
            throw new RecordSingleFlightAbortError("timeout", gate.stats());
        }
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
            timeoutMs: getRecordUpdateQueueTimeoutMs(),
            shouldCancel: () => Boolean(options.isCancelled?.() || options.isSettled?.()),
            cancelMessage: "record update shared gate cancelled",
            timeoutMessage: RECORD_PERSISTENCE_QUEUE_TIMEOUT_MESSAGE,
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
        if (error instanceof Error && error.message === RECORD_PERSISTENCE_QUEUE_TIMEOUT_MESSAGE) {
            throw new RecordUpdatePoolAbortError("timeout", recordPersistenceStats());
        }
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
