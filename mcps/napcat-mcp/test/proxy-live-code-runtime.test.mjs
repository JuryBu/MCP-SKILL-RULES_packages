import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { buildProxyLiveBundle } from "../src/proxy-live-build.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const require = createRequire(import.meta.url);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function copyFixtureTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyFixtureTree(sourcePath, destinationPath);
    else if (entry.isFile()) fs.writeFileSync(destinationPath, fs.readFileSync(sourcePath));
    else throw new Error("FIXTURE_DEPENDENCY_LINK_REFUSED");
  }
}

function makeBundle(root, version) {
  const bundleRoot = path.join(root, version);
  fs.mkdirSync(bundleRoot);
  const pending = ["codex-app-server-proxy.mjs"];
  const entries = new Map();
  while (pending.length) {
    const filename = pending.pop();
    if (entries.has(filename)) continue;
    let source = fs.readFileSync(path.join(sourceRoot, filename), "utf8");
    if (filename === "codex-app-server-proxy.mjs") source += '\nconst priorStatus = CodexAppServerProxy.prototype.status;\nCodexAppServerProxy.prototype.status = function () { return { ...priorStatus.call(this), liveVersion: ' + JSON.stringify(version) + ' }; };\nconst priorReceive = CodexAppServerProxy.prototype._liveReceiveDownstream;\nCodexAppServerProxy.prototype._liveReceiveDownstream = function (...args) { this.liveFrames = (this.liveFrames ?? 0) + 1; return priorReceive.apply(this, args); };\n';
    entries.set(filename, source);
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.\/[^"']+)["']/gu)) pending.push(match[1].slice(2));
  }
  const files = [...entries].map(([filename, source]) => {
    fs.writeFileSync(path.join(bundleRoot, filename), source);
    return { path: filename, sha256: hash(source) };
  });
  const manifestPath = path.join(bundleRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, stateSchema: "proxy-live-state-v1", version,
    entry: "codex-app-server-proxy.mjs", files }));
  return { manifestPath, manifestSha256: hash(fs.readFileSync(manifestPath)) };
}

async function setup(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-live-code-test-"));
  copyFixtureTree(path.dirname(require.resolve("ws/package.json")), path.join(root, "node_modules", "ws"));
  const upstreamServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstreamServer, "listening");
  const frames = [];
  let upstream;
  upstreamServer.on("connection", socket => {
    upstream = socket;
    socket.on("message", data => { frames.push(JSON.parse(data)); });
  });
  const proxy = createCodexAppServerProxy({ controlToken: "fixture-token", instanceToken: "fixture-instance",
    outerRuntimeRoot: root, downstreamPort: 1, controlPort: 2,
    upstreamUrl: `ws://127.0.0.1:${upstreamServer.address().port}` });
  proxy.downstreamPort = 0;
  proxy.controlPort = 0;
  await proxy.start();
  const downstream = new WebSocket(`ws://127.0.0.1:${proxy.websocketServer.address().port}`);
  await once(downstream, "open");
  const responses = [];
  downstream.on("message", data => responses.push(JSON.parse(data)));
  const deadline = Date.now() + 2000;
  while (!upstream && Date.now() < deadline) await sleep(5);
  assert.ok(upstream);
  const request = async (action, input) => {
    const response = await fetch(`http://127.0.0.1:${proxy.controlServer.address().port}/v1/full-runtime/${action}`, {
      method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  };
  context.after(async () => {
    await proxy.close();
    downstream.terminate();
    for (const socket of upstreamServer.clients) socket.terminate();
    await new Promise(resolve => upstreamServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, proxy, downstream, frames, responses, upstream: () => upstream, request };
}

test("full proxy code replaces an established busy connection and restores without repeating a tool", async context => {
  const fixture = await setup(context);
  const { root, proxy, downstream, frames, responses, request } = fixture;
  const retainedClient = [...proxy.clients][0];
  const retainedUpstream = retainedClient.upstream;
  downstream.send(JSON.stringify({ id: 10, method: "tool/wait", params: { value: "fixture" } }));
  while (!frames.length) await sleep(5);
  const bundle = makeBundle(root, "version2");
  const preparation = await request("prepare", { instanceId: "fixture-instance", expectedRevision: 0, ...bundle });
  assert.equal(preparation.status, 200);
  const activation = await request("activate", { instanceId: "fixture-instance", expectedRevision: 0, preparationId: preparation.value.id });
  assert.equal(activation.status, 200);
  assert.ok(activation.value.actualMs < 5000);
  assert.equal(proxy.status().liveVersion, "version2");
  assert.equal([...proxy.clients][0], retainedClient);
  assert.equal(retainedClient.upstream, retainedUpstream);
  downstream.send(JSON.stringify({ id: 11, method: "next/request", params: {} }));
  while (frames.length < 2) await sleep(5);
  assert.equal(proxy.liveFrames, 1);
  fixture.upstream().send(JSON.stringify({ id: 10, result: { done: true } }));
  while (!responses.length) await sleep(5);
  assert.deepEqual(responses[0], { id: 10, result: { done: true } });
  const restoration = await request("restore", { instanceId: "fixture-instance", expectedRevision: 1 });
  assert.equal(restoration.status, 200);
  assert.equal(proxy.status().liveVersion, undefined);
  assert.equal(frames.filter(frame => frame.method === "tool/wait").length, 1);
  assert.equal([...proxy.clients][0].upstream, retainedUpstream);
  context.diagnostic(JSON.stringify({ toolExecutions: 1, retryCount: 0, sameConnection: true, activationMs: activation.value.actualMs }));
});

test("changed pinned source refuses activation while original connections remain", async context => {
  const fixture = await setup(context);
  const bundle = makeBundle(fixture.root, "changed-source");
  const prepared = await fixture.request("prepare", { instanceId: "fixture-instance", expectedRevision: 0, ...bundle });
  assert.equal(prepared.status, 200);
  fs.appendFileSync(path.join(path.dirname(bundle.manifestPath), "codex-app-server-proxy.mjs"), "\n");
  const activation = await fixture.request("activate", { instanceId: "fixture-instance", expectedRevision: 0, preparationId: prepared.value.id });
  assert.equal(activation.status, 500);
  assert.equal(activation.value.error.code, "LIVE_CODE_FILE_CHANGED");
  assert.equal(fixture.proxy.status().liveVersion, undefined);
  assert.equal(fixture.proxy.clients.size, 1);
});

test("a compiled real proxy generation preserves busy WebSockets and permits collection after replacement", {
  skip: !process.env.NAPCAT_TEST_ESBUILD_MODULE,
}, async context => {
  const compiler = require(process.env.NAPCAT_TEST_ESBUILD_MODULE);
  assert.equal(compiler.version, "0.28.2");
  const fixture = await setup(context);
  const retainedClient = [...fixture.proxy.clients][0];
  const retainedUpstream = retainedClient.upstream;
  const originalPrototype = Object.getPrototypeOf(fixture.proxy);
  fixture.downstream.send(JSON.stringify({ id: 80, method: "tool/wait", params: { value: "compiled" } }));
  while (!fixture.frames.length) await sleep(5);
  let retired;
  for (let index = 0; index < 5; index++) {
    const version = `compiled-${index}`;
    const bundle = await buildProxyLiveBundle({ sourceRoot,
      destinationRoot: path.join(fixture.root, version), version, compiler });
    const prepared = await fixture.request("prepare", { instanceId: "fixture-instance", expectedRevision: index, ...bundle });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
    const activated = await fixture.request("activate", { instanceId: "fixture-instance", expectedRevision: index, preparationId: prepared.value.id });
    assert.equal(activated.status, 200, JSON.stringify(activated.value));
    assert.equal(activated.value.selected.version, version);
    assert.equal(activated.value.legacyImports, 0);
    assert.ok(activated.value.actualMs < 5000);
    assert.notEqual(Object.getPrototypeOf(fixture.proxy), originalPrototype);
    if (index === 0) retired = new WeakRef(Object.getPrototypeOf(fixture.proxy));
  }
  assert.equal([...fixture.proxy.clients][0], retainedClient);
  assert.equal(retainedClient.upstream, retainedUpstream);
  fixture.upstream().send(JSON.stringify({ id: 80, result: { done: true } }));
  while (!fixture.responses.length) await sleep(5);
  assert.deepEqual(fixture.responses[0], { id: 80, result: { done: true } });
  fixture.downstream.send(JSON.stringify({ id: 81, method: "next/request", params: {} }));
  while (fixture.frames.length < 2) await sleep(5);
  assert.equal(fixture.frames.filter(frame => frame.method === "tool/wait").length, 1);
  if (typeof globalThis.gc === "function") {
    await new Promise(resolve => setImmediate(resolve));
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(retired.deref(), undefined);
  }
  const restored = await fixture.request("restore", { instanceId: "fixture-instance", expectedRevision: 5 });
  assert.equal(restored.status, 200);
  assert.equal(restored.value.selected.version, "compiled-3");
  assert.equal(retainedClient.upstream, retainedUpstream);
  context.diagnostic(JSON.stringify({ compiledGenerations: 5, oldCodeCollected: typeof globalThis.gc === "function",
    sameConnection: true, toolExecutions: 1, retryCount: 0 }));
});
