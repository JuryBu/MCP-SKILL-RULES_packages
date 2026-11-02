import { z } from 'zod';
import type { MethodSpec } from '../protocol.js';

const identifier = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const control = { controlLeaseId: identifier.optional(), controlEpoch: revision.optional() };
const duration = z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000);
const retentionFields = { conversationId: identifier, mode: z.enum(['temporary', 'ttl', 'archive']),
    ttlDurationMs: duration.optional(), expectedPolicyRevision: revision };
const branchFields = { conversationId: identifier, roundId: identifier, expectedHistoryEpoch: revision,
    title: z.string().min(1).max(2048).optional(), ttlDurationMs: duration.optional(),
    writeRoots: z.array(z.string().min(1).max(32768)).min(1) };

function checkRetention(input: { mode: string; ttlDurationMs?: number }, context: z.RefinementCtx): void {
    if (input.mode === 'ttl' && input.ttlDurationMs === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['ttlDurationMs'], message: 'TTL转换必须显式提供时长' });
    if (input.mode !== 'ttl' && input.ttlDurationMs !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['ttlDurationMs'], message: '只有TTL转换接受时长' });
}

export const CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS = {
    'conversations.previewRetention': {
        writes: false, scope: 'conversation', description: '只读预览完整保存范围，令牌绑定来源版本、目标保存方式和所属主体',
        schema: z.object(retentionFields).strict().superRefine(checkRetention),
    },
    'conversations.setRetention': {
        writes: true, scope: 'conversation', description: '以新写命令和原只读预览令牌确认保存转换，重复提交沿原回执',
        schema: z.object({ ...retentionFields, clientCommandId: identifier, ...control,
            previewToken: z.string().min(1).max(8192) }).strict().superRefine(checkRetention),
    },
    'conversations.previewBranch': {
        writes: false, scope: 'conversation', description: '只读冻结所选轮次与完整原件范围，令牌绑定主体、原版本和明确分支参数',
        schema: z.object(branchFields).strict(),
    },
    'conversations.branch': {
        writes: true, scope: 'conversation', description: '冻结指定轮次完整来源，另建独立会话，工作区文件保持当前状态',
        schema: z.object({ ...branchFields, clientCommandId: identifier, ...control,
            previewToken: z.string().min(1).max(8192).optional() }).strict(),
    },
} satisfies Record<string, MethodSpec>;
