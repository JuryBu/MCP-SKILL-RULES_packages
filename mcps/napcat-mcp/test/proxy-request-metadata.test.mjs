import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Loopback fixture deadline exceeded");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function memoryJournal() {
  const files = new Map();
  return createWakeJournal({ filePath: path.join(os.tmpdir(), "metadata-memory-only", "journal.json"),
    fsImpl: {
      mkdirSync() {},
      readFileSync(filePath) {
        if (!files.has(filePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(filePath);
      },
      writeFileSync(filePath, content) { files.set(filePath, content); },
      renameSync(source, target) { files.set(target, files.get(source)); files.delete(source); },
    },
  });
}

async function fixture(context, options = {}, onRequest = () => {}) {
  const { deferInitialization = false, ...proxyOptions } = options;
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => upstream.once("listening", resolve));
  const requests = [];
  const replies = [];
  const desktops = [];
  let peer;
  const proxy = createCodexAppServerProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    downstreamPort: await freePort(), controlPort: await freePort(), controlToken: "metadata-fixture-token",
    requestTimeoutMs: 250, resumeRequestTimeoutMs: 250, heartbeatIntervalMs: 1000, ...proxyOptions,
  });
  context.after(async () => {
    for (const desktop of desktops) desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
    await waitFor(() => desktops.every(desktop => desktop.readyState === WebSocket.CLOSED));
    assert.equal(upstream.clients.size, 0);
    assert.equal(proxy.clients.size, 0);
    assert.equal(proxy.heartbeatTimer, null);
    assert.equal(proxy.websocketServer, null);
    assert.equal(proxy.controlServer, null);
    assert.deepEqual(proxy.requestMetadataSnapshot().storage, { pendingSlots: 0, generationSlots: 0 });
    context.diagnostic("cleanup: own loopback sockets/servers/heartbeat closed; collector slots=0");
  });
  upstream.on("connection", socket => {
    peer = socket;
    socket.on("message", (bytes, binary) => {
      requests.push({ bytes, binary });
      const request = JSON.parse(bytes.toString("utf8"));
      if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
      else onRequest(socket, request, desktops.at(-1), bytes);
    });
  });
  await proxy.start();
  async function connect() {
    const desktop = new WebSocket(`ws://127.0.0.1:${proxy.downstreamPort}`);
    desktops.push(desktop);
    desktop.on("message", (bytes, binary) => replies.push({ bytes, binary }));
    await new Promise((resolve, reject) => { desktop.once("open", resolve); desktop.once("error", reject); });
    desktop.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    if (!deferInitialization) await waitFor(() => proxy.status().readyClientCount === 1);
    return desktop;
  }
  const desktop = await connect();
  return { proxy, upstream, desktop, requests, replies, connect, peer: () => peer };
}

for (const enabled of [false, true]) {
  test(`loopback preserves both directions, binary flags and cancellation; enabled=${enabled}`, { timeout: 8000 }, async context => {
    const state = await fixture(context, enabled ? { requestMetadata: { enabled: true } } : {});
    const before = state.proxy.requestMetadataSnapshot();
    const request = Buffer.from(' { "id": "client-secret-id", "method": "thread/items/list", "params": { "threadId": "fixture-thread", "secret": "fixture-body" } }\n');
    state.desktop.send(request, { binary: true });
    await waitFor(() => state.requests.some(frame => frame.bytes.equals(request)));
    const reply = Buffer.from(' { "id": "client-secret-id", "result": { "data": [] } }\n');
    const serverRequest = Buffer.from(' { "id": "client-secret-id", "method": "thread/read", "params": { "threadId": "fixture-thread" } }\n');
    state.peer().send(serverRequest, { binary: true });
    await waitFor(() => state.replies.some(frame => frame.bytes.equals(serverRequest)));
    const serverReply = Buffer.from(' { "id": "client-secret-id", "error": { "code": -32003 } }\n');
    state.desktop.send(serverReply, { binary: false });
    state.peer().send(reply, { binary: false });
    const cancel = Buffer.from('{"method":"$/cancelRequest","params":{"id":"client-secret-id"}}');
    state.desktop.send(cancel);
    await waitFor(() => state.requests.some(frame => frame.bytes.equals(cancel)));
    assert.equal(state.requests.find(frame => frame.bytes.equals(request)).binary, true);
    assert.equal(state.requests.find(frame => frame.bytes.equals(serverReply)).binary, false);
    assert.equal(state.replies.find(frame => frame.bytes.equals(reply)).binary, false);
    assert.equal(state.replies.find(frame => frame.bytes.equals(serverRequest)).binary, true);
    const snapshot = state.proxy.requestMetadataSnapshot();
    assert.equal(snapshot.enabled, enabled);
    assert.equal(Object.hasOwn(state.proxy.status(), "requestMetadata"), false);
    if (enabled) {
      assert.equal(snapshot.frames.downstream.count - before.frames.downstream.count, 3);
      assert.equal(snapshot.frames.upstream.count - before.frames.upstream.count, 2);
      assert.equal(snapshot.methods["thread/items/list"].requestBytes, request.length);
      assert.equal(snapshot.methods["thread/items/list"].responseBytes, reply.length);
      assert.equal(snapshot.methods["thread/read"].responseBytesByResult["error_-32003"], serverReply.length);
    } else {
      assert.equal(snapshot.counts.requests, 0);
      const [client] = state.proxy.clients;
      assert.equal(client.metadataDownstreamGeneration, null);
      assert.equal(client.metadataUpstreamGeneration, null);
    }
    const serialized = JSON.stringify(snapshot);
    assert.ok(Buffer.byteLength(serialized) <= 16 * 1024);
    for (const secret of ["client-secret-id", "server-secret-id", "fixture-body", "metadata-fixture-token"]) {
      assert.equal(serialized.includes(secret), false);
    }
  });
}

for (const enabled of [false, true]) {
  test(`metadata read endpoint requires control authorization and preserves normal status: enabled=${enabled}`, { timeout: 8000 }, async context => {
    const state = await fixture(context, { requestMetadata: { enabled } });
    const endpoint = `http://127.0.0.1:${state.proxy.controlPort}/v1/request-metadata`;
    const rejected = await fetch(endpoint);
    assert.equal(rejected.status, 401);
    const rejectedBody = await rejected.json();
    assert.equal(rejectedBody.error.code, "UNAUTHORIZED");
    const response = await fetch(endpoint, { headers: { authorization: "Bearer metadata-fixture-token" } });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.deepEqual(snapshot, state.proxy.requestMetadataSnapshot());
    assert.equal(snapshot.enabled, enabled);
    assert.equal(Object.hasOwn(state.proxy.status(), "requestMetadata"), false);
    for (const secret of ["metadata-fixture-token", "fixture-thread"]) {
      assert.equal(JSON.stringify(snapshot).includes(secret), false);
    }
  });
}

test("loopback correlates injected and rewritten Desktop ids without changing either result", { timeout: 8000 }, async context => {
  let injectedId;
  let desktopBytes;
  let originalRequest;
  const state = await fixture(context, { requestMetadata: { enabled: true } }, (socket, request, desktop) => {
    if (request.method === "thread/resume") {
      injectedId = request.id;
      originalRequest = Buffer.from(` {"id":${request.id}.00,"method":"thread/read","params":{"threadId":"fixture-thread"}} `);
      desktop.send(originalRequest);
    } else if (request.method === "thread/read") {
      assert.notEqual(request.id, injectedId);
      desktopBytes = Buffer.from(JSON.stringify({ id: request.id, result: { origin: "desktop" } }));
      socket.send(desktopBytes);
      socket.send(JSON.stringify({ id: injectedId, result: { thread: { id: "fixture-thread", turns: [] }, origin: "injected" } }));
    }
  });
  const result = await state.proxy.subscribeThread("fixture-thread");
  await waitFor(() => state.replies.some(frame => frame.bytes.includes(Buffer.from('"desktop"'))));
  assert.equal(result.results[0].origin, "injected");
  const received = state.replies.find(frame => frame.bytes.includes(Buffer.from('"desktop"'))).bytes;
  assert.equal(JSON.parse(received).id, injectedId);
  assert.ok(received.includes(Buffer.from(`${injectedId}.00`)));
  assert.equal(received.length, desktopBytes.length + 3);
  const snapshot = state.proxy.requestMetadataSnapshot();
  assert.equal(snapshot.methods["thread/resume"].completed, 1);
  assert.equal(snapshot.methods["thread/read"].completed, 1);
  assert.equal(snapshot.methods["thread/read"].requestBytes, originalRequest.length);
  assert.equal(snapshot.methods["thread/read"].responseBytes, desktopBytes.length);
  assert.equal(snapshot.counts.duplicates, 0);
  assert.equal(snapshot.counts.trackedCurrent, 0);
  state.peer().send(JSON.stringify({ id: injectedId, result: { origin: "orphan" } }));
  await waitFor(() => state.proxy.requestMetadataSnapshot().counts.unmatchedResponses === 1);
  assert.equal(state.replies.some(frame => frame.bytes.includes(Buffer.from('"orphan"'))), false);
  assert.equal(state.proxy.requestMetadataSnapshot().methods.unknown.responseSizeBuckets.le_1KiB, 1);
});

test("loopback retains raw sizes above parse budget and leaves unsupported ids unknown", { timeout: 10000 }, async context => {
  const state = await fixture(context, { maxJsonParseBytes: 1024, requestMetadata: { enabled: true } });
  const request = Buffer.from(JSON.stringify({ id: 12, method: "thread/items/list", params: { padding: "x".repeat(4 * 1024 * 1024) } }));
  state.desktop.send(request, { binary: true });
  await waitFor(() => state.requests.some(frame => frame.bytes.equals(request)));
  const reply = Buffer.from(JSON.stringify({ id: 12, error: { code: -32003, message: "fixture", data: { padding: "x".repeat(2048) } } }));
  state.peer().send(reply, { binary: true });
  await waitFor(() => state.replies.some(frame => frame.bytes.equals(reply)));
  const unsupportedId = "unsupported-" + "x".repeat(300);
  const unknownRequest = JSON.stringify({ id: unsupportedId, method: "thread/read", params: { threadId: "fixture-thread" } });
  const unknownReply = Buffer.from(JSON.stringify({ id: unsupportedId, result: {} }));
  state.desktop.send(unknownRequest);
  await waitFor(() => state.requests.some(frame => frame.bytes.toString() === unknownRequest));
  state.peer().send(unknownReply);
  await waitFor(() => state.replies.some(frame => frame.bytes.equals(unknownReply)));
  const snapshot = state.proxy.requestMetadataSnapshot();
  assert.equal(snapshot.methods["thread/items/list"].requestBytes, request.length);
  assert.equal(snapshot.methods["thread/items/list"].requestSizeBuckets.gt_4MiB, 1);
  assert.equal(snapshot.methods["thread/items/list"].responseBytesByResult["error_-32003"], reply.length);
  assert.equal(snapshot.methods["thread/read"].completed, 0);
  assert.equal(snapshot.methods.unknown.responseBytes, unknownReply.length);
  assert.equal(snapshot.unknown.unsupportedId, 1);
  assert.equal(snapshot.counts.unmatchedResponses, 1);
});

test("loopback closes generations on loss and isolates same ids after Desktop reconnect", { timeout: 8000 }, async context => {
  const state = await fixture(context, { requestMetadata: { enabled: true } });
  const pending = JSON.stringify({ id: 22, method: "thread/list", params: {} });
  state.desktop.send(pending);
  await waitFor(() => state.requests.some(frame => frame.bytes.toString() === pending));
  state.peer().terminate();
  await waitFor(() => state.proxy.clients.size === 0);
  let snapshot = state.proxy.requestMetadataSnapshot();
  assert.equal(snapshot.storage.pendingSlots, 0);
  assert.equal(snapshot.storage.generationSlots, 0);
  assert.equal(snapshot.unknown.connectionClosed, 1);
  const desktop = await state.connect();
  state.peer().send(JSON.stringify({ id: 22, result: {} }));
  await waitFor(() => state.proxy.requestMetadataSnapshot().counts.unmatchedResponses === 1);
  assert.equal(state.proxy.requestMetadataSnapshot().methods["thread/list"].completed, 0);
  desktop.send(pending);
  await waitFor(() => state.requests.filter(frame => frame.bytes.toString() === pending).length === 2);
  state.peer().send(JSON.stringify({ id: 22, result: {} }));
  await waitFor(() => state.proxy.requestMetadataSnapshot().methods["thread/list"].completed === 1);
  snapshot = state.proxy.requestMetadataSnapshot();
  assert.equal(snapshot.counts.duplicates, 0);
  assert.ok(snapshot.counts.generationAdmissions >= 2);
});

test("loopback initial upstream retry preserves queued requests and observes each frame once", { timeout: 8000 }, async context => {
  const unavailablePort = await freePort();
  const state = await fixture(context, { requestMetadata: { enabled: true }, deferInitialization: true,
    upstreamUrl: `ws://127.0.0.1:${unavailablePort}`, reconnectInitialMs: 50, reconnectMaxMs: 100 });
  await waitFor(() => [...state.proxy.clients][0]?.reconnectAttempt >= 1);
  assert.equal(state.proxy.requestMetadataSnapshot().frames.downstream.count, 1);
  assert.equal([...state.proxy.clients][0].queued.length, 1);
  state.proxy.setUpstreamUrl(`ws://127.0.0.1:${state.upstream.address().port}`);
  state.proxy.resumeUpstream();
  await waitFor(() => state.proxy.status().readyClientCount === 1);
  const snapshot = state.proxy.requestMetadataSnapshot();
  assert.equal(snapshot.methods.initialize.requests, 1);
  assert.equal(snapshot.methods.initialize.completed, 1);
  assert.equal(snapshot.frames.downstream.count, 1);
  assert.equal(snapshot.frames.upstream.count, 1);
  assert.equal(snapshot.counts.duplicates, 0);
});

test("loopback adds no whole-body JSON parse with statistics enabled", { timeout: 8000 }, async context => {
  const state = await fixture(context, { requestMetadata: { enabled: true } });
  const payload = JSON.stringify({ id: 44, method: "thread/list", params: { padding: "x".repeat(512) } });
  const originalParse = JSON.parse;
  let bodyParses = 0;
  JSON.parse = function(value, ...remaining) {
    if (value === payload && new Error().stack.includes("parseJsonMessage")) bodyParses += 1;
    return originalParse(value, ...remaining);
  };
  try {
    state.desktop.send(payload);
    await waitFor(() => state.requests.some(frame => frame.bytes.toString() === payload));
    assert.equal(bodyParses, 1);
    assert.equal(state.proxy.requestMetadataSnapshot().methods["thread/list"].requests, 1);
  } finally {
    JSON.parse = originalParse;
  }
});

for (const direction of ["downstream", "upstream"]) {
  test(`loopback counts one raw unknown on ${direction} envelope rejection`, { timeout: 8000 }, async context => {
    const state = await fixture(context, { requestMetadata: { enabled: true }, maxJsonParseBytes: 1024 });
    const before = state.proxy.requestMetadataSnapshot();
    const invalid = Buffer.from('{"id":2,"method":"' + "x".repeat(1100) + '","params":{}}');
    if (direction === "downstream") state.desktop.send(invalid);
    else state.peer().send(invalid);
    await waitFor(() => state.proxy.clients.size === 0);
    const snapshot = state.proxy.requestMetadataSnapshot();
    assert.equal(snapshot.frames[direction].count - before.frames[direction].count, 1);
    assert.equal(snapshot.frames[direction].bytes - before.frames[direction].bytes, invalid.length);
    assert.equal(snapshot.counts.unknownFrames - before.counts.unknownFrames, 1);
    assert.equal(snapshot.methods.other.requests, 0);
    assert.equal(snapshot.storage.pendingSlots, 0);
  });
}

for (const now of [() => { throw new Error("statistics-only fault"); }, () => ({ valueOf() { throw new Error("invalid statistics-only return"); } })]) {
  test(`loopback statistics fault preserves forwarding: ${now.toString()}`, { timeout: 8000 }, async context => {
    const state = await fixture(context, { requestMetadata: { enabled: true, now } });
    const request = Buffer.from('{"id":33,"method":"thread/read","params":{"threadId":"fixture-thread"}}');
    const reply = Buffer.from('{"id":33,"result":{"ok":true}}');
    state.desktop.send(request);
    await waitFor(() => state.requests.some(frame => frame.bytes.equals(request)));
    state.peer().send(reply);
    await waitFor(() => state.replies.some(frame => frame.bytes.equals(reply)));
    assert.equal(state.proxy.status().readyClientCount, 1);
    assert.equal(state.proxy.lastError, null);
    assert.ok(state.proxy.requestMetadataSnapshot().counts.failures >= 2);
  });
}

test("loopback hidden wake counts consumed injections and hidden projection without exposing content", { timeout: 8000 }, async context => {
  let injectedInput;
  const state = await fixture(context, { requestMetadata: { enabled: true }, journal: memoryJournal() }, (socket, request) => {
    if (request.method === "thread/resume") {
      socket.send(JSON.stringify({ id: request.id, result: { thread: { id: "hidden-thread", status: "inProgress",
        turns: [{ id: "hidden-turn", status: "inProgress" }] } } }));
    } else if (request.method === "turn/steer") {
      injectedInput = request.params;
      socket.send(JSON.stringify({ id: request.id, result: { turn: { id: "hidden-turn", status: "inProgress" } } }));
    }
  });
  const wake = await state.proxy.wakeThread({ taskId: "fixture-task", generation: 1, threadId: "hidden-thread",
    localRole: "fixture-local", sourceMachine: "fixture-source", targetMachine: "fixture-target", trustedPeerQq: "fixture-peer",
    wakeId: "fixture-hidden-wake", prompt: "private-fixture-prompt", messageVisibility: "hidden",
    pendingThroughSequence: 1, pendingThroughTime: "2026-10-11T00:00:00Z" });
  assert.equal(wake.started, true);
  assert.equal(wake.injectionMethod, "turn/steer");
  assert.equal(wake.messageVisibility, "hidden");
  assert.equal(wake.clientUserMessageId, null);
  const before = state.proxy.requestMetadataSnapshot();
  state.peer().send(JSON.stringify({ method: "item/started", params: { threadId: "hidden-thread", turnId: "hidden-turn",
    item: { id: "hidden-item", type: "userMessage", clientId: injectedInput.clientUserMessageId,
      content: [{ type: "text", text: "private-fixture-prompt" }] } } }));
  const barrier = Buffer.from('{"method":"fixture/barrier"}');
  state.peer().send(barrier);
  await waitFor(() => state.replies.some(frame => frame.bytes.equals(barrier)));
  const snapshot = state.proxy.requestMetadataSnapshot();
  assert.equal(snapshot.frames.upstream.count - before.frames.upstream.count, 2);
  assert.equal(snapshot.methods.other.completed, 1);
  assert.equal(snapshot.methods["thread/resume"].completed, 1);
  assert.equal(state.replies.some(frame => frame.bytes.includes(Buffer.from("private-fixture-prompt"))), false);
  assert.equal(JSON.stringify(snapshot).includes("private-fixture-prompt"), false);
});
