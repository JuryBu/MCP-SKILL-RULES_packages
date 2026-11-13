import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../../storage/memory.ts';
import { canonicalJson } from '../../protocol.ts';
import { createToolDeliveryStore, hashBytes, hashContext } from '../index.ts';

const identity = ordinal => ({ conversationId: `delivery-body-${ordinal}`, runId: 'run', runEpoch: 1, stepId: 'step', callId: 'call' });
const key = value => ({ conversationId: value.conversationId, kind: 'step', id: `context:tool-delivery:${hashContext(value)}` });

test('a complete large original page stays complete while delivery metadata only stores a body reference', async () => {
    const store = new MemoryStore();
    const owner = identity('page');
    const original = { callId: owner.callId, name: 'history_read', result: { ok: true,
        data: { dataBase64: Buffer.alloc(100000, 65).toString('base64'), nextOffset: null, complete: true } } };
    const first = await createToolDeliveryStore(store).preserve(owner, original);
    assert.equal(first.shortened, false);
    assert.deepEqual(first.sent, original);
    const record = await store.getRecord(key(owner));
    assert.equal(record.value.schemaVersion, 2);
    assert.equal(record.value.sent, undefined);
    assert.ok(Buffer.byteLength(canonicalJson(record.value)) < 4096);
    assert.equal(record.value.sentArtifact.artifactId, first.source.artifactId);
    const cold = await createToolDeliveryStore(store).read(owner, original);
    assert.deepEqual(cold, first);
    await store.close();
});

test('long command raw bytes remain in the original while their stable short view omits duplicate Base64', async () => {
    const store = new MemoryStore();
    const owner = identity('command');
    const stdout = 'BEGIN\n' + 'L'.repeat(50000) + '\nEND';
    const original = { callId: owner.callId, name: 'run_command', result: { ok: true, data: {
        stdout, stdoutBase64: Buffer.from(stdout).toString('base64'), stderr: '', stderrBase64: '',
        exitCode: 0, cleanupState: 'released', outputDecoding: { stdout: { status: 'valid' } } } } };
    const deliveries = createToolDeliveryStore(store);
    const first = await deliveries.preserve(owner, original, { kind: 'log', maxTextChars: 512 });
    assert.equal(first.shortened, true);
    assert.match(first.sent.result.data.stdout, /工具发送短版/);
    assert.equal(first.sent.result.data.stdoutBase64, undefined);
    assert.equal(first.sent.result.data.rawBytesSource.artifactId, first.source.artifactId);
    assert.equal(first.sent.result.data.cleanupState, 'released');
    const raw = await store.readContent(owner.conversationId, first.source.artifactId);
    assert.deepEqual(raw, original);
    assert.equal(hashBytes(canonicalJson(raw)), first.receivedHash);
    const cold = createToolDeliveryStore(store);
    const replay = await cold.preserve(owner, original, { maxTextChars: 100000 }, async () => { throw new Error('must not transform twice'); });
    assert.deepEqual(replay, first);
    assert.ok(Buffer.byteLength(canonicalJson((await store.getRecord(key(owner))).value)) < 4096);
    await store.close();
});

test('legacy inline delivery states remain readable and a lost new-state reply resolves the original committed body', async () => {
    const store = new MemoryStore();
    const legacyOwner = identity('legacy');
    const original = { callId: legacyOwner.callId, name: 'read_file', result: { text: 'legacy original' } };
    const seeded = await createToolDeliveryStore(store).preserve(legacyOwner, original);
    const record = await store.getRecord(key(legacyOwner));
    await store.commitTransition({ expected: [{ key: record.key, revision: record.revision }],
        records: [{ key: record.key, revision: record.revision + 1, value: seeded }] });
    assert.deepEqual(await createToolDeliveryStore(store).read(legacyOwner, original), seeded);
    const owner = identity('lost-reply');
    let lost = false;
    const wrapper = { getRecord: store.getRecord.bind(store), readArtifact: store.readArtifact.bind(store), commitTransition: async transition => {
        const result = await store.commitTransition(transition);
        if (!lost && transition.records?.some(entry => entry.value.schemaVersion === 2)) { lost = true; throw new Error('lost committed reply'); }
        return result;
    } };
    const saved = await createToolDeliveryStore(wrapper).preserve(owner, { ...original, callId: owner.callId });
    assert.equal(lost, true);
    assert.deepEqual(await createToolDeliveryStore(store).read(owner), saved);
    await store.close();
});
