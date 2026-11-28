import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { PassThrough, Readable } from "node:stream";
import { createNativeBodySourceWebSocketClass, NATIVE_WS_BODY_SOURCE, sendSource } from "./native-ws-body-source.mjs";
import { collectBodySource } from "./request-body-source.mjs";
import { jsonRequestChunks } from "./request-body-buffer.mjs";
import { inspectJsonBodySource } from "./source-json-inspection.mjs";
import { registerRootSourcePayload, rootSourcePayload, isRootInputProjection, retainRootInput, releaseRootInput,
  combineRootInputs, projectRootSourcePayload, composeRootSourceBody } from "./source-root-admission.mjs";
import { classifyModelFailure, isKnownIncompleteResponse, modelRecoveryAction } from "./model-failure-policy.mjs";
import { createStreamRecovery, waitForRecoveryAction } from "./codex-stream-recovery.mjs";
import { INTERNAL_MEMORY_CONNECTION_HEADER, takeInternalMemoryConnectionHeader } from "./internal-memory-request-authority.mjs";
import { nativeEventCommitsOutput } from "./incremental-responses-transport.mjs";
import { createNativeReasoningProgressForwarder, isNativeReasoningProgressEvent } from "./reasoning-progress.mjs";

const require = createRequire(import.meta.url);
const webSocketOpen = 1;
const nativeConnectionIds = new WeakMap();
const nativeConnectionCloseReasons = new WeakMap();
const responsePaths = new Set(["/v1/responses", "/backend-api/codex/responses"]);
const ignoredHeaders = new Set(["connection", "upgrade", "host", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]);
const noop = () => {};
const NativeBodyWebSocket = createNativeBodySourceWebSocketClass();
const sourcePathError = code => Object.assign(new Error(code), { code, localRequestFailure: true,
  requestAccepted: false, requestTransmissionState: "not_sent" });
async function disposeNativePrepared(prepared) {
  try { await prepared?.requestBody?.releaseUnused(); }
  finally {
    try { await prepared?.inspected?.sourceDocument?.release(); }
    finally { prepared?.lease?.release(); }
  }
}
async function sourceCompactionTrigger(document) {
  if (document.getNode(["compaction_trigger"])) return true;
  for await (const item of document.inputItems()) {
    if (item.type === "object" && document.smallField(item, "type") === "compaction_trigger") return true;
  }
  return false;
}
async function inspectNativeRelaySource(source, signal) {
  const inspected = await inspectJsonBodySource(source, "identity", { signal });
  try {
    const fields = ["type", "model", "generate", "stream", "previous_response_id", "store", "client_metadata", "compaction_trigger"];
    for (const name of fields) {
      const node = inspected.document.getNode([name]);
      if (node && node.end - node.start > 65536) throw sourcePathError("NATIVE_WS_SOURCE_CONTROL_TOO_LARGE");
    }
    const payload = await inspected.document.topLevelSmall({ fields });
    payload.input = Object.freeze({});
    await registerRootSourcePayload(payload, inspected.document);
    return { payload, document: inspected.document };
  } catch (error) { await inspected.document.release(); throw error; }
}
async function rewriteNativeRelaySource(document, originalPayload, replacement, signal) {
  const registered = rootSourcePayload(replacement);
  if (registered?.expanded) return composeRootSourceBody(replacement, { signal });
  if (registered) document = registered.document;
  if (Object.hasOwn(replacement, "input") && replacement.input !== originalPayload.input && !Array.isArray(replacement.input) && !registered?.input) {
    throw sourcePathError("NATIVE_WS_SOURCE_INPUT_REWRITE_UNSUPPORTED");
  }
  const changes = Object.entries(replacement).filter(([name, value]) => value !== undefined
    && (name !== "input" || Array.isArray(value) && value !== originalPayload.input));
  const omitPrevious = Object.hasOwn(originalPayload, "previous_response_id") && !Object.hasOwn(replacement, "previous_response_id")
    && Array.isArray(replacement.input) && replacement.input !== originalPayload.input;
  async function* chunks() {
    yield Buffer.from("{");
    let first = true;
    for (const [name, value] of changes) {
      if (!first) yield Buffer.from(","); first = false;
      yield Buffer.from(JSON.stringify(name) + ":");
      yield* jsonRequestChunks(value);
    }
    for await (const child of document.children(document.getNode())) {
      const key = document.node(child.key_id);
      if (changes.some(([name]) => document.isString(key, name))) continue;
      if (omitPrevious && document.isString(key, "previous_response_id")) continue;
      if (!first) yield Buffer.from(","); first = false;
      yield* document.openRange(key, { signal });
      yield Buffer.from(":");
      yield* document.openRange(child, { signal });
    }
    yield Buffer.from("}");
  }
  return collectBodySource(Readable.from(chunks()), { signal });
}
const terminalEvent = event => ["response.completed", "response.failed", "response.incomplete", "error"].includes(event?.type);
const capacityCodes = new Set(["server_is_overloaded", "server_overloaded", "model_at_capacity"]);
const capacityNotice = "当前模型暂时满载，已自动尝试六次仍未恢复，请稍后重试或切换模型。";

function createNativeClientKeepalive(peer, requestedIntervalMs) {
  const intervalMs = Number.isFinite(requestedIntervalMs) && requestedIntervalMs > 0 ? Math.min(30000, requestedIntervalMs) : 30000;
  let timer = null;
  let active = false;
  let lastClientEvent = performance.now();
  const stop = () => { active = false; clearTimeout(timer); timer = null; };
  const due = () => performance.now() - lastClientEvent >= intervalMs;
  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    if (!active || peer.readyState !== webSocketOpen) return;
    timer = setTimeout(() => {
      timer = null;
      if (!active || peer.readyState !== webSocketOpen) { stop(); return; }
      if (due()) {
        lastClientEvent = performance.now();
        try { peer.send(JSON.stringify({ type: "ping" }), error => { if (error) { stop(); peer.terminate(); } }); }
        catch { stop(); peer.terminate(); return; }
      }
      schedule();
    }, Math.max(1, Math.ceil(intervalMs - (performance.now() - lastClientEvent))));
    timer.unref?.();
  };
  peer.once("close", stop);
  return {
    start() { if (active) return; active = true; lastClientEvent = performance.now(); schedule(); },
    note() { lastClientEvent = performance.now(); schedule(); },
    due,
    stop,
  };
}

function nativeWsStatusFields(signal) {
  const fields = {};
  for (const field of ["httpStatus", "statusCode", "http_status", "status_code", "status"]) {
    const value = signal?.[field];
    const status = typeof value === "string" && /^\d{3}$/u.test(value) ? Number(value) : value;
    if (Number.isInteger(status) && status >= 100 && status <= 599) fields[field] = value;
  }
  return fields;
}

const nativeWsHttpStatuses = signal => Object.values(nativeWsStatusFields(signal)).map(Number);
const nativeWsHttpStatus = signal => nativeWsHttpStatuses(signal)[0];

function nativeWsCapacityFailure(error) {
  if (!error || typeof error !== "object") return false;
  const signals = [error, error.upstreamError, error.error, error.response?.error].filter(Boolean);
  const statuses = signals.flatMap(nativeWsHttpStatuses);
  if (statuses.some(value => [400, 401, 402, 403, 404, 413, 422, 451].includes(value))) return false;
  const diagnosis = classifyModelFailure({ source: "sse", code: error.code, message: error, progressObserved: false });
  return diagnosis.category === "temporary" && (capacityCodes.has(diagnosis.reasonCode.toLowerCase())
    || signals.some(value => typeof value.message === "string"
      && /^(?:selected model is at capacity\b|server overloaded\b)/iu.test(value.message.trim())));
}

function nativeFailureNotice(error) {
  const diagnosis = classifyModelFailure({ source: "sse", code: error?.code, message: error });
  if (diagnosis.category === "quota") return "当前账号额度已耗尽，请等待额度恢复、购买额外额度或切换账号。";
  if (diagnosis.category === "authentication") return "模型认证失败，请重新登录或刷新认证后继续。";
  if (diagnosis.category === "safety") return "上游安全策略拒绝了本次请求，本轮已停止自动重试，已有信息已保留。";
  if (diagnosis.reasonCode === "context_length_exceeded") return "本次请求超过上游上下文长度限制，已停止自动重试，请缩减或压缩上下文后再试。";
  if (nativeWsCapacityFailure(error)) return "当前模型暂时满载，本轮已保留已有信息，请稍后继续。";
  return "本次模型响应未完成，已有信息已保留，请继续。";
}

const unresolvedNativeNotice = "上游是否完成仍待核实，已保留已有信息和操作记录，未自动重发。";
const executableNativeTools = new Set(["function_call", "custom_tool_call"]);
const safeLocalBridgeItemTypes = new Set([
  "reasoning", "message", "function_call", "custom_tool_call",
  "compaction", "compaction_trigger", "context_compaction", "compaction_summary",
]);
const safeLocalBridgeResponseEvents = new Set([
  "response.created", "response.in_progress", "response.queued",
  "response.completed", "response.failed", "response.incomplete",
  "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done",
  "response.refusal.delta", "response.refusal.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
  "response.interrupt.accepted", "response.output_item.interrupted",
]);
function isNonLocalSideEffectEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (event.item && typeof event.item === "object" && !safeLocalBridgeItemTypes.has(event.item.type)) return true;
  if (typeof event.type === "string" && event.type.startsWith("response.") && !safeLocalBridgeResponseEvents.has(event.type) && !/(?:^|\.)(?:metadata|rate_limits?)$/u.test(event.type)) return true;
  if (Array.isArray(event.response?.output) && event.response.output.some(item => item && !safeLocalBridgeItemTypes.has(item.type))) return true;
  return false;
}
function safeForClientTextContinuation(job, operation) {
  return Boolean(job && operation?.recoveryReconciliationRequired !== true
    && !job.deliveredExecutableToolDone && !job.unrecordedExecutableTool
    && !job.pendingLocalToolItems?.size && (job.protocolProgress?.toolParameterBytes ?? 0) === 0
    && !job.sawNonLocalSideEffect && job.storeRequested !== true
    && job.protocolProgress?.deliveredText === true);
}
function safeForClientCancellation(job, operation) {
  return Boolean(job && operation?.recoveryReconciliationRequired !== true
    && !job.deliveredExecutableToolDone && !job.unrecordedExecutableTool
    && !job.sawNonLocalSideEffect && job.storeRequested !== true);
}

function recordedNativeToolFingerprint(item) {
  if (!executableNativeTools.has(item?.type) || typeof item.id !== "string" || !item.id
    || typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name
    || (item.status !== undefined && item.status !== "completed")) return null;
  const content = item.type === "function_call" ? item.arguments : item.input;
  if (typeof content !== "string") return null;
  return crypto.createHash("sha256").update(JSON.stringify([item.type, item.id, item.call_id, item.name, content])).digest("hex");
}

function confirmedNativeToolContinuation(job, event) {
  if (!event || job.nativeFailedTerminal !== event || !job.createdDelivered || job.httpFallback || job.interruptResponseId
    || !job.deliveredExecutableToolDone || job.unrecordedExecutableTool || job.pendingLocalToolItems.size
    || event.type !== "response.failed" || event.response?.status !== "failed" || !job.publicResponseId
    || event.response.id !== job.publicResponseId || !Array.isArray(event.response.output)) return false;
  const category = classifyModelFailure({ source: "sse", message: event }).category;
  if (!["quota", "temporary"].includes(category)) return false;
  const hasProof = item => {
    if (["message", "reasoning"].includes(item?.type)) return true;
    const fingerprint = recordedNativeToolFingerprint(item);
    return Boolean(fingerprint && job.recordedNativeTools.get(item.id) === fingerprint);
  };
  return job.recordedNativeTools.size > 0 && [...job.deliveredItems.values()].every(hasProof) && event.response.output.every(hasProof);
}

function nativePendingDisposition(operation, job = null, { cancelled = false } = {}) {
  if (operation?.requiresReconciliation !== true) return null;
  if (safeForClientTextContinuation(job, operation)) {
    return null;
  }
  if (cancelled && safeForClientCancellation(job, operation)) {
    return null;
  }
  const accepted = [true, "accepted"].includes(operation.acceptance);
  const canHaveSent = ["prewarm_sent", "generation_sent", "response_received", "started", "finished"].includes(operation.requestTransmissionState);
  if (!accepted && !(operation.acceptance === "unknown" && canHaveSent)) return null;
  return { requiresReconciliation: true, reconciliationAcceptance: accepted ? "accepted" : "unknown" };
}

const structureRejectionCodes = new Set([
  "invalid_request_error",
  "invalid_request",
  "invalid_argument",
  "unsupported_parameter",
  "unsupported_value",
  "previous_response_not_found",
]);
function isPermanentStructureRejection(diagnostics) {
  if (!diagnostics) return false;
  const reasonCode = String(diagnostics.failureReasonCode ?? "").toLowerCase();
  const rawCode = String(diagnostics.rawCode ?? "").toLowerCase();
  const rawUpstreamCode = String(diagnostics.rawUpstreamCode ?? "").toLowerCase();
  if (reasonCode === "context_length_exceeded" || rawUpstreamCode === "context_length_exceeded" || reasonCode === "websocket_connection_limit_reached" || rawUpstreamCode === "websocket_connection_limit_reached") return false;
  if (rawUpstreamCode === "previous_response_not_found" || reasonCode === "previous_response_not_found") return true;
  if (diagnostics.rawUpstreamParam === "previous_response_id"
    && (diagnostics.httpStatus === 400 || diagnostics.rawUpstreamType === "invalid_request_error")) return true;
  if (diagnostics.httpStatus === 400 || diagnostics.httpStatus === 422) return true;
  if ([1002, 1003, 1007, 1008].includes(diagnostics.closeCode)) return true;
  if (typeof diagnostics.rawWsErrorCode === "string" && /^WS_ERR_(?:INVALID_|UNEXPECTED_|EXPECTED_)/u.test(diagnostics.rawWsErrorCode)) return true;
  if (diagnostics.failureCategory !== "permanent") return false;
  return diagnostics.httpStatus === 400
    || diagnostics.httpStatus === 422
    || diagnostics.rawUpstreamType === "invalid_request_error"
    || diagnostics.rawUpstreamParam === "input"
    || diagnostics.rawUpstreamParam === "previous_response_id"
    || structureRejectionCodes.has(reasonCode)
    || structureRejectionCodes.has(rawCode)
    || structureRejectionCodes.has(rawUpstreamCode);
}

const temporaryNativeWsCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ERR_NETWORK", "ERR_SOCKET_CLOSED", "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_TLS_HANDSHAKE_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "WS_CONNECTION_ERROR", "WS_CONNECT_TIMEOUT", "WS_CONNECTION_CLOSED", "WS_SEND_ERROR", "WS_TERMINAL_TIMEOUT", "WS_PREWARM_TIMEOUT",
  "WEBSOCKET_CONNECTION_LIMIT_REACHED",
  "FIRST_PROGRESS_TIMEOUT", "PROGRESS_IDLE_TIMEOUT", "UPSTREAM_IDLE_TIMEOUT", "COORDINATOR_WORKER_UNAVAILABLE", "NATIVE_WS_WORKER_UNAVAILABLE"]);

function nativeWsFailureDiagnostics(job, error, operation) {
  const code = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(value) ? value : null;
  const message = value => {
    if (typeof value !== "string") return null;
    const text = value.slice(0, 8192)
      .replace(/\b(Bearer|Basic)[\s\u0000-\u001f]+[^\s,;}"']+/giu, "$1 [REDACTED]")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, "")
      .replace(/\\(["'])/gu, "$1")
      .replace(/\b((?:proxy[-_])?authorization|(?:set[-_])?cookie)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[\[{].*|[^,}\]]*)/giu, "$1=[REDACTED]")
      .replace(/\b([A-Za-z0-9_-]*(?:token|api[-_]?key|secret[-_]?access[-_]?key|secret|password|passwd|session[-_]?id))["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[\[{].*|[^\s,;&}\]"']+)/giu, "$1=[REDACTED]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;}"']+/giu, "$1 [REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2})\b/gu, "[REDACTED]")
      .replace(/\b(https?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@")
      .trim();
    return text.slice(0, 512) || null;
  };
  const param = value => typeof value === "string" && /^[A-Za-z_][\w.[\]-]{0,159}$/u.test(value)
    && message(value) === value ? value : null;
  const progress = job.protocolProgress ?? {};
  const envelope = error?.upstreamFailureSignals ?? error;
  const upstreamError = error?.upstreamError ?? envelope?.error ?? envelope?.response?.error;
  const failureSource = terminalEvent(envelope) ? "sse" : "transport";
  const statuses = [error, upstreamError, envelope, envelope?.response].flatMap(nativeWsHttpStatuses);
  const httpStatus = statuses.find(status => [401, 402, 403, 413, 451].includes(status)) ?? statuses[0];
  const acceptance = value => value === true ? "accepted" : value === false ? "rejected"
    : ["accepted", "rejected", "not_sent", "unknown"].includes(value) ? value : "unknown";
  const policy = classifyModelFailure({ source: failureSource, code: error?.code,
    statusCode: httpStatus, requestAccepted: error?.requestAccepted,
    requestTransmissionState: error?.requestTransmissionState, wsCloseCode: error?.closeCode,
    message: error?.upstreamFailureSignals ?? error?.upstreamError ?? error,
    progressObserved: job.progressObserved, toolDelivered: job.deliveredExecutableToolDone,
    cancelled: error?.cancelled });
  return { rawCode: code(error?.code), rawType: code(envelope?.type), rawTopLevelCode: code(envelope?.code),
    rawStatus: nativeWsHttpStatus(envelope) ?? null, rawResponseStatus: code(envelope?.response?.status),
    rawStatusFields: nativeWsStatusFields(envelope), rawUpstreamStatusFields: nativeWsStatusFields(upstreamError),
    rawUpstreamCode: code(upstreamError?.code), rawUpstreamType: code(upstreamError?.type),
    rawUpstreamParam: param(upstreamError?.param), rawUpstreamMessage: message(upstreamError?.message),
    rawUpstreamStatus: nativeWsHttpStatus(upstreamError) ?? null, httpStatus: httpStatus ?? null, failureSource,
    failureCategory: policy.category, failureReasonCode: code(policy.reasonCode),
    requestAccepted: acceptance(error?.requestAccepted), operationAcceptance: acceptance(operation?.acceptance
      ?? (!job.started && error?.requestTransmissionState === "not_sent" ? "not_sent" : undefined)),
    requestTransmissionState: code(error?.requestTransmissionState ?? operation?.requestTransmissionState),
    progressObserved: job.progressObserved === true, reasoningProgressObserved: job.reasoningProgressObserved === true,
    deliveredExecutableToolDone: job.deliveredExecutableToolDone === true,
    completedReasoningItems: progress.completedReasoningItems ?? 0,
    reasoningFrames: progress.reasoningFrames ?? 0, firstVisibleEventType: progress.firstVisibleEventType ?? null,
    partialToolItems: job.pendingLocalToolItems?.size ?? 0,
    toolParameterBytes: progress.toolParameterBytes ?? 0, deliveredText: progress.deliveredText === true,
    partialScenario: job.deliveredExecutableToolDone ? "completed_executable_tool"
      : job.pendingLocalToolItems?.size || progress.toolParameterBytes ? "partial_tool_arguments" : progress.deliveredText ? "delivered_text"
        : progress.completedReasoningItems ? "completed_reasoning" : progress.reasoningFrames ? "partial_reasoning"
          : job.progressObserved ? "other_protocol_progress" : "no_output",
    canRetry: typeof operation?.canRetry === "boolean" ? operation.canRetry : null,
    requiresReconciliation: typeof operation?.requiresReconciliation === "boolean" ? operation.requiresReconciliation : null,
    retryableWithoutDelivery: operation?.retryableWithoutDelivery === true,
    ...(operation?.nativePreviousResponseMismatch ? { nativePreviousResponseMismatch: { ...operation.nativePreviousResponseMismatch } } : {}),
    ...(error?.responseIdentityConflict ? { responseIdentityConflict: { ...error.responseIdentityConflict } } : {}),
    rawWsErrorCode: code(error?.wsErrorCode),
    closeCode: Number.isInteger(error?.closeCode) && error.closeCode >= 1000 && error.closeCode <= 4999 ? error.closeCode : null,
    direction: ["send", "receive", "connect", "unknown"].includes(error?.direction) ? error.direction
      : failureSource === "sse" ? "receive" : "unknown" };
}

function nativeWsTemporaryFailure(error) {
  if (!error || typeof error !== "object") return false;
  const signals = [error, error.upstreamError, error.error, error.response?.error, error.cause].filter(value => value && typeof value === "object");
  const codes = signals.flatMap(value => [value.code, value.type]).filter(value => typeof value === "string");
  const statuses = signals.flatMap(nativeWsHttpStatuses);
  const expiredConnection = codes.some(value => value.toLowerCase() === "websocket_connection_limit_reached");
  if (statuses.some(value => [400, 401, 402, 403, 404, 413, 422, 451].includes(value)
    && !(value === 400 && expiredConnection))
    || codes.some(value => /cancel|abort_err|err_aborted|err_canceled|previous|metadata|identity|mismatch|invalid_char|quota|billing|credits|usage_limit|safety|content_policy/iu.test(value))) return false;
  const diagnosis = classifyModelFailure({ source: "transport", code: error.code,
    statusCode: statuses[0], requestAccepted: error.requestAccepted,
    requestTransmissionState: error.requestTransmissionState, wsCloseCode: error.closeCode,
    cancelled: error.cancelled, message: { code: error.code, message: error.message,
      error: error.upstreamError ?? error.error, response: error.response, cause: error.cause } });
  if (["authentication", "quota", "safety", "cancelled", "payload_too_large", "transport_capacity"].includes(diagnosis.category)
    || diagnosis.category === "permanent" && diagnosis.reasonCode !== "unknown_failure") return false;
  return diagnosis.category === "temporary" || nativeWsCapacityFailure(error) || codes.some(value => temporaryNativeWsCodes.has(value.toUpperCase())
    || /^(?:WS_HTTP_)?(?:429|502|503|504)$/u.test(value)
    || /^(?:rate_limit_exceeded|rate_limit_error|too_many_requests|overloaded_error|engine_overloaded|service_unavailable|temporarily_unavailable)$/iu.test(value))
    || statuses.some(value => [429, 502, 503, 504].includes(value));
}

export function createNativeWsRetryGate(options = {}) {
  const bounded = (name, maximum, minimum = 0) => Number.isFinite(options[name])
    ? Math.min(maximum, Math.max(minimum, options[name])) : maximum;
  const delayMs = bounded("delayMs", 30000);
  const slowDelayMs = bounded("slowDelayMs", 1000);
  const ttlMs = bounded("ttlMs", 60000, 1);
  const fastFailureMs = bounded("fastFailureMs", 8000);
  const maxEntries = Math.floor(bounded("maxEntries", 128, 1));
  const maxWaiters = Math.floor(bounded("maxWaiters", 32, 1));
  const entries = new Map();
  const waiters = new Set();
  let closed = false;
  const cancellation = () => Object.assign(new Error("NATIVE_WS_RETRY_CANCELLED: Native WebSocket retry wait cancelled"), { code: "NATIVE_WS_RETRY_CANCELLED" });
  const identity = metadata => metadata && typeof metadata.thread_id === "string" && metadata.thread_id.trim()
    && typeof metadata.turn_id === "string" && metadata.turn_id.trim() && !metadata.turn_id.startsWith("prewarm:")
    && (metadata.request_kind === undefined || ["turn", "compaction"].includes(metadata.request_kind))
    ? { thread_id: metadata.thread_id, turn_id: metadata.turn_id, request_kind: metadata.request_kind ?? "turn" } : null;
  const remove = (threadId, entry, kind) => {
    for (const waiter of [...waiters]) {
      if (waiter.entry === entry && (kind === undefined || waiter.kind === kind)) waiter.finish(cancellation());
    }
    if (kind === undefined) entries.delete(threadId);
    else {
      entry.kinds.delete(kind);
      if (!entry.kinds.size) entries.delete(threadId);
    }
  };
  const prune = () => {
    const now = performance.now();
    for (const [threadId, entry] of entries) {
      for (const [kind, state] of entry.kinds) if (now - state.touched >= (state.capacityAttempts ? Math.max(ttlMs, 600000) : ttlMs)) remove(threadId, entry, kind);
    }
  };
  const current = metadata => {
    const entry = entries.get(metadata.thread_id);
    if (entry && entry.turnId !== metadata.turn_id) { remove(metadata.thread_id, entry); return null; }
    return entry;
  };
  const clear = metadata => {
    const valid = identity(metadata);
    const entry = valid && entries.get(valid.thread_id);
    if (valid && entry?.turnId === valid.turn_id) remove(valid.thread_id, entry, valid.request_kind);
  };
  return {
    wait({ metadata, signal } = {}) {
      if (closed) return Promise.reject(cancellation());
      prune();
      if (signal?.aborted) return Promise.reject(cancellation());
      const valid = identity(metadata);
      if (!valid) return Promise.resolve();
      const entry = current(valid);
      const state = entry?.kinds.get(valid.request_kind);
      if (!state) return Promise.resolve();
      const now = performance.now();
      state.touched = now;
      const remaining = Math.min(30000, state.until - now);
      if (remaining <= 0) return Promise.resolve();
      if (waiters.size >= maxWaiters) return Promise.reject(Object.assign(new Error("Native WebSocket retry wait capacity reached"), { code: "NATIVE_WS_RETRY_CAPACITY" }));
      return new Promise((resolve, reject) => {
        const waiter = { entry, kind: valid.request_kind, timer: null, finish: null };
        const onAbort = () => waiter.finish(cancellation());
        waiter.finish = error => {
          if (!waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve();
        };
        waiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        waiter.timer = setTimeout(() => waiter.finish(), Math.ceil(remaining));
        if (signal?.aborted) onAbort();
      });
    },
    record({ metadata, error, elapsedMs } = {}) {
      if (closed) return;
      prune();
      const valid = identity(metadata);
      if (!valid) return;
      let entry = current(valid);
      const previous = entry?.kinds.get(valid.request_kind);
      if (!nativeWsTemporaryFailure(error)) {
        if (previous?.capacityAttempts && error?.code === "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH") return;
        clear(valid); return;
      }
      if (!entry) {
        if (entries.size >= maxEntries) return;
        entry = { turnId: valid.turn_id, kinds: new Map() };
        entries.set(valid.thread_id, entry);
      }
      const now = performance.now();
      const capacity = nativeWsCapacityFailure(error);
      const delay = capacity || Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= fastFailureMs ? delayMs : slowDelayMs;
      const capacityAttempts = (previous?.capacityAttempts ?? 0) + (capacity ? 1 : 0);
      entry.kinds.set(valid.request_kind, { until: now + delay, touched: now, capacityAttempts });
      return { capacityAttempts, exhausted: capacity && capacityAttempts >= 6 };
    },
    clear,
    close() {
      if (closed) return;
      closed = true;
      for (const [threadId, entry] of entries) remove(threadId, entry);
    },
    status() { prune(); return { entries: entries.size, waiters: waiters.size, timers: waiters.size, closed }; },
  };
}

export function nativeResponseMetadata(payload, request) {
  const raw = payload?.client_metadata?.["x-codex-turn-metadata"] ?? request?.headers?.["x-codex-turn-metadata"];
  if (raw == null || typeof raw === "string" && raw.length > 8192) throw Object.assign(new Error("Native response identity is missing"), { code: "NATIVE_WS_IDENTITY_REQUIRED" });
  let metadata;
  try { metadata = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw Object.assign(new Error("Native response identity is invalid"), { code: "NATIVE_WS_IDENTITY_REQUIRED" }); }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw Object.assign(new Error("Native response identity is invalid"), { code: "NATIVE_WS_IDENTITY_REQUIRED" });
  return metadata;
}

export function nativeResponseMetadataHeader(metadata) {
  const header = JSON.stringify(metadata).replace(/[^\x20-\x7e]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (header.length > 8192) throw Object.assign(new Error("Native metadata header is too large"), {
    code: "NATIVE_WS_METADATA_HEADER_TOO_LARGE", httpStatus: 400,
  });
  return header;
}

function isSettledResponseInterrupt(payload, activeResponseId, completedIds) {
  return payload?.type === "response.interrupt" && payload.mode === "discard_partial_items"
    && typeof payload.response_id === "string" && payload.response_id.length > 0 && payload.response_id.length <= 512
    && completedIds.has(payload.response_id) && payload.response_id !== activeResponseId;
}

function cleanHeaders(headers, allowInternalConnection = false) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !ignoredHeaders.has(name.toLowerCase())
    && (allowInternalConnection || name.toLowerCase() !== INTERNAL_MEMORY_CONNECTION_HEADER)));
}

function sendError(socket, code, status = 503, onSent = noop, details = {}) {
  if (socket.readyState !== webSocketOpen) { onSent(new Error("NATIVE_WS_NOT_OPEN")); return; }
  const knownCode = typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(code) ? code : "NATIVE_WS_UPSTREAM_ERROR";
  socket.send(JSON.stringify({ type: "error", status, error: {
    type: status === 400 ? "invalid_request_error" : "server_error", code: knownCode,
    message: status === 400 ? "The local WebSocket request could not be continued." : "The local WebSocket connection must be re-established.", ...details,
  } }), onSent);
}

function sendFailure(socket, failure, onSent = noop) {
  if (socket.readyState !== webSocketOpen) { onSent(new Error("NATIVE_WS_NOT_OPEN")); return; }
  if (failure?.code === "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH") {
    socket.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error",
      code: "previous_response_not_found", param: "previous_response_id", message: "Previous response is unavailable on this connection.",
      ...(failure.requestTransmissionState === "not_sent" && failure.requestAccepted === false
        ? { requestAccepted: false, operationAcceptance: "not_sent", requestTransmissionState: "not_sent" } : {}) } }), onSent);
    return;
  }
  if (failure?.upstreamError && typeof failure.upstreamError === "object" && !Array.isArray(failure.upstreamError)) {
    socket.send(JSON.stringify({ type: "error", ...(Number.isInteger(failure.httpStatus) ? { status: failure.httpStatus } : {}), error: failure.upstreamError }), onSent);
    return;
  }
  const notSent = failure?.requestTransmissionState === "not_sent" && failure?.requestAccepted === false;
  sendError(socket, failure?.code, Number.isInteger(failure?.httpStatus) ? failure.httpStatus : 503, onSent,
    notSent ? { requestAccepted: false, operationAcceptance: "not_sent", requestTransmissionState: "not_sent" } : {});
}

function closeFailedPeer(socket, failure, code = 1011) {
  nativeConnectionCloseReasons.set(socket, "failed");
  const terminate = () => {
    clearTimeout(timer);
    if (socket.readyState !== 3) socket.terminate();
  };
  const timer = setTimeout(terminate, 1000);
  timer.unref?.();
  socket.once("close", () => clearTimeout(timer));
  try {
    sendFailure(socket, failure, () => {
      try { socket.close(code, "model connection must reconnect"); } finally { terminate(); }
    });
  } catch { terminate(); }
}

const rawSocketGuardKey = Symbol.for("napcat.native.responses.rawSocketErrorGuard");
const endpointGuardKey = Symbol.for("napcat.native.responses.endpointSocketGuard");

export function guardNativeResponseSocket(socket, onEvent = noop) {
  if (socket[rawSocketGuardKey]) return socket[rawSocketGuardKey].connectionId;
  const connectionId = crypto.randomUUID();
  socket[rawSocketGuardKey] = Object.freeze({ connectionId });
  socket.on("error", error => {
    const reason = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code : "SOCKET_ERROR";
    try { onEvent({ type: "native_ws_socket_error", connectionId, reason }); } catch {}
    socket.destroy();
  });
  return connectionId;
}

export function installNativeResponseSocketGuard(server, onEvent = noop) {
  if (server[endpointGuardKey]) return server[endpointGuardKey];
  const listener = (_request, socket) => guardNativeResponseSocket(socket, onEvent);
  const registration = Object.freeze({ kind: "supplemental", listener });
  server.prependListener("upgrade", listener);
  server[endpointGuardKey] = registration;
  server.once("close", () => {
    server.off("upgrade", listener);
    if (server[endpointGuardKey] === registration) delete server[endpointGuardKey];
  });
  try { onEvent({ type: "native_ws_socket_guard_installed" }); } catch {}
  return registration;
}

function attachEndpoint({ server, maxPayload = 192 * 1024 * 1024, maxConnections = 32, isClosing = () => false, onConnection, onEvent = noop }) {
  let webSockets = null;
  let closed = false;
  const lifecycles = new WeakMap();
  const reclaiming = new WeakSet();
  const emit = (type, connectionId, reason, fields = {}) => {
    try { onEvent({ type, connectionId, reason, connections: webSockets?.clients.size ?? 0, maxConnections, ...fields }); } catch {}
  };
  const handleUpgrade = async (request, socket, head) => {
    const connectionId = guardNativeResponseSocket(socket, event => {
      emit(event.type, event.connectionId, event.reason);
    });
    let pendingUpgradeCancelled = false;
    const cancelPendingUpgrade = () => {
      if (pendingUpgradeCancelled) return;
      pendingUpgradeCancelled = true;
      emit("native_ws_upgrade_cancelled", connectionId, "peer_closed");
      socket.destroy();
    };
    socket.once("end", cancelPendingUpgrade);
    socket.once("close", cancelPendingUpgrade);
    try {
    const pathname = String(request.url ?? "").split("?")[0];
    if (responsePaths.has(pathname) && !closed && !isClosing() && (webSockets?.clients.size ?? 0) >= maxConnections) {
      const deadline = Date.now() + 1000;
      for (const candidate of [...webSockets.clients]) {
        if (Date.now() >= deadline || webSockets.clients.size < maxConnections || socket.destroyed || closed || isClosing()) break;
        if (reclaiming.has(candidate) || lifecycles.get(candidate)?.canReclaim?.() !== true) continue;
        reclaiming.add(candidate);
        try {
          const reclaimed = await lifecycles.get(candidate).reclaimIfIdle({
            stillRequired: () => !socket.destroyed && !closed && !isClosing() && webSockets.clients.size >= maxConnections,
            timeoutMs: deadline - Date.now(),
          });
          if (reclaimed) { emit("native_ws_slot_reclaimed", nativeConnectionIds.get(candidate), "authority_idle"); break; }
        } catch {} finally { reclaiming.delete(candidate); }
      }
    }
    if (socket.destroyed) return;
    const connections = webSockets?.clients.size ?? 0;
    const reason = !responsePaths.has(pathname) ? "path" : closed || isClosing() ? "closing"
      : connections >= maxConnections ? "capacity" : null;
    if (reason) {
      const statusCode = reason === "capacity" ? 426 : 503;
      const code = reason === "capacity" ? "WS_CONNECTION_LIMIT_REACHED" : "NATIVE_WS_ENDPOINT_UNAVAILABLE";
      const body = JSON.stringify({ error: { code, message: reason === "capacity"
        ? "Local WebSocket capacity is full; continue this request over HTTP."
        : "Local WebSocket endpoint is unavailable." } });
      try { onEvent({ type: "native_ws_upgrade_rejected", connectionId, reason, statusCode, connections, maxConnections }); } catch {}
      socket.end(`HTTP/1.1 ${statusCode} ${statusCode === 426 ? "Upgrade Required" : "Service Unavailable"}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    try {
      if (!webSockets) {
        const { WebSocketServer } = require("ws");
        webSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload, WebSocket: NativeBodyWebSocket });
        webSockets.on("connection", (peer, handshake) => {
          const lifecycle = onConnection(peer, handshake);
          if (lifecycle) lifecycles.set(peer, lifecycle);
        });
      }
      webSockets.handleUpgrade(request, socket, head, peer => {
        peer.on("error", noop);
        nativeConnectionIds.set(peer, connectionId);
        webSockets.emit("connection", peer, request);
        emit("native_ws_connection_opened", connectionId, "accepted");
        peer.once("close", closeCode => {
          const reason = closed ? "endpoint_close" : nativeConnectionCloseReasons.get(peer) ?? "peer_close";
          emit("native_ws_connection_closed", connectionId, reason, {
            closeCode: Number.isInteger(closeCode) && closeCode >= 1000 && closeCode <= 4999 ? closeCode : null,
            direction: reason === "peer_close" ? "unknown" : "send" });
        });
      });
    } catch { socket.destroy(); }
    } finally {
      socket.off("end", cancelPendingUpgrade);
      socket.off("close", cancelPendingUpgrade);
    }
  };
  const upgrade = (request, socket, head) => { handleUpgrade(request, socket, head).catch(() => socket.destroy()); };
  server.on("upgrade", upgrade);
  const registration = Object.freeze({ kind: "endpoint", listener: upgrade });
  if (!server[endpointGuardKey]) server[endpointGuardKey] = registration;
  return {
    status: () => ({ connections: webSockets?.clients.size ?? 0, closed }),
    async close() {
      if (closed) return;
      closed = true;
      server.off("upgrade", upgrade);
      if (server[endpointGuardKey] === registration) delete server[endpointGuardKey];
      if (!webSockets) return;
      for (const peer of webSockets.clients) peer.terminate();
      await new Promise(resolve => webSockets.close(resolve));
    },
  };
}

export function attachNativeResponsesBridge({ server, createRequestClient, releaseSession = noop, upstreamUrl,
  isClosing, onEvent = noop, maxPayload, maxConnections, admissionWaitingByteLimit, reserveAdmissionBytes, maxEventBytes = 32 * 1024 * 1024,
  onPacketSending, onPreparationProgress, onUploadProgress, onRequestStart = noop, onRequestEnd = noop, onToolDone = noop,
  onConnectionClosed = noop, nativeWsRetryOptions, getOperation = () => null, onRecoveryState = noop,
  managedRecovery = false, managedRetryBaseMs = 5000, recoveryWaitLimitMs = 300000, maxNetworkRetries = 16, executeHttpAttempt, prepareBodySource }) {
  const effectiveMaxNetworkRetries = Number.isSafeInteger(maxNetworkRetries) && maxNetworkRetries >= 1 ? maxNetworkRetries : 16;
  const jobs = new Set();
  const sourceCleanups = new Set();
  const ownedPreparations = new WeakSet();
  const releasePrepared = (prepared, attempt, job) => {
    if (!prepared && !job) return;
    const cleanup = Promise.resolve(attempt).catch(noop).then(() => disposeNativePrepared(job?.prepared ?? prepared));
    sourceCleanups.add(cleanup);
    cleanup.catch(error => { try { onEvent({ type: "native_ws_source_cleanup_failed", code: error?.code }); } catch {} })
      .finally(() => sourceCleanups.delete(cleanup));
  };
  const maxAdmissionWaitingBytes = Math.min((maxPayload ?? 192 * 1024 * 1024) * 2,
    Number.isSafeInteger(admissionWaitingByteLimit) && admissionWaitingByteLimit > 0 ? admissionWaitingByteLimit : 8 * 1024 * 1024);
  let admissionWaitingBytes = 0;
  const retryGate = createNativeWsRetryGate(nativeWsRetryOptions);
  const endpoint = attachEndpoint({ server, maxPayload, maxConnections, isClosing, onEvent,
    onConnection(peer, handshake) {
      const connectionId = nativeConnectionIds.get(peer) ?? crypto.randomUUID();
      const connectionToken = takeInternalMemoryConnectionHeader(handshake.headers);
      const sessionKey = `native:${connectionId}`;
      const clientKeepalive = createNativeClientKeepalive(peer, nativeWsRetryOptions?.keepaliveIntervalMs);
      let active = null;
      let threadId = null;
      let anchor = null;
      const setAnchor = next => {
        const previous = anchor;
        anchor = next ? { ...next, input: isRootInputProjection(next.input) ? retainRootInput(next.input) : next.input } : null;
        if (previous) {
          const cleanup = releaseRootInput(previous.input);
          sourceCleanups.add(cleanup);
          cleanup.catch(error => emit("native_ws_source_cleanup_failed", { code: error?.code }))
            .finally(() => sourceCleanups.delete(cleanup));
        }
      };
      let peerClosed = false;
      const terminalResponseIds = new Set();
      const invalidatedResponseIds = new Set();
      const invalidateResponseIds = (...ids) => {
        for (const id of ids) {
          if (typeof id !== "string" || !id) continue;
          invalidatedResponseIds.add(id);
          if (invalidatedResponseIds.size > 64) invalidatedResponseIds.delete(invalidatedResponseIds.values().next().value);
        }
        try { releaseSession(sessionKey); } catch {}
      };
      const emit = (type, fields = {}) => { try { onEvent({ type, connectionId, ...fields }); } catch {} };
      const recoveryState = (job, phase, fields = {}) => {
        job.recoveryPhase = phase;
        job.recoveryWait = { type: "model_recovery_state", requestId: job.operationId, operationId: job.operationId,
          threadId: job.metadata.thread_id, turnId: job.metadata.turn_id, requestKind: job.metadata?.request_kind ?? "turn",
          sequence: ++job.recoverySequence, phase, reason: job.recoveryReason, willRetry: false,
          canContinueHttp: false, transport: job.httpFallback ? "http" : "ws", ...fields };
        try { onRecoveryState({ ...job.recoveryWait }); }
        catch { emit("recovery_state_observer_failed", { operationId: job.operationId }); }
      };
      const mapClientResponse = (job, raw) => {
        const responseId = raw.response?.id ?? raw.response_id;
        if (typeof responseId === "string") {
          job.upstreamResponseId = responseId;
          job.publicResponseId ??= responseId;
        }
        if (!job.networkRetry && !job.capacityRetry) {
          if (Number.isSafeInteger(raw.sequence_number)) job.clientSequence = Math.max(job.clientSequence, raw.sequence_number);
          return raw;
        }
        const event = structuredClone(raw);
        if (event.response?.id !== undefined) event.response.id = job.publicResponseId;
        if (event.response_id !== undefined) event.response_id = job.publicResponseId;
        if (/^response\./u.test(event.type ?? "")) event.sequence_number = ++job.clientSequence;
        return event;
      };
      const replayAllowed = (operation, job) => Boolean(operation) && !job.progressObserved && !job.deliveredExecutableToolDone
        && !job.progressBudgetExceeded
        && operation.canRetry === true && operation.requiresReconciliation !== true && operation.terminalOutcome !== "completed";
      const settle = job => {
        if (!job.started || job.ended) return;
        job.ended = true;
        try { onRequestEnd({ context: job.context, operationId: job.operationId,
          deliveredExecutableToolDone: job.deliveredExecutableToolDone, progressObserved: job.progressObserved,
          reasoningProgressObserved: job.reasoningProgressObserved,
          requestStarted: job.upstreamStarted, httpOutcome: job.httpOutcome, ...job.outcome }); }
        catch (error) {
          job.settlementFailed = true;
          job.outcome = { ...job.outcome, kind: "failed", settlementState: "unknown", error };
          emit("native_ws_state_write_failed", { code: error.code ?? "NATIVE_WS_STATE_WRITE_FAILED", settlementState: "unknown" });
          return error;
        }
      };
      const release = (job, outcome = {}) => {
        if (!job || job.released) return;
        clientKeepalive.stop();
        job.released = true;
        const cancelled = outcome.kind === "cancelled";
        const protect = outcome.kind !== "completed" && !outcome.confirmedUpstreamTerminal;
        const beforeAbort = protect ? pendingReconciliation(job, outcome.userRequested, cancelled) : null;
        job.outcome = { ...outcome, ...beforeAbort };
        job.cancelled = true;
        job.currentAbort?.();
        job.abort.abort();
        job.reasoningProgress?.clear();
        clearInterval(job.resumeTimer);
        job.resumeTimer = null;
        job.response?.resume();
        if (protect && !beforeAbort) Object.assign(job.outcome, pendingReconciliation(job, outcome.userRequested, cancelled));
        job.readHttpTransmissionState = null;
        const settlementError = settle(job);
        job.admissionLease?.release();
        releasePrepared(job.prepared, Promise.allSettled([job.httpAttempt, job.admissionAttempt, job.bodyPreparation]), job);
        if (!settlementError && job.terminal && typeof job.publicResponseId === "string"
          && job.publicResponseId.length > 0 && job.publicResponseId.length <= 512) {
          terminalResponseIds.delete(job.publicResponseId);
          terminalResponseIds.add(job.publicResponseId);
          if (terminalResponseIds.size > 32) terminalResponseIds.delete(terminalResponseIds.values().next().value);
        }
        if (!settlementError && (["completed", "interrupted"].includes(outcome.kind)
          || outcome.kind === "cancelled" && job.clearRetry)) retryGate.clear(job.metadata);
        const cancellation = outcome.userRequested === true
          ? { reason: "user_interrupt", userRequested: true, cancellationScope: "turn", cancellationOrigin: "user_interrupt", willRetry: false }
          : outcome.kind === "cancelled" ? { cancellationScope: "request", cancellationOrigin: outcome.cancellationOrigin
            ?? (isClosing?.() ? "service_shutdown" : peerClosed || peer.readyState !== webSocketOpen
              ? "downstream_connection" : "request_cancelled") } : {};
        if (job.recoverySequence) recoveryState(job, settlementError ? "failed" : outcome.kind === "cancelled" || outcome.userRequested ? "stopped"
          : outcome.kind === "completed" || outcome.kind === "interrupted" ? "completed" : "failed",
        settlementError ? { reason: settlementError.code ?? "NATIVE_WS_STATE_WRITE_FAILED", settlementState: "unknown" } : cancellation);
        jobs.delete(job);
        if (active === job) active = null;
        emit("native_ws_request_finished", { operationId: job.operationId, terminal: job.terminal,
          outcome: outcome.kind, ...cancellation });
        return settlementError;
      };
      const internalJob = job => job.internalRequest || job.context?.internalMemory || job.context?.internalMemoryPrewarm;
      const validationFor = error => Object.getOwnPropertyDescriptor(error ?? {}, "nativeRequestValidation")?.value;
      const startFailureCanFinishTurn = (job, error) => job.startCallbackFailed && job.ordinaryTurn
        && validationFor(error)?.kind === "turn" && validationFor(error)?.threadId === job.metadata.thread_id
        && validationFor(error)?.turnId === job.metadata.turn_id && validationFor(error)?.operationId === job.operationId;
      const admitRequest = async (job, start) => {
        let retryNumber = 0;
        let reservedBytes = 0;
        try {
        for (;;) {
          try {
            const context = await start();
            job.startCallbackFailed = false;
            return context;
          } catch (error) {
            job.startCallbackFailed = true;
            const policy = classifyModelFailure({ source: "local", code: error?.code, statusCode: nativeWsHttpStatus(error),
              requestTransmissionState: "not_sent",
              progressObserved: job.progressObserved, toolDelivered: job.deliveredExecutableToolDone });
            const canRetry = managedRecovery && job.ordinaryTurn && !internalJob(job) && !job.started && !job.upstreamStarted
              && !job.progressObserved && !job.deliveredExecutableToolDone && !Object.hasOwn(error ?? {}, "nativeRequestValidation")
              && policy.category === "temporary" && policy.retryable;
            if (!canRetry || job.released || peerClosed || isClosing?.()) throw error;
            if (!reservedBytes) {
              const bytes = job.requestBytes * 2;
              if (!Number.isSafeInteger(bytes) || bytes > maxAdmissionWaitingBytes - admissionWaitingBytes) {
                emit("native_ws_admission_budget_rejected", { operationId: job.operationId, requestBytes: job.requestBytes,
                  admissionWaitingBytes, maxAdmissionWaitingBytes, requestTransmissionState: "not_sent", requestAccepted: false });
                throw Object.assign(new Error("Native admission waiting buffer is full", { cause: error }), {
                  code: "NATIVE_WS_BUFFER_CAPACITY", httpStatus: 503, requestAccepted: false,
                  operationAcceptance: "not_sent", requestTransmissionState: "not_sent" });
              }
              reservedBytes = bytes;
              admissionWaitingBytes += reservedBytes;
              emit("native_ws_admission_budget_reserved", { operationId: job.operationId, reservedBytes,
                admissionWaitingBytes, maxAdmissionWaitingBytes });
            }
            retryNumber += 1;
            job.waiting = true;
            job.recoveryReason = policy.reasonCode;
            const state = { willRetry: true, acceptance: "not_sent", category: policy.category,
              httpStatusCode: nativeWsHttpStatus(error), startedAt: Date.now(), retryNumber: 0,
              admissionRetryNumber: retryNumber, waitContext: "native_request_admission", retryAction: "retry",
              transport: "ws", attemptStarted: false };
            recoveryState(job, "waiting", state);
            const action = await waitForRecoveryAction(Math.min(60000, managedRetryBaseMs * 2 ** Math.min(6, retryNumber - 1)),
              job, { keepaliveIntervalMs: 100, onKeepalive: () => {
                if (isClosing?.() || peerClosed || peer.readyState !== webSocketOpen) job.cancel();
              } });
            job.waiting = false;
            if (action === "cancel" || job.released || peerClosed || isClosing?.()) {
              if (!job.released) job.cancel();
              throw Object.assign(new Error("Native admission cancelled"), { code: "NATIVE_WS_RETRY_CANCELLED" });
            }
            recoveryState(job, "retrying", state);
          }
        }
        } finally {
          admissionWaitingBytes -= reservedBytes;
          if (reservedBytes) emit("native_ws_admission_budget_released", { operationId: job.operationId, reservedBytes,
            admissionWaitingBytes, maxAdmissionWaitingBytes });
        }
      };
      const operationFor = job => {
        if (!job.httpFallback) return getOperation(job.operationId);
        const outcome = job.httpOutcome;
        if (!outcome) return null;
        const failureEvent = outcome.upstreamFailureEvent;
        const failureWithoutOutput = !failureEvent || (failureEvent.type === "error"
          || failureEvent.type === "response.failed" && failureEvent.response?.status === "failed")
          && (failureEvent.response?.output === undefined
            || Array.isArray(failureEvent.response.output) && failureEvent.response.output.length === 0);
        const sourceCompactionReplay = job.compacting && job.prepared?.sourceBased === true
          && job.metadata?.request_kind === "compaction" && !job.createdDelivered && !job.progressObserved
          && !job.deliveredExecutableToolDone && job.deliveredItems.size === 0 && failureWithoutOutput && !outcome.progressObserved
          && outcome.transportRetryWithoutOutput !== false && outcome.transportReconciliationRequired !== true
          && !outcome.deliveredExecutableToolDone && outcome.failure?.category !== "capacity";
        const cancelledCleanHttp = outcome.kind === "cancelled" && !outcome.sawNonLocalSideEffect
          && !outcome.sawHostedTool && !outcome.deliveredExecutableToolDone
          && !outcome.sawExecutableToolDone && !outcome.holdingToolDone && job.storeRequested !== true;
        const compactionHttpTransient = job.compacting && outcome.kind !== "completed"
          && ["temporary", "acceptance_unknown"].includes(outcome.policy?.category)
          && !outcome.sawNonLocalSideEffect && !outcome.sawHostedTool && !outcome.sawTool
          && !outcome.deliveredExecutableToolDone && !outcome.sawExecutableToolDone
          && !outcome.holdingToolDone && job.storeRequested !== true;
        const unresolvedHttpOutput = !cancelledCleanHttp && !compactionHttpTransient
          && (outcome.transportReconciliationRequired === true || outcome.kind !== "completed"
            && (outcome.progressObserved || outcome.sawSubstantiveWork || outcome.sawTool || outcome.deliveredExecutableToolDone));
        const canRetry = !unresolvedHttpOutput && outcome.policy?.retryable === true && !outcome.localRejection && !outcome.sawReplayUnsafeContent
          && !outcome.sawSubstantiveWork && !outcome.sawTool && !outcome.sawExecutableToolDone
          && !outcome.sawHostedTool && !outcome.sawNonLocalSideEffect
          && (!outcome.sawCompaction || sourceCompactionReplay || compactionHttpTransient);
        return { canRetry, sourceCompactionReplay: canRetry && (sourceCompactionReplay || compactionHttpTransient),
          requiresReconciliation: !cancelledCleanHttp && !compactionHttpTransient
            && (unresolvedHttpOutput || !canRetry && outcome.policy?.acceptance === "unknown"),
          recoveryReconciliationRequired: cancelledCleanHttp || compactionHttpTransient ? false
            : Boolean(outcome.transportReconciliationRequired || outcome.sawNonLocalSideEffect || outcome.sawHostedTool
              || outcome.sawTool || outcome.sawExecutableToolDone || outcome.holdingToolDone || outcome.sawCompaction),
          acceptance: outcome.policy?.acceptance === "rejected" || outcome.policy?.acceptance === "not_sent" ? false
            : outcome.policy?.acceptance === "accepted" ? true : "unknown",
          requestTransmissionState: outcome.requestTransmissionState, terminalOutcome: outcome.kind === "completed" ? "completed" : undefined };
      };
      const pendingReconciliation = (job, userRequested = false, cancelled = false) => {
        if (!job.started || !job.context?.key) return null;
        try {
          const observed = nativePendingDisposition(operationFor(job), job, { cancelled }) ?? job.nativeReconciliationEvidence ?? null;
          if (observed || userRequested === true || !job.httpFallback || job.httpOutcome) return observed;
          if (cancelled && safeForClientCancellation(job, { recoveryReconciliationRequired: false })) return null;
          return nativePendingDisposition({ requiresReconciliation: true, recoveryReconciliationRequired: true, acceptance: "unknown",
            requestTransmissionState: job.readHttpTransmissionState?.() }, job, { cancelled });
        } catch { return job.nativeReconciliationEvidence ?? null; }
      };
      const fail = (job, error, capacity) => {
        if (job.released || peerClosed || job.managedWaiting) return;
        if (error?.code === "NATIVE_WS_REASONING_PROGRESS_LIMIT") job.progressBudgetExceeded = true;
        let failureOperation = null;
        try {
          const attempt = Object.getOwnPropertyDescriptor(error ?? {}, "nativeTransportAttempt")?.value;
          failureOperation = capacity?.operation
            ?? (!job.httpFallback && attempt?.operationId === job.operationId ? attempt : operationFor(job));
        } catch {}
        job.nativeReconciliationEvidence ??= nativePendingDisposition(failureOperation, job, {
          cancelled: Boolean(job.cancelled || job.interruptResponseId),
        });
        const failureDiagnostics = nativeWsFailureDiagnostics(job, error, failureOperation);
        emit("native_ws_failure_diagnostic", { operationId: job.operationId,
          ...failureDiagnostics });
        if (job.progressBudgetExceeded) {
          finishNotice(job, null, "推理进度已达到本次请求的内存预算，请保留已显示内容后重新发起请求。", job.fullInput,
            "native_ws_progress_budget_exceeded", {}, error);
          job.request?.destroy();
          return;
        }
        if (job.interruptResponseId && job.ordinaryTurn && !internalJob(job)) {
          const event = error?.upstreamFailureSignals;
          const knownFailure = Boolean(event && job.nativeFailedTerminal === event);
          if (knownFailure || job.nativeReconciliationEvidence) {
            finishNotice(job, knownFailure ? event : null, knownFailure ? nativeFailureNotice(event) : unresolvedNativeNotice,
              job.fullInput, "native_ws_terminal_notice", {}, error);
            job.request?.destroy();
            return;
          }
        }
        const recoveryPolicy = classifyModelFailure({ source: "transport", code: error?.code,
          statusCode: error?.httpStatus, message: error?.upstreamFailureSignals ?? error?.upstreamError,
          requestTransmissionState: failureOperation?.requestTransmissionState,
          requestAccepted: failureOperation?.acceptance, progressObserved: job.progressObserved,
          toolDelivered: job.deliveredExecutableToolDone, wsCloseCode: error?.closeCode });
        const recoveryAction = modelRecoveryAction(recoveryPolicy, { ordinary: job.ordinaryTurn && !internalJob(job),
          cancelled: job.cancelled || Boolean(job.interruptResponseId), localRejection: Boolean(job.startCallbackFailed),
          outputDelivered: job.progressObserved || job.deliveredExecutableToolDone,
          clientCanContinue: Boolean(job.publicResponseId) });
        if (confirmedNativeToolContinuation(job, error?.upstreamFailureSignals)) {
          finishNotice(job, error.upstreamFailureSignals, nativeFailureNotice(error.upstreamFailureSignals), job.fullInput,
            "native_ws_terminal_notice", {}, error);
          return;
        }
        if (recoveryAction === "continue_in_client" && !job.deliveredExecutableToolDone
          && !job.unrecordedExecutableTool && !job.pendingLocalToolItems.size
          && (job.protocolProgress?.toolParameterBytes ?? 0) === 0
          && !job.sawNonLocalSideEffect && job.storeRequested !== true
          && failureOperation?.recoveryReconciliationRequired !== true
          && !isPermanentStructureRejection(failureDiagnostics)
          && (job.protocolProgress?.deliveredText === true
            || failureOperation?.terminalOutcome === "failed" && failureOperation.requiresReconciliation === false)) {
          job.terminal = true;
          const persistenceError = release(job, { kind: "failed", error });
          if (persistenceError) { invalidateResponseIds(job.publicResponseId, job.upstreamResponseId); setAnchor(null); closeFailedPeer(peer, persistenceError); return; }
          invalidateResponseIds(job.publicResponseId, job.upstreamResponseId);
          setAnchor(null);
          for (const [outputIndex, item] of job.deliveredItems) {
            if (item?.type !== "message" || item.status === "completed"
              || !item.content?.some(part => part?.type === "output_text" && part.text?.length)) continue;
            if (peer.readyState === webSocketOpen) peer.send(JSON.stringify({ type: "response.output_item.done",
              sequence_number: ++job.clientSequence, response_id: job.publicResponseId, output_index: outputIndex,
              item: { ...item, status: "completed" } }), sendError => { if (sendError) peer.terminate(); });
          }
          emit("native_ws_client_continuation", { operationId: job.operationId,
            reason: recoveryPolicy.reasonCode, deliveredExecutableToolDone: job.deliveredExecutableToolDone,
            partialToolItems: job.pendingLocalToolItems.size, replayed: false });
          if (peer.readyState === webSocketOpen) peer.send(JSON.stringify({ type: "response.failed",
            sequence_number: ++job.clientSequence, response: { id: job.publicResponseId, status: "failed", output: [],
              error: { code: "server_error", type: "server_error",
                message: "The model response stream was interrupted. Continue from completed output items." } } }),
          sendError => { if (sendError) peer.terminate(); });
          job.request?.destroy();
          return;
        }
        if (!job.httpFallback && executeHttpAttempt && managedRecovery && job.ordinaryTurn && !internalJob(job)
          && job.context?.key && job.fullInput && !job.progressObserved && !job.deliveredExecutableToolDone && !job.interruptResponseId
          && error?.code === "payload_too_large" && failureOperation?.acceptance === false
          && failureOperation.requestTransmissionState === "not_sent" && replayAllowed(failureOperation, job)) {
          job.httpFallback = true;
          job.networkRetry = true;
          const previous = job.request;
          job.request = null;
          previous?.destroy();
          emit("native_ws_http_fallback", { operationId: job.operationId, reason: error.code });
          try { job.startRequest(); } catch (nextError) { fail(job, nextError); }
          return;
        }
        const idleContextLoss = error?.code === "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH"
          && failureOperation?.acceptance === false && failureOperation.requestTransmissionState === "not_sent"
          && failureOperation.nativePreviousResponseMismatch?.bindingMatches === true
          && failureOperation.nativePreviousResponseMismatch.connectionOpen === false
          && failureOperation.nativePreviousResponseMismatch.lastResetWasIdle === true;
        const managedCapacity = capacity && managedRecovery && job.ordinaryTurn && !internalJob(job) && !job.httpFallback;
        const compactionNativeRetry = job.compacting && !job.httpFallback && !internalJob(job)
          && failureOperation?.retryableWithoutDelivery === true
          && !nativeWsCapacityFailure(error)
          && ["temporary", "acceptance_unknown"].includes(recoveryPolicy.category)
          && recoveryPolicy.retryable === true;
        const operation = managedCapacity ? failureOperation : managedRecovery && job.started && job.generating
          && (!job.compacting || failureOperation?.sourceCompactionReplay === true || compactionNativeRetry) && !idleContextLoss
          && !job.context?.internalMemory && !job.context?.internalMemoryPrewarm
          && job.metadata?.thread_id && job.metadata?.turn_id
          && (job.fullInput || job.replayableSource && !job.replayableSource.requestBody.released)
          && !job.progressObserved && !job.deliveredExecutableToolDone && !job.interruptResponseId
          && (job.httpFallback ? failureOperation?.canRetry
            : (recoveryAction === "retry_request" || compactionNativeRetry) && !nativeWsCapacityFailure(error)) ? failureOperation : null;
        if (operation) {
          job.recoveryStartedAt ??= Date.now();
          job.managedWaiting = true;
          job.waiting = true;
          job.recoveryReason = error?.code ?? "NATIVE_WS_UPSTREAM_ERROR";
          const retryable = replayAllowed(operation, job) && !isPermanentStructureRejection(failureDiagnostics);
          if (!retryable) {
            job.managedWaiting = false;
            job.waiting = false;
            finishNotice(job, error?.upstreamFailureSignals ?? null, nativeFailureNotice(error), job.fullInput,
              "native_ws_terminal_notice", { code: error?.code ?? "NATIVE_WS_UPSTREAM_ERROR",
                ...(error?.responseIdentityConflict ? { responseIdentityConflict: error.responseIdentityConflict } : {}) }, error);
            job.request?.destroy();
            return;
          }
          const previousRequest = job.request;
          job.request = null;
          clearInterval(job.resumeTimer);
          job.resumeTimer = null;
          job.response?.resume();
          previousRequest?.destroy();
          if (managedCapacity) {
            job.response = null;
            job.capacityRetry = true;
            waitForManagedCapacity(job, capacity).catch(nextError => fail(job, nextError));
            return;
          }
          if (!managedCapacity && job.networkRetryNumber >= effectiveMaxNetworkRetries) {
            job.managedWaiting = false;
            job.waiting = false;
            finishNotice(job, null, "上游连接多次中断，已自动重连仍未恢复，已有信息已保留，请稍后继续。", job.fullInput,
              "native_ws_terminal_notice", { code: error?.code ?? "NATIVE_WS_UPSTREAM_ERROR", retryExhausted: true,
                retryNumber: job.networkRetryNumber, recoveryElapsedMs: Date.now() - job.recoveryStartedAt }, error);
            return;
          }
          const retryNumber = ++job.networkRetryNumber;
          const delayMs = Math.min(60000, managedRetryBaseMs * 2 ** Math.min(6, retryNumber - 1));
          const recoveryCycle = { willRetry: retryable, retryNumber, recoveryCycleId: crypto.randomUUID(),
            acceptance: operation.acceptance === false ? "rejected" : operation.acceptance === true ? "accepted" : "unknown",
            httpStatusCode: Number.isInteger(error?.httpStatus) ? error.httpStatus : null, startedAt: Date.now(),
            category: recoveryPolicy.category, retryAction: job.httpFallback ? "retry" : "reconnect", attemptStarted: false };
          recoveryState(job, "waiting", recoveryCycle);
          waitForRecoveryAction(delayMs, job, { onKeepalive: () => {
            if (isClosing?.() || peerClosed || peer.readyState !== webSocketOpen) job.cancel();
          }, keepaliveIntervalMs: 100 }).then(action => {
            job.managedWaiting = false;
            if (job.released) return;
            if (action === "cancel" || isClosing?.()) { job.cancel(); return; }
            if (!replayAllowed(operationFor(job), job)) {
              fail(job, error);
              return;
            }
            recoveryState(job, "retrying", { ...recoveryCycle, willRetry: true });
            job.networkRetry = true;
            try { job.startRequest(); } catch (nextError) { fail(job, nextError); }
          }).catch(nextError => {
            job.managedWaiting = false;
            if (!job.released) { release(job, { kind: "failed", error: nextError }); closeFailedPeer(peer, nextError); }
          });
          return;
        }
        if (!internalJob(job) && job.generating && !job.compacting && error?.code !== "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH"
          && (startFailureCanFinishTurn(job, error) || job.started && job.upstreamStarted
            && (job.httpFallback || !nativeWsTemporaryFailure(error) || job.progressObserved || job.deliveredExecutableToolDone))) {
          if (job.startCallbackFailed) threadId ??= job.metadata.thread_id;
          finishNotice(job, error?.upstreamFailureSignals ?? null, nativeFailureNotice(error?.upstreamFailureSignals ?? error?.upstreamError ?? error),
            job.fullInput, "native_ws_terminal_notice", { code: error?.code ?? "NATIVE_WS_UPSTREAM_ERROR",
              ...(error?.responseIdentityConflict ? { responseIdentityConflict: error.responseIdentityConflict } : {}) }, error);
          job.request?.destroy();
          return;
        }
        const skipCompactionFastRestartCooldown = job.compacting && failureOperation?.retryableWithoutDelivery === true
          && error?.closeCode === 1012;
        if (job.attemptStarted !== null && !skipCompactionFastRestartCooldown) {
          retryGate.record({ metadata: job.metadata, error, elapsedMs: performance.now() - job.attemptStarted });
        }
        const persistenceError = release(job, { kind: "failed", error });
        emit("native_ws_request_failed", { operationId: job.operationId, code: error?.code ?? "NATIVE_WS_UPSTREAM_ERROR" });
        closeFailedPeer(peer, persistenceError ?? error);
        job.request?.destroy();
      };
      const waitForManagedCapacity = async (job, { event, attemptNumber }) => {
        let retry = false;
        try {
          emit("native_ws_capacity_retry_wait_started", { operationId: job.operationId, attemptNumber });
          await retryGate.wait({ metadata: job.metadata, signal: job.abort.signal });
          if (job.released || peerClosed) return;
          emit("native_ws_capacity_retry_wait_finished", { operationId: job.operationId, attemptNumber });
          const deadline = performance.now() + recoveryWaitLimitMs;
          const baseDelayMs = Math.max(100, Math.min(60000, managedRetryBaseMs));
          for (let checkNumber = 0; checkNumber <= 3; checkNumber++) {
            if (job.released || peerClosed) return;
            if (isClosing?.() || peer.readyState !== webSocketOpen) { job.cancel(); return; }
            if (checkNumber > 0 && performance.now() >= deadline) break;
            const operation = getOperation(job.operationId);
            if (operation?.terminalOutcome === "completed" || operation?.state === "completed") break;
            if (operation?.requiresReconciliation === false) {
              retry = replayAllowed(operation, job);
              break;
            }
            const remainingMs = deadline - performance.now();
            if ((operation && operation.requiresReconciliation !== true) || checkNumber === 3 || remainingMs <= 0) break;
            const delayMs = Math.min(60000, remainingMs, baseDelayMs * 2 ** checkNumber);
            emit("native_ws_capacity_reconciliation_wait", { operationId: job.operationId, checkNumber: checkNumber + 1,
              delayMs, recordPresent: Boolean(operation) });
            const action = await waitForRecoveryAction(delayMs, job, { keepaliveIntervalMs: 100, onKeepalive: () => {
              if (isClosing?.() || peerClosed || peer.readyState !== webSocketOpen) job.cancel();
            } });
            if (action === "cancel") { if (!job.released && !peerClosed) job.cancel(); return; }
          }
        } catch (error) {
          if (job.released || peerClosed) return;
          if (error?.code === "NATIVE_WS_RETRY_CANCELLED") { job.cancel(); return; }
          emit("native_ws_capacity_reconciliation_unavailable", { operationId: job.operationId, code: error?.code });
        } finally {
          job.managedWaiting = false;
          job.waiting = false;
        }
        if (job.released || peerClosed) return;
        if (retry) { job.startRequest(); return; }
        finishNotice(job, event, nativeFailureNotice(event), job.fullInput, "native_ws_terminal_notice");
      };
      const finishNotice = (job, event, text, fullInput, type, fields = {}, error) => {
        let failureOperation = null;
        try { failureOperation = operationFor(job); } catch {}
        const diagnostics = nativeWsFailureDiagnostics(job, error ?? event, failureOperation);
        job.terminal = true;
        if (job.compacting || internalJob(job)) {
          const persistenceError = release(job, { kind: "failed", event, ...(error ? { error } : {}) });
          emit("native_ws_failure_diagnostic", { operationId: job.operationId, ...diagnostics });
          if (persistenceError || !event) { closeFailedPeer(peer, persistenceError ?? error); return; }
          if (peer.readyState === webSocketOpen) {
            clientKeepalive.note();
            peer.send(JSON.stringify(event), sendError => { if (sendError) peer.terminate(); });
          }
          return;
        }
        const verifiedStop = event && (job.nativeIncompleteTerminal === event
          || job.interruptResponseId && job.nativeFailedTerminal === event);
        const confirmedUpstreamTerminal = confirmedNativeToolContinuation(job, event)
          || Boolean(verifiedStop && !job.deliveredExecutableToolDone && !job.pendingLocalToolItems.size);
        const persistenceError = release(job, { kind: "failed", event, ...(error ? { error } : {}), confirmedUpstreamTerminal });
        const pending = job.outcome?.requiresReconciliation === true;
        const noticeText = pending && !event ? unresolvedNativeNotice : text;
        const notice = persistenceError ? `${noticeText}\n本次请求的结束状态保存失败，请核对已有输出后再继续。` : noticeText;
        const outgoingEvents = job.recovery.finish(notice, event).split(/\r?\n\r?\n/u).filter(Boolean).map(frame => JSON.parse(
          frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")));
        for (const outgoing of outgoingEvents) {
          if (typeof outgoing.item?.id === "string" && Number.isSafeInteger(outgoing.output_index)) {
            job.itemIndices.set(outgoing.item.id, outgoing.output_index);
          }
        }
        const completed = outgoingEvents.find(outgoing => outgoing.type === "response.completed");
        const deliveredAllNonMessages = [...job.deliveredItems.values()].filter(item => item.type !== "message");
        const deliveredNonMessages = deliveredAllNonMessages.filter(item =>
          !(job.interruptResponseId || verifiedStop || pending || persistenceError) || item.type === "reasoning");
        const droppedDeliveredNonMessages = deliveredNonMessages.length < deliveredAllNonMessages.length;
        completed.response.output = [...completed.response.output, ...deliveredNonMessages].sort((left, right) =>
          (job.itemIndices.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (job.itemIndices.get(right.id) ?? Number.MAX_SAFE_INTEGER));
        const invalidateAnchor = droppedDeliveredNonMessages
          || Boolean(job.deliveredExecutableToolDone && (pending || persistenceError || job.interruptResponseId || verifiedStop))
          || Boolean((job.networkRetry || job.capacityRetry) && (job.protocolProgress?.completedReasoningItems ?? 0) > 0)
          || job.pendingLocalToolItems.size > 0
          || job.localAnchorUsed === true
          || job.startCallbackFailed === true
          || job.settlementFailed === true
          || Boolean(persistenceError)
          || isPermanentStructureRejection(diagnostics);
        if (invalidateAnchor) invalidateResponseIds(completed?.response?.id, job.publicResponseId, job.upstreamResponseId);
        setAnchor(!invalidateAnchor && fullInput ? { id: completed.response.id, input: fullInput, output: completed.response.output, local: true } : null);
        if (!job.settlementFailed) retryGate.clear(job.metadata);
        emit(type, { operationId: job.operationId, ...diagnostics, ...(invalidateAnchor ? { anchorInvalidated: true } : {}), ...fields });
        for (const outgoing of outgoingEvents) if (peer.readyState === webSocketOpen) { clientKeepalive.note(); peer.send(JSON.stringify(outgoing)); }
      };
      const receive = async (data, binary, prepared) => {
        if (peerClosed) return;
        if (active && data.byteLength > 4096) {
          sendError(peer, "NATIVE_WS_RESPONSE_ACTIVE", 400);
          peer.close(1008, "active control frame too large");
          return;
        }
        let admissionLease = null;
        if (!prepared && !active && !binary && reserveAdmissionBytes) {
          try { admissionLease = reserveAdmissionBytes({ bytes: data.byteLength }); }
          catch (error) {
            emit("native_ws_admission_buffer_rejected", { requestBytes: data.byteLength,
              code: error?.code ?? "NATIVE_WS_BUFFER_CAPACITY", requestTransmissionState: "not_sent", requestAccepted: false });
            closeFailedPeer(peer, error);
            return;
          }
        }
        let payload;
        try {
          if (binary) throw new Error();
          payload = prepared ? prepared.inspected.payload : JSON.parse(data.toString("utf8"));
        } catch { admissionLease?.release(); sendError(peer, "NATIVE_WS_INVALID_JSON", 400); peer.close(1008, "invalid request"); return; }
        if (payload?.type === "response.interrupt") {
          admissionLease?.release();
          const targetResponseId = typeof payload.response_id === "string" && payload.response_id.length > 0
            ? payload.response_id : null;
          if (targetResponseId && isSettledResponseInterrupt(payload, active?.publicResponseId, terminalResponseIds)) {
            emit("native_ws_interrupt", { operationId: null, activeRequestPresent: Boolean(active), accepted: true, reason: "already_terminal" });
            return;
          }
          const matchesActive = targetResponseId !== null && targetResponseId === active?.publicResponseId;
          const ordinaryNative = active?.ordinaryTurn && !active.httpFallback && !internalJob(active)
            && !active.released && !active.terminal;
          const waitingNative = ordinaryNative && active.waiting;
          const unrelatedControl = ordinaryNative && !matchesActive;
          if (waitingNative && matchesActive && payload.mode === "discard_partial_items") {
            const job = active;
            if (pendingReconciliation(job, false, true)) {
              finishNotice(job, null, unresolvedNativeNotice, job.fullInput, "native_ws_terminal_notice");
              job.request?.destroy();
              return;
            }
            const deliveredAll = [...job.deliveredItems];
            const output = deliveredAll.filter(([, item]) => item?.type === "message"
              || item?.type === "reasoning" && item.status === "completed")
              .sort(([left], [right]) => left - right).map(([, item]) => {
                const copy = structuredClone(item);
                if (copy.type === "message" && copy.status !== "completed") copy.status = "incomplete";
                return copy;
              });
            const droppedWaitingItems = output.length < deliveredAll.length || job.deliveredExecutableToolDone;
            const event = { type: "response.incomplete", sequence_number: ++job.clientSequence,
              response: { id: job.publicResponseId, status: "incomplete", incomplete_details: { reason: "interrupted" }, output } };
            job.terminal = true;
            job.interruptResponseId = targetResponseId;
            const settlementError = release(job, { kind: "interrupted", event });
            job.request?.destroy();
            job.request = null;
            emit("native_ws_interrupt", { operationId: job.operationId, accepted: !settlementError,
              reason: settlementError ? "settlement_failed" : "waiting_interrupted", targetResponseId });
            if (settlementError) { invalidateResponseIds(job.publicResponseId, job.upstreamResponseId); setAnchor(null); closeFailedPeer(peer, settlementError); return; }
            if (droppedWaitingItems) invalidateResponseIds(job.publicResponseId, job.upstreamResponseId);
            setAnchor(!droppedWaitingItems && job.fullInput ? { id: job.publicResponseId, input: job.fullInput, output, local: true } : null);
            if (peer.readyState === webSocketOpen) {
              peer.send(JSON.stringify(event), sendFailure => { if (sendFailure) peer.terminate(); });
            }
            return;
          }
          const responseId = matchesActive ? active.upstreamResponseId ?? targetResponseId : targetResponseId;
          const result = waitingNative && matchesActive ? { ok: false, code: "invalid_interrupt_mode" } : matchesActive
            ? (active?.httpFallback ? active.interruptHttp?.({ responseId, mode: payload.mode })
              : active?.request?.interrupt?.({ responseId, mode: payload.mode }))
            : { ok: false, code: "public_response_id_mismatch" };
          const accepted = result === true || result?.ok === true;
          if (accepted) {
            active.interruptResponseId = targetResponseId;
            active.preparationInterrupted = result?.code === "preparation_interrupted";
          }
          emit("native_ws_interrupt", { operationId: unrelatedControl ? null : active?.operationId ?? null, accepted,
            ...(unrelatedControl && targetResponseId ? { targetResponseId: targetResponseId.slice(0, 512) } : {}),
            reason: result?.code ?? (accepted ? "interrupt_sent" : "no_active_request") });
          if (!accepted && !unrelatedControl) {
            sendError(peer, "NATIVE_WS_INTERRUPT_MISMATCH", 400);
            if (!ordinaryNative && active?.waiting && !active.httpFallback) active.cancel();
          }
          return;
        }
        let sourceDocument = prepared?.sourceBased ? prepared.inspected.sourceDocument : null;
        if (payload?.type !== "response.create" || (sourceDocument ? sourceDocument.getNode(["input"])?.type !== "array" : !Array.isArray(payload.input)) || active) {
          admissionLease?.release();
          sendError(peer, active ? "NATIVE_WS_RESPONSE_ACTIVE" : "NATIVE_WS_INVALID_REQUEST", 400);
          peer.close(1008, "invalid request");
          return;
        }
        const job = { operationId: crypto.randomUUID(), request: null, response: null, terminal: false, released: false, resumeTimer: null,
          context: null, admissionLease, requestBytes: data.byteLength, deliveredExecutableToolDone: false, progressObserved: false, abort: new AbortController(),
          started: false, ended: false, waiting: false, attemptStarted: null, upstreamStarted: false,
          recoverySequence: 0, networkRetryNumber: 0, publicResponseId: null, upstreamResponseId: null,
          clientSequence: -1, createdDelivered: false, reasoningProgressObserved: false };
        job.prepared = prepared;
        if (prepared) ownedPreparations.add(prepared);
        job.httpFallback = prepared?.sourceBased === true;
        job.recovery = createStreamRecovery(job.operationId);
        job.reasoningProgress = createNativeReasoningProgressForwarder();
        job.deliveredItems = new Map();
        job.recordedNativeTools = new Map();
        job.itemIndices = new Map();
        job.protocolProgress = { completedReasoningItems: 0, reasoningFrames: 0, toolParameterBytes: 0, deliveredText: false };
        job.pendingLocalToolItems = new Set();
        job.generating = payload.generate !== false;
        job.cancel = ({ clearRetry = false, cancellationOrigin } = {}) => {
          job.clearRetry = clearRetry;
          release(job, { kind: "cancelled", cancellationOrigin }); job.request?.destroy(); peer.close(1000, "request closed");
        };
        jobs.add(job);
        active = job;
        clientKeepalive.start();
        try {
          const metadata = nativeResponseMetadata(payload, handshake);
          job.metadata = metadata;
          job.compacting = metadata.request_kind === "compaction" || Object.hasOwn(payload, "compaction_trigger")
            || (sourceDocument ? await sourceCompactionTrigger(sourceDocument) : payload.input.some(item => item?.type === "compaction_trigger"));
          job.internalRequest = connectionToken !== undefined || metadata.request_kind === "memory"
            || metadata.thread_source === "memory_consolidation" || metadata.turn_trigger === "memory_consolidation"
            || payload.client_metadata?.["x-openai-subagent"] === "memory_consolidation";
          if (sourceDocument && !rootSourcePayload(payload)) await registerRootSourcePayload(payload, sourceDocument);
          const localAnchor = anchor?.local === true && anchor.id === payload.previous_response_id;
          job.localAnchorUsed = localAnchor;
          const sourceAnchor = Boolean(anchor && typeof payload.previous_response_id === "string"
            && anchor.id === payload.previous_response_id && isRootInputProjection(anchor.input));
          if (sourceAnchor || sourceDocument && payload.previous_response_id && anchor?.id === payload.previous_response_id) {
            job.bodyPreparation = (async () => {
            if (!prepareBodySource) throw sourcePathError("ROOT_SOURCE_HISTORY_REQUIRES_HTTP");
            if (!sourceDocument) {
              job.admissionLease?.release(); job.admissionLease = null;
              const source = await collectBodySource(Readable.from([data]), { signal: job.abort.signal });
              try { prepared = await prepareBodySource({ source, request: handshake, signal: job.abort.signal, forceSourceInspection: true }); }
              finally { await source.release(); }
              job.prepared = prepared; ownedPreparations.add(prepared);
              sourceDocument = prepared.inspected.sourceDocument;
              payload = prepared.inspected.payload;
              if (!sourceDocument) throw sourcePathError("ROOT_SOURCE_HISTORY_REQUIRES_HTTP");
              if (!rootSourcePayload(payload)) await registerRootSourcePayload(payload, sourceDocument);
            }
            const combined = combineRootInputs(anchor.input, anchor.output, rootSourcePayload(payload).input);
            if (!combined) throw sourcePathError("ROOT_SOURCE_HISTORY_REQUIRES_HTTP");
            const expanded = await composeRootSourceBody(projectRootSourcePayload(payload, combined), { signal: job.abort.signal });
            try {
              await disposeNativePrepared(prepared);
              prepared = await prepareBodySource({ source: expanded, request: handshake, signal: job.abort.signal, forceSourceInspection: true });
            } finally { await expanded.release(); }
            job.prepared = prepared; ownedPreparations.add(prepared);
            sourceDocument = prepared.inspected.sourceDocument;
            payload = prepared.inspected.payload;
            if (!sourceDocument) throw sourcePathError("ROOT_SOURCE_HISTORY_REQUIRES_HTTP");
            if (!rootSourcePayload(payload)) await registerRootSourcePayload(payload, sourceDocument);
            job.httpFallback = true; job.requestBytes = prepared.requestBody.bytes;
            })();
            await job.bodyPreparation;
          }
          const sourcePreviousPresent = payload.previous_response_id !== undefined && payload.previous_response_id !== null;
          if (job.httpFallback && (!executeHttpAttempt || !job.generating
            || job.compacting && metadata.request_kind !== "compaction" || job.internalRequest || sourcePreviousPresent)) {
            if (job.internalRequest) throw sourcePathError("INTERNAL_MEMORY_DESCRIPTOR_INVALID");
            const error = sourcePathError(sourcePreviousPresent ? "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH" : "payload_too_large");
            error.httpStatus = sourcePreviousPresent ? 400 : 413;
            release(job, { kind: "failed", error }); closeFailedPeer(peer, error, 1008); return;
          }
          job.replayableSource = sourceDocument ? prepared : null;
          job.peer = peer;
          const headers = cleanHeaders(handshake.headers);
          headers["x-codex-turn-metadata"] = nativeResponseMetadataHeader(metadata);
          headers["openai-beta"] = "responses_websockets=2026-02-06";
          const fullInput = sourceDocument ? rootSourcePayload(payload).input : !payload.previous_response_id ? payload.input : anchor?.id === payload.previous_response_id
            ? [...anchor.input, ...anchor.output, ...payload.input] : null;
          job.fullInput = fullInput;
          job.storeRequested = payload.store === true;
          job.sawNonLocalSideEffect = false;
          job.ordinaryTurn = job.generating && !job.compacting && !job.internalRequest
            && (metadata.request_kind === undefined || metadata.request_kind === "turn")
            && typeof metadata.thread_id === "string" && metadata.thread_id.length > 0
            && typeof metadata.turn_id === "string" && metadata.turn_id.length > 0
            && (!threadId || threadId === metadata.thread_id);
          const replayPayload = sourceDocument ? payload : fullInput ? { ...payload, input: fullInput } : null;
          if (replayPayload) delete replayPayload.previous_response_id;
          job.admissionAttempt = admitRequest(job, () => onRequestStart({ sessionKey, operationId: job.operationId, metadata,
              payload: localAnchor && replayPayload ? replayPayload : payload, headers, bytes: data.byteLength,
               connectionToken, connectionId, requestPath: handshake.url, admissionLease: job.admissionLease, prepared }));
          job.context = await job.admissionAttempt;
          job.started = true;
          const authorizedExtract = job.context?.internalMemory?.kind === "extract";
          const binding = job.context?.internalMemory?.threadBindingKey ?? job.context?.internalMemory?.bindingKey ?? metadata.thread_id;
          if (typeof binding !== "string" || !binding || !authorizedExtract && !metadata.thread_id
            || !job.context?.internalMemoryPrewarm && threadId && threadId !== binding) {
            throw Object.assign(new Error("Native connection thread changed"), { code: "NATIVE_WS_THREAD_MISMATCH" });
          }
          if (!job.context?.internalMemoryPrewarm) threadId = binding;
          if (job.released) { settle(job); return; }
          if (typeof payload.previous_response_id === "string" && invalidatedResponseIds.has(payload.previous_response_id)) {
            const error = Object.assign(new Error("Previous response anchor was invalidated on this connection"), {
              code: "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH", httpStatus: 400,
              requestAccepted: false, operationAcceptance: "not_sent", requestTransmissionState: "not_sent",
            });
            release(job, { kind: "failed", error });
            closeFailedPeer(peer, error, 1008);
            return;
          }
          const startRequest = () => {
          job.waiting = false;
          job.nativeReconciliationEvidence = null;
          job.sawNonLocalSideEffect = false;
          if (job.released || peerClosed || peer.readyState !== webSocketOpen || job.abort.signal.aborted || isClosing?.()) { job.cancel(); return; }
          job.attemptStarted = performance.now();
          job.reasoningProgress.beginAttempt();
          job.upstreamStarted = true;
          let upstreamPayload = (job.capacityRetry || job.networkRetry || localAnchor) && replayPayload ? replayPayload : payload;
          if (!localAnchor && anchor && anchor.id === upstreamPayload.previous_response_id && typeof anchor.upstreamId === "string") {
            upstreamPayload = { ...upstreamPayload, previous_response_id: anchor.upstreamId };
          }
          const client = job.httpFallback ? { request() {
            const request = new PassThrough();
            job.interruptHttp ??= settings => {
              if (settings?.mode !== "discard_partial_items" || !job.publicResponseId
                || settings.responseId !== (job.upstreamResponseId ?? job.publicResponseId)) return { ok: false, code: "invalid_interrupt" };
              if (job.released || job.terminal) return { ok: false, code: "no_active_response" };
              if (job.httpInterruptQueued) return { ok: false, code: "duplicate_interrupt" };
              job.httpInterruptQueued = true;
              job.interruptResponseId = job.publicResponseId;
              queueMicrotask(() => {
                if (job.released) return;
                const output = [...job.deliveredItems].sort(([left], [right]) => left - right).map(([, item]) => {
                  const retained = structuredClone(item);
                  if (retained.type === "message" && retained.status !== "completed") retained.status = "incomplete";
                  return retained;
                });
                const event = { type: "response.incomplete", sequence_number: ++job.clientSequence,
                  response: { id: job.publicResponseId, status: "incomplete", incomplete_details: { reason: "interrupted" }, output } };
                job.terminal = true;
                const error = release(job, { kind: "interrupted", event, userRequested: true });
                job.request?.destroy();
                const invalidateHttpInterruptAnchor = Boolean(error || job.outcome?.requiresReconciliation
                  || job.deliveredExecutableToolDone || job.localAnchorUsed);
                emit("native_http_interrupted", { operationId: job.operationId, responseId: job.publicResponseId,
                  reason: "user_interrupt", userRequested: true, settlementState: error ? "unknown" : "settled",
                  ...(invalidateHttpInterruptAnchor ? { anchorInvalidated: true } : {}) });
                if (error) { invalidateResponseIds(job.publicResponseId, job.upstreamResponseId); setAnchor(null); closeFailedPeer(peer, error); return; }
                if (invalidateHttpInterruptAnchor) invalidateResponseIds(job.publicResponseId, job.upstreamResponseId);
                setAnchor(!invalidateHttpInterruptAnchor && job.fullInput ? { id: job.publicResponseId, input: job.fullInput, output, local: true } : null);
                if (peer.readyState === webSocketOpen) { clientKeepalive.note(); peer.send(JSON.stringify(event)); }
              });
              return { ok: true, code: "interrupt_queued" };
            };
            request.interrupt = job.interruptHttp;
            request.once("finish", () => {
              const response = new PassThrough();
              response.headersSent = false;
              response.writeHead = () => { response.headersSent = true; };
              response.flushHeaders = noop;
              request.emit("response", response);
              job.httpOutcome = null;
              job.readHttpTransmissionState = null;
              job.httpAttemptNumber = (job.httpAttemptNumber ?? 0) + 1;
              job.httpAttempt = Promise.resolve().then(() => executeHttpAttempt({ context: job.context, operationId: job.operationId,
                metadata, payload: replayPayload, prepared: job.prepared, headers, requestPath: handshake.url, signal: job.abort.signal,
                downstream: response, isTerminal: () => job.released && job.outcome?.kind === "completed", attemptNumber: job.httpAttemptNumber,
                observeDirectHttpTransmission: read => {
                  if (!job.released && job.request === request) job.readHttpTransmissionState = read;
                } }))
                .then(outcome => {
                  if (job.released || job.request !== request) return;
                  job.httpOutcome = outcome;
                  job.readHttpTransmissionState = null;
                  if (outcome.kind === "completed") return;
                  response.destroy();
                  if (outcome.kind === "cancelled") { job.cancel(); return; }
                  fail(job, { code: outcome.reason,
                    httpStatus: job.compacting ? (Number.isInteger(outcome.httpStatus) && outcome.httpStatus >= 400
                      ? outcome.httpStatus : outcome.kind === "usage_limit" ? 429 : undefined) : outcome.httpStatus,
                    ...(job.compacting && outcome.upstreamError ? { upstreamError: outcome.upstreamError } : {}),
                    requestAccepted: outcome.policy?.acceptance, operationAcceptance: outcome.policy?.acceptance,
                    requestTransmissionState: outcome.requestTransmissionState, upstreamFailureSignals: outcome.failure });
                }).catch(error => {
                  if (job.released || job.request !== request) return;
                  response.destroy();
                  job.httpOutcome = { kind: "failed", localRejection: error.localRequestFailure === true,
                    requestTransmissionState: error.requestTransmissionState ?? "unknown",
                    policy: classifyModelFailure({ source: "local", code: error.code, requestAccepted: error.requestAccepted,
                      requestTransmissionState: error.requestTransmissionState, progressObserved: job.progressObserved,
                      toolDelivered: job.deliveredExecutableToolDone }) };
                  job.readHttpTransmissionState = null;
                  fail(job, error);
                });
            });
            return request;
          } } : createRequestClient({ nativeWebSocket: true, sessionKey, operationId: job.operationId,
            atomicUntilVisibleOutput: true,
            allowInterruptedContextRebuild: managedRecovery && job.ordinaryTurn,
            reasoningProgressBudget: job.reasoningProgress.budget,
            recoveryResponseId: (job.networkRetry || job.capacityRetry) && (job.createdDelivered || job.reasoningProgressObserved)
              && !job.progressObserved && !job.deliveredExecutableToolDone ? job.upstreamResponseId : undefined,
            turnId: metadata.turn_id || `prewarm:${connectionId}`, payload: upstreamPayload, fullInput, url: upstreamUrl, headers,
            retryWithoutOutput: job.capacityRetry === true || job.networkRetry === true,
            onPacketSending, onPreparationProgress, onUploadProgress });
          const request = client.request(upstreamUrl, { headers });
          job.request = request;
          request.on("error", error => { if (job.request === request && !job.waiting) fail(job, error); });
          request.on("interruptError", error => { if (job.request === request && !job.waiting) fail(job, error); });
          request.on("response", response => {
            if (job.released || job.request !== request || job.waiting) { response.resume(); return; }
            job.response = response;
            const decoder = new StringDecoder("utf8");
            let buffer = "";
            const read = chunk => {
              if (peerClosed || job.released || job.request !== request || job.waiting) return;
              buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
              if (Buffer.byteLength(buffer) > maxEventBytes) return fail(job, { code: "NATIVE_WS_EVENT_LIMIT" });
              for (;;) {
                const delimiter = /\r?\n\r?\n/u.exec(buffer);
                if (!delimiter) break;
                const eventText = buffer.slice(0, delimiter.index).split(/\r?\n/u)
                  .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                buffer = buffer.slice(delimiter.index + delimiter[0].length);
                if (!eventText || eventText === "[DONE]") continue;
                let event;
                try { event = JSON.parse(eventText); } catch { return fail(job, { code: "NATIVE_WS_INVALID_EVENT" }); }
                try { event = job.reasoningProgress.forward(event); }
                catch (error) { fail(job, error); return; }
                if (!event) continue;
                const rawResponseId = event.response?.id ?? event.response_id;
                const observedUpstreamId = typeof rawResponseId === "string" && rawResponseId ? rawResponseId : job.upstreamResponseId;
                const observedIncomplete = !job.httpFallback && isKnownIncompleteResponse(event, observedUpstreamId);
                const observedFailed = !job.httpFallback && event.type === "response.failed"
                  && typeof observedUpstreamId === "string" && event.response?.id === observedUpstreamId
                  && event.response.status === "failed" && Array.isArray(event.response.output);
                event = mapClientResponse(job, event);
                const executableDone = event.type === "response.output_item.done" && executableNativeTools.has(event.item?.type);
                const toolFingerprint = executableDone ? recordedNativeToolFingerprint(event.item) : null;
                if (executableDone && !toolFingerprint) {
                  job.unrecordedExecutableTool = true;
                  job.pendingLocalToolItems.delete(event.output_index ?? "unindexed");
                  continue;
                }
                const reasoningProgress = isNativeReasoningProgressEvent(event);
                const recoveryEvent = reasoningProgress && event.item
                  ? { ...event, item: { type: "reasoning", id: event.item.id } } : event;
                try { job.recovery.observe(recoveryEvent); }
                catch (error) { fail(job, error); return; }
                if (!reasoningProgress && typeof event.item?.id === "string" && Number.isSafeInteger(event.output_index)) job.itemIndices.set(event.item.id, event.output_index);
                if (event.item?.type === "reasoning" || /^response\.reasoning_/u.test(event.type ?? "")) {
                  job.protocolProgress.reasoningFrames = Math.min(Number.MAX_SAFE_INTEGER, job.protocolProgress.reasoningFrames + 1);
                  if (event.type === "response.output_item.done" && event.item?.type === "reasoning") {
                    job.protocolProgress.completedReasoningItems = Math.min(Number.MAX_SAFE_INTEGER, job.protocolProgress.completedReasoningItems + 1);
                  }
                }
                if (event.type === "response.output_item.added" && ["function_call", "custom_tool_call"].includes(event.item?.type)) {
                  if (job.pendingLocalToolItems.size < 1024) job.pendingLocalToolItems.add(event.output_index ?? "unindexed");
                }
                if (/^response\.(?:function_call_arguments|custom_tool_call_input)\.delta$/u.test(event.type ?? "") && typeof event.delta === "string") {
                  job.protocolProgress.toolParameterBytes = Math.min(Number.MAX_SAFE_INTEGER,
                    job.protocolProgress.toolParameterBytes + Buffer.byteLength(event.delta));
                }
                if (event.type === "response.function_call_arguments.done" && typeof event.arguments === "string" && event.arguments.length
                  || event.type === "response.custom_tool_call_input.done" && typeof event.input === "string" && event.input.length) {
                  const doneParam = event.type === "response.function_call_arguments.done" ? event.arguments : event.input;
                  job.protocolProgress.toolParameterBytes = Math.min(Number.MAX_SAFE_INTEGER,
                    job.protocolProgress.toolParameterBytes + Buffer.byteLength(doneParam));
                }
                if (isNonLocalSideEffectEvent(event)) job.sawNonLocalSideEffect = true;
                if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta.length) {
                  job.protocolProgress.deliveredText = true;
                }
                if (!terminalEvent(event) && nativeEventCommitsOutput(event)) {
                  job.progressObserved = true;
                  job.protocolProgress.firstVisibleEventType ??= typeof event.type === "string" ? event.type.slice(0, 96) : "unknown";
                }
                if (reasoningProgress) job.reasoningProgressObserved = true;
                if ((job.progressObserved || reasoningProgress) && job.recoveryPhase === "retrying") recoveryState(job, "resumed");
                if (executableDone) {
                  try {
                    if (onToolDone({ context: job.context, item: event.item }) === true) {
                      job.recordedNativeTools.set(event.item.id, toolFingerprint);
                    } else job.unrecordedExecutableTool = true;
                  }
                  catch (error) { return fail(job, error); }
                  job.deliveredExecutableToolDone = true;
                  job.pendingLocalToolItems.delete(event.output_index ?? "unindexed");
                }
                if (terminalEvent(event)) {
                  if (observedFailed) job.nativeFailedTerminal = event;
                  const acknowledgedInterrupt = event.type === "response.incomplete"
                    && typeof job.interruptResponseId === "string" && event.response?.id === job.interruptResponseId
                    && event.response?.status === "incomplete" && event.response?.incomplete_details?.reason === "interrupted"
                    && Array.isArray(event.response.output) && !event.error && !event.response.error;
                  let recordedCapacity = false;
                  let terminalOperation = null;
                  try { terminalOperation = getOperation(job.operationId); } catch {}
                  if (!acknowledgedInterrupt && replayPayload && payload.generate !== false && !job.progressObserved && !job.deliveredExecutableToolDone
                    && !job.httpFallback && !job.interruptResponseId && nativeWsCapacityFailure(event) && replayAllowed(terminalOperation, job)) {
                    const recorded = retryGate.record({ metadata, error: event, elapsedMs: performance.now() - job.attemptStarted });
                    recordedCapacity = Boolean(recorded);
                    if (recorded?.exhausted && !job.compacting) {
                      finishNotice(job, event, capacityNotice, fullInput, "native_ws_capacity_exhausted", { attemptNumber: recorded.capacityAttempts });
                      return;
                    }
                    if (recorded && !recorded.exhausted) {
                      if (managedRecovery && job.ordinaryTurn && !internalJob(job)) {
                        const upstreamError = event.response?.error ?? event.error ?? {};
                        fail(job, { code: upstreamError.code ?? upstreamError.type ?? "NATIVE_WS_UPSTREAM_ERROR",
                          httpStatus: nativeWsHttpStatus(event) ?? nativeWsHttpStatus(upstreamError) ?? nativeWsHttpStatus(event.response),
                          upstreamError, upstreamFailureSignals: event },
                        { operation: terminalOperation, event, attemptNumber: recorded.capacityAttempts });
                        return;
                      }
                      job.capacityRetry = true;
                      job.waiting = true;
                      emit("native_ws_capacity_retry_wait_started", { operationId: job.operationId, attemptNumber: recorded.capacityAttempts });
                      retryGate.wait({ metadata, signal: job.abort.signal }).then(() => {
                        if (job.released || peerClosed) return;
                        emit("native_ws_capacity_retry_wait_finished", { operationId: job.operationId, attemptNumber: recorded.capacityAttempts });
                        try {
                          if (!replayAllowed(getOperation(job.operationId), job)) {
                            finishNotice(job, event, nativeFailureNotice(event), fullInput, "native_ws_terminal_notice");
                            job.request?.destroy();
                            return;
                          }
                          startRequest();
                        } catch (error) { fail(job, error); }
                      }).catch(error => {
                        if (job.released) return;
                        if (error.code === "NATIVE_WS_RETRY_CANCELLED") job.cancel(); else fail(job, error);
                      });
                      return;
                    }
                  }
                  if (observedIncomplete && job.generating && !job.compacting && !internalJob(job)) {
                    job.nativeIncompleteTerminal = event;
                    const reason = event.response.incomplete_details.reason;
                    finishNotice(job, event, reason === "content_filter" ? "本次输出因内容过滤停止，已保留此前收到的内容。"
                      : "本次输出达到长度上限，已保留此前收到的内容。", fullInput, "native_ws_confirmed_incomplete", { reason });
                    return;
                  }
                  if (!acknowledgedInterrupt && !observedIncomplete && event.type !== "response.completed" && job.generating && !job.compacting) {
                    const category = classifyModelFailure({ source: "sse", message: event }).category;
                    if (["temporary", "acceptance_unknown"].includes(category) && (!nativeWsCapacityFailure(event)
                      || job.progressObserved || job.deliveredExecutableToolDone)) {
                      const upstreamError = event.response?.error ?? event.error ?? {};
                      fail(job, { code: upstreamError.code ?? upstreamError.type ?? "NATIVE_WS_UPSTREAM_ERROR",
                        httpStatus: nativeWsHttpStatus(event) ?? nativeWsHttpStatus(upstreamError) ?? nativeWsHttpStatus(event.response),
                        upstreamError, upstreamFailureSignals: event });
                      return;
                    }
                    finishNotice(job, event, nativeFailureNotice(event), fullInput,
                      category === "quota" ? "native_ws_quota_stopped" : "native_ws_terminal_notice", { category });
                    return;
                  }
                  if (!acknowledgedInterrupt && !observedIncomplete && event.type !== "response.completed"
                    && job.generating && job.compacting && managedRecovery && !internalJob(job) && !job.httpFallback
                    && !job.progressObserved && !job.deliveredExecutableToolDone && !job.interruptResponseId
                    && terminalOperation?.retryableWithoutDelivery === true) {
                    const category = classifyModelFailure({ source: "sse", message: event }).category;
                    if (["temporary", "acceptance_unknown"].includes(category) && !nativeWsCapacityFailure(event)) {
                      const upstreamError = event.response?.error ?? event.error ?? {};
                      fail(job, { code: upstreamError.code ?? upstreamError.type ?? "NATIVE_WS_UPSTREAM_ERROR",
                        httpStatus: nativeWsHttpStatus(event) ?? nativeWsHttpStatus(upstreamError) ?? nativeWsHttpStatus(event.response),
                        upstreamError, upstreamFailureSignals: event });
                      return;
                    }
                  }
                  job.terminal = true;
                  if ((event.type === "response.completed" || acknowledgedInterrupt) && fullInput
                    && typeof event.response?.id === "string" && Array.isArray(event.response.output)) {
                    const outputCallIds = new Set(event.response.output.map(item => item?.call_id).filter(Boolean));
                    const missingDeliveredTool = acknowledgedInterrupt && [...job.deliveredItems.values()].some(
                      item => ["function_call", "custom_tool_call", "local_shell_call", "computer_call", "mcp_call", "tool_search_call"].includes(item?.type)
                        && typeof item.call_id === "string" && !outputCallIds.has(item.call_id));
                    if (missingDeliveredTool) invalidateResponseIds(event.response.id, job.publicResponseId, job.upstreamResponseId);
                    setAnchor(missingDeliveredTool ? null : { id: event.response.id, upstreamId: job.upstreamResponseId, input: fullInput, output: event.response.output,
                      ...(job.preparationInterrupted || job.httpFallback ? { local: true } : {}) });
                  }
                  if (!acknowledgedInterrupt && event.type !== "response.completed" && !recordedCapacity) {
                    retryGate.record({ metadata: job.metadata, error: event, elapsedMs: performance.now() - job.attemptStarted });
                  }
                  if (!acknowledgedInterrupt && event.type !== "response.completed") {
                    emit("native_ws_failure_diagnostic", { operationId: job.operationId,
                      ...nativeWsFailureDiagnostics(job, event, terminalOperation) });
                  }
                  const error = release(job, { kind: acknowledgedInterrupt ? "interrupted" : event.type === "response.completed" ? "completed" : "failed", event,
                    ...(acknowledgedInterrupt || observedIncomplete ? { confirmedUpstreamTerminal: true } : {}),
                    ...(acknowledgedInterrupt ? { userRequested: true } : {}) });
                  if (error) {
                    if (job.ordinaryTurn && !internalJob(job)) {
                      finishNotice(job, null, "本次请求的结束状态保存失败，请核对已有输出后再继续。", fullInput,
                        "native_ws_terminal_notice", { code: error.code ?? "NATIVE_WS_STATE_WRITE_FAILED", settlementState: "unknown" }, error);
                    } else closeFailedPeer(peer, error);
                    return;
                  }
                }
                if (peer.readyState === webSocketOpen) {
                  if (event.type === "response.created" && job.createdDelivered) continue;
                  if (event.type === "response.created") job.createdDelivered = true;
                  job.recovery.markDelivered(event);
                  if (event.type === "response.output_item.added" && event.item?.type === "message") {
                    job.deliveredItems.set(event.output_index ?? 0, structuredClone(event.item));
                  }
                  if (event.type === "response.content_part.added") {
                    const item = job.deliveredItems.get(event.output_index ?? 0);
                    if (item?.type === "message") { item.content ??= []; item.content[event.content_index ?? 0] = structuredClone(event.part); }
                  }
                  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                    const index = event.output_index ?? 0;
                    if (!job.deliveredItems.has(index)) job.deliveredItems.set(index, { type: "message", role: "assistant",
                      id: event.item_id ?? `msg_partial_${job.operationId.replaceAll("-", "")}`, status: "in_progress", content: [] });
                    const item = job.deliveredItems.get(index);
                    if (item.type === "message") {
                      item.content ??= [];
                      item.content[event.content_index ?? 0] ??= { type: "output_text", text: "" };
                      item.content[event.content_index ?? 0].text += event.delta;
                    }
                  }
                  if (event.type === "response.output_item.done" && !reasoningProgress) job.deliveredItems.set(event.output_index ?? 0, structuredClone(event.item));
                  clientKeepalive.note();
                  peer.send(JSON.stringify(event), error => { if (error) peer.terminate(); });
                }
                if (!job.released && peer.bufferedAmount > maxEventBytes) {
                  response.pause();
                  job.resumeTimer ??= setInterval(() => {
                    if (peer.readyState !== webSocketOpen) return;
                    if (peer.bufferedAmount < maxEventBytes / 2) { clearInterval(job.resumeTimer); job.resumeTimer = null; response.resume(); }
                  }, 20);
                  job.resumeTimer.unref?.();
                }
              }
            };
            response.on("data", read);
            response.on("error", error => { if (job.request === request && !job.waiting) fail(job, error); });
            response.once("end", () => { if (!job.terminal && !job.waiting && job.request === request) fail(job, { code: "NATIVE_WS_MISSING_TERMINAL" }); });
          });
          emit(job.httpFallback ? "native_http_request_started" : "native_ws_request_started", { operationId: job.operationId, inputItems: sourceDocument ? sourceDocument.getNode(["input"]).count : payload.input.length,
            bytes: data.byteLength, incremental: Boolean(payload.previous_response_id), prewarm: payload.generate === false });
          request.end();
          };
          job.startRequest = startRequest;
          job.waiting = true;
          const previousWaiters = retryGate.status().waiters;
          const pending = retryGate.wait({ metadata, signal: job.abort.signal });
          const waiting = retryGate.status().waiters > previousWaiters;
          if (waiting) emit("native_ws_retry_wait_started", { operationId: job.operationId });
          pending.then(() => {
            if (waiting) emit("native_ws_retry_wait_finished", { operationId: job.operationId });
            startRequest();
          }).catch(error => {
            job.waiting = false;
            if (waiting) emit("native_ws_retry_wait_finished", { operationId: job.operationId, cancelled: true });
            if (!job.released) {
              try {
                if (error?.code === "NATIVE_WS_RETRY_CANCELLED") job.cancel();
                else fail(job, error);
              } catch {
                release(job, { kind: "cancelled" });
                try { job.request?.destroy(); } catch {}
                peer.terminate();
              }
            }
          });
        } catch (error) { fail(job, error); }
      };
      const preparing = new Set();
      let sourcePreparation = null;
      peer.on("message", (data, binary) => {
        if (sourcePreparation) sourcePreparation.then(() => receive(data, binary)).catch(error => closeFailedPeer(peer, error));
        else void receive(data, binary);
      });
      peer.on(NATIVE_WS_BODY_SOURCE, (source, binary) => {
        if (preparing.size || active || peerClosed || binary) { closeFailedPeer(peer, sourcePathError("NATIVE_WS_RESPONSE_ACTIVE")); return; }
        clientKeepalive.start();
        const reference = source.retain();
        const controller = new AbortController();
        preparing.add(controller);
        let prepared;
        const preparation = Promise.resolve().then(async () => {
          if (peerClosed || binary) throw sourcePathError("NATIVE_WS_INVALID_JSON");
          if (active) throw sourcePathError("NATIVE_WS_RESPONSE_ACTIVE");
          if (prepareBodySource) {
            prepared = await prepareBodySource({ source: reference, request: handshake, signal: controller.signal,
              forceSourceInspection: reference.bytes > (maxPayload ?? 192 * 1024 * 1024) });
            const data = prepared.sourceBased ? { byteLength: reference.bytes } : prepared.requestBody.body;
            await receive(data, false, prepared);
          } else {
            const data = await reference.readAllBounded(maxPayload ?? 192 * 1024 * 1024, { signal: controller.signal });
            await receive(data, false);
          }
        }).catch(error => { if (!peerClosed) closeFailedPeer(peer, error); }).finally(async () => {
          preparing.delete(controller);
          if (prepared && !ownedPreparations.has(prepared)) releasePrepared(prepared);
          await reference.release();
          if (sourcePreparation === preparation) sourcePreparation = null;
          if (!active) clientKeepalive.stop();
        });
        sourcePreparation = preparation;
        sourceCleanups.add(preparation);
        preparation.catch(noop).finally(() => sourceCleanups.delete(preparation));
      });
      peer.once("close", () => {
        peerClosed = true;
        setAnchor(null);
        for (const controller of preparing) controller.abort();
        clientKeepalive.stop();
        const job = active;
        if (job) { job.request?.destroy(); release(job, { kind: "cancelled", cancellationOrigin: "downstream_connection" }); }
        try { onConnectionClosed({ connectionToken, connectionId }); } catch {}
        releaseSession(sessionKey);
      });
    },
  });
  return { ...endpoint, status: () => ({ ...endpoint.status(), activeRequests: jobs.size, retry: retryGate.status(),
    admissionWaitingBytes, maxAdmissionWaitingBytes }),
    recoveryStates: () => [...jobs].filter(job => job.recoveryWait).map(job => ({ ...job.recoveryWait })),
    async close() {
      retryGate.close();
      for (const job of [...jobs]) job.cancel({ cancellationOrigin: "service_shutdown" });
      await endpoint.close();
      while (sourceCleanups.size) await Promise.allSettled([...sourceCleanups]);
    },
    cancelTurn({ threadId, turnId }) {
      const matching = [...jobs].filter(job => job.metadata?.thread_id === threadId && job.metadata?.turn_id === turnId);
      for (const job of matching) job.cancel({ clearRetry: true, cancellationOrigin: "native_turn" });
      for (const kind of ["turn", "compaction"]) retryGate.clear({ thread_id: threadId, turn_id: turnId, request_kind: kind });
      return matching.length > 0;
    },
  };
}

export function attachNativeResponsesRelay({ server, acquire, isClosing, onEvent = noop, maxPayload, maxConnections, keepaliveIntervalMs }) {
  const rootAdmissionProtocol = Object.freeze({ version: 1, localStream: frames => frames });
  const sourceCleanups = new Set();
  const endpoint = attachEndpoint({ server, isClosing, maxPayload, maxConnections, onEvent,
    onConnection(peer, handshake) {
      const connectionId = nativeConnectionIds.get(peer) ?? crypto.randomUUID();
      const clientKeepalive = createNativeClientKeepalive(peer, keepaliveIntervalMs);
      let upstream = null;
      let upstreamUrl = null;
      let active = null;
      let closed = false;
      let failed = false;
      let terminalErrorForwarded = false;
      let resumeTimer = null;
      let lastLease = null;
      let idleTerminal = false;
      let activityRevision = 0;
      let checkingReclaim = false;
      let reclaimAbort = null;
      const highWaterBytes = Math.min(maxPayload ?? 192 * 1024 * 1024, 1024 * 1024);
      const completedIds = new Set();
      const reclaimProtectedToolTypes = new Set(["function_call", "custom_tool_call", "local_shell_call", "computer_call", "mcp_call", "tool_search_call"]);
      const releaseLease = job => {
        if (!job?.lease || job.leaseReleased) return;
        job.leaseReleased = true;
        try {
          job.leaseCleanup = Promise.resolve(job.lease.release?.(job.terminalEvidence));
          sourceCleanups.add(job.leaseCleanup);
          job.leaseCleanup.catch(error => { try { onEvent({ type: "native_ws_lease_release_failed", connectionId, reason: error?.code ?? "release_failed" }); } catch {} })
            .finally(() => sourceCleanups.delete(job.leaseCleanup));
        }
        catch { try { onEvent({ type: "native_ws_lease_release_failed", connectionId, reason: "release_failed" }); } catch {} }
      };
      const release = job => {
        if (!job) return;
        clientKeepalive.stop();
        job.released = true;
        try { releaseLease(job); } finally { if (active === job) active = null; }
        if (closed || failed) job.abort?.abort();
        if (job.bodySource && !job.sourceCleanup) {
          job.sourceCleanup = Promise.allSettled([job.sendPromise, job.acquisition]).then(async () => {
            releaseLease(job);
            await Promise.allSettled([job.leaseCleanup]);
            try { await job.sourceDocument?.release(); }
            finally { await job.bodySource.release(); }
          });
          sourceCleanups.add(job.sourceCleanup);
          job.sourceCleanup.catch(error => { try { onEvent({ type: "native_ws_source_cleanup_failed", code: error?.code }); } catch {} })
            .finally(() => sourceCleanups.delete(job.sourceCleanup));
        }
      };
      const finishOrdinaryFailure = terminal => {
        const job = active;
        if (!job || closed || isClosing?.() || peer.readyState !== webSocketOpen) return false;
        let completion;
        try { completion = job.lease?.finishOrdinaryFailure?.(job.recovery, terminal); } catch { return false; }
        if (!completion) return false;
        for (const event of completion.events) {
          const responseId = event.response?.id ?? event.response_id;
          if (event.type === "response.completed") {
            completedIds.add(responseId);
            if (completedIds.size > 128) completedIds.delete(completedIds.values().next().value);
            idleTerminal = job.deliveredTool !== true;
          }
          clientKeepalive.note();
          peer.send(JSON.stringify(event), error => { if (error) peer.terminate(); });
        }
        const socket = upstream;
        upstream = null;
        upstreamUrl = null;
        if (socket) {
          socket.removeAllListeners("message"); socket.removeAllListeners("close"); socket.removeAllListeners("error");
          socket.on("error", noop);
          socket.terminate();
        }
        clearInterval(resumeTimer); resumeTimer = null;
        release(job);
        try { onEvent({ type: "root_model_response_finished", connectionId, acceptance: "unknown", replayed: false,
          anchored: completion.anchored }); } catch {}
        if (completion.closeModelConnection) peer.close(1000, "root-response-context-refresh");
        return true;
      };
      const fail = (error, code = error?.code === "NATIVE_WS_WORKER_CHANGED" ? 1012 : 1011) => {
        if (closed || failed) return;
        if (finishOrdinaryFailure()) return;
        failed = true;
        clientKeepalive.stop();
        clearInterval(resumeTimer);
        resumeTimer = null;
        try { onEvent({ type: "native_ws_relay_failed", connectionId, code: error?.code ?? "NATIVE_WS_RELAY_FAILED" }); } catch {}
        release(active);
        reclaimAbort?.abort();
        closeFailedPeer(peer, error, code);
        upstream?.terminate();
      };
      const open = lease => new Promise((resolve, reject) => {
        if (upstream?.readyState === webSocketOpen && upstreamUrl === lease.url) return resolve(upstream);
        if (upstream) return reject(Object.assign(new Error("Worker changed"), { code: "NATIVE_WS_WORKER_CHANGED",
          requestAccepted: false, requestTransmissionState: "not_sent" }));
        const target = new URL(lease.url);
        if (target.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)) return reject(new Error("Invalid worker endpoint"));
        upstreamUrl = lease.url;
        const { WebSocket } = require("ws");
        upstream = new WebSocket(lease.url, { headers: cleanHeaders(lease.headers ?? handshake.headers, true),
          perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10000, maxPayload: maxPayload ?? 192 * 1024 * 1024 });
        const closeAfterForwardedError = code => {
          failed = true;
          clientKeepalive.stop();
          clearInterval(resumeTimer);
          resumeTimer = null;
          reclaimAbort?.abort();
          try { onEvent({ type: "native_ws_relay_failed", connectionId, code }); } catch {}
          nativeConnectionCloseReasons.set(peer, "failed");
          const closeTimer = setTimeout(() => { if (peer.readyState !== 3) peer.terminate(); }, 1000);
          closeTimer.unref?.();
          peer.once("close", () => clearTimeout(closeTimer));
          try { peer.close(1011, "model connection must reconnect"); } catch { clearTimeout(closeTimer); if (peer.readyState !== 3) peer.terminate(); }
          upstream?.terminate();
        };
        upstream.once("open", () => resolve(upstream));
        upstream.once("error", reject);
        upstream.on("error", error => {
          if (closed || failed) return;
          if (!active && terminalErrorForwarded) { closeAfterForwardedError(error?.code ?? "NATIVE_WS_WORKER_CLOSED"); return; }
          fail(error);
        });
        upstream.on("unexpected-response", (_request, response) => { response.resume(); reject(Object.assign(new Error("Worker rejected WebSocket"), { code: "NATIVE_WS_WORKER_UNAVAILABLE" })); });
        upstream.on("close", () => {
          if (closed || failed) return;
          if (!active && terminalErrorForwarded) { closeAfterForwardedError("NATIVE_WS_WORKER_CLOSED"); return; }
          fail({ code: "NATIVE_WS_WORKER_CLOSED" });
        });
        upstream.on("message", (data, binary) => {
          if (closed || failed) return;
          activityRevision += 1;
          reclaimAbort?.abort();
          let event;
          try { event = JSON.parse(data.toString("utf8")); } catch { fail({ code: "NATIVE_WS_INVALID_EVENT" }); return; }
          if (event.type === "ping" && Object.keys(event).length === 1 && !clientKeepalive.due()) return;
          const responseId = event.response?.id ?? event.response_id;
          if (typeof responseId === "string" && completedIds.has(responseId)) return;
          if (event.type === "response.created" && active) active.responseId = responseId;
          if (active) {
            try { active.recovery.observe(event); } catch (error) { fail(error); return; }
            if (["error", "response.failed", "response.incomplete"].includes(event.type) && finishOrdinaryFailure(event)) return;
          }
          if (active && ["response.output_item.added", "response.output_item.done"].includes(event.type)
            && reclaimProtectedToolTypes.has(event.item?.type)) active.deliveredTool = true;
          if (terminalEvent(event)) {
            if (active?.responseId && responseId && active.responseId !== responseId) { fail({ code: "NATIVE_WS_RESPONSE_MISMATCH" }); return; }
            if (typeof responseId === "string") {
              completedIds.add(responseId);
              if (completedIds.size > 128) completedIds.delete(completedIds.values().next().value);
            }
            if (active) idleTerminal = event.type === "response.completed" && event.response?.status === "completed"
              && Array.isArray(event.response.output)
              && active.deliveredTool !== true
              && event.response.output.every(item => ["message", "reasoning", "compaction"].includes(item?.type));
            if (active && idleTerminal) active.terminalEvidence = Object.freeze({ connectionId, responseId,
              completedWithoutTools: true });
            release(active);
          }
          if (peer.readyState === webSocketOpen) {
            clientKeepalive.note();
            if (event.type === "error") terminalErrorForwarded = true;
            else if (event.type === "response.created" || event.type === "response.completed") terminalErrorForwarded = false;
            peer.send(data, { binary }, error => { if (error) peer.terminate(); });
            if (active) { active.recovery.markDelivered(event); active.lease?.markDelivered?.(event); }
          }
          if (peer.bufferedAmount > highWaterBytes && !resumeTimer) {
            upstream.pause();
            resumeTimer = setInterval(() => {
              if (closed || failed || peer.readyState !== webSocketOpen || upstream.readyState !== webSocketOpen) {
                clearInterval(resumeTimer); resumeTimer = null;
                return;
              }
              if (peer.bufferedAmount < highWaterBytes / 2) {
                clearInterval(resumeTimer); resumeTimer = null;
                upstream.resume();
              }
            }, 20);
            resumeTimer.unref?.();
          }
        });
      });
      const receive = async (data, binary, sourceState) => {
        if (closed || failed) return;
        activityRevision += 1;
        reclaimAbort?.abort();
        let payload;
        try { if (binary) throw new Error(); payload = sourceState ? sourceState.payload : JSON.parse(data.toString("utf8")); }
        catch { fail({ code: "NATIVE_WS_INVALID_JSON" }, 1008); return; }
        if (payload?.type === "response.interrupt") {
          if (isSettledResponseInterrupt(payload, active?.responseId, completedIds)) {
            try { onEvent({ type: "native_ws_interrupt", connectionId, operationId: null,
              activeRequestPresent: Boolean(active), accepted: true, reason: "already_terminal" }); } catch {}
            return;
          }
          if (!active || upstream?.readyState !== webSocketOpen) { fail({ code: "NATIVE_WS_INTERRUPT_MISMATCH" }, 1008); return; }
          upstream.send(data, { binary: false }, error => { if (error) fail(error); });
          return;
        }
        if (payload?.type !== "response.create" || (sourceState ? sourceState.document.getNode(["input"])?.type !== "array" : !Array.isArray(payload.input)) || active) { fail({ code: "NATIVE_WS_INVALID_REQUEST" }, 1008); return; }
        const job = { lease: null, released: false, deliveredTool: false, recovery: createStreamRecovery(`root_${crypto.randomUUID()}`),
          abort: new AbortController() };
        if (sourceState) {
          sourceState.claimed = true;
          job.bodySource = sourceState.source;
          job.sourceDocument = sourceState.document;
        }
        active = job;
        terminalErrorForwarded = false;
        clientKeepalive.start();
        idleTerminal = false;
        try {
          job.acquisition = Promise.resolve().then(() => acquire({ payload, request: handshake, connectionId, rootAdmissionProtocol,
            ...(sourceState ? { bodySource: job.bodySource } : {}) }));
          job.lease = await job.acquisition;
          if (job.lease.tracksClientDelivery) job.recovery.enableClientDelivery();
          if (closed || job.released) { releaseLease(job); return; }
          lastLease = job.lease;
          if (job.lease.kind === "root_local_response" && job.lease.protocol === rootAdmissionProtocol) {
            for (const event of job.lease.events) {
              if (closed || job.released || isClosing?.() || peer.readyState !== webSocketOpen) { release(job); return; }
              job.lease.validate();
              const responseId = event.response?.id ?? event.response_id;
              if (event.type === "response.created") job.responseId = responseId;
              if (event.type === "response.completed") {
                completedIds.add(responseId);
                if (completedIds.size > 128) completedIds.delete(completedIds.values().next().value);
                idleTerminal = true;
                job.terminalEvidence = Object.freeze({ connectionId, responseId, completedWithoutTools: true });
              }
              clientKeepalive.note();
              peer.send(JSON.stringify(event), error => { if (error) peer.terminate(); });
            }
            release(job);
            if (job.lease.closeModelConnection) peer.close(1000, "root-response-context-refresh");
            return;
          }
          const socket = await open(job.lease);
          if (closed || job.released) return;
          job.lease?.validate?.();
          const registered = rootSourcePayload(job.lease.payload);
          if (sourceState || registered) {
            job.forwarding = (async () => {
              let onward;
              try {
                onward = sourceState && (!job.lease.payload || job.lease.payload === payload) ? job.bodySource
                  : await rewriteNativeRelaySource(sourceState?.document ?? registered.document,
                    payload, job.lease.payload, job.abort.signal);
                job.lease.beforeWorkerWrite?.();
                job.sendPromise = sendSource(socket, onward, { signal: job.abort.signal });
                await job.sendPromise;
              } finally { if (onward && onward !== job.bodySource) await onward.release(); }
            })();
            sourceCleanups.add(job.forwarding);
            job.forwarding.catch(noop).finally(() => sourceCleanups.delete(job.forwarding));
            await job.forwarding;
          } else {
            const onward = job.lease.payload ? JSON.stringify(job.lease.payload) : data;
            job.lease.beforeWorkerWrite?.();
            socket.send(onward, { binary: false }, error => { if (error) fail(error); });
          }
        } catch (error) { if (!job.released) fail(error); }
      };
      let sourcePreparation = null;
      peer.on("message", (data, binary) => {
        if (sourcePreparation) sourcePreparation.then(() => receive(data, binary)).catch(error => fail(error));
        else void receive(data, binary);
      });
      peer.on(NATIVE_WS_BODY_SOURCE, (source, binary) => {
        if (closed || failed || active || sourcePreparation || binary) { fail({ code: "NATIVE_WS_INVALID_REQUEST" }, 1008); return; }
        clientKeepalive.start();
        const reference = source.retain();
        const controller = new AbortController();
        const onClose = () => controller.abort();
        peer.once("close", onClose);
        let state;
        const preparation = Promise.resolve().then(async () => {
          state = { ...await inspectNativeRelaySource(reference, controller.signal), source: reference, claimed: false };
          await receive(null, false, state);
        }).catch(error => fail(error)).finally(async () => {
          peer.off("close", onClose);
          if (state?.claimed !== true) {
            try { await state?.document?.release(); }
            finally { await reference.release(); }
          }
          if (sourcePreparation === preparation) sourcePreparation = null;
          if (!active) clientKeepalive.stop();
        });
        sourcePreparation = preparation;
        sourceCleanups.add(preparation);
        preparation.catch(noop).finally(() => sourceCleanups.delete(preparation));
      });
      peer.once("close", () => {
        clientKeepalive.stop();
        closed = true; reclaimAbort?.abort(); clearInterval(resumeTimer); resumeTimer = null; release(active); upstream?.terminate();
      });
      const idle = () => !closed && !failed && !active && idleTerminal && peer.readyState === webSocketOpen && peer.bufferedAmount === 0
        && typeof lastLease?.canReclaimConnection === "function";
      return {
        canReclaim: () => !checkingReclaim && idle(),
        async reclaimIfIdle({ stillRequired, timeoutMs = 1000 }) {
          if (checkingReclaim || !idle()) return false;
          checkingReclaim = true;
          const lease = lastLease;
          const revision = activityRevision;
          const abort = new AbortController();
          reclaimAbort = abort;
          let timer;
          try {
            const proof = await Promise.race([
              Promise.resolve().then(() => lease.canReclaimConnection({ connectionId, signal: abort.signal })),
              new Promise(resolve => { timer = setTimeout(() => { abort.abort(); resolve(false); }, Math.max(1, Math.min(1000, timeoutMs))); }),
            ]);
            if ((proof !== true && typeof proof?.validate !== "function") || abort.signal.aborted || !idle() || lease !== lastLease
              || revision !== activityRevision || !stillRequired()) return false;
            if (proof !== true && proof.validate() !== true) return false;
            nativeConnectionCloseReasons.set(peer, "authority_idle");
            const stopped = new Promise(resolve => peer.once("close", resolve));
            closed = true;
            clientKeepalive.stop();
            const closeTimer = setTimeout(() => peer.terminate(), Math.max(1, Math.min(1000, timeoutMs)));
            try {
              peer.close(1000, "idle capacity reclaim");
              await stopped;
            } finally { clearTimeout(closeTimer); }
            return true;
          } catch { return false; }
          finally {
            clearTimeout(timer); abort.abort(); if (reclaimAbort === abort) reclaimAbort = null; checkingReclaim = false;
          }
        },
      };
    },
  });
  return { ...endpoint, anchorFixVersion: 1,
    status: () => ({ ...endpoint.status(), anchorFixVersion: 1 }),
    async close() { await endpoint.close(); while (sourceCleanups.size) await Promise.allSettled([...sourceCleanups]); } };
}
