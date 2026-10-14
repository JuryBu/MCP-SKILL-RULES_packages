import assert from "node:assert/strict";
import test from "node:test";
import { createCodexRequestMetadata } from "../src/codex-request-metadata.mjs";

const MAX_SNAPSHOT_BYTES = 16 * 1024;

function fixture(options = {}) {
  let current = 0;
  const collector = createCodexRequestMetadata({ enabled: true, now: () => current, ...options });
  const observe = (parsed, overrides = {}) => collector.observe({
    parsed, byteLength: 100, direction: "downstream", generation: "opaque_A", ...overrides,
  });
  const request = (id, overrides = {}) => observe({ id, method: "thread/read" }, overrides);
  const response = (id, overrides = {}) => observe({ id, result: null }, { direction: "upstream", ...overrides });
  return { collector, observe, request, response, setTime: value => { current = value; } };
}

function shape(value) {
  if (value === null || typeof value !== "object") return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
}

test("disabled by default, disabled observations never touch input or clock", () => {
  const collector = createCodexRequestMetadata({ now: () => { throw new Error("clock accessed"); } });
  const input = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("input accessed"); } });
  const initial = collector.snapshot();
  for (let index = 0; index < 10000; index += 1) collector.observe(input);
  collector.closeConnection(input);
  collector.sweep();
  assert.deepEqual(collector.snapshot(), initial);
  assert.equal(initial.enabled, false);
  assert.equal(initial.storage.pendingSlots, 0);
  assert.equal(initial.counts.failures, 0);
  for (const enabled of [1, "true", null, undefined]) {
    assert.equal(createCodexRequestMetadata({ enabled }).snapshot().enabled, false);
  }
});

test("existing parsed objects produce byte, latency, concurrency and -32003 buckets", () => {
  const state = fixture();
  const request = Object.freeze({ id: 1, method: "thread/read", params: { threadId: "synthetic-private-thread" } });
  const failure = Object.freeze({ id: 1, error: { code: -32003, message: "synthetic-private-error" } });
  state.observe(request, { byteLength: 1024 });
  state.request(2);
  state.setTime(75);
  state.observe(failure, { direction: "upstream", byteLength: 512 });
  state.response(2);
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.counts.requests, 2);
  assert.equal(snapshot.counts.completed, 2);
  assert.equal(snapshot.counts.trackedCurrent, 0);
  assert.equal(snapshot.counts.trackedPeak, 2);
  assert.equal(snapshot.counts.latencyTotalMs, 150);
  assert.equal(snapshot.latencyBuckets.le_100ms, 2);
  assert.equal(snapshot.results["error_-32003"], 1);
  assert.equal(snapshot.methods["thread/read"].results["error_-32003"], 1);
  assert.equal(snapshot.methods["thread/read"].results.success, 1);
  assert.equal(snapshot.frames.downstream.bytes, 1124);
  assert.equal(snapshot.frames.upstream.bytes, 612);
  assert.equal(request.id, 1);
  assert.equal(failure.error.code, -32003);
});

test("history pagination and permission failures retain fixed method byte attribution", () => {
  const state = fixture();
  state.observe({ id: "page", method: "thread/items/list" }, { byteLength: 128 });
  state.observe({ id: "read", method: "thread/read" }, { byteLength: 96 });
  state.response("page", { byteLength: 524288 });
  state.observe({ id: "read", error: { code: -32003 } }, { direction: "upstream", byteLength: 512 });
  let snapshot = state.collector.snapshot();
  const pagination = snapshot.methods["thread/items/list"];
  assert.equal(pagination.requests, 1);
  assert.equal(pagination.requestBytes, 128);
  assert.equal(pagination.requestSizeBuckets.le_1KiB, 1);
  assert.equal(pagination.responseBytes, 524288);
  assert.equal(pagination.responseSizeBuckets.le_4MiB, 1);
  assert.equal(pagination.responseBytesByResult.success, 524288);
  assert.equal(snapshot.methods["thread/read"].responseBytesByResult["error_-32003"], 512);
  assert.equal(snapshot.methods.other.requests, 0);
  pagination.requestSizeBuckets.le_1KiB = 99;
  pagination.responseSizeBuckets.le_4MiB = 99;
  pagination.responseBytesByResult.success = 99;
  snapshot = state.collector.snapshot();
  assert.equal(snapshot.methods["thread/items/list"].requestSizeBuckets.le_1KiB, 1);
  assert.equal(snapshot.methods["thread/items/list"].responseSizeBuckets.le_4MiB, 1);
  assert.equal(snapshot.methods["thread/items/list"].responseBytesByResult.success, 524288);
});

test("missing frame sizes and unreliable response associations remain unknown", () => {
  const state = fixture({ maxPending: 1, ttlMs: 10 });
  state.observe({ id: "lost", method: "thread/items/list" }, { byteLength: undefined });
  state.request("kept", { byteLength: 12 });
  state.response("lost", { byteLength: 1024 });
  state.setTime(10);
  state.response("kept", { byteLength: 2048 });
  state.request("duplicate", { byteLength: 20 });
  state.request("duplicate", { byteLength: 21 });
  state.response("duplicate", { byteLength: 4096 });
  state.response("invalid", { generation: "bad tag", byteLength: undefined });
  state.response("orphan", { byteLength: 8192 });
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.methods["thread/items/list"].requestBytes, 0);
  assert.equal(snapshot.methods["thread/items/list"].requestSizeBuckets.unknown, 1);
  assert.equal(snapshot.methods["thread/items/list"].responseBytes, 0);
  assert.equal(snapshot.methods["thread/read"].responseBytes, 0);
  assert.equal(snapshot.methods.unknown.responseBytes, 15360);
  assert.equal(snapshot.methods.unknown.responseBytesByResult.success, 15360);
  assert.equal(snapshot.methods.unknown.responseSizeBuckets.unknown, 1);
  assert.equal(snapshot.counts.unmatchedResponses, 5);
  assert.equal(snapshot.counts.completed, 0);
});

test("duplicate IDs stay ambiguous until expiry, including further duplicates and responses", () => {
  const state = fixture({ ttlMs: 10 });
  state.request("duplicate-id");
  state.request("duplicate-id");
  state.request("duplicate-id");
  state.response("duplicate-id");
  state.response("duplicate-id");
  let snapshot = state.collector.snapshot();
  assert.equal(snapshot.counts.duplicates, 2);
  assert.equal(snapshot.unknown.duplicate, 3);
  assert.equal(snapshot.counts.completed, 0);
  assert.equal(snapshot.counts.unmatchedResponses, 2);
  assert.equal(snapshot.counts.trackedCurrent, 0);
  assert.equal(snapshot.storage.pendingSlots, 1);
  state.setTime(10);
  snapshot = state.collector.snapshot();
  assert.equal(snapshot.storage.pendingSlots, 0);
  assert.equal(snapshot.unknown.ttl, 0);
  state.request("duplicate-id");
  state.response("duplicate-id");
  assert.equal(state.collector.snapshot().counts.completed, 1);
});

test("same ID in distinct connection generations cannot complete another generation", () => {
  const state = fixture();
  state.request(1, { generation: "opaque_A" });
  state.request(1, { generation: "opaque_B" });
  state.response(1, { generation: "opaque_C" });
  assert.equal(state.collector.snapshot().counts.trackedCurrent, 2);
  state.response(1, { generation: "opaque_A" });
  assert.equal(state.collector.snapshot().counts.trackedCurrent, 1);
  state.response(1, { generation: "opaque_B" });
  assert.equal(state.collector.snapshot().counts.completed, 2);
  assert.equal(state.collector.snapshot().counts.unmatchedResponses, 1);
});

test("number/string IDs and bidirectional requests have separate correlations", () => {
  const state = fixture();
  state.request(1);
  state.request("1");
  state.request(1, { direction: "upstream" });
  state.response(1);
  state.response("1");
  assert.equal(state.collector.snapshot().counts.trackedCurrent, 1);
  state.response(1, { direction: "downstream" });
  assert.equal(state.collector.snapshot().counts.completed, 3);
  assert.equal(state.collector.snapshot().counts.duplicates, 0);
});

test("notifications never enter request storage; other methods and error codes stay in finite buckets", () => {
  const state = fixture();
  state.observe({ method: "turn/started", params: { secret: "synthetic-private-note" } });
  state.observe({ method: "arbitrary-method" });
  for (const [index, code] of [-32600, -32601, -32602, -32603, -32700, -32099, "private-code"].entries()) {
    state.request(index);
    state.observe({ id: index, error: { code } }, { direction: "upstream" });
  }
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.counts.notifications, 2);
  assert.equal(snapshot.methods["turn/started"].notifications, 1);
  assert.equal(snapshot.methods.other.notifications, 1);
  assert.equal(snapshot.storage.pendingSlots, 0);
  assert.equal(snapshot.results.standard_error, 5);
  assert.equal(snapshot.results.other_error, 1);
  assert.equal(snapshot.results.unknown, 1);
});

test("unknown and oversized frames only use supplied byte counts, with saturating totals", () => {
  const state = fixture();
  for (const parsed of [null, undefined, [], "raw-frame", 3, {}, { id: 1 }, { id: 2, result: 1, error: {} }]) {
    state.observe(parsed, { byteLength: 5 * 1024 * 1024 });
  }
  state.observe({ method: "private-method", params: "x".repeat(8 * 1024 * 1024) }, { byteLength: 8 * 1024 * 1024 });
  state.observe(null, { byteLength: Number.MAX_SAFE_INTEGER });
  state.observe(null, { byteLength: Number.MAX_SAFE_INTEGER });
  for (const byteLength of [-1, NaN, Infinity, 1.5, "123"]) state.observe(null, { byteLength });
  state.observe(null, { direction: "invalid" });
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.counts.unknownFrames, 15);
  assert.equal(snapshot.counts.notifications, 1);
  assert.equal(snapshot.frames.downstream.sizeBuckets.gt_4MiB, 11);
  assert.equal(snapshot.frames.downstream.bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.counts.invalidByteLengths, 5);
  assert.equal(snapshot.counts.invalidDirections, 1);
  assert.equal(snapshot.storage.pendingSlots, 0);
});

test("TTL eviction at boundary and backward clocks only discard collector associations", () => {
  const state = fixture({ ttlMs: 10 });
  state.request(1);
  state.setTime(9);
  assert.equal(state.collector.snapshot().counts.trackedCurrent, 1);
  state.setTime(10);
  state.collector.sweep();
  state.response(1);
  state.request(2);
  state.setTime(8);
  state.response(2);
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.unknown.ttl, 1);
  assert.equal(snapshot.counts.unmatchedResponses, 1);
  assert.equal(snapshot.counts.completed, 1);
  assert.equal(snapshot.counts.latencyMaxMs, 0);
  assert.equal(snapshot.storage.generationSlots, 1);
});

test("missing original byte lengths are explicitly unknown without serializing or copying results", () => {
  const state = fixture();
  let bodyReads = 0;
  const body = {};
  Object.defineProperty(body, "toJSON", { get() { bodyReads += 1; throw new Error("body serialized"); } });
  Object.defineProperty(body, "history", { get() { bodyReads += 1; throw new Error("history copied"); } });
  for (const byteLength of [undefined, null, NaN]) {
    state.observe({ id: 1, result: body }, { direction: "upstream", byteLength });
  }
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.frames.upstream.bytes, 0);
  assert.equal(snapshot.frames.upstream.sizeBuckets.unknown, 3);
  assert.equal(snapshot.counts.invalidByteLengths, 1);
  assert.equal(snapshot.counts.responses, 3);
  assert.equal(bodyReads, 0);
});

test("capacity eviction and generation eviction produce unknown outcomes without hooks", () => {
  const state = fixture({ maxPending: 2, maxGenerations: 2 });
  state.request(1);
  state.request(2);
  state.request(3);
  state.response(1);
  let snapshot = state.collector.snapshot();
  assert.equal(snapshot.storage.pendingSlots, 2);
  assert.equal(snapshot.counts.trackedPeak, 2);
  assert.equal(snapshot.unknown.capacity, 1);
  state.request(4, { generation: "opaque_B" });
  state.request(5, { generation: "opaque_C" });
  state.response(3);
  snapshot = state.collector.snapshot();
  assert.equal(snapshot.storage.generationSlots, 2);
  assert.equal(snapshot.counts.generationEvictions, 1);
  assert.equal(snapshot.unknown.generationCapacity, 1);
  assert.equal(snapshot.counts.unmatchedResponses, 2);
});

test("connection close and collector close are idempotent and leave transport inputs intact", () => {
  const state = fixture();
  const forbidden = () => { throw new Error("transport hook must never be used"); };
  state.observe({ id: 1, method: "thread/read" }, { cancel: forbidden, resend: forbidden, send: forbidden });
  state.request(2, { generation: "opaque_B" });
  state.collector.closeConnection("opaque_A");
  state.collector.closeConnection("opaque_A");
  state.response(1);
  state.request(3, { generation: "opaque_B" });
  state.collector.close();
  state.collector.close();
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.unknown.connectionClosed, 1);
  assert.equal(snapshot.unknown.collectorClosed, 2);
  assert.equal(snapshot.counts.connectionsClosed, 1);
  assert.equal(snapshot.storage.pendingSlots, 0);
  assert.equal(snapshot.storage.generationSlots, 0);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.closed, true);
  state.request(4);
  assert.deepEqual(state.collector.snapshot(), snapshot);
});

test("raw body, IDs, generation labels and error text are absent from bounded snapshots", () => {
  const state = fixture();
  const privateId = "synthetic-private-request";
  const generation = "synthetic_private_generation";
  state.observe({ id: privateId, method: "synthetic-private-method", params: {
    threadId: "synthetic-private-thread", authorization: "synthetic-private-token", body: "synthetic-private-body",
  } }, { generation });
  let snapshot = state.collector.snapshot();
  assert.equal(JSON.stringify(snapshot).includes("synthetic"), false);
  const initialShape = shape(snapshot);
  snapshot.counts.requests = 0;
  snapshot.methods.other.results.success = 123;
  snapshot.frames.downstream.sizeBuckets.le_1KiB = 123;
  state.observe({ id: privateId, error: { code: -32003, message: "synthetic-private-error" } }, {
    generation, direction: "upstream",
  });
  snapshot = state.collector.snapshot();
  assert.deepEqual(shape(snapshot), initialShape);
  assert.equal(snapshot.counts.requests, 1);
  assert.equal(snapshot.methods.other.results.success, 0);
  assert.equal(snapshot.frames.downstream.sizeBuckets.le_1KiB, 1);
  assert.equal(JSON.stringify(snapshot).includes("synthetic"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < MAX_SNAPSHOT_BYTES);
  const maximizeNumbers = value => {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number") value[key] = Number.MAX_SAFE_INTEGER;
      else if (item !== null && typeof item === "object") maximizeNumbers(item);
    }
  };
  maximizeNumbers(snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < MAX_SNAPSHOT_BYTES);
});

test("unsupported IDs and generation labels do not retain arbitrarily sized values", () => {
  const state = fixture();
  for (const id of [null, {}, [], Infinity, 0.5, "", "x".repeat(257), "界".repeat(100)]) state.request(id);
  for (const generation of [null, 1, "", "a b", "x".repeat(97)]) state.request(1, { generation });
  state.response(1, { generation: "bad tag" });
  const snapshot = state.collector.snapshot();
  assert.equal(snapshot.unknown.unsupportedId, 8);
  assert.equal(snapshot.unknown.invalidGeneration, 5);
  assert.equal(snapshot.counts.invalidGenerations, 6);
  assert.equal(snapshot.storage.pendingSlots, 0);
  assert.equal(snapshot.storage.generationSlots, 0);
});

test("accessors are never invoked and counting failures cannot block forwarding", () => {
  const state = fixture();
  let accessorReads = 0;
  const parsed = { method: "thread/read", id: 1 };
  Object.defineProperty(parsed, "params", { get() { accessorReads += 1; throw new Error("body touched"); } });
  state.observe(parsed);
  const getterOnly = {};
  Object.defineProperty(getterOnly, "method", { get() { accessorReads += 1; throw new Error("method touched"); } });
  state.observe(getterOnly);
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("counter failure"); } });
  const forwarded = [];
  for (const input of [hostile, { direction: "downstream", generation: "opaque_A", parsed: hostile, byteLength: 9 }]) {
    assert.doesNotThrow(() => { state.collector.observe(input); forwarded.push(input); });
  }
  assert.equal(accessorReads, 0);
  assert.equal(forwarded.length, 2);
  assert.equal(state.collector.snapshot().counts.failures, 2);
  const brokenClock = fixture({ now: () => { throw new Error("broken clock"); } });
  assert.doesNotThrow(() => brokenClock.request(1));
  assert.doesNotThrow(() => brokenClock.collector.snapshot());
  assert.equal(brokenClock.collector.snapshot().counts.failures, 3);
  assert.doesNotThrow(() => brokenClock.collector.close());
});

test("configuration uses hard caps with unchanged snapshot structure", () => {
  const capped = fixture({ maxPending: Number.MAX_SAFE_INTEGER, maxGenerations: Number.MAX_SAFE_INTEGER, ttlMs: Number.MAX_SAFE_INTEGER });
  const defaults = fixture({ maxPending: 0, maxGenerations: NaN, ttlMs: -1 });
  assert.deepEqual(capped.collector.snapshot().limits, {
    maxPending: 4096, maxGenerations: 64, ttlMs: 600000, maxIdBytes: 256, maxGenerationChars: 96,
  });
  assert.equal(defaults.collector.snapshot().limits.maxPending, 256);
  assert.deepEqual(shape(capped.collector.snapshot()), shape(defaults.collector.snapshot()));
});

test("actual hard limits hold at 4096 pending entries and 64 generations", () => {
  const state = fixture({ maxPending: Number.MAX_SAFE_INTEGER, maxGenerations: Number.MAX_SAFE_INTEGER });
  for (let index = 0; index < 5000; index += 1) state.request(index, { generation: `opaque_${index % 64}` });
  let snapshot = state.collector.snapshot();
  assert.equal(snapshot.storage.pendingSlots, 4096);
  assert.equal(snapshot.storage.generationSlots, 64);
  assert.equal(snapshot.counts.trackedPeak, 4096);
  assert.equal(snapshot.unknown.capacity, 904);
  state.request(5000, { generation: "opaque_new" });
  snapshot = state.collector.snapshot();
  assert.equal(snapshot.storage.generationSlots, 64);
  assert.ok(snapshot.storage.pendingSlots <= 4096);
  assert.equal(snapshot.counts.generationEvictions, 1);
  assert.equal(snapshot.unknown.generationCapacity, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < MAX_SNAPSHOT_BYTES);
  state.collector.close();
});

test("sustained churn at tiny caps has bounded retained heap and fixed snapshot size", context => {
  if (typeof global.gc !== "function") {
    context.skip("Run node --expose-gc --test test/codex-request-metadata.test.mjs for heap evidence");
    return;
  }
  const state = fixture({ maxPending: 16, maxGenerations: 4, ttlMs: 100 });
  const initialShape = shape(state.collector.snapshot());
  let peakSlots = 0;
  const runBatch = () => {
    for (let index = 0; index < 20000; index += 1) {
      const generation = `opaque_${index % (index % 1000 < 500 ? 4 : 8)}`;
      state.request(index, { generation });
      if (index % 3 === 0) state.response(index, { generation });
      if (index % 100 === 0) {
        const snapshot = state.collector.snapshot();
        peakSlots = Math.max(peakSlots, snapshot.storage.pendingSlots);
        assert.ok(snapshot.storage.pendingSlots <= 16);
        assert.ok(snapshot.storage.generationSlots <= 4);
        assert.deepEqual(shape(snapshot), initialShape);
        assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < MAX_SNAPSHOT_BYTES);
      }
    }
    global.gc();
    return process.memoryUsage().heapUsed;
  };
  const warmHeap = runBatch();
  const middleHeap = runBatch();
  const finalHeap = runBatch();
  const delta = finalHeap - warmHeap;
  const snapshot = state.collector.snapshot();
  assert.ok(delta < 2 * 1024 * 1024, `Retained heap grew by ${delta} bytes after warm-up`);
  assert.equal(snapshot.counts.requests, 60000);
  assert.equal(peakSlots, 16);
  assert.ok(snapshot.storage.pendingSlots <= 16);
  assert.ok(snapshot.storage.generationSlots <= 4);
  context.diagnostic(`heapUsed bytes warm=${warmHeap} middle=${middleHeap} final=${finalHeap} delta=${delta}; pending=${snapshot.storage.pendingSlots}/16 peakSlots=${peakSlots} generations=${snapshot.storage.generationSlots}/4 snapshotBytes=${Buffer.byteLength(JSON.stringify(snapshot))}`);
  state.collector.close();
});
