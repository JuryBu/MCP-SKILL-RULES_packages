import test from "node:test";
import assert from "node:assert/strict";
import { createDevinSessionClient } from "../src/transports/devin-session-client.mjs";
import { WindsurfAcpDeliveryAdapter } from "../src/adapters/windsurf-acp.mjs";
import { identityKey, requireText } from "../src/contracts.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ ignorePrompts = false, requestTimeoutMs = 500, largeInitialize = false, connectorId = "devin-cli" } = {}) {
  const wire = [];
  let client;
  const reply = (request, result) => client.feedLine(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  client = createDevinSessionClient({ connectorId, sessionId: "fixture-session", cwd: "C:/fixture/workspace", requestTimeoutMs,
    sendLine: line => {
      const frame = JSON.parse(line);
      wire.push({ ...frame, wire_bytes: Buffer.byteLength(line) });
      if (frame.method === "initialize") queueMicrotask(() => reply(frame, { protocolVersion: 2,
        agentCapabilities: { sessionCapabilities: { resume: {} }, _meta: { "cognition.ai/midTurnPrompts": true, "cognition.ai/queuedMessages": true } },
        ...(largeInitialize ? { _meta: { fixtureCatalog: "x".repeat(300000) } } : {}) }));
      else if (frame.method === "session/resume") queueMicrotask(() => reply(frame, {}));
      else if (frame.method === "_cognition.ai/queuedMessages/update") queueMicrotask(() => reply(frame, { messages: [] }));
      else if (frame.method === "session/prompt" && !ignorePrompts) queueMicrotask(() => reply(frame, { messageId: "fixture-native-receipt" }));
    } });
  const target = { machine_id: "fixture", host: "windsurf", surface: "desktop", conversation_id: "fixture-session",
    binding_id: "fixture-binding", binding_generation: 1, adapter_id: "fixture-wsf", capabilities: { next_model_boundary: true, when_idle: true } };
  const input = { target, message: { message_id: "fixture-message", envelope: { caller: { machine_id: "fixture", host: "codex", surface: "desktop", conversation_id: "fixture-caller" },
    origin: { kind: "agent_message", channel: "codex", source_ref: "fixture-caller" }, target, text: "synthetic integration message",
    delivery_policy: "next_model_boundary", attachment_refs: [] } },
    delivery: { delivery_id: "fixture-delivery", message_id: "fixture-message", target_key: identityKey(target), status: "prepared", attempt_count: 1 } };
  const adapter = new WindsurfAcpDeliveryAdapter({ clientForTarget: async () => client });
  return { client, adapter, input, wire, reply };
}

async function connect(sample) {
  assert.equal((await sample.client.initialize()).outcome, "accepted");
  assert.equal((await sample.client.attach()).outcome, "accepted");
  return sample;
}

test("Core adapter and actual candidate client agree on native direct identity and durable start callback", async () => {
  const sample = await connect(harness());
  let starts = 0;
  sample.input.onRequestStarted = async () => { starts += 1; };
  try {
    const receipt = await sample.adapter.deliver(sample.input);
    assert.equal(receipt.outcome, "accepted");
    assert.equal(starts, 1);
    const request = sample.wire.find(frame => frame.method === "session/prompt");
    assert.equal(request.params.sessionId, sample.input.target.conversation_id);
    assert.equal(request.params._meta["cognition.ai/clientMessageId"], sample.input.message.message_id);
    assert.equal(receipt.evidence.native.kind, "direct_receipt");
    assert.equal(receipt.evidence.connection_id, sample.client.describe().connection_id);
    assert.equal(sample.wire.some(frame => /cancel|close|new/.test(frame.method)), false);
  } finally { sample.client.close(); }
});

test("an original pending prompt survives a second Core direct request and completes by its own response", async () => {
  const sample = await connect(harness({ ignorePrompts: true }));
  try {
    const original = sample.client.deliver({ message_id: "fixture-original", delivery_id: "fixture-original-delivery", text: "synthetic original turn" });
    await tick();
    const inserted = sample.adapter.deliver(sample.input);
    await tick();
    const requests = sample.wire.filter(frame => frame.method === "session/prompt");
    assert.equal(requests.length, 2);
    sample.reply(requests[1], { messageId: "fixture-native-insertion" });
    assert.equal((await inserted).outcome, "accepted");
    assert.equal(sample.client.query({ message_id: "fixture-original", delivery_id: "fixture-original-delivery" }).outcome, "unknown");
    sample.reply(requests[0], { stopReason: "end_turn" });
    assert.equal((await original).outcome, "accepted");
    assert.equal(sample.wire.some(frame => frame.method === "session/cancel"), false);
  } finally { sample.client.close(); }
});

test("Core explicit when_idle reaches the queue method with no direct request", async () => {
  const sample = await connect(harness());
  try {
    sample.input.message.envelope.delivery_policy = "when_idle";
    const receipt = await sample.adapter.deliver(sample.input);
    assert.equal(receipt.outcome, "accepted");
    assert.equal(receipt.evidence.native.kind, "queue_ack");
    assert.equal(sample.wire.at(-1).method, "_cognition.ai/queuedMessages/update");
    assert.equal(sample.wire.at(-1).params.op, "add");
    assert.equal(sample.wire.some(frame => frame.method === "session/prompt"), false);
  } finally { sample.client.close(); }
});

test("a timed-out Core delivery is queried by original IDs and a late response never writes another prompt", async () => {
  const sample = await connect(harness({ ignorePrompts: true, requestTimeoutMs: 80 }));
  try {
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "unknown");
    sample.input.delivery.status = "unknown";
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "unknown");
    const prompt = sample.wire.find(frame => frame.method === "session/prompt");
    sample.reply(prompt, { messageId: "fixture-late-native" });
    assert.equal((await sample.adapter.query(sample.input)).outcome, "accepted");
    assert.equal(sample.wire.filter(frame => frame.method === "session/prompt").length, 1);
  } finally { sample.client.close(); }
});

test("the maximum legal Core text still fits after provenance rendering and worst-case JSON escaping", async () => {
  const sample = await connect(harness());
  try {
    sample.input.message.envelope.text = "\u0000".repeat(262143) + "x";
    assert.equal(Buffer.byteLength(requireText(sample.input.message.envelope.text, "text")), 262144);
    const receipt = await sample.adapter.deliver(sample.input);
    assert.equal(receipt.outcome, "accepted");
    const frame = sample.wire.at(-1);
    assert.equal(frame.method, "session/prompt");
    assert.ok(frame.wire_bytes > 1500000);
    assert.ok(frame.wire_bytes <= sample.client.describe().limits.maxFrameBytes);
  } finally { sample.client.close(); }
});

test("a bounded larger native initialization catalog is accepted without relaxing protocol identity", async () => {
  const sample = harness({ largeInitialize: true });
  try {
    await connect(sample);
    assert.equal(sample.client.describe().protocol_version, 2);
    assert.equal(sample.client.describe().ready, true);
  } finally { sample.client.close(); }
});

test("cached accepted delivery and closed-client query retain one native write and one core fence", async () => {
  const sample = await connect(harness());
  let starts = 0;
  sample.input.onRequestStarted = async () => { starts += 1; };
  try {
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "accepted");
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "accepted");
    sample.client.close();
    sample.input.delivery.status = "unknown";
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "accepted");
    assert.equal(starts, 1);
    assert.equal(sample.wire.filter(frame => frame.method === "session/prompt").length, 1);
  } finally { sample.client.close(); }
});

test("a real client from a different connector cannot turn its cached receipt into a core acceptance", async () => {
  const sample = await connect(harness({ connectorId: "other-connector" }));
  try {
    assert.equal((await sample.client.deliver({ message_id: sample.input.message.message_id,
      delivery_id: sample.input.delivery.delivery_id, text: "synthetic prior receipt" })).outcome, "accepted");
    assert.equal((await sample.adapter.query(sample.input)).outcome, "unknown");
    assert.equal((await sample.adapter.deliver(sample.input)).outcome, "busy");
    assert.equal(sample.wire.filter(frame => frame.method === "session/prompt").length, 1);
  } finally { sample.client.close(); }
});
