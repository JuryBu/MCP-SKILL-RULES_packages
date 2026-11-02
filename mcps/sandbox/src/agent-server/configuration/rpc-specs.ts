import { z } from 'zod';
import type { MethodSpec } from '../protocol.js';

const identifier = z.string().min(1).max(256);
const revision = z.number().int().safe().nonnegative();
const conversation = { conversationId: identifier };
const mutation = { clientCommandId: identifier, controlLeaseId: identifier.optional(), controlEpoch: revision.optional(), expectedRevision: revision };
const page = { cursor: z.string().max(16384).optional(), limit: z.number().int().min(1).max(100).optional() };
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

function method(shape: z.ZodRawShape, writes: boolean, scope: MethodSpec['scope'], description: string): MethodSpec {
    return { schema: z.object(shape).strict(), writes, scope, description };
}

export const MODULE_RPC_SPECS: Record<string, MethodSpec> = {
    'conversations.skills.list': method({ ...conversation, ...page }, false, 'conversation', '分页查看显式登记的技能元数据和当前选择，不读取正文'),
    'conversations.skills.get': method({ ...conversation, qualifiedName: identifier }, false, 'conversation', '按来源限定名称读取一个技能及固定版本，不执行脚本'),
    'conversations.skills.load': method({ ...conversation, ...mutation, qualifiedName: identifier, expectedSha256: sha256.optional() }, true, 'conversation', '固定一个明确选择的技能版本，仅下一请求生效'),
    'conversations.skills.unload': method({ ...conversation, ...mutation, qualifiedName: identifier }, true, 'conversation', '停用下一请求的技能，已发送请求保持原字节'),
    'conversations.rules.list': method({ ...conversation, ...page }, false, 'conversation', '查看本产品显式规则来源、优先级、固定版本和加载状态'),
    'conversations.rules.get': method({ ...conversation, sourceId: identifier }, false, 'conversation', '按需读取一个规则来源或其已选定版本'),
    'conversations.rules.reload': method({ ...conversation, ...mutation, dryRun: z.boolean().default(true),
        sourceIds: z.array(identifier).max(32).optional(), previewToken: sha256.optional() }, true, 'conversation', '先预览规则变化，再携原预览令牌提交到下一请求'),
    'server.settings.get': method({ scope: z.literal('global').default('global') }, false, 'none', '查看本产品当前身份的脱敏全局设置、版本及来源'),
    'server.settings.put': method({ ...mutation, scope: z.literal('global').default('global'), values: z.record(z.unknown()) }, true, 'server', '以稳定命令ID和CAS保存本产品自己的设置'),
    'conversations.search': method({ ...conversation, ...page, query: z.string().min(1).max(512), scope: z.enum(['input', 'conversation']).default('conversation'),
        sourceHost: z.literal('agent-server').optional(), maxBytes: z.number().int().min(4096).max(1024 * 1024).default(128 * 1024) }, false, 'conversation', '有界扫描本Store原历史，返回命中轮次、字节位置及原文引用'),
};
