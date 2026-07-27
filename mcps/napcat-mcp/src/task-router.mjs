function messageSequence(message) {
  const sequence = Number(message?.messageSeq ?? message?.messageId ?? -1);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function messageTimestamp(message) {
  const timestamp = Date.parse(message?.time ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function expectedPeerMachine(task) {
  if (task.localRole && task.localRole === task.sourceMachine) return task.targetMachine;
  if (task.localRole && task.localRole === task.targetMachine) return task.sourceMachine;
  return "";
}

function eligibleMessage(task, message) {
  if (!message || message.isSelf) return false;
  if (String(message.taskId ?? "") !== task.taskId) return false;
  if (String(message.senderId ?? "") !== task.trustedPeerQq) return false;
  if (message.targetMachine && task.localRole && message.targetMachine !== task.localRole) return false;
  const peerMachine = expectedPeerMachine(task);
  if (message.sourceMachine && peerMachine && message.sourceMachine !== peerMachine) return false;
  return messageSequence(message) !== null && messageTimestamp(message) !== null;
}

function buildWakePrompt(task, pendingThroughSequence) {
  return [
    "[NAPCAT_TASK_WAKE]",
    `task_id=${task.taskId}`,
    `generation=${task.generation}`,
    `pending_through_message_seq=${pendingThroughSequence}`,
    "ExampleGroup 固定群有尚未确认的新消息。请调用 napcat_read_recent 按 task_id 读取并处理；完成后调用 napcat_task_ack，使用本提示中的 generation 和 pending_through_message_seq 原值。message_seq 是不保证数字递增的消息标识，不能自行取最大值。",
  ].join("\n");
}

function publicError(error) {
  return {
    code: error?.code ?? "UNEXPECTED_ERROR",
    message: error?.message ?? String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
  };
}

export function createTaskRouter(options = {}) {
  const registry = options.registry;
  const notifier = options.notifier;
  const bridge = options.bridge;
  if (!registry || !notifier || !bridge) throw new Error("task router 需要 registry、notifier 和 bridge");
  const historyCount = Math.max(1, Math.min(50, Number(options.historyCount ?? 50)));
  const wakeLeaseMs = Math.max(1000, Number(options.wakeLeaseMs ?? 300000));

  async function scanTask(task, sharedHistory = null) {
    try {
      const history = sharedHistory ?? await notifier.readRecentMessages({ count: historyCount });
      const eligible = history.messages
        .filter((message) => eligibleMessage(task, message))
        .sort((left, right) => messageTimestamp(left) - messageTimestamp(right));
      const lastAckedAt = task.lastAckedAt === null ? null : Date.parse(task.lastAckedAt);
      const acknowledgedIndex = task.lastAckedSeq > 0
        ? eligible.findLastIndex((message) => messageSequence(message) === task.lastAckedSeq)
        : -1;
      const pending = acknowledgedIndex >= 0
        ? eligible.slice(acknowledgedIndex + 1)
        : eligible.filter((message) =>
            lastAckedAt === null || messageTimestamp(message) >= lastAckedAt
          );
      if (!pending.length) {
        return { taskId: task.taskId, outcome: "no_new_message", scannedCount: history.scannedCount };
      }
      const pendingThroughMessage = pending.at(-1);
      const pendingThroughSequence = messageSequence(pendingThroughMessage);
      const seenTask = registry.markSeen({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        seq: pendingThroughSequence,
        at: pendingThroughMessage.time,
      });
      const lease = registry.acquireWakeLease({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        leaseMs: wakeLeaseMs,
        seq: pendingThroughSequence,
        at: pendingThroughMessage.time,
      });
      if (!lease.acquired) {
        return {
          taskId: task.taskId,
          outcome: lease.reason,
          pendingCount: pending.length,
          pendingThroughSequence,
        };
      }
      const prompt = buildWakePrompt(seenTask, pendingThroughSequence);
      let wake;
      try {
        wake = await bridge.wake({ threadId: seenTask.conversationId, prompt });
      } catch (error) {
        registry.releaseWakeLease({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
        });
        return { taskId: task.taskId, outcome: "wake_failed", error: publicError(error), pendingThroughSequence };
      }
      if (wake.outcome === "accepted" || wake.outcome === "completed") {
        registry.confirmWakeSent({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
        });
        return {
          taskId: task.taskId,
          outcome: wake.outcome,
          pendingCount: pending.length,
          pendingThroughSequence,
          turnId: wake.turn?.id ?? wake.turn?.turnId ?? null,
        };
      }
      if (wake.outcome === "unknown" && wake.error?.outcomeUnknown) {
        registry.confirmWakeSent({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
        });
        return {
          taskId: task.taskId,
          outcome: "wake_unknown",
          pendingCount: pending.length,
          pendingThroughSequence,
          error: wake.error,
        };
      }
      registry.releaseWakeLease({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        expectedWakeSentAt: lease.wakeSentAt,
      });
      return {
        taskId: task.taskId,
        outcome: wake.outcome === "busy" ? "thread_busy" : "thread_unavailable",
        pendingCount: pending.length,
        pendingThroughSequence,
        threadStatus: wake.status,
      };
    } catch (error) {
      return { taskId: task.taskId, outcome: "scan_error", error: publicError(error) };
    }
  }

  async function scanOnce() {
    const tasks = registry.list({ status: "open" });
    if (!tasks.length) {
      return { scannedAt: new Date().toISOString(), openTaskCount: 0, wakeCount: 0, results: [] };
    }
    let history;
    try {
      history = await notifier.readRecentMessages({ count: historyCount });
    } catch (error) {
      const failure = publicError(error);
      return {
        scannedAt: new Date().toISOString(),
        openTaskCount: tasks.length,
        wakeCount: 0,
        results: tasks.map((task) => ({ taskId: task.taskId, outcome: "scan_error", error: failure })),
      };
    }
    const results = [];
    for (const task of tasks) results.push(await scanTask(task, history));
    return {
      scannedAt: new Date().toISOString(),
      openTaskCount: tasks.length,
      wakeCount: results.filter((result) => result.outcome === "accepted" || result.outcome === "completed").length,
      results,
    };
  }

  return { scanOnce, scanTask };
}
