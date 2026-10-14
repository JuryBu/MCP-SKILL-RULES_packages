import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import vm from "node:vm";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createInnerProxyCoordinator } from "../src/inner-proxy-coordinator.mjs";

const require = createRequire(import.meta.url);
const compiler = require(process.argv[2]);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitUntil = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "owned coordinator condition deadline");
    await pause(10);
  }
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-live-code-compiled-"));
const calls = [];
const held = [];
const events = [];
const markers = [];
const bundles = [];
const retiredMethods = [];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const release = () => {
  for (const response of held) if (!response.writableEnded) response.end(frame({ type: "response.completed",
    response: { id: "owned-compiled-http", status: "completed", output: [] } }));
};
const upstream = http.createServer((request, response) => {
  request.resume();
  request.once("end", () => {
    calls.push({ method: request.method, path: request.url });
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ slug: "owned-compiled" }] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.output_text.delta", delta: "before-switch-owned" }));
    held.push(response);
  });
});
const environment = {};
for (const name of Object.keys(process.env)) {
  if (!/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/iu.test(name)) environment[name] = "";
}
Object.assign(environment, { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100",
  CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" });
let coordinator;
let evidence;
try {
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  coordinator = createInnerProxyCoordinator({ ownerId: "compiled-owned", nativeSourceId: "compiled-native",
    checkpointRoot: root, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, environment,
    onEvent: event => events.push(event) });
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs",
    core: "codex-model-stream-proxy.mjs", helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
    .map(([key, name]) => [key, digest(fs.readFileSync(path.join(sourceRoot, name)))]));
  const endpoint = await coordinator.start({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes });
  const notify = (threadId, turnId, phase) => coordinator.observeNativeMessage("compiled-native", {
    method: `turn/${phase}`, params: { threadId, turn: { id: turnId,
      ...(phase === "completed" ? { status: "completed" } : {}) } } });
  const warmupThreads = 260;
  for (let index = 0; index < warmupThreads; index += 1) {
    const threadId = index === warmupThreads - 2 ? "owned-thread" : index === warmupThreads - 1 ? "queued-thread" : `warmup-${index}`;
    await notify(threadId, `warmup-turn-${index}`, "started");
    await notify(threadId, `warmup-turn-${index}`, "completed");
  }
  await notify("owned-thread", "owned-turn", "started");
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn",
      thread_id: "owned-thread", turn_id: "owned-turn" }) },
    body: JSON.stringify({ model: "synthetic", stream: true, input: [] }) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  let body = Buffer.from(first.value).toString("utf8");
  assert.match(body, /before-switch-owned/u);
  const participant = coordinator.liveCodeParticipant();
  const shared = participant.snapshot().state;
  const worker = shared.defaultWorker;
  const thread = shared.threads.get("owned-thread");
  const request = [...shared.requests.values()][0];
  const server = shared.server;
  const listener = server.rawListeners("request")[0];
  const workerListeners = Object.fromEntries(["message", "exit", "error"].map(name => [name, worker.child.rawListeners(name)]));
  const retainedMaps = Object.fromEntries(["workers", "threads", "terminalThreads", "pending", "migrations", "adoptions", "requests"]
    .map(name => [name, shared[name]]));
  const initialWorkers = coordinator.status().workers;
  const assertRetained = () => {
    assert.strictEqual(participant.snapshot().state, shared);
    assert.strictEqual(shared.server, server);
    assert.strictEqual(server.rawListeners("request")[0], listener);
    assert.equal(server.address().port, endpoint.port);
    assert.strictEqual(shared.defaultWorker, worker);
    assert.strictEqual(shared.threads.get("owned-thread"), thread);
    assert.strictEqual(shared.requests.get(request.id), request);
    assert.equal(thread.activeHttp, 1);
    assert.equal(worker.activeHttp, 1);
    assert.deepEqual(coordinator.status().workers, initialWorkers);
    for (const [name, retained] of Object.entries(retainedMaps)) assert.strictEqual(shared[name], retained);
    for (const [name, retained] of Object.entries(workerListeners)) assert.deepEqual(worker.child.rawListeners(name), retained);
  };
  const build = label => {
    const before = coordinator.status();
    const result = compiler.buildSync({ entryPoints: [path.join(sourceRoot, "inner-proxy-coordinator.mjs")], bundle: true,
      platform: "node", format: "cjs", target: "node18", external: ["ws"], write: false, logLevel: "silent" });
    const bytes = result.outputFiles[0].contents;
    const filePath = path.join(root, `${label}.cjs`);
    fs.writeFileSync(filePath, bytes);
    bundles.push({ label, bytes: bytes.length, sha256: digest(bytes) });
    const module = { exports: {} };
    const externalRequire = dependency => {
      assert.ok(dependency.startsWith("node:") || dependency === "ws");
      return require(dependency);
    };
    vm.compileFunction(Buffer.from(bytes).toString("utf8"), ["exports", "require", "module", "__filename", "__dirname"],
      { filename: filePath })(module.exports, externalRequire, module, filePath, root);
    assert.equal(typeof module.exports.createInnerProxyCoordinatorImplementation, "function");
    const candidate = participant.prepare({ createInnerProxyCoordinatorImplementation: state => {
      assert.strictEqual(state, shared);
      const implementation = module.exports.createInnerProxyCoordinatorImplementation(state);
      if (label === "compiled-1") {
        for (const [name, method] of Object.entries(implementation)) retiredMethods.push({ name, reference: new WeakRef(method) });
      }
      return Object.fromEntries(Object.entries(implementation).map(([name, method]) => [name, (...args) => {
        markers.push({ label, name, generation: state.implementationGeneration });
        return method(...args);
      }]));
    } });
    assert.deepEqual(coordinator.status(), before, "compiled factory preparation changed resources or counters");
    assertRetained();
    return candidate;
  };
  const catalog = async () => {
    const catalogResponse = await fetch(`http://127.0.0.1:${endpoint.port}/backend-api/codex/models`);
    assert.equal(catalogResponse.status, 200);
    assert.equal((await catalogResponse.json()).models[0].slug, "owned-compiled");
    await waitUntil(() => shared.requests.size === 1);
  };
  let candidate = build("compiled-1");
  const queuedNative = notify("queued-thread", "queued-turn", "started");
  const pendingCheck = shared.dispatch("control", worker, "check");
  assert.equal(shared.pending.size, 1);
  const pendingEntry = [...shared.pending.values()][0];
  const sequenceBefore = { ...coordinator.status().sequences };
  let token = participant.activate(candidate);
  assert.deepEqual(coordinator.status().sequences, sequenceBefore);
  assert.strictEqual([...shared.pending.values()][0], pendingEntry);
  await Promise.all([queuedNative, pendingCheck]);
  assert.ok(markers.some(marker => marker.name === "relayNativeEvent"));
  assert.ok(markers.some(marker => marker.name === "handleWorkerMessage"));
  assert.ok(markers.some(marker => marker.name === "handleControlSendError"));
  assertRetained();
  await catalog();
  assert.ok(markers.some(marker => marker.name === "handleHttpRequest"));
  participant.restore(token);
  token = null;
  const markerCount = markers.length;
  await catalog();
  assert.equal(markers.length, markerCount);
  participant.activate(candidate);
  const retired = new WeakRef(candidate.implementation);
  candidate = null;
  for (let index = 2; index <= 7; index++) {
    const next = build(`compiled-${index}`);
    const before = { ...coordinator.status().sequences };
    participant.activate(next);
    assert.deepEqual(coordinator.status().sequences, before);
    assertRetained();
    await catalog();
  }
  assert.equal(coordinator.status().liveCode.generation, 9);
  assert.equal(typeof globalThis.gc, "function");
  await new Promise(resolve => setImmediate(resolve));
  globalThis.gc();
  await new Promise(resolve => setImmediate(resolve));
  globalThis.gc();
  assert.equal(retired.deref(), undefined, "retired implementation retained by coordinator resources");
  for (const method of retiredMethods) assert.equal(method.reference.deref(), undefined, `retired compiled method ${method.name} retained`);
  release();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += Buffer.from(chunk.value).toString("utf8");
  }
  assert.match(body, /response.completed/u);
  await waitUntil(() => shared.requests.size === 0);
  assert.equal(thread.activeHttp, 0);
  assert.equal(worker.activeHttp, 0);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(events.filter(event => event.type === "request_routed" && event.threadId === "owned-thread").length, 1);
  await notify("owned-thread", "owned-turn", "completed");
  await notify("queued-thread", "queued-turn", "completed");
  assert.equal(shared.nativeSequence, warmupThreads * 2 + 4);
  assert.equal(shared.workerSequence, 1);
  assert.equal(shared.pending.size, 0);
  assert.equal(shared.threads.get("owned-thread").phase, "terminal");
  await coordinator.close();
  assert.ok(markers.some(marker => marker.name === "handleWorkerExit" && marker.generation === 9));
  assert.ok(markers.some(marker => marker.name === "releaseHttpRequest" && marker.generation === 9));
  assert.equal(worker.child.exitCode, 0);
  evidence = { evidence: "compiled-coordinator-live-sse-ipc-gc", compilerVersion: compiler.version,
    root, port: endpoint.port, upstreamPort: upstream.address().port, pid: worker.child.pid, workerExitCode: worker.child.exitCode,
    switches: 9, compiledGenerations: 7, warmupThreads, terminalHistory: coordinator.status().terminalHistory,
    bundles, sameListener: true, sameWorker: true, sameThread: true, sameRequest: true,
    postExecutions: 1, originalHttpStatus: response.status, originalStreamCompleted: true, retiredCollected: true,
    retiredMethodsCollected: retiredMethods.length,
    activeHttp: shared.requests.size, pendingControl: shared.pending.size, finalSequences: coordinator.status().sequences,
    dispatched: [...new Set(markers.map(marker => marker.name))] };
} finally {
  release();
  if (coordinator) await coordinator.close();
  upstream.closeAllConnections();
  if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
  assert.equal(path.dirname(root), os.tmpdir());
  fs.rmSync(root, { recursive: true });
}
evidence.removed = !fs.existsSync(root);
assert.equal(evidence.removed, true);
console.log(JSON.stringify(evidence));
