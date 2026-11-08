import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentClient } from '../../../src/agent-client/client.ts';
import { RpcConnection } from '../../../src/agent-client/connection.ts';

const countParams = { conversationId: 'count-timeout-fixture', input: { text: 'fixture' } };

class FixtureSocket extends EventEmitter {
    destroyed = false;
    lastFrame;
    write(frame, callback) { this.lastFrame = JSON.parse(frame.toString('utf8')); callback?.(); return true; }
    destroy() { this.destroyed = true; }
}

function fixture(options = {}) {
    const requests = [];
    const client = new AgentClient({ dataDir: '.', clientId: 'count-timeout-fixture', ...options });
    client.control = {
        connected: true,
        async request(method, params, requestOptions) {
            requests.push({ method, params, options: requestOptions });
            return { ok: true, data: { totalTokens: 1 } };
        },
        close() { this.connected = false; },
    };
    return { client, requests };
}

test('countTokens receives its provider deadline plus 5s, with a 125s automatic ceiling', async () => {
    for (const [providerTimeout, configuredTimeout, expected] of [
        [undefined, undefined, 125_000], [120_000, undefined, 125_000],
        [60_000, undefined, 65_000], [1, undefined, 5_001],
        [1, 30_000, 30_000], [120_000, 200_000, 125_000],
    ]) {
        const { client, requests } = fixture({ requestTimeoutMs: configuredTimeout });
        try {
            const params = { ...countParams, ...(providerTimeout === undefined ? {} : { timeoutMs: providerTimeout }) };
            assert.equal((await client.request('conversations.countTokens', params)).ok, true);
            assert.equal(requests.length, 1);
            assert.equal(requests[0].options.timeoutMs, expected);
            assert.deepEqual(requests[0].params, params);
            assert.equal(requests[0].options.writes, undefined);
        } finally { await client.close(); }
    }
});

test('explicit request timeout and client deadline still take precedence', async () => {
    const explicit = fixture();
    try {
        assert.equal((await explicit.client.request('conversations.countTokens', countParams, { timeoutMs: 73 })).ok, true);
        assert.equal(explicit.requests[0].options.timeoutMs, 73);
    } finally { await explicit.client.close(); }
    const deadline = fixture({ deadlineAt: new Date(Date.now() + 1_500).toISOString() });
    try {
        assert.equal((await deadline.client.request('conversations.countTokens', countParams)).ok, true);
        assert.ok(deadline.requests[0].options.timeoutMs > 0);
        assert.ok(deadline.requests[0].options.timeoutMs <= 1_500);
    } finally { await deadline.client.close(); }
    const expired = fixture({ deadlineAt: new Date(Date.now() - 1).toISOString() });
    try {
        assert.equal((await expired.client.request('conversations.countTokens', countParams)).error.code, 'IPC_TIMEOUT');
        assert.equal(expired.requests.length, 0);
    } finally { await expired.client.close(); }
});

test('other reads and events.read retain their existing defaults and overrides', async () => {
    for (const configuredTimeout of [undefined, 30_000]) {
        const { client, requests } = fixture({ requestTimeoutMs: configuredTimeout });
        try {
            assert.equal((await client.request('server.info')).ok, true);
            assert.equal(requests.at(-1).options.timeoutMs, configuredTimeout ?? 3_000);
            assert.equal((await client.request('events.read', { conversationId: countParams.conversationId, waitMs: 20_000 })).ok, true);
            assert.equal(requests.at(-1).options.timeoutMs, Math.max(configuredTimeout ?? 3_000, 23_000));
            assert.equal((await client.request('server.info', {}, { timeoutMs: 17 })).ok, true);
            assert.equal(requests.at(-1).options.timeoutMs, 17);
        } finally { await client.close(); }
    }
});

test('transport survives 30s and enforces the 125s count deadline', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const reply of [true, false]) {
        const connection = new RpcConnection('unused-count-timeout-fixture');
        const socket = new FixtureSocket();
        connection.socket = socket;
        connection.closed = false;
        const { client } = fixture();
        client.control = connection;
        try {
            const pending = client.request('conversations.countTokens', countParams);
            await new Promise(resolve => setImmediate(resolve));
            context.mock.timers.tick(30_001);
            assert.equal(connection.pending.size, 1);
            if (reply) {
                connection.receive(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: socket.lastFrame.id,
                    result: { ok: true, data: { totalTokens: 7 } } }) + '\n'));
                assert.equal((await pending).data.totalTokens, 7);
            } else {
                context.mock.timers.tick(94_998);
                assert.equal(connection.pending.size, 1);
                context.mock.timers.tick(1);
                const result = await pending;
                assert.equal(result.error.code, 'IPC_TIMEOUT');
                assert.equal(result.error.details.timeoutMs, 125_000);
            }
            assert.equal(connection.pending.size, 0);
        } finally { await client.close(); connection.close(); }
    }
});

test('a long count wait remains interruptible by signal-driven client close', async () => {
    const connection = new RpcConnection('unused-count-timeout-fixture');
    const socket = new FixtureSocket();
    connection.socket = socket;
    connection.closed = false;
    const { client } = fixture();
    client.control = connection;
    try {
        const pending = client.request('conversations.countTokens', countParams);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(connection.pending.size, 1);
        const abort = new AbortController();
        abort.signal.addEventListener('abort', () => { void client.close(); }, { once: true });
        abort.abort();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(result.error.code, 'IPC_UNAVAILABLE');
        assert.equal(result.error.mayHaveStarted, false);
        assert.equal(connection.pending.size, 0);
        assert.equal(socket.destroyed, true);
    } finally { await client.close(); connection.close(); }
});
