import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const [installedRoot, dataRoot, expectedPort] = process.argv.slice(2);
assert.ok(path.isAbsolute(installedRoot) && path.isAbsolute(dataRoot));
const runtime = JSON.parse(fs.readFileSync(path.join(dataRoot, 'state/codex-app-server-proxy-runtime.json'), 'utf8'));
assert.equal(runtime.state, 'running');
const endpoint = new URL(runtime.downstreamUrl);
assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(endpoint.protocol, 'ws:');
assert.equal(endpoint.port, expectedPort);
const WebSocket = createRequire(path.join(installedRoot, 'package.json'))('ws');
const socket = new WebSocket(endpoint, { handshakeTimeout: 5000 });
let requestId = 0;
let threadCount = 0;
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const request = (method, params) => new Promise((resolve, reject) => {
    assert.ok(['initialize', 'thread/list'].includes(method));
    requestId += 1;
    const expectedId = requestId;
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('OWNER_BUSINESS_TIMEOUT')); }, 5000);
    const receive = raw => {
      const message = JSON.parse(String(raw));
      if (message.id !== expectedId) return;
      clearTimeout(timer);
      socket.off('message', receive);
      if (message.error) reject(new Error('OWNER_BUSINESS_RPC_ERROR'));
      else resolve(message.result);
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ id: expectedId, method, params }));
  });
  await request('initialize', { clientInfo: { name: 'outer_owner_window_verifier', version: '1.0.0' } });
  socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  const threads = await request('thread/list', { limit: 1 });
  assert.ok(Array.isArray(threads.data));
  threadCount = threads.data.length;
  console.log(JSON.stringify({ businessReady: true, runnerPid: runtime.pid, backendPid: runtime.appServerPid, methods: ['initialize', 'thread/list'], returnedThreadCount: threadCount, modelRequests: 0, loopbackOnly: true }));
} finally {
  await new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => socket.terminate(), 2000);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.close();
  });
}
