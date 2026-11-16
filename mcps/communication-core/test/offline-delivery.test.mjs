import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";
import { identityKey } from "../src/contracts.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";

const SOURCE = { machine_id: "offline-test", host: "codex", surface: "desktop", conversation_id: "sender-a" };
const TARGET = {
  machine_id: "offline-test", host: "antigravity", surface: "desktop", conversation_id: "receiver-b",
  binding_id: "offline-binding", binding_generation: 7, adapter_id: "offline-adapter",
  capabilities: { next_model_boundary: true, when_idle: true }, evidence: "isolated-offline-test",
};
const SOURCE_CONTEXT = { principal_id: "offline-sender" };

function simulatedReceiver(failurePoint = "describe") {
  const state = { online: false, ambiguousWrite: false, queryReceipt: "original", descriptions: [], calls: [], writes: [], reads: [] };
  const transport = {
    async describe(target) {
      state.descriptions.push(structuredClone(target));
      if (!state.online && failurePoint === "describe") throw new Error("simulated receiver is not started");
      return { cascade_id: target.conversation_id, trajectory_id: "offline-trajectory", status: "idle", step_count: state.writes.length };
    },
    async call(method, payload, options) {
      const invocation = { method, payload: structuredClone(payload), target: structuredClone(options.target) };
      state.calls.push(invocation);
      if (!state.online) throw Object.assign(new Error("simulated refusal before write"), { requestSent: false });
      state.writes.push(invocation);
      if (state.ambiguousWrite) {
        state.ambiguousWrite = false;
        throw new Error("simulated response lost after acceptance");
      }
      return {};
    },
    async readSteps(target) {
      state.reads.push(structuredClone(target));
      return { steps: state.writes.map((invocation, index) => ({
        index, type: "user_input",
        user_input: { client_message_id: state.queryReceipt === "original" ? invocation.payload.clientMessageId : "unrelated-delivery" },
      })) };
    },
  };
  return { state, transport };
}

function reference(request) {
  return {
    message_id: request.message.message_id, delivery_id: request.delivery.delivery_id,
    target_key: request.delivery.target_key, target: structuredClone(request.target),
  };
}

async function fixture(testContext, receiver, { lifetimeMs = 60000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-offline-delivery-"));
  const filePath = join(directory, "messages.sqlite");
  const clock = { now: Date.parse("2035-01-01T00:00:00Z") };
  const targets = [structuredClone(TARGET)];
  const principals = [{ id: SOURCE_CONTEXT.principal_id, identity: SOURCE, allowed_targets: [TARGET.binding_id], origin_kinds: ["agent_message"] }];
  const invocations = { deliveries: [], queries: [] };
  const adapter = new AntigravityDeliveryAdapter({ transport: receiver.transport });
  const adapters = { [TARGET.adapter_id]: {
    deliver(request) { invocations.deliveries.push(reference(request)); return adapter.deliver(request); },
    query(request) { invocations.queries.push(reference(request)); return adapter.query(request); },
  } };
  const resources = [];
  let current;
  const open = async () => {
    const store = new MessageStore({ filePath });
    const core = new CommunicationCore({ store, targets, principals, adapters, now: () => clock.now, deliveryTimeoutMs: 1000 });
    current = { core, store };
    resources.push(current);
    await core.start();
    await core.drain();
  };
  testContext.after(async () => {
    try {
      for (const resource of resources) {
        await resource.core.close();
        resource.store.close();
        assert.equal(resource.core.controllers.size, 0);
        assert.equal(resource.core.waiters.size, 0);
        assert.equal(resource.core.jobs.size, 0);
      }
    } finally {
      for (const resource of resources) resource.store.close();
      rmSync(directory, { recursive: true, force: true });
      assert.equal(existsSync(directory), false);
      testContext.diagnostic(`offline fixture removed: ${directory}`);
    }
  });
  await open();
  const input = {
    caller: SOURCE, origin: { kind: "agent_message", channel: "offline-test", source_ref: "synthetic-source-event" },
    target: {
      machine_id: TARGET.machine_id, host: TARGET.host, surface: TARGET.surface, conversation_id: TARGET.conversation_id,
      binding_id: TARGET.binding_id, binding_generation: TARGET.binding_generation,
    },
    text: "发送给尚未启动的原接收者", dedupe_key: "original-offline-message", delivery_policy: "next_model_boundary",
    expires_at: new Date(clock.now + lifetimeMs).toISOString(),
  };
  return {
    get core() { return current.core; },
    get store() { return current.store; },
    clock, targets, invocations, input,
    async reopen() { await current.core.close(); current.store.close(); await open(); },
    async send() { const result = await current.core.sendMessage(SOURCE_CONTEXT, input); await current.core.drain(); return result; },
    snapshot(original) { return current.core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: original.message.message_id }); },
    async deliveryEvents(original) {
      return current.core.wait(SOURCE_CONTEXT, { caller: SOURCE, message_id: original.message.message_id, after_cursor: original.next_cursor, until: "delivery", wait_ms: 0 });
    },
  };
}

function assertOriginalIdentity(context, original) {
  const current = context.snapshot(original);
  assert.equal(current.message.message_id, original.message.message_id);
  assert.equal(current.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(current.delivery.message_id, original.message.message_id);
  assert.equal(current.delivery.target_key, identityKey(TARGET));
  assert.deepEqual(current.message.envelope.target, context.input.target);
  assert.deepEqual(current.delivery.target_snapshot, TARGET);
  for (const invocation of [...context.invocations.deliveries, ...context.invocations.queries]) {
    assert.equal(invocation.message_id, original.message.message_id);
    assert.equal(invocation.delivery_id, original.delivery.delivery_id);
    assert.equal(invocation.target_key, identityKey(TARGET));
    assert.deepEqual(invocation.target, TARGET);
  }
}

for (const failurePoint of ["describe", "submit-before-write"]) {
  test(`offline ${failurePoint}: repeated failures keep exact durable backoff and resume once after SQLite reopens`, async testContext => {
    const receiver = simulatedReceiver(failurePoint);
    const context = await fixture(testContext, receiver);
    const original = await context.send();
    const first = context.snapshot(original);
    assert.equal(first.delivery.status, "prepared");
    assert.equal(first.delivery.error.code, "unavailable");
    assert.equal(first.delivery.evidence.outcome, "busy");
    assert.equal(first.delivery.evidence.evidence.retry_after_ms, 1000);
    assert.equal(first.delivery.attempt_count, 1);
    assert.equal(receiver.state.writes.length, 0);
    const eventCount = context.store.lastSequence(original.message.message_id);
    const firstDeadline = Date.parse(first.delivery.updated_at) + 1000;
    context.clock.now = firstDeadline - 1;
    await context.reopen();
    await context.core.dispatchPending();
    assert.deepEqual(context.snapshot(original).delivery, first.delivery);
    assert.equal(context.store.lastSequence(original.message.message_id), eventCount);
    assert.equal(context.invocations.deliveries.length, 1);
    const duplicate = await context.send();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.delivery.delivery_id, original.delivery.delivery_id);
    assert.equal(context.invocations.deliveries.length, 1);
    context.clock.now = firstDeadline;
    await context.core.dispatchPending();
    const second = context.snapshot(original);
    assert.equal(second.delivery.status, "prepared");
    assert.equal(second.delivery.attempt_count, 2);
    assert.equal(second.delivery.error.code, "unavailable");
    assert.equal(second.delivery.evidence.evidence.retry_after_ms, 2000);
    assert.equal(context.invocations.deliveries.length, 2);
    assert.equal(receiver.state.writes.length, 0);
    const secondDeadline = Date.parse(second.delivery.updated_at) + 2000;
    receiver.state.online = true;
    context.clock.now = secondDeadline - 1;
    await context.reopen();
    await context.core.dispatchPending();
    assert.deepEqual(context.snapshot(original).delivery, second.delivery);
    assert.equal(context.invocations.deliveries.length, 2);
    context.clock.now = secondDeadline;
    await context.core.dispatchPending();
    const accepted = context.snapshot(original);
    assert.equal(accepted.delivery.status, "accepted");
    assert.equal(accepted.delivery.attempt_count, 3);
    assert.equal(receiver.state.writes.length, 1);
    assert.equal(receiver.state.writes[0].payload.clientMessageId, original.delivery.delivery_id);
    assert.equal(receiver.state.writes[0].payload.cascadeId, TARGET.conversation_id);
    assert.equal(receiver.state.writes[0].payload.deliveryStrategy, "MESSAGE_DELIVERY_STRATEGY_NEXT_INVOCATION");
    assert.ok(receiver.state.writes[0].payload.items[0].text.includes(`message_id=${original.message.message_id} delivery_id=${original.delivery.delivery_id}`));
    const observed = await context.deliveryEvents(original);
    assert.equal(observed.matched, true);
    assert.equal(observed.events.filter(event => event.kind === "delivery" && event.data.status === "accepted").length, 1);
    assert.equal(accepted.message.processing, "pending");
    assert.equal(accepted.message.model_observed, "unknown");
    await context.reopen();
    await context.core.dispatchPending();
    assert.equal((await context.send()).duplicate, true);
    assert.equal(receiver.state.writes.length, 1);
    assert.equal(context.store.listDeliveries().length, 1);
    assert.equal(context.invocations.queries.length, 0);
    assertOriginalIdentity(context, original);
  });
}

test("offline unknown: expired and rebound original is queried by its old identity without repeating delivery", async testContext => {
  const receiver = simulatedReceiver();
  receiver.state.online = true;
  receiver.state.ambiguousWrite = true;
  const context = await fixture(testContext, receiver, { lifetimeMs: 500 });
  const original = await context.send();
  assert.equal(context.snapshot(original).delivery.status, "unknown");
  assert.equal(receiver.state.writes.length, 1);
  receiver.state.online = false;
  context.targets[0] = { ...structuredClone(TARGET), conversation_id: "replacement-b", binding_generation: 8 };
  context.clock.now += 1000;
  await context.reopen();
  assert.equal(context.snapshot(original).delivery.status, "unknown");
  assert.equal(context.invocations.queries.length, 1);
  assert.equal(context.invocations.deliveries.length, 1);
  receiver.state.online = true;
  receiver.state.queryReceipt = "unrelated";
  await context.core.dispatchPending();
  assert.equal(context.snapshot(original).delivery.status, "unknown");
  receiver.state.queryReceipt = "original";
  await context.core.dispatchPending();
  assert.equal(context.snapshot(original).delivery.status, "accepted");
  assert.equal(context.invocations.queries.length, 3);
  assert.equal(context.invocations.deliveries.length, 1);
  assert.equal(receiver.state.writes.length, 1);
  assert.ok(receiver.state.descriptions.every(target => target.conversation_id === TARGET.conversation_id));
  assert.ok(receiver.state.reads.every(target => target.conversation_id === TARGET.conversation_id));
  const duplicate = await context.send();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, original.message.message_id);
  await context.reopen();
  await context.core.dispatchPending();
  assert.equal(context.invocations.queries.length, 3);
  assert.equal(receiver.state.writes.length, 1);
  assertOriginalIdentity(context, original);
});

test("offline expiry: a prepared message expires during persisted backoff without waiting for another attempt", async testContext => {
  const receiver = simulatedReceiver();
  const context = await fixture(testContext, receiver, { lifetimeMs: 500 });
  const original = await context.send();
  assert.equal(context.snapshot(original).delivery.evidence.evidence.retry_after_ms, 1000);
  context.clock.now += 500;
  await context.reopen();
  const expired = context.snapshot(original);
  testContext.diagnostic(`expiry during backoff: ${JSON.stringify({ status: expired.delivery.status, error: expired.delivery.error })}`);
  assert.equal(expired.delivery.status, "expired");
  assert.equal(expired.delivery.error.code, "expired");
  assert.ok(expired.delivery.error.message.length > 0);
  assert.equal(expired.message.delivery_status, "expired");
  assert.equal(expired.delivery.attempt_count, 1);
  const observed = await context.deliveryEvents(original);
  assert.equal(observed.matched, true);
  assert.ok(observed.events.some(event => event.data.status === "expired" && event.data.error?.code === "expired"));
  receiver.state.online = true;
  context.clock.now += 1000;
  await context.core.dispatchPending();
  assert.equal(receiver.state.writes.length, 0);
  assert.equal(context.invocations.deliveries.length, 1);
  assertOriginalIdentity(context, original);
});

test("offline binding change: rebinding terminates prepared delivery during backoff and never redirects it", async testContext => {
  const receiver = simulatedReceiver();
  const context = await fixture(testContext, receiver);
  const original = await context.send();
  receiver.state.online = true;
  context.clock.now += 100;
  context.targets[0] = { ...structuredClone(TARGET), conversation_id: "replacement-b", binding_generation: 8 };
  await context.reopen();
  const changed = context.snapshot(original);
  testContext.diagnostic(`binding change during backoff: ${JSON.stringify({ status: changed.delivery.status, error: changed.delivery.error })}`);
  assert.equal(changed.delivery.status, "failed_before_send");
  assert.equal(changed.delivery.error.code, "binding_changed");
  assert.ok(changed.delivery.error.message.length > 0);
  assert.equal(changed.delivery.attempt_count, 1);
  assert.equal((await context.send()).duplicate, true);
  await assert.rejects(context.core.sendMessage(SOURCE_CONTEXT, {
    ...context.input, dedupe_key: "stale-binding-new-message",
  }), error => error.code === "binding_changed");
  context.targets[0] = structuredClone(TARGET);
  context.clock.now += 1000;
  await context.reopen();
  await context.core.dispatchPending();
  const observed = await context.deliveryEvents(original);
  assert.equal(observed.matched, true);
  assert.ok(observed.events.some(event => event.data.error?.code === "binding_changed"));
  assert.equal(context.invocations.deliveries.length, 1);
  assert.equal(receiver.state.writes.length, 0);
  assertOriginalIdentity(context, original);
});

test("offline target missing: a temporarily absent registry entry remains recoverable only for the original binding", async testContext => {
  const receiver = simulatedReceiver();
  const context = await fixture(testContext, receiver);
  const original = await context.send();
  receiver.state.online = true;
  context.targets.splice(0, 1);
  context.clock.now += 1000;
  await context.reopen();
  const missing = context.snapshot(original);
  testContext.diagnostic(`temporarily missing target: ${JSON.stringify({ status: missing.delivery.status, error: missing.delivery.error })}`);
  assert.equal(missing.delivery.status, "prepared");
  assert.ok(["target_not_found", "unavailable"].includes(missing.delivery.error?.code));
  assert.ok(missing.delivery.error.message.length > 0);
  assert.equal(missing.delivery.attempt_count, 1);
  const delay = missing.delivery.evidence?.evidence?.retry_after_ms;
  assert.ok(Number.isSafeInteger(delay) && delay > 0 && delay <= 45000);
  const deadline = Date.parse(missing.delivery.updated_at) + delay;
  context.targets.push(structuredClone(TARGET));
  context.clock.now = deadline - 1;
  await context.reopen();
  await context.core.dispatchPending();
  assert.equal(context.invocations.deliveries.length, 1);
  context.clock.now = deadline;
  await context.core.dispatchPending();
  assert.equal(context.snapshot(original).delivery.status, "accepted");
  assert.equal(receiver.state.writes.length, 1);
  assert.equal(receiver.state.writes[0].payload.cascadeId, TARGET.conversation_id);
  await context.reopen();
  assert.equal((await context.send()).duplicate, true);
  assert.equal(receiver.state.writes.length, 1);
  assertOriginalIdentity(context, original);
});
