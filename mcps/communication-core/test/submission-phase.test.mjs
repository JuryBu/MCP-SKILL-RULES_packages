import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";

const source = { machine_id: "test", host: "codex", surface: "desktop", conversation_id: "phase-source" };
const target = { machine_id: "test", host: "antigravity", surface: "desktop", conversation_id: "phase-receiver", binding_id: "phase-binding", binding_generation: 1, adapter_id: "phase-adapter", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "controlled-phase-test" };
const context = { principal_id: "phase-source" };

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error("cancelled"));
    else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
}

async function fixture(testContext, phase, { tracking = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-submission-phase-"));
  const store = new MessageStore({ filePath: join(directory, "core.sqlite") });
  const state = { writes: 0 };
  const transport = {
    submissionTracking: tracking,
    async describe(target, { signal }) {
      if (phase === "preflight") return waitForAbort(signal);
      if (phase === "delayed-preflight") await new Promise(resolve => setTimeout(resolve, 60));
      return { cascade_id: target.conversation_id };
    },
    async call(method, payload, { signal, onRequestStarted }) {
      onRequestStarted?.();
      state.writes += 1;
      return waitForAbort(signal);
    },
    async readSteps() { return { steps: [] }; },
  };
  const core = new CommunicationCore({ store, targets: [target], principals: [{ id: context.principal_id, identity: source, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] }], adapters: { "phase-adapter": new AntigravityDeliveryAdapter({ transport }) }, deliveryTimeoutMs: 20 });
  testContext.after(async () => { await core.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await core.start();
  const input = { caller: source, origin: { kind: "agent_message", channel: "test", source_ref: "phase-original" }, target: Object.fromEntries(Object.entries(target).filter(([key]) => !["adapter_id", "capabilities", "evidence"].includes(key))), dedupe_key: phase, text: "等待B端", expires_at: "2031-01-01T00:00:00Z" };
  const original = await core.sendMessage(context, input);
  await core.drain();
  return { core, store, state, original };
}

test("deadline during a declared read-only preflight retains prepared and never starts a send", async testContext => {
  const { core, store, state, original } = await fixture(testContext, "preflight");
  const delivery = store.getDelivery(original.delivery.delivery_id);
  assert.equal(delivery.status, "prepared");
  assert.equal(delivery.evidence.evidence.retry_after_ms, 1000);
  assert.equal(state.writes, 0);
  await core.dispatchPending();
  assert.equal(state.writes, 0);
  assert.equal(store.getDelivery(delivery.delivery_id).attempt_count, 1);
});

test("deadline after the mutation boundary remains unknown and never sends a second time", async testContext => {
  const { core, store, state, original } = await fixture(testContext, "submitted");
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "unknown");
  await core.dispatchPending();
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "unknown");
  assert.equal(state.writes, 1);
});

test("a legacy adapter without an explicit tracking contract remains unknown", async testContext => {
  const { store, state, original } = await fixture(testContext, "preflight", { tracking: false });
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "unknown");
  assert.equal(state.writes, 0);
});

test("a delayed read-only preflight cannot start a mutation after its deadline", async testContext => {
  const { store, state, original } = await fixture(testContext, "delayed-preflight");
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "prepared");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(state.writes, 0);
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "prepared");
});
