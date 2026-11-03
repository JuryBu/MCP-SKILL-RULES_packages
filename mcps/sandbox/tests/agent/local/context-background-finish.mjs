import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { createAgentServices } from '../../../src/agent-server/server-services.ts';
import { MemoryCatalogPort, entryFromMetadata, modelScope } from '../../../src/agent-server/models/catalog.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

test('seven ordinary read/write rounds settle actual background HTTP before normal Runtime release and cold reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-context-owned-background-'));
    console.log(JSON.stringify({ trialRoot: root }));
    const work = join(root, 'ordinary workspace with preserved input and output evidence');
    await mkdir(work);
    const path = join(work, 'timeline.txt');
    await writeFile(path, 'base\n');
    const modelId = 'own-formal-context-workspace';
    const requests = [];
    let compressionCalls = 0;
    let releaseHeld;
    let fifthResponse = false;
    let heldClosed = false;
    let heldAtNormalEnd = false;
    const text = value => typeof value === 'string' ? value : value?.map(part => part.text ?? '').join('') ?? '';
    const server = createServer(async (incoming, outgoing) => {
        try {
            assert.equal(incoming.headers.authorization, undefined);
            const pieces = []; for await (const piece of incoming) pieces.push(piece);
            const body = JSON.parse(Buffer.concat(pieces).toString('utf8'));
            assert.equal(body.model, modelId);
            const latest = body.messages.filter(message => message.role === 'user').at(-1);
            let compression; try { compression = JSON.parse(text(latest.content)); } catch {}
            let message; let finishReason = 'stop'; let ordinal;
            if (Array.isArray(compression?.targets)) {
                compressionCalls++;
                if (compressionCalls === 2) {
                    outgoing.once('close', () => { if (!outgoing.writableEnded) heldClosed = true; });
                    await new Promise(resolveHeld => { releaseHeld = resolveHeld; });
                }
                message = { role: 'assistant', content: JSON.stringify({ body: 'Ordinary numbered file edits are preserved in original history and the current file.',
                    skeleton: 'File edits with stable source identities.', title: 'Ordinary file timeline', unresolved: [] }) };
            } else {
                const userIndex = body.messages.findLastIndex(message => message.role === 'user' && text(message.content).includes('FORMAL_INPUT='));
                const input = JSON.parse(/FORMAL_INPUT=(\{[^\n]+\})/.exec(text(body.messages[userIndex].content))[1]);
                assert.equal(input.path, path); ordinal = input.ordinal;
                const results = body.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
                const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: `${name}-${input.nonce}`,
                    type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
                if (!results.length) message = call('read_file', { path, limit: 65536 });
                else if (results.length === 1) {
                    const envelope = JSON.parse(text(results[0].content)); const read = envelope.result ?? envelope;
                    assert.equal(read.ok, true);
                    message = call('write_file', { path, expectedVersion: read.data.expectedVersion, content: read.data.content + input.line + '\n' });
                } else {
                    assert.equal(results.length, 2);
                    message = { role: 'assistant', content: `Completed ordinary file row ${input.line}; nonce=${input.nonce}.` };
                    if (ordinal === 5) fifthResponse = true;
                }
                if (results.length < 2) finishReason = 'tool_calls';
            }
            requests.push({ kind: compression?.targets ? 'compression' : 'business', ordinal, body });
            outgoing.writeHead(200, { 'content-type': 'application/json' });
            outgoing.end(JSON.stringify({ id: `own-${randomUUID()}`, model: modelId, choices: [{ index: 0, message, finish_reason: finishReason }],
                usage: { prompt_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4), completion_tokens: 120,
                    prompt_tokens_details: { cached_tokens: 0 }, cache_creation_input_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } } }));
        } catch (error) { outgoing.writeHead(500); outgoing.end(JSON.stringify({ error: { message: error.message } })); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let store; let runtime; let services;
    const dataDir = join(root, 'state');
    const client = { principalId: 'own-background-client', clientId: 'own-background-cli', callerHost: 'standalone-cli' };
    const makeServices = async () => {
        store = await openAgentStore({ dataDir: join(dataDir, 'store') });
        runtime = createAgentRuntime({ store, cleanupGraceMs: 3000, onConversationClosed: conversation => services?.onConversationClosed(conversation) });
        services = await createAgentServices({ store, runtime, catalogPort: new MemoryCatalogPort(), sharedServices: [],
            authority: { dataDir, runtimeDir: join(dataDir, 'runtime'), principalId: client.principalId,
                credentialRef: 'own-local-control', secret: Buffer.alloc(32), endpoint: 'own-local-fixture' } });
    };
    try {
        await makeServices();
        const profile = (await services.provider.profiles.put(newProfile({ profileId: 'own-background-profile', label: 'Own background HTTP',
            protocol: 'compatible_chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId }), 0, client, randomUUID())).profile;
        const observedAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 600000).toISOString();
        const evidence = value => ({ value, status: 'supported', source: 'verified_fixture', sourceRef: 'own-background-finish', observedAt, expiresAt,
            scope: modelScope(profile, modelId, null), version: 'own-v1', confidence: 'contract_checked' });
        const entry = entryFromMetadata(profile, { id: modelId }, observedAt, expiresAt);
        Object.assign(entry, { contextWindow: evidence(65536), maxOutputTokens: evidence(4096), inputModalities: evidence(['text']), outputModalities: evidence(['text']),
            tools: evidence(true), parameters: { maxOutputTokens: evidence({ type: 'integer', min: 1, max: 4096, wirePath: 'max_tokens' }) },
            pricing: evidence({ priceVersion: 'own-price', currency: 'USD', unitTokens: 1000000, inputUncached: 0, inputCacheRead: 0,
                inputCacheWrite: 0, output: 0, reasoningBilledSeparately: false, media: 'included_in_tokens', serverTools: 'disabled',
                sourceRef: 'verified_fixture', validFrom: observedAt, expiresAt, coversAllParameters: true }) });
        await services.provider.models.port.publish({ schemaVersion: 1, catalogVersion: 'own-catalog', profileId: profile.profileId,
            profileRevision: profile.revision, observedAt, expiresAt, entries: [entry] }, null);
        await services.provider.ledger.createQuotaLimit({ quotaLimitId: 'own-background-total', currency: 'USD', maxCostMicros: 0,
            quotaScopeIds: [profile.quotaScopeId], sourceRef: 'verified_fixture' });
        const created = await services.dispatch('conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' },
            options: { profileId: profile.profileId, modelId, writeRoots: [work], tools: ['read_file', 'write_file'],
                contextPolicy: { localContextWindowTokens: 32768 } } }, client);
        assert.equal(created.ok, true, JSON.stringify(created));
        const owner = { conversationId: created.data.conversationId, controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
        const budget = { wallMs: 90000, maxModelCalls: 8, costMode: 'hard', currency: 'USD', maxCostMicros: 0,
            maxOutputTokens: 1024, quotaLimitId: 'own-background-total' };
        const runs = [];
        for (let ordinal = 1; ordinal <= 7; ordinal++) {
            const input = { nonce: randomUUID(), path, ordinal, line: `files-${ordinal}` };
            const started = await services.dispatch('runs.start', { ...owner, clientCommandId: randomUUID(), budget,
                input: { text: `FORMAL_INPUT=${JSON.stringify(input)}` } }, client);
            assert.equal(started.ok, true, JSON.stringify(started));
            const deadline = performance.now() + 12000;
            while (true) {
                const run = await services.dispatch('runs.get', { conversationId: owner.conversationId, runId: started.data.runId }, client);
                assert.equal(run.ok, true, JSON.stringify(run));
                if (releaseHeld && fifthResponse && !heldAtNormalEnd) {
                    assert.equal(heldClosed, false, 'normal business completion aborted its background HTTP');
                    assert.equal(run.data.state, 'running', JSON.stringify(run));
                    heldAtNormalEnd = true; releaseHeld(); releaseHeld = null;
                }
                if (['succeeded', 'failed', 'cancelled', 'outcome_unknown', 'paused'].includes(run.data.state)) {
                    assert.equal(run.data.state, 'succeeded', JSON.stringify(run));
                    assert.ok(['released', 'not_needed'].includes(run.data.cleanupState), JSON.stringify(run));
                    const conversation = await services.dispatch('conversations.get', { conversationId: owner.conversationId }, client);
                    assert.equal(conversation.data.activeRunId, null);
                    assert.equal(run.data.budget.amountUnknown, false, JSON.stringify(run));
                    assert.equal(run.data.budget.heldCostMicros, 0);
                    runs.push(run.data.runId); break;
                }
                assert.ok(performance.now() < deadline, JSON.stringify({ ordinal, fifthResponse, compressionCalls, heldClosed, run }));
                await delay(5);
            }
        }
        assert.equal(heldAtNormalEnd, true);
        assert.ok(compressionCalls >= 2);
        assert.equal(requests.filter(request => request.kind === 'business').length, 21);
        const status = await services.contextService.status({ conversationId: owner.conversationId });
        assert.ok(status.history.viewRevision > 0, JSON.stringify(status));
        assert.notEqual(status.scheduler.state, 'hardPaused');
        assert.equal(await readFile(path, 'utf8'), 'base\n' + Array.from({ length: 7 }, (_, index) => `files-${index + 1}\n`).join(''));
        const readCompleteHistory = async () => {
            const items = [];
            const cursors = new Set();
            let cursor;
            let metadata;
            for (;;) {
                const page = await store.readHistory({ conversationId: owner.conversationId, limit: 200, maxBytes: 262144,
                    ...(cursor ? { cursor } : {}) });
                const current = { historyEpoch: page.historyEpoch, appendSeq: page.appendSeq, viewRevision: page.viewRevision };
                if (metadata) assert.deepEqual(current, metadata);
                else metadata = current;
                items.push(...page.items);
                if (!page.hasMore) return { ...metadata, items };
                assert.ok(page.items.length && page.nextCursor && !cursors.has(page.nextCursor));
                cursors.add(page.nextCursor);
                cursor = page.nextCursor;
            }
        };
        const original = await readCompleteHistory();
        const originalHash = createHash('sha256').update(JSON.stringify(original)).digest('hex');
        const beforeCold = requests.length;
        await runtime.close(); await services.close(); await store.close(); await makeServices();
        assert.deepEqual(await readCompleteHistory(), original);
        assert.equal(requests.length, beforeCold);
        console.log(JSON.stringify({ evidence: 'normal-background-finish', conversationId: owner.conversationId, runs, originalHash,
            localWindow: 32768, businessRequests: 21, compressionCalls, viewRevision: status.history.viewRevision,
            heldAtNormalEnd, heldClosed, coldReopenRequests: requests.length - beforeCold, paidRequests: 0 }));
    } finally {
        releaseHeld?.(); server.closeAllConnections();
        await runtime?.close(); await services?.close(); await store?.close();
        await new Promise(resolveClosed => server.close(resolveClosed));
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true });
    }
});
