import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentClient } from '../../../src/agent-client/client.ts';
import { RpcConnection } from '../../../src/agent-client/connection.ts';

async function withPipe(options, handler, run) {
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\sdk-ipc-retirement-${process.pid}-${randomUUID()}`
        : join(tmpdir(), `sdk-ipc-retirement-${randomUUID()}.sock`);
    const sockets = new Set();
    const requests = [];
    const observed = new EventEmitter();
    const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let pending = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            pending += chunk;
            while (pending.includes('\n')) {
                const boundary = pending.indexOf('\n');
                const request = JSON.parse(pending.slice(0, boundary));
                pending = pending.slice(boundary + 1);
                requests.push(request);
                handler(request, socket, observed);
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
    });
    const client = new AgentClient({ clientId: 'owned-pipe-client', requestTimeoutMs: 1500, ...options });
    client.server = { serverInstanceId: 'owned-pipe-instance' };
    client.openControl = async () => {
        const connection = new RpcConnection(endpoint, 1500);
        client.connections.add(connection);
        await connection.open(1000);
        client.control = connection;
    };
    try { await client.connect(); await run({ client, requests, observed }); }
    finally {
        await client.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function reply(socket, request, result) {
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}

test('a read-timeout reconnect drains the original pipe write without introducing unknown status or replay', { timeout: 6000 }, async () => {
    let writeSocket;
    let writeRequest;
    let firstSocket;
    await withPipe({}, (request, socket, observed) => {
        firstSocket ??= socket;
        if (request.method === 'conversations.create') {
            writeSocket = socket;
            writeRequest = request;
            observed.emit('write');
        } else if (request.method === 'server.info' && socket !== firstSocket) reply(socket, request, { ok: true, data: { recovered: true } });
    }, async ({ client, requests, observed }) => {
        const written = once(observed, 'write');
        const write = client.request('conversations.create', { retention: { mode: 'archive' } }, { clientCommandId: 'owned-original-write' });
        await written;
        const recovered = await client.request('server.info', {}, { timeoutMs: 50 });
        assert.equal(recovered.ok, true, JSON.stringify(recovered.error));
        assert.equal(writeSocket.destroyed, false);
        const drained = once(writeSocket, 'close');
        reply(writeSocket, writeRequest, { ok: true, data: { conversationId: 'owned-created-conversation' }, receiptId: 'owned-original-receipt' });
        const completed = await write;
        assert.equal(completed.ok, true, JSON.stringify(completed.error));
        assert.equal(completed.receiptId, 'owned-original-receipt');
        await drained;
        assert.equal(requests.filter(request => request.method === 'conversations.create').length, 1);
        assert.equal(requests.filter(request => request.method === 'server.info').length, 2);
        assert.equal(requests.filter(request => request.method === 'server.getReceipt').length, 0);
        assert.equal(client.commands.get('server\0owned-original-write').uncertain, false);
    });
});

test('an unconfirmed close-time release preserves the exact request and never queries or resubmits automatically', { timeout: 6000 }, async () => {
    await withPipe({ closeTimeoutMs: 60 }, () => {}, async ({ client, requests }) => {
        client.leases.set('server', { scope: 'server', controlLeaseId: 'owned-lease', controlEpoch: 7,
            expiresAt: new Date(Date.now() + 90_000).toISOString() });
        const started = performance.now();
        await client.close();
        assert.ok(performance.now() - started < 1000);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'server.releaseControl');
        assert.equal(requests[0].params.controlEpoch, 7);
        assert.equal(client.closeReport.retained[0].reason, 'release_unknown');
        assert.equal(client.closeReport.pendingCommands[0].clientCommandId, requests[0].params.clientCommandId);
        assert.equal(client.closeReport.pendingCommands[0].requestId, requests[0].id);
        assert.equal(client.connected, false);
        await client.close();
        assert.equal(requests.length, 1);
    });
});
