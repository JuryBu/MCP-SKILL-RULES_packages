import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { entryFromMetadata, resolveParameters, validateModelEntry } from '../../../src/agent-server/models/catalog.ts';
import { normalizeDocumentedMetadata, normalizeGeminiMetadata } from '../../../src/agent-server/models/metadata.ts';

const reviewedAt = '2026-11-13T05:12:00.000Z';
const now = Date.parse('2026-11-13T05:13:00.000Z');
const config = (protocol, baseUrl, modelId) => newProfile({ profileId: `metadata-contract-${protocol}`, label: 'Official metadata contract pure-data fixture', protocol, baseUrl, modelId });
const anthropic = config('anthropic', 'https://api.anthropic.com/v1', 'claude-opus-5-5');
const router = config('compatible_chat', 'https://openrouter.ai/api/v1', 'vendor/fixture-model');
const rows = {
    anthropic: { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude fixture', lifecycle: 'active', max_input_tokens: 200000, max_tokens: 32000,
        capabilities: { image_input: { supported: true }, pdf_input: { supported: true } } },
    compatible_chat: { id: 'vendor/fixture-model', context_length: 8192, top_provider: { max_completion_tokens: 4096 },
        architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'temperature', 'top_p', 'stop'] },
};
function seed(profile, at = now, overrides = {}, observation = at - 1000, expiry = at + 3600000) {
    return entryFromMetadata(profile, { ...rows[profile.protocol], ...overrides }, new Date(observation).toISOString(), new Date(expiry).toISOString());
}
function bare(profile, at = now) {
    const entry = seed(profile, at);
    const unknown = evidence => ({ ...evidence, value: null, status: 'unknown' });
    return { ...entry, streaming: unknown(entry.streaming), tools: unknown(entry.tools), parameters: {} };
}

test('Anthropic current API model rows retain native limits, modalities and streaming after November 11 (pure data)', () => {
    const entry = normalizeDocumentedMetadata(anthropic, seed(anthropic), now);
    validateModelEntry(entry, anthropic);
    assert.equal(entry.contextWindow.value, 200000);
    assert.equal(entry.maxOutputTokens.value, 32000);
    assert.equal(entry.contextWindow.source, 'api');
    assert.equal(entry.streaming.value, true);
    assert.equal(entry.streaming.observedAt, reviewedAt);
    assert.equal(entry.streaming.version, 'anthropic-streaming-contract-2026-11-13');
    assert.deepEqual(entry.inputModalities.value, ['text', 'image', 'file']);
    assert.equal(entry.tools.status, 'unknown');
    assert.equal(resolveParameters(entry, anthropic, { maxOutputTokens: 128 }, now).max_tokens, 128);
});

test('OpenRouter parameter schemas and tool support require that exact fresh API row to list the names (pure data)', () => {
    const base = seed(router);
    const entry = normalizeDocumentedMetadata(router, base, now);
    validateModelEntry(entry, router);
    assert.equal(entry.tools.value, true);
    assert.equal(entry.tools.source, 'api');
    assert.equal(entry.tools.observedAt, base.contextWindow.observedAt);
    assert.equal(entry.parameters.temperature.observedAt, reviewedAt);
    assert.equal(entry.parameters.temperature.version, 'openrouter-parameters-contract-2026-11-13');
    assert.equal(resolveParameters(entry, router, { temperature: 0.5 }, now).temperature, 0.5);
    const absent = normalizeDocumentedMetadata(router, seed(router, now, { supported_parameters: [] }), now);
    assert.equal(absent.tools.value, false);
    assert.equal(absent.parameters.temperature, undefined);
    const missing = normalizeDocumentedMetadata(router, seed(router, now, { supported_parameters: undefined }), now);
    assert.equal(missing.tools.status, 'unknown');
});

test('new API observations advance expiry without inventing a new document review or another calendar cutoff (pure data)', () => {
    const future = Date.parse('2027-02-01T00:00:00.000Z');
    for (const profile of [anthropic, router]) {
        const base = bare(profile, future);
        const expiry = new Date(future + 30000).toISOString();
        base.maxOutputTokens = { ...base.maxOutputTokens, expiresAt: expiry };
        const entry = normalizeDocumentedMetadata(profile, base, future);
        const contract = profile === anthropic ? entry.streaming : entry.parameters.temperature;
        assert.equal(contract.status, 'supported');
        assert.equal(contract.observedAt, reviewedAt);
        assert.equal(contract.expiresAt, expiry);
        if (profile === router) assert.equal(entry.tools.expiresAt, expiry);
    }
});

test('stale, future, non-API, mismatched and routed observations do not add reviewed facts (pure data)', () => {
    for (const profile of [anthropic, router]) {
        for (const field of ['contextWindow', 'maxOutputTokens']) {
            for (const changes of [{ expiresAt: new Date(now).toISOString() }, { observedAt: new Date(now + 60000).toISOString() },
                { source: 'manual' }, { scope: { endpoint: profile.baseUrl, modelId: 'ordinary-other-model', routeId: null } }]) {
                const base = bare(profile);
                base[field] = { ...base[field], ...changes };
                const entry = normalizeDocumentedMetadata(profile, base, now);
                assert.equal(entry.streaming.status, 'unknown');
                assert.equal(entry.tools.status, 'unknown');
                assert.equal(entry.parameters.temperature, undefined);
            }
        }
        const base = bare(profile);
        base.rawMetadata = { ...base.rawMetadata, id: 'ordinary-other-model' };
        assert.equal(normalizeDocumentedMetadata(profile, base, now).streaming.status, 'unknown');
        assert.equal(normalizeDocumentedMetadata(profile, base, now).tools.status, 'unknown');
        const routed = { ...bare(profile), routeId: 'ordinary-route' };
        const result = normalizeDocumentedMetadata(profile, routed, now);
        assert.equal(result.streaming.status, 'unknown');
        assert.equal(result.tools.status, 'unknown');
    }
});

test('explicit false and unsupported facts survive the official contract supplements (pure data)', () => {
    const routerBase = bare(router);
    routerBase.tools = { ...routerBase.tools, value: false, status: 'supported' };
    routerBase.parameters.temperature = { ...routerBase.contextWindow, value: null, status: 'unsupported' };
    const result = normalizeDocumentedMetadata(router, routerBase, now);
    assert.equal(result.tools.value, false);
    assert.equal(result.parameters.temperature.status, 'unsupported');
    routerBase.tools = { ...routerBase.tools, value: null, status: 'unsupported' };
    routerBase.rawMetadata = { ...routerBase.rawMetadata, capabilities: { tools: true },
        parameters: { temperature: { type: 'number', wirePath: 'temperature' } } };
    assert.equal(normalizeDocumentedMetadata(router, routerBase, now).tools.status, 'unsupported');
    assert.equal(normalizeDocumentedMetadata(router, routerBase, now).parameters.temperature.status, 'unsupported');
    const native = bare(anthropic);
    native.streaming = { ...native.streaming, value: null, status: 'unsupported' };
    assert.equal(normalizeDocumentedMetadata(anthropic, native, now).streaming.status, 'unsupported');
    const apiFalse = seed(anthropic, now, { capabilities: { ...rows.anthropic.capabilities, streaming: { supported: false } } });
    assert.equal(normalizeDocumentedMetadata(anthropic, apiFalse, now).streaming.value, false);
    const retired = normalizeDocumentedMetadata(anthropic, seed(anthropic, now, { lifecycle: 'retired' }), now);
    assert.equal(retired.retired, true);
});

test('official protocol contracts do not spread to ordinary third-party endpoints (pure data)', () => {
    for (const original of [anthropic, router]) {
        const other = { ...original, baseUrl: 'https://ordinary-provider.example/v1' };
        const entry = normalizeDocumentedMetadata(other, bare(other), now);
        assert.equal(entry.streaming.status, 'unknown');
        assert.equal(entry.tools.status, 'unknown');
        assert.equal(entry.parameters.temperature, undefined);
        const routed = { ...original, routePolicy: { kind: 'ordinary-routed-fixture' } };
        const routeEntry = normalizeDocumentedMetadata(routed, bare(routed), now);
        assert.equal(routeEntry.streaming.status, 'unknown');
        assert.equal(routeEntry.tools.status, 'unknown');
    }
});

test('the earlier documented interval and the Provider-owned Gemini metadata path remain intact (pure data)', () => {
    const earlier = Date.parse('2026-11-05T17:00:00.000Z');
    const native = normalizeDocumentedMetadata(anthropic, seed(anthropic, earlier), earlier);
    assert.equal(native.streaming.version, 'anthropic-streaming-2026-11-05');
    const compatible = normalizeDocumentedMetadata(router, seed(router, earlier), earlier);
    assert.equal(compatible.parameters.temperature.version, 'openrouter-parameters-2026-11-04');
    const base = bare(anthropic);
    const gemini = normalizeGeminiMetadata({ ...base, maxOutputTokens: { ...base.maxOutputTokens, value: 8192, status: 'supported' },
        rawMetadata: { thinking: true, supportedGenerationMethods: ['streamGenerateContent'] } });
    assert.equal(gemini.parameters.maxOutputTokens.value.max, 8192);
    assert.equal(gemini.thinking.value, true);
    assert.equal(gemini.streaming.value, true);
});
