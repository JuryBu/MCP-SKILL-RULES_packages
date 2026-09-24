import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { once } from "node:events";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const complete = frame({ type: "response.completed", response: { id: "fixture", status: "completed", model: "fixture-model", output: [] } });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(context, options = {}) {
  const received = [];
  const events = [];
  const observations = [];
  const upstream = http.createServer(async (request, response) => {
    const digest = crypto.createHash("sha256");
    let bytes = 0;
    for await (const chunk of request) { digest.update(chunk); bytes += chunk.length; }
    received.push({ bytes, hash: digest.digest("hex"), encoding: request.headers["content-encoding"] ?? null });
    response.writeHead(200, { "content-type": "text/event-stream", "openai-model": "fixture-model" });
    response.end(complete);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    onEvent: event => events.push(event), onModelObservation: event => observations.push(event), ...options });
  await proxy.start();
  context.after(async () => { await proxy.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const send = (body, encoding, extra = {}) => new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "body-test", turn_id: crypto.randomUUID() }) };
    if (encoding) headers["content-encoding"] = encoding;
    if (!extra.chunked) headers["content-length"] = body.length;
    const request = http.request({ host: "127.0.0.1", port: proxy.status().port, method: "POST", path: "/v1/responses", headers, signal: extra.signal }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
      response.once("error", reject);
    });
    request.once("error", reject);
    if (extra.open) request.write(body);
    else request.end(body);
  });
  return { proxy, send, events, observations, received };
}

test("decoded and wire limits are independent and original compressed bytes survive forwarding", async context => {
  const state = await fixture(context, { maxBufferedRequestBytes: 1024, maxDecodedRequestBytes: 4096 });
  const body = Buffer.from(JSON.stringify({ model: "fixture-model", stream: true, input: [], data: "a".repeat(3000) }));
  const encoded = zlib.gzipSync(body);
  const response = await state.send(encoded, "gzip");
  assert.equal(response.status, 200);
  assert.equal(response.text, complete);
  assert.deepEqual(state.received, [{ bytes: encoded.length, hash: hash(encoded), encoding: "gzip" }]);
  assert.ok(state.events.some(event => event.type === "request_body_inspected" && event.decodedBytes === body.length));
  assert.ok(state.observations.some(event => event.request_sent && event.upstream_response_model === "fixture-model"));
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
});

test("typed decoding failures are received by the HTTP client and never forwarded", async context => {
  const state = await fixture(context, { maxBufferedRequestBytes: 1024, maxDecodedRequestBytes: 2048 });
  const cases = [
    [zlib.gzipSync(Buffer.from(JSON.stringify({ text: "a".repeat(3000) }))), "gzip", 413, "decoded_body_too_large"],
    [Buffer.from("not-gzip"), "gzip", 400, "invalid_compression"],
    [Buffer.from("{}"), "future-encoding", 415, "unsupported_content_encoding"],
    [Buffer.from("{broken"), undefined, 400, "invalid_json"],
    [Buffer.from("[]"), undefined, 400, "invalid_json_object"],
  ];
  for (const [body, encoding, status, code] of cases) {
    const response = await state.send(body, encoding);
    assert.equal(response.status, status);
    assert.equal(JSON.parse(response.text).error.code, code);
  }
  assert.equal(state.received.length, 0);
  assert.equal(state.observations.some(event => event.request_sent), false);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  const success = await state.send(Buffer.from('{"input":[]}'));
  assert.equal(success.status, 200);
});

test("wire overflow returns readable 413 before EOF rather than destroying the response", async context => {
  const state = await fixture(context, { maxBufferedRequestBytes: 1024 });
  const response = await state.send(Buffer.alloc(2048, 65), undefined, { chunked: true, open: true });
  assert.equal(response.status, 413);
  assert.equal(JSON.parse(response.text).error.code, "ENCODED_BODY_TOO_LARGE");
  assert.equal(state.received.length, 0);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
});

test("exact wire boundary remains valid, plus one is rejected", async context => {
  const state = await fixture(context, { maxBufferedRequestBytes: 1024 });
  const exact = Buffer.from(JSON.stringify({ data: "a".repeat(1013) }));
  assert.equal(exact.length, 1024);
  assert.equal((await state.send(exact)).status, 200);
  const over = Buffer.from(JSON.stringify({ data: "a".repeat(1014) }));
  assert.equal((await state.send(over)).status, 413);
  assert.equal(state.received.length, 1);
});

test("aggregate encoded budget rejects with 503 and recovers after cancellation", async context => {
  const state = await fixture(context, { maxTotalRequestBytes: 1024, maxBufferedRequestBytes: 2048 });
  const controller = new AbortController();
  const pending = state.send(Buffer.alloc(900, 32), undefined, { chunked: true, open: true, signal: controller.signal });
  pending.catch(() => {});
  for (let attempts = 0; attempts < 100 && state.proxy.status().requestBuffer.usedBytes !== 900; attempts++) await delay(5);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 900);
  const response = await state.send(Buffer.from(JSON.stringify({ data: "b".repeat(200) })));
  assert.equal(response.status, 503);
  assert.equal(response.headers["retry-after"], "1");
  assert.equal(JSON.parse(response.text).error.code, "REQUEST_BUFFER_BUSY");
  controller.abort();
  await assert.rejects(pending);
  for (let attempts = 0; attempts < 100 && state.proxy.status().requestBuffer.usedBytes !== 0; attempts++) await delay(5);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  assert.equal((await state.send(Buffer.from('{"input":[]}'))).status, 200);
});

test("cancellation during queued inspection never reaches upstream and releases buffers", async context => {
  const state = await fixture(context);
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const pending = controllers.map(controller => state.send(Buffer.from(JSON.stringify({ input: [], data: "a".repeat(80000) })), undefined, { signal: controller.signal }));
  for (const result of pending) result.catch(() => {});
  for (let attempts = 0; attempts < 100 && state.proxy.status().requestInspection.queued < 1; attempts++) await delay(1);
  for (const controller of controllers) controller.abort();
  await Promise.allSettled(pending);
  for (let attempts = 0; attempts < 100 && state.proxy.status().activeRequests > 0; attempts++) await delay(5);
  assert.equal(state.proxy.status().requestInspection.active, 0);
  assert.equal(state.proxy.status().requestInspection.queued, 0);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
  assert.equal(state.received.length, 0);
});

test("context hints and adaptive model identity preserve their original meanings", async context => {
  const state = await fixture(context);
  const body = Buffer.from(JSON.stringify({ model: "fixture-model", stream: true, input: [
    { encrypted_content: "fixture" },
    { role: "developer", content: [{ type: "input_text", text: "<context_window_reminder>bounded</context_window_reminder>" }] },
  ] }));
  assert.equal((await state.send(body)).status, 200);
  const event = state.events.find(entry => entry.type === "request_phase_observed");
  assert.equal(event.reminderCount, 1);
  assert.equal(event.opaqueItems, 1);
  assert.equal(event.inputItems, 2);
  assert.equal(state.observations.find(entry => entry.phase === "request.parsed").proxy_input_model, "fixture-model");
});
