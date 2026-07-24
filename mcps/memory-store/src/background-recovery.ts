import crypto from "node:crypto";
import type { RecordSchedulerAdmissionReceipt } from "./record-scheduler-contracts.js";

export type BackgroundTaskStatus = "running" | "suspended" | "done" | "error" | "cancelled";

export interface BackgroundTaskProgress {
    stage?: string;
    detail?: string;
    current?: number;
    total?: number;
    unit?: string;
    updatedAt?: string;
    stageStartedAt?: string;
}

export type ResumePayloadValue =
    | null
    | boolean
    | number
    | string
    | ResumePayloadValue[]
    | { [key: string]: ResumePayloadValue };

export interface RecordSchedulerTaskEnvelope {
    admission: RecordSchedulerAdmissionReceipt;
    projection?: ResumePayloadValue;
}

export interface RecoveryCandidateTask {
    id: string;
    kind: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    updatedAt: string;
    finishedAt?: string;
    deadlineAt?: string;
    wakeAt?: string;
    waitingReason?: string;
    suspensionRevision?: number;
    suspensionLedgerRevision?: number;
    maxRunMs?: number;
    timedOut?: boolean;
    progress?: BackgroundTaskProgress;
    result?: string;
    error?: string;
    resumePayload?: ResumePayloadValue;
    resumeVersion?: number;
    resumeHash?: string;
    schedulerAdmission?: RecordSchedulerTaskEnvelope;
    recovered?: boolean;
    recoveredFrom?: string;
    recoveredBy?: string;
    recoveredAt?: string;
    ownerPid?: number;
}

export interface RecoveryTaskContext {
    taskId: string;
    updateProgress: (progress: BackgroundTaskProgress) => void;
    isCancelled: () => boolean;
    isSettled: () => boolean;
}

export interface RecoveryHandlerAction {
    mode: "resume" | "restart";
    run: (context: RecoveryTaskContext) => Promise<string>;
    kind?: string;
    maxRunMs?: number;
    timeoutMessage?: string;
}

export type BackgroundRecoveryHandler = (
    task: RecoveryCandidateTask,
) => Promise<RecoveryHandlerAction | null | undefined> | RecoveryHandlerAction | null | undefined;

export const BACKGROUND_TASK_RESUME_VERSION = 1;

const recoveryHandlers = new Map<string, BackgroundRecoveryHandler>();
const MAX_RESUME_PAYLOAD_BYTES = Number(process.env.MEMORY_STORE_BACKGROUND_RESUME_PAYLOAD_MAX_BYTES || 256 * 1024);
const MAX_RESUME_PAYLOAD_DEPTH = Number(process.env.MEMORY_STORE_BACKGROUND_RESUME_PAYLOAD_MAX_DEPTH || 16);
const MAX_RESUME_PAYLOAD_NODES = Number(process.env.MEMORY_STORE_BACKGROUND_RESUME_PAYLOAD_MAX_NODES || 20_000);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizeResumeValue(
    value: unknown,
    path = "resumePayload",
    depth = 0,
    state: { nodes: number } = { nodes: 0 },
): ResumePayloadValue {
    state.nodes++;
    if (state.nodes > MAX_RESUME_PAYLOAD_NODES) throw new Error(`${path} 节点数超过 ${MAX_RESUME_PAYLOAD_NODES}`);
    if (depth > MAX_RESUME_PAYLOAD_DEPTH) throw new Error(`${path} 深度超过 ${MAX_RESUME_PAYLOAD_DEPTH}`);
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error(`${path} 只允许有限 number`);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) => (
            entry === undefined
                ? null
                : normalizeResumeValue(entry, `${path}[${index}]`, depth + 1, state)
        ));
    }
    if (!isPlainObject(value)) {
        throw new Error(`${path} 只允许 JSON 对象/数组/标量`);
    }

    const normalized: Record<string, ResumePayloadValue> = {};
    for (const key of Object.keys(value).sort()) {
        const entry = value[key];
        if (entry === undefined) continue;
        normalized[key] = normalizeResumeValue(entry, `${path}.${key}`, depth + 1, state);
    }
    return normalized;
}

function stableStringify(value: ResumePayloadValue): string {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry)).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function normalizeResumePayload(payload: unknown): ResumePayloadValue {
    const normalized = normalizeResumeValue(payload);
    const bytes = Buffer.byteLength(stableStringify(normalized), "utf8");
    if (bytes > MAX_RESUME_PAYLOAD_BYTES) {
        throw new Error(`resumePayload 大小 ${bytes} bytes 超过 ${MAX_RESUME_PAYLOAD_BYTES}`);
    }
    return normalized;
}

export function stableJsonStringify(payload: unknown): string {
    return stableStringify(normalizeResumePayload(payload));
}

export function stableJsonHash(payload: unknown): string {
    return crypto.createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

export function registerBackgroundTaskRecoveryHandler(kind: string, handler: BackgroundRecoveryHandler): void {
    recoveryHandlers.set(kind, handler);
}

export function unregisterBackgroundTaskRecoveryHandler(kind: string): void {
    recoveryHandlers.delete(kind);
}

export function getBackgroundTaskRecoveryHandler(kind: string): BackgroundRecoveryHandler | undefined {
    return recoveryHandlers.get(kind);
}

export function listBackgroundTaskRecoveryHandlers(): string[] {
    return Array.from(recoveryHandlers.keys()).sort();
}

export function clearBackgroundTaskRecoveryHandlersForTest(): void {
    recoveryHandlers.clear();
}
