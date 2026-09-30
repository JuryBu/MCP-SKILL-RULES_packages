import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { deliveryProfileKey } from "../src/adaptive-delivery.mjs";

const wire = event => `data: ${JSON.stringify(event)}\n\n`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const account = "fake-compaction-account";
const model = "fake-compaction-model";
const opaque = { id: "compact-real", type: "compaction", encrypted_content: "FAKE+/opaque==\\\"\n原样",
  future_field: { version: 7, payload: ["not-an-assistant-message", null] } };
const reasoning = { id: "reasoning-real", type: "reasoning", encrypted_content: "FAKE-reasoning+/==", summary: [] };
const created = { type: "response.created", response: { id: "response-real", status: "in_progress" } };
const completed = { type: "response.completed", response: { id: "response-real", status: "completed", output: [opaque, reasoning] } };
const compactOutput = wire({ type: "response.output_item.done", output_index: 0, item: opaque })
  + wire({ type: "response.output_item.done", output_index: 1, item: reasoning }) + wire(completed);
const failed = { type: "response.failed", response: { id: "response-real", status: "failed",
  error: { code: "server_error", message: "fake transient compaction failure" } } };
const parse = body => body.split(/\r?\n\r?\n/u).slice(0, -1).flatMap(frame => {
  const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n");
  if (!data || data.trim() === "[DONE]") return [];
  return [JSON.parse(data)];
});

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(10);
  assert.ok(predicate(), message);
}

async function fixture(context, handler, options = {}) {
  const clients = new Set();
  const sockets = new Set();
  const timers = new Set();
  const responses = new Set();
  const handlerErrors = [];
  const events = [];
  const sentBodies = [];
  let count = 0;
  let proxy;
  const upstream = http.createServer((request, response) => {
    request.resume();
    const attempt = ++count;
    sentBodies[attempt - 1] = "";
    responses.add(response);
    response.once("close", () => responses.delete(response));
    const send = (body, end = false) => {
      if (response.destroyed || response.writableEnded) return;
      sentBodies[attempt - 1] += body;
      if (end) response.end(body);
      else response.write(body);
    };
    const later = (callback, milliseconds) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (response.destroyed || response.writableEnded) return;
        try { callback(); } catch (error) { handlerErrors.push(error); response.destroy(error); }
      }, milliseconds);
      timers.add(timer);
      response.once("close", () => { clearTimeout(timer); timers.delete(timer); });
    };
    const heartbeat = () => {
      const timer = setInterval(() => send(wire({ type: "keepalive" })), 50);
      timers.add(timer);
      response.once("close", () => { clearInterval(timer); timers.delete(timer); });
    };
    Promise.resolve().then(() => handler(request, response, attempt, { send, later, heartbeat }))
      .catch(error => { handlerErrors.push(error); response.destroy(error); });
  });
  upstream.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  context.after(async () => {
    for (const client of clients) client.destroy();
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    timers.clear();
    try { await proxy?.stop(); } finally {
      upstream.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      if (upstream.listening) await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
    }
    await waitFor(() => clients.size === 0 && sockets.size === 0 && responses.size === 0, "all owned loopback connections must close");
    assert.equal(proxy?.status().activeRequests ?? 0, 0);
    assert.equal(proxy?.status().running ?? false, false);
    assert.equal(upstream.listening, false);
    assert.equal(timers.size, 0);
    assert.deepEqual(handlerErrors, []);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const { buffered = false, ...proxyOptions } = options;
  const state = buffered ? { schemaVersion: 1, profiles: [{
    key: deliveryProfileKey({ "chatgpt-account-id": account }, { model }, origin), mode: "buffered",
    updatedAt: Date.now(), probeAfter: 0, evidenceStartedAt: 0,
  }] } : undefined;
  proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: origin, firstProgressTimeoutMs: 80,
    progressIdleTimeoutMs: 80, adaptiveWaitLimitMs: 260, upstreamIdleTimeoutMs: 140,
    compactionAttemptTimeoutMs: 10_000, maxConsecutiveAttempts: 2,
    adaptiveDeliveryState: state, onEvent: event => events.push(event), ...proxyOptions });
  await proxy.start();
  const request = (settings = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, stream: settings.unary !== true, input: [], tools: [] });
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body),
      "chatgpt-account-id": account, authorization: "Bearer fake-loopback-token" };
    if (settings.metadata !== false) headers["x-codex-turn-metadata"] = JSON.stringify({
      request_kind: settings.requestKind ?? "compaction", thread_id: "compaction-budget-test", turn_id: settings.turn ?? "same-turn",
    });
    const startedAt = Date.now();
    let settled = false;
    let guard;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (error) reject(error);
      else resolve(result);
    };
    const client = http.request({ host: "127.0.0.1", port: proxy.status().port, method: "POST", agent: false,
      path: settings.path ?? "/backend-api/codex/responses", headers, signal: settings.signal }, response => {
      const chunks = [];
      response.on("data", chunk => {
        chunks.push(chunk);
        try { settings.onData?.(Buffer.concat(chunks).toString("utf8")); }
        catch (error) { finish(error); client.destroy(error); }
      });
      response.once("end", () => {
        const output = Buffer.concat(chunks).toString("utf8");
        try { finish(null, { body: output, events: settings.unary ? [] : parse(output), statusCode: response.statusCode,
          headers: response.headers, elapsedMs: Date.now() - startedAt }); } catch (error) { finish(error); }
      });
      response.once("error", error => finish(error));
    });
    clients.add(client);
    client.once("close", () => clients.delete(client));
    client.once("error", error => finish(error));
    guard = setTimeout(() => client.destroy(new Error("Loopback fixture exceeded its 17 second request guard")), 17_000);
    guard.unref?.();
    client.end(body);
  });
  return { request, events, proxy, count: () => count, sent: attempt => sentBodies[attempt - 1],
    cleanup: (requireClosed = false) => waitFor(() => proxy.status().activeRequests === 0 && responses.size === 0 && (!requireClosed || sockets.size === 0),
      "cancelled or finished attempts must release proxy and upstream state") };
}

function assertRealCompaction(result, expectedBody) {
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, expectedBody, "successful SSE compaction must be forwarded byte for byte");
  assert.deepEqual(result.events.find(event => event.item?.type === "compaction")?.item, opaque);
  assert.deepEqual(result.events.find(event => event.item?.type === "reasoning")?.item, reasoning);
  assert.equal(result.events.find(event => event.type === "response.completed")?.response?.id, "response-real");
}

function assertCompactionError(result) {
  assert.equal(result.events.some(event => event.type === "response.completed"), false, "a compaction failure cannot become ordinary assistant success");
  assert.equal(result.events.some(event => event.item?.type === "message" && event.item?.role === "assistant"), false);
  const failure = result.events.find(event => event.type === "response.failed");
  assert.ok(failure, "compaction exhaustion must produce a response.failed event");
  assert.match(failure.response?.error?.code ?? "", /compaction/iu);
}

for (const route of [
  { label: "metadata sampling SSE", settings: {} },
  { label: "compact URL fallback SSE", settings: { path: "/backend-api/codex/responses/compact", metadata: false } },
]) {
  test(`${route.label} uses compaction budget before its first compaction frame and preserves opaque output`, { timeout: 20_000 }, async context => {
    const setup = await fixture(context, (_request, response, _attempt, { send, later, heartbeat }) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      send(wire(created));
      heartbeat();
      later(() => send(compactOutput, true), 600);
    }, { buffered: true });
    const result = await setup.request(route.settings);
    assertRealCompaction(result, setup.sent(1));
    assert.ok(result.elapsedMs >= 550, "completion must occur after the shortened ordinary first-progress and adaptive budgets");
    assert.equal(setup.count(), 1);
    assert.equal(setup.events.some(event => event.type === "adaptive_wait_stopped"), false);
    assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
    await setup.cleanup();
  });
}

test("unary compact URL fallback outlives ordinary budgets and preserves raw JSON with opaque fields", { timeout: 20_000 }, async context => {
  const raw = '{\n "id": "compact-json-real", "output": ' + JSON.stringify([opaque, reasoning]) + ', "future_field": [1,2,3]\n}\n';
  const setup = await fixture(context, (_request, response, _attempt, { send, later }) => {
    response.writeHead(200, { "content-type": "application/json", "x-fake-result": "compact-original" });
    later(() => send(raw, true), 600);
  }, { buffered: true });
  const result = await setup.request({ unary: true, metadata: false, path: "/backend-api/codex/responses/compact" });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, raw);
  assert.deepEqual(JSON.parse(result.body).output, [opaque, reasoning]);
  assert.equal(result.headers["x-fake-result"], "compact-original");
  assert.ok(result.elapsedMs >= 550);
  assert.equal(setup.count(), 1);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  await setup.cleanup();
});

for (const controlSeen of [false, true]) {
  test(`cancelled compaction ${controlSeen ? "after" : "before"} its first control frame retries without ordinary adaptive cache`, { timeout: 20_000 }, async context => {
    const setup = await fixture(context, (_request, response, attempt, { send, later, heartbeat }) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (attempt > 1) {
        send(wire(created));
        heartbeat();
        later(() => send(compactOutput, true), 600);
        return;
      }
      send(wire(created) + (controlSeen ? wire({ type: "response.output_item.added", output_index: 0,
        item: { id: "compact-pending", type: "compaction_trigger" } }) : ""));
      heartbeat();
    }, { buffered: true });
    const controller = new AbortController();
    await assert.rejects(setup.request({ signal: controller.signal, onData: output => {
      if (parse(output).some(event => controlSeen ? event.item?.type === "compaction_trigger" : event.type === "response.created")) controller.abort();
    } }), error => error.name === "AbortError" || error.code === "ECONNRESET");
    await setup.cleanup(true);
    assert.equal(setup.count(), 1);
    assert.ok(setup.events.some(event => event.type === "downstream_cancelled"));
    await sleep(340);
    const result = await setup.request();
    assertRealCompaction(result, setup.sent(2));
    assert.ok(result.elapsedMs >= 550, "the retry must also outlive the ordinary adaptive budget before a compaction item arrives");
    assert.equal(setup.count(), 2, "expired ordinary adaptive cache must not block a real compaction retry");
    assert.equal(setup.events.some(event => /adaptive_wait_(?:stopped|terminal_replayed)/u.test(event.type)), false);
    assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
    await setup.cleanup();
  });
}

test("cancelled compaction retry reports a terminal compaction error, not adaptive assistant success", { timeout: 20_000 }, async context => {
  const setup = await fixture(context, (_request, response, attempt, { send, later, heartbeat }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    send(wire(created));
    heartbeat();
    if (attempt > 1) later(() => send(wire(failed), true), 600);
  }, { buffered: true, maxConsecutiveAttempts: 1 });
  const controller = new AbortController();
  await assert.rejects(setup.request({ signal: controller.signal, onData: () => controller.abort() }));
  await setup.cleanup(true);
  await sleep(340);
  const result = await setup.request();
  assertCompactionError(result);
  assert.equal(setup.count(), 2);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  await setup.cleanup(true);
});

test("two transient compaction attempts exhaust with an explicit error before any compaction output", { timeout: 20_000 }, async context => {
  const setup = await fixture(context, (_request, response, _attempt, { send }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    send(wire(created) + wire(failed), true);
  }, { maxConsecutiveAttempts: 2 });
  const first = await setup.request();
  assert.equal(first.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.count(), 1);
  await setup.cleanup(true);
  const terminal = await setup.request();
  assertCompactionError(terminal);
  assert.equal(setup.count(), 2);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  await setup.cleanup(true);
});

test("an upstream disconnect on compaction reports an explicit terminal error and closes loopback state", { timeout: 20_000 }, async context => {
  const setup = await fixture(context, (_request, response, _attempt, { send, later }) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    send(wire(created));
    later(() => response.destroy(), 30);
  }, { maxConsecutiveAttempts: 1 });
  assertCompactionError(await setup.request());
  assert.equal(setup.count(), 1);
  await setup.cleanup(true);
});

for (const delayControl of [false, true]) {
  test(`compaction absolute 10 second attempt cap ${delayControl ? "cannot reset on a late control frame" : "applies before any control frame"}`, { timeout: 20_000 }, async context => {
    const setup = await fixture(context, (_request, response, _attempt, { send, later, heartbeat }) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      send(wire(created));
      heartbeat();
      if (delayControl) later(() => send(wire({ type: "response.output_item.added", output_index: 0,
        item: { id: "compact-late", type: "compaction" } })), 3000);
    }, { buffered: true, maxConsecutiveAttempts: 1 });
    const result = await setup.request();
    assertCompactionError(result);
    const timeout = setup.events.find(event => event.type === "attempt_progress_timeout");
    assert.ok(timeout, "the real proxy must enforce its compaction attempt watchdog");
    assert.match(timeout.reason, /COMPACTION.*TIMEOUT/u);
    assert.ok(timeout.elapsedMs >= 9800 && timeout.elapsedMs < 11_800,
      `one absolute attempt budget must expire near 10000ms, observed ${timeout.elapsedMs}ms`);
    assert.equal(setup.count(), 1);
    assert.equal(setup.proxy.status().compactionAttemptTimeoutMs, 10_000);
    assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
    await setup.cleanup(true);
  });
}

test("unary compaction uses its independent 10 second timeout and returns a JSON compaction error", { timeout: 20_000 }, async context => {
  const setup = await fixture(context, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  }, { buffered: true, maxConsecutiveAttempts: 1 });
  const result = await setup.request({ unary: true, path: "/backend-api/codex/responses/compact" });
  assert.equal(result.statusCode, 502);
  assert.match(result.headers["content-type"], /application\/json/u);
  assert.match(JSON.parse(result.body).error?.code ?? "", /COMPACTION.*TIMEOUT/u);
  assert.doesNotMatch(result.body, /response\.completed|"role":"assistant"/u);
  assert.ok(result.elapsedMs >= 9800 && result.elapsedMs < 11_800);
  assert.equal(setup.count(), 1);
  await setup.cleanup(true);
});

test("existing default budgets keep compaction at 600 seconds independently of ordinary 40 and adaptive 300", async context => {
  const setup = await fixture(context, () => { throw new Error("default budget inspection must not send an upstream request"); }, {
    firstProgressTimeoutMs: undefined, progressIdleTimeoutMs: undefined,
    adaptiveWaitLimitMs: undefined, compactionAttemptTimeoutMs: undefined,
  });
  assert.equal(setup.proxy.status().firstProgressTimeoutMs, 40_000);
  assert.equal(setup.proxy.status().adaptiveWaitLimitMs, 300_000);
  assert.equal(setup.proxy.status().compactionAttemptTimeoutMs, 600_000);
  assert.equal(setup.count(), 0);
  context.diagnostic(`runtime=${process.version}; platform=${process.platform}/${process.arch}; proxy=${setup.proxy.status().implementationVersion}`);
});
