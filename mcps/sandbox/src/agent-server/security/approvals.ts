import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { BoundToolContext } from '../tools/types.js';

export interface ApprovalTicket {
    approvalId: string;
    principalId: string;
    conversationId: string;
    runId: string;
    runEpoch: number;
    actionIds: string[];
    argsHashes: string[];
    scope: { paths: string[]; effects: string[]; reason: string };
    policyRevision: number;
    expiresAt: string;
    maxUses: number;
    uses: number;
    decision: 'pending' | 'approve' | 'deny';
    pendingToolId?: string;
    closedReason?: 'cancelled' | 'timed_out';
}

export interface ApprovalScope { principalId: string; conversationId: string; runId?: string }
export interface ApprovalQuery extends ApprovalScope { cursor?: string; limit?: number }
export interface ApprovalPage { tickets: ApprovalTicket[]; nextCursor: string | null }
export interface ApprovalDecisionInput {
    approvalId: string;
    principalId: string;
    conversationId: string;
    runId: string;
    policyRevision: number;
    decision: 'approve' | 'deny';
    clientId: string;
    clientCommandId: string;
    runEpoch?: number;
}

export interface ApprovalTransaction {
    get(approvalId: string): ApprovalTicket | undefined;
    put(ticket: ApprovalTicket): void;
    getReceipt(key: string): { hash: string; value: unknown } | undefined;
    putReceipt(key: string, hash: string, value: unknown): void;
}

export interface ApprovalStorePort {
    transaction<Value>(operation: (transaction: ApprovalTransaction) => Value): Promise<Value>;
    getTicket(approvalId: string): Promise<ApprovalTicket | undefined>;
    listTickets(query: ApprovalQuery): Promise<{ tickets: ApprovalTicket[]; nextCursor: string | null }>;
}

export class MemoryApprovalStore implements ApprovalStorePort {
    private readonly tickets = new Map<string, ApprovalTicket>();
    private readonly receipts = new Map<string, { hash: string; value: unknown }>();

    async getTicket(approvalId: string): Promise<ApprovalTicket | undefined> { return structuredClone(this.tickets.get(approvalId)); }
    async listTickets(query: ApprovalQuery): Promise<{ tickets: ApprovalTicket[]; nextCursor: string | null }> {
        const offset = query.cursor ? Number(query.cursor) : 0;
        const limit = query.limit ?? 24;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentFault('INVALID_PARAMS', '批准分页参数无效');
        const all = [...this.tickets.values()].filter(ticket => ticket.principalId === query.principalId && ticket.conversationId === query.conversationId
            && (!query.runId || ticket.runId === query.runId)).sort((first, second) => first.approvalId.localeCompare(second.approvalId));
        return { tickets: structuredClone(all.slice(offset, offset + limit)), nextCursor: offset + limit < all.length ? String(offset + limit) : null };
    }

    async transaction<Value>(operation: (transaction: ApprovalTransaction) => Value): Promise<Value> {
        const tickets = structuredClone(this.tickets);
        const receipts = structuredClone(this.receipts);
        const result = operation({ get: key => structuredClone(tickets.get(key)), put: ticket => { tickets.set(ticket.approvalId, structuredClone(ticket)); },
            getReceipt: key => structuredClone(receipts.get(key)), putReceipt: (key, hash, value) => { receipts.set(key, { hash, value: structuredClone(value) }); } });
        this.tickets.clear();
        this.receipts.clear();
        for (const [key, ticket] of tickets) this.tickets.set(key, ticket);
        for (const [key, receipt] of receipts) this.receipts.set(key, receipt);
        return structuredClone(result);
    }
}

export class ApprovalLedger {
    constructor(readonly store: ApprovalStorePort = new MemoryApprovalStore(), readonly now: () => number = Date.now) {}

    async get(approvalId: string, scope: ApprovalScope): Promise<ApprovalTicket | undefined> {
        const ticket = await this.store.getTicket(approvalId);
        if (!ticket || ticket.principalId !== scope.principalId || ticket.conversationId !== scope.conversationId || (scope.runId && ticket.runId !== scope.runId)) return undefined;
        return ticket;
    }

    list(query: ApprovalQuery): Promise<{ tickets: ApprovalTicket[]; nextCursor: string | null }> { return this.store.listTickets(query); }

    async closePending(approvalId: string, pendingToolId: string, scope: ApprovalScope, reason: 'cancelled' | 'timed_out'): Promise<void> {
        await this.store.transaction(transaction => {
            const ticket = transaction.get(approvalId);
            if (!ticket || ticket.pendingToolId !== pendingToolId || ticket.principalId !== scope.principalId
                || ticket.conversationId !== scope.conversationId || (scope.runId && ticket.runId !== scope.runId)) throw new AgentFault('APPROVAL_STALE', '原工具批准待办不属于当前主体');
            if (ticket.closedReason) return;
            ticket.closedReason = reason;
            transaction.put(ticket);
        });
    }

    async request(context: BoundToolContext, argsHash: string, scope: ApprovalTicket['scope'], options: { pendingToolId?: string; expiresAt?: string } = {}): Promise<ApprovalTicket> {
        const expires = Math.min(this.now() + 15 * 60 * 1000, options.expiresAt ? Date.parse(options.expiresAt) : Infinity);
        if (!Number.isFinite(expires) || expires <= this.now()) throw new AgentFault('APPROVAL_STALE', '批准待办期限无效或已到期');
        const key = canonicalJson(['request', context.principalId, context.conversationId, context.runId, context.actionId, argsHash, context.policyRevision]);
        return this.store.transaction(transaction => {
            const previous = transaction.getReceipt(key);
            if (previous) {
                const existing = transaction.get(previous.value as string)!;
                if (options.pendingToolId && existing.pendingToolId !== options.pendingToolId) {
                    if (existing.pendingToolId) throw new AgentFault('APPROVAL_STALE', '批准票据已绑定其他原工具动作');
                    existing.pendingToolId = options.pendingToolId;
                    existing.runEpoch = context.runEpoch;
                    transaction.put(existing);
                }
                return existing;
            }
            const ticket: ApprovalTicket = { approvalId: randomUUID(), principalId: context.principalId, conversationId: context.conversationId,
                runId: context.runId, runEpoch: context.runEpoch, actionIds: [context.actionId], argsHashes: [argsHash], scope: structuredClone(scope), policyRevision: context.policyRevision,
                expiresAt: new Date(expires).toISOString(),
                maxUses: 1, uses: 0, decision: 'pending', ...(options.pendingToolId ? { pendingToolId: options.pendingToolId } : {}) };
            transaction.put(ticket);
            transaction.putReceipt(key, argsHash, ticket.approvalId);
            return ticket;
        });
    }

    async bindPendingExecution(approvalId: string, pendingToolId: string, context: BoundToolContext, argsHash: string): Promise<void> {
        await this.store.transaction(transaction => {
            const ticket = transaction.get(approvalId);
            if (!ticket || ticket.pendingToolId !== pendingToolId || ticket.principalId !== context.principalId || ticket.conversationId !== context.conversationId
                || ticket.runId !== context.runId || ticket.policyRevision !== context.policyRevision || !ticket.actionIds.includes(context.actionId)
                || ticket.argsHashes[ticket.actionIds.indexOf(context.actionId)] !== argsHash || ticket.runEpoch > context.runEpoch
                || Date.parse(ticket.expiresAt) <= this.now() || ticket.closedReason || ticket.decision !== 'approve') throw new AgentFault('APPROVAL_STALE', '原动作的批准或执行代际已失效');
            if (ticket.runEpoch !== context.runEpoch) { ticket.runEpoch = context.runEpoch; transaction.put(ticket); }
        });
    }

    async respond(input: ApprovalDecisionInput): Promise<ApprovalTicket> {
        return this.store.transaction(transaction => {
            const ticket = transaction.get(input.approvalId);
            const key = canonicalJson(['respond', input.principalId, input.clientId, input.conversationId, input.clientCommandId]);
            const { runEpoch: ignoredEpoch, ...decisionCommand } = input;
            const hash = createHash('sha256').update(canonicalJson(decisionCommand)).digest('hex');
            const receipt = transaction.getReceipt(key);
            if (receipt) {
                if (receipt.hash !== hash) throw new AgentFault('COMMAND_ID_REUSED', '该客户端命令已用于其他批准答复');
                return receipt.value as ApprovalTicket;
            }
            if (!ticket || ticket.principalId !== input.principalId || ticket.conversationId !== input.conversationId || ticket.runId !== input.runId
                || ticket.policyRevision !== input.policyRevision || ticket.closedReason || Date.parse(ticket.expiresAt) <= this.now() || ticket.decision !== 'pending') {
                throw new AgentFault('APPROVAL_STALE', '批准待办已过期、已答复或授权版本变化');
            }
            if (input.runEpoch !== undefined) {
                if (!ticket.pendingToolId || input.runEpoch < ticket.runEpoch) throw new AgentFault('APPROVAL_STALE', '批准答复的执行代际无效');
                ticket.runEpoch = input.runEpoch;
            }
            ticket.decision = input.decision;
            transaction.put(ticket);
            transaction.putReceipt(key, hash, ticket);
            return ticket;
        });
    }

    async consume(approvalId: string, context: BoundToolContext, argsHash: string): Promise<void> {
        await this.store.transaction(transaction => {
            const ticket = transaction.get(approvalId);
            const index = ticket?.actionIds.indexOf(context.actionId) ?? -1;
            if (!ticket || ticket.principalId !== context.principalId || ticket.conversationId !== context.conversationId || ticket.runId !== context.runId || ticket.runEpoch !== context.runEpoch
                || ticket.policyRevision !== context.policyRevision || ticket.closedReason || Date.parse(ticket.expiresAt) <= this.now()
                || index < 0 || ticket.argsHashes[index] !== argsHash) throw new AgentFault('APPROVAL_STALE', '批准范围、动作参数或授权版本变化');
            if (ticket.decision !== 'approve') throw new AgentFault('APPROVAL_REQUIRED', '该动作尚未取得可信调用方批准', { approvalId });
            const key = canonicalJson(['consume', approvalId, context.actionId, argsHash]);
            if (transaction.getReceipt(key)) return;
            if (ticket.uses >= ticket.maxUses) throw new AgentFault('APPROVAL_STALE', '批准的使用次数已经用完');
            ticket.uses++;
            transaction.put(ticket);
            transaction.putReceipt(key, argsHash, true);
        });
    }
}
