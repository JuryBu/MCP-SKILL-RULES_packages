import {
  RelayError,
  loadAndValidateRelayConfig,
  resolveRelayRoute,
  reverifyFrozenRelayRoute,
  isRelayRouteDrainExpired,
} from "./relay-groups.mjs";
import { computeRelayBodySha256 } from "./relay-frame.mjs";

const MAX_SCOPES_PER_SWEEP = 16;

function bodySha256(body) {
  return computeRelayBodySha256(body);
}

function defaultControlAddress(machineId) {
  if (typeof machineId !== "string" || !machineId.trim()) return null;
  return `system/napcat-file-bundle/${machineId.trim()}`;
}

/**
 * 为整块 B（src/file-bundle-integration.mjs / openFileBundleIntegration）提供的
 * 极窄共享桥接适配器：复用 A 的配置加载、冻结选路复核、实时核群、固定路线控制帧收发、只读对账与本机已核事件读取。
 */
export function createFileBundleRelayHost({
  notifier,
  relayService,
  relayGroupsPath,
  env = process.env,
  now = () => Date.now(),
  controlAddress = defaultControlAddress,
}) {
  if (!notifier || !notifier._relayTransport) {
    throw new RelayError("RELAY_TRANSPORT_UNAVAILABLE", "notifier 缺少受控 _relayTransport");
  }
  if (!relayService) {
    throw new RelayError("RELAY_SERVICE_UNAVAILABLE", "缺少 relayService 实例");
  }

  const nowProvider = typeof now === "function" ? now : () => now;
  const configOptions = {
    bindingPath: notifier.bindingPath,
    ...(relayGroupsPath ? { relayGroupsPath } : {}),
    env,
  };
  const transport = notifier._relayTransport;

  async function verifyLiveRoute(frozenRoute, purpose, options = {}) {
    options?.signal?.throwIfAborted?.();
    if (!frozenRoute || !frozenRoute.group_id || !frozenRoute.expected_self_id) {
      return false;
    }
    const transportOptions = options?.signal ? { signal: options.signal } : {};
    try {
      await transport.verifyAccountOnline(frozenRoute.expected_self_id, transportOptions);
      options?.signal?.throwIfAborted?.();
      await transport.verifyGroupIdentity({
        groupId: frozenRoute.group_id,
        expectedGroupName: frozenRoute.expected_group_name || "",
        expectedMemberCount: frozenRoute.expected_member_count ?? null,
        verifyMemberCount: frozenRoute.verify_member_count === true,
      }, transportOptions);
      return true;
    } catch {
      options?.signal?.throwIfAborted?.();
      return false;
    }
  }

  async function sendPinnedControl(frozenRoute, request, options = {}) {
    options?.signal?.throwIfAborted?.();
    const config = loadAndValidateRelayConfig(configOptions);
    let latestRoute;
    try {
      latestRoute = reverifyFrozenRelayRoute(config, frozenRoute, {
        allowDraining: options.requireFileBundleWrite !== true,
        requireFileBundleWrite: options.requireFileBundleWrite === true,
        now: nowProvider(),
      });
    } catch (error) {
      return { status: "not_sent", reason: error?.code || "route_reverify_failed" };
    }
    if (latestRoute.peer_machine_id && request.target_machine !== latestRoute.peer_machine_id) {
      return { status: "not_sent", reason: "RELAY_ROUTE_CHANGED" };
    }
    if (request.channel && request.channel !== latestRoute.channel) {
      return { status: "not_sent", reason: "RELAY_ROUTE_CHANGED" };
    }
    if (options.requireRecipientListDisclosure === true && latestRoute.allow_recipient_list_disclosure !== true) {
      return { status: "not_sent", reason: "RELAY_RECIPIENT_DISCLOSURE_BLOCKED" };
    }
    const folderPinned = Boolean(latestRoute.file_bundle_folder_id && latestRoute.file_bundle_folder_name);
    if (latestRoute.legacy_training_coexistence === true && !folderPinned) {
      return { status: "not_sent", reason: "RELAY_FILE_ROUTE_DENIED" };
    }
    if (
      options.requireFileBundleWrite === true
      && (latestRoute.role !== "active_write" || latestRoute.allow_file_bundle_write !== true)
    ) {
      return { status: "not_sent", reason: "RELAY_FILE_ROUTE_DENIED" };
    }

    try {
      const sent = await relayService.relaySend({
        dedupe_key: request.dedupe_key,
        target_machine: request.target_machine,
        channel: request.channel || latestRoute.channel || "qq",
        reply_relay_key: latestRoute.relay_key,
        reply_group_id: latestRoute.group_id,
        reply_route_generation: latestRoute.generation,
        op: request.op,
        source: request.source,
        recipients: request.recipients,
        body: request.body,
        ...(request.in_reply_to ? { in_reply_to: request.in_reply_to } : {}),
        ...(request.meta ? { meta: request.meta } : {}),
      }, options?.signal ? { signal: options.signal } : {});
      return {
        status: sent.status,
        transport_stage: sent.transport_stage,
        relay_key: sent.relay_key,
        route_generation: sent.route_generation,
        group_id: sent.group_id,
        body_sha256: sent.body_sha256 ?? null,
        onebot_message_id: sent.onebot_message_id ?? null,
        real_seq: sent.real_seq ?? null,
        outcome_unknown: Boolean(sent.outcome_unknown),
      };
    } catch (error) {
      options?.signal?.throwIfAborted?.();
      if (error?.outcomeUnknown === true) {
        return { status: "unknown" };
      }
      return { status: "not_sent", reason: error?.code || "send_failed" };
    }
  }

  async function inspectPinnedControl(frozenRoute, request, options = {}) {
    options?.signal?.throwIfAborted?.();
    if (typeof relayService.inspectSendRecord !== "function") {
      return { status: "unknown" };
    }
    let rec = relayService.inspectSendRecord(request.dedupe_key);
    if (!rec) return { status: "unknown" };
    const expectedBodySha = bodySha256(request.body);
    if (
      rec.relay_key !== frozenRoute.relay_key
      || rec.group_id !== frozenRoute.group_id
      || rec.route_generation !== frozenRoute.generation
    ) {
      return { status: "unknown" };
    }
    if (!rec.body_sha256 || rec.body_sha256 !== expectedBodySha) {
      return { status: "unknown" };
    }
    if (
      (rec.status === "pending_send" || rec.status === "sent_unverified" || rec.outcome_unknown === true)
      && typeof relayService.reconcileSendRecord === "function"
    ) {
      rec = (await relayService.reconcileSendRecord(request.dedupe_key, frozenRoute, {
        signal: options?.signal,
      })) ?? rec;
      options?.signal?.throwIfAborted?.();
      if (
        !rec
        || rec.relay_key !== frozenRoute.relay_key
        || rec.group_id !== frozenRoute.group_id
        || rec.route_generation !== frozenRoute.generation
        || !rec.body_sha256
        || rec.body_sha256 !== expectedBodySha
      ) {
        return { status: "unknown" };
      }
    }
    return {
      status: rec.status,
      transport_stage: rec.status === "sent_verified" ? "group_received" : "group_unverified",
      relay_key: rec.relay_key,
      route_generation: rec.route_generation,
      group_id: rec.group_id,
      body_sha256: rec.body_sha256,
      onebot_message_id: rec.onebot_message_id ?? null,
      real_seq: rec.real_seq ?? null,
      outcome_unknown: Boolean(rec.outcome_unknown),
    };
  }

  async function listScopes({ relayKeys, signal } = {}) {
    signal?.throwIfAborted?.();
    const config = loadAndValidateRelayConfig(configOptions);
    if (Array.isArray(config.global_conflicts) && config.global_conflicts.length > 0) {
      return [];
    }
    const currentNowMs = nowProvider();
    const scopes = [];
    const allowedSet = Array.isArray(relayKeys) ? new Set(relayKeys) : null;
    for (const [relayKey, relay] of Object.entries(config.relays)) {
      if (!relay.enabled) continue;
      if (relay.valid !== true) continue;
      const folderPinned = Boolean(relay.file_bundle_folder_id && relay.file_bundle_folder_name);
      if (relay.legacy_training_coexistence === true && !folderPinned) continue;
      if (isRelayRouteDrainExpired(relay, currentNowMs)) continue;
      if (allowedSet && !allowedSet.has(relayKey)) continue;
      scopes.push({
        relay_key: relayKey,
        group_id: relay.group_id,
        route_generation: relay.generation,
      });
      if (scopes.length >= MAX_SCOPES_PER_SWEEP) break;
    }
    return scopes;
  }

  async function readVerifiedPage({ relay_key, group_id, route_generation, cursor = null, limit = 12, signal } = {}) {
    signal?.throwIfAborted?.();
    const config = loadAndValidateRelayConfig(configOptions);
    if (Array.isArray(config.global_conflicts) && config.global_conflicts.length > 0) {
      throw new RelayError("RELAY_CONFIG_CONFLICT", "中继全局配置存在冲突，已拒绝读取文件控制帧");
    }
    const relay = Object.hasOwn(config.relays, relay_key) ? config.relays[relay_key] : null;
    const folderPinned = Boolean(relay?.file_bundle_folder_id && relay?.file_bundle_folder_name);
    if (
      !relay
      || !relay.enabled
      || relay.valid !== true
      || (relay.legacy_training_coexistence === true && !folderPinned)
      || isRelayRouteDrainExpired(relay, nowProvider())
      || relay.group_id !== group_id
      || relay.generation !== route_generation
    ) {
      throw new RelayError("RELAY_CURSOR_SCOPE_MISMATCH", "中继路由身份、代次或可用态已变化", {
        relay_key,
        group_id,
        route_generation,
      });
    }
    const page = await relayService.relayEventsRead({
      relay_key,
      cursor,
      limit,
    });
    const routeGap = Array.isArray(page.route_gaps)
      ? page.route_gaps.find((g) => g.relay_key === relay_key) || null
      : null;
    return {
      events: page.events,
      next_cursor: page.next_cursor,
      has_more: page.has_more,
      route_gap: routeGap,
    };
  }

  function callOneBot(action, params, options) {
    return transport.callOneBot(action, params, options);
  }

  return {
    configOptions,
    loadAndValidateRelayConfig,
    resolveRelayRoute: (config, opts) => resolveRelayRoute(config, { now: nowProvider(), ...opts }),
    reverifyFrozenRelayRoute: (config, route, opts) => reverifyFrozenRelayRoute(config, route, { now: nowProvider(), ...opts }),
    verifyLiveRoute,
    sendPinnedControl,
    inspectPinnedControl,
    listScopes,
    readVerifiedPage,
    callOneBot,
    controlAddress,
  };
}
