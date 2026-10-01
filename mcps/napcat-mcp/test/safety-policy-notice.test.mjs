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

for (const code of ["cyber_policy", "misalignment_policy_violation", "invalid_prompt"]) {
  for (const shape of ["response.failed", "response.incomplete", "error", "normalized"]) {
    test(`${code} ${shape} stops once with the upstream rejection reason`, async context => {
      const message = "This request was blocked by the upstream service.";
      const event = shape === "response.failed"
        ? { type: shape, response: { error: { code, message } } }
        : shape === "response.incomplete"
          ? { type: shape, response: { incomplete_details: { reason: code } } }
          : { type: "error", error: { code: shape === "normalized" ? ` ${code.toUpperCase()} ` : code, message } };
      const server = await fixture(context, response => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frame(event));
      });
      const result = await server.request();
      assert.ok(result.body.includes(code));
      assert.ok(result.body.includes("未继续自动重试"));
      assert.ok(!result.body.includes("请继续"));
      if (shape !== "response.incomplete") assert.ok(!result.body.includes(message));
      assert.equal(server.calls(), 1);
      assert.equal(server.proxy.status().counters.retrySignals, 0);
      assert.equal(server.proxy.status().counters.actualCompletions, 0);
      assert.ok(server.events.some(event => event.type === "safety_policy_completed_idle" && event.code === code));
    });
  }
  for (const status of [200, 400, 429, 500]) {
    test(`HTTP ${status} ${code} is terminal independently of transport status`, async context => {
      const server = await fixture(context, response => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code, message: "Rejected by upstream." } }));
      });
      const result = await server.request();
      assert.ok(result.body.includes(code));
      assert.ok(!result.body.includes("请继续"));
      assert.equal(server.calls(), 1);
      assert.equal(server.proxy.status().counters.retrySignals, 0);
    });
  }
  test(`${code} compact stream stays failed instead of fabricating success`, async context => {
    const server = await fixture(context, response => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame({ type: "response.failed", response: { error: { code, message: "Rejected." } } }));
    });
    const result = await server.request({ kind: "compaction" });
    assert.ok(result.body.includes(code));
    assert.ok(result.body.includes("response.failed"));
    assert.ok(!result.body.includes("response.completed"));
    assert.ok(!result.body.includes("请继续"));
    assert.equal(server.calls(), 1);
    assert.equal(server.proxy.status().counters.retrySignals, 0);
  });
  test(`${code} unary compact preserves its code and rejection`, async context => {
    const server = await fixture(context, response => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code, message: "Rejected." } }));
    });
    const result = await server.request({ kind: "compaction", path: "responses/compact" });
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).error.code, code);
    assert.ok(JSON.parse(result.body).error.message.includes(code));
    assert.equal(server.calls(), 1);
    assert.equal(server.proxy.status().counters.retrySignals, 0);
  });
}

test("policy code takes precedence over quota wording and never reflects arbitrary credentials", async context => {
  const server = await fixture(context, response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame({ type: "error", code: "cyber_policy",
      message: 'Quota exceeded. Bearer fixture-secret token=fixture-token api_key=fixture-key sk-fixturekey {"token":"quoted-secret"} Cookie: cookie-secret password=two words-secret' }));
  });
  const result = await server.request();
  assert.ok(result.body.includes("cyber_policy"));
  for (const secret of ["fixture-secret", "fixture-token", "fixture-key", "sk-fixturekey", "quoted-secret", "cookie-secret", "words-secret"]) assert.ok(!result.body.includes(secret));
  assert.ok(server.events.some(event => event.type === "safety_policy_completed_idle"));
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});

test("explicit context limit wins over capacity wording", async context => {
  const server = await fixture(context, response => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "The selected model is at capacity; quota exceeded" } }));
  });
  const result = await server.request();
  assert.ok(result.body.includes("上下文长度限制"));
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});

for (const code of ["server_error", "service_unavailable", "timeout"]) test(`${code} with authentication wording remains retryable`, async context => {
  const server = await fixture(context, response => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code, message: "authentication service temporarily unavailable" } }));
  });
  const result = await server.request();
  assert.ok(!result.body.includes("不适合自动重试"));
  assert.equal(server.proxy.status().counters.retrySignals, 1);
});

test("buffered compact explicit refusal wins over later completed and transient frames", async context => {
  const server = await fixture(context, response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame({ type: "response.failed", response: { error: { code: "cyber_policy" } } })
      + frame({ type: "error", code: "server_error" })
      + frame({ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque" } })
      + frame({ type: "response.completed" }));
  });
  const result = await server.request({ kind: "compaction", path: "responses/compact" });
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.body).error.code, "cyber_policy");
  assert.equal(server.proxy.status().counters.actualCompletions, 0);
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});

test("policy rejection preserves prior text and does not replay partial tool work", async context => {
  const server = await fixture(context, response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.created", response: { id: "resp_policy_partial" } }));
    response.write(frame({ type: "response.output_item.added", output_index: 0,
      item: { type: "message", id: "msg_policy_partial", role: "assistant", content: [] } }));
    response.write(frame({ type: "response.output_text.delta", output_index: 0, item_id: "msg_policy_partial", delta: "已保留内容" }));
    response.write(frame({ type: "response.output_item.added", output_index: 1,
      item: { type: "function_call", id: "tool_policy_partial", call_id: "call_policy_partial", name: "write_probe", arguments: "" } }));
    response.write(frame({ type: "response.function_call_arguments.delta", item_id: "tool_policy_partial", delta: "{\"path\":" }));
    response.end(frame({ type: "error", code: "cyber_policy", message: "Rejected." }));
  });
  const result = await server.request();
  assert.ok(result.body.includes("已保留内容"));
  assert.ok(result.body.includes("cyber_policy"));
  assert.ok(!result.body.includes("response.function_call_arguments.done"));
  assert.equal(server.calls(), 1);
  assert.equal(server.proxy.status().counters.retrySignals, 0);
});

for (const code of ["credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "context_length_exceeded"]) {
  test(`${code} is not retried even with HTTP 500`, async context => {
    const server = await fixture(context, response => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code } }));
    });
    const result = await server.request();
    assert.ok(result.body.includes(code === "context_length_exceeded" ? "上下文长度限制" : "额度已耗尽"));
    assert.equal(server.calls(), 1);
    assert.equal(server.proxy.status().counters.retrySignals, 0);
  });
  test(`${code} unary compact retains its failure without retrying HTTP 500`, async context => {
    const server = await fixture(context, response => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code } }));
    });
    const result = await server.request({ kind: "compaction", path: "responses/compact" });
    assert.equal(result.status, 500);
    assert.equal(JSON.parse(result.body).error.code, code);
    assert.equal(server.calls(), 1);
    assert.equal(server.proxy.status().counters.retrySignals, 0);
  });
}

test("a server error mentioning cyber policy still remains retryable", async context => {
  const server = await fixture(context, response => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "server_error", message: "cyber_policy service unavailable" } }));
  });
  const result = await server.request();
  assert.ok(!result.body.includes("未继续自动重试"));
  assert.equal(server.proxy.status().counters.retrySignals, 1);
});
