import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextService } from '../../../src/agent-server/context/service.ts';
import { appendNativeHistoryView, freezeNativeHistoryView } from '../../../src/agent-server/context/native-view-build.ts';
import { CompatibleChatAdapter, normalizeChatResponse } from '../../../src/agent-server/providers/compatible-chat.ts';
import { GeminiAdapter, normalizeGeminiResponse } from '../../../src/agent-server/providers/gemini.ts';
import { AnthropicAdapter, normalizeAnthropicResponse } from '../../../src/agent-server/providers/anthropic.ts';
import { OpenAIResponsesAdapter, normalizeResponsesResponse } from '../../../src/agent-server/providers/openai-responses.ts';
import { computeContextLimits, totalContextTokens } from '../../../src/agent-server/context/budget.ts';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { FixturePort, execution, fixtureConfig, fixtureModel } from './context-fixtures.mjs';

const raw = json => ({ httpStatus: 200, headers: {}, json, body: JSON.stringify(json) });

function addUser(port, ordinal) {
    return port.appendItem(`owned-view-user-${ordinal}`, { text: `ordinary owned report input ${ordinal}`, references: [] },
        { role: 'user', roundId: `owned-round-${ordinal}`, stepId: `owned-user-step-${ordinal}`, kind: 'input_consumed' });
}

function addNormalModel(port, ordinal) {
    const response = normalizeChatResponse(`owned-normal-${ordinal}`, raw({ id: `owned-normal-response-${ordinal}`, model: fixtureModel.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `ordinary owned answer ${ordinal}`,
            native_extension: { retained: ordinal } }, finish_reason: 'stop' }] }));
    port.appendItem(`owned-view-model-${ordinal}`, { kind: 'model', protocol: 'compatible_chat', response },
        { role: 'assistant', roundId: `owned-round-${ordinal}`, stepId: `owned-model-step-${ordinal}`, kind: 'model_step', providerProtocol: 'compatible_chat' });
}

function fixture(beforeRequest, options = {}) {
    const port = new FixturePort();
    addUser(port, 1);
    addNormalModel(port, 1);
    const reads = [];
    const controller = new AbortController();
    const context = { signal: controller.signal, readHistory: query => {
        reads.push({ kind: 'metadata', ...query });
        return port.readHistory({ ...query, view: 'raw', effectiveOnly: true });
    }, readContent: contentId => {
        reads.push({ kind: 'content', contentId });
        return port.readContent(port.capture.conversationId, contentId);
    } };
    const config = fixtureConfig();
    const service = new ContextService({ ...options, compactor: { beforeRequest: input => beforeRequest(input, port) },
        readSummaryView: async () => structuredClone(port.capture.view) });
    const input = { conversationId: port.capture.conversationId, context, adapter: new CompatibleChatAdapter(), modelId: fixtureModel.model,
        baseView: { protocol: 'compatible_chat', messages: [{ role: 'system', content: 'ordinary owned rules' }] },
        compression: { execution: execution(), config, stepSeq: port.capture.stepSeq,
            limits: computeContextLimits(fixtureModel.contextWindow, fixtureModel.maxOutputTokens, config.policy) } };
    return { port, reads, service, input };
}

test('one request reuses the exact frozen native view while repeated estimates see unchanged bounded history metadata', async () => {
    const estimates = [];
    const owned = fixture(async input => {
        for (let ordinal = 0; ordinal < 3; ordinal++) estimates.push(await input.estimate());
        return { estimate: estimates.at(-1), inputTokens: totalContextTokens(estimates.at(-1)), backgroundCandidateId: null };
    });
    const built = await owned.service.buildView(owned.input);
    assert.equal(owned.reads.filter(read => read.kind === 'content').length, 2);
    assert.equal(owned.reads.filter(read => read.kind === 'metadata' && read.limit === 1).length, 3);
    assert.equal(owned.reads.filter(read => read.kind === 'metadata' && read.limit !== 1).length, 1);
    assert.ok(estimates.every(estimate => estimate === built.estimate));
    assert.ok(Object.isFrozen(built.view));
    assert.ok(Object.isFrozen(built.view.messages));
    assert.deepEqual(built.view.messages.at(-1).native_extension, { retained: 1 });
    console.log(JSON.stringify({ completeBuilds: 1, metadataChecks: 3, originalContentsRead: 2, viewFrozen: true, paidRequests: 0 }));
});

test('conversation version metadata replaces repeated history-page checks without reading original contents again', async () => {
    const versions = [];
    const estimates = [];
    const owned = fixture(async input => {
        for (let ordinal = 0; ordinal < 3; ordinal++) estimates.push(await input.estimate());
        return { estimate: estimates.at(-1), inputTokens: totalContextTokens(estimates.at(-1)), backgroundCandidateId: null };
    }, { readVersionState: async conversationId => {
        versions.push(conversationId);
        const { historyEpoch, appendSeq, viewRevision } = owned.port.capture;
        return { historyEpoch, appendSeq, viewRevision };
    } });
    const built = await owned.service.buildView(owned.input);
    assert.deepEqual(versions, Array(3).fill(owned.input.conversationId));
    assert.equal(owned.reads.filter(read => read.kind === 'metadata').length, 1);
    assert.equal(owned.reads.filter(read => read.kind === 'metadata' && read.limit === 1).length, 0);
    assert.equal(owned.reads.filter(read => read.kind === 'content').length, 2);
    assert.ok(estimates.every(estimate => estimate === built.estimate));
    assert.ok(Object.isFrozen(built.view.messages));
});

test('post-step reuse and the following request use only fresh conversation versions for both fences', async () => {
    let versionReads = 0;
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    }, { readVersionState: async () => {
        versionReads++;
        const { historyEpoch, appendSeq, viewRevision } = owned.port.capture;
        return { historyEpoch, appendSeq, viewRevision };
    } });
    const offered = await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    const before = owned.reads.length;
    const consumed = await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    assert.equal(versionReads, 2);
    assert.equal(owned.reads.length, before);
    assert.deepEqual(consumed.view, offered.view);
    assert.notStrictEqual(consumed.view.messages, offered.view.messages);
    assert.equal(owned.service.readTails.size, 0);
    assert.equal(owned.service.readTailBytes, 0);
});

for (const field of ['appendSeq', 'historyEpoch', 'viewRevision']) test(`fresh conversation ${field} invalidates a reused original tail`, async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    }, { readVersionState: async () => {
        const { historyEpoch, appendSeq, viewRevision } = owned.port.capture;
        return { historyEpoch, appendSeq, viewRevision };
    } });
    await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    if (field === 'appendSeq') addUser(owned.port, 2);
    else {
        owned.port.capture[field]++;
        if (field === 'historyEpoch') owned.port.capture.view.historyEpoch = owned.port.capture.historyEpoch;
        else owned.port.capture.view.revision = owned.port.capture.viewRevision;
    }
    const before = owned.reads.length;
    const built = await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    assert.equal(built.history[field], owned.port.capture[field]);
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, field === 'appendSeq' ? 3 : 2);
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'metadata' && read.limit === 1).length, 0);
});

test('a legacy version source without metadata falls back to the original page budget and last-item fence', async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    }, { readVersionState: async () => undefined });
    await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    const before = owned.reads.length;
    await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    const checks = owned.reads.slice(before).filter(read => read.kind === 'metadata');
    assert.equal(checks.length, 2);
    assert.ok(checks.every(check => check.limit === 1 && check.maxBytes === owned.reads[0].maxBytes));
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, 0);
});

test('conversation metadata read errors retain the original failure without a second history request', async () => {
    const failure = Object.assign(new Error('owned version source unavailable'), { code: 'STORAGE_UNAVAILABLE' });
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    }, { readVersionState: async () => { throw failure; } });
    await assert.rejects(owned.service.buildView(owned.input), error => error === failure);
    assert.equal(owned.reads.filter(read => read.kind === 'metadata').length, 1);
});

test('a validated post-step tail is consumed once while native assembly and caller callbacks run again', async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    const offered = await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    assert.equal(owned.service.readTails.size, 1);
    assert.ok(owned.service.readTailBytes > 0);
    const before = owned.reads.length;
    const consumed = await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    assert.deepEqual(consumed.view, offered.view);
    assert.notEqual(consumed.view, offered.view);
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, 0);
    assert.ok(owned.reads.slice(before).filter(read => read.kind === 'metadata').every(read => read.limit === 1));
    assert.equal(owned.service.readTails.size, 0);
    assert.equal(owned.service.readTailBytes, 0);
    const consumedReads = owned.reads.length;
    await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    assert.equal(owned.reads.slice(consumedReads).filter(read => read.kind === 'content').length, 2);
});

for (const field of ['appendSeq', 'historyEpoch', 'viewRevision']) test(`read-tail reuse reloads normal history after ${field} changes`, async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    if (field === 'appendSeq') addUser(owned.port, 2);
    else {
        owned.port.capture[field]++;
        owned.port.capture.view = { ...owned.port.capture.view, historyEpoch: owned.port.capture.historyEpoch, revision: owned.port.capture.viewRevision };
    }
    const before = owned.reads.length;
    const built = await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    assert.equal(built.history[field], owned.port.capture[field]);
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, field === 'appendSeq' ? 3 : 2);
    assert.equal(owned.service.readTails.size, 0);
});

test('a new execution context and explicit cleanup do not reuse the previous owned tail', async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    const before = owned.reads.length;
    await owned.service.buildView({ ...owned.input, context: { ...owned.input.context }, readTailReuse: 'consume' });
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, 2);
    await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    owned.service.releaseReadTail(owned.input.conversationId);
    assert.equal(owned.service.readTails.size, 0);
    assert.equal(owned.service.readTailBytes, 0);
});

test('read-tail reuse renders tool results freshly for each native request', async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    addUser(owned.port, 2);
    const response = normalizeChatResponse('owned-reuse-tool-response', raw({ id: 'owned-reuse-tool-response', model: fixtureModel.model,
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'owned-reuse-call', type: 'function',
            function: { name: 'read_file', arguments: '{"path":"ordinary.txt"}' } }] }, finish_reason: 'tool_calls' }] }));
    owned.port.appendItem('owned-reuse-model', { kind: 'model', protocol: 'compatible_chat', response },
        { role: 'assistant', roundId: 'owned-round-2', stepId: 'owned-reuse-step', kind: 'model_step', providerProtocol: 'compatible_chat' });
    owned.port.appendItem('owned-reuse-tool', { kind: 'tool', protocol: 'compatible_chat', result: { callId: response.toolCalls[0].callId,
        name: 'read_file', result: { content: 'ordinary source result' } } },
        { role: 'tool', roundId: 'owned-round-2', stepId: 'owned-reuse-step', kind: 'tool_step', providerProtocol: 'compatible_chat', callId: response.toolCalls[0].callId });
    let renders = 0;
    const renderToolResults = async (view, results) => {
        renders++;
        return results.map(result => ({ ...result, result: { content: `fresh ordinary result ${renders}` } }));
    };
    const offered = await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer', renderToolResults });
    const before = owned.reads.length;
    const consumed = await owned.service.buildView({ ...owned.input, readTailReuse: 'consume', renderToolResults });
    assert.equal(renders, 2);
    assert.match(offered.view.messages.at(-1).content, /fresh ordinary result 1/);
    assert.match(consumed.view.messages.at(-1).content, /fresh ordinary result 2/);
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, 0);
    assert.ok(Object.isFrozen(consumed.view.messages));
});

test('reused original tails preserve signed Gemini, Anthropic and Responses native fields', async () => {
    const cases = [
        { protocol: 'gemini', adapter: new GeminiAdapter(), model: 'owned-cache-gemini', field: 'contents',
            response: normalizeGeminiResponse('owned-cache-gemini', raw({ modelVersion: 'owned-cache-gemini', candidates: [{ index: 0,
                finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ordinary signed answer', thoughtSignature: 'owned-exact-signature', native_extension: { keep: true } }] } }] })) },
        { protocol: 'anthropic', adapter: new AnthropicAdapter(), model: 'owned-cache-anthropic', field: 'messages',
            response: normalizeAnthropicResponse('owned-cache-anthropic', raw({ id: 'owned-cache-anthropic', type: 'message', role: 'assistant', model: 'owned-cache-anthropic', stop_reason: 'end_turn',
                content: [{ type: 'thinking', thinking: 'ordinary fixture thinking', signature: 'owned-exact-signature' }, { type: 'text', text: 'ordinary answer' }] })) },
        { protocol: 'openai_responses', adapter: new OpenAIResponsesAdapter(), model: 'owned-cache-responses', field: 'input',
            response: normalizeResponsesResponse('owned-cache-responses', raw({ id: 'owned-cache-responses', model: 'owned-cache-responses', status: 'completed',
                output: [{ id: 'owned-cache-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ordinary answer', annotations: [] }] }] })) },
    ];
    for (const entry of cases) {
        const port = new FixturePort();
        addUser(port, 1);
        port.appendItem('owned-cache-native', { kind: 'model', protocol: entry.protocol, response: entry.response },
            { role: 'assistant', roundId: 'owned-round-1', stepId: 'owned-native-cache-step', kind: 'model_step', providerProtocol: entry.protocol });
        const reads = [];
        const context = { signal: new AbortController().signal,
            readHistory: query => port.readHistory({ ...query, view: 'raw', effectiveOnly: true }),
            readContent: contentId => { reads.push(contentId); return port.readContent(port.capture.conversationId, contentId); } };
        const service = new ContextService();
        const input = { conversationId: port.capture.conversationId, context, adapter: entry.adapter, modelId: entry.model,
            baseView: { protocol: entry.protocol, [entry.field]: [] } };
        const offered = await service.buildView({ ...input, readTailReuse: 'offer' });
        const before = reads.length;
        const consumed = await service.buildView({ ...input, readTailReuse: 'consume' });
        assert.deepEqual(consumed.view, offered.view);
        assert.equal(reads.length, before);
        assert.ok(Object.isFrozen(consumed.view));
        assert.equal(service.readTails.size, 0);
    }
});

test('a complete tail larger than the reuse item bound follows the original full read path', async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    for (let ordinal = 2; ordinal <= 257; ordinal++) { addUser(owned.port, ordinal); addNormalModel(owned.port, ordinal); }
    const offered = await owned.service.buildView({ ...owned.input, compression: undefined, readTailReuse: 'offer' });
    assert.equal(offered.history.loadedItems, 514);
    assert.equal(owned.service.readTails.size, 0);
    const before = owned.reads.length;
    const consumed = await owned.service.buildView({ ...owned.input, readTailReuse: 'consume' });
    assert.deepEqual(consumed.view, offered.view);
    assert.equal(owned.reads.slice(before).filter(read => read.kind === 'content').length, 514);
});

test('normal history append rebuilds the complete view instead of reusing the previous appendSeq', async () => {
    const owned = fixture(async (input, port) => {
        await input.estimate();
        addUser(port, 2);
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    const built = await owned.service.buildView(owned.input);
    assert.equal(owned.reads.filter(read => read.kind === 'content').length, 5);
    assert.equal(built.history.appendSeq, owned.port.capture.appendSeq);
    assert.equal(built.history.loadedItems, 3);
    assert.equal(built.view.messages.at(-1).content, 'ordinary owned report input 2');
});

for (const field of ['historyEpoch', 'viewRevision']) test(`${field} changes rebuild and retain the current complete native history`, async () => {
    const owned = fixture(async (input, port) => {
        await input.estimate();
        port.capture[field]++;
        port.capture.view = { ...port.capture.view, historyEpoch: port.capture.historyEpoch, revision: port.capture.viewRevision };
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    const built = await owned.service.buildView(owned.input);
    assert.equal(owned.reads.filter(read => read.kind === 'content').length, 4);
    assert.equal(built.history[field], owned.port.capture[field]);
    assert.equal(built.history.loadedItems, 2);
    assert.equal(built.view.messages.at(-1).content, 'ordinary owned answer 1');
});

test('an explicit caller summary keeps the original fresh-store rebuild rule', async () => {
    const owned = fixture(async input => {
        const estimate = await input.estimate();
        return { estimate, inputTokens: totalContextTokens(estimate), backgroundCandidateId: null };
    });
    owned.input.summaryView = structuredClone(owned.port.capture.view);
    await owned.service.buildView(owned.input);
    assert.equal(owned.reads.filter(read => read.kind === 'content').length, 4);
});

test('history append shares its private prefix, final freeze detaches every original native field and public continuation stays immutable', () => {
    const native = { role: 'assistant', content: null, reasoning_content: 'ordinary opaque native reasoning', native_extension: { retained: true },
        tool_calls: [{ id: 'owned-native-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"owned.txt"}' } }] };
    const response = normalizeChatResponse('owned-native-response', raw({ id: 'owned-native-response', model: fixtureModel.model,
        choices: [{ index: 0, message: native, finish_reason: 'tool_calls' }] }));
    const results = [{ callId: 'owned-native-call', name: 'read_file', result: { content: 'ordinary owned report' } }];
    const base = { protocol: 'compatible_chat', messages: [{ role: 'user', content: 'read the ordinary owned report',
        native_extension: { first: true } }], tools: [{ name: 'read_file', parameters: { type: 'object' } }] };
    const adapter = new CompatibleChatAdapter();
    const publicView = adapter.continueView(base, response, results);
    let fastCalls = 0;
    const fastAdapter = { protocol: adapter.protocol, continueView: () => assert.fail('history used the public copying path'),
        continueHistoryView(view, current, toolResults) {
            fastCalls++;
            const segment = adapter.continueView({ protocol: view.protocol, messages: [] }, current, toolResults);
            return { ...view, messages: [...view.messages, ...segment.messages] };
        } };
    const staged = appendNativeHistoryView(fastAdapter, base, response, results);
    assert.equal(fastCalls, 1);
    assert.strictEqual(staged.messages[0], base.messages[0]);
    const final = freezeNativeHistoryView(staged);
    assert.equal(canonicalJson(final), canonicalJson(publicView));
    assert.notStrictEqual(final.messages[0], base.messages[0]);
    assert.notStrictEqual(final.messages[1], response.replayMessages[0]);
    assert.ok(Object.isFrozen(final.messages[1].native_extension));
    assert.ok(Object.isFrozen(publicView.messages));
    assert.ok(!Object.isFrozen(base.messages[0]));
    base.messages[0].native_extension.first = false;
    assert.equal(final.messages[0].native_extension.first, true);
    assert.equal(publicView.messages[0].native_extension.first, true);
});

test('a legacy adapter without the optional history method keeps its original continuation contract', () => {
    const view = { protocol: 'compatible_chat', messages: [] };
    let called = 0;
    const legacy = { protocol: 'compatible_chat', continueView(current) { called++; return { ...current, messages: [{ role: 'assistant', content: 'ordinary legacy result' }] }; } };
    const built = appendNativeHistoryView(legacy, view, {}, []);
    assert.equal(called, 1);
    assert.equal(built.messages[0].content, 'ordinary legacy result');
    assert.equal(view.messages.length, 0);
});
