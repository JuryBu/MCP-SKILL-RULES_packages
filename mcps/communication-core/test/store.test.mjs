import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoreError, digest, identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

const CREATED_AT = "2026-11-14T17:30:00.000Z";
const UPDATED_AT = "2026-11-14T17:31:00.000Z";
const SOURCE = { machine_id: "test-source", host: "codex", surface: "desktop", conversation_id: "source-chat" };
const TARGET = { machine_id: "test-target", host: "codex", surface: "desktop", conversation_id: "target-chat" };

function makeMessage(messageId = "message-1", overrides = {}) {
  const envelope = {
    caller: SOURCE,
    target: { ...TARGET, binding_id: "test-binding", binding_generation: 1 },
    text: "仅限隔离测试的消息",
    attachment_refs: ["test:attachment"],
  };
  return {
    message_id: messageId,
    source_key: identityKey(SOURCE),
    target_key: identityKey(TARGET),
    dedupe_key: `dedupe:${messageId}`,
    payload_hash: digest(envelope),
    envelope,
    created_at: CREATED_AT,
    delivery_status: "prepared",
    ...overrides,
  };
}

function makeDelivery(deliveryId = "delivery-1", messageId = "message-1", overrides = {}) {
  return {
    delivery_id: deliveryId,
    message_id: messageId,
    target_key: identityKey(TARGET),
    status: "prepared",
    attempt_count: 0,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function createFixture(context, databaseName = "存储 fixture.sqlite") {
  const directory = mkdtempSync(join(tmpdir(), "communication-core-store-"));
  const filePath = join(directory, databaseName);
  const stores = [];
  context.after(() => {
    try {
      for (const store of stores) store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const open = () => {
    const store = new MessageStore({ filePath });
    stores.push(store);
    return store;
  };
  return { filePath, directory, open, store: open() };
}

function expectCoreError(callback, code = "invalid_input") {
  assert.throws(callback, error => error instanceof CoreError && error.code === code);
}

test("requires an explicit persistent file path", () => {
  for (const options of [undefined, {}, { filePath: "" }, { filePath: ":memory:" }]) {
    expectCoreError(() => new MessageStore(options));
  }
});

test("optional multi-recipient ledger commits with child receipts and preserves the original batch on retry", context => {
  const { open } = createFixture(context);
  const first = open();
  const ledger = first.openMessageBatches();
  const original = { batch_id: "fixture-group", source_key: identityKey(SOURCE), dedupe_key: "fixture-batch",
    batch_payload_hash: digest("fixed list and text"), created_at: CREATED_AT,
    receipts: [{ message_id: "fixture-child", delivery_id: "fixture-child-delivery" }] };
  assert.throws(() => first.transaction(() => {
    ledger.insert(original);
    first.insertMessage(makeMessage("fixture-child"));
    first.insertDelivery(makeDelivery("fixture-child-delivery", "fixture-child"));
    throw new Error("fixture transaction interrupted");
  }), /fixture transaction interrupted/);
  first.close();
  const reopened = open();
  const recovered = reopened.openMessageBatches();
  assert.equal(recovered.find(original.source_key, original.dedupe_key), null);
  assert.equal(reopened.getMessage("fixture-child"), null);
  assert.equal(reopened.getDelivery("fixture-child-delivery"), null);
  reopened.transaction(() => {
    assert.equal(recovered.insert(original).duplicate, false);
    reopened.insertMessage(makeMessage("fixture-child"));
    reopened.insertDelivery(makeDelivery("fixture-child-delivery", "fixture-child"));
  });
  const duplicate = recovered.insert({ ...original, batch_id: "fixture-other-id" });
  assert.deepEqual(duplicate, { duplicate: true, record: original });
  assert.throws(() => recovered.insert({ ...original, batch_payload_hash: digest("changed recipients") }), { code: "dedupe_conflict" });
  assert.equal(reopened.getDeliveryForMessage(original.receipts[0].message_id).delivery_id, "fixture-child-delivery");
});

test("a relay processing acknowledgement shares the local commit and recovers uncertain sends only by their original attempt", context => {
  const { open } = createFixture(context);
  let clock = Date.parse(CREATED_AT);
  let store = open();
  let relay = store.openRelayAcknowledgements({ now: () => clock });
  const locallyReceived = "fixture-inbound-message";
  const route = {
    local_message_id: locallyReceived, origin_relay_id: "fixture-relay-entry", origin_message_id: "fixture-remote-message",
    from_machine: SOURCE.machine_id, reply_relay_key: "fixture-draining-group", reply_group_id: "fixture-group",
    reply_route_generation: 3, target_key: identityKey(TARGET),
  };
  assert.throws(() => relay.bindInbound(route), { code: "delivery_mismatch" });
  store.insertMessage(makeMessage(locallyReceived));
  assert.throws(() => relay.bindInbound({ ...route, from_machine: "fixture-wrong-source" }), { code: "delivery_mismatch" });
  assert.deepEqual(relay.bindInbound(route), route);
  assert.deepEqual(relay.bindInbound(route), route);
  assert.throws(() => relay.bindInbound({ ...route, reply_route_generation: 4 }), { code: "relay_route_changed" });

  assert.throws(() => store.transaction(() => {
    store.updateMessage(locallyReceived, { processing: "processing" });
    assert.equal(relay.stageProcessing(locallyReceived, "processing").ack_seq, 1);
    throw new Error("fixture rolls back both writes");
  }), /rolls back both/);
  assert.equal(store.getMessage(locallyReceived).processing, "pending");
  assert.deepEqual(relay.ready(), []);
  const first = store.transaction(() => {
    store.updateMessage(locallyReceived, { processing: "processing" });
    return relay.stageProcessing(locallyReceived, "processing");
  });
  assert.equal(first.ack_seq, 1);
  assert.equal(first.reply_route_generation, 3);
  assert.equal(relay.stageProcessing(locallyReceived, "processing"), null);
  assert.equal(relay.claim(first.event_id).attempt, 1);
  assert.equal(relay.claim(first.event_id), null);
  assert.equal(relay.settle(first.event_id, 1, "failed_before_send"), true);
  assert.deepEqual(relay.ready(), []);
  clock += 1000;
  assert.equal(relay.claim(first.event_id).attempt, 2);
  assert.equal(relay.settle(first.event_id, 1, "accepted"), false);

  store.close();
  store = open();
  relay = store.openRelayAcknowledgements({ now: () => clock });
  assert.equal(relay.recoverInterrupted(), 1);
  assert.equal(relay.read(first.event_id).state, "unknown");
  assert.equal(relay.claim(first.event_id), null);
  assert.equal(relay.settle(first.event_id, 2, "failed_before_send"), false);
  assert.equal(relay.settle(first.event_id, 2, "accepted"), true);
  assert.equal(relay.read(first.event_id).state, "sent");
  const second = store.transaction(() => {
    store.updateMessage(locallyReceived, { processing: "done" });
    return relay.stageProcessing(locallyReceived, "done");
  });
  assert.equal(second.ack_seq, 2);
  assert.equal(second.reply_group_id, route.reply_group_id);
  assert.deepEqual(relay.ready().map(item => item.event_id), [second.event_id]);
  assert.throws(() => relay.stageProcessing(locallyReceived, "processing"), { code: "processing_conflict" });
});

test("enables WAL, FULL synchronous writes and foreign keys on its connection", context => {
  const originalExec = DatabaseSync.prototype.exec;
  const settings = [];
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (sql.includes("PRAGMA synchronous = FULL")) {
      settings.push({
        synchronous: this.prepare("PRAGMA synchronous").get().synchronous,
        foreignKeys: this.prepare("PRAGMA foreign_keys").get().foreign_keys,
      });
    }
    return result;
  };
  let fixture;
  try {
    fixture = createFixture(context);
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.deepEqual(settings, [{ synchronous: 2, foreignKeys: 1 }]);
  const observer = new DatabaseSync(fixture.filePath);
  try {
    assert.equal(observer.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    observer.close();
  }
});

test("creates only the explicitly selected nested path and closes cleanly", context => {
  const fixture = createFixture(context, join("中文 子目录", "消息.sqlite"));
  fixture.store.insertMessage(makeMessage());
  fixture.store.close();
  assert.deepEqual(readdirSync(join(fixture.directory, "中文 子目录")), ["消息.sqlite"]);
  assert.equal(fixture.open().getMessage("message-1").message_id, "message-1");
});

test("constructor failures roll back schema work and close the failed connection", context => {
  const fixture = createFixture(context);
  fixture.store.close();
  const originalExec = DatabaseSync.prototype.exec;
  const failure = new Error("injected initialization failure");
  let failedConnection;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS messages")) {
      failedConnection = this;
      originalExec.call(this, "BEGIN IMMEDIATE; CREATE TABLE initialization_probe (value TEXT) STRICT;");
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
  const observer = new DatabaseSync(fixture.filePath);
  try {
    assert.equal(observer.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get("initialization_probe"), undefined);
  } finally {
    observer.close();
  }
  assert.equal(fixture.open().insertMessage(makeMessage()).message_id, "message-1");
});

test("persists messages, deliveries, observations, evidence and events after close/reopen", context => {
  const fixture = createFixture(context);
  const message = fixture.store.insertMessage(makeMessage());
  assert.equal(message.processing, "pending");
  assert.equal(message.model_observed, "unknown");
  assert.equal(message.ui_observed, "unknown");
  fixture.store.insertDelivery(makeDelivery());
  fixture.store.transaction(() => {
    fixture.store.updateMessage("message-1", {
      delivery_status: "accepted", processing: "pending", model_observed: "observed",
      ui_observed: "unknown", evidence: { observed: ["model-boundary"] }, updated_at: UPDATED_AT,
    });
    fixture.store.updateDelivery("delivery-1", {
      status: "accepted", attempt_count: 1, updated_at: UPDATED_AT,
      evidence: { accepted_id: "isolated-acceptance" }, error: null,
    });
    fixture.store.appendEvent("message-1", "accepted", { receipt: ["local-only"] });
  });
  const expectedMessage = fixture.store.getMessage("message-1");
  const expectedDelivery = fixture.store.getDelivery("delivery-1");
  const expectedEvents = fixture.store.eventsAfter("message-1");
  fixture.store.close();
  const reopened = fixture.open();
  assert.deepEqual(reopened.getMessage("message-1"), expectedMessage);
  assert.deepEqual(reopened.findMessageByDedupe(message.source_key, message.dedupe_key), expectedMessage);
  assert.deepEqual(reopened.getDelivery("delivery-1"), expectedDelivery);
  assert.deepEqual(reopened.getDeliveryForMessage("message-1"), expectedDelivery);
  assert.deepEqual(reopened.eventsAfter("message-1"), expectedEvents);
  assert.equal(reopened.lastSequence("message-1"), 1);
  assert.equal(reopened.appendEvent("message-1", "reopened").sequence, 2);
});

test("returns null or empty queries for missing records", context => {
  const { store } = createFixture(context);
  assert.equal(store.getMessage("missing"), null);
  assert.equal(store.findMessageByDedupe("missing", "missing"), null);
  assert.equal(store.getDelivery("missing"), null);
  assert.equal(store.getDeliveryForMessage("missing"), null);
  assert.equal(store.updateMessage("missing", { processing: "done" }), null);
  assert.equal(store.updateDelivery("missing", { status: "accepted" }), null);
  assert.deepEqual(store.listDeliveries(), []);
  assert.deepEqual(store.eventsAfter("missing"), []);
  assert.equal(store.lastSequence("missing"), 0);
});

test("enforces message identity and source-scoped dedupe uniqueness without overwriting", context => {
  const { store } = createFixture(context);
  const original = store.insertMessage(makeMessage());
  assert.throws(() => store.insertMessage(makeMessage("message-1", { dedupe_key: "other-dedupe" })), /UNIQUE/);
  assert.throws(() => store.insertMessage(makeMessage("other-message", { dedupe_key: original.dedupe_key })), /UNIQUE/);
  assert.throws(() => store.insertMessage(makeMessage("other-message", {
    dedupe_key: original.dedupe_key, target_key: "other-target", payload_hash: "other-hash",
  })), /UNIQUE/);
  const otherSource = identityKey({ ...SOURCE, conversation_id: "other-source" });
  store.insertMessage(makeMessage("other-message", { source_key: otherSource, dedupe_key: original.dedupe_key }));
  assert.equal(store.findMessageByDedupe(otherSource, original.dedupe_key).message_id, "other-message");
  assert.deepEqual(store.getMessage("message-1"), original);
});

test("enforces delivery identity, one delivery per message and message foreign keys", context => {
  const { store } = createFixture(context);
  assert.throws(() => store.insertDelivery(makeDelivery()), /FOREIGN KEY/);
  assert.throws(() => store.appendEvent("message-1", "missing-parent"), /FOREIGN KEY/);
  store.insertMessage(makeMessage());
  store.insertMessage(makeMessage("message-2"));
  const original = store.insertDelivery(makeDelivery());
  assert.throws(() => store.insertDelivery(makeDelivery("delivery-2", "message-1")), /UNIQUE/);
  assert.throws(() => store.insertDelivery(makeDelivery("delivery-1", "message-2")), /UNIQUE/);
  assert.deepEqual(store.getDelivery("delivery-1"), original);
  assert.equal(store.insertDelivery(makeDelivery("delivery-2", "message-2")).message_id, "message-2");
  assert.equal(store.appendEvent("message-1", "parent-now-exists").sequence, 1);
});

test("keeps stored objects detached from input, insert/update results and every query", context => {
  const { store } = createFixture(context);
  const input = makeMessage();
  const inserted = store.insertMessage(input);
  input.envelope.text = "input mutation";
  inserted.envelope.attachment_refs.push("result mutation");
  assert.equal(store.getMessage("message-1").envelope.text, "仅限隔离测试的消息");
  assert.deepEqual(store.getMessage("message-1").envelope.attachment_refs, ["test:attachment"]);
  const patch = { evidence: { details: ["original"] } };
  const updated = store.updateMessage("message-1", patch);
  patch.evidence.details.push("patch mutation");
  updated.evidence.details.push("update result mutation");
  for (const message of [store.getMessage("message-1"), store.findMessageByDedupe(inserted.source_key, inserted.dedupe_key)]) {
    assert.deepEqual(message.evidence.details, ["original"]);
    message.evidence.details.push("query mutation");
  }
  const deliveryInput = makeDelivery("delivery-1", "message-1", { evidence: { details: ["delivery"] } });
  const deliveryInserted = store.insertDelivery(deliveryInput);
  deliveryInput.evidence.details.push("input mutation");
  deliveryInserted.evidence.details.push("insert result mutation");
  const deliveryPatch = { evidence: { details: ["changed"] } };
  const deliveryUpdated = store.updateDelivery("delivery-1", deliveryPatch);
  deliveryPatch.evidence.details.push("patch mutation");
  deliveryUpdated.evidence.details.push("update result mutation");
  for (const delivery of [store.getDelivery("delivery-1"), store.getDeliveryForMessage("message-1"), ...store.listDeliveries()]) {
    assert.deepEqual(delivery.evidence.details, ["changed"]);
    delivery.evidence.details.push("query mutation");
  }
  assert.deepEqual(store.getDelivery("delivery-1").evidence.details, ["changed"]);
  const data = { nested: ["event"] };
  const event = store.appendEvent("message-1", "example", data);
  data.nested.push("input mutation");
  event.data.nested.push("result mutation");
  store.eventsAfter("message-1")[0].data.nested.push("query mutation");
  assert.deepEqual(store.eventsAfter("message-1")[0].data.nested, ["event"]);
});

test("rejects immutable and unknown patch fields atomically", context => {
  const { store } = createFixture(context);
  const originalMessage = store.insertMessage(makeMessage());
  const originalDelivery = store.insertDelivery(makeDelivery());
  for (const field of ["message_id", "source_key", "target_key", "dedupe_key", "payload_hash", "envelope", "created_at", "identity", "unexpected"]) {
    expectCoreError(() => store.updateMessage("message-1", { processing: "changed", [field]: "forbidden" }));
  }
  for (const field of ["delivery_id", "message_id", "target_key", "created_at", "envelope", "payload_hash", "identity", "unexpected"]) {
    expectCoreError(() => store.updateDelivery("delivery-1", { status: "changed", [field]: "forbidden" }));
  }
  for (const patch of [null, [], "status", 1]) {
    expectCoreError(() => store.updateMessage("message-1", patch));
    expectCoreError(() => store.updateDelivery("delivery-1", patch));
  }
  assert.deepEqual(store.getMessage("message-1"), originalMessage);
  assert.deepEqual(store.getDelivery("delivery-1"), originalDelivery);
});

test("stores arbitrary status names without applying a business state machine", context => {
  const { store } = createFixture(context);
  store.insertMessage(makeMessage());
  store.insertDelivery(makeDelivery());
  for (const status of ["prepared", "dispatching", "accepted", "failed_before_send", "unknown", "expired", "unsupported", "future-status"]) {
    assert.equal(store.updateMessage("message-1", { delivery_status: status }).delivery_status, status);
    assert.equal(store.updateDelivery("delivery-1", { status }).status, status);
    assert.equal(store.listDeliveries({ statuses: [status] })[0].status, status);
  }
  store.updateMessage("message-1", { error: { code: "local" }, last_error: "earlier", evidence: ["message"] });
  store.updateDelivery("delivery-1", { error: null, last_error: { code: "local" }, evidence: ["delivery"] });
  assert.deepEqual(store.getDelivery("delivery-1").evidence, ["delivery"]);
});

test("validates the serialized patch as well as its original keys", context => {
  const { store } = createFixture(context);
  const originalMessage = store.insertMessage(makeMessage());
  const originalDelivery = store.insertDelivery(makeDelivery());
  const messagePatch = Object.create({ toJSON: () => ({ envelope: { text: "replacement" } }) });
  messagePatch.processing = "changed";
  const deliveryPatch = Object.create({ toJSON: () => ({ message_id: "replacement" }) });
  deliveryPatch.status = "changed";
  expectCoreError(() => store.updateMessage("message-1", messagePatch));
  expectCoreError(() => store.updateDelivery("delivery-1", deliveryPatch));
  assert.deepEqual(store.getMessage("message-1"), originalMessage);
  assert.deepEqual(store.getDelivery("delivery-1"), originalDelivery);
});

test("rolls back inserted records, changed records and events together and stays usable", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  const originalMessage = store.insertMessage(makeMessage());
  const originalDelivery = store.insertDelivery(makeDelivery());
  const firstEvent = store.appendEvent("message-1", "before");
  const failure = new Error("abort this transaction");
  assert.throws(() => store.transaction(() => {
    store.updateMessage("message-1", { processing: "changed" });
    store.updateDelivery("delivery-1", { status: "unknown", attempt_count: 3 });
    store.appendEvent("message-1", "rolled-back", { nested: ["must disappear"] });
    store.insertMessage(makeMessage("message-2"));
    store.insertDelivery(makeDelivery("delivery-2", "message-2"));
    store.appendEvent("message-2", "rolled-back-new-message");
    throw failure;
  }), error => error === failure);
  assert.deepEqual(store.getMessage("message-1"), originalMessage);
  assert.deepEqual(store.getDelivery("delivery-1"), originalDelivery);
  assert.deepEqual(store.eventsAfter("message-1"), [firstEvent]);
  assert.equal(store.lastSequence("message-1"), 1);
  assert.equal(store.getMessage("message-2"), null);
  assert.equal(store.getDelivery("delivery-2"), null);
  assert.deepEqual(store.eventsAfter("message-2"), []);
  assert.equal(store.transaction(() => {
    store.insertMessage(makeMessage("message-2"));
    store.insertDelivery(makeDelivery("delivery-2", "message-2"));
    return store.appendEvent("message-1", "after-rollback").sequence;
  }), 2);
  store.close();
  assert.equal(fixture.open().getDelivery("delivery-2").status, "prepared");
});

test("SQL uniqueness failure rolls back previous writes and leaves the store usable", context => {
  const { store } = createFixture(context);
  store.insertMessage(makeMessage());
  assert.throws(() => store.transaction(() => {
    store.insertMessage(makeMessage("message-2"));
    store.appendEvent("message-1", "must-roll-back");
    store.insertMessage(makeMessage("message-3", { dedupe_key: "dedupe:message-1" }));
  }), /UNIQUE/);
  assert.equal(store.getMessage("message-2"), null);
  assert.equal(store.lastSequence("message-1"), 0);
  assert.equal(store.transaction(() => store.insertMessage(makeMessage("message-2"))).message_id, "message-2");
});

test("nested transaction savepoints isolate caught inner failures and follow outer rollback", context => {
  const { store } = createFixture(context);
  store.insertMessage(makeMessage());
  const result = store.transaction(() => {
    store.appendEvent("message-1", "outer-before");
    assert.throws(() => store.transaction(() => {
      store.updateMessage("message-1", { processing: "inner-change" });
      store.appendEvent("message-1", "inner-rollback");
      throw new Error("inner failure");
    }), /inner failure/);
    assert.equal(store.getMessage("message-1").processing, "pending");
    return store.appendEvent("message-1", "outer-after").sequence;
  });
  assert.equal(result, 2);
  assert.deepEqual(store.eventsAfter("message-1").map(event => event.kind), ["outer-before", "outer-after"]);
  assert.throws(() => store.transaction(() => {
    store.transaction(() => store.updateMessage("message-1", { processing: "inner-committed" }));
    throw new Error("outer failure");
  }), /outer failure/);
  assert.equal(store.getMessage("message-1").processing, "pending");
});

test("rejects asynchronous callbacks and rolls back thenable results", async context => {
  const { store } = createFixture(context);
  let asyncCallbackRan = false;
  expectCoreError(() => store.transaction(async () => {
    asyncCallbackRan = true;
    store.insertMessage(makeMessage());
  }));
  assert.equal(asyncCallbackRan, false);
  for (const callback of [null, {}, 1]) expectCoreError(() => store.transaction(callback));
  expectCoreError(() => store.transaction(() => {
    store.insertMessage(makeMessage());
    return Promise.resolve("not synchronous");
  }));
  expectCoreError(() => store.transaction(() => {
    store.insertMessage(makeMessage());
    return Promise.reject(new Error("rejection must be consumed"));
  }));
  assert.equal(store.getMessage("message-1"), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.transaction(() => "still usable"), "still usable");
});

test("sequences and cursor pages are scoped to one message and strictly ordered", context => {
  const { store } = createFixture(context);
  store.insertMessage(makeMessage("first"));
  store.insertMessage(makeMessage("second"));
  store.transaction(() => {
    for (let eventIndex = 0; eventIndex < 7; eventIndex += 1) {
      store.appendEvent("first", "first-event", { eventIndex });
      store.appendEvent("second", "second-event", { eventIndex });
    }
  });
  assert.equal(store.lastSequence("first"), 7);
  assert.equal(store.lastSequence("second"), 7);
  const collected = [];
  let cursor = 0;
  while (true) {
    const page = store.eventsAfter("first", cursor, 2);
    if (!page.length) break;
    assert.ok(page.every(event => event.message_id === "first"));
    collected.push(...page);
    cursor = page.at(-1).sequence;
  }
  assert.deepEqual(collected.map(event => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(collected.every(event => Number.isFinite(Date.parse(event.created_at))));
  assert.deepEqual(store.eventsAfter("first", 7), []);
  assert.deepEqual(store.eventsAfter("first", Number.MAX_SAFE_INTEGER), []);
});

test("delivery listing filters statuses and orders by ID independently of creation time", context => {
  const { store } = createFixture(context);
  store.transaction(() => {
    for (const delivery of [
      makeDelivery("delivery-c", "message-c", { status: "unknown" }),
      makeDelivery("delivery-b", "message-b", { status: "prepared" }),
      makeDelivery("delivery-a", "message-a", { status: "unknown", created_at: UPDATED_AT }),
    ]) {
      store.insertMessage(makeMessage(delivery.message_id));
      store.insertDelivery(delivery);
    }
  });
  assert.deepEqual(store.listDeliveries().map(delivery => delivery.delivery_id), ["delivery-a", "delivery-b", "delivery-c"]);
  assert.deepEqual(store.listDeliveries({ statuses: ["unknown"], limit: 1 }).map(delivery => delivery.delivery_id), ["delivery-a"]);
  assert.equal(store.listDeliveries({ statuses: ["prepared", "unknown"] }).length, 3);
  assert.deepEqual(store.listDeliveries({ after_id: "delivery-a" }).map(delivery => delivery.delivery_id), ["delivery-b", "delivery-c"]);
  assert.deepEqual(store.listDeliveries({ statuses: ["unknown"], after_id: "delivery-a" }).map(delivery => delivery.delivery_id), ["delivery-c"]);
  assert.deepEqual(store.listDeliveries({ after_id: "delivery-b-middle" }).map(delivery => delivery.delivery_id), ["delivery-c"]);
  assert.deepEqual(store.listDeliveries({ after_id: "delivery-c" }), []);
  assert.deepEqual(store.listDeliveries({ statuses: [] }), []);
  assert.deepEqual(store.listDeliveries({ statuses: ["missing"] }), []);
  store.updateDelivery("delivery-a", { status: "accepted" });
  assert.deepEqual(store.listDeliveries({ statuses: ["unknown"] }).map(delivery => delivery.delivery_id), ["delivery-c"]);
});

test("delivery keyset pages remain complete while processed rows leave the status filter", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  const identifiers = ["delta", "alpha", "foxtrot", "bravo", "echo", "charlie"];
  store.transaction(() => {
    for (const identifier of identifiers) {
      store.insertMessage(makeMessage(`message-${identifier}`));
      store.insertDelivery(makeDelivery(identifier, `message-${identifier}`));
    }
  });
  const expected = identifiers.toSorted();
  const collected = [];
  let afterId;
  while (true) {
    const page = store.listDeliveries({ statuses: ["prepared"], limit: 2, after_id: afterId });
    if (!page.length) break;
    assert.ok(page.length <= 2);
    for (const delivery of page) {
      collected.push(delivery.delivery_id);
      store.updateDelivery(delivery.delivery_id, { status: "dispatching" });
    }
    afterId = page.at(-1).delivery_id;
  }
  assert.deepEqual(collected, expected);
  assert.equal(new Set(collected).size, expected.length);
  assert.deepEqual(store.listDeliveries({ statuses: ["prepared"] }), []);
  assert.deepEqual(store.listDeliveries({ statuses: ["dispatching"] }).map(delivery => delivery.delivery_id), expected);
  store.close();
  assert.deepEqual(fixture.open().listDeliveries({ after_id: "bravo", limit: 2 })
    .map(delivery => delivery.delivery_id), ["charlie", "delta"]);
});

test("delivery keyset pages use an exclusive cursor and avoid offset shifts after inserts", context => {
  const { store } = createFixture(context);
  for (const identifier of ["delivery-10", "delivery-30", "delivery-20"]) {
    store.insertMessage(makeMessage(`message-${identifier}`));
    store.insertDelivery(makeDelivery(identifier, `message-${identifier}`));
  }
  const firstPage = store.listDeliveries({ limit: 2 });
  assert.deepEqual(firstPage.map(delivery => delivery.delivery_id), ["delivery-10", "delivery-20"]);
  for (const identifier of ["delivery-00", "delivery-25"]) {
    store.insertMessage(makeMessage(`message-${identifier}`));
    store.insertDelivery(makeDelivery(identifier, `message-${identifier}`));
  }
  const secondPage = store.listDeliveries({ after_id: firstPage.at(-1).delivery_id, limit: 2 });
  assert.deepEqual(secondPage.map(delivery => delivery.delivery_id), ["delivery-25", "delivery-30"]);
  assert.deepEqual(store.listDeliveries({ after_id: secondPage.at(-1).delivery_id, limit: 2 }), []);
  assert.deepEqual(store.listDeliveries({ after_id: "delivery-20", limit: 2 }), secondPage);
});

test("caps default pages at 100, permits 1000 and rejects invalid or unbounded requests", context => {
  const { store } = createFixture(context);
  store.insertMessage(makeMessage("events"));
  store.transaction(() => {
    for (let recordIndex = 0; recordIndex < 1001; recordIndex += 1) {
      const suffix = String(recordIndex).padStart(4, "0");
      store.insertMessage(makeMessage(`message-${suffix}`));
      store.insertDelivery(makeDelivery(`delivery-${suffix}`, `message-${suffix}`));
      store.appendEvent("events", "bounded", { recordIndex });
    }
  });
  assert.equal(store.listDeliveries().length, 100);
  assert.equal(store.listDeliveries({ limit: 1000 }).length, 1000);
  assert.equal(store.listDeliveries({ after_id: "delivery-0999", limit: 1000 }).length, 1);
  assert.equal(store.eventsAfter("events").length, 100);
  assert.equal(store.eventsAfter("events", 0, 1000).length, 1000);
  assert.equal(store.eventsAfter("events", 1000, 1000).length, 1);
  for (const limit of [-1, 0, 1.5, 1001, Infinity, NaN, "100", null]) {
    expectCoreError(() => store.listDeliveries({ limit }));
    expectCoreError(() => store.eventsAfter("events", 0, limit));
  }
  for (const sequence of [-1, 1.5, Infinity, NaN, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => store.eventsAfter("events", sequence));
  }
  for (const statuses of ["prepared", null, [null], [""], Array(1001).fill("prepared")]) {
    expectCoreError(() => store.listDeliveries({ statuses }));
  }
  for (const afterId of [null, 1, {}, [], "", " "]) {
    expectCoreError(() => store.listDeliveries({ after_id: afterId }));
  }
});

test("binds SQL-like IDs, dedupe values, statuses, kinds and JSON data as values", context => {
  const { store } = createFixture(context);
  const unusual = "x'); DROP TABLE messages; --";
  const message = store.insertMessage(makeMessage(unusual, {
    source_key: unusual, target_key: unusual, dedupe_key: unusual,
    envelope: { text: unusual }, payload_hash: unusual,
  }));
  store.insertDelivery(makeDelivery(unusual, unusual, { status: unusual, target_key: unusual }));
  assert.deepEqual(store.getMessage(unusual), message);
  assert.deepEqual(store.findMessageByDedupe(unusual, unusual), message);
  assert.equal(store.listDeliveries({ statuses: [unusual] })[0].delivery_id, unusual);
  assert.deepEqual(store.listDeliveries({ after_id: unusual }), []);
  assert.equal(store.getDeliveryForMessage(unusual).message_id, unusual);
  assert.equal(store.appendEvent(unusual, unusual, { text: unusual }).kind, unusual);
  assert.equal(store.eventsAfter(unusual)[0].data.text, unusual);
  expectCoreError(() => store.updateMessage(unusual, JSON.parse('{"record_json = NULL; DROP TABLE messages; --":"x"}')));
  assert.equal(store.insertMessage(makeMessage("still-exists")).message_id, "still-exists");
});

test("rejects invalid records, counters and JSON without corrupting existing records", context => {
  const { store } = createFixture(context);
  const originalMessage = store.insertMessage(makeMessage());
  const originalDelivery = store.insertDelivery(makeDelivery());
  const circular = {};
  circular.self = circular;
  expectCoreError(() => store.insertMessage(makeMessage("circular", { envelope: circular })));
  expectCoreError(() => store.insertDelivery(makeDelivery("bigint", "message-1", { evidence: { value: 1n } })));
  for (const record of [null, [], "message"]) expectCoreError(() => store.insertMessage(record));
  for (const envelope of [null, [], "message"]) {
    expectCoreError(() => store.insertMessage(makeMessage("invalid", { envelope })));
  }
  for (const attemptCount of [-1, 1.5, null, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expectCoreError(() => store.updateDelivery("delivery-1", { status: "changed", attempt_count: attemptCount }));
  }
  expectCoreError(() => store.updateMessage("message-1", { delivery_status: "" }));
  expectCoreError(() => store.updateMessage("message-1", { evidence: circular }));
  expectCoreError(() => store.updateDelivery("delivery-1", { evidence: circular }));
  expectCoreError(() => store.appendEvent("message-1", "circular", circular));
  expectCoreError(() => store.appendEvent("message-1", ""));
  assert.deepEqual(store.getMessage("message-1"), originalMessage);
  assert.deepEqual(store.getDelivery("delivery-1"), originalDelivery);
  assert.equal(store.lastSequence("message-1"), 0);
  assert.equal(store.appendEvent("message-1", "after-invalid-input").sequence, 1);
});

test("separate connections see committed changes, retain uniqueness and recover from lock failures", context => {
  const fixture = createFixture(context);
  const first = fixture.store;
  const second = fixture.open();
  first.insertMessage(makeMessage());
  assert.equal(second.getMessage("message-1").message_id, "message-1");
  assert.throws(() => second.insertMessage(makeMessage("duplicate", { dedupe_key: "dedupe:message-1" })), /UNIQUE/);
  first.transaction(() => {
    first.insertMessage(makeMessage("uncommitted"));
    assert.equal(second.getMessage("uncommitted"), null);
    assert.throws(() => second.transaction(() => second.insertMessage(makeMessage("blocked"))), /locked/);
  });
  assert.equal(second.getMessage("uncommitted").message_id, "uncommitted");
  assert.equal(second.transaction(() => second.insertMessage(makeMessage("blocked"))).message_id, "blocked");
  first.appendEvent("message-1", "first-connection");
  assert.equal(second.appendEvent("message-1", "second-connection").sequence, 2);
  assert.equal(first.lastSequence("message-1"), 2);
});

test("close is idempotent, rejects active transactions and fails closed afterward", context => {
  const fixture = createFixture(context);
  const { store } = fixture;
  store.insertMessage(makeMessage());
  assert.throws(() => store.transaction(() => {
    store.updateMessage("message-1", { processing: "changed" });
    store.close();
  }), error => error instanceof CoreError && error.code === "store_transaction_active");
  assert.equal(store.getMessage("message-1").processing, "pending");
  store.close();
  store.close();
  for (const operation of [
    () => store.getMessage("message-1"), () => store.findMessageByDedupe("source", "dedupe"),
    () => store.insertMessage(makeMessage()), () => store.updateMessage("message-1", {}),
    () => store.getDelivery("delivery-1"), () => store.getDeliveryForMessage("message-1"),
    () => store.insertDelivery(makeDelivery()), () => store.updateDelivery("delivery-1", {}),
    () => store.listDeliveries(), () => store.appendEvent("message-1", "closed"),
    () => store.eventsAfter("message-1"), () => store.lastSequence("message-1"),
    () => store.transaction(() => {}),
  ]) expectCoreError(operation, "store_closed");
  assert.equal(fixture.open().getMessage("message-1").processing, "pending");
});
