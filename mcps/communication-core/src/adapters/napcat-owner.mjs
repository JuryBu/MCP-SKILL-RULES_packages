import { CoreError, identityKey } from "../contracts.mjs";
import { createOwnerReplyReader } from "../owner-replies.mjs";

const SOURCE_HOST_NAMES = new Map([["codex", "Codex"], ["antigravity", "Antigravity"], ["windsurf", "Windsurf"]]);
const SOURCE_TITLE_TIMEOUT_MS = 900;

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function receipt(input, outcome, reason, extra = {}) {
  return {
    delivery_id: input.delivery.delivery_id,
    target_key: identityKey(input.target),
    outcome,
    ...(reason ? { reason } : {}),
    evidence: { kind: "transport", observed_at: new Date().toISOString() },
    ...extra,
  };
}

function busy(input, reason) {
  const attempt = Number.isSafeInteger(input.delivery.attempt_count) ? input.delivery.attempt_count : 1;
  const retryAfterMs = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, attempt - 1))));
  const result = receipt(input, "busy", reason, { error: { code: "unavailable" } });
  result.evidence.retry_after_ms = retryAfterMs;
  return result;
}

function unsupported(input, reason) {
  return receipt(input, "failed_before_send", reason, { error: { code: "unsupported" } });
}

function hasMessageId(value) {
  return (typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value))
    || (Number.isSafeInteger(value) && value !== 0);
}

export function createOwnerSourceTitleReader({ localMachineId, principals, readers }) {
  const authorized = new Map(principals.map(principal => [principal.id, principal]));
  return async (message, { signal } = {}) => {
    const source = message?.envelope?.caller;
    const principal = authorized.get(message?.principal_id);
    if (!localMachineId || source?.machine_id !== localMachineId || !principal || message.relay_inbound ||
      !boundedText(source.conversation_id, 256) || source.conversation_id === "*" || signal?.aborted) return null;
    const sameScope = grant => ["machine_id", "host", "surface"].every(field => grant[field] === source[field]);
    const canList = principal.allowed_host_lists?.some(sameScope) === true;
    if (!canList &&
      !principal.allowed_host_snapshots?.some(grant => sameScope(grant) &&
        (grant.all_conversations === true || grant.conversation_id === source.conversation_id))) return null;
    return readers.get(source.host)?.(source, { signal, canList });
  };
}

async function optionalSourceTitle(reader, message, signal) {
  if (!reader || signal?.aborted) return null;
  const timeout = new AbortController();
  const lookup = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const timer = setTimeout(() => timeout.abort(), SOURCE_TITLE_TIMEOUT_MS);
  let cancel;
  try {
    const aborted = new Promise(resolve => {
      cancel = () => resolve(null);
      lookup.addEventListener("abort", cancel, { once: true });
      if (lookup.aborted) cancel();
    });
    const value = await Promise.race([Promise.resolve().then(() => reader(message, { signal: lookup })), aborted]);
    if (lookup.aborted || !boundedText(value, 128) || /[\p{Cc}\p{Bidi_Control}\u2028\u2029]|\[\s*CQ:/iu.test(value)) return null;
    const title = value.trim();
    return title === message.envelope.caller.conversation_id ? null : title;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    lookup.removeEventListener("abort", cancel);
  }
}

export class NapcatOwnerAdapter {
  constructor({ transport, routeKey, replyHint, replyEvents, conversationId, readSourceTitle } = {}) {
    if (typeof transport?.status !== "function" || typeof transport?.sendOwnerAlert !== "function"
      || !boundedText(routeKey, 256) || (replyHint !== undefined && !boundedText(replyHint, 80))
      || (readSourceTitle !== undefined && typeof readSourceTitle !== "function")) {
      throw new TypeError("NapCat通知适配器配置无效");
    }
    this.transport = transport;
    this.submissionTracking = transport.submissionTracking === true;
    this.routeKey = routeKey;
    this.replyHint = replyHint;
    this.readSourceTitle = readSourceTitle;
    if (conversationId !== undefined && (!boundedText(conversationId, 256) || conversationId.trim() !== conversationId || /[\u0000-\u001f\u007f]/.test(conversationId))) throw new TypeError("QQ路由调用身份无效");
    this.conversationId = conversationId;
    this.replyEvents = null;
    if (replyEvents !== undefined) {
      if (!replyEvents || typeof replyEvents !== "object" || Array.isArray(replyEvents) || typeof replyEvents.enabled !== "boolean") throw new TypeError("QQ回信配置无效");
      if (replyEvents.enabled) {
        if (typeof transport.readOwnerEvents !== "function" || !boundedText(replyEvents.callerConversationId, 256) || conversationId !== replyEvents.callerConversationId
          || !boundedText(replyEvents.targetKey, 256) || !Number.isSafeInteger(replyEvents.routeGeneration) || replyEvents.routeGeneration < 1
          || !Array.isArray(replyEvents.ownerSenderAllowlist) || !replyEvents.ownerSenderAllowlist.length || replyEvents.ownerSenderAllowlist.length > 32
          || Array.from(replyEvents.ownerSenderAllowlist).some(sender => typeof sender !== "string" || !/^[1-9]\d{0,19}$/.test(sender))
          || new Set(replyEvents.ownerSenderAllowlist).size !== replyEvents.ownerSenderAllowlist.length) throw new TypeError("QQ回信配置无效");
        this.replyEvents = Object.freeze({ ...replyEvents, ownerSenderAllowlist: Object.freeze([...replyEvents.ownerSenderAllowlist]) });
      }
    }
    this.closed = false;
  }

  async deliver(input) {
    const envelope = input.message?.envelope;
    if (envelope?.origin?.kind !== "agent_message") return unsupported(input, "agent_origin_required");
    const attachments = envelope.attachment_refs ?? [];
    if (!Array.isArray(attachments) || attachments.length !== 0) return unsupported(input, "attachments_unsupported");
    if (!boundedText(envelope.text, 4000) || [...envelope.text].length > 1000) return unsupported(input, "text_unsupported");
    if (input.target.host !== "qq" || !boundedText(input.target.conversation_id, 256)) return unsupported(input, "qq_target_required");
    const sourceHost = envelope.caller?.host;
    if (!boundedText(sourceHost, 64) || /[\r\n\u0000-\u001f\u007f]/.test(sourceHost)
      || !boundedText(input.delivery.delivery_id, 181)) return unsupported(input, "source_or_delivery_invalid");
    const format = label => `交流核心转送 / 来源${label}：\n${envelope.text}`;
    let summary = format((SOURCE_HOST_NAMES.get(sourceHost) ?? sourceHost) + "对话");
    if (summary.length > 800) return unsupported(input, "owner_alert_summary_too_long");
    if (this.closed || input.signal?.aborted) return busy(input, "aborted_before_send");
    let status;
    try {
      status = await this.transport.status({ signal: input.signal });
    } catch {
      return busy(input, "status_unavailable_before_send");
    }
    if (status?.ready !== true || status.ok === false) return busy(input, "napcat_not_ready");
    const title = await optionalSourceTitle(this.readSourceTitle, input.message, input.signal);
    if (title) {
      const named = format("「" + title + "」");
      if (named.length <= 800) summary = named;
    }
    if (this.closed || input.signal?.aborted) return busy(input, "aborted_before_send");
    let result;
    try {
      result = await this.transport.sendOwnerAlert({
        route_key: this.routeKey,
        dedupe_key: `communication-core:${input.delivery.delivery_id}`,
        summary,
        ...(this.replyHint === undefined ? {} : { reply_hint: this.replyHint }),
      }, { signal: input.signal, ...(typeof input.onRequestStarted === "function" ? { onRequestStarted: input.onRequestStarted } : {}) });
    } catch (error) {
      if (error instanceof CoreError && error.code === "napcat_mcp_unconfirmed" && error.details?.request_sent === false) {
        return busy(input, "transport_unavailable_before_send");
      }
      return receipt(input, "unknown", "owner_alert_submission_unconfirmed");
    }
    if (!result || result.ok !== true || (result.sent !== true && result.deduped !== true)
      || result.verified !== true || result.statePersisted !== true
      || result.target?.targetKey !== input.target.conversation_id || !hasMessageId(result.messageId)) {
      return receipt(input, "unknown", "owner_alert_receipt_unconfirmed");
    }
    const accepted = receipt(input, "accepted");
    accepted.evidence.kind = "receipt";
    accepted.evidence.native_receipt = {
      provider: "napcat_owner",
      message_id: String(result.messageId),
      verified: true,
      state_persisted: true,
    };
    const captured = result.replyRoute;
    if (this.conversationId && captured?.messageId === String(result.messageId) && captured.routeKey === this.routeKey
      && captured.conversationId === this.conversationId && captured.targetKey === input.target.conversation_id
      && Number.isSafeInteger(captured.ownerEventGeneration) && captured.ownerEventGeneration > 0) {
      accepted.evidence.native_receipt.reply_route = { route_key: this.routeKey, conversation_id: this.conversationId, target_key: input.target.conversation_id, generation: captured.ownerEventGeneration };
    }
    return accepted;
  }

  async query(input) {
    return receipt(input, "unknown", "owner_alert_recovery_query_unsupported", { error: { code: "unsupported" } });
  }

  async observeReply(input) {
    if (this.closed || !this.replyEvents || input.signal?.aborted || input.target?.conversation_id !== this.replyEvents.targetKey) return null;
    const capturedRoute = input.delivery?.evidence?.evidence?.native_receipt?.reply_route;
    if (!capturedRoute
      || capturedRoute.route_key !== this.routeKey
      || capturedRoute.conversation_id !== this.replyEvents.callerConversationId
      || capturedRoute.target_key !== this.replyEvents.targetKey
      || capturedRoute.generation !== this.replyEvents.routeGeneration) {
      return null;
    }
    const reader = createOwnerReplyReader({
      enabled: true,
      callerConversationId: this.replyEvents.callerConversationId,
      ownerSenderAllowlist: this.replyEvents.ownerSenderAllowlist,
      binding: {
        message_id: input.message.message_id,
        delivery_id: input.delivery.delivery_id,
        route: { route_key: this.routeKey, conversation_id: this.replyEvents.callerConversationId, target_key: this.replyEvents.targetKey, generation: this.replyEvents.routeGeneration },
      },
      readPage: (parameters, context) => this.transport.readOwnerEvents(parameters, context),
    });
    const observed = await reader(input);
    return observed?.status === "unsupported" ? null : observed;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close?.();
  }
}
