import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createControlState, ControlStateError } from "../src/control-state.mjs";

const BASE_TIME = "2026-08-09T00:00:00.000Z";

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-control-state-test-"));
  const statePath = path.join(root, "state", "control-state.json");
  let currentTime = new Date(BASE_TIME).getTime();
  const now = () => new Date(currentTime);
  const controlState = createControlState({ statePath, now, ...options });
  return {
    root,
    statePath,
    controlState,
    advance(milliseconds) {
      currentTime += milliseconds;
    },
    createState(extraOptions = {}) {
      return createControlState({ statePath, now, ...extraOptions });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function deliveryInput(overrides = {}) {
  return {
    deliveryId: "delivery-001",
    taskId: "task-001",
    sourceMachine: "development",
    targetMachine: "training",
    messageSeq: 101,
    status: "machine_received",
    ...overrides,
  };
}

function connectionRequestInput(overrides = {}) {
  return {
    requestId: "request-001",
    sourceConversationId: "019f-source-conversation",
    targetConversationId: "019f-test-conversation",
    proposedTaskId: "task-proposed-001",
    previousTaskId: "task-previous-001",
    sourceMachine: "training",
    targetMachine: "development",
    status: "received",
    ...overrides,
  };
}

function ownerRouteInput(overrides = {}) {
  return {
    routeKey: "development:conversation-owner",
    conversationId: "conversation-owner",
    taskId: "task-001",
    targetKey: "training:task-001",
    ...overrides,
  };
}

function assertControlStateError(callback, code) {
  assert.throws(callback, (error) => error instanceof ControlStateError && error.code === code);
}

test("first write creates schemaVersion 5 state through a clean atomic rename", () => {
  const fixture = createFixture();
  try {
    assert.equal(fs.existsSync(fixture.statePath), false);
    const delivery = fixture.controlState.updateDelivery(deliveryInput());
    assert.deepEqual(delivery, {
      deliveryId: "delivery-001",
      taskId: "task-001",
      sourceMachine: "development",
      targetMachine: "training",
      messageSeq: 101,
      machineReceivedAt: BASE_TIME,
      conversationReceivedAt: null,
      status: "machine_received",
    });

    const stored = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(stored.schemaVersion, 5);
    assert.equal(stored.businessReceiptBootstrapAt, null);
    assert.deepEqual(stored.deliveries["delivery-001"], delivery);
    assert.deepEqual(stored.connectionRequests, {});
    assert.deepEqual(stored.ownerRoutes, {});
    assert.deepEqual(stored.ownerAlertMessages, {});
    assert.deepEqual(stored.seenControlMessages, []);
    assert.deepEqual(
      fs.readdirSync(path.dirname(fixture.statePath)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test("legacy schema migrates and persists the business receipt bootstrap", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.statePath), { recursive: true });
    fs.writeFileSync(fixture.statePath, `${JSON.stringify({
      schemaVersion: 1,
      deliveries: {},
      connectionRequests: {},
      ownerRoutes: {},
      seenControlMessages: [],
    }, null, 2)}\n`, "utf8");
    assert.deepEqual(fixture.controlState.initializeBusinessReceiptBaseline({
      receiptKeys: ["business-receipt:machine_received:delivery-legacy"],
    }), {
      initialized: true,
      bootstrapAt: BASE_TIME,
      baselinedReceiptCount: 1,
    });
    assert.equal(fixture.controlState.getBusinessReceiptBootstrapAt(), BASE_TIME);
    assert.equal(
      fixture.controlState.hasSeenControlMessage("business-receipt:machine_received:delivery-legacy"),
      true,
    );
    assert.equal(fixture.controlState.snapshot().schemaVersion, 5);
  } finally {
    fixture.cleanup();
  }
});

test("delivery updates are idempotent and can only advance stages", () => {
  const fixture = createFixture();
  try {
    const pending = fixture.controlState.updateDelivery(deliveryInput({ status: "pending" }));
    assert.equal(pending.machineReceivedAt, null);
    const pendingBytes = fs.readFileSync(fixture.statePath, "utf8");

    fixture.advance(1000);
    assert.deepEqual(
      fixture.controlState.updateDelivery({ deliveryId: "delivery-001", status: "pending" }),
      pending,
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), pendingBytes);

    const machineReceived = fixture.controlState.updateDelivery({
      deliveryId: "delivery-001",
      status: "machine_received",
    });
    assert.equal(machineReceived.machineReceivedAt, "2026-08-09T00:00:01.000Z");
    assert.equal(machineReceived.conversationReceivedAt, null);

    fixture.advance(1000);
    const conversationReceived = fixture.controlState.updateDelivery({
      deliveryId: "delivery-001",
      status: "conversation_received",
    });
    assert.equal(conversationReceived.machineReceivedAt, "2026-08-09T00:00:01.000Z");
    assert.equal(conversationReceived.conversationReceivedAt, "2026-08-09T00:00:02.000Z");
    const finalBytes = fs.readFileSync(fixture.statePath, "utf8");

    fixture.advance(1000);
    assert.deepEqual(
      fixture.controlState.updateDelivery({
        deliveryId: "delivery-001",
        messageSeq: 101,
        status: "conversation_received",
      }),
      conversationReceived,
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), finalBytes);
    assertControlStateError(
      () => fixture.controlState.updateDelivery({
        deliveryId: "delivery-001",
        status: "machine_received",
      }),
      "DELIVERY_STAGE_REGRESSION",
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), finalBytes);
    assertControlStateError(
      () => fixture.controlState.updateDelivery({
        deliveryId: "delivery-001",
        messageSeq: 102,
        status: "conversation_received",
      }),
      "DELIVERY_CONFLICT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("connection requests persist reception and wake acceptance monotonically", () => {
  const fixture = createFixture();
  try {
    const received = fixture.controlState.updateConnectionRequest(connectionRequestInput());
    assert.equal(received.receivedAt, BASE_TIME);
    assert.equal(received.wakeAcceptedAt, null);
    assert.equal(received.status, "received");
    assert.equal(received.sourceConversationId, "019f-source-conversation");

    fixture.advance(5000);
    const accepted = fixture.controlState.updateConnectionRequest({
      requestId: "request-001",
      status: "wake_accepted",
    });
    assert.equal(accepted.receivedAt, BASE_TIME);
    assert.equal(accepted.wakeAcceptedAt, "2026-08-09T00:00:05.000Z");
    assert.equal(accepted.status, "wake_accepted");
    const acceptedBytes = fs.readFileSync(fixture.statePath, "utf8");

    fixture.advance(5000);
    assert.deepEqual(
      fixture.controlState.updateConnectionRequest({
        requestId: "request-001",
        status: "wake_accepted",
      }),
      accepted,
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), acceptedBytes);
    assertControlStateError(
      () => fixture.controlState.updateConnectionRequest({
        requestId: "request-001",
        status: "received",
      }),
      "CONNECTION_REQUEST_STAGE_REGRESSION",
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), acceptedBytes);
  } finally {
    fixture.cleanup();
  }
});

test("a fresh instance reloads all persisted control records", () => {
  const fixture = createFixture();
  try {
    const delivery = fixture.controlState.updateDelivery(deliveryInput());
    const request = fixture.controlState.updateConnectionRequest(connectionRequestInput());
    const route = fixture.controlState.openOwnerRoute(ownerRouteInput());
    const alert = fixture.controlState.recordOwnerAlertMessage({
      messageId: "501",
      routeKey: route.routeKey,
      targetKey: route.targetKey,
    });
    fixture.controlState.markControlMessageSeen("training:message:101");

    const reloaded = fixture.createState();
    assert.deepEqual(reloaded.getDelivery(delivery.deliveryId), delivery);
    assert.deepEqual(reloaded.getConnectionRequest(request.requestId), request);
    assert.deepEqual(reloaded.getOwnerRoute(route.routeKey), route);
    assert.deepEqual(reloaded.getOwnerAlertMessage(alert.messageId), alert);
    assert.equal(reloaded.hasSeenControlMessage("training:message:101"), true);
    assert.deepEqual(reloaded.snapshot(), JSON.parse(fs.readFileSync(fixture.statePath, "utf8")));
  } finally {
    fixture.cleanup();
  }
});

test("schemaVersion 2 migrates owner alert message mappings without changing existing records", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.statePath), { recursive: true });
    fs.writeFileSync(fixture.statePath, `${JSON.stringify({
      schemaVersion: 2,
      businessReceiptBootstrapAt: BASE_TIME,
      deliveries: {
        "delivery-001": {
          deliveryId: "delivery-001",
          taskId: "task-001",
          sourceMachine: "development",
          targetMachine: "training",
          messageSeq: 101,
          machineReceivedAt: BASE_TIME,
          conversationReceivedAt: null,
          status: "machine_received",
        },
      },
      connectionRequests: {},
      ownerRoutes: {},
      seenControlMessages: ["business-receipt:machine_received:delivery-001"],
    }, null, 2)}\n`, "utf8");

    const snapshot = fixture.controlState.snapshot();
    assert.equal(snapshot.schemaVersion, 5);
    assert.equal(snapshot.businessReceiptBootstrapAt, BASE_TIME);
    assert.deepEqual(snapshot.ownerAlertMessages, {});
    assert.equal(snapshot.deliveries["delivery-001"].deliveryId, "delivery-001");
  } finally {
    fixture.cleanup();
  }
});

test("owner alert message mappings are idempotent and cannot be remapped", () => {
  const fixture = createFixture();
  try {
    fixture.controlState.openOwnerRoute(ownerRouteInput());
    const first = fixture.controlState.recordOwnerAlertMessage({
      messageId: "501",
      routeKey: "development:conversation-owner",
      targetKey: "training:task-001",
    });
    assert.equal(first.messageId, "501");
    assert.equal(first.sentAt, BASE_TIME);

    fixture.advance(1000);
    assert.deepEqual(fixture.controlState.recordOwnerAlertMessage({
      messageId: "501",
      routeKey: "development:conversation-owner",
      targetKey: "training:task-001",
    }), first);
    assert.deepEqual(fixture.controlState.getOwnerAlertMessage("501"), first);
    assert.deepEqual(
      fixture.controlState.getLatestOwnerAlertMessageForTarget("training:task-001", ["development:conversation-owner"]),
      { message: first, ambiguous: false },
    );
    fixture.controlState.openOwnerRoute(ownerRouteInput({
      routeKey: "another-route",
      conversationId: "another-conversation",
    }));
    assertControlStateError(
      () => fixture.controlState.recordOwnerAlertMessage({
        messageId: "501",
        routeKey: "another-route",
        targetKey: "training:task-001",
      }),
      "OWNER_ALERT_MESSAGE_CONFLICT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("latest owner alert resolution rejects tied routes instead of guessing", () => {
  const fixture = createFixture();
  try {
    fixture.controlState.openOwnerRoute(ownerRouteInput());
    fixture.controlState.openOwnerRoute(ownerRouteInput({
      routeKey: "another-route",
      conversationId: "another-conversation",
    }));
    fixture.controlState.recordOwnerAlertMessage({
      messageId: "501",
      routeKey: "development:conversation-owner",
      targetKey: "training:task-001",
    });
    fixture.controlState.recordOwnerAlertMessage({
      messageId: "502",
      routeKey: "another-route",
      targetKey: "training:task-001",
    });
    assert.deepEqual(
      fixture.controlState.getLatestOwnerAlertMessageForTarget("training:task-001", [
        "development:conversation-owner",
        "another-route",
      ]),
      { message: null, ambiguous: true },
    );
  } finally {
    fixture.cleanup();
  }
});

test("legacy connection requests without callback fields remain readable", () => {
  const fixture = createFixture();
  try {
    fixture.controlState.updateConnectionRequest(connectionRequestInput());
    const stored = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    delete stored.connectionRequests["request-001"].sourceConversationId;
    delete stored.connectionRequests["request-001"].previousTaskId;
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const legacy = fixture.createState().getConnectionRequest("request-001");
    assert.equal(legacy.targetConversationId, "019f-test-conversation");
    assert.equal(Object.hasOwn(legacy, "sourceConversationId"), false);
  } finally {
    fixture.cleanup();
  }
});

test("seen control messages deduplicate and stay within maxSeen", () => {
  const fixture = createFixture({ maxSeen: 3 });
  try {
    assert.deepEqual(
      fixture.controlState.markControlMessageSeen("message-a"),
      { messageKey: "message-a", duplicate: false },
    );
    const firstBytes = fs.readFileSync(fixture.statePath, "utf8");
    assert.deepEqual(
      fixture.controlState.markControlMessageSeen("message-a"),
      { messageKey: "message-a", duplicate: true },
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), firstBytes);

    fixture.controlState.markControlMessageSeen("message-b");
    fixture.controlState.markControlMessageSeen("message-c");
    fixture.controlState.markControlMessageSeen("message-d");
    assert.deepEqual(
      fixture.controlState.snapshot().seenControlMessages,
      ["message-b", "message-c", "message-d"],
    );
    assert.equal(fixture.controlState.hasSeenControlMessage("message-a"), false);
    assert.equal(fixture.createState({ maxSeen: 3 }).hasSeenControlMessage("message-d"), true);
  } finally {
    fixture.cleanup();
  }
});

test("owner routes open, track the latest processed identity without numeric ordering, close, and reopen cleanly", () => {
  const fixture = createFixture();
  try {
    const opened = fixture.controlState.openOwnerRoute(ownerRouteInput({
      baselineMessageKeys: ["owner:training:task-001:old-message"],
    }));
    assert.deepEqual(opened, {
      routeKey: "development:conversation-owner",
      conversationId: "conversation-owner",
      taskId: "task-001",
      targetKey: "training:task-001",
      status: "open",
      openedAt: BASE_TIME,
      closedAt: null,
      lastInboundMessageSeq: 0,
      baselineMessageKeys: ["owner:training:task-001:old-message"],
      baselineInitialized: true,
      bufferedOwnerMessages: [],
    });
    const openedBytes = fs.readFileSync(fixture.statePath, "utf8");
    assert.deepEqual(fixture.controlState.openOwnerRoute(ownerRouteInput()), opened);
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), openedBytes);

    const inbound = fixture.controlState.recordOwnerRouteInbound({
      routeKey: opened.routeKey,
      messageSeq: 12,
    });
    assert.equal(inbound.lastInboundMessageSeq, 12);
    const lowerSequence = fixture.controlState.recordOwnerRouteInbound({
      routeKey: opened.routeKey,
      messageSeq: 10,
    });
    assert.equal(lowerSequence.lastInboundMessageSeq, 10);
    const inboundBytes = fs.readFileSync(fixture.statePath, "utf8");
    assert.deepEqual(
      fixture.controlState.recordOwnerRouteInbound({ routeKey: opened.routeKey, messageSeq: 10 }),
      lowerSequence,
    );
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), inboundBytes);

    fixture.controlState.bufferOwnerRouteMessage({
      routeKey: opened.routeKey,
      messageKey: "owner:training:task-001:media-message",
      messageSeq: 11,
      time: BASE_TIME,
      text: "[CQ:image,file=image-001]",
      contentTypes: ["image"],
      attachments: [{ type: "image", file: "image-001" }],
    });
    const reloadedBuffered = fixture.createState().getOwnerRoute(opened.routeKey);
    assert.equal(reloadedBuffered.bufferedOwnerMessages.length, 1);
    assert.equal(reloadedBuffered.bufferedOwnerMessages[0].messageSeq, 11);

    fixture.advance(1000);
    const closed = fixture.controlState.closeOwnerRoute({ routeKey: opened.routeKey });
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedAt, "2026-08-09T00:00:01.000Z");
    const closedBytes = fs.readFileSync(fixture.statePath, "utf8");
    assert.deepEqual(fixture.controlState.closeOwnerRoute({ routeKey: opened.routeKey }), closed);
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), closedBytes);
    assertControlStateError(
      () => fixture.controlState.recordOwnerRouteInbound({ routeKey: opened.routeKey, messageSeq: 13 }),
      "OWNER_ROUTE_CLOSED",
    );

    fixture.advance(1000);
    const reopened = fixture.controlState.openOwnerRoute({
      routeKey: opened.routeKey,
      baselineMessageKeys: ["owner:training:task-001:new-baseline"],
    });
    assert.equal(reopened.status, "open");
    assert.equal(reopened.openedAt, "2026-08-09T00:00:02.000Z");
    assert.equal(reopened.closedAt, null);
    assert.equal(reopened.lastInboundMessageSeq, 10);
    assert.deepEqual(reopened.baselineMessageKeys, ["owner:training:task-001:new-baseline"]);
    assert.equal(reopened.baselineInitialized, true);
    assert.deepEqual(reopened.bufferedOwnerMessages, []);
  } finally {
    fixture.cleanup();
  }
});

test("schemaVersion 3 open owner route requires one baseline refresh before scanning", () => {
  const fixture = createFixture();
  try {
    fixture.controlState.openOwnerRoute(ownerRouteInput());
    const legacyState = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    legacyState.schemaVersion = 3;
    delete legacyState.ownerRoutes["development:conversation-owner"].baselineMessageKeys;
    delete legacyState.ownerRoutes["development:conversation-owner"].bufferedOwnerMessages;
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

    const migrated = fixture.createState().getOwnerRoute("development:conversation-owner");
    assert.equal(migrated.baselineInitialized, false);
    const refreshed = fixture.createState().openOwnerRoute({
      routeKey: "development:conversation-owner",
      baselineMessageKeys: ["owner:training:task-001:legacy-history"],
    });
    assert.equal(refreshed.baselineInitialized, true);
    assert.deepEqual(refreshed.baselineMessageKeys, ["owner:training:task-001:legacy-history"]);
  } finally {
    fixture.cleanup();
  }
});

test("schemaVersion 4 partial owner route preserves data and requires one baseline refresh", () => {
  const fixture = createFixture();
  try {
    fixture.controlState.openOwnerRoute(ownerRouteInput());
    const partialState = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    partialState.schemaVersion = 4;
    delete partialState.ownerRoutes["development:conversation-owner"].baselineInitialized;
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(partialState, null, 2)}\n`, "utf8");

    const migrated = fixture.createState().getOwnerRoute("development:conversation-owner");
    assert.equal(migrated.baselineInitialized, false);
    assert.deepEqual(migrated.baselineMessageKeys, []);
    assert.deepEqual(migrated.bufferedOwnerMessages, []);
  } finally {
    fixture.cleanup();
  }
});

test("public input validation and corrupted state failures expose stable codes", () => {
  const fixture = createFixture();
  try {
    assertControlStateError(() => createControlState({ statePath: fixture.statePath, maxSeen: 0 }), "INVALID_ARGUMENT");
    assertControlStateError(
      () => fixture.controlState.updateDelivery(deliveryInput({ deliveryId: "", status: "unknown" })),
      "INVALID_ARGUMENT",
    );
    fs.mkdirSync(path.dirname(fixture.statePath), { recursive: true });
    const corrupted = "{\"schemaVersion\":1,\"deliveries\":";
    fs.writeFileSync(fixture.statePath, corrupted, "utf8");
    assertControlStateError(() => fixture.controlState.snapshot(), "INVALID_STATE");
    assertControlStateError(() => fixture.controlState.markControlMessageSeen("message-a"), "INVALID_STATE");
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), corrupted);
  } finally {
    fixture.cleanup();
  }
});
