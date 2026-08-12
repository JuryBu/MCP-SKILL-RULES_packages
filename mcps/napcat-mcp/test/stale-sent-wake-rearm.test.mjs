import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendOnlyFileSnapshot,
  createBackup,
  injectWakeAfterMaintenanceRelease,
  restoreBackup,
  verifyAppendOnlyFileSnapshot,
} from "../ops/rearm-stale-sent-wake.mjs";
import { createTaskRegistry } from "../src/task-registry.mjs";
import {
  buildRearmWakePrompt,
  createStaleSentWakeRearmPlan,
  StaleSentWakeRearmError,
  verifyRearmedTask,
} from "../src/stale-sent-wake-rearm.mjs";

function fixture() {
  const pending = [10, 11].map((messageSeq, index) => ({
    messageSeq,
    messageAt: `2026-08-11T00:00:0${index}.000Z`,
    status: "pending",
    lastRemindedAt: "2026-08-11T01:00:00.000Z",
  }));
  const wake = (wakeId, sequences, at) => ({
    wakeId,
    messageSeqs: sequences,
    messageTimes: sequences.map((sequence) => pending.find((message) => message.messageSeq === sequence).messageAt),
    boundaryMessageSeq: sequences.at(-1),
    boundaryMessageAt: pending.find((message) => message.messageSeq === sequences.at(-1)).messageAt,
    leaseStartedAt: at,
    sentAt: at,
    promptSha256: "a".repeat(64),
    status: "sent",
    acknowledgedSeqs: [],
    legacy: false,
  });
  return {
    schemaVersion: 2,
    tasks: {
      task: {
        taskId: "task",
        conversationId: "conversation",
        localRole: "training",
        sourceMachine: "development",
        targetMachine: "training",
        trustedPeerQq: "1",
        generation: 1,
        status: "open",
        lastSeenSeq: 11,
        lastAckedSeq: 0,
        lastSeenAt: pending[1].messageAt,
        lastAckedAt: null,
        wakeCooldownMs: 60000,
        wakePending: true,
        wakeSentAt: "2026-08-11T01:00:01.000Z",
        wakeMessageSeq: 11,
        wakeMessageAt: pending[1].messageAt,
        activeWakeId: "wake-new",
        wakePromptSha256: "a".repeat(64),
        lastWakeAt: "2026-08-11T01:00:01.000Z",
        ledgerInitialized: true,
        messageLedger: pending,
        wakeBatches: [
          wake("wake-old", [10], "2026-08-11T01:00:00.000Z"),
          wake("wake-new", [10, 11], "2026-08-11T01:00:01.000Z"),
        ],
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T01:00:01.000Z",
      },
    },
  };
}

test("rearm plan preserves business state and archives all sent wakes", () => {
  const state = fixture();
  const plan = createStaleSentWakeRearmPlan({
    state,
    taskId: "task",
    expectedGeneration: 1,
    expectedConversationId: "conversation",
    expectedPendingSeqs: [10, 11],
    expectedActiveWakeIds: ["wake-old", "wake-new"],
    expectedLatestWakeId: "wake-new",
    preparedAt: "2026-08-11T02:00:00.000Z",
  });
  const next = structuredClone(state);
  plan.apply(next, "2026-08-11T02:00:01.000Z");
  const task = next.tasks.task;
  assert.deepEqual(plan.archivedWakes.map((wake) => wake.wakeId), ["wake-old", "wake-new"]);
  assert.deepEqual(task.messageLedger.map(({ messageSeq, messageAt, status }) => ({ messageSeq, messageAt, status })), [
    { messageSeq: 10, messageAt: "2026-08-11T00:00:00.000Z", status: "pending" },
    { messageSeq: 11, messageAt: "2026-08-11T00:00:01.000Z", status: "pending" },
  ]);
  assert.deepEqual(task.messageLedger.map((message) => message.lastRemindedAt), [null, null]);
  assert.deepEqual(task.wakeBatches, []);
  assert.equal(task.generation, 1);
  assert.equal(task.conversationId, "conversation");
  assert.equal(task.lastSeenSeq, 11);
  assert.equal(task.lastAckedSeq, 0);
  assert.equal(task.wakePending, false);
  assert.equal(task.activeWakeId, null);
});

test("rearm rejects pending or wake identity drift", () => {
  const state = fixture();
  assert.throws(() => createStaleSentWakeRearmPlan({
    state,
    taskId: "task",
    expectedGeneration: 1,
    expectedConversationId: "conversation",
    expectedPendingSeqs: [10],
    expectedActiveWakeIds: ["wake-old", "wake-new"],
  }), (error) => error instanceof StaleSentWakeRearmError && error.code === "INVARIANT_MISMATCH");
  assert.throws(() => createStaleSentWakeRearmPlan({
    state,
    taskId: "task",
    expectedGeneration: 1,
    expectedConversationId: "conversation",
    expectedPendingSeqs: [10, 11],
    expectedActiveWakeIds: ["wake-new"],
  }), (error) => error instanceof StaleSentWakeRearmError && error.code === "INVARIANT_MISMATCH");
});

test("rearm rejects leased wakes and incomplete latest coverage", () => {
  const leased = fixture();
  leased.tasks.task.wakeBatches[0].status = "leased";
  leased.tasks.task.wakeBatches[0].sentAt = null;
  assert.throws(() => createStaleSentWakeRearmPlan({
    state: leased,
    taskId: "task",
    expectedGeneration: 1,
    expectedConversationId: "conversation",
  }), (error) => error instanceof StaleSentWakeRearmError && error.code === "WAKE_NOT_SENT");
  const incomplete = fixture();
  incomplete.tasks.task.wakeBatches[1].messageSeqs = [11];
  incomplete.tasks.task.wakeBatches[1].messageTimes = ["2026-08-11T00:00:01.000Z"];
  assert.throws(() => createStaleSentWakeRearmPlan({
    state: incomplete,
    taskId: "task",
    expectedGeneration: 1,
    expectedConversationId: "conversation",
  }), (error) => error instanceof StaleSentWakeRearmError && error.code === "INVARIANT_MISMATCH");
});

test("new wake verification requires one sent wake with exact coverage", () => {
  const state = fixture();
  const plan = createStaleSentWakeRearmPlan({
    state,
    taskId: "task",
    expectedGeneration: 1,
    expectedConversationId: "conversation",
  });
  const task = {
    ...plan.before,
    pendingMessages: plan.before.pending.map(({ messageSeq, messageAt }) => ({ messageSeq, messageAt, lastRemindedAt: "2026-08-11T02:00:00.000Z" })),
    activeWakes: [{ wakeId: "wake-rearmed", messageSeqs: [10, 11], status: "sent" }],
  };
  assert.deepEqual(verifyRearmedTask(task, plan, "wake-rearmed"), {
    pendingCount: 2,
    activeWakeCount: 1,
    wakeId: "wake-rearmed",
  });
  task.activeWakes.push({ wakeId: "wake-extra", messageSeqs: [10, 11], status: "sent" });
  assert.throws(() => verifyRearmedTask(task, plan, "wake-rearmed"), (error) => error.code === "REARM_WAKE_COUNT_MISMATCH");
});

test("rearm prompt is explicit that no new business may start", () => {
  const state = fixture();
  const plan = createStaleSentWakeRearmPlan({ state, taskId: "task", expectedGeneration: 1, expectedConversationId: "conversation" });
  const prompt = buildRearmWakePrompt(plan.before, plan.before.pending, "wake-rearmed");
  assert.match(prompt, /pending_message_seqs=\[10,11\]/);
  assert.match(prompt, /wake_id=wake-rearmed/);
  assert.match(prompt, /不是新增业务/);
  assert.match(prompt, /不要启动新的业务批次/);
});

test("rearmed schema remains compatible and accepts one random wake", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-schema-"));
  try {
    const state = fixture();
    const plan = createStaleSentWakeRearmPlan({ state, taskId: "task", expectedGeneration: 1, expectedConversationId: "conversation" });
    plan.apply(state, "2026-08-11T02:00:00.000Z");
    const statePath = path.join(root, "task-registry.json");
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const registry = createTaskRegistry({ statePath, now: () => new Date("2026-08-11T02:00:01.000Z") });
    const messages = plan.before.pending.map(({ messageSeq, messageAt }) => ({ messageSeq, messageAt }));
    const lease = registry.acquireWakeLease({
      taskId: "task",
      expectedGeneration: 1,
      messages,
      wakeId: "wake-random",
      promptSha256: "b".repeat(64),
    });
    assert.equal(lease.acquired, true);
    registry.confirmWakeSent({
      taskId: "task",
      expectedGeneration: 1,
      expectedWakeSentAt: lease.wakeSentAt,
      expectedWakeId: "wake-random",
    });
    assert.deepEqual(verifyRearmedTask(registry.get("task"), plan, "wake-random"), {
      pendingCount: 2,
      activeWakeCount: 1,
      wakeId: "wake-random",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registry rearm and rollback share the ledger lock and restore exact bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-lock-"));
  try {
    const statePath = path.join(root, "task-registry.json");
    fs.writeFileSync(statePath, `${JSON.stringify(fixture(), null, 2)}\n`, "utf8");
    const original = fs.readFileSync(statePath);
    const registry = createTaskRegistry({ statePath, now: () => new Date("2026-08-11T02:00:00.000Z") });
    const rearmed = registry.rearmStaleSentWakes({
      taskId: "task",
      expectedGeneration: 1,
      expectedConversationId: "conversation",
      expectedPendingSeqs: [10, 11],
      expectedActiveWakeIds: ["wake-old", "wake-new"],
      expectedLatestWakeId: "wake-new",
      newWakeId: "wake-random",
      promptSha256: "b".repeat(64),
    });
    assert.equal(rearmed.task.activeWakes.length, 1);
    assert.equal(rearmed.task.activeWakes[0].wakeId, "wake-random");
    assert.equal(rearmed.task.activeWakes[0].status, "leased");
    registry.rollbackStaleSentWakeRearm({
      taskId: "task",
      expectedGeneration: 1,
      expectedPendingSeqs: [10, 11],
      newWakeId: "wake-random",
      rollback: rearmed.rollback,
    });
    assert.deepEqual(fs.readFileSync(statePath), original);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("three-file backup restores exact original bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-backup-"));
  try {
    const paths = {
      registry: path.join(root, "task-registry.json"),
      dedupe: path.join(root, "dedupe.json"),
      log: path.join(root, "task-router.jsonl"),
    };
    const original = {
      registry: Buffer.from("registry-original\n", "utf8"),
      dedupe: Buffer.from("dedupe-original\n", "utf8"),
      log: Buffer.from("log-original\n", "utf8"),
    };
    for (const name of Object.keys(paths)) fs.writeFileSync(paths[name], original[name]);
    const backupRoot = path.join(root, "backups");
    fs.mkdirSync(backupRoot);
    const backupPath = createBackup({ schemaVersion: 1 }, paths, backupRoot);
    for (const name of Object.keys(paths)) fs.writeFileSync(paths[name], `${name}-changed\n`, "utf8");
    restoreBackup(paths, backupPath);
    for (const name of Object.keys(paths)) assert.deepEqual(fs.readFileSync(paths[name]), original[name]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("append-only log accepts a legitimate tail while preserving its prepared prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-log-append-"));
  try {
    const logPath = path.join(root, "task-router.jsonl");
    fs.writeFileSync(logPath, "prepared\n", "utf8");
    const snapshot = appendOnlyFileSnapshot(logPath);
    fs.appendFileSync(logPath, "later-scan\n", "utf8");
    const verified = verifyAppendOnlyFileSnapshot(snapshot, logPath);
    assert.equal(verified.appendedBytes, Buffer.byteLength("later-scan\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("append-only log rejects prepared-prefix tampering and truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-log-drift-"));
  try {
    const logPath = path.join(root, "task-router.jsonl");
    fs.writeFileSync(logPath, "prepared\n", "utf8");
    const snapshot = appendOnlyFileSnapshot(logPath);
    fs.writeFileSync(logPath, "tampered\nlater\n", "utf8");
    assert.throws(() => verifyAppendOnlyFileSnapshot(snapshot, logPath), /既有前缀已变化/);
    fs.writeFileSync(logPath, "short\n", "utf8");
    assert.throws(() => verifyAppendOnlyFileSnapshot(snapshot, logPath), /已截断/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("append-only log rejects replacement even when bytes match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-log-identity-"));
  try {
    const logPath = path.join(root, "task-router.jsonl");
    const displacedPath = path.join(root, "task-router.old.jsonl");
    fs.writeFileSync(logPath, "prepared\n", "utf8");
    const snapshot = appendOnlyFileSnapshot(logPath);
    fs.renameSync(logPath, displacedPath);
    fs.writeFileSync(logPath, "prepared\n", "utf8");
    assert.throws(() => verifyAppendOnlyFileSnapshot(snapshot, logPath), /身份已变化/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stable rollback does not erase append-only log records written after backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-rearm-log-rollback-"));
  try {
    const paths = {
      registry: path.join(root, "task-registry.json"),
      dedupe: path.join(root, "dedupe.json"),
      log: path.join(root, "task-router.jsonl"),
    };
    fs.writeFileSync(paths.registry, "registry-original\n", "utf8");
    fs.writeFileSync(paths.dedupe, "dedupe-original\n", "utf8");
    fs.writeFileSync(paths.log, "log-original\n", "utf8");
    const backupRoot = path.join(root, "backups");
    fs.mkdirSync(backupRoot);
    const backupPath = createBackup({ schemaVersion: 1 }, paths, backupRoot);
    fs.writeFileSync(paths.dedupe, "dedupe-changed\n", "utf8");
    fs.appendFileSync(paths.log, "legitimate-tail\n", "utf8");
    restoreBackup({ dedupe: paths.dedupe }, backupPath);
    assert.equal(fs.readFileSync(paths.dedupe, "utf8"), "dedupe-original\n");
    assert.equal(fs.readFileSync(paths.log, "utf8"), "log-original\nlegitimate-tail\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("controlled injection releases maintenance and restores it on failure", async () => {
  let maintenanceActive = true;
  const accepted = await injectWakeAfterMaintenanceRelease({
    releaseMaintenance: () => { maintenanceActive = false; },
    restoreMaintenance: () => { maintenanceActive = true; },
    injectWake: async () => {
      assert.equal(maintenanceActive, false);
      return { outcome: "accepted" };
    },
  });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(maintenanceActive, false);

  maintenanceActive = true;
  await assert.rejects(() => injectWakeAfterMaintenanceRelease({
    releaseMaintenance: () => { maintenanceActive = false; },
    restoreMaintenance: () => { maintenanceActive = true; },
    injectWake: async () => {
      assert.equal(maintenanceActive, false);
      throw new Error("injection failed");
    },
  }), /injection failed/);
  assert.equal(maintenanceActive, true);
});
