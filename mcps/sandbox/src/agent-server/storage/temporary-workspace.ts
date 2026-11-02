import { AgentFault } from '../protocol.js';
import { MemoryApprovalStore } from '../security/approvals.js';
import type { ApprovalStorePort, ApprovalTicket, ApprovalTransaction, ApprovalQuery } from '../security/approvals.js';
import { MemoryWorkspaceJournal } from '../workspace/journal.js';
import type { ChangeAction, WorkspaceJournalPort } from '../workspace/journal.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { AgentStore } from './index.js';
import { createSqliteWorkspacePorts } from './workspace-port.js';
import { createAgentPendingToolStore } from './temporary-pending.js';
import type { RestorePlanStorePort, StoredRestorePlan } from './workspace-port.js';
import { lifecycleFrozen, requireLifecycleSnapshotOwner } from '../conversation-lifecycle/migration-snapshots.js';
import type { LifecycleCapture, LifecycleStage, LifecycleWorkspaceSnapshot } from '../conversation-lifecycle/migration-snapshots.js';
import type { JsonValue } from '../protocol.js';

class SelectApprovalStore extends Error {
    constructor(readonly conversationId?: string) { super('select approval retention'); }
}

function receiptConversation(key: string, approvalOwner?: (approvalId: string) => string | undefined): string | undefined {
    try {
        const parts = JSON.parse(key);
        return Array.isArray(parts) ? parts[0] === 'request' ? parts[2] : parts[0] === 'respond' ? parts[3]
            : parts[0] === 'consume' ? approvalOwner?.(String(parts[1])) : undefined : undefined;
    } catch { return undefined; }
}

export function createAgentWorkspacePorts(store: AgentStore) {
    const cached = workspaces.get(store);
    if (cached) return cached;
    const durable = createSqliteWorkspacePorts(store.persistent);
    const journalBudget = store.temporaryMemoryBudget.scope('workspace-journal');
    const approvalBudget = store.temporaryMemoryBudget.scope('workspace-approvals');
    const journals = new Map<string, MemoryWorkspaceJournal>();
    const journalHeld = new Map<string, number>();
    const approvals = new Map<string, MemoryApprovalStore>();
    const approvalSizes = new Map<string, Map<string, number>>();
    const ticketOwners = new Map<string, string>();
    const restoreBudget = store.temporaryMemoryBudget.scope('workspace-restore-plans');
    const restoreRecords = new Map<string, { plan: StoredRestorePlan; bytes: number }>();
    const purgedRestoreIds = new Set<string>();
    const purgedRestoreConversations = new Set<string>();
    let restoreClosed = false;
    let approvalSerial: Promise<unknown> = Promise.resolve();
    const lifecycleFrozenIds = new Set<string>();
    const lifecycleStages = new Map<string, () => void>();
    const isTemporary = async (conversationId: string) => Boolean(await store.temporary.getRecord({ conversationId, kind: 'conversation', id: conversationId }));
    const memoryJournal = (conversationId: string) => {
        let journal = journals.get(conversationId);
        if (!journal) { journal = new MemoryWorkspaceJournal(store.temporaryMemoryBudget.maxConversationBytes); journals.set(conversationId, journal); }
        return journal;
    };
    const readJournal = async <Value>(conversationId: string, operation: (journal: MemoryWorkspaceJournal) => Promise<Value>): Promise<Value> => {
        const scratch = (journalHeld.get(conversationId) ?? 0) * 2;
        journalBudget.reserve(conversationId, scratch, 'scratch');
        try { return await operation(memoryJournal(conversationId)); }
        finally { journalBudget.release(conversationId, scratch, 'scratch'); }
    };
    const journal: WorkspaceJournalPort = {
        persistence: 'durable', supportedRetentions: ['temporary', 'archive', 'ttl'],
        get: async (conversationId, actionId) => await isTemporary(conversationId)
            ? readJournal(conversationId, memory => memory.get(conversationId, actionId)) : durable.journal.get(conversationId, actionId),
        list: async conversationId => await isTemporary(conversationId)
            ? readJournal(conversationId, memory => memory.list(conversationId)) : durable.journal.list(conversationId),
        listPage: async (conversationId, input) => await isTemporary(conversationId)
            ? readJournal(conversationId, memory => memory.listPage(conversationId, input)) : durable.journal.listPage(conversationId, input),
        revision: async conversationId => await isTemporary(conversationId) ? memoryJournal(conversationId).revision(conversationId) : durable.journal.revision(conversationId),
        prepare: async action => {
            if (lifecycleFrozenIds.has(action.conversationId)) throw lifecycleFrozen(action.conversationId);
            if (!await isTemporary(action.conversationId)) {
                if (action.retention.mode === 'temporary') throw new AgentFault('CONVERSATION_NOT_FOUND', '临时修改所属会话已经关闭');
                return durable.journal.prepare(action);
            }
            if (action.retention.mode !== 'temporary') throw new AgentFault('TOOL_NOT_ALLOWED', '临时修改的保存方式与会话不同');
            const metadata = { ...action, before: undefined, after: undefined };
            const bytes = (action.before?.length ?? 0) + action.after.length + measureCanonicalJsonBytes(metadata, { maxBytes: 65536 }) + 65536;
            journalBudget.reserve(action.conversationId, bytes);
            let scratchHeld = false;
            try {
                journalBudget.reserve(action.conversationId, bytes * 2, 'scratch'); scratchHeld = true;
                await memoryJournal(action.conversationId).prepare(action);
                journalHeld.set(action.conversationId, (journalHeld.get(action.conversationId) ?? 0) + bytes);
            } catch (error) { journalBudget.release(action.conversationId, bytes); throw error; }
            finally { if (scratchHeld) journalBudget.release(action.conversationId, bytes * 2, 'scratch'); }
        },
        settle: async (conversationId, actionId, result) => {
            if (lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
            if (!await isTemporary(conversationId)) return durable.journal.settle(conversationId, actionId, result);
            return store.withConversationLifecycleMutation(async () => {
                if (lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
                const key = { conversationId, kind: 'conversation' as const, id: conversationId };
                const current = await store.temporary.getRecord(key);
                if (!current) throw new AgentFault('CONVERSATION_NOT_FOUND', '临时修改所属会话已经关闭');
                const settled = await readJournal(conversationId, memory => memory.settle(conversationId, actionId, result));
                const workspaceRevision = await memoryJournal(conversationId).revision(conversationId);
                if (current.value.workspaceRevision !== workspaceRevision) await store.temporary.commitTransition({
                    expected: [{ key, revision: current.revision }], records: [{ key, revision: current.revision + 1,
                        value: { ...current.value, workspaceRevision } }],
                });
                return settled;
            });
        },
    };
    const approvalStore: ApprovalStorePort = {
        getTicket: async approvalId => {
            const conversationId = ticketOwners.get(approvalId);
            return conversationId ? approvals.get(conversationId)?.getTicket(approvalId) : durable.approvalStore.getTicket(approvalId);
        },
        listTickets: async (query: ApprovalQuery) => {
            if (!await isTemporary(query.conversationId)) return durable.approvalStore.listTickets(query);
            const conversation = await store.temporary.getRecord({ conversationId: query.conversationId, kind: 'conversation', id: query.conversationId });
            if (conversation?.value.principalId !== query.principalId) throw new AgentFault('TOOL_NOT_ALLOWED', '批准列表未绑定原会话主体');
            return approvals.get(query.conversationId)?.listTickets(query) ?? { tickets: [], nextCursor: null };
        },
        transaction: <Value>(operation: (transaction: ApprovalTransaction) => Value): Promise<Value> => {
            const pending = approvalSerial.then(async () => {
                let conversationId: string | undefined;
                try {
                    return operation({ get: id => { throw new SelectApprovalStore(ticketOwners.get(id)); },
                        put: ticket => { throw new SelectApprovalStore(ticket.conversationId); },
                        getReceipt: key => { throw new SelectApprovalStore(receiptConversation(key)); },
                        putReceipt: key => { throw new SelectApprovalStore(receiptConversation(key)); } });
                } catch (error) {
                    if (!(error instanceof SelectApprovalStore)) throw error;
                    conversationId = error.conversationId;
                }
                if (conversationId && lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
                if (!conversationId || !await isTemporary(conversationId)) return durable.approvalStore.transaction(operation);
                const selected = conversationId;
                let memory = approvals.get(selected);
                if (!memory) { memory = new MemoryApprovalStore(); approvals.set(selected, memory); }
                const sizes = approvalSizes.get(selected) ?? new Map<string, number>();
                const scratch = [...sizes.values()].reduce((total, bytes) => total + bytes, 0) * 3 + 65536;
                approvalBudget.reserve(selected, scratch, 'scratch');
                const allocated = new Map<string, number>(); const owners = new Set<string>();
                const reserve = (key: string, value: unknown) => {
                    const bytes = measureCanonicalJsonBytes(value, { maxBytes: 65536 });
                    approvalBudget.reserve(selected, bytes);
                    if (allocated.has(key)) approvalBudget.release(selected, allocated.get(key)!);
                    allocated.set(key, bytes);
                };
                try {
                    const value = await memory.transaction(transaction => operation({ get: id => transaction.get(id), getReceipt: key => transaction.getReceipt(key),
                        put: (ticket: ApprovalTicket) => {
                            if (ticket.conversationId !== selected) throw new AgentFault('STORAGE_TRANSITION_CROSS_MODE', '批准事务不能跨越会话保存方式');
                            reserve(`ticket:${ticket.approvalId}`, ticket); owners.add(ticket.approvalId); transaction.put(ticket);
                        },
                        putReceipt: (key, hash, value) => { reserve(`receipt:${key}`, { hash, value }); transaction.putReceipt(key, hash, value); } }));
                    for (const [key, bytes] of allocated) { if (sizes.has(key)) approvalBudget.release(selected, sizes.get(key)!); sizes.set(key, bytes); }
                    approvalSizes.set(selected, sizes); for (const id of owners) ticketOwners.set(id, selected);
                    return value;
                } catch (error) { for (const bytes of allocated.values()) approvalBudget.release(selected, bytes); throw error; }
                finally { approvalBudget.release(selected, scratch, 'scratch'); }
            });
            approvalSerial = pending.catch(() => undefined);
            return pending;
        },
    };
    const restorePlans: RestorePlanStorePort = {
        persistence: 'durable',
        get: async restorePlanId => {
            if (purgedRestoreIds.has(restorePlanId)) return undefined;
            const memory = restoreRecords.get(restorePlanId);
            if (!memory) return durable.restorePlans.get(restorePlanId);
            restoreBudget.reserve(memory.plan.conversationId, memory.bytes * 2, 'scratch');
            try { return structuredClone(memory.plan); }
            finally { restoreBudget.release(memory.plan.conversationId, memory.bytes * 2, 'scratch'); }
        },
        put: async (plan, expectedRevision) => {
            if (lifecycleFrozenIds.has(plan.conversationId)) throw lifecycleFrozen(plan.conversationId);
            if (purgedRestoreIds.has(plan.restorePlanId)) throw new AgentFault('CONVERSATION_NOT_FOUND', '临时恢复预览所属会话已经关闭');
            const temporary = await isTemporary(plan.conversationId);
            if (restoreClosed || purgedRestoreConversations.has(plan.conversationId)) throw new AgentFault('CONVERSATION_NOT_FOUND', '恢复预览所属会话已经关闭');
            if (!temporary) {
                if (restoreRecords.has(plan.restorePlanId)) throw new AgentFault('CONVERSATION_NOT_FOUND', '临时恢复预览所属会话已经关闭');
                return durable.restorePlans.put(plan, expectedRevision);
            }
            const previous = restoreRecords.get(plan.restorePlanId);
            if ((previous?.plan.revision ?? null) !== expectedRevision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '临时恢复预览版本已经变化');
            if (previous && (previous.plan.conversationId !== plan.conversationId || previous.plan.principalId !== plan.principalId)) throw new AgentFault('TOOL_NOT_ALLOWED', '临时恢复预览归属发生变化');
            const next = { ...plan, revision: (expectedRevision ?? 0) + 1 };
            const bytes = measureCanonicalJsonBytes(next, { maxBytes: store.temporaryMemoryBudget.maxConversationBytes });
            restoreBudget.reserve(plan.conversationId, bytes);
            let held = false;
            try {
                restoreBudget.reserve(plan.conversationId, bytes * 2, 'scratch'); held = true;
                const saved = structuredClone(next);
                const returned = structuredClone(saved);
                restoreRecords.set(plan.restorePlanId, { plan: saved, bytes });
                if (previous) restoreBudget.release(plan.conversationId, previous.bytes);
                return returned;
            } catch (error) { restoreBudget.release(plan.conversationId, bytes); throw error; }
            finally { if (held) restoreBudget.release(plan.conversationId, bytes * 2, 'scratch'); }
        },
    };
    const clear = (conversationId: string, purged = true) => {
        if (purged) purgedRestoreConversations.add(conversationId);
        for (const [planId, record] of restoreRecords) if (record.plan.conversationId === conversationId) {
            restoreBudget.release(conversationId, record.bytes); restoreRecords.delete(planId); if (purged) purgedRestoreIds.add(planId);
        }
        journals.get(conversationId)?.clear(conversationId); journals.delete(conversationId);
        const journalBytes = journalHeld.get(conversationId) ?? 0;
        if (journalBytes) journalBudget.release(conversationId, journalBytes); journalHeld.delete(conversationId);
        const approvalBytes = [...(approvalSizes.get(conversationId)?.values() ?? [])].reduce((total, bytes) => total + bytes, 0);
        if (approvalBytes) approvalBudget.release(conversationId, approvalBytes);
        approvals.delete(conversationId); approvalSizes.delete(conversationId);
        for (const [id, owner] of ticketOwners) if (owner === conversationId) ticketOwners.delete(id);
    };
    store.onTemporaryTransition(async transition => { if (transition.purgeConversationId) { await approvalSerial; clear(transition.purgeConversationId); } });
    store.onClosing(async () => { restoreClosed = true; await approvalSerial; for (const discard of lifecycleStages.values()) discard();
        for (const conversationId of new Set([...journals.keys(), ...approvals.keys(), ...[...restoreRecords.values()].map(record => record.plan.conversationId)])) clear(conversationId); });
    const lifecycle = {
        async freezeConversationLifecycle(conversationId: string): Promise<() => void> {
            if (restoreClosed || lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
            lifecycleFrozenIds.add(conversationId);
            await approvalSerial;
            return () => lifecycleFrozenIds.delete(conversationId);
        },
        async captureConversationLifecycle(conversationId: string): Promise<LifecycleCapture<LifecycleWorkspaceSnapshot>> {
            if (!lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
            const sizes = approvalSizes.get(conversationId) ?? new Map<string, number>();
            const plans = [...restoreRecords.values()].filter(entry => entry.plan.conversationId === conversationId);
            const scratch = ((journalHeld.get(conversationId) ?? 0) + [...sizes.values()].reduce((total, bytes) => total + bytes, 0)
                + plans.reduce((total, entry) => total + entry.bytes, 0)) * 4;
            journalBudget.reserve(conversationId, scratch, 'scratch');
            let released = false;
            try {
                const actions = await journals.get(conversationId)?.list(conversationId) ?? [];
                const tickets: ApprovalTicket[] = [];
                for (const [approvalId, owner] of ticketOwners) if (owner === conversationId) {
                    const ticket = await approvals.get(conversationId)?.getTicket(approvalId);
                    if (!ticket) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '批准归属缺少原批准记录');
                    tickets.push(ticket);
                }
                const approvalReceipts = await approvals.get(conversationId)?.transaction(transaction => [...sizes.keys()].filter(key => key.startsWith('receipt:')).map(key => {
                    const receiptKey = key.slice('receipt:'.length), receipt = transaction.getReceipt(receiptKey);
                    if (!receipt) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '批准清单缺少原回执');
                    return { key: receiptKey, hash: receipt.hash, value: receipt.value as JsonValue };
                })) ?? [];
                const value: LifecycleWorkspaceSnapshot = { schemaVersion: 1, conversationId,
                    journalRevision: await journals.get(conversationId)?.revision(conversationId) ?? 0,
                    actions: actions.map(({ before, after, ...action }) => ({ ...action, beforeBase64: before?.toString('base64') ?? null, afterBase64: after.toString('base64') })),
                    tickets, approvalReceipts, restorePlans: structuredClone(plans.map(entry => entry.plan)) };
                return { value, release: () => { if (!released) { released = true; journalBudget.release(conversationId, scratch, 'scratch'); } } };
            } catch (error) { journalBudget.release(conversationId, scratch, 'scratch'); throw error; }
        },
        async stageConversationLifecycle(snapshot: LifecycleWorkspaceSnapshot): Promise<LifecycleStage> {
            const conversationId = snapshot.conversationId;
            requireLifecycleSnapshotOwner(snapshot, conversationId);
            if (!lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
            if (journals.has(conversationId) || approvals.has(conversationId) || [...restoreRecords.values()].some(entry => entry.plan.conversationId === conversationId)
                || lifecycleStages.has(conversationId)) throw new AgentFault('REVISION_CONFLICT', '临时工作区目标已有原记录');
            const nextJournal = new MemoryWorkspaceJournal(store.temporaryMemoryBudget.maxConversationBytes);
            const restore = nextJournal as MemoryWorkspaceJournal & { restoreConversationLifecycle?(input: { conversationId: string; revision: number; actions: ChangeAction[] }): void };
            if (!restore.restoreConversationLifecycle && (snapshot.actions.length || snapshot.journalRevision !== 0)) throw new AgentFault('RETENTION_TRANSITION_BUSY', '工作区原版本恢复入口尚未接入', { requiredFactory: 'MemoryWorkspaceJournal.restoreConversationLifecycle' });
            const nextApprovals = new MemoryApprovalStore(), nextSizes = new Map<string, number>();
            const nextPlans = new Map<string, { plan: StoredRestorePlan; bytes: number }>();
            let journalBytes = 0, approvalBytes = 0, restoreBytes = 0, settled = false;
            const discard = () => {
                if (settled) return;
                settled = true; lifecycleStages.delete(conversationId); nextJournal.clear(conversationId);
                journalBudget.release(conversationId, journalBytes); approvalBudget.release(conversationId, approvalBytes); restoreBudget.release(conversationId, restoreBytes);
            };
            try {
                const actions: ChangeAction[] = [];
                for (const input of snapshot.actions) {
                    if (input.conversationId !== conversationId || input.retention.mode !== 'temporary') throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '工作区迁移的会话或保存归属不同');
                    const { beforeBase64, afterBase64, ...metadata } = input;
                    const rawBytes = (beforeBase64 === null ? 0 : Buffer.byteLength(beforeBase64, 'base64')) + Buffer.byteLength(afterBase64, 'base64');
                    const bytes = rawBytes + measureCanonicalJsonBytes(metadata, { maxBytes: 65536 }) + 65536;
                    journalBudget.reserve(conversationId, bytes); journalBytes += bytes;
                    actions.push({ ...metadata, before: beforeBase64 === null ? null : Buffer.from(beforeBase64, 'base64'), after: Buffer.from(afterBase64, 'base64') });
                }
                journalBudget.reserve(conversationId, journalBytes * 2, 'scratch');
                try { restore.restoreConversationLifecycle?.({ conversationId, revision: snapshot.journalRevision, actions }); }
                finally { for (const action of actions) { action.before?.fill(0); action.after.fill(0); } journalBudget.release(conversationId, journalBytes * 2, 'scratch'); }
                await nextApprovals.transaction(transaction => {
                    for (const ticket of snapshot.tickets) {
                        if (ticket.conversationId !== conversationId || nextSizes.has(`ticket:${ticket.approvalId}`)) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '批准迁移的归属或ID不同');
                        const bytes = measureCanonicalJsonBytes(ticket, { maxBytes: 65536 }); approvalBudget.reserve(conversationId, bytes); approvalBytes += bytes;
                        nextSizes.set(`ticket:${ticket.approvalId}`, bytes); transaction.put(ticket);
                    }
                    for (const receipt of snapshot.approvalReceipts) {
                        if (receiptConversation(receipt.key, approvalId => transaction.get(approvalId)?.conversationId) !== conversationId
                            || nextSizes.has(`receipt:${receipt.key}`)) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '批准回执迁移的归属或ID不同');
                        const bytes = measureCanonicalJsonBytes({ hash: receipt.hash, value: receipt.value }, { maxBytes: 65536 });
                        approvalBudget.reserve(conversationId, bytes); approvalBytes += bytes;
                        nextSizes.set(`receipt:${receipt.key}`, bytes); transaction.putReceipt(receipt.key, receipt.hash, receipt.value);
                    }
                });
                for (const plan of snapshot.restorePlans) {
                    if (plan.conversationId !== conversationId || nextPlans.has(plan.restorePlanId) || restoreRecords.has(plan.restorePlanId)) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '恢复计划迁移的归属或ID不同');
                    const bytes = measureCanonicalJsonBytes(plan); restoreBudget.reserve(conversationId, bytes); restoreBytes += bytes;
                    nextPlans.set(plan.restorePlanId, { plan: structuredClone(plan), bytes });
                }
                lifecycleStages.set(conversationId, discard);
                return { discard, activate: () => {
                    if (settled) return;
                    settled = true; lifecycleStages.delete(conversationId);
                    journals.set(conversationId, nextJournal); journalHeld.set(conversationId, journalBytes);
                    approvals.set(conversationId, nextApprovals); approvalSizes.set(conversationId, nextSizes);
                    for (const ticket of snapshot.tickets) ticketOwners.set(ticket.approvalId, conversationId);
                    for (const [planId, plan] of nextPlans) { restoreRecords.set(planId, plan); purgedRestoreIds.delete(planId); }
                    purgedRestoreConversations.delete(conversationId);
                } };
            } catch (error) { discard(); throw error; }
        },
        releaseConversationLifecycle(conversationId: string): void {
            if (!lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
            clear(conversationId, false);
        },
    };
    const created = { journal, approvalStore, pendingTools: createAgentPendingToolStore(store), restorePlans, lifecycle };
    workspaces.set(store, created);
    return created;
}

type AgentWorkspacePorts = { journal: WorkspaceJournalPort; approvalStore: ApprovalStorePort;
    pendingTools: ReturnType<typeof createAgentPendingToolStore>; restorePlans: RestorePlanStorePort;
    lifecycle: { freezeConversationLifecycle(conversationId: string): Promise<() => void>;
        captureConversationLifecycle(conversationId: string): Promise<LifecycleCapture<LifecycleWorkspaceSnapshot>>;
        stageConversationLifecycle(snapshot: LifecycleWorkspaceSnapshot): Promise<LifecycleStage>;
        releaseConversationLifecycle(conversationId: string): void } };
const workspaces = new WeakMap<AgentStore, AgentWorkspacePorts>();
