import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { createModelOperationLedger } from "../src/model-operation-ledger.mjs";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const inputMessage = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const outputMessage = text => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const payload = input => ({ model: "fixture-model", stream: true, instructions: "Loopback integration", tools: [], input });
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const eventsFrom = text => text.split(/\r?\n\r?\n/u).flatMap(value => {
  try { return [JSON.parse(value.split("\n").find(line => line.startsWith("data:"))?.slice(5))]; }
  catch { return []; }
});

async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Integration fixture timed out");
    await delay(5);
  }
}

function complete(socket, id, output = [], delta) {
  socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
  if (delta) socket.send(JSON.stringify({ type: "response.output_text.delta", delta }));
  socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output } }));
}

async function fixture(context, { onPacket, onHttp, transportOptions = {}, proxyOptions = {} } = {}) {
  const packets = [];
  const connections = [];
  const httpRequests = [];
  const recovery = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const entry = { headers: request.headers, body: Buffer.concat(chunks) };
      httpRequests.push(entry);
      if (onHttp) onHttp(request, response, entry);
      else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frame({ type: "response.completed", response: { id: "http_completed", status: "completed", output: [] } }));
      }
    });
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket, request) => {
    const connection = connections.length + 1;
    connections.push({ connection, socket, headers: request.headers });
    socket.on("error", () => {});
    socket.on("message", raw => {
      const entry = { packet: JSON.parse(raw), socket, connection, index: packets.length + 1 };
      packets.push(entry);
      if (onPacket) onPacket(entry);
      else complete(socket, `resp_${entry.index}`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = createIncrementalResponsesTransport({ responseTimeoutMs: 1000, ...transportOptions });
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: origin,
    incrementalTransport: transport, incrementalUpstreamUrl: origin.replace("http:", "ws:") + "/v1/responses",
    managedRecovery: true, managedRetryBaseMs: 10, firstProgressTimeoutMs: 1000,
    firstLastProgressTimeoutMs: 1000, progressIdleTimeoutMs: 1000, fastRetryDelayMs: 0,
    onRecoveryState: event => recovery.push(event), ...proxyOptions });
  await proxy.start();
  context.after(async () => {
    await proxy.stop();
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => websocket.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(transport.status().connections, 0);
    assert.equal(proxy.status().activeRequests, 0);
    assert.equal(proxy.status().requestBuffer.usedBytes, 0);
  });
  function request({ input = [inputMessage("hello")], turnId = "turn-first", threadId = "thread-fixture",
    authorization = "Bearer fixture-original", signal, compressed = true, model = "fixture-model" } = {}) {
    const body = Buffer.from(JSON.stringify({ ...payload(input), model }));
    const encoded = compressed ? zstdCompressSync(body) : body;
    const done = new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: "127.0.0.1", port: proxy.status().port, path: "/v1/responses",
        method: "POST", signal, headers: { "content-type": "application/json", "content-length": encoded.length,
          ...(compressed ? { "content-encoding": "zstd" } : {}), authorization,
          "chatgpt-account-id": "fixture-account", "user-agent": "fixture-native-0.159",
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId }) } }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.once("end", () => resolve({ status: response.statusCode, text, events: eventsFrom(text) }));
        response.once("error", reject);
      });
      outgoing.once("error", reject);
      outgoing.end(encoded);
    });
    done.catch(() => {});
    return { done, body, encoded };
  }
  return { proxy, transport, packets, connections, httpRequests, recovery, request };
}

test("compressed native HTTP becomes per-thread incremental WS with exact prefix, output and real headers", async context => {
  const reply = outputMessage("first reply");
  const setup = await fixture(context, { onPacket: entry => complete(entry.socket, `resp_${entry.index}`, [reply]) });
  const firstInput = [inputMessage("first")];
  const first = await setup.request({ input: firstInput }).done;
  const suffix = inputMessage("second");
  const second = await setup.request({ input: [...firstInput, reply, suffix], turnId: "turn-second" }).done;
  assert.deepEqual(setup.packets[0].packet.input, firstInput);
  assert.deepEqual(setup.packets[1].packet.input, [suffix]);
  assert.equal(setup.packets[1].packet.previous_response_id, "resp_1");
  assert.equal(setup.connections.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.connections[0].headers["user-agent"], "fixture-native-0.159");
  assert.match(setup.connections[0].headers["openai-beta"], /responses_websockets=2026-02-06/u);
  for (const result of [first, second]) assert.equal(result.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
});

test("separate threads never share a WS connection or previous-response identity", async context => {
  const setup = await fixture(context);
  await setup.request({ threadId: "thread-alpha" }).done;
  await setup.request({ threadId: "thread-beta" }).done;
  assert.equal(setup.connections.length, 2);
  assert.notEqual(setup.packets[0].connection, setup.packets[1].connection);
  assert.equal(setup.packets[1].packet.previous_response_id, undefined);
});

test("tool result sampling in the same native turn gets a distinct operation and keeps its trusted output prefix", async context => {
  const call = { type: "function_call", call_id: "same-turn-call", name: "fixture_tool", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "same-turn-call", output: "done" };
  const setup = await fixture(context, { onPacket: entry => complete(entry.socket, `resp_${entry.index}`, entry.index === 1 ? [call] : []) });
  const input = [inputMessage("use fixture tool")];
  await setup.request({ input }).done;
  const response = await setup.request({ input: [...input, call, result] }).done;
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.connections.length, 1);
  assert.equal(setup.packets[1].packet.previous_response_id, "resp_1");
  assert.deepEqual(setup.packets[1].packet.input, [result]);
  assert.equal(response.events.at(-1).type, "response.completed");
});

test("credential or model changes rebuild the connection and send the complete current input", async context => {
  const setup = await fixture(context);
  await setup.request().done;
  const changedInput = [inputMessage("full changed history")];
  await setup.request({ input: changedInput, authorization: "Bearer fixture-refreshed", turnId: "turn-auth" }).done;
  await setup.request({ input: changedInput, authorization: "Bearer fixture-refreshed", model: "different-model", turnId: "turn-model" }).done;
  assert.equal(setup.connections.length, 3);
  for (const entry of setup.packets.slice(1)) {
    assert.equal(entry.packet.previous_response_id, undefined);
    assert.deepEqual(entry.packet.input, changedInput);
  }
});

test("large compressed history is prewarmed atomically before one generation", async context => {
  const setup = await fixture(context, { transportOptions: { maxMessageBytes: 800 } });
  const call = { type: "function_call", name: "fixture", call_id: "call-fixture", arguments: "{}" };
  const result = { type: "function_call_output", call_id: "call-fixture", output: "verified" };
  const input = [inputMessage("a".repeat(350)), call, result, inputMessage("b".repeat(350)), inputMessage("last")];
  const response = await setup.request({ input }).done;
  assert.ok(setup.packets.length >= 2);
  assert.equal(setup.packets.filter(entry => entry.packet.generate !== false).length, 1);
  assert.deepEqual(setup.packets.flatMap(entry => entry.packet.input), input);
  const toolPacket = setup.packets.find(entry => entry.packet.input.some(item => item.call_id === "call-fixture"));
  assert.deepEqual(toolPacket.packet.input.filter(item => item.call_id === "call-fixture"), [call, result]);
  assert.equal(response.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(setup.httpRequests.length, 0);
});

test("an unsent oversized atom automatically falls back to HTTP with the original compressed bytes", async context => {
  const setup = await fixture(context, { transportOptions: { maxMessageBytes: 400 } });
  const pending = setup.request({ input: [inputMessage("x".repeat(2000))] });
  const response = await pending.done;
  const current = setup.recovery.find(state => state.reason === "websocket_payload_requires_http");
  assert.equal(current.canContinueHttp, false);
  assert.equal(current.acceptance, "not_sent");
  assert.equal(setup.connections.length, 0);
  assert.equal(setup.packets.length, 0);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, pending.encoded);
  assert.equal(response.events.at(-1).type, "response.completed");
});

test("two no-output websocket failures fall back automatically to one complete HTTP request", async context => {
  const setup = await fixture(context, { onPacket: entry => entry.socket.terminate() });
  const pending = setup.request({ input: [inputMessage("complete original context"), inputMessage("next")] });
  const response = await pending.done;
  assert.equal(setup.connections.length, 2);
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, pending.encoded);
  assert.ok(setup.packets.every(entry => entry.packet.previous_response_id === undefined));
  assert.equal(response.events.at(-1).type, "response.completed");
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  assert.ok(setup.recovery.every(state => !state.canContinueHttp));
});

test("metadata and heartbeat before an accepted response do not prevent websocket retry and HTTP fallback", async context => {
  const setup = await fixture(context, { onPacket: entry => {
    for (const event of [
      { type: "codex.rate_limits", rate_limits: [] },
      { type: "codex.response.metadata", metadata: {} },
      { type: "ping" },
      { type: "response.created", response: { id: `metadata-${entry.index}`, status: "in_progress", output: [] } },
      { type: "response.in_progress", response: { id: `metadata-${entry.index}`, status: "in_progress", output: [] } },
    ]) entry.socket.send(JSON.stringify(event));
    setTimeout(() => entry.socket.terminate(), 10);
  } });
  const pending = setup.request();
  const response = await pending.done;
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, pending.encoded);
  assert.equal(response.events.at(-1).type, "response.completed");
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  assert.equal(response.text.includes("duplicate_operation"), false);
});

test("1009 falls back once to full HTTP without resending the websocket packet", async context => {
  const setup = await fixture(context, { onPacket: entry => entry.socket.close(1009, "fixture limit") });
  const pending = setup.request();
  const response = await pending.done;
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.connections.length, 1);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, pending.encoded);
  assert.equal(response.events.at(-1).type, "response.completed");
});

test("natural new requests probe websocket after 1 5 and 15 minute cooldowns and reset on success", async context => {
  let now = 1000;
  let successful = false;
  const setup = await fixture(context, { proxyOptions: { websocketNow: () => now },
    onPacket: entry => successful ? complete(entry.socket, `resp_${entry.index}`) : entry.socket.terminate() });
  const send = turnId => setup.request({ turnId }).done;
  await send("cooldown-1");
  await send("cooldown-before-1");
  assert.equal(setup.packets.length, 2);
  now += 60_000;
  await send("cooldown-2");
  assert.equal(setup.packets.length, 4);
  now += 299_999;
  await send("cooldown-before-2");
  assert.equal(setup.packets.length, 4);
  now += 1;
  await send("cooldown-3");
  assert.equal(setup.packets.length, 6);
  now += 899_999;
  await send("cooldown-before-3");
  assert.equal(setup.packets.length, 6);
  successful = true;
  now += 1;
  await send("cooldown-recovered");
  await send("cooldown-cleared");
  assert.equal(setup.packets.length, 8);
  assert.equal(setup.httpRequests.length, 6);
});

test("real wall clock probes websocket after one minute and extends the next cooldown to five minutes", {
  skip: process.env.NAPCAT_REAL_COOLDOWN_TEST !== "1", timeout: 75_000,
}, async context => {
  let lastClockRead;
  const fallbacks = [];
  const startedAt = Date.now();
  const setup = await fixture(context, {
    proxyOptions: {
      websocketNow: () => { lastClockRead = Date.now(); return lastClockRead; },
      onRecoveryState: state => {
        if (state.phase === "retrying" && state.reason === "websocket_http_fallback") fallbacks.push({
          observedAt: Date.now(), deferredAt: lastClockRead,
          retryAfterMs: state.retryAfterMs, nextWSAt: lastClockRead + state.retryAfterMs,
        });
      },
    },
    onPacket: entry => entry.socket.terminate(),
  });
  await setup.request({ turnId: "real-cooldown-initial" }).done;
  assert.equal(setup.packets.length, 2);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].retryAfterMs, 60_000);
  await setup.request({ turnId: "real-cooldown-before-probe" }).done;
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.httpRequests.length, 2);
  while (Date.now() < fallbacks[0].nextWSAt) await delay(Math.min(1000, fallbacks[0].nextWSAt - Date.now()));
  assert.equal(setup.packets.length, 2);
  const probeAt = Date.now();
  await setup.request({ turnId: "real-cooldown-natural-probe" }).done;
  assert.ok(probeAt - fallbacks[0].deferredAt >= 60_000);
  assert.equal(setup.packets.length, 4);
  assert.equal(fallbacks.length, 2);
  assert.equal(fallbacks[1].retryAfterMs, 300_000);
  assert.equal(fallbacks[1].nextWSAt - fallbacks[1].deferredAt, 300_000);
  await setup.request({ turnId: "real-cooldown-within-five-minutes" }).done;
  assert.equal(setup.packets.length, 4);
  assert.equal(setup.httpRequests.length, 4);
  assert.ok(Date.now() < fallbacks[1].nextWSAt);
  context.diagnostic(JSON.stringify({ startedAt, probeAt, endedAt: Date.now(),
    firstCooldownElapsedMs: probeAt - fallbacks[0].deferredAt, fallbacks,
    websocketPackets: setup.packets.length, httpRequests: setup.httpRequests.length }));
});

test("partial output is handed to native and a same-turn continuation can use HTTP without a ledger lock", async context => {
  const setup = await fixture(context, { onPacket: entry => {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "partial-native", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "visible native work" }));
    setTimeout(() => entry.socket.terminate(), 20);
  } });
  const first = await setup.request().done;
  assert.match(first.text, /visible native work/u);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  const continuation = await setup.request({ input: [inputMessage("hello"), outputMessage("visible native work"), inputMessage("continue")] }).done;
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 1);
  assert.equal(continuation.events.at(-1).type, "response.completed");
});

test("a restored unknown operation ends protected without replay while a fresh turn remains usable", async context => {
  const ledger = createModelOperationLedger();
  ledger.begin("thread-fixture\u0000turn-first\u0000turn");
  const setup = await fixture(context, { proxyOptions: { operationState: ledger.snapshot() } });
  const protectedResult = await setup.request().done;
  assert.equal(protectedResult.events.at(-1).type, "response.failed");
  assert.equal(protectedResult.events.at(-1).response.error.code, "proxy_operation_recovery_protected");
  assert.equal(setup.packets.length, 0);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 1);
  const repeated = await setup.request().done;
  assert.equal(repeated.events.at(-1).type, "response.failed");
  assert.equal(repeated.events.at(-1).response.error.code, "proxy_operation_recovery_protected");
  assert.equal(repeated.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.packets.length, 0);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 1);
  const fresh = await setup.request({ turnId: "after-native-interrupt" }).done;
  assert.equal(fresh.events.at(-1).type, "response.completed");
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 1);
});

for (const failure of [
  { category: "authentication", status: 401, code: "invalid_token", notice: /认证失败.*重新登录|刷新认证/u },
  { category: "quota", status: 429, code: "usage_limit_reached", notice: /额度已耗尽.*等待额度恢复/u },
]) {
  for (const protocol of ["ws-error", "ws-failed", "http-status", "http-failed"]) {
    test(`${protocol} ${failure.category} stops with an explained IDLE twice and hard-fails the third empty turn without retry`, async context => {
      const observations = [];
      const error = { code: failure.code, status: failure.status, message: "synthetic permanent failure" };
      const failedEvent = { type: "response.failed", response: { id: "permanent-failure", status: "failed", output: [], error } };
      const usingHttp = protocol.startsWith("http-");
      const setup = await fixture(context, {
        proxyOptions: { ...(usingHttp ? { incrementalTransport: null } : {}),
          onModelObservation: event => observations.push(event) },
        onPacket: entry => entry.socket.send(JSON.stringify(protocol === "ws-error"
          ? { type: "error", status: failure.status, error } : failedEvent)),
        onHttp: (_request, response) => {
          response.writeHead(protocol === "http-status" ? failure.status : 200,
            { "content-type": protocol === "http-status" ? "application/json" : "text/event-stream" });
          response.end(protocol === "http-status" ? JSON.stringify({ error }) : frame(failedEvent));
        },
      });
      for (const turn of [1, 2, 3]) {
        const response = await setup.request({ turnId: `permanent-turn-${turn}` }).done;
        assert.equal(setup.packets.length, usingHttp ? 0 : turn);
        assert.equal(setup.httpRequests.length, usingHttp ? turn : 0);
        assert.match(response.text, failure.notice);
        const terminal = response.events.at(-1);
        if (turn < 3) {
          assert.equal(terminal.type, "response.completed");
          assert.equal(terminal.response.status, "completed");
          assert.equal(response.events.filter(event => event.type === "response.completed").length, 1);
          assert.equal(response.events.some(event => event.type === "response.failed"), false);
          const notice = terminal.response.output.find(item => item.id?.startsWith("msg_proxy_"));
          assert.equal(notice.phase, "final_answer");
          assert.match(notice.content.map(part => part.text ?? "").join(""), failure.notice);
          assert.equal(setup.proxy.status().counters.syntheticCompletions, turn);
        } else {
          assert.equal(terminal.type, "response.failed");
          assert.equal(terminal.response.error.code, "proxy_repeated_empty_idle");
          assert.match(terminal.response.error.message, /连续三个回合/u);
          assert.equal(response.events.some(event => event.type === "response.completed"), false);
          assert.equal(setup.proxy.status().counters.syntheticCompletions, 2);
        }
      }
      assert.equal(setup.proxy.status().counters.actualCompletions, 0);
      const ended = observations.filter(event => event.phase === "request.ended");
      assert.equal(ended.length, 3);
      assert.ok(ended.every(event => event.outcome === "failed"));
      assert.equal(observations.some(event => event.outcome === "completed"), false);
      assert.ok(setup.recovery.every(state => !state.willRetry && state.phase !== "waiting"));
      const repeated = await setup.request({ turnId: "permanent-turn-3" }).done;
      assert.equal(repeated.events.at(-1).response.error.code, "proxy_repeated_empty_idle");
      assert.equal(setup.packets.length, usingHttp ? 0 : 3);
      assert.equal(setup.httpRequests.length, usingHttp ? 3 : 0);
    });
  }
}

test("a first-progress timeout with no output permits the second real websocket attempt", async context => {
  const setup = await fixture(context, { proxyOptions: { firstProgressTimeoutMs: 20, firstLastProgressTimeoutMs: 20 },
    onPacket: entry => { if (entry.index === 2) complete(entry.socket, "second-attempt"); } });
  const response = await setup.request().done;
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(response.events.at(-1).response.id, "second-attempt");
});

test("slow multi-packet prewarming crosses first-progress timeout without reporting business recovery", async context => {
  const timers = new Set();
  context.after(() => { for (const timer of timers) clearTimeout(timer); });
  const preparationEvents = [];
  const trace = [];
  const setup = await fixture(context, {
    transportOptions: { maxMessageBytes: 800, responseTimeoutMs: 1000, prewarmTimeoutMs: 1000 },
    proxyOptions: { firstProgressTimeoutMs: 180, consecutiveWaitLimitMs: 300, adaptiveWaitLimitMs: 300,
      onEvent: event => { trace.push(event); if (event.type === "incremental_prewarm_progress") preparationEvents.push(event); } },
    onPacket: entry => {
      if (entry.packet.generate !== false) return complete(entry.socket, `resp_${entry.index}`, [outputMessage("done")], "done");
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (entry.socket.readyState === 1) complete(entry.socket, `resp_${entry.index}`);
      }, 100);
      timers.add(timer);
    },
  });
  const input = Array.from({ length: 15 }, (_, index) => inputMessage(`${index}:` + "x".repeat(350)));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 4000);
  const startedAt = Date.now();
  let response;
  try { response = await setup.request({ input, signal: controller.signal }).done; }
  catch (error) {
    throw new Error(`prewarm failed trace=${JSON.stringify({ packets: setup.packets.map(entry => ({ generate: entry.packet.generate, items: entry.packet.input.length })), recovery: setup.recovery, trace })}`, { cause: error });
  }
  finally { clearTimeout(deadline); }
  assert.ok(Date.now() - startedAt > 1000);
  assert.ok(preparationEvents.length >= 10);
  assert.ok(preparationEvents.every(event => event.businessProgress === false));
  assert.equal(setup.recovery.some(event => event.phase === "waiting" || event.phase === "resumed"), false);
  assert.equal(setup.packets.filter(entry => entry.packet.generate !== false).length, 1);
  assert.deepEqual(setup.packets.flatMap(entry => entry.packet.input), input);
  assert.equal(response.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(setup.httpRequests.length, 0);
});

test("the first websocket packet uses expanded wire bytes instead of its compressed HTTP body", async context => {
  const uploads = [];
  const timers = new Set();
  context.after(() => { for (const timer of timers) clearTimeout(timer); });
  const setup = await fixture(context, {
    transportOptions: { maxMessageBytes: 65536, responseTimeoutMs: 100, prewarmTimeoutMs: 100 },
    proxyOptions: { firstProgressTimeoutMs: 100, firstLastProgressTimeoutMs: 100,
      consecutiveWaitLimitMs: 150, adaptiveWaitLimitMs: 150, uploadAllowanceMsPerMiB: 60000,
      maxUploadAllowanceMs: 2500, onEvent: event => { if (event.type === "incremental_packet_upload_started") uploads.push(event); } },
    onPacket: entry => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (entry.socket.readyState === 1) complete(entry.socket, "expanded_wire_done", [outputMessage("done")], "done");
      }, 250);
      timers.add(timer);
    },
  });
  const request = setup.request({ input: [inputMessage("x".repeat(32000))], compressed: true });
  const response = await request.done;
  assert.ok(request.encoded.length < 1000);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].packetWireBytes, Buffer.byteLength(JSON.stringify(setup.packets[0].packet)));
  assert.ok(uploads[0].packetWireBytes > 32000);
  assert.ok(uploads[0].uploadAllowanceMs > 1800);
  assert.equal(response.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(setup.recovery.some(event => event.phase === "waiting" || event.phase === "resumed"), false);
  assert.equal(setup.httpRequests.length, 0);
});

test("each packet after a prewarm acknowledgement receives its own wire upload allowance", async context => {
  const timers = new Set();
  context.after(() => { for (const timer of timers) clearTimeout(timer); });
  const preparation = [];
  const setup = await fixture(context, {
    transportOptions: { maxMessageBytes: 16000, responseTimeoutMs: 100, prewarmTimeoutMs: 100 },
    proxyOptions: { firstProgressTimeoutMs: 100, firstLastProgressTimeoutMs: 100,
      consecutiveWaitLimitMs: 200, adaptiveWaitLimitMs: 200, uploadAllowanceMsPerMiB: 60000,
      maxUploadAllowanceMs: 2000, onEvent: event => { if (event.type === "incremental_packet_upload_started") preparation.push(event); } },
    onPacket: entry => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (entry.socket.readyState === 1) complete(entry.socket, `resp_${entry.index}`,
          entry.packet.generate === false ? [] : [outputMessage("done")], entry.packet.generate === false ? undefined : "done");
      }, 250);
      timers.add(timer);
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1600);
  let response;
  try { response = await setup.request({ input: Array.from({ length: 4 }, (_, index) => inputMessage(`${index}:` + "x".repeat(8000))),
    compressed: false, signal: controller.signal }).done; }
  finally { clearTimeout(timer); }
  assert.equal(response.events.filter(event => event.type === "response.completed").length, 1);
  assert.ok(preparation.length >= 2);
  assert.equal(preparation.length, setup.packets.length);
  assert.deepEqual(preparation.map(event => event.packetWireBytes), setup.packets.map(entry => Buffer.byteLength(JSON.stringify(entry.packet))));
  assert.ok(preparation.every(event => event.businessProgress === false && event.packetWireBytes > 8000 && event.uploadAllowanceMs > 400));
  assert.equal(setup.recovery.some(event => event.phase === "waiting" || event.phase === "resumed"), false);
  assert.equal(setup.packets.filter(entry => entry.packet.generate !== false).length, 1);
  assert.equal(setup.httpRequests.length, 0);
});

for (const mode of ["close1009", "ws503"]) {
  test(`${mode} with unknown acceptance uses automatic complete HTTP fallback`, async context => {
    const setup = await fixture(context, { onPacket: entry => {
      if (mode === "close1009") entry.socket.close(1009, "Fixture remote message limit");
      else entry.socket.send(JSON.stringify({ type: "error", error: { code: "server_error", status: 503, message: "Fixture unavailable" } }));
    } });
    const pending = setup.request();
    const response = await pending.done;
    assert.equal(setup.packets.length, mode === "close1009" ? 1 : 2);
    assert.equal(setup.httpRequests.length, 1);
    assert.deepEqual(setup.httpRequests[0].body, pending.encoded);
    assert.equal(response.events.at(-1).type, "response.completed");
    await until(() => setup.proxy.status().activeRequests === 0);
    assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
    assert.equal(setup.proxy.status().requestBuffer.usedBytes, 0);
  });
}

test("temporary HTTP reconnect has no attempt ceiling and cancellation releases the original request", async context => {
  const setup = await fixture(context, { proxyOptions: { maxConsecutiveAttempts: 1 },
    onPacket: entry => entry.socket.close(1009), onHttp: (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "server_error", message: "temporary fixture" } }));
    } });
  const controller = new AbortController();
  const pending = setup.request({ signal: controller.signal }).done.catch(error => error);
  await until(() => setup.httpRequests.length >= 8, 5000);
  const cancelledAt = Date.now();
  controller.abort();
  await pending;
  await until(() => setup.proxy.status().activeRequests === 0);
  assert.ok(Date.now() - cancelledAt < 500);
  const calls = setup.httpRequests.length;
  await delay(40);
  assert.equal(setup.httpRequests.length, calls);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
});

test("cancelling a queued same-thread request never sends its generation", async context => {
  const setup = await fixture(context, { onPacket: entry => {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "held-response", status: "in_progress" } }));
  } });
  const firstController = new AbortController();
  const first = setup.request({ signal: firstController.signal }).done.catch(error => error);
  await until(() => setup.packets.length === 1);
  const secondController = new AbortController();
  const second = setup.request({ turnId: "queued-turn", signal: secondController.signal }).done.catch(error => error);
  await until(() => setup.transport.status().queued === 1);
  secondController.abort();
  await second;
  await until(() => setup.transport.status().queued === 0);
  firstController.abort();
  await first;
  await until(() => setup.proxy.status().activeRequests === 0);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 0);
});
