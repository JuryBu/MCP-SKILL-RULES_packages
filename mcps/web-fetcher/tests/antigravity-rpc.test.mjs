import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
    AntigravityRpcError,
    antigravityRpcFailure,
    callAntigravityModel,
    callAntigravityRpc,
    isAntigravityRpcUnsupported,
} from '../src/antigravity-rpc.ts';

const model = 'MODEL_PLACEHOLDER_M318';

function request(overrides = {}) {
    return { prompt: 'fixture prompt 中文', deadline: performance.now() + 2000, ...overrides };
}

async function endpointFixture(context, handler) {
    const requests = [];
    const sockets = new Set();
    const server = http.createServer((incoming, outgoing) => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
            requests.push({ path: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') });
            handler(incoming, outgoing, requests.at(-1));
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return {
        requests,
        endpoint: { host: '127.0.0.1', port: server.address().port, pid: process.pid,
            identity: `fixture:${server.address().port}`, transport: 'app-ls', csrfToken: 'test-secret-do-not-log' },
    };
}

function json(outgoing, data, status = 200) {
    outgoing.writeHead(status, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify(data));
}

test('unary RPC sends the actual text/model contract and preserves complete text', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, { response: ' 完整回答\n中文 ' }));
    const result = await callAntigravityModel(request({ schema: { type: 'object' } }), fixture.endpoint, model);
    assert.deepEqual(result, { text: ' 完整回答\n中文 ', transport: 'app-ls', model,
        outcome: 'success', submitted: true, safeToFallback: false });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].path, '/exa.language_server_pb.LanguageServerService/GetModelResponse');
    assert.equal(fixture.requests[0].headers['x-codeium-csrf-token'], fixture.endpoint.csrfToken);
    assert.deepEqual(JSON.parse(fixture.requests[0].body), { prompt: 'fixture prompt 中文', model });
});

test('invalid endpoint, unsafe method, cancellation, and expired deadline send no request', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, { response: 'unexpected' }));
    for (const endpoint of [
        { ...fixture.endpoint, host: 'example.com' },
        { ...fixture.endpoint, port: 0 },
        { ...fixture.endpoint, pid: 0 },
        { ...fixture.endpoint, identity: '' },
    ]) {
        await assert.rejects(callAntigravityRpc(endpoint, 'GetModelResponse', {}, request()), error =>
            error instanceof AntigravityRpcError && !error.submitted && !error.safeToFallback);
    }
    await assert.rejects(callAntigravityRpc(fixture.endpoint, '../GetModelResponse', {}, request()));
    await assert.rejects(callAntigravityRpc(fixture.endpoint, 'GetModelResponse', {}, request({ deadline: performance.now() - 1 })),
        error => error.outcome === 'not-started' && !error.submitted);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await callAntigravityModel(request({ signal: controller.signal }), fixture.endpoint, model);
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.submitted, false);
    assert.equal(cancelled.safeToFallback, false);
    assert.equal(fixture.requests.length, 0);
});

test('reset after dispatch is unknown and never declared safe to resend', async context => {
    const fixture = await endpointFixture(context, incoming => incoming.socket.destroy());
    const result = await callAntigravityModel(request(), fixture.endpoint, model);
    assert.equal(result.outcome, 'transport-unknown');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
    assert.equal(fixture.requests.length, 1);
});

test('truncated response after dispatch remains unknown', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => {
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 200 });
        outgoing.write('{"response":"partial');
        setImmediate(() => outgoing.destroy());
    });
    const result = await callAntigravityModel(request(), fixture.endpoint, model);
    assert.equal(result.outcome, 'transport-unknown');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
});

test('one absolute deadline covers a trickling response without resetting per chunk', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => {
        outgoing.writeHead(200, { 'Content-Type': 'application/json' });
        outgoing.write('{"response":"');
        const timer = setInterval(() => outgoing.write('x'), 15);
        outgoing.on('close', () => clearInterval(timer));
    });
    const startedAt = performance.now();
    const result = await callAntigravityModel(request({ deadline: startedAt + 130 }), fixture.endpoint, model);
    assert.equal(result.outcome, 'timeout-unknown');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
    assert.ok(performance.now() - startedAt < 1000);
    assert.equal(fixture.requests.length, 1);
});

test('cancellation after dispatch keeps submitted state and closes its request', async context => {
    const controller = new AbortController();
    const fixture = await endpointFixture(context, () => controller.abort());
    const result = await callAntigravityModel(request({ signal: controller.signal }), fixture.endpoint, model);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
    assert.equal(fixture.requests.length, 1);
});

test('connection refusal is a proven pre-dispatch failure', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, {}));
    const vacant = http.createServer();
    await new Promise(resolve => vacant.listen(0, '127.0.0.1', resolve));
    const port = vacant.address().port;
    await new Promise(resolve => vacant.close(resolve));
    const result = await callAntigravityModel(request(), { ...fixture.endpoint, port }, model);
    assert.equal(result.outcome, 'not-started');
    assert.equal(result.submitted, false);
    assert.equal(result.safeToFallback, true);
    assert.equal(fixture.requests.length, 0);
});

test('response allocation is bounded for declared and chunked content', async context => {
    for (const declared of [false, true]) {
        await context.test(declared ? 'content length' : 'chunked', async subcontext => {
            const fixture = await endpointFixture(subcontext, (_incoming, outgoing) => {
                outgoing.writeHead(200, { ...(declared ? { 'Content-Length': 5000 } : {}) });
                outgoing.end(JSON.stringify({ response: 'x'.repeat(1000) }));
            });
            await assert.rejects(callAntigravityRpc(fixture.endpoint, 'GetModelResponse', { prompt: 'test', model },
                { ...request(), maxResponseBytes: 100 }), error =>
                error.outcome === 'invalid-response' && error.submitted && !error.safeToFallback);
        });
    }
});

test('request allocation is bounded before dispatch', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, {}));
    const result = await callAntigravityModel(request({ prompt: 'x'.repeat(8 * 1024 * 1024 + 1) }), fixture.endpoint, model);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.submitted, false);
    assert.equal(fixture.requests.length, 0);
});

test('strict text terminal rejects malformed, incomplete, non-text, and error-containing output', async context => {
    const bodies = [
        'not json',
        { response: '' },
        { response: '   ' },
        { response: { text: 'nested' } },
        { response: 'progress', terminalStatus: 'running' },
        { response: 'partial', complete: false },
        { response: 'partial', done: false },
        { response: 'apparent success', error: { code: 'internal', message: 'terminal error' } },
    ];
    for (const body of bodies) {
        await context.test(JSON.stringify(body).slice(0, 70), async subcontext => {
            const fixture = await endpointFixture(subcontext, (_incoming, outgoing) =>
                typeof body === 'string' ? outgoing.end(body) : json(outgoing, body));
            const result = await callAntigravityModel(request(), fixture.endpoint, model);
            assert.notEqual(result.outcome, 'success');
            assert.equal(result.text, null);
            assert.equal(result.submitted, true);
            assert.equal(result.safeToFallback, false);
            if (typeof body === 'object' && body.error) assert.match(result.error, /terminal error/);
        });
    }
});

test('auth, quota 403, forbidden, model404 and explicit unsupported have distinct retry policy', async context => {
    const cases = [
        [401, { code: 'unauthenticated', message: 'login required' }, 'auth-required', false],
        [403, { code: 'permission_denied', message: 'quota exhausted' }, 'quota-exhausted', false],
        [403, { code: 'permission_denied', message: 'forbidden' }, 'rejected', false],
        [403, { code: 'unimplemented', message: 'forbidden' }, 'rejected', false],
        [429, { code: 'resource_exhausted', message: 'rate limit' }, 'quota-exhausted', false],
        [404, { code: 'not_found', message: 'model not found' }, 'unsupported', true],
        [500, { code: 'unknown', message: 'unknown model key MODEL_PLACEHOLDER_M132: model not found' }, 'unsupported', true],
        [501, { code: 'unimplemented', message: 'method not implemented' }, 'unsupported', true],
        [503, { code: 'unavailable', message: 'No capacity available for gemini-3.8-flash-high' }, 'rejected', true],
        [503, { code: 'unavailable', message: 'Service unavailable' }, 'transport-unknown', false],
        [503, { code: 'unimplemented', message: 'Service unavailable' }, 'transport-unknown', false],
        [503, { code: 'unknown', message: 'model not found' }, 'transport-unknown', false],
        [503, { code: 'unavailable', message: 'No capacity available', response: { text: 'partial' } }, 'transport-unknown', false],
        [503, { code: 'resource_exhausted', message: 'No capacity available: quota exhausted' }, 'quota-exhausted', false],
        [500, { code: 'internal', message: 'server error' }, 'transport-unknown', false],
    ];
    for (const [status, body, outcome, safeToFallback] of cases) {
        await context.test(`${status} ${outcome} ${body.message}`, async subcontext => {
            const fixture = await endpointFixture(subcontext, (_incoming, outgoing) => json(outgoing, body, status));
            const result = await callAntigravityModel(request(), fixture.endpoint, model);
            assert.equal(result.outcome, outcome);
            assert.equal(result.submitted, true);
            assert.equal(result.safeToFallback, safeToFallback);
            assert.equal(fixture.requests.length, 1);
        });
    }
});

test('HTTP auth and quota without JSON retain their classification', async context => {
    for (const [status, message, outcome] of [[401, 'login required', 'auth-required'], [403, 'quota exceeded', 'quota-exhausted']]) {
        await context.test(`${status}`, async subcontext => {
            const fixture = await endpointFixture(subcontext, (_incoming, outgoing) => {
                outgoing.writeHead(status);
                outgoing.end(message);
            });
            const result = await callAntigravityModel(request(), fixture.endpoint, model);
            assert.equal(result.outcome, outcome);
            assert.equal(result.safeToFallback, false);
        });
    }
});

test('metadata does not claim generation submitted and cannot silently turn bad shapes into unsupported', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, { malformed: true }));
    const response = await callAntigravityRpc(fixture.endpoint, 'GetUserStatus', {}, request());
    assert.equal(response.submitted, false);
    assert.equal(isAntigravityRpcUnsupported(response), false);
    assert.equal(antigravityRpcFailure(response, fixture.endpoint), null);
    assert.equal(isAntigravityRpcUnsupported({ status: 200, data: { response: 'partial', code: 'unimplemented' }, submitted: true }), false);
});

test('RPC diagnostics redact endpoint credentials', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing,
        { code: 'unauthenticated', message: 'bad token test-secret-do-not-log; Bearer sensitive-value' }, 401));
    const result = await callAntigravityModel(request(), fixture.endpoint, model);
    assert.equal(result.outcome, 'auth-required');
    assert.ok(!result.error.includes(fixture.endpoint.csrfToken));
    assert.ok(!result.error.includes('sensitive-value'));
    assert.match(result.error, /redacted/);
});

test('deadline uses the monotonic clock even when the wall clock jumps', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, { response: 'clock-safe' }));
    const original = Date.now;
    try {
        Date.now = () => 999999999999999;
        const result = await callAntigravityModel(request(), fixture.endpoint, model);
        assert.equal(result.outcome, 'success');
        assert.equal(result.text, 'clock-safe');
    } finally {
        Date.now = original;
    }
});

test('interrupted 503 capacity text cannot be declared a complete rejection', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => {
        outgoing.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': 500 });
        outgoing.write('{"code":"unavailable","message":"No capacity available for gemini-3.8-flash-high"}');
        setImmediate(() => outgoing.destroy());
    });
    const result = await callAntigravityModel(request(), fixture.endpoint, model);
    assert.equal(result.outcome, 'transport-unknown');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
});

test('only a dispatched generation triggers onSubmitted with the selected enum', async context => {
    const submitted = [];
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, { response: 'hook result' }));
    const original = request({ onSubmitted: selected => submitted.push(selected) });
    await callAntigravityRpc(fixture.endpoint, 'GetUserStatus', {}, original);
    await callAntigravityRpc(fixture.endpoint, 'Heartbeat', {}, original);
    assert.deepEqual(submitted, []);
    assert.equal((await callAntigravityModel(original, fixture.endpoint, model)).outcome, 'success');
    assert.deepEqual(submitted, [model]);
    const controller = new AbortController();
    controller.abort();
    await callAntigravityModel({ ...original, signal: controller.signal }, fixture.endpoint, model);
    assert.deepEqual(submitted, [model]);
});

test('reset and cancellation after dispatch notify submission exactly once without enabling fallback', async context => {
    for (const mode of ['reset', 'cancel']) {
        await context.test(mode, async subcontext => {
            const submitted = [];
            const controller = new AbortController();
            const fixture = await endpointFixture(subcontext, incoming => mode === 'reset'
                ? incoming.socket.destroy() : controller.abort());
            const result = await callAntigravityModel(request({ signal: controller.signal,
                onSubmitted: selected => submitted.push(selected) }), fixture.endpoint, model);
            assert.equal(result.outcome, mode === 'reset' ? 'transport-unknown' : 'cancelled');
            assert.equal(result.submitted, true);
            assert.equal(result.safeToFallback, false);
            assert.deepEqual(submitted, [model]);
        });
    }
});

test('submission hook failure remains a submitted unknown result', async context => {
    const fixture = await endpointFixture(context, (_incoming, outgoing) => json(outgoing, { response: 'unused' }));
    const result = await callAntigravityModel(request({ onSubmitted: () => { throw new Error('fixture observer failed'); } }), fixture.endpoint, model);
    assert.equal(result.outcome, 'transport-unknown');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
});
