import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { createRequestInspector, RequestInspectionError } from "./request-body-inspector.mjs";
import { collectRequestBody, createRequestBodyOwner, createRequestBufferBudget } from "./request-body-buffer.mjs";
import { createRequestObservation } from "./model-observation-hooks.mjs";
import { correlationQuality, hashIdentity } from "./observability-utils.mjs";
import { createStreamRecovery, waitForRetry, waitForRecoveryAction } from "./codex-stream-recovery.mjs";
import { createToolPreparationDeadline } from "./tool-preparation-deadline.mjs";
import { createReasoningProgressTracker } from "./reasoning-progress.mjs";
import { partialResponsesSseProgress } from "./partial-response-progress.mjs";
import { parseToolDeliveryProfile, toolIdentityHash } from "./tool-delivery-profile.mjs";
import { createAdaptiveDeliveryRegistry, deliveryProfileKey } from "./adaptive-delivery.mjs";
import { createRequestProgressTracker, createRequestWaitBudget, mergeRequestProgressState, mergeRequestWaitState, requestUploadAllowanceMs, DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB, MAX_UPLOAD_ALLOWANCE_MS } from "./request-wait-budget.mjs";
import { createThreadRecoveryHandoff } from "./thread-recovery-handoff.mjs";
import { createModelStreamFailureDiagnostics } from "./model-stream-failure-diagnostics.mjs";
import { classifyModelFailure } from "./model-failure-policy.mjs";
import { createModelOperationLedger } from "./model-operation-ledger.mjs";

const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 40_000;
const DEFAULT_PROGRESS_IDLE_TIMEOUT_MS = 40_000;
const DEFAULT_FIRST_LAST_PROGRESS_TIMEOUT_MS = 60_000;
const DEFAULT_REASONING_PROGRESS_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_RAPID_RETRY_MINIMUM_MS = 70_000;
export function nativeRetryDelay({ elapsedMs, attemptNumber, maxConsecutiveAttempts, chainElapsedMs,
  rapidRetryMinimumMs, fastRetryThresholdMs = 8000, fastRetryDelayMs = 30000 }) {
  const fast = Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= fastRetryThresholdMs;
  const finalGap = attemptNumber === 5 && maxConsecutiveAttempts >= 6
    ? Math.max(0, rapidRetryMinimumMs - chainElapsedMs) : 0;
  return { delayMs: Math.max(fast ? fastRetryDelayMs : 0, finalGap),
    fast, fastRetryThresholdMs, fastRetryDelayMs, finalGapMs: finalGap };
}
const DEFAULT_RETRY_PROGRESS_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_COMPACTION_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_DECODED_REQUEST_BYTES = 192 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_REQUEST_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_ATTEMPTS = 6;
const MAX_LOCAL_TOOL_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [0, 0, 0, 0, 0];
const DEFAULT_ATTEMPT_STATE_TTL_MS = 30 * 60_000;
const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
const MAX_METADATA_HEADER_BYTES = 64 * 1024;
const COMPACTION_CONTROL_TYPES = new Set(["compaction", "compaction_trigger", "context_compaction", "compaction_summary"]);
const CONTEXT_CONTROL_FUNCTION_NAMES = new Set(["new_context", "functions.new_context"]);
const RETRY_SAFE_REASONING_DELTAS = new Set(["response.reasoning_summary_text.delta", "response.reasoning_text.delta"]);
const IMPLEMENTATION_VERSION = "2026-10-03.1";
const SAFETY_POLICY_NOTICE = "触发栅栏检查，可能是误报，请避免类似内容";
const LEGACY_SAFETY_POLICY_CODES = new Set(["bio_policy", "content_filter", "content_policy_violation"]);
const SAFETY_POLICY_CODES = new Set([...LEGACY_SAFETY_POLICY_CODES, "cyber_policy", "misalignment_policy_violation", "invalid_prompt"]);
const EXPLICIT_PERMANENT_CODES = new Set(["context_length_exceeded"]);
const NETWORK_EXHAUSTED_NOTICE = "\n\n本次模型响应未完成，已有信息已保留，请继续。";
const CAPACITY_EXHAUSTED_NOTICE = "\n\n当前模型暂时满载，已自动尝试六次仍未恢复，请稍后重试或切换模型。";
const USAGE_LIMIT_NOTICE = "\n\n当前账号额度已耗尽，请等待额度恢复、购买额外额度或切换账号。";
const PERMANENT_FAILURE_NOTICE = "\n\n本次模型响应因不可重试错误未完成，已有信息已保留，请继续。";
const LOCAL_REQUEST_TOO_LARGE_NOTICE = "\n\n本次请求体超过本地中转上限，未发送到上游，已停止重复重试；请减少本轮图片或上下文后继续。";
const INTERRUPTED_AFTER_PROGRESS_NOTICE = "\n\n模型流在已产生内容或工具调用后中断。为避免重复执行，本轮已停止，请重新发送。";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const CAPACITY_CODES = new Set(["server_is_overloaded", "server_overloaded", "model_at_capacity"]);
const USAGE_LIMIT_CODES = new Set([
  "usage_limit_reached",
  "usage_limit_exceeded",
  "quota_exceeded",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "usage_not_included",
]);
const TRANSIENT_CODES = new Set([
  "rate_limit_exceeded",
  "server_error",
  "service_unavailable",
  "slow_down",
  "timeout",
  ...CAPACITY_CODES,
]);
const EXPLICIT_PERMANENT_CODE = /(?:auth|unauthori[sz]ed|forbidden|permission|invalid|bad_request|unsupported|not_found)/iu;
const EXPLICIT_PERMANENT_MESSAGE = /(?:invalid (?:request|api key|authorization)|authentication(?: failed)?|unauthori[sz]ed|forbidden|permission denied)/iu;

function integerOption(value, fallback, minimum, maximum, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function headerByteLength(headers, name) {
  const value = headerValue(headers, name);
  return value === undefined ? null : Buffer.byteLength(String(value), "utf8");
}

function requestPathForLog(url) {
  try {
    return new URL(url ?? "/", "http://localhost").pathname.slice(0, 256);
  } catch {
    return String(url ?? "").split("?")[0].slice(0, 256) || null;
  }
}

function summarizeRequestHeaders(headers) {
  return {
    accept: String(headerValue(headers, "accept") ?? "").slice(0, 128) || null,
    contentType: String(headerValue(headers, "content-type") ?? "").slice(0, 128) || null,
    connection: String(headerValue(headers, "connection") ?? "").slice(0, 64) || null,
    upgrade: String(headerValue(headers, "upgrade") ?? "").slice(0, 64) || null,
    hasAuthorization: headerByteLength(headers, "authorization") !== null,
    hasCookie: headerByteLength(headers, "cookie") !== null,
    codexTurnMetadataBytes: headerByteLength(headers, "x-codex-turn-metadata"),
    codexTurnStateBytes: headerByteLength(headers, "x-codex-turn-state"),
  };
}

function summarizeUpstreamHeaders(headers) {
  return {
    contentType: String(headerValue(headers, "content-type") ?? "").slice(0, 128) || null,
    codexTurnStateBytes: headerByteLength(headers, "x-codex-turn-state"),
    codexTurnMetadataBytes: headerByteLength(headers, "x-codex-turn-metadata"),
    requestIdBytes: headerByteLength(headers, "x-request-id") ?? headerByteLength(headers, "request-id"),
    cfRayBytes: headerByteLength(headers, "cf-ray"),
  };
}

function parseTurnMetadata(headers) {
  const raw = headerValue(headers, "x-codex-turn-metadata");
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_METADATA_HEADER_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function classifyCodexModelRequest(request) {
  const metadata = parseTurnMetadata(request?.headers ?? {});
  const pathname = String(request?.url ?? "").split("?")[0].replace(/\/+$/u, "");
  const fallbackKind = request?.method === "POST" && /\/responses(?:\/compact)?$/u.test(pathname)
    ? (pathname.endsWith("/compact") ? "compaction" : "turn")
    : null;
  const requestKind = typeof metadata?.request_kind === "string" ? metadata.request_kind : fallbackKind;
  return {
    requestKind,
    guarded: requestKind === "turn" || requestKind === "compaction",
    threadId: typeof metadata?.thread_id === "string" ? metadata.thread_id : null,
    turnId: typeof metadata?.turn_id === "string" ? metadata.turn_id : null,
  };
}

function compactionTransport(targetUrl, payload, headers) {
  const pathname = targetUrl.pathname.replace(/\/+$/u, "");
  const wantsSse = payload?.stream === true || /text\/event-stream/iu.test(String(headerValue(headers, "accept") ?? ""));
  if (/\/responses\/compact$/iu.test(pathname)) return wantsSse ? "remote_sse" : "remote_unary";
  return wantsSse ? "sampling_sse" : "remote_unary";
}

function successfulUnaryJson(body, observation = null) {
  try {
    const value = JSON.parse(body.toString("utf8"));
    observation?.json(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (value.error || value.response?.error) return false;
    return Boolean(value.output || value.compaction || value.response || value.id);
  } catch {
    return false;
  }
}

function frameData(frame) {
  return frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function parseSseFrame(frame) {
  const data = frameData(frame);
  if (!data) return { event: null, type: null, doneMarker: false };
  if (data.trim() === "[DONE]") return { event: null, type: "[DONE]", doneMarker: true };
  try {
    const event = JSON.parse(data);
    return { event, type: typeof event?.type === "string" ? event.type : null, doneMarker: false };
  } catch {
    return { event: null, type: null, doneMarker: false };
  }
}

function isToolResponseItem(item) {
  const type = typeof item?.type === "string" ? item.type : "";
  return Boolean(type) && type !== "message" && type !== "reasoning" && !COMPACTION_CONTROL_TYPES.has(type);
}

function eventPayloadHasContent(event) {
  if (!event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "response.completed") return true;
  if (type === "response.output_item.done") {
    const content = event.item?.content;
    if (Array.isArray(content) && content.some((item) => typeof item?.text === "string" && item.text.length > 0)) return true;
    if (isToolResponseItem(event.item)) {
      return ["arguments", "input", "code", "output"].some(key => typeof event.item[key] === "string" && event.item[key].length > 0);
    }
  }
  if (!type.endsWith(".delta")) return false;
  for (const key of ["delta", "text", "arguments", "input", "code"]) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

function isResponsesProtocolType(type) {
  return type === "[DONE]" || type === "error" || type.startsWith("response.");
}

export function isMeaningfulResponsesSseFrame(frame) {
  const parsed = parseSseFrame(frame);
  return parsed.event ? eventPayloadHasContent(parsed.event) : false;
}

function isToolEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (isToolResponseItem(event.item)) return true;
  const type = typeof event.type === "string" ? event.type : "";
  return /(?:function|custom_tool|local_shell|web_search|file_search|computer|mcp|tool_search|image_generation)_call/iu.test(type);
}

function isExecutableToolDone(event) {
  return event?.type === "response.output_item.done" && isToolResponseItem(event.item);
}

function isIndependentKeepalive(event) {
  if (!event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  return ["response.in_progress", "response.queued", "ping", "keepalive", "keep_alive", "heartbeat", "proxy.keepalive"].includes(type);
}

function eventHasSubstantiveWork(event) {
  if (!event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length > 0) return true;
  return type === "response.output_item.done"
    && Array.isArray(event.item?.content)
    && event.item.content.some((part) => typeof part?.text === "string" && part.text.length > 0);
}

function isRetrySafeReasoningProgress(event, completedReasoningProgress) {
  return completedReasoningProgress || (RETRY_SAFE_REASONING_DELTAS.has(event?.type)
    && typeof event.delta === "string" && event.delta.length > 0);
}

function responseFailureDetails(event) {
  const source = event?.response?.error ?? event?.error ?? event;
  const incompleteReason = typeof event?.response?.incomplete_details?.reason === "string" ? event.response.incomplete_details.reason : "";
  const rawCode = typeof source?.code === "string" ? source.code : incompleteReason || (typeof source?.type === "string" ? source.type : "");
  const rawMessage = typeof source?.message === "string" ? source.message : incompleteReason;
  const code = rawCode.trim().toLowerCase();
  const message = rawMessage.replace(/[\r\n]+/gu, " ").trim();
  const safetyPolicy = SAFETY_POLICY_CODES.has(code);
  const explicitPermanent = safetyPolicy || EXPLICIT_PERMANENT_CODES.has(code) || EXPLICIT_PERMANENT_CODE.test(code);
  const knownTransient = TRANSIENT_CODES.has(code) || /^(?:internal_server_error|internal_error|flex_unavailable)$/u.test(code);
  const usageLimit = !explicitPermanent && (USAGE_LIMIT_CODES.has(code)
    || (!knownTransient && !CAPACITY_CODES.has(code)
      && /you(?:'|’)ve hit your usage limit|codex\/settings\/usage|purchase more credits|quota exceeded/iu.test(message)));
  const capacity = !explicitPermanent && !usageLimit && (CAPACITY_CODES.has(code)
    || (!knownTransient && /selected model is at capacity|server overloaded/iu.test(message)));
  const permanent = explicitPermanent || (!knownTransient && !usageLimit && !capacity && EXPLICIT_PERMANENT_MESSAGE.test(message));
  const statusCode = source?.status ?? source?.status_code ?? event?.status ?? event?.status_code;
  return {
    code: code || null,
    message: message.slice(0, 512) || null,
    statusCode: Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : null,
    safetyPolicy,
    category: safetyPolicy ? "permanent" : usageLimit ? "usage_limit" : capacity ? "capacity" : permanent ? "permanent" : "transient",
  };
}

function safetyPolicyNotice(failure) {
  if (LEGACY_SAFETY_POLICY_CODES.has(failure.code)) return SAFETY_POLICY_NOTICE;
  const reasons = {
    cyber_policy: "上游网络安全策略拒绝",
    misalignment_policy_violation: "上游安全策略拒绝",
    invalid_prompt: "上游判定请求输入无效",
  };
  return `${reasons[failure.code]}（${failure.code}），本轮已停止，未继续自动重试。`;
}

function permanentFailureNotice(failure) {
  return failure?.code === "context_length_exceeded"
    ? "\n\n本次请求超过上游上下文长度限制，已停止自动重试，请缩减或压缩上下文后再试。"
    : PERMANENT_FAILURE_NOTICE;
}

function responseFailureDetailsFromBody(body, observation = null) {
  const text = body.toString("utf8").replace(/[\r\n]+/gu, " ").trim();
  if (!text) return { code: null, message: null, category: "transient" };
  try {
    const parsed = JSON.parse(text);
    observation?.json(parsed);
    return responseFailureDetails({ error: parsed?.error ?? parsed?.response?.error ?? parsed });
  } catch {
    return responseFailureDetails({ error: { message: text } });
  }
}

function retryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function createSseFrameParser(onFrame, options = {}) {
  const decoder = new StringDecoder("utf8");
  const maximumPendingBytes = options.maximumPendingBytes ?? DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const classifyPartialProgress = typeof options.classifyPartialProgress === "function" ? options.classifyPartialProgress : () => null;
  const onPartialProgress = typeof options.onPartialProgress === "function" ? options.onPartialProgress : () => {};
  const shouldPause = typeof options.shouldPause === "function" ? options.shouldPause : () => false;
  let pending = "";
  let pendingPartialProgress = null;
  let failed = false;
  let ending = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    pending = "";
    try {
      onError(error);
    } catch {
    }
  };
  const deliver = (wire, frame) => {
    if (failed) return;
    if (Buffer.byteLength(wire, "utf8") > maximumPendingBytes) {
      fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
      return;
    }
    try {
      onFrame(wire, frame);
    } catch (error) {
      fail(Object.assign(error instanceof Error ? error : new Error("SSE callback failed"), {
        code: error?.code ?? "SSE_CALLBACK_ERROR",
      }));
    }
  };
  const drain = (ending = false) => {
    if (failed) return;
    while (true) {
      if (shouldPause()) return;
      const match = /\r?\n\r?\n/u.exec(pending);
      if (!match) break;
      const frame = pending.slice(0, match.index);
      const wire = `${frame}${match[0]}`;
      pending = pending.slice(match.index + match[0].length);
      pendingPartialProgress = null;
      deliver(wire, frame);
      if (failed || shouldPause()) return;
    }
    if (ending && pending) {
      const frame = pending;
      pending = "";
      deliver(frame, frame);
    }
  };
  const observePartialProgress = () => {
    if (failed || !pending) {
      pendingPartialProgress = null;
      return;
    }
    let progress;
    try {
      progress = classifyPartialProgress(pending);
    } catch (error) {
      fail(Object.assign(error instanceof Error ? error : new Error("SSE partial-progress callback failed"), {
        code: error?.code ?? "SSE_PARTIAL_PROGRESS_ERROR",
      }));
      return;
    }
    if (!progress || typeof progress.key !== "string" || !Number.isFinite(progress.bytes)) {
      pendingPartialProgress = null;
      return;
    }
    const previous = pendingPartialProgress;
    pendingPartialProgress = progress;
    if (previous?.key === progress.key && previous.bytes >= progress.bytes) return;
    try {
      onPartialProgress(progress);
    } catch (error) {
      fail(Object.assign(error instanceof Error ? error : new Error("SSE partial-progress callback failed"), {
        code: error?.code ?? "SSE_PARTIAL_PROGRESS_ERROR",
      }));
    }
  };
  return {
    push(chunk) {
      if (failed) return;
      pending += decoder.write(chunk);
      drain(false);
      if (shouldPause()) return;
      if (Buffer.byteLength(pending, "utf8") > maximumPendingBytes) {
        fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
        return;
      }
      observePartialProgress();
    },
    end() {
      if (failed) return;
      if (!ending) pending += decoder.end();
      ending = true;
      drain(true);
    },
    resume() {
      if (failed) return;
      drain(ending);
      if (shouldPause()) return;
      if (Buffer.byteLength(pending, "utf8") > maximumPendingBytes) {
        fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
        return;
      }
      observePartialProgress();
    },
    dispose() {
      failed = true;
      pending = "";
      pendingPartialProgress = null;
    },
  };
}

function sanitizeForwardHeaders(headers, targetHost, bodyLength = null) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "host" || normalized === "content-length") continue;
    if (value !== undefined) result[normalized] = value;
  }
  result.host = targetHost;
  if (bodyLength !== null) result["content-length"] = String(bodyLength);
  return result;
}

function sanitizeResponseHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "content-length") continue;
    if (value !== undefined) result[normalized] = value;
  }
  return result;
}

function writeHeadOnce(response, statusCode, statusMessage, headers) {
  if (response.headersSent || response.destroyed) return false;
  response.writeHead(statusCode, statusMessage, sanitizeResponseHeaders(headers));
  return true;
}

function ensureSseHead(response, upstreamHeaders = {}) {
  return writeHeadOnce(response, 200, "OK", {
    ...upstreamHeaders,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
  });
}

function requestClient(url) {
  if (url.protocol === "https:") return https;
  if (url.protocol === "http:") return http;
  throw new Error(`Unsupported upstream protocol: ${url.protocol}`);
}

function collectResponseBody(response, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    response.on("data", (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        reject(Object.assign(new Error("upstream response exceeded proxy buffer limit"), { code: "RESPONSE_LIMIT_EXCEEDED" }));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => resolve(Buffer.concat(chunks, length)));
    response.once("error", reject);
  });
}

function sseFrame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function attemptKey(identity) {
  if (!identity.threadId || !identity.turnId || !identity.requestKind) return null;
  return `${identity.threadId}\u0000${identity.turnId}\u0000${identity.requestKind}`;
}

function forwardPassthrough(request, response, targetUrl, onEvent) {
  const client = requestClient(targetUrl);
  const upstream = client.request(targetUrl, { method: request.method, headers: sanitizeForwardHeaders(request.headers, targetUrl.host) });
  upstream.once("response", (upstreamResponse) => {
    writeHeadOnce(response, upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
    upstreamResponse.on("error", (error) => response.destroy(error));
    upstreamResponse.pipe(response);
  });
  upstream.once("error", (error) => {
    onEvent({ type: "passthrough_error", code: error.code ?? "UPSTREAM_ERROR" });
    if (!response.headersSent && !response.destroyed) {
      response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { type: "upstream_unavailable", message: "Local model stream proxy could not reach upstream." } }));
    } else {
      response.destroy(error);
    }
  });
  request.once("aborted", () => upstream.destroy());
  response.once("close", () => upstream.destroy());
  request.pipe(upstream);
}

function isToolInputProgressType(type) {
  return /^response\.(?:function_call_arguments|custom_tool_call_input|local_shell_call)\.delta$/u.test(type ?? "");
}

function executeTurnAttempt(options) {
  const {
    requestBody,
    downstream,
    headers,
    method,
    targetUrl,
    firstProgressTimeoutMs,
    progressIdleTimeoutMs,
    reasoningProgressIdleTimeoutMs = progressIdleTimeoutMs,
    toolInputProgressIdleTimeoutMs = progressIdleTimeoutMs,
    compactionAttemptTimeoutMs,
    toolPreparationGraceMs,
    bufferedToolIdentityHashes,
    bufferedToolPreparationGraceMs,
    contextHint,
    adaptiveRegistry,
    adaptiveKey,
    adaptiveWaitLimitMs,
    consecutiveWaitLimitMs = adaptiveWaitLimitMs,
    priorWaitState,
    uploadAllowanceMs = 0,
    uploadAllowanceMsPerMiB = 1000,
    maxUploadAllowanceMs = 128_000,
    compactionRequest = false,
    upstreamIdleTimeoutMs,
    adaptiveStreamMinSpanMs,
    maxBufferedResponseBytes,
    onEvent,
    requestState,
    observation,
    nativeAttempt,
    upstreamClient,
  } = options;
  return new Promise((resolve) => {
    const client = upstreamClient ?? requestClient(targetUrl);
    const startedAt = Date.now();
    const chainWaitBudget = compactionRequest ? null : createRequestWaitBudget({ startedAt, uploadAllowanceMs,
      waitLimitMs: consecutiveWaitLimitMs, previous: priorWaitState });
    const attemptWaitBudget = compactionRequest ? null : createRequestWaitBudget({ startedAt, uploadAllowanceMs,
      waitLimitMs: adaptiveWaitLimitMs });
    const waitBudget = chainWaitBudget ? { ...chainWaitBudget,
      deadline: () => Math.min(chainWaitBudget.deadline(), attemptWaitBudget.deadline()),
      noteUpload(time, allowance) {
        attemptWaitBudget.noteUpload(time, allowance);
        chainWaitBudget.noteUpload(time, allowance);
      },
      notePreparation(time, allowance) {
        attemptWaitBudget.notePreparation(time, allowance);
        chainWaitBudget.notePreparation(time, allowance);
      },
      noteProgress(time) { attemptWaitBudget.noteProgress(time); return chainWaitBudget.noteProgress(time); },
    } : null;
    const progressTracker = createRequestProgressTracker(priorWaitState?.progressIdentityState, `attempt-${nativeAttempt ?? startedAt}`);
    const adaptive = compactionRequest ? null : adaptiveRegistry?.begin({ key: adaptiveKey, startedAt, firstProgressTimeoutMs,
      waitLimitMs: adaptiveWaitLimitMs, waitBudget, uploadAllowanceMs, upstreamIdleTimeoutMs,
      streamMinSpanMs: adaptiveStreamMinSpanMs, onEvent });
    let upstreamResponse = null;
    let settled = false;
    let timer = null;
    let drainTimer = null;
    let waitingForDrain = false;
    let completionPending = false;
    let parser = null;
    let upstreamEnded = false;
    let finishUpstreamResponse = null;
    let sawCompleted = false;
    let sawContent = false;
    let sawReplayUnsafeContent = false;
    let sawTool = false;
    let sawLocalTool = false;
    let sawSubstantiveWork = false;
    let sawExecutableToolDone = false;
    let sawCompaction = compactionRequest;
    let sawHostedTool = false;
    const toolItemTypes = new Set();
    const toolNames = new Set();
    let terminalFailure = null;
    let heldAfterTool = [];
    let heldBytes = 0;
    let holdingToolDone = false;
    let deliveredExecutableToolDone = false;
    let upstreamHeaders = {};
    let frames = 0;
    let sawResponsesProtocol = false;
    let rawBodyBeforeProtocol = [];
    let rawBodyBeforeProtocolBytes = 0;
    let advertisedResponsesSse = false;
    let firstFrameAt = null;
    let lastFrameAt = null;
    let lastProgressAt = null;
    let lastFrameType = null;
    let lastProgressType = null;
    let lastToolType = null;
    let currentChunkAt = null;
    const preparation = createToolPreparationDeadline(toolPreparationGraceMs, { bufferedToolIdentityHashes, bufferedToolPreparationGraceMs });
    const observeReasoningProgress = createReasoningProgressTracker();
    const completedReasoningIds = new Set();
    let normalDeadline = startedAt + uploadAllowanceMs + firstProgressTimeoutMs;
    let normalReason = "FIRST_PROGRESS_TIMEOUT";
    const failureDiagnostics = createModelStreamFailureDiagnostics();
    let diagnosticSocket = null;
    let modelResponseStarted = false;
    let upstreamStatusCode;
    let explicitAcceptance;
    let requestTransmissionState = "not_started";
    const noteConnection = () => failureDiagnostics.connected();
    const noteTlsConnection = () => failureDiagnostics.connected(true);

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      observation?.ended(outcome.kind);
      clearTimeout(timer);
      clearTimeout(drainTimer);
      downstream.off("drain", resumeAfterDrain);
      downstream.off("finish", onDownstreamFinished);
      downstream.off("error", cancelDownstream);
      parser?.dispose();
      heldAfterTool = [];
      heldBytes = 0;
      rawBodyBeforeProtocol = [];
      rawBodyBeforeProtocolBytes = 0;
      diagnosticSocket?.removeListener("connect", noteConnection);
      diagnosticSocket?.removeListener("secureConnect", noteTlsConnection);
      if (outcome.kind === "completed") adaptive?.complete(Date.now(), !sawCompaction);
      requestState.currentAbort = null;
      requestState.onPreparationProgress = null;
      requestState.onPacketSending = null;
      if (!upstream.writableFinished) upstream.destroy();
      upstreamResponse?.destroy();
      const phase = holdingToolDone ? "tool_completion_barrier" : sawLocalTool ? "tool_parameters"
        : contextHint?.contextPreparationHint === true ? "context_preparation_hint" : sawSubstantiveWork ? "ordinary_generation" : "unknown";
      const endCause = outcome.origin ?? (outcome.reason === "DOWNSTREAM_CANCELLED" ? "downstream_cancel_user_origin_unknown"
        : /^HTTP_/u.test(outcome.reason ?? "") ? "upstream_http"
        : terminalFailure ? "upstream_error" : outcome.kind === "completed" ? "upstream_completed" : "unknown");
      const diagnostics = failureDiagnostics.snapshot({ frames, progressObserved: lastProgressAt !== null });
      const definitelyNotSent = !diagnostics.connectionObserved && !diagnostics.requestFinished
        && !diagnostics.responseStarted && upstream.transport !== "websocket";
      const rawAcceptance = upstream.operationAcceptance ?? explicitAcceptance;
      const acceptance = rawAcceptance === "accepted" ? true
        : ["rejected", "not_sent"].includes(rawAcceptance) ? false : rawAcceptance;
      const transmission = upstream.requestTransmissionState ?? (definitelyNotSent ? "not_started" : requestTransmissionState);
      const policy = classifyModelFailure({
        source: terminalFailure ? "sse" : upstream.terminalEvidence ? "transport" : upstreamStatusCode >= 400 ? "http"
          : outcome.origin === "upstream_transport" ? "transport" : "local",
        statusCode: upstreamStatusCode,
        code: outcome.failure?.code ?? outcome.reason,
        message: outcome.failure?.message,
        requestAccepted: acceptance,
        requestTransmissionState: transmission,
        responseStarted: modelResponseStarted,
        terminalOutcome: upstream.terminalOutcome,
        terminalEvidence: upstream.terminalEvidence,
        progressObserved: lastProgressAt !== null,
        toolDelivered: deliveredExecutableToolDone,
        cancelled: outcome.kind === "cancelled",
      });
      resolve({ ...outcome, phase, endCause, policy, httpStatus: upstreamStatusCode,
        requestAccepted: policy.acceptance,
        requestTransmissionState: transmission, contextPreparationHint: contextHint?.contextPreparationHint ?? null,
        failureDiagnostics: diagnostics,
        elapsedMs: Date.now() - startedAt, uploadAllowanceMs, firstProgressDelayMs: waitBudget?.firstProgressDelayMs() ?? null,
        ...(!sawCompaction ? { ...waitBudget?.snapshot(Date.now()), progressIdentityState: progressTracker.snapshot() } : {}),
        progressObserved: lastProgressAt !== null,
        frames, sawContent, sawReplayUnsafeContent, sawSubstantiveWork, sawExecutableToolDone, deliveredExecutableToolDone, holdingToolDone, preparationPending: preparation.active(), sawTool, sawCompaction, sawHostedTool, toolItemTypes: [...toolItemTypes], toolNames: [...toolNames] });
    };
    const abortWith = (reason) => {
      upstreamResponse?.destroy();
      upstream.destroy(Object.assign(new Error(reason), { code: reason }));
      const category = reason === "TOOL_PREPARATION_TIMEOUT" ? "tool_preparation"
        : reason === "TOOL_COMPLETION_TIMEOUT" ? "tool_completion" : null;
      finish({ kind: reason.startsWith("ADAPTIVE_") ? "adaptive_wait_timeout" : category ? "local_phase_timeout" : "retryable_failure", reason, origin: /TIMEOUT$/u.test(reason) ? "local_timer" : "local_limit",
        ...(category || /TIMEOUT$/u.test(reason) ? { failure: { category: category ?? "local_timer" } } : {}), upstreamHeaders });
    };
    const adaptiveDeadlineExpired = () => {
      if (settled || requestState.cancelled) return true;
      if (completionPending) return false;
      if (sawCompaction) return false;
      let deadline = adaptive?.active() ? adaptive.deadline(normalDeadline, normalReason) : null;
      const waitDeadlineAt = waitBudget?.deadline();
      if (waitDeadlineAt !== undefined && (!deadline || waitDeadlineAt < deadline.at)) {
        deadline = { at: waitDeadlineAt, reason: "ADAPTIVE_WAIT_LIMIT" };
      }
      if (!deadline) return false;
      if (Date.now() < deadline.at) return false;
      abortWith(deadline.reason);
      return true;
    };
    const armTimer = (timeoutMs, reason, preserveNormalDeadline = false) => {
      clearTimeout(timer);
      if (!sawCompaction) {
        if (!preserveNormalDeadline) {
          normalDeadline = Date.now() + timeoutMs;
          normalReason = reason;
        }
        timeoutMs = Math.max(0, preparation.deadline(normalDeadline) - Date.now());
        if (preparation.active()) reason = "TOOL_PREPARATION_TIMEOUT";
        else if (holdingToolDone && toolItemTypes.has("function_call")) reason = "TOOL_COMPLETION_TIMEOUT";
        if (adaptive?.active()) {
          const phaseDeadline = preparation.active() || holdingToolDone ? { at: Date.now() + timeoutMs, reason } : null;
          const deadline = adaptive.deadline(normalDeadline, normalReason, phaseDeadline);
          timeoutMs = Math.max(0, deadline.at - Date.now());
          reason = deadline.reason;
        }
        const waitDeadlineAt = waitBudget?.deadline();
        if (waitDeadlineAt !== undefined && waitDeadlineAt <= Date.now() + timeoutMs) {
          timeoutMs = Math.max(0, waitDeadlineAt - Date.now());
          reason = "ADAPTIVE_WAIT_LIMIT";
        }
      }
      timer = setTimeout(() => {
        if (settled || requestState.cancelled) return;
        if (waitingForDrain) return cancelDownstream();
        const now = Date.now();
        if (!sawCompaction && !preparation.active() && !holdingToolDone
          && ["FIRST_PROGRESS_TIMEOUT", "PROGRESS_IDLE_TIMEOUT"].includes(reason) && adaptive?.tryProbe(now)) {
          armTimer(0, normalReason, true);
          return;
        }
        onEvent({
          type: "attempt_progress_timeout",
          reason,
          timeoutMs,
          elapsedMs: now - startedAt,
          frames,
          sawContent,
          sawTool,
          sawCompaction,
          toolItemTypes: [...toolItemTypes],
          toolNames: [...toolNames],
          firstFrameDelayMs: firstFrameAt ? firstFrameAt - startedAt : null,
          msSinceLastFrame: lastFrameAt ? now - lastFrameAt : null,
          msSinceLastProgress: lastProgressAt ? now - lastProgressAt : null,
          lastFrameType,
          lastProgressType,
          lastToolType,
          upstreamHeaderState: summarizeUpstreamHeaders(upstreamHeaders),
        });
        abortWith(reason);
      }, timeoutMs);
      timer.unref?.();
    };
    const writeWire = (wire) => {
      if (adaptiveDeadlineExpired()) return false;
      if (downstream.destroyed || downstream.writableEnded) {
        cancelDownstream();
        return false;
      }
      ensureSseHead(downstream, upstreamHeaders);
      if (!downstream.write(wire)) {
        waitingForDrain = true;
        upstreamResponse?.pause();
        downstream.once("drain", resumeAfterDrain);
        clearTimeout(drainTimer);
        drainTimer = setTimeout(cancelDownstream, upstreamIdleTimeoutMs);
        drainTimer.unref?.();
      }
      requestState.downstreamFrames += 1;
      const deliveredEvent = parseSseFrame(wire).event;
      if (isExecutableToolDone(deliveredEvent)) deliveredExecutableToolDone = true;
      requestState.recovery.markDelivered(deliveredEvent);
      return true;
    };
    const holdToolWire = (wire) => {
      heldBytes += Buffer.byteLength(wire, "utf8");
      if (heldBytes > maxBufferedResponseBytes) {
        abortWith("TOOL_BUFFER_LIMIT");
        return false;
      }
      heldAfterTool.push(wire);
      return true;
    };
    const flushHeldAfterTool = () => {
      if (adaptiveDeadlineExpired()) return false;
      while (heldAfterTool.length > 0) {
        if (waitingForDrain) return false;
        const wire = heldAfterTool.shift();
        heldBytes -= Buffer.byteLength(wire, "utf8");
        if (!writeWire(wire)) return false;
      }
      heldBytes = 0;
      holdingToolDone = false;
      return true;
    };
    const cancelDownstream = () => {
      if (settled) return;
      requestState.cancelled = true;
      upstreamResponse?.destroy();
      upstream.destroy();
      downstream.destroy();
    };
    const onDownstreamFinished = () => {
      if (completionPending) finish({ kind: "completed", reason: "RESPONSE_COMPLETED" });
    };
    const finishDelivery = () => {
      if (settled || requestState.cancelled || !flushHeldAfterTool() || waitingForDrain) return;
      if (!downstream.destroyed && !downstream.writableEnded) downstream.end();
      if (downstream.writableFinished) onDownstreamFinished();
    };
    const resumeAfterDrain = () => {
      waitingForDrain = false;
      clearTimeout(drainTimer);
      if (settled || requestState.cancelled) return;
      if (completionPending) return finishDelivery();
      parser?.resume();
      if (upstreamEnded && !waitingForDrain && !completionPending) finishUpstreamResponse?.();
      if (!settled && !waitingForDrain && !completionPending) upstreamResponse?.resume();
    };
    const noteProgress = (time, type) => {
      requestState.onBusinessProgress?.({ progressType: type, observedAt: time });
      if (waitBudget?.noteProgress(time)) {
        onEvent({ type: "first_progress_observed", elapsedMs: time - startedAt, progressType: type,
          encodedBytes: requestBody.bytes, uploadAllowanceMs });
      }
    };
    let packetSequence = 0;
    requestState.onPacketSending = (progress) => {
      if (settled || requestState.cancelled || lastProgressAt !== null
        || progress?.operationId !== requestState.requestId || progress?.sessionKey !== requestState.threadId
        || progress.phase !== "packet_sending" || progress.businessProgress !== false
        || !Number.isSafeInteger(progress.sequence) || progress.sequence <= packetSequence
        || !Number.isSafeInteger(progress.wireBytes) || progress.wireBytes < 0) return 0;
      packetSequence = progress.sequence;
      const observedAt = Date.now();
      const packetUploadAllowanceMs = requestUploadAllowanceMs(progress.wireBytes, uploadAllowanceMsPerMiB, maxUploadAllowanceMs);
      waitBudget?.noteUpload(observedAt, packetUploadAllowanceMs);
      armTimer(firstProgressTimeoutMs + packetUploadAllowanceMs, "FIRST_PROGRESS_TIMEOUT");
      onEvent({ type: "incremental_packet_upload_started", requestId: requestState.requestId,
        threadId: requestState.threadId, sequence: progress.sequence, generation: progress.generation,
        packetWireBytes: progress.wireBytes, warm: progress.warm, uploadAllowanceMs: packetUploadAllowanceMs,
        firstProgressDeadlineAt: normalDeadline, waitDeadlineAt: waitBudget?.deadline(), businessProgress: false });
      return packetUploadAllowanceMs;
    };
    let preparationSequence = 0;
    requestState.onPreparationProgress = (progress) => {
      if (settled || requestState.cancelled || lastProgressAt !== null
        || progress?.operationId !== requestState.requestId || progress?.sessionKey !== requestState.threadId
        || progress.phase !== "prewarm_completed" || progress.businessProgress !== false
        || !Number.isSafeInteger(progress.sequence) || progress.sequence <= preparationSequence) return;
      preparationSequence = progress.sequence;
      waitBudget?.notePreparation(Date.now());
      onEvent({ type: "incremental_prewarm_progress", requestId: requestState.requestId,
        threadId: requestState.threadId, sequence: progress.sequence,
        preparedPackets: progress.preparedPackets, preparedInputItems: progress.preparedInputItems,
        remainingPackets: progress.remainingPackets, businessProgress: false });
    };
    const completeFromUpstream = (wire) => {
      if (adaptiveDeadlineExpired()) return;
      completionPending = true;
      clearTimeout(timer);
      if (holdingToolDone) {
        if (!holdToolWire(wire)) return;
      } else {
        if (!writeWire(wire)) return;
      }
      upstreamResponse?.pause();
      finishDelivery();
    };

    const upstream = client.request(targetUrl, {
      method,
      headers: { ...sanitizeForwardHeaders(headers, targetUrl.host, requestBody.bytes), "accept-encoding": "identity" },
    });
    upstream.once("socket", (socket) => {
      if (settled) return;
      diagnosticSocket = socket;
      failureDiagnostics.socketAssigned({ reusedSocket: upstream.reusedSocket === true });
      socket.once("connect", noteConnection);
      if (socket.encrypted) socket.once("secureConnect", noteTlsConnection);
    });
    requestState.currentAbort = () => {
      upstreamResponse?.destroy();
      upstream.destroy();
      finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
    };
    downstream.once("finish", onDownstreamFinished);
    downstream.once("error", cancelDownstream);
    armTimer(compactionRequest ? compactionAttemptTimeoutMs : firstProgressTimeoutMs + uploadAllowanceMs,
      compactionRequest ? "COMPACTION_CONTROL_TIMEOUT" : "FIRST_PROGRESS_TIMEOUT");

    upstream.once("response", async (response) => {
      upstreamResponse = response;
      upstreamHeaders = response.headers;
      const statusCode = response.statusCode ?? 502;
      upstreamStatusCode = statusCode;
      failureDiagnostics.responseStarted(statusCode, upstreamHeaders);
      response.on("data", (chunk) => failureDiagnostics.responseData(chunk.length));
      observation?.headers(response.headers, statusCode);
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      advertisedResponsesSse = contentType.includes("text/event-stream");
      onEvent({
        type: "upstream_response_started",
        statusCode,
        contentType: contentType.slice(0, 160) || null,
        advertisedResponsesSse,
        upstreamHeaderState: summarizeUpstreamHeaders(upstreamHeaders),
      });
      if (statusCode < 200 || statusCode >= 300) {
        try {
          const responseBody = await collectResponseBody(response, Math.min(maxBufferedResponseBytes, 1024 * 1024));
          if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
          const failure = responseFailureDetailsFromBody(responseBody, observation);
          failureDiagnostics.httpFailure(responseBody, failure);
          if (failure.safetyPolicy) return finish({ kind: "permanent_failure", reason: failure.code, failure, upstreamHeaders });
          if (failure.category === "usage_limit") return finish({ kind: "usage_limit", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
          if (failure.category === "permanent") return finish({ kind: "permanent_failure", reason: failure.code ?? `HTTP_${statusCode}`, failure, upstreamHeaders });
          if (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient") {
            return finish({ kind: "retryable_failure", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
          }
          return finish({ kind: "permanent_failure", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
        } catch (error) {
          if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
          onEvent({ type: "upstream_error_body_unavailable", statusCode, reason: error.code ?? "HTTP_BODY_ERROR" });
          failureDiagnostics.transportError("response", error);
          return finish({ kind: retryableStatus(statusCode) ? "retryable_failure" : "permanent_failure", reason: `HTTP_${statusCode}`, upstreamHeaders });
        }
      }

      ensureSseHead(downstream, upstreamHeaders);
      parser = createSseFrameParser((wire, frame) => {
        if (adaptiveDeadlineExpired()) return;
        frames += 1;
        const parsed = parseSseFrame(frame);
        const event = parsed.event;
        const type = parsed.type;
        if (type === "response.created" || type === "response.in_progress" || type === "response.completed") modelResponseStarted = true;
        const freshProgressEvent = progressTracker.observe(event);
        observation?.event(event);
        const now = Date.now();
        firstFrameAt ??= now;
        lastFrameAt = now;
        lastFrameType = type ?? (parsed.doneMarker ? "[DONE]" : null);
        adaptive?.observe(event, currentChunkAt ?? now);
        if (isResponsesProtocolType(type ?? "")) sawResponsesProtocol = true;
        requestState.recovery.observe(event);
        const contextControlFunction = event?.item?.type === "function_call" && CONTEXT_CONTROL_FUNCTION_NAMES.has(event.item.name);
        const preparationWasActive = preparation.active();
        preparation.observe(event, now);
        if (!sawCompaction && (preparationWasActive || preparation.active())) {
          armTimer(Math.max(0, normalDeadline - now), normalReason, true);
        }
        if (COMPACTION_CONTROL_TYPES.has(event?.item?.type) && !sawCompaction) {
          sawCompaction = true;
          onEvent({ type: "compaction_control_passthrough", itemType: event.item.type, functionName: null, timeoutMs: compactionAttemptTimeoutMs });
          armTimer(Math.max(0, startedAt + compactionAttemptTimeoutMs - now), "COMPACTION_CONTROL_TIMEOUT");
        }
        const finalizedFunctionArguments = type === "response.function_call_arguments.done"
          && typeof event.arguments === "string" && event.arguments.length > 0;
        const completedReasoningProgress = observeReasoningProgress(event);
        if (completedReasoningProgress) completedReasoningIds.add(event.item.id);
        if (!sawCompaction && freshProgressEvent && (eventPayloadHasContent(event) || finalizedFunctionArguments || completedReasoningProgress)) {
          sawContent = true;
          if (!isRetrySafeReasoningProgress(event, completedReasoningProgress)) sawReplayUnsafeContent = true;
          lastProgressAt = now;
          lastProgressType = type ?? null;
          noteProgress(now, lastProgressType);
          const toolInputProgress = !sawExecutableToolDone && isToolInputProgressType(type);
          const progressTimeoutMs = toolInputProgress ? toolInputProgressIdleTimeoutMs
            : !holdingToolDone && isRetrySafeReasoningProgress(event, completedReasoningProgress) ? reasoningProgressIdleTimeoutMs : progressIdleTimeoutMs;
          armTimer(progressTimeoutMs, "PROGRESS_IDLE_TIMEOUT");
        }
        if (eventHasSubstantiveWork(event)) sawSubstantiveWork = true;
        if (["function_call", "custom_tool_call", "local_shell_call"].includes(event?.item?.type)
          || /^response\.(?:function_call_arguments|custom_tool_call_input|local_shell_call)\./u.test(type ?? "")) sawLocalTool = true;
        if (isToolEvent(event)) {
          sawTool = true;
          lastToolType = type ?? null;
          if (event.item?.name && toolNames.size < 16) {
            const functionName = String(event.item.name).replace(/[^a-zA-Z0-9_.:-]/gu, "_").slice(0,96);
            if (!toolNames.has(functionName)) {
              toolNames.add(functionName);
              onEvent({ type: "tool_call_observed", itemType: event.item.type, functionName, toolIdentityHash: toolIdentityHash(event.item), eventType: type, argumentBytes: typeof event.item.arguments === "string" ? Buffer.byteLength(event.item.arguments, "utf8") : null, contextControlFunction });
            }
          }
          if (event.item?.type) {
            toolItemTypes.add(event.item.type);
            if (!["function_call", "custom_tool_call", "local_shell_call"].includes(event.item.type)) sawHostedTool = true;
          } else if (!/^response\.(?:function_call_arguments|custom_tool_call_input|local_shell_call)/u.test(type ?? "")) {
            sawHostedTool = true;
          }
        }
        if (type === "response.failed" || type === "response.incomplete" || type === "error") {
          terminalFailure = responseFailureDetails(event);
          if (terminalFailure.statusCode !== null) upstreamStatusCode = terminalFailure.statusCode;
          const kind = terminalFailure.category === "usage_limit"
            ? "usage_limit"
            : terminalFailure.category === "permanent"
              ? "permanent_failure"
              : "retryable_failure";
          finish({ kind, reason: terminalFailure.code ?? "RESPONSE_FAILED", failure: terminalFailure, upstreamHeaders });
          upstreamResponse?.destroy();
          upstream.destroy();
          return;
        }
        if (parsed.doneMarker && !sawCompleted) return;
        if (type === "response.completed") {
          sawCompleted = true;
          completeFromUpstream(wire);
          return;
        }

        if (sawCompaction) {
          writeWire(wire);
          return;
        }

        if (adaptive?.active()) armTimer(0, normalReason, true);

        if (isIndependentKeepalive(event)) {
          writeWire(holdingToolDone ? sseFrame({ type: "proxy.keepalive" }) : wire);
          return;
        }
        if (holdingToolDone) {
          holdToolWire(wire);
          return;
        }
        if (isExecutableToolDone(event)) {
          sawExecutableToolDone = true;
          holdingToolDone = true;
          armTimer(progressIdleTimeoutMs, "PROGRESS_IDLE_TIMEOUT");
          holdToolWire(wire);
          return;
        }
        writeWire(wire);
      }, {
        maximumPendingBytes: maxBufferedResponseBytes,
        shouldPause: () => waitingForDrain || completionPending || settled || requestState.cancelled,
        classifyPartialProgress: frame => partialResponsesSseProgress(frame, completedReasoningIds),
        onPartialProgress: progress => {
            if (settled || requestState.cancelled || sawCompaction) return;
            if (adaptiveDeadlineExpired()) return;
            const now = Date.now();
            adaptive?.notePartialProgress(now);
            if (progress.argumentsProgress) {
              preparation.observe({ type: "response.function_call_arguments.delta", delta: "fragment" }, now);
            }
            sawContent = true;
            if (!RETRY_SAFE_REASONING_DELTAS.has(progress.type) && !progress.reasoningId) sawReplayUnsafeContent = true;
            lastProgressAt = now;
            lastProgressType = progress.type;
            noteProgress(now, lastProgressType);
            const progressTimeoutMs = (progress.argumentsProgress || isToolInputProgressType(progress.type)) && !sawExecutableToolDone
              ? toolInputProgressIdleTimeoutMs : !holdingToolDone && (RETRY_SAFE_REASONING_DELTAS.has(progress.type) || progress.reasoningId)
                ? reasoningProgressIdleTimeoutMs : progressIdleTimeoutMs;
            armTimer(progressTimeoutMs, "PROGRESS_IDLE_TIMEOUT");
        },
        onError: (error) => {
          if (settled || requestState.cancelled) return;
          finish({ kind: "retryable_failure", reason: error.code ?? "SSE_PARSE_ERROR", upstreamHeaders });
          upstreamResponse?.destroy();
          upstream.destroy();
        },
      });
      response.on("data", (chunk) => {
        currentChunkAt = Date.now();
        if (!advertisedResponsesSse && frames === 0 && rawBodyBeforeProtocolBytes <= 1024 * 1024) {
          rawBodyBeforeProtocol.push(chunk);
          rawBodyBeforeProtocolBytes += chunk.length;
        }
        parser.push(chunk);
      });
      finishUpstreamResponse = () => {
        if (waitingForDrain) return;
        parser.end();
        if (waitingForDrain || completionPending) return;
        if (settled) return;
        if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
        if (sawCompleted) {
          if (!flushHeldAfterTool()) return;
          if (!downstream.destroyed && !downstream.writableEnded) downstream.end();
          return finish({ kind: "completed", reason: "RESPONSE_COMPLETED" });
        }
        if (terminalFailure?.category === "usage_limit") {
          return finish({ kind: "usage_limit", reason: "USAGE_LIMIT", failure: terminalFailure, upstreamHeaders });
        }
        if (terminalFailure?.category === "permanent") {
          return finish({ kind: "permanent_failure", reason: terminalFailure.code ?? "RESPONSE_FAILED", failure: terminalFailure, upstreamHeaders });
        }
        if (!advertisedResponsesSse && !sawResponsesProtocol && rawBodyBeforeProtocolBytes > 0 && rawBodyBeforeProtocolBytes <= 1024 * 1024) {
          const failure = responseFailureDetailsFromBody(Buffer.concat(rawBodyBeforeProtocol, rawBodyBeforeProtocolBytes), observation);
          if (failure.category === "usage_limit") {
            return finish({ kind: "usage_limit", reason: "HTTP_200_NON_SSE", failure, upstreamHeaders });
          }
          if (failure.category === "capacity" || failure.category === "transient") {
            return finish({ kind: "retryable_failure", reason: "HTTP_200_NON_SSE", failure, upstreamHeaders });
          }
          return finish({ kind: "permanent_failure", reason: "HTTP_200_NON_SSE", failure, upstreamHeaders });
        }
        return finish({
          kind: "retryable_failure",
          reason: terminalFailure?.code ?? (terminalFailure ? "RESPONSE_FAILED" : "STREAM_ENDED_WITHOUT_COMPLETION"),
          failure: terminalFailure,
          upstreamHeaders,
        });
      };
      response.once("end", () => {
        upstreamEnded = true;
        finishUpstreamResponse();
      });
      response.once("error", (error) => {
        if (settled || requestState.cancelled) return;
        explicitAcceptance = error.requestAccepted ?? explicitAcceptance;
        if (error.requestTransmissionState) requestTransmissionState = error.requestTransmissionState;
        if (Number.isInteger(error.httpStatus)) upstreamStatusCode = error.httpStatus;
        failureDiagnostics.transportError("response", error);
        finish({ kind: "retryable_failure", reason: error.code ?? "STREAM_ERROR", origin: "upstream_transport", upstreamHeaders });
      });
    });
    upstream.once("error", (error) => {
      if (settled || requestState.cancelled) return;
      explicitAcceptance = error.requestAccepted;
      if (error.requestTransmissionState) requestTransmissionState = error.requestTransmissionState;
      if (Number.isInteger(error.httpStatus)) upstreamStatusCode = error.httpStatus;
      failureDiagnostics.transportError("request", error);
      finish({ kind: "retryable_failure", reason: error.code ?? "UPSTREAM_ERROR", origin: "upstream_transport", upstreamHeaders });
    });
    requestTransmissionState = "started";
    requestBody.submit(upstream, bodyBytes => {
      requestTransmissionState = "finished";
      failureDiagnostics.requestFinished(bodyBytes);
      onEvent({ type: "upstream_request_finished", elapsedMs: Date.now() - startedAt, bodyBytes,
        meaning: upstream.transport === "websocket" ? "local_adapter_body_received" : "local_os_handoff" });
    });
    observation?.submitted(nativeAttempt);
  });
}

function analyzeBufferedSse(body, observation = null) {
  let sawCompleted = false;
  let sawResponsesProtocol = false;
  let compactionItems = 0;
  let failure = null;
  const parser = createSseFrameParser((_wire, frame) => {
    const parsed = parseSseFrame(frame);
    observation?.event(parsed.event);
    if (isResponsesProtocolType(parsed.type ?? "")) sawResponsesProtocol = true;
    if (parsed.type === "response.completed") sawCompleted = true;
    if (parsed.type === "response.output_item.done" && parsed.event?.item?.type === "compaction") compactionItems += 1;
    if (parsed.type === "response.failed" || parsed.type === "response.incomplete" || parsed.type === "error") {
      const nextFailure = responseFailureDetails(parsed.event);
      if (!failure || (!["permanent", "usage_limit"].includes(failure.category)
        && ["permanent", "usage_limit"].includes(nextFailure.category))) failure = nextFailure;
    }
  });
  parser.push(body);
  parser.end();
  return { sawCompleted, sawResponsesProtocol, compactionItems, failure };
}

function executeBufferedCompactionAttempt(options) {
  const { requestBody, headers, method, targetUrl, timeoutMs, maxBufferedResponseBytes, requestState, observation, onEvent } = options;
  return new Promise((resolve) => {
    const client = requestClient(targetUrl);
    let settled = false;
    let upstreamResponse = null;
    let requestFinished = false;
    let connectionObserved = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      observation?.ended(outcome.kind);
      clearTimeout(timer);
      requestState.currentAbort = null;
      if (!upstream.writableFinished) upstream.destroy();
      const policy = classifyModelFailure({
        source: outcome.statusCode >= 400 ? "http" : outcome.failure ? "sse" : "transport",
        statusCode: outcome.statusCode, code: outcome.failure?.code ?? outcome.reason,
        message: outcome.failure?.message,
        requestTransmissionState: !connectionObserved && !requestFinished && !upstreamResponse ? "not_started"
          : requestFinished ? "finished" : "started",
        cancelled: outcome.kind === "cancelled",
      });
      resolve({ ...outcome, policy });
    };
    const timer = setTimeout(() => {
      if (settled || requestState.cancelled) return;
      upstreamResponse?.destroy();
      upstream.destroy(Object.assign(new Error("COMPACTION_TIMEOUT"), { code: "COMPACTION_TIMEOUT" }));
      finish({ kind: "retryable_failure", reason: "COMPACTION_TIMEOUT" });
    }, timeoutMs);
    timer.unref?.();
    const upstream = client.request(targetUrl, {
      method,
      headers: { ...sanitizeForwardHeaders(headers, targetUrl.host, requestBody.bytes), "accept-encoding": "identity" },
    });
    upstream.once("socket", socket => {
      if (!socket.connecting) connectionObserved = true;
      socket.once("connect", () => { connectionObserved = true; });
      socket.once("secureConnect", () => { connectionObserved = true; });
    });
    requestState.currentAbort = () => {
      upstreamResponse?.destroy();
      upstream.destroy();
      finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
    };
    upstream.once("response", async (response) => {
      upstreamResponse = response;
      const statusCode = response.statusCode ?? 502;
      observation?.headers(response.headers, statusCode);
      try {
        const responseBody = await collectResponseBody(response, maxBufferedResponseBytes);
        if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
        const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
        if (statusCode < 200 || statusCode >= 300) {
          const failure = responseFailureDetailsFromBody(responseBody, observation);
          const retryable = !["permanent", "usage_limit"].includes(failure.category)
            && (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient");
          return finish({
            kind: retryable ? "retryable_failure" : "permanent_failure",
            reason: `HTTP_${statusCode}`,
            failure,
            statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            body: responseBody,
          });
        }
        if (!contentType.includes("text/event-stream")) {
          if (successfulUnaryJson(responseBody, observation)) {
            return finish({ kind: "completed", statusCode, statusMessage: response.statusMessage, headers: response.headers, body: responseBody });
          }
          const failure = responseFailureDetailsFromBody(responseBody, observation);
          const retryable = !["permanent", "usage_limit"].includes(failure.category)
            && (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient");
          return finish({
            kind: retryable ? "retryable_failure" : "permanent_failure",
            reason: failure.code ?? "HTTP_200_NON_SSE",
            failure,
            statusCode,
            statusMessage: response.statusMessage,
            headers: response.headers,
            body: responseBody,
          });
        }
        const analysis = analyzeBufferedSse(responseBody, observation);
        if (!analysis.failure && analysis.sawCompleted && analysis.compactionItems === 1) {
          return finish({ kind: "completed", statusCode, statusMessage: response.statusMessage, headers: response.headers, body: responseBody });
        }
        const permanent = analysis.failure?.category === "usage_limit" || analysis.failure?.category === "permanent";
        return finish({
          kind: permanent ? "permanent_failure" : "retryable_failure",
          reason: analysis.failure?.code ?? "COMPACTION_INCOMPLETE",
          failure: analysis.failure,
          statusCode,
          statusMessage: response.statusMessage,
          headers: response.headers,
          body: responseBody,
        });
      } catch (error) {
        finish({ kind: "retryable_failure", reason: error.code ?? "COMPACTION_STREAM_ERROR" });
      }
    });
    upstream.once("error", (error) => {
      if (settled || requestState.cancelled) return;
      finish({ kind: "retryable_failure", reason: error.code ?? "UPSTREAM_ERROR" });
    });
    requestBody.submit(upstream, bodyBytes => {
      requestFinished = true;
      onEvent?.({ type: "upstream_request_finished", bodyBytes, meaning: "local_os_handoff" });
    });
    observation?.submitted();
  });
}

export function createCodexModelStreamProxy(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = integerOption(options.port, 18435, 0, 65535, "port");
  const upstreamOrigin = new URL(options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN);
  if (!["http:", "https:"].includes(upstreamOrigin.protocol)) {
    throw new Error("upstreamOrigin must use http or https");
  }
  const firstProgressTimeoutMs = integerOption(options.firstProgressTimeoutMs, DEFAULT_FIRST_PROGRESS_TIMEOUT_MS, 10, 300_000, "firstProgressTimeoutMs");
  const firstLastProgressTimeoutMs = integerOption(options.firstLastProgressTimeoutMs,
    Math.max(firstProgressTimeoutMs, Math.min(DEFAULT_FIRST_LAST_PROGRESS_TIMEOUT_MS,
      Math.round(firstProgressTimeoutMs * DEFAULT_FIRST_LAST_PROGRESS_TIMEOUT_MS / DEFAULT_FIRST_PROGRESS_TIMEOUT_MS))),
    10, 300_000, "firstLastProgressTimeoutMs");
  const rapidRetryMinimumMs = integerOption(options.rapidRetryMinimumMs,
    Math.max(firstProgressTimeoutMs, Math.min(DEFAULT_RAPID_RETRY_MINIMUM_MS,
      Math.round(firstProgressTimeoutMs * DEFAULT_RAPID_RETRY_MINIMUM_MS / DEFAULT_FIRST_PROGRESS_TIMEOUT_MS))),
    10, 300_000, "rapidRetryMinimumMs");
  const fastRetryThresholdMs = integerOption(options.fastRetryThresholdMs, 8000, 0, 300_000, "fastRetryThresholdMs");
  const fastRetryDelayMs = integerOption(options.fastRetryDelayMs, 30000, 0, 300_000, "fastRetryDelayMs");
  const retryFirstProgressTimeoutMs = integerOption(options.retryFirstProgressTimeoutMs,
    Math.max(firstProgressTimeoutMs, Math.min(DEFAULT_RETRY_PROGRESS_IDLE_TIMEOUT_MS,
      Math.round(firstProgressTimeoutMs * DEFAULT_RETRY_PROGRESS_IDLE_TIMEOUT_MS / DEFAULT_FIRST_PROGRESS_TIMEOUT_MS))),
    10, 300_000, "retryFirstProgressTimeoutMs");
  const uploadAllowanceMsPerMiB = integerOption(options.uploadAllowanceMsPerMiB, DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB, 0, 60_000, "uploadAllowanceMsPerMiB");
  const maxUploadAllowanceMs = integerOption(options.maxUploadAllowanceMs, 128 * uploadAllowanceMsPerMiB, 0, MAX_UPLOAD_ALLOWANCE_MS, "maxUploadAllowanceMs");
  const progressIdleTimeoutMs = integerOption(options.progressIdleTimeoutMs, DEFAULT_PROGRESS_IDLE_TIMEOUT_MS, 10, 300_000, "progressIdleTimeoutMs");
  const reasoningProgressIdleTimeoutMs = integerOption(options.reasoningProgressIdleTimeoutMs,
    Math.max(progressIdleTimeoutMs, Math.min(DEFAULT_REASONING_PROGRESS_IDLE_TIMEOUT_MS,
      Math.round(progressIdleTimeoutMs * DEFAULT_REASONING_PROGRESS_IDLE_TIMEOUT_MS / DEFAULT_PROGRESS_IDLE_TIMEOUT_MS))),
    10, 300_000, "reasoningProgressIdleTimeoutMs");
  const retryProgressIdleTimeoutMs = integerOption(options.retryProgressIdleTimeoutMs,
    Math.max(progressIdleTimeoutMs, Math.min(DEFAULT_RETRY_PROGRESS_IDLE_TIMEOUT_MS,
      Math.round(progressIdleTimeoutMs * DEFAULT_RETRY_PROGRESS_IDLE_TIMEOUT_MS / DEFAULT_PROGRESS_IDLE_TIMEOUT_MS))),
    10, 300_000, "retryProgressIdleTimeoutMs");
  const adaptiveWaitLimitMs = integerOption(options.adaptiveWaitLimitMs, 300_000, 10, 300_000, "adaptiveWaitLimitMs");
  const upstreamIdleTimeoutMs = integerOption(options.upstreamIdleTimeoutMs, 90_000, 10, 300_000, "upstreamIdleTimeoutMs");
  const adaptiveProbeCooldownMs = integerOption(options.adaptiveProbeCooldownMs, 600_000, 10, 86_400_000, "adaptiveProbeCooldownMs");
  const adaptiveStreamMinSpanMs = integerOption(options.adaptiveStreamMinSpanMs, 1500, 1, 10_000, "adaptiveStreamMinSpanMs");
  const adaptiveRegistry = createAdaptiveDeliveryRegistry({ state: options.adaptiveDeliveryState,
    probeCooldownMs: adaptiveProbeCooldownMs, onChange: options.onAdaptiveDeliveryStateChange,
    onPersistenceError: () => onEvent({ type: "adaptive_delivery_state_write_failed" }) });
  const toolPreparationGraceMs = integerOption(options.toolPreparationGraceMs, 120_000, 10, 300_000, "toolPreparationGraceMs");
  const bufferedToolPreparationGraceMs = integerOption(options.bufferedToolPreparationGraceMs, 300_000, 10, 300_000, "bufferedToolPreparationGraceMs");
  const bufferedToolIdentityHashes = parseToolDeliveryProfile({ schemaVersion: 1, bufferedToolIdentityHashes: options.bufferedToolIdentityHashes ?? [] }).bufferedToolIdentityHashes;
  const compactionAttemptTimeoutMs = integerOption(options.compactionAttemptTimeoutMs, DEFAULT_COMPACTION_ATTEMPT_TIMEOUT_MS, 10_000, 600_000, "compactionAttemptTimeoutMs");
  const maxBufferedRequestBytes = integerOption(options.maxBufferedRequestBytes, DEFAULT_MAX_BUFFERED_REQUEST_BYTES, 1_024, 256 * 1024 * 1024, "maxBufferedRequestBytes");
  const maxDecodedRequestBytes = integerOption(options.maxDecodedRequestBytes, Math.max(DEFAULT_MAX_DECODED_REQUEST_BYTES, maxBufferedRequestBytes), 1_024, 256 * 1024 * 1024, "maxDecodedRequestBytes");
  const maxTotalRequestBytes = integerOption(options.maxTotalRequestBytes, DEFAULT_MAX_TOTAL_REQUEST_BYTES, 1_024, 512 * 1024 * 1024, "maxTotalRequestBytes");
  const requestInspectionTimeoutMs = integerOption(options.requestInspectionTimeoutMs, 15_000, 10, 60_000, "requestInspectionTimeoutMs");
  const requestInspector = createRequestInspector({ maxDecodedBytes: maxDecodedRequestBytes, concurrency: 1, maxQueued: 16, timeoutMs: requestInspectionTimeoutMs });
  const requestBufferBudget = createRequestBufferBudget(maxTotalRequestBytes);
  const managedRecovery = options.managedRecovery === true;
  const managedRetryBaseMs = integerOption(options.managedRetryBaseMs, 5000, 10, 60_000, "managedRetryBaseMs");
  const largeHttpBodyBytes = integerOption(options.largeHttpBodyBytes, 4 * 1024 * 1024, 1024, 256 * 1024 * 1024, "largeHttpBodyBytes");
  const incrementalTransport = options.incrementalTransport ?? null;
  const incrementalUpstreamUrl = options.incrementalUpstreamUrl ? new URL(options.incrementalUpstreamUrl) : null;
  if (incrementalTransport && (!incrementalUpstreamUrl || !["ws:", "wss:"].includes(incrementalUpstreamUrl.protocol))) {
    throw new Error("Incremental transport requires an explicit ws or wss upstream URL");
  }
  const maxBufferedResponseBytes = integerOption(options.maxBufferedResponseBytes, DEFAULT_MAX_BUFFERED_RESPONSE_BYTES, 1_024, 256 * 1024 * 1024, "maxBufferedResponseBytes");
  const maxConsecutiveAttempts = integerOption(options.maxConsecutiveAttempts, DEFAULT_MAX_CONSECUTIVE_ATTEMPTS, 1, 20, "maxConsecutiveAttempts");
  const consecutiveWaitLimitMs = integerOption(options.consecutiveWaitLimitMs,
    adaptiveWaitLimitMs + Math.max(0, firstLastProgressTimeoutMs - firstProgressTimeoutMs) * Math.min(2, maxConsecutiveAttempts),
    10, 900_000, "consecutiveWaitLimitMs");
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length === 0 || retryDelaysMs.length > 20
    || retryDelaysMs.some(delay => !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000)) {
    throw new Error("retryDelaysMs must contain 1-20 integer delays between 0 and 60000 ms");
  }
  const attemptStateTtlMs = integerOption(options.attemptStateTtlMs, DEFAULT_ATTEMPT_STATE_TTL_MS, 1_000, 24 * 60 * 60_000, "attemptStateTtlMs");
  const instanceToken = options.instanceToken ?? null;
  const observationInstance = instanceToken ?? crypto.randomUUID();
  const onEvent = typeof options.onEvent === "function"
    ? (event) => {
      try {
        options.onEvent(event);
      } catch {
      }
    }
    : () => {};
  const active = new Map();
  const operationClaims = new Map();
  const attempts = new Map();
  const emptyIdleTurns = new Map();
  const businessProgress = new Map();
  const waitTerminals = new Map();
  const websocketCooldowns = new Map();
  const websocketNow = typeof options.websocketNow === "function" ? options.websocketNow : Date.now;
  const deferWebsocket = threadId => {
    const failures = (websocketCooldowns.get(threadId)?.failures ?? 0) + 1;
    const delayMs = [60_000, 300_000, 900_000][Math.min(failures - 1, 2)];
    websocketCooldowns.delete(threadId);
    websocketCooldowns.set(threadId, { failures, retryAt: websocketNow() + delayMs });
    if (websocketCooldowns.size > 2048) websocketCooldowns.delete(websocketCooldowns.keys().next().value);
    return delayMs;
  };
  const operationLedger = managedRecovery || incrementalTransport ? createModelOperationLedger({
    state: options.operationState, onStateChange: options.onOperationStateChange,
    maxEntries: options.maxUnresolvedOperations,
  }) : null;
  const recoveryHandoff = createThreadRecoveryHandoff({
    state: options.durableRecoveryState,
    onStateChange: options.onDurableRecoveryStateChange,
    maps: { attempts, emptyIdleTurns, businessProgress, waitTerminals },
    active,
    operationLedger,
    policy: { upstreamOrigin: upstreamOrigin.origin, attemptStateTtlMs, maxConsecutiveAttempts,
      consecutiveWaitLimitMs, adaptiveWaitLimitMs, operationLedgerSchema: operationLedger ? 1 : null },
  });
  const sockets = new Set();
  let draining = false;
  const counters = {
    total: 0,
    guarded: 0,
    passthrough: 0,
    retrySignals: 0,
    syntheticCompletions: 0,
    completed: 0,
    actualCompletions: 0,
    softCompletions: 0,
    failed: 0,
    cancelled: 0,
    compactionInternalRetries: 0,
  };

  const pruneAttempts = () => {
    const cutoff = Date.now() - attemptStateTtlMs;
    for (const [key, state] of attempts) if (state.updatedAt < cutoff) attempts.delete(key);
    for (const [key, state] of emptyIdleTurns) if (state.updatedAt < cutoff) emptyIdleTurns.delete(key);
    for (const [key, state] of businessProgress) if (state.updatedAt < cutoff) businessProgress.delete(key);
    for (const [key, state] of waitTerminals) {
      if (state.updatedAt < cutoff && !["unknown", "accepted"].includes(state.acceptance)) waitTerminals.delete(key);
    }
  };
  const recordBusinessProgress = (identity) => {
    const key = attemptKey(identity);
    if (key) businessProgress.set(key, { updatedAt: Date.now() });
    resetEmptyIdleTurns(identity);
  };
  const hasBusinessProgress = (identity) => {
    const key = attemptKey(identity);
    return Boolean(key && businessProgress.has(key));
  };
  const resetEmptyIdleTurns = (identity) => {
    if (identity.threadId) emptyIdleTurns.delete(identity.threadId);
  };
  const recordEmptyIdleTurn = (identity) => {
    if (!identity.threadId || !identity.turnId) return 0;
    const previous = emptyIdleTurns.get(identity.threadId);
    const count = previous?.turnId === identity.turnId ? previous.count : (previous?.count ?? 0) + 1;
    emptyIdleTurns.set(identity.threadId, { count, turnId: identity.turnId,
      terminalTurnId: count >= 3 ? identity.turnId : previous?.terminalTurnId ?? null, updatedAt: Date.now() });
    return count;
  };

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      pruneAttempts();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        instanceToken,
        implementationVersion: IMPLEMENTATION_VERSION,
        draining,
        contextControlFunctions: [...CONTEXT_CONTROL_FUNCTION_NAMES],
        activeRequests: active.size,
        attemptChains: attempts.size,
        firstProgressTimeoutMs,
        firstLastProgressTimeoutMs,
        rapidRetryMinimumMs,
        fastRetryThresholdMs,
        fastRetryDelayMs,
        retryFirstProgressTimeoutMs,
        uploadAllowanceMsPerMiB,
        maxUploadAllowanceMs,
        progressIdleTimeoutMs,
        reasoningProgressIdleTimeoutMs,
        adaptiveWaitLimitMs,
        consecutiveWaitLimitMs,
        upstreamIdleTimeoutMs,
        adaptiveDelivery: adaptiveRegistry.summary(),
        toolPreparationGraceMs,
        bufferedToolPreparationGraceMs,
        bufferedToolProfileCount: bufferedToolIdentityHashes.length,
        compactionAttemptTimeoutMs,
        maxConsecutiveAttempts,
        maxLocalToolAttempts: Math.min(MAX_LOCAL_TOOL_ATTEMPTS, maxConsecutiveAttempts),
        retryDelaysMs: [...retryDelaysMs],
        maxBufferedRequestBytes,
        maxDecodedRequestBytes,
        requestBuffer: requestBufferBudget.status(),
        requestInspection: requestInspector.status(),
        maxBufferedResponseBytes,
        counters,
      }));
      return;
    }
    if (draining) {
      response.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "connection": "close",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: { type: "proxy_draining", message: "Local model stream proxy is draining existing requests." } }));
      return;
    }
    counters.total += 1;
    pruneAttempts();
    const identity = classifyCodexModelRequest(request);
    const key = attemptKey(identity);
    if (managedRecovery && identity.guarded && !key) {
      request.resume();
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { code: "proxy_operation_identity_required",
        message: "Managed recovery requires a stable thread, turn and request-kind identity." } }));
      return;
    }
    const credentialIdentity = crypto.createHash("sha256")
      .update(String(request.headers.authorization ?? "")).update("\0")
      .update(String(request.headers["chatgpt-account-id"] ?? "")).digest("hex");
    if (identity.guarded && recoveryHandoff.blocked(identity.threadId)) {
      response.writeHead(503, { "content-type": "application/json", "connection": "close" });
      response.end(JSON.stringify({ error: { type: "thread_handoff_pending", message: "This thread is moving to another proxy generation." } }));
      return;
    }
    if (identity.guarded) recoveryHandoff.noteRequest(identity.threadId);
    const requestId = crypto.randomUUID();
    const pathname = String(request.url ?? "").split("?")[0].replace(/\/+$/u, "");
    const endpoint = request.method === "POST" && identity.guarded
      ? /\/responses\/compact$/u.test(pathname) ? "compact" : /\/responses$/u.test(pathname) ? "responses" : "unsupported"
      : "unsupported";
    const observation = createRequestObservation({ emit: options.onModelObservation,
      producerInstance: observationInstance, requestId, endpoint });
    const requestState = { requestId, threadId: identity.threadId, turnId: identity.turnId,
      requestKind: identity.requestKind, recoverySequence: 0, cancelled: false, currentAbort: null,
      downstreamFrames: 0, inspectionAbort: new AbortController() };
    if (key && operationClaims.has(key)) {
      request.resume();
      response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { code: "proxy_operation_in_progress",
        message: "This operation already has an active request. No duplicate upstream request was started." } }));
      observation?.ended("failed");
      return;
    }
    if (key) operationClaims.set(key, requestId);
    const compactionDeadlineAt = identity.requestKind === "compaction" ? Date.now() + compactionAttemptTimeoutMs : null;
    let compactionPreparationTimer = null;
    const bodyLease = requestBufferBudget.lease();
    const requestBody = createRequestBodyOwner(bodyLease, { retainUntilReleased: managedRecovery || Boolean(incrementalTransport) });
    requestState.recovery = createStreamRecovery(requestId);
    active.set(requestId, requestState);
    const threadHash = hashIdentity(identity.threadId);
    const turnHash = hashIdentity(identity.turnId);
    const emit = (event) => onEvent({
      at: new Date().toISOString(),
      requestId,
      requestKind: identity.requestKind,
      threadHash,
      turnHash,
      correlation: correlationQuality(threadHash, turnHash),
      ...event,
    });
    emit({
      type: "request_observed",
      method: request.method,
      path: requestPathForLog(request.url),
      guarded: identity.guarded,
      headerState: summarizeRequestHeaders(request.headers),
    });
    const rememberAttemptFailure = (failures, startedAt, details = {}) => {
      if (!key) return;
      const previous = attempts.get(key);
      const progressRetryProbeUsed = Boolean(previous?.progressRetryProbeUsed || details.progressRetryProbeUsed);
      const firstProgressRetryProbeUsed = Boolean(previous?.firstProgressRetryProbeUsed || details.firstProgressRetryProbeUsed);
      attempts.set(key, {
        failures: Math.max(previous?.failures ?? 0, failures),
        startedAt: previous?.startedAt ?? startedAt,
        updatedAt: Date.now(),
        replayUnsafe: Boolean(previous?.replayUnsafe || details.replayUnsafe),
        ...mergeRequestWaitState(previous, details),
        progressIdentityState: mergeRequestProgressState(previous?.progressIdentityState, details.progressIdentityState),
        progressRetryProbeUsed,
        progressRetryProbePending: !progressRetryProbeUsed && Boolean(details.progressRetryProbePending || previous?.progressRetryProbePending),
        firstProgressRetryProbeUsed,
        firstProgressRetryProbePending: !firstProgressRetryProbeUsed
          && Boolean(details.firstProgressRetryProbePending || previous?.firstProgressRetryProbePending),
      });
    };
    const finishTerminalFailure = (notice, eventType, details = {}, headers = {}) => {
      observation?.ended("failed");
      const canCountEmptyIdle = identity.requestKind === "turn" && Boolean(key)
        && !["safety_policy", "safety", "local_state"].includes(details.category);
      const emptyIdleCount = canCountEmptyIdle && !hasBusinessProgress(identity) ? recordEmptyIdleTurn(identity) : 0;
      const repeatedEmptyIdle = emptyIdleCount >= 3;
      const code = repeatedEmptyIdle ? "proxy_repeated_empty_idle" : details.code ?? details.reason ?? "proxy_request_failed";
      const message = repeatedEmptyIdle && details.code !== code && details.reason !== code
        ? `${notice}\n连续三个回合没有模型文本或已完成的工具工作，本回合已停止自动继续。` : notice;
      ensureSseHead(response, headers);
      if (key) waitTerminals.set(key, { notice: message, reason: code,
        category: details.category, acceptance: details.acceptance, credentialIdentity, updatedAt: Date.now() });
      const hardFailure = repeatedEmptyIdle || details.category === "local_state" || details.category === "acceptance_unknown"
        || eventType === "request_acceptance_unresolved";
      response.end(hardFailure ? requestState.recovery.fail(code, message) : requestState.recovery.finish(message));
      if (hardFailure) counters.failed += 1;
      else {
        counters.syntheticCompletions += 1;
        counters.softCompletions += 1;
      }
      emit({ type: repeatedEmptyIdle ? "empty_idle_terminal_failure" : eventType, emptyIdleCount, hardFailure, ...details });
      if (!key) emit({ type: "untracked_identity_terminal_failure", reason: details.reason ?? null });
      return { hardFailure, emptyIdleCount };
    };
    const finishAdaptiveWait = (reason, headers = {}) => {
      if (key) attempts.delete(key);
      const notice = reason === "ADAPTIVE_WAIT_LIMIT"
        ? `\n\n本次模型请求已达到${Math.ceil(adaptiveWaitLimitMs / 1000)}秒等待上限，已停止自动重试。`
        : "\n\n上游连接长时间未发送任何有效事件，本轮无法安全自动重试，已停止，请核对已有输出后继续。";
      if (key) waitTerminals.set(key, { notice, reason, updatedAt: Date.now() });
      finishTerminalFailure(notice, "adaptive_wait_stopped", { reason, category: "wait_budget" }, headers);
    };
    const recoveryState = state => {
      requestState.recoverySequence += 1;
      requestState.recoveryWait = { ...state, sequence: requestState.recoverySequence };
      const event = { type: "model_recovery_state", requestId, threadId: identity.threadId, turnId: identity.turnId,
        requestKind: identity.requestKind, ...requestState.recoveryWait };
      emit(event);
      try { options.onRecoveryState?.(event); } catch { emit({ type: "recovery_state_observer_failed" }); }
    };
    requestState.onBusinessProgress = progress => {
      if (!["waiting", "retrying"].includes(requestState.recoveryWait?.phase)) return;
      recoveryState({ ...requestState.recoveryWait, phase: "resumed", willRetry: false,
        canContinueHttp: false, ...progress });
    };
    const waitForRecovery = async ({ delayMs, reason, acceptance, canContinueHttp = false,
      retryNumber = 0, httpStatusCode = null, streamKeepalive = true }) => {
      const state = { phase: "waiting", reason, acceptance, canContinueHttp, retryNumber,
        willRetry: delayMs !== null, startedAt: Date.now(),
        httpStatusCode: Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599
          ? httpStatusCode : null };
      recoveryState(state);
      if (streamKeepalive) ensureSseHead(response);
      const action = await waitForRecoveryAction(delayMs, requestState, { canContinueHttp,
        keepaliveIntervalMs: Math.max(100, Math.min(1000, options.heartbeatIntervalMs ?? 1000)),
        onKeepalive: () => {
          if (response.destroyed || response.writableEnded) {
            requestState.cancelled = true;
            return;
          }
          if (streamKeepalive) response.write('event: ping\ndata: {"type":"ping"}\n\n');
        },
      });
      recoveryState({ ...state, phase: action === "cancel" ? "stopped" : "retrying", willRetry: action !== "cancel" });
      return action;
    };
    const finish = () => {
      observation?.ended(requestState.cancelled ? "cancelled" : "ended_unknown");
      clearTimeout(compactionPreparationTimer);
      requestBody.releaseUnused();
      active.delete(requestId);
      if (key && operationClaims.get(key) === requestId) operationClaims.delete(key);
    };
    response.once("close", () => {
      if (response.writableFinished) return;
      requestState.cancelled = true;
      requestState.inspectionAbort.abort();
      requestState.currentAbort?.();
      counters.cancelled += 1;
      emit({
        type: "downstream_cancelled",
        closeTrigger: "response_close",
        responseWritableEnded: response.writableEnded,
        responseDestroyed: response.destroyed,
        responseHeadersSent: response.headersSent,
        requestAborted: request.aborted,
        requestComplete: request.complete,
      });
      if (!identity.guarded || request.method !== "POST") finish();
    });
    let targetUrl;
    try {
      targetUrl = new URL(request.url ?? "/", upstreamOrigin);
      if (targetUrl.origin !== upstreamOrigin.origin) throw new Error("Model request URL must use the configured upstream origin.");
    } catch {
      response.writeHead(400, { "content-type": "application/json", "connection": "close" });
      response.end(JSON.stringify({ error: { type: "invalid_proxy_url", message: "Invalid model request URL." } }));
      observation?.ended("failed");
      finish();
      return;
    }
    if (!identity.guarded || request.method !== "POST") {
      counters.passthrough += 1;
      emit({ type: "passthrough", reason: !identity.guarded ? "request_kind" : "method" });
      observation?.unsupported();
      forwardPassthrough(request, response, targetUrl, emit);
      response.once("finish", finish);
      return;
    }

    try {
      if (compactionDeadlineAt !== null) {
        compactionPreparationTimer = setTimeout(() => {
          requestState.compactionPreparationTimedOut = true;
          requestState.inspectionAbort.abort();
        }, Math.max(0, compactionDeadlineAt - Date.now()));
      }
      requestBody.assign(await collectRequestBody(request, maxBufferedRequestBytes, bodyLease, requestState.inspectionAbort.signal,
        { idleTimeoutMs: requestInspectionTimeoutMs }));
      const inspected = await requestInspector.inspect(requestBody.body, request.headers["content-encoding"], {
        signal: requestState.inspectionAbort.signal, includePayload: Boolean(incrementalTransport),
      });
      if (incrementalTransport && !bodyLease.reserve(inspected.decodedBytes)) {
        throw Object.assign(new Error("Decoded request cannot fit the aggregate request budget"), {
          code: "REQUEST_BUFFER_BUSY", statusCode: 503, errorType: "proxy_request_capacity", localRequestFailure: true,
        });
      }
      clearTimeout(compactionPreparationTimer);
      if (requestState.cancelled) return;
      const compactionRemainingMs = compactionDeadlineAt === null ? compactionAttemptTimeoutMs : Math.max(0, compactionDeadlineAt - Date.now());
      if (compactionDeadlineAt !== null && compactionRemainingMs === 0) throw Object.assign(new Error("Compaction classification budget exhausted"), { code: "COMPACTION_CONTROL_TIMEOUT" });
      observation?.parsed(inspected.modelInvalid ? { invalid: true } : inspected.model);
      emit({ type: "request_body_inspected", encodedBytes: requestBody.bytes, decodedBytes: inspected.decodedBytes,
        contentEncoding: inspected.contentEncoding, decodedLimit: maxDecodedRequestBytes });
      counters.guarded += 1;
      const contextHint = inspected.contextHint;
      if (key && waitTerminals.get(key)?.category === "authentication"
        && waitTerminals.get(key).acceptance === "rejected"
        && waitTerminals.get(key).credentialIdentity !== credentialIdentity) {
        waitTerminals.delete(key);
        attempts.delete(key);
      }
      const protectedOperation = key && operationLedger?.get(key);
      if (key && waitTerminals.has(key) && !protectedOperation) {
        const terminal = waitTerminals.get(key);
        if (identity.requestKind === "compaction" && terminal.httpFailure) {
          response.writeHead(terminal.httpFailure.statusCode, { "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store", ...terminal.httpFailure.headers });
          response.end(JSON.stringify({ error: terminal.httpFailure.error }));
          return;
        }
        finishTerminalFailure(terminal.notice, "adaptive_wait_terminal_replayed", terminal);
        return;
      }
      if (protectedOperation) {
        const code = "proxy_operation_recovery_protected";
        const notice = "此前请求已发送，上游结果尚未核实，已保留恢复记录并停止重发。请取消当前回合，核对已有输出后再开始新回合。";
        recoveryState({ phase: "failed", reason: code, acceptance: protectedOperation.acceptance,
          category: "acceptance_unknown", willRetry: false, canContinueHttp: false });
        finishTerminalFailure(notice, "request_acceptance_unresolved", {
          code, reason: protectedOperation.reason, acceptance: protectedOperation.acceptance, category: "acceptance_unknown",
        });
        return;
      }
      emit({ type: "request_phase_observed", ...contextHint });
      if (identity.requestKind === "compaction" && identity.threadId) {
        incrementalTransport?.invalidate(identity.threadId, "compaction");
      }
      const transport = identity.requestKind === "compaction"
        ? compactionTransport(targetUrl, inspected, request.headers)
        : "sampling_sse";

      if (identity.requestKind === "compaction" && transport !== "sampling_sse") {
        emit({ type: "compaction_attempt_started", internalAttempt: 1, timeoutMs: compactionRemainingMs, classifiedTimeoutMs: compactionAttemptTimeoutMs });
        let outcome;
        let compactionRetryNumber = 0;
        for (;;) {
          if (key) operationLedger?.begin(key);
          outcome = await executeBufferedCompactionAttempt({
          requestBody,
          headers: request.headers,
          method: request.method,
          targetUrl,
          timeoutMs: Math.max(1, compactionDeadlineAt - Date.now()),
          maxBufferedResponseBytes,
          requestState,
          observation,
          onEvent: emit,
          });
          if (key) operationLedger?.settle(key, outcome);
          if (!managedRecovery || requestState.cancelled || outcome.kind === "completed" || !outcome.policy?.retryable) break;
          compactionRetryNumber += 1;
          const remaining = compactionDeadlineAt - Date.now();
          if (remaining <= 0) break;
          const delayMs = Math.min(remaining, 60_000, managedRetryBaseMs * 2 ** Math.min(6, compactionRetryNumber - 1));
          const action = await waitForRecovery({ delayMs, reason: outcome.policy.reasonCode,
            acceptance: outcome.policy.acceptance, httpStatusCode: outcome.statusCode,
            retryNumber: compactionRetryNumber, canContinueHttp: true, streamKeepalive: false });
          if (action === "cancel" || requestState.cancelled) return;
          if (Date.now() >= compactionDeadlineAt) break;
          requestBody.approveReplay();
        }
        emit({ type: "compaction_attempt_finished", internalAttempt: 1, kind: outcome.kind, reason: outcome.reason ?? null });
        if (requestState.cancelled || outcome?.kind === "cancelled") return;
        if (outcome.failure?.safetyPolicy) {
          if (key) attempts.delete(key);
          response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: { type: "safety_policy", code: outcome.failure.code, message: safetyPolicyNotice(outcome.failure) } }));
          counters.failed += 1;
          emit({ type: "safety_policy_terminal_failure", category: "safety_policy", code: outcome.failure.code });
          return;
        }
        const preserveUpstreamError = outcome?.kind === "permanent_failure"
          || ["authentication", "quota", "safety", "permanent", "payload_too_large"].includes(outcome.policy?.category);
        if (preserveUpstreamError && key && outcome.kind !== "completed") {
          const statusCode = outcome.statusCode >= 400 ? outcome.statusCode
            : outcome.policy.category === "authentication" ? 401 : outcome.policy.category === "quota" ? 429 : 400;
          waitTerminals.set(key, { notice: outcome.failure?.message ?? "Compaction request failed.",
            reason: outcome.policy.reasonCode, category: outcome.policy.category, acceptance: outcome.policy.acceptance,
            credentialIdentity, updatedAt: Date.now(), httpFailure: { statusCode,
              headers: typeof outcome.headers?.["www-authenticate"] === "string"
                ? { "www-authenticate": outcome.headers["www-authenticate"].slice(0, 2048) } : {},
              error: { code: outcome.policy.reasonCode, type: outcome.policy.reasonCode,
                message: outcome.failure?.message ?? "Compaction request failed." } } });
        }
        if (outcome?.kind === "completed" || preserveUpstreamError) {
          writeHeadOnce(response, outcome.statusCode ?? 502, outcome.statusMessage, outcome.headers ?? {});
          response.end(outcome.body ?? Buffer.alloc(0));
          if (outcome.kind === "completed") {
            counters.completed += 1;
            counters.actualCompletions += 1;
          }
          else counters.failed += 1;
          return;
        }
        response.writeHead(502, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "connection": "close",
        });
        response.end(JSON.stringify({
          error: {
            type: "upstream_retryable_failure",
            code: outcome?.reason ?? "COMPACTION_UPSTREAM_FAILURE",
            message: "The upstream compact request failed before producing a valid JSON result.",
          },
        }));
        counters.failed += 1;
        counters.retrySignals += 1;
        emit({ type: "compaction_retryable_http_failure", reason: outcome?.reason ?? "UNKNOWN" });
        return;
      }

      const prior = key ? attempts.get(key) : null;
      const chainWaitLimitMs = prior?.waitBudgetProgressAt > 0 ? adaptiveWaitLimitMs : consecutiveWaitLimitMs;
      const chainStartedAt = prior?.startedAt ?? Date.now();
      const attemptNumber = key ? (prior?.failures ?? 0) + 1 : null;
      const finalAttempt = Boolean(key && attemptNumber >= maxConsecutiveAttempts);
      const compactionRequest = identity.requestKind === "compaction";
      const firstProgressRetryProbe = Boolean(!compactionRequest && key && prior?.firstProgressRetryProbePending
        && !prior.firstProgressRetryProbeUsed && !prior.replayUnsafe);
      const ordinaryFirstProgressTimeoutMs = !compactionRequest && key && (attemptNumber === 1 || finalAttempt)
        ? Math.max(firstProgressTimeoutMs, firstLastProgressTimeoutMs) : firstProgressTimeoutMs;
      const attemptFirstProgressTimeoutMs = firstProgressRetryProbe
        ? Math.max(ordinaryFirstProgressTimeoutMs, retryFirstProgressTimeoutMs) : ordinaryFirstProgressTimeoutMs;
      const uploadAllowanceMs = compactionRequest ? 0
        : requestUploadAllowanceMs(requestBody.bytes, uploadAllowanceMsPerMiB, maxUploadAllowanceMs);
      const progressRetryProbe = Boolean(key && prior?.progressRetryProbePending && !prior?.progressRetryProbeUsed);
      const attemptToolInputProgressIdleTimeoutMs = progressRetryProbe
        ? Math.max(progressIdleTimeoutMs, retryProgressIdleTimeoutMs)
        : progressIdleTimeoutMs;
      if (!compactionRequest && (prior?.waitBudgetSpentMs ?? 0) >= chainWaitLimitMs) {
        finishAdaptiveWait("ADAPTIVE_WAIT_LIMIT");
        return;
      }
      if (progressRetryProbe || firstProgressRetryProbe) {
        attempts.set(key, { ...prior,
          ...(progressRetryProbe ? { progressRetryProbePending: false, progressRetryProbeUsed: true } : {}),
          ...(firstProgressRetryProbe ? { firstProgressRetryProbePending: false, firstProgressRetryProbeUsed: true } : {}),
          updatedAt: Date.now() });
      }
      emit({ type: "turn_attempt_started", attemptNumber, maxConsecutiveAttempts, finalAttempt, untrackedIdentity: !key,
        firstProgressTimeoutMs: attemptFirstProgressTimeoutMs, uploadAllowanceMs,
        firstProgressDeadlineMs: compactionRequest ? compactionAttemptTimeoutMs : uploadAllowanceMs + attemptFirstProgressTimeoutMs,
        firstProgressRetryProbe, waitBudgetRemainingMs: compactionRequest ? null : Math.max(0, chainWaitLimitMs - (prior?.waitBudgetSpentMs ?? 0)),
        progressIdleTimeoutMs,
        reasoningProgressIdleTimeoutMs,
        toolInputProgressIdleTimeoutMs: attemptToolInputProgressIdleTimeoutMs, progressRetryProbe });
      let outcome;
      let managedRetryNumber = 0;
      let websocketAttempts = 0;
      let forceHttp = (websocketCooldowns.get(identity.threadId)?.retryAt ?? 0) > websocketNow();
      for (;;) {
        if (key) operationLedger?.begin(key);
        const websocketHeaders = { ...request.headers,
          "openai-beta": [request.headers["openai-beta"], "responses_websockets=2026-02-06"].filter(Boolean).join(", "),
          originator: request.headers.originator ?? "codex_cli_rs",
        };
        const upstreamClient = incrementalTransport && key && !forceHttp && !compactionRequest
          && (!inspected.hasImages || options.incrementalImagesEnabled === true)
          ? incrementalTransport.createRequestClient({ sessionKey: identity.threadId, operationId: requestId,
            retryWithoutOutput: managedRetryNumber > 0,
            payload: inspected.payload, url: incrementalUpstreamUrl.href, headers: websocketHeaders,
            onPreparationProgress: (progress) => requestState.onPreparationProgress?.(progress),
            onPacketSending: (progress) => requestState.onPacketSending?.(progress) }) : null;
        if (upstreamClient) websocketAttempts += 1;
        outcome = await executeTurnAttempt({
        requestBody,
        downstream: response,
        headers: upstreamClient ? websocketHeaders : request.headers,
        method: request.method,
        targetUrl,
        firstProgressTimeoutMs: attemptFirstProgressTimeoutMs,
        progressIdleTimeoutMs,
        reasoningProgressIdleTimeoutMs,
        toolInputProgressIdleTimeoutMs: attemptToolInputProgressIdleTimeoutMs,
        compactionAttemptTimeoutMs: compactionRequest ? Math.max(1, compactionDeadlineAt - Date.now()) : compactionAttemptTimeoutMs,
        toolPreparationGraceMs,
        bufferedToolIdentityHashes,
        bufferedToolPreparationGraceMs,
        contextHint,
        adaptiveRegistry,
        adaptiveKey: identity.requestKind === "turn" ? deliveryProfileKey(request.headers, inspected, upstreamOrigin.origin) : null,
        adaptiveWaitLimitMs,
        consecutiveWaitLimitMs: chainWaitLimitMs,
        priorWaitState: prior,
        uploadAllowanceMs,
        uploadAllowanceMsPerMiB,
        maxUploadAllowanceMs,
        compactionRequest,
        upstreamIdleTimeoutMs,
        adaptiveStreamMinSpanMs,
        finalAttempt,
        maxBufferedResponseBytes,
        onEvent: emit,
        requestState,
        observation,
        nativeAttempt: attemptNumber,
        upstreamClient,
      });
        const replayWithoutOutput = !outcome.progressObserved && !outcome.sawReplayUnsafeContent
          && !outcome.sawSubstantiveWork && !outcome.sawTool && !outcome.deliveredExecutableToolDone
          && !outcome.sawHostedTool && (!outcome.sawCompaction || compactionRequest && outcome.frames === 0);
        outcome.nativeRecovery = !compactionRequest && !outcome.sawCompaction
          && ["temporary", "acceptance_unknown"].includes(outcome.policy?.category) && !replayWithoutOutput;
        const fallbackPayload = upstreamClient && ["payload_too_large", "transport_capacity"].includes(outcome.policy?.category) && replayWithoutOutput;
        if (key) operationLedger?.settle(key, fallbackPayload
          ? { ...outcome, policy: { ...outcome.policy, acceptance: "rejected" } } : outcome);
        if (upstreamClient && outcome.kind === "completed") websocketCooldowns.delete(identity.threadId);
        const fallbackNetwork = upstreamClient && replayWithoutOutput && outcome.policy?.retryable && websocketAttempts >= 2;
        if (upstreamClient && outcome.nativeRecovery) deferWebsocket(identity.threadId);
        if (managedRecovery && !compactionRequest && (fallbackPayload || fallbackNetwork) && !requestState.cancelled) {
          const retryAfterMs = deferWebsocket(identity.threadId);
          incrementalTransport.invalidate(identity.threadId, "http_fallback");
          forceHttp = true;
          recoveryState({ phase: "retrying", reason: fallbackPayload
            ? (outcome.policy.category === "transport_capacity" ? "websocket_capacity_requires_http" : "websocket_payload_requires_http")
            : "websocket_http_fallback",
            acceptance: outcome.policy.acceptance, willRetry: true, canContinueHttp: false, retryAfterMs, websocketAttempts });
          requestBody.approveReplay();
          continue;
        }
        if (!managedRecovery || requestState.cancelled || outcome.kind === "completed"
          || !outcome.policy?.retryable || !replayWithoutOutput) break;
        managedRetryNumber += 1;
        const remainingCompactionMs = compactionRequest ? compactionDeadlineAt - Date.now() : null;
        if (remainingCompactionMs !== null && remainingCompactionMs <= 0) break;
        const largeHttpWait = !upstreamClient && requestBody.bytes >= largeHttpBodyBytes;
        const action = await waitForRecovery({
          delayMs: Math.min(remainingCompactionMs ?? Infinity,
            60_000, managedRetryBaseMs * 2 ** Math.min(6, managedRetryNumber - 1)),
          reason: largeHttpWait ? "large_http_retransmission_waiting" : outcome.policy.reasonCode,
          acceptance: outcome.policy.acceptance, retryNumber: managedRetryNumber,
          httpStatusCode: outcome.httpStatus ?? outcome.failureDiagnostics?.statusCode,
        });
        if (action === "cancel" || requestState.cancelled) return;
        if (remainingCompactionMs !== null && Date.now() >= compactionDeadlineAt) break;
        forceHttp = forceHttp || action === "continue_http";
        requestBody.approveReplay();
      }
      emit({
        type: "turn_attempt_finished",
        attemptNumber,
        kind: outcome.kind,
        phase: outcome.phase,
        endCause: outcome.endCause,
        failureDiagnostics: outcome.failureDiagnostics,
        contextPreparationHint: outcome.contextPreparationHint,
        reason: outcome.reason,
        elapsedMs: outcome.elapsedMs,
        frames: outcome.frames,
        sawContent: outcome.sawContent,
        sawReplayUnsafeContent: outcome.sawReplayUnsafeContent,
        sawSubstantiveWork: outcome.sawSubstantiveWork,
        sawExecutableToolDone: outcome.sawExecutableToolDone,
        sawTool: outcome.sawTool,
        sawCompaction: outcome.sawCompaction,
        sawHostedTool: outcome.sawHostedTool,
        toolItemTypes: outcome.toolItemTypes,
      });
      const replayUnsafe = Boolean(prior?.replayUnsafe
        || outcome.sawReplayUnsafeContent || outcome.sawSubstantiveWork || outcome.sawTool
        || outcome.sawExecutableToolDone || outcome.sawCompaction || outcome.sawHostedTool);
      if (requestState.cancelled || outcome.kind === "cancelled") {
        if (!compactionRequest && !outcome.sawCompaction) {
          rememberAttemptFailure(attemptNumber, chainStartedAt, { replayUnsafe,
            ...mergeRequestWaitState({}, outcome),
            progressIdentityState: outcome.progressIdentityState, firstProgressRetryProbeUsed: firstProgressRetryProbe });
        }
        return;
      }
      if (outcome.kind === "completed") {
        if (key) attempts.delete(key);
        recoveryState({ phase: "completed", reason: "upstream_completed", acceptance: "accepted",
          willRetry: false, canContinueHttp: false });
        if (outcome.sawSubstantiveWork || outcome.sawExecutableToolDone) recordBusinessProgress(identity);
        counters.completed += 1;
        counters.actualCompletions += 1;
        return;
      }
      if (outcome.sawSubstantiveWork || outcome.deliveredExecutableToolDone) recordBusinessProgress(identity);
      const nativeRetryFallback = ["temporary", "acceptance_unknown"].includes(outcome.policy?.category)
        && !outcome.sawCompaction && identity.requestKind !== "compaction";
      if (outcome.policy && !outcome.policy.retryable && !nativeRetryFallback) {
        const policy = outcome.policy;
        const unresolved = ["accepted", "unknown"].includes(policy.acceptance)
          && !["authentication", "quota", "safety", "permanent"].includes(policy.category);
        const notice = unresolved
          ? "上游是否完成了本次请求仍待核对，已保留操作状态并停止自动重发，避免重复生成或执行工具。"
          : policy.category === "authentication" ? "模型认证失败，请重新登录或刷新认证后继续。"
            : policy.category === "quota" ? USAGE_LIMIT_NOTICE
              : policy.category === "safety" ? safetyPolicyNotice(outcome.failure)
                : permanentFailureNotice(outcome.failure);
        if (key) attempts.delete(key);
        recoveryState({ phase: "failed", reason: policy.reasonCode, acceptance: policy.acceptance,
          category: policy.category, willRetry: false, canContinueHttp: false });
        finishTerminalFailure(notice, unresolved ? "request_acceptance_unresolved" : "model_terminal_failure", {
          category: policy.category, code: policy.reasonCode, reason: outcome.reason, acceptance: policy.acceptance,
        }, outcome.upstreamHeaders);
        return;
      }
      if (outcome.sawSubstantiveWork) recordBusinessProgress(identity);
      const remainingChainWaitLimitMs = outcome.waitBudgetProgressAt > 0 ? adaptiveWaitLimitMs : chainWaitLimitMs;
      const retryableAdaptiveIdle = outcome.kind === "adaptive_wait_timeout"
        && outcome.reason === "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT"
        && Boolean(key) && !replayUnsafe && (outcome.waitBudgetSpentMs ?? 0) < remainingChainWaitLimitMs;
      const progressRetryProbeUsed = Boolean(prior?.progressRetryProbeUsed || progressRetryProbe);
      const retryState = { replayUnsafe,
        ...(!compactionRequest && !outcome.sawCompaction ? mergeRequestWaitState({}, outcome) : {}),
        progressIdentityState: outcome.progressIdentityState,
        firstProgressRetryProbeUsed: Boolean(prior?.firstProgressRetryProbeUsed || firstProgressRetryProbe),
        firstProgressRetryProbePending: !compactionRequest && !outcome.sawCompaction && !replayUnsafe
          && !prior?.firstProgressRetryProbeUsed && !firstProgressRetryProbe
          && retryFirstProgressTimeoutMs > firstProgressTimeoutMs
          && outcome.reason === "FIRST_PROGRESS_TIMEOUT" && outcome.endCause === "local_timer"
          && outcome.firstProgressDelayMs === null,
        progressRetryProbeUsed,
        progressRetryProbePending: !progressRetryProbeUsed && retryProgressIdleTimeoutMs > progressIdleTimeoutMs
          && outcome.reason === "PROGRESS_IDLE_TIMEOUT" && outcome.endCause === "local_timer"
          && outcome.phase === "tool_parameters" && !outcome.sawExecutableToolDone };
      if (outcome.kind === "adaptive_wait_timeout") {
        if (!retryableAdaptiveIdle) {
          finishAdaptiveWait((outcome.waitBudgetSpentMs ?? 0) >= remainingChainWaitLimitMs ? "ADAPTIVE_WAIT_LIMIT" : outcome.reason, outcome.upstreamHeaders);
          return;
        }
        emit({ type: "adaptive_idle_retry_eligible", attemptNumber, finalAttempt,
          waitBudgetRemainingMs: Math.max(0, remainingChainWaitLimitMs - (outcome.waitBudgetSpentMs ?? 0)) });
      }
      if (outcome.failure?.safetyPolicy) {
        if (key) attempts.delete(key);
        const details = { category: "safety_policy", code: outcome.failure.code, reason: outcome.reason };
        const notice = safetyPolicyNotice(outcome.failure);
        if (identity.requestKind === "compaction" || outcome.sawCompaction) {
          ensureSseHead(response, outcome.upstreamHeaders ?? {});
          response.end(requestState.recovery.fail(outcome.failure.code, notice));
          counters.failed += 1;
          emit({ type: "safety_policy_terminal_failure", ...details });
        } else {
          finishTerminalFailure(`\n\n${notice}`, "safety_policy_terminal_failure", details, outcome.upstreamHeaders);
        }
        return;
      }
      if (outcome.kind === "local_phase_timeout") {
        const onlyLocalFunctions = outcome.toolItemTypes.length > 0
          && outcome.toolItemTypes.every(type => type === "function_call")
          && !outcome.sawHostedTool && !outcome.sawCompaction;
        const preparationNotDelivered = outcome.failure.category === "tool_preparation"
          && outcome.preparationPending && !outcome.sawExecutableToolDone;
        const heldContextCompletion = outcome.failure.category === "tool_completion"
          && outcome.holdingToolDone && outcome.toolNames.length > 0
          && outcome.toolNames.every(name => CONTEXT_CONTROL_FUNCTION_NAMES.has(name));
        const safeLocalRetry = onlyLocalFunctions && !outcome.sawSubstantiveWork
          && !outcome.deliveredExecutableToolDone && (preparationNotDelivered || heldContextCompletion);
        const localAttemptLimit = Math.min(MAX_LOCAL_TOOL_ATTEMPTS, maxConsecutiveAttempts);
        if (safeLocalRetry && key && attemptNumber < localAttemptLimit) {
          rememberAttemptFailure(attemptNumber, chainStartedAt, retryState);
          ensureSseHead(response, outcome.upstreamHeaders ?? {});
          response.end();
          counters.retrySignals += 1;
          emit({ type: "local_tool_phase_retry_signal", reason: outcome.reason, category: outcome.failure.category,
            attemptNumber, maxAttempts: localAttemptLimit, retrySafety: preparationNotDelivered ? "arguments_not_delivered" : "context_completion_held" });
          return;
        }
        if (key) attempts.delete(key);
        const notice = safeLocalRetry && key
          ? "\n\n本地工具阶段等待超时，已达到有限自动重试上限，请继续。"
          : "\n\n本地工具准备或完成确认等待超时，本轮未自动重试，请继续。";
        if (key) {
          waitTerminals.set(key, { notice, reason: outcome.reason, updatedAt: Date.now() });
        }
        finishTerminalFailure(notice, "local_tool_phase_timeout", {
          category: outcome.failure.category, reason: outcome.reason, safeLocalRetry, attemptNumber, maxAttempts: localAttemptLimit,
        }, outcome.upstreamHeaders);
        return;
      }
      if (identity.requestKind === "compaction" || outcome.sawCompaction) {
        const terminalCompactionFailure = !key || finalAttempt
          || outcome.kind === "permanent_failure"
          || outcome.kind === "usage_limit";
        if (terminalCompactionFailure) {
          ensureSseHead(response, outcome.upstreamHeaders);
          response.end(requestState.recovery.fail(
            "proxy_compaction_failed",
            "The compaction stream failed before a valid upstream completion.",
          ));
          if (key) attempts.delete(key);
          counters.failed += 1;
          emit({ type: "compaction_stream_terminal_failure", reason: outcome.reason, untrackedIdentity: !key });
          return;
        }
        rememberAttemptFailure(attemptNumber, chainStartedAt, retryState);
        ensureSseHead(response, outcome.upstreamHeaders ?? {});
        response.end();
        counters.retrySignals += 1;
        emit({ type: "compaction_retry_signal", reason: outcome.reason ?? "UNKNOWN" });
        return;
      }
      if (!key) {
        const notice = outcome.kind === "usage_limit"
          ? USAGE_LIMIT_NOTICE
          : outcome.kind === "permanent_failure"
            ? permanentFailureNotice(outcome.failure)
            : NETWORK_EXHAUSTED_NOTICE;
        finishTerminalFailure(notice, "untracked_identity_terminal_failure", {
          reason: outcome.reason,
          category: outcome.failure?.category ?? "network",
        }, outcome.upstreamHeaders);
        return;
      }
      if (outcome.kind === "permanent_failure") {
        attempts.delete(key);
        finishTerminalFailure(permanentFailureNotice(outcome.failure), "permanent_failure_terminal_failure", {
          code: outcome.failure?.code ?? null,
          reason: outcome.reason,
        }, outcome.upstreamHeaders);
        return;
      }
      if (outcome.kind === "usage_limit") {
        attempts.delete(key);
        finishTerminalFailure(USAGE_LIMIT_NOTICE, "usage_limit_terminal_failure", {
          reason: outcome.reason,
        }, outcome.upstreamHeaders);
        return;
      }
      rememberAttemptFailure(attemptNumber, chainStartedAt, retryState);
      if (finalAttempt) {
        const notice = outcome.failure?.category === "capacity" ? CAPACITY_EXHAUSTED_NOTICE : NETWORK_EXHAUSTED_NOTICE;
        attempts.delete(key);
        if (retryableAdaptiveIdle || prior?.waitBudgetSpentMs) {
          waitTerminals.set(key, { notice, reason: "RETRY_EXHAUSTED", updatedAt: Date.now() });
        }
        finishTerminalFailure(notice, "retry_exhausted_terminal_failure", {
          attemptNumber,
          category: outcome.failure?.category ?? "network",
          reason: outcome.reason,
        }, outcome.upstreamHeaders);
        return;
      }
      const retryDelay = nativeRetryDelay({ elapsedMs: outcome.elapsedMs, attemptNumber, maxConsecutiveAttempts,
        chainElapsedMs: Date.now() - chainStartedAt, rapidRetryMinimumMs, fastRetryThresholdMs, fastRetryDelayMs });
      const rapidDelayMs = retryDelay.delayMs;
      if (rapidDelayMs > 0) {
        emit({ type: "rapid_retry_wait_started", attemptNumber, delayMs: rapidDelayMs, reason: outcome.reason,
          fastFailure: retryDelay.fast, fastRetryThresholdMs, fastRetryDelayMs, finalGapMs: retryDelay.finalGapMs });
        if (!await waitForRetry(rapidDelayMs, requestState, {
          onKeepalive: () => {
            if (!response.destroyed && !response.writableEnded) {
              ensureSseHead(response, outcome.upstreamHeaders ?? {});
              response.write(sseFrame({ type: "proxy.keepalive" }));
            }
          },
        })) return;
      }
      ensureSseHead(response, outcome.upstreamHeaders ?? {});
      response.end();
      counters.retrySignals += 1;
      emit({ type: "native_retry_signal", attemptNumber, reason: outcome.reason, category: outcome.failure?.category ?? "network",
        failureDiagnostics: outcome.failureDiagnostics });
    } catch (error) {
      if (requestState.compactionPreparationTimedOut && !requestState.cancelled) {
        error = Object.assign(new Error("Compaction classification budget exhausted"), { code: "COMPACTION_CONTROL_TIMEOUT" });
      }
      if (error.code === "COMPACTION_CONTROL_TIMEOUT" && identity.requestKind === "compaction" && !requestState.cancelled) {
        counters.failed += 1;
        observation?.ended("failed");
        emit({ type: "compaction_preparation_timeout", timeoutMs: compactionAttemptTimeoutMs, upstreamRequestStarted: false });
        if (!response.destroyed && !response.headersSent) {
          response.writeHead(504, { "content-type": "application/json; charset=utf-8", "connection": "close" });
          response.end(JSON.stringify({ error: { type: "server_error", code: "proxy_compaction_timeout", message: "Compaction request exceeded its classified time budget." } }));
        }
        return;
      }
      if (requestState.cancelled || error.code === "REQUEST_ABORTED") return;
      counters.failed += 1;
      observation?.ended("failed");
      if (/^MODEL_OPERATION_/u.test(error.code ?? "")) {
        const notice = error.code === "MODEL_OPERATION_LEDGER_FULL"
          ? "尚未核实的操作记录已达到保护上限，请先核对已有操作，再开始新请求。"
          : "操作保护记录暂时无法安全保存，已停止发送新请求，请检查本机状态文件。";
        const acceptance = ["accepted", "unknown"].includes(error.requestAccepted) ? error.requestAccepted : "not_sent";
        recoveryState({ phase: "failed", reason: error.code, acceptance, category: "local_state",
          willRetry: false, canContinueHttp: false });
        finishTerminalFailure(notice, "operation_state_terminal_failure", { code: error.code,
          category: "local_state", acceptance });
        return;
      }
      if (error instanceof RequestInspectionError || error.localRequestFailure) {
        emit({ type: "request_body_rejected", code: error.code, stage: error.stage ?? "inspect",
          encodedBytes: error.encodedBytes ?? null, decodedBytes: error.decodedBytes ?? null,
          limit: error.limit ?? null, upstreamRequestStarted: false, retryable: error.statusCode === 503 });
        if (error.statusCode === 413 && identity.requestKind === "turn"
          && !/\/responses\/compact\/?$/u.test(targetUrl.pathname)) {
          if (!response.destroyed && !response.headersSent) {
            ensureSseHead(response);
            response.end(requestState.recovery.fail("request_too_large", LOCAL_REQUEST_TOO_LARGE_NOTICE));
          }
          return;
        }
        if (!response.destroyed && !response.headersSent) {
          const headers = { "content-type": "application/json; charset=utf-8", "connection": "close" };
          if (error.statusCode === 503) headers["retry-after"] = "1";
          response.writeHead(error.statusCode, headers);
          response.end(JSON.stringify({ error: { type: error.errorType, code: error.code, message: error.message } }));
        }
        return;
      }
      emit({ type: "guarded_request_error", code: error.code ?? "UNEXPECTED_ERROR", message: error.message });
      if (error.code === "BODY_LIMIT_EXCEEDED") {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8", "connection": "close" });
        response.end(JSON.stringify({ error: { type: "request_too_large", message: "Model request exceeded proxy buffer limit." } }));
        return;
      }
      if (!response.destroyed) {
        const prior = key ? attempts.get(key) : null;
        const nextFailure = key ? (prior?.failures ?? 0) + 1 : null;
        const chainStartedAt = prior?.startedAt ?? Date.now();
        if (identity.requestKind === "compaction") {
          const terminalCompactionFailure = !key || nextFailure >= maxConsecutiveAttempts;
          ensureSseHead(response);
          if (terminalCompactionFailure) {
            response.end(requestState.recovery.fail("proxy_compaction_failed", "The compaction request could not be forwarded."));
            if (key) attempts.delete(key);
            counters.failed += 1;
          } else {
            rememberAttemptFailure(nextFailure, chainStartedAt);
            response.end();
            counters.retrySignals += 1;
          }
          return;
        }
        if (!key) {
          finishTerminalFailure(PERMANENT_FAILURE_NOTICE, "untracked_identity_terminal_failure", {
            reason: error.code ?? "UNEXPECTED_ERROR",
          });
          return;
        }
        if (nextFailure >= maxConsecutiveAttempts) {
          attempts.delete(key);
          finishTerminalFailure(PERMANENT_FAILURE_NOTICE, "guarded_error_terminal_failure", {
            attemptNumber: nextFailure,
            reason: error.code ?? "UNEXPECTED_ERROR",
          });
        } else {
          rememberAttemptFailure(nextFailure, chainStartedAt);
          ensureSseHead(response);
          response.end();
          counters.retrySignals += 1;
          emit({ type: "guarded_error_retry_signal", attemptNumber: nextFailure });
        }
      }
    } finally {
      finish();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return {
    continueWithHttp({ threadId, turnId, requestId }) {
      const state = [...active.values()].find(item => item.threadId === threadId && item.turnId === turnId
        && (!requestId || item.requestId === requestId));
      return { accepted: state?.recoveryControl?.continueHttp() === true };
    },
    recoveryStates() {
      return [...active.values()].filter(state => state.recoveryWait).map(state => ({
        requestId: state.requestId, threadId: state.threadId, turnId: state.turnId,
        requestKind: state.requestKind, ...state.recoveryWait,
      }));
    },
    prepareThreadHandoff(threadId) { return recoveryHandoff.prepare(threadId); },
    cancelThreadHandoff(threadId, token) { return recoveryHandoff.cancel(threadId, token); },
    acceptThreadHandoff(snapshot) { return recoveryHandoff.accept(snapshot); },
    async start() {
      if (server.listening) return this.status();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      return this.status();
    },
    async stop() {
      draining = true;
      for (const state of active.values()) {
        state.cancelled = true;
        state.inspectionAbort.abort();
        state.currentAbort?.();
      }
      await requestInspector.close();
      await incrementalTransport?.close?.();
      if (!server.listening) return;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await closed;
    },
    beginDrain() {
      draining = true;
      return this.status();
    },
    status() {
      const address = server.address();
      return {
        running: server.listening,
        pid: process.pid,
        instanceToken,
        implementationVersion: IMPLEMENTATION_VERSION,
        draining,
        contextControlFunctions: [...CONTEXT_CONTROL_FUNCTION_NAMES],
        host,
        port: typeof address === "object" && address ? address.port : port,
        upstreamOrigin: upstreamOrigin.origin,
        activeRequests: active.size,
        operationLedger: operationLedger?.status() ?? null,
        managedRecovery,
        recoveryWaitingRequests: [...active.values()].filter(state => state.recoveryWait?.phase === "waiting").length,
        unresolvedOperations: [...waitTerminals.values()].filter(state => ["unknown", "accepted"].includes(state.acceptance)).length,
        incrementalTransport: incrementalTransport?.status?.() ?? null,
        attemptChains: attempts.size,
        firstProgressTimeoutMs,
        firstLastProgressTimeoutMs,
        rapidRetryMinimumMs,
        fastRetryThresholdMs,
        fastRetryDelayMs,
        retryFirstProgressTimeoutMs,
        uploadAllowanceMsPerMiB,
        maxUploadAllowanceMs,
        progressIdleTimeoutMs,
        reasoningProgressIdleTimeoutMs,
        compactionAttemptTimeoutMs,
        adaptiveWaitLimitMs,
        consecutiveWaitLimitMs,
        upstreamIdleTimeoutMs,
        adaptiveDelivery: adaptiveRegistry.summary(),
        maxConsecutiveAttempts,
        maxLocalToolAttempts: Math.min(MAX_LOCAL_TOOL_ATTEMPTS, maxConsecutiveAttempts),
        retryDelaysMs: [...retryDelaysMs],
        maxBufferedRequestBytes,
        maxDecodedRequestBytes,
        requestBuffer: requestBufferBudget.status(),
        requestInspection: requestInspector.status(),
        maxBufferedResponseBytes,
        counters: { ...counters },
        toolPreparationGraceMs,
        bufferedToolPreparationGraceMs,
        bufferedToolProfileCount: bufferedToolIdentityHashes.length,
      };
    },
    server,
  };
}
