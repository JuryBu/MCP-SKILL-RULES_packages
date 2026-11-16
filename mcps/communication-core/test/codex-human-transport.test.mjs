import test from "node:test";
import assert from "node:assert/strict";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";
import { CodexProxyTransport } from "../src/transports/codex-proxy.mjs";
import { normalizeCodexHumanSource } from "../src/codex-human-origin.mjs";

const relay = { host: "codex", conversation_id: "fixture-core" };
const target = { machine_id: "fixture-machine", host: "codex", surface: "desktop", conversation_id: "fixture-target",
  binding_id: "fixture-binding", binding_generation: 3 };

function humanInput() {
  const eventId = "a1".repeat(32);
  return {
    target: structuredClone(target), delivery: { delivery_id: "human-delivery", attempt_count: 1 },
    message: {
      message_id: "human-message",
      envelope: {
        caller: { machine_id: "fixture-machine", host: "qq", surface: "group", conversation_id: "fixture-owner" },
        origin: { kind: "human_message", channel: "napcat_owner_reply", source_ref: `owner-event:${eventId}` },
        text: " \r\n[CQ:reply,id=-80001][CQ:at,qq=90001] 本人原文\t\u0000 ", attachment_refs: [],
        delivery_policy: "next_model_boundary", in_reply_to: "original-core-message",
      },
      forward_of: { message_id: "original-core-message", delivery_id: "original-core-delivery", native_source: {
        provider: "napcat_owner", route: { route_key: "fixture-route", conversation_id: relay.conversation_id,
          target_key: "fixture-owner", generation: 8 }, original_qq_message_id: "-80001",
        event: { event_id: eventId, message_id: "80002", message_seq: 44, quoted_message_id: "-80001", sender_id: "90001" },
      } },
    },
  };
}

function client(fetchImpl, options = {}) {
  return new CodexProxyTransport({ baseUrl: "http://127.0.0.1:12345", token: "fixture-only-token", relay, fetchImpl, ...options });
}

function receipt(body, overrides = {}) {
  return { ...structuredClone(body), thread_id: target.conversation_id, turn_id: "fixture-turn", outcome: "accepted",
    request_sent: true, injection_method: "turn/start", ...overrides };
}

function adapterRequest(input) {
  return new CodexDeliveryAdapter({ transport: { async submit() {}, async query() {} } }).request(input);
}

function replyPage(overrides = {}) {
  return { supported: true, thread_id: target.conversation_id, turn_id: "fixture-turn", turn_status: "completed",
    replies: [{ item_id: "fixture-item", text: "  回信原文\n", turn_status: "completed" }], partial: false, ...overrides };
}

test("human adapter preserves QQ caller, original source and finite provenance without mutation", async () => {
  const input = humanInput();
  const original = structuredClone(input);
  const configuredRelay = { ...relay };
  let body;
  let started = 0;
  const transport = client(async (url, options) => {
    assert.equal(started, 1);
    assert.equal(url, "http://127.0.0.1:12345/v1/communication/deliveries");
    body = JSON.parse(options.body);
    const delivered = receipt(body, { diagnostic: "fixture-private-diagnostic" });
    delivered.origin = Object.fromEntries(Object.entries(delivered.origin).reverse());
    delivered.forward_of.native_source.event = Object.fromEntries(Object.entries(delivered.forward_of.native_source.event).reverse());
    return Response.json({ ok: true, delivery: delivered });
  }, { relay: configuredRelay });
  configuredRelay.conversation_id = "changed-after-construction";
  transport.relay = { host: "codex", conversation_id: "payload-cannot-replace-private-relay" };
  const adapter = new CodexDeliveryAdapter({ transport });
  const request = adapter.request(input);
  assert.deepEqual(request.source, { caller: input.message.envelope.caller, origin: input.message.envelope.origin });
  assert.deepEqual(request.forward_of, input.message.forward_of);
  assert.equal(request.in_reply_to, input.message.envelope.in_reply_to);
  const result = await adapter.deliver({ ...input, onRequestStarted() { started += 1; } });
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(normalizeCodexHumanSource(body), { origin: input.message.envelope.origin, relay,
    in_reply_to: input.message.envelope.in_reply_to, forward_of: input.message.forward_of });
  assert.equal(body.text, input.message.envelope.text);
  assert.deepEqual(body.target, { host: "codex", conversation_id: target.conversation_id });
  assert.equal(body.message_visibility, "visible");
  assert.equal(JSON.stringify(result).includes("fixture-private-diagnostic"), false);
  for (const field of ["relay", "forward_of", "origin", "text"]) assert.equal(Object.hasOwn(result, field), false);
  assert.deepEqual(input, original);
  await transport.close();
});

test("fixed relay is optional for legacy agent requests and never changes the original eight-field body", async () => {
  for (const configuredRelay of [undefined, relay]) {
    let raw;
    const transport = client(async (url, options) => {
      raw = options.body;
      return Response.json({ ok: true, delivery: receipt(JSON.parse(raw)) });
    }, { relay: configuredRelay });
    const input = humanInput();
    input.message.envelope.caller = { host: "antigravity", conversation_id: "fixture-agent" };
    input.message.envelope.origin = { kind: "agent_message", channel: "host_mcp", source_ref: "fixture-agent-event" };
    delete input.message.forward_of;
    delete input.message.envelope.in_reply_to;
    assert.equal((await new CodexDeliveryAdapter({ transport }).deliver(input)).outcome, "accepted");
    assert.equal(raw, JSON.stringify({ delivery_id: "human-delivery", message_id: "human-message", binding_generation: 3,
      origin: { kind: "agent", host: "antigravity", conversation_id: "fixture-agent" },
      target: { host: "codex", conversation_id: target.conversation_id }, text: input.message.envelope.text,
      delivery_policy: "next_model_boundary", message_visibility: "visible" }));
    await transport.close();
  }
});

test("human local rejection is explicitly unsent, with no HTTP, tracking or connection retry evidence", async () => {
  let calls = 0;
  let started = 0;
  const transport = client(async () => { calls += 1; assert.fail("invalid request reached HTTP"); });
  const adapter = new CodexDeliveryAdapter({ transport });
  const changes = [
    value => { delete value.message.envelope.origin; },
    value => { value.message.envelope.origin.kind = "agent_message"; },
    value => { value.message.envelope.origin.channel = "other"; },
    value => { value.message.envelope.origin.source_ref = `owner-event:${"b".repeat(64)}`; },
    value => { value.message.envelope.origin.host = "codex"; },
    value => { delete value.message.envelope.in_reply_to; },
    value => { value.message.envelope.in_reply_to = "different-original"; },
    value => { delete value.message.forward_of; },
    value => { value.message.forward_of.delivery_id = "x".repeat(201); },
    value => { value.message.forward_of.message_id = "different-original"; },
    value => { value.message.forward_of.native_source.provider = "other"; },
    value => { value.message.forward_of.native_source.original_qq_message_id = "0"; },
    value => { value.message.forward_of.native_source.event.quoted_message_id = "80003"; },
    value => { value.message.forward_of.native_source.event.event_id = "A".repeat(64); },
    value => { value.message.forward_of.native_source.event.message_id = "1".repeat(21); },
    value => { value.message.forward_of.native_source.event.message_id = "80002\n"; },
    value => { value.message.forward_of.native_source.event.sender_id = "01"; },
    value => { value.message.forward_of.native_source.event.message_seq = -1; },
    value => { delete value.message.forward_of.native_source.event.message_seq; },
    value => { value.message.forward_of.native_source.event.message_seq = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.message.forward_of.native_source.route.generation = 0; },
    value => { value.message.forward_of.native_source.route.generation = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.message.forward_of.native_source.route.conversation_id = "other-core"; },
    value => { value.message.forward_of.native_source.route.route_key = "路线".repeat(128) + "外"; },
    value => { value.message.forward_of.native_source.route.target_key = " leading"; },
    value => { value.message.forward_of.native_source.route.route_key = "bad\u0000key"; },
    value => { value.message.forward_of.native_source.route.extra = "not-finite"; },
    value => { value.message.forward_of.native_source.event.text = value.message.envelope.text; },
    value => { value.message.forward_of.extra = "not-finite"; },
    value => { value.message.envelope.caller.host = "antigravity"; },
    value => { value.message.envelope.caller.conversation_id = "other-owner"; },
    value => { value.target.host = "antigravity"; },
    value => { value.target.conversation_id = "目"; },
    value => { value.target.conversation_id = "x".repeat(201); },
    value => { value.target.binding_generation = 0; },
    value => { value.message.message_id = "message/invalid"; },
    value => { value.message.message_id = "message-with-newline\n"; },
    value => { value.delivery.delivery_id = "x".repeat(201); },
    value => { value.message.envelope.attachment_refs = ["unmapped"]; },
    value => { value.message.envelope.delivery_policy = "unsupported"; },
    value => { delete value.message.envelope.text; },
    value => { value.message.envelope.text = "中".repeat(87382); },
  ];
  for (const change of changes) {
    const input = humanInput();
    change(input);
    const result = await adapter.deliver({ ...input, onRequestStarted() { started += 1; } });
    assert.equal(result.outcome, "failed_before_send", change.toString());
    assert.equal(result.evidence?.retry_after_ms, undefined);
    assert.ok(["invalid_input", "unsupported"].includes(result.error.code));
  }
  for (const request of [{ ...adapterRequest(humanInput()), relay },
    { ...adapterRequest(humanInput()), source: { ...adapterRequest(humanInput()).source, relay } }]) {
    await assert.rejects(transport.submit(request, { onRequestStarted() { started += 1; } }),
      error => error.details.request_sent === false && error.details.local_rejection === true);
  }
  const unconfigured = client(async () => { calls += 1; }, { relay: undefined });
  assert.equal((await new CodexDeliveryAdapter({ transport: unconfigured }).deliver(humanInput())).outcome, "failed_before_send");
  assert.equal(calls, 0);
  assert.equal(started, 0);
  await unconfigured.close();
  await transport.close();
});

test("relay configuration rejects extra fields and non-ASCII core identifiers before use", () => {
  for (const configuredRelay of [null, {}, { ...relay, host: "antigravity" }, { ...relay, extra: "untrusted" },
    { ...relay, conversation_id: "" }, { ...relay, conversation_id: "中文核心" }, { ...relay, conversation_id: "x".repeat(201) }]) {
    assert.throws(() => client(async () => {}, { relay: configuredRelay }), { code: "invalid_config" });
  }
});

test("provider Unicode keys, opaque text and native numeric limits match the candidate source contract", async () => {
  const input = humanInput();
  const native = input.message.forward_of.native_source;
  native.route.route_key = "路线".repeat(128);
  native.route.target_key = input.message.envelope.caller.conversation_id = "目标".repeat(128);
  native.route.generation = Number.MAX_SAFE_INTEGER;
  native.original_qq_message_id = native.event.quoted_message_id = `-${"9".repeat(20)}`;
  native.event.message_id = "9".repeat(20);
  native.event.sender_id = "8".repeat(20);
  native.event.message_seq = Number.MAX_SAFE_INTEGER;
  input.message.envelope.text = "中".repeat(87381) + "x";
  const transport = client(async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(Buffer.byteLength(body.text, "utf8"), 256 * 1024);
    assert.deepEqual(body.forward_of, input.message.forward_of);
    return Response.json({ ok: true, delivery: receipt(body) });
  });
  assert.equal((await new CodexDeliveryAdapter({ transport }).deliver(input)).outcome, "accepted");
  await transport.close();
});

test("human receipts check every echoed provenance identity, including internally consistent forgeries", async () => {
  const changes = [
    value => { value.origin.kind = "agent"; },
    value => { value.origin.channel = "other"; },
    value => { value.origin.host = "codex"; },
    value => { value.origin.source_ref = `owner-event:${"b".repeat(64)}`; value.forward_of.native_source.event.event_id = "b".repeat(64); },
    value => { value.relay.host = "antigravity"; },
    value => { value.relay.extra = "not-finite"; },
    value => { value.relay.conversation_id = value.forward_of.native_source.route.conversation_id = "other-core"; },
    value => { value.in_reply_to = value.forward_of.message_id = "other-original-message"; },
    value => { value.forward_of.delivery_id = "other-original-delivery"; },
    value => { value.forward_of.native_source.provider = "other"; },
    value => { value.forward_of.extra = "not-finite"; },
    value => { value.forward_of.native_source.extra = "not-finite"; },
    value => { value.forward_of.native_source.route.route_key = "other-route"; },
    value => { value.forward_of.native_source.route.target_key = "other-owner"; },
    value => { value.forward_of.native_source.route.generation += 1; },
    value => { value.forward_of.native_source.original_qq_message_id = value.forward_of.native_source.event.quoted_message_id = "80004"; },
    value => { value.forward_of.native_source.event.message_id = "80003"; },
    value => { value.forward_of.native_source.event.message_seq += 1; },
    value => { value.forward_of.native_source.event.sender_id = "90002"; },
    value => { value.forward_of.native_source.event.extra = "not-finite"; },
    value => { delete value.forward_of.native_source.event.quoted_message_id; },
    value => { delete value.relay; },
    value => { delete value.in_reply_to; },
    value => { delete value.forward_of; },
    value => { value.delivery_id = "other-delivery"; },
    value => { value.message_id = "other-message"; },
    value => { value.target.conversation_id = value.thread_id = "other-target"; },
    value => { value.binding_generation += 1; },
    value => { value.text += "changed"; },
    value => { value.delivery_policy = "when_idle"; },
    value => { value.message_visibility = "hidden"; },
  ];
  for (const change of changes) {
    const transport = client(async (url, options) => {
      const delivered = receipt(JSON.parse(options.body));
      change(delivered);
      return Response.json({ ok: true, delivery: delivered });
    });
    await assert.rejects(transport.submit(adapterRequest(humanInput())), { code: "codex_receipt_identity_mismatch" }, change.toString());
    assert.equal((await new CodexDeliveryAdapter({ transport }).deliver(humanInput())).outcome, "unknown");
    await transport.close();
  }
});

test("new transport recovers human GET and paginated replies using only the original relay scope", async () => {
  const request = adapterRequest(humanInput());
  let originalBody;
  const sending = client(async (url, options) => {
    originalBody = JSON.parse(options.body);
    return Response.json({ ok: true, delivery: receipt(originalBody) });
  });
  await sending.submit(request);
  await sending.close();
  const urls = [];
  const recovering = client(async (url, options) => {
    urls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    const address = new URL(url);
    const later = address.searchParams.has("cursor");
    return Response.json({ ok: true, delivery: receipt(originalBody), replies: replyPage({
      replies: [{ item_id: later ? "last-item" : "first-item", text: later ? "末段" : "首段", turn_status: "completed" }],
      partial: !later, cursor: later ? null : "opaque_next",
    }) });
  });
  assert.equal((await recovering.query({ delivery_id: request.delivery_id }, { request })).outcome, "accepted");
  const reply = await recovering.observeReply(request);
  assert.equal(reply.text, "首段\n\n末段");
  assert.equal(reply.native_message_id, "last-item");
  assert.equal(reply.native_turn_id, "fixture-turn");
  assert.equal(urls.length, 3);
  for (const url of urls) {
    const address = new URL(url);
    assert.equal(address.searchParams.get("source_host"), "codex");
    assert.equal(address.searchParams.get("source_conversation_id"), relay.conversation_id);
    assert.equal(address.searchParams.get("target_conversation_id"), target.conversation_id);
    assert.equal(address.searchParams.get("binding_generation"), "3");
    assert.ok([4, 5].includes(address.searchParams.size));
    assert.equal(address.pathname.startsWith("/v1/communication/deliveries/human-delivery"), true);
  }
  await assert.rejects(recovering.query({ delivery_id: "replacement" }, { request }), { code: "codex_query_identity_mismatch" });
  assert.equal(urls.length, 3);
  await recovering.close();
});

test("human requests preserve connect-refused busy and post-submission unknown-only-query behavior", async () => {
  const refused = () => Object.assign(new Error("fixture refusal"), { code: "ECONNREFUSED", syscall: "connect" });
  const disconnected = client(async () => { throw new TypeError("fixture connect", { cause: new AggregateError([refused(), refused()]) }); });
  const waiting = await new CodexDeliveryAdapter({ transport: disconnected }).deliver(humanInput());
  assert.equal(waiting.outcome, "busy");
  assert.equal(waiting.evidence.retry_after_ms, 1000);
  await disconnected.close();
  let posts = 0;
  let gets = 0;
  let originalBody;
  const lost = client(async (url, options) => {
    if (options.method === "POST") {
      posts += 1;
      originalBody = JSON.parse(options.body);
      throw Object.assign(new Error("fixture receipt lost"), { code: "ECONNRESET" });
    }
    gets += 1;
    return Response.json({ ok: true, delivery: receipt(originalBody) });
  });
  const adapter = new CodexDeliveryAdapter({ transport: lost });
  assert.equal((await adapter.deliver(humanInput())).outcome, "unknown");
  assert.equal((await adapter.query(humanInput())).outcome, "accepted");
  assert.equal(posts, 1);
  assert.equal(gets, 1);
  await lost.close();
  for (const fetchImpl of [async () => new Response("finite rejection", { status: 400 }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(refused()); } })),
    async () => { throw new TypeError("fixture mixed connect", { cause: new AggregateError([refused(), new Error("reset")]) }); }]) {
    const transport = client(fetchImpl);
    const result = await new CodexDeliveryAdapter({ transport }).deliver(humanInput());
    assert.equal(result.outcome, "unknown");
    assert.equal(result.evidence?.retry_after_ms, undefined);
    await transport.close();
  }
});

test("human receipt outcome evidence retains the same strict request-sent contract", async () => {
  for (const outcome of ["accepted", "busy", "failed_before_send", "unknown"]) {
    for (const requestSent of [true, false, null, undefined]) {
      const transport = client(async (url, options) => Response.json({ ok: true,
        delivery: receipt(JSON.parse(options.body), { outcome, request_sent: requestSent }) }));
      const delivered = await transport.submit(adapterRequest(humanInput()));
      const expected = outcome === "accepted" ? requestSent === true : outcome !== "unknown" && requestSent === false;
      assert.equal(delivered.outcome, expected ? outcome : "unknown");
      await transport.close();
    }
  }
});

test("human replies retain the response byte cap, page cap, cursor and completed-turn checks", async () => {
  const request = adapterRequest(humanInput());
  const body = { delivery_id: request.delivery_id, message_id: request.message_id, binding_generation: target.binding_generation,
    origin: request.source.origin, target: { host: "codex", conversation_id: target.conversation_id }, relay,
    in_reply_to: request.in_reply_to, forward_of: request.forward_of, text: request.body.text,
    delivery_policy: request.delivery_policy, message_visibility: "visible" };
  const oversized = client(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(oversized.query({ delivery_id: request.delivery_id }, { request }), { code: "codex_response_too_large" });
  await oversized.close();
  for (const patch of [{ supported: false }, { thread_id: "other-thread" }, { turn_id: "other-turn" },
    { turn_status: "inProgress" }, { partial: true, cursor: "bad/cursor" },
    { replies: [{ item_id: "item", text: "text", turn_status: "inProgress" }] },
    { replies: Array.from({ length: 1001 }, () => ({ item_id: "item", text: "text", turn_status: "completed" })) }]) {
    const transport = client(async () => Response.json({ ok: true, delivery: receipt(body), replies: replyPage(patch) }));
    assert.equal(await transport.observeReply(request), null);
    await transport.close();
  }
  for (const mode of ["page-cap", "duplicate-item", "changed-turn", "repeated-cursor"]) {
    let pages = 0;
    const transport = client(async () => {
      pages += 1;
      return Response.json({ ok: true, delivery: receipt(body), replies: replyPage({ partial: true,
        cursor: mode === "repeated-cursor" ? "same_cursor" : `page_${pages}`,
        turn_id: mode === "changed-turn" && pages > 1 ? "changed-turn" : "fixture-turn",
        replies: mode === "duplicate-item" ? replyPage().replies : [],
      }) });
    });
    assert.equal(await transport.observeReply(request), null);
    assert.equal(pages, mode === "page-cap" ? 8 : 2);
    await transport.close();
  }
});
