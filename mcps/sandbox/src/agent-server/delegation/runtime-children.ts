import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue, RpcResult } from '../protocol.js';
import type { AccountingPort, BudgetView, UpperBound } from '../accounting/budget-ledger.js';
import type { ConversationData, ExecutorStepWrite, RunData } from '../runtime.js';
import type { ContentWrite, StoreRecord } from '../storage/port.js';
import type { BoundToolContext } from '../tools/types.js';
import type { ProviderAttempt } from '../providers/types.js';
import { ProviderFault } from '../providers/types.js';
import type { DispatchJournalPort, PreparedDispatch } from '../providers/dispatch.js';
import { isWithin, pathIdentity } from '../security/policy.js';
import type { ChildLimits, ChildReceipt, ChildSelection, InternalDelegationPort, PreparedChild } from './contracts.js';
import { selectChildTools } from './tool-policy.js';
import type { ChildToolSelectionPolicy } from './tool-policy.js';

export interface ChildLink { childRunId: string; childConversationId: string; callKey: string; requestHash: string; inputHash: string;
    parentRoundId?: string; parentActionId?: string }
interface ChildAttempt { attemptId: string; snapshotHash: string; upperBound: UpperBound }
export interface ChildAllocation {
    parentConversationId: string;
    parentRunId: string;
    parentRunEpoch: number;
    parentRoundId?: string;
    parentActionId?: string;
    rulesHash: string;
    maxContextTokens: number;
    attempts: ChildAttempt[];
}

export interface InternalChildrenHooks {
    ready(): Promise<unknown>;
    serial<Value>(operation: () => Promise<Value>): Promise<Value>;
    now(): number;
    accepting(): boolean;
    executorAvailable(): boolean;
    retentionOwnershipAvailable(): boolean;
    readBudget: AccountingPort['read'];
    getConversation(conversationId: string): Promise<StoreRecord<ConversationData>>;
    getRun(conversationId: string, runId: string): Promise<StoreRecord<RunData>>;
    listRuns(conversationId: string): Promise<StoreRecord<RunData>[]>;
    readContent(conversationId: string, contentId: string): Promise<JsonValue | undefined>;
    commit(conversation: StoreRecord<ConversationData>, records: StoreRecord[], events: { type: string; payload: Record<string, unknown>; run?: RunData }[],
        data: unknown, contents?: ContentWrite[]): Promise<RpcResult>;
    createInput(conversationId: string, runId: string, content: JsonValue): { record: StoreRecord; content: ContentWrite };
    schedule(run: RunData): void;
    stop(conversation: StoreRecord<ConversationData>, record: StoreRecord<RunData>, reason: string): Promise<unknown>;
    cancelExecution(runId: string, reason: string): void;
    subscribe(listener: () => void): () => void;
}

export function childLinks(run: RunData): ChildLink[] { return Array.isArray(run.internalChildren) ? run.internalChildren as ChildLink[] : []; }
export function childAllocation(run: RunData): ChildAllocation | undefined { return run.internalDelegation as ChildAllocation | undefined; }
export function rememberChildChange(run: RunData, step: ExecutorStepWrite): void {
    if (!childAllocation(run) || step.kind !== 'tool' || step.result.isError) return;
    const result = step.result.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return;
    const data = result.data;
    if (result.ok !== true || !data || typeof data !== 'object' || Array.isArray(data)) return;
    const coverage = data.coverage && typeof data.coverage === 'object' && !Array.isArray(data.coverage) ? data.coverage : {};
    const actionIds = Array.isArray(coverage.actionIds) ? coverage.actionIds.filter((value): value is string => typeof value === 'string') : [];
    if (typeof data.workspaceRevision !== 'number' && !actionIds.length) return;
    const previous = Array.isArray(run.internalChangedActionIds) ? run.internalChangedActionIds as string[] : [];
    run.internalChangedActionIds = [...new Set([...previous, ...(actionIds.length ? actionIds : [step.actionId])])];
}
const settled = (run: RunData): boolean => ['succeeded', 'failed', 'cancelled'].includes(run.state)
    && ['released', 'not_needed'].includes(run.cleanupState);
const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function childInputHash(input: { taskKind: string; task: string; contextRefs: string[]; writeRoots: string[]; limits: ChildLimits }): string {
    return digest({ taskKind: input.taskKind, task: input.task, contextRefs: input.contextRefs,
        writeRoots: input.writeRoots.map(pathIdentity).sort(), limits: input.limits });
}

export function rootAvailability(ledger: BudgetView): { calls: number; micros: number | null } {
    const amounts = [ledger.budget.maxCostMicros === null ? null : ledger.budget.maxCostMicros - ledger.budget.spentMicros - ledger.budget.heldMicros,
        ledger.quotaLimit ? ledger.quotaLimit.maxCostMicros - ledger.quotaLimit.spentMicros - ledger.quotaLimit.heldMicros : null]
        .filter((amount): amount is number => amount !== null);
    return { calls: ledger.budget.maxModelCalls - ledger.budget.spentCalls - ledger.budget.heldCalls,
        micros: amounts.length ? Math.min(...amounts) : null };
}

export class InternalChildren implements InternalDelegationPort {
    private toolSelectionPolicy: ChildToolSelectionPolicy = input => selectChildTools(input);

    constructor(private readonly hooks: InternalChildrenHooks) {}

    setToolSelectionPolicy(policy: ChildToolSelectionPolicy): void {
        this.toolSelectionPolicy = policy;
    }

    private async parent(context: BoundToolContext, active: boolean) {
        const conversation = await this.hooks.getConversation(context.conversationId);
        const run = await this.hooks.getRun(context.conversationId, context.runId);
        if (conversation.value.principalId !== context.principalId || run.value.rootRunId !== context.rootRunId || run.value.parentRunId
            || childAllocation(run.value)) throw new AgentFault('CHILD_AGENTS_DISABLED', '内部派发只供所属根任务使用');
        if (active && (context.signal.aborted || run.value.runEpoch !== context.runEpoch || run.value.state !== 'running'
            || conversation.value.state !== 'open' || !this.hooks.accepting())) throw new AgentFault('TOOL_CANCELLED', '父任务已停止或执行代次已经改变');
        const options = { ...conversation.value.options, ...(run.value.options as Record<string, unknown> ?? {}) };
        if (active && options.allowSubagents !== true && options.allowInternalAgents !== true) throw new AgentFault('CHILD_AGENTS_DISABLED', '可信调用方尚未开启内部派发');
        return { conversation, run, options };
    }

    async policy(context: BoundToolContext) {
        await this.hooks.ready();
        return this.hooks.serial(async () => {
            const parent = await this.parent(context, true);
            const configured = Number(parent.options.childContextTokens ?? 16384);
            if (!Number.isSafeInteger(configured) || configured < 1) throw new AgentFault('CHILD_CONTEXT_TOO_LARGE', '子任务上下文上限无效');
            return { options: structuredClone(parent.options), maxContextTokens: configured };
        });
    }

    async replay(input: { taskKind: string; task: string; contextRefs: string[]; writeRoots: string[]; limits: ChildLimits }, context: BoundToolContext): Promise<ChildReceipt | null> {
        await this.hooks.ready();
        return this.hooks.serial(async () => {
            const parent = await this.parent(context, false);
            const callKey = canonicalJson([context.actionId, context.callId ?? context.actionId]);
            const link = childLinks(parent.run.value).find(item => item.callKey === callKey);
            if (!link) return null;
            if (link.inputHash !== childInputHash(input)) throw new AgentFault('COMMAND_CONFLICT', '原子调用已固定其它参数');
            return this.receipt(link, parent.run.value);
        });
    }

    async start(plan: PreparedChild, limits: ChildLimits, selection: ChildSelection, context: BoundToolContext): Promise<ChildReceipt> {
        await this.hooks.ready();
        return this.hooks.serial(async () => {
            const parent = await this.parent(context, true);
            if (!this.hooks.executorAvailable()) throw new AgentFault('EXECUTOR_UNAVAILABLE', '当前核心尚未接入执行器');
            if (parent.conversation.value.retention.mode === 'ttl' && !this.hooks.retentionOwnershipAvailable()) {
                throw new AgentFault('CAPABILITY_REQUIRED', '限时父会话的子派发须先接入持久存储的父级保存归属',
                    { capability: 'internal_child_retention_parent_cascade_v1' });
            }
            if (plan.parentRunId !== parent.run.value.runId || plan.rootRunId !== parent.run.value.rootRunId
                || plan.conversationId !== parent.conversation.value.conversationId || plan.runEpoch !== parent.run.value.runEpoch
                || plan.policyRevision !== parent.conversation.value.policyRevision || plan.depth !== 1 || plan.allowInternalAgents !== false) {
                throw new AgentFault('CHILD_IDENTITY_MISMATCH', '派发快照与所属父任务身份或版本不一致');
            }
            for (const value of [limits.wallMs, limits.maxModelCalls, limits.maxContextTokens]) {
                if (!Number.isSafeInteger(value) || value < 1) throw new AgentFault('CHILD_BUDGET_REQUIRED', '子任务需要有限时间、次数和上下文预算');
            }
            if (limits.maxCostMicros !== null && (!Number.isSafeInteger(limits.maxCostMicros) || limits.maxCostMicros < 0)) {
                throw new AgentFault('CHILD_BUDGET_REQUIRED', '子任务费用上限须为非负整数');
            }
            const contextCap = Number(parent.options.childContextTokens ?? 16384);
            if (!Number.isSafeInteger(selection.contextTokens) || selection.contextTokens < 0 || selection.contextTokens > limits.maxContextTokens
                || limits.maxContextTokens > contextCap) throw new AgentFault('CHILD_CONTEXT_TOO_LARGE', '选中材料超过父任务批准的上下文预算');
            const configuredRoots = parent.options.writeRoots ?? parent.options.workspaceRoots ?? [];
            const approved = Array.isArray(configuredRoots) ? configuredRoots.filter((root): root is string => typeof root === 'string').map(pathIdentity) : [];
            const roots = plan.writeRoots.map(pathIdentity);
            if (roots.some(root => !approved.some(allowed => isWithin(root, allowed)))) throw new AgentFault('TOOL_NOT_ALLOWED', '子任务写根须属于父任务批准范围');
            const callKey = canonicalJson([context.actionId, context.callId ?? context.actionId]);
            const requestHash = digest({ task: plan.task, taskKind: plan.taskKind, contextRefs: plan.contextRefs, selection, limits,
                roots, rulesHash: plan.rulesHash, profileId: plan.profileId, modelId: plan.modelId, reasoningEffort: plan.reasoningEffort });
            const existing = childLinks(parent.run.value).find(link => link.callKey === callKey);
            if (existing) {
                if (existing.requestHash !== requestHash) throw new AgentFault('COMMAND_CONFLICT', '原子任务调用已固定其它参数');
                return this.receipt(existing, parent.run.value);
            }
            const ledger = await this.hooks.readBudget(parent.run.value.rootRunId);
            const root = ledger.budget;
            if (!plan.currency || !plan.quotaScopeId) throw new AgentFault('MODEL_RULE_UNSUPPORTED',
                '子任务目录须提供所选配置的实际币种和quotaScopeId');
            if (plan.currency !== root.currency || (ledger.quotaLimit && ledger.quotaLimit.currency !== plan.currency)) {
                throw new AgentFault('CHILD_CURRENCY_UNSUPPORTED', '当前子任务仅支持原根相同币种，跨币种需要明确汇率及双账本金额合同',
                    { rootCurrency: root.currency, childCurrency: plan.currency });
            }
            const effectiveQuotaLimitId = plan.quotaLimitId ?? root.quotaLimitId ?? null;
            if (!effectiveQuotaLimitId || effectiveQuotaLimitId !== root.quotaLimitId || ledger.quotaLimit?.quotaLimitId !== effectiveQuotaLimitId
                || !ledger.quotaLimit.quotaScopeIds.includes(plan.quotaScopeId)) {
                throw new AgentFault('CHILD_QUOTA_UNSUPPORTED', '当前子任务仅支持同一供应商全局quota；跨quota须在原根和目标quota间原子预留',
                    { rootQuotaLimitId: root.quotaLimitId ?? null, childQuotaLimitId: plan.quotaLimitId, childQuotaScopeId: plan.quotaScopeId });
            }
            const fixedPlan: PreparedChild = { ...plan, quotaLimitId: effectiveQuotaLimitId,
                quotaBindingSource: plan.quotaLimitId ? 'profile' : 'trusted_root' };
            if (root.rootBudgetId !== parent.run.value.rootRunId || root.blockedReason || root.overdrawn
                || ledger.quotaLimit?.blockedReason || ledger.quotaLimit?.overdrawn) throw new AgentFault('CHILD_BUDGET_REQUIRED', '原根账本或供应商总账已停止接纳');
            const available = rootAvailability(ledger);
            const reserved = await this.unusedAllocations(parent.run.value, ledger);
            const remainingCalls = available.calls - reserved.calls;
            const remainingMicros = available.micros === null ? null : available.micros - reserved.micros;
            if (limits.maxModelCalls > remainingCalls || (root.mode === 'hard' && limits.maxCostMicros === null)
                || (remainingMicros !== null && (limits.maxCostMicros === null || limits.maxCostMicros > remainingMicros))
                || plan.maxOutputTokens > root.maxOutputTokens) throw new AgentFault('CHILD_BUDGET_EXCEEDED', '子任务分配超过原根账本的剩余次数、费用或输出限额');
            const deadlineAt = new Date(Math.min(this.hooks.now() + limits.wallMs, Date.parse(root.deadlineAt), Date.parse(parent.run.value.deadlineAt))).toISOString();
            if (Date.parse(deadlineAt) <= this.hooks.now()) throw new AgentFault('CHILD_BUDGET_EXCEEDED', '原父任务期限已经到达');
            const conversationId = randomUUID();
            const time = new Date(this.hooks.now()).toISOString();
            const toolSelection = this.toolSelectionPolicy({
                parentTools: Array.isArray(parent.options.tools) ? parent.options.tools : undefined,
                childRetentionMode: parent.conversation.value.retention.mode,
            });
            const allowedTools = [...toolSelection.tools];
            const childOptions = { profileId: plan.profileId, modelId: plan.modelId, parameters: { reasoningEffort: plan.reasoningEffort },
                writeRoots: roots, tools: allowedTools, allowSubagents: false, allowInternalAgents: false, delegationDepth: 1,
                delegatedToolSelection: structuredClone(toolSelection.decisions),
                rootBudgetDefinition: structuredClone(root), modelRulesSnapshot: structuredClone(plan.rulesDocument),
                delegationContext: { refs: plan.contextRefs, provenance: selection.provenance, contextTokens: selection.contextTokens,
                    maxContextTokens: limits.maxContextTokens }, parentConversationId: context.conversationId,
                parentRunId: context.runId, parentRoundId: context.roundId, parentActionId: context.actionId };
            const conversation: ConversationData = { ...structuredClone(parent.conversation.value), conversationId, options: childOptions,
                state: 'open', retention: { ...parent.conversation.value.retention, activeRuns: 1, lastRunEnd: null, lastClose: null, expiresAt: null },
                createdAt: time, updatedAt: time, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
                runEpoch: 1, activeRunId: plan.childRunId, eventGeneration: randomUUID(), eventSeq: '0', policyRevision: plan.policyRevision,
                configRevision: 1, cleanupState: 'not_needed', cleanupError: null, closeCleanupCompleted: false };
            delete conversation.closeReceiptKeys;
            const allocation: ChildAllocation = { parentConversationId: context.conversationId, parentRunId: context.runId,
                parentRunEpoch: context.runEpoch, parentRoundId: context.roundId, parentActionId: context.actionId,
                rulesHash: plan.rulesHash, maxContextTokens: limits.maxContextTokens, attempts: [] };
            const run: RunData = { conversationId, runId: plan.childRunId, rootRunId: plan.rootRunId, parentRunId: plan.parentRunId,
                kind: 'task', runEpoch: 1, state: 'queued', phase: 'admitting', resultStatus: null, stopReason: null, effectState: 'none',
                cleanupState: 'not_needed', activeRoundId: null, activeStepId: null, pendingInteractionIds: [],
                budget: { ...parent.run.value.budget, wallMs: Date.parse(deadlineAt) - this.hooks.now(), maxModelCalls: limits.maxModelCalls,
                    maxCostMicros: limits.maxCostMicros, maxOutputTokens: plan.maxOutputTokens, currency: root.currency, costMode: root.mode, deadlineAt },
                nextCheckpointAt: null, eventCursor: null, createdAt: time, updatedAt: time, deadlineAt, queueRevision: 1, inputOrder: 1,
                activeInputId: null, stopTarget: null, executorAvailable: true, resultContentId: null, failure: null,
                initiator: structuredClone(parent.run.value.initiator), internalDelegation: allocation,
                delegationPlan: structuredClone(fixedPlan), budgetReservationId: null };
            const selected = selection.content && typeof selection.content === 'object' && !Array.isArray(selection.content) ? selection.content : {};
            const input = this.hooks.createInput(conversationId, run.runId, { ...selected,
                text: typeof selected.text === 'string' && selected.text ? `${plan.task}\n\n${selected.text}` : plan.task });
            const link: ChildLink = { childRunId: run.runId, childConversationId: conversationId, callKey, requestHash,
                parentRoundId: context.roundId, parentActionId: context.actionId,
                inputHash: childInputHash({ taskKind: plan.taskKind, task: plan.task, contextRefs: plan.contextRefs, writeRoots: roots, limits }) };
            const parentRun = { ...parent.run.value, internalChildren: [...childLinks(parent.run.value), link] };
            await this.hooks.commit(parent.conversation, [{ ...parent.run, revision: parent.run.revision + 1, value: parentRun },
                { key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1, value: conversation },
                { key: { conversationId, kind: 'run', id: run.runId }, revision: 1, value: run }, input.record],
                [{ type: 'run.childQueued', payload: { childRunId: run.runId, childConversationId: conversationId, rootRunId: run.rootRunId,
                    rulesHash: plan.rulesHash }, run: parentRun }], null, [input.content]);
            this.hooks.schedule(run);
            return this.receipt(link, parentRun);
        });
    }

    private async receipt(link: ChildLink, parent: RunData): Promise<ChildReceipt> {
        const child = (await this.hooks.getRun(link.childConversationId, link.childRunId)).value;
        const result = child.resultContentId ? await this.hooks.readContent(child.conversationId, child.resultContentId) ?? null : null;
        const object = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
        const plan = child.delegationPlan as PreparedChild;
        return { childRunId: child.runId, childConversationId: child.conversationId, parentRunId: parent.runId,
            parentConversationId: parent.conversationId, rootRunId: child.rootRunId,
            budgetReservationId: typeof child.budgetReservationId === 'string' ? child.budgetReservationId : null, rulesHash: childAllocation(child)!.rulesHash,
            state: child.state, terminalConfirmed: settled(child), cleanupState: child.cleanupState, effectState: child.effectState,
            result, artifactRefs: Array.isArray(object.artifacts) ? object.artifacts : [],
            changedActionIds: Array.isArray(child.internalChangedActionIds) ? child.internalChangedActionIds as string[] : [],
            selectedContextRefs: [...plan.contextRefs], failure: child.failure ? JSON.parse(canonicalJson(child.failure)) as JsonValue : null };
    }

    async get(childRunId: string, context: BoundToolContext): Promise<ChildReceipt> {
        await this.hooks.ready();
        return this.hooks.serial(async () => {
            const { run } = await this.parent(context, false);
            const link = childLinks(run.value).find(candidate => candidate.childRunId === childRunId);
            if (!link) throw new AgentFault('NOT_FOUND', '当前父任务没有该子任务');
            return this.receipt(link, run.value);
        });
    }

    async wait(childRunId: string, waitMs: number, context: BoundToolContext): Promise<ChildReceipt> {
        if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 45000) throw new AgentFault('INVALID_PARAMS', '子任务单次等待须为0至45000毫秒');
        const deadline = this.hooks.now() + waitMs;
        let result = await this.get(childRunId, context);
        while (!result.terminalConfirmed && !['paused', 'waiting', 'outcome_unknown'].includes(result.state)
            && !context.signal.aborted && this.hooks.now() < deadline) {
            await new Promise<void>(resolve => {
                const finish = (): void => { clearTimeout(timer); unsubscribe(); context.signal.removeEventListener('abort', finish); resolve(); };
                const unsubscribe = this.hooks.subscribe(finish);
                const timer = setTimeout(finish, Math.min(100, Math.max(1, deadline - this.hooks.now())));
                context.signal.addEventListener('abort', finish, { once: true });
            });
            result = await this.get(childRunId, context);
        }
        return result;
    }

    async cancel(childRunId: string, context: BoundToolContext): Promise<ChildReceipt> {
        await this.hooks.ready();
        await this.hooks.serial(async () => {
            const parent = await this.parent(context, true);
            const link = childLinks(parent.run.value).find(candidate => candidate.childRunId === childRunId);
            if (!link) throw new AgentFault('NOT_FOUND', '当前父任务没有该子任务');
            const child = await this.hooks.getRun(link.childConversationId, childRunId);
            if (child.value.state === 'outcome_unknown') this.hooks.cancelExecution(childRunId, 'PARENT_REQUESTED');
            else await this.hooks.stop(await this.hooks.getConversation(link.childConversationId), child, 'PARENT_REQUESTED');
        });
        return this.get(childRunId, context);
    }

    async stopOwnedChildren(parent: RunData, reason: string): Promise<boolean> {
        let released = true;
        for (const link of childLinks(parent)) {
            const child = await this.hooks.getRun(link.childConversationId, link.childRunId);
            if (settled(child.value)) continue;
            released = false;
            if (child.value.state === 'outcome_unknown') { this.hooks.cancelExecution(child.value.runId, reason); continue; }
            try { await this.hooks.stop(await this.hooks.getConversation(link.childConversationId), child, reason); }
            catch (error) {
                if (!(error instanceof AgentFault) || error.code !== 'OUTCOME_UNKNOWN') throw error;
                this.hooks.cancelExecution(child.value.runId, reason);
            }
        }
        return released;
    }

    async released(parent: RunData): Promise<boolean> {
        for (const link of childLinks(parent)) if (!settled((await this.hooks.getRun(link.childConversationId, link.childRunId)).value)) return false;
        return true;
    }

    async syncRetention(parent: ConversationData): Promise<void> {
        if (parent.options.parentConversationId) return;
        const runs = await this.hooks.listRuns(parent.conversationId);
        for (const record of runs) for (const link of childLinks(record.value)) {
            const child = await this.hooks.getConversation(link.childConversationId);
            if (child.value.retention.mode !== parent.retention.mode) throw new AgentFault('CHILD_RETENTION_SYNC_REQUIRED',
                '父会话保存模式已改变，子会话须纳入原保存模式转换事务', { childConversationId: child.value.conversationId });
            if (parent.retention.mode !== 'ttl') continue;
            const run = await this.hooks.getRun(link.childConversationId, link.childRunId);
            const retention = { ...parent.retention, activeRuns: Math.max(parent.retention.activeRuns, settled(run.value) ? 0 : 1) };
            if (canonicalJson(child.value.retention) === canonicalJson(retention)) continue;
            child.value.retention = retention;
            await this.hooks.commit(child, [], [{ type: 'conversation.parentRetention', payload: { parentConversationId: parent.conversationId,
                expiresAt: retention.expiresAt, activeRuns: retention.activeRuns } }], null);
        }
    }

    async synchronizeRetention(conversationId: string): Promise<void> {
        await this.hooks.ready();
        await this.hooks.serial(async () => this.syncRetention((await this.hooks.getConversation(conversationId)).value));
    }

    async admitAttempt(attempt: ProviderAttempt, upperBound: UpperBound): Promise<void> {
        await this.hooks.ready();
        await this.hooks.serial(() => this.admitLocked(attempt, upperBound));
    }

    async prepareJournalAttempt(journal: DispatchJournalPort, attempt: ProviderAttempt, upperBound: UpperBound): Promise<PreparedDispatch> {
        await this.hooks.ready();
        return this.hooks.serial(async () => {
            try { await this.admitLocked(attempt, upperBound); }
            catch (error) {
                if (error instanceof ProviderFault) throw error;
                throw new ProviderFault(error instanceof AgentFault ? error.code : 'CHILD_ADMISSION_FAILED',
                    error instanceof Error ? error.message : '子请求发送前核验失败', { acceptance: 'not_sent' });
            }
            return journal.prepareAttempt(attempt, upperBound);
        });
    }

    private async unusedAllocations(parent: RunData, ledger: BudgetView, exceptRunId?: string): Promise<{ calls: number; micros: number }> {
        let calls = 0;
        let micros = 0;
        for (const link of childLinks(parent)) {
            if (link.childRunId === exceptRunId) continue;
            const child = (await this.hooks.getRun(link.childConversationId, link.childRunId)).value;
            if (settled(child)) continue;
            const ids = new Set(childAllocation(child)!.attempts.map(item => item.attemptId));
            const reservations = ledger.reservations.filter(item => ids.has(item.attemptId));
            const usedCalls = reservations.filter(item => item.state !== 'rejected').length;
            const usedMicros = reservations.reduce((sum, item) => sum + item.heldMicros, 0)
                + ledger.charges.filter(item => ids.has(item.attemptId)).reduce((sum, item) => sum + (item.amountMicros ?? 0), 0);
            calls += Math.max(0, Number(child.budget.maxModelCalls) - usedCalls);
            if (typeof child.budget.maxCostMicros === 'number') micros += Math.max(0, child.budget.maxCostMicros - usedMicros);
        }
        return { calls, micros };
    }

    private async admitLocked(attempt: ProviderAttempt, upperBound: UpperBound): Promise<void> {
            const record = await this.hooks.getRun(attempt.snapshot.conversationId, attempt.snapshot.runId);
            const allocation = childAllocation(record.value);
            if (!allocation) {
                if (!childLinks(record.value).length) return;
                const ledger = await this.hooks.readBudget(record.value.rootRunId);
                const available = rootAvailability(ledger);
                const reserved = await this.unusedAllocations(record.value, ledger);
                if (available.calls - reserved.calls < 1 || (available.micros !== null && (upperBound.amountMicros === null
                    || available.micros - reserved.micros < upperBound.amountMicros))) {
                    throw new AgentFault('CHILD_BUDGET_RESERVED', '原根剩余额度已分配给在途子任务，请先收回其结果或取消');
                }
                return;
            }
            const plan = record.value.delegationPlan as PreparedChild;
            const contextSnapshot = attempt.snapshot as unknown as Record<string, unknown>;
            const compression = typeof contextSnapshot.compressionCandidateId === 'string'
                && typeof contextSnapshot.effectiveCompressionModelFingerprint === 'string';
            if (!plan || (!compression && (attempt.snapshot.profile.profileId !== plan.profileId
                || attempt.snapshot.profileRevision !== plan.profileRevision || attempt.snapshot.modelId !== plan.modelId))
                || Date.parse(attempt.snapshot.deadlineAt) > Date.parse(record.value.deadlineAt)
                || Number(attempt.snapshot.effectiveParameters.maxOutputTokens) > Number(record.value.budget.maxOutputTokens)) {
                throw new AgentFault('CHILD_IDENTITY_MISMATCH', '子请求与冻结的模型、配置或期限不一致');
            }
            if (compression && Buffer.byteLength(attempt.snapshot.body, 'utf8') > allocation.maxContextTokens) {
                throw new AgentFault('CHILD_CONTEXT_TOO_LARGE', '压缩请求的保守输入上界超过子任务的原分配');
            }
            const parent = await this.hooks.getRun(allocation.parentConversationId, allocation.parentRunId);
            if (parent.value.runEpoch !== allocation.parentRunEpoch || parent.value.state !== 'running'
                || record.value.runEpoch !== attempt.snapshot.runEpoch || record.value.state !== 'running'
                || attempt.rootBudgetId !== record.value.rootRunId || Date.parse(record.value.deadlineAt) <= this.hooks.now()) {
                throw new AgentFault('TOOL_CANCELLED', '子任务的父代次、期限或执行身份已经失效');
            }
            const known = allocation.attempts.find(item => item.attemptId === attempt.attemptId);
            if (known) {
                if (known.snapshotHash !== attempt.snapshot.snapshotHash) throw new AgentFault('COMMAND_CONFLICT', '子尝试已固定其它请求');
                return;
            }
            const ledger = await this.hooks.readBudget(record.value.rootRunId);
            if (upperBound.currency !== ledger.budget.currency || upperBound.currency !== plan.currency) {
                throw new AgentFault('CHILD_CURRENCY_UNSUPPORTED', '实际子请求币种与已冻结的原根/子分配不同');
            }
            if ((attempt.snapshot.profile.quotaLimitId && attempt.snapshot.profile.quotaLimitId !== ledger.budget.quotaLimitId)
                || plan.quotaLimitId !== ledger.budget.quotaLimitId
                || !ledger.quotaLimit?.quotaScopeIds.includes(attempt.snapshot.profile.quotaScopeId)
                || (!compression && attempt.snapshot.profile.quotaScopeId !== plan.quotaScopeId)) {
                throw new AgentFault('CHILD_QUOTA_UNSUPPORTED', '实际子请求未绑定已冻结且明确覆盖当前账户范围的同一全局quota');
            }
            const available = rootAvailability(ledger);
            const reserved = await this.unusedAllocations(parent.value, ledger, record.value.runId);
            if (available.calls - reserved.calls < 1 || (available.micros !== null && (upperBound.amountMicros === null
                || available.micros - reserved.micros < upperBound.amountMicros))) {
                throw new AgentFault('CHILD_BUDGET_EXCEEDED', '原根剩余额度已由原尝试或其它子任务占用');
            }
            const identifiers = new Set(allocation.attempts.map(item => item.attemptId));
            const reservations = ledger.reservations.filter(item => identifiers.has(item.attemptId));
            const missing = allocation.attempts.filter(item => !reservations.some(reservation => reservation.attemptId === item.attemptId));
            const calls = reservations.filter(item => item.state !== 'rejected').length + missing.length;
            const cost = ledger.charges.filter(item => identifiers.has(item.attemptId)).reduce((sum, item) => sum + (item.amountMicros ?? 0), 0)
                + reservations.reduce((sum, item) => sum + item.heldMicros, 0)
                + missing.reduce((sum, item) => sum + (item.upperBound.amountMicros ?? 0), 0);
            const maxCost = record.value.budget.maxCostMicros;
            if (calls >= Number(record.value.budget.maxModelCalls) || upperBound.currency !== ledger.budget.currency
                || (typeof maxCost === 'number' && (upperBound.amountMicros === null || cost + upperBound.amountMicros > maxCost))) {
                throw new AgentFault('CHILD_BUDGET_EXCEEDED', '子任务在原根账本中的累计次数或费用已达到分配上限');
            }
            const next = { ...record.value, budgetReservationId: attempt.attemptId, internalDelegation: { ...allocation,
                attempts: [...allocation.attempts, { attemptId: attempt.attemptId, snapshotHash: attempt.snapshot.snapshotHash, upperBound: structuredClone(upperBound) }] } };
            await this.hooks.commit(await this.hooks.getConversation(record.value.conversationId), [{ ...record, revision: record.revision + 1, value: next }],
                [{ type: 'run.childAttemptIntent', payload: { attemptId: attempt.attemptId, rootBudgetId: attempt.rootBudgetId }, run: next }], null);
    }
}
