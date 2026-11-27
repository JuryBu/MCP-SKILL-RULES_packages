import test from "node:test";
import assert from "node:assert/strict";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";
import { renderHostMessage } from "../src/adapters/host-message.mjs";

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

test("frozen group labels only change presentation; two scoped host renderings retain the original text and marker", async () => {
  const adapter = new CodexDeliveryAdapter({ transport: { submit() { assert.fail("invalid group must never reach the transport"); }, query() {} } });
  const grouped = structuredClone(input);
  grouped.message.batch_meta = {
    recipient_group: {
      batch_id: "fixture-group", total_count: 2,
      recipients: [target, { ...target, host: "antigravity", conversation_id: "second-fixture-recipient" }],
    },
    recipient_labels: ["本机给搭档取的名字"],
  };
  const original = structuredClone(grouped);
  const notice = "同批收件人：本机给搭档取的名字";
  const sharedHost = renderHostMessage(grouped);
  assert.equal(sharedHost.split("\n")[1], notice);
  assert.match(sharedHost, /\[COMMUNICATION_CORE message_id=isolated-message delivery_id=isolated-delivery\]/u);
  assert.ok(sharedHost.endsWith("\n\n" + original.message.envelope.text));
  const codex = adapter.request(grouped);
  assert.equal(codex.body.text, notice + "\n\n" + original.message.envelope.text);
  assert.deepEqual(grouped, original);
  assert.equal(Object.hasOwn(codex, "batch_meta"), false);
  grouped.message.batch_meta.recipient_labels = ["越界\n另起一行"];
  assert.throws(() => renderHostMessage(grouped), { code: "invalid_input" });
  assert.throws(() => adapter.request(grouped), { code: "invalid_input" });
  assert.equal((await adapter.deliver(grouped)).outcome, "failed_before_send");
  grouped.message.batch_meta.recipient_labels = original.message.batch_meta.recipient_labels;
  grouped.message.envelope.text = "a".repeat(262144);
  assert.equal((await adapter.deliver(grouped)).outcome, "failed_before_send");
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
