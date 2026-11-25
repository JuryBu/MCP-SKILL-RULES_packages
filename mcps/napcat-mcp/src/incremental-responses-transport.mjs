import { createHash } from "node:crypto";
import { normalizeLocalNoticePayload } from "./local-notice-normalization.mjs";
import { normalizeInputItemMetadataForComparison } from "./model-input-comparison.mjs";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { classifyModelFailure, createModelFailureTerminalEvidence } from "./model-failure-policy.mjs";
import { MAX_UPLOAD_ALLOWANCE_MS } from "./request-wait-budget.mjs";
import { createReasoningProgressTracker, createReasoningProgressBudget, DEFAULT_RESPONSES_SESSION_BYTES,
  isNativeReasoningProgressEvent } from "./reasoning-progress.mjs";

const require = createRequire(import.meta.url);
const websocketFragmentBytes = 64 * 1024;
const websocketAcknowledgementBytes = 256 * 1024;
const websocketAcknowledgementTimeoutMs = 30000;
const websocketMaxUploadWindow = 4;
const websocketUploadQueueBudgetMs = 8000;
const assistantOutputProofBytes = 128;
const ignoredFields = new Set(["input", "previous_response_id", "generate", "stream", "background", "stream_id", "type"]);
const noop = () => {};
const byteLength = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const canonical = value => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
});
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

function canonicalInput(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return canonical(item);
  const comparable = normalizeInputItemMetadataForComparison(item);
  return canonical(comparable);
}

function completeAssistantOutput(item) {
  return item?.type === "message" && item.role === "assistant" && item.status === "completed"
    && typeof item.id === "string" && item.id.length > 0 && Array.isArray(item.content) && item.content.length > 0
    && item.content.every(part => part?.type === "output_text" && typeof part.text === "string"
      || part?.type === "refusal" && typeof part.refusal === "string");
}

function cachedInputMatches(session, cached, incoming, binding) {
  if (canonicalInput(cached) === canonicalInput(incoming)) return true;
  const proof = session.confirmedAssistantOutput;
  if (session.binding !== binding || session.socket?.readyState !== 1 || proof?.generation !== session.generation
    || !completeAssistantOutput(cached) || !proof.items.has(cached)
    || !incoming || typeof incoming !== "object" || Array.isArray(incoming) || Object.hasOwn(incoming, "id")) return false;
  const { id: upstreamId, ...completeMessage } = cached;
  return isDeepStrictEqual(normalizeInputItemMetadataForComparison(completeMessage),
    normalizeInputItemMetadataForComparison(incoming));
}

function cacheConfiguration(config, includeRequestAnnotations = false, nativeWebSocket = false) {
  const stableConfig = { ...config };
  delete stableConfig.service_tier;
  if (config.reasoning && typeof config.reasoning === "object" && !Array.isArray(config.reasoning)) {
    const stableReasoning = { ...config.reasoning };
    delete stableReasoning.effort;
    if (["auto", "concise", "detailed"].includes(stableReasoning.summary)) delete stableReasoning.summary;
    if (Object.keys(stableReasoning).length) stableConfig.reasoning = stableReasoning;
    else delete stableConfig.reasoning;
  }
  if (config.stream_options && typeof config.stream_options === "object" && !Array.isArray(config.stream_options)) {
    const stableStreamOptions = { ...config.stream_options };
    if (stableStreamOptions.reasoning_summary_delivery === "sequential_cutoff") delete stableStreamOptions.reasoning_summary_delivery;
    if (Object.keys(stableStreamOptions).length) stableConfig.stream_options = stableStreamOptions;
    else delete stableConfig.stream_options;
  }
  const metadata = config.client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return stableConfig;
  const stableMetadata = { ...metadata };
  if (nativeWebSocket && typeof stableMetadata["x-codex-ws-stream-request-start-ms"] === "string"
    && /^\d+$/.test(stableMetadata["x-codex-ws-stream-request-start-ms"])) delete stableMetadata["x-codex-ws-stream-request-start-ms"];
  for (const key of ["turn_id", "root_turn_id", "parent_turn_id", "turn_started_at_unix_ms"]) delete stableMetadata[key];
  const rawTurnMetadata = stableMetadata["x-codex-turn-metadata"];
  if (typeof rawTurnMetadata === "string"
    || rawTurnMetadata && typeof rawTurnMetadata === "object" && !Array.isArray(rawTurnMetadata)) {
    try {
      const turnMetadata = typeof rawTurnMetadata === "string" ? JSON.parse(rawTurnMetadata) : rawTurnMetadata;
      if (turnMetadata && typeof turnMetadata === "object" && !Array.isArray(turnMetadata)) {
        stableMetadata["x-codex-turn-metadata"] = includeRequestAnnotations ? turnMetadata
          : Object.fromEntries(["session_id", "thread_id", "window_id"].filter(key => Object.hasOwn(turnMetadata, key))
            .map(key => [key, turnMetadata[key]]));
      }
    } catch {}
  }
  return { ...stableConfig, client_metadata: stableMetadata };
}

const diagnosticMetadataKeys = new Set(["client_metadata", "x-codex-turn-metadata", "thread_id", "sandbox_mode", "approval_policy",
  "window_id", "window_number", "context_window_id", "history_initialization", "request_kind", "agent_id", "agent_name",
  "root", "turn_trigger", "sandbox", "auto_review_enabled", "node_repl", "client_type", "source"]);
const diagnosticCloseCategories = new Map([[1000, "normal"], [1001, "going_away"], [1002, "protocol_error"],
  [1003, "unsupported_data"], [1005, "no_status"], [1006, "abnormal"], [1007, "invalid_payload"], [1008, "policy"],
  [1009, "message_too_large"], [1010, "extension_required"], [1011, "server_error"], [1012, "service_restart"],
  [1013, "try_again_later"], [1014, "bad_gateway"], [1015, "tls_failure"]]);

function metadataDiagnostic(config) {
  let remaining = 64;
  function capture(value, present, path, depth) {
    remaining -= 1;
    const type = !present ? "absent" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const node = { path, present, type, fingerprint: value === undefined ? null : digest(value) };
    if (value && typeof value === "object") {
      const keys = Object.keys(value).sort();
      if (depth >= 4 || keys.length > remaining) node.truncated = true;
      else {
        node.children = new Map();
        for (const [index, key] of keys.entries()) {
          if (remaining < 1) {
            node.children = null;
            node.truncated = true;
            break;
          }
          const segment = Array.isArray(value) ? `[${key}]` : `.${diagnosticMetadataKeys.has(key) ? key : `<key:${index + 1}>`}`;
          node.children.set(digest(key), capture(value[key], true, `${path}${segment}`.slice(0, 192), depth + 1));
        }
      }
    }
    return node;
  }
  return capture(config.client_metadata, Object.hasOwn(config, "client_metadata"), "client_metadata", 0);
}

function changedMetadataPaths(before, after, includeKeyTag = false) {
  const changes = [];
  function compare(previous, incoming, keyTag) {
    if (changes.length >= 12 || (previous?.present === incoming?.present && previous?.type === incoming?.type
      && previous?.fingerprint === incoming?.fingerprint)) return;
    if (previous?.children && incoming?.children && previous.type === incoming.type) {
      for (const key of new Set([...previous.children.keys(), ...incoming.children.keys()])) {
        compare(previous.children.get(key), incoming.children.get(key), key.slice(0, 16));
        if (changes.length >= 12) break;
      }
    } else changes.push({ path: incoming?.path ?? previous.path,
      before: previous?.type ?? "absent", after: incoming?.type ?? "absent",
      beforePresent: previous?.present ?? false, afterPresent: incoming?.present ?? false,
      truncated: Boolean(previous?.truncated || incoming?.truncated), ...(includeKeyTag && keyTag ? { keyTag } : {}) });
  }
  if (before) compare(before, after);
  return changes;
}

function containsImage(value) {
  if (!value || typeof value !== "object") return false;
  if (["input_image", "image_url", "image"].includes(value.type) || "image_url" in value) return true;
  return Object.values(value).some(entry => Array.isArray(entry) ? entry.some(containsImage) : containsImage(entry));
}

function limit(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new RangeError("Invalid transport resource limit");
  return result;
}

function mergeHeaders(...sources) {
  const headers = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      const oldKey = Object.keys(headers).find(existing => existing.toLowerCase() === key.toLowerCase());
      if (oldKey) delete headers[oldKey];
      headers[key] = value;
    }
  }
  for (const key of Object.keys(headers)) {
    if (["host", "content-length", "content-encoding", "content-type", "expect", "connection", "upgrade", "transfer-encoding", "sec-websocket-key", "sec-websocket-version"].includes(key.toLowerCase())) delete headers[key];
  }
  return headers;
}

function isNativeCompaction(payload, headers) {
  const raw = payload.client_metadata?.["x-codex-turn-metadata"]
    ?? Object.entries(headers).find(([name]) => name.toLowerCase() === "x-codex-turn-metadata")?.[1];
  let metadata = raw;
  if (typeof raw === "string") {
    try { metadata = JSON.parse(raw); } catch { return false; }
  }
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.request_kind === "compaction";
}

function atomicGroups(input) {
  const calls = new Map();
  const ends = new Map();
  for (const [index, item] of input.entries()) {
    if (typeof item?.call_id !== "string") continue;
    if (["function_call", "custom_tool_call"].includes(item.type)) calls.set(item.call_id, index);
    if (["function_call_output", "custom_tool_call_output"].includes(item.type) && calls.has(item.call_id)) {
      ends.set(calls.get(item.call_id), index);
    }
  }
  const groups = [];
  for (let start = 0; start < input.length;) {
    let end = ends.get(start) ?? start;
    for (let cursor = start; cursor <= end; cursor += 1) end = Math.max(end, ends.get(cursor) ?? cursor);
    groups.push(input.slice(start, end + 1));
    start = end + 1;
  }
  return groups;
}

function errorStatusValues(event) {
  return [event?.status, event?.status_code, event?.httpStatus, event?.http_status,
    event?.error?.status, event?.error?.status_code, event?.error?.httpStatus, event?.error?.http_status,
    event?.response?.error?.status, event?.response?.error?.status_code,
    event?.response?.error?.httpStatus, event?.response?.error?.http_status];
}

function errorStatuses(event) {
  return errorStatusValues(event).map(value => typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value)
    .filter(value => Number.isInteger(value) && value >= 100 && value <= 599);
}

function errorStatus(event) {
  return errorStatuses(event)[0];
}

function isBusinessProgress(event) {
  if (["response.output_text.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta", "response.custom_tool_call_input.delta", "response.refusal.delta",
    "response.output_audio.delta", "response.output_audio_transcript.delta", "response.mcp_call_arguments.delta"].includes(event.type)) {
    return typeof event.delta === "string" && event.delta.length > 0;
  }
  if (["response.output_item.added", "response.output_item.done"].includes(event.type)) {
    return ["function_call", "custom_tool_call", "web_search_call", "file_search_call", "code_interpreter_call", "mcp_call"].includes(event.item?.type);
  }
  const completedField = {
    "response.output_text.done": "text", "response.reasoning_text.done": "text",
    "response.reasoning_summary_text.done": "text", "response.function_call_arguments.done": "arguments",
    "response.custom_tool_call_input.done": "input", "response.mcp_call_arguments.done": "arguments",
    "response.refusal.done": "refusal",
  }[event.type];
  if (completedField) return typeof event[completedField] === "string" && event[completedField].length > 0;
  if (["response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.content_part.added", "response.content_part.done"].includes(event.type)) {
    return ["text", "refusal"].some(key => typeof event.part?.[key] === "string" && event.part[key].length > 0);
  }
  return /^response\.(?:web_search_call|file_search_call|code_interpreter_call|mcp_call|image_generation_call)\.(?:in_progress|searching|interpreting|generating|partial_image|completed)$/.test(event.type);
}

function itemHasOutput(item) {
  if (!item || typeof item !== "object") return false;
  if (!["message", "reasoning"].includes(item.type)) return true;
  if (typeof item.encrypted_content === "string" && item.encrypted_content.trim()) return true;
  return [item.content, item.summary].some(parts => Array.isArray(parts) && parts.some(part =>
    ["text", "refusal", "audio", "data"].some(key => typeof part?.[key] === "string" && part[key].length > 0)));
}

function eventHasOutput(event) {
  if (isBusinessProgress(event) || itemHasOutput(event.item)) return true;
  const output = event.response?.output;
  return output !== undefined && (!Array.isArray(output) || output.some(itemHasOutput));
}

function operationRequiresReconciliation(record) {
  return Boolean(record && record.state !== "completed" && (record.recoveryReconciliationRequired === true
    || !record.safeToEvict && record.acceptance !== false
      && record.terminalOutcome !== "failed_no_output"));
}

function canRetryOperation(record, retryWithoutOutput = false) {
  return Boolean(record && !record.safeToEvict && !record.permanentRejection && !record.visibleOutputCommitted
    && !operationRequiresReconciliation(record)
    && (record.acceptance === false || record.terminalOutcome === "failed_no_output" && record.retryableWithoutOutput === true
      || retryWithoutOutput && (record.retryableWithoutOutput === true
        || record.atomicUntilVisibleOutput && record.retryableWithoutDelivery === true))
    && ["failed", "cancelled"].includes(record.state));
}

function protocolControlEvent(event) {
  if (typeof event?.type !== "string" || eventHasOutput(event)) return false;
  return ["ping", "pong", "keepalive", "keep_alive", "heartbeat", "proxy.keepalive"].includes(event.type)
    || event.type.startsWith("codex.")
    || /(?:^|\.)(?:metadata|rate_limits?)$/.test(event.type);
}

function reasoningAnchorEvent(event) {
  if (protocolControlEvent(event)) return true;
  if (event.item !== undefined && event.item?.type !== "reasoning") return false;
  if (event.response?.output !== undefined && (!Array.isArray(event.response.output)
    || event.response.output.some(item => item?.type !== "reasoning"))) return false;
  if (["response.created", "response.in_progress", "response.completed", "response.incomplete"].includes(event.type)) return true;
  if (["response.output_item.added", "response.output_item.done"].includes(event.type)) return event.item?.type === "reasoning";
  return /^response\.(?:reasoning_text|reasoning_summary_text)\.(?:delta|done)$/.test(event.type)
    || /^response\.reasoning_summary_part\.(?:added|done)$/.test(event.type);
}

function deferrableNativeOutput(event) {
  if (isNativeReasoningProgressEvent(event)
    || /^response\.(?:function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(event.type)) return true;
  if (["response.output_item.added", "response.output_item.done"].includes(event.type)) {
    if (event.type.endsWith(".added") && ["function_call", "custom_tool_call"].includes(event.item?.type)) return true;
    return event.item?.type === "message" && !itemHasOutput(event.item);
  }
  if (["response.content_part.added", "response.content_part.done"].includes(event.type)) {
    return event.part?.type === "output_text" && !event.part.text;
  }
  return event.type === "response.output_text.delta" && event.delta === ""
    || event.type === "response.output_text.done" && event.text === "";
}

export function nativeEventCommitsOutput(event) {
  if (isNativeReasoningProgressEvent(event)) return false;
  if (["response.created", "response.in_progress", "response.queued"].includes(event.type)) {
    const output = event.response?.output;
    if (output === undefined) return false;
    if (!Array.isArray(output)) return true;
    return output.some(item => item?.type !== "reasoning" && itemHasOutput(item));
  }
  if (protocolControlEvent(event)) return false;
  return !deferrableNativeOutput(event);
}

function discardableInterruptEvent(event) {
  if (reasoningAnchorEvent(event)) return true;
  if (event.type === "response.output_item.added") return ["message", "function_call", "custom_tool_call"].includes(event.item?.type);
  if (/^response\.(?:output_text|refusal|function_call_arguments|custom_tool_call_input)\.(?:delta|done)$/.test(event.type)) return true;
  return ["response.content_part.added", "response.content_part.done"].includes(event.type)
    && ["output_text", "refusal"].includes(event.part?.type);
}

const interruptedHistoryControlTypes = new Set(["ping", "pong", "keepalive", "keep_alive", "heartbeat", "proxy.keepalive",
  "metadata", "codex.metadata", "rate_limits", "rate_limits.updated", "codex.rate_limits"]);

export function createIncrementalResponsesTransport(options = {}) {
  const maxSessions = limit(options.maxSessions, 32);
  const maxSessionBytes = limit(options.maxSessionBytes, DEFAULT_RESPONSES_SESSION_BYTES);
  const maxMessageBytes = limit(options.maxMessageBytes, 1024 * 1024);
  const interruptiblePrewarmBytes = Math.min(maxMessageBytes, limit(options.interruptiblePrewarmBytes, 1024 * 1024));
  const maxOperations = limit(options.maxOperations, 4096);
  const maxPreviousResponseIdBytes = limit(options.maxPreviousResponseIdBytes, 128);
  const connectTimeoutMs = limit(options.connectTimeoutMs, 15000);
  const responseTimeoutMs = limit(options.responseTimeoutMs, 120000);
  const compactionAttemptTimeoutMs = Math.min(600000, limit(options.compactionAttemptTimeoutMs, 600000));
  const prewarmTimeoutMs = limit(options.prewarmTimeoutMs, responseTimeoutMs);
  const warmHandoffGraceMs = limit(options.warmHandoffGraceMs, 2500);
  const interruptTimeoutMs = limit(options.interruptTimeoutMs, 2500);
  const interruptHandoffTimeoutMs = limit(options.interruptHandoffTimeoutMs, Math.min(responseTimeoutMs, 30000));
  const responseHighWaterMark = limit(options.responseHighWaterMark, 16384);
  const uploadAcknowledgementTimeoutMs = Math.min(websocketAcknowledgementTimeoutMs,
    limit(options.uploadAcknowledgementTimeoutMs, websocketAcknowledgementTimeoutMs));
  const allowImagePrewarm = options.allowImagePrewarm === true;
  const now = options.now ?? Date.now;
  const connectionLifetimeMs = 60 * 60000;
  const connectionFullInputRotationMs = 40 * 60000;
  const connectionRotationMs = 45 * 60000;
  const connectionSafetyMs = 2 * 60000;
  const connectionGenerationBudgetMs = Math.max(10 * 60000, responseTimeoutMs);
  const connectionUploadBytesPerSecond = Math.min(31250, limit(options.connectionUploadBytesPerSecond, 31250));
  const createWebSocket = options.createWebSocket ?? ((url, socketOptions) => {
    const WebSocket = require("ws");
    return new WebSocket(url, socketOptions);
  });
  const sessions = new Map();
  const operations = new Map();
  const pendingJobs = new Set();
  const stoppedTurns = new Map();
  let closed = false;
  let nextGeneration = 0;

  function metadata(record) {
    if (!record) return null;
    return {
      state: record.state,
      acceptance: record.acceptance,
      reasonCode: record.reasonCode,
      requestTransmissionState: record.requestTransmissionState,
      phase: record.phase,
      generation: record.generation,
      ...(record.connectionOpenedAt !== undefined ? { connectionOpenedAt: record.connectionOpenedAt } : {}),
      ...(record.connectionRotation ? { connectionRotation: { ...record.connectionRotation } } : {}),
      ...(record.interruptState ? { interruptState: record.interruptState } : {}),
      ...(record.interruptDiagnostics ? { interruptDiagnostics: { ...record.interruptDiagnostics } } : {}),
      ...(record.nativePreviousResponseMismatch ? { nativePreviousResponseMismatch: { ...record.nativePreviousResponseMismatch } } : {}),
      ...(record.retryableWithoutDelivery ? { retryableWithoutDelivery: true } : {}),
      direction: record.direction,
      closeCode: record.closeCode,
      wsErrorCode: record.wsErrorCode,
      attempt: record.attempt,
      prewarmCompatibilityFallback: record.prewarmCompatibilityFailure === true && record.httpFallbackEligible === true,
      canRetry: !record.permanentRejection && !record.visibleOutputCommitted && !operationRequiresReconciliation(record)
        && (record.acceptance === false || record.terminalOutcome === "failed_no_output" && record.retryableWithoutOutput === true
        || record.retryableWithoutDelivery === true)
        && ["failed", "cancelled"].includes(record.state),
      requiresReconciliation: operationRequiresReconciliation(record),
      ...(record.terminalOutcome ? { terminalOutcome: record.terminalOutcome } : {}),
      ...(record.fallbackCompletion ? { fallbackCompletion: { ...record.fallbackCompletion } } : {}),
    };
  }

  function transportError(code, record, httpStatus) {
    const error = new Error(`WebSocket request failed (${code})`);
    Object.defineProperty(error, "nativeTransportAttempt", {
      value: Object.freeze({ operationId: record.operationId, ...metadata(record) }),
    });
    error.code = code;
    error.requestAccepted = record.acceptance;
    error.requestTransmissionState = record.requestTransmissionState;
    if (record.terminalOutcome) error.terminalOutcome = record.terminalOutcome;
    if (record.terminalEvidence) error.terminalEvidence = record.terminalEvidence;
    error.transport = "websocket";
    if (record.pendingAdmissionError) Object.assign(error, record.pendingAdmissionError);
    for (const key of ["direction", "closeCode", "wsErrorCode", "upstreamError", "upstreamFailureSignals", "localRejection", "previousFailure", "responseIdentityConflict"]) {
      if (record[key] !== undefined) error[key] = record[key];
    }
    if (record.upstreamFailureSignals) error.cause = record.upstreamFailureSignals;
    if (record.prewarmCompatibilityBlocked) {
      error.compatibilityFallbackBlocked = true;
      error.originalUpstreamError = record.upstreamError;
      error.upstreamError = { type: "transport_compatibility_guard", code: "invalid_request_error",
        message: "Prewarm compatibility fallback was not approved by the transport." };
      error.upstreamFailureSignals = error.upstreamError;
      error.cause = error.upstreamError;
    }
    if (httpStatus !== undefined) error.httpStatus = httpStatus;
    return error;
  }

  function bufferedBytes(session) {
    let bytes = 0;
    for (const response of session.streams) bytes += response.readableLength + response.writableLength;
    return bytes;
  }

  function retainedBytes(session) {
    const progressBudgets = new Set([session.active, ...session.queue, ...session.receiving]
      .map(job => job?.progressBudget).filter(Boolean));
    return session.cacheBytes + session.queue.reduce((sum, job) => sum + job.bytes, 0)
      + [...session.receiving].reduce((sum, job) => sum + job.bytes, 0)
      + (session.active?.bytes ?? 0) + (session.active?.deferredOutputBytes ?? 0) + session.wireBytes + bufferedBytes(session)
      + (session.confirmedAssistantOutput?.count ?? 0) * assistantOutputProofBytes
      + (session.idleContinuationProof ? byteLength(session.idleContinuationProof) : 0)
      + [...progressBudgets].reduce((sum, budget) => sum + budget.retainedBytes, 0);
  }

  function resetConnection(session, reason, details) {
    const idleContinuationProof = !session.active && (session.previousComplete || session.idleContinuationProof?.kind === "interrupted") && session.previousId
      && session.completedIds.has(session.previousId) && session.idleContinuationProof?.responseId === session.previousId
      ? session.idleContinuationProof : null;
    session.lastResetReason = reason;
    session.lastResetAt = new Date().toISOString();
    session.lastResetWasIdle = !session.active;
    const closeCode = details?.closeCode;
    session.lastResetCloseCode = Number.isInteger(closeCode) && closeCode >= 1000 && closeCode <= 4999 ? closeCode : null;
    session.lastResetCloseCategory = session.lastResetCloseCode === null ? null
      : diagnosticCloseCategories.get(closeCode) ?? (closeCode >= 4000 ? "application" : closeCode >= 3000 ? "registered" : "other");
    const socket = session.socket;
    session.socket = null;
    session.connecting = null;
    session.connectionState = "disconnected";
    session.connectedAt = null;
    session.prefix = [];
    session.previousId = null;
    session.previousComplete = false;
    session.cancelledReasoningAnchor = null;
    session.confirmedAssistantOutput = null;
    session.nativeCompletedConfigHash = null;
    session.cacheBytes = 0;
    session.wireBytes = 0;
    session.completedIds.clear();
    session.idleContinuationProof = idleContinuationProof;
    clearTimeout(session.connectTimer);
    session.connectTimer = null;
    const reject = session.connectReject;
    session.connectReject = null;
    reject?.(new Error("Connection invalidated"));
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", noop);
      const retiringJob = session.active;
      if (retiringJob && !retiringJob.generationEverStarted && !retiringJob.outputObserved) socket.once("close", () => {
        retiringJob.socketClosureConfirmed = true;
        if (retiringJob.record.prewarmOnlyCancelled) retiringJob.record.safeToEvict = true;
      });
      socket.terminate();
    }
  }

  function connectionAgeDecision(session, job, fullInput, necessaryFullInput, uploadInput) {
    if (session.socket?.readyState !== 1 || session.connectedAt === null || session.binding !== job.binding) return null;
    const connectionAgeMs = Math.max(0, now() - session.connectedAt);
    const fullInputBytes = byteLength({ ...job.payload, input: fullInput, previous_response_id: undefined });
    const uploadPlan = planPackets(job, uploadInput, necessaryFullInput ? undefined : session.previousId);
    if (uploadPlan.error) return null;
    const plannedUploadBytes = uploadPlan.wireBytes;
    const uploadBytesPerSecond = Math.min(options.connectionUploadBytesPerSecond === undefined ? Infinity : connectionUploadBytesPerSecond,
      session.minimumUploadBytesPerSecond === null ? connectionUploadBytesPerSecond : session.minimumUploadBytesPerSecond / 2);
    const uploadBudgetMs = Math.ceil(plannedUploadBytes / uploadBytesPerSecond * 1000);
    const generationBudgetMs = Math.max(connectionGenerationBudgetMs, session.longestGenerationMs ?? 0);
    const rotationTrigger = connectionAgeMs >= connectionRotationMs ? "maximum_connection_age"
      : necessaryFullInput && connectionAgeMs >= connectionFullInputRotationMs ? "necessary_full_input"
        : connectionAgeMs + uploadBudgetMs + generationBudgetMs + connectionSafetyMs >= connectionLifetimeMs
          ? "remaining_lifetime_budget" : null;
    return rotationTrigger ? { reason: "connection_age_rotation", rotationTrigger, connectionAgeMs,
      connectionOpenedAt: session.connectedAt, previousGeneration: session.generation, fullInputBytes,
      plannedUploadBytes, plannedUploadItems: uploadInput.length, plannedUploadPackets: uploadPlan.plan.length, necessaryFullInput,
      uploadBytesPerSecond, uploadBudgetMs, generationBudgetMs, safetyMs: connectionSafetyMs } : null;
  }

  function rotateConnection(session, job, decision) {
    resetConnection(session, "connection_age_rotation");
    session.lastResetWasIdle = true;
    job.record.connectionRotation = decision;
    job.cacheDecision = { ...job.cacheDecision, previousReason: job.cacheDecision?.reason, ...decision };
    try { options.onEvent?.({ type: "connection_age_rotation", sessionKey: session.key,
      operationId: job.operationId, ...decision }); } catch {}
  }

  function releaseJob(job) {
    if (job.released) return;
    job.released = true;
    job.fragmentCleanup?.();
    clearTimeout(job.timer);
    clearTimeout(job.compactionTimer);
    clearTimeout(job.requestTimer);
    clearTimeout(job.drainTimer);
    job.signal?.removeEventListener("abort", job.onAbort);
    job.payload = null;
    job.fullInput = null;
    job.headers = null;
    job.config = null;
    job.agent = null;
    job.url = null;
    job.groups = null;
    job.groupBytes = null;
    job.plan = null;
    job.onPreparationProgress = null;
    job.onPacketSending = null;
    job.onUploadProgress = null;
    job.observeReasoningProgress = null;
    job.packet = null;
    job.warmConsumer = null;
    job.interruptHandoffConsumer = null;
    job.bytes = 0;
    job.deferredOutput = null;
    job.deferredOutputBytes = 0;
    pendingJobs.delete(job);
  }

  function settle(job, code, httpStatus, cancelled = false, publish) {
    if (job.settled) return;
    const publication = !job.draining ? publish?.() : undefined;
    cancelled ||= job.record.downstreamCancelled === true;
    job.settled = true;
    job.settledAt = performance.now();
    if (cancelled) job.cancelledAt ??= job.settledAt;
    job.record.state = code ? (cancelled ? "cancelled" : "failed") : "completed";
    job.record.reasonCode = code ?? (job.record.terminalOutcome === "interrupted" ? "response_interrupted" : "response_completed");
    if (job.atomicUntilVisibleOutput) job.record.visibleOutputCommitted = job.visibleOutputCommitted;
    const failurePolicy = code ? classifyModelFailure({
      source: "transport", statusCode: httpStatus, code, requestAccepted: job.record.acceptance,
      message: job.record.upstreamFailureSignals ?? job.record.upstreamError,
      requestTransmissionState: job.record.requestTransmissionState,
      progressObserved: job.outputObserved === true, terminalEvidence: job.record.terminalEvidence, cancelled,
    }) : null;
    job.record.retryableWithoutOutput = Boolean(code && !job.record.localRejection && !job.outputObserved && !job.visibleOutputCommitted
      && (job.record.acceptance === false || job.record.terminalOutcome === "failed_no_output")
      && (cancelled && code === "ABORT_ERR" || failurePolicy?.retryable));
    job.record.retryableWithoutDelivery = Boolean(code && !cancelled && !job.record.localRejection
      && job.atomicUntilVisibleOutput && !job.visibleOutputCommitted
      && (job.record.safeToEvict || job.record.acceptance === false || job.record.terminalOutcome === "failed_no_output")
      && classifyModelFailure({ source: "transport", statusCode: httpStatus, code,
        requestAccepted: job.record.acceptance, message: job.record.upstreamFailureSignals ?? job.record.upstreamError,
        requestTransmissionState: job.record.requestTransmissionState, progressObserved: false,
        terminalEvidence: job.record.terminalEvidence }).retryable);
    if (job.record.retryableWithoutDelivery) {
      job.record.discardedOutputBytes = job.deferredOutputBytes;
    }
    job.record.httpFallbackEligible = Boolean(code && !job.nativeWebSocket && !cancelled && !job.record.localRejection && !job.outputObserved
      && !job.record.prewarmCompatibilityBlocked
      && (recordedPrewarmCompatibility(job) || failurePolicy?.httpCompatibilityFallback || ["payload_too_large", "transport_capacity"].includes(failurePolicy?.category)));
    if (cancelled && job.sentPackets > 0 && !job.generationEverStarted && !job.outputObserved) {
      job.record.prewarmOnlyCancelled = true;
      job.record.safeToEvict = job.warmTerminalConfirmed === true || job.socketClosureConfirmed === true;
      job.record.retryableWithoutOutput = false;
      job.record.httpFallbackEligible = false;
    }
    if (!code) {
      job.record.acceptance = true;
      job.record.requestTransmissionState = "completed";
    }
    const session = job.session;
    if (session) {
      session.queue = session.queue.filter(queued => queued !== job);
      session.receiving.delete(job);
      if (session.active === job) session.active = null;
    }
    releaseJob(job);
    publication?.();
    if (code) {
      const error = transportError(code, job.record, httpStatus);
      job.response?.destroy(error);
      if (!job.request.destroyed) job.request.destroy(error);
    } else if (!job.draining) {
      job.response?.end();
    }
    if (session) queueMicrotask(() => pump(session));
  }

  function failConnection(session, code, httpStatus, details, publish) {
    const job = session.active;
    if (job && details) Object.assign(job.record, details);
    resetConnection(session, code, details);
    if (job) settle(job, code, httpStatus, false, publish);
  }

  function recordedPrewarmCompatibility(job) {
    return job.record.prewarmCompatibilityFailure === true && !job.generationEverStarted && !job.outputObserved;
  }

  function socketFailure(error, direction) {
    const statusSymbol = error && Object.getOwnPropertySymbols(error).find(symbol => symbol.description === "status-code");
    return { direction, closeCode: error?.closeCode ?? (statusSymbol ? error[statusSymbol] : undefined), wsErrorCode: error?.code };
  }

  function cancel(job, code = "ABORT_ERR") {
    if (job.settled) return;
    job.cancelledAt ??= performance.now();
    if (job.session?.active === job) resetConnection(job.session, "active_request_cancelled");
    settle(job, code, undefined, true);
  }

  function interruptConsumer(job) {
    const live = candidate => candidate && !candidate.settled && !candidate.request.destroyed
      && candidate.binding === job.binding && job.session?.queue.includes(candidate);
    if (live(job.interruptHandoffConsumer)) return job.interruptHandoffConsumer;
    job.interruptHandoffConsumer = job.session?.queue.find(candidate => live(candidate)
      && candidate.payload?.input.length > job.payload.input.length
      && job.payload.input.every((item, index) => canonicalInput(item) === canonicalInput(candidate.payload.input[index]))) ?? null;
    return job.interruptHandoffConsumer;
  }

  function expireDrain(job) {
    if (!job.draining || job.settled) return false;
    if (job.drainMode === "prewarm" && performance.now() < job.packet.hardDeadline && refreshWarmConsumer(job)) {
      clearTimeout(job.drainTimer);
      return false;
    }
    if (job.drainMode === "interrupt" && job.handoffExtended) {
      if (!interruptConsumer(job)) job.drainDeadline = performance.now();
    } else if (job.drainMode === "interrupt" && performance.now() >= job.drainDeadline && interruptConsumer(job)) {
      job.handoffExtended = true;
      job.drainDeadline = job.cancelledAt + Math.max(interruptTimeoutMs, interruptHandoffTimeoutMs);
      job.record.interruptDiagnostics.handoffWaitBudgetMs = Math.max(interruptTimeoutMs, interruptHandoffTimeoutMs);
    }
    const remaining = job.drainDeadline - performance.now();
    if (remaining > 0 && (job.drainMode !== "prewarm" || performance.now() < job.packet.hardDeadline)) {
      clearTimeout(job.drainTimer);
      job.drainTimer = setTimeout(() => expireDrain(job), job.handoffExtended ? Math.min(remaining, 100) : remaining);
      job.drainTimer.unref?.();
      return false;
    }
    job.draining = false;
    if (job.record.interruptDiagnostics) job.record.interruptDiagnostics.expired = true;
    cancel(job);
    return true;
  }

  function refreshWarmConsumer(job) {
    const session = job.session;
    const previous = job.warmConsumer;
    const live = candidate => candidate && !candidate.settled && !candidate.request.destroyed
      && session.queue.includes(candidate) && candidate.payload && candidate.binding === job.binding;
    if (live(previous)) return true;
    if (previous) job.drainDeadline = (previous.cancelledAt ?? previous.settledAt ?? job.cancelledAt) + warmHandoffGraceMs;
    if (performance.now() >= job.drainDeadline) return false;
    const prefix = [...session.prefix, ...job.packet.input];
    job.warmConsumer = session.queue.find(candidate => live(candidate)
      && prefix.length <= candidate.payload.input.length
      && prefix.every((item, index) => cachedInputMatches(session, item, candidate.payload.input[index], job.binding))) ?? null;
    if (job.warmConsumer) {
      const consumer = job.warmConsumer;
      if (!consumer.response) createResponse(consumer);
      if (consumer.warmCarrier !== job.packet) {
        consumer.warmCarrier = job.packet;
        consumer.sentPackets = (consumer.sentPackets ?? 0) + 1;
        try {
          const allowance = consumer.onPacketSending?.(Object.freeze({
            sessionKey: session.key, operationId: consumer.operationId, generation: session.generation,
            phase: "packet_sending", sequence: consumer.sentPackets, wireBytes: job.packet.wireBytes,
            warm: true, businessProgress: false, inheritedUpload: true, newlySentBytes: 0, cacheDecision: "adopted_prewarm",
          })) ?? 0;
          if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > MAX_UPLOAD_ALLOWANCE_MS) throw new Error();
        } catch { settle(consumer, "WS_UPLOAD_BUDGET_INVALID"); }
      }
    }
    return live(job.warmConsumer);
  }

  function cancelAndDrain(job) {
    if (job.nativeWebSocket) return false;
    const session = job.session;
    if (job.settled) {
      const anchor = session?.cancelledReasoningAnchor;
      if (anchor?.operationId === job.operationId && anchor.responseId === session.previousId) anchor.cancelled = true;
      return false;
    }
    if (job.draining) return !expireDrain(job);
    if (!job.settled && session?.active === job && job.packet?.warm === true
      && !job.outputObserved && !job.generationEverStarted && session.socket?.readyState === 1) {
      job.draining = true;
      job.drainMode = "prewarm";
      job.cancelledAt ??= performance.now();
      job.drainDeadline = job.cancelledAt + warmHandoffGraceMs;
      job.record.downstreamCancelled = true;
      session.socket.resume?.();
      expireDrain(job);
      return true;
    }
    if (job.settled || session?.active !== job || job.packet?.warm !== false
      || session.socket?.readyState !== 1 || session.wireBytes !== 0) return false;
    const pendingCreated = !job.packet.establishedResponseId && job.generationEverStarted
      && job.record.acceptance === "unknown" && job.record.requestTransmissionState === "generation_sent";
    if (!pendingCreated && (!job.packet.establishedResponseId || job.record.acceptance !== true)) return false;
    job.draining = true;
    job.drainMode = "interrupt";
    job.pendingInterrupt = pendingCreated;
    job.awaitedResponseCreated = pendingCreated;
    job.cancelledAt ??= performance.now();
    job.drainDeadline = job.cancelledAt + interruptTimeoutMs;
    if (!pendingCreated) {
      const interrupted = interrupt(job, { responseId: job.packet.establishedResponseId, mode: "discard_partial_items" }, true);
      if (!interrupted.ok) {
        job.draining = false;
        return false;
      }
    }
    job.record.downstreamCancelled = true;
    job.record.interruptDiagnostics = { requestedAt: new Date().toISOString(), waitBudgetMs: interruptTimeoutMs,
      lastProgressAt: null, progressFrames: 0, expired: false, acknowledged: false };
    job.session.socket.resume?.();
    expireDrain(job);
    for (const queued of session.queue) {
      if (!queued.settled && !queued.response) createResponse(queued);
    }
    return true;
  }

  function getSession(key) {
    if (sessions.has(key)) {
      const session = sessions.get(key);
      sessions.delete(key);
      sessions.set(key, session);
      return session;
    }
    if (sessions.size >= maxSessions) {
      const idle = [...sessions.values()].find(session => !session.active && !session.queue.length && !session.streams.size && !session.receiving.size);
      if (!idle) return null;
      resetConnection(idle, "idle_session_evicted");
      sessions.delete(idle.key);
    }
    const session = {
      key, queue: [], active: null, socket: null, connecting: null, connectReject: null,
      connectTimer: null, connectionState: "disconnected", generation: 0, binding: null,
      connectedAt: null, minimumUploadBytesPerSecond: null, longestGenerationMs: 0,
      prefix: [], previousId: null, previousComplete: false, cancelledReasoningAnchor: null,
      confirmedAssistantOutput: null, idleContinuationProof: null,
      nativeCompletedConfigHash: null, cacheBytes: 0, wireBytes: 0,
      streams: new Set(), receiving: new Set(), completedIds: new Map(), bindingConfigHashes: null,
    };
    sessions.set(key, session);
    return session;
  }

  function ensureConnection(session, job) {
    if (session.socket?.readyState === 1) return Promise.resolve();
    if (session.connecting) return session.connecting;
    session.generation = ++nextGeneration;
    session.confirmedAssistantOutput = null;
    job.record.generation = session.generation;
    session.connectionState = "connecting";
    job.record.requestTransmissionState = "connecting";
    const socket = createWebSocket(job.url, {
      headers: job.headers,
      agent: job.agent,
      perMessageDeflate: { clientNoContextTakeover: true, serverNoContextTakeover: true },
      followRedirects: false,
      handshakeTimeout: connectTimeoutMs,
      maxPayload: maxSessionBytes,
    });
    session.socket = socket;
    const generation = session.generation;
    const current = () => session.socket === socket && session.generation === generation;
    session.connecting = new Promise((resolve, reject) => {
      session.connectReject = reject;
      socket.once("open", () => {
        if (!current()) return;
        clearTimeout(session.connectTimer);
        session.connectTimer = null;
        session.connectReject = null;
        session.connecting = null;
        session.connectionState = "open";
        session.connectedAt = now();
        resolve();
      });
    });
    socket.on("message", data => {
      if (current()) receive(session, data);
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (current()) failConnection(session, "WS_HANDSHAKE_REJECTED", response.statusCode);
    });
    socket.on("error", error => {
      const details = socketFailure(error, "receive");
      if (current()) failConnection(session, details.closeCode === 1009 || error?.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ? "WS_MESSAGE_TOO_LARGE" : "WS_CONNECTION_ERROR", undefined, details);
    });
    socket.on("close", code => {
      if (current()) failConnection(session, code === 1009 ? "WS_MESSAGE_TOO_LARGE" : "WS_CONNECTION_CLOSED", undefined, { direction: code === 1009 ? "send" : "unknown", closeCode: code });
    });
    session.connectTimer = setTimeout(() => {
      if (current()) failConnection(session, "WS_CONNECT_TIMEOUT");
    }, connectTimeoutMs);
    session.connectTimer.unref?.();
    return session.connecting;
  }

  function packetFor(job, input, warm, previousId) {
    const wireInput = normalizeLocalNoticePayload({ input }, [job.fullInput, job.payload?.input]).input;
    if (job.nativeWebSocket) {
      const packet = { ...job.payload, input: wireInput };
      if (previousId) packet.previous_response_id = previousId;
      if (warm) {
        packet.generate = false;
        delete packet.compaction_trigger;
      }
      return packet;
    }
    const packet = { ...job.config, type: "response.create", store: false, input: wireInput };
    if (previousId) packet.previous_response_id = previousId;
    if (warm) {
      packet.generate = false;
      delete packet.compaction_trigger;
    }
    return packet;
  }

  function planPackets(job, input, initialPreviousId) {
    const groups = atomicGroups(input);
    const groupBytes = groups.map(group => byteLength(group) - 2);
    const baseBytes = byteLength(packetFor(job, [], false, initialPreviousId));
    const inputBytes = groupBytes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, groups.length - 1);
    if (!allowImagePrewarm && containsImage(input) && baseBytes + inputBytes > maxMessageBytes) {
      return { error: "unsupported_image_prewarm" };
    }
    if (baseBytes > maxMessageBytes || groupBytes.some(bytes => baseBytes + bytes > maxMessageBytes)) {
      return { error: "payload_too_large" };
    }
    const plan = [];
    let wireBytes = 0;
    let offset = 0;
    let previousId = initialPreviousId;
    do {
      const remaining = groupBytes.slice(offset);
      const remainingBytes = remaining.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, remaining.length - 1);
      const generationBytes = byteLength(packetFor(job, [], false, previousId)) + remainingBytes;
      const mandatoryWarm = generationBytes > maxMessageBytes;
      let warm = mandatoryWarm || remaining.length > 0
        && generationBytes > interruptiblePrewarmBytes && (allowImagePrewarm || !containsImage(groups.slice(offset)));
      let groupCount = remaining.length;
      if (warm) {
        groupCount = 0;
        let bytes = byteLength(packetFor(job, [], true, previousId));
        for (const nextGroupBytes of remaining) {
          if (groups[offset + groupCount].some(item => item?.type === "compaction_trigger")) break;
          const candidate = bytes + nextGroupBytes + (groupCount ? 1 : 0);
          if (candidate > maxMessageBytes) break;
          bytes = candidate;
          groupCount += 1;
        }
        if (!groupCount && mandatoryWarm) return { error: "payload_too_large" };
        if (!groupCount) {
          warm = false;
          groupCount = remaining.length;
        }
      }
      const packetWarm = warm || job.nativeWebSocket && job.payload.generate === false;
      const packet = packetFor(job, groups.slice(offset, offset + groupCount).flat(), packetWarm, previousId);
      wireBytes += byteLength(packet);
      plan.push({ groupCount, warm: packetWarm, internalPrewarm: warm });
      offset += groupCount;
      if (!warm) break;
      previousId = "x".repeat(Math.max(0, maxPreviousResponseIdBytes - 2));
    } while (offset <= groups.length);
    return { groups, groupBytes, plan, wireBytes };
  }

  function createResponse(job) {
    const response = new PassThrough({ highWaterMark: responseHighWaterMark });
    response.statusCode = 200;
    response.headers = { "content-type": "text/event-stream" };
    response.httpVersion = "1.1";
    response.complete = false;
    response.on("error", noop);
    job.response = response;
    job.session.streams.add(response);
    const release = () => job.session.streams.delete(response);
    response.once("end", release);
    response.once("close", () => {
      release();
      if (!job.settled) job.request.destroy();
    });
    job.request.emit("response", response);
  }

  function refreshPacketTimeout(session, job, packet, uploadAllowanceMs = 0) {
    if (job.compactionDeadline !== undefined && !packet.warm) return;
    clearTimeout(job.timer);
    const socket = session.socket;
    job.timer = setTimeout(() => {
      if (!job.settled && session.active === job && job.packet === packet && session.socket === socket) {
        failConnection(session, packet.warm ? "WS_PREWARM_TIMEOUT" : "WS_TERMINAL_TIMEOUT");
      }
    }, Math.min(2_147_483_647, uploadAllowanceMs + (packet.warm ? prewarmTimeoutMs : responseTimeoutMs),
      packet.warm ? Math.max(0, packet.hardDeadline - performance.now()) : Infinity));
    job.timer.unref?.();
  }

  function sendNext(session, job) {
    if (job.settled || session.active !== job) return;
    if (job.draining && job.drainMode === "prewarm") return;
    const { groupCount, warm, internalPrewarm = warm } = job.plan.shift();
    const input = job.groups.slice(0, groupCount).flat();
    if (job.atomicUntilVisibleOutput && !warm) {
      const completeInput = job.nativeWebSocket && !job.payload.previous_response_id ? job.payload.input : [...session.prefix, ...input];
      job.record.retryInputFingerprint = digest(completeInput.map(canonicalInput));
    }
    const packet = packetFor(job, input, warm, session.previousId);
    const wire = JSON.stringify(packet);
    const wireBytes = Buffer.byteLength(wire, "utf8");
    if (wireBytes > maxMessageBytes) return failConnection(session, "payload_too_large");
    if (retainedBytes(session) + wireBytes > maxSessionBytes) return failConnection(session, "session_bytes_exceeded");
    job.packet = { input, warm, internalPrewarm, groupCount, wireBytes, responseId: null, establishedResponseId: null,
      outputObserved: false, startedAt: performance.now() };
    job.record.phase = warm ? "prewarm" : "generation";
    job.record.state = warm ? "prewarming" : "awaiting_response";
    job.record.generation = session.generation;
    job.record.connectionOpenedAt = session.connectedAt;
    if (job.settled || session.active !== job) return;
    if (session.socket?.readyState !== 1) return failConnection(session, "WS_CONNECTION_CLOSED");
    job.sentPackets = (job.sentPackets ?? 0) + 1;
    let uploadAllowanceMs;
    try {
      uploadAllowanceMs = job.onPacketSending?.(Object.freeze({
        sessionKey: session.key, operationId: job.operationId, generation: session.generation,
          connectionOpenedAt: session.connectedAt, connectionAgeMs: Math.max(0, now() - session.connectedAt),
          phase: "packet_sending", sequence: job.sentPackets, wireBytes, warm, businessProgress: false,
          inheritedUpload: false, newlySentBytes: wireBytes, cacheDecision: job.cacheDecision,
      })) ?? 0;
    } catch (error) {
      if (job.settled || session.active !== job || job.request.destroyed) return;
      if (error?.recoveryStatePendingAdmission === true && error.localRequestFailure === true
        && error.httpStatus === 503 && error.requestTransmissionState === "not_sent"
        && ["MODEL_OPERATION_RECOVERY_STATE_PERSISTENCE_FAILED", "MODEL_OPERATION_STATE_PERSISTENCE_FAILED"].includes(error.code)) {
        if (job.sentPackets === 1) {
          job.record.acceptance = false;
          job.record.requestTransmissionState = "not_sent";
        }
        job.record.pendingAdmissionError = {
          recoveryStatePendingAdmission: true, localRequestFailure: true, statusCode: 503, httpStatus: 503,
          errorType: "local_state", requestAccepted: job.record.acceptance,
          operationAcceptance: job.record.acceptance === false ? "not_sent" : job.record.acceptance === true ? "accepted" : "unknown",
          requestTransmissionState: job.record.requestTransmissionState,
          recoveryPersistenceStage: ["validation", "callback"].includes(error.recoveryPersistenceStage) ? error.recoveryPersistenceStage : "unknown",
          cause: { code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.cause?.code ?? "") ? error.cause.code : "UNKNOWN",
            ...(["open", "write", "fsync", "close", "rename", "directory_open", "directory_fsync", "directory_close"].includes(error.cause?.stateSaveStage)
              ? { stateSaveStage: error.cause.stateSaveStage } : {}) },
        };
        return settle(job, error.code, 503);
      }
      return failConnection(session, "WS_UPLOAD_BUDGET_INVALID");
    }
    if (!Number.isSafeInteger(uploadAllowanceMs) || uploadAllowanceMs < 0 || uploadAllowanceMs > MAX_UPLOAD_ALLOWANCE_MS) {
      return failConnection(session, "WS_UPLOAD_BUDGET_INVALID");
    }
    if (!job.response) createResponse(job);
    if (job.settled || session.active !== job) return;
    if (!warm) job.generationEverStarted = true;
    else job.packet.hardDeadline = performance.now() + uploadAllowanceMs + prewarmTimeoutMs;
    job.record.acceptance = "unknown";
    job.record.requestTransmissionState = warm ? "prewarm_sent" : "generation_sent";
    session.wireBytes = wireBytes;
    const socket = session.socket;
    const pendingPacket = job.packet;
    const current = () => session.socket === socket && session.active === job && !job.settled && job.packet === pendingPacket;
    const sent = error => {
      if (!current()) return;
      job.fragmentCleanup?.();
      session.wireBytes = 0;
      if (error) failConnection(session, "WS_SEND_ERROR", undefined, socketFailure(error, "send"));
    };
    refreshPacketTimeout(session, job, pendingPacket, uploadAllowanceMs);
    try {
      if (wireBytes <= websocketFragmentBytes) return socket.send(wire, sent);
      const payload = Buffer.from(wire, "utf8");
      let offset = 0;
      let acknowledgedBytes = 0;
      let uploadWindow = 1;
      let sending = false;
      let sendingBytes = 0;
      let scheduled = null;
      let acknowledgementTimer = null;
      let sendCallbackMs = 0;
      let sendCallbackMaxMs = 0;
      const uploadStartedAt = performance.now();
      let lastAcknowledgedAt = uploadStartedAt;
      const acknowledgements = new Map();
      const cleanup = () => {
        clearTimeout(acknowledgementTimer);
        clearImmediate(scheduled);
        acknowledgementTimer = null;
        scheduled = null;
        acknowledgements.clear();
        socket.off("pong", onPong);
        if (job.fragmentCleanup === cleanup) job.fragmentCleanup = null;
      };
      const refreshAcknowledgementTimeout = () => {
        clearTimeout(acknowledgementTimer);
        acknowledgementTimer = null;
        if (!acknowledgements.size || !current()) return;
        acknowledgementTimer = setTimeout(() => {
          if (!current() || expireDrain(job)) return;
          sent(Object.assign(new Error("WebSocket upload acknowledgement timed out"), { code: "WS_PONG_TIMEOUT" }));
        }, uploadAcknowledgementTimeoutMs);
        acknowledgementTimer.unref?.();
      };
      const scheduleSend = () => {
        if (!current() || scheduled !== null || sending) return;
        scheduled = setImmediate(() => { scheduled = null; sendFragment(); });
      };
      const onPong = data => {
        if (!current()) return;
        const acknowledgement = acknowledgements.get(Buffer.from(data).toString("hex"));
        if (!acknowledgement || acknowledgement.offset <= acknowledgedBytes) return;
        if (expireDrain(job)) return;
        const observedAt = performance.now();
        const elapsedMs = Math.max(1, observedAt - lastAcknowledgedAt);
        const uploadElapsedMs = Math.max(1, observedAt - uploadStartedAt);
        const observedBytesPerMs = Math.min((acknowledgement.offset - acknowledgedBytes) / elapsedMs,
          acknowledgement.offset / uploadElapsedMs);
        if (observedBytesPerMs > 0) session.minimumUploadBytesPerSecond = Math.min(
          session.minimumUploadBytesPerSecond ?? Infinity, observedBytesPerMs * 1000);
        acknowledgedBytes = acknowledgement.offset;
        lastAcknowledgedAt = observedAt;
        const targetWindow = Math.max(1, Math.min(websocketMaxUploadWindow,
          Math.floor(observedBytesPerMs * websocketUploadQueueBudgetMs / websocketAcknowledgementBytes)));
        uploadWindow = Math.min(uploadWindow + 1, targetWindow);
        for (const [token, pending] of acknowledgements) {
          if (pending.offset <= acknowledgedBytes) acknowledgements.delete(token);
        }
        let remainingAllowanceMs;
        try {
          const progress = {
            sessionKey: session.key, operationId: job.operationId, generation: session.generation,
            phase: "packet_upload_progress", sequence: job.sentPackets, wireBytes,
            acknowledgedBytes, warm, businessProgress: false, uploadElapsedMs,
            sendCallbackMs, sendCallbackMaxMs, pingRttMs: observedAt - acknowledgement.startedAt,
            pingSendCallbackMs: acknowledgement.callbackAt === null ? null : acknowledgement.callbackAt - acknowledgement.startedAt,
            pingCallbackToPongMs: acknowledgement.callbackAt === null ? null : Math.max(0, observedAt - acknowledgement.callbackAt),
            uploadWindow, outstandingBytes: offset + sendingBytes - acknowledgedBytes,
            uploadBytesPerSecond: observedBytesPerMs * 1000, pendingAcknowledgements: acknowledgements.size,
          };
          remainingAllowanceMs = Math.ceil(uploadAllowanceMs * (payload.length - acknowledgedBytes) / payload.length);
          if (!job.draining) remainingAllowanceMs = job.onUploadProgress?.(Object.freeze(progress)) ?? remainingAllowanceMs;
          else if (job.warmConsumer && !job.warmConsumer.settled && !job.warmConsumer.request.destroyed) {
            const consumer = job.warmConsumer;
            try {
              consumer.onUploadProgress?.(Object.freeze({ ...progress, operationId: consumer.operationId, inheritedUpload: true,
                sequence: consumer.sentPackets }));
            } catch { settle(consumer, "WS_UPLOAD_BUDGET_INVALID"); }
          }
        } catch { return failConnection(session, "WS_UPLOAD_BUDGET_INVALID"); }
        if (!Number.isSafeInteger(remainingAllowanceMs) || remainingAllowanceMs < 0 || remainingAllowanceMs > MAX_UPLOAD_ALLOWANCE_MS) {
          return failConnection(session, "WS_UPLOAD_BUDGET_INVALID");
        }
        if (!current()) return;
        refreshAcknowledgementTimeout();
        refreshPacketTimeout(session, job, pendingPacket, remainingAllowanceMs);
        scheduleSend();
      };
      const checkpoint = () => {
        const token = createHash("sha256").update(`${session.generation}:${job.operationId}:${job.sentPackets}:${offset}`).digest().subarray(0, 16);
        const acknowledgement = { offset, startedAt: performance.now(), callbackAt: null };
        acknowledgements.set(token.toString("hex"), acknowledgement);
        if (acknowledgementTimer === null) refreshAcknowledgementTimeout();
        try {
          socket.ping(token, error => {
            if (!current()) return;
            acknowledgement.callbackAt = performance.now();
            if (error) sent(error);
          });
        } catch (error) { sent(error); }
      };
      job.fragmentCleanup = cleanup;
      socket.on("pong", onPong);
      const sendFragment = () => {
        if (!current()) return;
        if (expireDrain(job)) return;
        if (sending || offset - acknowledgedBytes >= uploadWindow * websocketAcknowledgementBytes) return;
        if (socket.readyState !== 1) return failConnection(session, "WS_CONNECTION_CLOSED");
        const end = Math.min(offset + websocketFragmentBytes, payload.length);
        const sendStartedAt = performance.now();
        sending = true;
        sendingBytes = end - offset;
        try {
          socket.send(payload.subarray(offset, end), { binary: false, fin: end === payload.length }, error => {
            if (!current()) return;
            sending = false;
            sendingBytes = 0;
            if (error) return sent(error);
            const callbackMs = performance.now() - sendStartedAt;
            sendCallbackMs += callbackMs;
            sendCallbackMaxMs = Math.max(sendCallbackMaxMs, callbackMs);
            offset = end;
            if (offset === payload.length) return sent();
            if (offset % websocketAcknowledgementBytes === 0) checkpoint();
            scheduleSend();
          });
        } catch (error) { sent(error); }
      };
      sendFragment();
    } catch (error) {
      sent(error);
    }
  }

  function receive(session, data) {
    const job = session.active;
    if (!job?.packet || job.settled) return;
    if (expireDrain(job)) return;
    const packet = job.packet;
    const socket = session.socket;
    const current = () => !job.settled && session.active === job && job.packet === packet && session.socket === socket;
    const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let event;
    try { event = JSON.parse(raw); } catch { return failConnection(session, "WS_INVALID_EVENT"); }
    const nestedId = event?.response?.id;
    const topLevelId = event?.response_id;
    const responseId = nestedId ?? topLevelId;
    const identityConflict = reason => {
      const tag = value => typeof value === "string" ? digest(value).slice(0, 16) : value === undefined ? null : `invalid:${typeof value}`;
      const responseIdentityConflict = { reason, eventType: typeof event?.type === "string" ? event.type.slice(0, 96) : null,
        nestedIdTag: tag(nestedId), topLevelIdTag: tag(topLevelId), packetResponseIdTag: tag(packet.responseId),
        previousResponseIdTag: tag(session.previousId), completedResponse: Boolean(responseId && session.completedIds.has(responseId)),
        eventFingerprint: digest(event).slice(0, 16), completedFingerprint: typeof responseId === "string"
          ? session.completedIds.get(responseId)?.slice(0, 16) ?? null : null,
        packetSequence: job.sentPackets, warm: packet.warm === true, nativeWebSocket: job.nativeWebSocket === true,
        outputObserved: job.outputObserved === true, packetOutputObserved: packet.outputObserved === true };
      job.outputObserved = true;
      return failConnection(session, "WS_RESPONSE_ID_CONFLICT", undefined, { responseIdentityConflict });
    };
    if (nestedId !== undefined && topLevelId !== undefined && nestedId !== topLevelId
      || responseId !== undefined && (typeof responseId !== "string" || !responseId)) {
      return identityConflict("invalid_or_inconsistent_event_id");
    }
    if (responseId && session.completedIds.has(responseId)) {
      if (["response.completed", "response.incomplete"].includes(event.type) && session.completedIds.get(responseId) === digest(event)) return;
      if (job.nativeWebSocket && !packet.warm
        && packet.establishedResponseId && packet.establishedResponseId !== responseId
        && event.type === "response.in_progress" && event.response?.status === "in_progress"
        && Object.keys(event).every(key => ["type", "response", "response_id", "sequence_number"].includes(key))
        && (event.sequence_number === undefined || Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0)
        && Object.keys(event.response).every(key => ["id", "status", "output"].includes(key))
        && (event.response.output === undefined || Array.isArray(event.response.output) && event.response.output.length === 0)) return;
      return identityConflict("event_for_completed_response");
    }
    if (responseId && packet.responseId && responseId !== packet.responseId) {
      return identityConflict("active_response_id_changed");
    }
    if (responseId) packet.responseId = responseId;
    if (typeof event?.type !== "string") return failConnection(session, "WS_INVALID_EVENT");
    if (!job.nativeWebSocket && !packet.warm && event.type !== "error" && !reasoningAnchorEvent(event)) {
      packet.reasoningAnchorUnsafe = true;
      if (!discardableInterruptEvent(event)) packet.interruptAnchorUnsafe = true;
    }
    if (job.nativeWebSocket && !packet.warm && !(protocolControlEvent(event)
      ? interruptedHistoryControlTypes.has(event.type) : discardableInterruptEvent(event))) packet.interruptAnchorUnsafe = true;
    if (event.type === "response.created" && typeof event?.response?.id === "string"
      && event.response.id && event.response.status === "in_progress") packet.establishedResponseId = event.response.id;
    if (eventHasOutput(event)) {
      packet.outputObserved = true;
      job.outputObserved = true;
      if (packet.warm) return failConnection(session, "WS_INVALID_PREWARM_OUTPUT");
    }
    const responseOutput = event.response?.output;
    const terminalResponseEvent = ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type);
    if (responseOutput !== undefined && responseOutput !== null
      && (!Array.isArray(responseOutput)
        || responseOutput.some(item => !["reasoning", "message"].includes(item?.type)
          && (!["function_call", "custom_tool_call"].includes(item?.type)
            || !["in_progress", "incomplete"].includes(item?.status) || job.visibleOutputCommitted || terminalResponseEvent)))) {
      job.record.recoveryReconciliationRequired = true;
    }
    if (event.type.startsWith("response.")) {
      job.record.acceptance = true;
      job.record.requestTransmissionState = "response_received";
    }
    if (job.pendingInterrupt && packet.establishedResponseId) {
      job.pendingInterrupt = false;
      const interrupted = interrupt(job, { responseId: packet.establishedResponseId, mode: "discard_partial_items" }, true);
      if (!interrupted.ok) return failConnection(session, "WS_INTERRUPT_SEND_ERROR");
      if (!current()) return;
    }
    const completedReasoningProgress = !packet.warm && (job.observeReasoningProgress ??= createReasoningProgressTracker())(event);
    if (job.draining && job.record.interruptDiagnostics && (isBusinessProgress(event) || completedReasoningProgress)) {
      job.record.interruptDiagnostics.lastProgressAt = new Date().toISOString();
      job.record.interruptDiagnostics.progressFrames += 1;
    }
    if (!packet.warm && (isBusinessProgress(event) || completedReasoningProgress)) refreshPacketTimeout(session, job, packet);
    let sse;
    if (!packet.internalPrewarm && !job.draining) {
      const eventLine = /^[\w.:-]+$/.test(event.type) ? `event: ${event.type}\n` : "";
      sse = `${eventLine}${raw.split(/\r?\n/).map(line => `data: ${line}`).join("\n")}\n\n`;
      if (retainedBytes(session) + Buffer.byteLength(sse) > maxSessionBytes) {
        if (job.progressBudget) job.record.localRejection = true;
        return failConnection(session, "session_bytes_exceeded");
      }
    }
    const responseStream = job.response;
    const delivery = () => {
      if (!sse || !job.atomicUntilVisibleOutput || !job.nativeWebSocket || job.visibleOutputCommitted) return sse;
      if (["response.created", "response.in_progress", "response.queued"].includes(event.type) || protocolControlEvent(event)) {
        if (nativeEventCommitsOutput(event)) job.visibleOutputCommitted = true;
        return sse;
      }
      if (["error", "response.failed"].includes(event.type)
        || event.type === "response.incomplete" && !acknowledgedInterrupt) return sse;
      if (isNativeReasoningProgressEvent(event)) return sse;
      if (deferrableNativeOutput(event)) {
        (job.deferredOutput ??= []).push(sse);
        job.deferredOutputBytes = (job.deferredOutputBytes ?? 0) + Buffer.byteLength(sse);
        return null;
      }
      job.visibleOutputCommitted = true;
      job.outputObserved = true;
      const output = (job.deferredOutput ?? []).join("") + sse;
      job.deferredOutput = null;
      job.deferredOutputBytes = 0;
      return output;
    };
    const publish = () => {
      const output = delivery();
      return () => {
        if (output && !responseStream.destroyed) responseStream.write(output);
      };
    };
    const acknowledgedInterrupt = (job.nativeWebSocket || job.drainMode === "interrupt") && !packet.warm && packet.interruptSent
      && ["queued", "sent"].includes(job.record.interruptState) && event.type === "response.incomplete"
      && event.response?.id === packet.establishedResponseId && event.response?.status === "incomplete"
      && event.response?.incomplete_details?.reason === "interrupted" && Array.isArray(event.response.output)
      && !event.error && !event.response.error;
    if (["error", "response.failed", "response.incomplete"].includes(event.type) && !acknowledgedInterrupt) {
      if (job.cancelledReasoningAnchorReused && !job.anchorFullRebuildAttempted && !job.outputObserved && !packet.reasoningAnchorUnsafe
        && job.record.acceptance !== true && !packet.responseId && event.type === "error" && !event.response
        && event.error?.type === "invalid_request_error" && event.error.code === "previous_response_not_found"
        && errorStatusValues(event).every(value => value === undefined || [400, 404, "400", "404"].includes(value))) {
        job.anchorFullRebuildAttempted = true;
        clearTimeout(job.timer);
        job.fragmentCleanup?.();
        resetConnection(session, "cancelled_reasoning_anchor_not_found");
        job.packet = null;
        session.active = null;
        session.queue.unshift(job);
        queueMicrotask(() => pump(session));
        return;
      }
      const status = errorStatus(event);
      job.record.upstreamError = event.response?.error ?? event.error
        ?? { code: event.response?.incomplete_details?.reason ?? event.code, type: event.type, message: event.message };
      job.record.upstreamFailureSignals = { code: event.code, type: event.type, message: event.message,
        error: event.error ?? (!event.response?.error ? job.record.upstreamError : undefined), ...(event.response ? { response: { code: event.response.code,
          type: event.response.type, message: event.response.message, error: event.response.error,
          incomplete_details: event.response.incomplete_details } } : {}) };
      if (!job.outputObserved) {
        const rejection = classifyModelFailure({ source: "sse", statusCode: status, message: event,
          progressObserved: false });
        if (["temporary", "authentication", "quota", "safety", "permanent", "payload_too_large"].includes(rejection.category)
          && rejection.acceptance === "rejected") {
          job.record.acceptance = false;
          job.record.permanentRejection = ["authentication", "quota", "safety", "permanent"].includes(rejection.category);
        }
      }
      const compatibilityError = event.response?.error ?? event.error;
      if (packet.warm && !job.generationEverStarted && !job.outputObserved
        && (event.type === "error" || event.type === "response.failed" && event.response?.id === packet.establishedResponseId
          && event.response.status === "failed" && Array.isArray(event.response.output) && event.response.output.length === 0)
        && compatibilityError?.type === "invalid_request_error"
        && ["unsupported_parameter", "unsupported_value"].includes(compatibilityError.code)
        && typeof compatibilityError.param === "string" && /^[A-Za-z_][\w.[\]-]{0,159}$/u.test(compatibilityError.param)
        && errorStatusValues(event).every(value => value === undefined || [400, 422, "400", "422"].includes(value))
        && classifyModelFailure({ source: "sse", statusCode: status, message: event,
          requestAccepted: false, progressObserved: false }).httpCompatibilityFallback === true) {
        job.record.prewarmCompatibilityFailure = true;
      }
      if (!job.nativeWebSocket && packet.warm && packet.establishedResponseId && !job.generationEverStarted && !job.outputObserved
        && !job.record.prewarmCompatibilityFailure
        && classifyModelFailure({ source: "sse", statusCode: status, message: compatibilityError,
          requestAccepted: job.record.acceptance, progressObserved: false }).httpCompatibilityFallback === true) {
        job.record.prewarmCompatibilityBlocked = true;
      }
      if (event.type === "error" && !packet.responseId && !job.outputObserved && job.record.acceptance !== true
        && event.error?.type === "invalid_request_error"
        && ["unsupported_parameter", "unsupported_value"].includes(event.error.code)
        && typeof event.error.param === "string" && /^[A-Za-z_][\w.[\]-]{0,159}$/u.test(event.error.param)
        && errorStatuses(event).every(value => value === 400 || value === 422)
        && classifyModelFailure({ source: "sse", statusCode: status, message: event, progressObserved: false }).httpCompatibilityFallback === true) {
        job.record.acceptance = false;
      }
      if (event.type === "response.failed" && event.response?.status === "failed"
        && !job.record.prewarmCompatibilityBlocked
        && event.response.id === packet.establishedResponseId && !job.outputObserved
        && Array.isArray(event.response.output) && event.response.output.length === 0) {
        job.record.terminalOutcome = "failed_no_output";
        job.record.terminalEvidence = createModelFailureTerminalEvidence({ operationId: job.operationId,
          attempt: job.record.attempt, generation: session.generation,
          packetSequence: (job.preparedPackets ?? 0) + 1, responseId: event.response.id,
          statusCode: status, error: event.response.error ?? event.error });
      }
      return failConnection(session, status === 503 ? "WS_HTTP_503" : "WS_UPSTREAM_ERROR", status, undefined,
        job.record.prewarmCompatibilityBlocked ? undefined : publish);
    }
    if (event.type !== "response.completed" && !acknowledgedInterrupt) {
      if (!sse) return;
      const output = delivery();
      if (!output) return;
      const canWrite = job.response.write(output);
      if (!current()) return;
      if (!canWrite && session.socket && !job.backpressured) {
        const socket = session.socket;
        job.backpressured = true;
        socket.pause?.();
        const resume = () => {
          job.backpressured = false;
          job.response.removeListener("drain", resume);
          job.response.removeListener("end", resume);
          job.response.removeListener("close", resume);
          if (session.socket === socket) socket.resume?.();
        };
        job.response.once("drain", resume);
        job.response.once("end", resume);
        job.response.once("close", resume);
      }
      return;
    }
    const response = event.response;
    if (typeof response?.id !== "string" || !response.id || response.status !== (acknowledgedInterrupt ? "incomplete" : "completed") || !Array.isArray(response.output)) return failConnection(session, "WS_INVALID_TERMINAL");
    if (job.awaitedResponseCreated && (!acknowledgedInterrupt || response.output.length !== 0)) {
      return failConnection(session, "WS_CANCEL_DRAIN_UNCONFIRMED");
    }
    if (acknowledgedInterrupt) {
      job.record.interruptState = "acknowledged";
      if (job.record.interruptDiagnostics) job.record.interruptDiagnostics.acknowledged = true;
      job.record.terminalOutcome = "interrupted";
    }
    if (packet.warm && response.output.length) return failConnection(session, "WS_INVALID_PREWARM_OUTPUT");
    if (packet.warm && byteLength(response.id) > maxPreviousResponseIdBytes) return failConnection(session, "WS_RESPONSE_ID_LIMIT");
    if (!packet.warm) session.longestGenerationMs = Math.max(session.longestGenerationMs, performance.now() - packet.startedAt);
    clearTimeout(job.timer);
    session.cancelledReasoningAnchor = !job.nativeWebSocket && !packet.warm
      && (!packet.reasoningAnchorUnsafe || acknowledgedInterrupt && !packet.interruptAnchorUnsafe)
      && packet.establishedResponseId === response.id && session.previousComplete && session.previousId
      && session.completedIds.has(session.previousId) && response.output.length > 0
      && response.output.every(item => item?.type === "reasoning" && typeof item.id === "string" && item.id)
      ? { previousId: session.previousId, prefixItems: session.prefix.length,
        requestInputItems: session.prefix.length + packet.input.length, responseId: response.id,
        operationId: job.operationId, generation: session.generation, cancelled: job.record.downstreamCancelled === true }
      : null;
    const committed = [...session.prefix, ...packet.input, ...response.output];
    session.prefix = committed;
    if (!packet.warm) {
      const proof = session.confirmedAssistantOutput ??= { generation: session.generation, items: new WeakSet(), count: 0 };
      for (const item of response.output) {
        if (proof.count >= Math.floor(maxSessionBytes / assistantOutputProofBytes)) break;
        if (!completeAssistantOutput(item) || proof.items.has(item)) continue;
        proof.items.add(item);
        proof.count += 1;
      }
    }
    session.previousId = response.id;
    session.previousComplete = !acknowledgedInterrupt;
    session.nativeCompletedConfigHash = job.nativeWebSocket && !packet.warm && !acknowledgedInterrupt ? job.nativeConfigHash : null;
    session.idleContinuationProof = job.nativeWebSocket && (!acknowledgedInterrupt || !packet.interruptAnchorUnsafe) ? {
      responseId: response.id, binding: job.binding, configurationHash: job.nativeConfigHash,
      inputItems: committed.length, fingerprint: digest(committed.map(canonicalInput)),
      ...(acknowledgedInterrupt ? { kind: "interrupted" } : {}),
    } : null;
    session.cacheBytes = byteLength(committed) + Buffer.byteLength(response.id)
      + (session.cancelledReasoningAnchor ? byteLength(session.cancelledReasoningAnchor) : 0);
    session.completedIds.set(response.id, digest(event));
    if (session.completedIds.size > 128) session.completedIds.delete(session.completedIds.keys().next().value);
    if (packet.internalPrewarm) {
      session.wireBytes = 0;
      job.fragmentCleanup?.();
      if (retainedBytes(session) > maxSessionBytes) return failConnection(session, "session_bytes_exceeded");
      if (job.draining && job.drainMode === "prewarm") {
        job.warmTerminalConfirmed = true;
        const consumer = job.warmConsumer;
        if (consumer && !consumer.settled && !consumer.request.destroyed) {
          consumer.preparedPackets = (consumer.preparedPackets ?? 0) + 1;
          consumer.preparedInputItems = (consumer.preparedInputItems ?? 0) + packet.input.length;
          try {
            consumer.onPreparationProgress?.(Object.freeze({ sessionKey: session.key, operationId: consumer.operationId,
              generation: session.generation, phase: "prewarm_completed", sequence: consumer.preparedPackets,
              preparedPackets: consumer.preparedPackets, preparedInputItems: consumer.preparedInputItems,
              acknowledgedInputItems: packet.input.length, remainingPackets: 1, businessProgress: false }));
          } catch {}
        }
        return settle(job, "ABORT_ERR", undefined, true);
      }
      job.groups.splice(0, packet.groupCount);
      job.groupBytes.splice(0, packet.groupCount);
      job.packet = null;
      job.preparedPackets = (job.preparedPackets ?? 0) + 1;
      job.preparedInputItems = (job.preparedInputItems ?? 0) + packet.input.length;
      try {
        job.onPreparationProgress?.(Object.freeze({
          sessionKey: session.key, operationId: job.operationId, generation: session.generation,
          phase: "prewarm_completed", sequence: job.preparedPackets, preparedPackets: job.preparedPackets,
          preparedInputItems: job.preparedInputItems, acknowledgedInputItems: packet.input.length,
          remainingPackets: job.plan.length, businessProgress: false,
        }));
      } catch {}
      queueMicrotask(() => sendNext(session, job));
    } else {
      job.response.complete = true;
      settle(job, undefined, undefined, false, publish);
      if (retainedBytes(session) > maxSessionBytes) resetConnection(session, "session_bytes_exceeded");
    }
  }

  async function pump(session) {
    if (session.active?.draining) expireDrain(session.active);
    if (closed || session.active || !session.queue.length) return;
    const job = session.queue.shift();
    if (job.settled) return pump(session);
    session.active = job;
    try {
      let input;
      if (job.nativeWebSocket) {
        let previousId = job.payload.previous_response_id;
        const idleProof = session.idleContinuationProof;
        if (previousId && session.socket?.readyState !== 1 && session.lastResetWasIdle === true
          && (idleProof?.kind !== "interrupted" || job.allowInterruptedContextRebuild)
          && idleProof?.responseId === previousId && idleProof.binding === session.binding && idleProof.binding === job.binding
          && idleProof.configurationHash === job.nativeConfigHash && Array.isArray(job.fullInput)
          && job.fullInput.length === idleProof.inputItems + job.payload.input.length
          && digest(job.fullInput.slice(0, idleProof.inputItems).map(canonicalInput)) === idleProof.fingerprint
          && job.payload.input.every((item, index) => canonicalInput(item) === canonicalInput(job.fullInput[idleProof.inputItems + index]))) {
          job.record.retryFullInputFingerprint = digest(job.fullInput.map(canonicalInput));
          job.payload = { ...job.payload, input: structuredClone(job.fullInput) };
          delete job.payload.previous_response_id;
          job.bytes = byteLength(job.payload) + byteLength(job.headers) + byteLength(job.config);
          session.idleContinuationProof = null;
          try { job.onPreparationProgress?.({ operationId: job.operationId, phase: "native_idle_context_rebuild",
            reason: idleProof.kind === "interrupted" ? "verified_interrupted_history" : "verified_completed_history",
            inputItems: job.fullInput.length, requestTransmissionState: "not_sent" }); } catch {}
          previousId = null;
        }
        if (previousId && (session.binding !== job.binding || session.socket?.readyState !== 1 || session.previousId !== previousId)) {
          job.record.localRejection = true;
          job.record.nativePreviousResponseMismatch = {
            bindingMatches: session.binding === job.binding, connectionOpen: session.socket?.readyState === 1,
            previousIdMatches: session.previousId === previousId, previousIdKnown: session.completedIds.has(previousId),
            latestPreviousIdPresent: Boolean(session.previousId), generation: session.generation,
            lastResetReason: session.lastResetReason ?? null, lastResetAt: session.lastResetAt ?? null,
            lastResetWasIdle: session.lastResetWasIdle ?? null, lastResetCloseCode: session.lastResetCloseCode ?? null,
            lastResetCloseCategory: session.lastResetCloseCategory ?? null,
          };
          return settle(job, "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH");
        }
        let mismatchIndex = null;
        const cacheState = { bindingMatches: session.binding === job.binding, connectionOpen: session.socket?.readyState === 1,
          previousConfirmed: Boolean(session.previousId && session.completedIds.has(session.previousId)),
          configurationMatches: session.nativeCompletedConfigHash === job.nativeConfigHash,
          cachedInputItems: session.prefix.length, requestedInputItems: job.payload.input.length };
        let reuseFullInput = !previousId && job.payload.generate !== false && !isNativeCompaction(job.payload, job.headers)
          && !job.payload.input.some(item => item?.type === "compaction_trigger")
          && session.binding === job.binding && session.socket?.readyState === 1 && session.previousId
          && session.completedIds.has(session.previousId) && session.nativeCompletedConfigHash === job.nativeConfigHash
          && session.prefix.length > 0 && session.prefix.length < job.payload.input.length
          && session.prefix.every((item, index) => {
            if (cachedInputMatches(session, item, job.payload.input[index], job.binding)) return true;
            mismatchIndex = index;
            return false;
          });
        const cacheReason = previousId ? "native_previous_response" : reuseFullInput ? "native_full_input_reused" : "native_full_input";
        const fullInput = previousId ? job.fullInput ?? [...session.prefix, ...job.payload.input] : job.payload.input;
        const fullInputMatchesPrevious = previousId && fullInput.length === session.prefix.length + job.payload.input.length
          && session.prefix.every((item, index) => cachedInputMatches(session, item, fullInput[index], job.binding))
          && job.payload.input.every((item, index) => canonicalInput(item) === canonicalInput(fullInput[session.prefix.length + index]));
        if (job.atomicUntilVisibleOutput && fullInputMatchesPrevious && session.completedIds.has(previousId)) {
          job.record.retryFullInputFingerprint = digest(fullInput.map(canonicalInput));
        }
        const rotation = connectionAgeDecision(session, job, fullInput, !previousId && !reuseFullInput,
          reuseFullInput ? job.payload.input.slice(session.prefix.length) : job.payload.input);
        if (rotation) {
          if (previousId && !fullInputMatchesPrevious) {
            job.record.localRejection = true;
            return settle(job, "WS_NATIVE_PREVIOUS_RESPONSE_MISMATCH");
          }
          rotateConnection(session, job, rotation);
          job.payload = { ...job.payload, input: structuredClone(fullInput) };
          delete job.payload.previous_response_id;
          job.bytes = byteLength(job.payload) + byteLength(job.headers) + byteLength(job.config);
          previousId = null;
          reuseFullInput = false;
        }
        if (!previousId && !reuseFullInput) {
          if (session.binding !== job.binding) resetConnection(session, session.binding ? "configuration_or_identity_changed" : "initial_binding");
          session.prefix = [];
          session.confirmedAssistantOutput = null;
          session.previousId = null;
          session.nativeCompletedConfigHash = null;
          session.cacheBytes = 0;
        }
        session.binding = job.binding;
        session.bindingConfigHashes = null;
        session.bindingMetadataDiagnostic = null;
        session.bindingRawMetadataDiagnostic = null;
        job.cacheDecision = { reason: cacheReason,
          ...cacheState, mismatchIndex, ...(rotation ? { previousReason: cacheReason, ...rotation } : {}) };
        input = reuseFullInput ? job.payload.input.slice(session.prefix.length) : job.payload.input;
      } else {
        const previousPrefix = session.prefix;
        const mismatchIndex = session.prefix.findIndex((item, index) => !cachedInputMatches(session, item, job.payload.input[index], job.binding));
        const anchor = session.cancelledReasoningAnchor;
        const inserted = job.payload.input[mismatchIndex];
        const reuseCancelledAnchor = anchor?.cancelled === true && session.binding === job.binding
          && session.socket?.readyState === 1 && anchor.generation === session.generation
          && anchor.responseId === session.previousId && session.completedIds.has(anchor.previousId)
          && mismatchIndex >= anchor.requestInputItems && mismatchIndex < session.prefix.length
          && [undefined, "message"].includes(inserted?.type) && inserted?.role === "user"
          && (typeof inserted.content === "string" && inserted.content.length > 0
            || Array.isArray(inserted.content) && inserted.content.length > 0)
          && job.payload.input.slice(mismatchIndex).every(item => [undefined, "message"].includes(item?.type)
            && ["user", "developer"].includes(item?.role));
        if (reuseCancelledAnchor) {
          const proof = session.confirmedAssistantOutput;
          if (proof) for (let index = anchor.prefixItems; index < previousPrefix.length; index += 1) {
            if (proof.items.delete(previousPrefix[index])) proof.count -= 1;
          }
          session.prefix = previousPrefix.slice(0, anchor.prefixItems);
          session.previousId = anchor.previousId;
          session.previousComplete = true;
          session.cancelledReasoningAnchor = null;
          session.cacheBytes = byteLength(session.prefix) + Buffer.byteLength(session.previousId);
          job.cancelledReasoningAnchorReused = true;
        }
        const prefixMatches = reuseCancelledAnchor || session.prefix.length <= job.payload.input.length && mismatchIndex < 0;
        const connectionWasOpen = session.socket?.readyState === 1;
        const previousResponsePresent = Boolean(session.previousId);
        const cacheMissReasons = [!session.binding ? "initial" : session.binding !== job.binding ? "configuration_or_identity_changed" : null,
          !prefixMatches ? "input_prefix_changed" : null, !connectionWasOpen ? "connection_unavailable" : null,
          !previousResponsePresent ? "previous_response_unavailable" : null].filter(Boolean);
        const normalizedConfig = cacheConfiguration(job.config);
        const configHashes = Object.fromEntries(Object.entries(normalizedConfig).map(([key, value]) => [key, value === undefined ? "absent" : digest(value)]));
        const metadataSnapshot = session.bindingMetadataDiagnostic && session.bindingConfigHashes?.client_metadata === configHashes.client_metadata
          ? session.bindingMetadataDiagnostic : metadataDiagnostic(normalizedConfig);
        const clientMetadataChanges = changedMetadataPaths(session.bindingMetadataDiagnostic, metadataSnapshot);
        const rawMetadataSnapshot = metadataDiagnostic(cacheConfiguration(job.config, true));
        const rawClientMetadataChanges = changedMetadataPaths(session.bindingRawMetadataDiagnostic, rawMetadataSnapshot, true);
        const changedConfigFields = session.bindingConfigHashes ? [...new Set([...Object.keys(session.bindingConfigHashes), ...Object.keys(configHashes)])]
          .filter(key => session.bindingConfigHashes[key] !== configHashes[key]).slice(0, 12) : [];
        const before = mismatchIndex >= 0 ? JSON.parse(canonicalInput(previousPrefix[mismatchIndex])) : null;
        const afterValue = mismatchIndex >= 0 ? canonicalInput(job.payload.input[mismatchIndex]) : null;
        const after = afterValue ? JSON.parse(afterValue) : null;
        const shape = value => value === undefined ? "absent" : value === null ? "null" : Array.isArray(value) ? `array:${value.length}` : typeof value;
        const changedItemFields = before && after && typeof before === "object" && typeof after === "object"
          ? [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => canonical(before[key]) !== canonical(after[key])).slice(0, 8)
            .map(key => ({ field: key, before: shape(before[key]), after: shape(after[key]) })) : [];
        const metadataShape = item => {
          const metadata = item?.internal_chat_message_metadata_passthrough;
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { type: shape(metadata) };
          return { type: "object", keys: Object.keys(metadata).sort().slice(0, 24),
            fields: Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)).slice(0, 24)
              .map(([key, value]) => ({ key, type: shape(value), finite: key === "create_time" ? Number.isFinite(value) : undefined,
                keys: value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().slice(0, 12) : undefined })) };
        };
        const changedItemMetadata = changedItemFields.some(item => item.field === "internal_chat_message_metadata_passthrough")
          ? { cached: metadataShape(previousPrefix[mismatchIndex]), incoming: metadataShape(job.payload.input[mismatchIndex]),
            normalizedCached: metadataShape(before), normalizedIncoming: metadataShape(after) } : undefined;
        job.cacheDecision = { reason: !session.binding ? "initial" : session.binding !== job.binding ? "configuration_or_identity_changed"
          : !prefixMatches ? "input_prefix_changed" : reuseCancelledAnchor ? "cancelled_reasoning_anchor_reused"
            : session.socket?.readyState !== 1 ? "connection_unavailable" : "reused",
        changedConfigFields, clientMetadataChanges, rawClientMetadataChanges, connectionWasOpen, previousResponsePresent, cacheMissReasons,
        lastResetReason: session.lastResetReason ?? null, lastResetAt: session.lastResetAt ?? null,
        lastResetWasIdle: session.lastResetWasIdle ?? null, lastResetCloseCode: session.lastResetCloseCode ?? null,
        lastResetCloseCategory: session.lastResetCloseCategory ?? null,
        mismatchIndex, mismatchItemType: before?.type ?? null, changedItemFields, changedItemMetadata,
        previousInputItems: previousPrefix.length, incomingInputItems: job.payload.input.length,
        ...(reuseCancelledAnchor ? { anchorInputItems: anchor.prefixItems,
          discardedReasoningItems: previousPrefix.length - mismatchIndex,
          replayedInputItems: job.payload.input.length - anchor.prefixItems } : {}) };
        if (session.binding !== job.binding || !prefixMatches) resetConnection(session, !session.binding ? "initial_binding"
          : session.binding !== job.binding && !prefixMatches ? "configuration_and_input_prefix_changed"
            : session.binding !== job.binding ? "configuration_or_identity_changed" : "input_prefix_changed");
        const rotation = connectionAgeDecision(session, job, job.payload.input, !session.previousId,
          job.payload.input.slice(session.prefix.length));
        if (rotation) rotateConnection(session, job, rotation);
        session.binding = job.binding;
        session.bindingConfigHashes = configHashes;
        session.bindingMetadataDiagnostic = metadataSnapshot;
        session.bindingRawMetadataDiagnostic = rawMetadataSnapshot;
        input = job.payload.input.slice(session.prefix.length);
      }
      const packetPlan = planPackets(job, input, session.previousId);
      if (packetPlan.error) return failConnection(session, packetPlan.error);
      job.groups = packetPlan.groups;
      job.groupBytes = packetPlan.groupBytes;
      job.plan = packetPlan.plan;
      if (job.plan.length > 1) {
        const projectedCacheBytes = byteLength(job.nativeWebSocket ? [...session.prefix, ...input] : job.payload.input) + maxPreviousResponseIdBytes;
        const projectedRetainedBytes = retainedBytes(session) - session.cacheBytes
          + Math.max(session.cacheBytes, projectedCacheBytes) + maxMessageBytes;
        if (projectedRetainedBytes > maxSessionBytes) return failConnection(session, "session_bytes_exceeded");
      }
      await ensureConnection(session, job);
      if (!job.settled && session.active === job) sendNext(session, job);
    } catch {
      if (!job.settled) failConnection(session, "WS_CONNECTION_ERROR");
    }
  }

  function interrupt(job, settings, legacyHandoff = false) {
    const rejected = code => ({ ok: false, code });
    if (!job.nativeWebSocket && !legacyHandoff) return rejected("native_websocket_required");
    if (!settings || typeof settings !== "object") return rejected("invalid_interrupt");
    const { responseId, mode } = settings;
    if (typeof responseId !== "string" || !responseId || mode !== "discard_partial_items") return rejected("invalid_interrupt");
    const session = job.session;
    const packet = job.packet;
    if (job.settled || session?.active !== job || !packet || job.draining && !legacyHandoff) return rejected("no_active_response");
    if (packet.warm) {
      if (!packet.internalPrewarm || job.payload.generate === false || !job.atomicUntilVisibleOutput
        || !job.recoveryResponseId || job.recoveryResponseId !== responseId
        || job.generationEverStarted || job.outputObserved || job.visibleOutputCommitted) return rejected("prewarm_not_interruptible");
      if (packet.interruptSent) return rejected("duplicate_interrupt");
      if (session.socket?.readyState !== 1) return rejected("connection_unavailable");
      packet.interruptSent = true;
      job.record.interruptState = "queued";
      queueMicrotask(() => {
        if (job.settled || session.active !== job || job.packet !== packet) return;
        const response = job.response;
        const event = { type: "response.incomplete", response: { id: responseId, status: "incomplete",
          incomplete_details: { reason: "interrupted" }, output: [] } };
        job.record.interruptState = "acknowledged";
        job.record.interruptDiagnostics = { preparationOnly: true, generationSent: false };
        job.record.terminalOutcome = "interrupted";
        resetConnection(session, "preparation_interrupted");
        response.complete = true;
        settle(job, undefined, undefined, false, () => () => {
          if (!response.destroyed) response.write(`event: response.incomplete\ndata: ${JSON.stringify(event)}\n\n`);
        });
      });
      return { ok: true, code: "preparation_interrupted" };
    }
    if (!packet.establishedResponseId) return rejected("response_not_created");
    if (packet.establishedResponseId !== responseId) return rejected("response_id_mismatch");
    if (packet.interruptSent) return rejected("duplicate_interrupt");
    if (session.socket?.readyState !== 1) return rejected("connection_unavailable");
    packet.interruptSent = true;
    job.record.interruptState = "queued";
    const failed = error => {
      if (job.settled || session.active !== job || job.packet !== packet) return;
      job.record.interruptState = "failed";
      const failure = new Error("WebSocket interrupt send failed");
      failure.code = "WS_INTERRUPT_SEND_ERROR";
      failure.cause = error;
      job.request.emit("interruptError", failure);
      if (legacyHandoff) cancel(job, failure.code);
    };
    try {
      session.socket.send(JSON.stringify({ type: "response.interrupt", response_id: responseId, mode }), error => {
        if (error) failed(error);
        else if (!job.settled && session.active === job && job.packet === packet
          && job.record.interruptState === "queued") job.record.interruptState = "sent";
      });
      if (job.record.interruptState === "failed") return rejected("interrupt_send_failed");
      return { ok: true, code: "interrupt_sent" };
    } catch (error) {
      failed(error);
      return rejected("interrupt_send_failed");
    }
  }

  function createRequestClient({ sessionKey, turnId, operationId, payload, fullInput, recoveryResponseId, url, headers, onPreparationProgress, onPacketSending, onUploadProgress,
    retryWithoutOutput = false, nativeWebSocket = false, atomicUntilVisibleOutput = false, allowInterruptedContextRebuild = false, reasoningProgressBudget } = {}) {
    let currentRecord;
    let canonicalRecord;
    return {
      transport: "websocket",
      get operationAcceptance() { return currentRecord?.acceptance ?? false; },
      get requestTransmissionState() { return currentRecord?.requestTransmissionState ?? "not_sent"; },
      request(targetUrl, requestOptions = {}) {
        const existing = operations.get(operationId) ?? canonicalRecord;
        const retryable = canRetryOperation(existing, retryWithoutOutput);
        const duplicate = existing && !retryable;
        const record = duplicate ? { ...existing } : {
          operationId, state: "receiving_body", acceptance: false, reasonCode: null, requestTransmissionState: "not_sent",
          phase: "none", generation: 0, attempt: (existing?.attempt ?? 0) + 1,
          ...(nativeWebSocket === true ? { nativeWebSocket: true } : {}),
          ...(nativeWebSocket === true && atomicUntilVisibleOutput === true ? { atomicUntilVisibleOutput: true } : {}),
        };
        if (duplicate) {
          record.localRejection = true;
          record.previousFailure = { code: existing.reasonCode, acceptance: existing.acceptance,
            requestTransmissionState: existing.requestTransmissionState,
            upstreamCode: existing.upstreamError?.code ?? existing.upstreamError?.type };
        }
        if (duplicate && record.acceptance === false) record.acceptance = "unknown";
        const job = { record, operationId, sessionKey, turnId, fullInput: Array.isArray(fullInput) ? fullInput : null, nativeWebSocket: nativeWebSocket === true,
          recoveryResponseId: typeof recoveryResponseId === "string" ? recoveryResponseId : null,
          atomicUntilVisibleOutput: nativeWebSocket === true && atomicUntilVisibleOutput === true,
          allowInterruptedContextRebuild: nativeWebSocket === true && atomicUntilVisibleOutput === true && allowInterruptedContextRebuild === true,
          progressBudget: nativeWebSocket === true && atomicUntilVisibleOutput === true
            ? reasoningProgressBudget ?? createReasoningProgressBudget(maxSessionBytes) : null,
          visibleOutputCommitted: false, deferredOutputBytes: 0, settled: false, bytes: 0, session: null, response: null, timer: null,
          signal: requestOptions.signal, onPreparationProgress: onPreparationProgress ?? options.onPreparationProgress,
          onPacketSending: onPacketSending ?? options.onPacketSending,
          onUploadProgress: onUploadProgress ?? options.onUploadProgress };
        currentRecord = record;
        job.progressBudget?.setLimit(maxSessionBytes);
        pendingJobs.add(job);
        const request = new Writable({
          autoDestroy: false,
          write(_chunk, _encoding, callback) { callback(); },
          final(callback) {
            callback();
            queueMicrotask(() => {
              if (job.settled) return;
              if (duplicate) return settle(job, "duplicate_operation");
              if (closed) return settle(job, "transport_closed");
              if (stoppedTurns.has(canonical([sessionKey, turnId]))) return settle(job, "ABORT_ERR", undefined, true);
              if (job.validationError || !job.payload) return settle(job, job.validationError ?? "invalid_payload");
              const session = job.session ?? getSession(sessionKey);
              if (!session) return settle(job, "session_limit");
              job.session = session;
              session.receiving.delete(job);
              if (retainedBytes(session) + job.bytes > maxSessionBytes) return settle(job, "session_bytes_exceeded");
              record.state = "queued";
              session.queue.push(job);
              if (session.active?.draining && !job.response) createResponse(job);
              pump(session);
            });
          },
          destroy(error, callback) {
            if (job.draining && !job.settled) {
              job.response?.destroy();
              callback(transportError("ABORT_ERR", record));
            } else if (!job.settled) {
              cancel(job);
              callback(transportError(record.reasonCode, record));
            } else {
              callback(error);
            }
          },
        });
        job.request = request;
        request.on("error", noop);
        request.transport = "websocket";
        Object.defineProperties(request, {
          operationAcceptance: { get: () => record.acceptance },
          requestTransmissionState: { get: () => record.requestTransmissionState },
          canRetryWithoutOutput: { get: () => canRetryOperation(record, true) },
          recoveryReconciliationRequired: { get: () => operationRequiresReconciliation(record) },
          terminalOutcome: { get: () => record.terminalOutcome },
          terminalEvidence: { get: () => record.terminalEvidence },
        });
        request.abort = () => request.destroy();
        request.cancelAndDrain = () => cancelAndDrain(job);
        request.interrupt = settings => interrupt(job, settings);
        request.flushHeaders = noop;
        request.setTimeout = (milliseconds, callback) => {
          clearTimeout(job.requestTimer);
          if (callback) request.once("timeout", callback);
          if (milliseconds > 0) {
            job.requestTimer = setTimeout(() => request.emit("timeout"), milliseconds);
            job.requestTimer.unref?.();
          }
          return request;
        };
        if (!duplicate && !existing && operations.size >= maxOperations) {
          const liveRecords = new Set([...pendingJobs].map(pending => pending.record));
          for (const [key, value] of operations) {
            if (!liveRecords.has(value) && (value.state === "completed" || value.safeToEvict === true
              || ["failed", "cancelled"].includes(value.state) && value.acceptance === false)) {
              operations.delete(key);
              break;
            }
          }
        }
        if (!duplicate && operations.size >= maxOperations && !existing) {
          job.validationError = "operation_limit";
        } else if (!duplicate) {
          if (!existing) {
            operations.set(operationId, record);
            canonicalRecord = record;
          }
          try {
            if (typeof sessionKey !== "string" || !sessionKey || typeof operationId !== "string" || !operationId) throw new Error();
            const endpoint = new URL(url ?? targetUrl);
            if (!["ws:", "wss:"].includes(endpoint.protocol)) {
              job.validationError = "invalid_websocket_url";
              throw new Error();
            }
            job.url = endpoint.href;
            job.payload = structuredClone(payload);
            if (!Array.isArray(job.payload?.input)) throw new Error();
            if (job.nativeWebSocket && (job.payload.type !== "response.create"
              || job.payload.previous_response_id != null && (typeof job.payload.previous_response_id !== "string" || !job.payload.previous_response_id)
              || job.payload.generate !== undefined && typeof job.payload.generate !== "boolean")) throw new Error();
            job.headers = mergeHeaders(headers, requestOptions.headers);
            job.config = Object.fromEntries(Object.entries(job.payload).filter(([key]) => !ignoredFields.has(key)));
            if (!job.nativeWebSocket) job.config.store = false;
            if (job.nativeWebSocket) job.nativeConfigHash = digest(cacheConfiguration(job.config, false, true));
            const identity = Object.fromEntries(Object.entries(job.headers).filter(([key]) => ["authorization", "chatgpt-account-id", "proxy-authorization", "cookie", "x-api-key", "api-key", "openai-organization", "openai-project", "openai-beta"].includes(key.toLowerCase())).map(([key, value]) => [key.toLowerCase(), value]));
            job.binding = digest({ url: job.url, identity, config: job.nativeWebSocket ? { model: job.payload.model } : cacheConfiguration(job.config),
              ...(job.nativeWebSocket ? { nativeWebSocket: true } : {}) });
            if (existing?.atomicUntilVisibleOutput
              && (!job.atomicUntilVisibleOutput || sessionKey !== existing.retrySessionKey || turnId !== existing.retryTurnId
                || job.binding !== existing.retryBinding || digest(job.config) !== existing.retryConfigFingerprint
                || job.payload.previous_response_id != null
                || ![existing.retryInputFingerprint, existing.retryFullInputFingerprint]
                  .includes(digest(job.payload.input.map(canonicalInput))))) {
              job.validationError = "unverified_output_recovery";
              record.localRejection = true;
              record.permanentRejection = true;
            }
            if (job.atomicUntilVisibleOutput) {
              record.retryBinding = job.binding;
              record.retrySessionKey = sessionKey;
              record.retryTurnId = turnId;
              record.retryConfigFingerprint = digest(job.config);
              record.retryInputFingerprint = job.payload.previous_response_id ? null : digest(job.payload.input.map(canonicalInput));
            }
            job.agent = requestOptions.agent ?? options.agent;
            job.bytes = byteLength(job.payload) + byteLength(job.headers) + byteLength(job.config);
            if (job.bytes > maxSessionBytes) {
              job.payload = null;
              job.headers = null;
              job.config = null;
              job.bytes = 0;
              job.validationError = "session_bytes_exceeded";
            }
            if (job.payload && !job.validationError) {
              const session = getSession(sessionKey);
              if (!session || retainedBytes(session) + job.bytes > maxSessionBytes) {
                job.payload = null;
                job.headers = null;
                job.config = null;
                job.bytes = 0;
                job.validationError = session ? "session_bytes_exceeded" : "session_limit";
              } else {
                job.session = session;
                session.receiving.add(job);
              }
            }
            if (job.nativeWebSocket && job.payload && !job.validationError && job.payload.generate !== false && isNativeCompaction(job.payload, job.headers)) {
              job.compactionDeadline = performance.now() + compactionAttemptTimeoutMs;
              job.compactionTimer = setTimeout(() => {
                if (job.settled) return;
                if (job.session?.active === job) failConnection(job.session, "WS_TERMINAL_TIMEOUT");
                else settle(job, "WS_TERMINAL_TIMEOUT");
              }, compactionAttemptTimeoutMs);
              job.compactionTimer.unref?.();
            }
          } catch {
            job.payload = null;
            job.validationError ??= "invalid_payload";
          }
          if (existing && !job.validationError) {
            operations.set(operationId, record);
            canonicalRecord = record;
          }
        }
        if (job.signal) {
          job.onAbort = () => request.destroy();
          job.signal.addEventListener("abort", job.onAbort, { once: true });
          if (job.signal.aborted) queueMicrotask(job.onAbort);
        }
        return request;
      },
    };
  }

  return {
    createRequestClient,
    cancelTurn({ threadId, turnId } = {}) {
      if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return false;
      stoppedTurns.set(canonical([threadId, turnId]), true);
      while (stoppedTurns.size > maxOperations) stoppedTurns.delete(stoppedTurns.keys().next().value);
      const matches = [...pendingJobs].filter(job => job.sessionKey === threadId && job.turnId === turnId && !job.settled);
      for (const job of matches) if (job.session?.active !== job) cancel(job);
      for (const job of matches) {
        if (job.settled) continue;
        const carrier = job.packet?.warm && !job.generationEverStarted && !job.outputObserved;
        if (carrier && job.draining && refreshWarmConsumer(job) && job.warmConsumer.turnId !== turnId) continue;
        if (job.draining && job.drainMode === "interrupt") continue;
        cancel(job);
      }
      const session = sessions.get(threadId);
      const carrier = session?.active;
      if (carrier?.draining && carrier.packet?.warm && !refreshWarmConsumer(carrier)) cancel(carrier);
      return matches.length > 0;
    },
    getOperation(operationId) { return metadata(operations.get(operationId)); },
    completeHttpFallback(operationId, { approvedFallback = false } = {}) {
      const record = operations.get(operationId);
      if (!record || record.nativeWebSocket || operationRequiresReconciliation(record) || !["failed", "cancelled"].includes(record.state)
        || !(record.retryableWithoutOutput || approvedFallback && record.httpFallbackEligible) || record.localRejection
        || [...pendingJobs].some(job => job.record === record)) return false;
      record.state = "completed";
      record.reasonCode = "http_fallback_completed";
      record.fallbackCompletion = { transport: "http", websocketAcceptance: record.acceptance,
        websocketTransmissionState: record.requestTransmissionState };
      record.acceptance = true;
      record.requestTransmissionState = "completed";
      record.retryableWithoutOutput = false;
      record.httpFallbackEligible = false;
      return true;
    },
    invalidate(sessionKey, _reason) {
      const session = sessions.get(sessionKey);
      if (!session) return false;
      failConnection(session, "session_invalidated");
      if (!session.queue.length && !session.active && !session.streams.size && !session.receiving.size) sessions.delete(sessionKey);
      return true;
    },
    status() {
      const all = [...sessions.values()];
      return {
        closed, sessions: sessions.size, connections: all.filter(session => session.socket).length,
        active: all.filter(session => session.active).length, queued: all.reduce((sum, session) => sum + session.queue.length, 0),
        receiving: all.reduce((sum, session) => sum + session.receiving.size, 0),
        retainedBytes: all.reduce((sum, session) => sum + retainedBytes(session), 0), operations: operations.size,
        unknownOperations: [...operations.values()].filter(record => record.acceptance === "unknown").length,
        maxSessions, maxSessionBytes, maxMessageBytes, interruptiblePrewarmBytes, maxOperations, maxPreviousResponseIdBytes,
        previousResponseIdLimitScope: "local_policy", responseTimeoutMs, compactionAttemptTimeoutMs, prewarmTimeoutMs, warmHandoffGraceMs,
        interruptTimeoutMs, interruptHandoffTimeoutMs, allowImagePrewarm,
        websocketFragmentBytes, websocketAcknowledgementBytes, uploadAcknowledgementTimeoutMs,
        websocketMaxUploadWindow, websocketUploadQueueBudgetMs,
        connectionLifetimeMs, connectionFullInputRotationMs, connectionRotationMs, connectionSafetyMs,
        connectionGenerationBudgetMs, connectionUploadBytesPerSecond,
      };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of [...pendingJobs]) {
        if (!job.session) settle(job, "transport_closed", undefined, true);
      }
      for (const session of sessions.values()) {
        const jobs = [session.active, ...session.queue, ...session.receiving].filter(Boolean);
        resetConnection(session, "transport_closed");
        for (const job of jobs) settle(job, "transport_closed", undefined, true);
        for (const response of session.streams) response.destroy();
        session.streams.clear();
      }
      sessions.clear();
      stoppedTurns.clear();
    },
  };
}
