import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";

const threadId = "rpc-fixture-thread";
const thread = { id: threadId, turns: [] };

async function waitFor(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("RPC fixture deadline exceeded");
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

async function fixture(context, onRequest, options = {}) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => upstream.once("listening", resolve));
  const proxy = createCodexAppServerProxy({ upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    downstreamPort: await freePort(), controlPort: await freePort(), controlToken: "rpc-fixture-token",
    requestTimeoutMs: 250, resumeRequestTimeoutMs: 250, ...options });
  if (options.observerTimers && typeof proxy.createTurnObserver === "function") {
    const createObserver = proxy.createTurnObserver;
    proxy.createTurnObserver = settings => createObserver({ ...settings,
      setTimeoutImpl(callback) { const timer = { callback }; options.observerTimers.add(timer); return timer; },
      clearTimeoutImpl(timer) { options.observerTimers.delete(timer); },
    });
  }
  const messages = [];
  const rawMessages = [];
  const binaryFrames = [];
  let desktop;
  upstream.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes.toString("utf8"));
    if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
    else onRequest(socket, request, desktop, bytes);
  }));
  context.after(async () => {
    desktop?.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  await proxy.start();
  desktop = new WebSocket(`ws://127.0.0.1:${proxy.downstreamPort}`);
  desktop.on("message", (bytes, isBinary) => {
    rawMessages.push(Buffer.from(bytes));
    binaryFrames.push(isBinary);
    try {
      messages.push(JSON.parse(bytes.toString("utf8")));
    } catch {
      messages.push({ malformed: true });
    }
  });
  await new Promise((resolve, reject) => { desktop.once("open", resolve); desktop.once("error", reject); });
  desktop.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  return { proxy, desktop, messages, rawMessages, binaryFrames };
}

function largeReply(id, field = "result", idJson = JSON.stringify(id)) {
  const value = field === "error"
    ? { code: -32046, message: "fixture rejected", data: { padding: "x".repeat(4 * 1024 * 1024) } }
    : { origin: "large-reply", padding: "x".repeat(4 * 1024 * 1024), nested: { id: -1000000000, method: "decoy", error: {} } };
  return Buffer.from(` { "${field}" : ${JSON.stringify(value)}, "id" : ${idJson} }\n`);
}

function assertTrackingCleared(state) {
  const [client] = state.proxy.clients;
  assert.ok(client);
  assert.equal(client.desktopRequestIds.size, 0);
  assert.equal(client.desktopRequestBytes, 0);
  assert.equal(client.forwardedRequestIds.size, 0);
  assert.equal(client.injected.size, 0);
}

function observerAvailable(context, state) {
  if (typeof state.proxy.createTurnObserver === "function") return true;
  context.skip("The selected baseline has no turn observer");
  return false;
}

function memoryJournal() {
  const files = new Map();
  return createWakeJournal({
    filePath: path.join(os.tmpdir(), "outer-rpc-ownership-memory-only", "journal.json"),
    fsImpl: {
      mkdirSync() {},
      readFileSync(filePath) {
        if (!files.has(filePath)) throw Object.assign(new Error("missing fixture journal"), { code: "ENOENT" });
        return files.get(filePath);
      },
      writeFileSync(filePath, content) { files.set(filePath, content); },
      renameSync(source, target) { files.set(target, files.get(source)); files.delete(source); },
    },
  });
}

function wakeInput(wakeId) {
  return { taskId: "rpc-fixture-task", generation: 1, threadId, localRole: "fixture-local",
    sourceMachine: "fixture-source", targetMachine: "fixture-target", trustedPeerQq: "fixture-peer",
    wakeId, prompt: "fixture wake", pendingThroughSequence: 1, pendingThroughTime: "2026-10-09T00:00:00Z" };
}

test("late internal responses do not release caller slots or grow abandoned mappings beyond the limit", { timeout: 5000 }, async context => {
  let expiredId;
  let forwardedReads = 0;
  const state = await fixture(context, (socket, request) => {
    if (request.method === "thread/resume") {
      expiredId = request.id;
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: request.id, result: { thread, origin: "late-internal" } }));
      }, 280);
    } else if (request.method === "thread/read") forwardedReads += 1;
  }, { maxQueuedMessages: 2 });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(state.proxy.subscribeThread(threadId));
    state.desktop.send(JSON.stringify({ id: expiredId, method: "thread/read", params: { threadId } }));
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  await waitFor(() => state.proxy.status().readyClientCount === 0);
  assert.equal(forwardedReads, 2);
  assert.equal(state.messages.some(message => message.result?.origin === "late-internal"), false);
});

test("an upstream request sharing an injected id remains a request and its response stays private", { timeout: 5000 }, async context => {
  let injectedId;
  const state = await fixture(context, (socket, request) => {
    if (request.method !== "thread/resume") return;
    injectedId = request.id;
    socket.send(JSON.stringify({ id: request.id, method: "item/tool/requestUserInput", params: { questions: [] } }));
    socket.send(JSON.stringify({ id: request.id, result: { thread } }));
    socket.send(JSON.stringify({ method: "fixture/barrier" }));
  });
  const result = await state.proxy.subscribeThread(threadId);
  await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
  assert.equal(state.messages.some(message => message.method === "item/tool/requestUserInput"), true);
  assert.equal(state.messages.some(message => message.id === injectedId && message.result), false);
  assert.deepEqual(result.results[0], { thread });
});

test("a Desktop request using an active injected id receives its own result under its original id", { timeout: 5000 }, async context => {
  let injectedId;
  const state = await fixture(context, (socket, request, desktop) => {
    if (request.method === "thread/resume") {
      injectedId = request.id;
      desktop.send(JSON.stringify({ id: request.id, method: "thread/read", params: { threadId } }));
    } else if (request.method === "thread/read") {
      assert.notEqual(request.id, injectedId);
      socket.send(JSON.stringify({ id: request.id, result: { thread, origin: "desktop" } }));
      socket.send(JSON.stringify({ id: injectedId, result: { thread, origin: "injected" } }));
      socket.send(JSON.stringify({ method: "fixture/barrier" }));
    }
  });
  const result = await state.proxy.subscribeThread(threadId);
  await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
  assert.equal(result.results[0].origin, "injected");
  assert.equal(state.messages.find(message => message.id === injectedId).result.origin, "desktop");
});

test("the injected allocator skips a Desktop id already waiting upstream", { timeout: 5000 }, async context => {
  let waitingDesktopId;
  const state = await fixture(context, (socket, request) => {
    if (request.method === "thread/read") waitingDesktopId = request.id;
    else if (request.method === "thread/resume") {
      assert.notEqual(request.id, waitingDesktopId);
      socket.send(JSON.stringify({ id: request.id, result: { thread } }));
      socket.send(JSON.stringify({ id: waitingDesktopId, result: { thread, origin: "desktop" } }));
    }
  });
  state.desktop.send(JSON.stringify({ id: -1000000000, method: "thread/read", params: { threadId } }));
  await waitFor(() => waitingDesktopId != null);
  await state.proxy.subscribeThread(threadId);
  await waitFor(() => state.messages.some(message => message.id === waitingDesktopId));
  assert.equal(state.messages.find(message => message.id === waitingDesktopId).result.origin, "desktop");
});

for (const internalReplyFirst of [false, true]) {
test(`a timed-out internal result remains private after id reuse, internal reply first=${internalReplyFirst}`, { timeout: 5000 }, async context => {
  let expiredId;
  const state = await fixture(context, (socket, request) => {
    if (request.method === "thread/resume") {
      expiredId = request.id;
      setTimeout(() => {
        socket.send(JSON.stringify({ id: expiredId, result: { thread, origin: "late-internal" } }));
        socket.send(JSON.stringify({ method: "fixture/barrier" }));
      }, 450);
    } else if (request.method === "thread/read") {
      assert.notEqual(request.id, expiredId);
      setTimeout(() => socket.send(JSON.stringify({ id: request.id, result: { thread, origin: "desktop" } })), internalReplyFirst ? 300 : 0);
    }
  });
  await assert.rejects(state.proxy.subscribeThread(threadId));
  state.desktop.send(JSON.stringify({ id: expiredId, method: "thread/read", params: { threadId } }));
  await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
  await waitFor(() => state.messages.some(message => message.result?.origin === "desktop"));
  assert.equal(state.messages.filter(message => message.id === expiredId).length, 1);
  assert.equal(state.messages.find(message => message.id === expiredId).result.origin, "desktop");
});
}

test("large Desktop replies preserve raw bytes, typed escaped ids and release slots before id reuse", { timeout: 15000 }, async context => {
  const replies = [];
  const state = await fixture(context, (socket, request) => {
    const reply = largeReply(request.id, "result", typeof request.id === "string"
      ? JSON.stringify(request.id).replace("任", "\\u4efb") : JSON.stringify(request.id));
    replies.push(reply);
    socket.send(reply, { binary: false });
  });
  for (const requestedId of [2, "2", "任務\n\"\\😀"]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const previousCount = state.messages.length;
      state.desktop.send(JSON.stringify({ id: requestedId, method: "large/result", params: {} }));
      await waitFor(() => state.messages.length > previousCount || state.desktop.readyState !== WebSocket.OPEN);
      assert.equal(state.desktop.readyState, WebSocket.OPEN);
      assert.equal(state.messages.at(-1).id, requestedId);
      assert.deepEqual(state.rawMessages.at(-1), replies.at(-1));
      assertTrackingCleared(state);
    }
  }
});

for (const field of ["result", "error"]) {
  test(`large remapped Desktop ${field} restores only the id and releases both mappings`, { timeout: 10000 }, async context => {
    const originalId = -1000000000;
    const replies = [];
    const state = await fixture(context, (socket, request) => {
      if (request.method === "thread/read") socket.send(JSON.stringify({ id: request.id, result: { thread } }));
      else {
        assert.notEqual(request.id, originalId);
        replies.push(largeReply(originalId, field));
        socket.send(largeReply(request.id, field), { binary: false });
      }
    });
    await state.proxy.inspectThread(threadId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const previousCount = state.messages.length;
      state.desktop.send(JSON.stringify({ id: originalId, method: "large/result", params: {} }));
      await waitFor(() => state.messages.length > previousCount);
      assert.equal(state.messages.at(-1).id, originalId);
      assert.deepEqual(state.rawMessages.at(-1), replies.at(-1));
      assertTrackingCleared(state);
    }
  });

  test(`oversized internal ${field} rejects the read immediately, clears its slot and isolates late copies`, { timeout: 10000 }, async context => {
    let internalId;
    const state = await fixture(context, (socket, request) => {
      if (request.method === "thread/read") {
        internalId = request.id;
        socket.send(largeReply(request.id, field), { binary: false });
        socket.send(largeReply(request.id, field), { binary: false });
        socket.send(JSON.stringify({ id: request.id, method: "item/tool/requestUserInput", params: { questions: [] } }));
        socket.send(JSON.stringify({ method: "fixture/barrier" }));
      } else socket.send(JSON.stringify({ id: request.id, result: { origin: "desktop" } }));
    }, { requestTimeoutMs: 2000 });
    await assert.rejects(state.proxy.inspectThread(threadId), error => {
      assert.equal(error.code, "APP_SERVER_RESPONSE_TOO_LARGE");
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.details.method, "thread/read");
      return true;
    });
    await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
    assert.equal(state.messages.some(message => message.id === internalId && !message.method), false);
    assert.equal(state.messages.some(message => message.method === "item/tool/requestUserInput"), true);
    state.desktop.send(JSON.stringify({ id: internalId, method: "desktop/after-large", params: {} }));
    await waitFor(() => state.messages.some(message => message.result?.origin === "desktop"));
    assert.equal(state.messages.find(message => message.result?.origin === "desktop").id, internalId);
    assertTrackingCleared(state);
  });
}

test("oversized mutating replies retain an unknown wake and never auto-resend the same wake", { timeout: 10000 }, async context => {
  const journal = memoryJournal();
  let startRequests = 0;
  const state = await fixture(context, (socket, request) => {
    if (request.method === "thread/resume") socket.send(JSON.stringify({ id: request.id, result: { thread: { ...thread, status: "idle" } } }));
    else if (request.method === "turn/start") {
      startRequests += 1;
      socket.send(largeReply(request.id), { binary: false });
      socket.send(JSON.stringify({ method: "fixture/barrier" }));
    }
  }, { journal, requestTimeoutMs: 2000 });
  const input = wakeInput("oversized-mutating-wake");
  await assert.rejects(state.proxy.wakeThread(input), error => {
    assert.equal(error.code, "APP_SERVER_RESPONSE_TOO_LARGE");
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
  assert.equal(journal.getWake(input.wakeId).status, "unknown");
  assert.equal((await state.proxy.wakeThread(input)).outcome, "unknown");
  assert.equal(startRequests, 1);
  assert.equal(state.messages.some(message => Object.hasOwn(message, "result") && message.id !== 1), false);
  assertTrackingCleared(state);
});

const rpcErrorCases = [
  { code: -32601, message: "thread/read: method not found", missing: false },
  { code: -32603, message: "thread storage: database not found", missing: false },
  { code: -32602, message: "thread storage: database not found", missing: false },
  { code: -32602, message: "thread not found", missing: false },
  { code: -32602, message: "thread not found: unrelated-thread", missing: false },
  { code: -32602, message: `thread not loaded: ${threadId}`, missing: false },
  { code: -32601, message: `thread not found: ${threadId}`, missing: false },
  { code: -32602, message: `thread not found: ${threadId}`, missing: true },
  { code: -32004, message: `unknown thread: '${threadId}'.`, missing: true },
  { code: -32602, message: `Thread "${threadId}" does not exist!`, missing: true },
  { code: -32602, message: `  thread does not exist: ${threadId}!\n`, missing: true },
];

for (const rpcError of rpcErrorCases) {
  test(`HTTP inspect preserves exact error or proves missing: ${rpcError.code}/${rpcError.message}`, { timeout: 5000 }, async context => {
    const error = { code: rpcError.code, message: rpcError.message, data: { marker: "preserved" } };
    const state = await fixture(context, (socket, request) => socket.send(JSON.stringify({ id: request.id, error })));
    const response = await fetch(`http://127.0.0.1:${state.proxy.controlPort}/v1/threads/inspect`, {
      method: "POST", headers: { authorization: "Bearer rpc-fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    const body = await response.json();
    assert.equal(response.status, rpcError.missing ? 200 : 500);
    if (rpcError.missing) assert.deepEqual(body, { ok: true, threadId, found: false, thread: null });
    else {
      assert.equal(body.error.code, "APP_SERVER_RPC_ERROR");
      assert.deepEqual(body.error.details.rpcError, error);
    }
    assertTrackingCleared(state);
  });
}

for (const internalReplyFirst of [false, true]) {
  for (const internalFails of [false, true]) {
    test(`observer isolates internal replies and clears a remapped rejected turn: first=${internalReplyFirst}, error=${internalFails}`, { timeout: 5000 }, async context => {
      const events = [];
      const timers = new Set();
      let pending;
      const state = await fixture(context, (socket, request, desktop) => {
        if (request.method === "thread/resume") {
          pending = { socket, request };
          desktop.send(JSON.stringify({ id: request.id, method: "turn/start", params: { threadId } }));
        } else if (request.method === "turn/start") {
          const internalReply = { id: pending.request.id, ...(internalFails
            ? { error: { code: -32045, message: "internal resume rejected" } } : { result: { thread } }) };
          const desktopReply = { id: request.id, error: { code: -32046, message: "Desktop turn rejected" } };
          socket.send(JSON.stringify({ id: pending.request.id, method: "item/tool/requestUserInput", params: { threadId, questions: [] } }));
          for (const reply of internalReplyFirst ? [internalReply, desktopReply] : [desktopReply, internalReply]) socket.send(JSON.stringify(reply));
          socket.send(JSON.stringify({ method: "fixture/barrier" }));
        }
      }, { onEvent: event => events.push(event), observerTimers: timers });
      if (!observerAvailable(context, state)) return;
      if (internalFails) await assert.rejects(state.proxy.subscribeThread(threadId), error => error.details.rpcError.code === -32045);
      else await state.proxy.subscribeThread(threadId);
      await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
      assert.equal(state.proxy.status().clients[0].turnObservation.active, 0);
      for (const timer of timers) timer.callback();
      const rejected = events.filter(event => event.type === "app_server_turn_start_rejected");
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].rpcCode, -32046);
      assert.equal(rejected[0].appServerAccepted, false);
      assert.equal(events.some(event => event.type === "app_server_turn_first_output_deadline_exceeded"), false);
      assert.equal(timers.size, 0);
      assertTrackingCleared(state);
    });
  }
}

const unsafeResumeSummaries = [
  { name: "systemError", thread: { ...thread, status: { type: "systemError" } } },
  { name: "unknown object", thread: { ...thread, status: { type: "futureStatus" } } },
  { name: "notLoaded", thread: { ...thread, status: { type: "notLoaded" } } },
  { name: "wrong id", thread: { ...thread, id: "OTHER", status: "idle" } },
  { name: "missing id", thread: { status: "idle", turns: [] } },
  { name: "no summary", thread: null },
  { name: "unknown string", thread: { ...thread, status: "futureStatus" } },
  { name: "nested fake identity", thread: { id: "OTHER", status: "idle", metadata: { id: threadId } } },
  { name: "missing status and turns", thread: { id: threadId } },
];

for (const summary of unsafeResumeSummaries) {
  test(`wake refuses unsafe resume ${summary.name} before turn/start`, { timeout: 5000 }, async context => {
    const journal = memoryJournal();
    const methods = [];
    const state = await fixture(context, (socket, request) => {
      methods.push(request.method);
      socket.send(JSON.stringify({ id: request.id, result: request.method === "thread/resume"
        ? { thread: summary.thread } : { turn: { id: "unexpected-turn", status: "inProgress" } } }));
    }, { journal });
    await assert.rejects(state.proxy.wakeThread(wakeInput(`unsafe-${summary.name}`)), error => {
      assert.ok(["INVALID_THREAD_SUMMARY", "THREAD_NOT_IDLE"].includes(error.code));
      assert.equal(error.outcomeUnknown, false);
      return true;
    });
    assert.deepEqual(methods, ["thread/resume"]);
    assert.equal(journal.getWake(`unsafe-${summary.name}`).status, "failed_before_send");
    assertTrackingCleared(state);
  });
}

const malformedFrames = [
  { name: "duplicate top-level id", build: (id, padding) => `{"id":${id},"result":"${padding}","id":2}` },
  { name: "escaped duplicate top-level id", build: (id, padding) => `{"id":${id},"result":"${padding}","\\u0069d":2}` },
  { name: "nested decoy without envelope id", build: (id, padding) => `{"result":{"id":${id},"padding":"${padding}"}}` },
  { name: "invalid nested grammar", build: (id, padding) => `{"id":${id},"result":{"padding":"${padding}","broken" 1}}` },
  { name: "invalid escape", build: (id, padding) => `{"id":${id},"result":"${padding}\\uZZZZ"}` },
  { name: "truncated string", build: (id, padding) => `{"id":${id},"result":"${padding}` },
  { name: "trailing junk", build: (id, padding) => `{"id":${id},"result":"${padding}"}false` },
  { name: "excessive nesting", build: (id, padding) => `{"id":${id},"result":[${"[".repeat(130)}"${padding}"${"]".repeat(130)}]}` },
  { name: "invalid binary UTF-8", binary: true, build: (id, padding) => Buffer.concat([
    Buffer.from(`{"id":${id},"result":"${padding}`), Buffer.from([255]), Buffer.from('"}'),
  ]) },
  { name: "UTF-8 encoded surrogate", binary: true, build: (id, padding) => Buffer.concat([
    Buffer.from(`{"id":${id},"result":"${padding}`), Buffer.from([237, 160, 128]), Buffer.from('"}'),
  ]) },
];

for (const malformed of malformedFrames) {
  test(`malformed oversized RPC ${malformed.name} closes safely without leaking an internal body`, { timeout: 5000 }, async context => {
    const state = await fixture(context, (socket, request) => {
      socket.send(malformed.build(request.id, "x".repeat(2048)), { binary: malformed.binary ?? false });
    }, { maxJsonParseBytes: 1024 });
    await assert.rejects(state.proxy.inspectThread(threadId), error => {
      assert.equal(error.code, "CONNECTION_CLOSED");
      assert.equal(error.outcomeUnknown, false);
      return true;
    });
    await waitFor(() => state.desktop.readyState === WebSocket.CLOSED);
    assert.equal(state.messages.length, 1);
    assert.equal(state.proxy.status().clientCount, 0);
    assert.equal(state.proxy.status().lastError.code, "APP_SERVER_PROTOCOL_ERROR");
  });
}

test("large notifications and server requests sharing an internal id remain raw and never resolve the injected call", { timeout: 10000 }, async context => {
  const frames = [];
  let internalId;
  const state = await fixture(context, (socket, request) => {
    internalId = request.id;
    frames.push(Buffer.from(JSON.stringify({ result: { id: request.id }, method: "fixture/large-notification",
      params: { padding: "x".repeat(4 * 1024 * 1024) } })));
    frames.push(Buffer.from(JSON.stringify({ result: { id: request.id }, id: request.id,
      method: "item/tool/requestUserInput", params: { padding: "x".repeat(4 * 1024 * 1024) } })));
    for (const frame of frames) socket.send(frame, { binary: false });
    socket.send(JSON.stringify({ id: request.id, result: { thread } }));
    socket.send(JSON.stringify({ method: "fixture/barrier" }));
  });
  assert.deepEqual((await state.proxy.inspectThread(threadId)).thread, thread);
  await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
  assert.deepEqual(state.rawMessages.slice(1, 3), frames);
  assert.equal(state.messages.some(message => message.id === internalId && !message.method), false);
  assertTrackingCleared(state);
});

test("numeric and string ids with the same characters retain separate ownership", { timeout: 5000 }, async context => {
  const requests = [];
  const state = await fixture(context, (socket, request) => {
    requests.push(request);
    if (requests.length === 2) {
      for (const pending of [...requests].reverse()) socket.send(JSON.stringify({ id: pending.id, error: { code: -32046, message: "typed rejection" } }));
    }
  });
  state.desktop.send(JSON.stringify({ id: 2, method: "typed/request", params: {} }));
  state.desktop.send(JSON.stringify({ id: "2", method: "typed/request", params: {} }));
  await waitFor(() => state.messages.length === 3);
  assert.deepEqual(state.messages.slice(1).map(message => message.id), ["2", 2]);
  assertTrackingCleared(state);
});

test("the default observer clears a rejected remapped large turn reply without a real deadline event", { timeout: 5000 }, async context => {
  const events = [];
  const state = await fixture(context, (socket, request) => {
    if (request.method === "thread/read") socket.send(JSON.stringify({ id: request.id, result: { thread } }));
    else socket.send(largeReply(request.id, "error"), { binary: false });
  }, { turnFirstOutputTimeoutMs: 1000, onEvent: event => events.push(event) });
  if (!observerAvailable(context, state)) return;
  await state.proxy.inspectThread(threadId);
  state.desktop.send(JSON.stringify({ id: -1000000000, method: "turn/start", params: { threadId } }));
  await waitFor(() => state.messages.some(message => message.id === -1000000000 && message.error));
  assert.equal(state.proxy.status().clients[0].turnObservation.active, 0);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(events.filter(event => event.type === "app_server_turn_start_rejected").length, 1);
  assert.equal(events.find(event => event.type === "app_server_turn_start_rejected").rpcCode, -32046);
  assert.equal(events.some(event => event.type === "app_server_turn_first_output_deadline_exceeded"), false);
  assertTrackingCleared(state);
});

test("observer keeps lifecycle identity in a large first-output notification without materializing its body", { timeout: 10000 }, async context => {
  const events = [];
  let notification;
  const state = await fixture(context, (socket, request) => {
    socket.send(JSON.stringify({ id: request.id, result: { turn: { id: "large-output-turn", threadId, status: "inProgress" } } }));
    notification = Buffer.from(JSON.stringify({ method: "item/agentMessage/delta",
      params: { delta: "x".repeat(4 * 1024 * 1024), turnId: "large-output-turn", threadId } }));
    socket.send(notification, { binary: false });
    socket.send(JSON.stringify({ method: "fixture/barrier" }));
  }, { turnFirstOutputTimeoutMs: 1000, onEvent: event => events.push(event) });
  if (!observerAvailable(context, state)) return;
  state.desktop.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId } }));
  await waitFor(() => state.messages.some(message => message.method === "fixture/barrier"));
  assert.deepEqual(state.rawMessages.find(bytes => bytes.length > 4 * 1024 * 1024), notification);
  assert.equal(state.proxy.status().clients[0].turnObservation.active, 0);
  assert.equal(state.proxy.status().clients[0].turnObservation.counters.meaningful, 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(events.some(event => event.type === "app_server_turn_first_output_deadline_exceeded"), false);
  assertTrackingCleared(state);
});

for (const status of ["idle", { type: "idle" }, null]) {
  test(`wake accepts a matched idle resume with legacy/object status ${JSON.stringify(status)}`, { timeout: 5000 }, async context => {
    const methods = [];
    const state = await fixture(context, (socket, request) => {
      methods.push(request.method);
      socket.send(JSON.stringify({ id: request.id, result: request.method === "thread/resume"
        ? { thread: { ...thread, ...(status === null ? {} : { status }) } }
        : { turn: { id: "fixture-accepted-turn", status: "inProgress" } } }));
    }, { journal: memoryJournal() });
    assert.equal((await state.proxy.wakeThread(wakeInput(`safe-idle-${JSON.stringify(status)}`))).outcome, "accepted");
    assert.deepEqual(methods, ["thread/resume", "turn/start"]);
    assertTrackingCleared(state);
  });
}

test("HTTP inspect escapes the full requested thread id in missing-error recognition", { timeout: 5000 }, async context => {
  const requestedId = "rpc.[a]+(x)?";
  const state = await fixture(context, (socket, request) => socket.send(JSON.stringify({ id: request.id,
    error: { code: -32602, message: `thread not found: ${request.params.threadId}` } })));
  assert.deepEqual(await state.proxy.inspectThread(requestedId), { threadId: requestedId, found: false, thread: null });
  assertTrackingCleared(state);
});

test("a large remapped binary request preserves its body, escaped key and original numeric id spelling", { timeout: 10000 }, async context => {
  const originalIdJson = "-1.000000000e9";
  const result = JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024), text: "任務\\\"😀", nested: { id: -1000000000 } });
  const rawRequest = Buffer.from(` { "params" : ${result}, "method" : "fixture/large-binary", "\\u0069d" : ${originalIdJson} } `);
  const expectedReply = Buffer.from(` { "result" : ${result}, "\\u0069d" : ${originalIdJson} } `);
  const state = await fixture(context, (socket, request, desktop, bytes) => {
    if (request.method === "thread/read") socket.send(JSON.stringify({ id: request.id, result: { thread } }));
    else {
      assert.notEqual(request.id, -1000000000);
      const expectedRequest = Buffer.from(` { "params" : ${result}, "method" : "fixture/large-binary", "\\u0069d" : ${request.id} } `);
      assert.deepEqual(bytes, expectedRequest);
      socket.send(Buffer.from(` { "result" : ${result}, "\\u0069d" : ${request.id} } `), { binary: true });
    }
  });
  await state.proxy.inspectThread(threadId);
  state.desktop.send(rawRequest, { binary: true });
  await waitFor(() => state.messages.some(message => message.id === -1000000000));
  assert.deepEqual(state.rawMessages.at(-1), expectedReply);
  assert.equal(state.binaryFrames.at(-1), true);
  assertTrackingCleared(state);
});
