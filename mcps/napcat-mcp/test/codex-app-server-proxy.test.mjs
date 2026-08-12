import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  createCodexAppServerProxy,
  createWakeJournal,
} from "../src/codex-app-server-proxy.mjs";

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

test("transparent proxy keeps Desktop connected while App Server restarts", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  let upstream = null;
  let hiddenInitializeCount = 0;
  const startUpstream = async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8"));
        if (message.method === "initialize") {
          if (Number(message.id) < 0) hiddenInitializeCount += 1;
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
  await waitFor(() => proxy.status().readyClientCount === 0);
  assert.equal(desktop.readyState, WebSocket.OPEN);
  await startUpstream();
  await waitFor(() => proxy.status().readyClientCount === 1);
  desktop.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "desktop/after-restart", params: {} }));
  await waitFor(() => responses.some((message) => message.id === 2));
  assert.equal(responses.find((message) => message.id === 2).result.echoed, "desktop/after-restart");
  assert.equal(desktop.readyState, WebSocket.OPEN);
  assert.equal(hiddenInitializeCount, 1);
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
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
      } else if (message.method === "thread/resume") {
        threadResumeCount += 1;
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
  assert.equal(Object.hasOwn(startRequests[1], "clientUserMessageId"), false);

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
  assert.equal(Object.hasOwn(steerRequests[1], "clientUserMessageId"), false);

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
