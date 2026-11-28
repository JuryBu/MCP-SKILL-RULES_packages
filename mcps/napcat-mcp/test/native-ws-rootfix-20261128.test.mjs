import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { attachNativeResponsesBridge } from "../src/native-responses-ws-bridge.mjs";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { createModelOperationLedger } from "../src/model-operation-ledger.mjs";
import { acquireInnerColdStart } from "../src/inner-cold-start-state.mjs";

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

const identity = (turn, thread = "rootfix-thread") => ({
  thread_id: thread,
  turn_id: turn,
  request_kind: "turn",
});

const makePacket = (turn, input, previous, { thread = "rootfix-thread", store } = {}) => ({
  type: "response.create",
  model: "gpt-6.2-sol",
  input,
  ...(previous ? { previous_response_id: previous } : {}),
  ...(store !== undefined ? { store } : {}),
  client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity(turn, thread)) },
});

const reasoningItem = (id, summaryText = "thinking step") => ({
  type: "reasoning",
  id,
  status: "completed",
  summary: [{ type: "summary_text", text: summaryText }],
  encrypted_content: `enc_${id}`,
});

const assistantMessage = (id, text) => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text }],
});

async function until(predicate, timeoutMs = 5000, label = "ROOTFIX_TEST_TIMEOUT") {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(label);
    await delay(5);
  }
}

async function createBridgeFixture(context, {
  respond,
  responseTimeoutMs = 400,
  maxNetworkRetries,
  managedRetryBaseMs = 5,
  withLedger = true,
} = {}) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamCalls = [];
  const upstreamSockets = [];
  const bridgeEvents = [];
  const recoveryEvents = [];
  const ledger = withLedger ? createModelOperationLedger() : null;

  upstream.on("connection", socket => {
    upstreamSockets.push(socket);
    socket.on("error", () => {});
    socket.on("message", raw => {
      const payload = JSON.parse(raw.toString("utf8"));
      upstreamCalls.push(payload);
      const send = ev => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(ev));
      };
      respond({ socket, payload, calls: upstreamCalls, send });
    });
  });

  const transport = createIncrementalResponsesTransport({
    responseTimeoutMs,
    onEvent: ev => bridgeEvents.push(ev),
  });
  const server = http.createServer();
  const bridge = attachNativeResponsesBridge({
    server,
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}/v1/responses`,
    createRequestClient: opts => transport.createRequestClient(opts),
    getOperation: id => transport.getOperation(id),
    releaseSession: key => transport.invalidate(key, "test_end"),
    onEvent: ev => bridgeEvents.push(ev),
    onRequestStart: ({ metadata, payload }) => {
      const key = `${metadata.thread_id}\0${metadata.turn_id}`;
      ledger?.begin(key, payload);
      return { key };
    },
    onRequestEnd: ({ context: reqCtx, kind, error, event, deliveredExecutableToolDone, requiresReconciliation, reconciliationAcceptance }) => {
      if (!ledger || !reqCtx?.key) return;
      const retain = kind !== "completed" && requiresReconciliation === true
        && ["accepted", "unknown"].includes(reconciliationAcceptance);
      ledger.settle(reqCtx.key, {
        kind: kind === "interrupted" && !retain ? "completed" : kind,
        policy: retain
          ? { acceptance: reconciliationAcceptance, retryable: false, reasonCode: error?.code ?? "unresolved" }
          : { acceptance: kind === "completed" ? "accepted" : "unknown", retryable: kind !== "completed" && !retain },
        requiresReconciliation: retain,
        deliveredExecutableToolDone,
        responseId: event?.response?.id,
      });
    },
    onToolDone: ({ context: reqCtx, item }) => (ledger && reqCtx?.key ? ledger.recordTool(reqCtx.key, item) === true : true),
    managedRecovery: true,
    managedRetryBaseMs,
    ...(maxNetworkRetries !== undefined ? { maxNetworkRetries } : {}),
    onRecoveryState: ev => recoveryEvents.push(ev),
    nativeWsRetryOptions: { delayMs: 5, slowDelayMs: 5 },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  const peers = [];
  const connect = async () => {
    const peer = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/responses`);
    const client = { peer, seen: [], closed: false, closeCode: null };
    peer.on("error", () => {});
    peer.on("message", raw => client.seen.push(JSON.parse(raw.toString("utf8"))));
    peer.on("close", code => { client.closed = true; client.closeCode = code; });
    peers.push(peer);
    await once(peer, "open");
    return client;
  };

  context.after(async () => {
    for (const p of peers) p.terminate();
    await bridge.close();
    transport.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const s of upstream.clients) s.terminate();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(bridge.status().activeRequests, 0);
    assert.equal(bridge.status().retry.waiters, 0);
    assert.equal(transport.status().active, 0);
    assert.equal(transport.status().retainedBytes, 0);
  });

  return { server, bridge, transport, upstream, upstreamCalls, upstreamSockets, bridgeEvents, recoveryEvents, ledger, connect };
}

test("Case 1 (14:41 incident): WS_CONNECTION_CLOSED 1012 after 2 completed reasoning items reconnects silently and keeps next incremental turn healthy", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ socket, calls, send }) => {
      const n = calls.length;
      if (n === 1) {
        const msg = assistantMessage("msg_base", "base ok");
        send({ type: "response.created", response: { id: "resp_base", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: msg });
        send({ type: "response.completed", response: { id: "resp_base", status: "completed", output: [msg] } });
        return;
      }
      if (n === 2) {
        const r1 = reasoningItem("rs_1", "step one");
        const r2 = reasoningItem("rs_2", "step two");
        send({ type: "response.created", response: { id: "resp_drop_1012", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", status: "in_progress", summary: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: r1 });
        send({ type: "response.output_item.added", output_index: 1, item: { type: "reasoning", id: "rs_2", status: "in_progress", summary: [] } });
        send({ type: "response.output_item.done", output_index: 1, item: r2 });
        socket.close(1012, "server_restart");
        return;
      }
      if (n === 3) {
        const r3 = reasoningItem("rs_3", "recomputed step");
        const msg = assistantMessage("msg_recovered", "recovered clean answer");
        send({ type: "response.created", response: { id: "resp_rec_2", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: r3 });
        send({ type: "response.output_item.done", output_index: 1, item: msg });
        send({ type: "response.completed", response: { id: "resp_rec_2", status: "completed", output: [r3, msg] } });
        return;
      }
      const msg = assistantMessage("msg_turn3", "next turn ok");
      send({ type: "response.created", response: { id: "resp_turn3", status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item: msg });
      send({ type: "response.completed", response: { id: "resp_turn3", status: "completed", output: [msg] } });
    },
  });

  const client = await state.connect();
  client.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: "hello" }])));
  await until(() => client.seen.some(e => e.type === "response.completed"));
  const baseId = client.seen.find(e => e.type === "response.completed").response.id;

  client.seen.length = 0;
  client.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: "run task" }], baseId)));
  await until(() => client.seen.some(e => e.type === "response.completed"));

  assert.equal(state.upstreamCalls.length, 3);
  assert.equal(client.seen.filter(e => e.type === "response.created").length, 1);
  assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice"), false);
  const fullText = JSON.stringify(client.seen);
  assert.equal(fullText.includes("仍待核实"), false);
  assert.equal(fullText.includes("recovered clean answer"), true);
  assert.equal(state.ledger.status().protectedOperations, 0);

  const seqs = client.seen.filter(e => typeof e.sequence_number === "number").map(e => e.sequence_number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `sequence not monotonic: ${seqs}`);

  const turn2Id = client.seen.find(e => e.type === "response.completed").response.id;
  client.seen.length = 0;
  client.peer.send(JSON.stringify(makePacket("turn-3", [{ type: "message", role: "user", content: "follow up" }], turn2Id)));
  await until(() => client.seen.some(e => e.type === "response.completed"));
  assert.equal(JSON.stringify(client.seen).includes("next turn ok"), true);
  assert.equal(state.upstreamCalls.length, 4);
  assert.equal(state.upstreamCalls[3].previous_response_id, "resp_rec_2");
  assert.equal(state.ledger.status().protectedOperations, 0);
});

test("Case 2 (11-27 16:31 incident): WS_CONNECTION_CLOSED 1012 during partial_reasoning reconnects silently without fabricating incomplete item done", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ socket, calls, send }) => {
      if (calls.length === 1) {
        send({ type: "response.created", response: { id: "resp_partial_r", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_partial", status: "in_progress", summary: [] } });
        send({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_partial", summary_index: 0, delta: "half thinking..." });
        socket.close(1012, "server_restart");
        return;
      }
      const r = reasoningItem("rs_retry", "fresh thinking");
      const msg = assistantMessage("msg_after_partial_r", "done after partial reasoning");
      send({ type: "response.created", response: { id: "resp_partial_ok", status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item: r });
      send({ type: "response.output_item.done", output_index: 1, item: msg });
      send({ type: "response.completed", response: { id: "resp_partial_ok", status: "completed", output: [r, msg] } });
    },
  });

  const client = await state.connect();
  client.peer.send(JSON.stringify(makePacket("turn-partial", [{ type: "message", role: "user", content: "think hard" }])));
  await until(() => client.seen.some(e => e.type === "response.completed"));

  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice"), false);
  assert.equal(client.seen.some(e => e.type === "response.output_item.done" && e.item?.id === "rs_partial"), false);
  assert.equal(JSON.stringify(client.seen).includes("done after partial reasoning"), true);
  assert.equal(state.ledger.status().protectedOperations, 0);
});

test("Case 3 (07:44 & 14:43 incidents): WS_CONNECTION_CLOSED 1006 at generation_sent and created_no_output both reconnect silently", async context => {
  for (const mode of ["generation_sent", "no_output"]) {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, calls, send }) => {
        if (calls.length === 1) {
          if (mode === "no_output") {
            send({ type: "response.created", response: { id: `resp_${mode}_1`, status: "in_progress", output: [] } });
          }
          socket.terminate();
          return;
        }
        const msg = assistantMessage(`msg_${mode}`, `ok_${mode}`);
        send({ type: "response.created", response: { id: `resp_${mode}_2`, status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: msg });
        send({ type: "response.completed", response: { id: `resp_${mode}_2`, status: "completed", output: [msg] } });
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket(`turn-${mode}`, [{ type: "message", role: "user", content: mode }])));
    await until(() => client.seen.some(e => e.type === "response.completed"));
    assert.equal(state.upstreamCalls.length, 2, `mode=${mode}`);
    assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice"), false, `mode=${mode}`);
    assert.equal(JSON.stringify(client.seen).includes(`ok_${mode}`), true, `mode=${mode}`);
    assert.equal(state.ledger.status().protectedOperations, 0, `mode=${mode}`);
  }
});

test("Case 4a (04:44 / 06:05 / 06:31 incident): interrupt followed by completed absorbs arbitrary late error/failed/in_progress/completed frames on same socket without conflict", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ payload, calls, send }) => {
      if (payload.type === "response.interrupt") {
        send({ type: "response.completed", response: { id: "resp_race_old", status: "completed", output: [] } });
        return;
      }
      const createCalls = calls.filter(c => c.type === "response.create").length;
      if (createCalls === 1) {
        send({ type: "response.created", response: { id: "resp_race_old", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: reasoningItem("rs_race_old", "before interrupt") });
        return;
      }
      // Immediate next request arrives on SAME socket; upstream sends late race frames from resp_race_old before resp_race_new created
      send({ type: "error", response_id: "resp_race_old", error: { code: "late_interrupt_race", message: "stale" } });
      send({ type: "response.failed", response: { id: "resp_race_old", status: "failed", output: [], error: { code: "interrupted" } } });
      send({ type: "response.in_progress", response: { id: "resp_race_old", status: "in_progress", output: [reasoningItem("rs_late", "late")] } });
      send({ type: "response.completed", response: { id: "resp_race_old", status: "completed", output: [], usage: { total_tokens: 1 } } });
      const msg = assistantMessage("msg_race_new", "same socket zero conflict");
      send({ type: "response.created", response: { id: "resp_race_new", status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item: msg });
      send({ type: "response.completed", response: { id: "resp_race_new", status: "completed", output: [msg] } });
    },
  });

  const client = await state.connect();
  client.peer.send(JSON.stringify(makePacket("turn-race-1", [{ type: "message", role: "user", content: "first" }])));
  await until(() => client.seen.some(e => e.type === "response.output_item.done"));
  const oldPublicId = client.seen.find(e => e.type === "response.created").response.id;
  client.peer.send(JSON.stringify({ type: "response.interrupt", response_id: oldPublicId, mode: "discard_partial_items" }));
  await until(() => client.seen.some(e => e.type === "response.completed"));

  client.seen.length = 0;
  client.peer.send(JSON.stringify(makePacket("turn-race-2", [{ type: "message", role: "user", content: "second immediately" }], oldPublicId)));
  await until(() => client.seen.some(e => e.type === "response.completed"));

  assert.equal(state.upstreamSockets.length, 1, "same socket stays open for incremental steer without breaking previous_response_id");
  assert.equal(state.bridgeEvents.some(e => e.rawCode === "WS_RESPONSE_ID_CONFLICT"), false);
  assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice"), false);
  assert.ok(state.bridgeEvents.filter(e => e.type === "stale_completed_response_event_ignored").length >= 4);
  assert.equal(JSON.stringify(client.seen).includes("same socket zero conflict"), true);
  assert.equal(state.ledger.status().protectedOperations, 0);
});

test("Case 4b (secondary defense): late stale frames on reused socket after acknowledged interrupt are safely ignored before new response establishes", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ payload, calls, send }) => {
      if (payload.type === "response.interrupt") {
        // Acknowledged interrupted terminal keeps socket alive
        send({ type: "response.incomplete", response: { id: "resp_ack_int", status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] } });
        return;
      }
      const createCalls = calls.filter(c => c.type === "response.create").length;
      if (createCalls === 1) {
        send({ type: "response.created", response: { id: "resp_ack_int", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: reasoningItem("rs_ack", "thinking") });
        return;
      }
      // Late frames from acknowledged interrupted response before new response created
      send({ type: "response.in_progress", response: { id: "resp_ack_int", status: "in_progress", output: [] } });
      send({ type: "response.interrupt.accepted", response_id: "resp_ack_int" });
      send({ type: "codex.rate_limits", response_id: "resp_ack_int", rate_limits: { remaining: 99 } });
      const msg = assistantMessage("msg_after_ack", "clean after stale ack frames");
      send({ type: "response.created", response: { id: "resp_after_ack", status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item: msg });
      send({ type: "response.completed", response: { id: "resp_after_ack", status: "completed", output: [msg] } });
    },
  });

  const client = await state.connect();
  client.peer.send(JSON.stringify(makePacket("turn-ack-1", [{ type: "message", role: "user", content: "first" }])));
  await until(() => client.seen.some(e => e.type === "response.output_item.done"));
  const oldPublicId = client.seen.find(e => e.type === "response.created").response.id;
  client.peer.send(JSON.stringify({ type: "response.interrupt", response_id: oldPublicId, mode: "discard_partial_items" }));
  await until(() => client.seen.some(e => e.type === "response.incomplete"));

  client.seen.length = 0;
  client.peer.send(JSON.stringify(makePacket("turn-ack-2", [{ type: "message", role: "user", content: "second" }], oldPublicId)));
  await until(() => client.seen.some(e => e.type === "response.completed"));

  assert.equal(state.bridgeEvents.some(e => e.rawCode === "WS_RESPONSE_ID_CONFLICT"), false);
  assert.ok(state.bridgeEvents.filter(e => e.type === "stale_completed_response_event_ignored").length >= 2);
  assert.equal(JSON.stringify(client.seen).includes("clean after stale ack frames"), true);
  assert.equal(state.ledger.status().protectedOperations, 0);
});

test("Case 5 (red-team negative): genuine WS_RESPONSE_ID_CONFLICT and stale flood >16 strictly block replay and retain full diagnostic correlation", async context => {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  let upstreamCreateCount = 0;
  upstream.on("connection", socket => {
    socket.on("message", raw => {
      const payload = JSON.parse(raw.toString("utf8"));
      if (payload.type !== "response.create") return;
      upstreamCreateCount += 1;
      socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_legit", status: "in_progress", output: [] } }));
      socket.send(JSON.stringify({ type: "response.in_progress", response: { id: "resp_rogue_foreign", status: "in_progress", output: [] } }));
    });
  });

  const events = [];
  const transport = createIncrementalResponsesTransport({ responseTimeoutMs: 500, onEvent: ev => events.push(ev) });
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    incrementalTransport: transport,
    incrementalUpstreamUrl: `ws://127.0.0.1:${upstream.address().port}/v1/responses`,
    nativeWebSocketEnabled: true,
    managedRecovery: true,
    onEvent: ev => events.push(ev),
  });
  const status = await proxy.start();
  let peer = null;
  context.after(async () => {
    peer?.terminate();
    await proxy.stop();
    for (const s of upstream.clients) s.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  peer = new WebSocket(`ws://127.0.0.1:${status.port}/v1/responses`);
  const seen = [];
  peer.on("error", () => {});
  peer.on("message", raw => seen.push(JSON.parse(raw.toString("utf8"))));
  await once(peer, "open");

  peer.send(JSON.stringify(makePacket("turn-conflict", [{ type: "message", role: "user", content: "rogue id test" }], undefined, { thread: "thread-conflict-audit" })));
  await until(() => seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
  await delay(30);

  assert.equal(upstreamCreateCount, 1, "genuine WS_RESPONSE_ID_CONFLICT must never replay");
  const diag = events.find(e => e.type === "native_ws_failure_diagnostic");
  assert.ok(diag, "failure diagnostic must be emitted");
  assert.equal(diag.rawCode, "WS_RESPONSE_ID_CONFLICT");
  assert.ok(diag.responseIdentityConflict, "failure diagnostic must expose responseIdentityConflict");
  assert.equal(diag.responseIdentityConflict.eventType, "response.in_progress");
  assert.equal(diag.responseIdentityConflict.packetResponseIdTag, sha256(JSON.stringify("resp_legit")).slice(0, 16));
  assert.equal(diag.responseIdentityConflict.nestedIdTag, sha256(JSON.stringify("resp_rogue_foreign")).slice(0, 16));

  const notice = events.find(e => e.type === "native_ws_terminal_notice");
  assert.ok(notice, "terminal notice expected for genuine conflict");
  assert.equal(notice.threadHash, sha256("thread-conflict-audit").slice(0, 16), "terminal notice must preserve threadHash after release()");
  assert.equal(notice.turnHash, sha256("turn-conflict").slice(0, 16), "terminal notice must preserve turnHash after release()");
  assert.ok(notice.responseIdentityConflict, "terminal notice must preserve responseIdentityConflict");

  const floodState = await createBridgeFixture(context, {
    respond: ({ calls, send }) => {
      if (calls.length === 1) {
        send({ type: "response.created", response: { id: "resp_flood_old", status: "in_progress", output: [] } });
        send({ type: "response.completed", response: { id: "resp_flood_old", status: "completed", output: [] } });
        return;
      }
      for (let i = 0; i < 18; i++) {
        send({ type: "response.in_progress", response: { id: "resp_flood_old", status: "in_progress", output: [] } });
      }
    },
  });
  const floodClient = await floodState.connect();
  floodClient.peer.send(JSON.stringify(makePacket("turn-flood-1", [{ type: "message", role: "user", content: "init" }])));
  await until(() => floodClient.seen.some(e => e.type === "response.completed"));
  const floodPrev = floodClient.seen.find(e => e.type === "response.completed").response.id;
  floodClient.seen.length = 0;
  floodClient.peer.send(JSON.stringify(makePacket("turn-flood-2", [{ type: "message", role: "user", content: "flood" }], floodPrev)));
  await until(() => floodState.bridgeEvents.some(e => e.rawCode === "WS_RESPONSE_ID_CONFLICT"));
  assert.equal(floodState.upstreamCalls.length, 2, "stale flood >16 must stop and must not replay");
});

test("Case 6a-d (red-team safety boundaries): protocol close 1002/1009, WS_ERR_INVALID_UTF8, store=true, hosted tool, and 400 previous_response_not_found never auto-retry", async context => {
  // 6a: WS close 1002 & 1009
  for (const closeCode of [1002, 1009]) {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, send }) => {
        send({ type: "response.created", response: { id: `resp_close_${closeCode}`, status: "in_progress", output: [] } });
        socket.close(closeCode, "protocol_rejection");
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket(`turn-close-${closeCode}`, [{ type: "message", role: "user", content: "hi" }])));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1, `closeCode ${closeCode} must not retry`);
  }

  // 6b: malformed UTF-8 text frame triggering WS_CONNECTION_ERROR with closeCode 1007 / WS_ERR_INVALID_UTF8
  {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, send }) => {
        send({ type: "response.created", response: { id: "resp_bad_utf8", status: "in_progress", output: [] } });
        // Raw invalid UTF-8 WS text frame (FIN=1, opcode=1, len=2, payload=0xFF 0xFE)
        socket._socket.write(Buffer.from([0x81, 0x02, 0xff, 0xfe]));
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket("turn-bad-utf8", [{ type: "message", role: "user", content: "utf8" }])));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1, "WS_CONNECTION_ERROR with invalid UTF-8 (1007) must NEVER auto-retry");
  }

  // 6c: store=true
  {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, send }) => {
        send({ type: "response.created", response: { id: "resp_store_true", status: "in_progress", output: [] } });
        socket.close(1012, "restart");
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket("turn-store-true", [{ type: "message", role: "user", content: "stored" }], undefined, { store: true })));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1, "store=true must not auto-retry");
  }

  // 6d: hosted tool web_search_call alone
  {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, send }) => {
        send({ type: "response.created", response: { id: "resp_hosted", status: "in_progress", output: [] } });
        send({ type: "response.web_search_call.in_progress", output_index: 0, item_id: "ws_1" });
        socket.terminate();
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket("turn-hosted", [{ type: "message", role: "user", content: "search" }])));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1, "hosted tool must never auto-retry");
  }

  // 6e: 400 previous_response_not_found (even with acceptance=false) must NEVER auto-retry
  {
    const state = await createBridgeFixture(context, {
      respond: ({ send }) => {
        send({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", code: "previous_response_not_found", message: "previous response not found" },
        });
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket("turn-400-prnf", [{ type: "message", role: "user", content: "stale prev" }])));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed" || e.type === "error"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1, "400 previous_response_not_found must NEVER auto-retry via acceptance=false shortcut");
  }

  // 6e-2: 400 websocket_connection_limit_reached MUST remain exempted and auto-reconnect cleanly
  {
    const state = await createBridgeFixture(context, {
      respond: ({ calls, send }) => {
        if (calls.length === 1) {
          send({ type: "error", status: 400, error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "Maximum connection duration exceeded" } });
          return;
        }
        const msg = assistantMessage("msg_limit_rec", "reconnected after 1h limit");
        send({ type: "response.created", response: { id: "resp_limit_ok", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: msg });
        send({ type: "response.completed", response: { id: "resp_limit_ok", status: "completed", output: [msg] } });
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket("turn-ws-limit", [{ type: "message", role: "user", content: "1h limit" }])));
    await until(() => client.seen.some(e => e.type === "response.completed"));
    assert.equal(state.upstreamCalls.length, 2, "400 websocket_connection_limit_reached must reconnect cleanly");
    assert.equal(JSON.stringify(client.seen).includes("reconnected after 1h limit"), true);
  }
});

test("Case 6f (P0 red-team): visible text followed by hosted tool (web_search_call / mcp_call) or store=true NEVER enters continue_in_client and preserves ledger protection", async context => {
  // 6f-1: visible text + web_search_call.in_progress (without event.response.output) + 1006
  for (const sideEvent of [
    { type: "response.web_search_call.in_progress", output_index: 1, item_id: "ws_after_text" },
    { type: "response.mcp_call.in_progress", output_index: 1, item_id: "mcp_after_text" },
  ]) {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, send }) => {
        send({ type: "response.created", response: { id: "resp_text_hosted", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] } });
        send({ type: "response.output_text.delta", output_index: 0, item_id: "m1", content_index: 0, delta: "Searching now..." });
        send(sideEvent);
        socket.terminate();
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket(`turn-${sideEvent.item_id}`, [{ type: "message", role: "user", content: "search" }])));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1, `${sideEvent.type} must not retry`);
    assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_client_continuation"), false, `${sideEvent.type} after text MUST NOT enter continue_in_client`);
    assert.equal(state.ledger.status().protectedOperations, 1, `${sideEvent.type} after text MUST preserve ledger protection`);
  }

  // 6f-2: visible text + store=true + 1006
  {
    const state = await createBridgeFixture(context, {
      respond: ({ socket, send }) => {
        send({ type: "response.created", response: { id: "resp_text_store", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] } });
        send({ type: "response.output_text.delta", output_index: 0, item_id: "m1", content_index: 0, delta: "Stored partial..." });
        socket.terminate();
      },
    });
    const client = await state.connect();
    client.peer.send(JSON.stringify(makePacket("turn-text-store", [{ type: "message", role: "user", content: "stored text" }], undefined, { store: true })));
    await until(() => client.seen.some(e => e.type === "response.completed" || e.type === "response.failed"));
    await delay(30);
    assert.equal(state.upstreamCalls.length, 1);
    assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_client_continuation"), false, "store=true after text MUST NOT enter continue_in_client");
    assert.equal(state.ledger.status().protectedOperations, 1, "store=true after text MUST preserve ledger protection");
  }
});

test("Case 7 (partial text continuation + real follow-up): disconnect after safe partial text uses continue_in_client, then follow-up succeeds cleanly with ledger at 0", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ socket, calls, send }) => {
      if (calls.length === 1) {
        send({ type: "response.created", response: { id: "resp_partial_text", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] } });
        send({ type: "response.output_text.delta", output_index: 0, item_id: "m1", content_index: 0, delta: "Half answer " });
        socket.terminate();
        return;
      }
      const msg = assistantMessage("m2", "Continued cleanly");
      send({ type: "response.created", response: { id: "resp_continued", status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item: msg });
      send({ type: "response.completed", response: { id: "resp_continued", status: "completed", output: [msg] } });
    },
  });

  const client = await state.connect();
  client.peer.send(JSON.stringify(makePacket("turn-ptext-1", [{ type: "message", role: "user", content: "write long" }])));
  await until(() => client.seen.some(e => e.type === "response.failed" || e.type === "response.completed"));
  await delay(20);

  assert.equal(state.upstreamCalls.length, 1);
  assert.equal(client.seen.some(e => e.type === "response.failed"), true);
  assert.equal(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice"), false);
  assert.equal(JSON.stringify(client.seen).includes("仍待核实"), false);
  assert.equal(state.ledger.status().protectedOperations, 0);

  // Real follow-up request on the same connection succeeds without 400
  client.seen.length = 0;
  client.peer.send(JSON.stringify(makePacket("turn-ptext-2", [
    { type: "message", role: "user", content: "write long" },
    assistantMessage("m1", "Half answer "),
    { type: "message", role: "user", content: "continue" },
  ])));
  await until(() => client.seen.some(e => e.type === "response.completed"));
  assert.equal(state.upstreamCalls.length, 2);
  assert.equal(JSON.stringify(client.seen).includes("Continued cleanly"), true);
  assert.equal(state.ledger.status().protectedOperations, 0);
});

test("Case 8 (maxNetworkRetries cap + real follow-up): bounded reconnect stops cleanly with clear Chinese notice, invalidates dirty anchor, and follow-up succeeds", async context => {
  const state = await createBridgeFixture(context, {
    maxNetworkRetries: 3,
    respond: ({ socket, calls, send }) => {
      const n = calls.length;
      if (n <= 4) {
        send({ type: "response.created", response: { id: `resp_loop_${n}`, status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", output_index: 0, item: reasoningItem(`rs_loop_${n}`, `attempt ${n}`) });
        socket.close(1012, "persistent_outage");
        return;
      }
      const msg = assistantMessage("msg_after_outage", "fresh turn ok");
      send({ type: "response.created", response: { id: "resp_after_outage", status: "in_progress", output: [] } });
      send({ type: "response.output_item.done", output_index: 0, item: msg });
      send({ type: "response.completed", response: { id: "resp_after_outage", status: "completed", output: [msg] } });
    },
  });

  const client = await state.connect();
  client.peer.send(JSON.stringify(makePacket("turn-exhaust", [{ type: "message", role: "user", content: "outage" }])));
  await until(() => client.seen.some(e => e.type === "response.completed"));

  assert.equal(state.upstreamCalls.length, 4);
  const notice = state.bridgeEvents.find(e => e.type === "native_ws_terminal_notice");
  assert.ok(notice);
  assert.equal(notice.retryExhausted, true);
  assert.equal(notice.anchorInvalidated, true);
  const text = JSON.stringify(client.seen);
  assert.equal(text.includes("上游连接多次中断，已自动重连仍未恢复"), true);
  assert.equal(text.includes("仍待核实"), false);
  assert.equal(state.ledger.status().protectedOperations, 0);

  // Real follow-up request after outage recovery succeeds cleanly
  client.seen.length = 0;
  client.peer.send(JSON.stringify(makePacket("turn-exhaust-2", [{ type: "message", role: "user", content: "retry after outage" }])));
  await until(() => client.seen.some(e => e.type === "response.completed"));
  assert.equal(state.upstreamCalls.length, 5);
  assert.equal(JSON.stringify(client.seen).includes("fresh turn ok"), true);
  assert.equal(state.ledger.status().protectedOperations, 0);
});

test("Case 9 (ledger TTL, atomic rollback & requiresReconciliation guard): begin() save failure rolls back expired entries, >1h cure skips requiresReconciliation", () => {
  const realBase = Date.parse("2026-11-28T08:00:00Z");
  let clock = realBase;
  const expiredEvents = [];
  const toolReceipt = {
    callIdHash: sha256("call_1"),
    callHash: sha256("call_hash_1"),
    outputType: "function_call_output",
  };
  const validCont = {
    modelHash: sha256("gpt-6.2-sol"),
    inputTail: [sha256("item_1")],
    inputLength: 1,
    inputHash: sha256(JSON.stringify([sha256("item_1")])),
    tools: [toolReceipt],
    completedTools: [],
  };

  const threadHash = sha256("thread-cure");
  const seed = {
    schemaVersion: 1,
    entries: [
      [sha256("zombie-37d"), { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: realBase - 37 * 86400_000, threadHash: sha256("old-thread"), requiresReconciliation: true }],
      [sha256("expired-25h-notool"), { phase: "unresolved", acceptance: "unknown", reason: "WS_CONNECTION_CLOSED", updatedAt: realBase - 25 * 3600_000, threadHash: sha256("other-thread") }],
      [sha256("keep-25h-tool"), { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: realBase - 25 * 3600_000, threadHash: sha256("tool-thread"), continuation: validCont }],
      [sha256("expired-8d-tool"), { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: realBase - 8 * 86400_000, threadHash: sha256("tool-thread-old"), continuation: validCont }],
      [sha256("same-thread-2h-plain"), { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: realBase - 2 * 3600_000, threadHash }],
      [sha256("same-thread-2h-reconcile"), { phase: "unresolved", acceptance: "accepted", reason: "WS_RESPONSE_ID_CONFLICT", updatedAt: realBase - 2 * 3600_000, threadHash, requiresReconciliation: true }],
      [sha256("same-thread-10m"), { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: realBase - 10 * 60_000, threadHash }],
    ],
  };

  let persisted = null;
  let failSave = false;
  const ledger = createModelOperationLedger({
    state: seed,
    now: () => clock,
    onStateChange: s => {
      if (failSave) throw new Error("DISK_FULL");
      persisted = s;
    },
    onExpired: list => expiredEvents.push(...list),
  });

  assert.deepEqual(Object.keys(ledger.status()).sort(), ["maxEntries", "persistent", "protectedOperations"]);
  // 37d, 25h-notool, 8d-tool pruned on read -> 4 remain
  assert.equal(ledger.status().protectedOperations, 4);
  assert.equal(expiredEvents.length, 3);
  assert.equal(ledger.persistIfPruned(), true, "dirty read prune must persist to disk when persistIfPruned() is called");
  assert.equal(persisted.entries.length, 4);
  assert.equal(ledger.persistIfPruned(), false, "second persistIfPruned() is a no-op");

  // Complete a fresh turn on thread-cure: cures same-thread-2h-plain, KEEPS same-thread-2h-reconcile & same-thread-10m & keep-25h-tool
  const turnKey = "thread-cure\0fresh-turn";
  ledger.begin(turnKey, { model: "gpt-6.2-sol", input: [{ type: "message", role: "user", content: "new turn" }] });
  ledger.settle(turnKey, { kind: "completed", policy: null });
  assert.equal(ledger.status().protectedOperations, 3);
  assert.equal(persisted.entries.some(([k]) => k === sha256("same-thread-2h-plain")), false);
  assert.equal(persisted.entries.some(([k]) => k === sha256("same-thread-2h-reconcile")), true, ">1h cure MUST NOT prematurely drop requiresReconciliation=true");
  assert.equal(persisted.entries.some(([k]) => k === sha256("same-thread-10m")), true);

  // Advance clock by 25h so same-thread-2h-reconcile and same-thread-10m are now expired; simulate save() failure during begin() -> must roll back expired entries atomically!
  clock += 25 * 3600_000;
  const expiredBeforeFail = expiredEvents.length;
  failSave = true;
  assert.throws(
    () => ledger.begin("thread-rollback\0t1", { model: "gpt-6.2-sol", input: [{ type: "message", role: "user", content: "fail save" }] }),
    { code: "MODEL_OPERATION_STATE_PERSISTENCE_FAILED" },
  );
  assert.equal(expiredEvents.length, expiredBeforeFail, "failed begin() save MUST NOT fire onExpired");
  // Restore clock back 25h to prove entries were truly restored into Map on rollback (not silently dropped!)
  clock -= 25 * 3600_000;
  assert.equal(ledger.status().protectedOperations, 3, "failed begin() save MUST restore expired entries atomically into memory");

  // Legacy synthetic low updatedAt (1 / 1900) under default real clock must NOT be pruned
  const legacySeed = {
    schemaVersion: 1,
    entries: [
      [sha256("legacy-1"), { phase: "unresolved", acceptance: "accepted", reason: "request_interrupted", updatedAt: 1, threadHash: sha256("t1") }],
      [sha256("legacy-1900"), { phase: "unresolved", acceptance: "unknown", reason: "request_interrupted", updatedAt: 1900, threadHash: sha256("t2") }],
    ],
  };
  assert.equal(createModelOperationLedger({ state: legacySeed }).status().protectedOperations, 2);
});

test("Case 10 (real acquireInnerColdStart + proxy.start() disk prune): real cold start drops 37-day zombies and proxy startup persists pruned ledger", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rootfix-coldstart-"));
  const guards = [];
  context.after(() => {
    for (const g of guards) { try { g.release(); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 10a: Real acquireInnerColdStart with an older closed session + started worker carrying 37-day zombie + 1h recent entry
  const binding = { stateRoot: root, ownerId: "rootfix-owner", nativeSourceId: "rootfix-native" };
  const oldSessionId = crypto.randomUUID();
  const g1 = acquireInnerColdStart({ ...binding, sessionId: oldSessionId });
  const oldWorkerId = `${oldSessionId}-worker-1`;
  const oldWorkerRoot = path.join(root, oldWorkerId);
  g1.seed(oldWorkerRoot, oldWorkerId);
  const markerPath = path.join(oldWorkerRoot, ".inner-worker-owner.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  // Mark old worker as started with a non-existent PID (dead old worker)
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, phase: "started", pid: 999999 }));
  const nowMs = Date.now();
  const zombieKey = sha256("cold-zombie-37d");
  const recentKey = sha256("cold-recent-1h");
  fs.writeFileSync(path.join(oldWorkerRoot, "codex-model-operation-state.json"), JSON.stringify({
    schemaVersion: 1,
    entries: [
      [zombieKey, { phase: "unresolved", acceptance: "accepted", reason: "previous_proxy_interrupted", updatedAt: nowMs - 37 * 86400_000, threadHash: sha256("old-t"), requiresReconciliation: true }],
      [recentKey, { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: nowMs - 3600_000, threadHash: sha256("recent-t"), requiresReconciliation: true }],
    ],
  }));
  g1.release();

  const newSessionId = crypto.randomUUID();
  const g2 = acquireInnerColdStart({ ...binding, sessionId: newSessionId });
  guards.push(g2);
  assert.equal(g2.status.protectedOperations, 1, "real acquireInnerColdStart must drop 37-day zombie");
  const newWorkerId = `${newSessionId}-worker-1`;
  const newWorkerRoot = path.join(root, newWorkerId);
  g2.seed(newWorkerRoot, newWorkerId);
  const seeded = JSON.parse(fs.readFileSync(path.join(newWorkerRoot, "codex-model-operation-state.json"), "utf8"));
  assert.equal(seeded.entries.length, 1);
  assert.equal(seeded.entries[0][0], recentKey);

  // 10b: Real createCodexModelStreamProxy.start() persists read-pruned ledger immediately to disk callback
  const diskSnapshots = [];
  const proxyEvents = [];
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: "http://127.0.0.1:9",
    managedRecovery: true,
    operationState: {
      schemaVersion: 1,
      entries: [
        [zombieKey, { phase: "unresolved", acceptance: "accepted", reason: "previous_proxy_interrupted", updatedAt: nowMs - 37 * 86400_000, threadHash: sha256("old-t"), requiresReconciliation: true }],
        [recentKey, { phase: "unresolved", acceptance: "accepted", reason: "WS_CONNECTION_CLOSED", updatedAt: nowMs - 3600_000, threadHash: sha256("recent-t"), requiresReconciliation: true }],
      ],
    },
    onOperationStateChange: s => diskSnapshots.push(s),
    onEvent: ev => proxyEvents.push(ev),
  });
  await proxy.start();
  try {
    assert.equal(diskSnapshots.length, 1, "proxy.start() must persist pruned ledger immediately");
    assert.equal(diskSnapshots[0].entries.length, 1);
    assert.equal(diskSnapshots[0].entries[0][0], recentKey);
    assert.equal(proxyEvents.some(e => e.type === "operation_ledger_startup_pruned_persisted"), true);
  } finally {
    await proxy.stop();
  }
});
