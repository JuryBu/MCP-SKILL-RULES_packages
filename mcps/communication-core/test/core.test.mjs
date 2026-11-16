import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommunicationCore } from "../src/core.mjs";
import { decodeCursor, encodeCursor, identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

class StubStore {
  constructor(snapshot) {
    this.state = snapshot ? copy(snapshot) : { messages: {}, deliveries: {}, events: {} };
    this.closed = false;
  }

  transaction(callback) {
    const before = copy(this.state);
    try {
      const result = callback();
      assert.equal(typeof result?.then, "undefined");
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    }
  }

  getMessage(messageId) {
    return this.state.messages[messageId] ? copy(this.state.messages[messageId]) : null;
  }

  findMessageByDedupe(sourceKey, dedupeKey) {
    const message = Object.values(this.state.messages).find(record => record.source_key === sourceKey && record.dedupe_key === dedupeKey);
    return message ? copy(message) : null;
  }

  insertMessage(record) {
    assert.equal(this.getMessage(record.message_id), null);
    assert.equal(this.findMessageByDedupe(record.source_key, record.dedupe_key), null);
    this.state.messages[record.message_id] = copy(record);
  }

  updateMessage(messageId, patch) {
    assert.ok(this.getMessage(messageId));
    this.state.messages[messageId] = { ...this.state.messages[messageId], ...copy(patch) };
  }

  getDelivery(deliveryId) {
    return this.state.deliveries[deliveryId] ? copy(this.state.deliveries[deliveryId]) : null;
  }

  getDeliveryForMessage(messageId) {
    const delivery = Object.values(this.state.deliveries).find(record => record.message_id === messageId);
    return delivery ? copy(delivery) : null;
  }

  insertDelivery(record) {
    assert.ok(this.getMessage(record.message_id));
    assert.equal(this.getDelivery(record.delivery_id), null);
    assert.equal(this.getDeliveryForMessage(record.message_id), null);
    this.state.deliveries[record.delivery_id] = copy(record);
  }

  updateDelivery(deliveryId, patch) {
    assert.ok(this.getDelivery(deliveryId));
    assert.ok(Object.keys(patch).every(key => ["status", "attempt_count", "updated_at", "error", "last_error", "evidence"].includes(key)));
    this.state.deliveries[deliveryId] = { ...this.state.deliveries[deliveryId], ...copy(patch) };
  }

  listDeliveries({ statuses, limit = 100, after_id: afterId }) {
    assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000);
    return copy(Object.values(this.state.deliveries)
      .filter(record => statuses.includes(record.status) && (!afterId || record.delivery_id > afterId))
      .sort((left, right) => left.delivery_id < right.delivery_id ? -1 : left.delivery_id > right.delivery_id ? 1 : 0)
      .slice(0, limit));
  }

  appendEvent(messageId, kind, data = {}) {
    assert.ok(this.getMessage(messageId));
    const events = this.state.events[messageId] ?? [];
    this.state.events[messageId] = events;
    const event = { sequence: events.length + 1, message_id: messageId, kind, data: copy(data), created_at: new Date().toISOString() };
    events.push(event);
    return copy(event);
  }

  eventsAfter(messageId, sequence = 0, limit = 100) {
    return copy((this.state.events[messageId] ?? []).filter(event => event.sequence > sequence).slice(0, limit));
  }

  lastSequence(messageId) {
    return this.state.events[messageId]?.at(-1)?.sequence ?? 0;
  }

  close() {
    this.closed = true;
  }
}

const SOURCE = { machine_id: "development", host: "codex", surface: "desktop", conversation_id: "source" };
const RECEIVER = { machine_id: "development", host: "codex", surface: "desktop", conversation_id: "receiver" };
const OTHER = { machine_id: "development", host: "codex", surface: "desktop", conversation_id: "other" };
const SOURCE_CONTEXT = { principal_id: "source-principal" };
const RECEIVER_CONTEXT = { principal_id: "receiver-principal" };
const OTHER_CONTEXT = { principal_id: "other-principal" };

function adapterResult(request, outcome = "accepted", evidence = {}) {
  return { outcome, delivery_id: request.delivery.delivery_id, target_key: request.delivery.target_key, ...evidence };
}

async function fixture(testContext, options = {}) {
  const state = { now: Date.parse("2030-01-01T00:00:00Z"), calls: [], queries: [] };
  const targets = options.targets ?? [
    { ...RECEIVER, binding_id: "receiver-binding", binding_generation: 7, adapter_id: "test-adapter", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "isolated-test" },
    { ...SOURCE, binding_id: "source-binding", binding_generation: 3, adapter_id: "test-adapter", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "isolated-test" },
    { ...OTHER, binding_id: "other-binding", binding_generation: 2, adapter_id: "test-adapter", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "isolated-test" },
  ];
  const principals = options.principals ?? [
    { id: SOURCE_CONTEXT.principal_id, identity: SOURCE, allowed_targets: ["receiver-binding"], origin_kinds: ["agent_message"] },
    { id: RECEIVER_CONTEXT.principal_id, identity: RECEIVER, allowed_targets: ["source-binding"], origin_kinds: ["agent_message"] },
    { id: OTHER_CONTEXT.principal_id, identity: OTHER, allowed_targets: ["source-binding", "receiver-binding"], origin_kinds: ["agent_message"] },
  ];
  const store = options.store ?? new StubStore();
  const adapter = {
    async deliver(request) {
      state.calls.push(request);
      return options.deliver ? options.deliver(request, state, store) : adapterResult(request);
    },
    ...(options.query ? { async query(request) { state.queries.push(request); return options.query(request, state, store); } } : {}),
  };
  const core = new CommunicationCore({ store, targets, principals, adapters: { "test-adapter": adapter }, now: () => state.now, deliveryTimeoutMs: options.deliveryTimeoutMs ?? 100, maxConcurrent: options.maxConcurrent ?? 2 });
  testContext.after(() => core.close());
  if (options.start !== false) {
    await core.start();
    await core.drain();
  }
  return { core, store, state, targets, principals, adapter };
}

function sendInput(overrides = {}) {
  return {
    caller: copy(SOURCE),
    origin: { kind: "agent_message", channel: "communication", source_ref: "isolated-source" },
    target: { ...RECEIVER, binding_id: "receiver-binding", binding_generation: 7 },
    dedupe_key: "dedupe-1",
    text: "独立核心测试消息",
    expires_at: "2030-01-02T00:00:00Z",
    ...overrides,
  };
}

function replyInput(original, overrides = {}) {
  return sendInput({
    caller: copy(RECEIVER),
    target: { ...SOURCE, binding_id: "source-binding", binding_generation: 3 },
    dedupe_key: `reply-${original.message.message_id}`,
    in_reply_to: original.message.message_id,
    text: "回复内容",
    ...overrides,
  });
}

function ackInput(original, processing = "done", overrides = {}) {
  return { caller: copy(RECEIVER), message_id: original.message.message_id, delivery_id: original.delivery.delivery_id, binding_generation: 7, processing, ...overrides };
}

function errorCode(code) {
  return error => error.code === code;
}

async function sendAndObserve(core, context, input) {
  const sent = await core.sendMessage(context, input);
  await core.drain();
  const observed = await core.wait(context, { caller: input.caller, message_id: sent.message.message_id, after_cursor: sent.next_cursor, until: "any", wait_ms: 0 });
  return { ...core.getMessage(context, { caller: input.caller, message_id: sent.message.message_id }), duplicate: sent.duplicate, next_cursor: observed.next_cursor };
}

test("authenticate the trusted transport, caller, permission, generation and source kind", async testContext => {
  const { core, state, store } = await fixture(testContext);
  await assert.rejects(core.sendMessage({ principal_id: "missing" }, sendInput()), errorCode("unauthorized"));
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ caller: RECEIVER })), errorCode("caller_mismatch"));
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ target: { ...OTHER, binding_id: "other-binding", binding_generation: 2 } })), errorCode("forbidden"));
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ target: { ...RECEIVER, binding_id: "receiver-binding", binding_generation: 6 } })), errorCode("binding_changed"));
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ target: { ...OTHER, binding_id: "receiver-binding", binding_generation: 7 } })), errorCode("binding_changed"));
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ origin: { kind: "user_message", channel: "qq", source_ref: "unverified" } })), errorCode("source_unverified"));
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ caller: { ...SOURCE, machine_id: "another-machine" } })), errorCode("caller_mismatch"));
  assert.equal(state.calls.length, 0);
  assert.deepEqual(Object.keys(store.state.messages), []);
});

test("persist both records and the dispatch claim before invoking an adapter", async testContext => {
  const { core } = await fixture(testContext, { deliver(request, state, store) {
    assert.equal(store.getMessage(request.message.message_id).delivery_status, "dispatching");
    assert.equal(store.getDelivery(request.delivery.delivery_id).status, "dispatching");
    assert.equal(request.delivery.attempt_count, 1);
    assert.equal(request.target.binding_generation, 7);
    return adapterResult(request, "accepted", { proof: "transport-only" });
  } });
  const result = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(result.duplicate, false);
  assert.equal(result.delivery.status, "accepted");
  assert.equal(result.message.delivery_status, "accepted");
  assert.equal(result.message.processing, "pending");
  assert.equal(result.message.model_observed, "unknown");
  assert.equal(result.message.ui_observed, "unknown");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("a failed delivery insert rolls back the message and all events", async testContext => {
  const { core, store, state } = await fixture(testContext);
  store.insertDelivery = () => { throw new Error("injected-insert-failure"); };
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput()), /injected-insert-failure/);
  assert.deepEqual(store.state, { messages: {}, deliveries: {}, events: {} });
  assert.equal(state.calls.length, 0);
});

test("stable dedupe returns the original while changes conflict and copies remain isolated", async testContext => {
  const { core, state } = await fixture(testContext);
  const input = sendInput({ attachment_refs: ["local-reference"] });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, input);
  const duplicate = await sendAndObserve(core, SOURCE_CONTEXT, copy(input));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, first.message.message_id);
  assert.equal(duplicate.delivery.delivery_id, first.delivery.delivery_id);
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, { ...input, text: "changed" }), errorCode("dedupe_conflict"));
  input.attachment_refs.push("mutation");
  first.message.envelope.text = "mutation";
  duplicate.delivery.target_snapshot.conversation_id = "mutation";
  const stored = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: first.message.message_id });
  assert.equal(stored.message.envelope.text, "独立核心测试消息");
  assert.deepEqual(stored.message.envelope.attachment_refs, ["local-reference"]);
  assert.equal(stored.delivery.target_snapshot.conversation_id, "receiver");
  assert.equal(state.calls.length, 1);
});

test("dedupe is scoped to the complete source identity", async testContext => {
  const { core, state } = await fixture(testContext);
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const other = await sendAndObserve(core, OTHER_CONTEXT, sendInput({ caller: OTHER }));
  assert.notEqual(first.message.message_id, other.message.message_id);
  assert.equal(state.calls.length, 2);
});

test("simultaneous identical requests create one message and one write", async testContext => {
  const { core, state } = await fixture(testContext, { async deliver(request) { await delay(5); return adapterResult(request); } });
  const results = await Promise.all(Array.from({ length: 5 }, () => sendAndObserve(core, SOURCE_CONTEXT, sendInput())));
  assert.equal(new Set(results.map(result => result.message.message_id)).size, 1);
  assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(state.calls.length, 1);
});

test("a correct reference with the wrong reply author or target is rejected", async testContext => {
  const { core, store, principals } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  await assert.rejects(core.sendMessage(OTHER_CONTEXT, replyInput(original, { caller: OTHER })), errorCode("invalid_reply"));
  await assert.rejects(core.sendMessage(OTHER_CONTEXT, replyInput(original, { caller: OTHER, target: { ...RECEIVER, binding_id: "receiver-binding", binding_generation: 7 } })), errorCode("invalid_reply"));
  await assert.rejects(core.sendMessage(RECEIVER_CONTEXT, replyInput(original, { in_reply_to: "missing-message" })), errorCode("reply_not_found"));
  principals[1].allowed_targets.push("other-binding");
  await assert.rejects(core.sendMessage(RECEIVER_CONTEXT, replyInput(original, { target: { ...OTHER, binding_id: "other-binding", binding_generation: 2 } })), errorCode("invalid_reply"));
  assert.equal(store.eventsAfter(original.message.message_id).filter(event => event.kind === "reply").length, 0);
});

test("a valid reply produces one original-message reply event without finishing processing", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const pending = core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, wait_ms: 100 });
  const reply = await sendAndObserve(core, RECEIVER_CONTEXT, replyInput(original));
  await sendAndObserve(core, RECEIVER_CONTEXT, replyInput(original));
  const observed = await pending;
  assert.equal(observed.matched, true);
  assert.equal(observed.matched_by, "reply");
  assert.equal(observed.events[0].data.message_id, reply.message.message_id);
  assert.equal(store.getMessage(original.message.message_id).processing, "pending");
  assert.equal(store.eventsAfter(original.message.message_id).filter(event => event.kind === "reply").length, 1);
});

test("unsupported boundary delivery stays pending without silently choosing idle", async testContext => {
  const { core, state, targets } = await fixture(testContext);
  targets[0].capabilities.next_model_boundary = false;
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(original.delivery.status, "unsupported");
  assert.equal(original.message.processing, "pending");
  assert.equal(original.message.envelope.delivery_policy, "next_model_boundary");
  assert.equal(state.calls.length, 0);
  await core.dispatchPending();
  assert.equal(state.calls.length, 0);
  targets[0].capabilities.next_model_boundary = true;
  await core.dispatchPending();
  assert.equal(state.calls.length, 1);
});

test("explicit when_idle is honored and failed_before_send is never retried", async testContext => {
  const { core, state } = await fixture(testContext, { deliver: request => adapterResult(request, "failed_before_send") });
  const result = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ delivery_policy: "when_idle" }));
  assert.equal(result.delivery.status, "failed_before_send");
  assert.equal(state.calls[0].message.envelope.delivery_policy, "when_idle");
  await core.dispatchPending();
  assert.equal(state.calls.length, 1);
});

test("busy is definitely not sent and retries only on a later dispatch with the original delivery", async testContext => {
  const { core, state } = await fixture(testContext, { deliver: (request, state) => adapterResult(request, state.calls.length === 1 ? "busy" : "accepted") });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(first.delivery.status, "prepared");
  assert.equal(first.delivery.attempt_count, 1);
  assert.equal(state.calls.length, 1);
  await core.dispatchPending();
  const current = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: first.message.message_id });
  assert.equal(current.delivery.status, "accepted");
  assert.equal(current.delivery.attempt_count, 2);
  assert.equal(state.calls[0].delivery.delivery_id, state.calls[1].delivery.delivery_id);
});

test("write errors become unknown and query only the original delivery", async testContext => {
  const { core, state } = await fixture(testContext, {
    deliver() { throw new Error("response-lost-after-write"); },
    query: request => adapterResult(request),
  });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(first.delivery.status, "unknown");
  assert.equal(first.delivery.error.code, "adapter_error");
  await core.sendMessage(SOURCE_CONTEXT, sendInput());
  await core.dispatchPending();
  assert.equal(state.calls.length, 1);
  assert.equal(state.queries.length, 1);
  assert.equal(state.queries[0].delivery.delivery_id, first.delivery.delivery_id);
  assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: first.message.message_id }).delivery.status, "accepted");
});

test("write timeout is unknown, aborts the signal and never replays an uncooperative adapter", async testContext => {
  const { core, state } = await fixture(testContext, { deliveryTimeoutMs: 10, deliver: () => new Promise(() => {}) });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(first.delivery.status, "unknown");
  assert.equal(first.delivery.error.code, "delivery_timeout");
  assert.equal(state.calls[0].signal.aborted, true);
  await core.dispatchPending();
  await core.dispatchPending();
  assert.equal(state.calls.length, 1);
});

test("mismatched write and query receipts remain unknown", async testContext => {
  const { core, state } = await fixture(testContext, {
    deliver: request => adapterResult(request, "accepted", { delivery_id: "unrelated-delivery" }),
    query: request => adapterResult(request, "accepted", { target_key: identityKey(OTHER) }),
  });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(first.delivery.status, "unknown");
  assert.equal(first.delivery.error.code, "invalid_adapter_result");
  await core.dispatchPending();
  const current = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: first.message.message_id });
  assert.equal(current.delivery.status, "unknown");
  assert.equal(current.delivery.error.code, "invalid_adapter_result");
  assert.equal(state.calls.length, 1);
  assert.equal(state.queries.length, 1);
});

test("query busy, unknown, errors and malformed evidence never authorize another write", async testContext => {
  const queryOutcomes = ["busy", "unknown", "throw", "malformed"];
  const { core, state } = await fixture(testContext, {
    deliver: request => adapterResult(request, "unknown"),
    query(request) {
      const outcome = queryOutcomes.shift();
      if (outcome === "throw") throw new Error("query-failed");
      if (outcome === "malformed") return { outcome: "accepted" };
      return adapterResult(request, outcome);
    },
  });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  for (let iteration = 0; iteration < 4; iteration += 1) {
    await core.dispatchPending();
    assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: first.message.message_id }).delivery.status, "unknown");
  }
  assert.equal(state.calls.length, 1);
});

test("expired messages and busy messages expiring before retry never leave the core", async testContext => {
  const { core, state } = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const expired = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ expires_at: "2029-12-31T23:59:59Z" }));
  assert.equal(expired.delivery.status, "expired");
  assert.equal(expired.delivery.attempt_count, 0);
  assert.equal(state.calls.length, 0);
  const busy = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ dedupe_key: "busy-expiry", expires_at: "2030-01-01T00:00:01Z" }));
  state.now += 1000;
  await core.dispatchPending();
  assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: busy.message.message_id }).delivery.status, "expired");
  assert.equal(state.calls.length, 1);
});

test("only the original recipient, delivery and historical generation may acknowledge", async testContext => {
  const { core, targets } = await fixture(testContext);
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const second = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ dedupe_key: "second" }));
  assert.throws(() => core.ackProcessing(SOURCE_CONTEXT, ackInput(first, "done", { caller: SOURCE })), errorCode("forbidden"));
  assert.throws(() => core.ackProcessing(OTHER_CONTEXT, ackInput(first, "done", { caller: OTHER })), errorCode("forbidden"));
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "done", { delivery_id: second.delivery.delivery_id })), errorCode("delivery_mismatch"));
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "done", { binding_generation: 8 })), errorCode("binding_changed"));
  targets[0].binding_generation = 8;
  targets[0].conversation_id = "rebound-receiver";
  const acknowledged = core.ackProcessing(RECEIVER_CONTEXT, ackInput(first));
  assert.equal(acknowledged.message.processing, "done");
  assert.equal(acknowledged.message.envelope.target.binding_generation, 7);
  assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: second.message.message_id }).message.processing, "pending");
});

test("processing can finish directly, terminal repetitions are idempotent and cannot regress", async testContext => {
  const { core, store } = await fixture(testContext);
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "processing"));
  assert.equal(core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "processing")).duplicate, true);
  core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "done"));
  const count = store.lastSequence(first.message.message_id);
  assert.equal(core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "done")).duplicate, true);
  assert.equal(store.lastSequence(first.message.message_id), count);
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "processing")), errorCode("processing_conflict"));
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "failed")), errorCode("processing_conflict"));
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(first, "pending")), errorCode("invalid_input"));
  const second = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ dedupe_key: "failed" }));
  assert.equal(core.ackProcessing(RECEIVER_CONTEXT, ackInput(second, "failed")).message.processing, "failed");
});

test("a late original-generation acknowledgement settles unknown after rebind", async testContext => {
  const { core, targets } = await fixture(testContext, { deliver: request => adapterResult(request, "unknown") });
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  targets[0].binding_generation += 1;
  const result = core.ackProcessing(RECEIVER_CONTEXT, ackInput(original));
  assert.equal(result.delivery.status, "accepted");
  assert.equal(result.message.processing, "done");
  assert.equal(result.message.model_observed, "unknown");
  assert.equal(result.message.ui_observed, "unknown");
});

test("an acknowledgement while a write is pending wins over a later ambiguous write result", async testContext => {
  let fixtureCore;
  const { core } = await fixture(testContext, { deliver(request) {
    fixtureCore.ackProcessing(RECEIVER_CONTEXT, { caller: RECEIVER, message_id: request.message.message_id, delivery_id: request.delivery.delivery_id, binding_generation: 7, processing: "done" });
    return adapterResult(request, "unknown");
  } });
  fixtureCore = core;
  const result = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(result.delivery.status, "accepted");
  assert.equal(result.message.processing, "done");
});

test("acks cannot fabricate acceptance for prepared or expired deliveries", async testContext => {
  const { core } = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const prepared = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(prepared)), errorCode("invalid_state"));
  const expired = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ dedupe_key: "expired", expires_at: "2029-12-31T23:59:59Z" }));
  assert.throws(() => core.ackProcessing(RECEIVER_CONTEXT, ackInput(expired)), errorCode("invalid_state"));
});

test("receipt mappings remain immutable and no original-channel ACK is invoked", async testContext => {
  const { core, principals, store } = await fixture(testContext);
  const receipt = { component: "isolated-channel", resource_id: "resource", generation: 4, wake_id: "wake", notification_id: "notification", event_ids: ["event-2", "event-1"] };
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ origin_receipt_binding: receipt })), errorCode("source_unverified"));
  principals[0].channel_component = "isolated-channel";
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ origin_receipt_binding: receipt }));
  const expected = copy(receipt);
  receipt.event_ids.push("new-event");
  core.ackProcessing(RECEIVER_CONTEXT, ackInput(original));
  assert.deepEqual(store.getMessage(original.message.message_id).envelope.origin_receipt_binding, expected);
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ origin_receipt_binding: receipt })), errorCode("dedupe_conflict"));
});

test("wait bounds, scoped cursors, polling and actual timeout", async testContext => {
  const { core } = await fixture(testContext);
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const second = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ dedupe_key: "second" }));
  const base = { caller: SOURCE, message_id: first.message.message_id, after_cursor: first.next_cursor };
  for (const waitMs of [-1, 45001, 1.5]) await assert.rejects(core.wait(SOURCE_CONTEXT, { ...base, wait_ms: waitMs }), errorCode("invalid_input"));
  await assert.rejects(core.wait(SOURCE_CONTEXT, { ...base, until: "invented" }), errorCode("invalid_input"));
  await assert.rejects(core.wait(SOURCE_CONTEXT, { ...base, after_cursor: second.next_cursor }), errorCode("invalid_cursor"));
  await assert.rejects(core.wait(SOURCE_CONTEXT, { ...base, after_cursor: encodeCursor(first.message.message_id, 100000) }), errorCode("invalid_cursor"));
  await assert.rejects(core.wait(OTHER_CONTEXT, { ...base, caller: OTHER }), errorCode("forbidden"));
  const poll = await core.wait(SOURCE_CONTEXT, { ...base, wait_ms: 0 });
  assert.equal(poll.timed_out, true);
  assert.equal(poll.matched, false);
  assert.deepEqual(poll.events, []);
  const before = performance.now();
  const timeout = await core.wait(SOURCE_CONTEXT, { ...base, wait_ms: 15 });
  assert.equal(timeout.timed_out, true);
  assert.ok(performance.now() - before >= 8);
});

test("wait registers before an immediate acknowledgement and supports processing and delivery conditions", async testContext => {
  const { core } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const waiting = core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, until: "processing", wait_ms: 100 });
  core.ackProcessing(RECEIVER_CONTEXT, ackInput(original, "processing"));
  core.ackProcessing(RECEIVER_CONTEXT, ackInput(original, "done"));
  assert.equal((await waiting).matched_by, "processing");
  const delivery = await core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: original.message.message_id, until: "delivery", wait_ms: 0 });
  assert.equal(delivery.matched, true);
});

test("wait pagination advances only through returned events and never drops a later reply", async testContext => {
  const { core } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  await sendAndObserve(core, RECEIVER_CONTEXT, replyInput(original));
  let cursor;
  const sequences = [];
  let matched = false;
  for (let page = 0; page < 10 && !matched; page += 1) {
    const result = await core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: original.message.message_id, after_cursor: cursor, until: "reply", limit: 1 });
    sequences.push(...result.events.map(event => event.sequence));
    assert.equal(decodeCursor(result.next_cursor, original.message.message_id), result.events.at(-1).sequence);
    cursor = result.next_cursor;
    matched = result.matched;
  }
  assert.equal(matched, true);
  assert.deepEqual(sequences, [1, 2, 3, 4]);
});

test("close releases bounded and active waits, aborts writes and leaves the supplied store open", async testContext => {
  let beginWrite;
  const began = new Promise(resolve => { beginWrite = resolve; });
  const { core, state, store } = await fixture(testContext, { deliveryTimeoutMs: 2000, deliver(request) { beginWrite(request); return new Promise(() => {}); } });
  const sending = core.sendMessage(SOURCE_CONTEXT, sendInput());
  const request = await began;
  const waiting = core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: request.message.message_id, until: "reply", wait_ms: 45000 });
  await core.close();
  const result = await waiting;
  assert.equal(result.matched_by, "closed");
  assert.equal(result.timed_out, false);
  assert.equal((await sending).delivery.status, "prepared");
  assert.equal(store.getDelivery(request.delivery.delivery_id).status, "unknown");
  assert.equal(state.calls[0].signal.aborted, true);
  assert.equal(store.closed, false);
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput()), errorCode("closed"));
  await assert.rejects(core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: request.message.message_id }), errorCode("closed"));
  assert.deepEqual(await core.close(), { closed: true });
});

test("dispatch concurrency is bounded and close does not invoke queued writes", async testContext => {
  let beginWrite;
  const began = new Promise(resolve => { beginWrite = resolve; });
  const { core, state, store } = await fixture(testContext, { maxConcurrent: 1, deliveryTimeoutMs: 2000, deliver() { beginWrite(); return new Promise(() => {}); } });
  const sending = Array.from({ length: 4 }, (_, index) => core.sendMessage(SOURCE_CONTEXT, sendInput({ dedupe_key: `concurrent-${index}` })));
  await began;
  assert.equal(state.calls.length, 1);
  await core.close();
  await Promise.all(sending);
  assert.equal(state.calls.length, 1);
  assert.equal(store.listDeliveries({ statuses: ["prepared"] }).length, 3);
});

test("discovery is permission-filtered, detached, paginated and cursor-scoped", async testContext => {
  const { core, principals, targets } = await fixture(testContext);
  principals[0].allowed_targets = ["receiver-binding", "other-binding"];
  const first = core.listConversations(SOURCE_CONTEXT, { caller: SOURCE, limit: 1 });
  assert.equal(first.targets.length, 1);
  assert.equal(first.has_more, true);
  const second = core.listConversations(SOURCE_CONTEXT, { caller: SOURCE, limit: 1, cursor: first.next_cursor });
  assert.equal(second.targets.length, 1);
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  assert.notEqual(first.targets[0].binding_id, second.targets[0].binding_id);
  assert.throws(() => core.listConversations(OTHER_CONTEXT, { caller: OTHER, cursor: first.next_cursor }), errorCode("invalid_cursor"));
  assert.throws(() => core.listConversations(SOURCE_CONTEXT, { caller: SOURCE, host: "another-host", cursor: first.next_cursor }), errorCode("invalid_cursor"));
  assert.deepEqual(core.listConversations(SOURCE_CONTEXT, { caller: SOURCE, host: "another-host" }).targets, []);
  const resolved = core.resolveTarget(SOURCE_CONTEXT, { caller: SOURCE, binding_id: "receiver-binding" });
  resolved.target.capabilities.next_model_boundary = false;
  assert.equal(targets[0].capabilities.next_model_boundary, true);
  assert.throws(() => core.resolveTarget(RECEIVER_CONTEXT, { caller: RECEIVER, binding_id: "other-binding" }), errorCode("forbidden"));
  targets[0].binding_generation += 1;
  assert.throws(() => core.listConversations(SOURCE_CONTEXT, { caller: SOURCE, cursor: first.next_cursor }), errorCode("invalid_cursor"));
});

test("reopened core preserves dedupe and only queries interrupted writes", async testContext => {
  const originalFixture = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const first = await sendAndObserve(originalFixture.core, SOURCE_CONTEXT, sendInput());
  originalFixture.store.updateDelivery(first.delivery.delivery_id, { status: "dispatching" });
  originalFixture.store.updateMessage(first.message.message_id, { delivery_status: "dispatching" });
  const snapshot = copy(originalFixture.store.state);
  await originalFixture.core.close();
  const reopened = await fixture(testContext, { store: new StubStore(snapshot), query: request => adapterResult(request) });
  assert.equal(reopened.state.calls.length, 0);
  assert.equal(reopened.state.queries.length, 1);
  const duplicate = await reopened.core.sendMessage(SOURCE_CONTEXT, sendInput());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, first.message.message_id);
  assert.equal(duplicate.delivery.status, "accepted");
  await assert.rejects(reopened.core.sendMessage(SOURCE_CONTEXT, sendInput({ text: "changed-after-reopen" })), errorCode("dedupe_conflict"));
});

test("prepared recovery rechecks current authority, generation, identity and adapter", async testContext => {
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const first = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  const snapshot = copy(original.store.state);
  await original.core.close();
  const mutations = [
    ({ targets }) => { targets[0].binding_generation += 1; },
    ({ targets }) => { targets[0].conversation_id = "new-recipient"; },
    ({ targets }) => { targets[0].adapter_id = "new-adapter"; },
    ({ principals }) => { principals[0].allowed_targets = []; },
    ({ principals }) => { principals[0].origin_kinds = []; },
    ({ principals }) => { principals[0].identity = OTHER; },
    ({ principals }) => { principals.splice(0, 1); },
  ];
  for (const mutate of mutations) {
    const reopened = await fixture(testContext, { store: new StubStore(snapshot), start: false });
    mutate(reopened);
    await reopened.core.start();
    await reopened.core.drain();
    assert.equal(reopened.state.calls.length, 0);
    assert.equal(reopened.store.getDelivery(first.delivery.delivery_id).status, "failed_before_send");
    await reopened.core.close();
  }
});

test("prepared recovery resumes valid messages and keeps unknown pinned to the old snapshot", async testContext => {
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const first = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  const preparedSnapshot = copy(original.store.state);
  await original.core.close();
  const resumed = await fixture(testContext, { store: new StubStore(preparedSnapshot) });
  assert.equal(resumed.state.calls.length, 1);
  assert.equal(resumed.state.calls[0].delivery.delivery_id, first.delivery.delivery_id);
  assert.equal(resumed.state.calls[0].delivery.attempt_count, 2);
  const unknownStore = new StubStore(preparedSnapshot);
  unknownStore.updateDelivery(first.delivery.delivery_id, { status: "unknown" });
  unknownStore.updateMessage(first.message.message_id, { delivery_status: "unknown" });
  const unknown = await fixture(testContext, { store: unknownStore, start: false, query: request => adapterResult(request) });
  unknown.targets[0].binding_generation = 99;
  unknown.targets[0].conversation_id = "rebound";
  unknown.principals[0].allowed_targets = [];
  await unknown.core.start();
  await unknown.core.drain();
  assert.equal(unknown.state.calls.length, 0);
  assert.equal(unknown.state.queries[0].target.binding_generation, 7);
  assert.equal(unknown.state.queries[0].target.conversation_id, RECEIVER.conversation_id);
});

test("map registries and idempotent start obey the same interface", async testContext => {
  const original = await fixture(testContext);
  const core = new CommunicationCore({ store: new StubStore(), targets: new Map(original.targets.map(target => [target.binding_id, target])), principals: new Map(original.principals.map(principal => [principal.id, principal])), adapters: new Map([["test-adapter", original.adapter]]) });
  testContext.after(() => core.close());
  assert.deepEqual(await core.start(), { started: true });
  assert.deepEqual(await core.start(), { started: true });
  assert.equal(core.resolveTarget(SOURCE_CONTEXT, { caller: SOURCE, binding_id: "receiver-binding" }).target.binding_generation, 7);
});

function seededStore(template, count, statusAt) {
  const snapshot = { messages: {}, deliveries: {}, events: {} };
  for (let index = 0; index < count; index += 1) {
    const messageId = `seed-message-${String(index).padStart(4, "0")}`;
    const deliveryId = `seed-delivery-${String(index).padStart(4, "0")}`;
    const status = typeof statusAt === "function" ? statusAt(index) : statusAt;
    snapshot.messages[messageId] = { ...copy(template.message), message_id: messageId, dedupe_key: `seed-${index}`, delivery_status: status };
    snapshot.deliveries[deliveryId] = { ...copy(template.delivery), message_id: messageId, delivery_id: deliveryId, status };
  }
  return new StubStore(snapshot);
}

test("multi-page pending and unknown scans stay bounded, finish each page and visit each delivery once", async testContext => {
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const template = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  await original.core.close();
  const store = seededStore(template, 205, index => index % 2 ? "prepared" : "unknown");
  const reopened = await fixture(testContext, { store, start: false, deliver: request => adapterResult(request, "busy"), query: request => adapterResult(request, "unknown") });
  const pages = [];
  const list = store.listDeliveries.bind(store);
  store.listDeliveries = input => {
    assert.ok(input.limit <= 100);
    if (input.statuses.includes("prepared")) {
      assert.equal(reopened.state.calls.length + reopened.state.queries.length, pages.length * 100);
      pages.push(copy(input));
    }
    return list(input);
  };
  await reopened.core.start();
  await reopened.core.drain();
  assert.equal(pages.length, 3);
  assert.equal(reopened.state.calls.length, 102);
  assert.equal(reopened.state.queries.length, 103);
  assert.equal(new Set([...reopened.state.calls, ...reopened.state.queries].map(request => request.delivery.delivery_id)).size, 205);
  assert.equal(pages[0].after_id, undefined);
  assert.equal(pages[1].after_id, "seed-delivery-0099");
  assert.equal(pages[2].after_id, "seed-delivery-0199");
});

test("interrupted recovery crosses multiple keyset pages without skipping status changes", async testContext => {
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const template = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  await original.core.close();
  const store = seededStore(template, 205, "dispatching");
  const reopened = await fixture(testContext, { store, query: request => adapterResult(request, "unknown") });
  assert.equal(reopened.state.calls.length, 0);
  assert.equal(reopened.state.queries.length, 205);
  assert.equal(store.listDeliveries({ statuses: ["dispatching"], limit: 1000 }).length, 0);
  assert.equal(store.listDeliveries({ statuses: ["unknown"], limit: 1000 }).length, 205);
  for (const request of reopened.state.queries) assert.equal(request.delivery.error.code, "interrupted");
});

test("start returns while external recovery is blocked, keeps reads responsive and close stops its bounded queue", async testContext => {
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const template = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  await original.core.close();
  const store = seededStore(template, 205, "unknown");
  const reopened = await fixture(testContext, { store, start: false, deliveryTimeoutMs: 10000, query: () => new Promise(() => {}) });
  const started = await Promise.race([reopened.core.start(), delay(100).then(() => "startup-blocked")]);
  assert.deepEqual(started, { started: true });
  assert.equal(reopened.state.queries.length, 2);
  assert.equal(reopened.core.jobs.size, 100);
  assert.equal(reopened.core.queue.length, 98);
  assert.equal(reopened.core.resolveTarget(SOURCE_CONTEXT, { caller: SOURCE, binding_id: "receiver-binding" }).target.binding_generation, 7);
  assert.equal(reopened.core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: "seed-message-0204" }).delivery.status, "unknown");
  assert.equal(reopened.core.listConversations(SOURCE_CONTEXT, { caller: SOURCE }).targets.length, 1);
  await reopened.core.close();
  assert.equal(reopened.state.queries.length, 2);
  assert.equal(reopened.core.jobs.size, 0);
  assert.equal(reopened.core.waiters.size, 0);
  assert.equal(store.closed, false);
});

test("concurrent dispatch requests share one background pass instead of repeatedly querying unknown", async testContext => {
  const { core, state } = await fixture(testContext, { deliver: request => adapterResult(request, "unknown"), async query(request) { await delay(5); return adapterResult(request, "unknown"); } });
  await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  await Promise.all([core.dispatchPending(), core.dispatchPending(), core.dispatchPending()]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.queries.length, 1);
});

test("queued messages recheck rebinding immediately before their own dispatch", async testContext => {
  let releaseWrite;
  let beginWrite;
  const began = new Promise(resolve => { beginWrite = resolve; });
  const { core, state, targets } = await fixture(testContext, { maxConcurrent: 1, deliver(request) {
    return new Promise(resolve => {
      releaseWrite = () => resolve(adapterResult(request));
      beginWrite();
    });
  } });
  const first = core.sendMessage(SOURCE_CONTEXT, sendInput());
  const queued = core.sendMessage(SOURCE_CONTEXT, sendInput({ dedupe_key: "queued" }));
  await began;
  targets[0].conversation_id = "replacement";
  targets[0].binding_generation += 1;
  releaseWrite();
  await first;
  const sent = await queued;
  await core.drain();
  const result = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id });
  assert.equal(result.delivery.status, "failed_before_send");
  assert.equal(result.delivery.error.code, "binding_changed");
  assert.equal(result.delivery.attempt_count, 0);
  assert.equal(state.calls.length, 1);
});

test("queued messages recheck expiry before sending", async testContext => {
  let releaseWrite;
  let beginWrite;
  const began = new Promise(resolve => { beginWrite = resolve; });
  const { core, state } = await fixture(testContext, { maxConcurrent: 1, deliver(request) {
    return new Promise(resolve => {
      releaseWrite = () => resolve(adapterResult(request));
      beginWrite();
    });
  } });
  const first = core.sendMessage(SOURCE_CONTEXT, sendInput());
  const queued = core.sendMessage(SOURCE_CONTEXT, sendInput({ dedupe_key: "queued-expiry", expires_at: "2030-01-01T00:00:01Z" }));
  await began;
  state.now += 1000;
  releaseWrite();
  await first;
  const sent = await queued;
  await core.drain();
  assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id }).delivery.status, "expired");
  assert.equal(state.calls.length, 1);
});

test("an original duplicate survives a later rebind without dispatching to the new target", async testContext => {
  const { core, state, targets } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  targets[0].conversation_id = "replacement";
  targets[0].binding_generation += 1;
  const repeated = await core.sendMessage(SOURCE_CONTEXT, sendInput());
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(state.calls.length, 1);
  await assert.rejects(core.sendMessage(SOURCE_CONTEXT, sendInput({ dedupe_key: "new-stale-message" })), errorCode("binding_changed"));
});

test("cyclic adapter evidence is discarded without replacing a validated correlated receipt", async testContext => {
  const { core } = await fixture(testContext, { deliver(request) {
    const result = adapterResult(request);
    result.evidence = result;
    return result;
  } });
  const result = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  assert.equal(result.delivery.status, "accepted");
  assert.deepEqual(result.delivery.evidence.evidence, { operation: "deliver" });
});

test("real SQLite recovery uses bounded keyset pages and survives an actual store reopen", async testContext => {
  const directory = mkdtempSync(join(tmpdir(), "communication-core-worker-分页恢复-"));
  const filePath = join(directory, "core.sqlite");
  let ownedCore;
  let ownedStore;
  testContext.after(async () => {
    await ownedCore?.close();
    ownedStore?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const template = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  await original.core.close();
  const seed = seededStore(template, 205, index => ["dispatching", "unknown", "prepared"][index % 3]);
  ownedStore = new MessageStore({ filePath });
  ownedStore.transaction(() => {
    for (const message of Object.values(seed.state.messages)) ownedStore.insertMessage(message);
    for (const delivery of Object.values(seed.state.deliveries)) ownedStore.insertDelivery(delivery);
    ownedStore.insertMessage({ ...template.message, delivery_status: "accepted" });
    ownedStore.insertDelivery({ ...template.delivery, status: "accepted" });
  });
  const pageSizes = [];
  const list = ownedStore.listDeliveries.bind(ownedStore);
  ownedStore.listDeliveries = input => {
    pageSizes.push(input.limit);
    return list(input);
  };
  const first = await fixture(testContext, { store: ownedStore, start: false, query: request => adapterResult(request) });
  ownedCore = first.core;
  await ownedCore.start();
  await ownedCore.drain();
  assert.equal(first.state.calls.length, 68);
  assert.equal(first.state.queries.length, 137);
  assert.ok(pageSizes.length >= 4);
  assert.ok(pageSizes.every(size => size <= 100));
  assert.equal(list({ statuses: ["accepted"], limit: 1000 }).length, 206);
  await ownedCore.close();
  ownedStore.close();
  ownedCore = null;
  ownedStore = new MessageStore({ filePath });
  const reopened = await fixture(testContext, { store: ownedStore, start: false });
  ownedCore = reopened.core;
  await ownedCore.start();
  await ownedCore.drain();
  const duplicate = await ownedCore.sendMessage(SOURCE_CONTEXT, sendInput());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, template.message.message_id);
  assert.equal(duplicate.delivery.delivery_id, template.delivery.delivery_id);
  assert.equal(reopened.state.calls.length, 0);
});

test("startup background failures surface through drain and an explicit healthy pass clears them", async testContext => {
  const { core, store } = await fixture(testContext, { start: false });
  const list = store.listDeliveries.bind(store);
  store.listDeliveries = input => {
    if (input.statuses.includes("prepared")) throw new Error("injected-background-read-failure");
    return list(input);
  };
  assert.deepEqual(await core.start(), { started: true });
  await assert.rejects(core.drain(), /injected-background-read-failure/);
  store.listDeliveries = list;
  assert.deepEqual(await core.dispatchPending(), { checked: 0 });
  await core.drain();
});

function trackWaitTimers(testContext) {
  const active = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  testContext.mock.method(globalThis, "setTimeout", (...parameters) => {
    const handle = nativeSetTimeout(...parameters);
    active.add(handle);
    return handle;
  });
  testContext.mock.method(globalThis, "clearTimeout", handle => {
    active.delete(handle);
    return nativeClearTimeout(handle);
  });
  return active;
}

test("an already aborted trusted wait signal creates no timer or waiter and leaves all business state unchanged", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const before = copy(store.state);
  const controller = new AbortController();
  controller.abort();
  const timers = trackWaitTimers(testContext);
  const result = await core.wait({ ...SOURCE_CONTEXT, signal: controller.signal }, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, wait_ms: 45000 });
  assert.equal(result.matched, false);
  assert.equal(result.matched_by, "cancelled");
  assert.equal(result.timed_out, false);
  assert.equal(result.next_cursor, original.next_cursor);
  assert.deepEqual(result.events, []);
  assert.equal(core.waiters.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(globalThis.setTimeout.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.deepEqual(store.state, before);
});

test("aborting an active core wait synchronously removes its waiter timer and listener without any receipt changes", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const before = copy(store.state);
  const controller = new AbortController();
  const timers = trackWaitTimers(testContext);
  const waiting = core.wait({ ...SOURCE_CONTEXT, signal: controller.signal }, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, wait_ms: 45000 });
  assert.equal(core.waiters.size, 1);
  assert.equal(core.waiters.get(original.message.message_id).size, 1);
  assert.equal(timers.size, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(new Error("synthetic-client-cancel"));
  assert.equal(core.waiters.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const result = await waiting;
  assert.equal(result.matched_by, "cancelled");
  assert.equal(result.matched, false);
  assert.equal(result.timed_out, false);
  assert.equal(result.next_cursor, original.next_cursor);
  assert.deepEqual(store.state, before);
});

test("repeated cancelled waits cannot accumulate background resources", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const before = copy(store.state);
  const timers = trackWaitTimers(testContext);
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const controller = new AbortController();
    const waiting = core.wait({ ...SOURCE_CONTEXT, signal: controller.signal }, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, wait_ms: 45000 });
    controller.abort();
    assert.equal((await waiting).matched_by, "cancelled");
    assert.equal(core.waiters.size, 0);
    assert.equal(timers.size, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  assert.deepEqual(store.state, before);
});

test("cancelling one wait preserves a different wait on the same message", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const before = copy(store.state);
  const timers = trackWaitTimers(testContext);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const input = { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, wait_ms: 45000 };
  const first = core.wait({ ...SOURCE_CONTEXT, signal: firstController.signal }, input);
  const second = core.wait({ ...SOURCE_CONTEXT, signal: secondController.signal }, input);
  assert.equal(core.waiters.get(original.message.message_id).size, 2);
  firstController.abort();
  assert.equal((await first).matched_by, "cancelled");
  assert.equal(core.waiters.get(original.message.message_id).size, 1);
  assert.equal(timers.size, 1);
  assert.equal(getEventListeners(firstController.signal, "abort").length, 0);
  assert.equal(getEventListeners(secondController.signal, "abort").length, 1);
  secondController.abort();
  assert.equal((await second).matched_by, "cancelled");
  assert.equal(core.waiters.size, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(store.state, before);
});

test("normal completion and close also remove a trusted wait signal listener", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const controller = new AbortController();
  const timers = trackWaitTimers(testContext);
  const input = { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, until: "processing", wait_ms: 45000 };
  const waiting = core.wait({ ...SOURCE_CONTEXT, signal: controller.signal }, input);
  core.ackProcessing(RECEIVER_CONTEXT, ackInput(original));
  assert.equal((await waiting).matched_by, "processing");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(core.waiters.size, 0);
  assert.equal(timers.size, 0);
  const afterCompletion = copy(store.state);
  controller.abort();
  assert.deepEqual(store.state, afterCompletion);
  const closeController = new AbortController();
  const closing = core.wait({ ...SOURCE_CONTEXT, signal: closeController.signal }, { ...input, after_cursor: encodeCursor(original.message.message_id, store.lastSequence(original.message.message_id)), until: "reply" });
  await core.close();
  assert.equal((await closing).matched_by, "closed");
  assert.equal(getEventListeners(closeController.signal, "abort").length, 0);
  assert.equal(core.waiters.size, 0);
  assert.equal(timers.size, 0);
});

test("context cancellation is scoped to waiting and never cancels an already persisted send", async testContext => {
  const { core, state } = await fixture(testContext, { async deliver(request) { await delay(5); return adapterResult(request); } });
  const controller = new AbortController();
  const sending = core.sendMessage({ ...SOURCE_CONTEXT, signal: controller.signal }, sendInput());
  controller.abort();
  const sent = await sending;
  assert.equal(sent.delivery.status, "prepared");
  await core.drain();
  const result = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id });
  assert.equal(result.delivery.status, "accepted");
  assert.equal(result.message.processing, "pending");
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].signal.aborted, false);
});

test("invalid trusted wait signal values fail before allocating background resources", async testContext => {
  const { core, store } = await fixture(testContext);
  const original = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  const before = copy(store.state);
  const timers = trackWaitTimers(testContext);
  for (const signal of [false, 0, "invalid", {}]) {
    await assert.rejects(core.wait({ ...SOURCE_CONTEXT, signal }, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, wait_ms: 45000 }), errorCode("invalid_input"));
    assert.equal(core.waiters.size, 0);
    assert.equal(timers.size, 0);
  }
  assert.deepEqual(store.state, before);
});

test("early replies remain visible through both send and snapshot cursors before the original adapter returns", async testContext => {
  let activeCore;
  let releaseWrite;
  let pendingReply;
  let beginReply;
  const began = new Promise(resolve => { beginReply = resolve; });
  const { core, store } = await fixture(testContext, { deliver(request) {
    if (request.message.envelope.in_reply_to) return adapterResult(request);
    pendingReply = activeCore.sendMessage(RECEIVER_CONTEXT, replyInput({ message: request.message }));
    beginReply();
    return new Promise(resolve => { releaseWrite = () => resolve(adapterResult(request)); });
  } });
  activeCore = core;
  const sending = core.sendMessage(SOURCE_CONTEXT, sendInput({ reply_required: true }));
  await began;
  const sent = await sending;
  const reply = await pendingReply;
  assert.equal(sent.delivery.status, "prepared");
  assert.equal(store.getDelivery(sent.delivery.delivery_id).status, "dispatching");
  assert.equal(decodeCursor(sent.next_cursor, sent.message.message_id), 0);
  const snapshot = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id });
  assert.equal(decodeCursor(snapshot.next_cursor, sent.message.message_id), 0);
  for (const cursor of [sent.next_cursor, snapshot.next_cursor]) {
    const found = await core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id, after_cursor: cursor, until: "reply", wait_ms: 0 });
    assert.equal(found.matched, true);
    assert.equal(found.matched_by, "reply");
    assert.equal(found.events.find(event => event.kind === "reply").data.message_id, reply.message.message_id);
  }
  releaseWrite();
  await core.drain();
  assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id }).message.processing, "pending");
});

const SYNTHETIC_SECRET = "synthetic-secret-sentinel-never-a-real-credential-8e45";

function secretAdapterOutcome(request, outcome = "accepted") {
  return adapterResult(request, outcome, {
    headers: { authorization: `Bearer ${SYNTHETIC_SECRET}` },
    token: SYNTHETIC_SECRET,
    url: `https://synthetic.invalid/?token=${SYNTHETIC_SECRET}`,
    host_request_id: SYNTHETIC_SECRET,
    reason: SYNTHETIC_SECRET,
    error: { code: "unavailable", message: SYNTHETIC_SECRET, stack: SYNTHETIC_SECRET, details: { token: SYNTHETIC_SECRET } },
    evidence: { kind: "simulated", observed_at: "2030-01-01T00:00:00Z", retry_after_ms: 25, headers: { cookie: SYNTHETIC_SECRET }, token: SYNTHETIC_SECRET, nested: [SYNTHETIC_SECRET] },
  });
}

test("every structured adapter outcome is rebuilt from a finite safe whitelist before snapshots events or storage", async testContext => {
  const outcomes = ["accepted", "busy", "failed_before_send", "unknown"];
  const { core, store, state } = await fixture(testContext, { deliver: (request, state) => secretAdapterOutcome(request, outcomes[state.calls.length - 1]) });
  for (const outcome of outcomes) {
    const sent = await core.sendMessage(SOURCE_CONTEXT, sendInput({ dedupe_key: `sanitized-${outcome}` }));
    assert.equal(JSON.stringify(sent).includes(SYNTHETIC_SECRET), false);
    await core.drain();
    const snapshot = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id });
    const events = await core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id, until: "any", wait_ms: 0 });
    assert.equal(JSON.stringify(snapshot).includes(SYNTHETIC_SECRET), false);
    assert.equal(JSON.stringify(events).includes(SYNTHETIC_SECRET), false);
    assert.equal(JSON.stringify(store.state).includes(SYNTHETIC_SECRET), false);
    assert.equal(snapshot.delivery.status, outcome === "busy" ? "prepared" : outcome);
    assert.deepEqual(Object.keys(snapshot.delivery.evidence).sort(), ["delivery_id", "target_key", "outcome", "evidence", "error"].sort());
    assert.deepEqual(snapshot.delivery.evidence.evidence, { operation: "deliver", kind: "simulated", observed_at: "2030-01-01T00:00:00.000Z", retry_after_ms: 25 });
    assert.deepEqual(snapshot.delivery.error, { code: "unavailable", message: "适配器暂时不可用" });
    assert.equal(snapshot.message.processing, "pending");
    assert.equal(snapshot.message.model_observed, "unknown");
    assert.equal(snapshot.message.ui_observed, "unknown");
  }
  assert.equal(state.calls.length, 4);
});

test("query receipts discard secret codes arbitrary evidence strings and mismatched target data", async testContext => {
  let mismatched = false;
  const { core, store, state } = await fixture(testContext, {
    deliver: request => adapterResult(request, "unknown"),
    query(request) {
      const result = secretAdapterOutcome(request);
      result.error.code = SYNTHETIC_SECRET;
      result.evidence = { kind: SYNTHETIC_SECRET, observed_at: SYNTHETIC_SECRET, retry_after_ms: SYNTHETIC_SECRET };
      if (mismatched) result.target_key = SYNTHETIC_SECRET;
      return result;
    },
  });
  const first = await sendAndObserve(core, SOURCE_CONTEXT, sendInput());
  await core.dispatchPending();
  const accepted = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: first.message.message_id });
  assert.equal(accepted.delivery.status, "accepted");
  assert.deepEqual(accepted.delivery.error, { code: "adapter_error", message: "适配器调用失败，发送结果待核实" });
  assert.deepEqual(accepted.delivery.evidence.evidence, { operation: "query" });
  mismatched = true;
  const second = await sendAndObserve(core, SOURCE_CONTEXT, sendInput({ dedupe_key: "mismatched-secret" }));
  await core.dispatchPending();
  const unknown = core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: second.message.message_id });
  assert.equal(unknown.delivery.status, "unknown");
  assert.equal(unknown.delivery.error.code, "invalid_adapter_result");
  assert.equal(JSON.stringify([accepted, unknown, store.state]).includes(SYNTHETIC_SECRET), false);
  assert.equal(state.calls.length, 2);
});

test("real SQLite and WAL never receive secret structured adapter fields and sanitized receipts survive reopen", async testContext => {
  const directory = mkdtempSync(join(tmpdir(), "communication-core-worker-safe-evidence-"));
  const filePath = join(directory, "core.sqlite");
  let ownedCore;
  let ownedStore = new MessageStore({ filePath });
  testContext.after(async () => {
    await ownedCore?.close();
    ownedStore?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const harness = await fixture(testContext, { store: ownedStore, start: false, deliver: request => secretAdapterOutcome(request) });
  ownedCore = harness.core;
  await ownedCore.start();
  await ownedCore.drain();
  const sent = await ownedCore.sendMessage(SOURCE_CONTEXT, sendInput());
  await ownedCore.drain();
  const snapshot = ownedCore.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id });
  assert.equal(JSON.stringify([sent, snapshot, ownedStore.getDelivery(sent.delivery.delivery_id)]).includes(SYNTHETIC_SECRET), false);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(filePath + suffix)) assert.equal(readFileSync(filePath + suffix).includes(Buffer.from(SYNTHETIC_SECRET)), false);
  }
  await ownedCore.close();
  ownedCore = null;
  ownedStore.close();
  ownedStore = new MessageStore({ filePath });
  assert.equal(ownedStore.getDelivery(sent.delivery.delivery_id).status, "accepted");
  assert.equal(JSON.stringify(ownedStore.getDelivery(sent.delivery.delivery_id)).includes(SYNTHETIC_SECRET), false);
  assert.equal(readFileSync(filePath).includes(Buffer.from(SYNTHETIC_SECRET)), false);
});

test("sending and deduping return persisted prepared IDs without waiting behind a blocked recovery page", async testContext => {
  const original = await fixture(testContext, { deliver: request => adapterResult(request, "busy") });
  const template = await sendAndObserve(original.core, SOURCE_CONTEXT, sendInput());
  await original.core.close();
  const store = seededStore(template, 205, "unknown");
  const recovered = await fixture(testContext, { store, start: false, deliveryTimeoutMs: 10000, query: () => new Promise(() => {}) });
  await recovered.core.start();
  assert.equal(recovered.state.queries.length, 2);
  assert.equal(recovered.core.jobs.size, 100);
  const input = sendInput({ dedupe_key: "sent-during-blocked-recovery" });
  const sent = await Promise.race([recovered.core.sendMessage(SOURCE_CONTEXT, input), delay(100).then(() => null)]);
  assert.ok(sent, "发送持久化结果应在恢复查询完成前返回");
  assert.equal(sent.delivery.status, "prepared");
  assert.equal(store.getDelivery(sent.delivery.delivery_id).status, "prepared");
  assert.equal(store.getMessage(sent.message.message_id).processing, "pending");
  assert.equal(recovered.state.calls.length, 0);
  const duplicate = await recovered.core.sendMessage(SOURCE_CONTEXT, input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, sent.message.message_id);
  assert.equal(duplicate.delivery.delivery_id, sent.delivery.delivery_id);
  assert.equal(recovered.core.jobs.size, 101);
  await recovered.core.close();
  assert.equal(store.getDelivery(sent.delivery.delivery_id).status, "prepared");
});

test("asynchronous send work failures are handled and observable through drain without unhandled rejections", async testContext => {
  const { core, store } = await fixture(testContext);
  const unhandled = [];
  const recordUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", recordUnhandled);
  testContext.after(() => process.off("unhandledRejection", recordUnhandled));
  const update = store.updateDelivery.bind(store);
  store.updateDelivery = (deliveryId, patch) => {
    if (patch.status === "dispatching") throw new Error("injected-async-send-work-failure");
    return update(deliveryId, patch);
  };
  const sent = await core.sendMessage(SOURCE_CONTEXT, sendInput());
  assert.equal(sent.delivery.status, "prepared");
  await assert.rejects(core.drain(), /injected-async-send-work-failure/);
  await delay(0);
  assert.deepEqual(unhandled, []);
  assert.equal(store.getDelivery(sent.delivery.delivery_id).status, "prepared");
  store.updateDelivery = update;
  await core.dispatchPending();
  await core.drain();
  assert.equal(core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id }).delivery.status, "accepted");
});
