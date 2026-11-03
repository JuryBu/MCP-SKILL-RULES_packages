import assert from 'node:assert/strict';
import { AgentClient } from '../../../dist/agent-client/client.js';
import { AgentFault } from '../../../dist/agent-server/protocol.js';

async function scenario(lateFailure) {
    const client = new AgentClient({ clientId: 'owned-renewal-order-check' });
    const lease = { scope: 'server', controlLeaseId: 'owned-normal-lease', controlEpoch: 1, expiresAt: new Date(Date.now() + 90000).toISOString() };
    let finishRenewal;
    let failRenewal;
    let opened = 0;
    const pending = new Promise((resolve, reject) => { finishRenewal = resolve; failRenewal = reject; });
    const connection = { connected: true, close() { this.connected = false; }, async request(method) {
        if (method === 'server.renewControl') return pending;
        assert.equal(method, 'server.shutdown');
        this.connected = false;
        return { ok: true, data: { stopped: true } };
    } };
    client.control = connection;
    client.server = { serverInstanceId: 'owned-instance' };
    client.leases.set('server', lease);
    client.openControl = async () => { opened++; throw new Error('Background renewal opened a connection'); };
    const renewal = client.renewControl('server', undefined, { connectedOnly: true, recoverReceipt: false });
    const stopped = await client.request('server.shutdown', { clientCommandId: 'owned-shutdown-' + lateFailure, mode: 'drain', graceMs: 0 });
    assert.equal(stopped.ok, true);
    assert.equal(client.leases.size, 0);
    if (lateFailure) failRenewal(new AgentFault('IPC_UNAVAILABLE', 'Ordinary closed connection', undefined, true));
    else finishRenewal({ ok: true, data: { ...lease, expiresAt: new Date(Date.now() + 180000).toISOString() } });
    const result = await renewal;
    assert.equal(client.leases.size, 0);
    assert.equal(client.renewalTimer, null);
    assert.equal(opened, 0);
    if (lateFailure) {
        assert.equal(result.error.code, 'RECEIPT_UNKNOWN');
        const original = [...client.commands.values()].find(record => record.method === 'server.renewControl' && record.uncertain);
        assert.ok(original);
        let receiptQueries = 0;
        client.getReceipt = async () => { receiptQueries++; throw new Error('Background renewal queried a receipt'); };
        const unchanged = await client.request('server.renewControl', { scope: 'server', controlLeaseId: lease.controlLeaseId,
            controlEpoch: lease.controlEpoch, clientCommandId: original.clientCommandId }, { acquireControl: false, connectedOnly: true, recoverReceipt: false });
        assert.equal(unchanged.error.code, 'RECEIPT_UNKNOWN');
        assert.equal(original.uncertain, true);
        assert.equal(receiptQueries, 0);
        client.captureRecoveredLease({ ...original, result: { ok: true, data: lease } });
        assert.equal(client.leases.size, 0);
        assert.equal(client.renewalTimer, null);
    } else assert.equal(result.ok, true);
    await client.close();
}

await scenario(false);
await scenario(true);
const disconnected = new AgentClient({ clientId: 'owned-disconnected-renewal' });
disconnected.leases.set('server', { scope: 'server', controlLeaseId: 'owned-disconnected-lease', controlEpoch: 1, expiresAt: new Date(Date.now() + 90000).toISOString() });
let opened = 0;
disconnected.openControl = async () => { opened++; throw new Error('A disconnected renewal attempted startup'); };
const skipped = await disconnected.renewControl('server', undefined, { connectedOnly: true, recoverReceipt: false });
assert.equal(skipped.ok, false);
assert.equal(opened, 0);
await disconnected.close();
console.log(JSON.stringify({ passed: true, cases: ['late-success-after-shutdown', 'late-disconnect-preserves-original-unknown', 'disconnected-renewal-does-not-connect'], realModelRequests: 0, scope: 'Deterministic client callback ordering; real MCP process coverage is separate' }));
