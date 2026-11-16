import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { identityKey } from "../src/contracts.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { createOwnerReplyReader, OWNER_REPLY_LIMITS } from "../src/owner-replies.mjs";

const OWNER = "77000001";
const ORIGINAL = "-88000001";
const SECRET = "fictional-private-body-never-an-error";
let networkAttempts = 0;

test.before(() => {
  const blocked = () => {
    networkAttempts += 1;
    throw new Error("fictional test forbids network access");
  };
  for (const [object, method] of [
    [globalThis, "fetch"], [net.Socket.prototype, "connect"],
    [http, "request"], [http, "get"], [https, "request"], [https, "get"],
  ]) test.mock.method(object, method, blocked);
});

test.after(() => {
  test.mock.restoreAll();
  assert.equal(networkAttempts, 0, "all observations must use in-memory fictional pages");
});

function fixture(options = {}) {
  const source = { machine_id: "fictional-machine", host: "codex", surface: "desktop", conversation_id: "fictional-source" };
  const target = {
    machine_id: "fictional-machine", host: "qq", surface: "group", conversation_id: "fictional-owner-target",
    binding_id: "fictional-target-binding", binding_generation: 5, adapter_id: "fictional-owner-adapter",
  };
  const binding = {
    delivery_id: "fictional-delivery", message_id: "fictional-message",
    route: { route_key: "fictional-route", conversation_id: source.conversation_id, target_key: target.conversation_id, generation: 9 },
  };
  const input = {
    message: {
      message_id: binding.message_id, source_key: identityKey(source), target_key: identityKey(target), processing: "pending",
      envelope: { caller: source, target: { ...target }, text: SECRET },
    },
    target,
    delivery: {
      delivery_id: binding.delivery_id, message_id: binding.message_id, status: "accepted",
      target_key: identityKey(target), target_snapshot: { ...target },
      evidence: {
        outcome: "accepted", delivery_id: binding.delivery_id, target_key: identityKey(target),
        evidence: { kind: "receipt", native_receipt: { provider: "napcat_owner", message_id: ORIGINAL, verified: true, state_persisted: true, reply_route: { ...binding.route } } },
      },
    },
  };
  const calls = [];
  const event = (patch = {}) => ({
    event_id: "fictional-event", message_id: "88000002", message_seq: 12,
    quoted_message_id: ORIGINAL, sender_id: OWNER, text: "  虚构的原生回复\n保持原样  ", ...patch,
  });
  const page = (patch = {}) => ({
    ok: true, route: { ...binding.route }, original_qq_message_id: ORIGINAL,
    events: [event()], next_cursor: null, partial: false, ...patch,
  });
  const reader = createOwnerReplyReader({
    enabled: true, binding, callerConversationId: source.conversation_id, ownerSenderAllowlist: [OWNER],
    async readPage(parameters, context) {
      calls.push({ parameters, context });
      return options.respond ? options.respond(parameters, context, calls.length, { page, event, input }) : page();
    },
    ...options.reader,
  });
  return { source, target, binding, input, calls, event, page, reader };
}

function rejected(result, reason) {
  assert.deepEqual(result, { status: "unsupported", reason, reply: null });
}

test("default disabled, invalid enable flags, missing private allowlist and missing capability make zero calls", async () => {
  for (const enabled of [undefined, false, null, 1, "true"]) {
    let reads = 0;
    const reader = createOwnerReplyReader({ enabled, ownerSenderAllowlist: [OWNER], readPage() { reads += 1; } });
    rejected(await reader({}), "disabled");
    assert.equal(reads, 0);
  }
  for (const ownerSenderAllowlist of [undefined, [], [77000001], ["0"], [" 77000001"], [OWNER, null], Array(33).fill(OWNER)]) {
    const context = fixture({ reader: { ownerSenderAllowlist } });
    rejected(await context.reader(context.input), "owner_allowlist_required");
    assert.equal(context.calls.length, 0);
  }
  const context = fixture({ reader: { readPage: undefined } });
  rejected(await context.reader(context.input), "read_page_unavailable");
  assert.equal(context.calls.length, 0);
  rejected(await createOwnerReplyReader()({}), "disabled");
  assert.equal(networkAttempts, 0);
});

test("missing original delivery route binding makes zero calls", async () => {
  for (const binding of [undefined, {}, { delivery_id: "different", message_id: "message", route: {} }]) {
    const context = fixture({ reader: { binding } });
    rejected(await context.reader(context.input), "original_binding_required");
    assert.equal(context.calls.length, 0);
  }
});

test("legacy or mismatched captured route provenance makes zero reads", async () => {
  for (const change of [
    receipt => { delete receipt.reply_route; },
    receipt => { receipt.reply_route.generation += 1; },
    receipt => { receipt.reply_route.conversation_id = "another-caller"; },
    receipt => { receipt.reply_route.route_key = "another-route"; },
    receipt => { receipt.reply_route.target_key = "another-target"; },
  ]) {
    const context = fixture();
    change(context.input.delivery.evidence.evidence.native_receipt);
    rejected(await context.reader(context.input), "original_delivery_unverified");
    assert.equal(context.calls.length, 0);
  }
});

test("actual stored delivery shape and a different AG origin retain the trusted relay route", async () => {
  const context = fixture();
  const agent = { ...context.source, host: "antigravity", conversation_id: "fictional-ag-source" };
  context.input.message.envelope.caller = agent;
  context.input.message.source_key = identityKey(agent);
  assert.equal(context.input.delivery.outcome, undefined);
  const reader = createOwnerReplyReader({
    enabled: true, binding: context.binding, callerConversationId: context.binding.route.conversation_id, ownerSenderAllowlist: [OWNER],
    readPage(parameters, metadata) {
      assert.equal(metadata.conversationId, context.binding.route.conversation_id);
      assert.notEqual(metadata.conversationId, agent.conversation_id);
      return context.page();
    },
  });
  const result = await reader(context.input);
  assert.equal(result.native_message_id, "88000002");
  assert.equal(result.native_source.route.conversation_id, context.binding.route.conversation_id);
});

test("sparse allowlists never authorize an absent sender and make zero calls", async () => {
  const context = fixture({
    reader: { ownerSenderAllowlist: Array(1) },
    respond: (parameters, options, count, { page, event }) => page({ events: [event({ sender_id: undefined })] }),
  });
  rejected(await context.reader(context.input), "owner_allowlist_required");
  assert.equal(context.calls.length, 0);
});

test("disabled construction does not inspect capabilities, and setup exceptions are sanitized", async () => {
  const options = { enabled: false };
  for (const property of ["binding", "readPage", "ownerSenderAllowlist"]) {
    Object.defineProperty(options, property, { get() { throw new Error(SECRET); } });
  }
  rejected(await createOwnerReplyReader(options)({}), "disabled");
  for (const property of ["enabled", "binding", "readPage", "ownerSenderAllowlist"]) {
    const broken = { enabled: true };
    Object.defineProperty(broken, property, { get() { throw new Error(SECRET); } });
    const result = await createOwnerReplyReader(broken)({});
    rejected(result, "invalid_setup");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test("returns exact native facts and finite provenance without copying extra fields or changing processing", async () => {
  const context = fixture({ respond: (parameters, options, count, { page, event }) => page({
    secret: SECRET, events: [event({ sender_name: SECRET, body: SECRET, wake: SECRET, thinking: SECRET })],
  }) });
  const before = structuredClone(context.input);
  const result = await context.reader(context.input);
  assert.deepEqual(result, {
    native_message_id: "88000002", native_conversation_id: context.target.conversation_id, source_step_index: 12,
    text: context.event().text,
    native_source: {
      provider: "napcat_owner", route: context.binding.route, original_qq_message_id: ORIGINAL,
      event: { event_id: "fictional-event", message_id: "88000002", message_seq: 12, quoted_message_id: ORIGINAL, sender_id: OWNER },
    },
  });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(context.input, before);
  assert.deepEqual(context.calls[0].parameters, {
    route_key: "fictional-route", original_qq_message_id: ORIGINAL, expected_route_generation: 9,
  });
  assert.deepEqual(context.calls[0].context, {
    conversationId: context.source.conversation_id, targetKey: context.target.conversation_id, signal: undefined,
  });
  assert.equal(Object.isFrozen(context.calls[0].parameters), true);
  assert.equal(Object.isFrozen(context.calls[0].context), true);
});

const invalidOriginals = [
  ["delivery not accepted", context => { context.input.delivery.status = "unknown"; }],
  ["outcome not accepted", context => { context.input.delivery.outcome = "unknown"; }],
  ["unverified native receipt", context => { context.input.delivery.evidence.evidence.native_receipt.verified = false; }],
  ["receipt not persisted", context => { context.input.delivery.evidence.evidence.native_receipt.state_persisted = false; }],
  ["wrong provider", context => { context.input.delivery.evidence.evidence.native_receipt.provider = "fictional-other"; }],
  ["numeric native id", context => { context.input.delivery.evidence.evidence.native_receipt.message_id = 88000001; }],
  ["zero native id", context => { context.input.delivery.evidence.evidence.native_receipt.message_id = "0"; }],
  ["missing receipt with wake substitute", context => {
    delete context.input.delivery.evidence.evidence.native_receipt;
    context.input.wake = { original_qq_message_id: ORIGINAL, text: context.event().text };
    context.input.delivery.message_id = ORIGINAL;
  }],
  ["receipt wrapper target changed", context => { context.input.delivery.evidence.target_key = "fictional-other"; }],
  ["receipt wrapper delivery changed", context => { context.input.delivery.evidence.delivery_id = "fictional-other"; }],
  ["receipt wrapper outcome changed", context => { context.input.delivery.evidence.outcome = "unknown"; }],
  ["receipt kind changed", context => { context.input.delivery.evidence.evidence.kind = "transport"; }],
  ["non QQ target", context => { context.input.target.host = "codex"; }],
  ["wrong source CID", context => { context.input.message.envelope.caller.conversation_id = "fictional-other"; }],
  ["wrong core message", context => { context.input.message.message_id = "fictional-other"; }],
  ["wrong original delivery", context => { context.input.delivery.delivery_id = "fictional-other"; }],
  ["wrong delivery message", context => { context.input.delivery.message_id = "fictional-other"; }],
  ["target identity changed", context => { context.input.target.conversation_id = "fictional-other"; }],
  ["target binding generation changed", context => { context.input.target.binding_generation += 1; }],
  ["persisted target changed", context => { context.input.delivery.target_snapshot.binding_generation += 1; }],
  ["adapter changed", context => { context.input.target.adapter_id = "fictional-other"; }],
  ["core target key changed", context => { context.input.message.target_key = "fictional-other"; }],
];

for (const [name, mutate] of invalidOriginals) {
  test(`${name} is rejected before reading`, async () => {
    const context = fixture();
    mutate(context);
    rejected(await context.reader(context.input), "original_delivery_unverified");
    assert.equal(context.calls.length, 0);
  });
}

test("every returned route dimension and original QQ id must exactly match", async () => {
  for (const key of ["route_key", "conversation_id", "target_key", "generation"]) {
    const context = fixture({ respond: (parameters, options, count, { page }) => {
      const result = page();
      result.route[key] = key === "generation" ? 10 : "fictional-other";
      return result;
    } });
    rejected(await context.reader(context.input), "page_scope_mismatch");
  }
  for (const patch of [{ original_qq_message_id: "88000009" }, { original_qq_message_id: 88000001 }, { ok: false }, { route: null }]) {
    const context = fixture({ respond: (parameters, options, count, { page }) => page(patch) });
    rejected(await context.reader(context.input), "page_scope_mismatch");
  }
});

test("native shape and exact quote apply to every event while only the owner can supply a reply", async () => {
  for (const patch of [
    { quoted_message_id: "88000009" }, { quoted_message_id: -88000001 }, { quoted_message_id: undefined },
    { sender_id: "0" }, { sender_id: 77000001 }, { sender_id: undefined },
    { event_id: "" }, { message_id: "0" }, { message_seq: -1 }, { message_seq: "12" },
    { message_seq: Number.MAX_SAFE_INTEGER + 1 }, { text: null },
  ]) {
    const context = fixture({ respond: (parameters, options, count, { page, event }) => page({ events: [event(patch)] }) });
    rejected(await context.reader(context.input), "event_unverified");
  }
  const mixed = fixture({ respond: (parameters, options, count, { page, event }) => page({
    events: [event(), event({ event_id: "fictional-second", message_id: "88000003", message_seq: 13, sender_id: "77000002", text: "" })],
  }) });
  assert.equal((await mixed.reader(mixed.input)).native_message_id, "88000002");
  const foreignOnly = fixture({ respond: (parameters, options, count, { page, event }) => page({ events: [event({ sender_id: "77000002" })] }) });
  rejected(await foreignOnly.reader(foreignOnly.input), "no_reply");
});

test("complete pagination uses the same scope and retains provider order without sorting native IDs", async () => {
  const context = fixture({ respond: (parameters, options, count, { page, event }) => count === 1
    ? page({ events: [event({ message_seq: 22, text: "较新原文" })], partial: true, next_cursor: "fictional.cursor+/=" })
    : page({ events: [event({ event_id: "fictional-older", message_id: "88000003", message_seq: 99, text: "较旧原文" })] }) });
  const result = await context.reader(context.input);
  assert.equal(result.text, "较新原文");
  assert.equal(result.source_step_index, 22);
  assert.equal(context.calls.length, 2);
  assert.deepEqual(context.calls[1].parameters, { ...context.calls[0].parameters, cursor: "fictional.cursor+/=" });
  assert.equal(context.calls[1].context, context.calls[0].context);
});

test("a valid owner reply survives other correctly scoped group senders across pages", async () => {
  const context = fixture({ respond: (parameters, options, count, { page, event }) => count === 1
    ? page({ events: [event({ sender_id: "77000002", event_id: "foreign-event", message_id: "88000003", message_seq: 13 })], partial: true, next_cursor: "owner-next" })
    : page({ events: [event()] }) });
  const result = await context.reader(context.input);
  assert.equal(result.native_message_id, "88000002");
  assert.equal(result.native_source.event.sender_id, OWNER);
  assert.equal(context.calls.length, 2);
});

test("later correctly scoped group senders never replace a verified owner reply", async () => {
  const context = fixture({ respond: (parameters, options, count, { page, event }) => count === 1
    ? page({ events: [event()], partial: true, next_cursor: "foreign-next" })
    : page({ events: [event({ sender_id: "77000002", event_id: "foreign-event", message_id: "88000003", message_seq: 13, text: SECRET })] }) });
  const result = await context.reader(context.input);
  assert.equal(result.native_message_id, "88000002");
  assert.equal(result.native_source.event.sender_id, OWNER);
  assert.equal(result.text.includes(SECRET), false);
});

test("malformed or unfinished pagination never returns an early reply", async () => {
  for (const patch of [
    { partial: true, next_cursor: null }, { partial: true, next_cursor: "" },
    { partial: true, next_cursor: "bad\ncursor" }, { partial: true, next_cursor: "c".repeat(4097) },
    { partial: false, next_cursor: "fictional-next" }, { partial: undefined }, { next_cursor: undefined }, { events: null },
  ]) {
    const context = fixture({ respond: (parameters, options, count, { page }) => page(patch) });
    rejected(await context.reader(context.input), "incomplete_page");
    assert.equal(context.calls.length, 1);
  }
  const context = fixture({ respond: (parameters, options, count, { page, event }) => page({
    events: [event({ event_id: `fictional-${count}`, message_id: String(88000010 + count), message_seq: count })],
    partial: true, next_cursor: `fictional-cursor-${count}`,
  }) });
  rejected(await context.reader(context.input), "page_limit");
  assert.equal(context.calls.length, OWNER_REPLY_LIMITS.pages);
});

test("cursor cycles and duplicate native events are rejected across pages", async () => {
  const cycle = fixture({ respond: (parameters, options, count, { page }) => page({ events: [], partial: true, next_cursor: "fictional-same" }) });
  rejected(await cycle.reader(cycle.input), "cursor_cycle");
  assert.equal(cycle.calls.length, 2);
  for (const patch of [
    { event_id: "fictional-event", message_id: "88000003", message_seq: 13 },
    { event_id: "fictional-second", message_id: "88000002", message_seq: 13 },
    { event_id: "fictional-second", message_id: "88000003", message_seq: 12 },
  ]) {
    const context = fixture({ respond: (parameters, options, count, { page, event }) => count === 1
      ? page({ partial: true, next_cursor: "fictional-next" }) : page({ events: [event(patch)] }) });
    rejected(await context.reader(context.input), "duplicate_event");
  }
  const samePage = fixture({ respond: (parameters, options, count, { page, event }) => page({ events: [event(), event()] }) });
  rejected(await samePage.reader(samePage.input), "duplicate_event");
});

test("later-page scope drift and read failures discard previously valid replies", async () => {
  for (const failure of ["generation", "throw"]) {
    const context = fixture({ respond: (parameters, options, count, { page, event }) => {
      if (count === 1) return page({ partial: true, next_cursor: "fictional-next" });
      if (failure === "throw") throw new Error(SECRET);
      const result = page({ events: [event({ event_id: "fictional-second", message_id: "88000003", message_seq: 13 })] });
      if (failure === "generation") result.route.generation += 1;
      return result;
    } });
    rejected(await context.reader(context.input), { generation: "page_scope_mismatch", throw: "read_failed" }[failure]);
  }
});

test("total event and UTF-8 text budgets are bounded", async () => {
  const tooMany = fixture({ respond: (parameters, options, count, { page, event }) => page({ events: Array(101).fill(event()) }) });
  rejected(await tooMany.reader(tooMany.input), "event_limit");
  for (const text of ["x".repeat(OWNER_REPLY_LIMITS.textBytes + 1), "字".repeat(Math.floor(OWNER_REPLY_LIMITS.textBytes / 3) + 1)]) {
    const context = fixture({ respond: (parameters, options, count, { page, event }) => page({ events: [event({ text })] }) });
    rejected(await context.reader(context.input), "text_limit");
  }
  const total = fixture({ respond: (parameters, options, count, { page, event }) => page({
    events: Array.from({ length: 5 }, (_, index) => event({
      event_id: `fictional-${index}`, message_id: String(88000020 + index), message_seq: index, text: "x".repeat(OWNER_REPLY_LIMITS.textBytes),
    })),
  }) });
  rejected(await total.reader(total.input), "text_limit");
});

test("event and text totals apply across pages, with exact limits accepted", async () => {
  const over = fixture({ respond: (parameters, options, count, { page, event }) => page({
    events: Array.from({ length: count === 1 ? 60 : 41 }, (_, index) => event({
      event_id: `fictional-${count}-${index}`, message_id: String(88100000 + count * 100 + index), message_seq: count * 100 + index,
    })),
    partial: count === 1, next_cursor: count === 1 ? "fictional-next" : null,
  }) });
  rejected(await over.reader(over.input), "event_limit");
  assert.equal(over.calls.length, 2);
  const exactEvents = fixture({ respond: (parameters, options, count, { page, event }) => page({
    events: Array.from({ length: OWNER_REPLY_LIMITS.events }, (_, index) => event({
      event_id: `fictional-${index}`, message_id: String(88200000 + index), message_seq: index, text: "x",
    })),
  }) });
  assert.equal((await exactEvents.reader(exactEvents.input)).source_step_index, 0);
  const exactText = fixture({ respond: (parameters, options, count, { page, event }) => page({
    events: [event({ event_id: `fictional-${count}`, message_id: String(88300000 + count), message_seq: count, text: "x".repeat(OWNER_REPLY_LIMITS.textBytes) })],
    partial: count < OWNER_REPLY_LIMITS.pages, next_cursor: count < OWNER_REPLY_LIMITS.pages ? `fictional-${count}` : null,
  }) });
  assert.equal((await exactText.reader(exactText.input)).source_step_index, 1);
  assert.equal(exactText.calls.length, OWNER_REPLY_LIMITS.pages);
});

test("empty and whitespace replies return structured no observation and never use wake text", async () => {
  for (const events of [[], [{ text: "" }], [{ text: " \n\t " }]]) {
    const context = fixture({ respond: (parameters, options, count, { page, event }) => page({ events: events.map(patch => event(patch)) }) });
    context.input.wake = { text: "虚构唤醒正文", sender_id: OWNER, quoted_message_id: ORIGINAL };
    rejected(await context.reader(context.input), "no_reply");
  }
});

test("input cursors cannot resume a different route, delivery or original message", async () => {
  const context = fixture();
  context.input.cursor = "fictional-foreign-cursor";
  rejected(await context.reader(context.input), "invalid_input");
  assert.equal(context.calls.length, 0);
});

test("binding and allowlist are captured privately, and scope mutation during a read is rejected", async () => {
  const owners = [OWNER];
  const context = fixture({ reader: { ownerSenderAllowlist: owners } });
  context.binding.route.route_key = "fictional-mutated";
  owners[0] = "77000002";
  const result = await context.reader(context.input);
  rejected(result, "page_scope_mismatch");
  assert.equal(context.calls[0].parameters.route_key, "fictional-route");
  const ownerOnly = [OWNER];
  const snapshot = fixture({ reader: { ownerSenderAllowlist: ownerOnly } });
  ownerOnly[0] = "77000002";
  assert.equal((await snapshot.reader(snapshot.input)).native_source.event.sender_id, OWNER);
  const changed = fixture({ respond: (parameters, options, count, { page, input }) => {
    input.delivery.target_snapshot.binding_generation += 1;
    return page();
  } });
  rejected(await changed.reader(changed.input), "original_scope_changed");
  assert.equal(changed.calls.length, 1);
});

test("abort before reading makes zero calls and abort during an uncooperative read stops waiting", async () => {
  const before = fixture();
  const controller = new AbortController();
  controller.abort(SECRET);
  rejected(await before.reader({ ...before.input, signal: controller.signal }), "cancelled");
  assert.equal(before.calls.length, 0);
  const activeController = new AbortController();
  const active = fixture({ respond: () => new Promise(() => {}) });
  const pending = active.reader({ ...active.input, signal: activeController.signal });
  await nextTurn();
  assert.equal(active.calls.length, 1);
  assert.equal(active.calls[0].context.signal, activeController.signal);
  activeController.abort(new Error(SECRET));
  rejected(await pending, "cancelled");
  assert.equal(getEventListeners(activeController.signal, "abort").length, 0);
});

test("abort after a page and between pages starts no further read", async () => {
  const controller = new AbortController();
  const context = fixture({ respond: (parameters, options, count, { page }) => {
    controller.abort(SECRET);
    return page({ partial: true, next_cursor: "fictional-next" });
  } });
  rejected(await context.reader({ ...context.input, signal: controller.signal }), "cancelled");
  assert.equal(context.calls.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("late read rejection after cancellation is handled and no next page is started", async () => {
  let rejectRead;
  const controller = new AbortController();
  const context = fixture({ respond: () => new Promise((resolve, reject) => { rejectRead = reject; }) });
  const pending = context.reader({ ...context.input, signal: controller.signal });
  await nextTurn();
  controller.abort();
  rejected(await pending, "cancelled");
  rejectRead(new Error(SECRET));
  await nextTurn();
  assert.equal(context.calls.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("invalid signals and foreign original bindings make zero reads", async () => {
  for (const signal of [null, {}, { aborted: false }, "fictional-signal"]) {
    const context = fixture();
    rejected(await context.reader({ ...context.input, signal }), "invalid_signal");
    assert.equal(context.calls.length, 0);
  }
  const original = fixture();
  for (const patch of [
    { message_id: "fictional-foreign" }, { delivery_id: "fictional-foreign" },
    { route: { ...original.binding.route, conversation_id: "fictional-foreign" } },
    { route: { ...original.binding.route, target_key: "fictional-foreign" } },
  ]) {
    const context = fixture({ reader: { binding: { ...original.binding, ...patch } } });
    rejected(await context.reader(context.input), "original_delivery_unverified");
    assert.equal(context.calls.length, 0);
  }
});

test("transport rejection and malformed property errors are sanitized without returning body or exception", async () => {
  for (const respond of [
    () => { throw new Error(SECRET); },
    async () => { throw { message: SECRET, body: SECRET }; },
    () => ({ get ok() { throw new Error(SECRET); } }),
  ]) {
    const context = fixture({ respond });
    const result = await context.reader(context.input);
    rejected(result, "read_failed");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test("throwing input getters also return a static error without leaking a private exception", async () => {
  const context = fixture();
  Object.defineProperty(context.input, "signal", { get() { throw new Error(SECRET); } });
  const result = await context.reader(context.input);
  rejected(result, "read_failed");
  assert.equal(context.calls.length, 0);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("core preserves only the original-quote native source alongside the observed reply", async () => {
  const context = fixture();
  const core = new CommunicationCore({ store: {}, deliveryTimeoutMs: 1000 });
  const result = await core.callReplyObserver({ observeReply: context.reader }, context.input.message, context.input.delivery, context.target);
  assert.deepEqual(result, {
    native_message_id: "88000002", native_conversation_id: context.target.conversation_id,
    source_step_index: 12, text: context.event().text,
    native_source: { provider: "napcat_owner", route: context.binding.route, original_qq_message_id: ORIGINAL,
      event: { event_id: "fictional-event", message_id: "88000002", message_seq: 12, quoted_message_id: ORIGINAL, sender_id: OWNER } },
  });
  assert.equal(context.input.message.processing, "pending");
  assert.equal(core.replyInvocations.size, 0);
  assert.equal(core.controllers.size, 0);
  assert.equal(networkAttempts, 0);
});

test("core rejects QQ source facts that contradict the original accepted receipt", async () => {
  const context = fixture();
  const original = await context.reader(context.input);
  for (const change of [
    reply => { delete reply.native_source; },
    reply => { reply.native_source.original_qq_message_id = "999"; },
    reply => { reply.native_source.event.quoted_message_id = "999"; },
    reply => { reply.native_source.event.message_id = "999"; },
    reply => { reply.native_source.event.message_seq = 999; },
    reply => { reply.native_source.event.sender_id = "0"; },
    reply => { reply.native_source.route.target_key = "another-target"; },
    reply => { reply.native_source.route.generation = 0; },
  ]) {
    const reply = structuredClone(original);
    change(reply);
    const core = new CommunicationCore({ store: {}, deliveryTimeoutMs: 1000 });
    assert.equal(await core.callReplyObserver({ observeReply: async () => reply }, context.input.message, context.input.delivery, context.target), null);
  }
  const extended = structuredClone(original);
  extended.native_source.credentials = SECRET;
  extended.native_source.event.raw = SECRET;
  const core = new CommunicationCore({ store: {}, deliveryTimeoutMs: 1000 });
  const observed = await core.callReplyObserver({ observeReply: async () => extended }, context.input.message, context.input.delivery, context.target);
  assert.equal(JSON.stringify(observed.native_source).includes(SECRET), false);
});

test("current core treats disabled structured unsupported as no observation with zero reads", async () => {
  const context = fixture({ reader: { enabled: false } });
  const core = new CommunicationCore({ store: {}, deliveryTimeoutMs: 1000 });
  const result = await core.callReplyObserver({ observeReply: context.reader }, context.input.message, context.input.delivery, context.target);
  assert.equal(result, null);
  assert.equal(context.calls.length, 0);
  assert.equal(context.input.message.processing, "pending");
});
