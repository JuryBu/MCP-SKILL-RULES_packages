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
