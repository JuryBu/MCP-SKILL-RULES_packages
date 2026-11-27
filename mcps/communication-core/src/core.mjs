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
import { ChannelContentReader } from "./channel-content.mjs";
import { batchRecipientNotice } from "./adapters/host-message.mjs";
import { deriveBatchDedupeKeys, normalizeRecipientsInput, planReplyAllSubMessages, projectBatchSendReceipt, projectVisibilityForRecipient,
  renderPeerRecipientsForReceiver, validateAndDedupeRecipients } from "./multi-recipient.mjs";

const DELIVERY_RESULTS = new Set(["accepted", "busy", "failed_before_send", "unknown"]);
const DELIVERY_BOUNDARIES = new Set(["accepted", "failed_before_send", "unknown", "expired", "unsupported"]);
const PROCESSING_TERMINALS = new Set(["done", "failed"]);
const WAIT_CONDITIONS = new Set(["reply", "delivery", "processing", "any"]);
const DELIVERY_PAGE_SIZE = 100;
const REPLY_PAGE_SIZE = 25;
const REPLY_EVENT_PAGE_SIZE = 100;
const CODEX_REPLY_RECENT_MS = 60 * 60 * 1000;
const CODEX_REPLY_PASSIVE_GAP_MS = 10000;
const CODEX_REPLY_WAIT_GAP_MS = 1000;
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
  if (["codex", "windsurf"].includes(delivery.target_snapshot?.host) && outcome === "busy" && kind === "receipt" && suppliedEvidence.request_sent === false) {
    evidence.request_sent = false;
  }
  if (delivery.target_snapshot?.host === "windsurf" && kind === "receipt") {
    if (suppliedEvidence.connector_id === "devin-cli") evidence.connector_id = "devin-cli";
    if (typeof suppliedEvidence.connection_id === "string" && suppliedEvidence.connection_id.length <= 128) evidence.connection_id = suppliedEvidence.connection_id;
    if (Number.isSafeInteger(suppliedEvidence.protocol_version) && suppliedEvidence.protocol_version >= 2) evidence.protocol_version = suppliedEvidence.protocol_version;
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

class CodexReplyPacer {
  constructor(now) {
    this.now = now;
    this.waiters = new WeakSet();
    this.reading = new Set();
    this.passive = { cursor: null, cohortBefore: null, reading: false, nextAt: 0, gap: CODEX_REPLY_PASSIVE_GAP_MS };
    this.waiting = { cursor: null, reading: false, nextAt: 0, gap: CODEX_REPLY_WAIT_GAP_MS };
  }

  begin() {
    const now = this.now();
    return { now, passive: { lane: this.passive, used: false }, waiting: { lane: this.waiting, used: false } };
  }

  available(pass) {
    return !pass.used && !pass.lane.reading && pass.lane.nextAt <= this.now();
  }

  activelyWaiting(listeners) {
    for (const listener of listeners) if (this.waiters.has(listener)) return true;
    return false;
  }

  isOld(pass, message, delivery) {
    const acceptedAt = Date.parse(delivery.updated_at ?? delivery.created_at);
    return message.envelope.reply_required !== true && Number.isFinite(acceptedAt)
      && pass.now - acceptedAt > CODEX_REPLY_RECENT_MS;
  }

  claim(pass, deliveryId) {
    if (!this.available(pass) || pass.lane.cursor !== null && deliveryId <= pass.lane.cursor) return null;
    pass.used = true;
    pass.lane.cursor = deliveryId;
    pass.lane.reading = true;
    return pass.lane;
  }

  reserve(pass, message, delivery, listeners = []) {
    const deliveryId = delivery.delivery_id;
    if (this.reading.has(deliveryId)) return null;
    let lane = null;
    if (this.isOld(pass, message, delivery)) {
      if (this.activelyWaiting(listeners)) lane = this.claim(pass.waiting, deliveryId);
      const cohort = this.passive.cohortBefore ?? pass.now - CODEX_REPLY_RECENT_MS;
      if (lane === null && Date.parse(delivery.updated_at ?? delivery.created_at) <= cohort) {
        lane = this.claim(pass.passive, deliveryId);
        if (lane !== null) lane.cohortBefore = cohort;
      }
      if (lane === null) return null;
    }
    this.reading.add(deliveryId);
    for (const listener of listeners) this.waiters.delete(listener);
    return () => {
      this.reading.delete(deliveryId);
      if (lane !== null) {
        lane.reading = false;
        lane.nextAt = this.now() + lane.gap;
      }
    };
  }

  finish(pass, scanned) {
    if (scanned && this.available(pass.passive)) {
      this.passive.cursor = null;
      this.passive.cohortBefore = null;
    }
  }
}

export class CommunicationCore {
  constructor({ store, targets, principals, adapters, replyForwarding = [], conversationRoutes = [], channelWindows = [], ownerWindowSources = [], downloadLedger, channelDownloadFailure = false, statusProvider, hostContentProvider, automaticReplyForwarding = [], autoCompleteOnReply = false, now = () => Date.now(), deliveryTimeoutMs = 5000, maxConcurrent = 2 }) {
    this.store = store;
    this.targets = targets ?? [];
    this.principals = principals ?? [];
    this.adapters = adapters ?? {};
    this.directory = conversationRoutes.length ? new ConversationDirectory({ store, targets: registryValues(this.targets), routes: conversationRoutes }) : null;
    this.statusProvider = statusProvider;
    this.hostContentProvider = hostContentProvider;
    this.addressBook = null;
    this.relayAcknowledgements = null;
    this.automaticReplyForwarding = automaticReplyForwarding;
    this.autoCompleteOnReply = autoCompleteOnReply === true;
    this.channelBindings = new ChannelBindingManager({ store, windows: channelWindows, resolveCallerTarget: principal => this.directory
      ? this.directory.byIdentity(principal.identity) : this.resolveAddress(principal, principal.identity) });
    this.ownerWindows = new OwnerWindowMessages({ core: this, sources: ownerWindowSources });
    const channelAdapters = this.adapters instanceof Map ? this.adapters : new Map(Object.entries(this.adapters));
    this.createChannelHistoryFallback = () => new ChannelContentReader({ sources: ownerWindowSources, adapters: channelAdapters, now });
    this.channelContent = new ChannelContentReader({ sources: ownerWindowSources, adapters: channelAdapters, now, downloadLedger });
    this.channelDownloadsAvailable = !channelDownloadFailure;
    this.channelHistoryFallback = channelDownloadFailure ? this.channelContent : null;
    this.replyForwarding = Array.isArray(replyForwarding) && replyForwarding.length === 0 ? []
      : normalizeReplyForwardingRules({ rules: replyForwarding, targets: registryValues(this.targets), principals: registryValues(this.principals) });
    this.replyForwardPrincipals = this.replyForwarding.map(rule => ({
      id: rule.principal_id,
      identity: normalizeIdentity(rule.from_target),
      allowed_targets: [rule.to_target.binding_id],
      origin_kinds: ["human_message"],
    }));
    this.now = now;
    this.codexReplies = new CodexReplyPacer(() => this.nowMs());
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

  nowMs() {
    const value = this.now();
    const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ms)) throw new CoreError("invalid_input", "时钟时间无效");
    return ms;
  }

  timestamp() {
    return new Date(this.nowMs()).toISOString();
  }

  principal(context, caller, { remember = true } = {}) {
    this.assertOpen();
    const principalId = requireText(context?.principal_id, "principal_id", 128);
    const matches = [...registryValues(this.principals), ...this.replyForwardPrincipals].filter(principal => principal.id === principalId);
    if (matches.length !== 1) throw new CoreError("unauthorized", "当前连接没有唯一有效的来源授权");
    const principal = matches[0];
    const effective = principalForCaller(principal, caller);
    if (remember && principal.caller_scope) this.directory?.rememberCaller(effective.identity);
    if (context.shared_facade === true && effective.address_book_identity_bound === true) {
      return { ...effective, address_book_identity_bound: false };
    }
    return effective;
  }

  attachAddressBook(options) {
    if (this.addressBook) throw new CoreError("invalid_config", "通讯录已经接入");
    const machineId = requireText(options.machineId, "本机标识", 128);
    this.addressBook = this.store.openAddressBook({
      ...options,
      machineId,
      now: () => this.timestamp(),
      readInbound: (actor, id) => {
        const message = this.store.getMessage(id);
        const sender = message?.envelope?.caller;
        const recipient = message?.envelope?.target;
        if (message?.source_identity_verified !== true || message?.delivery_status !== "accepted" ||
          message.target_key !== identityKey(actor) || !sender || !recipient ||
          identityKey(sender) !== message.source_key || identityKey(recipient) !== message.target_key) return null;
        return { message_id: id, sender: normalizeIdentity(sender), recipient: normalizeIdentity(recipient), source_verified: true };
      },
    });
    this.addressBookMachineId = machineId;
  }

  attachRelayAcknowledgements({ onReady } = {}) {
    if (this.relayAcknowledgements || (onReady !== undefined && typeof onReady !== "function")) {
      throw new CoreError("invalid_config", "跨机回执入口已配置或参数无效");
    }
    this.relayAcknowledgements = this.store.openRelayAcknowledgements({ now: () => this.nowMs() });
    this.relayAcknowledgementReady = onReady;
    return this.relayAcknowledgements;
  }

  attachMessageBatches({ machineId }) {
    if (this.messageBatches) throw new CoreError("invalid_config", "群发入口已经接入");
    this.batchMachineId = requireText(machineId, "本机标识", 128);
    this.messageBatches = this.store.openMessageBatches();
  }

  contactAccess(principal) {
    if (!this.addressBook) throw new CoreError("contacts_unavailable", "本机通讯录尚未启用");
    if (principal.identity.machine_id !== this.addressBookMachineId) throw new CoreError("forbidden", "只可查看本机通讯录");
    return principal.address_book_identity_bound === true && principal.caller_scope == null;
  }

  contactForCaller(principal, alias) {
    const entry = this.contactAccess(principal) ? this.addressBook.resolve(principal, alias) : this.addressBook.resolveShared(alias);
    if (entry.entry_kind === "board") throw new CoreError("board_not_direct_target", "请使用交流板入口，板子不能作为对话收件人");
    return entry;
  }

  resolveDisplayName(receiverIdentity, peerAddress) {
    const receiver = normalizeIdentity(receiverIdentity);
    const peer = normalizeIdentity(peerAddress);
    const name = receiver.machine_id === this.addressBookMachineId ? this.addressBook?.resolveDisplayName(receiver, peer) : undefined;
    return name ?? [peer.machine_id, peer.host, peer.conversation_id].join("/");
  }

  contacts(context, input) {
    const fields = new Map([
      ["list", ["include_machine_routes"]], ["get", ["contact"]], ["save", ["alias", "target", "note"]],
      ["set_note", ["contact", "note"]], ["save_sender", ["message_id", "alias", "note"]], ["remove", ["contact"]],
    ]).get(input?.action);
    if (!fields) throw new CoreError("invalid_input", "通讯录操作无效");
    assertExactKeys(input, ["caller", "action", ...fields], "通讯录");
    const principal = this.principal(context, input.caller, { remember: false });
    const personal = this.contactAccess(principal);
    if (input.action === "list") return personal ? this.addressBook.list(principal, input) : this.addressBook.listShared(input);
    if (input.action === "get") return personal ? this.addressBook.resolve(principal, input.contact) : this.addressBook.resolveShared(input.contact);
    if (!personal) throw new CoreError("caller_unverified", "当前入口仅能查看共有通讯录");
    if (input.action === "save") return this.addressBook.saveAddress(principal, input);
    if (input.action === "save_sender") return this.addressBook.saveSender(principal, input);
    if (input.action === "set_note") return this.addressBook.setNote(principal, input);
    return this.addressBook.remove(principal, input.contact);
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
    const message = this.store.getMessage(messageId);
    if (message?.batch_meta && Object.hasOwn(message.batch_meta, "recipient_labels")) {
      const { recipient_labels: privateLabels, ...publicMetadata } = message.batch_meta;
      message.batch_meta = publicMetadata;
    }
    const relayed = this.remoteRelay?.observation(message);
    return copy({
      message,
      delivery: this.store.getDeliveryForMessage(messageId),
      next_cursor: encodeCursor(messageId, 0),
      ...(relayed ? { remote_delivery: relayed } : {}),
    });
  }

  transaction(callback) {
    const changed = new Set();
    let relayAckStaged = false;
    const result = this.store.transaction(() => callback((messageId, kind, data = {}) => {
      const event = this.store.appendEvent(messageId, kind, copy(data));
      if (kind === "processing" && this.relayAcknowledgements?.stageProcessing(messageId, data.processing)) relayAckStaged = true;
      changed.add(messageId);
      return event;
    }));
    if (relayAckStaged && this.relayAcknowledgementReady && !this.relayAcknowledgementSignalPending) {
      this.relayAcknowledgementSignalPending = true;
      queueMicrotask(() => {
        this.relayAcknowledgementSignalPending = false;
        if (this.closed) return;
        Promise.resolve().then(() => this.relayAcknowledgementReady()).catch(error => { this.relayAcknowledgementSignalError = error; });
      });
    }
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
    assertExactKeys(input, ["caller", "machine_id", "host", "surface", "limit", "cursor", "scope"], "对话列表查询");
    if (input.scope === "host") {
      const principal = this.principal(context, input.caller, { remember: false });
      if (!this.hostContentProvider) throw new CoreError("host_content_unavailable", "宿主列表入口未就绪");
      return this.hostContentProvider.list(principal, input, { signal: context.signal });
    }
    if (input.scope !== undefined && input.scope !== "bindings") throw new CoreError("invalid_input", "不支持的列表范围");
    if (input.machine_id !== undefined || input.surface !== undefined) throw new CoreError("invalid_input", "机器和入口类型筛选仅用于宿主列表");
    const { scope: unusedScope, ...bindingInput } = input;
    const principal = this.principal(context, input.caller);
    if (this.directory) return this.directory.list(principal, bindingInput);
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

  readRecentSnapshot(context, input) {
    const principal = this.principal(context, input?.caller, { remember: false });
    if (!this.hostContentProvider) throw new CoreError("host_content_unavailable", "宿主近期内容入口未就绪");
    if (input?.target?.contact !== undefined) {
      assertExactKeys(input.target, ["contact"], "联系人地址");
      input = { ...input, target: this.contactForCaller(principal, input.target.contact).target };
    }
    return this.hostContentProvider.snapshot(principal, input, { signal: context.signal });
  }

  resolveTarget(context, input) {
    assertExactKeys(input, ["caller", "binding_id", "machine_id", "host", "surface", "conversation_id", "contact"], "目标解析");
    const principal = this.principal(context, input.caller);
    if (input.contact !== undefined) {
      assertExactKeys(input, ["caller", "contact"], "联系人地址");
      input = { caller: input.caller, ...this.contactForCaller(principal, input.contact).target };
    }
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
    assertExactKeys(input, ["caller", "binding_id", "machine_id", "host", "surface", "conversation_id", "contact"], "状态查询");
    const principal = this.principal(context, input.caller);
    if (input.contact !== undefined) {
      assertExactKeys(input, ["caller", "contact"], "联系人地址");
      input = { caller: input.caller, ...this.contactForCaller(principal, input.contact).target };
    }
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
    const status = !this.statusProvider
      ? { target, observed_at: this.timestamp(), host_online: "unknown", conversation_exists: "unknown", conversation_running: "unknown", can_deliver: "unknown",
          delivery_modes: { next_model_boundary: "unknown", when_idle: "unknown" }, source: "status_provider_not_enabled" }
      : await this.statusProvider.getStatus(target, { signal: context.signal });
    if (!this.closed && target.conversation_id !== undefined && typeof this.store?.latestDeliveryIssueForTarget === "function") {
      const issue = this.store.latestDeliveryIssueForTarget(identityKey(target));
      if (issue) {
        const issueMessage = typeof this.store.getMessage === "function" ? this.store.getMessage(issue.message_id) : null;
        if (issueMessage && canAccessMessage(principal, issueMessage)) {
          return { ...status, recent_delivery_issue: copy(issue) };
        }
        const { delivery_id: omittedDeliveryId, message_id: omittedMessageId, ...redactedIssue } = issue;
        return { ...status, recent_delivery_issue: copy(redactedIssue) };
      }
    }
    return status;
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
    return this.channelBindings.manage(principal, { ...input, caller: principal.identity });
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

  #prepareOutgoing(context, input, batchMeta, relayIngress) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CoreError("invalid_input", "消息必须是对象");
    const principal = relayIngress?.principal ?? this.principal(context, input.caller);
    input = { ...input, caller: principal.identity };
    const viaContact = input.target?.contact;
    if (viaContact !== undefined) {
      assertExactKeys(input.target, ["contact"], "联系人地址");
      input = { ...input, target: this.contactForCaller(principal, viaContact).target };
    }
    if (input.origin === undefined) {
      input = { ...input, origin: { kind: "agent_message", channel: principal.identity.host, source_ref: principal.identity.conversation_id } };
    }
    const sourceKey = identityKey(principal.identity);
    const addressed = input.target?.binding_id === undefined;
    let dedupeKey;
    let existing;
    let target;
    let normalizedInput = input;
    if (input.dedupe_key !== undefined) {
      dedupeKey = requireText(input.dedupe_key, "dedupe_key", 128);
      existing = this.store.findMessageByDedupe(sourceKey, dedupeKey);
      target = existing ? existing.envelope.target : addressed ? this.resolveAddress(principal, input.target) : this.target(input.target.binding_id);
      if (addressed) {
        const identity = normalizeConversationAddress({ ...input.target, surface: input.target?.surface ?? target.surface }, principal.identity.machine_id);
        if (identityKey(identity) !== identityKey(target)) throw new CoreError("dedupe_conflict", "原去重键已经用于另一个对话地址");
        normalizedInput = { ...normalizedInput, target: { ...normalizeIdentity(target), binding_id: target.binding_id, binding_generation: target.binding_generation } };
      }
      if (input.expires_at === undefined) {
        const expiresAt = existing
          ? existing.envelope.expires_at
          : new Date((Math.floor(this.nowMs() / 60000) + 1) * 60000 + 86400000).toISOString();
        normalizedInput = { ...normalizedInput, expires_at: expiresAt };
      }
    } else {
      const resolvedTarget = addressed ? this.resolveAddress(principal, input.target) : this.target(input.target.binding_id);
      const bucket = Math.floor(this.nowMs() / 60000);
      const defaultExpiresAt = new Date((bucket + 1) * 60000 + 86400000).toISOString();
      if (addressed) {
        normalizedInput = { ...normalizedInput, target: { ...normalizeIdentity(resolvedTarget), binding_id: resolvedTarget.binding_id, binding_generation: resolvedTarget.binding_generation } };
      }
      if (input.expires_at === undefined) {
        normalizedInput = { ...normalizedInput, expires_at: defaultExpiresAt };
      }
      const canonicalDraft = normalizeSendInput({ ...normalizedInput, dedupe_key: "__auto__" }, principal, resolvedTarget);
      dedupeKey = `auto-${digest({ ...canonicalDraft, dedupe_key: null, minute_bucket: bucket }).slice(0, 24)}`;
      existing = this.store.findMessageByDedupe(sourceKey, dedupeKey);
      target = existing ? existing.envelope.target : resolvedTarget;
      normalizedInput = { ...normalizedInput, dedupe_key: dedupeKey };
    }
    const envelope = copy(normalizeSendInput(normalizedInput, principal, target, {
      preserveLegacyVisibility: Boolean(existing && !Object.hasOwn(existing.envelope, "message_visibility")),
    }));
    const payloadHash = digest(envelope);
    if (existing && existing.payload_hash !== payloadHash) throw new CoreError("dedupe_conflict", "同一去重键已经对应其它消息内容");
    this.validateReply(envelope);
    const persist = append => {
      if (this.addressBook && principal.address_book_identity_bound === true && principal.caller_scope == null &&
        principal.identity.machine_id === this.addressBookMachineId) this.addressBook.openForSend(principal);
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
        ...(relayIngress?.sourceVerified === true || (principal.address_book_identity_bound === true && principal.caller_scope == null)
          ? { source_identity_verified: true } : {}),
        ...(relayIngress ? { relay_inbound: true } : {}),
        envelope,
        ...(batchMeta ? { batch_meta: copy(batchMeta) } : {}),
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
        if (this.autoCompleteOnReply) {
          const origMsg = this.store.getMessage(envelope.in_reply_to);
          const origDel = this.store.getDeliveryForMessage(envelope.in_reply_to);
          if (origMsg && origDel && (origDel.status === "accepted" || origDel.status === "unknown")) {
            const origGeneration = origDel.target_snapshot?.binding_generation ?? origMsg.envelope.target.binding_generation;
            if (origDel.status === "unknown") {
              this.changeDelivery(origDel.delivery_id, "accepted", {
                outcome: "accepted",
                error: null,
                evidence: { source: "reply_ack", binding_generation: origGeneration },
              }, append);
            }
            if (origMsg.processing === "pending") {
              this.store.updateMessage(origMsg.message_id, {
                processing: "done",
                ...(origMsg.model_observed === "unknown" ? { model_observed: "observed" } : {}),
              });
              append(origMsg.message_id, "processing", {
                processing: "done",
                delivery_id: origDel.delivery_id,
                binding_generation: origGeneration,
                auto_completed_by_reply: true,
                reply_message_id: messageId,
              });
            } else if (origMsg.model_observed === "unknown") {
              this.store.updateMessage(origMsg.message_id, { model_observed: "observed" });
            }
          }
        }
      }
      return { message_id: messageId, delivery_id: deliveryId, duplicate: false };
    };
    return { persist, viaContact, existingId: existing?.message_id, envelope };
  }

  #resolveBatchTarget(principal, reference) {
    if (typeof reference === "string") reference = { contact: reference };
    assertExactKeys(reference, ["contact", "binding_id", "binding_generation", "machine_id", "host", "surface", "conversation_id"], "群发收件人");
    if (reference.contact !== undefined) {
      assertExactKeys(reference, ["contact"], "联系人地址");
      return this.resolveAddress(principal, this.contactForCaller(principal, reference.contact).target);
    }
    if (reference.binding_id === undefined) {
      if (reference.binding_generation !== undefined) throw new CoreError("invalid_input", "绑定代次必须与绑定地址一起填写");
      return this.resolveAddress(principal, reference);
    }
    const target = this.target(reference.binding_id);
    if (["machine_id", "host", "surface", "conversation_id", "binding_generation"].some(field => reference[field] !== undefined && reference[field] !== target[field])) {
      throw new CoreError("binding_changed", "群发收件人的绑定已变化");
    }
    return target;
  }

  #sendBatch(context, input) {
    if (!this.messageBatches) throw new CoreError("unsupported_op", "本机尚未启用多收件人发送");
    const { receipt, deliveries } = this.transaction(append => this.#stageBatch(context, input, append));
    for (const deliveryId of deliveries) this.enqueue(deliveryId).catch(error => { this.backgroundError = error; });
    return receipt;
  }

  #stageBatch(context, input, append) {
    assertExactKeys(input, ["caller", "origin", "target", "targets", "dedupe_key", "text", "attachment_refs", "delivery_policy", "reply_required",
      "expires_at", "in_reply_to", "origin_receipt_binding", "message_visibility"], "群发消息");
    const { rawTargets, isBatch } = normalizeRecipientsInput(input);
    if (!isBatch) throw new CoreError("invalid_input", "群发需要提供收件人列表");
    const principal = this.principal(context, input.caller, { remember: false });
    const sourceKey = identityKey(principal.identity);
    const { targets, targetKeys, deduplicatedCount } = validateAndDedupeRecipients(rawTargets.map(target => this.#resolveBatchTarget(principal, target)), { principal });
    if (!this.remoteRelay && targets.some(target => target.machine_id !== this.batchMachineId)) {
      throw new CoreError("unsupported_op", "远端群发尚未接入；本次没有登记或投递任何收件人");
    }
    const original = input.in_reply_to ? this.store.getMessage(requireText(input.in_reply_to, "in_reply_to", 256)) : undefined;
    const reply = input.in_reply_to ? planReplyAllSubMessages({ originalMessage: original, callerIdentity: principal.identity, targets }) : null;
    const replyPlan = new Map(reply?.subMessages.map(entry => [entry.targetKey, entry.envelopeInReplyTo]));
    const messageVisibility = targets.some(target => target.host === "codex") ? input.message_visibility ?? "hidden" : undefined;
    const { batchId, parentDedupeKey, batchPayloadHash, entries } = deriveBatchDedupeKeys({
      parentDedupeKey: input.dedupe_key === undefined ? undefined : requireText(input.dedupe_key, "dedupe_key", 128),
      sourceKey, canonicalTargets: targetKeys, text: input.text, deliveryPolicy: input.delivery_policy, minuteBucket: Math.floor(this.nowMs() / 60000),
      replyToBatchId: reply?.replyToBatchId, replyToMessageId: reply?.replyToMessageId,
      attachmentRefs: input.attachment_refs, replyRequired: input.reply_required, messageVisibility,
    });
    const previous = this.messageBatches.find(sourceKey, parentDedupeKey);
    if (previous && previous.batch_payload_hash !== batchPayloadHash) throw new CoreError("dedupe_conflict", "原去重键已经用于另一批收件人或消息");
    if (input.message_visibility !== undefined && !["hidden", "visible"].includes(input.message_visibility)) throw new CoreError("invalid_input", "Codex 显示方式无效");
    const recipients = targets.map(normalizeIdentity);
    const project = (results, duplicate) => {
      const receipt = projectBatchSendReceipt({ batchId, text: input.text, deduplicatedCount, results });
      const received = results.filter(entry => entry.delivery_status === "accepted").length;
      return { ...receipt, succeeded_count: received, pending_count: results.length - received - receipt.failed_count, duplicate };
    };
    const idsForSizing = "00000000-0000-0000-0000-000000000000";
    const bound = project(recipients.map(target => ({ target, message_id: idsForSizing, delivery_id: idsForSizing,
      delivery_status: "failed_before_send", processing: "processing", duplicate: true,
      error: { code: "failed_before_send", message: "详见原投递" } })), true);
    if (Buffer.byteLength(JSON.stringify(bound), "utf8") > 8704) throw new CoreError("invalid_input", "收件地址太长，无法返回逐人回执，请分两批发送");
    const prepared = targets.map((target, index) => {
      const identity = recipients[index];
      const { targetKey, subDedupeKey } = entries[index];
      const batchMeta = previous ? undefined : {
        batch_id: batchId,
        recipient_group: { batch_id: batchId, recipients },
        recipient_labels: renderPeerRecipientsForReceiver({ receiver: identity, allRecipients: recipients,
          resolveDisplayName: (receiver, peer) => this.resolveDisplayName(receiver, peer) }).recipient_labels,
        ...(reply ? { reply_to_batch_id: reply.replyToBatchId, reply_to_message_id: reply.replyToMessageId } : {}),
      };
      const childVisibility = projectVisibilityForRecipient(messageVisibility, target);
      const chosenTarget = previous ? identity : { ...identity, binding_id: target.binding_id, binding_generation: target.binding_generation };
      const child = this.#prepareOutgoing(context, { caller: principal.identity, target: chosenTarget, origin: input.origin,
        dedupe_key: subDedupeKey, text: input.text, attachment_refs: input.attachment_refs, delivery_policy: input.delivery_policy,
        reply_required: input.reply_required, expires_at: input.expires_at, in_reply_to: replyPlan.get(targetKey) ?? null,
        ...(childVisibility === undefined ? {} : { message_visibility: childVisibility }),
      }, batchMeta);
      if (child.envelope.origin.kind !== "agent_message") throw new CoreError("source_unverified", "群发入口只接受已获准的代理消息");
      const notice = batchMeta ? batchRecipientNotice({ batch_meta: batchMeta, envelope: child.envelope }) : null;
      if (notice && target.host === "codex") requireText(notice + "\n\n" + child.envelope.text, "群发到 Codex 的正文");
      return { targetKey, child };
    });
    const priorChildren = previous ? new Map(previous.members.map(member => [member.target_key, member.message_id])) : null;
    if (previous && prepared.some(({ targetKey, child }) => !child.existingId || priorChildren.get(targetKey) !== child.existingId)) {
      throw new CoreError("dedupe_conflict", "原群发登记没有对应全部子回执；保留原件，请核对原投递");
    }
    const committed = previous ?? (() => {
      const members = prepared.map(({ targetKey, child }) => {
        const record = child.persist(append);
        if (record.duplicate) throw new CoreError("dedupe_conflict", "子投递已属于其它消息，整批未提交");
        return { target_key: targetKey, message_id: record.message_id, delivery_id: record.delivery_id };
      });
      this.remoteRelay?.stageOutgoing(members, recipients);
      return this.messageBatches.insert({ batch_id: batchId, source_key: sourceKey, dedupe_key: parentDedupeKey,
        batch_payload_hash: batchPayloadHash, created_at: this.timestamp(), members }).record;
    })();
    const results = committed.members.map(member => {
      const { message, delivery } = this.result(member.message_id);
      const failure = ["failed_before_send", "expired", "unsupported", "failed"].includes(delivery.status);
      return { target: message.envelope.target, message_id: member.message_id, delivery_id: member.delivery_id,
        delivery_status: delivery.status, processing: message.processing, duplicate: Boolean(previous),
        ...(failure ? { error: { code: delivery.status, message: "详见原投递" } } : {}) };
    });
    return { receipt: project(results, Boolean(previous)), deliveries: previous ? [] : committed.members.map(member => member.delivery_id) };
  }

  async sendMessage(context, input) {
    if (input?.targets !== undefined) return this.#sendBatch(context, input);
    const { persist, viaContact } = this.#prepareOutgoing(context, input);
    const persisted = this.transaction(append => {
      const record = persist(append);
      if (!record.duplicate) this.remoteRelay?.stageOutgoing([record]);
      return record;
    });
    const snapshot = { ...this.result(persisted.message_id), duplicate: persisted.duplicate };
    if (!persisted.duplicate) this.enqueue(persisted.delivery_id).catch(error => { this.backgroundError = error; });
    return viaContact === undefined ? snapshot : { ...snapshot, resolved_target: { ...snapshot.message.envelope.target, via_contact: viaContact } };
  }

  async ingestRelayMessage(inbound) {
    if (!this.remoteRelay) throw new CoreError("unsupported_op", "本机未启用跨机投递");
    const rows = this.transaction(append => {
      const relay = this.remoteRelay.planInbound(inbound);
      return relay.recipients.map(item => {
        const { target, originMessageId } = item;
        const targetKey = identityKey(target);
        const principal = this.remoteRelay.inboundPrincipal(relay.source, target);
        const batchMeta = relay.recipientsVisible.length > 1 && relay.recipientsVisible.some(peer => identityKey(peer) === targetKey) ? {
          batch_id: relay.requestId,
          recipient_group: { batch_id: relay.requestId, recipients: relay.recipientsVisible },
          recipient_labels: renderPeerRecipientsForReceiver({ receiver: target, allRecipients: relay.recipientsVisible,
            resolveDisplayName: (receiver, peer) => this.resolveDisplayName(receiver, peer) }).recipient_labels,
        } : undefined;
        const dedupeKey = `relay-in:${digest({ origin: relay.relayId, request: relay.requestId, targetKey }).slice(0, 48)}`;
        const direct = this.#prepareOutgoing(null, {
          caller: relay.source, target, text: relay.body, origin: { kind: "agent_message", channel: "remote_relay", source_ref: relay.relayId },
          dedupe_key: dedupeKey, delivery_policy: relay.deliveryPolicy, expires_at: relay.expiresAt,
          ...(item.inReplyTo ? { in_reply_to: item.inReplyTo } : {}),
          ...(target.host === "codex" && item.visibility ? { message_visibility: item.visibility } : {}),
        }, batchMeta, { principal, sourceVerified: relay.sourceVerified });
        const notice = batchMeta ? batchRecipientNotice({ batch_meta: batchMeta, envelope: direct.envelope }) : null;
        if (notice && target.host === "codex") requireText(notice + "\n\n" + direct.envelope.text, "群发到 Codex 的正文");
        const record = direct.persist(append);
        const originalDelivery = this.store.getDeliveryForMessage(record.message_id);
        this.relayAcknowledgements.bindInbound({
          local_message_id: record.message_id, origin_relay_id: relay.relayId, origin_message_id: originMessageId,
          from_machine: relay.source.machine_id, reply_relay_key: relay.route.relay_key, reply_group_id: relay.route.group_id,
          reply_route_generation: relay.route.route_generation, target_key: targetKey,
        });
        return { ...record, delivery_id: originalDelivery.delivery_id, target_key: targetKey, origin_message_id: originMessageId };
      });
    });
    const tasks = rows.filter(row => !row.duplicate).map(row => this.enqueue(row.delivery_id));
    let timer;
    try {
      if (tasks.length) await Promise.race([Promise.allSettled(tasks), new Promise(resolve => { timer = setTimeout(resolve, 150); })]);
    } finally { clearTimeout(timer); }
    return { deliveries: rows.map(row => ({ local_message_id: row.message_id, target_key: row.target_key,
      origin_message_id: row.origin_message_id, delivery_status: this.store.getDelivery(row.delivery_id)?.status ?? "unknown" })) };
  }

  recordRelayedProcessing(messageId, { processing, sequence }) {
    const message = this.store.getMessage(messageId);
    if (!message?.relay_request_id || !["processing", "done", "failed"].includes(processing) ||
      !Number.isSafeInteger(sequence) || sequence <= (message.remote_processing_sequence ?? 0) ||
      (PROCESSING_TERMINALS.has(message.processing) && message.processing !== processing)) return false;
    return this.transaction(append => {
      const delivery = this.store.getDeliveryForMessage(messageId);
      if (!delivery || !["prepared", "dispatching", "unknown", "accepted"].includes(delivery.status)) return false;
      if (delivery.status !== "accepted") this.changeDelivery(delivery.delivery_id, "accepted",
        { outcome: "accepted", error: null, attempt_count: Math.max(1, delivery.attempt_count),
          evidence: { source: "remote_processing_receipt" } }, append);
      this.store.updateMessage(messageId, { processing, remote_processing_sequence: sequence,
        ...(message.model_observed === "unknown" ? { model_observed: "observed" } : {}) });
      if (message.processing !== processing) append(messageId, "processing", {
        processing, delivery_id: delivery.delivery_id, binding_generation: delivery.target_snapshot.binding_generation,
      });
      return true;
    });
  }

  async readChannelMessages(context, input) {
    const principal = this.principal(context, input.caller);
    const attributed = { ...input, caller: principal.identity };
    let result;
    try {
      result = await (this.channelHistoryFallback ?? this.channelContent).read(principal, attributed, { signal: context.signal });
    } catch (error) {
      if (!(error instanceof CoreError) || !/^channel_download_ledger_(?:io|changed|closed)$/.test(error.code)) throw error;
      this.channelDownloadsAvailable = false;
      this.channelHistoryFallback ??= this.createChannelHistoryFallback();
      result = await this.channelHistoryFallback.read(principal, attributed, { signal: context.signal });
    }
    if (!this.channelDownloadsAvailable) {
      result.download_service = { available: false, code: "channel_download_state_unavailable" };
      for (const message of result.messages) for (const attachment of message.attachments) {
        attachment.downloadable = false;
        attachment.download_unavailable = "channel_download_state_unavailable";
        delete attachment.attachment_ref;
        delete attachment.attachment_ref_expires_at;
      }
    }
    return result;
  }

  async downloadAttachment(context, input) {
    const principal = this.principal(context, input.caller);
    if (!this.channelDownloadsAvailable) throw new CoreError("channel_download_state_unavailable", "下载原操作记录未就绪，已保留原件并停止新下载", { request_sent: false });
    try {
      return await this.channelContent.download(principal, { ...input, caller: principal.identity }, { signal: context.signal });
    } catch (error) {
      if (error instanceof CoreError && /^channel_download_ledger_(?:io|changed|closed)$/.test(error.code)) {
        this.channelDownloadsAvailable = false;
        this.channelHistoryFallback ??= this.createChannelHistoryFallback();
      }
      throw error;
    }
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
      if (until === "reply" && waitMs > 0) this.codexReplies.waiters.add(notify);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (settled) return;
      timer = setTimeout(() => notify(true), waitMs);
      notify(false);
    });
  }

  ackProcessing(context, input) {
    assertExactKeys(input, ["caller", "message_id", "delivery_id", "binding_generation", "processing", "note"], "处理回执");
    const principal = this.principal(context, input.caller);
    const message = this.authorizedMessage(principal, input.message_id);
    if (identityKey(principal.identity) !== message.target_key) throw new CoreError("forbidden", "只有原接收对话可以确认处理状态");
    if (!["processing", "done", "failed"].includes(input.processing)) throw new CoreError("invalid_input", "处理回执状态无效");
    let note;
    if (input.note !== undefined) {
      if (typeof input.note !== "string" || Buffer.byteLength(input.note, "utf8") > 1200) {
        throw new CoreError("invalid_input", "note必须是非空且不超过280字符和1200字节的文本");
      }
      const trimmedNote = input.note.trim();
      if (!trimmedNote || [...trimmedNote].length > 280) {
        throw new CoreError("invalid_input", "note必须是非空且不超过280字符和1200字节的文本");
      }
      note = trimmedNote;
    }
    const delivery = this.store.getDeliveryForMessage(message.message_id);
    let deliveryId;
    if (input.delivery_id !== undefined) {
      deliveryId = requireText(input.delivery_id, "delivery_id", 256);
      if (!delivery || deliveryId !== delivery.delivery_id || delivery.message_id !== message.message_id) {
        throw new CoreError("delivery_mismatch", "处理回执没有对应原投递");
      }
    } else {
      if (!delivery || delivery.message_id !== message.message_id) {
        throw new CoreError("delivery_mismatch", "处理回执没有对应原投递");
      }
      deliveryId = delivery.delivery_id;
    }
    const expectedGeneration = delivery.target_snapshot?.binding_generation ?? message.envelope.target.binding_generation;
    let bindingGeneration;
    if (input.binding_generation !== undefined) {
      bindingGeneration = requireInteger(input.binding_generation, "binding_generation", 1);
      if (bindingGeneration !== expectedGeneration) {
        throw new CoreError("binding_changed", "处理回执没有对应原绑定代次");
      }
    } else {
      bindingGeneration = expectedGeneration;
    }
    const duplicate = this.transaction(append => {
      const current = this.store.getMessage(message.message_id);
      if (current.processing === input.processing) {
        if (input.processing === "processing" && note !== undefined && note !== current.processing_note) {
          const currentDelivery = this.store.getDelivery(deliveryId);
          if (!currentDelivery || !["accepted", "dispatching", "unknown"].includes(currentDelivery.status)) {
            throw new CoreError("invalid_state", "该投递尚无接收依据");
          }
          if (currentDelivery.status !== "accepted") {
            this.changeDelivery(deliveryId, "accepted", { outcome: "accepted", error: null, evidence: { source: "processing_ack", binding_generation: bindingGeneration } }, append);
          }
          this.store.updateMessage(message.message_id, {
            processing_note: note,
            ...(this.autoCompleteOnReply && current.model_observed === "unknown" ? { model_observed: "observed" } : {}),
          });
          append(message.message_id, "processing", { processing: input.processing, delivery_id: deliveryId, binding_generation: bindingGeneration, note });
          return false;
        }
        return true;
      }
      if (PROCESSING_TERMINALS.has(current.processing)) throw new CoreError("processing_conflict", "原消息已经取得终态处理回执");
      const currentDelivery = this.store.getDelivery(deliveryId);
      if (!currentDelivery || !["accepted", "dispatching", "unknown"].includes(currentDelivery.status)) throw new CoreError("invalid_state", "该投递尚无接收依据");
      if (currentDelivery.status !== "accepted") {
        this.changeDelivery(deliveryId, "accepted", { outcome: "accepted", error: null, evidence: { source: "processing_ack", binding_generation: bindingGeneration } }, append);
      }
      this.store.updateMessage(message.message_id, {
        processing: input.processing,
        ...(note !== undefined ? { processing_note: note } : {}),
        ...(this.autoCompleteOnReply && current.model_observed === "unknown" ? { model_observed: "observed" } : {}),
      });
      append(message.message_id, "processing", {
        processing: input.processing,
        delivery_id: deliveryId,
        binding_generation: bindingGeneration,
        ...(note !== undefined ? { note } : {}),
      });
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
    const target = this.target(message.envelope.target.binding_id);
    if (message.relay_inbound && !this.remoteRelay) throw new CoreError("target_not_found", "跨机原授权入口尚未接回");
    const relayPrincipal = message.relay_inbound ? this.remoteRelay.inboundPrincipal(message.envelope.caller, target) : null;
    const principal = relayPrincipal ?? windowPrincipal ?? forwarded ?? this.principal({ principal_id: message.principal_id }, message.envelope.caller);
    if (ownerReply && !forwarded) {
      const rules = this.replyForwarding.filter(rule => rule.principal_id === principal.id);
      const sender = message.forward_of?.native_source?.event?.sender_id;
      if (rules.length !== 1 || !rules[0].owner_sender_allowlist.includes(sender)) {
        throw new CoreError("source_unverified", "原回信发送者已不在当前本人授权范围");
      }
    }
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
    if (Date.parse(message.envelope.expires_at) <= this.nowMs()) {
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
          && this.nowMs() < Date.parse(delivery.updated_at) + retryAfterMs) return;
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
      && retryAfterMs > 0 && retryAfterMs <= 45000 && this.nowMs() < Date.parse(delivery.updated_at) + retryAfterMs) return;
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
      const confirmedUnsentQuery = queried && current.status === "unknown" && ["codex", "windsurf"].includes(current.target_snapshot?.host)
        && outcome.evidence?.kind === "receipt" && outcome.evidence.operation === "query" && outcome.evidence.request_sent === false;
      const status = outcome.outcome === "busy" ? queried && !confirmedUnsentQuery ? "unknown" : "prepared" : outcome.outcome;
      if (queried && current.status === "unknown" && status === "unknown"
        && current.evidence?.outcome === outcome.outcome
        && (current.error?.code ?? null) === (outcome.error?.code ?? null)) {
        return;
      }
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

  async callReplyObserver(adapter, message, delivery, target, release) {
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
      release?.();
    });
    this.replyInvocations.add(invocation);
    try {
      return await Promise.race([invocation, interrupted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  replyCandidate(delivery) {
    if (!delivery || delivery.status !== "accepted") return null;
    const message = this.store.getMessage(delivery.message_id);
    if (!message || this.hasReply(message.message_id)) return null;
    let target;
    try {
      target = this.currentDispatchTarget(message, delivery);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      return null;
    }
    const adapter = lookupAdapter(this.adapters, target.adapter_id);
    return typeof adapter?.observeReply === "function" ? { delivery, message, target, adapter } : null;
  }

  waitingCodexReply(pass, prioritized) {
    if (!this.codexReplies.available(pass.waiting)) return null;
    let first = null;
    let next = null;
    for (const [messageId, listeners] of this.waiters.entries()) {
      if (!this.codexReplies.activelyWaiting(listeners)) continue;
      const delivery = this.store.getDeliveryForMessage(messageId);
      if (!delivery || prioritized.has(delivery.delivery_id) || this.codexReplies.reading.has(delivery.delivery_id)) continue;
      const candidate = this.replyCandidate(delivery);
      if (!candidate || candidate.target.host !== "codex" || !this.codexReplies.isOld(pass, candidate.message, delivery)) continue;
      if (!first || delivery.delivery_id < first.delivery.delivery_id) first = candidate;
      if ((this.codexReplies.waiting.cursor === null || delivery.delivery_id > this.codexReplies.waiting.cursor)
        && (!next || delivery.delivery_id < next.delivery.delivery_id)) next = candidate;
    }
    if (!next && first) this.codexReplies.waiting.cursor = null;
    return next ?? first;
  }

  pollReplies() {
    this.assertOpen();
    if (this.replyPollPromise) return this.replyPollPromise;
    const poll = Promise.resolve().then(async () => {
      let checked = 0;
      let replies = 0;
      const codexPass = this.codexReplies.begin();
      const prioritized = new Set();
      let scanned = true;
      for (const deliveries of this.deliveryPages(["accepted"], REPLY_PAGE_SIZE)) {
        if (this.closed || this.replyInvocations.size >= this.maxConcurrent) { scanned = false; break; }
        let nextIndex = 0;
        const worker = async () => {
          while (!this.closed && nextIndex < deliveries.length && this.replyInvocations.size < this.maxConcurrent) {
            const waiting = this.waitingCodexReply(codexPass, prioritized);
            let candidate = waiting;
            if (!candidate) {
              const deliveryId = deliveries[nextIndex++].delivery_id;
              if (prioritized.has(deliveryId)) continue;
              candidate = this.replyCandidate(this.store.getDelivery(deliveryId));
            }
            if (!candidate) continue;
            const { delivery, message, target, adapter } = candidate;
            if (waiting) prioritized.add(delivery.delivery_id);
            const release = target.host === "codex"
              ? this.codexReplies.reserve(codexPass, message, delivery, this.waiters.get(message.message_id))
              : undefined;
            if (release === null) continue;
            checked += 1;
            const reply = await this.callReplyObserver(adapter, message, delivery, target, release);
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
        if (nextIndex < deliveries.length) scanned = false;
      }
      this.codexReplies.finish(codexPass, scanned && !this.closed);
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
      await this.channelContent.close();
      if (this.channelHistoryFallback && this.channelHistoryFallback !== this.channelContent) await this.channelHistoryFallback.close();
      await Promise.allSettled([this.replyPollPromise, ...this.replyInvocations]);
      await this.drain();
      return { closed: true };
    })();
    return this.closePromise;
  }
}
