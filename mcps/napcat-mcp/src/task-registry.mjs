import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STATE_SCHEMA_VERSION = 1;
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
  "wakeCooldownMs",
  "wakePending",
  "wakeSentAt",
  "lastWakeAt",
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
  for (const field of PUBLIC_FIELDS) result[field] = task[field];
  return result;
}

function normalizeStoredTask(task) {
  if (!isPlainObject(task)) return task;
  if (!hasOwn(task, "wakeCooldownMs")) task.wakeCooldownMs = DEFAULT_WAKE_COOLDOWN_MS;
  if (!hasOwn(task, "lastWakeAt")) task.lastWakeAt = task.wakeSentAt ?? null;
  return task;
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
  storedDate(task.createdAt, `${taskId}.createdAt`, statePath);
  storedDate(task.updatedAt, `${taskId}.updatedAt`, statePath);
}

function validateState(value, statePath) {
  if (!isPlainObject(value) || value.schemaVersion !== STATE_SCHEMA_VERSION || !isPlainObject(value.tasks)) {
    invalidState(statePath, "账本结构无效");
  }
  for (const [taskId, task] of Object.entries(value.tasks)) {
    validateStoredTask(normalizeStoredTask(task), taskId, statePath);
  }
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
    throw new TaskRegistryError("STATE_WRITE_FAILED", `无法原子写入账本：${statePath}`, { statePath }, { cause: error });
  }
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
    return this.#write((state) => {
      const existing = state.tasks[taskId];
      if (existing) {
        if (existing.conversationId !== conversationId) {
          throw new TaskRegistryError(
            "TASK_CONVERSATION_CONFLICT",
            `taskId 已绑定其他 conversationId：${taskId}`,
            {
              taskId,
              existingConversationId: existing.conversationId,
              requestedConversationId: conversationId,
            },
          );
        }
        return { changed: false, value: clonePublicTask(existing) };
      }
      const now = resolveNow(this.now, input).toISOString();
      const task = {
        taskId,
        conversationId,
        localRole: optionalString(input.localRole, "localRole"),
        sourceMachine: optionalString(input.sourceMachine, "sourceMachine"),
        targetMachine: optionalString(input.targetMachine, "targetMachine"),
        trustedPeerQq: optionalString(input.trustedPeerQq, "trustedPeerQq"),
        generation: 1,
        status: "open",
        lastSeenSeq: 0,
        lastAckedSeq: 0,
        wakeCooldownMs: wakeCooldownNumber(input.wakeCooldownMs, this.wakeCooldownMs),
        wakePending: false,
        wakeSentAt: null,
        lastWakeAt: null,
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
        if (hasOwn(input, field)) nextTask[field] = optionalString(input[field], field);
      }
      if (hasCooldownUpdate) {
        nextTask.wakeCooldownMs = wakeCooldownNumber(input.wakeCooldownMs, task.wakeCooldownMs);
      }
      const routingChanged = ROUTING_FIELDS.some((field) => nextTask[field] !== task[field]);
      if (routingChanged) {
        if (nextTask.generation >= Number.MAX_SAFE_INTEGER) {
          throw new TaskRegistryError("GENERATION_OVERFLOW", `任务代次已达到上限：${taskId}`, { taskId });
        }
        nextTask.generation += 1;
      }
      const changed = routingChanged || nextTask.wakeCooldownMs !== task.wakeCooldownMs;
      if (!changed) return { changed: false, value: clonePublicTask(task) };
      nextTask.updatedAt = resolveNow(this.now, input).toISOString();
      if (nextConversationId !== task.conversationId) {
        nextTask.wakePending = false;
        nextTask.wakeSentAt = null;
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
      const nextTask = {
        ...task,
        status: "closed",
        wakePending: false,
        wakeSentAt: null,
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

  markSeen(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const sequence = parseSequence(input, "seq", ["seq", "lastSeenSeq", "sequence"]);
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (task.status === "closed") {
        throw new TaskRegistryError("TASK_CLOSED", `任务已经关闭：${taskId}`, { taskId });
      }
      if (sequence <= task.lastSeenSeq) return { changed: false, value: clonePublicTask(task) };
      const nextTask = {
        ...task,
        lastSeenSeq: sequence,
        updatedAt: resolveNow(this.now, input).toISOString(),
      };
      state.tasks[taskId] = nextTask;
      return { changed: true, value: clonePublicTask(nextTask) };
    });
  }

  ack(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const sequence = parseSequence(input, "seq", ["seq", "lastAckedSeq", "sequence"]);
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (task.status === "closed") {
        throw new TaskRegistryError("TASK_CLOSED", `任务已经关闭：${taskId}`, { taskId });
      }
      if (sequence < task.lastAckedSeq) {
        throw new TaskRegistryError(
          "ACK_REGRESSION",
          `ACK 不能回退：${taskId}`,
          { taskId, lastAckedSeq: task.lastAckedSeq, requestedSeq: sequence },
        );
      }
      if (sequence > task.lastSeenSeq) {
        throw new TaskRegistryError(
          "ACK_AHEAD_OF_SEEN",
          `ACK 不能超过已扫描消息：${taskId}`,
          { taskId, lastSeenSeq: task.lastSeenSeq, requestedSeq: sequence },
        );
      }
      if (sequence === task.lastAckedSeq) return { changed: false, value: clonePublicTask(task) };
      const nextTask = {
        ...task,
        lastAckedSeq: sequence,
        updatedAt: resolveNow(this.now, input).toISOString(),
      };
      state.tasks[taskId] = nextTask;
      return { changed: true, value: clonePublicTask(nextTask) };
    });
  }

  acquireWakeLease(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const leaseMs = optionNumber(
      input.leaseMs ?? input.wakeLeaseMs,
      "leaseMs",
      this.wakeLeaseMs,
      1,
    );
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      const now = resolveNow(this.now, input);
      if (task.status === "closed") {
        return {
          changed: false,
          value: wakeLeaseResult(task, false, "closed", null),
        };
      }
      const sentAtMs = task.wakeSentAt === null ? null : Date.parse(task.wakeSentAt);
      const leaseExpiresAt = sentAtMs === null
        ? null
        : new Date(sentAtMs + leaseMs).toISOString();
      if (task.wakePending && sentAtMs !== null && now.getTime() < sentAtMs + leaseMs) {
        return {
          changed: false,
          value: wakeLeaseResult(task, false, "lease_active", leaseExpiresAt),
        };
      }
      const lastWakeAtMs = task.lastWakeAt === null ? null : Date.parse(task.lastWakeAt);
      const cooldownExpiresAt = lastWakeAtMs === null
        ? null
        : new Date(lastWakeAtMs + task.wakeCooldownMs).toISOString();
      if (lastWakeAtMs !== null && now.getTime() < lastWakeAtMs + task.wakeCooldownMs) {
        return {
          changed: false,
          value: wakeLeaseResult(task, false, "wake_cooldown", null, cooldownExpiresAt),
        };
      }
      const nextTask = {
        ...task,
        wakePending: true,
        wakeSentAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      state.tasks[taskId] = nextTask;
      return {
        changed: true,
        value: wakeLeaseResult(nextTask, true, "acquired", new Date(now.getTime() + leaseMs).toISOString()),
      };
    });
  }

  confirmWakeSent(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const expectedWakeSentAt = requiredString(
      input.expectedWakeSentAt ?? input.wakeSentAt,
      "expectedWakeSentAt",
    );
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (!task.wakePending || task.wakeSentAt !== expectedWakeSentAt) {
        throw new TaskRegistryError(
          "WAKE_LEASE_MISMATCH",
          `唤醒租约已变化：${taskId}`,
          { taskId, expectedWakeSentAt, actualWakeSentAt: task.wakeSentAt },
        );
      }
      if (task.lastWakeAt === task.wakeSentAt) {
        return { changed: false, value: clonePublicTask(task) };
      }
      const nextTask = {
        ...task,
        lastWakeAt: task.wakeSentAt,
        updatedAt: resolveNow(this.now, input).toISOString(),
      };
      state.tasks[taskId] = nextTask;
      return { changed: true, value: clonePublicTask(nextTask) };
    });
  }

  releaseWakeLease(input) {
    if (!isPlainObject(input)) invalidArgument("input 必须是对象");
    const taskId = parseTaskId(input);
    const expectedWakeSentAt = input.expectedWakeSentAt ?? input.wakeSentAt;
    return this.#write((state) => {
      const task = this.#requireTask(state, taskId);
      requireGenerationMatch(task, input);
      if (expectedWakeSentAt !== undefined && expectedWakeSentAt !== task.wakeSentAt) {
        throw new TaskRegistryError(
          "WAKE_LEASE_MISMATCH",
          `唤醒租约已变化：${taskId}`,
          { taskId, expectedWakeSentAt, actualWakeSentAt: task.wakeSentAt },
        );
      }
      if (!task.wakePending && task.wakeSentAt === null) {
        return { changed: false, value: clonePublicTask(task) };
      }
      const nextTask = {
        ...task,
        wakePending: false,
        wakeSentAt: null,
        updatedAt: resolveNow(this.now, input).toISOString(),
      };
      state.tasks[taskId] = nextTask;
      return { changed: true, value: clonePublicTask(nextTask) };
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
      const state = readState(this.statePath);
      const result = mutator(state);
      if (!result || typeof result.changed !== "boolean") {
        throw new TaskRegistryError("INTERNAL_ERROR", "账本变更没有返回有效结果");
      }
      if (result.changed) atomicWriteState(this.statePath, state);
      return result.value;
    } finally {
      release();
    }
  }
}

export function createTaskRegistry(options = {}) {
  return new TaskRegistry(options);
}
