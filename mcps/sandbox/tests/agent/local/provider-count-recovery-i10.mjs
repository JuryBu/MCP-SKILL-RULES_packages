import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createGeminiTokenCounter, FetchTransport } from '../../../dist/agent-server/providers/index.js';
import { newProfile } from '../../../dist/agent-server/profiles/profile-store.js';

const modelId = 'gemini-nano-banana-2.1';
const view = { protocol: 'gemini', contents: [{ role: 'user', parts: [{ text: 'Count this ordinary input' }] }] };

async function withCounter(handler, use, options = {}) {
    const observed = [];
    const server = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        observed.push({ path: request.url, method: request.method, body });
        await handler(request, response, observed);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const transport = new FetchTransport({ environment: {} });
    const base = `http://127.0.0.1:${server.address().port}/v1beta`;
    const profile = newProfile({ profileId: 'i10-counter', label: 'I10 local HTTP', protocol: 'gemini', baseUrl: base, modelId });
    const counter = createGeminiTokenCounter({ profiles: { async get() { return profile; } }, transport, ...options });
    try { await use(counter, observed); }
    finally {
        await counter.close();
        await transport.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

const deadline = () => new Date(Date.now() + 10000).toISOString();

test('real HTTP count reset retries the same read-only endpoint and body, then succeeds without generating', async () => {
    await withCounter(async (request, response, observed) => {
        if (observed.length === 1) request.socket.destroy();
        else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"totalTokens":31}'); }
    }, async (counter, observed) => {
        const result = await counter.countTokens('i10-counter', modelId, view, undefined, deadline());
        assert.equal(result.inputTokens, 31);
        assert.equal(result.source.requestAttempts, 2);
        assert.equal(observed.length, 2);
        assert.ok(observed.every(item => item.path.endsWith(':countTokens')));
        assert.equal(observed[0].body, observed[1].body);
        assert.equal(observed.some(item => /generateContent|streamGenerateContent/.test(item.path)), false);
    });
});

test('three real count resets stop as preparation failure and retain count acceptance separately', async () => {
    await withCounter(async request => request.socket.destroy(), async (counter, observed) => {
        await assert.rejects(counter.countTokens('i10-counter', modelId, view, undefined, deadline()), error => {
            assert.equal(error.code, 'E_COUNT_TOKENS_TRANSPORT');
            assert.equal(error.acceptance, 'not_sent');
            assert.equal(error.mayHaveStarted, false);
            assert.equal(error.details.generationDispatch, 'not_started');
            assert.equal(error.details.countRequestAcceptance, 'unknown');
            assert.equal(error.details.requestAttempts, 3);
            assert.ok(error.details.endpoint.endsWith(':countTokens'));
            return true;
        });
        assert.equal(observed.length, 3);
    });
});

test('authentication and quota rejections stop count retry immediately', async () => {
    for (const status of [401, 402, 403]) await withCounter(async (_request, response) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: status === 402 ? 'insufficient_quota' : 'PERMISSION_DENIED' } }));
    }, async (counter, observed) => {
        await assert.rejects(counter.countTokens('i10-counter', modelId, view, undefined, deadline()), error => {
            assert.ok(['E_AUTH', 'E_QUOTA'].includes(error.code));
            assert.equal(error.acceptance, 'not_sent');
            assert.equal(error.retryable, false);
            return true;
        });
        assert.equal(observed.length, 1);
    });
});

test('cancelling count backoff does not issue another HTTP request', async () => {
    const aborted = new AbortController();
    await withCounter(async request => { request.socket.destroy(); setTimeout(() => aborted.abort(), 25); }, async (counter, observed) => {
        await assert.rejects(counter.countTokens('i10-counter', modelId, view, aborted.signal, deadline()), error => error.code === 'E_CANCELLED');
        await delay(600);
        assert.equal(observed.length, 1);
    });
});

test('count retries stay inside the original deadline', async () => {
    await withCounter(async request => request.socket.destroy(), async (counter, observed) => {
        await assert.rejects(counter.countTokens('i10-counter', modelId, view, undefined, new Date(Date.now() + 150).toISOString()),
            error => error.code === 'E_COUNT_TOKENS_TRANSPORT' || error.code === 'E_COUNT_TOKENS_DEADLINE');
        await delay(400);
        assert.ok(observed.length <= 1);
    });
});

test('503 oversized count response stops after one request', async () => {
    await withCounter(async (_request, response) => {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': 65537 });
        response.end('x'.repeat(65537));
    }, async (counter, observed) => {
        await assert.rejects(counter.countTokens('i10-counter', modelId, view, undefined, deadline()), error => {
            assert.equal(error.code, 'E_RESPONSE_LIMIT');
            assert.equal(error.retryable, false);
            assert.equal(error.details.requestAttempts, 1);
            return true;
        });
        assert.equal(observed.length, 1);
    });
});

test('final count rejection retains its bounded provider body and Retry-After in serialized state', async () => {
    const body = JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Count endpoint temporarily unavailable' } });
    await withCounter(async (_request, response) => {
        response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
        response.end(body);
    }, async (counter, observed) => {
        await assert.rejects(counter.countTokens('i10-counter', modelId, view, undefined, deadline()), error => {
            const saved = JSON.parse(JSON.stringify(error.toJSON()));
            assert.equal(saved.details.retryAfterMs, 30000);
            assert.deepEqual(saved.details.countResponse, { httpStatus: 503, body });
            assert.equal(error.acceptance, 'not_sent');
            return true;
        });
        assert.equal(observed.length, 1);
    });
});

test('two retained copies of the same 2MiB image preserve the complete 5MiB count payload across retry', async () => {
    const image = { inlineData: { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024, 17).toString('base64') } };
    const imageView = { protocol: 'gemini', contents: [
        { role: 'user', parts: [{ text: 'Original attachment' }, image] },
        { role: 'user', parts: [{ text: 'Use the same attachment again' }, image] },
    ] };
    await withCounter(async (request, response, observed) => {
        if (observed.length === 1) request.socket.destroy();
        else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"totalTokens":4096}'); }
    }, async (counter, observed) => {
        const result = await counter.countTokens('i10-counter', modelId, imageView, undefined, deadline());
        assert.equal(result.inputTokens, 4096);
        assert.equal(observed.length, 2);
        assert.equal(observed[0].path, `/v1beta/models/${modelId}:countTokens`);
        assert.equal(observed[0].body, observed[1].body);
        const parsed = JSON.parse(observed[0].body);
        const images = parsed.generateContentRequest.contents.flatMap(content => content.parts).filter(part => part.inlineData);
        assert.equal(images.length, 2);
        assert.equal(images[0].inlineData.data, images[1].inlineData.data);
        assert.ok(Buffer.byteLength(observed[0].body) > 5 * 1024 * 1024);
        console.log(JSON.stringify({ endpointPath: observed[0].path, bodyBytes: Buffer.byteLength(observed[0].body), images: images.length, attempts: 2, generationRequests: 0 }));
    });
});
