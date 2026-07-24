export interface BackgroundTaskSuspensionDetails {
    taskId: string;
    wakeAt: string;
    waitingReason: string;
    ledgerRevision: number;
}

function validateSuspensionDetails(details: BackgroundTaskSuspensionDetails): BackgroundTaskSuspensionDetails {
    if (!details || typeof details !== "object") throw new Error("后台任务挂起信号必须包含详情对象");
    if (typeof details.taskId !== "string" || !details.taskId.trim()) throw new Error("后台任务挂起信号缺少 taskId");
    if (typeof details.waitingReason !== "string" || !details.waitingReason.trim()) {
        throw new Error("后台任务挂起信号缺少 waitingReason");
    }
    if (!Number.isSafeInteger(details.ledgerRevision) || details.ledgerRevision < 0) {
        throw new Error("后台任务挂起信号 ledgerRevision 必须是非负安全整数");
    }
    if (typeof details.wakeAt !== "string" || !Number.isFinite(Date.parse(details.wakeAt))) {
        throw new Error("后台任务挂起信号 wakeAt 必须是有效 ISO 时间");
    }
    return {
        taskId: details.taskId,
        wakeAt: new Date(details.wakeAt).toISOString(),
        waitingReason: details.waitingReason,
        ledgerRevision: details.ledgerRevision,
    };
}

export class BackgroundTaskSuspension extends Error {
    readonly code = "BACKGROUND_TASK_SUSPENDED";
    readonly taskId: string;
    readonly wakeAt: string;
    readonly waitingReason: string;
    readonly ledgerRevision: number;

    constructor(details: BackgroundTaskSuspensionDetails) {
        const normalized = validateSuspensionDetails(details);
        super(`后台任务 ${normalized.taskId} 挂起至 ${normalized.wakeAt}：${normalized.waitingReason}`);
        this.name = "BackgroundTaskSuspension";
        this.taskId = normalized.taskId;
        this.wakeAt = normalized.wakeAt;
        this.waitingReason = normalized.waitingReason;
        this.ledgerRevision = normalized.ledgerRevision;
    }
}

export function createBackgroundTaskSuspension(details: BackgroundTaskSuspensionDetails): BackgroundTaskSuspension {
    return new BackgroundTaskSuspension(details);
}

export function suspendBackgroundTask(details: BackgroundTaskSuspensionDetails): never {
    throw createBackgroundTaskSuspension(details);
}

export function isBackgroundTaskSuspension(error: unknown): error is BackgroundTaskSuspension {
    return error instanceof BackgroundTaskSuspension;
}
