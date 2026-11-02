import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import { pathIdentity } from '../security/policy.js';
import type { ApprovalLedger, ApprovalTicket } from '../security/approvals.js';
import type { WorkspaceJournalPort } from '../workspace/journal.js';
import { fileOperationSchemas } from '../workspace/file-operations.js';
import type { BoundToolContext, ToolExecutionResult } from './types.js';
import { assertPendingTransition, summarizePending, TERMINAL_PENDING_STATES } from './pending-types.js';
import type { FrozenToolInvocation, PendingToolCompletion, PendingToolQuery, PendingToolRecord, PendingToolStorePort } from './pending-types.js';

export class MemoryPendingToolStore implements PendingToolStorePort {
    readonly persistence = 'memory' as const;
    private readonly records = new Map<string, PendingToolRecord>();
    async get(pendingToolId: string): Promise<PendingToolRecord | undefined> { return structuredClone(this.records.get(pendingToolId)); }
    async put(record: PendingToolRecord, expectedRevision: number | null): Promise<PendingToolRecord> {
        const previous = this.records.get(record.pendingToolId);
        if ((previous?.revision ?? null) !== expectedRevision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '原工具等待项版本已变化');
        assertPendingTransition(record, previous);
        const next = { ...structuredClone(record), revision: (expectedRevision ?? 0) + 1 };
        this.records.set(record.pendingToolId, next);
        return structuredClone(next);
    }
    async list(query: PendingToolQuery) {
        const offset = query.cursor ? Number(query.cursor) : 0;
        const limit = query.limit ?? 24;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentFault('INVALID_PARAMS', '原工具等待项分页参数无效');
        const all = [...this.records.values()].filter(record => record.frozen.principalId === query.principalId
            && record.frozen.conversationId === query.conversationId && (!query.runId || record.frozen.runId === query.runId)
            && (query.includeTerminal || !TERMINAL_PENDING_STATES.includes(record.state))).sort((first, second) => first.pendingToolId.localeCompare(second.pendingToolId));
        return { items: all.slice(offset, offset + limit).map(summarizePending), nextCursor: offset + limit < all.length ? String(offset + limit) : null };
    }
}

function invocationId(origin: FrozenToolInvocation): string {
    const bytes = createHash('sha256').update(canonicalJson(['sandbox-agent-pending/v1', origin.conversationId, origin.runId, origin.actionId])).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class PendingToolCoordinator {
    private readonly active = new Map<string, { controller: AbortController; promise: Promise<PendingToolCompletion> }>();
    constructor(readonly store: PendingToolStorePort, readonly approvals: ApprovalLedger, readonly journal: WorkspaceJournalPort,
        readonly executeFrozen: (name: string, args: unknown, context: BoundToolContext) => Promise<ToolExecutionResult>, readonly now: () => number = Date.now) {}

    async capture(name: string, args: Record<string, unknown>, context: BoundToolContext, scope: ApprovalTicket['scope']): Promise<{ record: PendingToolRecord; ticket: ApprovalTicket }> {
        if (!context.stepId) throw new AgentFault('PENDING_TOOL_ORIGIN_REQUIRED', '等待批准前需要核心传入原stepId与callId');
        if (context.retention.mode !== 'temporary' && this.store.persistence !== 'durable') throw new AgentFault('PENDING_TOOL_STORE_REQUIRED', '持久会话需要持久保存原工具调用后再等待批准');
        const frozen: FrozenToolInvocation = { name, args: JSON.parse(canonicalJson(args)), argsHash: createHash('sha256').update(canonicalJson({ name, args })).digest('hex'),
            principalId: context.principalId, conversationId: context.conversationId, runId: context.runId, rootRunId: context.rootRunId,
            originalRunEpoch: context.runEpoch, roundId: context.roundId, stepId: context.stepId, actionId: context.actionId,
            attemptId: context.attemptId, callId: context.callId ?? context.actionId, providerCallId: context.providerCallId ?? null,
            providerProtocol: context.providerProtocol, modelContentId: context.modelContentId, rootBudgetId: context.rootBudgetId,
            roots: [...context.roots], protectedPaths: [...(context.protectedPaths ?? [])], approvalRequiredTools: [...(context.approvalRequiredTools ?? [])],
            policyRevision: context.policyRevision, retention: context.retention };
        const pendingToolId = invocationId(frozen);
        let record = await this.store.get(pendingToolId);
        if (!record) {
            const expires = Math.min(this.now() + 15 * 60 * 1000, context.deadlineAt ? Date.parse(context.deadlineAt) : Infinity);
            if (!Number.isFinite(expires)) throw new AgentFault('INVALID_PARAMS', '原工具等待期限无效');
            if (expires <= this.now()) throw new AgentFault('PENDING_TOOL_TIMED_OUT', '原工具动作已到期');
            const fresh: PendingToolRecord = { pendingToolId, approvalId: null, frozen, executionEpoch: context.runEpoch, state: 'awaiting_approval',
                revision: 0, createdAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString(), expiresAt: new Date(expires).toISOString() };
            try { record = await this.store.put(fresh, null); }
            catch (error) {
                if (!(error instanceof AgentFault) || error.code !== 'WORKSPACE_CAS_CONFLICT') throw error;
                record = await this.store.get(pendingToolId);
            }
        }
        if (!record || record.frozen.argsHash !== frozen.argsHash || record.frozen.actionId !== frozen.actionId
            || record.frozen.stepId !== frozen.stepId || record.frozen.callId !== frozen.callId || record.frozen.attemptId !== frozen.attemptId) throw new AgentFault('COMMAND_ID_REUSED', '原工具调用与已保存的等待项不一致');
        let ticket = record.approvalId ? await this.approvals.get(record.approvalId, this.scope(context)) : undefined;
        if (!ticket) {
            ticket = await this.approvals.request(context, record.frozen.argsHash, scope, { pendingToolId, expiresAt: record.expiresAt });
            for (let attempt = 0; attempt < 4; attempt++) {
                const latest = await this.owned(pendingToolId, context);
                if (latest.approvalId === ticket.approvalId) { record = latest; break; }
                if (latest.state === 'cancelled' || latest.state === 'timed_out') {
                    await this.approvals.closePending(ticket.approvalId, pendingToolId, this.scope(context), latest.state);
                    record = latest;
                    break;
                }
                try {
                    record = await this.update(latest, { approvalId: ticket.approvalId,
                        expiresAt: new Date(Math.min(Date.parse(latest.expiresAt), Date.parse(ticket.expiresAt))).toISOString() });
                    break;
                } catch (error) { if (!(error instanceof AgentFault) || error.code !== 'WORKSPACE_CAS_CONFLICT' || attempt === 3) throw error; }
            }
        }
        return { record, ticket };
    }

    private scope(context: BoundToolContext) { return { principalId: context.principalId, conversationId: context.conversationId, runId: context.runId }; }
    private async owned(pendingToolId: string, context: BoundToolContext): Promise<PendingToolRecord> {
        const record = await this.store.get(pendingToolId);
        if (!record || record.frozen.principalId !== context.principalId || record.frozen.conversationId !== context.conversationId
            || record.frozen.runId !== context.runId || record.frozen.rootRunId !== context.rootRunId) throw new AgentFault('TOOL_NOT_ALLOWED', '原工具等待项未绑定当前可信执行');
        return record;
    }
    private async update(record: PendingToolRecord, patch: Partial<PendingToolRecord>): Promise<PendingToolRecord> {
        return this.store.put({ ...record, ...patch, updatedAt: new Date(this.now()).toISOString() }, record.revision);
    }
    private failure(record: PendingToolRecord, code: string, message: string, mayHaveStarted = false): ToolExecutionResult {
        return { ok: false, disposition: 'completed', error: { code, message, retryable: false, mayHaveStarted,
            actionId: record.frozen.actionId, attemptId: record.frozen.attemptId,
            details: { pendingToolId: record.pendingToolId, approvalId: record.approvalId } } };
    }
    private completion(record: PendingToolRecord): PendingToolCompletion {
        const { args, roots, protectedPaths, approvalRequiredTools, ...origin } = record.frozen;
        const ready = TERMINAL_PENDING_STATES.includes(record.state) && Boolean(record.result);
        return { pending: summarizePending(record), ready, operationId: `pending-tool-completion:${record.pendingToolId}`, origin,
            invocation: { name: record.frozen.name, args: structuredClone(record.frozen.args), argsHash: record.frozen.argsHash },
            ...(ready ? { toolResult: { callId: origin.callId, name: origin.name, result: JSON.parse(canonicalJson(record.result)) as JsonValue, isError: !record.result!.ok } } : {}) };
    }
    private async finish(record: PendingToolRecord, state: PendingToolRecord['state'], result: ToolExecutionResult): Promise<PendingToolCompletion> {
        for (let attempt = 0; attempt < 4; attempt++) {
            const latest = await this.store.get(record.pendingToolId);
            if (!latest) throw new AgentFault('NOT_FOUND', '原工具等待项不存在');
            if (TERMINAL_PENDING_STATES.includes(latest.state)) return this.completion(latest);
            try {
                const saved = await this.update(latest, { state, result });
                if ((state === 'cancelled' || state === 'timed_out') && saved.approvalId) await this.approvals.closePending(saved.approvalId, saved.pendingToolId,
                    { principalId: saved.frozen.principalId, conversationId: saved.frozen.conversationId, runId: saved.frozen.runId }, state);
                return this.completion(saved);
            }
            catch (error) { if (!(error instanceof AgentFault) || error.code !== 'WORKSPACE_CAS_CONFLICT' || attempt === 3) throw error; }
        }
        throw new AgentFault('WORKSPACE_CAS_CONFLICT', '原工具等待项持续变化');
    }

    async get(pendingToolId: string, context: BoundToolContext): Promise<PendingToolCompletion> {
        const record = await this.owned(pendingToolId, context);
        if (record.state === 'awaiting_approval' && Date.parse(record.expiresAt) <= this.now()) return this.cancel(pendingToolId, 'timed_out', context);
        return this.completion(record);
    }

    list(context: BoundToolContext, page: { cursor?: string; limit?: number; includeTerminal?: boolean } = {}) {
        return this.store.list({ ...this.scope(context), ...page });
    }

    async resume(pendingToolId: string, context: BoundToolContext): Promise<PendingToolCompletion> {
        await this.owned(pendingToolId, context);
        const existing = this.active.get(pendingToolId);
        if (existing) return existing.promise;
        const controller = new AbortController();
        const combined = { ...context, signal: AbortSignal.any([context.signal, controller.signal]) };
        const promise = this.perform(pendingToolId, combined);
        this.active.set(pendingToolId, { controller, promise });
        try { return await promise; }
        finally { if (this.active.get(pendingToolId)?.promise === promise) this.active.delete(pendingToolId); }
    }

    private async perform(pendingToolId: string, context: BoundToolContext): Promise<PendingToolCompletion> {
        let record = await this.owned(pendingToolId, context);
        if (TERMINAL_PENDING_STATES.includes(record.state)) return this.completion(record);
        const frozen = record.frozen;
        const localName = frozen.name.startsWith('local.') ? frozen.name.slice(6) : frozen.name;
        const controlledFile = localName === 'write_file' || Object.hasOwn(fileOperationSchemas, localName);
        const journalAction = controlledFile ? await this.journal.get(frozen.conversationId, frozen.actionId) : undefined;
        if (journalAction?.state === 'applied') return this.finish(record, 'completed', { ok: true, disposition: 'completed',
            data: { ...journalAction.receipt, workspaceRevision: journalAction.workspaceRevisionAfter, replayed: true } });
        if (journalAction && ['prepared', 'unknown'].includes(journalAction.state)) return this.finish(record, 'unknown', this.failure(record, 'RESTORE_PENDING', '原动作回执仍待核对，保留原调用且停止新增文件操作', true));
        if (journalAction?.state === 'failed') return this.finish(record, 'failed', this.failure(record, journalAction.errorCode ?? 'TOOL_IO_FAILED', '原文件动作已记录失败'));
        if (record.cancelReason) {
            if (record.state === 'cancelling' && context.runEpoch <= record.executionEpoch) return this.completion(record);
            return this.finish(record, record.cancelReason, this.failure(record, record.cancelReason === 'timed_out' ? 'TOOL_APPROVAL_TIMED_OUT' : 'TOOL_CANCELLED', '原工具等待已结束'));
        }
        if (Date.parse(record.expiresAt) <= this.now()) return this.requestStop(pendingToolId, 'timed_out', context, false);
        if (record.state === 'executing' && context.runEpoch <= record.executionEpoch) return this.completion(record);
        if (record.state === 'unknown' && context.runEpoch <= record.executionEpoch) return this.completion(record);
        if (!record.approvalId) {
            const captured = await this.capture(frozen.name, frozen.args, { ...context, ...this.identities(frozen) }, { paths: [], effects: [frozen.name], reason: '恢复原工具批准等待' });
            record = captured.record;
        }
        const ticket = await this.approvals.get(record.approvalId!, this.scope(context));
        if (!ticket) return this.finish(record, 'failed', this.failure(record, 'APPROVAL_STALE', '原批准票据已不可用'));
        if (ticket.decision === 'deny') return this.finish(record, 'denied', this.failure(record, 'TOOL_APPROVAL_DENIED', '可信调用方拒绝了原工具动作'));
        if (ticket.decision !== 'approve') return this.completion(record);
        if (!controlledFile) return this.finish(record, 'failed', this.failure(record, 'TOOL_CAPABILITY_UNVERIFIED', '当前原动作恢复仅启用获准根内的受控普通文件动作'));
        if (context.policyRevision !== frozen.policyRevision || canonicalJson(context.roots.map(pathIdentity)) !== canonicalJson(frozen.roots.map(pathIdentity))
            || canonicalJson(context.retention) !== canonicalJson(frozen.retention) || context.runEpoch < frozen.originalRunEpoch) {
            return this.finish(record, 'failed', this.failure(record, 'POLICY_CHANGED', '原动作等待期间的权限或保存方式已经变化'));
        }
        if (context.signal.aborted) return this.requestStop(pendingToolId, 'cancelled', context, false);
        const executionContext: BoundToolContext = { ...context, ...this.identities(frozen), roots: [...frozen.roots],
            protectedPaths: [...new Set([...(context.protectedPaths ?? []), ...frozen.protectedPaths])],
            approvalRequiredTools: [...frozen.approvalRequiredTools], approvalId: record.approvalId! };
        try {
            await context.assertCurrent?.();
            await this.approvals.bindPendingExecution(record.approvalId!, record.pendingToolId, executionContext, frozen.argsHash);
        } catch (error) {
            if (!(error instanceof AgentFault)) throw error;
            const state = Date.parse(ticket.expiresAt) <= this.now() ? 'timed_out' : error.code === 'TOOL_CANCELLED' ? 'cancelled' : 'failed';
            return this.finish(record, state, this.failure(record, state === 'timed_out' ? 'TOOL_APPROVAL_TIMED_OUT' : error.code, error.message));
        }
        const claimToken = randomUUID();
        try { record = await this.update(record, { state: 'executing', executionEpoch: context.runEpoch, claimToken }); }
        catch (error) {
            if (error instanceof AgentFault && error.code === 'WORKSPACE_CAS_CONFLICT') return this.completion(await this.owned(pendingToolId, context));
            if (error instanceof AgentFault && error.code === 'PENDING_TOOL_TIMED_OUT') return this.requestStop(pendingToolId, 'timed_out', context, false);
            throw error;
        }
        const assertCurrent = executionContext.assertCurrent;
        executionContext.pendingExecution = { pendingToolId, claimToken };
        executionContext.assertCurrent = async () => {
            await assertCurrent?.();
            const current = await this.store.get(pendingToolId);
            if (!current || current.claimToken !== claimToken || current.state !== 'executing' || current.cancelReason) throw new AgentFault('TOOL_CANCELLED', '原工具动作已停止当前执行者');
            if (Date.parse(current.expiresAt) <= this.now()) throw new AgentFault('TOOL_APPROVAL_TIMED_OUT', '原工具动作已到期');
        };
        let result: ToolExecutionResult;
        try { result = await this.executeFrozen(frozen.name, frozen.args, executionContext); }
        catch (error) { result = this.failure(record, error instanceof AgentFault ? error.code : 'TOOL_IO_FAILED', '原工具执行未正常返回', !(error instanceof AgentFault) || error.mayHaveStarted); }
        const latest = await this.owned(pendingToolId, context);
        const state = result.ok ? 'completed' : result.error?.mayHaveStarted ? 'unknown' : latest.cancelReason
            ?? (result.error?.code === 'TOOL_APPROVAL_TIMED_OUT' ? 'timed_out' : result.error?.code === 'TOOL_CANCELLED' ? 'cancelled' : 'failed');
        return this.finish(latest, state, { ...result, disposition: 'completed' });
    }

    private identities(frozen: FrozenToolInvocation) {
        return { actionId: frozen.actionId, attemptId: frozen.attemptId, roundId: frozen.roundId, stepId: frozen.stepId,
            callId: frozen.callId, providerCallId: frozen.providerCallId, providerProtocol: frozen.providerProtocol,
            modelContentId: frozen.modelContentId, rootBudgetId: frozen.rootBudgetId };
    }

    async cancel(pendingToolId: string, reason: 'cancelled' | 'timed_out', context: BoundToolContext): Promise<PendingToolCompletion> {
        return this.requestStop(pendingToolId, reason, context, true);
    }

    private async requestStop(pendingToolId: string, reason: 'cancelled' | 'timed_out', context: BoundToolContext, waitForActive: boolean): Promise<PendingToolCompletion> {
        let record = await this.owned(pendingToolId, context);
        if (TERMINAL_PENDING_STATES.includes(record.state)) return this.completion(record);
        if (record.state === 'executing' || record.state === 'cancelling') {
            record = await this.update(record, { state: 'cancelling', cancelReason: reason });
            const active = this.active.get(pendingToolId);
            if (active) { active.controller.abort(); if (waitForActive) return active.promise; }
            return this.completion(record);
        }
        if (record.state === 'unknown') return this.completion(record);
        return this.finish(record, reason, this.failure(record, reason === 'timed_out' ? 'TOOL_APPROVAL_TIMED_OUT' : 'TOOL_CANCELLED',
            reason === 'timed_out' ? '原工具等待批准已超时' : '原工具等待已取消'));
    }

    async cancelRun(reason: 'cancelled' | 'timed_out', context: BoundToolContext): Promise<PendingToolCompletion[]> {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.store.list({ ...this.scope(context), includeTerminal: true, limit: 100, cursor });
            ids.push(...page.items.filter(item => !TERMINAL_PENDING_STATES.includes(item.state)).map(item => item.pendingToolId));
            cursor = page.nextCursor ?? undefined;
            if (ids.length > 1024) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '待取消的原工具动作超过单次处理预算');
        } while (cursor);
        const completed: PendingToolCompletion[] = [];
        for (const id of ids) completed.push(await this.cancel(id, reason, context));
        return completed;
    }
}
