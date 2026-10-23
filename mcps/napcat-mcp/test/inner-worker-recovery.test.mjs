import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInnerProxyCoordinator, createInnerProxyCoordinatorImplementation } from "../src/inner-proxy-coordinator.mjs";
import { createInnerNativeTurnSource } from "../src/inner-native-turn-source.mjs";
import { createThreadRecoveryHandoff, validateDurableRecoveryState } from "../src/thread-recovery-handoff.mjs";

const channels = ["attempts", "emptyIdleTurns", "businessProgress", "waitTerminals"];
const maps = () => Object.fromEntries(channels.map(channel => [channel, new Map()]));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "recovery condition deadline"); await pause(10); }
}

test("durable handoff preserves all four channels and rolls back failed synchronous persistence", () => {
  const source = maps();
  let durable;
  let broken = false;
  createThreadRecoveryHandoff({ maps: source, active: new Map(), policy: { attemptStateTtlMs: 1000 }, now: () => 2000,
    onStateChange(state) { if (broken) throw new Error("disk failed"); durable = structuredClone(state); } });
  source.emptyIdleTurns.set("thread", { count: 2, turnId: "working", terminalTurnId: null, updatedAt: 1900 });
  for (const channel of channels.filter(channel => channel !== "emptyIdleTurns")) {
    source[channel].set("thread\u0000working\u0000turn", { failures: 3, updatedAt: 1900 });
  }
  const restored = maps();
  createThreadRecoveryHandoff({ maps: restored, active: new Map(), policy: { attemptStateTtlMs: 1000 }, now: () => 2000, state: durable });
  for (const channel of channels) assert.deepEqual([...restored[channel]], [...source[channel]]);
  broken = true;
  assert.throws(() => source.attempts.delete("thread\u0000working\u0000turn"), /PERSISTENCE_FAILED/);
  assert.equal(source.attempts.size, 1);
  const invalid = structuredClone(durable);
  invalid.state.attempts.push(invalid.state.attempts[0]);
  assert.throws(() => validateDurableRecoveryState(invalid, { now: () => 2000 }), /INVALID/);
  assert.throws(() => createThreadRecoveryHandoff({ maps: maps(), active: new Map(), policy: {}, state: durable, now: () => 2000 }), /INVALID/);
});

async function fixture(context, { coordinatorFactory = createInnerProxyCoordinator,
  runnerSourceRoot = fileURLToPath(new URL("../src/", import.meta.url)) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-worker-recovery-"));
  const events = [];
  const calls = [];
  const responseHeads = [];
  const held = [];
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const finish = response => response.end(frame({ type: "response.completed", response: { id: "owned", status: "completed", output: [] } }));
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const metadata = JSON.parse(request.headers["x-codex-turn-metadata"]);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ metadata, body });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ type: "response.output_text.delta", delta: "owned-progress" }));
      if (metadata.thread_id === "old-inflight" || metadata.thread_id === "partial") held.push(response);
      else finish(response);
    });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const environment = {};
  for (const name of Object.keys(process.env)) if (/^(CODEX|OPENAI|MCP|MODEL_OBSERVER)_/u.test(name)) environment[name] = "";
  Object.assign(environment, { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: "1",
    CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" });
  const coordinator = coordinatorFactory({ ownerId: "worker-recovery-test", nativeSourceId: "worker-recovery-native",
    checkpointRoot: root, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, environment,
    onEvent: event => events.push(event) });
  const sourceRoot = runnerSourceRoot;
  const specification = { runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"),
    expectedHashes: Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
      .map(([name, file]) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, file))).digest("hex")])) };
  context.after(async () => {
    for (const response of held) if (!response.writableEnded) finish(response);
    await coordinator.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(coordinator.status().workers.every(worker => !worker.alive));
    fs.rmSync(root, { recursive: true });
  });
  const endpoint = await coordinator.start(specification);
  const notify = (threadId, phase, turnId = "working", status = "completed") => coordinator.observeNativeMessage("worker-recovery-native", {
    method: `turn/${phase}`, params: { threadId, turn: { id: turnId, ...(phase === "completed" ? { status } : {}) } } });
  const request = async (threadId, input = [], turnId = "working", signal = AbortSignal.timeout(12000)) => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/responses`, { method: "POST", headers: {
      "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId }) },
    body: JSON.stringify({ model: "synthetic", stream: true, input }), signal });
    responseHeads.push({ threadId, turnId, status: response.status });
    return { status: response.status, body: await response.text() };
  };
  return { root, events, calls, responseHeads, held, finish, coordinator, specification, endpoint, notify, request };
}

test("deployed old parent participant keeps its method table and runs the new private recovery closure", {
  timeout: 15000, skip: !process.env.RECOVERY_OLD_INSTALLATION_ROOT,
}, async context => {
  const oldSourceRoot = path.join(process.env.RECOVERY_OLD_INSTALLATION_ROOT, "src");
  const oldModule = await import(pathToFileURL(path.join(oldSourceRoot, "inner-proxy-coordinator.mjs")));
  const state = await fixture(context, { coordinatorFactory: oldModule.createInnerProxyCoordinator, runnerSourceRoot: oldSourceRoot });
  const participant = state.coordinator.liveCodeParticipant();
  const shared = participant.snapshot().state;
  const oldMethods = Object.keys(shared.implementation).sort();
  assert.equal(oldMethods.includes("recoverFailedWorker"), false);
  await state.notify("adopted-old-parent", "started");
  const preparation = participant.prepare({ createInnerProxyCoordinatorImplementation });
  participant.activate(preparation);
  assert.deepEqual(Object.keys(shared.implementation).sort(), oldMethods);
  const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
    .map(([name, file]) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, file))).digest("hex")]));
  assert.notEqual(expectedHashes.core, state.specification.expectedHashes.core);
  const manifest = { schemaVersion: 1, edges: [{ source: { core: state.specification.expectedHashes.core,
    helper: state.specification.expectedHashes.helper }, target: { core: expectedHashes.core, helper: expectedHashes.helper },
    checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
  const compatibility = { manifest, sha256: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
  const candidate = await state.coordinator.prepareCandidate({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes });
  await state.coordinator.activate({ candidateId: candidate.workerId, compatibility });
  assert.equal((await state.request("adopted-old-parent")).status, 200);
  await state.notify("partial", "started");
  const partial = state.request("partial").catch(error => ({ error: error.message }));
  await until(() => state.responseHeads.some(response => response.threadId === "partial"));
  shared.workers.get(candidate.workerId).child.kill();
  await until(() => state.events.some(event => ["worker_recovered", "worker_recovery_failed"].includes(event.type)));
  assert.equal(state.events.find(event => event.type === "worker_recovery_failed"), undefined, JSON.stringify(state.events));
  const thread = shared.threads.get("adopted-old-parent");
  assert.deepEqual(thread.worker.ready.sourceHashes, state.specification.expectedHashes);
  context.diagnostic(JSON.stringify({ evidence: "deployed-old-parent-live-participant", oldMethodsPreserved: true,
    replacementHashes: thread.worker.ready.sourceHashes, recovery: state.events.find(event => event.type === "worker_recovered") }));
  assert.equal((await state.request("adopted-old-parent", [{ type: "function_call_output", call_id: "old-parent-next", output: "next" }])).status, 200);
  assert.equal(state.coordinator.status().nativeHealthy, true);
  assert.equal(state.coordinator.status().liveCode.generation, 1);
  assert.ok((await partial).error);
  const beforeReplay = state.calls.length;
  for (let index = 0; index < 2; index += 1) {
    const replay = await state.request("partial", [], "working", AbortSignal.timeout(2000));
    assert.equal(replay.status, 200);
    assert.match(replay.body, /"type":"response.failed"/u);
    assert.doesNotMatch(replay.body, /"type":"response.completed"/u);
  }
  assert.equal(state.calls.length, beforeReplay);
  await state.notify("partial", "completed", "working", "failed");
  await state.notify("partial", "started", "after-recovery");
  const fresh = state.request("partial", [], "after-recovery");
  await until(() => state.calls.length === beforeReplay + 1);
  state.finish(state.held.at(-1));
  assert.equal((await fresh).status, 200);
});

test("migration source death with native cancel preserves the healthy candidate route", { timeout: 15000 }, async context => {
  const state = await fixture(context);
  const shared = state.coordinator.liveCodeParticipant().snapshot().state;
  await state.notify("moving", "started");
  const candidate = await state.coordinator.prepareCandidate(state.specification);
  await state.coordinator.activate({ candidateId: candidate.workerId });
  await state.notify("healthy", "started");
  assert.equal((await state.request("healthy")).status, 200);
  const healthyPid = shared.workers.get(candidate.workerId).child.pid;
  const originalDispatch = shared.dispatch;
  let injected = false;
  let terminal;
  shared.dispatch = (method, ...args) => {
    const result = originalDispatch(method, ...args);
    if (!injected && method === "control" && args[1] === "prepare" && args[2].threadId === "moving") {
      injected = true;
      return Promise.resolve(result).then(async receipt => {
        const exited = once(args[0].child, "exit");
        args[0].child.kill();
        await exited;
        terminal = state.notify("moving", "completed", "working", "interrupted");
        return receipt;
      });
    }
    return result;
  };
  await assert.rejects(shared.dispatch("migrate", { threadId: "moving", candidateId: candidate.workerId, live: true },
    { selectDefault: false }), /COMMIT_PRECONDITION_CHANGED/);
  await terminal;
  await until(() => state.events.some(event => event.type === "worker_recovered"));
  assert.ok(state.events.some(event => event.type === "migration_preserved_source" && event.cancelled === false));
  assert.equal(state.coordinator.status().nativeHealthy, true);
  assert.equal((await state.request("healthy")).status, 200);
  assert.equal(shared.workers.get(candidate.workerId).child.pid, healthyPid);
  assert.equal(state.coordinator.status().workers.find(worker => worker.workerId === candidate.workerId).alive, true);
  assert.equal(state.events.some(event => event.type === "native_relay_failed"), false);
});

test("unconfirmed migration cancellation freezes only its source thread until worker recovery", { timeout: 15000 }, async context => {
  const state = await fixture(context);
  const shared = state.coordinator.liveCodeParticipant().snapshot().state;
  await state.notify("moving", "started");
  await state.notify("healthy", "started");
  assert.equal((await state.request("healthy")).status, 200);
  const source = shared.threads.get("moving").worker;
  const candidate = await state.coordinator.prepareCandidate(state.specification);
  const originalDispatch = shared.dispatch;
  shared.dispatch = (method, ...args) => {
    if (method === "control" && args[2]?.threadId === "moving" && ["accept", "cancel"].includes(args[1])) {
      return Promise.reject(Object.assign(new Error("OWNED_CONTROL_REJECTED"), { code: "OWNED_CONTROL_REJECTED" }));
    }
    return originalDispatch(method, ...args);
  };
  await assert.rejects(shared.dispatch("migrate", { threadId: "moving", candidateId: candidate.workerId, live: true },
    { selectDefault: false }), /OWNED_CONTROL_REJECTED/);
  shared.dispatch = originalDispatch;
  assert.equal(state.coordinator.status().nativeHealthy, true);
  assert.equal(state.coordinator.status().threads.find(thread => thread.threadId === "moving").migrationCleanupError, "OWNED_CONTROL_REJECTED");
  assert.equal((await state.request("moving")).status, 503);
  assert.equal((await state.request("healthy")).status, 200);
  assert.equal(state.calls.some(call => call.metadata.thread_id === "moving"), false);
  source.child.kill();
  await until(() => state.events.some(event => event.type === "worker_recovered"));
  assert.equal(state.coordinator.status().threads.find(thread => thread.threadId === "moving").migrationCleanupError, null);
  assert.equal((await state.request("moving")).status, 200);
});

test("rejected native binding keeps the shared queue usable and never clears a real native failure", { timeout: 15000 }, async context => {
  const state = await fixture(context);
  const shared = state.coordinator.liveCodeParticipant().snapshot().state;
  await state.notify("binding", "started");
  const originalDispatch = shared.dispatch;
  shared.dispatch = (method, ...args) => method === "control" && args[1] === "bindRecovery"
    ? Promise.reject(Object.assign(new Error("OWNED_BIND_REJECTED"), { code: "OWNED_BIND_REJECTED" }))
    : originalDispatch(method, ...args);
  const input = { threadId: "binding", turnId: "working", connectionGeneration: "owned-retry" };
  await assert.rejects(state.coordinator.recoveryControl("bind-native", input), /OWNED_BIND_REJECTED/);
  const nativeSource = createInnerNativeTurnSource({ sourceId: "worker-recovery-native", coordinator: state.coordinator });
  await nativeSource.observe({ method: "turn/started", params: { threadId: "binding", turn: { id: "working" } },
    recoveryConnectionGeneration: "owned-retry" });
  assert.equal(nativeSource.status().healthy, true);
  shared.dispatch = originalDispatch;
  await shared.relay;
  assert.equal(shared.threads.get("binding").start.connectionGeneration, undefined);
  assert.equal(state.coordinator.status().threads.find(thread => thread.threadId === "binding").recoveryBindingError, "OWNED_BIND_REJECTED");
  await nativeSource.observe({ method: "turn/started", params: { threadId: "healthy", turn: { id: "working" } } });
  assert.equal((await state.request("healthy")).status, 200);
  assert.equal(state.events.some(event => event.type === "native_relay_failed"), false);
  await state.coordinator.recoveryControl("bind-native", input);
  assert.equal(state.coordinator.recoveryControl("binding", input).connectionGeneration, input.connectionGeneration);
  assert.equal(state.coordinator.status().threads.find(thread => thread.threadId === "binding").recoveryBindingError, null);
  shared.dispatch("handleNativeRelayFailure", { code: "OWNED_NATIVE_SOURCE_FAILURE" });
  assert.throws(() => state.coordinator.recoveryControl("bind-native", input), /RECOVERY_BINDING_INVALID/);
  assert.equal(state.coordinator.status().nativeHealthy, false);
});

for (const method of ["bind-native", "duplicate-start"]) {
  test(`${method} waits for worker recovery before confirming the connection binding`, { timeout: 15000 }, async context => {
    const state = await fixture(context);
    const shared = state.coordinator.liveCodeParticipant().snapshot().state;
    const candidate = await state.coordinator.prepareCandidate(state.specification);
    await state.coordinator.activate({ candidateId: candidate.workerId });
    await state.notify("binding", "started");
    assert.equal((await state.request("binding")).status, 200);
    const originalDispatch = shared.dispatch;
    let release;
    let blocked = false;
    const gate = new Promise(resolve => { release = resolve; });
    context.after(() => release());
    shared.dispatch = (operation, ...args) => {
      if (operation === "launchWorker" && args[1]?.recoverySeed) {
        blocked = true;
        return gate.then(() => originalDispatch(operation, ...args));
      }
      return originalDispatch(operation, ...args);
    };
    shared.workers.get(candidate.workerId).child.kill();
    await until(() => blocked);
    let settled = false;
    const binding = (method === "bind-native"
      ? state.coordinator.recoveryControl(method, { threadId: "binding", turnId: "working", connectionGeneration: "owned-rebound" })
      : state.coordinator.observeNativeMessage("worker-recovery-native", { method: "turn/started",
        params: { threadId: "binding", turn: { id: "working" } }, recoveryConnectionGeneration: "owned-rebound" }))
      .then(result => { settled = true; return { result }; }, error => { settled = true; return { error: error.code ?? error.message }; });
    await pause(30);
    const prematureGeneration = shared.threads.get("binding").start.connectionGeneration;
    const prematurelySettled = settled;
    release();
    const result = await binding;
    assert.equal(result.error, undefined);
    assert.equal(prematurelySettled, false);
    assert.equal(prematureGeneration, undefined);
    const confirmed = state.coordinator.recoveryControl("binding", { threadId: "binding", turnId: "working" });
    assert.equal(confirmed.connectionGeneration, "owned-rebound");
    assert.notEqual(confirmed.producerPid, shared.workers.get(candidate.workerId).child.pid);
    await state.notify("healthy-after-bind", "started");
    assert.equal((await state.request("healthy-after-bind")).status, 200);
    assert.equal(state.coordinator.status().nativeHealthy, true);
    assert.equal(state.events.some(event => event.type === "native_relay_failed"), false);
  });
}

test("candidate death restores adopted and new threads while old HTTP finishes once and cancel append stays healthy", { timeout: 25000 }, async context => {
  const state = await fixture(context);
  await state.notify("old-inflight", "started");
  const original = state.request("old-inflight");
  await until(() => state.calls.length === 1);
  await state.notify("adopted", "started");
  const candidate = await state.coordinator.prepareCandidate(state.specification);
  await state.coordinator.activate({ candidateId: candidate.workerId });
  const tool = [{ type: "function_call_output", call_id: "once", output: "owned" }];
  assert.equal((await state.request("adopted", tool)).status, 200);
  await state.notify("candidate-new", "started");
  await state.request("candidate-new");
  await state.notify("partial", "started");
  const partial = state.request("partial").catch(error => ({ error: error.message }));
  await until(() => state.calls.length === 4);
  await until(() => state.responseHeads.some(response => response.threadId === "partial"));
  const worker = state.coordinator.status().workers.find(worker => worker.workerId === candidate.workerId);
  const ledgerPath = path.join(state.root, candidate.workerId, "codex-model-operation-state.json");
  context.diagnostic(JSON.stringify({ beforeKill: JSON.parse(fs.readFileSync(ledgerPath, "utf8")) }));
  process.kill(worker.pid);
  await until(() => state.events.some(event => event.type === "worker_recovered" || event.type === "worker_recovery_failed"));
  assert.equal(state.events.find(event => event.type === "worker_recovery_failed"), undefined, JSON.stringify(state.events));
  context.diagnostic(JSON.stringify({ recovery: state.events.find(event => event.type === "worker_recovered"),
    deadLedger: JSON.parse(fs.readFileSync(ledgerPath, "utf8")) }));
  assert.equal(state.coordinator.status().defaultWorkerId, state.endpoint.workerId);
  assert.ok((await partial).error);
  assert.equal((await state.request("adopted", [{ type: "function_call_output", call_id: "second", output: "next" }])).status, 200);
  assert.equal((await state.request("candidate-new")).status, 200);
  assert.equal(state.calls.filter(call => call.body.input.some(item => item.call_id === "once")).length, 1);
  const retry = await state.request("partial", [], "working", AbortSignal.timeout(2000));
  assert.match(retry.body, /"type":"response.failed"/u);
  assert.doesNotMatch(retry.body, /"type":"response.completed"/u);
  assert.equal(state.calls.filter(call => call.metadata.thread_id === "partial").length, 1);
  await state.notify("adopted", "completed", "working", "interrupted");
  await state.notify("adopted", "started", "append");
  assert.equal((await state.request("adopted", [], "append")).status, 200);
  assert.equal(state.coordinator.status().nativeHealthy, true);
  state.finish(state.held[0]);
  assert.equal((await original).status, 200);
  assert.equal(state.calls.filter(call => call.metadata.thread_id === "old-inflight").length, 1);
});

test("corrupt recovery state isolates the failed thread and preserves native cancellation plus fresh work", { timeout: 15000 }, async context => {
  const state = await fixture(context);
  const candidate = await state.coordinator.prepareCandidate(state.specification);
  await state.coordinator.activate({ candidateId: candidate.workerId });
  await state.notify("damaged", "started");
  await state.request("damaged");
  fs.writeFileSync(path.join(state.root, candidate.workerId, "codex-model-recovery-state.json"), "{corrupt");
  process.kill(state.coordinator.status().workers.find(worker => worker.workerId === candidate.workerId).pid);
  await until(() => state.events.some(event => event.type === "worker_recovery_failed"));
  assert.equal((await state.request("damaged")).status, 503);
  await state.notify("damaged", "completed", "working", "interrupted");
  await state.notify("healthy", "started");
  assert.equal((await state.request("healthy")).status, 200);
  assert.equal(state.coordinator.status().nativeHealthy, true);
  assert.equal(state.coordinator.status().defaultWorkerId, state.endpoint.workerId);
});

test("native cancel and append arriving during candidate recovery are delivered in order", { timeout: 15000 }, async context => {
  const state = await fixture(context);
  const candidate = await state.coordinator.prepareCandidate(state.specification);
  await state.coordinator.activate({ candidateId: candidate.workerId });
  await state.notify("racing", "started");
  await state.request("racing");
  process.kill(state.coordinator.status().workers.find(worker => worker.workerId === candidate.workerId).pid);
  await until(() => state.events.some(event => event.type === "worker_exited" && event.workerId === candidate.workerId));
  const cancelled = state.notify("racing", "completed", "working", "interrupted");
  const appended = state.notify("racing", "started", "append");
  await Promise.all([cancelled, appended]);
  assert.equal((await state.request("racing", [], "append")).status, 200);
  assert.equal(state.coordinator.status().nativeHealthy, true);
  assert.equal(state.events.some(event => event.type === "worker_recovery_failed"), false, JSON.stringify(state.events));
  assert.equal(state.coordinator.status().threads.find(thread => thread.threadId === "racing").turnId, "append");
});

test("real runner recovery restores four seeded counters through the existing signed accept protocol", { timeout: 15000 }, async context => {
  const state = await fixture(context);
  const candidate = await state.coordinator.prepareCandidate(state.specification);
  await state.coordinator.activate({ candidateId: candidate.workerId });
  await state.notify("counter-owner", "started");
  await state.request("counter-owner");
  const target = path.join(state.root, candidate.workerId, "codex-model-recovery-state.json");
  const snapshot = JSON.parse(fs.readFileSync(target, "utf8"));
  const key = "counter-owner\u0000working\u0000turn";
  const updatedAt = Date.now();
  snapshot.capturedAt = updatedAt;
  snapshot.state = {
    attempts: [[key, { failures: 2, startedAt: updatedAt, updatedAt }]],
    emptyIdleTurns: [["counter-owner", { count: 2, turnId: "working", terminalTurnId: null, updatedAt }]],
    businessProgress: [[key, { updatedAt }]],
    waitTerminals: [[key, { reason: "owned_fixture", notice: "owned fixture", updatedAt }]],
  };
  fs.writeFileSync(target, JSON.stringify(snapshot));
  process.kill(state.coordinator.status().workers.find(worker => worker.workerId === candidate.workerId).pid);
  await until(() => state.events.some(event => event.type === "worker_recovered" || event.type === "worker_recovery_failed"));
  assert.equal(state.events.some(event => event.type === "worker_recovery_failed"), false, JSON.stringify(state.events));
  const restored = state.events.find(event => event.type === "worker_recovered");
  const saved = JSON.parse(fs.readFileSync(path.join(state.root, restored.replacementWorkerId, "codex-model-recovery-state.json"), "utf8"));
  assert.deepEqual(saved.state, snapshot.state);
  const checkpoints = fs.readdirSync(state.root).filter(name => name.startsWith("inner-runner-recovery-"));
  assert.equal(checkpoints.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.root, checkpoints[0]), "utf8")).payload.snapshot.state, snapshot.state);
});
