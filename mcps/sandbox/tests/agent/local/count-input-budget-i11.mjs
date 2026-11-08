import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGeminiTokenCounter, ProviderFault } from '../../../src/agent-server/providers/index.ts';
import { FetchTransport } from '../../../src/agent-server/providers/http.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const modelId = 'i11-model';
const profile = newProfile({ profileId: 'i11-counter', label: 'I11 count budget', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId });
const largeView = { protocol: 'gemini', contents: [{ role: 'user', parts: [
    { inlineData: { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024, 17).toString('base64') } },
    { inlineData: { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024, 17).toString('base64') } },
] }] };

for (const responsePhase of ['headers', 'body']) {
    test(`large count cancellation closes the actual ${responsePhase} request before transport cleanup`, async () => {
        let requestCount = 0;
        let bytes = 0;
        let declaredBytes = 0;
        let responseClosed = false;
        const sockets = new Set();
        const server = createServer((request, response) => {
            requestCount += 1;
            declaredBytes = Number(request.headers['content-length']);
            request.on('data', chunk => { bytes += chunk.length; });
            request.on('end', () => {
                if (responsePhase === 'body') {
                    response.writeHead(200, { 'content-type': 'application/json' });
                    response.write('{"totalTokens":');
                }
            });
            response.on('close', () => { responseClosed = true; });
        });
        server.on('connection', socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const localProfile = newProfile({ profileId: `i11-${responsePhase}`, label: 'I11 local cancellation', protocol: 'gemini',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1beta`, modelId });
        const transport = new FetchTransport({ env: {}, platform: 'linux', windowsProxySettings: { enabled: false, pacConfigured: false } });
        const counter = createGeminiTokenCounter({ requestTimeoutMs: 350, profiles: { async get() { return localProfile; } }, transport });
        try {
            const started = performance.now();
            await assert.rejects(counter.countTokens(localProfile.profileId, modelId, largeView, undefined,
                new Date(Date.now() + 5000).toISOString()), error => error.code === 'E_COUNT_TOKENS_TIMEOUT');
            assert.ok(performance.now() - started < 1500);
            for (let wait = 0; wait < 20 && !responseClosed; wait += 1) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(requestCount, 1);
            console.log(JSON.stringify({ responsePhase, declaredBytes, receivedBytes: bytes, responseClosed, observedBeforeCleanup: true }));
            assert.ok(declaredBytes > 5 * 1024 * 1024);
            assert.ok(bytes > 0);
            assert.equal(responseClosed, true);
        } finally {
            await counter.close();
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        }
    });
}

test('large input gets one byte-sized budget and retries do not reset its original start', async () => {
    const started = Date.now();
    let now = started;
    const timeouts = [];
    const counter = createGeminiTokenCounter({ now: () => now, profiles: { async get() { return profile; } },
        transport: { async request(request) {
            timeouts.push(request.timeoutMs);
            if (timeouts.length === 1) {
                now += 66000;
                throw new ProviderFault('E_RESULT_UNKNOWN', 'owned count reset', { acceptance: 'unknown',
                    transportCause: { name: 'Error', causeCode: 'ECONNRESET' } });
            }
            return { status: 200, headers: {}, body: '{"totalTokens":42}' };
        } } });
    try {
        const result = await counter.countTokens(profile.profileId, modelId, largeView, undefined, new Date(started + 300000).toISOString());
        assert.equal(result.source.requestBudgetMs, 105000);
        assert.deepEqual(timeouts, [105000, 39000]);
        assert.equal(Date.parse(result.source.requestDeadlineAt), started + 105000);
        assert.equal(result.source.requestAttempts, 2);
    } finally { await counter.close(); }
});

test('large input still uses the original root deadline and explicit shorter count limit', async () => {
    for (const explicit of [undefined, 9000]) {
        const started = Date.now();
        let observed;
        const counter = createGeminiTokenCounter({ now: () => started, requestTimeoutMs: explicit,
            profiles: { async get() { return profile; } }, transport: { async request(request) {
                observed = request.timeoutMs;
                return { status: 200, headers: {}, body: '{"totalTokens":42}' };
            } } });
        try {
            const result = await counter.countTokens(profile.profileId, modelId, largeView, undefined, new Date(started + 20000).toISOString());
            assert.equal(observed, explicit ?? 20000);
            assert.equal(Date.parse(result.source.requestDeadlineAt), started + (explicit ?? 20000));
            assert.ok(result.source.requestBodyBytes > 5 * 1024 * 1024);
        } finally { await counter.close(); }
    }
});
