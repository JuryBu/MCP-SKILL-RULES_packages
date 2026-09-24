import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createAdaptiveDeliveryRegistry, deliveryProfileKey } from "../src/adaptive-delivery.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const account = "adaptive-review-fixture";
const model = "adaptive-review-model";
const wire = event => `data: ${JSON.stringify(event)}\n\n`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const completed = { type: "response.completed", response: { id: "review-response", status: "completed", output: [] } };
const contentDelta = delta => ({ type: "response.output_text.delta", item_id: "review-message", delta });

function parseEvents(body) {
  return body.split(/\r?\n\r?\n/u).flatMap(frame => {
    const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n");
    try { return [JSON.parse(data)]; } catch { return []; }
  });
}

function bufferedState(key, updatedAt = Date.now()) {
  return { schemaVersion: 1, profiles: [{ key, mode: "buffered", updatedAt, probeAfter: 0, evidenceStartedAt: 0 }] };
}

async function fixture(context, handler, settings = {}) {
  const { buffered = false, initialEvent = true, onEvent: observeEvent, ...proxyOptions } = settings;
  let upstreamRequests = 0;
  let requestSerial = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    if (initialEvent) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(wire({ type: "response.created", response: { id: "review-response", status: "in_progress" } }));
    }
    Promise.resolve(handler(request, response, ++upstreamRequests)).catch(error => response.destroy(error));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const events = [];
  const profileKey = deliveryProfileKey({ "chatgpt-account-id": account }, { model }, origin);
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: origin,
    firstProgressTimeoutMs: 80,
    progressIdleTimeoutMs: 160,
    adaptiveWaitLimitMs: 500,
    upstreamIdleTimeoutMs: 180,
    adaptiveDeliveryState: buffered ? bufferedState(profileKey) : undefined,
    ...proxyOptions,
    onEvent(event) { events.push(event); observeEvent?.(event); },
  });
  context.after(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  await proxy.start();
  const request = (turn = `review-turn-${++requestSerial}`) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: true, input: [] });
    const client = http.request({
      host: "127.0.0.1",
      port: proxy.status().port,
      path: "/backend-api/codex/responses",
      method: "POST",
      signal: AbortSignal.timeout(4000),
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "chatgpt-account-id": account,
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "adaptive-review-fixture", turn_id: turn }),
      },
    }, response => {
      let output = "";
      response.on("data", chunk => { output += chunk; });
      response.once("end", () => resolve({ body: output, events: parseEvents(output) }));
      response.once("error", reject);
    });
    client.once("error", reject);
    client.end(body);
  });
  return { request, events, proxy, count: () => upstreamRequests };
}

function heartbeat(response) {
  const timer = setInterval(() => {
    if (!response.destroyed) response.write(wire({ type: "keepalive" }));
  }, 20);
  response.once("close", () => clearInterval(timer));
}

test("review: an overdue hard cap blocks a co-batched tool commit and completion", { timeout: 5000 }, async context => {
  const tool = { type: "function_call", id: "review-tool", call_id: "review-call", name: "inert_review_tool", arguments: "{}" };
  let blocked = false;
  const setup = await fixture(context, (_request, response) => {
    response.end([
      { type: "response.output_item.added", output_index: 0, item: { ...tool, arguments: "" } },
      { type: "response.function_call_arguments.done", item_id: tool.id, output_index: 0, arguments: "{}" },
      { type: "response.output_item.done", output_index: 0, item: tool },
      { type: "response.completed", response: { id: "review-response", status: "completed", output: [tool] } },
    ].map(wire).join(""));
  }, {
    buffered: true,
    adaptiveWaitLimitMs: 120,
    upstreamIdleTimeoutMs: 1000,
    progressIdleTimeoutMs: 1000,
    toolPreparationGraceMs: 1000,
    onEvent(event) {
      if (event.type !== "tool_call_observed" || blocked) return;
      blocked = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 220);
    },
  });
  const result = await setup.request("overdue-tool");
  const outcome = setup.events.find(event => event.type === "turn_attempt_finished");
  const toolDoneDelivered = result.events.some(event => event.type === "response.output_item.done" && event.item?.type === "function_call");
  context.diagnostic(JSON.stringify({ scenario: "overdue-tool", blocked, kind: outcome?.kind, reason: outcome?.reason, elapsedMs: outcome?.elapsedMs, toolDoneDelivered }));
  assert.equal(blocked, true);
  assert.equal(toolDoneDelivered, false, "a queued timer must not let an overdue tool commit escape");
  assert.equal(result.events.some(event => event.response?.output?.some(item => item.type === "function_call")), false);
  assert.equal(outcome?.kind, "adaptive_wait_timeout");
  assert.equal(outcome?.reason, "ADAPTIVE_WAIT_LIMIT");
  assert.equal(setup.events.some(event => event.type === "native_retry_signal"), false);
  assert.equal(setup.proxy.status().activeRequests, 0);
});

for (const headersOnly of [false, true]) {
  test(`review: known buffered silence retries within budget with ${headersOnly ? "headers but no frames" : "no response headers"}`, { timeout: 5000 }, async context => {
    const setup = await fixture(context, (_request, response) => {
      if (headersOnly) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      }
    }, { buffered: true, initialEvent: false, upstreamIdleTimeoutMs: 180, maxConsecutiveAttempts: 2 });
    await setup.request("silent-same-turn");
    await setup.request("silent-same-turn");
    await setup.request("silent-same-turn");
    const outcomes = setup.events.filter(event => event.type === "turn_attempt_finished");
    context.diagnostic(JSON.stringify({ scenario: "buffered-silence", headersOnly, upstreamRequests: setup.count(), outcomes: outcomes.map(event => ({ kind: event.kind, reason: event.reason, elapsedMs: event.elapsedMs })) }));
    assert.equal(setup.count(), 2, "one native retry is permitted, then the shared attempt budget stops replay");
    assert.equal(outcomes[0]?.kind, "adaptive_wait_timeout");
    assert.equal(outcomes[0]?.reason, "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT");
    assert.ok(outcomes[0].elapsedMs >= 170, "known buffered mode must use the 180ms idle budget, not the 80ms first-progress budget");
    assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
    assert.ok(setup.events.some(event => event.type === "adaptive_wait_terminal_replayed"));
    assert.equal(setup.proxy.status().activeRequests, 0);
  });
}

test("review: late paced short output does not teach buffered mode or extend the next request", { timeout: 5000 }, async context => {
  const writes = [];
  const setup = await fixture(context, async (_request, response, count) => {
    heartbeat(response);
    if (count !== 1) return;
    await sleep(140);
    for (let index = 0; index < 10 && !response.destroyed; index++) {
      writes.push(Date.now());
      response.write(wire(contentDelta("x".repeat(30))));
      await sleep(60);
    }
    if (!response.destroyed) response.end(wire(completed));
  }, { progressIdleTimeoutMs: 250, adaptiveWaitLimitMs: 2500, upstreamIdleTimeoutMs: 600 });
  const first = await setup.request();
  const observed = setup.events.find(event => event.type === "adaptive_delivery_observed");
  const afterFirst = setup.proxy.status().adaptiveDelivery;
  context.diagnostic(JSON.stringify({ scenario: "late-short-stream", writes: writes.length, writeSpanMs: writes.at(-1) - writes[0], observed: observed?.observed, contentSpanMs: observed?.contentSpanMs, bufferedProfiles: afterFirst.buffered }));
  assert.ok(first.events.some(event => event.type === "response.completed"));
  assert.equal(writes.length, 10);
  assert.equal(setup.events.filter(event => event.type === "adaptive_delivery_probe_started").length, 1);
  assert.equal(afterFirst.buffered, 0, "ten paced deltas are not a concentrated burst just because the answer is short");
  const second = await setup.request();
  const outcome = setup.events.filter(event => event.type === "turn_attempt_finished").at(-1);
  assert.equal(second.events.some(event => event.type === "response.completed"), false);
  assert.equal(outcome?.reason, "FIRST_PROGRESS_TIMEOUT");
  assert.equal(setup.events.filter(event => event.type === "adaptive_delivery_probe_started").length, 1);
});

function begin(registry, key, startedAt) {
  return registry.begin({ key, startedAt, firstProgressTimeoutMs: 40_000, waitLimitMs: 300_000, upstreamIdleTimeoutMs: 90_000 });
}

function streamed(attempt, startedAt) {
  for (let index = 0; index < 12; index++) attempt.observe(contentDelta("code "), startedAt + index * 200);
}

test("review: same-millisecond attempts cannot let an older completion overwrite newer streaming evidence", context => {
  const now = Date.now();
  const key = "a".repeat(64);
  const registry = createAdaptiveDeliveryRegistry({ state: bufferedState(key, now) });
  const older = begin(registry, key, now);
  const newer = begin(registry, key, now);
  streamed(newer, now);
  newer.complete(now + 2300);
  const modeAfterNewer = registry.snapshot().profiles[0].mode;
  older.observe(contentDelta("x".repeat(1000)), now + 2400);
  older.complete(now + 2500);
  const modeAfterOlder = registry.snapshot().profiles[0].mode;
  context.diagnostic(JSON.stringify({ scenario: "same-millisecond", modeAfterNewer, modeAfterOlder }));
  assert.equal(modeAfterNewer, "streaming");
  assert.equal(modeAfterOlder, "streaming");
});

test("review: invalid persisted evidence timestamps cannot block fresh streaming evidence", context => {
  const now = Date.now();
  const key = "b".repeat(64);
  for (const timestamps of [
    { updatedAt: now, evidenceStartedAt: Number.MAX_SAFE_INTEGER },
    { updatedAt: now - 2000, evidenceStartedAt: now - 1000 },
  ]) {
    const state = bufferedState(key, timestamps.updatedAt);
    Object.assign(state.profiles[0], timestamps);
    let registry;
    let rejected = false;
    try { registry = createAdaptiveDeliveryRegistry({ state }); }
    catch (error) {
      assert.match(error.message, /invalid|evidence|timestamp/iu);
      rejected = true;
      registry = createAdaptiveDeliveryRegistry();
    }
    const restored = registry.snapshot().profiles;
    context.diagnostic(JSON.stringify({ scenario: "invalid-persisted-evidence", ...timestamps, rejected, restoredProfiles: restored.length }));
    assert.ok(restored.every(entry => entry.evidenceStartedAt <= entry.updatedAt && entry.evidenceStartedAt <= now), "invalid evidence ordering must be rejected, discarded, or normalized");
    const recovery = begin(registry, key, now);
    streamed(recovery, now);
    recovery.complete(now + 2300);
    assert.equal(registry.snapshot().profiles.find(entry => entry.key === key)?.mode, "streaming");
  }
});
