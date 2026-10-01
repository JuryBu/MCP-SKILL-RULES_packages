import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const progress = frame({ type: "response.in_progress" });
const complete = frame({ type: "response.completed", response: { id: "fixture", status: "completed", model: "fixture-model", output: [] } });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const largeBody = (stream = true) => Buffer.from(JSON.stringify({ model: "fixture-model", stream, input: [], data: "a".repeat(1024 * 1024) }));

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function fixture(context, options = {}, respond = ({ response }) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(complete);
}) {
  const received = [];
  const handlerErrors = [];
  const clients = new Set();
  const upstreamSockets = new Set();
  const upstream = http.createServer();
  let proxy;
  upstream.on("connection", socket => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
  });
  upstream.on("request", (request, response) => {
    (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const record = { body, bytes: body.length, hash: hash(body),
        encoding: request.headers["content-encoding"] ?? null, request, response, uploadedAt: performance.now() };
      received.push(record);
      await respond(record, received.length);
    })().catch(error => {
      if (!request.aborted && !response.destroyed) handlerErrors.push(error);
      response.destroy();
    });
  });
  context.after(async () => {
    for (const client of clients) client.destroy();
    if (proxy) await proxy.stop();
    for (const socket of upstreamSockets) socket.destroy();
    await close(upstream);
    assert.deepEqual(handlerErrors, []);
  });
  const upstreamPort = await listen(upstream);
  proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 5000, progressIdleTimeoutMs: 5000, ...options });
  await proxy.start();
  const send = (body, encoding, extra = {}) => {
    const pending = new Promise((resolve, reject) => {
      const headers = { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({
        request_kind: extra.requestKind ?? "turn", thread_id: extra.threadId ?? "body-lifetime-test",
        turn_id: extra.turnId ?? crypto.randomUUID(),
      }) };
      if (encoding) headers["content-encoding"] = encoding;
      if (extra.accept) headers.accept = extra.accept;
      if (!extra.chunked) headers["content-length"] = body.length;
      const request = http.request({ host: "127.0.0.1", port: proxy.status().port, method: "POST",
        path: extra.path ?? "/v1/responses", headers, signal: extra.signal }, response => {
        let text = "";
        let settled = false;
        const finish = aborted => {
          if (settled) return;
          settled = true;
          resolve({ status: response.statusCode, headers: response.headers, text, aborted, finishedAt: performance.now() });
        };
        response.on("data", chunk => { text += chunk; extra.onData?.(chunk); });
        response.once("end", () => finish(false));
        response.once("aborted", () => finish(true));
        response.once("error", error => { if (!settled) reject(error); });
      });
      clients.add(request);
      request.once("close", () => clients.delete(request));
      request.once("error", reject);
      if (extra.open) request.write(body);
      else request.end(body);
    });
    pending.catch(() => {});
    return pending;
  };
  return { proxy, send, received, upstream, upstreamPort };
}

function assertUploaded(record, body, encoding = null) {
  assert.equal(record.bytes, body.length);
  assert.equal(record.hash, hash(body));
  assert.deepEqual(record.body, body);
  assert.equal(record.encoding, encoding);
}

function assertIdle(state) {
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  assert.equal(state.proxy.status().requestInspection.active, 0);
  assert.equal(state.proxy.status().requestInspection.queued, 0);
  assert.equal(state.proxy.status().activeRequests, 0);
}

test("completed upload releases encoded quota while a healthy response is still pending and admits a second large body", async context => {
  const body = largeBody();
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096 }, ({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(progress);
  });
  assert.ok(body.length * 2 > state.proxy.status().requestBuffer.maxBytes);
  let firstSettled = false;
  const first = state.send(body);
  first.finally(() => { firstSettled = true; }).catch(() => {});
  await waitFor(() => state.received.length === 1, "first large body must reach upstream");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "uploaded body must not occupy encoded quota during generation");
  assert.equal(firstSettled, false);
  assert.equal(state.received[0].response.writableEnded, false);
  assert.equal(state.proxy.status().activeRequests, 1);
  assert.equal(state.proxy.status().requestInspection.active, 0);
  const second = state.send(body);
  await waitFor(() => state.received.length === 2, "second large body must fit while the first response remains pending");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "second upload must also release its encoded quota");
  assert.equal(firstSettled, false);
  assert.equal(state.proxy.status().activeRequests, 2);
  for (const record of state.received) {
    assertUploaded(record, body);
    assert.equal(record.response.writableEnded, false);
    record.response.end(complete);
  }
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.aborted, false);
    assert.equal(result.text, progress + complete);
  }
  assertIdle(state);
});

test("native first-progress timeout leaves no old body and client reupload retains the retry deadline and exact bytes", async context => {
  const body = largeBody();
  const firstTimeoutMs = 200;
  const retryTimeoutMs = 700;
  const retryGenerationMs = 350;
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096,
    firstProgressTimeoutMs: firstTimeoutMs, retryFirstProgressTimeoutMs: retryTimeoutMs,
    uploadAllowanceMsPerMiB: 0, maxUploadAllowanceMs: 0 }, ({ response }, attempt) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(progress);
    if (attempt === 2) {
      const timer = setTimeout(() => response.end(complete), retryGenerationMs);
      response.once("close", () => clearTimeout(timer));
    }
  });
  const identity = { threadId: "body-lifetime-native-retry", turnId: "same-turn" };
  const firstPending = state.send(body, undefined, identity);
  await waitFor(() => state.received.length === 1, "first retryable upload must reach upstream");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "first attempt must release quota before its timeout", firstTimeoutMs);
  assert.equal(state.proxy.status().activeRequests, 1);
  const first = await firstPending;
  const firstElapsedMs = first.finishedAt - state.received[0].uploadedAt;
  assert.equal(first.status, 200);
  assert.equal(first.aborted, false);
  assert.doesNotMatch(first.text, /response\.completed/u);
  assert.ok(firstElapsedMs >= firstTimeoutMs - 70, `first deadline fired too early: ${firstElapsedMs} ms`);
  assert.ok(firstElapsedMs < firstTimeoutMs + 500, `first deadline changed: ${firstElapsedMs} ms`);
  assert.equal(state.received.length, 1);
  assert.equal(state.proxy.status().counters.retrySignals, 1);
  assertIdle(state);
  const secondPending = state.send(body, undefined, identity);
  await waitFor(() => state.received.length === 2, "native retry must reupload from the client, not replay the old package");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "retry upload must release quota during its longer generation window");
  assert.equal(state.proxy.status().activeRequests, 1);
  const second = await secondPending;
  const retryElapsedMs = second.finishedAt - state.received[1].uploadedAt;
  assert.equal(second.status, 200);
  assert.equal(second.aborted, false);
  assert.match(second.text, /response\.completed/u);
  assert.ok(retryElapsedMs >= retryGenerationMs - 50, `retry generation was interrupted: ${retryElapsedMs} ms`);
  assert.ok(retryElapsedMs < retryTimeoutMs + 300, `retry did not retain its configured window: ${retryElapsedMs} ms`);
  assert.equal(state.proxy.status().firstProgressTimeoutMs, firstTimeoutMs);
  assert.equal(state.proxy.status().retryFirstProgressTimeoutMs, retryTimeoutMs);
  assert.equal(state.proxy.status().counters.retrySignals, 1);
  for (const record of state.received) assertUploaded(record, body);
  assertIdle(state);
});

test("releasing an uploaded body preserves its nonzero byte-based first-progress allowance", async context => {
  const body = largeBody();
  const firstTimeoutMs = 150;
  const generationMs = 325;
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096,
    firstProgressTimeoutMs: firstTimeoutMs, uploadAllowanceMsPerMiB: 300, maxUploadAllowanceMs: 600 }, ({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(progress);
    const timer = setTimeout(() => response.end(complete), generationMs);
    response.once("close", () => clearTimeout(timer));
  });
  const pending = state.send(body);
  await waitFor(() => state.received.length === 1, "allowance test must finish its upstream upload");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "upload quota must be free before the allowance is used");
  await delay(firstTimeoutMs + 30);
  assert.equal(state.proxy.status().activeRequests, 1);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  const result = await pending;
  const elapsedMs = result.finishedAt - state.received[0].uploadedAt;
  assert.equal(result.status, 200);
  assert.equal(result.text, progress + complete);
  assert.ok(elapsedMs >= generationMs - 50, `byte-based allowance disappeared after release: ${elapsedMs} ms`);
  assert.equal(state.proxy.status().uploadAllowanceMsPerMiB, 300);
  assert.equal(state.proxy.status().maxUploadAllowanceMs, 600);
  assert.equal(state.proxy.status().counters.retrySignals, 0);
  assertUploaded(state.received[0], body);
  assertIdle(state);
});

test("compressed inspection worker exits and releases the original wire-body quota before generation finishes", async context => {
  const decoded = Buffer.from(JSON.stringify({ model: "fixture-model", stream: true, input: [],
    data: crypto.randomBytes(512 * 1024).toString("base64") }));
  const body = zlib.gzipSync(decoded);
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxDecodedRequestBytes: decoded.length,
    maxTotalRequestBytes: body.length + 4096 }, ({ response }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(progress);
  });
  assert.ok(body.length > 512 * 1024);
  assert.ok(body.length * 2 > state.proxy.status().requestBuffer.maxBytes);
  const first = state.send(body, "gzip");
  await waitFor(() => state.received.length === 1, "compressed body must reach upstream");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "gzip wire quota must be released while response remains open");
  assert.equal(state.proxy.status().requestInspection.active, 0);
  assert.equal(state.proxy.status().requestInspection.queued, 0);
  assert.equal(state.proxy.status().activeRequests, 1);
  const second = state.send(body, "gzip");
  await waitFor(() => state.received.length === 2, "second compressed body must fit after the first worker exits");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "second compressed upload must release quota");
  for (const record of state.received) {
    assertUploaded(record, body, "gzip");
    assert.equal(record.response.writableEnded, false);
    record.response.end(complete);
  }
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.equal(result.text, progress + complete);
  }
  assertIdle(state);
});

for (const transport of ["unary", "sse"]) {
  test(`buffered compaction ${transport} releases upload quota without exposing a partial response or losing its result`, async context => {
    const body = largeBody(transport === "sse");
    const item = { id: "compact-item", type: "compaction", encrypted_content: "fixture" };
    const unary = JSON.stringify({ id: "compact-fixture", object: "response.compaction", output: [item] });
    const sseTail = frame({ type: "response.output_item.done", output_index: 0, item })
      + frame({ type: "response.completed", response: { id: "compact-fixture", status: "completed", model: "fixture-model", output: [item] } });
    const expected = transport === "sse" ? progress + sseTail : unary;
    const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096 }, ({ request, response }) => {
      const metadata = JSON.parse(request.headers["x-codex-turn-metadata"]);
      response.writeHead(200, { "content-type": metadata.request_kind === "compaction" && transport === "unary" ? "application/json" : "text/event-stream" });
      if (metadata.request_kind === "compaction") response.write(transport === "sse" ? progress : unary.slice(0, 25));
      else response.end(complete);
    });
    let settled = false;
    let exposedBytes = 0;
    const pending = state.send(body, undefined, { path: "/v1/responses/compact", requestKind: "compaction",
      accept: transport === "sse" ? "text/event-stream" : "application/json", onData: chunk => { exposedBytes += chunk.length; } });
    pending.finally(() => { settled = true; }).catch(() => {});
    await waitFor(() => state.received.length === 1, "compaction body must reach upstream");
    await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "buffered compaction must release encoded quota before response completion");
    assert.equal(settled, false);
    assert.equal(state.proxy.status().activeRequests, 1);
    assertUploaded(state.received[0], body);
    assert.equal(state.received[0].response.writableEnded, false);
    const other = await state.send(largeBody());
    assert.equal(other.status, 200);
    assert.equal(other.text, complete);
    assert.equal(settled, false);
    assert.equal(exposedBytes, 0);
    assert.equal(state.received.length, 2);
    assertUploaded(state.received[1], largeBody());
    state.received[0].response.end(transport === "sse" ? sseTail : unary.slice(25));
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(result.aborted, false);
    assert.equal(result.text, expected);
    assertIdle(state);
  });
}

test("connection failure before upstream upload releases quota and the same proxy admits a healthy request afterwards", async context => {
  const body = largeBody();
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096 });
  await close(state.upstream);
  const failed = await state.send(body);
  assert.equal(failed.status, 200);
  assert.doesNotMatch(failed.text, /response\.completed/u);
  assert.equal(state.received.length, 0);
  await waitFor(() => state.proxy.status().activeRequests === 0 && state.proxy.status().requestBuffer.usedBytes === 0,
    "failed upstream connection must release all encoded quota");
  assertIdle(state);
  await listen(state.upstream, state.upstreamPort);
  const recovered = await state.send(body);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.text, complete);
  assert.equal(state.received.length, 1);
  assertUploaded(state.received[0], body);
  assertIdle(state);
});

test("client cancellation before body EOF releases held quota and permits another large request", async context => {
  const body = largeBody();
  const partial = body.subarray(0, 256 * 1024);
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096 });
  const controller = new AbortController();
  const pending = state.send(partial, undefined, { chunked: true, open: true, signal: controller.signal });
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === partial.length, "unfinished body must actually reserve encoded quota");
  assert.equal(state.received.length, 0);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  await waitFor(() => state.proxy.status().activeRequests === 0 && state.proxy.status().requestBuffer.usedBytes === 0,
    "client abort before upload must release held quota");
  assertIdle(state);
  const recovered = await state.send(body);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.text, complete);
  assert.equal(state.received.length, 1);
  assertUploaded(state.received[0], body);
  assertIdle(state);
});

test("client cancellation during healthy pending generation leaves no encoded quota and does not block other uploads", async context => {
  const body = largeBody();
  const state = await fixture(context, { maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length + 4096 }, ({ response }, attempt) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (attempt === 1) response.write(progress);
    else response.end(complete);
  });
  const controller = new AbortController();
  const pending = state.send(body, undefined, { signal: controller.signal });
  await waitFor(() => state.received.length === 1, "cancelled request must first finish its upstream upload");
  await waitFor(() => state.proxy.status().requestBuffer.usedBytes === 0, "healthy generation must not hold encoded quota before cancellation");
  assert.equal(state.proxy.status().activeRequests, 1);
  controller.abort();
  const cancellation = await pending.then(result => ({ result }), error => ({ error }));
  if (cancellation.error) assert.equal(cancellation.error.name, "AbortError");
  else {
    assert.equal(cancellation.result.aborted, true);
    assert.doesNotMatch(cancellation.result.text, /response\.completed/u);
  }
  await waitFor(() => state.proxy.status().activeRequests === 0, "cancelled generation must finish proxy cleanup");
  assertIdle(state);
  const recovered = await state.send(body);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.text, complete);
  assert.equal(state.received.length, 2);
  for (const record of state.received) assertUploaded(record, body);
  assertIdle(state);
});
