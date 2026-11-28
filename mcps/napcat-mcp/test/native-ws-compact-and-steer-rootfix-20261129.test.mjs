import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createRequire } from "node:module";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { createModelOperationLedger } from "../src/model-operation-ledger.mjs";

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 4000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${label}`);
    await pause(5);
  }
}

const userMsg = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const sendJson = (socket, value) => socket.send(JSON.stringify(value));

async function startWsProxyFixture(context, {
  onUpstreamMessage,
  nativeWebSocketEnabled = true,
  managedRecovery = true,
  managedRetryBaseMs = 20,
  nativeWsRetryOptions = { delayMs: 20, slowDelayMs: 5 },
  interruptTimeoutMs = 1500,
  interruptHandoffTimeoutMs = 2500,
} = {}) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamCalls = [];
  const upstreamInterrupts = [];
  const clients = [];
  const events = [];
  const ledgerSnapshots = [];

  upstream.on("connection", socket => {
    socket.on("message", bytes => {
      const packet = JSON.parse(bytes.toString("utf8"));
      if (packet.type === "response.interrupt") {
        upstreamInterrupts.push({ socket, packet });
        onUpstreamMessage?.({ socket, packet, isInterrupt: true, upstreamCalls, upstreamInterrupts });
        return;
      }
      const callIndex = upstreamCalls.length;
      const entry = { socket, packet, callIndex };
      upstreamCalls.push(entry);
      onUpstreamMessage?.({ socket, packet, isInterrupt: false, callIndex, entry, upstreamCalls, upstreamInterrupts });
    });
  });

  const wsUrl = `ws://127.0.0.1:${upstream.address().port}/v1/responses`;
  const httpOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const transport = createIncrementalResponsesTransport({
    responseTimeoutMs: 5000,
    interruptTimeoutMs,
    interruptHandoffTimeoutMs,
  });

  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: httpOrigin,
    incrementalTransport: transport,
    incrementalUpstreamUrl: wsUrl,
    nativeWebSocketEnabled,
    ...(nativeWsRetryOptions ? { nativeWsRetryOptions } : {}),
    managedRecovery,
    managedRetryBaseMs,
    firstProgressTimeoutMs: 5000,
    progressIdleTimeoutMs: 5000,
    onEvent: event => events.push(event),
    onOperationStateChange: state => ledgerSnapshots.push(structuredClone(state)),
  });
  const status = await proxy.start();

  const connectNative = async (metadata) => {
    const socket = new WebSocket(`ws://127.0.0.1:${status.port}/v1/responses`, {
      headers: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    });
    const received = [];
    let closeInfo = null;
    socket.on("message", bytes => received.push(JSON.parse(bytes.toString("utf8"))));
    socket.on("close", (code, reason) => { closeInfo = { code, reason: reason?.toString("utf8") ?? "" }; });
    socket.on("error", () => {});
    clients.push(socket);
    await once(socket, "open");
    return { socket, received, get closeInfo() { return closeInfo; } };
  };

  const postHttp = (bodyObj, metadata, { path = "/backend-api/codex/responses", authorization = "Bearer fixture-token" } = {}) => {
    const raw = JSON.stringify(bodyObj);
    let incomingResponse = null;
    let bodyText = "";
    const req = http.request({
      hostname: "127.0.0.1",
      port: status.port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(raw),
        authorization,
        "x-codex-turn-metadata": JSON.stringify(metadata),
      },
    });
    const done = new Promise(resolve => {
      req.on("error", error => resolve({ error, bodyText }));
      req.on("response", res => {
        incomingResponse = res;
        res.setEncoding("utf8");
        res.on("data", chunk => { bodyText += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, bodyText }));
        res.on("error", error => resolve({ statusCode: res.statusCode, bodyText, error }));
      });
    });
    req.end(raw);
    return { req, done, get response() { return incomingResponse; }, get bodyText() { return bodyText; } };
  };

  context.after(async () => {
    for (const socket of clients) socket.terminate();
    await proxy.stop();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(transport.status().active, 0, "transport active leak");
    assert.equal(transport.status().queued, 0, "transport queued leak");
    assert.equal(transport.status().receiving, 0, "transport receiving leak");
    assert.equal(transport.status().retainedBytes, 0, "transport retainedBytes leak");
    assert.equal(proxy.status().activeRequests, 0, "proxy activeRequests leak");
    assert.equal(proxy.status().requestBuffer.usedBytes, 0, "proxy requestBuffer leak");
  });

  return { proxy, transport, status, upstream, upstreamCalls, upstreamInterrupts, events, ledgerSnapshots, connectNative, postHttp };
}

test("Case 1a (managedRecovery=true): native WS compaction close 1012 after output_item.added(compaction) silently reconnects on same peer without locking ledger", async context => {
  const metadata = { thread_id: "compact-1012-managed-thread", turn_id: "compact-1012-turn", request_kind: "compaction" };
  const payload = {
    type: "response.create",
    generate: true,
    model: "fixture-model",
    input: [userMsg("long history item 1"), userMsg("long history item 2")],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const state = await startWsProxyFixture(context, {
    managedRecovery: true,
    managedRetryBaseMs: 20,
    nativeWsRetryOptions: null, // production defaults (30s fast cooldown) must NOT stall managed compaction reconnect!
    onUpstreamMessage({ socket, callIndex, isInterrupt }) {
      if (isInterrupt) return;
      const responseId = `resp_compact_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
      if (callIndex === 0) {
        sendJson(socket, {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "compaction", id: "cmp_partial_1", status: "in_progress" },
        });
        setTimeout(() => socket.close(1012, "service restart"), 15);
        return;
      }
      const compactItem = { type: "compaction", id: "cmp_final_2", encrypted_content: "opaque_encrypted_summary_v2" };
      sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "compaction", id: "cmp_final_2" } });
      sendJson(socket, { type: "response.output_item.done", output_index: 0, item: compactItem });
      sendJson(socket, {
        type: "response.completed",
        response: { id: responseId, status: "completed", output: [compactItem] },
      });
    },
  });

  const t0 = Date.now();
  const client = await state.connectNative(metadata);
  sendJson(client.socket, payload);
  await until(() => client.received.some(e => e.type === "response.completed"), 4000, "managed compaction silent reconnect");
  const elapsedMs = Date.now() - t0;

  assert.ok(elapsedMs < 3000, `managed compaction reconnect should be fast, got ${elapsedMs}ms`);
  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(client.received.filter(e => e.type === "response.output_item.added").length, 1);
  assert.equal(client.received.some(e => e.item?.id?.startsWith("msg_proxy_")), false);
  const completedFrame = client.received.find(e => e.type === "response.completed");
  assert.equal(completedFrame?.response?.output?.[0]?.encrypted_content, "opaque_encrypted_summary_v2");
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);
});

test("Case 1b (managedRecovery=false, production retryGate defaults): native WS compaction close 1012 releases ledger and immediate client retry bypasses 30s stall", async context => {
  const metadata = { thread_id: "compact-1012-passthrough-thread", turn_id: "compact-1012-turn", request_kind: "compaction" };
  const payload = {
    type: "response.create",
    generate: true,
    model: "fixture-model",
    input: [userMsg("long history")],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const state = await startWsProxyFixture(context, {
    managedRecovery: false,
    nativeWsRetryOptions: null, // production defaults (30s fast cooldown)
    onUpstreamMessage({ socket, callIndex, isInterrupt }) {
      if (isInterrupt) return;
      const responseId = `resp_compact_pt_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
      if (callIndex === 0) {
        sendJson(socket, {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "compaction", id: "cmp_partial_pt", status: "in_progress" },
        });
        setTimeout(() => socket.close(1012, "service restart"), 15);
        return;
      }
      const compactItem = { type: "compaction", id: "cmp_pt_2", encrypted_content: "opaque_pt_ok" };
      sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "compaction", id: "cmp_pt_2" } });
      sendJson(socket, { type: "response.output_item.done", output_index: 0, item: compactItem });
      sendJson(socket, { type: "response.completed", response: { id: responseId, status: "completed", output: [compactItem] } });
    },
  });

  const first = await state.connectNative(metadata);
  sendJson(first.socket, payload);
  await until(() => first.received.some(e => e.type === "error") && state.proxy.status().activeRequests === 0, 4000, "passthrough compaction error");
  assert.equal(first.received.some(e => e.type === "response.output_item.added"), false);
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);

  const t0 = Date.now();
  const retry = await state.connectNative(metadata);
  sendJson(retry.socket, payload);
  await until(() => retry.received.some(e => e.type === "response.completed"), 4000, "passthrough retry completed");
  assert.ok(Date.now() - t0 < 2000, "1012 compaction retry must not stall 30s in retryGate");
  assert.equal(retry.received.find(e => e.type === "response.completed")?.response?.output?.[0]?.encrypted_content, "opaque_pt_ok");
});

test("Case 2: native WS compaction terminated (1006) after output_item.done or failed with internal_error/flex_unavailable recovers cleanly without locking ledger", async context => {
  for (const mode of ["close_1006", "internal_error", "flex_unavailable"]) {
    const metadata = { thread_id: `compact-${mode}-thread`, turn_id: "turn-1", request_kind: "compaction" };
    const payload = {
      type: "response.create",
      generate: true,
      model: "fixture-model",
      input: [userMsg("history")],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    };
    const state = await startWsProxyFixture(context, {
      managedRecovery: true,
      managedRetryBaseMs: 20,
      onUpstreamMessage({ socket, callIndex, isInterrupt }) {
        if (isInterrupt) return;
        const responseId = `resp_compact_${mode}_${callIndex + 1}`;
        const compactItem = { type: "compaction_summary", id: `cmp_${callIndex + 1}`, encrypted_content: `enc_${callIndex + 1}` };
        sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
        sendJson(socket, { type: "response.in_progress", response: { id: responseId, status: "in_progress", output: [compactItem] } });
        sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "compaction_summary", id: compactItem.id } });
        sendJson(socket, { type: "response.output_item.done", output_index: 0, item: compactItem });
        if (callIndex === 0) {
          if (mode === "close_1006") {
            setTimeout(() => socket.terminate(), 10);
          } else {
            sendJson(socket, {
              type: "response.failed",
              response: { id: responseId, status: "failed", output: [], error: { code: mode, message: `Transient ${mode}` } },
            });
          }
          return;
        }
        sendJson(socket, { type: "response.completed", response: { id: responseId, status: "completed", output: [compactItem] } });
      },
    });

    const client = await state.connectNative(metadata);
    sendJson(client.socket, payload);
    await until(() => client.received.some(e => e.type === "response.completed"), 4000, `${mode} compaction recovered`);
    assert.equal(state.upstreamCalls.length, 2, `${mode} should recover on 2nd attempt`);
    assert.equal(client.received.find(e => e.type === "response.completed")?.response?.output?.[0]?.encrypted_content, "enc_2");
    assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);
  }
});

test("Case 3: HTTP + real incrementalTransport turn/steer cancel after response.created never locks ledger or emits proxy_operation_recovery_protected", async context => {
  const metadata = { thread_id: "steer-http-ws-thread", turn_id: "steer-http-ws-turn", request_kind: "turn" };
  const state = await startWsProxyFixture(context, {
    onUpstreamMessage({ socket, packet, callIndex, isInterrupt }) {
      if (isInterrupt) {
        setTimeout(() => {
          sendJson(socket, {
            type: "response.incomplete",
            response: { id: packet.response_id, status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] },
          });
        }, 60);
        return;
      }
      const responseId = `resp_steer_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
      sendJson(socket, { type: "response.in_progress", response: { id: responseId, status: "in_progress", output: [] } });
      sendJson(socket, { type: "codex.rate_limits", rate_limits: { primary: 50 } });
      if (callIndex === 0) return;
      sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_ok", role: "assistant", status: "in_progress", content: [] } });
      sendJson(socket, { type: "response.output_text.delta", item_id: "msg_ok", output_index: 0, content_index: 0, delta: "steer accepted cleanly" });
      sendJson(socket, {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", id: "msg_ok", role: "assistant", status: "completed", content: [{ type: "output_text", text: "steer accepted cleanly" }] },
      });
      sendJson(socket, {
        type: "response.completed",
        response: { id: responseId, status: "completed", output: [{ type: "message", id: "msg_ok", role: "assistant", status: "completed", content: [{ type: "output_text", text: "steer accepted cleanly" }] }] },
      });
    },
  });

  const first = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("initial prompt")] }, metadata);
  await until(() => state.upstreamCalls.length === 1 && first.bodyText.includes("response.in_progress"), 4000, "first request reached in_progress");

  first.req.destroy();
  await first.done;
  await until(() => state.events.some(e => e.type === "turn_attempt_finished" && e.kind === "cancelled"), 4000, "first request cancelled");
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);

  const second = state.postHttp({
    model: "fixture-model",
    stream: true,
    input: [userMsg("initial prompt"), userMsg("steered follow-up message")],
  }, metadata);
  const secondResult = await second.done;
  assert.equal(secondResult.statusCode, 200);
  assert.match(secondResult.bodyText, /steer accepted cleanly/);
  assert.match(secondResult.bodyText, /response\.completed/);
  assert.doesNotMatch(secondResult.bodyText, /msg_proxy_|proxy_operation_recovery_protected|上游结果尚未核实|先前请求的恢复记录已保留/);
  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(state.upstreamInterrupts.length, 1);
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);
});

test("Case 3b: concurrent steer claim preemption on real incrementalTransport succeeds without ledger lock", async context => {
  const metadata = { thread_id: "steer-preempt-thread", turn_id: "steer-preempt-turn", request_kind: "turn" };
  const state = await startWsProxyFixture(context, {
    onUpstreamMessage({ socket, packet, callIndex, isInterrupt }) {
      if (isInterrupt) {
        sendJson(socket, {
          type: "response.incomplete",
          response: { id: packet.response_id, status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] },
        });
        return;
      }
      const responseId = `resp_preempt_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
      if (callIndex === 0) {
        sendJson(socket, { type: "response.output_text.delta", item_id: "msg_partial", output_index: 0, content_index: 0, delta: "partial text before steer" });
        return;
      }
      sendJson(socket, {
        type: "response.completed",
        response: { id: responseId, status: "completed", output: [{ type: "message", id: "msg_preempt_ok", role: "assistant", status: "completed", content: [{ type: "output_text", text: "preempt successor ok" }] }] },
      });
    },
  });

  const first = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("base")] }, metadata);
  await until(() => state.upstreamCalls.length === 1 && first.bodyText.includes("partial text before steer"), 4000, "first partial text");

  const successor = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("base"), userMsg("new steer")] }, metadata);
  const successorResult = await successor.done;
  await first.done;

  assert.equal(successorResult.statusCode, 200);
  assert.match(successorResult.bodyText, /preempt successor ok/);
  assert.doesNotMatch(successorResult.bodyText, /msg_proxy_|proxy_operation_recovery_protected|上游结果尚未核实/);
  assert.equal(state.events.some(e => e.type === "native_steer_claim_successor"), true);
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);
});

test("Case 4: directHttp steer cancel after response.created releases ledger and successor succeeds", async context => {
  const upstreamCalls = [];
  const sockets = new Set();
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.once("end", () => {
      const idx = upstreamCalls.length;
      upstreamCalls.push({ payload: JSON.parse(Buffer.concat(chunks).toString("utf8")), res });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `http_${idx + 1}`, status: "in_progress", output: [] } })}\n\n`);
      if (idx === 1) {
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: "http_2", status: "completed", output: [{ type: "message", id: "m2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "direct http steer ok" }] }] } })}\n\n`);
      }
    });
  });
  upstream.on("connection", s => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    managedRecovery: true,
    firstProgressTimeoutMs: 5000,
    progressIdleTimeoutMs: 5000,
  });
  const status = await proxy.start();
  context.after(async () => {
    await proxy.stop();
    for (const s of sockets) s.destroy();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(proxy.status().activeRequests, 0);
  });

  const metadata = { thread_id: "direct-http-steer-thread", turn_id: "direct-http-steer-turn", request_kind: "turn" };
  const sendPost = input => {
    const raw = JSON.stringify({ model: "fixture-model", stream: true, input });
    let text = "";
    const req = http.request({
      hostname: "127.0.0.1",
      port: status.port,
      path: "/backend-api/codex/responses",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-codex-turn-metadata": JSON.stringify(metadata) },
    });
    const done = new Promise(resolve => {
      req.on("error", error => resolve({ error, text }));
      req.on("response", res => {
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, text }));
        res.on("error", error => resolve({ statusCode: res.statusCode, text, error }));
      });
    });
    req.end(raw);
    return { req, done, get text() { return text; } };
  };

  const first = sendPost([userMsg("hello")]);
  await until(() => upstreamCalls.length === 1 && first.text.includes("response.created"), 4000, "directHttp created");
  first.req.destroy();
  await first.done;
  await until(() => proxy.status().activeRequests === 0, 4000, "directHttp cleaned");
  assert.equal(proxy.status().operationLedger.protectedOperations, 0);

  const second = sendPost([userMsg("hello"), userMsg("steer")]);
  const res2 = await second.done;
  assert.equal(res2.statusCode, 200);
  assert.match(res2.text, /direct http steer ok/);
  assert.doesNotMatch(res2.text, /msg_proxy_|proxy_operation_recovery_protected|上游结果尚未核实/);
});

test("Case 5: native WS peer cancel with 0 tools and 0 hosted effects releases ledger so immediate retry succeeds", async context => {
  const metadata = { thread_id: "native-cancel-thread", turn_id: "native-cancel-turn", request_kind: "turn" };
  const state = await startWsProxyFixture(context, {
    onUpstreamMessage({ socket, callIndex, isInterrupt }) {
      if (isInterrupt) return;
      const responseId = `resp_native_cancel_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
      if (callIndex === 0) {
        sendJson(socket, { type: "response.reasoning_summary_text.delta", delta: "thinking before cancel" });
        return;
      }
      sendJson(socket, {
        type: "response.completed",
        response: { id: responseId, status: "completed", output: [{ type: "message", id: "msg_ok_2", role: "assistant", status: "completed", content: [{ type: "output_text", text: "native cancel retry ok" }] }] },
      });
    },
  });

  const first = await state.connectNative(metadata);
  sendJson(first.socket, {
    type: "response.create",
    model: "fixture-model",
    input: [userMsg("first")],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  });
  await until(() => first.received.some(e => e.type === "response.reasoning_summary_text.delta"), 4000, "first reasoning delta");
  first.socket.close(1000, "client steer cancel");
  await until(() => state.proxy.status().activeRequests === 0, 4000, "first native cancel cleaned");
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 0);

  const second = await state.connectNative(metadata);
  sendJson(second.socket, {
    type: "response.create",
    model: "fixture-model",
    input: [userMsg("first"), userMsg("steer")],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  });
  await until(() => second.received.some(e => e.type === "response.completed"), 4000, "second native completed");
  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(second.received.find(e => e.type === "response.completed")?.response?.output?.[0]?.content?.[0]?.text, "native cancel retry ok");
});

test("Case 6a-c (red-team compaction boundaries): hosted tool, store=true, and close 1002 MUST keep reconciliation protection", async context => {
  for (const mode of ["hosted_tool", "store_true", "close_1002"]) {
    const metadata = { thread_id: `compact-guard-${mode}`, turn_id: "turn-1", request_kind: "compaction" };
    const state = await startWsProxyFixture(context, {
      onUpstreamMessage({ socket, callIndex, isInterrupt }) {
        if (isInterrupt) return;
        const responseId = `resp_guard_${mode}_${callIndex + 1}`;
        sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
        if (mode === "hosted_tool") {
          sendJson(socket, {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "web_search_call", id: "ws_1", status: "in_progress" },
          });
          setTimeout(() => socket.close(1012, "restart after hosted tool"), 15);
        } else if (mode === "store_true") {
          sendJson(socket, {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "compaction", id: "cmp_store", status: "in_progress" },
          });
          setTimeout(() => socket.close(1012, "restart with store=true"), 15);
        } else {
          setTimeout(() => socket.close(1002, "protocol error"), 15);
        }
      },
    });
    const payload = {
      type: "response.create",
      generate: true,
      model: "fixture-model",
      ...(mode === "store_true" ? { store: true } : {}),
      input: [userMsg("history")],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    };
    const first = await state.connectNative(metadata);
    sendJson(first.socket, payload);
    await until(() => first.received.some(e => e.type === "error") && state.proxy.status().activeRequests === 0, 4000, `guard ${mode} first error`);
    assert.equal(state.proxy.status().operationLedger.protectedOperations, 1, `${mode} MUST retain ledger protection`);

    const blocked = await state.connectNative(metadata);
    sendJson(blocked.socket, payload);
    await until(() => blocked.received.some(e => e.type === "error"), 4000, `guard ${mode} replay blocked`);
    assert.equal(state.upstreamCalls.length, 1, `${mode} MUST block duplicate upstream replay`);
  }
});

test("Case 6d-f (red-team cancel boundaries): hosted tool, delivered executable tool, and store=true MUST keep ledger protection after cancel", async context => {
  for (const mode of ["hosted_tool", "delivered_tool", "store_true"]) {
    const metadata = { thread_id: `cancel-guard-${mode}`, turn_id: "turn-1", request_kind: "turn" };
    const toolItem = { type: "function_call", id: "fc_1", call_id: "call_guard_1", name: "local_exec", arguments: "{\"cmd\":\"echo\"}", status: "completed" };
    const state = await startWsProxyFixture(context, {
      onUpstreamMessage({ socket, packet, callIndex, isInterrupt }) {
        if (isInterrupt) {
          sendJson(socket, {
            type: "response.incomplete",
            response: { id: packet.response_id, status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] },
          });
          return;
        }
        const responseId = `resp_cguard_${mode}_${callIndex + 1}`;
        sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
        if (mode === "hosted_tool") {
          sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_c1", status: "in_progress" } });
        } else if (mode === "delivered_tool") {
          // Deliver tool via response.completed so holdingToolDone flushes to client before downstream close,
          // OR use a second non-held scenario; here we verify deliveredExecutableToolDone via direct SSE delivery
          sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_guard_1", name: "local_exec", arguments: "" } });
          sendJson(socket, { type: "response.output_item.done", output_index: 0, item: toolItem });
        }
      },
    });

    if (mode === "delivered_tool") {
      // On native WS, output_item.done(function_call) is immediately delivered to peer and recorded in ledger
      const firstWs = await state.connectNative(metadata);
      sendJson(firstWs.socket, {
        type: "response.create",
        model: "fixture-model",
        input: [userMsg("do side effect")],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      });
      await until(() => firstWs.received.some(e => e.type === "response.output_item.done" && e.item?.call_id === "call_guard_1"), 4000, "native tool delivered");
      firstWs.socket.close(1000, "cancel after tool delivered");
      await until(() => state.proxy.status().activeRequests === 0, 4000, "native tool cancel settled");
      assert.equal(state.proxy.status().operationLedger.protectedOperations, 1, "delivered_tool cancel MUST retain ledger protection");
      const replay = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("do side effect"), userMsg("steer without tool result")] }, metadata);
      const replayRes = await replay.done;
      assert.equal(state.upstreamCalls.length, 1);
      assert.match(replayRes.bodyText, /先前请求的恢复记录已保留/);
      continue;
    }

    const body = {
      model: "fixture-model",
      stream: true,
      ...(mode === "store_true" ? { store: true } : {}),
      input: [userMsg("do side effect")],
    };
    const first = state.postHttp(body, metadata);
    await until(() => state.upstreamCalls.length === 1 && (
      mode === "hosted_tool" ? first.bodyText.includes("web_search_call") : first.bodyText.includes("response.created")
    ), 4000, `cancel guard ${mode} ready`);

    first.req.destroy();
    await first.done;
    await until(() => state.events.some(e => e.type === "turn_attempt_finished" && e.kind === "cancelled"), 4000, `cancel guard ${mode} settled`);
    assert.equal(state.proxy.status().operationLedger.protectedOperations, 1, `cancel guard ${mode} MUST retain ledger protection`);

    const replay = state.postHttp({ ...body, input: [...body.input, userMsg("steer after side effect")] }, metadata);
    const replayRes = await replay.done;
    assert.equal(state.upstreamCalls.length, 1, `cancel guard ${mode} MUST block unverified replay`);
    assert.match(replayRes.bodyText, /先前请求的恢复记录已保留/);
  }
});

test("Case 6g (ledger unit guard): verified non-reconciliation cancelled settlement with recorded tool preserves receipt until tool output is provided", () => {
  const key = "ledger-cancel-thread\u0000ledger-cancel-turn\u0000turn";
  const input = [userMsg("run tool")];
  const payload = { model: "fixture-model", input };
  const tool = { type: "function_call", call_id: "call_ledger_1", name: "local_fn", arguments: "{}" };
  const ledger = createModelOperationLedger();
  ledger.begin(key, payload);
  ledger.recordTool(key, tool);
  ledger.settle(key, {
    kind: "cancelled",
    deliveredExecutableToolDone: true,
    policy: { category: "cancelled", acceptance: "accepted", retryable: false },
  });
  const entry = ledger.get(key);
  assert.equal(entry?.phase, "unresolved");
  assert.equal(ledger.canContinue(key, payload), false);
  assert.equal(ledger.canContinue(key, {
    ...payload,
    input: [...input, tool, { type: "function_call_output", call_id: "call_ledger_1", output: "ok" }],
  }), true);
});

test("Case 7 (B-P0-1 red-team): directHttp cancel MUST fail-closed on code_interpreter_call, unknown response.* events, and response.output hosted tools", async context => {
  const vectors = [
    ["code_interpreter_event", { type: "response.code_interpreter_call.interpreting", item_id: "ci_1" }],
    ["unknown_hosted_event", { type: "response.mcp_list_tools.in_progress", item_id: "mcp_1" }],
    ["response_output_hosted", { type: "response.in_progress", response: { id: "resp_1", status: "in_progress", output: [{ type: "web_search_call", id: "ws_out_1", status: "in_progress" }] } }],
  ];
  for (const [label, frame] of vectors) {
    const upstreamCalls = [];
    const sockets = new Set();
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.once("end", () => {
        upstreamCalls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${upstreamCalls.length}`, status: "in_progress", output: [] } })}\n\n`);
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      });
    });
    upstream.on("connection", s => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, managedRecovery: true });
    const status = await proxy.start();
    const metadata = { thread_id: `direct-guard-${label}`, turn_id: "turn-1", request_kind: "turn" };
    const sendPost = input => {
      const raw = JSON.stringify({ model: "fixture-model", stream: true, input });
      let text = "";
      const req = http.request({
        hostname: "127.0.0.1", port: status.port, path: "/backend-api/codex/responses", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-codex-turn-metadata": JSON.stringify(metadata) },
      });
      const done = new Promise(resolve => {
        req.on("error", error => resolve({ error, text }));
        req.on("response", res => {
          res.setEncoding("utf8");
          res.on("data", chunk => { text += chunk; });
          res.on("end", () => resolve({ statusCode: res.statusCode, text }));
          res.on("error", error => resolve({ statusCode: res.statusCode, text, error }));
        });
      });
      req.end(raw);
      return { req, done, get text() { return text; } };
    };
    try {
      const first = sendPost([userMsg("run hosted")]);
      await until(() => upstreamCalls.length === 1 && first.text.includes(frame.type), 4000, `${label} frame`);
      first.req.destroy();
      await first.done;
      await until(() => proxy.status().activeRequests === 0, 4000, `${label} cleaned`);
      assert.equal(proxy.status().operationLedger.protectedOperations, 1, `directHttp ${label} MUST lock ledger on cancel`);
      const replay = await sendPost([userMsg("run hosted"), userMsg("steer")]).done;
      assert.equal(upstreamCalls.length, 1, `directHttp ${label} MUST block duplicate upstream call`);
      assert.match(replay.text, /先前请求的恢复记录已保留/);
    } finally {
      await proxy.stop();
      for (const s of sockets) s.destroy();
      await new Promise(resolve => upstream.close(resolve));
    }
  }
});

test("Case 8 (B-P0-2 red-team TOCTOU): in-flight hosted tool arriving during cancelAndDrain immediately blocks queued same-turn steer and re-locks ledger", async context => {
  const metadata = { thread_id: "drain-toctou-thread", turn_id: "drain-toctou-turn", request_kind: "turn" };
  const state = await startWsProxyFixture(context, {
    onUpstreamMessage({ socket, packet, callIndex, isInterrupt }) {
      if (isInterrupt) {
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) {
            sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "mcp_call", id: "mcp_late_1", status: "in_progress" } });
            sendJson(socket, {
              type: "response.incomplete",
              response: { id: packet.response_id, status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] },
            });
          }
        }, 50);
        return;
      }
      const responseId = `resp_toctou_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    },
  });

  const first = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("start")] }, metadata);
  await until(() => state.upstreamCalls.length === 1 && first.bodyText.includes("response.created"), 4000, "toctou first created");
  first.req.destroy();
  await first.done;

  // Immediately enqueue same-turn steer while job1 is still draining before late mcp_call arrives
  const second = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("start"), userMsg("steer during drain")] }, metadata);
  const secondRes = await second.done;

  await until(() => state.proxy.status().activeRequests === 0 && state.transport.status().active === 0, 4000, "toctou drain settled");
  assert.equal(state.upstreamCalls.length, 1, "queued same-turn steer MUST NEVER reach upstream once drain observes mcp_call");
  assert.equal(state.proxy.status().operationLedger.protectedOperations, 1, "ledger MUST be re-locked with requiresReconciliation");
  assert.match(secondRes.bodyText, /本地重复操作保护|先前请求的恢复记录已保留|上游/);

  // A third follow-up after drain completes must ALSO be blocked by the re-locked ledger
  const third = await state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("start"), userMsg("third")] }, metadata).done;
  assert.equal(state.upstreamCalls.length, 1);
  assert.match(third.bodyText, /先前请求的恢复记录已保留/);
});

test("Case 9 (A-P0-2 & A-P1-2): HTTP sampling_sse compaction cancel/disconnect, buffered compaction cancel, and holdingToolDone cancel never deadlock turn", async context => {
  // 9a: HTTP sampling_sse compaction disconnect + cancel
  {
    const upstreamCalls = [];
    const sockets = new Set();
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.once("end", () => {
        const idx = upstreamCalls.length;
        upstreamCalls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        if (req.url === "/v1/responses/compact") {
          if (idx === 0) return; // held until client cancels
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "cmp_buf_ok", status: "completed", output: [{ type: "compaction", id: "c1", encrypted_content: "buf_ok" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `cmp_sse_${idx}`, status: "in_progress", output: [] } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "compaction", id: "cmp_item_1" } })}\n\n`);
        if (idx === 0) {
          setTimeout(() => res.socket?.destroy(), 15);
          return;
        }
        const doneItem = { type: "compaction", id: "cmp_item_2", encrypted_content: "sse_compact_ok" };
        res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: doneItem })}\n\n`);
        res.end(`data: ${JSON.stringify({ type: "response.completed", response: { id: `cmp_sse_${idx}`, status: "completed", output: [doneItem] } })}\n\n`);
      });
    });
    upstream.on("connection", s => { sockets.add(s); s.once("close", () => sockets.delete(s)); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, managedRecovery: true, managedRetryBaseMs: 20 });
    const status = await proxy.start();
    const post = (urlPath, bodyObj, md) => {
      const raw = JSON.stringify(bodyObj);
      let text = "";
      const req = http.request({
        hostname: "127.0.0.1", port: status.port, path: urlPath, method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw), "x-codex-turn-metadata": JSON.stringify(md) },
      });
      const done = new Promise(resolve => {
        req.on("error", error => resolve({ error, text }));
        req.on("response", res => {
          res.setEncoding("utf8");
          res.on("data", c => { text += c; });
          res.on("end", () => resolve({ statusCode: res.statusCode, text }));
          res.on("error", error => resolve({ statusCode: res.statusCode, text, error }));
        });
      });
      req.end(raw);
      return { req, done };
    };
    try {
      const mdSse = { thread_id: "http-sse-compact", turn_id: "t1", request_kind: "compaction" };
      const r1 = await post("/v1/responses", { model: "fixture-model", stream: true, input: [userMsg("hist")] }, mdSse).done;
      assert.equal(proxy.status().operationLedger.protectedOperations, 0, "sampling_sse compaction disconnect must not lock ledger");
      const r2 = await post("/v1/responses", { model: "fixture-model", stream: true, input: [userMsg("hist")] }, mdSse).done;
      assert.match(r2.text, /sse_compact_ok/);
      assert.doesNotMatch(r2.text, /上游结果尚未核实|先前请求的恢复记录已保留/);

      // 9b: buffered /v1/responses/compact downstream cancel
      upstreamCalls.length = 0;
      const mdBuf = { thread_id: "http-buf-compact", turn_id: "t1", request_kind: "compaction" };
      const b1 = post("/v1/responses/compact", { model: "fixture-model", input: [userMsg("hist")] }, mdBuf);
      await until(() => upstreamCalls.length === 1, 4000, "buffered compact started");
      b1.req.destroy();
      await b1.done;
      await until(() => proxy.status().activeRequests === 0, 4000, "buffered compact cancelled");
      assert.equal(proxy.status().operationLedger.protectedOperations, 0, "buffered compaction downstream cancel must not lock ledger");
      const b2 = await post("/v1/responses/compact", { model: "fixture-model", input: [userMsg("hist")] }, mdBuf).done;
      assert.equal(b2.statusCode, 200);
      assert.match(b2.text, /buf_ok/);
    } finally {
      await proxy.stop();
      for (const s of sockets) s.destroy();
      await new Promise(resolve => upstream.close(resolve));
    }
  }

  // 9c: HTTP holdingToolDone cancel (tool was HELD by proxy and never delivered to client) -> steer succeeds
  {
    const metadata = { thread_id: "hold-tool-cancel-thread", turn_id: "turn-1", request_kind: "turn" };
    const heldTool = { type: "function_call", id: "fc_held", call_id: "call_held_never_sent", name: "local_exec", arguments: "{}", status: "completed" };
    const state = await startWsProxyFixture(context, {
      onUpstreamMessage({ socket, packet, callIndex, isInterrupt }) {
        if (isInterrupt) {
          sendJson(socket, { type: "response.incomplete", response: { id: packet.response_id, status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] } });
          return;
        }
        const rid = `resp_hold_${callIndex + 1}`;
        sendJson(socket, { type: "response.created", response: { id: rid, status: "in_progress", output: [] } });
        if (callIndex === 0) {
          sendJson(socket, { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_held", call_id: "call_held_never_sent", name: "local_exec", arguments: "" } });
          sendJson(socket, { type: "response.output_item.done", output_index: 0, item: heldTool });
          // Never sends response.completed -> proxy holds the tool frame (client never saw it!)
          return;
        }
        sendJson(socket, {
          type: "response.completed",
          response: { id: rid, status: "completed", output: [{ type: "message", id: "msg_after_hold", role: "assistant", status: "completed", content: [{ type: "output_text", text: "steer after held tool ok" }] }] },
        });
      },
    });
    const first = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("start")] }, metadata);
    await until(() => state.events.some(e => e.type === "tool_call_observed"), 4000, "held tool observed");
    await pause(30);
    assert.equal(first.bodyText.includes("response.output_item.done"), false, "held tool done frame must not have reached client");
    first.req.destroy();
    await first.done;
    await until(() => state.events.some(e => e.type === "turn_attempt_finished" && e.kind === "cancelled"), 4000, "held cancel settled");
    assert.equal(state.proxy.status().operationLedger.protectedOperations, 0, "undelivered held tool cancel must not deadlock turn");

    const second = await state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("start"), userMsg("steer instead")] }, metadata).done;
    assert.equal(second.statusCode, 200);
    assert.match(second.bodyText, /steer after held tool ok/);
    assert.doesNotMatch(second.bodyText, /先前请求的恢复记录已保留/);
  }
});

test("Case 10 (B-P1-1): silent upstream ignoring response.interrupt on 0-output cancelled request expires at interruptTimeoutMs instead of stalling 30s handoff budget", async context => {
  const metadata = { thread_id: "silent-drain-thread", turn_id: "silent-drain-turn", request_kind: "turn" };
  const state = await startWsProxyFixture(context, {
    interruptTimeoutMs: 120,
    interruptHandoffTimeoutMs: 3000,
    onUpstreamMessage({ socket, callIndex, isInterrupt }) {
      if (isInterrupt) return; // Upstream completely ignores response.interrupt!
      const rid = `resp_silent_${callIndex + 1}`;
      sendJson(socket, { type: "response.created", response: { id: rid, status: "in_progress", output: [] } });
      if (callIndex === 0) return;
      sendJson(socket, {
        type: "response.completed",
        response: { id: rid, status: "completed", output: [{ type: "message", id: "msg_fast", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fast steer rebuild ok" }] }] },
      });
    },
  });

  const first = state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("hello")] }, metadata);
  await until(() => state.upstreamCalls.length === 1 && first.bodyText.includes("response.created"), 4000, "silent first created");
  const t0 = Date.now();
  first.req.destroy();
  await first.done;
  const second = await state.postHttp({ model: "fixture-model", stream: true, input: [userMsg("hello"), userMsg("urgent steer")] }, metadata).done;
  const elapsedMs = Date.now() - t0;
  assert.equal(second.statusCode, 200);
  assert.match(second.bodyText, /fast steer rebuild ok/);
  assert.ok(elapsedMs < 1500, `0-output silent interrupt should expire at ~120ms, not handoff 3000ms (got ${elapsedMs}ms)`);
});
