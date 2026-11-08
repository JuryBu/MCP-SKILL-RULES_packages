import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openAgentStore } from '../../../dist/agent-server/storage/index.js';
import { createAgentRuntime } from '../../../dist/agent-server/runtime.js';
import { createAgentServices } from '../../../dist/agent-server/server-services.js';
import { MemoryCatalogPort, entryFromMetadata, modelScope } from '../../../dist/agent-server/models/catalog.js';
import { newProfile } from '../../../dist/agent-server/profiles/profile-store.js';

for (const scenario of ['recover', 'exhaust']) test(`formal same-CID image followup ${scenario} preserves count-versus-generation state and accounting`, { timeout: 45000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i10-count-runtime-'));
    const dataDir = join(root, 'state');
    const observed = { count: 0, generation: 0 };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nksAAAAASUVORK5CYII=';
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) {}
        if (request.url.endsWith(':countTokens')) {
            observed.count++;
            if (scenario === 'exhaust' || observed.count === 1) { request.socket.destroy(); return; }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{"totalTokens":128}');
            return;
        }
        assert.ok(request.url.includes('GenerateContent') || request.url.includes('generateContent'));
        observed.generation++;
        const parts = observed.generation === 1 ? [{ inlineData: { mimeType: 'image/png', data: png } }] : [{ text: 'The retained image is available.' }];
        const body = { responseId: `i10-${observed.generation}`, modelVersion: 'i10-model',
            candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }],
            usageMetadata: { promptTokenCount: 128, candidatesTokenCount: 16, totalTokenCount: 144 } };
        response.writeHead(200, { 'Content-Type': request.url.includes('streamGenerateContent') ? 'text/event-stream' : 'application/json' });
        response.end(request.url.includes('streamGenerateContent') ? `data: ${JSON.stringify(body)}\n\n` : JSON.stringify(body));
    });
    let store, runtime, services;
    const client = { principalId: 'i10-owner', clientId: 'i10-client', callerHost: 'standalone-cli' };
    try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        store = await openAgentStore({ dataDir: join(dataDir, 'store') });
        runtime = createAgentRuntime({ store, cleanupGraceMs: 1000, onConversationClosed: conversation => services?.onConversationClosed(conversation) });
        services = await createAgentServices({ store, runtime, catalogPort: new MemoryCatalogPort(), sharedServices: [],
            authority: { dataDir, runtimeDir: join(dataDir, 'runtime'), principalId: client.principalId,
                credentialRef: 'i10-control', secret: Buffer.alloc(32), endpoint: 'i10-local' } });
        const profile = (await services.provider.profiles.put(newProfile({ profileId: 'i10-profile', label: 'I10 local HTTP', protocol: 'gemini',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, modelId: 'i10-model' }), 0, client, randomUUID())).profile;
        const expiresAt = new Date(Date.now() + 300000).toISOString();
        const evidence = value => ({ value, status: 'supported', source: 'verified_fixture', sourceRef: 'i10-owned-http',
            observedAt: new Date().toISOString(), expiresAt, scope: modelScope(profile, 'i10-model', null), version: 'i10', confidence: 'contract_checked' });
        const entry = entryFromMetadata(profile, { id: 'i10-model' }, new Date().toISOString(), expiresAt);
        Object.assign(entry, { contextWindow: evidence(65536), maxOutputTokens: evidence(512), inputModalities: evidence(['text', 'image']),
            outputModalities: evidence(['text', 'image']), tools: evidence(false), streaming: evidence(true),
            parameters: { maxOutputTokens: evidence({ type: 'integer', min: 1, max: 512, wirePath: 'generationConfig.maxOutputTokens' }) },
            pricing: evidence({ priceVersion: 'i10', currency: 'USD', unitTokens: 1000000, inputUncached: 1, inputCacheRead: 1,
                inputCacheWrite: null, output: 1, reasoningBilledSeparately: false, media: 'included_in_tokens', serverTools: 'disabled',
                sourceRef: 'verified_fixture', validFrom: new Date().toISOString(), expiresAt, coversAllParameters: true }) });
        await services.provider.models.port.publish({ schemaVersion: 1, catalogVersion: randomUUID(), profileId: profile.profileId,
            profileRevision: profile.revision, observedAt: new Date().toISOString(), expiresAt, entries: [entry] }, null);
        await services.provider.ledger.createQuotaLimit({ quotaLimitId: 'i10-total', currency: 'USD', maxCostMicros: 100000,
            quotaScopeIds: [profile.quotaScopeId], sourceRef: 'verified_fixture' });
        const created = await services.dispatch('conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' },
            options: { profileId: profile.profileId, modelId: profile.defaultModel, tools: [] } }, client);
        assert.equal(created.ok, true, JSON.stringify(created));
        const control = { conversationId: created.data.conversationId, controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
        for (let round = 1; round <= 2; round++) {
            const started = await services.dispatch('runs.start', { ...control, clientCommandId: randomUUID(), input: { text: `ordinary image round ${round}` },
                budget: { costMode: 'hard', currency: 'USD', quotaLimitId: 'i10-total', maxCostMicros: 10000, maxModelCalls: 1, maxOutputTokens: 512, wallMs: 30000 } }, client);
            assert.equal(started.ok, true, JSON.stringify(started));
            let ended;
            const deadline = Date.now() + 20000;
            do {
                ended = await services.dispatch('runs.get', { conversationId: control.conversationId, runId: started.data.runId }, client);
                if (['succeeded', 'failed', 'outcome_unknown', 'paused', 'cancelled'].includes(ended.data?.state)) break;
                await delay(20);
            } while (Date.now() < deadline);
            if (round === 1 || scenario === 'recover') assert.equal(ended.data.state, 'succeeded', JSON.stringify(ended));
            else {
                assert.equal(ended.data.state, 'failed', JSON.stringify(ended));
                assert.equal(ended.data.failure.error.code, 'E_COUNT_TOKENS_TRANSPORT');
                assert.equal(ended.data.failure.acceptance, 'not_sent');
                assert.equal(ended.data.failure.error.mayHaveStarted, false);
                const budget = await services.dispatch('budgets.get', { rootBudgetId: started.data.runId }, client);
                assert.equal(budget.data.budget.spentCalls, 0);
                assert.equal(budget.data.budget.heldMicros, 0);
                assert.deepEqual(budget.data.reservations, []);
                assert.deepEqual(budget.data.charges, []);
            }
        }
        assert.equal(observed.generation, scenario === 'recover' ? 2 : 1);
        assert.equal(observed.count, scenario === 'recover' ? 2 : 3);
        if (scenario === 'recover') {
            const before = await services.dispatch('conversations.get', { conversationId: control.conversationId }, client);
            const historyBefore = await services.dispatch('conversations.readHistory', { conversationId: control.conversationId }, client);
            const counted = await services.dispatch('conversations.countTokens', { conversationId: control.conversationId,
                input: { text: 'Count only; do not append this to the conversation' }, timeoutMs: 5000 }, client);
            assert.equal(counted.ok, true, JSON.stringify(counted));
            assert.equal(counted.data.inputTokens, 128);
            assert.equal(counted.data.scope, 'provided_input_only');
            assert.equal(counted.data.generationRequests, 0);
            const after = await services.dispatch('conversations.get', { conversationId: control.conversationId }, client);
            const historyAfter = await services.dispatch('conversations.readHistory', { conversationId: control.conversationId }, client);
            assert.deepEqual(after, before);
            assert.deepEqual(historyAfter, historyBefore);
            assert.equal(observed.generation, 2);
            assert.equal(observed.count, 3);
            const rejected = await services.dispatch('conversations.countTokens', { conversationId: control.conversationId,
                input: { text: 'Must not reach the provider' } }, { ...client, principalId: 'other-principal' });
            assert.equal(rejected.ok, false);
            assert.equal(observed.count, 3);
            const getRecord = store.getRecord.bind(store);
            let conversationReads = 0;
            store.getRecord = async key => {
                if (key.kind === 'conversation' && ++conversationReads === 2) await delay(150);
                return getRecord(key);
            };
            try {
                const timedOut = await services.dispatch('conversations.countTokens', { conversationId: control.conversationId,
                    input: { text: 'Preparation must share the same deadline' }, timeoutMs: 20 }, client);
                assert.equal(timedOut.ok, false);
                assert.equal(timedOut.error.code, 'E_COUNT_TOKENS_TIMEOUT');
                await delay(180);
                assert.equal(observed.count, 3);
            } finally { store.getRecord = getRecord; }
        }
        console.log(JSON.stringify({ scenario, ...observed, realLocalHttp: true, sameConversation: true, modelCharges: 0 }));
    } finally {
        await runtime?.close(); await services?.close(); await store?.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(basename(root).startsWith('sandbox-i10-count-runtime-'));
        await rm(root, { recursive: true, force: true });
    }
});
