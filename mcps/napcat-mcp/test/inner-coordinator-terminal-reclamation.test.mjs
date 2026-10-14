import test from "node:test";
import assert from "node:assert/strict";
import { createInnerProxyCoordinatorImplementation } from "../src/inner-proxy-coordinator.mjs";
import { createInnerNativeTurnSource } from "../src/inner-native-turn-source.mjs";

function fixture() {
  const events = [];
  const controls = [];
  const worker = workerId => ({ workerId, activeHttp: 0, nativeSequence: 0, threadHistory: new Set(),
    releasedThreadHistory: new Set(), native: new Map(),
    child: { pid: workerId === "source" ? 101 : 102, connected: true, exitCode: null, signalCode: null },
    ready: { instanceToken: workerId, sourceHashes: { core: "core", helper: "helper" } } });
  const source = worker("source");
  const state = { options: {}, nativeSourceId: "unit-native", workers: new Map([[source.workerId, source]]),
    reclaimedWorkers: [], threads: new Map(), terminalThreads: new Map(), migrations: new Map(), pending: new Map(),
    adoptions: new Map(), requests: new Map(), maxThreads: 128, defaultWorker: source, nativeSequence: 0,
    generation: 0, relay: Promise.resolve(), nativeHealthy: true, transactionActive: false, workerMaintenance: false,
    server: { listening: false }, onEvent: event => events.push(event) };
  state.dispatch = (method, ...args) => state.implementation[method](...args);
  state.bindDispatch = (method, ...bound) => (...args) => state.dispatch(method, ...bound, ...args);
  const control = async (owner, method, params = {}) => {
    controls.push({ owner, method, params });
    if (method === "nativeTurn" || method === "restoreTerminal") owner.native.set(params.event.threadId, params.event);
    if (method === "shutdown") {
      if (owner.shutdownError) throw owner.shutdownError;
      owner.child.exitCode = 0;
      owner.child.connected = false;
    }
    if (method === "check") return { status: { running: true, draining: false, activeRequests: owner.remoteHttp ?? 0 },
      native: owner.native.get(params.threadId), nativeHistory: { retained: owner.native.size, archived: 0 } };
    if (method === "prepare") return { fileName: params.fileName, sha256: "checkpoint", token: "token" };
    if (method === "accept") return { threadId: params.threadId, importedEntries: 0 };
    return { recorded: true };
  };
  const implementation = () => ({ ...createInnerProxyCoordinatorImplementation(state), control });
  state.implementation = implementation();
  const notify = (threadId, turnId, phase = "started", status = "completed") => state.dispatch("observeNativeMessage", "unit-native", {
    method: `turn/${phase}`, params: { threadId, turn: { id: turnId, ...(phase === "completed" ? { status } : {}) } },
  });
  const finish = async (threadId, turnId = `${threadId}-turn`, status = "completed") => {
    await notify(threadId, turnId);
    await notify(threadId, turnId, "completed", status);
  };
  const fill = async (count = 128, prefix = "thread") => {
    for (let index = 0; index < count; index += 1) await finish(`${prefix}-${index}`);
  };
  return { state, source, worker, controls, events, implementation, notify, finish, fill };
}

test("terminal slots remain reusable while unrelated work is active on the same worker", async () => {
  const current = fixture();
  await current.notify("held-thread", "held-turn");
  const held = current.state.threads.get("held-thread");
  held.activeHttp = 1;
  current.source.activeHttp = 1;
  current.state.requests.set("held-request", { thread: held, worker: current.source });
  current.state.pending.set("unrelated-control", { worker: current.source });
  const source = createInnerNativeTurnSource({ sourceId: "unit-native", coordinator: {
    observeNativeMessage: (sourceId, message) => current.state.dispatch("observeNativeMessage", sourceId, message),
    status: () => ({ nativeHealthy: current.state.nativeHealthy }),
  } });
  for (let index = 0; index < 640; index += 1) {
    for (const phase of ["started", "completed"]) await source.observe({ method: `turn/${phase}`,
      params: { threadId: `capacity-${index}`, turn: { id: `turn-${index}`,
        ...(phase === "completed" ? { status: "completed" } : {}) } } });
  }
  assert.equal(source.status().healthy, true);
  assert.equal(current.state.threads.size, 128);
  assert.equal(current.state.terminalThreads.size, 128);
  assert.strictEqual(current.state.threads.get("held-thread"), held);
  assert.equal(held.activeHttp, 1);
  assert.equal(current.source.activeHttp, 1);
  assert.equal(current.state.requests.size, 1);
  assert.equal(current.state.pending.size, 1);
});

test("current turn duplicates remain idempotent after the event source forgets its cache", async () => {
  const current = fixture();
  await current.notify("repeated", "same-turn");
  await current.notify("repeated", "same-turn");
  assert.equal(current.state.nativeSequence, 1);
  assert.equal(current.controls.length, 1);
  await current.notify("repeated", "same-turn", "completed");
  await current.notify("repeated", "same-turn", "completed");
  assert.equal(current.state.nativeSequence, 2);
  assert.equal(current.controls.length, 2);
  assert.throws(() => current.notify("repeated", "same-turn", "completed", "failed"), { code: "COORDINATOR_NATIVE_SEQUENCE_INVALID" });
  assert.equal(current.state.threads.get("repeated").completion.status, "completed");
});

test("ended threads retain history without blocking successive selections and resume into the latest worker", async () => {
  const current = fixture();
  await current.fill(9);
  const originals = [...current.state.threads.values()];
  for (const workerId of ["second", "third", "fourth"]) {
    const candidate = current.worker(workerId);
    current.state.workers.set(workerId, candidate);
    const receipt = await current.state.dispatch("activate", { candidateId: workerId });
    assert.deepEqual(receipt.deferredThreadIds, []);
    assert.equal(receipt.stateTransferComplete, false);
    assert.deepEqual([...current.state.threads.values()], originals);
    assert.ok(originals.every(state => state.worker === current.source && !state.pendingActivation));
  }
  await current.notify("thread-0", "resumed");
  const resumed = current.state.threads.get("thread-0");
  assert.strictEqual(resumed.pendingActivation, current.state.activation);
  await current.state.dispatch("adoptForRequest", resumed, { turn_id: "resumed" }, {}, {});
  assert.strictEqual(resumed.worker, current.state.defaultWorker);
  assert.equal(resumed.pendingActivation, undefined);
  assert.equal(current.source.releasedThreadHistory.has("thread-0"), true);
});

test("an implementation replacement accepts existing terminal-only deferred state without changing history owners", async () => {
  const current = fixture();
  await current.fill(9);
  const previousTarget = current.worker("previous-target");
  const candidate = current.worker("candidate");
  current.state.workers.set(previousTarget.workerId, previousTarget);
  current.state.workers.set(candidate.workerId, candidate);
  current.state.activation = { id: "old-selection", active: true, source: current.source, target: previousTarget };
  current.state.defaultWorker = previousTarget;
  for (const state of current.state.threads.values()) state.pendingActivation = current.state.activation;
  current.state.implementation = current.implementation();
  const receipt = await current.state.dispatch("activate", { candidateId: candidate.workerId });
  assert.deepEqual(receipt.deferredThreadIds, []);
  assert.ok([...current.state.threads.values()].every(state => state.worker === current.source && !state.pendingActivation));
  assert.equal(current.source.threadHistory.size, 9);
});

test("640 ended threads leave bounded coordinator maps and a new thread can enter", async context => {
  const current = fixture();
  await current.fill(640);
  assert.equal(current.state.maxThreads, 128);
  assert.equal(current.state.threads.size, 128);
  assert.equal(current.state.terminalThreads.size, 128);
  assert.ok([...current.state.threads.values(), ...current.state.terminalThreads.values()].every(state => state.nativeRelays === 0));
  await current.notify("new-thread", "new-turn");
  assert.equal(current.state.threads.get("new-thread").phase, "active");
  assert.equal(current.state.nativeHealthy, true);
  assert.equal(current.controls.filter(entry => entry.method === "nativeTurn").length, 1281);
  context.diagnostic(JSON.stringify({ evidence: "coordinator-unit-terminal-reclamation", endedThreads: 640,
    retainedThreads: current.state.threads.size, archivedThreads: current.state.terminalThreads.size,
    archiveLimit: 128, relayedEvents: 1281, workerBoundary: "simulated control only" }));
});

test("archived continuation restores the exact state object, maps and worker after implementation replacement", async () => {
  const current = fixture();
  await current.fill();
  const original = current.state.threads.get("thread-0");
  const threads = current.state.threads;
  const history = current.state.terminalThreads;
  await current.finish("overflow");
  assert.strictEqual(history.get("thread-0"), original);
  current.state.implementation = current.implementation();
  await current.notify("thread-0", "continued");
  assert.strictEqual(current.state.threads, threads);
  assert.strictEqual(current.state.terminalThreads, history);
  assert.strictEqual(threads.get("thread-0"), original);
  assert.equal(history.has("thread-0"), false);
  assert.strictEqual(original.worker, current.source);
  assert.equal(original.turnId, "continued");
  await current.notify("thread-0", "continued", "completed");
  assert.equal(original.nativeRelays, 0);
});

test("expired terminal continuation routes to its unique original worker after default selection changes", async () => {
  const current = fixture();
  await current.fill(640);
  assert.equal(current.state.threads.has("thread-0"), false);
  assert.equal(current.state.terminalThreads.has("thread-0"), false);
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  current.state.defaultWorker = target;
  await current.notify("thread-0", "restored-turn");
  assert.strictEqual(current.state.threads.get("thread-0").worker, current.source);
  await current.notify("brand-new", "fresh-turn");
  assert.strictEqual(current.state.threads.get("brand-new").worker, target);
});

test("128 active turns still reject the next thread without changing resources or sequence", async () => {
  const current = fixture();
  for (let index = 0; index < 128; index += 1) await current.notify(`active-${index}`, `turn-${index}`);
  const sequence = current.state.nativeSequence;
  assert.throws(() => current.notify("overflow", "turn-overflow"), { code: "COORDINATOR_THREAD_LIMIT" });
  assert.equal(current.state.nativeSequence, sequence);
  assert.equal(current.state.threads.size, 128);
  assert.equal(current.state.terminalThreads.size, 0);
});

const protections = {
  "active turn": (current, state) => { state.phase = "active"; },
  "active HTTP on the original state": (current, state) => { state.activeHttp = 1; },
  "migration": (current, state) => { current.state.migrations.set(state.threadId, { done: Promise.resolve() }); },
  "adoption": (current, state) => { current.state.adoptions.set(state.threadId, Promise.resolve()); },
  "pending activation": (current, state) => { state.pendingActivation = { active: true }; },
  "activation error": (current, state) => { state.activationError = "held"; },
  "request still references the state": (current, state) => { current.state.requests.set("held", { thread: state }); },
  "worker startup": current => { current.source.startup = {}; },
  "worker cleanup pending": current => { current.source.cleanupPending = true; },
};

for (const [name, protect] of Object.entries(protections)) {
  test(`terminal reclamation preserves ${name}`, async () => {
    const current = fixture();
    await current.fill();
    const original = current.state.threads.get("thread-0");
    for (const state of current.state.threads.values()) if (state !== original) state.phase = "active";
    protect(current, original);
    const sequence = current.state.nativeSequence;
    const pending = [...current.state.pending];
    const migrations = [...current.state.migrations];
    const adoptions = [...current.state.adoptions];
    const requests = [...current.state.requests];
    assert.throws(() => current.notify("overflow", "new-turn"), { code: "COORDINATOR_THREAD_LIMIT" });
    assert.strictEqual(current.state.threads.get(original.threadId), original);
    assert.equal(current.state.nativeSequence, sequence);
    assert.equal(current.state.terminalThreads.size, 0);
    assert.deepEqual([...current.state.pending], pending);
    assert.deepEqual([...current.state.migrations], migrations);
    assert.deepEqual([...current.state.adoptions], adoptions);
    assert.deepEqual([...current.state.requests], requests);
  });
}

test("queued native starts and completions cannot be reclaimed before their worker relay finishes", async () => {
  const current = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalControl = current.state.implementation.control;
  current.state.implementation.control = async (...args) => { await gate; return originalControl(...args); };
  for (let index = 0; index < 128; index += 1) {
    current.notify(`queued-${index}`, `turn-${index}`);
    current.notify(`queued-${index}`, `turn-${index}`, "completed");
  }
  const original = current.state.threads.get("queued-0");
  assert.equal(original.nativeRelays, 2);
  assert.throws(() => current.notify("overflow", "new-turn"), { code: "COORDINATOR_THREAD_LIMIT" });
  assert.strictEqual(current.state.threads.get("queued-0"), original);
  release();
  await current.state.relay;
  assert.equal(original.nativeRelays, 0);
  await current.notify("overflow", "new-turn");
  assert.strictEqual(current.state.terminalThreads.get("queued-0"), original);
  assert.equal(current.controls.length, 257);
});

test("an archived terminal remains available for handoff and its original object is preserved", async () => {
  const current = fixture();
  await current.fill(129);
  const original = current.state.terminalThreads.get("thread-0");
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  const receipt = await current.state.dispatch("migrate", { threadId: original.threadId, candidateId: target.workerId });
  assert.equal(receipt.committed, true);
  assert.strictEqual(current.state.terminalThreads.get(original.threadId), original);
  assert.strictEqual(original.worker, target);
  await current.notify(original.threadId, "migrated-turn");
  assert.strictEqual(current.state.threads.get(original.threadId), original);
  assert.strictEqual(original.worker, target);
});

test("activation and rollback preserve idle archives and restore expired history through deferred adoption", async () => {
  const current = fixture();
  await current.fill(640);
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  const archived = current.state.terminalThreads.get("thread-384");
  const receipt = await current.state.dispatch("activate", { candidateId: target.workerId });
  assert.equal(receipt.deferredThreadIds.length, 0);
  assert.equal(archived.pendingActivation, undefined);
  assert.strictEqual(archived.worker, current.source);
  current.state.dispatch("rollbackActivation", { activationId: receipt.activationId });
  assert.equal(archived.pendingActivation, undefined);
  await current.notify("thread-0", "restored-turn");
  const next = await current.state.dispatch("activate", { candidateId: target.workerId });
  const restored = current.state.threads.get("thread-0");
  assert.strictEqual(restored.worker, current.source);
  assert.equal(restored.pendingActivation.id, next.activationId);
});

test("full protected archive refuses further reclamation and keeps every routing object", async () => {
  const current = fixture();
  await current.fill(256);
  const target = current.worker("target");
  for (const threadId of current.state.terminalThreads.keys()) target.threadHistory.add(threadId);
  current.state.workers.set(target.workerId, target);
  const threads = [...current.state.threads];
  const history = [...current.state.terminalThreads];
  assert.throws(() => current.notify("overflow", "new-turn"), { code: "COORDINATOR_THREAD_LIMIT" });
  assert.deepEqual([...current.state.threads], threads);
  assert.deepEqual([...current.state.terminalThreads], history);
  const original = current.state.terminalThreads.get("thread-0");
  await current.notify("thread-0", "continued-turn");
  assert.strictEqual(current.state.threads.get("thread-0"), original);
  assert.equal(current.state.terminalThreads.size, 128);
});

test("worker reclamation preserves archives and expired ownership identities", async () => {
  const current = fixture();
  await current.fill(640);
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  current.state.defaultWorker = target;
  current.source.retired = true;
  await current.state.dispatch("reclaimRetiredWorkers");
  assert.strictEqual(current.state.workers.get("source"), current.source);
  assert.equal(current.controls.some(entry => entry.method === "shutdown"), false);
});

test("activation retires empty sources and only superseded rollback sources are reclaimed", async () => {
  const current = fixture();
  const target = current.worker("second");
  current.state.workers.set(target.workerId, target);
  await current.state.dispatch("activate", { candidateId: target.workerId });
  assert.equal(current.source.retired, true);
  await current.state.dispatch("reclaimRetiredWorkers");
  assert.equal(current.source.child.exitCode, null);
  const third = current.worker("third");
  current.state.workers.set(third.workerId, third);
  const activation = await current.state.dispatch("activate", { candidateId: third.workerId });
  await current.state.dispatch("reclaimRetiredWorkers");
  assert.equal(current.source.child.exitCode, 0);
  assert.equal(current.state.workers.has(current.source.workerId), false);
  assert.equal(target.child.exitCode, null);
  current.state.dispatch("rollbackActivation", { activationId: activation.activationId });
  assert.equal(third.retired, true);
  const fourth = current.worker("fourth");
  current.state.workers.set(fourth.workerId, fourth);
  await current.state.dispatch("activate", { candidateId: fourth.workerId });
  await current.state.dispatch("reclaimRetiredWorkers");
  assert.equal(third.child.exitCode, 0);
  assert.equal(target.child.exitCode, null);
  assert.strictEqual(current.state.defaultWorker, fourth);
});

const discardProtections = {
  "not prepared": (current, worker) => { worker.preparedCandidate = false; },
  "not ready": (current, worker) => { worker.ready = null; },
  "startup pending": (current, worker) => { worker.startup = {}; },
  "current default": (current, worker) => { current.state.defaultWorker = worker; },
  "previous default": (current, worker) => { worker.wasDefault = true; },
  "previous activation": (current, worker) => { worker.wasActivated = true; },
  "rollback source": (current, worker) => { current.state.activation = { source: worker }; },
  "activation target": (current, worker) => { current.state.activation = { target: worker }; },
  "HTTP in flight": (current, worker) => { worker.activeHttp = 1; },
  "remote HTTP in flight": (current, worker) => { worker.remoteHttp = 1; },
  "IPC in flight": (current, worker) => { current.state.pending.set("ipc", { worker }); },
  "queued native relay": (current, worker) => { current.state.threads.set("queued", { worker, nativeRelays: 1 }); },
  "archived thread": (current, worker) => { current.state.terminalThreads.set("archive", { worker }); },
  "historical ownership": (current, worker) => { worker.threadHistory.add("past-thread"); },
  "released history": (current, worker) => { worker.releasedThreadHistory.add("past-thread"); },
  "native activity": (current, worker) => { worker.nativeSequence = 1; },
  "untracked remote native record": (current, worker) => { worker.native.set("remote", { phase: "terminal" }); },
  "unfinished cleanup": (current, worker) => { worker.cleanupPending = true; },
  "request reference": (current, worker) => { current.state.requests.set("request", { worker }); },
  "pending activation": (current, worker) => {
    current.state.threads.set("adopting", { worker: current.source, pendingActivation: { target: worker } });
  },
};

test("a candidate whose activation fails before selection can be discarded without changing A", async () => {
  const current = fixture();
  const worker = current.worker("prepared");
  worker.preparedCandidate = true;
  worker.ready.sourceHashes.core = "different-core";
  current.state.workers.set(worker.workerId, worker);
  await assert.rejects(current.state.dispatch("activate", { candidateId: worker.workerId }), { code: "CHECKPOINT_VERSION_EDGE_NOT_ALLOWED" });
  assert.strictEqual(current.state.defaultWorker, current.source);
  assert.equal(worker.wasActivated, undefined);
  const receipt = await current.state.dispatch("discardCandidate", { workerId: worker.workerId });
  assert.equal(receipt.discarded, true);
  assert.equal(worker.child.exitCode, 0);
  assert.equal(current.source.child.exitCode, null);
  const repeat = await current.state.dispatch("discardCandidate", { workerId: worker.workerId });
  assert.equal(repeat.alreadyDiscarded, true);
  assert.equal(current.controls.filter(entry => entry.method === "shutdown").length, 1);
  await assert.rejects(current.state.dispatch("discardCandidate", { workerId: "unknown" }), { code: "COORDINATOR_WORKER_NOT_FOUND" });
  await assert.rejects(current.state.dispatch("discardCandidate", { workerId: "../invalid" }), { code: "COORDINATOR_INVALID_CANDIDATE" });
});

test("a new IPC reference during the candidate health check prevents its shutdown", async () => {
  const current = fixture();
  const worker = current.worker("prepared");
  worker.preparedCandidate = true;
  current.state.workers.set(worker.workerId, worker);
  const control = current.state.implementation.control;
  current.state.implementation.control = async (...args) => {
    const reply = await control(...args);
    if (args[1] === "check") current.state.pending.set("arrived", { worker });
    return reply;
  };
  await assert.rejects(current.state.dispatch("discardCandidate", { workerId: worker.workerId }), { code: "COORDINATOR_CANDIDATE_PROTECTED" });
  assert.equal(worker.child.exitCode, null);
  assert.equal(current.controls.some(entry => entry.method === "shutdown"), false);
});

for (const [name, protect] of Object.entries(discardProtections)) {
  test(`discardCandidate protects ${name}`, async () => {
    const current = fixture();
    const worker = current.worker("prepared");
    worker.preparedCandidate = true;
    current.state.workers.set(worker.workerId, worker);
    protect(current, worker);
    await assert.rejects(current.state.dispatch("discardCandidate", { workerId: worker.workerId }), { code: "COORDINATOR_CANDIDATE_PROTECTED" });
    assert.equal(worker.child.exitCode, null);
    assert.strictEqual(current.state.workers.get(worker.workerId), worker);
    assert.equal(current.controls.some(entry => entry.method === "shutdown"), false);
    assert.equal(current.state.workerMaintenance, false);
  });
}

for (const flag of ["transactionActive", "workerMaintenance", "preparationTask", "starting", "closing"]) {
  test(`discardCandidate refuses ${flag} without shutting down any worker`, async () => {
    const current = fixture();
    const worker = current.worker("prepared");
    worker.preparedCandidate = true;
    current.state.workers.set(worker.workerId, worker);
    current.state[flag] = true;
    await assert.rejects(current.state.dispatch("discardCandidate", { workerId: worker.workerId }), { code: "COORDINATOR_CANDIDATE_DISCARD_BUSY" });
    assert.equal(current.controls.length, 0);
    assert.equal(worker.child.exitCode, null);
  });
}

test("discardCandidate keeps an unconfirmed shutdown and its worker record for a later retry", async () => {
  const current = fixture();
  const worker = current.worker("prepared");
  worker.preparedCandidate = true;
  worker.shutdownError = Object.assign(new Error("owned shutdown failure"), { code: "OWNED_SHUTDOWN_FAILED" });
  current.state.workers.set(worker.workerId, worker);
  await assert.rejects(current.state.dispatch("discardCandidate", { workerId: worker.workerId }), { code: "OWNED_SHUTDOWN_FAILED" });
  assert.equal(worker.reclamation, "cleanup_pending");
  assert.strictEqual(current.state.workers.get(worker.workerId), worker);
  assert.equal(worker.child.connected, true);
  assert.equal(worker.child.exitCode, null);
  assert.equal(current.state.reclaimedWorkers.length, 0);
  assert.equal(current.state.workerMaintenance, false);
  delete worker.shutdownError;
  const receipt = await current.state.dispatch("discardCandidate", { workerId: worker.workerId });
  assert.equal(receipt.discarded, true);
  assert.equal(worker.child.exitCode, 0);
});

test("rollback restores only the latest selection and reports threads already adopted by B", async () => {
  const current = fixture();
  await current.finish("already-owned");
  const candidate = current.worker("B");
  current.state.workers.set(candidate.workerId, candidate);
  const activation = await current.state.dispatch("activate", { candidateId: candidate.workerId });
  await current.state.dispatch("migrate", { threadId: "already-owned", candidateId: candidate.workerId }, { selectDefault: false });
  const receipt = current.state.dispatch("rollbackActivation", { activationId: activation.activationId });
  assert.strictEqual(current.state.defaultWorker, current.source);
  assert.strictEqual(current.state.threads.get("already-owned").worker, candidate);
  assert.deepEqual(receipt.retainedThreadIds, ["already-owned"]);
  assert.throws(() => current.state.dispatch("rollbackActivation", { activationId: activation.activationId }), { code: "COORDINATOR_ACTIVATION_NOT_CURRENT" });
  await assert.rejects(current.state.dispatch("discardCandidate", { workerId: candidate.workerId }), { code: "COORDINATOR_CANDIDATE_PROTECTED" });
});

test("rollback rejects a superseded activation, a current transaction and an unavailable source", async () => {
  const current = fixture();
  const second = current.worker("B");
  const third = current.worker("C");
  current.state.workers.set(second.workerId, second);
  current.state.workers.set(third.workerId, third);
  const first = await current.state.dispatch("activate", { candidateId: second.workerId });
  const latest = await current.state.dispatch("activate", { candidateId: third.workerId });
  assert.throws(() => current.state.dispatch("rollbackActivation", { activationId: first.activationId }), { code: "COORDINATOR_ACTIVATION_NOT_CURRENT" });
  current.state.transactionActive = true;
  assert.throws(() => current.state.dispatch("rollbackActivation", { activationId: latest.activationId }), { code: "COORDINATOR_ACTIVATION_BUSY" });
  current.state.transactionActive = false;
  second.child.exitCode = 1;
  assert.throws(() => current.state.dispatch("rollbackActivation", { activationId: latest.activationId }), { code: "COORDINATOR_ACTIVATION_BUSY" });
  assert.strictEqual(current.state.defaultWorker, third);
});

for (const [name, protect] of Object.entries({
  "worker HTTP": (current, worker) => { worker.activeHttp = 1; },
  "pending IPC": (current, worker) => { current.state.pending.set("ipc", { worker }); },
  "request reference": (current, worker) => { current.state.requests.set("http", { worker }); },
  "unfinished cleanup": (current, worker) => { worker.cleanupPending = true; },
  "pending activation source": (current, worker) => {
    current.state.terminalThreads.set("archive", { worker: current.source, pendingActivation: { source: worker } });
  },
})) {
  test(`retired worker reclamation preserves ${name}`, async () => {
    const current = fixture();
    const worker = current.worker("retired");
    worker.retired = true;
    current.state.workers.set(worker.workerId, worker);
    protect(current, worker);
    await current.state.dispatch("reclaimRetiredWorkers");
    assert.equal(worker.child.exitCode, null);
    assert.strictEqual(current.state.workers.get(worker.workerId), worker);
    assert.equal(current.controls.some(entry => entry.method === "shutdown"), false);
  });
}

test("successfully migrated history can expire and later returns to its committed owner", async () => {
  const current = fixture();
  await current.finish("moved-thread");
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  await current.state.dispatch("migrate", { threadId: "moved-thread", candidateId: target.workerId });
  assert.equal(current.source.releasedThreadHistory.has("moved-thread"), true);
  assert.equal(target.releasedThreadHistory.has("moved-thread"), false);
  await current.fill(640);
  assert.equal(current.state.threads.has("moved-thread"), false);
  assert.equal(current.state.terminalThreads.has("moved-thread"), false);
  current.state.defaultWorker = current.source;
  await current.notify("moved-thread", "resumed-turn");
  assert.strictEqual(current.state.threads.get("moved-thread").worker, target);
});

test("failed candidate acceptance keeps the old owner after its terminal history expires", async () => {
  const current = fixture();
  await current.finish("preserved-thread");
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  const originalControl = current.state.implementation.control;
  current.state.implementation.control = (owner, method, params) => {
    if (method === "accept") throw Object.assign(new Error("synthetic acceptance failure"), { code: "FIXTURE_ACCEPT_FAILED" });
    return originalControl(owner, method, params);
  };
  await assert.rejects(current.state.dispatch("migrate", { threadId: "preserved-thread", candidateId: target.workerId }),
    { code: "FIXTURE_ACCEPT_FAILED" });
  assert.equal(target.releasedThreadHistory.has("preserved-thread"), true);
  assert.equal(current.source.releasedThreadHistory.has("preserved-thread"), false);
  await current.fill(640);
  current.state.defaultWorker = target;
  await current.notify("preserved-thread", "resumed-turn");
  assert.strictEqual(current.state.threads.get("preserved-thread").worker, current.source);
});

for (const flag of ["transactionActive", "workerMaintenance", "preparationTask", "closing"]) {
  test(`terminal reclamation is blocked during ${flag}`, async () => {
    const current = fixture();
    await current.fill();
    current.state[flag] = true;
    const original = [...current.state.threads];
    assert.throws(() => current.notify("new-thread", "new-turn"), { code: "COORDINATOR_THREAD_LIMIT" });
    assert.deepEqual([...current.state.threads], original);
    assert.equal(current.state.terminalThreads.size, 0);
  });
}

test("an ambiguous expired owner is rejected without retiring unrelated history", async () => {
  const current = fixture();
  await current.fill(640);
  const target = current.worker("target");
  target.threadHistory.add("thread-0");
  current.state.workers.set(target.workerId, target);
  const original = [...current.state.threads];
  const history = [...current.state.terminalThreads];
  const sequence = current.state.nativeSequence;
  assert.throws(() => current.notify("thread-0", "new-turn"), { code: "COORDINATOR_THREAD_OWNER_AMBIGUOUS" });
  assert.equal(current.state.nativeSequence, sequence);
  assert.deepEqual([...current.state.threads], original);
  assert.deepEqual([...current.state.terminalThreads], history);
});

test("production freshness still rejects a candidate whose released thread has expired from the coordinator cache", async () => {
  const current = fixture();
  await current.finish("moved-thread");
  const target = current.worker("target");
  current.state.workers.set(target.workerId, target);
  await current.state.dispatch("migrate", { threadId: "moved-thread", candidateId: target.workerId });
  await current.fill(640);
  current.state.runtimeProfile = {};
  current.state.implementation = current.implementation();
  await assert.rejects(current.state.dispatch("activate", { candidateId: current.source.workerId }),
    { code: "COORDINATOR_FRESH_WORKER_REQUIRED" });
  assert.strictEqual(current.state.defaultWorker, target);
});

const selectionProtections = {
  ...protections,
  "active HTTP on the worker": current => { current.source.activeHttp = 1; },
  "worker control in flight": current => { current.state.pending.set("held", { worker: current.source }); },
};
for (const [name, protect] of Object.entries(selectionProtections).filter(([name]) => name !== "pending activation")) {
  test(`terminal deferred selection still protects ${name}`, async () => {
    const current = fixture();
    await current.finish("terminal");
    const previousTarget = current.worker("previous-target");
    const candidate = current.worker("candidate");
    current.state.workers.set(previousTarget.workerId, previousTarget);
    current.state.workers.set(candidate.workerId, candidate);
    const activation = { id: "old", active: true, source: current.source, target: previousTarget };
    current.state.activation = activation;
    current.state.defaultWorker = previousTarget;
    const terminal = current.state.threads.get("terminal");
    terminal.pendingActivation = activation;
    protect(current, terminal);
    await assert.rejects(current.state.dispatch("activate", { candidateId: candidate.workerId }),
      { code: "COORDINATOR_ACTIVATION_BUSY" });
    assert.strictEqual(current.state.activation, activation);
    assert.strictEqual(current.state.defaultWorker, previousTarget);
    assert.strictEqual(terminal.worker, current.source);
  });
}

test("a terminal resumed during the candidate check prevents superseding its active migration", async () => {
  const current = fixture();
  await current.finish("terminal");
  const previousTarget = current.worker("previous-target");
  const candidate = current.worker("candidate");
  current.state.workers.set(previousTarget.workerId, previousTarget);
  current.state.workers.set(candidate.workerId, candidate);
  await current.state.dispatch("activate", { candidateId: previousTarget.workerId });
  const activation = current.state.activation;
  const control = current.state.implementation.control;
  current.state.implementation.control = async (owner, method, params) => {
    if (owner === candidate && method === "check") await current.notify("terminal", "resumed");
    return control(owner, method, params);
  };
  await assert.rejects(current.state.dispatch("activate", { candidateId: candidate.workerId }),
    { code: "COORDINATOR_ACTIVATION_BUSY" });
  assert.strictEqual(current.state.activation, activation);
  assert.strictEqual(current.state.threads.get("terminal").pendingActivation, activation);
});

test("idle terminal owners still require an explicit checkpoint compatibility edge", async () => {
  const current = fixture();
  await current.finish("terminal");
  const candidate = current.worker("candidate");
  candidate.ready.sourceHashes.core = "different-core";
  current.state.workers.set(candidate.workerId, candidate);
  await assert.rejects(current.state.dispatch("activate", { candidateId: candidate.workerId }),
    { code: "CHECKPOINT_VERSION_EDGE_NOT_ALLOWED" });
  assert.strictEqual(current.state.defaultWorker, current.source);
  assert.equal(current.state.threads.get("terminal").pendingActivation, undefined);
});

test("a nonfirst terminal with pending activation stays protected from capacity reclamation", async () => {
  const current = fixture();
  await current.fill();
  for (const state of current.state.threads.values()) state.pendingActivation = { active: true };
  assert.throws(() => current.notify("overflow", "new-turn"), { code: "COORDINATOR_THREAD_LIMIT" });
  assert.equal(current.state.terminalThreads.size, 0);
});
