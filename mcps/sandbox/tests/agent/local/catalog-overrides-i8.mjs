import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelCatalog, MemoryCatalogPort, entryFromMetadata, modelScope, resolveParameters } from '../../../src/agent-server/models/catalog.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const started = Date.parse('2026-11-04T07:28:00.000Z');
const config = (baseUrl = 'https://catalog.example/v1') => ({ ...newProfile({ profileId: 'i8-models', label: 'I8 local catalog', protocol: 'compatible_chat', baseUrl, modelId: 'arbitrary-new-model' }), revision: 1 });
const metadata = { id: 'arbitrary-new-model', context_window: 8192, max_output_tokens: 2048, input_modalities: ['text'], output_modalities: ['text'] };
const adapter = (models = [metadata]) => ({ protocol: 'compatible_chat', async discover() { return { models, complete: true, nextCursor: null }; } });
function declaration(profile, routeId = null) {
    const entry = entryFromMetadata(profile, metadata, new Date(started).toISOString(), new Date(started + 120_000).toISOString());
    const proof = value => ({ value, status: value === null ? 'unknown' : 'supported', source: 'manual', sourceRef: 'owner-declaration-i8',
        observedAt: new Date(started).toISOString(), expiresAt: new Date(started + 120_000).toISOString(), scope: modelScope(profile, entry.modelId, routeId), version: 'manual-v1', confidence: 'declared' });
    Object.assign(entry, { routeId, contextWindow: proof(16384), maxOutputTokens: proof(4096), inputModalities: proof(['text', 'image']),
        outputModalities: proof(['text']), tools: proof(true), streaming: proof(false), parameters: {
            maxOutputTokens: proof({ type: 'integer', min: 1, max: 4096, wirePath: 'max_tokens' }),
            temperature: proof({ type: 'number', min: 0, max: 1, wirePath: 'temperature' }),
        }, pricing: proof({ priceVersion: 'owner-price-v1', currency: 'USD', unitTokens: 1000000, inputUncached: 1000,
            inputCacheRead: 1000, inputCacheWrite: null, output: 2000, reasoningBilledSeparately: false,
            media: 'unknown', serverTools: 'disabled', sourceRef: 'owner-price-source', validFrom: new Date(started).toISOString(),
            expiresAt: new Date(started + 120_000).toISOString(), coversAllParameters: true }) });
    return entry;
}

test('I8 successful discovery keeps separate manual capabilities, parameters and pricing across JSON reopen', async () => {
    let current = started;
    const profile = config();
    const port = new MemoryCatalogPort();
    const catalog = new ModelCatalog(port, () => current);
    const discovered = await catalog.refresh(profile, adapter(), {});
    const declared = await catalog.declare(profile, declaration(profile), discovered.catalogVersion);
    const refreshed = await catalog.refresh(profile, adapter(), {});
    assert.equal(refreshed.entries[0].tools.value, true);
    assert.equal(refreshed.discoveryEntries[0].tools.status, 'unknown');
    assert.equal(refreshed.declarations[0].tools.source, 'manual');
    assert.equal(refreshed.entries[0].pricing.value.priceVersion, 'owner-price-v1');
    assert.deepEqual(resolveParameters(refreshed.entries[0], profile, { temperature: 0.5, maxOutputTokens: 4096 }, current), { temperature: 0.5, max_tokens: 4096 });
    assert.equal(declared.declarations[0].contextWindow.conflicts, undefined);
    assert.equal(refreshed.entries[0].contextWindow.conflicts[0].source, 'api');
    const reopenedPort = new MemoryCatalogPort();
    await reopenedPort.publish(JSON.parse(JSON.stringify(await port.read(profile.profileId))), null);
    const reopened = new ModelCatalog(reopenedPort, () => current);
    assert.equal((await reopened.get(profile.profileId, metadata.id)).entry.tools.value, true);
    current += 120_001;
    const expired = (await reopened.get(profile.profileId, metadata.id)).entry;
    assert.equal(expired.contextWindow.value, 8192);
    assert.equal(expired.tools.status, 'unknown');
    assert.equal(expired.parameters.temperature, undefined);
    assert.equal(expired.pricing.status, 'unknown');
    assert.equal((await reopened.port.read(profile.profileId)).declarations[0].tools.value, true);
});

test('I8 exact manual route survives model-only discovery without borrowing evidence from another route or endpoint', async () => {
    const profile = config();
    const catalog = new ModelCatalog(new MemoryCatalogPort(), () => started);
    const initial = await catalog.refresh(profile, adapter(), {});
    await catalog.declare(profile, declaration(profile, 'owner-pinned-route'), initial.catalogVersion);
    await catalog.refresh({ ...profile, revision: 2 }, adapter(), {});
    const routed = (await catalog.get(profile.profileId, metadata.id, 'owner-pinned-route')).entry;
    assert.equal(routed.retired, false);
    assert.equal(routed.tools.scope.routeId, 'owner-pinned-route');
    assert.equal((await catalog.get(profile.profileId, metadata.id)).entry.tools.status, 'unknown');
    const changed = await catalog.refresh({ ...config('https://different.example/v1'), revision: 3 }, adapter(), {});
    assert.equal(changed.entries.some(entry => entry.routeId === 'owner-pinned-route'), false);
    assert.equal(changed.entries[0].tools.status, 'unknown');
    assert.equal(changed.declarations.length, 1);
});

test('I8 legacy manual snapshots migrate and incomplete refresh preserves both layers atomically', async () => {
    const profile = config();
    const port = new MemoryCatalogPort();
    await port.publish({ schemaVersion: 1, catalogVersion: 'legacy', profileId: profile.profileId, profileRevision: 1,
        observedAt: new Date(started).toISOString(), expiresAt: new Date(started + 120000).toISOString(), entries: [declaration(profile)] }, null);
    const catalog = new ModelCatalog(port, () => started);
    const refreshed = await catalog.refresh(profile, adapter(), {});
    assert.equal(refreshed.entries[0].tools.value, true);
    assert.equal(refreshed.declarations.length, 1);
    const before = await port.read(profile.profileId);
    await assert.rejects(catalog.refresh(profile, { protocol: 'compatible_chat', async discover() { return { models: [metadata], complete: false, nextCursor: null }; } }, {}), { code: 'E_CATALOG_INCOMPLETE' });
    assert.deepEqual(await port.read(profile.profileId), before);
});

test('I8 explicit complete API schemas and prices are used, incomplete names never invent a domain or price', () => {
    const profile = config();
    const manual = declaration(profile);
    const entry = entryFromMetadata(profile, { ...metadata, capabilities: { tools: true, streaming: false },
        parameters: { temperature: { type: 'number', min: 0, max: 1, wirePath: 'temperature' }, invalid: { type: 'number' } },
        pricing: manual.pricing.value }, new Date(started).toISOString(), new Date(started + 86400000).toISOString());
    assert.equal(entry.tools.value, true);
    assert.equal(entry.parameters.invalid, undefined);
    assert.equal(entry.parameters.temperature.source, 'api');
    assert.equal(entry.pricing.value.priceVersion, manual.pricing.value.priceVersion);
    const unknown = entryFromMetadata(profile, { ...metadata, supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0.01' } },
        new Date(started).toISOString(), new Date(started + 86400000).toISOString());
    assert.equal(unknown.tools.status, 'unknown');
    assert.equal(unknown.pricing.status, 'unknown');
    assert.equal(unknown.parameters.temperature, undefined);
});

test('I8 documented OpenRouter domains are composed with dynamic model support, never a model whitelist', () => {
    const profile = config('https://openrouter.ai/api/v1');
    const entry = entryFromMetadata(profile, { ...metadata, supported_parameters: ['tools', 'temperature', 'top_p', 'reasoning'] },
        new Date(started).toISOString(), new Date(started + 86400000).toISOString());
    assert.equal(entry.tools.value, true);
    assert.equal(entry.parameters.temperature.value.max, 2);
    assert.equal(entry.parameters.top_p.value.max, 1);
    assert.equal(entry.parameters.temperature.source, 'official_doc');
    assert.equal(entry.parameters.reasoning, undefined);
    assert.equal(entry.pricing.status, 'unknown');
    assert.deepEqual(resolveParameters(entry, profile, { temperature: 0.2 }, started), { temperature: 0.2 });
});

test('I8 expired standalone route declaration becomes unknown in effective view and preserves source declaration', async () => {
    let current = started;
    const profile = config();
    const port = new MemoryCatalogPort();
    const catalog = new ModelCatalog(port, () => current);
    await catalog.declare(profile, declaration(profile, 'manual-only-route'), null);
    current += 120_001;
    const entry = (await catalog.get(profile.profileId, metadata.id, 'manual-only-route')).entry;
    assert.equal(entry.tools.status, 'unknown');
    assert.equal(entry.contextWindow.value, null);
    assert.deepEqual(entry.parameters, {});
    assert.equal((await port.read(profile.profileId)).declarations[0].tools.value, true);
});

test('I8 current Anthropic model metadata and official streaming contract enrich dynamic identities', () => {
    const profile = { ...config('https://api.anthropic.com/v1'), protocol: 'anthropic' };
    const observedAt = '2026-11-04T16:23:00.000Z';
    const expiresAt = '2026-11-05T16:23:00.000Z';
    const data = { id: 'dynamically-discovered-model', display_name: 'Discovered title', max_input_tokens: 50000, max_tokens: 6000,
        capabilities: { image_input: { supported: true }, pdf_input: { supported: false } } };
    const entry = entryFromMetadata(profile, data, observedAt, expiresAt);
    assert.equal(entry.contextWindow.value, 50000);
    assert.equal(entry.maxOutputTokens.value, 6000);
    assert.equal(entry.parameters.maxOutputTokens.value.wirePath, 'max_tokens');
    assert.deepEqual(entry.inputModalities.value, ['text', 'image']);
    assert.equal(entry.streaming.source, 'official_doc');
    assert.equal(entry.streaming.value, true);
    assert.equal(entry.pricing.status, 'unknown');
    assert.equal(entry.tools.status, 'unknown');
    const compatible = entryFromMetadata({ ...profile, baseUrl: 'https://compatible.example/v1' }, data, observedAt, expiresAt);
    assert.equal(compatible.streaming.status, 'unknown');
});
