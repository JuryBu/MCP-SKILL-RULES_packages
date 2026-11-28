import { createHash } from "node:crypto";

export class CoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }
}

export function requireText(value, name, maxBytes = 262144) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new CoreError("invalid_input", `${name}必须是非空且大小受限的文本`);
  }
  return value;
}

export function requireInteger(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CoreError("invalid_input", `${name}超出整数范围`);
  }
  return value;
}

export function assertExactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreError("invalid_input", `${name}必须是对象`);
  }
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new CoreError("invalid_input", `${name}包含未支持的字段`);
  }
}

export function normalizeIdentity(value) {
  if (!value || typeof value !== "object") throw new CoreError("invalid_input", "缺少明确对话身份");
  return {
    machine_id: requireText(value.machine_id, "machine_id", 128),
    host: requireText(value.host, "host", 64),
    surface: requireText(value.surface ?? "desktop", "surface", 64),
    conversation_id: requireText(value.conversation_id, "conversation_id", 256),
  };
}

export function identityKey(value) {
  const identity = normalizeIdentity(value);
  return JSON.stringify([identity.machine_id, identity.host, identity.surface, identity.conversation_id]);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function normalizeTarget(value) {
  return {
    ...normalizeIdentity(value),
    binding_id: requireText(value.binding_id, "binding_id", 128),
    binding_generation: requireInteger(value.binding_generation, "binding_generation", 1),
    adapter_id: requireText(value.adapter_id, "adapter_id", 128),
    capabilities: {
      next_model_boundary: value.capabilities?.next_model_boundary === true,
      when_idle: value.capabilities?.when_idle === true,
    },
    evidence: requireText(value.evidence ?? "unverified", "evidence", 256),
  };
}

export function hasTargetPermission(principal, target) {
  if (Array.isArray(principal.allowed_targets) && principal.allowed_targets.includes(target.binding_id)) return true;
  return Array.isArray(principal.allowed_target_scopes) && principal.allowed_target_scopes.some(scope =>
    scope.machine_id === target.machine_id && scope.host === target.host && scope.surface === target.surface);
}

export function principalForCaller(principal, caller) {
  if (!caller || typeof caller !== "object" || Array.isArray(caller)) throw new CoreError("invalid_input", "缺少明确对话身份");
  const identity = normalizeIdentity({
    ...caller,
    machine_id: caller.machine_id === undefined ? principal.identity.machine_id : caller.machine_id,
    surface: caller.surface === undefined ? principal.identity.surface : caller.surface,
  });
  if (identity.conversation_id === "*") throw new CoreError("invalid_input", "调用者必须填写自己的具体对话ID");
  if (identityKey(identity) === identityKey(principal.identity)) return principal;
  const scope = principal.caller_scope;
  if (!scope || scope.machine_id !== identity.machine_id || scope.host !== identity.host || scope.surface !== identity.surface) {
    throw new CoreError("caller_mismatch", "来源对话超出当前连接授权");
  }
  return { ...principal, identity };
}

export function canAccessMessage(principal, message) {
  const actor = identityKey(principal.identity);
  return actor === message.source_key || actor === message.target_key;
}

export function normalizeSendInput(input, principal, target, { preserveLegacyVisibility = false } = {}) {
  assertExactKeys(input, ["caller", "origin", "target", "dedupe_key", "text", "attachment_refs", "delivery_policy", "reply_required", "expires_at", "in_reply_to", "origin_receipt_binding", "message_visibility"], "消息");
  const caller = normalizeIdentity(input.caller);
  if (identityKey(caller) !== identityKey(principal.identity)) throw new CoreError("caller_mismatch", "来源对话超出当前连接授权");
  if (!hasTargetPermission(principal, target)) throw new CoreError("forbidden", "当前来源没有目标发送授权");
  assertExactKeys(input.target, ["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation"], "目标");
  if (identityKey(input.target) !== identityKey(target) || input.target.binding_id !== target.binding_id || input.target.binding_generation !== target.binding_generation) {
    throw new CoreError("binding_changed", "目标身份或绑定代次已变化");
  }
  assertExactKeys(input.origin, ["kind", "channel", "source_ref"], "来源");
  if (!(principal.origin_kinds ?? ["agent_message"]).includes(input.origin.kind)) throw new CoreError("source_unverified", "来源类型没有对应授权");
  const origin = {
    kind: requireText(input.origin.kind, "origin.kind", 64),
    channel: requireText(input.origin.channel, "origin.channel", 64),
    source_ref: requireText(input.origin.source_ref, "origin.source_ref", 512),
  };
  const policy = input.delivery_policy ?? "next_model_boundary";
  if (!["next_model_boundary", "when_idle"].includes(policy)) throw new CoreError("invalid_input", "不支持该投递策略");
  const visibility = target.host === "codex" ? input.message_visibility ?? (preserveLegacyVisibility ? undefined : "hidden") : undefined;
  if ((input.message_visibility !== undefined && (target.host !== "codex" || !["hidden", "visible"].includes(input.message_visibility)))
    || (visibility !== undefined && !["hidden", "visible"].includes(visibility))) throw new CoreError("invalid_input", "Codex显示方式只支持hidden或visible");
  const attachments = input.attachment_refs ?? [];
  if (!Array.isArray(attachments) || attachments.length > 32) throw new CoreError("invalid_input", "附件引用数量超出范围");
  const expiry = requireText(input.expires_at, "expires_at", 64);
  if (!Number.isFinite(Date.parse(expiry))) throw new CoreError("invalid_input", "expires_at必须是有效日期");
  if (input.reply_required !== undefined && typeof input.reply_required !== "boolean") throw new CoreError("invalid_input", "reply_required必须是布尔值");
  let receipt = null;
  if (input.origin_receipt_binding !== undefined && input.origin_receipt_binding !== null) {
    receipt = input.origin_receipt_binding;
    assertExactKeys(receipt, ["component", "resource_id", "generation", "wake_id", "notification_id", "event_ids"], "原渠道回执映射");
    if (!principal.channel_component || receipt.component !== principal.channel_component) throw new CoreError("source_unverified", "原渠道映射缺少对应组件授权");
    receipt = {
      component: requireText(receipt.component, "component", 64),
      resource_id: requireText(receipt.resource_id, "resource_id", 256),
      generation: requireInteger(receipt.generation, "generation", 1),
      wake_id: requireText(receipt.wake_id, "wake_id", 256),
      notification_id: receipt.notification_id ? requireText(receipt.notification_id, "notification_id", 256) : null,
      event_ids: receipt.event_ids,
    };
    if (!Array.isArray(receipt.event_ids) || !receipt.event_ids.length || receipt.event_ids.length > 1000) throw new CoreError("invalid_input", "需要明确的原事件集合");
    receipt.event_ids = receipt.event_ids.map(eventId => {
      if (typeof eventId !== "string" && !(Number.isSafeInteger(eventId) && eventId >= 0)) throw new CoreError("invalid_input", "原事件ID必须是文本或安全整数");
      return requireText(String(eventId), "event_id", 256);
    });
    if (new Set(receipt.event_ids).size !== receipt.event_ids.length) throw new CoreError("invalid_input", "原事件ID不可重复");
  }
  return {
    caller,
    origin,
    target: { ...normalizeIdentity(target), binding_id: target.binding_id, binding_generation: target.binding_generation },
    dedupe_key: requireText(input.dedupe_key, "dedupe_key", 128),
    text: requireText(input.text, "text"),
    attachment_refs: attachments.map(reference => requireText(reference, "attachment_ref", 1024)),
    delivery_policy: policy,
    ...(visibility === undefined ? {} : { message_visibility: visibility }),
    reply_required: input.reply_required === true,
    expires_at: expiry,
    in_reply_to: input.in_reply_to ? requireText(input.in_reply_to, "in_reply_to", 256) : null,
    origin_receipt_binding: receipt,
  };
}

export function encodeCursor(messageId, sequence) {
  return Buffer.from(JSON.stringify({ message_id: messageId, sequence })).toString("base64url");
}

export function decodeCursor(cursor, messageId) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    requireText(cursor, "cursor", 512);
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed.message_id !== messageId) throw new Error("scope");
    return requireInteger(parsed.sequence, "sequence");
  } catch {
    throw new CoreError("invalid_cursor", "游标与当前消息不匹配");
  }
}
