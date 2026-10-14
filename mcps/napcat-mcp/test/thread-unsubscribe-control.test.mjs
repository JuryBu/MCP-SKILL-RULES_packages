import assert from "node:assert/strict";
import test from "node:test";
import { classifyUnsubscribeError, createThreadUnsubscribeControl } from "../src/thread-unsubscribe-control.mjs";

function fixture(overrides = {}) {
  let clock = 1000;
  const connection = {};
  const binding = { ownerId: "fixture-owner", ownerConnectionId: "original-connection", backendGeneration: 1, subscriptionGeneration: 1, threadId: "fixture-thread" };
  const state = { ...binding, connection, stateRevision: 1, observedAt: clock, initialized: true, upstreamOpen: true, originalOwner: true,
    subscribed: true, loaded: true, reconnecting: false, currentView: false, activeTurn: false, pendingCount: 0, activeWakeCount: 0,
    followCount: 0, activeRequestCount: 0, injectedCount: 0, desktopPendingCount: 0, status: "idle", ephemeral: false, ...overrides };
  const calls = [];
  const history = [];
  const journal = new Map();
  const actions = {
    inspect: async () => {},
    inject: async () => ({ status: "unsubscribed" }),
    beforeWrite: () => {},
  };
  const lease = {
    connection,
    snapshot: () => ({ ...state }),
    async inspect(input) {
      calls.push({ method: "thread/read", input });
      const result = await actions.inspect();
      return result ?? { thread: { id: binding.threadId, status: { type: "idle" }, ephemeral: false } };
    },
    injectRequest(method, params, options) {
      actions.beforeWrite();
      options.beforeWrite();
      calls.push({ method, params, options });
      return actions.inject();
    },
  };
  const options = { now: () => clock, withOwnerLease: async (requested, operation) => operation(lease),
    journal: { get: key => journal.get(key) ?? null, put(key, value) { journal.set(key, value); history.push(value); return true; } } };
  const control = createThreadUnsubscribeControl(options);
  return { control, options, binding, state, calls, history, journal, actions, lease, connection, tick(value) { clock += value; },
    async prepare() { return (await control.prepare(binding)).receipt; },
    execute(receipt) { return control.execute({ ...binding, receiptId: receipt.receiptId }); } };
}

test("prepared original connection executes once with mutating RPC and persisted outcome", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  assert.equal(state.calls.filter(call => call.method === "thread/unsubscribe").length, 0);
  const outcome = await state.execute(receipt);
  assert.equal(outcome.state, "VERIFIED");
  assert.deepEqual(outcome.result, { status: "unsubscribed" });
  assert.deepEqual(state.history.map(entry => entry.state), ["EXECUTING", "VERIFIED"]);
  const call = state.calls.find(entry => entry.method === "thread/unsubscribe");
  assert.deepEqual(call.params, { threadId: state.binding.threadId });
  assert.equal(call.options.mutating, true);
  assert.equal(call.options.expectedConnection, state.connection);
  await assert.rejects(() => state.execute(receipt), { code: "UNSUBSCRIBE_PREPARATION_REQUIRED" });
});

for (const [field, unsafe] of Object.entries({ status: "active", initialized: false, upstreamOpen: false, originalOwner: false, subscribed: false,
  loaded: false, reconnecting: true, currentView: true, activeTurn: true, pendingCount: 1, activeWakeCount: 1, followCount: 1,
  activeRequestCount: 1, injectedCount: 1, desktopPendingCount: 1, ephemeral: true })) {
  test(`prepare refuses ${field} unsafe and unknown`, async () => {
    for (const value of [unsafe, undefined, null]) {
      const state = fixture({ [field]: value });
      await assert.rejects(() => state.prepare());
      assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
    }
  });
  test(`execute rechecks ${field} after preparation`, async () => {
    const state = fixture();
    const receipt = await state.prepare();
    state.state[field] = unsafe;
    await assert.rejects(() => state.execute(receipt));
    assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
  });
}

for (const field of ["ownerId", "ownerConnectionId", "backendGeneration", "subscriptionGeneration", "threadId", "stateRevision"]) {
  test(`rejects ${field} drift even after activity returns to idle`, async () => {
    const state = fixture();
    const receipt = await state.prepare();
    state.state[field] = typeof state.state[field] === "number" ? state.state[field] + 1 : "changed";
    await assert.rejects(() => state.execute(receipt));
    assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
  });
}

test("a new connection copying identity strings cannot consume an old receipt", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  state.lease.connection = {};
  state.state.connection = state.lease.connection;
  await assert.rejects(() => state.execute(receipt), { code: "UNSUBSCRIBE_ORIGINAL_CONNECTION_REQUIRED" });
});

test("wake, viewing, request and reconnect arriving during inspection prevent write", async () => {
  for (const field of ["activeWakeCount", "currentView", "activeRequestCount", "reconnecting"]) {
    const state = fixture();
    const receipt = await state.prepare();
    state.actions.inspect = async () => { state.state[field] = typeof state.state[field] === "number" ? 1 : true; };
    await assert.rejects(() => state.execute(receipt));
    assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
  }
});

test("active or wake activity ending before execute still invalidates the old preparation", async () => {
  for (const field of ["status", "activeWakeCount", "reconnecting"]) {
    const state = fixture();
    const receipt = await state.prepare();
    const previous = state.state[field];
    state.state[field] = field === "status" ? "active" : field === "activeWakeCount" ? 1 : true;
    state.state.stateRevision += 1;
    state.state[field] = previous;
    state.state.stateRevision += 1;
    await assert.rejects(() => state.execute(receipt), { code: "UNSUBSCRIBE_PREPARATION_CHANGED" });
    assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
  }
});

test("view, follower and local owner becoming unknown after preparation prevent unsubscribe", async () => {
  for (const field of ["currentView", "followCount", "originalOwner"]) {
    const state = fixture();
    const receipt = await state.prepare();
    state.state[field] = undefined;
    await assert.rejects(() => state.execute(receipt));
    assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
  }
});

test("last synchronous beforeWrite gate catches generation change after journal persistence", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  state.actions.beforeWrite = () => { state.state.backendGeneration += 1; };
  const outcome = await state.execute(receipt);
  assert.equal(outcome.state, "NOT_WRITTEN");
  assert.equal(outcome.retryAllowed, false);
  assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
});

test("a host omitting the write guard produces UNKNOWN and blocks future preparation", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  state.lease.injectRequest = () => Promise.resolve({ status: "unsubscribed" });
  assert.equal((await state.execute(receipt)).state, "UNKNOWN");
  await assert.rejects(() => state.prepare(), { code: "UNSUBSCRIBE_OUTCOME_UNRESOLVED" });
});

for (const code of ["APP_SERVER_TIMEOUT", "CONNECTION_CLOSED", "APP_SERVER_WRITE_FAILED"]) {
  test(`${code} without explicit not-written proof remains UNKNOWN across controller replacement`, async () => {
    const state = fixture();
    const receipt = await state.prepare();
    state.actions.inject = async () => { throw Object.assign(new Error("fixture failure"), { code, outcomeUnknown: true, written: true }); };
    const outcome = await state.execute(receipt);
    assert.equal(outcome.state, "UNKNOWN");
    assert.equal(outcome.retryAllowed, false);
    state.state.backendGeneration += 1;
    const replacement = createThreadUnsubscribeControl(state.options);
    await assert.rejects(() => replacement.prepare({ ...state.binding, backendGeneration: 2 }), { code: "UNSUBSCRIBE_OUTCOME_UNRESOLVED" });
    assert.equal(state.calls.filter(call => call.method === "thread/unsubscribe").length, 1);
  });
}

test("false outcomeUnknown alone cannot turn a timeout into safe retry", async () => {
  assert.equal(classifyUnsubscribeError({ code: -1, message: "transport", outcomeUnknown: true }).state, "UNKNOWN");
  assert.equal(classifyUnsubscribeError({ code: "APP_SERVER_TIMEOUT", outcomeUnknown: false }).state, "UNKNOWN");
  assert.equal(classifyUnsubscribeError({ code: "APP_SERVER_TIMEOUT", outcomeUnknown: false, written: true }).state, "UNKNOWN");
  assert.equal(classifyUnsubscribeError({ code: "APP_SERVER_TIMEOUT", outcomeUnknown: false, written: false }).state, "NOT_WRITTEN");
  const state = fixture();
  const receipt = await state.prepare();
  state.actions.inject = async () => { throw Object.assign(new Error("fixture before write"), { code: "APP_SERVER_TIMEOUT", written: false, outcomeUnknown: false }); };
  assert.equal((await state.execute(receipt)).state, "NOT_WRITTEN");
  await assert.rejects(() => state.execute(receipt), { code: "UNSUBSCRIBE_PREPARATION_REQUIRED" });
});

test("official inspection identity and status are required independently of local idle", async () => {
  for (const thread of [{}, { id: "other", status: { type: "idle" }, ephemeral: false },
    { id: "fixture-thread", status: { type: "active" }, ephemeral: false },
    { id: "fixture-thread", status: { type: "idle" } },
    { id: "fixture-thread", status: { type: "idle" }, ephemeral: false, turns: [{ status: "inProgress" }] }]) {
    const state = fixture();
    state.actions.inspect = async () => ({ thread });
    await assert.rejects(() => state.prepare(), { code: "UNSUBSCRIBE_INSPECTION_NOT_SAFE" });
    assert.equal(state.calls.some(call => call.method === "thread/unsubscribe"), false);
  }
});

test("current proxy details.rpcError preserves original unloaded category", () => {
  for (const code of [-32600, -32602]) {
    const rpcError = { code, message: "thread not loaded: fixture-thread" };
    const classified = classifyUnsubscribeError({ code: "APP_SERVER_RPC_ERROR", details: { method: "thread/read", rpcError } });
    assert.deepEqual(classified.rpcError, rpcError);
    assert.equal(classified.category, "thread_not_loaded");
  }
});

for (const code of [-32600, -32602]) {
  test(`thread not loaded preserves original RPC ${code} during inspect and unsubscribe`, async () => {
    const rpcError = { code, message: "thread not loaded: fixture-thread", data: { source: "fixture" } };
    const error = Object.assign(new Error(rpcError.message), { code: "APP_SERVER_RPC_ERROR", rpcError });
    const state = fixture();
    state.actions.inspect = async () => { throw error; };
    await assert.rejects(() => state.prepare(), candidate => candidate === error && candidate.rpcError.code === code);
    state.actions.inspect = async () => {};
    const receipt = await state.prepare();
    state.actions.inject = async () => { throw error; };
    const outcome = await state.execute(receipt);
    assert.equal(outcome.state, "RPC_ERROR");
    assert.equal(outcome.category, "thread_not_loaded");
    assert.deepEqual(outcome.rpcError, rpcError);
    assert.equal(outcome.retryAllowed, false);
    await state.prepare();
  });
}

test("official no-op statuses are returned intact without an unload claim", async () => {
  for (const status of ["notSubscribed", "notLoaded"]) {
    const state = fixture();
    const receipt = await state.prepare();
    state.actions.inject = async () => ({ status });
    const result = await state.execute(receipt);
    assert.deepEqual(result.result, { status });
    assert.equal(Object.hasOwn(result, "memoryReleased"), false);
  }
});

test("unknown result, pending attempt and journal uncertainty fail closed", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  state.actions.inject = async () => ({});
  assert.equal((await state.execute(receipt)).state, "UNKNOWN");
  const replacement = createThreadUnsubscribeControl(state.options);
  await assert.rejects(() => replacement.prepare(state.binding), { code: "UNSUBSCRIBE_OUTCOME_UNRESOLVED" });
  for (const previous of [undefined, { state: "EXECUTING", attemptId: "interrupted" }]) {
    const another = fixture();
    another.options.journal.get = () => previous;
    await assert.rejects(() => createThreadUnsubscribeControl(another.options).prepare(another.binding));
  }
});

test("expired, future or stale evidence and tampered receipts are refused", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  await assert.rejects(() => state.control.execute({ ...state.binding, threadId: "other", receiptId: receipt.receiptId }), { code: "UNSUBSCRIBE_RECEIPT_MISMATCH" });
  state.tick(30000);
  await assert.rejects(() => state.execute(receipt), { code: "UNSUBSCRIBE_PREPARATION_EXPIRED" });
  for (const observedAt of [undefined, 1001, -10000]) await assert.rejects(() => fixture({ observedAt }).prepare());
});

test("concurrent calls cannot write twice and journal failure prevents mutation", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  let release;
  state.actions.inspect = () => new Promise(resolve => { release = resolve; });
  const running = state.execute(receipt);
  await assert.rejects(() => state.prepare(), { code: "UNSUBSCRIBE_OPERATION_PENDING" });
  release();
  await running;
  const another = fixture();
  const prepared = await another.prepare();
  another.options.journal.put = () => false;
  await assert.rejects(() => another.execute(prepared), { code: "UNSUBSCRIBE_OUTCOME_NOT_PERSISTED" });
  assert.equal(another.calls.some(call => call.method === "thread/unsubscribe"), false);
});

test("failed final persistence keeps durable EXECUTING and blocks a fresh controller", async () => {
  const state = fixture();
  const receipt = await state.prepare();
  const originalPut = state.options.journal.put;
  state.options.journal.put = (key, outcome) => outcome.state === "EXECUTING" ? originalPut(key, outcome) : false;
  assert.equal((await state.execute(receipt)).state, "UNKNOWN");
  await assert.rejects(() => createThreadUnsubscribeControl(state.options).prepare(state.binding), { code: "UNSUBSCRIBE_OUTCOME_UNRESOLVED" });
});
