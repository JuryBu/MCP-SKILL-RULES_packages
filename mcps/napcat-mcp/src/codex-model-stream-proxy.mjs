import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024;
const ABORT_CONFIRM_TIMEOUT_MS = 2_000;
const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
const MAX_METADATA_HEADER_BYTES = 64 * 1024;
const SAFE_REPLAY_TOOL_TYPES = new Set(["function", "custom", "local_shell"]);
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

function parseTurnMetadata(headers) {
  const raw = headerValue(headers, "x-codex-turn-metadata");
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_METADATA_HEADER_BYTES) {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function classifyCodexModelRequest(request) {
  const metadata = parseTurnMetadata(request?.headers ?? {});
  const requestKind = typeof metadata?.request_kind === "string" ? metadata.request_kind : null;
  return {
    requestKind,
    guarded: requestKind === "turn",
    threadId: typeof metadata?.thread_id === "string" ? metadata.thread_id : null,
    turnId: typeof metadata?.turn_id === "string" ? metadata.turn_id : null,
  };
}

function hasReplaySafeTools(body) {
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  if (payload?.stream !== true) return false;
  if (!Array.isArray(payload?.tools)) return true;
  return payload.tools.every((tool) => {
    const type = typeof tool?.type === "string" ? tool.type : null;
    return type !== null && SAFE_REPLAY_TOOL_TYPES.has(type);
  });
}

function eventPayloadHasContent(event) {
  if (!event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "response.completed" || type === "response.failed" || type === "error") return true;
  if (!type.endsWith(".delta")) return false;
  for (const key of ["delta", "text", "arguments", "input", "code"]) {
    const value = event[key];
    if (typeof value === "string" && value.length > 0) return true;
  }
  return false;
}

export function isMeaningfulResponsesSseFrame(frame) {
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  if (data.trim() === "[DONE]") return true;
  try {
    return eventPayloadHasContent(JSON.parse(data));
  } catch {
    return false;
  }
}

function createSseProgressParser(onMeaningful) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let meaningful = false;
  return {
    push(chunk) {
      if (meaningful) return;
      pending += decoder.write(chunk);
      while (!meaningful) {
        const match = /\r?\n\r?\n/u.exec(pending);
        if (!match) break;
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (isMeaningfulResponsesSseFrame(frame)) {
          meaningful = true;
          onMeaningful();
        }
      }
    },
    end() {
      if (meaningful) return;
      pending += decoder.end();
      if (pending && isMeaningfulResponsesSseFrame(pending)) {
        meaningful = true;
        onMeaningful();
      }
    },
    get meaningful() {
      return meaningful;
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

function hashIdentity(value) {
  return typeof value === "string" && value.length > 0
    ? crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)
    : null;
}

function requestClient(url) {
  if (url.protocol === "https:") return https;
  if (url.protocol === "http:") return http;
  throw new Error(`Unsupported upstream protocol: ${url.protocol}`);
}

function retryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
}

function collectRequestBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        reject(Object.assign(new Error("request body exceeded guarded replay limit"), { code: "BODY_LIMIT_EXCEEDED" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks, length)));
    request.once("aborted", () => reject(Object.assign(new Error("downstream request aborted"), { code: "DOWNSTREAM_ABORTED" })));
    request.once("error", reject);
  });
}

function forwardPassthrough(request, response, targetUrl, onEvent) {
  const client = requestClient(targetUrl);
  const upstream = client.request(targetUrl, {
    method: request.method,
    headers: sanitizeForwardHeaders(request.headers, targetUrl.host),
  });
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

function guardedAttempt(options) {
  const {
    body,
    downstream,
    headers,
    method,
    targetUrl,
    timeoutMs,
    attempt,
    maxAttempts,
    onEvent,
    requestState,
  } = options;
  return new Promise((resolve) => {
    const client = requestClient(targetUrl);
    const attemptId = crypto.randomUUID();
    let upstreamResponse = null;
    let committed = false;
    let settled = false;
    let bufferedChunks = [];
    let bufferedBytes = 0;
    let timer = null;
    let abortConfirmationTimer = null;
    let abortPending = null;

    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(abortConfirmationTimer);
      resolve({ ...outcome, attemptId, committed });
    };
    const abortAttempt = (reason) => {
      if (upstreamResponse) upstreamResponse.destroy();
      upstream.destroy(Object.assign(new Error(reason), { code: reason }));
    };
    const abortAndConfirm = (reason, retry) => {
      if (settled || abortPending) return;
      abortPending = { reason, retry };
      clearTimeout(timer);
      upstream.once("close", () => {
        onEvent({ type: "attempt_abort_confirmed", attempt, attemptId, reason });
        settle({ retry, reason });
      });
      abortConfirmationTimer = setTimeout(() => {
        onEvent({ type: "attempt_abort_unconfirmed", attempt, attemptId, reason });
        settle({ retry: false, reason: `${reason}_ABORT_UNCONFIRMED` });
      }, ABORT_CONFIRM_TIMEOUT_MS);
      abortConfirmationTimer.unref?.();
      abortAttempt(reason);
    };
    const commit = () => {
      if (committed || settled || requestState.cancelled || downstream.destroyed) return;
      committed = writeHeadOnce(
        downstream,
        upstreamResponse?.statusCode ?? 502,
        upstreamResponse?.statusMessage,
        upstreamResponse?.headers ?? {},
      );
      if (!committed) return;
      clearTimeout(timer);
      for (const chunk of bufferedChunks) downstream.write(chunk);
      bufferedChunks = [];
      bufferedBytes = 0;
      onEvent({ type: "attempt_committed", attempt, attemptId });
    };

    const upstream = client.request(targetUrl, {
      method,
      headers: {
        ...sanitizeForwardHeaders(headers, targetUrl.host, body.length),
        "accept-encoding": "identity",
      },
    });
    requestState.currentAbort = () => abortAndConfirm("DOWNSTREAM_CANCELLED", false);
    timer = setTimeout(() => {
      if (committed || settled || requestState.cancelled) return;
      onEvent({ type: "attempt_no_progress_timeout", attempt, attemptId, timeoutMs });
      abortAndConfirm("NO_MEANINGFUL_PROGRESS", attempt < maxAttempts);
    }, timeoutMs);
    timer.unref?.();

    upstream.once("response", (response) => {
      upstreamResponse = response;
      const statusCode = response.statusCode ?? 502;
      if (retryableStatus(statusCode) && attempt < maxAttempts) {
        response.resume();
        response.once("end", () => settle({ retry: true, reason: `HTTP_${statusCode}` }));
        response.once("error", () => settle({ retry: true, reason: `HTTP_${statusCode}` }));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      if (statusCode < 200 || statusCode >= 300 || !contentType.includes("text/event-stream")) {
        commit();
      }
      const parser = createSseProgressParser(commit);
      response.on("data", (chunk) => {
        if (settled || requestState.cancelled) return;
        if (committed) {
          if (!downstream.write(chunk)) response.pause();
          return;
        }
        bufferedChunks.push(chunk);
        bufferedBytes += chunk.length;
        parser.push(chunk);
      });
      downstream.on("drain", () => response.resume());
      response.once("end", () => {
        parser.end();
        if (requestState.cancelled) return settle({ retry: false, reason: "DOWNSTREAM_CANCELLED" });
        if (committed) {
          downstream.end();
          return settle({ retry: false, reason: "COMPLETED" });
        }
        if (parser.meaningful) {
          commit();
          downstream.end();
          return settle({ retry: false, reason: "COMPLETED" });
        }
        onEvent({ type: "attempt_ended_without_progress", attempt, attemptId, bufferedBytes });
        settle({ retry: attempt < maxAttempts, reason: "ENDED_WITHOUT_MEANINGFUL_PROGRESS" });
      });
      response.once("error", (error) => {
        if (abortPending) return;
        if (committed) {
          downstream.destroy(error);
          settle({ retry: false, reason: error.code ?? "STREAM_ERROR" });
        } else {
          settle({ retry: attempt < maxAttempts, reason: error.code ?? "STREAM_ERROR" });
        }
      });
    });
    upstream.once("error", (error) => {
      if (settled || abortPending) return;
      if (committed) downstream.destroy(error);
      settle({ retry: !committed && attempt < maxAttempts, reason: error.code ?? "UPSTREAM_ERROR" });
    });
    upstream.end(body);
  });
}

export function createCodexModelStreamProxy(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = integerOption(options.port, 18435, 0, 65535, "port");
  const upstreamOrigin = new URL(options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN);
  const firstProgressTimeoutMs = integerOption(
    options.firstProgressTimeoutMs,
    DEFAULT_FIRST_PROGRESS_TIMEOUT_MS,
    10,
    300_000,
    "firstProgressTimeoutMs",
  );
  const maxBufferedRequestBytes = integerOption(
    options.maxBufferedRequestBytes,
    DEFAULT_MAX_BUFFERED_REQUEST_BYTES,
    1_024,
    256 * 1024 * 1024,
    "maxBufferedRequestBytes",
  );
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const active = new Map();
  const counters = {
    total: 0,
    guarded: 0,
    passthrough: 0,
    retries: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, activeRequests: active.size, counters }));
      return;
    }
    counters.total += 1;
    const identity = classifyCodexModelRequest(request);
    const requestId = crypto.randomUUID();
    const requestState = { cancelled: false, currentAbort: null };
    active.set(requestId, requestState);
    const emit = (event) => onEvent({
      at: new Date().toISOString(),
      requestId,
      requestKind: identity.requestKind,
      threadHash: hashIdentity(identity.threadId),
      turnHash: hashIdentity(identity.turnId),
      ...event,
    });
    const finish = () => active.delete(requestId);
    response.once("close", () => {
      if (response.writableEnded) return;
      requestState.cancelled = true;
      requestState.currentAbort?.();
      counters.cancelled += 1;
      emit({ type: "downstream_cancelled" });
      finish();
    });
    const targetUrl = new URL(request.url ?? "/", upstreamOrigin);
    const declaredLength = Number(headerValue(request.headers, "content-length"));
    const canBuffer = Number.isSafeInteger(declaredLength)
      && declaredLength >= 0
      && declaredLength <= maxBufferedRequestBytes;
    if (!identity.guarded || request.method !== "POST" || !canBuffer) {
      counters.passthrough += 1;
      emit({ type: "passthrough", reason: !identity.guarded ? "request_kind" : "body_not_replayable" });
      forwardPassthrough(request, response, targetUrl, emit);
      response.once("finish", finish);
      return;
    }

    try {
      const body = await collectRequestBody(request, maxBufferedRequestBytes);
      if (!hasReplaySafeTools(body)) {
        counters.passthrough += 1;
        emit({ type: "buffered_passthrough", reason: "hosted_or_unknown_tools" });
        const client = requestClient(targetUrl);
        const upstream = client.request(targetUrl, {
          method: request.method,
          headers: sanitizeForwardHeaders(request.headers, targetUrl.host, body.length),
        });
        upstream.once("response", (upstreamResponse) => {
          writeHeadOnce(response, upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        });
        upstream.once("error", (error) => response.destroy(error));
        requestState.currentAbort = () => upstream.destroy();
        upstream.end(body);
        response.once("finish", finish);
        return;
      }

      counters.guarded += 1;
      emit({ type: "guarded_request_started", timeoutMs: firstProgressTimeoutMs });
      let finalOutcome = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (requestState.cancelled) break;
        emit({ type: "attempt_started", attempt });
        const outcome = await guardedAttempt({
          body,
          downstream: response,
          headers: request.headers,
          method: request.method,
          targetUrl,
          timeoutMs: firstProgressTimeoutMs,
          attempt,
          maxAttempts: 2,
          onEvent: emit,
          requestState,
        });
        finalOutcome = outcome;
        if (!outcome.retry) break;
        counters.retries += 1;
        emit({ type: "attempt_retrying", attempt, reason: outcome.reason });
      }
      if (requestState.cancelled) return;
      if (!response.writableEnded && !response.destroyed && !response.headersSent) {
        counters.failed += 1;
        response.writeHead(504, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({
          error: {
            type: "model_stream_no_progress",
            message: "The upstream model did not produce meaningful output after one isolated retry.",
            retryable: true,
          },
        }));
        emit({ type: "guarded_request_failed", reason: finalOutcome?.reason ?? "NO_OUTCOME" });
      } else if (response.writableEnded) {
        counters.completed += 1;
        emit({ type: "guarded_request_completed", reason: finalOutcome?.reason ?? "COMPLETED" });
      }
    } catch (error) {
      counters.failed += 1;
      emit({ type: "guarded_request_error", code: error.code ?? "UNEXPECTED_ERROR" });
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { type: "local_model_proxy_error", message: "Local model stream proxy failed safely." } }));
      } else if (!response.destroyed) {
        response.destroy(error);
      }
    } finally {
      finish();
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

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
      for (const state of active.values()) {
        state.cancelled = true;
        state.currentAbort?.();
      }
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    status() {
      const address = server.address();
      return {
        running: server.listening,
        host,
        port: typeof address === "object" && address ? address.port : port,
        upstreamOrigin: upstreamOrigin.origin,
        activeRequests: active.size,
        firstProgressTimeoutMs,
        maxBufferedRequestBytes,
        counters: { ...counters },
      };
    },
    server,
  };
}
