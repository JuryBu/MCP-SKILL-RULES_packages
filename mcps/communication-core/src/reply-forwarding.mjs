import {
  CoreError,
  assertExactKeys,
  digest,
  hasTargetPermission,
  identityKey,
  normalizeIdentity,
  normalizeTarget,
  requireInteger,
  requireText,
} from "./contracts.mjs";
import { OWNER_REPLY_LIMITS } from "./owner-replies.mjs";

const MAX_TTL_MS = 604800000;
const RULE_KEYS = ["id", "source_principal_id", "from_binding_id", "to_binding_id", "ttl_ms", "owner_sender_allowlist", "adopt_reply_events"];
const BINDING_KEYS = ["rule_id", "source_principal_id", "from_target", "to_target", "ttl_ms", "owner_sender_allowlist", "principal_id"];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value, name, maximum = 256) {
  requireText(value, name, maximum);
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CoreError("invalid_input", `${name}必须是完整且无控制字符的标识符`);
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function ownerSenders(value) {
  if (!Array.isArray(value) || !value.length || value.length > OWNER_REPLY_LIMITS.ownerSenders) {
    throw new CoreError("invalid_input", "回信转交需要明确的本人发送者集合");
  }
  const senders = Array.from(value);
  if (senders.some(sender => typeof sender !== "string" || !/^[1-9]\d{0,19}$/.test(sender))
    || new Set(senders).size !== senders.length) {
    throw new CoreError("invalid_input", "本人发送者必须是互不重复的QQ数字标识符");
  }
  return senders;
}

function adoptedEvents(value = []) {
  if (!Array.isArray(value) || value.length > 100) throw new CoreError("invalid_input", "受控恢复事件数量超出范围");
  const seen = new Set();
  return Array.from(value, event => {
    assertExactKeys(event, ["message_id", "native_event_id"], "受控恢复事件");
    const result = {
      message_id: identifier(event.message_id, "adopt.message_id"),
      native_event_id: identifier(event.native_event_id, "adopt.native_event_id"),
    };
    const key = JSON.stringify([result.message_id, result.native_event_id]);
    if (seen.has(key)) throw new CoreError("invalid_input", "受控恢复事件不可重复");
    seen.add(key);
    return result;
  });
}

function forwardingPrincipal(ruleId) {
  return `owner-reply-forward:${ruleId}`;
}

function forwardingTargets(from, to) {
  const fromTarget = normalizeTarget(from);
  const toTarget = normalizeTarget(to);
  if (fromTarget.host !== "qq" || !["antigravity", "codex"].includes(toTarget.host)) {
    throw new CoreError("invalid_input", "本人回信转交仅支持QQ到Antigravity或Codex");
  }
  return { from_target: fromTarget, to_target: toTarget };
}

function normalizeBinding(value) {
  assertExactKeys(value, BINDING_KEYS, "回信转交冻结绑定");
  const ruleId = identifier(value.rule_id, "rule_id", 80);
  const principalId = forwardingPrincipal(ruleId);
  if (value.principal_id !== principalId) throw new CoreError("invalid_input", "回信转交内部身份不匹配");
  return freeze({
    rule_id: ruleId,
    source_principal_id: identifier(value.source_principal_id, "source_principal_id", 128),
    ...forwardingTargets(value.from_target, value.to_target),
    ttl_ms: requireInteger(value.ttl_ms, "ttl_ms", 1, MAX_TTL_MS),
    owner_sender_allowlist: ownerSenders(value.owner_sender_allowlist),
    principal_id: principalId,
  });
}

function bindingFromRule(rule) {
  return normalizeBinding({
    rule_id: rule.id,
    source_principal_id: rule.source_principal_id,
    from_target: rule.from_target,
    to_target: rule.to_target,
    ttl_ms: rule.ttl_ms,
    owner_sender_allowlist: rule.owner_sender_allowlist,
    principal_id: rule.principal_id,
  });
}

function matchesTarget(value, target, adapterRequired = true) {
  return record(value) && identityKey(value) === identityKey(target)
    && value.binding_id === target.binding_id && value.binding_generation === target.binding_generation
    && (adapterRequired ? value.adapter_id === target.adapter_id : value.adapter_id === undefined || value.adapter_id === target.adapter_id);
}

function qqMessageId(value) {
  return typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value);
}

function ownerRoute(value) {
  if (!record(value)) throw new CoreError("invalid_input", "缺少本人回信的原路由");
  return {
    route_key: identifier(value.route_key, "route_key"),
    conversation_id: identifier(value.conversation_id, "route.conversation_id"),
    target_key: identifier(value.target_key, "route.target_key"),
    generation: requireInteger(value.generation, "route.generation", 1),
  };
}

function sameRoute(actual, expected) {
  return actual.route_key === expected.route_key && actual.conversation_id === expected.conversation_id
    && actual.target_key === expected.target_key && actual.generation === expected.generation;
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const localPart = value.slice(0, 19);
  const localDate = new Date(`${localPart}Z`);
  if (!Number.isFinite(localDate.getTime()) || localDate.toISOString().slice(0, 19) !== localPart) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function normalizeReplyForwardingRules(options = {}) {
  try {
    assertExactKeys(options, ["rules", "targets", "principals"], "回信转交配置");
    const { rules = [], targets = [], principals = [] } = options;
    if (!Array.isArray(rules)) throw new CoreError("invalid_input", "回信转交规则必须是数组");
    if (!rules.length) return freeze([]);
    if (!Array.isArray(targets) || !Array.isArray(principals)) {
      throw new CoreError("invalid_input", "回信转交规则、目标与来源身份必须是数组");
    }
    const targetBindings = new Map();
    const targetIdentities = new Set();
    for (const target of Array.from(targets)) {
      const normalized = normalizeTarget(target);
      const key = identityKey(normalized);
      if (targetBindings.has(normalized.binding_id) || targetIdentities.has(key)) {
        throw new CoreError("invalid_input", "回信转交目标身份或绑定不可重复");
      }
      targetBindings.set(normalized.binding_id, normalized);
      targetIdentities.add(key);
    }
    const publicPrincipals = new Map();
    for (const principal of Array.from(principals)) {
      if (!record(principal)) throw new CoreError("invalid_input", "来源身份必须是对象");
      const principalId = identifier(principal.id, "principal.id", 128);
      if (publicPrincipals.has(principalId)) throw new CoreError("invalid_input", "来源身份ID不可重复");
      publicPrincipals.set(principalId, principal);
    }
    const ruleIds = new Set();
    const sources = new Set();
    const internalPrincipals = new Set();
    return freeze(Array.from(rules, rule => {
      assertExactKeys(rule, RULE_KEYS, "回信转交规则");
      const ruleId = identifier(rule.id, "rule.id", 80);
      const sourcePrincipalId = identifier(rule.source_principal_id, "source_principal_id", 128);
      const fromBindingId = identifier(rule.from_binding_id, "from_binding_id", 128);
      const toBindingId = identifier(rule.to_binding_id, "to_binding_id", 128);
      const source = JSON.stringify([sourcePrincipalId, fromBindingId]);
      const principalId = forwardingPrincipal(ruleId);
      if (ruleIds.has(ruleId) || sources.has(source) || internalPrincipals.has(principalId) || publicPrincipals.has(principalId)) {
        throw new CoreError("invalid_input", "回信转交规则、来源绑定或内部身份不可重复");
      }
      const from = targetBindings.get(fromBindingId);
      const to = targetBindings.get(toBindingId);
      if (!from || !to) throw new CoreError("invalid_input", "回信转交规则引用了未登记的目标");
      const scopedTargets = forwardingTargets(from, to);
      const principal = publicPrincipals.get(sourcePrincipalId);
      if (!principal || identityKey(principal.identity) !== identityKey(to) || !hasTargetPermission(principal, from)) {
        throw new CoreError("invalid_input", "回信转交规则缺少唯一且已授权的原来源身份");
      }
      ruleIds.add(ruleId);
      sources.add(source);
      internalPrincipals.add(principalId);
      return {
        id: ruleId,
        source_principal_id: sourcePrincipalId,
        ...scopedTargets,
        ttl_ms: requireInteger(rule.ttl_ms, "ttl_ms", 1, MAX_TTL_MS),
        owner_sender_allowlist: ownerSenders(rule.owner_sender_allowlist),
        adopt_reply_events: adoptedEvents(rule.adopt_reply_events),
        principal_id: principalId,
      };
    }));
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("invalid_input", "回信转交配置无效");
  }
}

export function replyForwardBindingForMessage(rules, principal, target) {
  try {
    if (!Array.isArray(rules) || !record(principal)) return null;
    let selected = null;
    for (const rule of rules) {
      const binding = bindingFromRule(rule);
      if (binding.source_principal_id !== principal.id || !matchesTarget(target, binding.from_target)
        || identityKey(principal.identity) !== identityKey(binding.to_target) || !hasTargetPermission(principal, binding.from_target)) continue;
      if (selected) return null;
      selected = binding;
    }
    return selected;
  } catch {
    return null;
  }
}

export function planOwnerReplyForward(options = {}) {
  try {
    const { message, delivery, reply, binding, observedAt } = options;
    const captured = normalizeBinding(binding);
    const { from_target: from, to_target: to } = captured;
    const observed = isoTimestamp(observedAt);
    if (observed === null || !record(message) || !record(delivery) || !record(reply)) return null;
    const messageId = identifier(message.message_id, "message_id");
    const deliveryId = identifier(delivery.delivery_id, "delivery_id");
    const fromKey = identityKey(from);
    const toKey = identityKey(to);
    const envelope = message.envelope;
    const accepted = delivery.evidence;
    const evidence = accepted?.evidence;
    const receipt = evidence?.native_receipt;
    const partialUnknown = delivery.status === "unknown"
      && (delivery.outcome === undefined || delivery.outcome === "unknown")
      && accepted?.outcome === "unknown"
      && evidence?.partial_delivery === true
      && Array.isArray(envelope?.attachment_refs) && envelope.attachment_refs.length > 0;
    const fullyAccepted = delivery.status === "accepted"
      && (delivery.outcome === undefined || delivery.outcome === "accepted")
      && accepted?.outcome === "accepted";
    if (message.principal_id !== captured.source_principal_id || message.source_key !== toKey || message.target_key !== fromKey
      || !record(envelope) || envelope.origin?.kind !== "agent_message" || identityKey(envelope.caller) !== toKey
      || !matchesTarget(envelope.target, from, false) || !matchesTarget(delivery.target_snapshot, from)
      || delivery.message_id !== messageId || delivery.target_key !== fromKey
      || (!fullyAccepted && !partialUnknown)) return null;
    requireText(envelope.origin.channel, "origin.channel", 64);
    requireText(envelope.origin.source_ref, "origin.source_ref", 512);
    if (message.reply_forward_binding !== undefined && message.reply_forward_binding !== null
      && digest(normalizeBinding(message.reply_forward_binding)) !== digest(captured)) return null;
    if (reply.delivery_id !== undefined && reply.delivery_id !== deliveryId) return null;
    if (accepted.delivery_id !== deliveryId || accepted.target_key !== fromKey
      || evidence?.kind !== "receipt" || receipt?.provider !== "napcat_owner" || receipt.verified !== true
      || receipt.state_persisted !== true || !qqMessageId(receipt.message_id)) return null;
    const capturedRoute = ownerRoute(receipt.reply_route);
    const source = reply.native_source;
    if (!record(source) || source.provider !== "napcat_owner") return null;
    const route = ownerRoute(source.route);
    const event = source.event;
    if (!sameRoute(route, capturedRoute) || route.target_key !== from.conversation_id
      || source.original_qq_message_id !== receipt.message_id || !record(event)) return null;
    const eventId = identifier(event.event_id, "event_id");
    if (!qqMessageId(reply.native_message_id) || reply.native_conversation_id !== from.conversation_id
      || event.message_id !== reply.native_message_id || event.message_id === receipt.message_id
      || !Number.isSafeInteger(reply.source_step_index) || reply.source_step_index < 0 || event.message_seq !== reply.source_step_index
      || event.quoted_message_id !== receipt.message_id || !captured.owner_sender_allowlist.includes(event.sender_id)
      || (reply.native_event_id !== undefined && reply.native_event_id !== eventId)) return null;
    const text = requireText(reply.text, "reply.text", OWNER_REPLY_LIMITS.textBytes);
    if (text.length > OWNER_REPLY_LIMITS.textBytes || (event.text !== undefined && event.text !== text)) return null;
    if (reply.evidence !== undefined && (!record(reply.evidence) || reply.evidence.kind !== "native_reply"
      || reply.evidence.source !== "adapter.observeReply" || !matchesTarget(reply.evidence, from))) return null;
    const nativeSource = {
      provider: "napcat_owner",
      route,
      original_qq_message_id: receipt.message_id,
      event: {
        event_id: eventId,
        message_id: reply.native_message_id,
        message_seq: reply.source_step_index,
        quoted_message_id: receipt.message_id,
        sender_id: event.sender_id,
      },
    };
    return freeze({
      envelope: {
        caller: normalizeIdentity(from),
        origin: { kind: "human_message", channel: "napcat_owner_reply", source_ref: `owner-event:${eventId}` },
        target: { ...normalizeIdentity(to), binding_id: to.binding_id, binding_generation: to.binding_generation },
        dedupe_key: `owner-reply:${digest([messageId, eventId])}`,
        text,
        attachment_refs: [],
        delivery_policy: "next_model_boundary",
        reply_required: false,
        expires_at: new Date(observed + captured.ttl_ms).toISOString(),
        in_reply_to: messageId,
        origin_receipt_binding: null,
      },
      target: to,
      principal_id: captured.principal_id,
      forward_of: { message_id: messageId, delivery_id: deliveryId, native_source: nativeSource },
    });
  } catch {
    return null;
  }
}
