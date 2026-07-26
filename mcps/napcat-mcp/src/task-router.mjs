function compareMessageSequence(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isSafeInteger(leftNumber) || leftNumber < 0) return -1;
  if (!Number.isSafeInteger(rightNumber) || rightNumber < 0) return 1;
  return leftNumber - rightNumber;
}

function messageSequence(message) {
  const sequence = Number(message?.messageSeq ?? message?.messageId ?? -1);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
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
  return messageSequence(message) !== null;
}

function buildWakePrompt(task, maximumSequence) {
  return [
    "[NAPCAT_TASK_WAKE]",
    `task_id=${task.taskId}`,
    `generation=${task.generation}`,
    `pending_through_message_seq=${maximumSequence}`,
    "ExampleGroup 固定群有尚未确认的新消息。请调用 napcat_read_recent 按 task_id 读取并处理；完成后调用 napcat_task_ack，使用本提示中的 generation 和实际处理到的最大 message_seq。",
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
        .sort((left, right) => compareMessageSequence(messageSequence(left), messageSequence(right)));
      const pending = eligible.filter((message) => messageSequence(message) > task.lastAckedSeq);
      if (!pending.length) {
        return { taskId: task.taskId, outcome: "no_new_message", scannedCount: history.scannedCount };
      }
      const maximumSequence = Math.max(...pending.map(messageSequence));
      const seenTask = registry.markSeen({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        seq: maximumSequence,
      });
      const lease = registry.acquireWakeLease({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        leaseMs: wakeLeaseMs,
      });
      if (!lease.acquired) {
        return {
          taskId: task.taskId,
          outcome: lease.reason,
          pendingCount: pending.length,
          maximumSequence,
        };
      }
      const prompt = buildWakePrompt(seenTask, maximumSequence);
      let wake;
      try {
        wake = await bridge.wake({ threadId: seenTask.conversationId, prompt });
      } catch (error) {
        registry.releaseWakeLease({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
        });
        return { taskId: task.taskId, outcome: "wake_failed", error: publicError(error), maximumSequence };
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
          maximumSequence,
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
          maximumSequence,
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
        maximumSequence,
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
