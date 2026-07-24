import {
    ensureRecordSchedulerBackgroundProjection,
    getBackgroundTask,
    type BackgroundTask,
    type BackgroundTaskContext,
    type RecordSchedulerBackgroundTaskOptions,
} from "./background-tasks.js";
import {
    BACKGROUND_TASK_RESUME_VERSION,
    normalizeResumePayload,
    stableJsonHash,
} from "./background-recovery.js";
import {
    calculateRecordSchedulerAdmissionRequestHash,
    createRecordSchedulerLedger,
    createSchedulerLedgerAnchor,
    listRecordSchedulerAdmissionCapsuleTaskIds,
    listRecordSchedulerLedgerTaskIds,
    readRecordSchedulerAdmissionCapsule,
    readRecordSchedulerLedgerStore,
    recordSchedulerLedgerPath,
    verifyOrRecoverTaskAdmission,
    withRecordSchedulerAdmissionNamespaceLock,
    writeRecordSchedulerAdmissionCapsule,
    type PersistedRecordSchedulerLedger,
    type SchedulerLedgerMutationOptions,
} from "./record-scheduler-store.js";
import type {
    RecordSchedulerAdmissionReceipt,
    SchedulerAdmissionBackgroundProjection,
    SchedulerAdmissionIdentity,
    SchedulerAdmissionCapsule,
} from "./record-scheduler-contracts.js";
import { isTerminalTaskState } from "./record-scheduler-contracts.js";

type AdmissionInitialTask = Omit<PersistedRecordSchedulerLedger["task"], "admissionIdentity"> & {
    admissionIdentity?: SchedulerAdmissionIdentity;
};

export type RecordSchedulerAdmissionInitialLedger = Omit<PersistedRecordSchedulerLedger, "task"> & {
    task: AdmissionInitialTask;
};

export interface AdmitRecordSchedulerTaskOptions extends Omit<RecordSchedulerBackgroundTaskOptions, "admissionReceipt" | "resumePayload"> {
    kind: "record-update" | "record-batch-update";
    requestKey: string;
    initialLedger: RecordSchedulerAdmissionInitialLedger;
    immutableRequestSummary: Record<string, unknown>;
    resumePayload: unknown;
    run: (context: BackgroundTaskContext) => Promise<string>;
    replayTerminal?: boolean;
    ledgerMutation?: SchedulerLedgerMutationOptions;
}

export interface AdmittedRecordSchedulerTask {
    outcome: "Admitted" | "Replayed";
    taskId: string;
    task: BackgroundTask;
    admissionReceipt: RecordSchedulerAdmissionReceipt;
}

export interface RecordSchedulerAdmissionUnknownOutcome {
    outcome: "UnknownOutcome";
    admissionIdentity: SchedulerAdmissionIdentity;
    candidateTaskIds: string[];
    reasons: string[];
}

export type AdmitRecordSchedulerTaskResult = AdmittedRecordSchedulerTask | RecordSchedulerAdmissionUnknownOutcome;

type AdmissionIdentityResolution =
    | { kind: "missing" }
    | { kind: "current"; ledger: PersistedRecordSchedulerLedger }
    | { kind: "unknown"; candidateTaskIds: string[]; reasons: string[] };

type AdmissionNamespaceDecision = AdmissionIdentityResolution
    | { kind: "created"; ledger: PersistedRecordSchedulerLedger }
    | { kind: "retry" };

const ADMISSION_CAPSULE_READ_CONCURRENCY = 32;
const ADMISSION_LEDGER_READ_CONCURRENCY = 4;

export class RecordSchedulerAdmissionConflictError extends Error {
    readonly code = "ADMISSION_IDENTITY_CONFLICT";

    constructor(message: string, readonly candidateTaskIds: string[]) {
        super(message);
        this.name = "RecordSchedulerAdmissionConflictError";
    }
}

export async function admitRecordSchedulerTask(options: AdmitRecordSchedulerTaskOptions): Promise<AdmitRecordSchedulerTaskResult> {
    const requestedTaskId = options.initialLedger.task?.taskId;
    if (typeof requestedTaskId !== "string" || requestedTaskId.length === 0) {
        throw new Error("admitRecordSchedulerTask 需要 initialLedger.task.taskId");
    }
    if (options.initialLedger.task.admission?.state !== "LedgerCreated") {
        throw new Error("生产接纳必须从不含 envelope ref 的 LedgerCreated L1 开始");
    }
    if (typeof options.requestKey !== "string"
        || options.requestKey.length === 0
        || options.requestKey.length > 512
        || options.requestKey.trim() !== options.requestKey) {
        throw new Error("admitRecordSchedulerTask 需要稳定、非空且不含首尾空白的 requestKey");
    }
    const expectedRequestMode = options.kind === "record-update" ? "update" : "batch_update";
    if (options.initialLedger.task.requestMode !== expectedRequestMode) {
        throw new Error("task kind 与 initial ledger requestMode 不匹配");
    }

    const requestSummary = normalizeImmutableRequestSummary(options.immutableRequestSummary);
    const backgroundProjection = normalizeAdmissionBackgroundProjection(options);
    const admissionIdentity: SchedulerAdmissionIdentity = {
        requestKey: options.requestKey,
        requestHash: calculateRecordSchedulerAdmissionRequestHash(options.kind, requestSummary, backgroundProjection),
    };
    if (options.initialLedger.task.admissionIdentity
        && !sameAdmissionIdentity(options.initialLedger.task.admissionIdentity, admissionIdentity)) {
        throw new RecordSchedulerAdmissionConflictError(
            "initial ledger 的 admissionIdentity 与 requestKey/真实请求摘要不一致",
            [requestedTaskId],
        );
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const decision = await withRecordSchedulerAdmissionNamespaceLock(async admissionLock => {
            const resolution = await resolveAdmissionIdentity(
                requestedTaskId,
                options.kind,
                admissionIdentity,
                options.replayTerminal !== false,
            );
            if (resolution.kind !== "missing") return resolution;

            const initialLedger = structuredClone(options.initialLedger) as PersistedRecordSchedulerLedger;
            initialLedger.task.admissionIdentity = structuredClone(admissionIdentity);
            try {
                await admissionLock.assertHeld();
                const created = await createRecordSchedulerLedger(initialLedger, options.ledgerMutation);
                return { kind: "created", ledger: created.ledger } satisfies AdmissionNamespaceDecision;
            } catch (error) {
                if ((error as { code?: string }).code === "LEDGER_ALREADY_EXISTS") return { kind: "retry" } satisfies AdmissionNamespaceDecision;
                throw error;
            }
        });
        if (decision.kind === "unknown") {
            return {
                outcome: "UnknownOutcome",
                admissionIdentity,
                candidateTaskIds: decision.candidateTaskIds,
                reasons: decision.reasons,
            };
        }
        if (decision.kind === "current") {
            return continueRecordSchedulerAdmission(
                decision.ledger,
                true,
                options,
                admissionIdentity,
                requestSummary,
                backgroundProjection,
            );
        }
        if (decision.kind === "created") {
            return continueRecordSchedulerAdmission(
                decision.ledger,
                false,
                options,
                admissionIdentity,
                requestSummary,
                backgroundProjection,
            );
        }
    }
    return {
        outcome: "UnknownOutcome",
        admissionIdentity,
        candidateTaskIds: [requestedTaskId],
        reasons: ["并发接纳在三次重读后仍无法唯一确定落盘结果"],
    };
}

async function continueRecordSchedulerAdmission(
    ledger: PersistedRecordSchedulerLedger,
    replayed: boolean,
    options: AdmitRecordSchedulerTaskOptions,
    admissionIdentity: SchedulerAdmissionIdentity,
    requestSummary: Record<string, unknown>,
    backgroundProjection: SchedulerAdmissionBackgroundProjection,
): Promise<AdmitRecordSchedulerTaskResult> {
    const taskId = ledger.task.taskId;
    if (!sameAdmissionIdentity(ledger.task.admissionIdentity, admissionIdentity)) {
        throw new RecordSchedulerAdmissionConflictError("已存在 ledger 的 admission identity 与本次请求不一致", [taskId]);
    }
    const ledgerAnchor = ledger.task.admission.state === "EnvelopeBound"
        ? ledger.task.admission.ledgerAnchor
        : createSchedulerLedgerAnchor({
            path: recordSchedulerLedgerPath(taskId),
            revision: ledger.revision,
            hash: ledger.persistedHash,
        });
    const capsuleDocument: SchedulerAdmissionCapsule = {
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId,
        taskKind: options.kind,
        admissionIdentity: structuredClone(admissionIdentity),
        ledgerAnchor: structuredClone(ledgerAnchor),
        requestSummary,
        backgroundProjection,
    };

    try {
        await writeRecordSchedulerAdmissionCapsule(capsuleDocument);
    } catch (error) {
        return {
            outcome: "UnknownOutcome",
            admissionIdentity,
            candidateTaskIds: [taskId],
            reasons: [error instanceof Error ? error.message : String(error)],
        };
    }

    const verified = await verifyOrRecoverTaskAdmission(taskId);
    if (verified.kind !== "verified") {
        return {
            outcome: "UnknownOutcome",
            admissionIdentity,
            candidateTaskIds: [taskId],
            reasons: [verified.reason],
        };
    }
    if (replayed && isTerminalTaskState(verified.ledger.task.state)) {
        const terminalProjection = getBackgroundTask(taskId);
        if (!terminalProjection) {
            return {
                outcome: "UnknownOutcome",
                admissionIdentity,
                candidateTaskIds: [taskId],
                reasons: [`terminal ledger ${taskId} 存在但无可验证的既有 background projection，拒绝重建`],
            };
        }
        return {
            outcome: "Replayed",
            taskId,
            task: terminalProjection,
            admissionReceipt: verified.receipt,
        };
    }
    let ensured: Awaited<ReturnType<typeof ensureRecordSchedulerBackgroundProjection>>;
    try {
        ensured = await ensureRecordSchedulerBackgroundProjection(options.kind, options.run, {
            admissionReceipt: verified.receipt,
            projection: options.projection,
            resumePayload: options.resumePayload,
            resumeVersion: options.resumeVersion,
            resumeHash: options.resumeHash,
            timeoutMessage: options.timeoutMessage,
        });
    } catch (error) {
        return {
            outcome: "UnknownOutcome",
            admissionIdentity,
            candidateTaskIds: [taskId],
            reasons: [error instanceof Error ? error.message : String(error)],
        };
    }
    return {
        outcome: replayed || ensured.disposition === "loaded" ? "Replayed" : "Admitted",
        taskId,
        task: ensured.task,
        admissionReceipt: verified.receipt,
    };
}

async function resolveAdmissionIdentity(
    requestedTaskId: string,
    taskKind: "record-update" | "record-batch-update",
    admissionIdentity: SchedulerAdmissionIdentity,
    replayTerminal: boolean,
): Promise<AdmissionIdentityResolution> {
    const matching: PersistedRecordSchedulerLedger[] = [];
    const conflictingTaskIds: string[] = [];
    const unresolved = new Map<string, string>();
    const ledgerTaskIds = new Set(listRecordSchedulerLedgerTaskIds());
    const untrustedLedgerTaskIds = new Set(ledgerTaskIds);
    const matchingCapsuleTaskIds = new Set<string>();
    const capsuleReads = await mapWithAdmissionConcurrency(
        listRecordSchedulerAdmissionCapsuleTaskIds(),
        async taskId => ({ taskId, result: await readRecordSchedulerAdmissionCapsule(taskId) }),
        ADMISSION_CAPSULE_READ_CONCURRENCY,
    );
    const markUnresolved = (taskId: string, reason: string): void => {
        if (!unresolved.has(taskId)) unresolved.set(taskId, reason);
    };

    for (const { taskId, result } of capsuleReads) {
        if (result.kind !== "current") {
            markUnresolved(taskId, `admission capsule ${taskId} 无法判定 identity：${result.kind === "repair_required" ? result.reason : result.kind}`);
            continue;
        }
        untrustedLedgerTaskIds.delete(taskId);
        const capsuleIdentity = result.capsule.admissionIdentity;
        const sameRequestKey = capsuleIdentity.requestKey === admissionIdentity.requestKey;
        const sameIdentity = sameAdmissionIdentity(capsuleIdentity, admissionIdentity);
        const sameTaskKind = result.capsule.taskKind === taskKind;
        if (!ledgerTaskIds.has(taskId)) {
            if (sameRequestKey && sameIdentity && sameTaskKind) {
                markUnresolved(taskId, `matching admission capsule ${taskId} 缺失对应 ledger`);
            } else if (sameRequestKey || taskId === requestedTaskId) {
                conflictingTaskIds.push(taskId);
            }
            continue;
        }
        if (sameRequestKey) {
            if (!sameIdentity || !sameTaskKind) {
                conflictingTaskIds.push(taskId);
                continue;
            }
            matchingCapsuleTaskIds.add(taskId);
            continue;
        }
        if (taskId === requestedTaskId) {
            conflictingTaskIds.push(taskId);
        }
    }
    if (conflictingTaskIds.length > 0) {
        throw new RecordSchedulerAdmissionConflictError(
            "相同 requestKey 或 taskId 已绑定不同 admission identity/content",
            [...new Set(conflictingTaskIds)].sort(),
        );
    }

    const candidateTaskIds = [...new Set([
        ...matchingCapsuleTaskIds,
        ...untrustedLedgerTaskIds,
    ])].sort();
    const candidateReads = await mapWithAdmissionConcurrency(
        candidateTaskIds,
        async taskId => {
            if (matchingCapsuleTaskIds.has(taskId)) {
                return { taskId, source: "capsule" as const, verification: await verifyOrRecoverTaskAdmission(taskId) };
            }
            return { taskId, source: "untrusted" as const, stored: await readRecordSchedulerLedgerStore(taskId, { expectPublished: true }) };
        },
        ADMISSION_LEDGER_READ_CONCURRENCY,
    );
    for (const candidate of candidateReads) {
        if (candidate.source === "capsule") {
            if (candidate.verification.kind !== "verified") {
                markUnresolved(candidate.taskId, `matching capsule 的 ledger ${candidate.taskId} 无法验证：${candidate.verification.reason}`);
                continue;
            }
            const verifiedIdentity = candidate.verification.ledger.task.admissionIdentity;
            if (!sameAdmissionIdentity(verifiedIdentity, admissionIdentity)
                || !sameAdmissionIdentity(candidate.verification.capsule.admissionIdentity, admissionIdentity)
                || candidate.verification.capsule.taskKind !== taskKind
                || taskKindFromRequestMode(candidate.verification.ledger.task.requestMode) !== taskKind) {
                markUnresolved(candidate.taskId, `matching capsule ${candidate.taskId} 与权威 ledger identity 不一致`);
                continue;
            }
            matching.push(candidate.verification.ledger);
            continue;
        }

        if (candidate.stored.kind !== "current") {
            markUnresolved(candidate.taskId, `ledger ${candidate.taskId} 无法判定 admission identity：${candidate.stored.kind}`);
            continue;
        }
        if (candidate.stored.ledger.task.admission.state !== "LedgerCreated") {
            markUnresolved(candidate.taskId, `ledger ${candidate.taskId} 缺失可信 admission capsule`);
            continue;
        }
        const identity = candidate.stored.ledger.task.admissionIdentity;
        const sameRequestKey = identity.requestKey === admissionIdentity.requestKey;
        const sameIdentity = sameAdmissionIdentity(identity, admissionIdentity);
        const sameTaskKind = taskKindFromRequestMode(candidate.stored.ledger.task.requestMode) === taskKind;
        if (sameRequestKey) {
            if (!sameIdentity || !sameTaskKind) {
                conflictingTaskIds.push(candidate.taskId);
                continue;
            }
            matching.push(candidate.stored.ledger);
            continue;
        }
        if (candidate.taskId === requestedTaskId) conflictingTaskIds.push(candidate.taskId);
    }
    if (conflictingTaskIds.length > 0) {
        throw new RecordSchedulerAdmissionConflictError(
            "相同 requestKey 或 taskId 已绑定不同 admission identity/content",
            [...new Set(conflictingTaskIds)].sort(),
        );
    }
    if (unresolved.size > 0) {
        return {
            kind: "unknown",
            candidateTaskIds: [...unresolved.keys()].sort(),
            reasons: [...unresolved.entries()]
                .sort(([leftTaskId], [rightTaskId]) => leftTaskId.localeCompare(rightTaskId))
                .map(([, reason]) => reason),
        };
    }
    const activeMatches = matching.filter(candidate => !isTerminalTaskState(candidate.task.state));
    if (activeMatches.length > 1) {
        return {
            kind: "unknown",
            candidateTaskIds: activeMatches.map(candidate => candidate.task.taskId).sort(),
            reasons: ["同一 admission identity 对应多个非终态 ledger，无法安全选择唯一执行实例"],
        };
    }
    if (activeMatches.length === 1) return { kind: "current", ledger: activeMatches[0] };
    if (!replayTerminal) return { kind: "missing" };
    const terminalMatches = matching
        .filter(candidate => isTerminalTaskState(candidate.task.state))
        .sort((left, right) => {
            const createdAtOrder = Date.parse(right.task.createdAt) - Date.parse(left.task.createdAt);
            return createdAtOrder || right.task.taskId.localeCompare(left.task.taskId);
        });
    if (terminalMatches.length > 0) return { kind: "current", ledger: terminalMatches[0] };
    return { kind: "missing" };
}

async function mapWithAdmissionConcurrency<Value, Result>(
    values: readonly Value[],
    mapper: (value: Value) => Promise<Result>,
    concurrency: number,
): Promise<Result[]> {
    if (values.length === 0) return [];
    const results = new Array<Result>(values.length);
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, values.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        for (;;) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= values.length) return;
            results[currentIndex] = await mapper(values[currentIndex]);
        }
    }));
    return results;
}

function normalizeImmutableRequestSummary(summary: Record<string, unknown>): Record<string, unknown> {
    const normalized = normalizeResumePayload(summary);
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
        throw new Error("immutableRequestSummary 必须是 JSON 对象");
    }
    return normalized as Record<string, unknown>;
}

function normalizeAdmissionBackgroundProjection(
    options: AdmitRecordSchedulerTaskOptions,
): SchedulerAdmissionBackgroundProjection {
    const projection = options.projection === undefined ? undefined : normalizeResumePayload(options.projection);
    if (options.resumePayload === undefined) {
        throw new Error("生产接纳必须提供 immutable resumePayload，供热重启恢复 handler 重建执行");
    }
    const resumePayload = normalizeResumePayload(options.resumePayload);
    const resumeVersion = options.resumeVersion ?? BACKGROUND_TASK_RESUME_VERSION;
    if (!Number.isInteger(resumeVersion) || resumeVersion <= 0) throw new Error("resumeVersion 必须是正整数");
    const resumeHash = stableJsonHash(resumePayload);
    if (options.resumeHash && options.resumeHash !== resumeHash) {
        throw new Error("resumeHash 与 resumePayload 的稳定 JSON hash 不一致");
    }
    return {
        ...(projection === undefined ? {} : { projection }),
        resumePayload,
        resumeVersion,
        resumeHash,
    };
}

function sameAdmissionIdentity(left: SchedulerAdmissionIdentity, right: SchedulerAdmissionIdentity): boolean {
    return left.requestKey === right.requestKey && left.requestHash === right.requestHash;
}

function taskKindFromRequestMode(requestMode: "update" | "batch_update"): "record-update" | "record-batch-update" {
    return requestMode === "update" ? "record-update" : "record-batch-update";
}
