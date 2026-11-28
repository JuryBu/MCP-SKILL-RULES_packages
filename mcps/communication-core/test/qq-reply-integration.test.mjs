import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { NapcatOwnerAdapter } from "../src/adapters/napcat-owner.mjs";

const source = { machine_id: "synthetic-machine", host: "antigravity", surface: "desktop", conversation_id: "synthetic-ag-source" };
const target = { machine_id: "synthetic-machine", host: "qq", surface: "group", conversation_id: "synthetic-owner-target", binding_id: "synthetic-owner-binding", binding_generation: 3, adapter_id: "synthetic-owner", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic-provider" };
const principal = { id: "synthetic-source", identity: source, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] };
const route = { route_key: "synthetic-route", conversation_id: "synthetic-maintenance-caller", target_key: target.conversation_id, generation: 7 };

async function fixture(testContext, { enabled = true, eventPatch = {}, pagePatch = {}, capturePatch = {}, captureMissing = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-qq-reply-"));
  const databasePath = join(directory, "core.sqlite");
  const calls = { sends: 0, reads: 0, acknowledgements: 0 };
  const transport = {
    async status() { return { ready: true }; },
    async sendOwnerAlert() { calls.sends += 1; return { ok: true, sent: true, verified: true, statePersisted: true, target: { targetKey: target.conversation_id }, messageId: "80001", ...(captureMissing ? {} : { replyRoute: { messageId: "80001", routeKey: route.route_key, conversationId: route.conversation_id, targetKey: route.target_key, ownerEventGeneration: route.generation, ...capturePatch } }) }; },
    async readOwnerEvents(parameters, context) {
      calls.reads += 1;
      assert.equal(context.conversationId, route.conversation_id);
      assert.notEqual(context.conversationId, source.conversation_id);
      assert.equal(parameters.original_qq_message_id, "80001");
      assert.equal(parameters.expected_route_generation, 7);
      return { ok: true, route: { ...route }, original_qq_message_id: "80001", events: [{ event_id: "synthetic-native-event", message_id: "80002", message_seq: 321, quoted_message_id: "80001", sender_id: "90001", text: "原QQ回复保持完整", ...eventPatch }], next_cursor: null, partial: false, ...pagePatch };
    },
  };
  const adapter = new NapcatOwnerAdapter({ transport, routeKey: route.route_key, conversationId: route.conversation_id, replyEvents: enabled ? { enabled: true, callerConversationId: route.conversation_id, targetKey: route.target_key, routeGeneration: route.generation, ownerSenderAllowlist: ["90001"] } : { enabled: false } });
  let store = new MessageStore({ filePath: databasePath });
  let core = new CommunicationCore({ store, targets: [target], principals: [principal], adapters: { [target.adapter_id]: adapter } });
  testContext.after(async () => { await core.close(); store.close(); await adapter.close(); rmSync(directory, { recursive: true, force: true }); });
  await core.start();
  const input = { caller: source, origin: { kind: "agent_message", channel: "test", source_ref: "synthetic-original" }, target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation }, text: "请核原通知", dedupe_key: "synthetic-quote-original", expires_at: "2031-01-01T00:00:00Z" };
  const original = await core.sendMessage({ principal_id: principal.id }, input);
  await core.drain();
  return { original, calls, get core() { return core; }, async reopen() { await core.close(); store.close(); store = new MessageStore({ filePath: databasePath }); core = new CommunicationCore({ store, targets: [target], principals: [principal], adapters: { [target.adapter_id]: adapter } }); await core.start(); return core.sendMessage({ principal_id: principal.id }, input); } };
}

async function waitForReply(context) {
  return context.core.wait({ principal_id: principal.id }, { caller: source, message_id: context.original.message.message_id, until: "reply", wait_ms: 0 });
}

test("QQ exact quote flows through adapter, core and durable reply with a different AG origin", async testContext => {
  const context = await fixture(testContext);
  assert.equal((await context.core.pollReplies()).replies, 1);
  const reply = (await waitForReply(context)).events.find(event => event.kind === "reply");
  assert.equal(reply.data.text, "原QQ回复保持完整");
  assert.deepEqual(reply.data.native_source.route, route);
  assert.equal(reply.data.native_source.original_qq_message_id, "80001");
  assert.equal(reply.data.native_source.event.sender_id, "90001");
  assert.deepEqual(context.core.result(context.original.message.message_id).delivery.evidence.evidence.native_receipt.reply_route, route);
  assert.equal(context.core.result(context.original.message.message_id).message.processing, "pending");
  assert.equal((await context.core.pollReplies()).replies, 0);
  const reopened = await context.reopen();
  assert.equal(reopened.duplicate, true);
  assert.equal(reopened.message.message_id, context.original.message.message_id);
  assert.equal(reopened.delivery.delivery_id, context.original.delivery.delivery_id);
  assert.equal((await waitForReply(context)).events.filter(event => event.kind === "reply").length, 1);
  await context.core.pollReplies();
  assert.deepEqual(context.calls, { sends: 1, reads: 1, acknowledgements: 0 });
});

test("QQ reply runtime remains opt-in with zero reads while disabled", async testContext => {
  const context = await fixture(testContext, { enabled: false });
  assert.equal((await context.core.pollReplies()).replies, 0);
  assert.equal((await waitForReply(context)).matched, false);
  assert.deepEqual(context.calls, { sends: 1, reads: 0, acknowledgements: 0 });
});

for (const [name, options] of [
  ["legacy notification without capture provenance", { captureMissing: true }],
  ["captured wrong original", { capturePatch: { messageId: "80003" } }],
  ["captured wrong caller", { capturePatch: { conversationId: "another-caller" } }],
  ["captured wrong route", { capturePatch: { routeKey: "another-route" } }],
  ["captured wrong target", { capturePatch: { targetKey: "another-target" } }],
  ["captured wrong generation", { capturePatch: { ownerEventGeneration: 8 } }],
]) {
  test(`QQ ${name} preserves delivery acceptance and performs zero reply reads`, async testContext => {
    const context = await fixture(testContext, options);
    assert.equal(context.core.result(context.original.message.message_id).delivery.status, "accepted");
    assert.equal((await context.core.pollReplies()).replies, 0);
    assert.equal((await waitForReply(context)).matched, false);
    assert.deepEqual(context.calls, { sends: 1, reads: 0, acknowledgements: 0 });
  });
}

for (const [name, options] of [
  ["foreign sender", { eventPatch: { sender_id: "90002" } }],
  ["foreign original quote", { eventPatch: { quoted_message_id: "80003" } }],
  ["foreign provider generation", { pagePatch: { route: { ...route, generation: 8 } } }],
  ["foreign caller route", { pagePatch: { route: { ...route, conversation_id: source.conversation_id } } }],
]) {
  test(`QQ ${name} never completes the original wait or acknowledges a channel`, async testContext => {
    const context = await fixture(testContext, options);
    assert.equal((await context.core.pollReplies()).replies, 0);
    assert.equal((await waitForReply(context)).matched, false);
    assert.equal(context.calls.acknowledgements, 0);
    assert.equal(context.core.result(context.original.message.message_id).message.processing, "pending");
  });
}

test("450 aged QQ deliveries never starve a brand-new QQ reply while aged deliveries still rotate slowly", async testContext => {
  const directory = mkdtempSync(join(tmpdir(), "communication-qq-backlog-"));
  const databasePath = join(directory, "core.sqlite");
  let clockMs = Date.parse("2030-01-01T00:00:00Z");
  let nextQqMsgId = 90000;
  let newestQqMsgId = null;
  const readLog = [];
  const transport = {
    async status() { return { ready: true }; },
    async sendOwnerAlert() {
      const msgId = String(++nextQqMsgId);
      return {
        ok: true, sent: true, verified: true, statePersisted: true,
        target: { targetKey: target.conversation_id },
        messageId: msgId,
        replyRoute: { messageId: msgId, routeKey: route.route_key, conversationId: route.conversation_id, targetKey: route.target_key, ownerEventGeneration: route.generation },
      };
    },
    async readOwnerEvents(parameters) {
      readLog.push(parameters.original_qq_message_id);
      if (parameters.original_qq_message_id === newestQqMsgId) {
        return {
          ok: true,
          route: { ...route },
          original_qq_message_id: newestQqMsgId,
          events: [{ event_id: "evt-newest", message_id: "999999", message_seq: 1, quoted_message_id: newestQqMsgId, sender_id: "90001", text: "最新QQ秒回" }],
          next_cursor: null,
          partial: false,
        };
      }
      return { ok: true, route: { ...route }, original_qq_message_id: parameters.original_qq_message_id, events: [], next_cursor: null, partial: false };
    },
  };
  const adapter = new NapcatOwnerAdapter({
    transport,
    routeKey: route.route_key,
    conversationId: route.conversation_id,
    replyEvents: { enabled: true, callerConversationId: route.conversation_id, targetKey: route.target_key, routeGeneration: route.generation, ownerSenderAllowlist: ["90001"] },
  });
  const store = new MessageStore({ filePath: databasePath });
  const core = new CommunicationCore({
    store,
    targets: [target],
    principals: [principal],
    adapters: { [target.adapter_id]: adapter },
    now: () => clockMs,
    maxConcurrent: 2,
  });
  testContext.after(async () => { await core.close(); store.close(); await adapter.close(); rmSync(directory, { recursive: true, force: true }); });
  await core.start();

  // Seed 450 historical un-replied accepted QQ deliveries directly into SQLite (mimicking production core.sqlite)
  const agedIso = new Date(clockMs).toISOString();
  const targetSnapshot = { ...target };
  store.transaction(() => {
    for (let i = 0; i < 450; i += 1) {
      const msgId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const delivId = `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
      const qqId = String(50000 + i);
      store.insertMessage({
        message_id: msgId,
        source_key: JSON.stringify([source.machine_id, source.host, source.surface, source.conversation_id]),
        target_key: JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id]),
        dedupe_key: `aged-qq-${i}`,
        payload_hash: `hash-${i}`,
        principal_id: principal.id,
        envelope: {
          caller: source,
          origin: { kind: "agent_message", channel: "test", source_ref: `aged-${i}` },
          target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation },
          text: `历史旧通知 ${i}`,
          dedupe_key: `aged-qq-${i}`,
          reply_required: false,
          attachment_refs: [],
          delivery_policy: "next_model_boundary",
          expires_at: "2031-01-01T00:00:00Z",
        },
        created_at: agedIso,
        delivery_status: "accepted",
      });
      store.insertDelivery({
        delivery_id: delivId,
        message_id: msgId,
        target_key: JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id]),
        target_snapshot: targetSnapshot,
        status: "accepted",
        attempt_count: 1,
        evidence: {
          outcome: "accepted",
          delivery_id: delivId,
          target_key: JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id]),
          evidence: {
            kind: "receipt",
            native_receipt: {
              provider: "napcat_owner",
              message_id: qqId,
              verified: true,
              state_persisted: true,
              reply_route: { ...route },
            },
          },
        },
        created_at: agedIso,
        updated_at: agedIso,
      });
    }
  });

  // Advance 20 minutes (> 15m QQ recent window), then send 1 brand-new QQ notification
  clockMs += 20 * 60 * 1000;
  const fresh = await core.sendMessage({ principal_id: principal.id }, {
    caller: source,
    origin: { kind: "agent_message", channel: "test", source_ref: "fresh-qq" },
    target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation },
    text: "最新需要快速收回复的QQ通知",
    dedupe_key: "fresh-qq-notice",
    reply_required: false,
    expires_at: "2031-01-01T00:00:00Z",
  });
  await core.drain();
  newestQqMsgId = core.result(fresh.message.message_id).delivery.evidence.evidence.native_receipt.message_id;

  const t0 = performance.now();
  const polled = await core.pollReplies();
  const elapsedMs = performance.now() - t0;

  assert.equal(polled.replies, 1, "fresh QQ reply must be captured on the very first poll");
  assert.equal(readLog[0], newestQqMsgId, "fresh QQ hot pool must be probed before any of the 450 aged deliveries");
  assert.ok(readLog.length <= 2, `expected <= 2 RPC reads (1 fresh + at most 1 slow-lane aged), got ${readLog.length}`);
  assert.ok(elapsedMs < 2000, `poll with 450 aged deliveries should complete quickly, took ${Math.round(elapsedMs)}ms`);

  // Second poll within 5s passive gap performs 0 RPC reads (replied fresh is cached, aged slow lane respects 5s gap)
  readLog.length = 0;
  assert.deepEqual(await core.pollReplies(), { checked: 0, replies: 0 });
  assert.equal(readLog.length, 0);

  // After 5s gap, slow lane visits the next aged delivery (zero starvation / never permanently dropped)
  clockMs += 5001;
  await core.pollReplies();
  assert.equal(readLog.length, 1);
  assert.notEqual(readLog[0], newestQqMsgId);
  testContext.diagnostic(`450 aged + 1 fresh QQ poll elapsed=${Math.round(elapsedMs)}ms, first-round reads=2 (fresh first)`);

  // Restart recovery: send another recent QQ notification, close & reopen Core -> start() must warm hot pool before 450 aged records!
  const beforeRestart = await core.sendMessage({ principal_id: principal.id }, {
    caller: source,
    origin: { kind: "agent_message", channel: "test", source_ref: "pre-restart-qq" },
    target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation },
    text: "重启前刚发出的QQ通知",
    dedupe_key: "pre-restart-qq-notice",
    reply_required: false,
    expires_at: "2031-01-01T00:00:00Z",
  });
  await core.drain();
  newestQqMsgId = core.result(beforeRestart.message.message_id).delivery.evidence.evidence.native_receipt.message_id;

  await core.close();
  store.close();
  const store2 = new MessageStore({ filePath: databasePath });
  const core2 = new CommunicationCore({
    store: store2,
    targets: [target],
    principals: [principal],
    adapters: { [target.adapter_id]: adapter },
    now: () => clockMs,
    maxConcurrent: 2,
  });
  try {
    await core2.start();
    readLog.length = 0;
    const afterRestart = await core2.pollReplies();
    assert.equal(afterRestart.replies, 1, "reopened Core must warm hot pool from SQLite and capture recent QQ reply immediately");
    assert.equal(readLog[0], newestQqMsgId);
    assert.ok(readLog.length <= 2);
  } finally {
    await core2.close();
    store2.close();
  }
});
