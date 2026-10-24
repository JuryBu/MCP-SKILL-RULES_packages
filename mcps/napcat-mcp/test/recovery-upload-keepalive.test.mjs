import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import test from 'node:test';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.SOURCE_ROOT || repository;
const source = fs.existsSync(path.join(root, 'src/codex-model-stream-proxy.mjs')) ? path.join(root, 'src') : root;
const { createCodexModelStreamProxy } = await import(pathToFileURL(path.join(source, 'codex-model-stream-proxy.mjs')));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(context, silent = false) {
  let attempts = 0;
  let retryAt = 0;
  const events = [];
  const pings = [];
  const timers = new Set();
  const stub = http.createServer((request, response) => {
    const attempt = ++attempts;
    request.resume();
    request.on('end', () => {
      if (attempt === 1) { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"type":"server_error","code":"server_error","message":"Local fixture"}}'); return; }
      retryAt = Date.now();
      if (silent) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return; }
      const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"local_complete","status":"completed","output":[]}}\n\n'); } }, 1900);
      timers.add(timer);
    });
  });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${stub.address().port}`, managedRecovery: true, managedRetryBaseMs: 150, heartbeatIntervalMs: 100, firstProgressTimeoutMs: silent ? 450 : 5000, firstLastProgressTimeoutMs: silent ? 450 : 5000, retryFirstProgressTimeoutMs: 450, uploadAllowanceMsPerMiB: 0, maxUploadAllowanceMs: 0, onEvent: entry => events.push({ ...entry, observedAt: Date.now() }) });
  await proxy.start();
  let incoming;
  const outgoing = http.request({ hostname: '127.0.0.1', port: proxy.status().port, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'turn', thread_id: `local-${silent}`, turn_id: 'keepalive' }) } });
  outgoing.on('error', () => {});
  const done = new Promise((resolve, reject) => {
    outgoing.once('response', response => { incoming = response; let wire = ''; response.setTimeout(1200, () => response.destroy(new Error('LOCAL_NATIVE_IDLE_SIMULATION'))); response.on('data', chunk => { wire += chunk.toString(); if (chunk.toString().includes('event: ping')) pings.push(Date.now()); }); response.once('end', () => resolve(wire)); response.once('error', reject); response.once('close', () => resolve(wire)); });
    outgoing.once('error', reject);
  });
  done.catch(() => {});
  outgoing.end(JSON.stringify({ model: 'fixture', stream: true, tools: [], input: [{ role: 'user', content: 'local fixture' }] }));
  context.after(async () => {
    incoming?.destroy(); outgoing.destroy();
    for (const timer of timers) clearTimeout(timer);
    await proxy.stop(); stub.closeAllConnections(); await new Promise(resolve => stub.close(resolve));
    assert.equal(proxy.status().activeRequests, 0);
    assert.equal(proxy.status().requestBuffer.usedBytes, 0);
  });
  return { proxy, events, pings, done, retryAt: () => retryAt, cancel: () => { incoming?.destroy(); outgoing.destroy(); } };
}

test('recovery keepalive spans a 1900ms retransmission beyond the 1200ms downstream idle limit', { timeout: 6000 }, async context => {
  const setup = await fixture(context);
  const wire = await setup.done;
  assert.match(wire, /response.completed/);
  assert.ok(setup.pings.filter(time => time > setup.retryAt() + 400).length >= 8, 'keepalive must continue during the recovered request');
  const pingCount = setup.pings.length;
  await delay(250);
  assert.equal(setup.pings.length, pingCount, 'no keepalive after completion');
});

test('recovery pings preserve the real upstream timeout and stop after cancellation', { timeout: 4000 }, async context => {
  const setup = await fixture(context, true);
  const deadline = Date.now() + 2500;
  while (!setup.events.some(entry => entry.type === 'attempt_progress_timeout') && Date.now() < deadline) await delay(10);
  const timeout = setup.events.find(entry => entry.type === 'attempt_progress_timeout');
  assert.ok(timeout, 'upstream timeout must fire while downstream receives pings');
  assert.ok(setup.pings.length >= 3);
  assert.equal(timeout.reason, 'FIRST_PROGRESS_TIMEOUT');
  assert.ok(timeout.elapsedMs < 1000);
  setup.cancel();
  await delay(100);
  const pingCount = setup.pings.length;
  await delay(300);
  assert.equal(setup.pings.length, pingCount);
  assert.equal(setup.proxy.status().activeRequests, 0);
  assert.equal(setup.proxy.status().requestBuffer.usedBytes, 0);
});
