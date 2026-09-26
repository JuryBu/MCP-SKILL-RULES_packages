import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { deliveryProfileKey } from "../src/adaptive-delivery.mjs";

const wire = event => `data: ${JSON.stringify(event)}\n\n`;
const done = { type: "response.completed", response: { id: "test-response", status: "completed", output: [] } };
const text = delta => ({ type: "response.output_text.delta", delta });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const parse = body => body.split(/\r?\n\r?\n/u).flatMap(frame => {
  try { return [JSON.parse(frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n"))]; } catch { return []; }
});

async function fixture(context, handler, options = {}) {
  let count = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(wire({ type: "response.created", response: { id: "test-response", status: "in_progress" } }));
    Promise.resolve(handler(request, response, ++count)).catch(error => response.destroy(error));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const events = [];
  let saved;
  const state = options.buffered ? { schemaVersion: 1, profiles: [{ key: deliveryProfileKey({ "chatgpt-account-id": "account-a" }, { model: "model-a" }, origin), mode: "buffered", updatedAt: Date.now(), probeAfter: 0, evidenceStartedAt: 0 }] } : undefined;
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: origin, firstProgressTimeoutMs: 80, progressIdleTimeoutMs: 80,
    adaptiveWaitLimitMs: 400, upstreamIdleTimeoutMs: 140, adaptiveStreamMinSpanMs: 40,
    adaptiveDeliveryState: state, onAdaptiveDeliveryStateChange: value => { saved = value; }, onEvent: event => events.push(event), ...options });
  await proxy.start();
  context.after(async () => { await proxy.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = (settings = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: settings.model ?? "model-a", stream: true, input: [] });
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body),
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "adaptive-test", turn_id: settings.turn ?? `turn-${count}` }) };
    if (!settings.anonymous) headers["chatgpt-account-id"] = settings.account ?? "account-a";
    const client = http.request({ host: "127.0.0.1", port: proxy.status().port, path: "/backend-api/codex/responses", method: "POST", headers, signal: settings.signal }, response => {
      let output = "";
      response.on("data", chunk => {
        output += chunk;
        settings.onData?.(output);
      });
      response.once("end", () => resolve({ body: output, events: parse(output) }));
      response.once("error", reject);
    });
    client.once("error", reject);
    client.end(body);
  });
  return { request, events, proxy, count: () => count, saved: () => saved };
}

function heartbeat(response, interval = 20) {
  const timer = setInterval(() => { if (!response.destroyed) response.write(wire({ type: "keepalive" })); }, interval);
  response.once("close", () => clearInterval(timer));
}

async function waitForRequestCleanup(setup) {
  const deadline = Date.now() + 2000;
  while (setup.proxy.status().activeRequests > 0 && Date.now() < deadline) await sleep(10);
  assert.equal(setup.proxy.status().activeRequests, 0);
}

test("concentrated completion is learned, used by the next request, then real streaming restores normal mode", async context => {
  const setup = await fixture(context, async (_request, response, count) => {
    heartbeat(response);
    if (count < 3) {
      await sleep(140);
      response.end(wire(text("x".repeat(2000))) + wire(done));
    } else {
      for (let index = 0; index < 12; index++) { response.write(wire(text("code "))); await sleep(8); }
      response.end(wire(done));
    }
  });
  assert.ok((await setup.request()).events.some(event => event.type === "response.completed"));
  assert.equal(setup.proxy.status().adaptiveDelivery.buffered, 1);
  await setup.request();
  assert.equal(setup.events.filter(event => event.type === "adaptive_delivery_probe_started").length, 1);
  await setup.request();
  assert.equal(setup.proxy.status().adaptiveDelivery.buffered, 0);
  assert.deepEqual(setup.events.filter(event => event.type === "adaptive_delivery_mode_changed").map(event => event.to), ["buffered", "streaming"]);
  assert.equal(setup.count(), 3);
});

test("late streaming gets one probe, the next slow request returns to the normal deadline", async context => {
  const setup = await fixture(context, async (_request, response) => {
    heartbeat(response);
    await sleep(140);
    for (let index = 0; index < 12 && !response.destroyed; index++) { response.write(wire(text("code "))); await sleep(8); }
    if (!response.destroyed) response.end(wire(done));
  });
  const first = await setup.request();
  assert.ok(first.events.some(event => event.type === "response.completed"));
  assert.equal(setup.proxy.status().adaptiveDelivery.buffered, 0);
  const next = await setup.request();
  assert.equal(next.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.events.filter(event => event.type === "adaptive_delivery_probe_started").length, 1);
  assert.ok(setup.events.some(event => event.type === "adaptive_late_streaming_success"));
});

test("endless heartbeats stop at the absolute budget and replay does not make another upstream request", async context => {
  const setup = await fixture(context, (_request, response) => heartbeat(response), { adaptiveWaitLimitMs: 260 });
  const began = Date.now();
  const first = await setup.request({ turn: "same-turn" });
  assert.match(first.body, /等待上限/u);
  assert.ok(Date.now() - began >= 240 && Date.now() - began < 800);
  assert.ok(setup.events.some(event => event.type === "adaptive_wait_stopped" && event.reason === "ADAPTIVE_WAIT_LIMIT"));
  await setup.request({ turn: "same-turn" });
  assert.equal(setup.count(), 1);
  assert.equal(setup.proxy.status().activeRequests, 0);
});

test("known buffered silence signals a native retry and the next attempt can complete", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 2) response.end(wire(text("RECOVERED")) + wire(done));
  }, { buffered: true, upstreamIdleTimeoutMs: 120 });
  const first = await setup.request({ turn: "silent-retry" });
  assert.equal(first.events.some(event => event.type === "response.completed"), false);
  assert.ok(setup.events.some(event => event.type === "native_retry_signal" && event.reason === "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT"));
  const second = await setup.request({ turn: "silent-retry" });
  assert.match(second.body, /RECOVERED/u);
  assert.equal(setup.count(), 2);
  assert.deepEqual(setup.events.filter(event => event.type === "turn_attempt_started").map(event => event.attemptNumber), [1, 2]);
});

test("a probed idle timeout retries without resetting its absolute budget during cooldown", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 1) {
      const timer = setInterval(() => response.write(wire({ type: "keepalive" })), 20);
      setTimeout(() => clearInterval(timer), 120);
      response.once("close", () => clearInterval(timer));
    } else heartbeat(response);
  }, { adaptiveWaitLimitMs: 400, upstreamIdleTimeoutMs: 140, firstProgressTimeoutMs: 80 });
  const first = await setup.request({ turn: "probe-retry-budget" });
  assert.equal(first.events.some(event => event.type === "response.completed"), false);
  assert.ok(setup.events.some(event => event.type === "adaptive_delivery_probe_started"));
  while (!setup.events.some(event => event.type === "adaptive_wait_stopped") && setup.count() < 6) {
    await setup.request({ turn: "probe-retry-budget" });
  }
  const terminal = setup.events.find(event => event.type === "adaptive_wait_stopped");
  assert.equal(terminal?.reason, "ADAPTIVE_WAIT_LIMIT");
  const count = setup.count();
  await setup.request({ turn: "probe-retry-budget" });
  assert.equal(setup.count(), count);
  assert.ok(setup.events.some(event => event.type === "adaptive_wait_terminal_replayed"));
});

test("an expired idle retry budget prevents opening another upstream connection", async context => {
  const setup = await fixture(context, () => {}, { buffered: true, adaptiveWaitLimitMs: 280, upstreamIdleTimeoutMs: 120 });
  const first = await setup.request({ turn: "budget-before-connect" });
  assert.equal(first.events.some(event => event.type === "response.completed"), false);
  await sleep(300);
  const final = await setup.request({ turn: "budget-before-connect" });
  assert.match(final.body, /等待上限/u);
  assert.equal(setup.count(), 1);
});

test("disconnect regression: an idle retry keeps its absolute deadline after downstream cancellation", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count > 2) response.end(wire(text("UNEXPECTED_REPLAY")) + wire(done));
  }, { buffered: true, adaptiveWaitLimitMs: 600, upstreamIdleTimeoutMs: 120 });
  const turn = "disconnect-idle-budget";
  await setup.request({ turn });
  const deadline = setup.events.find(event => event.type === "adaptive_idle_retry_eligible")?.deadlineAt;
  assert.ok(Number.isFinite(deadline));
  const controller = new AbortController();
  await assert.rejects(setup.request({ turn, signal: controller.signal, onData: () => controller.abort() }));
  await waitForRequestCleanup(setup);
  assert.equal(setup.count(), 2);
  assert.ok(setup.events.some(event => event.type === "downstream_cancelled"));
  await sleep(Math.max(0, deadline - Date.now()) + 30);
  const terminal = await setup.request({ turn });
  assert.equal(setup.count(), 2, "an expired pre-disconnect deadline must block another upstream request");
  assert.match(terminal.body, /等待上限/u);
  await setup.request({ turn });
  assert.equal(setup.count(), 2);
});

test("disconnect regression: exposed hosted work stays unsafe after downstream cancellation", async context => {
  const hostedId = "hosted-before-disconnect";
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 1) response.write(wire({ type: "response.output_item.added", output_index: 0,
      item: { type: "web_search_call", id: hostedId, status: "in_progress" } }));
    else if (count > 2) response.end(wire(text("UNEXPECTED_REPLAY")) + wire(done));
  }, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 180 });
  const turn = "disconnect-hosted-safety";
  const controller = new AbortController();
  let hostedDelivered = false;
  await assert.rejects(setup.request({ turn, signal: controller.signal, onData: output => {
    if (parse(output).some(event => event.item?.id === hostedId)) {
      hostedDelivered = true;
      controller.abort();
    }
  } }));
  await waitForRequestCleanup(setup);
  assert.equal(hostedDelivered, true);
  assert.equal(setup.count(), 1);
  const terminal = await setup.request({ turn });
  assert.equal(setup.events.some(event => event.type === "native_retry_signal"), false,
    "a disconnect must not erase hosted work and make an empty idle retry safe");
  assert.ok(terminal.events.some(event => event.type === "response.completed"));
  const countBeforeReplay = setup.count();
  await setup.request({ turn });
  assert.equal(setup.count(), countBeforeReplay);
});

test("local terminal regression: tool retry exhaustion caches an earlier idle chain terminal", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 2 || count === 3) response.write(wire({ type: "response.output_item.added", output_index: 0,
      item: { type: "function_call", id: "pending", call_id: "pending-call", name: "safe", arguments: "" } }));
    else if (count > 3) response.end(wire(text("UNEXPECTED_REPLAY")) + wire(done));
  }, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 180, toolPreparationGraceMs: 60 });
  const turn = "idle-then-tool-exhaustion";
  await setup.request({ turn });
  await setup.request({ turn });
  const terminal = await setup.request({ turn });
  assert.equal(setup.count(), 3);
  assert.ok(setup.events.some(event => event.type === "local_tool_phase_retry_signal"));
  assert.ok(setup.events.some(event => event.type === "local_tool_phase_timeout" && event.attemptNumber === 3));
  assert.match(terminal.body, /自动重试上限/u);
  const replay = await setup.request({ turn });
  assert.equal(setup.count(), 3, "the local terminal must be replayed instead of resetting the idle chain");
  assert.match(replay.body, /自动重试上限/u);
  assert.deepEqual(setup.events.filter(event => event.type === "turn_attempt_started").map(event => event.attemptNumber), [1, 2, 3]);
});

test("idle retries obey the shared attempt limit and terminal replays do not restart it", async context => {
  const setup = await fixture(context, () => {}, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 120, maxConsecutiveAttempts: 2 });
  await setup.request({ turn: "bounded-idle" });
  const final = await setup.request({ turn: "bounded-idle" });
  assert.ok(final.events.some(event => event.type === "response.completed"));
  assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
  await setup.request({ turn: "bounded-idle" });
  assert.equal(setup.count(), 2);
});

for (const partial of [text("PARTIAL"), { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "hosted", status: "in_progress" } }]) {
  test(`idle timeout after ${partial.type} does not replay exposed or hosted work`, async context => {
    const setup = await fixture(context, (_request, response) => response.write(wire(partial)), { buffered: true, adaptiveWaitLimitMs: 1000, upstreamIdleTimeoutMs: 120 });
    await setup.request({ turn: "partial-idle" });
    await setup.request({ turn: "partial-idle" });
    assert.equal(setup.count(), 1);
    assert.equal(setup.events.some(event => event.type === "native_retry_signal"), false);
  });
}

for (const previous of [text("EARLIER_COMPLETED"), { type: "response.output_item.done", output_index: 0,
  item: { type: "function_call", id: "finished-tool", call_id: "finished-call", name: "read_file", arguments: "{}" } }]) {
  test(`completed ${previous.type} does not block reasoning-only idle in the next request`, async context => {
    const setup = await fixture(context, (_request, response, count) => {
      if (count === 1) response.end(wire(previous) + wire(done));
      else if (count === 2) response.write(wire({ type: "response.reasoning_summary_text.delta", delta: "Thinking after the completed result" }));
      else response.end(wire(text("RECOVERED")) + wire(done));
    }, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 120 });
    const turn = "completed-work-next-request";
    await setup.request({ turn });
    const stalled = await setup.request({ turn });
    assert.equal(stalled.events.some(event => event.type === "response.completed"), false);
    assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
    const recovered = await setup.request({ turn });
    assert.match(recovered.body, /RECOVERED/u);
    assert.equal(setup.count(), 3);
  });
}

for (const reasoning of [
  { type: "response.reasoning_summary_text.delta", delta: "Reasoning summary" },
  { type: "response.reasoning_text.delta", delta: "Reasoning text" },
  { type: "response.output_item.done", output_index: 0, item: { id: "reasoning-only", type: "reasoning", encrypted_content: "opaque-reasoning", summary: [] } },
]) {
  test(`${reasoning.type} alone permits idle retry but preserves the attempt limit`, async context => {
    const setup = await fixture(context, (_request, response) => response.write(wire(reasoning)),
      { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 120, maxConsecutiveAttempts: 2 });
    const first = await setup.request({ turn: "reasoning-only" });
    assert.equal(first.events.some(event => event.type === "response.completed"), false);
    const final = await setup.request({ turn: "reasoning-only" });
    assert.ok(final.events.some(event => event.type === "response.completed"));
    assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
    assert.ok(setup.events.some(event => event.type === "retry_exhausted_completed_idle"));
    await setup.request({ turn: "reasoning-only" });
    assert.equal(setup.count(), 2);
  });
}

test("unknown non-text content still prevents adaptive idle replay", async context => {
  const setup = await fixture(context, (_request, response) => response.write(wire({ type: "response.unknown_output.delta", delta: "opaque output" })),
    { buffered: true, adaptiveWaitLimitMs: 1000, upstreamIdleTimeoutMs: 120 });
  await setup.request({ turn: "unknown-output" });
  await setup.request({ turn: "unknown-output" });
  assert.equal(setup.count(), 1);
  assert.equal(setup.events.some(event => event.type === "native_retry_signal"), false);
});

for (const [label, fragment, retrySafe] of [
  ["unknown", 'data: {"type":"response.unknown_output.delta","delta":"opaque', false],
  ["text", 'data: {"type":"response.output_text.delta","delta":"visible', false],
  ["arguments", 'data: {"type":"response.function_call_arguments.delta","delta":"{', false],
  ["tool-done", 'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"tool","arguments":"{', false],
  ["reasoning-summary", 'data: {"type":"response.reasoning_summary_text.delta","delta":"Thinking', true],
  ["reasoning-text", 'data: {"type":"response.reasoning_text.delta","delta":"Thinking', true],
  ["reasoning-item", 'data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"reasoning","encrypted_content":"opaque', true],
]) {
  test(`partial ${label} retains the same narrow adaptive idle replay boundary`, async context => {
    const setup = await fixture(context, (_request, response) => response.write(fragment),
      { buffered: true, adaptiveWaitLimitMs: 1200, upstreamIdleTimeoutMs: 100, progressIdleTimeoutMs: 1000, toolPreparationGraceMs: 1000 });
    const result = await setup.request({ turn: `partial-${label}` });
    assert.equal(setup.events.some(event => event.type === "native_retry_signal"), retrySafe);
    assert.equal(result.events.some(event => event.type === "response.completed"), !retrySafe);
    const outcome = setup.events.find(event => event.type === "turn_attempt_finished");
    assert.equal(outcome.sawReplayUnsafeContent, !retrySafe);
  });
}

test("a failed reasoning-only attempt does not poison the next idle attempt", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    response.write(wire({ type: "response.reasoning_summary_text.delta", delta: "Reasoning only" }));
    if (count === 1) response.end();
    if (count === 3) response.end(wire(text("RECOVERED")) + wire(done));
  }, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 120 });
  await setup.request({ turn: "failed-reasoning" });
  const second = await setup.request({ turn: "failed-reasoning" });
  assert.equal(second.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 2);
  const final = await setup.request({ turn: "failed-reasoning" });
  assert.match(final.body, /RECOVERED/u);
});

test("reasoning cannot erase an executable tool from an earlier failed attempt", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 1) response.end(wire({ type: "response.output_item.done", output_index: 0,
      item: { type: "function_call", id: "uncertain-tool", call_id: "uncertain-call", name: "write_file", arguments: "{}" } })
      + wire({ type: "response.failed", response: { error: { code: "server_error", message: "temporary" } } }));
    else response.write(wire({ type: "response.reasoning_summary_text.delta", delta: "Reasoning on retry" }));
  }, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 120 });
  await setup.request({ turn: "uncertain-tool" });
  const final = await setup.request({ turn: "uncertain-tool" });
  assert.ok(final.events.some(event => event.type === "response.completed"));
  assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
  await setup.request({ turn: "uncertain-tool" });
  assert.equal(setup.count(), 2);
});

test("prior streamed work also blocks a later empty adaptive idle replay", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 1) response.end(wire(text("EARLIER")));
  }, { buffered: true, adaptiveWaitLimitMs: 1000, upstreamIdleTimeoutMs: 120 });
  await setup.request({ turn: "prior-progress" });
  await setup.request({ turn: "prior-progress" });
  await setup.request({ turn: "prior-progress" });
  assert.equal(setup.count(), 2);
  assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
});

test("a tool preparation timeout cannot discard an earlier idle retry deadline", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 2) {
      response.write(wire({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "pending", call_id: "pending-call", name: "safe", arguments: "" } }));
    } else if (count > 2) response.end(wire(text("UNEXPECTED")) + wire(done));
  }, { buffered: true, adaptiveWaitLimitMs: 600, upstreamIdleTimeoutMs: 180, toolPreparationGraceMs: 60 });
  await setup.request({ turn: "idle-then-preparation" });
  await setup.request({ turn: "idle-then-preparation" });
  assert.ok(setup.events.some(event => event.type === "local_tool_phase_retry_signal"));
  await sleep(650);
  const final = await setup.request({ turn: "idle-then-preparation" });
  assert.equal(setup.count(), 2);
  assert.match(final.body, /等待上限/u);
});

test("a tool preparation timeout cannot discard an earlier hosted work safety marker", async context => {
  const setup = await fixture(context, (_request, response, count) => {
    if (count === 1) {
      response.end(wire({ type: "response.output_item.added", item: { type: "web_search_call", id: "hosted-prior", status: "in_progress" } })
        + wire({ type: "response.failed", response: { error: { code: "server_error", message: "temporary" } } }));
    } else if (count === 2) {
      response.write(wire({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "pending", call_id: "pending-call", name: "safe", arguments: "" } }));
    }
  }, { buffered: true, adaptiveWaitLimitMs: 1500, upstreamIdleTimeoutMs: 180, toolPreparationGraceMs: 60 });
  await setup.request({ turn: "hosted-then-preparation" });
  await setup.request({ turn: "hosted-then-preparation" });
  const final = await setup.request({ turn: "hosted-then-preparation" });
  assert.ok(final.events.some(event => event.type === "response.completed"));
  assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 1);
  assert.equal(setup.events.filter(event => event.type === "local_tool_phase_retry_signal").length, 1);
  await setup.request({ turn: "hosted-then-preparation" });
  assert.equal(setup.count(), 3);
});

test("body progress cannot reset a buffered request hard budget", async context => {
  const setup = await fixture(context, (_request, response) => {
    const timer = setInterval(() => response.write(wire(text("a"))), 20);
    response.once("close", () => clearInterval(timer));
  }, { buffered: true, adaptiveWaitLimitMs: 240 });
  const began = Date.now();
  const result = await setup.request();
  assert.match(result.body, /等待上限/u);
  assert.ok(Date.now() - began < 750);
  assert.equal(setup.proxy.status().adaptiveDelivery.buffered, 1);
});

test("a creation acknowledgement without sustained upstream activity cannot trigger a probe", async context => {
  const setup = await fixture(context, () => {});
  const result = await setup.request();
  assert.equal(result.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.events.some(event => event.type === "adaptive_delivery_probe_started"), false);
});

test("unknown account keeps the existing deadline instead of sharing another account profile", async context => {
  const setup = await fixture(context, (_request, response) => heartbeat(response), { buffered: true });
  const result = await setup.request({ anonymous: true });
  assert.equal(result.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.events.some(event => event.type === "adaptive_delivery_probe_started"), false);
});

test("safety failure during a probe is terminal and is not delivery-mode evidence", async context => {
  const setup = await fixture(context, async (_request, response) => {
    heartbeat(response);
    await sleep(130);
    response.end(wire({ type: "response.failed", response: { error: { code: "bio_policy", message: "blocked" } } }));
  });
  const result = await setup.request();
  assert.match(result.body, /触发栅栏检查/u);
  assert.equal(setup.count(), 1);
  assert.equal(setup.proxy.status().adaptiveDelivery.buffered, 0);
});

test("an unfinished tool commit cannot escape when the buffered budget expires", async context => {
  const setup = await fixture(context, (_request, response) => {
    heartbeat(response);
    response.write(wire({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "tool", call_id: "call", name: "safe_tool", arguments: "" } }));
    response.write(wire({ type: "response.function_call_arguments.done", item_id: "tool", output_index: 0, arguments: "{}" }));
    response.write(wire({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "tool", call_id: "call", name: "safe_tool", arguments: "{}" } }));
  }, { buffered: true, progressIdleTimeoutMs: 1000, adaptiveWaitLimitMs: 220 });
  const result = await setup.request();
  assert.match(result.body, /等待上限/u);
  assert.equal(result.events.some(event => event.type === "response.output_item.done" && event.item?.type === "function_call"), false);
  assert.equal(setup.count(), 1);
});

test("cancelled probes release the request without recording buffered delivery", async context => {
  const setup = await fixture(context, (_request, response) => heartbeat(response));
  const controller = new AbortController();
  const request = setup.request({ signal: controller.signal });
  const rejected = assert.rejects(request);
  await sleep(130);
  controller.abort();
  await rejected;
  await sleep(20);
  assert.equal(setup.proxy.status().activeRequests, 0);
  assert.equal(setup.proxy.status().adaptiveDelivery.buffered, 0);
});
