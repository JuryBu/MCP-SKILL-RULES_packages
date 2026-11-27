import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  RelayError,
  loadAndValidateRelayConfig,
  resolveRelayRoute,
  reverifyFrozenRelayRoute,
  isRelayRouteDrainExpired,
  findPeerMachineByQq,
  buildSanitizedRelayView,
} from "./relay-groups.mjs";
import {
  ALLOWED_RELAY_OPS,
  normalizeRelayAddress,
  normalizeFullRecipientRef,
  computeRelayBodySha256,
  encodeRelayFrame,
  decodeRelayFrame,
  validateRecipientDisclosure,
  computeRelaySendFingerprint,
} from "./relay-frame.mjs";
import { createRelayStateStore } from "./relay-state.mjs";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const BODY_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const NUMERIC_ID_PATTERN = /^[1-9]\d{0,19}$/;

const STATUS_ALLOWED_FIELDS = Object.freeze(["include_live_check"]);
const SEND_ALLOWED_FIELDS = Object.freeze([
  "dedupe_key",
  "target_machine",
  "channel",
  "reply_relay_key",
  "reply_group_id",
  "reply_route_generation",
  "op",
  "source",
  "recipients",
  "body",
  "in_reply_to",
  "meta",
  "allow_disclose_recipients",
]);
const POLL_ALLOWED_FIELDS = Object.freeze(["relay_keys", "max_pages"]);
const EVENTS_READ_ALLOWED_FIELDS = Object.freeze(["cursor", "limit", "relay_key", "resume_from_retained"]);

const DEFAULT_MAX_FRAME_CHARS = 1800;
const HARD_MAX_FRAME_CHARS = 1900;
const DEFAULT_MAX_RECIPIENTS = 16;
const DEFAULT_MAX_SENDS_PER_MINUTE = 20;
const DEFAULT_MAX_POLL_PAGES = 10;
const HARD_MAX_POLL_PAGES = 50;
const MAX_META_DEPTH = 8;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactObject(value, allowedFields, name) {
  if (!isPlainObject(value)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是普通对象`, { field: name });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key) || !allowedFields.includes(key)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 包含不被允许的字段：${String(key)}`, {
        field: name,
        key: String(key),
      });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 不能包含访问器属性：${key}`, {
        field: name,
        key,
      });
    }
  }
  return value;
}

function requireSafeString(value, name, maximum = 256) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > maximum
    || CONTROL_CHAR_PATTERN.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
  ) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 无效`, { field: name });
  }
  return value;
}

function optionalSafeString(value, name, maximum = 256) {
  if (value === undefined || value === null) return null;
  return requireSafeString(value, name, maximum);
}

function requireGroupId(value, name) {
  if (typeof value !== "string" || !NUMERIC_ID_PATTERN.test(value)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是有效数字群号字符串`, { field: name });
  }
  return value;
}

function requireAddress(value, name) {
  return normalizeRelayAddress(value, name);
}

function validateMetaValue(value, pathName, depth = 0) {
  if (depth > MAX_META_DEPTH) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${pathName} 嵌套深度超过上限`, { field: pathName });
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${pathName} 不能包含非有限数值`, { field: pathName });
    }
    return value;
  }
  if (typeof value === "string") {
    if (CONTROL_CHAR_PATTERN.test(value)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${pathName} 不能包含控制字符`, { field: pathName });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => validateMetaValue(item, `${pathName}[${index}]`, depth + 1));
  }
  if (isPlainObject(value)) {
    const clean = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !key || FORBIDDEN_KEYS.has(key) || CONTROL_CHAR_PATTERN.test(key)) {
        throw new RelayError("RELAY_INVALID_ARGUMENT", `${pathName} 包含非法键名`, { field: pathName });
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new RelayError("RELAY_INVALID_ARGUMENT", `${pathName}.${key} 不能是访问器属性`, { field: pathName });
      }
      if (descriptor.value === undefined) continue;
      clean[key] = validateMetaValue(descriptor.value, `${pathName}.${key}`, depth + 1);
    }
    return clean;
  }
  throw new RelayError("RELAY_INVALID_ARGUMENT", `${pathName} 包含不支持的 JSON 值类型`, { field: pathName });
}

function isAllowedOp(op) {
  if (typeof op !== "string") return false;
  if (ALLOWED_RELAY_OPS instanceof Set) return ALLOWED_RELAY_OPS.has(op);
  if (Array.isArray(ALLOWED_RELAY_OPS)) return ALLOWED_RELAY_OPS.includes(op);
  return false;
}

function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function decodeCqValue(value) {
  return String(value ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function numericRealSeq(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function extractOneBotText(message) {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  if (Array.isArray(message.message)) {
    const joined = message.message.map((segment) => {
      if (typeof segment === "string") return segment;
      if (segment?.type === "text") return String(segment?.data?.text ?? "");
      return "";
    }).join("");
    if (joined) return joined;
  }
  if (typeof message.raw_message === "string" && message.raw_message) {
    return decodeCqValue(message.raw_message);
  }
  if (typeof message.message === "string" && message.message) {
    return decodeCqValue(message.message);
  }
  return "";
}

function normalizeMessageTimeIso(rawTime) {
  if (rawTime === null || rawTime === undefined || rawTime === "") return null;
  if (typeof rawTime === "number" && Number.isFinite(rawTime) && rawTime > 0) {
    const ms = rawTime < 1e12 ? rawTime * 1000 : rawTime;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof rawTime === "string") {
    const parsed = Date.parse(rawTime);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    if (/^\d+$/.test(rawTime.trim())) {
      const numeric = Number(rawTime.trim());
      if (Number.isFinite(numeric) && numeric > 0) {
        const ms = numeric < 1e12 ? numeric * 1000 : numeric;
        return new Date(ms).toISOString();
      }
    }
  }
  return null;
}

function listConfigRelays(config) {
  const source = config?.relays ?? config?.routes ?? [];
  if (Array.isArray(source)) return source;
  if (isPlainObject(source)) {
    return Object.entries(source).map(([key, route]) => (
      route?.relay_key ? route : { relay_key: key, ...route }
    ));
  }
  return [];
}

function globalConflicts(config) {
  if (Array.isArray(config?.global_conflicts)) {
    return config.global_conflicts;
  }
  const conflicts = Array.isArray(config?.conflicts) ? config.conflicts : [];
  return conflicts.filter((conflict) => {
    if (!conflict || typeof conflict !== "object") return true;
    if (typeof conflict.scope === "string") return conflict.scope === "global";
    const conflictKey = conflict.relay_key ?? conflict.relayKey ?? null;
    const conflictGroupId = conflict.group_id ?? conflict.groupId ?? null;
    const conflictPeer = conflict.peer_machine_id ?? conflict.peerMachineId ?? null;
    return !conflictKey && !conflictGroupId && !conflictPeer;
  });
}

function relevantConflictsForRoute(config, route, { ignoreAmbiguous = false } = {}) {
  const globals = globalConflicts(config);
  const fullRoute = route?.relay_key && isPlainObject(config?.relays)
    ? config.relays[route.relay_key]
    : null;
  let routeLocal;
  if (Array.isArray(fullRoute?.conflicts)) {
    routeLocal = fullRoute.conflicts;
  } else {
    const conflicts = Array.isArray(config?.conflicts) ? config.conflicts : [];
    routeLocal = conflicts.filter((conflict) => {
      if (!conflict || typeof conflict !== "object") return false;
      if (conflict.scope === "global") return false;
      const conflictKey = conflict.relay_key ?? conflict.relayKey ?? null;
      const conflictGroupId = conflict.group_id ?? conflict.groupId ?? null;
      if (route && conflictKey && conflictKey === route.relay_key) return true;
      if (route && conflictGroupId && String(conflictGroupId) === String(route.group_id)) return true;
      return false;
    });
  }
  const filteredLocal = ignoreAmbiguous
    ? routeLocal.filter((conflict) => conflict?.code !== "RELAY_ROUTE_AMBIGUOUS")
    : routeLocal;
  return [...globals, ...filteredLocal];
}

function peerAllowedForRoute(config, route, senderMachine) {
  const peer = isPlainObject(config?.peers) && Object.hasOwn(config.peers, senderMachine)
    ? config.peers[senderMachine]
    : null;
  if (peer) {
    if (peer.enabled === false) return false;
    if (Array.isArray(peer.conflicts) && peer.conflicts.length > 0) return false;
    if (Array.isArray(peer.channels) && !peer.channels.includes(route.channel ?? "qq")) return false;
    if (Array.isArray(peer.allowed_relays) && !peer.allowed_relays.includes(route.relay_key)) return false;
  }
  if (Array.isArray(route.allowed_peers) && route.allowed_peers.length > 0) {
    return route.allowed_peers.includes(senderMachine);
  }
  if (Array.isArray(route.target_machines) && route.target_machines.length > 0) {
    return route.target_machines.includes(senderMachine);
  }
  if (typeof route.peer_machine_id === "string" && route.peer_machine_id) {
    return route.peer_machine_id === senderMachine;
  }
  return false;
}

function wrapTransportError(error, fallbackCode, fallbackMessage, options = {}) {
  if (error instanceof RelayError) return error;
  const code = typeof error?.code === "string" && error.code ? error.code : fallbackCode;
  const message = error?.message || fallbackMessage;
  const details = isPlainObject(error?.details) ? { ...error.details, ...(options.details ?? {}) } : (options.details ?? null);
  const outcomeUnknown = options.outcomeUnknown !== undefined
    ? Boolean(options.outcomeUnknown)
    : Boolean(error?.outcomeUnknown);
  return new RelayError(code, message, details, { outcomeUnknown, cause: error });
}

function computeRelayEventId(expectedSelfId, groupId, oneBotMessageId) {
  return createHash("sha256")
    .update(`relay-v1:${expectedSelfId}:${groupId}:${oneBotMessageId}`, "utf8")
    .digest("hex");
}

function extractBeforeCheckpoint(raw) {
  if (raw === null || raw === undefined) {
    return { beforeRealSeq: null, emptyHistory: true };
  }
  if (typeof raw === "number" || typeof raw === "string") {
    const parsed = numericRealSeq(raw);
    return { beforeRealSeq: parsed, emptyHistory: parsed === null };
  }
  if (isPlainObject(raw)) {
    const parsed = numericRealSeq(raw.maxRealSeq ?? raw.max_real_seq ?? raw.realSeq ?? raw.real_seq);
    const count = raw.messageCount ?? raw.message_count;
    const emptyHistory = typeof count === "number" ? count === 0 : parsed === null;
    return { beforeRealSeq: parsed, emptyHistory };
  }
  return { beforeRealSeq: null, emptyHistory: false };
}

function normalizeDecodedFrame(decoded) {
  if (!decoded || decoded.malformed) return null;
  const frame = isPlainObject(decoded.frame) ? decoded.frame : decoded;
  const fromMachine = frame.from_machine ?? frame.r_from ?? null;
  const toMachine = frame.to_machine ?? frame.r_to ?? null;
  const relayId = frame.relay_id ?? frame.r_id ?? null;
  const op = frame.op ?? frame.r_op ?? null;
  const source = frame.source ?? frame.r_src ?? null;
  const recipients = Array.isArray(frame.recipients)
    ? frame.recipients.slice()
    : (Array.isArray(frame.r_rcpt) ? frame.r_rcpt.slice() : []);
  const inReplyTo = frame.in_reply_to ?? frame.r_reply ?? null;
  const bodySha256 = frame.body_sha256 ?? null;
  const meta = frame.meta ?? frame.r_meta ?? null;
  const body = typeof frame.body === "string" ? frame.body : "";
  if (!relayId || !op || !fromMachine || !toMachine || !source) return null;
  return {
    relay_id: relayId,
    op,
    from_machine: fromMachine,
    to_machine: toMachine,
    source,
    recipients,
    in_reply_to: inReplyTo,
    body_sha256: bodySha256,
    meta,
    body,
  };
}

export function createNapCatRelayService({
  notifier,
  statePath,
  relayGroupsPath,
  env = process.env,
  now = () => new Date(),
  maxCacheBytes,
  maxEventsPerRoute,
  maxGlobalEvents,
  maxSendRecords,
} = {}) {
  if (!notifier || typeof notifier !== "object" || typeof notifier.bindingPath !== "string" || !notifier.bindingPath.trim()) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "notifier 必须提供有效的 bindingPath");
  }
  const nowProvider = typeof now === "function" ? now : () => now;
  const resolvedStatePath = statePath
    || env?.NAPCAT_RELAY_STATE_PATH
    || path.join(path.dirname(notifier.bindingPath), "state", "comm-relay-state.json");

  const stateStore = createRelayStateStore({
    statePath: resolvedStatePath,
    ...(maxCacheBytes !== undefined ? { maxCacheBytes } : {}),
    ...(maxEventsPerRoute !== undefined ? { maxEventsPerRoute } : {}),
    ...(maxGlobalEvents !== undefined ? { maxGlobalEvents } : {}),
    ...(maxSendRecords !== undefined ? { maxSendRecords } : {}),
    now: nowProvider,
  });

  function loadConfig() {
    return loadAndValidateRelayConfig({
      bindingPath: notifier.bindingPath,
      relayGroupsPath,
      env,
    });
  }

  function requireTransport(requiredMethods) {
    const transport = notifier._relayTransport;
    if (!transport || typeof transport !== "object") {
      throw new RelayError("RELAY_TRANSPORT_UNAVAILABLE", "notifier 缺少受控底层传输 _relayTransport");
    }
    for (const methodName of requiredMethods) {
      if (typeof transport[methodName] !== "function") {
        throw new RelayError("RELAY_TRANSPORT_UNAVAILABLE", `notifier._relayTransport 缺少方法：${methodName}`, {
          method: methodName,
        });
      }
    }
    return transport;
  }

  function extractStateLimits(config) {
    return {
      maxCacheBytes: config?.limits?.max_cache_bytes,
      maxEventsPerRoute: config?.limits?.max_events_per_route,
      maxGlobalEvents: config?.limits?.max_global_events,
      maxSendRecords: config?.limits?.max_send_records,
    };
  }

  async function relayStatus(args = {}, context = {}) {
    exactObject(args, STATUS_ALLOWED_FIELDS, "napcat_relay_status");
    const includeLiveCheck = args.include_live_check ?? false;
    if (typeof includeLiveCheck !== "boolean") {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "include_live_check 必须是布尔值", {
        field: "include_live_check",
      });
    }

    const config = loadConfig();
    const sanitized = buildSanitizedRelayView(config);
    const routes = Array.isArray(sanitized?.routes)
      ? sanitized.routes
      : (Array.isArray(sanitized?.relays) ? sanitized.relays : []);
    const peers = Array.isArray(sanitized?.peers)
      ? sanitized.peers
      : (isPlainObject(sanitized?.peers)
        ? Object.entries(sanitized.peers).map(([machineId, peer]) => ({ machine_id: machineId, ...peer }))
        : []);
    const conflicts = Array.isArray(sanitized?.conflicts)
      ? sanitized.conflicts
      : (Array.isArray(config.conflicts) ? config.conflicts : []);
    const limits = sanitized?.limits ?? config.limits ?? {};
    const retention = stateStore.getRetentionSummary(extractStateLimits(config));

    const result = {
      ok: true,
      local_machine_id: sanitized?.local_machine_id ?? config.local_machine_id,
      expected_self_id: sanitized?.expected_self_id ?? config.expected_self_id,
      ...(sanitized?.config_hash ?? config.config_hash
        ? { config_hash: sanitized?.config_hash ?? config.config_hash }
        : {}),
      routes,
      peers,
      conflicts,
      limits,
      retention,
    };

    if (includeLiveCheck) {
      const transport = requireTransport(["verifyAccountOnline", "verifyGroupIdentity"]);
      const transportOptions = context?.signal ? { signal: context.signal } : {};
      const checkedAt = nowProvider().toISOString();
      let accountCheck;
      try {
        const accountInfo = await transport.verifyAccountOnline(config.expected_self_id, transportOptions);
        accountCheck = {
          ok: true,
          expected_self_id: config.expected_self_id,
          ...(isPlainObject(accountInfo) ? accountInfo : {}),
        };
      } catch (error) {
        accountCheck = {
          ok: false,
          expected_self_id: config.expected_self_id,
          code: error?.code || "RELAY_ACCOUNT_CHECK_FAILED",
          message: error?.message || String(error),
        };
      }

      const groupChecks = [];
      for (const route of listConfigRelays(config)) {
        if (route.enabled === false) continue;
        const routeConflicts = relevantConflictsForRoute(config, route);
        if (routeConflicts.length > 0) {
          groupChecks.push({
            relay_key: route.relay_key,
            group_id: route.group_id,
            route_generation: route.generation ?? 1,
            ok: false,
            code: "RELAY_CONFIG_CONFLICT",
            message: "该中继路由存在配置冲突，已跳过实时放行",
          });
          continue;
        }
        try {
          const groupInfo = await transport.verifyGroupIdentity({
            groupId: route.group_id,
            expectedGroupName: route.expected_group_name,
            expectedMemberCount: route.expected_member_count,
            verifyMemberCount: Boolean(route.verify_member_count),
          }, transportOptions);
          groupChecks.push({
            relay_key: route.relay_key,
            group_id: route.group_id,
            route_generation: route.generation ?? 1,
            ok: true,
            ...(isPlainObject(groupInfo) ? groupInfo : {}),
          });
        } catch (error) {
          groupChecks.push({
            relay_key: route.relay_key,
            group_id: route.group_id,
            route_generation: route.generation ?? 1,
            ok: false,
            code: error?.code || "RELAY_GROUP_CHECK_FAILED",
            message: error?.message || String(error),
          });
        }
      }

      result.live_check = {
        checked_at: checkedAt,
        ok: accountCheck.ok && groupChecks.every((entry) => entry.ok),
        account: accountCheck,
        groups: groupChecks,
      };
    }

    return result;
  }

  async function relaySend(args, context = {}) {
    exactObject(args, SEND_ALLOWED_FIELDS, "napcat_relay_send");
    const transportOptions = context?.signal ? { signal: context.signal } : {};
    const currentNow = nowProvider();

    const dedupeKey = requireSafeString(args.dedupe_key, "dedupe_key", 200);
    const targetMachine = requireSafeString(args.target_machine, "target_machine", 128);
    const channel = args.channel === undefined ? "qq" : requireSafeString(args.channel, "channel", 32);
    if (channel !== "qq") {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "channel 当前仅支持 qq", { field: "channel", channel });
    }

    const replyRelayKey = optionalSafeString(args.reply_relay_key, "reply_relay_key", 128);
    const replyGroupId = args.reply_group_id === undefined || args.reply_group_id === null
      ? null
      : requireGroupId(args.reply_group_id, "reply_group_id");
    let replyRouteGeneration = null;
    if (args.reply_route_generation !== undefined && args.reply_route_generation !== null) {
      if (!Number.isSafeInteger(args.reply_route_generation) || args.reply_route_generation <= 0) {
        throw new RelayError("RELAY_INVALID_ARGUMENT", "reply_route_generation 必须是正安全整数", {
          field: "reply_route_generation",
        });
      }
      replyRouteGeneration = args.reply_route_generation;
    }
    if (!replyRelayKey && (replyGroupId !== null || replyRouteGeneration !== null)) {
      throw new RelayError(
        "RELAY_INVALID_ARGUMENT",
        "指定 reply_group_id 或 reply_route_generation 时必须同时提供 reply_relay_key",
      );
    }

    const op = requireSafeString(args.op, "op", 64);
    if (!isAllowedOp(op)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `不支持的中继操作类型 op：${op}`, { field: "op", op });
    }
    const source = requireAddress(args.source, "source");

    if (!Array.isArray(args.recipients) || args.recipients.length === 0) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "recipients 必须是非空字符串数组", { field: "recipients" });
    }
    const recipients = args.recipients.map((entry, index) => requireAddress(entry, `recipients[${index}]`));

    if (typeof args.body !== "string" || BODY_CONTROL_CHAR_PATTERN.test(args.body)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "body 必须是不含非法控制字符的字符串", { field: "body" });
    }
    const body = args.body;

    const inReplyTo = optionalSafeString(args.in_reply_to, "in_reply_to", 256);

    let meta = null;
    if (args.meta !== undefined && args.meta !== null) {
      if (!isPlainObject(args.meta)) {
        throw new RelayError("RELAY_INVALID_ARGUMENT", "meta 必须是普通对象", { field: "meta" });
      }
      meta = validateMetaValue(args.meta, "meta");
      if (meta.all_recipients !== undefined) {
        if (!Array.isArray(meta.all_recipients) || meta.all_recipients.length === 0) {
          throw new RelayError("RELAY_INVALID_ARGUMENT", "meta.all_recipients 必须是非空字符串数组", {
            field: "meta.all_recipients",
          });
        }
        meta.all_recipients = meta.all_recipients.map((entry, index) =>
          normalizeFullRecipientRef(entry, `meta.all_recipients[${index}]`),
        );
      }
    }

    let allowDiscloseRecipients;
    if (args.allow_disclose_recipients !== undefined) {
      if (typeof args.allow_disclose_recipients !== "boolean") {
        throw new RelayError("RELAY_INVALID_ARGUMENT", "allow_disclose_recipients 必须是布尔值", {
          field: "allow_disclose_recipients",
        });
      }
      allowDiscloseRecipients = args.allow_disclose_recipients;
    }

    // 1. 局部重读配置并选路
    const config = loadConfig();
    const route = replyRelayKey
      ? resolveRelayRoute(config, {
        target_machine: targetMachine,
        channel,
        mode: "reply",
        relay_key: replyRelayKey,
        expected_generation: replyRouteGeneration ?? undefined,
        expected_group_id: replyGroupId ?? undefined,
        now: currentNow,
      })
      : resolveRelayRoute(config, {
        target_machine: targetMachine,
        channel,
        mode: "write",
        now: currentNow,
      });

    // 原路回执显式二次守卫，杜绝跨群漂移或代次漂移
    if (replyGroupId !== null && route.group_id !== replyGroupId) {
      throw new RelayError("RELAY_ROUTE_CHANGED", "原路回执绑定的 reply_group_id 与路由当前群号不一致", {
        relay_key: route.relay_key,
        change_reason: "group_mismatch",
        expected_group_id: replyGroupId,
        actual_group_id: route.group_id,
      });
    }
    if (replyRouteGeneration !== null && route.generation !== replyRouteGeneration) {
      throw new RelayError(
        "RELAY_ROUTE_CHANGED",
        "原路回执绑定的 reply_route_generation 与路由当前代次不一致",
        {
          relay_key: route.relay_key,
          change_reason: "generation_mismatch",
          expected_generation: replyRouteGeneration,
          current_generation: route.generation,
          actual_generation: route.generation,
        },
      );
    }

    const conflicts = relevantConflictsForRoute(config, route, {
      ignoreAmbiguous: Boolean(replyRelayKey) && route.role === "draining_read",
    });
    if (conflicts.length > 0) {
      throw new RelayError("RELAY_CONFIG_CONFLICT", `中继路由 ${route.relay_key} 存在配置冲突，已 fail-closed 阻断发送`, {
        relay_key: route.relay_key,
        group_id: route.group_id,
        conflicts,
      });
    }
    const fullRouteConfig = isPlainObject(config.relays) && Object.hasOwn(config.relays, route.relay_key)
      ? config.relays[route.relay_key]
      : null;

    // 2. 校验 all_recipients 公开名单策略
    const allRecipients = meta?.all_recipients;
    validateRecipientDisclosure(route, {
      recipients,
      all_recipients: allRecipients,
      allow_disclose_recipients: allowDiscloseRecipients,
    });

    // 3. 编码并校验 UTF-16 <= maxFrameChars（<= 1900）
    const configuredMaxFrame = Number(config.limits?.max_frame_chars ?? DEFAULT_MAX_FRAME_CHARS);
    const maxFrameChars = Math.min(
      Number.isSafeInteger(configuredMaxFrame) && configuredMaxFrame > 0 ? configuredMaxFrame : DEFAULT_MAX_FRAME_CHARS,
      HARD_MAX_FRAME_CHARS,
    );
    const configuredMaxRecipients = Number(config.limits?.max_recipients_per_frame ?? DEFAULT_MAX_RECIPIENTS);
    const maxRecipients = Number.isSafeInteger(configuredMaxRecipients) && configuredMaxRecipients > 0
      ? configuredMaxRecipients
      : DEFAULT_MAX_RECIPIENTS;

    const relayId = `rly_${randomUUID()}`;
    const bodySha256 = computeRelayBodySha256(body);
    const encodedResult = encodeRelayFrame({
      relay_id: relayId,
      op,
      from_machine: route.local_machine_id,
      to_machine: targetMachine,
      source,
      recipients,
      ...(inReplyTo !== null ? { in_reply_to: inReplyTo } : {}),
      ...(meta !== null ? { meta } : {}),
      body,
    }, { maxFrameChars, maxRecipients });

    const encodedText = typeof encodedResult === "string"
      ? encodedResult
      : (encodedResult?.encoded ?? encodedResult?.text ?? "");
    const frameLength = typeof encodedResult === "string"
      ? encodedResult.length
      : (Number.isSafeInteger(encodedResult?.frame_length) ? encodedResult.frame_length : encodedText.length);

    // 4. 计算去重指纹并在锁内原子完成：去重校验 -> 滑窗频控 -> 写 pending_send
    const fingerprintSha256 = computeRelaySendFingerprint({
      target_machine: targetMachine,
      channel,
      reply_relay_key: replyRelayKey,
      reply_group_id: replyGroupId,
      reply_route_generation: replyRouteGeneration,
      op,
      source,
      recipients,
      all_recipients: allRecipients ?? null,
      body,
      in_reply_to: inReplyTo,
      meta,
    });

    const configuredRateLimit = Number(config.limits?.max_sends_per_minute_per_group ?? DEFAULT_MAX_SENDS_PER_MINUTE);
    const rateLimit = Number.isSafeInteger(configuredRateLimit) && configuredRateLimit > 0
      ? configuredRateLimit
      : DEFAULT_MAX_SENDS_PER_MINUTE;

    const stateLimitsOverride = {
      maxCacheBytes: config.limits?.max_cache_bytes,
      maxEventsPerRoute: config.limits?.max_events_per_route,
      maxGlobalEvents: config.limits?.max_global_events,
      maxSendRecords: config.limits?.max_send_records,
    };

    const reserved = stateStore.reserveOrCheckSend({
      dedupe_key: dedupeKey,
      fingerprint_sha256: fingerprintSha256,
      body_sha256: bodySha256,
      relay_id: relayId,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.generation,
      frame_length: frameLength,
      limits: stateLimitsOverride,
      rate_limit: {
        group_id: route.group_id,
        limit: rateLimit,
        relay_key: route.relay_key,
      },
    });

    if (reserved.duplicate) {
      const existing = reserved.record;
      const isVerified = existing.status === "sent_verified";
      return {
        ok: true,
        status: isVerified ? "duplicate" : "sent_unverified",
        transport_stage: isVerified ? "group_received" : "group_unverified",
        relay_id: existing.relay_id,
        relay_key: existing.relay_key,
        group_id: existing.group_id,
        route_generation: existing.route_generation,
        body_sha256: existing.body_sha256 ?? bodySha256,
        onebot_message_id: existing.onebot_message_id,
        real_seq: existing.real_seq,
        outcome_unknown: isVerified ? false : Boolean(existing.outcome_unknown),
        frame_length: existing.frame_length,
      };
    }

    // 5. 发送前核验（账号在线 + 群身份 + 抓 beforeRealSeq）；此处均无外部发送副作用，失败即干净撤销 pending_send
    let transport;
    let rawBeforeCheckpoint;
    let beforeCheckpoint;
    try {
      transport = requireTransport([
        "callOneBot",
        "verifyAccountOnline",
        "verifyGroupIdentity",
        "getGroupLatestRealSeq",
      ]);
      if (
        typeof transport.verifyGroupHistoryDelivery !== "function"
        && typeof transport.readGroupHistoryMultiPage !== "function"
      ) {
        throw new RelayError(
          "RELAY_TRANSPORT_UNAVAILABLE",
          "notifier._relayTransport 缺少历史核验方法（verifyGroupHistoryDelivery 或 readGroupHistoryMultiPage）",
        );
      }
      await transport.verifyAccountOnline(route.expected_self_id, transportOptions);
      await transport.verifyGroupIdentity({
        groupId: route.group_id,
        expectedGroupName: route.expected_group_name,
        expectedMemberCount: fullRouteConfig?.expected_member_count ?? route.expected_member_count ?? null,
        verifyMemberCount: Boolean(route.verify_member_count),
      }, transportOptions);
      // 再次用最新配置复核冻结路由（防并发热改配置导致错群或关闭名单公开）
      const reverifiedRoute = reverifyFrozenRelayRoute(loadConfig(), route, {
        allowDraining: Boolean(replyRelayKey),
        requireFileBundleWrite: false,
        now: nowProvider(),
      });
      validateRecipientDisclosure(reverifiedRoute, {
        recipients,
        all_recipients: allRecipients,
        allow_disclose_recipients: allowDiscloseRecipients,
      });
      rawBeforeCheckpoint = await transport.getGroupLatestRealSeq(route.group_id, route.expected_self_id, transportOptions);
      beforeCheckpoint = extractBeforeCheckpoint(rawBeforeCheckpoint);
    } catch (error) {
      try {
        stateStore.abortPendingSend({
          dedupe_key: dedupeKey,
          relay_id: relayId,
          rate_timestamp_ms: reserved.rate_timestamp_ms,
        });
      } catch {
      }
      throw wrapTransportError(error, "RELAY_PREFLIGHT_FAILED", "中继发送前置核验失败", {
        outcomeUnknown: false,
        details: { relay_key: route.relay_key, group_id: route.group_id, route_generation: route.generation },
      });
    }

    function safeFinalizePostSend(payload) {
      try {
        stateStore.finalizeSend({
          before_real_seq: beforeCheckpoint.beforeRealSeq,
          before_empty_history: beforeCheckpoint.emptyHistory,
          ...payload,
        });
      } catch (persistError) {
        throw wrapTransportError(
          persistError,
          "RELAY_SEND_OUTCOME_UNKNOWN",
          "消息已发出但持久化发送结果失败，请按原 dedupe_key 核对，严禁更换参数重发",
          {
            outcomeUnknown: true,
            details: {
              relay_id: relayId,
              relay_key: route.relay_key,
              group_id: route.group_id,
              route_generation: route.generation,
              body_sha256: bodySha256,
              onebot_message_id: payload.onebot_message_id ?? null,
            },
          },
        );
      }
    }

    // 6. 触发真实 OneBot send_group_msg（使用纯文本 segment 数组杜绝 CQ 码解析注入；此后严禁自动回滚或重试）
    let sendData;
    try {
      sendData = await transport.callOneBot("send_group_msg", {
        group_id: route.group_id,
        message: [{ type: "text", data: { text: encodedText } }],
      }, transportOptions);
    } catch (error) {
      try {
        stateStore.finalizeSend({
          dedupe_key: dedupeKey,
          status: "sent_unverified",
          body_sha256: bodySha256,
          before_real_seq: beforeCheckpoint.beforeRealSeq,
          before_empty_history: beforeCheckpoint.emptyHistory,
          onebot_message_id: null,
          real_seq: null,
          outcome_unknown: true,
        });
      } catch {
      }
      throw wrapTransportError(error, "RELAY_SEND_OUTCOME_UNKNOWN", "send_group_msg 调用失败，发送结果未知，请勿更换参数重发", {
        outcomeUnknown: true,
        details: {
          relay_id: relayId,
          relay_key: route.relay_key,
          group_id: route.group_id,
          route_generation: route.generation,
          body_sha256: bodySha256,
        },
      });
    }

    const onebotMessageId = String(sendData?.message_id ?? "").trim();
    if (!onebotMessageId) {
      safeFinalizePostSend({
        dedupe_key: dedupeKey,
        status: "sent_unverified",
        body_sha256: bodySha256,
        onebot_message_id: null,
        real_seq: null,
        outcome_unknown: true,
      });
      return {
        ok: true,
        status: "sent_unverified",
        transport_stage: "group_unverified",
        relay_id: relayId,
        relay_key: route.relay_key,
        group_id: route.group_id,
        route_generation: route.generation,
        body_sha256: bodySha256,
        onebot_message_id: null,
        real_seq: null,
        outcome_unknown: true,
        frame_length: frameLength,
      };
    }

    // 先落盘 sent_unverified，确保校验期间即使进程退出也留存 onebot_message_id
    safeFinalizePostSend({
      dedupe_key: dedupeKey,
      status: "sent_unverified",
      body_sha256: bodySha256,
      onebot_message_id: onebotMessageId,
      real_seq: null,
      outcome_unknown: true,
    });

    // 7. 调 get_msg + 群历史 realSeq 递进校验
    let verified = false;
    let verifiedRealSeq = null;
    try {
      const msg = await transport.callOneBot("get_msg", { message_id: onebotMessageId }, transportOptions);
      const msgId = String(msg?.message_id ?? "").trim();
      const msgGroupId = String(msg?.group_id ?? "").trim();
      const msgSenderId = String(msg?.sender?.user_id ?? msg?.user_id ?? "").trim();
      const msgText = normalizeLineEndings(extractOneBotText(msg));
      const expectedNormalized = normalizeLineEndings(encodedText);

      const getMsgValid = msgId === onebotMessageId
        && msgGroupId === route.group_id
        && (!msgSenderId || msgSenderId === route.expected_self_id)
        && msgText === expectedNormalized;

      if (getMsgValid) {
        if (typeof transport.verifyGroupHistoryDelivery === "function") {
          const deliveryEvidence = await transport.verifyGroupHistoryDelivery(
            route.group_id,
            encodedText,
            onebotMessageId,
            isPlainObject(rawBeforeCheckpoint)
              ? rawBeforeCheckpoint
              : { maxRealSeq: beforeCheckpoint.beforeRealSeq, messageCount: beforeCheckpoint.emptyHistory ? 0 : 1 },
            route.expected_self_id,
            transportOptions,
          );
          const deliveredRealSeq = numericRealSeq(deliveryEvidence?.deliveredRealSeq ?? msg?.real_seq);
          if (deliveryEvidence?.realSeqAdvanced === true && deliveredRealSeq !== null && deliveredRealSeq >= 1) {
            verified = true;
            verifiedRealSeq = deliveredRealSeq;
          }
        } else {
          const recent = await transport.readGroupHistoryMultiPage(route.group_id, 1, route.expected_self_id, transportOptions);
          const recentMessages = Array.isArray(recent?.messages) ? recent.messages : [];
          const historyMatch = recentMessages.find((item) => {
            const itemId = String(item?.messageId ?? item?.message_id ?? "").trim();
            if (itemId !== onebotMessageId) return false;
            const itemSender = String(item?.senderId ?? item?.sender_id ?? item?.sender?.user_id ?? "").trim();
            const isSelf = item?.isSelf === true || itemSender === route.expected_self_id;
            if (!isSelf) return false;
            if (itemSender && itemSender !== route.expected_self_id) return false;
            const itemText = normalizeLineEndings(extractOneBotText(item));
            return itemText === expectedNormalized;
          });

          if (historyMatch) {
            const deliveredRealSeq = numericRealSeq(
              historyMatch.realSeq ?? historyMatch.real_seq ?? msg?.real_seq,
            );
            const realSeqAdvanced = deliveredRealSeq !== null && deliveredRealSeq >= 1 && (
              beforeCheckpoint.beforeRealSeq === null
                ? beforeCheckpoint.emptyHistory
                : deliveredRealSeq > beforeCheckpoint.beforeRealSeq
            );
            if (realSeqAdvanced) {
              verified = true;
              verifiedRealSeq = deliveredRealSeq;
            }
          }
        }
      }
    } catch {
      verified = false;
    }

    const finalStatus = verified ? "sent_verified" : "sent_unverified";
    const outcomeUnknown = !verified;
    safeFinalizePostSend({
      dedupe_key: dedupeKey,
      status: finalStatus,
      body_sha256: bodySha256,
      onebot_message_id: onebotMessageId,
      real_seq: verifiedRealSeq,
      outcome_unknown: outcomeUnknown,
    });

    return {
      ok: true,
      status: finalStatus,
      transport_stage: verified ? "group_received" : "group_unverified",
      relay_id: relayId,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.generation,
      body_sha256: bodySha256,
      onebot_message_id: onebotMessageId,
      real_seq: verifiedRealSeq,
      outcome_unknown: outcomeUnknown,
      frame_length: frameLength,
    };
  }

  async function reconcileSendRecord(dedupeKey, frozenRoute = null, options = {}) {
    options?.signal?.throwIfAborted?.();
    const rec = stateStore.getSendRecord(dedupeKey);
    if (!rec) return null;
    if (
      rec.status === "sent_verified"
      && rec.outcome_unknown === false
      && rec.onebot_message_id
      && Number.isSafeInteger(rec.real_seq)
      && rec.real_seq >= 1
    ) {
      return rec;
    }
    if (!rec.body_sha256 || !rec.relay_id || !rec.group_id) {
      return rec;
    }
    const config = loadConfig();
    const expectedSelfId = frozenRoute?.expected_self_id || config.expected_self_id;
    const expectedLocalMachine = frozenRoute?.local_machine_id || config.local_machine_id;
    const transportOptions = options?.signal ? { signal: options.signal } : {};
    try {
      const transport = requireTransport(["verifyAccountOnline", "readGroupHistoryMultiPage", "callOneBot"]);
      await transport.verifyAccountOnline(expectedSelfId, transportOptions);
      const history = await transport.readGroupHistoryMultiPage(rec.group_id, 2, expectedSelfId, transportOptions);
      const items = Array.isArray(history?.messages) ? history.messages : [];
      const matches = [];
      for (const item of items) {
        const senderId = String(item?.senderId ?? item?.sender_id ?? item?.sender?.user_id ?? "").trim();
        const isSelf = item?.isSelf === true || senderId === expectedSelfId;
        if (!isSelf || (senderId && senderId !== expectedSelfId)) continue;
        const decoded = decodeRelayFrame(extractOneBotText(item));
        const frame = normalizeDecodedFrame(decoded);
        if (!frame) continue;
        if (frame.from_machine !== expectedLocalMachine) continue;
        if (frame.relay_id !== rec.relay_id || frame.body_sha256 !== rec.body_sha256) continue;
        const msgId = String(item?.messageId ?? item?.message_id ?? "").trim();
        if (!msgId) continue;
        if (rec.onebot_message_id && msgId !== String(rec.onebot_message_id)) continue;
        const realSeq = numericRealSeq(item?.realSeq ?? item?.real_seq);
        if (realSeq === null || realSeq < 1) continue;
        const hasBeforeSeq = Number.isSafeInteger(rec.before_real_seq);
        const advanced = hasBeforeSeq
          ? realSeq > rec.before_real_seq
          : (rec.before_real_seq === null ? rec.before_empty_history === true : true);
        if (!advanced) continue;
        matches.push({ msgId, realSeq });
      }
      if (matches.length === 1) {
        const { msgId, realSeq } = matches[0];
        // 二次调用 get_msg 校验群号、发件人与完整帧哈希，杜绝本地假回显误升级
        const msg = await transport.callOneBot("get_msg", { message_id: msgId }, transportOptions);
        const fetchedId = String(msg?.message_id ?? "").trim();
        const fetchedGroupId = String(msg?.group_id ?? "").trim();
        const fetchedSenderId = String(msg?.sender?.user_id ?? msg?.user_id ?? "").trim();
        const fetchedFrame = normalizeDecodedFrame(decodeRelayFrame(extractOneBotText(msg)));
        if (
          fetchedId === msgId
          && fetchedGroupId === rec.group_id
          && (!fetchedSenderId || fetchedSenderId === expectedSelfId)
          && fetchedFrame
          && fetchedFrame.from_machine === expectedLocalMachine
          && fetchedFrame.relay_id === rec.relay_id
          && fetchedFrame.body_sha256 === rec.body_sha256
        ) {
          return stateStore.finalizeSend({
            dedupe_key: dedupeKey,
            status: "sent_verified",
            body_sha256: rec.body_sha256,
            onebot_message_id: msgId,
            real_seq: realSeq,
            outcome_unknown: false,
          });
        }
      }
    } catch {
      options?.signal?.throwIfAborted?.();
    }
    options?.signal?.throwIfAborted?.();
    return stateStore.getSendRecord(dedupeKey);
  }

  async function relayPoll(args = {}, context = {}) {
    exactObject(args, POLL_ALLOWED_FIELDS, "napcat_relay_poll");
    const transportOptions = context?.signal ? { signal: context.signal } : {};
    const currentNowMs = nowProvider().getTime();

    let requestedKeys = null;
    if (args.relay_keys !== undefined) {
      if (!Array.isArray(args.relay_keys) || args.relay_keys.length === 0) {
        throw new RelayError("RELAY_INVALID_ARGUMENT", "relay_keys 必须是非空字符串数组", {
          field: "relay_keys",
        });
      }
      requestedKeys = [...new Set(
        args.relay_keys.map((key, index) => requireSafeString(key, `relay_keys[${index}]`, 128)),
      )];
    }

    let requestedMaxPages = null;
    if (args.max_pages !== undefined) {
      if (!Number.isSafeInteger(args.max_pages) || args.max_pages < 1 || args.max_pages > HARD_MAX_POLL_PAGES) {
        throw new RelayError("RELAY_INVALID_ARGUMENT", `max_pages 必须是 1 至 ${HARD_MAX_POLL_PAGES} 的安全整数`, {
          field: "max_pages",
        });
      }
      requestedMaxPages = args.max_pages;
    }

    const config = loadConfig();
    const topConflicts = globalConflicts(config);
    if (topConflicts.length > 0) {
      throw new RelayError("RELAY_CONFIG_CONFLICT", "中继全局配置存在冲突，已 fail-closed 阻断轮询", {
        conflicts: topConflicts,
      });
    }

    const configuredMaxPages = Number(config.limits?.max_poll_pages ?? DEFAULT_MAX_POLL_PAGES);
    const defaultMaxPages = Number.isSafeInteger(configuredMaxPages) && configuredMaxPages > 0
      ? Math.min(configuredMaxPages, HARD_MAX_POLL_PAGES)
      : DEFAULT_MAX_POLL_PAGES;
    const effectiveMaxPages = requestedMaxPages ?? defaultMaxPages;

    const allRelays = listConfigRelays(config);
    const readableRelays = allRelays.filter(
      (route) => route.enabled !== false
        && (route.role === "active_write" || route.role === "draining_read")
        && !isRelayRouteDrainExpired(route, currentNowMs),
    );

    let targetRelays;
    if (requestedKeys !== null) {
      const byKey = new Map(readableRelays.map((route) => [route.relay_key, route]));
      targetRelays = [];
      for (const key of requestedKeys) {
        const matched = byKey.get(key);
        if (!matched) {
          const rawRoute = isPlainObject(config.relays) && Object.hasOwn(config.relays, key) ? config.relays[key] : null;
          if (rawRoute && isRelayRouteDrainExpired(rawRoute, currentNowMs)) {
            throw new RelayError("RELAY_ROUTE_DRAIN_EXPIRED", `中继路由 ${key} 排空已到期`, {
              relay_key: key,
              drain_until: rawRoute.drain_until,
            });
          }
          throw new RelayError("RELAY_ROUTE_NOT_FOUND", `未找到可读取的中继路由：${key}`, { relay_key: key });
        }
        const routeConflicts = relevantConflictsForRoute(config, matched, { ignoreAmbiguous: true });
        if (routeConflicts.length > 0) {
          throw new RelayError("RELAY_CONFIG_CONFLICT", `中继路由 ${key} 存在配置冲突，无法轮询`, {
            relay_key: key,
            group_id: matched.group_id,
            conflicts: routeConflicts,
          });
        }
        targetRelays.push(matched);
      }
    } else {
      targetRelays = readableRelays.filter(
        (route) => relevantConflictsForRoute(config, route, { ignoreAmbiguous: true }).length === 0,
      );
    }

    const transport = requireTransport([
      "verifyAccountOnline",
      "verifyGroupIdentity",
      "readGroupHistoryMultiPage",
    ]);

    try {
      await transport.verifyAccountOnline(config.expected_self_id, transportOptions);
    } catch (error) {
      throw wrapTransportError(error, "RELAY_ACCOUNT_NOT_ONLINE", "NapCat 账号在线状态核验失败", {
        outcomeUnknown: false,
      });
    }

    const scannedRoutes = [];
    const historyGaps = [];
    let totalIngested = 0;
    let totalIgnored = 0;
    const singleExplicitRoute = requestedKeys !== null && requestedKeys.length === 1;
    const stateLimits = extractStateLimits(config);

    for (const route of targetRelays) {
      const routeGeneration = route.generation ?? 1;
      try {
        await transport.verifyGroupIdentity({
          groupId: route.group_id,
          expectedGroupName: route.expected_group_name,
          expectedMemberCount: route.expected_member_count,
          verifyMemberCount: Boolean(route.verify_member_count),
        }, transportOptions);
      } catch (error) {
        const wrapped = wrapTransportError(error, "RELAY_GROUP_IDENTITY_MISMATCH", `中继群 ${route.relay_key} 身份核验失败`, {
          outcomeUnknown: false,
          details: { relay_key: route.relay_key, group_id: route.group_id, route_generation: routeGeneration },
        });
        if (singleExplicitRoute) throw wrapped;
        scannedRoutes.push({
          relay_key: route.relay_key,
          group_id: route.group_id,
          route_generation: routeGeneration,
          role: route.role,
          ok: false,
          error_code: wrapped.code,
          error_message: wrapped.message,
          pages_scanned: 0,
          stop_reason: "group_identity_failed",
          ingested_count: 0,
          ignored_count: 0,
          history_gap: false,
        });
        continue;
      }

      const rawSnapshot = stateStore.getRouteSnapshot(route.relay_key);
      const priorSnapshot = rawSnapshot
        && rawSnapshot.group_id === route.group_id
        && rawSnapshot.route_generation === routeGeneration
        ? rawSnapshot
        : null;
      const seenEventIds = new Set(priorSnapshot?.seen_event_ids ?? []);
      const seenAnchorIds = new Set(priorSnapshot?.seen_anchor_ids ?? []);
      const declaredBootstrapAt = typeof route.bootstrap_at === "string" ? route.bootstrap_at : null;
      const effectiveBootstrapAt = priorSnapshot?.bootstrap_at ?? declaredBootstrapAt;
      const effectiveBootstrapMs = effectiveBootstrapAt ? Date.parse(effectiveBootstrapAt) : null;
      const isInitialNoBootstrap = priorSnapshot === null && declaredBootstrapAt === null;

      let historyResult;
      try {
        historyResult = await transport.readGroupHistoryMultiPage(
          route.group_id,
          isInitialNoBootstrap ? 1 : effectiveMaxPages,
          config.expected_self_id,
          {
            ...transportOptions,
            shouldStopAfterPage: (pageMessages) => {
              if (isInitialNoBootstrap) return true;
              for (const item of pageMessages) {
                const mid = String(item?.messageId ?? item?.message_id ?? "").trim();
                if (mid && (seenAnchorIds.has(mid) || seenEventIds.has(computeRelayEventId(config.expected_self_id, route.group_id, mid)))) {
                  return true;
                }
                if (effectiveBootstrapMs !== null && Number.isFinite(effectiveBootstrapMs)) {
                  const tIso = normalizeMessageTimeIso(item?.time);
                  const tMs = tIso ? Date.parse(tIso) : null;
                  if (tMs !== null && tMs <= effectiveBootstrapMs) {
                    return true;
                  }
                }
              }
              return false;
            },
          },
        );
      } catch (error) {
        const wrapped = wrapTransportError(error, "RELAY_HISTORY_READ_FAILED", `读取中继群 ${route.relay_key} 历史消息失败`, {
          outcomeUnknown: false,
          details: { relay_key: route.relay_key, group_id: route.group_id, route_generation: routeGeneration },
        });
        if (singleExplicitRoute) throw wrapped;
        scannedRoutes.push({
          relay_key: route.relay_key,
          group_id: route.group_id,
          route_generation: routeGeneration,
          role: route.role,
          ok: false,
          error_code: wrapped.code,
          error_message: wrapped.message,
          pages_scanned: 0,
          stop_reason: "history_read_failed",
          ingested_count: 0,
          ignored_count: 0,
          history_gap: false,
        });
        continue;
      }

      const rawMessages = Array.isArray(historyResult?.messages) ? historyResult.messages : [];
      const pagesScanned = Number.isSafeInteger(historyResult?.pagesScanned)
        ? historyResult.pagesScanned
        : (Number.isSafeInteger(historyResult?.pages_scanned) ? historyResult.pages_scanned : 0);
      const stopReason = String(historyResult?.stopReason ?? historyResult?.stop_reason ?? "history_exhausted");

      const enriched = rawMessages.map((msg, index) => {
        const messageId = String(msg?.messageId ?? msg?.message_id ?? "").trim();
        const timeIso = normalizeMessageTimeIso(msg?.time);
        const timeMs = timeIso ? Date.parse(timeIso) : null;
        const realSeq = numericRealSeq(msg?.realSeq ?? msg?.real_seq);
        return { msg, index, messageId, timeIso, timeMs, realSeq };
      });

      // 优先按同群权威 realSeq 从旧到新排序，缺失时再回退 timeMs
      enriched.sort((left, right) => {
        if (left.realSeq !== null && right.realSeq !== null && left.realSeq !== right.realSeq) {
          return left.realSeq - right.realSeq;
        }
        if (left.timeMs !== null && right.timeMs !== null && left.timeMs !== right.timeMs) {
          return left.timeMs - right.timeMs;
        }
        return left.index - right.index;
      });

      const nowIso = nowProvider().toISOString();
      let oldestSeenIso = null;
      let newestSeenIso = null;
      let reachedBootstrap = false;
      let reachedAnchor = false;
      let routeIgnored = 0;
      const validEvents = [];
      const recentAnchorIds = [];

      for (const entry of enriched) {
        if (entry.timeIso) {
          if (oldestSeenIso === null || Date.parse(entry.timeIso) < Date.parse(oldestSeenIso)) {
            oldestSeenIso = entry.timeIso;
          }
          if (newestSeenIso === null || Date.parse(entry.timeIso) > Date.parse(newestSeenIso)) {
            newestSeenIso = entry.timeIso;
          }
        }
        if (entry.messageId) {
          recentAnchorIds.push(entry.messageId);
          if (seenAnchorIds.has(entry.messageId)) {
            reachedAnchor = true;
          }
        }
        if (
          effectiveBootstrapMs !== null
          && Number.isFinite(effectiveBootstrapMs)
          && entry.timeMs !== null
          && entry.timeMs <= effectiveBootstrapMs
        ) {
          reachedBootstrap = true;
        }

        if (!entry.messageId) {
          routeIgnored += 1;
          continue;
        }

        const eventId = computeRelayEventId(config.expected_self_id, route.group_id, entry.messageId);
        if (seenEventIds.has(eventId)) {
          reachedAnchor = true;
          continue;
        }

        if (isInitialNoBootstrap) {
          // 首次无 bootstrap_at 接入既有群仅建基线锚点，不误回放旧历史
          routeIgnored += 1;
          continue;
        }

        if (
          effectiveBootstrapMs !== null
          && Number.isFinite(effectiveBootstrapMs)
          && entry.timeMs !== null
          && entry.timeMs < effectiveBootstrapMs
        ) {
          routeIgnored += 1;
          continue;
        }

        // 先验 sender / !isSelf / 授权 peer，再解码帧，缩小未授权输入对解码器的暴露面
        const senderId = String(entry.msg?.senderId ?? entry.msg?.sender_id ?? entry.msg?.sender?.user_id ?? "").trim();
        const isSelf = entry.msg?.isSelf === true || senderId === config.expected_self_id;
        if (!senderId || isSelf) {
          routeIgnored += 1;
          continue;
        }

        const peerMatch = findPeerMachineByQq(config, senderId);
        const senderMachine = typeof peerMatch === "string"
          ? peerMatch
          : (peerMatch?.machine_id ?? null);
        if (!senderMachine || !peerAllowedForRoute(config, route, senderMachine)) {
          routeIgnored += 1;
          continue;
        }

        const text = extractOneBotText(entry.msg);
        const decoded = decodeRelayFrame(text);
        if (!decoded || decoded.malformed) {
          routeIgnored += 1;
          continue;
        }

        const frame = normalizeDecodedFrame(decoded);
        if (!frame) {
          routeIgnored += 1;
          continue;
        }

        if (senderMachine !== frame.from_machine || frame.to_machine !== config.local_machine_id) {
          routeIgnored += 1;
          continue;
        }

        validEvents.push({
          event_id: eventId,
          relay_key: route.relay_key,
          group_id: route.group_id,
          route_generation: routeGeneration,
          onebot_message_id: entry.messageId,
          real_seq: entry.realSeq,
          sender_id: senderId,
          source_machine: senderMachine,
          received_at: entry.timeIso ?? nowIso,
          frame,
        });
      }

      const nextBootstrapAt = isInitialNoBootstrap
        ? (newestSeenIso ?? nowIso)
        : (effectiveBootstrapAt ?? oldestSeenIso ?? nowIso);

      const hitPageLimit = stopReason === "page_limit_reached" && pagesScanned >= effectiveMaxPages;
      const hitCursorAnomaly = stopReason === "missing_or_repeated_cursor";
      const hasNewGap = !isInitialNoBootstrap && (hitPageLimit || hitCursorAnomaly) && !reachedBootstrap && !reachedAnchor;

      const ingestResult = stateStore.ingestRouteEvents({
        relay_key: route.relay_key,
        group_id: route.group_id,
        route_generation: routeGeneration,
        bootstrap_at: nextBootstrapAt,
        events: validEvents,
        scanned_anchor_ids: recentAnchorIds.slice(-200),
        clear_history_gap: !hasNewGap && (reachedBootstrap || stopReason === "history_exhausted" || isInitialNoBootstrap),
        limits: stateLimits,
      });

      let routeGap = null;
      if (hasNewGap) {
        routeGap = stateStore.recordRouteHistoryGap({
          relay_key: route.relay_key,
          group_id: route.group_id,
          route_generation: routeGeneration,
          pages_scanned: pagesScanned,
          max_pages: effectiveMaxPages,
          oldest_seen_at: oldestSeenIso,
          bootstrap_at: nextBootstrapAt,
          reason: hitCursorAnomaly
            ? "missing_or_repeated_cursor_before_baseline_or_anchor"
            : "max_pages_reached_before_baseline_or_anchor",
          detected_at: nowIso,
        });
        historyGaps.push(routeGap);
      }

      totalIngested += ingestResult.ingested_count;
      totalIgnored += routeIgnored;
      scannedRoutes.push({
        relay_key: route.relay_key,
        group_id: route.group_id,
        route_generation: routeGeneration,
        role: route.role,
        ok: true,
        pages_scanned: pagesScanned,
        stop_reason: stopReason,
        ingested_count: ingestResult.ingested_count,
        ignored_count: routeIgnored,
        history_gap: routeGap !== null,
      });
    }

    return {
      ok: true,
      scanned_routes: scannedRoutes,
      ingested_count: totalIngested,
      ignored_count: totalIgnored,
      history_gaps: historyGaps,
      retention: stateStore.getRetentionSummary(stateLimits),
    };
  }

  async function relayEventsRead(args = {}) {
    exactObject(args, EVENTS_READ_ALLOWED_FIELDS, "napcat_relay_events_read");

    const cursor = args.cursor === undefined ? null : args.cursor;
    if (cursor !== null && typeof cursor !== "string") {
      throw new RelayError("RELAY_CURSOR_INVALID", "cursor 必须是字符串或 null", { field: "cursor" });
    }
    const limit = args.limit === undefined ? 50 : args.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "limit 必须是 1 至 50 的安全整数", { field: "limit" });
    }
    const relayKey = args.relay_key === undefined || args.relay_key === null
      ? null
      : requireSafeString(args.relay_key, "relay_key", 128);
    if (args.resume_from_retained !== undefined && typeof args.resume_from_retained !== "boolean") {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "resume_from_retained 必须是布尔值", { field: "resume_from_retained" });
    }

    const config = loadConfig();
    const activeRoute = relayKey && Object.hasOwn(config.relays, relayKey) ? config.relays[relayKey] : null;
    const result = stateStore.readEvents({
      local_machine_id: config.local_machine_id,
      expected_self_id: config.expected_self_id,
      relay_key: relayKey,
      expected_group_id: activeRoute?.group_id ?? null,
      expected_route_generation: activeRoute?.generation ?? null,
      cursor,
      limit,
      resume_from_retained: args.resume_from_retained === true,
      limits: extractStateLimits(config),
    });

    return {
      ok: true,
      events: result.events,
      next_cursor: result.next_cursor,
      has_more: result.has_more,
      retention: result.retention,
      route_gaps: result.route_gaps,
    };
  }

  return {
    statePath: resolvedStatePath,
    stateStore,
    relayStatus,
    relaySend,
    relayPoll,
    relayEventsRead,
    inspectSendRecord: (dedupeKey) => stateStore.getSendRecord(dedupeKey),
    reconcileSendRecord,
  };
}
