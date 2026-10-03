import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { deliveryProfileKey } from "../src/adaptive-delivery.mjs";

const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const completion = text => sse({ type: "response.output_text.delta", delta: text }) + sse({ type: "response.completed" });

test("first-output and tool-input retry opportunities remain independent in one failure chain", async context => {
  let calls = 0;
  const { send, events } = await fixture(context, (_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
    if (calls > 1) {
      response.write(sse({ type: "response.output_item.added", output_index: 0,
        item: { id: `tool-${calls}`, type: "function_call", call_id: `call-${calls}`, name: "fixture_tool", arguments: "" } }));
      response.write(sse({ type: "response.function_call_arguments.delta", item_id: `tool-${calls}`, output_index: 0, delta: "{" }));
    }
  }, { uploadAllowanceMsPerMiB: 0, retryProgressIdleTimeoutMs: 338 });
  for (let index = 0; index < 4; index += 1) await send();
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.deepEqual(starts.map(event => event.firstProgressTimeoutMs), [150, 338, 150, 150]);
  assert.deepEqual(starts.map(event => event.toolInputProgressIdleTimeoutMs), [150, 150, 338, 150]);
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_finished").map(event => event.reason),
    ["FIRST_PROGRESS_TIMEOUT", "PROGRESS_IDLE_TIMEOUT", "PROGRESS_IDLE_TIMEOUT", "PROGRESS_IDLE_TIMEOUT"]);
});

test("a stale concurrent cancellation cannot revoke a newly granted first-output retry", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0 });
  const first = send();
  await waitUntil(() => events.some(event => event.type === "turn_attempt_started"));
  await pause(60);
  const controller = new AbortController();
  const second = send({}, { signal: controller.signal });
  const rejected = assert.rejects(second, { name: "AbortError" });
  await first;
  controller.abort();
  await rejected;
  await waitUntil(() => events.filter(event => event.type === "turn_attempt_finished").length === 2);
  await send();
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_started")
    .map(event => event.firstProgressTimeoutMs), [150, 150, 338]);
});

test("repeated and out-of-order sequenced deltas cannot keep a stalled request alive", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.created", sequence_number: 0, response: { id: "replayed-response" } }));
    for (let index = 0; index < 20; index += 1) later(() => {
      if (!response.destroyed) response.write(sse({ type: "response.reasoning_text.delta", sequence_number: 1,
        item_id: "replayed-item", delta: "same text" }));
    }, index * 40 + 10);
  }, { uploadAllowanceMsPerMiB: 0, progressIdleTimeoutMs: 200, adaptiveWaitLimitMs: 300 });
  const result = await send();
  assert.ok(result.elapsedMs < 700);
  assert.equal(events.filter(event => event.type === "first_progress_observed").length, 1);
  assert.equal(events.filter(event => event.type === "attempt_progress_timeout").length, 1);
});

async function fixture(context, handler, options = {}) {
  const events = [];
  const timers = new Set();
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const upstream = http.createServer((request, response) => handler(request, response, later));
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: origin, firstProgressTimeoutMs: 150,
    firstLastProgressTimeoutMs: 150, progressIdleTimeoutMs: 150, reasoningProgressIdleTimeoutMs: 150, onEvent: event => events.push(event),
    ...options, ...(options.buffered ? { adaptiveDeliveryState: { schemaVersion: 1, profiles: [{
      key: deliveryProfileKey({ "chatgpt-account-id": "fixture-account" }, { model: "fixture-model" }, origin),
      mode: "buffered", updatedAt: Date.now(), evidenceStartedAt: Date.now() - 1, probeAfter: Date.now() + 60_000,
    }] } } : {}) });
  await proxy.start();
  context.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await proxy.stop();
    upstream.closeAllConnections?.();
    await new Promise(resolve => upstream.close(resolve));
  });
  const send = (payload = {}, extra = {}) => new Promise((resolve, reject) => {
    const body = extra.encodedBody ?? Buffer.from(JSON.stringify({ model: "fixture-model", stream: true, ...payload }));
    const headers = { "content-type": "application/json", "content-length": body.length,
      "chatgpt-account-id": "fixture-account",
      ...(!extra.untracked ? { "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture-thread",
        turn_id: extra.turnId ?? "fixture-turn", request_kind: "turn" }) } : {}), ...extra.headers };
    const startedAt = Date.now();
    const request = http.request({ host: "127.0.0.1", port: proxy.status().port,
      path: "/backend-api/codex/responses", method: "POST", headers, signal: extra.signal }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve({ text, elapsedMs: Date.now() - startedAt }));
    });
    request.on("error", reject);
    request.end(body);
  });
  return { proxy, send, events };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture state was not reached");
    await pause(10);
  }
}

test("size allowance protects a delayed first output without counting headers as progress", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    later(() => response.end(completion("large-success")), 300);
  }, { uploadAllowanceMsPerMiB: 600 });
  const result = await send({ padding: "x".repeat(512 * 1024) });
  assert.match(result.text, /large-success/u);
  const start = events.find(event => event.type === "turn_attempt_started");
  assert.ok(start.uploadAllowanceMs >= 300 && start.uploadAllowanceMs < 302);
  const progress = events.find(event => event.type === "first_progress_observed");
  assert.ok(progress.elapsedMs >= 250);
  assert.equal(events.some(event => event.type === "attempt_progress_timeout"), false);
});

test("late headers do not restart the first-output deadline", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    later(() => { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); }, 100);
    later(() => response.end(completion("too-late")), 260);
  }, { maxConsecutiveAttempts: 1, uploadAllowanceMsPerMiB: 0 });
  const result = await send();
  assert.doesNotMatch(result.text, /too-late/u);
  assert.equal(events.find(event => event.type === "attempt_progress_timeout").reason, "FIRST_PROGRESS_TIMEOUT");
  assert.ok(events.find(event => event.type === "turn_attempt_finished").elapsedMs < 230);
});

test("first-output retries use the longer baseline only once", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0, maxConsecutiveAttempts: 4 });
  await send(); await send(); await send();
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.deepEqual(starts.map(event => event.firstProgressTimeoutMs), [150, 338, 150]);
  assert.deepEqual(starts.map(event => event.firstProgressRetryProbe), [false, true, false]);
});

test("a failed extended attempt cannot obtain a second extended opportunity", async context => {
  let count = 0;
  const { send, events } = await fixture(context, (_request, response, later) => {
    count += 1;
    if (count === 2) { later(() => response.destroy(), 20); return; }
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0, maxConsecutiveAttempts: 4 });
  await send(); await send(); await send();
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_started")
    .map(event => event.firstProgressRetryProbe), [false, true, false]);
});

test("cancelling before first output does not grant a longer retry", async context => {
  const { send, events, proxy } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0 });
  const controller = new AbortController();
  const cancelled = assert.rejects(send({}, { signal: controller.signal }), { name: "AbortError" });
  await waitUntil(() => events.some(event => event.type === "turn_attempt_started"));
  controller.abort();
  await cancelled;
  await waitUntil(() => proxy.status().activeRequests === 0);
  await send();
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_started")
    .map(event => event.firstProgressRetryProbe), [false, false]);
});

test("cancelling an extended attempt consumes its opportunity", async context => {
  const { send, events, proxy } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0, maxConsecutiveAttempts: 4 });
  await send();
  const controller = new AbortController();
  const cancelled = assert.rejects(send({}, { signal: controller.signal }), { name: "AbortError" });
  await waitUntil(() => events.filter(event => event.type === "turn_attempt_started").length === 2);
  controller.abort();
  await cancelled;
  await waitUntil(() => proxy.status().activeRequests === 0);
  await send();
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_started")
    .map(event => event.firstProgressRetryProbe), [false, true, false]);
});

test("concurrent retries cannot claim the same first-output extension twice", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0, maxConsecutiveAttempts: 4 });
  await send();
  await Promise.all([send(), send()]);
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.equal(starts.length, 3);
  assert.equal(starts.filter(event => event.firstProgressRetryProbe).length, 1);
});

test("untracked requests never receive the extended retry opportunity", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 0 });
  await send({}, { untracked: true }); await send({}, { untracked: true });
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_started")
    .map(event => event.firstProgressRetryProbe), [false, false]);
  assert.equal(events.filter(event => event.type === "upstream_request_finished").length, 2);
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_finished")
    .map(event => event.reason), ["FIRST_PROGRESS_TIMEOUT", "FIRST_PROGRESS_TIMEOUT"]);
});

test("encoded compressed size, rather than decoded size, determines the allowance", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.end(completion("compressed-success"));
  });
  const encodedBody = gzipSync(Buffer.from(JSON.stringify({ model: "fixture-model", stream: true,
    padding: "x".repeat(2 * 1024 * 1024) })));
  await send({}, { encodedBody, headers: { "content-encoding": "gzip" } });
  const inspected = events.find(event => event.type === "request_body_inspected");
  assert.equal(inspected.encodedBytes, encodedBody.length);
  assert.ok(inspected.decodedBytes > 2 * 1024 * 1024);
  assert.equal(events.find(event => event.type === "turn_attempt_started").uploadAllowanceMs,
    Math.ceil(encodedBody.length / 1024 / 1024 * 1000));
});

test("buffered startup idle and total budgets preserve the same size allowance", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.in_progress" }));
    later(() => response.end(completion("buffered-success")), 250);
  }, { buffered: true, uploadAllowanceMsPerMiB: 400, adaptiveWaitLimitMs: 100, upstreamIdleTimeoutMs: 150 });
  const result = await send({ padding: "x".repeat(512 * 1024) });
  assert.match(result.text, /buffered-success/u);
  assert.equal(events.some(event => event.type === "attempt_progress_timeout"), false);
});

test("each upload receives its allowance without replenishing the shared server-wait balance", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { uploadAllowanceMsPerMiB: 400, adaptiveWaitLimitMs: 300, maxConsecutiveAttempts: 4 });
  const payload = { padding: "x".repeat(512 * 1024) };
  await send(payload);
  await pause(350);
  await send(payload);
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.equal(starts[0].uploadAllowanceMs, starts[1].uploadAllowanceMs);
  assert.ok(starts[1].waitBudgetRemainingMs > 100 && starts[1].waitBudgetRemainingMs < 200);
  const finishes = events.filter(event => event.type === "turn_attempt_finished");
  assert.ok(finishes[1].elapsedMs > 300 && finishes[1].elapsedMs < 450);
  assert.equal(finishes[1].reason, "ADAPTIVE_WAIT_LIMIT");
  const count = starts.length;
  await send(payload);
  assert.equal(events.filter(event => event.type === "turn_attempt_started").length, count);
});

test("heartbeats alone cannot replenish the no-progress balance", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const heartbeat = () => { if (response.destroyed) return; response.write(sse({ type: "response.in_progress" })); later(heartbeat, 30); };
    heartbeat();
  }, { buffered: true, adaptiveWaitLimitMs: 180, upstreamIdleTimeoutMs: 150, maxConsecutiveAttempts: 1,
    uploadAllowanceMsPerMiB: 0 });
  await send();
  assert.equal(events.find(event => event.type === "turn_attempt_finished").reason, "ADAPTIVE_WAIT_LIMIT");
  assert.equal(events.some(event => event.type === "first_progress_observed"), false);
});

test("valid continuing generation can outlive the original total wait limit", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    let count = 0;
    const progress = () => {
      response.write(sse({ type: "response.output_text.delta", delta: "healthy" }));
      count += 1;
      if (count === 8) response.end(sse({ type: "response.completed" })); else later(progress, 60);
    };
    later(progress, 40);
  }, { buffered: true, adaptiveWaitLimitMs: 120, upstreamIdleTimeoutMs: 150, uploadAllowanceMsPerMiB: 0 });
  const result = await send();
  assert.match(result.text, /healthy/u);
  assert.ok(result.elapsedMs >= 400);
  assert.equal(events.find(event => event.type === "turn_attempt_finished").reason, "RESPONSE_COMPLETED");
});
