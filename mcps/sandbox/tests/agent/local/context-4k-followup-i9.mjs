import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { openAgentStore } from '../../../dist/agent-server/storage/index.js';

const source = process.env.I9_CONTEXT_SOURCE === '1';
const load = path => import(new URL(`../../../${source ? 'src' : 'dist'}/agent-server/${path}.${source ? 'ts' : 'js'}`, import.meta.url));
const { createAgentRuntime } = await load('runtime');
const { createAgentServices } = await load('server-services');
const { MemoryCatalogPort, entryFromMetadata, modelScope } = await load('models/catalog');
const { newProfile } = await load('profiles/profile-store');
const { ContextService } = await load('context/service');
const { readHistoryArtifact } = await load('context/artifact-source');
const { GeminiAdapter } = await load('providers/gemini');
const { canonicalJson } = await load('protocol');

function crc32(bytes) {
    let checksum = 0xffffffff;
    for (const byte of bytes) {
        checksum ^= byte;
        for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const label = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, checksum]);
}

function png4k() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(4096); header.writeUInt32BE(4096, 4); header[8] = 8;
    const pixels = Buffer.alloc(4096 * 4097, 128);
    let noise = 0x536ab429;
    for (let offset = 0; offset < 13 * 1048576; offset++) {
        noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5;
        pixels[offset] = noise & 255;
    }
    for (let row = 0; row < 4096; row++) pixels[row * 4097] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(pixels, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
}

async function until(operation, predicate) {
    const expires = Date.now() + 300000;
    while (Date.now() < expires) {
        const result = await operation();
        if (predicate(result)) return result;
        await delay(25);
    }
    assert.fail('formal service run did not settle');
}

test('I9 formal services record a 4K model step, reopen the CID and send one image in the next real request', { timeout: 360000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-i9-context-followup-'));
    const image = png4k();
    assert.ok(image.length > 12 * 1048576 && image.length < 14 * 1048576);
    const data = image.toString('base64');
    const requests = [];
    const streamModes = [];
    let store, runtime, services, control;
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(request.headers.authorization, undefined);
        if (request.url.includes('countTokens')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ totalTokens: 1024 }));
            return;
        }
        requests.push(body);
        const parts = requests.length === 1 ? [{ inlineData: { mimeType: 'image/png', data }, thoughtSignature: 'i9-owned-signature' }]
            : [{ text: 'The same retained picture is available.' }];
        const json = { responseId: `i9-followup-${requests.length}`, modelVersion: 'i9-context-model',
            candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts } }],
            usageMetadata: { promptTokenCount: 1024, candidatesTokenCount: 16, totalTokenCount: 1040 } };
        const streaming = request.url.includes('streamGenerateContent');
        streamModes.push(streaming);
        response.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
        const wire = Buffer.from(streaming ? `data: ${JSON.stringify(json)}\n\n` : JSON.stringify(json));
        for (let offset = 0; offset < wire.length; offset += 256 * 1024) {
            if (!response.write(wire.subarray(offset, offset + 256 * 1024))) await once(response, 'drain');
        }
        response.end();
    });
    const client = { principalId: 'i9-followup-owner', clientId: 'i9-followup-cli', callerHost: 'standalone-cli' };
    const dataDir = join(root, 'state');
    const boot = async () => {
        store = await openAgentStore({ dataDir: join(dataDir, 'store') });
        runtime = createAgentRuntime({ store, cleanupGraceMs: 2000, onConversationClosed: conversation => services?.onConversationClosed(conversation) });
        services = await createAgentServices({ store, runtime, catalogPort: new MemoryCatalogPort(), sharedServices: [],
            authority: { dataDir, runtimeDir: join(dataDir, 'runtime'), principalId: client.principalId,
                credentialRef: 'i9-local-control', secret: Buffer.alloc(32), endpoint: 'i9-local-fixture' } });
        const existing = await services.provider.profiles.get('i9-context-profile');
        const profile = existing ?? (await services.provider.profiles.put(newProfile({ profileId: 'i9-context-profile', label: 'I9 local context fixture',
            protocol: 'gemini', baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, modelId: 'i9-context-model' }), 0, client, randomUUID())).profile;
        const expiresAt = new Date(Date.now() + 600000).toISOString();
        const evidence = value => ({ value, status: 'supported', source: 'verified_fixture', sourceRef: 'i9-owned-local-http',
            observedAt: new Date().toISOString(), expiresAt, scope: modelScope(profile, 'i9-context-model', null), version: 'i9-v1', confidence: 'contract_checked' });
        const entry = entryFromMetadata(profile, { id: 'i9-context-model' }, new Date().toISOString(), expiresAt);
        Object.assign(entry, { contextWindow: evidence(1048576), maxOutputTokens: evidence(512), inputModalities: evidence(['text', 'image']),
            outputModalities: evidence(['text', 'image']), tools: evidence(false), streaming: evidence(true),
            parameters: { maxOutputTokens: evidence({ type: 'integer', min: 1, max: 512, wirePath: 'generationConfig.maxOutputTokens' }) },
            pricing: evidence({ priceVersion: 'i9-fixture-price', currency: 'USD', unitTokens: 1000000, inputUncached: 1, inputCacheRead: 1,
                inputCacheWrite: null, output: 1, reasoningBilledSeparately: false, media: 'included_in_tokens', serverTools: 'disabled',
                sourceRef: 'verified_fixture', validFrom: new Date().toISOString(), expiresAt, coversAllParameters: true }) });
        await services.provider.models.port.publish({ schemaVersion: 1, catalogVersion: `i9-catalog-${randomUUID()}`, profileId: profile.profileId,
            profileRevision: profile.revision, observedAt: new Date().toISOString(), expiresAt, entries: [entry] }, null);
        return profile;
    };
    try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const profile = await boot();
        await services.provider.ledger.createQuotaLimit({ quotaLimitId: 'i9-context-total', currency: 'USD', maxCostMicros: 100000,
            quotaScopeIds: [profile.quotaScopeId], sourceRef: 'verified_fixture' });
        const created = await services.dispatch('conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' },
            options: { profileId: profile.profileId, modelId: profile.defaultModel, tools: [] } }, client);
        assert.equal(created.ok, true, JSON.stringify(created));
        control = { conversationId: created.data.conversationId, controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
        for (let round = 1; round <= 2; round++) {
            const started = await services.dispatch('runs.start', { ...control, clientCommandId: randomUUID(), input: { text: `I9 formal media round ${round}` },
                budget: { costMode: 'hard', currency: 'USD', quotaLimitId: 'i9-context-total', maxCostMicros: 10000,
                    maxModelCalls: 2, maxOutputTokens: 512, wallMs: 300000 } }, client);
            assert.equal(started.ok, true, JSON.stringify(started));
            const ended = await until(() => services.dispatch('runs.get', { conversationId: control.conversationId, runId: started.data.runId }, client),
                value => ['succeeded', 'failed', 'cancelled', 'outcome_unknown', 'paused'].includes(value.data?.state));
            console.log(JSON.stringify({ stage: `formal_round_${round}`, state: ended.data.state, requests: requests.length,
                failure: ended.data.failure ?? ended.error, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
            assert.equal(ended.data.state, 'succeeded', JSON.stringify(ended));
            if (round === 1) {
                const history = await store.readHistory({ conversationId: control.conversationId, view: 'raw', effectiveOnly: true, maxBytes: 262144 });
                const modelStep = history.items.find(item => item.kind === 'model_step');
                assert.ok(modelStep?.objectRef.rawBytes > 32 * 1048576, 'runtime.recordStep must retain the actual expanded model response');
                console.log(JSON.stringify({ stage: 'recordStep_verified', sourceBytes: modelStep.objectRef.rawBytes, imageBytes: image.length }));
                await runtime.close(); await services.close(); await store.close();
                services = runtime = store = undefined;
                await boot();
            }
        }
        assert.equal(requests.length, 2);
        assert.deepEqual(streamModes, [true, true]);
        const second = requests[1];
        const pictures = second.contents.flatMap(content => content.parts ?? []).filter(part => part.inlineData);
        assert.equal(pictures.length, 1);
        assert.equal(pictures[0].inlineData.data, data);
        assert.ok(!JSON.stringify(second).includes('"raw"'));
        assert.ok(Buffer.byteLength(JSON.stringify(second)) > 16 * 1048576);
        assert.ok(Buffer.byteLength(JSON.stringify(second)) < 32 * 1048576);
        console.log(JSON.stringify({ stage: 'same_CID_followup_verified', imageBytes: image.length, requestBytes: Buffer.byteLength(JSON.stringify(second)),
            imageCopies: pictures.length, requests: requests.length, sourceModules: source, reopened: true }));
    } finally {
        await runtime?.close(); await services?.close(); await store?.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        const temporaryRoot = resolve(root);
        assert.equal(dirname(temporaryRoot), resolve(tmpdir()), 'fixture cleanup must stay directly within the system Temp directory');
        assert.ok(basename(temporaryRoot).startsWith('sandbox-i9-context-followup-'), 'fixture cleanup must retain the owned prefix');
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

function historyItem(overrides = {}) {
    return { itemId: 'i9-item', contentId: 'i9-content', seq: 1, roundId: 'i9-round', stepId: null,
        runId: null, runEpoch: null, kind: 'user_input', role: 'user', view: 'raw', effective: true,
        objectRef: { rawBytes: 1, hash: '0'.repeat(64) }, ...overrides };
}

function historyContext(item, readContent) {
    return { snapshot: { conversationId: 'i9-negative-context' }, signal: new AbortController().signal, readContent,
        async readHistory() { return { conversationId: 'i9-negative-context', historyEpoch: 1, appendSeq: 1, viewRevision: 0,
            items: [item], hasMore: false, nextCursor: null }; } };
}

test('I9 context guards reject ordinary oversized text before body reads and preserve final view and hash checks', async () => {
    let reads = 0;
    const oversized = historyItem({ objectRef: { rawBytes: 32 * 1048576 + 1, hash: '0'.repeat(64) } });
    const plan = { adapter: new GeminiAdapter(), modelId: 'i9-context-model', parameters: {} };
    await assert.rejects(() => new ContextService().createPrepareView()(historyContext(oversized, async () => { reads++; return null; }), plan),
        error => error.code === 'CONTEXT_INPUT_BUDGET');
    assert.equal(reads, 0);
    const value = { text: 'x'.repeat(2048) };
    const canonical = canonicalJson(value);
    const item = historyItem({ objectRef: { rawBytes: Buffer.byteLength(canonical), hash: createHash('sha256').update(canonical).digest('hex') } });
    const bounded = new ContextService({ maxReadBytes: 1024, maxViewBytes: 1024 });
    await assert.rejects(() => bounded.createPrepareView(async () => ({ readItem: async () => value }))(historyContext(item, async () => value), plan),
        error => error.code === 'CONTEXT_INPUT_BUDGET');
    const corrupt = historyItem({ objectRef: { ...item.objectRef, hash: '0'.repeat(64) } });
    await assert.rejects(() => new ContextService().createPrepareView(async () => ({ readItem: async () => value }))(historyContext(corrupt, async () => value), plan),
        error => error.code === 'CONTEXT_HISTORY_STALE');
});

test('I9 context guards use only the bounded media port and reject missing ports, wrong hashes, oversize sources and bad frames', async () => {
    const item = historyItem({ kind: 'model_step', role: 'assistant', objectRef: { rawBytes: 33 * 1048576, hash: '0'.repeat(64) } });
    let frameReads = 0, mediaReads = 0;
    const store = { async readArtifact() { frameReads++; throw new Error('large source must not enter a 427-page loop'); } };
    const input = { conversationId: 'i9-negative-context', item, mediaExpansion: true };
    await assert.rejects(() => readHistoryArtifact(store, input), error => error.code === 'CONTEXT_SOURCE_GAP');
    const mediaStore = { ...store, async readContextMediaContent() { mediaReads++; return { kind: 'model', response: {} }; } };
    await assert.rejects(() => readHistoryArtifact(mediaStore, input), error => error.code === 'CONTEXT_HISTORY_STALE');
    assert.equal(mediaReads, 1);
    await assert.rejects(() => readHistoryArtifact(mediaStore, { ...input, item: { ...item,
        objectRef: { ...item.objectRef, rawBytes: 256 * 1048576 + 1 } } }), error => error.code === 'CONTEXT_INPUT_BUDGET');
    await assert.rejects(() => readHistoryArtifact(mediaStore, { ...input, item: { ...item, kind: 'user_input', role: 'user' } }),
        error => error.code === 'CONTEXT_INPUT_BUDGET');
    await assert.rejects(() => readHistoryArtifact(mediaStore, { ...input, maxReadBytes: 0 }), error => error.code === 'CONTEXT_CONFIG_INVALID');
    assert.equal(mediaReads, 1);
    assert.equal(frameReads, 0);
});
