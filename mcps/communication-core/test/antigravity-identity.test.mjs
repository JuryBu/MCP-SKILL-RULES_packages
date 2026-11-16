import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";

const input = {
  target: { machine_id: "test", host: "antigravity", surface: "desktop", conversation_id: "original-root", binding_id: "test", binding_generation: 1 },
  delivery: { delivery_id: "original-delivery" },
  message: { message_id: "original-message", envelope: {
    caller: { machine_id: "test", host: "codex", surface: "desktop", conversation_id: "source" },
    origin: { kind: "agent_message", channel: "test", source_ref: "source-event" },
    text: "原消息", attachment_refs: [], delivery_policy: "next_model_boundary",
  } },
};
const marker = "[COMMUNICATION_CORE message_id=original-message delivery_id=original-delivery]";
const nativeIdentity = { cascade_id: "original-root", trajectory_id: "original-trajectory" };

function userStep(index, userInput, identity = nativeIdentity) {
  return { index, type: "user_input", status: "DONE", user_input: userInput, ...identity };
}

function fixture(steps) {
  return new AntigravityDeliveryAdapter({ transport: {
    async describe() { return { ...nativeIdentity, step_count: steps.length }; },
    async readSteps() { return { steps }; },
    async call() { throw new Error("read-only verification must never send"); },
  } });
}

for (const [name, steps] of [
  ["another nonempty native client ID cannot borrow the original marker", [userStep(0, { client_message_id: "different-delivery", text: `引用原标记：${marker}` })]],
  ["another native root cannot confirm the original delivery", [userStep(0, { client_message_id: "original-delivery", text: marker }, { ...nativeIdentity, cascade_id: "foreign-root" })]],
  ["another native trajectory cannot confirm the original delivery", [userStep(0, { client_message_id: "original-delivery", text: marker }, { ...nativeIdentity, trajectory_id: "foreign-trajectory" })]],
  ["duplicate original native inputs leave delivery ownership unresolved", [userStep(0, { client_message_id: "original-delivery" }), userStep(1, { client_message_id: "original-delivery" })]],
  ["a marker quoted without a native client ID is insufficient", [userStep(0, { client_message_id: null, text: `引用原标记：${marker}` })]],
]) {
  test(name, async () => {
    const withReply = [...steps, { index: steps.length, type: "planner_response", status: "DONE", ...nativeIdentity, assistant_response: { message_id: "foreign-reply", text: "无关回复", final: true } }];
    const adapter = fixture(withReply);
    assert.equal((await adapter.query(input)).outcome, "unknown");
    assert.equal(await adapter.observeReply(input), null);
  });
}

test("missing native client ID can recover only the exact originally rendered input", async () => {
  let rendered;
  const sender = new AntigravityDeliveryAdapter({ transport: {
    async describe() { return nativeIdentity; },
    async readSteps() { return { steps: [] }; },
    async call(method, payload) { rendered = payload.items[0].text; return {}; },
  } });
  assert.equal((await sender.deliver(input)).outcome, "accepted");
  const adapter = fixture([userStep(0, { text: rendered })]);
  assert.equal((await adapter.query(input)).outcome, "accepted");
});
