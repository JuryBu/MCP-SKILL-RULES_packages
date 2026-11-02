import { AgentFault } from './protocol.js';
import type { ExecutorContext } from './runtime.js';
import type { PreparedChild } from './delegation/contracts.js';
import type { InputReferenceSourceGrant } from './media/input-types.js';

export function selectedInputSource(context: Pick<ExecutorContext, 'snapshot' | 'conversationOptions'>): InputReferenceSourceGrant | undefined {
    if (!context.snapshot.parentRunId) return undefined;
    const plan = context.snapshot.delegationPlan as PreparedChild | undefined;
    if (!plan || !Array.isArray(plan.contextRefs)) throw new AgentFault('E_REFERENCE_GRANT_STALE', '子任务缺少原派发材料清单');
    if (!plan.contextRefs.length) return undefined;
    const allocation = context.snapshot.internalDelegation as { parentConversationId?: string } | undefined;
    const selected = context.conversationOptions.delegationContext as { provenance?: { sources?: unknown[] } } | undefined;
    const sources = selected?.provenance?.sources;
    if (!allocation?.parentConversationId || context.conversationOptions.parentConversationId !== allocation.parentConversationId
        || !Array.isArray(sources) || sources.length !== 1 || plan.contextRefs.length > 32) {
        throw new AgentFault('E_REFERENCE_GRANT_STALE', '子任务原件读取来源须与冻结的父会话及选中清单一致');
    }
    const source = sources[0] as { conversationId?: string; references?: { referenceId?: string; sha256?: string }[] } | null;
    if (!source || source.conversationId !== allocation.parentConversationId || !Array.isArray(source.references)
        || source.references.length > 32 || source.references.length !== plan.contextRefs.length
        || source.references.some(reference => typeof reference.referenceId !== 'string' || !plan.contextRefs.includes(reference.referenceId)
            || typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256))
        || new Set(source.references.map(reference => reference.referenceId)).size !== new Set(plan.contextRefs).size) {
        throw new AgentFault('E_REFERENCE_GRANT_STALE', '子任务选中原件的ID、SHA或父来源不完整');
    }
    return { readerConversationId: context.snapshot.conversationId, sources: [{ conversationId: source.conversationId,
        references: source.references.map(reference => ({ referenceId: reference.referenceId!, sha256: reference.sha256! })) }] };
}
