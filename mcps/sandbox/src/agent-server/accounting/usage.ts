import { AgentFault } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';

export interface NormalizedUsage {
    inputTokens: number | null;
    inputUncachedTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    inputIncludesCache: boolean;
    outputIncludesReasoning: boolean;
    providerCostMicros: number | null;
    providerCostCurrency: string | null;
    raw: JsonValue;
    issues: string[];
    outputTokenDetails: Record<string, number> | null;
    providerCostBasis?: { field: 'cost_in_usd_ticks'; ticksPerUsd: 10000000000; rounding: 'ceil_to_micros' };
}

export function normalizeProgrokUsage(raw: JsonValue | undefined): NormalizedUsage {
    const normalized = normalizeUsage('compatible_chat', raw);
    const source = record(raw);
    const value = source.cost_in_usd_ticks;
    if (value === undefined || value === null) return normalized;
    let ticks: bigint;
    if (tokenCount(value) !== null) ticks = BigInt(value as number);
    else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value)) ticks = BigInt(value);
    else return { ...normalized, issues: [...normalized.issues, 'provider_cost_ticks_invalid'] };
    const micros = (ticks + 9999n) / 10000n;
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return { ...normalized, issues: [...normalized.issues, 'provider_cost_ticks_out_of_range'] };
    return { ...normalized, providerCostMicros: Number(micros), providerCostCurrency: 'USD',
        providerCostBasis: { field: 'cost_in_usd_ticks', ticksPerUsd: 10000000000, rounding: 'ceil_to_micros' } };
}

export function tokenCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export function normalizeUsage(protocol: 'compatible_chat' | 'gemini' | 'openai_responses' | 'anthropic', raw: JsonValue | undefined): NormalizedUsage {
    const usage = record(raw);
    if (protocol === 'anthropic') {
        return { inputTokens: tokenCount(usage.input_tokens), inputUncachedTokens: tokenCount(usage.input_tokens),
            outputTokens: tokenCount(usage.output_tokens), cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
            cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens), reasoningTokens: null, totalTokens: tokenCount(usage.total_tokens),
            inputIncludesCache: false, outputIncludesReasoning: true, providerCostMicros: null, providerCostCurrency: null, raw: raw ?? null, issues: [], outputTokenDetails: null };
    }
    if (protocol === 'openai_responses') {
        const normalized = normalizeUsage('compatible_chat', { prompt_tokens: usage.input_tokens ?? null, prompt_tokens_details: usage.input_tokens_details ?? null,
            completion_tokens: usage.output_tokens ?? null, completion_tokens_details: usage.output_tokens_details ?? null, total_tokens: usage.total_tokens ?? null });
        return { ...normalized, raw: raw ?? null };
    }
    const promptDetails = record(usage.prompt_tokens_details);
    const outputDetails = record(usage.completion_tokens_details);
    const inputTokens = tokenCount(protocol === 'gemini' ? usage.promptTokenCount : usage.prompt_tokens);
    const cacheReadTokens = tokenCount(protocol === 'gemini' ? usage.cachedContentTokenCount
        : usage.prompt_cache_hit_tokens ?? promptDetails.cached_tokens);
    const explicitMiss = tokenCount(usage.prompt_cache_miss_tokens);
    const issues: string[] = [];
    let outputTokenDetails: Record<string, number> | null = null;
    if (protocol === 'gemini' && Array.isArray(usage.candidatesTokensDetails)) {
        outputTokenDetails = {};
        for (const item of usage.candidatesTokensDetails) {
            const detail = record(item);
            const count = tokenCount(detail.tokenCount);
            if (typeof detail.modality !== 'string' || count === null) { issues.push('output_modality_detail_invalid'); outputTokenDetails = null; break; }
            const modality = detail.modality.toLowerCase();
            outputTokenDetails[modality] = (outputTokenDetails[modality] ?? 0) + count;
        }
        const output = tokenCount(usage.candidatesTokenCount);
        if (outputTokenDetails && output !== null && Object.values(outputTokenDetails).reduce((sum, count) => sum + count, 0) !== output) {
            issues.push('output_modality_bucket_mismatch');
            outputTokenDetails = null;
        }
    }
    let inputUncachedTokens = explicitMiss;
    if (inputUncachedTokens === null && inputTokens !== null && cacheReadTokens !== null) {
        if (cacheReadTokens <= inputTokens) inputUncachedTokens = inputTokens - cacheReadTokens;
        else issues.push('cache_read_exceeds_input');
    }
    if (explicitMiss !== null && inputTokens !== null && cacheReadTokens !== null
        && explicitMiss + cacheReadTokens !== inputTokens) issues.push('input_bucket_mismatch');
    if (issues.length) inputUncachedTokens = null;
    return {
        inputTokens, inputUncachedTokens,
        outputTokens: tokenCount(protocol === 'gemini' ? usage.candidatesTokenCount : usage.completion_tokens),
        cacheReadTokens, cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
        reasoningTokens: tokenCount(protocol === 'gemini' ? usage.thoughtsTokenCount : outputDetails.reasoning_tokens),
        totalTokens: tokenCount(protocol === 'gemini' ? usage.totalTokenCount : usage.total_tokens),
        inputIncludesCache: true, outputIncludesReasoning: protocol === 'compatible_chat',
        providerCostMicros: null, providerCostCurrency: null, raw: raw ?? null, issues, outputTokenDetails,
    };
}

export interface PriceEntry {
    priceVersion: string;
    currency: string;
    unitTokens: number;
    inputUncached: number | null;
    inputCacheRead: number | null;
    inputCacheWrite: number | null;
    output: number | null;
    reasoningBilledSeparately: boolean;
    media: 'included_in_tokens' | 'separate' | 'unknown';
    serverTools: 'disabled' | 'separate' | 'unknown';
    sourceRef: string;
    validFrom: string;
    expiresAt: string;
    coversAllParameters?: boolean;
    parameterHash?: string;
    inputCacheReadUpperBound?: number;
    outputByModality?: Record<string, number | null>;
    reasoning?: number | null;
}

export interface CostEstimate {
    amountMicros: number | null;
    currency: string;
    priceVersion: string;
    missing: string[];
    kind: 'calculated' | 'conservative_estimate' | 'upper_bound';
    assumptions?: string[];
}

export interface UsagePricingContext {
    reasoningZero?: { source: 'frozen_request'; snapshotHash: string;
        parameter: 'generationConfig.thinkingConfig.thinkingBudget'; value: 0 };
    inputCachePolicy?: 'hold' | 'conservative_upper_bound';
}

export interface ReportedUsageUpperBound {
    amountMicros: number;
    inputTokens: number;
    originalMaxOutputTokens: number;
    boundedRemainingTokens: number;
    reportedTotalTokens: number | null;
    method: 'reported_total_tokens' | 'original_output_cap';
}

function money(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) throw new AgentFault('E_PRICE_RANGE', '金额超出精确定点范围');
    return Number(value);
}

function cost(tokens: number, rate: number, unit: number): bigint {
    return (BigInt(tokens) * BigInt(rate) + BigInt(unit) - 1n) / BigInt(unit);
}

export function validatePrice(price: PriceEntry, now = Date.now()): void {
    if (!price.priceVersion || !price.sourceRef || !/^[A-Z]{3}$/.test(price.currency)
        || tokenCount(price.unitTokens) === null || price.unitTokens < 1
        || !Number.isFinite(Date.parse(price.validFrom)) || Date.parse(price.validFrom) > now
        || !Number.isFinite(Date.parse(price.expiresAt)) || Date.parse(price.expiresAt) <= now) {
        throw new AgentFault('E_PRICE_UNKNOWN', '价格版本、币种、单位或有效期不完整');
    }
    for (const rate of [price.inputUncached, price.inputCacheRead, price.inputCacheWrite, price.output,
        price.inputCacheReadUpperBound ?? null, price.reasoning ?? null, ...Object.values(price.outputByModality ?? {})]) {
        if (rate !== null && tokenCount(rate) === null) throw new AgentFault('E_PRICE_UNKNOWN', '价格必须为非负整数微金额');
    }
    if (price.output !== null && Object.values(price.outputByModality ?? {}).some(rate => rate !== null && rate > price.output!)) {
        throw new AgentFault('E_PRICE_UNKNOWN', '输出预留价格低于已知模态价格');
    }
    if (price.output !== null && price.reasoning !== undefined && price.reasoning !== null && price.reasoning > price.output) {
        throw new AgentFault('E_PRICE_UNKNOWN', '输出预留价格低于已知thinking价格');
    }
}

export function priceUsage(usage: NormalizedUsage, price: PriceEntry, now = Date.now(), context: UsagePricingContext = {}): CostEstimate {
    validatePrice(price, now);
    const missing = [...usage.issues];
    const assumptions: string[] = [];
    const zeroProof = context.reasoningZero;
    const reasoningProvenZero = zeroProof?.source === 'frozen_request' && zeroProof.value === 0
        && zeroProof.parameter === 'generationConfig.thinkingConfig.thinkingBudget' && /^[a-f0-9]{64}$/.test(zeroProof.snapshotHash);
    let reasoning = usage.reasoningTokens;
    if (reasoningProvenZero) {
        if (reasoning === null) { reasoning = 0; assumptions.push('reasoning_zero_from_frozen_request'); }
        else if (reasoning !== 0) missing.push('reasoning_configuration_conflict');
    }
    let input = usage.inputUncachedTokens;
    let cached = usage.cacheReadTokens;
    if (usage.inputIncludesCache && price.inputUncached === price.inputCacheRead && usage.inputTokens !== null) {
        input = usage.inputTokens;
        cached = 0;
    }
    let output = usage.outputTokens;
    let amount = 0n;
    let conservativeInput = false;
    if (context.inputCachePolicy === 'conservative_upper_bound' && usage.inputIncludesCache && usage.inputTokens !== null
        && input === null && cached === null && price.inputUncached !== null
        && (price.inputCacheRead !== null || price.inputCacheReadUpperBound !== undefined)) {
        amount += cost(usage.inputTokens, Math.max(price.inputUncached, price.inputCacheRead ?? price.inputCacheReadUpperBound!), price.unitTokens);
        conservativeInput = true;
        assumptions.push('unknown_input_cache_all_input_at_max_rate');
    }
    if (price.outputByModality) {
        if (!usage.outputTokenDetails) missing.push('output_modality_usage');
        else for (const [modality, count] of Object.entries(usage.outputTokenDetails)) {
            const rate = price.outputByModality[modality];
            if (count === 0) continue;
            if (rate === undefined || rate === null) missing.push(`output_${modality}_price`);
            else amount += cost(count, rate, price.unitTokens);
        }
        if (!usage.outputIncludesReasoning && price.reasoningBilledSeparately) {
            if (reasoning === null || price.reasoning === undefined || price.reasoning === null) missing.push('reasoning_usage_or_price');
            else amount += cost(reasoning, price.reasoning, price.unitTokens);
        }
    } else if (!usage.outputIncludesReasoning && price.reasoningBilledSeparately) {
        if (reasoning === null) missing.push('reasoning_usage');
        output = output !== null && reasoning !== null ? output + reasoning : null;
    }
    const buckets: Array<[string, number | null, number | null]> = conservativeInput ? [] : [
        ['input_uncached', input, price.inputUncached], ['input_cache_read', cached, price.inputCacheRead],
    ];
    if (!price.outputByModality) buckets.push(['output', output, price.output]);
    if (price.inputCacheWrite !== null) buckets.push(['input_cache_write', usage.cacheWriteTokens, price.inputCacheWrite]);
    for (const [name, count, rate] of buckets) {
        if (count === 0) continue;
        if (count === null || rate === null) missing.push(name);
        else amount += cost(count, rate, price.unitTokens);
    }
    if (price.media !== 'included_in_tokens') missing.push('media_pricing');
    if (price.serverTools !== 'disabled') missing.push('server_tools_pricing');
    return { amountMicros: missing.length ? null : money(amount), currency: price.currency,
        priceVersion: price.priceVersion, missing, kind: conservativeInput ? 'conservative_estimate' : 'calculated', assumptions };
}

export function estimateUpperBound(input: {
    price: PriceEntry; maxInputTokens: number | null; maxOutputTokens: number | null;
    maxCacheWriteTokens?: number | null; includesMedia?: boolean; includesServerTools?: boolean; now?: number;
}): CostEstimate {
    const { price } = input;
    validatePrice(price, input.now);
    const missing: string[] = [];
    if (tokenCount(input.maxInputTokens) === null) missing.push('max_input_tokens');
    if (tokenCount(input.maxOutputTokens) === null || input.maxOutputTokens === 0) missing.push('max_output_tokens');
    if (price.inputUncached === null) missing.push('input_price');
    if (price.inputCacheRead === null && price.inputCacheReadUpperBound === undefined) missing.push('cache_read_upper_bound');
    if (price.output === null) missing.push('output_price');
    if (input.includesMedia && price.media !== 'included_in_tokens') missing.push('media_upper_bound');
    if (input.includesServerTools || price.serverTools !== 'disabled') missing.push('server_tool_upper_bound');
    if (price.inputCacheWrite !== null && tokenCount(input.maxCacheWriteTokens) === null) missing.push('cache_write_upper_bound');
    let amount = 0n;
    if (!missing.length) {
        const inputRate = Math.max(price.inputUncached!, price.inputCacheRead ?? price.inputCacheReadUpperBound ?? price.inputUncached!);
        amount = cost(input.maxInputTokens!, inputRate, price.unitTokens) + cost(input.maxOutputTokens!, price.output!, price.unitTokens);
        if (price.inputCacheWrite !== null) amount += cost(input.maxCacheWriteTokens!, price.inputCacheWrite, price.unitTokens);
    }
    return { amountMicros: missing.length ? null : money(amount), currency: price.currency,
        priceVersion: price.priceVersion, missing, kind: 'upper_bound' };
}

export function estimateReportedUsageUpperBound(input: {
    usage: NormalizedUsage; price: PriceEntry; maxOutputTokens: number; now?: number;
}): ReportedUsageUpperBound | null {
    const { usage, price } = input;
    validatePrice(price, input.now);
    const raw = record(usage.raw);
    const prompt = tokenCount(raw.promptTokenCount);
    const total = tokenCount(raw.totalTokenCount);
    const candidates = tokenCount(raw.candidatesTokenCount);
    const thoughts = tokenCount(raw.thoughtsTokenCount);
    const toolInput = tokenCount(raw.toolUsePromptTokenCount);
    const details = Array.isArray(raw.candidatesTokensDetails) ? raw.candidatesTokensDetails : null;
    let detailedTokens = 0;
    for (const item of details ?? []) {
        const detail = record(item);
        const count = tokenCount(detail.tokenCount);
        if (typeof detail.modality !== 'string' || count === null) return null;
        const rate = price.outputByModality?.[detail.modality.toLowerCase()];
        if (count > 0 && price.outputByModality && (rate === undefined || rate === null)) return null;
        detailedTokens += count;
        if (!Number.isSafeInteger(detailedTokens) || (candidates !== null && detailedTokens > candidates)) return null;
    }
    const incompleteModalities = details !== null && candidates !== null && detailedTokens < candidates
        && usage.issues.every(issue => issue === 'output_modality_bucket_mismatch');
    if ((usage.issues.length && !incompleteModalities) || !usage.inputIncludesCache || prompt === null || prompt !== usage.inputTokens
        || typeof raw.serviceTier !== 'string' || raw.serviceTier.toLowerCase() !== 'standard'
        || tokenCount(input.maxOutputTokens) === null || input.maxOutputTokens < 1
        || price.coversAllParameters !== true || price.inputUncached === null || price.output === null
        || (price.inputCacheRead === null && price.inputCacheReadUpperBound === undefined)
        || price.inputCacheWrite !== null || price.media !== 'included_in_tokens' || price.serverTools !== 'disabled'
        || (price.outputByModality && (!Object.keys(price.outputByModality).length
            || Object.values(price.outputByModality).some(rate => rate === null)
            || (price.reasoningBilledSeparately && (price.reasoning === undefined || price.reasoning === null))))
        || ['totalTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount']
            .some(field => raw[field] !== undefined && tokenCount(raw[field]) === null)) return null;
    const inputRate = Math.max(price.inputUncached, price.inputCacheRead ?? price.inputCacheReadUpperBound ?? price.inputUncached);
    let boundedRemainingTokens = input.maxOutputTokens;
    let inputTokens = prompt;
    let remainingRate = price.output;
    let method: ReportedUsageUpperBound['method'] = 'original_output_cap';
    if (total !== null) {
        if (total !== usage.totalTokens || total < prompt || total - prompt < detailedTokens
            || total - prompt < (candidates ?? 0) + (thoughts ?? 0) + (toolInput ?? 0)) return null;
        boundedRemainingTokens = total - prompt;
        remainingRate = Math.max(inputRate, price.output);
        method = 'reported_total_tokens';
    } else {
        if (toolInput === null || !Number.isSafeInteger(prompt + toolInput)
            || (candidates ?? 0) + (thoughts ?? 0) > input.maxOutputTokens) return null;
        inputTokens += toolInput;
    }
    const amountMicros = money(cost(inputTokens, inputRate, price.unitTokens) + cost(boundedRemainingTokens, remainingRate, price.unitTokens));
    return { amountMicros, inputTokens, originalMaxOutputTokens: input.maxOutputTokens,
        boundedRemainingTokens, reportedTotalTokens: total, method };
}
