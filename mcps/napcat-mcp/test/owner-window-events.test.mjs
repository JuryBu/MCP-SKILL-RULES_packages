import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createControlState } from "../src/control-state.mjs";
import { createControlPlane } from "../src/control-plane.mjs";
import { createNapCatNotifier } from "../src/core.mjs";
import { OWNER_WINDOW_EVENT_LIMITS } from "../src/owner-window-events.mjs";

const SELF = "1000000001";
const OWNER = "1999000001";
const GROUP = "2999000001";

function windowBinding(generation = 1, conversationId = "model-a") {
  const target = {
    machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: conversationId,
    binding_id: `synthetic-${conversationId}`, binding_generation: 1,
  };
  return { generation, owner_key: JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id]), target };
}

function registration(overrides = {}) {
  return {
    route_key: "window-route", conversation_id: "stable-core-component", target_key: "owner-private",
    capture_owner_events: true, reply_delivery: "events_only", window_capture: true,
    expected_generation: 0, dedupe_key: "register-1", window_binding: windowBinding(), ...overrides,
  };
}

function fixture(context, options = {}) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, "napcat-owner-window-"));
  const cleanups = [];
  context.after(async () => {
    for (const cleanup of cleanups.slice().reverse()) await cleanup();
    assert.equal(path.dirname(root), temporaryParent);
    assert.ok(path.basename(root).startsWith("napcat-owner-window-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const statePath = path.join(root, "control-state.json");
  const configuration = {
    enabled: true, expectedSelfId: SELF, defaultTargetKey: "owner-private",
    targets: { "owner-private": { type: "private", id: OWNER }, "owner-group": { type: "group", id: GROUP } },
  };
  const histories = new Map([["owner-private", []], ["owner-group", []]]);
  const reads = [];
  const wakes = [];
  const notifier = {
    getControlPlaneConfig: () => configuration,
    readConfiguredTargetMessages: async (input) => {
      reads.push(structuredClone(input));
      assert.equal(input.count, 50);
      assert.equal(input.reverse_order, true);
      return { target: structuredClone(configuration.targets[input.target_key]),
        messages: structuredClone((histories.get(input.target_key) ?? []).slice(-50)) };
    },
    sendConfiguredMessage: async () => assert.fail("window fixture must never send a QQ message"),
  };
  const now = () => new Date("2026-11-16T00:00:00.000Z");
  const bridge = { wake: async (input) => { wakes.push(structuredClone(input)); return { outcome: "accepted" }; } };
  const reload = () => {
    const state = createControlState({ statePath, now, maxSeen: options.maxSeen ?? 2048 });
    return { state, control: createControlPlane({ notifier, state, bridge, now }) };
  };
  const initial = reload();
  const readInput = (overrides = {}) => ({
    route_key: "window-route", conversation_id: "stable-core-component", expected_route_generation: 1, ...overrides,
  });
  const message = (sequence, overrides = {}, targetKey = "owner-private") => {
    const native = {
      messageId: String(1000 + sequence), messageSeq: sequence, senderId: OWNER, isSelf: false,
      replyMessageId: null, text: `preview ${sequence}`, ownerEventContent: { text: `native ${sequence}` },
      time: "2026-11-16T00:00:01.000Z", mentionedUserIds: [], hasExplicitText: true, contentTypes: ["text"], attachments: [],
      ...overrides,
    };
    histories.get(targetKey).push(native);
    return native;
  };
  return {
    root, statePath, configuration, histories, reads, wakes, notifier, now, bridge, reload, cleanups, ...initial,
    register: (overrides = {}, control = initial.control) => control.registerOwnerWindowRoute(registration(overrides)),
    get: (overrides = {}, control = initial.control) => control.getOwnerWindowRoute({
      route_key: "window-route", conversation_id: "stable-core-component", ...overrides,
    }),
    read: (overrides = {}, control = initial.control) => control.readOwnerWindowEvents(readInput(overrides)),
    close: (overrides = {}) => initial.control.closeOwnerWindowRoute({
      route_key: "window-route", conversation_id: "stable-core-component", expected_generation: 1, ...overrides,
    }),
    message,
  };
}

test("private default ingress needs no outbound notice and freezes native fields plus binding", async (context) => {
  const subject = fixture(context);
  const opened = await subject.register();
  assert.equal(opened.route.route_generation, 1);
  assert.equal(opened.route.reply_delivery, "events_only");
  subject.message(7, { text: "short preview", ownerEventContent: { text: "完整原生正文".repeat(600) } });
  const scan = await subject.control.scanOwnerReplies();
  assert.equal(scan.results[0].outcome, "owner_window_captured");
  const page = subject.read();
  const event = page.events[0];
  assert.match(event.event_id, /^[a-f0-9]{64}$/);
  assert.equal(event.message_id, "1007");
  assert.equal(event.message_seq, 7);
  assert.equal(event.sender_id, OWNER);
  assert.equal(event.text, "完整原生正文".repeat(600));
  assert.equal(event.content, event.text);
  assert.equal(event.source_kind, "human_message");
  assert.equal(event.route_generation, 1);
  assert.deepEqual(event.window_binding, windowBinding());
  assert.deepEqual(event.window, { channel: "qq", type: "private", id: OWNER, self_id: SELF });
  assert.deepEqual(event.owner_sender_allowlist, [OWNER]);
  assert.equal(subject.reads.length, 2);
  assert.equal(subject.reads.at(-1).include_owner_event_content, true);
  assert.equal(subject.wakes.length, 0);
  assert.deepEqual(subject.state.snapshot().ownerAlertMessages, {});
  assert.equal(subject.state.listOwnerRouteBufferedMessages("window-route").length, 0);
});

test("first fifty messages and reopened fifty messages are baselines only", async (context) => {
  const subject = fixture(context);
  for (let sequence = 1; sequence <= 50; sequence += 1) subject.message(sequence);
  const opened = await subject.register();
  assert.equal(opened.route.baseline_message_count, 50);
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events, []);
  subject.message(51);
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [51]);
  subject.close();
  subject.message(52);
  const reopened = await subject.register({ expected_generation: 2, dedupe_key: "reopen-3" });
  assert.equal(reopened.route.route_generation, 3);
  await subject.control.scanOwnerReplies();
  subject.message(53);
  await subject.control.scanOwnerReplies();
  const events = subject.read({ expected_route_generation: 3 }).events;
  assert.deepEqual(events.map((event) => event.message_seq), [51, 53]);
  assert.deepEqual(events.map((event) => event.route_generation), [1, 3]);
});

test("unquoted private sender must match the configured owner and self history is ignored", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1, { senderId: "1999000099" });
  subject.message(2, { isSelf: true, senderId: SELF });
  subject.message(3);
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [3]);
});

test("group default ingress requires both configured private-owner sender and mention of this account", async (context) => {
  const subject = fixture(context);
  await subject.register({ target_key: "owner-group" });
  subject.message(1, { mentionedUserIds: [SELF] }, "owner-group");
  subject.message(2, { senderId: "1999000099", mentionedUserIds: [SELF] }, "owner-group");
  subject.message(3, { mentionedUserIds: ["1000000099"] }, "owner-group");
  subject.message(4, { mentionedUserIds: undefined }, "owner-group");
  subject.message(5, { isSelf: true, senderId: SELF, mentionedUserIds: [SELF] }, "owner-group");
  subject.message(6, { mentionedUserIds: SELF }, "owner-group");
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [1]);
  assert.deepEqual(subject.get().route.owner_sender_allowlist, [OWNER]);
});

test("group registration fails before any history read without one unambiguous private owner", async (context) => {
  const subject = fixture(context);
  delete subject.configuration.targets["owner-private"];
  await assert.rejects(subject.register({ target_key: "owner-group" }), { code: "OWNER_WINDOW_TRUST_UNAVAILABLE" });
  subject.configuration.targets["owner-private"] = { type: "private", id: OWNER };
  subject.configuration.targets["another-person"] = { type: "private", id: "1999000099" };
  await assert.rejects(subject.register({ target_key: "owner-group" }), { code: "OWNER_WINDOW_TRUST_AMBIGUOUS" });
  assert.equal(subject.reads.length, 0);
  assert.equal(fs.existsSync(subject.statePath), false);
});

test("registration rejects missing flags, arbitrary addresses, forged identities and caller allowlists without state writes", async (context) => {
  const subject = fixture(context);
  const invalid = [
    { capture_owner_events: false }, { capture_owner_events: undefined }, { reply_delivery: "wake" },
    { reply_delivery: undefined }, { window_capture: false }, { window_capture: undefined },
    { expected_generation: undefined }, { expected_generation: -1 }, { expected_generation: "0" },
    { dedupe_key: "" }, { target_key: "arbitrary-qq" }, { target_key: OWNER },
    { owner_sender_allowlist: ["1999000099"] }, { sender_id: "1999000099" }, { qq: "1999000099" },
    { window_binding: { ...windowBinding(), owner_key: "forged-owner" } },
    { window_binding: { ...windowBinding(), generation: 0 } },
    { window_binding: { ...windowBinding(), target: { ...windowBinding().target, binding_generation: 0 } } },
    { window_binding: { ...windowBinding(), target: { ...windowBinding().target, adapter_id: "unaccepted-seventh-field" } } },
    { window_binding: { ...windowBinding(), target: { ...windowBinding().target, conversation_id: "*" } } },
  ];
  for (const input of invalid) {
    await assert.rejects(subject.register(input));
    assert.equal(fs.existsSync(subject.statePath), false);
  }
  assert.equal(subject.reads.length, 0);
});

test("unknown registration is queried read-only by the original key and identical requests are idempotent after reload", async (context) => {
  const subject = fixture(context);
  const opened = await subject.register();
  const originalBytes = fs.readFileSync(subject.statePath);
  const originalReads = subject.reads.length;
  const reloaded = subject.reload();
  assert.deepEqual(subject.get({ dedupe_key: "register-1" }, reloaded.control).registration, opened.registration);
  assert.equal(subject.get({ dedupe_key: "never-recorded" }).registration, null);
  const duplicate = await subject.register({}, reloaded.control);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.registration.applied_generation, 1);
  assert.equal(subject.reads.length, originalReads);
  assert.deepEqual(fs.readFileSync(subject.statePath), originalBytes);
  await assert.rejects(subject.register({ window_binding: windowBinding(2, "model-b") }), { code: "OWNER_WINDOW_DEDUPE_CONFLICT" });
  assert.deepEqual(fs.readFileSync(subject.statePath), originalBytes);
});

test("get and event read are side-effect free including invalid scope and limits", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1);
  await subject.control.scanOwnerReplies();
  const before = fs.readFileSync(subject.statePath);
  const reads = subject.reads.length;
  assert.deepEqual(subject.read(), subject.read());
  subject.get();
  for (const input of [{ conversation_id: "foreign-component" }, { route_key: "foreign-route" },
    { expected_route_generation: 2 }, { expected_route_generation: "1" }, { limit: 0 }, { limit: 51 },
    { limit: 1.5 }, { cursor: "not-json" }, { cursor: "" }]) assert.throws(() => subject.read(input));
  assert.throws(() => subject.get({ conversation_id: "foreign-component" }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.reads.length, reads);
  assert.equal(subject.wakes.length, 0);
  assert.equal(fs.existsSync(`${subject.statePath}.lock`), false);
});

test("pagination is independently scoped, persists across reload, and tail cursors continue polling", async (context) => {
  const subject = fixture(context);
  await subject.register();
  for (const sequence of [1, 2, 3]) subject.message(sequence);
  await subject.control.scanOwnerReplies();
  const first = subject.read({ limit: 1 });
  assert.equal(first.partial, true);
  const reloaded = subject.reload();
  const rest = subject.read({ cursor: first.next_cursor, limit: 2 }, reloaded.control);
  assert.deepEqual(rest.events.map((event) => event.message_seq), [2, 3]);
  assert.equal(rest.partial, false);
  assert.ok(rest.next_cursor);
  assert.deepEqual(subject.read({ cursor: rest.next_cursor }).events, []);
  subject.message(4);
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read({ cursor: rest.next_cursor }).events.map((event) => event.message_seq), [4]);
  const tampered = JSON.parse(Buffer.from(first.next_cursor, "base64url").toString("utf8"));
  tampered[1] = "other-route";
  assert.throws(() => subject.read({ cursor: Buffer.from(JSON.stringify(tampered)).toString("base64url") }), { code: "OWNER_WINDOW_CURSOR_SCOPE_MISMATCH" });
  assert.deepEqual(rest.source, { mode: "recent_history", max_messages_per_poll: 50, continuity: "not_guaranteed" });
});

test("same native message dedupes across changed sequence, repeated scans, reload and model rebind", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1);
  await subject.control.scanOwnerReplies();
  const first = subject.read().events[0];
  subject.message(2, { messageId: "1001" });
  await subject.control.scanOwnerReplies();
  const reloaded = subject.reload();
  await subject.register({ expected_generation: 1, dedupe_key: "bind-model-b", window_binding: windowBinding(2, "model-b") }, reloaded.control);
  await reloaded.control.scanOwnerReplies();
  subject.message(3);
  await reloaded.control.scanOwnerReplies();
  const events = subject.read({ expected_route_generation: 2 }, reloaded.control).events;
  assert.deepEqual(events.map((event) => event.message_seq), [1, 3]);
  assert.deepEqual(events.map((event) => event.route_generation), [1, 2]);
  assert.deepEqual(events[0], first);
  assert.deepEqual(events[1].window_binding, windowBinding(2, "model-b"));
  assert.equal(subject.reads.filter((input) => !input.include_owner_event_content).length, 1);
});

test("message sequences are native identities rather than numeric progress watermarks", async (context) => {
  const subject = fixture(context);
  await subject.register();
  for (const sequence of [900, 7, 500]) subject.message(sequence);
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [900, 7, 500]);
  assert.equal(subject.state.getOwnerRoute("window-route").lastInboundMessageSeq, 500);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.read().events.length, 3);
});

test("rebind invalidates old provider generation/cursor and stale CAS cannot replace the frozen target", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1);
  await subject.control.scanOwnerReplies();
  const cursor = subject.read().next_cursor;
  await subject.register({ expected_generation: 1, dedupe_key: "bind-model-b", window_binding: windowBinding(2, "model-b") });
  assert.throws(() => subject.read(), { code: "OWNER_WINDOW_GENERATION_MISMATCH" });
  assert.throws(() => subject.read({ expected_route_generation: 2, cursor }), { code: "OWNER_WINDOW_CURSOR_SCOPE_MISMATCH" });
  const before = fs.readFileSync(subject.statePath);
  await assert.rejects(subject.register({ expected_generation: 1, dedupe_key: "stale-bind", window_binding: windowBinding(3, "model-c") }), { code: "OWNER_WINDOW_GENERATION_MISMATCH" });
  await assert.rejects(subject.register({ expected_generation: 2, dedupe_key: "stale-core", window_binding: windowBinding(2, "model-c") }), { code: "OWNER_WINDOW_BINDING_GENERATION_MISMATCH" });
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.deepEqual(subject.read({ expected_route_generation: 2 }).events[0].window_binding, windowBinding());
});

test("only one window route owns an actual target, including differently named aliases", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.configuration.targets.alias = { type: "private", id: OWNER };
  subject.histories.set("alias", []);
  await assert.rejects(subject.register({ route_key: "competing-route", dedupe_key: "alias-route", target_key: "alias" }), { code: "OWNER_WINDOW_ROUTE_CONFLICT" });
  await assert.rejects(subject.register({ conversation_id: "other-core" }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  assert.equal(subject.state.listOwnerRoutes().length, 1);
});

for (const mode of ["legacy", "events_only"]) {
  test(`old ${mode} quoted alerts retain priority when their route is open or closed`, async (context) => {
    const subject = fixture(context);
    await subject.control.registerOwnerRoute({ route_key: "quote-route", conversation_id: "quote-model", target_key: "owner-private",
      capture_owner_events: true, ...(mode === "events_only" ? { reply_delivery: "events_only" } : {}) });
    subject.state.recordOwnerAlertMessage({ messageId: "500", routeKey: "quote-route", targetKey: "owner-private" });
    await subject.register();
    subject.message(1, { replyMessageId: "500" });
    subject.message(2);
    const beforeReads = subject.reads.length;
    await subject.control.scanOwnerReplies();
    assert.equal(subject.reads.length - beforeReads, 1);
    assert.deepEqual(subject.read().events.map((event) => event.message_seq), [2]);
    assert.deepEqual(subject.control.readOwnerEvents({ route_key: "quote-route", conversation_id: "quote-model",
      original_qq_message_id: "500", expected_route_generation: 1 }).events.map((event) => event.message_seq), [1]);
    assert.equal(subject.wakes.length, mode === "legacy" ? 1 : 0);
    subject.control.closeOwnerRoute({ route_key: "quote-route" });
    subject.message(3, { replyMessageId: "500" });
    await subject.control.scanOwnerReplies();
    assert.deepEqual(subject.read().events.map((event) => event.message_seq), [2]);
    await subject.control.registerOwnerRoute({ route_key: "quote-route", conversation_id: "quote-model", target_key: "owner-private" });
    subject.message(4, { replyMessageId: "500" });
    await subject.control.scanOwnerReplies();
    assert.deepEqual(subject.read().events.map((event) => event.message_seq), [2]);
    if (mode === "legacy") assert.ok(subject.wakes.every((wake) => wake.generation === 1 && wake.threadId === "quote-model"));
  });
}

test("unrecognized quotes may enter the default route but known alerts from another target never do", async (context) => {
  const subject = fixture(context);
  await subject.control.registerOwnerRoute({ route_key: "group-quote", conversation_id: "quote-model", target_key: "owner-group" });
  subject.state.recordOwnerAlertMessage({ messageId: "500", routeKey: "group-quote", targetKey: "owner-group" });
  await subject.register();
  subject.message(1, { replyMessageId: "500" });
  subject.message(2, { replyMessageId: "unknown-external-notice" });
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [2]);
});

test("legacy mutation and notification tools cannot bypass window CAS or change its stable holder", async (context) => {
  const subject = fixture(context);
  await subject.register();
  const before = fs.readFileSync(subject.statePath);
  await assert.rejects(subject.control.registerOwnerRoute({ route_key: "window-route", conversation_id: "stable-core-component", target_key: "owner-private" }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  assert.throws(() => subject.control.closeOwnerRoute({ route_key: "window-route" }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  await assert.rejects(subject.control.sendOwnerAlert({ route_key: "window-route", summary: "must not send", dedupe_key: "no-send" }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  assert.throws(() => subject.state.enableOwnerReplyEvents("window-route"), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  assert.throws(() => subject.close({ conversation_id: "other-core" }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  assert.throws(() => subject.close({ expected_generation: 2 }), { code: "OWNER_WINDOW_GENERATION_MISMATCH" });
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.wakes.length, 0);
});

test("closing and unknown old registration retries never reopen, while a fresh CAS reopens with a new baseline", async (context) => {
  const subject = fixture(context);
  await subject.register();
  const closed = subject.close();
  assert.equal(closed.route.route_generation, 2);
  assert.equal(closed.route.status, "closed");
  assert.throws(() => subject.read({ expected_route_generation: 2 }), { code: "OWNER_WINDOW_SCOPE_MISMATCH" });
  const beforeReads = subject.reads.length;
  const originalRetry = await subject.register();
  assert.equal(originalRetry.duplicate, true);
  assert.equal(originalRetry.route.status, "closed");
  assert.equal(originalRetry.registration.applied_generation, 1);
  assert.equal(subject.reads.length, beforeReads);
  subject.message(1);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.reads.length, beforeReads);
  await subject.register({ expected_generation: 2, dedupe_key: "reopen" });
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read({ expected_route_generation: 3 }).events, []);
});

test("a regressed clock cannot commit an invalid closed route or advance its generation", async (context) => {
  const subject = fixture(context);
  await subject.register();
  const before = fs.readFileSync(subject.statePath);
  subject.state.now = () => new Date("2026-11-15T00:00:00.000Z");
  assert.throws(() => subject.close(), { code: "OWNER_WINDOW_INVALID_ARGUMENT" });
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.get().route.route_generation, 1);
  assert.equal(subject.get().route.status, "open");
});

for (const missing of ["native-content", "message-id", "message-seq", "empty-message-seq", "boolean-message-seq", "over-limit"]) {
  test(`${missing} is explicitly unavailable and does not become a shortened preview or legacy wake`, async (context) => {
    const subject = fixture(context);
    await subject.register();
    const input = missing === "native-content" ? { ownerEventContent: undefined }
      : missing === "message-id" ? { messageId: undefined }
        : missing === "message-seq" ? { messageSeq: undefined }
          : missing === "empty-message-seq" ? { messageSeq: " " }
            : missing === "boolean-message-seq" ? { messageSeq: true }
              : { ownerEventContent: { text: "原".repeat(OWNER_WINDOW_EVENT_LIMITS.cacheBytes) } };
    subject.message(1, input);
    await subject.control.scanOwnerReplies();
    assert.throws(() => subject.read(), { code: "OWNER_WINDOW_CONTENT_UNAVAILABLE" });
    const reloaded = subject.reload();
    await reloaded.control.scanOwnerReplies();
    assert.equal(reloaded.state.getOwnerRoute("window-route").ownerWindowEventCounter, 1);
    assert.equal(subject.wakes.length, 0);
    assert.ok(fs.statSync(subject.statePath).size < 16384);
  });
}

test("event retention and expired cursors report gaps without replaying the still-observed fifty messages", async (context) => {
  const subject = fixture(context, { maxSeen: 2 });
  await subject.register();
  subject.message(1);
  await subject.control.scanOwnerReplies();
  const cursor = subject.read().next_cursor;
  subject.message(2);
  subject.message(3);
  await subject.control.scanOwnerReplies();
  assert.throws(() => subject.read(), { code: "OWNER_WINDOW_HISTORY_EXPIRED" });
  assert.throws(() => subject.read({ cursor }), { code: "OWNER_WINDOW_CURSOR_EXPIRED" });
  const before = fs.readFileSync(subject.statePath);
  await subject.reload().control.scanOwnerReplies();
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.deepEqual(subject.state.getOwnerRoute("window-route").ownerWindowEvents.map((event) => event.message_seq), [2, 3]);
});

test("aggregate native content eviction is bounded at one MiB and retains explicit source/cursor limits", async (context) => {
  const subject = fixture(context);
  await subject.register();
  const body = "x".repeat(400000);
  for (const sequence of [1, 2]) subject.message(sequence, { ownerEventContent: { text: body } });
  await subject.control.scanOwnerReplies();
  const first = subject.read({ limit: 1 });
  subject.message(3, { ownerEventContent: { text: body } });
  await subject.control.scanOwnerReplies();
  assert.throws(() => subject.read(), { code: "OWNER_WINDOW_HISTORY_EXPIRED" });
  assert.throws(() => subject.read({ cursor: first.next_cursor }), { code: "OWNER_WINDOW_CURSOR_EXPIRED" });
  const retained = subject.state.getOwnerRoute("window-route");
  assert.deepEqual(retained.ownerWindowEvents.map((event) => event.message_seq), [2, 3]);
  assert.ok(Buffer.byteLength(JSON.stringify(retained.ownerWindowEvents)) <= OWNER_WINDOW_EVENT_LIMITS.cacheBytes);
  const before = fs.readFileSync(subject.statePath);
  await subject.control.scanOwnerReplies();
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
});

test("one atomic capture failure leaves event and dedupe absent and a reload retry captures exactly once", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1);
  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = (descriptor) => {
    const stats = fs.fstatSync(descriptor);
    if (!failed && stats.size > 1000) {
      failed = true;
      throw Object.assign(new Error("isolated window state fsync failure"), { code: "EIO" });
    }
    return originalFsync(descriptor);
  };
  let scan;
  try { scan = await subject.control.scanOwnerReplies(); } finally { fs.fsyncSync = originalFsync; }
  assert.equal(failed, true);
  assert.equal(scan.results[0].error.code, "STATE_WRITE_FAILED");
  assert.equal(subject.state.getOwnerRoute("window-route").ownerWindowEventCounter, 0);
  assert.deepEqual(subject.state.getOwnerRoute("window-route").windowSeenMessageKeys, []);
  assert.equal(fs.existsSync(`${subject.statePath}.lock`), false);
  const reloaded = subject.reload();
  await reloaded.control.scanOwnerReplies();
  await reloaded.control.scanOwnerReplies();
  assert.deepEqual(subject.read({}, reloaded.control).events.map((event) => event.message_seq), [1]);
});

test("provider route generation CAS guards a scan that was in flight during model rebind", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1);
  const originalRead = subject.notifier.readConfiguredTargetMessages;
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  subject.notifier.readConfiguredTargetMessages = async (input) => {
    const history = await originalRead(input);
    entered();
    await new Promise((resolve) => { release = resolve; });
    return history;
  };
  const pending = subject.control.scanOwnerReplies();
  await ready;
  await subject.register({ expected_generation: 1, dedupe_key: "bind-in-flight", window_binding: windowBinding(2, "model-b") });
  release();
  const scanned = await pending;
  assert.equal(scanned.results[0].error.code, "OWNER_WINDOW_GENERATION_MISMATCH");
  subject.notifier.readConfiguredTargetMessages = originalRead;
  await subject.control.scanOwnerReplies();
  const page = subject.read({ expected_route_generation: 2 });
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0].window_binding, windowBinding(2, "model-b"));
});

test("two simultaneous worker state writers compare and swap under the existing file lock", async (context) => {
  const subject = fixture(context);
  const gate = new SharedArrayBuffer(4);
  const stateUrl = new URL("../src/control-state.mjs", import.meta.url).href;
  const workers = ["cas-a", "cas-b"].map((dedupeKey) => new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { createControlState } = await import(workerData.stateUrl);
      const state = createControlState({ statePath: workerData.statePath });
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try { parentPort.postMessage({ result: state.registerOwnerWindowRoute(workerData.input) }); }
      catch (error) { parentPort.postMessage({ code: error.code }); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { stateUrl, statePath: subject.statePath, gate, input: {
    routeKey: "window-route", conversationId: "stable-core-component", targetKey: "owner-private",
    expectedGeneration: 0, dedupeKey, windowBinding: windowBinding(), baselineMessageKeys: [],
    windowTarget: { type: "private", id: OWNER }, windowSelfId: SELF, windowOwnerSenderAllowlist: [OWNER],
  } } }));
  subject.cleanups.push(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  const ready = workers.map((worker) => new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (message) => { assert.equal(message.ready, true); resolve(); });
  }));
  const results = workers.map((worker) => new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("message", (message) => { if (!message.ready) resolve(message); });
  }));
  await Promise.all(ready);
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, 2);
  const values = await Promise.all(results);
  assert.equal(values.filter((value) => value.result?.ok).length, 1);
  assert.deepEqual(values.filter((value) => value.code).map((value) => value.code), ["OWNER_WINDOW_GENERATION_MISMATCH"]);
  assert.equal(subject.get().route.route_generation, 1);
  assert.equal(subject.state.getOwnerRoute("window-route").windowRegistrationReceipts.length, 1);
  assert.equal(fs.existsSync(`${subject.statePath}.lock`), false);
});

test("registration atomic write failure preserves the original state and original request can safely recover", async (context) => {
  const subject = fixture(context);
  await subject.control.registerOwnerRoute({ route_key: "existing-quote", conversation_id: "quote-holder", target_key: "owner-private" });
  const before = fs.readFileSync(subject.statePath);
  const originalFsync = fs.fsyncSync;
  let failed = false;
  fs.fsyncSync = (descriptor) => {
    if (!failed && fs.fstatSync(descriptor).size > 1000) {
      failed = true;
      throw Object.assign(new Error("isolated registration fsync EIO"), { code: "EIO" });
    }
    return originalFsync(descriptor);
  };
  try { await assert.rejects(subject.register(), { code: "STATE_WRITE_FAILED" }); } finally { fs.fsyncSync = originalFsync; }
  assert.equal(failed, true);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.state.getOwnerRoute("window-route"), null);
  assert.equal(fs.existsSync(`${subject.statePath}.lock`), false);
  const recovered = await subject.register();
  assert.equal(recovered.registration.dedupe_key, "register-1");
  assert.equal(recovered.route.route_generation, 1);
});

test("changed or removed private trust denies both subsequent group capture and cached reads", async (context) => {
  const subject = fixture(context);
  await subject.register({ target_key: "owner-group" });
  subject.message(1, { mentionedUserIds: [SELF] }, "owner-group");
  await subject.control.scanOwnerReplies();
  assert.equal(subject.read().events.length, 1);
  delete subject.configuration.targets["owner-private"];
  subject.message(2, { mentionedUserIds: [SELF] }, "owner-group");
  const scanned = await subject.control.scanOwnerReplies();
  assert.equal(scanned.results[0].error.code, "OWNER_WINDOW_TRUST_UNAVAILABLE");
  assert.throws(() => subject.read(), { code: "OWNER_WINDOW_TRUST_UNAVAILABLE" });
  assert.equal(subject.state.getOwnerRoute("window-route").ownerWindowEventCounter, 1);
  subject.configuration.targets["owner-private"] = { type: "private", id: "1999000099" };
  assert.throws(() => subject.read(), { code: "OWNER_WINDOW_TRUST_CHANGED" });
  subject.configuration.enabled = false;
  assert.throws(() => subject.read(), { code: "OWNER_WINDOW_UNSUPPORTED" });
  assert.equal((await subject.control.scanOwnerReplies()).enabled, false);
  assert.equal(subject.wakes.length, 0);
});

test("malformed native state is rejected on reload rather than converted into an owner event", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.message(1);
  await subject.control.scanOwnerReplies();
  const original = fs.readFileSync(subject.statePath);
  const corruptions = [
    (route) => { route.ownerWindowEvents[0].sequence = 2; },
    (route) => { route.ownerWindowEvents[0].sender_id = "1999000099"; },
    (route) => { route.ownerWindowEvents[0].window_binding.owner_key = "forged"; },
    (route) => { route.ownerWindowEvents[0].route_generation = 2; },
    (route) => { route.ownerWindowEvents[0].window.id = "1999000099"; },
    (route) => { route.ownerWindowEventCounter = 10; },
  ];
  for (const corrupt of corruptions) {
    const state = JSON.parse(original);
    corrupt(state.ownerRoutes["window-route"]);
    fs.writeFileSync(subject.statePath, JSON.stringify(state));
    assert.throws(() => subject.reload().control.readOwnerWindowEvents({ route_key: "window-route",
      conversation_id: "stable-core-component", expected_route_generation: 1 }));
  }
  fs.writeFileSync(subject.statePath, original);
  assert.equal(subject.read().events.length, 1);
});

async function nativeFixture(context) {
  const subject = fixture(context);
  const nativeHistory = new Map([["private", []], ["group", []]]);
  const calls = [];
  const unexpected = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const action = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    calls.push({ action, input });
    const actions = {
      get_status: { online: true, good: true },
      get_login_info: { user_id: SELF, nickname: "SyntheticWindowBot" },
      get_friend_list: [{ user_id: OWNER, nickname: "SyntheticOwner" }],
      get_group_info: { group_id: GROUP, group_name: "SyntheticOwnerGroup", member_count: 3 },
      get_friend_msg_history: { messages: nativeHistory.get("private").slice(-50) },
      get_group_msg_history: { messages: nativeHistory.get("group").slice(-50) },
    };
    if (!Object.hasOwn(actions, action)) unexpected.push(action);
    response.writeHead(Object.hasOwn(actions, action) ? 200 : 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify(Object.hasOwn(actions, action) ? { status: "ok", retcode: 0, data: actions[action] }
      : { status: "failed", retcode: 1, wording: "synthetic read-only OneBot endpoints only" }));
  });
  subject.cleanups.push(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(unexpected, []);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bindingPath = path.join(subject.root, "synthetic-binding.json");
  const binding = {
    schemaVersion: 2, bindingName: "synthetic-window-only", expectedSelfId: SELF, expectedNickname: "SyntheticWindowBot",
    groupId: "123456789", groupName: "UnusedSyntheticTrainingGroup", expectedMemberCount: 4,
    allowedEvents: ["test"], minimumHeartbeatMinutes: 5, dedupeRetentionDays: 30,
    requireGroupIdentityCheckBeforeSend: true, requireMessageVerification: true,
    controlPlane: { enabled: true, localMachine: "development", defaultTargetKey: "owner-private", targets: {
      "owner-private": { type: "private", id: OWNER, name: "SyntheticOwner" },
      "owner-group": { type: "group", id: GROUP, name: "SyntheticOwnerGroup", expectedMemberCount: 3 },
    } },
  };
  fs.writeFileSync(bindingPath, JSON.stringify(binding), "utf8");
  const env = {
    USERPROFILE: subject.root, NAPCAT_HTTP_URL: `http://127.0.0.1:${server.address().port}`,
    NAPCAT_ACCESS_TOKEN: "synthetic-loopback-only-token", NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(subject.root, "unused-send-state.json"), NAPCAT_HTTP_TIMEOUT_MS: "2000",
  };
  const notifier = createNapCatNotifier({ cwd: subject.root, now: subject.now, env });
  const control = createControlPlane({ notifier, state: subject.state, bridge: subject.bridge, now: subject.now });
  return {
    ...subject, control, notifier, calls, binding, bindingPath, env, nativeHistory,
    register: (input = {}) => control.registerOwnerWindowRoute(registration(input)),
    read: (input = {}) => subject.read(input, control),
    get: (input = {}) => subject.get(input, control),
    nativeMessage(sequence, text, windowType = "private", overrides = {}) {
      nativeHistory.get(windowType).push({
        message_id: String(1000 + sequence), message_seq: String(sequence), time: 1794780000 + sequence,
        user_id: OWNER, sender: { user_id: OWNER, nickname: "SyntheticOwner" },
        message: [...(windowType === "group" ? [{ type: "at", data: { qq: SELF } }] : []), { type: "text", data: { text } }],
        raw_message: `${windowType === "group" ? `[CQ:at,qq=${SELF}]` : ""}${text}`, ...overrides,
      });
    },
  };
}

test("native private OneBot reads retain full text while window get/read perform zero HTTP or state writes", async (context) => {
  const subject = await nativeFixture(context);
  assert.equal(subject.notifier.getControlPlaneConfig().targets["owner-private"].id, undefined);
  await subject.register();
  const text = `${"完整原生正文".repeat(600)}NATIVE_END`;
  subject.nativeMessage(7, text);
  await subject.control.scanOwnerReplies();
  const before = fs.readFileSync(subject.statePath);
  const callCount = subject.calls.length;
  const event = subject.read().events[0];
  assert.equal(event.text, text);
  assert.equal(event.content, text);
  assert.ok(event.text.length > 2000);
  subject.get({ dedupe_key: "register-1" });
  assert.equal(subject.calls.length, callCount);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.calls.filter((call) => call.action === "get_friend_msg_history").length, 2);
  assert.ok(subject.calls.filter((call) => call.action.endsWith("msg_history")).every((call) => call.input.count === 50));
  assert.equal(subject.wakes.length, 0);
  assert.equal(fs.existsSync(subject.env.NAPCAT_MCP_STATE_PATH), false);
});

test("native group trust is derived from private binding without reading private history or accepting ordinary members", async (context) => {
  const subject = await nativeFixture(context);
  await subject.register({ target_key: "owner-group" });
  subject.nativeMessage(1, "human group message", "group");
  subject.nativeMessage(2, "ordinary member", "group", { user_id: "1999000099", sender: { user_id: "1999000099" } });
  subject.nativeMessage(3, "missing mention", "group", { raw_message: "missing mention", message: [{ type: "text", data: { text: "missing mention" } }] });
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [1]);
  assert.ok(subject.calls.every((call) => call.action !== "get_friend_msg_history" && call.action !== "get_friend_list"));
  assert.equal(subject.calls.filter((call) => call.action === "get_group_msg_history").length, 2);
  assert.equal(subject.wakes.length, 0);
});

test("native media-only messages enter as events immediately and retain the full readable CQ content", async (context) => {
  const subject = await nativeFixture(context);
  await subject.register();
  const content = "[CQ:image,file=synthetic-image.png]";
  subject.nativeMessage(1, "", "private", { message: [{ type: "image", data: { file: "synthetic-image.png" } }], raw_message: content });
  await subject.control.scanOwnerReplies();
  assert.equal(subject.read().events[0].content, content);
  assert.deepEqual(subject.state.listOwnerRouteBufferedMessages("window-route"), []);
  assert.equal(subject.wakes.length, 0);
});

async function stdioClient(context, subject) {
  const entry = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const sdkCandidates = [process.env.MCP_SDK_ROOT,
    fileURLToPath(new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm", import.meta.url)),
    path.join(process.env.USERPROFILE || os.homedir(), ".gemini", "antigravity", "mcp-memory-store",
      "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm")].filter(Boolean);
  const sdkRoot = sdkCandidates.find((candidate) => fs.existsSync(path.join(candidate, "server", "index.js")));
  assert.ok(sdkRoot, "isolated MCP test requires the existing SDK without installing dependencies");
  const child = spawn(process.execPath, [entry], { cwd: subject.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...subject.env, MCP_SDK_ROOT: sdkRoot,
      NAPCAT_TASK_REGISTRY_PATH: path.join(subject.root, "unused-task-registry.json"),
      NAPCAT_CONTROL_STATE_PATH: subject.statePath,
    } });
  let buffer = "";
  let stderr = "";
  let requestId = 0;
  const pending = new Map();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    }
  });
  child.on("error", (error) => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } });
  child.on("exit", () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`isolated MCP exited: ${stderr}`)); }
  });
  subject.cleanups.push(async () => { child.stdin.end(); if (child.exitCode === null) child.kill(); await exited; });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`isolated MCP timeout: ${method}; ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "synthetic-window-test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { request };
}

test("actual isolated MCP stdio exposes exact new schemas and dispatches read/get without starting a scanner", async (context) => {
  const subject = await nativeFixture(context);
  await subject.register();
  subject.nativeMessage(1, "stdio-readable native message");
  await subject.control.scanOwnerReplies();
  const before = fs.readFileSync(subject.statePath);
  const beforeCalls = subject.calls.length;
  const client = await stdioClient(context, subject);
  const listed = await client.request("tools/list", {});
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const register = tools.get("napcat_owner_window_route_register");
  assert.equal(register.inputSchema.additionalProperties, false);
  assert.equal(register.inputSchema.properties.window_capture.const, true);
  assert.equal(register.inputSchema.properties.reply_delivery.const, "events_only");
  assert.equal(register.inputSchema.properties.window_binding.properties.target.required.length, 6);
  assert.ok(register.inputSchema.required.includes("dedupe_key"));
  assert.equal(Object.hasOwn(register.inputSchema.properties, "owner_sender_allowlist"), false);
  const readTool = tools.get("napcat_owner_window_events_read");
  assert.equal(readTool.inputSchema.properties.limit.maximum, 50);
  assert.equal(Object.hasOwn(readTool.inputSchema.properties, "original_qq_message_id"), false);
  assert.equal(readTool.annotations.readOnlyHint, true);
  assert.ok(tools.get("napcat_owner_events_read").inputSchema.required.includes("original_qq_message_id"));
  assert.equal(Object.hasOwn(tools.get("napcat_owner_route_register").inputSchema.properties, "window_capture"), false);
  const getResult = await client.request("tools/call", { name: "napcat_owner_window_route_get", arguments: {
    route_key: "window-route", conversation_id: "stable-core-component", dedupe_key: "register-1",
  } });
  assert.equal(JSON.parse(getResult.content[0].text).registration.applied_generation, 1);
  const readResult = await client.request("tools/call", { name: "napcat_owner_window_events_read", arguments: {
    route_key: "window-route", conversation_id: "stable-core-component", expected_route_generation: 1,
  } });
  assert.equal(JSON.parse(readResult.content[0].text).events[0].text, "stdio-readable native message");
  const denied = await client.request("tools/call", { name: "napcat_owner_window_events_read", arguments: {
    route_key: "window-route", conversation_id: "foreign-core", expected_route_generation: 1,
  } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).code, "OWNER_WINDOW_SCOPE_MISMATCH");
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.calls.length, beforeCalls);
  assert.equal(fs.existsSync(path.join(subject.root, "unused-task-registry.json")), false);
  assert.equal(fs.existsSync(path.join(subject.root, "state", "task-router.pid")), false);
});
