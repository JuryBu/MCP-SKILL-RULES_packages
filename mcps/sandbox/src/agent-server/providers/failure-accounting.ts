import { AgentFault } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import { settlementForResponse } from '../accounting/settlement.js';
import { tokenCount } from '../accounting/usage.js';
import type { NormalizedUsage } from '../accounting/usage.js';
import type { AccountingCommand, BudgetView, ChargeRecord } from '../accounting/budget-ledger.js';
import type { RecordedFailure } from './dispatch.js';
import type { NormalizedResponse, ProviderAttempt, RawProviderResponse } from './types.js';
import { responseUsage } from './http.js';
import { objectValue, stringValue } from './assemble.js';

type Settlement = Omit<Extract<AccountingCommand, { type: 'settle' }>, 'type'>;

export function failureHasExecutionEvidence(failure: { usage?: NormalizedUsage; partialResponse?: NormalizedResponse; rawResponse?: RawProviderResponse }): boolean {
    const raw = failure.rawResponse?.json ?? failure.partialResponse?.raw.json;
    return failure.usage !== undefined || Boolean(failure.partialResponse?.blocks.length || failure.partialResponse?.toolCalls.length)
        || Boolean(raw && (raw.usage != null || raw.usageMetadata != null
            || ['output', 'candidates', 'choices'].some(name => Array.isArray(raw[name]) && raw[name].length > 0)));
}

export function financialInputTokens(usage: NormalizedUsage): number | null {
    if (usage.inputTokens === null) return null;
    const total = usage.inputTokens + (usage.inputIncludesCache ? 0 : (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0));
    return Number.isSafeInteger(total) ? total : null;
}

export function providerChargesForAttempt(view: BudgetView, attempt: ProviderAttempt, responseId?: string | null): ChargeRecord[] {
    const reservation = view.reservations.find(item => item.attemptId === attempt.attemptId);
    return view.charges.filter(charge => charge.quotaScopeId === attempt.snapshot.profile.quotaScopeId
        && (charge.attemptId === attempt.attemptId || charge.executionKey === reservation?.executionKey
            || responseId && charge.executionKey === `execution:${responseId}`));
}

export function nextProviderUsageRevision(view: BudgetView, attempt: ProviderAttempt, responseId?: string | null): number {
    return Math.max(0, ...providerChargesForAttempt(view, attempt, responseId).map(charge => charge.usageRevision)) + 1;
}

export function failureUsageResponse(attempt: ProviderAttempt, failure: RecordedFailure): NormalizedResponse | null {
    const partial = failure.partialResponse;
    if (partial && partial.attemptId !== attempt.attemptId) throw new AgentFault('E_RESPONSE_IDENTITY', '部分响应与原费用尝试不一致');
    const raw = failure.rawResponse ?? partial?.raw;
    const observed = failure.usage ?? partial?.usage ?? (raw ? responseUsage(attempt.snapshot.profile.protocol, raw.json) : null);
    if (!observed || ![observed.inputTokens, observed.outputTokens, observed.cacheReadTokens, observed.cacheWriteTokens,
        observed.reasoningTokens, observed.totalTokens, observed.providerCostMicros].some(value => tokenCount(value) !== null)) return null;
    const usage: NormalizedUsage = { ...observed, raw: null };
    return { attemptId: attempt.attemptId, providerRequestId: partial?.providerRequestId
        ?? raw?.headers['x-request-id'] ?? raw?.headers['request-id'] ?? null,
    providerResponseId: partial?.providerResponseId ?? (raw ? stringValue(raw.json.id ?? raw.json.responseId) : null),
    modelId: partial?.modelId ?? attempt.snapshot.modelId, routeId: partial?.routeId ?? null,
    blocks: [], toolCalls: [], replayMessages: [], complete: false, canExecuteTools: false,
    stop: { kind: 'unknown', native: null }, problems: ['E_FAILURE_OUTCOME_UNKNOWN'], usage,
    raw: raw ?? { httpStatus: 0, headers: {}, body: '', json: {} } };
}

export function preserveKnownProviderCharges(settlement: Settlement, view: BudgetView, attempt: ProviderAttempt): Settlement {
    const previous = providerChargesForAttempt(view, attempt, settlement.providerExecutionId);
    let retained = false;
    const charges = settlement.charges.map(charge => {
        const old = previous.find(item => item.component === charge.component);
        if (!old || old.amountMicros === null || charge.amountMicros !== null && !(old.kind === 'provider_reported' && charge.kind !== 'provider_reported')) return charge;
        retained = true;
        return { ...charge, amountMicros: old.amountMicros, currency: old.currency, kind: old.kind,
            usage: { ...(objectValue(charge.usage) ?? {}), retainedReportedCost: { amountMicros: old.amountMicros, currency: old.currency, kind: old.kind } } as JsonValue };
    });
    return { ...settlement, charges, complete: settlement.complete && !retained };
}

export function settlementForFailure(attempt: ProviderAttempt, response: NormalizedResponse, view: BudgetView): Settlement {
    const calculated = settlementForResponse({ attempt, response, currency: view.budget.currency,
        usageRevision: nextProviderUsageRevision(view, attempt, response.providerResponseId) });
    const amount = tokenCount(response.usage.providerCostMicros);
    const reportedCurrency = response.usage.providerCostCurrency;
    return preserveKnownProviderCharges({ ...calculated, complete: false, charges: calculated.charges.map(charge => ({ ...charge,
        ...(amount !== null && reportedCurrency === charge.currency ? { amountMicros: amount, kind: 'provider_reported' as const } : {}) })) }, view, attempt);
}
