import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const complete = frame({ type: "response.completed", response: { id: "limit-fixture", status: "completed", output: [] } });

async function run(context, handle) {
  const events = [];
  const upstream = http.createServer(handle);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, maxBufferedResponseBytes: 1024,
    onEvent: event => events.push(event) });
  await proxy.start();
  context.after(async () => { await proxy.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: proxy.status().port, path: "/v1/responses", method: "POST",
      headers: { "content-type": "application/json" } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.once("end", () => resolve({ body, status: response.statusCode }));
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("downstream aborted")));
    });
    request.once("error", reject);
    request.end('{"model":"fixture","stream":true,"input":[]}');
  });
  return { response, events };
}

for (const split of [false, true]) {
  test(`multiple legal SSE frames do not share one size allowance (split=${split})`, async context => {
    const delta = frame({ type: "response.output_text.delta", delta: "文".repeat(180) });
    assert.ok(Buffer.byteLength(delta) < 1024);
    assert.ok(Buffer.byteLength(delta.repeat(2)) > 1024);
    const state = await run(context, (request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (split) { response.write(delta); setTimeout(() => response.end(delta + complete), 20); }
      else response.end(delta.repeat(2) + complete);
    });
    assert.equal(state.response.body, delta.repeat(2) + complete);
    assert.equal(state.events.some(event => event.reason === "SSE_FRAME_LIMIT"), false);
  });
}

for (const unfinished of [false, true]) {
  test(`individual oversized SSE frame still fails (unfinished=${unfinished})`, async context => {
    const state = await run(context, (request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: " + "x".repeat(1100) + (unfinished ? "" : "\n\n"));
    });
    assert.ok(state.events.some(event => event.type === "turn_attempt_finished" && event.reason === "SSE_FRAME_LIMIT"));
  });
}

for (const status of [403, 429, 503]) {
  test(`HTTP ${status} retains its retry classification when its error body is oversized`, async context => {
    const state = await run(context, (request, response) => {
      request.resume();
      response.writeHead(status, { "content-type": "text/html" });
      response.end("x".repeat(2048));
    });
    const failure = state.events.find(event => event.type === "turn_attempt_finished");
    assert.equal(failure.reason, `HTTP_${status}`);
    assert.equal(failure.kind, status === 403 ? "permanent_failure" : "retryable_failure");
    assert.ok(state.events.some(event => event.type === "upstream_error_body_unavailable" && event.statusCode === status));
  });
}
