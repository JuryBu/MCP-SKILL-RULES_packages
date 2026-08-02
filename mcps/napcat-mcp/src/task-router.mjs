import crypto from "node:crypto";

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
  if (task.localRole && message.targetMachine !== task.localRole) return false;
  const peerMachine = expectedPeerMachine(task);
  if (peerMachine && message.sourceMachine !== peerMachine) return false;
  return messageSequence(message) !== null && messageTimestamp(message) !== null;
}

export function buildWakeId(task, pendingMessages, pendingThroughTime = null) {
  const normalizedMessages = Array.isArray(pendingMessages)
    ? pendingMessages.map((message) => ({
        messageSeq: Number(message.messageSeq ?? message.message_seq),
        messageAt: String(message.messageAt ?? message.message_time ?? message.time),
      }))
    : [{ messageSeq: Number(pendingMessages), messageAt: String(pendingThroughTime) }];
  return crypto.createHash("sha256").update([
    "wake:v2",
    task.taskId,
    String(task.generation),
    task.conversationId,
    ...normalizedMessages.flatMap((message) => [String(message.messageSeq), message.messageAt]),
  ].join("\0"), "utf8").digest("hex");
}

function buildWakePrompt(task, pendingMessages, newMessages, wakeId) {
  const pendingSequences = pendingMessages.map((message) => message.messageSeq);
  const newSequences = newMessages.map((message) => message.messageSeq);
  const previouslyPendingSequences = pendingSequences.filter((sequence) => !newSequences.includes(sequence));
  const pendingThroughSequence = pendingSequences.at(-1);
  return [
    "[NAPCAT_TASK_WAKE]",
    `task_id=${task.taskId}`,
    `generation=${task.generation}`,
    `pending_message_seqs=${JSON.stringify(pendingSequences)}`,
    `new_message_seqs=${JSON.stringify(newSequences)}`,
    `previously_pending_message_seqs=${JSON.stringify(previouslyPendingSequences)}`,
    `pending_through_message_seq=${pendingThroughSequence}`,
    `wake_id=${wakeId}`,
    "ExampleGroup 固定群有新增消息，并可能仍有此前未完成的消息。请调用 napcat_read_recent 按 task_id 读取并处理；完成一条或多条后调用 napcat_task_ack，原样回传 generation、wake_id，并用 processed_message_seqs 明确列出实际处理完成的消息。未列出的消息继续保留待处理；message_seq 是不保证数字递增的消息标识，不能自行取最大值或确认未处理消息。",
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
  const isMaintenanceActive = typeof options.isMaintenanceActive === "function"
    ? options.isMaintenanceActive
    : () => false;

  async function scanTask(task, sharedHistory = null) {
    try {
      const history = sharedHistory ?? await notifier.readRecentMessages({ count: historyCount });
      const eligible = history.messages
        .filter((message) => eligibleMessage(task, message))
        .sort((left, right) => messageTimestamp(left) - messageTimestamp(right));
      if (!eligible.length) {
        return { taskId: task.taskId, outcome: "no_new_message", scannedCount: history.scannedCount };
      }
      let messagesToObserve = eligible;
      if (!task.ledgerInitialized) {
        const lastAckedAt = task.lastAckedAt === null ? null : Date.parse(task.lastAckedAt);
        const acknowledgedIndex = task.lastAckedSeq > 0
          ? eligible.findLastIndex((message) => messageSequence(message) === task.lastAckedSeq)
          : -1;
        messagesToObserve = acknowledgedIndex >= 0
          ? eligible.slice(acknowledgedIndex + 1)
          : eligible.filter((message) => lastAckedAt === null || messageTimestamp(message) >= lastAckedAt);
      }
      if (!messagesToObserve.length) {
        return { taskId: task.taskId, outcome: "no_new_message", scannedCount: history.scannedCount };
      }
      const seenTask = registry.observeMessages({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        messages: messagesToObserve.map((message) => ({
          messageSeq: messageSequence(message),
          messageAt: message.time,
        })),
      });
      const pendingMessages = seenTask.pendingMessages
        .sort((left, right) => Date.parse(left.messageAt) - Date.parse(right.messageAt));
      const newMessages = pendingMessages
        .filter((message) => message.lastRemindedAt === null)
        .sort((left, right) => Date.parse(left.messageAt) - Date.parse(right.messageAt));
      if (!newMessages.length) {
        return {
          taskId: task.taskId,
          outcome: pendingMessages.length ? "awaiting_ack" : "no_new_message",
          pendingCount: pendingMessages.length,
          scannedCount: history.scannedCount,
        };
      }
      const pendingThroughMessage = pendingMessages.at(-1);
      const wakeBoundarySequence = pendingThroughMessage.messageSeq;
      const wakeBoundaryTime = pendingThroughMessage.messageAt;
      const wakeId = buildWakeId(seenTask, pendingMessages);
      const prompt = buildWakePrompt(seenTask, pendingMessages, newMessages, wakeId);
      const promptHash = crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
      const lease = registry.acquireWakeLease({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        leaseMs: wakeLeaseMs,
        messages: pendingMessages,
        wakeId,
        promptSha256: promptHash,
      });
      if (!lease.acquired) {
        return {
          taskId: task.taskId,
          outcome: lease.reason,
          pendingCount: pendingMessages.length,
          pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq),
          newMessageSeqs: newMessages.map((message) => message.messageSeq),
          pendingThroughSequence: wakeBoundarySequence,
          wakeId,
        };
      }
      if (await isMaintenanceActive()) {
        registry.releaseWakeLease({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
          expectedWakeId: wakeId,
        });
        return {
          taskId: task.taskId,
          outcome: "automation_paused",
          pendingCount: pendingMessages.length,
          pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq),
          newMessageSeqs: newMessages.map((message) => message.messageSeq),
          pendingThroughSequence: wakeBoundarySequence,
          wakeId,
        };
      }
      let wake;
      try {
        wake = await bridge.wake({
          threadId: seenTask.conversationId,
          prompt,
          wakeId,
          taskId: seenTask.taskId,
          generation: seenTask.generation,
          localRole: seenTask.localRole,
          sourceMachine: seenTask.sourceMachine,
          targetMachine: seenTask.targetMachine,
          trustedPeerQq: seenTask.trustedPeerQq,
          pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq),
          newMessageSeqs: newMessages.map((message) => message.messageSeq),
          pendingThroughSequence: wakeBoundarySequence,
          pendingThroughTime: wakeBoundaryTime,
          promptSha256: promptHash,
        });
      } catch (error) {
        registry.releaseWakeLease({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
          expectedWakeId: wakeId,
        });
        return { taskId: task.taskId, outcome: "wake_failed", error: publicError(error), pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq), newMessageSeqs: newMessages.map((message) => message.messageSeq), pendingThroughSequence: wakeBoundarySequence, wakeId };
      }
      if (wake.outcome === "accepted" || wake.outcome === "completed") {
        registry.confirmWakeSent({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
          expectedWakeId: wakeId,
        });
        return {
          taskId: task.taskId,
          outcome: wake.outcome,
          pendingCount: pendingMessages.length,
          pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq),
          newMessageSeqs: newMessages.map((message) => message.messageSeq),
          pendingThroughSequence: wakeBoundarySequence,
          wakeId,
          turnId: wake.turn?.id ?? wake.turn?.turnId ?? null,
        };
      }
      if (wake.outcome === "unknown" && wake.error?.outcomeUnknown) {
        registry.confirmWakeSent({
          taskId: task.taskId,
          expectedGeneration: task.generation,
          expectedWakeSentAt: lease.wakeSentAt,
          expectedWakeId: wakeId,
        });
        return {
          taskId: task.taskId,
          outcome: "wake_unknown",
          pendingCount: pendingMessages.length,
          pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq),
          newMessageSeqs: newMessages.map((message) => message.messageSeq),
          pendingThroughSequence: wakeBoundarySequence,
          wakeId,
          error: wake.error,
        };
      }
      registry.releaseWakeLease({
        taskId: task.taskId,
        expectedGeneration: task.generation,
        expectedWakeSentAt: lease.wakeSentAt,
        expectedWakeId: wakeId,
      });
      return {
        taskId: task.taskId,
        outcome: wake.outcome === "busy" ? "thread_busy" : "thread_unavailable",
        pendingCount: pendingMessages.length,
        pendingMessageSeqs: pendingMessages.map((message) => message.messageSeq),
        newMessageSeqs: newMessages.map((message) => message.messageSeq),
        pendingThroughSequence: wakeBoundarySequence,
        wakeId,
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
