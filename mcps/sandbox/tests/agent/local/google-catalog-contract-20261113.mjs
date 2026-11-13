import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { ModelCatalog, MemoryCatalogPort, entryFromMetadata, resolveParameters, validateCapabilities, validateModelEntry } from '../../../src/agent-server/models/catalog.ts';
import { enrichGoogleCatalogEntry } from '../../../src/agent-server/models/google.ts';
import { requireEvidence } from '../../../src/agent-server/models/evidence.ts';
import { GeminiAdapter } from '../../../src/agent-server/providers/gemini.ts';
import { normalizeUsage, priceUsage } from '../../../src/agent-server/accounting/usage.ts';

const reviewedAt = '2026-11-13T04:59:00.000Z';
const tariffDeadline = '2026-11-20T04:59:00.000Z';
const now = Date.parse('2026-11-13T05:00:00.000Z');
const flashId = 'gemini-3.8-flash';
const nanoId = 'gemini-nano-banana-2.1';
const limits = { [flashId]: [1048576, 65536], [nanoId]: [131072, 32768] };
const profile = (modelId = flashId, overrides = {}) => newProfile({ profileId: 'google-contract-20261113-fixture',
    label: 'Google contract pure-data fixture', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId, ...overrides });
const metadata = (modelId = flashId, overrides = {}) => ({ name: `models/${modelId}`,
    inputTokenLimit: limits[modelId]?.[0] ?? 8192, outputTokenLimit: limits[modelId]?.[1] ?? 4096,
    supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true, ...overrides });
function fixture(modelId = flashId, at = now, overrides = {}, config = profile(modelId)) {
    const base = entryFromMetadata(config, metadata(modelId, overrides), new Date(at - 1000).toISOString(), new Date(at + 3600000).toISOString());
    return { config, base, entry: enrichGoogleCatalogEntry(config, base, at) };
}

test('reviewed exact models supplement fresh API rows after the old November 8 deadline (pure data)', () => {
    for (const modelId of [flashId, nanoId]) {
        const { config, base, entry } = fixture(modelId);
        validateModelEntry(entry, config);
        assert.equal(entry.tools.status, 'supported');
        assert.equal(entry.tools.value, modelId === flashId);
        assert.equal(entry.tools.source, 'official_doc');
        assert.equal(entry.tools.sourceRef, `https://aistudio.google.com/docs/models/${modelId}`);
        assert.equal(entry.tools.version, 'google-contract-2026-11-13');
        assert.equal(entry.tools.observedAt, reviewedAt);
        assert.equal(entry.tools.expiresAt, base.contextWindow.expiresAt);
        assert.equal(entry.pricing.status, 'supported');
        assert.equal(entry.pricing.sourceRef, 'https://aistudio.google.com/docs/pricing');
        assert.equal(entry.pricing.value.validFrom, reviewedAt);
        assert.match(entry.pricing.value.priceVersion, /2026-11-13/);
        assert.equal(entry.rawMetadata, base.rawMetadata);
        assert.equal(entry.contextWindow.source, 'api');
        assert.equal(base.tools.status, 'unknown');
        assert.equal(base.pricing.status, 'unknown');
    }
});

test('API refresh renews only catalog evidence and never pretends to re-review documentation (pure data)', () => {
    for (const offset of [0, 86400000, 6 * 86400000]) {
        const at = now + offset;
        const { base, entry } = fixture(flashId, at);
        assert.equal(entry.tools.observedAt, reviewedAt);
        assert.equal(entry.tools.version, 'google-contract-2026-11-13');
        assert.equal(entry.contextWindow.observedAt, new Date(at - 1000).toISOString());
        assert.equal(entry.tools.expiresAt, base.contextWindow.expiresAt);
        assert.equal(entry.pricing.observedAt, reviewedAt);
        assert.equal(entry.pricing.value.validFrom, reviewedAt);
    }
});

test('expired tariff snapshots and the promotional boundary leave stable function capabilities available (pure data)', () => {
    for (const at of [Date.parse(tariffDeadline), Date.parse('2026-12-01T00:00:00.000Z'), Date.parse('2027-01-01T00:00:00.000Z')]) {
        for (const modelId of [flashId, nanoId]) {
            const { config, entry } = fixture(modelId, at);
            validateModelEntry(entry, config);
            assert.equal(entry.tools.status, 'supported');
            assert.equal(entry.tools.value, modelId === flashId);
            assert.equal(entry.pricing.status, 'unknown');
            assert.equal(entry.pricing.value, null);
            assert.equal(entry.parameters.maxOutputTokens.status, 'supported');
            assert.equal(entry.parameters.thinkingLevel.status, 'supported');
        }
    }
});

test('stable contracts require current matching API limits, scope, identity and generateContent availability (pure data)', () => {
    for (const overrides of [{ inputTokenLimit: undefined }, { outputTokenLimit: undefined }, { inputTokenLimit: 0 },
        { outputTokenLimit: 1.5 }, { supportedGenerationMethods: undefined }, { supportedGenerationMethods: [] },
        { supportedGenerationMethods: ['countTokens'] }, { name: 'models/ordinary-other-model' }, { thinking: false }]) {
        const { config, base } = fixture(flashId, now, overrides);
        assert.equal(enrichGoogleCatalogEntry(config, base, now), base);
    }
    for (const field of ['contextWindow', 'maxOutputTokens']) {
        for (const change of [
            { expiresAt: new Date(now).toISOString() },
            { observedAt: new Date(now + 1).toISOString() },
            { source: 'manual' },
            { scope: { endpoint: 'https://ordinary-models.example/v1beta', modelId: flashId, routeId: null } },
            { value: 123 },
        ]) {
            const { config, base } = fixture();
            base[field] = { ...base[field], ...change };
            assert.equal(enrichGoogleCatalogEntry(config, base, now), base);
        }
    }
    for (const change of [{ retired: true }, { protocol: 'compatible_chat' }, { routeId: 'ordinary-route' }]) {
        const { config, base } = fixture();
        Object.assign(base, change);
        assert.equal(enrichGoogleCatalogEntry(config, base, now), base);
    }
});

test('unreviewed models and ordinary third-party endpoints receive no official contract or tariff (pure data)', () => {
    for (const modelId of ['gemini-3.6-flash', 'gemini-3.8-flash-latest', 'gemini-nano-banana-2.1-preview', 'gemini-2.5-flash']) {
        const { base, entry } = fixture(modelId);
        assert.equal(entry, base);
        assert.equal(entry.tools.status, 'unknown');
        assert.equal(entry.pricing.status, 'unknown');
    }
    for (const baseUrl of ['https://ordinary-models.example/v1beta', 'https://generativelanguage.googleapis.com/ordinary-models']) {
        const config = profile(flashId, { baseUrl });
        const { base, entry } = fixture(flashId, now, {}, config);
        assert.equal(entry, base);
    }
});

test('explicit API capability and parameter exclusions survive supplementation (pure data)', () => {
    const { config, base } = fixture(flashId, now, { capabilities: { tools: false, streaming: false } });
    const unavailable = evidence => ({ ...evidence, value: null, status: 'unsupported' });
    base.inputModalities = unavailable(base.inputModalities);
    base.outputModalities = unavailable(base.outputModalities);
    base.pricing = unavailable(base.pricing);
    base.parameters.thinkingLevel = unavailable(base.contextWindow);
    const entry = enrichGoogleCatalogEntry(config, base, now);
    assert.equal(entry.tools, base.tools);
    assert.equal(entry.tools.value, false);
    assert.equal(entry.streaming.value, false);
    assert.equal(entry.inputModalities, base.inputModalities);
    assert.equal(entry.outputModalities, base.outputModalities);
    assert.equal(entry.pricing, base.pricing);
    assert.equal(entry.parameters.thinkingLevel, base.parameters.thinkingLevel);
    const rejected = { ...base, tools: unavailable(base.tools) };
    assert.equal(enrichGoogleCatalogEntry(config, rejected, now).tools, rejected.tools);
});

test('both API expiries cap all supplemented facts and document limits intersect without enlargement (pure data)', () => {
    for (const modelId of [flashId, nanoId]) {
        const { config, base } = fixture(modelId, now, { inputTokenLimit: limits[modelId][0] + 1, outputTokenLimit: limits[modelId][1] + 1 });
        const expiry = new Date(now + 30000).toISOString();
        base.maxOutputTokens = { ...base.maxOutputTokens, expiresAt: expiry };
        const entry = enrichGoogleCatalogEntry(config, base, now);
        validateModelEntry(entry, config);
        assert.equal(entry.contextWindow.value, limits[modelId][0]);
        assert.equal(entry.maxOutputTokens.value, limits[modelId][1]);
        assert.equal(entry.tools.expiresAt, expiry);
        assert.equal(entry.pricing.expiresAt, expiry);
        assert.equal(entry.pricing.value.expiresAt, expiry);
        for (const parameter of Object.values(entry.parameters)) assert.equal(parameter.expiresAt, expiry);
        assert.throws(() => requireEvidence(entry.tools, base.contextWindow.scope, Date.parse(expiry)), { code: 'E_CAPABILITY_UNKNOWN' });
        const smaller = fixture(modelId, now, { inputTokenLimit: 4096, outputTokenLimit: 512 }).entry;
        assert.equal(smaller.contextWindow.value, 4096);
        assert.equal(smaller.maxOutputTokens.value, 512);
        assert.equal(smaller.parameters.maxOutputTokens.value.max, 512);
    }
});

test('reviewed text and image controls retain distinct function-calling behavior (pure data)', () => {
    const flash = fixture();
    validateCapabilities(flash.entry, flash.config, { inputModalities: ['text'], outputModalities: ['text'], usesTools: true,
        inputTokenUpperBound: 1024, maxOutputTokens: 128, now });
    assert.equal(resolveParameters(flash.entry, flash.config, { thinkingLevel: 'medium', maxOutputTokens: 128 }, now)
        .generationConfig.thinkingConfig.thinkingLevel, 'medium');
    for (const name of ['temperature', 'topP', 'topK', 'candidateCount', 'thinkingBudget']) {
        assert.equal(flash.entry.parameters[name].status, 'unsupported');
    }
    const nano = fixture(nanoId);
    assert.deepEqual(nano.entry.inputModalities.value, ['text', 'image', 'video', 'pdf']);
    const controls = resolveParameters(nano.entry, nano.config, { imageSize: '4K', thinkingLevel: 'MINIMAL', maxOutputTokens: 32768 }, now);
    assert.equal(controls.generationConfig.imageConfig.imageSize, '4K');
    assert.equal(controls.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
    assert.throws(() => validateCapabilities(nano.entry, nano.config, { inputModalities: ['text'], outputModalities: ['image'], usesTools: true,
        inputTokenUpperBound: 1024, maxOutputTokens: 1024, now }), { code: 'E_PARAMETER_UNSUPPORTED' });
});

test('current standard tariff snapshots retain introductory text rates and modality-specific image rates (pure data)', () => {
    const flash = fixture().entry.pricing.value;
    assert.equal(flash.inputUncached, 750000);
    assert.equal(flash.inputCacheRead, 75000);
    assert.equal(flash.output, 3750000);
    const nano = fixture(nanoId).entry.pricing.value;
    assert.equal(nano.inputUncached, 1500000);
    assert.deepEqual(nano.outputByModality, { text: 7500000, image: 30000000 });
    assert.equal(nano.reasoning, 7500000);
    const image = normalizeUsage('gemini', { promptTokenCount: 0, cachedContentTokenCount: 0, candidatesTokenCount: 1120,
        thoughtsTokenCount: 0, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] });
    assert.equal(priceUsage(image, nano, now).amountMicros, 33600);
    for (const modelId of [flashId, nanoId]) {
        const at = Date.parse(tariffDeadline) - 1;
        const { entry } = fixture(modelId, at);
        assert.equal(entry.pricing.expiresAt, tariffDeadline);
        assert.equal(entry.pricing.value.validFrom, reviewedAt);
    }
});

test('historical November 1 snapshots and the original Gemini 2.5 branch remain comparable (pure data)', () => {
    const past = Date.parse('2026-11-01T16:00:00.000Z');
    for (const modelId of [flashId, nanoId]) {
        const { entry } = fixture(modelId, past);
        assert.equal(entry.pricing.observedAt, '2026-11-01T15:57:28.000Z');
        assert.equal(entry.pricing.version, 'google-doc-2026-11-01');
        assert.match(entry.pricing.value.priceVersion, /2026-11-01/);
    }
    const { entry } = fixture('gemini-2.5-flash', Date.parse('2026-10-30T15:00:00.000Z'));
    assert.equal(entry.tools.value, true);
    assert.equal(entry.pricing.value.inputUncached, 300000);
    assert.deepEqual(entry.parameters.thinkingBudget.value.enum, [0]);
});

test('normal catalog refresh supplements only the received rows and preserves the raw receipt (simulated GET)', async () => {
    const config = profile();
    const enabled = { ...config, discovery: { ...config.discovery, enabled: true } };
    const catalog = new ModelCatalog(new MemoryCatalogPort(), () => now);
    const rows = [metadata(), metadata('ordinary-unreviewed-model')];
    const calls = [];
    const result = await catalog.refresh(enabled, new GeminiAdapter(), { transport: { async request(request) {
        calls.push(request);
        return { status: 200, headers: {}, body: JSON.stringify({ models: rows }) };
    } } }, { enrich: entry => enrichGoogleCatalogEntry(enabled, entry, now) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.deepEqual(result.entries.map(entry => entry.modelId), [flashId, 'ordinary-unreviewed-model']);
    assert.equal(result.entries[0].tools.value, true);
    assert.equal(result.entries[0].pricing.status, 'supported');
    assert.equal(result.entries[1].tools.status, 'unknown');
    assert.equal(result.entries[1].pricing.status, 'unknown');
    assert.deepEqual(result.entries[0].rawMetadata, rows[0]);
    assert.equal(result.entries.some(entry => entry.modelId === nanoId), false);
});
