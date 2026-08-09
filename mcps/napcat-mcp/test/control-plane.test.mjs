import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlPlane } from "../src/control-plane.mjs";
import { createControlState } from "../src/control-state.mjs";

const BASE_TIME = "2026-08-09T00:00:00.000Z";
const PLACEHOLDER_OWNER_PRIVATE_ID = "1999000001";
const PLACEHOLDER_OWNER_GROUP_ID = "2999000001";

function configuration(overrides = {}) {
  return {
    enabled: true,
    machineIngressEnabled: true,
    localMachine: "development",
    trustedPeerQq: "2000000002",
    expectedSelfId: "1000000001",
    defaultTargetKey: "owner-private",
    targets: {
      "owner-private": {
        type: "private",
        id: PLACEHOLDER_OWNER_PRIVATE_ID,
        name: "owner",
      },
      "owner-group": {
        type: "group",
        id: PLACEHOLDER_OWNER_GROUP_ID,
        name: "owner-group",
      },
    },
    ...overrides,
  };
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-control-plane-test-"));
  const statePath = path.join(root, "state", "control-state.json");
  const groupSends = [];
  const configuredSends = [];
  const wakeCalls = [];
  const targetHistory = new Map(Object.entries(options.targetHistory ?? {}));
  const sentByDedupeKey = new Map();
  const currentConfiguration = configuration(options.configuration);
  let nextMessageId = options.nextMessageId ?? 500;
  const notifier = {
    getControlPlaneConfig: () => currentConfiguration,
    sendControlGroupMessage: async (input) => {
      groupSends.push(structuredClone(input));
      if (typeof options.sendControlGroupMessage === "function") {
        return options.sendControlGroupMessage(input, { groupSends, sentByDedupeKey });
      }
      if (!sentByDedupeKey.has(input.dedupe_key)) {
        sentByDedupeKey.set(input.dedupe_key, nextMessageId);
        nextMessageId += 1;
      }
      const duplicateSuppressed = groupSends.slice(0, -1)
        .some((entry) => entry.dedupe_key === input.dedupe_key);
      return duplicateSuppressed
        ? {
            sent: false,
            duplicateSuppressed: true,
            reason: "already_sent",
            existing: { messageId: sentByDedupeKey.get(input.dedupe_key) },
          }
        : {
            sent: true,
            verified: true,
            messageId: sentByDedupeKey.get(input.dedupe_key),
          };
    },
    sendConfiguredMessage: async (input) => {
      configuredSends.push(structuredClone(input));
      return { sent: true, verified: true, messageId: nextMessageId++ };
    },
    readConfiguredTargetMessages: async ({ target_key: targetKey }) => {
      const target = currentConfiguration.targets[targetKey];
      if (!target) throw new Error(`missing target: ${targetKey}`);
      return {
        target: { ...target },
        messages: structuredClone(targetHistory.get(targetKey) ?? []),
      };
    },
  };
  const bridge = {
    wake: async (input) => {
      wakeCalls.push(structuredClone(input));
      return options.wakeResult ?? {
        outcome: "accepted",
        status: "busy",
        started: true,
        turn: { id: `turn-${wakeCalls.length}` },
      };
    },
  };
  const state = createControlState({
    statePath,
    now: options.now ?? (() => new Date(BASE_TIME)),
  });
  if (options.existingState) {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(options.existingState, null, 2)}\n`, "utf8");
  }
  const controlPlane = createControlPlane({
    notifier,
    bridge,
    state,
    now: options.now ?? (() => new Date(BASE_TIME)),
    registry: options.registry,
    connectionRequestBootstrapLookbackMs: options.connectionRequestBootstrapLookbackMs,
  });
  return {
    root,
    state,
    controlPlane,
    groupSends,
    configuredSends,
    wakeCalls,
    configuration: currentConfiguration,
    targetHistory,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function businessMessage(overrides = {}) {
  return {
    messageId: "77",
    messageSeq: "77",
    deliveryMessageSeq: "77",
    senderId: "1000000001",
    isSelf: false,
    messageType: "business",
    deliveryId: "delivery-001",
    taskId: "stable-task",
    sourceMachine: "development",
    targetMachine: "training",
    time: BASE_TIME,
    text: "business payload",
    ...overrides,
  };
}

function receiptMessage(stage, overrides = {}) {
  return {
    messageId: stage === "machine_received" ? "501" : "502",
    messageSeq: stage === "machine_received" ? "501" : "502",
    deliveryMessageSeq: "77",
    senderId: "2000000002",
    isSelf: false,
    messageType: "delivery_receipt",
    deliveryId: "delivery-001",
    taskId: "stable-task",
    sourceMachine: "training",
    targetMachine: "development",
    receiptStage: stage,
    time: stage === "machine_received"
      ? "2026-08-09T00:00:01.000Z"
      : "2026-08-09T00:00:02.000Z",
    text: `[Codex][DELIVERY_RECEIPT] ${stage}`,
    ...overrides,
  };
}

test("business delivery advances through machine and conversation receipts without receipt recursion", async () => {
  const sender = createFixture();
  const receiver = createFixture({
    configuration: {
      localMachine: "training",
      trustedPeerQq: "1000000001",
      expectedSelfId: "2000000002",
    },
  });
  try {
    sender.controlPlane.trackOutgoingDelivery({
      deliveryId: "delivery-001",
      taskId: "stable-task",
      sourceMachine: "development",
      targetMachine: "training",
      messageSeq: 77,
    });

    const business = businessMessage();
    await receiver.controlPlane.scanGroupHistory([]);
    assert.deepEqual(
      await receiver.controlPlane.acknowledgeBusinessMessages([business], "machine_received"),
      [{ deliveryId: "delivery-001", stage: "machine_received", sent: true }],
    );
    assert.deepEqual(
      await receiver.controlPlane.acknowledgeBusinessMessages([business], "conversation_received"),
      [{ deliveryId: "delivery-001", stage: "conversation_received", sent: true }],
    );
    assert.deepEqual(
      receiver.groupSends.map((entry) => entry.dedupe_key),
      [
        "delivery-receipt:machine_received:delivery-001",
        "delivery-receipt:conversation_received:delivery-001",
      ],
    );

    const receipts = [receiptMessage("machine_received"), receiptMessage("conversation_received")];
    const scan = await sender.controlPlane.scanGroupHistory(receipts);
    assert.deepEqual(
      scan.results.map((result) => result.outcome),
      ["machine_received", "conversation_received"],
    );
    assert.deepEqual(sender.controlPlane.getDeliveryStatus("delivery-001"), {
      deliveryId: "delivery-001",
      taskId: "stable-task",
      sourceMachine: "development",
      targetMachine: "training",
      messageSeq: 77,
      machineReceivedAt: "2026-08-09T00:00:01.000Z",
      conversationReceivedAt: "2026-08-09T00:00:02.000Z",
      status: "conversation_received",
    });

    const sendCount = receiver.groupSends.length;
    assert.deepEqual(
      await receiver.controlPlane.acknowledgeBusinessMessages(receipts, "machine_received"),
      [],
    );
    assert.equal(receiver.groupSends.length, sendCount);
    assert.equal(sender.groupSends.length, 0);
  } finally {
    sender.cleanup();
    receiver.cleanup();
  }
});

test("first control-plane enable baselines historical business messages without emitting receipts", async () => {
  const fixture = createFixture({
    now: () => new Date("2026-08-09T00:10:00.000Z"),
    configuration: {
      localMachine: "training",
      trustedPeerQq: "1000000001",
      expectedSelfId: "2000000002",
    },
  });
  try {
    const historical = businessMessage({
      deliveryId: "delivery-before-enable",
      messageId: "71",
      messageSeq: "71",
      deliveryMessageSeq: "71",
      time: "2026-08-09T00:00:00.000Z",
    });
    const bootstrap = await fixture.controlPlane.scanGroupHistory([historical]);
    assert.equal(bootstrap.bootstrap.initialized, true);
    assert.equal(bootstrap.bootstrap.baselinedReceiptCount, 2);
    assert.deepEqual(await fixture.controlPlane.acknowledgeBusinessMessages([historical], "machine_received"), []);
    assert.deepEqual(
      await fixture.controlPlane.acknowledgeBusinessMessages([historical], "conversation_received"),
      [],
    );
    assert.equal(fixture.groupSends.length, 0);
    assert.equal(fixture.state.snapshot().businessReceiptBootstrapAt, "2026-08-09T00:10:00.000Z");
  } finally {
    fixture.cleanup();
  }
});

test("disabled control plane does not establish a bootstrap before real enable", async () => {
  const fixture = createFixture({
    now: () => new Date("2026-08-09T00:10:00.000Z"),
    configuration: {
      enabled: false,
      localMachine: "training",
      trustedPeerQq: "1000000001",
      expectedSelfId: "2000000002",
    },
  });
  try {
    const historical = businessMessage({ deliveryId: "delivery-while-disabled" });
    assert.equal((await fixture.controlPlane.scanGroupHistory([historical])).enabled, false);
    assert.equal(fixture.state.getBusinessReceiptBootstrapAt(), null);
    assert.deepEqual(
      await fixture.controlPlane.acknowledgeBusinessMessages([historical], "machine_received"),
      [],
    );
    fixture.configuration.enabled = true;
    const enabled = await fixture.controlPlane.scanGroupHistory([historical]);
    assert.equal(enabled.bootstrap.initialized, true);
    assert.equal(enabled.bootstrap.baselinedReceiptCount, 2);
    assert.equal(fixture.groupSends.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("same-second business message after bootstrap is receipted without wall-clock filtering", async () => {
  let currentTime = new Date("2026-08-09T00:10:00.700Z");
  const fixture = createFixture({ now: () => currentTime });
  try {
    await fixture.controlPlane.scanGroupHistory([]);
    currentTime = new Date("2026-08-09T00:10:01.000Z");
    const sameSecond = businessMessage({
      deliveryId: "delivery-same-second",
      messageId: "73",
      messageSeq: "73",
      deliveryMessageSeq: "73",
      time: "2026-08-09T00:10:00.000Z",
    });
    assert.deepEqual(
      await fixture.controlPlane.acknowledgeBusinessMessages([sameSecond], "machine_received"),
      [{ deliveryId: "delivery-same-second", stage: "machine_received", sent: true }],
    );
  } finally {
    fixture.cleanup();
  }
});

test("persisted bootstrap resumes receipts for messages received while the machine was offline", async () => {
  const fixture = createFixture({
    now: () => new Date("2026-08-09T01:00:00.000Z"),
    existingState: {
      schemaVersion: 2,
      businessReceiptBootstrapAt: "2026-08-09T00:10:00.000Z",
      deliveries: {},
      connectionRequests: {},
      ownerRoutes: {},
      seenControlMessages: [],
    },
  });
  try {
    const offlineArrival = businessMessage({
      deliveryId: "delivery-during-offline",
      messageId: "72",
      messageSeq: "72",
      deliveryMessageSeq: "72",
      time: "2026-08-09T00:30:00.000Z",
    });
    assert.deepEqual(
      await fixture.controlPlane.acknowledgeBusinessMessages([offlineArrival], "machine_received"),
      [{ deliveryId: "delivery-during-offline", stage: "machine_received", sent: true }],
    );
    assert.deepEqual(
      await fixture.controlPlane.acknowledgeBusinessMessages([offlineArrival], "machine_received"),
      [],
    );
    assert.equal(fixture.groupSends.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("unknown receipt send outcome is persisted and never retried automatically", async () => {
  let attempts = 0;
  const fixture = createFixture({
    sendControlGroupMessage: async () => {
      attempts += 1;
      const error = new Error("socket closed after send");
      error.outcomeUnknown = true;
      throw error;
    },
  });
  try {
    await fixture.controlPlane.scanGroupHistory([]);
    const inbound = businessMessage({ deliveryId: "delivery-outcome-unknown" });
    const first = await fixture.controlPlane.acknowledgeBusinessMessages([inbound], "machine_received");
    assert.equal(first[0].sent, false);
    assert.equal(first[0].error.outcomeUnknown, true);
    assert.deepEqual(
      await fixture.controlPlane.acknowledgeBusinessMessages([inbound], "machine_received"),
      [],
    );
    assert.equal(attempts, 1);
  } finally {
    fixture.cleanup();
  }
});

test("first enable accepts only recent connection requests inside the bootstrap lookback", async () => {
  const fixture = createFixture({
    now: () => new Date("2026-08-09T00:20:00.000Z"),
    connectionRequestBootstrapLookbackMs: 10 * 60 * 1000,
  });
  try {
    const base = {
      senderId: "2000000002",
      isSelf: false,
      messageType: "connection_request",
      proposedTaskId: "stable-successor-task",
      sourceConversationId: "019f-source-conversation",
      targetConversationId: "019f-target-conversation",
      sourceMachine: "training",
      targetMachine: "development",
      text: "connection request",
    };
    const stale = {
      ...base,
      messageId: "610",
      messageSeq: "610",
      deliveryMessageSeq: "610",
      deliveryId: "request-stale",
      requestId: "request-stale",
      time: "2026-08-09T00:00:00.000Z",
    };
    const recent = {
      ...base,
      messageId: "611",
      messageSeq: "611",
      deliveryMessageSeq: "611",
      deliveryId: "request-recent",
      requestId: "request-recent",
      time: "2026-08-09T00:15:00.000Z",
    };
    const scan = await fixture.controlPlane.scanGroupHistory([stale, recent]);
    assert.deepEqual(scan.results.map((entry) => entry.outcome), [
      "stale_connection_request_baselined",
      "connection_request_delivered",
    ]);
    assert.equal(fixture.wakeCalls.length, 1);
    assert.equal(fixture.wakeCalls[0].taskId, "stable-successor-task");
    assert.deepEqual(fixture.groupSends.map((entry) => entry.dedupe_key), [
      "delivery-receipt:machine_received:request-recent",
      "delivery-receipt:conversation_received:request-recent",
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("first enable rejects connection requests with unverifiable time but later restarts accept offline requests", async () => {
  const fixture = createFixture({ now: () => new Date("2026-08-09T00:20:00.000Z") });
  try {
    const base = {
      senderId: "2000000002",
      isSelf: false,
      messageType: "connection_request",
      proposedTaskId: "stable-successor-task",
      sourceConversationId: "019f-source-conversation",
      targetConversationId: "019f-target-conversation",
      sourceMachine: "training",
      targetMachine: "development",
      text: "connection request",
    };
    const invalidTime = {
      ...base,
      messageId: "612",
      messageSeq: "612",
      deliveryMessageSeq: "612",
      deliveryId: "request-invalid-time",
      requestId: "request-invalid-time",
      time: null,
    };
    const first = await fixture.controlPlane.scanGroupHistory([invalidTime]);
    assert.deepEqual(first.results.map((entry) => entry.outcome), ["connection_request_time_unverifiable"]);
    assert.equal(fixture.wakeCalls.length, 0);

    const offlineRequest = {
      ...base,
      messageId: "613",
      messageSeq: "613",
      deliveryMessageSeq: "613",
      deliveryId: "request-after-bootstrap",
      requestId: "request-after-bootstrap",
      time: "2026-08-08T23:00:00.000Z",
    };
    const later = await fixture.controlPlane.scanGroupHistory([offlineRequest]);
    assert.deepEqual(later.results.map((entry) => entry.outcome), ["connection_request_delivered"]);
    assert.equal(fixture.wakeCalls.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("connection request wakes only its requested conversation and never registers a task", async () => {
  let registryRegisterCount = 0;
  const fixture = createFixture({
    registry: {
      register() {
        registryRegisterCount += 1;
        throw new Error("control plane must not register tasks");
      },
    },
  });
  try {
    const request = {
      messageId: "601",
      messageSeq: "601",
      deliveryMessageSeq: "601",
      senderId: "2000000002",
      isSelf: false,
      messageType: "connection_request",
      deliveryId: "request-001",
      requestId: "request-001",
      proposedTaskId: "stable-successor-task",
      previousTaskId: "stable-predecessor-task",
      sourceConversationId: "019f-source-conversation",
      targetConversationId: "019f-target-conversation",
      sourceMachine: "training",
      targetMachine: "development",
      time: BASE_TIME,
      text: "connection request",
    };

    const first = await fixture.controlPlane.scanGroupHistory([request]);
    assert.deepEqual(first.results, [{
      outcome: "connection_request_delivered",
      requestId: "request-001",
    }]);
    assert.equal(registryRegisterCount, 0);
    assert.equal(fixture.wakeCalls.length, 1);
    assert.equal(fixture.wakeCalls[0].threadId, "019f-target-conversation");
    assert.equal(fixture.wakeCalls[0].taskId, "stable-successor-task");
    assert.match(fixture.wakeCalls[0].prompt, /source_conversation_id=019f-source-conversation/);
    assert.match(fixture.wakeCalls[0].prompt, /不代表本机已经登记、绑定或接受 task/);
    assert.deepEqual(
      fixture.groupSends.map((entry) => entry.dedupe_key),
      [
        "delivery-receipt:machine_received:request-001",
        "delivery-receipt:conversation_received:request-001",
      ],
    );
    assert.equal(fixture.state.snapshot().connectionRequests["request-001"].status, "wake_accepted");
    assert.deepEqual(fixture.state.snapshot().deliveries, {});

    const second = await fixture.controlPlane.scanGroupHistory([request]);
    assert.deepEqual(second.results, [{
      outcome: "duplicate_connection_request",
      requestId: "request-001",
    }]);
    assert.equal(fixture.wakeCalls.length, 1);
    assert.equal(fixture.groupSends.length, 2);

    const replayedWithNewSequence = {
      ...request,
      messageId: "602",
      messageSeq: "602",
      deliveryMessageSeq: "602",
    };
    const third = await fixture.controlPlane.scanGroupHistory([replayedWithNewSequence]);
    assert.deepEqual(third.results, [{
      outcome: "duplicate_connection_request",
      requestId: "request-001",
    }]);
    assert.equal(fixture.wakeCalls.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("connection requests exchange callback ids once and reverse requests reuse the persisted address", async () => {
  const fixture = createFixture();
  try {
    fixture.state.updateConnectionRequest({
      requestId: "request-original",
      sourceConversationId: "019f-training-source",
      targetConversationId: "019f-development-target",
      proposedTaskId: "stable-old-task",
      previousTaskId: null,
      sourceMachine: "training",
      targetMachine: "development",
      status: "wake_accepted",
    });

    const sent = await fixture.controlPlane.sendConnectionRequest({
      proposed_task_id: "stable-new-task",
      previous_task_id: "stable-old-task",
      source_conversation_id: "019f-development-source",
      target_machine: "training",
      reason: "recover",
    });

    assert.equal(sent.targetConversationId, "019f-training-source");
    assert.equal(sent.resolvedFromRequestId, "request-original");
    assert.match(fixture.groupSends[0].message, /source_conversation_id：019f-development-source/);
    assert.match(fixture.groupSends[0].message, /target_conversation_id：019f-training-source/);
    assert.equal((fixture.groupSends[0].message.match(/source_conversation_id/g) ?? []).length, 1);
    assert.equal((fixture.groupSends[0].message.match(/target_conversation_id/g) ?? []).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("connection requests can resolve the callback by the exact prior request id", async () => {
  const fixture = createFixture();
  try {
    fixture.state.updateConnectionRequest({
      requestId: "request-exact",
      sourceConversationId: "019f-training-source",
      targetConversationId: "019f-development-target",
      proposedTaskId: "stable-old-task",
      previousTaskId: null,
      sourceMachine: "training",
      targetMachine: "development",
      status: "wake_accepted",
    });

    const sent = await fixture.controlPlane.sendConnectionRequest({
      proposed_task_id: "stable-new-task",
      reply_to_request_id: "request-exact",
      source_conversation_id: "019f-development-source",
      target_machine: "training",
      reason: "recover-by-request-id",
    });

    assert.equal(sent.targetConversationId, "019f-training-source");
    assert.equal(sent.resolvedFromRequestId, "request-exact");
    assert.match(fixture.groupSends[0].message, /source_conversation_id：019f-development-source/);
    assert.match(fixture.groupSends[0].message, /target_conversation_id：019f-training-source/);
  } finally {
    fixture.cleanup();
  }
});

test("connection request rejects an explicit target that conflicts with the persisted callback", async () => {
  const fixture = createFixture();
  try {
    fixture.state.updateConnectionRequest({
      requestId: "request-original",
      sourceConversationId: "019f-training-source",
      targetConversationId: "019f-development-target",
      proposedTaskId: "stable-old-task",
      previousTaskId: null,
      sourceMachine: "training",
      targetMachine: "development",
      status: "received",
    });

    await assert.rejects(
      () => fixture.controlPlane.sendConnectionRequest({
        proposed_task_id: "stable-new-task",
        previous_task_id: "stable-old-task",
        source_conversation_id: "019f-development-source",
        target_conversation_id: "019f-wrong-target",
        target_machine: "training",
      }),
      /与已持久化回拨地址冲突/,
    );
    assert.equal(fixture.groupSends.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("owner private and group replies require their configured sender or mention before routing", async () => {
  const privateHistory = [
        {
          isSelf: false,
          replyMessageId: "500",
          senderId: "9999999999",
          messageSeq: 10,
          time: BASE_TIME,
          text: "wrong private sender",
          mentionedUserIds: [],
        },
        {
          isSelf: false,
          replyMessageId: "500",
          senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
          messageSeq: 11,
          time: BASE_TIME,
          text: "valid private reply",
          mentionedUserIds: [],
        },
      ];
  const groupHistory = [
        {
          isSelf: false,
          replyMessageId: "501",
          senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
          messageSeq: 20,
          time: BASE_TIME,
          text: "missing mention",
          mentionedUserIds: [],
        },
        {
          isSelf: false,
          replyMessageId: "501",
          senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
          messageSeq: 21,
          time: BASE_TIME,
          text: "valid group reply",
          mentionedUserIds: ["1000000001"],
        },
      ];
  const fixture = createFixture();
  try {
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      task_id: "stable-task-private",
      target_key: "owner-private",
    });
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "group-route",
      conversation_id: "conversation-group",
      task_id: "stable-task-group",
      target_key: "owner-group",
    });
    const privateAlert = await fixture.controlPlane.sendOwnerAlert({
      route_key: "private-route",
      summary: "开发机处理完成。",
      reply_hint: "回我这条就好",
      dedupe_key: "owner-private-alert",
    });
    const groupAlert = await fixture.controlPlane.sendOwnerAlert({
      route_key: "group-route",
      summary: "训练机需要主人确认，请引用并 @ 当前机器账号回复。",
      dedupe_key: "owner-group-alert",
    });
    assert.equal(privateAlert.messageId, 500);
    assert.equal(groupAlert.messageId, 501);
    assert.equal(privateAlert.replyMode, "quote_only");
    assert.equal(groupAlert.replyMode, "quote_and_mention");
    assert.deepEqual(
      fixture.configuredSends.map((send) => send.message),
      [
        "开发机处理完成。\n\n回我这条就好",
        "训练机需要主人确认，请引用并 @ 当前机器账号回复。\n\n回复此条并 @ 当前机器账号即可",
      ],
    );
    assert.equal(fixture.configuredSends.some((send) => /route_key|\[OWNER_ALERT\]/.test(send.message)), false);

    fixture.targetHistory.set("owner-private", privateHistory);
    fixture.targetHistory.set("owner-group", groupHistory);
    const first = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(
      first.results.map((result) => ({
        outcome: result.outcome,
        routeKey: result.routeKey,
        messageSeq: result.messageSeq,
      })),
      [
        { outcome: "owner_reply_delivered", routeKey: "private-route", messageSeq: 11 },
        { outcome: "owner_reply_delivered", routeKey: "group-route", messageSeq: 21 },
      ],
    );
    assert.deepEqual(
      fixture.wakeCalls.map((call) => [call.threadId, call.pendingThroughSequence]),
      [
        ["conversation-private", 11],
        ["conversation-group", 21],
      ],
    );
    assert.match(fixture.wakeCalls[0].prompt, /valid private reply/);
    assert.match(fixture.wakeCalls[1].prompt, /valid group reply/);
    assert.equal(fixture.state.getOwnerRoute("private-route").lastInboundMessageSeq, 11);
    assert.equal(fixture.state.getOwnerRoute("group-route").lastInboundMessageSeq, 21);

    await fixture.controlPlane.scanOwnerReplies();
    assert.equal(fixture.wakeCalls.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("an unquoted private reply is ignored instead of guessing the latest route", async () => {
  let now = new Date(BASE_TIME);
  const fixture = createFixture({
    now: () => new Date(now),
  });
  try {
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "older-route",
      conversation_id: "conversation-older",
      target_key: "owner-private",
    });
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "latest-route",
      conversation_id: "conversation-latest",
      target_key: "owner-private",
    });
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "older-route",
      summary: "较早通知",
      dedupe_key: "older-owner-alert",
    });
    now = new Date("2026-08-09T00:00:01.000Z");
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "latest-route",
      summary: "最新通知",
      dedupe_key: "latest-owner-alert",
    });
    fixture.targetHistory.set("owner-private", [{
      isSelf: false,
      replyMessageId: "",
      routeKey: "",
      senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
      messageSeq: 1852008078,
      time: "2026-08-09T09:20:00.000Z",
      text: "受到",
      mentionedUserIds: [],
    }]);

    const scan = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(scan.results, []);
    assert.equal(fixture.wakeCalls.length, 0);
    assert.equal(fixture.state.getOwnerRoute("older-route").lastInboundMessageSeq, 0);
    assert.equal(fixture.state.getOwnerRoute("latest-route").lastInboundMessageSeq, 0);
  } finally {
    fixture.cleanup();
  }
});

test("owner routes without business task ids use distinct bridge subscriptions", async () => {
  const fixture = createFixture();
  try {
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      target_key: "owner-private",
    });
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "group-route",
      conversation_id: "conversation-group",
      target_key: "owner-group",
    });
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "private-route",
      summary: "private alert",
      dedupe_key: "private-alert-distinct-subscription",
    });
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "group-route",
      summary: "group alert",
      dedupe_key: "group-alert-distinct-subscription",
    });
    fixture.targetHistory.set("owner-private", [{
      isSelf: false,
      replyMessageId: "500",
      senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
      messageSeq: 31,
      time: BASE_TIME,
      text: "private reply",
      mentionedUserIds: [],
    }]);
    fixture.targetHistory.set("owner-group", [{
      isSelf: false,
      replyMessageId: "501",
      senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
      messageSeq: 32,
      time: BASE_TIME,
      text: "group reply",
      mentionedUserIds: ["1000000001"],
    }]);

    const scan = await fixture.controlPlane.scanOwnerReplies();

    assert.deepEqual(scan.results.map((result) => result.outcome), [
      "owner_reply_delivered",
      "owner_reply_delivered",
    ]);
    assert.deepEqual(fixture.wakeCalls.map((call) => call.taskId), [
      "owner-reply:private-route",
      "owner-reply:group-route",
    ]);
    assert.notEqual(fixture.wakeCalls[0].taskId, fixture.wakeCalls[1].taskId);
  } finally {
    fixture.cleanup();
  }
});

test("owner replies with out-of-order message_seq are delivered exactly once each", async () => {
  const firstReply = {
    isSelf: false,
    replyMessageId: "500",
    senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
    messageSeq: 21,
    time: BASE_TIME,
    text: "first valid reply",
    mentionedUserIds: [],
  };
  const secondReply = {
    isSelf: false,
    replyMessageId: "500",
    senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
    messageSeq: 20,
    time: "2026-08-09T00:00:01.000Z",
    text: "second valid reply with lower sequence",
    mentionedUserIds: [],
  };
  const fixture = createFixture();
  try {
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      task_id: "stable-task-private",
      target_key: "owner-private",
    });
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "private-route",
      summary: "回复顺序测试",
      dedupe_key: "owner-order-alert",
    });

    fixture.targetHistory.set("owner-private", [firstReply]);
    const first = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(
      first.results.map((result) => [result.outcome, result.messageSeq]),
      [["owner_reply_delivered", 21]],
    );

    fixture.targetHistory.set("owner-private", [firstReply, secondReply]);
    const second = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(
      second.results.map((result) => [result.outcome, result.messageSeq]),
      [["owner_reply_delivered", 20]],
    );
    assert.deepEqual(
      fixture.wakeCalls.map((call) => [call.pendingThroughSequence, call.prompt.includes("valid reply")]),
      [
        [21, true],
        [20, true],
      ],
    );

    const third = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(third.results, []);
    assert.equal(fixture.wakeCalls.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("open owner route keeps the control plane alive without machine ingress or business tasks", async () => {
  const fixture = createFixture({
    configuration: { machineIngressEnabled: false },
  });
  try {
    assert.equal(fixture.controlPlane.keepAlive(), false);
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      task_id: "stable-task-private",
      target_key: "owner-private",
    });
    assert.equal(fixture.controlPlane.keepAlive(), true);
  } finally {
    fixture.cleanup();
  }
});

test("new owner route baselines existing history and delivers only later replies", async () => {
  const oldReply = {
    isSelf: false,
    replyMessageId: "",
    routeKey: "",
    senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
    messageSeq: 101,
    time: BASE_TIME,
    text: "old history",
    mentionedUserIds: [],
  };
  const fixture = createFixture({ targetHistory: { "owner-private": [oldReply] } });
  try {
    const route = await fixture.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      target_key: "owner-private",
    });
    assert.equal(route.baselineMessageCount, 1);
    assert.deepEqual((await fixture.controlPlane.scanOwnerReplies()).results, []);
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "private-route",
      summary: "新通知",
      dedupe_key: "baseline-owner-alert",
    });

    fixture.targetHistory.set("owner-private", [oldReply, {
      ...oldReply,
      replyMessageId: "500",
      messageSeq: 102,
      time: "2026-08-09T00:00:01.000Z",
      text: "new reply",
    }]);
    const scan = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(scan.results, [{
      outcome: "owner_reply_delivered",
      routeKey: "private-route",
      messageSeq: 102,
    }]);
    assert.equal(fixture.wakeCalls.length, 1);
    assert.match(fixture.wakeCalls[0].prompt, /new reply/);
    assert.doesNotMatch(fixture.wakeCalls[0].prompt, /old history/);
  } finally {
    fixture.cleanup();
  }
});

test("migrated open owner route establishes a baseline on its first background scan", async () => {
  const seed = createFixture();
  let legacyState;
  try {
    await seed.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      target_key: "owner-private",
    });
    legacyState = seed.state.snapshot();
  } finally {
    seed.cleanup();
  }
  legacyState.schemaVersion = 3;
  delete legacyState.ownerRoutes["private-route"].baselineMessageKeys;
  delete legacyState.ownerRoutes["private-route"].bufferedOwnerMessages;
  const oldReply = {
    isSelf: false,
    replyMessageId: "",
    routeKey: "",
    senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
    messageSeq: 150,
    time: BASE_TIME,
    text: "legacy private history",
    mentionedUserIds: [],
  };
  const fixture = createFixture({ existingState: legacyState, targetHistory: { "owner-private": [oldReply] } });
  try {
    assert.deepEqual((await fixture.controlPlane.scanOwnerReplies()).results, []);
    assert.equal(fixture.wakeCalls.length, 0);
    const persisted = JSON.parse(fs.readFileSync(path.join(fixture.root, "state", "control-state.json"), "utf8"));
    assert.equal(persisted.schemaVersion, 5);
    assert.equal(persisted.ownerRoutes["private-route"].baselineInitialized, true);
    assert.equal(persisted.ownerRoutes["private-route"].baselineMessageKeys.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("standalone owner media stays buffered until explicit text arrives", async () => {
  const media = {
    isSelf: false,
    replyMessageId: "500",
    routeKey: "",
    senderId: PLACEHOLDER_OWNER_PRIVATE_ID,
    messageSeq: 201,
    time: BASE_TIME,
    text: "[CQ:image,file=image-001]",
    hasExplicitText: false,
    contentTypes: ["image"],
    attachments: [{ type: "image", file: "image-001" }],
    mentionedUserIds: [],
  };
  const fixture = createFixture();
  try {
    await fixture.controlPlane.registerOwnerRoute({
      route_key: "private-route",
      conversation_id: "conversation-private",
      target_key: "owner-private",
    });
    await fixture.controlPlane.sendOwnerAlert({
      route_key: "private-route",
      summary: "请结合后续媒体回复",
      dedupe_key: "owner-media-alert",
    });
    fixture.targetHistory.set("owner-private", [media]);
    assert.deepEqual((await fixture.controlPlane.scanOwnerReplies()).results, [{
      outcome: "owner_reply_buffered",
      routeKey: "private-route",
      messageSeq: 201,
    }]);
    assert.equal(fixture.wakeCalls.length, 0);
    assert.equal(fixture.state.listOwnerRouteBufferedMessages("private-route").length, 1);
    assert.deepEqual((await fixture.controlPlane.scanOwnerReplies()).results, []);

    fixture.targetHistory.set("owner-private", [{
      ...media,
      messageSeq: 202,
      time: "2026-08-09T00:00:01.000Z",
      text: "看看这张图",
      hasExplicitText: true,
      contentTypes: [],
      attachments: [],
    }, media]);
    const scan = await fixture.controlPlane.scanOwnerReplies();
    assert.deepEqual(scan.results, [{
      outcome: "owner_reply_delivered",
      routeKey: "private-route",
      messageSeq: 202,
    }]);
    assert.deepEqual(fixture.wakeCalls[0].pendingMessageSeqs, [201, 202]);
    assert.match(fixture.wakeCalls[0].prompt, /image-001/);
    assert.match(fixture.wakeCalls[0].prompt, /看看这张图/);
    assert.deepEqual(fixture.state.listOwnerRouteBufferedMessages("private-route"), []);
    assert.deepEqual((await fixture.controlPlane.scanOwnerReplies()).results, []);
  } finally {
    fixture.cleanup();
  }
});

test("connection delivery and wake identifiers are stable and duplicate scans are idempotent", async () => {
  const fixture = createFixture();
  try {
    const input = {
      proposed_task_id: "stable-task",
      source_conversation_id: "019f-local-conversation",
      target_conversation_id: "019f-peer-conversation",
      target_machine: "training",
      reason: "reconnect after an accidental close",
    };
    const first = await fixture.controlPlane.sendConnectionRequest(input);
    const second = await fixture.controlPlane.sendConnectionRequest(input);
    assert.equal(first.requestId, second.requestId);
    assert.equal(first.deliveryId, first.requestId);
    assert.equal(second.deliveryId, first.requestId);
    assert.match(first.requestId, /^request-[a-f0-9]{32}$/);
    assert.equal(fixture.groupSends[0].dedupe_key, fixture.groupSends[1].dedupe_key);
    assert.equal(fixture.controlPlane.listDeliveryStatuses().length, 1);
    assert.equal(fixture.controlPlane.getDeliveryStatus(first.deliveryId).status, "pending");

    const changed = await fixture.controlPlane.sendConnectionRequest({
      ...input,
      target_conversation_id: "019f-another-conversation",
    });
    assert.notEqual(changed.requestId, first.requestId);
  } finally {
    fixture.cleanup();
  }
});
