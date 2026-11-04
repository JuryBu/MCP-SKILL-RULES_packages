import assert from 'node:assert/strict';
import test from 'node:test';
import { readProviderBalance } from '../../../src/agent-server/providers/balance.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';

const profile = (baseUrl = 'https://api.deepseek.com/v1') => ({ ...newProfile({ profileId: 'i8-balance', label: 'balance data fixture',
    protocol: 'compatible_chat', baseUrl, modelId: 'fixture-model' }), credentialRef: 'fixture-reference', credentialGeneration: 3 });
const credentials = { async withCredential(reference, generation, use) {
    assert.equal(reference, 'fixture-reference');
    assert.equal(generation, 3);
    return use('fictional-fixture-credential');
} };
const balance = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.340000000000000001',
    granted_balance: '2', topped_up_balance: '10.340000000000000001' }, { currency: 'USD', total_balance: '0.00', granted_balance: '0', topped_up_balance: '0' }] };

test('I8 official DeepSeek root, v1 and Anthropic bases use one documented root balance path without monetary rounding', async () => {
    for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/anthropic']) {
        let sent = 0;
        const result = await readProviderBalance(profile(base), credentials, async request => {
            sent++;
            assert.equal(request.url, 'https://api.deepseek.com/user/balance');
            assert.equal(request.method, 'GET');
            assert.equal(request.body, undefined);
            assert.equal(request.headers.Authorization, 'Bearer fictional-fixture-credential');
            return { status: 200, headers: {}, body: JSON.stringify(balance) };
        });
        assert.equal(sent, 1);
        assert.equal(result.status, 'reported');
        assert.equal(result.balances[0].available, '12.340000000000000001');
        assert.equal(result.balances[0].totalUsed, undefined);
        assert.equal(JSON.stringify(result).includes('fictional-fixture-credential'), false);
    }
});

test('I8 other provider bases stay unsupported and do not open credentials or make a request', async () => {
    for (const base of ['https://provider.example/v1', 'https://api.deepseek.com/unknown', 'http://api.deepseek.com', 'https://api.deepseek.com:444/v1']) {
        const result = await readProviderBalance(profile(base), { async withCredential() { assert.fail('unsupported credential read'); } },
            async () => { assert.fail('unsupported request'); });
        assert.equal(result.status, 'unsupported');
        assert.deepEqual(result.balances, []);
    }
});

test('I8 unavailable, malformed and auth failures preserve a safe no-balance result, insufficient balance remains reported', async () => {
    for (const response of [{ status: 401, headers: {}, body: 'fictional-fixture-credential' },
        { status: 200, headers: {}, body: '{' },
        { status: 200, headers: {}, body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 12 }] }) }]) {
        const result = await readProviderBalance(profile(), credentials, async () => response);
        assert.equal(result.status, 'unavailable');
        assert.equal(JSON.stringify(result).includes('fictional-fixture-credential'), false);
    }
    const missing = await readProviderBalance({ ...profile(), credentialRef: null }, credentials, async () => assert.fail('missing credential request'));
    assert.equal(missing.status, 'unavailable');
    const failed = await readProviderBalance(profile(), { async withCredential() { throw Error('private fixture error'); } }, async () => assert.fail('vault failed'));
    assert.equal(failed.status, 'unavailable');
    assert.equal(JSON.stringify(failed).includes('private fixture error'), false);
    const empty = await readProviderBalance(profile(), credentials, async () => ({ status: 200, headers: {}, body: JSON.stringify({ ...balance, is_available: false }) }));
    assert.equal(empty.status, 'reported');
    assert.match(empty.message, /余额不足/);
});
