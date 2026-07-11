import fs from "node:fs";
import path from "node:path";
import {
    BACKGROUND_TASK_RESUME_VERSION,
    getBackgroundTaskRecoveryHandler,
    normalizeResumePayload,
    stableJsonHash,
    type BackgroundTaskProgress,
    type RecoveryHandlerAction,
    type ResumePayloadValue,
} from "./background-recovery.js";
import { DATA_ROOT, writeJsonAtomic } from "./store.js";

export {
    BACKGROUND_TASK_RESUME_VERSION,
    type BackgroundTaskProgress,
    clearBackgroundTaskRecoveryHandlersForTest,
    getBackgroundTaskRecoveryHandler,
    listBackgroundTaskRecoveryHandlers,
    normalizeResumePayload,
    registerBackgroundTaskRecoveryHandler,
    stableJsonHash,
    stableJsonStringify,
    unregisterBackgroundTaskRecoveryHandler,
} from "./background-recovery.js";

export type BackgroundTaskStatus = "running" | "done" | "error" | "cancelled";

export interface BackgroundTask {
    id: string;
    kind: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    updatedAt: string;
    finishedAt?: string;
    deadlineAt?: string;
    maxRunMs?: number;
    timedOut?: boolean;
    progress?: BackgroundTaskProgress;
    result?: string;
    error?: string;
    resumePayload?: ResumePayloadValue;
    resumeVersion?: number;
    resumeHash?: string;
    recovered?: boolean;
    recoveredFrom?: string;
    recoveredBy?: string;
    recoveredAt?: string;
    ownerPid?: number;
}

export interface BackgroundTaskContext {
    taskId: string;
    updateProgress: (progress: BackgroundTaskProgress) => void;
    isCancelled: () => boolean;
    /** 任务是否已结算（done/error/超时/cancelled 任一）。长任务在「写回前」自查，避免超时后仍幽灵写回。 */
    isSettled: () => boolean;
}

export interface BackgroundTaskOptions {
    maxRunMs?: number;
    timeoutMessage?: string;
    resumePayload?: unknown;
    resumeVersion?: number;
    resumeHash?: string;
}

const tasks = new Map<string, BackgroundTask>();
const DEFAULT_TTL_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_TTL || 30 * 60 * 1000);
const DEFAULT_MAX_RUN_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_MAX_RUN_MS || 15 * 60 * 1000);
const DEFAULT_BACKGROUND_CONCURRENCY = Number(
    process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY
    || process.env.MEMORY_STORE_BACKGROUND_MAX_CONCURRENCY
    || 2,
);
const DEFAULT_RECORD_BATCH_UPDATE_LANE_CONCURRENCY = Number(
    process.env.MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_CONCURRENCY
    || Math.max(
        4,
        Number.isFinite(DEFAULT_BACKGROUND_CONCURRENCY) && DEFAULT_BACKGROUND_CONCURRENCY > 0
            ? Math.floor(DEFAULT_BACKGROUND_CONCURRENCY)
            : 2,
    ),
);

type QueuedBackgroundRun = () => Promise<void>;
type BackgroundTaskLaneName = "default" | "recordBatchUpdate";

interface BackgroundTaskQueueStats {
    active: number;
    pending: number;
}

interface BackgroundTaskQueueLaneStats {
    default: BackgroundTaskQueueStats;
    recordBatchUpdate: BackgroundTaskQueueStats;
}

interface QueuedBackgroundTask {
    lane: BackgroundTaskLaneName;
    run: QueuedBackgroundRun;
}

function normalizeConcurrencyLimit(value: number, fallback: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

class BackgroundTaskQueue {
    private active = 0;
    private readonly pending: QueuedBackgroundTask[] = [];
    private readonly activeByLane = new Map<BackgroundTaskLaneName, number>();
    private readonly pendingByLane = new Map<BackgroundTaskLaneName, number>();

    constructor(private readonly limits: Record<BackgroundTaskLaneName, number>) {
        for (const lane of Object.keys(limits) as BackgroundTaskLaneName[]) {
            this.activeByLane.set(lane, 0);
            this.pendingByLane.set(lane, 0);
        }
    }

    get activeCount(): number {
        return this.active;
    }

    get pendingCount(): number {
        return this.pending.length;
    }

    get laneStats(): BackgroundTaskQueueLaneStats {
        return {
            default: {
                active: this.activeByLane.get("default") || 0,
                pending: this.pendingByLane.get("default") || 0,
            },
            recordBatchUpdate: {
                active: this.activeByLane.get("recordBatchUpdate") || 0,
                pending: this.pendingByLane.get("recordBatchUpdate") || 0,
            },
        };
    }

    enqueue(lane: BackgroundTaskLaneName, run: QueuedBackgroundRun): void {
        this.pending.push({ lane, run });
        this.pendingByLane.set(lane, (this.pendingByLane.get(lane) || 0) + 1);
        this.drain();
    }

    resetForTest(): void {
        this.active = 0;
        this.pending.length = 0;
        for (const lane of this.activeByLane.keys()) {
            this.activeByLane.set(lane, 0);
            this.pendingByLane.set(lane, 0);
        }
    }

    private drain(): void {
        while (this.pending.length > 0) {
            const nextIndex = this.pending.findIndex(item => this.canRunLane(item.lane));
            if (nextIndex < 0) return;
            const [{ lane, run }] = this.pending.splice(nextIndex, 1);
            this.active++;
            this.pendingByLane.set(lane, Math.max(0, (this.pendingByLane.get(lane) || 0) - 1));
            this.activeByLane.set(lane, (this.activeByLane.get(lane) || 0) + 1);
            void run().finally(() => {
                this.active = Math.max(0, this.active - 1);
                this.activeByLane.set(lane, Math.max(0, (this.activeByLane.get(lane) || 0) - 1));
                this.drain();
            });
        }
    }

    private canRunLane(lane: BackgroundTaskLaneName): boolean {
        const limit = normalizeConcurrencyLimit(this.limits[lane], 1);
        return (this.activeByLane.get(lane) || 0) < limit;
    }
}

function getBackgroundTaskLane(kind: string): BackgroundTaskLaneName {
    return kind === "record-batch-update" ? "recordBatchUpdate" : "default";
}

const backgroundQueue = new BackgroundTaskQueue(
    {
        default: normalizeConcurrencyLimit(DEFAULT_BACKGROUND_CONCURRENCY, 2),
        recordBatchUpdate: normalizeConcurrencyLimit(DEFAULT_RECORD_BATCH_UPDATE_LANE_CONCURRENCY, 4),
    },
);

export function getBackgroundTaskQueueStatsForTest(): { active: number; pending: number } {
    return { active: backgroundQueue.activeCount, pending: backgroundQueue.pendingCount };
}

export function getBackgroundTaskQueueLaneStatsForTest(): BackgroundTaskQueueLaneStats {
    return backgroundQueue.laneStats;
}

export function resetBackgroundTaskQueueForTest(): void {
    backgroundQueue.resetForTest();
}

// ============= 文件持久化（跨进程可见） =============
// 内存 Map 仍是「本进程活任务」的真相源；这里叠一层文件态，让同机同 DATA_ROOT
// 的另一个进程也能查到任务状态（A 源拿 taskId、B 源查得到；进程重启后历史可见）。
// 边界：仅解决「同机、同 DATA_ROOT、不同进程」可见；活任务会在进度、取消检查和 settle 前
// 同步文件终态，因此同 DATA_ROOT 的另一进程可查询并取消任务。

const TASKS_DIR = path.join(DATA_ROOT, "tasks");
const DEFAULT_CLEAN_OLD_TASK_DAYS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_CLEANUP_DAYS || 15);
const MAX_TASK_FILE_BYTES = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_FILE_MAX_BYTES || 2 * 1024 * 1024);
const RECOVERY_ORPHAN_GRACE_MS = Number(process.env.MEMORY_STORE_BACKGROUND_RECOVERY_ORPHAN_GRACE_MS || 30_000);
const RECOVERY_CLAIM_TTL_MS = Number(process.env.MEMORY_STORE_BACKGROUND_RECOVERY_CLAIM_TTL_MS || 10 * 60 * 1000);
// 进度落盘节流间隔：高频 updateProgress 不必每次写盘，~1s 落一次即可。
const PERSIST_THROTTLE_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_PERSIST_THROTTLE_MS || 1000);
// 孤儿陈旧判定的额外宽限倍数：文件态 running 但 updatedAt 距今超过 maxRunMs × 此倍数，
// 视为「进程已退出/超时、状态陈旧」，转 error。倍数 >1 留足余量，避免误杀慢任务。
const STALE_FACTOR = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_STALE_FACTOR || 1.5);
// 即便 maxRunMs=0（不限时）或异常，也至少给一个保守的兜底陈旧阈值。
const STALE_FLOOR_MS = Number(process.env.MEMORY_STORE_BACKGROUND_TASK_STALE_FLOOR_MS || 60 * 60 * 1000);
const TERMINAL_TASK_STATUSES = new Set<BackgroundTaskStatus>(["done", "error", "cancelled"]);
const BACKGROUND_TASK_STATUSES = new Set<BackgroundTaskStatus>(["running", "done", "error", "cancelled"]);
const BACKGROUND_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export interface BackgroundTaskRecoveryResult {
    outcome: "loaded" | "resumed" | "restarted" | "error" | "claimed" | "ignored";
    taskId: string;
    kind: string;
    task: BackgroundTask | null;
    recoveredTaskId?: string;
    reason?: string;
}

export interface BackgroundTaskRecoveryEligibility {
    recoverable: boolean;
    reason?: string;
}

export interface ScanOrphanedTasksSummary {
    scanned: number;
    loaded: number;
    resumed: number;
    restarted: number;
    errored: number;
    claimed: number;
    ignored: number;
    results: BackgroundTaskRecoveryResult[];
}

export interface CleanOldTasksSummary {
    deletedTaskIds: string[];
    preservedTaskIds: string[];
    keptRunningTaskIds: string[];
    invalidTaskFiles: string[];
    deletedDanglingPreserveFiles: string[];
    deletedDanglingClaimFiles: string[];
    deletedDanglingRecoveryFiles: string[];
}

// 记录每个任务上次落盘时间戳，用于进度节流（settle 时无视此节流强制落盘）。
const lastPersistMs = new Map<string, number>();

function taskFilePath(taskId: string): string {
    return path.join(TASKS_DIR, `${taskId}.json`);
}

export function isValidBackgroundTaskId(taskId: string): boolean {
    return BACKGROUND_TASK_ID_PATTERN.test(taskId);
}

function taskPreservePath(taskId: string): string {
    return path.join(TASKS_DIR, `${taskId}.preserve`);
}

function taskClaimPath(taskId: string): string {
    return path.join(TASKS_DIR, `${taskId}.claim`);
}

function loadTaskIntoMemory(task: BackgroundTask): BackgroundTask {
    tasks.set(task.id, task);
    const updatedMs = new Date(task.updatedAt).getTime();
    if (Number.isFinite(updatedMs)) lastPersistMs.set(task.id, updatedMs);
    return task;
}

function prepareResumeMetadata(options: BackgroundTaskOptions): Pick<BackgroundTask, "resumePayload" | "resumeVersion" | "resumeHash"> {
    const hasPayload = options.resumePayload !== undefined;
    const hasVersion = options.resumeVersion !== undefined;
    const hasHash = options.resumeHash !== undefined;
    if (!hasPayload && !hasVersion && !hasHash) return {};
    if (!hasPayload) {
        throw new Error("resumeVersion/resumeHash 需要与 resumePayload 一起提供");
    }
    const resumePayload = normalizeResumePayload(options.resumePayload);
    const resumeVersion = options.resumeVersion ?? BACKGROUND_TASK_RESUME_VERSION;
    if (!Number.isInteger(resumeVersion) || resumeVersion <= 0) {
        throw new Error("resumeVersion 必须是正整数");
    }
    const computedHash = stableJsonHash(resumePayload);
    if (options.resumeHash && options.resumeHash !== computedHash) {
        throw new Error("resumeHash 与 resumePayload 的稳定 JSON hash 不一致");
    }
    return {
        resumePayload,
        resumeVersion,
        resumeHash: computedHash,
    };
}

/** 把任务最新态原子落盘。任何 IO 异常都吞掉——持久化是「尽力而为」，绝不影响任务主流程。 */
function persistTask(task: BackgroundTask): void {
    try {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        writeJsonAtomic(taskFilePath(task.id), task);
        lastPersistMs.set(task.id, Date.now());
    } catch {
        // 落盘失败不致命：内存态仍是本进程真相源，下次 settle/进度还会再试。
    }
}

/** 进度落盘：按 PERSIST_THROTTLE_MS 节流，避免高频 updateProgress 打爆磁盘。 */
function persistTaskThrottled(task: BackgroundTask): void {
    const last = lastPersistMs.get(task.id) || 0;
    if (Date.now() - last < PERSIST_THROTTLE_MS) return;
    persistTask(task);
}

/** 从文件读取任务态（跨进程兜底）。文件不存在或解析失败均返回 null。 */
function readPersistedTask(taskId: string): BackgroundTask | null {
    try {
        const stats = fs.statSync(taskFilePath(taskId));
        if (!stats.isFile() || stats.size > MAX_TASK_FILE_BYTES) return null;
        const raw = fs.readFileSync(taskFilePath(taskId), "utf-8");
        const parsed = JSON.parse(raw) as BackgroundTask;
        if (
            parsed
            && parsed.id === taskId
            && typeof parsed.kind === "string"
            && BACKGROUND_TASK_STATUSES.has(parsed.status)
            && typeof parsed.startedAt === "string"
            && typeof parsed.updatedAt === "string"
        ) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 若另一进程已把同 taskId 写成 settled/cancelled，这里把本进程内存态同步到最新终态。
 * 只接收终态，避免用文件态 running 覆盖本进程更鲜活的内存进度。
 */
function syncTaskFromPersistedState(task: BackgroundTask): boolean {
    const persisted = readPersistedTask(task.id);
    if (!persisted || !TERMINAL_TASK_STATUSES.has(persisted.status)) return false;
    if (
        task.status === persisted.status
        && task.updatedAt === persisted.updatedAt
        && task.finishedAt === persisted.finishedAt
        && task.result === persisted.result
        && task.error === persisted.error
    ) {
        return false;
    }
    task.status = persisted.status;
    task.updatedAt = persisted.updatedAt || task.updatedAt;
    task.finishedAt = persisted.finishedAt ?? task.finishedAt;
    task.deadlineAt = persisted.deadlineAt ?? task.deadlineAt;
    task.maxRunMs = persisted.maxRunMs ?? task.maxRunMs;
    task.timedOut = persisted.timedOut;
    task.progress = persisted.progress ?? task.progress;
    task.result = persisted.result;
    task.error = persisted.error;
    return true;
}

/**
 * 孤儿陈旧判定：文件态 status=running 的任务在本进程没有对应定时器/协程，
 * 若它由一个已退出/崩溃的进程留下，会永远卡在 running 永不 settle。
 * 这里在「读到文件态 running」时，若 updatedAt 距今超过 STALE_MS（该 kind 的 maxRunMs × 余量），
 * 就把它当 error 返回，避免「查不到」恶化成「永远卡 running」。
 * 注意：内存优先已保证「本进程仍在跑的活任务」走内存态，不会被这里误杀。
 */
function reconcileStaleTask(task: BackgroundTask): BackgroundTask {
    if (task.status !== "running") return task;
    const baseMaxRun = task.maxRunMs && task.maxRunMs > 0 ? task.maxRunMs : getBackgroundTaskMaxRunMs(task.kind);
    const staleMs = Math.max(baseMaxRun * STALE_FACTOR, STALE_FLOOR_MS);
    const updatedMs = new Date(task.updatedAt).getTime();
    if (!Number.isFinite(updatedMs)) return task;
    if (Date.now() - updatedMs <= staleMs) return task;
    return {
        ...task,
        status: "error",
        timedOut: true,
        error: task.error || "任务进程已退出或超时，状态陈旧（孤儿任务）",
        finishedAt: task.finishedAt || nowIso(),
    };
}

function validateRecoverableTask(task: BackgroundTask): { ok: true } | { ok: false; reason: string } {
    if (task.resumePayload === undefined || task.resumeVersion === undefined || task.resumeHash === undefined) {
        return { ok: false, reason: "缺少 resumePayload/resumeVersion/resumeHash，不能安全恢复" };
    }
    if (task.resumeVersion !== BACKGROUND_TASK_RESUME_VERSION) {
        return { ok: false, reason: `resumeVersion=${task.resumeVersion} 不受当前实现支持` };
    }
    try {
        const normalized = normalizeResumePayload(task.resumePayload);
        const computedHash = stableJsonHash(normalized);
        if (computedHash !== task.resumeHash) {
            return { ok: false, reason: "resumeHash 校验失败" };
        }
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true };
}

function tryClaimRecovery(taskId: string): (() => void) | null {
    const claimPath = taskClaimPath(taskId);
    const tryCreate = (): (() => void) | null => {
        let fd: number | undefined;
        try {
            fs.mkdirSync(TASKS_DIR, { recursive: true });
            fd = fs.openSync(claimPath, "wx");
            fs.writeFileSync(fd, JSON.stringify({ taskId, pid: process.pid, claimedAt: nowIso() }, null, 2), "utf8");
            fs.closeSync(fd);
            fd = undefined;
            return () => {
                try {
                    fs.rmSync(claimPath, { force: true });
                } catch {
                    // ignore
                }
            };
        } catch {
            if (fd !== undefined) {
                try {
                    fs.closeSync(fd);
                } catch {
                    // ignore
                }
            }
            return null;
        }
    };
    const created = tryCreate();
    if (created) return created;
    try {
        const claim = JSON.parse(fs.readFileSync(claimPath, "utf8")) as { pid?: number; claimedAt?: string };
        const claimedAtMs = Date.parse(claim.claimedAt || "");
        const expired = !Number.isFinite(claimedAtMs) || Date.now() - claimedAtMs > RECOVERY_CLAIM_TTL_MS;
        const ownerDead = typeof claim.pid === "number" && claim.pid > 0 ? !isProcessAlive(claim.pid) : true;
        if (!expired && !ownerDead) return null;
        fs.rmSync(claimPath, { force: true });
        return tryCreate();
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isTaskStaleForRecovery(task: BackgroundTask): boolean {
    const updatedMs = Date.parse(task.updatedAt);
    if (!Number.isFinite(updatedMs)) return true;
    const baseMaxRun = task.maxRunMs && task.maxRunMs > 0 ? task.maxRunMs : getBackgroundTaskMaxRunMs(task.kind);
    const staleMs = Math.max(RECOVERY_ORPHAN_GRACE_MS, baseMaxRun * STALE_FACTOR, STALE_FLOOR_MS);
    return Date.now() - updatedMs > staleMs;
}

function shouldRecoverRunningTask(task: BackgroundTask): { ok: true } | { ok: false; reason: string } {
    if (typeof task.ownerPid === "number" && isProcessAlive(task.ownerPid) && !isTaskStaleForRecovery(task)) {
        return { ok: false, reason: `原任务进程 PID=${task.ownerPid} 仍存活，跳过重复恢复` };
    }
    if (task.ownerPid === undefined) {
        if (!isTaskStaleForRecovery(task)) {
            return { ok: false, reason: "legacy running 任务缺少 ownerPid，达到保守陈旧阈值前不自动恢复" };
        }
    }
    return { ok: true };
}

export function inspectBackgroundTaskRecovery(task: BackgroundTask): BackgroundTaskRecoveryEligibility {
    if (task.status !== "running") return { recoverable: false, reason: `任务状态为 ${task.status}` };
    const liveness = shouldRecoverRunningTask(task);
    if (!liveness.ok) return { recoverable: false, reason: liveness.reason };
    const validation = validateRecoverableTask(task);
    if (!validation.ok) return { recoverable: false, reason: validation.reason };
    if (!getBackgroundTaskRecoveryHandler(task.kind)) {
        return { recoverable: false, reason: `未注册 kind=${task.kind} 的恢复 handler` };
    }
    return { recoverable: true };
}

function settleTaskAsError(
    task: BackgroundTask,
    error: string,
    extra: Partial<Pick<BackgroundTask, "recovered" | "recoveredBy" | "recoveredAt" | "timedOut">> = {},
): BackgroundTask {
    const updatedAt = nowIso();
    const nextTask: BackgroundTask = {
        ...task,
        ...extra,
        status: "error",
        error,
        result: undefined,
        finishedAt: updatedAt,
        updatedAt,
        deadlineAt: undefined,
    };
    persistTask(loadTaskIntoMemory(nextTask));
    return nextTask;
}

function nowIso(): string {
    return new Date().toISOString();
}

function makeTaskId(kind: string): string {
    return `${kind}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function getBackgroundTaskMaxRunMs(kind: string): number {
    const key = `MEMORY_STORE_${kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BACKGROUND_MAX_RUN_MS`;
    const value = Number(process.env[key]);
    if (Number.isFinite(value) && value > 0) return value;
    if (kind === "record-update") {
        const recordValue = Number(process.env.MEMORY_STORE_RECORD_UPDATE_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(recordValue) && recordValue > 0 ? recordValue : 60 * 60 * 1000;
    }
    if (kind === "record-batch-update") {
        const batchValue = Number(process.env.MEMORY_STORE_RECORD_BATCH_UPDATE_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(batchValue) && batchValue > 0 ? batchValue : 60 * 60 * 1000;
    }
    if (kind === "conversation-batch-export") {
        const exportValue = Number(process.env.MEMORY_STORE_CONVERSATION_BATCH_EXPORT_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(exportValue) && exportValue > 0 ? exportValue : 30 * 60 * 1000;
    }
    if (kind === "stage-guard-check") {
        const guardValue = Number(process.env.MEMORY_STORE_STAGE_GUARD_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(guardValue) && guardValue > 0 ? guardValue : 15 * 60 * 1000;
    }
    if (kind === "golden-extract") {
        const goldenValue = Number(process.env.MEMORY_STORE_GOLDEN_EXTRACT_BACKGROUND_MAX_RUN_MS);
        return Number.isFinite(goldenValue) && goldenValue > 0 ? goldenValue : 15 * 60 * 1000;
    }
    return DEFAULT_MAX_RUN_MS;
}

function cleanupExpiredTasksFromMemory(): void {
    const now = Date.now();
    for (const [id, task] of tasks) {
        if (task.status === "running") continue;
        const updatedMs = new Date(task.updatedAt).getTime();
        if (Number.isFinite(updatedMs) && now - updatedMs > DEFAULT_TTL_MS) {
            tasks.delete(id);
            lastPersistMs.delete(id);
            // 这里只逐出内存缓存；落盘历史统一由 cleanOldTasks 的 15 天策略和 .preserve 规则管理。
        }
    }
}

function scheduleBackgroundTask(
    task: BackgroundTask,
    run: (context: BackgroundTaskContext) => Promise<string>,
    options: BackgroundTaskOptions = {},
    onSettled?: () => void,
): BackgroundTask {
    cleanupExpiredTasksFromMemory();
    loadTaskIntoMemory(task);
    persistTask(task);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const syncSharedTaskState = (): void => {
        const changed = syncTaskFromPersistedState(task);
        if (!changed || task.status === "running") return;
        settled = true;
        if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
        }
    };

    const updateProgress = (progress: BackgroundTaskProgress) => {
        syncSharedTaskState();
        if (task.status !== "running") return;
        const updatedAt = nowIso();
        const previous = task.progress;
        const stageChanged = progress.stage !== undefined && progress.stage !== previous?.stage;
        const progressShapeChanged = progress.total !== undefined && previous?.total !== undefined && progress.total !== previous.total;
        task.progress = {
            ...(previous || {}),
            ...progress,
            stageStartedAt: progress.stageStartedAt
                || (stageChanged || progressShapeChanged ? updatedAt : previous?.stageStartedAt)
                || updatedAt,
            updatedAt,
        };
        task.updatedAt = updatedAt;
        persistTaskThrottled(task);
    };

    const settle = (status: Exclude<BackgroundTaskStatus, "running">, payload: { result?: string; error?: string; timedOut?: boolean }) => {
        syncSharedTaskState();
        if (settled || task.status !== "running") return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        task.status = status;
        task.result = payload.result;
        task.error = payload.error;
        task.timedOut = payload.timedOut;
        task.finishedAt = nowIso();
        task.updatedAt = task.finishedAt;
        persistTask(task);
    };

    backgroundQueue.enqueue(getBackgroundTaskLane(task.kind), async () => {
        try {
            syncSharedTaskState();
            if (task.status !== "running") return;
            const maxRunMs = task.maxRunMs ?? options.maxRunMs ?? getBackgroundTaskMaxRunMs(task.kind);
            task.maxRunMs = maxRunMs;
            if (maxRunMs > 0) {
                task.deadlineAt = new Date(Date.now() + maxRunMs).toISOString();
                timeout = setTimeout(() => {
                    settle("error", {
                        timedOut: true,
                        error: options.timeoutMessage || `后台任务超时（${Math.round(maxRunMs / 1000)}s）`,
                    });
                }, maxRunMs);
                if (typeof (timeout as { unref?: () => void }).unref === "function") {
                    (timeout as { unref: () => void }).unref();
                }
            }
            const context: BackgroundTaskContext = {
                taskId: task.id,
                updateProgress,
                isCancelled: () => {
                    syncSharedTaskState();
                    return task.status === "cancelled";
                },
                isSettled: () => {
                    syncSharedTaskState();
                    return task.status !== "running";
                },
            };
            updateProgress({ stage: "running", detail: task.recovered ? "后台任务恢复后继续执行" : "后台任务已开始执行" });
            if (task.status !== "running") return;
            persistTask(task);
            const result = await run(context);
            settle("done", { result });
        } catch (err) {
            settle("error", { error: err instanceof Error ? err.message : String(err) });
        } finally {
            onSettled?.();
        }
    });

    return task;
}

function resumeBackgroundTaskWithSameId(
    persistedTask: BackgroundTask,
    action: RecoveryHandlerAction,
    releaseClaim: () => void,
): BackgroundTask {
    const updatedAt = nowIso();
    const resumedTask: BackgroundTask = {
        ...persistedTask,
        status: "running",
        updatedAt,
        finishedAt: undefined,
        deadlineAt: undefined,
        timedOut: undefined,
        result: undefined,
        error: undefined,
        recovered: true,
        recoveredAt: updatedAt,
        ownerPid: process.pid,
        maxRunMs: action.maxRunMs ?? persistedTask.maxRunMs ?? getBackgroundTaskMaxRunMs(persistedTask.kind),
        progress: {
            ...(persistedTask.progress || {}),
            stage: persistedTask.progress?.stage || "recovered",
            detail: "后台任务已恢复，等待队列调度",
            updatedAt,
            stageStartedAt: updatedAt,
        },
    };
    return scheduleBackgroundTask(resumedTask, action.run, {
        maxRunMs: resumedTask.maxRunMs,
        timeoutMessage: action.timeoutMessage,
        resumePayload: resumedTask.resumePayload,
        resumeVersion: resumedTask.resumeVersion,
        resumeHash: resumedTask.resumeHash,
    }, releaseClaim);
}

export function startBackgroundTask(
    kind: string,
    run: (context: BackgroundTaskContext) => Promise<string>,
    options: BackgroundTaskOptions = {},
): BackgroundTask {
    const maxRunMs = options.maxRunMs ?? getBackgroundTaskMaxRunMs(kind);
    const startedAtMs = Date.now();
    const resume = prepareResumeMetadata(options);
    const task: BackgroundTask = {
        id: makeTaskId(kind),
        kind,
        status: "running",
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: new Date(startedAtMs).toISOString(),
        maxRunMs,
        progress: {
            stage: "queued",
            detail: "等待后台任务队列调度",
            updatedAt: new Date(startedAtMs).toISOString(),
            stageStartedAt: new Date(startedAtMs).toISOString(),
        },
        ...resume,
        ownerPid: process.pid,
    };
    return scheduleBackgroundTask(task, run, options);
}

export function getBackgroundTask(taskId: string): BackgroundTask | null {
    if (!isValidBackgroundTaskId(taskId)) return null;
    cleanupExpiredTasksFromMemory();
    // 内存优先：本进程的活任务（含 running 的真活任务）以内存态为真相源，不会被孤儿判定误杀。
    const inMemory = tasks.get(taskId);
    if (inMemory) {
        syncTaskFromPersistedState(inMemory);
        return inMemory;
    }
    // 文件兜底：本进程没有 → 可能是另一进程创建的任务，或本进程重启前的历史任务。
    const persisted = readPersistedTask(taskId);
    if (!persisted) return null;
    // 文件态 running 的孤儿任务（无对应定时器/协程、永不 settle）按陈旧判定转 error。
    return reconcileStaleTask(persisted);
}

export function cleanOldTasks(maxAgeDays = DEFAULT_CLEAN_OLD_TASK_DAYS): CleanOldTasksSummary {
    const summary: CleanOldTasksSummary = {
        deletedTaskIds: [],
        preservedTaskIds: [],
        keptRunningTaskIds: [],
        invalidTaskFiles: [],
        deletedDanglingPreserveFiles: [],
        deletedDanglingClaimFiles: [],
        deletedDanglingRecoveryFiles: [],
    };
    if (!fs.existsSync(TASKS_DIR)) return summary;

    const now = Date.now();
    const maxAgeMs = Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(TASKS_DIR)) {
        if (!entry.endsWith(".json")) continue;
        const taskId = entry.slice(0, -5);
        const task = readPersistedTask(taskId);
        if (!task) {
            summary.invalidTaskFiles.push(entry);
            continue;
        }
        if (task.status === "running") {
            summary.keptRunningTaskIds.push(taskId);
            continue;
        }
        if (fs.existsSync(taskPreservePath(taskId))) {
            summary.preservedTaskIds.push(taskId);
            continue;
        }
        const updatedMs = new Date(task.updatedAt).getTime();
        if (!Number.isFinite(updatedMs) || now - updatedMs <= maxAgeMs) continue;
        try {
            fs.rmSync(taskFilePath(taskId), { force: true });
            fs.rmSync(taskClaimPath(taskId), { force: true });
            fs.rmSync(path.join(TASKS_DIR, `${taskId}.guard-pass`), { force: true });
            tasks.delete(taskId);
            lastPersistMs.delete(taskId);
            summary.deletedTaskIds.push(taskId);
        } catch {
            summary.invalidTaskFiles.push(entry);
        }
    }
    for (const entry of fs.readdirSync(TASKS_DIR)) {
        if (!entry.endsWith(".preserve")) continue;
        const taskId = entry.slice(0, -9);
        if (fs.existsSync(taskFilePath(taskId))) continue;
        try {
            fs.rmSync(path.join(TASKS_DIR, entry), { force: true });
            summary.deletedDanglingPreserveFiles.push(entry);
        } catch {
            summary.invalidTaskFiles.push(entry);
        }
    }
    for (const entry of fs.readdirSync(TASKS_DIR)) {
        if (!entry.endsWith(".claim")) continue;
        const taskId = entry.slice(0, -6);
        if (fs.existsSync(taskFilePath(taskId))) continue;
        try {
            fs.rmSync(path.join(TASKS_DIR, entry), { force: true });
            summary.deletedDanglingClaimFiles.push(entry);
        } catch {
            summary.invalidTaskFiles.push(entry);
        }
    }
    for (const entry of fs.readdirSync(TASKS_DIR)) {
        if (!entry.endsWith(".guard-pass")) continue;
        const taskId = entry.slice(0, -11);
        if (fs.existsSync(taskFilePath(taskId))) continue;
        try {
            fs.rmSync(path.join(TASKS_DIR, entry), { force: true });
            summary.deletedDanglingRecoveryFiles.push(entry);
        } catch {
            summary.invalidTaskFiles.push(entry);
        }
    }
    return summary;
}

export async function recoverBackgroundTask(taskId: string): Promise<BackgroundTaskRecoveryResult> {
    if (!isValidBackgroundTaskId(taskId)) {
        return {
            outcome: "ignored",
            taskId,
            kind: "unknown",
            task: null,
            reason: "taskId 格式非法",
        };
    }
    const persistedTask = readPersistedTask(taskId);
    if (!persistedTask) {
        return {
            outcome: "ignored",
            taskId,
            kind: "unknown",
            task: null,
            reason: "任务文件不存在或损坏",
        };
    }

    if (persistedTask.status !== "running") {
        return {
            outcome: "loaded",
            taskId,
            kind: persistedTask.kind,
            task: loadTaskIntoMemory(persistedTask),
        };
    }

    const liveness = shouldRecoverRunningTask(persistedTask);
    if (!liveness.ok) {
        return {
            outcome: "ignored",
            taskId,
            kind: persistedTask.kind,
            task: persistedTask,
            reason: liveness.reason,
        };
    }

    const validation = validateRecoverableTask(persistedTask);
    if (!validation.ok) {
        return {
            outcome: "error",
            taskId,
            kind: persistedTask.kind,
            task: settleTaskAsError(persistedTask, `后台任务恢复失败：${validation.reason}`),
            reason: validation.reason,
        };
    }

    const handler = getBackgroundTaskRecoveryHandler(persistedTask.kind);
    if (!handler) {
        const reason = persistedTask.kind.includes("deep-locate")
            ? "deep-locate 任务不支持自动恢复"
            : `未注册 kind=${persistedTask.kind} 的恢复 handler`;
        return {
            outcome: "error",
            taskId,
            kind: persistedTask.kind,
            task: settleTaskAsError(persistedTask, `后台任务恢复失败：${reason}`),
            reason,
        };
    }

    const releaseClaim = tryClaimRecovery(taskId);
    if (!releaseClaim) {
        return {
            outcome: "claimed",
            taskId,
            kind: persistedTask.kind,
            task: getBackgroundTask(taskId),
            reason: "已被其他进程 claim，跳过重复恢复",
        };
    }

    try {
        const latestTask = readPersistedTask(taskId) || persistedTask;
        if (latestTask.status !== "running") {
            return {
                outcome: "loaded",
                taskId,
                kind: latestTask.kind,
                task: loadTaskIntoMemory(latestTask),
            };
        }

        const action = await handler(latestTask);
        if (!action) {
            const reason = `恢复 handler 未返回 action（kind=${latestTask.kind}）`;
            return {
                outcome: "error",
                taskId,
                kind: latestTask.kind,
                task: settleTaskAsError(latestTask, `后台任务恢复失败：${reason}`),
                reason,
            };
        }

        if (action.mode === "resume") {
            const resumedTask = resumeBackgroundTaskWithSameId(latestTask, action, releaseClaim);
            return {
                outcome: "resumed",
                taskId,
                kind: latestTask.kind,
                task: resumedTask,
                recoveredTaskId: resumedTask.id,
            };
        }

        const restartedTask = startBackgroundTask(action.kind || latestTask.kind, action.run, {
            maxRunMs: action.maxRunMs ?? latestTask.maxRunMs,
            timeoutMessage: action.timeoutMessage,
            resumePayload: latestTask.resumePayload,
            resumeVersion: latestTask.resumeVersion,
            resumeHash: latestTask.resumeHash,
        });
        restartedTask.recovered = true;
        restartedTask.recoveredFrom = latestTask.id;
        restartedTask.recoveredAt = nowIso();
        persistTask(restartedTask);
        const oldTask = settleTaskAsError(
            latestTask,
            `后台任务已恢复到新 taskId=${restartedTask.id}`,
            { recovered: true, recoveredBy: restartedTask.id, recoveredAt: restartedTask.recoveredAt },
        );
        return {
            outcome: "restarted",
            taskId,
            kind: latestTask.kind,
            task: oldTask,
            recoveredTaskId: restartedTask.id,
        };
    } catch (error) {
        releaseClaim();
        const reason = error instanceof Error ? error.message : String(error);
        return {
            outcome: "error",
            taskId,
            kind: persistedTask.kind,
            task: settleTaskAsError(persistedTask, `后台任务恢复失败：${reason}`),
            reason,
        };
    } finally {
        const latestTask = readPersistedTask(taskId);
        if (!latestTask || latestTask.status !== "running") {
            releaseClaim();
        }
    }
}

export async function scanOrphanedTasks(): Promise<ScanOrphanedTasksSummary> {
    const summary: ScanOrphanedTasksSummary = {
        scanned: 0,
        loaded: 0,
        resumed: 0,
        restarted: 0,
        errored: 0,
        claimed: 0,
        ignored: 0,
        results: [],
    };
    if (!fs.existsSync(TASKS_DIR)) return summary;

    for (const entry of fs.readdirSync(TASKS_DIR).sort()) {
        if (!entry.endsWith(".json")) continue;
        summary.scanned++;
        const result = await recoverBackgroundTask(entry.slice(0, -5));
        summary.results.push(result);
        if (result.outcome === "loaded") summary.loaded++;
        else if (result.outcome === "resumed") summary.resumed++;
        else if (result.outcome === "restarted") summary.restarted++;
        else if (result.outcome === "error") summary.errored++;
        else if (result.outcome === "claimed") summary.claimed++;
        else summary.ignored++;
    }

    return summary;
}

export function cancelBackgroundTask(taskId: string, reason = "用户取消"): BackgroundTask | null {
    const task = getBackgroundTask(taskId);
    if (!task) return null;
    if (task.status !== "running") return task;
    task.status = "cancelled";
    task.error = reason;
    task.finishedAt = nowIso();
    task.updatedAt = task.finishedAt;
    // 取消态落盘；同 DATA_ROOT 的活任务会在下一次同步检查时感知该终态并停止写回。
    persistTask(task);
    return task;
}

export async function waitForBackgroundTask(taskId: string, waitSeconds = 0): Promise<BackgroundTask | null> {
    const deadline = Date.now() + Math.max(0, Math.min(waitSeconds, 300)) * 1000;
    while (Date.now() < deadline) {
        const task = getBackgroundTask(taskId);
        if (!task || task.status !== "running") return task;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return getBackgroundTask(taskId);
}

function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const restSeconds = Math.ceil(seconds % 60);
    if (minutes < 60) return restSeconds > 0 ? `${minutes}m${restSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function formatProgress(task: BackgroundTask): string[] {
    const progress = task.progress;
    if (!progress) return [];

    const lines: string[] = [];
    if (progress.stage) lines.push(`🔄 阶段: ${progress.stage}`);
    if (progress.total !== undefined && progress.current !== undefined && progress.total > 0) {
        const unit = progress.unit || "项";
        const current = Math.min(Math.max(progress.current, 0), progress.total);
        const percent = ((current / progress.total) * 100).toFixed(1);
        lines.push(`📈 进度: ${current}/${progress.total} ${unit} (${percent}%)`);

        if (current > 0 && current < progress.total) {
            const etaBase = progress.stageStartedAt || task.startedAt;
            const elapsedSeconds = (Date.now() - new Date(etaBase).getTime()) / 1000;
            const etaSeconds = (elapsedSeconds / current) * (progress.total - current);
            lines.push(`⏳ 预计剩余: ${formatDuration(etaSeconds)}`);
        }
    }
    if (progress.detail) lines.push(`🧩 当前: ${progress.detail}`);
    if (progress.updatedAt) lines.push(`🕒 进度更新时间: ${progress.updatedAt}`);
    return lines;
}

export function formatBackgroundTask(task: BackgroundTask | null): string {
    if (!task) return "❌ 未找到后台任务";
    if (task.status === "running") {
        const elapsed = ((Date.now() - new Date(task.startedAt).getTime()) / 1000).toFixed(0);
        return [
            `⏳ 后台任务运行中`,
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            `⏱ 已用: ${elapsed}s`,
            ...formatProgress(task),
            task.deadlineAt ? `⏳ 截止: ${task.deadlineAt}` : "",
        ].filter(Boolean).join("\n");
    }
    if (task.status === "error") {
        return [
            `❌ 后台任务失败`,
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            task.timedOut ? `⏰ timedOut: true` : "",
            task.deadlineAt ? `⏳ 截止: ${task.deadlineAt}` : "",
            `📋 错误: ${task.error || "unknown error"}`,
        ].filter(Boolean).join("\n");
    }
    if (task.status === "cancelled") {
        return [
            `🛑 后台任务已取消`,
            `🆔 taskId: ${task.id}`,
            `📌 类型: ${task.kind}`,
            task.error ? `📋 原因: ${task.error}` : "",
        ].filter(Boolean).join("\n");
    }
    return task.result || `✅ 后台任务完成: ${task.id}`;
}

// ============= 测试专用钩子（仅供单测模拟「另一进程」场景，勿在业务代码使用） =============

/** 把任务从内存 Map 逐出，仅保留文件态——模拟「在另一进程查询该任务」。 */
export function __testEvictFromMemory(taskId: string): void {
    tasks.delete(taskId);
    lastPersistMs.delete(taskId);
}

/** 直接往 tasks/{id}.json 写入一个任意文件态——模拟「另一进程/重启前残留」的孤儿任务。 */
export function __testWritePersistedTask(task: BackgroundTask): void {
    persistTask(task);
}

export function __testHasTaskInMemory(taskId: string): boolean {
    return tasks.has(taskId);
}

export function __testTaskFilePath(taskId: string): string {
    return taskFilePath(taskId);
}

export function __testTaskPreservePath(taskId: string): string {
    return taskPreservePath(taskId);
}

export function __testResetBackgroundTasksForTest(): void {
    tasks.clear();
    lastPersistMs.clear();
    resetBackgroundTaskQueueForTest();
}
