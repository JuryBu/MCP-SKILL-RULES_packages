import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactor, ContextService, backgroundTriggerTokens, captureCompletedFragments, computeContextLimits, hashContext,
    bootstrapCommunicationWindow, createSourceManifest, previewCompaction, sealSummaryNode, selectCompactionRounds, updateCommunicationWindow } from '../index.ts';
import { CompatibleChatAdapter } from '../../providers/compatible-chat.ts';
import { createFixture, estimate, fixtureConfig, fixtureModel } from '../../../../tests/agent/local/context-fixtures.mjs';

function appendActiveTools(fixture, count, { pendingLast = false, paddingBytes = 0 } = {}) {
    const { port } = fixture;
    const roundId = `round-${port.capture.rounds.length + 1}`;
    const firstSeq = port.capture.appendSeq + 1;
    const ids = [];
    const append = (id, value, metadata) => {
        port.appendItem(id, value, { roundId, ...metadata });
        ids.push(id);
    };
    append(`${roundId}-user`, { text: 'Complete one continuous report task; read, write and verify the final result.', references: [] },
        { role: 'user', stepId: `${roundId}-user-step`, kind: 'input_consumed' });
    for (let ordinal = 1; ordinal <= count; ordinal++) {
        const stepId = `${roundId}-step-${ordinal}`;
        const callId = `${roundId}-call-${ordinal}`;
        const name = 'read_file';
        const text = `Observed completed work ${ordinal}`;
        append(`${stepId}-model`, { kind: 'model', protocol: 'compatible_chat', response: {
            attemptId: `${stepId}-attempt`, modelId: fixtureModel.model, complete: true, canExecuteTools: true, problems: [],
            toolCalls: [{ callId, providerCallId: callId, name, arguments: { path: `input-${ordinal}.txt` },
                nativeRef: `${stepId}-call`, index: 0, candidateIndex: 0, native: { name, arguments: { path: `input-${ordinal}.txt` } } }],
            blocks: [{ type: 'text', text, nativeRef: stepId, candidateIndex: 0, native: { text } }],
            replayMessages: [{ role: 'assistant', content: text, tool_calls: [{ id: callId, type: 'function',
                function: { name, arguments: JSON.stringify({ path: `input-${ordinal}.txt` }) } }] }],
            raw: { httpStatus: 200, headers: {}, body: text, json: { text } },
        } }, { role: 'assistant', stepId, kind: 'model_step', providerProtocol: 'compatible_chat' });
        if (!(pendingLast && ordinal === count)) append(`${stepId}-tool`, { kind: 'tool',
            result: { callId, name, result: { ok: true, data: { text: `Source facts ${ordinal}${'.'.repeat(paddingBytes)}`, verified: true } } } },
        { role: 'tool', stepId, callId, kind: 'tool_result', providerProtocol: 'compatible_chat' });
    }
    port.capture.rounds.push({ roundId, firstSeq, lastSeq: port.capture.appendSeq, itemIds: ids, complete: false,
        nativePairing: pendingLast ? 'pending' : 'complete', lastStepSeq: count + 1 });
    port.capture.activeRoundId = roundId;
    port.capture.execution.roundId = roundId;
    port.capture.stepSeq += count + 1;
    return roundId;
}

test('BPC starts before an output-limited input gate while ordinary threshold remains unchanged', () => {
    const config = fixtureConfig();
    const ordinary = computeContextLimits(128000, 2048, config.policy);
    assert.equal(backgroundTriggerTokens(ordinary, config.policy), 87040);
    const narrow = computeContextLimits(10000, 4096, config.policy);
    assert.equal(narrow.inputBudget, 4880);
    assert.equal(backgroundTriggerTokens(narrow, config.policy), 3687);
    assert.ok(backgroundTriggerTokens(narrow, config.policy) < narrow.inputBudget);
});

test('one user round exposes only paired completed fragments and retains recent native steps', async () => {
    const fixture = createFixture({ rounds: 0 });
    const roundId = appendActiveTools(fixture, 6, { pendingLast: true });
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    const selection = selectCompactionRounds(capture, fixture.config.policy);
    assert.equal(fixture.port.capture.rounds.length, 1);
    assert.deepEqual(selection.targets.map(round => round.roundId), [roundId]);
    assert.deepEqual(selection.targets[0].itemIds, fixture.port.items.slice(0, 7).map(item => item.itemId));
    assert.equal(selection.retained[0].firstSeq, 8);
    assert.equal(selection.targets[0].nativePairing, 'complete');
    assert.equal(fixture.port.capture.rounds[0].complete, false);
});

test('recent completed steps keep old completed user rounds from blocking an active prefix', async () => {
    const fixture = createFixture({ rounds: 2, active: false });
    const roundId = appendActiveTools(fixture, 5);
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    const selection = selectCompactionRounds(capture, fixture.config.policy);
    assert.deepEqual(selection.targets.map(round => round.roundId), ['round-1', 'round-2', roundId]);
    assert.equal(selection.retained.length, 1);
    assert.equal(selection.retained[0].roundId, roundId);
    assert.equal(selection.retained[0].itemIds.length, 4);
    assert.deepEqual(previewCompaction(capture, fixture.config).recentRawRetention, { unit: 'complete_model_steps', count: 2 });
    const handle = await fixture.compactor.start({ conversationId: capture.conversationId, execution: capture.execution,
        config: fixture.config, reason: 'background' });
    assert.equal((await handle.completion).state, 'ready');
    await fixture.compactor.publish(capture.conversationId, capture.stepSeq);
    const originals = fixture.port.capture.view.communicationWindow.entries.flatMap(entry => entry.originals);
    for (const expected of ['normal fixture input 1', 'normal fixture input 2',
        'Complete one continuous report task; read, write and verify the final result.']) {
        assert.ok(originals.some(part => part.role === 'user' && part.text === expected));
    }
    assert.ok(originals.some(part => part.role === 'assistant' && part.text === 'fixture answer 1'));
    assert.ok(originals.some(part => part.role === 'assistant' && part.text === 'fixture answer 2'));
});

test('a crossing round without an uncovered indexed tail fails explicitly before selecting a fragment', async () => {
    const fixture = createFixture({ rounds: 1, active: false });
    fixture.port.capture.view.coveredEndSeq = 2;
    fixture.port.capture.appendSeq = 3;
    fixture.port.capture.rounds[0].lastSeq = 3;
    await assert.rejects(captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy),
        error => error.code === 'CONTEXT_SOURCE_GAP' && error.details.roundId === 'round-1');
    assert.equal(fixture.port.commits, 0);
});

test('an authoritative unfinished group prevents later fragments from being compacted across it', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendActiveTools(fixture, 6);
    fixture.port.readModelStepPairings = async query => query.stepIds.map((_, index) => index === 2 ? 'pending' : 'complete');
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    assert.equal(capture.activeCompletedPrefix, undefined);
    assert.deepEqual(selectCompactionRounds(capture, fixture.config.policy).targets, []);
});

test('a single user task automatically compacts inside its original input budget and a cold controller reuses the result', async () => {
    const config = fixtureConfig({ currentModel: { ...fixtureModel, contextWindow: 10000, maxOutputTokens: 4096 } });
    const fixture = createFixture({ rounds: 0, config });
    const roundId = appendActiveTools(fixture, 6);
    const original = hashContext(fixture.port.items.map(item => fixture.port.contents.get(item.contentId)));
    const limits = computeContextLimits(config.model.contextWindow, config.model.maxOutputTokens, config.policy);
    const request = { conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution, config,
        stepSeq: fixture.port.capture.stepSeq, limits,
        estimateCompaction: async (_snapshot, summary) => ({ estimate: estimate(summary.text ? 2200 : 2000),
            modelId: config.model.model, adapterVersion: config.model.adapterVersion }) };
    const started = await fixture.compactor.postStep({ ...request, estimate: estimate(4200) });
    assert.ok(started.backgroundCandidateId);
    const deadline = Date.now() + 3000;
    while (fixture.port.candidates.get(started.backgroundCandidateId)?.state !== 'ready' && Date.now() < deadline) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(fixture.port.candidates.get(started.backgroundCandidateId)?.state, 'ready');
    const result = await fixture.compactor.beforeRequest({ ...request,
        estimate: async () => estimate(fixture.port.commits ? 2200 : 4200) });
    assert.equal(result.inputTokens, 2200);
    assert.equal(fixture.port.commits, 1);
    assert.ok(fixture.model.calls.length > 0);
    assert.equal(fixture.port.capture.rounds.length, 1);
    assert.equal(fixture.port.capture.activeRoundId, roundId);
    assert.ok(fixture.port.capture.view.coveredEndSeq < fixture.port.capture.appendSeq);
    const cold = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model });
    assert.deepEqual(await cold.readView(request.conversationId), fixture.port.capture.view);
    const next = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), config.policy);
    assert.equal(next.rounds[0].firstSeq, fixture.port.capture.view.coveredEndSeq + 1);
    assert.equal(original, hashContext(fixture.port.items.map(item => fixture.port.contents.get(item.contentId))));
    const firstCovered = fixture.port.capture.view.coveredEndSeq;
    const active = fixture.port.capture.rounds[0];
    for (let ordinal = 7; ordinal <= 8; ordinal++) {
        const stepId = `${roundId}-step-${ordinal}`;
        const callId = `${roundId}-call-${ordinal}`;
        const value = structuredClone(fixture.port.contents.get(`${roundId}-step-1-model-content`));
        value.response.attemptId = `${stepId}-attempt`;
        value.response.toolCalls[0].callId = callId;
        value.response.toolCalls[0].providerCallId = callId;
        value.response.replayMessages[0].tool_calls[0].id = callId;
        fixture.port.appendItem(`${stepId}-model`, value, { role: 'assistant', roundId, stepId, kind: 'model_step', providerProtocol: 'compatible_chat' });
        fixture.port.appendItem(`${stepId}-tool`, { kind: 'tool', result: { callId, name: 'read_file', result: { ok: true, data: 'continued source' } } },
            { role: 'tool', roundId, stepId, callId, kind: 'tool_result', providerProtocol: 'compatible_chat' });
        active.itemIds.push(`${stepId}-model`, `${stepId}-tool`);
        active.lastSeq = fixture.port.capture.appendSeq;
    }
    const repeated = await cold.beforeRequest({ ...request,
        estimate: async () => estimate(fixture.port.commits > 1 ? 2200 : 6000) });
    assert.equal(repeated.inputTokens, 2200);
    assert.equal(fixture.port.commits, 2);
    assert.ok(fixture.port.capture.view.coveredEndSeq > firstCovered);
    assert.equal(fixture.port.capture.rounds.length, 1);
    assert.equal(fixture.port.capture.activeRoundId, roundId);
    assert.equal(fixture.port.capture.view.nodes.length, 1);
});

test('first K-exchange bootstrap uses the same semantic identities as incremental communication updates', async () => {
    const fixture = createFixture({ rounds: 3, active: false, config: fixtureConfig({ policy: { communicationWindowSize: 2 } }) });
    const node = (nodeId, roundIds, firstSeq, lastSeq) => sealSummaryNode({ kind: 'batch', nodeId, exchangeId: nodeId,
        firstSeq, lastSeq, roundIds, sourceSpans: [], chunkIds: [], parentBatchIds: [], modelFingerprint: fixture.config.modelFingerprint,
        body: nodeId, skeleton: nodeId, title: nodeId, unresolved: [], anchors: [] });
    const nodes = [node('semantic-a', ['round-1', 'round-2'], 1, 4), node('semantic-b', ['round-3'], 5, 6)];
    fixture.port.capture.viewRevision = 1;
    fixture.port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 6, nodes };
    fixture.port.readSemanticNodes = async () => ({ historyEpoch: 1, viewRevision: 1, nodes });
    const initial = await bootstrapCommunicationWindow({ conversationId: fixture.port.capture.conversationId,
        historyEpoch: 1, viewRevision: 1, coveredEndSeq: 6, policy: fixture.config.policy, history: fixture.port, sources: fixture.sources });
    const manifest = await createSourceManifest(fixture.sources, fixture.port.items, fixture.port.capture.rounds);
    const incremental = await updateCommunicationWindow({ snapshot: { conversationId: fixture.port.capture.conversationId,
        historyEpoch: 1, coveredStartSeq: 1, config: fixture.config, manifest,
        requirementSourceMetadata: fixture.port.items.map(item => ({ itemId: item.itemId, role: item.role, roundId: item.roundId, seq: item.seq })) },
    nodes, coveredEndSeq: 6, sources: fixture.sources, signal: new AbortController().signal });
    assert.equal(initial.bootstrap.grouping, 'semantic');
    assert.equal(initial.bootstrap.complete, true);
    const project = window => window.entries.map(entry => ({ exchangeId: entry.exchangeId, roundIds: entry.roundIds,
        originals: entry.originals.map(part => [part.itemId, part.blockId]) }));
    assert.deepEqual(project(initial), project(incremental));
    assert.deepEqual(initial.entries.map(entry => entry.roundIds), [['round-1', 'round-2'], ['round-3']]);
    const partialEntry = structuredClone(initial.entries[1]);
    partialEntry.firstSeq = 6;
    partialEntry.originals = partialEntry.originals.filter(part => part.seq >= 6);
    const previousContent = { schemaVersion: 1, historyEpoch: 1, coveredEndSeq: 6, size: 1, entries: [partialEntry] };
    const previous = { ...previousContent, hash: hashContext(previousContent) };
    const supplemented = await bootstrapCommunicationWindow({ conversationId: fixture.port.capture.conversationId,
        historyEpoch: 1, viewRevision: 1, coveredEndSeq: 6, policy: fixture.config.policy, history: fixture.port, sources: fixture.sources, previous });
    assert.deepEqual(project(supplemented), project(incremental));
});

test('the formal ContextService serializer reuses one active tool round across background publication and a cold service', async () => {
    const config = fixtureConfig({ currentModel: { ...fixtureModel, contextWindow: 10000, maxOutputTokens: 4096 } });
    const adapter = new CompatibleChatAdapter();
    const parameters = { maxOutputTokens: 4096 };
    const wireBytes = view => Buffer.byteLength(JSON.stringify(adapter.encode(view, fixtureModel.model, parameters)));
    const limits = computeContextLimits(10000, 4096, config.policy);
    const setup = paddingBytes => {
        const fixture = createFixture({ rounds: 0, config });
        appendActiveTools(fixture, 6, { paddingBytes });
        const service = new ContextService({ compactor: fixture.compactor });
        const input = { conversationId: fixture.port.capture.conversationId,
            context: { signal: new AbortController().signal,
                readHistory: query => fixture.port.readHistory({ ...query, conversationId: fixture.port.capture.conversationId }),
                readContent: contentId => fixture.port.readContent(fixture.port.capture.conversationId, contentId) },
            adapter, parameters, modelId: fixtureModel.model, baseView: { protocol: 'compatible_chat', messages: [{ role: 'system', content: 'Continue the original task.' }] },
            estimateView: async view => estimate(wireBytes(view)),
            compression: { config, execution: fixture.port.capture.execution, stepSeq: fixture.port.capture.stepSeq, limits } };
        return { fixture, service, input };
    };
    const baseline = setup(0);
    const ordinary = await baseline.service.buildView({ ...baseline.input, compression: undefined });
    const desired = Math.min(limits.inputBudget - 256, backgroundTriggerTokens(limits, config.policy) + 200);
    const padding = Math.max(0, Math.floor((desired - wireBytes(ordinary.view)) / 6));
    const { fixture, service, input } = setup(padding);
    const before = await service.buildView(input);
    assert.ok(wireBytes(before.view) < limits.inputBudget);
    assert.ok(wireBytes(before.view) >= backgroundTriggerTokens(limits, config.policy));
    const deadline = Date.now() + 3000;
    while (![...fixture.port.candidates.values()].some(candidate => candidate.state === 'ready') && Date.now() < deadline) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const after = await service.buildView(input);
    assert.equal(fixture.port.commits, 1);
    assert.ok(wireBytes(after.view) < limits.inputBudget);
    assert.ok(wireBytes(after.view) < wireBytes(before.view));
    const calls = fixture.model.calls.length;
    const coldService = new ContextService({ compactor: new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model }) });
    const cold = await coldService.buildView(input);
    assert.deepEqual(cold.view, after.view);
    assert.equal(fixture.model.calls.length, calls);
    assert.equal(fixture.port.capture.rounds.length, 1);
});
