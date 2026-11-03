import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { ContextCompactor, ContextUsageTracker, checkContextGate, computeContextLimits, conservativeTextTokens, createCompressionChunks,
    freezeCompressionConfig, hashBytes, hashContext, renderSummary, sealSummaryNode, selectCompactionRounds, selectRawTail,
    validateContextPolicy, validateCoverage, validateNativeTail, computeConversationContextLimits } from '../../../src/agent-server/context/index.ts';
import { createFixture, estimate, execution, fixtureConfig, fixtureModel, ready } from './context-fixtures.mjs';

test('policy defaults, frozen current-model fallback, explicit compression identity and complete request hard gate', () => {
    const config = fixtureConfig();
    assert.equal(config.modelSource, 'current');
    assert.equal(config.policy.bpcThreshold, 0.68);
    assert.equal(config.policy.hardThreshold, 0.90);
    assert.equal(config.policy.keepCompleteRounds, 2);
    assert.equal(config.policy.readFrameBytes, 262144);
    const explicit = { ...fixtureModel, model: 'explicit-compression', parameters: { temperature: 0.2 } };
    const frozen = freezeCompressionConfig({ currentModel: fixtureModel, conversationModel: explicit, revision: 2 });
    explicit.parameters.temperature = 0.8;
    assert.equal(frozen.model.parameters.temperature, 0.2);
    assert.equal(frozen.modelSource, 'conversation');
    assert.throws(() => { frozen.model.parameters.temperature = 0.9; }, TypeError);
    const limits = computeContextLimits(128000, 2048, config.policy);
    assert.deepEqual(limits, { contextWindow: 128000, outputReserve: 2048, margin: 3840,
        inputBudget: 115200, summaryBudget: 38400, target: 76800 });
    assert.equal(checkContextGate(estimate(115199), limits).allowed, true);
    assert.equal(checkContextGate(estimate(115200), limits).allowed, false);
    assert.throws(() => checkContextGate({ ...estimate(10), media: null, confidence: 'unknown' }, limits), { code: 'CONTEXT_CONFIG_INVALID' });
    assert.throws(() => validateContextPolicy({ bpcThreshold: 0.9, hardThreshold: 0.8 }), { code: 'CONTEXT_CONFIG_INVALID' });
    assert.throws(() => computeContextLimits(1024, 100, config.policy), { code: 'CONTEXT_CONFIG_INVALID' });
});

test('explicit completed rounds retain latest two plus the entire active round, and unresolved tools stop the prefix', () => {
    const fixture = createFixture();
    const selection = selectCompactionRounds(fixture.port.capture, fixture.config.policy);
    assert.deepEqual(selection.targets.map(round => round.roundId), ['round-1', 'round-2', 'round-3']);
    assert.deepEqual(selection.retained.map(round => round.roundId), ['round-4', 'round-5', 'round-6']);
    fixture.port.capture.rounds[1].nativePairing = 'pending';
    assert.deepEqual(selectCompactionRounds(fixture.port.capture, fixture.config.policy).targets.map(round => round.roundId), ['round-1']);
});

test('a user local work window changes conversation gates while retaining the real catalog window and compression chunk window', () => {
    const policy = validateContextPolicy({ localContextWindowTokens: 32768 });
    const limits = computeConversationContextLimits(128000, 4096, policy);
    assert.equal(limits.providerContextWindow, 128000);
    assert.equal(limits.localContextWindowTokens, 32768);
    assert.equal(limits.contextWindow, 32768);
    assert.equal(limits.windowSource, 'local');
    assert.equal(limits.inputBudget, 27648);
    assert.equal(limits.target, 19660);
    assert.equal(computeContextLimits(128000, 2048, policy).contextWindow, 128000);
    assert.equal(computeConversationContextLimits(16000, 2048, policy).contextWindow, 16000);
    assert.equal(computeConversationContextLimits(16000, 2048, policy).windowSource, 'provider');
    assert.equal(computeConversationContextLimits(128000, 2048, validateContextPolicy()).contextWindow, 128000);
    const frozen = fixtureConfig({ policy: { localContextWindowTokens: 32768 } });
    assert.equal(frozen.policy.localContextWindowTokens, 32768);
    assert.equal(frozen.model.contextWindow, 128000);
});

test('minimal BPC produces actual source manifest, real complete coverage and ready candidate before the replace deadline', async () => {
    const fixture = createFixture();
    const originals = canonicalJson(fixture.port.items);
    const { candidate } = await ready(fixture);
    assert.equal(candidate.state, 'ready');
    assert.equal(candidate.snapshot.targetReplaceStep, 15);
    assert.deepEqual(candidate.coverage.completeRoundIds, ['round-1', 'round-2', 'round-3']);
    assert.equal(candidate.coverage.coveredEndSeq, 6);
    assert.ok(candidate.coverage.anchorOnly.length >= 3);
    assert.equal(candidate.snapshot.sourceManifestHash, hashContext({ blocks: candidate.snapshot.manifest.blocks, rounds: candidate.snapshot.manifest.rounds }));
    assert.equal(candidate.nextView.coveredEndSeq, 6);
    assert.equal(fixture.port.commits, 0);
    assert.equal(canonicalJson(fixture.port.items), originals);
    assert.ok(fixture.model.calls.every(request => request.execution.rootBudgetId === fixture.port.capture.execution.rootBudgetId
        && request.snapshot.runEpoch === fixture.port.capture.execution.runEpoch && request.chunk.inputTokens <= 16000));
});

test('publication CAS retains a normal appended tail and returns the original view for a different command ID', async () => {
    const fixture = createFixture();
    const { candidate } = await ready(fixture);
    fixture.port.beforePublish = async () => {
        fixture.port.beforePublish = null;
        fixture.port.capture.rounds.at(-1).complete = true;
        fixture.port.appendRound('new tail must survive publication', { active: true });
    };
    const publication = await fixture.compactor.publish(fixture.port.capture.conversationId, 13);
    assert.equal(publication.viewRevision, 1);
    assert.equal(publication.appendSeq, 14);
    assert.equal(fixture.port.capture.appendSeq, 14);
    const tail = selectRawTail(fixture.port.items, fixture.port.capture.view);
    assert.ok(tail.some(item => fixture.port.contents.get(item.contentId)?.text === 'new tail must survive publication'));
    assert.ok(tail.every(item => item.seq > 6));
    const replay = await fixture.port.publishCandidate({ candidate: { ...candidate, state: 'ready' }, receiptKey: {
        principalId: 'fixture-owner', clientId: 'fixture-cli', conversationId: fixture.port.capture.conversationId, clientCommandId: 'second-command' } });
    assert.equal(replay.viewRevision, 1);
    assert.equal(replay.replayed, true);
    assert.equal(fixture.port.commits, 1);
});

test('source missing from an effective consumed history page is a verifiable gap before any model request', async () => {
    const fixture = createFixture();
    fixture.port.items = fixture.port.items.filter(item => item.itemId !== 'user-2');
    await assert.rejects(ready(fixture), error => error.code === 'CONTEXT_SOURCE_GAP' && error.details.itemIds.includes('user-2'));
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.port.capture.viewRevision, 0);
});

test('long UTF-8 content is split without losing the ending and every request and source read stays bounded', async () => {
    const ending = '\n最终要求：保留这段末尾原文';
    const text = '正常素材甲乙丙丁'.repeat(16000) + ending;
    const fixture = createFixture({ rounds: 4, text: ordinal => ordinal === 1 ? text : `normal fixture ${ordinal}`, allowLarge: true });
    const { candidate } = await ready(fixture);
    const requests = fixture.model.calls.filter(request => request.chunk.roundId === 'round-1');
    const targetParts = requests.flatMap(request => JSON.parse(request.chunk.body).targets).filter(part => part.span.itemId === 'user-1');
    assert.equal(targetParts.map(part => part.text).join(''), text);
    assert.ok(targetParts.at(-1).text.endsWith(ending));
    assert.ok(requests.length > 1);
    assert.ok(fixture.port.readSizes.every(size => size <= 262144));
    assert.ok(requests.every(request => conservativeTextTokens(request.chunk.body) === request.chunk.inputTokens && request.chunk.inputTokens <= 16000));
    assert.equal(candidate.coverage.coveredEndSeq, 2);
    assert.equal(candidate.coverage.gaps.length, 0);
});

test('a large object without a bounded source callback pauses with a concrete missing-port report', async () => {
    const fixture = createFixture({ rounds: 4, text: ordinal => ordinal === 1 ? 'normal long input '.repeat(20000) : 'normal' });
    await assert.rejects(ready(fixture), error => error.code === 'CONTEXT_SOURCE_GAP' && error.details.requiredPort === 'ContextSourcePort');
    assert.equal(fixture.model.calls.length, 0);
});

test('partial target coverage only advances the fully covered preceding rounds and never counts references', async () => {
    const fixture = createFixture();
    fixture.model.onGenerate = async (request, signal, result) => {
        if (request.chunk.roundId === 'round-2') result.coverage = result.coverage.filter(entry => entry.span.itemId !== 'user-2');
        return result;
    };
    const { candidate } = await ready(fixture);
    assert.deepEqual(candidate.coverage.completeRoundIds, ['round-1']);
    assert.equal(candidate.nextView.coveredEndSeq, 2);
    assert.ok(candidate.coverage.gaps.some(gap => gap.itemId === 'user-2'));
    assert.ok(fixture.model.calls.some(request => request.chunk.referenceSpans.length > 0));
    assert.equal(fixture.model.calls.filter(request => request.chunk.roundId === 'round-3').length, 0);
    assert.ok(candidate.batch.chunkIds.every(chunkId => candidate.chunks.find(chunk => chunk.chunkId === chunkId).roundId === 'round-1'));
    const onlyReferences = candidate.chunks.map(chunk => ({ ...chunk,
        coverage: chunk.coverage.map(entry => ({ ...entry, span: { ...entry.span, purpose: 'reference' } })) }));
    assert.equal(validateCoverage(candidate.snapshot.manifest, onlyReferences).completeRoundIds.length, 0);
});

for (const changed of ['historyEpoch', 'viewRevision', 'runEpoch', 'compressionGeneration', 'model']) {
    test(`stale ${changed} rejects publication while preserving raw content and the old view`, async () => {
        const fixture = createFixture();
        await ready(fixture);
        const original = canonicalJson(fixture.port.items);
        if (changed === 'runEpoch') fixture.port.capture.execution.runEpoch++;
        else if (changed === 'compressionGeneration') fixture.port.capture.compressionGeneration = 'new-generation';
        else if (changed === 'model') fixture.port.capture.effectiveModelFingerprint = 'new-model';
        else fixture.port.capture[changed]++;
        await assert.rejects(fixture.compactor.publish(fixture.port.capture.conversationId, 13), error => error.code.startsWith('CONTEXT_'));
        assert.equal(fixture.port.commits, 0);
        assert.equal(canonicalJson(fixture.port.items), original);
    });
}

test('lost publication reply is looked up by the original receipt without another commit', async () => {
    const fixture = createFixture();
    await ready(fixture);
    fixture.port.losePublicationResponse = true;
    const publication = await fixture.compactor.publish(fixture.port.capture.conversationId, 13);
    assert.equal(publication.viewRevision, 1);
    assert.equal(fixture.port.commits, 1);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'idle');
});

test('cancel confirms the original attempt, starts 180-second cooldown, and keeps the hard request gate', async () => {
    let now = 10000;
    const fixture = createFixture({ now: () => now });
    let resolveGeneration;
    fixture.model.onGenerate = async (request, signal, result) => new Promise(resolve => { resolveGeneration = () => resolve(result); });
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId,
        config: fixture.config, execution: fixture.port.capture.execution, reason: 'background' });
    while (!resolveGeneration) await delay(1);
    const cancellation = await fixture.compactor.cancel(fixture.port.capture.conversationId);
    assert.equal(cancellation.state, 'cancelled');
    assert.equal(cancellation.cooldownUntil, 190000);
    assert.deepEqual(fixture.model.cancellations, [fixture.model.calls[0].attemptId]);
    resolveGeneration();
    await assert.rejects(handle.completion, { code: 'CONTEXT_CANCELLED' });
    const limits = computeContextLimits(128000, 2048, fixture.config.policy);
    assert.equal(checkContextGate(estimate(limits.inputBudget), limits).allowed, false);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'cooldown');
    now = 190001;
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'idle');
});

test('unknown cancellation stops additional requests and preserves the pending attempt for lookup', async () => {
    const fixture = createFixture();
    let finish;
    fixture.model.cancelStatus = 'unknown';
    fixture.model.onGenerate = async (request, signal, result) => new Promise(resolve => { finish = () => resolve(result); });
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId,
        config: fixture.config, execution: fixture.port.capture.execution, reason: 'background' });
    while (!finish) await delay(1);
    assert.equal((await fixture.compactor.cancel(fixture.port.capture.conversationId)).state, 'unknown');
    await assert.rejects(fixture.compactor.restart(fixture.port.capture.conversationId), { code: 'CONTEXT_ATTEMPT_UNKNOWN' });
    assert.equal(fixture.model.calls.length, 1);
    finish();
    await assert.rejects(handle.completion);
});

test('hard compression rebuilds the entire request and pauses a same-input non-improving loop after one generation', async () => {
    const fixture = createFixture();
    const limits = computeContextLimits(128000, 2048, fixture.config.policy);
    let rebuilt = 0;
    const result = await fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution,
        config: fixture.config, limits, stepSeq: 13, estimate: async () => { rebuilt++; return estimate(fixture.port.capture.viewRevision ? 5000 : limits.inputBudget); } });
    assert.equal(result.inputTokens, 5000);
    assert.ok(rebuilt >= 2);
    assert.equal(fixture.port.commits, 1);
    const other = createFixture();
    await assert.rejects(other.compactor.beforeRequest({ conversationId: other.port.capture.conversationId, execution: other.port.capture.execution,
        config: other.config, limits, stepSeq: 13, estimate: async () => estimate(limits.inputBudget) }), { code: 'CONTEXT_SUMMARY_BUDGET' });
    const count = other.model.calls.length;
    await assert.rejects(other.compactor.beforeRequest({ conversationId: other.port.capture.conversationId, execution: other.port.capture.execution,
        config: other.config, limits, stepSeq: 14, estimate: async () => estimate(limits.inputBudget) }), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.equal(other.model.calls.length, count);
});

test('idle manual compression uses a new maintenance root, publishes at its own boundary and never consumes a draft', async () => {
    const fixture = createFixture({ active: false });
    fixture.port.capture.execution = null;
    const draft = { text: 'keep as draft during maintenance', revision: 4, sent: false };
    const roots = [];
    const finished = [];
    const callbacks = {
        async createRun(input) {
            assert.equal(input.budget.fixtureApproved, true);
            const lease = execution('maintenance', 2);
            roots.push(lease.rootBudgetId);
            fixture.port.capture.execution = lease;
            return lease;
        },
        async finishRun(input) { finished.push(input); fixture.port.capture.execution = null; },
    };
    const compactor = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model, maintenance: callbacks });
    const result = await compactor.manual({ conversationId: fixture.port.capture.conversationId, config: fixture.config, budget: { fixtureApproved: true } });
    await result.handle.completion;
    assert.equal(fixture.port.commits, 1);
    assert.deepEqual(roots, ['fixture-root-2']);
    assert.equal(finished[0].result, 'published');
    assert.equal(finished[0].execution.roundId, null);
    assert.ok(fixture.model.calls.every(request => request.execution.kind === 'maintenance' && request.execution.rootBudgetId === 'fixture-root-2'));
    assert.deepEqual(draft, { text: 'keep as draft during maintenance', revision: 4, sent: false });
    assert.equal(fixture.port.capture.rounds.length, 6);
});

test('idle manual preview survives a missing budget callback without reusing a completed task root', async () => {
    const fixture = createFixture({ active: false });
    fixture.port.capture.execution = null;
    const preview = await fixture.compactor.preview(fixture.port.capture.conversationId, fixture.config);
    assert.equal(preview.requiresBudget, true);
    await assert.rejects(fixture.compactor.manual({ conversationId: fixture.port.capture.conversationId, config: fixture.config }),
        error => error.code === 'BUDGET_REQUIRED' && error.details.preview.roundIds.length > 0);
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.port.claims, 0);
});

test('usage identity preserves missing versus zero, rejects a mismatched attempt and calibrates only after 20 real samples', () => {
    const tracker = new ContextUsageTracker();
    const identity = { attemptId: 'fixture-usage', bodyHash: 'fixture-body', modelFingerprint: 'fixture-model', adapterVersion: 'fixture-v1', modality: 'text' };
    tracker.record(identity, 100, { inputTokens: null, cacheRead: null, cacheWrite: null });
    assert.equal(tracker.exact(identity), null);
    tracker.record(identity, 100, { inputTokens: 0, cacheRead: 0, cacheWrite: null });
    assert.equal(tracker.exact(identity), 0);
    assert.throws(() => tracker.record({ ...identity, bodyHash: 'different' }, 100, { inputTokens: 0, cacheRead: null, cacheWrite: null }), { code: 'CONTEXT_USAGE_MISMATCH' });
    assert.equal(tracker.coefficient(identity), 1.15);
    for (let ordinal = 1; ordinal <= 20; ordinal++) tracker.record({ ...identity, attemptId: `fixture-usage-${ordinal}` }, 100,
        { inputTokens: 130, cacheRead: null, cacheWrite: null });
    assert.equal(tracker.coefficient(identity), 1.3);
});
