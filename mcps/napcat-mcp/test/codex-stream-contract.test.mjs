import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createCodexModelStreamProxy, isMeaningfulResponsesSseFrame } from '../src/codex-model-stream-proxy.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const wire = event => `data: ${JSON.stringify(event)}\n\n`;
const complete = { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [] } };
const failed = code => ({ type: 'response.failed', response: { id: 'resp_fixture', status: 'failed', error: { code, message: code } } });
const parse = body => body.split(/\r?\n\r?\n/).flatMap(frame => {
  try { return [JSON.parse(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'))]; }
  catch { return []; }
});

async function fixture(context, handler, options = {}) {
  let requests = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    Promise.resolve(handler(request, response, ++requests)).catch(error => response.destroy(error));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const events = [];
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, firstProgressTimeoutMs: 1000, progressIdleTimeoutMs: 1000, onEvent: event => events.push(event), ...options });
  await proxy.start();
  context.after(async () => { await proxy.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = (settings = {}) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ stream: !settings.unary, input: [] }));
    const headers = { 'content-type': 'application/json' };
    if (!settings.chunked) headers['content-length'] = body.length;
    if (!settings.anonymous) headers['x-codex-turn-metadata'] = JSON.stringify({ request_kind: settings.kind ?? 'turn', thread_id: settings.thread ?? 'contract-thread', turn_id: settings.turn ?? 'contract-turn' });
    const client = http.request({ host: '127.0.0.1', port: proxy.status().port, path: settings.path ?? (settings.unary ? '/v1/responses/compact' : '/v1/responses'), method: 'POST', headers, signal: settings.signal }, response => {
      let result = '';
      response.on('data', chunk => { result += chunk.toString(); settings.onChunk?.(chunk.toString()); });
      response.once('end', () => resolve({ status: response.statusCode, body: result, events: parse(result) }));
      response.once('error', reject);
    });
    client.once('error', reject);
    client.end(body);
  });
  return { proxy, request, events, requestCount: () => requests };
}

test('module defaults use forty seconds for both progress timers', () => {
  const proxy = createCodexModelStreamProxy();
  assert.equal(proxy.status().firstProgressTimeoutMs, 40000);
  assert.equal(proxy.status().progressIdleTimeoutMs, 40000);
});

test('a tool name alone is not actual content, completed arguments are content', () => {
  assert.equal(isMeaningfulResponsesSseFrame(wire({ type: 'response.output_item.done', item: { type: 'function_call', name: 'safe' } })), false);
  assert.equal(isMeaningfulResponsesSseFrame(wire({ type: 'response.output_item.done', item: { type: 'function_call', name: 'safe', arguments: '{}' } })), true);
});

test('unknown server errors retry after visible text and completed does not wait for EOF', async context => {
  const setup = await fixture(context, (_request, response, count) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(wire({ type: 'response.output_text.delta', delta: 'kept text' }));
    if (count === 1) response.write(wire(failed('previously_unknown_server_code')));
    else response.write(wire(complete));
  });
  const started = Date.now();
  const first = await setup.request();
  assert.equal(first.events.some(event => event.type === 'response.completed'), false);
  const second = await setup.request();
  assert.equal(second.events.some(event => event.type === 'response.completed'), true);
  assert.ok(Date.now() - started < 800, 'terminal events must not wait for the 1000ms watchdog or EOF');
  assert.equal(setup.requestCount(), 2);
});

test('quota soft stops count distinct empty turns and third failure remains terminal', async context => {
  const setup = await fixture(context, (_request, response) => response.end(wire(failed('usage_limit_reached'))));
  for (const turn of ['one', 'two']) {
    const result = await setup.request({ turn });
    assert.equal(result.events.some(event => event.type === 'response.completed'), true);
  }
  const third = await setup.request({ turn: 'three' });
  assert.equal(third.events.some(event => event.type === 'response.failed'), true);
  assert.equal(third.events.some(event => event.type === 'response.completed'), false);
  const count = setup.requestCount();
  const replay = await setup.request({ turn: 'three' });
  assert.equal(replay.events.some(event => event.type === 'response.failed'), true);
  assert.equal(setup.requestCount(), count);
});

test('local compaction quota failure cannot become a synthetic summary', async context => {
  const setup = await fixture(context, (_request, response) => response.end(wire(failed('usage_limit_reached'))));
  const result = await setup.request({ kind: 'compaction' });
  assert.equal(result.events.some(event => event.type === 'response.completed'), false);
  assert.equal(result.events.some(event => event.type === 'response.output_item.done'), false);
});

test('unary compact failure returns JSON 502 with one upstream request', async context => {
  const setup = await fixture(context, (_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'server_error', message: 'fixture' } }));
  });
  const result = await setup.request({ kind: 'compaction', unary: true });
  assert.equal(result.status, 502);
  assert.ok(JSON.parse(result.body).error);
  assert.equal(setup.requestCount(), 1);
});

test('rapid retry top-up counts time spent in the first attempt', async context => {
  const setup = await fixture(context, async (_request, response, count) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count === 1) {
      for (let index = 0; index < 6; index += 1) {
        response.write(wire({ type: 'response.reasoning_text.delta', delta: 'progress' }));
        await pause(35);
      }
    }
    response.end();
  }, { firstProgressTimeoutMs: 100, progressIdleTimeoutMs: 100 });
  for (let index = 0; index < 5; index += 1) await setup.request();
  assert.equal(setup.events.some(event => event.type === 'rapid_retry_wait_started'), false);
});

test('fast five failures add only a single bounded wait before the last retry', async context => {
  const setup = await fixture(context, (_request, response) => response.end(), { firstProgressTimeoutMs: 150 });
  const started = Date.now();
  for (let index = 0; index < 5; index += 1) await setup.request();
  const waits = setup.events.filter(event => event.type === 'rapid_retry_wait_started');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].attemptNumber, 5);
  assert.ok(Date.now() - started >= 130);
  assert.ok(waits[0].delayMs <= 150);
});

test('new_context failure has safe IDLE without completing a tool or reusing its index', async context => {
  const setup = await fixture(context, (_request, response) => {
    const item = { type: 'function_call', id: 'tool_pending', call_id: 'call_pending', name: 'new_context', arguments: '{}' };
    response.end(wire({ type: 'response.created', response: { id: 'resp_control' } }) + wire({ type: 'response.output_item.added', output_index: 0, item }) + wire({ type: 'response.output_item.done', output_index: 0, item }));
  }, { maxConsecutiveAttempts: 1 });
  const result = await setup.request();
  assert.equal(result.events.filter(event => event.type === 'response.created').length, 1);
  assert.equal(result.events.some(event => event.type === 'response.output_item.done' && event.item?.type === 'function_call'), false);
  assert.equal(result.events.some(event => event.type === 'response.completed'), true);
  const notice = result.events.find(event => event.type === 'response.output_item.added' && event.item?.type === 'message');
  assert.ok(notice.output_index > 0);
});

test('tool completion is held but independent keepalive remains visible', async context => {
  let completedAt = null;
  const setup = await fixture(context, async (_request, response) => {
    const item = { type: 'function_call', id: 'tool1', call_id: 'call1', name: 'safe', arguments: '{}' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(wire({ type: 'response.output_item.added', output_index: 0, item }));
    response.write(wire({ type: 'response.output_item.done', output_index: 0, item }));
    await pause(20);
    response.write(wire({ type: 'response.in_progress' }));
    await pause(90);
    completedAt = Date.now();
    response.write(wire(complete));
  });
  let keepaliveBeforeCompleted = false;
  let toolBeforeCompleted = false;
  const result = await setup.request({ onChunk: chunk => {
    if (!completedAt && chunk.includes('proxy.keepalive')) keepaliveBeforeCompleted = true;
    if (!completedAt && chunk.includes('response.output_item.done')) toolBeforeCompleted = true;
  } });
  assert.equal(keepaliveBeforeCompleted, true);
  assert.equal(toolBeforeCompleted, false);
  assert.equal(result.events.filter(event => event.type === 'response.output_item.done').length, 1);
});

test('chunked requests retain the guard instead of bypassing it', async context => {
  const setup = await fixture(context, (_request, response) => response.end(), { maxConsecutiveAttempts: 1 });
  const result = await setup.request({ chunked: true });
  assert.equal(result.events.some(event => event.type === 'response.completed'), true);
  assert.equal(setup.proxy.status().counters.passthrough, 0);
});

test('observability callback errors cannot crash the request handler', async context => {
  const setup = await fixture(context, (_request, response) => response.end(wire(complete)), { onEvent() { throw new Error('fixture logging failure'); } });
  assert.equal((await setup.request()).events.some(event => event.type === 'response.completed'), true);
});

test('missing metadata uses an isolated soft stop, never unguarded passthrough', async context => {
  const setup = await fixture(context, (_request, response) => response.end());
  const result = await setup.request({ anonymous: true });
  assert.equal(result.events.some(event => event.type === 'response.completed'), true);
  assert.equal(setup.proxy.status().counters.passthrough, 0);
  assert.equal(setup.proxy.status().attemptChains, 0);
});

test('malformed absolute URL cannot escape upstream or crash the server', async context => {
  const setup = await fixture(context, (_request, response) => response.end(wire(complete)));
  assert.equal((await setup.request({ path: 'http://[invalid/responses' })).status, 400);
  assert.equal((await setup.request({ path: 'http://127.0.0.1:1/v1/responses' })).status, 400);
  assert.equal((await setup.request()).events.some(event => event.type === 'response.completed'), true);
  assert.equal(setup.requestCount(), 1);
});

test('oversized unfinished frame and invalid response index are request failures, not process failures', async context => {
  const setup = await fixture(context, (_request, response, count) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count === 1) response.end('data: ' + 'x'.repeat(4096));
    else if (count === 2) response.end(wire({ type: 'response.output_text.delta', content_index: 1000000000, delta: 'bad index' }));
    else response.end(wire(complete));
  }, { maxConsecutiveAttempts: 1, maxBufferedResponseBytes: 1024 });
  for (const turn of ['large-frame', 'bad-index', 'healthy']) {
    assert.equal((await setup.request({ turn })).events.some(event => event.type === 'response.completed'), true);
  }
  assert.equal(setup.requestCount(), 3);
});

test('downstream cancellation destroys the matching upstream without cancelling the next request', async context => {
  let upstreamClosed = false;
  const setup = await fixture(context, (_request, response, count) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (count === 1) {
      response.once('close', () => { upstreamClosed = true; });
      response.write(wire({ type: 'response.created', response: { id: 'resp_cancel' } }));
    } else response.end(wire(complete));
  });
  const controller = new AbortController();
  await assert.rejects(setup.request({ signal: controller.signal, onChunk: () => controller.abort() }));
  const deadline = Date.now() + 1000;
  while (!upstreamClosed && Date.now() < deadline) await pause(10);
  assert.equal(upstreamClosed, true);
  assert.equal((await setup.request({ turn: 'next' })).events.some(event => event.type === 'response.completed'), true);
  assert.equal(setup.proxy.status().counters.cancelled, 1);
  assert.equal(setup.proxy.status().activeRequests, 0);
});

test('structured tool done and following item metadata cannot bypass the commit barrier', async context => {
  let committed = false;
  const setup = await fixture(context, async (_request, response) => {
    const item = { type: 'local_shell_call', id: 'shell1', call_id: 'shell-call1', action: { type: 'exec', command: ['echo', 'fixture'] } };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(wire({ type: 'response.output_item.added', sequence_number: 0, output_index: 0, item }));
    response.write(wire({ type: 'response.output_item.done', sequence_number: 1, output_index: 0, item }));
    response.write(wire({ type: 'response.output_item.added', sequence_number: 2, output_index: 1, item: { type: 'message', id: 'after-tool', content: [] } }));
    response.write(wire({ type: 'response.in_progress', sequence_number: 3 }));
    await pause(60);
    committed = true;
    response.end(wire({ ...complete, sequence_number: 4 }));
  });
  let premature = false;
  const result = await setup.request({ onChunk: chunk => {
    if (!committed && (chunk.includes('response.output_item.done') || chunk.includes('after-tool'))) premature = true;
  } });
  assert.equal(premature, false);
  const sequences = result.events.map(event => event.sequence_number).filter(Number.isSafeInteger);
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
});
