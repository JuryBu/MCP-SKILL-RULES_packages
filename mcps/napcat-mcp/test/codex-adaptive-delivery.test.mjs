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
      response.on("data", chunk => { output += chunk; });
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

test("known buffered mode stops a dead upstream before the hard budget", async context => {
  const setup = await fixture(context, () => {}, { buffered: true, upstreamIdleTimeoutMs: 120 });
  const result = await setup.request();
  assert.match(result.body, /长时间未发送/u);
  assert.ok(setup.events.some(event => event.type === "adaptive_wait_stopped" && event.reason === "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT"));
  assert.equal(setup.count(), 1);
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
