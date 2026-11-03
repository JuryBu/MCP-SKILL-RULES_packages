import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { AgentFault, canonicalJson } from '../../../src/agent-server/protocol.ts';
import { ProviderCompressionModelPort } from '../../../src/agent-server/context/server-adapter.ts';
import { ContextCompactor } from '../../../src/agent-server/context/bpc.ts';
import { hashBytes, hashContext } from '../../../src/agent-server/context/config.ts';
import { createFixture, ready } from './context-fixtures.mjs';

const originalText = '保留最终报告。重复要求。重复要求。';
const invalidDigest = request => {
    const target = JSON.parse(request.chunk.body).targets[0];
    return { body: '保留报告和重复要求', skeleton: '报告待完成', title: '核查', unresolved: [
        { quote: '重复要求。', source: { itemId: target.span.itemId, blockId: target.span.blockId, startByte: 134 } },
    ] };
};
const validDigest = request => {
    const target = JSON.parse(request.chunk.body).targets[0];
    return { body: '保留最终报告和要求', skeleton: '报告待完成', title: '核查', unresolved: [
        { quote: originalText, source: { itemId: target.span.itemId, blockId: target.span.blockId } },
    ] };
};

function fixture(options = {}) {
    const base = createFixture({ rounds: options.rounds ?? 4, text: () => originalText, ...(options.now ? { now: options.now } : {}) });
    const records = new Map();
    const contents = new Map();
    const journal = new Map();
    const charges = new Map();
    const sent = [];
    const prepared = [];
    const profile = { revision: 1, credentialRef: null, credentialGeneration: 0, protocol: 'compatible_chat', routePolicy: {} };
    const store = {
        async getRecord(key) {
            if (key.id.startsWith('context:state:')) return { key, revision: 1, value: { kind: 'context_state', schemaVersion: 1,
                ...base.port.capture, effectiveModelFingerprint: base.config.modelFingerprint } };
            if (key.id.startsWith('context:candidate:')) {
                const candidate = base.port.candidates.get(key.id.slice('context:candidate:'.length));
                if (!candidate) return undefined;
                return { key, revision: 1, value: { ...candidate.snapshot, state: candidate.state,
                    pendingAttemptId: candidate.pendingRequest?.attemptId } };
            }
            return structuredClone(records.get(canonicalJson(key)));
        },
        async commitTransition(transition) {
            for (const expected of transition.expected) assert.equal(records.get(canonicalJson(expected.key))?.revision ?? null, expected.revision);
            for (const record of transition.records ?? []) records.set(canonicalJson(record.key), structuredClone(record));
            for (const content of transition.contents ?? []) contents.set(content.contentId, structuredClone(content.value));
        },
        async readContent(conversationId, contentId) { return structuredClone(contents.get(contentId)); },
    };
    const adapter = { version: 'fixture-v1', endpoint: () => 'fixture:in-memory' };
    const provider = {
        profiles: { async get() { return profile; } }, adapterFor: () => adapter,
        async prepareRequest(input) {
            if (options.prepareError) throw options.prepareError;
            const body = canonicalJson(input.view);
            const snapshot = { ...input.versions, rootBudgetId: input.rootBudgetId, body, bodyHash: hashBytes(body),
                profileRevision: 1, capabilityVersion: 'fixture-v1', deadlineAt: input.deadlineAt };
            prepared.push({ input, snapshot });
            return { adapter, snapshot, upperBound: { costMicros: 100, outputTokens: input.maxOutputTokens } };
        },
    };
    const model = new ProviderCompressionModelPort({ store, provider, journal: { async readAttempt(id) { return structuredClone(journal.get(id)); } },
        dispatcher: { async execute(selectedAdapter, snapshot, rootBudgetId, upperBound, dispatch) {
            const candidate = base.port.candidates.get(snapshot.compressionCandidateId);
            const request = candidate.pendingRequest;
            assert.equal(request.attemptId, dispatch.attemptId);
            sent.push(structuredClone(request));
            if (options.dispatchError) throw options.dispatchError;
            const invalid = options.invalidEveryOriginal ? !request.validationRepair : options.alwaysInvalid || (options.invalidFirst !== false && sent.length === 1);
            const value = invalid ? invalidDigest(request) : validDigest(request);
            if (sent.length > 1 && options.byteSource) value.unresolved = [{ quote: '重复要求。', source: {
                itemId: JSON.parse(request.chunk.body).targets[0].span.itemId, blockId: 'text', startByte: Buffer.byteLength('保留最终报告。重复要求。') } }];
            const response = { attemptId: dispatch.attemptId, providerResponseId: `response-${sent.length}`, complete: options.complete ?? true,
                stop: { kind: options.stop ?? 'completed' }, toolCalls: [], problems: [],
                blocks: [{ type: 'text', thought: true, text: 'internal fixture reasoning' }, { type: 'text', text: options.jsonFailure && sent.length === 1 ? '{'
                    : options.shapeFailure && sent.length === 1 ? JSON.stringify({ body: '', unresolved: null }) : JSON.stringify(value) }],
                usage: { inputTokens: 100, outputTokens: 20 }, raw: { body: JSON.stringify(value) } };
            journal.set(dispatch.attemptId, { state: options.journalState ?? 'committed', attempt: { attemptId: dispatch.attemptId, rootBudgetId, snapshot }, response });
            charges.set(dispatch.attemptId, { rootBudgetId, costMicros: 5, bodyHash: snapshot.bodyHash });
            options.afterResponse?.(base, request, response);
            return response;
        }, async lookup() { return { status: 'unknown' }; } } });
    base.model = model;
    base.compactor = new ContextCompactor({ port: base.port, sources: base.sources, model, ...(options.now ? { now: options.now } : {}) });
    return { ...base, sent, prepared, journal, charges, store };
}

test('completed invalid source gets one new persisted attempt, keeps both receipts and publishes locally', async () => {
    const value = fixture();
    const originals = canonicalJson(value.port.items);
    const { candidate } = await ready(value);
    assert.equal(value.sent.length, 2);
    const [first, repair] = value.sent;
    for (const field of ['attemptId', 'actionId', 'stepId']) assert.notEqual(first[field], repair[field]);
    assert.deepEqual(first.execution, repair.execution);
    assert.equal(first.chunk.body, repair.chunk.body);
    assert.equal(first.inputBodyHash, repair.inputBodyHash);
    assert.equal(repair.validationRepair.previousAttemptId, first.attemptId);
    assert.equal(repair.validationRepair.validationError, 'unresolved source ambiguous');
    assert.ok(!repair.validationRepair.previousResponse.includes('internal fixture reasoning'));
    assert.equal(candidate.failedResult.requestAttemptId, first.attemptId);
    assert.equal(candidate.validationRepair.failedResult.requestAttemptId, first.attemptId);
    assert.equal(candidate.chunks[0].inputBodyHash, first.inputBodyHash);
    assert.equal(value.journal.size, 2);
    assert.equal(value.charges.size, 2);
    assert.equal([...value.charges.values()].reduce((sum, charge) => sum + charge.costMicros, 0), 10);
    assert.notEqual(value.prepared[0].snapshot.bodyHash, value.prepared[1].snapshot.bodyHash);
    assert.notEqual(value.prepared[0].snapshot.nativeReplayHash, value.prepared[1].snapshot.nativeReplayHash);
    assert.ok(value.prepared[1].snapshot.body.includes('validationRepair'));
    await value.compactor.publish(value.port.capture.conversationId, 13);
    assert.equal(value.port.commits, 1);
    assert.equal(value.port.capture.viewRevision, 1);
    assert.equal(value.port.capture.view.nodes[0].unresolved[0].quote, originalText);
    assert.equal(canonicalJson(value.port.items), originals);
});

test('second invalid result stops after two attempts and keeps original failure', async () => {
    const value = fixture({ alwaysInvalid: true });
    await assert.rejects(ready(value, 'hard'), { code: 'CONTEXT_SOURCE_GAP', mayHaveStarted: false });
    const candidate = [...value.port.candidates.values()][0];
    assert.equal(value.sent.length, 2);
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.failedResult.requestAttemptId, value.sent[1].attemptId);
    assert.equal(candidate.validationRepair.failedResult.requestAttemptId, value.sent[0].attemptId);
    assert.equal(value.charges.size, 2);
    const restored = new ContextCompactor({ port: value.port, sources: value.sources, model: value.model });
    await assert.rejects(restored.recover(value.port.capture.conversationId, candidate.candidateId));
    assert.equal(value.sent.length, 2);
});

test('ordinary valid output remains one request', async () => {
    const value = fixture({ invalidFirst: false });
    const { candidate } = await ready(value);
    assert.equal(value.sent.length, 1);
    assert.equal(candidate.validationRepair, undefined);
    assert.equal(candidate.state, 'ready');
});

test('the entire candidate has one repair total even when a later chunk is also invalid', async () => {
    const value = fixture({ rounds: 5, invalidEveryOriginal: true });
    await assert.rejects(ready(value, 'hard'), { code: 'CONTEXT_SOURCE_GAP', mayHaveStarted: false });
    assert.equal(value.sent.length, 3);
    assert.equal(value.sent.filter(request => request.validationRepair).length, 1);
    assert.notEqual(value.sent[0].chunk.chunkId, value.sent[2].chunk.chunkId);
    const candidate = [...value.port.candidates.values()][0];
    assert.equal(candidate.chunks.length, 1);
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.validationRepair.failedResult.requestAttemptId, value.sent[0].attemptId);
});

test('complete malformed JSON can be repaired once', async () => {
    for (const options of [{ jsonFailure: true }, { shapeFailure: true }, { byteSource: true }]) {
        const value = fixture(options);
        const { candidate } = await ready(value);
        assert.equal(value.sent.length, 2);
        if (options.byteSource) assert.equal(candidate.chunks[0].digest.unresolved[0].source.startByte, Buffer.byteLength('保留最终报告。重复要求。'));
    }
});

test('repair pending saved before dispatch survives an interrupted save without a new paid attempt', async () => {
    const value = fixture();
    let interrupted = false;
    value.port.beforeSave = async candidate => {
        if (candidate.pendingRequest?.validationRepair && !interrupted) { interrupted = true; throw new Error('ordinary local save interruption'); }
    };
    await assert.rejects(ready(value));
    const candidate = [...value.port.candidates.values()][0];
    assert.equal(candidate.pendingRequest.attemptId, candidate.validationRepair.repairAttemptId);
    assert.equal(value.sent.length, 1);
    value.port.beforeSave = null;
    const restored = new ContextCompactor({ port: value.port, sources: value.sources, model: value.model });
    await assert.rejects(restored.recover(value.port.capture.conversationId, candidate.candidateId), { code: 'CONTEXT_ATTEMPT_NOT_ACCEPTED' });
    assert.equal(value.sent.length, 1);
    assert.ok((await value.port.getCandidate(value.port.capture.conversationId, candidate.candidateId)).validationRepair);
});

test('committed repair with a lost local reply is recovered from its original journal and reused without dispatch', async () => {
    let responses = 0;
    const value = fixture({ afterResponse() { if (++responses === 2) throw new Error('ordinary local reply interruption'); } });
    await assert.rejects(ready(value));
    const candidate = [...value.port.candidates.values()][0];
    assert.equal(candidate.state, 'unknown');
    assert.equal(candidate.pendingRequest.attemptId, candidate.validationRepair.repairAttemptId);
    const restored = new ContextCompactor({ port: value.port, sources: value.sources, model: value.model });
    const recovery = await restored.recover(value.port.capture.conversationId, candidate.candidateId);
    const recovered = recovery.completion ? await recovery.completion : recovery;
    assert.equal(recovered.state, 'ready');
    assert.equal(recovered.pendingRequest, null);
    assert.equal(value.sent.length, 2);
    assert.equal(value.charges.size, 2);
    assert.equal(recovered.chunks[0].inputBodyHash, value.sent[0].inputBodyHash);
    await restored.publish(value.port.capture.conversationId, 13);
    assert.equal(value.port.commits, 1);
});

test('unfinished, cancelled, unknown and ordinary quota failures add no repair request', async () => {
    for (const options of [{ complete: false }, { stop: 'cancelled' }, { journalState: 'unknown' },
        { dispatchError: new AgentFault('FIXTURE_UNKNOWN', 'ordinary unknown completion', {}, true) },
        { dispatchError: new TypeError('ordinary fixture type failure') },
        { prepareError: new AgentFault('ROOT_BUDGET_EXHAUSTED', 'ordinary quota exhausted') }]) {
        const value = fixture(options);
        await assert.rejects(ready(value));
        assert.ok(value.sent.length <= 1);
        assert.ok(![...value.port.candidates.values()][0].validationRepair);
    }
});

test('deadline and epoch are checked again before repair dispatch', async () => {
    let clock = Date.now();
    const expired = fixture({ now: () => clock, afterResponse(base) { clock = Date.parse(base.port.capture.execution.deadlineAt) + 1; } });
    await assert.rejects(ready(expired, 'hard'));
    assert.equal(expired.sent.length, 1);
    const changed = fixture({ afterResponse(base) { base.port.capture.execution.runEpoch++; } });
    await assert.rejects(ready(changed));
    assert.equal(changed.sent.length, 1);
});

test('optional offline original export remains strictly rejected with all 18 repeated byte positions', async () => {
    if (!process.env.VALIDATION_REPAIR_SOURCE) return;
    const source = JSON.parse(await readFile(process.env.VALIDATION_REPAIR_SOURCE, 'utf8'));
    const quote = source.digest.unresolved[1].quote;
    const target = source.chunk.targets.find(part => part.span.itemId === source.digest.unresolved[1].source.itemId);
    const positions = [];
    for (let offset = target.text.indexOf(quote); offset >= 0; offset = target.text.indexOf(quote, offset + 1)) positions.push(target.span.startByte + Buffer.byteLength(target.text.slice(0, offset)));
    assert.equal(positions.length, 18);
    assert.deepEqual(positions.slice(0, 3), [236, 392, 549]);
    assert.equal(positions.at(-1), 2899);
    assert.ok(!positions.includes(134));
    const value = fixture();
    const request = { attemptId: 'offline-original', chunk: { body: JSON.stringify(source.chunk), inputBodyHash: hashContext(source.chunk), sourceSpans: [] },
        snapshot: { effectiveModelFingerprint: 'offline', referenceBlocks: [], manifest: { rounds: [] } } };
    const result = value.model.result(request, { attemptId: request.attemptId, complete: true, stop: { kind: 'completed' },
        toolCalls: [], problems: [], blocks: [{ type: 'text', text: JSON.stringify(source.digest) }] }, { bodyHash: 'offline' });
    assert.equal(result.complete, false);
    assert.equal(result.usage.digestValidation, 'unresolved source ambiguous');
    console.log(JSON.stringify({ originalRepeatedQuotes: positions.length, startBytes: positions, strictValidation: result.usage.digestValidation, apiRequests: 0 }));
});
