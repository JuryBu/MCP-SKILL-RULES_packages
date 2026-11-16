import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";
import { NapcatOwnerAdapter } from "../src/adapters/napcat-owner.mjs";

const source = { machine_id: "synthetic-machine", host: "antigravity", surface: "desktop", conversation_id: "synthetic-reply-origin" };
const owner = { machine_id: "synthetic-machine", host: "qq", surface: "group", conversation_id: "synthetic-reply-group", binding_id: "synthetic-owner", binding_generation: 2, adapter_id: "synthetic-qq", capabilities: { next_model_boundary: true, when_idle: false }, evidence: "synthetic" };
const returnTarget = { ...source, binding_id: "synthetic-origin", binding_generation: 3, adapter_id: "synthetic-ag", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic" };
const principal = { id: "synthetic-origin-principal", identity: source, allowed_targets: [owner.binding_id], origin_kinds: ["agent_message"] };
const route = { route_key: "synthetic-events-only", conversation_id: "synthetic-core-owner", target_key: owner.conversation_id, generation: 8 };
const nativeEventId = "synthetic-quoted-owner-event";
const rule = { id: "synthetic-return", source_principal_id: principal.id, from_binding_id: owner.binding_id, to_binding_id: returnTarget.binding_id, ttl_ms: 60000, owner_sender_allowlist: ["90001"] };

async function fixture(context, { enabled = true, availability = "ready" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-reply-forward-"));
  const filePath = join(directory, "core.sqlite");
  const targets = [structuredClone(owner), structuredClone(returnTarget)];
  const calls = { qq: 0, reads: 0, attempts: 0, received: [], queries: 0 };
  let mode = availability;
  let clock = Date.now();
  const ownerAdapter = new NapcatOwnerAdapter({
    routeKey: route.route_key,
    conversationId: route.conversation_id,
    replyEvents: { enabled: true, callerConversationId: route.conversation_id, targetKey: route.target_key, routeGeneration: route.generation, ownerSenderAllowlist: ["90001"] },
    transport: {
      async status() { return { ready: true }; },
      async sendOwnerAlert() {
        calls.qq += 1;
        return { ok: true, sent: true, verified: true, statePersisted: true, target: { targetKey: owner.conversation_id }, messageId: "80001", replyRoute: { messageId: "80001", routeKey: route.route_key, conversationId: route.conversation_id, targetKey: route.target_key, ownerEventGeneration: route.generation } };
      },
      async readOwnerEvents() {
        calls.reads += 1;
        return { ok: true, route, original_qq_message_id: "80001", events: [{ event_id: nativeEventId, message_id: "80002", message_seq: 44, quoted_message_id: "80001", sender_id: "90001", text: "[CQ:reply,id=80001] 主人的原始回信" }], next_cursor: null, partial: false };
      },
    },
  });
  const returnAdapter = {
    async deliver({ message, delivery, target }) {
      calls.attempts += 1;
      if (mode === "absent") return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "busy", evidence: { kind: "query", retry_after_ms: 0 } };
      calls.received.push(structuredClone(message));
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: mode === "unknown" ? "unknown" : "accepted", evidence: { kind: "transport" } };
    },
    async query({ delivery, target }) { calls.queries += 1; return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: { kind: "query" } }; },
  };
  let store;
  let core;
  async function open(rules) {
    store = new MessageStore({ filePath });
    core = new CommunicationCore({ store, targets, principals: [principal], adapters: { [owner.adapter_id]: ownerAdapter, [returnTarget.adapter_id]: returnAdapter }, replyForwarding: rules, now: () => clock });
    await core.start();
  }
  context.after(async () => { await core.close(); store.close(); await ownerAdapter.close(); rmSync(directory, { recursive: true, force: true }); });
  await open(enabled ? [rule] : []);
  const input = { caller: source, origin: { kind: "agent_message", channel: "test", source_ref: "synthetic-owner-notice" }, target: { machine_id: owner.machine_id, host: owner.host, surface: owner.surface, conversation_id: owner.conversation_id, binding_id: owner.binding_id, binding_generation: owner.binding_generation }, text: "由原模型发出的QQ通知", dedupe_key: "synthetic-forward-original", expires_at: "2031-01-01T00:00:00Z" };
  const original = await core.sendMessage({ principal_id: principal.id }, input);
  await core.drain();
  return {
    original, calls, input, targets,
    get core() { return core; },
    get store() { return store; },
    setMode(value) { mode = value; },
    advance(milliseconds) { clock += milliseconds; },
    async reopen(rules = enabled ? [rule] : []) { await core.close(); store.close(); await open(rules); await core.drain(); },
    forwards() { return store.listDeliveries({ limit: 100 }).map(delivery => core.result(delivery.message_id)).filter(snapshot => snapshot.message.forward_of); },
  };
}

test("native owner reply automatically reaches its exact originating AG through a durable human message", async context => {
  const state = await fixture(context);
  assert.equal((await state.core.pollReplies()).replies, 1);
  await state.core.drain();
  const [forward] = state.forwards();
  assert.equal(forward.delivery.status, "accepted");
  assert.equal(forward.message.envelope.origin.kind, "human_message");
  assert.equal(forward.message.source_key, identityKey(owner));
  assert.equal(forward.message.target_key, identityKey(source));
  assert.equal(forward.message.envelope.text, "[CQ:reply,id=80001] 主人的原始回信");
  assert.equal(forward.message.envelope.in_reply_to, state.original.message.message_id);
  assert.equal(forward.message.forward_of.native_source.event.event_id, nativeEventId);
  assert.equal(state.calls.received.length, 1);
  assert.equal(state.calls.qq, 1);
  assert.equal(state.core.result(state.original.message.message_id).message.processing, "pending");
  assert.equal(forward.message.processing, "pending");
  await state.core.pollReplies();
  await state.reopen();
  assert.equal(state.forwards()[0].message.message_id, forward.message.message_id);
  assert.equal(state.forwards()[0].delivery.delivery_id, forward.delivery.delivery_id);
  assert.equal(state.calls.received.length, 1);
  assert.equal(state.calls.qq, 1);
});

test("no automatic forwarding is inferred when no explicit return rule is configured", async context => {
  const state = await fixture(context, { enabled: false });
  await state.core.pollReplies();
  await state.core.drain();
  assert.equal(state.forwards().length, 0);
  assert.equal(state.calls.received.length, 0);
  assert.equal(state.core.hasReply(state.original.message.message_id), true);
});

test("absent originating host keeps the same return message and delivery through restart", async context => {
  const state = await fixture(context, { availability: "absent" });
  await state.core.pollReplies();
  await state.core.drain();
  const [pending] = state.forwards();
  assert.equal(pending.delivery.status, "prepared");
  assert.equal(state.calls.received.length, 0);
  state.setMode("ready");
  await state.reopen();
  const [recovered] = state.forwards();
  assert.equal(recovered.delivery.status, "accepted");
  assert.equal(recovered.message.message_id, pending.message.message_id);
  assert.equal(recovered.delivery.delivery_id, pending.delivery.delivery_id);
  assert.equal(state.calls.received.length, 1);
  assert.equal(state.calls.qq, 1);
});

test("native reply and return outbox creation roll back together on SQLite insertion failure", async context => {
  const state = await fixture(context);
  const insertDelivery = state.store.insertDelivery.bind(state.store);
  state.store.insertDelivery = record => {
    if (record.target_key === identityKey(source)) throw new Error("synthetic-return-write-failed");
    return insertDelivery(record);
  };
  await assert.rejects(state.core.pollReplies(), /synthetic-return-write-failed/);
  assert.equal(state.core.hasReply(state.original.message.message_id), false);
  assert.equal(state.forwards().length, 0);
  assert.equal(state.calls.received.length, 0);
  state.store.insertDelivery = insertDelivery;
  await state.core.pollReplies();
  await state.core.drain();
  assert.equal(state.forwards().length, 1);
  assert.equal(state.calls.received.length, 1);
});

test("restart dispatches a committed return outbox when the old enqueue never ran", async context => {
  const state = await fixture(context);
  state.core.enqueue = async () => {};
  await state.core.pollReplies();
  const [pending] = state.forwards();
  assert.equal(pending.delivery.status, "prepared");
  await state.reopen();
  assert.equal(state.forwards()[0].delivery.delivery_id, pending.delivery.delivery_id);
  assert.equal(state.forwards()[0].delivery.status, "accepted");
  assert.equal(state.calls.received.length, 1);
});

test("unknown return submission is queried under its original identity after restart, never resent", async context => {
  const state = await fixture(context, { availability: "unknown" });
  await state.core.pollReplies();
  await state.core.drain();
  const [unknown] = state.forwards();
  assert.equal(unknown.delivery.status, "unknown");
  state.setMode("ready");
  await state.reopen();
  assert.equal(state.forwards()[0].delivery.delivery_id, unknown.delivery.delivery_id);
  assert.equal(state.forwards()[0].delivery.status, "accepted");
  assert.equal(state.calls.attempts, 1);
  assert.equal(state.calls.received.length, 1);
  assert.equal(state.calls.queries, 1);
});

test("changed return binding fails before any new host submission", async context => {
  const state = await fixture(context, { availability: "absent" });
  await state.core.pollReplies();
  await state.core.drain();
  const [originalForward] = state.forwards();
  state.targets[1].binding_generation += 1;
  state.setMode("ready");
  await state.core.dispatchPending();
  assert.equal(state.forwards()[0].delivery.delivery_id, originalForward.delivery.delivery_id);
  assert.equal(state.forwards()[0].delivery.status, "failed_before_send");
  assert.equal(state.calls.received.length, 0);
});

test("expired return message remains readable without retrying the absent source", async context => {
  const state = await fixture(context, { availability: "absent" });
  await state.core.pollReplies();
  await state.core.drain();
  const [originalForward] = state.forwards();
  state.advance(120000);
  state.setMode("ready");
  await state.core.dispatchPending();
  const [expired] = state.forwards();
  assert.equal(expired.delivery.delivery_id, originalForward.delivery.delivery_id);
  assert.equal(expired.delivery.status, "expired");
  assert.equal(state.calls.attempts, 1);
});

test("revoked owner sender blocks a prepared return under its original IDs before first host input", async context => {
  const state = await fixture(context, { availability: "absent" });
  await state.core.pollReplies();
  await state.core.drain();
  const [before] = state.forwards();
  state.setMode("ready");
  await state.reopen([{ ...rule, owner_sender_allowlist: ["90002"] }]);
  const [after] = state.forwards();
  assert.equal(after.message.message_id, before.message.message_id);
  assert.equal(after.delivery.delivery_id, before.delivery.delivery_id);
  assert.equal(after.delivery.status, "failed_before_send");
  assert.equal(after.delivery.error.code, "source_unverified");
  assert.equal(state.calls.received.length, 0);
  assert.equal(state.calls.attempts, 1);
});

test("revoked owner sender never prevents querying an already unknown original submission", async context => {
  const state = await fixture(context, { availability: "unknown" });
  await state.core.pollReplies();
  await state.core.drain();
  const [before] = state.forwards();
  state.setMode("ready");
  await state.reopen([{ ...rule, owner_sender_allowlist: ["90002"] }]);
  const [after] = state.forwards();
  assert.equal(after.delivery.delivery_id, before.delivery.delivery_id);
  assert.equal(after.delivery.status, "accepted");
  assert.equal(state.calls.attempts, 1);
  assert.equal(state.calls.received.length, 1);
  assert.equal(state.calls.queries, 1);
});

test("public AG principal cannot forge the internal human reply identity", async context => {
  const state = await fixture(context);
  await assert.rejects(state.core.sendMessage({ principal_id: principal.id }, { ...state.input, origin: { ...state.input.origin, kind: "human_message" }, dedupe_key: "forged-human" }), { code: "source_unverified" });
  await assert.rejects(state.core.sendMessage({ principal_id: principal.id }, { ...state.input, caller: owner, dedupe_key: "forged-owner" }), { code: "caller_mismatch" });
  assert.equal(state.forwards().length, 0);
});

test("explicit exact-event adoption recovers the existing genuine reply once and keeps its return IDs", async context => {
  const state = await fixture(context, { enabled: false });
  await state.core.pollReplies();
  const adoption = { ...rule, adopt_reply_events: [{ message_id: state.original.message.message_id, native_event_id: nativeEventId }] };
  await state.reopen([adoption]);
  const [first] = state.forwards();
  assert.equal(first.delivery.status, "accepted");
  await state.reopen([adoption]);
  assert.equal(state.forwards()[0].message.message_id, first.message.message_id);
  assert.equal(state.forwards()[0].delivery.delivery_id, first.delivery.delivery_id);
  assert.equal(state.calls.received.length, 1);
  assert.equal(state.calls.qq, 1);
});

test("exact-event adoption refuses an unrelated native event without host input", async context => {
  const state = await fixture(context, { enabled: false });
  await state.core.pollReplies();
  await assert.rejects(state.reopen([{ ...rule, adopt_reply_events: [{ message_id: state.original.message.message_id, native_event_id: "different-native-event" }] }]), { code: "invalid_forward_recovery" });
  assert.equal(state.calls.received.length, 0);
});
