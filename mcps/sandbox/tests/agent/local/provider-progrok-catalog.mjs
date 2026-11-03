import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgrokAdapter } from '../../../src/agent-server/providers/progrok.ts';
import { createProviderServices } from '../../../src/agent-server/providers/services.ts';
import { MemoryAccountingPort } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { estimateUpperBound } from '../../../src/agent-server/accounting/usage.ts';
import { MemoryProfilePort, newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { MemoryCatalogPort, ModelCatalog, entryFromMetadata, resolveParameters, resolveRuntimeOutputBudget, validateCapabilities, validateModelEntry } from '../../../src/agent-server/models/catalog.ts';
import { normalizeProgrokMetadata } from '../../../src/agent-server/models/progrok.ts';

const now = Date.parse('2026-11-02T23:00:04.665Z');
const observedAt = new Date(now).toISOString();
const expiresAt = new Date(now + 86_400_000).toISOString();
const profile = () => ({ ...newProfile({ profileId: 'progrok-catalog-local', label: 'owned catalog fixture', protocol: 'progrok',
    baseUrl: 'http://127.0.0.1:41998/v1', modelId: 'grok-4.20-0309-non-reasoning' }),
    quotaScopeId: 'progrok-catalog-local-account', quotaLimitId: 'progrok-catalog-local-quota' });
const model = () => ({ id: 'grok-4.20-0309-non-reasoning', context_length: 1_000_000, object: 'model', owned_by: 'xai',
    prompt_text_token_price: 12_500, cached_prompt_text_token_price: 2_000, completion_text_token_price: 25_000,
    prompt_text_token_price_long_context: 25_000, cached_prompt_text_token_price_long_context: 4_000,
    completion_text_token_price_long_context: 50_000, long_context_threshold: 200_000, prompt_image_token_price: 12_500 });
const language = () => {
    const { context_length, ...metadata } = model();
    return { ...metadata, input_modalities: ['text', 'image'], output_modalities: ['text'], fingerprint: 'fixture-fingerprint',
        aliases: ['fixture-alias'], search_price: 0 };
};
const response = json => ({ status: 200, headers: {}, body: JSON.stringify(json) });

test('Progrok normal discovery joins exact IDs and preserves both API metadata objects without generation (local transport fixture)', async () => {
    const requests = [];
    const primary = model();
    const details = language();
    const unknown = { id: 'fixture-unrelated-model', context_length: 8192 };
    const mismatched = { ...details, id: 'fixture-unmatched-model', aliases: [unknown.id] };
    const config = profile();
    const catalog = new ModelCatalog(new MemoryCatalogPort(), () => now);
    const snapshot = await catalog.refresh(config, new ProgrokAdapter(), { transport: { async request(request) {
        requests.push(request);
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.Authorization, 'Bearer anything');
        assert.equal(request.maxResponseBytes, 4 * 1024 * 1024);
        return new URL(request.url).pathname.endsWith('/language-models')
            ? response({ models: [details, mismatched] }) : response({ data: [primary, unknown] });
    } } });
    assert.equal(requests.length, 2);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    const entry = snapshot.entries.find(value => value.modelId === primary.id);
    assert.equal(entry.contextWindow.value, 1_000_000);
    assert.equal(entry.contextWindow.sourceRef, 'http://127.0.0.1:41998/v1/models');
    assert.deepEqual(entry.inputModalities.value, ['text', 'image']);
    assert.deepEqual(entry.outputModalities.value, ['text']);
    assert.equal(entry.inputModalities.sourceRef, 'http://127.0.0.1:41998/v1/language-models');
    assert.equal(entry.inputModalities.source, 'api');
    assert.equal(entry.inputModalities.confidence, 'declared');
    assert.equal(entry.maxOutputTokens.status, 'unknown');
    assert.equal(entry.maxOutputTokens.value, null);
    assert.equal(entry.tools.value, true);
    assert.equal(entry.tools.source, 'manual');
    assert.equal(entry.tools.declarationKind, 'versioned_builtin_protocol');
    assert.equal(entry.tools.confidence, 'declared');
    assert.equal(entry.streaming.status, 'unknown');
    assert.equal(entry.parameters.maxOutputTokens.value.wirePath, 'max_tokens');
    assert.equal(entry.parameters.maxOutputTokens.value.outputLimitKind, 'visible_tokens');
    assert.equal(entry.parameters.maxOutputTokens.value.max, undefined);
    assert.deepEqual(entry.rawMetadata, { ...primary, progrokLanguageModel: details });
    const unrelated = snapshot.entries.find(value => value.modelId === unknown.id);
    assert.equal(unrelated.contextWindow.value, 8192);
    for (const field of ['inputModalities', 'outputModalities', 'pricing', 'tools', 'maxOutputTokens']) {
        assert.equal(unrelated[field].status, 'unknown');
    }
    assert.deepEqual(unrelated.rawMetadata, unknown);
    validateModelEntry(entry, config);
});

test('Progrok catalog prices retain integer units and label conservative short-long rates separately from account billing (pure metadata)', () => {
    const raw = { ...model(), progrokLanguageModel: language() };
    const before = structuredClone(raw);
    const entry = entryFromMetadata(profile(), raw, observedAt, expiresAt);
    const price = entry.pricing.value;
    assert.equal(entry.pricing.source, 'api');
    assert.equal(entry.pricing.confidence, 'declared');
    assert.equal(price.unitTokens, 10_000);
    assert.equal(price.inputUncached, 25_000);
    assert.equal(price.inputCacheRead, 4_000);
    assert.equal(price.output, 50_000);
    assert.equal(price.inputUncached * 1_000_000 / price.unitTokens / 1_000_000, 2.5);
    assert.equal(price.basis.kind, 'catalog_max_short_long_context');
    assert.equal(price.basis.billing, 'catalog_rates_account_charge_unknown');
    assert.match(price.basis.unitSourceRef, /xai-org\/xai-sdk-ts/);
    assert.equal(price.basis.longContextThreshold, 200_000);
    assert.equal(estimateUpperBound({ price, maxInputTokens: 100, maxOutputTokens: 256, now }).amountMicros, 1530);
    assert.deepEqual(raw, before);
    assert.equal(entry.rawMetadata, raw);
    for (const value of [undefined, null, '25000', -1, 0.5]) {
        const incomplete = model();
        incomplete.completion_text_token_price_long_context = value;
        assert.equal(entryFromMetadata(profile(), incomplete, observedAt, expiresAt).pricing.status, 'unknown');
    }
    const explicitZero = Object.fromEntries(Object.entries(model()).map(([key, value]) =>
        [key, key.includes('token_price') ? 0 : value]));
    assert.equal(entryFromMetadata(profile(), explicitZero, observedAt, expiresAt).pricing.value.output, 0);
});

test('missing optional language-models endpoint retains known primary fields and unknown capabilities (local transport fixture)', async () => {
    const catalog = new ModelCatalog(new MemoryCatalogPort(), () => now);
    const snapshot = await catalog.refresh(profile(), new ProgrokAdapter(), { transport: { async request(request) {
        return new URL(request.url).pathname.endsWith('/language-models')
            ? { status: 404, headers: {}, body: '{}' } : response({ data: [{ id: 'fixture-minimal', context_length: 8192 }] });
    } } });
    assert.equal(snapshot.entries[0].contextWindow.value, 8192);
    for (const field of ['inputModalities', 'outputModalities', 'maxOutputTokens', 'tools', 'pricing']) {
        assert.equal(snapshot.entries[0][field].status, 'unknown');
    }
});

test('Progrok native effort capabilities use the declared enum and default without model-name inference (pure metadata)', () => {
    const metadata = { ...model(), id: 'fixture-effort-model', progrokLanguageModel: { ...language(), id: 'fixture-effort-model',
        capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'high' } } };
    const entry = entryFromMetadata(profile(), metadata, observedAt, expiresAt);
    const effort = entry.parameters.reasoningEffort;
    assert.deepEqual(effort.value.enum, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(effort.value.default, 'high');
    assert.equal(effort.value.wirePath, 'reasoning_effort');
    assert.equal(effort.source, 'api');
    assert.equal(effort.sourceRef, 'http://127.0.0.1:41998/v1/language-models');
    assert.deepEqual(resolveParameters(entry, profile(), { reasoningEffort: 'low' }, now), { reasoning_effort: 'low' });
    assert.equal(entry.maxOutputTokens.status, 'unknown');
    assert.equal(entry.tools.status, 'unknown');
    assert.deepEqual(entry.rawMetadata, metadata);
});

test('incomplete richer catalog keeps the previous complete snapshot (local transport fixture)', async () => {
    const config = profile();
    const catalog = new ModelCatalog(new MemoryCatalogPort(), () => now);
    let catalogModels = [language()];
    const transport = { async request(request) {
        return new URL(request.url).pathname.endsWith('/language-models')
            ? response({ models: catalogModels }) : response({ data: [model()] });
    } };
    const first = await catalog.refresh(config, new ProgrokAdapter(), { transport });
    for (const incomplete of [[language(), language()], [{ fingerprint: 'missing-identity' }]]) {
        catalogModels = incomplete;
        await assert.rejects(catalog.refresh(config, new ProgrokAdapter(), { transport }), { code: 'E_CATALOG_INCOMPLETE' });
        assert.deepEqual((await catalog.get(config.profileId, config.defaultModel)).catalog, first);
    }
});

test('known catalog prices and visible request budget retain the separate unknown billable-output gate (local transport fixture)', async () => {
    const requests = [];
    const services = createProviderServices({ accountingPort: new MemoryAccountingPort(), profilePort: new MemoryProfilePort(),
        catalogPort: new MemoryCatalogPort(), now: () => now, transport: { async request(request) {
            requests.push(request);
            assert.equal(request.method, 'GET');
            return new URL(request.url).pathname.endsWith('/language-models')
                ? response({ models: [language()] }) : response({ data: [model()] });
        } } });
    try {
        const config = (await services.profiles.put(profile(), 0, { principalId: 'fixture-principal', clientId: 'fixture-client' }, 'fixture-profile')).profile;
        await services.refreshModels(config.profileId);
        await services.ledger.createQuotaLimit({ quotaLimitId: config.quotaLimitId, currency: 'USD', maxCostMicros: 100_000,
            quotaScopeIds: [config.quotaScopeId], sourceRef: 'local-fixture-ceiling' });
        await services.ledger.create({ rootBudgetId: 'fixture-root', quotaLimitId: config.quotaLimitId, mode: 'estimated', currency: 'USD',
            maxCostMicros: 100_000, maxModelCalls: 4, maxOutputTokens: 256, deadlineAt: expiresAt, sourceRef: 'local-fixture-root' });
        await assert.rejects(services.prepareRequest({ rootBudgetId: 'fixture-root', profileId: config.profileId, modelId: config.defaultModel,
            parameters: { maxOutputTokens: 256 }, view: { protocol: 'progrok', messages: [{ role: 'user', content: 'ordinary text' }] },
            versions: {}, inputModalities: ['text'], outputModalities: ['text'], inputTokenUpperBound: 100,
            inputUpperBoundReliable: true, maxOutputTokens: 256 }), error => error.code === 'BUDGET_UNBOUNDED'
                && error.message.includes('计费输出'));
        assert.equal(requests.filter(request => request.method === 'POST').length, 0);
        const account = await services.ledger.read('fixture-root');
        assert.equal(account.budget.spentCalls, 0);
        assert.equal(account.budget.spentMicros, 0);
        assert.equal(account.budget.heldCalls, 0);
        assert.equal(account.budget.heldMicros, 0);
        assert.deepEqual(account.reservations, []);
        assert.deepEqual(account.charges, []);
    } finally { await services.close(); }
});

test('runtime output budget preserves unknown model maximum and known limits while checking complete context (pure preparation)', () => {
    const config = profile();
    const entry = entryFromMetadata(config, { ...model(), progrokLanguageModel: language() }, observedAt, expiresAt);
    assert.equal(resolveRuntimeOutputBudget(entry, config, 256, now), 256);
    assert.equal(entry.maxOutputTokens.value, null);
    assert.deepEqual(resolveParameters(entry, config, { maxOutputTokens: 256 }, now), { max_tokens: 256 });
    validateCapabilities(entry, config, { inputModalities: ['text'], outputModalities: ['text'], usesTools: true,
        inputTokenUpperBound: 1000, maxOutputTokens: 256, now });
    const known = { ...entry, maxOutputTokens: { ...entry.contextWindow, value: 128 } };
    assert.equal(resolveRuntimeOutputBudget(known, config, 256, now), 128);
    assert.throws(() => validateCapabilities(entry, config, { inputModalities: ['text'], outputModalities: ['text'], usesTools: true,
        inputTokenUpperBound: 1_000_000, maxOutputTokens: 256, now }), { code: 'E_CONTEXT_LIMIT' });
});

test('built-in protocol declarations preserve explicit unsupported tools and narrower known parameters after the former document deadline (pure metadata)', () => {
    const config = profile();
    const later = '2026-11-12T00:00:00.000Z';
    const deadline = '2026-11-13T00:00:00.000Z';
    const base = entryFromMetadata(config, { ...model(), progrokLanguageModel: language() }, later, deadline);
    assert.equal(base.tools.value, true);
    assert.equal(base.tools.observedAt, '2026-11-02T23:00:00.000Z');
    assert.equal(base.tools.expiresAt, deadline);
    assert.equal(base.tools.version, 'progrok-local-chat-v1-doc-2026-11-03');
    assert.equal(base.tools.confidence, 'declared');
    assert.equal(base.maxOutputTokens.value, null);
    const fixed = { ...base, tools: { ...base.contextWindow, value: false, status: 'supported' }, parameters: {
        maxOutputTokens: { ...base.contextWindow, value: { type: 'integer', min: 1, max: 64, wirePath: 'max_tokens' } } } };
    const normalized = normalizeProgrokMetadata(config, fixed);
    assert.deepEqual(normalized.tools, fixed.tools);
    assert.deepEqual(normalized.parameters.maxOutputTokens, fixed.parameters.maxOutputTokens);
    const unsupported = { ...fixed, tools: { ...fixed.tools, status: 'unsupported' }, parameters: {
        maxOutputTokens: { ...fixed.parameters.maxOutputTokens, value: null, status: 'unsupported' } } };
    const kept = normalizeProgrokMetadata(config, unsupported);
    assert.deepEqual(kept.tools, unsupported.tools);
    assert.deepEqual(kept.parameters.maxOutputTokens, unsupported.parameters.maxOutputTokens);
});
