import { z } from 'zod';
import type { MethodSpec } from '../protocol.js';

const identifier = z.string().min(1).max(256);
const conversationFields = { conversationId: identifier };
const controlFields = { controlLeaseId: identifier.optional(), controlEpoch: z.number().int().nonnegative().optional() };

export const workspaceChangesListSchema = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(24) }).strict();
export const workspaceChangesGetSchema = z.union([
    z.object({ actionId: identifier, maxDiffBytes: z.number().int().min(1024).max(65536).default(65536) }).strict(),
    z.object({ restorePlanId: identifier }).strict(),
]);
export const workspaceChangesPreviewSchema = z.object({ mode: z.enum(['files_only', 'round_restart']),
    expectedHistoryEpoch: z.number().int().min(0), expectedWorkspaceRevision: z.number().int().min(0),
    actionIds: z.array(identifier).min(1).max(200).optional(), roundId: identifier.optional(),
    hunks: z.array(z.object({ actionId: identifier, hunkIds: z.array(identifier).min(1).max(200) }).strict()).min(1).max(200).optional(),
    paths: z.array(z.string().min(1).max(32768)).min(1).max(200).optional() }).strict();
export const workspaceChangesCommitSchema = z.object({ restorePlanId: identifier, clientCommandId: identifier }).strict();

const previewSchema = workspaceChangesPreviewSchema.extend({ ...conversationFields, ...controlFields, clientCommandId: identifier })
    .superRefine((input, context) => {
        if (input.mode === 'round_restart' && (!input.roundId || input.actionIds || input.paths || input.hunks)) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ['roundId'], message: '整轮回溯只按roundId选择目标轮及以后修改' });
        }
        if (input.mode === 'files_only' && !input.actionIds && !input.paths && !input.roundId && !input.hunks) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: '文件恢复需要选择动作、路径、轮次或片段' });
        }
    });

export const WORKSPACE_RPC_SIGNATURES = {
    'changes.list': workspaceChangesListSchema.extend(conversationFields),
    'changes.get': z.union([workspaceChangesGetSchema.options[0].extend(conversationFields),
        workspaceChangesGetSchema.options[1].extend(conversationFields)]),
    'changes.preview': previewSchema,
    'changes.commit': workspaceChangesCommitSchema.extend({ ...conversationFields, ...controlFields }),
} as const;

export type WorkspaceRpcMethod = keyof typeof WORKSPACE_RPC_SIGNATURES;
export type WorkspaceRpcParams = { [Method in WorkspaceRpcMethod]: z.output<typeof WORKSPACE_RPC_SIGNATURES[Method]> };

export const WORKSPACE_RPC_METHOD_SPECS = {
    'changes.list': { schema: WORKSPACE_RPC_SIGNATURES['changes.list'], writes: false, scope: 'conversation', description: '分页查看本会话受控修改' },
    'changes.get': { schema: WORKSPACE_RPC_SIGNATURES['changes.get'], writes: false, scope: 'conversation', description: '查看本会话动作差异或原恢复计划' },
    'changes.preview': { schema: WORKSPACE_RPC_SIGNATURES['changes.preview'], writes: true, scope: 'conversation', description: '以当前历史和文件版本保存恢复预览' },
    'changes.commit': { schema: WORKSPACE_RPC_SIGNATURES['changes.commit'], writes: true, scope: 'conversation', description: '按原恢复计划及命令标识提交文件和历史恢复' },
} satisfies Record<WorkspaceRpcMethod, MethodSpec>;
