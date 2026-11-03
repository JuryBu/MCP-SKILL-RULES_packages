import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createProviderServices, createGeminiTokenCounter, encodeGeminiCountTokensRequest, FetchTransport, sha256 } from '../../../src/agent-server/providers/index.ts';
import { MemoryAccountingPort } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { MemoryCatalogPort } from '../../../src/agent-server/models/catalog.ts';
import { MemoryProfilePort, newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const modelId = 'gemini-nano-banana-2.1';
const deadline = duration => new Date(Date.now() + duration).toISOString();
const ordinaryView = { protocol: 'gemini', contents: [{ role: 'user', parts: [{ text: 'ordinary fictional input' }] }] };
const profile = () => ({ ...newProfile({ profileId: 'counter-fixture', label: 'owned count fixture', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId }), credentialRef: 'fixture-ref', credentialGeneration: 1 });
const credentials = { async withCredential(ref, generation, use) { assert.equal(ref, 'fixture-ref'); assert.equal(generation, 1); return use('fictional-count-credential'); } };
const counter = transport => createGeminiTokenCounter({ profiles: { async get() { return profile(); } }, transport, credentialAccess: credentials });

async function ownedHttp(handler, use) {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const transport = new FetchTransport({ env: {}, platform: 'linux', windowsProxySettings: { enabled: false, pacConfigured: false } });
    try { await use(`http://127.0.0.1:${server.address().port}`, transport); }
    finally { await transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('factory countTokens sends complete native media/system/tool input to owned HTTP and preserves the native receipt (fixture only)', async () => {
    const received = [];
    await ownedHttp(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received.push({ url: request.url, method: request.method, body: Buffer.concat(chunks).toString('utf8'), key: request.headers['x-goog-api-key'] });
        response.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': `fixture-count-${received.length}`, 'set-cookie': 'fictional-count-cookie' });
        response.end(JSON.stringify({ totalTokens: 1200 + received.length, promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 1000 }], nativeFixtureField: 'preserved' }));
    }, async (baseUrl, http) => {
        const requests = [];
        const borrowed = { async request(request, signal) {
            assert.match(request.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-(?:3\.8-flash|nano-banana-2\.1):countTokens$/);
            requests.push(request);
            return http.request({ ...request, url: baseUrl + new URL(request.url).pathname }, signal);
        } };
        const profilePort = new MemoryProfilePort();
        const initialBase = newProfile({ profileId: 'counter-fixture', label: 'owned counter', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId });
        const initial = { ...initialBase, routePolicy: { ...initialBase.routePolicy, allowedModels: [...initialBase.routePolicy.allowedModels, 'gemini-3.8-flash'] } };
        const identity = { principalId: 'fixture-principal', clientId: 'fixture-client' };
        await profilePort.execute({ type: 'put', ...identity, clientCommandId: 'fixture-put', expectedRevision: 0, profile: initial });
        await profilePort.execute({ type: 'credential', ...identity, clientCommandId: 'fixture-secret', expectedRevision: 1, profileId: initial.profileId, credentialRef: 'fixture-ref', credentialGeneration: 1 });
        const accountingPort = new MemoryAccountingPort();
        const services = createProviderServices({ accountingPort, profilePort, catalogPort: new MemoryCatalogPort(), transport: borrowed, credentialAccess: credentials });
        const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nksAAAAASUVORK5CYII=';
        const view = { protocol: 'gemini', systemInstruction: { parts: [{ text: 'fictional system instruction' }] }, contents: [
            { role: 'user', parts: [{ text: 'ordinary generated image' }] },
            { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: imageData }, thoughtSignature: 'fixture-original-image-signature' }] },
            { role: 'user', parts: [{ text: 'change the mug to red' }] },
        ], tools: [{ name: 'read_number', description: 'ordinary fixture tool', parameters: { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'], additionalProperties: false } }] };
        try {
            const first = await services.countTokens(initial.profileId, 'gemini-3.8-flash', view, undefined, deadline(5000));
            const second = await services.countTokens(initial.profileId, modelId, { ...view, tools: [] }, undefined, deadline(5000));
            assert.equal(first.inputTokens, 1201);
            assert.equal(second.inputTokens, 1202);
            assert.equal(first.raw.json.nativeFixtureField, 'preserved');
            assert.equal(first.raw.headers['x-request-id'], 'fixture-count-1');
            assert.equal(first.raw.headers['set-cookie'], undefined);
            assert.equal(first.source.kind, 'gemini_count_tokens');
            assert.equal(first.source.profileRevision, 2);
            assert.equal(first.source.requestBodyHash, sha256(requests[0].body));
            assert.notEqual(first.source.requestHash, second.source.requestHash);
            assert.equal(JSON.stringify(first).includes('fictional-count-credential'), false);
            assert.equal(Object.isFrozen(first.raw.json), true);
            assert.ok(requests.every(request => request.maxResponseBytes === 65536 && request.timeoutMs > 0 && request.timeoutMs <= 5000));
            const body = JSON.parse(received[0].body);
            assert.equal(body.generateContentRequest.model, 'models/gemini-3.8-flash');
            assert.equal(Object.hasOwn(body, 'contents'), false);
            assert.deepEqual(body.generateContentRequest.contents, view.contents);
            assert.deepEqual(body.generateContentRequest.systemInstruction, view.systemInstruction);
            assert.deepEqual(body.generateContentRequest.tools[0].functionDeclarations[0].parametersJsonSchema, view.tools[0].parameters);
            assert.equal(received[0].key, 'fictional-count-credential');
            assert.ok(received.every(item => item.url.endsWith(':countTokens') && item.method === 'POST'));
            assert.equal(Object.hasOwn(JSON.parse(received[1].body).generateContentRequest, 'tools'), false);
            assert.deepEqual((await accountingPort.exportState()).reservations, {});
        } finally { await services.close(); }
    });
});

test('native counting never converts missing or malformed totalTokens to zero (pure data)', async () => {
    for (const json of [{}, { totalTokens: null }, { totalTokens: -1 }, { totalTokens: '1200' }]) {
        let calls = 0;
        const service = counter({ async request() { calls++; return { status: 200, headers: {}, body: JSON.stringify(json) }; } });
        try { await assert.rejects(service.countTokens('counter-fixture', modelId, ordinaryView, undefined, deadline(1000)), error => error.code === 'E_COUNT_TOKENS_INVALID'); }
        finally { await service.close(); }
        assert.equal(calls, 1);
    }
});

test('original deadline includes credential preparation and prevents any late count request (pure data)', async () => {
    let releaseCredential;
    let requests = 0;
    const credentialReady = new Promise(resolve => { releaseCredential = resolve; });
    const service = createGeminiTokenCounter({ profiles: { async get() { return profile(); } },
        credentialAccess: { async withCredential(_ref, _generation, use) { await credentialReady; return use('fictional-delayed-credential'); } },
        transport: { async request() { requests++; return { status: 200, headers: {}, body: '{"totalTokens":1}' }; } } });
    try {
        await assert.rejects(service.countTokens('counter-fixture', modelId, ordinaryView, undefined, deadline(25)), error => error.code === 'E_COUNT_TOKENS_DEADLINE');
        releaseCredential();
        await delay(10);
        assert.equal(requests, 0);
    } finally { releaseCredential(); await service.close(); }
});

test('cancellation and service close bound active count work without retrying (pure data)', async () => {
    const service = counter({ async request(_request, signal) {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    const controller = new AbortController();
    const cancelled = service.countTokens('counter-fixture', modelId, ordinaryView, controller.signal, deadline(1000));
    const cancellation = assert.rejects(cancelled, error => error.code === 'E_CANCELLED');
    controller.abort();
    await cancellation;
    const active = service.countTokens('counter-fixture', modelId, ordinaryView, undefined, deadline(1000));
    const closed = assert.rejects(active, error => error.code === 'E_COUNT_TOKENS_CLOSED');
    await service.close();
    await closed;
    await assert.rejects(service.countTokens('counter-fixture', modelId, ordinaryView, undefined, deadline(1000)), error => error.code === 'E_COUNT_TOKENS_CLOSED');
});

test('ordinary HTTP count receipts remain subject to the response byte limit (fixture only)', async () => {
    await ownedHttp((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ totalTokens: 1234, ordinaryFixturePadding: 'x'.repeat(70000) })); },
        async (baseUrl, http) => {
            const service = counter({ request(request, signal) { return http.request({ ...request, url: baseUrl + '/countTokens' }, signal); } });
            try { await assert.rejects(service.countTokens('counter-fixture', modelId, ordinaryView, undefined, deadline(1000)), error => error.code === 'E_RESPONSE_LIMIT'); }
            finally { await service.close(); }
        });
});

test('full-request counting uses only generateContentRequest and preserves raw signatures (pure data)', () => {
    const request = encodeGeminiCountTokensRequest({ protocol: 'gemini', contents: [{ role: 'model', parts: [{ text: 'fixture', thoughtSignature: 'fixture-signature' }] }] }, modelId);
    assert.deepEqual(Object.keys(request), ['generateContentRequest']);
    assert.equal(request.generateContentRequest.contents[0].parts[0].thoughtSignature, 'fixture-signature');
});

test('configured same-origin Gemini count endpoint preserves actual generation settings without borrowing credentials (owned HTTP)', async () => {
    const received = [];
    await ownedHttp(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        received.push({ url: request.url, key: request.headers['x-goog-api-key'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ totalTokens: 628, promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 258 }] }));
    }, async (baseUrl, transport) => {
        const configured = newProfile({ profileId: 'owned-same-origin-counter', label: 'owned standard Gemini API',
            protocol: 'gemini', baseUrl: baseUrl + '/api/v1beta', modelId });
        const service = createGeminiTokenCounter({ profiles: { async get() { return configured; } }, transport });
        const parameters = { generationConfig: { maxOutputTokens: 64, mediaResolution: 'MEDIA_RESOLUTION_LOW' } };
        const view = { protocol: 'gemini', contents: [{ role: 'model',
            parts: [{ text: 'retained input', thoughtSignature: 'owned-original-signature' }] }] };
        try {
            const result = await service.countTokens(configured.profileId, modelId, view, undefined, deadline(2000), parameters);
            assert.equal(result.inputTokens, 628);
            assert.equal(result.source.endpoint, baseUrl + '/api/v1beta/models/' + modelId + ':countTokens');
            assert.equal(result.source.profileId, configured.profileId);
            assert.equal(received.length, 1);
            assert.equal(received[0].key, undefined);
            assert.equal(received[0].url, '/api/v1beta/models/' + modelId + ':countTokens');
            assert.deepEqual(received[0].body.generateContentRequest.generationConfig, parameters.generationConfig);
            assert.equal(received[0].body.generateContentRequest.contents[0].parts[0].thoughtSignature, 'owned-original-signature');
        } finally { await service.close(); }
    });
});
