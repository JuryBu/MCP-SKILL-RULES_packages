import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SqliteStore } from '../../../dist/agent-server/storage/sqlite.js';
import { createSqliteProviderPorts } from '../../../dist/agent-server/storage/provider-journal.js';
import { createSqliteMediaPort } from '../../../dist/agent-server/storage/media-port.js';
import { MediaService } from '../../../dist/agent-server/media/service.js';
import { GeminiAdapter } from '../../../dist/agent-server/providers/gemini.js';
import { ProviderDispatcher } from '../../../dist/agent-server/providers/dispatch.js';
import { FetchTransport } from '../../../dist/agent-server/providers/http.js';
import { freezeRequest } from '../../../dist/agent-server/providers/assemble.js';
import { newProfile } from '../../../dist/agent-server/profiles/profile-store.js';

function crc32(bytes) {
    let checksum = 0xffffffff;
    for (const byte of bytes) {
        checksum ^= byte;
        for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    return (checksum ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const label = Buffer.from(type);
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([size, label, data, checksum]);
}

function png4k() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(4096, 0); header.writeUInt32BE(4096, 4); header[8] = 8;
    const pixels = Buffer.alloc(4096 * 4097, 128);
    for (let row = 0; row < 4096; row++) pixels[row * 4097] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

test('ordinary 4K PNG crosses JSON expansion bounds through local HTTP, Gemini SSE, persistence, publication and cold readback', { timeout: 120000 }, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sandbox-agent-4k-replay-'));
    const image = png4k();
    const checksum = createHash('sha256').update(image).digest('hex');
    const json = { responseId: 'owned-local-4k-response', modelVersion: 'owned-local-4k-model',
        candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') }, thoughtSignature: 'owned-fixture-signature' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 16, totalTokenCount: 17,
            cachedContentTokenCount: 0, thoughtsTokenCount: 0, toolUsePromptTokenCount: 0, serviceTier: 'standard' } };
    const wire = Buffer.from(`data: ${JSON.stringify(json)}\n\n`);
    let requests = 0, store, transport;
    const server = createServer(async (request, response) => {
        requests++;
        for await (const ignored of request) assert.ok(ignored.length);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'owned-local-4k-request' });
        for (let offset = 0; offset < wire.length; offset += 256 * 1024) {
            if (!response.write(wire.subarray(offset, offset + 256 * 1024))) await once(response, 'drain');
        }
        response.end();
    });
    try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        store = await SqliteStore.open({ dataDir });
        const conversationId = randomUUID(), runId = randomUUID(), now = new Date().toISOString();
        const deadlineAt = new Date(Date.now() + 110000).toISOString();
        const conversation = { key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1,
            value: { conversationId, principalId: 'owned-4k-replay', state: 'open', retention: { mode: 'archive', lastRunEnd: null,
                lastClose: null, expiresAt: null, activeRuns: 1 }, createdAt: now, updatedAt: now, historyEpoch: 1, appendSeq: 0,
                viewRevision: 0, workspaceRevision: 0, runEpoch: 1, eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1,
                activeRunId: runId, options: {} } };
        const run = { key: { conversationId, kind: 'run', id: runId }, revision: 1,
            value: { conversationId, runId, rootRunId: runId, parentRunId: null, kind: 'task', runEpoch: 1, state: 'running',
                phase: 'awaiting_response', effectState: 'none', cleanupState: 'pending', activeRoundId: randomUUID(), activeStepId: randomUUID(),
                pendingInteractionIds: [], budget: { rootBudgetId: runId }, resultStatus: null, stopReason: null, deadlineAt, createdAt: now, updatedAt: now } };
        await store.commitTransition({ expected: [{ key: conversation.key, revision: null }, { key: run.key, revision: null }], records: [conversation, run] });
        let ports = createSqliteProviderPorts(store);
        await ports.accountingPort.execute({ type: 'create_quota_limit', definition: { quotaLimitId: 'owned-4k-total', currency: 'USD',
            maxCostMicros: 1000, quotaScopeIds: ['owned-4k-account'], sourceRef: 'verified_fixture' } });
        await ports.accountingPort.createBudget({ rootBudgetId: runId, mode: 'hard', quotaLimitId: 'owned-4k-total', currency: 'USD',
            maxCostMicros: 1000, maxModelCalls: 1, maxOutputTokens: 32, deadlineAt, sourceRef: 'verified_fixture' });
        const profile = { ...newProfile({ profileId: 'owned-4k-profile', label: 'owned local 4K replay', protocol: 'gemini',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, modelId: 'owned-local-4k-model' }), quotaScopeId: 'owned-4k-account' };
        const adapter = new GeminiAdapter();
        const snapshot = freezeRequest({ adapter, profile, modelId: profile.defaultModel, rootBudgetId: runId, stream: true,
            versions: { conversationId, runId, roundId: run.value.activeRoundId, stepId: run.value.activeStepId, actionId: randomUUID(),
                runEpoch: 1, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0, catalogVersion: 'fixture',
                capabilityVersion: 'fixture', priceVersion: null, toolSchemaHash: 'none', skillVersions: {},
                attachmentManifestHash: 'none', nativeReplayHash: 'none' },
            view: { protocol: 'gemini', contents: [{ role: 'user', parts: [{ text: 'ordinary local 4K media fixture' }] }] },
            parameters: { generationConfig: { maxOutputTokens: 32, responseModalities: ['IMAGE'], imageConfig: { imageSize: '4K' } } }, deadlineAt });
        transport = new FetchTransport();
        const dispatcher = new ProviderDispatcher({ journal: ports.journal, transport });
        const response = await dispatcher.execute(adapter, snapshot, runId,
            { currency: 'USD', amountMicros: 100, reliable: true, source: 'fixture', sourceRef: 'verified_fixture' }).catch(error => {
            console.error(JSON.stringify({ stage: 'dispatch_failed', code: error.code, acceptance: error.acceptance,
                phase: error.phase, message: error.message }));
            throw new Error(`${error.code}: ${error.message}`);
        });
        assert.equal(requests, 1); assert.equal(response.complete, true);
        console.log(JSON.stringify({ stage: 'response_committed', imageBytes: image.length, wireBytes: wire.length,
            logicalResponseBytes: Buffer.byteLength(JSON.stringify(response)), checksum, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
        const media = () => new MediaService({ durable: createSqliteMediaPort(store), retention: async () => ({ mode: 'archive' }) });
        let service = media();
        const artifacts = await service.publish({ snapshot: run.value, signal: new AbortController().signal }, response);
        assert.equal(artifacts.length, 1);
        const artifact = artifacts[0];
        assert.equal(artifact.byteLength, image.length); assert.equal(artifact.sha256, checksum);
        assert.deepEqual(await readFile(artifact.absolutePath), image);
        for (const offset of [0, Math.floor(image.length / 2), image.length - 113]) {
            const page = await service.read({ conversationId, artifactId: artifact.artifactId, offset, maxBytes: 113 });
            assert.deepEqual(Buffer.from(page.dataBase64, 'base64'), image.subarray(offset, offset + 113));
        }
        console.log(JSON.stringify({ stage: 'published_and_paged', artifactId: artifact.artifactId, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
        let saved = await ports.journal.readAttempt(response.attemptId);
        assert.equal(saved.state, 'committed');
        assert.equal(saved.response.complete, true);
        assert.equal(saved.response.canExecuteTools, false);
        assert.ok(saved.rawResponseArtifact?.artifactId);
        const rawPage = await store.readArtifact({ conversationId, artifactId: saved.rawResponseArtifact.artifactId, offset: 7, maxBytes: 8192 });
        assert.equal(Buffer.from(rawPage.dataBase64, 'base64').length, 8192);
        await store.close();
        store = await SqliteStore.open({ dataDir }); ports = createSqliteProviderPorts(store); service = media();
        saved = await ports.journal.readAttempt(response.attemptId);
        assert.equal(saved.state, 'committed'); assert.equal(saved.response.complete, true);
        const coldPage = await service.read({ conversationId, artifactId: artifact.artifactId, offset: image.length - 113, maxBytes: 113 });
        assert.deepEqual(Buffer.from(coldPage.dataBase64, 'base64'), image.subarray(-113));
        assert.equal(requests, 1);
        assert.equal((await ports.accountingPort.read(runId)).budget.spentCalls, 1);
        const replay = new ProviderDispatcher({ journal: ports.journal, transport });
        const replayed = await replay.execute(adapter, snapshot, runId,
            { currency: 'USD', amountMicros: 100, reliable: true, source: 'fixture', sourceRef: 'verified_fixture' }, { attemptId: response.attemptId });
        assert.equal(replayed.canExecuteTools, false);
        assert.equal(requests, 1);
        console.log(JSON.stringify({ stage: 'cold_reopened_and_replayed', requests, artifactSha256: coldPage.sha256,
            rssMiB: Math.round(process.memoryUsage().rss / 1048576) }));
    } finally {
        await transport?.close(); await store?.close(); server.closeAllConnections();
        await new Promise(done => server.close(done));
        assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith('sandbox-agent-4k-replay-'));
        await rm(dataDir, { recursive: true, force: true });
    }
});
