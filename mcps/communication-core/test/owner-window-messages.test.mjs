import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { digest, identityKey, normalizeIdentity } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";

function fixture(targetHost = "codex") {
  const root = mkdtempSync(join(tmpdir(), "core-owner-window-"));
  const source = { machine_id: "synthetic-machine", host: "qq", surface: "group", conversation_id: "synthetic-members",
    binding_id: "synthetic-qq-binding", binding_generation: 1, adapter_id: "synthetic-qq",
    capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic" };
  const target = { machine_id: "synthetic-machine", host: targetHost, surface: "desktop", conversation_id: "synthetic-model",
    binding_id: "synthetic-model-binding", binding_generation: 3, adapter_id: "synthetic-model",
    capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic" };
  const second = { ...target, conversation_id: "synthetic-model-2", binding_id: "synthetic-model-binding-2" };
  const window = { channel: "qq", type: "group", id: "90002", self_id: "90003" };
  const windowKey = `window:${digest(["qq", "synthetic-component", "group", window.id])}`;
  const sourceSpec = { window_key: windowKey, channel: "qq", component: "synthetic-component", window_type: "group", window_id: window.id,
    channel_binding_id: source.binding_id, target_key: source.conversation_id, route_key: "synthetic-window-route",
    conversation_id: "synthetic-component-cid", source_target: source, owner_sender_allowlist: ["90001"] };
  const native = { event_id: "a".repeat(64), message_id: "12345", message_seq: 8, sender_id: "90001", text: "  原生窗口正文\n保持原样  ",
    content: "  原生窗口正文\n保持原样  ", source_kind: "human_message", route_key: sourceSpec.route_key, conversation_id: sourceSpec.conversation_id,
    target_key: source.conversation_id, route_generation: 2, window, owner_sender_allowlist: ["90001"],
    window_binding: { generation: 7, owner_key: identityKey(target), target: { ...normalizeIdentity(target), binding_id: target.binding_id, binding_generation: target.binding_generation } } };
  const sent = [];
  const cores = [];
  const stores = [];
  let now = Date.parse("2026-11-16T00:00:00Z");
  const open = ({ sources = [sourceSpec], sendOutcome = "accepted" } = {}) => {
    const store = new MessageStore({ filePath: join(root, "messages.sqlite") });
    stores.push(store);
    const adapter = { submissionTracking: true, async deliver({ message, delivery, target: resolved, onRequestStarted }) {
      onRequestStarted(); sent.push(structuredClone({ message, delivery, target: resolved }));
      return { outcome: sendOutcome, delivery_id: delivery.delivery_id, target_key: delivery.target_key, evidence: { kind: "receipt" } };
    }, async query({ delivery }) { return { outcome: "accepted", delivery_id: delivery.delivery_id, target_key: delivery.target_key, evidence: { kind: "query" } }; } };
    const core = new CommunicationCore({ store, targets: [source, target, second],
      principals: [{ id: "synthetic-model-principal", identity: normalizeIdentity(target), allowed_targets: [source.binding_id, second.binding_id], origin_kinds: ["agent_message"] }],
      adapters: { "synthetic-model": adapter, "synthetic-qq": adapter }, ownerWindowSources: sources, now: () => now });
    cores.push(core);
    return { core, store };
  };
  return { root, source, target, second, window, windowKey, sourceSpec, native, sent, open,
    context: { window_key: windowKey, native_route: { window } }, advance: milliseconds => { now += milliseconds; },
    async close() { for (const core of cores) await core.close(); for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); } };
}

test("native window admission preserves original source, text, frozen target and default policy", async () => {
  const setup = fixture();
  try {
    const { core, store } = setup.open();
    const result = await core.ingestOwnerWindowEvent(setup.native, setup.context);
    assert.equal(result.persisted, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.message.envelope.text, setup.native.text);
    assert.equal(result.message.envelope.origin.kind, "human_message");
    assert.equal(result.message.envelope.origin.channel, "napcat_owner_window");
    assert.equal(result.message.envelope.delivery_policy, "next_model_boundary");
    assert.equal(result.message.envelope.message_visibility, "hidden");
    assert.equal(result.message.envelope.in_reply_to, null);
    assert.equal(result.message.envelope.origin_receipt_binding, null);
    assert.equal(result.message.forward_of, undefined);
    assert.equal(result.message.source_key, identityKey(setup.source));
    assert.equal(result.message.target_key, identityKey(setup.target));
    assert.deepEqual(result.message.native_window_source.window_binding, setup.native.window_binding);
    assert.deepEqual(result.delivery.target_snapshot, setup.target);
    await core.drain();
    assert.equal(setup.sent.length, 1);
    assert.equal(store.getDelivery(result.delivery.delivery_id).status, "accepted");
    assert.equal(store.eventsAfter(result.message.message_id, 0, 100).filter(event => event.kind === "message_created").length, 1);
  } finally { await setup.close(); }
});

test("page-prefix replay and later duplicate keep the original IDs and expiry", async () => {
  const setup = fixture();
  try {
    const { core } = setup.open();
    const original = await core.ingestOwnerWindowEvent(setup.native, setup.context);
    await core.drain();
    setup.advance(86400001);
    const duplicate = await core.ingestOwnerWindowEvent(structuredClone(setup.native), structuredClone(setup.context));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.message_id, original.message.message_id);
    assert.equal(duplicate.delivery.delivery_id, original.delivery.delivery_id);
    assert.equal(duplicate.message.envelope.expires_at, original.message.envelope.expires_at);
    assert.equal(setup.sent.length, 1);
  } finally { await setup.close(); }
});

for (const [name, change] of [
  ["text", event => { event.text = "修改"; event.content = event.text; }],
  ["frozen target", (event, setup) => { event.window_binding.target = { ...normalizeIdentity(setup.second), binding_id: setup.second.binding_id, binding_generation: setup.second.binding_generation }; event.window_binding.owner_key = identityKey(setup.second); }],
  ["native message id", event => { event.message_id = "99999"; }],
  ["window binding generation", event => { event.window_binding.generation += 1; }],
]) test(`same native event rejects changed ${name}`, async () => {
  const setup = fixture();
  try {
    const { core } = setup.open();
    await core.ingestOwnerWindowEvent(setup.native, setup.context);
    await core.drain();
    const modified = structuredClone(setup.native);
    change(modified, setup);
    await assert.rejects(core.ingestOwnerWindowEvent(modified, setup.context), { code: "dedupe_conflict" });
    assert.equal(setup.sent.length, 1);
  } finally { await setup.close(); }
});

test("Antigravity receives a native window human message without forged quote metadata", async () => {
  const setup = fixture("antigravity");
  try {
    const { core, store } = setup.open();
    const calls = [];
    core.adapters[setup.target.adapter_id] = new AntigravityDeliveryAdapter({ transport: {
      submissionTracking: true,
      async describe(target) { return { cascade_id: target.conversation_id, trajectory_id: "synthetic-trajectory", status: "CASCADE_RUN_STATUS_RUNNING" }; },
      async call(method, payload, options) { options?.onRequestStarted?.(); calls.push({ method, payload }); return {}; },
      async readSteps() { return { steps: [] }; },
    } });
    const original = await core.ingestOwnerWindowEvent(setup.native, setup.context);
    await core.drain();
    assert.equal(store.getDelivery(original.delivery.delivery_id).status, "accepted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.deliveryStrategy, "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION");
    assert.equal(calls[0].payload.clientMessageId, original.delivery.delivery_id);
    assert.ok(calls[0].payload.items[0].text.startsWith("主人在QQ窗口中的来信"));
    assert.ok(calls[0].payload.items[0].text.endsWith(setup.native.text));
    assert.equal(calls[0].payload.items[0].text.includes("引用的原交流核心消息"), false);
  } finally { await setup.close(); }
});

test("Antigravity window rendering rejects an altered frozen event before native send", async () => {
  const setup = fixture("antigravity");
  try {
    const { core } = setup.open(); core.maxConcurrent = 0;
    const original = await core.ingestOwnerWindowEvent(setup.native, setup.context);
    const adapter = new AntigravityDeliveryAdapter({ transport: {
      async describe(target) { return { cascade_id: target.conversation_id, trajectory_id: "synthetic-trajectory" }; },
      async call() { assert.fail("altered record must not reach native send"); }, async readSteps() { return { steps: [] }; },
    } });
    const message = structuredClone(original.message); message.native_window_source.event.text = "篡改正文";
    const result = await adapter.deliver({ message, delivery: original.delivery, target: setup.target });
    assert.equal(result.outcome, "failed_before_send");
  } finally { await setup.close(); }
});

test("frozen event ignores a newer model window mapping", async () => {
  const setup = fixture();
  try {
    const { core, store } = setup.open();
    store.putChannelBinding({ window_key: setup.windowKey, target: setup.second }, { ownerKey: identityKey(setup.second), expectedGeneration: 0 });
    const result = await core.ingestOwnerWindowEvent(setup.native, setup.context);
    await core.drain();
    assert.equal(result.message.target_key, identityKey(setup.target));
    assert.equal(setup.sent[0].target.conversation_id, setup.target.conversation_id);
    assert.equal(store.getChannelBinding(setup.windowKey).target.conversation_id, setup.second.conversation_id);
  } finally { await setup.close(); }
});

test("prepared native window survives SQLite close/reopen without enabled capture or remapping", async () => {
  const setup = fixture();
  try {
    const first = setup.open();
    first.core.maxConcurrent = 0;
    const original = await first.core.ingestOwnerWindowEvent(setup.native, setup.context);
    await first.core.close(); first.store.close();
    const reopened = setup.open();
    await reopened.core.start(); await reopened.core.drain();
    assert.equal(setup.sent.length, 1);
    assert.equal(setup.sent[0].message.message_id, original.message.message_id);
    assert.equal(setup.sent[0].delivery.delivery_id, original.delivery.delivery_id);
    const duplicate = await reopened.core.ingestOwnerWindowEvent(setup.native, setup.context);
    assert.equal(duplicate.duplicate, true);
  } finally { await setup.close(); }
});

test("unknown window submission recovers only by query with the original IDs", async () => {
  const setup = fixture();
  try {
    const first = setup.open({ sendOutcome: "unknown" });
    const original = await first.core.ingestOwnerWindowEvent(setup.native, setup.context);
    await first.core.drain(); await first.core.close(); first.store.close();
    const reopened = setup.open({ sources: [] });
    await reopened.core.start(); await reopened.core.drain();
    assert.equal(reopened.store.getDelivery(original.delivery.delivery_id).status, "accepted");
    assert.equal(setup.sent.length, 1);
  } finally { await setup.close(); }
});

test("prepared window fails safely if its configured source authorization is removed", async () => {
  const setup = fixture();
  try {
    const first = setup.open(); first.core.maxConcurrent = 0;
    const original = await first.core.ingestOwnerWindowEvent(setup.native, setup.context);
    await first.core.close(); first.store.close();
    const reopened = setup.open({ sources: [] });
    await reopened.core.start(); await reopened.core.drain();
    assert.equal(setup.sent.length, 0);
    assert.equal(reopened.store.getDelivery(original.delivery.delivery_id).status, "failed_before_send");
    assert.ok(reopened.store.getMessage(original.message.message_id));
  } finally { await setup.close(); }
});

test("caller cannot manufacture a human window message through public send", async () => {
  const setup = fixture();
  try {
    const { core } = setup.open();
    await assert.rejects(core.sendMessage({ principal_id: "synthetic-model-principal" }, {
      caller: normalizeIdentity(setup.target), target: { ...normalizeIdentity(setup.second), binding_id: setup.second.binding_id, binding_generation: setup.second.binding_generation },
      origin: { kind: "human_message", channel: "napcat_owner_window", source_ref: "synthetic-forgery" },
      dedupe_key: "synthetic-forgery", text: "合成伪造", expires_at: "2026-11-17T00:00:00Z",
    }), { code: "source_unverified" });
  } finally { await setup.close(); }
});

test("model replies to the admitted window source through the original QQ target", async () => {
  const setup = fixture();
  try {
    const { core } = setup.open();
    const original = await core.ingestOwnerWindowEvent(setup.native, setup.context);
    await core.drain();
    const reply = await core.sendMessage({ principal_id: "synthetic-model-principal" }, {
      caller: normalizeIdentity(setup.target), target: { ...normalizeIdentity(setup.source), binding_id: setup.source.binding_id, binding_generation: setup.source.binding_generation },
      origin: { kind: "agent_message", channel: "codex", source_ref: "synthetic-model-reply" }, dedupe_key: "synthetic-reply",
      text: "收到原窗口消息", expires_at: "2026-11-17T00:00:00Z", in_reply_to: original.message.message_id,
    });
    await core.drain();
    assert.equal(reply.message.target_key, original.message.source_key);
    assert.equal(reply.message.envelope.in_reply_to, original.message.message_id);
    assert.equal(setup.sent[1].target.host, "qq");
  } finally { await setup.close(); }
});

for (const [name, change] of [
  ["window", event => { event.window.id = "90004"; }],
  ["sender", event => { event.sender_id = "90004"; }],
  ["source route", event => { event.route_key = "synthetic-foreign-route"; }],
  ["source component", event => { event.conversation_id = "synthetic-foreign-component"; }],
]) test(`untrusted ${name} is rejected before any persistent message`, async () => {
  const setup = fixture();
  try {
    const { core, store } = setup.open();
    const modified = structuredClone(setup.native); change(modified);
    await assert.rejects(core.ingestOwnerWindowEvent(modified, setup.context));
    assert.equal(store.listDeliveries({ limit: 100 }).length, 0);
    assert.equal(setup.sent.length, 0);
  } finally { await setup.close(); }
});
