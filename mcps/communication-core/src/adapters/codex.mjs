import { CoreError, identityKey, requireText } from "../contracts.mjs";
import { batchRecipientNotice } from "./host-message.mjs";

function confirmedBusyRetry({ message, delivery, target }) {
  const previous = delivery.evidence;
  const targetKey = identityKey(target);
  return ["prepared", "dispatching"].includes(delivery.status)
    && delivery.message_id === message.message_id && delivery.target_key === targetKey
    && delivery.target_snapshot?.binding_id === target.binding_id
    && delivery.target_snapshot.binding_generation === target.binding_generation
    && delivery.target_snapshot.adapter_id === target.adapter_id && identityKey(delivery.target_snapshot) === targetKey
    && previous?.outcome === "busy" && previous.delivery_id === delivery.delivery_id
    && previous.target_key === targetKey && ["deliver", "query"].includes(previous.evidence?.operation)
    && previous.evidence.kind === "receipt" && previous.evidence.request_sent === false;
}

export class CodexDeliveryAdapter {
  constructor({ transport }) {
    if (typeof transport?.submit !== "function" || typeof transport?.query !== "function") {
      throw new TypeError("Codex transport需要submit和query方法");
    }
    this.transport = transport;
    this.submissionTracking = transport.submissionTracking === true;
  }

  request({ message, delivery, target }) {
    let bodyText = message.envelope.text;
    try {
      const batchNotice = batchRecipientNotice(message);
      if (batchNotice) bodyText = requireText(batchNotice + "\n\n" + bodyText, "群发到 Codex 的正文");
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      throw new CoreError(error.code, error.message, { request_sent: false, local_rejection: true });
    }
    return {
      delivery_id: delivery.delivery_id,
      message_id: message.message_id,
      source: { caller: message.envelope.caller, origin: message.envelope.origin,
        ...(message.source_identity_version === undefined ? {} : { identity_version: message.source_identity_version }) },
      target: {
        machine_id: target.machine_id,
        host: target.host,
        surface: target.surface,
        conversation_id: target.conversation_id,
        binding_id: target.binding_id,
        binding_generation: target.binding_generation,
      },
      body: {
        text: bodyText,
        attachment_refs: message.envelope.attachment_refs,
      },
      delivery_policy: message.envelope.delivery_policy,
      ...(Object.hasOwn(message.envelope, "message_visibility") ? { message_visibility: message.envelope.message_visibility } : {}),
      ...(message.envelope.origin?.kind === "human_message" && message.envelope.origin.channel === "napcat_owner_window" ? {
        window_source: message.native_window_source,
      } : message.envelope.origin?.kind === "human_message" ? {
        in_reply_to: message.envelope.in_reply_to,
        forward_of: message.forward_of,
      } : {}),
    };
  }

  normalize(result, { delivery, target }) {
    const base = { delivery_id: delivery.delivery_id, target_key: identityKey(target) };
    if (!result || typeof result !== "object") return { ...base, outcome: "unknown", reason: "missing_transport_result" };
    let matched = false;
    try {
      matched = result.delivery_id === delivery.delivery_id
        && identityKey(result.target) === base.target_key
        && result.target.binding_id === target.binding_id
        && result.target.binding_generation === target.binding_generation;
    } catch {
    }
    if (!matched) return { ...base, outcome: "unknown", reason: "transport_identity_mismatch" };
    if (!["accepted", "busy", "failed_before_send", "unknown"].includes(result.outcome)) {
      return { ...base, outcome: "unknown", reason: "unsupported_transport_outcome" };
    }
    const normalized = {
      ...base,
      outcome: result.outcome,
      turn_id: typeof result.turn_id === "string" ? result.turn_id : null,
      injection_method: typeof result.injection_method === "string" ? result.injection_method : null,
      evidence: { kind: "receipt" },
    };
    if (result.outcome === "busy") {
      normalized.evidence.retry_after_ms = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, (delivery.attempt_count ?? 1) - 1))));
      if (result.request_sent === false) normalized.evidence.request_sent = false;
    }
    return normalized;
  }

  async deliver(input) {
    if (input.delivery.status === "unknown") return this.query(input);
    if (input.message.envelope.attachment_refs?.length) {
      return { delivery_id: input.delivery.delivery_id, target_key: identityKey(input.target), outcome: "failed_before_send", error: { code: "unsupported" } };
    }
    try {
      const request = this.request(input);
      if (confirmedBusyRetry(input)) request.retry_failed_before_send = true;
      return this.normalize(await this.transport.submit(request, { signal: input.signal, ...(typeof input.onRequestStarted === "function" ? { onRequestStarted: input.onRequestStarted } : {}) }), input);
    } catch (error) {
      if (error instanceof CoreError && error.details?.request_sent === false && error.details?.local_rejection === true) {
        return { delivery_id: input.delivery.delivery_id, target_key: identityKey(input.target), outcome: "failed_before_send",
          error: { code: error.code === "codex_unsupported_request" ? "unsupported" : "invalid_input" } };
      }
      if (error instanceof CoreError && error.code === "codex_control_not_connected" && error.details?.request_sent === false) {
        const retryAfterMs = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, (input.delivery.attempt_count ?? 1) - 1))));
        return { delivery_id: input.delivery.delivery_id, target_key: identityKey(input.target), outcome: "busy", error: { code: "unavailable" }, evidence: { kind: "query", retry_after_ms: retryAfterMs } };
      }
      return { delivery_id: input.delivery.delivery_id, target_key: identityKey(input.target), outcome: "unknown", reason: "transport_submission_unconfirmed" };
    }
  }

  async query(input) {
    try {
      return this.normalize(await this.transport.query({ delivery_id: input.delivery.delivery_id }, { signal: input.signal, request: this.request(input) }), input);
    } catch {
      return { delivery_id: input.delivery.delivery_id, target_key: identityKey(input.target), outcome: "unknown", reason: "transport_query_unavailable" };
    }
  }

  async observeReply(input) {
    if (typeof this.transport.observeReply !== "function") return null;
    try {
      return await this.transport.observeReply(this.request(input), { signal: input.signal });
    } catch {
      return null;
    }
  }
}
