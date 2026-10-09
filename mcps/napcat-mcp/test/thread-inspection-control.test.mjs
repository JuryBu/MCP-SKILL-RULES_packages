import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";
import { createCodexThreadBridge } from "../src/codex-thread-bridge.mjs";

const FIXTURE_THREAD_ID = "inspection-fixture-thread";
const FIXTURE_TOKEN = "inspection-fixture-control-token";
const FIXTURE_SUBSCRIPTION = {
  taskId: "inspection-fixture-task",
  generation: 1,
  threadId: FIXTURE_THREAD_ID,
  localRole: "development",
  sourceMachine: "training",
  targetMachine: "development",
  trustedPeerQq: "1000000001",
};
const TEST_OPTIONS = { timeout: 10000 };

function threadSummary(type, turns = []) {
  return {
    id: FIXTURE_THREAD_ID,
    status: type === "active"
      ? { type, activeFlags: ["waitingOnApproval", "waitingOnUserInput"] }
      : { type },
    preview: "Isolated inspection fixture",
    modelProvider: "fixture-provider",
    turns,
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Inspection fixture deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function closeServer(server) {
  if (!server?.listening && !server?.address?.()) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function terminateSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.terminate();
  await closed;
}

async function createFixture(context, options = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thread-inspection-control-"));
  const journalPath = path.join(temporaryRoot, "wake-journal.json");
  const reservations = [];
  const bridges = [];
  const desktops = [];
  let upstream;
  let proxy;
  const fixture = {
    requests: [],
    httpRequests: [],
    desktopMessages: [],
    journalMutations: [],
    connectionCount: 0,
    replyCount: 0,
    readReply: options.readReply ?? { result: { thread: threadSummary("idle") } },
    resumeThread: options.resumeThread ?? threadSummary("idle"),
    onRpc: null,
  };

  context.after(async () => {
    try {
      for (const bridge of bridges) await bridge.close();
      const sockets = new Set(desktops);
      for (const client of proxy?.clients ?? []) {
        sockets.add(client.downstream);
        if (client.upstream) sockets.add(client.upstream);
      }
      for (const socket of upstream?.clients ?? []) sockets.add(socket);
      proxy?.controlServer?.closeAllConnections?.();
      await Promise.all([...sockets].map(terminateSocket));
      await proxy?.close();
    } finally {
      await Promise.all([...(upstream?.clients ?? [])].map(terminateSocket));
      await closeServer(upstream);
      await Promise.all(reservations.map(closeServer));
      assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith("thread-inspection-control-"));
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    assert.equal(proxy?.closed, true);
    assert.equal(upstream.clients.size, 0);
    assert.ok(desktops.every((desktop) => desktop.readyState === WebSocket.CLOSED));
    assert.equal(fs.existsSync(temporaryRoot), false);
  });

  const storedJournal = createWakeJournal({ filePath: journalPath });
  storedJournal.registerSubscription(FIXTURE_SUBSCRIPTION);
  storedJournal.writeWake("inspection-fixture-existing-wake", {
    ...FIXTURE_SUBSCRIPTION,
    status: "completed",
    turnId: "inspection-fixture-existing-turn",
    messageVisibility: "visible",
    pendingThroughSequence: 1,
  });
  const journal = { ...storedJournal };
  for (const method of ["registerSubscription", "claimWake", "writeWake", "write"]) {
    journal[method] = (...args) => {
      fixture.journalMutations.push(method);
      return storedJournal[method](...args);
    };
  }
  fixture.journal = journal;
  fixture.journalPath = journalPath;

  fixture.reply = (socket, request, envelope) => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...envelope }));
    fixture.replyCount += 1;
    socket.send(JSON.stringify({ method: "fixture/rpc-replied", params: { requestId: request.id } }));
  };
  upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  upstream.on("connection", (socket) => {
    fixture.connectionCount += 1;
    const connectionId = fixture.connectionCount;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString("utf8"));
      fixture.requests.push({ connectionId, ...request });
      if (request.method === "initialize") {
        fixture.reply(socket, request, { result: { serverInfo: { name: "fixture-app-server" } } });
      } else if (fixture.onRpc?.(socket, request) === true) {
        return;
      } else if (request.method === "thread/read") {
        const envelope = typeof fixture.readReply === "function"
          ? fixture.readReply(request)
          : fixture.readReply;
        fixture.reply(socket, request, envelope);
      } else if (request.method === "thread/resume") {
        fixture.reply(socket, request, { result: { thread: fixture.resumeThread } });
      } else if (request.method === "turn/start" || request.method === "turn/steer") {
        fixture.reply(socket, request, {
          result: {
            turn: {
              id: request.params.expectedTurnId ?? "inspection-fixture-started-turn",
              status: "inProgress",
            },
          },
        });
      } else if (Object.hasOwn(request, "id")) {
        fixture.reply(socket, request, { result: { echoed: request.method, params: request.params } });
      }
    });
  });
  await once(upstream, "listening");

  for (let index = 0; index < 2; index += 1) {
    const reservation = net.createServer();
    reservations.push(reservation);
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
  }
  const [downstreamPort, controlPort] = reservations.map((server) => server.address().port);
  await Promise.all(reservations.map(closeServer));
  proxy = createCodexAppServerProxy({
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    downstreamPort,
    controlPort,
    controlToken: FIXTURE_TOKEN,
    writerEpoch: "inspection-fixture-writer",
    requestTimeoutMs: 2000,
    resumeRequestTimeoutMs: 2000,
    journal,
  });
  fixture.proxy = proxy;
  await proxy.start();
  fixture.controlUrl = `http://127.0.0.1:${controlPort}`;
  proxy.controlServer.prependListener("request", (request) => {
    const entry = { method: request.method, url: request.url, authorization: request.headers.authorization, body: null };
    fixture.httpRequests.push(entry);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      entry.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    });
  });
  fixture.createBridge = (controlToken = FIXTURE_TOKEN) => {
    const bridge = createCodexThreadBridge({
      mode: "transparent_proxy",
      controlUrl: fixture.controlUrl,
      controlToken,
      requestTimeoutMs: 3000,
      env: {},
    });
    bridges.push(bridge);
    return bridge;
  };
  fixture.bridge = fixture.createBridge();
  fixture.post = async (route, body, authorization = `Bearer ${FIXTURE_TOKEN}`) => {
    const response = await fetch(`${fixture.controlUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "close",
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  };
  if (!options.noDesktop) {
    const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
    fixture.desktop = desktop;
    desktops.push(desktop);
    desktop.on("message", (bytes) => fixture.desktopMessages.push(JSON.parse(bytes.toString("utf8"))));
    await once(desktop, "open");
    desktop.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "inspection-fixture-initialize",
      method: "initialize",
      params: { clientInfo: { name: "fixture-desktop", version: "0.0.0" } },
    }));
    await waitFor(() => fixture.desktopMessages.some((message) => message.id === "inspection-fixture-initialize"));
    await waitFor(() => proxy.status().readyClientCount === 1);
    desktop.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    await waitFor(() => fixture.requests.some((request) => request.method === "initialized"));
  }
  fixture.initialJournal = fs.readFileSync(journalPath);
  fixture.initialJournalMtime = fs.statSync(journalPath).mtimeMs;
  fixture.initialJournalFiles = fs.readdirSync(temporaryRoot).sort();
  fixture.journalMutations.length = 0;
  fixture.rpcRequests = () => fixture.requests.filter((request) => !["initialize", "initialized"].includes(request.method));
  fixture.settle = async () => {
    if (fixture.desktop) {
      await waitFor(() => fixture.desktopMessages.filter((message) => message.method === "fixture/rpc-replied").length === fixture.replyCount);
    }
  };
  fixture.assertJournalUnchanged = () => {
    assert.deepEqual(fixture.journalMutations, []);
    assert.deepEqual(fs.readFileSync(journalPath), fixture.initialJournal);
    assert.equal(fs.statSync(journalPath).mtimeMs, fixture.initialJournalMtime);
    assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), fixture.initialJournalFiles);
  };
  return fixture;
}

async function assertReadOnlyInspection(fixture, readCount) {
  await fixture.settle();
  const requests = fixture.rpcRequests();
  assert.deepEqual(requests.map((request) => request.method), Array(readCount).fill("thread/read"));
  for (const request of requests) {
    assert.equal(request.connectionId, 1);
    assert.deepEqual(request.params, { threadId: FIXTURE_THREAD_ID, includeTurns: false });
  }
  const desktopCount = fixture.desktop ? 1 : 0;
  assert.equal(fixture.connectionCount, desktopCount);
  assert.equal(fixture.requests.filter((request) => request.method === "initialize").length, desktopCount);
  assert.equal(fixture.desktopMessages.filter((message) => Object.hasOwn(message, "result") || Object.hasOwn(message, "error")).length, desktopCount);
  assert.ok(fixture.httpRequests.every((request) => request.method === "POST" && request.url === "/v1/threads/inspect"));
  assert.ok(fixture.httpRequests.every((request) => request.body.threadId === FIXTURE_THREAD_ID));
  fixture.assertJournalUnchanged();
}

const officialStates = [
  { type: "idle", expected: "idle", history: "inProgress" },
  { type: "active", expected: "busy", history: "completed" },
  { type: "notLoaded", expected: "not_loaded", history: "inProgress" },
  { type: "systemError", expected: "system_error", history: "inProgress" },
  { type: "fixtureFutureStatus", expected: "unknown", history: "completed" },
];

for (const state of officialStates) {
  test(`real HTTP inspection maps official ${state.type} ahead of historical ${state.history}`, TEST_OPTIONS, async (context) => {
    const thread = threadSummary(state.type, [{ id: "inspection-fixture-historical-turn", status: state.history }]);
    const fixture = await createFixture(context, { readReply: { result: { thread } } });
    const direct = await fixture.post("/v1/threads/inspect", { threadId: FIXTURE_THREAD_ID });
    assert.equal(direct.status, 200);
    assert.deepEqual(direct.body, { ok: true, threadId: FIXTURE_THREAD_ID, found: true, thread });
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const inspected = await fixture.bridge.inspectThread(FIXTURE_THREAD_ID);
      assert.equal(inspected.threadId, FIXTURE_THREAD_ID);
      assert.equal(inspected.status, state.expected);
      assert.equal(inspected.busy, state.expected === "busy");
      assert.equal(inspected.found, true);
      assert.deepEqual(inspected.thread, thread);
      assert.deepEqual(inspected.raw, direct.body);
    }
    assert.equal(fixture.httpRequests.length, 3);
    assert.ok(fixture.httpRequests.every((request) => request.authorization === `Bearer ${FIXTURE_TOKEN}`));
    await assertReadOnlyInspection(fixture, 3);
  });
}

test("thread-not-found RPC becomes found:false without resuming or rewriting wake state", TEST_OPTIONS, async (context) => {
  const fixture = await createFixture(context, {
    readReply: { error: { code: -32602, message: `thread not found: ${FIXTURE_THREAD_ID}` } },
  });
  const direct = await fixture.post("/v1/threads/inspect", { threadId: FIXTURE_THREAD_ID });
  assert.equal(direct.status, 200);
  assert.deepEqual(direct.body, { ok: true, threadId: FIXTURE_THREAD_ID, found: false, thread: null });
  const inspected = await fixture.bridge.inspectThread(FIXTURE_THREAD_ID);
  assert.equal(inspected.status, "not_found");
  assert.equal(inspected.found, false);
  assert.equal(inspected.busy, false);
  assert.equal(inspected.thread, null);
  await assertReadOnlyInspection(fixture, 2);
});

const rpcErrors = [
  { code: -32001, message: "fixture permission denied", data: { reason: "fixture-denial" } },
  { code: -32601, message: "method not found", data: { method: "thread/read" } },
  { code: -32002, message: "fixture storage error", data: { retryable: false } },
];

for (const rpcError of rpcErrors) {
  test(`inspection preserves non-missing RPC error ${rpcError.code}: ${rpcError.message}`, TEST_OPTIONS, async (context) => {
    const fixture = await createFixture(context, { readReply: { error: rpcError } });
    const direct = await fixture.post("/v1/threads/inspect", { threadId: FIXTURE_THREAD_ID });
    assert.equal(direct.status, 500);
    assert.equal(direct.body.ok, false);
    assert.equal(direct.body.error.code, "APP_SERVER_RPC_ERROR");
    assert.equal(direct.body.error.message, rpcError.message);
    assert.deepEqual(direct.body.error.details.rpcError, rpcError);
    await assert.rejects(() => fixture.bridge.inspectThread(FIXTURE_THREAD_ID), (error) => {
      assert.equal(error.code, "APP_SERVER_RPC_ERROR");
      assert.equal(error.message, rpcError.message);
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.details.route, "/v1/threads/inspect");
      assert.deepEqual(error.details.remoteError.details.rpcError, rpcError);
      return true;
    });
    await assertReadOnlyInspection(fixture, 2);
  });
}

const malformedResults = [
  { name: "null result", result: null },
  { name: "missing thread", result: {} },
  { name: "null thread", result: { thread: null } },
  { name: "array thread", result: { thread: [] } },
  { name: "scalar thread", result: { thread: "fixture-malformed-summary" } },
  { name: "missing id", result: { thread: { status: { type: "idle" } } } },
  { name: "non-string id", result: { thread: { id: 1, status: { type: "idle" } } } },
  {
    name: "wrong id with a misleading nested match",
    result: {
      threadId: FIXTURE_THREAD_ID,
      thread: {
        id: "inspection-fixture-other-thread",
        status: { type: "active", activeFlags: [] },
        metadata: { id: FIXTURE_THREAD_ID, status: "idle" },
      },
    },
  },
];

for (const malformed of malformedResults) {
  test(`inspection rejects ${malformed.name} as INVALID_THREAD_SUMMARY`, TEST_OPTIONS, async (context) => {
    const fixture = await createFixture(context, { readReply: { result: malformed.result } });
    const direct = await fixture.post("/v1/threads/inspect", { threadId: FIXTURE_THREAD_ID });
    assert.equal(direct.status, 500);
    assert.equal(direct.body.ok, false);
    assert.equal(direct.body.error.code, "INVALID_THREAD_SUMMARY");
    await assert.rejects(() => fixture.bridge.inspectThread(FIXTURE_THREAD_ID), (error) => {
      assert.equal(error.code, "INVALID_THREAD_SUMMARY");
      assert.equal(error.outcomeUnknown, false);
      assert.equal(error.details.route, "/v1/threads/inspect");
      return true;
    });
    await assertReadOnlyInspection(fixture, 2);
  });
}

test("repeated and concurrent inspections issue only fresh includeTurns:false reads on the Desktop session", TEST_OPTIONS, async (context) => {
  const fixture = await createFixture(context);
  for (const state of officialStates) {
    fixture.readReply = { result: { thread: threadSummary(state.type) } };
    const inspected = await fixture.bridge.inspectThread(FIXTURE_THREAD_ID);
    assert.equal(inspected.status, state.expected);
    assert.equal(inspected.found, true);
  }
  const active = threadSummary("active");
  fixture.readReply = { result: { thread: active } };
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => fixture.bridge.inspectThread(FIXTURE_THREAD_ID)));
  assert.ok(concurrent.every((inspected) => inspected.status === "busy" && inspected.found === true));
  for (const inspected of concurrent) assert.deepEqual(inspected.thread, active);
  assert.equal(fixture.httpRequests.length, 9);
  assert.equal(new Set(fixture.rpcRequests().map((request) => request.id)).size, 9);
  await assertReadOnlyInspection(fixture, 9);
});

for (const desktopFails of [false, true]) {
  test(`Desktop thread/read survives an inspect RPC id collision, Desktop error=${desktopFails}`, TEST_OPTIONS, async (context) => {
    const fixture = await createFixture(context);
    const inspectedThread = threadSummary("active");
    const desktopEnvelope = desktopFails
      ? { error: { code: -32042, message: "fixture Desktop RPC failure", data: { origin: "desktop" } } }
      : { result: { thread: threadSummary("idle"), origin: "desktop" } };
    let pending;
    let forwardedDesktopId;
    fixture.onRpc = (socket, request) => {
      if (request.method !== "thread/read") return false;
      if (request.params.includeTurns === false) {
        pending = { socket, request };
        fixture.desktop.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          method: "thread/read",
          params: { threadId: FIXTURE_THREAD_ID, includeTurns: true },
        }));
      } else {
        forwardedDesktopId = request.id;
        fixture.reply(socket, request, desktopEnvelope);
        fixture.reply(pending.socket, pending.request, { result: { thread: inspectedThread } });
      }
      return true;
    };
    const inspected = await fixture.bridge.inspectThread(FIXTURE_THREAD_ID);
    await fixture.settle();
    assert.equal(inspected.status, "busy");
    assert.deepEqual(inspected.thread, inspectedThread);
    assert.notEqual(forwardedDesktopId, pending.request.id);
    const desktopReplies = fixture.desktopMessages.filter((message) => message.id === pending.request.id);
    assert.deepEqual(desktopReplies, [{ jsonrpc: "2.0", id: pending.request.id, ...desktopEnvelope }]);
    assert.equal(fixture.connectionCount, 1);
    assert.deepEqual(fixture.rpcRequests().map((request) => request.params), [
      { threadId: FIXTURE_THREAD_ID, includeTurns: false },
      { threadId: FIXTURE_THREAD_ID, includeTurns: true },
    ]);
    assert.deepEqual(fixture.rpcRequests().map((request) => request.method), ["thread/read", "thread/read"]);
    assert.deepEqual(fixture.httpRequests.map((request) => request.url), ["/v1/threads/inspect"]);
    fixture.assertJournalUnchanged();
  });
}

test("missing and invalid controlToken fail authentication before any thread RPC", TEST_OPTIONS, async (context) => {
  const fixture = await createFixture(context);
  for (const authorization of [null, "Bearer inspection-fixture-invalid-token"]) {
    const direct = await fixture.post("/v1/threads/inspect", { threadId: FIXTURE_THREAD_ID }, authorization);
    assert.equal(direct.status, 401);
    assert.equal(direct.body.ok, false);
    assert.equal(direct.body.error.code, "UNAUTHORIZED");
  }
  const unauthorizedBridge = fixture.createBridge("inspection-fixture-invalid-token");
  await assert.rejects(() => unauthorizedBridge.inspectThread(FIXTURE_THREAD_ID), (error) => {
    assert.equal(error.code, "UNAUTHORIZED");
    assert.equal(error.details.status, 401);
    return true;
  });
  assert.equal(fixture.httpRequests.length, 3);
  await assertReadOnlyInspection(fixture, 0);
});

test("no initialized Desktop fails explicitly without creating an App-server connection", TEST_OPTIONS, async (context) => {
  const fixture = await createFixture(context, { noDesktop: true });
  const direct = await fixture.post("/v1/threads/inspect", { threadId: FIXTURE_THREAD_ID });
  assert.equal(direct.status, 500);
  assert.equal(direct.body.error.code, "NO_DESKTOP_CLIENT");
  await assert.rejects(() => fixture.bridge.inspectThread(FIXTURE_THREAD_ID), (error) => {
    assert.equal(error.code, "NO_DESKTOP_CLIENT");
    assert.equal(error.outcomeUnknown, false);
    return true;
  });
  await assertReadOnlyInspection(fixture, 0);
});

for (const wakeMethod of ["turn/start", "turn/steer"]) {
  test(`real wake retains resume and ${wakeMethod} after a read-only notLoaded inspection`, TEST_OPTIONS, async (context) => {
    const activeTurnId = "inspection-fixture-active-turn";
    const fixture = await createFixture(context, {
      readReply: { result: { thread: threadSummary("notLoaded") } },
      resumeThread: wakeMethod === "turn/start"
        ? threadSummary("idle")
        : threadSummary("active", [{ id: activeTurnId, status: "inProgress" }]),
    });
    const inspected = await fixture.bridge.inspectThread(FIXTURE_THREAD_ID);
    assert.equal(inspected.status, "not_loaded");
    assert.equal(inspected.found, true);
    await assertReadOnlyInspection(fixture, 1);
    const wakeInput = {
      ...FIXTURE_SUBSCRIPTION,
      wakeId: "inspection-fixture-new-wake",
      prompt: "Isolated fixture wake request",
      pendingThroughSequence: 2,
      pendingThroughTime: "2026-01-01T00:00:00.000Z",
    };
    const awakened = await fixture.bridge.wake(wakeInput);
    assert.equal(awakened.outcome, "accepted");
    assert.equal(awakened.started, true);
    assert.equal(awakened.status, "busy");
    assert.equal(awakened.turn.id, wakeMethod === "turn/start" ? "inspection-fixture-started-turn" : activeTurnId);
    const duplicate = await fixture.bridge.wake(wakeInput);
    assert.equal(duplicate.duplicateSuppressed, true);
    assert.equal(duplicate.started, false);
    await fixture.settle();
    const requests = fixture.rpcRequests();
    assert.deepEqual(requests.map((request) => request.method), ["thread/read", "thread/resume", wakeMethod]);
    assert.ok(requests.every((request) => request.connectionId === 1));
    assert.deepEqual(requests[1].params, { threadId: FIXTURE_THREAD_ID, excludeTurns: true });
    assert.equal(requests[2].params.threadId, FIXTURE_THREAD_ID);
    assert.deepEqual(requests[2].params.input, [{ type: "text", text: wakeInput.prompt }]);
    if (wakeMethod === "turn/steer") assert.equal(requests[2].params.expectedTurnId, activeTurnId);
    const recorded = fixture.journal.getWake(wakeInput.wakeId);
    assert.equal(recorded.status, "accepted");
    assert.equal(recorded.injectionMethod, wakeMethod);
    assert.equal(recorded.turnId, awakened.turn.id);
    assert.deepEqual(fixture.journal.getWake("inspection-fixture-existing-wake"), JSON.parse(fixture.initialJournal.toString("utf8")).wakes["inspection-fixture-existing-wake"]);
    assert.ok(fixture.journalMutations.length > 0);
    assert.deepEqual(fixture.httpRequests.map((request) => request.url), [
      "/v1/threads/inspect", "/v1/subscriptions", "/v1/wakes", "/v1/subscriptions", "/v1/wakes",
    ]);
  });
}
