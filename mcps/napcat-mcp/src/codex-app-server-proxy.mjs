import crypto from "node:crypto";
import { createProxyLiveCodeRuntime } from "./proxy-live-code-runtime.mjs";
import { createOuterRuntime } from "./outer-runtime.mjs";
import { createOuterRuntimeHost } from "./outer-runtime-host.mjs";
import { createRecoveryNotificationRouter } from "./model-recovery-notifications.mjs";
import { CodexAppServerProxyError } from "./outer-runtime-contract.mjs";
export { CodexAppServerProxyError } from "./outer-runtime-contract.mjs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createWakeVisibilityAdapter } from "./wake-visibility.mjs";
import { createReasoningPlaceholderView } from "./reasoning-placeholder.mjs";
import { createTurnLifecycleObserver } from "./turn-observability.mjs";
import { createCodexDisplayPolicyManager, createCodexDisplayPolicyControl } from "./codex-display-policy.mjs";
import { createCodexRequestMetadata } from "./codex-request-metadata.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const FIRST_INJECTED_REQUEST_ID = -1_000_000_000;
const DEFAULT_RESUME_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_JSON_PARSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 60000;
const MAX_RPC_ENVELOPE_DEPTH = 128;
const MAX_RPC_ENVELOPE_FIELDS = 128;
const MAX_RPC_ENVELOPE_VALUE_BYTES = 64 * 1024;

export const DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES = 96 * 1024 * 1024;
export const DESKTOP_RESPONSE_BUDGET_ERROR_CODE = -32010;
const HISTORY_METHODS = new Set(["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]);
const NATIVE_TURN_START_METHODS = new Set(["turn/start", "thread/compact/start"]);

export function createDesktopResponseBudgetError({ requestId, method, responseBytes,
  limit = DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES } = {}) {
  const validRequestId = typeof requestId === "string" || (typeof requestId === "number" && Number.isFinite(requestId));
  if (!validRequestId || !HISTORY_METHODS.has(method)) return null;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Desktop response limit must be a positive safe integer");
  if (!Number.isSafeInteger(responseBytes) || responseBytes < 0 || responseBytes <= limit) return null;
  return { id: requestId, error: { code: DESKTOP_RESPONSE_BUDGET_ERROR_CODE,
    message: "历史响应超过 Desktop 安全预算，请分页读取",
    data: { reason: "DESKTOP_RESPONSE_BUDGET_EXCEEDED", method, bytes: responseBytes, limit,
      retrySameRequest: false, upstreamStateMayHaveChanged: method === "thread/resume",
      pagination: { summaryMethod: "thread/read", includeTurns: false, turnsMethod: "thread/turns/list",
        itemsMethod: "thread/items/list", itemsView: "notLoaded", useCursor: true },
      hint: method === "thread/resume"
        ? "恢复请求可能已完成，请先核对线程状态，再用原 threadId 和 nextCursor 分页读取历史"
        : "使用原 threadId，先读取摘要，再用 nextCursor 分页读取回合与条目" } } };
}

export function createDesktopTransportBudgetError({ requestId, method, responseBytes,
  limit = DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES } = {}) {
  const validRequestId = typeof requestId === "string" || (typeof requestId === "number" && Number.isFinite(requestId));
  if (!validRequestId || typeof method !== "string") return null;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Desktop transport limit must be a positive safe integer");
  if (!Number.isSafeInteger(responseBytes) || responseBytes <= limit) return null;
  const historyError = createDesktopResponseBudgetError({ requestId, method, responseBytes, limit });
  if (historyError) {
    historyError.error.data.reason = "DESKTOP_TRANSPORT_BUDGET_EXCEEDED";
    return historyError;
  }
  return { id: requestId, error: { code: -32011,
    message: "响应超过 Desktop 传输上限，操作结果需核对",
    data: { reason: "DESKTOP_TRANSPORT_BUDGET_EXCEEDED", method: method.slice(0, 128), bytes: responseBytes, limit,
      retrySameRequest: false, upstreamStateMayHaveChanged: true, outcomeUnknown: true,
      hint: "请先核对上游权威状态和原操作结果，勿自动重试原请求" } } };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcResponse(message) {
  return isObject(message) && Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")
    && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

function requiredString(value, name, maximum = 100000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new CodexAppServerProxyError("INVALID_ARGUMENT", `${name} 不能为空`);
  if (normalized.length > maximum) {
    throw new CodexAppServerProxyError("INVALID_ARGUMENT", `${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function messageByteLength(data) {
  if (Buffer.isBuffer(data)) return data.length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Buffer.byteLength(String(data));
}

function parseJsonMessage(data, maximumBytes = DEFAULT_MAX_JSON_PARSE_BYTES, byteLength = messageByteLength(data)) {
  if (byteLength > maximumBytes) return null;
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function scanRpcEnvelope(data, maximumBytes) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fields = new Map();
  const envelopeFields = new Set(["id", "method", "result", "error", "params"]);
  const identityFields = new Map();
  const identityParents = new Set(["params", "params.turn", "result", "result.turn", "error"]);
  const identityPaths = new Set([
    "params.threadId", "params.turnId", "params.turn.id", "params.turn.threadId", "params.turn.status",
    "result.threadId", "result.turnId", "result.turn.id", "result.turn.threadId", "result.turn.status",
    "error.code", "error.message",
  ]);
  const valueBudget = Math.min(MAX_RPC_ENVELOPE_VALUE_BYTES, maximumBytes);
  let offset = 0;
  let fieldCount = 0;

  function invalid() {
    throw new CodexAppServerProxyError("APP_SERVER_PROTOCOL_ERROR", "RPC JSON 帧无效或超出 envelope 安全预算");
  }

  function whitespace() {
    while ([32, 9, 10, 13].includes(bytes[offset])) offset += 1;
  }

  function digit(value) {
    return value >= 48 && value <= 57;
  }

  function stringEnd() {
    if (bytes[offset++] !== 34) invalid();
    while (offset < bytes.length) {
      const value = bytes[offset++];
      if (value === 34) return;
      if (value < 32) invalid();
      if (value >= 128) {
        const continuationCount = value >= 194 && value <= 223 ? 1
          : value >= 224 && value <= 239 ? 2 : value >= 240 && value <= 244 ? 3 : 0;
        const firstContinuation = bytes[offset];
        if (!continuationCount || (value === 224 && firstContinuation < 160)
          || (value === 237 && firstContinuation >= 160) || (value === 240 && firstContinuation < 144)
          || (value === 244 && firstContinuation >= 144)) invalid();
        for (let index = 0; index < continuationCount; index += 1) {
          const continuation = bytes[offset++];
          if (!(continuation >= 128 && continuation <= 191)) invalid();
        }
        continue;
      }
      if (value !== 92) continue;
      const escaped = bytes[offset++];
      if ([34, 92, 47, 98, 102, 110, 114, 116].includes(escaped)) continue;
      if (escaped !== 117) invalid();
      for (let index = 0; index < 4; index += 1) {
        const hexadecimal = bytes[offset++];
        if (!digit(hexadecimal) && !(hexadecimal >= 65 && hexadecimal <= 70)
          && !(hexadecimal >= 97 && hexadecimal <= 102)) invalid();
      }
    }
    invalid();
  }

  function valueEnd(depth, parentPath = null) {
    if (depth > MAX_RPC_ENVELOPE_DEPTH) invalid();
    whitespace();
    const initial = bytes[offset];
    if (initial === 34) return stringEnd();
    if (initial === 123 || initial === 91) {
      offset += 1;
      const closing = initial === 123 ? 125 : 93;
      whitespace();
      if (bytes[offset] === closing) { offset += 1; return; }
      while (offset < bytes.length) {
        let childPath = null;
        if (initial === 123) {
          const keyStart = offset;
          stringEnd();
          if (identityParents.has(parentPath)) {
            childPath = `${parentPath}.${decode({ start: keyStart, end: offset }, 1024)}`;
          }
          whitespace();
          if (bytes[offset++] !== 58) invalid();
        }
        whitespace();
        const start = offset;
        valueEnd(depth + 1, identityParents.has(childPath) ? childPath : null);
        if (identityPaths.has(childPath)) {
          if (identityFields.has(childPath)) invalid();
          identityFields.set(childPath, { start, end: offset });
        }
        whitespace();
        if (bytes[offset] === closing) { offset += 1; return; }
        if (bytes[offset++] !== 44) invalid();
        whitespace();
      }
      invalid();
    }
    const literal = initial === 116 ? "true" : initial === 102 ? "false" : initial === 110 ? "null" : null;
    if (literal) {
      for (const character of literal) if (bytes[offset++] !== character.charCodeAt(0)) invalid();
      return;
    }
    if (bytes[offset] === 45) offset += 1;
    if (bytes[offset] === 48) offset += 1;
    else {
      if (!(bytes[offset] >= 49 && bytes[offset] <= 57)) invalid();
      while (digit(bytes[offset])) offset += 1;
    }
    if (bytes[offset] === 46) {
      offset += 1;
      if (!digit(bytes[offset])) invalid();
      while (digit(bytes[offset])) offset += 1;
    }
    if (bytes[offset] === 69 || bytes[offset] === 101) {
      offset += 1;
      if (bytes[offset] === 43 || bytes[offset] === 45) offset += 1;
      if (!digit(bytes[offset])) invalid();
      while (digit(bytes[offset])) offset += 1;
    }
  }

  function decode(range, maximumBytes = valueBudget) {
    if (range.end - range.start > maximumBytes) invalid();
    return JSON.parse(bytes.subarray(range.start, range.end).toString("utf8"));
  }

  whitespace();
  if (bytes[offset++] !== 123) invalid();
  whitespace();
  if (bytes[offset] !== 125) {
    while (offset < bytes.length) {
      if (++fieldCount > MAX_RPC_ENVELOPE_FIELDS) invalid();
      const keyStart = offset;
      stringEnd();
      const key = decode({ start: keyStart, end: offset }, 1024);
      whitespace();
      if (bytes[offset++] !== 58) invalid();
      whitespace();
      const start = offset;
      valueEnd(1, identityParents.has(key) ? key : null);
      if (envelopeFields.has(key)) {
        if (fields.has(key)) invalid();
        fields.set(key, { start, end: offset });
      }
      whitespace();
      if (bytes[offset] === 125) break;
      if (bytes[offset++] !== 44) invalid();
      whitespace();
    }
  }
  if (bytes[offset++] !== 125) invalid();
  whitespace();
  if (offset !== bytes.length) invalid();
  const message = {};
  for (const [key, range] of fields) {
    if (["id", "method"].includes(key) || range.end - range.start <= valueBudget) {
      message[key] = decode(range);
    } else if (key !== "params") message[key] = {};
  }
  if (Object.hasOwn(message, "id") && message.id !== null
    && !["string", "number"].includes(typeof message.id)) invalid();
  if (typeof message.id === "number" && !Number.isFinite(message.id)) invalid();
  if (Object.hasOwn(message, "method") && typeof message.method !== "string") invalid();
  if (!Object.hasOwn(message, "method") && (!fields.has("id") || !(fields.has("result") || fields.has("error")))) invalid();
  if (!Object.hasOwn(message, "method") && fields.has("result") && fields.has("error")) invalid();
  let identityBytes = 0;
  for (const [identityPath, range] of identityFields) {
    const root = identityPath.split(".")[0];
    const rootRange = fields.get(root);
    const length = range.end - range.start;
    if (rootRange.end - rootRange.start <= valueBudget || identityBytes + length > valueBudget) continue;
    identityBytes += length;
    const segments = identityPath.split(".");
    let target = message;
    for (const segment of segments.slice(0, -1)) {
      if (!isObject(target[segment])) target[segment] = {};
      target = target[segment];
    }
    target[segments.at(-1)] = decode(range);
  }
  return { bytes, fields, message };
}

function rewriteRpcId(envelope, idJson) {
  const range = envelope.fields.get("id");
  return Buffer.concat([
    envelope.bytes.subarray(0, range.start),
    Buffer.from(idJson),
    envelope.bytes.subarray(range.end),
  ]);
}

function isNotFoundRpcError(error, threadId) {
  if (![-32602, -32004].includes(error?.code) || typeof error?.message !== "string") return false;
  const escapedId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const message = error.message.trim();
  return new RegExp(`^(?:thread not found|unknown thread|thread does not exist):\\s*["']?${escapedId}["']?[.!]?$`, "i").test(message)
    || new RegExp(`^thread\\s+["']?${escapedId}["']?\\s+(?:not found|does not exist)[.!]?$`, "i").test(message);
}

function responseTurn(response) {
  if (!isObject(response)) return null;
  if (isObject(response.turn)) return response.turn;
  if (isObject(response.result?.turn)) return response.result.turn;
  if (typeof response.turnId === "string" && response.turnId) return { id: response.turnId, status: "inProgress" };
  return null;
}

function normalizeWakeMessageVisibility(value) {
  const visibility = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "visible";
  if (!["visible", "hidden"].includes(visibility)) {
    throw new CodexAppServerProxyError(
      "INVALID_ARGUMENT",
      "messageVisibility 只支持 visible 或 hidden",
    );
  }
  return visibility;
}

function normalizeTurnStatus(value) {
  const status = isObject(value) ? value.type : value;
  return typeof status === "string" ? status.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

const ACTIVE_TURN_STATUSES = new Set([
  "active",
  "inprogress",
  "pending",
  "queued",
  "running",
  "starting",
  "streaming",
  "working",
]);

function resumeThreadState(result, threadId) {
  const thread = result?.thread;
  if (!isObject(thread) || thread.id !== threadId) {
    throw new CodexAppServerProxyError("INVALID_THREAD_SUMMARY", "App Server 未返回匹配的恢复对话摘要");
  }
  const explicitStatus = thread.status ?? thread.state;
  let status = normalizeTurnStatus(explicitStatus);
  if (explicitStatus === undefined || explicitStatus === null) {
    if (Array.isArray(thread.turns)) {
      if (!thread.turns.length) status = "idle";
      else {
        status = normalizeTurnStatus(thread.turns.at(-1)?.status ?? thread.turns.at(-1)?.state);
        if (["completed", "done", "failed", "cancelled", "canceled", "interrupted"].includes(status)) status = "idle";
      }
    }
  }
  if (status === "idle") return "idle";
  if (ACTIVE_TURN_STATUSES.has(status)) return "busy";
  throw new CodexAppServerProxyError("THREAD_NOT_IDLE", "App Server 恢复摘要未确认对话空闲或可定位的活动状态", {
    details: { threadId, status: explicitStatus ?? status ?? null },
  });
}

function activeTurnFromResumeResult(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const active = activeTurnFromResumeResult(value[index], depth + 1);
      if (active) return active;
    }
    return null;
  }
  if (!isObject(value)) return null;
  const candidates = Array.isArray(value.turns) ? value.turns : Array.isArray(value.data) ? value.data : null;
  if (candidates) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const turn = candidates[index];
      const status = normalizeTurnStatus(turn?.status ?? turn?.state);
      if (
        isObject(turn)
        && typeof (turn.id ?? turn.turnId) === "string"
        && (turn.id ?? turn.turnId).trim().length > 0
        && ACTIVE_TURN_STATUSES.has(status)
      ) return turn;
    }
  }
  for (const child of Object.values(value)) {
    const active = activeTurnFromResumeResult(child, depth + 1);
    if (active) return active;
  }
  return null;
}

function publicError(error) {
  return {
    code: error?.code ?? "UNEXPECTED_ERROR",
    message: error?.message ?? String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: error?.details ?? null,
  };
}

function atomicWriteJson(filePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsImpl.renameSync(temporaryPath, filePath);
}

function readJournal(filePath, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    if (parsed?.schemaVersion === 2 && isObject(parsed.subscriptions) && isObject(parsed.wakes)) return parsed;
    if (parsed?.schemaVersion === 1 && isObject(parsed.wakes)) {
      return { schemaVersion: 2, subscriptions: {}, wakes: parsed.wakes };
    }
    throw new CodexAppServerProxyError("WAKE_JOURNAL_INVALID", `唤醒日志结构无效：${filePath}`);
  } catch (cause) {
    if (cause?.code === "ENOENT") return { schemaVersion: 2, subscriptions: {}, wakes: {} };
    if (cause instanceof CodexAppServerProxyError) throw cause;
    throw new CodexAppServerProxyError(
      "WAKE_JOURNAL_INVALID",
      `无法读取唤醒日志，已停止自动注入：${filePath}`,
      { cause },
    );
  }
}

function promptSha256(prompt) {
  return crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
}

const SUBSCRIPTION_FIELDS = [
  "taskId",
  "generation",
  "threadId",
  "localRole",
  "sourceMachine",
  "targetMachine",
  "trustedPeerQq",
];

function normalizeSubscription(input) {
  if (!isObject(input)) throw new CodexAppServerProxyError("INVALID_ARGUMENT", "subscription 必须接收对象");
  const generation = Number(input.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new CodexAppServerProxyError("INVALID_ARGUMENT", "generation 必须是正安全整数");
  }
  return {
    taskId: requiredString(input.taskId, "taskId", 128),
    generation,
    threadId: requiredString(input.threadId, "threadId", 256),
    localRole: requiredString(input.localRole, "localRole", 128),
    sourceMachine: requiredString(input.sourceMachine, "sourceMachine", 128),
    targetMachine: requiredString(input.targetMachine, "targetMachine", 128),
    trustedPeerQq: requiredString(input.trustedPeerQq, "trustedPeerQq", 64),
  };
}

function sameFields(left, right, fields) {
  return fields.every((field) => left?.[field] === right?.[field]);
}


export function createWakeJournal(options = {}) {
  const filePath = requiredString(options.filePath, "filePath", 32768);
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());

  function getWake(wakeId) {
    const state = readJournal(filePath, fsImpl);
    return state.wakes[wakeId] ?? null;
  }

  function writeWake(wakeId, patch, expectedStatuses = null) {
    const state = readJournal(filePath, fsImpl);
    const current = state.wakes[wakeId] ?? {};
    if (expectedStatuses && !expectedStatuses.includes(current.status)) {
      throw new CodexAppServerProxyError(
        "WAKE_STATE_CONFLICT",
        `wakeId 状态已变化：${wakeId}`,
        { details: { wakeId, expectedStatuses, actualStatus: current.status ?? null } },
      );
    }
    const next = {
      ...current,
      ...patch,
      wakeId,
      createdAt: current.createdAt ?? now().toISOString(),
      updatedAt: now().toISOString(),
    };
    state.wakes[wakeId] = next;
    atomicWriteJson(filePath, state, fsImpl);
    return next;
  }

  function registerSubscription(input) {
    const subscription = normalizeSubscription(input);
    const state = readJournal(filePath, fsImpl);
    const existing = state.subscriptions[subscription.taskId] ?? null;
    if (existing && sameFields(existing, subscription, SUBSCRIPTION_FIELDS)) {
      return { subscription: existing, created: false, updated: false };
    }
    if (existing && subscription.generation > Number(existing.generation)) {
      const next = { ...subscription, createdAt: existing.createdAt, updatedAt: now().toISOString() };
      state.subscriptions[subscription.taskId] = next;
      atomicWriteJson(filePath, state, fsImpl);
      return { subscription: next, created: false, updated: true };
    }
    if (existing) {
      throw new CodexAppServerProxyError(
        "SUBSCRIPTION_CONFLICT",
        `taskId 已登记不同的 Codex 订阅：${subscription.taskId}`,
        { details: { existing, requested: subscription } },
      );
    }
    const nowIso = now().toISOString();
    const next = { ...subscription, createdAt: nowIso, updatedAt: nowIso };
    state.subscriptions[subscription.taskId] = next;
    atomicWriteJson(filePath, state, fsImpl);
    return { subscription: next, created: true, updated: false };
  }

  function claimWake(input) {
    const wakeId = requiredString(input.wakeId, "wakeId", 256);
    const state = readJournal(filePath, fsImpl);
    const existing = state.wakes[wakeId] ?? null;
    const messageVisibility = normalizeWakeMessageVisibility(input.messageVisibility);
    const identity = {
      wakeId,
      taskId: requiredString(input.taskId, "taskId", 128),
      generation: Number(input.generation),
      threadId: requiredString(input.threadId, "threadId", 256),
      promptSha256: requiredString(input.promptSha256, "promptSha256", 128),
      pendingThroughSequence: Number(input.pendingThroughSequence),
      pendingThroughTime: requiredString(input.pendingThroughTime, "pendingThroughTime", 128),
    };
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
      throw new CodexAppServerProxyError("INVALID_ARGUMENT", "generation 必须是正安全整数");
    }
    if (!Number.isSafeInteger(identity.pendingThroughSequence) || identity.pendingThroughSequence < 0) {
      throw new CodexAppServerProxyError("INVALID_ARGUMENT", "pendingThroughSequence 必须是非负安全整数");
    }
    const identityFields = [
      "taskId",
      "generation",
      "threadId",
      "promptSha256",
      "pendingThroughSequence",
      "pendingThroughTime",
    ];
    if (existing && !sameFields(existing, identity, identityFields)) {
      throw new CodexAppServerProxyError("WAKE_ID_CONFLICT", `wakeId 已被不同请求使用：${wakeId}`);
    }
    if (
      existing?.status !== "failed_before_send"
      && existing?.messageVisibility
      && existing.messageVisibility !== messageVisibility
    ) {
      throw new CodexAppServerProxyError("WAKE_ID_CONFLICT", `wakeId 已绑定不同的消息可见性：${wakeId}`);
    }
    if (existing && existing.status !== "failed_before_send") {
      return { wake: existing, acquired: false };
    }
    const nowIso = now().toISOString();
    const next = {
      ...(existing ?? {}),
      ...identity,
      messageVisibility,
      clientUserMessageId: messageVisibility === "visible"
        ? existing?.clientUserMessageId ?? crypto.randomUUID()
        : null,
      visibilityClientId: messageVisibility === "hidden" ? existing?.visibilityClientId ?? crypto.randomUUID() : null,
      status: "prepared",
      attempt: Number(existing?.attempt ?? 0) + 1,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      error: null,
    };
    state.wakes[wakeId] = next;
    atomicWriteJson(filePath, state, fsImpl);
    return { wake: next, acquired: true };
  }

  function status() {
    const state = readJournal(filePath, fsImpl);
    return {
      schemaVersion: state.schemaVersion,
      subscriptionCount: Object.keys(state.subscriptions).length,
      wakeCount: Object.keys(state.wakes).length,
      unknownWakeCount: Object.values(state.wakes).filter((wake) => wake.status === "unknown").length,
    };
  }

  return {
    filePath,
    get: getWake,
    write: writeWake,
    getWake,
    writeWake,
    visibilityWakes() {
      return Object.values(readJournal(filePath, fsImpl).wakes)
        .filter(wake => ["accepted", "completed", "unknown"].includes(wake.status))
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
        .slice(-2048);
    },
    registerSubscription,
    claimWake,
    status,
  };
}

export class CodexAppServerProxy {
  static hotRuntimeSchema = "proxy-live-state-v1";
  _liveRequestMetadata = null;
  _liveRequestMetadataEnabled = false;

  constructor(options = {}) {
    this.downstreamHost = options.downstreamHost ?? "127.0.0.1";
    this.downstreamPort = boundedInteger(options.downstreamPort, 18432, 1, 65535);
    this.controlHost = options.controlHost ?? "127.0.0.1";
    this.controlPort = boundedInteger(options.controlPort, 18431, 1, 65535);
    this.upstreamUrl = requiredString(options.upstreamUrl ?? "ws://127.0.0.1:18433", "upstreamUrl", 2048);
    this.upstreamPaused = Boolean(options.upstreamPaused);
    this.controlToken = requiredString(options.controlToken, "controlToken", 4096);
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 250, 300000);
    this.resumeRequestTimeoutMs = boundedInteger(
      options.resumeRequestTimeoutMs,
      DEFAULT_RESUME_REQUEST_TIMEOUT_MS,
      this.requestTimeoutMs,
      300000,
    );
    this.maxBodyBytes = boundedInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, 16 * 1024 * 1024);
    this.reconnectInitialMs = boundedInteger(options.reconnectInitialMs, 250, 50, 60000);
    this.reconnectMaxMs = boundedInteger(options.reconnectMaxMs, 5000, this.reconnectInitialMs, 300000);
    this.maxQueuedMessages = boundedInteger(options.maxQueuedMessages, 1000, 1, 10000);
    this.maxQueuedBytes = boundedInteger(
      options.maxQueuedBytes,
      DEFAULT_MAX_QUEUED_BYTES,
      1024,
      DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES,
    );
    this.maxBufferedBytes = boundedInteger(
      options.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      1024,
      DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES,
    );
    this.maxWebSocketPayloadBytes = boundedInteger(
      options.maxWebSocketPayloadBytes,
      DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES,
      1024 * 1024,
      1024 * 1024 * 1024 - 1,
    );
    this.maxJsonParseBytes = boundedInteger(
      options.maxJsonParseBytes,
      DEFAULT_MAX_JSON_PARSE_BYTES,
      1024,
      this.maxWebSocketPayloadBytes,
    );
    this.maxDesktopResponseBytes = boundedInteger(options.maxDesktopResponseBytes,
      DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES, 1024, DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES);
    this.maxDesktopTransportBytes = boundedInteger(options.maxDesktopTransportBytes,
      DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES, 1024, DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES);
    this.heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      1000,
      300000,
    );
    this.turnFirstOutputTimeoutMs = boundedInteger(
      options.turnFirstOutputTimeoutMs,
      DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
      1000,
      300000,
    );
    this.createTurnObserver = options.createTurnObserver ?? createTurnLifecycleObserver;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.WebSocketServerImpl = options.WebSocketServerImpl ?? WebSocketServer;
    try {
      this._liveRequestMetadata = createCodexRequestMetadata(options.requestMetadata);
      this._liveRequestMetadataEnabled = this._liveRequestMetadata.snapshot().enabled;
    } catch {}
    this.journal = options.journal ?? null;
    this.displayPolicy = createCodexDisplayPolicyManager({
      maximumRequests: this.maxQueuedMessages,
      onEvent: (event) => this.onEvent?.(event),
    });
    this.wakeVisibility = createWakeVisibilityAdapter({
      onItemBound: (registration) => {
        try {
          const binding = this.displayPolicy.prepareReminderBinding(registration);
          this.journal.writeWake(registration.wakeId, {
            turnId: registration.turnId,
            injectionMethod: registration.injectionMethod,
            visibilityItemKey: registration.itemKey,
            displayPolicyVersion: binding.version,
            displayDecision: binding.decision,
          }, ["dispatching", "accepted", "completed", "unknown"]);
          this.displayPolicy.commitReminderBinding(registration, binding);
          return true;
        } catch (error) {
          this._liveRecordError("wake_visibility_identity", error);
          return false;
        }
      },
    });
    for (const wake of this.journal?.visibilityWakes?.() ?? []) {
      const registration = this.wakeVisibility.registerWake({
        ...wake, itemKey: wake.visibilityItemKey ?? null,
        visibilityClientId: wake.visibilityClientId ?? wake.clientUserMessageId,
      });
      this.displayPolicy.registerReminder(registration, wake);
    }
    this.reasoningPlaceholderEnabled = options.reasoningPlaceholderEnabled !== false;
    this.reasoningPlaceholderClientNames = options.reasoningPlaceholderClientNames;
    this.maintenanceFilePath = options.maintenanceFilePath
      ? path.resolve(String(options.maintenanceFilePath))
      : null;
    this.writerEpoch = requiredString(options.writerEpoch ?? crypto.randomUUID(), "writerEpoch", 256);
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.onNativeTurn = typeof options.onNativeTurn === "function" ? options.onNativeTurn : null;
    this.managedInnerControl = options.managedInnerControl ?? null;
    if (this.managedInnerControl && !["127.0.0.1", "::1"].includes(this.controlHost)) throw new Error("INNER_MANAGED_CONTROL_REQUIRES_LOOPBACK");
    if (options.displayPolicyRoot && !["127.0.0.1", "::1"].includes(this.controlHost)) {
      throw new Error("DISPLAY_POLICY_CONTROL_REQUIRES_LOOPBACK");
    }
    this.displayPolicyControl = createCodexDisplayPolicyControl(this.displayPolicy, {
      candidateRoot: options.displayPolicyRoot, instanceId: options.instanceToken ?? this.writerEpoch, onEvent: this.onEvent,
    });
    this.clients = new Set();
    this.modelRecovery = options.modelRecoveryControl ? createRecoveryNotificationRouter({
      ...options.modelRecoveryControl,
      sendNotification: (client, notification, binding) => this._liveNotifyClient(client, notification, binding),
    }) : null;
    this.liveCodeRuntime = createProxyLiveCodeRuntime(this, {
      candidateRoot: options.outerRuntimeRoot, instanceId: options.instanceToken ?? this.writerEpoch,
    });
    this.nextInjectedRequestId = FIRST_INJECTED_REQUEST_ID;
    this.websocketServer = null;
    this.controlServer = null;
    this.heartbeatTimer = null;
    this.startedAt = null;
    this.closed = false;
    this.lastError = null;
    this.lastIncident = null;
    if (options.outerRuntimeRoot && !["127.0.0.1", "::1"].includes(this.controlHost)) throw new Error("OUTER_RUNTIME_CONTROL_REQUIRES_LOOPBACK");
    this.outerRuntime = createOuterRuntime({
      instanceId: options.instanceToken ?? this.writerEpoch, candidateRoot: options.outerRuntimeRoot,
      maximumTurns: this.maxQueuedMessages, onEvent: this.onEvent,
      createHost: entry => createOuterRuntimeHost({
        entry,
        state: {
          journal: this.journal,
          wakeVisibility: this.wakeVisibility,
          displayPolicy: this.displayPolicy,
          resumeRequestTimeoutMs: this.resumeRequestTimeoutMs,
          writerEpoch: this.writerEpoch,
        },
        readyClients: () => this._liveReadyClients(),
        maintenanceStatus: () => this._liveMaintenanceStatus(),
        recordError: (source, error) => this._liveRecordError(source, error),
        injectRequest: (client, method, params, requestOptions = {}) => {
          return this._liveInjectRequest(client, method, params, { ...requestOptions, outerEntry: entry });
        },
        notifyRecoveryState: envelope => this.publishRecoveryState(envelope),
      }),
    });
  }

  async start() {
    if (this.websocketServer || this.controlServer) return this.status();
    this.closed = false;
    try {
      await this.outerRuntime.reopenSelection();
      this.websocketServer = new this.WebSocketServerImpl({
        host: this.downstreamHost,
        port: this.downstreamPort,
        maxPayload: this.maxWebSocketPayloadBytes,
      });
      this.websocketServer.on("connection", (socket) => this._liveAcceptDownstream(socket));
      this.websocketServer.on("error", (error) => this._liveRecordError("downstream_server", error));
      await this._liveWaitForListening(this.websocketServer, "WebSocket");

      this.controlServer = http.createServer((request, response) => {
        this._liveHandleControlRequest(request, response).catch((error) => {
          if (!/^\/v1\/display-policy(?:\/|\?|$)/.test(request.url ?? "")) this._liveRecordError("control_request", error);
          if (!response.headersSent) response.setHeader("content-type", "application/json; charset=utf-8");
          response.statusCode = error?.code === "UNAUTHORIZED"
            ? 401
            : ["SUBSCRIPTION_CONFLICT", "WAKE_ID_CONFLICT", "WAKE_STATE_CONFLICT"].includes(error?.code)
              ? 409
              : error?.code === "AUTOMATION_PAUSED"
                ? 503
                : 500;
          response.end(JSON.stringify({ ok: false, error: publicError(error) }));
        });
      });
      this.controlServer.on("error", (error) => this._liveRecordError("control_server", error));
      await this._liveListenHttp(this.controlServer, this.controlPort, this.controlHost);
      this.startedAt = new Date().toISOString();
      this.heartbeatTimer = setInterval(() => this._liveCheckHeartbeats(), this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
      this.onEvent({ type: "proxy_started", status: this.status() });
      return this.status();
    } catch (error) {
      await Promise.all([
        this._liveCloseServer(this.websocketServer),
        this._liveCloseServer(this.controlServer),
      ]);
      this.websocketServer = null;
      this.controlServer = null;
      throw error;
    }
  }

  requestMetadataSnapshot() {
    try {
      return this._liveRequestMetadata?.snapshot() ?? { schemaVersion: 1, enabled: false, unavailable: true };
    } catch {
      return { schemaVersion: 1, enabled: false, unavailable: true };
    }
  }

  _liveNewMetadataGeneration() {
    if (!this._liveRequestMetadataEnabled) return null;
    try { return crypto.randomUUID(); } catch { return null; }
  }

  _liveObserveRequestMetadata(direction, generation, parsed, byteLength) {
    try { this._liveRequestMetadata?.observe({ direction, generation, parsed, byteLength }); } catch {}
  }

  _liveCloseMetadataConnection(generation) {
    try { this._liveRequestMetadata?.closeConnection(generation); } catch {}
  }

  status() {
    const clients = [...this.clients].map((client) => ({
      initialized: client.initialized,
      downstreamState: client.downstream.readyState,
      upstreamState: client.upstream?.readyState ?? this.WebSocketImpl.CLOSED,
      upstreamReady: client.upstreamReady,
      pendingInjectionCount: client.injected.size,
      queuedMessageCount: client.queued.length,
      queuedBytes: client.queuedBytes,
      downstreamBufferedBytes: client.downstream.bufferedAmount ?? 0,
      upstreamBufferedBytes: client.upstream?.bufferedAmount ?? 0,
      reconnectAttempt: client.reconnectAttempt,
      nextReconnectAt: client.nextReconnectAt,
      connectedAt: client.connectedAt,
      reasoningPlaceholder: client.reasoningPlaceholder.status(),
      turnObservation: client.turnObserver.status(),
      displayPolicy: client.displayPolicy.snapshot(),
    }));
    return {
      ok: true,
      startedAt: this.startedAt,
      closed: this.closed,
      downstreamUrl: `ws://${this.downstreamHost}:${this.downstreamPort}`,
      controlUrl: `http://${this.controlHost}:${this.controlPort}`,
      upstreamUrl: this.upstreamUrl,
      clientCount: clients.length,
      initializedClientCount: clients.filter((client) => client.initialized).length,
      readyClientCount: clients.filter((client) =>
      client.initialized
      && client.upstreamReady
      && client.downstreamState === this.WebSocketImpl.OPEN
        && client.upstreamState === this.WebSocketImpl.OPEN
      ).length,
      clients,
      writerEpoch: this.writerEpoch,
      maintenance: this._liveMaintenanceStatus(),
      journal: this.journal?.status?.() ?? null,
      wakeVisibility: this.wakeVisibility.snapshot(),
      displayPolicy: this.displayPolicy.status(),
      displayPolicyControl: this.displayPolicyControl.status(),
      outerRuntime: this.outerRuntime.status(),
      lastError: this.lastError,
      lastIncident: this.lastIncident,
      limits: {
        maxWebSocketPayloadBytes: this.maxWebSocketPayloadBytes,
        maxJsonParseBytes: this.maxJsonParseBytes,
        maxQueuedMessages: this.maxQueuedMessages,
        maxQueuedBytes: this.maxQueuedBytes,
        maxBufferedBytes: this.maxBufferedBytes,
        maxDesktopResponseBytes: this.maxDesktopResponseBytes ?? DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES,
        maxDesktopTransportBytes: this.maxDesktopTransportBytes ?? DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        turnFirstOutputTimeoutMs: this.turnFirstOutputTimeoutMs,
      },
    };
  }

  async prepareDisplayPolicy(modulePath) {
    return this.displayPolicy.prepare(modulePath);
  }

  activateDisplayPolicy(preparation) {
    return this.displayPolicy.activate(preparation);
  }

  async inspectThread(input) { return this.outerRuntime.invoke("inspectThread", input); }
  async subscribeThread(input) { return this.outerRuntime.invoke("subscribeThread", input); }
  async subscribeTask(input) { return this.outerRuntime.invoke("subscribeTask", input); }
  async wakeThread(input) { return this.outerRuntime.invoke("wakeThread", input); }

  prepareOuterRuntime(input) { return this.outerRuntime.prepare(input); }
  activateOuterRuntime(input) { return this.outerRuntime.activate(input); }
  restoreOuterRuntime(input) { return this.outerRuntime.restore(input); }

  async close() {
    if (this.closed) return { closed: true };
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const client of [...this.clients]) this._liveCloseClient(client, "proxy_closed");
    try { this._liveRequestMetadata?.close(); } catch {}
    this.wakeVisibility.close();
    this.outerRuntime.close();
    await Promise.all([
      this._liveCloseServer(this.websocketServer),
      this._liveCloseServer(this.controlServer),
    ]);
    this.websocketServer = null;
    this.controlServer = null;
    this.onEvent({ type: "proxy_closed" });
    return { closed: true };
  }

  _liveReadyClients() {
    return [...this.clients].filter((client) =>
      client.initialized
      && client.upstreamReady
      && client.downstream.readyState === this.WebSocketImpl.OPEN
      && client.upstream?.readyState === this.WebSocketImpl.OPEN
    );
  }

  _liveNotifyClient(client, notification, binding) {
    if (this.closed || !this.clients.has(client) || client.closed || !client.initialized || !client.upstreamReady
      || client.metadataUpstreamGeneration !== binding?.connectionGeneration
      || client.downstream.readyState !== this.WebSocketImpl.OPEN
      || client.upstream?.readyState !== this.WebSocketImpl.OPEN
      || notification?.method !== "error" || Object.hasOwn(notification, "id")) return false;
    return this._liveSendOrClose(client, client.downstream, JSON.stringify(notification), false, "model_recovery_notification");
  }

  publishRecoveryState(envelope) {
    if (this.closed) return { accepted: false };
    return this.modelRecovery?.accept(envelope) ?? { accepted: false };
  }

  _liveMaintenanceStatus() {
    if (!this.maintenanceFilePath) return { active: false, reasons: [] };
    try {
      const state = JSON.parse(fs.readFileSync(this.maintenanceFilePath, "utf8").replace(/^\uFEFF/, ""));
      const reasons = isObject(state?.reasons)
        ? Object.keys(state.reasons)
        : Array.isArray(state?.reasons)
          ? state.reasons.map(String)
          : [];
      return {
        active: Boolean(state?.active || state?.enabled || state?.paused || reasons.length),
        reasons,
        updatedAt: state?.updatedAt ?? null,
      };
    } catch (cause) {
      if (cause?.code === "ENOENT") return { active: false, reasons: [] };
      return {
        active: true,
        reasons: ["maintenance_state_unreadable"],
        error: publicError(cause),
      };
    }
  }

  _liveAcceptDownstream(downstream) {
    const client = {
      downstream,
      upstream: null,
      metadataDownstreamGeneration: this._liveNewMetadataGeneration(),
      metadataUpstreamGeneration: null,
      initialized: false,
      initializationRequestId: null,
      upstreamReady: false,
      hasConnectedBefore: false,
      queued: [],
      queuedBytes: 0,
      injected: new Map(),
      desktopRequestIds: new Map(),
      desktopRequestBytes: 0,
      forwardedRequestIds: new Map(),
      connectedAt: new Date().toISOString(),
      closed: false,
      reconnectTimer: null,
      reconnectAttempt: 0,
      nextReconnectAt: null,
      downstreamAlive: true,
      upstreamAlive: false,
      wakeVisibility: this.wakeVisibility.createView(),
      displayPolicy: this.displayPolicy.createView(),
      reasoningPlaceholder: createReasoningPlaceholderView({
        enabled: this.reasoningPlaceholderEnabled,
        clientNames: this.reasoningPlaceholderClientNames,
      }),
      turnObserver: this.createTurnObserver({
        timeoutMs: this.turnFirstOutputTimeoutMs,
        onAnomaly: (event) => this.onEvent(event),
      }),
    };
    this.clients.add(client);
    downstream.on("message", (data, isBinary) => this._liveReceiveDownstream(client, data, isBinary));
    downstream.on("close", () => this._liveCloseClient(client, "downstream_closed"));
    downstream.on("error", (error) => this._liveCloseClient(client, "downstream_error", error));
    downstream.on("pong", () => { client.downstreamAlive = true; });
    this._liveConnectUpstream(client);
  }

  _liveReceiveDownstream(client, data, isBinary) {
    const originalByteLength = messageByteLength(data);
    if (client.closed) {
      this._liveObserveRequestMetadata("downstream", null, null, originalByteLength);
      return;
    }
    client.downstreamAlive = true;
    const envelope = this._liveReadRpcEnvelope(client, data, "downstream");
    if (!envelope) {
      this._liveObserveRequestMetadata("downstream", null, null, originalByteLength);
      return;
    }
    const message = parseJsonMessage(data, this.maxJsonParseBytes, originalByteLength) ?? envelope.message;
    this._liveObserveRequestMetadata("downstream", isRpcResponse(message)
      ? client.metadataUpstreamGeneration : client.metadataDownstreamGeneration, message, originalByteLength);
    this.outerRuntime.downstream(client, message);
    if (message?.method === "initialize") {
      client.initializationRequestId = message.id ?? null;
    } else if (message?.method === "initialized") {
      client.initialized = true;
    }
    let payload = data;
    if (typeof message?.method === "string" && ["string", "number"].includes(typeof message.id)) {
      const idRange = envelope.fields.get("id");
      const requestIdBytes = Buffer.byteLength(String(message.id), "utf8") + 16
        + (this._liveIsInternalRequestId(message.id) ? idRange.end - idRange.start : 0);
      if (client.desktopRequestIds.has(message.id) || client.desktopRequestIds.size >= this.maxQueuedMessages
        || client.desktopRequestBytes + requestIdBytes > this.maxQueuedBytes) {
        this._liveCloseClient(client, "desktop_request_tracking_conflict");
        return;
      }
      client.desktopRequestIds.set(message.id, { bytes: requestIdBytes, upstreamId: message.id,
        method: message.method.slice(0, 128), threadId: message.params?.threadId?.slice?.(0, 512),
        includeTurns: message.params?.includeTurns === true });
      client.desktopRequestBytes += requestIdBytes;
      if (this._liveIsInternalRequestId(message.id)) {
        const forwardedId = this._liveAllocateRequestId(client);
        client.forwardedRequestIds.set(forwardedId, message.id);
        const tracking = client.desktopRequestIds.get(message.id);
        tracking.upstreamId = forwardedId;
        tracking.idJson = Buffer.from(envelope.bytes.subarray(idRange.start, idRange.end));
        payload = rewriteRpcId(envelope, JSON.stringify(forwardedId));
      }
    }
    const payloadBytes = payload === data ? originalByteLength : messageByteLength(payload);
    const observation = { id: message.id, method: message.method, threadId: message.params?.threadId };
    if ((!client.turnPreflightPending || isRpcResponse(message) || message.method === "initialized")
      && client.upstreamReady && client.upstream?.readyState === this.WebSocketImpl.OPEN) {
      this._liveForwardDesktopMessage(client, client.upstream, { data: payload, isBinary, bytes: payloadBytes, observation });
      return;
    }
    if (client.queued.length >= this.maxQueuedMessages
      || client.queuedBytes + (client.turnPreflightBytes ?? 0) + payloadBytes > this.maxQueuedBytes) {
      this._liveCloseClient(client, "downstream_queue_overflow", new CodexAppServerProxyError(
        "DOWNSTREAM_QUEUE_OVERFLOW",
        `App Server 启动期间累计消息超过安全上限，已关闭当前连接以避免无界占用`,
      ));
      return;
    }
    client.queued.push({ data: payload, isBinary, bytes: payloadBytes, observation });
    client.queuedBytes += payloadBytes;
  }

  _liveReceiveUpstream(client, upstream, metadataGeneration, data, isBinary) {
    const originalByteLength = messageByteLength(data);
    if (client.closed || client.upstream !== upstream) {
      this._liveObserveRequestMetadata("upstream", null, null, originalByteLength);
      return;
    }
    client.upstreamAlive = true;
    const envelope = this._liveReadRpcEnvelope(client, data, "upstream");
    if (!envelope) {
      this._liveObserveRequestMetadata("upstream", null, null, originalByteLength);
      return;
    }
    let message = parseJsonMessage(data, this.maxJsonParseBytes, originalByteLength);
    let rpcMessage = message ?? envelope.message;
    const response = isRpcResponse(rpcMessage);
    let desktopResponse = null;
    let metadataMessage = rpcMessage;
    let responseGeneration = metadataGeneration;
    if (response && client.forwardedRequestIds.has(rpcMessage.id)) {
      responseGeneration = client.metadataDownstreamGeneration;
      metadataMessage = { id: client.forwardedRequestIds.get(rpcMessage.id) };
      if (Object.hasOwn(rpcMessage, "error")) metadataMessage.error = rpcMessage.error;
      else metadataMessage.result = rpcMessage.result;
    } else if (response && !client.injected.has(rpcMessage.id)
      && (!this._liveIsInternalRequestId(rpcMessage.id)
        || client.desktopRequestIds.get(rpcMessage.id)?.upstreamId === rpcMessage.id)) {
      responseGeneration = client.metadataDownstreamGeneration;
    }
    this._liveObserveRequestMetadata("upstream", responseGeneration, metadataMessage, originalByteLength);
    if (response && client.injected.has(rpcMessage.id)) {
      const pending = client.injected.get(rpcMessage.id);
      this.outerRuntime.injectedResponse(client, message ?? rpcMessage, pending.outerEntry);
      client.injected.delete(rpcMessage.id);
      clearTimeout(pending.timeout);
      if (!message) {
        pending.reject(new CodexAppServerProxyError(
          "APP_SERVER_RESPONSE_TOO_LARGE",
          `App Server 回复超过正文解析预算：${pending.method}`,
          { outcomeUnknown: pending.mutating && pending.written,
            details: { method: pending.method, id: pending.id, bytes: envelope.bytes.length, maxJsonParseBytes: this.maxJsonParseBytes } },
        ));
      } else if (message.error) {
        this.modelRecovery?.rejectExpectedTurn?.(client, pending.id, metadataGeneration);
        pending.reject(new CodexAppServerProxyError(
          "APP_SERVER_RPC_ERROR",
          message.error.message ?? `App Server 请求失败：${pending.method}`,
          { details: { method: pending.method, rpcError: message.error } },
        ));
      } else {
        pending.resolve(message.result);
      }
      this.displayPolicyControl.observeRpc("consumed", pending.id, pending.method);
      return;
    }
    if (response) {
      const upstreamId = rpcMessage.id;
      if (client.forwardedRequestIds.has(upstreamId)) {
        const originalId = client.forwardedRequestIds.get(upstreamId);
        client.forwardedRequestIds.delete(upstreamId);
        data = rewriteRpcId(envelope, client.desktopRequestIds.get(originalId)?.idJson ?? JSON.stringify(originalId));
        rpcMessage = { ...rpcMessage, id: originalId };
        if (message) message = rpcMessage;
      } else if (this._liveIsInternalRequestId(upstreamId) && client.desktopRequestIds.get(upstreamId)?.upstreamId !== upstreamId) {
        this.outerRuntime.orphanResponse(client, message ?? rpcMessage);
        return;
      }
      const tracking = client.desktopRequestIds.get(rpcMessage.id);
      if (tracking?.upstreamId === upstreamId) {
        if (Object.hasOwn(rpcMessage, "error")) this.modelRecovery?.rejectExpectedTurn?.(client, upstreamId, metadataGeneration);
        desktopResponse = { requestId: rpcMessage.id, method: tracking.method };
        const budgetError = createDesktopResponseBudgetError({ requestId: rpcMessage.id, method: tracking.method,
          responseBytes: originalByteLength, limit: this.maxDesktopResponseBytes ?? DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES });
        if (originalByteLength > 1024 * 1024) this.onEvent({ type: "desktop_large_rpc_response",
          requestId: rpcMessage.id, method: tracking.method, threadId: tracking.threadId,
          includeTurns: tracking.includeTurns, bytes: originalByteLength, blocked: Boolean(budgetError),
          connectionGeneration: metadataGeneration });
        if (budgetError) {
          rpcMessage = budgetError;
          message = budgetError;
          data = JSON.stringify(budgetError);
          isBinary = false;
        }
        if (client.initializationRequestId !== null && rpcMessage.id === client.initializationRequestId && !rpcMessage.error) {
          client.initialized = true;
          client.initializedUpstream = upstream;
        }
        client.turnObserver.observeUpstream(rpcMessage);
        client.desktopRequestBytes -= tracking.bytes;
        client.desktopRequestIds.delete(rpcMessage.id);
      }
    } else if (typeof rpcMessage.method === "string" && !Object.hasOwn(rpcMessage, "id")) {
      const recoverySubscribed = this.modelRecovery?.observeNative(client, rpcMessage, metadataGeneration) === true;
      if (this.onNativeTurn && ["turn/started", "turn/completed"].includes(rpcMessage.method)) {
        try {
          Promise.resolve(this.onNativeTurn(structuredClone(rpcMessage), {
            ...(recoverySubscribed ? { connectionGeneration: metadataGeneration } : {}),
          })).catch(error => this._liveRecordError("native_turn_observer", error));
        } catch (error) { this._liveRecordError("native_turn_observer", error); }
      }
      client.turnObserver.observeUpstream(rpcMessage);
    }
    const projected = this.outerRuntime.upstream(client, message ?? rpcMessage, { projectionMessage: message });
    if (!projected && message) return;
    if (client.downstream.readyState === this.WebSocketImpl.OPEN) {
      const payload = projected !== message ? JSON.stringify(projected) : data;
      this._liveSendOrClose(client, client.downstream, payload, isBinary, "upstream_to_downstream", desktopResponse);
    }
  }

  _liveUpstreamOpened(client, upstream) {
    if (client.closed || client.upstream !== upstream) return;
    client.reconnectAttempt = 0;
    client.nextReconnectAt = null;
    client.upstreamAlive = true;
    client.hasConnectedBefore = true;
    client.upstreamReady = true;
    this.lastError = null;
    this._liveFlushQueuedMessages(client, upstream);
    this.onEvent({ type: "upstream_connected", connectedAt: client.connectedAt, restored: false });
  }

  pauseUpstream() {
    this.upstreamPaused = true;
    for (const client of [...this.clients]) {
      if (!client.upstream) continue;
      const upstream = client.upstream;
      upstream.terminate?.();
      this._liveHandleUpstreamDisconnect(client, upstream, "managed_upstream_restarting");
    }
  }

  setUpstreamUrl(value) {
    const target = new URL(value);
    if (target.protocol !== "ws:" || target.hostname !== "127.0.0.1" || !target.port
      || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
      throw new CodexAppServerProxyError("INVALID_UPSTREAM_URL", "受管 App Server 地址必须是本机回环 WebSocket 端口");
    }
    this.pauseUpstream();
    this.upstreamUrl = value;
  }

  resumeUpstream() {
    this.upstreamPaused = false;
    for (const client of this.clients) this._liveConnectUpstream(client);
  }

  _liveConnectUpstream(client) {
    if (
      client.closed
      || this.closed
      || this.upstreamPaused
      || client.downstream.readyState >= this.WebSocketImpl.CLOSING
      || [this.WebSocketImpl.CONNECTING, this.WebSocketImpl.OPEN].includes(client.upstream?.readyState)
    ) return;
    if (client.reconnectTimer) {
      clearTimeout(client.reconnectTimer);
      client.reconnectTimer = null;
    }
    client.nextReconnectAt = null;
    const upstream = new this.WebSocketImpl(this.upstreamUrl, { maxPayload: this.maxWebSocketPayloadBytes });
    client.upstream = upstream;
    const metadataGeneration = this._liveNewMetadataGeneration() ?? (this.modelRecovery ? crypto.randomUUID() : null);
    client.metadataUpstreamGeneration = metadataGeneration;
    upstream.on("open", () => this._liveUpstreamOpened(client, upstream));
    upstream.on("message", (data, isBinary) => this._liveReceiveUpstream(client, upstream, metadataGeneration, data, isBinary));
    upstream.on("close", () => this._liveHandleUpstreamDisconnect(client, upstream, "upstream_closed"));
    upstream.on("error", (error) => this._liveHandleUpstreamDisconnect(client, upstream, "upstream_error", error));
    upstream.on("pong", () => { client.upstreamAlive = true; });
  }

  _liveCheckHeartbeats() {
    for (const client of [...this.clients]) {
      if (client.closed) continue;
      if (client.downstream.readyState === this.WebSocketImpl.OPEN) {
        if (!client.downstreamAlive) {
          client.downstream.terminate?.();
          this._liveCloseClient(client, "downstream_heartbeat_timeout", new CodexAppServerProxyError(
            "DOWNSTREAM_HEARTBEAT_TIMEOUT",
            "Codex Desktop WebSocket 心跳超时",
          ), 1012);
          continue;
        }
        client.downstreamAlive = false;
        client.downstream.ping?.();
      }
      if (client.upstream?.readyState === this.WebSocketImpl.OPEN) {
        if (!client.upstreamAlive) {
          const upstream = client.upstream;
          upstream.terminate?.();
          this._liveHandleUpstreamDisconnect(client, upstream, "upstream_heartbeat_timeout", new CodexAppServerProxyError(
            "UPSTREAM_HEARTBEAT_TIMEOUT",
            "Codex App Server WebSocket 心跳超时",
          ));
          continue;
        }
        client.upstreamAlive = false;
        client.upstream.ping?.();
      }
    }
  }

  _liveHandleUpstreamDisconnect(client, upstream, reason, error = null) {
    if (client.closed || client.upstream !== upstream) return;
    this._liveCloseMetadataConnection(client.metadataUpstreamGeneration);
    client.metadataUpstreamGeneration = null;
    client.upstream = null;
    client.upstreamReady = false;
    for (const pending of client.injected.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerProxyError(
        "UPSTREAM_RECONNECTING",
        `App Server 上游连接中断，透明中转正在恢复：${reason}`,
        { outcomeUnknown: pending.mutating && pending.written, details: { method: pending.method } },
      ));
    }
    client.injected.clear();
    if (client.hasConnectedBefore) {
      this.lastIncident = {
        at: new Date().toISOString(),
        code: "UPSTREAM_SESSION_LOST",
        reason,
        error: error ? publicError(error) : null,
      };
      this.onEvent({ type: "upstream_session_lost", incident: this.lastIncident });
      this._liveCloseClient(client, "upstream_session_lost", error, 1012);
      return;
    }
    if (error) this._liveRecordError(reason, error);
    this._liveScheduleReconnect(client, reason);
  }

  _liveFlushQueuedMessages(client, upstream) {
    if (client.closed || client.upstream !== upstream || upstream.readyState !== this.WebSocketImpl.OPEN) return;
    while (client.queued.length && !client.turnPreflightPending) {
      const queued = client.queued.shift();
      client.queuedBytes -= queued.bytes;
      this._liveForwardDesktopMessage(client, upstream, queued);
      if (client.closed) break;
    }
    if (!client.queued.length) client.queuedBytes = 0;
  }

  _liveForwardDesktopMessage(client, upstream, queued) {
    const observation = queued.observation;
    if (NATIVE_TURN_START_METHODS.has(observation.method) && !observation.threadId) {
      const envelope = this._liveReadRpcEnvelope(client, queued.data, "queued");
      if (!envelope) return;
      observation.threadId = envelope.message.params?.threadId;
    }
    const forward = () => {
      if (client.closed || client.upstream !== upstream) return;
      if (this._liveSendOrClose(client, upstream, queued.data, queued.isBinary, "downstream_to_upstream")) {
        if (NATIVE_TURN_START_METHODS.has(observation.method)) this.modelRecovery?.expectTurn(client, observation.threadId,
          client.desktopRequestIds.get(observation.id)?.upstreamId ?? observation.id, client.metadataUpstreamGeneration);
        client.turnObserver.markForwarded(observation);
      }
    };
    if (!NATIVE_TURN_START_METHODS.has(observation.method) || !observation.threadId || !this.managedInnerControl) {
      forward();
      return;
    }
    client.turnPreflightPending = true;
    client.turnPreflightBytes = queued.bytes;
    const recoverBeforeTurn = this._liveRecoverBeforeTurn.bind(this);
    const connectionActive = () => !client.closed && client.upstream === upstream && upstream.readyState === this.WebSocketImpl.OPEN;
    Promise.resolve().then(() => {
      const tracking = client.desktopRequestIds.get(observation.id);
      if (!tracking) throw new Error("INNER_TURN_REQUEST_ID_REQUIRED");
      return recoverBeforeTurn(client, observation.threadId);
    }).then(forward, error => {
      if (!connectionActive()) return;
      const tracking = client.desktopRequestIds.get(observation.id);
      if (tracking) {
        client.desktopRequestBytes -= tracking.bytes;
        client.desktopRequestIds.delete(observation.id);
        client.forwardedRequestIds.delete(tracking.upstreamId);
      }
      const response = { jsonrpc: "2.0", id: observation.id, error: { code: -32001,
        message: "Previous turn recovery could not be confirmed; this turn was not started",
        data: { reason: error.code ?? error.message } } };
      client.turnObserver.observeUpstream(response);
      this.outerRuntime.upstream(client, response, { projectionMessage: response });
      this._liveSendOrClose(client, client.downstream, JSON.stringify(response), false, "turn_preflight_error");
      this.onEvent({ type: "turn_preflight_rejected", threadId: observation.threadId, reason: error.code ?? error.message });
    }).finally(() => {
      client.turnPreflightPending = false;
      client.turnPreflightBytes = 0;
      if (connectionActive()) this._liveFlushQueuedMessages(client, upstream);
    }).catch(error => this._liveCloseClient(client, "turn_preflight_failed", error));
  }

  _liveRecoverBeforeTurn(client, threadId) {
    if (!this.managedInnerControl) return Promise.resolve();
    const upstream = client.upstream;
    const connectionActive = () => !client.closed && client.upstream === upstream
      && upstream.readyState === this.WebSocketImpl.OPEN && client.initialized === true
      && (client.initializedUpstream === undefined || client.initializedUpstream === upstream);
    return this.managedInnerControl.dispatch("recover-before-turn", { threadId }, {
      connectionActive,
      lookupTurns: params => {
        if (!connectionActive()) throw new Error("INNER_TURN_RECOVERY_CONNECTION_CHANGED");
        return this._liveInjectRequest(client, "thread/turns/list", params, { timeoutMs: 1250 });
      },
    });
  }

  _liveReadRpcEnvelope(client, data, source) {
    try {
      return scanRpcEnvelope(data, this.maxJsonParseBytes);
    } catch (error) {
      this._liveCloseClient(client, `${source}_protocol_error`, error instanceof CodexAppServerProxyError ? error
        : new CodexAppServerProxyError("APP_SERVER_PROTOCOL_ERROR", "RPC JSON envelope 无法解析", { cause: error }), 1002);
      return null;
    }
  }

  _liveSendOrClose(client, socket, data, isBinary, source, desktopResponse = null) {
    if (client.closed || socket.readyState !== this.WebSocketImpl.OPEN) return false;
    if (socket === client.downstream) {
      const limit = boundedInteger(this.maxDesktopTransportBytes, DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES,
        1, DEFAULT_DESKTOP_TRANSPORT_LIMIT_BYTES);
      const bytes = messageByteLength(data);
      if (bytes > limit) {
        let replacement = null;
        if (desktopResponse) {
          let finalMessage = null;
          try { finalMessage = scanRpcEnvelope(data, this.maxJsonParseBytes).message; } catch {}
          if (isRpcResponse(finalMessage) && finalMessage.id === desktopResponse.requestId) {
            replacement = createDesktopTransportBudgetError({ ...desktopResponse, responseBytes: bytes, limit });
          }
        }
        const replacementPayload = replacement ? JSON.stringify(replacement) : null;
        const replacementBytes = replacementPayload === null ? null : messageByteLength(replacementPayload);
        const replaced = replacementBytes !== null && replacementBytes <= limit;
        this.onEvent({ type: "desktop_transport_budget_exceeded", bytes, limit, replaced, replacementBytes,
          method: desktopResponse?.method?.slice(0, 128) ?? null });
        if (!replaced) {
          this._liveCloseClient(client, "desktop_transport_budget_exceeded", new CodexAppServerProxyError(
            "DESKTOP_TRANSPORT_BUDGET_EXCEEDED", "Desktop 下行消息超过传输上限，已关闭当前客户端连接",
            { details: { bytes, limit, replacementBytes } },
          ), 1009);
          return false;
        }
        data = replacementPayload;
        isBinary = false;
      }
    }
    if ((socket.bufferedAmount ?? 0) > this.maxBufferedBytes) {
      this._liveCloseClient(client, `${source}_backpressure`, new CodexAppServerProxyError(
        "WEBSOCKET_BACKPRESSURE",
        `WebSocket 待发送数据超过 ${this.maxBufferedBytes} 字节，已关闭连接以触发权威重连`,
      ), 1013);
      return false;
    }
    socket.send(data, { binary: isBinary }, (error) => {
      if (error) this._liveCloseClient(client, `${source}_write_failed`, error, 1011);
    });
    return true;
  }

  _liveScheduleReconnect(client, reason) {
    if (client.closed || this.closed || client.reconnectTimer) return;
    client.reconnectAttempt += 1;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectInitialMs * (2 ** Math.min(client.reconnectAttempt - 1, 10)),
    );
    client.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    this.onEvent({
      type: "upstream_reconnect_scheduled",
      reason,
      attempt: client.reconnectAttempt,
      delayMs,
      connectedAt: client.connectedAt,
    });
    client.reconnectTimer = setTimeout(() => {
      client.reconnectTimer = null;
      this._liveConnectUpstream(client);
    }, delayMs);
  }

  _liveIsInternalRequestId(id) {
    return Number.isSafeInteger(id) && id <= FIRST_INJECTED_REQUEST_ID && id > this.nextInjectedRequestId;
  }

  _liveAllocateRequestId(client) {
    let id;
    do {
      id = this.nextInjectedRequestId;
      this.nextInjectedRequestId -= 1;
    } while (client.injected.has(id) || client.desktopRequestIds.has(id) || client.forwardedRequestIds.has(id));
    return id;
  }

  _liveInjectRequest(client, method, params, options = {}) {
    if (NATIVE_TURN_START_METHODS.has(method) && params?.threadId && !options.turnRecoveryChecked) {
      const recoverBeforeTurn = this._liveRecoverBeforeTurn.bind(this);
      const injectRequest = this._liveInjectRequest.bind(this);
      return Promise.resolve().then(() => recoverBeforeTurn(client, params.threadId)).then(() => {
        if (client.closed) throw new CodexAppServerProxyError("UPSTREAM_NOT_OPEN", "App Server 连接已关闭");
        return injectRequest(client, method, params, { ...options, turnRecoveryChecked: true });
      });
    }
    if (client.upstream?.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.reject(new CodexAppServerProxyError("UPSTREAM_NOT_OPEN", "App Server 上游连接未就绪"));
    }
    const id = this._liveAllocateRequestId(client);
    const timeoutMs = boundedInteger(options.timeoutMs, this.requestTimeoutMs, 250, 300000);
    return new Promise((resolve, reject) => {
      const pending = {
        id,
        method,
        mutating: Boolean(options.mutating),
        outerEntry: options.outerEntry,
        written: false,
        resolve,
        reject,
        timeout: null,
      };
      pending.timeout = setTimeout(() => {
        if (!client.injected.delete(id)) return;
        this.outerRuntime.forgetRequest(client, id, { retainTurn: pending.mutating && pending.written });
        reject(new CodexAppServerProxyError(
          "APP_SERVER_TIMEOUT",
          `App Server 在 ${timeoutMs}ms 内未响应：${method}`,
          { outcomeUnknown: pending.mutating && pending.written, details: { method, id } },
        ));
      }, timeoutMs);
      client.injected.set(id, pending);
      try {
        this.outerRuntime.injectedRequest(client, { id, method, params }, options.outerEntry);
        const request = { jsonrpc: "2.0", id, method, params };
        const payload = JSON.stringify(request);
        this._liveObserveRequestMetadata("downstream", client.metadataUpstreamGeneration, request, messageByteLength(payload));
        client.upstream.send(payload);
        pending.written = true;
        if (NATIVE_TURN_START_METHODS.has(method)) this.modelRecovery?.expectTurn(client, params?.threadId, id, client.metadataUpstreamGeneration);
        this.displayPolicyControl.observeRpc("written", id, method);
      } catch (cause) {
        client.injected.delete(id);
        this.outerRuntime.forgetRequest(client, id);
        clearTimeout(pending.timeout);
        reject(new CodexAppServerProxyError(
          "APP_SERVER_WRITE_FAILED",
          `无法向 App Server 写入请求：${method}`,
          { cause, outcomeUnknown: pending.mutating, details: { method, id } },
        ));
      }
    });
  }

  _liveCloseClient(client, reason, error = null, closeCode = 1000) {
    if (client.closed) return;
    client.closed = true;
    this.modelRecovery?.closeClient(client);
    this._liveCloseMetadataConnection(client.metadataDownstreamGeneration);
    this._liveCloseMetadataConnection(client.metadataUpstreamGeneration);
    client.metadataDownstreamGeneration = null;
    client.metadataUpstreamGeneration = null;
    client.upstreamReady = false;
    client.nextReconnectAt = null;
    client.queued.length = 0;
    client.queuedBytes = 0;
    this.outerRuntime.closeClient(client);
    client.wakeVisibility.close();
    client.displayPolicy.close();
    this.clients.delete(client);
    client.reasoningPlaceholder.close();
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    client.reconnectTimer = null;
    client.turnObserver.close(reason);
    for (const pending of client.injected.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerProxyError(
        "CONNECTION_CLOSED",
        `透明中转连接已关闭：${reason}`,
        { outcomeUnknown: pending.mutating && pending.written, details: { method: pending.method } },
      ));
    }
    client.injected.clear();
    client.desktopRequestIds.clear();
    client.desktopRequestBytes = 0;
    client.forwardedRequestIds.clear();
    if (client.downstream.readyState < this.WebSocketImpl.CLOSING) {
      client.downstream.close(closeCode, String(reason).slice(0, 120));
    }
    if (client.upstream?.readyState < this.WebSocketImpl.CLOSING) client.upstream.close();
    if (error) this._liveRecordError(reason, error);
    this.onEvent({ type: "client_closed", reason, connectedAt: client.connectedAt });
  }

  async _liveHandleControlRequest(request, response) {
    response.setHeader("content-type", "application/json; charset=utf-8");
    const requestUrl = new URL(request.url ?? "/", `http://${this.controlHost === "::1" ? "[::1]" : this.controlHost}:${this.controlPort}`);
    if (requestUrl.pathname.startsWith("/v1/inner/")) {
      response.setHeader("cache-control", "no-store");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-content-type-options", "nosniff");
      const port = this.controlServer?.address()?.port ?? this.controlPort;
      const origin = `http://${this.controlHost === "::1" ? "[::1]" : this.controlHost}:${port}`;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)
        || request.headers.host !== new URL(origin).host
        || (request.headers.origin && request.headers.origin !== origin)
        || request.headers["sec-fetch-site"] === "cross-site") {
        response.statusCode = 403;
        response.end(JSON.stringify({ ok: false, error: { code: "INNER_CONTROL_SAME_ORIGIN_REQUIRED" } }));
        return;
      }
      if (requestUrl.pathname === "/v1/inner/recovery") {
        if (!this.managedInnerControl || request.method !== "GET" || requestUrl.search) {
          response.statusCode = !this.managedInnerControl ? 404 : requestUrl.search ? 400 : 405;
          response.end(JSON.stringify({ ok: false, error: { code: "INNER_RECOVERY_PAGE_UNAVAILABLE" } }));
          return;
        }
        const nonce = crypto.randomBytes(24).toString("hex");
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
        response.setHeader("x-frame-options", "DENY");
        response.setHeader("cross-origin-opener-policy", "same-origin");
        const { renderInnerRecoveryControlPage } = await import("./inner-recovery-control-page.mjs");
        response.end(renderInnerRecoveryControlPage(nonce));
        return;
      }
    }
    const authorization = String(request.headers.authorization ?? "");
    const expectedAuthorization = `Bearer ${this.controlToken}`;
    const authorized = authorization.length === expectedAuthorization.length
      && crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expectedAuthorization));
    if (!authorized) throw new CodexAppServerProxyError("UNAUTHORIZED", "代理控制口令不正确");
    if (/^\/v1\/inner\/(status|prepare|migrate|activate|rollback|reconcile-terminal|continue-http)$/.test(requestUrl.pathname)) {
      if (!this.managedInnerControl) {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: { code: "INNER_MANAGED_CONTROL_DISABLED" } }));
        return;
      }
      try {
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) throw new Error("INNER_CONTROL_LOOPBACK_REQUIRED");
        const method = requestUrl.pathname.split("/").at(-1);
        if ((method === "status" && request.method !== "GET") || (method !== "status" && request.method !== "POST")) throw new Error("INNER_CONTROL_METHOD_INVALID");
        let input;
        if (method === "status") input = { ownerId: request.headers["x-inner-owner-id"], nativeSourceId: request.headers["x-inner-native-source-id"],
          instanceToken: request.headers["x-inner-instance-token"] };
        else {
          if (Number(request.headers["content-length"] ?? 0) > 16 * 1024) {
            request.resume();
            throw new CodexAppServerProxyError("BODY_TOO_LARGE", "控制请求正文过大");
          }
          const body = await this._liveReadBody(request, 16 * 1024);
          if (!body.trim()) throw new Error("INNER_CONTROL_BODY_REQUIRED");
          input = JSON.parse(body);
          if (!isObject(input)) throw new Error("INNER_CONTROL_REQUEST_INVALID");
        }
        const context = this.status();
        const result = await this.managedInnerControl.dispatch(method, input, { outerBusy: context.clients.some(client =>
          client.pendingInjectionCount > 0 || client.queuedMessageCount > 0 || client.downstreamBufferedBytes > 0 || client.upstreamBufferedBytes > 0) });
        response.statusCode = result.httpStatus ?? 200;
        response.end(JSON.stringify(result));
      } catch (error) {
        response.statusCode = error.code === "BODY_TOO_LARGE" ? 413 : /NOT_READY|BUSY/.test(error.message) ? 503 : 409;
        response.end(JSON.stringify({ ok: false, error: { code: error.code ?? error.message } }));
      }
      return;
    }
    if (requestUrl.pathname === "/v1/full-runtime" && request.method === "GET") {
      response.end(JSON.stringify({ ok: true, ...this.liveCodeRuntime.status() }));
      return;
    }
    if (request.method === "POST" && /^\/v1\/full-runtime\/(register|prepare|activate|restore)$/.test(requestUrl.pathname)) {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) throw new Error("LIVE_CODE_LOOPBACK_REQUIRED");
      const input = JSON.parse(await this._liveReadBody(request, 16 * 1024));
      const result = await this.liveCodeRuntime[requestUrl.pathname.split("/").at(-1)](input);
      response.end(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/request-metadata") {
      response.end(JSON.stringify(this.requestMetadataSnapshot()));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/outer-runtime") {
      response.end(JSON.stringify({ ok: true, ...this.outerRuntime.status() }));
      return;
    }
    if (request.method === "POST" && /^\/v1\/outer-runtime\/(prepare|activate|restore)$/.test(requestUrl.pathname)) {
      try {
        if (!this.outerRuntime.status().enabled) throw new Error("OUTER_RUNTIME_CONTROL_DISABLED");
        const input = JSON.parse(await this._liveReadBody(request));
        if (!isObject(input)) throw new Error("OUTER_RUNTIME_REQUEST_INVALID");
        const result = await this.outerRuntime[requestUrl.pathname.split("/").at(-1)](input);
        response.end(JSON.stringify({ ok: true, ...result }));
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: { code: error.code ?? error.message, message: error.message } }));
      }
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/v1/display-policy") {
      response.end(JSON.stringify({ ok: true, ...this.displayPolicyControl.status() }));
      return;
    }
    if (request.method === "POST" && /^\/v1\/display-policy\/(prepare|activate|restore|discard)$/.test(requestUrl.pathname)) {
      let result;
      try {
        const input = JSON.parse(await this._liveReadBody(request));
        result = await this.displayPolicyControl[requestUrl.pathname.split("/").at(-1)](input);
        result = { ...result, busy: this.displayPolicyControl.status().busy };
      } catch (error) {
        result = { ok: false, httpStatus: 400, error: { code: "INVALID_DISPLAY_POLICY_REQUEST", message: String(error.message ?? error) } };
      }
      response.statusCode = result.httpStatus ?? 200;
      response.end(JSON.stringify({ ...result, httpStatus: undefined }));
      return;
    }
    if (request.method === "GET" && ["/status", "/v1/status"].includes(requestUrl.pathname)) {
      response.end(JSON.stringify(this.status()));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/v1/wakes/")) {
      const wakeId = decodeURIComponent(requestUrl.pathname.slice("/v1/wakes/".length));
      response.end(JSON.stringify({ ok: true, wake: this.journal?.getWake?.(wakeId) ?? null }));
      return;
    }
    const postRoutes = ["/subscribe", "/wake", "/v1/subscriptions", "/v1/wakes", "/v1/threads/inspect"];
    if (request.method !== "POST" || !postRoutes.includes(requestUrl.pathname)) {
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "控制接口不存在" } }));
      return;
    }
    const body = await this._liveReadBody(request);
    const input = JSON.parse(body || "{}");
    const result = requestUrl.pathname === "/v1/threads/inspect"
      ? await this.inspectThread(input.threadId)
      : requestUrl.pathname === "/subscribe"
        ? await this.subscribeThread(input.threadId)
      : requestUrl.pathname === "/v1/subscriptions"
        ? await this.subscribeTask(input)
        : await this.wakeThread(input);
    response.end(JSON.stringify({
      ok: true,
      ...result,
      readyClients: undefined,
      results: undefined,
    }));
  }

  async _liveReadBody(request, maximumBytes = this.maxBodyBytes) {
    let total = 0;
    const chunks = [];
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maximumBytes) {
        throw new CodexAppServerProxyError("BODY_TOO_LARGE", "控制请求正文过大");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  _liveRecordError(source, error) {
    this.lastError = {
      at: new Date().toISOString(),
      source,
      ...publicError(error),
    };
    this.onEvent({ type: "proxy_error", error: this.lastError });
  }

  _liveWaitForListening(server, name) {
    if (server.address()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (cause) => {
        cleanup();
        reject(new CodexAppServerProxyError("LISTEN_FAILED", `${name} 监听失败：${cause.message}`, { cause }));
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
  }

  _liveListenHttp(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (cause) => {
        server.off("listening", onListening);
        reject(new CodexAppServerProxyError("LISTEN_FAILED", `控制端口监听失败：${cause.message}`, { cause }));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  }

  _liveCloseServer(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

export function createCodexAppServerProxy(options = {}) {
  return new CodexAppServerProxy(options);
}
