import { randomUUID } from "node:crypto";
import { CoreError, assertExactKeys, digest, identityKey, normalizeIdentity, requireInteger, requireText } from "./contracts.mjs";
import { normalizeHostScope } from "./conversation-directory.mjs";
import * as relayEnvelope from "./relay-envelope.mjs";
import { RemoteCoreDispatcher, createRemoteMachineProviders } from "./remote-core-dispatcher.mjs";

export const CORE_RELAY_ADAPTER = "core-remote-relay";
const HOSTS = new Set(["antigravity", "codex", "windsurf"]);
const MODEL_MODES = Object.freeze({ next_model_boundary: true, when_idle: true });
const REPLY_SCOPE = ["machine_id", "host", "surface", "conversation_id"];

function invalid(message) { return new CoreError("invalid_config", message); }
function forbidden() { return new CoreError("forbidden", "这条跨机路线或对话未获授权"); }
function routeIdentity(value) { return [value.relay_key, String(value.group_id), value.route_generation].join("\0"); }
function scopedHost(value) { return [value.machine_id, value.host, value.surface].join("\0"); }
function readArray(items, convert, max = 64) {
  if (!Array.isArray(items) || items.length > max) throw invalid("跨机授权清单无效");
  return items.map(convert);
}
function modelIdentity(value) {
  assertExactKeys(value, REPLY_SCOPE, "跨机对话地址");
  const identity = normalizeIdentity(value);
  if (!HOSTS.has(identity.host) || identity.conversation_id === "*") throw forbidden();
  relayEnvelope.formatEndpoint(identity);
  return identity;
}
function targetScope(value, machineId) {
  assertExactKeys(value, ["host", "surface"], "跨机宿主范围");
  if (!HOSTS.has(value.host)) throw invalid("仅能接入本阶段支持的跨机宿主");
  return normalizeHostScope({ ...value, machine_id: machineId });
}
function configuredRoute(value) {
  return { relay_key: requireText(value.relay_key, "中继路线", 256), group_id: requireText(value.group_id, "中继群", 256),
    route_generation: requireInteger(value.route_generation, "中继路线代次", 1) };
}

export function prepareCoreRelay(value, localMachineId) {
  if (value === undefined) return null;
  assertExactKeys(value, ["transport", "peers", "autoPoll", "onError", "limits"], "跨机接线");
  const machineId = requireText(localMachineId, "本机标识", 128);
  if (!value.transport || typeof value.transport.sendFrame !== "function" || typeof value.transport.poll !== "function" ||
    typeof value.transport.readEvents !== "function") throw invalid("缺少独立跨机传输入口");
  if (value.autoPoll !== undefined && typeof value.autoPoll !== "boolean") throw invalid("跨机轮询配置无效");
  const peers = new Map();
  const scopes = [];
  for (const item of readArray(value.peers, item => item, 16)) {
    assertExactKeys(item, ["machine_id", "sender_account", "channel", "relay_key", "group_id", "route_generation", "draining_routes", "outbound_scopes", "inbound_targets",
      "status_targets", "status_hosts", "directory_scopes", "snapshot_permissions", "allow_recipient_lists", "trust_source_identity"], "跨机对端");
    const id = requireText(item.machine_id, "对端机器", 128);
    if (id === machineId || id === "*" || id.includes("\0") || peers.has(id)) throw invalid("跨机对端身份重复或无效");
    const localIdentity = input => {
      const target = modelIdentity(input);
      if (target.machine_id !== machineId) throw invalid("对端读取或投递授权必须落在本机");
      return target;
    };
    const outbound = readArray(item.outbound_scopes ?? [], scope => targetScope(scope, id));
    const activeRoute = configuredRoute(item);
    const draining = readArray(item.draining_routes ?? [], value => {
      assertExactKeys(value, ["relay_key", "group_id", "route_generation"], "原群回执路线");
      return configuredRoute(value);
    }, 8);
    const readableRoutes = new Set([activeRoute, ...draining].map(routeIdentity));
    if (readableRoutes.size !== draining.length + 1) throw invalid("中继原群与现用路线重复");
    const snapshots = new Set();
    for (const pair of readArray(item.snapshot_permissions ?? [], pair => pair)) {
      assertExactKeys(pair, ["caller", "target"], "跨机近期内容授权");
      const caller = modelIdentity(pair.caller);
      const target = localIdentity(pair.target);
      const permission = `${identityKey(caller)}\0${identityKey(target)}`;
      if (caller.machine_id !== id || item.trust_source_identity !== true || snapshots.has(permission)) {
        throw invalid("跨机快照必须明确绑定可信、互不重复的发端与目标对话");
      }
      snapshots.add(permission);
    }
    const incoming = {
      machine_id: id,
      senderAccount: requireText(item.sender_account, "已登记的中继发送账号", 128),
      channel: item.channel === undefined ? undefined : requireText(item.channel, "中继路线名", 128),
      route: activeRoute,
      readableRoutes,
      outbound,
      inbound: new Set(readArray(item.inbound_targets ?? [], localIdentity).map(identityKey)),
      status: new Set(readArray(item.status_targets ?? [], localIdentity).map(identityKey)),
      statusHosts: new Set(readArray(item.status_hosts ?? [], scope => targetScope(scope, machineId)).map(scopedHost)),
      directory: readArray(item.directory_scopes ?? [], scope => targetScope(scope, machineId)),
      snapshots,
      fullList: item.allow_recipient_lists === true,
      sourceVerified: item.trust_source_identity === true,
    };
    peers.set(id, incoming);
    for (const scope of outbound) scopes.push({ ...scope, adapter_id: CORE_RELAY_ADAPTER, capabilities: MODEL_MODES });
  }
  if (!peers.size || new Set(scopes.map(scopedHost)).size !== scopes.length ||
    new Set([...peers.values()].map(peer => peer.senderAccount)).size !== peers.size) throw invalid("跨机投递范围或发送账号重复");
  return { machineId, peers, routes: scopes, transport: value.transport, autoPoll: value.autoPoll !== false, onError: value.onError, limits: value.limits };
}

export function attachCoreRelay(core, configuration, machineProviders) {
  const { machineId, peers, transport } = configuration;
  const journal = core.store.openRelayDispatches();
  journal.recoverInterrupted();
  let dispatcher;
  let closing;
  const acknowledgements = core.attachRelayAcknowledgements({ onReady: () => dispatcher?.triggerFlush() });
  acknowledgements.reconcileLegacyProcessing();

  function peerFor(machine, route, active = false) {
    const peer = peers.get(machine);
    if (!peer || (route && (active ? routeIdentity(route) !== routeIdentity(peer.route) : !peer.readableRoutes.has(routeIdentity(route))))) throw forbidden();
    return peer;
  }
  function verifiedEvent(machine, event) {
    if (event?.sender_verified === false || event?.source_machine !== machine) throw forbidden();
    const peer = peerFor(machine, event);
    if (String(event.sender_id ?? "") !== peer.senderAccount) throw forbidden();
    return peer;
  }
  async function sendDeliveryReceipt(call, receiver, input, options) {
    const key = `ack:${digest({ dedupe: input.dedupe_key, machine: input.target_machine,
      route: [input.reply_relay_key, input.reply_group_id, input.reply_route_generation] }).slice(0, 48)}`;
    const earlier = journal.read(key);
    if (!earlier) journal.stage({ request_id: key, input });
    const record = journal.claim(key);
    if (!record) {
      return earlier?.phase === "relayed" ? { status: "sent_verified", relay_id: earlier.relay_id }
        : { status: "unknown", outcome_unknown: true };
    }
    try {
      const receipt = await call.call(receiver, record.input, options);
      const known = receipt?.status === "sent_verified" && receipt.outcome_unknown !== true;
      journal.update(key, value => ({ ...value, phase: known ? "relayed" : "unknown",
        ...(typeof receipt?.relay_id === "string" ? { relay_id: receipt.relay_id } : {}) }));
      return receipt;
    } catch (error) {
      const mayRetry = error?.code === "relay_rate_limited" && error.details?.request_sent === false;
      journal.update(key, value => ({ ...value, phase: mayRetry ? "prepared" : "unknown" }));
      throw error;
    }
  }
  function pinReference(input) {
    const quote = input.in_reply_to ?? input.payload_json?.in_reply_to;
    if (input.op !== "message" || !quote) return input;
    const record = input.meta?.request_id && journal.read(input.meta.request_id);
    if (!record || record.reference?.relay_id !== quote || record.to_machine !== input.target_machine) throw forbidden();
    peerFor(record.to_machine, record.route, true);
    return { ...input, reply_relay_key: record.route.relay_key,
      reply_group_id: record.route.group_id, reply_route_generation: record.route.route_generation };
  }
  async function sendTransport(call, target, input, options) {
    const result = await call.call(target, pinReference(input), options);
    return result?.status === "unknown" ? { ...result, outcome_unknown: true } : result;
  }
  const guardedTransport = new Proxy(transport, {
    get(target, method) {
      const call = Reflect.get(target, method, target);
      if (typeof call !== "function") return call;
      if (method === "sendFrame") return (input, options) => input?.op === "delivery_ack"
        ? sendDeliveryReceipt(call, target, input, options) : sendTransport(call, target, input, options);
      if (method === "sendBundle") return (input, options) => sendTransport(call, target, input, options);
      if (method !== "readEvents" && method !== "readBundleEvents") return call.bind(target);
      return async (...args) => {
        const page = await call.apply(target, args);
        if (!Array.isArray(page?.events)) return page;
        const events = page.events.filter(event => {
          try { return Boolean(verifiedEvent(event.source_machine, event)); } catch { return false; }
        }).map(event => ({ ...event, sender_verified: true }));
        return { ...page, events };
      };
    },
  });
  function inboundPrincipal(source, target) {
    const peer = peerFor(source.machine_id);
    const address = normalizeIdentity(target);
    if (!peer.inbound.has(identityKey(address))) throw forbidden();
    return { id: `relay-peer:${digest(source).slice(0, 48)}`, identity: source, allowed_targets: target.binding_id ? [target.binding_id] : [],
      allowed_target_scopes: [{ machine_id: machineId, host: address.host, surface: address.surface }], origin_kinds: ["agent_message"] };
  }
  function planInbound(inbound) {
    const peer = verifiedEvent(inbound.from_machine, inbound.event);
    const source = modelIdentity({ machine_id: peer.machine_id, ...relayEnvelope.parseEndpoint(inbound.source) });
    if (inbound.staged_files.length) throw new CoreError("unsupported_op", "暂未启用跨机附件接管");
    const sourceVerified = peer.sourceVerified && inbound.source_identity_verified === true;
    const referencedMessage = inbound.meta.reply_origin_message_id;
    let reference = null;
    if (inbound.in_reply_to || referencedMessage !== undefined) {
      if (!sourceVerified || !inbound.in_reply_to || typeof referencedMessage !== "string") throw forbidden();
      const original = core.store.getMessage(requireText(referencedMessage, "原本机消息", 256));
      const grouped = original?.relay_request_id && journal.read(original.relay_request_id);
      if (!original || original.target_key !== identityKey(source) || grouped?.phase !== "relayed" ||
        grouped.to_machine !== source.machine_id ||
        !grouped.members?.some(member => member.message_id === original.message_id && member.target_key === original.target_key) ||
        grouped.relay_id !== inbound.in_reply_to || routeIdentity(grouped.route) !== routeIdentity(inbound.event)) throw forbidden();
      reference = { original: original.message_id, originalSender: original.source_key };
    }
    const requestId = requireText(inbound.meta.request_id, "原请求", 128);
    const relayId = requireText(inbound.frame.relay_id, "原中继回执", 256);
    const members = readArray(inbound.meta.origin_members, row => row, 16);
    const byEndpoint = new Map(members.map(item => {
      assertExactKeys(item, ["endpoint", "message_id", "visibility"], "跨机原收件记录");
      return [requireText(item.endpoint, "原收件地址", 512), item];
    }));
    if (members.length !== byEndpoint.size || byEndpoint.size !== inbound.recipients.length || inbound.recipients.length === 0 ||
      new Set(inbound.recipients).size !== inbound.recipients.length) throw forbidden();
    const recipients = inbound.recipients.map(endpoint => {
      const member = byEndpoint.get(endpoint);
      if (!member) throw forbidden();
      const address = modelIdentity({ machine_id: machineId, ...relayEnvelope.parseEndpoint(endpoint) });
      const target = core.resolveAddress(inboundPrincipal(source, address), address);
      return { target: { ...address, binding_id: target.binding_id, binding_generation: target.binding_generation },
        originMessageId: requireText(member.message_id, "原消息", 256), visibility: member.visibility,
        ...(reference?.originalSender === identityKey(address) ? { inReplyTo: reference.original } : {}) };
    });
    if (reference && !recipients.some(item => item.inReplyTo === reference.original)) throw forbidden();
    const expiresAt = requireText(inbound.meta.expires_at, "原消息有效期", 64);
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new CoreError("expired", "原跨机消息已过期");
    }
    const recipientsVisible = peer.fullList ? readArray(inbound.all_recipients, item => {
      const separator = item.indexOf("/");
      if (separator < 1) throw forbidden();
      return modelIdentity({ machine_id: item.slice(0, separator), ...relayEnvelope.parseEndpoint(item.slice(separator + 1)) });
    }, 16) : [];
    if (recipientsVisible.length > 1 && (new Set(recipientsVisible.map(identityKey)).size !== recipientsVisible.length ||
      recipients.some(({ target }) => !recipientsVisible.some(item => identityKey(item) === identityKey(target))))) throw forbidden();
    const inKey = `in:${digest({ source, requestId }).slice(0, 48)}`;
    const hash = digest({ source, members, recipientsVisible, body: inbound.body, deliveryPolicy: inbound.meta.delivery_policy, expiresAt,
      ...(reference ? { reference } : {}) });
    const initial = journal.read(inKey);
    if (initial && (initial.inbound_hash !== hash || initial.relay_id !== relayId)) throw new CoreError("dedupe_conflict", "跨机原请求内容或路线发生变化");
    if (!initial && Date.parse(expiresAt) <= core.nowMs()) throw new CoreError("expired", "原跨机消息已过期");
    if (!initial) journal.stage({ request_id: inKey, inbound_hash: hash, relay_id: relayId });
    return { source, recipients, recipientsVisible, requestId, relayId, route: configuredRoute({ ...inbound.event, group_id: String(inbound.event.group_id) }),
      expiresAt, body: inbound.body,
      deliveryPolicy: inbound.meta.delivery_policy, sourceVerified };
  }
  function stageOutgoing(members, allRecipients) {
    const grouped = new Map();
    for (const member of members) {
      const message = core.store.getMessage(member.message_id);
      const delivery = core.store.getDeliveryForMessage(member.message_id);
      if (delivery.target_snapshot.adapter_id !== CORE_RELAY_ADAPTER) continue;
      const envelope = message.envelope;
      const peer = peerFor(envelope.target.machine_id);
      if (envelope.caller.machine_id !== machineId || envelope.origin.kind !== "agent_message" ||
        envelope.origin_receipt_binding || envelope.attachment_refs.length) {
        throw new CoreError("unsupported_op", "跨机试验只接入代理正文；原渠道回执和附件保持原入口");
      }
      if ((allRecipients?.length ?? 1) > 1 && !peer.fullList) {
        throw new CoreError("relay_recipient_disclosure_blocked", "原中继路线未允许披露同批收件人");
      }
      const group = grouped.get(peer.machine_id) ?? { members: [], reference: null };
      if (envelope.in_reply_to) {
        const originalRoute = acknowledgements.inboundRoute(envelope.in_reply_to);
        if (!message.source_identity_verified || !originalRoute || originalRoute.from_machine !== peer.machine_id ||
          originalRoute.target_key !== identityKey(envelope.caller) || group.reference) throw forbidden();
        const original = { relay_key: originalRoute.reply_relay_key, group_id: originalRoute.reply_group_id,
          route_generation: originalRoute.reply_route_generation };
        if (routeIdentity(peer.route) !== routeIdentity(original)) {
          throw new CoreError("relay_route_changed", "原信仍按旧中继收确认；这次引用回复只支持当前仍在使用的原路线");
        }
        group.reference = { relay_id: originalRoute.origin_relay_id, message_id: originalRoute.origin_message_id };
      }
      group.members.push({ message_id: member.message_id, delivery_id: delivery.delivery_id, target_key: delivery.target_key,
        endpoint: relayEnvelope.formatEndpoint(envelope.target),
        ...(envelope.message_visibility ? { visibility: envelope.message_visibility } : {}) });
      grouped.set(peer.machine_id, group);
    }
    for (const [machine, { members: group, reference }] of grouped) {
      const peer = peerFor(machine);
      const requestId = `req_${randomUUID()}`;
      const recipients = allRecipients ?? group.map(member => normalizeIdentity(core.store.getMessage(member.message_id).envelope.target));
      journal.stage({ request_id: requestId, to_machine: machine, route: peer.route, members: group, all_recipients: recipients, remote: {},
        ...(reference ? { reference } : {}) });
      for (const member of group) core.store.updateMessage(member.message_id, { relay_request_id: requestId });
    }
  }
  const outcome = (delivery, accepted = false) => ({
    outcome: accepted ? "accepted" : "unknown", delivery_id: delivery.delivery_id, target_key: delivery.target_key, evidence: { kind: "receipt" },
  });
  function query({ message, delivery }) {
    const record = message.relay_request_id && journal.read(message.relay_request_id);
    return outcome(delivery, record?.remote?.[delivery.target_key]?.delivery_status === "accepted");
  }
  async function deliver(input) {
    const { message, delivery, signal } = input;
    if (!message.relay_request_id || signal?.aborted) return outcome(delivery);
    const record = journal.claim(message.relay_request_id);
    if (!record) return query(input);
    try {
      const peer = peerFor(record.to_machine, record.route, true);
      const receipt = await dispatcher.dispatchMessage({
        dedupeKey: record.request_id, targetMachine: record.to_machine, channel: peer.channel,
        source: message.envelope.caller, recipients: record.members.map(item => item.endpoint),
        allRecipients: record.all_recipients, body: message.envelope.text, sourceIdentityVerified: message.source_identity_verified === true,
        ...(record.reference ? { inReplyTo: record.reference.relay_id } : {}),
        allowDiscloseRecipients: record.all_recipients.length > 1,
        meta: { request_id: record.request_id, delivery_policy: message.envelope.delivery_policy, expires_at: message.envelope.expires_at,
          origin_members: record.members.map(({ endpoint, message_id, visibility }) => ({ endpoint, message_id, ...(visibility ? { visibility } : {}) })),
          ...(record.reference ? { reply_origin_message_id: record.reference.message_id } : {}) },
        signal,
      });
      const evidence = receipt.transport_result;
      const expected = evidence && routeIdentity(evidence) === routeIdentity(record.route) && receipt.relay_id;
      journal.update(record.request_id, current => ({
        ...current, phase: current.phase === "relayed" || (expected && receipt.stages?.relay_accepted?.ok === true &&
          receipt.stages?.relay_accepted?.outcome_unknown !== true) ? "relayed" : "unknown",
        ...(expected && (!current.relay_id || current.relay_id === receipt.relay_id) ? { relay_id: receipt.relay_id } : {}),
      }));
    } catch {
      journal.update(record.request_id, current => current.phase === "relayed" ? current : { ...current, phase: "unknown" });
    }
    return query(input);
  }
  function deliveryAck(input) {
    verifiedEvent(input.from_machine, input.event);
    const old = typeof input.request_id === "string" && journal.read(input.request_id);
    if (!old || old.to_machine !== input.from_machine || old.phase === "prepared" || routeIdentity(old.route) !== routeIdentity(input.event) ||
      (old.relay_id && old.relay_id !== input.origin_relay_id) || !input.origin_relay_id) return;
    if (!input.ok) {
      const code = ["forbidden", "unsupported_op", "invalid_input", "expired", "dedupe_conflict"].includes(input.error?.code)
        ? input.error.code : "remote_rejected";
      if (!Object.keys(old.remote).length) journal.update(old.request_id, current => ({
        ...current, phase: "relayed", relay_id: input.origin_relay_id, rejection: code,
      }));
      return;
    }
    const local = new Map(old.members.map(row => [row.target_key, row]));
    const statuses = Array.isArray(input.recipient_deliveries) ? input.recipient_deliveries : [];
    if (statuses.length !== local.size || new Set(statuses.map(row => row.target_key)).size !== local.size ||
      statuses.some(row => !local.has(row.target_key) || typeof row.local_message_id !== "string")) return;
    const remote = { ...old.remote };
    for (const row of statuses) {
      const previous = remote[row.target_key];
      if (previous && previous.local_message_id !== row.local_message_id) return;
      remote[row.target_key] = previous?.delivery_status === "accepted" ? previous : {
        local_message_id: requireText(row.local_message_id, "目标机原消息", 256),
        delivery_status: row.delivery_status === "accepted" ? "accepted" : "prepared",
      };
    }
    journal.update(old.request_id, current => ({ ...current, phase: "relayed", relay_id: input.origin_relay_id, remote }));
    for (const [targetKey, member] of local) {
      if (remote[targetKey].delivery_status === "accepted") {
        const delivery = core.store.getDelivery(member.delivery_id);
        if (delivery) core.applyOutcome(member.delivery_id, outcome(delivery, true), true);
      }
    }
  }
  function processingAck(input) {
    verifiedEvent(input.from_machine, input.event);
    if (!input.origin_message_id || !input.origin_relay_id || !input.local_message_id) return;
    const message = core.store.getMessage(input.origin_message_id);
    const group = message?.relay_request_id && journal.read(message.relay_request_id);
    const recipient = group?.members.find(member => member.message_id === input.origin_message_id && member.target_key === message.target_key);
    const priorLocalId = group?.remote?.[message?.target_key]?.local_message_id;
    if (!group || !recipient || group.phase === "prepared" || group.to_machine !== input.from_machine ||
      routeIdentity(group.route) !== routeIdentity(input.event) || input.frame?.source !== recipient.endpoint ||
      (group.relay_id && group.relay_id !== input.origin_relay_id) || (priorLocalId && priorLocalId !== input.local_message_id)) return;
    const localId = requireText(input.local_message_id, "目标机原消息", 256);
    core.store.transaction(() => {
      if (!core.recordRelayedProcessing(message.message_id, { processing: input.processing, sequence: input.ack_seq })) return;
      journal.update(group.request_id, current => ({ ...current, phase: "relayed", relay_id: input.origin_relay_id,
        remote: { ...current.remote, [message.target_key]: { local_message_id: localId, delivery_status: "accepted" } } }));
    });
  }
  function queryLocalStatus({ scope, target, remotePrincipal }) {
    const peer = peerFor(remotePrincipal.from_machine, remotePrincipal);
    const address = scope === "host" ? normalizeHostScope(target) : modelIdentity(target);
    if (address.machine_id !== machineId || (scope === "host" ? !peer.statusHosts.has(scopedHost(address)) : !peer.status.has(identityKey(address)))) {
      return core.statusProvider.snapshot(address, "remote_core_relay", "forbidden");
    }
    return core.statusProvider.getStatus(address);
  }
  async function queryLocalDirectory({ host, surface, limit, cursor, remotePrincipal }) {
    const peer = peerFor(remotePrincipal.from_machine, remotePrincipal);
    const request = normalizeHostScope({ machine_id: machineId, host, surface: surface ?? "desktop" });
    const principal = { id: `peer-list:${peer.machine_id}`, identity: { ...request, conversation_id: "relay-directory" }, allowed_host_lists: peer.directory };
    const page = await core.hostContentProvider.list(principal, { caller: principal.identity, ...request, scope: "host", limit, cursor });
    return { items: page.conversations, next_cursor: page.next_cursor, cursor_signed: true, partial: page.partial };
  }

  async function queryLocalSnapshot({ target, last_rounds, max_bytes, remotePrincipal, signal }) {
    const peer = peerFor(remotePrincipal.from_machine, remotePrincipal);
    if (!peer.sourceVerified || remotePrincipal.source_identity_verified !== true ||
      String(remotePrincipal.sender_id ?? "") !== peer.senderAccount || !remotePrincipal.source_endpoint) throw forbidden();
    const source = modelIdentity({ machine_id: peer.machine_id, ...relayEnvelope.parseEndpoint(remotePrincipal.source_endpoint) });
    const destination = modelIdentity(target);
    if (destination.machine_id !== machineId ||
      !peer.snapshots.has(`${identityKey(source)}\0${identityKey(destination)}`)) throw forbidden();
    const principal = { id: `peer-snapshot:${digest(source).slice(0, 48)}`, identity: source, allowed_host_snapshots: [destination] };
    return core.hostContentProvider.relaySnapshot(principal, { caller: source, target: destination, last_rounds }, {
      signal, ...(max_bytes === undefined ? {} : { maxBytes: max_bytes }),
    });
  }

  const policies = Object.fromEntries([...peers].map(([id, peer]) => [id, {
    allow_message: peer.inbound.size > 0, allow_status: peer.status.size > 0 || peer.statusHosts.size > 0,
    allow_directory: peer.directory.length > 0, allow_snapshot: peer.snapshots.size > 0,
    trust_source_identity: peer.sourceVerified,
    allow_file_bundle: true, group_visibility_policy: peer.fullList ? "full" : "none",
  }]));
  dispatcher = new RemoteCoreDispatcher({
    localMachineId: machineId, transport: guardedTransport, ackStore: acknowledgements, frameCodec: relayEnvelope, signDirectoryCursor: false,
    policy: { defaults: { allow_message: false, allow_status: false, allow_directory: false, allow_snapshot: false, allow_file_bundle: false }, peers: policies },
    limits: configuration.limits, onError: configuration.onError,
    localHandlers: { deliverInboundMessage: input => core.ingestRelayMessage(input), applyRemoteDeliveryAck: deliveryAck,
      applyRemoteProcessingAck: processingAck, queryLocalStatus, queryLocalDirectory, queryLocalSnapshot },
  });
  for (const peer of peers.values()) {
    const hosts = [...new Set(peer.outbound.map(scope => scope.host))];
    if (!hosts.length) continue;
    const installed = createRemoteMachineProviders(dispatcher, peer.machine_id, hosts,
      { channel: peer.channel, cursorGeneration: peer.route.route_generation });
    const providerMap = new Map();
    for (const [host, provider] of installed.get(peer.machine_id)) {
      providerMap.set(host, { ...provider, cursorGeneration: peer.route.route_generation,
        getRemoteStatus: (target, { signal }) => dispatcher.queryStatus({
        targetMachine: peer.machine_id, channel: peer.channel, target,
        scope: target.conversation_id === undefined ? "host" : "conversation", signal,
      }),
        async readRecent(target, { lastRounds = 3, signal, principal } = {}) {
          if (principal?.address_book_identity_bound !== true || principal.caller_scope != null ||
            principal.shared_facade_request === true ||
            principal.identity?.machine_id !== machineId || !principal.allowed_host_snapshots?.some(grant =>
              grant.all_conversations !== true && grant.conversation_id && identityKey(grant) === identityKey(target))) throw forbidden();
          const reply = await dispatcher.querySnapshot({
            targetMachine: peer.machine_id, channel: peer.channel, target, last_rounds: lastRounds,
            max_bytes: 6000, source: principal.identity, sourceIdentityVerified: true, signal,
          });
          const snapshot = reply?.snapshot;
          if (!snapshot || !Array.isArray(snapshot.rounds) ||
            REPLY_SCOPE.some(field => snapshot[field] !== target[field])) {
            throw new CoreError("host_content_unverified", "远端未返回同一趟具体对话的结构化近期内容");
          }
          return { ...snapshot, partial: snapshot.partial === true || reply.truncated === true || reply.omitted === true };
        } });
    }
    machineProviders.set(peer.machine_id, providerMap);
  }
  const bridge = { adapter: { deliver, query }, dispatcher, planInbound, inboundPrincipal, stageOutgoing,
    observation(message) {
      const record = message?.relay_request_id && journal.read(message.relay_request_id);
      if (!record) return undefined;
      const child = record.remote?.[message.target_key];
      return { relay_stage: record.phase === "relayed" ? "accepted" : record.phase === "prepared" ? "pending" : "unknown",
        target_core: child ? "accepted" : record.rejection ? "rejected" : "unknown",
        target_host: child?.delivery_status === "accepted" ? "accepted" : "unknown",
        ...(!child && record.rejection ? { code: record.rejection } : {}) };
    },
    start() { dispatcher.recoverInterruptedOutbox(); if (configuration.autoPoll) dispatcher.startPolling(); },
    close() {
      closing ??= (async () => {
        try { await dispatcher.close(); }
        finally { await transport.close?.(); }
      })();
      return closing;
    },
  };
  core.remoteRelay = bridge;
  return bridge;
}
