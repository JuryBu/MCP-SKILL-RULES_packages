import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import type { ApprovalStorePort, ApprovalTicket, ApprovalTransaction, ApprovalQuery } from '../security/approvals.js';
import type { PendingToolRecord, PendingToolQuery, PendingToolSummary, PendingToolStorePort } from '../tools/pending-types.js';
import type { ChangeAction, WorkspaceJournalPort } from '../workspace/journal.js';
import type { FileCommitReceipt } from '../workspace/versions.js';
import type { CoreRestorePort } from '../workspace/restore.js';

export type RestoreHistoryCommit = Parameters<CoreRestorePort['commitHistory']>[0] & {
    conversationId: string; principalId: string; policyRevision: number;
};

export interface WireChangeAction extends Omit<ChangeAction, 'before' | 'after'> {
    beforeBase64: string | null;
    afterBase64: string;
}

export interface StoredRestorePlan {
    restorePlanId: string;
    conversationId: string;
    principalId: string;
    mode: 'files_only' | 'round_restart';
    historyEpoch: number;
    workspaceRevision: number;
    policyRevision: number;
    state: 'preview' | 'committing' | 'complete' | 'pending';
    actionIds: string[];
    data: Record<string, unknown>;
    revision: number;
}

export interface RestorePlanStorePort {
    readonly persistence: 'memory' | 'durable';
    get(restorePlanId: string): Promise<StoredRestorePlan | undefined>;
    put(plan: StoredRestorePlan, expectedRevision: number | null): Promise<StoredRestorePlan>;
}

export interface ApprovalVersion {
    kind: 'ticket' | 'receipt';
    key: string;
    revision: number | null;
}

export interface ApprovalSnapshotEntry extends ApprovalVersion {
    value: ApprovalTicket | { hash: string; value: unknown } | null;
}

export type WorkspaceCommand =
    | { type: 'change.prepare'; action: WireChangeAction }
    | { type: 'change.settle'; conversationId: string; actionId: string; receipt?: FileCommitReceipt; errorCode?: string; unknown?: boolean }
    | { type: 'restore.put'; plan: StoredRestorePlan; expectedRevision: number | null }
    | { type: 'restore.history'; input: RestoreHistoryCommit }
    | { type: 'pending.put'; record: PendingToolRecord; expectedRevision: number | null }
    | { type: 'approval.commit'; expected: ApprovalVersion[]; tickets: ApprovalTicket[]; receipts: { key: string; hash: string; value: unknown }[] };

export type WorkspaceQuery =
    | { type: 'change.get'; conversationId: string; actionId: string }
    | { type: 'change.list'; conversationId: string; cursor?: string; limit?: number; maxBytes?: number; pendingOnly?: boolean }
    | { type: 'workspace.revision'; conversationId: string }
    | { type: 'recovery.list'; conversationId: string; cursor?: string; limit?: number; maxBytes?: number }
    | { type: 'restore.get'; restorePlanId: string }
    | { type: 'pending.get'; pendingToolId: string }
    | { type: 'pending.list'; query: PendingToolQuery }
    | { type: 'approval.list'; query: ApprovalQuery }
    | { type: 'approval.snapshot'; tickets: string[]; receipts: string[] };

export type WorkspaceMutationResult =
    | { kind: 'change'; action: WireChangeAction }
    | { kind: 'restore'; plan: StoredRestorePlan }
    | { kind: 'restore_history'; receipt: Record<string, unknown> }
    | { kind: 'pending'; record: PendingToolRecord }
    | { kind: 'approval'; committed: true };

export type WorkspaceReadResult =
    | { kind: 'change'; action: WireChangeAction | null }
    | { kind: 'changes'; actions: WireChangeAction[]; nextCursor: string | null }
    | { kind: 'revision'; revision: number }
    | { kind: 'restore'; plan: StoredRestorePlan | null }
    | { kind: 'pending'; record: PendingToolRecord | null }
    | { kind: 'pending_list'; items: PendingToolSummary[]; nextCursor: string | null }
    | { kind: 'approval_list'; tickets: ApprovalTicket[]; nextCursor: string | null }
    | { kind: 'approval_snapshot'; entries: ApprovalSnapshotEntry[] };

export interface WorkspaceRpcStore {
    readonly capabilities: { persistent: boolean };
    executeWorkspace(command: WorkspaceCommand): Promise<WorkspaceMutationResult>;
    readWorkspace(query: WorkspaceQuery): Promise<WorkspaceReadResult>;
}

function requireStore(store: WorkspaceRpcStore): void {
    if (store.capabilities?.persistent !== true || typeof store.executeWorkspace !== 'function' || typeof store.readWorkspace !== 'function') {
        throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '持久工作区端口需要已接入workspace.execute/read的SQLite worker');
    }
}

export function encodeChangeAction(action: ChangeAction): WireChangeAction {
    const { before, after, ...metadata } = action;
    return { ...structuredClone(metadata), beforeBase64: before === null ? null : Buffer.from(before).toString('base64'),
        afterBase64: Buffer.from(after).toString('base64') };
}

export function decodeChangeAction(action: WireChangeAction): ChangeAction {
    const { beforeBase64, afterBase64, ...metadata } = action;
    return { ...structuredClone(metadata), before: beforeBase64 === null ? null : Buffer.from(beforeBase64, 'base64'),
        after: Buffer.from(afterBase64, 'base64') };
}

export class SqliteWorkspaceJournal implements WorkspaceJournalPort {
    readonly persistence = 'durable' as const;
    readonly supportedRetentions = ['archive', 'ttl'] as const;
    constructor(readonly store: WorkspaceRpcStore) { requireStore(store); }

    async get(conversationId: string, actionId: string): Promise<ChangeAction | undefined> {
        const result = await this.store.readWorkspace({ type: 'change.get', conversationId, actionId });
        if (result.kind !== 'change') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区读取回执类型无效');
        return result.action ? decodeChangeAction(result.action) : undefined;
    }

    async listPage(conversationId: string, input: { cursor?: string; limit?: number; maxBytes?: number } = {}): Promise<{ actions: ChangeAction[]; nextCursor: string | null }> {
        const result = await this.store.readWorkspace({ type: 'change.list', conversationId, ...input });
        if (result.kind !== 'changes') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区分页回执类型无效');
        return { actions: result.actions.map(decodeChangeAction), nextCursor: result.nextCursor };
    }

    async list(conversationId: string): Promise<ChangeAction[]> {
        const actions: ChangeAction[] = [];
        let cursor: string | undefined;
        let bytes = 0;
        do {
            const page = await this.store.readWorkspace({ type: 'change.list', conversationId, cursor, limit: 24, maxBytes: 32 * 1024 * 1024 });
            if (page.kind !== 'changes') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区分页回执类型无效');
            for (const action of page.actions) {
                const decoded = decodeChangeAction(action);
                bytes += (decoded.before?.length ?? 0) + decoded.after.length;
                if (bytes > 64 * 1024 * 1024 || actions.length >= 1024) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '工作区完整字节读取超过预算，请按动作或分页读取', { nextCursor: cursor ?? null });
                actions.push(decoded);
            }
            if (page.nextCursor === cursor) throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区分页没有前进');
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return actions;
    }

    async revision(conversationId: string): Promise<number> {
        const result = await this.store.readWorkspace({ type: 'workspace.revision', conversationId });
        if (result.kind !== 'revision') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区版本回执类型无效');
        return result.revision;
    }

    async prepare(action: ChangeAction): Promise<void> {
        const result = await this.store.executeWorkspace({ type: 'change.prepare', action: encodeChangeAction(action) });
        if (result.kind !== 'change') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区prepared回执类型无效');
    }

    async settle(conversationId: string, actionId: string, result: { receipt?: FileCommitReceipt; errorCode?: string; unknown?: boolean }): Promise<ChangeAction> {
        const reply = await this.store.executeWorkspace({ type: 'change.settle', conversationId, actionId, ...result });
        if (reply.kind !== 'change') throw new AgentFault('STORAGE_RESPONSE_INVALID', '工作区提交回执类型无效', undefined, true);
        return decodeChangeAction(reply.action);
    }
}

class ApprovalLoadRequired extends Error {
    constructor(readonly kind: 'ticket' | 'receipt', readonly key: string) { super('approval snapshot required'); }
}

export class SqliteApprovalStore implements ApprovalStorePort {
    constructor(readonly store: WorkspaceRpcStore) { requireStore(store); }

    async getTicket(approvalId: string): Promise<ApprovalTicket | undefined> {
        const result = await this.store.readWorkspace({ type: 'approval.snapshot', tickets: [approvalId], receipts: [] });
        if (result.kind !== 'approval_snapshot') throw new AgentFault('STORAGE_RESPONSE_INVALID', '批准读取回执无效');
        return result.entries[0]?.value as ApprovalTicket ?? undefined;
    }
    async listTickets(query: ApprovalQuery): Promise<{ tickets: ApprovalTicket[]; nextCursor: string | null }> {
        const result = await this.store.readWorkspace({ type: 'approval.list', query });
        if (result.kind !== 'approval_list') throw new AgentFault('STORAGE_RESPONSE_INVALID', '批准列表回执无效');
        return { tickets: result.tickets, nextCursor: result.nextCursor };
    }

    async transaction<Value>(operation: (transaction: ApprovalTransaction) => Value): Promise<Value> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const snapshot = new Map<string, ApprovalSnapshotEntry>();
            const ticketWrites = new Map<string, ApprovalTicket>();
            const receiptWrites = new Map<string, { key: string; hash: string; value: unknown }>();
            const identity = (kind: string, key: string) => JSON.stringify([kind, key]);
            const read = (kind: 'ticket' | 'receipt', key: string): ApprovalSnapshotEntry => {
                const entry = snapshot.get(identity(kind, key));
                if (!entry) throw new ApprovalLoadRequired(kind, key);
                return entry;
            };
            let value!: Value;
            for (let loads = 0; loads < 64; loads++) {
                ticketWrites.clear();
                receiptWrites.clear();
                try {
                    value = operation({
                        get: key => structuredClone(ticketWrites.get(key) ?? read('ticket', key).value ?? undefined) as ApprovalTicket | undefined,
                        put: ticket => {
                            const key = identity('ticket', ticket.approvalId);
                            if (!snapshot.has(key)) snapshot.set(key, { kind: 'ticket', key: ticket.approvalId, revision: null, value: null });
                            ticketWrites.set(ticket.approvalId, structuredClone(ticket));
                        },
                        getReceipt: key => structuredClone(receiptWrites.get(key) ?? read('receipt', key).value ?? undefined) as { hash: string; value: unknown } | undefined,
                        putReceipt: (key, hash, receipt) => { read('receipt', key); receiptWrites.set(key, { key, hash, value: structuredClone(receipt) }); },
                    });
                    if (value && typeof (value as { then?: unknown }).then === 'function') throw new AgentFault('INVALID_PARAMS', '批准事务callback必须同步完成');
                    break;
                } catch (error) {
                    if (!(error instanceof ApprovalLoadRequired)) throw error;
                    const result = await this.store.readWorkspace({ type: 'approval.snapshot', tickets: error.kind === 'ticket' ? [error.key] : [], receipts: error.kind === 'receipt' ? [error.key] : [] });
                    if (result.kind !== 'approval_snapshot' || result.entries.length !== 1) throw new AgentFault('STORAGE_RESPONSE_INVALID', '批准快照回执无效');
                    snapshot.set(identity(error.kind, error.key), result.entries[0]);
                    if (loads === 63) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '批准事务读取对象过多');
                }
            }
            try {
                const result = await this.store.executeWorkspace({ type: 'approval.commit', expected: [...snapshot.values()].map(({ kind, key, revision }) => ({ kind, key, revision })),
                    tickets: [...ticketWrites.values()], receipts: [...receiptWrites.values()] });
                if (result.kind !== 'approval') throw new AgentFault('STORAGE_RESPONSE_INVALID', '批准事务提交回执无效');
                return structuredClone(value);
            } catch (error) {
                if (!(error instanceof AgentFault) || error.code !== 'WORKSPACE_CAS_CONFLICT' || attempt === 3) throw error;
            }
        }
        throw new AgentFault('WORKSPACE_CAS_CONFLICT', '批准数据持续变化，请重新读取当前待办');
    }
}

export class SqliteRestorePlanStore implements RestorePlanStorePort {
    readonly persistence = 'durable' as const;
    constructor(readonly store: WorkspaceRpcStore) { requireStore(store); }
    async get(restorePlanId: string): Promise<StoredRestorePlan | undefined> {
        const result = await this.store.readWorkspace({ type: 'restore.get', restorePlanId });
        if (result.kind !== 'restore') throw new AgentFault('STORAGE_RESPONSE_INVALID', '撤回计划读取回执无效');
        return result.plan ?? undefined;
    }
    async put(plan: StoredRestorePlan, expectedRevision: number | null): Promise<StoredRestorePlan> {
        const result = await this.store.executeWorkspace({ type: 'restore.put', plan, expectedRevision });
        if (result.kind !== 'restore') throw new AgentFault('STORAGE_RESPONSE_INVALID', '撤回计划提交回执无效');
        return result.plan;
    }
}

export class SqlitePendingToolStore implements PendingToolStorePort {
    readonly persistence = 'durable' as const;
    constructor(readonly store: WorkspaceRpcStore) { requireStore(store); }
    async get(pendingToolId: string): Promise<PendingToolRecord | undefined> {
        const result = await this.store.readWorkspace({ type: 'pending.get', pendingToolId });
        if (result.kind !== 'pending') throw new AgentFault('STORAGE_RESPONSE_INVALID', '等待工具读取回执无效');
        return result.record ?? undefined;
    }
    async put(record: PendingToolRecord, expectedRevision: number | null): Promise<PendingToolRecord> {
        const result = await this.store.executeWorkspace({ type: 'pending.put', record, expectedRevision });
        if (result.kind !== 'pending') throw new AgentFault('STORAGE_RESPONSE_INVALID', '等待工具提交回执无效');
        return result.record;
    }
    async list(query: PendingToolQuery): Promise<{ items: PendingToolSummary[]; nextCursor: string | null }> {
        const result = await this.store.readWorkspace({ type: 'pending.list', query });
        if (result.kind !== 'pending_list') throw new AgentFault('STORAGE_RESPONSE_INVALID', '等待工具列表回执无效');
        return { items: result.items, nextCursor: result.nextCursor };
    }
}

export function createSqliteWorkspacePorts(store: WorkspaceRpcStore): { journal: SqliteWorkspaceJournal; approvalStore: SqliteApprovalStore; restorePlans: SqliteRestorePlanStore; pendingTools: SqlitePendingToolStore } {
    requireStore(store);
    return { journal: new SqliteWorkspaceJournal(store), approvalStore: new SqliteApprovalStore(store), restorePlans: new SqliteRestorePlanStore(store), pendingTools: new SqlitePendingToolStore(store) };
}

export function approvalStorageId(kind: 'ticket' | 'receipt', key: string): { kind: string; id: string } {
    return { kind: kind === 'ticket' ? 'workspaceApprovalTicket' : 'workspaceApprovalReceipt',
        id: kind === 'ticket' ? key : createHash('sha256').update(key).digest('hex') };
}
