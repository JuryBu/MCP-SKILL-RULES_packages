import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    cancelBackgroundTask,
    formatBackgroundTask,
    getRecordSchedulerProjectionHint,
    waitForBackgroundTask,
} from "../background-tasks.js";
import { touchActivity } from "../lifecycle.js";
import {
    formatRecordSchedulerCancel,
    formatRecordSchedulerTaskStatus,
    getRecordSchedulerRuntime,
} from "../record-scheduler-runtime.js";
import { isTerminalTaskState } from "../record-scheduler-contracts.js";

function textResponse(text: string) {
    return {
        content: [{ type: "text" as const, text }],
    };
}

function schedulerProjectionRepairRequired(task: { id: string; kind: string }): string {
    return `⚠️ Record scheduler ${task.kind} ${task.id} 的持久 projection 仍存在，但权威 scheduler ledger 不可读取；拒绝回退 generic status/cancel，需按 RepairRequired 处理`;
}

const BackgroundTaskStatusSchema = {
    taskId: z.string().describe("后台任务 ID"),
    waitSeconds: z.number().optional().describe("查询后台任务时等待秒数(1-300)，任务完成时提前返回"),
};

const BackgroundTaskCancelSchema = {
    taskId: z.string().describe("后台任务 ID"),
    reason: z.string().optional().describe("取消原因，默认 用户取消"),
};

export async function handleBackgroundTaskStatus(
    taskId: string,
    waitSeconds?: number,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    touchActivity({ skipRecordAutoCheck: true });
    const runtime = getRecordSchedulerRuntime();
    const schedulerStatus = runtime.status(taskId);
    if (schedulerStatus) {
        const settled = await runtime.waitForTerminal(taskId, waitSeconds || 0);
        const persistedTask = await waitForBackgroundTask(taskId, settled && isTerminalTaskState(settled.state) ? 1 : 0);
        return textResponse(formatRecordSchedulerTaskStatus(settled, persistedTask?.error));
    }
    const projectionHint = getRecordSchedulerProjectionHint(taskId);
    if (projectionHint) {
        return textResponse(schedulerProjectionRepairRequired(projectionHint));
    }
    const immediate = await waitForBackgroundTask(taskId, 0);
    const task = waitSeconds ? await waitForBackgroundTask(taskId, waitSeconds) : immediate;
    return textResponse(formatBackgroundTask(task));
}

export async function handleBackgroundTaskCancel(
    taskId: string,
    reason?: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    touchActivity({ skipRecordAutoCheck: true });
    const scheduler = await getRecordSchedulerRuntime().cancel(taskId);
    if (scheduler) return textResponse(formatRecordSchedulerCancel(scheduler));
    const projectionHint = getRecordSchedulerProjectionHint(taskId);
    if (projectionHint) {
        return textResponse(schedulerProjectionRepairRequired(projectionHint));
    }
    const task = cancelBackgroundTask(taskId, reason || "用户取消");
    return textResponse(formatBackgroundTask(task));
}

export function registerBackgroundTask(server: McpServer): void {
    server.tool(
        "background_task_status",
        "统一查询 task-backed 后台任务状态。兼容旧入口：record_manage(task_status)、stage_guard(check, taskId)、conversation_read_original(deep_locate_status)、conversation_golden_extract(taskId)。",
        BackgroundTaskStatusSchema,
        async ({ taskId, waitSeconds }) => handleBackgroundTaskStatus(taskId, waitSeconds),
    );

    server.tool(
        "background_task_cancel",
        "统一取消 task-backed 后台任务。兼容旧入口：conversation_read_original(deep_locate_cancel)；stage_guard(action=\"cancel\") 保留原“取消 Guard 锁”语义，不走这里。",
        BackgroundTaskCancelSchema,
        async ({ taskId, reason }) => handleBackgroundTaskCancel(taskId, reason),
    );
}
