import test from "node:test";
import assert from "node:assert/strict";
import { CoreError, digest, identityKey, normalizeIdentity, normalizeSendInput } from "../src/contracts.mjs";
import { createOwnerReplyReader, OWNER_REPLY_LIMITS } from "../src/owner-replies.mjs";
import { normalizeReplyForwardingRules, replyForwardBindingForMessage, planOwnerReplyForward } from "../src/reply-forwarding.mjs";

function configuration() {
  const from = {
    machine_id: "synthetic-machine", host: "qq", surface: "group", conversation_id: "synthetic-owner-target",
    binding_id: "synthetic-qq-binding", binding_generation: 3, adapter_id: "synthetic-qq",
    capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic-provider",
  };
  const to = {
    machine_id: "synthetic-machine", host: "antigravity", surface: "desktop", conversation_id: "synthetic-ag-source",
    binding_id: "synthetic-ag-binding", binding_generation: 5, adapter_id: "synthetic-ag",
    capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic-provider",
  };
  return {
    rules: [{ id: "synthetic-owner-return", source_principal_id: "synthetic-source", from_binding_id: from.binding_id, to_binding_id: to.binding_id, ttl_ms: 60000, owner_sender_allowlist: ["90001"] }],
    targets: [from, to],
    principals: [{ id: "synthetic-source", identity: normalizeIdentity(to), allowed_targets: [from.binding_id], origin_kinds: ["agent_message"] }],
  };
}

function fixture() {
  const config = configuration();
  const rules = normalizeReplyForwardingRules(config);
  const binding = replyForwardBindingForMessage(rules, config.principals[0], config.targets[0]);
  const from = binding.from_target;
  const to = binding.to_target;
  const route = { route_key: "synthetic-route", conversation_id: "synthetic-maintenance-caller", target_key: from.conversation_id, generation: 7 };
  const message = {
    message_id: "synthetic-original-message", principal_id: config.principals[0].id,
    source_key: identityKey(to), target_key: identityKey(from), reply_forward_binding: binding,
    envelope: {
      caller: normalizeIdentity(to), origin: { kind: "agent_message", channel: "host_mcp", source_ref: "synthetic-original-source" },
      target: { ...normalizeIdentity(from), binding_id: from.binding_id, binding_generation: from.binding_generation },
      text: "原AG通知", attachment_refs: [],
    },
  };
  const delivery = {
    message_id: message.message_id, delivery_id: "synthetic-original-delivery", target_key: identityKey(from),
    status: "accepted", outcome: "accepted", target_snapshot: structuredClone(from),
    evidence: {
      outcome: "accepted", delivery_id: "synthetic-original-delivery", target_key: identityKey(from),
      evidence: { kind: "receipt", native_receipt: { provider: "napcat_owner", verified: true, state_persisted: true, message_id: "80001", reply_route: structuredClone(route) } },
    },
  };
  const reply = {
    native_message_id: "80002", native_conversation_id: from.conversation_id, source_step_index: 321,
    text: "  主人的原文\n[CQ:reply,id=80001]请看这条～  ",
    native_source: {
      provider: "napcat_owner", route: structuredClone(route), original_qq_message_id: "80001",
      event: { event_id: "synthetic-native-event", message_id: "80002", message_seq: 321, quoted_message_id: "80001", sender_id: "90001" },
    },
  };
  return { message, delivery, reply, binding, observedAt: "2026-11-15T16:00:00.000Z" };
}

function mutatePath(value, path, replacement) {
  const fields = path.split(".");
  const last = fields.pop();
  let parent = value;
  for (const field of fields) parent = parent[field];
  parent[last] = replacement;
}

function mutableFixture() {
  const input = structuredClone(fixture());
  input.message.reply_forward_binding = structuredClone(input.binding);
  return input;
}

test("forwarding is off by default and does not validate disabled registries", () => {
  assert.deepEqual(normalizeReplyForwardingRules(), []);
  assert.deepEqual(normalizeReplyForwardingRules({ rules: [], targets: null, principals: "dynamic" }), []);
  const config = configuration();
  assert.deepEqual(normalizeReplyForwardingRules({ rules: [], targets: [...config.targets, ...config.targets], principals: [...config.principals, ...config.principals] }), []);
  assert.equal(replyForwardBindingForMessage([], config.principals[0], config.targets[0]), null);
  assert.equal(planOwnerReplyForward({ ...fixture(), binding: null }), null);
});

test("normalization copies and deeply freezes only the documented safe rule fields", () => {
  const config = configuration();
  config.rules[0].adopt_reply_events = [{ message_id: "historical-message", native_event_id: "historical-event" }];
  config.targets[0].token = "synthetic-private-sentinel";
  config.targets[1].credentials = { token: "synthetic-private-sentinel" };
  config.principals[0].http_token = "synthetic-private-sentinel";
  const normalized = normalizeReplyForwardingRules(config);
  const before = structuredClone(normalized);
  assert.deepEqual(Object.keys(normalized[0]).sort(), ["id", "source_principal_id", "from_target", "to_target", "ttl_ms", "owner_sender_allowlist", "adopt_reply_events", "principal_id"].sort());
  assert.equal(normalized[0].principal_id, "owner-reply-forward:synthetic-owner-return");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized[0].from_target.capabilities), true);
  assert.equal(Object.isFrozen(normalized[0].adopt_reply_events[0]), true);
  assert.equal(Object.isFrozen(config.targets[0]), false);
  config.rules[0].id = "changed";
  config.rules[0].owner_sender_allowlist.push("90002");
  config.rules[0].adopt_reply_events[0].native_event_id = "changed";
  config.targets[1].conversation_id = "changed";
  config.targets[0].capabilities.when_idle = false;
  config.principals[0].identity.host = "codex";
  assert.deepEqual(normalized, before);
  assert.equal(JSON.stringify(normalized).includes("synthetic-private-sentinel"), false);
});

test("normalization always provides an adoption array and accepts the exact configured limits", () => {
  const config = configuration();
  assert.deepEqual(normalizeReplyForwardingRules(config)[0].adopt_reply_events, []);
  config.rules[0].id = `${"界".repeat(26)}ab`;
  config.rules[0].ttl_ms = 604800000;
  config.rules[0].owner_sender_allowlist = Array.from({ length: 32 }, (_, index) => String(90001 + index));
  config.rules[0].adopt_reply_events = Array.from({ length: 100 }, (_, index) => ({ message_id: `historical-${index}`, native_event_id: `event-${index}` }));
  assert.equal(normalizeReplyForwardingRules(config)[0].adopt_reply_events.length, 100);
  config.rules[0].ttl_ms = 1;
  assert.equal(normalizeReplyForwardingRules(config)[0].ttl_ms, 1);
});

const invalidConfigurations = [
  ["non-array rules", config => { config.rules = {}; }],
  ["non-array targets", config => { config.targets = {}; }],
  ["non-array principals", config => { config.principals = {}; }],
  ["unknown rule field", config => { config.rules[0].enabled = true; }],
  ["null rule", config => { config.rules[0] = null; }],
  ["sparse rule", config => { delete config.rules[0]; }],
  ["empty rule id", config => { config.rules[0].id = ""; }],
  ["over-byte rule id", config => { config.rules[0].id = "界".repeat(27); }],
  ["control in rule id", config => { config.rules[0].id = "bad\nrule"; }],
  ["trimmed rule id", config => { config.rules[0].id = " rule"; }],
  ["zero ttl", config => { config.rules[0].ttl_ms = 0; }],
  ["over-limit ttl", config => { config.rules[0].ttl_ms = 604800001; }],
  ["fraction ttl", config => { config.rules[0].ttl_ms = 1.5; }],
  ["string ttl", config => { config.rules[0].ttl_ms = "60000"; }],
  ["missing source principal", config => { config.rules[0].source_principal_id = "absent"; }],
  ["duplicate public principal", config => { config.principals.push(structuredClone(config.principals[0])); }],
  ["internal principal collides with public id", config => { config.principals.push({ ...config.principals[0], id: `owner-reply-forward:${config.rules[0].id}` }); }],
  ["different source identity", config => { config.principals[0].identity.conversation_id = "wrong-source"; }],
  ["source lacks qq permission", config => { config.principals[0].allowed_targets = []; }],
  ["unknown from binding", config => { config.rules[0].from_binding_id = "absent"; }],
  ["unknown to binding", config => { config.rules[0].to_binding_id = "absent"; }],
  ["non-qq from binding", config => { config.targets[0].host = "codex"; }],
  ["unsupported human target", config => { config.targets[1].host = "windsurf"; config.principals[0].identity.host = "windsurf"; }],
  ["duplicate target binding", config => { config.targets.push({ ...config.targets[0], conversation_id: "different" }); }],
  ["duplicate target identity", config => { config.targets.push({ ...config.targets[0], binding_id: "different" }); }],
  ["invalid target generation", config => { config.targets[0].binding_generation = 0; }],
  ["missing target adapter", config => { delete config.targets[0].adapter_id; }],
  ["null target", config => { config.targets.push(null); }],
  ["missing sender allowlist", config => { delete config.rules[0].owner_sender_allowlist; }],
  ["empty sender allowlist", config => { config.rules[0].owner_sender_allowlist = []; }],
  ["over-limit sender allowlist", config => { config.rules[0].owner_sender_allowlist = Array.from({ length: 33 }, (_, index) => String(90001 + index)); }],
  ["duplicate sender", config => { config.rules[0].owner_sender_allowlist = ["90001", "90001"]; }],
  ["numeric sender", config => { config.rules[0].owner_sender_allowlist = [90001]; }],
  ["non-digit sender", config => { config.rules[0].owner_sender_allowlist = ["owner"]; }],
  ["unreadable qq sender", config => { config.rules[0].owner_sender_allowlist = ["090001"]; }],
  ["sparse sender", config => { config.rules[0].owner_sender_allowlist = Array(1); }],
  ["null adoption", config => { config.rules[0].adopt_reply_events = null; }],
  ["over-limit adoption", config => { config.rules[0].adopt_reply_events = Array.from({ length: 101 }, (_, index) => ({ message_id: `message-${index}`, native_event_id: `event-${index}` })); }],
  ["empty adoption message", config => { config.rules[0].adopt_reply_events = [{ message_id: "", native_event_id: "event" }]; }],
  ["empty adoption event", config => { config.rules[0].adopt_reply_events = [{ message_id: "message", native_event_id: "" }]; }],
  ["over-limit adoption event", config => { config.rules[0].adopt_reply_events = [{ message_id: "message", native_event_id: "界".repeat(86) }]; }],
  ["unknown adoption key", config => { config.rules[0].adopt_reply_events = [{ message_id: "message", native_event_id: "event", replay_all: true }]; }],
  ["duplicate adoption pair", config => { config.rules[0].adopt_reply_events = Array.from({ length: 2 }, () => ({ message_id: "message", native_event_id: "event" })); }],
  ["duplicate source and from pair", config => { config.rules.push({ ...config.rules[0], id: "another-rule" }); }],
  ["globally duplicate rule and internal ids", config => {
    config.targets.push({ ...config.targets[0], conversation_id: "another-qq", binding_id: "another-qq" });
    config.principals[0].allowed_targets.push("another-qq");
    config.rules.push({ ...config.rules[0], from_binding_id: "another-qq" });
  }],
];

for (const [name, change] of invalidConfigurations) {
  test(`normalization rejects ${name} with CoreError`, () => {
    const config = configuration();
    change(config);
    assert.throws(() => normalizeReplyForwardingRules(config), CoreError);
  });
}

test("invalid configuration containers always fail with CoreError", () => {
  for (const options of [null, false, [], "invalid"]) assert.throws(() => normalizeReplyForwardingRules(options), CoreError);
});

test("binding helper accepts normalized id and target snapshots and returns a separate frozen subset", () => {
  const config = configuration();
  const rules = normalizeReplyForwardingRules(config);
  const binding = replyForwardBindingForMessage([rules[0]], config.principals[0], structuredClone(config.targets[0]));
  assert.deepEqual(Object.keys(binding).sort(), ["rule_id", "source_principal_id", "from_target", "to_target", "ttl_ms", "owner_sender_allowlist", "principal_id"].sort());
  assert.equal(binding.rule_id, rules[0].id);
  assert.notEqual(binding.from_target, rules[0].from_target);
  assert.notEqual(binding.owner_sender_allowlist, rules[0].owner_sender_allowlist);
  assert.equal(Object.isFrozen(binding.to_target.capabilities), true);
  assert.equal(Object.isFrozen(binding.owner_sender_allowlist), true);
  assert.equal(replyForwardBindingForMessage([rules[0], rules[0]], config.principals[0], config.targets[0]), null);
  config.principals[0].allowed_targets = [];
  assert.equal(replyForwardBindingForMessage(rules, config.principals[0], config.targets[0]), null);
});

for (const [field, value] of [["machine_id", "wrong"], ["host", "codex"], ["surface", "private"], ["conversation_id", "wrong"], ["binding_id", "wrong"], ["binding_generation", 4], ["adapter_id", "wrong"]]) {
  test(`binding refuses a different QQ ${field}`, () => {
    const config = configuration();
    const rules = normalizeReplyForwardingRules(config);
    config.targets[0][field] = value;
    assert.equal(replyForwardBindingForMessage(rules, config.principals[0], config.targets[0]), null);
  });
}

test("binding refuses a different source principal or AG identity", () => {
  const config = configuration();
  const rules = normalizeReplyForwardingRules(config);
  assert.equal(replyForwardBindingForMessage(rules, { ...config.principals[0], id: "wrong" }, config.targets[0]), null);
  for (const field of ["machine_id", "host", "surface", "conversation_id"]) {
    const principal = structuredClone(config.principals[0]);
    principal.identity[field] = "wrong";
    assert.equal(replyForwardBindingForMessage(rules, principal, config.targets[0]), null);
  }
});

test("planning preserves raw QQ text, human role and exact source provenance without changing inputs", () => {
  const input = fixture();
  const before = structuredClone(input);
  const planned = planOwnerReplyForward(input);
  assert.deepEqual(input, before);
  assert.deepEqual(planned.envelope, {
    caller: normalizeIdentity(input.binding.from_target),
    origin: { kind: "human_message", channel: "napcat_owner_reply", source_ref: "owner-event:synthetic-native-event" },
    target: { ...normalizeIdentity(input.binding.to_target), binding_id: input.binding.to_target.binding_id, binding_generation: 5 },
    dedupe_key: `owner-reply:${digest([input.message.message_id, "synthetic-native-event"])}`,
    text: input.reply.text, attachment_refs: [], delivery_policy: "next_model_boundary", reply_required: false,
    expires_at: "2026-11-15T16:01:00.000Z", in_reply_to: input.message.message_id, origin_receipt_binding: null,
  });
  assert.deepEqual(planned.target, input.binding.to_target);
  assert.equal(planned.principal_id, input.binding.principal_id);
  assert.deepEqual(planned.forward_of, { message_id: input.message.message_id, delivery_id: input.delivery.delivery_id, native_source: input.reply.native_source });
  assert.equal(Object.isFrozen(planned.forward_of.native_source.event), true);
  assert.equal(Object.isFrozen(planned.envelope.attachment_refs), true);
  const internal = { identity: input.binding.from_target, allowed_targets: [planned.target.binding_id], origin_kinds: ["human_message"] };
  assert.deepEqual(normalizeSendInput(planned.envelope, internal, planned.target), planned.envelope);
});

test("registered Codex sender receives the same native human source under its own frozen return binding", () => {
  const config = configuration();
  config.targets[1].host = "codex";
  config.targets[1].adapter_id = "synthetic-codex-return";
  config.principals[0].identity.host = "codex";
  const rules = normalizeReplyForwardingRules(config);
  const binding = replyForwardBindingForMessage(rules, config.principals[0], config.targets[0]);
  const input = mutableFixture();
  input.binding = binding;
  input.message.reply_forward_binding = structuredClone(binding);
  input.message.source_key = identityKey(binding.to_target);
  input.message.envelope.caller = normalizeIdentity(binding.to_target);
  const planned = planOwnerReplyForward(input);
  assert.equal(planned.target.host, "codex");
  assert.equal(planned.target.adapter_id, "synthetic-codex-return");
  assert.equal(planned.envelope.origin.kind, "human_message");
  assert.equal(planned.envelope.caller.host, "qq");
  assert.equal(planned.envelope.in_reply_to, input.message.message_id);
  assert.deepEqual(planned.forward_of.native_source, input.reply.native_source);
});

test("frozen binding and plan survive JSON reload and do not consult Date.now", () => {
  const input = fixture();
  const original = planOwnerReplyForward(input);
  const now = Date.now;
  try {
    Date.now = () => { throw new Error("clock must not affect durable replay"); };
    assert.deepEqual(planOwnerReplyForward(JSON.parse(JSON.stringify(input))), original);
  } finally {
    Date.now = now;
  }
  input.reply.native_source.event.event_id = "a-different-event";
  const different = planOwnerReplyForward(input);
  assert.notEqual(different.envelope.dedupe_key, original.envelope.dedupe_key);
  assert.equal(original.forward_of.native_source.event.event_id, "synthetic-native-event");
});

test("valid offset timestamps and optional persisted reply evidence keep the same plan", () => {
  const input = fixture();
  const original = planOwnerReplyForward(input);
  input.observedAt = "2026-11-16T00:00:00+08:00";
  input.reply.delivery_id = input.delivery.delivery_id;
  input.reply.native_event_id = input.reply.native_source.event.event_id;
  input.reply.evidence = { kind: "native_reply", source: "adapter.observeReply", ...structuredClone(input.binding.from_target) };
  assert.deepEqual(planOwnerReplyForward(input), original);
  delete input.message.reply_forward_binding;
  assert.deepEqual(planOwnerReplyForward(input), original);
});

const rejectedPlans = [
  ["observedAt", "not-an-iso-date"], ["observedAt", "2026-11-15"], ["observedAt", "2026-02-30T00:00:00Z"],
  ["observedAt", "2026-11-15T16:00:00"], ["observedAt", "2026-11-15T24:00:00Z"],
  ["binding.principal_id", "wrong"], ["binding.ttl_ms", 0], ["binding.from_target.host", "codex"], ["binding.to_target.host", "codex"],
  ["message.principal_id", "wrong"], ["message.source_key", "wrong"], ["message.target_key", "wrong"],
  ["message.envelope.origin.kind", "human_message"], ["message.envelope.origin.channel", ""], ["message.envelope.origin.source_ref", ""],
  ["message.envelope.caller.host", "codex"], ["message.envelope.caller.conversation_id", "wrong"],
  ["message.envelope.target.binding_generation", 4], ["message.envelope.target.binding_id", "wrong"],
  ["message.envelope.target.host", "antigravity"], ["message.envelope.target.surface", "private"],
  ["message.envelope.target.conversation_id", "wrong"], ["message.envelope.target.machine_id", "wrong"],
  ["delivery.message_id", "wrong"], ["delivery.delivery_id", "wrong"], ["delivery.target_key", "wrong"],
  ["delivery.status", "unknown"], ["delivery.outcome", "unknown"],
  ["delivery.target_snapshot.binding_generation", 4], ["delivery.target_snapshot.binding_id", "wrong"],
  ["delivery.target_snapshot.adapter_id", "wrong"], ["delivery.target_snapshot.machine_id", "wrong"],
  ["delivery.target_snapshot.host", "antigravity"], ["delivery.target_snapshot.surface", "private"], ["delivery.target_snapshot.conversation_id", "wrong"],
  ["delivery.evidence.outcome", "unknown"], ["delivery.evidence.delivery_id", "wrong"], ["delivery.evidence.target_key", "wrong"],
  ["delivery.evidence.evidence.kind", "transport"], ["delivery.evidence.evidence.native_receipt.provider", "wrong"],
  ["delivery.evidence.evidence.native_receipt.verified", false], ["delivery.evidence.evidence.native_receipt.state_persisted", false],
  ["delivery.evidence.evidence.native_receipt.message_id", "not-qq"], ["delivery.evidence.evidence.native_receipt.reply_route", null],
  ["reply.native_source.provider", "wrong"], ["reply.native_source.original_qq_message_id", "wrong"],
  ["reply.native_source.route.route_key", "wrong"], ["reply.native_source.route.conversation_id", "wrong"],
  ["reply.native_source.route.target_key", "wrong"], ["reply.native_source.route.generation", 8],
  ["reply.native_source.event.event_id", ""], ["reply.native_source.event.event_id", "event\n"], ["reply.native_source.event.event_id", "界".repeat(86)],
  ["reply.native_source.event.message_id", "80003"], ["reply.native_source.event.message_seq", 322],
  ["reply.native_source.event.quoted_message_id", "80000"], ["reply.native_source.event.sender_id", "90002"],
  ["reply.native_source.event.sender_id", 90001], ["reply.native_source.event.text", "changed text"],
  ["reply.native_message_id", "80001"], ["reply.native_message_id", "invalid"], ["reply.native_conversation_id", "wrong"],
  ["reply.source_step_index", -1], ["reply.source_step_index", 1.5], ["reply.source_step_index", "321"],
  ["reply.native_event_id", "wrong"], ["reply.delivery_id", "wrong"], ["reply.text", "   "],
  ["reply.text", "界".repeat(5462)], ["reply.text", "a".repeat(16385)],
  ["reply.evidence", { kind: "receipt" }], ["message.reply_forward_binding.ttl_ms", 1],
];

for (const [path, value] of rejectedPlans) {
  test(`plan rejects inconsistent ${path} (${String(value).slice(0, 24)})`, () => {
    const input = mutableFixture();
    mutatePath(input, path, value);
    assert.equal(planOwnerReplyForward(input), null);
  });
}

test("planning remains fail-closed for missing containers and unsupported replies", () => {
  for (const input of [undefined, null, {}, { ...fixture(), reply: { status: "unsupported", reason: "incomplete_page", reply: null } }]) {
    assert.equal(planOwnerReplyForward(input), null);
  }
});

test("planner accepts exact QQ text byte limit and reconstructs provenance without unknown fields or credentials", () => {
  const input = fixture();
  input.reply.text = "a".repeat(OWNER_REPLY_LIMITS.textBytes);
  input.reply.credentials = "synthetic-private-sentinel";
  input.reply.native_source.credentials = "synthetic-private-sentinel";
  input.reply.native_source.route.token = "synthetic-private-sentinel";
  input.reply.native_source.event.metadata = { token: "synthetic-private-sentinel" };
  input.delivery.evidence.evidence.native_receipt.token = "synthetic-private-sentinel";
  const planned = planOwnerReplyForward(input);
  assert.equal(planned.envelope.text, input.reply.text);
  assert.equal(JSON.stringify(planned).includes("synthetic-private-sentinel"), false);
  assert.deepEqual(Object.keys(planned.forward_of).sort(), ["message_id", "delivery_id", "native_source"].sort());
  assert.deepEqual(Object.keys(planned.forward_of.native_source).sort(), ["provider", "route", "original_qq_message_id", "event"].sort());
  assert.deepEqual(Object.keys(planned.forward_of.native_source.route).sort(), ["route_key", "conversation_id", "target_key", "generation"].sort());
  assert.deepEqual(Object.keys(planned.forward_of.native_source.event).sort(), ["event_id", "message_id", "message_seq", "quoted_message_id", "sender_id"].sort());
});

const rejectedPages = [
  ["unconfirmed page", page => { page.ok = false; }],
  ["wrong page route key", page => { page.route.route_key = "wrong"; }],
  ["wrong page caller", page => { page.route.conversation_id = "wrong"; }],
  ["wrong page target", page => { page.route.target_key = "wrong"; }],
  ["wrong page generation", page => { page.route.generation += 1; }],
  ["wrong page original QQ id", page => { page.original_qq_message_id = "80000"; }],
  ["incomplete page cursor", page => { page.partial = true; }],
  ["non-array page events", page => { page.events = {}; }],
  ["duplicate page event", page => { page.events.push(structuredClone(page.events[0])); }],
  ["non-owner page sender", page => { page.events[0].sender_id = "90002"; }],
];

async function readPageReply(input, change = () => {}) {
  const source = input.reply.native_source;
  const reader = createOwnerReplyReader({
    enabled: true,
    callerConversationId: source.route.conversation_id,
    ownerSenderAllowlist: input.binding.owner_sender_allowlist,
    binding: { message_id: input.message.message_id, delivery_id: input.delivery.delivery_id, route: source.route },
    async readPage() {
      const page = { ok: true, route: structuredClone(source.route), original_qq_message_id: source.original_qq_message_id, events: [{ ...source.event, text: input.reply.text }], next_cursor: null, partial: false };
      change(page);
      return page;
    },
  });
  return reader({ message: input.message, delivery: input.delivery, target: input.binding.from_target });
}

test("QQ reader output satisfies the forwarding contract without rewriting the original body", async () => {
  const input = fixture();
  const expected = planOwnerReplyForward(input);
  input.reply = await readPageReply(input);
  assert.deepEqual(planOwnerReplyForward(input), expected);
});

for (const [name, change] of rejectedPages) {
  test(`QQ reader and planner reject ${name}`, async () => {
    const input = fixture();
    input.reply = await readPageReply(input, change);
    assert.equal(input.reply.status, "unsupported");
    assert.equal(planOwnerReplyForward(input), null);
  });
}
