import { randomUUID } from "node:crypto";
import { CoreError, assertExactKeys, digest, identityKey, normalizeIdentity, normalizeSendInput, normalizeTarget, requireText } from "./contracts.mjs";
import { normalizeOwnerWindowEvent } from "./owner-window-ingress.mjs";

const SOURCE_FIELDS = ["window_key", "channel", "component", "window_type", "window_id", "channel_binding_id", "target_key", "route_key", "conversation_id", "source_target", "owner_sender_allowlist"];
const MESSAGE_TTL_MS = 86400000;

function sourceError() {
  return new CoreError("source_unverified", "原生窗口消息没有对应已授权的来源和冻结记录");
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function nativeEvent(source) {
  return {
    ...source.event, source_kind: "human_message", route_key: source.route.route_key,
    conversation_id: source.route.conversation_id, target_key: source.route.target_key,
    route_generation: source.route.generation, window: source.window,
    window_binding: source.window_binding, owner_sender_allowlist: source.owner_sender_allowlist,
  };
}

export class OwnerWindowMessages {
  constructor({ core, sources = [] }) {
    this.core = core;
    this.sources = new Map();
    if (!Array.isArray(sources) || sources.length > 256) throw sourceError();
    for (const value of sources) {
      assertExactKeys(value, SOURCE_FIELDS, "原生窗口来源");
      const source = copy(value);
      const expectedKey = `window:${digest([source.channel, source.component, source.window_type, source.window_id])}`;
      if (source.channel !== "qq" || !["private", "group"].includes(source.window_type)
        || source.window_key !== expectedKey || !/^[1-9]\d{0,19}$/.test(source.window_id)
        || this.sources.has(source.window_key)) throw sourceError();
      for (const name of ["component", "channel_binding_id", "target_key", "route_key", "conversation_id"]) {
        requireText(source[name], name, name === "component" ? 64 : name === "target_key" ? 64 : 256);
      }
      const configuredTarget = normalizeTarget(source.source_target);
      const currentTarget = this.core.target(source.channel_binding_id);
      if (digest(configuredTarget) !== digest(currentTarget) || configuredTarget.host !== "qq"
        || configuredTarget.surface !== source.window_type || configuredTarget.conversation_id !== source.target_key) throw sourceError();
      source.source_target = configuredTarget;
      if (!Array.isArray(source.owner_sender_allowlist) || source.owner_sender_allowlist.length < 1
        || source.owner_sender_allowlist.length > 32 || new Set(source.owner_sender_allowlist).size !== source.owner_sender_allowlist.length
        || source.owner_sender_allowlist.some(owner => typeof owner !== "string" || !/^[1-9]\d{0,19}$/.test(owner))) throw sourceError();
      this.sources.set(source.window_key, source);
    }
  }

  normalize(event, windowKey, nativeWindow) {
    const source = this.sources.get(windowKey);
    if (!source || nativeWindow?.channel !== source.channel || nativeWindow.type !== source.window_type
      || nativeWindow.id !== source.window_id) throw sourceError();
    const normalized = normalizeOwnerWindowEvent(event, {
      routeKey: source.route_key, conversationId: source.conversation_id, targetKey: source.target_key,
      window: nativeWindow, sourceTarget: source.source_target, ownerSenderAllowlist: source.owner_sender_allowlist,
    });
    if (!["codex", "antigravity"].includes(normalized.target.host)
      || normalized.target.machine_id !== source.source_target.machine_id) throw sourceError();
    return { source, normalized };
  }

  identity(windowKey, source, target) {
    return {
      id: `owner-window-${digest(windowKey).slice(0, 48)}`,
      identity: normalizeIdentity(source.source_target), allowed_targets: [target.binding_id], origin_kinds: ["human_message"],
    };
  }

  recoverPrincipal(message) {
    try {
      const windowKey = message.native_window_key;
      const nativeSource = message.native_window_source;
      const { source, normalized } = this.normalize(nativeEvent(nativeSource), windowKey, nativeSource.window);
      const principal = this.identity(windowKey, source, normalized.target);
      const expectedDedupe = `owner-window-${digest([source.route_key, normalized.route_generation, normalized.native_event_id])}`;
      if (message.principal_id !== principal.id || message.source_identity_version !== 2
        || message.native_window_hash !== digest({ window_key: windowKey, native_source: normalized.native_source })
        || message.payload_hash !== digest(message.envelope) || message.source_key !== identityKey(principal.identity)
        || message.target_key !== identityKey(normalized.target) || message.dedupe_key !== expectedDedupe
        || message.envelope.origin.kind !== "human_message" || message.envelope.origin.channel !== "napcat_owner_window"
        || message.envelope.origin.source_ref !== `owner-window-event:${normalized.native_event_id}`
        || message.envelope.text !== normalized.text || message.envelope.in_reply_to !== null
        || message.envelope.origin_receipt_binding !== null || message.forward_of !== undefined
        || digest(message.envelope.target) !== digest(normalized.target)) throw sourceError();
      return principal;
    } catch {
      throw sourceError();
    }
  }

  async ingest(event, context) {
    this.core.assertOpen();
    assertExactKeys(context, ["window_key", "native_route"], "窗口消费上下文");
    const windowKey = requireText(context.window_key, "window_key", 256);
    const { source, normalized } = this.normalize(event, windowKey, context.native_route?.window);
    const dedupeKey = `owner-window-${digest([source.route_key, normalized.route_generation, normalized.native_event_id])}`;
    const sourceKey = identityKey(source.source_target);
    const nativeHash = digest({ window_key: windowKey, native_source: normalized.native_source });
    const existing = this.core.store.findMessageByDedupe(sourceKey, dedupeKey);
    if (existing) {
      this.recoverPrincipal(existing);
      if (existing.native_window_hash !== nativeHash) throw new CoreError("dedupe_conflict", "原窗口事件已经对应其它冻结内容");
      const delivery = this.core.store.getDeliveryForMessage(existing.message_id);
      if (!delivery) throw new CoreError("store_integrity_error", "原窗口消息缺少对应投递");
      return { persisted: true, ...this.core.result(existing.message_id), duplicate: true };
    }
    const target = this.core.target(normalized.target.binding_id);
    const principal = this.identity(windowKey, source, target);
    const envelope = copy(normalizeSendInput({
      caller: principal.identity,
      origin: { kind: "human_message", channel: "napcat_owner_window", source_ref: `owner-window-event:${normalized.native_event_id}` },
      target: normalized.target, dedupe_key: dedupeKey, text: normalized.text, attachment_refs: [],
      expires_at: new Date(this.core.now() + MESSAGE_TTL_MS).toISOString(), reply_required: true,
    }, principal, target));
    const persisted = this.core.transaction(append => {
      const original = this.core.store.findMessageByDedupe(sourceKey, dedupeKey);
      if (original) {
        if (original.native_window_hash !== nativeHash) throw new CoreError("dedupe_conflict", "原窗口事件已经对应其它冻结内容");
        return { message_id: original.message_id, duplicate: true };
      }
      const messageId = randomUUID();
      const deliveryId = randomUUID();
      const createdAt = this.core.timestamp();
      this.core.store.insertMessage({
        message_id: messageId, source_key: sourceKey, target_key: identityKey(target), dedupe_key: dedupeKey,
        payload_hash: digest(envelope), principal_id: principal.id, source_identity_version: 2, envelope,
        native_window_key: windowKey, native_window_source: copy(normalized.native_source), native_window_hash: nativeHash,
        created_at: createdAt, delivery_status: "prepared", processing: "pending", model_observed: "unknown", ui_observed: "unknown",
      });
      this.core.store.insertDelivery({
        delivery_id: deliveryId, message_id: messageId, target_key: identityKey(target), target_snapshot: copy(target),
        status: "prepared", attempt_count: 0, created_at: createdAt, updated_at: createdAt,
      });
      append(messageId, "message_created", { delivery_id: deliveryId, source: "native_owner_window" });
      return { message_id: messageId, delivery_id: deliveryId, duplicate: false };
    });
    const result = { persisted: true, ...this.core.result(persisted.message_id), duplicate: persisted.duplicate };
    if (!persisted.duplicate) this.core.enqueue(persisted.delivery_id).catch(error => { this.core.backgroundError = error; });
    return result;
  }
}
