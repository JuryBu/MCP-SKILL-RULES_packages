import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import net from "node:net";
import fs from "node:fs";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexCommunicationTransport } from "../src/codex-communication-transport.mjs";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { createWakeVisibilityAdapter } from "../src/wake-visibility.mjs";
import { createCodexDisplayPolicyManager } from "../src/codex-display-policy.mjs";

const threadId = "communication-fixture-thread";
const turnId = "communication-fixture-turn";
const input = overrides => ({ delivery_id: "delivery-fixture", message_id: "message-fixture", binding_generation: 7,
  origin: { kind: "agent", host: "codex", conversation_id: "source-fixture" },
  target: { host: "codex", conversation_id: threadId }, text: "  fixture text\r\n\t正文\n  ",
  delivery_policy: "next_model_boundary", message_visibility: "visible", ...overrides });
const rpcError = (code, overrides = {}) => Object.assign(new Error("fixture RPC rejection"), {
  code: "APP_SERVER_RPC_ERROR", details: { rpcError: { code } }, ...overrides,
});

function humanInput(overrides = {}) {
  const eventId = "a1".repeat(32);
  return input({
    origin: { kind: "human_message", channel: "napcat_owner_reply", source_ref: `owner-event:${eventId}` },
    relay: { host: "codex", conversation_id: "core-fixture" }, in_reply_to: "original-core-message",
    forward_of: { message_id: "original-core-message", delivery_id: "original-core-delivery", native_source: {
      provider: "napcat_owner", route: { route_key: "owner-route", conversation_id: "core-fixture", target_key: "owner-target", generation: 3 },
      original_qq_message_id: "-80001", event: { event_id: eventId, message_id: "80002", message_seq: 0,
        quoted_message_id: "-80001", sender_id: "90001" },
    } }, text: "  [CQ:reply,id=-80001][CQ:at,qq=90001] 本人原文\r\n\t\u0000 ", ...overrides,
  });
}

function fake(options = {}) {
  const client = { initialized: true, upstreamReady: true };
  const state = { client, live: [client], active: false, calls: [], subscriptions: [],
    thread: { id: threadId, status: { type: "idle" }, turns: [], ...options.thread } };
  state.proxy = {
    wakeVisibility: createWakeVisibilityAdapter(),
    displayPolicy: createCodexDisplayPolicyManager(),
    _liveReadyClients: () => state.live,
    _liveMaintenanceStatus: () => ({ active: state.active }),
    async subscribeThread(requestedThreadId) {
      state.subscriptions.push(requestedThreadId);
      return options.subscribe ? options.subscribe(state) : {
        threadId, readyClients: [client], results: [{ thread: state.thread }],
      };
    },
    async _liveInjectRequest(actualClient, method, params, requestOptions) {
      assert.equal(actualClient, client);
      const call = { method, params, options: requestOptions };
      state.calls.push(call);
      if (options.inject) return options.inject(call, state);
      return { turn: { id: turnId, status: "inProgress" } };
    },
  };
  client.wakeVisibility = state.proxy.wakeVisibility.createView();
  client.displayPolicy = state.proxy.displayPolicy.createView();
  state.transport = createCodexCommunicationTransport(state.proxy);
  return state;
}

test("human QQ reply uses the original idle start and exact busy steer with opaque text and honest source labels", async context => {
  for (const mode of ["idle", "busy"]) await context.test(mode, async () => {
    const state = fake({ thread: mode === "busy" ? { status: "active", turns: [{ id: turnId, status: "inProgress" }] } : {} });
    const value = humanInput();
    const original = structuredClone(value);
    let persisted = false;
    const delivered = await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {
      assert.equal(state.calls.length, 0);
      persisted = true;
    } });
    assert.equal(persisted, true);
    assert.equal(delivered.outcome, "accepted");
    assert.equal(delivered.injection_method, mode === "busy" ? "turn/steer" : "turn/start");
    assert.deepEqual(state.subscriptions, [threadId]);
    assert.equal(state.calls.length, 1);
    const call = state.calls[0];
    assert.equal(call.params.expectedTurnId, mode === "busy" ? turnId : undefined);
    assert.deepEqual(Object.keys(call.params).sort(), mode === "busy"
      ? ["clientUserMessageId", "expectedTurnId", "input", "threadId"] : ["clientUserMessageId", "input", "threadId"]);
    assert.deepEqual(call.options, { mutating: true, threadId });
    assert.equal(call.params.input[0].text, `【主人QQ回复，经可信交流核心转交】\n\n${value.text}\n\n消息 ID：${value.message_id}`);
    assert.equal(call.params.clientUserMessageId, `communication-${createHash("sha256").update(value.delivery_id).digest("hex")}`);
    assert.deepEqual(value, original);
  });
});

test("transport independently rejects malformed human provenance and agent mixing before subscription or mutation", async () => {
  const changes = [
    body => { body.origin.source_ref = "owner-event:forged"; },
    body => { body.origin.channel = "other"; },
    body => { body.forward_of.native_source.event.quoted_message_id = "12345"; },
    body => { body.forward_of.message_id = "another-message"; },
    body => { body.forward_of.native_source.route.generation = 0; },
    body => { body.forward_of.native_source.route.generation = Number.MAX_SAFE_INTEGER + 1; },
    body => { body.forward_of.native_source.event.message_seq = -1; },
    body => { body.forward_of.native_source.event.message_id = "0"; },
    body => { body.forward_of.native_source.event.sender_id = "1".repeat(21); },
    body => { body.forward_of.native_source.event.event_id = "A".repeat(64); },
    body => { body.forward_of.native_source.route.conversation_id = "wrong-core"; },
    body => { body.forward_of.native_source.route.route_key = "x".repeat(257); },
    body => { body.forward_of.native_source.event.token = "extra"; },
    body => { body.forward_of.native_source.route.path = "extra"; },
    body => { body.forward_of.text = "second copy"; },
    body => { body.relay.host = "windsurf"; },
    body => { body.relay.conversation_id = ""; },
    body => { body.origin.extra = "extra"; },
    body => { body.attachment_refs = []; },
    body => { body.target.extra = "extra"; },
    body => { body.message_id = 123; },
    body => { delete body.message_id; },
    body => { body.binding_generation = 0; },
    body => { body.text = ""; },
    body => { body.text = "x".repeat(256 * 1024 + 1); },
  ];
  const values = changes.map(change => { const body = humanInput(); change(body); return body; });
  for (const field of ["relay", "in_reply_to", "forward_of"]) values.push(input({ [field]: humanInput()[field] }));
  for (const value of values) {
    const state = fake();
    const actual = await state.transport.inspectAndDispatch(value, { beforeMutation: async () => assert.fail("invalid source must not prepare mutation") });
    assert.equal(actual.outcome, "failed_before_send");
    assert.equal(actual.request_sent, false);
    assert.equal(state.subscriptions.length, 0);
    assert.equal(state.calls.length, 0);
  }
});

test("human busy when_idle and lost mutation receipts retain the original no-send and unknown contracts", async () => {
  const busy = fake({ thread: { status: "active" } });
  const held = await busy.transport.inspectAndDispatch(humanInput({ delivery_policy: "when_idle" }), {
    beforeMutation: async () => assert.fail("busy must not send"),
  });
  assert.equal(held.outcome, "busy");
  assert.equal(held.request_sent, false);
  assert.equal(busy.calls.length, 0);
  const lost = fake({ inject: () => { throw Object.assign(new Error("lost receipt"), { outcomeUnknown: true }); } });
  const unknown = await lost.transport.inspectAndDispatch(humanInput(), { beforeMutation: async () => {} });
  assert.equal(unknown.outcome, "unknown");
  assert.equal(unknown.request_sent, null);
  assert.equal(lost.calls.length, 1);
});

test("agent display uses a short honest source label and the unchanged original body", async () => {
  const state = fake();
  const value = input();
  await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {} });
  const original = `【外部代理协作，来源：codex】\n\n${value.text}\n\n消息 ID：${value.message_id}`;
  assert.equal(state.calls[0].params.input[0].text, original);
});

test("idle dispatch waits for persistence and keeps source, whitespace, deterministic id and model settings", async () => {
  let persisted = false;
  const value = input({ model: "must-not-be-forwarded", config: { secret: true }, effort: "must-not-be-forwarded" });
  const original = structuredClone(value);
  const state = fake({ inject: call => {
    assert.equal(persisted, true);
    assert.equal(call.method, "turn/start");
    assert.deepEqual(Object.keys(call.params).sort(), ["clientUserMessageId", "input", "threadId"]);
    assert.deepEqual(call.options, { mutating: true, threadId });
    assert.equal(call.params.input[0].text, `【外部代理协作，来源：codex】\n\n${value.text}\n\n消息 ID：${value.message_id}`);
    assert.equal(call.params.input.length, 1);
    assert.equal(call.params.input[0].type, "text");
    assert.equal(call.params.clientUserMessageId, `communication-${createHash("sha256").update(value.delivery_id).digest("hex")}`);
    return { turn: { id: turnId } };
  } });
  const actual = await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {
    assert.equal(state.calls.length, 0);
    await Promise.resolve();
    persisted = true;
  } });
  assert.deepEqual(actual, { outcome: "accepted", request_sent: true, injection_method: "turn/start", thread_id: threadId, turn_id: turnId });
  assert.deepEqual(value, original);
});

test("empty and whitespace-only bodies survive the short source label verbatim", async () => {
  for (const text of ["", " \t\n\r\n ", "</external>\u0000\"\\正文"]) {
    const state = fake();
    await state.transport.inspectAndDispatch(input({ text }), { beforeMutation: async () => {} });
    assert.equal(state.calls[0].params.input[0].text, `【外部代理协作，来源：codex】\n\n${text}\n\n消息 ID：${input().message_id}`);
  }
});

test("the client user message id is stable per delivery and different for a different delivery", async () => {
  const ids = [];
  for (const deliveryId of ["same", "same", "different"]) {
    const state = fake();
    await state.transport.inspectAndDispatch(input({ delivery_id: deliveryId }), { beforeMutation: async () => {} });
    ids.push(state.calls[0].params.clientUserMessageId);
  }
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test("busy dispatch steers only the exact active turn and accepts a matching turnId receipt", async () => {
  const state = fake({ thread: { status: { type: "active" }, turns: [{ id: turnId, status: "inProgress" }] },
    inject: () => ({ turnId }) });
  const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => {} });
  assert.equal(actual.outcome, "accepted");
  assert.equal(actual.injection_method, "turn/steer");
  assert.equal(state.calls[0].params.expectedTurnId, turnId);
  assert.deepEqual(Object.keys(state.calls[0].params).sort(), ["clientUserMessageId", "expectedTurnId", "input", "threadId"]);
});

test("a busy metadata-only resume looks up one latest turn without loading items", async () => {
  let persisted = false;
  const state = fake({ thread: { status: "active" }, inject: call => {
    if (call.method === "thread/turns/list") {
      assert.equal(persisted, false);
      assert.deepEqual(call.params, { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      assert.notEqual(call.options.mutating, true);
      return { data: [{ id: turnId, status: "inProgress" }], nextCursor: null };
    }
    assert.equal(persisted, true);
    return { turnId };
  } });
  const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => { persisted = true; } });
  assert.equal(actual.outcome, "accepted");
  assert.deepEqual(state.calls.map(call => call.method), ["thread/turns/list", "turn/steer"]);
});

test("when_idle returns busy without persistence, turn lookup or mutation", async () => {
  const state = fake({ thread: { status: "active" } });
  const actual = await state.transport.inspectAndDispatch(input({ delivery_policy: "when_idle" }), {
    beforeMutation: async () => assert.fail("busy dispatch must not persist dispatching"),
  });
  assert.equal(actual.outcome, "busy");
  assert.equal(actual.request_sent, false);
  assert.equal(actual.injection_method, null);
  assert.equal(state.calls.length, 0);
});

test("when_idle starts a confirmed idle thread", async () => {
  const state = fake();
  assert.equal((await state.transport.inspectAndDispatch(input({ delivery_policy: "when_idle" }), {
    beforeMutation: async () => {},
  })).injection_method, "turn/start");
});

test("maintenance blocks subscription and is rechecked after persistence", async () => {
  const state = fake();
  state.active = true;
  const blocked = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => assert.fail() });
  assert.equal(blocked.error.code, "AUTOMATION_PAUSED");
  assert.equal(state.subscriptions.length, 0);
  state.active = false;
  const raced = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => { state.active = true; } });
  assert.equal(raced.outcome, "failed_before_send");
  assert.equal(state.calls.length, 0);
});

test("missing persistence hook and a rejecting persistence hook never send a mutation", async () => {
  const state = fake();
  assert.equal((await state.transport.inspectAndDispatch(input())).error.code, "BEFORE_MUTATION_REQUIRED");
  const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => { throw new Error("disk full"); } });
  assert.equal(actual.outcome, "failed_before_send");
  assert.equal(actual.request_sent, false);
  assert.equal(state.calls.length, 0);
});

test("unknown resume state, conflicting state and wrong thread identity cannot start a turn", async () => {
  for (const thread of [{ status: undefined }, { status: undefined, turns: [] }, { status: "notLoaded" },
    { status: "systemError" }, { id: "other-thread" },
    { status: "idle", turns: [{ id: turnId, status: "inProgress" }] }]) {
    const state = fake({ thread });
    const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => assert.fail() });
    assert.equal(actual.outcome, "failed_before_send");
    assert.equal(state.calls.length, 0);
  }
});

test("a vanished subscribed client cannot be replaced with an unrelated Desktop client", async () => {
  const state = fake();
  state.live = [{ initialized: true, upstreamReady: true }];
  assert.equal((await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => assert.fail() })).error.code, "NO_DESKTOP_CLIENT");
  state.live = [state.client];
  const raced = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => { state.live = []; } });
  assert.equal(raced.request_sent, false);
  assert.equal(state.calls.length, 0);
});

test("busy with no accurate active turn fails before send and never falls back to start", async () => {
  for (const turns of [[], [{ id: turnId, status: "completed" }], [{ id: "", status: "inProgress" }],
    [{ id: turnId, threadId: "another-thread", status: "inProgress" }]]) {
    const state = fake({ thread: { status: "active" }, inject: () => ({ data: turns, nextCursor: null }) });
    const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => assert.fail() });
    assert.equal(actual.outcome, "failed_before_send");
    assert.deepEqual(state.calls.map(call => call.method), ["thread/turns/list"]);
  }
});

test("conflicting active identities and subscription identity anomalies fail before mutation", async () => {
  for (const subscribe of [
    state => ({ threadId: "other", readyClients: [state.client], results: [{ thread: state.thread }] }),
    state => ({ threadId, readyClients: [state.client], results: [] }),
    state => ({ threadId, readyClients: [state.client], results: [{ thread: { id: threadId, status: "active", turns: [
      { id: "first", status: "inProgress" }, { id: "second", status: "inProgress" },
    ] } }] }),
  ]) {
    const state = fake({ subscribe });
    assert.equal((await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => assert.fail() })).request_sent, false);
    assert.equal(state.calls.length, 0);
  }
});

test("mutation failures distinguish explicit pre-send or known rejection from unknown outcomes", async context => {
  const scenarios = [
    [Object.assign(new Error("closed before write"), { code: "UPSTREAM_NOT_OPEN" }), false],
    [Object.assign(new Error("timeout"), { code: "APP_SERVER_TIMEOUT", outcomeUnknown: true }), true],
    [Object.assign(new Error("disconnect"), { code: "CONNECTION_CLOSED", outcomeUnknown: true }), true],
    [new Error("arbitrary throw"), true],
    [Object.assign(new Error("unknown write"), { code: "APP_SERVER_WRITE_FAILED", outcomeUnknown: false }), true],
    ...[-32602, -32600, -32601, -32001].map(code => [rpcError(code), false]),
    [rpcError(-32603), true], [rpcError(-32099), true], [rpcError(-32602, { outcomeUnknown: true }), true],
  ];
  for (const [error, unknown] of scenarios) await context.test(`${error.code ?? "throw"}:${error.details?.rpcError?.code ?? "none"}:${unknown}`, async () => {
    const state = fake({ inject: () => { throw error; } });
    const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => {} });
    assert.equal(actual.outcome, unknown ? "unknown" : "failed_before_send");
    assert.equal(actual.request_sent, unknown ? null : false);
    assert.equal(state.calls.length, 1);
  });
});

test("a steer race rejection never retries as turn/start", async () => {
  const state = fake({ thread: { status: "active", turns: [{ id: turnId, status: "inProgress" }] },
    inject: () => { throw rpcError(-32602); } });
  const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => {} });
  assert.equal(actual.outcome, "failed_before_send");
  assert.deepEqual(state.calls.map(call => call.method), ["turn/steer"]);
});

test("missing, conflicting or wrong-thread receipts remain unknown after a mutation", async () => {
  for (const response of [{}, { turn: {} }, { turn: { id: turnId }, turnId: "different-turn" },
    { threadId: "different-thread", turn: { id: turnId } }]) {
    const state = fake({ inject: () => response });
    const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => {} });
    assert.equal(actual.outcome, "unknown");
    assert.equal(actual.request_sent, null);
  }
  const state = fake({ thread: { status: "active", turns: [{ id: turnId, status: "inProgress" }] },
    inject: () => ({ turnId: "different-turn" }) });
  const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: async () => {} });
  assert.equal(actual.outcome, "unknown");
  assert.equal(actual.turn_id, turnId);
});

const delivery = overrides => ({ thread_id: threadId, turn_id: turnId, ...overrides });
const completed = { data: [{ id: turnId, status: "completed" }], nextCursor: null };
const messageEntry = (id, text, type = "agentMessage") => ({ turnId, item: { type, id, text } });

test("reply reader returns completed agent text and identities only, using scoped readonly pagination", async () => {
  const state = fake({ inject: call => {
    assert.equal(call.options.mutating, false);
    if (call.method === "thread/turns/list") {
      assert.deepEqual(call.params, { threadId, limit: 50, sortDirection: "desc", itemsView: "notLoaded" });
      return completed;
    }
    assert.deepEqual(call.params, { threadId, turnId, limit: 50, sortDirection: "asc" });
    return { data: [messageEntry("reply-1", "  preserved\nreply "), messageEntry("reason", "private", "reasoning"),
      messageEntry("thinking", "private", "thinking"), messageEntry("tool", "private", "commandExecution"),
      messageEntry("user", "private", "userMessage"), messageEntry("reply-1", "  preserved\nreply "),
      { turnId, item: { type: "agentMessage", id: "unfinished", text: "draft", status: "inProgress" } }], nextCursor: null };
  } });
  state.active = true;
  const actual = await state.transport.readCompletedReplies(delivery());
  assert.equal(actual.outcome, "ok");
  assert.equal(actual.turn_status, "completed");
  assert.equal(actual.partial, false);
  assert.deepEqual(actual.replies, [{ item_id: "reply-1", text: "  preserved\nreply ", turn_status: "completed" }]);
  assert.equal(state.subscriptions.length, 0);
});

test("active, failed and interrupted turns yield no completed reply and no inferred processing state", async () => {
  for (const status of ["inProgress", "failed", "interrupted"]) {
    const state = fake({ inject: () => ({ data: [{ id: turnId, status }], nextCursor: null }) });
    const actual = await state.transport.readCompletedReplies(delivery());
    assert.equal(actual.turn_status, status);
    assert.deepEqual(actual.replies, []);
    assert.equal(Object.hasOwn(actual, "processed"), false);
    assert.equal(state.calls.length, 1);
  }
});

test("reply reading requires recorded identities and refuses mismatched delivery and cursor scope", async () => {
  for (const value of [delivery({ turn_id: null }), delivery({ target: { host: "codex", conversation_id: "other" } }),
    delivery({ reply_cursor: { method: "thread/items/list", value: "opaque", thread_id: "other", turn_id: turnId } })]) {
    const state = fake();
    const actual = await state.transport.readCompletedReplies(value);
    assert.equal(actual.partial, true);
    assert.deepEqual(actual.replies, []);
    assert.equal(state.calls.length, 0);
  }
});

test("a different-turn reply is never leaked", async () => {
  const state = fake({ inject: call => call.method === "thread/turns/list" ? completed : {
    data: [{ turnId: "unrelated", item: { type: "agentMessage", id: "secret", text: "must not leak" } }], nextCursor: null,
  } });
  const actual = await state.transport.readCompletedReplies(delivery());
  assert.equal(actual.error.code, "REPLY_IDENTITY_MISMATCH");
  assert.deepEqual(actual.replies, []);
});

test("turn pagination is bounded and resumes from a scoped opaque cursor", async () => {
  const state = fake({ inject: call => {
    if (call.params.cursor === "page-4") return completed;
    if (call.method === "thread/items/list") return { data: [messageEntry("found", "reply")], nextCursor: null };
    const index = Number((call.params.cursor ?? "page-0").split("-")[1]);
    return { data: [{ id: `other-${index}`, status: "completed" }], nextCursor: `page-${index + 1}` };
  } });
  const first = await state.transport.readCompletedReplies(delivery());
  assert.equal(first.partial, true);
  assert.equal(first.cursor.method, "thread/turns/list");
  assert.equal(state.calls.length, 4);
  const second = await state.transport.readCompletedReplies(delivery({ reply_cursor: first.cursor }));
  assert.equal(second.partial, false);
  assert.equal(second.replies[0].text, "reply");
  assert.equal(state.calls[4].params.cursor, "page-4");
});

test("item pagination is bounded and preserves the matching turn page when resumed", async () => {
  const state = fake({ inject: call => {
    if (call.method === "thread/turns/list") return call.params.cursor === "target-page" ? completed : {
      data: [{ id: "other", status: "completed" }], nextCursor: "target-page",
    };
    const index = Number((call.params.cursor ?? "items-0").split("-")[1]);
    return { data: [messageEntry(`reply-${index}`, `text-${index}`)], nextCursor: index < 4 ? `items-${index + 1}` : null };
  } });
  const first = await state.transport.readCompletedReplies(delivery());
  assert.equal(first.partial, true);
  assert.equal(first.replies.length, 4);
  assert.equal(first.cursor.method, "thread/items/list");
  assert.equal(first.cursor.turn_cursor, "target-page");
  const second = await state.transport.readCompletedReplies(delivery({ reply_cursor: first.cursor }));
  assert.equal(second.partial, false);
  assert.deepEqual(second.replies, [{ item_id: "reply-4", text: "text-4", turn_status: "completed" }]);
  assert.deepEqual(state.calls.slice(-2).map(call => call.params.cursor), ["target-page", "items-4"]);
});

test("unsupported history methods and schemas have concrete limitations without alternate mutation", async () => {
  for (const inject of [() => { throw rpcError(-32601); }, () => ({ data: [] }),
    () => ({ data: [{ id: turnId, status: "unknown" }], nextCursor: null })]) {
    const state = fake({ inject });
    const actual = await state.transport.readCompletedReplies(delivery());
    assert.equal(actual.outcome, "unsupported");
    assert.equal(actual.supported, false);
    assert.equal(actual.partial, true);
    assert.ok(actual.error.message);
    assert.equal(state.subscriptions.length, 0);
    assert.equal(state.calls.every(call => call.options.mutating === false), true);
  }
});

test("an unsupported scoped item method or unscoped item schema is explicitly unsupported", async () => {
  for (const itemPage of [rpcError(-32601), rpcError(-32600),
    { data: [{ type: "agentMessage", id: "unscoped", text: "private" }], nextCursor: null }]) {
    const state = fake({ inject: call => {
      if (call.method === "thread/turns/list") return completed;
      if (itemPage instanceof Error) throw itemPage;
      return itemPage;
    } });
    const actual = await state.transport.readCompletedReplies(delivery());
    assert.equal(actual.outcome, "unsupported");
    assert.equal(actual.supported, false);
    assert.deepEqual(actual.replies, []);
    assert.deepEqual(state.calls.map(call => call.method), ["thread/turns/list", "thread/items/list"]);
  }
});

test("reply reading reports an exhausted history or unavailable Desktop without mutation", async () => {
  const state = fake({ inject: () => ({ data: [], nextCursor: null }) });
  assert.equal((await state.transport.readCompletedReplies(delivery())).outcome, "not_found");
  state.live = [];
  const actual = await state.transport.readCompletedReplies(delivery());
  assert.equal(actual.outcome, "unavailable");
  assert.equal(actual.error.code, "NO_DESKTOP_CLIENT");
  assert.equal(state.calls.length, 1);
  assert.equal(state.subscriptions.length, 0);
});

test("repeating history cursors stop instead of looping", async () => {
  const state = fake({ inject: () => ({ data: [], nextCursor: "same" }) });
  const actual = await state.transport.readCompletedReplies(delivery());
  assert.equal(actual.error.code, "HISTORY_CURSOR_LOOP");
  assert.equal(state.calls.length, 2);
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Isolated Desktop fixture deadline exceeded");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function websocketFixture(context, mode = "idle", projection = false, eventsAfterReply = false) {
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(upstream, "listening");
  const requests = [];
  const messages = [];
  const history = mode === "busy" ? [{ id: "human-opening", type: "userMessage", clientId: "human",
    content: [{ type: "text", text: "original input" }] }] : [];
  let nextItemIndex = history.length;
  let beforeMutationFinished = false;
  let finished = false;
  upstream.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes.toString("utf8"));
    requests.push(request);
    const reply = result => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") reply({});
    else if (request.method === "thread/resume") reply({ thread: { id: threadId, status: { type: mode === "busy" ? "active" : "idle" }, turns: [] } });
    else if (request.method === "thread/turns/list") reply({ data: [{ id: turnId, status: finished ? "completed" : "inProgress" }], nextCursor: null });
    else if (request.method === "thread/items/list") reply({ data: [messageEntry("real-ws-reply", "  WS completed reply\n"),
      messageEntry("ws-reasoning", "private", "reasoning")], nextCursor: null });
    else if (request.method === "thread/read") reply({ thread: { id: threadId, turns: [{ id: turnId, items: history }] } });
    else if (["turn/start", "turn/steer"].includes(request.method)) {
      assert.equal(beforeMutationFinished, true);
      if (mode === "timeout") return;
      if (mode === "disconnect") { socket.terminate(); return; }
      if (mode === "reject") { socket.send(JSON.stringify({ id: request.id, error: { code: -32602, message: "fixture rejection" } })); return; }
      const item = { id: `communication-item-${nextItemIndex++}`, type: "userMessage",
        clientId: request.params.clientUserMessageId, content: request.params.input };
      const notify = () => { if (projection) {
        history.push(item);
        for (const method of ["item/started", "item/completed"]) socket.send(JSON.stringify({ method, params: { threadId, turnId, item } }));
      } };
      if (!eventsAfterReply) notify();
      reply(request.method === "turn/steer" ? { turnId } : { turn: { id: turnId, status: "inProgress" } });
      if (eventsAfterReply) setTimeout(notify, 0);
    }
  }));
  const proxy = createCodexAppServerProxy({ upstreamUrl: `ws://127.0.0.1:${upstream.address().port}`,
    downstreamPort: await freePort(), controlPort: await freePort(), controlToken: "communication-isolated-fixture-token",
    requestTimeoutMs: 250, resumeRequestTimeoutMs: 250 });
  let desktop;
  context.after(async () => {
    desktop?.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
  });
  await proxy.start();
  desktop = new WebSocket(proxy.status().downstreamUrl);
  desktop.on("message", bytes => messages.push(JSON.parse(bytes.toString("utf8"))));
  desktop.on("error", () => {});
  await once(desktop, "open");
  desktop.send(JSON.stringify({ id: "fixture-init", method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  return { proxy, requests, messages, history, desktop, upstream, transport: createCodexCommunicationTransport(proxy),
    beforeMutation: async () => { await Promise.resolve(); beforeMutationFinished = true; },
    finish: () => { finished = true; } };
}

test("isolated real proxy and WebSockets use existing Desktop injection for start, steer and scoped replies", { timeout: 12000 }, async context => {
  for (const mode of ["idle", "busy"]) await context.test(mode, async child => {
    const state = await websocketFixture(child, mode);
    const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: state.beforeMutation });
    assert.equal(actual.outcome, "accepted");
    assert.equal(actual.injection_method, mode === "busy" ? "turn/steer" : "turn/start");
    const mutation = state.requests.find(request => request.method === actual.injection_method);
    assert.ok(mutation);
    assert.equal(mutation.params.input[0].text, `【外部代理协作，来源：codex】\n\n${input().text}\n\n消息 ID：${input().message_id}`);
    assert.equal(Object.hasOwn(mutation.params, "model"), false);
    assert.equal(Object.hasOwn(mutation.params, "config"), false);
    assert.equal(Object.hasOwn(mutation.params, "effort"), false);
    state.finish();
    const replies = await state.transport.readCompletedReplies(actual);
    assert.equal(replies.outcome, "ok");
    assert.deepEqual(replies.replies, [{ item_id: "real-ws-reply", text: "  WS completed reply\n", turn_status: "completed" }]);
    assert.equal(state.proxy.status().clientCount, 1);
  });
});

test("real proxy injection reports written timeout/disconnect as unknown and standard RPC rejection as not accepted", { timeout: 12000 }, async context => {
  for (const mode of ["timeout", "disconnect", "reject"]) await context.test(mode, async child => {
    const state = await websocketFixture(child, mode);
    const actual = await state.transport.inspectAndDispatch(input(), { beforeMutation: state.beforeMutation });
    assert.equal(actual.outcome, mode === "reject" ? "failed_before_send" : "unknown");
    assert.equal(actual.request_sent, mode === "reject" ? false : null);
    assert.equal(state.requests.filter(request => request.method === "turn/start").length, 1);
  });
});

function projectItem(client, call, itemId, overrides = {}) {
  const message = { method: "item/started", params: { threadId, turnId,
    item: { type: "userMessage", id: itemId, clientId: call.params.clientUserMessageId,
      content: call.params.input, ...overrides } } };
  client.displayPolicy.observeUpstream(message);
  const suppressed = client.wakeVisibility.shouldSuppress(message);
  const stable = suppressed ? message : client.wakeVisibility.project(message);
  return client.displayPolicy.project(message, stable, suppressed);
}

test("default hidden isolates identical delivery bodies, ordinary users and old wakes across live and reloaded history", async () => {
  const state = fake({ thread: { status: "active", turns: [{ id: turnId, status: "inProgress" }] } });
  const oldWake = state.proxy.wakeVisibility.registerWake({ threadId, wakeId: "old-wake",
    prompt: `【外部代理协作，来源：codex】\n\n${input().text}\n\n消息 ID：${input().message_id}`, messageVisibility: "visible",
    turnId, injectionMethod: "turn/steer", visibilityClientId: "old-client" });
  state.proxy.displayPolicy.registerReminder(oldWake);
  for (const [id, visibility] of [["hidden-one", undefined], ["visible-two", "visible"], ["hidden-three", "hidden"]]) {
    const value = input({ delivery_id: id, message_visibility: visibility });
    assert.equal((await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {} })).outcome, "accepted");
  }
  const [hidden, visible, another] = state.calls;
  assert.equal(hidden.params.input[0].text, visible.params.input[0].text);
  assert.equal(projectItem(state.client, hidden, "ordinary-before", { clientId: "ordinary-human" })?.params.item.id, "ordinary-before");
  assert.equal(projectItem(state.client, hidden, "hidden-item"), null);
  assert.equal(projectItem(state.client, visible, "visible-item")?.params.item.id, "visible-item");
  assert.equal(projectItem(state.client, another, "another-hidden-item"), null);
  assert.equal(projectItem(state.client, hidden, "ordinary-after", { clientId: null })?.params.item.id, "ordinary-after");
  assert.equal(state.proxy.wakeVisibility.snapshot().registeredWakes, 1);
  assert.equal(oldWake.itemKey, null);
  assert.ok(projectItem(state.client, hidden, "old-visible-wake", { clientId: "old-client" }));
  const reloaded = { wakeVisibility: state.proxy.wakeVisibility.createView(), displayPolicy: state.proxy.displayPolicy.createView() };
  const request = { id: "reload", method: "thread/read", params: { threadId } };
  reloaded.wakeVisibility.observeRequest(request);
  reloaded.displayPolicy.observeRequest(request);
  const items = [{ type: "userMessage", id: "opening", clientId: "ordinary-human", content: [{ type: "text", text: "opening" }] },
    ...state.calls.map((call, index) => ({ type: "userMessage", id: ["hidden-item", "visible-item", "another-hidden-item"][index],
      clientId: call.params.clientUserMessageId, content: call.params.input }))];
  const response = { id: "reload", result: { thread: { id: threadId, turns: [{ id: turnId, items }] } } };
  reloaded.displayPolicy.observeUpstream(response);
  const stable = reloaded.wakeVisibility.project(response);
  const projected = reloaded.displayPolicy.project(response, stable, false);
  assert.deepEqual(projected.result.thread.turns[0].items.map(item => item.id), ["opening", "visible-item"]);
  reloaded.wakeVisibility.close();
  reloaded.displayPolicy.close();
});

test("hidden idle opening stays visible and subsequent exact steer is hidden", async () => {
  const state = fake();
  assert.equal((await state.transport.inspectAndDispatch(input({ message_visibility: undefined }), { beforeMutation: async () => {} })).outcome, "accepted");
  assert.ok(projectItem(state.client, state.calls[0], "idle-opening"));
  state.thread.status = "active";
  state.thread.turns = [{ id: turnId, status: "inProgress" }];
  await state.transport.inspectAndDispatch(input({ delivery_id: "later", message_visibility: "hidden" }), { beforeMutation: async () => {} });
  assert.equal(projectItem(state.client, state.calls[1], "later-steer"), null);
});

test("missing projection dependencies reject hidden and visible before persistent mutation", async () => {
  for (const visibility of [undefined, "hidden", "visible"]) {
    const state = fake();
    delete state.proxy.wakeVisibility;
    const result = await state.transport.inspectAndDispatch(input({ message_visibility: visibility }), {
      beforeMutation: async () => assert.fail("dependencies must be checked first"),
    });
    assert.equal(result.outcome, "failed_before_send");
    assert.equal(result.error.code, "COMMUNICATION_VISIBILITY_UNAVAILABLE");
    assert.equal(state.calls.length, 0);
  }
});

test("a previously working projection dependency removed later rejects before a second mutation", async () => {
  const state = fake();
  assert.equal((await state.transport.inspectAndDispatch(input({ message_visibility: "hidden" }), { beforeMutation: async () => {} })).outcome, "accepted");
  delete state.proxy.displayPolicy.createView;
  const result = await state.transport.inspectAndDispatch(input({ delivery_id: "later-dependency-loss", message_visibility: "hidden" }), {
    beforeMutation: async () => assert.fail("lost dependency must reject before persistent mutation"),
  });
  assert.equal(result.error.code, "COMMUNICATION_VISIBILITY_UNAVAILABLE");
  assert.equal(result.outcome, "failed_before_send");
  assert.equal(state.calls.length, 1);
});

test("start and steer keep unknown visibility but forget explicit pre-send rejection, including beforeMutation failure", async () => {
  for (const busy of [false, true]) for (const scenario of ["before", "closed", "rejected", "unknown", "accepted"]) {
    const state = fake({ thread: busy ? { status: "active", turns: [{ id: turnId, status: "inProgress" }] } : {},
      inject: () => {
        if (scenario === "closed") throw Object.assign(new Error("closed"), { code: "UPSTREAM_NOT_OPEN" });
        if (scenario === "rejected") throw rpcError(-32602);
        if (scenario === "unknown") throw Object.assign(new Error("lost"), { outcomeUnknown: true });
        return { turn: { id: turnId } };
      } });
    const value = input({ message_visibility: "hidden" });
    const result = await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {
      if (scenario === "before") throw new Error("persistence failed");
    } });
    const call = state.calls[0] ?? { params: { input: [{ type: "text", text: `【外部代理协作，来源：codex】\n\n${value.text}\n\n消息 ID：${value.message_id}` }],
      clientUserMessageId: `communication-${createHash("sha256").update(value.delivery_id).digest("hex")}` } };
    if (scenario === "unknown" || scenario === "accepted") {
      assert.equal(result.outcome, scenario === "accepted" ? "accepted" : "unknown");
      assert.equal(projectItem(state.client, call, `result-${scenario}`) === null, busy);
    } else {
      assert.equal(result.outcome, "failed_before_send");
      assert.ok(projectItem(state.client, call, `result-${scenario}`));
    }
  }
});

test("real proxy WS projects hidden middle bubbles and history while preserving explicit visible and idle opening", { timeout: 12000 }, async context => {
  for (const busy of [false, true]) for (const eventsAfterReply of [false, true]) await context.test(`${busy}:${eventsAfterReply}`, async child => {
    const state = await websocketFixture(child, busy ? "busy" : "idle", true, eventsAfterReply);
    const oldWakeCount = state.proxy.wakeVisibility.snapshot().registeredWakes;
    for (const [id, visibility] of [["ws-hidden", undefined], ["ws-visible", "visible"]]) {
      const actual = await state.transport.inspectAndDispatch(input({ delivery_id: id, message_visibility: visibility }), { beforeMutation: state.beforeMutation });
      assert.equal(actual.outcome, "accepted");
    }
    await waitFor(() => state.history.length === (busy ? 3 : 2));
    state.desktop.send(JSON.stringify({ id: "projection-read", method: "thread/read", params: { threadId } }));
    await waitFor(() => state.messages.some(message => message.id === "projection-read"));
    const read = state.messages.find(message => message.id === "projection-read");
    const hiddenId = busy ? "communication-item-1" : "communication-item-0";
    const visibleId = busy ? "communication-item-2" : "communication-item-1";
    const eventIds = state.messages.filter(message => message.params?.item).map(message => message.params.item.id);
    assert.equal(eventIds.includes(hiddenId), !busy);
    assert.equal(eventIds.filter(id => id === visibleId).length, 2);
    assert.deepEqual(read.result.thread.turns[0].items.map(item => item.id), busy ? ["human-opening", visibleId] : [hiddenId, visibleId]);
    assert.equal(state.proxy.wakeVisibility.snapshot().registeredWakes, oldWakeCount);
    assert.ok(state.requests.filter(request => ["turn/start", "turn/steer"].includes(request.method)).every(request => !Object.hasOwn(request.params, "message_visibility")));
  });
});

test("restored hidden confirmed and unknown bindings hide exact null-client history only", () => {
  for (const status of ["confirmed", "unknown"]) {
    const state = fake();
    const value = input({ message_visibility: "hidden" });
    state.transport.restoreVisibility({ ...value, status, injection_method: "turn/steer", turn_id: turnId,
      visibility_item_key: JSON.stringify([threadId, turnId, "saved-hidden-item"]) });
    const call = { params: { clientUserMessageId: null, input: [{ type: "text", text: `【外部代理协作，来源：codex】\n\n${value.text}\n\n消息 ID：${value.message_id}` }] } };
    assert.equal(projectItem(state.client, call, "saved-hidden-item"), null);
    assert.ok(projectItem(state.client, call, "ordinary-copy"));
    assert.equal(state.proxy.wakeVisibility.snapshot().registeredWakes, 0);
  }
});

test("real renderer emits agent and human samples with exactly the complete message-id tail and untouched opaque body", async () => {
  const samples = [];
  for (const value of [input({ message_id: "agent-original-message-001", text: "外部代理的协作原文\n[CQ:opaque,id=fixture]" }),
    humanInput({ message_id: "owner-original-message-002", text: "主人QQ回复的原文\n[CQ:reply,id=-80001] 保留正文  " })]) {
    const state = fake();
    const delivered = await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {} });
    assert.equal(delivered.outcome, "accepted");
    const rendered = state.calls[0].params.input[0].text;
    assert.equal(rendered.split("\n").at(-1), `消息 ID：${value.message_id}`);
    assert.equal(rendered.match(/消息 ID：/g)?.length, 1);
    assert.ok(rendered.includes(`\n\n${value.text}\n\n`));
    assert.equal(rendered.includes(value.delivery_id), false);
    samples.push({ kind: value.origin.kind, message_id: value.message_id, original_text: value.text, rendered_text: rendered });
  }
  if (process.env.COMMUNICATION_RENDERER_SAMPLES) fs.writeFileSync(process.env.COMMUNICATION_RENDERER_SAMPLES, JSON.stringify(samples, null, 2), "utf8");
});

test("live tagged hidden keeps its exact persisted item hidden after null-client thread/read in the same and a new view", async () => {
  const state = fake({ thread: { status: "active", turns: [{ id: turnId, status: "inProgress" }] } });
  let bound = null;
  const value = input({ message_visibility: "hidden" });
  await state.transport.inspectAndDispatch(value, { beforeMutation: async () => {}, onVisibilityBound: registration => {
    bound = registration.itemKey;
    return true;
  } });
  const call = state.calls[0];
  assert.equal(projectItem(state.client, call, "live-hidden-item"), null);
  assert.equal(bound, JSON.stringify([threadId, turnId, "live-hidden-item"]));
  const original = { id: "live-hidden-item", type: "userMessage", clientId: null, content: call.params.input };
  for (const client of [state.client, { wakeVisibility: state.proxy.wakeVisibility.createView(), displayPolicy: state.proxy.displayPolicy.createView() }]) {
    const request = { id: "null-client-thread-read", method: "thread/read", params: { threadId } };
    client.wakeVisibility.observeRequest(request);
    client.displayPolicy.observeRequest(request);
    const opening = { id: "opening-human", type: "userMessage", clientId: "human", content: [{ type: "text", text: "opening" }] };
    const copy = { ...original, id: "ordinary-copy", clientId: "human" };
    const response = { id: request.id, result: { thread: { id: threadId, turns: [{ id: turnId, items: [opening, original, copy] }] } } };
    client.displayPolicy.observeUpstream(response);
    const stable = client.wakeVisibility.project(response);
    const projected = client.displayPolicy.project(response, stable, false);
    assert.deepEqual(projected.result.thread.turns[0].items.map(item => item.id), [opening.id, copy.id]);
    if (client !== state.client) { client.wakeVisibility.close(); client.displayPolicy.close(); }
  }
});

test("ordinary upstream hashing remains constant at 0, 32, 128 and 512 completed deliveries", async () => {
  const originalCreateHash = crypto.createHash;
  let hashes = 0;
  const measurements = [];
  crypto.createHash = (...args) => { hashes += 1; return originalCreateHash(...args); };
  syncBuiltinESMExports();
  try {
    for (const count of [0, 32, 128, 512]) {
      const state = fake({ thread: { status: "active", turns: [{ id: turnId, status: "inProgress" }] } });
      state.transport.setVisibilitySource({ lookup: () => null, onBound: () => true });
      for (let index = 0; index < count; index += 1) {
        assert.equal((await state.transport.inspectAndDispatch(input({ delivery_id: `hash-${index}`, message_visibility: "hidden" }),
          { beforeMutation: async () => {} })).outcome, "accepted");
      }
      const before = state.transport.visibilitySnapshot();
      hashes = 0;
      const shown = projectItem(state.client, { params: { clientUserMessageId: "ordinary-human",
        input: [{ type: "text", text: "unrelated human text" }] } }, "ordinary-item");
      const observed = hashes;
      const after = state.transport.visibilitySnapshot();
      assert.ok(shown);
      assert.equal(observed, 2);
      assert.equal(after.managersCreated, before.managersCreated);
      assert.equal(after.coldLookups - before.coldLookups, 1);
      assert.ok(after.hotEntries <= after.cacheLimit);
      assert.equal(after.retainedPromptChars, 0);
      measurements.push({ completedDeliveries: count, hashes: observed, hotEntries: after.hotEntries,
        managers: after.managers, views: after.cachedViews, ledgerLookups: after.coldLookups - before.coldLookups });
      state.client.wakeVisibility.close();
      state.client.displayPolicy.close();
    }
  } finally {
    crypto.createHash = originalCreateHash;
    syncBuiltinESMExports();
  }
  if (process.env.COMMUNICATION_AMPLIFICATION_METRICS) fs.writeFileSync(process.env.COMMUNICATION_AMPLIFICATION_METRICS, JSON.stringify(measurements, null, 2), "utf8");
});
