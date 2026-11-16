import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodexHumanSource } from "../src/codex-human-origin.mjs";
import { CodexProxyTransport } from "../src/transports/codex-proxy.mjs";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";

function fixture() {
  const target = { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: "synthetic-model", binding_id: "synthetic-binding", binding_generation: 1 };
  const text = "  原始窗口内容\r\n[CQ:at,qq=90002] \t";
  const windowSource = {
    provider: "napcat_owner_window",
    route: { route_key: "synthetic-window-route", conversation_id: "synthetic-core", target_key: "synthetic-private", generation: 2 },
    window: { channel: "qq", type: "private", id: "90001", self_id: "90002" },
    window_binding: { generation: 3, owner_key: JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id]), target: { ...target } },
    owner_sender_allowlist: ["90001"],
    event: { event_id: "a".repeat(64), message_id: "-90003", message_seq: 0, sender_id: "90001", text, content: text },
  };
  const request = { delivery_id: "synthetic-delivery", message_id: "synthetic-message", source: { caller: { machine_id: "synthetic-machine", host: "qq", surface: "private", conversation_id: "synthetic-private" }, origin: { kind: "human_message", channel: "napcat_owner_window", source_ref: `owner-window-event:${windowSource.event.event_id}` }, identity_version: 2 }, target, body: { text, attachment_refs: [] }, window_source: windowSource, delivery_policy: "next_model_boundary", message_visibility: "hidden" };
  const calls = [];
  let receipt;
  const transport = new CodexProxyTransport({ baseUrl: "http://127.0.0.1:19001", token: "synthetic-token", relay: { host: "codex", conversation_id: "synthetic-core" }, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    if (options.method === "POST") receipt = { ...JSON.parse(options.body), thread_id: target.conversation_id, outcome: "accepted", request_sent: true, turn_id: "synthetic-turn", injection_method: "turn/start" };
    return new Response(JSON.stringify({ ok: true, delivery: receipt }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  return { request, transport, calls, getReceipt: () => receipt, setReceipt: next => { receipt = next; } };
}

test("window human provenance reaches HTTP without quote fields and queries only the original mixed relay scope", async context => {
  const state = fixture();
  context.after(() => state.transport.close());
  const original = structuredClone(state.request);
  const submitted = await state.transport.submit(state.request);
  assert.equal(submitted.outcome, "accepted");
  const body = state.calls[0].body;
  assert.deepEqual(body.window_source, original.window_source);
  assert.equal(body.text, original.body.text);
  assert.equal(body.message_visibility, "hidden");
  for (const field of ["in_reply_to", "forward_of", "attachment_refs"]) assert.ok(!Object.hasOwn(body, field));
  assert.deepEqual(body.target, { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: "synthetic-model" });
  assert.equal((await state.transport.query({ delivery_id: state.request.delivery_id }, { request: state.request })).outcome, "accepted");
  const query = new URL(state.calls[1].url).searchParams;
  assert.equal(query.get("source_host"), "codex");
  assert.equal(query.get("source_conversation_id"), "synthetic-core");
  assert.equal(query.get("source_machine_id"), null);
  assert.equal(query.get("target_machine_id"), "synthetic-machine");
  assert.deepEqual(state.request, original);
});

test("window adapter preserves its authenticated QQ source and carries no invented old quote relation", () => {
  const state = fixture();
  const message = { message_id: state.request.message_id, source_identity_version: 2, envelope: { caller: state.request.source.caller, origin: state.request.source.origin, text: state.request.body.text, attachment_refs: [], delivery_policy: "next_model_boundary", message_visibility: "hidden", in_reply_to: null }, native_window_source: state.request.window_source };
  const adapter = new CodexDeliveryAdapter({ transport: state.transport });
  const mapped = adapter.request({ message, delivery: { delivery_id: state.request.delivery_id }, target: state.request.target });
  assert.deepEqual(mapped.window_source, message.native_window_source);
  assert.equal(mapped.source.identity_version, 2);
  assert.equal(mapped.source.caller.host, "qq");
  assert.ok(!Object.hasOwn(mapped, "in_reply_to") && !Object.hasOwn(mapped, "forward_of"));
});

const invalidRequests = [
  ["unmarked identity", request => { delete request.source.identity_version; }],
  ["fake agent origin", request => { request.source.origin.kind = "agent_message"; }],
  ["foreign QQ caller", request => { request.source.caller.conversation_id = "other-window"; }],
  ["wrong caller surface", request => { request.source.caller.surface = "group"; }],
  ["fake quote relationship", request => { request.in_reply_to = "invented-core-message"; }],
  ["mixed quote and window", request => { request.forward_of = {}; }],
  ["foreign relay component", request => { request.window_source.route.conversation_id = "other-core"; }],
  ["wrong target generation", request => { request.window_source.window_binding.target.binding_generation = 2; }],
  ["foreign target machine", request => { request.window_source.window_binding.target.machine_id = "other-machine"; }],
  ["forged binding owner", request => { request.window_source.window_binding.owner_key = "[]"; }],
  ["wrong original sender", request => { request.window_source.event.sender_id = "90004"; }],
  ["wrong actual private window", request => { request.window_source.window.id = "90004"; }],
  ["changed native text", request => { request.window_source.event.content += "changed"; }],
  ["wrong event identity", request => { request.window_source.event.event_id = "b".repeat(64); }],
  ["invented native quote", request => { request.window_source.event.quoted_message_id = "90005"; }],
  ["duplicate owner allowlist", request => { request.window_source.owner_sender_allowlist.push("90001"); }],
];

for (const [label, change] of invalidRequests) test(`window provenance rejects ${label} before HTTP or recovery`, async context => {
  const state = fixture();
  context.after(() => state.transport.close());
  change(state.request);
  await assert.rejects(state.transport.submit(state.request), error => error.code === "codex_invalid_human_source" || error.code === "codex_unsupported_request");
  assert.equal(state.calls.length, 0);
});

test("window receipts reject a consistent but different provenance and leave original request unchanged", async context => {
  const state = fixture();
  context.after(() => state.transport.close());
  await state.transport.submit(state.request);
  const changed = structuredClone(state.getReceipt());
  changed.window_source.window_binding.generation += 1;
  state.setReceipt(changed);
  await assert.rejects(state.transport.query({ delivery_id: state.request.delivery_id }, { request: state.request }), { code: "codex_receipt_identity_mismatch" });
  assert.equal(state.request.window_source.window_binding.generation, 3);
});

test("window source normalization preserves full raw content while legacy quote cannot accept an extra window proof", () => {
  const state = fixture();
  const envelope = { origin: state.request.source.origin, relay: { host: "codex", conversation_id: "synthetic-core" }, window_source: state.request.window_source, target: state.request.target, binding_generation: 1, text: state.request.body.text };
  assert.equal(normalizeCodexHumanSource(envelope).window_source.event.content, state.request.body.text);
  assert.throws(() => normalizeCodexHumanSource({ ...envelope, origin: { ...envelope.origin, channel: "napcat_owner_reply" } }), { code: "codex_invalid_human_source" });
});
