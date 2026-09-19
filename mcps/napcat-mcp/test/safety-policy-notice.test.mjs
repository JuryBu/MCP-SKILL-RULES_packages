import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const notice = "触发栅栏检查，可能是误报，请避免类似内容";
const frame = event => `data: ${JSON.stringify(event)}\n\n`;

async function fixture(context, reply) {
  let calls = 0;
  const events = [];
  const upstream = http.createServer((request, response) => {
    calls += 1;
    reply(response);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    firstProgressTimeoutMs: 1000,
    maxConsecutiveAttempts: 6,
    onEvent: event => events.push(event),
  });
  await proxy.start();
  context.after(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  return {
    proxy, events,
    calls: () => calls,
    async request({ kind = "turn", turn = "test-turn", path = "responses" } = {}) {
      const result = await fetch(`http://127.0.0.1:${proxy.status().port}/backend-api/codex/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-turn-metadata": JSON.stringify({ request_kind: kind, thread_id: "safety-test", turn_id: turn }),
        },
        body: JSON.stringify(path === "responses/compact" ? { input: [] } : { stream: true, tools: [] }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: result.status, body: await result.text() };
    },
  };
}

for (const [name, event] of [
  ["bio policy", { type: "response.failed", response: { error: { code: "bio_policy" } } }],
  ["content filter", { type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" } } }],
  ["policy violation", { type: "error", error: { code: "content_policy_violation" } }],
  ["normalized code", { type: "error", code: " BIO_POLICY " }],
]) {
  test(`${name} produces exact safety notice without retry`, async context => {
    const server = await fixture(context, response => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame(event));
    });
    const result = await server.request();
    assert.ok(result.body.includes(notice));
    assert.ok(!result.body.includes("请继续"));
    assert.equal(server.calls(), 1);
    assert.equal(server.proxy.status().counters.retrySignals, 0);
    assert.equal(server.proxy.status().counters.actualCompletions, 0);
    assert.ok(server.events.some(event => event.type === "safety_policy_completed_idle"));
  });
}

for (const status of [200, 400, 429, 500]) {
  test(`HTTP ${status} safety error overrides transport retry policy`, async context => {
    const server = await fixture(context, response => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "bio_policy" } }));
    });
    const result = await server.request();
    assert.ok(result.body.includes(notice));
    assert.equal(server.calls(), 1);
    assert.equal(server.proxy.status().counters.retrySignals, 0);
  });
}

test("unrelated server error mentioning policy is still retryable", async context => {
  const server = await fixture(context, response => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "server_error", message: "bio_policy service unavailable" } }));
  });
  const result = await server.request();
  assert.ok(!result.body.includes(notice));
  assert.equal(server.proxy.status().counters.retrySignals, 1);
});

test("repeated separate safety turns retain the exact notice", async context => {
  const server = await fixture(context, response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame({ type: "error", code: "bio_policy" }));
  });
  for (const turn of ["first", "second", "third", "fourth"]) {
    const result = await server.request({ turn });
    assert.ok(result.body.includes(notice));
    assert.ok(!result.body.includes("proxy_repeated_empty_idle"));
  }
  assert.equal(server.calls(), 4);
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});

test("SSE compaction safety failure never fabricates completed compaction", async context => {
  const server = await fixture(context, response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame({ type: "error", code: "bio_policy" }));
  });
  const result = await server.request({ kind: "compaction" });
  assert.ok(result.body.includes(notice));
  assert.ok(result.body.includes("response.failed"));
  assert.ok(!result.body.includes("response.completed"));
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});

test("unary compaction safety failure returns nonretryable JSON", async context => {
  const server = await fixture(context, response => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "bio_policy" } }));
  });
  const result = await server.request({ kind: "compaction", path: "responses/compact" });
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.body).error.message, notice);
  assert.equal(server.calls(), 1);
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});
