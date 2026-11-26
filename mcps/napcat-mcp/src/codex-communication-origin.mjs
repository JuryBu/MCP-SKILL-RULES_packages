export const HUMAN_SOURCE_KEYS = ["relay", "in_reply_to", "forward_of", "window_source"];

const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
const nativeRouteIdentifier = value => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const nativeId = value => typeof value === "string" && /^-?[1-9]\d{0,19}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const generation = value => Number.isSafeInteger(value) && value > 0;
const windowId = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);

function windowSourceFrom(input) {
  const { origin, relay, window_source: source } = input;
  const route = source?.route;
  const window = source?.window;
  const binding = source?.window_binding;
  const target = binding?.target;
  const event = source?.event;
  const allowlist = source?.owner_sender_allowlist;
  if (!onlyKeys(origin, ["kind", "channel", "source_ref"]) || origin.kind !== "human_message"
    || origin.channel !== "napcat_owner_window"
    || !onlyKeys(relay, ["host", "conversation_id"]) || relay.host !== "codex" || !identifier(relay.conversation_id)
    || Object.hasOwn(input, "in_reply_to") || Object.hasOwn(input, "forward_of")
    || !onlyKeys(source, ["provider", "route", "window", "window_binding", "owner_sender_allowlist", "event"])
    || source.provider !== "napcat_owner_window"
    || !onlyKeys(route, ["route_key", "conversation_id", "target_key", "generation"])
    || !nativeRouteIdentifier(route.route_key) || !nativeRouteIdentifier(route.target_key) || route.target_key.length > 64
    || route.conversation_id !== relay.conversation_id || !generation(route.generation)
    || !onlyKeys(window, ["channel", "type", "id", "self_id"]) || window.channel !== "qq"
    || !["private", "group"].includes(window.type) || !windowId(window.id) || !windowId(window.self_id)
    || !onlyKeys(binding, ["generation", "owner_key", "target"]) || !generation(binding.generation)
    || !onlyKeys(target, ["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation"])
    || !identifier(target.machine_id) || target.host !== "codex" || !identifier(target.surface) || !identifier(target.conversation_id)
    || !nativeRouteIdentifier(target.binding_id) || target.binding_id.length > 128 || !generation(target.binding_generation)
    || binding.owner_key !== JSON.stringify([target.machine_id, target.host, target.surface, target.conversation_id])
    || target.binding_generation !== input.binding_generation
    || !onlyKeys(input.target, ["machine_id", "host", "surface", "conversation_id"])
    || input.target.host !== target.host || input.target.conversation_id !== target.conversation_id
    || ((Object.hasOwn(input.target, "machine_id") || Object.hasOwn(input.target, "surface"))
      && (input.target.machine_id !== target.machine_id || input.target.surface !== target.surface))
    || !Array.isArray(allowlist) || !allowlist.length || allowlist.length > 128
    || allowlist.some(sender => !windowId(sender)) || new Set(allowlist).size !== allowlist.length
    || (window.type === "private" && (allowlist.length !== 1 || allowlist[0] !== window.id))
    || !onlyKeys(event, ["event_id", "message_id", "message_seq", "sender_id", "text", "content"])
    || typeof event.event_id !== "string" || !/^[0-9a-f]{64}$/.test(event.event_id)
    || origin.source_ref !== `owner-window-event:${event.event_id}`
    || !nativeId(event.message_id) || !windowId(event.sender_id) || event.sender_id === window.self_id
    || !allowlist.includes(event.sender_id) || (window.type === "private" && event.sender_id !== window.id)
    || !Number.isSafeInteger(event.message_seq) || event.message_seq < 0
    || typeof input.text !== "string" || !input.text.length || Buffer.byteLength(input.text, "utf8") > 256 * 1024
    || event.text !== input.text || event.content !== input.text) {
    throw Object.assign(new TypeError("Invalid finite QQ owner window source"), { code: "INVALID_HUMAN_SOURCE" });
  }
  return {
    origin: { kind: origin.kind, channel: origin.channel, source_ref: origin.source_ref },
    relay: { host: relay.host, conversation_id: relay.conversation_id },
    window_source: {
      provider: source.provider,
      route: { route_key: route.route_key, conversation_id: route.conversation_id, target_key: route.target_key, generation: route.generation },
      window: { channel: window.channel, type: window.type, id: window.id, self_id: window.self_id },
      window_binding: { generation: binding.generation, owner_key: binding.owner_key,
        target: { machine_id: target.machine_id, host: target.host, surface: target.surface,
          conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation } },
      owner_sender_allowlist: allowlist.slice(),
      event: { event_id: event.event_id, message_id: event.message_id, message_seq: event.message_seq,
        sender_id: event.sender_id, text: event.text, content: event.content },
    },
  };
}

export function humanSourceFrom(input) {
  if (input?.origin?.channel === "napcat_owner_window") return windowSourceFrom(input);
  const origin = input?.origin;
  const relay = input?.relay;
  const forward = input?.forward_of;
  const native = forward?.native_source;
  const route = native?.route;
  const event = native?.event;
  if (!onlyKeys(origin, ["kind", "channel", "source_ref"]) || origin.kind !== "human_message"
    || origin.channel !== "napcat_owner_reply" || typeof origin.source_ref !== "string" || Object.hasOwn(input, "window_source")
    || !onlyKeys(relay, ["host", "conversation_id"]) || relay.host !== "codex" || !identifier(relay.conversation_id)
    || !identifier(input.in_reply_to) || !onlyKeys(forward, ["message_id", "delivery_id", "native_source"])
    || forward.message_id !== input.in_reply_to || !identifier(forward.delivery_id)
    || !onlyKeys(native, ["provider", "route", "original_qq_message_id", "event"]) || native.provider !== "napcat_owner"
    || !onlyKeys(route, ["route_key", "conversation_id", "target_key", "generation"])
    || !nativeRouteIdentifier(route.route_key) || !nativeRouteIdentifier(route.target_key) || !generation(route.generation)
    || route.conversation_id !== relay.conversation_id
    || !nativeId(native.original_qq_message_id)
    || !onlyKeys(event, ["event_id", "message_id", "message_seq", "quoted_message_id", "sender_id"])
    || typeof event.event_id !== "string" || !/^[0-9a-f]{64}$/.test(event.event_id)
    || origin.source_ref !== `owner-event:${event.event_id}`
    || !nativeId(event.message_id) || !nativeId(event.sender_id)
    || event.quoted_message_id !== native.original_qq_message_id
    || !Number.isSafeInteger(event.message_seq) || event.message_seq < 0) {
    throw Object.assign(new TypeError("Invalid finite QQ owner reply source"), { code: "INVALID_HUMAN_SOURCE" });
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
