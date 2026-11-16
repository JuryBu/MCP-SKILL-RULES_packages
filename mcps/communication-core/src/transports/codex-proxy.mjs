import { CoreError, requireInteger, requireText, stableStringify } from "../contracts.mjs";
import { normalizeCodexHumanSource, normalizeCodexRelay } from "../codex-human-origin.mjs";
import { CodexSourceRecovery } from "../codex-source-recovery.mjs";

const OUTCOMES = new Set(["accepted", "busy", "failed_before_send", "unknown"]);

function unavailable(code = "codex_control_unconfirmed", details) {
  return new CoreError(code, "Codex控制入口尚未取得可核对结果", details);
}

function rejected(code = "codex_unsupported_request") {
  return new CoreError(code, "Codex请求在HTTP调用前被拒绝", { request_sent: false, local_rejection: true });
}

function controlIdentifier(value) {
  if (typeof value !== "string" || !value.length || value.length > 200 || /[^a-zA-Z0-9_.:-]/.test(value)) throw rejected("invalid_input");
  return value;
}

function connectionRefused(error, depth = 0) {
  if (!error || typeof error !== "object" || depth > 5) return false;
  if (error.code === "ECONNREFUSED" && error.syscall === "connect") return true;
  if (Array.isArray(error.errors) && error.errors.length > 0) return error.errors.every(item => connectionRefused(item, depth + 1));
  return connectionRefused(error.cause, depth + 1);
}

export class CodexProxyTransport {
  #relay;
  #sourceRecovery;

  constructor({ baseUrl, token, relay, sourceRecovery, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
    let address;
    try { address = new URL(baseUrl); } catch { throw unavailable("invalid_config"); }
    if (address.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(address.hostname)
      || address.username || address.password || address.search || address.hash || address.pathname !== "/" || !address.port) throw unavailable("invalid_config");
    this.baseUrl = address.origin;
    this.token = requireText(token, "token", 4096);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = requireInteger(timeoutMs, "timeoutMs", 50, 30000);
    this.#relay = relay === undefined ? null : Object.freeze(normalizeCodexRelay(relay));
    this.#sourceRecovery = sourceRecovery === undefined ? null : new CodexSourceRecovery({ ensure: sourceRecovery, endpoint: this.baseUrl });
    this.closed = false;
    this.submissionTracking = true;
  }

  context(request) {
    try {
      const identityVersion = request?.source?.identity_version ?? 1;
      if (![1, 2].includes(identityVersion)) throw rejected();
      if (request?.target?.host !== "codex" || !request.body
        || (request.body.attachment_refs !== undefined && (!Array.isArray(request.body.attachment_refs) || request.body.attachment_refs.length))
        || !["agent_message", "human_message"].includes(request.source?.origin?.kind)
        || Object.hasOwn(request, "relay") || Object.hasOwn(request.source, "relay")) throw rejected();
      let source;
      if (request.source.origin.kind === "human_message") {
        if (!this.#relay) throw rejected();
        if (request.source.origin.channel === "napcat_owner_window" && identityVersion !== 2) throw rejected("codex_invalid_human_source");
        source = normalizeCodexHumanSource({ origin: request.source.origin, relay: this.#relay,
          in_reply_to: request.in_reply_to, forward_of: request.forward_of,
          window_source: request.window_source, target: request.target, binding_generation: request.target.binding_generation, text: request.body?.text });
        if (request.source.caller?.host !== "qq"
          || request.source.caller.conversation_id !== (source.window_source ?? source.forward_of.native_source).route.target_key) throw rejected("codex_invalid_human_source");
        if (source.window_source && request.source.caller.surface !== source.window_source.window.type) throw rejected("codex_invalid_human_source");
      } else {
        if (["napcat_owner_reply", "napcat_owner_window"].includes(request.source.origin.channel) || request.forward_of !== undefined || request.window_source !== undefined) throw rejected();
        source = { origin: {
          kind: "agent",
          host: requireText(request.source.caller?.host, "source_host", 64),
          conversation_id: controlIdentifier(request.source.caller?.conversation_id),
          ...(identityVersion === 2 ? {
            machine_id: requireText(request.source.caller?.machine_id, "source_machine_id", 128),
            surface: requireText(request.source.caller?.surface, "source_surface", 64),
          } : {}),
        } };
      }
      return {
        delivery_id: controlIdentifier(request.delivery_id),
        message_id: controlIdentifier(request.message_id),
        binding_generation: requireInteger(request.target.binding_generation, "binding_generation", 1),
        origin: source.origin,
        target: { host: "codex", conversation_id: controlIdentifier(request.target.conversation_id),
          ...(identityVersion === 2 ? { machine_id: requireText(request.target.machine_id, "target_machine_id", 128), surface: requireText(request.target.surface, "target_surface", 64) } : {}) },
        ...(source.relay ? { relay: source.relay, ...(source.window_source ? { window_source: source.window_source, text: request.body.text } : { in_reply_to: source.in_reply_to, forward_of: source.forward_of }) } : {}),
      };
    } catch (error) {
      throw rejected(error instanceof CoreError ? error.code : "invalid_input");
    }
  }

  async request(path, { method = "GET", body, signal, envelope = false, onRequestStarted } = {}) {
    if (this.closed) throw unavailable("closed");
    let responseReceived = false;
    try {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      if (requestSignal.aborted) throw unavailable("closed");
      if (method === "POST") onRequestStarted?.();
      const response = await this.fetchImpl(this.baseUrl + path, {
        method, redirect: "error",
        headers: { Authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
      responseReceived = true;
      if (!response.ok) throw unavailable("codex_control_http_error");
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw unavailable("codex_response_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result?.ok !== true || !result.delivery) throw unavailable();
      return envelope ? result : result.delivery;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      if (!responseReceived && connectionRefused(error)) {
        const failure = unavailable("codex_control_not_connected", { request_sent: false });
        if (method === "GET" && this.#sourceRecovery && !this.closed && !signal?.aborted) {
          try { await this.#sourceRecovery.prepare(); } catch (recoveryError) {
            failure.details.source_recovery = recoveryError.details?.source_recovery;
          }
        }
        throw failure;
      }
      throw unavailable();
    }
  }

  normalize(delivery, request, expected) {
    let sourceMatches = false;
    if (expected.origin.kind === "human_message") {
      try {
        sourceMatches = stableStringify(normalizeCodexHumanSource(delivery)) === stableStringify(normalizeCodexHumanSource(expected))
          && delivery.text === request.body.text && delivery.delivery_policy === request.delivery_policy
          && delivery.message_visibility === (request.message_visibility === undefined ? "visible" : request.message_visibility);
      } catch {
      }
    } else {
      sourceMatches = delivery?.origin?.kind === "agent" && delivery.origin.host === expected.origin.host
        && delivery.origin.conversation_id === expected.origin.conversation_id
        && delivery.origin.machine_id === expected.origin.machine_id && delivery.origin.surface === expected.origin.surface
        && !["relay", "in_reply_to", "forward_of", "window_source"].some(key => Object.hasOwn(delivery, key))
        && (request.message_visibility === undefined ? delivery.message_visibility === undefined || delivery.message_visibility === "visible"
          : delivery.message_visibility === request.message_visibility);
    }
    if (delivery.delivery_id !== expected.delivery_id || delivery.message_id !== expected.message_id
      || delivery.binding_generation !== expected.binding_generation || delivery.thread_id !== expected.target.conversation_id
      || !sourceMatches
      || delivery.target?.host !== "codex" || delivery.target?.conversation_id !== expected.target.conversation_id || !OUTCOMES.has(delivery.outcome)) throw unavailable("codex_receipt_identity_mismatch");
    if (delivery.target.machine_id !== expected.target.machine_id || delivery.target.surface !== expected.target.surface) throw unavailable("codex_receipt_identity_mismatch");
    let outcome = delivery.outcome;
    if (outcome === "accepted" && delivery.request_sent !== true) outcome = "unknown";
    if ((outcome === "busy" || outcome === "failed_before_send") && delivery.request_sent !== false) outcome = "unknown";
    return {
      delivery_id: expected.delivery_id,
      target: structuredClone(request.target),
      outcome,
      turn_id: typeof delivery.turn_id === "string" && delivery.turn_id.length <= 256 ? delivery.turn_id : null,
      injection_method: ["turn/start", "turn/steer"].includes(delivery.injection_method) ? delivery.injection_method : null,
      evidence: { kind: "transport_receipt" },
      ...(outcome === "busy" && delivery.request_sent === false ? { request_sent: false } : {}),
    };
  }

  async submit(request, { signal, onRequestStarted } = {}) {
    const expected = this.context(request);
    if (!["next_model_boundary", "when_idle"].includes(request.delivery_policy)) throw rejected();
    const visibility = request.message_visibility === undefined ? "visible" : request.message_visibility;
    if (!["hidden", "visible"].includes(visibility)
      || (request.retry_failed_before_send !== undefined && typeof request.retry_failed_before_send !== "boolean")) throw rejected();
    let text;
    try { text = requireText(request.body.text, "text"); } catch { throw rejected("invalid_input"); }
    const body = { ...expected, text, delivery_policy: request.delivery_policy, message_visibility: visibility,
      ...(request.retry_failed_before_send === true ? { retry_failed_before_send: true } : {}) };
    if (this.#sourceRecovery) {
      const interrupted = () => unavailable("codex_control_not_connected", { request_sent: false, source_recovery: { status: "cancelled" } });
      if (this.closed || signal?.aborted) throw interrupted();
      await this.#sourceRecovery.prepare();
      if (this.closed || signal?.aborted) throw interrupted();
    }
    const delivery = await this.request("/v1/communication/deliveries", { method: "POST", body, signal, onRequestStarted });
    return this.normalize(delivery, request, expected);
  }

  appendQueryIdentity(query, source, target) {
    if (source.machine_id !== undefined) {
      query.set("source_machine_id", source.machine_id);
      query.set("source_surface", source.surface);
    }
    if (target.machine_id !== undefined) {
      query.set("target_host", target.host);
      query.set("target_machine_id", target.machine_id);
      query.set("target_surface", target.surface);
    }
  }

  async query({ delivery_id }, { signal, request } = {}) {
    const expected = this.context(request);
    if (expected.delivery_id !== delivery_id) throw unavailable("codex_query_identity_mismatch");
    const source = expected.origin.kind === "human_message" ? expected.relay : expected.origin;
    const query = new URLSearchParams({ source_host: source.host, source_conversation_id: source.conversation_id, target_conversation_id: expected.target.conversation_id, binding_generation: String(expected.binding_generation) });
    this.appendQueryIdentity(query, source, expected.target);
    const delivery = await this.request(`/v1/communication/deliveries/${encodeURIComponent(delivery_id)}?${query}`, { signal });
    return this.normalize(delivery, request, expected);
  }

  async observeReply(request, { signal } = {}) {
    const expected = this.context(request);
    const source = expected.origin.kind === "human_message" ? expected.relay : expected.origin;
    const cursors = new Set();
    const items = [];
    const itemIds = new Set();
    let cursor;
    let turnId;
    for (let page = 0; page < 8; page += 1) {
      const query = new URLSearchParams({ source_host: source.host, source_conversation_id: source.conversation_id, target_conversation_id: expected.target.conversation_id, binding_generation: String(expected.binding_generation), ...(cursor ? { cursor } : {}) });
      this.appendQueryIdentity(query, source, expected.target);
      const response = await this.request(`/v1/communication/deliveries/${encodeURIComponent(expected.delivery_id)}/replies?${query}`, { signal, envelope: true });
      const normalized = this.normalize(response.delivery, request, expected);
      const observed = response.replies;
      if (normalized.outcome !== "accepted" || normalized.injection_method !== "turn/start" || !observed || observed.supported !== true
        || observed.thread_id !== expected.target.conversation_id || observed.turn_status !== "completed"
        || typeof observed.turn_id !== "string" || observed.turn_id !== normalized.turn_id
        || (turnId && turnId !== observed.turn_id) || !Array.isArray(observed.replies) || observed.replies.length > 1000) return null;
      turnId = observed.turn_id;
      for (const item of observed.replies) {
        if (item.turn_status !== "completed") return null;
        const itemId = requireText(item.item_id, "native_item_id", 256);
        const text = requireText(item.text, "reply_text");
        if (itemIds.has(itemId)) return null;
        itemIds.add(itemId);
        items.push({ itemId, text });
        if (items.length > 1000) return null;
      }
      if (observed.partial !== true) {
        if (!items.length) return null;
        return {
          native_message_id: items.at(-1).itemId,
          native_conversation_id: observed.thread_id,
          native_turn_id: turnId,
          source_step_index: items.length - 1,
          text: requireText(items.map(item => item.text).join("\n\n"), "reply_text"),
        };
      }
      if (typeof observed.cursor !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(observed.cursor) || cursors.has(observed.cursor)) return null;
      cursor = observed.cursor;
      cursors.add(cursor);
    }
    return null;
  }

  async close() {
    this.closed = true;
    this.token = "";
    await this.#sourceRecovery?.close();
  }
}
