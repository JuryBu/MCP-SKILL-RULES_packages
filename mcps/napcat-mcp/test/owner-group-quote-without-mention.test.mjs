import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlane } from "../src/control-plane.mjs";
import { createControlState } from "../src/control-state.mjs";

const SELF_ID = "1000000001";
const OWNER_ID = "1999000001";
const OTHER_MEMBER_ID = "1999000099";
const GROUP_ID = "2000000001";

function createGroupFixture(context, { includePrivateTarget = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-group-quote-no-at-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = createControlState({
    statePath: path.join(root, "control-state.json"),
    now: () => new Date("2026-11-28T12:00:00.000Z"),
  });
  const targets = {
    ...(includePrivateTarget ? { "owner-private": { type: "private", id: OWNER_ID, name: "Owner" } } : {}),
    "owner-group": { type: "group", id: GROUP_ID, name: "Members", expectedMemberCount: 4 },
  };
  const groupHistory = [];
  let nextSentId = 600;
  const wakeCalls = [];
  const notifier = {
    getControlPlaneConfig() {
      return {
        enabled: true,
        localMachine: "development",
        expectedSelfId: SELF_ID,
        trustedPeerQq: "1000000003",
        defaultTargetKey: "owner-group",
        targets,
      };
    },
    async sendConfiguredMessage() {
      nextSentId += 1;
      return { sent: true, messageId: String(nextSentId) };
    },
    async readConfiguredTargetMessages({ target_key: targetKey }) {
      return {
        target: targets[targetKey],
        messages: [...groupHistory],
      };
    },
  };
  const bridge = {
    async wake(input) {
      wakeCalls.push(input);
      return { outcome: "accepted", turn: { id: "turn-1" } };
    },
  };
  const controlPlane = createControlPlane({
    notifier,
    bridge,
    state,
    now: () => new Date("2026-11-28T12:06:30.000Z"),
  });
  return { root, state, groupHistory, wakeCalls, controlPlane };
}

test("events_only 群聊精确引用 bot 消息：主人不加 @ 直接捕获，非授权群成员即使 @ 也被拦截", async (context) => {
  const fx = createGroupFixture(context);
  await fx.controlPlane.registerOwnerRoute({
    route_key: "core-egress",
    conversation_id: "conv-core",
    target_key: "owner-group",
    reply_delivery: "events_only",
    capture_owner_events: true,
  });
  const sent = await fx.controlPlane.sendOwnerAlert({
    route_key: "core-egress",
    summary: "模型渲染已回报，请核对。",
    dedupe_key: "alert-601",
  });
  assert.equal(sent.messageId, "601");

  fx.groupHistory.push(
    {
      isSelf: false,
      messageId: "7001",
      messageSeq: 7001,
      replyMessageId: "601",
      senderId: OTHER_MEMBER_ID,
      time: "2026-11-28T12:06:10.000Z",
      text: "stranger quoting with mention",
      mentionedUserIds: [SELF_ID],
      ownerEventContent: { text: "stranger quoting with mention" },
    },
    {
      isSelf: false,
      messageId: "7002",
      messageSeq: 7002,
      replyMessageId: "601",
      senderId: OWNER_ID,
      time: "2026-11-28T12:06:16.000Z",
      text: "owner pure quote without mention",
      mentionedUserIds: [],
      ownerEventContent: { text: "owner pure quote without mention" },
    },
  );

  const scan = await fx.controlPlane.scanOwnerReplies();
  assert.deepEqual(scan.results, [
    { outcome: "owner_reply_captured", routeKey: "core-egress", messageSeq: 7002 },
  ]);
  const page = fx.controlPlane.readOwnerEvents({
    route_key: "core-egress",
    conversation_id: "conv-core",
    original_qq_message_id: "601",
    expected_route_generation: 1,
  });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].message_id, "7002");
  assert.equal(page.events[0].sender_id, OWNER_ID);
  assert.equal(page.events[0].text, "owner pure quote without mention");
});

test("普通非引用群聊依然严格要求 @self，不因精确引用放宽而误抓群内闲聊", async (context) => {
  const fx = createGroupFixture(context);
  await fx.controlPlane.registerOwnerWindowRoute({
    route_key: "window-group",
    conversation_id: "conv-core",
    target_key: "owner-group",
    capture_owner_events: true,
    reply_delivery: "events_only",
    window_capture: true,
    dedupe_key: "reg-win-1",
    expected_generation: 0,
    window_binding: {
      generation: 1,
      owner_key: JSON.stringify(["development", "codex", "desktop", "conv-target"]),
      target: {
        machine_id: "development",
        host: "codex",
        surface: "desktop",
        conversation_id: "conv-target",
        binding_id: "bind-target",
        binding_generation: 1,
      },
    },
  });

  fx.groupHistory.push(
    {
      isSelf: false,
      messageId: "8001",
      messageSeq: 8001,
      replyMessageId: "",
      senderId: OWNER_ID,
      time: "2026-11-28T12:06:10.000Z",
      text: "ordinary chat without mention",
      mentionedUserIds: [],
      ownerEventContent: { text: "ordinary chat without mention" },
    },
    {
      isSelf: false,
      messageId: "8002",
      messageSeq: 8002,
      replyMessageId: "",
      senderId: OWNER_ID,
      time: "2026-11-28T12:06:20.000Z",
      text: "ordinary chat with mention",
      mentionedUserIds: [SELF_ID],
      ownerEventContent: { text: "ordinary chat with mention" },
    },
  );

  const scan = await fx.controlPlane.scanOwnerReplies();
  assert.equal(scan.results.length, 1);
  assert.equal(scan.results[0].outcome, "owner_window_captured");
  assert.equal(scan.results[0].messageSeq, 8002);
});

test("未配置唯一 private 本人目标时：直接唤醒仍要求 @self，events_only 精准引用交由下游校验", async (context) => {
  const fx = createGroupFixture(context, { includePrivateTarget: false });
  await fx.controlPlane.registerOwnerRoute({
    route_key: "direct-group",
    conversation_id: "conv-direct",
    target_key: "owner-group",
  });
  await fx.controlPlane.registerOwnerRoute({
    route_key: "events-group",
    conversation_id: "conv-events",
    target_key: "owner-group",
    reply_delivery: "events_only",
    capture_owner_events: true,
  });
  const directAlert = await fx.controlPlane.sendOwnerAlert({
    route_key: "direct-group",
    summary: "direct alert",
    dedupe_key: "direct-601",
  });
  const eventsAlert = await fx.controlPlane.sendOwnerAlert({
    route_key: "events-group",
    summary: "events alert",
    dedupe_key: "events-602",
  });

  fx.groupHistory.push(
    {
      isSelf: false,
      messageId: "9001",
      messageSeq: 9001,
      replyMessageId: directAlert.messageId,
      senderId: OWNER_ID,
      time: "2026-11-28T12:06:10.000Z",
      text: "direct quote without mention",
      mentionedUserIds: [],
    },
    {
      isSelf: false,
      messageId: "9002",
      messageSeq: 9002,
      replyMessageId: eventsAlert.messageId,
      senderId: OWNER_ID,
      time: "2026-11-28T12:06:15.000Z",
      text: "events quote without mention",
      mentionedUserIds: [],
      ownerEventContent: { text: "events quote without mention" },
    },
  );

  const scan = await fx.controlPlane.scanOwnerReplies();
  assert.deepEqual(scan.results, [
    { outcome: "owner_reply_captured", routeKey: "events-group", messageSeq: 9002 },
  ]);
  assert.equal(fx.wakeCalls.length, 0);
});
