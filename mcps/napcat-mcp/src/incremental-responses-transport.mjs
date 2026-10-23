import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { classifyModelFailure, createModelFailureTerminalEvidence } from "./model-failure-policy.mjs";
import { MAX_UPLOAD_ALLOWANCE_MS } from "./request-wait-budget.mjs";

const require = createRequire(import.meta.url);
const ignoredFields = new Set(["input", "previous_response_id", "generate", "stream", "background", "stream_id", "type"]);
const noop = () => {};
const byteLength = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const canonical = value => JSON.stringify(value, (_key, entry) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
});
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

function cacheConfiguration(config) {
  const metadata = config.client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return config;
  const stableMetadata = { ...metadata };
  for (const key of ["turn_id", "root_turn_id", "turn_started_at_unix_ms"]) delete stableMetadata[key];
  const rawTurnMetadata = stableMetadata["x-codex-turn-metadata"];
  if (typeof rawTurnMetadata === "string") {
    try {
      const turnMetadata = JSON.parse(rawTurnMetadata);
      if (turnMetadata && typeof turnMetadata === "object" && !Array.isArray(turnMetadata)) {
        for (const key of ["turn_id", "root_turn_id", "turn_started_at_unix_ms"]) delete turnMetadata[key];
        stableMetadata["x-codex-turn-metadata"] = turnMetadata;
      }
    } catch {}
  }
  return { ...config, client_metadata: stableMetadata };
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
    if (["host", "content-length", "connection", "upgrade", "transfer-encoding", "sec-websocket-key", "sec-websocket-version"].includes(key.toLowerCase())) delete headers[key];
  }
  return headers;
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

function errorStatus(event) {
  const candidate = event?.status ?? event?.status_code ?? event?.httpStatus ?? event?.http_status
    ?? event?.error?.status ?? event?.error?.status_code ?? event?.error?.http_status
    ?? event?.response?.error?.status ?? event?.response?.error?.status_code;
  const status = typeof candidate === "string" && /^\d{3}$/.test(candidate) ? Number(candidate) : candidate;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
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
  }[event.type];
  if (completedField) return typeof event[completedField] === "string" && event[completedField].length > 0;
  if (["response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.content_part.added", "response.content_part.done"].includes(event.type)) {
    return typeof event.part?.text === "string" && event.part.text.length > 0;
  }
  return /^response\.(?:web_search_call|file_search_call|code_interpreter_call|mcp_call|image_generation_call)\.(?:in_progress|searching|interpreting|generating|partial_image|completed)$/.test(event.type);
}

export function createIncrementalResponsesTransport(options = {}) {
  const maxSessions = limit(options.maxSessions, 32);
  const maxSessionBytes = limit(options.maxSessionBytes, 16 * 1024 * 1024);
  const maxMessageBytes = limit(options.maxMessageBytes, 1024 * 1024);
  const maxOperations = limit(options.maxOperations, 4096);
  const maxPreviousResponseIdBytes = limit(options.maxPreviousResponseIdBytes, 128);
  const connectTimeoutMs = limit(options.connectTimeoutMs, 15000);
  const responseTimeoutMs = limit(options.responseTimeoutMs, 120000);
  const prewarmTimeoutMs = limit(options.prewarmTimeoutMs, responseTimeoutMs);
  const responseHighWaterMark = limit(options.responseHighWaterMark, 16384);
  const allowImagePrewarm = options.allowImagePrewarm === true;
  const createWebSocket = options.createWebSocket ?? ((url, socketOptions) => {
    const WebSocket = require("ws");
    return new WebSocket(url, socketOptions);
  });
  const sessions = new Map();
  const operations = new Map();
  const pendingJobs = new Set();
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
      direction: record.direction,
      closeCode: record.closeCode,
      wsErrorCode: record.wsErrorCode,
      attempt: record.attempt,
      canRetry: (record.acceptance === false || record.terminalOutcome === "failed_no_output") && ["failed", "cancelled"].includes(record.state),
      requiresReconciliation: record.acceptance !== false && record.state !== "completed" && record.terminalOutcome !== "failed_no_output",
      ...(record.terminalOutcome ? { terminalOutcome: record.terminalOutcome } : {}),
    };
  }

  function transportError(code, record, httpStatus) {
    const error = new Error(`WebSocket request failed (${code})`);
    error.code = code;
    error.requestAccepted = record.acceptance;
    error.requestTransmissionState = record.requestTransmissionState;
    if (record.terminalOutcome) error.terminalOutcome = record.terminalOutcome;
    if (record.terminalEvidence) error.terminalEvidence = record.terminalEvidence;
    error.transport = "websocket";
    for (const key of ["direction", "closeCode", "wsErrorCode"]) {
      if (record[key] !== undefined) error[key] = record[key];
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
    return session.cacheBytes + session.queue.reduce((sum, job) => sum + job.bytes, 0)
      + [...session.receiving].reduce((sum, job) => sum + job.bytes, 0)
      + (session.active?.bytes ?? 0) + session.wireBytes + bufferedBytes(session);
  }

  function resetConnection(session) {
    const socket = session.socket;
    session.socket = null;
    session.connecting = null;
    session.connectionState = "disconnected";
    session.prefix = [];
    session.previousId = null;
    session.cacheBytes = 0;
    session.wireBytes = 0;
    session.completedIds.clear();
    clearTimeout(session.connectTimer);
    session.connectTimer = null;
    const reject = session.connectReject;
    session.connectReject = null;
    reject?.(new Error("Connection invalidated"));
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", noop);
      socket.terminate();
    }
  }

  function releaseJob(job) {
    if (job.released) return;
    job.released = true;
    clearTimeout(job.timer);
    clearTimeout(job.requestTimer);
    job.signal?.removeEventListener("abort", job.onAbort);
    job.payload = null;
    job.headers = null;
    job.config = null;
    job.agent = null;
    job.url = null;
    job.groups = null;
    job.groupBytes = null;
    job.plan = null;
    job.onPreparationProgress = null;
    job.onPacketSending = null;
    job.packet = null;
    job.bytes = 0;
    pendingJobs.delete(job);
  }

  function settle(job, code, httpStatus, cancelled = false, publish) {
    if (job.settled) return;
    job.settled = true;
    job.record.state = code ? (cancelled ? "cancelled" : "failed") : "completed";
    job.record.reasonCode = code ?? "response_completed";
    job.record.retryableWithoutOutput = Boolean(code && !job.outputObserved && (cancelled && code === "ABORT_ERR" || classifyModelFailure({
      source: "transport", statusCode: httpStatus, code, requestAccepted: job.record.acceptance,
      requestTransmissionState: job.record.requestTransmissionState,
      progressObserved: job.outputObserved === true, terminalEvidence: job.record.terminalEvidence,
    }).retryable));
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
    publish?.();
    if (code) {
      const error = transportError(code, job.record, httpStatus);
      job.response?.destroy(error);
      if (!job.request.destroyed) job.request.destroy(error);
    } else {
      job.response?.end();
    }
    if (session) queueMicrotask(() => pump(session));
  }

  function failConnection(session, code, httpStatus, details, publish) {
    const job = session.active;
    if (job && details) Object.assign(job.record, details);
    resetConnection(session);
    if (job) settle(job, code, httpStatus, false, publish);
  }

  function socketFailure(error, direction) {
    const statusSymbol = error && Object.getOwnPropertySymbols(error).find(symbol => symbol.description === "status-code");
    return { direction, closeCode: error?.closeCode ?? (statusSymbol ? error[statusSymbol] : undefined), wsErrorCode: error?.code };
  }

  function cancel(job, code = "ABORT_ERR") {
    if (job.settled) return;
    if (job.session?.active === job) resetConnection(job.session);
    settle(job, code, undefined, true);
  }

  function getSession(key) {
    if (sessions.has(key)) return sessions.get(key);
    if (sessions.size >= maxSessions) {
      const idle = [...sessions.values()].find(session => !session.active && !session.queue.length && !session.streams.size && !session.receiving.size);
      if (!idle) return null;
      resetConnection(idle);
      sessions.delete(idle.key);
    }
    const session = {
      key, queue: [], active: null, socket: null, connecting: null, connectReject: null,
      connectTimer: null, connectionState: "disconnected", generation: 0, binding: null,
      prefix: [], previousId: null, cacheBytes: 0, wireBytes: 0, streams: new Set(), receiving: new Set(), completedIds: new Map(),
    };
    sessions.set(key, session);
    return session;
  }

  function ensureConnection(session, job) {
    if (session.socket?.readyState === 1) return Promise.resolve();
    if (session.connecting) return session.connecting;
    session.generation = ++nextGeneration;
    job.record.generation = session.generation;
    session.connectionState = "connecting";
    job.record.requestTransmissionState = "connecting";
    const socket = createWebSocket(job.url, {
      headers: job.headers,
      agent: job.agent,
      perMessageDeflate: false,
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
    const packet = { ...job.config, type: "response.create", store: false, input };
    if (previousId) packet.previous_response_id = previousId;
    if (warm) packet.generate = false;
    return packet;
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
    clearTimeout(job.timer);
    const socket = session.socket;
    job.timer = setTimeout(() => {
      if (!job.settled && session.active === job && job.packet === packet && session.socket === socket) {
        failConnection(session, packet.warm ? "WS_PREWARM_TIMEOUT" : "WS_TERMINAL_TIMEOUT");
      }
    }, Math.min(2_147_483_647, uploadAllowanceMs + (packet.warm ? prewarmTimeoutMs : responseTimeoutMs)));
    job.timer.unref?.();
  }

  function sendNext(session, job) {
    if (job.settled || session.active !== job) return;
    const { groupCount, warm } = job.plan.shift();
    const input = job.groups.slice(0, groupCount).flat();
    const packet = packetFor(job, input, warm, session.previousId);
    const wire = JSON.stringify(packet);
    const wireBytes = Buffer.byteLength(wire, "utf8");
    if (wireBytes > maxMessageBytes) return failConnection(session, "payload_too_large");
    if (retainedBytes(session) + wireBytes > maxSessionBytes) return failConnection(session, "session_bytes_exceeded");
    job.packet = { input, warm, groupCount, responseId: null, establishedResponseId: null, outputObserved: false };
    job.record.phase = warm ? "prewarm" : "generation";
    job.record.state = warm ? "prewarming" : "awaiting_response";
    job.record.generation = session.generation;
    if (!warm && !job.response) createResponse(job);
    if (job.settled || session.active !== job) return;
    if (session.socket?.readyState !== 1) return failConnection(session, "WS_CONNECTION_CLOSED");
    job.sentPackets = (job.sentPackets ?? 0) + 1;
    let uploadAllowanceMs;
    try {
      uploadAllowanceMs = job.onPacketSending?.(Object.freeze({
        sessionKey: session.key, operationId: job.operationId, generation: session.generation,
        phase: "packet_sending", sequence: job.sentPackets, wireBytes, warm, businessProgress: false,
      })) ?? 0;
    } catch { return failConnection(session, "WS_UPLOAD_BUDGET_INVALID"); }
    if (!Number.isSafeInteger(uploadAllowanceMs) || uploadAllowanceMs < 0 || uploadAllowanceMs > MAX_UPLOAD_ALLOWANCE_MS) {
      return failConnection(session, "WS_UPLOAD_BUDGET_INVALID");
    }
    if (job.settled || session.active !== job) return;
    job.record.acceptance = "unknown";
    job.record.requestTransmissionState = warm ? "prewarm_sent" : "generation_sent";
    session.wireBytes = wireBytes;
    const socket = session.socket;
    const pendingPacket = job.packet;
    refreshPacketTimeout(session, job, pendingPacket, uploadAllowanceMs);
    try {
      socket.send(wire, error => {
        if (session.socket !== socket || session.active !== job || job.settled || job.packet !== pendingPacket) return;
        session.wireBytes = 0;
        if (error) failConnection(session, "WS_SEND_ERROR", undefined, socketFailure(error, "send"));
      });
    } catch (error) {
      if (session.socket === socket && session.active === job && !job.settled && job.packet === pendingPacket) {
        failConnection(session, "WS_SEND_ERROR", undefined, socketFailure(error, "send"));
      }
    }
  }

  function receive(session, data) {
    const job = session.active;
    if (!job?.packet || job.settled) return;
    const packet = job.packet;
    const socket = session.socket;
    const current = () => !job.settled && session.active === job && job.packet === packet && session.socket === socket;
    const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let event;
    try { event = JSON.parse(raw); } catch { return failConnection(session, "WS_INVALID_EVENT"); }
    const nestedId = event?.response?.id;
    const topLevelId = event?.response_id;
    const responseId = nestedId ?? topLevelId;
    if (nestedId !== undefined && topLevelId !== undefined && nestedId !== topLevelId
      || responseId !== undefined && (typeof responseId !== "string" || !responseId)) {
      job.outputObserved = true;
      return failConnection(session, "WS_RESPONSE_ID_CONFLICT");
    }
    if (responseId && session.completedIds.has(responseId)) {
      if (event.type === "response.completed" && session.completedIds.get(responseId) === digest(event)) return;
      job.outputObserved = true;
      return failConnection(session, "WS_RESPONSE_ID_CONFLICT");
    }
    if (responseId && packet.responseId && responseId !== packet.responseId) {
      job.outputObserved = true;
      return failConnection(session, "WS_RESPONSE_ID_CONFLICT");
    }
    if (responseId) packet.responseId = responseId;
    if (typeof event?.type !== "string") return failConnection(session, "WS_INVALID_EVENT");
    if (event.type === "response.created" && typeof event?.response?.id === "string"
      && event.response.id && event.response.status === "in_progress") packet.establishedResponseId = event.response.id;
    if (event.type.startsWith("response.") && !["response.created", "response.in_progress", "response.queued", "response.completed", "response.failed"].includes(event.type)
      || event.response?.output !== undefined && (!Array.isArray(event.response.output) || event.response.output.length > 0)) {
      packet.outputObserved = true;
      job.outputObserved = true;
    }
    if (event.type.startsWith("response.")) {
      job.record.acceptance = true;
      job.record.requestTransmissionState = "response_received";
    }
    if (!packet.warm && isBusinessProgress(event)) refreshPacketTimeout(session, job, packet);
    let sse;
    if (!packet.warm) {
      const eventLine = /^[\w.:-]+$/.test(event.type) ? `event: ${event.type}\n` : "";
      sse = `${eventLine}${raw.split(/\r?\n/).map(line => `data: ${line}`).join("\n")}\n\n`;
      if (retainedBytes(session) + Buffer.byteLength(sse) > maxSessionBytes) return failConnection(session, "session_bytes_exceeded");
    }
    const responseStream = job.response;
    const publish = () => {
      if (sse && !responseStream.destroyed) responseStream.write(sse);
    };
    if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      const status = errorStatus(event);
      if (event.type === "response.failed" && event.response?.status === "failed"
        && event.response.id === packet.establishedResponseId && !job.outputObserved
        && Array.isArray(event.response.output) && event.response.output.length === 0) {
        job.record.terminalOutcome = "failed_no_output";
        job.record.terminalEvidence = createModelFailureTerminalEvidence({ operationId: job.operationId,
          attempt: job.record.attempt, generation: session.generation,
          packetSequence: (job.preparedPackets ?? 0) + 1, responseId: event.response.id,
          statusCode: status, error: event.response.error ?? event.error });
      }
      return failConnection(session, status === 503 ? "WS_HTTP_503" : "WS_UPSTREAM_ERROR", status, undefined, publish);
    }
    if (event.type !== "response.completed") {
      if (!sse) return;
      const canWrite = job.response.write(sse);
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
    if (typeof response?.id !== "string" || !response.id || response.status !== "completed" || !Array.isArray(response.output)) return failConnection(session, "WS_INVALID_TERMINAL");
    if (packet.warm && response.output.length) return failConnection(session, "WS_INVALID_PREWARM_OUTPUT");
    if (packet.warm && byteLength(response.id) > maxPreviousResponseIdBytes) return failConnection(session, "WS_RESPONSE_ID_LIMIT");
    clearTimeout(job.timer);
    const committed = [...session.prefix, ...packet.input, ...response.output];
    session.prefix = committed;
    session.previousId = response.id;
    session.cacheBytes = byteLength(committed) + Buffer.byteLength(response.id);
    session.completedIds.set(response.id, digest(event));
    if (session.completedIds.size > 128) session.completedIds.delete(session.completedIds.keys().next().value);
    if (packet.warm) {
      if (retainedBytes(session) > maxSessionBytes) return failConnection(session, "session_bytes_exceeded");
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
      if (retainedBytes(session) > maxSessionBytes) resetConnection(session);
    }
  }

  async function pump(session) {
    if (closed || session.active || !session.queue.length) return;
    const job = session.queue.shift();
    if (job.settled) return pump(session);
    session.active = job;
    try {
      const prefixMatches = session.prefix.length <= job.payload.input.length
        && session.prefix.every((item, index) => canonical(item) === canonical(job.payload.input[index]));
      if (session.binding !== job.binding || !prefixMatches) resetConnection(session);
      session.binding = job.binding;
      const input = job.payload.input.slice(session.prefix.length);
      job.groups = atomicGroups(input);
      job.groupBytes = job.groups.map(group => byteLength(group) - 2);
      const baseBytes = byteLength(packetFor(job, [], false, session.previousId));
      const inputBytes = job.groupBytes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, job.groups.length - 1);
      if (!allowImagePrewarm && containsImage(input)
        && baseBytes + inputBytes > maxMessageBytes) {
        return failConnection(session, "unsupported_image_prewarm");
      }
      for (const bytes of job.groupBytes) {
        if (baseBytes + bytes > maxMessageBytes) return failConnection(session, "payload_too_large");
      }
      if (baseBytes > maxMessageBytes) return failConnection(session, "payload_too_large");
      job.plan = [];
      let offset = 0;
      let previousId = session.previousId;
      do {
        const remaining = job.groupBytes.slice(offset);
        const remainingBytes = remaining.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, remaining.length - 1);
        const warm = byteLength(packetFor(job, [], false, previousId)) + remainingBytes > maxMessageBytes;
        let groupCount = remaining.length;
        if (warm) {
          groupCount = 0;
          let bytes = byteLength(packetFor(job, [], true, previousId));
          for (const groupBytes of remaining) {
            const candidate = bytes + groupBytes + (groupCount ? 1 : 0);
            if (candidate > maxMessageBytes) break;
            bytes = candidate;
            groupCount += 1;
          }
          if (!groupCount) return failConnection(session, "payload_too_large");
        }
        job.plan.push({ groupCount, warm });
        offset += groupCount;
        if (!warm) break;
        previousId = "x".repeat(Math.max(0, maxPreviousResponseIdBytes - 2));
      } while (offset <= job.groups.length);
      if (job.plan.length > 1) {
        const projectedCacheBytes = byteLength(job.payload.input) + maxPreviousResponseIdBytes;
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

  function createRequestClient({ sessionKey, operationId, payload, url, headers, onPreparationProgress, onPacketSending,
    retryWithoutOutput = false } = {}) {
    let currentRecord;
    return {
      transport: "websocket",
      get operationAcceptance() { return currentRecord?.acceptance ?? false; },
      get requestTransmissionState() { return currentRecord?.requestTransmissionState ?? "not_sent"; },
      request(targetUrl, requestOptions = {}) {
        const existing = operations.get(operationId);
        const retryable = (existing?.acceptance === false || existing?.terminalOutcome === "failed_no_output"
          || retryWithoutOutput && existing?.retryableWithoutOutput === true)
          && ["failed", "cancelled"].includes(existing.state);
        const duplicate = existing && !retryable;
        const record = duplicate ? { ...existing } : {
          state: "receiving_body", acceptance: false, reasonCode: null, requestTransmissionState: "not_sent",
          phase: "none", generation: 0, attempt: (existing?.attempt ?? 0) + 1,
        };
        if (duplicate && record.acceptance === false) record.acceptance = "unknown";
        const job = { record, operationId, settled: false, bytes: 0, session: null, response: null, timer: null,
          signal: requestOptions.signal, onPreparationProgress: onPreparationProgress ?? options.onPreparationProgress,
          onPacketSending: onPacketSending ?? options.onPacketSending };
        currentRecord = record;
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
              if (!job.payload) return settle(job, job.validationError ?? "invalid_payload");
              const session = job.session ?? getSession(sessionKey);
              if (!session) return settle(job, "session_limit");
              job.session = session;
              session.receiving.delete(job);
              if (retainedBytes(session) + job.bytes > maxSessionBytes) return settle(job, "session_bytes_exceeded");
              record.state = "queued";
              session.queue.push(job);
              pump(session);
            });
          },
          destroy(error, callback) {
            if (!job.settled) {
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
          terminalOutcome: { get: () => record.terminalOutcome },
          terminalEvidence: { get: () => record.terminalEvidence },
        });
        request.abort = () => request.destroy();
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
            if (value.state === "completed" && !liveRecords.has(value)) {
              operations.delete(key);
              break;
            }
          }
        }
        if (!duplicate && operations.size >= maxOperations && !existing) {
          job.validationError = "operation_limit";
        } else if (!duplicate) {
          operations.set(operationId, record);
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
            job.headers = mergeHeaders(headers, requestOptions.headers);
            job.config = Object.fromEntries(Object.entries(job.payload).filter(([key]) => !ignoredFields.has(key)));
            job.config.store = false;
            const identity = Object.fromEntries(Object.entries(job.headers).filter(([key]) => ["authorization", "chatgpt-account-id", "proxy-authorization", "cookie", "x-api-key", "api-key", "openai-organization", "openai-project", "openai-beta"].includes(key.toLowerCase())).map(([key, value]) => [key.toLowerCase(), value]));
            job.binding = digest({ url: job.url, identity, config: cacheConfiguration(job.config) });
            job.agent = requestOptions.agent ?? options.agent;
            job.bytes = byteLength(job.payload) + byteLength(job.headers) + byteLength(job.config);
            if (job.bytes > maxSessionBytes) {
              job.payload = null;
              job.headers = null;
              job.config = null;
              job.bytes = 0;
              job.validationError = "session_bytes_exceeded";
            }
            if (job.payload) {
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
          } catch {
            job.payload = null;
            job.validationError ??= "invalid_payload";
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
    getOperation(operationId) { return metadata(operations.get(operationId)); },
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
        maxSessions, maxSessionBytes, maxMessageBytes, maxOperations, maxPreviousResponseIdBytes,
        previousResponseIdLimitScope: "local_policy", responseTimeoutMs, prewarmTimeoutMs, allowImagePrewarm,
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
        resetConnection(session);
        for (const job of jobs) settle(job, "transport_closed", undefined, true);
        for (const response of session.streams) response.destroy();
        session.streams.clear();
      }
      sessions.clear();
    },
  };
}
