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

test("transparent proxy forwards Desktop traffic and suppresses duplicate wake_id", { timeout: 15000 }, async (context) => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-test-"));
  const token = "test-token-that-is-long-enough";
  let turnStartCount = 0;
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  upstream.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "fake" } } }));
      } else if (message.method === "thread/resume") {
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
