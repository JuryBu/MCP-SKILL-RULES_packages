import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const complete = text => frame({ type: "response.output_text.delta", delta: text }) + frame({ type: "response.completed" });

async function fixture(context, handler, options = {}) {
  const events = [];
  const timers = new Set();
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!context.signal.aborted) callback(); }, delay);
    timers.add(timer);
  };
  const upstream = http.createServer((request, response) => handler(request, response, later));
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    firstProgressTimeoutMs: 120, progressIdleTimeoutMs: 120, uploadAllowanceMsPerMiB: 0,
    onEvent: event => events.push(event), ...options });
  await proxy.start();
  context.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const send = (metadata = {}, signal) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "fixture-model", stream: true });
    const request = http.request({ host: "127.0.0.1", port: proxy.status().port, method: "POST",
      path: "/backend-api/codex/responses", signal, headers: { "content-type": "application/json",
        "chatgpt-account-id": "fixture-account",
        "content-length": Buffer.byteLength(body), "x-codex-turn-metadata": JSON.stringify({
          thread_id: "wait-policy-thread", turn_id: "wait-policy-turn", request_kind: "turn", ...metadata }) } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("error", reject);
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
    request.end(body);
  });
  return { proxy, send, events };
}

test("production defaults expose first/last 60, one retry 90 and reasoning idle 60", async context => {
  const { proxy } = await fixture(context, () => {}, { firstProgressTimeoutMs: 40_000, progressIdleTimeoutMs: 40_000 });
  const state = proxy.status();
  assert.equal(state.firstProgressTimeoutMs, 40_000);
  assert.equal(state.firstLastProgressTimeoutMs, 60_000);
  assert.equal(state.rapidRetryMinimumMs, 70_000);
  assert.equal(state.retryFirstProgressTimeoutMs, 90_000);
  assert.equal(state.reasoningProgressIdleTimeoutMs, 60_000);
  assert.equal(state.progressIdleTimeoutMs, 40_000);
  assert.equal(state.adaptiveWaitLimitMs, 300_000);
  assert.equal(state.consecutiveWaitLimitMs, 340_000);
  assert.equal(state.upstreamIdleTimeoutMs, 90_000);
  assert.equal(state.maxConsecutiveAttempts, 6);
});

test("six silent attempts use 60/90/40/40/40/60 proportions then stop", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  });
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) last = await send();
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.deepEqual(starts.map(event => event.firstProgressTimeoutMs), [180, 270, 120, 120, 120, 180]);
  assert.deepEqual(starts.map(event => event.firstProgressRetryProbe), [false, true, false, false, false, false]);
  assert.equal(events.filter(event => event.type === "native_retry_signal").length, 5);
  assert.match(last, /response.completed/u);
  assert.equal(events.filter(event => event.type === "retry_exhausted_completed_idle").length, 1);
});

for (const kind of ["encrypted", "delta", "partial"]) {
  test(`${kind} reasoning survives a gap longer than ordinary idle`, async context => {
    const { send, events } = await fixture(context, (_request, response, later) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (kind === "encrypted") response.write(frame({ type: "response.output_item.done", output_index: 0,
        item: { id: "reasoning-one", type: "reasoning", encrypted_content: "fixture-encrypted" } }));
      else if (kind === "delta") response.write(frame({ type: "response.reasoning_text.delta", item_id: "reasoning-one", delta: "progress" }));
      else response.write('data: {"type":"response.reasoning_text.delta","item_id":"reasoning-one","delta":"progress');
      later(() => {
        if (response.destroyed) return;
        if (kind === "partial") response.write('"}\n\n');
        response.end(complete("reasoning-survived"));
      }, 240);
    }, { firstProgressTimeoutMs: 200, progressIdleTimeoutMs: 200 });
    assert.match(await send(), /reasoning-survived/u);
    assert.equal(events.some(event => event.type === "attempt_progress_timeout"), false);
  });
}

test("ordinary text retains its existing idle deadline", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.output_text.delta", delta: "existing text" }));
    later(() => { if (!response.destroyed) response.end(complete("too-late")); }, 300);
  }, { progressIdleTimeoutMs: 180, maxConsecutiveAttempts: 1 });
  assert.doesNotMatch(await send(), /too-late/u);
  assert.equal(events.find(event => event.type === "attempt_progress_timeout").reason, "PROGRESS_IDLE_TIMEOUT");
});

test("repeated completed reasoning and empty reasoning do not extend the deadline", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = { id: "duplicate", type: "reasoning", encrypted_content: "fixture-encrypted" };
    response.write(frame({ type: "response.output_item.done", item }));
    later(() => response.write(frame({ type: "response.output_item.done", item })), 100);
    later(() => response.write(frame({ type: "response.output_item.done", item: { ...item, id: "empty", encrypted_content: "" } })), 150);
    later(() => { if (!response.destroyed) response.end(complete("too-late")); }, 390);
  }, { progressIdleTimeoutMs: 200, maxConsecutiveAttempts: 1 });
  assert.doesNotMatch(await send(), /too-late/u);
  assert.equal(events.filter(event => event.type === "first_progress_observed").length, 1);
  const finish = events.find(event => event.type === "turn_attempt_finished");
  assert.equal(finish.reason, "PROGRESS_IDLE_TIMEOUT");
  assert.ok(finish.elapsedMs >= 275 && finish.elapsedMs < 390);
});

test("larger configured deadlines are not shortened", async context => {
  const { proxy } = await fixture(context, () => {}, { firstProgressTimeoutMs: 100_000, progressIdleTimeoutMs: 110_000 });
  assert.equal(proxy.status().firstLastProgressTimeoutMs, 100_000);
  assert.equal(proxy.status().reasoningProgressIdleTimeoutMs, 110_000);
});

test("a completed request resets the chain to the longer first attempt", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(complete("ok"));
  });
  await send(); await send();
  assert.deepEqual(events.filter(event => event.type === "turn_attempt_started").map(event => event.firstProgressTimeoutMs), [180, 180]);
});

test("compaction does not use the first/last extension", async context => {
  const { send, events } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(complete("ok"));
  });
  await send({ request_kind: "compaction" });
  const start = events.find(event => event.type === "turn_attempt_started");
  assert.equal(start.firstProgressTimeoutMs, 120);
  assert.equal(start.firstProgressDeadlineMs, 600_000);
});

test("the last 60-second window is not truncated by the old cumulative limit", async context => {
  const { send, events, proxy } = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
  }, { firstProgressTimeoutMs: 200, adaptiveWaitLimitMs: 1600 });
  assert.equal(proxy.status().consecutiveWaitLimitMs, 1800);
  for (let attempt = 0; attempt < 6; attempt += 1) await send();
  const finishes = events.filter(event => event.type === "turn_attempt_finished");
  assert.equal(finishes.length, 6);
  assert.equal(finishes[5].reason, "FIRST_PROGRESS_TIMEOUT", JSON.stringify(events.filter(event => ["turn_attempt_started", "turn_attempt_finished"].includes(event.type))));
  assert.ok(finishes[5].elapsedMs >= 295);
  assert.equal(events.some(event => event.type === "attempt_progress_timeout" && event.reason === "ADAPTIVE_WAIT_LIMIT"), false);
});

test("extra chain time cannot extend one heartbeat-only attempt", async context => {
  const { send, events } = await fixture(context, (_request, response, later) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const heartbeat = () => {
      if (response.destroyed) return;
      response.write(frame({ type: "response.in_progress" })); later(heartbeat, 40);
    };
    heartbeat();
  }, { adaptiveWaitLimitMs: 350, upstreamIdleTimeoutMs: 150 });
  await send();
  const finish = events.find(event => event.type === "turn_attempt_finished");
  assert.equal(finish.reason, "ADAPTIVE_WAIT_LIMIT", JSON.stringify(events));
  assert.ok(finish.elapsedMs >= 335 && finish.elapsedMs < 435);
  assert.equal(events.some(event => event.type === "first_progress_observed"), false);
});

test("after real reasoning progress the following retry keeps the original shared limit", async context => {
  let calls = 0;
  const { send, events } = await fixture(context, (_request, response, later) => {
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
    if (calls === 1) {
      response.write(frame({ type: "response.reasoning_text.delta", delta: "progress" }));
      later(() => response.destroy(), 260);
    }
  }, { adaptiveWaitLimitMs: 350, reasoningProgressIdleTimeoutMs: 1000 });
  await send(); await send();
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.ok(starts[1].waitBudgetRemainingMs <= 100);
  assert.equal(events.filter(event => event.type === "turn_attempt_finished")[1].reason, "ADAPTIVE_WAIT_LIMIT");
});

for (const partial of [false, true]) {
  test(`reasoning does not extend a pending tool completion (${partial ? "partial" : "full"})`, async context => {
    const { send, events } = await fixture(context, (_request, response, later) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ type: "response.output_item.added", item: {
        id: "tool-one", type: "function_call", call_id: "call-one", name: "fixture_tool", arguments: "" } }));
      response.write(frame({ type: "response.output_item.done", item: {
        id: "tool-one", type: "function_call", call_id: "call-one", name: "fixture_tool", arguments: "{}" } }));
      later(() => response.write(partial
        ? 'data: {"type":"response.reasoning_text.delta","delta":"progress'
        : frame({ type: "response.reasoning_text.delta", delta: "progress" })), 50);
      later(() => {
        if (response.destroyed) return;
        if (partial) response.write('"}\n\n');
        response.end(frame({ type: "response.completed" }));
      }, 320);
    }, { progressIdleTimeoutMs: 200 });
    await send();
    assert.equal(events.find(event => event.type === "turn_attempt_finished").reason, "TOOL_COMPLETION_TIMEOUT");
  });
}

test("rapid failures wait for the independent 70-second minimum before the last attempt", async context => {
  let calls = 0;
  const { send, events } = await fixture(context, (_request, response) => {
    calls += 1;
    if (calls < 6) { response.writeHead(503); response.end("busy"); }
    else { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(complete("recovered")); }
  }, { firstProgressTimeoutMs: 1000 });
  let result;
  for (let attempt = 0; attempt < 6; attempt += 1) result = await send();
  assert.match(result, /recovered/u);
  const starts = events.filter(event => event.type === "turn_attempt_started");
  assert.ok(Date.parse(starts[5].at) - Date.parse(starts[0].at) >= 1740);
  assert.equal(events.filter(event => event.type === "rapid_retry_wait_started").length, 1);
});
