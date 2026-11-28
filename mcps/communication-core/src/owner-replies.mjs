import { identityKey } from "./contracts.mjs";

export const OWNER_REPLY_LIMITS = Object.freeze({
  pages: 4,
  events: 100,
  textBytes: 16384,
  totalTextBytes: 65536,
  cursorBytes: 4096,
  ownerSenders: 32,
});

const CANCELLED = Symbol("cancelled");

function unsupported(reason) {
  return { status: "unsupported", reason, reply: null };
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identifier(value, maximum = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
    && Buffer.byteLength(value, "utf8") <= maximum;
}

function messageId(value) {
  return typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value);
}

function generation(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function captureBinding(value) {
  if (!record(value) || !identifier(value.delivery_id) || !identifier(value.message_id)) return null;
  const route = value.route;
  if (!record(route) || !identifier(route.route_key) || !identifier(route.conversation_id)
    || !identifier(route.target_key) || !generation(route.generation)) return null;
  return Object.freeze({
    delivery_id: value.delivery_id,
    message_id: value.message_id,
    route: Object.freeze({
      route_key: route.route_key,
      conversation_id: route.conversation_id,
      target_key: route.target_key,
      generation: route.generation,
    }),
  });
}

function sameRoute(actual, expected) {
  return record(actual) && actual.route_key === expected.route_key
    && actual.conversation_id === expected.conversation_id && actual.target_key === expected.target_key
    && actual.generation === expected.generation;
}

function originalScope(input, binding) {
  try {
    const { message, delivery, target } = input;
    const envelope = message?.envelope;
    const targetKey = identityKey(target);
    const matchesTarget = value => identityKey(value) === targetKey
      && value.binding_id === target.binding_id && value.binding_generation === target.binding_generation;
    if (target.host !== "qq" || !identifier(target.binding_id) || !generation(target.binding_generation)
      || !identifier(target.adapter_id) || !matchesTarget(envelope?.target) || !matchesTarget(delivery?.target_snapshot)
      || delivery.target_snapshot.adapter_id !== target.adapter_id
      || message.message_id !== binding.message_id || delivery.message_id !== binding.message_id
      || delivery.delivery_id !== binding.delivery_id || message.target_key !== targetKey || delivery.target_key !== targetKey
      || message.source_key !== identityKey(envelope.caller)
      || target.conversation_id !== binding.route.target_key) return null;
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
    if ((!fullyAccepted && !partialUnknown) || accepted.delivery_id !== delivery.delivery_id || accepted.target_key !== targetKey
      || evidence?.kind !== "receipt" || receipt?.provider !== "napcat_owner" || receipt.verified !== true
      || receipt.state_persisted !== true || !messageId(receipt.message_id)) return null;
    if (!sameRoute(receipt.reply_route, binding.route)) return null;
    return {
      originalId: receipt.message_id,
      fingerprint: JSON.stringify([
        message.message_id, message.source_key, delivery.delivery_id, targetKey,
        target.binding_id, target.binding_generation, target.adapter_id, receipt.message_id, receipt.reply_route,
      ]),
    };
  } catch {
    return null;
  }
}

async function callPage(readPage, parameters, context) {
  const { signal } = context;
  if (!signal) return readPage(parameters, context);
  if (signal.aborted) return CANCELLED;
  let onAbort;
  const interrupted = new Promise(resolve => {
    onAbort = () => resolve(CANCELLED);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const pending = Promise.resolve().then(() => signal.aborted ? CANCELLED : readPage(parameters, context));
  try {
    return await Promise.race([pending, interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function nativeReply(event, binding, originalId) {
  return {
    native_message_id: event.message_id,
    native_conversation_id: binding.route.target_key,
    source_step_index: event.message_seq,
    text: event.text,
    native_source: {
      provider: "napcat_owner",
      route: { ...binding.route },
      original_qq_message_id: originalId,
      event: {
        event_id: event.event_id,
        message_id: event.message_id,
        message_seq: event.message_seq,
        quoted_message_id: event.quoted_message_id,
        sender_id: event.sender_id,
      },
    },
  };
}

export function createOwnerReplyReader(options = {}) {
  let enabled = false;
  let readPage;
  let capturedBinding = null;
  let callerConversationId = null;
  let owners = null;
  let setupFailed = false;
  try {
    enabled = options?.enabled === true;
    if (enabled) {
      readPage = options.readPage;
      capturedBinding = captureBinding(options.binding);
      callerConversationId = options.callerConversationId;
      const allowlist = options.ownerSenderAllowlist;
      if (Array.isArray(allowlist) && allowlist.length <= OWNER_REPLY_LIMITS.ownerSenders) {
        const senders = Array.from(allowlist);
        if (senders.length > 0 && senders.length <= OWNER_REPLY_LIMITS.ownerSenders
          && senders.every(sender => typeof sender === "string" && /^[1-9]\d{0,19}$/.test(sender))) owners = new Set(senders);
      }
    }
  } catch {
    setupFailed = true;
  }

  return async function readOwnerReply(input) {
    if (setupFailed) return unsupported("invalid_setup");
    if (enabled !== true) return unsupported("disabled");
    if (!owners) return unsupported("owner_allowlist_required");
    if (typeof readPage !== "function") return unsupported("read_page_unavailable");
    if (!capturedBinding) return unsupported("original_binding_required");
    if (!identifier(callerConversationId) || callerConversationId !== capturedBinding.route.conversation_id) return unsupported("original_delivery_unverified");
    try {
      if (!record(input) || Object.hasOwn(input, "cursor")) return unsupported("invalid_input");
      const signal = input.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) return unsupported("invalid_signal");
      if (signal?.aborted) return unsupported("cancelled");
      const original = originalScope(input, capturedBinding);
      if (!original) return unsupported("original_delivery_unverified");
      const context = Object.freeze({
        conversationId: capturedBinding.route.conversation_id,
        targetKey: capturedBinding.route.target_key,
        signal,
      });
      const cursors = new Set();
      const eventIds = new Set();
      const messageIds = new Set();
      const sequences = new Set();
      let cursor;
      let selected = null;
      let textBytes = 0;
      for (let pageIndex = 0; pageIndex < OWNER_REPLY_LIMITS.pages; pageIndex += 1) {
        if (signal?.aborted) return unsupported("cancelled");
        if (originalScope(input, capturedBinding)?.fingerprint !== original.fingerprint) return unsupported("original_scope_changed");
        const parameters = Object.freeze({
          route_key: capturedBinding.route.route_key,
          original_qq_message_id: original.originalId,
          expected_route_generation: capturedBinding.route.generation,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const page = await callPage(readPage, parameters, context);
        if (page === CANCELLED || signal?.aborted) return unsupported("cancelled");
        if (originalScope(input, capturedBinding)?.fingerprint !== original.fingerprint) return unsupported("original_scope_changed");
        if (!record(page) || page.ok !== true || !sameRoute(page.route, capturedBinding.route)
          || page.original_qq_message_id !== original.originalId) return unsupported("page_scope_mismatch");
        if (!Array.isArray(page.events) || typeof page.partial !== "boolean"
          || (page.partial ? !identifier(page.next_cursor, OWNER_REPLY_LIMITS.cursorBytes) : page.next_cursor !== null)) {
          return unsupported("incomplete_page");
        }
        if (page.events.length > OWNER_REPLY_LIMITS.events - eventIds.size) return unsupported("event_limit");
        for (const event of page.events) {
          if (signal?.aborted) return unsupported("cancelled");
          if (!record(event) || !identifier(event.event_id) || !messageId(event.message_id)
            || !Number.isSafeInteger(event.message_seq) || event.message_seq < 0
            || event.quoted_message_id !== original.originalId || typeof event.sender_id !== "string" || !/^[1-9]\d{0,19}$/.test(event.sender_id)
            || typeof event.text !== "string") return unsupported("event_unverified");
          if (eventIds.has(event.event_id) || messageIds.has(event.message_id) || sequences.has(event.message_seq)) {
            return unsupported("duplicate_event");
          }
          if (event.text.length > OWNER_REPLY_LIMITS.textBytes) return unsupported("text_limit");
          const bytes = Buffer.byteLength(event.text, "utf8");
          textBytes += bytes;
          if (bytes > OWNER_REPLY_LIMITS.textBytes || textBytes > OWNER_REPLY_LIMITS.totalTextBytes) return unsupported("text_limit");
          eventIds.add(event.event_id);
          messageIds.add(event.message_id);
          sequences.add(event.message_seq);
          if (owners.has(event.sender_id) && event.text.trim() && !selected) {
            selected = {
              event_id: event.event_id,
              message_id: event.message_id,
              message_seq: event.message_seq,
              quoted_message_id: event.quoted_message_id,
              sender_id: event.sender_id,
              text: event.text,
            };
          }
        }
        if (signal?.aborted) return unsupported("cancelled");
        if (originalScope(input, capturedBinding)?.fingerprint !== original.fingerprint) return unsupported("original_scope_changed");
        if (!page.partial) return selected ? nativeReply(selected, capturedBinding, original.originalId) : unsupported("no_reply");
        if (cursors.has(page.next_cursor)) return unsupported("cursor_cycle");
        cursor = page.next_cursor;
        cursors.add(cursor);
      }
      return unsupported("page_limit");
    } catch {
      return unsupported("read_failed");
    }
  };
}
