import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextCompactor, ContextService, appendPlainUser, computeContextLimits, hashBytes, injectSummaryText, renderSummary, totalContextTokens } from '../../../src/agent-server/context/index.ts';
import { fitCompactionSummary } from '../../../src/agent-server/context/compaction.ts';
import { COMPRESSION_INSTRUCTIONS } from '../../../src/agent-server/context/server-adapter.ts';
import { CompatibleChatAdapter, normalizeChatResponse } from '../../../src/agent-server/providers/compatible-chat.ts';
import { GeminiAdapter, normalizeGeminiResponse } from '../../../src/agent-server/providers/gemini.ts';
import { createFixture, fixtureConfig, fixtureModel, ready } from './context-fixtures.mjs';

const parameters = { maxOutputTokens: 4096, temperature: 0.2 };
const adapter = new CompatibleChatAdapter();
const wireTokens = view => Buffer.byteLength(JSON.stringify(adapter.encode(view, fixtureModel.model, parameters)));

function pendingLookup(fixture, metadata = {}) {
    const stepId = 'headroom-overlapping-tool-step';
    const callId = 'headroom-overlapping-tool-call';
    const response = normalizeChatResponse('headroom-overlapping-attempt', { httpStatus: 200, headers: {}, body: '{}',
        json: { model: fixtureModel.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: callId, type: 'function', function: { name: 'ordinary_lookup', arguments: '{}' } }] } }] } });
    const identity = { roundId: fixture.port.capture.activeRoundId, stepId, providerProtocol: adapter.protocol, ...metadata };
    fixture.port.appendItem('headroom-overlapping-model', { kind: 'model', protocol: adapter.protocol, response },
        { ...identity, role: 'assistant', kind: 'model_step' });
    return () => fixture.port.appendItem('headroom-overlapping-result', { kind: 'tool', result: {
        callId, name: 'ordinary_lookup', result: { ok: true, data: { text: 'EVIDENCE-COMPLETE' } } } }, { ...identity, role: 'tool', kind: 'tool_step' });
}

async function readyNativeEstimate() {
    const fixture = setup();
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId,
        config: fixture.config, execution: fixture.input.compression.execution, reason: 'background' });
    const candidate = await handle.completion;
    const summary = { coveredEndSeq: candidate.nextView.coveredEndSeq, text: 'verified historical facts', tokens: 25 };
    return { fixture, candidate, summary };
}

function appendRound(fixture, ordinal, text, active) {
    const response = normalizeChatResponse(`headroom-${ordinal}`, { httpStatus: 200, headers: {},
        body: '{}', json: { model: fixtureModel.model, choices: [{ index: 0, finish_reason: 'stop',
            message: { role: 'assistant', content: `verified answer ${ordinal}` } }] } });
    fixture.port.appendRound(text, { active, modelValue: { kind: 'model', protocol: adapter.protocol, response } });
}

function setup({ schemaBytes = 5500, retainedText = 'retained original '.repeat(105), historicalText = 'ordinary historical source fact\n'.repeat(360), policy, compressionModel } = {}) {
    const config = fixtureConfig({ currentModel: { ...fixtureModel, contextWindow: 32768, maxOutputTokens: 4096, ...compressionModel }, ...(policy ? { policy } : {}) });
    const fixture = createFixture({ config, rounds: 0 });
    for (let ordinal = 1; ordinal <= 6; ordinal++) {
        appendRound(fixture, ordinal, ordinal <= 3 ? historicalText : retainedText, ordinal === 6);
    }
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    const context = { signal: new AbortController().signal,
        readHistory: query => fixture.port.readHistory({ ...query, view: 'raw', effectiveOnly: true }),
        readContent: contentId => fixture.port.readContent(fixture.port.capture.conversationId, contentId) };
    const limits = computeContextLimits(32768, 4096, config.policy);
    const baseView = { protocol: adapter.protocol, messages: [{ role: 'system', content: 'current rules '.repeat(90) }],
        tools: [{ name: 'ordinary_lookup', description: 'current schema '.repeat(Math.ceil(schemaBytes / 15)),
            parameters: { type: 'object', properties: { name: { type: 'string' } } } }] };
    const service = new ContextService({ compactor: fixture.compactor });
    const input = { conversationId: fixture.port.capture.conversationId, context, adapter, modelId: fixtureModel.model,
        parameters, baseView, compression: { config, execution: fixture.port.capture.execution, stepSeq: 12, limits } };
    return { ...fixture, context, limits, baseView, service, input };
}

async function fixedView(fixture) {
    return fixture.service.buildView({ ...fixture.input, compression: undefined,
        summaryView: { revision: 0, historyEpoch: 1, coveredEndSeq: 6, nodes: [] } });
}

test('Gemini 3.8 complete model tail can be measured for background compaction', async () => {
    const gemini = new GeminiAdapter();
    const geminiParameters = { generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } } };
    const config = fixtureConfig({ currentModel: { ...fixtureModel, model: 'gemini-3.8-flash', protocol: gemini.protocol,
        adapterVersion: gemini.version, parameters: geminiParameters, contextWindow: 32768, maxOutputTokens: 4096 } });
    const fixture = createFixture({ config, rounds: 0 });
    for (let ordinal = 1; ordinal <= 6; ordinal++) {
        const response = normalizeGeminiResponse(`gemini-measurement-${ordinal}`, { httpStatus: 200, headers: {}, body: '{}',
            json: { modelVersion: 'gemini-3.8-flash', candidates: [{ index: 0, finishReason: 'STOP',
                content: { role: 'model', parts: [{ text: `verified original ${ordinal}` }] } }] } });
        fixture.port.appendRound(`source fact ${ordinal}`, { active: ordinal === 6,
            modelValue: { kind: 'model', protocol: gemini.protocol, response } });
        fixture.port.items.at(-1).providerProtocol = gemini.protocol;
    }
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    const context = { signal: new AbortController().signal,
        readHistory: query => fixture.port.readHistory({ ...query, view: 'raw', effectiveOnly: true }),
        readContent: contentId => fixture.port.readContent(fixture.port.capture.conversationId, contentId) };
    const service = new ContextService({ compactor: fixture.compactor });
    const input = { conversationId: fixture.port.capture.conversationId, context, adapter: gemini,
        modelId: 'gemini-3.8-flash', parameters: geminiParameters, baseView: { protocol: gemini.protocol } };
    const handle = await fixture.compactor.start({ conversationId: input.conversationId, config,
        execution: fixture.port.capture.execution, reason: 'background' });
    const candidate = await handle.completion;
    const summary = { coveredEndSeq: candidate.nextView.coveredEndSeq, text: 'verified historical facts', tokens: 25 };
    const before = JSON.stringify(fixture.port.items);
    const generatedBeforeMeasurement = fixture.model.calls.length;
    const measured = await service.createCompactionEstimator(input, fixture.port.capture.execution)(candidate.snapshot, summary);
    assert.equal(measured.estimate.confidence, 'conservative');
    assert.ok(totalContextTokens(measured.estimate) > 0);
    assert.equal(JSON.stringify(fixture.port.items), before);
    assert.equal(fixture.model.calls.length, generatedBeforeMeasurement);
});

test('Gemini measurement preserves bytes while dispatch still rejects model prefilling', () => {
    const gemini = new GeminiAdapter();
    const geminiParameters = { generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } } };
    const completed = { protocol: gemini.protocol, contents: [{ role: 'user', parts: [{ text: 'original question' }] },
        { role: 'model', parts: [{ text: 'verified response', thoughtSignature: 'test-native-signature' }] }] };
    const before = JSON.stringify(completed);
    const measured = gemini.encodeForMeasurement(completed, 'gemini-3.8-flash', geminiParameters);
    assert.deepEqual(measured.contents, completed.contents);
    assert.equal(JSON.stringify(completed), before);
    assert.throws(() => gemini.encode(completed, 'gemini-3.8-flash', geminiParameters), { code: 'E_PARAMETER_UNSUPPORTED' });
    const ready = appendPlainUser(completed, 'next real task');
    assert.deepEqual(gemini.encodeForMeasurement(ready, 'gemini-3.8-flash', geminiParameters), gemini.encode(ready, 'gemini-3.8-flash', geminiParameters));
    assert.throws(() => gemini.encodeForMeasurement(completed, 'gemini-3.8-flash', { generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } }), { code: 'E_PARAMETER_UNSUPPORTED' });
});

test('ContextService -> Compactor supplies actual complete-native headroom before generation', async () => {
    const fixture = setup();
    const fixed = await fixedView(fixture);
    const fixedTokens = wireTokens(fixed.view);
    assert.ok(fixedTokens < fixture.limits.target);
    assert.ok(fixture.limits.summaryBudget > fixture.limits.target - fixedTokens - 1);
    fixture.model.onGenerate = async (request, signal, result) => {
        assert.equal(request.snapshot.requestBudget?.summaryBudget,
            Math.min(fixture.limits.summaryBudget, fixture.limits.target - fixedTokens - 1));
        assert.deepEqual(JSON.parse(request.chunk.body).requestBudget, request.snapshot.requestBudget);
        return result;
    };
    const built = await fixture.service.buildView(fixture.input);
    assert.ok(fixture.model.calls.length > 0);
    assert.equal(fixture.port.commits, 1);
    assert.ok(wireTokens(built.view) < fixture.limits.target);
    assert.ok(totalContextTokens(built.estimate) < fixture.limits.target);
});

test('a fixed native floor at the hard input budget refuses before any summary model call', async () => {
    const fixture = setup({ schemaBytes: 30000 });
    assert.ok(wireTokens((await fixedView(fixture)).view) >= fixture.limits.inputBudget);
    await assert.rejects(fixture.service.buildView(fixture.input), error => error.code === 'CONTEXT_SUMMARY_BUDGET'
        && error.details.fixedInputTokens >= fixture.limits.inputBudget);
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.port.commits, 0);
});

test('strictly equal fixed native floor refuses without a paid-generation intent', async () => {
    const fixture = setup({ schemaBytes: 1000 });
    const initial = wireTokens((await fixedView(fixture)).view);
    fixture.baseView.messages[0].content += 'X'.repeat(fixture.limits.inputBudget - initial);
    assert.equal(wireTokens((await fixedView(fixture)).view), fixture.limits.inputBudget);
    await assert.rejects(fixture.service.buildView(fixture.input), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.port.candidates.size, 0);
});

test('a fixed native floor at the optimization target can retain a safe summary and continue', async () => {
    const fixture = setup({ schemaBytes: 1000 });
    const initial = wireTokens((await fixedView(fixture)).view);
    fixture.baseView.messages[0].content += 'X'.repeat(fixture.limits.target - initial);
    const built = await fixture.service.buildView(fixture.input);
    assert.ok(wireTokens(built.view) >= fixture.limits.target);
    assert.ok(wireTokens(built.view) < fixture.limits.inputBudget);
    assert.ok(fixture.model.calls.length > 0);
    assert.equal(fixture.port.commits, 1);
    const view = fixture.port.capture.view;
    assert.equal(view.fitEvidence.targetReached, false);
    assert.equal(view.fitEvidence.optimizationStoppedAtMinimum, true);
});

test('an allowed foreground request stays usable when an impossible background compaction is refused unsent', async () => {
    const fixture = setup({ schemaBytes: 18500, historicalText: 'ordinary historical source fact' });
    const before = await fixture.service.buildView({ ...fixture.input, compression: undefined });
    assert.ok(totalContextTokens(before.estimate) < fixture.limits.inputBudget);
    assert.ok(totalContextTokens(before.estimate) >= fixture.config.policy.bpcThreshold * fixture.limits.contextWindow);
    const built = await fixture.service.buildView(fixture.input);
    assert.ok(totalContextTokens(built.estimate) < fixture.limits.inputBudget);
    assert.equal(fixture.model.calls.length, 0);
    assert.equal(fixture.port.commits, 0);
    assert.equal(fixture.port.checkpoints.get(fixture.input.conversationId).state, 'idle');
    assert.equal(fixture.port.checkpoints.get(fixture.input.conversationId).lastFailure.code, 'CONTEXT_SUMMARY_BUDGET');
});

function irreducibleSummaryFixture() {
    const quote = 'retain this verified continuing requirement '.repeat(48);
    const fixture = setup({ schemaBytes: 2000, retainedText: 'recent retained input',
        historicalText: `${quote}\n${'ordinary source detail '.repeat(10)}`,
        policy: { localContextWindowTokens: 16384 }, compressionModel: { contextWindow: 1048576 } });
    fixture.limits = computeContextLimits(16384, 4096, fixture.config.policy);
    fixture.input.compression.limits = fixture.limits;
    fixture.model.onGenerate = async (request, signal, result) => {
        const span = request.chunk.sourceSpans.find(entry => entry.purpose === 'target');
        const clause = quote.slice(0, quote.length / 2);
        result.digest = { body: 'Verified continuing requirement', skeleton: 'Verified requirement', title: 'Verified requirement',
            unresolved: [{ id: `irreducible-${request.chunk.roundId}`, quote, source: { ...span,
                endByte: span.startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) } },
            { id: `irreducible-clause-${request.chunk.roundId}`, quote: clause, source: { ...span,
                endByte: span.startByte + Buffer.byteLength(clause), sha256: hashBytes(clause) } }] };
        return result;
    };
    return fixture;
}

test('a fully observed background summary-budget failure preserves safe foreground work and stops background regeneration', async () => {
    const fixture = irreducibleSummaryFixture();
    const original = await fixture.service.buildView({ ...fixture.input, compression: undefined });
    assert.ok(totalContextTokens(original.estimate) < fixture.limits.inputBudget);
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background', limits: fixture.limits, estimateCompaction });
    const candidate = await handle.completion;
    assert.equal(candidate.state, 'failed', JSON.stringify({ originalTokens: totalContextTokens(original.estimate),
        fitEvidence: candidate.nextView?.fitEvidence, inputBudget: fixture.limits.inputBudget }));
    assert.equal(candidate.error.code, 'CONTEXT_SUMMARY_BUDGET');
    assert.equal(candidate.pendingRequest, null);
    const calls = fixture.model.calls.length;
    assert.ok(calls > 0);
    const built = await fixture.service.buildView(fixture.input);
    assert.ok(totalContextTokens(built.estimate) < fixture.limits.inputBudget);
    assert.deepEqual(built.view, original.view);
    assert.equal(fixture.model.calls.length, calls);
    assert.equal(fixture.port.commits, 0);
    assert.equal(fixture.port.checkpoints.get(fixture.input.conversationId).state, 'circuitBroken');
});

test('a delayed old background failure cannot remove a replacement compaction after an ordinary restart', async () => {
    const fixture = irreducibleSummaryFixture();
    const saveScheduler = fixture.port.saveScheduler.bind(fixture.port);
    let reached;
    let releaseReply;
    const persisted = new Promise(resolve => { reached = resolve; });
    const delayedReply = new Promise(resolve => { releaseReply = resolve; });
    fixture.port.saveScheduler = async (conversationId, checkpoint) => {
        await saveScheduler(conversationId, checkpoint);
        if (checkpoint.state === 'circuitBroken') {
            reached();
            await delayedReply;
        }
    };
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const start = () => fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background', limits: fixture.limits, estimateCompaction });
    const original = await start();
    await persisted;
    await fixture.compactor.restart(fixture.input.conversationId);
    let enteredReplacement;
    let releaseReplacement;
    const replacementEntered = new Promise(resolve => { enteredReplacement = resolve; });
    const replacementHeld = new Promise(resolve => { releaseReplacement = resolve; });
    fixture.model.onGenerate = async (request, signal, result) => { enteredReplacement(); await replacementHeld; return result; };
    const replacement = await start();
    await replacementEntered;
    const expectedCheckpoint = structuredClone(fixture.port.checkpoints.get(fixture.input.conversationId));
    let current;
    let currentCheckpoint;
    try {
        releaseReply();
        await original.completion;
        current = fixture.compactor.active.get(fixture.input.conversationId)?.candidate.candidateId;
        currentCheckpoint = structuredClone(fixture.port.checkpoints.get(fixture.input.conversationId));
    } finally {
        releaseReply();
        releaseReplacement();
        await replacement.completion;
    }
    assert.equal(current, replacement.candidateId);
    assert.deepEqual(currentCheckpoint, expectedCheckpoint);
});

test('a known hard summary-budget failure stays explicit and cannot create more automatic model calls', async () => {
    const fixture = irreducibleSummaryFixture();
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'hard', limits: fixture.limits, estimateCompaction });
    await assert.rejects(handle.completion, { code: 'CONTEXT_SUMMARY_BUDGET' });
    const calls = fixture.model.calls.length;
    await assert.rejects(fixture.service.buildView(fixture.input), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.equal(fixture.model.calls.length, calls);
    assert.equal(fixture.port.checkpoints.get(fixture.input.conversationId).state, 'hardPaused');
});

for (const [label, body] of [['normal', 'ordinary fact '.repeat(140)], ['Chinese quotes and escapes', '中文"\\\n'.repeat(175)]]) {
    test(`${label}: static raw allowance cannot bypass the full native target or remove a live obligation`, async () => {
        const fixture = setup();
        const rawDraft = [];
        fixture.model.onGenerate = async (request, signal, result) => {
            const quote = 'ordinary historical source fact';
            const span = request.chunk.sourceSpans.find(entry => entry.purpose === 'target');
            const requirement = { id: `live-${request.chunk.roundId}`, quote, source: { ...span,
                endByte: span.startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) } };
            result.digest = { body, skeleton: 'Compact verified facts with original source anchors', title: 'Current verified facts',
                unresolved: [requirement] };
            rawDraft.push(result.digest);
            return result;
        };
        const built = await fixture.service.buildView(fixture.input);
        const candidate = [...fixture.port.candidates.values()].at(-1);
        const unbounded = renderSummary(candidate.nextView.nodes, fixture.config.policy, Number.MAX_SAFE_INTEGER);
        assert.ok(unbounded.tokens < fixture.limits.summaryBudget);
        if (label !== 'normal') {
            assert.ok(wireTokens({ ...built.view, messages: built.view.messages.map(message => message.role === 'system'
                && message.content.includes('[summary ') ? { ...message, content: unbounded.text } : message) }) >= fixture.limits.target);
            assert.ok(candidate.nextView.summaryBudget < unbounded.tokens);
        }
        assert.ok(wireTokens(built.view) < fixture.limits.target);
        assert.ok(JSON.stringify(built.view).includes('ordinary historical source fact'));
        assert.deepEqual(built.view.tools, fixture.baseView.tools);
        assert.equal(candidate.nextView.nodes[0].unresolved.length, 3);
        assert.equal(fixture.port.commits, 1);
        assert.equal(rawDraft.length, fixture.model.calls.length);
    });
}

test('background native measurement waits for the same current tool step and then includes its full result', async () => {
    const { fixture, candidate, summary } = await readyNativeEstimate();
    const finish = pendingLookup(fixture);
    let fullReads = 0;
    let metadataReads = 0;
    const read = fixture.context.readHistory;
    fixture.context.readHistory = query => { if (query.limit === 1) metadataReads++; else fullReads++; return read(query); };
    const native = new CompatibleChatAdapter();
    const encode = native.encode.bind(native);
    const encoded = [];
    native.encode = (...args) => { encoded.push(structuredClone(args[0])); return encode(...args); };
    const estimateView = view => ({ rules: 0, schema: 0,
        native: Buffer.byteLength(JSON.stringify(native.encode(view, fixture.input.modelId, fixture.input.parameters))),
        summary: 0, retained: 0, media: 0, protocol: 0, confidence: 'conservative' });
    const estimate = fixture.service.createCompactionEstimator({ ...fixture.input, adapter: native, estimateView }, fixture.input.compression.execution);
    const timer = setTimeout(finish, 60);
    try {
        const measured = await estimate(candidate.snapshot, summary);
        assert.ok(measured.estimate.native > 0);
        assert.equal(encoded.length, 1);
        assert.ok(JSON.stringify(encoded[0]).includes('EVIDENCE-COMPLETE'));
        assert.equal(fullReads, 2);
        assert.ok(metadataReads >= 1);
    } finally { clearTimeout(timer); }
});

test('an incomplete historical tool group from another root still fails without waiting', async () => {
    const { fixture, candidate, summary } = await readyNativeEstimate();
    pendingLookup(fixture, { runId: 'another-root' });
    const estimate = fixture.service.createCompactionEstimator(fixture.input, fixture.input.compression.execution);
    await assert.rejects(estimate(candidate.snapshot, summary), { code: 'E_TOOL_PAIRING' });
});

test('a non-final incomplete tool group remains a pairing error', async () => {
    const { fixture, candidate, summary } = await readyNativeEstimate();
    pendingLookup(fixture);
    fixture.port.appendItem('headroom-later-user', { text: 'A later turn already began', references: [] },
        { role: 'user', roundId: fixture.port.capture.activeRoundId, stepId: 'later-user', kind: 'input_consumed' });
    const estimate = fixture.service.createCompactionEstimator(fixture.input, fixture.input.compression.execution);
    await assert.rejects(estimate(candidate.snapshot, summary), { code: 'E_TOOL_PAIRING' });
});

test('compactor cancellation promptly aborts a pending native estimate without aborting the foreground signal', async () => {
    const { fixture, candidate, summary } = await readyNativeEstimate();
    pendingLookup(fixture);
    const abort = new AbortController();
    const estimate = fixture.service.createCompactionEstimator(fixture.input, fixture.input.compression.execution);
    const timer = setTimeout(() => abort.abort(), 20);
    try {
        await assert.rejects(estimate(candidate.snapshot, summary, abort.signal), { code: 'CONTEXT_CANCELLED' });
        assert.equal(fixture.context.signal.aborted, false);
    } finally { clearTimeout(timer); }
});

test('a pending native estimate obeys the unchanged root deadline', async () => {
    const { fixture, candidate, summary } = await readyNativeEstimate();
    pendingLookup(fixture);
    const execution = { ...fixture.input.compression.execution, deadlineAt: new Date(Date.now() + 40).toISOString() };
    const snapshot = { ...candidate.snapshot, execution };
    const estimate = fixture.service.createCompactionEstimator(fixture.input, execution);
    await assert.rejects(estimate(snapshot, summary), { code: 'CONTEXT_CANCELLED' });
});

test('a heavier current schema reduces native summary headroom by its real encoded difference', async () => {
    const cases = [setup({ schemaBytes: 3000 }), setup({ schemaBytes: 7500 })];
    const budgets = [];
    for (const fixture of cases) {
        const fixedInputTokens = wireTokens((await fixedView(fixture)).view);
        const built = await fixture.service.buildView(fixture.input);
        const budget = fixture.model.calls[0].snapshot.requestBudget;
        budgets.push(budget);
        assert.equal(budget.fixedInputTokens, fixedInputTokens);
        assert.equal(budget.target, fixture.limits.target);
        assert.equal(budget.modelId, fixtureModel.model);
        assert.equal(budget.adapterVersion, adapter.version);
        assert.ok(wireTokens(built.view) < budget.target);
    }
    assert.ok(budgets[1].summaryBudget < budgets[0].summaryBudget);
    assert.equal(budgets[0].summaryBudget - budgets[1].summaryBudget,
        budgets[1].fixedInputTokens - budgets[0].fixedInputTokens);
});

test('distinct foreground and compression models keep the foreground native target and the compressor input/output caps', async () => {
    const fixture = setup({ compressionModel: { model: 'independent-small-compressor', contextWindow: 16384, maxOutputTokens: 1024 },
        policy: { chunkInputTokens: 2048, referenceTokens: 500 } });
    fixture.input.modelId = 'foreground-large-model';
    const foregroundWire = view => Buffer.byteLength(JSON.stringify(adapter.encode(view, fixture.input.modelId, parameters)));
    const fixedInputTokens = foregroundWire((await fixedView(fixture)).view);
    const compressionLimits = computeContextLimits(16384, 1024, fixture.config.policy);
    fixture.model.onGenerate = async (request, signal, result) => {
        assert.equal(request.model.model, 'independent-small-compressor');
        assert.equal(request.model.contextWindow, 16384);
        assert.equal(request.maxOutputTokens, 1024);
        assert.ok(request.chunk.inputTokens <= fixture.config.policy.chunkInputTokens);
        assert.ok(request.chunk.inputTokens < compressionLimits.inputBudget);
        const compressionView = appendPlainUser(injectSummaryText({ protocol: adapter.protocol }, COMPRESSION_INSTRUCTIONS), request.chunk.body);
        const nativeCompressionInput = Buffer.byteLength(JSON.stringify(adapter.encode(compressionView, request.model.model,
            { maxOutputTokens: request.maxOutputTokens })));
        assert.ok(nativeCompressionInput < compressionLimits.inputBudget);
        assert.equal(request.snapshot.requestBudget.modelId, fixture.input.modelId);
        assert.equal(request.snapshot.requestBudget.target, fixture.limits.target);
        assert.equal(request.snapshot.requestBudget.summaryBudget, fixture.limits.target - fixedInputTokens - 1);
        return result;
    };
    const built = await fixture.service.buildView(fixture.input);
    assert.ok(fixture.model.calls.length > 3);
    assert.ok(foregroundWire(built.view) > compressionLimits.target);
    assert.ok(foregroundWire(built.view) < fixture.limits.target);
    const budget = fixture.model.calls[0].snapshot.requestBudget;
    assert.ok(foregroundWire(built.view) - fixedInputTokens <= budget.summaryBudget);
    console.log(JSON.stringify({ independentCompressionModel: true, foregroundWindow: fixture.limits.contextWindow,
        foregroundOutput: parameters.maxOutputTokens, target: budget.target, compressionWindow: 16384, compressionOutput: 1024,
        completeNativeInput: foregroundWire(built.view), sharedSummaryBudget: budget.summaryBudget, apiCalls: 0 }));
});

test('fitting rejects a model or adapter identity that differs from the frozen native request budget', async () => {
    const fixture = setup();
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'hard', limits: fixture.limits, estimateCompaction });
    const candidate = await handle.completion;
    const calls = fixture.model.calls.length;
    for (const mismatch of [{ modelId: 'other-foreground-model' }, { adapterVersion: 'other-adapter-version' }]) {
        await assert.rejects(fitCompactionSummary({ snapshot: candidate.snapshot, nodes: candidate.nextView.nodes,
            coveredEndSeq: candidate.nextView.coveredEndSeq,
            estimateCompaction: async (...args) => ({ ...await estimateCompaction(...args), ...mismatch }) }),
        { code: 'CONTEXT_MODEL_STALE' });
    }
    assert.equal(fixture.model.calls.length, calls);
    assert.equal(fixture.port.commits, 0);
});

test('the actual additional consumed input is included before generation', async () => {
    const fixture = setup();
    const previous = wireTokens((await fixedView(fixture)).view);
    const round = fixture.port.capture.rounds.at(-1);
    const item = fixture.port.appendItem('new-consumed-input', { text: '新输入"保持现有义务"'.repeat(15), references: [] },
        { role: 'user', roundId: round.roundId, stepId: 'new-input-step', kind: 'input_consumed' });
    round.itemIds.push(item.itemId);
    round.lastSeq = item.seq;
    const fixedInputTokens = wireTokens((await fixedView(fixture)).view);
    assert.ok(fixedInputTokens > previous);
    await fixture.service.buildView(fixture.input);
    const budget = fixture.model.calls[0].snapshot.requestBudget;
    assert.equal(budget.fixedInputTokens, fixedInputTokens);
    assert.equal(budget.summaryBudget, fixture.limits.target - fixedInputTokens - 1);
    assert.equal(fixture.model.calls[0].snapshot.snapshotAppendSeq, item.seq);
});

test('publication checks the current native request again before committing a ready candidate', async () => {
    const fixture = setup();
    fixture.port.beforeSave = candidate => {
        if (candidate.state !== 'ready') return;
        fixture.port.beforeSave = null;
        fixture.baseView.tools[0].description += 'new-current-schema '.repeat(1500);
    };
    await assert.rejects(fixture.service.buildView(fixture.input), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.ok(fixture.model.calls.length > 0);
    assert.equal(fixture.port.commits, 0);
    assert.equal(fixture.port.capture.viewRevision, 0);
});

test('a fully measured summary remains readable when the provider window exceeds the explicit local window', async () => {
    const quote = 'retain this verified continuing requirement '.repeat(40);
    const fixture = setup({ schemaBytes: 500, retainedText: 'recent retained input',
        historicalText: `${quote}\n${'ordinary source detail '.repeat(120)}`,
        policy: { localContextWindowTokens: 16384 }, compressionModel: { contextWindow: 1048576 } });
    fixture.limits = computeContextLimits(16384, 4096, fixture.config.policy);
    fixture.input.compression.limits = fixture.limits;
    fixture.model.onGenerate = async (request, signal, result) => {
        const span = request.chunk.sourceSpans.find(entry => entry.purpose === 'target');
        result.digest = { body: 'Verified history with its continuing obligation', skeleton: 'Verified history', title: 'Verified history',
            unresolved: [{ id: `local-window-live-${request.chunk.roundId}`, quote, source: { ...span,
                endByte: span.startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) } }] };
        return result;
    };
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'hard', limits: fixture.limits, estimateCompaction });
    const candidate = await handle.completion;
    const rendered = renderSummary(candidate.nextView.nodes, fixture.config.policy, candidate.nextView.summaryBudget);
    assert.ok(rendered.tokens > fixture.limits.summaryBudget);
    assert.ok(rendered.tokens < fixture.limits.target);
    const built = await fixture.service.buildView(fixture.input);
    assert.equal(fixture.port.commits, 1);
    assert.ok(wireTokens(built.view) < fixture.limits.target);
    assert.equal(candidate.nextView.nodes[0].unresolved.length, 3);
    assert.ok(JSON.stringify(built.view).includes(quote));
    await assert.rejects(fixture.service.buildView({ ...fixture.input, compression: undefined,
        summaryBudget: fixture.limits.summaryBudget }), { code: 'CONTEXT_SUMMARY_BUDGET' });
});

test('legacy snapshots without native request budgets preserve the original start and publish interface', async () => {
    const fixture = setup();
    const { candidate } = await ready(fixture, 'hard');
    assert.equal(candidate.snapshot.requestBudget, undefined);
    assert.equal(candidate.nextView.summaryBudget, undefined);
    assert.ok(fixture.model.calls.every(request => JSON.parse(request.chunk.body).requestBudget === undefined));
    await fixture.compactor.publish(fixture.port.capture.conversationId, 12);
    assert.equal(fixture.port.commits, 1);
});

test('readonly budget estimates reject another CID, execution lease, epoch and append regression', async () => {
    const fixture = setup();
    const { candidate } = await ready(fixture);
    const estimate = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const summary = { coveredEndSeq: candidate.snapshot.coveredEndSeq, text: '', tokens: 0 };
    for (const snapshot of [{ ...candidate.snapshot, conversationId: 'other-CID' },
        { ...candidate.snapshot, execution: { ...candidate.snapshot.execution, runEpoch: 90 } },
        { ...candidate.snapshot, historyEpoch: 90 }, { ...candidate.snapshot, snapshotAppendSeq: 999 }]) {
        await assert.rejects(estimate(snapshot, summary), { code: 'CONTEXT_HISTORY_STALE' });
    }
    assert.equal(fixture.port.commits, 0);
});

test('a persisted budgeted ready candidate publishes through a cold ContextService without another model request', async () => {
    const fixture = setup();
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'hard', limits: fixture.limits, estimateCompaction });
    const candidate = await handle.completion;
    assert.ok(candidate.snapshot.requestBudget);
    const calls = fixture.model.calls.length;
    const cold = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model });
    const built = await new ContextService({ compactor: cold }).buildView(fixture.input);
    assert.equal(fixture.port.commits, 1);
    assert.equal(fixture.model.calls.length, calls);
    assert.ok(wireTokens(built.view) < fixture.limits.target);
    assert.deepEqual(fixture.port.candidates.get(candidate.candidateId).snapshot.requestBudget, candidate.snapshot.requestBudget);
});

test('background generation accepts a normal appended tail and remeasures it before the formal publication', async () => {
    const fixture = setup();
    let release;
    let entered;
    const generating = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    fixture.model.onGenerate = async (request, signal, result) => {
        entered();
        await held;
        const span = request.chunk.sourceSpans.find(entry => entry.purpose === 'target');
        const quote = 'ordinary historical source fact';
        result.digest = { body: 'verified fact '.repeat(110), skeleton: 'Verified facts with source anchors', title: 'Verified facts',
            unresolved: [{ id: `append-live-${request.chunk.roundId}`, quote, source: { ...span,
                endByte: span.startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) } }] };
        return result;
    };
    const estimateCompaction = fixture.service.createCompactionEstimator(fixture.input, fixture.port.capture.execution);
    const handle = await fixture.compactor.start({ conversationId: fixture.input.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background', limits: fixture.limits, estimateCompaction });
    await generating;
    const frozen = structuredClone(fixture.port.candidates.get(handle.candidateId).snapshot);
    const round = fixture.port.capture.rounds.at(-1);
    const text = 'Normal appended tool-independent input '.repeat(35);
    const item = fixture.port.appendItem('ordinary-appended-tail', { text, references: [] },
        { role: 'user', roundId: round.roundId, stepId: 'next-normal-step', kind: 'input_consumed' });
    round.itemIds.push(item.itemId);
    round.lastSeq = item.seq;
    fixture.port.capture.execution = { ...fixture.port.capture.execution, stepId: 'next-normal-step' };
    release();
    const candidate = await handle.completion;
    const built = await fixture.service.buildView({ ...fixture.input,
        compression: { ...fixture.input.compression, execution: fixture.port.capture.execution, stepSeq: 13 } });
    assert.ok(built.history.appendSeq > frozen.snapshotAppendSeq);
    assert.equal(candidate.snapshot.snapshotAppendSeq, frozen.snapshotAppendSeq);
    assert.equal(candidate.snapshot.sourcePrefixHash, frozen.sourcePrefixHash);
    assert.equal(candidate.snapshot.sourceManifestHash, frozen.sourceManifestHash);
    assert.equal(candidate.nextView.nodes[0].unresolved.length, 3);
    assert.ok(built.view.messages.some(message => message.role === 'user' && message.content === text));
    assert.ok(JSON.stringify(built.view).includes('ordinary historical source fact'));
    assert.ok(wireTokens(built.view) < fixture.limits.target);
    assert.equal(fixture.port.commits, 1);
    console.log(JSON.stringify({ backgroundAppend: true, frozenAppendSeq: frozen.snapshotAppendSeq,
        publishedAppendSeq: built.history.appendSeq, completeNativeInput: wireTokens(built.view), target: fixture.limits.target,
        sourcePrefixUnchanged: true, activeObligations: candidate.nextView.nodes[0].unresolved.length, apiCalls: 0 }));
});

test('async native summary injection is measured through the same serializer without a guessed escaping multiplier', async () => {
    const fixture = setup();
    fixture.input.injectSummary = async (view, text) => injectSummaryText(view, text ? `Current memory:\n${text}\nEnd memory` : '');
    const fixedInputTokens = wireTokens((await fixedView(fixture)).view);
    const built = await fixture.service.buildView(fixture.input);
    assert.equal(fixture.model.calls[0].snapshot.requestBudget.fixedInputTokens, fixedInputTokens);
    assert.ok(wireTokens(built.view) < fixture.limits.target);
    assert.ok(JSON.stringify(built.view).includes('Current memory:'));
});

test('fold generation receives the same frozen native headroom and publication remains below target', async () => {
    const fixture = setup({ policy: { stableHeadBatches: 0, stableTailBatches: 0, maxActiveNodes: 3, foldAfterBatches: 3 } });
    await ready(fixture);
    await fixture.compactor.publish(fixture.input.conversationId, 12);
    fixture.port.capture.rounds.at(-1).complete = true;
    for (let ordinal = 7; ordinal <= 12; ordinal++) appendRound(fixture, ordinal,
        ordinal <= 9 ? 'additional ordinary historical fact\n'.repeat(360) : 'retained original '.repeat(105), ordinal === 12);
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    fixture.input.compression.execution = fixture.port.capture.execution;
    fixture.model.onGenerate = async (request, signal, result) => {
        assert.ok(request.snapshot.requestBudget?.summaryBudget > 0);
        assert.deepEqual(JSON.parse(request.chunk.body).requestBudget, request.snapshot.requestBudget);
        result.digest.body = 'verified foldable fact '.repeat(55);
        result.digest.skeleton = result.digest.body;
        return result;
    };
    const calls = fixture.model.calls.length;
    const built = await fixture.service.buildView(fixture.input);
    assert.ok(fixture.model.calls.slice(calls).some(request => request.reason === 'fold'));
    assert.equal(fixture.port.commits, 2);
    assert.ok(wireTokens(built.view) < fixture.limits.target);
});

test('readonly candidate7 files retain their original hashes and expose the static-versus-native deficit',
    { skip: !process.env.CONTEXT_HEADROOM_ORIGINAL }, async () => {
        const directory = process.env.CONTEXT_HEADROOM_ORIGINAL;
        const names = ['result.json', 'current-native-view.json', 'future-input-minimum-view.json'];
        const original = await Promise.all(names.map(name => readFile(join(directory, name))));
        const [result, current, future] = original.map(bytes => JSON.parse(bytes));
        assert.match(result.conversationId, /^[a-f0-9-]{36}$/);
        if (process.env.CONTEXT_HEADROOM_EXPECTED_CID) assert.equal(result.conversationId, process.env.CONTEXT_HEADROOM_EXPECTED_CID);
        assert.deepEqual(result.originalVersion, { historyEpoch: 1, appendSeq: 27, viewRevision: 1 });
        assert.equal(result.futureInput.minimumInputAfterEligiblePrefixAndNewUser, 12039);
        assert.equal(result.futureInput.maximumEncodedSummaryIncreaseStrictlyUnderTarget, 7620);
        assert.equal(result.limits.summaryBudget, 9830);
        assert.equal(current.tools.length, 7);
        assert.deepEqual(current.tools, future.tools);
        const summary = current.messages.find(message => message.role === 'system' && message.content.startsWith('[summary '));
        assert.ok(summary);
        assert.equal(Buffer.byteLength(summary.content), 8378);
        const noSummary = { ...current, messages: current.messages.filter(message => message !== summary) };
        assert.equal(wireTokens(current) - wireTokens(noSummary), 8764);
        assert.ok(wireTokens(injectSummaryText(future, summary.content)) >= result.limits.target);
        assert.deepEqual(await Promise.all(names.map(name => readFile(join(directory, name)).then(hashBytes))), original.map(hashBytes));
        console.log(JSON.stringify({ originalFilesReadOnly: true, tools: future.tools.length, rawSummaryBytes: 8378,
            encodedSummaryIncrease: 8764, frozenNativeViewFloor: 12039, frozenHeadroom: 7620,
            fullAdapterFloorForLocalParameters: wireTokens(future), localHeadroom: result.limits.target - wireTokens(future) - 1,
            originalRecordsSha256: result.originalRecordsSha256, apiCalls: 0 }));
    });
