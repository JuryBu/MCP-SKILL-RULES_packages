import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STATE_SCHEMA_VERSION = 3;
const DEFAULT_MAX_SEEN = 2048;
const DEFAULT_LOCK_WAIT_MS = 2000;

export const DELIVERY_STATUSES = Object.freeze([
  "pending",
  "machine_received",
  "conversation_received",
]);
export const CONNECTION_REQUEST_STATUSES = Object.freeze([
  "received",
  "wake_accepted",
]);

const DELIVERY_STATUS_RANK = new Map(DELIVERY_STATUSES.map((status, index) => [status, index]));
const CONNECTION_REQUEST_STATUS_RANK = new Map(
  CONNECTION_REQUEST_STATUSES.map((status, index) => [status, index]),
);

export class ControlStateError extends Error {
  constructor(code, message, details = null, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ControlStateError";
    this.code = code;
    this.details = details;
  }
}

function invalidArgument(message, details = null) {
  throw new ControlStateError("INVALID_ARGUMENT", message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(value, name, maximum = 512) {
  if (value === undefined || value === null) invalidArgument(`${name} 不能为空`);
  const normalized = String(value).trim();
  if (!normalized) invalidArgument(`${name} 不能为空`);
  if (normalized.length > maximum) invalidArgument(`${name} 不能超过 ${maximum} 个字符`);
  return normalized;
}

function optionalString(value, name, maximum = 512) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maximum) invalidArgument(`${name} 不能超过 ${maximum} 个字符`);
  return normalized;
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
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    invalidArgument(`${name} 必须是正安全整数`);
  }
  return numberValue;
}

function enumValue(value, name, allowedValues) {
  const normalized = requiredString(value, name, 64);
  if (!allowedValues.includes(normalized)) {
    invalidArgument(`${name} 必须是 ${allowedValues.join("、")} 之一`, { name, value: normalized });
  }
  return normalized;
}

function toISOString(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) invalidArgument(`${name} 必须是有效时间`);
  return date.toISOString();
}

function resolveNow(provider, input) {
  return toISOString(hasOwn(input, "now") ? input.now : provider(), "now");
}

function clone(value) {
  if (value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    businessReceiptBootstrapAt: null,
    deliveries: {},
    connectionRequests: {},
    ownerRoutes: {},
    ownerAlertMessages: {},
    seenControlMessages: [],
  };
}

function migrateState(value) {
  if (!isPlainObject(value)) return value;
  let migrated = value;
  if (migrated.schemaVersion === 1) {
    migrated = {
      ...migrated,
      schemaVersion: 2,
      businessReceiptBootstrapAt: null,
    };
  }
  if (migrated.schemaVersion === 2) {
    migrated = {
      ...migrated,
      schemaVersion: STATE_SCHEMA_VERSION,
      ownerAlertMessages: {},
    };
  }
  return migrated;
}

function invalidState(statePath, message, details = null, cause = undefined) {
  throw new ControlStateError(
    "INVALID_STATE",
    `${message}：${statePath}`,
    { statePath, ...details },
    cause ? { cause } : undefined,
  );
}

function validateStoredString(value, statePath, field) {
  if (typeof value !== "string" || !value.trim()) {
    invalidState(statePath, `字段无效（${field}）`, { field });
  }
}

function validateStoredOptionalString(value, statePath, field) {
  if (value !== null && (typeof value !== "string" || !value.trim())) {
    invalidState(statePath, `字段无效（${field}）`, { field });
  }
}

function validateStoredDate(value, statePath, field, optional = false) {
  if (optional && value === null) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalidState(statePath, `时间无效（${field}）`, { field });
  }
}

function validateStoredDelivery(delivery, deliveryId, statePath) {
  if (!isPlainObject(delivery)) invalidState(statePath, `投递记录无效（${deliveryId}）`);
  if (delivery.deliveryId !== deliveryId) invalidState(statePath, `投递键与 deliveryId 不一致（${deliveryId}）`);
  for (const field of ["deliveryId", "taskId", "sourceMachine", "targetMachine"]) {
    validateStoredString(delivery[field], statePath, `deliveries.${deliveryId}.${field}`);
  }
  if (!Number.isSafeInteger(delivery.messageSeq) || delivery.messageSeq < 0) {
    invalidState(statePath, `投递消息标识无效（${deliveryId}）`);
  }
  if (!DELIVERY_STATUS_RANK.has(delivery.status)) {
    invalidState(statePath, `投递状态无效（${deliveryId}）`);
  }
  validateStoredDate(delivery.machineReceivedAt, statePath, `deliveries.${deliveryId}.machineReceivedAt`, true);
  validateStoredDate(
    delivery.conversationReceivedAt,
    statePath,
    `deliveries.${deliveryId}.conversationReceivedAt`,
    true,
  );
  const rank = DELIVERY_STATUS_RANK.get(delivery.status);
  if ((rank === 0 && (delivery.machineReceivedAt !== null || delivery.conversationReceivedAt !== null))
    || (rank === 1 && (delivery.machineReceivedAt === null || delivery.conversationReceivedAt !== null))
    || (rank === 2 && (delivery.machineReceivedAt === null || delivery.conversationReceivedAt === null))) {
    invalidState(statePath, `投递阶段与时间不一致（${deliveryId}）`);
  }
  if (delivery.machineReceivedAt !== null
    && delivery.conversationReceivedAt !== null
    && Date.parse(delivery.conversationReceivedAt) < Date.parse(delivery.machineReceivedAt)) {
    invalidState(statePath, `投递时间顺序无效（${deliveryId}）`);
  }
}

function validateStoredConnectionRequest(request, requestId, statePath) {
  if (!isPlainObject(request)) invalidState(statePath, `连接请求记录无效（${requestId}）`);
  if (request.requestId !== requestId) invalidState(statePath, `连接请求键与 requestId 不一致（${requestId}）`);
  for (const field of [
    "requestId",
    "targetConversationId",
    "proposedTaskId",
    "sourceMachine",
    "targetMachine",
  ]) {
    validateStoredString(request[field], statePath, `connectionRequests.${requestId}.${field}`);
  }
  if (request.sourceConversationId !== undefined) {
    validateStoredOptionalString(
      request.sourceConversationId,
      statePath,
      `connectionRequests.${requestId}.sourceConversationId`,
    );
  }
  if (request.previousTaskId !== undefined) {
    validateStoredOptionalString(request.previousTaskId, statePath, `connectionRequests.${requestId}.previousTaskId`);
  }
  if (!CONNECTION_REQUEST_STATUS_RANK.has(request.status)) {
    invalidState(statePath, `连接请求状态无效（${requestId}）`);
  }
  validateStoredDate(request.receivedAt, statePath, `connectionRequests.${requestId}.receivedAt`);
  validateStoredDate(
    request.wakeAcceptedAt,
    statePath,
    `connectionRequests.${requestId}.wakeAcceptedAt`,
    true,
  );
  const rank = CONNECTION_REQUEST_STATUS_RANK.get(request.status);
  if ((rank === 0 && request.wakeAcceptedAt !== null) || (rank === 1 && request.wakeAcceptedAt === null)) {
    invalidState(statePath, `连接请求阶段与时间不一致（${requestId}）`);
  }
  if (request.wakeAcceptedAt !== null && Date.parse(request.wakeAcceptedAt) < Date.parse(request.receivedAt)) {
    invalidState(statePath, `连接请求时间顺序无效（${requestId}）`);
  }
}

function validateStoredOwnerRoute(route, routeKey, statePath) {
  if (!isPlainObject(route)) invalidState(statePath, `所有者路由记录无效（${routeKey}）`);
  if (route.routeKey !== routeKey) invalidState(statePath, `路由键与 routeKey 不一致（${routeKey}）`);
  for (const field of ["routeKey", "conversationId", "targetKey"]) {
    validateStoredString(route[field], statePath, `ownerRoutes.${routeKey}.${field}`);
  }
  validateStoredOptionalString(route.taskId, statePath, `ownerRoutes.${routeKey}.taskId`);
  if (route.status !== "open" && route.status !== "closed") {
    invalidState(statePath, `所有者路由状态无效（${routeKey}）`);
  }
  validateStoredDate(route.openedAt, statePath, `ownerRoutes.${routeKey}.openedAt`);
  validateStoredDate(route.closedAt, statePath, `ownerRoutes.${routeKey}.closedAt`, true);
  if ((route.status === "open" && route.closedAt !== null)
    || (route.status === "closed" && route.closedAt === null)) {
    invalidState(statePath, `所有者路由阶段与时间不一致（${routeKey}）`);
  }
  if (route.closedAt !== null && Date.parse(route.closedAt) < Date.parse(route.openedAt)) {
    invalidState(statePath, `所有者路由时间顺序无效（${routeKey}）`);
  }
  if (!Number.isSafeInteger(route.lastInboundMessageSeq) || route.lastInboundMessageSeq < 0) {
    invalidState(statePath, `所有者路由消息标识无效（${routeKey}）`);
  }
}

function validateStoredOwnerAlertMessage(message, messageId, statePath) {
  if (!isPlainObject(message)) invalidState(statePath, `主人通知消息记录无效（${messageId}）`);
  if (message.messageId !== messageId) invalidState(statePath, `主人通知消息键与 messageId 不一致（${messageId}）`);
  for (const field of ["messageId", "routeKey", "targetKey"]) {
    validateStoredString(message[field], statePath, `ownerAlertMessages.${messageId}.${field}`);
  }
  validateStoredDate(message.sentAt, statePath, `ownerAlertMessages.${messageId}.sentAt`);
}

function validateState(value, statePath) {
  value = migrateState(value);
  if (!isPlainObject(value)
    || value.schemaVersion !== STATE_SCHEMA_VERSION
    || !(value.businessReceiptBootstrapAt === null
      || (typeof value.businessReceiptBootstrapAt === "string"
        && Number.isFinite(Date.parse(value.businessReceiptBootstrapAt))))
    || !isPlainObject(value.deliveries)
    || !isPlainObject(value.connectionRequests)
    || !isPlainObject(value.ownerRoutes)
    || !isPlainObject(value.ownerAlertMessages)
    || !Array.isArray(value.seenControlMessages)) {
    invalidState(statePath, "控制账本结构无效");
  }
  for (const [deliveryId, delivery] of Object.entries(value.deliveries)) {
    validateStoredDelivery(delivery, deliveryId, statePath);
  }
  for (const [requestId, request] of Object.entries(value.connectionRequests)) {
    validateStoredConnectionRequest(request, requestId, statePath);
  }
  for (const [routeKey, route] of Object.entries(value.ownerRoutes)) {
    validateStoredOwnerRoute(route, routeKey, statePath);
  }
  for (const [messageId, message] of Object.entries(value.ownerAlertMessages)) {
    validateStoredOwnerAlertMessage(message, messageId, statePath);
  }
  const seen = new Set();
  for (const messageKey of value.seenControlMessages) {
    validateStoredString(messageKey, statePath, "seenControlMessages");
    if (seen.has(messageKey)) invalidState(statePath, `控制消息去重键重复（${messageKey}）`);
    seen.add(messageKey);
  }
  return value;
}

function readState(statePath, maxSeen) {
  let text;
  try {
    text = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: emptyState(), trimmed: false };
    throw new ControlStateError("STATE_READ_FAILED", `无法读取控制账本：${statePath}`, { statePath }, { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new ControlStateError("INVALID_STATE", `控制账本 JSON 损坏：${statePath}`, { statePath }, { cause: error });
  }
  const state = validateState(value, statePath);
  const trimCount = Math.max(0, state.seenControlMessages.length - maxSeen);
  if (trimCount > 0) state.seenControlMessages.splice(0, trimCount);
  const ownerAlertEntries = Object.values(state.ownerAlertMessages)
    .sort((left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt));
  const ownerAlertTrimCount = Math.max(0, ownerAlertEntries.length - maxSeen);
  for (const entry of ownerAlertEntries.slice(0, ownerAlertTrimCount)) {
    delete state.ownerAlertMessages[entry.messageId];
  }
  return { state, trimmed: trimCount > 0 || ownerAlertTrimCount > 0 };
}

function atomicWriteState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(statePath),
    `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
    }
    throw new ControlStateError(
      "STATE_WRITE_FAILED",
      `无法原子写入控制账本：${statePath}`,
      { statePath },
      { cause: error },
    );
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleepSync(milliseconds) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitArray, 0, 0, milliseconds);
}

function acquireStateLock(statePath, waitMs = DEFAULT_LOCK_WAIT_MS) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8").replace(/^\uFEFF/, ""));
          if (current?.token === token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      let snapshot = "";
      let metadata = null;
      try {
        snapshot = fs.readFileSync(lockPath, "utf8");
        metadata = JSON.parse(snapshot.replace(/^\uFEFF/, ""));
      } catch {
      }
      if (!processIsAlive(Number(metadata?.pid))) {
        try {
          if (fs.readFileSync(lockPath, "utf8") === snapshot) fs.unlinkSync(lockPath);
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code === "ENOENT") continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new ControlStateError("STATE_LOCK_TIMEOUT", `等待控制账本锁超时：${lockPath}`, { lockPath, owner: metadata });
      }
      sleepSync(10);
    }
  }
}

function immutableValue(input, field, existing, options = {}) {
  const { optional = false, maximum = 512, conflictCode, recordId } = options;
  if (!existing) {
    return optional
      ? optionalString(input[field], field, maximum)
      : requiredString(input[field], field, maximum);
  }
  if (!hasOwn(input, field)) return existing[field];
  const requested = optional
    ? optionalString(input[field], field, maximum)
    : requiredString(input[field], field, maximum);
  if (requested !== existing[field]) {
    throw new ControlStateError(
      conflictCode,
      `${field} 与已持久化记录冲突：${recordId}`,
      { recordId, field, existing: existing[field], requested },
    );
  }
  return existing[field];
}

function immutableInteger(input, field, existing, conflictCode, recordId) {
  if (!existing) return nonNegativeInteger(input[field], field);
  if (!hasOwn(input, field)) return existing[field];
  const requested = nonNegativeInteger(input[field], field);
  if (requested !== existing[field]) {
    throw new ControlStateError(
      conflictCode,
      `${field} 与已持久化记录冲突：${recordId}`,
      { recordId, field, existing: existing[field], requested },
    );
  }
  return existing[field];
}

function requestedDate(input, field) {
  if (!hasOwn(input, field) || input[field] === null || input[field] === undefined) return null;
  return toISOString(input[field], field);
}

function mergeDate(existingValue, input, field, conflictCode, recordId) {
  const requested = requestedDate(input, field);
  if (existingValue !== null && requested !== null && requested !== existingValue) {
    throw new ControlStateError(
      conflictCode,
      `${field} 与已持久化记录冲突：${recordId}`,
      { recordId, field, existing: existingValue, requested },
    );
  }
  return existingValue ?? requested;
}

function assertChronological(earlier, later, earlierName, laterName) {
  if (earlier !== null && later !== null && Date.parse(later) < Date.parse(earlier)) {
    invalidArgument(`${laterName} 不能早于 ${earlierName}`);
  }
}

export class ControlState {
  constructor(options = {}) {
    if (!isPlainObject(options)) invalidArgument("options 必须是对象");
    const defaultStatePath = path.join(process.cwd(), "state", "control-state.json");
    this.statePath = path.resolve(String(options.statePath ?? defaultStatePath));
    this.maxSeen = positiveInteger(options.maxSeen ?? DEFAULT_MAX_SEEN, "maxSeen");
    if (options.now !== undefined && typeof options.now !== "function") {
      const fixedNow = options.now;
      this.now = () => fixedNow;
    } else {
      this.now = options.now ?? (() => new Date());
    }
  }

  snapshot() {
    return clone(readState(this.statePath, this.maxSeen).state);
  }

  getBusinessReceiptBootstrapAt() {
    return readState(this.statePath, this.maxSeen).state.businessReceiptBootstrapAt;
  }

  initializeBusinessReceiptBaseline(input = {}) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const receiptKeys = Array.isArray(input.receiptKeys)
      ? input.receiptKeys.map((value) => requiredString(value, "receiptKeys[]", 512))
      : [];
    return this.#write((state) => {
      if (state.businessReceiptBootstrapAt !== null) {
        return {
          changed: false,
          value: {
            initialized: false,
            bootstrapAt: state.businessReceiptBootstrapAt,
            baselinedReceiptCount: 0,
          },
        };
      }
      state.businessReceiptBootstrapAt = resolveNow(this.now, input);
      let baselinedReceiptCount = 0;
      for (const receiptKey of receiptKeys) {
        if (state.seenControlMessages.includes(receiptKey)) continue;
        state.seenControlMessages.push(receiptKey);
        baselinedReceiptCount += 1;
      }
      if (state.seenControlMessages.length > this.maxSeen) {
        state.seenControlMessages.splice(0, state.seenControlMessages.length - this.maxSeen);
      }
      return {
        changed: true,
        value: {
          initialized: true,
          bootstrapAt: state.businessReceiptBootstrapAt,
          baselinedReceiptCount,
        },
      };
    });
  }

  getDelivery(deliveryId) {
    const normalizedId = requiredString(deliveryId, "deliveryId", 128);
    return clone(readState(this.statePath, this.maxSeen).state.deliveries[normalizedId] ?? null);
  }

  listDeliveries() {
    return Object.values(readState(this.statePath, this.maxSeen).state.deliveries).map(clone);
  }

  updateDelivery(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const deliveryId = requiredString(input.deliveryId, "deliveryId", 128);
    const requestedStatus = enumValue(input.status, "status", DELIVERY_STATUSES);
    return this.#write((state) => {
      const existing = state.deliveries[deliveryId] ?? null;
      const currentRank = existing ? DELIVERY_STATUS_RANK.get(existing.status) : -1;
      const requestedRank = DELIVERY_STATUS_RANK.get(requestedStatus);
      if (requestedRank < currentRank) {
        throw new ControlStateError(
          "DELIVERY_STAGE_REGRESSION",
          `投递阶段不能倒退：${deliveryId}`,
          { deliveryId, currentStatus: existing.status, requestedStatus },
        );
      }
      const now = resolveNow(this.now, input);
      const machineReceivedAt = requestedRank >= 1
        ? mergeDate(existing?.machineReceivedAt ?? null, input, "machineReceivedAt", "DELIVERY_CONFLICT", deliveryId) ?? now
        : requestedDate(input, "machineReceivedAt");
      const conversationReceivedAt = requestedRank >= 2
        ? mergeDate(
          existing?.conversationReceivedAt ?? null,
          input,
          "conversationReceivedAt",
          "DELIVERY_CONFLICT",
          deliveryId,
        ) ?? now
        : requestedDate(input, "conversationReceivedAt");
      if (requestedRank === 0 && (machineReceivedAt !== null || conversationReceivedAt !== null)) {
        invalidArgument("pending 阶段不能带接收时间");
      }
      if (requestedRank === 1 && conversationReceivedAt !== null) {
        invalidArgument("machine_received 阶段不能带 conversationReceivedAt");
      }
      assertChronological(
        machineReceivedAt,
        conversationReceivedAt,
        "machineReceivedAt",
        "conversationReceivedAt",
      );
      const delivery = {
        deliveryId,
        taskId: immutableValue(input, "taskId", existing, {
          conflictCode: "DELIVERY_CONFLICT",
          recordId: deliveryId,
        }),
        sourceMachine: immutableValue(input, "sourceMachine", existing, {
          conflictCode: "DELIVERY_CONFLICT",
          recordId: deliveryId,
        }),
        targetMachine: immutableValue(input, "targetMachine", existing, {
          conflictCode: "DELIVERY_CONFLICT",
          recordId: deliveryId,
        }),
        messageSeq: immutableInteger(
          input,
          "messageSeq",
          existing,
          "DELIVERY_CONFLICT",
          deliveryId,
        ),
        machineReceivedAt,
        conversationReceivedAt,
        status: requestedStatus,
      };
      if (existing && requestedRank === currentRank) return { changed: false, value: clone(existing) };
      state.deliveries[deliveryId] = delivery;
      return { changed: true, value: clone(delivery) };
    });
  }

  getConnectionRequest(requestId) {
    const normalizedId = requiredString(requestId, "requestId", 128);
    return clone(readState(this.statePath, this.maxSeen).state.connectionRequests[normalizedId] ?? null);
  }

  listConnectionRequests() {
    return Object.values(readState(this.statePath, this.maxSeen).state.connectionRequests).map(clone);
  }

  updateConnectionRequest(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const requestId = requiredString(input.requestId, "requestId", 128);
    const requestedStatus = enumValue(input.status, "status", CONNECTION_REQUEST_STATUSES);
    return this.#write((state) => {
      const existing = state.connectionRequests[requestId] ?? null;
      const currentRank = existing ? CONNECTION_REQUEST_STATUS_RANK.get(existing.status) : -1;
      const requestedRank = CONNECTION_REQUEST_STATUS_RANK.get(requestedStatus);
      if (requestedRank < currentRank) {
        throw new ControlStateError(
          "CONNECTION_REQUEST_STAGE_REGRESSION",
          `连接请求阶段不能倒退：${requestId}`,
          { requestId, currentStatus: existing.status, requestedStatus },
        );
      }
      const now = resolveNow(this.now, input);
      const receivedAt = mergeDate(
        existing?.receivedAt ?? null,
        input,
        "receivedAt",
        "CONNECTION_REQUEST_CONFLICT",
        requestId,
      ) ?? now;
      const wakeAcceptedAt = requestedRank >= 1
        ? mergeDate(
          existing?.wakeAcceptedAt ?? null,
          input,
          "wakeAcceptedAt",
          "CONNECTION_REQUEST_CONFLICT",
          requestId,
        ) ?? now
        : requestedDate(input, "wakeAcceptedAt");
      if (requestedRank === 0 && wakeAcceptedAt !== null) {
        invalidArgument("received 阶段不能带 wakeAcceptedAt");
      }
      assertChronological(receivedAt, wakeAcceptedAt, "receivedAt", "wakeAcceptedAt");
      const request = {
        requestId,
        sourceConversationId: immutableValue(input, "sourceConversationId", existing, {
          optional: true,
          maximum: 256,
          conflictCode: "CONNECTION_REQUEST_CONFLICT",
          recordId: requestId,
        }),
        targetConversationId: immutableValue(input, "targetConversationId", existing, {
          maximum: 256,
          conflictCode: "CONNECTION_REQUEST_CONFLICT",
          recordId: requestId,
        }),
        proposedTaskId: immutableValue(input, "proposedTaskId", existing, {
          conflictCode: "CONNECTION_REQUEST_CONFLICT",
          recordId: requestId,
        }),
        previousTaskId: immutableValue(input, "previousTaskId", existing, {
          optional: true,
          maximum: 128,
          conflictCode: "CONNECTION_REQUEST_CONFLICT",
          recordId: requestId,
        }),
        sourceMachine: immutableValue(input, "sourceMachine", existing, {
          conflictCode: "CONNECTION_REQUEST_CONFLICT",
          recordId: requestId,
        }),
        targetMachine: immutableValue(input, "targetMachine", existing, {
          conflictCode: "CONNECTION_REQUEST_CONFLICT",
          recordId: requestId,
        }),
        receivedAt,
        wakeAcceptedAt,
        status: requestedStatus,
      };
      if (existing && requestedRank === currentRank) return { changed: false, value: clone(existing) };
      state.connectionRequests[requestId] = request;
      return { changed: true, value: clone(request) };
    });
  }

  getOwnerRoute(routeKey) {
    const normalizedKey = requiredString(routeKey, "routeKey", 256);
    return clone(readState(this.statePath, this.maxSeen).state.ownerRoutes[normalizedKey] ?? null);
  }

  listOwnerRoutes() {
    return Object.values(readState(this.statePath, this.maxSeen).state.ownerRoutes).map(clone);
  }

  openOwnerRoute(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const routeKey = requiredString(input.routeKey, "routeKey", 256);
    return this.#write((state) => {
      const existing = state.ownerRoutes[routeKey] ?? null;
      const requestedOpenedAt = requestedDate(input, "openedAt");
      if (existing?.status === "open" && requestedOpenedAt !== null && requestedOpenedAt !== existing.openedAt) {
        throw new ControlStateError(
          "OWNER_ROUTE_CONFLICT",
          `openedAt 与已打开路由冲突：${routeKey}`,
          { routeKey, existing: existing.openedAt, requested: requestedOpenedAt },
        );
      }
      const requestedSequence = hasOwn(input, "lastInboundMessageSeq")
        ? nonNegativeInteger(input.lastInboundMessageSeq, "lastInboundMessageSeq")
        : null;
      const route = {
        routeKey,
        conversationId: immutableValue(input, "conversationId", existing, {
          maximum: 256,
          conflictCode: "OWNER_ROUTE_CONFLICT",
          recordId: routeKey,
        }),
        taskId: immutableValue(input, "taskId", existing, {
          optional: true,
          conflictCode: "OWNER_ROUTE_CONFLICT",
          recordId: routeKey,
        }),
        targetKey: immutableValue(input, "targetKey", existing, {
          maximum: 256,
          conflictCode: "OWNER_ROUTE_CONFLICT",
          recordId: routeKey,
        }),
        status: "open",
        openedAt: existing?.status === "open"
          ? existing.openedAt
          : requestedOpenedAt ?? resolveNow(this.now, input),
        closedAt: null,
        lastInboundMessageSeq: requestedSequence ?? existing?.lastInboundMessageSeq ?? 0,
      };
      const changed = !existing
        || existing.status !== "open"
        || route.lastInboundMessageSeq !== existing.lastInboundMessageSeq;
      if (!changed) return { changed: false, value: clone(existing) };
      state.ownerRoutes[routeKey] = route;
      return { changed: true, value: clone(route) };
    });
  }

  closeOwnerRoute(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const routeKey = requiredString(input.routeKey, "routeKey", 256);
    return this.#write((state) => {
      const existing = state.ownerRoutes[routeKey];
      if (!existing) {
        throw new ControlStateError("OWNER_ROUTE_NOT_FOUND", `所有者路由不存在：${routeKey}`, { routeKey });
      }
      const requestedClosedAt = requestedDate(input, "closedAt");
      if (existing.status === "closed") {
        if (requestedClosedAt !== null && requestedClosedAt !== existing.closedAt) {
          throw new ControlStateError(
            "OWNER_ROUTE_CONFLICT",
            `closedAt 与已关闭路由冲突：${routeKey}`,
            { routeKey, existing: existing.closedAt, requested: requestedClosedAt },
          );
        }
        return { changed: false, value: clone(existing) };
      }
      const closedAt = requestedClosedAt ?? resolveNow(this.now, input);
      assertChronological(existing.openedAt, closedAt, "openedAt", "closedAt");
      existing.status = "closed";
      existing.closedAt = closedAt;
      return { changed: true, value: clone(existing) };
    });
  }

  recordOwnerRouteInbound(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const routeKey = requiredString(input.routeKey, "routeKey", 256);
    const messageSeq = nonNegativeInteger(input.messageSeq, "messageSeq");
    return this.#write((state) => {
      const route = state.ownerRoutes[routeKey];
      if (!route) {
        throw new ControlStateError("OWNER_ROUTE_NOT_FOUND", `所有者路由不存在：${routeKey}`, { routeKey });
      }
      if (route.status !== "open") {
        throw new ControlStateError("OWNER_ROUTE_CLOSED", `所有者路由已关闭：${routeKey}`, { routeKey });
      }
      if (messageSeq === route.lastInboundMessageSeq) return { changed: false, value: clone(route) };
      route.lastInboundMessageSeq = messageSeq;
      return { changed: true, value: clone(route) };
    });
  }

  getOwnerAlertMessage(messageId) {
    const normalizedId = requiredString(messageId, "messageId", 256);
    return clone(readState(this.statePath, this.maxSeen).state.ownerAlertMessages[normalizedId] ?? null);
  }

  recordOwnerAlertMessage(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const messageId = requiredString(input.messageId, "messageId", 256);
    const routeKey = requiredString(input.routeKey, "routeKey", 256);
    const targetKey = requiredString(input.targetKey, "targetKey", 256);
    return this.#write((state) => {
      const route = state.ownerRoutes[routeKey];
      if (!route) {
        throw new ControlStateError("OWNER_ROUTE_NOT_FOUND", `所有者路由不存在：${routeKey}`, { routeKey });
      }
      if (route.status !== "open") {
        throw new ControlStateError("OWNER_ROUTE_CLOSED", `所有者路由已关闭：${routeKey}`, { routeKey });
      }
      if (route.targetKey !== targetKey) {
        throw new ControlStateError(
          "OWNER_ALERT_TARGET_CONFLICT",
          `通知目标与路由不一致：${routeKey}`,
          { routeKey, existing: route.targetKey, requested: targetKey },
        );
      }
      const existing = state.ownerAlertMessages[messageId] ?? null;
      if (existing) {
        if (existing.routeKey !== routeKey || existing.targetKey !== targetKey) {
          throw new ControlStateError(
            "OWNER_ALERT_MESSAGE_CONFLICT",
            `messageId 已绑定到其它主人通知：${messageId}`,
            { messageId, existing, requested: { routeKey, targetKey } },
          );
        }
        return { changed: false, value: clone(existing) };
      }
      const message = {
        messageId,
        routeKey,
        targetKey,
        sentAt: resolveNow(this.now, input),
      };
      state.ownerAlertMessages[messageId] = message;
      return { changed: true, value: clone(message) };
    });
  }

  hasSeenControlMessage(messageKey) {
    const normalizedKey = requiredString(messageKey, "messageKey", 512);
    return readState(this.statePath, this.maxSeen).state.seenControlMessages.includes(normalizedKey);
  }

  markControlMessageSeen(messageKey) {
    const normalizedKey = requiredString(messageKey, "messageKey", 512);
    return this.#write((state) => {
      if (state.seenControlMessages.includes(normalizedKey)) {
        return { changed: false, value: { messageKey: normalizedKey, duplicate: true } };
      }
      state.seenControlMessages.push(normalizedKey);
      if (state.seenControlMessages.length > this.maxSeen) {
        state.seenControlMessages.splice(0, state.seenControlMessages.length - this.maxSeen);
      }
      return { changed: true, value: { messageKey: normalizedKey, duplicate: false } };
    });
  }

  #write(mutator) {
    const release = acquireStateLock(this.statePath);
    try {
      const { state, trimmed } = readState(this.statePath, this.maxSeen);
      const result = mutator(state);
      if (!result || typeof result.changed !== "boolean") {
        throw new ControlStateError("INTERNAL_ERROR", "控制账本变更没有返回有效结果");
      }
      if (result.changed || trimmed) atomicWriteState(this.statePath, state);
      return result.value;
    } finally {
      release();
    }
  }
}

export function createControlState(options = {}) {
  return new ControlState(options);
}
