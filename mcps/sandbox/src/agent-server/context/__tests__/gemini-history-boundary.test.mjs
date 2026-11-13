import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactor, ContextService, hashContext } from '../index.ts';
import { GeminiAdapter, encodeGeminiCountTokensRequest, normalizeGeminiResponse } from '../../providers/gemini.ts';
import { normalizeChatResponse } from '../../providers/compatible-chat.ts';
import { appendTransferredHistory, validateHistoryTransferBoundary } from '../../providers/history-transfer.ts';
import { createFixture } from '../../../../tests/agent/local/context-fixtures.mjs';

const modelId = 'gemini-3.8-flash';
const parameters = { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } };
const boundaryLabel = '[Runtime history boundary; not an original user message]';
const adapter = new GeminiAdapter();

function toolExchange(ordinal, name = 'read_file') {
    const callId = `original-call-${ordinal}`;
    const response = normalizeGeminiResponse(`original-attempt-${ordinal}`, { httpStatus: 200, headers: {}, body: '{}', json: {
        modelVersion: modelId, candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [
            { functionCall: { name, id: callId, args: { path: 'source.txt' } }, thoughtSignature: `original-signature-${ordinal}+/==` },
            { text: '' },
        ] } }],
    } });
    return { itemId: `original-model-${ordinal}`, sourceProtocol: 'gemini', sourceModelId: modelId, response,
        results: [{ callId, name, result: { data: `Original tool result ${ordinal}` } }] };
}

function retainedView() {
    let view = { protocol: 'gemini', systemInstruction: { parts: [{ text: '[summary fixture]\nEarlier task context.' }] } };
    for (const exchange of [toolExchange(1, 'mark_history_hit'), toolExchange(2)]) {
        view = appendTransferredHistory(adapter, view, exchange, modelId).view;
    }
    return { ...view, contents: [...view.contents, { role: 'user', parts: [{ text: 'Continue the original task.' }] }] };
}

test('Gemini encodes the compacted five-turn tool-call prefix without changing retained native content', () => {
    const view = retainedView();
    const original = hashContext(view);
    assert.deepEqual(view.contents.map(message => message.role), ['model', 'user', 'model', 'user', 'user']);
    const body = adapter.encode(view, modelId, parameters);
    assert.equal(body.contents[0].role, 'user');
    assert.ok(body.contents[0].parts[0].text.startsWith(boundaryLabel));
    assert.deepEqual(body.contents.slice(1), view.contents);
    assert.deepEqual(body.systemInstruction, view.systemInstruction);
    assert.equal(hashContext(view), original);
    assert.deepEqual(adapter.encodeForMeasurement(view, modelId, parameters), body);
    assert.deepEqual(encodeGeminiCountTokensRequest(view, modelId, parameters).generateContentRequest,
        { model: `models/${modelId}`, ...body });
    assert.deepEqual(encodeGeminiCountTokensRequest(view, modelId).generateContentRequest.contents, body.contents);
    assert.deepEqual(adapter.encode({ ...view, contents: body.contents }, modelId, parameters), body);
});

test('Gemini keeps an existing initial user turn and consecutive function-response turns exactly once', () => {
    const retained = retainedView();
    const view = { ...retained, contents: [{ role: 'user', parts: [{ text: 'Original user task.' }] },
        ...retained.contents] };
    const original = hashContext(view);
    const body = adapter.encode(view, modelId, parameters);
    assert.deepEqual(body.contents, view.contents);
    assert.equal(hashContext(view), original);
    assert.equal(body.contents.filter(message => message.parts.some(part => part.text?.startsWith(boundaryLabel))).length, 0);
});

test('Gemini preserves consecutive parallel function responses and the separate follow-up user text', () => {
    const first = toolExchange(1);
    const second = toolExchange(2);
    const firstCall = first.response.toolCalls[0];
    const secondCall = second.response.toolCalls[0];
    const response = normalizeGeminiResponse('parallel-attempt', { httpStatus: 200, headers: {}, body: '{}', json: {
        modelVersion: modelId, candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [
            firstCall.native, { functionCall: secondCall.native.functionCall }, { text: '' },
        ] } }],
    } });
    const continued = adapter.continueView({ protocol: 'gemini', contents: [{ role: 'user', parts: [{ text: 'Read both files.' }] }] },
        response, [...second.results, ...first.results]);
    const view = { ...continued, contents: [...continued.contents, { role: 'user', parts: [{ text: 'Continue the task.' }] }] };
    const body = adapter.encode(view, modelId, parameters);
    assert.deepEqual(body.contents, view.contents);
    assert.deepEqual(body.contents[2].parts.map(part => part.functionResponse.id), [firstCall.providerCallId, secondCall.providerCallId]);
    assert.equal(body.contents[3].parts[0].text, 'Continue the task.');
});

test('Gemini leaves an initial model text-only measurement unchanged', () => {
    const view = { protocol: 'gemini', contents: [{ role: 'model', parts: [{ text: 'Completed answer.', thoughtSignature: 'text-signature' }] }] };
    assert.deepEqual(adapter.encodeForMeasurement(view, modelId, parameters).contents, view.contents);
});

function importedView() {
    const response = normalizeChatResponse('source-chat-attempt', { httpStatus: 200, headers: {}, body: '{}', json: {
        model: 'source-chat', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Original source text.',
            tool_calls: [{ id: 'source-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"source.txt"}' } }] } }],
    } });
    const exchange = { itemId: 'source-model', sourceProtocol: 'compatible_chat', sourceModelId: 'source-chat', response,
        results: [{ callId: 'source-call', name: 'read_file', result: { data: 'Original source tool result.' } }] };
    const original = hashContext(exchange);
    const transferred = appendTransferredHistory(adapter, { protocol: 'gemini' }, exchange, modelId);
    assert.equal(hashContext(exchange), original);
    return transferred;
}

test('Gemini repairs a converted tool prefix while preserving cross-protocol call/result provenance', () => {
    const transferred = importedView();
    const view = { ...transferred.view, contents: [...transferred.view.contents,
        { role: 'user', parts: [{ text: 'Continue using the selected target model.' }] }] };
    validateHistoryTransferBoundary(view, [transferred.provenance]);
    const body = adapter.encode(view, modelId, parameters);
    assert.ok(body.contents[0].parts[0].text.startsWith(boundaryLabel));
    assert.deepEqual(body.contents.slice(1), view.contents);
    const parts = body.contents.flatMap(message => message.parts);
    assert.equal(parts.find(part => part.functionCall).functionCall.id, 'source-call');
    assert.equal(parts.find(part => part.functionResponse).functionResponse.id, 'source-call');
    assert.ok(parts.every(part => !Object.hasOwn(part, 'thoughtSignature')));
    assert.equal(transferred.provenance.operation, 'target_protocol_view');
});

test('a runtime prefix still cannot satisfy the real follow-up user requirement for imported tool history', () => {
    const transferred = importedView();
    const body = adapter.encode(transferred.view, modelId, parameters);
    assert.throws(() => validateHistoryTransferBoundary({ ...transferred.view, contents: body.contents }, [transferred.provenance]),
        error => error.code === 'E_HISTORY_TARGET_TURN_REQUIRED');
});

test('ContextService serializes a published active-prefix cut into a legal Gemini tool history', async () => {
    const fixture = createFixture({ rounds: 0 });
    const { port } = fixture;
    const roundId = 'original-active-round';
    const input = port.appendItem('original-user', { text: 'Keep working on the original task.', references: [] },
        { role: 'user', roundId, stepId: 'original-input', kind: 'input_consumed' });
    const active = { roundId, firstSeq: input.seq, lastSeq: input.seq, itemIds: [input.itemId], complete: false,
        nativePairing: 'complete', lastStepSeq: 0 };
    port.capture.rounds.push(active);
    port.capture.activeRoundId = roundId;
    port.capture.execution.roundId = roundId;
    for (let ordinal = 1; ordinal <= 6; ordinal++) {
        const stepId = `original-step-${++port.capture.stepSeq}`;
        const exchange = toolExchange(ordinal, ordinal === 5 ? 'mark_history_hit' : 'read_file');
        const model = port.appendItem(exchange.itemId, { kind: 'model', protocol: 'gemini', requestModelId: modelId, response: exchange.response },
            { role: 'assistant', roundId, stepId, kind: 'model_step', providerProtocol: 'gemini' });
        const tool = port.appendItem(`original-result-${ordinal}`, { kind: 'tool', result: exchange.results[0] },
            { role: 'tool', roundId, stepId, callId: exchange.results[0].callId, kind: 'tool_result', providerProtocol: 'gemini' });
        active.itemIds.push(model.itemId, tool.itemId);
        active.lastSeq = port.capture.appendSeq;
        active.lastStepSeq = port.capture.stepSeq;
    }
    const originals = hashContext([...port.contents]);
    const compactor = new ContextCompactor({ port, sources: fixture.sources, model: fixture.model });
    const handle = await compactor.start({ conversationId: port.capture.conversationId, execution: port.capture.execution,
        config: fixture.config, reason: 'background' });
    assert.equal((await handle.completion).state, 'ready');
    await compactor.publish(port.capture.conversationId, port.capture.stepSeq);
    assert.ok(port.capture.view.coveredEndSeq > input.seq);
    assert.equal(hashContext([...port.contents]), originals);
    port.appendItem('real-follow-up', { text: 'Continue the original task after compression.', references: [] },
        { role: 'user', roundId: 'follow-up-round', stepId: 'follow-up-input', kind: 'input_consumed' });
    const beforeBuild = hashContext([...port.contents]);
    const result = await new ContextService().buildView({ conversationId: port.capture.conversationId, modelId, adapter,
        summaryView: structuredClone(port.capture.view),
        baseView: { protocol: 'gemini' }, context: { signal: new AbortController().signal,
            readHistory: query => port.readHistory({ ...query, conversationId: port.capture.conversationId }),
            readContent: contentId => port.readContent(port.capture.conversationId, contentId) } });
    assert.deepEqual(result.view.contents.map(message => message.role), ['model', 'user', 'model', 'user', 'user']);
    assert.ok(result.view.systemInstruction.parts.some(part => part.text.includes('[summary ')));
    const body = adapter.encode(result.view, modelId, parameters);
    assert.ok(body.contents[0].parts[0].text.startsWith(boundaryLabel));
    assert.deepEqual(body.contents.slice(1), result.view.contents);
    assert.equal(hashContext([...port.contents]), beforeBuild);
    assert.deepEqual(body.contents.slice(1).flatMap(message => message.parts).filter(part => part.thoughtSignature)
        .map(part => part.thoughtSignature), ['original-signature-5+/==', 'original-signature-6+/==']);
});
