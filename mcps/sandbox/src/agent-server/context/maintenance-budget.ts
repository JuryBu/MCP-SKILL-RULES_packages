import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { budgetDefinitionFromRun } from '../accounting/run-budget.js';
import type { BudgetDefinition, BudgetLedger } from '../accounting/budget-ledger.js';
import type { ExecutionLease, FrozenCompressionConfig, MaintenanceCallbacks } from './contracts.js';
import { contextFailure, ContextFault } from './errors.js';

export interface ContextMaintenanceBudgetSource {
    budget: JsonObject;
    sourceRef: string;
    quotaLimitId?: string;
}

export interface ContextMaintenanceBudgetOptions {
    lifecycle: MaintenanceCallbacks;
    resolveBudget?(input: Parameters<MaintenanceCallbacks['createRun']>[0]): Promise<ContextMaintenanceBudgetSource | null>;
    now?: () => number;
}

function validateLease(execution: ExecutionLease, conversationId: string, budget: BudgetDefinition, now: number): void {
    if (execution.kind !== 'maintenance' || execution.conversationId !== conversationId || execution.roundId !== null
        || !execution.runId || execution.runId !== execution.rootBudgetId || !execution.stepId
        || !Number.isSafeInteger(execution.runEpoch) || execution.runEpoch < 1
        || !Number.isFinite(Date.parse(execution.deadlineAt)) || Date.parse(execution.deadlineAt) <= now
        || Date.parse(execution.deadlineAt) > Date.parse(budget.deadlineAt)) {
        throw new ContextFault('CONFIG_INVALID', '维护执行须使用本会话独立根预算、无人工轮及预算以内的期限');
    }
}

export function createContextMaintenanceCallbacks(options: ContextMaintenanceBudgetOptions & {
    ledger: Pick<BudgetLedger, 'create' | 'read'>;
}): MaintenanceCallbacks {
    const now = options.now ?? Date.now;
    return {
        async createRun(input) {
            if (!input.config) throw new ContextFault('CONFIG_INVALID', '维护预算需要已冻结的压缩模型配置');
            const template = await options.resolveBudget?.(input);
            if (!input.budget && !template) throw new AgentFault('BUDGET_REQUIRED', '空闲压缩需要明确维护预算或已批准的预算模板');
            const value = { ...template?.budget, ...input.budget };
            let definition: BudgetDefinition;
            try {
                definition = budgetDefinitionFromRun({ rootBudgetId: 'context-maintenance-pending', budget: value,
                    sourceRef: template?.sourceRef ?? `context:manual:${input.operationId ?? input.conversationId}`,
                    quotaLimitId: template?.quotaLimitId, maxOutputTokens: input.config.model.maxOutputTokens, now: now() });
            } catch (error) {
                if (error instanceof AgentFault && error.code === 'E_GLOBAL_BUDGET_REQUIRED') {
                    throw new AgentFault('BUDGET_REQUIRED', '维护预算需要已批准的全局quotaLimitId', { cause: error.code });
                }
                throw error;
            }
            definition.maxOutputTokens = Math.min(definition.maxOutputTokens, input.config.model.maxOutputTokens);
            const budget: JsonObject = { ...value, costMode: definition.mode ?? 'hard', currency: definition.currency,
                ...(definition.quotaLimitId ? { quotaLimitId: definition.quotaLimitId } : {}), maxCostMicros: definition.maxCostMicros,
                maxModelCalls: definition.maxModelCalls, maxOutputTokens: definition.maxOutputTokens, deadlineAt: definition.deadlineAt };
            const execution = await options.lifecycle.createRun({ ...input, budget });
            try {
                validateLease(execution, input.conversationId, definition, now());
                await options.ledger.create({ ...definition, rootBudgetId: execution.rootBudgetId, deadlineAt: execution.deadlineAt });
                const root = await options.ledger.read(execution.rootBudgetId);
                if (root.budget.mode !== 'metered' && (!root.budget.quotaLimitId || !root.quotaLimit)) throw new ContextFault('CONFIG_INVALID', '维护预算尚未关联全局费用上限');
                return execution;
            } catch (error) {
                await options.lifecycle.finishRun({ execution, result: 'failed', failure: contextFailure(error) });
                throw error;
            }
        },
        async prepareRun(input): Promise<FrozenCompressionConfig> {
            const config = await options.lifecycle.prepareRun?.(input) ?? input.config;
            const root = await options.ledger.read(input.execution.rootBudgetId);
            validateLease(input.execution, input.execution.conversationId, root.budget, now());
            if (root.budget.mode !== 'metered' && (!root.budget.quotaLimitId || !root.quotaLimit)) throw new ContextFault('CONFIG_INVALID', '恢复维护压缩需要原全局预算');
            return config;
        },
        finishRun: input => options.lifecycle.finishRun(input),
    };
}
