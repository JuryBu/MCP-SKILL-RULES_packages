import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCodexModelStreamProxy, nativeRetryDelay } from "../src/codex-model-stream-proxy.mjs";

test("each fast failure uses the inclusive eight-second threshold and thirty-second default", () => {
  for (const attemptNumber of [1, 2, 3, 4]) {
    const result = nativeRetryDelay({ elapsedMs: 8000, attemptNumber, maxConsecutiveAttempts: 6,
      chainElapsedMs: 100000, rapidRetryMinimumMs: 70000 });
    assert.equal(result.delayMs, 30000);
    assert.equal(result.fast, true);
  }
  assert.equal(nativeRetryDelay({ elapsedMs: 8001, attemptNumber: 1, maxConsecutiveAttempts: 6,
    chainElapsedMs: 100000, rapidRetryMinimumMs: 70000 }).delayMs, 0);
  assert.equal(nativeRetryDelay({ elapsedMs: 1, attemptNumber: 5, maxConsecutiveAttempts: 6,
    chainElapsedMs: 20000, rapidRetryMinimumMs: 70000 }).delayMs, 50000);
});

async function setup(context, extra = {}) {
  const events = [];
  const calls = [];
  const upstream = http.createServer((request, response) => {
    calls.push(Date.now());
    request.resume();
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "server_error", code: "owned-transient-fixture" } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    fastRetryThresholdMs: 1000, fastRetryDelayMs: 60, rapidRetryMinimumMs: 10,
    maxConsecutiveAttempts: 3, onEvent: event => events.push(event), ...extra });
  await proxy.start();
  context.after(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const request = async (turnId, signal) => {
    const response = await fetch(`http://127.0.0.1:${proxy.status().port}/backend-api/codex/responses`, {
      method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn", thread_id: "owned-fast-thread", turn_id: turnId,
      }) }, body: JSON.stringify({ stream: true, input: [] }), signal,
    });
    return response.text();
  };
  return { events, calls, proxy, request };
}

test("real HTTP delays each quick failure and sends each native attempt upstream once", async context => {
  const value = await setup(context);
  for (const index of [1, 2]) {
    const began = Date.now();
    await value.request("owned-one-turn");
    assert.ok(Date.now() - began >= 50);
    assert.equal(value.calls.length, index);
  }
  await value.request("owned-one-turn");
  assert.equal(value.calls.length, 3);
  assert.equal(value.events.filter(event => event.type === "rapid_retry_wait_started").length, 2);
  assert.equal(value.events.filter(event => event.type === "native_retry_signal").length, 2);
  assert.equal(value.events.at(-1)?.type === "retry_exhausted_completed_idle" || value.events.some(event => event.type === "retry_exhausted_completed_idle"), true);
});

test("cancelling a cooldown releases the request and makes no additional upstream call", async context => {
  const value = await setup(context, { fastRetryDelayMs: 1000 });
  const abort = new AbortController();
  const pending = value.request("owned-cancel-turn", abort.signal);
  const deadline = Date.now() + 2000;
  while (!value.events.some(event => event.type === "rapid_retry_wait_started") && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(value.events.some(event => event.type === "rapid_retry_wait_started"), true);
  const refused = assert.rejects(pending, error => error.name === "AbortError");
  abort.abort();
  await refused;
  while (value.proxy.status().activeRequests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(value.proxy.status().activeRequests, 0);
  assert.equal(value.calls.length, 1);
  assert.equal(value.events.filter(event => event.type === "native_retry_signal").length, 0);
});

test("default runtime cooldown really waits thirty seconds", { timeout: 45000 }, async context => {
  const value = await setup(context, { fastRetryThresholdMs: undefined, fastRetryDelayMs: undefined,
    maxConsecutiveAttempts: 6 });
  assert.equal(value.proxy.status().fastRetryThresholdMs, 8000);
  assert.equal(value.proxy.status().fastRetryDelayMs, 30000);
  const began = Date.now();
  await value.request("owned-default-delay");
  const elapsedMs = Date.now() - began;
  assert.ok(elapsedMs >= 29800 && elapsedMs < 43000, `cooldown elapsed ${elapsedMs}ms`);
  assert.equal(value.calls.length, 1);
  assert.equal(value.events.filter(event => event.type === "native_retry_signal").length, 1);
  console.log(JSON.stringify({ evidence: "owned-loopback-default-cooldown", elapsedMs,
    upstreamCalls: value.calls.length, thresholdMs: 8000, delayMs: 30000 }));
});
