import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlState } from "../src/control-state.mjs";
import { createControlPlane } from "../src/control-plane.mjs";
import { OWNER_REPLY_EVENT_LIMITS } from "../src/owner-reply-events.mjs";

function fixture(context, options = {}) {
  const temporaryParent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, "napcat-owner-events-only-"));
  context.after(() => {
    assert.equal(path.dirname(root), temporaryParent);
    assert.ok(path.basename(root).startsWith("napcat-owner-events-only-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const statePath = path.join(root, "control-state.json");
  const now = () => new Date("2026-11-15T16:12:00.000Z");
  const histories = new Map([["owner-private", []], ["owner-other", []], ["owner-group", []]]);
  const reads = [];
  const wakes = [];
  const inspections = [];
  const configuration = {
    enabled: true,
    localMachine: "development",
    expectedSelfId: "1000000001",
    defaultTargetKey: "owner-private",
    targets: {
      "owner-private": { type: "private", id: "1999000001" },
      "owner-other": { type: "private", id: "1999000002" },
      "owner-group": { type: "group", id: "123456789" },
    },
  };
  const notifier = {
    getControlPlaneConfig: () => configuration,
    readConfiguredTargetMessages: async (input) => {
      reads.push(structuredClone(input));
      const target = configuration.targets[input.target_key];
      assert.ok(target, "only synthetic configured targets may be read");
      return { target, messages: structuredClone(histories.get(input.target_key)) };
    },
    sendConfiguredMessage: async () => assert.fail("this fixture must never send a QQ message"),
  };
  const bridge = {
    inspectWake: async (wakeId) => { inspections.push(wakeId); return null; },
    wake: async (input) => {
      wakes.push(structuredClone(input));
      return { outcome: "accepted", started: true, turn: { id: `synthetic-turn-${wakes.length}` } };
    },
  };
  const reload = () => {
    const state = createControlState({ statePath, now, maxSeen: options.maxSeen ?? 2048 });
    return { state, control: createControlPlane({ notifier, state, bridge, now }) };
  };
  const initial = reload();
  const register = (input = {}, control = initial.control) => control.registerOwnerRoute({
    route_key: "event-route", conversation_id: "event-chat", target_key: "owner-private", ...input,
  });
  const openEvents = (input = {}, control = initial.control) => register({
    capture_owner_events: true, reply_delivery: "events_only", ...input,
  }, control);
  const notice = (input = {}, state = initial.state) => state.recordOwnerAlertMessage({
    messageId: "500", routeKey: "event-route", targetKey: "owner-private", ...input,
  });
  const read = (input = {}, control = initial.control) => control.readOwnerEvents({
    route_key: "event-route", conversation_id: "event-chat", original_qq_message_id: "500",
    expected_route_generation: 1, ...input,
  });
  const reply = (sequence, input = {}, targetKey = "owner-private") => {
    const message = {
      messageId: String(1000 + sequence), messageSeq: sequence, senderId: "1999000001", isSelf: false,
      replyMessageId: "500", time: "2026-11-15T16:12:30.000Z", mentionedUserIds: [],
      text: `native reply ${sequence}`, hasExplicitText: true, contentTypes: ["text"], attachments: [], ...input,
    };
    if (!Object.hasOwn(input, "ownerEventContent")) message.ownerEventContent = { text: message.text };
    histories.get(targetKey).push(message);
    return message;
  };
  const mediaReply = (sequence, input = {}, targetKey = "owner-private") => reply(sequence, {
    text: "[CQ:reply,id=500][CQ:image,file=synthetic.png]", hasExplicitText: false, contentTypes: ["image"],
    attachments: [{ type: "image", file: "synthetic.png" }], ...input,
  }, targetKey);
  return {
    root, statePath, now, ...initial, histories, reads, wakes, inspections, configuration,
    reload, register, openEvents, notice, read, reply, mediaReply,
  };
}

async function observeStateWrites(subject, action, failAt = 0) {
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const temporaryDescriptors = new Map();
  const snapshots = [];
  let value;
  let error;
  fs.openSync = (filePath, ...openArguments) => {
    const descriptor = originalOpen(filePath, ...openArguments);
    temporaryDescriptors.delete(descriptor);
    if (typeof filePath === "string" && path.dirname(filePath) === path.dirname(subject.statePath)
      && path.basename(filePath).startsWith(`.${path.basename(subject.statePath)}.`)
      && filePath.endsWith(".tmp")) temporaryDescriptors.set(descriptor, filePath);
    return descriptor;
  };
  fs.fsyncSync = (descriptor) => {
    if (temporaryDescriptors.has(descriptor)) {
      snapshots.push(JSON.parse(fs.readFileSync(temporaryDescriptors.get(descriptor), "utf8")));
      if (snapshots.length === failAt) {
        throw Object.assign(new Error("synthetic state tempfile fsync EIO"), { code: "EIO" });
      }
    }
    return originalFsync(descriptor);
  };
  try { value = await action(); } catch (caught) { error = caught; } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }
  return { value, error, snapshots };
}

function assertNoTemporaryState(subject) {
  assert.equal(fs.existsSync(`${subject.statePath}.lock`), false);
  assert.equal(fs.readdirSync(subject.root).some((name) => name.endsWith(".tmp")), false);
}

function assertNoLegacyDelivery(subject, state = subject.state, routeKey = "event-route") {
  assert.deepEqual(subject.wakes, []);
  assert.deepEqual(subject.inspections, []);
  assert.deepEqual(state.listOwnerRouteBufferedMessages(routeKey), []);
}

test("events_only creation persists mode and capture generation in exactly one real state write", async (context) => {
  const subject = fixture(context);
  const probe = await observeStateWrites(subject, () => subject.openEvents());
  assert.ifError(probe.error);
  assert.equal(probe.snapshots.length, 1);
  const route = probe.snapshots[0].ownerRoutes["event-route"];
  assert.equal(route.replyDelivery, "events_only");
  assert.equal(route.ownerEventGeneration, 1);
  assert.equal(route.ownerReplyEventCounter, 0);
  assert.deepEqual(route.ownerReplyEvents, []);
  assert.equal(probe.value.replyDelivery, "events_only");
  assert.equal(subject.reload().state.getOwnerRoute("event-route").ownerEventGeneration, 1);
  subject.notice();
  assert.equal(subject.state.getOwnerAlertMessage("500").ownerEventGeneration, 1);
  assertNoTemporaryState(subject);
});

for (const existingFile of [false, true]) {
  test(`failed events_only creation is atomic with existing state=${existingFile}`, async (context) => {
    const subject = fixture(context);
    if (existingFile) await subject.register({ route_key: "legacy-route" });
    const before = existingFile ? fs.readFileSync(subject.statePath) : null;
    const probe = await observeStateWrites(subject, () => subject.openEvents(), 1);
    assert.equal(probe.snapshots.length, 1);
    assert.equal(probe.error?.code, "STATE_WRITE_FAILED");
    assert.equal(probe.error?.cause?.code, "EIO");
    assert.equal(subject.reload().state.getOwnerRoute("event-route"), null);
    if (existingFile) assert.deepEqual(fs.readFileSync(subject.statePath), before);
    else assert.equal(fs.existsSync(subject.statePath), false);
    assertNoTemporaryState(subject);
    const retry = await subject.openEvents();
    assert.equal(retry.replyDelivery, "events_only");
    assert.equal(retry.ownerEventGeneration, 1);
  });
}

test("invalid new registration parameters never write a state snapshot", async (context) => {
  const subject = fixture(context);
  await subject.register({ route_key: "legacy-route" });
  const before = fs.readFileSync(subject.statePath);
  const probe = await observeStateWrites(subject, async () => {
    for (const value of [false, null, undefined, 1, "", "wake", "EVENTS_ONLY", {}]) {
      await assert.rejects(() => subject.openEvents({ reply_delivery: value }), { code: "OWNER_EVENTS_INVALID_ARGUMENT" });
    }
    for (const value of [false, null, undefined, 1, "true", {}]) {
      await assert.rejects(() => subject.openEvents({ capture_owner_events: value }), { code: "OWNER_EVENTS_INVALID_ARGUMENT" });
    }
    await assert.rejects(() => subject.register({ reply_delivery: "events_only" }), { code: "OWNER_EVENTS_INVALID_ARGUMENT" });
    assert.throws(() => subject.state.openOwnerRoute({
      routeKey: "direct", conversationId: "direct-chat", targetKey: "owner-private", replyDelivery: "events_only",
    }), { code: "INVALID_ARGUMENT" });
    assert.throws(() => subject.state.openOwnerRoute({
      routeKey: "direct", conversationId: "direct-chat", targetKey: "owner-private", replyDelivery: "wake", captureOwnerEvents: true,
    }), { code: "INVALID_ARGUMENT" });
  });
  assert.ifError(probe.error);
  assert.deepEqual(probe.snapshots, []);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.state.getOwnerRoute("event-route"), null);
  assert.equal(subject.state.getOwnerRoute("direct"), null);
  assertNoTemporaryState(subject);
});

test("text and standalone media atomically capture exact events without optional capture, wake or buffering", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  subject.notice();
  const fullText = `${"完整原文".repeat(700)}NATIVE_END`;
  subject.reply(7, { text: "legacy preview", ownerEventContent: { text: fullText } });
  subject.mediaReply(8);
  subject.state.recordOwnerReplyEvent = () => assert.fail("events_only must bypass optional early capture");
  subject.state.bufferOwnerRouteMessage = () => assert.fail("events_only must bypass legacy media buffering");
  const probe = await observeStateWrites(subject, () => subject.control.scanOwnerReplies());
  assert.ifError(probe.error);
  assert.equal(probe.snapshots.length, 2);
  assert.deepEqual(probe.value.results.map((result) => result.outcome), ["owner_reply_captured", "owner_reply_captured"]);
  for (const [index, sequence] of [7, 8].entries()) {
    const snapshot = probe.snapshots[index];
    assert.ok(snapshot.seenControlMessages.includes(`owner:owner-private:${sequence}`));
    assert.ok(snapshot.ownerRoutes["event-route"].ownerReplyEvents.some((event) => event.message_seq === sequence));
    assert.deepEqual(snapshot.ownerRoutes["event-route"].bufferedOwnerMessages, []);
  }
  assert.equal(subject.reads.at(-1).include_owner_event_content, true);
  const before = fs.readFileSync(subject.statePath);
  const historyReadCount = subject.reads.length;
  const page = subject.read();
  assert.deepEqual(page.route, { route_key: "event-route", conversation_id: "event-chat", target_key: "owner-private", generation: 1 });
  assert.deepEqual(page.events, [
    { event_id: page.events[0].event_id, message_id: "1007", message_seq: 7, quoted_message_id: "500", sender_id: "1999000001", text: fullText },
    { event_id: page.events[1].event_id, message_id: "1008", message_seq: 8, quoted_message_id: "500", sender_id: "1999000001", text: "[CQ:reply,id=500][CQ:image,file=synthetic.png]" },
  ]);
  assert.equal(page.partial, false);
  assert.equal(page.next_cursor, null);
  assert.deepEqual(subject.read(), page);
  assert.equal(subject.reads.length, historyReadCount);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assertNoLegacyDelivery(subject);
});

test("two events_only routes sharing a target retain only replies to their exact original notice", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  await subject.openEvents({ route_key: "second-route", conversation_id: "second-chat" });
  subject.notice();
  subject.notice({ routeKey: "second-route", messageId: "501" });
  subject.reply(7);
  subject.reply(8, { replyMessageId: "501", text: "second origin" });
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [7]);
  assert.deepEqual(subject.read({ route_key: "second-route", conversation_id: "second-chat", original_qq_message_id: "501" }).events.map((event) => event.message_seq), [8]);
  assert.throws(() => subject.read({ original_qq_message_id: "501" }), { code: "OWNER_EVENTS_ORIGINAL_MISMATCH" });
  assert.throws(() => subject.read({ conversation_id: "second-chat" }), { code: "OWNER_EVENTS_SCOPE_MISMATCH" });
  assertNoLegacyDelivery(subject);
  assertNoLegacyDelivery(subject, subject.state, "second-route");
});

for (const contentType of ["text", "media"]) {
  test(`${contentType} event fsync failure leaves both event and seen absent, then rescans exactly once`, async (context) => {
    const subject = fixture(context);
    await subject.openEvents();
    subject.notice();
    if (contentType === "media") subject.mediaReply(7);
    else subject.reply(7);
    const before = fs.readFileSync(subject.statePath);
    const probe = await observeStateWrites(subject, () => subject.control.scanOwnerReplies(), 1);
    assert.ifError(probe.error);
    assert.equal(probe.snapshots.length, 1);
    assert.equal(probe.value.results[0].outcome, "owner_event_capture_failed");
    assert.equal(probe.value.results[0].error.code, "STATE_WRITE_FAILED");
    assert.deepEqual(fs.readFileSync(subject.statePath), before);
    const reloaded = subject.reload();
    assert.equal(reloaded.state.hasSeenControlMessage("owner:owner-private:7"), false);
    assert.deepEqual(subject.read({}, reloaded.control).events, []);
    assert.equal(reloaded.state.getOwnerRoute("event-route").lastInboundMessageSeq, 0);
    assertNoTemporaryState(subject);
    await reloaded.control.scanOwnerReplies();
    const page = subject.read({}, reloaded.control);
    assert.deepEqual(page.events.map((event) => event.message_seq), [7]);
    assert.equal(reloaded.state.hasSeenControlMessage("owner:owner-private:7"), true);
    const finalReload = subject.reload();
    const idempotent = await observeStateWrites(subject, () => finalReload.control.scanOwnerReplies());
    assert.ifError(idempotent.error);
    assert.deepEqual(idempotent.snapshots, []);
    assert.deepEqual(subject.read({}, finalReload.control), page);
    assert.equal(finalReload.state.getOwnerRoute("event-route").ownerReplyEventCounter, 1);
    assertNoLegacyDelivery(subject, finalReload.state);
  });
}

test("later successful event cannot hide an earlier failed event on reload", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  subject.notice();
  subject.reply(7);
  subject.reply(8);
  const probe = await observeStateWrites(subject, () => subject.control.scanOwnerReplies(), 1);
  assert.ifError(probe.error);
  assert.equal(probe.snapshots.length, 2);
  assert.equal(subject.state.hasSeenControlMessage("owner:owner-private:7"), false);
  assert.equal(subject.state.hasSeenControlMessage("owner:owner-private:8"), true);
  const initial = subject.read();
  assert.deepEqual(initial.events.map((event) => event.message_seq), [8]);
  const reloaded = subject.reload();
  await reloaded.control.scanOwnerReplies();
  const page = subject.read({}, reloaded.control);
  assert.deepEqual(page.events.map((event) => event.message_seq).sort((left, right) => left - right), [7, 8]);
  assert.equal(page.events.find((event) => event.message_seq === 8).event_id, initial.events[0].event_id);
  assert.equal(new Set(page.events.map((event) => event.event_id)).size, 2);
  const finalReload = subject.reload();
  await finalReload.control.scanOwnerReplies();
  assert.deepEqual(subject.read({}, finalReload.control), page);
  assertNoLegacyDelivery(subject, finalReload.state);
});

test("file reload preserves exact pages, cursor scope and idempotent omitted-parameter registration", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  subject.notice();
  subject.reply(7);
  subject.reply(8);
  await subject.control.scanOwnerReplies();
  const first = subject.read({ limit: 1 });
  assert.equal(first.partial, true);
  const before = fs.readFileSync(subject.statePath);
  const reloaded = subject.reload();
  const probe = await observeStateWrites(subject, async () => {
    const repeated = await subject.register({}, reloaded.control);
    assert.equal(repeated.replyDelivery, "events_only");
    assert.equal(repeated.ownerEventGeneration, 1);
    await reloaded.control.scanOwnerReplies();
  });
  assert.ifError(probe.error);
  assert.deepEqual(probe.snapshots, []);
  const second = subject.read({ cursor: first.next_cursor, limit: 1 }, reloaded.control);
  assert.deepEqual(second.events.map((event) => event.message_seq), [8]);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  subject.notice({ messageId: "501" }, reloaded.state);
  assert.throws(() => subject.read({ original_qq_message_id: "501", cursor: first.next_cursor }, reloaded.control), { code: "OWNER_EVENTS_CURSOR_SCOPE_MISMATCH" });
  assert.throws(() => subject.read({ expected_route_generation: 2 }, reloaded.control), { code: "OWNER_EVENTS_GENERATION_MISMATCH" });
  assertNoLegacyDelivery(subject, reloaded.state);
});

test("closed, reopened and migrated events_only routes fail closed for old notices and retain their mode", async (context) => {
  const subject = fixture(context);
  await subject.register({ route_key: "maintenance-route", conversation_id: "maintenance-chat" });
  const maintenance = subject.state.getOwnerRoute("maintenance-route");
  await subject.openEvents();
  subject.notice();
  subject.reply(7);
  await subject.control.scanOwnerReplies();
  subject.control.closeOwnerRoute({ route_key: "event-route" });
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_SCOPE_MISMATCH" });
  const reopened = await subject.register();
  assert.equal(reopened.replyDelivery, "events_only");
  assert.equal(reopened.ownerEventGeneration, 2);
  assert.throws(() => subject.read(), { code: "OWNER_EVENTS_GENERATION_MISMATCH" });
  assert.throws(() => subject.read({ expected_route_generation: 2 }), { code: "OWNER_EVENTS_ORIGINAL_MISMATCH" });
  subject.reply(8);
  const oldScan = await subject.control.scanOwnerReplies();
  assert.ok(oldScan.results.some((result) => result.messageSeq === 8 && result.error?.code === "OWNER_EVENT_SCOPE_MISMATCH"));
  assert.equal(subject.state.hasSeenControlMessage("owner:owner-private:8"), false);
  subject.notice({ messageId: "501" });
  subject.reply(9, { replyMessageId: "501" });
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read({ original_qq_message_id: "501", expected_route_generation: 2 }).events.map((event) => event.message_seq), [9]);
  subject.control.closeOwnerRoute({ route_key: "event-route" });
  const migrated = subject.control.migrateOwnerRoute({
    route_key: "event-route", expected_conversation_id: "event-chat", expected_task_id: null,
    expected_target_key: "owner-private", conversation_id: "migrated-chat",
  });
  assert.equal(migrated.replyDelivery, "events_only");
  assert.equal(migrated.ownerEventGeneration, 3);
  assert.throws(() => subject.read({ original_qq_message_id: "501", expected_route_generation: 3 }), { code: "OWNER_EVENTS_SCOPE_MISMATCH" });
  assert.throws(() => subject.read({ conversation_id: "migrated-chat", original_qq_message_id: "501", expected_route_generation: 3 }), { code: "OWNER_EVENTS_ORIGINAL_MISMATCH" });
  subject.notice({ messageId: "502" });
  subject.reply(10, { replyMessageId: "502" });
  await subject.control.scanOwnerReplies();
  const finalReload = subject.reload();
  const page = subject.read({ conversation_id: "migrated-chat", original_qq_message_id: "502", expected_route_generation: 3 }, finalReload.control);
  assert.deepEqual(page.events.map((event) => event.message_seq), [10]);
  assert.equal(finalReload.state.getOwnerRoute("event-route").replyDelivery, "events_only");
  assert.deepEqual(finalReload.state.getOwnerRoute("maintenance-route"), maintenance);
  assertNoLegacyDelivery(subject, finalReload.state);
});

test("existing legacy routes reject conversion even when captured or closed and retain their original snapshot shape", async (context) => {
  const subject = fixture(context);
  await subject.register();
  assert.deepEqual(subject.state.getOwnerRoute("event-route"), {
    routeKey: "event-route", conversationId: "event-chat", taskId: null, targetKey: "owner-private",
    status: "open", openedAt: "2026-11-15T16:12:00.000Z", closedAt: null,
    lastInboundMessageSeq: 0, baselineMessageKeys: [], baselineInitialized: true, bufferedOwnerMessages: [],
  });
  for (const status of ["plain", "captured", "closed"]) {
    if (status === "captured") await subject.register({ capture_owner_events: true });
    if (status === "closed") subject.control.closeOwnerRoute({ route_key: "event-route" });
    const before = fs.readFileSync(subject.statePath);
    const probe = await observeStateWrites(subject, () => subject.openEvents());
    assert.equal(probe.error?.code, "OWNER_ROUTE_CONFLICT");
    assert.deepEqual(probe.snapshots, []);
    assert.deepEqual(fs.readFileSync(subject.statePath), before);
    assert.equal(Object.hasOwn(subject.state.getOwnerRoute("event-route"), "replyDelivery"), false);
  }
});

test("omitted parameters preserve legacy media buffering and wake generation one after reopening", async (context) => {
  const subject = fixture(context);
  await subject.register();
  subject.notice();
  subject.mediaReply(7);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 0);
  assert.equal(subject.state.listOwnerRouteBufferedMessages("event-route").length, 1);
  await subject.register();
  subject.reply(8);
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 1);
  assert.equal(subject.wakes[0].threadId, "event-chat");
  assert.equal(subject.wakes[0].generation, 1);
  assert.deepEqual(subject.wakes[0].pendingMessageSeqs, [7, 8]);
  subject.control.closeOwnerRoute({ route_key: "event-route" });
  await subject.register();
  subject.notice({ messageId: "501" });
  subject.reply(9, { replyMessageId: "501" });
  await subject.control.scanOwnerReplies();
  assert.equal(subject.wakes.length, 2);
  assert.ok(subject.wakes.every((wake) => wake.generation === 1 && wake.threadId === "event-chat"));
  assert.equal(Object.hasOwn(subject.state.getOwnerRoute("event-route"), "replyDelivery"), false);
  assert.equal(subject.state.getOwnerRoute("event-route").ownerEventGeneration, undefined);
});

test("events_only retains target, quote, sender, baseline, self filtering while allowing exact group quotes without mention", async (context) => {
  const subject = fixture(context);
  subject.reply(1);
  await subject.openEvents();
  subject.notice();
  subject.reply(2, { replyMessageId: null });
  subject.reply(3, { replyMessageId: "999" });
  subject.reply(4, { senderId: "1999000099" });
  subject.reply(5, { isSelf: true });
  subject.reply(6, {}, "owner-other");
  subject.reply(7);
  await subject.openEvents({ route_key: "group-route", conversation_id: "group-chat", target_key: "owner-group" });
  subject.notice({ routeKey: "group-route", targetKey: "owner-group", messageId: "600" });
  subject.reply(10, { replyMessageId: "600" }, "owner-group");
  subject.reply(11, { replyMessageId: "600", mentionedUserIds: ["1000000001"] }, "owner-group");
  subject.reply(12, { replyMessageId: "500", mentionedUserIds: ["1000000001"] }, "owner-group");
  subject.reply(13, { replyMessageId: null, mentionedUserIds: ["1000000001"] }, "owner-group");
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [7]);
  assert.deepEqual(subject.read({ route_key: "group-route", conversation_id: "group-chat", original_qq_message_id: "600" }).events.map((event) => event.message_seq), [10, 11]);
  for (const sequence of [1, 2, 3, 4, 5]) assert.equal(subject.state.hasSeenControlMessage(`owner:owner-private:${sequence}`), false);
  assert.equal(subject.state.hasSeenControlMessage("owner:owner-group:12"), false);
  assert.equal(subject.state.hasSeenControlMessage("owner:owner-group:13"), false);
  assertNoLegacyDelivery(subject);
  assertNoLegacyDelivery(subject, subject.state, "group-route");
});

test("events_only transaction rejects foreign route, original and event identity before any write", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  await subject.openEvents({ route_key: "foreign-route" });
  subject.notice();
  subject.notice({ routeKey: "foreign-route", messageId: "501" });
  const event = {
    routeKey: "event-route", messageKey: "owner:owner-private:7", messageId: "1007", messageSeq: 7,
    quotedMessageId: "500", senderId: "1999000001", text: "transaction payload",
  };
  const before = fs.readFileSync(subject.statePath);
  const probe = await observeStateWrites(subject, () => {
    for (const changed of [
      { routeKey: "foreign-route" }, { messageKey: "foreign-key" }, { messageSeq: 8 },
      { quotedMessageId: "501" }, { quotedMessageId: "999" },
    ]) assert.throws(() => subject.state.completeOwnerReplyDelivery({
      routeKey: "event-route", messageKey: event.messageKey, messageSeq: 7, ownerReplyEvent: { ...event, ...changed },
    }), { code: "OWNER_EVENT_SCOPE_MISMATCH" });
  });
  assert.ifError(probe.error);
  assert.deepEqual(probe.snapshots, []);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.equal(subject.state.hasSeenControlMessage(event.messageKey), false);
  assert.deepEqual(subject.read().events, []);
});

test("events_only and legacy routes sharing a target keep their distinct delivery behavior", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  await subject.register({ route_key: "legacy-route", conversation_id: "legacy-chat" });
  subject.notice();
  subject.notice({ routeKey: "legacy-route", messageId: "501" });
  subject.reply(7);
  subject.reply(8, { replyMessageId: "501" });
  await subject.control.scanOwnerReplies();
  assert.deepEqual(subject.read().events.map((event) => event.message_seq), [7]);
  assert.equal(subject.wakes.length, 1);
  assert.equal(subject.wakes[0].threadId, "legacy-chat");
  assert.equal(subject.wakes[0].generation, 1);
  assert.equal(subject.state.getOwnerRoute("legacy-route").ownerEventGeneration, undefined);
  assert.deepEqual(subject.state.listOwnerRouteBufferedMessages("event-route"), []);
});

for (const unavailable of ["missing-source", "missing-native-id", "over-one-MiB", "media-source-unavailable"]) {
  test(`${unavailable} remains explicitly unreadable after scan dedupe and never falls back to a wake`, async (context) => {
    const subject = fixture(context);
    await subject.openEvents();
    subject.notice();
    if (unavailable === "missing-source") subject.reply(7, { ownerEventContent: undefined });
    else if (unavailable === "missing-native-id") subject.reply(7, { messageId: undefined });
    else if (unavailable === "over-one-MiB") subject.reply(7, {
      text: "legacy short preview", ownerEventContent: { text: "x".repeat(OWNER_REPLY_EVENT_LIMITS.cacheBytes + 1) },
    });
    else subject.mediaReply(7, { ownerEventContent: { unavailable: "native_media_text_unavailable" } });
    await subject.control.scanOwnerReplies();
    const reloaded = subject.reload();
    assert.equal(reloaded.state.hasSeenControlMessage("owner:owner-private:7"), true);
    assert.equal(reloaded.state.getOwnerRoute("event-route").ownerReplyEventCounter, 1);
    assert.equal(typeof reloaded.state.getOwnerRoute("event-route").ownerReplyEvents[0].unavailable, "string");
    const before = fs.readFileSync(subject.statePath);
    const readCount = subject.reads.length;
    assert.throws(() => subject.read({}, reloaded.control), { code: "OWNER_EVENTS_CONTENT_UNAVAILABLE" });
    assert.equal(subject.reads.length, readCount);
    assert.deepEqual(fs.readFileSync(subject.statePath), before);
    await reloaded.control.scanOwnerReplies();
    assert.equal(reloaded.state.getOwnerRoute("event-route").ownerReplyEventCounter, 1);
    assert.throws(() => subject.read({}, reloaded.control), { code: "OWNER_EVENTS_CONTENT_UNAVAILABLE" });
    assert.ok(fs.statSync(subject.statePath).size < 16384);
    assertNoLegacyDelivery(subject, reloaded.state);
  });
}

test("existing maxSeen retention reports expired history and cursors without a legacy wake fallback", async (context) => {
  const subject = fixture(context, { maxSeen: 2 });
  await subject.openEvents();
  subject.notice();
  subject.reply(7);
  subject.reply(8);
  await subject.control.scanOwnerReplies();
  const first = subject.read({ limit: 1 });
  assert.equal(first.partial, true);
  subject.reply(9);
  await subject.control.scanOwnerReplies();
  const reloaded = subject.reload();
  const retained = reloaded.state.getOwnerRoute("event-route");
  assert.equal(retained.ownerReplyEvents.length, 2);
  assert.equal(retained.ownerReplyEvictedThrough, 1);
  assert.equal(retained.ownerReplyEventCounter, 3);
  const before = fs.readFileSync(subject.statePath);
  assert.throws(() => subject.read({}, reloaded.control), { code: "OWNER_EVENTS_HISTORY_EXPIRED" });
  assert.throws(() => subject.read({ cursor: first.next_cursor }, reloaded.control), { code: "OWNER_EVENTS_CURSOR_EXPIRED" });
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assertNoLegacyDelivery(subject, reloaded.state);
});

test("one-MiB aggregate eviction stays explicit while retained scan dedupe remains idempotent", async (context) => {
  const subject = fixture(context);
  await subject.openEvents();
  subject.notice();
  const retainedText = "y".repeat(Math.floor(OWNER_REPLY_EVENT_LIMITS.cacheBytes * 0.36));
  subject.reply(7, { text: "preview 7", ownerEventContent: { text: retainedText } });
  subject.reply(8, { text: "preview 8", ownerEventContent: { text: retainedText } });
  await subject.control.scanOwnerReplies();
  const first = subject.read({ limit: 1 });
  assert.equal(first.partial, true);
  subject.reply(9, { text: "preview 9", ownerEventContent: { text: retainedText } });
  await subject.control.scanOwnerReplies();
  const reloaded = subject.reload();
  const retained = reloaded.state.getOwnerRoute("event-route");
  assert.deepEqual(retained.ownerReplyEvents.map((event) => event.message_seq), [8, 9]);
  assert.equal(retained.ownerReplyEvictedThrough, 1);
  for (const sequence of [7, 8, 9]) assert.equal(reloaded.state.hasSeenControlMessage(`owner:owner-private:${sequence}`), true);
  assert.throws(() => subject.read({}, reloaded.control), { code: "OWNER_EVENTS_HISTORY_EXPIRED" });
  assert.throws(() => subject.read({ cursor: first.next_cursor }, reloaded.control), { code: "OWNER_EVENTS_CURSOR_EXPIRED" });
  const before = fs.readFileSync(subject.statePath);
  const probe = await observeStateWrites(subject, () => reloaded.control.scanOwnerReplies());
  assert.ifError(probe.error);
  assert.deepEqual(probe.snapshots, []);
  assert.deepEqual(fs.readFileSync(subject.statePath), before);
  assert.ok(fs.statSync(subject.statePath).size < OWNER_REPLY_EVENT_LIMITS.cacheBytes);
  subject.notice({ messageId: "501" }, reloaded.state);
  subject.reply(10, { replyMessageId: "501" });
  await reloaded.control.scanOwnerReplies();
  assert.deepEqual(subject.read({ original_qq_message_id: "501" }, reloaded.control).events.map((event) => event.message_seq), [10]);
  assert.throws(() => subject.read({}, reloaded.control), { code: "OWNER_EVENTS_HISTORY_EXPIRED" });
  assertNoLegacyDelivery(subject, reloaded.state);
});
