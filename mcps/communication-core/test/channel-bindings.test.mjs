import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChannelBindingManager } from "../src/channel-bindings.mjs";
import { CoreError, digest, identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

const IDENTITY = { machine_id: "test-machine", host: "codex", surface: "desktop", conversation_id: "caller" };
const PRINCIPAL = { id: "test-principal", identity: IDENTITY };
const OTHER = { id: "other-principal", identity: { ...IDENTITY, conversation_id: "other-caller" } };
const WINDOW = { channel: "qq", component: "napcat-isolated", window_type: "private", window_id: "test-private", binding_id: "authorized-window" };

function targetFor(principal, overrides = {}) {
  return {
    ...principal.identity,
    binding_id: `caller-target:${principal.identity.conversation_id}`,
    binding_generation: 1,
    adapter_id: "isolated-caller-adapter",
    capabilities: { next_model_boundary: true, when_idle: true },
    evidence: "isolated-test",
    ...overrides,
  };
}

function request(action = "bind", overrides = {}) {
  return { caller: { ...IDENTITY }, action, channel: "qq", window_type: "private", window_id: WINDOW.window_id, ...overrides };
}

function expectCoreError(callback, code = "invalid_input") {
  assert.throws(callback, error => error instanceof CoreError && error.code === code);
}

class MemoryStore {
  rows = new Map();
  calls = [];

  transaction(callback) {
    const snapshot = structuredClone(this.rows);
    try {
      return callback(this);
    } catch (error) {
      this.rows = snapshot;
      throw error;
    }
  }

  getChannelBinding(windowKey) {
    this.calls.push({ method: "get", windowKey });
    return structuredClone(this.rows.get(windowKey) ?? null);
  }

  putChannelBinding(record, { ownerKey, expectedGeneration, claimReleased = false }) {
    this.calls.push({ method: "put", record: structuredClone(record), ownerKey, expectedGeneration });
    const current = this.rows.get(record.window_key);
    if (current && current.owner_key !== ownerKey && !(claimReleased && current.deleted)) throw new CoreError("channel_binding_conflict", "owner conflict");
    if ((current?.generation ?? 0) !== expectedGeneration) throw new CoreError("binding_changed", "generation conflict");
    const saved = { ...structuredClone(record), generation: (current?.generation ?? 0) + 1, owner_key: ownerKey, deleted: false };
    this.rows.set(record.window_key, saved);
    return structuredClone(saved);
  }

  deleteChannelBinding(windowKey, { ownerKey, expectedGeneration }) {
    this.calls.push({ method: "remove", windowKey, ownerKey, expectedGeneration });
    const current = this.rows.get(windowKey);
    if (current && current.owner_key !== ownerKey) throw new CoreError("channel_binding_conflict", "owner conflict");
    if ((current?.generation ?? 0) !== expectedGeneration) throw new CoreError("binding_changed", "generation conflict");
    if (!current || current.deleted) return structuredClone(current ?? null);
    const saved = { ...current, generation: current.generation + 1, deleted: true };
    this.rows.set(windowKey, saved);
    return structuredClone(saved);
  }

  listChannelBindings({ ownerKey, limit = 100, afterKey = "" }) {
    this.calls.push({ method: "list", ownerKey, limit, afterKey });
    return structuredClone([...this.rows.values()].filter(record => record.owner_key === ownerKey && record.window_key > afterKey)
      .sort((left, right) => left.window_key < right.window_key ? -1 : left.window_key > right.window_key ? 1 : 0).slice(0, limit));
  }
}

function fixture(context, mode, windows = [WINDOW], resolveCallerTarget = targetFor) {
  const stores = [];
  let directory;
  let filePath;
  if (mode === "sqlite") {
    directory = mkdtempSync(join(tmpdir(), "communication-core-channel-manager-"));
    filePath = join(directory, "窗口对应 测试.sqlite");
  }
  context.after(() => {
    try {
      for (const store of stores) store.close?.();
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
  const open = () => {
    const store = mode === "sqlite" ? new MessageStore({ filePath }) : new MemoryStore();
    stores.push(store);
    return store;
  };
  const store = open();
  return { store, filePath, open, manager: new ChannelBindingManager({ store, windows, resolveCallerTarget }) };
}

for (const mode of ["memory", "sqlite"]) {
  test(`${mode}: binds the configured actual window to the caller's six-field target without side effects`, context => {
    const seen = [];
    const { manager, store } = fixture(context, mode, [WINDOW], principal => {
      seen.push(principal);
      return targetFor(principal);
    });
    const saved = manager.manage(PRINCIPAL, request());
    assert.equal(seen[0], PRINCIPAL);
    assert.equal(saved.owner_key, identityKey(IDENTITY));
    assert.equal(saved.window_key, `window:${digest(["qq", WINDOW.component, "private", WINDOW.window_id])}`);
    assert.equal(saved.window_key.length, 71);
    assert.deepEqual(saved.target, { ...IDENTITY, binding_id: "caller-target:caller", binding_generation: 1 });
    assert.deepEqual(Object.keys(saved).sort(), ["window_key", "channel", "component", "window_type", "window_id", "channel_binding_id", "target", "generation", "owner_key", "deleted"].sort());
    assert.equal(saved.channel_binding_id, WINDOW.binding_id);
    assert.equal(saved.generation, 1);
    assert.equal(saved.deleted, false);
    assert.deepEqual(manager.manage(PRINCIPAL, request("get")), saved);
    assert.deepEqual(store.getChannelBinding(saved.window_key), saved);
    assert.equal(Object.hasOwn(saved, "listening_enabled"), false);
    assert.equal(Object.hasOwn(saved, "route_id"), false);
    saved.target.conversation_id = "result mutation";
    assert.equal(manager.manage(PRINCIPAL, request("get")).target.conversation_id, "caller");
  });

  test(`${mode}: preserves the generation of an identical rebind but requires exact CAS before resolving targets`, context => {
    let calls = 0;
    let targetGeneration = 1;
    const { manager } = fixture(context, mode, [WINDOW], principal => {
      calls += 1;
      return targetFor(principal, { binding_generation: targetGeneration });
    });
    const original = manager.manage(PRINCIPAL, request());
    expectCoreError(() => manager.manage(PRINCIPAL, request()), "binding_changed");
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { expected_generation: 2 })), "binding_changed");
    assert.equal(calls, 1);
    assert.deepEqual(manager.manage(PRINCIPAL, request("bind", { expected_generation: 1 })), original);
    targetGeneration = 2;
    const rebound = manager.manage(PRINCIPAL, request("bind", { expected_generation: 1 }));
    assert.equal(rebound.generation, 2);
    assert.equal(rebound.target.binding_generation, 2);
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { expected_generation: 1 })), "binding_changed");
  });

  test(`${mode}: hides other owners on get/list and rejects their overwrite or removal`, context => {
    const { manager } = fixture(context, mode);
    const original = manager.manage(PRINCIPAL, request());
    const otherRequest = action => request(action, { caller: OTHER.identity, expected_generation: 1 });
    assert.equal(manager.manage(OTHER, request("get", { caller: OTHER.identity })), null);
    assert.deepEqual(manager.manage(OTHER, { caller: OTHER.identity, action: "list" }), { bindings: [], next_after_key: null, has_more: false });
    expectCoreError(() => manager.manage(OTHER, otherRequest("bind")), "channel_binding_conflict");
    expectCoreError(() => manager.manage(OTHER, otherRequest("remove")), "channel_binding_conflict");
    assert.deepEqual(manager.manage(PRINCIPAL, request("get")), original);
    manager.manage(PRINCIPAL, request("remove", { expected_generation: 1 }));
    const released = manager.manage(OTHER, request("get", { caller: OTHER.identity }));
    assert.equal(released.generation, 2);
    assert.equal(released.deleted, true);
    assert.ok(!Object.hasOwn(released, "owner_key") && !Object.hasOwn(released, "target"));
    expectCoreError(() => manager.manage(OTHER, request("bind", { caller: OTHER.identity, expected_generation: 0 })), "binding_changed");
    const claimed = manager.manage(OTHER, request("bind", { caller: OTHER.identity, expected_generation: 2 }));
    assert.equal(claimed.generation, 3);
    assert.equal(claimed.owner_key, identityKey(OTHER.identity));
    assert.equal(claimed.target.conversation_id, OTHER.identity.conversation_id);
    assert.equal(manager.manage(PRINCIPAL, request("get")), null);
    expectCoreError(() => manager.manage(PRINCIPAL, request("remove", { expected_generation: 2 })), "channel_binding_conflict");
  });

  test(`${mode}: removal keeps explicit tombstones and recreation continues the generation`, context => {
    const { manager } = fixture(context, mode);
    assert.equal(manager.manage(PRINCIPAL, request("get")), null);
    assert.equal(manager.manage(PRINCIPAL, request("remove", { expected_generation: 0 })), null);
    manager.manage(PRINCIPAL, request());
    expectCoreError(() => manager.manage(PRINCIPAL, request("remove")));
    expectCoreError(() => manager.manage(PRINCIPAL, request("remove", { expected_generation: 0 })), "binding_changed");
    const deleted = manager.manage(PRINCIPAL, request("remove", { expected_generation: 1 }));
    assert.equal(deleted.generation, 2);
    assert.equal(deleted.deleted, true);
    assert.deepEqual(manager.manage(PRINCIPAL, request("get")), deleted);
    assert.deepEqual(manager.manage(PRINCIPAL, { caller: IDENTITY, action: "list" }).bindings, [deleted]);
    assert.deepEqual(manager.manage(PRINCIPAL, request("remove", { expected_generation: 2 })), deleted);
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { expected_generation: 1 })), "binding_changed");
    const recreated = manager.manage(PRINCIPAL, request("bind", { expected_generation: 2 }));
    assert.equal(recreated.generation, 3);
    assert.equal(recreated.deleted, false);
  });

  test(`${mode}: unknown, uninstalled and unauthorized windows fail before registration`, context => {
    let resolveCalls = 0;
    const { manager } = fixture(context, mode, [WINDOW], principal => {
      resolveCalls += 1;
      return targetFor(principal);
    });
    for (const action of ["bind", "get", "remove"]) {
      expectCoreError(() => manager.manage(PRINCIPAL, request(action, { channel: "wechat", expected_generation: action === "get" ? undefined : 0 })), "channel_not_enabled");
      expectCoreError(() => manager.manage(PRINCIPAL, request(action, { window_id: "not-authorized", expected_generation: action === "get" ? undefined : 0 })), "channel_not_enabled");
      expectCoreError(() => manager.manage(PRINCIPAL, request(action, { window_type: "group", expected_generation: action === "get" ? undefined : 0 })), "channel_not_enabled");
    }
    expectCoreError(() => manager.manage(PRINCIPAL, { caller: IDENTITY, action: "list", channel: "wechat" }), "channel_not_enabled");
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { channel: "future-channel" })), "channel_not_enabled");
    assert.equal(resolveCalls, 0);
    assert.deepEqual(manager.manage(PRINCIPAL, { action: "list" }).bindings, []);
  });

  test(`${mode}: rejects caller spoofing and a resolver target from another conversation`, context => {
    const { manager, store } = fixture(context, mode);
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { caller: OTHER.identity })), "caller_mismatch");
    for (const field of ["owner_key", "ownerKey", "component", "target", "window_key", "channel_binding_id", "generation"]) {
      expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { [field]: "injected" })));
    }
    const wrongTarget = new ChannelBindingManager({ store, windows: [WINDOW], resolveCallerTarget: () => targetFor(OTHER) });
    expectCoreError(() => wrongTarget.manage(PRINCIPAL, request()), "caller_mismatch");
    assert.deepEqual(manager.manage(PRINCIPAL, { action: "list" }).bindings, []);
  });
}

test("constructor allows an unavailable store until Core start injects manager.store", context => {
  const { store } = fixture(context, "sqlite");
  const manager = new ChannelBindingManager({ windows: [WINDOW], resolveCallerTarget: targetFor });
  expectCoreError(() => manager.manage(PRINCIPAL, request()), "store_not_ready");
  expectCoreError(() => manager.manage(PRINCIPAL, { action: "list" }), "store_not_ready");
  manager.store = store;
  assert.equal(manager.manage(PRINCIPAL, request()).generation, 1);
  const second = new ChannelBindingManager({ store: {}, windows: [WINDOW], resolveCallerTarget: targetFor });
  expectCoreError(() => second.manage(PRINCIPAL, request("get")), "store_not_ready");
});

test("SQLite records survive store and manager reconstruction without resetting deleted generations", context => {
  const original = fixture(context, "sqlite");
  original.manager.manage(PRINCIPAL, request());
  const tombstone = original.manager.manage(PRINCIPAL, request("remove", { expected_generation: 1 }));
  original.store.close();
  const reopened = new ChannelBindingManager({ store: original.open(), windows: [WINDOW], resolveCallerTarget: targetFor });
  assert.deepEqual(reopened.manage(PRINCIPAL, request("get")), tombstone);
  assert.equal(reopened.manage(PRINCIPAL, request("bind", { expected_generation: 2 })).generation, 3);
});

test("same visible address across components is ambiguous while distinct channel/type/address tuples stay independent", context => {
  const windows = [WINDOW,
    { ...WINDOW, component: "another-account-component", binding_id: "another-account-window" },
    { ...WINDOW, window_type: "group", binding_id: "group-window" },
    { ...WINDOW, channel: "wechat", component: "wechat-isolated", binding_id: "wechat-window" }];
  const { manager } = fixture(context, "sqlite", windows);
  for (const action of ["bind", "get", "remove"]) {
    expectCoreError(() => manager.manage(PRINCIPAL, request(action, { expected_generation: action === "get" ? undefined : 0 })), "channel_window_ambiguous");
  }
  const group = manager.manage(PRINCIPAL, request("bind", { window_type: "group" }));
  const wechat = manager.manage(PRINCIPAL, request("bind", { channel: "wechat" }));
  assert.notEqual(group.window_key, wechat.window_key);
  assert.equal(group.channel_binding_id, "group-window");
  assert.equal(wechat.channel_binding_id, "wechat-window");
});

test("window keys are stable across order, caller, binding label and maximum-length window IDs", context => {
  const longWindow = { ...WINDOW, component: "c".repeat(64), window_id: "中".repeat(85) + "x" };
  const windows = [longWindow, { ...WINDOW, window_type: "group" }];
  const { store, manager } = fixture(context, "memory", windows);
  const saved = manager.manage(PRINCIPAL, request("bind", { window_id: longWindow.window_id }));
  const renamed = new ChannelBindingManager({ store, windows: [{ ...longWindow, binding_id: "renamed-window" }, windows[1]].reverse(), resolveCallerTarget: targetFor });
  const updated = renamed.manage(PRINCIPAL, request("bind", { window_id: longWindow.window_id, expected_generation: 1 }));
  assert.equal(saved.window_key, updated.window_key);
  assert.equal(updated.window_key.length, 71);
  assert.equal(updated.generation, 2);
  assert.equal(updated.channel_binding_id, "renamed-window");
});

test("owner-scoped filtered pages stay bounded and expose a continuation even when the current page has no matches", context => {
  const windows = Array.from({ length: 105 }, (_, index) => ({ ...WINDOW, window_id: `window-${String(index).padStart(3, "0")}` }));
  const { manager, store } = fixture(context, "memory", windows);
  for (const window of windows) manager.manage(PRINCIPAL, request("bind", { window_id: window.window_id }));
  const records = [...store.rows.values()].sort((left, right) => left.window_key.localeCompare(right.window_key));
  manager.manage(PRINCIPAL, request("remove", { window_id: records[0].window_id, expected_generation: 1 }));
  store.rows.set("foreign", { ...records[0], window_key: "foreign", owner_key: identityKey(OTHER.identity) });
  const first = manager.manage(PRINCIPAL, { caller: IDENTITY, action: "list" });
  assert.equal(first.bindings.length, 100);
  assert.equal(first.has_more, true);
  assert.equal(first.next_after_key.length, 71);
  assert.equal(first.bindings[0].deleted, true);
  const second = manager.manage(PRINCIPAL, { action: "list", after_key: first.next_after_key });
  assert.equal(second.bindings.length, 5);
  assert.equal(second.has_more, false);
  assert.equal(second.next_after_key, null);
  assert.equal(new Set([...first.bindings, ...second.bindings].map(record => record.window_key)).size, 105);
  assert.ok([...first.bindings, ...second.bindings].every(record => record.owner_key === identityKey(IDENTITY)));
  const filtered = manager.manage(PRINCIPAL, { action: "list", window_id: records[2].window_id, limit: 1 });
  assert.deepEqual(filtered.bindings, []);
  assert.equal(filtered.has_more, true);
  const found = [];
  let afterKey;
  do {
    const page = manager.manage(PRINCIPAL, { action: "list", window_id: records[2].window_id, limit: 17, after_key: afterKey });
    found.push(...page.bindings);
    afterKey = page.next_after_key;
  } while (afterKey !== null);
  assert.deepEqual(found.map(record => record.window_id), [records[2].window_id]);
  assert.ok(store.calls.filter(call => call.method === "list").every(call => call.limit >= 1 && call.limit <= 100 && call.ownerKey === identityKey(IDENTITY)));
});

test("SQLite keyset pages honor owner, filters, tombstones and exact end-of-list boundaries", context => {
  const windows = [WINDOW, { ...WINDOW, window_id: "second" }, { ...WINDOW, window_id: "third", window_type: "group" }];
  const { manager } = fixture(context, "sqlite", windows);
  for (const window of windows) manager.manage(PRINCIPAL, request("bind", { window_id: window.window_id, window_type: window.window_type }));
  const first = manager.manage(PRINCIPAL, { action: "list", limit: 2 });
  const second = manager.manage(PRINCIPAL, { action: "list", limit: 2, after_key: first.next_after_key });
  assert.equal(first.bindings.length, 2);
  assert.equal(second.bindings.length, 1);
  assert.equal(second.next_after_key, null);
  assert.deepEqual(manager.manage(PRINCIPAL, { action: "list", after_key: "zzzz" }).bindings, []);
  assert.equal(manager.manage(PRINCIPAL, { action: "list", channel: "qq", window_type: "group" }).bindings.length, 1);
  const exact = manager.manage(PRINCIPAL, { action: "list", limit: 3 });
  assert.equal(exact.bindings.length, 3);
  assert.equal(exact.has_more, false);
});

test("validates window configuration uniqueness, limits, fields, types and prototypes before using it", () => {
  const create = windows => new ChannelBindingManager({ windows, resolveCallerTarget: targetFor });
  for (const windows of [null, {}, Array(2), Array(1001).fill(WINDOW), [WINDOW, { ...WINDOW, binding_id: "renamed" }]]) {
    expectCoreError(() => create(windows));
  }
  for (const [field, values] of [
    ["channel", ["telegram", null, {}, ""]], ["window_type", ["room", null, ""]],
    ["window_id", ["", " ", 1, "x".repeat(257), "bad\0id"]],
    ["component", ["", 1, "x".repeat(65)]], ["binding_id", ["", 1, "x".repeat(129)]],
  ]) for (const value of values) expectCoreError(() => create([{ ...WINDOW, [field]: value }]));
  expectCoreError(() => create([{ ...WINDOW, unknown: true }]));
  expectCoreError(() => create([Object.assign(Object.create({ inherited: true }), WINDOW)]));
  expectCoreError(() => create([JSON.parse('{"__proto__":{"polluted":true}}')]));
  const accessed = [];
  const badWindow = { ...WINDOW, get component() { accessed.push("component"); return "bad"; } };
  expectCoreError(() => create([badWindow]));
  const badArray = [];
  Object.defineProperty(badArray, "0", { enumerable: true, get() { accessed.push("array"); return WINDOW; } });
  expectCoreError(() => create(badArray));
  assert.deepEqual(accessed, []);
  const source = [{ ...WINDOW }];
  const manager = new ChannelBindingManager({ store: new MemoryStore(), windows: source, resolveCallerTarget: targetFor });
  source[0].window_id = "mutated";
  source.length = 0;
  assert.equal(manager.manage(PRINCIPAL, request()).window_id, WINDOW.window_id);
});

test("validates input fields and action-specific fields, pagination and counters", context => {
  const { manager } = fixture(context, "memory");
  for (const input of [null, [], "request", 1, {}, { action: "unsupported" }, { action: "__proto__" }]) {
    expectCoreError(() => manager.manage(PRINCIPAL, input));
  }
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, null, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => manager.manage(PRINCIPAL, { action: "list", limit }));
  }
  for (const key of ["", " ", 1, null, [], "x".repeat(257), "bad\0key"]) {
    expectCoreError(() => manager.manage(PRINCIPAL, { action: "list", after_key: key }));
  }
  for (const generation of [-1, 1.5, NaN, Infinity, null, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { expected_generation: generation })));
    expectCoreError(() => manager.manage(PRINCIPAL, request("remove", { expected_generation: generation })));
  }
  expectCoreError(() => manager.manage(PRINCIPAL, request("get", { expected_generation: 0 })));
  expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { limit: 1 })));
  expectCoreError(() => manager.manage(PRINCIPAL, { action: "list", expected_generation: 0 }));
  for (const patch of [{ window_id: "x".repeat(257) }, { window_type: "room" }, { window_id: 1 }]) {
    expectCoreError(() => manager.manage(PRINCIPAL, request("bind", patch)));
  }
  expectCoreError(() => manager.manage(PRINCIPAL, { action: "list", window_type: "room" }));
});

test("rejects prototype, symbol and accessor inputs without running caller-supplied code", context => {
  const { manager } = fixture(context, "memory");
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const unsafe = [Object.assign(Object.create({ inherited: true }), request()),
    JSON.parse('{"__proto__":{"polluted":true}}'), new Proxy(request(), {}), revoked.proxy,
    { ...request(), [Symbol("unknown")]: true }];
  for (const input of unsafe) expectCoreError(() => manager.manage(PRINCIPAL, input));
  let calls = 0;
  expectCoreError(() => manager.manage(PRINCIPAL, { ...request(), get action() { calls += 1; return "bind"; } }));
  expectCoreError(() => manager.manage({ get identity() { calls += 1; return IDENTITY; } }, request()));
  expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { caller: { ...IDENTITY, get host() { calls += 1; return "codex"; } } })));
  expectCoreError(() => manager.manage({ ...PRINCIPAL, identity: { ...IDENTITY, conversation_id: "*" } }, request()));
  expectCoreError(() => manager.manage(PRINCIPAL, request("bind", { caller: { ...IDENTITY, unknown: true } })));
  assert.equal(calls, 0);
  assert.equal({}.polluted, undefined);
});

test("rejects asynchronous, malformed or hostile resolver results and preserves the old mapping", async context => {
  expectCoreError(() => new ChannelBindingManager({ resolveCallerTarget: async () => targetFor(PRINCIPAL) }));
  for (const resolver of [undefined, null, {}, "target"]) {
    expectCoreError(() => new ChannelBindingManager({ resolveCallerTarget: resolver }));
  }
  const { store, manager } = fixture(context, "sqlite");
  const original = manager.manage(PRINCIPAL, request());
  for (const resolved of [null, {}, [], { ...targetFor(PRINCIPAL), binding_generation: 0 },
    { ...targetFor(PRINCIPAL), binding_id: "x".repeat(129) },
    Object.assign(Object.create({ inherited: true }), targetFor(PRINCIPAL)),
    { ...targetFor(PRINCIPAL), then() { throw new Error("must not execute"); } }]) {
    const invalid = new ChannelBindingManager({ store, windows: [WINDOW], resolveCallerTarget: () => resolved });
    expectCoreError(() => invalid.manage(PRINCIPAL, request("bind", { expected_generation: 1 })));
    assert.deepEqual(manager.manage(PRINCIPAL, request("get")), original);
  }
  const promise = new ChannelBindingManager({ store, windows: [WINDOW], resolveCallerTarget: () => Promise.reject(new Error("invalid async callback")) });
  expectCoreError(() => promise.manage(PRINCIPAL, request("bind", { expected_generation: 1 })));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(manager.manage(PRINCIPAL, request("get")), original);
});

test("SQLite transaction rollback also covers the caller-directory resolver's work", context => {
  const { store, manager } = fixture(context, "sqlite");
  const original = manager.manage(PRINCIPAL, request());
  const invalid = new ChannelBindingManager({ store, windows: [WINDOW], resolveCallerTarget: principal => {
    store.putBinding(targetFor(principal));
    return targetFor(OTHER);
  } });
  expectCoreError(() => invalid.manage(PRINCIPAL, request("bind", { expected_generation: 1 })), "caller_mismatch");
  assert.equal(store.getBinding("caller-target:caller"), null);
  assert.deepEqual(manager.manage(PRINCIPAL, request("get")), original);
});

test("rejects a store page that violates ownership or page-size bounds", context => {
  const { manager, store } = fixture(context, "memory");
  store.listChannelBindings = () => [{ window_key: "foreign", owner_key: identityKey(OTHER.identity) }];
  expectCoreError(() => manager.manage(PRINCIPAL, { action: "list" }), "store_result_invalid");
  store.listChannelBindings = () => Array(101).fill({ window_key: "own", owner_key: identityKey(IDENTITY) });
  expectCoreError(() => manager.manage(PRINCIPAL, { action: "list" }), "store_result_invalid");
});
