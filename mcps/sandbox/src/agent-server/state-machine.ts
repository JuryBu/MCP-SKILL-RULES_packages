import { AgentFault } from './protocol.js';
import type { RunSnapshot, RunState } from './protocol.js';

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['succeeded', 'failed', 'cancelled']);
const transitions: Record<RunState, ReadonlySet<RunState>> = {
    accepted: new Set(['queued', 'stopping', 'recovering']),
    queued: new Set(['running', 'paused', 'stopping', 'recovering']),
    running: new Set(['queued', 'waiting', 'stopping', 'paused', 'succeeded', 'failed', 'outcome_unknown', 'recovering']),
    waiting: new Set(['queued', 'paused', 'stopping', 'recovering']),
    stopping: new Set(['paused', 'cancelled', 'outcome_unknown', 'recovering']),
    paused: new Set(['queued', 'stopping', 'recovering']),
    recovering: new Set(['paused', 'outcome_unknown', 'stopping']),
    outcome_unknown: new Set(['paused', 'failed', 'succeeded', 'cancelled', 'stopping', 'recovering']),
    succeeded: new Set(), failed: new Set(), cancelled: new Set(),
};

export function isTerminal(run: Pick<RunSnapshot, 'state'>): boolean { return TERMINAL_STATES.has(run.state); }

export function transitionRun<Value extends RunSnapshot>(run: Value, state: RunState, patch: Partial<Value> = {}): Value {
    if (run.state !== state && !transitions[run.state].has(state)) {
        throw new AgentFault('INVALID_STATE', '该执行状态无法进行请求的转换', { state: run.state, targetState: state });
    }
    return { ...run, ...patch, state };
}

export function requireRunEpoch(run: RunSnapshot, expected: unknown): void {
    if (!Number.isSafeInteger(expected) || expected !== run.runEpoch) throw new AgentFault('STALE_RUN_EPOCH', '执行代次已经变化，请查询原执行',
        { currentRunEpoch: run.runEpoch });
}

export function validateBudget(value: Record<string, unknown>, now: number): Record<string, unknown> {
    const wallMs = value.wallMs ?? 60 * 60 * 1000;
    const maxModelCalls = value.maxModelCalls ?? 128;
    const costMode = value.costMode ?? 'hard';
    if (!Number.isSafeInteger(wallMs) || Number(wallMs) < 1 || Number(wallMs) > 365 * 24 * 60 * 60 * 1000
        || !Number.isSafeInteger(maxModelCalls) || Number(maxModelCalls) < 1) throw new AgentFault('INVALID_PARAMS', '执行时间和模型次数须为有限正整数');
    if (costMode !== 'hard' && costMode !== 'estimated') throw new AgentFault('INVALID_PARAMS', 'costMode须为hard或estimated');
    if (costMode === 'hard' && (!Number.isSafeInteger(value.maxCostMicros) || Number(value.maxCostMicros) < 0
        || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency))) {
        throw new AgentFault('BUDGET_REQUIRED', 'hard预算需要明确金额上限和三字母币种');
    }
    if (costMode === 'estimated' && (!Number.isSafeInteger(value.maxOutputTokens) || Number(value.maxOutputTokens) < 1)) {
        throw new AgentFault('BUDGET_UNBOUNDED', 'estimated预算需要有限的maxOutputTokens');
    }
    return { ...value, wallMs, maxModelCalls, costMode, maxCostMicros: value.maxCostMicros ?? null,
        currency: value.currency ?? null, deadlineAt: new Date(now + Number(wallMs)).toISOString(), spentModelCalls: 0 };
}
