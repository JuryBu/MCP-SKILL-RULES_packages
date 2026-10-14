const TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const AUTHENTICATION_CODES = new Set([
  "invalid_api_key", "invalid_authorization", "authentication_error", "authentication_failed",
  "unauthorized", "unauthorised", "token_expired", "invalid_token",
]);
const SECURITY_CODES = new Set([
  "bio_policy", "content_filter", "content_policy_violation", "cyber_policy",
  "misalignment_policy_violation", "invalid_prompt",
]);
const USAGE_CODES = new Set([
  "usage_limit_reached", "usage_limit_exceeded", "quota_exceeded", "insufficient_quota",
  "credit_balance_exhausted", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "usage_not_included",
]);
const MAX_SIGNAL_BODY_BYTES = 64 * 1024;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function headerText(headers, name) {
  const value = headers?.[name];
  return typeof value === "string" ? value.slice(0, 512) : "";
}

function responseFormat(headers) {
  const mime = headerText(headers, "content-type").split(";", 1)[0].trim().toLowerCase();
  if (!mime) return "unknown";
  if (mime === "text/event-stream") return "sse";
  if (mime === "text/html") return "html";
  if (mime === "application/json" || /^application\/[a-z0-9.+-]+\+json$/u.test(mime)) return "json";
  return "other";
}

export function createModelStreamFailureDiagnostics() {
  let socketAssigned = false;
  let connectionObserved = false;
  let tlsObserved = false;
  let reusedSocket = false;
  let requestFinished = false;
  let requestBodyBytes = 0;
  let responseStarted = false;
  let statusCode = 0;
  let responseBytes = 0;
  let format = "unknown";
  let cfRayHeaderPresent = false;
  let errorSource = "unknown";
  let transportCode = "unknown";
  let challengeSignal = false;
  let authenticationSignal = false;
  let securitySignal = false;
  let usageLimitSignal = false;

  return {
    socketAssigned(details = {}) {
      socketAssigned = true;
      reusedSocket = details.reusedSocket === true;
      if (reusedSocket) connectionObserved = true;
    },
    connected(tls = false) {
      connectionObserved = true;
      if (tls === true) tlsObserved = true;
    },
    requestFinished(bodyBytes) {
      requestFinished = true;
      requestBodyBytes = count(bodyBytes);
    },
    responseStarted(status, headers) {
      responseStarted = true;
      statusCode = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
      format = responseFormat(headers);
      cfRayHeaderPresent = headerText(headers, "cf-ray").length > 0;
      if (statusCode >= 400) {
        challengeSignal = headerText(headers, "cf-mitigated").trim().toLowerCase() === "challenge";
        authenticationSignal = headerText(headers, "www-authenticate").trim().length > 0;
      }
    },
    responseData(byteLength) {
      responseBytes = Math.min(Number.MAX_SAFE_INTEGER, responseBytes + count(byteLength));
    },
    httpFailure(body, failure = {}) {
      if (statusCode < 400) return;
      const code = typeof failure?.code === "string" ? failure.code : "";
      authenticationSignal ||= AUTHENTICATION_CODES.has(code);
      securitySignal ||= SECURITY_CODES.has(code) || failure?.safetyPolicy === true;
      usageLimitSignal ||= USAGE_CODES.has(code) || failure?.category === "usage_limit";
      if (format === "html" && Buffer.isBuffer(body)) {
        const text = body.subarray(0, MAX_SIGNAL_BODY_BYTES).toString("utf8");
        challengeSignal ||= text.includes("/cdn-cgi/challenge-platform/");
      }
    },
    transportError(source, error) {
      errorSource = source === "request" || source === "response" ? source : "unknown";
      transportCode = TRANSPORT_CODES.has(error?.code) ? error.code : "unknown";
    },
    snapshot(progress = {}) {
      const responseFrames = count(progress.frames);
      const progressObserved = progress.progressObserved === true;
      const stage = progressObserved ? "stream_progress" : responseFrames > 0 ? "stream_frames"
        : responseBytes > 0 ? "response_body" : responseStarted ? "response_headers"
          : requestFinished ? "awaiting_response" : connectionObserved ? "request_sending"
            : socketAssigned ? "connection" : "unknown";
      const signals = [challengeSignal, authenticationSignal, securitySignal, usageLimitSignal];
      const signalCount = signals.filter(Boolean).length;
      const httpRefusalSignal = signalCount > 1 ? "multiple" : challengeSignal ? "challenge"
        : authenticationSignal ? "authentication" : securitySignal ? "security"
          : usageLimitSignal ? "usage_limit" : "unknown";
      return { version: 1, stage, errorSource, transportCode, socketAssigned, connectionObserved,
        tlsObserved, reusedSocket, requestFinished, requestBodyBytes, responseStarted, statusCode,
        responseBytes, responseFrames, progressObserved, responseFormat: format, cfRayHeaderPresent,
        httpRefusalSignal, challengeSignal, authenticationSignal, securitySignal, usageLimitSignal };
    },
  };
}
