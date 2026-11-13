import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextService, hashContext } from '../index.ts';
import { GeminiAdapter, normalizeGeminiResponse } from '../../providers/gemini.ts';
import { convertHistoryExchange, preflightHistoryTransfer } from '../../providers/history-transfer.ts';
import { createFixture } from '../../../../tests/agent/local/context-fixtures.mjs';

const modelId = 'gemini-3.8-flash';
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`;
const streamingEndpoint = endpoint.replace(':generateContent', ':streamGenerateContent?alt=sse');

function exchange() {
    const response = normalizeGeminiResponse('frozen-attempt', { httpStatus: 200, headers: {}, body: '{}', json: {
        modelVersion: 'returned-version-alias', candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [
            { functionCall: { id: 'original-call', name: 'task_plan_read', args: {} }, thoughtSignature: 'original-native-signature' },
            { text: '' },
        ] } }],
    } });
    return { itemId: 'source-model', sourceProtocol: 'gemini', sourceModelId: modelId, sourceEndpoint: streamingEndpoint,
        response, results: [{ callId: 'original-call', name: 'task_plan_read', result: { plan: null } }] };
}

test('official Gemini streamed and nonstreamed request endpoints share signed replay identity', () => {
    const original = exchange();
    const originalHash = hashContext(original);
    for (const [sourceEndpoint, targetEndpoint] of [[streamingEndpoint, endpoint], [endpoint, streamingEndpoint],
        [streamingEndpoint, streamingEndpoint], [endpoint, endpoint]]) {
        const converted = convertHistoryExchange({ ...original, sourceEndpoint }, { protocol: 'gemini', modelId, endpoint: targetEndpoint });
        assert.deepEqual(converted.response, original.response);
        assert.deepEqual(converted.results, original.results);
        assert.equal(converted.response.replayMessages[0].parts[0].thoughtSignature, 'original-native-signature');
    }
    assert.equal(hashContext(original), originalHash);
});

test('signed Gemini identity still rejects unknown identities, other models and changed routes', () => {
    const original = exchange();
    const cases = [
        [{ ...original, sourceModelId: null }, { protocol: 'gemini', modelId, endpoint }],
        [{ ...original, sourceEndpoint: undefined }, { protocol: 'gemini', modelId, endpoint }],
        [original, { protocol: 'gemini', modelId }],
        [original, { protocol: 'gemini', modelId: 'gemini-other', endpoint: endpoint.replace(modelId, 'gemini-other') }],
        [original, { protocol: 'compatible_chat', modelId, endpoint }],
        [original, { protocol: 'gemini', modelId, endpoint: endpoint.replace('generativelanguage.googleapis.com', 'other.invalid') }],
        [original, { protocol: 'gemini', modelId, endpoint: endpoint.replace('/v1beta/', '/proxy/v1beta/') }],
        [original, { protocol: 'gemini', modelId, endpoint: endpoint.replace('/v1beta/', '/v1/') }],
        [original, { protocol: 'gemini', modelId, endpoint: `${endpoint}?route=other` }],
        [original, { protocol: 'gemini', modelId, endpoint: endpoint.replace(modelId, 'gemini-other') }],
        [{ ...original, sourceEndpoint: 'https://generativelanguage.googleapis.com/v1beta' }, { protocol: 'gemini', modelId, endpoint }],
        [{ ...original, sourceEndpoint: `${streamingEndpoint}&alt=json` }, { protocol: 'gemini', modelId, endpoint }],
    ];
    for (const [source, target] of cases) {
        const result = preflightHistoryTransfer([source], target);
        assert.equal(result.allowed, false, JSON.stringify({ source: source.sourceEndpoint, target }));
        assert.equal(result.issues[0].code, 'E_HISTORY_SIGNATURE_INCOMPATIBLE');
        assert.equal(result.issues[0].itemId, 'source-model');
    }
});

test('ContextService replays the official streamed signed tool round against the ordinary target endpoint', async () => {
    const original = exchange();
    const { port } = createFixture({ rounds: 0 });
    const append = (itemId, value, role, callId) => port.appendItem(itemId, value, { role, roundId: 'original-round',
        stepId: 'original-step', kind: role === 'user' ? 'input_consumed' : role === 'tool' ? 'tool_result' : 'model_step',
        providerProtocol: 'gemini', ...(callId ? { callId } : {}) });
    append('source-user', { text: 'Read the task plan.', references: [] }, 'user');
    append(original.itemId, { kind: 'model', protocol: 'gemini', response: original.response }, 'assistant');
    append('source-result', { kind: 'tool', result: original.results[0] }, 'tool', 'original-call');
    const originalHash = hashContext([...port.contents]);
    const adapter = new GeminiAdapter();
    const result = await new ContextService().buildView({ conversationId: port.capture.conversationId, modelId, adapter,
        targetEndpoint: endpoint, resolveHistoryIdentity: async () => ({ modelId, endpoint: streamingEndpoint }),
        baseView: { protocol: 'gemini' }, context: { signal: new AbortController().signal,
            readHistory: query => port.readHistory({ ...query, conversationId: port.capture.conversationId }),
            readContent: contentId => port.readContent(port.capture.conversationId, contentId) } });
    const parts = result.view.contents.flatMap(message => message.parts);
    assert.equal(parts.find(part => part.functionCall)?.thoughtSignature, 'original-native-signature');
    assert.equal(parts.find(part => part.functionResponse)?.functionResponse.id, 'original-call');
    assert.equal(hashContext([...port.contents]), originalHash);
    assert.doesNotThrow(() => adapter.encode(result.view, modelId, { generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } }));
});
