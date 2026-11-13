import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextService, hashContext } from '../index.ts';
import { GeminiAdapter, normalizeGeminiResponse } from '../../providers/gemini.ts';
import { normalizeChatResponse } from '../../providers/compatible-chat.ts';
import { createFixture } from '../../../../tests/agent/local/context-fixtures.mjs';

function history(response, protocol, { followup = true } = {}) {
    const fixture = createFixture({ rounds: 0 });
    const { port } = fixture;
    const append = (id, value, role, stepId = id, callId) => port.appendItem(id, value, { role, roundId: 'original-round',
        stepId, kind: role === 'user' ? 'input_consumed' : role === 'tool' ? 'tool_result' : 'model_step', providerProtocol: protocol,
        ...(callId ? { callId } : {}) });
    append('source-user', { text: 'Original source task.', references: [] }, 'user');
    append('source-model', { kind: 'model', protocol, response }, 'assistant', 'model-step');
    for (const call of response.toolCalls) append(`result-${call.callId}`, { kind: 'tool', result: {
        callId: call.callId, name: call.name, result: { ok: true, data: 'actual original tool result' } } }, 'tool', 'model-step', call.callId);
    if (followup) append('target-user', { text: 'Continue the current task using the selected target model.', references: [] }, 'user');
    const input = { conversationId: port.capture.conversationId, modelId: 'gemini-target', adapter: new GeminiAdapter(),
        baseView: { protocol: 'gemini', systemInstruction: { parts: [{ text: 'Task rules.' }] } },
        context: { signal: new AbortController().signal, readHistory: query => port.readHistory({ ...query, conversationId: port.capture.conversationId }),
            readContent: contentId => port.readContent(port.capture.conversationId, contentId) } };
    return { fixture, input, service: new ContextService() };
}

const chat = () => normalizeChatResponse('chat-attempt', { httpStatus: 200, headers: {}, body: '{}', json: {
    model: 'chat-source', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Observed source facts.',
        tool_calls: [{ id: 'original-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"source.txt"}' } }] } }] } });

test('ContextService converts a paired Chat history into Gemini and preserves original call IDs and source hashes', async () => {
    const { fixture, input, service } = history(chat(), 'compatible_chat');
    const original = hashContext([...fixture.port.contents]);
    const result = await service.buildView(input);
    const parts = result.view.contents.flatMap(message => message.parts);
    assert.ok(parts.some(part => part.functionCall?.id === 'original-call'));
    assert.ok(parts.some(part => part.functionResponse?.id === 'original-call'));
    assert.match(result.view.contents.at(-1).parts[0].text, /selected target model/);
    assert.equal(result.historyTransferProvenance[0].operation, 'target_protocol_view');
    assert.equal(result.historyTransferProvenance[0].itemId, 'source-model');
    assert.equal(hashContext([...fixture.port.contents]), original);
    assert.equal(fixture.model.calls.length, 0);
    assert.doesNotThrow(() => input.adapter.encode(result.view, input.modelId, { maxOutputTokens: 512 }));
});

test('runtime dynamic context cannot replace the actual user turn required after imported Gemini tool history', async () => {
    const { input, service } = history(chat(), 'compatible_chat', { followup: false });
    await assert.rejects(service.buildView({ ...input, dynamicContext: 'A runtime workspace snapshot.' }),
        error => error.code === 'E_HISTORY_TARGET_TURN_REQUIRED');
});

test('signed native history uses frozen request model identity rather than a returned model alias', async () => {
    const response = normalizeGeminiResponse('gemini-attempt', { httpStatus: 200, headers: {}, body: '{}', json: {
        modelVersion: 'returned-version-alias', candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model',
            parts: [{ text: 'Original signed result.', thoughtSignature: 'original-signature-bytes' }] } }] } });
    const { input, service } = history(response, 'gemini');
    const resolved = await service.buildView({ ...input, targetEndpoint: 'https://fixture.invalid/generate',
        resolveHistoryIdentity: async () => ({ modelId: 'gemini-target', endpoint: 'https://fixture.invalid/generate' }) });
    assert.ok(resolved.view.contents.flatMap(message => message.parts).some(part => part.thoughtSignature === 'original-signature-bytes'));
    await assert.rejects(service.buildView({ ...input, resolveHistoryIdentity: async () => ({ modelId: null }) }),
        error => error.code === 'E_HISTORY_SIGNATURE_INCOMPATIBLE' && error.details.issues[0].itemId === 'source-model');
});
