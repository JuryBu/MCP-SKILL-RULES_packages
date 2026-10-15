import assert from "node:assert/strict";
import test from "node:test";
import { createProxyServiceCodeRuntime, createProxyServiceImplementation } from "../src/proxy-service-code-runtime.mjs";

function fixture() {
  const writes = [];
  const state = { options: { runtimeStatePath: "runtime", logPath: "log" }, fsImpl: {},
    now: () => new Date("2026-10-12T14:00:00Z"), pid: 1, lock: { isOwner: () => true },
    diagnosticStorageFailures: new Set(), diagnosticStorageWarningAt: 0, stopRequested: false, stopReason: null,
    status: { state: "running" }, appServer: { exitCode: null, signalCode: null },
    dependencies: { atomicWriteJson: (...args) => writes.push(args), appendJsonLine: (...args) => writes.push(args) } };
  return { state, writes, runtime: createProxyServiceCodeRuntime(state) };
}
test("already bound lifecycle handlers use new code and can restore the original generation", () => {
  const { state, writes, runtime } = fixture();
  const participant = runtime.liveCodeParticipant();
  const original = participant.snapshot();
  const persist = runtime.persist;
  const candidate = participant.prepare({ createProxyServiceImplementation: shared => {
    const base = createProxyServiceImplementation(shared);
    return { ...base, persist(patch, options) { return base.persist({ ...patch, version: "next" }, options); } };
  } });
  participant.activate(candidate);
  persist({ message: "same-service" });
  assert.equal(state.status.version, "next");
  assert.equal(writes.length, 1);
  participant.restore(original);
  persist({ version: "original" });
  assert.equal(state.status.version, "original");
  assert.equal(writes.length, 2);
});
test("installed signal handler dispatches new code while retaining its cleanup", () => {
  const { state, runtime } = fixture();
  const participant = runtime.liveCodeParticipant();
  const count = process.listenerCount("SIGINT");
  const cleanup = runtime.installSignals();
  try {
    participant.activate(participant.prepare({ createProxyServiceImplementation: shared => {
      const base = createProxyServiceImplementation(shared);
      return { ...base, requestStop(reason) { base.requestStop(`next:${reason}`); } };
    } }));
    process.emit("SIGINT");
    assert.equal(state.stopReason, "next:signal:SIGINT");
    assert.equal(state.stopRequested, true);
  } finally { cleanup(); }
  assert.equal(process.listenerCount("SIGINT"), count);
});
test("foreign candidate or copied restore token is refused", () => {
  const { runtime } = fixture();
  const participant = runtime.liveCodeParticipant();
  assert.throws(() => participant.activate({}), /PROXY_SERVICE_CODE_CANDIDATE_INVALID/u);
  assert.throws(() => participant.restore({ ...participant.snapshot() }), /PROXY_SERVICE_CODE_SNAPSHOT_INVALID/u);
});
test("diagnostic degradation and observer failure survive a code replacement", () => {
  const { state, runtime } = fixture();
  state.options.onDiagnosticStorageFailure = () => { throw new Error("observer"); };
  state.options.writeDiagnosticWarning = () => {};
  state.dependencies.atomicWriteJson = () => { throw Object.assign(new Error("disk"), { code: "ENOSPC" }); };
  const participant = runtime.liveCodeParticipant();
  participant.activate(participant.prepare({ createProxyServiceImplementation }));
  runtime.persist({}, { allowStorageDegradation: true });
  assert.equal(state.status.diagnosticStorageDegraded, true);
  assert.ok(state.diagnosticStorageFailures.has("runtime_state"));
});
test("an existing asynchronous lifecycle tick finishes once and the next tick uses new code", async () => {
  const { state, runtime } = fixture();
  state.fsImpl.existsSync = () => false;
  state.proxy = { status: () => ({ clientCount: 1 }) };
  state.dependencies.defaults = { emptyClientRestartMs: 30000 };
  state.dependencies.observeEmptyDesktopRestart = value => ({ state: value, shouldRestart: false });
  let release;
  state.dependencies.wait = () => new Promise(resolve => { release = resolve; });
  const cycle = { active: true, emptyDesktopRestartState: {}, nextLivenessAt: Number.MAX_SAFE_INTEGER, nextRefreshAt: Number.MAX_SAFE_INTEGER };
  const previousTick = runtime.watchLifecycleStep(cycle);
  const participant = runtime.liveCodeParticipant();
  let nextTicks = 0;
  participant.activate(participant.prepare({ createProxyServiceImplementation: shared => {
    const base = createProxyServiceImplementation(shared);
    return { ...base, async watchLifecycleStep() { nextTicks++; return { signal: "new-code" }; } };
  } }));
  release();
  assert.equal(await previousTick, null);
  assert.equal((await runtime.watchLifecycleStep(cycle)).signal, "new-code");
  assert.equal(nextTicks, 1);
  assert.equal(cycle.active, true);
});

test("empty Desktop shutdown waits for operations, tracked requests and pending tools to finish", async () => {
  for (const counter of ["activeOperationCount", "trackedRequestCount", "pendingToolCount"]) {
    const { state, runtime } = fixture();
    state.fsImpl.existsSync = () => false;
    state.dependencies.wait = async () => {};
    state.dependencies.observeEmptyDesktopRestart = value => ({ state: value, shouldRestart: true, emptyForMs: 10000 });
    const outerRuntime = { activeOperationCount: 0, trackedRequestCount: 0, pendingToolCount: 0, [counter]: 1 };
    state.proxy = { status: () => ({ clientCount: 0, outerRuntime }) };
    const cycle = { active: true, emptyDesktopRestartState: { sawDesktopClient: true },
      nextLivenessAt: Infinity, nextRefreshAt: Infinity };
    assert.equal(await runtime.watchLifecycleStep(cycle), null, counter);
    outerRuntime[counter] = 0;
    assert.equal((await runtime.watchLifecycleStep(cycle)).signal, "desktop_empty_restart", counter);
    outerRuntime[counter] = NaN;
    assert.equal(await runtime.watchLifecycleStep(cycle), null, `${counter}: unknown`);
  }
});

test("a Desktop that closes between lifecycle polls is still observed", async () => {
  const { state, runtime } = fixture();
  state.fsImpl.existsSync = () => false;
  state.dependencies.wait = async () => {};
  state.proxy = { status: () => ({ clientCount: 0 }) };
  runtime.handleProxyEvent({ type: "client_closed" });
  let sawDesktopClient;
  state.dependencies.observeEmptyDesktopRestart = value => {
    sawDesktopClient = value.sawDesktopClient;
    return { state: value, shouldRestart: false };
  };
  await runtime.watchLifecycleStep({ active: true, emptyDesktopRestartState: {}, nextLivenessAt: Infinity, nextRefreshAt: Infinity });
  assert.equal(sawDesktopClient, true);
});

test("waiting for Desktop remains stoppable without launching another backend", async () => {
  const { state, runtime } = fixture();
  state.waitingForDesktop = true;
  state.fsImpl.existsSync = () => false;
  state.proxy = { status: () => ({ clientCount: 0 }) };
  let release;
  state.dependencies.wait = () => new Promise(resolve => { release = resolve; });
  const pending = runtime.runBackendCycle();
  assert.equal(typeof release, "function");
  runtime.requestStop("owned-test");
  release();
  assert.deepEqual(await pending, { stop: true });
});
