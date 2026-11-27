import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renameReplaceSync } from "./atomic-file.mjs";
import { RelayError } from "./relay-groups.mjs";

export const RELAY_STATE_SCHEMA_VERSION = 1;
export const RELAY_STATE_LIMITS = Object.freeze({
  schemaVersion: RELAY_STATE_SCHEMA_VERSION,
  maxCacheBytes: 1048576,
  maxEventsPerRoute: 2000,
  maxGlobalEvents: 2000,
  maxSendRecords: 2000,
  maxReadLimit: 50,
  maxCursorBytes: 4096,
  rateWindowMs: 60_000,
  lockWaitMs: 2000,
  staleEmptyLockGraceMs: 5000,
});

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_SEND_STATUSES = new Set(["pending_send", "sent_unverified", "sent_verified"]);

const LOCK_SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds) {
  Atomics.wait(LOCK_SLEEP_VIEW, 0, 0, milliseconds);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function requireSafeKey(value, name, maximum = 256) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > maximum
    || CONTROL_CHAR_PATTERN.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
  ) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 无效`, { field: name });
  }
  return value;
}

function requireScopeOrKey(value, name, maximum = 256) {
  if (value === "*") return "*";
  return requireSafeKey(value, name, maximum);
}

function requirePositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是正安全整数`, { field: name });
  }
  return value;
}

function requireNonNegativeInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是非负安全整数`, { field: name });
  }
  return value;
}

function toIsoTimestamp(value, name = "now") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是有效时间`, { field: name });
  }
  return date.toISOString();
}

function resolveNowDate(nowProvider, overrideNow) {
  const raw = overrideNow !== undefined ? overrideNow : nowProvider();
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "now 必须是有效时间", { field: "now" });
  }
  return date;
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

function emptyState() {
  return {
    schemaVersion: RELAY_STATE_SCHEMA_VERSION,
    globalSequence: 0,
    sends: {},
    rateWindows: {},
    routes: {},
  };
}

function invalidState(statePath, message, details = null, cause = undefined) {
  throw new RelayError(
    "RELAY_STATE_INVALID",
    `${message}：${statePath}`,
    { statePath, ...(details ?? {}) },
    cause ? { cause } : undefined,
  );
}

function validateStoredEvent(event, route, statePath) {
  if (!isPlainObject(event)) {
    invalidState(statePath, `路由 ${route.relay_key} 中存在非对象事件`);
  }
  if (!SHA256_HEX_PATTERN.test(String(event.event_id ?? ""))) {
    invalidState(statePath, `路由 ${route.relay_key} 事件 event_id 无效`);
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
    invalidState(statePath, `路由 ${route.relay_key} 事件 sequence 无效`);
  }
  if (!Number.isSafeInteger(event.global_sequence) || event.global_sequence <= 0) {
    invalidState(statePath, `路由 ${route.relay_key} 事件 global_sequence 无效`);
  }
  if (event.relay_key !== route.relay_key || typeof event.group_id !== "string" || !event.group_id) {
    invalidState(statePath, `路由 ${route.relay_key} 事件路由归属无效`);
  }
  if (!Number.isSafeInteger(event.route_generation) || event.route_generation <= 0) {
    invalidState(statePath, `路由 ${route.relay_key} 事件 route_generation 无效`);
  }
  if (typeof event.sender_id !== "string" || !event.sender_id || typeof event.source_machine !== "string" || !event.source_machine) {
    invalidState(statePath, `路由 ${route.relay_key} 事件发送者字段无效`);
  }
  if (typeof event.received_at !== "string" || !Number.isFinite(Date.parse(event.received_at))) {
    invalidState(statePath, `路由 ${route.relay_key} 事件 received_at 无效`);
  }
  if (!isPlainObject(event.frame)) {
    invalidState(statePath, `路由 ${route.relay_key} 事件缺少 frame 对象`);
  }
}

function validateState(value, statePath) {
  if (!isPlainObject(value)) {
    invalidState(statePath, "中继状态账本根节点必须是对象");
  }
  if (value.schemaVersion !== RELAY_STATE_SCHEMA_VERSION) {
    invalidState(statePath, `不支持的中继状态账本 schemaVersion: ${String(value.schemaVersion)}`, {
      schemaVersion: value.schemaVersion ?? null,
    });
  }
  const globalSequence = value.globalSequence ?? 0;
  if (!Number.isSafeInteger(globalSequence) || globalSequence < 0) {
    invalidState(statePath, "globalSequence 无效");
  }
  if (!isPlainObject(value.sends) || !isPlainObject(value.rateWindows) || !isPlainObject(value.routes)) {
    invalidState(statePath, "sends / rateWindows / routes 必须是对象");
  }

  for (const [dedupeKey, record] of Object.entries(value.sends)) {
    if (FORBIDDEN_KEYS.has(dedupeKey) || !isPlainObject(record)) {
      invalidState(statePath, `发送记录无效：${dedupeKey}`);
    }
    if (record.dedupe_key !== dedupeKey) {
      invalidState(statePath, `发送记录 dedupe_key 不一致：${dedupeKey}`);
    }
    if (!SHA256_HEX_PATTERN.test(String(record.fingerprint_sha256 ?? ""))) {
      invalidState(statePath, `发送记录 fingerprint_sha256 无效：${dedupeKey}`);
    }
    if (!ALLOWED_SEND_STATUSES.has(record.status)) {
      invalidState(statePath, `发送记录状态无效：${dedupeKey}`);
    }
    if (
      typeof record.relay_id !== "string" || !record.relay_id
      || typeof record.relay_key !== "string" || !record.relay_key
      || typeof record.group_id !== "string" || !record.group_id
      || !Number.isSafeInteger(record.route_generation) || record.route_generation <= 0
    ) {
      invalidState(statePath, `发送记录路由凭据无效：${dedupeKey}`);
    }
    if (
      record.body_sha256 !== undefined
      && record.body_sha256 !== null
      && !SHA256_HEX_PATTERN.test(String(record.body_sha256))
    ) {
      invalidState(statePath, `发送记录 body_sha256 无效：${dedupeKey}`);
    }
  }

  for (const [groupId, timestamps] of Object.entries(value.rateWindows)) {
    if (FORBIDDEN_KEYS.has(groupId) || !Array.isArray(timestamps)) {
      invalidState(statePath, `频控窗口无效：${groupId}`);
    }
    if (timestamps.some((ts) => typeof ts !== "number" || !Number.isFinite(ts))) {
      invalidState(statePath, `频控时间戳无效：${groupId}`);
    }
  }

  let maxObservedGlobalSeq = globalSequence;
  for (const [relayKey, route] of Object.entries(value.routes)) {
    if (FORBIDDEN_KEYS.has(relayKey) || !isPlainObject(route)) {
      invalidState(statePath, `路由保留区无效：${relayKey}`);
    }
    if (route.relay_key !== relayKey || typeof route.group_id !== "string" || !route.group_id) {
      invalidState(statePath, `路由保留区身份无效：${relayKey}`);
    }
    if (!Number.isSafeInteger(route.route_generation) || route.route_generation <= 0) {
      invalidState(statePath, `路由保留区代次无效：${relayKey}`);
    }
    if (route.bootstrap_at !== null && (typeof route.bootstrap_at !== "string" || !Number.isFinite(Date.parse(route.bootstrap_at)))) {
      invalidState(statePath, `路由保留区 bootstrap_at 无效：${relayKey}`);
    }
    if (!Number.isSafeInteger(route.last_sequence) || route.last_sequence < 0) {
      invalidState(statePath, `路由保留区 last_sequence 无效：${relayKey}`);
    }
    if (!Number.isSafeInteger(route.evicted_through) || route.evicted_through < 0 || route.evicted_through > route.last_sequence) {
      invalidState(statePath, `路由保留区 evicted_through 无效：${relayKey}`);
    }
    const evictedGlobal = route.evicted_through_global_sequence ?? 0;
    if (!Number.isSafeInteger(evictedGlobal) || evictedGlobal < 0) {
      invalidState(statePath, `路由保留区 evicted_through_global_sequence 无效：${relayKey}`);
    }
    if (!Array.isArray(route.seen_event_ids) || !Array.isArray(route.events)) {
      invalidState(statePath, `路由保留区 seen_event_ids / events 必须是数组：${relayKey}`);
    }
    if (route.last_history_gap !== null && route.last_history_gap !== undefined && !isPlainObject(route.last_history_gap)) {
      invalidState(statePath, `路由保留区 last_history_gap 无效：${relayKey}`);
    }
    let expectedSeq = route.evicted_through;
    const seenInQueue = new Set();
    for (const event of route.events) {
      validateStoredEvent(event, route, statePath);
      if (event.sequence !== expectedSeq + 1 || event.sequence > route.last_sequence) {
        invalidState(statePath, `路由 ${relayKey} 事件序列不连续`);
      }
      if (seenInQueue.has(event.event_id)) {
        invalidState(statePath, `路由 ${relayKey} 事件队列存在重复 event_id`);
      }
      seenInQueue.add(event.event_id);
      expectedSeq = event.sequence;
      if (event.global_sequence > maxObservedGlobalSeq) {
        maxObservedGlobalSeq = event.global_sequence;
      }
    }
    if (expectedSeq !== route.last_sequence) {
      invalidState(statePath, `路由 ${relayKey} 事件队列末尾与 last_sequence 不一致`);
    }
    if (route.evicted_through_global_sequence === undefined) {
      route.evicted_through_global_sequence = 0;
    }
    if (route.last_history_gap === undefined) {
      route.last_history_gap = null;
    }
    if (!Array.isArray(route.seen_anchor_ids)) {
      route.seen_anchor_ids = [];
    }
  }
  value.globalSequence = maxObservedGlobalSeq;
  return value;
}

function readStateFromDisk(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyState();
    }
    throw new RelayError(
      "RELAY_STATE_READ_FAILED",
      `无法读取中继状态账本：${statePath}`,
      { statePath },
      { cause: error },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new RelayError(
      "RELAY_STATE_INVALID",
      `中继状态账本 JSON 损坏：${statePath}`,
      { statePath },
      { cause: error },
    );
  }
  return validateState(parsed, statePath);
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
    fs.writeFileSync(descriptor, `${JSON.stringify(state)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    renameReplaceSync(temporaryPath, statePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
    }
    throw new RelayError(
      "RELAY_STATE_WRITE_FAILED",
      `无法原子写入中继状态账本：${statePath}`,
      { statePath },
      { cause: error },
    );
  }
}

function unlinkWithTransientRetry(filePath) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.unlinkSync(filePath);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if ((error?.code === "EPERM" || error?.code === "EBUSY") && attempt < 5) {
        sleepSync(10);
        continue;
      }
      return;
    }
  }
}

function acquireStateLock(statePath, waitMs = RELAY_STATE_LIMITS.lockWaitMs, nowProvider = () => new Date()) {
  const lockPath = `${statePath}.lock`;
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    let descriptor;
    let lockCreated = false;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      lockCreated = true;
      const createdAt = resolveNowDate(nowProvider).toISOString();
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({ pid: process.pid, token, createdAt })}\n`,
        "utf8",
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, "utf8").replace(/^\uFEFF/, ""));
          if (current?.token === token) {
            unlinkWithTransientRetry(lockPath);
          }
        } catch {
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
        }
      }
      if (lockCreated) {
        unlinkWithTransientRetry(lockPath);
      }
      if (error?.code !== "EEXIST") {
        throw new RelayError(
          "RELAY_STATE_LOCK_FAILED",
          `无法获取中继状态账本锁：${lockPath}`,
          { lockPath },
          { cause: error },
        );
      }

      let snapshot = "";
      let metadata = null;
      let statMtimeMs = null;
      try {
        statMtimeMs = fs.statSync(lockPath).mtimeMs;
        snapshot = fs.readFileSync(lockPath, "utf8");
        metadata = JSON.parse(snapshot.replace(/^\uFEFF/, ""));
      } catch {
        if (statMtimeMs === null) {
          try {
            statMtimeMs = fs.statSync(lockPath).mtimeMs;
          } catch {
            continue;
          }
        }
      }

      const validPid = metadata !== null
        && typeof metadata === "object"
        && Object.hasOwn(metadata, "pid")
        && Number.isSafeInteger(Number(metadata.pid))
        && Number(metadata.pid) > 0;
      const deadOwner = validPid && !processIsAlive(Number(metadata.pid));
      const staleCorruptLock = !validPid
        && statMtimeMs !== null
        && (Date.now() - statMtimeMs) >= RELAY_STATE_LIMITS.staleEmptyLockGraceMs;

      if (deadOwner || staleCorruptLock) {
        try {
          if (fs.readFileSync(lockPath, "utf8") === snapshot) {
            fs.unlinkSync(lockPath);
          }
          continue;
        } catch (unlinkError) {
          if (unlinkError?.code === "ENOENT") continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new RelayError(
          "RELAY_STATE_LOCK_TIMEOUT",
          `等待中继状态账本锁超时：${lockPath}`,
          { lockPath, owner: metadata },
        );
      }
      sleepSync(10);
    }
  }
}

function publicEventFromStored(event) {
  return {
    event_id: event.event_id,
    sequence: event.sequence,
    relay_key: event.relay_key,
    group_id: event.group_id,
    route_generation: event.route_generation,
    onebot_message_id: event.onebot_message_id ?? null,
    real_seq: event.real_seq ?? null,
    sender_id: event.sender_id,
    source_machine: event.source_machine,
    received_at: event.received_at,
    frame: cloneJson(event.frame),
  };
}

function eventByteLength(event) {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function eventsArrayByteLength(events, perEventBytes = null) {
  if (!events.length) return 0;
  let total = 2 + (events.length - 1);
  if (perEventBytes) {
    for (const size of perEventBytes) total += size;
  } else {
    for (const event of events) total += eventByteLength(event);
  }
  return total;
}

function pruneSendRecords(state, maxSendRecords) {
  const entries = Object.values(state.sends);
  if (entries.length <= maxSendRecords) return;
  const excess = entries.length - maxSendRecords;
  const sorted = [...entries].sort((left, right) => {
    const leftPending = left.status === "pending_send" ? 1 : 0;
    const rightPending = right.status === "pending_send" ? 1 : 0;
    if (leftPending !== rightPending) return leftPending - rightPending;
    const leftUpdated = Date.parse(left.updated_at ?? left.created_at ?? "") || 0;
    const rightUpdated = Date.parse(right.updated_at ?? right.created_at ?? "") || 0;
    if (leftUpdated !== rightUpdated) return leftUpdated - rightUpdated;
    const leftCreated = Date.parse(left.created_at ?? "") || 0;
    const rightCreated = Date.parse(right.created_at ?? "") || 0;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return left.dedupe_key.localeCompare(right.dedupe_key);
  });
  for (const record of sorted.slice(0, excess)) {
    delete state.sends[record.dedupe_key];
  }
}

function applyRateLimitOnState(state, groupId, limit, relayKey, nowMs) {
  const safeGroupId = requireSafeKey(groupId, "group_id", 64);
  const safeLimit = requirePositiveInt(limit, "limit");
  const safeRelayKey = requireSafeKey(relayKey, "relay_key", 128);
  const cutoff = nowMs - RELAY_STATE_LIMITS.rateWindowMs;

  // 顺手清理其它群已全部过期的滑窗，避免空数组堆积
  for (const existingGroupId of Object.keys(state.rateWindows)) {
    if (existingGroupId === safeGroupId) continue;
    const active = state.rateWindows[existingGroupId].filter(
      (ts) => Number.isFinite(ts) && ts > cutoff,
    );
    if (active.length === 0) {
      delete state.rateWindows[existingGroupId];
    } else if (active.length !== state.rateWindows[existingGroupId].length) {
      state.rateWindows[existingGroupId] = active;
    }
  }

  const currentWindow = (Object.hasOwn(state.rateWindows, safeGroupId) ? state.rateWindows[safeGroupId] : [])
    .filter((ts) => Number.isFinite(ts) && ts > cutoff)
    .sort((left, right) => left - right);

  if (currentWindow.length >= safeLimit) {
    const blockingIndex = currentWindow.length - safeLimit;
    const blockingTimestamp = currentWindow[blockingIndex];
    const retryAfterMs = Math.max(1, (blockingTimestamp + RELAY_STATE_LIMITS.rateWindowMs) - nowMs);
    state.rateWindows[safeGroupId] = currentWindow;
    throw new RelayError(
      "RELAY_RATE_LIMITED",
      `中继群 ${safeGroupId}（${safeRelayKey}）超过每分钟 ${safeLimit} 条发送限制`,
      {
        relay_key: safeRelayKey,
        group_id: safeGroupId,
        limit: safeLimit,
        retry_after_ms: retryAfterMs,
      },
    );
  }

  currentWindow.push(nowMs);
  state.rateWindows[safeGroupId] = currentWindow;
  return {
    allowed: true,
    relay_key: safeRelayKey,
    group_id: safeGroupId,
    limit: safeLimit,
    count_in_window: currentWindow.length,
    recorded_timestamp_ms: nowMs,
  };
}

function ensureRouteBucket(state, { relay_key, group_id, route_generation, bootstrap_at = null }) {
  const safeRelayKey = requireSafeKey(relay_key, "relay_key", 128);
  const safeGroupId = requireSafeKey(group_id, "group_id", 64);
  const safeGeneration = requirePositiveInt(route_generation, "route_generation");
  const normalizedBootstrap = bootstrap_at === null || bootstrap_at === undefined
    ? null
    : toIsoTimestamp(bootstrap_at, "bootstrap_at");

  const existing = Object.hasOwn(state.routes, safeRelayKey) ? state.routes[safeRelayKey] : null;
  const scopeChanged = existing !== null
    && (existing.group_id !== safeGroupId || existing.route_generation !== safeGeneration);

  if (!existing || scopeChanged) {
    state.routes[safeRelayKey] = {
      relay_key: safeRelayKey,
      group_id: safeGroupId,
      route_generation: safeGeneration,
      bootstrap_at: normalizedBootstrap,
      last_sequence: 0,
      evicted_through: 0,
      evicted_through_global_sequence: 0,
      seen_event_ids: [],
      seen_anchor_ids: [],
      last_history_gap: null,
      events: [],
    };
  } else {
    if (existing.bootstrap_at === null && normalizedBootstrap !== null) {
      existing.bootstrap_at = normalizedBootstrap;
    }
  }
  return state.routes[safeRelayKey];
}

function enforceBoundedRetention(state, preferredRelayKey, limits) {
  const { maxCacheBytes, maxEventsPerRoute, maxGlobalEvents } = limits;
  const routeEntries = Object.values(state.routes);
  const metrics = new Map();
  let totalEvents = 0;
  let totalBytes = 0;

  for (const route of routeEntries) {
    const sizes = route.events.map((event) => eventByteLength(event));
    const bytes = eventsArrayByteLength(route.events, sizes);
    metrics.set(route.relay_key, { route, sizes, bytes });
    totalEvents += route.events.length;
    totalBytes += bytes;
  }

  function evictOneFrom(entry) {
    const evicted = entry.route.events.shift();
    if (!evicted) return false;
    const evictedSize = entry.sizes.shift();
    const prevBytes = entry.bytes;
    entry.bytes = entry.route.events.length === 0
      ? 0
      : prevBytes - evictedSize - 1;
    totalBytes += entry.bytes - prevBytes;
    totalEvents -= 1;
    entry.route.evicted_through = Math.max(entry.route.evicted_through, evicted.sequence);
    entry.route.evicted_through_global_sequence = Math.max(
      entry.route.evicted_through_global_sequence ?? 0,
      evicted.global_sequence ?? 0,
    );
    return true;
  }

  // 1. 先保证每条路由自身不超过单群条数上限（只影响超限的该路由）
  for (const entry of metrics.values()) {
    while (entry.route.events.length > maxEventsPerRoute) {
      evictOneFrom(entry);
    }
  }

  // 2. 再保证全局总字节 <= maxCacheBytes 且全局总条数 <= maxGlobalEvents。
  //    优先淘汰占用最大（或当前写入且已超公平配额）的路由，绝不因某群洪泛挤压健康小群！
  while (totalBytes > maxCacheBytes || totalEvents > maxGlobalEvents) {
    const nonEmpty = [...metrics.values()].filter((entry) => entry.route.events.length > 0);
    if (!nonEmpty.length) break;

    const overBytes = totalBytes > maxCacheBytes;
    const fairBytes = Math.floor(maxCacheBytes / nonEmpty.length);
    const fairEvents = Math.floor(maxGlobalEvents / nonEmpty.length);
    const preferred = preferredRelayKey ? metrics.get(preferredRelayKey) : null;

    let victim = null;
    if (
      preferred
      && preferred.route.events.length > 0
      && (
        (overBytes && preferred.bytes > fairBytes)
        || (!overBytes && preferred.route.events.length > fairEvents)
      )
    ) {
      victim = preferred;
    }

    if (!victim) {
      nonEmpty.sort((left, right) => {
        if (overBytes) {
          if (right.bytes !== left.bytes) return right.bytes - left.bytes;
          if (right.route.events.length !== left.route.events.length) {
            return right.route.events.length - left.route.events.length;
          }
        } else {
          if (right.route.events.length !== left.route.events.length) {
            return right.route.events.length - left.route.events.length;
          }
          if (right.bytes !== left.bytes) return right.bytes - left.bytes;
        }
        const leftPreferred = left.route.relay_key === preferredRelayKey ? 0 : 1;
        const rightPreferred = right.route.relay_key === preferredRelayKey ? 0 : 1;
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
        return left.route.relay_key.localeCompare(right.route.relay_key);
      });
      victim = nonEmpty[0];
    }

    if (!evictOneFrom(victim)) break;
  }
}

export function encodeRelayCursor({
  local_machine_id,
  expected_self_id,
  scope_key,
  sequence,
  event_id,
  group_id = null,
  route_generation = null,
}) {
  const safeMachine = requireSafeKey(local_machine_id, "local_machine_id", 128);
  const safeSelfId = requireSafeKey(expected_self_id, "expected_self_id", 64);
  const safeScope = requireScopeOrKey(scope_key, "scope_key", 128);
  const safeSequence = requirePositiveInt(sequence, "sequence");
  if (!SHA256_HEX_PATTERN.test(String(event_id ?? ""))) {
    throw new RelayError("RELAY_CURSOR_INVALID", "游标 event_id 无效");
  }
  const safeGroupId = group_id === null || group_id === undefined ? null : requireSafeKey(String(group_id), "group_id", 64);
  const safeGen = route_generation === null || route_generation === undefined ? null : requirePositiveInt(route_generation, "route_generation");
  const tuple = safeGroupId !== null && safeGen !== null
    ? [2, safeMachine, safeSelfId, safeScope, safeSequence, event_id, safeGroupId, safeGen]
    : [1, safeMachine, safeSelfId, safeScope, safeSequence, event_id];
  const encoded = Buffer.from(JSON.stringify(tuple), "utf8").toString("base64url");
  if (encoded.length > RELAY_STATE_LIMITS.maxCursorBytes) {
    throw new RelayError("RELAY_CURSOR_INVALID", "游标长度超出上限", {
      cursor_length: encoded.length,
      max_cursor_bytes: RELAY_STATE_LIMITS.maxCursorBytes,
    });
  }
  return encoded;
}

export function decodeRelayCursor(cursor) {
  if (
    typeof cursor !== "string"
    || !cursor
    || cursor.length > RELAY_STATE_LIMITS.maxCursorBytes
    || !BASE64URL_PATTERN.test(cursor)
  ) {
    throw new RelayError("RELAY_CURSOR_INVALID", "中继事件游标格式无效");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new RelayError("RELAY_CURSOR_INVALID", "中继事件游标无法解码");
  }
  if (!Array.isArray(parsed) || (parsed.length !== 6 && parsed.length !== 8)) {
    throw new RelayError("RELAY_CURSOR_INVALID", "中继事件游标结构无效");
  }
  const [version, machineId, selfId, scopeKey, sequence, eventId, groupId = null, routeGeneration = null] = parsed;
  const validVersion = (version === 1 && parsed.length === 6) || (version === 2 && parsed.length === 8);
  if (
    !validVersion
    || typeof machineId !== "string" || !machineId
    || typeof selfId !== "string" || !selfId
    || typeof scopeKey !== "string" || !scopeKey
    || !Number.isSafeInteger(sequence) || sequence <= 0
    || !SHA256_HEX_PATTERN.test(String(eventId ?? ""))
    || (version === 2 && (typeof groupId !== "string" || !groupId || !Number.isSafeInteger(routeGeneration) || routeGeneration <= 0))
  ) {
    throw new RelayError("RELAY_CURSOR_INVALID", "中继事件游标字段无效");
  }
  return {
    version,
    local_machine_id: machineId,
    expected_self_id: selfId,
    scope_key: scopeKey,
    sequence,
    event_id: eventId,
    group_id: version === 2 ? groupId : null,
    route_generation: version === 2 ? routeGeneration : null,
  };
}

function buildGapDetails(route, affectedOnlyRoute) {
  return {
    relay_key: route.relay_key,
    group_id: route.group_id,
    route_generation: route.route_generation,
    evicted_through: route.evicted_through,
    resume_from_sequence: route.events.length > 0 ? route.events[0].sequence : route.evicted_through + 1,
    affected_only_route: Boolean(affectedOnlyRoute),
  };
}

function buildRetentionSummaryFromState(state, limits) {
  const routesSummary = {};
  let totalCacheBytes = 0;
  let totalRetainedEvents = 0;

  for (const relayKey of Object.keys(state.routes).sort()) {
    const route = state.routes[relayKey];
    const cacheBytes = eventsArrayByteLength(route.events);
    totalCacheBytes += cacheBytes;
    totalRetainedEvents += route.events.length;
    routesSummary[relayKey] = {
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.route_generation,
      bootstrap_at: route.bootstrap_at,
      first_sequence: route.events[0]?.sequence ?? null,
      last_sequence: route.last_sequence,
      evicted_through: route.evicted_through,
      retained_count: route.events.length,
      cache_bytes: cacheBytes,
      has_history_gap: route.last_history_gap !== null,
    };
  }

  return {
    max_cache_bytes: limits.maxCacheBytes,
    total_cache_bytes: totalCacheBytes,
    max_global_events: limits.maxGlobalEvents,
    max_events_per_route: limits.maxEventsPerRoute,
    total_retained_events: totalRetainedEvents,
    send_record_count: Object.keys(state.sends).length,
    max_send_records: limits.maxSendRecords,
    routes: routesSummary,
  };
}

function reserveOrCheckSendOnState(state, input, options) {
  if (!isPlainObject(input)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "reserveOrCheckSend 参数必须是对象");
  }
  const dedupeKey = requireSafeKey(input.dedupe_key, "dedupe_key", 200);
  const fingerprintSha256 = String(input.fingerprint_sha256 ?? "");
  if (!SHA256_HEX_PATTERN.test(fingerprintSha256)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "fingerprint_sha256 必须是 64 位小写 hex");
  }

  if (Object.hasOwn(state.sends, dedupeKey)) {
    const existing = state.sends[dedupeKey];
    if (existing.fingerprint_sha256 !== fingerprintSha256) {
      throw new RelayError(
        "RELAY_DEDUPE_CONFLICT",
        `dedupe_key 已被用于不同的中继消息参数或正文：${dedupeKey}`,
        {
          dedupe_key: dedupeKey,
          existing_relay_id: existing.relay_id,
          existing_relay_key: existing.relay_key,
          existing_group_id: existing.group_id,
          existing_status: existing.status,
        },
      );
    }
    return {
      changed: false,
      duplicate: true,
      record: cloneJson(existing),
      rate_timestamp_ms: null,
    };
  }

  const relayId = requireSafeKey(input.relay_id, "relay_id", 128);
  const relayKey = requireSafeKey(input.relay_key, "relay_key", 128);
  const groupId = requireSafeKey(input.group_id, "group_id", 64);
  const routeGeneration = requirePositiveInt(input.route_generation, "route_generation");
  const frameLength = requireNonNegativeInt(input.frame_length, "frame_length");
  let bodySha256 = null;
  if (input.body_sha256 !== undefined && input.body_sha256 !== null) {
    const rawBodySha = String(input.body_sha256);
    if (!SHA256_HEX_PATTERN.test(rawBodySha)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "body_sha256 必须是 64 位小写 hex");
    }
    bodySha256 = rawBodySha;
  }
  const nowDate = resolveNowDate(options.now, input.now);
  const nowIso = nowDate.toISOString();

  let rateTimestampMs = null;
  if (input.rate_limit !== undefined && input.rate_limit !== null) {
    if (!isPlainObject(input.rate_limit)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "rate_limit 必须是对象");
    }
    const rateResult = applyRateLimitOnState(
      state,
      input.rate_limit.group_id ?? groupId,
      input.rate_limit.limit,
      input.rate_limit.relay_key ?? relayKey,
      nowDate.getTime(),
    );
    rateTimestampMs = rateResult.recorded_timestamp_ms;
  }

  const record = {
    dedupe_key: dedupeKey,
    fingerprint_sha256: fingerprintSha256,
    body_sha256: bodySha256,
    status: "pending_send",
    relay_id: relayId,
    relay_key: relayKey,
    group_id: groupId,
    route_generation: routeGeneration,
    onebot_message_id: null,
    real_seq: null,
    frame_length: frameLength,
    outcome_unknown: true,
    created_at: nowIso,
    updated_at: nowIso,
  };
  state.sends[dedupeKey] = record;
  pruneSendRecords(state, options.maxSendRecords);
  return {
    changed: true,
    duplicate: false,
    record: cloneJson(record),
    rate_timestamp_ms: rateTimestampMs,
  };
}

function abortPendingSendOnState(state, input) {
  if (!isPlainObject(input)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "abortPendingSend 参数必须是对象");
  }
  const dedupeKey = requireSafeKey(input.dedupe_key, "dedupe_key", 200);
  const relayId = requireSafeKey(input.relay_id, "relay_id", 128);
  if (!Object.hasOwn(state.sends, dedupeKey)) {
    return { changed: false, removed: false };
  }
  const existing = state.sends[dedupeKey];
  if (existing.relay_id !== relayId || existing.status !== "pending_send") {
    return { changed: false, removed: false };
  }
  const groupId = existing.group_id;
  delete state.sends[dedupeKey];

  if (
    typeof input.rate_timestamp_ms === "number"
    && Number.isFinite(input.rate_timestamp_ms)
    && Object.hasOwn(state.rateWindows, groupId)
  ) {
    const timestamps = state.rateWindows[groupId];
    const index = timestamps.lastIndexOf(input.rate_timestamp_ms);
    if (index >= 0) {
      timestamps.splice(index, 1);
      if (timestamps.length === 0) delete state.rateWindows[groupId];
    }
  }
  return { changed: true, removed: true };
}

function finalizeSendOnState(state, input, options) {
  if (!isPlainObject(input)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "finalizeSend 参数必须是对象");
  }
  const dedupeKey = requireSafeKey(input.dedupe_key, "dedupe_key", 200);
  if (!Object.hasOwn(state.sends, dedupeKey)) {
    throw new RelayError("RELAY_SEND_RECORD_NOT_FOUND", `未找到待完结的发送记录：${dedupeKey}`, {
      dedupe_key: dedupeKey,
    });
  }
  const existing = state.sends[dedupeKey];
  const status = String(input.status ?? "");
  if (status !== "sent_unverified" && status !== "sent_verified") {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "finalizeSend.status 只能是 sent_unverified 或 sent_verified", {
      status,
    });
  }
  const nowIso = resolveNowDate(options.now, input.now).toISOString();

  if (input.onebot_message_id !== undefined) {
    existing.onebot_message_id = input.onebot_message_id === null
      ? null
      : requireSafeKey(String(input.onebot_message_id), "onebot_message_id", 128);
  }
  if (input.real_seq !== undefined) {
    if (input.real_seq === null) {
      existing.real_seq = null;
    } else if (Number.isSafeInteger(input.real_seq) && input.real_seq >= 0) {
      existing.real_seq = input.real_seq;
    } else {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "real_seq 必须是非负安全整数或 null");
    }
  }
  if (input.frame_length !== undefined) {
    existing.frame_length = requireNonNegativeInt(input.frame_length, "frame_length");
  }
  if (input.body_sha256 !== undefined) {
    if (input.body_sha256 === null) {
      existing.body_sha256 = null;
    } else if (SHA256_HEX_PATTERN.test(String(input.body_sha256))) {
      existing.body_sha256 = String(input.body_sha256);
    } else {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "body_sha256 必须是 64 位小写 hex 或 null");
    }
  }
  if (input.before_real_seq !== undefined) {
    if (input.before_real_seq === null) {
      existing.before_real_seq = null;
    } else if (Number.isSafeInteger(input.before_real_seq) && input.before_real_seq >= 0) {
      existing.before_real_seq = input.before_real_seq;
    } else {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "before_real_seq 必须是非负安全整数或 null");
    }
  }
  if (input.before_empty_history !== undefined) {
    existing.before_empty_history = Boolean(input.before_empty_history);
  }

  existing.status = status;
  existing.outcome_unknown = input.outcome_unknown !== undefined
    ? Boolean(input.outcome_unknown)
    : status !== "sent_verified";
  existing.updated_at = nowIso;
  pruneSendRecords(state, options.maxSendRecords);
  return {
    changed: true,
    record: cloneJson(existing),
  };
}

function ingestRouteEventsOnState(state, input, options) {
  if (!isPlainObject(input)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "ingestRouteEvents 参数必须是对象");
  }
  const safeKey = requireSafeKey(input.relay_key, "relay_key", 128);
  const previousRoute = Object.hasOwn(state.routes, safeKey) ? state.routes[safeKey] : null;
  const previousGroupId = previousRoute?.group_id ?? null;
  const previousGeneration = previousRoute?.route_generation ?? null;
  const previousBootstrapAt = previousRoute?.bootstrap_at ?? null;

  const route = ensureRouteBucket(state, {
    relay_key: input.relay_key,
    group_id: input.group_id,
    route_generation: input.route_generation,
    bootstrap_at: input.bootstrap_at,
  });

  const eventsInput = Array.isArray(input.events) ? input.events : [];
  const seenSet = new Set(route.seen_event_ids);
  for (const existing of route.events) {
    seenSet.add(existing.event_id);
  }

  const maxSeenIds = Math.max(options.maxEventsPerRoute, 2000);
  const ingested = [];
  let duplicateCount = 0;
  let changed = !previousRoute
    || route.group_id !== previousGroupId
    || route.route_generation !== previousGeneration
    || route.bootstrap_at !== previousBootstrapAt;

  if (input.clear_history_gap === true && route.last_history_gap !== null) {
    route.last_history_gap = null;
    changed = true;
  }

  for (const item of eventsInput) {
    if (!isPlainObject(item)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "入站事件条目必须是对象");
    }
    const eventId = String(item.event_id ?? "");
    if (!SHA256_HEX_PATTERN.test(eventId)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "入站事件 event_id 必须是 64 位小写 hex");
    }
    if (seenSet.has(eventId)) {
      duplicateCount += 1;
      continue;
    }

    const senderId = requireSafeKey(String(item.sender_id ?? ""), "sender_id", 64);
    const sourceMachine = requireSafeKey(String(item.source_machine ?? ""), "source_machine", 128);
    const receivedAt = toIsoTimestamp(item.received_at ?? resolveNowDate(options.now), "received_at");
    if (!isPlainObject(item.frame)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "入站事件缺少 frame 对象");
    }

    const nextSeq = route.last_sequence + 1;
    const nextGlobalSeq = state.globalSequence + 1;
    const storedEvent = {
      event_id: eventId,
      sequence: nextSeq,
      global_sequence: nextGlobalSeq,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.route_generation,
      onebot_message_id: item.onebot_message_id !== undefined && item.onebot_message_id !== null
        ? String(item.onebot_message_id)
        : null,
      real_seq: Number.isSafeInteger(item.real_seq) && item.real_seq >= 0 ? item.real_seq : null,
      sender_id: senderId,
      source_machine: sourceMachine,
      received_at: receivedAt,
      frame: cloneJson(item.frame),
    };

    route.last_sequence = nextSeq;
    state.globalSequence = nextGlobalSeq;
    seenSet.add(eventId);
    route.seen_event_ids.push(eventId);
    if (route.seen_event_ids.length > maxSeenIds) {
      route.seen_event_ids.splice(0, route.seen_event_ids.length - maxSeenIds);
    }

    // 单条事件本身超过整个全局缓存封顶时，先清空队列更早残留事件再推进淘汰水位，严保连续性不变量
    if (eventByteLength(storedEvent) + 2 > options.maxCacheBytes) {
      let maxClearedGlobal = route.evicted_through_global_sequence ?? 0;
      for (const oldEvent of route.events) {
        if ((oldEvent.global_sequence ?? 0) > maxClearedGlobal) {
          maxClearedGlobal = oldEvent.global_sequence;
        }
      }
      route.events.length = 0;
      route.evicted_through = Math.max(route.evicted_through, storedEvent.sequence);
      route.evicted_through_global_sequence = Math.max(maxClearedGlobal, storedEvent.global_sequence);
    } else {
      route.events.push(storedEvent);
    }
    ingested.push(publicEventFromStored(storedEvent));
    changed = true;
  }

  if (Array.isArray(input.scanned_anchor_ids) && input.scanned_anchor_ids.length > 0) {
    const anchorSet = new Set(route.seen_anchor_ids);
    for (const rawId of input.scanned_anchor_ids) {
      const id = String(rawId ?? "").trim();
      if (!id || id.length > 128 || CONTROL_CHAR_PATTERN.test(id)) continue;
      if (!anchorSet.has(id)) {
        anchorSet.add(id);
        route.seen_anchor_ids.push(id);
        changed = true;
      }
    }
    if (route.seen_anchor_ids.length > 200) {
      route.seen_anchor_ids.splice(0, route.seen_anchor_ids.length - 200);
    }
  }

  if (changed) {
    enforceBoundedRetention(state, route.relay_key, options);
  }

  return {
    changed,
    ingested_count: ingested.length,
    duplicate_count: duplicateCount,
    events: ingested,
    retention: buildRetentionSummaryFromState(state, options),
  };
}

function recordRouteHistoryGapOnState(state, input, options) {
  if (!isPlainObject(input)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "recordRouteHistoryGap 参数必须是对象");
  }
  const route = ensureRouteBucket(state, {
    relay_key: input.relay_key,
    group_id: input.group_id,
    route_generation: input.route_generation,
    bootstrap_at: input.bootstrap_at,
  });
  const detectedAt = resolveNowDate(options.now, input.detected_at).toISOString();
  const resumeFromSequence = route.events.length > 0
    ? route.events[0].sequence
    : route.last_sequence + 1;

  const gap = {
    code: "RELAY_HISTORY_GAP",
    relay_key: route.relay_key,
    group_id: route.group_id,
    route_generation: route.route_generation,
    evicted_through: route.evicted_through,
    gap_at_sequence: route.last_sequence,
    resume_from_sequence: resumeFromSequence,
    affected_only_route: true,
    pages_scanned: Number.isSafeInteger(input.pages_scanned) ? input.pages_scanned : null,
    max_pages: Number.isSafeInteger(input.max_pages) ? input.max_pages : null,
    oldest_seen_at: input.oldest_seen_at ?? null,
    bootstrap_at: route.bootstrap_at,
    reason: typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim()
      : "max_pages_reached_before_baseline_or_anchor",
    detected_at: detectedAt,
  };
  route.last_history_gap = gap;
  return {
    changed: true,
    gap: cloneJson(gap),
  };
}

function readEventsFromState(state, input, options) {
  if (!isPlainObject(input)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "readEvents 参数必须是对象");
  }
  const localMachineId = requireSafeKey(input.local_machine_id, "local_machine_id", 128);
  const expectedSelfId = requireSafeKey(input.expected_self_id, "expected_self_id", 64);
  const singleRelayKey = input.relay_key === undefined || input.relay_key === null
    ? null
    : requireSafeKey(input.relay_key, "relay_key", 128);
  const scopeKey = singleRelayKey ?? "*";
  const limit = input.limit === undefined || input.limit === null
    ? RELAY_STATE_LIMITS.maxReadLimit
    : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RELAY_STATE_LIMITS.maxReadLimit) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `limit 必须是 1 至 ${RELAY_STATE_LIMITS.maxReadLimit} 的安全整数`, {
      field: "limit",
    });
  }

  const resumeFromRetained = input.resume_from_retained === true;
  if (input.resume_from_retained !== undefined && typeof input.resume_from_retained !== "boolean") {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "resume_from_retained 必须是布尔值", {
      field: "resume_from_retained",
    });
  }

  let decodedCursor = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    decodedCursor = decodeRelayCursor(input.cursor);
    if (
      decodedCursor.local_machine_id !== localMachineId
      || decodedCursor.expected_self_id !== expectedSelfId
      || decodedCursor.scope_key !== scopeKey
    ) {
      throw new RelayError(
        "RELAY_CURSOR_SCOPE_MISMATCH",
        "中继事件游标与当前机器、账号或路由作用域不匹配",
        {
          expected_scope: {
            local_machine_id: localMachineId,
            expected_self_id: expectedSelfId,
            scope_key: scopeKey,
          },
          cursor_scope: {
            local_machine_id: decodedCursor.local_machine_id,
            expected_self_id: decodedCursor.expected_self_id,
            scope_key: decodedCursor.scope_key,
          },
        },
      );
    }
  }

  const retention = buildRetentionSummaryFromState(state, options);

  // 分支 1：单群独立视图（绝不受其它路由断档影响！）
  if (singleRelayKey !== null) {
    const route = Object.hasOwn(state.routes, singleRelayKey) ? state.routes[singleRelayKey] : null;
    const expectedGroupId = typeof input.expected_group_id === "string" && input.expected_group_id.trim()
      ? input.expected_group_id.trim()
      : null;
    const expectedRouteGeneration = Number.isSafeInteger(input.expected_route_generation) && input.expected_route_generation > 0
      ? input.expected_route_generation
      : null;

    if (!route) {
      if (decodedCursor && !resumeFromRetained) {
        throw new RelayError(
          "RELAY_CURSOR_EXPIRED",
          `路由 ${singleRelayKey} 的游标锚点不存在或已过期`,
          {
            relay_key: singleRelayKey,
            group_id: expectedGroupId,
            route_generation: expectedRouteGeneration,
            evicted_through: 0,
            resume_from_sequence: 1,
            affected_only_route: true,
          },
        );
      }
      return {
        events: [],
        next_cursor: null,
        has_more: false,
        retention,
        route_gaps: [],
      };
    }

    const bucketMismatch = (expectedGroupId !== null && route.group_id !== expectedGroupId)
      || (expectedRouteGeneration !== null && route.route_generation !== expectedRouteGeneration);
    if (bucketMismatch) {
      if (decodedCursor) {
        throw new RelayError(
          "RELAY_CURSOR_SCOPE_MISMATCH",
          `路由 ${route.relay_key} 的群号或代次已变化，旧游标已失效`,
          {
            relay_key: route.relay_key,
            expected_group_id: expectedGroupId ?? route.group_id,
            expected_route_generation: expectedRouteGeneration ?? route.route_generation,
            stored_group_id: route.group_id,
            stored_route_generation: route.route_generation,
          },
        );
      }
      return {
        events: [],
        next_cursor: null,
        has_more: false,
        retention,
        route_gaps: [],
      };
    }

    if (
      decodedCursor
      && decodedCursor.version === 2
      && (decodedCursor.group_id !== route.group_id || decodedCursor.route_generation !== route.route_generation)
    ) {
      throw new RelayError(
        "RELAY_CURSOR_SCOPE_MISMATCH",
        `路由 ${route.relay_key} 的游标群号或代次已变化`,
        {
          relay_key: route.relay_key,
          expected_group_id: route.group_id,
          expected_route_generation: route.route_generation,
          cursor_group_id: decodedCursor.group_id,
          cursor_route_generation: decodedCursor.route_generation,
        },
      );
    }

    let startIndex = 0;
    if (decodedCursor) {
      const anchorIndex = route.events.findIndex(
        (event) => event.sequence === decodedCursor.sequence && event.event_id === decodedCursor.event_id,
      );
      if (anchorIndex < 0) {
        if (!resumeFromRetained) {
          throw new RelayError(
            "RELAY_CURSOR_EXPIRED",
            `路由 ${route.relay_key} 的游标锚点已不在保留范围`,
            buildGapDetails(route, true),
          );
        }
        startIndex = 0;
      } else {
        startIndex = anchorIndex + 1;
      }
    } else if (route.evicted_through > 0 && !resumeFromRetained) {
      throw new RelayError(
        "RELAY_HISTORY_EXPIRED",
        `路由 ${route.relay_key} 的早期事件已被淘汰，首次全量读取出现历史断档`,
        buildGapDetails(route, true),
      );
    }

    const selected = route.events.slice(startIndex, startIndex + limit);
    const last = selected.at(-1);
    const nextCursor = last
      ? encodeRelayCursor({
        local_machine_id: localMachineId,
        expected_self_id: expectedSelfId,
        scope_key: scopeKey,
        sequence: last.sequence,
        event_id: last.event_id,
        group_id: route.group_id,
        route_generation: route.route_generation,
      })
      : (resumeFromRetained ? null : (input.cursor ?? null));

    const gapVisible = !resumeFromRetained
      && route.last_history_gap !== null
      && (!decodedCursor || (route.last_history_gap.gap_at_sequence ?? route.last_sequence) > decodedCursor.sequence);

    return {
      events: selected.map(publicEventFromStored),
      next_cursor: nextCursor,
      has_more: startIndex + selected.length < route.events.length,
      retention,
      route_gaps: gapVisible ? [cloneJson(route.last_history_gap)] : [],
    };
  }

  // 分支 2：全局聚合视图（scope_key === "*"）
  const sortedRoutes = Object.keys(state.routes)
    .sort()
    .map((key) => state.routes[key]);
  const evictedRoutes = sortedRoutes.filter((route) => route.evicted_through > 0);
  const allEvents = sortedRoutes
    .flatMap((route) => route.events)
    .sort((left, right) => {
      if (left.global_sequence !== right.global_sequence) {
        return left.global_sequence - right.global_sequence;
      }
      return left.relay_key.localeCompare(right.relay_key);
    });

  let startIndex = 0;
  if (decodedCursor) {
    const anchorIndex = allEvents.findIndex(
      (event) => event.global_sequence === decodedCursor.sequence && event.event_id === decodedCursor.event_id,
    );
    if (anchorIndex < 0) {
      if (!resumeFromRetained) {
        const affected = evictedRoutes[0] ?? sortedRoutes[0] ?? null;
        const details = affected
          ? buildGapDetails(affected, evictedRoutes.length <= 1)
          : {
            relay_key: "*",
            group_id: null,
            route_generation: null,
            evicted_through: 0,
            resume_from_sequence: 1,
            affected_only_route: false,
          };
        throw new RelayError(
          "RELAY_CURSOR_EXPIRED",
          "全局中继事件游标锚点已不在保留范围",
          details,
        );
      }
      startIndex = 0;
    } else {
      const evictedAfterAnchor = evictedRoutes.filter(
        (route) => (route.evicted_through_global_sequence ?? 0) > decodedCursor.sequence,
      );
      if (evictedAfterAnchor.length > 0 && !resumeFromRetained) {
        const affected = evictedAfterAnchor[0];
        throw new RelayError(
          "RELAY_HISTORY_EXPIRED",
          `路由 ${affected.relay_key} 在当前游标之后发生事件淘汰，全局视图出现历史断档（其它健康路由仍可按 relay_key 独立读取）`,
          buildGapDetails(affected, evictedAfterAnchor.length === 1),
        );
      }
      startIndex = anchorIndex + 1;
    }
  } else if (evictedRoutes.length > 0 && !resumeFromRetained) {
    const affected = evictedRoutes[0];
    throw new RelayError(
      "RELAY_HISTORY_EXPIRED",
      `路由 ${affected.relay_key} 的早期事件已被淘汰，全局首次读取出现历史断档（其它健康路由仍可按 relay_key 独立读取）`,
      buildGapDetails(affected, evictedRoutes.length === 1),
    );
  }

  const selected = allEvents.slice(startIndex, startIndex + limit);
  const last = selected.at(-1);
  const nextCursor = last
    ? encodeRelayCursor({
      local_machine_id: localMachineId,
      expected_self_id: expectedSelfId,
      scope_key: "*",
      sequence: last.global_sequence,
      event_id: last.event_id,
    })
    : (resumeFromRetained ? null : (input.cursor ?? null));

  const routeGaps = sortedRoutes
    .filter((route) => route.last_history_gap !== null)
    .map((route) => cloneJson(route.last_history_gap));

  return {
    events: selected.map(publicEventFromStored),
    next_cursor: nextCursor,
    has_more: startIndex + selected.length < allEvents.length,
    retention,
    route_gaps: routeGaps,
  };
}

export function createRelayStateStore({
  statePath,
  maxCacheBytes = RELAY_STATE_LIMITS.maxCacheBytes,
  maxEventsPerRoute = RELAY_STATE_LIMITS.maxEventsPerRoute,
  maxGlobalEvents = RELAY_STATE_LIMITS.maxGlobalEvents,
  maxSendRecords = RELAY_STATE_LIMITS.maxSendRecords,
  lockWaitMs = RELAY_STATE_LIMITS.lockWaitMs,
  now = () => new Date(),
} = {}) {
  if (typeof statePath !== "string" || !statePath.trim()) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "statePath 必须是非空文件路径", { field: "statePath" });
  }
  const resolvedStatePath = path.resolve(statePath);
  const limits = {
    maxCacheBytes: requirePositiveInt(maxCacheBytes, "maxCacheBytes"),
    maxEventsPerRoute: requirePositiveInt(maxEventsPerRoute, "maxEventsPerRoute"),
    maxGlobalEvents: requirePositiveInt(maxGlobalEvents, "maxGlobalEvents"),
    maxSendRecords: requirePositiveInt(maxSendRecords, "maxSendRecords"),
    lockWaitMs: requirePositiveInt(lockWaitMs, "lockWaitMs"),
    now: typeof now === "function" ? now : () => now,
  };

  function withExclusiveLock(callback) {
    const release = acquireStateLock(resolvedStatePath, limits.lockWaitMs, limits.now);
    try {
      const state = readStateFromDisk(resolvedStatePath);
      const outcome = callback(state);
      if (outcome?.persist) {
        atomicWriteState(resolvedStatePath, state);
      }
      return outcome?.value;
    } finally {
      release();
    }
  }

  function readLocked(callback) {
    const release = acquireStateLock(resolvedStatePath, limits.lockWaitMs, limits.now);
    try {
      const state = readStateFromDisk(resolvedStatePath);
      return callback(state);
    } finally {
      release();
    }
  }

  function resolveEffectiveLimits(overrideLimits) {
    if (!isPlainObject(overrideLimits)) return limits;
    return {
      ...limits,
      maxCacheBytes: Number.isSafeInteger(overrideLimits.maxCacheBytes) && overrideLimits.maxCacheBytes > 0
        ? Math.min(limits.maxCacheBytes, overrideLimits.maxCacheBytes)
        : limits.maxCacheBytes,
      maxEventsPerRoute: Number.isSafeInteger(overrideLimits.maxEventsPerRoute) && overrideLimits.maxEventsPerRoute > 0
        ? Math.min(limits.maxEventsPerRoute, overrideLimits.maxEventsPerRoute)
        : limits.maxEventsPerRoute,
      maxGlobalEvents: Number.isSafeInteger(overrideLimits.maxGlobalEvents) && overrideLimits.maxGlobalEvents > 0
        ? Math.min(limits.maxGlobalEvents, overrideLimits.maxGlobalEvents)
        : limits.maxGlobalEvents,
      maxSendRecords: Number.isSafeInteger(overrideLimits.maxSendRecords) && overrideLimits.maxSendRecords > 0
        ? Math.min(limits.maxSendRecords, overrideLimits.maxSendRecords)
        : limits.maxSendRecords,
    };
  }

  return {
    statePath: resolvedStatePath,
    limits: Object.freeze({
      maxCacheBytes: limits.maxCacheBytes,
      maxEventsPerRoute: limits.maxEventsPerRoute,
      maxGlobalEvents: limits.maxGlobalEvents,
      maxSendRecords: limits.maxSendRecords,
    }),

    checkAndRecordRateLimit(groupId, limit, relayKey, overrideNow) {
      return withExclusiveLock((state) => {
        const nowMs = resolveNowDate(limits.now, overrideNow).getTime();
        const result = applyRateLimitOnState(state, groupId, limit, relayKey, nowMs);
        return { persist: true, value: result };
      });
    },

    reserveOrCheckSend(input) {
      return withExclusiveLock((state) => {
        const effective = resolveEffectiveLimits(input?.limits);
        const result = reserveOrCheckSendOnState(state, input, effective);
        return { persist: result.changed, value: result };
      });
    },

    abortPendingSend(input) {
      return withExclusiveLock((state) => {
        const result = abortPendingSendOnState(state, input);
        return { persist: result.changed, value: result };
      });
    },

    finalizeSend(input) {
      return withExclusiveLock((state) => {
        const effective = resolveEffectiveLimits(input?.limits);
        const result = finalizeSendOnState(state, input, effective);
        return { persist: result.changed, value: result.record };
      });
    },

    ingestRouteEvents(input) {
      return withExclusiveLock((state) => {
        const effective = resolveEffectiveLimits(input?.limits);
        const result = ingestRouteEventsOnState(state, input, effective);
        return { persist: result.changed, value: result };
      });
    },

    recordRouteHistoryGap(input) {
      return withExclusiveLock((state) => {
        const result = recordRouteHistoryGapOnState(state, input, limits);
        return { persist: result.changed, value: result.gap };
      });
    },

    readEvents(input) {
      return readLocked((state) => {
        const effective = resolveEffectiveLimits(input?.limits);
        return readEventsFromState(state, input, effective);
      });
    },

    getRetentionSummary(overrideLimits) {
      return readLocked((state) => buildRetentionSummaryFromState(state, resolveEffectiveLimits(overrideLimits)));
    },

    getRouteSnapshot(relayKey) {
      const safeRelayKey = requireSafeKey(relayKey, "relay_key", 128);
      return readLocked((state) => {
        if (!Object.hasOwn(state.routes, safeRelayKey)) return null;
        const route = state.routes[safeRelayKey];
        return {
          relay_key: route.relay_key,
          group_id: route.group_id,
          route_generation: route.route_generation,
          bootstrap_at: route.bootstrap_at,
          last_sequence: route.last_sequence,
          evicted_through: route.evicted_through,
          seen_event_ids: route.seen_event_ids.slice(),
          seen_anchor_ids: route.seen_anchor_ids.slice(),
          last_history_gap: cloneJson(route.last_history_gap),
          retained_count: route.events.length,
        };
      });
    },

    getSendRecord(dedupeKey) {
      const safeKey = requireSafeKey(dedupeKey, "dedupe_key", 200);
      return readLocked((state) => (
        Object.hasOwn(state.sends, safeKey) ? cloneJson(state.sends[safeKey]) : null
      ));
    },
  };
}

// 具名导出辅助方法：支持传入 store 实例或独立状态对象
export function reserveOrCheckSend(storeOrState, input, options = {}) {
  if (typeof storeOrState?.reserveOrCheckSend === "function") {
    return storeOrState.reserveOrCheckSend(input);
  }
  return reserveOrCheckSendOnState(storeOrState, input, {
    maxSendRecords: options.maxSendRecords ?? RELAY_STATE_LIMITS.maxSendRecords,
    now: typeof options.now === "function" ? options.now : () => new Date(),
  });
}

export function finalizeSend(storeOrState, input, options = {}) {
  if (typeof storeOrState?.finalizeSend === "function") {
    return storeOrState.finalizeSend(input);
  }
  return finalizeSendOnState(storeOrState, input, {
    maxSendRecords: options.maxSendRecords ?? RELAY_STATE_LIMITS.maxSendRecords,
    now: typeof options.now === "function" ? options.now : () => new Date(),
  }).record;
}

export function checkAndRecordRateLimit(storeOrState, groupId, limit, relayKey, overrideNow) {
  if (typeof storeOrState?.checkAndRecordRateLimit === "function") {
    return storeOrState.checkAndRecordRateLimit(groupId, limit, relayKey, overrideNow);
  }
  const nowMs = resolveNowDate(() => new Date(), overrideNow).getTime();
  return applyRateLimitOnState(storeOrState, groupId, limit, relayKey, nowMs);
}

export function ingestRouteEvents(storeOrState, input, options = {}) {
  if (typeof storeOrState?.ingestRouteEvents === "function") {
    return storeOrState.ingestRouteEvents(input);
  }
  return ingestRouteEventsOnState(storeOrState, input, {
    maxCacheBytes: options.maxCacheBytes ?? RELAY_STATE_LIMITS.maxCacheBytes,
    maxEventsPerRoute: options.maxEventsPerRoute ?? RELAY_STATE_LIMITS.maxEventsPerRoute,
    maxGlobalEvents: options.maxGlobalEvents ?? RELAY_STATE_LIMITS.maxGlobalEvents,
    maxSendRecords: options.maxSendRecords ?? RELAY_STATE_LIMITS.maxSendRecords,
    now: typeof options.now === "function" ? options.now : () => new Date(),
  });
}

export function recordRouteHistoryGap(storeOrState, input, options = {}) {
  if (typeof storeOrState?.recordRouteHistoryGap === "function") {
    return storeOrState.recordRouteHistoryGap(input);
  }
  return recordRouteHistoryGapOnState(storeOrState, input, {
    now: typeof options.now === "function" ? options.now : () => new Date(),
  }).gap;
}

export function getRetentionSummary(storeOrState, options = {}) {
  if (typeof storeOrState?.getRetentionSummary === "function") {
    return storeOrState.getRetentionSummary();
  }
  return buildRetentionSummaryFromState(storeOrState, {
    maxCacheBytes: options.maxCacheBytes ?? RELAY_STATE_LIMITS.maxCacheBytes,
    maxEventsPerRoute: options.maxEventsPerRoute ?? RELAY_STATE_LIMITS.maxEventsPerRoute,
    maxGlobalEvents: options.maxGlobalEvents ?? RELAY_STATE_LIMITS.maxGlobalEvents,
    maxSendRecords: options.maxSendRecords ?? RELAY_STATE_LIMITS.maxSendRecords,
  });
}
