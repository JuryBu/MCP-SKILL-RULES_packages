import { AgentFault } from '../protocol.js';
import type { WorkspaceRpcStore } from '../storage/workspace-port.js';
import type { RestorePlanStorePort } from '../storage/workspace-port.js';
import type { StorePort } from '../storage/port.js';
import type { CoreRestorePort } from './restore.js';
import type { WorkspaceJournalPort } from './journal.js';
import { createMemoryWorkspaceRestoreCore, validateRestoreHistory } from './temporary-history.js';
import { collectRoundChildChanges } from './round-children.js';

type DurableHistoryStore = WorkspaceRpcStore & Pick<StorePort, 'readHistory' | 'getRecord' | 'listRecords'>;

export function createAgentWorkspaceRestoreCore(options: { store: { persistent: DurableHistoryStore; temporary: StorePort };
    journal: WorkspaceJournalPort; plans: RestorePlanStorePort; quiesce: CoreRestorePort['quiesce'] }): CoreRestorePort {
    const durable = createSqliteWorkspaceRestoreCore(options.store.persistent, options.quiesce);
    const temporary = createMemoryWorkspaceRestoreCore({ ...options, store: options.store.temporary });
    return { validatePreview: async (input, context) => {
        const selection = await (context.retention.mode === 'temporary' ? temporary : durable).validatePreview!(input, context);
        if (input.mode !== 'round_restart' || !selection.roundIds) return selection;
        return { ...selection, ...await collectRoundChildChanges(context.retention.mode === 'temporary' ? options.store.temporary : options.store.persistent,
            options.journal, context, selection.roundIds, input.expectedHistoryEpoch) };
    },
        quiesce: (input, context) => (context.retention.mode === 'temporary' ? temporary : durable).quiesce(input, context), commitHistory: (input, context) =>
        (context.retention.mode === 'temporary' ? temporary : durable).commitHistory(input, context) };
}

export function createSqliteWorkspaceRestoreCore(store: DurableHistoryStore, quiesce: CoreRestorePort['quiesce']): CoreRestorePort {
    return {
        validatePreview: (input, context) => validateRestoreHistory(store, input, context.conversationId),
        async quiesce(input, context) {
            const previous = await store.getRecord({ conversationId: context.conversationId, kind: 'step', id: `workspace:restore-history:${input.restorePlanId}` });
            if (!previous) await validateRestoreHistory(store, { ...input, roundId: input.targetRoundId ?? undefined }, context.conversationId);
            return quiesce(previous ? { ...input, expectedHistoryEpoch: Number(previous.value.historyEpoch) } : input, context);
        },
        async commitHistory(input, context) {
            if (context.retention.mode === 'temporary') throw new AgentFault('RESTORE_PENDING', '临时会话需要核心绑定纯内存历史回溯事务');
            const result = await store.executeWorkspace({ type: 'restore.history', input: { ...input,
                conversationId: context.conversationId, principalId: context.principalId, policyRevision: context.policyRevision } });
            if (result.kind !== 'restore_history') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区历史提交回执类型无效');
            return result.receipt;
        },
    };
}
