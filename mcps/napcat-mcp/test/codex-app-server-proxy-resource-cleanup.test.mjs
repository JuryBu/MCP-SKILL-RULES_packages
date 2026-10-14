import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Resource cleanup fixture deadline exceeded");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(context, options = {}) {
  const upstreamPort = await freePort();
  let upstreamServer = null;
  const received = [];
  const startUpstream = async () => {
    upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
    upstreamServer.on("connection", socket => socket.on("message", bytes => {
      const request = JSON.parse(bytes.toString("utf8"));
      received.push(request);
      if (request.method === "initialize" || !options.holdRequests) {
        socket.send(JSON.stringify({ id: request.id, result: { thread: { id: "cleanup-thread", turns: [] } } }));
      }
    }));
    await new Promise(resolve => upstreamServer.once("listening", resolve));
  };
  if (!options.unavailable && !options.paused) await startUpstream();
  const proxy = createCodexAppServerProxy({
    downstreamPort: await freePort(), controlPort: await freePort(),
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`, upstreamPaused: Boolean(options.paused),
    controlToken: "resource-cleanup-fixture-token", reconnectInitialMs: 50, reconnectMaxMs: 50,
    requestTimeoutMs: 5000,
  });
  let desktop;
  context.after(async () => {
    desktop?.terminate();
    await proxy.close();
    if (upstreamServer) {
      for (const socket of upstreamServer.clients) socket.terminate();
      await new Promise(resolve => upstreamServer.close(resolve));
    }
  });
  await proxy.start();
  desktop = new WebSocket(`ws://127.0.0.1:${proxy.downstreamPort}`);
  desktop.on("error", () => {});
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  const [client] = proxy.clients;
  return { proxy, desktop, client, received, startUpstream };
}

function request(id, method = "thread/read") {
  return JSON.stringify({ id, method, params: { threadId: "cleanup-thread", padding: "x".repeat(128 * 1024) } });
}

function assertClientReleased(state) {
  assert.equal(state.proxy.clients.size, 0);
  assert.equal(state.client.closed, true);
  assert.equal(state.proxy.outerRuntime.status().trackedRequestCount, 0);
  assert.equal(state.proxy.outerRuntime.status().pendingToolCount, 0);
  assert.equal(state.client.queued.length, 0);
  assert.equal(state.client.queuedBytes, 0);
  assert.equal(state.client.desktopRequestIds.size, 0);
  assert.equal(state.client.desktopRequestBytes, 0);
  assert.equal(state.client.forwardedRequestIds.size, 0);
  assert.equal(state.client.injected.size, 0);
  assert.equal(state.client.reconnectTimer, null);
  assert.equal(state.client.nextReconnectAt, null);
  assert.equal(state.client.upstreamReady, false);
  assert.equal(state.client.turnObserver.status().active, 0);
}

test("downstream close releases queued payloads and request tracking", async context => {
  const state = await fixture(context, { paused: true });
  state.desktop.send(request(1));
  await waitFor(() => state.client.queued.length === 1);
  assert.ok(state.client.queuedBytes > 128 * 1024);
  state.desktop.terminate();
  await waitFor(() => state.client.closed);
  assertClientReleased(state);
});

test("buffered downstream frames after a protocol close cannot recreate closed-client state", async context => {
  const state = await fixture(context, { paused: true });
  state.desktop._socket.cork();
  state.desktop.send("invalid-json");
  state.desktop.send(request(2));
  state.desktop._socket.uncork();
  await waitFor(() => state.client.closed && state.desktop.readyState === WebSocket.CLOSED);
  assertClientReleased(state);
});

test("retained downstream callbacks ignore messages after final close", async context => {
  const state = await fixture(context, { paused: true });
  const [onMessage] = state.client.downstream.listeners("message");
  let observed = 0;
  const observeDownstream = state.proxy.outerRuntime.downstream;
  state.proxy.outerRuntime.downstream = (...args) => {
    observed += 1;
    return observeDownstream(...args);
  };
  state.desktop.terminate();
  await waitFor(() => state.client.closed);
  onMessage(Buffer.from(request(3)), false);
  assert.equal(observed, 0);
  assertClientReleased(state);
});

test("initial connection retries preserve queued requests until the upstream opens", async context => {
  const state = await fixture(context, { unavailable: true });
  state.desktop.send(JSON.stringify({ id: 4, method: "initialize", params: {} }));
  await waitFor(() => state.client.reconnectAttempt >= 2);
  assert.equal(state.client.closed, false);
  assert.equal(state.client.queued.length, 1);
  assert.equal(state.client.desktopRequestIds.size, 1);
  assert.ok(state.client.reconnectTimer);
  await state.startUpstream();
  await waitFor(() => state.proxy.status().readyClientCount === 1);
  await waitFor(() => state.client.desktopRequestIds.size === 0);
  assert.equal(state.received.filter(message => message.id === 4).length, 1);
  assert.equal(state.client.queued.length, 0);
  assert.equal(state.client.queuedBytes, 0);
  assert.equal(state.client.reconnectTimer, null);
  assert.equal(state.client.closed, false);
});

test("final close settles pending injected requests and cancels their timeout", async context => {
  const state = await fixture(context, { holdRequests: true });
  state.desktop.send(JSON.stringify({ id: 5, method: "initialize", params: {} }));
  await waitFor(() => state.proxy.status().readyClientCount === 1);
  const pendingResult = state.proxy.inspectThread("cleanup-thread");
  const rejected = assert.rejects(pendingResult, { code: "CONNECTION_CLOSED", outcomeUnknown: false });
  await waitFor(() => state.client.injected.size === 1);
  const [{ timeout }] = state.client.injected.values();
  state.desktop.terminate();
  await rejected;
  assert.equal(timeout._destroyed, true);
  assertClientReleased(state);
});

test("repeated protocol-close cycles leave no owned runtime requests", async context => {
  const state = await fixture(context, { paused: true });
  for (let cycle = 0; cycle < 16; cycle += 1) {
    if (cycle > 0) {
      state.desktop = new WebSocket(`ws://127.0.0.1:${state.proxy.downstreamPort}`);
      context.after(() => state.desktop.terminate());
      await new Promise((resolve, reject) => {
        state.desktop.once("open", resolve);
        state.desktop.once("error", reject);
      });
      [state.client] = state.proxy.clients;
    }
    state.desktop._socket.cork();
    state.desktop.send("invalid-json");
    state.desktop.send(request(100 + cycle));
    state.desktop._socket.uncork();
    await waitFor(() => state.client.closed && state.desktop.readyState === WebSocket.CLOSED);
    assertClientReleased(state);
  }
});
