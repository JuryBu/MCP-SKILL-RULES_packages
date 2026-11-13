import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { createCompressionChunks, generateCompaction, prepareCompaction, validateCompressionResult } from '../../../src/agent-server/context/compaction.ts';
import { hashBytes } from '../../../src/agent-server/context/config.ts';
import { applySemanticChunk, replaySemanticChunks, semanticTailInput } from '../../../src/agent-server/context/semantic-tail.ts';
import { projectHistoryContent } from '../../../src/agent-server/context/sources.ts';
import { sealSummaryNode } from '../../../src/agent-server/context/view.ts';
import { createFixture, fixtureConfig } from './context-fixtures.mjs';

const signal = () => new AbortController().signal;
const events = candidate => candidate.semanticTailReorganizations ?? (candidate.semanticTailReorganization ? [candidate.semanticTailReorganization] : []);
const lastEvent = candidate => events(candidate).at(-1);
const compactDigest = { body: 'Known facts, actual results and original retrieval identities retained.', skeleton: 'Verified facts and source index.',
    title: 'Bounded semantic continuation', unresolved: [], continuesPrevious: true };

function simulatedModel() {
    const calls = [];
    return { calls, async generate(request) {
        calls.push(structuredClone(request));
        assert.equal(request.maxOutputTokens, request.snapshot.config.model.maxOutputTokens);
        assert.equal(Buffer.byteLength(request.chunk.body), request.chunk.inputTokens);
        assert.ok(request.chunk.inputTokens <= request.snapshot.config.policy.chunkInputTokens);
        assert.equal(hashBytes(request.chunk.body), request.chunk.inputBodyHash);
        return { attemptId: request.attemptId, inputBodyHash: request.chunk.inputBodyHash,
            modelFingerprint: request.snapshot.effectiveModelFingerprint, complete: true,
            digest: structuredClone(compactDigest), usage: { simulated: true },
            coverage: request.chunk.sourceSpans.map(span => ({ span, status: span.purpose === 'nativeAnchor' ? 'anchorOnly' : 'complete', gaps: [] })) };
    } };
}

async function legacyFixture() {
    const fixture = createFixture({ rounds: 3, active: false, allowLarge: true, text: () => 'source fact '.repeat(7000),
        config: fixtureConfig({ policy: { chunkInputTokens: 16000, referenceTokens: 1000 } }) });
    const candidate = await prepareCompaction({ ...fixture, capture: fixture.port.capture, execution: fixture.port.capture.execution,
        reason: 'hard', signal: signal() });
    const chunks = createCompressionChunks({ snapshot: candidate.snapshot, sources: fixture.sources, signal: signal() });
    for (let index = 0; index < 3; index++) {
        const chunk = (await chunks.next()).value;
        assert.ok(chunk);
        candidate.chunks.push({ attemptId: `legacy-known-${index}`, inputBodyHash: chunk.inputBodyHash,
            modelFingerprint: candidate.snapshot.effectiveModelFingerprint, complete: true,
            digest: { ...structuredClone(compactDigest), body: 'fact '.repeat(1900), skeleton: 'index '.repeat(760) },
            usage: { simulated: true, alreadyCommitted: true }, chunkId: chunk.chunkId, roundId: chunk.roundId,
            sourceSpans: chunk.sourceSpans, anchors: chunk.anchors,
            coverage: chunk.sourceSpans.map(span => ({ span, status: span.purpose === 'nativeAnchor' ? 'anchorOnly' : 'complete', gaps: [] })) });
    }
    await chunks.return();
    return { ...fixture, candidate };
}

function generate(fixture, candidate = fixture.candidate, model = simulatedModel()) {
    return generateCompaction({ candidate, priorView: fixture.port.capture.view, port: fixture.port,
        sources: fixture.sources, model, signal: signal() });
}

test('SIMULATED: known oversized tail is reorganized once; all three old chunks and source offsets are reused', async () => {
    const fixture = await legacyFixture();
    const old = structuredClone(fixture.candidate.chunks);
    const model = simulatedModel();
    const candidate = await generate(fixture, fixture.candidate, model);
    assert.equal(candidate.state, 'ready');
    assert.deepEqual(candidate.chunks.slice(0, 3), old);
    assert.equal(model.calls.filter(request => request.chunk.roundId.startsWith('tail-reorganization:')).length, 1);
    const repaired = candidate.chunks.find(chunk => chunk.chunkId === lastEvent(candidate).chunkId);
    assert.ok(repaired);
    const normal = model.calls.filter(request => !request.chunk.roundId.startsWith('tail-reorganization:'));
    assert.ok(normal.length > 0);
    assert.ok(normal.every(request => request.chunk.sourceSpans.length > 0));
    for (const request of normal) for (const span of request.chunk.sourceSpans) {
        assert.ok(!old.some(chunk => chunk.sourceSpans.some(previous => previous.itemId === span.itemId && previous.blockId === span.blockId
            && previous.startByte < span.endByte && span.startByte < previous.endByte)));
    }
    const expected = replaySemanticChunks(fixture.port.capture.view.nodes, candidate.chunks.filter(chunk => !chunk.roundId.startsWith('tail-reorganization:')),
        candidate.snapshot, events(candidate), candidate.chunks);
    assert.deepEqual(candidate.nextView.nodes, expected);
    assert.deepEqual(candidate.coverage.gaps, []);
});

test('SIMULATED: JSON-persisted reorganization survives a new generator without replaying the repair or old requests', async () => {
    const fixture = await legacyFixture();
    let checkpoint;
    fixture.port.beforeSave = candidate => {
        if (!checkpoint && lastEvent(candidate) && !candidate.pendingRequest
            && candidate.chunks.some(chunk => chunk.chunkId === lastEvent(candidate).chunkId)) {
            checkpoint = JSON.stringify(candidate);
        }
    };
    const first = await generate(fixture);
    assert.ok(checkpoint);
    const cold = JSON.parse(checkpoint);
    const model = simulatedModel();
    fixture.port.beforeSave = null;
    const resumed = await generate(fixture, cold, model);
    assert.equal(resumed.state, 'ready');
    assert.ok(model.calls.length > 0);
    assert.ok(model.calls.every(request => !request.chunk.roundId.startsWith('tail-reorganization:')));
    assert.deepEqual(resumed.nextView, first.nextView);
    assert.deepEqual(resumed.chunks.slice(0, 4), first.chunks.slice(0, 4));
});

test('SIMULATED: an unknown original request blocks every new request and preserves its identity', async () => {
    const fixture = await legacyFixture();
    const unknown = { attemptId: 'unknown-original-do-not-resend', chunk: { chunkId: 'unknown-chunk' } };
    fixture.candidate.pendingRequest = structuredClone(unknown);
    const model = simulatedModel();
    await assert.rejects(generate(fixture, fixture.candidate, model), error => error.code === 'CONTEXT_ATTEMPT_UNKNOWN' && error.mayHaveStarted);
    assert.equal(model.calls.length, 0);
    assert.deepEqual(fixture.candidate.pendingRequest, unknown);
    assert.equal(fixture.candidate.state, 'unknown');
    assert.equal(fixture.candidate.chunks.length, 3);
});

test('SIMULATED: a new candidate keeps original chunk/request identities and the semantic checkpoint origin', async () => {
    const fixture = await legacyFixture();
    let checkpoint;
    fixture.port.beforeSave = candidate => {
        if (!checkpoint && lastEvent(candidate) && !candidate.pendingRequest
            && candidate.chunks.some(chunk => chunk.chunkId === lastEvent(candidate).chunkId)) checkpoint = JSON.stringify(candidate);
    };
    await generate(fixture);
    const retry = JSON.parse(checkpoint);
    const originalId = retry.candidateId;
    const originalChunks = structuredClone(retry.chunks);
    const originalRun = retry.snapshot.runId;
    retry.snapshot.retryOf = { candidateId: originalId, runId: originalRun, runEpoch: retry.snapshot.runEpoch,
        rootBudgetId: retry.snapshot.execution.rootBudgetId, sourceManifestHash: retry.snapshot.sourceManifestHash,
        sourcePrefixHash: retry.snapshot.sourcePrefixHash };
    retry.candidateId = 'new-candidate-with-original-known-progress';
    retry.snapshot.candidateId = retry.candidateId;
    retry.snapshot.semanticCandidateId = originalId;
    retry.snapshot.runId = 'new-maintenance-execution';
    retry.snapshot.execution.runId = retry.snapshot.runId;
    fixture.port.capture.execution.runId = retry.snapshot.runId;
    fixture.port.beforeSave = null;
    const model = simulatedModel();
    const result = await generate(fixture, retry, model);
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.chunks.slice(0, originalChunks.length), originalChunks);
    assert.equal(result.snapshot.retryOf.candidateId, originalId);
    assert.ok(model.calls.every(request => request.snapshot.candidateId === retry.candidateId && request.execution.runId !== originalRun));
    assert.ok(model.calls.every(request => !originalChunks.some(chunk => chunk.attemptId === request.attemptId || chunk.chunkId === request.chunk.chunkId)));
});

test('SIMULATED: new source chunk precedes tail reorganization and cold replay uses that exact position', async () => {
    const fixture = createFixture({ rounds: 5, active: false, text: () => 'source '.repeat(4000),
        config: fixtureConfig({ policy: { chunkInputTokens: 16000, referenceTokens: 8000 }, rules: 'Preserve facts.' }) });
    const first = fixture.port.items[0];
    const source = { itemId: first.itemId, blockId: 'text', startByte: 0, endByte: 5800,
        sha256: 'legacy-source', blockHash: 'legacy-source', purpose: 'target' };
    const node = sealSummaryNode({ kind: 'batch', nodeId: 'previous', firstSeq: 1, lastSeq: 2, roundIds: ['round-1'],
        sourceSpans: [], chunkIds: [], parentBatchIds: [], modelFingerprint: fixture.config.modelFingerprint,
        body: 'previous facts', skeleton: 'previous', title: 'previous', anchors: [],
        unresolved: [{ id: 'legacy-handoff', quote: 'q'.repeat(5800), source }] });
    fixture.port.capture.view = { ...fixture.port.capture.view, coveredEndSeq: 2, nodes: [node] };
    const candidate = await prepareCompaction({ ...fixture, capture: fixture.port.capture, execution: fixture.port.capture.execution,
        reason: 'hard', signal: signal() });
    const model = simulatedModel();
    const original = model.generate.bind(model);
    model.generate = async request => {
        const result = await original(request);
        if (model.calls.length === 1) result.digest.body = 'f'.repeat(5400);
        return result;
    };
    let checkpoint;
    fixture.port.beforeSave = current => {
        if (!checkpoint && lastEvent(current) && !current.pendingRequest
            && current.chunks.some(chunk => chunk.chunkId === lastEvent(current).chunkId)) checkpoint = JSON.stringify(current);
    };
    const result = await generate(fixture, candidate, model);
    assert.ok(checkpoint);
    assert.ok(!model.calls[0].chunk.roundId.startsWith('tail-reorganization:'));
    assert.equal(lastEvent(result).afterChunkId, result.chunks[0].chunkId);
    const cold = JSON.parse(checkpoint);
    fixture.port.beforeSave = null;
    const resumed = await generate(fixture, cold);
    assert.deepEqual(resumed.nextView, result.nextView);
});

test('SIMULATED: oversized known repair output is retained and never retried', async () => {
    const fixture = await legacyFixture();
    const model = simulatedModel();
    const original = model.generate.bind(model);
    model.generate = async request => ({ ...await original(request), digest: { ...compactDigest, body: 'oversized '.repeat(2000) } });
    await assert.rejects(generate(fixture, fixture.candidate, model), error => error.details?.digestBudgetExceeded === true && !error.mayHaveStarted);
    assert.equal(fixture.candidate.pendingRequest, null);
    assert.ok(fixture.candidate.failedResult.complete);
    assert.equal(model.calls.length, 1);
    await assert.rejects(generate(fixture, fixture.candidate, model), error => error.code === 'CONTEXT_CONFIG_INVALID');
    assert.equal(model.calls.length, 1);
});

test('SIMULATED: exact minimum source header is checked even when the empty complete body fits', async () => {
    const fixture = await legacyFixture();
    const snapshot = fixture.candidate.snapshot;
    const block = snapshot.manifest.blocks.find(entry => entry.kind === 'text');
    const tail = { nodeId: 'minimum-header-tail', hash: 'minimum-header-hash', firstSeq: 1, lastSeq: 1,
        roundIds: [block.roundId], body: '', skeleton: 'index', title: 'title', sourceSpanCount: 0, anchorCount: 0,
        retrieval: { nodeId: 'minimum-header-tail', hash: 'minimum-header-hash' }, continuesPreviousRequired: true };
    const base = createCompressionChunks({ snapshot, sources: fixture.sources, blocks: [block], semanticTail: () => tail, signal: signal() });
    const payload = JSON.parse((await base.next()).value.body);
    await base.return();
    payload.targets = [];
    payload.anchors = [];
    const emptyBytes = Buffer.byteLength(canonicalJson(payload));
    tail.body = 'x'.repeat(snapshot.config.policy.chunkInputTokens - emptyBytes - 1);
    let preparations = 0;
    let observedMinimum = 0;
    const chunks = createCompressionChunks({ snapshot, sources: fixture.sources, blocks: [block], semanticTail: () => tail, signal: signal(),
        async prepareChunk(roundId, actualTokens, limit) {
            if (actualTokens > limit) { preparations++; observedMinimum = actualTokens; tail.body = 'bounded'; }
        } });
    const first = (await chunks.next()).value;
    await chunks.return();
    assert.equal(preparations, 1);
    assert.ok(observedMinimum > snapshot.config.policy.chunkInputTokens);
    assert.ok(first.sourceSpans[0].endByte > first.sourceSpans[0].startByte);
    assert.ok(first.inputTokens <= snapshot.config.policy.chunkInputTokens);
});

test('SIMULATED: strict reorganization result includes every reorganized field in its length check', () => {
    const request = { attemptId: 'bounded', chunk: { inputBodyHash: 'same', sourceSpans: [], digestByteLimit: 200 },
        snapshot: { effectiveModelFingerprint: 'model' } };
    const result = { attemptId: 'bounded', inputBodyHash: 'same', modelFingerprint: 'model', complete: true,
        digest: structuredClone(compactDigest), coverage: [], usage: null };
    validateCompressionResult(request, result);
    result.digest.reorganizedTail = { body: 'extra '.repeat(100), skeleton: 'old index', title: 'old' };
    assert.throws(() => validateCompressionResult(request, result), error => error.details?.digestBudgetExceeded === true);
});

test('RECORDED FAILURE + SIMULATED MODEL: original three chunks advance past the 16093/16000 stop',
    { skip: !process.env.SANDBOX_CONTEXT_FAILURE_SNAPSHOT }, async context => {
    const root = process.env.SANDBOX_CONTEXT_FAILURE_SNAPSHOT;
    const original = JSON.parse(await readFile(join(root, '压缩候选内部快照_run1.json'), 'utf8'));
    const failure = JSON.parse(await readFile(join(root, '失败现场_run1.json'), 'utf8'));
    const requests = JSON.parse(await readFile(join(root, '压缩原请求与响应_run1.json'), 'utf8'));
    const candidate = structuredClone(original.candidate);
    const snapshot = candidate.snapshot;
    const oldChunks = structuredClone(candidate.chunks);
    let oldNodes = [];
    for (const chunk of oldChunks) oldNodes = applySemanticChunk(oldNodes, chunk, snapshot);
    const committed = requests.attempts.filter(attempt => attempt.state === 'committed');
    const body = committed[2].snapshot.body;
    const providerBody = typeof body === 'string' ? JSON.parse(body) : body;
    const previousPayload = JSON.parse(providerBody.messages.find(message => message.role === 'user').content);
    const oldStatic = Buffer.byteLength(canonicalJson({ ...previousPayload, targets: [], anchors: [],
        semanticTail: semanticTailInput(oldNodes, oldChunks.at(-1).roundId) }));
    assert.equal(oldStatic, 16093);
    const neededItems = new Set([...snapshot.manifest.blocks, ...snapshot.referenceBlocks].map(block => block.itemId));
    if (process.env.SANDBOX_CONTEXT_FAILURE_STORE) for (const item of failure.items.filter(entry => neededItems.has(entry.itemId)
        && entry.value === undefined && entry.objectRef)) {
        const content = await readFile(join(process.env.SANDBOX_CONTEXT_FAILURE_STORE, 'objects', item.objectRef.hash.slice(0, 2), item.objectRef.hash));
        assert.equal(content.length, item.objectRef.rawBytes);
        assert.equal(hashBytes(content), item.objectRef.hash);
        item.value = JSON.parse(content.toString('utf8'));
    }
    const bytes = new Map(failure.items.filter(item => item.value !== undefined).flatMap(item => projectHistoryContent(item, item.value)
        .map(block => [`${item.itemId}:${block.blockId}`, block.bytes])));
    for (const block of snapshot.manifest.blocks) assert.equal(hashBytes(bytes.get(`${block.itemId}:${block.blockId}`)), block.sha256);
    const sources = { async describe() { return snapshot.manifest.blocks; }, async read(request) {
        return bytes.get(`${request.block.itemId}:${request.block.blockId}`).subarray(request.startByte, request.endByte);
    } };
    const priorView = { revision: snapshot.parentViewRevision, historyEpoch: snapshot.historyEpoch, coveredEndSeq: 0, nodes: [] };
    const saved = [];
    const capture = { historyEpoch: snapshot.historyEpoch, viewRevision: snapshot.parentViewRevision,
        appendSeq: snapshot.snapshotAppendSeq, compressionGeneration: snapshot.compressionGeneration,
        effectiveModelFingerprint: snapshot.effectiveModelFingerprint, execution: snapshot.execution };
    const port = { async inspect() { return structuredClone(capture); }, async saveCandidate(value) { saved.push(JSON.stringify(value)); } };
    candidate.state = 'generating';
    candidate.error = null;
    const model = simulatedModel();
    const result = await generateCompaction({ candidate, priorView, port, sources, model, signal: signal(), now: () => Date.parse(snapshot.createdAt) });
    assert.equal(result.state, 'ready');
    assert.deepEqual(result.chunks.slice(0, 3), oldChunks);
    assert.deepEqual(result.coverage.gaps, []);
    const repairs = model.calls.filter(request => request.chunk.roundId.startsWith('tail-reorganization:'));
    assert.equal(repairs.length, 1);
    const next = model.calls.find(request => !request.chunk.roundId.startsWith('tail-reorganization:'));
    assert.equal(next.chunk.sourceSpans[0].blockId, 'response.toolCalls.0');
    assert.equal(next.chunk.sourceSpans[0].startByte, 200);
    const checkpoint = JSON.parse(saved.find(value => {
        const entry = JSON.parse(value);
        return lastEvent(entry) && !entry.pendingRequest && entry.chunks.length === 4;
    }));
    const coldModel = simulatedModel();
    const cold = await generateCompaction({ candidate: checkpoint, priorView, port, sources, model: coldModel, signal: signal(),
        now: () => Date.parse(snapshot.createdAt) });
    assert.deepEqual(cold.nextView, result.nextView);
    assert.ok(coldModel.calls.every(request => !request.chunk.roundId.startsWith('tail-reorganization:')));
    context.diagnostic(JSON.stringify({ evidence: 'original snapshot and bytes; model responses simulated; no production resume',
        oldStatic, inputLimit: snapshot.config.policy.chunkInputTokens, oldChunksReused: 3,
        repairInput: repairs[0].chunk.inputTokens, newSourceStart: 200, requestCount: model.calls.length,
        nextInput: next.chunk.inputTokens, coverageGaps: result.coverage.gaps.length, coldViewEqual: true }));
});

test('SIMULATED: oversized successful normal results retain source progress and each new tail gets one persisted reorganization', async () => {
    const fixture = await legacyFixture();
    const model = simulatedModel();
    const original = model.generate.bind(model);
    model.generate = async request => {
        const result = await original(request);
        if (!request.chunk.roundId.startsWith('tail-reorganization:')) {
            assert.equal(request.chunk.digestByteLimit, undefined);
            result.digest.body = 'f'.repeat(5400);
        }
        return result;
    };
    let checkpoint;
    fixture.port.beforeSave = candidate => {
        if (events(candidate).length > 1 && !candidate.pendingRequest
            && candidate.chunks.some(chunk => chunk.chunkId === lastEvent(candidate).chunkId)) checkpoint = JSON.stringify(candidate);
    };
    const result = await generate(fixture, fixture.candidate, model);
    assert.equal(result.state, 'ready');
    assert.ok(events(result).length > 1);
    assert.equal(new Set(events(result).map(event => `${event.afterChunkId}:${event.nodeId}`)).size, events(result).length);
    assert.ok(result.chunks.some(chunk => !chunk.roundId.startsWith('tail-reorganization:') && chunk.digest.body.length === 5400));
    assert.ok(checkpoint);
    const coldModel = simulatedModel();
    const coldGenerate = coldModel.generate.bind(coldModel);
    coldModel.generate = async request => {
        const value = await coldGenerate(request);
        if (!request.chunk.roundId.startsWith('tail-reorganization:')) value.digest.body = 'f'.repeat(5400);
        return value;
    };
    fixture.port.beforeSave = null;
    const cold = await generate(fixture, JSON.parse(checkpoint), coldModel);
    assert.deepEqual(cold.nextView, result.nextView);
    for (const event of events(JSON.parse(checkpoint))) assert.ok(!coldModel.calls.some(request => request.chunk.chunkId === event.chunkId));
});
