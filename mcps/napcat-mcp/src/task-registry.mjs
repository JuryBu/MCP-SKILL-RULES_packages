import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { renameReplaceSync } from "./atomic-file.mjs";
import { canonicalMachineRole } from "./machine-role.mjs";
import { createStaleSentWakeRearmPlan } from "./stale-sent-wake-rearm.mjs";

const STATE_SCHEMA_VERSION = 2;
const DEFAULT_WAKE_LEASE_MS = 30_000;
const DEFAULT_WAKE_COOLDOWN_MS = 600_000;
const MINIMUM_WAKE_COOLDOWN_MS = 30_000;
const MAXIMUM_WAKE_COOLDOWN_MS = 86_400_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 5;
const DEFAULT_STALE_LOCK_MS = 120_000;
const PUBLIC_FIELDS = [
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
  "activeWakeId",
  "wakePromptSha256",
  "lastWakeAt",
  "ledgerInitialized",
  "pendingMessages",
  "activeWakes",
  "createdAt",
  "updatedAt",
];
const ROUTING_FIELDS = [
  "conversationId",
  "localRole",
  "sourceMachine",
  "targetMachine",
  "trustedPeerQq",
];
const SLEEP_BUFFER = new SharedArrayBuffer(4);
const SLEEP_VIEW = new Int32Array(SLEEP_BUFFER);

export class TaskRegistryError extends Error {
  constructor(code, message, details = null, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "TaskRegistryError";
    this.code = code;
    this.details = details;
  }
}

function invalidArgument(message, details = null) {
  throw new TaskRegistryError("INVALID_ARGUMENT", message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(value, name, maximum = 512) {
  if (value === undefined || value === null) {
    invalidArgument(`${name} 不能为空`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    invalidArgument(`${name} 不能为空`);
  }
  if (normalized.length > maximum) {
    invalidArgument(`${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function optionalString(value, name, maximum = 512) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    invalidArgument(`${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function optionalDate(value, name) {
  if (value === undefined || value === null || value === "") return null;
  return toDate(value, name).toISOString();
}

function standardMachineRole(value, name) {
  const role = optionalString(value, name, 64);
  if (role === null) return null;
  const canonical = canonicalMachineRole(role);
  if (!canonical) invalidArgument(`${name} 只允许标准值 development 或 training；收到 ${role}`);
  if (canonical !== role) invalidArgument(`${name} 不接受兼容别名 ${role}；请改用标准值 ${canonical}`);
  return canonical;
}

function nonNegativeInteger(value, name) {
  const numberValue = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    invalidArgument(`${name} 必须是非负安全整数`);
  }
  return numberValue;
}

function positiveInteger(value, name) {
  const numberValue = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    invalidArgument(`${name} 必须是正安全整数`);
  }
  return numberValue;
}

function optionNumber(value, name, fallback, minimum) {
  if (value === undefined) return fallback;
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < minimum) {
    invalidArgument(`${name} 必须是不小于 ${minimum} 的安全整数`);
  }
  return numberValue;
}

function wakeCooldownNumber(value, fallback) {
  const numberValue = optionNumber(value, "wakeCooldownMs", fallback, MINIMUM_WAKE_COOLDOWN_MS);
  if (numberValue > MAXIMUM_WAKE_COOLDOWN_MS) {
    invalidArgument(`wakeCooldownMs 不能超过 ${MAXIMUM_WAKE_COOLDOWN_MS}`);
  }
  return numberValue;
}

function toDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    invalidArgument(`${name} 必须是有效时间`);
  }
  return date;
}

function storedDate(value, name, statePath) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TaskRegistryError("INVALID_STATE", `${name} 不是有效时间：${statePath}`, { statePath, field: name });
  }
}

function clonePublicTask(task) {
  const result = {};
  const pendingMessages = (task.messageLedger ?? [])
    .filter((message) => message.status === "pending")
    .map((message) => ({
      messageSeq: message.messageSeq,
      messageAt: message.messageAt,
      lastRemindedAt: message.lastRemindedAt,
      ...(message.replyRequired ? {
        replyRequired: true,
        expectedReply: message.expectedReply,
        replyDeadlineAt: message.replyDeadlineAt,
        nextCheckAt: message.nextCheckAt,
      } : {}),
    }));
  const activeWakes = (task.wakeBatches ?? [])
    .filter((wake) => wake.status !== "complete")
    .map((wake) => ({
      wakeId: wake.wakeId,
      messageSeqs: effectiveWakeMessageSeqs(wake).filter((sequence) =>
        pendingMessages.some((message) => message.messageSeq === sequence)
      ),
      leaseStartedAt: wake.leaseStartedAt,
      sentAt: wake.sentAt,
      status: wake.status,
      legacy: Boolean(wake.legacy),
    }))
    .filter((wake) => wake.messageSeqs.length > 0);
  for (const field of PUBLIC_FIELDS) {
    if (field === "pendingMessages") result[field] = pendingMessages;
    else if (field === "activeWakes") result[field] = activeWakes;
    else result[field] = task[field];
  }
  return result;
}

function messageRecord(sequence, at, status = "pending", lastRemindedAt = null, replyContract = {}) {
  return {
    messageSeq: sequence,
    messageAt: at,
    status,
    lastRemindedAt,
    replyRequired: replyContract.replyRequired === true,
    expectedReply: replyContract.expectedReply ?? null,
    replyDeadlineAt: replyContract.replyDeadlineAt ?? null,
    nextCheckAt: replyContract.nextCheckAt ?? null,
  };
}

function pendingSequenceSet(task) {
  return new Set((task.messageLedger ?? [])
    .filter((message) => message.status === "pending")
    .map((message) => message.messageSeq));
}

function effectiveWakeMessageSeqs(wake) {
  const superseded = new Set(wake.supersededMessageSeqs ?? []);
  return wake.messageSeqs.filter((sequence) => !superseded.has(sequence));
}

function refreshLegacyWakeFields(task) {
  const pendingSequences = pendingSequenceSet(task);
  for (const wake of task.wakeBatches ?? []) {
    const remaining = effectiveWakeMessageSeqs(wake).filter((sequence) => pendingSequences.has(sequence));
    if (!remaining.length) wake.status = "complete";
  }
  const latestWake = (task.wakeBatches ?? [])
    .filter((wake) => wake.status !== "complete")
    .filter((wake) => effectiveWakeMessageSeqs(wake).some((sequence) => pendingSequences.has(sequence)))
    .sort((left, right) => Date.parse(left.leaseStartedAt) - Date.parse(right.leaseStartedAt))
    .at(-1) ?? null;
  task.wakePending = latestWake !== null;
  task.wakeSentAt = latestWake?.leaseStartedAt ?? null;
  task.wakeMessageSeq = latestWake?.boundaryMessageSeq ?? null;
  task.wakeMessageAt = latestWake?.boundaryMessageAt ?? null;
  task.activeWakeId = latestWake?.wakeId ?? null;
  task.wakePromptSha256 = latestWake?.promptSha256 ?? null;
  return task;
}

function normalizeStoredTask(task, sourceSchemaVersion = STATE_SCHEMA_VERSION) {
  if (!isPlainObject(task)) return task;
  if (!hasOwn(task, "wakeCooldownMs")) task.wakeCooldownMs = DEFAULT_WAKE_COOLDOWN_MS;
  if (!hasOwn(task, "lastWakeAt")) task.lastWakeAt = task.wakeSentAt ?? null;
  if (!hasOwn(task, "lastSeenAt")) task.lastSeenAt = null;
  if (!hasOwn(task, "lastAckedAt")) task.lastAckedAt = null;
  if (!hasOwn(task, "wakeMessageSeq")) task.wakeMessageSeq = null;
  if (!hasOwn(task, "wakeMessageAt")) task.wakeMessageAt = null;
  if (!hasOwn(task, "activeWakeId")) task.activeWakeId = null;
  if (!hasOwn(task, "wakePromptSha256")) task.wakePromptSha256 = null;
  if (!hasOwn(task, "ledgerInitialized")) task.ledgerInitialized = sourceSchemaVersion >= 2;
  const legacyWakeSentAt = task.wakePending
    && task.wakeSentAt !== null
    && task.lastWakeAt === task.wakeSentAt
    ? task.wakeSentAt
    : null;
  if (!Array.isArray(task.messageLedger)) {
    task.messageLedger = [];
    if (task.lastAckedSeq > 0 && task.lastAckedAt !== null) {
      task.messageLedger.push(messageRecord(task.lastAckedSeq, task.lastAckedAt, "acked"));
    }
    if (task.wakeMessageSeq !== null && task.wakeMessageAt !== null) {
      const existing = task.messageLedger.find((message) => message.messageSeq === task.wakeMessageSeq);
      if (existing) {
        existing.status = "pending";
        existing.messageAt = task.wakeMessageAt;
        existing.lastRemindedAt = legacyWakeSentAt;
      } else {
        task.messageLedger.push(messageRecord(
          task.wakeMessageSeq,
          task.wakeMessageAt,
          "pending",
          legacyWakeSentAt,
        ));
      }
    }
  }
  for (const message of task.messageLedger) {
    if (!hasOwn(message, "replyRequired")) message.replyRequired = false;
    if (!hasOwn(message, "expectedReply")) message.expectedReply = null;
    if (!hasOwn(message, "replyDeadlineAt")) message.replyDeadlineAt = null;
    if (!hasOwn(message, "nextCheckAt")) message.nextCheckAt = null;
  }
  if (!Array.isArray(task.wakeBatches)) {
    task.wakeBatches = [];
    if (task.wakePending && task.wakeMessageSeq !== null && task.wakeMessageAt !== null) {
      task.wakeBatches.push({
        wakeId: task.activeWakeId ?? `legacy-${task.generation}-${task.wakeMessageSeq}`,
        messageSeqs: [task.wakeMessageSeq],
        messageTimes: [task.wakeMessageAt],
        boundaryMessageSeq: task.wakeMessageSeq,
        boundaryMessageAt: task.wakeMessageAt,
        leaseStartedAt: task.wakeSentAt,
        sentAt: legacyWakeSentAt,
        promptSha256: task.wakePromptSha256,
        status: legacyWakeSentAt === null ? "leased" : "sent",
        acknowledgedSeqs: [],
        supersededMessageSeqs: [],
        legacy: true,
      });
    }
  }
  for (const wake of task.wakeBatches) {
    if (!Array.isArray(wake.supersededMessageSeqs)) wake.supersededMessageSeqs = [];
  }
  return refreshLegacyWakeFields(task);
}

function emptyState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, tasks: {} };
}

function invalidState(statePath, message, cause = undefined) {
  throw new TaskRegistryError(
    "INVALID_STATE",
    `${message}：${statePath}`,
    { statePath },
    cause ? { cause } : undefined,
  );
}

function validateStoredTask(task, taskId, statePath) {
  if (!isPlainObject(task)) invalidState(statePath, `任务记录无效（${taskId}）`);
  if (task.taskId !== taskId) invalidState(statePath, `任务键与 taskId 不一致（${taskId}）`);
  for (const field of ["taskId", "conversationId"]) {
    if (typeof task[field] !== "string" || !task[field].trim()) {
      invalidState(statePath, `任务字段无效（${taskId}.${field}）`);
    }
  }
  for (const field of ["localRole", "sourceMachine", "targetMachine", "trustedPeerQq"]) {
    if (task[field] !== null && typeof task[field] !== "string") {
      invalidState(statePath, `任务字段无效（${taskId}.${field}）`);
    }
  }
  if (!Number.isSafeInteger(task.generation) || task.generation < 1) {
    invalidState(statePath, `任务代次无效（${taskId}）`);
  }
  if (task.status !== "open" && task.status !== "closed") {
    invalidState(statePath, `任务状态无效（${taskId}）`);
  }
  for (const field of ["lastSeenSeq", "lastAckedSeq"]) {
    if (!Number.isSafeInteger(task[field]) || task[field] < 0) {
      invalidState(statePath, `任务游标无效（${taskId}.${field}）`);
    }
  }
  if (task.lastSeenAt !== null) storedDate(task.lastSeenAt, `${taskId}.lastSeenAt`, statePath);
  if (task.lastAckedAt !== null) storedDate(task.lastAckedAt, `${taskId}.lastAckedAt`, statePath);
  if (task.wakeMessageSeq !== null && (!Number.isSafeInteger(task.wakeMessageSeq) || task.wakeMessageSeq < 0)) {
    invalidState(statePath, `唤醒消息标识无效（${taskId}.wakeMessageSeq）`);
  }
  if (task.wakeMessageAt !== null) storedDate(task.wakeMessageAt, `${taskId}.wakeMessageAt`, statePath);
  for (const field of ["activeWakeId", "wakePromptSha256"]) {
    if (task[field] !== null && (typeof task[field] !== "string" || !task[field].trim())) {
      invalidState(statePath, `唤醒字段无效（${taskId}.${field}）`);
    }
  }
  if (
    !Number.isSafeInteger(task.wakeCooldownMs)
    || task.wakeCooldownMs < MINIMUM_WAKE_COOLDOWN_MS
    || task.wakeCooldownMs > MAXIMUM_WAKE_COOLDOWN_MS
  ) {
    invalidState(statePath, `任务唤醒间隔无效（${taskId}.wakeCooldownMs）`);
  }
  if (typeof task.wakePending !== "boolean") {
    invalidState(statePath, `唤醒状态无效（${taskId}）`);
  }
  if (task.wakeSentAt !== null) storedDate(task.wakeSentAt, `${taskId}.wakeSentAt`, statePath);
  if (task.lastWakeAt !== null) storedDate(task.lastWakeAt, `${taskId}.lastWakeAt`, statePath);
  if (task.wakePending && task.wakeSentAt === null) {
    invalidState(statePath, `唤醒租约缺少时间（${taskId}）`);
  }
  if (typeof task.ledgerInitialized !== "boolean") {
    invalidState(statePath, `消息账本初始化状态无效（${taskId}）`);
  }
  if (!Array.isArray(task.messageLedger)) invalidState(statePath, `消息账本无效（${taskId}）`);
  const seenSequences = new Set();
  for (const message of task.messageLedger) {
    if (!isPlainObject(message)) invalidState(statePath, `消息账本记录无效（${taskId}）`);
    if (!Number.isSafeInteger(message.messageSeq) || message.messageSeq < 0) {
      invalidState(statePath, `消息标识无效（${taskId}）`);
    }
    if (seenSequences.has(message.messageSeq)) invalidState(statePath, `消息标识重复（${taskId}.${message.messageSeq}）`);
    seenSequences.add(message.messageSeq);
    storedDate(message.messageAt, `${taskId}.messageLedger.messageAt`, statePath);
    if (message.status !== "pending" && message.status !== "acked") {
      invalidState(statePath, `消息处理状态无效（${taskId}.${message.messageSeq}）`);
    }
    if (message.lastRemindedAt !== null) {
      storedDate(message.lastRemindedAt, `${taskId}.messageLedger.lastRemindedAt`, statePath);
    }
    if (typeof message.replyRequired !== "boolean") invalidState(statePath, `消息回复要求无效（${taskId}.${message.messageSeq}）`);
    if (message.replyRequired) {
      if (typeof message.expectedReply !== "string" || !message.expectedReply.trim()) {
        invalidState(statePath, `消息固定回复无效（${taskId}.${message.messageSeq}）`);
      }
    } else if (message.expectedReply !== null || message.replyDeadlineAt !== null || message.nextCheckAt !== null) {
      invalidState(statePath, `无回复任务携带回复合同（${taskId}.${message.messageSeq}）`);
    }
    if (message.replyDeadlineAt !== null) storedDate(message.replyDeadlineAt, `${taskId}.messageLedger.replyDeadlineAt`, statePath);
    if (message.nextCheckAt !== null) storedDate(message.nextCheckAt, `${taskId}.messageLedger.nextCheckAt`, statePath);
  }
  if (!Array.isArray(task.wakeBatches)) invalidState(statePath, `唤醒批次账本无效（${taskId}）`);
  const seenWakeIds = new Set();
  for (const wake of task.wakeBatches) {
    if (!isPlainObject(wake)) invalidState(statePath, `唤醒批次无效（${taskId}）`);
    if (typeof wake.wakeId !== "string" || !wake.wakeId.trim() || seenWakeIds.has(wake.wakeId)) {
      invalidState(statePath, `唤醒批次 ID 无效（${taskId}）`);
    }
    seenWakeIds.add(wake.wakeId);
    if (!Array.isArray(wake.messageSeqs) || !wake.messageSeqs.length) {
      invalidState(statePath, `唤醒批次消息无效（${taskId}.${wake.wakeId}）`);
    }
    if (wake.messageSeqs.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)) {
      invalidState(statePath, `唤醒批次消息标识无效（${taskId}.${wake.wakeId}）`);
    }
    if (!Array.isArray(wake.messageTimes) || wake.messageTimes.length !== wake.messageSeqs.length) {
      invalidState(statePath, `唤醒批次消息时间无效（${taskId}.${wake.wakeId}）`);
    }
    for (const messageTime of wake.messageTimes) storedDate(messageTime, `${taskId}.wakeBatches.messageTime`, statePath);
    if (wake.status !== "leased" && wake.status !== "sent" && wake.status !== "complete") {
      invalidState(statePath, `唤醒批次状态无效（${taskId}.${wake.wakeId}）`);
    }
    storedDate(wake.leaseStartedAt, `${taskId}.wakeBatches.leaseStartedAt`, statePath);
    if (wake.sentAt !== null) storedDate(wake.sentAt, `${taskId}.wakeBatches.sentAt`, statePath);
    if (!Array.isArray(wake.acknowledgedSeqs)) invalidState(statePath, `唤醒批次 ACK 列表无效（${taskId}.${wake.wakeId}）`);
    if (!Array.isArray(wake.supersededMessageSeqs)
      || wake.supersededMessageSeqs.some((sequence) => !wake.messageSeqs.includes(sequence))) {
      invalidState(statePath, `唤醒批次覆盖归档无效（${taskId}.${wake.wakeId}）`);
    }
  }
  storedDate(task.createdAt, `${taskId}.createdAt`, statePath);
  storedDate(task.updatedAt, `${taskId}.updatedAt`, statePath);
}

function validateState(value, statePath) {
  if (!isPlainObject(value) || ![1, STATE_SCHEMA_VERSION].includes(value.schemaVersion) || !isPlainObject(value.tasks)) {
    invalidState(statePath, "账本结构无效");
  }
  const sourceSchemaVersion = value.schemaVersion;
  for (const [taskId, task] of Object.entries(value.tasks)) {
    validateStoredTask(normalizeStoredTask(task, sourceSchemaVersion), taskId, statePath);
  }
  value.schemaVersion = STATE_SCHEMA_VERSION;
  return value;
}

function readState(statePath) {
  let text;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new TaskRegistryError("STATE_READ_FAILED", `无法读取账本：${statePath}`, { statePath }, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new TaskRegistryError("INVALID_STATE", `账本 JSON 损坏：${statePath}`, { statePath }, { cause: error });
  }
  return validateState(value, statePath);
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(SLEEP_VIEW, 0, 0, milliseconds);
}

function processIsAlive(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function recoverStaleLock(lockPath, staleLockMs) {
  let lockAgeMs = 0;
  let lockProcessId = 0;
  try {
    const stat = fs.statSync(lockPath);
    lockAgeMs = Math.max(0, Date.now() - stat.mtimeMs);
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8").replace(/^\uFEFF/, ""));
    lockProcessId = Number(raw?.pid ?? 0);
    const createdAtMs = Date.parse(String(raw?.createdAt ?? ""));
    if (Number.isFinite(createdAtMs)) lockAgeMs = Math.max(lockAgeMs, Date.now() - createdAtMs);
  } catch {
  }
  if (lockAgeMs < staleLockMs || processIsAlive(lockProcessId)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function acquireFileLock(lockPath, timeoutMs, retryMs, staleLockMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new TaskRegistryError("LOCK_FAILED", `无法创建账本锁：${lockPath}`, { lockPath }, { cause: error });
      }
      if (recoverStaleLock(lockPath, staleLockMs)) continue;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new TaskRegistryError("LOCK_TIMEOUT", `等待账本锁超时：${lockPath}`, { lockPath, timeoutMs });
      }
      sleepSync(Math.min(retryMs, timeoutMs - elapsed));
      continue;
    }
    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      fs.closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
      throw new TaskRegistryError("LOCK_FAILED", `无法写入账本锁：${lockPath}`, { lockPath }, { cause: error });
    }
    return () => {
      try {
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new TaskRegistryError("LOCK_RELEASE_FAILED", `无法释放账本锁：${lockPath}`, { lockPath }, { cause: error });
        }
      }
    };
  }
}

function atomicWriteBytes(statePath, bytes) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    renameReplaceSync(temporaryPath, statePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
    }
    throw new TaskRegistryError("STATE_WRITE_FAILED", `无法原子写入账本：${statePath}`, { statePath }, { cause: error });
  }
}

function atomicWriteState(statePath, state) {
  atomicWriteBytes(statePath, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
}

function parseTaskId(input) {
  if (!isPlainObject(input)) invalidArgument("输入必须是对象");
  return requiredString(input.taskId, "taskId");
}

function parseSequence(input, name, aliases) {
  for (const alias of aliases) {
    if (hasOwn(input, alias)) return nonNegativeInteger(input[alias], name);
  }
  invalidArgument(`${name} 不能为空`);
}

function parseSequenceList(value, name) {
  if (!Array.isArray(value) || !value.length) invalidArgument(`${name} 必须是非空数组`);
  const sequences = value.map((item) => nonNegativeInteger(item, name));
  if (new Set(sequences).size !== sequences.length) invalidArgument(`${name} 不能包含重复消息标识`);
  return sequences;
}

function parseObservedMessages(input) {
  const source = input.messages ?? input.pendingMessages;
  if (!Array.isArray(source) || !source.length) invalidArgument("messages 必须是非空数组");
  return source.map((message) => {
    if (!isPlainObject(message)) invalidArgument("messages 中的每项必须是对象");
    if (message.replyRequired !== undefined && typeof message.replyRequired !== "boolean") {
      invalidArgument("replyRequired 必须是布尔值");
    }
    const replyRequired = message.replyRequired === true;
    const expectedReply = optionalString(message.expectedReply, "expectedReply", 240);
    const replyDeadlineAt = optionalDate(message.replyDeadlineAt, "replyDeadlineAt");
    const nextCheckAt = optionalDate(message.nextCheckAt, "nextCheckAt");
    if (replyRequired && expectedReply === null) invalidArgument("replyRequired=true 时 expectedReply 不能为空");
    if (!replyRequired && (expectedReply !== null || replyDeadlineAt !== null || nextCheckAt !== null)) {
      invalidArgument("无回复任务不能携带 expectedReply、replyDeadlineAt 或 nextCheckAt");
    }
    return {
      messageSeq: parseSequence(message, "messageSeq", ["messageSeq", "message_seq", "seq"]),
      messageAt: toDate(message.messageAt ?? message.message_time ?? message.at, "messageAt").toISOString(),
      replyRequired,
      expectedReply,
      replyDeadlineAt,
      nextCheckAt,
    };
  }).sort((left, right) => Date.parse(left.messageAt) - Date.parse(right.messageAt));
}

function findMessage(task, sequence) {
  return task.messageLedger.find((message) => message.messageSeq === sequence) ?? null;
}

function parseExpectedGeneration(input) {
  if (!hasOwn(input, "expectedGeneration")) invalidArgument("expectedGeneration 不能为空");
  return positiveInteger(input.expectedGeneration, "expectedGeneration");
}

function requireGenerationMatch(task, input) {
  const expectedGeneration = parseExpectedGeneration(input);
  if (task.generation !== expectedGeneration) {
    throw new TaskRegistryError(
      "GENERATION_MISMATCH",
      `任务代次已变化：${task.taskId}`,
      { taskId: task.taskId, expectedGeneration, actualGeneration: task.generation },
    );
  }
  return expectedGeneration;
}

function requireCloseConfirmations(input) {
  const missingConfirmations = [
    "confirmPendingEmpty",
    "confirmPeerReady",
  ].filter((field) => input[field] !== true);
  if (missingConfirmations.length) {
    throw new TaskRegistryError(
      "CLOSE_CONFIRMATION_REQUIRED",
      "关闭任务前必须明确确认账本为空且可信对端已就绪",
      { missingConfirmations },
    );
  }
}

function closeBlockers(task) {
  const pendingMessages = (task.messageLedger ?? [])
    .filter((message) => message.status === "pending")
    .map((message) => ({
      messageSeq: message.messageSeq,
      messageAt: message.messageAt,
      lastRemindedAt: message.lastRemindedAt,
    }));
  const activeWakes = (task.wakeBatches ?? [])
    .filter((wake) => wake.status !== "complete")
    .map((wake) => ({
      wakeId: wake.wakeId,
      messageSeqs: [...wake.messageSeqs],
      leaseStartedAt: wake.leaseStartedAt,
      sentAt: wake.sentAt,
      status: wake.status,
    }));
  return {
    pendingMessages,
    activeWakes,
    activeWakeId: task.activeWakeId,
    wakePending: task.wakePending,
  };
}

function requireEmptyCloseLedger(task) {
  const blockers = closeBlockers(task);
  if (
    blockers.pendingMessages.length
    || blockers.activeWakes.length
    || blockers.activeWakeId !== null
    || blockers.wakePending
  ) {
    throw new TaskRegistryError(
      "TASK_CLOSE_BLOCKED",
      `任务仍有待处理消息或唤醒，不能关闭：${task.taskId}`,
      { taskId: task.taskId, ...blockers },
    );
  }
}

function requireEmptyRouteUpdateLedger(task) {
  const blockers = closeBlockers(task);
  if (
    blockers.pendingMessages.length
    || blockers.activeWakes.length
    || blockers.activeWakeId !== null
    || blockers.wakePending
  ) {
    throw new TaskRegistryError(
      "TASK_ROUTE_UPDATE_BLOCKED",
      `任务仍有待处理消息或唤醒，不能变更路由：${task.taskId}`,
      { taskId: task.taskId, ...blockers },
    );
  }
}

function requireCloseDisposition(state, task, input) {
  if (hasOwn(input, "finalClose") && typeof input.finalClose !== "boolean") {
    invalidArgument("finalClose 必须是布尔值");
  }
  const successorTaskId = hasOwn(input, "successorTaskId")
    ? requiredString(input.successorTaskId, "successorTaskId")
    : null;
  if (input.finalClose === true && successorTaskId !== null) {
    throw new TaskRegistryError(
      "CLOSE_DISPOSITION_CONFLICT",
      "finalClose 与 successorTaskId 不能同时指定",
      { taskId: task.taskId, finalClose: true, successorTaskId },
    );
  }
  if (input.finalClose !== true && successorTaskId === null) {
    throw new TaskRegistryError(
      "CLOSE_DISPOSITION_REQUIRED",
      "关闭任务必须指定 finalClose=true 或 successorTaskId",
      { taskId: task.taskId },
    );
  }
  if (successorTaskId === null) return;
  if (successorTaskId === task.taskId) {
    throw new TaskRegistryError(
      "SUCCESSOR_TASK_SAME_AS_CURRENT",
      "successorTaskId 必须不同于当前任务",
      { taskId: task.taskId, successorTaskId },
    );
  }
  const successor = state.tasks[successorTaskId];
  if (!successor) {
    throw new TaskRegistryError(
      "SUCCESSOR_TASK_NOT_FOUND",
      `未找到 successorTaskId：${successorTaskId}`,
      { taskId: task.taskId, successorTaskId },
    );
  }
  if (successor.status !== "open") {
    throw new TaskRegistryError(
      "SUCCESSOR_TASK_NOT_OPEN",
      `successorTaskId 未处于 open 状态：${successorTaskId}`,
      { taskId: task.taskId, successorTaskId, successorStatus: successor.status },
    );
  }
  const incompatibleFields = ["localRole", "sourceMachine", "targetMachine", "trustedPeerQq"]
    .filter((field) => successor[field] !== task[field]);
  if (incompatibleFields.length) {
    throw new TaskRegistryError(
      "SUCCESSOR_ROUTE_INCOMPATIBLE",
      "successorTaskId 的路由方向或可信对端与当前任务不兼容",
      {
        taskId: task.taskId,
        successorTaskId,
        incompatibleFields,
        current: Object.fromEntries(incompatibleFields.map((field) => [field, task[field]])),
        successor: Object.fromEntries(incompatibleFields.map((field) => [field, successor[field]])),
      },
    );
  }
}

function resolveNow(provider, input) {
  const value = hasOwn(input, "now") ? input.now : provider();
  return toDate(value, "now");
}

function wakeLeaseResult(task, acquired, reason, leaseExpiresAt, cooldownExpiresAt = null) {
  return {
    ...clonePublicTask(task),
    acquired,
    reason,
    leaseExpiresAt,
    cooldownExpiresAt,
  };
}

class TaskRegistry {
  constructor(options = {}) {
    if (!isPlainObject(options)) invalidArgument("options 必须是对象");
    const defaultStatePath = path.join(process.cwd(), "state", "task-registry.json");
    this.statePath = path.resolve(String(options.statePath ?? defaultStatePath));
    this.lockPath = path.resolve(String(options.lockPath ?? `${this.statePath}.lock`));
    this.lockTimeoutMs = optionNumber(
      options.lockTimeoutMs,
      "lockTimeoutMs",
      DEFAULT_LOCK_TIMEOUT_MS,
      0,
    );
    this.lockRetryMs = optionNumber(options.lockRetryMs, "lockRetryMs", DEFAULT_LOCK_RETRY_MS, 1);
    this.staleLockMs = optionNumber(options.staleLockMs, "staleLockMs", DEFAULT_STALE_LOCK_MS, 1000);
    this.wakeLeaseMs = optionNumber(options.wakeLeaseMs, "wakeLeaseMs", DEFAULT_WAKE_LEASE_MS, 1);
    this.wakeCooldownMs = wakeCooldownNumber(options.wakeCooldownMs, DEFAULT_WAKE_COOLDOWN_MS);
    if (options.now !== undefined && typeof options.now !== "function") {
      const fixedNow = options.now;
      this.now = () => fixedNow;
    } else {
      this.now = options.now ?? (() => new Date());
    }
  }

  register(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = requiredString(input.taskId, "taskId");
    const conversationId = requiredString(input.conversationId, "conversationId");
    const requestedRoute = {
      conversationId,
      localRole: standardMachineRole(input.localRole, "localRole"),
      sourceMachine: standardMachineRole(input.sourceMachine, "sourceMachine"),
      targetMachine: standardMachineRole(input.targetMachine, "targetMachine"),
      trustedPeerQq: optionalString(input.trustedPeerQq, "trustedPeerQq"),
    };
    return this.#write((state) => {
      const existing = state.tasks[taskId];
      if (existing) {
        const conflictingFields = ROUTING_FIELDS.filter((field) => existing[field] !== requestedRoute[field]);
        if (conflictingFields.length) {
          throw new TaskRegistryError(
            "TASK_ROUTE_CONFLICT",
            `taskId 已登记不同的任务路由：${taskId}`,
            {
              taskId,
              conflictingFields,
              existing: Object.fromEntries(ROUTING_FIELDS.map((field) => [field, existing[field]])),
              requested: requestedRoute,
            },
          );
        }
        return { changed: false, value: clonePublicTask(existing) };
      }
      const now = resolveNow(this.now, input).toISOString();
      const task = {
        taskId,
        ...requestedRoute,
        generation: 1,
        status: "open",
        lastSeenSeq: 0,
        lastAckedSeq: 0,
        lastSeenAt: null,
        lastAckedAt: null,
        wakeCooldownMs: wakeCooldownNumber(input.wakeCooldownMs, this.wakeCooldownMs),
        wakePending: false,
        wakeSentAt: null,
        wakeMessageSeq: null,
        wakeMessageAt: null,
        activeWakeId: null,
        wakePromptSha256: null,
        lastWakeAt: null,
        ledgerInitialized: true,
        messageLedger: [],
        wakeBatches: [],
        createdAt: now,
        updatedAt: now,
      };
      state.tasks[taskId] = task;
      return { changed: true, value: clonePublicTask(task) };
    });
  }

  update(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const expectedGeneration = parseExpectedGeneration(input);
    const hasRoutingUpdate = ROUTING_FIELDS.some((field) => hasOwn(input, field));
    const hasCooldownUpdate = hasOwn(input, "wakeCooldownMs");
    if (!hasRoutingUpdate && !hasCooldownUpdate) {
      invalidArgument("update 至少需要一个路由字段或 wakeCooldownMs");
    }
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, { expectedGeneration });
      if (task.status === "closed") {
        throw new TaskRegistryError("TASK_CLOSED", `任务已经关闭：${taskId}`, { taskId });
      }
      const nextConversationId = hasOwn(input, "conversationId")
        ? requiredString(input.conversationId, "conversationId")
        : task.conversationId;
      const nextTask = { ...task, conversationId: nextConversationId };
      for (const field of ROUTING_FIELDS.slice(1)) {
        if (!hasOwn(input, field)) continue;
        nextTask[field] = ["localRole", "sourceMachine", "targetMachine"].includes(field)
          ? standardMachineRole(input[field], field)
          : optionalString(input[field], field);
      }
      if (hasCooldownUpdate) {
        nextTask.wakeCooldownMs = wakeCooldownNumber(input.wakeCooldownMs, task.wakeCooldownMs);
      }
      const routingChanged = ROUTING_FIELDS.some((field) => nextTask[field] !== task[field]);
      if (routingChanged) {
        requireEmptyRouteUpdateLedger(task);
        if (nextTask.generation >= Number.MAX_SAFE_INTEGER) {
          throw new TaskRegistryError("GENERATION_OVERFLOW", `任务代次已达到上限：${taskId}`, { taskId });
        }
        nextTask.generation += 1;
      }
      const changed = routingChanged || nextTask.wakeCooldownMs !== task.wakeCooldownMs;
      if (!changed) return { changed: false, value: clonePublicTask(task) };
      nextTask.updatedAt = resolveNow(this.now, input).toISOString();
      if (routingChanged) {
        nextTask.ledgerInitialized = true;
        nextTask.messageLedger = [];
        nextTask.wakeBatches = [];
        nextTask.wakePending = false;
        nextTask.wakeSentAt = null;
        nextTask.wakeMessageSeq = null;
        nextTask.wakeMessageAt = null;
        nextTask.activeWakeId = null;
        nextTask.wakePromptSha256 = null;
        nextTask.lastWakeAt = null;
      }
      state.tasks[taskId] = nextTask;
      return { changed: true, value: clonePublicTask(nextTask) };
    });
  }

  close(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (task.status === "closed") return { changed: false, value: clonePublicTask(task) };
      requireCloseConfirmations(input);
      requireEmptyCloseLedger(task);
      requireCloseDisposition(state, task, input);
      const nextTask = {
        ...task,
        status: "closed",
        updatedAt: resolveNow(this.now, input).toISOString(),
      };
      state.tasks[taskId] = nextTask;
      return { changed: true, value: clonePublicTask(nextTask) };
    });
  }

  get(taskId) {
    const normalizedTaskId = requiredString(taskId, "taskId");
    const state = readState(this.statePath);
    const task = state.tasks[normalizedTaskId];
    return task ? clonePublicTask(task) : null;
  }

  list(filter = {}) {
    if (!isPlainObject(filter)) invalidArgument("filter 必须是对象");
    const state = readState(this.statePath);
    const requestedStatus = filter.status === undefined ? null : requiredString(filter.status, "status", 32);
    if (requestedStatus !== null && requestedStatus !== "open" && requestedStatus !== "closed") {
      invalidArgument("status 只能是 open 或 closed");
    }
    const requestedTaskId = filter.taskId === undefined ? null : requiredString(filter.taskId, "taskId");
    return Object.values(state.tasks)
      .filter((task) => requestedStatus === null || task.status === requestedStatus)
      .filter((task) => requestedTaskId === null || task.taskId === requestedTaskId)
      .sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)
      .map(clonePublicTask);
  }

  observeMessages(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const observedMessages = parseObservedMessages(input);
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (task.status === "closed") {
        throw new TaskRegistryError("TASK_CLOSED", `任务已经关闭：${taskId}`, { taskId });
      }
      let changed = false;
      for (const observed of observedMessages) {
        const existing = findMessage(task, observed.messageSeq);
        if (existing) {
          const legacyReplyContract = existing.replyRequired !== true
            && existing.expectedReply == null
            && existing.replyDeadlineAt == null
            && existing.nextCheckAt == null;
          if (existing.messageAt === observed.messageAt && legacyReplyContract && observed.replyRequired) {
            existing.replyRequired = true;
            existing.expectedReply = observed.expectedReply;
            existing.replyDeadlineAt = observed.replyDeadlineAt;
            existing.nextCheckAt = observed.nextCheckAt;
            changed = true;
            continue;
          }
          if (
            existing.messageAt !== observed.messageAt
            || existing.replyRequired !== observed.replyRequired
            || existing.expectedReply !== observed.expectedReply
            || existing.replyDeadlineAt !== observed.replyDeadlineAt
            || existing.nextCheckAt !== observed.nextCheckAt
          ) {
            throw new TaskRegistryError(
              "MESSAGE_SEQ_CONFLICT",
              `同一消息标识出现不同时间或回复合同：${observed.messageSeq}`,
              { taskId, messageSeq: observed.messageSeq, existingAt: existing.messageAt, observedAt: observed.messageAt },
            );
          }
          continue;
        }
        task.messageLedger.push(messageRecord(observed.messageSeq, observed.messageAt, "pending", null, observed));
        changed = true;
      }
      const latestObserved = observedMessages.at(-1);
      if (task.lastSeenAt === null || Date.parse(latestObserved.messageAt) >= Date.parse(task.lastSeenAt)) {
        if (task.lastSeenSeq !== latestObserved.messageSeq || task.lastSeenAt !== latestObserved.messageAt) changed = true;
        task.lastSeenSeq = latestObserved.messageSeq;
        task.lastSeenAt = latestObserved.messageAt;
      }
      if (!task.ledgerInitialized) {
        task.ledgerInitialized = true;
        changed = true;
      }
      if (!changed) return { changed: false, value: clonePublicTask(task) };
      task.updatedAt = resolveNow(this.now, input).toISOString();
      refreshLegacyWakeFields(task);
      return { changed: true, value: clonePublicTask(task) };
    });
  }

  markSeen(input) {
    const sequence = parseSequence(input, "seq", ["seq", "lastSeenSeq", "sequence"]);
    const observedAt = toDate(input.at ?? input.messageTime ?? resolveNow(this.now, input), "at").toISOString();
    return this.observeMessages({
      ...input,
      messages: [{ messageSeq: sequence, messageAt: observedAt }],
    });
  }

  ack(input) {
    return this.acknowledgeWake(input);
  }

  acknowledgeWake(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const explicitSequences = input.processedMessageSeqs ?? input.processed_message_seqs;
    const processedSequences = explicitSequences !== undefined
      ? parseSequenceList(explicitSequences, "processedMessageSeqs")
      : [parseSequence(input, "seq", ["seq", "lastAckedSeq", "sequence"] )];
    const requestedWakeId = optionalString(input.wakeId ?? input.wake_id, "wakeId");
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (task.status === "closed") {
        throw new TaskRegistryError("TASK_CLOSED", `任务已经关闭：${taskId}`, { taskId });
      }
      let wake = requestedWakeId === null
        ? null
        : task.wakeBatches.find((candidate) => candidate.wakeId === requestedWakeId && candidate.status !== "complete") ?? null;
      if (wake === null && requestedWakeId === null) {
        const candidates = task.wakeBatches.filter((candidate) =>
          candidate.status !== "complete"
          && candidate.legacy
          && processedSequences.every((sequence) => effectiveWakeMessageSeqs(candidate).includes(sequence))
        );
        if (candidates.length === 1) wake = candidates[0];
      }
      if (wake === null) {
        if (processedSequences.every((sequence) => findMessage(task, sequence)?.status === "acked")) {
          return { changed: false, value: clonePublicTask(task) };
        }
        throw new TaskRegistryError(
          "ACK_NOT_ACTIVE_WAKE",
          `ACK 必须引用包含这些消息的有效 wake_id：${taskId}`,
          { taskId, requestedWakeId, processedSequences },
        );
      }
      const wakeMessageSeqs = effectiveWakeMessageSeqs(wake);
      const invalidSequences = processedSequences.filter((sequence) => !wakeMessageSeqs.includes(sequence));
      if (invalidSequences.length) {
        throw new TaskRegistryError(
          "ACK_MESSAGE_MISMATCH",
          `ACK 包含不属于该唤醒批次的消息：${taskId}`,
          { taskId, wakeId: wake.wakeId, invalidSequences, wakeMessageSeqs },
        );
      }
      let changed = false;
      for (const sequence of processedSequences) {
        const message = findMessage(task, sequence);
        if (!message) {
          throw new TaskRegistryError("ACK_MESSAGE_UNKNOWN", `ACK 消息不在任务账本中：${sequence}`, { taskId, sequence });
        }
        if (message.status !== "acked") {
          message.status = "acked";
          changed = true;
        }
      }
      for (const candidate of task.wakeBatches) {
        const acknowledged = new Set(candidate.acknowledgedSeqs);
        const candidateMessageSeqs = effectiveWakeMessageSeqs(candidate);
        for (const sequence of processedSequences) {
          if (candidateMessageSeqs.includes(sequence)) acknowledged.add(sequence);
        }
        candidate.acknowledgedSeqs = [...acknowledged];
        if (candidateMessageSeqs.every((sequence) => findMessage(task, sequence)?.status === "acked")) {
          candidate.status = "complete";
        }
      }
      const latestAcknowledged = task.messageLedger
        .filter((message) => message.status === "acked")
        .sort((left, right) => Date.parse(left.messageAt) - Date.parse(right.messageAt))
        .at(-1) ?? null;
      if (latestAcknowledged) {
        task.lastAckedSeq = latestAcknowledged.messageSeq;
        task.lastAckedAt = latestAcknowledged.messageAt;
      }
      refreshLegacyWakeFields(task);
      if (!changed) return { changed: false, value: clonePublicTask(task) };
      task.updatedAt = resolveNow(this.now, input).toISOString();
      return { changed: true, value: clonePublicTask(task) };
    });
  }

  rearmStaleSentWakes(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const newWakeId = requiredString(input.newWakeId, "newWakeId");
    const promptSha256 = requiredString(input.promptSha256, "promptSha256");
    return this.#write((state, context) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const now = resolveNow(this.now, input).toISOString();
      const plan = createStaleSentWakeRearmPlan({
        state,
        taskId,
        expectedGeneration: input.expectedGeneration,
        expectedConversationId: requiredString(input.expectedConversationId, "expectedConversationId"),
        expectedPendingSeqs: parseSequenceList(input.expectedPendingSeqs, "expectedPendingSeqs"),
        expectedActiveWakeIds: input.expectedActiveWakeIds.map((wakeId) => requiredString(wakeId, "expectedActiveWakeIds")),
        expectedLatestWakeId: requiredString(input.expectedLatestWakeId, "expectedLatestWakeId"),
        preparedAt: input.preparedAt ?? now,
      });
      plan.rollback.originalStateBytes = Buffer.from(context.originalStateBytes);
      plan.rollback.originalStateSha256 = createHash("sha256").update(context.originalStateBytes).digest("hex");
      if (task.wakeBatches.some((wake) => wake.wakeId === newWakeId)) {
        throw new TaskRegistryError("WAKE_ID_CONFLICT", `新的 wake_id 已存在：${newWakeId}`, { taskId, newWakeId });
      }
      plan.apply(state, now);
      const nextTask = state.tasks[taskId];
      const boundary = plan.before.pending.at(-1);
      nextTask.wakeBatches.push({
        wakeId: newWakeId,
        messageSeqs: plan.expectedPendingSeqs,
        messageTimes: plan.before.pending.map((message) => message.messageAt),
        boundaryMessageSeq: boundary.messageSeq,
        boundaryMessageAt: boundary.messageAt,
        leaseStartedAt: now,
        sentAt: null,
        promptSha256,
        status: "leased",
        acknowledgedSeqs: [],
        supersededMessageSeqs: [],
        legacy: false,
      });
      refreshLegacyWakeFields(nextTask);
      return {
        changed: true,
        value: {
          task: clonePublicTask(nextTask),
          archivedWakes: plan.archivedWakes,
          rollback: plan.rollback,
          wakeId: newWakeId,
          wakeSentAt: now,
        },
      };
    });
  }

  rollbackStaleSentWakeRearm(input) {
    if (!isPlainObject(input) || !isPlainObject(input.rollback)) invalidArgument("rollback 必须是对象");
    const taskId = parseTaskId(input);
    const newWakeId = requiredString(input.newWakeId, "newWakeId");
    const expectedPendingSeqs = parseSequenceList(input.expectedPendingSeqs, "expectedPendingSeqs");
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const currentPending = task.messageLedger.filter((message) => message.status === "pending").map((message) => message.messageSeq);
      if (currentPending.length !== expectedPendingSeqs.length || currentPending.some((sequence, index) => sequence !== expectedPendingSeqs[index])) {
        throw new TaskRegistryError("REARM_ROLLBACK_BLOCKED", "pending 消息已变化，不能回滚重唤醒", { currentPending, expectedPendingSeqs });
      }
      const currentActive = task.wakeBatches.filter((wake) => wake.status !== "complete");
      if (currentActive.length !== 1 || currentActive[0].wakeId !== newWakeId || currentActive[0].status !== "leased") {
        throw new TaskRegistryError("REARM_ROLLBACK_BLOCKED", "新 wake 已不再是唯一未发送租约，不能回滚", {
          activeWakes: currentActive.map((wake) => ({ wakeId: wake.wakeId, status: wake.status })),
        });
      }
      const reminderMap = new Map(input.rollback.reminders.map((item) => [item.messageSeq, item.lastRemindedAt]));
      task.wakeBatches = input.rollback.wakeBatches;
      for (const message of task.messageLedger) {
        if (reminderMap.has(message.messageSeq)) message.lastRemindedAt = reminderMap.get(message.messageSeq);
      }
      for (const field of ["wakePending", "wakeSentAt", "wakeMessageSeq", "wakeMessageAt", "activeWakeId", "wakePromptSha256", "lastWakeAt", "updatedAt"]) {
        task[field] = input.rollback[field];
      }
      const originalStateBytes = input.rollback.originalStateBytes;
      const originalStateSha256 = input.rollback.originalStateSha256;
      if (!Buffer.isBuffer(originalStateBytes)
        || createHash("sha256").update(originalStateBytes).digest("hex") !== originalStateSha256) {
        throw new TaskRegistryError("REARM_ROLLBACK_BLOCKED", "原始账本备份身份无效，不能回滚重唤醒");
      }
      const originalState = validateState(JSON.parse(originalStateBytes.toString("utf8").replace(/^\uFEFF/, "")), this.statePath);
      const originalTask = originalState.tasks[taskId];
      const originalPending = originalTask?.messageLedger
        ?.filter((message) => message.status === "pending")
        .map((message) => message.messageSeq) ?? [];
      if (!originalTask
        || originalTask.generation !== input.expectedGeneration
        || originalPending.length !== expectedPendingSeqs.length
        || originalPending.some((sequence, index) => sequence !== expectedPendingSeqs[index])) {
        throw new TaskRegistryError("REARM_ROLLBACK_BLOCKED", "原始账本备份与回滚身份不一致，不能恢复");
      }
      return { changed: true, rawStateBytes: originalStateBytes, value: clonePublicTask(originalTask) };
    });
  }

  acquireWakeLease(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const requestedMessages = Array.isArray(input.messages)
      ? parseObservedMessages({ messages: input.messages })
      : [{
          messageSeq: parseSequence(input, "seq", ["seq", "messageSeq", "pendingThroughSequence"]),
          messageAt: toDate(input.at ?? input.messageTime, "at").toISOString(),
        }];
    const requestedWakeId = requiredString(input.wakeId, "wakeId");
    const requestedPromptSha256 = requiredString(input.promptSha256, "promptSha256");
    const leaseMs = optionNumber(input.leaseMs ?? input.wakeLeaseMs, "leaseMs", this.wakeLeaseMs, 1);
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const now = resolveNow(this.now, input);
      if (task.status === "closed") {
        return { changed: false, value: wakeLeaseResult(task, false, "closed", null) };
      }
      const expiredLeaseIds = new Set(task.wakeBatches
        .filter((candidate) => candidate.status === "leased")
        .filter((candidate) => now.getTime() >= Date.parse(candidate.leaseStartedAt) + leaseMs)
        .map((candidate) => candidate.wakeId));
      if (expiredLeaseIds.size) {
        task.wakeBatches = task.wakeBatches.filter((candidate) => !expiredLeaseIds.has(candidate.wakeId));
      }
      const competingLease = task.wakeBatches.find((candidate) =>
        candidate.status === "leased"
        && candidate.wakeId !== requestedWakeId
        && now.getTime() < Date.parse(candidate.leaseStartedAt) + leaseMs
      );
      if (competingLease) {
        if (expiredLeaseIds.size) {
          task.updatedAt = now.toISOString();
          refreshLegacyWakeFields(task);
        }
        return {
          changed: expiredLeaseIds.size > 0,
          value: wakeLeaseResult(
            task,
            false,
            "lease_active",
            new Date(Date.parse(competingLease.leaseStartedAt) + leaseMs).toISOString(),
          ),
        };
      }
      const resolved = requestedMessages.filter((message) => findMessage(task, message.messageSeq)?.status !== "pending");
      if (resolved.length) {
        return { changed: false, value: wakeLeaseResult(task, false, "messages_resolved", null) };
      }
      let batch = task.wakeBatches.find((candidate) => candidate.wakeId === requestedWakeId) ?? null;
      if (batch) {
        const sameMessages = batch.messageSeqs.length === requestedMessages.length
          && batch.messageSeqs.every((sequence, index) => sequence === requestedMessages[index].messageSeq);
        if (!sameMessages || batch.promptSha256 !== requestedPromptSha256) {
          return { changed: false, value: wakeLeaseResult(task, false, "wake_boundary_conflict", null) };
        }
        if (batch.status === "sent") {
          return { changed: false, value: wakeLeaseResult(task, false, "already_sent", null) };
        }
        if (batch.status === "complete") {
          return { changed: false, value: wakeLeaseResult(task, false, "messages_resolved", null) };
        }
        const leaseStartedAtMs = Date.parse(batch.leaseStartedAt);
        if (now.getTime() < leaseStartedAtMs + leaseMs) {
          return {
            changed: false,
            value: wakeLeaseResult(task, false, "lease_active", new Date(leaseStartedAtMs + leaseMs).toISOString()),
          };
        }
      }
      const lastWakeAtMs = task.lastWakeAt === null ? null : Date.parse(task.lastWakeAt);
      const cooldownExpiresAt = lastWakeAtMs === null
        ? null
        : new Date(lastWakeAtMs + task.wakeCooldownMs).toISOString();
      if (batch === null && lastWakeAtMs !== null && now.getTime() < lastWakeAtMs + task.wakeCooldownMs) {
        return { changed: false, value: wakeLeaseResult(task, false, "wake_cooldown", null, cooldownExpiresAt) };
      }
      const boundary = requestedMessages.at(-1);
      if (batch === null) {
        batch = {
          wakeId: requestedWakeId,
          messageSeqs: requestedMessages.map((message) => message.messageSeq),
          messageTimes: requestedMessages.map((message) => message.messageAt),
          boundaryMessageSeq: boundary.messageSeq,
          boundaryMessageAt: boundary.messageAt,
          leaseStartedAt: now.toISOString(),
          sentAt: null,
          promptSha256: requestedPromptSha256,
          status: "leased",
          acknowledgedSeqs: [],
          supersededMessageSeqs: [],
          legacy: false,
        };
        task.wakeBatches.push(batch);
      } else {
        batch.leaseStartedAt = now.toISOString();
        batch.status = "leased";
      }
      refreshLegacyWakeFields(task);
      task.updatedAt = now.toISOString();
      return {
        changed: true,
        value: wakeLeaseResult(task, true, "acquired", new Date(now.getTime() + leaseMs).toISOString()),
      };
    });
  }

  confirmWakeSent(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const expectedWakeSentAt = requiredString(input.expectedWakeSentAt ?? input.wakeSentAt, "expectedWakeSentAt");
    const expectedWakeId = requiredString(input.expectedWakeId ?? input.wakeId, "expectedWakeId");
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const batch = task.wakeBatches.find((candidate) => candidate.wakeId === expectedWakeId) ?? null;
      if (!batch || batch.leaseStartedAt !== expectedWakeSentAt) {
        throw new TaskRegistryError(
          "WAKE_LEASE_MISMATCH",
          `唤醒租约已变化：${taskId}`,
          { taskId, expectedWakeId, expectedWakeSentAt, actualWakeSentAt: batch?.leaseStartedAt ?? null },
        );
      }
      if (batch.status === "sent" && batch.sentAt === expectedWakeSentAt) {
        return { changed: false, value: clonePublicTask(task) };
      }
      if (batch.status !== "leased") {
        throw new TaskRegistryError("WAKE_LEASE_MISMATCH", `唤醒批次不再处于租约状态：${taskId}`, { taskId, expectedWakeId });
      }
      batch.status = "sent";
      batch.sentAt = expectedWakeSentAt;
      const coveredPendingSequences = new Set(batch.messageSeqs.filter((sequence) =>
        findMessage(task, sequence)?.status === "pending"
      ));
      for (const candidate of task.wakeBatches) {
        if (candidate.wakeId === batch.wakeId || candidate.status !== "sent") continue;
        const overlappingSequences = effectiveWakeMessageSeqs(candidate)
          .filter((sequence) => coveredPendingSequences.has(sequence));
        if (!overlappingSequences.length) continue;
        candidate.supersededMessageSeqs = [...new Set([
          ...candidate.supersededMessageSeqs,
          ...overlappingSequences,
        ])];
        if (!effectiveWakeMessageSeqs(candidate).some((sequence) => findMessage(task, sequence)?.status === "pending")) {
          candidate.status = "complete";
        }
      }
      for (const sequence of batch.messageSeqs) {
        const message = findMessage(task, sequence);
        if (message?.status === "pending") {
          message.lastRemindedAt = expectedWakeSentAt;
        }
      }
      task.lastWakeAt = expectedWakeSentAt;
      task.updatedAt = resolveNow(this.now, input).toISOString();
      refreshLegacyWakeFields(task);
      return { changed: true, value: clonePublicTask(task) };
    });
  }

  releaseWakeLease(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const expectedWakeSentAt = input.expectedWakeSentAt ?? input.wakeSentAt;
    const expectedWakeId = requiredString(input.expectedWakeId ?? input.wakeId, "expectedWakeId");
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const batchIndex = task.wakeBatches.findIndex((candidate) => candidate.wakeId === expectedWakeId);
      if (batchIndex < 0) return { changed: false, value: clonePublicTask(task) };
      const batch = task.wakeBatches[batchIndex];
      if (expectedWakeSentAt !== undefined && expectedWakeSentAt !== batch.leaseStartedAt) {
        throw new TaskRegistryError(
          "WAKE_LEASE_MISMATCH",
          `唤醒租约已变化：${taskId}`,
          { taskId, expectedWakeId, expectedWakeSentAt, actualWakeSentAt: batch.leaseStartedAt },
        );
      }
      if (batch.status !== "leased") return { changed: false, value: clonePublicTask(task) };
      task.wakeBatches.splice(batchIndex, 1);
      task.updatedAt = resolveNow(this.now, input).toISOString();
      refreshLegacyWakeFields(task);
      return { changed: true, value: clonePublicTask(task) };
    });
  }

  reconcileFailedWake(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const wakeId = requiredString(input.wakeId, "wakeId");
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const batchIndex = task.wakeBatches.findIndex((candidate) => candidate.wakeId === wakeId);
      if (batchIndex < 0) return { changed: false, value: clonePublicTask(task) };
      const batch = task.wakeBatches[batchIndex];
      if (batch.status === "complete") return { changed: false, value: clonePublicTask(task) };
      if (!["leased", "sent"].includes(batch.status)) {
        throw new TaskRegistryError(
          "WAKE_RECONCILE_CONFLICT",
          `无法把当前唤醒状态恢复为待重试：${taskId}`,
          { taskId, wakeId, status: batch.status },
        );
      }
      task.wakeBatches.splice(batchIndex, 1);
      for (const sequence of batch.messageSeqs) {
        const message = findMessage(task, sequence);
        if (!message || message.status !== "pending") continue;
        const latestReminder = task.wakeBatches
          .filter((candidate) => candidate.status === "sent" && candidate.messageSeqs.includes(sequence))
          .map((candidate) => candidate.sentAt)
          .filter(Boolean)
          .sort((left, right) => Date.parse(left) - Date.parse(right))
          .at(-1) ?? null;
        message.lastRemindedAt = latestReminder;
      }
      task.lastWakeAt = task.wakeBatches
        .filter((candidate) => candidate.status === "sent")
        .map((candidate) => candidate.sentAt)
        .filter(Boolean)
        .sort((left, right) => Date.parse(left) - Date.parse(right))
        .at(-1) ?? null;
      task.updatedAt = resolveNow(this.now, input).toISOString();
      refreshLegacyWakeFields(task);
      return { changed: true, value: clonePublicTask(task) };
    });
  }

  #requireTask(state, taskId) {
    const task = state.tasks[taskId];
    if (!task) {
      throw new TaskRegistryError("TASK_NOT_FOUND", `任务不存在：${taskId}`, { taskId });
    }
    return task;
  }

  #write(mutator) {
    const release = acquireFileLock(this.lockPath, this.lockTimeoutMs, this.lockRetryMs, this.staleLockMs);
    try {
      let originalStateBytes = null;
      try {
        originalStateBytes = fs.readFileSync(this.statePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const state = readState(this.statePath);
      const result = mutator(state, { originalStateBytes });
      if (!result || typeof result.changed !== "boolean") {
        throw new TaskRegistryError("INTERNAL_ERROR", "账本变更没有返回有效结果");
      }
      if (result.changed) {
        if (result.rawStateBytes !== undefined) {
          if (!Buffer.isBuffer(result.rawStateBytes)) {
            throw new TaskRegistryError("INTERNAL_ERROR", "账本原字节恢复结果无效");
          }
          atomicWriteBytes(this.statePath, result.rawStateBytes);
        } else {
          atomicWriteState(this.statePath, state);
        }
      }
      return result.value;
    } finally {
      release();
    }
  }
}

export function createTaskRegistry(options = {}) {
  return new TaskRegistry(options);
}
