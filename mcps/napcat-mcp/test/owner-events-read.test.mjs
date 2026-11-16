import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlState } from "../src/control-state.mjs";
import { createControlPlane } from "../src/control-plane.mjs";
import { OWNER_REPLY_EVENT_LIMITS } from "../src/owner-reply-events.mjs";

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-owner-events-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, "control-state.json");
  const state = createControlState({ statePath, maxSeen: options.maxSeen ?? 2048 });
  const history = [];
  const wakes = [];
  let historyReads = 0;
  let nextMessageId = 500;
  const configuration = {
    enabled: true,
    localMachine: "development",
    expectedSelfId: "1000000001",
    defaultTargetKey: "owner-private",
    targets: { "owner-private": { type: "private", id: "1999000001" } },
  };
  const notifier = {
    getControlPlaneConfig: () => configuration,
    readConfiguredTargetMessages: async () => {
      historyReads += 1;
      return { target: configuration.targets["owner-private"], messages: structuredClone(history).map((message) => ({
        ...message, ownerEventContent: { text: message.text },
      })) };
    },
    sendConfiguredMessage: async () => ({ sent: true, verified: true, messageId: nextMessageId++ }),
  };
  const control = createControlPlane({ notifier, state, bridge: { wake: async (input) => {
    wakes.push(structuredClone(input));
    return { outcome: "accepted", started: true, turn: { id: `turn-${wakes.length}` } };
  } } });
  return {
    root, statePath, state, control, history, wakes, configuration,
    historyReads: () => historyReads,
    open: (capture = true) => control.registerOwnerRoute({
      route_key: "test-route", conversation_id: "test-chat", target_key: "owner-private",
      ...(capture ? { capture_owner_events: true } : {}),
    }),
    alert: () => control.sendOwnerAlert({ route_key: "test-route", summary: "test notice", dedupe_key: `notice-${nextMessageId}` }),
    read: (overrides = {}) => control.readOwnerEvents({
      route_key: "test-route", conversation_id: "test-chat", original_qq_message_id: "500", expected_route_generation: 1, ...overrides,
    }),
    reply: (messageSeq, overrides = {}) => history.push({
      messageId: String(1000 + messageSeq), messageSeq, senderId: "1999000001", isSelf: false,
      replyMessageId: "500", text: `reply ${messageSeq}`, time: "2026-11-15T00:00:00.000Z",
      mentionedUserIds: [], contentTypes: ["text"], attachments: [], ...overrides,
    }),
  };
}

test("owner event capture is explicit and leaves the old wake unchanged", async (context) => {
  const subject = fixture(context);
  await subject.open(false);
  await subject.alert();
  subject.reply(1);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 1);
  assert.equal(subject.wakes[0].generation, 1);
  assert.equal(subject.state.getOwnerRoute("test-route").ownerEventGeneration, undefined);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_UNSUPPORTED" });
});

test("real scanner persists exact native fields after old delivery and read is side-effect free", async (context) => {
  const subject = fixture(context);
  const registered = await subject.open();
  assert.equal(registered.ownerEventGeneration, 1);
  await subject.alert();
  subject.reply(7, { text: "actual quoted reply" });
  await subject.control.scanOwnerReplies();
  const before = fs.readFileSync(subject.statePath);
  const historyReads = subject.historyReads();
  const page = subject.read();
  assert.equal(page.ok, true);
  assert.deepEqual(page.route, { route_key: "test-route", conversation_id: "test-chat", target_key: "owner-private", generation: 1 });
  assert.deepEqual(page.events, [{
    event_id: page.events[0].event_id, message_id: "1007", message_seq: 7,
    quoted_message_id: "500", sender_id: "1999000001", text: "actual quoted reply",
  }]);
  assert.equal(page.partial, false);
  assert.equal(page.next_cursor, null);
  assert.equal(subject.historyReads(), historyReads);
  assert.equal(subject.wakes.length, 1);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.state.listOwnerRouteBufferedMessages("test-route").length, 0);
  assert.deepEqual(subject.read(), page);
});

test("route, conversation, original notice and actual generation are required", async (context) => {
  const subject = fixture(context);
  await subject.open();
  await subject.alert();
  for (const [input, code] of [
    [{ route_key: "other-route" }, "OWNER_EVENTS_SCOPE_MISMATCH"],
    [{ conversation_id: "other-chat" }, "OWNER_EVENTS_SCOPE_MISMATCH"],
    [{ original_qq_message_id: "501" }, "OWNER_EVENTS_ORIGINAL_MISMATCH"],
    [{ expected_route_generation: 2 }, "OWNER_EVENTS_GENERATION_MISMATCH"],
  ]) assert.throws(() => subject.read(input), { code });
});

test("pagination survives state reload and cursor cannot cross original notifications", async (context) => {
  const subject = fixture(context);
  await subject.open();
  await subject.alert();
  subject.reply(1);
  subject.reply(2);
  await subject.control.scanOwnerReplies();
  const first = subject.read({ limit: 1 });
  assert.equal(first.partial, true);
  const reloaded = createControlState({ statePath: subject.statePath });
  const second = reloaded.readOwnerReplyEvents({
    routeKey: "test-route", conversationId: "test-chat", originalMessageId: "500", expectedGeneration: 1,
    cursor: first.next_cursor, limit: 1,
  });
  assert.equal(second.events[0].message_seq, 2);
  assert.equal(second.partial, false);
  await subject.alert();
  assert.throws(() => subject.read({ original_qq_message_id: "501", cursor: first.next_cursor }), { code: "OWNER_EVENTS_CURSOR_SCOPE_MISMATCH" });
  assert.throws(() => subject.read({ cursor: "not-json" }), { code: "OWNER_EVENTS_CURSOR_INVALID" });
});

test("reopen changes the persisted event generation but never changes legacy wake generation", async (context) => {
  const subject = fixture(context);
  await subject.open();
  await subject.alert();
  subject.control.closeOwnerRoute({ route_key: "test-route" });
  const reopened = await subject.open();
  assert.equal(reopened.ownerEventGeneration, 2);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_GENERATION_MISMATCH" });
  assert.throws(() => subject.read({ expected_route_generation: 2 }), { code: "OWNER_EVENTS_ORIGINAL_MISMATCH" });
  await subject.alert();
  subject.reply(4, { replyMessageId: "501" });
  await subject.control.scanOwnerReplies();
  assert.equal(subject.read({ original_qq_message_id: "501", expected_route_generation: 2 }).events.length, 1);
  assert.equal(subject.wakes[0].generation, 1);
});

test("old notices cannot acquire fabricated event provenance when capture is enabled later", async (context) => {
  const subject = fixture(context);
  await subject.open(false);
  await subject.alert();
  await subject.open(true);
  subject.reply(1);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 1);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_ORIGINAL_MISMATCH" });
});

test("retention is explicit and never blocks the existing message delivery", async (context) => {
  const subject = fixture(context, { maxSeen: 2 });
  await subject.open();
  await subject.alert();
  subject.reply(1);
  subject.reply(2);
  subject.reply(3);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 3);
  assert.equal(subject.state.getOwnerRoute("test-route").ownerReplyEvents.length, 2);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_HISTORY_EXPIRED" });
});

test("large text is not silently shortened or retained as an unbounded second copy", async (context) => {
  const subject = fixture(context);
  await subject.open();
  await subject.alert();
  subject.reply(1, { text: "x".repeat(OWNER_REPLY_EVENT_LIMITS.cacheBytes + 1) });
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 1);
  assert.ok(fs.statSync(subject.statePath).size < 16384);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_CONTENT_UNAVAILABLE" });
});

test("missing native identity is explicit, while optional capture failure leaves the old wake usable", async (context) => {
  const subject = fixture(context);
  await subject.open();
  await subject.alert();
  subject.reply(1, { messageId: undefined });
  await subject.control.scanOwnerReplies();
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_CONTENT_UNAVAILABLE" });
  subject.state.recordOwnerReplyEvent = () => { throw new Error("isolated cache failure"); };
  subject.reply(2);
  const result = await subject.control.scanOwnerReplies();
  assert.ok(result.results.some((entry) => entry.outcome === "owner_event_capture_failed"));
  assert.equal(subject.wakes.length, 2);
});

test("disabled channel and removed target deny cached reads", async (context) => {
  const subject = fixture(context);
  await subject.open();
  await subject.alert();
  subject.configuration.enabled = false;
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_UNSUPPORTED" });
  subject.configuration.enabled = true;
  delete subject.configuration.targets["owner-private"];
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_SCOPE_MISMATCH" });
});
