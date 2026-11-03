import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProgrokUsage, normalizeUsage, estimateUpperBound, priceUsage } from '../../../src/agent-server/accounting/usage.ts';
import { entryFromMetadata } from '../../../src/agent-server/models/catalog.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const now = Date.parse('2026-11-02T23:19:06.000Z');
const observedAt = new Date(now).toISOString();
const expiresAt = new Date(now + 86_400_000).toISOString();
const profile = newProfile({ profileId: 'progrok-usage-local', label: 'owned usage fixture', protocol: 'progrok',
    baseUrl: 'http://127.0.0.1:41998/v1', modelId: 'fixture-language-model' });
const entry = entryFromMetadata(profile, { id: 'fixture-language-model', context_length: 1_000_000,
    input_modalities: ['text', 'image'], output_modalities: ['text'], prompt_text_token_price: 12_500,
    cached_prompt_text_token_price: 2_000, completion_text_token_price: 25_000, prompt_image_token_price: 12_500,
    prompt_text_token_price_long_context: 25_000, cached_prompt_text_token_price_long_context: 4_000,
    completion_text_token_price_long_context: 50_000, long_context_threshold: 200_000 }, observedAt, expiresAt);
const price = entry.pricing.value;
const usage = reasoning => ({ prompt_tokens: 32, completion_tokens: 9, total_tokens: 41 + (reasoning ?? 0),
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: reasoning === undefined ? {} : { reasoning_tokens: reasoning } });

test('Progrok completion excludes separately reported reasoning while compatible Chat retains its existing semantics (pure usage)', () => {
    const raw = usage(94);
    const normalized = normalizeProgrokUsage(raw);
    assert.equal(normalized.inputTokens, 32);
    assert.equal(normalized.outputTokens, 9);
    assert.equal(normalized.reasoningTokens, 94);
    assert.equal(normalized.totalTokens, 135);
    assert.equal(normalized.outputIncludesReasoning, false);
    assert.equal(normalized.providerCostMicros, null);
    assert.equal(normalized.raw, raw);
    assert.equal(normalizeUsage('compatible_chat', raw).outputIncludesReasoning, true);
    assert.equal(normalizeUsage('openai_responses', { input_tokens: 32, output_tokens: 103,
        output_tokens_details: { reasoning_tokens: 94 } }).outputIncludesReasoning, true);
});

test('Progrok catalog output price covers separately reported reasoning without classifying models by name (pure pricing)', () => {
    assert.equal(price.reasoningBilledSeparately, true);
    assert.equal(price.reasoning, 50_000);
    assert.equal(price.output, 50_000);
    assert.match(price.basis.reasoningPriceSourceRef, /usage-and-pricing$/);
    const estimate = priceUsage(normalizeProgrokUsage(usage(94)), price, now);
    assert.equal(estimate.amountMicros, 595);
    assert.deepEqual(estimate.missing, []);
    const explicitZero = priceUsage(normalizeProgrokUsage(usage(0)), price, now);
    assert.equal(explicitZero.amountMicros, 125);
    const missing = normalizeProgrokUsage(usage(undefined));
    assert.equal(missing.reasoningTokens, null);
    assert.equal(priceUsage(missing, price, now).amountMicros, null);
    assert.ok(priceUsage(missing, price, now).missing.includes('reasoning_usage'));
});

test('automatic cache establishment uses prompt pricing and a positive maxCacheWriteTokens does not create an independent fee (pure estimator)', () => {
    assert.equal(price.inputCacheWrite, null);
    assert.equal(price.basis.cacheWritePolicy, 'automatic_prefill_in_prompt_rate');
    assert.equal(price.basis.cachePolicySourceRefs.length, 2);
    const standard = estimateUpperBound({ price, maxInputTokens: 100, maxOutputTokens: 256, now });
    const automaticCache = estimateUpperBound({ price, maxInputTokens: 100, maxOutputTokens: 256,
        maxCacheWriteTokens: 100, now });
    assert.equal(automaticCache.amountMicros, 1530);
    assert.deepEqual(automaticCache, standard);
});

test('Progrok preserves reported cost ticks independently from missing reasoning and never fills unknown usage with zero (pure usage)', () => {
    const raw = { ...usage(undefined), cost_in_usd_ticks: '1234500' };
    const normalized = normalizeProgrokUsage(raw);
    assert.equal(normalized.reasoningTokens, null);
    assert.equal(normalized.outputIncludesReasoning, false);
    assert.equal(normalized.providerCostMicros, 124);
    assert.equal(normalized.providerCostCurrency, 'USD');
    assert.equal(normalized.raw.cost_in_usd_ticks, '1234500');
    assert.equal(normalized.providerCostBasis.rounding, 'ceil_to_micros');
    assert.equal(normalizeProgrokUsage({}).outputTokens, null);
    assert.equal(normalizeProgrokUsage({}).reasoningTokens, null);
});

test('inconsistent Progrok token buckets keep calculated fees unknown and retain separately reported cost (pure usage)', () => {
    const raw = { ...usage(94), total_tokens: 41, cost_in_usd_ticks: '1234500' };
    const normalized = normalizeProgrokUsage(raw);
    assert.ok(normalized.issues.includes('progrok_total_token_bucket_mismatch'));
    assert.equal(priceUsage(normalized, price, now).amountMicros, null);
    assert.equal(normalized.providerCostMicros, 124);
    assert.equal(normalized.raw.total_tokens, 41);
    assert.equal(normalized.reasoningTokens, 94);
});
