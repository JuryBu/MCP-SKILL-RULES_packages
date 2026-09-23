import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHumanVerification, HUMAN_VERIFICATION_GENERATION } from '../assisted-verification.js';
import { cancelBackgroundTask, waitForBackgroundTask } from '../background-tasks.js';
import { remainingRequestMs } from '../request-context.js';
import { touchActivity } from '../lifecycle.js';

export function registerHumanVerification(server: McpServer): void {
    server.registerTool('web_human_verification', {
        title: '人工验证任务与原页面续接',
        description: 'start短返回taskId，后台打开人工窗口，窗口就绪后给予600秒。status短轮询返回cached状态，不反复导出存储。ready后使用sessionId继续原只读抓取；保留窗口，读完close。cancel/close仅清理本owner任务资源，不自动重放点击、提交或脚本。后端重启后旧taskId失效，不会自动重开窗口。',
        inputSchema: {
            action: z.enum(['start', 'status', 'cancel', 'close']),
            ownerId: z.string().trim().min(1).describe('必须与创建任务的稳定ownerId一致，不可使用global'),
            url: z.string().url().optional().describe('start时必填原目标URL'),
            waitFor: z.string().optional().describe('可选目标正文CSS选择器，不把未出现的选择器算验证成功'),
            taskId: z.string().optional(),
            waitSeconds: z.number().int().min(0).max(45).optional().describe('status最多45秒，默认0，不承载600秒人工等待'),
            humanSessionId: z.string().optional().describe('可选已有人工浏览器session，避免另开窗口；必须同owner'),
            pageId: z.string().optional().describe('已有人工浏览器的明确页面ID，多窗口应指定'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async params => {
        touchActivity();
        try {
            if (params.ownerId === 'global') throw new Error('人工任务必须使用非global稳定ownerId');
            if (params.action === 'start') {
                if (!params.url) throw new Error('start需要url');
                const task = startHumanVerification({ ...params, url: params.url });
                return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }], structuredContent: { task } };
            }
            if (!params.taskId) throw new Error('查询/关闭需要taskId');
            const existing = await waitForBackgroundTask(params.taskId, 0, params.ownerId);
            if (existing && existing.kind !== 'human-verification') throw new Error('taskId不是人工验证任务');
            if (params.action !== 'status') void cancelBackgroundTask(params.taskId, params.ownerId).catch(() => undefined);
            const task = await waitForBackgroundTask(params.taskId, params.action === 'status'
                ? Math.min(params.waitSeconds ?? 0, Math.max(0, (remainingRequestMs() - 1500) / 1000)) : 0, params.ownerId);
            if (!task) return { isError: true, content: [{ type: 'text' as const, text: `task_not_found：任务不存在、归属不匹配或后端已重启。generation=${HUMAN_VERIFICATION_GENERATION}；不要盲目重放原操作。` }] };
            const snapshot = task.status === 'running' ? task : {
                ...task,
                metadata: { ...task.metadata, contentVerified: false, nextAction: task.cleanupStatus === 'failed'
                    ? '清理未完成，请用同一taskId和ownerId再次close，仅重试清理；不要新建窗口或重放原操作。'
                    : task.status === 'cancelling'
                    ? '正在保存状态和清理资源，继续短轮询；不要重开或重放原操作。'
                    : '本任务已结束；旧sessionId不可用于续接。存储保存不等于目标认证成功，必要时发起新的只读验证。' },
            };
            return { isError: task.status === 'error', content: [{ type: 'text' as const, text: JSON.stringify(snapshot, null, 2) }], structuredContent: { task: snapshot } };
        } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
        }
    });
}
