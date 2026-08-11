import crypto from "node:crypto";

export class StaleSentWakeRearmError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "StaleSentWakeRearmError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new StaleSentWakeRearmError(code, message, details);
}

function exactArray(actual, expected, name) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) fail("INVARIANT_MISMATCH", `${name} 必须是数组`);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail("INVARIANT_MISMATCH", `${name} 与计划不一致`, { actual, expected });
  }
}

function pendingMessages(task) {
  return task.messageLedger.filter((message) => message.status === "pending");
}

function activeWakes(task, pendingSet) {
  return task.wakeBatches.filter((wake) =>
    wake.status !== "complete" && wake.messageSeqs.some((sequence) => pendingSet.has(sequence))
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function buildRearmWakePrompt(task, pending, wakeId) {
  const sequences = pending.map((message) => message.messageSeq);
  return [
    "[NAPCAT_TASK_WAKE]",
    `task_id=${task.taskId}`,
    `generation=${task.generation}`,
    `pending_message_seqs=${JSON.stringify(sequences)}`,
    `new_message_seqs=${JSON.stringify(sequences)}`,
    "previously_pending_message_seqs=[]",
    `pending_through_message_seq=${sequences.at(-1)}`,
    `wake_id=${wakeId}`,
    "这是维护系统对既有待办的重新提醒，不是新增业务。请只读逐条核对这些 message_seq 对应的现有消息；完成一条或多条后调用 napcat_task_ack，原样回传 generation、wake_id，并在 processed_message_seqs 中只列实际处理完成的消息。未列出的消息继续待处理；不要启动新的业务批次。",
  ].join("\n");
}

export function createStaleSentWakeRearmPlan(input) {
  const state = clone(input.state);
  const task = state.tasks?.[input.taskId];
  if (!task) fail("TASK_NOT_FOUND", `任务不存在：${input.taskId}`);
  if (task.status !== "open") fail("TASK_NOT_OPEN", `任务不是 open：${input.taskId}`);
  if (task.generation !== input.expectedGeneration) {
    fail("GENERATION_MISMATCH", "任务代次与请求不一致", { actual: task.generation, expected: input.expectedGeneration });
  }
  if (task.conversationId !== input.expectedConversationId) {
    fail("CONVERSATION_MISMATCH", "任务对话绑定与请求不一致", { actual: task.conversationId, expected: input.expectedConversationId });
  }
  const pending = pendingMessages(task);
  if (!pending.length) fail("NO_PENDING_MESSAGES", "任务没有待处理消息");
  const pendingSeqs = pending.map((message) => message.messageSeq);
  if (input.expectedPendingSeqs) exactArray(pendingSeqs, input.expectedPendingSeqs, "pending message_seq");
  const pendingSet = new Set(pendingSeqs);
  const wakes = activeWakes(task, pendingSet);
  if (!wakes.length) fail("NO_ACTIVE_WAKES", "任务没有活动唤醒");
  if (wakes.some((wake) => wake.status !== "sent" || !wake.sentAt)) {
    fail("WAKE_NOT_SENT", "只允许重新提醒全部处于 sent 状态的唤醒", {
      wakes: wakes.map((wake) => ({ wakeId: wake.wakeId, status: wake.status, sentAt: wake.sentAt })),
    });
  }
  const wakeIds = wakes.map((wake) => wake.wakeId);
  if (input.expectedActiveWakeIds) exactArray(wakeIds, input.expectedActiveWakeIds, "active wake_id");
  const latest = [...wakes].sort((left, right) => Date.parse(left.leaseStartedAt) - Date.parse(right.leaseStartedAt)).at(-1);
  const latestCoverage = latest.messageSeqs.filter((sequence) => pendingSet.has(sequence));
  exactArray(latestCoverage, pendingSeqs, "latest wake coverage");
  if (input.expectedLatestWakeId && latest.wakeId !== input.expectedLatestWakeId) {
    fail("LATEST_WAKE_MISMATCH", "最新 wake_id 与计划不一致", { actual: latest.wakeId, expected: input.expectedLatestWakeId });
  }
  const activeIdSet = new Set(wakeIds);
  const before = {
    taskId: task.taskId,
    conversationId: task.conversationId,
    generation: task.generation,
    localRole: task.localRole,
    sourceMachine: task.sourceMachine,
    targetMachine: task.targetMachine,
    trustedPeerQq: task.trustedPeerQq,
    status: task.status,
    lastSeenSeq: task.lastSeenSeq,
    lastAckedSeq: task.lastAckedSeq,
    pending: clone(pending),
    wakeIds,
    latestWakeId: latest.wakeId,
  };
  const rollback = {
    wakeBatches: clone(task.wakeBatches),
    reminders: pending.map((message) => ({ messageSeq: message.messageSeq, lastRemindedAt: message.lastRemindedAt })),
    wakePending: task.wakePending,
    wakeSentAt: task.wakeSentAt,
    wakeMessageSeq: task.wakeMessageSeq,
    wakeMessageAt: task.wakeMessageAt,
    activeWakeId: task.activeWakeId,
    wakePromptSha256: task.wakePromptSha256,
    lastWakeAt: task.lastWakeAt,
    updatedAt: task.updatedAt,
  };
  return {
    schemaVersion: 1,
    preparedAt: input.preparedAt,
    taskId: task.taskId,
    expectedGeneration: task.generation,
    expectedConversationId: task.conversationId,
    expectedPendingSeqs: pendingSeqs,
    expectedActiveWakeIds: wakeIds,
    expectedLatestWakeId: latest.wakeId,
    before,
    rollback,
    archivedWakes: clone(wakes),
    apply(nextState, now) {
      const nextTask = nextState.tasks[task.taskId];
      nextTask.wakeBatches = nextTask.wakeBatches.filter((wake) => !activeIdSet.has(wake.wakeId));
      for (const message of nextTask.messageLedger) {
        if (message.status === "pending" && pendingSet.has(message.messageSeq)) message.lastRemindedAt = null;
      }
      nextTask.wakePending = false;
      nextTask.wakeSentAt = null;
      nextTask.wakeMessageSeq = null;
      nextTask.wakeMessageAt = null;
      nextTask.activeWakeId = null;
      nextTask.wakePromptSha256 = null;
      nextTask.lastWakeAt = null;
      nextTask.updatedAt = now;
      return nextState;
    },
  };
}

export function verifyRearmedTask(task, plan, newWakeId) {
  if (!task) fail("TASK_NOT_FOUND", `任务不存在：${plan.taskId}`);
  for (const field of ["conversationId", "generation", "localRole", "sourceMachine", "targetMachine", "trustedPeerQq", "status", "lastSeenSeq", "lastAckedSeq"]) {
    const expected = plan.before[field];
    if (task[field] !== expected) fail("BUSINESS_STATE_DRIFT", `${field} 发生漂移`, { actual: task[field], expected });
  }
  const pending = task.pendingMessages ?? pendingMessages(task);
  exactArray(pending.map((message) => message.messageSeq), plan.expectedPendingSeqs, "pending message_seq");
  const active = task.activeWakes ?? activeWakes(task, new Set(plan.expectedPendingSeqs));
  if (active.length !== 1) fail("REARM_WAKE_COUNT_MISMATCH", "重新提醒后必须恰好有一个活动 wake", { count: active.length });
  const wake = active[0];
  if (wake.wakeId !== newWakeId || wake.status !== "sent") {
    fail("REARM_WAKE_MISMATCH", "新的 wake 身份或状态不正确", { wake, newWakeId });
  }
  exactArray(wake.messageSeqs, plan.expectedPendingSeqs, "new wake coverage");
  return { pendingCount: pending.length, activeWakeCount: 1, wakeId: newWakeId };
}
