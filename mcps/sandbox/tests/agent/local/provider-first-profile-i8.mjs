import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createProviderServices } from '../../../src/agent-server/providers/services.ts';
import { MemoryAccountingPort } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { MemoryProfilePort, newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { MemoryCatalogPort, entryFromMetadata } from '../../../src/agent-server/models/catalog.ts';
import { prepareAttempt } from '../../../src/agent-server/providers/assemble.ts';

const now = Date.parse('2026-11-04T16:40:00.000Z');
const deadlineAt = new Date(Math.max(now, Date.now()) + 120000).toISOString();
const versions = { conversationId: 'first-profile-fixture', runId: 'first-run', roundId: null, stepId: 'first-step', actionId: 'first-action',
    runEpoch: 1, historyEpoch: 1, appendSeq: 1, viewRevision: 1, workspaceRevision: 1, toolSchemaHash: 'no-tools', skillVersions: {},
    attachmentManifestHash: 'no-attachments', nativeReplayHash: 'no-native-replay' };

for (const fixture of [
    { protocol: 'compatible_chat', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-flash', currency: 'XXX',
        data: { data: [{ id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' }] } },
    { protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId: 'gemini-3.8-flash', currency: 'USD',
        data: { models: [{ name: 'models/gemini-3.8-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true }] } },
]) {
    test(`I8 fresh ${fixture.protocol} profile discovers, explicitly selects and refreshes into a sendable first request without manual model declarations`, async () => {
        let posts = 0;
        const transport = { async request(request) {
            if (request.method === 'GET') return { status: 200, headers: {}, body: JSON.stringify(fixture.data) };
            posts++;
            const data = fixture.protocol === 'gemini'
                ? { responseId: 'first-reply', modelVersion: fixture.modelId, candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: '源级首答' }] } }],
                    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }
                : { id: 'first-reply', model: fixture.modelId, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '源级首答' } }],
                    usage: { prompt_tokens: 8, completion_tokens: 2 } };
            return { status: 200, headers: {}, body: JSON.stringify(data) };
        } };
        const service = createProviderServices({ accountingPort: new MemoryAccountingPort(() => now), profilePort: new MemoryProfilePort(),
            catalogPort: new MemoryCatalogPort(), transport, now: () => now });
        try {
            const initial = newProfile({ profileId: `first-${fixture.protocol}`, label: 'blank first profile', protocol: fixture.protocol, baseUrl: fixture.baseUrl });
            assert.equal(initial.defaultModel, null);
            assert.deepEqual(initial.routePolicy.allowedModels, []);
            const identity = { principalId: 'i8-fixture', clientId: 'fixture-client' };
            const first = (await service.profiles.put(initial, 0, identity, randomUUID())).profile;
            await service.refreshModels(first.profileId);
            const selected = (await service.profiles.put({ ...first, defaultModel: fixture.modelId,
                routePolicy: { ...first.routePolicy, allowedModels: [fixture.modelId] } }, first.revision, identity, randomUUID())).profile;
            const refreshed = await service.refreshModels(selected.profileId);
            assert.equal(refreshed.declarations.length, 0);
            assert.equal(refreshed.profileRevision, selected.revision);
            await service.ledger.create({ rootBudgetId: 'first-root', mode: 'metered', currency: fixture.currency, maxCostMicros: null,
                maxModelCalls: 2, maxOutputTokens: 512, deadlineAt, sourceRef: 'source-only-fixture' });
            const view = { protocol: fixture.protocol, ...(fixture.protocol === 'gemini'
                ? { contents: [{ role: 'user', parts: [{ text: '正常首用' }] }] } : { messages: [{ role: 'user', content: '正常首用' }] }) };
            const prepared = await service.prepareRequest({ rootBudgetId: 'first-root', profileId: selected.profileId, modelId: fixture.modelId,
                parameters: { maxOutputTokens: 512 }, view, versions, inputModalities: ['text'], outputModalities: ['text'],
                inputTokenUpperBound: 32, inputUpperBoundReliable: false, maxOutputTokens: 512 });
            const response = await prepared.adapter.send(prepareAttempt(prepared.snapshot, 'first-root'), { transport });
            assert.equal(response.complete, true);
            assert.equal(response.blocks[0].text, '源级首答');
            assert.equal(posts, 1);
            if (fixture.protocol === 'compatible_chat') assert.deepEqual(prepared.missingPricing, ['price']);
        } finally { await service.close(); }
    });
}

test('I8 undocumented dynamic DeepSeek identities stay discovered with explicit unknown capabilities instead of disappearing', () => {
    const profile = newProfile({ label: 'dynamic fixture', protocol: 'compatible_chat', baseUrl: 'https://api.deepseek.com/v1' });
    const entry = entryFromMetadata(profile, { id: 'a-new-unreviewed-model' }, new Date(now).toISOString(), new Date(now + 60000).toISOString());
    assert.equal(entry.modelId, 'a-new-unreviewed-model');
    assert.equal(entry.retired, false);
    assert.equal(entry.contextWindow.status, 'unknown');
    assert.equal(entry.pricing.status, 'unknown');
});
