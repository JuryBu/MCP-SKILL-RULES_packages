import assert from "node:assert/strict";
import test from "node:test";
import { createTaskRouter } from "../src/task-router.mjs";

function task(overrides = {}) {
  return {
    taskId: "语音处理",
    conversationId: "thread-example-primary",
    localRole: "training",
    sourceMachine: "development",
    targetMachine: "training",
    trustedPeerQq: "1000000003",
    generation: 1,
    status: "open",
    lastSeenSeq: 0,
    lastAckedSeq: 0,
    wakeCooldownMs: 600_000,
    wakePending: false,
    wakeSentAt: null,
    lastWakeAt: null,
    ...overrides,
  };
}

function message(sequence, overrides = {}) {
  return {
    messageId: String(sequence),
    messageSeq: String(sequence),
    senderId: "1000000003",
    isSelf: false,
    taskId: "语音处理",
    sourceMachine: "development",
    targetMachine: "training",
    text: "测试消息",
    attachments: [],
    ...overrides,
  };
}

function fixture(options = {}) {
  let currentTask = task(options.task);
  const calls = [];
  const registry = {
    list: () => currentTask.status === "open" ? [{ ...currentTask }] : [],
    markSeen: (input) => {
      calls.push({ type: "markSeen", input });
      currentTask = { ...currentTask, lastSeenSeq: Math.max(currentTask.lastSeenSeq, input.seq) };
      return { ...currentTask };
    },
    acquireWakeLease: (input) => {
      calls.push({ type: "acquireWakeLease", input });
      if (options.leaseBlocked) {
        return { ...currentTask, acquired: false, reason: options.leaseReason ?? "lease_active" };
      }
      currentTask = { ...currentTask, wakePending: true, wakeSentAt: "2026-07-24T08:00:00.000Z" };
      return { ...currentTask, acquired: true, reason: "acquired" };
    },
    confirmWakeSent: (input) => {
      calls.push({ type: "confirmWakeSent", input });
      currentTask = { ...currentTask, lastWakeAt: currentTask.wakeSentAt };
      return { ...currentTask };
    },
    releaseWakeLease: (input) => {
      calls.push({ type: "releaseWakeLease", input });
      currentTask = { ...currentTask, wakePending: false, wakeSentAt: null };
      return { ...currentTask };
    },
  };
  const notifier = {
    readRecentMessages: async () => ({
      scannedCount: (options.messages ?? [message(10)]).length,
      messages: options.messages ?? [message(10)],
    }),
  };
  const bridge = {
    wake: async (input) => {
      calls.push({ type: "wake", input });
      if (options.wakeError) throw options.wakeError;
      return options.wakeResult ?? { outcome: "accepted", status: "busy", started: true, turn: { id: "turn-1" } };
    },
  };
  return { registry, notifier, bridge, calls, getTask: () => currentTask };
}

test("multiple eligible messages coalesce into one wake", async () => {
  const current = fixture({ messages: [message(10), message(12), message(11)] });
  const router = createTaskRouter(current);
  const result = await router.scanOnce();
  assert.equal(result.wakeCount, 1);
  assert.equal(result.results[0].maximumSequence, 12);
  assert.equal(current.calls.filter((call) => call.type === "wake").length, 1);
  assert.match(current.calls.find((call) => call.type === "wake").input.prompt, /task_id=语音处理/);
  assert.match(current.calls.find((call) => call.type === "wake").input.prompt, /pending_through_message_seq=12/);
  assert.equal(current.getTask().wakePending, true);
});

test("self, untrusted, wrong-task, and wrong-machine messages never wake", async () => {
  const current = fixture({ messages: [
    message(10, { isSelf: true }),
    message(11, { senderId: "999" }),
    message(12, { taskId: "数字图像处理" }),
    message(13, { targetMachine: "development" }),
  ] });
  const result = await createTaskRouter(current).scanOnce();
  assert.equal(result.results[0].outcome, "no_new_message");
  assert.equal(current.calls.some((call) => call.type === "wake"), false);
});

test("acknowledged messages and active leases suppress duplicate wake", async () => {
  const acknowledged = fixture({ task: { lastSeenSeq: 10, lastAckedSeq: 10 }, messages: [message(10)] });
  assert.equal((await createTaskRouter(acknowledged).scanOnce()).results[0].outcome, "no_new_message");
  const leased = fixture({ leaseBlocked: true, messages: [message(11)] });
  assert.equal((await createTaskRouter(leased).scanOnce()).results[0].outcome, "lease_active");
  assert.equal(leased.calls.some((call) => call.type === "wake"), false);
  const cooldown = fixture({ leaseBlocked: true, leaseReason: "wake_cooldown", messages: [message(12)] });
  assert.equal((await createTaskRouter(cooldown).scanOnce()).results[0].outcome, "wake_cooldown");
  assert.equal(cooldown.calls.some((call) => call.type === "wake"), false);
});

test("busy or unavailable threads release the lease", async () => {
  for (const wakeResult of [
    { outcome: "busy", status: "busy", started: false },
    { outcome: "unknown", status: "not_found", started: null, reason: "thread_not_found" },
  ]) {
    const current = fixture({ wakeResult });
    const result = await createTaskRouter(current).scanOnce();
    assert.equal(["thread_busy", "thread_unavailable"].includes(result.results[0].outcome), true);
    assert.equal(current.getTask().wakePending, false);
  }
});

test("unknown mutating outcome keeps lease while known failure releases it", async () => {
  const unknown = fixture({ wakeResult: {
    outcome: "unknown",
    status: "unknown",
    started: null,
    error: { code: "APP_SERVER_TIMEOUT", outcomeUnknown: true },
  } });
  assert.equal((await createTaskRouter(unknown).scanOnce()).results[0].outcome, "wake_unknown");
  assert.equal(unknown.getTask().wakePending, true);

  const failure = fixture({ wakeError: Object.assign(new Error("known failure"), { code: "APP_SERVER_RPC_ERROR" }) });
  assert.equal((await createTaskRouter(failure).scanOnce()).results[0].outcome, "wake_failed");
  assert.equal(failure.getTask().wakePending, false);
});

test("multiple open tasks share one fixed-group history read", async () => {
  const tasks = [
    task({ taskId: "语音处理", conversationId: "thread-a" }),
    task({ taskId: "数字图像处理", conversationId: "thread-b" }),
  ];
  let readCount = 0;
  const wakes = [];
  const registry = {
    list: () => tasks.map((item) => ({ ...item })),
    markSeen: ({ taskId, seq }) => ({ ...tasks.find((item) => item.taskId === taskId), lastSeenSeq: seq }),
    acquireWakeLease: ({ taskId }) => ({
      ...tasks.find((item) => item.taskId === taskId),
      acquired: true,
      reason: "acquired",
      wakeSentAt: "2026-07-24T08:00:00.000Z",
    }),
    confirmWakeSent: () => {},
    releaseWakeLease: () => {},
  };
  const notifier = {
    async readRecentMessages() {
      readCount += 1;
      return {
        scannedCount: 2,
        messages: [message(10), message(11, { taskId: "数字图像处理" })],
      };
    },
  };
  const bridge = {
    async wake(input) {
      wakes.push(input);
      return { outcome: "accepted", status: "busy", started: true, turn: { id: `turn-${wakes.length}` } };
    },
  };
  const result = await createTaskRouter({ registry, notifier, bridge }).scanOnce();
  assert.equal(readCount, 1);
  assert.equal(result.wakeCount, 2);
  assert.deepEqual(wakes.map((entry) => entry.threadId), ["thread-a", "thread-b"]);
});
