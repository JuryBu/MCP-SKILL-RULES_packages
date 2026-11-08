import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiTokenCounter, ProviderFault } from '../../../src/agent-server/providers/index.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const modelId = 'i11-model';
const profile = newProfile({ profileId: 'i11-counter', label: 'I11 count budget', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId });
const largeView = { protocol: 'gemini', contents: [{ role: 'user', parts: [
    { inlineData: { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024, 17).toString('base64') } },
    { inlineData: { mimeType: 'image/png', data: Buffer.alloc(2 * 1024 * 1024, 17).toString('base64') } },
] }] };

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
