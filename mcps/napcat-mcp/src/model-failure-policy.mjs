const terminalEvidenceRegistry = new WeakMap();

export function createModelFailureTerminalEvidence({ operationId, attempt, generation, packetSequence, responseId, statusCode, error } = {}) {
  if (typeof operationId !== "string" || !operationId || typeof responseId !== "string" || !responseId
    || ![attempt, generation, packetSequence].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError("Invalid terminal evidence identity");
  }
  const evidence = Object.freeze({ outcome: "failed_no_output", operationId, attempt, generation, packetSequence,
    responseId, statusCode, responseStatus: "failed", outputCount: 0 });
  terminalEvidenceRegistry.set(evidence, { error: error === undefined ? null : JSON.parse(JSON.stringify(error)) });
  return evidence;
}

const CODE_GROUPS = [
  ["cancelled", false, false, ["abort_err", "err_aborted", "err_canceled", "cancelled", "canceled", "request_cancelled", "request_canceled"]],
  ["safety", true, false, ["content_policy_violation", "content_policy_error", "content_filter", "safety_violation", "safety_error", "safety_policy_violation", "moderation_blocked", "bio_policy", "cyber_policy", "misalignment_policy_violation", "invalid_prompt"]],
  ["authentication", true, false, ["authentication_error", "authentication_failed", "invalid_api_key", "invalid_authentication", "invalid_token", "token_expired", "unauthorized", "permission_denied", "access_denied", "forbidden"]],
  ["quota", true, false, ["usage_limit_exceeded", "usage_limit_reached", "insufficient_quota", "insufficient_credits", "quota_exceeded", "quota_exhausted", "billing_hard_limit_reached", "billing_hard_limit_exceeded", "billing_limit_exceeded", "billing_not_active", "credit_balance_too_low", "credits_exhausted", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "usage_not_included"]],
  ["payload_too_large", true, false, ["payload_too_large", "request_too_large", "message_too_big", "request_entity_too_large", "ws_message_too_large", "unsupported_image_prewarm", "session_bytes_exceeded"]],
  ["transport_capacity", false, false, ["session_limit", "operation_limit"]],
  ["permanent", true, false, ["invalid_request_error", "invalid_request", "invalid_argument", "context_length_exceeded", "model_not_found", "unsupported_parameter", "unsupported_value"]],
  ["temporary", true, false, ["rate_limit_exceeded", "rate_limit_error", "too_many_requests", "overloaded_error", "engine_overloaded"]],
  ["temporary", false, false, ["server_error", "internal_server_error", "service_unavailable", "temporarily_unavailable"]],
  ["temporary", false, true, ["econnreset", "econnrefused", "econnaborted", "etimedout", "enotfound", "eai_again", "enetunreach", "ehostunreach", "epipe", "err_network", "err_socket_closed", "err_stream_premature_close", "err_tls_handshake_timeout", "und_err_connect_timeout", "und_err_headers_timeout", "und_err_body_timeout", "und_err_socket", "fetch_failed", "connection_failed", "ws_connection_error", "ws_connect_timeout", "ws_connection_closed", "ws_send_error", "ws_terminal_timeout",
    "first_progress_timeout", "progress_idle_timeout", "upstream_idle_timeout", "ws_prewarm_timeout",
    "previous_response_not_found", "websocket_connection_limit_reached", "stream_ended_without_completion",
    "stream_error", "upstream_error", "compaction_incomplete", "compaction_timeout", "compaction_stream_error"]],
];

const CODE_RULES = new Map(CODE_GROUPS.flatMap(([category, remoteRejection, networkFailure, codes], priority) =>
  codes.map(code => [code, { category, remoteRejection, networkFailure, priority }])));

const REJECTION_STATUSES = new Set([400, 401, 402, 403, 404, 405, 406, 410, 411, 412, 413, 414, 415, 416, 417, 421, 422, 425, 426, 428, 429, 431, 451, 501, 503, 505]);

const MESSAGE_RULES = [
  ["safety", "safety_rejection", /^(?:request (?:was )?(?:blocked|rejected) (?:by|due to) (?:the )?(?:safety|content policy)|content policy violation\b|safety policy violation\b)/i],
  ["authentication", "authentication_failed", /^(?:invalid api key\b|incorrect api key\b|authentication (?:failed|required)\b|unauthorized\b|(?:access |authentication )?token (?:has )?expired\b|please (?:sign|log) in again\b)/i],
  ["quota", "quota_exhausted", /^(?:you(?: have|'ve)? (?:exceeded|reached|hit) your (?:current )?(?:quota|usage limit)\b|(?:your )?(?:quota|usage limit) (?:has been )?(?:reached|exceeded|exhausted)\b|insufficient (?:quota|credits)\b|(?:your )?credit balance (?:is )?too low\b)/i],
  ["payload_too_large", "payload_too_large", /^(?:request (?:entity|body|payload) too large\b|payload too large\b|message too (?:big|large)\b)/i],
  ["temporary", "rate_limit_exceeded", /^(?:rate limit (?:reached|exceeded)\b|too many requests\b)/i],
  ["temporary", "network_failure", /^(?:fetch failed\b|network (?:error|failure)\b|socket hang up\b|connection (?:reset|refused|timed out|closed)\b|client network socket disconnected before secure tls connection was established\b)/i],
];

function normalizedEnum(value, allowed) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(normalized) ? normalized : "unknown";
}

function numericCode(value, minimum, maximum) {
  const normalized = typeof value === "string" && /^\d{3,4}$/.test(value.trim()) ? Number(value.trim()) : value;
  return Number.isInteger(normalized) && normalized >= minimum && normalized <= maximum ? normalized : undefined;
}

function recognizedCode(value) {
  if (typeof value !== "string" || value.length > 80) return undefined;
  const code = value.trim();
  const rule = CODE_RULES.get(code.toLowerCase());
  return rule ? { ...rule, code } : undefined;
}

function collectSignals(code, message) {
  const codes = [];
  const messages = [];
  const seen = new WeakSet();
  let complete = true;
  const directCode = recognizedCode(code);
  if (directCode) codes.push(directCode);
  const pending = [{ value: message, depth: 0 }];
  for (let visited = 0; pending.length && visited < 32; visited++) {
    const { value, depth } = pending.shift();
    if (typeof value === "string") {
      const bounded = value.slice(0, 8192).trim();
      messages.push(bounded);
      const messageCode = recognizedCode(bounded);
      if (messageCode) codes.push(messageCode);
      if (value.length > 8192) complete = false;
      if (/^[{"]/.test(bounded)) {
        if (depth >= 8 || value.length > 8192) {
          complete = false;
          continue;
        }
        try {
          pending.push({ value: JSON.parse(bounded), depth: depth + 1 });
        } catch {
          complete = false;
        }
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value)) {
        complete = false;
        continue;
      }
      seen.add(value);
      const nestedCode = recognizedCode(value.code);
      if (nestedCode) codes.push(nestedCode);
      const nestedType = recognizedCode(value.type);
      if (nestedType) codes.push(nestedType);
      for (const key of ["error", "response", "cause", "message"]) {
        if (Object.hasOwn(value, key)) {
          if (depth < 8) pending.push({ value: value[key], depth: depth + 1 });
          else complete = false;
        }
      }
    } else if (value !== undefined && value !== null) {
      complete = false;
    }
  }
  codes.sort((left, right) => left.priority - right.priority);
  return { code: codes[0], messages, complete: complete && pending.length === 0 };
}

function messageDiagnosis(messages) {
  for (const [category, reasonCode, pattern] of MESSAGE_RULES) {
    if (messages.some(message => pattern.test(message))) {
      const networkFailure = reasonCode === "network_failure";
      return { category, reasonCode, remoteRejection: !networkFailure, networkFailure, evidence: "message" };
    }
  }
  return undefined;
}

function statusDiagnosis(statusCode) {
  if (statusCode === undefined || statusCode < 400) return undefined;
  let category = "permanent";
  if (statusCode === 401 || statusCode === 403) category = "authentication";
  else if (statusCode === 402) category = "quota";
  else if (statusCode === 413) category = "payload_too_large";
  else if ([408, 425, 429].includes(statusCode) || (statusCode >= 500 && ![501, 505].includes(statusCode))) category = "temporary";
  return { category, reasonCode: `http_${statusCode}`, remoteRejection: REJECTION_STATUSES.has(statusCode), networkFailure: false, evidence: "status" };
}

function diagnose(failure, signals, statusCode, wsCloseCode) {
  if (wsCloseCode === 1009) {
    return { category: "payload_too_large", reasonCode: "ws_close_1009", remoteRejection: false, networkFailure: false };
  }
  if (failure.cancelled === true || signals.code?.category === "cancelled") {
    return { category: "cancelled", reasonCode: "request_cancelled", remoteRejection: false, networkFailure: false };
  }
  if (signals.code && signals.code.category !== "temporary") {
    return { ...signals.code, reasonCode: signals.code.code, evidence: "code" };
  }
  const status = statusDiagnosis(statusCode);
  if ([401, 402, 413].includes(statusCode)) return status;
  const message = messageDiagnosis(signals.messages);
  if (message && message.category !== "temporary") return message;
  if (statusCode === 503) return status;
  if (signals.code) return { ...signals.code, reasonCode: signals.code.code, evidence: "code" };
  return message ?? status;
}

function requestAcceptance(failure, transmission, source, diagnosis, statusCode) {
  if (failure.requestAccepted === true || failure.responseStarted === true || failure.progressObserved === true || failure.toolDelivered === true) return "accepted";
  if (transmission === "not_started" || transmission === "not_sent") return "not_sent";
  if (failure.requestAccepted === false) return "rejected";
  if (failure.requestAccepted !== undefined) return "unknown";
  if (source !== "local" && source !== "transport") {
    if (REJECTION_STATUSES.has(statusCode) || diagnosis?.evidence === "code" && diagnosis.remoteRejection) return "rejected";
    if ((source === "http" || source === "sse") && diagnosis?.remoteRejection) return "rejected";
  }
  return "unknown";
}

export function classifyModelFailure(failure = {}) {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) failure = {};
  const terminalEvidence = terminalEvidenceRegistry.get(failure.terminalEvidence);
  const statusCode = numericCode(failure.statusCode, 100, 599)
    ?? (terminalEvidence ? numericCode(failure.terminalEvidence.statusCode, 100, 599) : undefined);
  const wsCloseCode = numericCode(failure.wsCloseCode, 1000, 4999);
  const source = normalizedEnum(failure.source, ["http", "sse", "transport", "local"]);
  const transmission = normalizedEnum(failure.requestTransmissionState, ["not_started", "not_sent", "connecting",
    "prewarm_sent", "generation_sent", "response_received", "completed", "started", "finished", "unknown"]);
  const signals = collectSignals(failure.code, terminalEvidence
    ? { error: terminalEvidence.error, message: failure.message } : failure.message);
  const diagnosis = diagnose(failure, signals, statusCode, wsCloseCode);
  const acceptance = requestAcceptance(failure, transmission, source, diagnosis, statusCode);
  let category = diagnosis?.category ?? (acceptance === "unknown" ? "acceptance_unknown" : "permanent");
  if (diagnosis?.networkFailure && acceptance === "unknown" && statusCode !== 503) category = "acceptance_unknown";
  const terminalNoOutput = Boolean(terminalEvidence) && ["sse", "transport"].includes(source)
    && failure.progressObserved !== true && failure.toolDelivered !== true && failure.cancelled !== true;
  const reconnectWithoutOutput = ["temporary", "acceptance_unknown"].includes(category)
    && failure.progressObserved === false && failure.toolDelivered !== true && failure.cancelled !== true;
  const retryable = reconnectWithoutOutput || category === "temporary" && signals.complete
    && (acceptance === "not_sent" || acceptance === "rejected" || terminalNoOutput);
  const invalidateSession = statusCode === 503 || wsCloseCode === 1009 || category === "payload_too_large"
    || source === "transport" || diagnosis?.networkFailure === true || acceptance === "accepted" || acceptance === "unknown";
  const reasonCode = signals.code?.code ?? diagnosis?.reasonCode ?? "unknown_failure";
  const httpCompatibilityFallback = category === "permanent" && signals.complete
    && ["unsupported_parameter", "unsupported_value"].includes(reasonCode)
    && ![401, 402, 403, 451].includes(statusCode)
    && !["safety", "authentication", "quota"].includes(messageDiagnosis(signals.messages)?.category)
    && failure.progressObserved === false && failure.toolDelivered !== true && failure.cancelled !== true
    && (["not_sent", "rejected"].includes(acceptance) || terminalNoOutput);
  return Object.freeze({
    category,
    retryable,
    acceptance,
    invalidateSession,
    reasonCode,
    ...(httpCompatibilityFallback ? { httpCompatibilityFallback: true } : {}),
    ...(terminalNoOutput ? { terminalOutcome: "failed_no_output" } : {}),
  });
}
