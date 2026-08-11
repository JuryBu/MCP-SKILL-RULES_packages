import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalMachineRole } from "./machine-role.mjs";
import { renameReplaceSync } from "./atomic-file.mjs";

const DEFAULT_ALLOWED_EVENTS = [
  "started",
  "heartbeat",
  "paused",
  "resumed",
  "stopped",
  "recovery",
  "completed",
  "test",
];
const STALE_LOCK_MINUTES = 15;

export class NapCatNotifierError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "NapCatNotifierError";
    this.code = code;
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
    this.details = options.details ?? null;
  }
}

function expandEnvironmentVariables(value, env) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => env[name] ?? match);
}

function resolveConfiguredPath(value, fallback, cwd, env) {
  const expanded = expandEnvironmentVariables(value || fallback, env);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function readJsonFile(filePath, missingCode) {
  if (!fs.existsSync(filePath)) {
    throw new NapCatNotifierError(missingCode, `配置文件不存在：${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new NapCatNotifierError("INVALID_JSON", `无法解析 JSON：${filePath}`, { cause: error });
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameReplaceSync(temporaryPath, filePath);
}

function boundedString(value, name, maximum, required = false) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();
  if (required && !normalized) {
    throw new NapCatNotifierError("INVALID_ARGUMENT", `${name} 不能为空`);
  }
  if (normalized.length > maximum) {
    throw new NapCatNotifierError("INVALID_ARGUMENT", `${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function outboundMachineRole(value, name, required = false) {
  const role = boundedString(value, name, 64, required);
  if (!role) return "";
  const canonical = canonicalMachineRole(role);
  if (!canonical) {
    throw new NapCatNotifierError(
      "INVALID_MACHINE_ROLE",
      `${name} 只允许标准值 development 或 training；收到 ${role}`,
    );
  }
  if (canonical !== role) {
    throw new NapCatNotifierError(
      "MACHINE_ROLE_ALIAS_NOT_CANONICAL",
      `${name} 使用了兼容别名 ${role}；请改为标准值 ${canonical} 后再发送`,
    );
  }
  return canonical;
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeControlPlane(rawControlPlane) {
  if (rawControlPlane === undefined || rawControlPlane === null) {
    return {
      enabled: false,
      machineIngressEnabled: false,
      localMachine: "",
      trustedPeerQq: "",
      defaultTargetKey: "",
      targets: {},
    };
  }
  if (!isPlainObject(rawControlPlane)) {
    throw new NapCatNotifierError("UNSUPPORTED_BINDING", "controlPlane 必须是对象");
  }
  const targets = {};
  const rawTargets = isPlainObject(rawControlPlane.targets) ? rawControlPlane.targets : {};
  for (const [key, rawTarget] of Object.entries(rawTargets)) {
    const targetKey = boundedString(key, "controlPlane target key", 64, true);
    if (!isPlainObject(rawTarget)) {
      throw new NapCatNotifierError("UNSUPPORTED_BINDING", `controlPlane.targets.${targetKey} 必须是对象`);
    }
    const type = boundedString(rawTarget.type, `controlPlane.targets.${targetKey}.type`, 16, true).toLowerCase();
    if (!["private", "group"].includes(type)) {
      throw new NapCatNotifierError("UNSUPPORTED_BINDING", `controlPlane.targets.${targetKey}.type 只支持 private 或 group`);
    }
    targets[targetKey] = {
      type,
      id: boundedString(rawTarget.id, `controlPlane.targets.${targetKey}.id`, 64, true),
      name: boundedString(rawTarget.name, `controlPlane.targets.${targetKey}.name`, 128),
      mentionUserId: boundedString(rawTarget.mentionUserId, `controlPlane.targets.${targetKey}.mentionUserId`, 64),
      expectedMemberCount: type === "group"
        ? positiveInteger(rawTarget.expectedMemberCount, 0, 0, 1000000)
        : null,
    };
  }
  const defaultTargetKey = boundedString(rawControlPlane.defaultTargetKey, "controlPlane.defaultTargetKey", 64);
  if (defaultTargetKey && !targets[defaultTargetKey]) {
    throw new NapCatNotifierError("UNSUPPORTED_BINDING", `controlPlane.defaultTargetKey 未定义：${defaultTargetKey}`);
  }
  return {
    enabled: rawControlPlane.enabled === true,
    machineIngressEnabled: rawControlPlane.machineIngressEnabled === true,
    localMachine: boundedString(rawControlPlane.localMachine, "controlPlane.localMachine", 64),
    trustedPeerQq: boundedString(rawControlPlane.trustedPeerQq, "controlPlane.trustedPeerQq", 64),
    defaultTargetKey,
    targets,
  };
}

function normalizeBinding(raw) {
  if (raw.requireGroupIdentityCheckBeforeSend === false) {
    throw new NapCatNotifierError(
      "UNSAFE_BINDING",
      "固定 ExampleGroup 群的身份校验不能关闭",
    );
  }
  const allowedEvents = Array.isArray(raw.allowedEvents) && raw.allowedEvents.length
    ? raw.allowedEvents.map((event) => String(event))
    : DEFAULT_ALLOWED_EVENTS;
  const codexWakeMessageVisibility = boundedString(
    raw.codexWakeMessageVisibility ?? "visible",
    "codexWakeMessageVisibility",
    16,
    true,
  ).toLowerCase();
  if (!["visible", "hidden"].includes(codexWakeMessageVisibility)) {
    throw new NapCatNotifierError(
      "UNSUPPORTED_BINDING",
      "codexWakeMessageVisibility 只支持 visible 或 hidden",
    );
  }
  const binding = {
    schemaVersion: Number(raw.schemaVersion ?? 1),
    bindingName: boundedString(raw.bindingName ?? "example-group-notify", "bindingName", 128, true),
    expectedSelfId: boundedString(raw.expectedSelfId, "expectedSelfId", 64),
    expectedNickname: boundedString(raw.expectedNickname, "expectedNickname", 128),
    groupId: boundedString(raw.groupId, "groupId", 64),
    groupName: boundedString(raw.groupName ?? "ExampleGroup", "groupName", 128, true),
    expectedMemberCount: positiveInteger(raw.expectedMemberCount, 4, 1, 1000000),
    allowedEvents,
    minimumHeartbeatMinutes: positiveInteger(raw.minimumHeartbeatMinutes, 5, 1, 1440),
    dedupeRetentionDays: positiveInteger(raw.dedupeRetentionDays, 30, 1, 3650),
    requireGroupIdentityCheckBeforeSend: true,
    requireMessageVerification: raw.requireMessageVerification !== false,
    codexWakeMessageVisibility,
    controlPlane: normalizeControlPlane(raw.controlPlane),
  };
  if (![1, 2].includes(binding.schemaVersion)) {
    throw new NapCatNotifierError("UNSUPPORTED_BINDING", `不支持 binding schemaVersion=${binding.schemaVersion}`);
  }
  if (binding.schemaVersion === 1 && binding.controlPlane.enabled) {
    throw new NapCatNotifierError("UNSUPPORTED_BINDING", "启用 controlPlane 时 binding schemaVersion 必须为 2");
  }
  return binding;
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: 1, entries: {} };
  }
  const state = readJsonFile(filePath, "STATE_MISSING");
  if (state.schemaVersion !== 1 || !state.entries || typeof state.entries !== "object") {
    throw new NapCatNotifierError("INVALID_STATE", `去重状态格式无效：${filePath}`);
  }
  return state;
}

function pruneState(state, retentionDays, nowDate) {
  const oldest = nowDate.getTime() - retentionDays * 86400000;
  for (const [key, entry] of Object.entries(state.entries)) {
    const timestamp = Date.parse(entry.updatedAt || entry.createdAt || "");
    if (Number.isFinite(timestamp) && timestamp < oldest) {
      delete state.entries[key];
    }
  }
}

function dedupeLockPath(statePath, dedupeKey) {
  const digest = createHash("sha256").update(dedupeKey, "utf8").digest("hex");
  return path.join(path.dirname(statePath), ".locks", `${digest}.lock`);
}

function acquireDedupeLock(statePath, dedupeKey, nowDate) {
  const lockPath = dedupeLockPath(statePath, dedupeKey);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, dedupeKey, createdAt: nowDate.toISOString() })}\n`, "utf8");
    fs.closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === "EEXIST") {
      let metadata = null;
      try {
        metadata = JSON.parse(fs.readFileSync(lockPath, "utf8").replace(/^\uFEFF/, ""));
      } catch {
        metadata = null;
      }
      let createdAtMs = Date.parse(metadata?.createdAt || "");
      if (!Number.isFinite(createdAtMs)) {
        try {
          createdAtMs = fs.statSync(lockPath).mtimeMs;
        } catch {
          createdAtMs = nowDate.getTime();
        }
      }
      const ageMinutes = Math.max(0, (nowDate.getTime() - createdAtMs) / 60000);
      return {
        release: null,
        existingLock: {
          lockPath,
          pid: metadata?.pid ?? null,
          createdAt: metadata?.createdAt ?? new Date(createdAtMs).toISOString(),
          ageMinutes,
          stale: ageMinutes >= STALE_LOCK_MINUTES,
        },
      };
    }
    throw error;
  }
  return {
    existingLock: null,
    release: () => {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trimEnd();
}

function oneBotMessageText(message) {
  if (typeof message?.raw_message === "string") {
    return message.raw_message;
  }
  if (typeof message?.message === "string") {
    return message.message;
  }
  if (Array.isArray(message?.message)) {
    return message.message.map((segment) => {
      if (typeof segment === "string") return segment;
      if (segment?.type === "text") return String(segment?.data?.text ?? "");
      return "";
    }).join("");
  }
  return "";
}

function oneBotReadableText(message) {
  if (typeof message?.raw_message === "string" && message.raw_message) {
    return message.raw_message.slice(0, 2000);
  }
  if (typeof message?.message === "string") {
    return message.message.slice(0, 2000);
  }
  if (Array.isArray(message?.message)) {
    return message.message.map((segment) => {
      if (typeof segment === "string") return segment;
      if (segment?.type === "text") return String(segment?.data?.text ?? "");
      return segment?.type ? `[${segment.type}]` : "[unknown]";
    }).join("").slice(0, 2000);
  }
  return "";
}

function decodeCqValue(value) {
  return String(value ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function summarizeFileAttachment(data = {}) {
  const fileId = String(data.file_id ?? data.fileId ?? data.file_uuid ?? data.fileUuid ?? "");
  const fileName = decodeCqValue(data.file_name ?? data.name ?? data.file ?? "");
  const rawSize = Number(data.file_size ?? data.size ?? 0);
  const rawBusId = Number(data.busid ?? data.bus_id ?? data.file_biz_id ?? data.fileBizId ?? Number.NaN);
  return {
    type: "file",
    fileId,
    fileName,
    fileBytes: Number.isFinite(rawSize) && rawSize > 0 ? rawSize : null,
    busId: Number.isSafeInteger(rawBusId) && rawBusId >= 0 ? rawBusId : null,
    downloadable: Boolean(fileId),
  };
}

const DEFERRED_ATTACHMENT_TYPES = new Set([
  "file",
  "image",
  "record",
  "video",
  "forward",
  "node",
  "face",
  "mface",
  "json",
  "xml",
]);

const DEFERRED_ATTACHMENT_FIELDS = [
  "id",
  "file",
  "file_id",
  "file_uuid",
  "file_name",
  "name",
  "url",
  "summary",
  "sub_type",
  "size",
  "key",
  "resid",
];

function summarizeDeferredAttachment(type, data = {}) {
  if (type === "file") return summarizeFileAttachment(data);
  const attachment = { type };
  for (const field of DEFERRED_ATTACHMENT_FIELDS) {
    const value = data?.[field];
    if (value === undefined || value === null || value === "") continue;
    attachment[field] = typeof value === "string" ? decodeCqValue(value).slice(0, 1000) : value;
  }
  return attachment;
}

function oneBotDeferredAttachments(message) {
  const attachments = [];
  if (Array.isArray(message?.message)) {
    for (const segment of message.message) {
      if (DEFERRED_ATTACHMENT_TYPES.has(segment?.type)) {
        attachments.push(summarizeDeferredAttachment(segment.type, segment.data));
      }
    }
  }
  const rawMessage = typeof message?.raw_message === "string" ? message.raw_message : "";
  for (const match of rawMessage.matchAll(/\[CQ:([^,\]]+),([^\]]+)\]/g)) {
    const type = match[1];
    if (!DEFERRED_ATTACHMENT_TYPES.has(type)) continue;
    const attributes = {};
    for (const part of match[2].split(",")) {
      const separator = part.indexOf("=");
      if (separator > 0) attributes[part.slice(0, separator)] = part.slice(separator + 1);
    }
    attachments.push(summarizeDeferredAttachment(type, attributes));
  }
  const unique = new Map();
  for (const attachment of attachments) {
    const key = JSON.stringify(attachment);
    if (!unique.has(key)) unique.set(key, attachment);
  }
  return [...unique.values()];
}

function oneBotContentSummary(message) {
  const contentTypes = [];
  let explicitText = "";
  if (Array.isArray(message?.message)) {
    for (const segment of message.message) {
      if (typeof segment === "string") explicitText += segment;
      else if (segment?.type === "text") explicitText += String(segment?.data?.text ?? "");
      else if (segment?.type && segment.type !== "reply" && segment.type !== "at") contentTypes.push(String(segment.type));
    }
  } else {
    const raw = String(message?.raw_message ?? message?.message ?? "");
    explicitText = raw.replace(/\[CQ:[^\]]+\]/g, "");
    for (const match of raw.matchAll(/\[CQ:([^,\]]+)/g)) {
      if (match[1] !== "reply" && match[1] !== "at") contentTypes.push(match[1]);
    }
  }
  return {
    hasExplicitText: Boolean(explicitText.trim()),
    contentTypes: [...new Set(contentTypes)],
  };
}

function structuredTaskMetadata(text) {
  const metadata = {
    taskId: "",
    sourceMachine: "",
    targetMachine: "",
    deliveryId: "",
    messageType: "business",
    requestId: "",
    sourceConversationId: "",
    targetConversationId: "",
    receiptStage: "",
    deliveryMessageSeq: "",
    proposedTaskId: "",
    previousTaskId: "",
    routeKey: "",
  };
  const normalizedText = normalizeComparableText(text);
  const firstLine = normalizedText.split("\n").find((line) => line.trim())?.trim() ?? "";
  if (firstLine === "[Codex][CONNECTION_REQUEST]") metadata.messageType = "connection_request";
  else if (firstLine === "[Codex][DELIVERY_RECEIPT]") metadata.messageType = "delivery_receipt";
  else if (firstLine === "[Codex][OWNER_REPLY]") metadata.messageType = "owner_reply";
  for (const line of normalizedText.split("\n")) {
    const taskMatch = line.match(/^(?:任务|task_id)\s*[：:]\s*(.+)$/i);
    if (taskMatch) metadata.taskId = taskMatch[1].trim().slice(0, 128);
    const sourceMatch = line.match(/^(?:来源机器|source_machine)\s*[：:]\s*(.+)$/i);
    if (sourceMatch) metadata.sourceMachine = sourceMatch[1].trim().slice(0, 64);
    const targetMatch = line.match(/^(?:目标机器|target_machine)\s*[：:]\s*(.+)$/i);
    if (targetMatch) metadata.targetMachine = targetMatch[1].trim().slice(0, 64);
    const deliveryMatch = line.match(/^delivery_id\s*[：:]\s*(.+)$/i);
    if (deliveryMatch) metadata.deliveryId = deliveryMatch[1].trim().slice(0, 128);
    const requestMatch = line.match(/^request_id\s*[：:]\s*(.+)$/i);
    if (requestMatch) metadata.requestId = requestMatch[1].trim().slice(0, 128);
    const sourceConversationMatch = line.match(/^source_conversation_id\s*[：:]\s*(.+)$/i);
    if (sourceConversationMatch) metadata.sourceConversationId = sourceConversationMatch[1].trim().slice(0, 256);
    const conversationMatch = line.match(/^target_conversation_id\s*[：:]\s*(.+)$/i);
    if (conversationMatch) metadata.targetConversationId = conversationMatch[1].trim().slice(0, 256);
    const receiptMatch = line.match(/^receipt_stage\s*[：:]\s*(.+)$/i);
    if (receiptMatch) metadata.receiptStage = receiptMatch[1].trim().slice(0, 64);
    const deliverySequenceMatch = line.match(/^delivery_message_seq\s*[：:]\s*(.+)$/i);
    if (deliverySequenceMatch) metadata.deliveryMessageSeq = deliverySequenceMatch[1].trim().slice(0, 64);
    const proposedTaskMatch = line.match(/^proposed_task_id\s*[：:]\s*(.+)$/i);
    if (proposedTaskMatch) metadata.proposedTaskId = proposedTaskMatch[1].trim().slice(0, 128);
    const previousTaskMatch = line.match(/^previous_task_id\s*[：:]\s*(.+)$/i);
    if (previousTaskMatch) metadata.previousTaskId = previousTaskMatch[1].trim().slice(0, 128);
    const routeMatch = line.match(/^(?:route_key|路由)\s*[：:]\s*(.+)$/i);
    if (routeMatch) metadata.routeKey = routeMatch[1].trim().slice(0, 256);
  }
  return metadata;
}

function oneBotControlSegments(message) {
  const mentionedUserIds = [];
  let replyMessageId = "";
  if (Array.isArray(message?.message)) {
    for (const segment of message.message) {
      if (segment?.type === "at") {
        const userId = String(segment?.data?.qq ?? segment?.data?.user_id ?? "");
        if (userId) mentionedUserIds.push(userId);
      }
      if (segment?.type === "reply" && !replyMessageId) {
        replyMessageId = String(segment?.data?.id ?? segment?.data?.message_id ?? "");
      }
    }
  }
  const rawMessage = typeof message?.raw_message === "string"
    ? message.raw_message
    : typeof message?.message === "string"
      ? message.message
      : "";
  for (const match of rawMessage.matchAll(/\[CQ:(at|reply)(?:,([^\]]*))?\]/g)) {
    const attributes = {};
    for (const part of String(match[2] ?? "").split(",")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      attributes[part.slice(0, separator)] = decodeCqValue(part.slice(separator + 1));
    }
    if (match[1] === "at") {
      const userId = String(attributes.qq ?? attributes.user_id ?? "");
      if (userId) mentionedUserIds.push(userId);
    }
    if (match[1] === "reply" && !replyMessageId) {
      replyMessageId = String(attributes.id ?? attributes.message_id ?? "");
    }
  }
  return {
    mentionedUserIds: [...new Set(mentionedUserIds)],
    replyMessageId,
  };
}

function taskFileIndexMetadata(text) {
  const normalizedText = normalizeComparableText(text);
  if (!normalizedText.includes("[Codex][TASK_FILE_INDEX]")) return null;
  const metadata = {
    fileId: "",
    fileMessageSeq: "",
    busId: null,
    fileName: "",
    fileBytes: null,
  };
  for (const line of normalizedText.split("\n")) {
    const fileIdMatch = line.match(/^file_id\s*[：:]\s*(.+)$/i);
    if (fileIdMatch) metadata.fileId = fileIdMatch[1].trim();
    const messageSeqMatch = line.match(/^file_message_seq\s*[：:]\s*(.+)$/i);
    if (messageSeqMatch) metadata.fileMessageSeq = messageSeqMatch[1].trim();
    const busIdMatch = line.match(/^busid\s*[：:]\s*(.+)$/i);
    if (busIdMatch) {
      const parsedBusId = Number(busIdMatch[1].trim());
      if (Number.isSafeInteger(parsedBusId) && parsedBusId >= 0) metadata.busId = parsedBusId;
    }
    const fileNameMatch = line.match(/^文件名\s*[：:]\s*(.+)$/);
    if (fileNameMatch) metadata.fileName = fileNameMatch[1].trim();
    const fileBytesMatch = line.match(/^字节数\s*[：:]\s*(.+)$/);
    if (fileBytesMatch) {
      const parsedFileBytes = Number(fileBytesMatch[1].trim());
      if (Number.isSafeInteger(parsedFileBytes) && parsedFileBytes > 0) metadata.fileBytes = parsedFileBytes;
    }
  }
  return metadata.fileId ? metadata : null;
}

function summarizeGroupMessage(message, expectedSelfId) {
  const timestamp = Number(message?.time ?? 0);
  const text = oneBotReadableText(message);
  const taskMetadata = structuredTaskMetadata(text);
  const controlSegments = oneBotControlSegments(message);
  const contentSummary = oneBotContentSummary(message);
  return {
    messageId: String(message?.message_id ?? ""),
    messageSeq: String(message?.message_seq ?? message?.message_id ?? ""),
    time: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    senderId: String(message?.sender?.user_id ?? message?.user_id ?? ""),
    senderName: String(message?.sender?.card ?? message?.sender?.nickname ?? ""),
    isSelf: String(message?.sender?.user_id ?? message?.user_id ?? "") === expectedSelfId,
    text,
    taskId: taskMetadata.taskId,
    sourceMachine: taskMetadata.sourceMachine,
    targetMachine: taskMetadata.targetMachine,
    deliveryId: taskMetadata.deliveryId,
    messageType: taskMetadata.messageType,
    requestId: taskMetadata.requestId,
    sourceConversationId: taskMetadata.sourceConversationId,
    targetConversationId: taskMetadata.targetConversationId,
    receiptStage: taskMetadata.receiptStage,
    deliveryMessageSeq: taskMetadata.deliveryMessageSeq,
    proposedTaskId: taskMetadata.proposedTaskId,
    previousTaskId: taskMetadata.previousTaskId,
    routeKey: taskMetadata.routeKey,
    mentionedUserIds: controlSegments.mentionedUserIds,
    replyMessageId: controlSegments.replyMessageId,
    attachments: oneBotDeferredAttachments(message),
    hasExplicitText: contentSummary.hasExplicitText,
    contentTypes: contentSummary.contentTypes,
  };
}

function stableDeliveryId(kind, dedupeKey) {
  return createHash("sha256").update(`delivery:${kind}\0${dedupeKey}`, "utf8").digest("hex");
}

function publicError(error) {
  return {
    code: error instanceof NapCatNotifierError ? error.code : "UNEXPECTED_ERROR",
    message: error?.message || String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
  };
}

function formatProgress(input) {
  const parts = [];
  const progress = boundedString(input.progress, "progress", 240);
  const checkpointAt = boundedString(input.checkpoint_at, "checkpoint_at", 80);
  const nextCheckAt = boundedString(input.next_check_at, "next_check_at", 80);
  if (progress) parts.push(`进度：${progress}`);
  if (checkpointAt) parts.push(`最近存档：${checkpointAt}`);
  if (nextCheckAt) parts.push(`下次检查：${nextCheckAt}`);
  return parts;
}

function normalizeEventInput(input, binding) {
  const event = boundedString(input.event, "event", 32, true).toLowerCase();
  if (!binding.allowedEvents.includes(event)) {
    throw new NapCatNotifierError("EVENT_NOT_ALLOWED", `binding 不允许事件：${event}`);
  }
  return {
    event,
    taskId: boundedString(input.task_id, "task_id", 128, true),
    runId: boundedString(input.run_id, "run_id", 128),
    dedupeKey: boundedString(input.dedupe_key, "dedupe_key", 200, true),
    summary: boundedString(input.summary, "summary", 500),
    progress: boundedString(input.progress, "progress", 240),
    checkpointAt: boundedString(input.checkpoint_at, "checkpoint_at", 80),
    nextCheckAt: boundedString(input.next_check_at, "next_check_at", 80),
  };
}

function buildTrainingMessage(normalizedInput, nowDate) {
  const lines = [
    `[训练机][${normalizedInput.event.toUpperCase()}]`,
    `任务：${normalizedInput.taskId}`,
  ];
  if (normalizedInput.runId) lines.push(`运行：${normalizedInput.runId}`);
  lines.push(...formatProgress({
    progress: normalizedInput.progress,
    checkpoint_at: normalizedInput.checkpointAt,
    next_check_at: normalizedInput.nextCheckAt,
  }));
  if (normalizedInput.summary) lines.push(`摘要：${normalizedInput.summary}`);
  lines.push(`时间：${nowDate.toISOString()}`);
  return lines.join("\n");
}

function normalizeTextInput(input) {
  const taskId = boundedString(input.task_id, "task_id", 128);
  const dedupeKey = boundedString(input.dedupe_key, "dedupe_key", 200, true);
  return {
    event: "message",
    taskId: taskId || "fixed-group-text",
    runId: "",
    dedupeKey,
    deliveryId: boundedString(input.delivery_id, "delivery_id", 128) || stableDeliveryId("text", dedupeKey),
    text: boundedString(input.text, "text", 1000, true),
    sourceMachine: outboundMachineRole(input.source_machine, "source_machine", Boolean(taskId)),
    targetMachine: outboundMachineRole(input.target_machine, "target_machine", Boolean(taskId)),
  };
}

function buildTextMessage(normalizedInput, nowDate) {
  if (normalizedInput.taskId !== "fixed-group-text") {
    const lines = ["[Codex][TASK_MESSAGE]", `任务：${normalizedInput.taskId}`];
    if (normalizedInput.sourceMachine) lines.push(`来源机器：${normalizedInput.sourceMachine}`);
    if (normalizedInput.targetMachine) lines.push(`目标机器：${normalizedInput.targetMachine}`);
    lines.push(`delivery_id：${normalizedInput.deliveryId}`);
    lines.push(`正文：${normalizedInput.text}`, `时间：${nowDate.toISOString()}`);
    return lines.join("\n");
  }
  return [
    "[Codex][MESSAGE]",
    normalizedInput.text,
    `时间：${nowDate.toISOString()}`,
  ].join("\n");
}

function buildTaskFileIndexMessage(normalizedInput, file, nowDate) {
  const lines = [
    "[Codex][TASK_FILE_INDEX]",
    `任务：${normalizedInput.taskId}`,
    `来源机器：${normalizedInput.sourceMachine || "未指定"}`,
    `目标机器：${normalizedInput.targetMachine || "未指定"}`,
    `delivery_id：${normalizedInput.deliveryId}`,
    `file_id：${file.fileId}`,
  ];
  if (file.messageSeq) lines.push(`file_message_seq：${file.messageSeq}`);
  if (Number.isSafeInteger(file.busId) && file.busId >= 0) lines.push(`busid：${file.busId}`);
  lines.push(
    `文件名：${file.fileName}`,
    `字节数：${file.fileBytes}`,
    `sha256：${file.sha256}`,
    `时间：${nowDate.toISOString()}`,
  );
  return lines.join("\n");
}

function taskFileIndexDedupeKey(fileDedupeKey) {
  const digest = createHash("sha256").update(fileDedupeKey, "utf8").digest("hex");
  return `task-file-index:${digest}`;
}

function normalizeFileInput(input, maximumFileBytes) {
  const requestedPath = boundedString(input.file_path, "file_path", 4096, true);
  if (!path.isAbsolute(requestedPath)) {
    throw new NapCatNotifierError("FILE_PATH_NOT_ABSOLUTE", "file_path 必须是本机绝对路径");
  }
  let filePath;
  let fileStat;
  try {
    filePath = fs.realpathSync(requestedPath);
    fileStat = fs.statSync(filePath);
  } catch (error) {
    throw new NapCatNotifierError("FILE_NOT_FOUND", `无法读取待发送文件：${requestedPath}`, { cause: error });
  }
  if (!fileStat.isFile()) {
    throw new NapCatNotifierError("FILE_NOT_REGULAR", "file_path 必须指向普通文件");
  }
  if (fileStat.size <= 0) {
    throw new NapCatNotifierError("FILE_EMPTY", "拒绝发送空文件");
  }
  if (fileStat.size > maximumFileBytes) {
    throw new NapCatNotifierError("FILE_TOO_LARGE", `文件超过 ${maximumFileBytes} 字节上限`);
  }
  const requestedName = boundedString(input.name || path.basename(filePath), "name", 255, true);
  if (requestedName !== path.basename(requestedName) || requestedName === "." || requestedName === "..") {
    throw new NapCatNotifierError("INVALID_FILE_NAME", "name 只能是文件名，不能包含目录");
  }
  const taskId = boundedString(input.task_id, "task_id", 128);
  const sourceMachine = outboundMachineRole(input.source_machine, "source_machine", Boolean(taskId));
  const targetMachine = outboundMachineRole(input.target_machine, "target_machine", Boolean(taskId));
  const dedupeKey = boundedString(input.dedupe_key, "dedupe_key", 200, true);
  return {
    event: "file",
    taskId: taskId || "fixed-group-file",
    hasTaskId: Boolean(taskId),
    runId: "",
    dedupeKey,
    deliveryId: boundedString(input.delivery_id, "delivery_id", 128) || stableDeliveryId("file-index", dedupeKey),
    filePath,
    fileName: requestedName,
    fileBytes: fileStat.size,
    sourceMachine,
    targetMachine,
  };
}

function normalizeDownloadInput(input) {
  const fileId = boundedString(input.file_id, "file_id", 2048, true);
  const destinationDirectory = boundedString(input.destination_dir, "destination_dir", 4096, true);
  if (!path.isAbsolute(destinationDirectory)) {
    throw new NapCatNotifierError("DOWNLOAD_DIRECTORY_NOT_ABSOLUTE", "destination_dir 必须是本机绝对路径");
  }
  const requestedName = boundedString(input.name, "name", 255);
  if (requestedName && (requestedName !== path.basename(requestedName) || requestedName === "." || requestedName === "..")) {
    throw new NapCatNotifierError("INVALID_FILE_NAME", "name 只能是文件名，不能包含目录");
  }
  const messageSeq = boundedString(input.message_seq, "message_seq", 64);
  let busId = null;
  if (input.busid !== undefined && input.busid !== null && input.busid !== "") {
    const parsedBusId = Number(input.busid);
    if (!Number.isSafeInteger(parsedBusId) || parsedBusId < 0) {
      throw new NapCatNotifierError("INVALID_BUS_ID", "busid 必须是非负安全整数");
    }
    busId = parsedBusId;
  }
  return {
    fileId,
    destinationDirectory: path.resolve(destinationDirectory),
    requestedName,
    messageSeq,
    busId,
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

export function createNapCatNotifier(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const writeState = options.writeState ?? atomicWriteJson;
  const bindingPath = resolveConfiguredPath(
    env.NAPCAT_MCP_BINDING_PATH,
    "binding.json",
    cwd,
    env,
  );
  const statePath = resolveConfiguredPath(
    env.NAPCAT_MCP_STATE_PATH,
    path.join("state", "dedupe.json"),
    cwd,
    env,
  );
  const baseUrl = String(env.NAPCAT_HTTP_URL || "http://127.0.0.1:3010").replace(/\/+$/, "");
  const accessToken = String(env.NAPCAT_ACCESS_TOKEN || "");
  const allowEmptyToken = env.NAPCAT_ALLOW_EMPTY_TOKEN === "1";
  const timeoutMs = positiveInteger(env.NAPCAT_HTTP_TIMEOUT_MS, 10000, 1000, 120000);
  const fileUploadTimeoutMs = positiveInteger(env.NAPCAT_FILE_UPLOAD_TIMEOUT_MS, 600000, 10000, 1800000);
  const fileDownloadTimeoutMs = positiveInteger(env.NAPCAT_FILE_DOWNLOAD_TIMEOUT_MS, 600000, 10000, 1800000);
  const maximumFileBytes = positiveInteger(env.NAPCAT_MAX_FILE_BYTES, 2147483648, 1, 10737418240);
  const inFlight = new Set();

  if (typeof fetchImpl !== "function") {
    throw new NapCatNotifierError("FETCH_UNAVAILABLE", "当前 Node 运行时没有 fetch 支持");
  }

  function writeStateAfterSideEffect(state) {
    try {
      writeState(statePath, state);
      return null;
    } catch (error) {
      return {
        ...publicError(error),
        code: error?.code || "STATE_WRITE_FAILED",
      };
    }
  }

  function persistenceResult(error) {
    return {
      statePersisted: error === null,
      statePersistenceError: error,
      ...(error ? { retryRecommended: false } : {}),
    };
  }

  function loadBinding() {
    return normalizeBinding(readJsonFile(bindingPath, "BINDING_MISSING"));
  }

  function requireConnectionConfiguration() {
    if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(baseUrl) && !/^https?:\/\/localhost(?::\d+)?$/i.test(baseUrl)) {
      throw new NapCatNotifierError("NON_LOOPBACK_URL", "NAPCAT_HTTP_URL 必须是本机回环地址");
    }
    if (!accessToken && !allowEmptyToken) {
      throw new NapCatNotifierError("TOKEN_MISSING", "未配置 NAPCAT_ACCESS_TOKEN");
    }
  }

  async function callOneBot(action, params = {}, requestTimeoutMs = timeoutMs) {
    requireConnectionConfiguration();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error?.name === "AbortError";
      throw new NapCatNotifierError(
        aborted ? "ONEBOT_TIMEOUT" : "ONEBOT_NETWORK_ERROR",
        aborted ? `OneBot 请求 ${action} 超时` : `OneBot 请求 ${action} 失败`,
        { cause: error, outcomeUnknown: true },
      );
    } finally {
      clearTimeout(timeout);
    }

    let envelope;
    const responseText = await response.text();
    try {
      envelope = JSON.parse(responseText);
    } catch (error) {
      throw new NapCatNotifierError("ONEBOT_INVALID_JSON", `OneBot ${action} 返回了无效 JSON`, {
        cause: error,
        outcomeUnknown: response.ok,
      });
    }
    if (!response.ok) {
      throw new NapCatNotifierError("ONEBOT_HTTP_ERROR", `OneBot ${action} 返回 HTTP ${response.status}`, {
        outcomeUnknown: (action === "send_group_msg" || action === "upload_group_file") && response.status >= 500,
        details: { status: response.status, retcode: envelope?.retcode ?? null },
      });
    }
    if (envelope?.status !== "ok" || Number(envelope?.retcode ?? 0) !== 0) {
      throw new NapCatNotifierError("ONEBOT_ACTION_FAILED", `OneBot ${action} 执行失败`, {
        outcomeUnknown: action === "send_group_msg" || action === "send_private_msg" || action === "upload_group_file",
        details: { retcode: envelope?.retcode ?? null, wording: envelope?.wording ?? "" },
      });
    }
    return envelope.data ?? null;
  }

  function verifyLogin(binding, loginInfo) {
    const actualSelfId = String(loginInfo?.user_id ?? loginInfo?.self_id ?? "");
    const actualNickname = String(loginInfo?.nickname ?? "");
    if (binding.expectedSelfId && actualSelfId !== binding.expectedSelfId) {
      throw new NapCatNotifierError("SELF_ID_MISMATCH", "当前 NapCat 登录账号与 binding 不一致", {
        details: { expectedSelfId: binding.expectedSelfId, actualSelfId },
      });
    }
    if (binding.expectedNickname && actualNickname && actualNickname !== binding.expectedNickname) {
      throw new NapCatNotifierError("NICKNAME_MISMATCH", "当前 NapCat 昵称与 binding 不一致", {
        details: { expectedNickname: binding.expectedNickname, actualNickname },
      });
    }
    return { actualSelfId, actualNickname };
  }

  function verifyGroup(binding, groupInfo) {
    const actualGroupId = String(groupInfo?.group_id ?? "");
    const actualGroupName = String(groupInfo?.group_name ?? "");
    const actualMemberCount = Number(groupInfo?.member_count ?? 0);
    if (actualGroupId !== binding.groupId) {
      throw new NapCatNotifierError("GROUP_ID_MISMATCH", "OneBot 返回的群号与 binding 不一致");
    }
    if (actualGroupName !== binding.groupName) {
      throw new NapCatNotifierError("GROUP_NAME_MISMATCH", "目标群名与 binding 不一致", {
        details: { expected: binding.groupName, actual: actualGroupName },
      });
    }
    if (actualMemberCount !== binding.expectedMemberCount) {
      throw new NapCatNotifierError("GROUP_MEMBER_COUNT_MISMATCH", "目标群成员数与 binding 不一致", {
        details: { expected: binding.expectedMemberCount, actual: actualMemberCount },
      });
    }
    return { actualGroupId, actualGroupName, actualMemberCount };
  }

  async function checkTarget(binding) {
    if (!binding.expectedSelfId || !binding.groupId) {
      throw new NapCatNotifierError("BINDING_INCOMPLETE", "binding.json 尚未填写 expectedSelfId 和 groupId");
    }
    const runtimeStatus = await callOneBot("get_status");
    if (runtimeStatus?.online === false || runtimeStatus?.good === false) {
      throw new NapCatNotifierError("NAPCAT_NOT_READY", "NapCat 当前不在线或状态异常");
    }
    const login = verifyLogin(binding, await callOneBot("get_login_info"));
    const group = binding.requireGroupIdentityCheckBeforeSend
      ? verifyGroup(binding, await callOneBot("get_group_info", { group_id: binding.groupId, no_cache: true }))
      : { actualGroupId: binding.groupId, actualGroupName: binding.groupName, actualMemberCount: null };
    return { runtimeStatus, login, group };
  }

  function requireControlPlane(binding) {
    if (!binding.controlPlane.enabled) {
      throw new NapCatNotifierError("CONTROL_PLANE_DISABLED", "binding 尚未启用 controlPlane");
    }
    return binding.controlPlane;
  }

  async function checkConfiguredTarget(binding, targetKey) {
    const controlPlane = requireControlPlane(binding);
    const resolvedKey = boundedString(
      targetKey || controlPlane.defaultTargetKey,
      "target_key",
      64,
      true,
    );
    const target = controlPlane.targets[resolvedKey];
    if (!target) {
      throw new NapCatNotifierError("CONTROL_TARGET_NOT_FOUND", `binding 未定义控制目标：${resolvedKey}`);
    }
    const runtimeStatus = await callOneBot("get_status");
    if (runtimeStatus?.online === false || runtimeStatus?.good === false) {
      throw new NapCatNotifierError("NAPCAT_NOT_READY", "NapCat 当前不在线或状态异常");
    }
    const login = verifyLogin(binding, await callOneBot("get_login_info"));
    if (target.type === "private") {
      const friends = await callOneBot("get_friend_list", { no_cache: true });
      const friend = (Array.isArray(friends) ? friends : [])
        .find((item) => String(item?.user_id ?? "") === target.id);
      if (!friend) {
        throw new NapCatNotifierError("PRIVATE_TARGET_NOT_FRIEND", `私聊目标不在当前账号好友列表：${resolvedKey}`);
      }
      return {
        runtimeStatus,
        login,
        target: {
          targetKey: resolvedKey,
          type: "private",
          id: target.id,
          name: target.name || String(friend.remark ?? friend.nickname ?? ""),
        },
      };
    }
    const groupInfo = await callOneBot("get_group_info", { group_id: target.id, no_cache: true });
    const actualName = String(groupInfo?.group_name ?? "");
    const actualMemberCount = Number(groupInfo?.member_count ?? 0);
    if (target.name && actualName !== target.name) {
      throw new NapCatNotifierError("CONTROL_GROUP_NAME_MISMATCH", `控制群名称与 binding 不一致：${resolvedKey}`);
    }
    if (target.expectedMemberCount && actualMemberCount !== target.expectedMemberCount) {
      throw new NapCatNotifierError("CONTROL_GROUP_MEMBER_COUNT_MISMATCH", `控制群成员数与 binding 不一致：${resolvedKey}`);
    }
    return {
      runtimeStatus,
      login,
      target: {
        targetKey: resolvedKey,
        type: "group",
        id: target.id,
        name: actualName,
        memberCount: actualMemberCount,
        mentionUserId: target.mentionUserId || "",
      },
    };
  }

  function getControlPlaneConfig() {
    const binding = loadBinding();
    const controlPlane = binding.controlPlane;
    return {
      enabled: controlPlane.enabled,
      machineIngressEnabled: controlPlane.machineIngressEnabled,
      localMachine: controlPlane.localMachine,
      trustedPeerQq: controlPlane.trustedPeerQq,
      expectedSelfId: binding.expectedSelfId,
      defaultTargetKey: controlPlane.defaultTargetKey,
      targets: Object.fromEntries(Object.entries(controlPlane.targets).map(([key, target]) => [
        key,
        {
          type: target.type,
          name: target.name,
          expectedMemberCount: target.expectedMemberCount,
          mentionConfigured: Boolean(target.mentionUserId),
        },
      ])),
    };
  }

  async function readConfiguredTargetMessages(input = {}) {
    const binding = loadBinding();
    const targetCheck = await checkConfiguredTarget(binding, input.target_key);
    const count = positiveInteger(input.count, 20, 1, 50);
    const action = targetCheck.target.type === "private"
      ? "get_friend_msg_history"
      : "get_group_msg_history";
    const history = await callOneBot(action, {
      ...(targetCheck.target.type === "private"
        ? { user_id: targetCheck.target.id }
        : { group_id: targetCheck.target.id }),
      count,
      reverse_order: input.reverse_order === true,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: false,
    });
    const messages = (Array.isArray(history?.messages) ? history.messages : [])
      .map((message) => summarizeGroupMessage(message, binding.expectedSelfId));
    return {
      target: targetCheck.target,
      identity: targetCheck.login,
      requestedCount: count,
      returnedCount: messages.length,
      messages,
    };
  }

  async function status(optionsInput = {}) {
    let binding;
    try {
      binding = loadBinding();
      requireConnectionConfiguration();
    } catch (error) {
      return {
        ready: false,
        reachable: false,
        bindingPath,
        statePath,
        baseUrl,
        tokenConfigured: Boolean(accessToken),
        error: publicError(error),
      };
    }
    try {
      const runtimeStatus = await callOneBot("get_status");
      const loginInfo = await callOneBot("get_login_info");
      let identity = null;
      let identityError = null;
      try {
        identity = verifyLogin(binding, loginInfo);
      } catch (error) {
        identityError = publicError(error);
      }
      let group = null;
      let groupError = null;
      if (optionsInput.include_group !== false && binding.groupId) {
        try {
          group = verifyGroup(binding, await callOneBot("get_group_info", {
            group_id: binding.groupId,
            no_cache: true,
          }));
        } catch (error) {
          groupError = publicError(error);
        }
      }
      return {
        ready: Boolean(identity && (!binding.groupId || group) && runtimeStatus?.online !== false && runtimeStatus?.good !== false),
        reachable: true,
        baseUrl,
        tokenConfigured: Boolean(accessToken),
        binding: {
          bindingName: binding.bindingName,
          expectedSelfId: binding.expectedSelfId,
          expectedNickname: binding.expectedNickname,
          groupId: binding.groupId,
          groupName: binding.groupName,
          expectedMemberCount: binding.expectedMemberCount,
        },
        controlPlane: {
          enabled: binding.controlPlane.enabled,
          machineIngressEnabled: binding.controlPlane.machineIngressEnabled,
          machineIngressReady: Boolean(
            binding.controlPlane.enabled
            && binding.controlPlane.machineIngressEnabled
            && binding.controlPlane.localMachine
            && binding.controlPlane.trustedPeerQq
          ),
          localMachine: binding.controlPlane.localMachine,
          trustedPeerConfigured: Boolean(binding.controlPlane.trustedPeerQq),
          targetCount: Object.keys(binding.controlPlane.targets).length,
          defaultTargetKey: binding.controlPlane.defaultTargetKey,
        },
        runtimeStatus,
        identity,
        identityError,
        group,
        groupError,
      };
    } catch (error) {
      return {
        ready: false,
        reachable: false,
        baseUrl,
        tokenConfigured: Boolean(accessToken),
        binding: {
          bindingName: binding.bindingName,
          expectedSelfId: binding.expectedSelfId,
          groupId: binding.groupId,
          groupName: binding.groupName,
        },
        controlPlane: {
          enabled: binding.controlPlane.enabled,
          machineIngressEnabled: binding.controlPlane.machineIngressEnabled,
          machineIngressReady: Boolean(
            binding.controlPlane.enabled
            && binding.controlPlane.machineIngressEnabled
            && binding.controlPlane.localMachine
            && binding.controlPlane.trustedPeerQq
          ),
          localMachine: binding.controlPlane.localMachine,
          trustedPeerConfigured: Boolean(binding.controlPlane.trustedPeerQq),
          targetCount: Object.keys(binding.controlPlane.targets).length,
          defaultTargetKey: binding.controlPlane.defaultTargetKey,
        },
        error: publicError(error),
      };
    }
  }

  async function discoverTarget() {
    const binding = loadBinding();
    const loginInfo = await callOneBot("get_login_info");
    const identity = verifyLogin(binding, loginInfo);
    const groups = await callOneBot("get_group_list", { no_cache: true });
    const candidates = (Array.isArray(groups) ? groups : [])
      .filter((group) => String(group.group_name ?? "") === binding.groupName)
      .filter((group) => Number(group.member_count ?? 0) === binding.expectedMemberCount)
      .map((group) => ({
        groupId: String(group.group_id ?? ""),
        groupName: String(group.group_name ?? ""),
        memberCount: Number(group.member_count ?? 0),
      }));
    return {
      bindingName: binding.bindingName,
      identity,
      expectedGroupName: binding.groupName,
      expectedMemberCount: binding.expectedMemberCount,
      candidates,
      uniqueMatch: candidates.length === 1 ? candidates[0] : null,
    };
  }

  async function readRecentMessages(input = {}) {
    const binding = loadBinding();
    const targetCheck = await checkTarget(binding);
    const count = positiveInteger(input.count, 20, 1, 50);
    const messageSeq = boundedString(input.message_seq, "message_seq", 64);
    const requestedTaskId = boundedString(input.task_id, "task_id", 128);
    const history = await callOneBot("get_group_msg_history", {
      group_id: binding.groupId,
      ...(messageSeq ? { message_seq: messageSeq } : {}),
      count,
      reverse_order: input.reverse_order === true,
      disable_get_url: true,
      parse_mult_msg: false,
      quick_reply: false,
    });
    const scannedMessages = (Array.isArray(history?.messages) ? history.messages : [])
      .map((message) => summarizeGroupMessage(message, binding.expectedSelfId));
    const messages = requestedTaskId
      ? scannedMessages.filter((message) => message.taskId === requestedTaskId)
      : scannedMessages;
    return {
      target: targetCheck.group,
      identity: targetCheck.login,
      requestedCount: count,
      requestedTaskId: requestedTaskId || null,
      scannedCount: scannedMessages.length,
      returnedCount: messages.length,
      messages,
    };
  }

  function previewTrainingEvent(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeEventInput(input, binding);
    return {
      bindingName: binding.bindingName,
      target: {
        groupId: binding.groupId,
        groupName: binding.groupName,
        expectedMemberCount: binding.expectedMemberCount,
      },
      event: normalizedInput.event,
      dedupeKey: normalizedInput.dedupeKey,
      message: buildTrainingMessage(normalizedInput, now()),
    };
  }

  function previewTextMessage(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeTextInput(input);
    return {
      bindingName: binding.bindingName,
      target: {
        groupId: binding.groupId,
        groupName: binding.groupName,
        expectedMemberCount: binding.expectedMemberCount,
      },
      dedupeKey: normalizedInput.dedupeKey,
      deliveryId: normalizedInput.deliveryId,
      message: buildTextMessage(normalizedInput, now()),
    };
  }

  async function previewFile(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeFileInput(input, maximumFileBytes);
    return {
      bindingName: binding.bindingName,
      target: {
        groupId: binding.groupId,
        groupName: binding.groupName,
        expectedMemberCount: binding.expectedMemberCount,
      },
      dedupeKey: normalizedInput.dedupeKey,
      deliveryId: normalizedInput.deliveryId,
      filePath: normalizedInput.filePath,
      fileName: normalizedInput.fileName,
      fileBytes: normalizedInput.fileBytes,
      sha256: await sha256File(normalizedInput.filePath),
    };
  }

  async function primeGroupFileLookup(binding, normalizedInput) {
    try {
      const history = await callOneBot("get_group_msg_history", {
        group_id: binding.groupId,
        ...(normalizedInput.messageSeq ? { message_seq: normalizedInput.messageSeq } : {}),
        count: 50,
        reverse_order: true,
        disable_get_url: true,
        parse_mult_msg: false,
        quick_reply: false,
      });
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const summarizedMessages = messages
        .map((message) => summarizeGroupMessage(message, binding.expectedSelfId))
        .sort((left, right) => {
          const leftTimestamp = Date.parse(left.time ?? "");
          const rightTimestamp = Date.parse(right.time ?? "");
          if (!Number.isFinite(leftTimestamp) || !Number.isFinite(rightTimestamp)) return 0;
          return leftTimestamp - rightTimestamp;
        });
      const matchingMessage = summarizedMessages
        .find((message) => message.attachments.some((attachment) => attachment.fileId === normalizedInput.fileId));
      const matchingAttachment = matchingMessage?.attachments
        .find((attachment) => attachment.fileId === normalizedInput.fileId) ?? null;
      if (matchingAttachment) {
        return {
          attempted: true,
          matched: true,
          resolution: "exact_file_id",
          messageSeq: matchingMessage.messageSeq,
          resolvedFileId: matchingAttachment.fileId,
          resolvedBusId: matchingAttachment.busId,
        };
      }

      const anchorIndex = normalizedInput.messageSeq
        ? summarizedMessages.findIndex((message) => message.messageSeq === normalizedInput.messageSeq)
        : -1;
      const anchorMessage = anchorIndex >= 0 ? summarizedMessages[anchorIndex] : null;
      const indexMetadata = anchorMessage ? taskFileIndexMetadata(anchorMessage.text) : null;
      const expectedFileName = indexMetadata?.fileName || normalizedInput.requestedName;
      const requestedNameMatches = !normalizedInput.requestedName
        || !indexMetadata?.fileName
        || normalizedInput.requestedName === indexMetadata.fileName;
      let resolvedMessage = null;
      let resolvedAttachment = null;
      if (
        anchorMessage
        && indexMetadata?.fileId === normalizedInput.fileId
        && expectedFileName
        && indexMetadata.fileBytes !== null
        && requestedNameMatches
      ) {
        const anchorTimestamp = Date.parse(anchorMessage.time ?? "");
        const candidateMessages = summarizedMessages
          .map((message, index) => ({
            message,
            index,
            timestamp: Date.parse(message.time ?? ""),
          }))
          .filter((candidate) => candidate.index !== anchorIndex)
          .filter((candidate) =>
            Number.isFinite(anchorTimestamp)
            && Number.isFinite(candidate.timestamp)
            && anchorTimestamp - candidate.timestamp >= 0
            && anchorTimestamp - candidate.timestamp <= 300000
          )
          .sort((left, right) =>
            (anchorTimestamp - left.timestamp) - (anchorTimestamp - right.timestamp)
            || Math.abs(left.index - anchorIndex) - Math.abs(right.index - anchorIndex)
          );
        for (const candidate of candidateMessages) {
          const candidateMessage = candidate.message;
          if (candidateMessage.senderId !== anchorMessage.senderId) continue;
          const candidateAttachment = candidateMessage.attachments.find((attachment) =>
            attachment.fileName === expectedFileName
            && attachment.fileBytes === indexMetadata.fileBytes
          );
          if (!candidateAttachment) continue;
          resolvedMessage = candidateMessage;
          resolvedAttachment = candidateAttachment;
          break;
        }
      }
      return {
        attempted: true,
        matched: Boolean(resolvedAttachment),
        resolution: resolvedAttachment ? "legacy_task_index" : null,
        messageSeq: resolvedMessage?.messageSeq ?? null,
        resolvedFileId: resolvedAttachment?.fileId ?? null,
        resolvedBusId: resolvedAttachment?.busId ?? null,
      };
    } catch (error) {
      return {
        attempted: true,
        matched: false,
        resolution: null,
        messageSeq: null,
        resolvedFileId: null,
        resolvedBusId: null,
        error: publicError(error),
      };
    }
  }

  async function downloadFile(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeDownloadInput(input);
    const targetCheck = await checkTarget(binding);
    let lookupPayload = {
      group_id: binding.groupId,
      file_id: normalizedInput.fileId,
      ...(normalizedInput.busId !== null ? { busid: normalizedInput.busId } : {}),
    };
    let urlData;
    let cacheRefresh = null;
    try {
      urlData = await callOneBot("get_group_file_url", lookupPayload);
    } catch (firstError) {
      cacheRefresh = await primeGroupFileLookup(binding, normalizedInput);
      if (cacheRefresh.resolvedFileId && cacheRefresh.resolvedFileId !== normalizedInput.fileId) {
        lookupPayload = {
          group_id: binding.groupId,
          file_id: cacheRefresh.resolvedFileId,
          ...(cacheRefresh.resolvedBusId !== null ? { busid: cacheRefresh.resolvedBusId } : {}),
        };
      }
      try {
        urlData = await callOneBot("get_group_file_url", lookupPayload);
      } catch (retryError) {
        retryError.initialLookupError = publicError(firstError);
        retryError.cacheRefresh = cacheRefresh;
        throw retryError;
      }
    }
    const downloadUrl = String(urlData?.url ?? "");
    let parsedUrl;
    try {
      parsedUrl = new URL(downloadUrl);
    } catch (error) {
      throw new NapCatNotifierError("FILE_URL_INVALID", "NapCat 没有返回有效的群文件下载地址", { cause: error });
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new NapCatNotifierError("FILE_URL_INVALID", "NapCat 返回的群文件下载地址不是 HTTP(S)");
    }

    const urlName = decodeURIComponent(path.posix.basename(parsedUrl.pathname || ""));
    const fallbackName = `napcat-file-${createHash("sha256").update(normalizedInput.fileId).digest("hex").slice(0, 12)}`;
    const fileName = normalizedInput.requestedName || urlName || fallbackName;
    if (fileName !== path.basename(fileName) || fileName === "." || fileName === "..") {
      throw new NapCatNotifierError("INVALID_FILE_NAME", "下载文件名包含目录或无效路径");
    }
    fs.mkdirSync(normalizedInput.destinationDirectory, { recursive: true });
    const destinationPath = path.join(normalizedInput.destinationDirectory, fileName);
    if (fs.existsSync(destinationPath)) {
      throw new NapCatNotifierError("DOWNLOAD_TARGET_EXISTS", `下载目标已存在，拒绝覆盖：${destinationPath}`);
    }
    const temporaryPath = `${destinationPath}.part-${process.pid}-${Date.now()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fileDownloadTimeoutMs);
    let response;
    try {
      response = await fetchImpl(downloadUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new NapCatNotifierError("FILE_DOWNLOAD_HTTP_ERROR", `群文件下载返回 HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maximumFileBytes) {
        throw new NapCatNotifierError("FILE_TOO_LARGE", `下载文件超过 ${maximumFileBytes} 字节上限`);
      }
      if (!response.body) throw new NapCatNotifierError("FILE_DOWNLOAD_EMPTY_BODY", "群文件下载响应没有正文");

      let fileBytes = 0;
      const digest = createHash("sha256");
      const meter = new Transform({
        transform(chunk, encoding, callback) {
          fileBytes += chunk.length;
          if (fileBytes > maximumFileBytes) {
            callback(new NapCatNotifierError("FILE_TOO_LARGE", `下载文件超过 ${maximumFileBytes} 字节上限`));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporaryPath, { flags: "wx" }));
      if (fileBytes <= 0) throw new NapCatNotifierError("FILE_EMPTY", "拒绝保留空的群文件下载结果");
      fs.renameSync(temporaryPath, destinationPath);
      return {
        downloaded: true,
        fileId: normalizedInput.fileId,
        resolvedFileId: lookupPayload.file_id,
        resolvedBusId: lookupPayload.busid ?? null,
        fileName,
        filePath: destinationPath,
        fileBytes,
        sha256: digest.digest("hex"),
        target: targetCheck.group,
        identity: targetCheck.login,
        cacheRefresh,
      };
    } catch (error) {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
      }
      if (error instanceof NapCatNotifierError) throw error;
      const aborted = error?.name === "AbortError";
      throw new NapCatNotifierError(
        aborted ? "FILE_DOWNLOAD_TIMEOUT" : "FILE_DOWNLOAD_FAILED",
        aborted ? "群文件下载超时" : "群文件下载失败",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async function sendTaskFileIndex(binding, normalizedInput, file) {
    const dedupeKey = taskFileIndexDedupeKey(normalizedInput.dedupeKey);
    try {
      const result = await sendFixedMessage(binding, {
        event: "task_file_index",
        taskId: normalizedInput.taskId,
        runId: "",
        dedupeKey,
        deliveryId: normalizedInput.deliveryId,
        message: buildTaskFileIndexMessage(normalizedInput, file, now()),
      });
      const existing = result.existing ?? {};
      return {
        status: result.sent ? (result.verified ? "sent_verified" : "sent_unverified") : (existing.status || result.reason || "not_sent"),
        sent: Boolean(result.sent),
        verified: result.verified ?? Boolean(existing.verified),
        duplicateSuppressed: Boolean(result.duplicateSuppressed),
        reason: result.reason ?? null,
        messageId: result.messageId ?? String(existing.messageId ?? ""),
        dedupeKey,
        deliveryId: normalizedInput.deliveryId,
        verificationError: result.verificationError ?? existing.verificationError ?? null,
        error: null,
      };
    } catch (error) {
      return {
        status: error.outcomeUnknown ? "pending_send" : "failed_before_ack",
        sent: false,
        verified: false,
        duplicateSuppressed: false,
        reason: null,
        messageId: "",
        dedupeKey,
        deliveryId: normalizedInput.deliveryId,
        verificationError: null,
        error: publicError(error),
      };
    }
  }

  async function sendFile(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeFileInput(input, maximumFileBytes);
    const currentTime = now();
    const state = loadState(statePath);
    pruneState(state, binding.dedupeRetentionDays, currentTime);
    const existing = state.entries[normalizedInput.dedupeKey];
      if (normalizedInput.hasTaskId && existing && existing.status !== "failed_before_ack") {
      if (existing.status === "sent_verified" && existing.fileId) {
        const file = {
          fileId: String(existing.fileId),
          messageSeq: String(existing.fileMessageSeq || ""),
          busId: Number.isSafeInteger(existing.fileBusId) ? existing.fileBusId : null,
          fileName: String(existing.fileName || normalizedInput.fileName),
          fileBytes: Number(existing.fileBytes ?? normalizedInput.fileBytes),
          sha256: String(existing.sha256 || await sha256File(normalizedInput.filePath)),
        };
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: "file_already_uploaded",
          verified: true,
          fileId: file.fileId,
          verifiedFileId: String(existing.verifiedFileId ?? ""),
          verificationError: existing.verificationError ?? null,
          fileName: file.fileName,
          fileBytes: file.fileBytes,
          sha256: file.sha256,
          dedupeKey: normalizedInput.dedupeKey,
          deliveryId: normalizedInput.deliveryId,
          taskIndex: await sendTaskFileIndex(binding, normalizedInput, file),
        };
      }
      return {
        sent: false,
        duplicateSuppressed: true,
        reason: existing.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
        existing,
        taskIndex: {
          status: "blocked",
          sent: false,
          verified: false,
          duplicateSuppressed: false,
          reason: existing.status === "pending_send" ? "file_upload_pending" : "file_unverified",
          messageId: "",
          dedupeKey: taskFileIndexDedupeKey(normalizedInput.dedupeKey),
          verificationError: null,
          error: null,
        },
      };
    }
    if (existing && existing.status !== "failed_before_ack") {
      return {
        sent: false,
        duplicateSuppressed: true,
        reason: existing.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
        existing,
      };
    }
    if (inFlight.has(normalizedInput.dedupeKey)) {
      return { sent: false, duplicateSuppressed: true, reason: "in_flight" };
    }

    const fileSha256 = await sha256File(normalizedInput.filePath);
    inFlight.add(normalizedInput.dedupeKey);
    let releaseDedupeLock = null;
    try {
      const targetCheck = await checkTarget(binding);
      const lockResult = acquireDedupeLock(statePath, normalizedInput.dedupeKey, currentTime);
      releaseDedupeLock = lockResult.release;
      if (!releaseDedupeLock && lockResult.existingLock?.stale) {
        throw new NapCatNotifierError(
          "STALE_SEND_LOCK",
          "发现超过 15 分钟的文件发送锁，拒绝自动删除；请先确认旧上传进程已退出。",
          { details: lockResult.existingLock },
        );
      }
      if (!releaseDedupeLock) {
        return { sent: false, duplicateSuppressed: true, reason: "cross_process_in_flight" };
      }

      const claimedState = loadState(statePath);
      pruneState(claimedState, binding.dedupeRetentionDays, currentTime);
      const claimedExisting = claimedState.entries[normalizedInput.dedupeKey];
      if (claimedExisting && claimedExisting.status !== "failed_before_ack") {
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: claimedExisting.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
          existing: claimedExisting,
        };
      }
      claimedState.entries[normalizedInput.dedupeKey] = {
        status: "pending_send",
        event: normalizedInput.event,
        taskId: normalizedInput.taskId,
        runId: normalizedInput.runId,
        createdAt: claimedExisting?.createdAt || currentTime.toISOString(),
        updatedAt: currentTime.toISOString(),
        attempts: Number(claimedExisting?.attempts ?? 0) + 1,
        fileName: normalizedInput.fileName,
        fileBytes: normalizedInput.fileBytes,
        sha256: fileSha256,
        sourceMachine: normalizedInput.sourceMachine,
        targetMachine: normalizedInput.targetMachine,
      };
      writeState(statePath, claimedState);

      let uploadData;
      try {
        uploadData = await callOneBot("upload_group_file", {
          group_id: binding.groupId,
          file: normalizedInput.filePath,
          name: normalizedInput.fileName,
          upload_file: true,
        }, fileUploadTimeoutMs);
      } catch (error) {
        const failedState = loadState(statePath);
        failedState.entries[normalizedInput.dedupeKey] = {
          ...failedState.entries[normalizedInput.dedupeKey],
          status: error.outcomeUnknown ? "pending_send" : "failed_before_ack",
          updatedAt: now().toISOString(),
          error: publicError(error),
        };
        try {
          writeState(statePath, failedState);
        } catch (stateError) {
          error.details = {
            ...(error.details ?? {}),
            statePersistenceError: publicError(stateError),
          };
        }
        throw error;
      }

      const fileId = String(uploadData?.file_id ?? "");
      if (!fileId) {
        const missingFileId = new NapCatNotifierError(
          "FILE_ID_MISSING",
          "NapCat 返回成功但没有 file_id，文件上传结果未知",
          { outcomeUnknown: true },
        );
        const unknownState = loadState(statePath);
        unknownState.entries[normalizedInput.dedupeKey] = {
          ...unknownState.entries[normalizedInput.dedupeKey],
          status: "pending_send",
          updatedAt: now().toISOString(),
          error: publicError(missingFileId),
        };
        const statePersistenceError = writeStateAfterSideEffect(unknownState);
        if (statePersistenceError) {
          missingFileId.details = { statePersistenceError };
        }
        throw missingFileId;
      }

      const sentState = loadState(statePath);
      sentState.entries[normalizedInput.dedupeKey] = {
        ...sentState.entries[normalizedInput.dedupeKey],
        status: "sent_unverified",
        fileId,
        updatedAt: now().toISOString(),
      };
      let statePersistenceError = writeStateAfterSideEffect(sentState);

      let verified = false;
      let verificationError = null;
      let verifiedFile = null;
      try {
        const rootFiles = await callOneBot("get_group_root_files", {
          group_id: binding.groupId,
          file_count: 100,
        });
        const candidates = Array.isArray(rootFiles?.files) ? rootFiles.files : [];
        verifiedFile = candidates.find((file) =>
          String(file?.file_name ?? "") === normalizedInput.fileName
          && Number(file?.file_size ?? file?.size ?? -1) === normalizedInput.fileBytes
          && (!file?.uploader || String(file.uploader) === binding.expectedSelfId)
        ) ?? null;
        if (!verifiedFile) {
          throw new NapCatNotifierError("FILE_VERIFY_MISSING", "群文件列表中未找到刚上传的同名同大小文件");
        }
        verified = true;
      } catch (error) {
        verificationError = publicError(error);
      }

      let fileMessage = null;
      let fileMessageLookupError = null;
      if (normalizedInput.hasTaskId) {
        try {
          const history = await callOneBot("get_group_msg_history", {
            group_id: binding.groupId,
            count: 50,
            reverse_order: true,
            disable_get_url: true,
            parse_mult_msg: false,
            quick_reply: false,
          });
          const candidates = (Array.isArray(history?.messages) ? history.messages : [])
            .map((message) => summarizeGroupMessage(message, binding.expectedSelfId));
          fileMessage = candidates.find((message) =>
            message.isSelf
            && message.attachments.some((attachment) =>
              attachment.fileId === fileId
              || (
                attachment.fileName === normalizedInput.fileName
                && attachment.fileBytes === normalizedInput.fileBytes
              )
            )
          ) ?? null;
        } catch (error) {
          fileMessageLookupError = publicError(error);
        }
      }
      const messageAttachment = fileMessage?.attachments.find((attachment) =>
        attachment.fileId === fileId
        || (
          attachment.fileName === normalizedInput.fileName
          && attachment.fileBytes === normalizedInput.fileBytes
        )
      ) ?? null;
      const fileBusId = Number.isSafeInteger(messageAttachment?.busId)
        ? messageAttachment.busId
        : (Number.isSafeInteger(Number(verifiedFile?.busid)) ? Number(verifiedFile.busid) : null);

      const finalState = loadState(statePath);
      finalState.entries[normalizedInput.dedupeKey] = {
        ...finalState.entries[normalizedInput.dedupeKey],
        status: verified ? "sent_verified" : "sent_unverified",
        verified,
        fileId,
        verificationError,
        verifiedFileId: String(verifiedFile?.file_id ?? ""),
        fileMessageId: String(fileMessage?.messageId ?? ""),
        fileMessageSeq: String(fileMessage?.messageSeq ?? ""),
        fileBusId,
        fileMessageLookupError,
        updatedAt: now().toISOString(),
      };
      statePersistenceError = writeStateAfterSideEffect(finalState);

      const taskIndex = normalizedInput.hasTaskId
        ? (verified
          ? await sendTaskFileIndex(binding, normalizedInput, {
            fileId,
            messageSeq: String(fileMessage?.messageSeq ?? ""),
            busId: fileBusId,
            fileName: normalizedInput.fileName,
            fileBytes: normalizedInput.fileBytes,
            sha256: fileSha256,
          })
          : {
            status: "blocked",
            sent: false,
            verified: false,
            duplicateSuppressed: false,
            reason: "file_unverified",
            messageId: "",
            dedupeKey: taskFileIndexDedupeKey(normalizedInput.dedupeKey),
            verificationError,
            error: null,
          })
        : null;

      return {
        sent: true,
        verified,
        fileId,
        verifiedFileId: String(verifiedFile?.file_id ?? ""),
        verificationError,
        fileMessageId: String(fileMessage?.messageId ?? ""),
        fileMessageSeq: String(fileMessage?.messageSeq ?? ""),
        fileBusId,
        fileMessageLookupError,
        fileName: normalizedInput.fileName,
        fileBytes: normalizedInput.fileBytes,
        sha256: fileSha256,
        target: targetCheck.group,
        identity: targetCheck.login,
        dedupeKey: normalizedInput.dedupeKey,
        deliveryId: normalizedInput.deliveryId,
        ...persistenceResult(statePersistenceError),
        ...(taskIndex ? { taskIndex } : {}),
      };
    } finally {
      if (releaseDedupeLock) releaseDedupeLock();
      inFlight.delete(normalizedInput.dedupeKey);
    }
  }

  async function sendFixedMessage(binding, normalizedInput, configuredTargetKey = "") {
    const currentTime = now();
    const preview = {
      bindingName: binding.bindingName,
      event: normalizedInput.event,
      taskId: normalizedInput.taskId,
      runId: normalizedInput.runId,
      dedupeKey: normalizedInput.dedupeKey,
      deliveryId: normalizedInput.deliveryId || "",
      message: normalizedInput.message,
    };
    const state = loadState(statePath);
    pruneState(state, binding.dedupeRetentionDays, currentTime);
    const existing = state.entries[normalizedInput.dedupeKey];
    if (existing && existing.status !== "failed_before_ack") {
      return {
        sent: false,
        duplicateSuppressed: true,
        reason: existing.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
        existing,
      };
    }
    if (inFlight.has(normalizedInput.dedupeKey)) {
      return { sent: false, duplicateSuppressed: true, reason: "in_flight" };
    }

    if (normalizedInput.event === "heartbeat") {
      const minimumInterval = binding.minimumHeartbeatMinutes * 60000;
      const recentHeartbeat = Object.values(state.entries).find((entry) =>
        entry.event === "heartbeat"
        && entry.taskId === normalizedInput.taskId
        && String(entry.status || "").startsWith("sent_")
        && currentTime.getTime() - Date.parse(entry.updatedAt || entry.createdAt || "") < minimumInterval
      );
      if (recentHeartbeat) {
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: "heartbeat_too_frequent",
          minimumHeartbeatMinutes: binding.minimumHeartbeatMinutes,
        };
      }
    }

    inFlight.add(normalizedInput.dedupeKey);
    let releaseDedupeLock = null;
    try {
      const targetCheck = configuredTargetKey
        ? await checkConfiguredTarget(binding, configuredTargetKey)
        : {
            ...(await checkTarget(binding)),
            target: null,
          };
      const resolvedTarget = configuredTargetKey
        ? targetCheck.target
        : {
            targetKey: "fixed-group",
            type: "group",
            id: binding.groupId,
            name: targetCheck.group.actualGroupName,
            memberCount: targetCheck.group.actualMemberCount,
          };
      const lockResult = acquireDedupeLock(statePath, normalizedInput.dedupeKey, currentTime);
      releaseDedupeLock = lockResult.release;
      if (!releaseDedupeLock && lockResult.existingLock?.stale) {
        throw new NapCatNotifierError(
          "STALE_SEND_LOCK",
          "发现超过 15 分钟的发送锁，拒绝自动删除；请先确认旧通知进程已退出，再按 README 人工处理。",
          { details: lockResult.existingLock },
        );
      }
      if (!releaseDedupeLock) {
        return { sent: false, duplicateSuppressed: true, reason: "cross_process_in_flight" };
      }

      const claimedState = loadState(statePath);
      pruneState(claimedState, binding.dedupeRetentionDays, currentTime);
      const claimedExisting = claimedState.entries[normalizedInput.dedupeKey];
      if (claimedExisting && claimedExisting.status !== "failed_before_ack") {
        return {
          sent: false,
          duplicateSuppressed: true,
          reason: claimedExisting.status === "pending_send" ? "previous_outcome_unknown" : "already_sent",
          existing: claimedExisting,
        };
      }
      const previousAttempts = Number(claimedExisting?.attempts ?? 0);
      claimedState.entries[normalizedInput.dedupeKey] = {
        status: "pending_send",
        event: normalizedInput.event,
        taskId: normalizedInput.taskId,
        runId: normalizedInput.runId,
        deliveryId: normalizedInput.deliveryId || "",
        createdAt: claimedExisting?.createdAt || currentTime.toISOString(),
        updatedAt: currentTime.toISOString(),
        attempts: previousAttempts + 1,
      };
      writeState(statePath, claimedState);

      let sendData;
      try {
        sendData = resolvedTarget.type === "private"
          ? await callOneBot("send_private_msg", {
              user_id: resolvedTarget.id,
              message: preview.message,
            })
          : await callOneBot("send_group_msg", {
              group_id: resolvedTarget.id,
              message: preview.message,
            });
      } catch (error) {
        const failedState = loadState(statePath);
        const entry = failedState.entries[normalizedInput.dedupeKey] || {};
        failedState.entries[normalizedInput.dedupeKey] = {
          ...entry,
          status: error.outcomeUnknown ? "pending_send" : "failed_before_ack",
          updatedAt: now().toISOString(),
          error: publicError(error),
        };
        try {
          writeState(statePath, failedState);
        } catch (stateError) {
          error.details = {
            ...(error.details ?? {}),
            statePersistenceError: publicError(stateError),
          };
        }
        throw error;
      }

      const messageId = String(sendData?.message_id ?? "");
      if (!messageId) {
        const missingMessageId = new NapCatNotifierError(
          "MESSAGE_ID_MISSING",
          "NapCat 返回成功但没有 message_id，发送结果未知",
          { outcomeUnknown: true },
        );
        const unknownState = loadState(statePath);
        unknownState.entries[normalizedInput.dedupeKey] = {
          ...unknownState.entries[normalizedInput.dedupeKey],
          status: "pending_send",
          updatedAt: now().toISOString(),
          error: publicError(missingMessageId),
        };
        const statePersistenceError = writeStateAfterSideEffect(unknownState);
        if (statePersistenceError) {
          missingMessageId.details = { statePersistenceError };
        }
        throw missingMessageId;
      }

      const sentState = loadState(statePath);
      sentState.entries[normalizedInput.dedupeKey] = {
        ...sentState.entries[normalizedInput.dedupeKey],
        status: "sent_unverified",
        messageId,
        updatedAt: now().toISOString(),
      };
      let statePersistenceError = writeStateAfterSideEffect(sentState);

      let verified = !binding.requireMessageVerification;
      let verificationError = null;
      if (binding.requireMessageVerification) {
        try {
          const message = await callOneBot("get_msg", { message_id: messageId });
          const verifiedMessageId = String(message?.message_id ?? "");
          const verifiedGroupId = String(message?.group_id ?? "");
          const verifiedText = normalizeComparableText(oneBotMessageText(message));
          const expectedText = normalizeComparableText(preview.message);
          const verifiedSenderId = String(message?.sender?.user_id ?? message?.user_id ?? "");
          if (verifiedMessageId !== messageId) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_ID_MISMATCH", "get_msg 返回的 message_id 不一致");
          }
          if (resolvedTarget.type === "group" && verifiedGroupId !== resolvedTarget.id) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_GROUP_MISMATCH", "get_msg 返回的群号不是已配置目标群");
          }
          if (resolvedTarget.type === "private" && verifiedGroupId) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_TYPE_MISMATCH", "get_msg 返回的消息不是私聊消息");
          }
          if (!verifiedText || verifiedText !== expectedText) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_TEXT_MISMATCH", "get_msg 返回的通知正文与发送内容不一致");
          }
          if (verifiedSenderId && verifiedSenderId !== binding.expectedSelfId) {
            throw new NapCatNotifierError("MESSAGE_VERIFY_SENDER_MISMATCH", "get_msg 返回的发送账号与 binding 不一致");
          }
          verified = true;
        } catch (error) {
          verificationError = publicError(error);
        }
      }

      const finalState = loadState(statePath);
      finalState.entries[normalizedInput.dedupeKey] = {
        ...finalState.entries[normalizedInput.dedupeKey],
        status: verified ? "sent_verified" : "sent_unverified",
        verified,
        messageId,
        verificationError,
        updatedAt: now().toISOString(),
      };
      statePersistenceError = writeStateAfterSideEffect(finalState);

      return {
        sent: true,
        verified,
        messageId,
        verificationError,
        target: configuredTargetKey ? resolvedTarget : targetCheck.group,
        identity: targetCheck.login,
        event: normalizedInput.event,
        taskId: normalizedInput.taskId,
        runId: normalizedInput.runId,
        dedupeKey: normalizedInput.dedupeKey,
        deliveryId: normalizedInput.deliveryId || "",
        ...persistenceResult(statePersistenceError),
      };
    } finally {
      if (releaseDedupeLock) releaseDedupeLock();
      inFlight.delete(normalizedInput.dedupeKey);
    }
  }

  async function sendTrainingEvent(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeEventInput(input, binding);
    return sendFixedMessage(binding, {
      ...normalizedInput,
      message: buildTrainingMessage(normalizedInput, now()),
    });
  }

  async function sendTextMessage(input) {
    const binding = loadBinding();
    const normalizedInput = normalizeTextInput(input);
    return sendFixedMessage(binding, {
      ...normalizedInput,
      message: buildTextMessage(normalizedInput, now()),
    });
  }

  async function sendControlGroupMessage(input) {
    const binding = loadBinding();
    requireControlPlane(binding);
    const dedupeKey = boundedString(input.dedupe_key, "dedupe_key", 200, true);
    return sendFixedMessage(binding, {
      event: boundedString(input.event || "control", "event", 64, true),
      taskId: boundedString(input.task_id || "control-plane", "task_id", 128, true),
      runId: "",
      dedupeKey,
      deliveryId: "",
      message: boundedString(input.message, "message", 4000, true),
    });
  }

  async function sendConfiguredMessage(input) {
    const binding = loadBinding();
    const controlPlane = requireControlPlane(binding);
    const targetKey = boundedString(
      input.target_key || controlPlane.defaultTargetKey,
      "target_key",
      64,
      true,
    );
    const dedupeKey = boundedString(input.dedupe_key, "dedupe_key", 200, true);
    return sendFixedMessage(binding, {
      event: boundedString(input.event || "owner_alert", "event", 64, true),
      taskId: boundedString(input.task_id || "control-plane", "task_id", 128, true),
      runId: "",
      dedupeKey,
      deliveryId: "",
      message: boundedString(input.message, "message", 4000, true),
    }, targetKey);
  }

  return {
    bindingPath,
    statePath,
    baseUrl,
    status,
    discoverTarget,
    getControlPlaneConfig,
    readRecentMessages,
    readConfiguredTargetMessages,
    previewTrainingEvent,
    previewTextMessage,
    previewFile,
    downloadFile,
    sendTrainingEvent,
    sendTextMessage,
    sendControlGroupMessage,
    sendConfiguredMessage,
    sendFile,
  };
}
