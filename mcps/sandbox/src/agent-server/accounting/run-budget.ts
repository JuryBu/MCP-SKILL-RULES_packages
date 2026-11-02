import { AgentFault } from '../protocol.js';
import type { BudgetDefinition } from './budget-ledger.js';
import type { ProviderProfile } from '../providers/types.js';

export function resolveQuotaLimitId(budget: Record<string, unknown>, profile?: Pick<ProviderProfile, 'quotaLimitId'>, fallback?: string | null): string {
    const value = budget.quotaLimitId ?? fallback ?? profile?.quotaLimitId;
    if (typeof value !== 'string' || !value) throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', '请在执行预算或API配置中选择已批准的quotaLimitId总限额');
    return value;
}

export function budgetDefinitionFromRun(input: {
    rootBudgetId: string; quotaLimitId?: string | null; budget: Record<string, unknown>; sourceRef: string;
    profile?: Pick<ProviderProfile, 'quotaLimitId'>;
    maxOutputTokens?: number; now?: number;
}): BudgetDefinition {
    const value = input.budget;
    const now = input.now ?? Date.now();
    const mode = value.costMode ?? value.mode ?? 'hard';
    const quotaLimitId = resolveQuotaLimitId(value, input.profile, input.quotaLimitId);
    const wallMs = value.wallMs ?? 3_600_000;
    const deadlineTime = typeof value.deadlineAt === 'string' ? Date.parse(value.deadlineAt) : now + Number(wallMs);
    if (!Number.isFinite(deadlineTime)) throw new AgentFault('BUDGET_REQUIRED', '执行预算需要有限有效期限');
    const deadlineAt = new Date(deadlineTime).toISOString();
    const maxOutputTokens = value.maxOutputTokens ?? input.maxOutputTokens;
    if (!input.rootBudgetId || !input.sourceRef || !['hard', 'estimated'].includes(String(mode))
        || !Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) <= now
        || !Number.isSafeInteger(value.maxModelCalls) || Number(value.maxModelCalls) < 1
        || !Number.isSafeInteger(maxOutputTokens) || Number(maxOutputTokens) < 1
        || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
        || (mode === 'hard' && (!Number.isSafeInteger(value.maxCostMicros) || Number(value.maxCostMicros) < 0))) {
        throw new AgentFault('BUDGET_REQUIRED', '执行预算缺少全局限额引用、输出上限、币种、次数或期限');
    }
    return { rootBudgetId: input.rootBudgetId, quotaLimitId, mode: mode as 'hard' | 'estimated', currency: value.currency,
        maxCostMicros: value.maxCostMicros === null || value.maxCostMicros === undefined ? null : Number(value.maxCostMicros),
        maxModelCalls: Number(value.maxModelCalls), maxOutputTokens: Number(maxOutputTokens), deadlineAt, sourceRef: input.sourceRef };
}
