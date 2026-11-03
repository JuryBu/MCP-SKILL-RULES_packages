import type { PriceEntry } from '../accounting/usage.js';
import { objectValue } from '../providers/assemble.js';
import { normalizeCompatibleChatMetadata } from '../providers/compatible-chat.js';
import type { ProviderProfile } from '../providers/types.js';
import type { ModelEntry, ParameterSpec } from './catalog.js';
import type { Evidence } from './evidence.js';

const priceUnitSource = 'https://github.com/xai-org/xai-sdk-ts';
const cachePricingSource = 'https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing';
const cachePolicySource = 'https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works';
const modelSource = 'https://docs.x.ai/developers/models/grok-4.20-0309-non-reasoning';
const outputSource = 'https://docs.x.ai/developers/model-capabilities/text/best-practices';
const chatSource = 'https://docs.x.ai/developers/model-capabilities/text/comparison';
const documentObservedAt = '2026-11-02T23:00:00.000Z';
const protocolDeclarationVersion = 'progrok-local-chat-v1-doc-2026-11-03';

function documentedEntry(entry: ModelEntry): ModelEntry {
    if (entry.protocol !== 'progrok' || entry.modelId !== 'grok-4.20-0309-non-reasoning' || entry.retired) return entry;
    const expiresAt = entry.contextWindow.expiresAt;
    if (Date.parse(expiresAt) <= Date.parse(documentObservedAt)) return entry;
    const declared = <Value>(value: Value, sourceRef: string): Evidence<Value> & { declarationKind: string; validity: string } => ({ scope: entry.contextWindow.scope,
        value, status: 'supported', source: 'manual', sourceRef, observedAt: documentObservedAt, expiresAt,
        version: protocolDeclarationVersion, confidence: 'declared', declarationKind: 'versioned_builtin_protocol', validity: 'catalog_snapshot' });
    const maximum: ParameterSpec = { type: 'integer', min: 1, required: true, wirePath: 'max_tokens',
        outputLimitKind: 'visible_tokens', outputLimitSourceRef: outputSource };
    return { ...entry, tools: entry.tools.status === 'unknown' ? declared(true, modelSource) : entry.tools,
        parameters: { ...entry.parameters, ...(!entry.parameters.maxOutputTokens || entry.parameters.maxOutputTokens.status === 'unknown'
            ? { maxOutputTokens: declared(maximum, chatSource) } : {}) } };
}

function rate(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeProgrokMetadata(profile: ProviderProfile, entry: ModelEntry): ModelEntry {
    const original = entry.rawMetadata;
    const languageModel = objectValue(original.progrokLanguageModel);
    const language = languageModel?.id === entry.modelId ? languageModel : null;
    const metadata = language ? { ...original, ...language, id: entry.modelId,
        ...(Object.hasOwn(original, 'context_length') ? { context_length: original.context_length } : {}) } : original;
    const capabilities = objectValue(metadata.capabilities);
    const nativeEffort = !Object.hasOwn(metadata, 'effort') && Array.isArray(capabilities?.reasoning_effort);
    const normalizedMetadata = nativeEffort ? { ...metadata, effort: { supported_levels: capabilities!.reasoning_effort,
        ...(capabilities!.default_reasoning_effort !== undefined ? { default_level: capabilities!.default_reasoning_effort } : {}) } } : metadata;
    const normalized = normalizeCompatibleChatMetadata({ ...entry, rawMetadata: normalizedMetadata });
    const base = new URL(profile.baseUrl);
    const modelSource = `${base.origin}/v1/models`;
    const languageSource = `${base.origin}/v1/language-models`;
    const sourceFor = (field: string): string => language && Object.hasOwn(language, field) ? languageSource : modelSource;
    const withSource = <Value>(evidence: Evidence<Value>, sourceRef: string): Evidence<Value> => ({ ...evidence, sourceRef });
    const result: ModelEntry = documentedEntry({ ...normalized, rawMetadata: original,
        contextWindow: withSource(normalized.contextWindow, Object.hasOwn(original, 'context_length') ? modelSource : sourceFor('context_window')),
        maxOutputTokens: withSource(normalized.maxOutputTokens, sourceFor('max_output_tokens')),
        inputModalities: withSource(normalized.inputModalities, sourceFor('input_modalities')),
        outputModalities: withSource(normalized.outputModalities, sourceFor('output_modalities')),
        parameters: { ...Object.fromEntries(Object.entries(normalized.parameters).map(([name, evidence]) => [name,
            withSource(evidence, sourceFor(name === 'reasoningEffort' ? nativeEffort ? 'capabilities' : 'effort' : 'max_output_tokens'))])),
            ...Object.fromEntries(Object.entries(entry.parameters).filter(([, evidence]) => evidence.status !== 'unknown')) } });
    const fields = ['prompt_text_token_price', 'cached_prompt_text_token_price', 'completion_text_token_price'] as const;
    const hasLongContext = Object.hasOwn(metadata, 'long_context_threshold')
        || fields.some(field => Object.hasOwn(metadata, `${field}_long_context`));
    const threshold = metadata.long_context_threshold;
    if (hasLongContext && (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 1)) return result;
    const prices = fields.map(field => {
        const ordinary = rate(metadata[field]);
        const extended = hasLongContext ? rate(metadata[`${field}_long_context`]) : ordinary;
        return ordinary === null || extended === null ? null : Math.max(ordinary, extended);
    });
    if (prices.some(value => value === null)) return result;
    const imagePrice = rate(metadata.prompt_image_token_price);
    const price: PriceEntry & { basis: { kind: string; unitSourceRef: string; originalRateUnit: string;
        longContextThreshold: number | null; billing: string; reasoningPriceSourceRef: string;
        cacheWritePolicy: string; cachePolicySourceRefs: string[] } } = {
        priceVersion: `progrok-catalog-max-short-long-context-${entry.pricing.version}`,
        currency: 'USD', unitTokens: 10_000, inputUncached: Math.max(prices[0]!, imagePrice ?? 0),
        inputCacheRead: prices[1]!, inputCacheWrite: null, output: prices[2]!, reasoning: prices[2]!, reasoningBilledSeparately: true,
        media: imagePrice === null ? 'unknown' : 'included_in_tokens', serverTools: 'disabled',
        sourceRef: sourceFor(fields[0]), validFrom: entry.pricing.observedAt, expiresAt: entry.pricing.expiresAt,
        coversAllParameters: true, basis: { kind: 'catalog_max_short_long_context', unitSourceRef: priceUnitSource,
            originalRateUnit: 'USD_cents_per_100_million_tokens', longContextThreshold: hasLongContext ? Number(threshold) : null,
            billing: 'catalog_rates_account_charge_unknown', reasoningPriceSourceRef: cachePricingSource,
            cacheWritePolicy: 'automatic_prefill_in_prompt_rate', cachePolicySourceRefs: [cachePolicySource, cachePricingSource] },
    };
    return { ...result, pricing: { ...entry.pricing, value: price, status: 'supported', sourceRef: price.sourceRef } };
}
