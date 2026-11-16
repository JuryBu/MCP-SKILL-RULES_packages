import test from "node:test";
import assert from "node:assert/strict";
import { CoreError, identityKey } from "../src/contracts.mjs";
import { normalizeOwnerWindowBinding, normalizeOwnerWindowEvent } from "../src/owner-window-ingress.mjs";

const OWNER = "77000001";
const OTHER = "77000002";
const SELF = "77000009";
const SECRET = "synthetic-content-must-never-appear-in-errors";

function fixture(type = "private") {
  const sourceTarget = {
    machine_id: "synthetic-qq-machine", host: "qq", surface: type, conversation_id: "configured-owner-window",
    binding_id: "stable-qq-binding", binding_generation: 3, adapter_id: "configured-qq-adapter",
    capabilities: { next_model_boundary: true, when_idle: false }, evidence: "synthetic configured target",
  };
  const target = {
    machine_id: "synthetic-model-machine", host: "codex", surface: "desktop", conversation_id: "frozen-model-chat",
    binding_id: "model-binding", binding_generation: 11,
  };
  const window = { channel: "qq", type, id: type === "private" ? OWNER : "88000001", self_id: SELF };
  const event = {
    event_id: "a".repeat(64), message_id: "-88000002", message_seq: 7, sender_id: OWNER,
    text: `  ${SECRET}\n完整原文  `, content: `  ${SECRET}\n完整原文  `, source_kind: "human_message",
    route_key: "native-window-route", conversation_id: "stable-core-component", target_key: sourceTarget.conversation_id,
    route_generation: 9, window: { ...window }, owner_sender_allowlist: [OWNER],
    window_binding: { generation: 4, owner_key: identityKey(target), target },
  };
  const options = {
    routeKey: event.route_key, conversationId: event.conversation_id, targetKey: event.target_key,
    window, ownerSenderAllowlist: [OWNER], sourceTarget,
  };
  return { event, options };
}

function rejected(error) {
  assert.ok(error instanceof CoreError);
  assert.equal(error.code, "owner_window_event_invalid");
  assert.equal(error.message, "QQ窗口原生事件校验失败");
  assert.deepEqual(error.details, {});
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
}

function assertFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertFrozen(nested);
}

for (const type of ["private", "group"]) {
  test(`${type} event captures the exact separate window provenance and configured QQ source`, () => {
    const { event, options } = fixture(type);
    const output = normalizeOwnerWindowEvent(event, options);
    assert.deepEqual(output, {
      native_event_id: event.event_id, route_generation: 9, text: event.text,
      source_target: options.sourceTarget, target: event.window_binding.target,
      native_source: {
        provider: "napcat_owner_window",
        route: { route_key: event.route_key, conversation_id: event.conversation_id, target_key: event.target_key, generation: 9 },
        window: event.window, window_binding: event.window_binding, owner_sender_allowlist: [OWNER],
        event: { event_id: event.event_id, message_id: event.message_id, message_seq: 7, sender_id: OWNER,
          text: event.text, content: event.content },
      },
    });
    assertFrozen(output);
    assert.equal(Object.isFrozen(event), false);
    assert.equal(Object.isFrozen(options.sourceTarget), false);
    assert.notStrictEqual(output.source_target, options.sourceTarget);
    assert.notStrictEqual(output.target, event.window_binding.target);
    assert.notStrictEqual(output.native_source.window, event.window);
    assert.notStrictEqual(output.native_source.owner_sender_allowlist, event.owner_sender_allowlist);
    assert.equal(JSON.stringify(output).includes("quoted_message_id"), false);
    assert.equal(JSON.stringify(output).includes("wake_id"), false);
    event.text = "later mutation";
    event.window_binding.target.conversation_id = "later-model";
    event.owner_sender_allowlist.push(OTHER);
    options.sourceTarget.capabilities.next_model_boundary = false;
    options.window.self_id = OTHER;
    assert.equal(output.text.includes(SECRET), true);
    assert.equal(output.target.conversation_id, "frozen-model-chat");
    assert.deepEqual(output.native_source.owner_sender_allowlist, [OWNER]);
    assert.equal(output.source_target.capabilities.next_model_boundary, true);
    assert.equal(output.native_source.window.self_id, SELF);
  });
}

test("provider, Core window binding, model target and source binding generations remain independent", () => {
  const { event, options } = fixture();
  const output = normalizeOwnerWindowEvent(event, options);
  assert.equal(output.route_generation, 9);
  assert.equal(output.native_source.window_binding.generation, 4);
  assert.equal(output.target.binding_generation, 11);
  assert.equal(output.source_target.binding_generation, 3);
  assert.deepEqual(normalizeOwnerWindowEvent(event, options), output);
});

test("native owner claims can be narrower than trusted configuration but cannot widen it", () => {
  const { event, options } = fixture("group");
  options.ownerSenderAllowlist.push(OTHER);
  const output = normalizeOwnerWindowEvent(event, options);
  assert.deepEqual(output.native_source.owner_sender_allowlist, [OWNER]);
  options.ownerSenderAllowlist = [OWNER];
  event.owner_sender_allowlist.push(OTHER);
  assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
});

test("text and content are exact strings with no preview shortening, reformatting or synthesized quote", () => {
  const { event, options } = fixture();
  const native = "[CQ:image,file=synthetic.png]\n" + "原文".repeat(3000);
  event.text = native;
  event.content = native;
  assert.equal(normalizeOwnerWindowEvent(event, options).text, native);
  event.text = "x".repeat(1024 * 1024);
  event.content = event.text;
  assert.equal(normalizeOwnerWindowEvent(event, options).text.length, 1024 * 1024);
  event.text += "x";
  event.content = event.text;
  assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
  event.text = "原".repeat(Math.floor(1024 * 1024 / 3) + 1);
  event.content = event.text;
  assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
});

const invalidEvents = [
  ["route", event => { event.route_key = "foreign-route"; }],
  ["component CID", event => { event.conversation_id = "foreign-component"; }],
  ["target key", event => { event.target_key = "foreign-target"; }],
  ["source kind", event => { event.source_kind = "agent_message"; }],
  ["missing source kind", event => { delete event.source_kind; }],
  ["event ID", event => { event.event_id = "opaque-quote-id"; }],
  ["upper-case event ID", event => { event.event_id = "A".repeat(64); }],
  ["numeric native message ID", event => { event.message_id = 88000002; }],
  ["invalid native message ID", event => { event.message_id = "088000002"; }],
  ["sequence string", event => { event.message_seq = "7"; }],
  ["negative sequence", event => { event.message_seq = -1; }],
  ["unsafe sequence", event => { event.message_seq = Number.MAX_SAFE_INTEGER + 1; }],
  ["sender outside trusted owners", event => { event.sender_id = OTHER; }],
  ["self sender", event => { event.sender_id = SELF; }],
  ["numeric sender", event => { event.sender_id = 77000001; }],
  ["window channel", event => { event.window.channel = "wechat"; }],
  ["window type", event => { event.window.type = "group"; }],
  ["window ID", event => { event.window.id = OTHER; }],
  ["window self ID", event => { event.window.self_id = OTHER; }],
  ["numeric window ID", event => { event.window.id = 77000001; }],
  ["window extra field", event => { event.window.group_id = "synthetic"; }],
  ["missing text", event => { delete event.text; }],
  ["missing content", event => { delete event.content; }],
  ["different content", event => { event.content = "changed"; }],
  ["non-string content", event => { event.content = { text: event.text }; }],
  ["quoted message provenance", event => { event.quoted_message_id = "-88000001"; }],
  ["wake provenance", event => { event.wake_id = "old-wake"; }],
  ["content unavailable", event => { event.unavailable = "missing"; }],
  ["untrusted provider override", event => { event.provider = "napcat_owner"; }],
  ["owner key", event => { event.window_binding.owner_key = "forged"; }],
  ["target CID identity drift", event => { event.window_binding.target.conversation_id = "different-model"; }],
  ["seventh model identity field", event => { event.window_binding.target.adapter_id = "unexpected"; }],
  ["missing model identity", event => { delete event.window_binding.target.machine_id; }],
  ["wildcard model identity", event => { event.window_binding.target.conversation_id = "*"; }],
  ...[undefined, null, 0, -1, "1", 1.5, Number.MAX_SAFE_INTEGER + 1].flatMap((value, index) => [
    [`provider generation ${index}`, event => { event.route_generation = value; }],
    [`Core binding generation ${index}`, event => { event.window_binding.generation = value; }],
    [`model binding generation ${index}`, event => { event.window_binding.target.binding_generation = value; }],
  ]),
  ...[undefined, [], [OTHER], [OWNER, OWNER], Array(1), [77000001], [OWNER, OTHER]].map((value, index) =>
    [`native owner allowlist ${index}`, event => { event.owner_sender_allowlist = value; }]),
];

for (const [name, mutate] of invalidEvents) {
  test(`rejects ${name} with only a fixed sanitized validation error`, () => {
    const { event, options } = fixture();
    mutate(event);
    assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
  });
}

const invalidOptions = [
  ["missing source target", options => { delete options.sourceTarget; }],
  ["wrong QQ source host", options => { options.sourceTarget.host = "codex"; }],
  ["source target CID mismatch", options => { options.sourceTarget.conversation_id = "arbitrary-qq"; }],
  ["source target window mismatch", options => { options.sourceTarget.surface = "group"; }],
  ["source target binding generation", options => { options.sourceTarget.binding_generation = 0; }],
  ["source target capability", options => { options.sourceTarget.capabilities.when_idle = "true"; }],
  ["source target extra field", options => { options.sourceTarget.token = SECRET; }],
  ["padded component", options => { options.conversationId = " stable-core-component"; }],
  ["control target key", options => { options.targetKey = "target\u0000value"; }],
  ["oversized UTF8 component", options => { options.conversationId = "原".repeat(86); }],
  ["missing expected window", options => { delete options.window; }],
  ["missing expected self ID", options => { delete options.window.self_id; }],
  ...[undefined, [], [OTHER], [OWNER, OWNER], Array(1), [77000001], Array(33).fill(OWNER)].map((value, index) =>
    [`trusted owner allowlist ${index}`, options => { options.ownerSenderAllowlist = value; }]),
];

for (const [name, mutate] of invalidOptions) {
  test(`rejects invalid trusted ${name}`, () => {
    const { event, options } = fixture();
    mutate(options);
    assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
  });
}

test("private native owner policy cannot claim an extra trusted contact", () => {
  const { event, options } = fixture();
  options.ownerSenderAllowlist.push(OTHER);
  event.owner_sender_allowlist.push(OTHER);
  assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
});

test("plain null-prototype inputs retain their data while inherited, hidden, proxy and accessor data are rejected", () => {
  const { event, options } = fixture();
  assert.equal(normalizeOwnerWindowEvent(Object.assign(Object.create(null), event), options).native_event_id, event.event_id);
  for (const input of [undefined, null, [], Object.create(event), new Proxy(event, {})]) {
    assert.throws(() => normalizeOwnerWindowEvent(input, options), rejected);
  }
  let evaluated = 0;
  const getter = () => { evaluated += 1; throw new Error(SECRET); };
  const hostileEvent = Object.defineProperty({ ...event }, "text", { enumerable: true, get: getter });
  const hostileOptions = Object.defineProperty({ ...options }, "sourceTarget", { enumerable: true, get: getter });
  const hostileOwners = Object.defineProperty([OWNER], "0", { enumerable: true, get: getter });
  assert.throws(() => normalizeOwnerWindowEvent(hostileEvent, options), rejected);
  assert.throws(() => normalizeOwnerWindowEvent(event, hostileOptions), rejected);
  assert.throws(() => normalizeOwnerWindowEvent(event, { ...options, ownerSenderAllowlist: hostileOwners }), rejected);
  for (const key of ["text", Symbol("hidden")]) {
    const hidden = Object.defineProperty({ ...event }, key, { value: event.text, enumerable: false });
    assert.throws(() => normalizeOwnerWindowEvent(hidden, options), rejected);
  }
  assert.equal(evaluated, 0);
});

test("binding capture is strict, isolated from inputs and deeply frozen for transport reuse", () => {
  const { event } = fixture();
  const binding = normalizeOwnerWindowBinding(event.window_binding);
  assertFrozen(binding);
  assert.deepEqual(binding, event.window_binding);
  event.window_binding.target.host = "changed-after-capture";
  assert.equal(binding.target.host, "codex");
  assert.throws(() => normalizeOwnerWindowBinding(event.window_binding), rejected);
});

test("expected window including self_id can come from a trusted successful registration or get route.window", () => {
  const { event, options } = fixture("group");
  const trustedRegistration = Object.freeze({ ok: true, route: Object.freeze({
    route_key: options.routeKey, conversation_id: options.conversationId, target_key: options.targetKey,
    window: Object.freeze({ channel: "qq", type: "group", id: "88000001", self_id: SELF }),
  }) });
  options.window = trustedRegistration.route.window;
  assert.equal(normalizeOwnerWindowEvent(event, options).native_source.window.self_id, SELF);
  event.window.self_id = OTHER;
  assert.throws(() => normalizeOwnerWindowEvent(event, options), rejected);
  assert.equal(options.window.self_id, SELF);
});
