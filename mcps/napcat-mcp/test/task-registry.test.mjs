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
      "lastWakeAt",
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
    assert.equal(first.lastWakeAt, null);
    assert.equal(first.createdAt, BASE_TIME);
    assert.equal(first.updatedAt, BASE_TIME);

    const repeated = fixture.registry.register(taskInput({ localRole: "training" }));
    assert.deepEqual(repeated, first);
    assert.deepEqual(fixture.registry.get("task-001"), first);

    assertRegistryError(
      () => fixture.registry.register(taskInput({ conversationId: "conversation-002" })),
      "TASK_CONVERSATION_CONFLICT",
    );
    assert.deepEqual(fixture.registry.get("task-001"), first);
    const stateDirectory = path.dirname(fixture.statePath);
    assert.deepEqual(fs.readdirSync(stateDirectory).filter((name) => name.endsWith(".tmp")), []);
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

test("close is idempotent and list/get return complete public records", () => {
  const fixture = createFixture();
  try {
    fixture.registry.register(taskInput());
    fixture.registry.register(taskInput({ taskId: "task-002", conversationId: "conversation-002" }));
    const closed = fixture.registry.close({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(closed.status, "closed");
    assert.equal(closed.wakePending, false);
    assert.equal(closed.wakeSentAt, null);
    const closedLease = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(closedLease.acquired, false);
    assert.equal(closedLease.reason, "closed");
    assert.deepEqual(fixture.registry.close({ taskId: "task-001", expectedGeneration: 1 }), closed);
    assert.equal(fixture.registry.get("missing-task"), null);
    assert.deepEqual(fixture.registry.list({ status: "closed" }).map((task) => task.taskId), ["task-001"]);
    assert.deepEqual(fixture.registry.list({ status: "open" }).map((task) => task.taskId), ["task-002"]);
    assert.deepEqual(fixture.registry.list().map((task) => task.taskId), ["task-001", "task-002"]);
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
      seq: 3,
      at: "2026-07-24T08:00:09.000Z",
    });
    assert.equal(acquired.wakeMessageSeq, 3);
    const acknowledged = fixture.registry.ack({ taskId: "task-001", expectedGeneration: 1, seq: 3 });
    assert.equal(acknowledged.lastAckedSeq, 3);
    assert.equal(acknowledged.lastAckedAt, "2026-07-24T08:00:09.000Z");
    fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
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
      seq: 2,
      at: "2026-07-24T08:00:10.000Z",
    });
    assertRegistryError(
      () => fixture.registry.ack({ taskId: "task-001", expectedGeneration: 1, seq: 3 }),
      "ACK_NOT_ACTIVE_WAKE",
    );
    assertRegistryError(
      () => fixture.registry.ack({ taskId: "task-001", expectedGeneration: 2, seq: 3 }),
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
    const acquired = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.reason, "acquired");
    assert.equal(acquired.wakePending, true);
    assert.equal(acquired.wakeSentAt, BASE_TIME);
    assert.equal(acquired.wakeMessageSeq, null);
    assert.equal(acquired.wakeMessageAt, null);
    assert.equal(acquired.leaseExpiresAt, "2026-07-24T08:00:01.000Z");

    const blocked = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, "lease_active");
    assert.equal(blocked.wakeSentAt, BASE_TIME);

    fixture.advance(1000);
    const reacquired = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(reacquired.acquired, true);
    assert.equal(reacquired.wakeSentAt, "2026-07-24T08:00:01.000Z");
    const released = fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: reacquired.wakeSentAt,
    });
    assert.equal(released.wakePending, false);
    assert.equal(released.wakeSentAt, null);
    assert.equal(released.wakeMessageSeq, null);
    assert.equal(released.wakeMessageAt, null);
    assert.deepEqual(fixture.registry.releaseWakeLease({ taskId: "task-001", expectedGeneration: 1 }), released);
  } finally {
    fixture.cleanup();
  }
});

test("a confirmed wake remains cooldown-limited after ACK releases its lease", () => {
  const fixture = createFixture({ wakeLeaseMs: 300_000, wakeCooldownMs: 60_000 });
  try {
    fixture.registry.register(taskInput());
    const acquired = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    const confirmed = fixture.registry.confirmWakeSent({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
    });
    assert.equal(confirmed.lastWakeAt, BASE_TIME);
    fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
    });
    const blocked = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, "wake_cooldown");
    assert.equal(blocked.cooldownExpiresAt, "2026-07-24T08:01:00.000Z");
    fixture.advance(60_000);
    const reacquired = fixture.registry.acquireWakeLease({ taskId: "task-001", expectedGeneration: 1 });
    assert.equal(reacquired.acquired, true);
    assert.equal(reacquired.wakeSentAt, "2026-07-24T08:01:00.000Z");
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
      seq: 10,
      at: "2026-07-24T08:00:10.000Z",
    });
    fixture.registry.markSeen({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 7,
      at: "2026-07-24T08:00:11.000Z",
    });
    const acknowledged = fixture.registry.ack({
      taskId: "task-001",
      expectedGeneration: 1,
      seq: 10,
    });
    assert.equal(acknowledged.lastSeenSeq, 7);
    assert.equal(acknowledged.lastAckedSeq, 10);
    assert.equal(acknowledged.lastAckedAt, "2026-07-24T08:00:10.000Z");
    const released = fixture.registry.releaseWakeLease({
      taskId: "task-001",
      expectedGeneration: 1,
      expectedWakeSentAt: acquired.wakeSentAt,
    });
    assert.equal(released.wakeMessageSeq, null);
    assert.equal(released.wakeMessageAt, null);
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
