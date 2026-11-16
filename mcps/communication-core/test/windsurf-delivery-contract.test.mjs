import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

const SOURCE = { machine_id: "contract-fixture", host: "codex", surface: "desktop", conversation_id: "sender" };
const TARGET = {
  machine_id: "contract-fixture", host: "windsurf", surface: "desktop", conversation_id: "receiver",
  binding_id: "windsurf-fixture", binding_generation: 1, adapter_id: "fixture-only",
  capabilities: { next_model_boundary: true, when_idle: true }, evidence: "isolated-persistent-contract-test",
};
const CONTEXT = { principal_id: "contract-sender" };

function requestReference(request) {
  return {
    message: { message_id: request.message.message_id },
    delivery: { delivery_id: request.delivery.delivery_id, target_key: request.delivery.target_key },
    target: structuredClone(request.target),
  };
}

async function fixture(testContext, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-windsurf-contract-"));
  assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
  const filePath = join(directory, "messages.sqlite");
  const clock = { now: Date.parse("2035-01-01T00:00:00Z") };
  const state = { online: false, ambiguous: false, receipt: false, deliveries: [], queries: [], writes: [], ...options };
  const response = (request, outcome, extra = {}) => ({
    outcome, delivery_id: request.delivery.delivery_id, target_key: request.delivery.target_key,
    evidence: { kind: "windsurf-contract-fixture", retry_after_ms: 1000 }, ...extra,
  });
  const adapters = { [TARGET.adapter_id]: {
    async deliver(request) {
      state.deliveries.push(requestReference(request));
      if (!state.online) return response(request, "busy", { error: { code: "unavailable", message: "Fixture receiver is offline" } });
      state.writes.push(requestReference(request));
      if (state.ambiguous) {
        state.ambiguous = false;
        return response(request, "unknown");
      }
      return response(request, "accepted");
    },
    async query(request) {
      state.queries.push(requestReference(request));
      return response(request, state.receipt ? "accepted" : "unknown");
    },
  } };
  const principals = [{ id: CONTEXT.principal_id, identity: SOURCE, allowed_targets: [TARGET.binding_id], origin_kinds: ["agent_message"] }];
  const resources = [];
  let current;
  async function open() {
    const store = new MessageStore({ filePath });
    const core = new CommunicationCore({ store, targets: [TARGET], principals, adapters, now: () => clock.now, deliveryTimeoutMs: 1000 });
    current = { store, core };
    resources.push(current);
    await core.start();
    await core.drain();
  }
  testContext.after(async () => {
    try {
      for (const resource of resources) {
        await resource.core.close();
        resource.store.close();
        assert.equal(resource.core.jobs.size, 0);
        assert.equal(resource.core.controllers.size, 0);
        assert.equal(resource.core.waiters.size, 0);
      }
    } finally {
      for (const resource of resources) resource.store.close();
      rmSync(directory, { recursive: true, force: true });
      assert.equal(existsSync(directory), false);
    }
  });
  await open();
  const input = {
    caller: SOURCE, origin: { kind: "agent_message", channel: "codex", source_ref: SOURCE.conversation_id },
    target: {
      machine_id: TARGET.machine_id, host: TARGET.host, surface: TARGET.surface, conversation_id: TARGET.conversation_id,
      binding_id: TARGET.binding_id, binding_generation: TARGET.binding_generation,
    },
    text: "持久化给尚未在线的原WSF目标", dedupe_key: "original-fixture-message",
    expires_at: new Date(clock.now + 60000).toISOString(),
  };
  return {
    get core() { return current.core; },
    get store() { return current.store; },
    input, state, clock,
    async send() { const result = await current.core.sendMessage(CONTEXT, input); await current.core.drain(); return result; },
    async reopen() { await current.core.close(); current.store.close(); await open(); },
    snapshot(original) { return current.core.getMessage(CONTEXT, { caller: SOURCE, message_id: original.message.message_id }); },
  };
}

function assertPreserved(context, original) {
  const snapshot = context.snapshot(original);
  assert.equal(snapshot.message.message_id, original.message.message_id);
  assert.equal(snapshot.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(snapshot.delivery.target_key, identityKey(TARGET));
  assert.deepEqual(snapshot.message.envelope.target, context.input.target);
  assert.deepEqual(snapshot.message.envelope.origin, context.input.origin);
  assert.equal(snapshot.message.envelope.delivery_policy, "next_model_boundary");
  assert.equal(snapshot.message.envelope.message_visibility, undefined);
  assert.equal(context.store.listDeliveries().length, 1);
  for (const request of [...context.state.deliveries, ...context.state.queries]) {
    assert.equal(request.message.message_id, original.message.message_id);
    assert.equal(request.delivery.delivery_id, original.delivery.delivery_id);
    assert.deepEqual(request.target, TARGET);
  }
}

test("future WSF adapter contract keeps an offline message across SQLite reopen and delivers the original ID once", async testContext => {
  const context = await fixture(testContext);
  const original = await context.send();
  const offline = context.snapshot(original);
  assert.equal(offline.delivery.status, "prepared");
  assert.equal(offline.delivery.attempt_count, 1);
  assert.equal(context.state.writes.length, 0);
  context.state.online = true;
  context.clock.now += 1000;
  await context.reopen();
  const accepted = context.snapshot(original);
  assert.equal(accepted.delivery.status, "accepted");
  assert.equal(accepted.delivery.attempt_count, 2);
  assert.equal(accepted.message.processing, "pending");
  assert.equal(accepted.message.model_observed, "unknown");
  assert.equal(accepted.message.ui_observed, "unknown");
  assert.equal(context.state.writes.length, 1);
  const duplicate = await context.send();
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, original.message.message_id);
  await context.reopen();
  assert.equal(context.state.writes.length, 1);
  assert.equal(context.state.queries.length, 0);
  assertPreserved(context, original);
});

test("future WSF adapter contract queries an unknown receipt after expiry and never repeats the original write", async testContext => {
  const context = await fixture(testContext, { online: true, ambiguous: true });
  const original = await context.send();
  assert.equal(context.snapshot(original).delivery.status, "unknown");
  assert.equal(context.state.writes.length, 1);
  context.clock.now += 120000;
  await context.reopen();
  assert.equal(context.snapshot(original).delivery.status, "unknown");
  assert.equal(context.state.queries.length, 1);
  context.state.receipt = true;
  await context.core.dispatchPending();
  await context.core.drain();
  assert.equal(context.snapshot(original).delivery.status, "accepted");
  assert.equal(context.snapshot(original).delivery.attempt_count, 1);
  assert.equal(context.state.queries.length, 2);
  assert.equal(context.state.writes.length, 1);
  await context.reopen();
  assert.equal(context.state.queries.length, 2);
  assert.equal(context.state.writes.length, 1);
  assertPreserved(context, original);
});

test("WSF target visibility stays separate from the Codex-only hidden setting without inserting an invalid message", async testContext => {
  const context = await fixture(testContext);
  await assert.rejects(context.core.sendMessage(CONTEXT, { ...context.input, message_visibility: "hidden" }), { code: "invalid_input" });
  assert.equal(context.store.listDeliveries().length, 0);
  assert.equal(context.state.deliveries.length, 0);
  assert.equal(context.state.writes.length, 0);
});
