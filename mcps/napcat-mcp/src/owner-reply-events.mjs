import { createHash } from "node:crypto";

export const OWNER_REPLY_EVENT_LIMITS = Object.freeze({ cacheBytes: 1024 * 1024, pageSize: 50, cursorBytes: 4096 });

export class OwnerReplyEventsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OwnerReplyEventsError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OwnerReplyEventsError(code, message);
}

function identifier(value, name) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 256
    || /[\u0000-\u001f\u007f]/.test(value)) fail("OWNER_EVENTS_INVALID_ARGUMENT", `${name} 无效`);
  return value;
}

function nativeId(value) {
  return typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value);
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function captureEnabled(route) {
  return Number.isSafeInteger(route?.ownerEventGeneration) && route.ownerEventGeneration > 0;
}

export function ownerEventRouteFields(route, reset = false) {
  if (route?.ownerEventGeneration === undefined) return {};
  if (!captureEnabled(route) || !validCounter(route.ownerReplyEventCounter)
    || !validCounter(route.ownerReplyEvictedThrough) || route.ownerReplyEvictedThrough > route.ownerReplyEventCounter
    || !Array.isArray(route.ownerReplyEvents)) {
    fail("OWNER_EVENTS_STATE_INVALID", "引用回复事件状态无效");
  }
  let priorSequence = route.ownerReplyEvictedThrough;
  for (const event of route.ownerReplyEvents) {
    if (!event || !validCounter(event.sequence) || event.sequence <= priorSequence
      || event.sequence > route.ownerReplyEventCounter || typeof event.event_id !== "string") {
      fail("OWNER_EVENTS_STATE_INVALID", "引用回复事件的持久顺序无效");
    }
    priorSequence = event.sequence;
  }
  const generation = route.ownerEventGeneration + (reset ? 1 : 0);
  if (!Number.isSafeInteger(generation)) fail("OWNER_EVENTS_STATE_INVALID", "事件代次已超出安全范围");
  return {
    ownerEventGeneration: generation,
    ownerReplyEventCounter: reset ? 0 : route.ownerReplyEventCounter,
    ownerReplyEvictedThrough: reset ? 0 : route.ownerReplyEvictedThrough,
    ownerReplyEvents: reset ? [] : route.ownerReplyEvents.slice(),
  };
}

export function enableOwnerEventCapture(route) {
  if (route.ownerEventGeneration !== undefined) {
    ownerEventRouteFields(route);
    return false;
  }
  Object.assign(route, {
    ownerEventGeneration: 1,
    ownerReplyEventCounter: 0,
    ownerReplyEvictedThrough: 0,
    ownerReplyEvents: [],
  });
  return true;
}

export function appendOwnerReplyEvent(route, alert, input, maxEvents) {
  if (!captureEnabled(route) || alert?.ownerEventGeneration !== route.ownerEventGeneration
    || alert.conversationId !== route.conversationId || alert.targetKey !== route.targetKey) return false;
  ownerEventRouteFields(route);
  const quotedId = String(input.quotedMessageId ?? "");
  if (quotedId !== alert.messageId) return false;
  const eventId = createHash("sha256")
    .update(JSON.stringify([route.routeKey, route.ownerEventGeneration, quotedId, input.messageKey]))
    .digest("hex");
  if (route.ownerReplyEvents.some((event) => event.event_id === eventId)) return false;
  const sequence = route.ownerReplyEventCounter + 1;
  if (!Number.isSafeInteger(sequence)) fail("OWNER_EVENTS_STATE_INVALID", "事件顺序已超出安全范围");
  const event = { event_id: eventId, sequence, quoted_message_id: quotedId };
  const messageId = typeof input.messageId === "number" && Number.isSafeInteger(input.messageId)
    ? String(input.messageId) : input.messageId;
  const senderId = typeof input.senderId === "number" && Number.isSafeInteger(input.senderId)
    ? String(input.senderId) : input.senderId;
  if (typeof input.unavailable === "string") {
    event.unavailable = input.unavailable;
  } else if (!nativeId(messageId) || !nativeId(senderId) || !validCounter(input.messageSeq) || typeof input.text !== "string") {
    event.unavailable = "native_fields_missing";
  } else if (Buffer.byteLength(input.text, "utf8") > OWNER_REPLY_EVENT_LIMITS.cacheBytes) {
    event.unavailable = "content_exceeds_retention";
  } else {
    Object.assign(event, { message_id: messageId, message_seq: input.messageSeq, sender_id: senderId, text: input.text });
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > OWNER_REPLY_EVENT_LIMITS.cacheBytes) {
      delete event.text;
      event.unavailable = "content_exceeds_retention";
    }
  }
  route.ownerReplyEventCounter = sequence;
  route.ownerReplyEvents.push(event);
  let bytes = route.ownerReplyEvents.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"), 0);
  while (route.ownerReplyEvents.length > maxEvents || bytes > OWNER_REPLY_EVENT_LIMITS.cacheBytes) {
    const removed = route.ownerReplyEvents.shift();
    bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    route.ownerReplyEvictedThrough = removed.sequence;
  }
  return true;
}

export function readOwnerReplyEventsPage(route, alert, input) {
  const routeKey = identifier(input.routeKey, "route_key");
  const conversationId = identifier(input.conversationId, "conversation_id");
  const originalId = identifier(input.originalMessageId, "original_qq_message_id");
  if (!nativeId(originalId) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
    fail("OWNER_EVENTS_INVALID_ARGUMENT", "原QQ消息ID或预期事件代次无效");
  }
  if (!route || route.routeKey !== routeKey || route.status !== "open" || route.conversationId !== conversationId) {
    fail("OWNER_EVENTS_SCOPE_MISMATCH", "路由未打开或当前对话与绑定不符");
  }
  if (!captureEnabled(route)) fail("OWNER_EVENTS_UNSUPPORTED", "本路由尚未显式启用结构化回复事件保留");
  ownerEventRouteFields(route);
  if (route.ownerEventGeneration !== input.expectedGeneration) fail("OWNER_EVENTS_GENERATION_MISMATCH", "路由事件代次已变化");
  if (!alert || alert.routeKey !== routeKey || alert.targetKey !== route.targetKey
    || alert.conversationId !== conversationId || alert.messageId !== originalId
    || alert.ownerEventGeneration !== route.ownerEventGeneration || !validCounter(alert.ownerEventStartSequence)) {
    fail("OWNER_EVENTS_ORIGINAL_MISMATCH", "原通知没有匹配当前路由、目标和事件代次的持久记录");
  }
  const binding = [1, routeKey, conversationId, route.targetKey, route.ownerEventGeneration, originalId];
  const events = route.ownerReplyEvents.filter((event) => event.quoted_message_id === originalId);
  let start = 0;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.cursor)
      || Buffer.byteLength(input.cursor, "utf8") > OWNER_REPLY_EVENT_LIMITS.cursorBytes) {
      fail("OWNER_EVENTS_CURSOR_INVALID", "事件游标无效");
    }
    let cursor;
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch {
      fail("OWNER_EVENTS_CURSOR_INVALID", "事件游标无法解析");
    }
    if (!Array.isArray(cursor) || cursor.length !== 7 || JSON.stringify(cursor.slice(0, 6)) !== JSON.stringify(binding)) {
      fail("OWNER_EVENTS_CURSOR_SCOPE_MISMATCH", "事件游标属于其它路由、原通知或代次");
    }
    const previous = events.findIndex((event) => event.event_id === cursor[6]);
    if (previous < 0) fail("OWNER_EVENTS_CURSOR_EXPIRED", "游标指向的事件已不在保留范围");
    start = previous + 1;
  } else if (route.ownerReplyEvictedThrough > alert.ownerEventStartSequence) {
    fail("OWNER_EVENTS_HISTORY_EXPIRED", "原通知之后的事件保留已出现缺口");
  }
  const limit = input.limit ?? OWNER_REPLY_EVENT_LIMITS.pageSize;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > OWNER_REPLY_EVENT_LIMITS.pageSize) {
    fail("OWNER_EVENTS_INVALID_ARGUMENT", "limit须为1至50的整数");
  }
  const selected = events.slice(start, start + limit);
  if (selected.some((event) => event.unavailable)) fail("OWNER_EVENTS_CONTENT_UNAVAILABLE", "此原通知存在未完整保留的原生回复，未确认或消费任何消息");
  if (selected.some((event) => !/^[a-f0-9]{64}$/.test(event.event_id) || !nativeId(event.message_id)
    || !nativeId(event.sender_id) || !validCounter(event.message_seq) || typeof event.text !== "string")) {
    fail("OWNER_EVENTS_STATE_INVALID", "保留的原生回复字段无效");
  }
  const partial = start + selected.length < events.length;
  return {
    ok: true,
    route: { route_key: routeKey, conversation_id: conversationId, target_key: route.targetKey, generation: route.ownerEventGeneration },
    original_qq_message_id: originalId,
    events: selected.map((event) => ({
      event_id: event.event_id,
      message_id: event.message_id,
      message_seq: event.message_seq,
      quoted_message_id: event.quoted_message_id,
      sender_id: event.sender_id,
      text: event.text,
    })),
    next_cursor: partial ? Buffer.from(JSON.stringify([...binding, selected.at(-1).event_id])).toString("base64url") : null,
    partial,
  };
}
