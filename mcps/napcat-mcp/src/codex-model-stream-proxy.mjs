import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { createRequestInspector, RequestInspectionError } from "./request-body-inspector.mjs";
import { collectRequestBody, createRequestBufferBudget } from "./request-body-buffer.mjs";
import { createRequestObservation } from "./model-observation-hooks.mjs";
import { correlationQuality, hashIdentity } from "./observability-utils.mjs";
import { createStreamRecovery, waitForRetry } from "./codex-stream-recovery.mjs";
import { createToolPreparationDeadline } from "./tool-preparation-deadline.mjs";
import { createReasoningProgressTracker } from "./reasoning-progress.mjs";
import { partialResponsesSseProgress } from "./partial-response-progress.mjs";
import { parseToolDeliveryProfile, toolIdentityHash } from "./tool-delivery-profile.mjs";
import { createAdaptiveDeliveryRegistry, deliveryProfileKey } from "./adaptive-delivery.mjs";

const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 40_000;
const DEFAULT_PROGRESS_IDLE_TIMEOUT_MS = 40_000;
const DEFAULT_COMPACTION_ATTEMPT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DECODED_REQUEST_BYTES = 96 * 1024 * 1024;
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
const IMPLEMENTATION_VERSION = "2026-09-26.1";
const SAFETY_POLICY_NOTICE = "触发栅栏检查，可能是误报，请避免类似内容";
const SAFETY_POLICY_CODES = new Set(["bio_policy", "content_filter", "content_policy_violation"]);
const NETWORK_EXHAUSTED_NOTICE = "\n\n本次模型响应未完成，已有信息已保留，请继续。";
const CAPACITY_EXHAUSTED_NOTICE = "\n\n当前模型暂时满载，已自动尝试六次仍未恢复，请稍后重试或切换模型。";
const USAGE_LIMIT_NOTICE = "\n\n当前账号额度已耗尽，请等待额度恢复、购买额外额度或切换账号。";
const PERMANENT_FAILURE_NOTICE = "\n\n本次模型响应因不可重试错误未完成，已有信息已保留，请继续。";
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
  const usageLimit = USAGE_LIMIT_CODES.has(code)
    || /you(?:'|’)ve hit your usage limit|codex\/settings\/usage|purchase more credits|quota exceeded/iu.test(message);
  const capacity = CAPACITY_CODES.has(code) || /selected model is at capacity|server overloaded/iu.test(message);
  const permanent = !usageLimit && !capacity
    && (safetyPolicy || EXPLICIT_PERMANENT_CODE.test(code) || EXPLICIT_PERMANENT_MESSAGE.test(message));
  const transient = !usageLimit && !capacity && !permanent;
  return {
    code: code || null,
    message: message.slice(0, 512) || null,
    safetyPolicy,
    category: usageLimit ? "usage_limit" : capacity ? "capacity" : permanent ? "permanent" : "transient",
  };
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
  let pending = "";
  let pendingPartialProgress = null;
  let failed = false;
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
      const match = /\r?\n\r?\n/u.exec(pending);
      if (!match) break;
      const frame = pending.slice(0, match.index);
      const wire = `${frame}${match[0]}`;
      pending = pending.slice(match.index + match[0].length);
      pendingPartialProgress = null;
      deliver(wire, frame);
      if (failed) return;
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
      if (Buffer.byteLength(pending, "utf8") > maximumPendingBytes) {
        fail(Object.assign(new Error("SSE frame exceeded proxy buffer limit"), { code: "SSE_FRAME_LIMIT" }));
        return;
      }
      observePartialProgress();
    },
    end() {
      if (failed) return;
      pending += decoder.end();
      drain(true);
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

function syntheticCompletion(requestId, notice) {
  const compactId = requestId.replaceAll("-", "");
  const responseId = `resp_proxy_${compactId}`;
  const messageId = `msg_proxy_${compactId}`;
  const message = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: notice }],
    phase: "final_answer",
  };
  return [
    { type: "response.created", sequence_number: 0, response: { id: responseId, status: "in_progress" } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", sequence_number: 2, output_index: 0, item_id: messageId, content_index: 0, delta: notice },
    { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: message },
    { type: "response.completed", sequence_number: 4, response: { id: responseId, status: "completed", output: [message] } },
  ].map(sseFrame).join("");
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

function sendSyntheticCompletion(response, requestId, notice, headers = {}) {
  ensureSseHead(response, headers);
  response.end(syntheticCompletion(requestId, notice));
}

function executeTurnAttempt(options) {
  const {
    body,
    downstream,
    headers,
    method,
    targetUrl,
    firstProgressTimeoutMs,
    progressIdleTimeoutMs,
    compactionAttemptTimeoutMs,
    toolPreparationGraceMs,
    bufferedToolIdentityHashes,
    bufferedToolPreparationGraceMs,
    contextHint,
    adaptiveRegistry,
    adaptiveKey,
    adaptiveWaitLimitMs,
    adaptiveWaitDeadlineAt,
    retryDeadlineAt,
    upstreamIdleTimeoutMs,
    adaptiveStreamMinSpanMs,
    maxBufferedResponseBytes,
    onEvent,
    requestState,
    observation,
    nativeAttempt,
  } = options;
  return new Promise((resolve) => {
    const client = requestClient(targetUrl);
    const startedAt = Date.now();
    const adaptive = adaptiveRegistry?.begin({ key: adaptiveKey, startedAt, firstProgressTimeoutMs,
      waitLimitMs: adaptiveWaitLimitMs, waitDeadlineAt: adaptiveWaitDeadlineAt, upstreamIdleTimeoutMs, streamMinSpanMs: adaptiveStreamMinSpanMs, onEvent });
    let upstreamResponse = null;
    let settled = false;
    let timer = null;
    let sawCompleted = false;
    let sawContent = false;
    let sawReplayUnsafeContent = false;
    let sawTool = false;
    let sawLocalTool = false;
    let sawSubstantiveWork = false;
    let sawExecutableToolDone = false;
    let sawCompaction = false;
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
    let normalDeadline = startedAt + firstProgressTimeoutMs;
    let normalReason = "FIRST_PROGRESS_TIMEOUT";

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      observation?.ended(outcome.kind);
      clearTimeout(timer);
      if (outcome.kind === "completed") adaptive?.complete(Date.now(), !sawCompaction);
      requestState.currentAbort = null;
      const phase = holdingToolDone ? "tool_completion_barrier" : sawLocalTool ? "tool_parameters"
        : contextHint?.contextPreparationHint === true ? "context_preparation_hint" : sawSubstantiveWork ? "ordinary_generation" : "unknown";
      const endCause = outcome.origin ?? (outcome.reason === "DOWNSTREAM_CANCELLED" ? "downstream_cancel_user_origin_unknown"
        : /^HTTP_/u.test(outcome.reason ?? "") ? "upstream_http"
        : terminalFailure ? "upstream_error" : outcome.kind === "completed" ? "upstream_completed" : "unknown");
      resolve({ ...outcome, phase, endCause, contextPreparationHint: contextHint?.contextPreparationHint ?? null, elapsedMs: Date.now() - startedAt, frames, sawContent, sawReplayUnsafeContent, sawSubstantiveWork, sawExecutableToolDone, deliveredExecutableToolDone, holdingToolDone, preparationPending: preparation.active(), sawTool, sawCompaction, sawHostedTool, toolItemTypes: [...toolItemTypes], toolNames: [...toolNames] });
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
      if (sawCompaction) return false;
      let deadline = adaptive?.active() ? adaptive.deadline(normalDeadline, normalReason) : null;
      if (retryDeadlineAt && (!deadline || retryDeadlineAt < deadline.at)) {
        deadline = { at: retryDeadlineAt, reason: "ADAPTIVE_WAIT_LIMIT" };
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
        if (retryDeadlineAt && retryDeadlineAt <= Date.now() + timeoutMs) {
          timeoutMs = Math.max(0, retryDeadlineAt - Date.now());
          reason = "ADAPTIVE_WAIT_LIMIT";
        }
      }
      timer = setTimeout(() => {
        if (settled || requestState.cancelled) return;
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
      ensureSseHead(downstream, upstreamHeaders);
      downstream.write(wire);
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
      for (const wire of heldAfterTool) if (!writeWire(wire)) return false;
      heldAfterTool = [];
      heldBytes = 0;
      holdingToolDone = false;
      return true;
    };
    const completeFromUpstream = (wire) => {
      if (adaptiveDeadlineExpired()) return;
      if (holdingToolDone) {
        if (!holdToolWire(wire)) return;
        if (!flushHeldAfterTool()) return;
      } else {
        if (!writeWire(wire)) return;
      }
      if (!downstream.destroyed && !downstream.writableEnded) downstream.end();
      finish({ kind: "completed", reason: "RESPONSE_COMPLETED" });
      upstreamResponse?.destroy();
      upstream.destroy();
    };

    const upstream = client.request(targetUrl, {
      method,
      headers: { ...sanitizeForwardHeaders(headers, targetUrl.host, body.length), "accept-encoding": "identity" },
    });
    requestState.currentAbort = () => {
      upstreamResponse?.destroy();
      upstream.destroy();
      finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
    };
    armTimer(firstProgressTimeoutMs, "FIRST_PROGRESS_TIMEOUT");

    upstream.once("response", async (response) => {
      upstreamResponse = response;
      upstreamHeaders = response.headers;
      const statusCode = response.statusCode ?? 502;
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
          if (failure.safetyPolicy) return finish({ kind: "permanent_failure", reason: failure.code, failure, upstreamHeaders });
          if (failure.category === "usage_limit") return finish({ kind: "usage_limit", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
          if (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient") {
            return finish({ kind: "retryable_failure", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
          }
          return finish({ kind: "permanent_failure", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
        } catch (error) {
          if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
          onEvent({ type: "upstream_error_body_unavailable", statusCode, reason: error.code ?? "HTTP_BODY_ERROR" });
          return finish({ kind: retryableStatus(statusCode) ? "retryable_failure" : "permanent_failure", reason: `HTTP_${statusCode}`, upstreamHeaders });
        }
      }

      ensureSseHead(downstream, upstreamHeaders);
      const parser = createSseFrameParser((wire, frame) => {
        if (adaptiveDeadlineExpired()) return;
        frames += 1;
        const parsed = parseSseFrame(frame);
        const event = parsed.event;
        const type = parsed.type;
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
          armTimer(compactionAttemptTimeoutMs, "COMPACTION_CONTROL_TIMEOUT");
        }
        const finalizedFunctionArguments = type === "response.function_call_arguments.done"
          && typeof event.arguments === "string" && event.arguments.length > 0;
        const completedReasoningProgress = observeReasoningProgress(event);
        if (completedReasoningProgress) completedReasoningIds.add(event.item.id);
        if (!sawCompaction && (eventPayloadHasContent(event) || finalizedFunctionArguments || completedReasoningProgress)) {
          sawContent = true;
          if (!isRetrySafeReasoningProgress(event, completedReasoningProgress)) sawReplayUnsafeContent = true;
          lastProgressAt = now;
          lastProgressType = type ?? null;
          armTimer(progressIdleTimeoutMs, "PROGRESS_IDLE_TIMEOUT");
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
            armTimer(progressIdleTimeoutMs, "PROGRESS_IDLE_TIMEOUT");
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
      response.once("end", () => {
        parser.end();
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
      });
      response.once("error", (error) => {
        if (settled || requestState.cancelled) return;
        finish({ kind: "retryable_failure", reason: error.code ?? "STREAM_ERROR", origin: "upstream_transport", upstreamHeaders });
      });
    });
    upstream.once("error", (error) => {
      if (settled || requestState.cancelled) return;
      finish({ kind: "retryable_failure", reason: error.code ?? "UPSTREAM_ERROR", origin: "upstream_transport", upstreamHeaders });
    });
    upstream.end(body);
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
    if (parsed.type === "response.failed" || parsed.type === "response.incomplete" || parsed.type === "error") failure = responseFailureDetails(parsed.event);
  });
  parser.push(body);
  parser.end();
  return { sawCompleted, sawResponsesProtocol, compactionItems, failure };
}

function executeBufferedCompactionAttempt(options) {
  const { body, headers, method, targetUrl, timeoutMs, maxBufferedResponseBytes, requestState, observation } = options;
  return new Promise((resolve) => {
    const client = requestClient(targetUrl);
    let settled = false;
    let upstreamResponse = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      observation?.ended(outcome.kind);
      clearTimeout(timer);
      requestState.currentAbort = null;
      resolve(outcome);
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
      headers: { ...sanitizeForwardHeaders(headers, targetUrl.host, body.length), "accept-encoding": "identity" },
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
          const retryable = !failure.safetyPolicy && (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient");
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
          const retryable = !failure.safetyPolicy && (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient");
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
        if (analysis.sawCompleted && analysis.compactionItems === 1) {
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
    upstream.end(body);
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
  const progressIdleTimeoutMs = integerOption(options.progressIdleTimeoutMs, DEFAULT_PROGRESS_IDLE_TIMEOUT_MS, 10, 300_000, "progressIdleTimeoutMs");
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
  const maxBufferedResponseBytes = integerOption(options.maxBufferedResponseBytes, DEFAULT_MAX_BUFFERED_RESPONSE_BYTES, 1_024, 256 * 1024 * 1024, "maxBufferedResponseBytes");
  const maxConsecutiveAttempts = integerOption(options.maxConsecutiveAttempts, DEFAULT_MAX_CONSECUTIVE_ATTEMPTS, 1, 20, "maxConsecutiveAttempts");
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
  const attempts = new Map();
  const emptyIdleTurns = new Map();
  const businessProgress = new Map();
  const waitTerminals = new Map();
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
    for (const [key, state] of waitTerminals) if (state.updatedAt < cutoff) waitTerminals.delete(key);
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
    emptyIdleTurns.set(identity.threadId, {
      count,
      turnId: identity.turnId,
      terminalTurnId: count >= 3 ? identity.turnId : previous?.terminalTurnId ?? null,
      updatedAt: Date.now(),
    });
    return count;
  };
  const isTerminalEmptyTurn = (identity) => {
    return Boolean(identity.threadId && identity.turnId
      && emptyIdleTurns.get(identity.threadId)?.terminalTurnId === identity.turnId);
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
        progressIdleTimeoutMs,
        adaptiveWaitLimitMs,
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
    const requestId = crypto.randomUUID();
    const pathname = String(request.url ?? "").split("?")[0].replace(/\/+$/u, "");
    const endpoint = request.method === "POST" && identity.guarded
      ? /\/responses\/compact$/u.test(pathname) ? "compact" : /\/responses$/u.test(pathname) ? "responses" : "unsupported"
      : "unsupported";
    const observation = createRequestObservation({ emit: options.onModelObservation,
      producerInstance: observationInstance, requestId, endpoint });
    const requestState = { cancelled: false, currentAbort: null, downstreamFrames: 0, inspectionAbort: new AbortController() };
    const bodyLease = requestBufferBudget.lease();
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
    const key = attemptKey(identity);
    const rememberAttemptFailure = (failures, startedAt, details = {}) => {
      if (!key) return;
      const previous = attempts.get(key);
      attempts.set(key, {
        failures: Math.max(previous?.failures ?? 0, failures),
        startedAt: previous?.startedAt ?? startedAt,
        updatedAt: Date.now(),
        replayUnsafe: Boolean(previous?.replayUnsafe || details.replayUnsafe),
        adaptiveWaitDeadlineAt: previous?.adaptiveWaitDeadlineAt ?? details.adaptiveWaitDeadlineAt ?? null,
      });
    };
    const finishSoftTerminal = (notice, eventType, details = {}, headers = {}) => {
      observation?.synthetic();
      const canCountEmptyIdle = identity.requestKind === "turn" && Boolean(key) && details.category !== "safety_policy";
      const emptyIdleCount = canCountEmptyIdle && !hasBusinessProgress(identity)
        ? recordEmptyIdleTurn(identity)
        : 0;
      ensureSseHead(response, headers);
      if (canCountEmptyIdle && emptyIdleCount >= 3) {
        response.end(requestState.recovery.fail(
          "proxy_repeated_empty_idle",
          "Three distinct turns ended without model text or completed tool work. The proxy stopped native retry for this turn.",
        ));
        counters.failed += 1;
        emit({ type: "empty_idle_terminal_failure", emptyIdleCount, ...details });
        return { hardFailure: true, emptyIdleCount };
      }
      response.end(requestState.recovery.finish(notice));
      counters.syntheticCompletions += 1;
      counters.softCompletions += 1;
      emit({ type: eventType, emptyIdleCount, ...details });
      if (!key) emit({ type: "untracked_identity_soft_terminal", reason: details.reason ?? null });
      return { hardFailure: false, emptyIdleCount };
    };
    const finishAdaptiveWait = (reason, headers = {}) => {
      if (key) attempts.delete(key);
      const notice = reason === "ADAPTIVE_WAIT_LIMIT"
        ? `\n\n本次模型请求已达到${Math.ceil(adaptiveWaitLimitMs / 1000)}秒等待上限，已停止自动重试。`
        : "\n\n上游连接长时间未发送任何有效事件，本轮无法安全自动重试，已停止，请核对已有输出后继续。";
      if (key) waitTerminals.set(key, { notice, reason, updatedAt: Date.now() });
      finishSoftTerminal(notice, "adaptive_wait_stopped", { reason, category: "wait_budget" }, headers);
    };
    const finish = () => {
      observation?.ended(requestState.cancelled ? "cancelled" : "ended_unknown");
      bodyLease.release();
      active.delete(requestId);
    };
    response.once("close", () => {
      if (response.writableEnded) return;
      requestState.cancelled = true;
      requestState.inspectionAbort.abort();
      requestState.currentAbort?.();
      counters.cancelled += 1;
      emit({ type: "downstream_cancelled" });
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
      const body = await collectRequestBody(request, maxBufferedRequestBytes, bodyLease, requestState.inspectionAbort.signal);
      const inspected = await requestInspector.inspect(body, request.headers["content-encoding"], { signal: requestState.inspectionAbort.signal });
      if (requestState.cancelled) return;
      observation?.parsed(inspected.modelInvalid ? { invalid: true } : inspected.model);
      emit({ type: "request_body_inspected", encodedBytes: body.length, decodedBytes: inspected.decodedBytes,
        contentEncoding: inspected.contentEncoding, decodedLimit: maxDecodedRequestBytes });
      counters.guarded += 1;
      const contextHint = inspected.contextHint;
      if (key && waitTerminals.has(key)) {
        finishSoftTerminal(waitTerminals.get(key).notice, "adaptive_wait_terminal_replayed", { reason: waitTerminals.get(key).reason });
        return;
      }
      emit({ type: "request_phase_observed", ...contextHint });
      const transport = identity.requestKind === "compaction"
        ? compactionTransport(targetUrl, inspected, request.headers)
        : "sampling_sse";
      if (identity.requestKind === "turn" && isTerminalEmptyTurn(identity)) {
        observation?.synthetic();
        observation?.ended("failed");
        ensureSseHead(response);
        response.end(requestState.recovery.fail(
          "proxy_repeated_empty_idle",
          "Three distinct turns ended without model text or completed tool work. The proxy stopped native retry for this turn.",
        ));
        counters.failed += 1;
        emit({ type: "empty_idle_terminal_replayed" });
        return;
      }

      if (identity.requestKind === "compaction" && transport === "remote_unary") {
        emit({ type: "compaction_attempt_started", internalAttempt: 1, timeoutMs: compactionAttemptTimeoutMs });
        const outcome = await executeBufferedCompactionAttempt({
          body,
          headers: request.headers,
          method: request.method,
          targetUrl,
          timeoutMs: compactionAttemptTimeoutMs,
          maxBufferedResponseBytes,
          requestState,
          observation,
        });
        emit({ type: "compaction_attempt_finished", internalAttempt: 1, kind: outcome.kind, reason: outcome.reason ?? null });
        if (requestState.cancelled || outcome?.kind === "cancelled") return;
        if (outcome.failure?.safetyPolicy) {
          if (key) attempts.delete(key);
          response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: { type: "safety_policy", code: outcome.failure.code, message: SAFETY_POLICY_NOTICE } }));
          counters.failed += 1;
          emit({ type: "safety_policy_terminal_failure", category: "safety_policy", code: outcome.failure.code });
          return;
        }
        const preserveUpstreamError = outcome?.kind === "permanent_failure"
          || outcome?.failure?.category === "usage_limit";
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
      const chainStartedAt = prior?.startedAt ?? Date.now();
      const attemptNumber = key ? (prior?.failures ?? 0) + 1 : null;
      const finalAttempt = Boolean(key && attemptNumber >= maxConsecutiveAttempts);
      const adaptiveWaitDeadlineAt = prior?.adaptiveWaitDeadlineAt ?? chainStartedAt + adaptiveWaitLimitMs;
      if (prior?.adaptiveWaitDeadlineAt && Date.now() >= adaptiveWaitDeadlineAt) {
        finishAdaptiveWait("ADAPTIVE_WAIT_LIMIT");
        return;
      }
      emit({ type: "turn_attempt_started", attemptNumber, maxConsecutiveAttempts, finalAttempt, untrackedIdentity: !key, firstProgressTimeoutMs, progressIdleTimeoutMs });
      const outcome = await executeTurnAttempt({
        body,
        downstream: response,
        headers: request.headers,
        method: request.method,
        targetUrl,
        firstProgressTimeoutMs,
        progressIdleTimeoutMs,
        compactionAttemptTimeoutMs,
        toolPreparationGraceMs,
        bufferedToolIdentityHashes,
        bufferedToolPreparationGraceMs,
        contextHint,
        adaptiveRegistry,
        adaptiveKey: identity.requestKind === "turn" ? deliveryProfileKey(request.headers, inspected, upstreamOrigin.origin) : null,
        adaptiveWaitLimitMs,
        adaptiveWaitDeadlineAt,
        retryDeadlineAt: prior?.adaptiveWaitDeadlineAt ?? null,
        upstreamIdleTimeoutMs,
        adaptiveStreamMinSpanMs,
        finalAttempt,
        maxBufferedResponseBytes,
        onEvent: emit,
        requestState,
        observation,
        nativeAttempt: attemptNumber,
      });
      emit({
        type: "turn_attempt_finished",
        attemptNumber,
        kind: outcome.kind,
        phase: outcome.phase,
        endCause: outcome.endCause,
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
        rememberAttemptFailure(attemptNumber, chainStartedAt, { replayUnsafe, adaptiveWaitDeadlineAt });
        return;
      }
      if (outcome.kind === "completed") {
        if (key) attempts.delete(key);
        if (outcome.sawSubstantiveWork || outcome.sawExecutableToolDone) recordBusinessProgress(identity);
        counters.completed += 1;
        counters.actualCompletions += 1;
        return;
      }
      if (outcome.sawSubstantiveWork) recordBusinessProgress(identity);
      const retryableAdaptiveIdle = outcome.kind === "adaptive_wait_timeout"
        && outcome.reason === "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT"
        && Boolean(key) && !replayUnsafe && Date.now() < adaptiveWaitDeadlineAt;
      const retryState = { replayUnsafe,
        adaptiveWaitDeadlineAt: retryableAdaptiveIdle || prior?.adaptiveWaitDeadlineAt ? adaptiveWaitDeadlineAt : null };
      if (outcome.kind === "adaptive_wait_timeout") {
        if (!retryableAdaptiveIdle) {
          finishAdaptiveWait(Date.now() >= adaptiveWaitDeadlineAt ? "ADAPTIVE_WAIT_LIMIT" : outcome.reason, outcome.upstreamHeaders);
          return;
        }
        emit({ type: "adaptive_idle_retry_eligible", attemptNumber, finalAttempt, deadlineAt: adaptiveWaitDeadlineAt });
      }
      if (outcome.failure?.safetyPolicy) {
        if (key) attempts.delete(key);
        const details = { category: "safety_policy", code: outcome.failure.code, reason: outcome.reason };
        if (identity.requestKind === "compaction" || outcome.sawCompaction) {
          ensureSseHead(response, outcome.upstreamHeaders ?? {});
          response.end(requestState.recovery.fail(outcome.failure.code, SAFETY_POLICY_NOTICE));
          counters.failed += 1;
          emit({ type: "safety_policy_terminal_failure", ...details });
        } else {
          finishSoftTerminal(`\n\n${SAFETY_POLICY_NOTICE}`, "safety_policy_completed_idle", details, outcome.upstreamHeaders);
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
        if (key && retryState.adaptiveWaitDeadlineAt) {
          waitTerminals.set(key, { notice, reason: outcome.reason, updatedAt: Date.now() });
        }
        finishSoftTerminal(notice, "local_tool_phase_timeout", {
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
            ? PERMANENT_FAILURE_NOTICE
            : NETWORK_EXHAUSTED_NOTICE;
        finishSoftTerminal(notice, "untracked_identity_soft_terminal", {
          reason: outcome.reason,
          category: outcome.failure?.category ?? "network",
        }, outcome.upstreamHeaders);
        return;
      }
      if (outcome.kind === "permanent_failure") {
        attempts.delete(key);
        finishSoftTerminal(PERMANENT_FAILURE_NOTICE, "permanent_failure_completed_idle", {
          code: outcome.failure?.code ?? null,
          reason: outcome.reason,
        }, outcome.upstreamHeaders);
        return;
      }
      if (outcome.kind === "usage_limit") {
        attempts.delete(key);
        finishSoftTerminal(USAGE_LIMIT_NOTICE, "usage_limit_completed_idle", {
          reason: outcome.reason,
        }, outcome.upstreamHeaders);
        return;
      }
      rememberAttemptFailure(attemptNumber, chainStartedAt, retryState);
      if (finalAttempt) {
        const notice = outcome.failure?.category === "capacity" ? CAPACITY_EXHAUSTED_NOTICE : NETWORK_EXHAUSTED_NOTICE;
        attempts.delete(key);
        if (retryableAdaptiveIdle || prior?.adaptiveWaitDeadlineAt) {
          waitTerminals.set(key, { notice, reason: "RETRY_EXHAUSTED", updatedAt: Date.now() });
        }
        finishSoftTerminal(notice, "retry_exhausted_completed_idle", {
          attemptNumber,
          category: outcome.failure?.category ?? "network",
          reason: outcome.reason,
        }, outcome.upstreamHeaders);
        return;
      }
      const rapidDelayMs = attemptNumber === 5 && maxConsecutiveAttempts >= 6
        ? Math.max(0, firstProgressTimeoutMs - (Date.now() - chainStartedAt))
        : 0;
      if (rapidDelayMs > 0) {
        emit({ type: "rapid_retry_wait_started", attemptNumber, delayMs: rapidDelayMs, reason: outcome.reason });
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
      emit({ type: "native_retry_signal", attemptNumber, reason: outcome.reason, category: outcome.failure?.category ?? "network" });
    } catch (error) {
      if (requestState.cancelled || error.code === "REQUEST_ABORTED") return;
      counters.failed += 1;
      observation?.ended("failed");
      if (error instanceof RequestInspectionError || error.localRequestFailure) {
        emit({ type: "request_body_rejected", code: error.code, stage: error.stage ?? "inspect",
          encodedBytes: error.encodedBytes ?? null, decodedBytes: error.decodedBytes ?? null,
          limit: error.limit ?? null, upstreamRequestStarted: false });
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
          finishSoftTerminal(PERMANENT_FAILURE_NOTICE, "untracked_identity_soft_terminal", {
            reason: error.code ?? "UNEXPECTED_ERROR",
          });
          return;
        }
        if (nextFailure >= maxConsecutiveAttempts) {
          attempts.delete(key);
          finishSoftTerminal(PERMANENT_FAILURE_NOTICE, "guarded_error_completed_idle", {
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
        attemptChains: attempts.size,
        firstProgressTimeoutMs,
        progressIdleTimeoutMs,
        compactionAttemptTimeoutMs,
        adaptiveWaitLimitMs,
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
