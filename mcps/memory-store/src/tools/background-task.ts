import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { cancelBackgroundTask, formatBackgroundTask, waitForBackgroundTask } from "../background-tasks.js";
import { touchActivity } from "../lifecycle.js";

function textResponse(text: string) {
    return {
        content: [{ type: "text" as const, text }],
    };
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
    touchActivity();
    const task = await waitForBackgroundTask(taskId, waitSeconds || 0);
    return textResponse(formatBackgroundTask(task));
}

export function handleBackgroundTaskCancel(
    taskId: string,
    reason?: string,
): { content: Array<{ type: "text"; text: string }> } {
    touchActivity();
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
