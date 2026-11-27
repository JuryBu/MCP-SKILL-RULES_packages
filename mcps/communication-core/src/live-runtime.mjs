import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { CoreError, assertExactKeys, digest, identityKey, normalizeIdentity, normalizeTarget, requireInteger, requireText } from "./contracts.mjs";
import { CommunicationCore } from "./core.mjs";
import { MessageStore } from "./store.mjs";
import { createChannelDownloadLedger } from "./channel-download-ledger.mjs";
import { createMcpHttpServer } from "./mcp-server.mjs";
import { AntigravityDeliveryAdapter } from "./adapters/antigravity.mjs";
import { AntigravityLsTransport } from "./transports/antigravity-ls.mjs";
import { CodexDeliveryAdapter } from "./adapters/codex.mjs";
import { CodexProxyTransport } from "./transports/codex-proxy.mjs";
import { loadCodexSourceRecovery, loadCodexStatusSource } from "./codex-source-recovery.mjs";
import { NapcatMcpTransport } from "./transports/napcat-mcp.mjs";
import { NapcatOwnerAdapter } from "./adapters/napcat-owner.mjs";
import { acquireRuntimeLease } from "./runtime-lease.mjs";
import { normalizeReplyForwardingRules } from "./reply-forwarding.mjs";
import { normalizeHostScope } from "./conversation-directory.mjs";
import { HostConversationContent, normalizeHostContentGrants } from "./host-conversation-content.mjs";
import { createCodexConversationContent } from "./codex-conversation-content.mjs";
import { createAntigravityConversationContent } from "./antigravity-conversation-content.mjs";
import { createAntigravitySummaryIndex } from "./antigravity-summary-index.mjs";
import { WindsurfAcpDeliveryAdapter } from "./adapters/windsurf-acp.mjs";
import { WindsurfAcpTransport } from "./transports/windsurf-acp-transport.mjs";
import { createWindsurfConversationContent } from "./windsurf-conversation-content.mjs";
import { HostStatusProvider, createAntigravityStatusReader, createCodexStatusReader } from "./host-status.mjs";
import { createWindsurfDesktopStatusReader } from "./windsurf-desktop-status.mjs";
import { WindowIngressController } from "./window-ingress.mjs";
import { CORE_RELAY_ADAPTER, attachCoreRelay, prepareCoreRelay } from "./core-relay-bridge.mjs";
import { isLocalBoardCaller, restrictBoardRelayDispatcher } from "./board-entry-contract.mjs";

const MAX_ENTRIES = 256;
const IDENTITY_FIELDS = ["machine_id", "host", "surface", "conversation_id"];
const ADAPTER_KINDS = new Set(["antigravity", "codex_proxy", "napcat_owner", "windsurf_acp"]);
const ADAPTER_HOSTS = { antigravity: "antigravity", codex_proxy: "codex", napcat_owner: "qq", windsurf_acp: "windsurf" };

function invalidConfiguration() {
  return new CoreError("invalid_config", "真实测试配置无效，请核对显式目标、授权与接入列表");
}

function boundedList(value, maximum = MAX_ENTRIES, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw invalidConfiguration();
  return value;
}

function uniqueTextList(value, name, maximum = MAX_ENTRIES, minimum = 1, maxBytes = 256) {
  const values = boundedList(value, maximum, minimum).map(entry => requireText(entry, name, maxBytes));
  if (new Set(values).size !== values.length) throw invalidConfiguration();
  return values;
}

function ownerReplyConfiguration(value) {
  if (value === undefined) return undefined;
  assertExactKeys(value, ["enabled", "target_key", "route_generation", "owner_sender_allowlist"], "QQ回信配置");
  if (typeof value.enabled !== "boolean") throw invalidConfiguration();
  if (!value.enabled) {
    if (Object.keys(value).length !== 1) throw invalidConfiguration();
    return { enabled: false };
  }
  const owners = uniqueTextList(Array.from(boundedList(value.owner_sender_allowlist, 32)), "owner_sender", 32, 1, 20);
  if (owners.some(sender => !/^[1-9]\d{0,19}$/.test(sender))) throw invalidConfiguration();
  return {
    enabled: true,
    targetKey: requireText(value.target_key, "reply_target_key", 256),
    routeGeneration: requireInteger(value.route_generation, "reply_route_generation", 1),
    ownerSenderAllowlist: owners,
  };
}

function ownerWindowSourcesFor(windows, targets, adapters) {
  const keys = new Set();
  return windows.filter(window => window.channel === "qq").map(window => {
    const target = targets.find(candidate => candidate.binding_id === window.binding_id);
    const adapter = adapters.find(candidate => candidate.id === target?.adapter_id);
    if (target?.host !== "qq" || target.surface !== window.window_type || adapter?.kind !== "napcat_owner"
      || !adapter.reply_events?.enabled || adapter.reply_events.targetKey !== target.conversation_id) throw invalidConfiguration();
    requireText(target.conversation_id, "window_target_key", 64);
    const windowKey = `window:${digest([window.channel, window.component, window.window_type, window.window_id])}`;
    const routeKey = `communication-core-window:${digest([windowKey, target.binding_id, adapter.conversation_id])}`;
    if (keys.has(windowKey) || routeKey === adapter.route_key) throw invalidConfiguration();
    keys.add(windowKey);
    return {
      window_key: windowKey, channel: window.channel, component: window.component, window_type: window.window_type,
      window_id: window.window_id, channel_binding_id: target.binding_id, target_key: target.conversation_id,
      route_key: routeKey, conversation_id: adapter.conversation_id, source_target: normalizeTarget(target),
      owner_sender_allowlist: [...adapter.reply_events.ownerSenderAllowlist],
    };
  });
}

function windowCaptureStatus(controller, windowKey, enabled) {
  const state = controller.getStatus(windowKey);
  const pendingOperation = state.pending_registration ? "register" : state.pending_close ? "close" : null;
  return {
    consumer_enabled: enabled, status: !enabled && state.status === "pending" && !pendingOperation ? "blocked" : state.status,
    native_status: state.status === "closed" ? "closed" : state.status === "ready" ? "open" : "unconfirmed",
    provider_generation: state.provider_generation,
    confirmed_mapping_generation: state.confirmed_mapping_generation,
    pending_operation: pendingOperation,
    blocked_retry_count: state.blocked_retry_count, last_blocked_retry_at: state.last_blocked_retry_at,
    gap: state.gap ? { code: state.gap.code, detected_at: state.gap.detected_at } : null,
    last_error: state.last_error,
  };
}

function windowTransportFor(transport) {
  const methods = ["registerOwnerWindowRoute", "getOwnerWindowRoute", "closeOwnerWindowRoute", "readOwnerWindowEvents"];
  if (methods.every(method => typeof transport?.[method] === "function")) return transport;
  return Object.fromEntries(methods.map(method => [method, (...args) => {
    if (typeof transport?.[method] === "function") return transport[method](...args);
    throw new CoreError("OWNER_WINDOW_UNSUPPORTED", "当前窗口提供方尚无此接口", { request_sent: false });
  }]));
}

function connectWindowManagement(core, controller, sources, enabled, isClosing, report) {
  const manage = core.manageChannelBinding.bind(core);
  const keys = new Set(sources.map(source => source.window_key));
  core.manageChannelBinding = async (context, input) => {
    if (isClosing()) throw new CoreError("service_closing", "当前服务正在退出");
    const result = await manage(context, input);
    if (!result || typeof result !== "object") return result;
    let failed = false;
    if (["bind", "remove"].includes(input.action) && keys.has(result.window_key)) {
      try { await controller.synchronize(result.window_key); } catch {
        failed = true;
        report("窗口对应关系已保存，原生捕获同步尚未确认\n");
      }
    }
    const decorate = binding => {
      if (!keys.has(binding.window_key)) return binding;
      let capture;
      try { capture = windowCaptureStatus(controller, binding.window_key, enabled); } catch {
        capture = { consumer_enabled: enabled, status: "blocked", native_status: "unconfirmed", last_error: "window_ingress_state_unavailable" };
      }
      if (failed) capture = { ...capture, status: capture.pending_operation ? "pending" : "blocked", native_status: "unconfirmed", last_error: "window_ingress_synchronize_unconfirmed" };
      return { ...binding, capture };
    };
    return input.action === "list" ? { ...result, bindings: result.bindings.map(decorate) } : decorate(result);
  };
}

async function readConfiguration(configPath) {
  try {
    const information = await stat(configPath);
    if (!information.isFile() || information.size > 1048576) throw invalidConfiguration();
    const text = await readFile(configPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 1048576) throw invalidConfiguration();
    const configuration = JSON.parse(text.replace(/^\uFEFF/, ""));
    assertExactKeys(configuration, ["adapter_mode", "host", "port", "principals", "targets", "adapters", "allowed_conversation_ids", "delivery_timeout_ms", "reply_forwarding", "conversation_routes", "channel_windows", "window_ingress_enabled", "status_hosts", "address_book_file", "local_machine_id", "multi_recipient_enabled"], "真实测试配置");
    if (configuration.adapter_mode !== "live_test") throw invalidConfiguration();
    let addressBook;
    if (configuration.address_book_file !== undefined) {
      const path = requireText(configuration.address_book_file, "address_book_file", 32768);
      if (!isAbsolute(path)) throw invalidConfiguration();
      const information = await stat(path);
      if (!information.isFile() || information.size > 1048576) throw invalidConfiguration();
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text, "utf8") > 1048576) throw invalidConfiguration();
      const saved = JSON.parse(text.replace(/^\uFEFF/, ""));
      assertExactKeys(saved, ["schema_version", "machine_id", "entries", "machine_routes"], "本机共有通讯录配置");
      if (saved.schema_version !== 1) throw invalidConfiguration();
      addressBook = {
        machineId: requireText(saved.machine_id, "machine_id", 128),
        sharedContacts: boundedList(saved.entries, 512, 0),
        machineRoutes: boundedList(saved.machine_routes ?? [], 128, 0),
      };
    }
    const host = configuration.host === undefined ? "127.0.0.1" : configuration.host;
    if (!["127.0.0.1", "localhost"].includes(host)) throw invalidConfiguration();
    const port = requireInteger(configuration.port === undefined ? 0 : configuration.port, "port", 0, 65535);
    const deliveryTimeoutMs = requireInteger(configuration.delivery_timeout_ms === undefined ? 15000 : configuration.delivery_timeout_ms, "delivery_timeout_ms", 1000, 30000);
    const windowIngressEnabled = configuration.window_ingress_enabled === undefined ? false : configuration.window_ingress_enabled;
    if (typeof windowIngressEnabled !== "boolean") throw invalidConfiguration();
    const allowedConversationIds = new Set(uniqueTextList(configuration.allowed_conversation_ids, "allowed_conversation_id"));
    const adapterIds = new Set();
    const adapters = boundedList(configuration.adapters).map(entry => {
      const allowed = entry.kind === "codex_proxy" ? ["id", "kind", "connection_file"]
        : entry.kind === "napcat_owner" ? ["id", "kind", "base_url", "route_key", "conversation_id", "reply_hint", "reply_events"]
        : entry.kind === "windsurf_acp" ? ["id", "kind", "max_active_clients", "idle_ttl_ms"]
        : ["id", "kind", "conversation_index_file"];
      assertExactKeys(entry, allowed, "接入模块");
      const id = requireText(entry.id, "adapter.id", 128);
      if (adapterIds.has(id) || !ADAPTER_KINDS.has(entry.kind)) throw invalidConfiguration();
      adapterIds.add(id);
      if (entry.kind === "codex_proxy") {
        const connectionFile = requireText(entry.connection_file, "connection_file", 32768);
        if (!isAbsolute(connectionFile)) throw invalidConfiguration();
        return { id, kind: entry.kind, connection_file: connectionFile };
      }
      if (entry.kind === "windsurf_acp") {
        const maxActive = entry.max_active_clients === undefined ? 8 : requireInteger(entry.max_active_clients, "max_active_clients", 1, 16);
        const idleTtl = entry.idle_ttl_ms === undefined ? 180000 : requireInteger(entry.idle_ttl_ms, "idle_ttl_ms", 15000, 3600000);
        return { id, kind: entry.kind, max_active_clients: maxActive, idle_ttl_ms: idleTtl };
      }
      if (entry.kind === "napcat_owner") return {
        id, kind: entry.kind,
        base_url: requireText(entry.base_url, "base_url", 2048),
        route_key: requireText(entry.route_key, "route_key", 256),
        conversation_id: requireText(entry.conversation_id, "conversation_id", 256),
        ...(entry.reply_hint === undefined ? {} : { reply_hint: requireText(entry.reply_hint, "reply_hint", 512) }),
        ...(entry.reply_events === undefined ? {} : { reply_events: ownerReplyConfiguration(entry.reply_events) }),
      };
      if (entry.conversation_index_file === undefined) return { id, kind: entry.kind };
      const indexFile = requireText(entry.conversation_index_file, "conversation_index_file", 32768);
      if (!isAbsolute(indexFile) || basename(indexFile) !== "conversation_summaries.db") throw invalidConfiguration();
      return { id, kind: entry.kind, conversation_index_file: indexFile };
    });
    const bindingIds = new Set();
    const targetIdentities = new Set();
    const targets = boundedList(configuration.targets).map(entry => {
      assertExactKeys(entry, [...IDENTITY_FIELDS, "binding_id", "binding_generation", "adapter_id", "capabilities", "evidence"], "真实测试目标");
      if (entry.capabilities !== undefined) {
        assertExactKeys(entry.capabilities, ["next_model_boundary", "when_idle"], "目标能力");
        if (Object.values(entry.capabilities).some(value => typeof value !== "boolean")) throw invalidConfiguration();
      }
      const target = normalizeTarget(entry);
      const adapterKind = adapters.find(adapter => adapter.id === target.adapter_id)?.kind;
      if (target.host !== ADAPTER_HOSTS[adapterKind]) throw invalidConfiguration();
      const identity = identityKey(target);
      if (!allowedConversationIds.has(target.conversation_id) || !adapterIds.has(target.adapter_id) || bindingIds.has(target.binding_id) || targetIdentities.has(identity)) throw invalidConfiguration();
      bindingIds.add(target.binding_id);
      targetIdentities.add(identity);
      return target;
    });
    for (const adapter of adapters) {
      if (adapter.reply_events?.enabled && (!targets.some(target => target.adapter_id === adapter.id)
        || targets.some(target => target.adapter_id === adapter.id && target.conversation_id !== adapter.reply_events.targetKey))) throw invalidConfiguration();
    }
    const principalIds = new Set();
    const tokens = new Set();
    const principals = boundedList(configuration.principals).map(entry => {
      assertExactKeys(entry, ["id", "token", "identity", "allowed_targets", "origin_kinds", "channel_component", "caller_scope", "allowed_target_scopes", "allowed_channel_reads", "allowed_channel_downloads", "allowed_host_lists", "allowed_host_snapshots", "address_book_identity_bound"], "连接授权");
      assertExactKeys(entry.identity, IDENTITY_FIELDS, "来源对话身份");
      const id = requireText(entry.id, "principal.id", 128);
      const token = requireText(entry.token, "principal.token", 4096);
      if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || principalIds.has(id) || tokens.has(token)) throw invalidConfiguration();
      principalIds.add(id);
      tokens.add(token);
      const allowedTargets = uniqueTextList(entry.allowed_targets, "allowed_target", MAX_ENTRIES, 0, 128);
      if (allowedTargets.some(bindingId => !bindingIds.has(bindingId))) throw invalidConfiguration();
      const channelReads = entry.allowed_channel_reads === undefined ? undefined
        : uniqueTextList(entry.allowed_channel_reads, "allowed_channel_read", MAX_ENTRIES, 0, 128);
      const channelDownloads = entry.allowed_channel_downloads === undefined ? undefined
        : uniqueTextList(entry.allowed_channel_downloads, "allowed_channel_download", MAX_ENTRIES, 0, 128);
      if ([...(channelReads ?? []), ...(channelDownloads ?? [])].some(bindingId => !targets.some(target => target.binding_id === bindingId && target.host === "qq"))) {
        throw invalidConfiguration();
      }
      const identity = normalizeIdentity(entry.identity);
      const callerScope = entry.caller_scope === undefined ? undefined : normalizeHostScope(entry.caller_scope);
      if (callerScope && (identity.conversation_id !== "*" || Object.entries(callerScope).some(([field, value]) => identity[field] !== value))) throw invalidConfiguration();
      if (!callerScope && identity.conversation_id === "*") throw invalidConfiguration();
      if (entry.address_book_identity_bound !== undefined && typeof entry.address_book_identity_bound !== "boolean") throw invalidConfiguration();
      if (entry.address_book_identity_bound === true && (callerScope || addressBook?.machineId !== identity.machine_id)) throw invalidConfiguration();
      const targetScopes = entry.allowed_target_scopes === undefined ? undefined : boundedList(entry.allowed_target_scopes, 32, 0).map(normalizeHostScope);
      if (targetScopes && new Set(targetScopes.map(scope => JSON.stringify(scope))).size !== targetScopes.length) throw invalidConfiguration();
      const originKinds = uniqueTextList(entry.origin_kinds ?? ["agent_message"], "origin_kind", 32, 1, 64);
      if (callerScope && originKinds.some(kind => kind !== "agent_message")) throw invalidConfiguration();
      const hostLists = entry.allowed_host_lists === undefined ? undefined : normalizeHostContentGrants(entry.allowed_host_lists, false);
      const hostSnapshots = entry.allowed_host_snapshots === undefined ? undefined : normalizeHostContentGrants(entry.allowed_host_snapshots, true);
      return {
        id,
        token,
        identity,
        allowed_targets: allowedTargets,
        ...(channelReads === undefined ? {} : { allowed_channel_reads: channelReads }),
        ...(channelDownloads === undefined ? {} : { allowed_channel_downloads: channelDownloads }),
        ...(hostLists === undefined ? {} : { allowed_host_lists: hostLists }),
        ...(hostSnapshots === undefined ? {} : { allowed_host_snapshots: hostSnapshots }),
        ...(callerScope ? { caller_scope: callerScope } : {}),
        ...(targetScopes ? { allowed_target_scopes: targetScopes } : {}),
        ...(entry.address_book_identity_bound === true ? { address_book_identity_bound: true } : {}),
        origin_kinds: originKinds,
        ...(entry.channel_component === undefined ? {} : { channel_component: requireText(entry.channel_component, "channel_component", 64) }),
      };
    });
    const replyForwarding = boundedList(configuration.reply_forwarding ?? [], 32, 0).map(rule => {
      assertExactKeys(rule, ["id", "source_principal_id", "from_binding_id", "to_binding_id", "ttl_ms", "adopt_reply_events"], "回信转交规则");
      const target = targets.find(entry => entry.binding_id === rule.from_binding_id);
      const adapter = target && adapters.find(entry => entry.id === target.adapter_id);
      if (target?.host !== "qq" || !adapter?.reply_events?.enabled) throw invalidConfiguration();
      return { ...rule, owner_sender_allowlist: [...adapter.reply_events.ownerSenderAllowlist] };
    });
    normalizeReplyForwardingRules({ rules: replyForwarding, targets, principals });
    const conversationRoutes = boundedList(configuration.conversation_routes ?? [], 32, 0).map(entry => {
      assertExactKeys(entry, ["machine_id", "host", "surface", "adapter_id", "capabilities"], "宿主投递接线");
      const scope = normalizeHostScope({ machine_id: entry.machine_id, host: entry.host, surface: entry.surface });
      const adapterId = requireText(entry.adapter_id, "adapter_id", 128);
      const adapter = adapters.find(candidate => candidate.id === adapterId);
      if (!adapter || ADAPTER_HOSTS[adapter.kind] !== scope.host || scope.host === "qq") throw invalidConfiguration();
      assertExactKeys(entry.capabilities, ["next_model_boundary", "when_idle"], "宿主投递能力");
      if (Object.values(entry.capabilities).some(value => typeof value !== "boolean")) throw invalidConfiguration();
      return { ...scope, adapter_id: adapterId, capabilities: { ...entry.capabilities } };
    });
    if (new Set(conversationRoutes.map(({ machine_id, host: routeHost, surface }) => JSON.stringify([machine_id, routeHost, surface]))).size !== conversationRoutes.length) throw invalidConfiguration();
    const automaticReplyForwarding = adapters.filter(adapter => adapter.reply_events?.enabled).flatMap(adapter => targets.filter(target => target.adapter_id === adapter.id)
      .map(target => ({ binding_id: target.binding_id, owner_sender_allowlist: [...adapter.reply_events.ownerSenderAllowlist], ttl_ms: 86400000 })));
    const channelWindows = boundedList(configuration.channel_windows ?? [], 256, 0).map(entry => {
      assertExactKeys(entry, ["channel", "component", "window_type", "window_id", "binding_id"], "聊天窗口");
      const bindingId = requireText(entry.binding_id, "binding_id", 128);
      const target = targets.find(candidate => candidate.binding_id === bindingId);
      if (!target || !["qq", "wechat"].includes(entry.channel) || target.host !== entry.channel || !["private", "group"].includes(entry.window_type)
        || target.surface !== entry.window_type) throw invalidConfiguration();
      const windowId = requireText(entry.window_id, "window_id", 256);
      if (entry.channel === "qq" && !/^[1-9]\d{0,19}$/.test(windowId)) throw invalidConfiguration();
      return { channel: entry.channel, component: requireText(entry.component, "component", 64), window_type: entry.window_type, window_id: windowId, binding_id: bindingId };
    });
    const ownerWindowSources = ownerWindowSourcesFor(channelWindows, targets, adapters);
    const statusHosts = uniqueTextList(configuration.status_hosts ?? [], "status_host", 1, 0, 64);
    if (statusHosts.some(entry => entry !== "windsurf")) throw invalidConfiguration();
    const declaredMachineId = configuration.local_machine_id === undefined ? undefined : requireText(configuration.local_machine_id, "local_machine_id", 128);
    if (declaredMachineId === "*" || declaredMachineId?.includes("\0")
      || (declaredMachineId !== undefined && addressBook && declaredMachineId !== addressBook.machineId)) throw invalidConfiguration();
    const knownMachines = new Set([...targets.map(target => target.machine_id), ...principals.map(principal => principal.identity.machine_id)]);
    const localMachineId = declaredMachineId ?? addressBook?.machineId ?? (knownMachines.size === 1 ? knownMachines.values().next().value : null);
    const multiRecipient = configuration.multi_recipient_enabled ?? false;
    if (typeof multiRecipient !== "boolean" || (multiRecipient && localMachineId === null)) throw invalidConfiguration();
    return { host, port, deliveryTimeoutMs, targets, principals, adapters, replyForwarding, conversationRoutes, automaticReplyForwarding,
      channelWindows, windowIngressEnabled, ownerWindowSources, statusHosts, addressBook, localMachineId, multiRecipient };
  } catch {
    throw invalidConfiguration();
  }
}

function prepareBoardRuntimeOptions(value, configuration, directory, relayConfiguration) {
  if (value === undefined) return null;
  assertExactKeys(value, ["enabled", "open", "principalIds", "superAdminIdentities", "allowedUploadRoots", "peerMachineIds", "fileBundlePeers",
    "notifyLocalMember", "syncIntervalMs", "notifyIntervalMs"], "私有交流板配置");
  if (value.enabled === false) return null;
  if (value.enabled !== true || (value.open !== undefined && typeof value.open !== "function") ||
    (value.notifyLocalMember !== undefined && typeof value.notifyLocalMember !== "function") || !configuration.addressBook) throw invalidConfiguration();
  const principalIds = uniqueTextList(value.principalIds, "交流板连接授权", MAX_ENTRIES, 1, 128);
  if (principalIds.some(id => !configuration.principals.some(principal => principal.id === id &&
    isLocalBoardCaller(principal, configuration.localMachineId)))) throw invalidConfiguration();
  const superAdminIdentities = boundedList(value.superAdminIdentities ?? [], MAX_ENTRIES, 0).map(identity => {
    assertExactKeys(identity, IDENTITY_FIELDS, "交流板管理员");
    if (IDENTITY_FIELDS.some(field => typeof identity[field] !== "string" || identity[field] === "*" ||
      identity[field] !== identity[field].trim() || /[\u0000-\u001f\u007f]/u.test(identity[field]))) throw invalidConfiguration();
    return Object.freeze(normalizeIdentity(identity));
  });
  if (new Set(superAdminIdentities.map(identityKey)).size !== superAdminIdentities.length) throw invalidConfiguration();
  const allowedUploadRoots = uniqueTextList(value.allowedUploadRoots ?? [], "交流板上传根", 32, 0, 32768).map(path => {
    if (!isAbsolute(path) || path !== path.trim() || /[\u0000-\u001f\u007f]/u.test(path)) throw invalidConfiguration();
    return resolve(path);
  });
  const pathKey = path => process.platform === "win32" ? path.toLowerCase() : path;
  if (new Set(allowedUploadRoots.map(pathKey)).size !== allowedUploadRoots.length) throw invalidConfiguration();
  const peers = relayConfiguration?.peers ?? new Map();
  const peerMachines = uniqueTextList(value.peerMachineIds ?? [], "交流板同步机器", 16, 0, 128);
  const fileBundlePeers = new Set(uniqueTextList(value.fileBundlePeers ?? [], "交流板附件同步机器", 16, 0, 128));
  if (peerMachines.some(id => !peers.has(id)) || [...fileBundlePeers].some(id => !peerMachines.includes(id))) throw invalidConfiguration();
  const peerCapabilities = new Map(peerMachines.map(id => [id, Object.freeze({
    known: true,
    allow_file_bundle: fileBundlePeers.has(id) && relayConfiguration?.transport.bundleEnabled !== false &&
      typeof relayConfiguration?.transport.sendBundle === "function",
  })]));
  const syncIntervalMs = value.syncIntervalMs === undefined ? undefined : requireInteger(value.syncIntervalMs, "交流板同步间隔", 10, 3_600_000);
  const notifyIntervalMs = value.notifyIntervalMs === undefined ? (peerMachines.length > 0 && !value.notifyLocalMember ? 0 : undefined) :
    requireInteger(value.notifyIntervalMs, "交流板提醒间隔", 0, 3_600_000);
  if (notifyIntervalMs > 0 && notifyIntervalMs < 10) throw invalidConfiguration();
  return { open: value.open, principalIds, privateRoot: directory, boardRoot: join(directory, "boards"),
    superAdminIdentities: Object.freeze(superAdminIdentities), allowedUploadRoots: Object.freeze(allowedUploadRoots),
    peerMachines: Object.freeze(peerMachines), peerCapabilitiesProvider: id => peerCapabilities.get(id) ?? null,
    notifyLocalMember: value.notifyLocalMember, syncIntervalMs, notifyIntervalMs };
}

export async function startLiveFromConfig({ configPath, stateDir, endpointFile, onError = () => {}, factories = {}, recoverTerminated = false, relay, boards }) {
  let configuration;
  let relayConfiguration;
  let boardConfiguration;
  let directory;
  try {
    requireText(configPath, "configPath", 32768);
    directory = resolve(requireText(stateDir, "stateDir", 32768));
    if (typeof onError !== "function" || typeof recoverTerminated !== "boolean") throw invalidConfiguration();
    assertExactKeys(factories, [...ADAPTER_KINDS], "接入工厂");
    if (Object.values(factories).some(factory => typeof factory !== "function")) throw invalidConfiguration();
    configuration = await readConfiguration(configPath);
    relayConfiguration = prepareCoreRelay(relay, configuration.localMachineId);
    boardConfiguration = prepareBoardRuntimeOptions(boards, configuration, directory, relayConfiguration);
    if (relayConfiguration && (configuration.adapters.some(entry => entry.id === CORE_RELAY_ADAPTER) ||
      relayConfiguration.routes.some(route => configuration.conversationRoutes.some(existing =>
        ["machine_id", "host", "surface"].every(field => existing[field] === route[field]))))) throw invalidConfiguration();
  } catch {
    throw invalidConfiguration();
  }
  const lease = await acquireRuntimeLease({ configPath, stateDir: directory, endpointFile, recoverTerminated });
  const adapters = new Map();
  const ownedAdapters = new Set();
  const externalAdapters = new Set();
  const transports = new Set();
  const windowTransports = new Map();
  const localMachineId = configuration.localMachineId;
  const machineProviders = new Map();
  const statusProvider = new HostStatusProvider({ localMachineId, machineProviders });
  const hostContentProviders = Object.create(null);
  if (configuration.statusHosts.includes("windsurf")) statusProvider.providers.set("windsurf", createWindsurfDesktopStatusReader());
  let store;
  let downloadLedger;
  let core;
  let http;
  let relayBridge;
  let boardRuntime;
  let detachBoard;
  let windowIngress;
  let windowIngressNeedsSync = false;
  let timer;
  let closing = false;
  let closePromise;
  let scheduledWork = Promise.resolve();
  let nextPollAt = Date.now() + 1000;
  const report = message => { try { onError(message); } catch {} };
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(timer);
    const boardDrain = detachBoard?.();
    closePromise = Promise.resolve().then(async () => {
      let failed = false;
      try { await windowIngress?.close(); } catch { failed = true; }
      if (boardRuntime || boardDrain) {
        const boardCleanup = await Promise.allSettled([
          Promise.resolve().then(() => typeof boardRuntime?.close === "function" ? boardRuntime.close() : undefined),
          boardDrain,
        ]);
        if (boardCleanup.some(result => result.status === "rejected")) failed = true;
      }
      try { await relayBridge?.close(); } catch { failed = true; }
      const stopped = await Promise.allSettled([Promise.resolve().then(() => statusProvider.close()), Promise.resolve().then(() => core?.close()), Promise.resolve().then(() => http?.close())]);
      if (stopped.some(result => result.status === "rejected")) failed = true;
      for (const cleanup of [() => scheduledWork, ...[...ownedAdapters].map(adapter => () => adapter.close?.()), ...[...transports].map(transport => () => transport.close()), () => downloadLedger?.close(), () => store?.close()]) {
        try { await cleanup(); } catch { failed = true; }
      }
      if (failed) throw new CoreError("shutdown_failed", "真实测试服务退出清理失败");
      await lease.release();
    });
    return closePromise;
  };
  const schedule = () => {
    if (closing) return;
    timer = setTimeout(() => {
      if (closing) return;
      scheduledWork = Promise.resolve().then(async () => {
        await core.dispatchPending();
        if (!closing && Date.now() >= nextPollAt) {
          nextPollAt = Date.now() + 1000;
          await core.pollReplies();
          if (!closing && windowIngress) {
            if (windowIngressNeedsSync) {
              windowIngressNeedsSync = false;
              await windowIngress.start();
            }
            if (!closing) await windowIngress.poll();
          }
        }
      }).catch(() => {
        if (closing) return;
        report("真实测试投递或回信调度异常，正在关闭服务\n");
        void close().catch(() => report("真实测试服务退出清理失败\n"));
      }).finally(schedule);
    }, 250);
    timer.unref();
  };
  try {
    for (const entry of configuration.adapters) {
      let created;
      let windowTransport;
      if (Object.hasOwn(factories, entry.kind)) created = await factories[entry.kind]({ ...entry });
      else if (entry.kind === "antigravity") {
        const transport = new AntigravityLsTransport();
        transports.add(transport);
        created = new AntigravityDeliveryAdapter({ transport });
        statusProvider.providers.set("antigravity", createAntigravityStatusReader(transport, { configured_delivery_modes: { next_model_boundary: true, when_idle: true } }));
        const summaryIndex = entry.conversation_index_file ? createAntigravitySummaryIndex({ filePath: entry.conversation_index_file }) : undefined;
        if (summaryIndex) transports.add(summaryIndex);
        hostContentProviders.antigravity = createAntigravityConversationContent(transport, { summaryIndex, getMessageForDelivery: id => {
          const delivery = store?.getDelivery(id);
          return delivery ? store.getMessage(delivery.message_id) : null;
        } });
      } else if (entry.kind === "codex_proxy") {
        const information = await stat(entry.connection_file);
        if (!information.isFile() || information.size > 65536) throw invalidConfiguration();
        const connection = JSON.parse((await readFile(entry.connection_file, "utf8")).replace(/^\uFEFF/, ""));
        assertExactKeys(connection, ["base_url", "token", "relay", "source_recovery", "status_source", "content_read_token"], "Codex控制连接");
        const sourceRecovery = Object.hasOwn(connection, "source_recovery") ? await loadCodexSourceRecovery(connection.source_recovery) : undefined;
        const transport = new CodexProxyTransport({ baseUrl: connection.base_url, token: connection.token, contentReadToken: connection.content_read_token, sourceRecovery, ...(connection.relay === undefined ? {} : { relay: connection.relay }) });
        transports.add(transport);
        created = new CodexDeliveryAdapter({ transport });
        const codexStatus = connection.status_source === undefined ? undefined : await loadCodexStatusSource(connection.status_source);
        if (codexStatus) statusProvider.providers.set("codex", createCodexStatusReader({
          ...codexStatus, configured_delivery_modes: { next_model_boundary: true, when_idle: true },
        }));
        if (connection.content_read_token !== undefined) {
          hostContentProviders.codex = createCodexConversationContent(transport, { inspectThread: codexStatus?.inspectThread });
        }
      } else if (entry.kind === "windsurf_acp") {
        const priorWindsurfReader = statusProvider.providers.get("windsurf");
        if (priorWindsurfReader) await priorWindsurfReader.close?.().catch(() => {});
        const transport = new WindsurfAcpTransport({ maxActiveClients: entry.max_active_clients, idleTtlMs: entry.idle_ttl_ms });
        transports.add(transport);
        created = new WindsurfAcpDeliveryAdapter({
          clientForTarget: (target, ctx) => transport.clientForTarget(target, ctx),
          verifyPersistedDelivery: (target, ctx) => transport.verifyPersistedDelivery(target, ctx),
        });
        statusProvider.providers.set("windsurf", createWindsurfDesktopStatusReader({
          configured_delivery_modes: { next_model_boundary: true, when_idle: true },
          transportProbe: (target, ctx) => transport.probeStatus(target, ctx),
          timeoutMs: 8000,
          databaseTimeoutMs: 2000,
          maxRecordBytes: 524288,
          processCacheTtlMs: 5000,
          serializeDatabase: true,
        }));
        hostContentProviders.windsurf = createWindsurfConversationContent({
          transport,
          getMessageForDelivery: id => {
            const delivery = store?.getDelivery(id);
            return delivery ? store.getMessage(delivery.message_id) : null;
          },
        });
      } else {
        const transport = new NapcatMcpTransport({ baseUrl: entry.base_url, conversationId: entry.conversation_id });
        transports.add(transport);
        windowTransport = transport;
        created = new NapcatOwnerAdapter({ transport, routeKey: entry.route_key, replyHint: entry.reply_hint, conversationId: entry.conversation_id,
          ...(entry.reply_events === undefined ? {} : { replyEvents: { ...entry.reply_events, callerConversationId: entry.conversation_id } }),
        });
      }
      const wrapped = created && Object.hasOwn(created, "adapter");
      const adapter = wrapped ? created.adapter : created;
      if (wrapped && created.statusReader) statusProvider.providers.set(ADAPTER_HOSTS[entry.kind], created.statusReader);
      if (wrapped && created.contentProvider) hostContentProviders[ADAPTER_HOSTS[entry.kind]] = created.contentProvider;
      if (entry.kind === "napcat_owner") windowTransports.set(entry.id,
        windowTransport ?? (wrapped ? created.windowTransport : undefined) ?? adapter?.windowTransport ?? adapter?.transport);
      if (wrapped && created.owned === false) {
        externalAdapters.add(adapter);
        ownedAdapters.delete(adapter);
      } else if (adapter && !externalAdapters.has(adapter)) ownedAdapters.add(adapter);
      if (!adapter || typeof adapter.deliver !== "function" || typeof adapter.query !== "function" || (adapter.close !== undefined && typeof adapter.close !== "function")) throw invalidConfiguration();
      adapters.set(entry.id, adapter);
    }
    let channelDownloadFailure = false;
    if (configuration.principals.some(principal => principal.allowed_channel_reads?.length || principal.allowed_channel_downloads?.length)) {
      try { downloadLedger = await createChannelDownloadLedger({ stateDir: join(directory, "channel-downloads") }); }
      catch {
        channelDownloadFailure = true;
        report("附件原操作记录未就绪，已停止新下载；普通消息、历史读取与状态继续可用\n");
      }
    }
    core = new CommunicationCore({ targets: configuration.targets, principals: configuration.principals, adapters, replyForwarding: configuration.replyForwarding,
      conversationRoutes: [...configuration.conversationRoutes, ...(relayConfiguration?.routes ?? [])], automaticReplyForwarding: configuration.automaticReplyForwarding,
      channelWindows: configuration.channelWindows,
      ownerWindowSources: configuration.ownerWindowSources, downloadLedger, channelDownloadFailure, autoCompleteOnReply: true,
      statusProvider, hostContentProvider: new HostConversationContent({ providers: hostContentProviders, localMachineId, machineProviders }),
      deliveryTimeoutMs: configuration.deliveryTimeoutMs });
    if (typeof core.pollReplies !== "function") throw new CoreError("startup_failed", "真实测试核心依赖尚未就绪");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    store = new MessageStore({ filePath: join(directory, "core.sqlite") });
    core.store = store;
    if (configuration.addressBook) core.attachAddressBook(configuration.addressBook);
    if (configuration.multiRecipient) core.attachMessageBatches({ machineId: localMachineId });
    if (relayConfiguration) {
      relayBridge = attachCoreRelay(core, relayConfiguration, machineProviders);
      adapters.set(CORE_RELAY_ADAPTER, relayBridge.adapter);
    }
    await core.start();
    if (configuration.ownerWindowSources.length) {
      if (typeof core.ingestOwnerWindowEvent !== "function") throw new CoreError("startup_failed", "窗口事件接纳依赖尚未就绪");
      windowIngress = new WindowIngressController({
        windows: configuration.ownerWindowSources.map(source => ({ ...source, transport: windowTransportFor(windowTransports.get(source.source_target.adapter_id)) })),
        getBinding: windowKey => configuration.windowIngressEnabled ? store.getChannelBinding(windowKey) : null,
        getState: windowKey => store.getChannelIngressState(windowKey),
        putState: (windowKey, state) => store.putChannelIngressState(windowKey, state),
        onEvent: (event, window) => core.ingestOwnerWindowEvent(event, { window_key: window.window_key, native_route: window.native_route }),
        onError: () => report("窗口原生捕获尚未完成，已保留原操作和游标\n"),
      });
      connectWindowManagement(core, windowIngress, configuration.ownerWindowSources, configuration.windowIngressEnabled, () => closing, report);
      windowIngressNeedsSync = true;
    }
    if (boardConfiguration) {
      const { open, principalIds, privateRoot, boardRoot, allowedUploadRoots, superAdminIdentities,
        peerMachines, peerCapabilitiesProvider, notifyLocalMember, syncIntervalMs, notifyIntervalMs } = boardConfiguration;
      const openBoards = open ?? (await import("./board-sync.mjs")).openBoardRuntime;
      boardRuntime = await openBoards({
        localMachineId, privateRoot, boardRoot, superAdminIdentities, allowedUploadRoots,
        openStore: create => store.openBoardStore(create, { privateRoot, allowedUploadRoots, now: () => core.nowMs() }),
        addressBookAdapter: Object.freeze({
          saveBoardForIdentity: (member, board) => core.addressBook.saveBoardForIdentity(member, board),
          listBoardsForIdentity: member => core.addressBook.listBoardsForIdentity(member),
          resolve: (principal, alias) => core.addressBook.resolve(principal, alias),
          resolveDisplayName: (receiver, peer) => core.resolveDisplayName(receiver, peer),
        }),
        relayDispatcher: restrictBoardRelayDispatcher(relayBridge?.dispatcher, peerMachines, peerCapabilitiesProvider),
        peerMachines, peerCapabilitiesProvider,
        notifyLocalMember, syncIntervalMs, notifyIntervalMs, now: () => core.nowMs(),
        onError: error => report(error instanceof CoreError ? error.code : "board_runtime_error"),
      });
      if (typeof boardRuntime?.invoke !== "function" || typeof boardRuntime.close !== "function" ||
        (boardRuntime.start !== undefined && typeof boardRuntime.start !== "function")) throw invalidConfiguration();
      await boardRuntime.start?.();
      detachBoard = core.attachBoardEntry({ invoke: invocation => boardRuntime.invoke(invocation), principalIds });
    }
    http = await createMcpHttpServer({ core, principals: configuration.principals, host: configuration.host, port: configuration.port });
    await lease.setUrl(http.url);
    relayBridge?.start();
    schedule();
    return { url: http.url, address: http.address, close, core, ...(windowIngress ? { windowIngress } : {}),
      ...(relayBridge ? { relayDispatcher: relayBridge.dispatcher } : {}) };
  } catch {
    await close().catch(() => {});
    throw new CoreError("startup_failed", "真实测试服务启动失败，请核对配置、状态目录和本机依赖");
  }
}
