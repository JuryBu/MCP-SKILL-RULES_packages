import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as coordinatorModule from "../src/inner-proxy-coordinator.mjs";
import { HANDOFF_CHANNEL } from "../src/inner-runner-handoff-control.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const esbuildModule = process.env.CODEX_LIVE_ESBUILD_MODULE ?? process.env.NAPCAT_TEST_ESBUILD_MODULE;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const waitUntil = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "live-code condition deadline");
    await pause(10);
  }
};

async function fixture(context, { emptyIdle = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-coordinator-live-code-"));
  const events = [];
  const calls = [];
  const held = [];
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const complete = response => response.end(frame({ type: "response.completed",
    response: { id: "live-code-fixture", status: "completed", output: [] } }));
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      calls.push({ method: request.method, path: request.url });
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ slug: "live-code-owned" }] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (emptyIdle) {
        response.end(frame({ type: "response.failed", response: { id: "owned-empty-idle", status: "failed",
          error: { code: "usage_limit_reached", message: "owned loopback only" } } }));
        return;
      }
      response.write(frame({ type: "response.output_text.delta", delta: "owned-live-code" }));
      held.push(response);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const environment = {};
  for (const name of Object.keys(process.env)) {
    if (!/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/iu.test(name)) environment[name] = "";
  }
  Object.assign(environment, { MODEL_OBSERVER_ENABLED: "false",
    CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" });
  const coordinator = coordinatorModule.createInnerProxyCoordinator({ ownerId: "live-code-owner",
    nativeSourceId: "live-code-native", checkpointRoot: root,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, environment,
    onEvent: event => events.push(event) });
  const release = () => {
    for (const response of held) if (!response.writableEnded) complete(response);
  };
  context.after(async () => {
    release();
    await coordinator.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    const final = coordinator.status();
    assert.ok(final.workers.every(worker => !worker.alive && worker.exitCode === 0));
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
    console.log(JSON.stringify({ evidence: "live-code-owned-http-worker-cleanup", root,
      removed: !fs.existsSync(root), workers: final.workers.map(worker => ({ pid: worker.pid, exitCode: worker.exitCode })),
      upstreamCalls: calls.length, routed: events.filter(event => event.type === "request_routed").length }));
  });
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs",
    core: "codex-model-stream-proxy.mjs", helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
    .map(([key, name]) => [key, digest(fs.readFileSync(path.join(sourceRoot, name)))]));
  const endpoint = await coordinator.start({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes });
  const notify = (threadId, turnId, phase) => coordinator.observeNativeMessage("live-code-native", {
    method: `turn/${phase}`, params: { threadId, turn: { id: turnId,
      ...(phase === "completed" ? { status: "completed" } : {}) } } });
  const request = async (threadId = "working-thread", turnId = "working-turn") => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn",
        thread_id: threadId, turn_id: turnId }) },
      body: JSON.stringify({ model: "synthetic", stream: true, input: [] }) });
    return { status: response.status, body: await response.text() };
  };
  const catalog = async () => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/backend-api/codex/models`);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { coordinator, endpoint, events, calls, held, release, notify, request, catalog,
    specification: { runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes } };
}

test("nine ended histories survive successive real worker selections and resume once on the latest worker", { timeout: 15000 }, async context => {
  const value = await fixture(context);
  const shared = value.coordinator.liveCodeParticipant().snapshot().state;
  const source = shared.defaultWorker;
  for (let index = 0; index < 9; index += 1) {
    await value.notify(`ended-${index}`, `ended-turn-${index}`, "started");
    await value.notify(`ended-${index}`, `ended-turn-${index}`, "completed");
  }
  const originalStates = [...shared.threads.values()];
  const originalWorker = source.workerId;
  const selected = [];
  for (let index = 0; index < 3; index += 1) {
    const candidate = await value.coordinator.prepareCandidate(value.specification);
    const receipt = await value.coordinator.activate({ candidateId: candidate.workerId });
    assert.deepEqual(receipt.deferredThreadIds, []);
    assert.equal(receipt.stateTransferComplete, false);
    assert.ok(originalStates.every(state => state.worker === source && !state.pendingActivation));
    assert.ok(value.coordinator.status().workers.some(worker => worker.workerId === originalWorker && worker.alive));
    selected.push(candidate.workerId);
  }
  await value.notify("ended-0", "resumed-turn", "started");
  const stream = value.request("ended-0", "resumed-turn");
  await waitUntil(() => value.held.length === 1);
  const resumed = shared.threads.get("ended-0");
  assert.strictEqual(resumed.worker, shared.defaultWorker);
  assert.equal(resumed.pendingActivation, undefined);
  assert.equal(resumed.activeHttp, 1);
  value.release();
  const response = await stream;
  assert.equal(response.status, 200);
  assert.match(response.body, /response.completed/u);
  await value.notify("ended-0", "resumed-turn", "completed");
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(value.events.filter(event => event.type === "activation_thread_adopted").length, 1);
  assert.ok(originalStates.slice(1).every(state => state.worker === source));
  context.diagnostic(JSON.stringify({ evidence: "real-terminal-selection-resume", retainedHistories: 9,
    selectedWorkers: selected, resumedWorker: resumed.worker.workerId, postExecutions: 1 }));
});

test("discardCandidate frees only the unused prepared worker repeatedly while another real SSE stays active", { timeout: 15000 }, async context => {
  const value = await fixture(context);
  const shared = value.coordinator.liveCodeParticipant().snapshot().state;
  const source = shared.defaultWorker;
  await value.notify("working-thread", "working-turn", "started");
  const stream = value.request();
  await waitUntil(() => value.held.length === 1);
  const original = shared.threads.get("working-thread");
  const routed = [...shared.requests.values()][0];
  const spare = await value.coordinator.prepareCandidate(value.specification);
  const exits = [];
  for (let index = 0; index < 6; index += 1) {
    const prepared = await value.coordinator.prepareCandidate(value.specification);
    const worker = shared.workers.get(prepared.workerId);
    if (index === 0) {
      const participant = value.coordinator.liveCodeParticipant();
      participant.activate(participant.prepare(coordinatorModule));
    }
    const receipt = await value.coordinator.discardCandidate({ workerId: prepared.workerId });
    assert.equal(receipt.discarded, true);
    assert.equal(receipt.workerId, prepared.workerId);
    assert.equal(receipt.exitCode, 0);
    assert.equal(worker.child.exitCode, 0);
    assert.equal(worker.child.signalCode, null);
    assert.equal(shared.workers.has(prepared.workerId), false);
    assert.equal(shared.workers.has(spare.workerId), true);
    assert.strictEqual(shared.defaultWorker, source);
    assert.strictEqual(shared.threads.get("working-thread"), original);
    assert.strictEqual([...shared.requests.values()][0], routed);
    assert.equal(original.activeHttp, 1);
    assert.equal((await value.coordinator.discardCandidate({ workerId: prepared.workerId })).alreadyDiscarded, true);
    exits.push({ workerId: prepared.workerId, exitCode: worker.child.exitCode });
  }
  value.release();
  assert.equal((await stream).status, 200);
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  context.diagnostic(JSON.stringify({ evidence: "real-prepared-candidate-discard", cancelledCandidates: 6,
    exactWorkerOnly: true, sameActiveThread: true, postExecutions: 1, exits }));
});

test("rollback after simulated B persistence failure restores A and preserves its real recovery record", { timeout: 15000 }, async context => {
  const value = await fixture(context, { emptyIdle: true });
  const shared = value.coordinator.liveCodeParticipant().snapshot().state;
  const preparedA = await value.coordinator.prepareCandidate(value.specification);
  const committedA = await value.coordinator.activate({ candidateId: preparedA.workerId });
  const source = shared.defaultWorker;
  await value.notify("a-thread", "a-turn", "started");
  assert.equal((await value.request("a-thread", "a-turn")).status, 200);
  await value.notify("a-thread", "a-turn", "completed");
  const state = shared.threads.get("a-thread");
  const before = await shared.dispatch("control", source, "prepare", { threadId: "a-thread", fileName: "inner-runner-a-before.json", live: false });
  const originalRecovery = JSON.parse(fs.readFileSync(before.filePath, "utf8")).payload.snapshot.state;
  assert.equal(originalRecovery.emptyIdleTurns[0][1].count, 1);
  await shared.dispatch("control", source, "cancel", { threadId: "a-thread", token: before.token });
  const candidate = await value.coordinator.prepareCandidate(value.specification);
  const activation = await value.coordinator.activate({ candidateId: candidate.workerId });
  assert.throws(() => value.coordinator.rollbackActivation({ activationId: committedA.activationId }), { code: "COORDINATOR_ACTIVATION_NOT_CURRENT" });
  let failure;
  let receipt;
  try { throw new Error("OWNED_SIMULATED_B_PERSIST_FAILURE"); }
  catch (error) {
    failure = error;
    receipt = value.coordinator.rollbackActivation({ activationId: activation.activationId });
  }
  assert.equal(failure.message, "OWNED_SIMULATED_B_PERSIST_FAILURE");
  assert.equal(receipt.selectionRestored, true);
  assert.equal(receipt.defaultWorkerId, source.workerId);
  assert.deepEqual(receipt.retainedThreadIds, []);
  assert.strictEqual(shared.threads.get("a-thread"), state);
  assert.strictEqual(state.worker, source);
  assert.equal(state.pendingActivation, undefined);
  const after = await shared.dispatch("control", source, "prepare", { threadId: "a-thread", fileName: "inner-runner-a-after.json", live: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(after.filePath, "utf8")).payload.snapshot.state, originalRecovery);
  await shared.dispatch("control", source, "cancel", { threadId: "a-thread", token: after.token });
  await assert.rejects(value.coordinator.discardCandidate({ workerId: candidate.workerId }), { code: "COORDINATOR_CANDIDATE_PROTECTED" });
  const retired = shared.workers.get(candidate.workerId);
  const next = await value.coordinator.prepareCandidate(value.specification);
  assert.equal(retired.child.exitCode, 0);
  assert.equal(shared.workers.has(candidate.workerId), false);
  await value.coordinator.discardCandidate({ workerId: next.workerId });
  await value.notify("a-thread", "a-next-turn", "started");
  assert.strictEqual(shared.threads.get("a-thread").worker, source);
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  context.diagnostic(JSON.stringify({ evidence: "real-A-B-persist-rollback", persistenceFailure: "simulated after activation",
    rollback: receipt, originalRecoveryPreserved: true, retiredBExitCode: retired.child.exitCode, postExecutions: 1 }));
});

test("terminal handoff restores evicted runner bookkeeping without replay and preserves the coordinator object", { timeout: 15000 }, async context => {
  const value = await fixture(context);
  const shared = value.coordinator.liveCodeParticipant().snapshot().state;
  await value.notify("preserved-terminal", "preserved-turn", "started");
  await value.notify("preserved-terminal", "preserved-turn", "completed");
  const original = shared.threads.get("preserved-terminal");
  const source = original.worker;
  shared.requests.set("owned-test-pin", { thread: original });
  for (let index = 0; index < 300; index += 1) {
    await value.notify(`terminal-pressure-${index}`, `turn-${index}`, "started");
    await value.notify(`terminal-pressure-${index}`, `turn-${index}`, "completed");
  }
  shared.requests.delete("owned-test-pin");
  assert.strictEqual(shared.threads.get("preserved-terminal"), original);
  assert.equal((await shared.dispatch("control", source, "check", { threadId: "preserved-terminal" })).native, null);
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs",
    core: "codex-model-stream-proxy.mjs", helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
    .map(([key, name]) => [key, digest(fs.readFileSync(path.join(sourceRoot, name)))]));
  const candidate = await value.coordinator.prepareCandidate({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes });
  const receipt = await value.coordinator.migrate({ threadId: "preserved-terminal", candidateId: candidate.workerId });
  assert.equal(receipt.committed, true);
  assert.equal(receipt.cleanupPending, false);
  assert.strictEqual(shared.threads.get("preserved-terminal"), original);
  assert.equal(original.worker.workerId, candidate.workerId);
  await value.notify("preserved-terminal", "continued-turn", "started");
  assert.strictEqual(shared.threads.get("preserved-terminal"), original);
  assert.equal(value.calls.length, 0);
  context.diagnostic(JSON.stringify({ evidence: "real-worker-evicted-terminal-handoff", endedThreads: 301,
    restoredTerminal: true, originalStatePreserved: true, committed: receipt.committed, httpExecutions: 0 }));
});

test("baseline real worker and active HTTP complete once with native turn retained", { timeout: 12000 }, async context => {
  const fixtureState = await fixture(context);
  await fixtureState.notify("working-thread", "working-turn", "started");
  const inflight = fixtureState.request();
  await waitUntil(() => fixtureState.held.length === 1);
  assert.equal(fixtureState.coordinator.status().threads[0].activeHttp, 1);
  fixtureState.release();
  assert.equal((await inflight).status, 200);
  await fixtureState.notify("working-thread", "working-turn", "completed");
  assert.equal(fixtureState.calls.length, 1);
  assert.equal(fixtureState.coordinator.status().threads[0].phase, "terminal");
});

test("new HTTP, native IPC and worker exit dispatch through switched implementation while old HTTP completes once",
  { timeout: 15000 }, async context => {
    const fixtureState = await fixture(context);
    await fixtureState.notify("working-thread", "working-turn", "started");
    const inflight = fixtureState.request();
    await waitUntil(() => fixtureState.held.length === 1);
    assert.equal(typeof fixtureState.coordinator.liveCodeParticipant, "function", "COORDINATOR_LIVE_CODE_PARTICIPANT_MISSING");
    const participant = fixtureState.coordinator.liveCodeParticipant();
    assert.strictEqual(fixtureState.coordinator.liveCodeParticipant(), participant);
    assert.equal(participant.id, "inner-coordinator");
    assert.equal(participant.stateSchema, "inner-coordinator-state-v1");
    assert.equal(participant.exportName, "createInnerProxyCoordinatorImplementation");
    const originalStatus = fixtureState.coordinator.status();
    const before = participant.snapshot();
    const markers = [];
    let sharedState;
    const candidate = participant.prepare({ [participant.exportName]: state => {
      sharedState = state;
      const implementation = coordinatorModule[participant.exportName](state);
      return Object.fromEntries(Object.entries(implementation).map(([name, method]) => [name, (...args) => {
        markers.push({ name, http: args[0] instanceof http.IncomingMessage,
          ipc: args.some(value => value?.channel === HANDOFF_CHANNEL) });
        return method(...args);
      }]));
    } });
    assert.deepEqual(participant.snapshot(), before, "prepare changed coordinator resources or counters");
    assert.ok(sharedState && typeof sharedState === "object");
    const token = participant.activate(candidate);
    assert.ok(token && typeof token === "object");
    const after = fixtureState.coordinator.status();
    assert.deepEqual(after.workers, originalStatus.workers);
    assert.deepEqual(after.threads, originalStatus.threads);
    await fixtureState.catalog();
    assert.ok(markers.some(marker => marker.http), "new HTTP remained on old closure");
    await fixtureState.notify("second-thread", "second-turn", "started");
    assert.ok(markers.some(marker => marker.name === "observeNativeMessage"));
    assert.ok(markers.some(marker => marker.ipc), "real worker IPC remained on old closure");
    participant.restore(token);
    const markerCount = markers.length;
    await fixtureState.catalog();
    assert.equal(markers.length, markerCount, "restore retained candidate dispatch");
    fixtureState.release();
    assert.equal((await inflight).status, 200);
    assert.equal(fixtureState.calls.filter(call => call.method === "POST").length, 1);
    await fixtureState.notify("working-thread", "working-turn", "completed");
    await fixtureState.notify("second-thread", "second-turn", "completed");
    participant.activate(candidate);
    await fixtureState.coordinator.close();
    assert.ok(markers.some(marker => /exit/iu.test(marker.name)), "worker exit remained on old closure");
  });

test("prepare rejects missing export and every missing dispatch method without selecting or altering state",
  { timeout: 12000 }, async context => {
    const fixtureState = await fixture(context);
    assert.equal(typeof fixtureState.coordinator.liveCodeParticipant, "function", "COORDINATOR_LIVE_CODE_PARTICIPANT_MISSING");
    const participant = fixtureState.coordinator.liveCodeParticipant();
    assert.equal(typeof coordinatorModule[participant.exportName], "function", "COORDINATOR_IMPLEMENTATION_EXPORT_MISSING");
    const before = participant.snapshot();
    assert.throws(() => participant.prepare({}));
    assert.throws(() => participant.prepare({ [participant.exportName]: null }));
    let implementation;
    participant.prepare({ [participant.exportName]: state => {
      implementation = coordinatorModule[participant.exportName](state);
      return implementation;
    } });
    for (const [name, method] of Object.entries(implementation)) {
      if (typeof method !== "function") continue;
      assert.throws(() => participant.prepare({ [participant.exportName]: () => {
        const incomplete = { ...implementation };
        delete incomplete[name];
        return incomplete;
      } }), `missing dispatch method ${name} accepted`);
    }
    assert.deepEqual(participant.snapshot(), before);
  });

test("compiled coordinator generations keep live SSE, real IPC, listeners and state and release retired code", {
  timeout: 30000, skip: !esbuildModule,
}, async context => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/iu.test(name)));
  const result = await promisify(execFile)(process.execPath, ["--expose-gc",
    fileURLToPath(new URL("./inner-coordinator-live-code-native.mjs", import.meta.url)), esbuildModule],
  { cwd: fileURLToPath(new URL("../", import.meta.url)), env: environment, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(result.stderr, "");
  const evidence = JSON.parse(result.stdout.trim());
  assert.equal(evidence.postExecutions, 1);
  assert.equal(evidence.switches, 9);
  assert.equal(evidence.sameListener, true);
  assert.equal(evidence.sameWorker, true);
  assert.equal(evidence.sameThread, true);
  assert.equal(evidence.sameRequest, true);
  assert.equal(evidence.retiredCollected, true);
  assert.equal(evidence.workerExitCode, 0);
  assert.equal(evidence.removed, true);
  context.diagnostic(JSON.stringify(evidence));
});

test("640 terminal threads pass through the real runner and old threads continue without HTTP replay", { timeout: 15000 }, async context => {
  const fixtureState = await fixture(context);
  const shared = fixtureState.coordinator.liveCodeParticipant().snapshot().state;
  assert.equal(shared.maxThreads, 128);
  for (let index = 0; index < 640; index++) {
    await fixtureState.notify(`history-thread-${index}`, `history-turn-${index}`, "started");
    await fixtureState.notify(`history-thread-${index}`, `history-turn-${index}`, "completed");
  }
  assert.equal(shared.threads.size, 128);
  assert.ok([...shared.threads.values()].every(thread => thread.phase === "terminal"));
  assert.equal(shared.terminalThreads.size, 128);
  const retainedThread = shared.terminalThreads.get("history-thread-384");
  await fixtureState.notify("history-thread-overflow", "history-turn-overflow", "started");
  assert.equal(shared.threads.size, 128);
  assert.strictEqual(shared.terminalThreads.get("history-thread-384"), undefined);
  assert.equal(shared.threads.get("history-thread-overflow").phase, "active");
  await fixtureState.notify("history-thread-385", "continued-archived-turn", "started");
  await fixtureState.notify("history-thread-385", "continued-archived-turn", "completed");
  await fixtureState.notify("history-thread-0", "continued-expired-turn", "started");
  await fixtureState.notify("history-thread-0", "continued-expired-turn", "completed");
  assert.strictEqual(shared.threads.get("history-thread-0").worker, shared.defaultWorker);
  assert.equal(fixtureState.coordinator.status().nativeHealthy, true);
  assert.equal(fixtureState.events.some(event => event.type === "native_relay_failed"), false);
  assert.equal(fixtureState.calls.length, 0);
  const workerState = await shared.dispatch("control", shared.defaultWorker, "check", { threadId: "history-thread-0" });
  assert.equal(workerState.native.turnId, "continued-expired-turn");
  assert.equal(workerState.nativeHistory.retained, 128);
  assert.equal(workerState.nativeHistory.archived, 128);
  context.diagnostic(JSON.stringify({ evidence: "real-worker-terminal-history-over-128", endedThreads: 640,
    retainedThreads: shared.threads.size, archivedThreads: shared.terminalThreads.size,
    runnerHistory: workerState.nativeHistory, retainedObjectWasArchived: Boolean(retainedThread),
    httpExecutions: fixtureState.calls.length, nativeHealthy: true, nativeSequence: shared.nativeSequence }));
});

test("real-worker terminal archive survives implementation switch, handoff and same-thread continuation", { timeout: 15000 }, async context => {
  const fixtureState = await fixture(context);
  const participant = fixtureState.coordinator.liveCodeParticipant();
  const shared = participant.snapshot().state;
  shared.maxThreads = 2;
  participant.activate(participant.prepare(coordinatorModule));
  for (const threadId of ["archived-thread", "recent-thread", "latest-thread"]) {
    await fixtureState.notify(threadId, `${threadId}-turn`, "started");
    await fixtureState.notify(threadId, `${threadId}-turn`, "completed");
  }
  const archived = shared.terminalThreads.get("archived-thread");
  assert.ok(archived);
  const history = shared.terminalThreads;
  participant.activate(participant.prepare(coordinatorModule));
  assert.strictEqual(shared.terminalThreads, history);
  assert.strictEqual(history.get("archived-thread"), archived);
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs",
    core: "codex-model-stream-proxy.mjs", helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
    .map(([key, name]) => [key, digest(fs.readFileSync(path.join(sourceRoot, name)))]));
  const candidate = await fixtureState.coordinator.prepareCandidate({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes });
  const receipt = await fixtureState.coordinator.migrate({ threadId: "archived-thread", candidateId: candidate.workerId });
  assert.equal(receipt.committed, true);
  assert.strictEqual(history.get("archived-thread"), archived);
  assert.equal(archived.worker.workerId, candidate.workerId);
  await fixtureState.notify("archived-thread", "continued-turn", "started");
  assert.strictEqual(shared.threads.get("archived-thread"), archived);
  assert.equal(history.has("archived-thread"), false);
  await fixtureState.notify("archived-thread", "continued-turn", "completed");
  assert.equal(archived.nativeRelays, 0);
  assert.equal(fixtureState.coordinator.status().nativeHealthy, true);
  context.diagnostic(JSON.stringify({ evidence: "real-worker-bounded-terminal-history", testLimit: 2,
    sameHistoryMap: true, sameThreadObject: true, handoffCommitted: true, continuationWorker: candidate.workerId,
    retainedThreads: shared.threads.size, archivedThreads: history.size, nativeHealthy: true }));
});

test("terminal HTTP remains on the original state until its SSE finishes once, then continuation also executes once", { timeout: 15000 }, async context => {
  const fixtureState = await fixture(context);
  const participant = fixtureState.coordinator.liveCodeParticipant();
  const shared = participant.snapshot().state;
  shared.maxThreads = 2;
  participant.activate(participant.prepare(coordinatorModule));
  await fixtureState.notify("working-thread", "working-turn", "started");
  const original = shared.threads.get("working-thread");
  const inflight = fixtureState.request();
  await waitUntil(() => fixtureState.held.length === 1);
  await fixtureState.notify("working-thread", "working-turn", "completed");
  await fixtureState.notify("second-thread", "second-turn", "started");
  await fixtureState.notify("second-thread", "second-turn", "completed");
  assert.throws(() => fixtureState.notify("third-thread", "third-turn", "started"), { code: "COORDINATOR_THREAD_LIMIT" });
  assert.strictEqual(shared.threads.get("working-thread"), original);
  assert.equal(original.activeHttp, 1);
  assert.equal(shared.requests.size, 1);
  assert.equal(shared.terminalThreads.size, 0);
  fixtureState.release();
  assert.equal((await inflight).status, 200);
  await waitUntil(() => shared.requests.size === 0);
  await fixtureState.notify("third-thread", "third-turn", "started");
  await fixtureState.notify("third-thread", "third-turn", "completed");
  assert.strictEqual(shared.terminalThreads.get("working-thread"), original);
  await fixtureState.notify("working-thread", "continued-turn", "started");
  assert.strictEqual(shared.threads.get("working-thread"), original);
  const continued = fixtureState.request("working-thread", "continued-turn");
  await waitUntil(() => fixtureState.held.length === 2);
  fixtureState.release();
  assert.equal((await continued).status, 200);
  await fixtureState.notify("working-thread", "continued-turn", "completed");
  await waitUntil(() => shared.requests.size === 0);
  assert.equal(original.activeHttp, 0);
  assert.equal(original.worker.activeHttp, 0);
  assert.equal(fixtureState.calls.filter(call => call.method === "POST").length, 2);
  assert.equal(fixtureState.events.filter(event => event.type === "request_routed").length, 2);
  assert.equal(fixtureState.coordinator.status().nativeHealthy, true);
  context.diagnostic(JSON.stringify({ evidence: "real-worker-terminal-sse-and-continuation", testLimit: 2,
    postExecutions: 2, sameThreadObject: true, activeHttp: 0, requests: 0, nativeHealthy: true }));
});
