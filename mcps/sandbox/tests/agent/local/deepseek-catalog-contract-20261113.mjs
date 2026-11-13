import assert from 'node:assert/strict';
import test from 'node:test';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { entryFromMetadata } from '../../../src/agent-server/models/catalog.ts';
import { enrichDeepSeekCatalogEntry } from '../../../src/agent-server/models/deepseek.ts';
import { requireEvidence } from '../../../src/agent-server/models/evidence.ts';

function fixture(observedAt, baseUrl = 'https://api.deepseek.com', modelId = 'deepseek-flash') {
    const config = newProfile({ profileId: 'official-deepseek', label: 'contract fixture', protocol: 'compatible_chat', baseUrl, modelId });
    const expiresAt = new Date(Date.parse(observedAt) + 86400000).toISOString();
    const entry = entryFromMetadata(config, { id: modelId, context_window: 1048576, max_output_tokens: 393216 }, observedAt, expiresAt);
    return { config, entry, expiresAt };
}

test('current official model listing retains the reviewed tool contract and the real catalog expiry', () => {
    const { config, entry, expiresAt } = fixture('2026-11-13T04:56:00.000Z');
    const actual = enrichDeepSeekCatalogEntry(config, entry);
    assert.equal(actual.tools.value, true);
    assert.equal(actual.tools.source, 'official_doc');
    assert.equal(actual.tools.observedAt, '2026-11-13T04:51:00.000Z');
    assert.equal(actual.tools.expiresAt, expiresAt);
    assert.equal(actual.tools.version, 'deepseek-api-contract-reviewed-2026-11-13');
    assert.equal(requireEvidence(actual.tools, actual.tools.scope, Date.parse('2026-11-13T05:00:00Z')), true);
    assert.equal(actual.pricing.value, null);
});

test('a later catalog refresh renews listing validity without pretending the document was reread', () => {
    const { config, entry, expiresAt } = fixture('2026-11-23T00:00:00.000Z');
    const actual = enrichDeepSeekCatalogEntry(config, entry);
    assert.equal(actual.tools.value, true);
    assert.equal(actual.tools.observedAt, '2026-11-13T04:51:00.000Z');
    assert.equal(actual.tools.expiresAt, expiresAt);
    assert.throws(() => requireEvidence(actual.tools, actual.tools.scope, Date.parse(expiresAt)), /有效证据/);
});

test('the previous dated contract stays distinct from the refreshed contract', () => {
    const { config, entry } = fixture('2026-11-05T01:00:00.000Z');
    const actual = enrichDeepSeekCatalogEntry(config, entry);
    assert.equal(actual.tools.value, true);
    assert.equal(actual.tools.version, 'deepseek-doc-2026-11-05');
    const gap = fixture('2026-11-12T01:00:00.000Z');
    assert.equal(enrichDeepSeekCatalogEntry(gap.config, gap.entry).tools.status, 'unknown');
});

test('explicit API limitations, other endpoints and unrelated models are preserved', () => {
    const original = fixture('2026-11-13T05:00:00.000Z');
    const unsupported = { ...original.entry, tools: { ...original.entry.tools, status: 'unsupported', value: false } };
    assert.deepEqual(enrichDeepSeekCatalogEntry(original.config, unsupported).tools, unsupported.tools);
    for (const [baseUrl, modelId] of [['https://compatible.example.test', 'deepseek-flash'], ['https://api.deepseek.com', 'unlisted-model']]) {
        const other = fixture('2026-11-13T05:00:00.000Z', baseUrl, modelId);
        assert.equal(enrichDeepSeekCatalogEntry(other.config, other.entry).tools.status, 'unknown');
    }
});
