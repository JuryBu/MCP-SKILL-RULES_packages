import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { CodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { createProxyClassCodeParticipant } from "../src/proxy-live-code-runtime.mjs";

async function baselineClass() {
  const source = fs.readFileSync(process.env.ARCHIVE_PROVIDER_BASELINE_PATH, "utf8");
  const sourceUrl = new URL("../src/codex-app-server-proxy.mjs", import.meta.url);
  const absolute = source.replace(/(from\s+)(["'])(\.\/[^"']+|ws)\2/gu,
    (_match, prefix, quote, dependency) => `${prefix}${quote}${dependency === "ws"
      ? import.meta.resolve("ws") : new URL(dependency, sourceUrl).href}${quote}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(absolute).toString("base64")}`)).CodexAppServerProxy;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(context, ProxyClass = CodexAppServerProxy) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  context.after(async () => {
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  await new Promise(resolve => upstream.once("listening", resolve));
  const records = [
    { id: "archived-old", modelProvider: "provider-old", source: "cli", archived: true },
    { id: "archived-new", modelProvider: "provider-new", source: "vscode", archived: true },
  ];
  const received = [];
  let connectionCount = 0;
  upstream.on("connection", socket => {
    connectionCount += 1;
    socket.on("message", (bytes, isBinary) => {
      const raw = bytes.toString();
      const request = JSON.parse(raw);
      const providers = request.params?.modelProviders ?? ["native-default"];
      const result = request.method === "thread/list" ? {
        data: records.filter(record => providers.length === 0 || providers.includes(record.modelProvider)),
        nextCursor: "opaque-next-page+/=", source: "native-stub", unknownField: { retained: true },
      } : request.method === "thread/read" ? { thread: { id: "fixture-thread", turns: [] } }
        : { echoed: request.params ?? null };
      const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result }, null, 2);
      received.push({ raw, request, response, isBinary });
      socket.send(response);
    });
  });
  const proxy = new ProxyClass({
    downstreamPort: await freePort(), controlPort: await freePort(),
    upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`, controlToken: "archive-provider-isolated-test",
    maxJsonParseBytes: 1024,
  });
  context.after(() => proxy.close());
  await proxy.start();
  const desktop = new WebSocket(proxy.status().downstreamUrl);
  context.after(() => desktop.terminate());
  const pending = new Map();
  desktop.on("message", bytes => {
    const raw = bytes.toString();
    const response = JSON.parse(raw);
    pending.get(response.id)?.({ raw, response });
  });
  await new Promise((resolve, reject) => {
    desktop.once("open", resolve);
    desktop.once("error", reject);
  });
  let sequence = 1;
  const rpc = async (params, { method = "thread/list", id = sequence++, binary = false, extraEnvelope = "retained" } = {}) => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id, method, params, extraEnvelope }, null, 2);
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${id}`)); }, 3000);
      pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
    });
    desktop.send(raw, { binary });
    const response = await responsePromise;
    return { requestRaw: raw, responseRaw: response.raw, response: response.response, forwarded: received.at(-1) };
  };
  await rpc({}, { method: "initialize" });
  return { proxy, desktop, rpc, received, connections: () => connectionCount };
}

test("native archive list only broadens omitted or null providers and preserves response bytes", async context => {
  const ProxyClass = process.env.ARCHIVE_PROVIDER_USE_BASELINE ? await baselineClass() : CodexAppServerProxy;
  const { rpc } = await fixture(context, ProxyClass);
  const shared = { cursor: "opaque-input+/=", limit: 1, sourceKinds: ["cli", "vscode"],
    sortKey: "updated_at", cwd: "fixture/中文 folder", searchTerm: "archive", futureField: { retained: 1 } };
  const cases = [
    { name: "archive omitted provider", params: { ...shared, archived: true }, broaden: true },
    { name: "archive null provider", params: { ...shared, archived: true, modelProviders: null }, broaden: true },
    { name: "explicit all", params: { archived: true, modelProviders: [] } },
    { name: "explicit old", params: { archived: true, modelProviders: ["provider-old"] } },
    { name: "explicit new", params: { archived: true, modelProviders: ["provider-new"] } },
    { name: "explicit unknown", params: { archived: true, modelProviders: ["unknown"] } },
    { name: "active omitted provider", params: { archived: false } },
    { name: "active null provider", params: { archived: false, modelProviders: null } },
    { name: "active explicit all", params: { archived: false, modelProviders: [] } },
    { name: "archived omitted", params: { modelProviders: null } },
    { name: "archived null", params: { archived: null, modelProviders: null } },
    { name: "archived string", params: { archived: "true", modelProviders: null } },
    { name: "archived number", params: { archived: 1, modelProviders: null } },
    { name: "invalid provider retained", params: { archived: true, modelProviders: "invalid" } },
    { name: "other method", method: "thread/read", params: { archived: true, modelProviders: null } },
    { name: "params omitted" },
    { name: "params null", params: null },
    { name: "binary archive request", params: { archived: true }, binary: true, broaden: true },
    { name: "large envelope retained", params: { archived: true }, extraEnvelope: "retained".repeat(2048), broaden: true },
  ];
  for (const entry of cases) await context.test(entry.name, async () => {
    const result = await rpc(entry.params, entry);
    const expected = JSON.parse(result.requestRaw);
    if (entry.broaden) expected.params.modelProviders = [];
    assert.deepEqual(result.forwarded.request, expected);
    if (!entry.broaden) assert.equal(result.forwarded.raw, result.requestRaw);
    assert.equal(result.requestRaw === result.forwarded.raw, !entry.broaden);
    assert.equal(result.forwarded.isBinary, entry.binary ?? false);
    assert.equal(result.response.id, expected.id);
    assert.equal(result.responseRaw, result.forwarded.response);
    assert.equal(result.response.result.nextCursor, entry.method ? undefined : "opaque-next-page+/=");
    assert.equal(result.response.result.source, entry.method ? undefined : "native-stub");
    if (entry.broaden) assert.deepEqual(result.response.result.data.map(record => record.id), ["archived-old", "archived-new"]);
  });
});

test("reserved Desktop request id still maps back after archive compatibility", async context => {
  const { proxy, rpc } = await fixture(context);
  await proxy._liveInjectRequest([...proxy.clients][0], "fixture/ping", {});
  const result = await rpc({ archived: true, modelProviders: null }, { id: -1_000_000_000 });
  assert.notEqual(result.forwarded.request.id, result.response.id);
  assert.equal(result.response.id, -1_000_000_000);
  assert.deepEqual(result.forwarded.request.params.modelProviders, []);
  assert.equal(result.response.result.data.length, 2);
});

test("existing native WebSocket uses hot candidate and restores legacy filtering without reconnect", {
  skip: !process.env.ARCHIVE_PROVIDER_BASELINE_PATH,
}, async context => {
  const { proxy, desktop, rpc, connections } = await fixture(context, await baselineClass());
  const participant = createProxyClassCodeParticipant(proxy);
  const retained = [proxy.clients, proxy.websocketServer, proxy.controlServer, proxy.outerRuntime, proxy.journal];
  const before = await rpc({ archived: true, modelProviders: null });
  assert.equal(before.response.result.data.length, 0);
  const candidate = participant.prepare({ CodexAppServerProxy });
  const rollback = participant.activate(candidate);
  const after = await rpc({ archived: true, modelProviders: null });
  assert.deepEqual(after.response.result.data.map(record => record.id), ["archived-old", "archived-new"]);
  const explicit = await rpc({ archived: true, modelProviders: ["provider-new"] });
  assert.deepEqual(explicit.response.result.data.map(record => record.id), ["archived-new"]);
  assert.equal(explicit.forwarded.raw, explicit.requestRaw);
  participant.restore(rollback);
  assert.equal((await rpc({ archived: true, modelProviders: null })).response.result.data.length, 0);
  assert.deepEqual([proxy.clients, proxy.websocketServer, proxy.controlServer, proxy.outerRuntime, proxy.journal], retained);
  assert.equal(desktop.readyState, WebSocket.OPEN);
  assert.equal(connections(), 1);
  if (process.env.ARCHIVE_PROVIDER_TEST_ROOT) {
    fs.writeFileSync(path.join(process.env.ARCHIVE_PROVIDER_TEST_ROOT, "hot-switch.json"), JSON.stringify({
      at: new Date().toISOString(), mechanism: "createProxyClassCodeParticipant", oldCount: 0, newCount: 2,
      restoredCount: 0, upstreamConnections: connections(), desktopStillOpen: true, resourcesPreserved: true,
    }, null, 2));
  }
});
