import { createHash, randomUUID } from "node:crypto";
import { RelayError } from "./relay-groups.mjs";

export const RELAY_FRAME_HEADER = "[COMM_RELAY_V1]";
export const RELAY_FRAME_FOOTER = "[END_COMM_RELAY_V1]";
export const ALLOWED_RELAY_OPS = Object.freeze([
  "message",
  "delivery_ack",
  "processing_ack",
  "status_query",
  "status_reply",
  "list_query",
  "list_reply",
  "snapshot_query",
  "snapshot_reply",
  "board_delta",
  "board_dissolved",
  "board_state_sync",
  "board_ack",
  "file_notice",
  "file_ack",
]);

export const RELAY_FRAME_HARD_MAX_CHARS = 1900;
export const RELAY_FRAME_DEFAULT_MAX_CHARS = 1800;
export const RELAY_FRAME_DEFAULT_MAX_RECIPIENTS = 16;
export const RELAY_FRAME_HARD_MAX_RECIPIENTS = 64;
export const DEFAULT_RELAY_SURFACE = "desktop";

const ALLOWED_OP_SET = new Set(ALLOWED_RELAY_OPS);
const TWO_SEGMENT_COMPAT_HOSTS = new Set(["antigravity", "codex", "windsurf"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const HEADER_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const BODY_FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MACHINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEGMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RELAY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const WHITESPACE_OR_COMMA_RE = /[\s,]/;
const MAX_ADDRESS_CHARS = 320;
const MAX_CONVERSATION_ID_CHARS = 256;
const MAX_DECODE_INPUT_CHARS = 65536;
const MAX_JSON_DEPTH = 16;

const ALLOWED_FRAME_HEADER_KEYS = new Set([
  "relay_id",
  "op",
  "from_machine",
  "to_machine",
  "source",
  "recipients",
  "in_reply_to",
  "body_sha256",
  "meta",
]);

const REQUIRED_FRAME_HEADER_KEYS = [
  "relay_id",
  "op",
  "from_machine",
  "to_machine",
  "source",
  "recipients",
  "body_sha256",
];

const ENCODE_INPUT_KEYS = [
  "relay_id",
  "op",
  "from_machine",
  "source_machine",
  "to_machine",
  "target_machine",
  "source",
  "recipients",
  "in_reply_to",
  "meta",
  "body",
];

const ENCODE_OPTION_KEYS = ["maxFrameChars", "maxRecipients"];
const DISCLOSURE_INPUT_KEYS = ["recipients", "all_recipients", "allow_disclose_recipients"];

function assertPlainObject(value, name, allowedKeys = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是普通对象`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是普通对象`);
  }
  const allowedSet = allowedKeys ? new Set(allowedKeys) : null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 包含非字符串属性键`);
    }
    if (FORBIDDEN_KEYS.has(key)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 禁止包含原型保留键：${key}`);
    }
    if (HEADER_CONTROL_CHAR_RE.test(key)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 包含含控制字符的属性键`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name}.${key} 必须是普通数据属性`);
    }
    if (allowedSet && !allowedSet.has(key)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 包含未允许字段：${key}`, { field: key });
    }
  }
}

function isPlainObjectSafe(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key) || HEADER_CONTROL_CHAR_RE.test(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
    if (!isJsonValueSafe(descriptor.value, depth + 1)) return false;
  }
  return true;
}

function isJsonValueSafe(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonValueSafe(item, depth + 1)) return false;
    }
    return true;
  }
  if (typeof value === "object") return isPlainObjectSafe(value, depth);
  return false;
}

function canonicalizeJsonValue(value, name = "value", depth = 0) {
  if (depth > MAX_JSON_DEPTH) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} JSON 嵌套层级超过上限 ${MAX_JSON_DEPTH}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 不能包含 NaN 或 Infinity`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => (
      item === undefined ? null : canonicalizeJsonValue(item, `${name}[${idx}]`, depth + 1)
    ));
  }
  if (typeof value === "object") {
    assertPlainObject(value, name);
    const sorted = {};
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const key of keys) {
      if (value[key] === undefined) continue;
      sorted[key] = canonicalizeJsonValue(value[key], `${name}.${key}`, depth + 1);
    }
    return sorted;
  }
  throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 包含无法稳定序列化的值类型：${typeof value}`);
}

function stableSingleLineJson(obj, name) {
  const canonical = canonicalizeJsonValue(obj, name, 0);
  return JSON.stringify(canonical)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function validateMachineId(value, name) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || HEADER_CONTROL_CHAR_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
    || !MACHINE_ID_RE.test(value)
  ) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是合法机器标识`);
  }
  return value;
}

function validateRelayId(value, name) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || HEADER_CONTROL_CHAR_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
    || !RELAY_ID_RE.test(value)
  ) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是合法中继消息编号`);
  }
  return value;
}

function parseRelayAddress(value) {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > MAX_ADDRESS_CHARS
    || HEADER_CONTROL_CHAR_RE.test(value)
    || WHITESPACE_OR_COMMA_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
  ) {
    return null;
  }
  const parts = value.split("/");
  if (parts.length !== 2 && parts.length !== 3) {
    return null;
  }
  const host = parts[0];
  if (parts.length === 2 && !TWO_SEGMENT_COMPAT_HOSTS.has(host)) {
    return null;
  }
  const surface = parts.length === 3 ? parts[1] : DEFAULT_RELAY_SURFACE;
  const conversationId = parts.length === 3 ? parts[2] : parts[1];

  if (
    !host
    || !SEGMENT_ID_RE.test(host)
    || FORBIDDEN_KEYS.has(host)
    || host === "*"
  ) {
    return null;
  }
  if (
    !surface
    || !SEGMENT_ID_RE.test(surface)
    || FORBIDDEN_KEYS.has(surface)
    || surface === "*"
  ) {
    return null;
  }
  if (
    !conversationId
    || conversationId.length > MAX_CONVERSATION_ID_CHARS
    || FORBIDDEN_KEYS.has(conversationId)
    || conversationId === "*"
  ) {
    return null;
  }
  return `${host}/${surface}/${conversationId}`;
}

export function normalizeRelayAddress(value, name = "address") {
  const normalized = parseRelayAddress(value);
  if (!normalized) {
    throw new RelayError(
      "RELAY_INVALID_ARGUMENT",
      `${name} 必须是合法规范地址 <host>/<surface>/<conversation_id>（2 段仅限 antigravity/codex/windsurf）`,
    );
  }
  return normalized;
}

export function normalizeFullRecipientRef(value, name = "all_recipients") {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > MAX_ADDRESS_CHARS + 128
    || HEADER_CONTROL_CHAR_RE.test(value)
    || WHITESPACE_OR_COMMA_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
  ) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是合法收件人地址`);
  }
  const parts = value.split("/");
  if (parts.length === 4) {
    const [machineId, host, surface, conversationId] = parts;
    if (
      !machineId || !MACHINE_ID_RE.test(machineId) || FORBIDDEN_KEYS.has(machineId) || machineId === "*"
      || !host || !SEGMENT_ID_RE.test(host) || FORBIDDEN_KEYS.has(host) || host === "*"
      || !surface || !SEGMENT_ID_RE.test(surface) || FORBIDDEN_KEYS.has(surface) || surface === "*"
      || !conversationId || conversationId.length > MAX_CONVERSATION_ID_CHARS || FORBIDDEN_KEYS.has(conversationId) || conversationId === "*"
    ) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 4 段收件人地址格式无效`);
    }
    return `${machineId}/${host}/${surface}/${conversationId}`;
  }
  return normalizeRelayAddress(value, name);
}

function normalizeRecipientList(rawList, name, {
  required = true,
  maxRecipients = RELAY_FRAME_HARD_MAX_RECIPIENTS,
  allowFourSegment = false,
} = {}) {
  if (rawList === undefined || rawList === null) {
    if (!required) return [];
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是非空收件人数组`);
  }
  if (!Array.isArray(rawList)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 必须是数组`);
  }
  if (required && rawList.length === 0) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 至少需要 1 个收件人`);
  }
  if (rawList.length > maxRecipients * 2 && rawList.length > RELAY_FRAME_HARD_MAX_RECIPIENTS * 2) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 数量超出允许上限`);
  }
  const seen = new Set();
  const deduped = [];
  for (let i = 0; i < rawList.length; i += 1) {
    const address = allowFourSegment
      ? normalizeFullRecipientRef(rawList[i], `${name}[${i}]`)
      : normalizeRelayAddress(rawList[i], `${name}[${i}]`);
    if (!seen.has(address)) {
      seen.add(address);
      deduped.push(address);
    }
  }
  if (required && deduped.length === 0) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 至少需要 1 个有效收件人`);
  }
  if (deduped.length > maxRecipients) {
    throw new RelayError(
      "RELAY_RECIPIENTS_TOO_MANY",
      `${name} 收件人数量 (${deduped.length}) 超过单帧上限 ${maxRecipients}`,
      { count: deduped.length, max_recipients: maxRecipients },
    );
  }
  return deduped;
}

function pickAliasedString(input, primaryKey, aliasKey, name) {
  const hasPrimary = input[primaryKey] !== undefined;
  const hasAlias = input[aliasKey] !== undefined;
  if (hasPrimary && hasAlias && input[primaryKey] !== input[aliasKey]) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `${name} 同时提供了不一致的 ${primaryKey} 与 ${aliasKey}`);
  }
  return hasPrimary ? input[primaryKey] : input[aliasKey];
}

export function computeRelayBodySha256(body) {
  const canonical = String(body ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function computeBodySha256(canonicalBody) {
  return createHash("sha256").update(canonicalBody, "utf8").digest("hex");
}

export function cqEncodedLength(text) {
  const str = String(text ?? "");
  let extra = 0;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "&" || ch === "[" || ch === "]" || ch === ",") {
      extra += 4;
    }
  }
  return str.length + extra;
}

export function encodeRelayFrame(input, options = {}) {
  assertPlainObject(input, "encodeRelayFrame input", ENCODE_INPUT_KEYS);
  assertPlainObject(options, "encodeRelayFrame options", ENCODE_OPTION_KEYS);

  const requestedMaxFrameChars = options.maxFrameChars === undefined
    ? RELAY_FRAME_DEFAULT_MAX_CHARS
    : options.maxFrameChars;
  if (!Number.isSafeInteger(requestedMaxFrameChars) || requestedMaxFrameChars < 128) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "maxFrameChars 必须是 >= 128 的安全整数");
  }
  const effectiveMaxFrameChars = Math.min(requestedMaxFrameChars, RELAY_FRAME_HARD_MAX_CHARS);

  const maxRecipients = options.maxRecipients === undefined
    ? RELAY_FRAME_DEFAULT_MAX_RECIPIENTS
    : options.maxRecipients;
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > RELAY_FRAME_HARD_MAX_RECIPIENTS) {
    throw new RelayError(
      "RELAY_INVALID_ARGUMENT",
      `maxRecipients 必须是 1..${RELAY_FRAME_HARD_MAX_RECIPIENTS} 范围内的安全整数`,
    );
  }

  const relayId = input.relay_id === undefined || input.relay_id === null || input.relay_id === ""
    ? `rly_${randomUUID()}`
    : validateRelayId(input.relay_id, "relay_id");

  const op = input.op;
  if (typeof op !== "string" || !ALLOWED_OP_SET.has(op)) {
    throw new RelayError(
      "RELAY_UNSUPPORTED_OP",
      `不支持的 op 操作类型：${String(op)}`,
      { op: typeof op === "string" ? op : null, allowed_ops: [...ALLOWED_RELAY_OPS] },
    );
  }

  const fromMachine = validateMachineId(
    pickAliasedString(input, "from_machine", "source_machine", "from_machine"),
    "from_machine",
  );
  const toMachine = validateMachineId(
    pickAliasedString(input, "to_machine", "target_machine", "to_machine"),
    "to_machine",
  );
  const source = normalizeRelayAddress(input.source, "source");
  const recipients = normalizeRecipientList(input.recipients, "recipients", {
    required: true,
    maxRecipients,
  });

  const inReplyTo = input.in_reply_to === undefined || input.in_reply_to === null || input.in_reply_to === ""
    ? null
    : validateRelayId(input.in_reply_to, "in_reply_to");

  let metaJson = "{}";
  if (input.meta !== undefined && input.meta !== null) {
    assertPlainObject(input.meta, "meta");
    metaJson = stableSingleLineJson(input.meta, "meta");
  }

  if (typeof input.body !== "string") {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "body 必须是字符串");
  }
  if (BODY_FORBIDDEN_CONTROL_RE.test(input.body)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "body 包含不允许的控制字符");
  }

  const canonicalBody = input.body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const bodySha256 = computeBodySha256(canonicalBody);

  const headerLines = [
    RELAY_FRAME_HEADER,
    `relay_id: ${relayId}`,
    `op: ${op}`,
    `from_machine: ${fromMachine}`,
    `to_machine: ${toMachine}`,
    `source: ${source}`,
    `recipients: ${recipients.join(", ")}`,
  ];
  if (inReplyTo !== null) {
    headerLines.push(`in_reply_to: ${inReplyTo}`);
  }
  headerLines.push(`body_sha256: ${bodySha256}`);
  headerLines.push(`meta: ${metaJson}`);
  headerLines.push("---");

  const bodyLines = canonicalBody.length === 0
    ? []
    : canonicalBody.split("\n").map((line) => (line === "" ? "|" : `| ${line}`));
  const encoded = [...headerLines, ...bodyLines, RELAY_FRAME_FOOTER].join("\n");
  const cqLength = cqEncodedLength(encoded);

  if (encoded.length > effectiveMaxFrameChars || cqLength > effectiveMaxFrameChars) {
    throw new RelayError(
      "RELAY_FRAME_TOO_LARGE",
      `编码后的中继帧长度（raw=${encoded.length}, cq=${cqLength}）超过上限 ${effectiveMaxFrameChars}，建议改用纯数据文件包通道`,
      {
        frame_length: encoded.length,
        cq_encoded_length: cqLength,
        max_frame_chars: effectiveMaxFrameChars,
        suggest_file_bundle: true,
      },
    );
  }

  return encoded;
}

export function decodeRelayFrame(rawText) {
  if (typeof rawText !== "string" || !rawText) return null;

  const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstNewline = normalized.indexOf("\n");
  const firstLine = firstNewline === -1 ? normalized : normalized.slice(0, firstNewline);

  if (firstLine !== RELAY_FRAME_HEADER) {
    if (firstLine.trim() === RELAY_FRAME_HEADER) {
      return { malformed: true, reason: "header_line_has_whitespace" };
    }
    return null;
  }

  if (normalized.length > MAX_DECODE_INPUT_CHARS) {
    return { malformed: true, reason: "frame_exceeds_decoder_limit" };
  }

  const lines = normalized.split("\n");
  if (lines.length < 4) {
    return { malformed: true, reason: "truncated_frame" };
  }

  if (lines[lines.length - 1] !== RELAY_FRAME_FOOTER) {
    return { malformed: true, reason: "missing_or_invalid_footer" };
  }

  let separatorIndex = -1;
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (lines[i] === "---") {
      separatorIndex = i;
      break;
    }
  }
  if (separatorIndex === -1) {
    return { malformed: true, reason: "missing_body_separator" };
  }

  const headers = Object.create(null);
  for (let i = 1; i < separatorIndex; i += 1) {
    const line = lines[i];
    const sep = line.indexOf(": ");
    if (sep <= 0) {
      return { malformed: true, reason: "malformed_header_line" };
    }
    const key = line.slice(0, sep);
    const value = line.slice(sep + 2);
    if (!ALLOWED_FRAME_HEADER_KEYS.has(key)) {
      return { malformed: true, reason: `unknown_header_${key}` };
    }
    if (Object.hasOwn(headers, key)) {
      return { malformed: true, reason: `duplicate_header_${key}` };
    }
    if (HEADER_CONTROL_CHAR_RE.test(value)) {
      return { malformed: true, reason: `control_char_in_${key}` };
    }
    headers[key] = value;
  }

  for (const requiredKey of REQUIRED_FRAME_HEADER_KEYS) {
    if (!Object.hasOwn(headers, requiredKey)) {
      return { malformed: true, reason: `missing_header_${requiredKey}` };
    }
  }

  const relayId = headers.relay_id;
  if (!relayId || relayId.trim() !== relayId || FORBIDDEN_KEYS.has(relayId) || relayId === "*" || !RELAY_ID_RE.test(relayId)) {
    return { malformed: true, reason: "invalid_relay_id" };
  }

  const op = headers.op;
  if (!ALLOWED_OP_SET.has(op)) {
    return { malformed: true, reason: "unsupported_op" };
  }

  const fromMachine = headers.from_machine;
  if (!fromMachine || FORBIDDEN_KEYS.has(fromMachine) || fromMachine === "*" || !MACHINE_ID_RE.test(fromMachine)) {
    return { malformed: true, reason: "invalid_from_machine" };
  }

  const toMachine = headers.to_machine;
  if (!toMachine || FORBIDDEN_KEYS.has(toMachine) || toMachine === "*" || !MACHINE_ID_RE.test(toMachine)) {
    return { malformed: true, reason: "invalid_to_machine" };
  }

  const source = parseRelayAddress(headers.source);
  if (!source) {
    return { malformed: true, reason: "invalid_source" };
  }

  const rawRecipients = headers.recipients;
  if (!rawRecipients) {
    return { malformed: true, reason: "invalid_recipients" };
  }
  const rawRecipientItems = rawRecipients.split(",");
  if (rawRecipientItems.length === 0 || rawRecipientItems.length > RELAY_FRAME_HARD_MAX_RECIPIENTS) {
    return { malformed: true, reason: "invalid_recipients_count" };
  }
  const recipients = [];
  const seenRecipients = new Set();
  for (let i = 0; i < rawRecipientItems.length; i += 1) {
    const rawItem = rawRecipientItems[i];
    const trimmed = i === 0 ? rawItem : (rawItem.startsWith(" ") ? rawItem.slice(1) : rawItem);
    const parsedAddress = parseRelayAddress(trimmed);
    if (!parsedAddress) {
      return { malformed: true, reason: "invalid_recipient_item" };
    }
    if (!seenRecipients.has(parsedAddress)) {
      seenRecipients.add(parsedAddress);
      recipients.push(parsedAddress);
    }
  }

  let inReplyTo = null;
  if (Object.hasOwn(headers, "in_reply_to")) {
    const val = headers.in_reply_to;
    if (!val || val.trim() !== val || FORBIDDEN_KEYS.has(val) || val === "*" || !RELAY_ID_RE.test(val)) {
      return { malformed: true, reason: "invalid_in_reply_to" };
    }
    inReplyTo = val;
  }

  const declaredBodySha256 = headers.body_sha256;
  if (!SHA256_HEX_RE.test(declaredBodySha256)) {
    return { malformed: true, reason: "invalid_body_sha256" };
  }

  let parsedMeta = {};
  if (Object.hasOwn(headers, "meta")) {
    try {
      parsedMeta = JSON.parse(headers.meta);
    } catch {
      return { malformed: true, reason: "invalid_meta_json" };
    }
    if (!isPlainObjectSafe(parsedMeta, 0)) {
      return { malformed: true, reason: "invalid_meta_structure" };
    }
  }

  const quotedBodyLines = lines.slice(separatorIndex + 1, lines.length - 1);

  const unquotedLines = [];
  for (const line of quotedBodyLines) {
    let content;
    if (line === "|" || line === "| ") {
      content = "";
    } else if (line.startsWith("| ")) {
      content = line.slice(2);
    } else {
      return { malformed: true, reason: "body_line_missing_quote_prefix" };
    }
    if (BODY_FORBIDDEN_CONTROL_RE.test(content)) {
      return { malformed: true, reason: "control_char_in_body" };
    }
    unquotedLines.push(content);
  }

  const body = unquotedLines.join("\n");
  const actualBodySha256 = computeBodySha256(body);
  if (actualBodySha256 !== declaredBodySha256) {
    return { malformed: true, reason: "body_sha256_mismatch" };
  }

  return {
    relay_id: relayId,
    op,
    from_machine: fromMachine,
    to_machine: toMachine,
    source,
    recipients,
    in_reply_to: inReplyTo,
    body_sha256: declaredBodySha256,
    meta: parsedMeta,
    body,
  };
}

export function validateRecipientDisclosure(route, input = {}) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "route 必须是有效路由对象");
  }
  assertPlainObject(input, "validateRecipientDisclosure input", DISCLOSURE_INPUT_KEYS);

  const normalizedRecipients = normalizeRecipientList(input.recipients, "recipients", {
    required: true,
    maxRecipients: RELAY_FRAME_HARD_MAX_RECIPIENTS,
  });
  const normalizedAllRecipients = normalizeRecipientList(input.all_recipients, "all_recipients", {
    required: false,
    maxRecipients: RELAY_FRAME_HARD_MAX_RECIPIENTS * 4,
    allowFourSegment: true,
  });

  if (input.allow_disclose_recipients !== undefined && typeof input.allow_disclose_recipients !== "boolean") {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "allow_disclose_recipients 必须是布尔值");
  }

  const routeTargetMachine = typeof route.peer_machine_id === "string" && route.peer_machine_id.trim()
    ? route.peer_machine_id.trim()
    : (Array.isArray(route.target_machines) && route.target_machines.length === 1 && typeof route.target_machines[0] === "string" && route.target_machines[0].trim()
      ? route.target_machines[0].trim()
      : null);

  const effectiveSet = new Set();
  const effectiveAllRecipients = [];
  for (const address of normalizedAllRecipients) {
    const canonical = address.split("/").length === 3 && routeTargetMachine
      ? `${routeTargetMachine}/${address}`
      : address;
    if (!effectiveSet.has(canonical)) {
      effectiveSet.add(canonical);
      effectiveAllRecipients.push(canonical);
    }
  }
  for (const address of normalizedRecipients) {
    const canonical = routeTargetMachine ? `${routeTargetMachine}/${address}` : address;
    if (effectiveSet.has(canonical)) continue;
    // 若 route 未提供 peer_machine_id/target_machines，但 all_recipients 恰好只有唯一单机 4 段引用指向同一 3 段收件人，不重复计为 2 人
    if (!routeTargetMachine && normalizedAllRecipients.length === 1) {
      const only = normalizedAllRecipients[0];
      if (only.split("/").length === 4 && only.endsWith(`/${address}`)) {
        continue;
      }
    }
    effectiveSet.add(canonical);
    effectiveAllRecipients.push(canonical);
  }

  if (effectiveAllRecipients.length > 1) {
    if (route.allow_recipient_list_disclosure !== true) {
      throw new RelayError(
        "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
        "所选中继路由未开启多收件人完整名单公开权限（allow_recipient_list_disclosure !== true）",
        {
          relay_key: route.relay_key ?? null,
          group_id: route.group_id ?? null,
          recipient_count: normalizedRecipients.length,
          effective_all_recipient_count: effectiveAllRecipients.length,
          reason: "route_disallows_disclosure",
        },
      );
    }
    if (input.allow_disclose_recipients === false) {
      throw new RelayError(
        "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
        "调用方显式禁止公开多收件人完整名单（allow_disclose_recipients === false）",
        {
          relay_key: route.relay_key ?? null,
          group_id: route.group_id ?? null,
          recipient_count: normalizedRecipients.length,
          effective_all_recipient_count: effectiveAllRecipients.length,
          reason: "caller_disallows_disclosure",
        },
      );
    }
  }

  return Object.freeze({
    allowed: true,
    disclosed: effectiveAllRecipients.length > 1,
    recipients: Object.freeze(normalizedRecipients),
    effective_all_recipients: Object.freeze(effectiveAllRecipients),
  });
}

export function computeRelaySendFingerprint(payload) {
  assertPlainObject(payload, "fingerprint payload");
  const canonical = canonicalizeJsonValue(payload, "fingerprint payload", 0);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
