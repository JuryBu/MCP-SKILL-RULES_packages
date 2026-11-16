import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoreError, identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

const OWNER = identityKey({ machine_id: "test-machine", host: "codex", surface: "desktop", conversation_id: "owner" });
const OTHER_OWNER = identityKey({ machine_id: "test-machine", host: "codex", surface: "desktop", conversation_id: "other-owner" });
const CREATED_AT = "2026-11-16T00:00:00.000Z";

function makeBinding(bindingId = "binding-1", overrides = {}) {
  return {
    machine_id: "test-machine",
    host: "codex",
    surface: "desktop",
    conversation_id: `conversation:${bindingId}`,
    binding_id: bindingId,
    binding_generation: 1,
    adapter_id: "isolated-adapter",
    capabilities: { next_model_boundary: true, when_idle: true },
    evidence: "isolated-directory-test",
    extra: { future: ["保留完整JSON", 1.25, null] },
    ...overrides,
  };
}

function makeChannel(windowKey = "qq:test-window", overrides = {}) {
  return {
    window_key: windowKey,
    channel: "qq",
    target: { conversation_id: "test-conversation", labels: ["isolated"] },
    ...overrides,
  };
}

function expectCoreError(callback, code = "invalid_input") {
  assert.throws(callback, error => error instanceof CoreError && error.code === code);
}

function createFixture(context, { legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-core-directory-"));
  const filePath = join(directory, "旧库与目录 测试.sqlite");
  const connections = [];
  context.after(() => {
    try {
      for (const connection of connections) {
        if (!(connection instanceof DatabaseSync) || connection.isOpen) connection.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const raw = () => {
    const connection = new DatabaseSync(filePath);
    connections.push(connection);
    return connection;
  };
  let legacySchema;
  if (legacy) {
    const connection = raw();
    connection.exec(`
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        source_key TEXT NOT NULL,
        target_key TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        UNIQUE (source_key, dedupe_key)
      ) STRICT;
      CREATE INDEX messages_target ON messages (target_key);
      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE REFERENCES messages (message_id),
        target_key TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK (json_valid(record_json))
      ) STRICT;
      CREATE INDEX deliveries_status_id ON deliveries (status, delivery_id);
      CREATE TABLE message_events (
        message_id TEXT NOT NULL REFERENCES messages (message_id),
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL CHECK (json_valid(data_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, sequence)
      ) STRICT;
    `);
    const message = {
      message_id: "legacy-message", source_key: OWNER, target_key: OTHER_OWNER,
      dedupe_key: "legacy-dedupe", payload_hash: "legacy-hash", envelope: { text: "原消息" },
      created_at: CREATED_AT, delivery_status: "accepted", processing: "pending",
      model_observed: "unknown", ui_observed: "unknown",
    };
    const delivery = {
      delivery_id: "legacy-delivery", message_id: message.message_id, target_key: OTHER_OWNER,
      status: "accepted", attempt_count: 1, created_at: CREATED_AT, updated_at: CREATED_AT,
    };
    connection.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)")
      .run(message.message_id, OWNER, OTHER_OWNER, message.dedupe_key, message.payload_hash, JSON.stringify(message));
    connection.prepare("INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, ?)")
      .run(delivery.delivery_id, message.message_id, OTHER_OWNER, delivery.status, CREATED_AT, JSON.stringify(delivery));
    connection.prepare("INSERT INTO message_events VALUES (?, 1, ?, ?, ?)")
      .run(message.message_id, "legacy-event", '{"original":true}', CREATED_AT);
    legacySchema = connection.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    connection.close();
  }
  const open = () => {
    const connection = new MessageStore({ filePath });
    connections.push(connection);
    return connection;
  };
  return { directory, filePath, raw, open, legacySchema, store: open() };
}

function padRecord(record, bytes) {
  const padded = { ...record, padding: "" };
  padded.padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(padded), "utf8"));
  assert.equal(Buffer.byteLength(JSON.stringify(padded), "utf8"), bytes);
  return padded;
}

test("opens an actual legacy schema in place and preserves all old tables and records after reopening", context => {
  const fixture = createFixture(context, { legacy: true });
  const oldMessage = fixture.store.getMessage("legacy-message");
  const oldDelivery = fixture.store.getDelivery("legacy-delivery");
  const oldEvents = fixture.store.eventsAfter("legacy-message");
  const observer = fixture.raw();
  for (const entry of fixture.legacySchema) {
    assert.deepEqual(observer.prepare("SELECT name, sql FROM sqlite_schema WHERE name = ?").get(entry.name), entry);
  }
  const binding = fixture.store.putBinding(makeBinding(), { expectedGeneration: 0 });
  const channel = fixture.store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  fixture.store.close();
  const reopened = fixture.open();
  assert.deepEqual(reopened.getBinding(binding.binding_id), binding);
  assert.deepEqual(reopened.findBindingByIdentity(identityKey(binding)), binding);
  assert.deepEqual(reopened.getChannelBinding(channel.window_key), channel);
  assert.deepEqual(reopened.getMessage("legacy-message"), oldMessage);
  assert.deepEqual(reopened.getDelivery("legacy-delivery"), oldDelivery);
  assert.deepEqual(reopened.eventsAfter("legacy-message"), oldEvents);
  assert.equal(reopened.appendEvent("legacy-message", "after-upgrade").sequence, 2);
  assert.equal(reopened.updateMessage("legacy-message", { processing: "processed" }).processing, "processed");
  assert.equal(reopened.updateDelivery("legacy-delivery", { attempt_count: 2 }).attempt_count, 2);
  assert.equal(observer.prepare("SELECT COUNT(*) AS count FROM pragma_table_list WHERE name IN ('messages', 'deliveries', 'message_events', 'conversation_bindings', 'channel_bindings')").get().count, 5);
  assert.ok(readdirSync(fixture.directory).every(name => name.startsWith("旧库与目录 测试.sqlite")));
});

test("keeps complete binding JSON detached and derives the unique key from all four identity fields", context => {
  const { store } = createFixture(context);
  const input = makeBinding("binding-json", { conversation_id: '对话"\\\n', binding_generation: 99 });
  const saved = store.putBinding(input);
  assert.equal(saved.binding_generation, 1);
  input.extra.future.push("input mutation");
  saved.extra.future.push("result mutation");
  const queried = store.getBinding(input.binding_id);
  assert.deepEqual(queried.extra.future, ["保留完整JSON", 1.25, null]);
  store.findBindingByIdentity(identityKey(input)).extra.future.push("query mutation");
  store.listBindings()[0].extra.future.push("list mutation");
  assert.deepEqual(store.getBinding(input.binding_id), queried);
  for (const field of ["machine_id", "host", "surface", "conversation_id"]) {
    assert.equal(store.findBindingByIdentity(identityKey({ ...input, [field]: "different" })), null);
  }
  const moved = store.putBinding({ ...queried, conversation_id: "new-conversation" }, { expectedGeneration: 1 });
  assert.equal(moved.binding_generation, 2);
  assert.equal(store.findBindingByIdentity(identityKey(queried)), null);
  assert.deepEqual(store.findBindingByIdentity(identityKey(moved)), moved);
});

test("enforces binding ID and identity uniqueness atomically for creation and updates", context => {
  const { store } = createFixture(context);
  const first = store.putBinding(makeBinding("first"));
  const second = store.putBinding(makeBinding("second"));
  expectCoreError(() => store.putBinding({ ...first, binding_id: "duplicate-identity" }), "binding_conflict");
  expectCoreError(() => store.putBinding({ ...first, conversation_id: second.conversation_id }, { expectedGeneration: 1 }), "binding_conflict");
  expectCoreError(() => store.putBinding(makeBinding("first")), "binding_changed");
  assert.equal(store.getBinding("duplicate-identity"), null);
  assert.deepEqual(store.getBinding("first"), first);
  assert.deepEqual(store.getBinding("second"), second);
  assert.equal(store.putBinding(makeBinding("third")).binding_generation, 1);
});

test("requires the exact expected generation before even an idempotent binding write", context => {
  const { store } = createFixture(context);
  expectCoreError(() => store.putBinding(makeBinding(), { expectedGeneration: 1 }), "binding_changed");
  assert.equal(store.getBinding("binding-1"), null);
  const original = store.putBinding(makeBinding(), { expectedGeneration: 0 });
  for (const options of [{}, { expectedGeneration: 0 }, { expectedGeneration: 2 }]) {
    expectCoreError(() => store.putBinding(original, options), "binding_changed");
  }
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.deepEqual(store.putBinding(reordered, { expectedGeneration: 1 }), original);
  const updated = store.putBinding({ ...original, adapter_id: "changed-adapter" }, { expectedGeneration: 1 });
  assert.equal(updated.binding_generation, 2);
  expectCoreError(() => store.putBinding(updated, { expectedGeneration: 1 }), "binding_changed");
  assert.deepEqual(store.putBinding(updated, { expectedGeneration: 2 }), updated);
});

test("returns authoritative channel metadata with detached full JSON and monotonic updates", context => {
  const { store } = createFixture(context);
  const input = makeChannel("qq:window", { generation: 73, owner_key: OWNER, deleted: true });
  const saved = store.putChannelBinding(input, { ownerKey: OWNER, expectedGeneration: 0 });
  assert.deepEqual({ generation: saved.generation, owner: saved.owner_key, window: saved.window_key, deleted: saved.deleted },
    { generation: 1, owner: OWNER, window: "qq:window", deleted: false });
  input.target.labels.push("input mutation");
  saved.target.labels.push("result mutation");
  const current = store.getChannelBinding("qq:window");
  assert.deepEqual(current.target.labels, ["isolated"]);
  current.target.labels.push("query mutation");
  store.listChannelBindings({ ownerKey: OWNER })[0].target.labels.push("list mutation");
  assert.deepEqual(store.getChannelBinding("qq:window").target.labels, ["isolated"]);
  const updated = store.putChannelBinding(makeChannel("qq:window", { channel: "wechat" }),
    { ownerKey: OWNER, expectedGeneration: 1 });
  assert.equal(updated.generation, 2);
  assert.equal(updated.channel, "wechat");
  expectCoreError(() => store.putChannelBinding(updated, { ownerKey: OWNER, expectedGeneration: 1 }), "binding_changed");
  assert.equal(store.putChannelBinding(updated, { ownerKey: OWNER, expectedGeneration: 2 }).generation, 3);
});

test("rejects cross-owner overwrites and deletes, including tombstones", context => {
  const { store } = createFixture(context);
  const current = store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  for (const expectedGeneration of [0, 1, 999]) {
    expectCoreError(() => store.putChannelBinding(makeChannel(), { ownerKey: OTHER_OWNER, expectedGeneration }), "channel_binding_conflict");
    expectCoreError(() => store.deleteChannelBinding(current.window_key, { ownerKey: OTHER_OWNER, expectedGeneration }), "channel_binding_conflict");
  }
  assert.deepEqual(store.getChannelBinding(current.window_key), current);
  const tombstone = store.deleteChannelBinding(current.window_key, { ownerKey: OWNER, expectedGeneration: 1 });
  expectCoreError(() => store.putChannelBinding(makeChannel(), { ownerKey: OTHER_OWNER, expectedGeneration: 2 }), "channel_binding_conflict");
  expectCoreError(() => store.deleteChannelBinding(current.window_key, { ownerKey: OTHER_OWNER, expectedGeneration: 2 }), "channel_binding_conflict");
  assert.deepEqual(store.getChannelBinding(current.window_key), tombstone);
  assert.deepEqual(store.listChannelBindings({ ownerKey: OTHER_OWNER }), []);
});

test("persists deletion generations through reopen and recreation without accepting stale references", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  assert.equal(store.deleteChannelBinding("missing", { ownerKey: OWNER, expectedGeneration: 0 }), null);
  expectCoreError(() => store.deleteChannelBinding("missing", { ownerKey: OWNER, expectedGeneration: 1 }), "binding_changed");
  expectCoreError(() => store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 1 }), "binding_changed");
  store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  const deleted = store.deleteChannelBinding("qq:test-window", { ownerKey: OWNER, expectedGeneration: 1 });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.generation, 2);
  assert.deepEqual(store.deleteChannelBinding(deleted.window_key, { ownerKey: OWNER, expectedGeneration: 2 }), deleted);
  assert.deepEqual(store.listChannelBindings({ ownerKey: OWNER }), [deleted]);
  store.close();
  const reopened = fixture.open();
  assert.deepEqual(reopened.getChannelBinding(deleted.window_key), deleted);
  for (const expectedGeneration of [0, 1]) {
    expectCoreError(() => reopened.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration }), "binding_changed");
    expectCoreError(() => reopened.deleteChannelBinding(deleted.window_key, { ownerKey: OWNER, expectedGeneration }), "binding_changed");
  }
  const recreated = reopened.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 2 });
  assert.equal(recreated.generation, 3);
  assert.equal(recreated.deleted, false);
  expectCoreError(() => reopened.deleteChannelBinding(recreated.window_key, { ownerKey: OWNER, expectedGeneration: 2 }), "binding_changed");
  assert.equal(reopened.deleteChannelBinding(recreated.window_key, { ownerKey: OWNER, expectedGeneration: 3 }).generation, 4);
});

test("shares transactions and nested savepoints with messages, deliveries and events", context => {
  const { store } = createFixture(context, { legacy: true });
  const initialBinding = store.putBinding(makeBinding());
  const initialChannel = store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  assert.throws(() => store.transaction(() => {
    store.putBinding({ ...initialBinding, evidence: "rolled-back" }, { expectedGeneration: 1 });
    store.deleteChannelBinding(initialChannel.window_key, { ownerKey: OWNER, expectedGeneration: 1 });
    store.putBinding(makeBinding("rolled-back"));
    store.putChannelBinding(makeChannel("rolled-back"), { ownerKey: OWNER, expectedGeneration: 0 });
    store.updateMessage("legacy-message", { processing: "processed" });
    store.updateDelivery("legacy-delivery", { status: "unknown" });
    store.appendEvent("legacy-message", "rolled-back");
    throw new Error("outer rollback");
  }), /outer rollback/);
  assert.deepEqual(store.getBinding(initialBinding.binding_id), initialBinding);
  assert.deepEqual(store.getChannelBinding(initialChannel.window_key), initialChannel);
  assert.equal(store.getBinding("rolled-back"), null);
  assert.equal(store.getChannelBinding("rolled-back"), null);
  assert.equal(store.getMessage("legacy-message").processing, "pending");
  assert.equal(store.getDelivery("legacy-delivery").status, "accepted");
  assert.equal(store.lastSequence("legacy-message"), 1);
  store.transaction(() => {
    store.putBinding(makeBinding("outer"));
    assert.throws(() => store.transaction(() => {
      store.putBinding(makeBinding("inner"));
      store.putChannelBinding(makeChannel("inner"), { ownerKey: OWNER, expectedGeneration: 0 });
      store.putBinding(makeBinding("outer"));
    }), error => error.code === "binding_changed");
    assert.equal(store.getBinding("inner"), null);
    assert.equal(store.getChannelBinding("inner"), null);
    store.putChannelBinding(makeChannel("outer"), { ownerKey: OWNER, expectedGeneration: 0 });
  });
  assert.equal(store.getBinding("outer").binding_generation, 1);
  assert.equal(store.getChannelBinding("outer").generation, 1);
});

test("separate connections observe committed generations and recover after writer lock failures", context => {
  const fixture = createFixture(context);
  const first = fixture.store;
  const second = fixture.open();
  const original = first.putBinding(makeBinding());
  first.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  assert.deepEqual(second.getBinding(original.binding_id), original);
  first.putBinding({ ...original, evidence: "newer" }, { expectedGeneration: 1 });
  expectCoreError(() => second.putBinding(original, { expectedGeneration: 1 }), "binding_changed");
  first.deleteChannelBinding("qq:test-window", { ownerKey: OWNER, expectedGeneration: 1 });
  expectCoreError(() => second.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 1 }), "binding_changed");
  first.transaction(() => {
    first.putBinding(makeBinding("uncommitted"));
    assert.equal(second.getBinding("uncommitted"), null);
    assert.throws(() => second.putBinding(makeBinding("locked")), /locked/);
  });
  assert.equal(second.getBinding("uncommitted").binding_generation, 1);
  assert.equal(second.putBinding(makeBinding("locked")).binding_generation, 1);
});

test("initialization faults roll back directory schema creation and close the failed database", context => {
  const fixture = createFixture(context);
  const observer = fixture.raw();
  observer.exec("DROP TABLE channel_bindings; DROP TABLE conversation_bindings;");
  fixture.store.close();
  const originalExec = DatabaseSync.prototype.exec;
  const failure = new Error("directory initialization fault");
  let failedConnection;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS conversation_bindings")) {
      failedConnection = this;
      originalExec.call(this, "BEGIN IMMEDIATE; CREATE TABLE directory_initialization_probe (value TEXT) STRICT;");
      throw failure;
    }
    return originalExec.call(this, sql);
  };
  try {
    assert.throws(() => fixture.open(), error => error === failure);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.equal(failedConnection.isOpen, false);
  assert.equal(observer.prepare("SELECT name FROM sqlite_schema WHERE name = 'directory_initialization_probe'").get(), undefined);
  assert.equal(observer.prepare("SELECT name FROM sqlite_schema WHERE name = 'conversation_bindings'").get(), undefined);
  assert.equal(fixture.open().putBinding(makeBinding()).binding_generation, 1);
});

test("uses STRICT tables, unique identities, JSON constraints and the owner keyset index", context => {
  const fixture = createFixture(context);
  const observer = fixture.raw();
  for (const name of ["conversation_bindings", "channel_bindings"]) {
    assert.equal(observer.prepare("SELECT strict FROM pragma_table_list WHERE name = ?").get(name).strict, 1);
  }
  const binding = fixture.store.putBinding(makeBinding());
  const insertBinding = observer.prepare("INSERT INTO conversation_bindings VALUES (?, ?, ?, ?)");
  assert.throws(() => insertBinding.run("other", identityKey(binding), 1,
    JSON.stringify({ ...binding, binding_id: "other" })), /UNIQUE/);
  for (const record of ["not JSON", "[]", "{}", JSON.stringify({ ...binding, binding_id: "wrong" }),
    JSON.stringify({ ...binding, binding_id: "bad", binding_generation: 2 })]) {
    assert.throws(() => insertBinding.run("bad", "unique-bad", 1, record));
  }
  assert.throws(() => insertBinding.run("bad", "unique-bad", 1.5,
    JSON.stringify({ ...binding, binding_id: "bad", binding_generation: 1.5 })));
  const channel = fixture.store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  const insertChannel = observer.prepare("INSERT INTO channel_bindings VALUES (?, ?, ?, ?, ?)");
  for (const patch of [{ owner_key: OTHER_OWNER }, { window_key: "wrong" }, { generation: 2 }, { deleted: true }]) {
    assert.throws(() => insertChannel.run("bad", OWNER, 1, 0, JSON.stringify({ ...channel, window_key: "bad", ...patch })));
  }
  assert.throws(() => insertChannel.run("bad", OWNER, 0, 0, JSON.stringify({ ...channel, window_key: "bad", generation: 0 })));
  assert.throws(() => insertChannel.run("bad", OWNER, 1, 2, JSON.stringify({ ...channel, window_key: "bad" })));
  assert.throws(() => insertChannel.run("bad", OWNER, 1, 0,
    JSON.stringify({ ...channel, window_key: "bad", padding: "x".repeat(65536) })));
  const plan = observer.prepare("EXPLAIN QUERY PLAN SELECT record_json FROM channel_bindings WHERE owner_key = ? AND window_key > ? ORDER BY window_key LIMIT ?")
    .all(OWNER, "", 100);
  assert.ok(plan.some(row => row.detail.includes("channel_bindings_owner_window")));
});

test("caps both directory listings at 100 and uses exclusive stable owner-scoped keyset pages", context => {
  const { store } = createFixture(context);
  store.transaction(() => {
    for (let recordIndex = 104; recordIndex >= 0; recordIndex -= 1) {
      const suffix = String(recordIndex).padStart(3, "0");
      store.putBinding(makeBinding(`binding-${suffix}`));
      store.putChannelBinding(makeChannel(`window-${suffix}`), { ownerKey: OWNER, expectedGeneration: 0 });
      if (recordIndex % 10 === 0) store.putChannelBinding(makeChannel(`other-${suffix}`), { ownerKey: OTHER_OWNER, expectedGeneration: 0 });
    }
  });
  assert.equal(store.listBindings().length, 100);
  assert.equal(store.listChannelBindings({ ownerKey: OWNER }).length, 100);
  const firstBindings = store.listBindings({ limit: 2, afterId: undefined });
  const firstChannels = store.listChannelBindings({ ownerKey: OWNER, limit: 2, afterKey: undefined });
  assert.deepEqual(firstBindings.map(record => record.binding_id), ["binding-000", "binding-001"]);
  assert.deepEqual(firstChannels.map(record => record.window_key), ["window-000", "window-001"]);
  store.putBinding(makeBinding("binding-000-before-cursor"));
  store.putBinding(makeBinding("binding-001-next"));
  store.putChannelBinding(makeChannel("window-000-before-cursor"), { ownerKey: OWNER, expectedGeneration: 0 });
  store.putChannelBinding(makeChannel("window-001-next"), { ownerKey: OWNER, expectedGeneration: 0 });
  store.deleteChannelBinding("window-002", { ownerKey: OWNER, expectedGeneration: 1 });
  assert.deepEqual(store.listBindings({ afterId: "binding-001", limit: 2 }).map(record => record.binding_id), ["binding-001-next", "binding-002"]);
  assert.deepEqual(store.listChannelBindings({ ownerKey: OWNER, afterKey: "window-001", limit: 2 })
    .map(record => record.window_key), ["window-001-next", "window-002"]);
  const bindings = [];
  const channels = [];
  let afterId;
  let afterKey;
  while (true) {
    const page = store.listBindings({ limit: 17, afterId });
    if (!page.length) break;
    bindings.push(...page.map(record => record.binding_id));
    afterId = page.at(-1).binding_id;
  }
  while (true) {
    const page = store.listChannelBindings({ ownerKey: OWNER, limit: 17, afterKey });
    if (!page.length) break;
    channels.push(...page.map(record => record.window_key));
    assert.ok(page.every(record => record.owner_key === OWNER));
    afterKey = page.at(-1).window_key;
  }
  assert.equal(bindings.length, 107);
  assert.equal(channels.length, 107);
  assert.equal(new Set(bindings).size, bindings.length);
  assert.equal(new Set(channels).size, channels.length);
  assert.deepEqual(bindings, bindings.toSorted());
  assert.deepEqual(channels, channels.toSorted());
  assert.deepEqual(store.listBindings({ afterId: "zzzz" }), []);
  assert.deepEqual(store.listChannelBindings({ ownerKey: OWNER, afterKey: "zzzz" }), []);
  assert.equal(store.listChannelBindings({ ownerKey: OTHER_OWNER }).length, 11);
});

test("validates limits, cursor keys, IDs, identities, ownership and generation options", context => {
  const { store } = createFixture(context);
  for (const limit of [0, -1, 1.5, 101, Infinity, NaN, "100", null, Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => store.listBindings({ limit }));
    expectCoreError(() => store.listChannelBindings({ ownerKey: OWNER, limit }));
  }
  for (const key of [null, 1, {}, [], "", " \n", "bad\0key", "x".repeat(4097)]) {
    expectCoreError(() => store.getBinding(key));
    expectCoreError(() => store.findBindingByIdentity(key));
    expectCoreError(() => store.getChannelBinding(key));
    expectCoreError(() => store.listBindings({ afterId: key }));
    expectCoreError(() => store.listChannelBindings({ ownerKey: OWNER, afterKey: key }));
    expectCoreError(() => store.listChannelBindings({ ownerKey: key }));
    expectCoreError(() => store.putChannelBinding(makeChannel(), { ownerKey: key, expectedGeneration: 0 }));
    expectCoreError(() => store.putChannelBinding(makeChannel(key), { ownerKey: OWNER, expectedGeneration: 0 }));
    expectCoreError(() => store.deleteChannelBinding(key, { ownerKey: OWNER, expectedGeneration: 0 }));
    expectCoreError(() => store.deleteChannelBinding("window", { ownerKey: key, expectedGeneration: 0 }));
  }
  for (const generation of [-1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => store.putBinding(makeBinding(), { expectedGeneration: generation }));
    expectCoreError(() => store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: generation }));
    expectCoreError(() => store.deleteChannelBinding("window", { ownerKey: OWNER, expectedGeneration: generation }));
  }
  for (const generation of [0, -1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => store.putBinding(makeBinding("invalid", { binding_generation: generation })));
    expectCoreError(() => store.putChannelBinding(makeChannel("invalid", { generation }), { ownerKey: OWNER, expectedGeneration: 0 }));
  }
  for (const [field, maximum] of [["binding_id", 128], ["machine_id", 128], ["host", 64], ["surface", 64], ["conversation_id", 256]]) {
    for (const value of ["", " ", null, 1, "x".repeat(maximum + 1), "中".repeat(Math.floor(maximum / 3) + 1)]) {
      expectCoreError(() => store.putBinding(makeBinding("invalid", { [field]: value })));
    }
  }
  expectCoreError(() => store.putBinding(makeBinding("invalid", { identity_key: "wrong" })));
  expectCoreError(() => store.putChannelBinding(makeChannel("invalid", { owner_key: OTHER_OWNER }), { ownerKey: OWNER, expectedGeneration: 0 }));
  expectCoreError(() => store.putChannelBinding(makeChannel("invalid", { deleted: 1 }), { ownerKey: OWNER, expectedGeneration: 0 }));
  expectCoreError(() => store.listChannelBindings());
  expectCoreError(() => store.putChannelBinding(makeChannel(), { ownerKey: OWNER }));
  expectCoreError(() => store.deleteChannelBinding("window", { ownerKey: OWNER }));
  for (const options of [null, [], "options", { unknown: 1 }, new Date()]) {
    expectCoreError(() => store.putBinding(makeBinding(), options));
    expectCoreError(() => store.listBindings(options));
    expectCoreError(() => store.putChannelBinding(makeChannel(), options));
    expectCoreError(() => store.listChannelBindings(options));
    expectCoreError(() => store.deleteChannelBinding("window", options));
  }
  const longestId = "x".repeat(128);
  assert.equal(store.putBinding(makeBinding(longestId)).binding_id, longestId);
  const longestKey = "k".repeat(4096);
  assert.equal(store.putChannelBinding(makeChannel(longestKey), { ownerKey: longestKey, expectedGeneration: 0 }).window_key, longestKey);
  assert.equal(store.getChannelBinding(longestKey).owner_key, longestKey);
  assert.equal(store.listChannelBindings({ ownerKey: longestKey }).length, 1);
});

test("rejects prototype pollution and non-JSON structures without invoking getters or toJSON", context => {
  const { store } = createFixture(context);
  const cyclic = {};
  cyclic.self = cyclic;
  let hookCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get() { hookCalls += 1; return "bad"; } });
  const toJSON = { toJSON() { hookCalls += 1; return {}; } };
  const symbol = { [Symbol("unsupported")]: true };
  const hidden = {};
  Object.defineProperty(hidden, "hidden", { value: true });
  const inherited = Object.create({ polluted: true });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let deep = {};
  for (let depth = 0; depth < 70; depth += 1) deep = { nested: deep };
  const unsafeValues = [cyclic, accessor, toJSON, symbol, hidden, inherited, new Date(), new Map(),
    JSON.parse('{"__proto__":{"polluted":true}}'), JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
    JSON.parse('{"prototype":{"polluted":true}}'), new Proxy({}, {}), revoked.proxy, [undefined], Array(2), 1n, Infinity,
    NaN, Number.MAX_SAFE_INTEGER + 1, undefined, () => {}, deep];
  for (const extra of unsafeValues) {
    expectCoreError(() => store.putBinding(makeBinding("invalid", { extra })));
    expectCoreError(() => store.putChannelBinding(makeChannel("invalid", { extra }), { ownerKey: OWNER, expectedGeneration: 0 }));
  }
  for (const record of [null, [], "record", 1, revoked.proxy]) {
    expectCoreError(() => store.putBinding(record));
    expectCoreError(() => store.putChannelBinding(record, { ownerKey: OWNER, expectedGeneration: 0 }));
  }
  expectCoreError(() => store.putBinding(makeBinding("invalid"), Object.create({ expectedGeneration: 0 })));
  expectCoreError(() => store.putBinding(makeBinding("invalid"), { get expectedGeneration() { hookCalls += 1; return 0; } }));
  assert.equal(hookCalls, 0);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(store.listBindings(), []);
  assert.deepEqual(store.listChannelBindings({ ownerKey: OWNER }), []);
  const nullPrototype = Object.assign(Object.create(null), makeBinding("safe-null-prototype"));
  assert.equal(store.putBinding(nullPrototype).binding_generation, 1);
});

test("enforces the 65536-byte JSON limit before and after adding authoritative metadata", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  const binding = padRecord(makeBinding("at-limit"), 65536);
  assert.deepEqual(store.putBinding(binding), binding);
  expectCoreError(() => store.putBinding(padRecord(makeBinding("over-limit"), 65537)));
  const channel = padRecord(makeChannel("at-limit", { generation: 1, owner_key: OWNER, deleted: false }), 65536);
  assert.deepEqual(store.putChannelBinding(channel, { ownerKey: OWNER, expectedGeneration: 0 }), channel);
  expectCoreError(() => store.putChannelBinding(padRecord(makeChannel("over-limit"), 65537), { ownerKey: OWNER, expectedGeneration: 0 }));
  const metadataOverflow = padRecord(makeChannel("metadata-overflow"), 65536);
  expectCoreError(() => store.putChannelBinding(metadataOverflow, { ownerKey: OWNER, expectedGeneration: 0 }));
  assert.equal(store.getChannelBinding("metadata-overflow"), null);
  const observer = fixture.raw();
  const ninthBinding = { ...binding, binding_generation: 9 };
  observer.prepare("UPDATE conversation_bindings SET binding_generation = ?, record_json = ? WHERE binding_id = ?")
    .run(9, JSON.stringify(ninthBinding), binding.binding_id);
  expectCoreError(() => store.putBinding({ ...binding, adapter_id: "changed--adapter" }, { expectedGeneration: 9 }));
  assert.deepEqual(store.getBinding(binding.binding_id), ninthBinding);
  const ninthChannel = { ...channel, generation: 9 };
  observer.prepare("UPDATE channel_bindings SET generation = ?, record_json = ? WHERE window_key = ?")
    .run(9, JSON.stringify(ninthChannel), channel.window_key);
  expectCoreError(() => store.putChannelBinding(channel, { ownerKey: OWNER, expectedGeneration: 9 }));
  assert.deepEqual(store.getChannelBinding(channel.window_key), ninthChannel);
});

test("rejects safe-integer generation overflow without changing stored bindings or tombstones", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  const binding = store.putBinding(makeBinding());
  const channel = store.putChannelBinding(makeChannel(), { ownerKey: OWNER, expectedGeneration: 0 });
  const observer = fixture.raw();
  const maximumBinding = { ...binding, binding_generation: Number.MAX_SAFE_INTEGER };
  const maximumChannel = { ...channel, generation: Number.MAX_SAFE_INTEGER };
  observer.prepare("UPDATE conversation_bindings SET binding_generation = ?, record_json = ? WHERE binding_id = ?")
    .run(Number.MAX_SAFE_INTEGER, JSON.stringify(maximumBinding), binding.binding_id);
  observer.prepare("UPDATE channel_bindings SET generation = ?, record_json = ? WHERE window_key = ?")
    .run(Number.MAX_SAFE_INTEGER, JSON.stringify(maximumChannel), channel.window_key);
  assert.deepEqual(store.putBinding(maximumBinding, { expectedGeneration: Number.MAX_SAFE_INTEGER }), maximumBinding);
  expectCoreError(() => store.putBinding({ ...maximumBinding, evidence: "changed" }, { expectedGeneration: Number.MAX_SAFE_INTEGER }));
  expectCoreError(() => store.putChannelBinding(channel, { ownerKey: OWNER, expectedGeneration: Number.MAX_SAFE_INTEGER }));
  expectCoreError(() => store.deleteChannelBinding(channel.window_key, { ownerKey: OWNER, expectedGeneration: Number.MAX_SAFE_INTEGER }));
  assert.deepEqual(store.getBinding(binding.binding_id), maximumBinding);
  assert.deepEqual(store.getChannelBinding(channel.window_key), maximumChannel);
});

test("binds SQL-like text as values and fails closed for every directory API", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  const unusual = "x'); DROP TABLE messages; --";
  const binding = store.putBinding(makeBinding(unusual));
  const channel = store.putChannelBinding(makeChannel(unusual), { ownerKey: unusual, expectedGeneration: 0 });
  assert.deepEqual(store.getBinding(unusual), binding);
  assert.deepEqual(store.findBindingByIdentity(identityKey(binding)), binding);
  assert.deepEqual(store.getChannelBinding(unusual), channel);
  assert.deepEqual(store.listChannelBindings({ ownerKey: unusual }), [channel]);
  assert.equal(store.getBinding("missing"), null);
  assert.equal(store.getChannelBinding("missing"), null);
  store.close();
  for (const operation of [
    () => store.getBinding(unusual), () => store.findBindingByIdentity(identityKey(binding)),
    () => store.putBinding(binding), () => store.listBindings(), () => store.getChannelBinding(unusual),
    () => store.putChannelBinding(channel, { ownerKey: unusual, expectedGeneration: 1 }),
    () => store.deleteChannelBinding(unusual, { ownerKey: unusual, expectedGeneration: 1 }),
    () => store.listChannelBindings({ ownerKey: unusual }),
  ]) expectCoreError(operation, "store_closed");
  assert.deepEqual(fixture.open().getBinding(unusual), binding);
});
