import crypto from "node:crypto";

const DEFAULT_CONNECTION_REQUEST_BOOTSTRAP_LOOKBACK_MS = 15 * 60 * 1000;

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
    ...(message.sourceConversationId ? [`source_conversation_id=${message.sourceConversationId}`] : []),
    "可信对端请求重新建立双机任务连接。此消息只负责唤醒与提出请求，不代表本机已经登记、绑定或接受 task；请先核对任务身份和来源，再自行决定是否调用 napcat_task_register，并在双方握手完成后才关闭旧 task。",
  ].join("\n");
}

function ownerReplyPrompt(route, message, bufferedMessages = []) {
  const buffered = bufferedMessages.length > 0
    ? [
        "主人此前连续发送了以下附件或媒体，当时按规则只缓冲、没有单独触发回复：",
        ...bufferedMessages.map((item) => [
          `message_seq=${item.messageSeq}`,
          `类型=${item.contentTypes.join(",") || "media"}`,
          ...(item.attachments.length > 0 ? [`附件=${JSON.stringify(item.attachments)}`] : []),
          ...(item.text ? [`内容=${item.text}`] : []),
        ].join("；")),
        "主人现在补充了明确文字，请结合这些缓冲内容一起处理：",
      ]
    : ["主人通过 QQ 通知通道回复了这条 Codex 对话，请把下面内容作为用户补充信息处理："];
  return [
    "[NAPCAT_OWNER_REPLY]",
    `route_key=${route.routeKey}`,
    ...(route.taskId ? [`task_id=${route.taskId}`] : []),
    `message_seq=${message.messageSeq}`,
    ...buffered,
    String(message.text ?? "").trim(),
  ].join("\n");
}

function standaloneDeferredOwnerMessage(message) {
  return message?.hasExplicitText === false && Array.isArray(message?.contentTypes) && message.contentTypes.length > 0;
}

function chronologicalMessages(messages) {
  return messages
    .map((message, index) => ({ message, index, timestamp: Date.parse(message?.time ?? "") }))
    .sort((left, right) => {
      if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) && left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.message);
}

export function createControlPlane(options = {}) {
  const notifier = options.notifier;
  const bridge = options.bridge;
  const state = options.state;
  const now = options.now ?? (() => new Date());
  const connectionRequestBootstrapLookbackMs = Math.max(
    0,
    Number(options.connectionRequestBootstrapLookbackMs ?? DEFAULT_CONNECTION_REQUEST_BOOTSTRAP_LOOKBACK_MS),
  );
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

  function deliveryReceiptKey(message, stage) {
    return `business-receipt:${stage}:${requiredText(message.deliveryId, "deliveryId", 128)}`;
  }

  function messageTime(message) {
    const timestamp = Date.parse(message?.time ?? "");
    return Number.isFinite(timestamp) ? timestamp : null;
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

  async function sendReceiptOnce(message, stage) {
    if (!message?.deliveryId) return { skipped: true, reason: "missing_delivery_id" };
    const receiptKey = deliveryReceiptKey(message, stage);
    if (state.hasSeenControlMessage(receiptKey)) {
      return { skipped: true, reason: "receipt_already_recorded" };
    }
    try {
      const receipt = await sendReceipt(message, stage);
      if (!receipt) return { skipped: true, reason: "receipt_not_applicable" };
      if (receipt.sent === true || receipt.duplicateSuppressed === true) {
        state.markControlMessageSeen(receiptKey);
      }
      return { skipped: false, receipt };
    } catch (error) {
      if (error?.outcomeUnknown) state.markControlMessageSeen(receiptKey);
      throw error;
    }
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

  async function scanConnectionRequest(message, configuration, bootstrap = null) {
    if (message.messageType !== "connection_request" || !validatePeerMessage(message, configuration)) return null;
    if (!message.requestId || !message.targetConversationId || !message.proposedTaskId) return null;
    const key = messageKey("connection-request", message);
    if (state.hasSeenControlMessage(key)) return { outcome: "duplicate_connection_request", requestId: message.requestId };
    if (bootstrap?.initialized) {
      const requestTime = messageTime(message);
      const bootstrapTime = Date.parse(bootstrap.bootstrapAt);
      if (requestTime === null) {
        state.markControlMessageSeen(key);
        return { outcome: "connection_request_time_unverifiable", requestId: message.requestId };
      }
      if (Number.isFinite(bootstrapTime)
        && requestTime < bootstrapTime - connectionRequestBootstrapLookbackMs) {
        state.markControlMessageSeen(key);
        return { outcome: "stale_connection_request_baselined", requestId: message.requestId };
      }
    }
    const existing = state.getConnectionRequest(message.requestId);
    if (existing) {
      state.updateConnectionRequest({
        requestId: message.requestId,
        ...(message.sourceConversationId ? { sourceConversationId: message.sourceConversationId } : {}),
        targetConversationId: message.targetConversationId,
        proposedTaskId: message.proposedTaskId,
        ...(message.previousTaskId ? { previousTaskId: message.previousTaskId } : {}),
        sourceMachine: message.sourceMachine,
        targetMachine: message.targetMachine,
        status: existing.status,
      });
      await sendReceiptOnce(message, "machine_received");
      if (existing.status === "wake_accepted") await sendReceiptOnce(message, "conversation_received");
      state.markControlMessageSeen(key);
      return { outcome: "duplicate_connection_request", requestId: message.requestId };
    }
    state.updateConnectionRequest({
      requestId: message.requestId,
      ...(message.sourceConversationId ? { sourceConversationId: message.sourceConversationId } : {}),
      targetConversationId: message.targetConversationId,
      proposedTaskId: message.proposedTaskId,
      ...(message.previousTaskId ? { previousTaskId: message.previousTaskId } : {}),
      sourceMachine: message.sourceMachine,
      targetMachine: message.targetMachine,
      status: "received",
      receivedAt: message.time,
    });
    await sendReceiptOnce(message, "machine_received");
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
    await sendReceiptOnce(message, "conversation_received");
    state.markControlMessageSeen(key);
    return { outcome: "connection_request_delivered", requestId: message.requestId };
  }

  async function scanGroupHistory(messages = []) {
    const configuration = config();
    if (!configuration.enabled || !configuration.machineIngressEnabled) return { enabled: false, results: [] };
    const baselineReceiptKeys = messages
      .filter((message) => message?.messageType === "business"
        && message?.deliveryId
        && validatePeerMessage(message, configuration))
      .flatMap((message) => [
        deliveryReceiptKey(message, "machine_received"),
        deliveryReceiptKey(message, "conversation_received"),
      ]);
    const bootstrap = state.initializeBusinessReceiptBaseline({
      now: now(),
      receiptKeys: baselineReceiptKeys,
    });
    const results = [];
    for (const message of messages) {
      try {
        const receipt = await scanReceipt(message, configuration);
        if (receipt) {
          results.push(receipt);
          continue;
        }
        const request = await scanConnectionRequest(message, configuration, bootstrap);
        if (request) results.push(request);
      } catch (error) {
        results.push({ outcome: "control_scan_error", messageSeq: message?.messageSeq ?? null, error: publicError(error) });
      }
    }
    return { enabled: true, bootstrap, results };
  }

  async function acknowledgeBusinessMessages(messages, stage) {
    const configuration = config();
    if (!configuration.enabled || !configuration.machineIngressEnabled) return [];
    if (state.getBusinessReceiptBootstrapAt() === null) return [];
    const results = [];
    for (const message of messages) {
      if (!message?.deliveryId || message.messageType !== "business") continue;
      try {
        const outcome = await sendReceiptOnce(message, stage);
        if (outcome.skipped) continue;
        const result = {
          deliveryId: message.deliveryId,
          stage,
          sent: outcome.receipt.sent === true,
        };
        if (outcome.receipt.duplicateSuppressed === true) result.duplicateSuppressed = true;
        results.push(result);
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
    const sourceConversationId = requiredText(input.source_conversation_id, "source_conversation_id", 256);
    const previousTaskId = optionalText(input.previous_task_id, 128);
    const replyToRequestId = optionalText(input.reply_to_request_id, 128);
    const reason = optionalText(input.reason, 600);
    const targetMachine = requiredText(input.target_machine, "target_machine", 64);
    let matchedRequest = null;
    if (replyToRequestId) {
      matchedRequest = state.getConnectionRequest(replyToRequestId);
      if (!matchedRequest) throw new Error(`找不到可回拨的连接请求：${replyToRequestId}`);
    } else if (previousTaskId) {
      matchedRequest = state.listConnectionRequests()
        .filter((request) => request.proposedTaskId === previousTaskId
          && request.sourceMachine === targetMachine
          && request.targetMachine === configuration.localMachine
          && request.sourceConversationId)
        .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))[0] ?? null;
    }
    if (matchedRequest && (matchedRequest.sourceMachine !== targetMachine
      || matchedRequest.targetMachine !== configuration.localMachine)) {
      throw new Error(`连接请求机器方向不匹配：${matchedRequest.requestId}`);
    }
    const explicitTargetConversationId = optionalText(input.target_conversation_id, 256);
    const rememberedTargetConversationId = matchedRequest?.sourceConversationId || "";
    if (explicitTargetConversationId && rememberedTargetConversationId
      && explicitTargetConversationId !== rememberedTargetConversationId) {
      throw new Error(`target_conversation_id 与已持久化回拨地址冲突：${matchedRequest.requestId}`);
    }
    const targetConversationId = explicitTargetConversationId || rememberedTargetConversationId;
    if (!targetConversationId) {
      throw new Error("缺少 target_conversation_id，且本机没有可由 reply_to_request_id 或 previous_task_id 恢复的回拨地址");
    }
    const requestId = optionalText(input.request_id, 128)
      || stableId("request", [configuration.localMachine, targetMachine, sourceConversationId, targetConversationId, proposedTaskId]);
    const message = [
      "[Codex][CONNECTION_REQUEST]",
      `request_id：${requestId}`,
      `delivery_id：${requestId}`,
      `proposed_task_id：${proposedTaskId}`,
      ...(previousTaskId ? [`previous_task_id：${previousTaskId}`] : []),
      `source_machine：${configuration.localMachine}`,
      `target_machine：${targetMachine}`,
      `source_conversation_id：${sourceConversationId}`,
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
    return {
      requestId,
      deliveryId: requestId,
      sourceConversationId,
      targetConversationId,
      resolvedFromRequestId: matchedRequest?.requestId ?? null,
      sent,
    };
  }

  async function registerOwnerRoute(input) {
    const routeKey = requiredText(input.route_key, "route_key", 256);
    const targetKey = requiredText(input.target_key || config().defaultTargetKey, "target_key", 64);
    const existing = state.getOwnerRoute(routeKey);
    let baselineMessageKeys = null;
    if (!existing || existing.status !== "open" || existing.baselineInitialized === false) {
      const history = await notifier.readConfiguredTargetMessages({ target_key: targetKey, count: 50, reverse_order: true });
      baselineMessageKeys = history.messages
        .filter((message) => !message.isSelf)
        .map((message) => messageKey(`owner:${targetKey}`, message));
    }
    const route = state.openOwnerRoute({
      routeKey,
      conversationId: requiredText(input.conversation_id, "conversation_id", 256),
      taskId: optionalText(input.task_id, 128) || null,
      targetKey,
      ...(baselineMessageKeys === null ? {} : { baselineMessageKeys }),
    });
    return {
      ...route,
      baselineMessageCount: route.baselineMessageKeys.length,
      bufferedMessageCount: route.bufferedOwnerMessages.length,
      baselineMessageKeys: undefined,
      bufferedOwnerMessages: undefined,
    };
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
    const defaultReplyHint = target.type === "group"
      ? "回复此条并 @ 当前机器账号即可"
      : "回复此条即可";
    const replyHint = optionalText(input.reply_hint, 80) || defaultReplyHint;
    const message = summary.includes(replyHint)
      ? summary
      : `${summary}\n\n${replyHint}`;
    const level = optionalText(input.level, 24) || "INFO";
    const sent = await notifier.sendConfiguredMessage({
      target_key: route.targetKey,
      event: "owner_alert",
      task_id: route.taskId || "owner-alert",
      dedupe_key: requiredText(input.dedupe_key, "dedupe_key", 200),
      message,
    });
    const messageId = sent.messageId ?? sent.existing?.messageId ?? null;
    if (messageId === null || messageId === undefined || String(messageId).trim() === "") {
      throw new Error("主人通知已提交发送，但没有取得 QQ messageId，无法建立引用回复路由");
    }
    const replyRoute = state.recordOwnerAlertMessage({
      messageId: String(messageId),
      routeKey,
      targetKey: route.targetKey,
    });
    return {
      ...sent,
      level,
      replyRoute,
      replyMode: target.type === "group" ? "quote_and_mention" : "latest_private_anchor",
      replyHint,
    };
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
        history = await notifier.readConfiguredTargetMessages({ target_key: targetKey, count: 50, reverse_order: true });
      } catch (error) {
        results.push({ outcome: "owner_channel_read_failed", targetKey, error: publicError(error) });
        continue;
      }
      const baselineMessageKeys = history.messages
        .filter((message) => !message.isSelf)
        .map((message) => messageKey(`owner:${targetKey}`, message));
      const readyRoutes = routes.map((route) => {
        if (route.baselineInitialized !== false) return route;
        return state.openOwnerRoute({
          routeKey: route.routeKey,
          conversationId: route.conversationId,
          taskId: route.taskId,
          targetKey: route.targetKey,
          baselineMessageKeys,
        });
      });
      for (const message of chronologicalMessages(history.messages)) {
        if (message.isSelf) continue;
        const quotedAlert = message.replyMessageId
          ? state.getOwnerAlertMessage(String(message.replyMessageId))
          : null;
        const latestPrivateAlert = history.target.type === "private"
          && !quotedAlert
          && !message.routeKey
          ? state.getLatestOwnerAlertMessageForTarget(targetKey, readyRoutes.map((route) => route.routeKey))
          : { message: null, ambiguous: false };
        if (latestPrivateAlert.ambiguous) {
          results.push({ outcome: "owner_private_route_ambiguous", targetKey, messageSeq: Number(message.messageSeq) });
          continue;
        }
        const resolvedRouteKey = quotedAlert?.targetKey === targetKey
          ? quotedAlert.routeKey
          : message.routeKey || latestPrivateAlert.message?.routeKey;
        if (!resolvedRouteKey) continue;
        const route = readyRoutes.find((candidate) => candidate.routeKey === resolvedRouteKey);
        if (!route) continue;
        if (history.target.type === "private" && String(message.senderId) !== String(history.target.id)) continue;
        if (history.target.type === "group" && !message.mentionedUserIds.includes(configuration.expectedSelfId)) continue;
        const sequence = Number(message.messageSeq);
        if (!Number.isSafeInteger(sequence)) continue;
        const key = messageKey(`owner:${targetKey}`, message);
        if (state.isOwnerRouteBaselineMessage(route.routeKey, key)) continue;
        if (state.hasSeenControlMessage(key)) continue;
        if (standaloneDeferredOwnerMessage(message)) {
          state.bufferOwnerRouteMessage({
            routeKey: route.routeKey,
            messageKey: key,
            messageSeq: sequence,
            time: message.time,
            text: message.text,
            contentTypes: message.contentTypes,
            attachments: message.attachments,
          });
          results.push({ outcome: "owner_reply_buffered", routeKey: route.routeKey, messageSeq: sequence });
          continue;
        }
        const bufferedMessages = state.listOwnerRouteBufferedMessages(route.routeKey);
        const prompt = ownerReplyPrompt(route, message, bufferedMessages);
        const pendingSequences = [...new Set([...bufferedMessages.map((item) => item.messageSeq), sequence])];
        const wakeId = stableId("owner-reply", [route.routeKey, ...bufferedMessages.map((item) => item.messageKey), key]);
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
            pendingMessageSeqs: pendingSequences,
            newMessageSeqs: pendingSequences,
            pendingThroughSequence: sequence,
            pendingThroughTime: message.time,
            promptSha256: crypto.createHash("sha256").update(prompt, "utf8").digest("hex"),
          });
          if (!acceptedWake(wake)) {
            results.push({ outcome: wake?.outcome === "busy" ? "owner_thread_busy" : "owner_thread_unavailable", routeKey: route.routeKey, messageSeq: sequence });
            continue;
          }
          state.completeOwnerReplyDelivery({ routeKey: route.routeKey, messageKey: key, messageSeq: sequence });
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
