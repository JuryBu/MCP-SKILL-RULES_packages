import { z } from 'zod';
import type { MethodSpec } from '../protocol.js';
import type { InputAttachmentService } from './input-attachments.js';
import type { InputAttachmentCaller, PrepareInputAttachment } from './input-types.js';

const identifier = z.string().min(1).max(256);
export const INPUT_ATTACHMENT_RPC_METHOD_SPECS: Record<string, MethodSpec> = {
    'conversations.references.prepare': { writes: true, scope: 'conversation', description: '有界固定原图、UTF-8文本或获准会话的所选原文，保留来源版本和SHA并返回短引用',
        schema: z.object({ conversationId: identifier, clientCommandId: identifier, controlLeaseId: identifier.optional(), controlEpoch: z.number().int().nonnegative().optional(),
            kind: z.enum(['file', 'attachment', 'conversation']).default('file'), source: z.string().min(1).max(32768), mime: z.string().max(256).optional(),
            range: z.string().max(128).optional(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceHost: identifier.optional(),
            contentIds: z.array(identifier).min(1).max(64).optional(), expectedHistoryEpoch: z.number().int().nonnegative().optional(),
            throughSeq: z.number().int().nonnegative().optional(), expectedViewRevision: z.number().int().nonnegative().optional() }).strict() },
    'conversations.references.get': { writes: false, scope: 'conversation', description: '读取当前会话附件的来源、MIME、字节、SHA和准备状态，不展开原件',
        schema: z.object({ conversationId: identifier, referenceId: identifier }).strict() },
};

export async function dispatchInputAttachment(service: InputAttachmentService, method: string, params: Record<string, unknown>, caller: InputAttachmentCaller) {
    if (method === 'conversations.references.prepare') return { reference: await service.prepare(params as unknown as PrepareInputAttachment, caller) };
    if (method === 'conversations.references.get') return { reference: await service.get(String(params.conversationId), String(params.referenceId)) };
    return undefined;
}
