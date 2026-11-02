import { AgentFault } from '../protocol.js';
import type { AccountingPort, BudgetRecord } from '../accounting/budget-ledger.js';
import type { ExecutorContext } from '../runtime.js';
import type { ProviderProfile } from '../providers/types.js';
import type { PreparedChild } from './contracts.js';

export async function childRootBudget(context: ExecutorContext, accounting: Pick<AccountingPort, 'read'>): Promise<BudgetRecord | null> {
    if (!context.snapshot.parentRunId) return null;
    const delegation = context.snapshot.internalDelegation;
    const frozen = context.conversationOptions.rootBudgetDefinition as BudgetRecord | undefined;
    const rootRunId = String(context.snapshot.rootRunId ?? '');
    if (!delegation || !frozen || frozen.rootBudgetId !== rootRunId) throw new AgentFault('CHILD_IDENTITY_MISMATCH', '子执行缺少原根预算快照');
    const current = await accounting.read(rootRunId);
    if (current.budget.definitionHash !== frozen.definitionHash) throw new AgentFault('CHILD_BUDGET_REQUIRED', '原根预算定义已经变化');
    if (current.budget.blockedReason || current.budget.overdrawn || current.quotaLimit?.blockedReason || current.quotaLimit?.overdrawn) {
        throw new AgentFault('CHILD_BUDGET_EXCEEDED', '原根费用账本已停止新请求');
    }
    return current.budget;
}

export function assertChildModel(context: ExecutorContext, profile: ProviderProfile, modelId: string): void {
    if (!context.snapshot.parentRunId) return;
    const plan = context.snapshot.delegationPlan as PreparedChild | undefined;
    if (!plan || profile.profileId !== plan.profileId || profile.revision !== plan.profileRevision || modelId !== plan.modelId
        || context.conversationOptions.allowSubagents !== false || context.conversationOptions.allowInternalAgents !== false) {
        throw new AgentFault('MODEL_RULE_UNSUPPORTED', '子任务须保留规则冻结的模型、配置版本及单层限制');
    }
}

export function assertChildContextBudget(context: ExecutorContext, inputTokenUpperBound: number): void {
    if (!context.snapshot.parentRunId) return;
    const allocation = context.snapshot.internalDelegation as { maxContextTokens?: number } | undefined;
    if (!allocation || !Number.isSafeInteger(inputTokenUpperBound) || inputTokenUpperBound < 0
        || inputTokenUpperBound > Number(allocation.maxContextTokens)) {
        throw new AgentFault('CHILD_CONTEXT_TOO_LARGE', '完整子请求的实际或保守输入上界超过原分配，须缩小选中材料');
    }
}

export function assertChildExecutionBounds(context: ExecutorContext, plan: {
    rootBudgetId: string; maxModelCalls: number; maxOutputTokens: number; deadlineAt: string;
}): void {
    if (!context.snapshot.parentRunId) return;
    const deadlineAt = Date.parse(String(context.snapshot.budget.deadlineAt ?? context.snapshot.deadlineAt ?? ''));
    if (plan.rootBudgetId !== context.snapshot.rootRunId || !Number.isSafeInteger(plan.maxModelCalls) || plan.maxModelCalls < 1
        || plan.maxModelCalls > Number(context.snapshot.budget.maxModelCalls) || !Number.isSafeInteger(plan.maxOutputTokens)
        || plan.maxOutputTokens < 1 || plan.maxOutputTokens > Number(context.snapshot.budget.maxOutputTokens)
        || !Number.isFinite(Date.parse(plan.deadlineAt)) || !Number.isFinite(deadlineAt) || Date.parse(plan.deadlineAt) > deadlineAt) {
        throw new AgentFault('CHILD_BUDGET_EXCEEDED', '执行计划须保留子任务原根、有限次数、输出和原截止点');
    }
}

export function canUseInternalDelegation(context: Pick<ExecutorContext, 'snapshot' | 'conversationOptions'>): boolean {
    return context.snapshot.parentRunId === null && context.snapshot.rootRunId === context.snapshot.runId
        && !context.snapshot.internalDelegation && context.conversationOptions.discussionOnly !== true
        && context.conversationOptions.toolsEnabled !== false
        && (context.conversationOptions.allowSubagents === true || context.conversationOptions.allowInternalAgents === true);
}
