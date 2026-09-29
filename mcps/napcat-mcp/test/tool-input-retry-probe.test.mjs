import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

function frame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function post(port, threadId = "probe-thread", signal) {
  const payload = Buffer.from(JSON.stringify({ stream: true, tools: [{ type: "custom", name: "exec" }] }));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1", port, path: "/backend-api/codex/responses", method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": String(payload.length),
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: "probe-turn" }) },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.once("error", reject);
    });
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

function beginTool(response, itemId = "probe-tool") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(frame({ type: "response.created", response: { id: "probe-response", status: "in_progress", output: [] } }));
  response.write(frame({ type: "response.output_item.added", output_index: 0,
    item: { id: itemId, type: "custom_tool_call", call_id: itemId, name: "exec", input: "" } }));
  response.write(frame({ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: itemId, delta: "await " }));
}

function completeTool(response, itemId = "probe-tool") {
  const item = { id: itemId, type: "custom_tool_call", call_id: itemId, name: "exec", input: "await read_once()" };
  response.write(frame({ type: "response.custom_tool_call_input.delta", output_index: 0, item_id: itemId, delta: "read_once()" }));
  response.write(frame({ type: "response.output_item.done", output_index: 0, item }));
  response.end(frame({ type: "response.completed", response: { id: "probe-response", status: "completed", output: [item] } }));
}

async function fixture(context, handler, options = {}) {
  const events = [];
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({
    port: 0, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 1000, progressIdleTimeoutMs: 200, retryProgressIdleTimeoutMs: 450,
    ...options, onEvent: event => { events.push(event); options.onEvent?.(event); },
  });
  await proxy.start();
  context.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); await new Promise(resolve => upstream.close(resolve)); });
  return { proxy, events, port: proxy.status().port };
}

function attemptBudgets(events) {
  return events.filter(event => event.type === "turn_attempt_started").map(event => event.toolInputProgressIdleTimeoutMs);
}

test("one longer retry recovers a stalled custom tool input without exposing the abandoned tool", async context => {
  let requests = 0;
  const scenario = await fixture(context, (incoming, response) => {
    requests += 1;
    beginTool(response, `tool-${requests}`);
    if (requests === 2) setTimeout(() => completeTool(response, "tool-2"), 320);
  });
  const first = await post(scenario.port);
  const second = await post(scenario.port);
  assert.doesNotMatch(first, /response\.output_item\.done/u);
  assert.doesNotMatch(first, /response\.completed/u);
  assert.match(second, /response\.completed/u);
  assert.match(second, /tool-2/u);
  assert.doesNotMatch(second, /tool-1/u);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450]);
  assert.equal(scenario.events.filter(event => event.type === "native_retry_signal").length, 1);
});

test("a failed longer retry returns to ordinary waits and retains the original attempt limit", async context => {
  const scenario = await fixture(context, (incoming, response) => beginTool(response));
  const outputs = [];
  for (let attempt = 0; attempt < 6; attempt += 1) outputs.push(await post(scenario.port));
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450, 200, 200, 200, 200]);
  assert.equal(scenario.events.filter(event => event.type === "native_retry_signal").length, 5);
  assert.equal(scenario.events.filter(event => event.type === "retry_exhausted_completed_idle").length, 1);
  assert.match(outputs[5], /response\.completed/u);
  assert.equal(scenario.proxy.status().maxConsecutiveAttempts, 6);
});

test("ordinary text stalls do not enable the tool-input retry probe", async context => {
  const scenario = await fixture(context, (incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.output_text.delta", delta: "partial text" }));
  });
  await post(scenario.port);
  await post(scenario.port);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 200]);
});

test("an already completed executable tool does not enable another preparation probe", async context => {
  const scenario = await fixture(context, (incoming, response) => {
    beginTool(response);
    response.write(frame({ type: "response.output_item.done", output_index: 0,
      item: { id: "probe-tool", type: "custom_tool_call", call_id: "probe-tool", name: "exec", input: "await read_once()" } }));
  });
  await post(scenario.port);
  await post(scenario.port);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 200]);
});

test("a claimed probe keeps ordinary text on the normal idle deadline", async context => {
  let requests = 0;
  const scenario = await fixture(context, (incoming, response) => {
    requests += 1;
    if (requests === 1) return beginTool(response);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.output_text.delta", delta: "ordinary text" }));
    setTimeout(() => {
      if (!response.destroyed) response.end(frame({ type: "response.completed", response: { status: "completed", output: [] } }));
    }, 320);
  });
  await post(scenario.port);
  const retry = await post(scenario.port);
  assert.doesNotMatch(retry, /response\.completed/u);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450]);
  assert.deepEqual(scenario.events.filter(event => event.type === "turn_attempt_started").map(event => event.progressIdleTimeoutMs), [200, 200]);
});

test("a claimed probe returns to the normal deadline after executable tool completion", async context => {
  let requests = 0;
  const scenario = await fixture(context, (incoming, response) => {
    requests += 1;
    beginTool(response);
    if (requests === 1) return;
    response.write(frame({ type: "response.output_item.done", output_index: 0,
      item: { id: "probe-tool", type: "custom_tool_call", call_id: "probe-tool", name: "exec", input: "await read_once()" } }));
    setTimeout(() => {
      if (!response.destroyed) response.end(frame({ type: "response.completed", response: { status: "completed", output: [] } }));
    }, 320);
  });
  await post(scenario.port);
  const retry = await post(scenario.port);
  assert.doesNotMatch(retry, /response\.completed/u);
  assert.doesNotMatch(retry, /response\.output_item\.done/u);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450]);
});

test("a claimed probe keeps split custom tool input on the extended parameter deadline", async context => {
  let requests = 0;
  const scenario = await fixture(context, (incoming, response) => {
    requests += 1;
    beginTool(response);
    if (requests === 1) return;
    response.write('data: {"type":"response.custom_tool_call_input.delta","output_index":0,"item_id":"probe-tool","delta":"read');
    setTimeout(() => {
      if (response.destroyed) return;
      response.write('once()"}\n\n');
      completeTool(response);
    }, 320);
  });
  await post(scenario.port);
  const retry = await post(scenario.port);
  assert.match(retry, /response\.completed/u);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450]);
  assert.equal(scenario.events.filter(event => event.type === "native_retry_signal").length, 1);
});

test("a claimed probe keeps partial ordinary SSE content on the normal idle deadline", async context => {
  let requests = 0;
  const scenario = await fixture(context, (incoming, response) => {
    requests += 1;
    if (requests === 1) return beginTool(response);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.output_text.delta","delta":"ordinary');
    setTimeout(() => {
      if (!response.destroyed) response.end(' text"}\n\n' + frame({ type: "response.completed", response: { status: "completed", output: [] } }));
    }, 320);
  });
  await post(scenario.port);
  const retry = await post(scenario.port);
  assert.doesNotMatch(retry, /response\.completed/u);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450]);
});

test("successful completion resets the probe for the next model request", async context => {
  let requests = 0;
  const scenario = await fixture(context, (incoming, response) => {
    requests += 1;
    beginTool(response);
    if (requests === 2) completeTool(response);
  });
  await post(scenario.port);
  await post(scenario.port);
  await post(scenario.port);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450, 200]);
});

test("a different thread cannot use another thread's longer retry", async context => {
  const scenario = await fixture(context, (incoming, response) => beginTool(response));
  await post(scenario.port, "thread-a");
  await post(scenario.port, "thread-b");
  await post(scenario.port, "thread-a");
  assert.deepEqual(attemptBudgets(scenario.events), [200, 200, 450]);
});

test("cancelling the longer retry consumes its one-time probe without leaving a request active", { timeout: 5000 }, async context => {
  let markRetryStarted;
  const retryStarted = new Promise(resolve => { markRetryStarted = resolve; });
  const scenario = await fixture(context, (incoming, response) => beginTool(response), {
    onEvent: event => { if (event.type === "turn_attempt_started" && event.progressRetryProbe) markRetryStarted(); },
  });
  await post(scenario.port);
  const controller = new AbortController();
  const cancelled = post(scenario.port, "probe-thread", controller.signal);
  const cancelledAssertion = assert.rejects(cancelled);
  await retryStarted;
  controller.abort();
  await cancelledAssertion;
  await new Promise(resolve => setTimeout(resolve, 30));
  await post(scenario.port);
  assert.deepEqual(attemptBudgets(scenario.events), [200, 450, 200]);
  assert.equal(scenario.proxy.status().activeRequests, 0);
});

test("the default remains 40 seconds with a 90 second one-time tool-input probe", () => {
  const proxy = createCodexModelStreamProxy();
  assert.equal(proxy.status().progressIdleTimeoutMs, 40_000);
  assert.equal(proxy.status().maxConsecutiveAttempts, 6);
});
