import crypto from "node:crypto";

function requiredText(value, name, maximum = 512) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  if (normalized.length > maximum) throw new Error(`${name} 不能超过 ${maximum} 个字符`);
  return normalized;
}

function optionalText(value, maximum = 512) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (normalized.length > maximum) throw new Error(`文本不能超过 ${maximum} 个字符`);
  return normalized;
}

function safeSequence(message) {
  const value = Number(message?.deliveryMessageSeq ?? message?.messageSeq ?? message?.messageId);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function messageKey(scope, message) {
  const sequence = String(message?.messageSeq ?? message?.messageId ?? "").trim();
  return `${scope}:${sequence || crypto.createHash("sha256").update(String(message?.text ?? "")).digest("hex")}`;
}

function stableId(prefix, values) {
  return `${prefix}-${crypto.createHash("sha256").update(values.join("\0"), "utf8").digest("hex").slice(0, 32)}`;
}

function publicError(error) {
  return {
    code: error?.code ?? "UNEXPECTED_ERROR",
    message: error?.message ?? String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
  };
}

function acceptedWake(wake) {
  return wake?.outcome === "accepted" || wake?.outcome === "completed";
}

function connectionPrompt(message) {
  return [
    "[NAPCAT_CONNECTION_REQUEST]",
    `request_id=${message.requestId}`,
    `proposed_task_id=${message.proposedTaskId}`,
    `previous_task_id=${message.previousTaskId || ""}`,
    `source_machine=${message.sourceMachine}`,
    `target_machine=${message.targetMachine}`,
    "可信对端请求重新建立双机任务连接。此消息只负责唤醒与提出请求，不代表本机已经登记、绑定或接受 task；请先核对任务身份和来源，再自行决定是否调用 napcat_task_register，并在双方握手完成后才关闭旧 task。",
  ].join("\n");
}

function ownerReplyPrompt(route, message) {
  return [
    "[NAPCAT_OWNER_REPLY]",
    `route_key=${route.routeKey}`,
    ...(route.taskId ? [`task_id=${route.taskId}`] : []),
    `message_seq=${message.messageSeq}`,
    "主人通过 QQ 通知通道回复了这条 Codex 对话，请把下面内容作为用户补充信息处理：",
    String(message.text ?? "").trim(),
  ].join("\n");
}

export function createControlPlane(options = {}) {
  const notifier = options.notifier;
  const bridge = options.bridge;
  const state = options.state;
  const now = options.now ?? (() => new Date());
  if (!notifier || !bridge || !state) throw new Error("control plane 需要 notifier、bridge 和 state");

  function config() {
    return notifier.getControlPlaneConfig();
  }

  function keepAlive() {
    const value = config();
    return value.enabled && (
      value.machineIngressEnabled
      || state.listOwnerRoutes().some((route) => route.status === "open")
    );
  }

  function validatePeerMessage(message, configuration) {
    return !message?.isSelf
      && String(message?.senderId ?? "") === configuration.trustedPeerQq
      && String(message?.targetMachine ?? "") === configuration.localMachine;
  }

  async function sendReceipt(message, stage) {
    if (!message.deliveryId) return null;
    const originalSequence = safeSequence(message);
    if (originalSequence === null) return null;
    const configuration = config();
    const receipt = [
      "[Codex][DELIVERY_RECEIPT]",
      `delivery_id：${message.deliveryId}`,
      `task_id：${message.taskId || message.proposedTaskId || "control-plane"}`,
      `source_machine：${configuration.localMachine}`,
      `target_machine：${message.sourceMachine}`,
      `receipt_stage：${stage}`,
      `delivery_message_seq：${originalSequence}`,
      `时间：${new Date(now()).toISOString()}`,
    ].join("\n");
    return notifier.sendControlGroupMessage({
      event: "delivery_receipt",
      task_id: message.taskId || message.proposedTaskId || "control-plane",
      dedupe_key: `delivery-receipt:${stage}:${message.deliveryId}`,
      message: receipt,
    });
  }

  function trackOutgoingDelivery(input) {
    return state.updateDelivery({
      deliveryId: requiredText(input.deliveryId, "deliveryId", 128),
      taskId: requiredText(input.taskId, "taskId", 128),
      sourceMachine: requiredText(input.sourceMachine, "sourceMachine", 64),
      targetMachine: requiredText(input.targetMachine, "targetMachine", 64),
      messageSeq: Number(input.messageSeq),
      status: "pending",
    });
  }

  async function scanReceipt(message, configuration) {
    if (message.messageType !== "delivery_receipt" || !validatePeerMessage(message, configuration)) return null;
    if (!message.deliveryId || !["machine_received", "conversation_received"].includes(message.receiptStage)) return null;
    const key = messageKey("receipt", message);
    if (state.hasSeenControlMessage(key)) return { outcome: "duplicate_receipt", deliveryId: message.deliveryId };
    const existing = state.getDelivery(message.deliveryId);
    if (!existing) return { outcome: "unknown_delivery_receipt", deliveryId: message.deliveryId };
    state.updateDelivery({
      deliveryId: message.deliveryId,
      status: message.receiptStage,
      ...(message.receiptStage === "machine_received"
        ? { machineReceivedAt: message.time }
        : { conversationReceivedAt: message.time }),
    });
    state.markControlMessageSeen(key);
    return { outcome: message.receiptStage, deliveryId: message.deliveryId };
  }

  async function scanConnectionRequest(message, configuration) {
    if (message.messageType !== "connection_request" || !validatePeerMessage(message, configuration)) return null;
    if (!message.requestId || !message.targetConversationId || !message.proposedTaskId) return null;
    const key = messageKey("connection-request", message);
    if (state.hasSeenControlMessage(key)) return { outcome: "duplicate_connection_request", requestId: message.requestId };
    state.updateConnectionRequest({
      requestId: message.requestId,
      targetConversationId: message.targetConversationId,
      proposedTaskId: message.proposedTaskId,
      sourceMachine: message.sourceMachine,
      targetMachine: message.targetMachine,
      status: "received",
      receivedAt: message.time,
    });
    await sendReceipt(message, "machine_received");
    const wakeId = stableId("connection", [message.requestId, message.targetConversationId]);
    const wake = await bridge.wake({
      threadId: message.targetConversationId,
      prompt: connectionPrompt(message),
      wakeId,
      taskId: message.proposedTaskId,
      generation: 1,
      localRole: configuration.localMachine,
      sourceMachine: message.sourceMachine,
      targetMachine: message.targetMachine,
      trustedPeerQq: configuration.trustedPeerQq,
      pendingMessageSeqs: [Number(message.messageSeq)],
      newMessageSeqs: [Number(message.messageSeq)],
      pendingThroughSequence: Number(message.messageSeq),
      pendingThroughTime: message.time,
      promptSha256: crypto.createHash("sha256").update(connectionPrompt(message), "utf8").digest("hex"),
    });
    if (!acceptedWake(wake)) {
      return { outcome: wake?.outcome === "busy" ? "connection_thread_busy" : "connection_thread_unavailable", requestId: message.requestId };
    }
    state.updateConnectionRequest({ requestId: message.requestId, status: "wake_accepted" });
    await sendReceipt(message, "conversation_received");
    state.markControlMessageSeen(key);
    return { outcome: "connection_request_delivered", requestId: message.requestId };
  }

  async function scanGroupHistory(messages = []) {
    const configuration = config();
    if (!configuration.enabled || !configuration.machineIngressEnabled) return { enabled: false, results: [] };
    const results = [];
    for (const message of messages) {
      try {
        const receipt = await scanReceipt(message, configuration);
        if (receipt) {
          results.push(receipt);
          continue;
        }
        const request = await scanConnectionRequest(message, configuration);
        if (request) results.push(request);
      } catch (error) {
        results.push({ outcome: "control_scan_error", messageSeq: message?.messageSeq ?? null, error: publicError(error) });
      }
    }
    return { enabled: true, results };
  }

  async function acknowledgeBusinessMessages(messages, stage) {
    const results = [];
    for (const message of messages) {
      if (!message?.deliveryId || message.messageType !== "business") continue;
      try {
        const receipt = await sendReceipt(message, stage);
        if (receipt) results.push({ deliveryId: message.deliveryId, stage, sent: true });
      } catch (error) {
        results.push({ deliveryId: message.deliveryId, stage, sent: false, error: publicError(error) });
      }
    }
    return results;
  }

  async function sendConnectionRequest(input) {
    const configuration = config();
    if (!configuration.enabled || !configuration.machineIngressEnabled) throw new Error("控制通道未启用");
    const proposedTaskId = requiredText(input.proposed_task_id, "proposed_task_id", 128);
    const targetConversationId = requiredText(input.target_conversation_id, "target_conversation_id", 256);
    const previousTaskId = optionalText(input.previous_task_id, 128);
    const reason = optionalText(input.reason, 600);
    const requestId = optionalText(input.request_id, 128)
      || stableId("request", [configuration.localMachine, input.target_machine, targetConversationId, proposedTaskId]);
    const targetMachine = requiredText(input.target_machine, "target_machine", 64);
    const message = [
      "[Codex][CONNECTION_REQUEST]",
      `request_id：${requestId}`,
      `delivery_id：${requestId}`,
      `proposed_task_id：${proposedTaskId}`,
      ...(previousTaskId ? [`previous_task_id：${previousTaskId}`] : []),
      `source_machine：${configuration.localMachine}`,
      `target_machine：${targetMachine}`,
      `target_conversation_id：${targetConversationId}`,
      ...(reason ? [`reason：${reason}`] : []),
      "说明：这是建立连接请求，不会替接收方自动登记或绑定 task。",
      `时间：${new Date(now()).toISOString()}`,
    ].join("\n");
    const sent = await notifier.sendControlGroupMessage({
      event: "connection_request",
      task_id: proposedTaskId,
      dedupe_key: `connection-request:${requestId}`,
      message,
    });
    const sequence = Number(sent.messageId ?? sent.existing?.messageId);
    trackOutgoingDelivery({
      deliveryId: requestId,
      taskId: proposedTaskId,
      sourceMachine: configuration.localMachine,
      targetMachine,
      messageSeq: sequence,
    });
    return { requestId, deliveryId: requestId, sent };
  }

  function registerOwnerRoute(input) {
    return state.openOwnerRoute({
      routeKey: requiredText(input.route_key, "route_key", 256),
      conversationId: requiredText(input.conversation_id, "conversation_id", 256),
      taskId: optionalText(input.task_id, 128) || null,
      targetKey: requiredText(input.target_key || config().defaultTargetKey, "target_key", 64),
    });
  }

  function closeOwnerRoute(input) {
    return state.closeOwnerRoute({ routeKey: requiredText(input.route_key, "route_key", 256) });
  }

  async function sendOwnerAlert(input) {
    const routeKey = requiredText(input.route_key, "route_key", 256);
    const route = state.getOwnerRoute(routeKey);
    if (!route || route.status !== "open") throw new Error(`主人通知路由不存在或已关闭：${routeKey}`);
    const configuration = config();
    const target = configuration.targets[route.targetKey];
    if (!target) throw new Error(`binding 未定义通知目标：${route.targetKey}`);
    const summary = requiredText(input.summary, "summary", 800);
    const level = optionalText(input.level, 24) || "INFO";
    const text = target.type === "private"
      ? [
          `[Codex提醒][${level}] ${summary}`,
          `机器：${configuration.localMachine}`,
          `路由：${routeKey}`,
          ...(route.taskId ? [`任务：${route.taskId}`] : []),
          "回复时请保留「路由」这一行。",
        ].join("\n")
      : [
          "[Codex][OWNER_ALERT]",
          `level：${level}`,
          `machine：${configuration.localMachine}`,
          `route_key：${routeKey}`,
          ...(route.taskId ? [`task_id：${route.taskId}`] : []),
          `summary：${summary}`,
          "回复时请 @ 本机 QQ 并保留 route_key。",
        ].join("\n");
    return notifier.sendConfiguredMessage({
      target_key: route.targetKey,
      event: "owner_alert",
      task_id: route.taskId || "owner-alert",
      dedupe_key: requiredText(input.dedupe_key, "dedupe_key", 200),
      message: text,
    });
  }

  async function scanOwnerReplies() {
    const configuration = config();
    if (!configuration.enabled) return { enabled: false, results: [] };
    const openRoutes = state.listOwnerRoutes().filter((route) => route.status === "open");
    const routesByTarget = new Map();
    for (const route of openRoutes) {
      if (!routesByTarget.has(route.targetKey)) routesByTarget.set(route.targetKey, []);
      routesByTarget.get(route.targetKey).push(route);
    }
    const results = [];
    for (const [targetKey, routes] of routesByTarget) {
      let history;
      try {
        history = await notifier.readConfiguredTargetMessages({ target_key: targetKey, count: 50 });
      } catch (error) {
        results.push({ outcome: "owner_channel_read_failed", targetKey, error: publicError(error) });
        continue;
      }
      for (const message of history.messages) {
        if (message.isSelf || !message.routeKey) continue;
        const route = routes.find((candidate) => candidate.routeKey === message.routeKey);
        if (!route) continue;
        if (history.target.type === "private" && String(message.senderId) !== String(history.target.id)) continue;
        if (history.target.type === "group" && !message.mentionedUserIds.includes(configuration.expectedSelfId)) continue;
        const sequence = Number(message.messageSeq);
        if (!Number.isSafeInteger(sequence)) continue;
        const key = messageKey(`owner:${targetKey}`, message);
        if (state.hasSeenControlMessage(key)) continue;
        const prompt = ownerReplyPrompt(route, message);
        const wakeId = stableId("owner-reply", [route.routeKey, key]);
        try {
          const wake = await bridge.wake({
            threadId: route.conversationId,
            prompt,
            wakeId,
            taskId: route.taskId || "owner-reply",
            generation: 1,
            localRole: configuration.localMachine,
            sourceMachine: "owner",
            targetMachine: configuration.localMachine,
            trustedPeerQq: String(message.senderId),
            pendingMessageSeqs: [sequence],
            newMessageSeqs: [sequence],
            pendingThroughSequence: sequence,
            pendingThroughTime: message.time,
            promptSha256: crypto.createHash("sha256").update(prompt, "utf8").digest("hex"),
          });
          if (!acceptedWake(wake)) {
            results.push({ outcome: wake?.outcome === "busy" ? "owner_thread_busy" : "owner_thread_unavailable", routeKey: route.routeKey, messageSeq: sequence });
            continue;
          }
          state.recordOwnerRouteInbound({ routeKey: route.routeKey, messageSeq: sequence });
          state.markControlMessageSeen(key);
          results.push({ outcome: "owner_reply_delivered", routeKey: route.routeKey, messageSeq: sequence });
        } catch (error) {
          results.push({ outcome: "owner_reply_failed", routeKey: route.routeKey, messageSeq: sequence, error: publicError(error) });
        }
      }
    }
    return { enabled: true, results };
  }

  return {
    config,
    keepAlive,
    trackOutgoingDelivery,
    getDeliveryStatus: (deliveryId) => state.getDelivery(deliveryId),
    listDeliveryStatuses: () => state.listDeliveries(),
    sendConnectionRequest,
    registerOwnerRoute,
    closeOwnerRoute,
    sendOwnerAlert,
    scanGroupHistory,
    scanOwnerReplies,
    acknowledgeBusinessMessages,
  };
}
