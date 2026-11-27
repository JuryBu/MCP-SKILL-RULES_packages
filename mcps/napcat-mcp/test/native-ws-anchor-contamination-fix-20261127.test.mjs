import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { attachNativeResponsesBridge, attachNativeResponsesRelay } from "../src/native-responses-ws-bridge.mjs";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { createRootAdmissionState } from "../src/root-admission-state.mjs";
import { createStreamRecovery } from "../src/codex-stream-recovery.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import * as coordinatorModule from "../src/inner-proxy-coordinator.mjs";
import { inspectJsonBodySource } from "../src/source-json-inspection.mjs";
import { createSourceInputProof } from "../src/source-input-proof.mjs";
import { createSourceRequestBodyOwner } from "../src/request-body-source.mjs";

const { WebSocket, WebSocketServer } = createRequire(import.meta.url)("ws");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identity = (turn, thread = "fix-anchor-thread") => ({ thread_id: thread, turn_id: turn, request_kind: "turn" });
const makePacket = (turn, input, previous, thread = "fix-anchor-thread") => ({
  type: "response.create",
  model: "gpt-6.2-sol",
  input,
  ...(previous ? { previous_response_id: previous } : {}),
  client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity(turn, thread)) },
});

async function until(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("ANCHOR_FIX_TEST_TIMEOUT");
    await delay(5);
  }
}

function validateUpstreamInputOrphans(input) {
  const seenCalls = new Set();
  for (const item of input ?? []) {
    if ((item?.type === "custom_tool_call" || item?.type === "function_call") && typeof item.call_id === "string") {
      seenCalls.add(item.call_id);
    }
    if ((item?.type === "custom_tool_call_output" || item?.type === "function_call_output") && typeof item.call_id === "string") {
      if (!seenCalls.has(item.call_id)) {
        return {
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            param: "input",
            message: `No tool call found for ${item.type === "custom_tool_call_output" ? "custom tool call output" : "function call output"} with call_id ${item.call_id}.`,
          },
        };
      }
    }
  }
  return null;
}

async function createBridgeFixture(context, { respond, responseTimeoutMs = 150, onRequestStart, onRequestEnd, onToolDone, executeHttpAttempt, prepareBodySource, managedRetryBaseMs = 10, onRecoveryState } = {}) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const upstreamCalls = [];
  const upstreamSockets = [];
  const bridgeEvents = [];

  upstream.on("connection", socket => {
    upstreamSockets.push(socket);
    socket.on("message", raw => {
      const payload = JSON.parse(raw.toString("utf8"));
      upstreamCalls.push(payload);
      const send = ev => socket.send(JSON.stringify(ev));
      if (!payload.previous_response_id) {
        const orphan = validateUpstreamInputOrphans(payload.input);
        if (orphan) {
          send(orphan);
          return;
        }
      }
      respond({ socket, payload, calls: upstreamCalls, send });
    });
  });

  const transport = createIncrementalResponsesTransport({ responseTimeoutMs });
  const server = http.createServer();
  const bridge = attachNativeResponsesBridge({
    server,
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}/v1/responses`,
    createRequestClient: opts => transport.createRequestClient(opts),
    getOperation: id => transport.getOperation(id),
    releaseSession: key => transport.invalidate(key, "test_end"),
    onEvent: ev => bridgeEvents.push(ev),
    onRequestStart: onRequestStart ?? (({ metadata }) => ({ key: `${metadata.thread_id}\0${metadata.turn_id}` })),
    onRequestEnd: onRequestEnd ?? (() => {}),
    onToolDone: onToolDone ?? (() => true),
    executeHttpAttempt,
    prepareBodySource,
    managedRecovery: true,
    managedRetryBaseMs,
    onRecoveryState,
    nativeWsRetryOptions: { delayMs: 10, slowDelayMs: 5 },
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

  const peers = [];
  const connect = async (url = `ws://127.0.0.1:${server.address().port}/v1/responses`) => {
    const peer = new WebSocket(url);
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
    assert.equal(transport.status().sessions, 0);
  });

  return { server, bridge, transport, upstream, upstreamCalls, upstreamSockets, bridgeEvents, connect };
}

test("Case 1: WS_TERMINAL_TIMEOUT after delivered custom_tool_call invalidates anchor, blocks same-turn replay, and heals via previous_response_not_found + full reconnect", async context => {
  const toolItem = { type: "custom_tool_call", id: "ctc_1", status: "completed", call_id: "call_case_1", name: "exec", input: "echo 1" };
  let blockTurn1 = false;
  let replayBlockedCount = 0;

  const state = await createBridgeFixture(context, {
    responseTimeoutMs: 120,
    onRequestStart: ({ metadata, operationId }) => {
      if (blockTurn1 && metadata.turn_id === "turn-1") {
        replayBlockedCount += 1;
        const err = Object.assign(new Error("MODEL_OPERATION_REPLAY_BLOCKED"), { code: "MODEL_OPERATION_REPLAY_BLOCKED" });
        Object.defineProperty(err, "nativeRequestValidation", {
          value: { kind: "turn", threadId: metadata.thread_id, turnId: metadata.turn_id, operationId },
        });
        throw err;
      }
      return { key: `${metadata.thread_id}\0${metadata.turn_id}` };
    },
    onRequestEnd: ({ deliveredExecutableToolDone, kind }) => {
      if (deliveredExecutableToolDone && kind === "failed") blockTurn1 = true;
    },
    respond: ({ calls, send }) => {
      const n = calls.length;
      if (n === 1) {
        send({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } });
        send({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
        return;
      }
      if (n === 2) {
        send({ type: "response.created", response: { id: "resp_2", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_2", output_index: 0, item: toolItem });
        // Hang -> WS_TERMINAL_TIMEOUT
        return;
      }
      const id = `resp_${n}`;
      send({ type: "response.created", response: { id, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id, status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  const baseUser = { type: "message", role: "user", content: [{ type: "input_text", text: "init" }] };
  const turn1User = { type: "message", role: "user", content: [{ type: "input_text", text: "run tool" }] };
  const toolOut = { type: "custom_tool_call_output", call_id: "call_case_1", output: "tool ok" };

  // 1) Baseline turn
  c1.peer.send(JSON.stringify(makePacket("turn-0", [baseUser])));
  await until(() => c1.seen.some(e => e.type === "response.completed" && e.response.id === "resp_1"));

  // 2) Turn-1 delivers tool then times out (pending=true)
  c1.peer.send(JSON.stringify(makePacket("turn-1", [turn1User], "resp_1")));
  await until(() => c1.seen.filter(e => e.type === "response.completed").length === 2);
  const timeoutTerm = c1.seen.filter(e => e.type === "response.completed")[1];
  assert.equal(c1.closed, false, "Worker must not proactively close peer after finishNotice");
  assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true));

  // 3) Same turn-1 incremental with tool output -> blocked by ledger (does not resend upstream)
  c1.peer.send(JSON.stringify(makePacket("turn-1", [toolOut], timeoutTerm.response.id)));
  await until(() => c1.seen.filter(e => e.type === "response.completed").length === 3);
  const blockedTerm = c1.seen.filter(e => e.type === "response.completed")[2];
  assert.equal(replayBlockedCount, 1);
  assert.equal(state.upstreamCalls.length, 2, "Replay-blocked turn must not hit upstream");

  // 4) New turn-2 incremental on SAME WS -> anchor was invalidated, so worker returns standard previous_response_not_found (not_sent) + closes WS without ever sending orphan upstream
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }], blockedTerm.response.id)));
  await until(() => c1.closed);
  const errFrame = c1.seen.find(e => e.type === "error");
  assert.ok(errFrame, "Client must receive previous_response_not_found to trigger full reconnect");
  assert.equal(errFrame.status, 400);
  assert.equal(errFrame.error.code, "previous_response_not_found");
  assert.equal(errFrame.error.requestTransmissionState, "not_sent");
  assert.equal(errFrame.error.requestAccepted, false);
  assert.equal(state.upstreamCalls.length, 2, "No orphan packet may be sent to upstream");

  // 5) Client reconnects with intact full rollout (paired tool + tool_output) -> succeeds!
  const c2 = await state.connect();
  c2.peer.send(JSON.stringify(makePacket("turn-2", [
    baseUser, turn1User, toolItem, toolOut,
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ])));
  await until(() => c2.seen.some(e => e.type === "response.completed"));
  assert.equal(state.upstreamCalls.length, 3);
  assert.equal(c2.seen.some(e => e.type === "error"), false);
  assert.ok(state.upstreamCalls[2].input.some(i => i.type === "custom_tool_call" && i.call_id === "call_case_1"));
  assert.ok(state.upstreamCalls[2].input.some(i => i.type === "custom_tool_call_output" && i.call_id === "call_case_1"));
});

test("Case 2: WS_CONNECTION_CLOSED after delivered function_call invalidates anchor and never emits orphan output", async context => {
  const fnItem = { type: "function_call", id: "fc_2", status: "completed", call_id: "call_case_2", name: "do_work", arguments: "{}" };
  const state = await createBridgeFixture(context, {
    respond: ({ socket, calls, send }) => {
      const n = calls.length;
      if (n === 1) {
        send({ type: "response.created", response: { id: "resp_c2_1", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_c2_1", output_index: 0, item: fnItem });
        socket.close(1011, "upstream drop before terminal");
        return;
      }
      send({ type: "response.created", response: { id: `resp_c2_${n}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_c2_${n}`, status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  const term = c1.seen.at(-1);
  assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true));

  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "function_call_output", call_id: "call_case_2", output: "done" }], term.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(state.upstreamCalls.length, 1);
});

test("Case 3: Upstream HTTP 400 permanent invalid_request_error invalidates anchor and breaks deadlock on next valid turn", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ calls, send }) => {
      const n = calls.length;
      if (n === 1) {
        send({ type: "response.created", response: { id: "resp_c3_1", status: "in_progress", output: [] } });
        send({ type: "response.completed", response: { id: "resp_c3_1", status: "completed", output: [] } });
        return;
      }
      if (n === 2) {
        send({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", param: "input", message: "No tool call found for custom tool call output with call_id call_bad." },
        });
        return;
      }
      send({ type: "response.created", response: { id: `resp_c3_${n}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_c3_${n}`, status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-0", [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));

  // Turn-1 triggers upstream 400 permanent
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "bad" }] }], "resp_c3_1")));
  await until(() => c1.seen.filter(e => e.type === "response.completed").length === 2);
  const term400 = c1.seen.filter(e => e.type === "response.completed")[1];
  assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice" && e.httpStatus === 400 && e.anchorInvalidated === true));

  // Next incremental on same WS must NOT replay bad local anchor; must get previous_response_not_found
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }], term400.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(state.upstreamCalls.length, 2);

  // Reconnect with clean full input succeeds
  const c2 = await state.connect();
  c2.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "clean full" }] }])));
  await until(() => c2.seen.some(e => e.type === "response.completed"));
  assert.equal(state.upstreamCalls.length, 3);
  assert.equal(c2.seen.some(e => e.type === "error"), false);
});

test("Case 4: Local-anchor second consecutive failure invalidates anchor instead of snowballing", async context => {
  const state = await createBridgeFixture(context, {
    respond: ({ calls, send }) => {
      const n = calls.length;
      if (n <= 2) {
        send({ type: "response.created", response: { id: `resp_c4_${n}`, status: "in_progress", output: [] } });
        send({ type: "response.failed", response: { id: `resp_c4_${n}`, status: "failed", output: [], error: { code: "usage_limit_reached", message: "limit" } } });
        return;
      }
      send({ type: "response.created", response: { id: `resp_c4_${n}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_c4_${n}`, status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  // First quota failure keeps local anchor (no tools dropped, non-400)
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "one" }] }])));
  await until(() => c1.seen.filter(e => e.type === "response.completed").length === 1);
  const t1 = c1.seen.at(-1);

  // Second request uses localAnchor and fails again -> must invalidate local anchor!
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }], t1.response.id)));
  await until(() => c1.seen.filter(e => e.type === "response.completed").length === 2);
  const t2 = c1.seen.at(-1);
  assert.ok(state.bridgeEvents.some(e => e.anchorInvalidated === true));

  // Third incremental must receive previous_response_not_found instead of snowballing
  c1.peer.send(JSON.stringify(makePacket("turn-3", [{ type: "message", role: "user", content: [{ type: "input_text", text: "three" }] }], t2.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(state.upstreamCalls.length, 2);
});

test("Case 5: startCallbackFailed on full resend does not create a local anchor and keeps socket open until incremental mismatch", async context => {
  let block = true;
  const state = await createBridgeFixture(context, {
    onRequestStart: ({ metadata, operationId }) => {
      if (block) {
        const err = Object.assign(new Error("MODEL_OPERATION_REPLAY_BLOCKED"), { code: "MODEL_OPERATION_REPLAY_BLOCKED" });
        Object.defineProperty(err, "nativeRequestValidation", {
          value: { kind: "turn", threadId: metadata.thread_id, turnId: metadata.turn_id, operationId },
        });
        throw err;
      }
      return { key: `${metadata.thread_id}\0${metadata.turn_id}` };
    },
    respond: ({ calls, send }) => {
      send({ type: "response.created", response: { id: `resp_c5_${calls.length}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_c5_${calls.length}`, status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "full blocked" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  assert.equal(c1.closed, false);
  const t1 = c1.seen.at(-1);
  assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true));

  block = false;
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "next delta" }] }], t1.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(state.upstreamCalls.length, 0);
});

test("Case 6: verifiedStop (response.incomplete max_output_tokens) after delivered tool invalidates anchor", async context => {
  const toolItem = { type: "custom_tool_call", id: "ctc_6", status: "completed", call_id: "call_case_6", name: "exec", input: "echo 6" };
  const state = await createBridgeFixture(context, {
    respond: ({ calls, send }) => {
      if (calls.length === 1) {
        send({ type: "response.created", response: { id: "resp_c6_1", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_c6_1", output_index: 0, item: toolItem });
        send({ type: "response.incomplete", response: { id: "resp_c6_1", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } });
        return;
      }
      send({ type: "response.created", response: { id: `resp_c6_${calls.length}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_c6_${calls.length}`, status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  const term = c1.seen.at(-1);
  assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_confirmed_incomplete" && e.anchorInvalidated === true));

  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "custom_tool_call_output", call_id: "call_case_6", output: "ok" }], term.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(state.upstreamCalls.length, 1);
});

test("Case 7: Large sourceDocument path releases source anchor cleanly after tool+disconnect without orphan combineRootInputs", async context => {
  const toolItem = { type: "custom_tool_call", id: "ctc_7", status: "completed", call_id: "call_case_7", name: "exec", input: "echo 7" };
  let sourceReleases = 0;
  let httpAttempts = 0;

  const state = await createBridgeFixture(context, {
    respond: () => { throw new Error("Expected sourceDocument HTTP fallback path"); },
    prepareBodySource: async ({ source, signal }) => {
      const inspected = await inspectJsonBodySource(source, "identity", { signal });
      const payload = await inspected.document.topLevelSmall({ fields: ["type", "model", "generate", "previous_response_id", "client_metadata", "compaction_trigger"] });
      payload.input = Object.freeze({});
      const sourceProof = await createSourceInputProof({
        model: payload.model,
        previousResponseId: payload.previous_response_id,
        records: opts => inspected.document.inputRecords(opts),
        signal,
      });
      sourceProof.register(payload);
      return {
        sourceBased: true,
        inspected: { ...inspected, payload, sourceProof, sourceDocument: inspected.document },
        lease: { release() {} },
        requestBody: createSourceRequestBodyOwner(source, {
          retainUntilReleased: true,
          onRelease: async () => { sourceReleases += 1; await inspected.document.release(); },
        }),
      };
    },
    executeHttpAttempt: async ({ downstream }) => {
      httpAttempts += 1;
      downstream.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_src_1", status: "in_progress", output: [] } })}\n\n`);
      downstream.write(`data: ${JSON.stringify({ type: "response.output_item.done", response_id: "resp_src_1", output_index: 0, item: toolItem })}\n\n`);
      // Simulate premature stream failure -> unresolved HTTP output (requiresReconciliation=true)
      return {
        kind: "failed",
        reason: "UPSTREAM_STREAM_ENDED",
        requestTransmissionState: "response_received",
        progressObserved: true,
        deliveredExecutableToolDone: true,
        policy: { category: "temporary", acceptance: "accepted", retryable: false },
      };
    },
  });

  // Connect with a large frame (> default threshold isn't needed if prepareBodySource forces sourceBased on >maxPayload; use direct NATIVE_WS_BODY_SOURCE via 128KiB payload with maxPayload=16KiB? No, bridge uses prepareBodySource whenever bodySource arrives; send >1MiB frame!)
  // Wait: NativeBodyWebSocket emits NATIVE_WS_BODY_SOURCE automatically for frames > BODY_SOURCE_MEMORY_BYTES (1 MiB)
  const bigText = "A".repeat(1100 * 1024);
  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: bigText }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  const term = c1.seen.at(-1);
  assert.equal(httpAttempts, 1);
  assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true));

  // Next incremental on same WS must fail cleanly with previous_response_not_found instead of combineRootInputs orphan HTTP
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "custom_tool_call_output", call_id: "call_case_7", output: "ok" }], term.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(httpAttempts, 1, "Source anchor was invalidated; no orphan HTTP fallback attempted");
  await until(() => sourceReleases >= 1);
});

test("Case 8: Dual-hop NEW Relay <-> NEW Worker emits ONLY 400 previous_response_not_found (ZERO 503 NATIVE_WS_WORKER_CLOSED) and recovers on reconnect", async context => {
  const toolItem = { type: "custom_tool_call", id: "ctc_8", status: "completed", call_id: "call_case_8", name: "exec", input: "echo 8" };
  const worker = await createBridgeFixture(context, {
    responseTimeoutMs: 120,
    respond: ({ calls, send }) => {
      if (calls.length === 1) {
        send({ type: "response.created", response: { id: "resp_r8_1", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_r8_1", output_index: 0, item: toolItem });
        return; // timeout -> pending=true
      }
      send({ type: "response.created", response: { id: `resp_r8_${calls.length}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_r8_${calls.length}`, status: "completed", output: [] } });
    },
  });

  const relayEvents = [];
  const relayServer = http.createServer();
  const relay = attachNativeResponsesRelay({
    server: relayServer,
    onEvent: ev => relayEvents.push(ev),
    acquire: async () => ({
      url: `ws://127.0.0.1:${worker.server.address().port}/v1/responses`,
      finishOrdinaryFailure: (_recovery, terminal) => {
        if (terminal?.type === "error" && terminal.error?.requestTransmissionState === "not_sent") return null;
        return null;
      },
      release: () => {},
    }),
  });
  await new Promise(resolve => relayServer.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await relay.close();
    relayServer.closeAllConnections();
    await new Promise(resolve => relayServer.close(resolve));
  });

  const c1 = await worker.connect(`ws://127.0.0.1:${relayServer.address().port}/v1/responses`);
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "via relay" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  const term = c1.seen.at(-1);
  assert.equal(c1.closed, false);

  // Send incremental on same relay connection -> worker returns 400 previous_response_not_found + closes -> NEW relay must NOT append 503 NATIVE_WS_WORKER_CLOSED!
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "custom_tool_call_output", call_id: "call_case_8", output: "ok" }], term.response.id)));
  await until(() => c1.closed);
  const errorFrames = c1.seen.filter(e => e.type === "error");
  assert.equal(errorFrames.length, 1, `Expected exactly 1 error frame (400), got: ${JSON.stringify(errorFrames)}`);
  assert.equal(errorFrames[0].status, 400);
  assert.equal(errorFrames[0].error.code, "previous_response_not_found");
  assert.equal(errorFrames.some(e => e.error?.code === "NATIVE_WS_WORKER_CLOSED"), false);
  assert.equal(worker.upstreamCalls.length, 1);

  // Reconnect through relay with intact full history succeeds
  const c2 = await worker.connect(`ws://127.0.0.1:${relayServer.address().port}/v1/responses`);
  c2.peer.send(JSON.stringify(makePacket("turn-2", [
    { type: "message", role: "user", content: [{ type: "input_text", text: "via relay" }] },
    toolItem,
    { type: "custom_tool_call_output", call_id: "call_case_8", output: "ok" },
  ])));
  await until(() => c2.seen.some(e => e.type === "response.completed"));
  assert.equal(worker.upstreamCalls.length, 2);
  assert.equal(c2.seen.some(e => e.type === "error"), false);
});

test("Case 9: Dual-hop legacy Relay vs patched Relay full-frame collection until close", async context => {
  const liveOldBridgePath = process.env.NAPCAT_LEGACY_RELAY_BRIDGE_PATH;
  const { attachNativeResponsesRelay: targetAttachRelay } = liveOldBridgePath
    ? await import(pathToFileURL(liveOldBridgePath).href)
    : { attachNativeResponsesRelay };
  const toolItem = { type: "custom_tool_call", id: "ctc_9", status: "completed", call_id: "call_case_9", name: "exec", input: "echo 9" };

  const worker = await createBridgeFixture(context, {
    responseTimeoutMs: 120,
    respond: ({ calls, send }) => {
      if (calls.length === 1) {
        send({ type: "response.created", response: { id: "resp_r9_1", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_r9_1", output_index: 0, item: toolItem });
        return;
      }
      send({ type: "response.created", response: { id: `resp_r9_${calls.length}`, status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: `resp_r9_${calls.length}`, status: "completed", output: [] } });
    },
  });

  const relayServer = http.createServer();
  const relay = targetAttachRelay({
    server: relayServer,
    acquire: async () => ({
      url: `ws://127.0.0.1:${worker.server.address().port}/v1/responses`,
      finishOrdinaryFailure: () => null,
      release: () => {},
    }),
  });
  await new Promise(resolve => relayServer.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await relay.close();
    relayServer.closeAllConnections();
    await new Promise(resolve => relayServer.close(resolve));
  });

  const c1 = await worker.connect(`ws://127.0.0.1:${relayServer.address().port}/v1/responses`);
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "via relay" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  const term = c1.seen.at(-1);

  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "custom_tool_call_output", call_id: "call_case_9", output: "ok" }], term.response.id)));
  await until(() => c1.closed);
  const allErrors = c1.seen.filter(e => e.type === "error");
  assert.equal(allErrors[0]?.status, 400);
  assert.equal(allErrors[0]?.error?.code, "previous_response_not_found");
  if (liveOldBridgePath) {
    // Explicitly assert legacy relay's known 2-frame behavior (400 + trailing 503) so it is never masked
    assert.equal(allErrors.length, 2, `Legacy relay expected 2 frames [400, 503], got: ${JSON.stringify(allErrors)}`);
    assert.equal(allErrors[1]?.status, 503);
    assert.equal(allErrors[1]?.error?.code, "NATIVE_WS_WORKER_CLOSED");
  } else {
    assert.equal(allErrors.length, 1, `Patched relay must emit strictly 1 error frame (400), got: ${JSON.stringify(allErrors)}`);
  }
  assert.equal(worker.upstreamCalls.length, 1, "Zero orphan upstream packet sent");

  const c2 = await worker.connect(`ws://127.0.0.1:${relayServer.address().port}/v1/responses`);
  c2.peer.send(JSON.stringify(makePacket("turn-2", [
    { type: "message", role: "user", content: [{ type: "input_text", text: "via relay" }] },
    toolItem,
    { type: "custom_tool_call_output", call_id: "call_case_9", output: "ok" },
  ])));
  await until(() => c2.seen.some(e => e.type === "response.completed"));
  assert.equal(worker.upstreamCalls.length, 2);
});

test("Case 10: root-admission-state never anchors permanent 400 rejection and sweeps same-turn consumed anchors on completion", async () => {
  const pin = { pid: 1, generation: 1 };
  const threadState = { threadId: "root-t1", turnId: "turn-1", phase: "active", start: { connectionGeneration: 1 }, activeHttp: 0, nativeRelays: 0, completion: null };
  const root = createRootAdmissionState({
    getThread: id => id === "root-t1" ? threadState : null,
    getNativeIdentity: () => pin,
    isNativeIdentityCurrent: p => p === pin,
    isClosing: () => false,
    hasNativeIdentity: () => true,
  });

  root.observeStart(threadState, threadState.start, "native_notification", pin);
  const payload1 = makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "bad" }] }], undefined, "root-t1");
  const job1 = root.begin({ thread_id: "root-t1", turn_id: "turn-1", request_kind: "turn" }, { requestPath: "/v1/responses", payload: payload1 });
  await root.ready(job1);
  root.beforeWorkerWrite(job1);
  const res400 = root.finishForwarded(job1, createStreamRecovery("root_test_400"), payload1, {
    type: "error",
    status: 400,
    error: { type: "invalid_request_error", param: "input", message: "No tool call found..." },
  });
  assert.ok(res400);
  assert.equal(res400.anchored, false, "Permanent 400 must never be anchored in root state");
  assert.equal(res400.closeModelConnection, true);
  assert.equal(root.status().anchors, 0);

  // Test same-turn anchor consumption + completion cleanup
  const job2 = root.begin({ thread_id: "root-t1", turn_id: "turn-1", request_kind: "turn" }, { requestPath: "/v1/responses", payload: payload1 });
  await root.ready(job2);
  root.beforeWorkerWrite(job2);
  const resTemp = root.finishForwarded(job2, createStreamRecovery("root_test_temp"), payload1, undefined);
  assert.equal(resTemp.anchored, true);
  assert.equal(root.status().anchors, 1);
  const anchorId = resTemp.events.find(e => e.type === "response.completed").response.id;

  // Same turn consumes the anchor via previous_response_id and then completes
  const payloadFollow = makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "follow" }] }], anchorId, "root-t1");
  const job3 = root.begin({ thread_id: "root-t1", turn_id: "turn-1", request_kind: "turn" }, { requestPath: "/v1/responses", payload: payloadFollow });
  await root.ready(job3);
  await root.preparePayload(job3, payloadFollow);
  root.beforeWorkerWrite(job3);
  const compEvent = { threadId: "root-t1", turnId: "turn-1", status: "completed" };
  threadState.completion = compEvent;
  root.observeTerminal(threadState, compEvent);
  assert.equal(root.status().anchors, 0, "Consumed same-turn anchor must be swept after turn completes");
  await root.close();
});

test("Case 11: Normal completed tool call + incremental tool_output stays single-connection incremental with zero regression", async context => {
  const toolItem = { type: "custom_tool_call", id: "ctc_11", status: "completed", call_id: "call_case_11", name: "exec", input: "echo 11" };
  const state = await createBridgeFixture(context, {
    respond: ({ calls, send }) => {
      const n = calls.length;
      if (n === 1) {
        send({ type: "response.created", response: { id: "resp_ok_1", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_ok_1", output_index: 0, item: toolItem });
        send({ type: "response.completed", response: { id: "resp_ok_1", status: "completed", output: [toolItem] } });
        return;
      }
      send({ type: "response.created", response: { id: "resp_ok_2", status: "in_progress", output: [] } });
      send({ type: "response.completed", response: { id: "resp_ok_2", status: "completed", output: [] } });
    },
  });

  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "run ok" }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed" && e.response.id === "resp_ok_1"));

  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "custom_tool_call_output", call_id: "call_case_11", output: "ok" }], "resp_ok_1")));
  await until(() => c1.seen.some(e => e.type === "response.completed" && e.response.id === "resp_ok_2"));
  assert.equal(state.upstreamSockets.length, 1, "Normal tool round-trip must stay on single upstream WS");
  assert.equal(state.upstreamCalls[1].previous_response_id, "resp_ok_1");
  assert.equal(c1.closed, false);
});

test("Case 12: Large >1MiB sourceDocument path tracks localAnchorUsed before payload rewrite and stops consecutive snowball", async context => {
  let sourceReleases = 0;
  let httpAttempts = 0;
  const state = await createBridgeFixture(context, {
    respond: () => { throw new Error("Expected sourceDocument HTTP path"); },
    prepareBodySource: async ({ source, signal }) => {
      const inspected = await inspectJsonBodySource(source, "identity", { signal });
      const payload = await inspected.document.topLevelSmall({ fields: ["type", "model", "generate", "previous_response_id", "client_metadata", "compaction_trigger"] });
      payload.input = Object.freeze({});
      const sourceProof = await createSourceInputProof({
        model: payload.model,
        previousResponseId: payload.previous_response_id,
        records: opts => inspected.document.inputRecords(opts),
        signal,
      });
      sourceProof.register(payload);
      return {
        sourceBased: true,
        inspected: { ...inspected, payload, sourceProof, sourceDocument: inspected.document },
        lease: { release() {} },
        requestBody: createSourceRequestBodyOwner(source, {
          retainUntilReleased: true,
          onRelease: async () => { sourceReleases += 1; await inspected.document.release(); },
        }),
      };
    },
    executeHttpAttempt: async () => {
      httpAttempts += 1;
      return {
        kind: "usage_limit",
        reason: "usage_limit_reached",
        httpStatus: 429,
        requestTransmissionState: "response_received",
        policy: { category: "quota", acceptance: "accepted", retryable: false },
      };
    },
  });

  const bigText = "B".repeat(1100 * 1024);
  const c1 = await state.connect();
  c1.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: bigText }] }])));
  await until(() => c1.seen.some(e => e.type === "response.completed"));
  const term1 = c1.seen.at(-1);
  assert.equal(httpAttempts, 1);

  // Second consecutive failure using local sourceAnchor MUST invalidate anchor
  c1.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "second try" }] }], term1.response.id)));
  await until(() => c1.seen.filter(e => e.type === "response.completed").length === 2);
  const term2 = c1.seen.at(-1);
  assert.equal(httpAttempts, 2);
  const notices = state.bridgeEvents.filter(e => e.type === "native_ws_quota_stopped" || e.type === "native_ws_terminal_notice");
  assert.equal(notices.at(-1)?.anchorInvalidated, true, "Second failure on local sourceAnchor MUST invalidate anchor");

  // Third incremental must hit previous_response_not_found locally without snowballing to a 3rd HTTP attempt
  c1.peer.send(JSON.stringify(makePacket("turn-3", [{ type: "message", role: "user", content: [{ type: "input_text", text: "third try" }] }], term2.response.id)));
  await until(() => c1.closed);
  assert.equal(c1.seen.at(-1).error.code, "previous_response_not_found");
  assert.equal(httpAttempts, 2, "Zero snowball to turn 3 on large sourceDocument path");
  await until(() => sourceReleases >= 2);
});

test("Case 13: HTTP 200 SSE invalid_request_error (real stream proxy httpFallback), bare WS invalid_request, and 400 previous_response_not_found all invalidate anchor on first failure", async context => {
  // Subcase A: real createCodexModelStreamProxy HTTP 200 SSE invalid_request_error (param=input) via httpFallback (> maxMessageBytes)
  let upstreamHttpHits = 0;
  const fakeUpstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      upstreamHttpHits += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", param: "input", message: "No tool call found for custom tool call output" } })}\n\n`);
    });
  });
  await new Promise(resolve => fakeUpstream.listen(0, "127.0.0.1", resolve));
  const transport13 = createIncrementalResponsesTransport({ maxMessageBytes: 16384, maxSessionBytes: 32 * 1024 * 1024 });
  const proxyEvents = [];
  const proxy = createCodexModelStreamProxy({
    upstreamOrigin: `http://127.0.0.1:${fakeUpstream.address().port}`,
    port: 0,
    nativeWebSocketEnabled: true,
    incrementalTransport: transport13,
    incrementalUpstreamUrl: `ws://127.0.0.1:${fakeUpstream.address().port}/v1/responses`,
    managedRecovery: true,
    managedRetryBaseMs: 10,
    internalMemoryStatePath: null,
    firstProgressTimeoutMs: 1000,
    progressIdleTimeoutMs: 1000,
    onEvent: ev => proxyEvents.push(ev),
  });
  const endpoint = await proxy.start();
  const cHttp = new WebSocket(`ws://127.0.0.1:${endpoint.port}/v1/responses`, {
    headers: { authorization: "Bearer local-test-only", "chatgpt-account-id": "local-account" },
  });
  const seenHttp = [];
  let closedHttp = false;
  cHttp.on("error", () => {});
  cHttp.on("message", d => seenHttp.push(JSON.parse(d.toString())));
  cHttp.on("close", () => { closedHttp = true; });
  context.after(async () => {
    cHttp.terminate();
    await proxy.stop();
    transport13.close();
    fakeUpstream.closeAllConnections();
    await new Promise(resolve => fakeUpstream.close(resolve));
  });

  await once(cHttp, "open");
  // > 16384 B triggers real native-ws -> executeHttpAttempt fallback inside createCodexModelStreamProxy
  cHttp.send(JSON.stringify(makePacket("turn-http-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "X".repeat(24000) }] }], undefined, "thread-c13")));
  await until(() => seenHttp.some(e => e.type === "response.completed"));
  const termHttp = seenHttp.at(-1);
  assert.equal(upstreamHttpHits, 1);
  assert.ok(proxyEvents.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true), "HTTP 200 SSE invalid_request_error must set anchorInvalidated=true");
  cHttp.send(JSON.stringify(makePacket("turn-http-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] }], termHttp.response.id, "thread-c13")));
  await until(() => closedHttp);
  assert.equal(seenHttp.at(-1).error.code, "previous_response_not_found");
  assert.equal(upstreamHttpHits, 1, "HTTP 200 SSE invalid_request_error must invalidate anchor immediately");

  // Subcase B: bare WS invalid_request (no status/type/param) & temporary-classified 400 previous_response_not_found reaching finishNotice
  for (const spec of [
    { emitProgress: false, frame: { type: "error", error: { code: "invalid_request", message: "Malformed input item" } } },
    { emitProgress: true, frame: { type: "error", status: 400, error: { type: "invalid_request_error", code: "previous_response_not_found", param: "previous_response_id", message: "Previous response not found" } } },
  ]) {
    const state = await createBridgeFixture(context, {
      respond: ({ send }) => {
        if (spec.emitProgress) {
          send({ type: "response.created", response: { id: "resp_prev_nf_13", status: "in_progress", output: [] } });
          send({ type: "response.output_text.delta", response_id: "resp_prev_nf_13", output_index: 0, content_index: 0, delta: "partial" });
        }
        send(spec.frame);
      },
    });
    const c = await state.connect();
    c.peer.send(JSON.stringify(makePacket("turn-b1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }])));
    await until(() => c.seen.some(e => e.type === "response.completed"));
    const t = c.seen.at(-1);
    assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true));
    c.peer.send(JSON.stringify(makePacket("turn-b2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "follow" }] }], t.response.id)));
    await until(() => c.closed);
    assert.equal(c.seen.at(-1).error.code, "previous_response_not_found");
    assert.equal(state.upstreamCalls.length, 1);
  }
});

test("Case 14: root-admission-state rejects status_code 400, http_status 422, err.code invalid_request_error/previous_response_not_found while preserving context_length_exceeded", async () => {
  const pin = { pid: 1, generation: 1 };
  const threadState = { threadId: "root-c14", turnId: "turn-1", phase: "active", start: { connectionGeneration: 1 }, activeHttp: 0, nativeRelays: 0, completion: null };
  const root = createRootAdmissionState({
    getThread: id => id === "root-c14" ? threadState : null,
    getNativeIdentity: () => pin,
    isNativeIdentityCurrent: p => p === pin,
    isClosing: () => false,
    hasNativeIdentity: () => true,
  });
  root.observeStart(threadState, threadState.start, "native_notification", pin);
  const payload = makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "check" }] }], undefined, "root-c14");

  const rejectingEvents = [
    { type: "error", status_code: 400, error: { message: "bad input" } },
    { type: "error", http_status: 422, error: { message: "unprocessable" } },
    { type: "response.failed", response: { error: { code: "invalid_request_error", message: "bad" } } },
    { type: "error", error: { code: "invalid_request", message: "bad" } },
    { type: "error", error: { code: "previous_response_not_found", message: "missing" } },
  ];
  for (let i = 0; i < rejectingEvents.length; i += 1) {
    const job = root.begin({ thread_id: "root-c14", turn_id: "turn-1", request_kind: "turn" }, { requestPath: "/v1/responses", payload });
    await root.ready(job);
    root.beforeWorkerWrite(job);
    const res = root.finishForwarded(job, createStreamRecovery(`root_c14_${i}`), payload, rejectingEvents[i]);
    assert.equal(res.anchored, false, `Event #${i} must NOT be anchored`);
    assert.equal(res.closeModelConnection, true);
  }
  assert.equal(root.status().anchors, 0);
  assert.equal(root.status().anchorFixVersion, 1);

  // context_length_exceeded must remain exempted
  const jobCtx = root.begin({ thread_id: "root-c14", turn_id: "turn-1", request_kind: "turn" }, { requestPath: "/v1/responses", payload });
  await root.ready(jobCtx);
  root.beforeWorkerWrite(jobCtx);
  const resCtx = root.finishForwarded(jobCtx, createStreamRecovery("root_c14_ctx"), payload, {
    type: "error", status: 400, error: { type: "invalid_request_error", code: "context_length_exceeded", message: "too long" },
  });
  assert.equal(resCtx.anchored, true, "context_length_exceeded remains exempted");
  await root.close();
});

test("Case 15: waitingNative interrupt, httpFallback interruptHttp (tool vs text), acknowledgedInterrupt missing delivered tool, and pending half-streamed tool all guard anchors", async context => {
  const toolItem = { type: "custom_tool_call", id: "ctc_15", status: "completed", call_id: "call_case_15", name: "exec", input: "echo 15" };

  // Subcase A: acknowledgedInterrupt where upstream omits an already-delivered tool item MUST invalidate anchor
  {
    let createCalls = 0;
    const state = await createBridgeFixture(context, {
      respond: ({ send, payload }) => {
        if (payload.type === "response.interrupt") {
          send({ type: "response.incomplete", response: { id: "resp_ack_15", status: "incomplete", incomplete_details: { reason: "interrupted" }, output: [] } });
          return;
        }
        createCalls += 1;
        send({ type: "response.created", response: { id: "resp_ack_15", status: "in_progress", output: [] } });
        send({ type: "response.output_item.done", response_id: "resp_ack_15", output_index: 0, item: toolItem });
      },
    });
    const c = await state.connect();
    c.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }])));
    await until(() => c.seen.some(e => e.type === "response.output_item.done"));
    c.peer.send(JSON.stringify({ type: "response.interrupt", response_id: "resp_ack_15", mode: "discard_partial_items" }));
    await until(() => c.seen.some(e => e.type === "response.incomplete"));
    c.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "custom_tool_call_output", call_id: "call_case_15", output: "ok" }], "resp_ack_15")));
    await until(() => c.closed);
    assert.equal(c.seen.at(-1).error.code, "previous_response_not_found");
    assert.equal(createCalls, 1);
  }

  // Subcase B: timeout/disconnect after bridge receives unfinished half-streamed tool item (output_item.added without done) invalidates anchor
  {
    const serverHalf = http.createServer();
    const eventsHalf = [];
    let reqCalls = 0;
    const bridgeHalf = attachNativeResponsesBridge({
      server: serverHalf,
      onEvent: ev => eventsHalf.push(ev),
      onRequestStart: ({ metadata }) => ({ key: `${metadata.thread_id}\0${metadata.turn_id}` }),
      onRequestEnd: () => {},
      onToolDone: () => true,
      getOperation: () => ({ requestTransmissionState: "response_received", acceptance: true, requiresReconciliation: true, canRetry: false }),
      managedRecovery: true,
      managedRetryBaseMs: 10,
      createRequestClient: () => ({
        request() {
          reqCalls += 1;
          const req = new PassThrough();
          req.once("finish", () => {
            const res = new PassThrough();
            req.emit("response", res);
            res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_half_15", status: "in_progress", output: [] } })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: "response.output_item.added", response_id: "resp_half_15", output_index: 0, item: { type: "function_call", id: "fc_half_15", call_id: "call_half_15", name: "exec", arguments: "" } })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", response_id: "resp_half_15", item_id: "fc_half_15", output_index: 0, delta: "{\"cmd\":\"echo" })}\n\n`);
            setTimeout(() => res.destroy(Object.assign(new Error("WS_TERMINAL_TIMEOUT"), { code: "WS_TERMINAL_TIMEOUT" })), 30);
          });
          return req;
        },
      }),
    });
    await new Promise(resolve => serverHalf.listen(0, "127.0.0.1", resolve));
    const peerHalf = new WebSocket(`ws://127.0.0.1:${serverHalf.address().port}/v1/responses`);
    const seenHalf = [];
    let closedHalf = false;
    peerHalf.on("error", () => {});
    peerHalf.on("message", d => seenHalf.push(JSON.parse(d.toString())));
    peerHalf.on("close", () => { closedHalf = true; });
    context.after(async () => {
      peerHalf.terminate();
      await bridgeHalf.close();
      serverHalf.closeAllConnections();
      await new Promise(r => serverHalf.close(r));
    });
    await once(peerHalf, "open");
    peerHalf.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "half" }] }])));
    await until(() => seenHalf.some(e => e.type === "response.completed"));
    const t = seenHalf.at(-1);
    assert.ok(eventsHalf.some(e => e.type === "native_ws_terminal_notice" && e.anchorInvalidated === true && e.partialToolItems === 1));
    peerHalf.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "after half" }] }], t.response.id)));
    await until(() => closedHalf);
    assert.equal(seenHalf.at(-1).error.code, "previous_response_not_found");
    assert.equal(reqCalls, 1);
  }

  // Subcase C: httpFallback interruptHttp (tool delivered -> invalidates anchor; text-only -> preserves healthy anchor)
  {
    for (const withTool of [true, false]) {
      let httpCalls = 0;
      const serverH = http.createServer();
      const eventsH = [];
      const transportH = createIncrementalResponsesTransport({ maxMessageBytes: 16384, maxSessionBytes: 32 * 1024 * 1024 });
      const bridgeH = attachNativeResponsesBridge({
        server: serverH,
        upstreamUrl: "ws://127.0.0.1:1/v1/responses",
        createRequestClient: opts => transportH.createRequestClient(opts),
        getOperation: id => transportH.getOperation(id),
        releaseSession: k => transportH.invalidate(k, "test_end"),
        onEvent: ev => eventsH.push(ev),
        onRequestStart: ({ metadata }) => ({ key: `${metadata.thread_id}\0${metadata.turn_id}` }),
        onRequestEnd: () => {},
        onToolDone: () => true,
        managedRecovery: true,
        managedRetryBaseMs: 10,
        executeHttpAttempt: async ({ downstream, signal }) => {
          httpCalls += 1;
          const respId = `resp_http_int_${withTool ? "tool" : "text"}_${httpCalls}`;
          downstream.write(`data: ${JSON.stringify({ type: "response.created", response: { id: respId, status: "in_progress", output: [] } })}\n\n`);
          if (httpCalls === 1) {
            if (withTool) {
              downstream.write(`data: ${JSON.stringify({ type: "response.output_item.done", response_id: respId, output_index: 0, item: toolItem })}\n\n`);
            } else {
              downstream.write(`data: ${JSON.stringify({ type: "response.output_text.delta", response_id: respId, output_index: 0, content_index: 0, delta: "hello" })}\n\n`);
            }
            await new Promise(resolve => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", resolve, { once: true });
            });
            return { kind: "cancelled" };
          }
          downstream.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: respId, status: "completed", output: [] } })}\n\n`);
          downstream.end();
          return { kind: "completed" };
        },
      });
      await new Promise(resolve => serverH.listen(0, "127.0.0.1", resolve));
      const peer = new WebSocket(`ws://127.0.0.1:${serverH.address().port}/v1/responses`);
      const seen = [];
      let closed = false;
      peer.on("error", () => {});
      peer.on("message", d => seen.push(JSON.parse(d.toString())));
      peer.on("close", () => { closed = true; });
      context.after(async () => {
        peer.terminate();
        await bridgeH.close();
        transportH.close();
        serverH.closeAllConnections();
        await new Promise(r => serverH.close(r));
      });
      await once(peer, "open");
      peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "Z".repeat(24000) }] }], undefined, `thread-c15-${withTool}`)));
      await until(() => seen.some(e => e.type === (withTool ? "response.output_item.done" : "response.output_text.delta")));
      const httpRespId = seen.find(e => e.type === "response.created").response.id;
      peer.send(JSON.stringify({ type: "response.interrupt", response_id: httpRespId, mode: "discard_partial_items" }));
      await until(() => seen.some(e => e.type === "response.incomplete"));
      const intEvent = eventsH.find(e => e.type === "native_http_interrupted");
      assert.ok(intEvent);
      if (withTool) {
        assert.equal(intEvent.anchorInvalidated, true);
        peer.send(JSON.stringify(makePacket("turn-2", [{ type: "custom_tool_call_output", call_id: "call_case_15", output: "ok" }], httpRespId, `thread-c15-${withTool}`)));
        await until(() => closed);
        assert.equal(seen.at(-1).error.code, "previous_response_not_found");
        assert.equal(httpCalls, 1);
      } else {
        assert.equal(intEvent.anchorInvalidated, undefined, "Text-only HTTP interrupt preserves healthy local anchor");
        peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "W".repeat(24000) }] }], httpRespId, `thread-c15-${withTool}`)));
        await until(() => seen.some(e => e.type === "response.completed"));
        assert.equal(httpCalls, 2);
      }
    }
  }

  // Subcase D: waitingNative interrupt while waiting in retry backoff after transient 503 cleanly settles and preserves healthy continuation without hanging
  {
    const recoveryEvents = [];
    const state = await createBridgeFixture(context, {
      managedRetryBaseMs: 400,
      onRecoveryState: ev => recoveryEvents.push(ev),
      respond: ({ send, calls }) => {
        if (calls.length === 1) {
          send({ type: "response.created", response: { id: "resp_wait_15", status: "in_progress", output: [] } });
          send({ type: "error", status: 503, error: { type: "server_error", code: "server_error", message: "try again later" } });
          return;
        }
        send({ type: "response.created", response: { id: "resp_wait_next", status: "in_progress", output: [] } });
        send({ type: "response.completed", response: { id: "resp_wait_next", status: "completed", output: [] } });
      },
    });
    const c = await state.connect();
    c.peer.send(JSON.stringify(makePacket("turn-1", [{ type: "message", role: "user", content: [{ type: "input_text", text: "wait" }] }])));
    await until(() => c.seen.some(e => e.type === "response.created"));
    const waitId = c.seen.find(e => e.type === "response.created").response.id;
    await until(() => recoveryEvents.some(e => e.phase === "waiting"));
    c.peer.send(JSON.stringify({ type: "response.interrupt", response_id: waitId, mode: "discard_partial_items" }));
    await until(() => c.seen.some(e => e.type === "response.incomplete"));
    assert.ok(state.bridgeEvents.some(e => e.type === "native_ws_interrupt" && e.accepted === true && e.reason === "waiting_interrupted"));
    const finalId = c.seen.find(e => e.type === "response.incomplete").response.id;
    c.peer.send(JSON.stringify(makePacket("turn-2", [{ type: "message", role: "user", content: [{ type: "input_text", text: "after wait" }] }], finalId)));
    await until(() => c.seen.some(e => e.type === "response.completed"));
    assert.equal(state.upstreamCalls.length, 2);
  }
});

test("Case 16: Patched Relay suppresses trailing 503 even if worker socket emits abrupt TCP reset/error after forwarding 400", async context => {
  const rawWorker = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(rawWorker, "listening");
  let workerSock = null;
  rawWorker.on("connection", ws => {
    workerSock = ws;
    ws.on("message", () => {
      ws.send(JSON.stringify({
        type: "error",
        status: 400,
        error: { type: "invalid_request_error", code: "previous_response_not_found", message: "must reconnect", requestAccepted: false, operationAcceptance: "not_sent", requestTransmissionState: "not_sent" },
      }));
    });
  });

  const relayServer = http.createServer();
  const relay = attachNativeResponsesRelay({
    server: relayServer,
    acquire: async () => ({
      url: `ws://127.0.0.1:${rawWorker.address().port}/v1/responses`,
      finishOrdinaryFailure: () => null,
      release: () => {},
    }),
  });
  await new Promise(resolve => relayServer.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await relay.close();
    relayServer.closeAllConnections();
    await new Promise(r => relayServer.close(r));
    for (const c of rawWorker.clients) c.terminate();
    await new Promise(r => rawWorker.close(r));
  });

  assert.equal(relay.anchorFixVersion, 1);
  assert.equal(relay.status().anchorFixVersion, 1);

  const client = new WebSocket(`ws://127.0.0.1:${relayServer.address().port}/v1/responses`);
  const seen = [];
  let closed = false;
  client.on("error", () => {});
  client.on("message", d => {
    const ev = JSON.parse(d.toString());
    seen.push(ev);
    // Immediately force abrupt TCP RST from worker socket right after Relay forwards 400!
    if (ev.type === "error" && ev.status === 400) {
      workerSock?._socket?.resetAndDestroy?.();
    }
  });
  client.on("close", () => { closed = true; });
  await once(client, "open");
  context.after(() => client.terminate());

  client.send(JSON.stringify(makePacket("turn-rst", [{ type: "message", role: "user", content: [{ type: "input_text", text: "rst" }] }], "resp_missing")));
  await until(() => closed);
  const errors = seen.filter(e => e.type === "error");
  assert.equal(errors.length, 1, `Expected strictly 1 error frame after abrupt RST, got: ${JSON.stringify(errors)}`);
  assert.equal(errors[0].status, 400);
  assert.equal(errors[0].error.code, "previous_response_not_found");
});

test("Case 17: Coordinator activation upgrades idle legacy Relay & Root to anchorFixVersion 1 without mutating state during prepare()", async context => {
  // Build a minimal coordinator-like state containing a simulated legacy Relay (no anchorFixVersion) and legacy Root (no anchorFixVersion)
  const server = http.createServer();
  let legacyClosed = false;
  const legacyUpgrade = (_req, socket) => socket.destroy();
  server.on("upgrade", legacyUpgrade);
  const legacyRelay = {
    status: () => ({ connections: 0, closed: legacyClosed }),
    async close() { legacyClosed = true; server.off("upgrade", legacyUpgrade); },
  };
  const legacyRoot = {
    sourcePayloadVersion: 1,
    status: () => ({ protocolVersion: 1, records: 0, jobs: 0, anchors: 0, anchorBytes: 0 }),
    close: async () => {},
  };
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const shared = {
    options: { port: server.address().port },
    ownerId: "test-owner",
    nativeSourceId: "test-source",
    root: process.cwd(),
    upstreamOrigin: "http://127.0.0.1:1",
    onEvent: () => {},
    environment: {},
    runtimeProfile: null,
    sessionId: "test-session",
    capability: "0".repeat(64),
    workers: new Map(),
    reclaimedWorkers: [],
    threads: new Map(),
    terminalThreads: new Map(),
    migrations: new Map(),
    pending: new Map(),
    adoptions: new Map(),
    requests: new Map(),
    activation: null,
    maxThreads: 16,
    defaultWorker: null,
    recycleRetiredWorkers: true,
    workerSequence: 0,
    requestSequence: 0,
    nativeSequence: 0,
    httpSequence: 0,
    generation: 0,
    transactionActive: false,
    starting: false,
    closing: false,
    nativeHealthy: true,
    preparationTask: null,
    workerMaintenance: false,
    relay: Promise.resolve(),
    server,
    implementation: null,
    implementationGeneration: 0,
    recentRejections: [],
    nativeResponsesRelay: legacyRelay,
    rootAdmissions: legacyRoot,
  };
  shared.dispatch = (method, ...args) => shared.implementation[method](...args);
  shared.bindDispatch = (method, ...bound) => (...args) => shared.dispatch(method, ...bound, ...args);

  // prepare phase: creating implementation must NOT mutate legacyRelay or legacyRoot
  context.after(async () => {
    try { await shared.nativeResponsesRelay?.close?.(); } catch {}
    try { await shared.rootAdmissions?.close?.(); } catch {}
    server.closeAllConnections();
    if (server.listening) await new Promise(r => server.close(r));
  });
  const impl = coordinatorModule.createInnerProxyCoordinatorImplementation(shared);
  assert.equal(shared.nativeResponsesRelay, legacyRelay, "prepare/construction must NOT replace Relay before activation");
  assert.equal(shared.rootAdmissions, legacyRoot, "prepare/construction must NOT replace Root before activation");
  assert.equal(legacyClosed, false);

  // activate phase with an ACTIVE thread: Root MUST NOT be replaced while a thread is active (preserves records!), even when jobs===0 && anchors===0
  shared.implementation = impl;
  const activeThread = { threadId: "t-active-17", turnId: "turn-1", phase: "active", worker: { workerId: "w1", child: { pid: 1, exitCode: null, signalCode: null }, ready: { sourceHashes: {} }, threadHistory: new Map() }, activeHttp: 0 };
  shared.threads.set("t-active-17", activeThread);
  const stWhileActive = impl.status();
  assert.equal(shared.rootAdmissions, legacyRoot, "Root must NOT be replaced while an active thread exists");
  assert.notEqual(stWhileActive.rootAnchorFixVersion, 1);

  // Once the active thread reaches terminal (0 active threads, 0 requests, 0 jobs, 0 anchors), next status() upgrades BOTH layers cleanly!
  activeThread.phase = "terminal";
  const st = impl.status();
  assert.equal(legacyClosed, true, "Old legacy relay must be closed and detached on idle upgrade");
  assert.notEqual(shared.nativeResponsesRelay, legacyRelay, "Relay must be replaced with patched relay");
  assert.notEqual(shared.rootAdmissions, legacyRoot, "Root must be replaced with patched root");
  assert.equal(shared.nativeResponsesRelay.anchorFixVersion, 1);
  assert.equal(shared.rootAdmissions.anchorFixVersion, 1);
  assert.equal(st.nativeResponses.anchorFixVersion, 1);
  assert.equal(st.rootAnchorFixVersion, 1);
});
