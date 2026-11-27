import { createHash, randomUUID } from "node:crypto";
import { CoreError, requireText, stableStringify } from "./contracts.mjs";

export const RELAY_FRAME_START = "[COMM_RELAY_V1]";
export const RELAY_FRAME_END = "[END_COMM_RELAY_V1]";
export const DEFAULT_MAX_FRAME_CHARS = 1800;
export const MAX_CONFIGURABLE_FRAME_CHARS = 1900;
const MAX_META_DEPTH = 32;
const MAX_RELAY_RECIPIENTS = 16;

export const ALLOWED_RELAY_OPS = new Set([
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

export const LEGACY_NAPCAT_FIELD_REGEXES = Object.freeze([
  /^(?:任务|task_id)\s*[：:]\s*(.+)$/i,
  /^(?:来源机器|source_machine)\s*[：:]\s*(.+)$/i,
  /^(?:目标机器|target_machine)\s*[：:]\s*(.+)$/i,
  /^delivery_id\s*[：:]\s*(.+)$/i,
  /^request_id\s*[：:]\s*(.+)$/i,
  /^source_conversation_id\s*[：:]\s*(.+)$/i,
  /^target_conversation_id\s*[：:]\s*(.+)$/i,
  /^receipt_stage\s*[：:]\s*(.+)$/i,
  /^delivery_message_seq\s*[：:]\s*(.+)$/i,
  /^proposed_task_id\s*[：:]\s*(.+)$/i,
  /^previous_task_id\s*[：:]\s*(.+)$/i,
  /^(?:route_key|路由)\s*[：:]\s*(.+)$/i,
  /^reply_required\s*[：:]\s*(true|false)$/i,
  /^expected_reply\s*[：:]\s*(.+)$/i,
  /^reply_deadline_at\s*[：:]\s*(.+)$/i,
  /^next_check_at\s*[：:]\s*(.+)$/i,
]);

const TWO_SEGMENT_DEFAULT_SURFACE_HOSTS = new Set(["antigravity", "codex", "windsurf"]);
const FORBIDDEN_SEGMENT_CHARS = /[\/,\s*\u0000-\u001f\u007f]/u;
const FORBIDDEN_TOKEN_CHARS = /[\s\u0000-\u001f\u007f]/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const LEGACY_HEADER_TYPES = new Set([
  "[Codex][CONNECTION_REQUEST]",
  "[Codex][DELIVERY_RECEIPT]",
  "[Codex][OWNER_REPLY]",
]);
const LEGACY_TASK_FILE_INDEX_MARKER = "[Codex][TASK_FILE_INDEX]";
const LEGACY_FILE_ID_RE = /^file_id\s*[：:]\s*(.+)$/i;
const ONEBOT_CONTROL_CQ_RE = /\[CQ:(at|reply)(?:,([^\]]*))?\]/g;
const ALLOWED_HEADER_KEYS = new Set([
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
const REQUIRED_HEADER_KEYS = [
  "relay_id",
  "op",
  "from_machine",
  "to_machine",
  "source",
  "recipients",
  "body_sha256",
  "meta",
];

function normalizeLineEndings(text) {
  return text.replace(/\r\n|\r/g, "\n");
}

function validateSegment(value, name, maxBytes) {
  const text = requireText(value, name, maxBytes);
  if (FORBIDDEN_SEGMENT_CHARS.test(text)) {
    throw new CoreError("invalid_input", `${name}包含非法分隔符、空白、通配符或控制字符`);
  }
  return text;
}

function validateToken(value, name, maxBytes = 128) {
  const text = requireText(value, name, maxBytes);
  if (FORBIDDEN_TOKEN_CHARS.test(text)) {
    throw new CoreError("invalid_input", `${name}不能包含空白或控制字符`);
  }
  return text;
}

function validateMachineId(value, name) {
  return validateSegment(value, name, 128);
}

function normalizeEndpointInput(endpoint, name) {
  if (typeof endpoint === "string") {
    return parseEndpoint(endpoint);
  }
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
    throw new CoreError("invalid_input", `${name}必须是合法端点对象或端点字符串`);
  }
  const host = validateSegment(endpoint.host, `${name}.host`, 64);
  let surface;
  if (endpoint.surface === undefined) {
    if (!TWO_SEGMENT_DEFAULT_SURFACE_HOSTS.has(host)) {
      throw new CoreError("invalid_input", `宿主「${host}」必须显式指定 surface，不可省略`);
    }
    surface = "desktop";
  } else {
    surface = validateSegment(endpoint.surface, `${name}.surface`, 64);
  }
  const conversation_id = validateSegment(endpoint.conversation_id, `${name}.conversation_id`, 256);
  return { host, surface, conversation_id };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeJsonValue(value, path = "meta", depth = 0, seen = new WeakSet()) {
  if (depth > MAX_META_DEPTH) {
    throw new CoreError("invalid_input", `${path}嵌套层级超出上限 ${MAX_META_DEPTH}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CoreError("invalid_input", `${path}包含非有限数值`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new CoreError("invalid_input", `${path}不允许包含循环引用`);
    }
    seen.add(value);
    try {
      return value.map((item, idx) => (
        item === undefined ? null : sanitizeJsonValue(item, `${path}[${idx}]`, depth + 1, seen)
      ));
    } finally {
      seen.delete(value);
    }
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) {
      throw new CoreError("invalid_input", `${path}不允许包含循环引用`);
    }
    seen.add(value);
    try {
      const clean = {};
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        clean[key] = sanitizeJsonValue(value[key], `${path}.${key}`, depth + 1, seen);
      }
      return clean;
    } finally {
      seen.delete(value);
    }
  }
  throw new CoreError("invalid_input", `${path}包含不可 JSON 序列化的值`);
}

export function cqEncodedLength(text) {
  if (typeof text !== "string") {
    throw new CoreError("invalid_input", "计算 CQ 编码长度的输入必须是字符串");
  }
  let length = text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 38 || code === 91 || code === 93 || code === 44) {
      length += 4;
    }
  }
  return length;
}

export function formatEndpoint(endpoint) {
  const normalized = normalizeEndpointInput(endpoint, "endpoint");
  return `${normalized.host}/${normalized.surface}/${normalized.conversation_id}`;
}

export function parseEndpoint(text) {
  if (typeof text !== "string" || !text.length) {
    throw new CoreError("invalid_input", "endpoint 必须是非空字符串");
  }
  if (FORBIDDEN_TOKEN_CHARS.test(text)) {
    throw new CoreError("invalid_input", "endpoint 不能包含空白或控制字符");
  }
  const parts = text.split("/");
  if (parts.length === 3) {
    return {
      host: validateSegment(parts[0], "endpoint.host", 64),
      surface: validateSegment(parts[1], "endpoint.surface", 64),
      conversation_id: validateSegment(parts[2], "endpoint.conversation_id", 256),
    };
  }
  if (parts.length === 2) {
    const host = validateSegment(parts[0], "endpoint.host", 64);
    if (!TWO_SEGMENT_DEFAULT_SURFACE_HOSTS.has(host)) {
      throw new CoreError("invalid_input", `仅 antigravity/codex/windsurf 允许 2 段端点省略 surface（收到宿主：${host}）`);
    }
    return {
      host,
      surface: "desktop",
      conversation_id: validateSegment(parts[1], "endpoint.conversation_id", 256),
    };
  }
  throw new CoreError("invalid_input", "endpoint 必须为 3 段 <host>/<surface>/<conversation_id> 或受支持宿主的 2 段格式");
}

export function computeBodySha256(body) {
  if (typeof body !== "string") {
    throw new CoreError("invalid_input", "正文必须是字符串");
  }
  return createHash("sha256").update(normalizeLineEndings(body), "utf8").digest("hex");
}

export function encodeRelayFrame(
  input,
  { maxFrameChars = DEFAULT_MAX_FRAME_CHARS, enforceCqBudget = true } = {},
) {
  if (!isPlainObject(input)) {
    throw new CoreError("invalid_input", "帧编码输入必须是普通对象");
  }
  if (!Number.isSafeInteger(maxFrameChars) || maxFrameChars < 128 || maxFrameChars > MAX_CONFIGURABLE_FRAME_CHARS) {
    throw new CoreError("invalid_input", `maxFrameChars 必须是 128..${MAX_CONFIGURABLE_FRAME_CHARS} 之间的整数`);
  }
  if (typeof enforceCqBudget !== "boolean") {
    throw new CoreError("invalid_input", "enforceCqBudget 必须是布尔值");
  }

  const rawRelayId = input.relay_id ?? input.relayId;
  const relayId = rawRelayId === undefined || rawRelayId === null
    ? `rly_${randomUUID()}`
    : validateToken(rawRelayId, "relay_id", 128);

  const op = requireText(input.op, "op", 64);
  if (!ALLOWED_RELAY_OPS.has(op)) {
    throw new CoreError("unsupported_op", `不支持的跨机中继操作类型：${op}`, { op });
  }

  const fromMachine = validateMachineId(input.from_machine ?? input.fromMachine, "from_machine");
  const toMachine = validateMachineId(input.to_machine ?? input.toMachine, "to_machine");
  const formattedSource = formatEndpoint(input.source);

  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new CoreError("invalid_input", "recipients 必须是非空数组");
  }
  if (input.recipients.length > MAX_RELAY_RECIPIENTS) {
    throw new CoreError("invalid_input", `recipients 数量不能超过 ${MAX_RELAY_RECIPIENTS}`);
  }
  const formattedRecipients = input.recipients.map((entry, idx) => {
    const parsed = normalizeEndpointInput(entry, `recipients[${idx}]`);
    return `${parsed.host}/${parsed.surface}/${parsed.conversation_id}`;
  });

  const rawReplyTo = input.in_reply_to ?? input.inReplyTo;
  const inReplyTo = rawReplyTo === undefined || rawReplyTo === null || rawReplyTo === ""
    ? null
    : validateToken(rawReplyTo, "in_reply_to", 128);

  const rawBody = input.body === undefined ? "" : input.body;
  if (typeof rawBody !== "string") {
    throw new CoreError("invalid_input", "body 必须是字符串");
  }
  const normalizedBody = normalizeLineEndings(rawBody);
  const bodySha256 = computeBodySha256(normalizedBody);

  const rawMeta = input.meta === undefined ? {} : input.meta;
  if (!isPlainObject(rawMeta)) {
    throw new CoreError("invalid_input", "meta 必须是普通对象");
  }
  const hopCount = rawMeta.hop_count === undefined ? 1 : rawMeta.hop_count;
  if (!Number.isSafeInteger(hopCount) || hopCount < 1) {
    throw new CoreError("invalid_input", "meta.hop_count 必须是正整数");
  }
  const normalizedMeta = sanitizeJsonValue({ ...rawMeta, hop_count: hopCount }, "meta");
  const metaJson = stableStringify(normalizedMeta);
  if (typeof metaJson !== "string" || /[\r\n]/.test(metaJson)) {
    throw new CoreError("invalid_input", "meta 序列化结果必须是单行合法 JSON");
  }

  const headerLines = [
    RELAY_FRAME_START,
    `relay_id: ${relayId}`,
    `op: ${op}`,
    `from_machine: ${fromMachine}`,
    `to_machine: ${toMachine}`,
    `source: ${formattedSource}`,
    `recipients: ${formattedRecipients.join(", ")}`,
    ...(inReplyTo ? [`in_reply_to: ${inReplyTo}`] : []),
    `body_sha256: ${bodySha256}`,
    `meta: ${metaJson}`,
    "---",
  ];

  const bodyLines = normalizedBody.length === 0
    ? []
    : normalizedBody.split("\n").map((line) => (line.length === 0 ? "|" : `| ${line}`));

  const frameText = [...headerLines, ...bodyLines, RELAY_FRAME_END].join("\n");
  const charLength = frameText.length;
  const cqLength = cqEncodedLength(frameText);

  if (charLength > maxFrameChars || (enforceCqBudget && cqLength > maxFrameChars)) {
    throw new CoreError(
      "relay_frame_too_large",
      `跨机中继帧超出单帧字符预算（原始=${charLength}，CQ编码=${cqLength}，上限=${maxFrameChars}）`,
      {
        frame_length: charLength,
        cq_encoded_length: cqLength,
        max_frame_chars: maxFrameChars,
        suggest_file_bundle: true,
      },
    );
  }

  return {
    frameText,
    relayId,
    bodySha256,
    charLength,
    cqLength,
  };
}

export function decodeRelayFrame(frameText, { maxFrameChars = 16384 } = {}) {
  if (typeof frameText !== "string") {
    return { ok: false, reason: "invalid_type" };
  }
  if (!Number.isSafeInteger(maxFrameChars) || maxFrameChars < 128) {
    return { ok: false, reason: "invalid_max_frame_chars" };
  }

  const normalized = normalizeLineEndings(frameText);
  if (normalized.length > maxFrameChars) {
    return { ok: false, reason: "frame_too_large" };
  }

  const lines = normalized.split("\n");
  if (lines.length < 3 || lines[0] !== RELAY_FRAME_START) {
    return { ok: false, reason: "missing_frame_start" };
  }
  if (lines[lines.length - 1] !== RELAY_FRAME_END) {
    return { ok: false, reason: "missing_frame_end" };
  }

  const separatorIdx = lines.indexOf("---", 1);
  if (separatorIdx === -1 || separatorIdx >= lines.length - 1) {
    return { ok: false, reason: "missing_header_separator" };
  }

  const headers = Object.create(null);
  for (let i = 1; i < separatorIdx; i += 1) {
    const line = lines[i];
    const colonIdx = line.indexOf(": ");
    if (colonIdx <= 0) {
      return { ok: false, reason: "malformed_header_line" };
    }
    const key = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 2);
    if (!ALLOWED_HEADER_KEYS.has(key)) {
      return { ok: false, reason: "unknown_header_key" };
    }
    if (Object.hasOwn(headers, key)) {
      return { ok: false, reason: "duplicate_header_key" };
    }
    headers[key] = value;
  }

  for (const requiredKey of REQUIRED_HEADER_KEYS) {
    if (!Object.hasOwn(headers, requiredKey)) {
      return { ok: false, reason: `missing_header_${requiredKey}` };
    }
  }

  if (!ALLOWED_RELAY_OPS.has(headers.op)) {
    return { ok: false, reason: "unsupported_op" };
  }

  let relayId;
  let fromMachine;
  let toMachine;
  let inReplyTo = null;
  let source;
  let recipients;
  try {
    relayId = validateToken(headers.relay_id, "relay_id", 128);
    fromMachine = validateMachineId(headers.from_machine, "from_machine");
    toMachine = validateMachineId(headers.to_machine, "to_machine");
    if (Object.hasOwn(headers, "in_reply_to")) {
      inReplyTo = validateToken(headers.in_reply_to, "in_reply_to", 128);
    }
    source = parseEndpoint(headers.source);
    const rawRecipients = headers.recipients.split(",");
    if (rawRecipients.length === 0) {
      return { ok: false, reason: "empty_recipients" };
    }
    if (rawRecipients.length > MAX_RELAY_RECIPIENTS) {
      return { ok: false, reason: "too_many_recipients" };
    }
    recipients = rawRecipients.map((item) => parseEndpoint(item.trim()));
  } catch {
    return { ok: false, reason: "invalid_header_value" };
  }

  if (!SHA256_HEX_RE.test(headers.body_sha256)) {
    return { ok: false, reason: "invalid_body_sha256" };
  }

  let meta;
  try {
    meta = JSON.parse(headers.meta);
  } catch {
    return { ok: false, reason: "invalid_meta_json" };
  }
  if (!isPlainObject(meta)) {
    return { ok: false, reason: "invalid_meta_object" };
  }
  try {
    meta = sanitizeJsonValue(meta, "meta");
  } catch {
    return { ok: false, reason: "invalid_meta_object" };
  }
  if (meta.hop_count === undefined) {
    meta = { ...meta, hop_count: 1 };
  } else if (!Number.isSafeInteger(meta.hop_count) || meta.hop_count < 1) {
    return { ok: false, reason: "invalid_meta_hop_count" };
  }

  const rawBodyLines = lines.slice(separatorIdx + 1, lines.length - 1);
  const decodedBodyLines = [];
  for (const rawLine of rawBodyLines) {
    if (rawLine === "|" || rawLine === "| ") {
      decodedBodyLines.push("");
    } else if (rawLine.startsWith("| ")) {
      decodedBodyLines.push(rawLine.slice(2));
    } else {
      return { ok: false, reason: "invalid_body_line_prefix" };
    }
  }

  const body = decodedBodyLines.join("\n");
  const actualSha256 = computeBodySha256(body);
  if (actualSha256 !== headers.body_sha256) {
    return { ok: false, reason: "body_sha256_mismatch" };
  }

  return {
    ok: true,
    frame: {
      relay_id: relayId,
      op: headers.op,
      from_machine: fromMachine,
      to_machine: toMachine,
      source,
      source_text: `${source.host}/${source.surface}/${source.conversation_id}`,
      recipients,
      recipients_text: recipients.map((entry) => `${entry.host}/${entry.surface}/${entry.conversation_id}`),
      in_reply_to: inReplyTo,
      body_sha256: headers.body_sha256,
      meta,
      body,
    },
  };
}

export function inspectLegacyNapcatCollisions(frameText) {
  if (typeof frameText !== "string") {
    throw new CoreError("invalid_input", "待检帧文本必须是字符串");
  }

  const normalized = normalizeLineEndings(frameText);
  const lines = normalized.split("\n");
  const hits = [];

  const firstNonEmpty = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  if (LEGACY_HEADER_TYPES.has(firstNonEmpty)) {
    hits.push({
      kind: "legacy_header_type",
      line: lines.findIndex((line) => line.trim().length > 0) + 1,
      match: firstNonEmpty,
    });
  }

  let bodyStartIdx = -1;
  let bodyEndIdx = -1;
  if (lines[0] === RELAY_FRAME_START && lines[lines.length - 1] === RELAY_FRAME_END) {
    const sep = lines.indexOf("---", 1);
    if (sep !== -1 && sep < lines.length - 1) {
      bodyStartIdx = sep + 1;
      bodyEndIdx = lines.length - 1;
    }
  }

  let firstFileIdLine = -1;
  let firstFileIdSample = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNumber = i + 1;
    const isIsolatedBodyLine = bodyStartIdx !== -1
      && i >= bodyStartIdx
      && i < bodyEndIdx
      && (line === "|" || line.startsWith("| "));

    for (let ruleIndex = 0; ruleIndex < LEGACY_NAPCAT_FIELD_REGEXES.length; ruleIndex += 1) {
      const regex = LEGACY_NAPCAT_FIELD_REGEXES[ruleIndex];
      if (regex.test(line)) {
        hits.push({
          kind: "legacy_field",
          ruleIndex,
          line: lineNumber,
          pattern: regex.source,
          sample: line.slice(0, 120),
        });
      }
    }

    if (firstFileIdLine === -1 && LEGACY_FILE_ID_RE.test(line)) {
      firstFileIdLine = lineNumber;
      firstFileIdSample = line.slice(0, 120);
    }

    if (!isIsolatedBodyLine && line.includes(LEGACY_TASK_FILE_INDEX_MARKER)) {
      hits.push({
        kind: "unisolated_task_file_index_marker",
        line: lineNumber,
        sample: line.slice(0, 120),
      });
    }

    if (!isIsolatedBodyLine) {
      ONEBOT_CONTROL_CQ_RE.lastIndex = 0;
      let match;
      while ((match = ONEBOT_CONTROL_CQ_RE.exec(line)) !== null) {
        hits.push({
          kind: "unisolated_cq_control_segment",
          cqType: match[1],
          line: lineNumber,
          match: match[0],
        });
      }
    }
  }

  if (normalized.includes(LEGACY_TASK_FILE_INDEX_MARKER) && firstFileIdLine !== -1) {
    hits.push({
      kind: "legacy_task_file_index",
      line: firstFileIdLine,
      sample: firstFileIdSample,
    });
  }

  return {
    clean: hits.length === 0,
    hits,
  };
}
