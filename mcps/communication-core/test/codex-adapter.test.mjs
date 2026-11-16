import test from "node:test";
import assert from "node:assert/strict";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";

const target = { machine_id: "isolation-machine", host: "codex", surface: "desktop", conversation_id: "receiver", binding_id: "receiver-binding", binding_generation: 2 };
const input = {
  target,
  delivery: { delivery_id: "isolated-delivery" },
  message: {
    message_id: "isolated-message",
    envelope: {
      caller: { machine_id: "isolation-machine", host: "antigravity", surface: "desktop", conversation_id: "source" },
      origin: { kind: "agent_message", channel: "host_mcp", source_ref: "source-event" },
      text: "请保留原工作并核对材料",
      attachment_refs: [],
      delivery_policy: "next_model_boundary",
    },
  },
};

test("generic Codex request carries authentic source and no QQ or model override", async () => {
  let submitted;
  const adapter = new CodexDeliveryAdapter({ transport: {
    async submit(request) {
      submitted = request;
      return { delivery_id: request.delivery_id, target: request.target, outcome: "accepted", turn_id: "active-turn", injection_method: "turn/steer" };
    },
    async query() { return null; },
  } });
  const result = await adapter.deliver(input);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.injection_method, "turn/steer");
  assert.equal(submitted.source.origin.kind, "agent_message");
  assert.equal(submitted.target.binding_generation, 2);
  assert.equal(submitted.body.text, input.message.envelope.text);
  for (const forbidden of ["trustedPeerQq", "taskId", "model", "cascadeConfig"]) {
    assert.equal(JSON.stringify(submitted).includes(`"${forbidden}"`), false);
  }
  assert.equal(result.model_observed, undefined);
});

test("transport disconnect remains unknown and query uses only original delivery", async () => {
  let submissionCount = 0;
  const queries = [];
  const adapter = new CodexDeliveryAdapter({ transport: {
    async submit() { submissionCount += 1; throw new Error("network disconnected"); },
    async query(request) { queries.push(request); return { delivery_id: request.delivery_id, target, outcome: "accepted" }; },
  } });
  assert.equal((await adapter.deliver(input)).outcome, "unknown");
  assert.equal((await adapter.query(input)).outcome, "accepted");
  assert.equal(submissionCount, 1);
  assert.deepEqual(queries, [{ delivery_id: input.delivery.delivery_id }]);
});

test("a response with wrong native target or generation remains unknown", async () => {
  const adapter = new CodexDeliveryAdapter({ transport: {
    async submit() { return { delivery_id: input.delivery.delivery_id, target: { ...target, conversation_id: "wrong-target" }, outcome: "accepted" }; },
    async query() { return { delivery_id: input.delivery.delivery_id, target: { ...target, binding_generation: 3 }, outcome: "accepted" }; },
  } });
  assert.equal((await adapter.deliver(input)).outcome, "unknown");
  assert.equal((await adapter.query(input)).outcome, "unknown");
});
