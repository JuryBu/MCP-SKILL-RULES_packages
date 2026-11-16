import { createHash } from "node:crypto";

export const OWNER_WINDOW_EVENT_LIMITS = Object.freeze({
  cacheBytes: 1024 * 1024, pageSize: 50, cursorBytes: 4096, registrationReceipts: 128,
});

export class OwnerWindowEventsError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "OwnerWindowEventsError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new OwnerWindowEventsError(`OWNER_WINDOW_${code}`, message, details);
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function text(value, name, maximum = 256) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value) || ["__proto__", "constructor", "prototype", "*"].includes(value)) {
    fail("INVALID_ARGUMENT", `${name}无效`);
  }
  return value;
}

function exactObject(value, fields, name) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key)
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) {
    fail("INVALID_ARGUMENT", `${name}必须是字段受限的普通对象`);
  }
}

export function nativeWindowId(value, signed = false) {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof normalized === "string" && (signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/).test(normalized)
    ? normalized : null;
}

export function normalizeWindowBinding(value) {
  exactObject(value, ["generation", "owner_key", "target"], "window_binding");
  if (!integer(value.generation, 1)) fail("INVALID_ARGUMENT", "window_binding.generation须为正安全整数");
  const fields = ["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation"];
  exactObject(value.target, fields, "window_binding.target");
  const target = Object.fromEntries(fields.slice(0, 5).map((field) => [field, text(value.target[field], field,
    field === "conversation_id" ? 256 : field === "host" || field === "surface" ? 64 : 128)]));
  if (!integer(value.target.binding_generation, 1)) fail("INVALID_ARGUMENT", "binding_generation须为正安全整数");
  target.binding_generation = value.target.binding_generation;
  const ownerKey = JSON.stringify(fields.slice(0, 4).map((field) => target[field]));
  if (value.owner_key !== ownerKey) fail("BINDING_IDENTITY_MISMATCH", "owner_key与模型四元身份不一致");
  return { generation: value.generation, owner_key: ownerKey, target };
}

export function normalizeWindowRegisterInput(input) {
  exactObject(input, ["route_key", "conversation_id", "target_key", "capture_owner_events", "reply_delivery",
    "window_capture", "expected_generation", "dedupe_key", "window_binding"], "窗口注册");
  if (input.capture_owner_events !== true || input.reply_delivery !== "events_only" || input.window_capture !== true) {
    fail("INVALID_ARGUMENT", "窗口注册须同时显式启用capture_owner_events=true、reply_delivery=events_only、window_capture=true");
  }
  if (!integer(input.expected_generation)) fail("INVALID_ARGUMENT", "expected_generation须为非负安全整数");
  return {
    routeKey: text(input.route_key, "route_key"),
    conversationId: text(input.conversation_id, "conversation_id"),
    targetKey: text(input.target_key, "target_key", 64),
    expectedGeneration: input.expected_generation,
    dedupeKey: text(input.dedupe_key, "dedupe_key", 200),
    windowBinding: normalizeWindowBinding(input.window_binding),
  };
}

function windowPolicy(input) {
  const target = input.windowTarget;
  exactObject(target, ["type", "id"], "窗口目标");
  const id = nativeWindowId(target.id);
  const selfId = nativeWindowId(input.windowSelfId);
  if (!["private", "group"].includes(target.type) || !id || !selfId) fail("TRUST_UNAVAILABLE", "缺少可信窗口或本机账号身份");
  const allowlist = [...new Set(input.windowOwnerSenderAllowlist ?? [])].sort();
  if (!allowlist.length || allowlist.some((sender) => nativeWindowId(sender) !== sender)
    || (target.type === "private" && (allowlist.length !== 1 || allowlist[0] !== id))) {
    fail("TRUST_UNAVAILABLE", "窗口缺少严格约束的本人sender映射");
  }
  return { windowTarget: { type: target.type, id }, windowSelfId: selfId, windowOwnerSenderAllowlist: allowlist };
}

function nextGeneration(value) {
  if (!integer(value) || !integer(value + 1, 1)) fail("STATE_INVALID", "窗口路由代次超出安全范围");
  return value + 1;
}

function scopedRoute(route, input, requireOpen = false) {
  text(input.routeKey, "route_key");
  text(input.conversationId, "conversation_id");
  if (!route || route.windowCapture !== true || route.routeKey !== input.routeKey
    || route.conversationId !== input.conversationId || (requireOpen && route.status !== "open")) {
    fail("SCOPE_MISMATCH", "窗口路由、组件对话或打开状态不匹配");
  }
  validateOwnerWindowRoute(route);
}

export function validateOwnerWindowRoute(route) {
  if (route.windowCapture !== true || route.replyDelivery !== "events_only" || !integer(route.windowRouteGeneration, 1)
    || !integer(route.ownerWindowEventCounter) || !integer(route.ownerWindowEvictedThrough)
    || route.ownerWindowEvictedThrough > route.ownerWindowEventCounter || !Array.isArray(route.ownerWindowEvents)
    || !Array.isArray(route.windowSeenMessageKeys) || route.windowSeenMessageKeys.length > 50
    || !Array.isArray(route.windowRegistrationReceipts)
    || route.windowRegistrationReceipts.length > OWNER_WINDOW_EVENT_LIMITS.registrationReceipts) {
    fail("STATE_INVALID", "窗口事件账本结构无效");
  }
  normalizeWindowBinding(route.windowBinding);
  windowPolicy(route);
  for (const key of route.windowSeenMessageKeys) text(key, "windowSeenMessageKeys", 768);
  let previous = route.ownerWindowEvictedThrough;
  const eventIds = new Set();
  for (const event of route.ownerWindowEvents) {
    if (!event || !integer(event.sequence, 1) || event.sequence !== previous + 1
      || event.sequence > route.ownerWindowEventCounter || !/^[a-f0-9]{64}$/.test(event.event_id) || eventIds.has(event.event_id)
      || !integer(event.route_generation, 1) || event.route_generation > route.windowRouteGeneration
      || event.route_key !== route.routeKey || event.conversation_id !== route.conversationId
      || event.target_key !== route.targetKey || JSON.stringify(event.window) !== JSON.stringify({
        channel: "qq", type: route.windowTarget.type, id: route.windowTarget.id, self_id: route.windowSelfId,
      })) fail("STATE_INVALID", "窗口事件的持久顺序或来源无效");
    normalizeWindowBinding(event.window_binding);
    if (!Array.isArray(event.owner_sender_allowlist) || !event.owner_sender_allowlist.length
      || event.owner_sender_allowlist.some((sender) => !nativeWindowId(sender))
      || (event.window.type === "private" && (event.owner_sender_allowlist.length !== 1
        || event.owner_sender_allowlist[0] !== event.window.id))) fail("STATE_INVALID", "窗口事件的本人映射快照无效");
    if (event.unavailable === undefined && (!nativeWindowId(event.message_id, true) || !nativeWindowId(event.sender_id)
      || !event.owner_sender_allowlist.includes(event.sender_id) || !integer(event.message_seq)
      || typeof event.text !== "string")) fail("STATE_INVALID", "窗口原生事件字段无效");
    if (event.unavailable !== undefined && typeof event.unavailable !== "string") fail("STATE_INVALID", "窗口内容缺失标记无效");
    previous = event.sequence;
    eventIds.add(event.event_id);
  }
  if (previous !== route.ownerWindowEventCounter
    || Buffer.byteLength(JSON.stringify(route.ownerWindowEvents), "utf8") > OWNER_WINDOW_EVENT_LIMITS.cacheBytes) {
    fail("STATE_INVALID", "窗口事件保留范围或大小无效");
  }
  const receiptKeys = new Set();
  for (const receipt of route.windowRegistrationReceipts) {
    text(receipt.dedupe_key, "dedupe_key", 200);
    if (receiptKeys.has(receipt.dedupe_key) || !/^[a-f0-9]{64}$/.test(receipt.fingerprint)
      || !integer(receipt.expected_generation) || !integer(receipt.applied_generation, 1)
      || receipt.applied_generation > route.windowRouteGeneration) fail("STATE_INVALID", "窗口注册回执无效");
    receiptKeys.add(receipt.dedupe_key);
  }
}

export function publicOwnerWindowRoute(route) {
  return {
    route_key: route.routeKey, conversation_id: route.conversationId, target_key: route.targetKey,
    route_generation: route.windowRouteGeneration, status: route.status,
    capture_owner_events: true, reply_delivery: "events_only", window_capture: true,
    window: { channel: "qq", type: route.windowTarget.type, id: route.windowTarget.id, self_id: route.windowSelfId },
    window_binding: copy(route.windowBinding), owner_sender_allowlist: route.windowOwnerSenderAllowlist.slice(),
    baseline_message_count: route.baselineMessageKeys.length, opened_at: route.openedAt, closed_at: route.closedAt,
  };
}

export function getOwnerWindowRegistration(route, input) {
  scopedRoute(route, input);
  const receipt = input.dedupeKey === undefined ? null : route.windowRegistrationReceipts.find((entry) =>
    entry.dedupe_key === text(input.dedupeKey, "dedupe_key", 200)) ?? null;
  return { ok: true, route: publicOwnerWindowRoute(route), registration: copy(receipt) };
}

export function applyOwnerWindowRegistration(state, input, now) {
  const routeKey = text(input.routeKey, "route_key");
  const conversationId = text(input.conversationId, "conversation_id");
  const targetKey = text(input.targetKey, "target_key", 64);
  const dedupeKey = text(input.dedupeKey, "dedupe_key", 200);
  if (!integer(input.expectedGeneration)) fail("INVALID_ARGUMENT", "expected_generation须为非负安全整数");
  const binding = normalizeWindowBinding(input.windowBinding);
  const policy = windowPolicy(input);
  const fingerprint = createHash("sha256").update(JSON.stringify([
    routeKey, conversationId, targetKey, input.expectedGeneration, binding, policy,
  ])).digest("hex");
  const existing = Object.hasOwn(state.ownerRoutes, routeKey) ? state.ownerRoutes[routeKey] : null;
  if (existing) {
    scopedRoute(existing, input);
    if (existing.targetKey !== targetKey || JSON.stringify(existing.windowTarget) !== JSON.stringify(policy.windowTarget)
      || existing.windowSelfId !== policy.windowSelfId) fail("SCOPE_MISMATCH", "已有窗口路由的实际QQ窗口不可更改");
    const receipt = existing.windowRegistrationReceipts.find((entry) => entry.dedupe_key === dedupeKey);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) fail("DEDUPE_CONFLICT", "dedupe_key已用于不同注册内容或预期代次");
      return { changed: false, value: { ...getOwnerWindowRegistration(existing, { ...input, dedupeKey }), duplicate: true } };
    }
  }
  if (input.expectedGeneration !== (existing?.windowRouteGeneration ?? 0)) fail("GENERATION_MISMATCH", "窗口路由CAS预期已变化");
  if (existing && JSON.stringify(binding) !== JSON.stringify(existing.windowBinding)
    && binding.generation <= existing.windowBinding.generation) fail("BINDING_GENERATION_MISMATCH", "模型改绑须使用更大的Core窗口CAS代次");
  for (const candidate of Object.values(state.ownerRoutes)) {
    if (candidate.routeKey !== routeKey && candidate.windowCapture === true && candidate.status === "open"
      && candidate.windowSelfId === policy.windowSelfId && candidate.windowTarget.type === policy.windowTarget.type
      && candidate.windowTarget.id === policy.windowTarget.id) fail("ROUTE_CONFLICT", "此QQ窗口已有唯一打开的window路由");
  }
  const reopening = !existing || existing.status !== "open";
  if (reopening && (!Array.isArray(input.baselineMessageKeys) || input.baselineMessageKeys.length > 50)) {
    fail("BASELINE_REQUIRED", "首次打开或重开必须先取得最近50条历史基线");
  }
  const unchanged = !reopening && JSON.stringify(binding) === JSON.stringify(existing.windowBinding)
    && JSON.stringify(policy.windowOwnerSenderAllowlist) === JSON.stringify(existing.windowOwnerSenderAllowlist);
  const generation = unchanged ? existing.windowRouteGeneration : nextGeneration(existing?.windowRouteGeneration ?? 0);
  const route = {
    ...(existing ?? {}), routeKey, conversationId, taskId: null, targetKey, status: "open",
    openedAt: reopening ? now : existing.openedAt, closedAt: null,
    lastInboundMessageSeq: existing?.lastInboundMessageSeq ?? 0,
    baselineMessageKeys: reopening ? [...new Set(input.baselineMessageKeys.map((key) => text(key, "baselineMessageKeys", 512)))] : existing.baselineMessageKeys,
    baselineInitialized: true, bufferedOwnerMessages: [], replyDelivery: "events_only", windowCapture: true,
    windowRouteGeneration: generation, windowBinding: binding, ...policy,
    ownerWindowEventCounter: existing?.ownerWindowEventCounter ?? 0,
    ownerWindowEvictedThrough: existing?.ownerWindowEvictedThrough ?? 0,
    ownerWindowEvents: existing?.ownerWindowEvents ?? [],
    windowSeenMessageKeys: existing?.windowSeenMessageKeys ?? [],
    windowRegistrationReceipts: [...(existing?.windowRegistrationReceipts ?? []), {
      dedupe_key: dedupeKey, fingerprint, expected_generation: input.expectedGeneration, applied_generation: generation,
    }].slice(-OWNER_WINDOW_EVENT_LIMITS.registrationReceipts),
  };
  validateOwnerWindowRoute(route);
  state.ownerRoutes[routeKey] = route;
  return { changed: true, value: { ...getOwnerWindowRegistration(route, { ...input, dedupeKey }), duplicate: false } };
}

export function applyOwnerWindowClose(route, input, now) {
  scopedRoute(route, input);
  if (!integer(input.expectedGeneration, 1) || input.expectedGeneration !== route.windowRouteGeneration) {
    fail("GENERATION_MISMATCH", "关闭窗口路由的CAS预期已变化");
  }
  if (route.status === "closed") return { changed: false, value: { ok: true, route: publicOwnerWindowRoute(route) } };
  if (Date.parse(now) < Date.parse(route.openedAt)) fail("INVALID_ARGUMENT", "窗口关闭时间不能早于打开时间");
  route.windowRouteGeneration = nextGeneration(route.windowRouteGeneration);
  route.status = "closed";
  route.closedAt = now;
  return { changed: true, value: { ok: true, route: publicOwnerWindowRoute(route) } };
}

export function appendOwnerWindowEvent(state, route, input, maxEvents) {
  scopedRoute(route, input, true);
  if (route.windowRouteGeneration !== input.expectedGeneration) fail("GENERATION_MISMATCH", "采集期间窗口路由代次已变化");
  const senderId = nativeWindowId(input.senderId);
  if (!senderId || !route.windowOwnerSenderAllowlist.includes(senderId)
    || (route.windowTarget.type === "group" && (!Array.isArray(input.mentionedUserIds) || !input.mentionedUserIds.includes(route.windowSelfId)))) {
    fail("SENDER_MISMATCH", "窗口消息没有满足本人sender与本机mention条件");
  }
  if (input.quotedMessageId && Object.hasOwn(state.ownerAlertMessages, String(input.quotedMessageId))) {
    return { changed: false, value: { captured: false, reason: "quoted_alert_priority" } };
  }
  const legacyKey = text(input.messageKey, "messageKey", 512);
  const messageId = nativeWindowId(input.messageId, true);
  const nativeKey = `owner-window:${route.windowSelfId}:${route.windowTarget.type}:${route.windowTarget.id}:${messageId ?? legacyKey}`;
  const eventId = createHash("sha256").update(nativeKey).digest("hex");
  if (route.baselineMessageKeys.includes(legacyKey) || state.seenControlMessages.includes(legacyKey)
    || state.seenControlMessages.includes(nativeKey) || route.windowSeenMessageKeys.includes(nativeKey)
    || route.ownerWindowEvents.some((event) => event.event_id === eventId)) {
    return { changed: false, value: { captured: false, reason: "baseline_or_duplicate" } };
  }
  const event = {
    event_id: eventId, sequence: nextGeneration(route.ownerWindowEventCounter),
    route_key: route.routeKey, conversation_id: route.conversationId, target_key: route.targetKey,
    route_generation: route.windowRouteGeneration, window_binding: copy(route.windowBinding),
    window: { channel: "qq", type: route.windowTarget.type, id: route.windowTarget.id, self_id: route.windowSelfId },
    owner_sender_allowlist: route.windowOwnerSenderAllowlist.slice(),
  };
  if (typeof input.nativeContent?.unavailable === "string") event.unavailable = input.nativeContent.unavailable;
  else if (!messageId || !integer(input.messageSeq) || typeof input.nativeContent?.text !== "string") event.unavailable = "native_fields_missing";
  else if (Buffer.byteLength(input.nativeContent.text, "utf8") > OWNER_WINDOW_EVENT_LIMITS.cacheBytes) event.unavailable = "content_exceeds_retention";
  else Object.assign(event, { message_id: messageId, message_seq: input.messageSeq, sender_id: senderId, text: input.nativeContent.text });
  if (Buffer.byteLength(JSON.stringify(event), "utf8") + 2 > OWNER_WINDOW_EVENT_LIMITS.cacheBytes) {
    delete event.text;
    event.unavailable = "content_exceeds_retention";
  }
  route.ownerWindowEventCounter = event.sequence;
  route.ownerWindowEvents.push(event);
  let bytes = Buffer.byteLength(JSON.stringify(route.ownerWindowEvents), "utf8");
  while (route.ownerWindowEvents.length > maxEvents || bytes > OWNER_WINDOW_EVENT_LIMITS.cacheBytes) {
    route.ownerWindowEvictedThrough = route.ownerWindowEvents.shift().sequence;
    bytes = Buffer.byteLength(JSON.stringify(route.ownerWindowEvents), "utf8");
  }
  if (integer(input.messageSeq)) route.lastInboundMessageSeq = input.messageSeq;
  route.windowSeenMessageKeys.push(nativeKey);
  if (route.windowSeenMessageKeys.length > 50) route.windowSeenMessageKeys.splice(0, route.windowSeenMessageKeys.length - 50);
  state.seenControlMessages.push(nativeKey);
  if (state.seenControlMessages.length > maxEvents) state.seenControlMessages.splice(0, state.seenControlMessages.length - maxEvents);
  return { changed: true, value: { captured: true, event_id: eventId, route_generation: event.route_generation } };
}

export function readOwnerWindowEventsPage(route, input) {
  scopedRoute(route, input, true);
  if (!integer(input.expectedGeneration, 1) || input.expectedGeneration !== route.windowRouteGeneration) {
    fail("GENERATION_MISMATCH", "读取窗口路由的预期代次已变化");
  }
  const limit = input.limit ?? OWNER_WINDOW_EVENT_LIMITS.pageSize;
  if (!integer(limit, 1) || limit > OWNER_WINDOW_EVENT_LIMITS.pageSize) fail("INVALID_ARGUMENT", "limit须为1至50的整数");
  const scope = [1, route.routeKey, route.conversationId, route.targetKey, route.windowRouteGeneration];
  let start = 0;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.cursor)
      || input.cursor.length > OWNER_WINDOW_EVENT_LIMITS.cursorBytes) fail("CURSOR_INVALID", "窗口事件游标无效");
    let cursor;
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { fail("CURSOR_INVALID", "窗口事件游标无法解析"); }
    if (!Array.isArray(cursor) || cursor.length !== 7 || JSON.stringify(cursor.slice(0, 5)) !== JSON.stringify(scope)) {
      fail("CURSOR_SCOPE_MISMATCH", "窗口事件游标属于其它路由、组件或代次");
    }
    const previous = route.ownerWindowEvents.findIndex((event) => event.sequence === cursor[5] && event.event_id === cursor[6]);
    if (previous < 0) fail("CURSOR_EXPIRED", "窗口游标锚点已不在保留范围", { evicted_through: route.ownerWindowEvictedThrough });
    start = previous + 1;
  } else if (route.ownerWindowEvictedThrough > 0) {
    fail("HISTORY_EXPIRED", "窗口事件保留已出现缺口", { evicted_through: route.ownerWindowEvictedThrough });
  }
  const selected = route.ownerWindowEvents.slice(start, start + limit);
  if (selected.some((event) => event.unavailable)) fail("CONTENT_UNAVAILABLE", "此页存在未完整保留的原生窗口消息", {
    events: selected.filter((event) => event.unavailable).map((event) => ({ event_id: event.event_id, reason: event.unavailable })),
  });
  const last = selected.at(-1);
  return {
    ok: true, route: publicOwnerWindowRoute(route),
    events: selected.map((event) => {
      const { sequence, ...native } = copy(event);
      return { ...native, content: native.text, source_kind: "human_message" };
    }),
    next_cursor: last ? Buffer.from(JSON.stringify([...scope, last.sequence, last.event_id])).toString("base64url") : input.cursor ?? null,
    partial: start + selected.length < route.ownerWindowEvents.length,
    retention: {
      first_sequence: route.ownerWindowEvents[0]?.sequence ?? null, last_sequence: route.ownerWindowEventCounter,
      evicted_through: route.ownerWindowEvictedThrough, retained_count: route.ownerWindowEvents.length,
      cache_bytes: Buffer.byteLength(JSON.stringify(route.ownerWindowEvents), "utf8"), max_cache_bytes: OWNER_WINDOW_EVENT_LIMITS.cacheBytes,
    },
    source: { mode: "recent_history", max_messages_per_poll: 50, continuity: "not_guaranteed" },
  };
}
