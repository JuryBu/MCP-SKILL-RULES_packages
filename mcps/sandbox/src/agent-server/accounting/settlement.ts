import { AgentFault } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { ProviderAttempt, NormalizedResponse } from '../providers/types.js';
import type { AccountingCommand, PostResponseUpperBound } from './budget-ledger.js';
import { estimateReportedUsageUpperBound, priceUsage, tokenCount } from './usage.js';
import type { UsagePricingContext } from './usage.js';
import type { RequestSnapshot } from '../providers/types.js';

export function postResponseUpperBoundForResponse(input: {
    attempt: ProviderAttempt; response: NormalizedResponse; usageRevision: number;
}): PostResponseUpperBound | null {
    const { attempt, response } = input;
    const snapshot = attempt.snapshot;
    const price = snapshot.pricingSnapshot;
    if (response.attemptId !== attempt.attemptId || !response.complete || response.problems.length
        || snapshot.profile.protocol !== 'gemini' || snapshot.profile.routePolicy.kind !== 'direct'
        || !price || price.priceVersion !== snapshot.priceVersion) return null;
    try {
        const endpoint = new URL(snapshot.endpoint);
        if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'generativelanguage.googleapis.com'
            || (endpoint.port !== '' && endpoint.port !== '443') || endpoint.username || endpoint.password) return null;
        const body = JSON.parse(snapshot.body) as { generationConfig?: { maxOutputTokens?: unknown }; tools?: Array<Record<string, unknown>> };
        const maximum = tokenCount(body.generationConfig?.maxOutputTokens);
        if (!maximum || (body.tools && (!Array.isArray(body.tools)
            || body.tools.some(tool => !tool || typeof tool !== 'object' || Object.keys(tool).some(name => name !== 'functionDeclarations'))))) return null;
        const bound = estimateReportedUsageUpperBound({ usage: response.usage, price, maxOutputTokens: maximum, now: Date.parse(snapshot.frozenAt) });
        return bound ? { ...bound, currency: price.currency, source: 'frozen_price_usage', sourceRef: price.sourceRef,
            priceVersion: price.priceVersion, usageRevision: input.usageRevision } : null;
    } catch { return null; }
}

export function pricingContextForSnapshot(snapshot: RequestSnapshot): UsagePricingContext {
    if (snapshot.profile.protocol !== 'gemini' || snapshot.modelId !== 'gemini-2.5-flash'
        || snapshot.profile.routePolicy.kind !== 'direct') return {};
    try {
        const endpoint = new URL(snapshot.endpoint);
        const body = JSON.parse(snapshot.body) as { generationConfig?: { thinkingConfig?: { thinkingBudget?: unknown } } };
        if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'generativelanguage.googleapis.com'
            || (endpoint.port !== '' && endpoint.port !== '443') || endpoint.username || endpoint.password
            || body.generationConfig?.thinkingConfig?.thinkingBudget !== 0) return {};
        return { reasoningZero: { source: 'frozen_request', snapshotHash: snapshot.snapshotHash,
            parameter: 'generationConfig.thinkingConfig.thinkingBudget', value: 0 } };
    } catch { return {}; }
}

export function settlementForResponse(input: {
    attempt: ProviderAttempt; response: NormalizedResponse; currency: string; usageRevision?: number;
}): Omit<Extract<AccountingCommand, { type: 'settle' }>, 'type'> {
    const { attempt, response, currency } = input;
    if (response.attemptId !== attempt.attemptId) throw new AgentFault('E_ATTEMPT_CONFLICT', '原生响应与费用尝试身份不匹配');
    const price = attempt.snapshot.pricingSnapshot ?? attempt.snapshot.price;
    if (price && price.priceVersion !== attempt.snapshot.priceVersion) throw new AgentFault('E_PRICE_SCOPE', '结算价格与原请求冻结版本不一致');
    if (price && price.currency !== currency) throw new AgentFault('E_CURRENCY_MISMATCH', '冻结价格与根预算币种不同');
    const settlementKnown = response.complete && response.problems.length === 0;
    const context = pricingContextForSnapshot(attempt.snapshot);
    const estimate = price && settlementKnown ? priceUsage(response.usage, price, Date.parse(attempt.snapshot.frozenAt), context) : null;
    const conservativeEstimate = price && settlementKnown && estimate?.amountMicros === null
        ? priceUsage(response.usage, price, Date.parse(attempt.snapshot.frozenAt), { ...context, inputCachePolicy: 'conservative_upper_bound' }) : null;
    const nativeCost = response.usage.providerCostCurrency === currency ? response.usage.providerCostMicros : null;
    const amountMicros = settlementKnown ? nativeCost ?? estimate?.amountMicros ?? null : null;
    const postResponseUpperBound = amountMicros === null ? postResponseUpperBoundForResponse({ attempt, response, usageRevision: input.usageRevision ?? 1 }) : null;
    return { attemptId: attempt.attemptId, usageRevision: input.usageRevision ?? 1,
        providerExecutionId: response.providerResponseId, complete: amountMicros !== null,
        ...(postResponseUpperBound ? { postResponseUpperBound } : {}),
        charges: [{ component: 'model_usage', amountMicros, currency, kind: nativeCost !== null ? 'provider_reported' : 'calculated',
            usage: { normalized: response.usage, priceVersion: price?.priceVersion ?? null, estimate: estimate ?? null,
                conservativeEstimate: conservativeEstimate?.kind === 'conservative_estimate' ? conservativeEstimate : null } as unknown as JsonValue }] };
}
