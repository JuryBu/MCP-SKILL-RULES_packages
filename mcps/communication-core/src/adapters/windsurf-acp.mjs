import { identityKey, normalizeTarget, requireText } from "../contracts.mjs";
import { renderHostMessage } from "./host-message.mjs";

const OUTCOMES = new Set(["accepted", "busy", "failed_before_send", "unknown"]);
const TRANSIENT_CLOSE_REASONS = new Set([
  "pool_lru_evict", "pool_detach_settled_evict", "idle_ttl_expired", "idle_ttl_reconciled", "stale_entry", "process_exited", "eof",
]);
const MODES = { next_model_boundary: "direct", when_idle: "queue" };

function result(input, outcome, reason, evidence = {}) {
  return {
    delivery_id: input.delivery.delivery_id,
    target_key: identityKey(input.target),
    outcome,
    ...(reason ? { reason } : {}),
    evidence: { kind: "receipt", ...evidence },
  };
}

function busy(input, reason, fixedRetryMs) {
  const retryAfterMs = fixedRetryMs ?? Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, (input.delivery.attempt_count ?? 1) - 1))));
  return { ...result(input, "busy", reason, { request_sent: false, retry_after_ms: retryAfterMs }), error: { code: "unavailable" } };
}

function validInput(input) {
  const target = normalizeTarget(input.target);
  requireText(input.message.message_id, "message_id", 256);
  requireText(input.delivery.delivery_id, "delivery_id", 256);
  return target.host === "windsurf" && target.surface === "desktop"
    && input.delivery.message_id === input.message.message_id && input.delivery.target_key === identityKey(target);
}

function matchesBinding(description, target) {
  return description?.session_id === target.conversation_id && description.connector_id === "devin-cli"
    && typeof description.connection_id === "string" && description.connection_id.length > 0
    && Number.isSafeInteger(description.protocol_version) && description.protocol_version >= 2;
}

export class WindsurfAcpDeliveryAdapter {
  constructor({ clientForTarget, verifyPersistedDelivery, closeCallback } = {}) {
    if (typeof clientForTarget !== "function") throw new TypeError("WSF适配器需要明确目标的客户端工厂");
    if (verifyPersistedDelivery !== undefined && typeof verifyPersistedDelivery !== "function") {
      throw new TypeError("WSF持久化核验器类型无效");
    }
    this.clientForTarget = clientForTarget;
    this.verifyPersistedDelivery = verifyPersistedDelivery;
    this.closeCallback = closeCallback;
    this.submissionTracking = true;
  }

  normalize(response, input, description) {
    if (!response || response.message_id !== input.message.message_id || response.delivery_id !== input.delivery.delivery_id
      || response.session_id !== input.target.conversation_id || !OUTCOMES.has(response.outcome)
      || response.connector_id !== "devin-cli"
      || typeof response.connection_id !== "string" || !response.connection_id.length
      || !Number.isSafeInteger(response.protocol_version) || response.protocol_version < 2
      || description && (response.connection_id !== description.connection_id || response.protocol_version !== description.protocol_version)) {
      return result(input, "unknown", "native_receipt_identity_mismatch");
    }
    if (["busy", "failed_before_send"].includes(response.outcome) && response.request_sent !== false) return result(input, "unknown", "native_write_unconfirmed");
    if (response.outcome === "accepted" && response.request_sent !== true && response.request_sent !== "unknown") return result(input, "unknown", "native_write_unconfirmed");
    if (response.outcome === "busy") return busy(input, response.reason ?? "native_busy_before_send");
    if (response.outcome === "failed_before_send" && response.request_sent === false && TRANSIENT_CLOSE_REASONS.has(response.reason)) {
      return busy(input, response.reason, 500);
    }
    return result(input, response.outcome, response.reason, {
      ...(response.request_sent === false ? { request_sent: false } : {}),
      native: response.evidence ?? null,
      connector_id: response.connector_id,
      connection_id: response.connection_id,
      protocol_version: response.protocol_version,
    });
  }

  async deliver(input) {
    if (input.delivery.status === "unknown") return this.query(input);
    if (input.signal?.aborted) return result(input, "failed_before_send", "aborted_before_send", { request_sent: false });
    let body;
    let mode;
    try {
      if (!validInput(input)) throw new TypeError("目标或消息身份不符");
      const attachments = input.message.envelope.attachment_refs ?? [];
      if (!Array.isArray(attachments) || attachments.length) return result(input, "failed_before_send", "attachment_mapping_unsupported", { request_sent: false });
      mode = Object.hasOwn(MODES, input.message.envelope.delivery_policy) ? MODES[input.message.envelope.delivery_policy] : undefined;
      if (!mode) return result(input, "failed_before_send", "unsupported_delivery_policy", { request_sent: false });
      body = renderHostMessage(input);
    } catch {
      return result(input, "failed_before_send", "invalid_message", { request_sent: false });
    }
    let client;
    let description;
    try {
      client = await this.clientForTarget(input.target, { signal: input.signal });
      if (![client?.describe, client?.deliver, client?.query].every(method => typeof method === "function")) return busy(input, "native_client_unavailable");
      description = await client.describe();
      if (!matchesBinding(description, input.target)) return busy(input, "native_session_binding_unverified");
      if (description.ready !== true) return busy(input, "native_session_not_ready");
    } catch {
      return busy(input, "native_client_unavailable");
    }

    let effectivePolicy = input.message.envelope.delivery_policy;
    if (mode === "queue" && description.capabilities?.queue !== true) {
      if (description.daemon_capabilities?.local_idle_gate === true && description.capabilities?.direct === true && typeof client.isIdleForQueue === "function") {
        const idleCheck = await client.isIdleForQueue({ signal: input.signal });
        if (idleCheck?.idle !== true) {
          return busy(input, idleCheck?.reason ?? "turn_in_progress_waiting_for_idle", 1500);
        }
        effectivePolicy = "next_model_boundary";
      } else {
        return result(input, "failed_before_send", "native_delivery_mode_unverified", { request_sent: false });
      }
    } else if (description.capabilities?.[mode] !== true) {
      return result(input, "failed_before_send", "native_delivery_mode_unverified", { request_sent: false });
    }

    if (input.signal?.aborted) return result(input, "failed_before_send", "aborted_before_send", { request_sent: false });
    let started = false;
    try {
      const response = await client.deliver({
        message_id: input.message.message_id,
        delivery_id: input.delivery.delivery_id,
        session_id: input.target.conversation_id,
        connector_id: description.connector_id,
        connection_id: description.connection_id,
        text: body,
        policy: effectivePolicy,
        signal: input.signal,
        onRequestStarted: async () => {
          if (started) throw new TypeError("原投递只能登记一次写入开始");
          if (input.signal?.aborted) throw new TypeError("投递已取消");
          started = true;
          await input.onRequestStarted?.();
        },
      });
      return this.normalize(response, input, description);
    } catch {
      return result(input, "unknown", "native_submission_unconfirmed");
    }
  }

  async query(input) {
    try {
      if (!validInput(input)) return result(input, "unknown", "invalid_query_identity");
      const client = await this.clientForTarget(input.target, { signal: input.signal, queryOnly: true });
      if (typeof client?.query === "function" && typeof client?.describe === "function") {
        const description = await client.describe();
        if (matchesBinding(description, input.target)) {
          const queried = this.normalize(await client.query({
            message_id: input.message.message_id,
            delivery_id: input.delivery.delivery_id,
            session_id: input.target.conversation_id,
            signal: input.signal,
          }), input, description);
          if (queried.outcome !== "unknown") return queried;
        }
      }
      if (typeof this.verifyPersistedDelivery === "function") {
        const persisted = await this.verifyPersistedDelivery(input.target, {
          messageId: input.message.message_id,
          deliveryId: input.delivery.delivery_id,
          signal: input.signal,
        });
        if (persisted?.verified === true) {
          return result(input, "accepted", undefined, {
            connector_id: "devin-cli",
            protocol_version: 2,
            native: {
              kind: "persisted_session_node_recovered",
              session_id: persisted.slug ?? input.target.conversation_id,
              ...(Number.isSafeInteger(persisted.node_id) ? { node_id: persisted.node_id } : {}),
            },
          });
        }
      }
      return result(input, "unknown", "native_query_unavailable", { retry_after_ms: 5000 });
    } catch {
      return result(input, "unknown", "native_query_unavailable", { retry_after_ms: 5000 });
    }
  }

  async close() {
    await this.closeCallback?.();
  }
}
