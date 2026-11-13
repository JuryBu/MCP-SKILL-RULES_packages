import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentClient } from '../../../src/agent-client/client.ts';
import { AgentFault } from '../../../src/agent-server/protocol.ts';

function fixture() {
    const calls = [];
    const client = new AgentClient({ clientId: 'sdk-reliability-fixture', requestTimeoutMs: 100 });
    const connection = { connected: true, close() { this.connected = false; }, async request(method, params, options) {
        calls.push({ method, params, options });
        return { ok: true, data: {} };
    } };
    client.control = connection;
    client.server = { serverInstanceId: 'owned-core' };
    return { client, connection, calls };
}

function lease(scope = 'server', conversationId) {
    return { scope, ...(conversationId ? { conversationId } : {}), controlLeaseId: `owned-${scope}-lease`, controlEpoch: 2,
        expiresAt: new Date(Date.now() + 90_000).toISOString() };
}

test('a live connection read timeout reconnects once and succeeds', async () => {
    const { client, connection, calls } = fixture();
    let openings = 0;
    connection.request = async () => { throw new AgentFault('IPC_TIMEOUT', '读取超时', { operationPhase: 'request' }); };
    client.openControl = async () => {
        openings++;
        client.control = { connected: true, close() { this.connected = false; }, async request(method, params, options) {
            calls.push({ method, params, options }); return { ok: true, data: { recovered: true } };
        } };
    };
    try {
        const result = await client.request('server.info');
        assert.equal(result.ok, true, JSON.stringify(result.error));
        assert.equal(result.data.recovered, true);
        assert.equal(openings, 1);
        assert.equal(calls.length, 1);
    } finally { await client.close(); }
});

test('a cold handshake timeout receives one bounded connection retry', async () => {
    const { client, connection } = fixture();
    client.control = null;
    let openings = 0;
    client.openControl = async () => {
        openings++;
        if (openings === 1) throw new AgentFault('IPC_TIMEOUT', '冷握手超时');
        client.control = connection;
    };
    try { await client.connect(); assert.equal(openings, 2); }
    finally { await client.close(); }
});

test('protocol and authentication failures receive no recovery retry', async () => {
    for (const code of ['AUTH_FAILED', 'PROTOCOL_MISMATCH']) {
        const { client } = fixture();
        client.control = null;
        let openings = 0;
        client.openControl = async () => { openings++; throw new AgentFault(code, '原故障'); };
        try { const result = await client.request('server.info'); assert.equal(result.error.code, code); assert.equal(openings, 1); }
        finally { await client.close(); }
    }
});

test('exhausted cold recovery reports the actual final connection attempt', async () => {
    const { client } = fixture();
    client.control = null;
    let openings = 0;
    client.openControl = async () => { openings++; throw new AgentFault('IPC_TIMEOUT', '冷握手仍未完成'); };
    try {
        const result = await client.request('server.info');
        assert.equal(openings, 2);
        assert.equal(result.error.details.operationPhase, 'connect');
        assert.equal(result.error.details.attempt, 2);
        assert.equal(result.error.details.maxAttempts, 2);
        assert.equal(result.error.details.method, 'server.info');
    } finally { await client.close(); }
});

test('read recovery is bounded even when every live connection times out', async () => {
    const { client } = fixture();
    let submissions = 0;
    let openings = 0;
    const fail = async () => { submissions++; throw new AgentFault('IPC_TIMEOUT', '保持原错误'); };
    client.control.request = fail;
    client.openControl = async () => {
        openings++;
        client.control = { connected: true, close() { this.connected = false; }, request: fail };
    };
    try {
        const result = await client.request('server.info');
        assert.equal(result.error.code, 'IPC_TIMEOUT');
        assert.equal(submissions, 2);
        assert.equal(openings, 1);
        assert.equal(result.error.details.attempt, 2);
    } finally { await client.close(); }
});

test('unknown write retains its original transport and command identities without replay', async () => {
    const { client, connection, calls } = fixture();
    connection.request = async (method, params, options) => {
        calls.push({ method, params, options });
        if (method === 'server.getReceipt') return { ok: false, error: { code: 'RECEIPT_NOT_FOUND', message: '待查询', mayHaveStarted: false, retryable: true } };
        throw new AgentFault('RECEIPT_UNKNOWN', '回执未到', undefined, true, true);
    };
    try {
        const params = { retention: { mode: 'archive' } };
        const first = await client.request('conversations.create', params, { clientCommandId: 'original-command', recoverReceipt: false });
        const next = await client.request('conversations.create', params, { clientCommandId: 'original-command' });
        assert.equal(first.error.code, 'RECEIPT_UNKNOWN');
        assert.equal(next.error.code, 'RECEIPT_UNKNOWN');
        assert.equal(calls.filter(call => call.method === 'conversations.create').length, 1);
        assert.equal(calls.filter(call => call.method === 'server.getReceipt').length, 1);
        assert.equal(typeof calls[0].options.id, 'string');
        assert.equal(first.error.details.requestId, calls[0].options.id);
        assert.equal(next.error.details.requestId, first.error.details.requestId);
        assert.equal(next.error.details.clientCommandId, 'original-command');
        await client.close();
        assert.equal(client.closeReport.pendingCommands[0].clientCommandId, 'original-command');
        assert.equal(client.closeReport.pendingCommands[0].requestId, first.error.details.requestId);
    } finally { await client.close(); }
});

test('close releases only its established owned leases and remains idempotent', async () => {
    const { client, calls } = fixture();
    client.leases.set('server', lease());
    client.leases.set('conversation:owned-conversation', lease('conversation', 'owned-conversation'));
    await Promise.all([client.close(), client.close()]);
    assert.deepEqual(calls.map(call => call.method), ['server.releaseControl', 'server.releaseControl']);
    assert.equal(calls[0].params.controlLeaseId, 'owned-server-lease');
    assert.equal(calls[1].params.conversationId, 'owned-conversation');
    assert.equal(client.closeReport.released.length, 2);
    assert.equal(client.closeReport.retained.length, 0);
    assert.equal(client.connected, false);
});

test('close never cold-starts a core to release a disconnected lease', async () => {
    const { client, connection, calls } = fixture();
    connection.connected = false;
    client.leases.set('server', lease());
    let openings = 0;
    client.openControl = async () => { openings++; throw new Error('unexpected startup'); };
    await client.close();
    assert.equal(openings, 0);
    assert.equal(calls.length, 0);
    assert.equal(client.closeReport.retained[0].reason, 'disconnected');
});

test('close preserves an uncertain in-flight write and does not release its control', async () => {
    const { client, calls } = fixture();
    client.leases.set('server', lease());
    client.commands.set('server\0unknown-write', { hash: 'original-hash', method: 'profiles.put', clientCommandId: 'unknown-write', requestId: 'original-request',
        uncertain: true, submitted: true, serverInstanceId: 'owned-core', controlLeaseId: 'owned-server-lease', controlEpoch: 2 });
    await client.close();
    assert.equal(calls.length, 0);
    assert.equal(client.closeReport.retained[0].reason, 'command_pending');
    assert.equal(client.closeReport.pendingCommands[0].requestId, 'original-request');
    assert.equal(client.commands.get('server\0unknown-write').uncertain, true);
});

test('an expired caller deadline prevents both close-time release and connection startup', async () => {
    const { client, calls } = fixture();
    client.leases.set('server', lease());
    client.options.deadlineAt = new Date(Date.now() - 1).toISOString();
    await client.close();
    assert.equal(calls.length, 0);
    assert.equal(client.closeReport.retained[0].reason, 'deadline_expired');
});

test('a late successful control claim cannot restore local ownership after close', async () => {
    const { client, connection } = fixture();
    let finish;
    connection.request = async () => new Promise(resolve => { finish = resolve; });
    const claim = client.claimControl('server');
    await new Promise(resolve => setImmediate(resolve));
    await client.close();
    finish({ ok: true, data: lease(), receiptId: 'original-claim-receipt' });
    assert.equal((await claim).ok, true);
    assert.equal(client.leases.size, 0);
    assert.equal(client.renewalTimer, null);
    assert.equal(client.closeReport.pendingCommands[0].method, 'server.claimControl');
});
