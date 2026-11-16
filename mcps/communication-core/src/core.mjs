import { randomUUID } from "node:crypto";
import {
  CoreError,
  assertExactKeys,
  canAccessMessage,
  decodeCursor,
  digest,
  encodeCursor,
  hasTargetPermission,
  identityKey,
  normalizeIdentity,
  normalizeSendInput,
  principalForCaller,
  normalizeTarget,
  requireInteger,
  requireText,
} from "./contracts.mjs";
import { normalizeReplyForwardingRules, planOwnerReplyForward, replyForwardBindingForMessage } from "./reply-forwarding.mjs";
import { ConversationDirectory, normalizeConversationAddress, normalizeHostScope } from "./conversation-directory.mjs";
import { ChannelBindingManager } from "./channel-bindings.mjs";
import { OwnerWindowMessages } from "./owner-window-messages.mjs";

const DELIVERY_RESULTS = new Set(["accepted", "busy", "failed_before_send", "unknown"]);
const DELIVERY_BOUNDARIES = new Set(["accepted", "failed_before_send", "unknown", "expired", "unsupported"]);
const PROCESSING_TERMINALS = new Set(["done", "failed"]);
const WAIT_CONDITIONS = new Set(["reply", "delivery", "processing", "any"]);
const DELIVERY_PAGE_SIZE = 100;
const REPLY_PAGE_SIZE = 25;
const REPLY_EVENT_PAGE_SIZE = 100;
const ADAPTER_ERROR_MESSAGES = {
  adapter_error: "适配器调用失败，发送结果待核实",
  delivery_timeout: "适配器调用超时，发送结果待核实",
  closed: "交流核心关闭，发送结果待核实",
  invalid_adapter_result: "适配器结果没有对应原投递和准确目标",
  busy: "适配器暂时忙碌，已确认尚未发送",
  failed_before_send: "适配器已确认本次发送尚未发生",
  unknown: "适配器尚未确认本次发送结果",
  unavailable: "适配器暂时不可用",
  rate_limited: "适配器暂时受到请求限制",
  forbidden: "适配器没有执行授权",
  unsupported: "适配器暂不支持该操作",
};
const ADAPTER_EVIDENCE_KINDS = new Set(["simulated", "transport", "receipt", "query"]);

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function registryValues(registry) {
  if (registry instanceof Map) return [...registry.values()];
  if (Array.isArray(registry)) return registry;
  return Object.values(registry ?? {});
}

function lookupAdapter(adapters, adapterId) {
  if (adapters instanceof Map) return adapters.get(adapterId);
  return Object.hasOwn(adapters, adapterId) ? adapters[adapterId] : null;
}

function adapterError(code) {
  const safeCode = typeof code === "string" && Object.hasOwn(ADAPTER_ERROR_MESSAGES, code) ? code : "adapter_error";
  return { code: safeCode, message: ADAPTER_ERROR_MESSAGES[safeCode] };
}

function unknownOutcome(delivery, code) {
  return { outcome: "unknown", delivery_id: delivery.delivery_id, target_key: delivery.target_key, error: adapterError(code) };
}

function safeOwnerRoute(value, targetKey) {
  try {
    if (!value || value.target_key !== targetKey) return null;
    return { route_key: requireText(value.route_key, "reply_route_key", 256), conversation_id: requireText(value.conversation_id, "reply_route_conversation", 256), target_key: targetKey, generation: requireInteger(value.generation, "reply_route_generation", 1) };
  } catch {
    return null;
  }
}

function safeAdapterOutcome(result, delivery, method) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return unknownOutcome(delivery, "invalid_adapter_result");
  const outcome = result.outcome;
  if (!DELIVERY_RESULTS.has(outcome) || result.delivery_id !== delivery.delivery_id || result.target_key !== delivery.target_key) {
    return unknownOutcome(delivery, "invalid_adapter_result");
  }
  const evidence = { operation: method };
  const suppliedEvidence = result.evidence;
  const kind = suppliedEvidence?.kind;
  if (ADAPTER_EVIDENCE_KINDS.has(kind)) evidence.kind = kind;
  if (delivery.target_snapshot?.host === "codex" && outcome === "busy" && kind === "receipt" && suppliedEvidence.request_sent === false) {
    evidence.request_sent = false;
  }
  const observedAt = suppliedEvidence?.observed_at;
  if (typeof observedAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt) && Number.isFinite(Date.parse(observedAt))) {
    evidence.observed_at = new Date(observedAt).toISOString();
  }
  const retryAfterMs = suppliedEvidence?.retry_after_ms;
  if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 45000) evidence.retry_after_ms = retryAfterMs;
  const nativeReceipt = suppliedEvidence?.native_receipt;
  if (outcome === "accepted" && delivery.target_snapshot?.host === "qq" && kind === "receipt"
    && nativeReceipt?.provider === "napcat_owner" && nativeReceipt.verified === true && nativeReceipt.state_persisted === true
    && typeof nativeReceipt.message_id === "string" && /^-?[1-9]\d{0,19}$/.test(nativeReceipt.message_id)) {
    evidence.native_receipt = { provider: "napcat_owner", message_id: nativeReceipt.message_id, verified: true, state_persisted: true };
    const route = safeOwnerRoute(nativeReceipt.reply_route, delivery.target_snapshot.conversation_id);
    if (route) evidence.native_receipt.reply_route = route;
  }
  const normalized = { outcome, delivery_id: delivery.delivery_id, target_key: delivery.target_key, evidence };
  const suppliedError = result.error;
  if (suppliedError !== undefined && suppliedError !== null) normalized.error = adapterError(suppliedError?.code);
  else if (outcome !== "accepted") normalized.error = adapterError(outcome);
  return normalized;
}

function safeOwnerReplySource(result, target, delivery) {
  const source = result.native_source;
  const receipt = delivery?.evidence?.evidence?.native_receipt;
  const route = source?.route;
  const event = source?.event;
  const capturedRoute = safeOwnerRoute(receipt?.reply_route, target.conversation_id);
  if (source?.provider !== "napcat_owner" || receipt?.provider !== "napcat_owner" || receipt.verified !== true || receipt.state_persisted !== true
    || typeof receipt.message_id !== "string" || !/^-?[1-9]\d{0,19}$/.test(receipt.message_id)
    || !capturedRoute || source.original_qq_message_id !== receipt.message_id || route?.target_key !== target.conversation_id
    || route.route_key !== capturedRoute.route_key || route.conversation_id !== capturedRoute.conversation_id || route.generation !== capturedRoute.generation
    || event?.message_id !== result.native_message_id || event?.message_seq !== result.source_step_index
    || event?.quoted_message_id !== receipt.message_id || typeof event.sender_id !== "string" || !/^[1-9]\d{0,19}$/.test(event.sender_id)
    || typeof result.native_message_id !== "string" || !/^-?[1-9]\d{0,19}$/.test(result.native_message_id)) return null;
  return {
    provider: "napcat_owner",
    route: { route_key: requireText(route.route_key, "reply_route_key", 256), conversation_id: requireText(route.conversation_id, "reply_route_conversation", 256), target_key: target.conversation_id, generation: requireInteger(route.generation, "reply_route_generation", 1) },
    original_qq_message_id: receipt.message_id,
    event: { event_id: requireText(event.event_id, "reply_event_id", 256), message_id: result.native_message_id, message_seq: result.source_step_index, quoted_message_id: receipt.message_id, sender_id: event.sender_id },
  };
}

function safeObservedReply(result, target, delivery) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  try {
    const { native_message_id, text, source_step_index, native_conversation_id, native_turn_id, native_trajectory_id, cascade_id, trajectory_id } = result;
    const conversationId = native_conversation_id === undefined ? cascade_id : native_conversation_id;
    if (conversationId !== target.conversation_id || (cascade_id !== undefined && cascade_id !== conversationId)) return null;
    const trajectoryId = native_trajectory_id ?? trajectory_id;
    if (native_trajectory_id !== undefined && native_trajectory_id !== null && trajectory_id !== undefined && trajectory_id !== null
      && native_trajectory_id !== trajectory_id) return null;
    const ownerSource = target.host === "qq" ? safeOwnerReplySource(result, target, delivery) : null;
    if (target.host === "qq" && !ownerSource) return null;
    return {
      native_message_id: requireText(native_message_id, "native_message_id", 256),
      text: requireText(text, "text"),
      source_step_index: requireInteger(source_step_index, "source_step_index"),
      native_conversation_id: conversationId,
      ...(native_turn_id === undefined || native_turn_id === null ? {} : { native_turn_id: requireText(native_turn_id, "native_turn_id", 256) }),
      ...(trajectoryId === undefined || trajectoryId === null ? {} : { native_trajectory_id: requireText(trajectoryId, "native_trajectory_id", 256) }),
      ...(cascade_id === undefined ? {} : { cascade_id }),
      ...(trajectory_id === undefined || trajectory_id === null ? {} : { trajectory_id: trajectoryId }),
      ...(ownerSource ? { native_source: ownerSource } : {}),
    };
  } catch {
    return null;
  }
}

export class CommunicationCore {
  constructor({ store, targets, principals, adapters, replyForwarding = [], conversationRoutes = [], channelWindows = [], ownerWindowSources = [], statusProvider, automaticReplyForwarding = [], now = () => Date.now(), deliveryTimeoutMs = 5000, maxConcurrent = 2 }) {
    this.store = store;
    this.targets = targets ?? [];
    this.principals = principals ?? [];
    this.adapters = adapters ?? {};
    this.directory = conversationRoutes.length ? new ConversationDirectory({ store, targets: registryValues(this.targets), routes: conversationRoutes }) : null;
    this.statusProvider = statusProvider;
    this.automaticReplyForwarding = automaticReplyForwarding;
    this.channelBindings = new ChannelBindingManager({ store, windows: channelWindows, resolveCallerTarget: principal => this.directory
      ? this.directory.byIdentity(principal.identity) : this.resolveAddress(principal, principal.identity) });
    this.ownerWindows = new OwnerWindowMessages({ core: this, sources: ownerWindowSources });
    this.replyForwarding = Array.isArray(replyForwarding) && replyForwarding.length === 0 ? []
      : normalizeReplyForwardingRules({ rules: replyForwarding, targets: registryValues(this.targets), principals: registryValues(this.principals) });
    this.replyForwardPrincipals = this.replyForwarding.map(rule => ({
      id: rule.principal_id,
      identity: normalizeIdentity(rule.from_target),
      allowed_targets: [rule.to_target.binding_id],
      origin_kinds: ["human_message"],
    }));
    this.now = now;
    this.deliveryTimeoutMs = requireInteger(deliveryTimeoutMs, "deliveryTimeoutMs", 1, 2147483647);
    this.maxConcurrent = requireInteger(maxConcurrent, "maxConcurrent", 1);
    this.closed = false;
    this.started = false;
    this.startPromise = null;
    this.closePromise = null;
    this.dispatchPromise = null;
    this.replyPollPromise = null;
    this.replyInvocations = new Set();
    this.backgroundError = null;
    this.jobs = new Map();
    this.queue = [];
    this.activeCount = 0;
    this.controllers = new Set();
    this.waiters = new Map();
  }

  assertOpen() {
    if (this.closed) throw new CoreError("closed", "交流核心已关闭");
  }

  timestamp() {
    return new Date(this.now()).toISOString();
  }

  principal(context, caller) {
    this.assertOpen();
    const principalId = requireText(context?.principal_id, "principal_id", 128);
    const matches = [...registryValues(this.principals), ...this.replyForwardPrincipals].filter(principal => principal.id === principalId);
    if (matches.length !== 1) throw new CoreError("unauthorized", "当前连接没有唯一有效的来源授权");
    const principal = matches[0];
    const effective = principalForCaller(principal, caller);
    if (principal.caller_scope) this.directory?.rememberCaller(effective.identity);
    return effective;
  }

  target(bindingId) {
    requireText(bindingId, "binding_id", 128);
    if (this.directory) return this.directory.byBinding(bindingId);
    const matches = registryValues(this.targets).filter(target => target.binding_id === bindingId);
    if (matches.length !== 1) throw new CoreError("target_not_found", "目标绑定不存在或存在歧义");
    return normalizeTarget(matches[0]);
  }

  authorizedMessage(principal, messageId) {
    requireText(messageId, "message_id", 256);
    const message = this.store.getMessage(messageId);
    if (!message) throw new CoreError("message_not_found", "消息不存在");
    if (!canAccessMessage(principal, message)) throw new CoreError("forbidden", "当前对话没有该消息的访问授权");
    return message;
  }

  result(messageId) {
    return copy({
      message: this.store.getMessage(messageId),
      delivery: this.store.getDeliveryForMessage(messageId),
      next_cursor: encodeCursor(messageId, 0),
    });
  }

  transaction(callback) {
    const changed = new Set();
    const result = this.store.transaction(() => callback((messageId, kind, data = {}) => {
      const event = this.store.appendEvent(messageId, kind, copy(data));
      changed.add(messageId);
      return event;
    }));
    for (const messageId of changed) {
      for (const notify of [...(this.waiters.get(messageId) ?? [])]) notify(false);
    }
    return result;
  }

  changeDelivery(deliveryId, status, patch = {}, append) {
    const delivery = this.store.getDelivery(deliveryId);
    const { outcome, ...persistedPatch } = copy(patch);
    const updated = { ...persistedPatch, status, updated_at: this.timestamp() };
    this.store.updateDelivery(deliveryId, updated);
    this.store.updateMessage(delivery.message_id, { delivery_status: status });
    append(delivery.message_id, "delivery", {
      delivery_id: deliveryId,
      status,
      attempt_count: updated.attempt_count ?? delivery.attempt_count,
      ...(updated.error ? { error: updated.error } : {}),
      ...(outcome ? { outcome } : {}),
    });
  }

  *deliveryPages(statuses, pageSize = DELIVERY_PAGE_SIZE) {
    let afterId;
    while (true) {
      const page = this.store.listDeliveries({ statuses, limit: pageSize, ...(afterId ? { after_id: afterId } : {}) });
      if (!page.length) return;
      let previousId = afterId;
      for (const delivery of page) {
        if (previousId && delivery.delivery_id <= previousId) throw new CoreError("store_pagination_error", "投递分页没有按原游标继续递增");
        previousId = delivery.delivery_id;
      }
      afterId = previousId;
      yield page;
      if (page.length < pageSize) return;
    }
  }

  async start() {
    this.assertOpen();
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      if (this.directory) this.directory.store = this.store;
      this.channelBindings.store = this.store;
      for (const interrupted of this.deliveryPages(["dispatching"])) {
        this.transaction(append => {
          for (const delivery of interrupted) {
            if (this.store.getDelivery(delivery.delivery_id)?.status === "dispatching") {
              this.changeDelivery(delivery.delivery_id, "unknown", { error: { code: "interrupted", message: "投递在上次关闭前尚未取得确定结果" } }, append);
            }
          }
        });
      }
      this.recoverReplyForwards();
      this.started = true;
      this.dispatchPending().catch(() => {});
      return { started: true };
    })();
    return this.startPromise;
  }

  listConversations(context, input) {
    assertExactKeys(input, ["caller", "host", "limit", "cursor"], "对话列表查询");
    const principal = this.principal(context, input.caller);
    if (this.directory) return this.directory.list(principal, input);
    const limit = requireInteger(input.limit ?? 100, "limit", 1, 100);
    const host = input.host === undefined ? null : requireText(input.host, "host", 64);
    const targets = registryValues(this.targets)
      .map(normalizeTarget)
      .filter(target => hasTargetPermission(principal, target) && (host === null || target.host === host))
      .sort((left, right) => `${identityKey(left)}:${left.binding_id}`.localeCompare(`${identityKey(right)}:${right.binding_id}`));
    const scope = `targets:${digest({ principal_id: principal.id, identity: normalizeIdentity(principal.identity), host, targets })}`;
    const offset = decodeCursor(input.cursor, scope);
    if (offset > targets.length) throw new CoreError("invalid_cursor", "游标超出当前对话列表");
    const page = targets.slice(offset, offset + limit);
    const hasMore = offset + page.length < targets.length;
    return copy({ targets: page, next_cursor: hasMore ? encodeCursor(scope, offset + page.length) : null, has_more: hasMore });
  }

  resolveTarget(context, input) {
    assertExactKeys(input, ["caller", "binding_id", "machine_id", "host", "surface", "conversation_id"], "目标解析");
    const principal = this.principal(context, input.caller);
    let target;
    if (input.binding_id !== undefined) {
      if (["machine_id", "host", "surface", "conversation_id"].some(field => input[field] !== undefined)) throw new CoreError("invalid_input", "请选择绑定ID或对话地址其中一种目标写法");
      target = this.target(input.binding_id);
    } else {
      const { caller, ...address } = input;
      target = this.resolveAddress(principal, address);
    }
    if (!hasTargetPermission(principal, target)) throw new CoreError("forbidden", "当前来源没有目标发送授权");
    return { target: copy(target) };
  }

  resolveAddress(principal, reference) {
    if (this.directory) return this.directory.resolve(reference, principal);
    const identity = normalizeConversationAddress(reference, principal.identity.machine_id);
    const matches = registryValues(this.targets).filter(target => target.machine_id === identity.machine_id && target.host === identity.host
      && target.conversation_id === identity.conversation_id && (reference.surface === undefined || target.surface === identity.surface));
    if (matches.length !== 1) throw new CoreError("host_not_enabled", "该对话地址尚无可用宿主接线");
    const target = normalizeTarget(matches[0]);
    if (!hasTargetPermission(principal, target)) throw new CoreError("forbidden", "当前来源没有目标发送授权");
    return target;
  }

  async getStatus(context, input) {
    assertExactKeys(input, ["caller", "binding_id", "machine_id", "host", "surface", "conversation_id"], "状态查询");
    const principal = this.principal(context, input.caller);
    const { caller, ...reference } = input;
    let target;
    if (reference.binding_id !== undefined) target = this.resolveTarget(context, input).target;
    else if (reference.conversation_id !== undefined) {
      const identity = normalizeConversationAddress(reference, principal.identity.machine_id);
      const matches = registryValues(this.targets).filter(candidate => candidate.machine_id === identity.machine_id && candidate.host === identity.host
        && candidate.conversation_id === identity.conversation_id && (reference.surface === undefined || candidate.surface === identity.surface));
      if (matches.length > 1) throw new CoreError("target_not_found", "该对话状态地址需要明确窗口类型");
      const known = matches[0];
      target = known ? normalizeTarget(known) : identity;
      if (!hasTargetPermission(principal, target)) throw new CoreError("forbidden", "当前来源没有该对话状态的读取授权");
    }
    else {
      const { host, machine_id: machineId, surface } = normalizeHostScope({ host: reference.host, machine_id: reference.machine_id ?? principal.identity.machine_id, surface: reference.surface ?? "desktop" });
      const permitted = principal.allowed_target_scopes?.some(scope => scope.machine_id === machineId && scope.host === host && scope.surface === surface)
        || registryValues(this.targets).some(candidate => candidate.machine_id === machineId && candidate.host === host && candidate.surface === surface && hasTargetPermission(principal, candidate));
      if (!permitted) throw new CoreError("forbidden", "当前来源没有该宿主状态的读取授权");
      target = { machine_id: machineId, host, surface };
    }
    if (!this.statusProvider) return { target, observed_at: this.timestamp(), host_online: "unknown", conversation_exists: "unknown", conversation_running: "unknown", can_deliver: "unknown",
      delivery_modes: { next_model_boundary: "unknown", when_idle: "unknown" }, source: "status_provider_not_enabled" };
    return this.statusProvider.getStatus(target, { signal: context.signal });
  }

  automaticReplyBinding(principal, target) {
    if (!principal.caller_scope || !this.directory || target.host !== "qq") return null;
    const matches = this.automaticReplyForwarding.filter(rule => rule.binding_id === target.binding_id);
    if (matches.length !== 1 || !hasTargetPermission(principal, target)) return null;
    const callerTarget = this.directory.byIdentity(principal.identity);
    const configured = matches[0];
    const rule = normalizeReplyForwardingRules({
      rules: [{ id: `automatic-${digest([principal.id, principal.identity, target.binding_id]).slice(0, 48)}`,
        source_principal_id: principal.id, from_binding_id: target.binding_id, to_binding_id: callerTarget.binding_id,
        owner_sender_allowlist: configured.owner_sender_allowlist, ttl_ms: configured.ttl_ms }],
      targets: [target, callerTarget], principals: [principal],
    })[0];
    return replyForwardBindingForMessage([rule], principal, target);
  }

  forwardPrincipal(binding, message) {
    const configured = this.replyForwardPrincipals.find(principal => principal.id === binding?.principal_id);
    if (configured) return this.principal({ principal_id: configured.id }, binding.from_target);
    const source = registryValues(this.principals).find(principal => principal.id === binding?.source_principal_id && principal.caller_scope);
    if (!source || message.principal_id !== source.id) return null;
    const effective = principalForCaller(source, message.envelope.caller);
    const expected = this.automaticReplyBinding(effective, binding.from_target);
    if (!expected || digest(expected) !== digest(binding)) return null;
    return { id: binding.principal_id, identity: normalizeIdentity(binding.from_target), allowed_targets: [binding.to_target.binding_id], origin_kinds: ["human_message"] };
  }

  forwardedMessagePrincipal(message) {
    const original = this.store.getMessage(message.forward_of?.message_id);
    const binding = original?.reply_forward_binding;
    if (!binding) return null;
    const principal = this.forwardPrincipal(binding, original);
    const delivery = this.store.getDeliveryForMessage(original.message_id);
    const source = message.forward_of?.native_source;
    if (!principal || principal.id !== message.principal_id || delivery?.delivery_id !== message.forward_of?.delivery_id) {
      throw new CoreError("source_unverified", "原回信转交的来源授权已变化");
    }
    const observedTime = Date.parse(message.envelope.expires_at) - binding.ttl_ms;
    if (!Number.isFinite(observedTime)) throw new CoreError("source_unverified", "原回信转交的有效期限无效");
    const observedAt = new Date(observedTime).toISOString();
    const planned = planOwnerReplyForward({ message: original, delivery, binding, observedAt, reply: {
      native_message_id: source?.event?.message_id, native_conversation_id: binding.from_target.conversation_id,
      source_step_index: source?.event?.message_seq, text: message.envelope.text, native_source: source,
    } });
    if (!planned || digest(normalizeSendInput(planned.envelope, principal, planned.target)) !== message.payload_hash
      || digest(planned.forward_of) !== digest(message.forward_of)) throw new CoreError("source_unverified", "原回信转交的原生证据不完整");
    return principal;
  }

  manageChannelBinding(context, input) {
    const principal = this.principal(context, input?.caller);
    if (!this.channelBindings) throw new CoreError("channel_not_enabled", "当前服务尚未启用窗口对应关系管理");
    return this.channelBindings.manage(principal, input);
  }

  ingestOwnerWindowEvent(event, context) {
    return this.ownerWindows.ingest(event, context);
  }

  validateReply(envelope) {
    if (!envelope.in_reply_to) return;
    const original = this.store.getMessage(envelope.in_reply_to);
    if (!original) throw new CoreError("reply_not_found", "引用的原消息不存在");
    if (identityKey(envelope.caller) !== original.target_key || identityKey(envelope.target) !== original.source_key) {
      throw new CoreError("invalid_reply", "回复者和回复目标必须分别对应原接收者和原来源");
    }
  }

  persistOwnerReplyForward(message, delivery, reply, binding, observedAt, append) {
    if (!binding) return null;
    const principal = this.forwardPrincipal(binding, message);
    if (!principal) return null;
    const planned = planOwnerReplyForward({ message, delivery, reply, binding, observedAt });
    if (!planned) return null;
    const envelope = copy(normalizeSendInput(planned.envelope, principal, planned.target));
    this.validateReply(envelope);
    const sourceKey = identityKey(envelope.caller);
    const existing = this.store.findMessageByDedupe(sourceKey, envelope.dedupe_key);
    if (existing) {
      if (existing.envelope.in_reply_to !== message.message_id || existing.envelope.origin.kind !== "human_message"
        || existing.envelope.origin.source_ref !== envelope.origin.source_ref || existing.target_key !== message.source_key
        || digest(existing.forward_of) !== digest(planned.forward_of)) throw new CoreError("dedupe_conflict", "原回信转交身份已经对应其它来源");
      const previousDelivery = this.store.getDeliveryForMessage(existing.message_id);
      if (!previousDelivery) throw new CoreError("store_integrity_error", "原回信转交缺少对应投递");
      return { message_id: existing.message_id, delivery_id: previousDelivery.delivery_id, duplicate: true };
    }
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const createdAt = this.timestamp();
    this.store.insertMessage({
      message_id: messageId,
      source_key: sourceKey,
      target_key: identityKey(envelope.target),
      dedupe_key: envelope.dedupe_key,
      payload_hash: digest(envelope),
      principal_id: principal.id,
      source_identity_version: 2,
      envelope,
      forward_of: copy(planned.forward_of),
      created_at: createdAt,
      delivery_status: "prepared",
    });
    this.store.insertDelivery({
      delivery_id: deliveryId,
      message_id: messageId,
      target_key: identityKey(envelope.target),
      target_snapshot: copy(planned.target),
      status: "prepared",
      attempt_count: 0,
      created_at: createdAt,
      updated_at: createdAt,
    });
    append(messageId, "message_created", { delivery_id: deliveryId });
    append(message.message_id, "reply_forward_created", {
      message_id: messageId,
      delivery_id: deliveryId,
      native_message_id: reply.native_message_id,
      source_delivery_id: delivery.delivery_id,
      target: copy(envelope.target),
    });
    return { message_id: messageId, delivery_id: deliveryId, duplicate: false };
  }

  recoverReplyForwards() {
    for (const rule of this.replyForwarding) {
      for (const adoption of rule.adopt_reply_events) {
        const message = this.store.getMessage(adoption.message_id);
        const delivery = message && this.store.getDeliveryForMessage(message.message_id);
        const principal = registryValues(this.principals).find(entry => entry.id === rule.source_principal_id);
        const binding = delivery && principal && replyForwardBindingForMessage([rule], principal, delivery.target_snapshot);
        if (!message || !delivery || !binding) throw new CoreError("invalid_forward_recovery", "精确回信恢复缺少原消息或绑定");
        const matches = [];
        let sequence = 0;
        let finished = false;
        for (let page = 0; page < 100; page += 1) {
          const events = this.store.eventsAfter(message.message_id, sequence, REPLY_EVENT_PAGE_SIZE);
          for (const event of events) {
            if (event.message_id !== message.message_id || event.sequence <= sequence) throw new CoreError("store_pagination_error", "回信恢复游标没有递增");
            sequence = event.sequence;
            if (event.kind === "reply" && event.data?.native_source?.event?.event_id === adoption.native_event_id) matches.push(event);
          }
          if (events.length < REPLY_EVENT_PAGE_SIZE) { finished = true; break; }
        }
        if (!finished || matches.length !== 1) throw new CoreError("invalid_forward_recovery", "精确回信恢复没有唯一原事件");
        const event = matches[0];
        const reply = safeObservedReply(event.data, delivery.target_snapshot, delivery);
        if (!reply || !this.transaction(append => this.persistOwnerReplyForward(message, delivery, reply, binding, event.created_at, append))) {
          throw new CoreError("invalid_forward_recovery", "原引用回信没有通过来源核查");
        }
      }
    }
  }

  async sendMessage(context, input) {
    const principal = this.principal(context, input?.caller);
    const sourceKey = identityKey(principal.identity);
    const dedupeKey = requireText(input.dedupe_key, "dedupe_key", 128);
    const existing = this.store.findMessageByDedupe(sourceKey, dedupeKey);
    const addressed = input.target?.binding_id === undefined;
    const target = existing ? existing.envelope.target : addressed ? this.resolveAddress(principal, input.target) : this.target(input.target.binding_id);
    let normalizedInput = input;
    if (addressed) {
      const identity = normalizeConversationAddress({ ...input.target, surface: input.target?.surface ?? target.surface }, principal.identity.machine_id);
      if (identityKey(identity) !== identityKey(target)) throw new CoreError("dedupe_conflict", "原去重键已经用于另一个对话地址");
      normalizedInput = { ...input, target: { ...normalizeIdentity(target), binding_id: target.binding_id, binding_generation: target.binding_generation } };
    }
    const envelope = copy(normalizeSendInput(normalizedInput, principal, target, {
      preserveLegacyVisibility: Boolean(existing && !Object.hasOwn(existing.envelope, "message_visibility")),
    }));
    const payloadHash = digest(envelope);
    if (existing && existing.payload_hash !== payloadHash) throw new CoreError("dedupe_conflict", "同一去重键已经对应其它消息内容");
    this.validateReply(envelope);
    const persisted = this.transaction(append => {
      const original = this.store.findMessageByDedupe(sourceKey, dedupeKey);
      if (original) {
        if (original.payload_hash !== payloadHash) throw new CoreError("dedupe_conflict", "同一去重键已经对应其它消息内容");
        return { message_id: original.message_id, duplicate: true };
      }
      const messageId = randomUUID();
      const deliveryId = randomUUID();
      const createdAt = this.timestamp();
      const replyForwardBinding = replyForwardBindingForMessage(this.replyForwarding, principal, target) ?? this.automaticReplyBinding(principal, target);
      this.store.insertMessage({
        message_id: messageId,
        source_key: sourceKey,
        target_key: identityKey(envelope.target),
        dedupe_key: dedupeKey,
        payload_hash: payloadHash,
        principal_id: principal.id,
        source_identity_version: 2,
        envelope,
        ...(replyForwardBinding ? { reply_forward_binding: copy(replyForwardBinding) } : {}),
        created_at: createdAt,
        delivery_status: "prepared",
        processing: "pending",
        model_observed: "unknown",
        ui_observed: "unknown",
      });
      this.store.insertDelivery({
        delivery_id: deliveryId,
        message_id: messageId,
        target_key: identityKey(envelope.target),
        target_snapshot: copy(target),
        status: "prepared",
        attempt_count: 0,
        created_at: createdAt,
        updated_at: createdAt,
      });
      append(messageId, "message_created", { delivery_id: deliveryId });
      if (envelope.in_reply_to) {
        append(envelope.in_reply_to, "reply", { message_id: messageId, delivery_id: deliveryId, text: envelope.text });
      }
      return { message_id: messageId, delivery_id: deliveryId, duplicate: false };
    });
    const snapshot = { ...this.result(persisted.message_id), duplicate: persisted.duplicate };
    if (!persisted.duplicate) this.enqueue(persisted.delivery_id).catch(error => { this.backgroundError = error; });
    return snapshot;
  }

  getMessage(context, input) {
    assertExactKeys(input, ["caller", "message_id"], "消息查询");
    const principal = this.principal(context, input.caller);
    const message = this.authorizedMessage(principal, input.message_id);
    return this.result(message.message_id);
  }

  async wait(context, input) {
    assertExactKeys(input, ["caller", "message_id", "after_cursor", "until", "wait_ms", "limit"], "消息等待");
    const principal = this.principal(context, input.caller);
    const message = this.authorizedMessage(principal, input.message_id);
    const until = input.until ?? "reply";
    if (!WAIT_CONDITIONS.has(until)) throw new CoreError("invalid_input", "不支持该等待条件");
    const waitMs = requireInteger(input.wait_ms ?? 0, "wait_ms", 0, 45000);
    const limit = requireInteger(input.limit ?? 100, "limit", 1, 100);
    const sequence = decodeCursor(input.after_cursor, message.message_id);
    if (sequence > this.store.lastSequence(message.message_id)) throw new CoreError("invalid_cursor", "游标超出该消息已有事件");
    const signal = context.signal ?? null;
    if (signal !== null && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      throw new CoreError("invalid_input", "等待取消信号无效");
    }
    const cancelled = {
      message_id: message.message_id,
      matched: false,
      matched_by: "cancelled",
      events: [],
      next_cursor: encodeCursor(message.message_id, sequence),
      timed_out: false,
    };
    if (signal?.aborted) return cancelled;
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const listeners = this.waiters.get(message.message_id) ?? new Set();
      this.waiters.set(message.message_id, listeners);
      const finish = (response, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        listeners.delete(notify);
        if (!listeners.size && this.waiters.get(message.message_id) === listeners) this.waiters.delete(message.message_id);
        if (error) reject(error);
        else resolve(copy(response));
      };
      const onAbort = () => finish(cancelled);
      const notify = timedOut => {
        if (settled) return;
        try {
          const events = this.store.eventsAfter(message.message_id, sequence, limit);
          const matched = events.some(event => {
            if (until === "any") return true;
            if (until === "reply") return event.kind === "reply";
            if (until === "processing") return event.kind === "processing" && PROCESSING_TERMINALS.has(event.data.processing);
            return event.kind === "delivery" && DELIVERY_BOUNDARIES.has(event.data.status);
          });
          if (matched || events.length >= limit || timedOut || this.closed || waitMs === 0) {
            finish({
              message_id: message.message_id,
              matched,
              matched_by: matched ? until : this.closed ? "closed" : null,
              events,
              next_cursor: encodeCursor(message.message_id, events.at(-1)?.sequence ?? sequence),
              timed_out: !matched && !this.closed && (timedOut || waitMs === 0),
            });
          }
        } catch (error) {
          finish(null, error);
        }
      };
      listeners.add(notify);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (settled) return;
      timer = setTimeout(() => notify(true), waitMs);
      notify(false);
    });
  }

  ackProcessing(context, input) {
    assertExactKeys(input, ["caller", "message_id", "delivery_id", "binding_generation", "processing"], "处理回执");
    const principal = this.principal(context, input.caller);
    const message = this.authorizedMessage(principal, input.message_id);
    requireText(input.delivery_id, "delivery_id", 256);
    requireInteger(input.binding_generation, "binding_generation", 1);
    if (identityKey(principal.identity) !== message.target_key) throw new CoreError("forbidden", "只有原接收对话可以确认处理状态");
    if (!["processing", "done", "failed"].includes(input.processing)) throw new CoreError("invalid_input", "处理回执状态无效");
    const delivery = this.store.getDeliveryForMessage(message.message_id);
    if (!delivery || input.delivery_id !== delivery.delivery_id || delivery.message_id !== message.message_id) {
      throw new CoreError("delivery_mismatch", "处理回执没有对应原投递");
    }
    if (input.binding_generation !== message.envelope.target.binding_generation) throw new CoreError("binding_changed", "处理回执没有对应原绑定代次");
    const duplicate = this.transaction(append => {
      const current = this.store.getMessage(message.message_id);
      if (current.processing === input.processing) return true;
      if (PROCESSING_TERMINALS.has(current.processing)) throw new CoreError("processing_conflict", "原消息已经取得终态处理回执");
      const currentDelivery = this.store.getDelivery(delivery.delivery_id);
      if (!["accepted", "dispatching", "unknown"].includes(currentDelivery.status)) throw new CoreError("invalid_state", "该投递尚无接收依据");
      if (currentDelivery.status !== "accepted") {
        this.changeDelivery(delivery.delivery_id, "accepted", { outcome: "accepted", error: null, evidence: { source: "processing_ack", binding_generation: input.binding_generation } }, append);
      }
      this.store.updateMessage(message.message_id, { processing: input.processing });
      append(message.message_id, "processing", { processing: input.processing, delivery_id: delivery.delivery_id, binding_generation: input.binding_generation });
      return false;
    });
    return { ...this.result(message.message_id), duplicate };
  }

  enqueue(deliveryId) {
    if (this.closed) return Promise.resolve();
    const previous = this.jobs.get(deliveryId);
    if (previous) return previous.promise;
    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = { deliveryId, promise, resolve: resolveJob, reject: rejectJob };
    this.jobs.set(deliveryId, job);
    this.queue.push(job);
    this.pump();
    return promise;
  }

  pump() {
    while (!this.closed && this.activeCount < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      this.activeCount += 1;
      Promise.resolve().then(() => this.processDelivery(job.deliveryId)).then(job.resolve, job.reject).finally(() => {
        this.jobs.delete(job.deliveryId);
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  currentDispatchTarget(message, delivery) {
    const ownerWindow = message.envelope.origin.kind === "human_message" && message.envelope.origin.channel === "napcat_owner_window";
    const windowPrincipal = ownerWindow ? this.ownerWindows.recoverPrincipal(message) : null;
    const ownerReply = message.envelope.origin.kind === "human_message" && message.envelope.origin.channel === "napcat_owner_reply";
    const dynamicForward = ownerReply && !this.replyForwardPrincipals.some(principal => principal.id === message.principal_id);
    const forwarded = dynamicForward ? this.forwardedMessagePrincipal(message) : null;
    const principal = windowPrincipal ?? forwarded ?? this.principal({ principal_id: message.principal_id }, message.envelope.caller);
    if (ownerReply && !forwarded) {
      const rules = this.replyForwarding.filter(rule => rule.principal_id === principal.id);
      const sender = message.forward_of?.native_source?.event?.sender_id;
      if (rules.length !== 1 || !rules[0].owner_sender_allowlist.includes(sender)) {
        throw new CoreError("source_unverified", "原回信发送者已不在当前本人授权范围");
      }
    }
    const target = this.target(message.envelope.target.binding_id);
    normalizeSendInput(message.envelope, principal, target);
    if (identityKey(target) !== delivery.target_key || target.adapter_id !== delivery.target_snapshot?.adapter_id) {
      throw new CoreError("binding_changed", "原投递绑定的身份或适配器已经变化");
    }
    return target;
  }

  async processDelivery(deliveryId) {
    if (this.closed) return;
    let delivery = this.store.getDelivery(deliveryId);
    if (!delivery) return;
    let message = this.store.getMessage(delivery.message_id);
    if (!message) throw new CoreError("message_not_found", "投递没有对应消息");
    if (delivery.status === "unknown") {
      const target = delivery.target_snapshot;
      const adapter = target ? lookupAdapter(this.adapters, target.adapter_id) : null;
      if (typeof adapter?.query !== "function") return;
      const outcome = await this.callAdapter(adapter, "query", message, delivery, target);
      this.applyOutcome(deliveryId, outcome, true);
      return;
    }
    if (!["prepared", "unsupported"].includes(delivery.status)) return;
    if (Date.parse(message.envelope.expires_at) <= this.now()) {
      this.transaction(append => this.changeDelivery(deliveryId, "expired", { error: { code: "expired", message: "消息已超过有效期" } }, append));
      return;
    }
    const retryAfterMs = delivery.evidence?.evidence?.retry_after_ms;
    let target;
    try {
      target = this.currentDispatchTarget(message, delivery);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      if (error.code === "target_not_found") {
        if (delivery.status === "prepared" && delivery.evidence?.outcome === "busy" && Number.isSafeInteger(retryAfterMs)
          && this.now() < Date.parse(delivery.updated_at) + retryAfterMs) return;
        this.transaction(append => this.changeDelivery(deliveryId, "prepared", {
          error: { code: "target_not_found", message: "准确目标绑定暂时不可用，原消息已保存等待恢复" },
          evidence: { outcome: "busy", delivery_id: deliveryId, target_key: delivery.target_key, evidence: { operation: "resolve", kind: "query", retry_after_ms: 5000 } },
        }, append));
        return;
      }
      this.transaction(append => this.changeDelivery(deliveryId, "failed_before_send", { error: { code: error.code, message: error.message } }, append));
      return;
    }
    if (delivery.status === "prepared" && delivery.evidence?.outcome === "busy" && Number.isSafeInteger(retryAfterMs)
      && retryAfterMs > 0 && retryAfterMs <= 45000 && this.now() < Date.parse(delivery.updated_at) + retryAfterMs) return;
    const adapter = lookupAdapter(this.adapters, target.adapter_id);
    if (!target.capabilities[message.envelope.delivery_policy] || typeof adapter?.deliver !== "function") {
      if (delivery.status !== "unsupported") {
        this.transaction(append => this.changeDelivery(deliveryId, "unsupported", { error: { code: "unsupported", message: "目标暂不支持指定投递策略或缺少适配器" } }, append));
      }
      return;
    }
    const claimed = this.transaction(append => {
      const current = this.store.getDelivery(deliveryId);
      if (!["prepared", "unsupported"].includes(current.status)) return false;
      this.changeDelivery(deliveryId, "dispatching", { attempt_count: current.attempt_count + 1, error: null, outcome: null }, append);
      return true;
    });
    if (!claimed) return;
    delivery = this.store.getDelivery(deliveryId);
    message = this.store.getMessage(delivery.message_id);
    const outcome = await this.callAdapter(adapter, "deliver", message, delivery, target);
    this.applyOutcome(deliveryId, outcome, false);
  }

  async callAdapter(adapter, method, message, delivery, target) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let requestStarted = false;
    const onRequestStarted = () => {
      if (controller.signal.aborted) throw new CoreError("closed", "投递已取消");
      requestStarted = true;
    };
    const interruptedOutcome = code => {
      if (method !== "deliver" || adapter.submissionTracking !== true || requestStarted) return unknownOutcome(delivery, code);
      const retryAfterMs = Math.min(45000, 1000 * (2 ** Math.min(6, Math.max(0, (delivery.attempt_count ?? 1) - 1))));
      return { outcome: "busy", delivery_id: delivery.delivery_id, target_key: delivery.target_key, error: adapterError("unavailable"), evidence: { operation: method, kind: "query", retry_after_ms: retryAfterMs } };
    };
    let onAbort;
    const interrupted = new Promise(resolve => {
      onAbort = () => resolve({ error: adapterError(controller.signal.reason?.code ?? "closed") });
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort({ code: "delivery_timeout" }), this.deliveryTimeoutMs);
    try {
      let returned;
      try {
        if (controller.signal.aborted) throw new CoreError("closed", "投递已取消");
        returned = adapter[method]({ message: copy(message), delivery: copy(delivery), target: copy(target), signal: controller.signal, onRequestStarted });
      } catch {
        return interruptedOutcome("adapter_error");
      }
      const invocation = Promise.resolve(returned).then(result => ({ result }), () => ({ error: adapterError("adapter_error") }));
      const response = await Promise.race([invocation, interrupted]);
      if (response.error) return interruptedOutcome(response.error.code);
      try {
        return safeAdapterOutcome(response.result, delivery, method);
      } catch {
        return unknownOutcome(delivery, "invalid_adapter_result");
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
    }
  }

  applyOutcome(deliveryId, outcome, queried) {
    this.transaction(append => {
      const current = this.store.getDelivery(deliveryId);
      if (!current || !["dispatching", "unknown"].includes(current.status)) return;
      const confirmedUnsentQuery = queried && current.status === "unknown" && current.target_snapshot?.host === "codex"
        && outcome.evidence?.kind === "receipt" && outcome.evidence.operation === "query" && outcome.evidence.request_sent === false;
      const status = outcome.outcome === "busy" ? queried && !confirmedUnsentQuery ? "unknown" : "prepared" : outcome.outcome;
      this.changeDelivery(deliveryId, status, { outcome: outcome.outcome, error: outcome.error ?? null, evidence: copy(outcome) }, append);
    });
  }

  async dispatchPending() {
    this.assertOpen();
    if (this.dispatchPromise) return this.dispatchPromise;
    this.backgroundError = null;
    const dispatch = (async () => {
      let checked = 0;
      for (const deliveries of this.deliveryPages(["prepared", "unsupported", "unknown"])) {
        if (this.closed) break;
        await Promise.all(deliveries.map(delivery => this.enqueue(delivery.delivery_id)));
        checked += deliveries.length;
      }
      return { checked };
    })();
    this.dispatchPromise = dispatch;
    try {
      return await dispatch;
    } catch (error) {
      this.backgroundError = error;
      throw error;
    } finally {
      if (this.dispatchPromise === dispatch) this.dispatchPromise = null;
    }
  }

  hasReply(messageId) {
    let sequence = 0;
    while (true) {
      const events = this.store.eventsAfter(messageId, sequence, REPLY_EVENT_PAGE_SIZE);
      if (!events.length) return false;
      for (const event of events) {
        if (event.message_id !== messageId || !Number.isSafeInteger(event.sequence) || event.sequence <= sequence) {
          throw new CoreError("store_pagination_error", "回复事件分页没有按原消息游标继续递增");
        }
        sequence = event.sequence;
        if (event.kind === "reply") return true;
      }
      if (events.length < REPLY_EVENT_PAGE_SIZE) return false;
    }
  }

  async callReplyObserver(adapter, message, delivery, target) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let onAbort;
    const interrupted = new Promise(resolve => {
      onAbort = () => resolve(null);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort({ code: "delivery_timeout" }), this.deliveryTimeoutMs);
    const invocation = Promise.resolve().then(() => {
      if (controller.signal.aborted) return null;
      return adapter.observeReply({ message: copy(message), delivery: copy(delivery), target: copy(target), signal: controller.signal });
    }).then(result => controller.signal.aborted ? null : safeObservedReply(result, target, delivery), () => null).finally(() => {
      this.controllers.delete(controller);
      this.replyInvocations.delete(invocation);
    });
    this.replyInvocations.add(invocation);
    try {
      return await Promise.race([invocation, interrupted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  pollReplies() {
    this.assertOpen();
    if (this.replyPollPromise) return this.replyPollPromise;
    const poll = Promise.resolve().then(async () => {
      let checked = 0;
      let replies = 0;
      for (const deliveries of this.deliveryPages(["accepted"], REPLY_PAGE_SIZE)) {
        if (this.closed || this.replyInvocations.size >= this.maxConcurrent) break;
        let nextIndex = 0;
        const worker = async () => {
          while (!this.closed && nextIndex < deliveries.length && this.replyInvocations.size < this.maxConcurrent) {
            const delivery = this.store.getDelivery(deliveries[nextIndex++].delivery_id);
            if (!delivery || delivery.status !== "accepted") continue;
            const message = this.store.getMessage(delivery.message_id);
            if (!message || this.hasReply(message.message_id)) continue;
            let target;
            try {
              target = this.currentDispatchTarget(message, delivery);
            } catch (error) {
              if (!(error instanceof CoreError)) throw error;
              continue;
            }
            const adapter = lookupAdapter(this.adapters, target.adapter_id);
            if (typeof adapter?.observeReply !== "function") continue;
            checked += 1;
            const reply = await this.callReplyObserver(adapter, message, delivery, target);
            if (!reply || this.closed) continue;
            const appended = this.transaction(append => {
              const currentDelivery = this.store.getDelivery(delivery.delivery_id);
              const currentMessage = this.store.getMessage(message.message_id);
              if (!currentDelivery || currentDelivery.status !== "accepted" || currentDelivery.message_id !== message.message_id
                || !currentMessage || this.hasReply(message.message_id)) return false;
              let currentTarget;
              try {
                currentTarget = this.currentDispatchTarget(currentMessage, currentDelivery);
              } catch (error) {
                if (!(error instanceof CoreError)) throw error;
                return false;
              }
              if (identityKey(currentTarget) !== identityKey(target) || currentTarget.binding_id !== target.binding_id
                || currentTarget.binding_generation !== target.binding_generation || currentTarget.adapter_id !== target.adapter_id
                || lookupAdapter(this.adapters, target.adapter_id) !== adapter) return false;
              const ownerSenders = currentMessage.reply_forward_binding?.owner_sender_allowlist;
              if (currentTarget.host === "qq" && currentMessage.reply_forward_binding
                && (!Array.isArray(ownerSenders) || !ownerSenders.includes(reply.native_source?.event?.sender_id))) return false;
              const event = append(message.message_id, "reply", {
                delivery_id: delivery.delivery_id,
                ...reply,
                evidence: {
                  kind: "native_reply",
                  source: "adapter.observeReply",
                  ...normalizeIdentity(target),
                  adapter_id: target.adapter_id,
                  binding_id: target.binding_id,
                  binding_generation: target.binding_generation,
                  observed_at: this.timestamp(),
                },
              });
              const forward = this.persistOwnerReplyForward(currentMessage, currentDelivery, reply, currentMessage.reply_forward_binding, event.created_at, append);
              if (currentMessage.reply_forward_binding && !forward) append(message.message_id, "reply_forward_blocked", { code: "unverified_reply_forward" });
              return { forward_delivery_id: forward?.delivery_id };
            });
            if (appended) {
              replies += 1;
              if (appended.forward_delivery_id) this.enqueue(appended.forward_delivery_id).catch(error => { this.backgroundError = error; });
            }
          }
        };
        const workers = await Promise.allSettled(Array.from({ length: Math.min(this.maxConcurrent, deliveries.length) }, worker));
        const failed = workers.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      }
      return { checked, replies };
    });
    this.replyPollPromise = poll;
    const clearPoll = () => {
      if (this.replyPollPromise === poll) this.replyPollPromise = null;
    };
    poll.then(clearPoll, clearPoll);
    return poll;
  }

  async drain() {
    while (this.dispatchPromise || this.jobs.size) {
      const pending = [...this.jobs.values()].map(job => job.promise);
      if (this.dispatchPromise) pending.push(this.dispatchPromise);
      await Promise.allSettled(pending);
    }
    if (this.backgroundError) throw this.backgroundError;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      for (const listeners of [...this.waiters.values()]) {
        for (const notify of [...listeners]) notify(false);
      }
      for (const job of this.queue.splice(0)) {
        this.jobs.delete(job.deliveryId);
        job.resolve();
      }
      for (const controller of this.controllers) controller.abort({ code: "closed" });
      await Promise.allSettled([this.replyPollPromise, ...this.replyInvocations]);
      await this.drain();
      return { closed: true };
    })();
    return this.closePromise;
  }
}
