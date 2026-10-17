import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  CodexAppServerProxy,
  DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES,
  DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES,
  createCodexAppServerProxy,
  createDesktopTransportBudgetError,
  createWakeJournal,
} from "../src/codex-app-server-proxy.mjs";
import { createProxyClassCodeParticipant } from "../src/proxy-live-code-runtime.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  });
}

test("wake journal replaces a subscription only when generation increases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-subscription-generation-test-"));
  const journal = createWakeJournal({ filePath: path.join(root, "wake-journal.json") });
  const base = {
    taskId: "task-generation-test",
    generation: 1,
    threadId: "thread-g1",
    localRole: "development",
    sourceMachine: "training",
    targetMachine: "development",
    trustedPeerQq: "1000000001",
  };
  try {
    assert.equal(journal.registerSubscription(base).created, true);
    const replaced = journal.registerSubscription({ ...base, generation: 2, threadId: "thread-g2" });
    assert.equal(replaced.updated, true);
    assert.equal(replaced.subscription.threadId, "thread-g2");
    assert.throws(
      () => journal.registerSubscription({ ...base, threadId: "thread-stale" }),
      (error) => error.code === "SUBSCRIPTION_CONFLICT",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("established upstream loss closes Desktop so Codex performs an authoritative resync", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  let upstream = null;
  const startUpstream = async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8"));
        if (message.method === "initialize") {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
        } else if (Object.hasOwn(message, "id")) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
        }
      });
    });
    await new Promise((resolve, reject) => {
      if (server.address()) {
        resolve();
        return;
      }
      server.once("listening", resolve);
      server.once("error", reject);
    });
    upstream = server;
    return server;
  };
  const stopUpstream = async () => {
    if (!upstream) return;
    const server = upstream;
    upstream = null;
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  };

  await startUpstream();
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "reconnect-test-token",
    reconnectInitialMs: 50,
    reconnectMaxMs: 100,
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  const responses = [];
  desktop.on("message", (data) => responses.push(JSON.parse(data.toString("utf8"))));
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    await stopUpstream();
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "desktop" } } }));
  await waitFor(() => responses.some((message) => message.id === 1));
  await waitFor(() => proxy.status().readyClientCount === 1);

  await stopUpstream();
  await waitFor(() => desktop.readyState === WebSocket.CLOSED);
  assert.equal(proxy.status().clientCount, 0);
  await startUpstream();
  const resumedDesktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(() => resumedDesktop.terminate());
  const resumedResponses = [];
  resumedDesktop.on("message", (data) => resumedResponses.push(JSON.parse(data.toString("utf8"))));
  await new Promise((resolve, reject) => {
    resumedDesktop.once("open", resolve);
    resumedDesktop.once("error", reject);
  });
  resumedDesktop.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} }));
  await waitFor(() => resumedResponses.some((message) => message.id === 2));
  resumedDesktop.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "desktop/after-restart", params: {} }));
  await waitFor(() => resumedResponses.some((message) => message.id === 3));
  assert.equal(resumedResponses.find((message) => message.id === 3).result.echoed, "desktop/after-restart");
  assert.equal(resumedDesktop.readyState, WebSocket.OPEN);
});

test("downstream heartbeat terminates a half-open Desktop connection", { timeout: 8000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("listening", resolve);
    upstream.once("error", reject);
  });
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "heartbeat-test-token",
    heartbeatIntervalMs: 1000,
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`, { autoPong: false });
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  await waitFor(() => desktop.readyState === WebSocket.CLOSED, 5000);
  assert.equal(proxy.status().clientCount, 0);
  assert.equal(proxy.status().lastError.code, "DOWNSTREAM_HEARTBEAT_TIMEOUT");
});

test("transparent proxy accepts Desktop before App Server starts and replays queued initialization", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "boot-race-test-token",
    reconnectInitialMs: 50,
    reconnectMaxMs: 100,
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  const responses = [];
  desktop.on("message", (data) => responses.push(JSON.parse(data.toString("utf8"))));
  let upstream = null;
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    if (upstream) {
      for (const socket of upstream.clients) socket.terminate();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 31, method: "initialize", params: { clientInfo: { name: "desktop" } } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(desktop.readyState, WebSocket.OPEN);

  upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once("listening", resolve);
    upstream.once("error", reject);
  });
  await waitFor(() => responses.some((message) => message.id === 31));
  assert.equal(desktop.readyState, WebSocket.OPEN);
  assert.equal(proxy.status().readyClientCount, 1);
});

test("transparent proxy forwards Desktop traffic and suppresses duplicate wake_id", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-test-"));
  const token = "test-token-that-is-long-enough";
  let turnStartCount = 0;
  let threadResumeCount = 0;
  const threadResumeParams = [];
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
      } else if (message.method === "thread/resume") {
        threadResumeCount += 1;
        threadResumeParams.push(message.params);
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { thread: { id: message.params.threadId, status: "idle", turns: [] } },
        }));
      } else if (message.method === "turn/start") {
        turnStartCount += 1;
        const turnId = `turn-${turnStartCount}`;
        setTimeout(() => socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { turn: { id: turnId, status: "inProgress" } },
        })), 40);
      } else if (Object.hasOwn(message, "id")) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }));
      }
    });
  });

  const journal = createWakeJournal({ filePath: path.join(temporaryRoot, "wake-journal.json") });
  const maintenancePath = path.join(temporaryRoot, "maintenance.json");
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: token,
    journal,
    maintenanceFilePath: maintenancePath,
  });
  await proxy.start();

  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  const desktopResponses = [];
  desktop.on("message", (data) => desktopResponses.push(JSON.parse(data.toString("utf8"))));
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "initialize", params: { clientInfo: { name: "desktop" } } }));
  await waitFor(() => desktopResponses.some((message) => message.id === 77));
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 78, method: "desktop/passthrough", params: {} }));
  await waitFor(() => desktopResponses.some((message) => message.id === 78));
  assert.equal(desktopResponses.find((message) => message.id === 78).result.echoed, "desktop/passthrough");

  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const wakeBody = {
    taskId: "task-test-1",
    generation: 1,
    threadId: "thread-test",
    localRole: "development",
    sourceMachine: "training",
    targetMachine: "development",
    trustedPeerQq: "1000000001",
    wakeId: "wake-test-1",
    pendingThroughSequence: 100,
    pendingThroughTime: "2026-08-02T00:00:00.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-test-1",
  };
  const subscription = await fetch(`http://127.0.0.1:${controlPort}/v1/subscriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify(wakeBody),
  }).then((response) => response.json());
  assert.equal(subscription.ok, true);
  assert.equal(subscription.readyClientCount, 1);
  assert.equal(threadResumeCount, 0);
  const first = await fetch(`http://127.0.0.1:${controlPort}/v1/wakes`, {
    method: "POST",
    headers,
    body: JSON.stringify(wakeBody),
  }).then((response) => response.json());
  assert.equal(first.ok, true);
  assert.equal(first.outcome, "accepted");
  assert.equal(first.started, true);
  assert.equal(first.turn.id, "turn-1");
  assert.equal(turnStartCount, 1);
  assert.equal(threadResumeCount, 1);
  assert.deepEqual(threadResumeParams, [{ threadId: "thread-test", excludeTurns: true }]);

  const concurrentBody = {
    ...wakeBody,
    wakeId: "wake-test-2",
    pendingThroughSequence: 101,
    pendingThroughTime: "2026-08-02T00:00:01.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-test-2",
  };
  const concurrent = await Promise.all([1, 2].map(() => fetch(`http://127.0.0.1:${controlPort}/v1/wakes`, {
    method: "POST",
    headers,
    body: JSON.stringify(concurrentBody),
  }).then((response) => response.json())));
  assert.equal(concurrent.filter((result) => result.started === true).length, 1);
  assert.equal(concurrent.filter((result) => result.duplicateSuppressed === true).length, 1);
  assert.equal(turnStartCount, 2);

  const conflictingSubscription = await fetch(`http://127.0.0.1:${controlPort}/v1/subscriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...wakeBody, threadId: "different-thread" }),
  });
  assert.equal(conflictingSubscription.status, 409);

  fs.writeFileSync(maintenancePath, JSON.stringify({ reasons: { test: { message: "pause" } } }), "utf8");
  const paused = await fetch(`http://127.0.0.1:${controlPort}/v1/wakes`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...wakeBody,
      wakeId: "wake-test-paused",
      pendingThroughSequence: 102,
      pendingThroughTime: "2026-08-02T00:00:02.000Z",
      prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-test-paused",
    }),
  });
  assert.equal(paused.status, 503);
  assert.equal(turnStartCount, 2);

  const duplicate = await fetch(`http://127.0.0.1:${controlPort}/v1/wakes`, {
    method: "POST",
    headers,
    body: JSON.stringify(wakeBody),
  }).then((response) => response.json());
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.started, false);
  assert.equal(duplicate.duplicateSuppressed, true);
  assert.equal(turnStartCount, 2);

  const unauthorized = await fetch(`http://127.0.0.1:${controlPort}/status`);
  assert.equal(unauthorized.status, 401);
  const journalState = JSON.parse(fs.readFileSync(path.join(temporaryRoot, "wake-journal.json"), "utf8"));
  assert.equal(journalState.wakes["wake-test-1"].status, "accepted");
  assert.equal(journalState.wakes["wake-test-2"].status, "accepted");
  assert.equal(journalState.wakes["wake-test-paused"].status, "failed_before_send");
});

test("wake visibility only controls client ids while busy and idle injection semantics stay identical", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-visibility-test-"));
  const steerRequests = [];
  const startRequests = [];
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    } else if (message.method === "thread/resume") {
      const idle = ["thread-visible-idle", "thread-hidden-idle"].includes(message.params.threadId);
      const missingTurnId = message.params.threadId === "thread-busy-without-turn-id";
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            status: idle ? "idle" : "inProgress",
            turns: idle || missingTurnId ? [] : [{ id: "active-turn-1", status: "inProgress" }],
          },
        },
      }));
    } else if (message.method === "thread/turns/list") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { data: [] } }));
    } else if (message.method === "turn/steer") {
      steerRequests.push(message.params);
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { turn: { id: message.params.expectedTurnId, status: "inProgress" } },
      }));
    } else if (message.method === "turn/start") {
      startRequests.push(message.params);
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { turn: { id: "legacy-hidden-turn", status: "inProgress" } },
      }));
    }
  }));
  const journalPath = path.join(temporaryRoot, "wake-journal.json");
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "visibility-test-token",
    journal: createWakeJournal({ filePath: journalPath }),
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);

  const wake = {
    taskId: "task-visibility",
    generation: 1,
    threadId: "thread-visibility",
    localRole: "development",
    sourceMachine: "training",
    targetMachine: "development",
    trustedPeerQq: "1000000001",
    pendingThroughSequence: 300,
    pendingThroughTime: "2026-08-03T00:00:00.000Z",
  };
  const visible = await proxy.wakeThread({
    ...wake,
    wakeId: "wake-visible",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-visible",
  });
  assert.equal(visible.injectionMethod, "turn/steer");
  assert.equal(visible.messageVisibility, "visible");
  assert.match(visible.clientUserMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(steerRequests.length, 1);
  assert.equal(steerRequests[0].expectedTurnId, "active-turn-1");
  assert.equal(steerRequests[0].clientUserMessageId, visible.clientUserMessageId);

  const visibleIdle = await proxy.wakeThread({
    ...wake,
    taskId: "task-visible-idle",
    threadId: "thread-visible-idle",
    wakeId: "wake-visible-idle",
    pendingThroughSequence: 301,
    pendingThroughTime: "2026-08-03T00:00:01.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-visible-idle",
  });
  assert.equal(visibleIdle.injectionMethod, "turn/start");
  assert.equal(visibleIdle.messageVisibility, "visible");
  assert.match(visibleIdle.clientUserMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(startRequests.length, 1);
  assert.equal(startRequests[0].clientUserMessageId, visibleIdle.clientUserMessageId);

  const hiddenIdle = await proxy.wakeThread({
    ...wake,
    taskId: "task-hidden-idle",
    threadId: "thread-hidden-idle",
    wakeId: "wake-hidden-idle",
    pendingThroughSequence: 302,
    pendingThroughTime: "2026-08-03T00:00:02.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-hidden-idle",
    messageVisibility: "hidden",
  });
  assert.equal(hiddenIdle.injectionMethod, "turn/start");
  assert.equal(hiddenIdle.messageVisibility, "hidden");
  assert.equal(hiddenIdle.clientUserMessageId, null);
  assert.equal(startRequests.length, 2);
  assert.match(startRequests[1].clientUserMessageId, /^[0-9a-f-]{36}$/i);

  const busyWithoutTurnId = await proxy.wakeThread({
    ...wake,
    taskId: "task-busy-without-turn-id",
    threadId: "thread-busy-without-turn-id",
    wakeId: "wake-busy-without-turn-id",
    pendingThroughSequence: 303,
    pendingThroughTime: "2026-08-03T00:00:03.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-busy-without-turn-id",
  });
  assert.equal(busyWithoutTurnId.outcome, "busy");
  assert.equal(busyWithoutTurnId.started, false);
  assert.equal(startRequests.length, 2);
  assert.equal(steerRequests.length, 1);

  const hiddenBusy = await proxy.wakeThread({
    ...wake,
    taskId: "task-hidden-busy",
    wakeId: "wake-hidden-busy",
    pendingThroughSequence: 304,
    pendingThroughTime: "2026-08-03T00:00:04.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-hidden-busy",
    messageVisibility: "hidden",
  });
  assert.equal(hiddenBusy.injectionMethod, "turn/steer");
  assert.equal(hiddenBusy.messageVisibility, "hidden");
  assert.equal(hiddenBusy.clientUserMessageId, null);
  assert.equal(hiddenBusy.started, true);
  assert.equal(startRequests.length, 2);
  assert.equal(steerRequests.length, 2);
  assert.equal(steerRequests[1].expectedTurnId, "active-turn-1");
  assert.match(steerRequests[1].clientUserMessageId, /^[0-9a-f-]{36}$/i);

  const state = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(state.wakes["wake-visible"].clientUserMessageId, visible.clientUserMessageId);
  assert.equal(state.wakes["wake-visible-idle"].clientUserMessageId, visibleIdle.clientUserMessageId);
  assert.equal(state.wakes["wake-hidden-idle"].clientUserMessageId, null);
  assert.equal(state.wakes["wake-busy-without-turn-id"].status, "failed_before_send");
  assert.equal(state.wakes["wake-hidden-busy"].status, "accepted");
  assert.equal(state.wakes["wake-hidden-busy"].clientUserMessageId, null);
});

test("failed-before-send wake may adopt a newly configured visibility mode", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-proxy-visibility-retry-"));
  const journalPath = path.join(temporaryRoot, "wake-journal.json");
  try {
    const journal = createWakeJournal({ filePath: journalPath });
    const wake = {
      wakeId: "wake-visibility-retry",
      taskId: "task-visibility-retry",
      generation: 1,
      threadId: "thread-visibility-retry",
      promptSha256: "a".repeat(64),
      pendingThroughSequence: 400,
      pendingThroughTime: "2026-08-03T00:00:04.000Z",
    };
    const hidden = journal.claimWake({ ...wake, messageVisibility: "hidden" });
    assert.equal(hidden.wake.clientUserMessageId, null);
    journal.writeWake(wake.wakeId, { status: "failed_before_send" }, ["prepared"]);
    const visible = journal.claimWake({ ...wake, messageVisibility: "visible" });
    assert.equal(visible.acquired, true);
    assert.equal(visible.wake.messageVisibility, "visible");
    assert.match(visible.wake.clientUserMessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("slow thread resume uses its dedicated timeout without widening mutations", { timeout: 5000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-proxy-slow-resume-"));
  let turnStartCount = 0;
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    } else if (message.method === "thread/resume") {
      setTimeout(() => socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { thread: { id: message.params.threadId, status: "idle", turns: [] } },
      })), 120);
    } else if (message.method === "turn/start") {
      turnStartCount += 1;
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { turn: { id: "slow-resume-turn", status: "inProgress" } },
      }));
    }
  }));
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "slow-resume-token",
    requestTimeoutMs: 40,
    resumeRequestTimeoutMs: 300,
    journal: createWakeJournal({ filePath: path.join(temporaryRoot, "wake-journal.json") }),
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  const result = await proxy.wakeThread({
    taskId: "task-slow-resume",
    generation: 1,
    threadId: "thread-slow-resume",
    localRole: "development",
    sourceMachine: "training",
    targetMachine: "development",
    trustedPeerQq: "1000000001",
    wakeId: "wake-slow-resume",
    pendingThroughSequence: 1,
    pendingThroughTime: "2026-08-03T00:00:00.000Z",
    prompt: "[NAPCAT_TASK_WAKE] slow resume",
  });
  assert.equal(result.outcome, "accepted");
  assert.equal(turnStartCount, 1);
});

test("accepted turn with journal commit failure becomes unknown and is never resent", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  let turnStartCount = 0;
  let subscriptionRecord = null;
  let wakeRecord = null;
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    } else if (message.method === "thread/resume") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } }));
    } else if (message.method === "turn/start") {
      turnStartCount += 1;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-once", status: "inProgress" } } }));
    }
  }));
  const journal = {
    status: () => ({ wakeCount: wakeRecord ? 1 : 0 }),
    registerSubscription(input) {
      subscriptionRecord ??= { ...input };
      return { subscription: subscriptionRecord, created: subscriptionRecord === input };
    },
    claimWake(input) {
      if (wakeRecord) return { wake: wakeRecord, acquired: false };
      wakeRecord = { ...input, status: "prepared" };
      return { wake: wakeRecord, acquired: true };
    },
    writeWake(_wakeId, patch, expectedStatuses) {
      if (expectedStatuses && !expectedStatuses.includes(wakeRecord.status)) throw new Error("state conflict");
      if (patch.status === "accepted") throw new Error("simulated disk failure after App Server accepted");
      wakeRecord = { ...wakeRecord, ...patch };
      return wakeRecord;
    },
    getWake: () => wakeRecord,
  };
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "commit-failure-token",
    journal,
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  const wake = {
    taskId: "task-commit-failure",
    generation: 1,
    threadId: "thread-commit-failure",
    localRole: "development",
    sourceMachine: "training",
    targetMachine: "development",
    trustedPeerQq: "1000000001",
    wakeId: "wake-commit-failure",
    pendingThroughSequence: 200,
    pendingThroughTime: "2026-08-02T00:00:00.000Z",
    prompt: "[NAPCAT_TASK_WAKE]\nwake_id=wake-commit-failure",
  };
  await assert.rejects(
    () => proxy.wakeThread(wake),
    (error) => error?.code === "WAKE_JOURNAL_COMMIT_FAILED" && error.outcomeUnknown === true,
  );
  assert.equal(wakeRecord.status, "unknown");
  const retry = await proxy.wakeThread(wake);
  assert.equal(retry.outcome, "unknown");
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(turnStartCount, 1);
});

test("large upstream text frames are forwarded without JSON materialization", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const largeValue = "x".repeat(512 * 1024);
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort, maxPayload: 2 * 1024 * 1024 });
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    } else if (["large/result", "thread/read"].includes(message.method)) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { value: largeValue } }));
    }
  }));
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "large-frame-token",
    maxJsonParseBytes: 1024,
    maxDesktopResponseBytes: 64 * 1024,
    maxWebSocketPayloadBytes: 2 * 1024 * 1024,
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`, { maxPayload: 2 * 1024 * 1024 });
  const responses = [];
  desktop.on("message", (data) => responses.push(JSON.parse(data.toString("utf8"))));
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await waitFor(() => responses.some((message) => message.id === 1));
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "large/result", params: {} }));
  await waitFor(() => responses.some((message) => message.id === 2));
  assert.equal(responses.find((message) => message.id === 2).result.value.length, largeValue.length);
  assert.equal(proxy.status().limits.maxJsonParseBytes, 1024);
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "thread/read", params: { threadId: "large-history", includeTurns: true } }));
  await waitFor(() => responses.some(message => message.id === 3));
  assert.equal(responses.find(message => message.id === 3).error.data.reason, "DESKTOP_RESPONSE_BUDGET_EXCEEDED");
  assert.equal(desktop.readyState, WebSocket.OPEN);
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }));
  await waitFor(() => responses.some(message => message.id === 4));
  assert.deepEqual(responses.find(message => message.id === 4).result, {});
  assert.equal([...proxy.clients][0].desktopRequestIds.size, 0);
});

function desktopBudgetFixture(options = {}) {
  const events = [];
  const proxy = createCodexAppServerProxy({ controlToken: "isolated-budget-test", maxJsonParseBytes: 1024,
    maxDesktopTransportBytes: 1024, onEvent: event => events.push(event), ...options });
  const makeSocket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, sent: [],
    send(data, _options, callback) { this.sent.push(Buffer.from(data)); callback?.(); },
    close(code, reason) { this.readyState = WebSocket.CLOSING; this.closeCode = code; this.closeReason = reason; } });
  const downstream = makeSocket();
  const upstream = makeSocket();
  const client = { downstream, upstream, upstreamReady: true, initialized: true, initializationRequestId: null,
    desktopRequestIds: new Map(), forwardedRequestIds: new Map(), injected: new Map(), desktopRequestBytes: 0,
    queued: [], queuedBytes: 0, connectedAt: "fixture", closed: false,
    turnObserver: { observeUpstream() {}, markForwarded() {}, close() {} },
    wakeVisibility: { close() {} }, displayPolicy: { close() {} }, reasoningPlaceholder: { close() {} } };
  proxy.clients.add(client);
  proxy.outerRuntime = { upstream: (_client, _message, input) => input.projectionMessage,
    downstream() {}, closeClient() {}, orphanResponse() {} };
  return { proxy, client, downstream, upstream, events,
    track(requestId, method, upstreamId = requestId) {
      client.desktopRequestIds.set(requestId, { bytes: 16, method, upstreamId });
      client.desktopRequestBytes += 16;
      if (requestId !== upstreamId) client.forwardedRequestIds.set(upstreamId, requestId);
    },
    receive(message) {
      proxy._liveReceiveUpstream(client, upstream, null, Buffer.from(JSON.stringify(message)), false);
    } };
}

test("final Desktop transport has an independent 96 MiB default and hot adoption fallback", () => {
  assert.equal(DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES, 64 * 1024 * 1024);
  assert.equal(DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES, 96 * 1024 * 1024);
  assert.ok(DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES < 100 * 1024 * 1024);
  const fixture = desktopBudgetFixture({ maxDesktopTransportBytes: 200 * 1024 * 1024 });
  const proxy = createCodexAppServerProxy({ controlToken: "hot-budget-test", maxDesktopTransportBytes: 200 * 1024 * 1024 });
  assert.equal(proxy.maxDesktopTransportBytes, DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES);
  delete proxy.maxDesktopTransportBytes;
  const clients = proxy.clients;
  const outerRuntime = proxy.outerRuntime;
  const participant = createProxyClassCodeParticipant(proxy);
  class AdoptedProxy extends CodexAppServerProxy {}
  const snapshot = participant.activate(participant.prepare({ CodexAppServerProxy: AdoptedProxy }));
  assert.equal(Object.getPrototypeOf(proxy), AdoptedProxy.prototype);
  assert.equal(proxy.clients, clients);
  assert.equal(proxy.outerRuntime, outerRuntime);
  assert.equal(proxy.maxDesktopTransportBytes, undefined);
  assert.equal(proxy.status().limits.maxDesktopTransportBytes, DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES);
  const payload = Buffer.alloc(2048, 120);
  assert.equal(proxy._liveSendOrClose(fixture.client, fixture.downstream, payload, true, "fallback"), true);
  assert.equal(fixture.downstream.sent[0].length, payload.length);
  participant.restore(snapshot);
  const error = createDesktopTransportBudgetError({ requestId: 7, method: "tools/call",
    responseBytes: DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES + 1 });
  assert.equal(error.error.data.limit, DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES);
  assert.equal(error.error.data.retrySameRequest, false);
});

test("final Desktop transport preserves small events, history and unknown responses", () => {
  const fixture = desktopBudgetFixture();
  const notification = { method: "turn/completed", params: { threadId: "fixture", turnId: "turn" } };
  fixture.receive(notification);
  fixture.track(0, "thread/items/list");
  fixture.receive({ id: 0, result: { data: [], nextCursor: null } });
  fixture.receive({ id: "unknown-small", result: {} });
  assert.deepEqual(fixture.downstream.sent.map(bytes => JSON.parse(bytes.toString())),
    [notification, { id: 0, result: { data: [], nextCursor: null } }, { id: "unknown-small", result: {} }]);
  assert.equal(fixture.client.closed, false);
  assert.equal(fixture.client.desktopRequestIds.size, 0);
});

test("final Desktop transport replaces matched generic responses and preserves later responses", () => {
  for (const requestId of [0, "original-id"]) {
    const fixture = desktopBudgetFixture();
    const upstreamId = requestId === 0 ? 0 : -1000000001;
    fixture.track(requestId, "tools/call", upstreamId);
    fixture.receive({ id: upstreamId, result: { value: "x".repeat(2048) } });
    const error = JSON.parse(fixture.downstream.sent[0].toString());
    assert.equal(error.id, requestId);
    assert.equal(error.error.data.reason, "DESKTOP_TRANSPORT_BUDGET_EXCEEDED");
    assert.equal(error.error.data.retrySameRequest, false);
    assert.equal(error.error.data.upstreamStateMayHaveChanged, true);
    assert.equal(error.error.data.outcomeUnknown, true);
    assert.ok(fixture.downstream.sent[0].length <= 1024);
    fixture.track(2, "thread/read");
    fixture.receive({ id: 2, result: { thread: { id: "still-alive" } } });
    assert.equal(JSON.parse(fixture.downstream.sent[1].toString()).result.thread.id, "still-alive");
    assert.equal(fixture.client.closed, false);
    assert.equal(fixture.client.desktopRequestIds.size, 0);
    assert.equal(fixture.client.forwardedRequestIds.size, 0);
    assert.equal(fixture.client.desktopRequestBytes, 0);
  }
});

test("history keeps its own budget and pagination guidance before the final Desktop limit", () => {
  for (const method of ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]) {
    const fixture = desktopBudgetFixture({ maxDesktopResponseBytes: 1024, maxDesktopTransportBytes: 4096 });
    fixture.track(7, method);
    fixture.receive({ id: 7, result: { value: "x".repeat(2048) } });
    const error = JSON.parse(fixture.downstream.sent[0].toString());
    assert.equal(error.error.data.reason, "DESKTOP_RESPONSE_BUDGET_EXCEEDED");
    assert.equal(error.error.data.pagination.useCursor, true);
    assert.equal(error.error.data.retrySameRequest, false);
    assert.equal(error.error.data.upstreamStateMayHaveChanged, method === "thread/resume");
    assert.equal(fixture.client.closed, false);
  }
});

test("oversized notifications, server requests and unknown response IDs close only their client", () => {
  for (const message of [
    { method: "item/completed", params: { value: "x".repeat(2048) } },
    { id: 7, method: "item/tool/request", params: { value: "x".repeat(2048) } },
    { id: "unknown", result: { value: "x".repeat(2048) } },
  ]) {
    const fixture = desktopBudgetFixture();
    const otherClient = { closed: false };
    fixture.proxy.clients.add(otherClient);
    fixture.track(7, "tools/call");
    fixture.receive(message);
    assert.equal(fixture.downstream.sent.length, 0);
    assert.equal(fixture.downstream.closeCode, 1009);
    assert.equal(fixture.client.closed, true);
    assert.equal(otherClient.closed, false);
    assert.equal(fixture.proxy.clients.has(otherClient), true);
    assert.equal(fixture.proxy.closed, false);
    const diagnostic = fixture.events.find(event => event.type === "desktop_transport_budget_exceeded");
    assert.equal(diagnostic.replaced, false);
    assert.ok(JSON.stringify(diagnostic).length < 512);
  }
});

test("final Desktop limit checks projection growth and does not mislabel projected server requests", () => {
  for (const method of ["tools/call", "thread/read"]) {
    const fixture = desktopBudgetFixture();
    fixture.track(7, method);
    fixture.proxy.outerRuntime.upstream = () => ({ id: 7, result: { value: "x".repeat(2048) } });
    fixture.receive({ id: 7, result: {} });
    const error = JSON.parse(fixture.downstream.sent[0].toString());
    assert.equal(error.id, 7);
    assert.equal(error.error.data.reason, "DESKTOP_TRANSPORT_BUDGET_EXCEEDED");
    if (method === "thread/read") assert.equal(error.error.data.pagination.useCursor, true);
  }
  for (const projected of [
    { method: "event/grown", params: { value: "x".repeat(2048) } },
    { id: 7, method: "server/request", params: { value: "x".repeat(2048) } },
    { id: 8, result: { value: "x".repeat(2048) } },
  ]) {
    const fixture = desktopBudgetFixture();
    fixture.track(7, "tools/call");
    fixture.proxy.outerRuntime.upstream = () => projected;
    fixture.receive({ id: 7, result: {} });
    assert.equal(fixture.client.closed, true);
    assert.equal(fixture.downstream.sent.length, 0);
  }
});

test("final Desktop limit counts UTF-8 bytes and accepts the exact boundary", () => {
  const fixture = desktopBudgetFixture();
  const message = { id: 7, result: { value: "猫".repeat(400) } };
  const serialized = JSON.stringify(message);
  assert.ok(serialized.length < 1024);
  assert.ok(Buffer.byteLength(serialized) > 1024);
  fixture.track(7, "tools/call");
  fixture.receive(message);
  assert.equal(JSON.parse(fixture.downstream.sent[0].toString()).error.data.bytes, Buffer.byteLength(serialized));
  const exact = JSON.stringify({ method: "event", params: "" });
  const boundary = { method: "event", params: "x".repeat(1024 - Buffer.byteLength(exact)) };
  fixture.receive(boundary);
  assert.equal(fixture.downstream.sent[1].length, 1024);
  assert.equal(fixture.client.closed, false);
});

test("oversized error wrappers and local errors cannot bypass the final Desktop limit", () => {
  for (const method of ["tools/call", "thread/read"]) {
    const fixture = desktopBudgetFixture({ maxDesktopResponseBytes: 1024 });
    const requestId = "r".repeat(900);
    fixture.track(requestId, method);
    fixture.receive({ id: requestId, result: { value: "x".repeat(2048) } });
    assert.equal(fixture.downstream.sent.length, 0);
    assert.equal(fixture.downstream.closeCode, 1009);
    assert.ok(fixture.events.find(event => event.type === "desktop_transport_budget_exceeded").replacementBytes > 1024);
  }
  const fixture = desktopBudgetFixture();
  assert.equal(fixture.proxy._liveSendOrClose(fixture.client, fixture.downstream,
    JSON.stringify({ id: 1, error: { message: "x".repeat(2048) } }), false, "turn_preflight_error"), false);
  assert.equal(fixture.downstream.sent.length, 0);
});

test("the final Desktop budget does not limit upstream requests", () => {
  const fixture = desktopBudgetFixture();
  const message = { id: 7, method: "tools/call", params: { value: "x".repeat(2048) } };
  const bytes = Buffer.from(JSON.stringify(message));
  fixture.proxy._liveReceiveDownstream(fixture.client, bytes, false);
  assert.deepEqual(fixture.upstream.sent[0], bytes);
  assert.equal(fixture.client.closed, false);
  assert.equal(fixture.downstream.sent.length, 0);
});

test("final Desktop budget protects the real network chain without closing other clients", { timeout: 15000 }, async context => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const calls = [];
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", socket => socket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    calls.push(message);
    let result = { ok: true };
    if (message.method === "tools/call") result = { value: "x".repeat(4096) };
    if (message.method === "thread/read") result = { value: "x".repeat(8192) };
    if (message.method === "large/upstream") result = { received: Buffer.byteLength(message.params.value) };
    if (message.method === "overflow/notification") {
      socket.send(JSON.stringify({ method: "item/completed", params: { value: "x".repeat(4096) } }));
    } else if (message.method === "overflow/server") {
      socket.send(JSON.stringify({ id: message.id, method: "server/request", params: { value: "x".repeat(4096) } }));
    } else if (message.method === "overflow/unknown") {
      socket.send(JSON.stringify({ id: "unknown", result: { value: "x".repeat(4096) } }));
    } else socket.send(JSON.stringify({ id: message.id, result }));
  }));
  const proxy = createCodexAppServerProxy({ downstreamPort, controlPort, upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "network-budget-test", maxDesktopTransportBytes: 1024, maxDesktopResponseBytes: 2048,
    maxJsonParseBytes: 1024 });
  const desktops = [];
  context.after(async () => {
    for (const desktop of desktops) desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  await proxy.start();
  const connect = async () => {
    const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`, { maxPayload: 1024 });
    desktops.push(desktop);
    const responses = [];
    desktop.on("message", bytes => responses.push(JSON.parse(bytes.toString())));
    await new Promise((resolve, reject) => { desktop.once("open", resolve); desktop.once("error", reject); });
    desktop.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
    await waitFor(() => responses.some(message => message.id === 1));
    return { desktop, responses };
  };
  const primary = await connect();
  const survivor = await connect();
  primary.desktop.send(JSON.stringify({ id: 2, method: "tools/call", params: {} }));
  await waitFor(() => primary.responses.some(message => message.id === 2));
  assert.equal(primary.responses.find(message => message.id === 2).error.data.outcomeUnknown, true);
  primary.desktop.send(JSON.stringify({ id: 3, method: "thread/read", params: {} }));
  await waitFor(() => primary.responses.some(message => message.id === 3));
  assert.equal(primary.responses.find(message => message.id === 3).error.data.pagination.useCursor, true);
  primary.desktop.send(JSON.stringify({ id: 4, method: "large/upstream", params: { value: "猫".repeat(2048) } }));
  await waitFor(() => primary.responses.some(message => message.id === 4));
  assert.equal(primary.responses.find(message => message.id === 4).result.received, 6144);
  for (const kind of ["notification", "server", "unknown"]) {
    const target = kind === "notification" ? primary : await connect();
    target.desktop.send(JSON.stringify({ id: 5, method: `overflow/${kind}`, params: {} }));
    await waitFor(() => target.desktop.readyState === WebSocket.CLOSED);
    assert.equal(target.responses.some(message => message.id === 5), false);
    assert.equal(survivor.desktop.readyState, WebSocket.OPEN);
  }
  survivor.desktop.send(JSON.stringify({ id: 6, method: "normal/after", params: {} }));
  await waitFor(() => survivor.responses.some(message => message.id === 6));
  assert.deepEqual(survivor.responses.find(message => message.id === 6).result, { ok: true });
  assert.equal(calls.filter(message => message.method === "tools/call").length, 1);
  assert.equal(proxy.closed, false);
  assert.equal([...proxy.clients][0].desktopRequestIds.size, 0);
});

test("startup queue is bounded by bytes as well as message count", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "queue-byte-limit-token",
    maxQueuedMessages: 10,
    maxQueuedBytes: 1024,
    reconnectInitialMs: 1000,
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", method: "queued/a", params: { value: "a".repeat(700) } }));
  desktop.send(JSON.stringify({ jsonrpc: "2.0", method: "queued/b", params: { value: "b".repeat(700) } }));
  await waitFor(() => desktop.readyState === WebSocket.CLOSED);
  assert.equal(proxy.status().clientCount, 0);
  assert.equal(proxy.status().lastError.code, "DOWNSTREAM_QUEUE_OVERFLOW");
});

test("disconnect after a mutating wake write becomes unknown and is never replayed", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-proxy-mutation-disconnect-"));
  let turnStartCount = 0;
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
    } else if (message.method === "thread/resume") {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params.threadId, status: "idle" } } }));
    } else if (message.method === "turn/start") {
      turnStartCount += 1;
      socket.terminate();
    }
  }));
  const journalPath = path.join(temporaryRoot, "wake-journal.json");
  const proxy = createCodexAppServerProxy({
    downstreamPort,
    controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    controlToken: "mutation-disconnect-token",
    journal: createWakeJournal({ filePath: journalPath }),
  });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  const wake = {
    taskId: "task-mutation-disconnect",
    generation: 1,
    threadId: "thread-mutation-disconnect",
    localRole: "development",
    sourceMachine: "training",
    targetMachine: "development",
    trustedPeerQq: "1000000001",
    wakeId: "wake-mutation-disconnect",
    pendingThroughSequence: 1,
    pendingThroughTime: "2026-08-13T00:00:00.000Z",
    prompt: "[NAPCAT_TASK_WAKE] mutation disconnect",
  };
  await assert.rejects(() => proxy.wakeThread(wake), (error) => error?.outcomeUnknown === true);
  const retry = await proxy.wakeThread(wake);
  assert.equal(retry.outcome, "unknown");
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(turnStartCount, 1);
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).wakes[wake.wakeId].status, "unknown");
});

test("managed upstream stays paused until verified and can move to another loopback listener", {timeout:10000}, async context => {
  const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const connections = [0, 0];
  const servers = ports.slice(0, 2).map((port, index) => {
    const server = new WebSocketServer({host:"127.0.0.1",port});
    server.on("connection", socket => {
      connections[index]++;
      socket.on("message", data => {
        const message = JSON.parse(data.toString());
        if (message.id !== undefined) socket.send(JSON.stringify({id:message.id,result:{}}));
      });
    });
    return server;
  });
  const proxy = createCodexAppServerProxy({downstreamPort:ports[2],controlPort:ports[3],upstreamUrl:`ws://127.0.0.1:${ports[0]}`,upstreamPaused:true,controlToken:"managed-listener-test",reconnectInitialMs:50,reconnectMaxMs:100});
  let desktop;
  context.after(async () => {
    desktop?.terminate();
    await proxy.close();
    for (const server of servers) {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  });
  await proxy.start();
  desktop = new WebSocket(`ws://127.0.0.1:${ports[2]}`);
  await new Promise((resolve,reject) => {desktop.once("open",resolve);desktop.once("error",reject);});
  desktop.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"fixture"}}}));
  await new Promise(resolve => setTimeout(resolve,150));
  assert.deepEqual(connections,[0,0]);
  proxy.resumeUpstream();
  await waitFor(() => connections[0] === 1);
  proxy.pauseUpstream();
  await waitFor(() => desktop.readyState === WebSocket.CLOSED);
  await new Promise(resolve => setTimeout(resolve,200));
  assert.deepEqual(connections,[1,0]);
  assert.throws(() => proxy.setUpstreamUrl("ws://example.invalid:1234"),error => error.code === "INVALID_UPSTREAM_URL");
  assert.throws(() => proxy.setUpstreamUrl(`ws://127.0.0.1:${ports[1]}/wrong`),error => error.code === "INVALID_UPSTREAM_URL");
  proxy.setUpstreamUrl(`ws://127.0.0.1:${ports[1]}`);
  desktop = new WebSocket(`ws://127.0.0.1:${ports[2]}`);
  await new Promise((resolve,reject) => {desktop.once("open",resolve);desktop.once("error",reject);});
  assert.deepEqual(connections,[1,0]);
  proxy.resumeUpstream();
  await waitFor(() => connections[1] === 1);
  assert.deepEqual(connections,[1,1]);
});

test("hot adopted initialized connections retain desktop and injected turn recovery", { timeout: 10000 }, async context => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const methods = [];
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", socket => socket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    methods.push(message.method);
    const result = message.method === "thread/turns/list"
      ? { data: [{ id: "old-turn", status: "completed" }], nextCursor: null }
      : message.method === "turn/start" ? { turn: { id: "accepted-turn" } } : {};
    const reply = () => socket.send(JSON.stringify({ id: message.id, result }));
    if (message.method === "turn/start") setTimeout(reply, 50);
    else reply();
  }));
  const proxy = createCodexAppServerProxy({ downstreamPort, controlPort,
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`, controlToken: "hot-adoption-test" });
  await proxy.start();
  const desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  const responses = [];
  desktop.on("message", bytes => responses.push(JSON.parse(bytes.toString())));
  context.after(async () => {
    desktop.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  await new Promise(resolve => desktop.once("open", resolve));
  desktop.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
  await waitFor(() => responses.some(response => response.id === 1));
  const client = [...proxy.clients][0];
  assert.equal(client.initialized, true);
  delete client.initializedUpstream;
  let recoveries = 0;
  proxy.managedInnerControl = { dispatch: async (method, input, callbacks) => {
    assert.equal(method, "recover-before-turn");
    assert.equal(callbacks.connectionActive(), true);
    const history = await callbacks.lookupTurns({ threadId: input.threadId, limit: 8, itemsView: "notLoaded" });
    assert.equal(history.data[0].status, "completed");
    recoveries += 1;
  } };
  desktop.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "desktop-thread", input: [] } }));
  await waitFor(() => responses.some(response => response.id === 2));
  assert.equal(responses.find(response => response.id === 2).error, undefined);
  const injected = await proxy._liveInjectRequest(client, "turn/start", { threadId: "injected-thread", input: [] });
  assert.equal(injected.turn.id, "accepted-turn");
  assert.equal(recoveries, 2);
  assert.deepEqual(methods, ["initialize", "thread/turns/list", "turn/start", "thread/turns/list", "turn/start"]);
  assert.equal(desktop.readyState, WebSocket.OPEN);
  const secondDesktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  const secondResponses = [];
  secondDesktop.on("message", bytes => secondResponses.push(JSON.parse(bytes.toString())));
  context.after(() => secondDesktop.terminate());
  await new Promise(resolve => secondDesktop.once("open", resolve));
  secondDesktop.send(JSON.stringify({ id: 10, method: "initialize", params: {} }));
  await waitFor(() => secondResponses.some(response => response.id === 10));
  for (const id of [3, 4]) desktop.send(JSON.stringify({ id, method: "turn/start", params: { threadId: "same-thread", input: [] } }));
  secondDesktop.send(JSON.stringify({ id: 11, method: "turn/start", params: { threadId: "same-thread", input: [] } }));
  const concurrentInjected = proxy._liveInjectRequest(client, "turn/start", { threadId: "same-thread", input: [] });
  await waitFor(() => responses.some(response => response.id === 4) && secondResponses.some(response => response.id === 11));
  assert.equal((await concurrentInjected).turn.id, "accepted-turn");
  for (const id of [3, 4]) assert.equal(responses.find(response => response.id === id).error, undefined);
  assert.equal(secondResponses.find(response => response.id === 11).error, undefined);
  assert.equal(methods.filter(method => method === "turn/start").length, 6);
  const currentPrototype = Object.getPrototypeOf(proxy);
  const previousPrototype = Object.create(currentPrototype);
  Object.assign(previousPrototype, { _liveRecoverBeforeTurn: undefined, _liveForwardDesktopMessage: undefined,
    _liveFlushQueuedMessages: () => { assert.equal(client.queued.length, 0); } });
  let rejectRecovery;
  proxy.managedInnerControl.dispatch = () => new Promise((resolve, reject) => { rejectRecovery = reject; });
  desktop.send(JSON.stringify({ id: 5, method: "turn/start", params: { threadId: "rollback-thread", input: [] } }));
  await waitFor(() => Boolean(rejectRecovery));
  Object.setPrototypeOf(proxy, previousPrototype);
  rejectRecovery(new Error("fixture-readonly-timeout"));
  await waitFor(() => responses.some(response => response.id === 5));
  assert.equal(responses.find(response => response.id === 5).error.data.reason, "fixture-readonly-timeout");
  assert.equal(client.turnPreflightPending, false);
  assert.equal(client.desktopRequestIds.size, 0);
  Object.setPrototypeOf(proxy, currentPrototype);
  let resolveRecovery;
  proxy.managedInnerControl.dispatch = () => new Promise(resolve => { resolveRecovery = resolve; });
  const pendingInjected = proxy._liveInjectRequest(client, "turn/start", { threadId: "rollback-injected", input: [] });
  await waitFor(() => Boolean(resolveRecovery));
  previousPrototype._liveInjectRequest = () => { throw new Error("legacy-inject-must-not-replace-inflight-function"); };
  Object.setPrototypeOf(proxy, previousPrototype);
  resolveRecovery({ recovered: false });
  assert.equal((await pendingInjected).turn.id, "accepted-turn");
  Object.setPrototypeOf(proxy, currentPrototype);
});

test("corrupted wake journal fails closed instead of forgetting prior turns", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-corrupt-test-"));
  try {
    const journalPath = path.join(temporaryRoot, "wake-journal.json");
    fs.writeFileSync(journalPath, "{broken", "utf8");
    const journal = createWakeJournal({ filePath: journalPath });
    assert.throws(
      () => journal.status(),
      (error) => error?.code === "WAKE_JOURNAL_INVALID",
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
