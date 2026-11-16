import { CoreError } from "./contracts.mjs";

const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 200
  && !/[^a-zA-Z0-9_.:-]/.test(value);
const routeIdentifier = value => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const nativeId = value => typeof value === "string" && value.trim() === value && /^-?[1-9]\d{0,19}$/.test(value);
const onlyKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));

export function normalizeCodexRelay(value) {
  if (!onlyKeys(value, ["host", "conversation_id"]) || value.host !== "codex" || !identifier(value.conversation_id)) {
    throw new CoreError("invalid_config", "Codex本人来源需要固定且准确的核心relay身份");
  }
  return { host: "codex", conversation_id: value.conversation_id };
}

export function normalizeCodexHumanSource(input) {
  if (input?.origin?.channel === "napcat_owner_window") return normalizeCodexWindowHumanSource(input);
  const origin = input?.origin;
  const relay = input?.relay;
  const forward = input?.forward_of;
  const native = forward?.native_source;
  const route = native?.route;
  const event = native?.event;
  if (input.window_source !== undefined || !onlyKeys(origin, ["kind", "channel", "source_ref"]) || origin.kind !== "human_message"
    || origin.channel !== "napcat_owner_reply" || typeof origin.source_ref !== "string"
    || !onlyKeys(relay, ["host", "conversation_id"]) || relay.host !== "codex" || !identifier(relay.conversation_id)
    || !identifier(input.in_reply_to) || !onlyKeys(forward, ["message_id", "delivery_id", "native_source"])
    || forward.message_id !== input.in_reply_to || !identifier(forward.delivery_id)
    || !onlyKeys(native, ["provider", "route", "original_qq_message_id", "event"]) || native.provider !== "napcat_owner"
    || !onlyKeys(route, ["route_key", "conversation_id", "target_key", "generation"])
    || !routeIdentifier(route.route_key) || !routeIdentifier(route.target_key)
    || !Number.isSafeInteger(route.generation) || route.generation < 1 || route.conversation_id !== relay.conversation_id
    || !nativeId(native.original_qq_message_id)
    || !onlyKeys(event, ["event_id", "message_id", "message_seq", "quoted_message_id", "sender_id"])
    || typeof event.event_id !== "string" || event.event_id.length !== 64 || !/^[0-9a-f]{64}$/.test(event.event_id)
    || origin.source_ref !== `owner-event:${event.event_id}`
    || !nativeId(event.message_id) || !nativeId(event.sender_id)
    || event.quoted_message_id !== native.original_qq_message_id
    || !Number.isSafeInteger(event.message_seq) || event.message_seq < 0) {
    throw new CoreError("codex_invalid_human_source", "Codex本人来源缺少准确且有限的原消息身份");
  }
  return {
    origin: { kind: origin.kind, channel: origin.channel, source_ref: origin.source_ref },
    relay: { host: relay.host, conversation_id: relay.conversation_id },
    in_reply_to: input.in_reply_to,
    forward_of: {
      message_id: forward.message_id, delivery_id: forward.delivery_id,
      native_source: {
        provider: native.provider,
        route: { route_key: route.route_key, conversation_id: route.conversation_id, target_key: route.target_key, generation: route.generation },
        original_qq_message_id: native.original_qq_message_id,
        event: { event_id: event.event_id, message_id: event.message_id, message_seq: event.message_seq,
          quoted_message_id: event.quoted_message_id, sender_id: event.sender_id },
      },
    },
  };
}

export function normalizeCodexWindowHumanSource(input) {
  const fail = () => { throw new CoreError("codex_invalid_human_source", "Codex窗口本人来源缺少准确的原生窗口与事件身份"); };
  const origin = input?.origin;
  const relay = input?.relay;
  const native = input?.window_source;
  const route = native?.route;
  const window = native?.window;
  const binding = native?.window_binding;
  const target = binding?.target;
  const event = native?.event;
  const positiveId = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
  const identityText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  if (!onlyKeys(origin, ["kind", "channel", "source_ref"]) || origin.kind !== "human_message" || origin.channel !== "napcat_owner_window"
    || !onlyKeys(relay, ["host", "conversation_id"]) || relay.host !== "codex" || !identifier(relay.conversation_id)
    || input.in_reply_to !== undefined || input.forward_of !== undefined
    || !onlyKeys(native, ["provider", "route", "window", "window_binding", "owner_sender_allowlist", "event"]) || native.provider !== "napcat_owner_window"
    || !onlyKeys(route, ["route_key", "conversation_id", "target_key", "generation"])
    || !routeIdentifier(route.route_key) || !routeIdentifier(route.target_key) || route.conversation_id !== relay.conversation_id
    || !Number.isSafeInteger(route.generation) || route.generation < 1
    || !onlyKeys(window, ["channel", "type", "id", "self_id"]) || window.channel !== "qq"
    || !["private", "group"].includes(window.type) || !positiveId(window.id) || !positiveId(window.self_id)
    || !onlyKeys(binding, ["generation", "owner_key", "target"]) || !Number.isSafeInteger(binding.generation) || binding.generation < 1
    || !onlyKeys(target, ["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation"])
    || !identityText(target.machine_id, 128) || target.host !== "codex" || target.surface !== "desktop"
    || !identifier(target.conversation_id) || !identifier(target.binding_id)
    || !Number.isSafeInteger(target.binding_generation) || target.binding_generation < 1
    || binding.owner_key !== JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id])
    || !["machine_id", "host", "surface", "conversation_id"].every(field => input.target?.[field] === target[field])
    || input.binding_generation !== target.binding_generation
    || !Array.isArray(native.owner_sender_allowlist) || native.owner_sender_allowlist.length < 1 || native.owner_sender_allowlist.length > 32
    || native.owner_sender_allowlist.some(sender => !positiveId(sender)) || new Set(native.owner_sender_allowlist).size !== native.owner_sender_allowlist.length
    || !onlyKeys(event, ["event_id", "message_id", "message_seq", "sender_id", "text", "content"])
    || typeof event.event_id !== "string" || !/^[0-9a-f]{64}$/.test(event.event_id)
    || origin.source_ref !== `owner-window-event:${event.event_id}`
    || !nativeId(event.message_id) || !positiveId(event.sender_id) || !native.owner_sender_allowlist.includes(event.sender_id)
    || !Number.isSafeInteger(event.message_seq) || event.message_seq < 0
    || window.type === "private" && event.sender_id !== window.id
    || typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 262144
    || event.text !== input.text || event.content !== input.text) fail();
  return {
    origin: { kind: origin.kind, channel: origin.channel, source_ref: origin.source_ref },
    relay: { host: relay.host, conversation_id: relay.conversation_id },
    window_source: {
      provider: native.provider,
      route: { route_key: route.route_key, conversation_id: route.conversation_id, target_key: route.target_key, generation: route.generation },
      window: { channel: window.channel, type: window.type, id: window.id, self_id: window.self_id },
      window_binding: { generation: binding.generation, owner_key: binding.owner_key, target: { ...target } },
      owner_sender_allowlist: [...native.owner_sender_allowlist],
      event: { event_id: event.event_id, message_id: event.message_id, message_seq: event.message_seq, sender_id: event.sender_id, text: event.text, content: event.content },
    },
  };
}
