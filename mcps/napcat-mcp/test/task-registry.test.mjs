import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskRegistry, TaskRegistryError } from "../src/task-registry.mjs";

const BASE_TIME = "2026-07-24T08:00:00.000Z";

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-task-registry-test-"));
  const statePath = path.join(root, "state", "task-registry.json");
  let currentTime = new Date(BASE_TIME).getTime();
  const now = () => new Date(currentTime);
  const registry = createTaskRegistry({ statePath, now, ...options });
  return {
    root,
    statePath,
    registry,
    advance(milliseconds) {
      currentTime += milliseconds;
    },
    createRegistry(extraOptions = {}) {
      return createTaskRegistry({ statePath, now, ...extraOptions });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function taskInput(overrides = {}) {
  return {
    taskId: "task-001",
    conversationId: "conversation-001",
    localRole: "development",
    sourceMachine: "development",
    targetMachine: "training",
    trustedPeerQq: "1000000001",
    ...overrides,
  };
}

function assertRegistryError(callback, code) {
  assert.throws(callback, (error) => error instanceof TaskRegistryError && error.code === code);
}

test("register is idempotent and rejects silent conversation changes", () => {
  const fixture = createFixture();
  try {
    const first = fixture.registry.register(taskInput());
    assert.deepEqual(Object.keys(first), [
      "taskId",
      "conversationId",
      "localRole",
      "sourceMachine",
      "targetMachine",
      "trustedPeerQq",
      "generation",
      "status",
      "lastSeenSeq",
      "lastAckedSeq",
      "lastSeenAt",
      "lastAckedAt",
      "wakeCooldownMs",
      "wakePending",
      "wakeSentAt",
      "wakeMessageSeq",
      "wakeMessageAt",
      "activeWakeId",
      "wakePromptSha256",
      "lastWakeAt",
      "ledgerInitialized",
      "pendingMessages",
      "activeWakes",
      "createdAt",
      "updatedAt",
    ]);
    assert.equal(first.generation, 1);
    assert.equal(first.status, "open");
    assert.equal(first.lastSeenSeq, 0);
    assert.equal(first.lastAckedSeq, 0);
    assert.equal(first.lastSeenAt, null);
    assert.equal(first.lastAckedAt, null);
    assert.equal(first.wakeCooldownMs, 600_000);
    assert.equal(first.wakePending, false);
    assert.equal(first.wakeSentAt, null);
    assert.equal(first.wakeMessageSeq, null);
    assert.equal(first.wakeMessageAt, null);
    assert.equal(first.activeWakeId, null);
    assert.equal(first.wakePromptSha256, null);
    assert.equal(first.lastWakeAt, null);
    assert.equal(first.createdAt, BASE_TIME);
    assert.equal(first.updatedAt, BASE_TIME);

    const repeated = fixture.registry.register(taskInput());
    assert.deepEqual(repeated, first);
    assert.deepEqual(fixture.registry.get("task-001"), first);

    assertRegistryError(
      () => fixture.registry.register(taskInput({ conversationId: "conversation-002" })),
      "TASK_ROUTE_CONFLICT",
    );
    assertRegistryError(
      () => fixture.registry.register(taskInput({ localRole: "training" })),
      "TASK_ROUTE_CONFLICT",
    );
    assert.deepEqual(fixture.registry.get("task-001"), first);
    const stateDirectory = path.dirname(fixture.statePath);
    assert.deepEqual(fs.readdirSync(stateDirectory).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    fixture.cleanup();
  }
});

test("new task routes require canonical machine role fields", () => {
  const fixture = createFixture();
  try {
    for (const overrides of [
      { localRole: "developer" },
      { sourceMachine: "developer" },
      { targetMachine: "trainer" },
    ]) {
      assertRegistryError(() => fixture.registry.register(taskInput(overrides)), "INVALID_ARGUMENT");
    }
    const registered = fixture.registry.register(taskInput());
    assertRegistryError(
      () => fixture.registry.update({
        taskId: registered.taskId,
        expectedGeneration: registered.generation,
        targetMachine: "developer",
      }),
      "INVALID_ARGUMENT",
    );
    assert.equal(fixture.registry.get(registered.taskId).targetMachine, "training");
  } finally {
    fixture.cleanup();
  }
});

test("legacy sequence-only tasks migrate without inventing message timestamps", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const stored = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    stored.tasks["task-001"].lastSeenSeq = 8;
    stored.tasks["task-001"].lastAckedSeq = 8;
    delete stored.tasks["task-001"].lastSeenAt;
    delete stored.tasks["task-001"].lastAckedAt;
    delete stored.tasks["task-001"].wakeMessageSeq;
    delete stored.tasks["task-001"].wakeMessageAt;
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    const migrated = fixture.createRegistry().get("task-001");
    assert.equal(migrated.lastSeenSeq, 8);
    assert.equal(migrated.lastAckedSeq, 8);
    assert.equal(migrated.lastSeenAt, null);
    assert.equal(migrated.lastAckedAt, null);
    assert.equal(migrated.wakeMessageSeq, null);
    assert.equal(migrated.wakeMessageAt, null);
  } finally {
    fixture.cleanup();
  }
});

test("legacy active wakes distinguish a delivered reminder from an unfinished lease", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const stored = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    stored.schemaVersion = 1;
    const legacy = stored.tasks["task-001"];
    legacy.wakePending = true;
    legacy.wakeSentAt = "2026-07-24T08:00:10.000Z";
    legacy.wakeMessageSeq = 10;
    legacy.wakeMessageAt = "2026-07-24T08:00:09.000Z";
    legacy.activeWakeId = "legacy-wake";
    legacy.wakePromptSha256 = "a".repeat(64);
    legacy.lastWakeAt = "2026-07-24T07:50:00.000Z";
    delete legacy.ledgerInitialized;
    delete legacy.messageLedger;
    delete legacy.wakeBatches;
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const unfinished = fixture.createRegistry().get("task-001");
    assert.equal(unfinished.ledgerInitialized, false);
    assert.equal(unfinished.pendingMessages[0].lastRemindedAt, null);
    assert.equal(unfinished.activeWakes[0].status, "leased");

    const deliveredState = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    deliveredState.tasks["task-001"].lastWakeAt = deliveredState.tasks["task-001"].wakeSentAt;
    fs.writeFileSync(fixture.statePath, `${JSON.stringify(deliveredState, null, 2)}\n`, "utf8");
    const delivered = fixture.createRegistry().get("task-001");
    assert.equal(delivered.pendingMessages[0].lastRemindedAt, "2026-07-24T08:00:10.000Z");
    assert.equal(delivered.activeWakes[0].status, "sent");
  } finally {
    fixture.cleanup();
  }
});

test("update uses expectedGeneration for an atomic rebind", () => {
  const fixture = createFixture();
  try {
    const first = fixture.registry.register(taskInput());
    const secondInstance = fixture.createRegistry();
    fixture.advance(1000);
    const rebound = secondInstance.update({
      taskId: first.taskId,
      expectedGeneration: first.generation,
      conversationId: "conversation-002",
      targetMachine: "development",
    });

    assert.equal(rebound.conversationId, "conversation-002");
    assert.equal(rebound.targetMachine, "development");
    assert.equal(rebound.generation, 2);
    assert.equal(rebound.updatedAt, "2026-07-24T08:00:01.000Z");
    assertRegistryError(
      () => fixture.registry.update({
        taskId: first.taskId,
        expectedGeneration: first.generation,
        conversationId: "conversation-003",
      }),
      "GENERATION_MISMATCH",
    );
    assert.equal(fixture.registry.get(first.taskId).conversationId, "conversation-002");
    assert.equal(fixture.registry.get(first.taskId).generation, 2);
  } finally {
    fixture.cleanup();
  }
});

test("route update rejects pending active wakes without changing the ledger", () => {
  const fixture = createFixture();
  try {
    const first = fixture.registry.register(taskInput());
    const pendingMessage = { messageSeq: 10, messageAt: "2026-07-24T08:00:10.000Z" };
    fixture.registry.observeMessages({
      taskId: first.taskId,
      expectedGeneration: first.generation,
      messages: [pendingMessage],
    });
    fixture.registry.acquireWakeLease({
      taskId: first.taskId,
      expectedGeneration: first.generation,
      messages: [pendingMessage],
      wakeId: "wake-pending-route-update",
      promptSha256: "a".repeat(64),
    });
    const beforePublic = fixture.registry.get(first.taskId);
    const beforeRaw = fs.readFileSync(fixture.statePath, "utf8");

    let thrown = null;
    try {
      fixture.registry.update({
        taskId: first.taskId,
        expectedGeneration: first.generation,
        conversationId: "conversation-002",
      });
    } catch (error) {
      thrown = error;
    }

    assert.deepEqual(fixture.registry.get(first.taskId), beforePublic);
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), beforeRaw);
    assert.ok(thrown instanceof TaskRegistryError);
    assert.equal(thrown.code, "TASK_ROUTE_UPDATE_BLOCKED");
  } finally {
    fixture.cleanup();
  }
});

test("task wake cooldown can be updated without changing the routing generation", () => {
  const fixture = createFixture();
  try {
    const first = fixture.registry.register(taskInput({ wakeCooldownMs: 1_800_000 }));
    assert.equal(first.wakeCooldownMs, 1_800_000);
    fixture.advance(1000);
    const updated = fixture.registry.update({
      taskId: first.taskId,
      expectedGeneration: first.generation,
      conversationId: first.conversationId,
      wakeCooldownMs: 60_000,
    });
    assert.equal(updated.wakeCooldownMs, 60_000);
    assert.equal(updated.generation, first.generation);
    assert.equal(updated.updatedAt, "2026-07-24T08:00:01.000Z");
    assert.deepEqual(fixture.registry.update({
      taskId: first.taskId,
      expectedGeneration: first.generation,
      wakeCooldownMs: 60_000,
    }), updated);
  } finally {
    fixture.cleanup();
  }
});

test("close requires explicit confirmations and a final disposition", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    assert.throws(() => fixture.registry.close({
      taskId: "task-001",
      expectedGeneration: 1,
      finalClose: true,
    }), (error) => (
      error instanceof TaskRegistryError
      && error.code === "CLOSE_CONFIRMATION_REQUIRED"
      && error.details.missingConfirmations.includes("confirmPendingEmpty")
      && error.details.missingConfirmations.includes("confirmPeerReady")
    ));
    assertRegistryError(
      () => fixture.registry.close({
        taskId: "task-001",
        expectedGeneration: 1,
        confirmPendingEmpty: true,
        confirmPeerReady: true,
      }),
      "CLOSE_DISPOSITION_REQUIRED",
    );
    assertRegistryError(
      () => fixture.registry.close({
        taskId: "task-001",
        expectedGeneration: 1,
        confirmPendingEmpty: true,
        confirmPeerReady: true,
        finalClose: true,
        successorTaskId: "task-002",
      }),
      "CLOSE_DISPOSITION_CONFLICT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("close rejects pending messages and active wake state without clearing its ledger", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    fixture.registry.observeMessages({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 1, messageAt: BASE_TIME }],
    });
    const lease = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 1, messageAt: BASE_TIME }],
      wakeId: "wake-1",
      promptSha256: "1".repeat(64),
    });
    assert.throws(() => fixture.registry.close({
      taskId: "task-001",
      expectedGeneration: 1,
      confirmPendingEmpty: true,
      confirmPeerReady: true,
      finalClose: true,
    }), (error) => (
      error instanceof TaskRegistryError
      && error.code === "TASK_CLOSE_BLOCKED"
      && error.details.pendingMessages.length === 1
      && error.details.activeWakes[0].wakeId === "wake-1"
      && error.details.activeWakeId === "wake-1"
      && error.details.wakePending === true
    ));
    assert.equal(fixture.registry.get("task-001").status, "open");
    assert.equal(fixture.registry.get("task-001").activeWakeId, "wake-1");
    assert.equal(lease.wakePending, true);
  } finally {
    fixture.cleanup();
  }
});

test("close rejects missing and incompatible successor tasks", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const closeWith = (successorTaskId) => fixture.registry.close({
      taskId: "task-001",
      expectedGeneration: 1,
      confirmPendingEmpty: true,
      confirmPeerReady: true,
      successorTaskId,
    });
    assertRegistryError(() => closeWith("missing-task"), "SUCCESSOR_TASK_NOT_FOUND");
    fixture.registry.register(taskInput({
      taskId: "task-002",
      conversationId: "conversation-002",
      targetMachine: "development",
    }));
    assertRegistryError(() => closeWith("task-002"), "SUCCESSOR_ROUTE_INCOMPATIBLE");
    assert.equal(fixture.registry.get("task-001").status, "open");
    assert.equal(fixture.registry.get("task-002").status, "open");
  } finally {
    fixture.cleanup();
  }
});

test("close succeeds for final and successor dispositions while preserving normal ledgers", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    fixture.registry.observeMessages({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 1, messageAt: BASE_TIME }],
    });
    const lease = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 1, messageAt: BASE_TIME }],
      wakeId: "wake-1",
      promptSha256: "1".repeat(64),
    });
    fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [1],
      wakeId: "wake-1",
    });
    const closed = fixture.registry.close({
      taskId: "task-001",
      expectedGeneration: 1,
      confirmPendingEmpty: true,
      confirmPeerReady: true,
      finalClose: true,
    });
    assert.equal(closed.status, "closed");
    const stored = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(stored.tasks["task-001"].messageLedger[0].status, "acked");
    assert.equal(stored.tasks["task-001"].wakeBatches[0].wakeId, lease.activeWakeId);

    fixture.registry.register(taskInput({ taskId: "task-002", conversationId: "conversation-002" }));
    fixture.registry.register(taskInput({ taskId: "task-003", conversationId: "conversation-003" }));
    const successorClosed = fixture.registry.close({
      taskId: "task-002",
      expectedGeneration: 1,
      confirmPendingEmpty: true,
      confirmPeerReady: true,
      successorTaskId: "task-003",
    });
    assert.equal(successorClosed.status, "closed");
    assert.equal(fixture.registry.get("task-003").status, "open");
  } finally {
    fixture.cleanup();
  }
});

test("repeated close remains idempotent after generation matching", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const closed = fixture.registry.close({
      taskId: "task-001",
      expectedGeneration: 1,
      confirmPendingEmpty: true,
      confirmPeerReady: true,
      finalClose: true,
    });
    assertRegistryError(
      () => fixture.registry.close({ taskId: "task-001", expectedGeneration: 2 }),
      "GENERATION_MISMATCH",
    );
    assert.deepEqual(fixture.registry.close({ taskId: "task-001", expectedGeneration: 1 }), closed);
  } finally {
    fixture.cleanup();
  }
});

test("markSeen follows message time instead of numeric message_seq ordering", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const seen = fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 8,
      at: "2026-07-24T08:00:08.000Z",
    });
    assert.equal(seen.lastSeenSeq, 8);
    assert.equal(seen.lastSeenAt, "2026-07-24T08:00:08.000Z");
    const laterWithSmallerSequence = fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 3,
      at: "2026-07-24T08:00:09.000Z",
    });
    assert.equal(laterWithSmallerSequence.lastSeenSeq, 3);
    assert.equal(laterWithSmallerSequence.lastSeenAt, "2026-07-24T08:00:09.000Z");
    assert.equal(fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 11,
      at: "2026-07-24T08:00:07.000Z",
    }).lastSeenSeq, 3);
    assertRegistryError(
      () => fixture.registry.ack({ taskId: "task-001", expectedGeneration: 1, seq: 8 }),
      "ACK_NOT_ACTIVE_WAKE",
    );
    const acquired = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 3, messageAt: "2026-07-24T08:00:09.000Z" }],
      wakeId: "wake-3",
      promptSha256: "3".repeat(64),
    });
    assert.equal(acquired.wakeMessageSeq, 3);
    const acknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [3],
      wakeId: "wake-3",
    });
    assert.equal(acknowledged.lastAckedSeq, 3);
    assert.equal(acknowledged.lastAckedAt, "2026-07-24T08:00:09.000Z");
    fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
      expectedWakeId: "wake-3",
    });
    fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 2,
      at: "2026-07-24T08:00:10.000Z",
    });
    fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 2, messageAt: "2026-07-24T08:00:10.000Z" }],
      wakeId: "wake-2",
      promptSha256: "2".repeat(64),
    });
    assertRegistryError(
      () => fixture.registry.acknowledgeWake({
        taskId: "task-001",
        expectedGeneration: 1,
        processedMessageSeqs: [3],
        wakeId: "wake-2",
      }),
      "ACK_MESSAGE_MISMATCH",
    );
    assertRegistryError(
      () => fixture.registry.acknowledgeWake({
        taskId: "task-001",
        expectedGeneration: 2,
        processedMessageSeqs: [2],
        wakeId: "wake-2",
      }),
      "GENERATION_MISMATCH",
    );
    assert.equal(fixture.registry.get("task-001").lastSeenSeq, 2);
  } finally {
    fixture.cleanup();
  }
});

test("wake lease acquisition, release, and timeout are persisted", () => {
  const fixture = createFixture({ wakeLeaseMs: 1000 });
  try {
    fixture.registry.register(taskInput());
    fixture.registry.markSeen({ taskId: "task-001", expectedGeneration: 1, seq: 1, at: BASE_TIME });
    const leaseInput = {
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 1, messageAt: BASE_TIME }],
      wakeId: "wake-1",
      promptSha256: "1".repeat(64),
    };
    const acquired = fixture.registry.acquireWakeLease(leaseInput);
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.reason, "acquired");
    assert.equal(acquired.wakePending, true);
    assert.equal(acquired.wakeSentAt, BASE_TIME);
    assert.equal(acquired.wakeMessageSeq, 1);
    assert.equal(acquired.wakeMessageAt, BASE_TIME);
    assert.equal(acquired.leaseExpiresAt, "2026-07-24T08:00:01.000Z");

    const blocked = fixture.registry.acquireWakeLease(leaseInput);
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, "lease_active");
    assert.equal(blocked.wakeSentAt, BASE_TIME);

    fixture.advance(1000);
    const reacquired = fixture.registry.acquireWakeLease(leaseInput);
    assert.equal(reacquired.acquired, true);
    assert.equal(reacquired.wakeSentAt, "2026-07-24T08:00:01.000Z");
    const released = fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: reacquired.wakeSentAt,
      expectedWakeId: "wake-1",
    });
    assert.equal(released.wakePending, false);
    assert.equal(released.wakeSentAt, null);
    assert.equal(released.wakeMessageSeq, null);
    assert.equal(released.wakeMessageAt, null);
    assert.deepEqual(fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeId: "wake-1",
    }), released);
  } finally {
    fixture.cleanup();
  }
});

test("a confirmed wake remains cooldown-limited after ACK releases its lease", () => {
  const fixture = createFixture({ wakeLeaseMs: 300_000, wakeCooldownMs: 60_000 });
  try {
    fixture.registry.register(taskInput());
    fixture.registry.markSeen({ taskId: "task-001", expectedGeneration: 1, seq: 1, at: BASE_TIME });
    const firstLeaseInput = {
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 1, messageAt: BASE_TIME }],
      wakeId: "wake-1",
      promptSha256: "1".repeat(64),
    };
    const acquired = fixture.registry.acquireWakeLease(firstLeaseInput);
    const confirmed = fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
      expectedWakeId: "wake-1",
    });
    assert.equal(confirmed.lastWakeAt, BASE_TIME);
    fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [1],
      wakeId: "wake-1",
    });
    fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 2,
      at: "2026-07-24T08:00:01.000Z",
    });
    const secondLeaseInput = {
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 2, messageAt: "2026-07-24T08:00:01.000Z" }],
      wakeId: "wake-2",
      promptSha256: "2".repeat(64),
    };
    const blocked = fixture.registry.acquireWakeLease(secondLeaseInput);
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, "wake_cooldown");
    assert.equal(blocked.cooldownExpiresAt, "2026-07-24T08:01:00.000Z");
    fixture.advance(60_000);
    const reacquired = fixture.registry.acquireWakeLease(secondLeaseInput);
    assert.equal(reacquired.acquired, true);
    assert.equal(reacquired.wakeSentAt, "2026-07-24T08:01:00.000Z");
  } finally {
    fixture.cleanup();
  }
});

test("failed-before-send reconciliation restores a confirmed batch without changing task progress", () => {
  const fixture = createFixture({ wakeLeaseMs: 300_000, wakeCooldownMs: 60_000 });
  try {
    fixture.registry.register(taskInput());
    fixture.registry.markSeen({ taskId: "task-001", expectedGeneration: 1, seq: 7, at: BASE_TIME });
    const leaseInput = {
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 7, messageAt: BASE_TIME }],
      wakeId: "wake-failed-before-send",
      promptSha256: "7".repeat(64),
    };
    const acquired = fixture.registry.acquireWakeLease(leaseInput);
    fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
      expectedWakeId: leaseInput.wakeId,
    });

    const restored = fixture.registry.reconcileFailedWake({
      taskId: "task-001",
      expectedGeneration: 1,
      wakeId: leaseInput.wakeId,
    });
    assert.equal(restored.generation, 1);
    assert.equal(restored.status, "open");
    assert.equal(restored.lastSeenSeq, 7);
    assert.equal(restored.lastAckedSeq, 0);
    assert.equal(restored.lastWakeAt, null);
    assert.deepEqual(restored.activeWakes, []);
    assert.deepEqual(restored.pendingMessages.map((message) => ({
      messageSeq: message.messageSeq,
      lastRemindedAt: message.lastRemindedAt,
    })), [{ messageSeq: 7, lastRemindedAt: null }]);

    const retried = fixture.registry.acquireWakeLease(leaseInput);
    assert.equal(retried.acquired, true);
    assert.equal(retried.reason, "acquired");
    assert.equal(retried.activeWakeId, leaseInput.wakeId);
  } finally {
    fixture.cleanup();
  }
});

test("later scans do not invalidate the token already delivered by an active wake", () => {
  const fixture = createFixture({ wakeLeaseMs: 300_000 });
  try {
    fixture.registry.register(taskInput());
    fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 10,
      at: "2026-07-24T08:00:10.000Z",
    });
    const acquired = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 10, messageAt: "2026-07-24T08:00:10.000Z" }],
      wakeId: "wake-10",
      promptSha256: "a".repeat(64),
    });
    fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 7,
      at: "2026-07-24T08:00:11.000Z",
    });
    const acknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10],
      wakeId: "wake-10",
    });
    assert.equal(acknowledged.lastSeenSeq, 7);
    assert.equal(acknowledged.lastAckedSeq, 10);
    assert.equal(acknowledged.lastAckedAt, "2026-07-24T08:00:10.000Z");
    const released = fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
      expectedWakeId: "wake-10",
    });
    assert.equal(released.wakeMessageSeq, null);
    assert.equal(released.wakeMessageAt, null);
  } finally {
    fixture.cleanup();
  }
});

test("acknowledgeWake atomically confirms only the matching wake_id and releases its lease", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 10,
      at: "2026-07-24T08:00:10.000Z",
    });
    const acquired = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{ messageSeq: 10, messageAt: "2026-07-24T08:00:10.000Z" }],
      wakeId: "wake-a",
      promptSha256: "a".repeat(64),
    });
    assert.equal(acquired.activeWakeId, "wake-a");
    assertRegistryError(
      () => fixture.registry.acknowledgeWake({
        taskId: "task-001",
        expectedGeneration: 1,
        processedMessageSeqs: [10],
        wakeId: "wake-b",
      }),
      "ACK_NOT_ACTIVE_WAKE",
    );
    const acknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10],
      wakeId: "wake-a",
    });
    assert.equal(acknowledged.lastAckedSeq, 10);
    assert.equal(acknowledged.wakePending, false);
    assert.equal(acknowledged.activeWakeId, null);
    assert.equal(acknowledged.wakePromptSha256, null);
  } finally {
    fixture.cleanup();
  }
});

test("message-level ACK accepts sparse subsets and keeps unprocessed messages pending", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const messages = [10, 11, 12].map((messageSeq) => ({
      messageSeq,
      messageAt: `2026-07-24T08:00:${messageSeq}.000Z`,
    }));
    fixture.registry.observeMessages({
      taskId: "task-001",
      expectedGeneration: 1,
      messages,
    });
    const acquired = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages,
      wakeId: "wake-sparse",
      promptSha256: "a".repeat(64),
    });
    fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
      expectedWakeId: "wake-sparse",
    });

    const acknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10, 12],
      wakeId: "wake-sparse",
    });
    assert.deepEqual(acknowledged.pendingMessages, [{
      messageSeq: 11,
      messageAt: "2026-07-24T08:00:11.000Z",
      lastRemindedAt: BASE_TIME,
    }]);
    assert.deepEqual(acknowledged.activeWakes.map((wake) => wake.messageSeqs), [[11]]);
    assert.equal(acknowledged.wakePending, true);
    assert.deepEqual(fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10, 12],
      wakeId: "wake-sparse",
    }), acknowledged);
  } finally {
    fixture.cleanup();
  }
});

test("structured reply contracts persist with pending messages and reject conflicting replay", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const observed = {
      messageSeq: 21,
      messageAt: "2026-07-24T08:00:21.000Z",
      replyRequired: true,
      expectedReply: "TASK_21_COMPLETED",
      replyDeadlineAt: "2026-07-24T12:00:00.000Z",
      nextCheckAt: "2026-07-24T08:30:00.000Z",
    };
    const task = fixture.registry.observeMessages({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [observed],
    });
    assert.deepEqual(task.pendingMessages, [{
      messageSeq: 21,
      messageAt: observed.messageAt,
      lastRemindedAt: null,
      replyRequired: true,
      expectedReply: "TASK_21_COMPLETED",
      replyDeadlineAt: "2026-07-24T12:00:00.000Z",
      nextCheckAt: "2026-07-24T08:30:00.000Z",
    }]);
    assertRegistryError(
      () => fixture.registry.observeMessages({
        taskId: "task-001",
        expectedGeneration: 1,
        messages: [{ ...observed, expectedReply: "DIFFERENT_REPLY" }],
      }),
      "MESSAGE_SEQ_CONFLICT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("legacy messages can adopt a structured reply contract exactly once", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    const legacy = {
      messageSeq: 22,
      messageAt: "2026-07-24T08:00:22.000Z",
    };
    fixture.registry.observeMessages({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [legacy],
    });
    const upgraded = fixture.registry.observeMessages({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [{
        ...legacy,
        replyRequired: true,
        expectedReply: "TASK_22_COMPLETED",
        replyDeadlineAt: "2026-07-24T12:00:00.000Z",
        nextCheckAt: "2026-07-24T08:30:00.000Z",
      }],
    });
    assert.deepEqual(upgraded.pendingMessages, [{
      messageSeq: 22,
      messageAt: legacy.messageAt,
      lastRemindedAt: null,
      replyRequired: true,
      expectedReply: "TASK_22_COMPLETED",
      replyDeadlineAt: "2026-07-24T12:00:00.000Z",
      nextCheckAt: "2026-07-24T08:30:00.000Z",
    }]);
    assertRegistryError(
      () => fixture.registry.observeMessages({
        taskId: "task-001",
        expectedGeneration: 1,
        messages: [{
          ...legacy,
          replyRequired: true,
          expectedReply: "DIFFERENT_REPLY",
          replyDeadlineAt: "2026-07-24T12:00:00.000Z",
          nextCheckAt: "2026-07-24T08:30:00.000Z",
        }],
      }),
      "MESSAGE_SEQ_CONFLICT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("a late ACK for an older wake cannot clear messages added to a newer wake", () => {
  const fixture = createFixture({ wakeCooldownMs: 30_000 });
  try {
    fixture.registry.register(taskInput());
    const message10 = { messageSeq: 10, messageAt: "2026-07-24T08:00:10.000Z" };
    fixture.registry.observeMessages({ taskId: "task-001", expectedGeneration: 1, messages: [message10] });
    const first = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [message10],
      wakeId: "wake-old",
      promptSha256: "a".repeat(64),
    });
    fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: first.wakeSentAt,
      expectedWakeId: "wake-old",
    });

    fixture.advance(30_000);
    const message11 = { messageSeq: 11, messageAt: "2026-07-24T08:00:11.000Z" };
    fixture.registry.observeMessages({ taskId: "task-001", expectedGeneration: 1, messages: [message11] });
    const second = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [message10, message11],
      wakeId: "wake-new",
      promptSha256: "b".repeat(64),
    });
    fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: second.wakeSentAt,
      expectedWakeId: "wake-new",
    });

    assertRegistryError(
      () => fixture.registry.acknowledgeWake({
        taskId: "task-001",
        expectedGeneration: 1,
        processedMessageSeqs: [10],
        wakeId: "wake-old",
      }),
      "ACK_NOT_ACTIVE_WAKE",
    );
    const afterLatestAck = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10],
      wakeId: "wake-new",
    });
    assert.deepEqual(afterLatestAck.pendingMessages.map((message) => message.messageSeq), [11]);
    assert.deepEqual(afterLatestAck.activeWakes.map((wake) => wake.messageSeqs), [[11]]);
  } finally {
    fixture.cleanup();
  }
});

test("repeated reminder wakes keep pending messages and only the latest coverage active", () => {
  const fixture = createFixture({ wakeCooldownMs: 30_000 });
  try {
    fixture.registry.register(taskInput({ wakeCooldownMs: 30_000 }));
    const message = { messageSeq: 10, messageAt: "2026-07-24T08:00:10.000Z" };
    fixture.registry.observeMessages({ taskId: "task-001", expectedGeneration: 1, messages: [message] });

    const sendWake = (wakeId, promptCharacter) => {
      const acquired = fixture.registry.acquireWakeLease({
        taskId: "task-001",
        expectedGeneration: 1,
        messages: [message],
        wakeId,
        promptSha256: promptCharacter.repeat(64),
      });
      return fixture.registry.confirmWakeSent({
        taskId: "task-001",
        expectedGeneration: 1,
        expectedWakeSentAt: acquired.wakeSentAt,
        expectedWakeId: wakeId,
      });
    };

    sendWake("wake-reminder-1", "a");
    fixture.advance(43_200_000);
    sendWake("wake-reminder-2", "b");
    fixture.advance(43_200_000);
    const latest = sendWake("wake-reminder-3", "c");

    assert.deepEqual(latest.pendingMessages.map((pending) => pending.messageSeq), [10]);
    assert.deepEqual(latest.activeWakes.map((wake) => ({
      wakeId: wake.wakeId,
      messageSeqs: wake.messageSeqs,
      status: wake.status,
    })), [{ wakeId: "wake-reminder-3", messageSeqs: [10], status: "sent" }]);

    const stored = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.deepEqual(stored.tasks["task-001"].wakeBatches.map((wake) => ({
      wakeId: wake.wakeId,
      status: wake.status,
      supersededMessageSeqs: wake.supersededMessageSeqs,
    })), [
      { wakeId: "wake-reminder-1", status: "complete", supersededMessageSeqs: [10] },
      { wakeId: "wake-reminder-2", status: "complete", supersededMessageSeqs: [10] },
      { wakeId: "wake-reminder-3", status: "sent", supersededMessageSeqs: [] },
    ]);
    assertRegistryError(
      () => fixture.registry.acknowledgeWake({
        taskId: "task-001",
        expectedGeneration: 1,
        processedMessageSeqs: [10],
        wakeId: "wake-reminder-1",
      }),
      "ACK_NOT_ACTIVE_WAKE",
    );

    const acknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10],
      wakeId: "wake-reminder-3",
    });
    assert.deepEqual(acknowledged.pendingMessages, []);
    assert.deepEqual(acknowledged.activeWakes, []);
  } finally {
    fixture.cleanup();
  }
});

test("a reminder supersedes only overlapping sent coverage and preserves disjoint wake work", () => {
  const fixture = createFixture({ wakeCooldownMs: 30_000 });
  try {
    fixture.registry.register(taskInput({ wakeCooldownMs: 30_000 }));
    const messages = [10, 11].map((messageSeq) => ({
      messageSeq,
      messageAt: `2026-07-24T08:00:${messageSeq}.000Z`,
    }));
    fixture.registry.observeMessages({ taskId: "task-001", expectedGeneration: 1, messages });
    const first = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages,
      wakeId: "wake-overlap-old",
      promptSha256: "a".repeat(64),
    });
    fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: first.wakeSentAt,
      expectedWakeId: "wake-overlap-old",
    });

    fixture.advance(43_200_000);
    const second = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [messages[0]],
      wakeId: "wake-overlap-new",
      promptSha256: "b".repeat(64),
    });
    const reminded = fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: second.wakeSentAt,
      expectedWakeId: "wake-overlap-new",
    });

    assert.deepEqual(reminded.pendingMessages.map((pending) => pending.messageSeq), [10, 11]);
    assert.deepEqual(reminded.activeWakes.map((wake) => ({ wakeId: wake.wakeId, messageSeqs: wake.messageSeqs })), [
      { wakeId: "wake-overlap-old", messageSeqs: [11] },
      { wakeId: "wake-overlap-new", messageSeqs: [10] },
    ]);
    assertRegistryError(
      () => fixture.registry.acknowledgeWake({
        taskId: "task-001",
        expectedGeneration: 1,
        processedMessageSeqs: [10],
        wakeId: "wake-overlap-old",
      }),
      "ACK_MESSAGE_MISMATCH",
    );

    const oldAcknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [11],
      wakeId: "wake-overlap-old",
    });
    assert.deepEqual(oldAcknowledged.pendingMessages.map((pending) => pending.messageSeq), [10]);
    assert.deepEqual(oldAcknowledged.activeWakes.map((wake) => ({ wakeId: wake.wakeId, messageSeqs: wake.messageSeqs })), [
      { wakeId: "wake-overlap-new", messageSeqs: [10] },
    ]);

    const latestAcknowledged = fixture.registry.acknowledgeWake({
      taskId: "task-001",
      expectedGeneration: 1,
      processedMessageSeqs: [10],
      wakeId: "wake-overlap-new",
    });
    assert.deepEqual(latestAcknowledged.pendingMessages, []);
    assert.deepEqual(latestAcknowledged.activeWakes, []);
  } finally {
    fixture.cleanup();
  }
});

test("different wake batches cannot hold concurrent live injection leases", () => {
  const fixture = createFixture({ wakeLeaseMs: 30_000 });
  try {
    fixture.registry.register(taskInput());
    const messages = [
      { messageSeq: 10, messageAt: "2026-07-24T08:00:10.000Z" },
      { messageSeq: 11, messageAt: "2026-07-24T08:00:11.000Z" },
    ];
    fixture.registry.observeMessages({ taskId: "task-001", expectedGeneration: 1, messages });
    fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages: [messages[0]],
      wakeId: "wake-a",
      promptSha256: "a".repeat(64),
    });
    const blocked = fixture.registry.acquireWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      messages,
      wakeId: "wake-b",
      promptSha256: "b".repeat(64),
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, "lease_active");
    assert.equal(blocked.leaseExpiresAt, "2026-07-24T08:00:30.000Z");
  } finally {
    fixture.cleanup();
  }
});

test("separate instances observe one locked state and respect lock timeout", () => {
  const fixture = createFixture();
  try {
    const secondInstance = fixture.createRegistry({ lockTimeoutMs: 30, lockRetryMs: 5 });
    fixture.registry.register(taskInput({ taskId: "task-a", conversationId: "conversation-a" }));
    secondInstance.register(taskInput({ taskId: "task-b", conversationId: "conversation-b" }));
    assert.deepEqual(fixture.registry.list().map((task) => task.taskId), ["task-a", "task-b"]);
    assert.deepEqual(secondInstance.list().map((task) => task.taskId), ["task-a", "task-b"]);

    fs.mkdirSync(path.dirname(secondInstance.lockPath), { recursive: true });
    fs.writeFileSync(secondInstance.lockPath, "held\n", "utf8");
    assertRegistryError(
      () => secondInstance.register(taskInput({ taskId: "task-c", conversationId: "conversation-c" })),
      "LOCK_TIMEOUT",
    );
    fs.unlinkSync(secondInstance.lockPath);
    assert.equal(fixture.registry.get("task-c"), null);
  } finally {
    fixture.cleanup();
  }
});

test("stale lock from a dead process is recovered", () => {
  const fixture = createFixture();
  try {
    const recoveringRegistry = fixture.createRegistry({ staleLockMs: 1000 });
    fs.mkdirSync(path.dirname(recoveringRegistry.lockPath), { recursive: true });
    fs.writeFileSync(recoveringRegistry.lockPath, `${JSON.stringify({
      pid: 2147483647,
      createdAt: "2020-01-01T00:00:00.000Z",
    })}\n`, "utf8");
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(recoveringRegistry.lockPath, oldTime, oldTime);
    const task = recoveringRegistry.register(taskInput());
    assert.equal(task.taskId, "task-001");
    assert.equal(fs.existsSync(recoveringRegistry.lockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("corrupted JSON is rejected without overwriting the state file", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.statePath), { recursive: true });
    const corrupted = "{\"schemaVersion\":1,\"tasks\":";
    fs.writeFileSync(fixture.statePath, corrupted, "utf8");
    assertRegistryError(() => fixture.registry.register(taskInput()), "INVALID_STATE");
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), corrupted);
    assertRegistryError(() => fixture.registry.list(), "INVALID_STATE");
    assert.equal(fs.readFileSync(fixture.statePath, "utf8"), corrupted);
  } finally {
    fixture.cleanup();
  }
});
