import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { types } from "node:util";
import { CoreError } from "../contracts.mjs";
import { normalizeOwnerWindowBinding } from "../owner-window-ingress.mjs";

const TIMEOUT_MS = 10000;
const OWNER_WINDOW_PROVIDER_CODES = new Set([
  "BASELINE_REQUIRED", "BINDING_GENERATION_MISMATCH", "BINDING_IDENTITY_MISMATCH", "CONTENT_UNAVAILABLE",
  "CURSOR_EXPIRED", "CURSOR_INVALID", "CURSOR_SCOPE_MISMATCH", "DEDUPE_CONFLICT", "GENERATION_MISMATCH",
  "HISTORY_EXPIRED", "INVALID_ARGUMENT", "ROUTE_CONFLICT", "SCOPE_MISMATCH", "SENDER_MISMATCH", "STATE_INVALID",
  "TRUST_AMBIGUOUS", "TRUST_CHANGED", "TRUST_UNAVAILABLE", "UNSUPPORTED",
].map(code => `OWNER_WINDOW_${code}`));

function unavailable(requestSent = false) {
  return new CoreError("napcat_mcp_unconfirmed", "NapCat MCP尚未取得可核对结果", { request_sent: requestSent });
}

function brokerSessionMissing(error) {
  const prefix = "Streamable HTTP error: Error POSTing to endpoint: ";
  if (!(error instanceof StreamableHTTPError) || error.code !== 404 || !error.message.startsWith(prefix)) return false;
  const body = error.message.slice(prefix.length);
  if (body.length > 256) return false;
  try {
    return JSON.parse(body)?.error === "Missing or invalid MCP session. Send initialize first.";
  } catch {
    return false;
  }
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function windowRecord(value, allowed) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw unavailable();
  const copied = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)
      || (allowed && !allowed.includes(key)) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw unavailable();
    copied[key] = descriptor.value;
  }
  return copied;
}

function windowIdentifier(value, maximum) {
  if (!boundedText(value, maximum) || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)
    || Buffer.byteLength(value, "utf8") > maximum) throw unavailable();
  return value;
}

function structuredResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) || result.isError) throw unavailable(true);
  let value = result.structuredContent;
  if (value === undefined) {
    if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text"
      || typeof result.content[0].text !== "string") throw unavailable(true);
    try { value = JSON.parse(result.content[0].text); } catch { throw unavailable(true); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable(true);
  return value;
}

function structuredWindowResult(result, requestSent) {
  const response = windowRecord(result);
  if (response.isError !== undefined && typeof response.isError !== "boolean") throw unavailable(requestSent);
  const value = structuredResult({ ...response, isError: false });
  const payload = windowRecord(value);
  if (payload.ok === false && OWNER_WINDOW_PROVIDER_CODES.has(payload.code)) {
    if ((payload.outcomeUnknown !== undefined && payload.outcomeUnknown !== false)
      || payload.status === "unknown" || payload.outcome === "unknown") {
      return { error: unavailable(requestSent) };
    }
    return { error: new CoreError(payload.code, "QQ窗口服务返回错误", { request_sent: requestSent }) };
  }
  if (response.isError) throw unavailable(requestSent);
  return { value };
}

function structuredChannelResult(result, requestSent) {
  const response = windowRecord(result);
  if (response.isError !== undefined && typeof response.isError !== "boolean") throw unavailable(requestSent);
  const value = structuredResult({ ...response, isError: false });
  const payload = windowRecord(value);
  if (payload.ok === false && payload.outcomeUnknown === false && typeof payload.code === "string"
    && /^[A-Z][A-Z0-9_]{0,95}$/.test(payload.code) && payload.code !== "UNEXPECTED_ERROR") {
    const cleanupPending = payload.details?.cleanupPending;
    if (cleanupPending !== undefined && typeof cleanupPending !== "boolean") throw unavailable(requestSent);
    return { error: new CoreError("channel_operation_failed", "QQ窗口操作返回明确失败", {
      request_sent: requestSent, outcome_unknown: false, provider_code: payload.code,
      ...(cleanupPending === true ? { cleanup_pending: true,
        ...(boundedText(payload.details?.temporaryPath, 4096) ? { temporary_path: payload.details.temporaryPath } : {}) } : {}),
    }) };
  }
  if (response.isError || payload.ok === false) throw unavailable(requestSent);
  return { value };
}

export class NapcatMcpTransport {
  #baseUrl;
  #conversationId;
  #clientFactory;
  #connection = null;
  #channelConnections = new Map();
  #closing = new Set();
  #shutdown = new AbortController();
  #closed = false;

  constructor({ baseUrl, conversationId, clientFactory = () => new Client({ name: "communication-core-napcat", version: "0.1.0" }) } = {}) {
    let address;
    try { address = new URL(baseUrl); } catch { throw new CoreError("invalid_config", "NapCat MCP配置无效"); }
    const loopback = ["localhost", "[::1]"].includes(address.hostname) || /^127(?:\.\d{1,3}){3}$/.test(address.hostname);
    if (typeof baseUrl !== "string" || address.protocol !== "http:" || !loopback || address.pathname !== "/napcat/mcp"
      || address.username || address.password || address.search || address.hash
      || baseUrl.includes("?") || baseUrl.includes("#")
      || !boundedText(conversationId, 256) || /[\u0000-\u001f\u007f]/.test(conversationId) || typeof clientFactory !== "function") {
      throw new CoreError("invalid_config", "NapCat MCP配置无效");
    }
    this.#baseUrl = address.href;
    this.#conversationId = conversationId;
    this.#clientFactory = clientFactory;
    this.submissionTracking = true;
  }

  #disconnect(connection) {
    if (!connection || connection.closed) return;
    connection.closed = true;
    if (this.#connection === connection) this.#connection = null;
    if (this.#channelConnections.get(connection.lane) === connection) this.#channelConnections.delete(connection.lane);
    const closing = Promise.allSettled([
      Promise.resolve().then(() => connection.transport.close()),
      Promise.resolve().then(() => connection.client.close()),
    ]);
    this.#closing.add(closing);
    void closing.then(() => this.#closing.delete(closing));
  }

  #connect(options, lane) {
    const client = this.#clientFactory();
    if (typeof client?.connect !== "function" || typeof client?.callTool !== "function" || typeof client?.close !== "function") throw unavailable();
    const transport = new StreamableHTTPClientTransport(new URL(this.#baseUrl), {
      requestInit: { redirect: "error", headers: { "x-conversation-id": this.#conversationId } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const connection = { client, transport, lane, closed: false };
    if (lane) this.#channelConnections.set(lane, connection);
    else this.#connection = connection;
    connection.ready = Promise.resolve().then(() => {
      if (connection.closed || this.#closed || options.signal.aborted) throw unavailable();
      return client.connect(transport, options);
    }).catch(() => {
      this.#disconnect(connection);
      throw unavailable();
    });
    return connection;
  }

  async #call(name, args, signal, onRequestStarted, preserveWindowErrors = false, timeoutMs = TIMEOUT_MS, preserveChannelErrors = false, lane) {
    if (this.#closed || signal?.aborted) throw unavailable();
    let connection;
    let requestSent = false;
    let providerFailure = null;
    let onAbort;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const requestSignal = AbortSignal.any([deadline.signal, this.#shutdown.signal, ...(signal ? [signal] : [])]);
    const options = { signal: requestSignal, timeout: timeoutMs, maxTotalTimeout: timeoutMs, resetTimeoutOnProgress: false };
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => {
        this.#disconnect(connection);
        reject(unavailable(requestSent));
      };
      requestSignal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          connection = (lane ? this.#channelConnections.get(lane) : this.#connection) ?? this.#connect(options, lane);
          await Promise.race([connection.ready, interrupted]);
          if (requestSignal.aborted || connection.closed || this.#closed) throw unavailable();
          if (["napcat_owner_alert", "napcat_send_configured_chat_file", "napcat_owner_window_route_register", "napcat_owner_window_route_close"].includes(name)) onRequestStarted?.();
          if (requestSignal.aborted || connection.closed || this.#closed) throw unavailable();
          requestSent = true;
          const result = await Promise.race([
            connection.client.callTool({ name, arguments: args }, undefined, options),
            interrupted,
          ]);
          if (requestSignal.aborted || this.#closed) throw unavailable(true);
          if (preserveChannelErrors) {
            const parsed = structuredChannelResult(result, requestSent);
            providerFailure = parsed.error ?? null;
            if (providerFailure) throw providerFailure;
            return parsed.value;
          }
          if (preserveWindowErrors) {
            const parsed = structuredWindowResult(result, requestSent);
            providerFailure = parsed.error ?? null;
            if (providerFailure) throw providerFailure;
            return parsed.value;
          }
          return structuredResult(result);
        } catch (error) {
          if (providerFailure && error === providerFailure) throw error;
          const expiredHistory = name === "napcat_read_configured_recent" && connection
            && (connection.sessionMissing === true || (requestSent && brokerSessionMissing(error)));
          if (expiredHistory) connection.sessionMissing = true;
          this.#disconnect(connection);
          if (expiredHistory && attempt === 0 && !requestSignal.aborted && !this.#closed) continue;
          throw unavailable(requestSent);
        }
      }
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", onAbort);
    }
  }

  async status({ signal } = {}) {
    return this.#call("napcat_status", { include_group: false }, signal);
  }

  async readConfiguredRecent(parameters = {}, context = {}) {
    let args;
    let signal;
    try {
      const request = windowRecord(parameters, ["target_key", "count", "before_message_id", "include_owner_event_content"]);
      ({ signal } = windowRecord(context, ["signal"]));
      if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted)) throw unavailable();
      const targetKey = windowIdentifier(request.target_key, 256);
      const count = request.count === undefined ? 20 : request.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > 50
        || (request.include_owner_event_content !== undefined && request.include_owner_event_content !== true)) throw unavailable();
      args = { target_key: targetKey, count, include_owner_event_content: true,
        ...(request.before_message_id === undefined ? {} : { before_message_id: windowIdentifier(request.before_message_id, 256) }) };
    } catch {
      throw unavailable();
    }
    return this.#call("napcat_read_configured_recent", args, signal, undefined, false, TIMEOUT_MS, true, "channel_history");
  }

  async downloadConfiguredFile(parameters = {}, context = {}) {
    let args;
    let signal;
    try {
      const request = windowRecord(parameters, ["target_key", "message_id", "attachment_ref", "destination_dir", "name"]);
      ({ signal } = windowRecord(context, ["signal"]));
      if (signal !== undefined && (!(signal instanceof AbortSignal) || signal.aborted)) throw unavailable();
      args = Object.fromEntries([["target_key", 256], ["message_id", 256], ["attachment_ref", 4096], ["destination_dir", 4096]]
        .map(([field, maximum]) => [field, windowIdentifier(request[field], maximum)]));
      if (request.name !== undefined) args.name = windowIdentifier(request.name, 255);
    } catch {
      throw unavailable();
    }
    return this.#call("napcat_download_configured_file", args, signal, undefined, false, 45000, true, "channel_download");
  }

  async sendOwnerAlert({ route_key, dedupe_key, summary, reply_hint } = {}, { signal, onRequestStarted } = {}) {
    if (!boundedText(route_key, 256) || !boundedText(dedupe_key, 200) || !boundedText(summary, 800)
      || (reply_hint !== undefined && !boundedText(reply_hint, 80))) throw unavailable();
    return this.#call("napcat_owner_alert", { route_key, dedupe_key, summary, ...(reply_hint === undefined ? {} : { reply_hint }) }, signal, onRequestStarted);
  }

  async sendConfiguredChatFile({ target_key, file_path, dedupe_key, name } = {}, { signal, onRequestStarted } = {}) {
    if (!boundedText(target_key, 64) || target_key.trim() !== target_key || /[\u0000-\u001f\u007f]/.test(target_key)
      || !boundedText(file_path, 4096) || /[\u0000-\u001f\u007f]/.test(file_path)
      || !boundedText(dedupe_key, 200) || dedupe_key.trim() !== dedupe_key || /[\u0000-\u001f\u007f]/.test(dedupe_key)
      || (name !== undefined && (!boundedText(name, 255) || /[\\/\u0000-\u001f\u007f]/.test(name)))) {
      throw unavailable();
    }
    const args = {
      target_key,
      file_path,
      dedupe_key,
      ...(name === undefined ? {} : { name }),
    };
    return this.#call("napcat_send_configured_chat_file", args, signal, onRequestStarted, false, 45000, true, "channel_upload");
  }

  async readOwnerEvents(parameters, context = {}) {
    let args;
    let signal;
    try {
      const allowed = ["route_key", "original_qq_message_id", "expected_route_generation", "cursor", "limit"];
      if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(parameters))
        || Reflect.ownKeys(parameters).some(key => !allowed.includes(key))
        || !context || typeof context !== "object" || Array.isArray(context)) throw unavailable();
      const identifier = (value, maximum) => boundedText(value, maximum) && value.trim() === value
        && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= maximum;
      const { route_key, original_qq_message_id, expected_route_generation, cursor, limit } = parameters;
      const { conversationId, targetKey } = context;
      signal = context.signal;
      if (!identifier(conversationId, 256) || conversationId !== this.#conversationId || !identifier(targetKey, 256)
        || !identifier(route_key, 256) || typeof original_qq_message_id !== "string"
        || !/^-?[1-9]\d{0,19}$/.test(original_qq_message_id)
        || !Number.isSafeInteger(expected_route_generation) || expected_route_generation < 1
        || (cursor !== undefined && !identifier(cursor, 4096))
        || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50))
        || (signal !== undefined && !(signal instanceof AbortSignal)) || signal?.aborted) throw unavailable();
      args = {
        route_key,
        conversation_id: conversationId,
        original_qq_message_id,
        expected_route_generation,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      };
    } catch {
      throw unavailable();
    }
    return this.#call("napcat_owner_events_read", args, signal);
  }

  async #windowCall(name, parameters, context, allowed, prepare) {
    let scope;
    let args;
    try {
      const request = windowRecord(parameters, allowed);
      scope = windowRecord(context);
      const conversationId = windowIdentifier(scope.conversationId, 256);
      const targetKey = windowIdentifier(scope.targetKey, 64);
      if (conversationId !== this.#conversationId || (scope.signal !== undefined && !(scope.signal instanceof AbortSignal))
        || scope.signal?.aborted || (scope.onRequestStarted !== undefined && typeof scope.onRequestStarted !== "function")) throw unavailable();
      args = { route_key: windowIdentifier(request.route_key, 256), conversation_id: conversationId,
        ...prepare(request, targetKey) };
    } catch {
      throw unavailable();
    }
    return this.#call(name, args, scope.signal, scope.onRequestStarted, true);
  }

  async registerOwnerWindowRoute(parameters, context = {}) {
    return this.#windowCall("napcat_owner_window_route_register", parameters, context,
      ["route_key", "target_key", "capture_owner_events", "reply_delivery", "window_capture", "expected_generation", "dedupe_key", "window_binding"],
      (request, targetKey) => {
        if (request.target_key !== targetKey || request.capture_owner_events !== true || request.reply_delivery !== "events_only"
          || request.window_capture !== true || !Number.isSafeInteger(request.expected_generation) || request.expected_generation < 0) throw unavailable();
        return {
          target_key: targetKey, capture_owner_events: true, reply_delivery: "events_only", window_capture: true,
          expected_generation: request.expected_generation, dedupe_key: windowIdentifier(request.dedupe_key, 200),
          window_binding: normalizeOwnerWindowBinding(request.window_binding),
        };
      });
  }

  async getOwnerWindowRoute(parameters, context = {}) {
    return this.#windowCall("napcat_owner_window_route_get", parameters, context, ["route_key", "dedupe_key"], request => ({
      ...(request.dedupe_key === undefined ? {} : { dedupe_key: windowIdentifier(request.dedupe_key, 200) }),
    }));
  }

  async closeOwnerWindowRoute(parameters, context = {}) {
    return this.#windowCall("napcat_owner_window_route_close", parameters, context, ["route_key", "expected_generation"], request => {
      if (!Number.isSafeInteger(request.expected_generation) || request.expected_generation < 1) throw unavailable();
      return { expected_generation: request.expected_generation };
    });
  }

  async readOwnerWindowEvents(parameters, context = {}) {
    return this.#windowCall("napcat_owner_window_events_read", parameters, context,
      ["route_key", "expected_route_generation", "cursor", "limit"], request => {
        if (!Number.isSafeInteger(request.expected_route_generation) || request.expected_route_generation < 1
          || (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 50))) throw unavailable();
        if (request.cursor !== undefined && !/^[A-Za-z0-9_-]+$/.test(windowIdentifier(request.cursor, 4096))) throw unavailable();
        return {
          expected_route_generation: request.expected_route_generation,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.limit === undefined ? {} : { limit: request.limit }),
        };
      });
  }

  async close() {
    this.#closed = true;
    this.#shutdown.abort();
    this.#disconnect(this.#connection);
    for (const connection of this.#channelConnections.values()) this.#disconnect(connection);
    await Promise.allSettled([...this.#closing]);
  }
}
