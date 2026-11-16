import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSendInput, normalizeTarget, identityKey, digest, encodeCursor, decodeCursor } from "../src/contracts.mjs";

const source = { machine_id: "isolation-machine", host: "codex", conversation_id: "source" };
const target = normalizeTarget({ machine_id: "isolation-machine", host: "antigravity", conversation_id: "receiver", binding_id: "receiver-binding", binding_generation: 1, adapter_id: "mock", capabilities: { next_model_boundary: true }, evidence: "simulated" });
const principal = { id: "source", identity: source, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] };
function message(overrides = {}) {
  return {
    caller: source,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "source-event" },
    target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation },
    dedupe_key: "same-send",
    text: "请核对隔离材料",
    expires_at: "2099-01-01T00:00:00Z",
    ...overrides,
  };
}

test("normalized identity and payload hash are stable and namespace aware", () => {
  assert.equal(identityKey(source), identityKey({ ...source, surface: "desktop" }));
  assert.notEqual(identityKey(source), identityKey({ ...source, surface: "cli" }));
  assert.equal(digest({ text: "测试", target: "a" }), digest({ target: "a", text: "测试" }));
  assert.equal(digest(normalizeSendInput(message(), principal, target)), digest(normalizeSendInput(message(), principal, target)));
});

test("caller, target generation, origin and model overrides are checked", () => {
  assert.throws(() => normalizeSendInput(message({ caller: { ...source, conversation_id: "other" } }), principal, target), { code: "caller_mismatch" });
  assert.throws(() => normalizeSendInput(message({ target: { ...message().target, binding_generation: 2 } }), principal, target), { code: "binding_changed" });
  assert.throws(() => normalizeSendInput(message({ origin: { ...message().origin, kind: "owner_message" } }), principal, target), { code: "source_unverified" });
  assert.throws(() => normalizeSendInput(message({ model: "unexpected-model" }), principal, target), { code: "invalid_input" });
  assert.throws(() => normalizeSendInput(message(), { ...principal, allowed_targets: [] }, target), { code: "forbidden" });
});

test("original channel receipt requires its own component grant and explicit event IDs", () => {
  const binding = { component: "synthetic-channel", resource_id: "subscription", generation: 3, wake_id: "wake", event_ids: [1, "event-2"] };
  assert.throws(() => normalizeSendInput(message({ origin_receipt_binding: binding }), principal, target), { code: "source_unverified" });
  const channelPrincipal = { ...principal, channel_component: binding.component };
  const normalized = normalizeSendInput(message({ origin_receipt_binding: binding }), channelPrincipal, target);
  assert.deepEqual(normalized.origin_receipt_binding.event_ids, ["1", "event-2"]);
  assert.throws(() => normalizeSendInput(message({ origin_receipt_binding: { ...binding, event_ids: [{}] } }), channelPrincipal, target), { code: "invalid_input" });
  assert.throws(() => normalizeSendInput(message({ origin_receipt_binding: { ...binding, event_ids: [1, "1"] } }), channelPrincipal, target), { code: "invalid_input" });
});

test("cursor scope and unicode byte budgets are checked", () => {
  assert.equal(decodeCursor(encodeCursor("message-1", 7), "message-1"), 7);
  assert.throws(() => decodeCursor(encodeCursor("message-1", 7), "message-2"), { code: "invalid_cursor" });
  assert.throws(() => decodeCursor("broken", "message-1"), { code: "invalid_cursor" });
  assert.throws(() => normalizeSendInput(message({ text: "字".repeat(90000) }), principal, target), { code: "invalid_input" });
});

test("Codex visibility defaults hidden while legacy and non-Codex envelopes retain their original shape", () => {
  const codex = { ...target, host: "codex" };
  const input = message({ target: { ...message().target, host: "codex" } });
  assert.equal(normalizeSendInput(input, principal, codex).message_visibility, "hidden");
  for (const visibility of ["hidden", "visible"]) {
    assert.equal(normalizeSendInput({ ...input, message_visibility: visibility }, principal, codex).message_visibility, visibility);
  }
  assert.equal(Object.hasOwn(normalizeSendInput(input, principal, codex, { preserveLegacyVisibility: true }), "message_visibility"), false);
  assert.equal(Object.hasOwn(normalizeSendInput(message(), principal, target), "message_visibility"), false);
  for (const visibility of [null, false, "", "inherit", "HIDDEN", {}, []]) {
    assert.throws(() => normalizeSendInput({ ...input, message_visibility: visibility }, principal, codex), { code: "invalid_input" });
  }
  assert.throws(() => normalizeSendInput(message({ message_visibility: "hidden" }), principal, target), { code: "invalid_input" });
});
