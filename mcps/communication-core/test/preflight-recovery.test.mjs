import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/store.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";

test("发送前定位失败按持久退避恢复，SQLite重开沿原身份仅发送一次", async context => {
  const directory = mkdtempSync(join(tmpdir(), "communication-preflight-recovery-"));
  let store;
  let core;
  context.after(async () => { await core?.close(); store?.close(); rmSync(directory, { recursive: true }); });
  let now = Date.now();
  let descriptions = 0;
  const writes = [];
  const source = { machine_id: "test", host: "codex", conversation_id: "source" };
  const target = { machine_id: "test", host: "antigravity", conversation_id: "target", binding_id: "binding", binding_generation: 1, adapter_id: "adapter", capabilities: { next_model_boundary: true }, evidence: "test" };
  const principal = { id: "source", identity: source, allowed_targets: ["binding"], origin_kinds: ["agent_message"] };
  const adapter = new AntigravityDeliveryAdapter({ transport: {
    async describe() { descriptions += 1; if (descriptions === 1) throw new Error("temporary lookup failure"); return { cascade_id: "target", trajectory_id: "trajectory", status: "idle", step_count: 0 }; },
    async call(method, payload) { writes.push(payload); return {}; },
    async readSteps() { return { steps: [] }; },
  } });
  const open = async () => {
    store = new MessageStore({ filePath: join(directory, "core.sqlite") });
    core = new CommunicationCore({ store, targets: [target], principals: [principal], adapters: { adapter }, now: () => now });
    await core.start();
    await core.drain();
  };
  await open();
  const input = { caller: source, origin: { kind: "agent_message", channel: "test", source_ref: "event" }, target: { machine_id: target.machine_id, host: target.host, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: 1 }, text: "test", dedupe_key: "original-key", delivery_policy: "next_model_boundary", expires_at: new Date(now + 60000).toISOString() };
  const original = await core.sendMessage({ principal_id: "source" }, input);
  await core.drain();
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "prepared");
  assert.equal(descriptions, 1);
  assert.equal(writes.length, 0);
  await core.dispatchPending();
  assert.equal(descriptions, 1);
  await core.close();
  store.close();
  await open();
  assert.equal(descriptions, 1);
  now += 1000;
  await core.dispatchPending();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].clientMessageId, original.delivery.delivery_id);
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "accepted");
  const repeated = await core.sendMessage({ principal_id: "source" }, input);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.message.message_id, original.message.message_id);
  assert.equal(writes.length, 1);
});

test("原生进度正文不会截走后续最终回复，明确结束标记可在busy读取", async () => {
  const input = { target: { machine_id: "test", host: "antigravity", conversation_id: "target" }, delivery: { delivery_id: "delivery" }, message: { message_id: "message" } };
  const steps = [
    { index: 0, type: "user_input", user_input: { client_message_id: "delivery" } },
    { index: 1, type: "planner_response", status: "DONE", assistant_response: { text: "已收到，开始处理", message_id: "progress", final: false } },
    { index: 2, type: "mcp_tool", status: "DONE" },
    { index: 3, type: "planner_response", status: "DONE", assistant_response: { text: "最终结果", message_id: "final", final: true } },
  ];
  const adapter = new AntigravityDeliveryAdapter({ transport: { describe: async () => ({ cascade_id: "target", trajectory_id: "trajectory", status: "CASCADE_RUN_STATUS_RUNNING", step_count: steps.length }), readSteps: async () => ({ steps }), call: async () => ({}) } });
  assert.equal((await adapter.observeReply(input)).native_message_id, "final");
  steps.pop();
  assert.equal(await adapter.observeReply(input), null);
});
