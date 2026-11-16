import { types } from "node:util";
import { CoreError, identityKey } from "./contracts.mjs";

const TARGET_FIELDS = ["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation"];
const WINDOW_FIELDS = ["channel", "type", "id", "self_id"];
const EVENT_FIELDS = ["event_id", "message_id", "message_seq", "sender_id", "text", "content", "source_kind",
  "route_key", "conversation_id", "target_key", "route_generation", "window", "window_binding", "owner_sender_allowlist"];
const LIMITS = Object.freeze({ textBytes: 1024 * 1024, ownerSenders: 32 });

function invalid() {
  return new CoreError("owner_window_event_invalid", "QQ窗口原生事件校验失败");
}

function dataObject(value, allowed) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const captured = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")) throw invalid();
    captured[key] = descriptor.value;
  }
  return captured;
}

function identifier(value, maximum) {
  if (typeof value !== "string" || !value || value.trim() !== value || value === "*"
    || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, "utf8") > maximum) throw invalid();
  return value;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

function nativeId(value, signed = false) {
  if (typeof value !== "string" || !(signed ? /^-?[1-9]\d{0,19}$/ : /^[1-9]\d{0,19}$/).test(value)) throw invalid();
  return value;
}

function targetIdentity(value, metadata = false) {
  const source = dataObject(value, metadata ? [...TARGET_FIELDS, "adapter_id", "capabilities", "evidence"] : TARGET_FIELDS);
  const target = {
    machine_id: identifier(source.machine_id, 128), host: identifier(source.host, 64),
    surface: identifier(source.surface, 64), conversation_id: identifier(source.conversation_id, 256),
    binding_id: identifier(source.binding_id, 128), binding_generation: generation(source.binding_generation),
  };
  if (Object.hasOwn(source, "adapter_id")) target.adapter_id = identifier(source.adapter_id, 128);
  if (Object.hasOwn(source, "evidence")) target.evidence = identifier(source.evidence, 256);
  if (Object.hasOwn(source, "capabilities")) {
    const capabilities = dataObject(source.capabilities, ["next_model_boundary", "when_idle"]);
    if (Object.values(capabilities).some(value => typeof value !== "boolean")) throw invalid();
    target.capabilities = capabilities;
  }
  return target;
}

function windowIdentity(value) {
  const window = dataObject(value, WINDOW_FIELDS);
  if (window.channel !== "qq" || !["private", "group"].includes(window.type)) throw invalid();
  return { channel: "qq", type: window.type, id: nativeId(window.id), self_id: nativeId(window.self_id) };
}

function owners(value) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > LIMITS.ownerSenders || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid();
    result.push(nativeId(descriptor.value));
  }
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}

function freeze(value) {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function normalizeOwnerWindowBinding(value) {
  try {
    const binding = dataObject(value, ["generation", "owner_key", "target"]);
    const target = targetIdentity(binding.target);
    if (binding.owner_key !== identityKey(target)) throw invalid();
    return freeze({ generation: generation(binding.generation), owner_key: binding.owner_key, target });
  } catch {
    throw invalid();
  }
}

export function normalizeOwnerWindowEvent(value, input) {
  try {
    const options = dataObject(input, ["routeKey", "conversationId", "targetKey", "window", "ownerSenderAllowlist", "sourceTarget"]);
    const routeKey = identifier(options.routeKey, 256);
    const conversationId = identifier(options.conversationId, 256);
    const targetKey = identifier(options.targetKey, 64);
    const expectedWindow = windowIdentity(options.window);
    const sourceTarget = targetIdentity(options.sourceTarget, true);
    if (sourceTarget.host !== "qq" || sourceTarget.conversation_id !== targetKey
      || sourceTarget.surface !== expectedWindow.type) throw invalid();
    const allowed = owners(options.ownerSenderAllowlist);
    const event = dataObject(value, EVENT_FIELDS);
    if (event.route_key !== routeKey || event.conversation_id !== conversationId || event.target_key !== targetKey
      || event.source_kind !== "human_message" || typeof event.event_id !== "string" || !/^[a-f0-9]{64}$/.test(event.event_id)) throw invalid();
    const window = windowIdentity(event.window);
    if (WINDOW_FIELDS.some(field => window[field] !== expectedWindow[field])) throw invalid();
    const routeGeneration = generation(event.route_generation);
    const windowBinding = normalizeOwnerWindowBinding(event.window_binding);
    const messageId = nativeId(event.message_id, true);
    const senderId = nativeId(event.sender_id);
    if (!Number.isSafeInteger(event.message_seq) || event.message_seq < 0 || typeof event.text !== "string"
      || event.content !== event.text || Buffer.byteLength(event.text, "utf8") > LIMITS.textBytes) throw invalid();
    const nativeOwners = owners(event.owner_sender_allowlist);
    if (!allowed.includes(senderId) || !nativeOwners.includes(senderId) || nativeOwners.some(sender => !allowed.includes(sender))
      || senderId === window.self_id || (window.type === "private" && (senderId !== window.id
        || nativeOwners.length !== 1 || nativeOwners[0] !== window.id))) throw invalid();
    return freeze({
      native_event_id: event.event_id, route_generation: routeGeneration, text: event.text,
      source_target: sourceTarget, target: windowBinding.target,
      native_source: {
        provider: "napcat_owner_window",
        route: { route_key: routeKey, conversation_id: conversationId, target_key: targetKey, generation: routeGeneration },
        window, window_binding: windowBinding, owner_sender_allowlist: nativeOwners,
        event: { event_id: event.event_id, message_id: messageId, message_seq: event.message_seq,
          sender_id: senderId, text: event.text, content: event.content },
      },
    });
  } catch {
    throw invalid();
  }
}
