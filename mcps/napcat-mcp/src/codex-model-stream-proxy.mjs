import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";
import { correlationQuality, hashIdentity } from "./observability-utils.mjs";

const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 30_000;
const DEFAULT_PROGRESS_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_COMPACTION_ATTEMPT_TIMEOUT_MS = 150_000;
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CONSECUTIVE_ATTEMPTS = 6;
const DEFAULT_ATTEMPT_STATE_TTL_MS = 30 * 60_000;
const DEFAULT_UPSTREAM_ORIGIN = "https://chatgpt.com";
const MAX_METADATA_HEADER_BYTES = 64 * 1024;
const NETWORK_EXHAUSTED_NOTICE = "\n\n网络重试六次仍失败，本轮没有执行新的工具操作，请重新发送。";
const CAPACITY_EXHAUSTED_NOTICE = "\n\n当前模型暂时满载，已自动尝试六次仍未恢复，请稍后重试或切换模型。";
const USAGE_LIMIT_NOTICE = "\n\n当前账号额度已耗尽，请等待额度恢复、购买额外额度或切换账号。";
const PERMANENT_FAILURE_NOTICE = "\n\n请求未能完成，服务器返回了不可重试的错误，本轮没有执行新的工具操作，请重新发送。";
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
  const requestKind = typeof metadata?.request_kind === "string" ? metadata.request_kind : null;
  return {
    requestKind,
    guarded: requestKind === "turn" || requestKind === "compaction",
    threadId: typeof metadata?.thread_id === "string" ? metadata.thread_id : null,
    turnId: typeof metadata?.turn_id === "string" ? metadata.turn_id : null,
  };
}

function decodeRequestBody(body, contentEncoding, maxOutputLength) {
  const encodings = String(contentEncoding ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity");
  let decoded = body;
  try {
    for (const encoding of encodings.reverse()) {
      if (encoding === "gzip") decoded = zlib.gunzipSync(decoded, { maxOutputLength });
      else if (encoding === "deflate") decoded = zlib.inflateSync(decoded, { maxOutputLength });
      else if (encoding === "br") decoded = zlib.brotliDecompressSync(decoded, { maxOutputLength });
      else if (encoding === "zstd") decoded = zlib.zstdDecompressSync(decoded, { maxOutputLength });
      else return null;
    }
  } catch {
    return null;
  }
  return decoded.length <= maxOutputLength ? decoded : null;
}

function isJsonRequestBody(body, contentEncoding, maxOutputLength) {
  const decoded = decodeRequestBody(body, contentEncoding, maxOutputLength);
  if (decoded === null) return false;
  try {
    const payload = JSON.parse(decoded.toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload);
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
  return Boolean(type) && type !== "message" && type !== "reasoning" && type !== "compaction";
}

function eventPayloadHasContent(event) {
  if (!event || typeof event !== "object") return false;
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "response.completed") return true;
  if (type === "response.output_item.done") {
    const content = event.item?.content;
    if (Array.isArray(content) && content.some((item) => typeof item?.text === "string" && item.text.length > 0)) return true;
    if (isToolResponseItem(event.item)) return true;
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

function responseFailureDetails(event) {
  const source = event?.response?.error ?? event?.error ?? event;
  const incompleteReason = typeof event?.response?.incomplete_details?.reason === "string" ? event.response.incomplete_details.reason : "";
  const rawCode = typeof source?.code === "string" ? source.code : typeof source?.type === "string" ? source.type : incompleteReason;
  const rawMessage = typeof source?.message === "string" ? source.message : incompleteReason;
  const code = rawCode.trim().toLowerCase();
  const message = rawMessage.replace(/[\r\n]+/gu, " ").trim();
  const usageLimit = USAGE_LIMIT_CODES.has(code)
    || /you(?:'|’)ve hit your usage limit|codex\/settings\/usage|purchase more credits|quota exceeded/iu.test(message);
  const capacity = CAPACITY_CODES.has(code) || /selected model is at capacity|server overloaded/iu.test(message);
  const transient = !usageLimit && (capacity || TRANSIENT_CODES.has(code));
  return {
    code: code || null,
    message: message.slice(0, 512) || null,
    category: usageLimit ? "usage_limit" : capacity ? "capacity" : transient ? "transient" : "permanent",
  };
}

function responseFailureDetailsFromBody(body) {
  const text = body.toString("utf8").replace(/[\r\n]+/gu, " ").trim();
  if (!text) return { code: null, message: null, category: "permanent" };
  try {
    const parsed = JSON.parse(text);
    return responseFailureDetails({ error: parsed?.error ?? parsed?.response?.error ?? parsed });
  } catch {
    return responseFailureDetails({ error: { message: text } });
  }
}

function retryableStatus(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function createSseFrameParser(onFrame) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const drain = (ending = false) => {
    while (true) {
      const match = /\r?\n\r?\n/u.exec(pending);
      if (!match) break;
      const frame = pending.slice(0, match.index);
      const wire = `${frame}${match[0]}`;
      pending = pending.slice(match.index + match[0].length);
      onFrame(wire, frame);
    }
    if (ending && pending) {
      const frame = pending;
      pending = "";
      onFrame(frame, frame);
    }
  };
  return {
    push(chunk) {
      pending += decoder.write(chunk);
      drain(false);
    },
    end() {
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

function collectRequestBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        reject(Object.assign(new Error("request body exceeded proxy buffer limit"), { code: "BODY_LIMIT_EXCEEDED" }));
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
    finalAttempt,
    maxBufferedResponseBytes,
    onEvent,
    requestState,
  } = options;
  return new Promise((resolve) => {
    const client = requestClient(targetUrl);
    const startedAt = Date.now();
    let upstreamResponse = null;
    let settled = false;
    let timer = null;
    let sawCompleted = false;
    let sawContent = false;
    let sawTool = false;
    let terminalFailure = null;
    let pendingPrelude = [];
    let heldAfterTool = [];
    let heldBytes = 0;
    let finalBuffer = [];
    let finalBytes = 0;
    let upstreamHeaders = {};
    let frames = 0;
    let sawResponsesProtocol = false;
    let rawBodyBeforeProtocol = [];
    let rawBodyBeforeProtocolBytes = 0;
    let advertisedResponsesSse = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      requestState.currentAbort = null;
      resolve({ ...outcome, elapsedMs: Date.now() - startedAt, frames, sawContent, sawTool });
    };
    const abortWith = (reason) => {
      upstreamResponse?.destroy();
      upstream.destroy(Object.assign(new Error(reason), { code: reason }));
      finish({ kind: "retryable_failure", reason, upstreamHeaders });
    };
    const armTimer = (timeoutMs, reason) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled || requestState.cancelled) return;
        onEvent({ type: "attempt_progress_timeout", reason, timeoutMs, sawContent, sawTool });
        abortWith(reason);
      }, timeoutMs);
      timer.unref?.();
    };
    const writeWire = (wire) => {
      ensureSseHead(downstream, upstreamHeaders);
      downstream.write(wire);
      requestState.downstreamFrames += 1;
    };
    const flushPrelude = () => {
      for (const wire of pendingPrelude) writeWire(wire);
      pendingPrelude = [];
    };
    const bufferFinal = (wire) => {
      finalBytes += Buffer.byteLength(wire, "utf8");
      if (finalBytes > maxBufferedResponseBytes) {
        abortWith("FINAL_ATTEMPT_BUFFER_LIMIT");
        return false;
      }
      finalBuffer.push(wire);
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
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      advertisedResponsesSse = contentType.includes("text/event-stream");
      if (statusCode < 200 || statusCode >= 300) {
        try {
          const responseBody = await collectResponseBody(response, Math.min(maxBufferedResponseBytes, 1024 * 1024));
          if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
          const failure = responseFailureDetailsFromBody(responseBody);
          if (failure.category === "usage_limit") return finish({ kind: "usage_limit", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
          if (retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient") {
            return finish({ kind: "retryable_failure", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
          }
          return finish({ kind: "permanent_failure", reason: `HTTP_${statusCode}`, failure, upstreamHeaders });
        } catch (error) {
          return finish({ kind: "retryable_failure", reason: error.code ?? "HTTP_BODY_ERROR", upstreamHeaders });
        }
      }

      ensureSseHead(downstream, upstreamHeaders);
      const parser = createSseFrameParser((wire, frame) => {
        if (settled || requestState.cancelled) return;
        frames += 1;
        const parsed = parseSseFrame(frame);
        const event = parsed.event;
        const type = parsed.type;
        if (isResponsesProtocolType(type ?? "")) sawResponsesProtocol = true;
        if (eventPayloadHasContent(event)) {
          sawContent = true;
          armTimer(progressIdleTimeoutMs, "PROGRESS_IDLE_TIMEOUT");
        }
        if (isToolEvent(event)) sawTool = true;
        if (type === "response.failed" || type === "response.incomplete" || type === "error") {
          terminalFailure = responseFailureDetails(event);
          return;
        }
        if (parsed.doneMarker && !sawCompleted) return;
        if (type === "response.completed") sawCompleted = true;

        if (finalAttempt) {
          bufferFinal(wire);
          return;
        }
        if (sawTool) {
          if (pendingPrelude.length > 0) {
            for (const prelude of pendingPrelude) holdToolWire(prelude);
            pendingPrelude = [];
          }
          holdToolWire(wire);
          return;
        }
        if (!sawContent && type !== "response.completed") {
          pendingPrelude.push(wire);
          return;
        }
        flushPrelude();
        writeWire(wire);
      });
      response.on("data", (chunk) => {
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
          if (finalAttempt) {
            ensureSseHead(downstream, upstreamHeaders);
            downstream.end(finalBuffer.join(""));
          } else if (sawTool) {
            ensureSseHead(downstream, upstreamHeaders);
            downstream.end(heldAfterTool.join(""));
          } else {
            flushPrelude();
            downstream.end();
          }
          return finish({ kind: "completed", reason: "RESPONSE_COMPLETED" });
        }
        if (terminalFailure?.category === "usage_limit" && (!sawContent || finalAttempt)) {
          return finish({ kind: "usage_limit", reason: "USAGE_LIMIT", failure: terminalFailure, upstreamHeaders });
        }
        if (terminalFailure?.category === "permanent") {
          if (finalAttempt || (!sawContent && !sawTool)) {
            return finish({ kind: "permanent_failure", reason: terminalFailure.code ?? "RESPONSE_FAILED", failure: terminalFailure, upstreamHeaders });
          }
          return finish({ kind: "retryable_failure", reason: terminalFailure.code ?? "RESPONSE_FAILED_AFTER_CONTENT", failure: terminalFailure, upstreamHeaders });
        }
        if (!advertisedResponsesSse && !sawResponsesProtocol && rawBodyBeforeProtocolBytes > 0 && rawBodyBeforeProtocolBytes <= 1024 * 1024) {
          const failure = responseFailureDetailsFromBody(Buffer.concat(rawBodyBeforeProtocol, rawBodyBeforeProtocolBytes));
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
        finish({ kind: "retryable_failure", reason: error.code ?? "STREAM_ERROR", upstreamHeaders });
      });
    });
    upstream.once("error", (error) => {
      if (settled || requestState.cancelled) return;
      finish({ kind: "retryable_failure", reason: error.code ?? "UPSTREAM_ERROR", upstreamHeaders });
    });
    upstream.end(body);
  });
}

function analyzeBufferedSse(body) {
  let sawCompleted = false;
  let sawResponsesProtocol = false;
  let compactionItems = 0;
  let failure = null;
  const parser = createSseFrameParser((_wire, frame) => {
    const parsed = parseSseFrame(frame);
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
  const { body, headers, method, targetUrl, timeoutMs, maxBufferedResponseBytes, requestState } = options;
  return new Promise((resolve) => {
    const client = requestClient(targetUrl);
    let settled = false;
    let upstreamResponse = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
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
      try {
        const responseBody = await collectResponseBody(response, maxBufferedResponseBytes);
        if (requestState.cancelled) return finish({ kind: "cancelled", reason: "DOWNSTREAM_CANCELLED" });
        const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
        if (statusCode < 200 || statusCode >= 300) {
          const failure = responseFailureDetailsFromBody(responseBody);
          const retryable = retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient";
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
        const analysis = analyzeBufferedSse(responseBody);
        if (analysis.sawCompleted && analysis.compactionItems === 1) {
          return finish({ kind: "completed", statusCode, statusMessage: response.statusMessage, headers: response.headers, body: responseBody });
        }
        const permanent = analysis.failure?.category === "usage_limit" || analysis.failure?.category === "permanent";
        if (!analysis.sawResponsesProtocol && !contentType.includes("text/event-stream")) {
          const failure = responseFailureDetailsFromBody(responseBody);
          const retryable = retryableStatus(statusCode) || failure.category === "capacity" || failure.category === "transient";
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
  });
}

export function createCodexModelStreamProxy(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = integerOption(options.port, 18435, 0, 65535, "port");
  const upstreamOrigin = new URL(options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN);
  const firstProgressTimeoutMs = integerOption(options.firstProgressTimeoutMs, DEFAULT_FIRST_PROGRESS_TIMEOUT_MS, 10, 300_000, "firstProgressTimeoutMs");
  const progressIdleTimeoutMs = integerOption(options.progressIdleTimeoutMs, DEFAULT_PROGRESS_IDLE_TIMEOUT_MS, 10, 300_000, "progressIdleTimeoutMs");
  const compactionAttemptTimeoutMs = integerOption(options.compactionAttemptTimeoutMs, DEFAULT_COMPACTION_ATTEMPT_TIMEOUT_MS, 10_000, 600_000, "compactionAttemptTimeoutMs");
  const maxBufferedRequestBytes = integerOption(options.maxBufferedRequestBytes, DEFAULT_MAX_BUFFERED_REQUEST_BYTES, 1_024, 256 * 1024 * 1024, "maxBufferedRequestBytes");
  const maxBufferedResponseBytes = integerOption(options.maxBufferedResponseBytes, DEFAULT_MAX_BUFFERED_RESPONSE_BYTES, 1_024, 256 * 1024 * 1024, "maxBufferedResponseBytes");
  const maxConsecutiveAttempts = integerOption(options.maxConsecutiveAttempts, DEFAULT_MAX_CONSECUTIVE_ATTEMPTS, 1, 20, "maxConsecutiveAttempts");
  const attemptStateTtlMs = integerOption(options.attemptStateTtlMs, DEFAULT_ATTEMPT_STATE_TTL_MS, 1_000, 24 * 60 * 60_000, "attemptStateTtlMs");
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const active = new Map();
  const attempts = new Map();
  const counters = {
    total: 0,
    guarded: 0,
    passthrough: 0,
    retrySignals: 0,
    syntheticCompletions: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    compactionInternalRetries: 0,
  };

  const pruneAttempts = () => {
    const cutoff = Date.now() - attemptStateTtlMs;
    for (const [key, state] of attempts) if (state.updatedAt < cutoff) attempts.delete(key);
  };

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      pruneAttempts();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ok: true,
        activeRequests: active.size,
        attemptChains: attempts.size,
        firstProgressTimeoutMs,
        progressIdleTimeoutMs,
        compactionAttemptTimeoutMs,
        maxConsecutiveAttempts,
        maxBufferedRequestBytes,
        maxBufferedResponseBytes,
        counters,
      }));
      return;
    }
    counters.total += 1;
    pruneAttempts();
    const identity = classifyCodexModelRequest(request);
    const requestId = crypto.randomUUID();
    const requestState = { cancelled: false, currentAbort: null, downstreamFrames: 0 };
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
    const key = attemptKey(identity);
    const finish = () => active.delete(requestId);
    response.once("close", () => {
      if (response.writableEnded) return;
      requestState.cancelled = true;
      requestState.currentAbort?.();
      if (key) attempts.delete(key);
      counters.cancelled += 1;
      emit({ type: "downstream_cancelled" });
      finish();
    });
    const targetUrl = new URL(request.url ?? "/", upstreamOrigin);
    const declaredLength = Number(headerValue(request.headers, "content-length"));
    const canBuffer = Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength <= maxBufferedRequestBytes;
    if (!identity.guarded || request.method !== "POST" || !canBuffer) {
      counters.passthrough += 1;
      emit({ type: "passthrough", reason: !identity.guarded ? "request_kind" : "body_not_bufferable" });
      forwardPassthrough(request, response, targetUrl, emit);
      response.once("finish", finish);
      return;
    }

    try {
      const body = await collectRequestBody(request, maxBufferedRequestBytes);
      if (!isJsonRequestBody(body, request.headers["content-encoding"], maxBufferedRequestBytes)) {
        counters.failed += 1;
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: { type: "invalid_proxy_request", message: "Buffered model request was not valid JSON." } }));
        emit({ type: "invalid_buffered_request" });
        return;
      }
      counters.guarded += 1;

      if (identity.requestKind === "compaction") {
        let outcome = null;
        for (let internalAttempt = 1; internalAttempt <= 2; internalAttempt += 1) {
          emit({ type: "compaction_attempt_started", internalAttempt, timeoutMs: compactionAttemptTimeoutMs });
          outcome = await executeBufferedCompactionAttempt({
            body,
            headers: request.headers,
            method: request.method,
            targetUrl,
            timeoutMs: compactionAttemptTimeoutMs,
            maxBufferedResponseBytes,
            requestState,
          });
          emit({ type: "compaction_attempt_finished", internalAttempt, kind: outcome.kind, reason: outcome.reason ?? null });
          if (outcome.kind !== "retryable_failure" || internalAttempt === 2) break;
          counters.compactionInternalRetries += 1;
        }
        if (requestState.cancelled || outcome?.kind === "cancelled") return;
        if (outcome?.kind === "completed" || outcome?.kind === "permanent_failure") {
          writeHeadOnce(response, outcome.statusCode ?? 502, outcome.statusMessage, outcome.headers ?? {});
          response.end(outcome.body ?? Buffer.alloc(0));
          if (outcome.kind === "completed") counters.completed += 1;
          else counters.failed += 1;
          return;
        }
        ensureSseHead(response, outcome?.headers ?? {});
        response.end();
        counters.retrySignals += 1;
        emit({ type: "compaction_retry_signal", reason: outcome?.reason ?? "UNKNOWN" });
        return;
      }

      const prior = key ? attempts.get(key) : null;
      const attemptNumber = (prior?.failures ?? 0) + 1;
      const finalAttempt = attemptNumber >= maxConsecutiveAttempts;
      emit({ type: "turn_attempt_started", attemptNumber, maxConsecutiveAttempts, finalAttempt, firstProgressTimeoutMs, progressIdleTimeoutMs });
      const outcome = await executeTurnAttempt({
        body,
        downstream: response,
        headers: request.headers,
        method: request.method,
        targetUrl,
        firstProgressTimeoutMs,
        progressIdleTimeoutMs,
        finalAttempt,
        maxBufferedResponseBytes,
        onEvent: emit,
        requestState,
      });
      emit({
        type: "turn_attempt_finished",
        attemptNumber,
        kind: outcome.kind,
        reason: outcome.reason,
        elapsedMs: outcome.elapsedMs,
        frames: outcome.frames,
        sawContent: outcome.sawContent,
        sawTool: outcome.sawTool,
      });
      if (requestState.cancelled || outcome.kind === "cancelled") {
        if (key) attempts.delete(key);
        return;
      }
      if (outcome.kind === "completed") {
        if (key) attempts.delete(key);
        counters.completed += 1;
        return;
      }
      if (outcome.kind === "permanent_failure") {
        if (key) attempts.delete(key);
        sendSyntheticCompletion(response, requestId, PERMANENT_FAILURE_NOTICE, outcome.upstreamHeaders);
        counters.syntheticCompletions += 1;
        counters.completed += 1;
        emit({ type: "permanent_failure_completed_idle", code: outcome.failure?.code ?? null });
        return;
      }
      if (outcome.kind === "usage_limit") {
        if (key) attempts.delete(key);
        sendSyntheticCompletion(response, requestId, USAGE_LIMIT_NOTICE, outcome.upstreamHeaders);
        counters.syntheticCompletions += 1;
        counters.completed += 1;
        emit({ type: "usage_limit_completed_idle" });
        return;
      }

      if (key) attempts.set(key, { failures: attemptNumber, updatedAt: Date.now() });
      if (finalAttempt) {
        const notice = outcome.failure?.category === "capacity" ? CAPACITY_EXHAUSTED_NOTICE : NETWORK_EXHAUSTED_NOTICE;
        sendSyntheticCompletion(response, requestId, notice, outcome.upstreamHeaders);
        if (key) attempts.delete(key);
        counters.syntheticCompletions += 1;
        counters.completed += 1;
        emit({ type: "retry_exhausted_completed_idle", attemptNumber, category: outcome.failure?.category ?? "network" });
        return;
      }
      ensureSseHead(response, outcome.upstreamHeaders ?? {});
      response.end();
      counters.retrySignals += 1;
      emit({ type: "native_retry_signal", attemptNumber, reason: outcome.reason, category: outcome.failure?.category ?? "network" });
    } catch (error) {
      counters.failed += 1;
      emit({ type: "guarded_request_error", code: error.code ?? "UNEXPECTED_ERROR", message: error.message });
      if (!response.destroyed) {
        const priorFailures = key ? (attempts.get(key)?.failures ?? 0) : 0;
        const nextFailure = priorFailures + 1;
        const canCompleteIdle = identity.requestKind === "turn" && requestState.downstreamFrames === 0
          && (!key || nextFailure >= maxConsecutiveAttempts);
        if (canCompleteIdle) {
          sendSyntheticCompletion(response, requestId, PERMANENT_FAILURE_NOTICE);
          if (key) attempts.delete(key);
          counters.syntheticCompletions += 1;
          counters.completed += 1;
          emit({ type: "guarded_error_completed_idle", attemptNumber: nextFailure });
        } else {
          if (key) attempts.set(key, { failures: nextFailure, updatedAt: Date.now() });
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
        attemptChains: attempts.size,
        firstProgressTimeoutMs,
        progressIdleTimeoutMs,
        compactionAttemptTimeoutMs,
        maxConsecutiveAttempts,
        maxBufferedRequestBytes,
        maxBufferedResponseBytes,
        counters: { ...counters },
      };
    },
    server,
  };
}
