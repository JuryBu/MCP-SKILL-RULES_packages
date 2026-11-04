import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { freezeRequest, prepareAttempt } from '../../../src/agent-server/providers/assemble.ts';
import { CompatibleChatAdapter } from '../../../src/agent-server/providers/compatible-chat.ts';
import { AnthropicAdapter } from '../../../src/agent-server/providers/anthropic.ts';
import { GeminiAdapter } from '../../../src/agent-server/providers/gemini.ts';
import { OpenAIResponsesAdapter } from '../../../src/agent-server/providers/openai-responses.ts';
import { ProgrokAdapter } from '../../../src/agent-server/providers/progrok.ts';
import { ProviderDispatcher } from '../../../src/agent-server/providers/dispatch.ts';
import { decodeResponse, FetchTransport } from '../../../src/agent-server/providers/http.ts';
import { ProviderFault } from '../../../src/agent-server/providers/types.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const versions = { conversationId: 'i8-stream-conversation', runId: 'i8-run', roundId: null, stepId: 'i8-step', actionId: 'i8-action',
    runEpoch: 1, historyEpoch: 1, appendSeq: 1, viewRevision: 1, workspaceRevision: 1, catalogVersion: 'fixture-catalog',
    capabilityVersion: 'fixture-capability', priceVersion: null, toolSchemaHash: 'fixture-tools', skillVersions: {},
    attachmentManifestHash: 'fixture-attachments', nativeReplayHash: 'fixture-native' };
const tool = { name: 'read_material', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
const event = (data, type) => `${type ? `event: ${type}\r\n` : ''}data: ${JSON.stringify(data)}\r\n\r\n`;
const usage = { prompt_tokens: 8, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };

function attemptFor(adapter, stream = true, overrides = {}) {
    const protocol = adapter.protocol;
    const profile = { ...newProfile({ profileId: `i8-${protocol}`, label: 'stream fixture', protocol,
        baseUrl: protocol === 'progrok' ? 'http://127.0.0.1:39999/v1' : 'https://fixture.example/v1', modelId: 'fixture-model' }), ...overrides };
    const view = { protocol, tools: [tool], ...(protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'fixture input' }] }] }
        : protocol === 'openai_responses' ? { input: [{ role: 'user', content: 'fixture input' }] }
            : { messages: [{ role: 'user', content: 'fixture input' }] }) };
    const snapshot = freezeRequest({ adapter, profile, view, versions, modelId: 'fixture-model', stream,
        parameters: protocol === 'gemini' ? { generationConfig: { maxOutputTokens: 32 } } : { max_tokens: 32 },
        deadlineAt: new Date(Date.now() + 120000).toISOString() });
    return prepareAttempt(snapshot, 'i8-root', randomUUID());
}

function streamTransport(body, options = {}) {
    let requests = 0;
    let finished = false;
    return { get requests() { return requests; }, get finished() { return finished; }, async request(request) {
        requests++;
        const bytes = Buffer.from(body);
        for (let offset = 0; offset < bytes.length; offset += options.chunkSize ?? 17) {
            await request.onChunk?.(bytes.subarray(offset, offset + (options.chunkSize ?? 17)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (options.fail) throw new TypeError('fixture connection interrupted');
        finished = true;
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, body };
    } };
}

for (const adapter of [new CompatibleChatAdapter(), new ProgrokAdapter()]) {
    test(`I8 ${adapter.protocol} streams actual deltas and commits native tool arguments only after DONE`, async () => {
        const attempt = attemptFor(adapter);
        const frames = [event({ id: 'chat-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] }),
            event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'read_material', arguments: '{"path":' } }] }, finish_reason: null }] }),
            event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"prepared.txt"}' } }] }, finish_reason: 'tool_calls' }] }),
            event({ choices: [], usage }), 'data: [DONE]\r\n\r\n'].join('');
        const transport = streamTransport(frames);
        const partials = [];
        const response = await adapter.send(attempt, { transport, onPartial: async partial => {
            assert.equal(transport.finished, false);
            partials.push(partial);
            await Promise.resolve();
        } });
        assert.equal(JSON.parse(attempt.snapshot.body).stream, true);
        assert.equal(response.complete, true);
        assert.equal(response.canExecuteTools, true);
        assert.deepEqual(response.toolCalls[0].arguments, { path: 'prepared.txt' });
        assert.equal(response.blocks[0].text, '你好');
        assert.equal(response.usage.inputTokens, 8);
        assert.ok(partials.some(partial => partial.textDelta === '你好'));
        assert.deepEqual(partials.map(partial => partial.seq), partials.map((_, index) => index + 1));
        assert.ok(partials.every(partial => partial.canExecuteTools === undefined));
        assert.equal(response.raw.body, frames);
    });
}

test('I8 Anthropic assembles text, thinking signatures and cumulative usage from native streaming blocks', async () => {
    const adapter = new AnthropicAdapter();
    const frames = [event({ type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [],
        stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture thought' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native' } }),
    event({ type: 'content_block_stop', index: 0 }),
    event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '文字结果' } }),
    event({ type: 'content_block_stop', index: 1 }),
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
    event({ type: 'message_stop' })].join('');
    const partials = [];
    const response = await adapter.send(attemptFor(adapter), { transport: streamTransport(frames), onPartial: partial => { partials.push(partial); } });
    assert.equal(response.complete, true);
    assert.equal(response.stop.kind, 'completed');
    assert.equal(response.replayMessages[0].content[0].signature, 'signed-native');
    assert.equal(response.usage.inputTokens, 8);
    assert.equal(response.usage.outputTokens, 2);
    assert.deepEqual(partials.filter(partial => partial.textDelta).map(partial => partial.textDelta), ['文字结果']);
});

test('I8 Gemini uses a frozen native SSE endpoint and preserves empty signed text plus pure-image success', async () => {
    const adapter = new GeminiAdapter();
    const attempt = attemptFor(adapter);
    const png = 'aW1hZ2UtZml4dHVyZQ==';
    const frames = [event({ responseId: 'gemini-fixture', modelVersion: 'fixture-model', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '', thoughtSignature: 'native-signature' }] } }] }),
        event({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: png }, thoughtSignature: 'native-image-signature' }] } }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } })].join('');
    const response = await adapter.send(attempt, { transport: streamTransport(frames) });
    assert.match(attempt.snapshot.endpoint, /:streamGenerateContent\?alt=sse$/);
    assert.equal(response.complete, true);
    assert.equal(response.stop.kind, 'completed');
    assert.equal(response.blocks.find(block => block.type === 'image').dataBase64, png);
    assert.deepEqual(response.replayMessages[0].parts.map(part => part.thoughtSignature), ['native-signature', 'native-image-signature']);
    assert.equal(response.usage.outputTokens, 2);
});

const completedResponse = { id: 'resp-fixture', status: 'completed', model: 'fixture-model', output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: '响应文字' }] }], usage: { input_tokens: 8, output_tokens: 2 } };

test('I8 Gemini text deltas form continuous visible text while all native parts, signatures, thoughts and tools remain replayable', async () => {
    const adapter = new GeminiAdapter();
    const fragments = [
        { text: '连接成功', thoughtSignature: 'signature-one' },
        { text: '，我们可以开始工作了', thoughtSignature: 'signature-two' },
        { text: '', thoughtSignature: 'signature-empty-tail' },
    ];
    const frames = fragments.map((part, index) => event({ responseId: 'gemini-text-fixture', modelVersion: 'fixture-model', candidates: [{ index: 0,
        content: { role: 'model', parts: [part] }, ...(index === fragments.length - 1 ? { finishReason: 'STOP' } : {}) }] })).join('');
    const response = await adapter.send(attemptFor(adapter), { transport: streamTransport(frames) });
    assert.equal(response.blocks.filter(block => block.type === 'text' && !block.thought).map(block => block.text).join('\n'), '连接成功，我们可以开始工作了');
    assert.deepEqual(response.replayMessages[0].parts, fragments);
    assert.deepEqual(response.raw.json.candidates[0].content.parts, fragments);
    assert.equal(response.raw.body, frames);
    assert.deepEqual(response.blocks[0].nativeFragments.map(fragment => fragment.native), fragments);
    assert.deepEqual(response.blocks[0].nativeFragments.map(fragment => fragment.thoughtSignature), ['signature-one', 'signature-two', 'signature-empty-tail']);
    const nativeParts = [{ text: '思考片段', thought: true, thoughtSignature: 'thinking-signature' }, ...fragments,
        { functionCall: { id: 'native-tool-id', name: 'read_material', args: { path: 'prepared.txt' } }, thoughtSignature: 'tool-signature' }];
    const nativeFrames = event({ responseId: 'gemini-native-fixture', modelVersion: 'fixture-model', candidates: [{ index: 0,
        content: { role: 'model', parts: nativeParts }, finishReason: 'STOP' }] });
    const toolResponse = await adapter.send(attemptFor(adapter), { transport: streamTransport(nativeFrames) });
    assert.equal(toolResponse.blocks[0].thought, true);
    assert.equal(toolResponse.blocks[0].thoughtSignature, 'thinking-signature');
    assert.equal(toolResponse.canExecuteTools, true);
    assert.equal(toolResponse.toolCalls[0].native.thoughtSignature, 'tool-signature');
    assert.deepEqual(toolResponse.replayMessages[0].parts, nativeParts);
});

test('I8 Responses emits deltas before terminal completion and preserves the authoritative final native response', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const frames = [event({ type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress', model: 'fixture-model', output: [] } }),
        event({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } }),
        event({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
        event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '响应文字' }),
        event({ type: 'response.completed', response: completedResponse })].join('');
    const transport = streamTransport(frames);
    const partials = [];
    const response = await adapter.send(attemptFor(adapter), { transport, onPartial: partial => {
        assert.equal(transport.finished, false);
        partials.push(partial);
    } });
    assert.deepEqual(response.raw.json, completedResponse);
    assert.equal(response.blocks[0].text, '响应文字');
    assert.ok(partials.some(partial => partial.textDelta === '响应文字' && partial.providerResponseId === 'resp-fixture'));
});

test('I8 interrupted streams keep complete observed frames, partial text and observed usage and never retry an accepted attempt', async () => {
    const adapter = new CompatibleChatAdapter();
    const attempt = attemptFor(adapter);
    const frames = event({ id: 'partial-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: '已收到的一半' }, finish_reason: null }], usage });
    const transport = streamTransport(frames, { fail: true });
    const failures = [], saved = [];
    const dispatcher = new ProviderDispatcher({ transport, maxAttempts: 3, journal: {
        async prepareAttempt() { return { status: 'send' }; }, async commitResponse() { assert.fail('partial cannot commit'); },
        async recordFailure(original, failure) { failures.push({ original, failure }); }, async recordPartial(original, partial) { saved.push(partial); },
    } });
    await assert.rejects(dispatcher.execute(adapter, attempt.snapshot, attempt.rootBudgetId, { kind: 'estimated', amountMicros: 0, currency: 'USD' },
        { attemptId: attempt.attemptId }), error => {
        assert.ok(error instanceof ProviderFault);
        assert.equal(error.acceptance, 'accepted');
        assert.equal(error.retryable, false);
        assert.equal(error.partialResponse.complete, false);
        assert.equal(error.partialResponse.canExecuteTools, false);
        assert.equal(error.partialResponse.blocks[0].text, '已收到的一半');
        assert.match(error.rawResponse.body, /已收到的一半/);
        assert.equal(error.usage.inputTokens, 8);
        assert.ok(error.usage.issues.includes('partial_stream_usage'));
        return true;
    });
    assert.equal(transport.requests, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].failure.usage.outputTokens, 2);
    assert.equal(failures[0].failure.partialResponse.providerResponseId, 'partial-fixture');
    assert.ok(saved.some(partial => partial.textDelta));
});

test('I8 missing terminal and persistence failures stay accepted partial; typed HTTP errors carry observed usage', async () => {
    const adapter = new CompatibleChatAdapter();
    const frames = event({ id: 'no-done', choices: [{ index: 0, delta: { role: 'assistant', content: '保留文字' }, finish_reason: 'stop' }] });
    await assert.rejects(adapter.send(attemptFor(adapter), { transport: streamTransport(frames) }), error => error.acceptance === 'accepted' && error.partialResponse.complete === false);
    await assert.rejects(adapter.send(attemptFor(adapter), { transport: streamTransport(frames), onPartial: partial => {
        if (partial.kind === 'event') throw Error('fixture disk unavailable');
    } }), error => error.acceptance === 'accepted' && error.rawResponse.body.includes('保留文字'));
    for (const current of [adapter, new AnthropicAdapter(), new GeminiAdapter(), new OpenAIResponsesAdapter(), new ProgrokAdapter()]) {
        const nativeUsage = current.protocol === 'gemini' ? { usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 } }
            : ['anthropic', 'openai_responses'].includes(current.protocol) ? { usage: { input_tokens: 8, output_tokens: 2 } } : { usage };
        await assert.rejects(current.send(attemptFor(current, false), { transport: { async request() {
            return { status: 400, headers: {}, body: JSON.stringify({ error: { code: 'bad_request' }, ...nativeUsage }) };
        } } }), error => error.acceptance === 'accepted' && error.usage.inputTokens === 8 && error.usage.outputTokens === 2);
    }
});

test('I8 Responses lookup uses the protected credential and only GETs an explicitly retained original response', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const attempt = attemptFor(adapter, true, { remoteRetention: 'allowed', credentialRef: 'fixture-reference', credentialGeneration: 2 });
    let calls = 0, credentials = 0;
    const transport = { async request(request) {
        calls++;
        assert.equal(request.method, 'GET');
        assert.match(request.url, /\/responses\/resp-fixture$/);
        assert.equal(request.headers.Authorization, 'Bearer fictional-original-credential');
        return { status: 200, headers: {}, body: JSON.stringify(completedResponse) };
    } };
    const dispatcher = new ProviderDispatcher({ transport, journal: {}, credentials: { async withCredential(reference, generation, use) {
        credentials++;
        assert.equal(reference, 'fixture-reference'); assert.equal(generation, 2);
        return use('fictional-original-credential');
    } } });
    const found = await dispatcher.lookup(adapter, attempt, undefined, { providerResponseId: 'resp-fixture' });
    assert.equal(found.status, 'found');
    assert.equal(found.response.attemptId, attempt.attemptId);
    assert.equal(calls, 1); assert.equal(credentials, 1);
    const unsaved = attemptFor(adapter);
    assert.deepEqual(await adapter.lookup({ attemptId: unsaved.attemptId, snapshot: unsaved.snapshot, providerResponseId: 'resp-fixture' }, { transport }), { status: 'unsupported' });
    assert.equal(calls, 1);
    const missing = await adapter.lookup({ attemptId: attempt.attemptId, snapshot: attempt.snapshot, providerResponseId: 'resp-fixture' },
        { transport: { async request() { return { status: 404, headers: {}, body: '{}' }; } } });
    assert.deepEqual(missing, { status: 'not_found', provesNotAccepted: false });
});

test('I8 documented temporary rejection uses bounded retry while quota, ambiguous throttling and execution evidence do not', async () => {
    const cases = [
        { protocol: 'openai_responses', url: 'https://api.openai.com/v1/responses', status: 429, code: 'slow_down', type: 'rate_limit_error', retry: true, after: '1' },
        { protocol: 'openai_responses', url: 'https://api.openai.com/v1/responses', status: 429, code: 'credit_balance_exhausted', retry: false, after: '1', expected: 'E_QUOTA' },
        { protocol: 'anthropic', url: 'https://api.anthropic.com/v1/messages', status: 429, type: 'rate_limit_error', retry: false },
        { protocol: 'anthropic', url: 'https://api.anthropic.com/v1/messages', status: 429, type: 'rate_limit_error', retry: true, after: '1' },
        { protocol: 'anthropic', url: 'https://api.anthropic.com/v1/messages', status: 529, type: 'overloaded_error', retry: true },
        { protocol: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models/fixture:generateContent', status: 429, code: 'RESOURCE_EXHAUSTED', retry: false },
        { protocol: 'compatible_chat', url: 'https://fixture.example/v1/chat/completions', status: 429, code: 'rate_limit_exceeded', retry: false, after: '1' },
    ];
    for (const fixture of cases) {
        assert.throws(() => decodeResponse({ status: fixture.status, headers: fixture.after ? { 'retry-after': fixture.after } : {},
            body: JSON.stringify({ error: { code: fixture.code, type: fixture.type } }) }, fixture.protocol, fixture.url), error => {
            assert.equal(error.retryable, fixture.retry);
            if (fixture.expected) assert.equal(error.code, fixture.expected);
            if (fixture.retry) assert.equal(error.acceptance, 'rejected');
            return true;
        });
    }
    assert.throws(() => decodeResponse({ status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: { code: 'slow_down', type: 'rate_limit_error' },
        usage: { input_tokens: 8, output_tokens: 2 } }) }, 'openai_responses', 'https://api.openai.com/v1/responses'), error => error.acceptance === 'accepted' && !error.retryable && error.usage.outputTokens === 2);
    const adapter = new OpenAIResponsesAdapter();
    const attempt = attemptFor(adapter, false, { baseUrl: 'https://api.openai.com/v1' });
    let sends = 0, waits = 0;
    const dispatcher = new ProviderDispatcher({ transport: { async request() {
        sends++;
        return sends === 1 ? { status: 429, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: { code: 'slow_down', type: 'rate_limit_error' } }) }
            : { status: 200, headers: {}, body: JSON.stringify(completedResponse) };
    } }, random: () => 0, async sleep(milliseconds) { waits++; assert.equal(milliseconds, 1000); }, journal: {
        async prepareAttempt() { return { status: 'send' }; }, async recordFailure(original, failure) { assert.equal(failure.acceptance, 'rejected'); },
        async commitResponse() { return { canExecuteTools: false }; },
    } });
    assert.equal((await dispatcher.execute(adapter, attempt.snapshot, attempt.rootBudgetId, { kind: 'estimated', amountMicros: 0, currency: 'USD' })).complete, true);
    assert.equal(sends, 2);
    assert.equal(waits, 1);
});

test('I8 native truncation, refusal and terminal failure retain usage and never expose executable partial tools', async () => {
    const adapter = new OpenAIResponsesAdapter();
    for (const [type, status, kind] of [['response.incomplete', 'incomplete', 'truncated'], ['response.failed', 'failed', 'failed']]) {
        const native = { ...completedResponse, status, error: status === 'failed' ? { code: 'server_error', message: 'fixture failure' } : null };
        const response = await adapter.send(attemptFor(adapter), { transport: streamTransport(event({ type, response: native })) });
        assert.equal(response.complete, true);
        assert.equal(response.stop.kind, kind);
        assert.equal(response.usage.inputTokens, 8);
        assert.equal(response.canExecuteTools, false);
    }
    const gemini = new GeminiAdapter();
    const response = await gemini.send(attemptFor(gemini), { transport: streamTransport(event({ promptFeedback: { blockReason: 'SAFETY' },
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 0 } })) });
    assert.equal(response.stop.kind, 'refused');
    assert.equal(response.complete, true);
    assert.equal(response.canExecuteTools, false);
});

test('I8 execute-scoped partial callback persists first and retains the actual fresh attempt identity after retry', async () => {
    const adapter = new OpenAIResponsesAdapter();
    const attempt = attemptFor(adapter, true, { baseUrl: 'https://api.openai.com/v1' });
    const frames = event({ type: 'response.created', response: { id: 'resp-fixture', status: 'in_progress', model: 'fixture-model', output: [] } })
        + event({ type: 'response.completed', response: completedResponse });
    const streaming = streamTransport(frames, { chunkSize: 4096 });
    const attempts = [], order = [], observed = [];
    let requests = 0;
    const dispatcher = new ProviderDispatcher({ transport: { async request(request) {
        requests++;
        if (requests === 1) return { status: 429, headers: { 'retry-after': '0' }, body: JSON.stringify({ error: { code: 'slow_down', type: 'rate_limit_error' } }) };
        return streaming.request(request);
    } }, random: () => 0, async sleep() {}, onPartial(original, partial) {
        order.push(`global:${partial.seq}`);
        assert.equal(original.attemptId, partial.attemptId);
    }, journal: {
        async prepareAttempt(original) { attempts.push(original.attemptId); return { status: 'send' }; }, async recordFailure() {},
        async recordPartial(original, partial) { order.push(`journal:${partial.seq}`); assert.equal(original.attemptId, partial.attemptId); },
        async commitResponse() { return { canExecuteTools: false }; },
    } });
    const response = await dispatcher.execute(adapter, attempt.snapshot, attempt.rootBudgetId, { kind: 'estimated', amountMicros: 0, currency: 'USD' },
        { attemptId: attempt.attemptId, async onPartial(original, partial) {
            order.push(`single:${partial.seq}`);
            observed.push({ original: original.attemptId, partial: partial.attemptId });
            await Promise.resolve();
        } });
    assert.equal(response.complete, true);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0], attempt.attemptId);
    assert.notEqual(attempts[1], attempts[0]);
    assert.ok(observed.length > 0);
    assert.ok(observed.every(entry => entry.original === attempts[1] && entry.partial === attempts[1]));
    for (let index = 0; index < order.length; index += 3) {
        const seq = order[index].split(':')[1];
        assert.deepEqual(order.slice(index, index + 3), [`journal:${seq}`, `single:${seq}`, `global:${seq}`]);
    }
});

test('I8 FetchTransport delivers live loopback chunks while the original HTTP response is still open', async () => {
    let ended = false;
    const server = createServer(async (request, response) => {
        for await (const chunk of request) {}
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(event({ id: 'live-fixture', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: '先到' }, finish_reason: null }] }));
        await new Promise(resolve => setTimeout(resolve, 40));
        response.end(event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }) + 'data: [DONE]\n\n');
        ended = true;
    });
    const transport = new FetchTransport();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const adapter = new CompatibleChatAdapter();
        const attempt = attemptFor(adapter, true, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
        let beforeEnd = false;
        const response = await adapter.send(attempt, { transport, onPartial: partial => { if (partial.textDelta) beforeEnd = !ended; } });
        assert.equal(beforeEnd, true);
        assert.equal(response.complete, true);
    } finally { await transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
