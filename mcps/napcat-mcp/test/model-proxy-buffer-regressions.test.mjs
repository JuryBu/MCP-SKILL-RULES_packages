import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { collectRequestBody, createRequestBufferBudget } from "../src/request-body-buffer.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const metadata = threadId => JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: `${threadId}-turn` });
const completed = 'data: {"type":"response.completed"}\n\n';
const frame = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(1024) })}\n\n`;

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function fixture(context, options = {}, respond = response => response.end(completed)) {
  const sockets = new Set();
  const uploads = [];
  const downstreams = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.once("end", () => {
      uploads.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "text/event-stream" });
      respond(response);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    fastRetryDelayMs: 0, firstProgressTimeoutMs: 5000, progressIdleTimeoutMs: 5000, ...options });
  await proxy.start();
  proxy.server.on("request", (request, response) => downstreams.push(response));
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(proxy.status().activeRequests, 0);
    assert.equal(proxy.status().requestBuffer.usedBytes, 0);
    assert.equal(proxy.server.listening, false);
    assert.equal(upstream.listening, false);
  });
  return { proxy, uploads, downstreams, async raw(body, declaredLength = body.length, paused = false) {
    const socket = net.connect(proxy.status().port, "127.0.0.1");
    sockets.add(socket);
    socket.on("error", () => {});
    await once(socket, "connect");
    if (paused) socket.pause();
    socket.write(`POST /backend-api/codex/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${declaredLength}\r\nx-codex-turn-metadata: ${metadata(`fixture-${sockets.size}`)}\r\n\r\n`);
    socket.write(body);
    return socket;
  } };
}

async function ordinaryRequest(state, input = "healthy") {
  const body = Buffer.from(JSON.stringify({ stream: true, input }));
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: state.proxy.status().port,
      path: "/backend-api/codex/responses", method: "POST", signal: AbortSignal.timeout(4000),
      headers: { "content-type": "application/json", "content-length": body.length,
        "x-codex-turn-metadata": metadata(`healthy-${state.uploads.length}`) } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("ordinary incomplete upload expires without EOF, releases lease and admits the next turn", { timeout: 6000 }, async context => {
  const state = await fixture(context, { requestInspectionTimeoutMs: 100, maxTotalRequestBytes: 1024,
    maxBufferedRequestBytes: 1024, maxDecodedRequestBytes: 1024 });
  const client = await state.raw(Buffer.alloc(899, "x"), 900);
  let text = "";
  client.on("data", chunk => { text += chunk; });
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 899, "partial upload reserves quota");
  await waitFor(() => state.proxy.status().activeRequests === 0, "idle upload must expire automatically");
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  assert.equal(state.uploads.length, 0);
  await waitFor(() => text.includes("REQUEST_BODY_IDLE_TIMEOUT"), "client receives a local upload timeout");
  assert.match(text, /408/u);
  assert.equal((await ordinaryRequest(state)).status, 200);
  assert.equal(state.uploads.length, 1);
});

test("zero-byte upload expires and shutdown leaves no receive timer or active request", { timeout: 6000 }, async context => {
  const state = await fixture(context, { requestInspectionTimeoutMs: 80 });
  await state.raw(Buffer.alloc(0), 1024);
  await waitFor(() => state.downstreams.length === 1, "request reaches proxy");
  await waitFor(() => state.proxy.status().activeRequests === 0, "empty upload expires");
  assert.equal(state.uploads.length, 0);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
});

test("upload deadline resets on data, preserves exact bytes and releases quota on success", { timeout: 6000 }, async () => {
  const request = new PassThrough();
  const budget = createRequestBufferBudget(4 * 1024 * 1024);
  const lease = budget.lease();
  const collecting = collectRequestBody(request, 4 * 1024 * 1024, lease, undefined, { idleTimeoutMs: 100 });
  const expected = Buffer.alloc(2 * 1024 * 1024, "x");
  const chunkBytes = expected.length / 4;
  for (let index = 0; index < 4; index += 1) {
    request.write(expected.subarray(index * chunkBytes, (index + 1) * chunkBytes));
    await delay(40);
  }
  request.end();
  assert.deepEqual(await collecting, expected);
  assert.equal(budget.status().usedBytes, expected.length);
  lease.release();
  assert.equal(budget.status().usedBytes, 0);
  assert.equal(request.listenerCount("data"), 0);
  await delay(110);
});

test("receive cancellation releases its lease and all collector listeners", async () => {
  const request = new PassThrough();
  const budget = createRequestBufferBudget(1024);
  const lease = budget.lease();
  const controller = new AbortController();
  const collecting = collectRequestBody(request, 1024, lease, controller.signal);
  request.write(Buffer.alloc(512));
  const rejected = assert.rejects(collecting, { code: "REQUEST_ABORTED" });
  controller.abort();
  await rejected;
  assert.equal(budget.status().usedBytes, 0);
  for (const event of ["data", "end", "aborted", "error"]) assert.equal(request.listenerCount(event), 0);
  request.destroy();
});

test("paused downstream applies bounded drain backpressure and cancels without replay", { timeout: 6000 }, async context => {
  const state = await fixture(context, { maxBufferedResponseBytes: 4096 }, response => {
    for (let index = 0; index < 12000; index += 1) response.write(frame);
    response.end(completed);
  });
  const client = await state.raw(Buffer.from(JSON.stringify({ stream: true, input: [] })), undefined, true);
  await waitFor(() => state.downstreams[0]?.writableNeedDrain, "downstream must reach backpressure");
  const downstream = state.downstreams[0];
  const buffered = downstream.writableLength;
  await delay(100);
  assert.ok(downstream.writableLength <= downstream.writableHighWaterMark + Buffer.byteLength(frame), "writer stays within high-water mark plus one frame");
  assert.ok(buffered < 100_000);
  assert.equal(state.proxy.status().activeRequests, 1);
  assert.equal(state.proxy.status().counters.completed, 0);
  assert.equal(downstream.writableEnded, false);
  client.destroy();
  await waitFor(() => state.proxy.status().activeRequests === 0, "close cancels active delivery");
  assert.equal(downstream.listenerCount("drain"), 0);
  assert.equal(downstream.writableLength, 0);
  assert.equal(state.uploads.length, 1);
  context.diagnostic(JSON.stringify({ buffered, highWaterMark: downstream.writableHighWaterMark,
    activeAfterClose: state.proxy.status().activeRequests, bufferedAfterClose: downstream.writableLength, upstreamPosts: state.uploads.length }));
});

test("resuming a paused reader drains every frame in order and completes exactly once", { timeout: 10000 }, async context => {
  const frameCount = 6000;
  const expectedFrames = Array.from({ length: frameCount }, (_, index) => JSON.stringify({ type: "response.output_text.delta", delta: `${index}:${"x".repeat(1024)}` }));
  const completionEvent = completed.trim().slice(6);
  const expected = Buffer.from(expectedFrames.map(event => `data: ${event}\n\n`).join("") + completed);
  const state = await fixture(context, { maxBufferedResponseBytes: 4096 }, response => response.end(expected));
  const client = await state.raw(Buffer.from(JSON.stringify({ stream: true, input: [] })), undefined, true);
  await waitFor(() => state.downstreams[0]?.writableNeedDrain, "stream reaches backpressure");
  assert.equal(state.proxy.status().activeRequests, 1);
  let text = "";
  client.on("data", chunk => { text += chunk; });
  client.resume();
  await waitFor(() => state.proxy.status().counters.completed === 1, "resumed stream completes", 6000);
  await waitFor(() => text.includes('"type":"response.completed"'), "completion reaches the reader");
  assert.equal((text.match(/response\.output_text\.delta/gu) ?? []).length, frameCount);
  assert.equal((text.match(/response\.completed/gu) ?? []).length, 1);
  const receivedFrames = text.split(/\r?\n/u).filter(line => line.startsWith("data: ")).map(line => line.slice(6));
  assert.deepEqual(receivedFrames, [...expectedFrames, completionEvent]);
  assert.equal(state.proxy.status().activeRequests, 0);
  assert.equal(state.uploads.length, 1);
  assert.equal(state.downstreams[0].writableLength, 0);
  client.destroy();
});

test("a reader that never drains is cancelled within the existing idle limit", { timeout: 6000 }, async context => {
  const state = await fixture(context, { upstreamIdleTimeoutMs: 100, maxBufferedResponseBytes: 4096 }, response => {
    for (let index = 0; index < 12000; index += 1) response.write(frame);
    response.end(completed);
  });
  await state.raw(Buffer.from(JSON.stringify({ stream: true, input: [] })), undefined, true);
  await waitFor(() => state.downstreams[0]?.writableNeedDrain, "writer blocks on reader");
  await waitFor(() => state.proxy.status().activeRequests === 0, "drain wait expires");
  assert.equal(state.downstreams[0].destroyed, true);
  assert.equal(state.downstreams[0].writableLength, 0);
  assert.equal(state.downstreams[0].listenerCount("drain"), 0);
  assert.equal(state.proxy.status().counters.completed, 0);
  assert.equal(state.uploads.length, 1);
});

test("stopping the isolated proxy closes a backpressured response and clears drain listeners", { timeout: 6000 }, async context => {
  const state = await fixture(context, { maxBufferedResponseBytes: 4096 }, response => {
    for (let index = 0; index < 12000; index += 1) response.write(frame);
    response.end(completed);
  });
  await state.raw(Buffer.from(JSON.stringify({ stream: true, input: [] })), undefined, true);
  await waitFor(() => state.downstreams[0]?.writableNeedDrain, "writer reaches drain wait");
  await state.proxy.stop();
  await waitFor(() => state.downstreams[0].writableLength === 0, "shutdown clears writer queue");
  assert.equal(state.proxy.status().activeRequests, 0);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  assert.equal(state.downstreams[0].destroyed, true);
  assert.equal(state.downstreams[0].listenerCount("drain"), 0);
  assert.equal(state.uploads.length, 1);
});
