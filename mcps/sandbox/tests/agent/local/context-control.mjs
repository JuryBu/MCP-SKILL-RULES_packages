import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { ContextCompactor, ContextFault, computeContextLimits, createHistorySourcePort, hashContext, renderSummary,
    sealSummaryNode, validateSummaryNodes, computeConversationContextLimits } from '../../../src/agent-server/context/index.ts';
import { createFixture, estimate, fixtureConfig, ready } from './context-fixtures.mjs';

function oldBatch(ordinal, requirements = [], bodySize = 20) {
    return sealSummaryNode({ kind: 'batch', nodeId: `old-batch-${ordinal}`, firstSeq: ordinal * 2 - 1, lastSeq: ordinal * 2,
        roundIds: [`round-${ordinal}`], sourceSpans: [], chunkIds: [], parentBatchIds: [], modelFingerprint: 'fixture-old-model',
        anchors: [], body: `old fixture ${ordinal} ${'normal '.repeat(bodySize)}`, skeleton: `old skeleton ${ordinal}`,
        title: `old title ${ordinal}`, unresolved: requirements });
}

async function waitReady(compactor, conversationId) {
    for (let ordinal = 0; ordinal < 200; ordinal++) {
        const state = await compactor.context(conversationId);
        if (state.candidate?.state === 'ready') return state.candidate;
        if (state.candidate?.state === 'failed' || state.candidate?.state === 'unknown') assert.fail(JSON.stringify(state.candidate.error));
        await delay(1);
    }
    assert.fail('fixture candidate did not become ready');
}

test('deterministic head/tail, middle skeleton and oldest-middle title levels are byte-stable', () => {
    const nodes = Array.from({ length: 26 }, (_, index) => oldBatch(index + 1));
    const config = fixtureConfig();
    const first = renderSummary(nodes, config.policy);
    const second = renderSummary(structuredClone(nodes), config.policy);
    assert.equal(first.text, second.text);
    assert.equal(first.hash, second.hash);
    assert.deepEqual(first.levels.slice(0, 2).map(level => level.level), ['body', 'body']);
    assert.equal(first.levels.at(-1).level, 'body');
    assert.equal(first.levels[2].level, 'title');
    assert.equal(first.levels[5].level, 'skeleton');
    const tiny = renderSummary(nodes, config.policy, 6500);
    assert.ok(tiny.tokens <= 6500);
    assert.ok(tiny.text.includes('read=summary:old-batch-26'));
});

test('folding uses the same injected model port, keeps original child hashes and limits the active view to eight nodes', async () => {
    const fixture = createFixture({ rounds: 30, active: false });
    const originalNodes = Array.from({ length: 25 }, (_, index) => oldBatch(index + 1));
    const original = canonicalJson(originalNodes);
    fixture.port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 50, nodes: originalNodes };
    fixture.port.capture.viewRevision = 1;
    const { candidate } = await ready(fixture);
    assert.equal(candidate.folds.length, 1);
    assert.equal(candidate.nextView.nodes.length, 8);
    assert.ok(fixture.model.calls.some(request => request.reason === 'fold'));
    assert.ok(fixture.model.calls.every(request => request.execution.rootBudgetId === fixture.port.capture.execution.rootBudgetId));
    assert.deepEqual(candidate.folds[0].children[0], { nodeId: 'old-batch-3', hash: originalNodes[2].hash, firstSeq: 5, lastSeq: 6 });
    assert.equal(candidate.folds[0].children.at(-1).nodeId, 'old-batch-21');
    assert.equal(canonicalJson(originalNodes), original);
    validateSummaryNodes(candidate.nextView.nodes);
    assert.ok(candidate.folds[0].chunkIds.length > 0);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 13);
    assert.equal(fixture.port.capture.view.coveredEndSeq, 56);
    assert.equal(fixture.port.items.length, 60);
});

test('an unresolved requirement keeps its original quote and item/block anchor through new batches and folded views', async () => {
    const fixture = createFixture({ rounds: 30, active: false });
    const anchor = { itemId: 'old-requirement-item', blockId: 'text', startByte: 0, endByte: 24,
        sha256: 'a'.repeat(64), blockHash: 'b'.repeat(64), purpose: 'target' };
    const requirement = { id: 'unresolved-fixture-request', quote: 'Keep this exact old request', source: anchor };
    fixture.port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 50,
        nodes: Array.from({ length: 25 }, (_, index) => oldBatch(index + 1, index === 3 ? [requirement] : [])) };
    fixture.port.capture.viewRevision = 1;
    const { candidate } = await ready(fixture);
    const view = renderSummary(candidate.nextView.nodes, fixture.config.policy);
    assert.equal(view.text.split(requirement.quote).length - 1, 1);
    assert.ok(view.text.includes('old-requirement-item'));
    assert.deepEqual(candidate.batch.unresolved[0], requirement);
    assert.deepEqual(candidate.folds[0].unresolved[0], requirement);
});

test('an oversized mandatory unresolved quote remains intact when background compression pauses without publication', async () => {
    const fixture = createFixture();
    const requirement = { id: 'long-fixture-requirement', quote: 'normal requirement '.repeat(3000), source: {
        itemId: 'original', blockId: 'text', startByte: 0, endByte: 1, sha256: 'a'.repeat(64), blockHash: 'b'.repeat(64), purpose: 'target' } };
    fixture.port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 2, nodes: [oldBatch(1, [requirement])] };
    fixture.port.capture.viewRevision = 1;
    const priorView = structuredClone(fixture.port.capture.view);
    const { candidate } = await ready(fixture);
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.error.code, 'CONTEXT_SUMMARY_BUDGET');
    assert.equal(fixture.model.calls.length, 2);
    assert.equal(fixture.port.commits, 0);
    assert.deepEqual(fixture.port.capture.view, priorView);
    const limits = computeContextLimits(fixture.config.model.contextWindow, fixture.config.model.maxOutputTokens, fixture.config.policy);
    await fixture.compactor.postStep({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, limits, stepSeq: 14, estimate: estimate(limits.inputBudget) });
    assert.equal(fixture.model.calls.length, 2);
    await assert.rejects(fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, limits, stepSeq: 15,
        estimate: async () => estimate(limits.inputBudget) }), { code: 'CONTEXT_SUMMARY_BUDGET' });
    const callsAfterHardFailure = fixture.model.calls.length;
    await assert.rejects(fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, limits, stepSeq: 16,
        estimate: async () => estimate(limits.inputBudget) }), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.equal(fixture.model.calls.length, callsAfterHardFailure);
});

test('new unresolved quotes are checked against exact source bytes and retained in the published summary', async () => {
    const fixture = createFixture({ text: ordinal => ordinal === 1 ? 'Keep the exact fixture requirement' : `ordinary fixture ${ordinal}` });
    fixture.model.onGenerate = async (request, signal, result) => {
        if (request.chunk.roundId === 'round-1') {
            const source = JSON.parse(request.chunk.body).targets.find(part => part.span.itemId === 'user-1');
            result.digest.unresolved.push({ id: 'new-fixture-requirement', quote: source.text, source: source.span });
        }
        return result;
    };
    const { candidate } = await ready(fixture);
    assert.equal(candidate.batch.unresolved[0].quote, 'Keep the exact fixture requirement');
    assert.ok(renderSummary(candidate.nextView.nodes, fixture.config.policy).text.includes('Keep the exact fixture requirement'));
});

test('a complete but invalid digest is retained as a known failed result, without labeling the attempt as unknown or retrying', async () => {
    const fixture = createFixture();
    fixture.model.onGenerate = async (request, signal, result) => ({ ...result, digest: { ...result.digest, body: '' } });
    await assert.rejects(ready(fixture), { code: 'CONTEXT_SOURCE_GAP' });
    const state = await fixture.compactor.context(fixture.port.capture.conversationId);
    assert.equal(state.candidate.state, 'failed');
    assert.equal(state.candidate.pendingRequest, null);
    assert.equal(state.candidate.failedResult.complete, true);
    assert.equal(fixture.model.calls.length, 1);
});

test('two immediate post-publication retriggers break only BPC and explicit restart clears the circuit', async () => {
    const fixture = createFixture();
    await ready(fixture);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 13);
    fixture.port.capture.rounds.at(-1).complete = true;
    fixture.port.appendRound('first new active tail', { active: true });
    const limits = computeContextLimits(128000, 2048, fixture.config.policy);
    await fixture.compactor.postStep({ conversationId: fixture.port.capture.conversationId, config: fixture.config, execution: fixture.port.capture.execution,
        stepSeq: 13, limits, estimate: estimate(90000) });
    await waitReady(fixture.compactor, fixture.port.capture.conversationId);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 14);
    fixture.port.capture.rounds.at(-1).complete = true;
    fixture.port.appendRound('second new active tail', { active: true });
    const count = fixture.model.calls.length;
    const result = await fixture.compactor.postStep({ conversationId: fixture.port.capture.conversationId, config: fixture.config, execution: fixture.port.capture.execution,
        stepSeq: 14, limits, estimate: estimate(90000) });
    assert.equal(result.backgroundCandidateId, null);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'circuitBroken');
    assert.equal(fixture.model.calls.length, count);
    await fixture.compactor.restart(fixture.port.capture.conversationId);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'idle');
});

test('generating recovery looks up the original attempt and resumes later chunks without resending the completed chunk', async () => {
    const fixture = createFixture();
    fixture.model.onGenerate = async (request, signal, result) => {
        fixture.model.results.set(request.attemptId, result);
        throw new ContextFault('ATTEMPT_UNKNOWN', 'fixture reply lost before context persistence', { attemptId: request.attemptId }, true);
    };
    await assert.rejects(ready(fixture), { code: 'CONTEXT_ATTEMPT_UNKNOWN' });
    const candidateId = fixture.port.capture.candidateId;
    const firstAttempt = fixture.model.calls[0].attemptId;
    fixture.model.onGenerate = null;
    const sources = createHistorySourcePort(fixture.port, { conversationId: fixture.port.capture.conversationId });
    const recovered = new ContextCompactor({ port: fixture.port, sources, model: fixture.model });
    const handle = await recovered.recover(fixture.port.capture.conversationId, candidateId);
    const candidate = await handle.completion;
    assert.equal(candidate.state, 'ready');
    assert.deepEqual(fixture.model.lookups, [firstAttempt]);
    assert.equal(fixture.model.calls.filter(call => call.attemptId === firstAttempt).length, 1);
    assert.equal(fixture.model.calls.length, 3);
    assert.equal(candidate.coverage.coveredEndSeq, 6);
});

test('unknown recovered attempt never adds a new model request; proved notAccepted becomes restartable failed state', async () => {
    const fixture = createFixture();
    fixture.model.onGenerate = async (request, signal, result) => { throw new ContextFault('ATTEMPT_UNKNOWN', 'fixture unknown result', { attemptId: request.attemptId }, true); };
    await assert.rejects(ready(fixture), { code: 'CONTEXT_ATTEMPT_UNKNOWN' });
    fixture.model.lookupStatus = 'unknown';
    const recovered = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model });
    await assert.rejects(recovered.recover(fixture.port.capture.conversationId, fixture.port.capture.candidateId), { code: 'CONTEXT_ATTEMPT_UNKNOWN' });
    assert.equal(fixture.model.calls.length, 1);
    fixture.model.lookupStatus = 'notAccepted';
    await assert.rejects(recovered.recover(fixture.port.capture.conversationId, fixture.port.capture.candidateId),
        error => error.code === 'CONTEXT_ATTEMPT_NOT_ACCEPTED' && error.mayHaveStarted === false);
    await recovered.restart(fixture.port.capture.conversationId);
    assert.equal((await recovered.context(fixture.port.capture.conversationId)).scheduler.state, 'idle');
    assert.equal(fixture.model.calls.length, 1);
});

test('publication with lost reply and unavailable first receipt recovers the committed revision, not another publication', async () => {
    const fixture = createFixture();
    const { candidate } = await ready(fixture);
    fixture.port.losePublicationResponse = true;
    fixture.port.hideReceipts = true;
    await assert.rejects(fixture.compactor.publish(fixture.port.capture.conversationId, 13), { code: 'CONTEXT_COMMIT_UNKNOWN' });
    assert.equal(fixture.port.commits, 1);
    fixture.port.hideReceipts = false;
    const recovered = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model });
    const result = await recovered.recover(fixture.port.capture.conversationId, candidate.candidateId);
    assert.equal(result.state, 'published');
    assert.equal(result.publishedViewRevision, 1);
    assert.equal(fixture.port.commits, 1);
    assert.equal((await recovered.context(fixture.port.capture.conversationId)).scheduler.state, 'idle');
});

test('cancellation during snapshot construction prevents the first model request', async () => {
    const fixture = createFixture();
    const original = fixture.sources.describe;
    let unblock;
    fixture.sources.describe = async (...args) => {
        if (!unblock) await new Promise(resolve => { unblock = resolve; });
        return original(...args);
    };
    const starting = fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background' });
    while (!unblock) await delay(1);
    const result = await fixture.compactor.cancel(fixture.port.capture.conversationId);
    assert.equal(result.state, 'cancelled');
    unblock();
    await assert.rejects(starting, { code: 'CONTEXT_CANCELLED' });
    assert.equal(fixture.model.calls.length, 0);
});

test('root cleanup publishes an already ready candidate without creating another run or model attempt', async () => {
    const fixture = createFixture();
    await ready(fixture);
    const count = fixture.model.calls.length;
    const root = structuredClone(fixture.port.capture.execution);
    const cleanup = await fixture.compactor.finishExecution(fixture.port.capture.conversationId, root, 13);
    assert.equal(cleanup.state, 'released');
    assert.equal(fixture.port.commits, 1);
    assert.equal(fixture.model.calls.length, count);
    assert.deepEqual(fixture.port.capture.execution, root);
});

test('normal root completion waits for its in-flight background result and publishes without cancellation', async () => {
    const fixture = createFixture();
    let release;
    fixture.model.onGenerate = async (request, signal, result) => {
        if (!release) await new Promise(resolve => { release = resolve; });
        return result;
    };
    fixture.model.cancelStatus = 'unknown';
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background' });
    while (!release) await delay(1);
    let finished = false;
    const cleanup = fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution, 13)
        .then(result => { finished = true; return result; });
    try {
        await delay(5);
        assert.equal(finished, false, 'normal completion must wait instead of cancelling a pending request');
    } finally { release(); }
    await handle.completion;
    assert.deepEqual(await cleanup, { state: 'released', candidateId: handle.candidateId });
    assert.equal(fixture.port.commits, 1);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.lastFailure, null);
});

for (const interruption of ['abort', 'deadline']) test(`normal root wait preserves an unknown attempt after ${interruption}`, async () => {
    const fixture = createFixture();
    let release;
    fixture.model.onGenerate = async (request, signal, result) => {
        await new Promise(resolve => { release = resolve; });
        return result;
    };
    fixture.model.cancelStatus = 'unknown';
    if (interruption === 'deadline') fixture.port.capture.execution.deadlineAt = new Date(Date.now() + 150).toISOString();
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background' });
    while (!release) await delay(1);
    const abort = new AbortController();
    const cleanup = fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution, 13, { signal: abort.signal });
    if (interruption === 'abort') abort.abort();
    const result = await cleanup;
    assert.deepEqual(result, { state: 'unconfirmed', candidateId: handle.candidateId });
    const status = await fixture.compactor.context(fixture.port.capture.conversationId);
    assert.equal(status.candidate.pendingRequest.attemptId, fixture.model.calls[0].attemptId);
    assert.equal(status.candidate.state, 'unknown');
    assert.equal(fixture.port.commits, 0);
    assert.equal(fixture.model.calls.length, 1);
    release();
    await assert.rejects(handle.completion, { code: 'CONTEXT_CANCELLED' });
});

test('normal root completion waits through snapshot construction instead of cancelling it', async () => {
    const fixture = createFixture();
    const describe = fixture.sources.describe;
    let unblock;
    fixture.sources.describe = async (...args) => {
        if (!unblock) await new Promise(resolve => { unblock = resolve; });
        return describe(...args);
    };
    const starting = fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background' });
    while (!unblock) await delay(1);
    let finished = false;
    const cleanup = fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution, 13)
        .then(result => { finished = true; return result; });
    try { await delay(5); assert.equal(finished, false); }
    finally { unblock(); }
    await (await starting).completion;
    assert.equal((await cleanup).state, 'released');
    assert.equal(fixture.port.commits, 1);
    assert.equal(fixture.model.cancellations.length, 0);
});

test('a small local window with one complete and one active human round reports the protected-round limit before claiming or generating', async () => {
    const config = fixtureConfig({ policy: { localContextWindowTokens: 32768 } });
    const fixture = createFixture({ config });
    fixture.port.items = fixture.port.items.filter(item => item.seq <= 4);
    fixture.port.capture.rounds = fixture.port.capture.rounds.slice(0, 2);
    fixture.port.capture.rounds[1].complete = false;
    fixture.port.capture.activeRoundId = fixture.port.capture.rounds[1].roundId;
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    fixture.port.capture.appendSeq = 4;
    fixture.port.capture.stepSeq = 4;
    const generation = fixture.port.capture.compressionGeneration;
    await assert.rejects(fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId, config,
        execution: fixture.port.capture.execution, stepSeq: 4, limits: computeConversationContextLimits(128000, 4096, config.policy),
        estimate: async () => ({ ...estimate(40000), confidence: 'conservative' }) }), error => error.code === 'CONTEXT_ACTIVE_ROUND_TOO_LARGE'
            && error.details.inputTokens === 40000 && error.details.inputBudget === 27648
            && error.details.keepCompleteRounds === 2 && error.details.retainedRoundIds.length === 2
            && error.details.limits.providerContextWindow === 128000 && error.details.estimateConfidence === 'conservative');
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.port.capture.compressionGeneration, generation);
    assert.equal(fixture.port.capture.viewRevision, 0);
});

test('root cleanup cancels snapshot construction before its first model request without starting a human cooldown', async () => {
    const fixture = createFixture();
    const describe = fixture.sources.describe;
    let unblock;
    fixture.sources.describe = async (...args) => {
        if (!unblock) await new Promise(resolve => { unblock = resolve; });
        return describe(...args);
    };
    const starting = fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background' });
    while (!unblock) await delay(1);
    const cleanup = await fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution, 12, { publishReady: false });
    assert.deepEqual(cleanup, { state: 'released', candidateId: null });
    unblock();
    await assert.rejects(starting, { code: 'CONTEXT_CANCELLED' });
    assert.equal(fixture.model.calls.length, 0);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.cooldownUntil, null);
});

test('root cleanup exposes unconfirmed cancellation and keeps the original pending attempt for lookup', async () => {
    const fixture = createFixture();
    let release;
    fixture.model.onGenerate = async (request, signal, result) => {
        await new Promise(resolve => { release = resolve; });
        return result;
    };
    fixture.model.cancelStatus = 'unknown';
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background' });
    while (!release) await delay(1);
    const attemptId = fixture.model.calls[0].attemptId;
    const cleanup = await fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution, 12, { publishReady: false });
    assert.deepEqual(cleanup, { state: 'unconfirmed', candidateId: handle.candidateId });
    const state = await fixture.compactor.context(fixture.port.capture.conversationId);
    assert.equal(state.scheduler.state, 'hardPaused');
    assert.equal(state.candidate.pendingRequest.attemptId, attemptId);
    release();
    await assert.rejects(handle.completion, { code: 'CONTEXT_CANCELLED' });
    assert.equal(fixture.model.calls.length, 1);
});

test('each compression chunk has an independent logical model step and stale run epochs stop the next chunk', async () => {
    const fixture = createFixture();
    await ready(fixture);
    assert.equal(new Set(fixture.model.calls.map(call => call.stepId)).size, fixture.model.calls.length);
    const stale = createFixture();
    stale.model.onGenerate = async (request, signal, result) => {
        stale.port.capture.execution.runEpoch++;
        return result;
    };
    await assert.rejects(ready(stale), { code: 'CONTEXT_HISTORY_STALE' });
    assert.equal(stale.model.calls.length, 1);
    assert.equal(stale.port.commits, 0);
});

test('one quota error persists the model-request stop across restart controls without switching ports', async () => {
    const fixture = createFixture();
    fixture.model.onGenerate = async () => { throw new ContextFault('QUOTA_EXCEEDED', 'fixture account quota exhausted', { httpStatus: 402 }); };
    await assert.rejects(ready(fixture), { code: 'CONTEXT_QUOTA_EXCEEDED' });
    await assert.rejects(fixture.compactor.restart(fixture.port.capture.conversationId), { code: 'CONTEXT_MODEL_REQUESTS_STOPPED' });
    assert.equal(fixture.model.calls.length, 1);
    const recovered = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model });
    await assert.rejects(recovered.restart(fixture.port.capture.conversationId), { code: 'CONTEXT_MODEL_REQUESTS_STOPPED' });
    assert.equal(fixture.model.calls.length, 1);
});

test('native media anchors remain visible and retrievable even when summary body levels are reduced', () => {
    const original = oldBatch(1);
    const { hash, ...content } = original;
    const node = sealSummaryNode({ ...content, anchors: [{ itemId: 'fixture-media', blockId: 'native-image', contentId: 'fixture-media-content',
        seq: 1, roundId: 'round-1', kind: 'nativeAnchor', byteLength: 20, sha256: 'a'.repeat(64), mediaType: 'image/png',
        retrieval: { contentId: 'fixture-media-content', nativeType: 'image' } }] });
    const rendered = renderSummary([node], fixtureConfig().policy);
    assert.ok(rendered.text.includes('fixture-media-content'));
    assert.ok(rendered.text.includes('native-image'));
    assert.throws(() => renderSummary([node], fixtureConfig().policy, 10), { code: 'CONTEXT_SUMMARY_BUDGET' });
});

test('a repeated manual request cannot finish an already owned maintenance run', async () => {
    const finished = [];
    const fixture = createFixture({ active: false, maintenance: {
        async createRun() { assert.fail('the existing maintenance run must be reused'); },
        async finishRun(input) { finished.push(input); },
    } });
    fixture.port.capture.execution.kind = 'maintenance';
    fixture.port.capture.execution.roundId = null;
    let release;
    fixture.model.onGenerate = async (request, signal, result) => {
        await new Promise(resolveHeld => { release = resolveHeld; });
        return result;
    };
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, reason: 'manual' });
    while (!release) await delay(1);
    await assert.rejects(fixture.compactor.manual({ conversationId: fixture.port.capture.conversationId, config: fixture.config }), { code: 'CONTEXT_COMPACTION_BUSY' });
    assert.equal(finished.length, 0);
    await fixture.compactor.cancel(fixture.port.capture.conversationId);
    release();
    await assert.rejects(handle.completion, { code: 'CONTEXT_CANCELLED' });
    assert.equal(finished.length, 1);
    assert.equal(finished[0].result, 'cancelled');
});

test('normal closing cleanup discards a ready candidate without publishing or generating more content', async () => {
    const fixture = createFixture();
    const { candidate } = await ready(fixture);
    const requests = fixture.model.calls.length;
    const cleanup = await fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution, 13, { publishReady: false });
    assert.deepEqual(cleanup, { state: 'released', candidateId: candidate.candidateId });
    assert.equal(fixture.port.capture.viewRevision, 0);
    assert.equal(fixture.port.commits, 0);
    assert.equal(fixture.model.calls.length, requests);
    assert.equal(fixture.port.candidates.get(candidate.candidateId).state, 'cancelled');
});
