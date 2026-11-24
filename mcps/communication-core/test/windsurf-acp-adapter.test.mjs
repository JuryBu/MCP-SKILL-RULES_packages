import test from "node:test";
import assert from "node:assert/strict";
import { identityKey } from "../src/contracts.mjs";
import { WindsurfAcpDeliveryAdapter } from "../src/adapters/windsurf-acp.mjs";
import { renderHostMessage } from "../src/adapters/host-message.mjs";

function fixture(options = {}) {
  const target = { machine_id: "fixture", host: "windsurf", surface: "desktop", conversation_id: "fixture-session",
    binding_id: "fixture-binding", binding_generation: 1, adapter_id: "fixture-wsf", capabilities: { next_model_boundary: true, when_idle: true } };
  const message = { message_id: "fixture-message", envelope: {
    caller: { machine_id: "fixture", host: "codex", surface: "desktop", conversation_id: "fixture-caller" },
    origin: { kind: "agent_message", channel: "codex", source_ref: "fixture-caller" }, target,
    text: "fixture external agent message", delivery_policy: "next_model_boundary", attachment_refs: [],
  } };
  const input = { message, delivery: { delivery_id: "fixture-delivery", message_id: message.message_id,
    target_key: identityKey(target), target_snapshot: target, status: "prepared", attempt_count: 1 }, target };
  const description = { session_id: target.conversation_id, connector_id: "devin-cli", connection_id: "fixture-connection", protocol_version: 2,
    ready: true, capabilities: { direct: true, queue: true }, ...options.description };
  const calls = { factories: [], deliveries: [], queries: [], writes: 0 };
  const receipt = { message_id: message.message_id, delivery_id: input.delivery.delivery_id, session_id: target.conversation_id,
    connector_id: "devin-cli", connection_id: description.connection_id, protocol_version: 2, outcome: "accepted", request_sent: true,
    evidence: { kind: "native_response", native_message_id: "fixture-native-message" }, ...options.receipt };
  const client = {
    describe: async () => structuredClone(description),
    deliver: async request => { calls.deliveries.push(request); await request.onRequestStarted(); calls.writes += 1; return structuredClone(receipt); },
    query: async request => { calls.queries.push(request); return structuredClone(receipt); },
    ...options.client,
  };
  const adapter = new WindsurfAcpDeliveryAdapter({ clientForTarget: async (selected, context) => {
    calls.factories.push({ target: structuredClone(selected), queryOnly: context.queryOnly === true });
    return client;
  } });
  return { input, adapter, description, calls, client, receipt };
}

test("default direct keeps original identities, renders provenance, and awaits the core write fence", async () => {
  const sample = fixture();
  const timeline = [];
  sample.input.onRequestStarted = async () => { await Promise.resolve(); timeline.push("durable-fence"); };
  const result = await sample.adapter.deliver(sample.input);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.delivery_id, sample.input.delivery.delivery_id);
  assert.equal(result.target_key, identityKey(sample.input.target));
  assert.deepEqual(timeline, ["durable-fence"]);
  assert.equal(sample.calls.writes, 1);
  const request = sample.calls.deliveries[0];
  assert.equal(request.message_id, sample.input.message.message_id);
  assert.equal(request.delivery_id, sample.input.delivery.delivery_id);
  assert.equal(request.policy, "next_model_boundary");
  assert.equal(request.text, renderHostMessage(sample.input));
  assert.match(request.text, /来源类型：agent_message/);
  assert.match(request.text, /message_id=fixture-message delivery_id=fixture-delivery/);
});

test("unknown delivery only queries the original operation and never submits again", async () => {
  const sample = fixture();
  sample.input.delivery.status = "unknown";
  const result = await sample.adapter.deliver(sample.input);
  assert.equal(result.outcome, "accepted");
  assert.equal(sample.calls.deliveries.length, 0);
  assert.equal(sample.calls.queries.length, 1);
  assert.equal(sample.calls.factories[0].queryOnly, true);
  assert.equal(sample.calls.queries[0].delivery_id, "fixture-delivery");
});

test("offline or mismatched native sessions remain before-send busy without writing", async () => {
  for (const description of [{ ready: false }, { session_id: "another-session" }, { protocol_version: 1 }, { connector_id: "other-connector" }]) {
    const sample = fixture({ description });
    const result = await sample.adapter.deliver(sample.input);
    assert.equal(result.outcome, "busy");
    assert.equal(result.evidence.request_sent, false);
    assert.equal(sample.calls.writes, 0);
    assert.ok(result.evidence.retry_after_ms >= 1000);
  }
});

test("missing direct capability never silently switches to the supported queue mode", async () => {
  const sample = fixture({ description: { capabilities: { direct: false, queue: true } } });
  const result = await sample.adapter.deliver(sample.input);
  assert.equal(result.outcome, "failed_before_send");
  assert.equal(result.reason, "native_delivery_mode_unverified");
  assert.equal(sample.calls.writes, 0);
  sample.input.message.envelope.delivery_policy = "when_idle";
  assert.equal((await sample.adapter.deliver(sample.input)).outcome, "accepted");
  assert.equal(sample.calls.deliveries[0].policy, "when_idle");
});

test("unsupported attachments and policy fail before selecting a client", async () => {
  const attachments = fixture();
  attachments.input.message.envelope.attachment_refs = ["fixture-attachment"];
  assert.equal((await attachments.adapter.deliver(attachments.input)).reason, "attachment_mapping_unsupported");
  assert.equal(attachments.calls.factories.length, 0);
  const policy = fixture();
  policy.input.message.envelope.delivery_policy = "toString";
  assert.equal((await policy.adapter.deliver(policy.input)).reason, "unsupported_delivery_policy");
  assert.equal(policy.calls.factories.length, 0);
});

test("pre-aborted requests do not create clients or mark native writes", async () => {
  const sample = fixture();
  const controller = new AbortController();
  controller.abort();
  sample.input.signal = controller.signal;
  assert.equal((await sample.adapter.deliver(sample.input)).reason, "aborted_before_send");
  assert.equal(sample.calls.factories.length, 0);
});

test("changed connection identity or wrong native message receipt stays unknown", async () => {
  for (const receipt of [{ connection_id: "other-connection" }, { message_id: "other-message" }, { delivery_id: "other-delivery" },
    { session_id: "other-session" }, { protocol_version: 1 }, { outcome: "busy", request_sent: true }]) {
    const sample = fixture({ receipt });
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "unknown");
    assert.equal(sample.calls.writes, 1);
  }
});

test("native errors and failed core fences never trigger an automatic retry", async () => {
  const uncertain = fixture({ client: { deliver: async request => { await request.onRequestStarted(); throw new Error("fixture uncertain write"); } } });
  assert.equal((await uncertain.adapter.deliver(uncertain.input)).outcome, "unknown");
  const fence = fixture();
  fence.input.onRequestStarted = async () => { throw new Error("fixture ledger failure"); };
  assert.equal((await fence.adapter.deliver(fence.input)).outcome, "unknown");
  assert.equal(fence.calls.writes, 0);
  assert.equal(fence.calls.deliveries.length, 1);
});

test("wrong query identities remain unknown without falling through to deliver", async () => {
  const sample = fixture({ receipt: { delivery_id: "another-delivery" } });
  const result = await sample.adapter.query(sample.input);
  assert.equal(result.outcome, "unknown");
  assert.equal(sample.calls.queries.length, 1);
  assert.equal(sample.calls.deliveries.length, 0);
});

test("query rejects a foreign connector and a receipt from a different connection", async () => {
  for (const options of [
    { description: { connector_id: "another-connector" } },
    { receipt: { connector_id: "another-connector" } },
    { receipt: { connection_id: "retired-connection" } },
    { receipt: { protocol_version: 3 } },
  ]) {
    const sample = fixture(options);
    assert.equal((await sample.adapter.query(sample.input)).outcome, "unknown");
    assert.equal(sample.calls.writes, 0);
    assert.equal(sample.calls.deliveries.length, 0);
  }
});

test("query can read the original closed client without requiring a ready connection", async () => {
  const sample = fixture({ description: { ready: false, closed: true } });
  assert.equal((await sample.adapter.query(sample.input)).outcome, "accepted");
  assert.equal(sample.calls.queries.length, 1);
  assert.equal(sample.calls.writes, 0);
});

test("accepted native receipts cannot claim that no request was sent", async () => {
  const sample = fixture({ receipt: { request_sent: false } });
  assert.equal((await sample.adapter.deliver(sample.input)).outcome, "unknown");
  assert.equal((await sample.adapter.query(sample.input)).outcome, "unknown");
});

test("concurrent duplicate write fences enter the core callback only once", async () => {
  const sample = fixture();
  let fences = 0;
  sample.input.onRequestStarted = async () => { fences += 1; await Promise.resolve(); };
  sample.client.deliver = async request => {
    await Promise.all([request.onRequestStarted(), request.onRequestStarted()]);
    return sample.receipt;
  };
  assert.equal((await sample.adapter.deliver(sample.input)).outcome, "unknown");
  assert.equal(fences, 1);
});

test("forged human and unfrozen QQ window sources fail before client selection", async () => {
  for (const channel of ["codex", "napcat_owner_window"]) {
    const sample = fixture();
    sample.input.message.envelope.origin = { kind: "human_message", channel, source_ref: "fixture" };
    if (channel === "napcat_owner_window") sample.input.message.envelope.caller = { machine_id: "fixture", host: "qq", surface: "private", conversation_id: "fixture-owner" };
    assert.equal((await sample.adapter.deliver(sample.input)).reason, "invalid_message");
    assert.equal(sample.calls.factories.length, 0);
  }
});
