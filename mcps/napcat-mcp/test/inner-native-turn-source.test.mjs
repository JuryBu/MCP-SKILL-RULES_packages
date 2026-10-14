import test from "node:test";
import assert from "node:assert/strict";
import { createInnerNativeTurnSource } from "../src/inner-native-turn-source.mjs";
import { createInnerProxyCoordinatorImplementation } from "../src/inner-proxy-coordinator.mjs";

const turn = (phase, status = "completed") => ({ method: `turn/${phase}`, params: {
  threadId: "thread-a", turn: { id: "turn-a", ...(phase === "completed" ? { status } : {}) },
} });

function fixture() {
  const calls = [];
  const coordinator = { observeNativeMessage(sourceId, message) { calls.push({ sourceId, message }); }, status: () => ({ nativeHealthy: true }) };
  return { calls, coordinator, source: createInnerNativeTurnSource({ sourceId: "native-a", coordinator }) };
}

test("duplicate subscribers relay each actual turn transition once", async () => {
  const { calls, source } = fixture();
  await source.observe(turn("started"));
  await source.observe(turn("started"));
  await source.observe(turn("completed"));
  await source.observe(turn("completed"));
  await source.observe(turn("started"));
  assert.equal(calls.length, 2);
  assert.equal(source.status().duplicates, 3);
  assert.equal(source.status().healthy, true);
});

test("conflicting terminal data stops subsequent native acceptance", async () => {
  const { source } = fixture();
  await source.observe(turn("completed"));
  assert.throws(() => source.observe(turn("completed", "failed")), /CONFLICTING_DUPLICATE/);
  assert.equal(source.status().healthy, false);
  assert.throws(() => source.observe(turn("started")), /UNAVAILABLE/);
});

test("RPC messages are excluded and malformed notifications leave an explicit failure", async () => {
  const { calls, source } = fixture();
  await source.observe({ ...turn("started"), id: 1 });
  assert.equal(calls.length, 0);
  assert.throws(() => source.observe({ method: "turn/started", params: {} }), /INVALID_EVENT/);
  assert.equal(source.status().failureCode, "NATIVE_SOURCE_INVALID_EVENT");
});

test("failed coordinator relay keeps the native source unavailable", async () => {
  const { source, coordinator } = fixture();
  coordinator.status = () => ({ nativeHealthy: false });
  await assert.rejects(source.observe(turn("started")), /RELAY_FAILED/);
  assert.equal(source.status().healthy, false);
});

const notification = (threadId, turnId, phase, status = "completed") => ({ method: `turn/${phase}`, params: {
  threadId, turn: { id: turnId, ...(phase === "completed" ? { status } : {}) },
} });

function admissionFixture(maximumRemembered = 2) {
  const worker = { workerId: "synthetic", activeHttp: 0, nativeSequence: 0, threadHistory: new Set(),
    releasedThreadHistory: new Set(), child: { pid: 99999999, connected: true, exitCode: null, signalCode: null },
    ready: { instanceToken: "synthetic", sourceHashes: { core: "synthetic", helper: "synthetic" }, status: { port: 0 } } };
  const state = { options: {}, nativeSourceId: "native-a", workers: new Map([[worker.workerId, worker]]), reclaimedWorkers: [],
    threads: new Map(), terminalThreads: new Map(), migrations: new Map(), pending: new Map(), adoptions: new Map(), requests: new Map(),
    maxThreads: 2, defaultWorker: worker, nativeSequence: 0, httpSequence: 0, generation: 0, relay: Promise.resolve(),
    nativeHealthy: true, transactionActive: false, workerMaintenance: false, server: { listening: false }, onEvent: () => {} };
  state.dispatch = (method, ...args) => state.implementation[method](...args);
  state.bindDispatch = (method, ...bound) => (...args) => state.dispatch(method, ...bound, ...args);
  state.implementation = { ...createInnerProxyCoordinatorImplementation(state),
    relayNative: async (owner, event) => { owner.threadHistory.add(event.threadId); owner.nativeSequence = event.sequence; } };
  const coordinator = { observeNativeMessage: (sourceId, message) => state.dispatch("observeNativeMessage", sourceId, message),
    status: () => state.implementation.status() };
  return { state, coordinator, source: createInnerNativeTurnSource({ sourceId: "native-a", coordinator, maximumRemembered }) };
}

test("real capacity rejection preserves active turns and lets completion release a slot", async () => {
  const { state, source } = admissionFixture();
  await source.observe(notification("first", "first-turn", "started"));
  await source.observe(notification("second", "second-turn", "started"));
  assert.throws(() => source.observe(notification("overflow", "overflow-turn", "started")), /COORDINATOR_THREAD_LIMIT/u);
  assert.equal(source.status().healthy, true);
  assert.equal(state.threads.size, 2);
  assert.equal(state.nativeSequence, 2);
  assert.deepEqual(source.status().rejections, [{ sourceId: "native-a", threadId: "overflow", turnId: "overflow-turn",
    method: "turn/started", status: "active", code: "COORDINATOR_THREAD_LIMIT" }]);
  await source.observe(notification("first", "first-turn", "completed"));
  await source.observe(notification("overflow", "overflow-turn", "started"));
  assert.equal(state.threads.get("second").phase, "active");
  assert.equal(state.threads.get("overflow").phase, "active");
  assert.equal(source.status().delivered, 4);
});

test("evicted old completion and fresh orphan reject locally with bounded exact records", async () => {
  const { state, source } = admissionFixture();
  await source.observe(notification("thread", "old", "started"));
  await source.observe(notification("thread", "old", "completed"));
  await source.observe(notification("thread", "middle", "started"));
  await source.observe(notification("thread", "middle", "completed"));
  await source.observe(notification("thread", "current", "started"));
  assert.throws(() => source.observe(notification("thread", "old", "completed")), /NATIVE_SEQUENCE_INVALID/u);
  for (let index = 0; index < 6; index += 1) {
    assert.throws(() => source.observe(notification(`orphan-${index}`, "lost", "completed")), /NATIVE_SEQUENCE_INVALID/u);
  }
  assert.equal(source.status().healthy, true);
  assert.equal(source.status().rejected, 7);
  assert.equal(source.status().rejections.length, 2);
  assert.equal(source.status().rejections[1].threadId, "orphan-5");
  assert.equal(source.status().remembered, 2);
  assert.equal(state.threads.get("thread").turnId, "current");
  assert.equal(state.threads.get("thread").phase, "active");
  assert.equal(state.nativeSequence, 5);
  await source.observe(notification("thread", "current", "completed"));
  await source.observe(notification("fresh", "fresh-turn", "started"));
});

test("async admission-looking rejection stays fatal and cannot be handed off", async () => {
  const { source, coordinator, calls } = fixture();
  coordinator.observeNativeMessage = () => Promise.reject(Object.assign(new Error("unknown outcome"), { code: "COORDINATOR_THREAD_LIMIT" }));
  await assert.rejects(source.observe(turn("started")), /unknown outcome/u);
  assert.equal(source.status().healthy, false);
  assert.equal(source.status().rejected, 0);
  assert.equal(source.status().remembered, 1);
  assert.throws(() => createInnerNativeTurnSource({ sourceId: "native-a", coordinator, previousSource: source }), /UNAVAILABLE/u);
  assert.equal(calls.length, 0);
});

test("healthy handoff retains duplicate window and in-flight unknown failure", async () => {
  const { source, coordinator, calls } = fixture();
  await source.observe(turn("started"));
  const replacement = createInnerNativeTurnSource({ sourceId: "native-a", coordinator, previousSource: source });
  await replacement.observe(turn("started"));
  assert.equal(calls.length, 1);
  assert.equal(replacement.status().duplicates, 1);
  let rejectRelay;
  coordinator.observeNativeMessage = () => new Promise((_resolve, reject) => { rejectRelay = reject; });
  const inflight = replacement.observe(turn("completed"));
  const next = createInnerNativeTurnSource({ sourceId: "native-a", coordinator, previousSource: replacement });
  const repeated = next.observe(turn("completed"));
  rejectRelay(Object.assign(new Error("unknown IPC outcome"), { code: "COORDINATOR_IPC_TIMEOUT" }));
  await assert.rejects(inflight, /unknown IPC outcome/u);
  await assert.rejects(repeated, /unknown IPC outcome/u);
  assert.equal(next.status().healthy, false);
  assert.equal(next.status().remembered, 2);
});
