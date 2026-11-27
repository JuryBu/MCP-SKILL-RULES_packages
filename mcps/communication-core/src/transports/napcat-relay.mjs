import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError, stableStringify } from "../contracts.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BUNDLE_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_FRAME_CHARS = 1800;
const MAX_CONFIGURABLE_FRAME_CHARS = 1900;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_EVENTS_PER_ROUTE = 512;
const DEFAULT_MAX_GROUP_MESSAGES = 512;
const DEFAULT_MAX_DEDUPE_ENTRIES = 4096;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const HEX64_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;
const LOWER_OP_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const MACHINE_RELAY_LANE = "machine_relay";
export const MACHINE_BUNDLE_LANE = "machine_bundle";

export const RELAY_ALLOWED_OPS = Object.freeze([
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

const RELAY_ALLOWED_OP_SET = new Set(RELAY_ALLOWED_OPS);
const BUNDLE_DISALLOWED_OPS = new Set(["file_notice", "file_ack"]);

const WRITE_TOOLS = new Set([
  "napcat_relay_send",
  "napcat_file_bundle_send",
  "napcat_file_bundle_events_ack",
]);

const RETRYABLE_READ_TOOLS = new Set([
  "napcat_relay_status",
  "napcat_relay_events_read",
  "napcat_file_bundle_events_read",
]);

const BUNDLE_UNAVAILABLE_PROVIDER_CODES = new Set([
  "RELAY_FILE_INTEGRATION_DISABLED",
  "RELAY_FILE_TOOL_UNKNOWN",
]);

export const RELAY_ERROR_CODE_MAP = Object.freeze({
  RELAY_FRAME_TOO_LARGE: "relay_frame_too_large",
  RELAY_RATE_LIMITED: "relay_rate_limited",
  RELAY_RECIPIENT_DISCLOSURE_BLOCKED: "relay_recipient_disclosure_blocked",
  RELAY_ROUTE_NOT_FOUND: "relay_route_not_found",
  RELAY_ROUTE_AMBIGUOUS: "relay_route_ambiguous",
  RELAY_ROUTE_DRAIN_EXPIRED: "relay_route_drain_expired",
  RELAY_ROUTE_CHANGED: "relay_route_changed",
  RELAY_DEDUPE_CONFLICT: "relay_dedupe_conflict",
  RELAY_CURSOR_EXPIRED: "relay_cursor_expired",
  RELAY_HISTORY_EXPIRED: "relay_history_expired",
  RELAY_HISTORY_GAP: "relay_history_gap",
  RELAY_CURSOR_INVALID: "relay_cursor_invalid",
  RELAY_CURSOR_SCOPE_MISMATCH: "relay_cursor_scope_mismatch",
  RELAY_FILE_BODY_INVALID: "relay_file_body_invalid",
  RELAY_FILE_ROOT_CHANGED: "relay_file_root_changed",
  RELAY_FILE_CALLER_DENIED: "relay_file_caller_denied",
  RELAY_FILE_REQUEST_INVALID: "relay_file_request_invalid",
  RELAY_FILE_ROUTE_DENIED: "relay_file_route_denied",
  RELAY_FILE_ID_CONFLICT: "relay_file_id_conflict",
  RELAY_FILE_EVENT_CURSOR: "relay_file_event_cursor",
  RELAY_FILE_ROUTE_UNAVAILABLE: "relay_file_route_unavailable",
  RELAY_FILE_EVENT_ACK_INVALID: "relay_file_event_ack_invalid",
  RELAY_FILE_RESUME_LIMIT: "relay_file_resume_limit",
  RELAY_FILE_SENDER_UNVERIFIED: "relay_file_sender_unverified",
  RELAY_FILE_TOOL_UNKNOWN: "relay_file_tool_unknown",
  RELAY_FILE_REPLY_ROUTE_UNBOUND: "relay_file_reply_route_unbound",
  RELAY_FILE_INTEGRATION_DISABLED: "relay_file_integration_disabled",
  RELAY_BUNDLE_TOO_LARGE: "relay_bundle_too_large",
  RELAY_BUNDLE_FILE_COUNT: "relay_bundle_file_count",
});

export class RelayError extends CoreError {
  constructor(code, message, details = {}, { outcomeUnknown } = {}) {
    const resolvedUnknown = typeof outcomeUnknown === "boolean"
      ? outcomeUnknown
      : details?.outcome_unknown === true;
    super(code, message, { ...details, outcome_unknown: resolvedUnknown });
    this.name = "RelayError";
    this.outcomeUnknown = resolvedUnknown;
  }
}

export function mapRelayProviderErrorCode(providerCode) {
  if (typeof providerCode !== "string" || !providerCode) return "relay_provider_error";
  if (Object.hasOwn(RELAY_ERROR_CODE_MAP, providerCode)) {
    return RELAY_ERROR_CODE_MAP[providerCode];
  }
  return "relay_provider_error";
}

function invalidInput(message, details = {}) {
  return new CoreError("invalid_input", message, details);
}

function invalidConfig(message, details = {}) {
  return new CoreError("invalid_config", message, details);
}

function transportUnconfirmed(requestSent = false, lane = MACHINE_RELAY_LANE, extra = {}) {
  return new RelayError(
    "relay_transport_unconfirmed",
    "NapCat 中继尚未取得可核对结果",
    { request_sent: requestSent, lane, ...extra },
    { outcomeUnknown: requestSent },
  );
}

function bundleUnavailable(details = {}) {
  return new CoreError(
    "bundle_transport_unavailable",
    "纯数据文件包通道未启用或当前中继不支持",
    { lane: MACHINE_BUNDLE_LANE, request_sent: false, ...details },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function copyPlainRecord(value, allowed = null, onReject = () => invalidInput("参数必须是普通对象")) {
  if (!isPlainObject(value)) throw onReject();
  const copied = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) throw onReject();
    if (allowed && !allowed.includes(key)) throw onReject();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw onReject();
    copied[key] = descriptor.value;
  }
  return copied;
}

function sanitizeJsonValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > 32) throw invalidInput("结构化载荷嵌套层级超出限制");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidInput("结构化载荷包含非有限数字");
    return value;
  }
  if (Array.isArray(value)) {
    if (types.isProxy(value)) throw invalidInput("结构化载荷不允许 Proxy 对象");
    if (seen.has(value)) throw invalidInput("结构化载荷不允许循环引用");
    seen.add(value);
    const out = value.map(item => sanitizeJsonValue(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (!isPlainObject(value)) throw invalidInput("结构化载荷仅支持纯 JSON 值");
  if (seen.has(value)) throw invalidInput("结构化载荷不允许循环引用");
  seen.add(value);
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
      throw invalidInput("结构化载荷包含非法字段名");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw invalidInput("结构化载荷包含不可读属性");
    }
    if (descriptor.value === undefined) continue;
    out[key] = sanitizeJsonValue(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

function sanitizeOptionalDetails(value, depth = 0) {
  if (depth > 8 || value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (types.isProxy(value)) return undefined;
    return value.slice(0, 64).map(item => sanitizeOptionalDetails(item, depth + 1)).filter(item => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) continue;
    const clean = sanitizeOptionalDetails(descriptor.value, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function requireIdentifier(value, fieldName, maxBytes = 256, onReject = message => invalidInput(message)) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || CONTROL_CHAR_PATTERN.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw onReject(`${fieldName}必须是无首尾空白与控制字符且长度受限的非空文本`);
  }
  return value;
}

function requireBoundedText(value, fieldName, maxBytes = 256, onReject = message => invalidInput(message)) {
  if (typeof value !== "string" || !value.trim()
    || CONTROL_CHAR_PATTERN.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw onReject(`${fieldName}必须是非空、无控制字符且长度受限的文本`);
  }
  return value.trim();
}

function requirePositiveInt(value, fieldName, max = Number.MAX_SAFE_INTEGER, onReject = message => invalidInput(message)) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw onReject(`${fieldName}必须是 1..${max} 范围内的安全整数`);
  }
  return value;
}

function requireHex64(value, fieldName) {
  if (typeof value !== "string" || !HEX64_PATTERN.test(value)) {
    throw invalidInput(`${fieldName}必须是 64 位小写十六进制字符串`);
  }
  return value;
}

function validateReplyRouteTriple(request) {
  const hasKey = request.reply_relay_key !== undefined;
  const hasGroup = request.reply_group_id !== undefined;
  const hasGen = request.reply_route_generation !== undefined;
  if (!hasKey && !hasGroup && !hasGen) return {};
  if (!hasKey || !hasGroup || !hasGen) {
    throw invalidInput("原路回复必须同时提供 reply_relay_key、reply_group_id 与 reply_route_generation");
  }
  return {
    reply_relay_key: requireIdentifier(request.reply_relay_key, "reply_relay_key", 256),
    reply_group_id: requireIdentifier(request.reply_group_id, "reply_group_id", 256),
    reply_route_generation: requirePositiveInt(request.reply_route_generation, "reply_route_generation"),
  };
}

function validateLoopbackBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl || CONTROL_CHAR_PATTERN.test(baseUrl)
    || baseUrl.includes("?") || baseUrl.includes("#") || baseUrl.includes("\\")
    || /(?:^|[/%])(?:\.\.|%2e%2e)(?:[/%]|$)/iu.test(baseUrl) || baseUrl.includes("..")) {
    throw invalidConfig("NapCat 中继 HTTP 地址无效");
  }
  let address;
  try {
    address = new URL(baseUrl);
  } catch {
    throw invalidConfig("NapCat 中继 HTTP 地址格式无效");
  }
  const ipv4Loopback = /^127(?:\.(\d{1,3})){3}$/u.test(address.hostname)
    && address.hostname.split(".").every(segment => Number(segment) >= 0 && Number(segment) <= 255);
  const isLoopback = address.hostname === "localhost" || address.hostname === "[::1]" || ipv4Loopback;
  if (address.protocol !== "http:" || !isLoopback
    || address.username || address.password || address.search || address.hash
    || !address.pathname || !address.pathname.startsWith("/") || address.pathname.includes("..")) {
    throw invalidConfig("NapCat 中继 HTTP 地址仅允许无凭据、无查询与无锚点的回环地址");
  }
  return address.href;
}

function validateStdioOptions(config) {
  const command = requireIdentifier(config.stdioCommand, "stdioCommand", 4096, msg => invalidConfig(msg));
  let args = [];
  if (config.stdioArgs !== undefined) {
    if (!Array.isArray(config.stdioArgs) || types.isProxy(config.stdioArgs)) {
      throw invalidConfig("stdioArgs 必须是字符串数组");
    }
    args = config.stdioArgs.map((arg, index) => {
      if (typeof arg !== "string" || CONTROL_CHAR_PATTERN.test(arg) || Buffer.byteLength(arg, "utf8") > 8192) {
        throw invalidConfig(`stdioArgs[${index}] 无效`);
      }
      return arg;
    });
  }
  let cwd;
  if (config.stdioCwd !== undefined) {
    cwd = requireIdentifier(config.stdioCwd, "stdioCwd", 4096, msg => invalidConfig(msg));
  }
  let env;
  if (config.stdioEnv !== undefined) {
    const rawEnv = copyPlainRecord(config.stdioEnv, null, () => invalidConfig("stdioEnv 必须是普通对象"));
    env = {};
    for (const [key, val] of Object.entries(rawEnv)) {
      if (!key || CONTROL_CHAR_PATTERN.test(key) || typeof val !== "string" || CONTROL_CHAR_PATTERN.test(val)) {
        throw invalidConfig(`stdioEnv.${key} 无效`);
      }
      env[key] = val;
    }
  }
  const stderr = config.stdioStderr ?? "ignore";
  if (!["ignore", "pipe", "inherit"].includes(stderr)) {
    throw invalidConfig("stdioStderr 必须是 ignore、pipe 或 inherit");
  }
  return Object.freeze({ command, args: Object.freeze(args), cwd, env, stderr });
}

function validateTimeoutMs(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw invalidConfig(`${name} 必须是 ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} 毫秒的安全整数`);
  }
  return value;
}

function brokerSessionMissing(error) {
  const prefix = "Streamable HTTP error: Error POSTing to endpoint: ";
  if (!(error instanceof StreamableHTTPError) || error.code !== 404 || !error.message.startsWith(prefix)) {
    return false;
  }
  const body = error.message.slice(prefix.length);
  if (body.length > 256) return false;
  try {
    return JSON.parse(body)?.error === "Missing or invalid MCP session. Send initialize first.";
  } catch {
    return false;
  }
}

function isToolUnavailableRpcError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === -32601) return true;
  const message = typeof error.message === "string" ? error.message : "";
  return /unknown tool|tool not found|method not found|napcat_file_bundle_/iu.test(message)
    && /not found|unknown|unsupported|disabled/iu.test(message);
}

function extractRawPayload(result, requestSent, lane) {
  const response = copyPlainRecord(result, null, () => transportUnconfirmed(requestSent, lane));
  if (response.isError !== undefined && typeof response.isError !== "boolean") {
    throw transportUnconfirmed(requestSent, lane);
  }
  let value = response.structuredContent;
  if (value === undefined) {
    if (!Array.isArray(response.content) || types.isProxy(response.content)
      || response.content.length !== 1 || !isPlainObject(response.content[0])
      || response.content[0].type !== "text" || typeof response.content[0].text !== "string") {
      throw transportUnconfirmed(requestSent, lane);
    }
    try {
      value = JSON.parse(response.content[0].text);
    } catch {
      throw transportUnconfirmed(requestSent, lane);
    }
  }
  const payload = copyPlainRecord(value, null, () => transportUnconfirmed(requestSent, lane));
  return { isError: response.isError === true, payload };
}

function parseRelayToolResult(result, { lane, requestSent }) {
  const { isError, payload } = extractRawPayload(result, requestSent, lane);
  const failed = isError || payload.ok === false;
  if (!failed) return payload;

  const providerCode = typeof payload.code === "string" && payload.code.trim() ? payload.code.trim() : null;
  if (lane === MACHINE_BUNDLE_LANE && providerCode && BUNDLE_UNAVAILABLE_PROVIDER_CODES.has(providerCode)) {
    throw bundleUnavailable({ request_sent: requestSent, provider_code: providerCode });
  }
  if (!providerCode) {
    throw transportUnconfirmed(requestSent, lane);
  }

  const mappedCode = mapRelayProviderErrorCode(providerCode);
  const rawDetails = isPlainObject(payload.details) ? sanitizeOptionalDetails(payload.details) : {};
  const explicitUnknown = typeof payload.outcome_unknown === "boolean"
    ? payload.outcome_unknown
    : typeof payload.outcomeUnknown === "boolean"
      ? payload.outcomeUnknown
      : typeof rawDetails.outcome_unknown === "boolean"
        ? rawDetails.outcome_unknown
        : (payload.status === "unknown" || payload.outcome === "unknown");

  const promotedFields = [
    "retry_after_ms",
    "frame_length",
    "cq_encoded_length",
    "max_frame_chars",
    "suggest_file_bundle",
    "relay_key",
    "group_id",
    "route_generation",
    "expected_generation",
    "current_generation",
    "reason",
  ];
  const mergedDetails = { ...rawDetails };
  for (const field of promotedFields) {
    if (mergedDetails[field] === undefined && payload[field] !== undefined) {
      const clean = sanitizeOptionalDetails(payload[field]);
      if (clean !== undefined) mergedDetails[field] = clean;
    }
  }
  mergedDetails.provider_code = providerCode;
  mergedDetails.request_sent = requestSent;
  mergedDetails.lane = lane;

  const message = typeof payload.message === "string" && payload.message.trim()
    && !CONTROL_CHAR_PATTERN.test(payload.message) && payload.message.length <= 300
    ? payload.message.trim()
    : `NapCat 中继返回明确错误 (${mappedCode})`;

  throw new RelayError(mappedCode, message, mergedDetails, { outcomeUnknown: explicitUnknown });
}

export function projectRelayRoutesForAddressBook(statusResponse) {
  const status = copyPlainRecord(statusResponse, null, () => invalidInput("statusResponse 必须是普通对象"));
  if (!Array.isArray(status.routes) || types.isProxy(status.routes)) {
    throw invalidInput("statusResponse.routes 必须是数组");
  }
  return status.routes.map((entry, index) => {
    const route = copyPlainRecord(entry, null, () => invalidInput(`routes[${index}] 必须是普通对象`));
    const labelSource = typeof route.expected_group_name === "string" && route.expected_group_name.trim()
      ? route.expected_group_name
      : route.relay_key;
    return Object.freeze({
      machine_id: requireBoundedText(route.peer_machine_id, `routes[${index}].peer_machine_id`, 128),
      channel: requireBoundedText(route.channel, `routes[${index}].channel`, 64),
      group_label: requireBoundedText(labelSource, `routes[${index}].group_label`, 160),
      group_id: requireBoundedText(route.group_id, `routes[${index}].group_id`, 128),
      account_id: requireBoundedText(route.peer_qq_id, `routes[${index}].peer_qq_id`, 128),
      enabled: route.enabled === true && route.role === "active_write",
      relay_mode: route.role === "draining_read" ? "group_draining" : "group",
    });
  });
}

export function mapRelayRouteToBundleRoute(routeInput, options = {}) {
  const route = copyPlainRecord(routeInput, null, () => invalidInput("route 必须是普通对象"));
  const opts = copyPlainRecord(options, ["disclosesRecipients"], () => invalidInput("options 必须是普通对象"));
  if (opts.disclosesRecipients !== undefined && typeof opts.disclosesRecipients !== "boolean") {
    throw invalidInput("disclosesRecipients 必须是布尔值");
  }
  const mapped = {
    relayId: requireIdentifier(route.relay_key, "route.relay_key", 256),
    generation: requirePositiveInt(route.generation, "route.generation"),
    groupId: requireIdentifier(route.group_id, "route.group_id", 128),
    channel: requireIdentifier(route.channel, "route.channel", 64),
    selfQqId: requireIdentifier(route.expected_self_id, "route.expected_self_id", 128),
    peerQqId: requireIdentifier(route.peer_qq_id, "route.peer_qq_id", 128),
    localMachineId: requireIdentifier(route.local_machine_id, "route.local_machine_id", 128),
    peerMachineId: requireIdentifier(route.peer_machine_id, "route.peer_machine_id", 128),
  };
  if (opts.disclosesRecipients !== undefined) {
    mapped.disclosesRecipients = opts.disclosesRecipients;
  }
  return Object.freeze(mapped);
}

function createNoopTransport() {
  return {
    async start() {},
    async send() {},
    async close() {},
  };
}

function validateLaneConfig(spec, fallbackConversationId) {
  const hasBaseUrl = spec.baseUrl !== undefined;
  const hasStdio = spec.stdioCommand !== undefined;
  const hasTransportFactory = spec.transportFactory !== undefined;
  const hasClientFactory = spec.clientFactory !== undefined;

  if ((hasBaseUrl ? 1 : 0) + (hasStdio ? 1 : 0) + (hasTransportFactory ? 1 : 0) > 1) {
    throw invalidConfig("baseUrl、stdioCommand 与 transportFactory 只能选择一种传输模式");
  }
  if (!hasBaseUrl && !hasStdio && !hasTransportFactory && !hasClientFactory) {
    throw invalidConfig("NapCat 中继传输必须配置 baseUrl、stdioCommand、transportFactory 或 clientFactory 之一");
  }
  if (hasTransportFactory && typeof spec.transportFactory !== "function") {
    throw invalidConfig("transportFactory 必须是函数");
  }
  if (hasClientFactory && typeof spec.clientFactory !== "function") {
    throw invalidConfig("clientFactory 必须是函数");
  }

  let baseUrl = null;
  let conversationId = spec.conversationId ?? fallbackConversationId ?? null;
  if (hasBaseUrl) {
    baseUrl = validateLoopbackBaseUrl(spec.baseUrl);
    conversationId = requireIdentifier(conversationId, "conversationId", 256, msg => invalidConfig(msg));
  } else if (conversationId !== null && conversationId !== undefined) {
    conversationId = requireIdentifier(conversationId, "conversationId", 256, msg => invalidConfig(msg));
  }

  const stdio = hasStdio ? validateStdioOptions(spec) : null;
  const mode = hasBaseUrl ? "http" : (hasStdio || hasTransportFactory) ? "stdio" : "injected";

  return Object.freeze({
    mode,
    baseUrl,
    conversationId,
    stdio,
    transportFactory: spec.transportFactory ?? null,
    clientFactory: spec.clientFactory ?? (lane => new Client({ name: `communication-core-${lane}`, version: "0.1.0" })),
  });
}

const TRANSPORT_OPTION_KEYS = [
  "baseUrl",
  "conversationId",
  "stdioCommand",
  "stdioArgs",
  "stdioEnv",
  "stdioCwd",
  "stdioStderr",
  "transportFactory",
  "clientFactory",
  "bundleEnabled",
  "bundleBaseUrl",
  "bundleConversationId",
  "bundleStdioCommand",
  "bundleStdioArgs",
  "bundleStdioEnv",
  "bundleStdioCwd",
  "bundleStdioStderr",
  "bundleTransportFactory",
  "bundleClientFactory",
  "timeoutMs",
  "bundleTimeoutMs",
];

export class NapcatRelayTransport {
  #relayConfig;
  #bundleConfig;
  #bundleEnabled;
  #timeoutMs;
  #bundleTimeoutMs;
  #lanes = new Map();
  #closing = new Set();
  #activeTimers = new Set();
  #activeControllers = new Set();
  #shutdown = new AbortController();
  #closed = false;

  constructor(options = {}) {
    const config = copyPlainRecord(options, TRANSPORT_OPTION_KEYS, () => invalidConfig("NapCat 中继传输配置无效"));
    if (config.bundleEnabled !== undefined && typeof config.bundleEnabled !== "boolean") {
      throw invalidConfig("bundleEnabled 必须是布尔值");
    }
    this.#bundleEnabled = config.bundleEnabled !== false;
    this.#timeoutMs = validateTimeoutMs(config.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#bundleTimeoutMs = validateTimeoutMs(config.bundleTimeoutMs, DEFAULT_BUNDLE_TIMEOUT_MS, "bundleTimeoutMs");

    this.#relayConfig = validateLaneConfig({
      baseUrl: config.baseUrl,
      conversationId: config.conversationId,
      stdioCommand: config.stdioCommand,
      stdioArgs: config.stdioArgs,
      stdioEnv: config.stdioEnv,
      stdioCwd: config.stdioCwd,
      stdioStderr: config.stdioStderr,
      transportFactory: config.transportFactory,
      clientFactory: config.clientFactory,
    }, null);

    const hasBundleOverride = [
      "bundleBaseUrl",
      "bundleStdioCommand",
      "bundleTransportFactory",
      "bundleClientFactory",
    ].some(key => config[key] !== undefined);

    if (this.#bundleEnabled && hasBundleOverride) {
      this.#bundleConfig = validateLaneConfig({
        baseUrl: config.bundleBaseUrl,
        conversationId: config.bundleConversationId,
        stdioCommand: config.bundleStdioCommand,
        stdioArgs: config.bundleStdioArgs,
        stdioEnv: config.bundleStdioEnv,
        stdioCwd: config.bundleStdioCwd,
        stdioStderr: config.bundleStdioStderr,
        transportFactory: config.bundleTransportFactory,
        clientFactory: config.bundleClientFactory,
      }, this.#relayConfig.conversationId);
    } else {
      this.#bundleConfig = this.#relayConfig;
    }

    this.submissionTracking = true;
  }

  get mode() {
    return this.#relayConfig.mode;
  }

  get bundleEnabled() {
    return this.#bundleEnabled;
  }

  get closed() {
    return this.#closed;
  }

  getActiveHandleCounts() {
    return {
      timers: this.#activeTimers.size,
      controllers: this.#activeControllers.size,
      connections: this.#lanes.size,
      closing: this.#closing.size,
    };
  }

  #configForLane(lane) {
    return lane === MACHINE_BUNDLE_LANE ? this.#bundleConfig : this.#relayConfig;
  }

  #createWireTransport(lane, laneConfig) {
    if (laneConfig.transportFactory) {
      const custom = laneConfig.transportFactory(lane);
      if (!custom || typeof custom.close !== "function") {
        throw transportUnconfirmed(false, lane);
      }
      return custom;
    }
    if (laneConfig.baseUrl) {
      return new StreamableHTTPClientTransport(new URL(laneConfig.baseUrl), {
        requestInit: {
          redirect: "error",
          headers: { "x-conversation-id": laneConfig.conversationId },
        },
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
    }
    if (laneConfig.stdio) {
      return new StdioClientTransport({
        command: laneConfig.stdio.command,
        args: [...laneConfig.stdio.args],
        ...(laneConfig.stdio.cwd ? { cwd: laneConfig.stdio.cwd } : {}),
        ...(laneConfig.stdio.env ? { env: { ...laneConfig.stdio.env } } : {}),
        stderr: laneConfig.stdio.stderr,
      });
    }
    return createNoopTransport();
  }

  #disconnect(connection) {
    if (!connection || connection.closed) return;
    connection.closed = true;
    if (this.#lanes.get(connection.lane) === connection) {
      this.#lanes.delete(connection.lane);
    }
    const closing = (async () => {
      if (connection.client && typeof connection.client.close === "function") {
        try {
          await connection.client.close();
          return;
        } catch {
          // Fallback to transport.close() if client.close() fails
        }
      }
      try {
        await connection.transport?.close?.();
      } catch {
        // Ignore transport close errors during cleanup
      }
    })();
    this.#closing.add(closing);
    void closing.then(() => this.#closing.delete(closing));
  }

  #connect(lane) {
    const laneConfig = this.#configForLane(lane);
    const client = laneConfig.clientFactory(lane);
    if (!client || typeof client.connect !== "function" || typeof client.callTool !== "function"
      || typeof client.close !== "function") {
      throw transportUnconfirmed(false, lane);
    }
    const transport = this.#createWireTransport(lane, laneConfig);
    const connectTimeoutMs = lane === MACHINE_BUNDLE_LANE ? this.#bundleTimeoutMs : this.#timeoutMs;
    const connectDeadline = new AbortController();
    this.#activeControllers.add(connectDeadline);
    const connectTimer = setTimeout(() => connectDeadline.abort(), connectTimeoutMs);
    this.#activeTimers.add(connectTimer);
    const connectSignal = AbortSignal.any([connectDeadline.signal, this.#shutdown.signal]);
    const connectOptions = {
      signal: connectSignal,
      timeout: connectTimeoutMs,
      maxTotalTimeout: connectTimeoutMs,
      resetTimeoutOnProgress: false,
    };

    const connection = {
      client,
      transport,
      lane,
      mode: laneConfig.mode,
      closed: false,
      sessionMissing: false,
      inflightCount: 0,
    };
    this.#lanes.set(lane, connection);
    connection.ready = Promise.resolve().then(() => {
      if (connection.closed || this.#closed || connectSignal.aborted) {
        throw transportUnconfirmed(false, lane);
      }
      return client.connect(transport, connectOptions);
    }).catch(() => {
      this.#disconnect(connection);
      throw transportUnconfirmed(false, lane);
    }).finally(() => {
      clearTimeout(connectTimer);
      this.#activeTimers.delete(connectTimer);
      this.#activeControllers.delete(connectDeadline);
    });
    connection.ready.catch(() => {});
    return connection;
  }

  #validateContext(context, defaultTimeoutMs) {
    const ctx = copyPlainRecord(context ?? {}, ["signal", "onRequestStarted", "timeoutMs"], () => invalidInput("调用上下文必须是普通对象"));
    if (ctx.signal !== undefined && (!(ctx.signal instanceof AbortSignal) || ctx.signal.aborted)) {
      throw invalidInput("signal 必须是未中止的 AbortSignal");
    }
    if (ctx.onRequestStarted !== undefined && typeof ctx.onRequestStarted !== "function") {
      throw invalidInput("onRequestStarted 必须是函数");
    }
    const timeoutMs = ctx.timeoutMs === undefined
      ? defaultTimeoutMs
      : validateTimeoutMs(ctx.timeoutMs, defaultTimeoutMs, "timeoutMs");
    return {
      signal: ctx.signal,
      onRequestStarted: ctx.onRequestStarted,
      timeoutMs,
    };
  }

  async #call(name, args, { lane, signal, onRequestStarted, timeoutMs }) {
    if (this.#closed || signal?.aborted) {
      throw transportUnconfirmed(false, lane);
    }
    const isWriteTool = WRITE_TOOLS.has(name);
    const canRetry404 = RETRYABLE_READ_TOOLS.has(name) && !isWriteTool;

    let activeConnection = null;
    let requestSent = false;
    let onAbort;
    const deadline = new AbortController();
    this.#activeControllers.add(deadline);
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    this.#activeTimers.add(timer);

    const requestSignal = AbortSignal.any([
      deadline.signal,
      this.#shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    const options = {
      signal: requestSignal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
      resetTimeoutOnProgress: false,
    };

    const interrupted = new Promise((_, reject) => {
      onAbort = () => {
        if (this.#closed || this.#shutdown.signal.aborted
          || (activeConnection && activeConnection.inflightCount <= 1)) {
          this.#disconnect(activeConnection);
        }
        reject(transportUnconfirmed(requestSent, lane));
      };
      requestSignal.addEventListener("abort", onAbort, { once: true });
    });
    interrupted.catch(() => {});

    try {
      for (let attempt = 0; ; attempt += 1) {
        let structuredFailure = null;
        const connection = this.#lanes.get(lane) ?? this.#connect(lane);
        connection.inflightCount += 1;
        activeConnection = connection;
        try {
          await Promise.race([connection.ready, interrupted]);
          if (requestSignal.aborted || connection.closed || this.#closed) {
            throw transportUnconfirmed(false, lane);
          }
          if (isWriteTool) {
            onRequestStarted?.();
          }
          if (requestSignal.aborted || connection.closed || this.#closed) {
            throw transportUnconfirmed(false, lane);
          }
          requestSent = true;
          const callPromise = Promise.resolve().then(() =>
            connection.client.callTool({ name, arguments: args }, undefined, options),
          );
          callPromise.catch(() => {});
          const result = await Promise.race([callPromise, interrupted]);
          if (requestSignal.aborted || this.#closed) {
            throw transportUnconfirmed(true, lane);
          }
          try {
            return parseRelayToolResult(result, { lane, requestSent: true });
          } catch (parsedError) {
            structuredFailure = parsedError;
            throw parsedError;
          }
        } catch (error) {
          if (structuredFailure && error === structuredFailure) {
            throw error;
          }
          if (lane === MACHINE_BUNDLE_LANE && isToolUnavailableRpcError(error)) {
            throw bundleUnavailable({ request_sent: requestSent });
          }
          const singleRequestAborted = !this.#closed
            && !this.#shutdown.signal.aborted
            && (Boolean(signal?.aborted) || deadline.signal.aborted);
          if (singleRequestAborted) {
            if (connection.inflightCount <= 1) {
              this.#disconnect(connection);
            }
            throw transportUnconfirmed(requestSent, lane);
          }
          const expiredSession = canRetry404
            && connection.mode === "http"
            && (connection.sessionMissing === true || (requestSent && brokerSessionMissing(error)));
          if (expiredSession) {
            connection.sessionMissing = true;
          }
          this.#disconnect(connection);
          if (expiredSession && attempt === 0 && !requestSignal.aborted && !this.#closed) {
            requestSent = false;
            continue;
          }
          if (error instanceof CoreError && error.code === "bundle_transport_unavailable") {
            throw error;
          }
          throw transportUnconfirmed(requestSent, lane);
        } finally {
          connection.inflightCount = Math.max(0, connection.inflightCount - 1);
          if (activeConnection === connection) {
            activeConnection = null;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      this.#activeTimers.delete(timer);
      this.#activeControllers.delete(deadline);
      requestSignal.removeEventListener("abort", onAbort);
    }
  }

  async status(params = {}, ctx = {}) {
    const request = copyPlainRecord(params ?? {}, ["include_live_check"], () => invalidInput("status 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#timeoutMs);
    const args = {};
    if (request.include_live_check !== undefined) {
      if (typeof request.include_live_check !== "boolean") {
        throw invalidInput("include_live_check 必须是布尔值");
      }
      args.include_live_check = request.include_live_check;
    }
    return this.#call("napcat_relay_status", args, { lane: MACHINE_RELAY_LANE, ...scope });
  }

  async sendFrame(params, ctx = {}) {
    const request = copyPlainRecord(params, [
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
    ], () => invalidInput("sendFrame 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#timeoutMs);

    const dedupeKey = requireIdentifier(request.dedupe_key, "dedupe_key", 256);
    const targetMachine = requireIdentifier(request.target_machine, "target_machine", 128);
    if (typeof request.op !== "string" || !RELAY_ALLOWED_OP_SET.has(request.op)) {
      throw invalidInput("op 不在允许的中继操作白名单内");
    }
    const source = requireIdentifier(request.source, "source", 512);
    if (!Array.isArray(request.recipients) || types.isProxy(request.recipients)
      || request.recipients.length < 1 || request.recipients.length > 16) {
      throw invalidInput("recipients 必须是包含 1..16 个收件人的数组");
    }
    const recipients = request.recipients.map((item, index) => requireIdentifier(item, `recipients[${index}]`, 512));
    if (typeof request.body !== "string") {
      throw invalidInput("body 必须是字符串");
    }

    const args = {
      dedupe_key: dedupeKey,
      target_machine: targetMachine,
      op: request.op,
      source,
      recipients,
      body: request.body,
      ...validateReplyRouteTriple(request),
    };
    if (request.channel !== undefined) {
      args.channel = requireIdentifier(request.channel, "channel", 64);
    }
    if (request.in_reply_to !== undefined) {
      args.in_reply_to = requireIdentifier(request.in_reply_to, "in_reply_to", 256);
    }
    if (request.meta !== undefined) {
      if (!isPlainObject(request.meta)) throw invalidInput("meta 必须是普通对象");
      args.meta = sanitizeJsonValue(request.meta);
    }
    if (request.allow_disclose_recipients !== undefined) {
      if (typeof request.allow_disclose_recipients !== "boolean") {
        throw invalidInput("allow_disclose_recipients 必须是布尔值");
      }
      args.allow_disclose_recipients = request.allow_disclose_recipients;
    }

    return this.#call("napcat_relay_send", args, { lane: MACHINE_RELAY_LANE, ...scope });
  }

  async poll(params = {}, ctx = {}) {
    const request = copyPlainRecord(params ?? {}, ["relay_keys", "max_pages"], () => invalidInput("poll 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#timeoutMs);
    const args = {};
    if (request.relay_keys !== undefined) {
      if (!Array.isArray(request.relay_keys) || types.isProxy(request.relay_keys)
        || request.relay_keys.length < 1 || request.relay_keys.length > 32) {
        throw invalidInput("relay_keys 必须是包含 1..32 项的数组");
      }
      args.relay_keys = request.relay_keys.map((key, index) => requireIdentifier(key, `relay_keys[${index}]`, 256));
    }
    if (request.max_pages !== undefined) {
      args.max_pages = requirePositiveInt(request.max_pages, "max_pages", 50);
    }
    return this.#call("napcat_relay_poll", args, { lane: MACHINE_RELAY_LANE, ...scope });
  }

  async readEvents(params = {}, ctx = {}) {
    const request = copyPlainRecord(params ?? {}, ["cursor", "limit", "relay_key"], () => invalidInput("readEvents 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#timeoutMs);
    const args = {};
    if (request.cursor !== undefined && request.cursor !== null) {
      args.cursor = requireIdentifier(request.cursor, "cursor", 4096);
    }
    if (request.limit !== undefined) {
      args.limit = requirePositiveInt(request.limit, "limit", 50);
    }
    if (request.relay_key !== undefined) {
      args.relay_key = requireIdentifier(request.relay_key, "relay_key", 256);
    }
    return this.#call("napcat_relay_events_read", args, { lane: MACHINE_RELAY_LANE, ...scope });
  }

  async sendBundle(input, ctx = {}) {
    if (!this.#bundleEnabled) throw bundleUnavailable();
    const request = copyPlainRecord(input, [
      "dedupe_key",
      "target_machine",
      "channel",
      "reply_relay_key",
      "reply_group_id",
      "reply_route_generation",
      "allow_disclose_recipients",
      "op",
      "source",
      "recipients",
      "meta",
      "payload_json",
      "attachments",
    ], () => invalidInput("sendBundle 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#bundleTimeoutMs);

    const dedupeKey = requireIdentifier(request.dedupe_key, "dedupe_key", 256);
    const targetMachine = requireIdentifier(request.target_machine, "target_machine", 80);
    if (typeof request.op !== "string" || !LOWER_OP_PATTERN.test(request.op) || BUNDLE_DISALLOWED_OPS.has(request.op)) {
      throw invalidInput("sendBundle 的 op 必须是受支持的小写业务操作且不可为 file_notice/file_ack");
    }
    const source = requireIdentifier(request.source, "source", 512);
    if (!Array.isArray(request.recipients) || types.isProxy(request.recipients)
      || request.recipients.length < 1 || request.recipients.length > 16) {
      throw invalidInput("recipients 必须是包含 1..16 个收件人的数组");
    }
    const recipients = request.recipients.map((item, index) => requireIdentifier(item, `recipients[${index}]`, 512));
    if (!isPlainObject(request.meta)) {
      throw invalidInput("meta 必须是必填普通对象");
    }
    const meta = sanitizeJsonValue(request.meta);
    if (!Object.hasOwn(request, "payload_json") || request.payload_json === undefined) {
      throw invalidInput("payload_json 为必填字段");
    }
    const payloadJson = sanitizeJsonValue(request.payload_json);

    const args = {
      dedupe_key: dedupeKey,
      target_machine: targetMachine,
      op: request.op,
      source,
      recipients,
      meta,
      payload_json: payloadJson,
      ...validateReplyRouteTriple(request),
    };
    if (request.channel !== undefined) {
      args.channel = requireIdentifier(request.channel, "channel", 256);
    }
    if (request.allow_disclose_recipients !== undefined) {
      if (typeof request.allow_disclose_recipients !== "boolean") {
        throw invalidInput("allow_disclose_recipients 必须是布尔值");
      }
      args.allow_disclose_recipients = request.allow_disclose_recipients;
    }
    if (request.attachments !== undefined) {
      if (!Array.isArray(request.attachments) || types.isProxy(request.attachments) || request.attachments.length > 63) {
        throw invalidInput("attachments 必须是最多 63 项的数组");
      }
      args.attachments = request.attachments.map((item, index) => {
        const attachment = copyPlainRecord(item, ["name", "filePath"], () => invalidInput(`attachments[${index}] 必须仅含 name 与 filePath`));
        return {
          name: requireIdentifier(attachment.name, `attachments[${index}].name`, 256),
          filePath: requireIdentifier(attachment.filePath, `attachments[${index}].filePath`, 4096),
        };
      });
    }

    return this.#call("napcat_file_bundle_send", args, { lane: MACHINE_BUNDLE_LANE, ...scope });
  }

  async pollBundles(params = {}, ctx = {}) {
    if (!this.#bundleEnabled) throw bundleUnavailable();
    const request = copyPlainRecord(params ?? {}, ["relay_keys", "cursor", "limit"], () => invalidInput("pollBundles 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#bundleTimeoutMs);
    const args = {};
    if (request.relay_keys !== undefined) {
      if (!Array.isArray(request.relay_keys) || types.isProxy(request.relay_keys)
        || request.relay_keys.length < 1 || request.relay_keys.length > 16) {
        throw invalidInput("relay_keys 必须是包含 1..16 项的数组");
      }
      args.relay_keys = request.relay_keys.map((key, index) => requireIdentifier(key, `relay_keys[${index}]`, 80));
    }
    if (request.cursor !== undefined) {
      args.cursor = request.cursor === null ? null : requireHex64(request.cursor, "cursor");
    }
    if (request.limit !== undefined) {
      args.limit = requirePositiveInt(request.limit, "limit", 32);
    }
    return this.#call("napcat_file_bundle_poll", args, { lane: MACHINE_BUNDLE_LANE, ...scope });
  }

  async readBundleEvents(params = {}, ctx = {}) {
    if (!this.#bundleEnabled) throw bundleUnavailable();
    const request = copyPlainRecord(params ?? {}, ["cursor", "limit"], () => invalidInput("readBundleEvents 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#bundleTimeoutMs);
    const args = {};
    if (request.cursor !== undefined) {
      args.cursor = request.cursor === null ? null : requireHex64(request.cursor, "cursor");
    }
    if (request.limit !== undefined) {
      args.limit = requirePositiveInt(request.limit, "limit", 32);
    }
    return this.#call("napcat_file_bundle_events_read", args, { lane: MACHINE_BUNDLE_LANE, ...scope });
  }

  async ackBundleEvents(params, ctx = {}) {
    if (!this.#bundleEnabled) throw bundleUnavailable();
    const request = copyPlainRecord(params, ["event_ids"], () => invalidInput("ackBundleEvents 参数必须是普通对象"));
    const scope = this.#validateContext(ctx, this.#bundleTimeoutMs);
    if (!Array.isArray(request.event_ids) || types.isProxy(request.event_ids)
      || request.event_ids.length < 1 || request.event_ids.length > 32) {
      throw invalidInput("event_ids 必须是包含 1..32 个 64 位小写 hex 标识的数组");
    }
    const eventIds = request.event_ids.map((id, index) => requireHex64(id, `event_ids[${index}]`));
    return this.#call("napcat_file_bundle_events_ack", { event_ids: eventIds }, { lane: MACHINE_BUNDLE_LANE, ...scope });
  }

  async close() {
    this.#closed = true;
    this.#shutdown.abort();
    for (const controller of [...this.#activeControllers]) {
      controller.abort();
    }
    for (const timer of [...this.#activeTimers]) {
      clearTimeout(timer);
    }
    this.#activeTimers.clear();
    this.#activeControllers.clear();
    for (const connection of [...this.#lanes.values()]) {
      this.#disconnect(connection);
    }
    await Promise.allSettled([...this.#closing]);
  }
}

/* ============================================================================
 * InMemoryRelayBus: Multi-node offline synthetic relay + file-bundle bus
 * ========================================================================== */

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n|\r/gu, "\n");
}

function defaultCqEncodedLength(text) {
  let extra = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "&" || ch === "[" || ch === "]" || ch === ",") {
      extra += 4;
    }
  }
  return text.length + extra;
}

function defaultEncodeFrame(input, { maxFrameChars = DEFAULT_MAX_FRAME_CHARS } = {}) {
  const relayId = input.relay_id ?? `rly_${randomUUID()}`;
  const normalizedBody = normalizeNewlines(input.body ?? "");
  const bodySha256 = sha256Hex(normalizedBody);
  const metaJson = JSON.stringify(input.meta ?? {});
  const headerLines = [
    "[COMM_RELAY_V1]",
    `relay_id: ${relayId}`,
    `op: ${input.op}`,
    `from_machine: ${input.from_machine}`,
    `to_machine: ${input.to_machine}`,
    `source: ${input.source}`,
    `recipients: ${input.recipients.join(", ")}`,
  ];
  if (input.in_reply_to) headerLines.push(`in_reply_to: ${input.in_reply_to}`);
  headerLines.push(`body_sha256: ${bodySha256}`);
  headerLines.push(`meta: ${metaJson}`);
  headerLines.push("---");

  const bodyLines = normalizedBody.length === 0
    ? []
    : normalizedBody.split("\n").map(line => (line.length === 0 ? "|" : `| ${line}`));

  const frameText = [...headerLines, ...bodyLines, "[END_COMM_RELAY_V1]"].join("\n");
  const charLength = frameText.length;
  const cqLength = defaultCqEncodedLength(frameText);
  return {
    relayId,
    frameText,
    bodySha256,
    normalizedBody,
    charLength,
    cqLength,
    exceedsLimit: charLength > maxFrameChars || cqLength > maxFrameChars,
    maxFrameChars,
  };
}

function encodeBusCursor(sequence, scopeRelayKey = null) {
  return Buffer.from(JSON.stringify({ seq: sequence, relay_key: scopeRelayKey }), "utf8").toString("base64url");
}

function decodeBusCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !Number.isSafeInteger(parsed.seq) || parsed.seq < 0) {
      return null;
    }
    if (parsed.relay_key !== null && typeof parsed.relay_key !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function busError(code, message, details = {}, outcomeUnknown = false) {
  return {
    isError: true,
    structuredContent: {
      ok: false,
      code,
      message,
      details,
      outcome_unknown: outcomeUnknown,
    },
  };
}

function setBoundedMap(map, key, value, maxSize = DEFAULT_MAX_DEDUPE_ENTRIES) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function addBoundedSet(set, value, maxSize = DEFAULT_MAX_DEDUPE_ENTRIES) {
  if (set.has(value)) {
    set.delete(value);
  }
  set.add(value);
  while (set.size > maxSize) {
    const oldestValue = set.values().next().value;
    set.delete(oldestValue);
  }
}

function busSuccess(payload) {
  return {
    isError: false,
    structuredContent: payload,
  };
}

export class InMemoryRelayBus {
  #now;
  #frameCodec;
  #maxEventsPerRoute;
  #retentionMs;
  #machines = new Map();
  #routes = new Map();
  #groupMessages = new Map();
  #machineState = new Map();
  #bundleTransfers = new Map();
  #seqCounter = 0;

  constructor({
    now = () => Date.now(),
    frameCodec = null,
    maxEventsPerRoute = DEFAULT_MAX_EVENTS_PER_ROUTE,
    retentionMs = DEFAULT_RETENTION_MS,
  } = {}) {
    if (typeof now !== "function") throw invalidConfig("now 必须是函数");
    this.#now = now;
    this.#frameCodec = frameCodec;
    this.#maxEventsPerRoute = requirePositiveInt(maxEventsPerRoute, "maxEventsPerRoute", 100_000, msg => invalidConfig(msg));
    this.#retentionMs = requirePositiveInt(retentionMs, "retentionMs", 365 * 24 * 60 * 60 * 1000, msg => invalidConfig(msg));
  }

  #ensureMachineState(machineId) {
    let state = this.#machineState.get(machineId);
    if (!state) {
      state = {
        dedupeMap: new Map(),
        rateBuckets: new Map(),
        pollOffsets: new Map(),
        eventSeq: 0,
        minRetainedSeq: 1,
        minRetainedSeqByRoute: new Map(),
        events: [],
        pendingGaps: new Map(),
        bundleDedupe: new Map(),
        incomingBundlesPendingPoll: [],
        incomingSpool: new Map(),
        outgoingSpool: new Map(),
        ackedEventIds: new Set(),
      };
      this.#machineState.set(machineId, state);
    }
    return state;
  }

  registerMachine({ machine_id, qq_id, bundle_enabled = true }) {
    const id = requireIdentifier(machine_id, "machine_id", 128);
    const qq = requireIdentifier(qq_id, "qq_id", 128);
    if (typeof bundle_enabled !== "boolean") throw invalidInput("bundle_enabled 必须是布尔值");
    const entry = { machine_id: id, qq_id: qq, bundle_enabled };
    this.#machines.set(id, entry);
    this.#ensureMachineState(id);
    return { ...entry };
  }

  registerRoute({
    relay_key,
    group_id,
    expected_group_name = null,
    channel = "qq",
    members,
    generation = 1,
    role = "active_write",
    enabled = true,
    drain_until = null,
    legacy_training_coexistence = false,
    allow_file_bundle_write = true,
    allow_recipient_list_disclosure = false,
    max_frame_chars = DEFAULT_MAX_FRAME_CHARS,
    rate_limit_per_minute = DEFAULT_RATE_LIMIT_PER_MINUTE,
  }) {
    const key = requireIdentifier(relay_key, "relay_key", 256);
    const groupId = requireIdentifier(group_id, "group_id", 128);
    const chan = requireIdentifier(channel, "channel", 64);
    if (!Array.isArray(members) || members.length !== 2) {
      throw invalidInput("中继路由必须绑定正好 2 台已注册机器");
    }
    const [m1, m2] = members.map((item, idx) => requireIdentifier(item, `members[${idx}]`, 128));
    if (m1 === m2 || !this.#machines.has(m1) || !this.#machines.has(m2)) {
      throw invalidInput("中继路由成员必须是两台不同的已注册机器");
    }
    if (!["active_write", "draining_read"].includes(role)) {
      throw invalidInput("role 必须是 active_write 或 draining_read");
    }
    const gen = requirePositiveInt(generation, "generation");
    const maxChars = requirePositiveInt(max_frame_chars, "max_frame_chars", MAX_CONFIGURABLE_FRAME_CHARS);
    const rateLimit = requirePositiveInt(rate_limit_per_minute, "rate_limit_per_minute", 10_000);
    const legacy = legacy_training_coexistence === true;
    const bundleWrite = legacy ? false : allow_file_bundle_write === true;

    const route = {
      relay_key: key,
      group_id: groupId,
      expected_group_name: expected_group_name ? requireBoundedText(expected_group_name, "expected_group_name", 160) : key,
      channel: chan,
      members: [m1, m2],
      generation: gen,
      role,
      enabled: enabled === true,
      drain_until: drain_until === null ? null : typeof drain_until === "number" ? new Date(drain_until).toISOString() : String(drain_until),
      legacy_training_coexistence: legacy,
      allow_file_bundle_write: bundleWrite,
      allow_recipient_list_disclosure: allow_recipient_list_disclosure === true,
      max_frame_chars: maxChars,
      rate_limit_per_minute: rateLimit,
    };
    this.#routes.set(key, route);
    if (!this.#groupMessages.has(key)) {
      this.#groupMessages.set(key, []);
    }
    return { ...route, members: [...route.members] };
  }

  rotateRoute({
    from_relay_key,
    new_relay_key,
    new_group_id,
    new_expected_group_name = null,
    new_generation = null,
    drain_until = null,
    legacy_training_coexistence,
    allow_file_bundle_write,
    allow_recipient_list_disclosure,
    max_frame_chars,
    rate_limit_per_minute,
  }) {
    const oldRoute = this.#routes.get(from_relay_key);
    if (!oldRoute) throw invalidInput(`未找到待切换路由: ${from_relay_key}`);
    oldRoute.role = "draining_read";
    oldRoute.drain_until = drain_until === null
      ? new Date(this.#now() + 3_600_000).toISOString()
      : typeof drain_until === "number"
        ? new Date(drain_until).toISOString()
        : String(drain_until);

    return this.registerRoute({
      relay_key: new_relay_key,
      group_id: new_group_id,
      expected_group_name: new_expected_group_name ?? new_relay_key,
      channel: oldRoute.channel,
      members: [...oldRoute.members],
      generation: new_generation ?? (oldRoute.generation + 1),
      role: "active_write",
      enabled: true,
      drain_until: null,
      legacy_training_coexistence: legacy_training_coexistence ?? oldRoute.legacy_training_coexistence,
      allow_file_bundle_write: allow_file_bundle_write ?? oldRoute.allow_file_bundle_write,
      allow_recipient_list_disclosure: allow_recipient_list_disclosure ?? oldRoute.allow_recipient_list_disclosure,
      max_frame_chars: max_frame_chars ?? oldRoute.max_frame_chars,
      rate_limit_per_minute: rate_limit_per_minute ?? oldRoute.rate_limit_per_minute,
    });
  }

  setRouteState(relayKey, patch = {}) {
    const route = this.#routes.get(relayKey);
    if (!route) throw invalidInput(`未找到路由: ${relayKey}`);
    if (patch.role !== undefined) route.role = patch.role;
    if (patch.enabled !== undefined) route.enabled = patch.enabled === true;
    if (patch.generation !== undefined) route.generation = requirePositiveInt(patch.generation, "generation");
    if (patch.group_id !== undefined) route.group_id = requireIdentifier(patch.group_id, "group_id", 128);
    if (patch.drain_until !== undefined) {
      route.drain_until = patch.drain_until === null
        ? null
        : typeof patch.drain_until === "number"
          ? new Date(patch.drain_until).toISOString()
          : String(patch.drain_until);
    }
    if (patch.legacy_training_coexistence !== undefined) {
      route.legacy_training_coexistence = patch.legacy_training_coexistence === true;
      if (route.legacy_training_coexistence) route.allow_file_bundle_write = false;
    }
    if (patch.allow_file_bundle_write !== undefined) {
      route.allow_file_bundle_write = route.legacy_training_coexistence ? false : patch.allow_file_bundle_write === true;
    }
    if (patch.allow_recipient_list_disclosure !== undefined) {
      route.allow_recipient_list_disclosure = patch.allow_recipient_list_disclosure === true;
    }
    return { ...route, members: [...route.members] };
  }

  injectHistoryGap(machineId, relayKey, { code = "RELAY_HISTORY_GAP", message = "中继群历史存在断档", from_seq = 1, to_seq = 2 } = {}) {
    const state = this.#ensureMachineState(machineId);
    const list = state.pendingGaps.get(relayKey) ?? [];
    list.push({ relay_key: relayKey, code, message, from_seq, to_seq, detected_at: new Date(this.#now()).toISOString() });
    state.pendingGaps.set(relayKey, list);
  }

  trimEvents(machineId, keepLastCount = 0) {
    const state = this.#ensureMachineState(machineId);
    if (keepLastCount <= 0) {
      state.minRetainedSeq = state.eventSeq + 1;
      state.minRetainedSeqByRoute.clear();
      state.events = [];
      return;
    }
    if (state.events.length > keepLastCount) {
      state.events = state.events.slice(-keepLastCount);
      state.minRetainedSeq = state.events[0].sequence;
    }
  }

  getSpoolStats(machineId) {
    const state = this.#ensureMachineState(machineId);
    let incomingBytes = 0;
    let outgoingBytes = 0;
    for (const item of state.incomingSpool.values()) incomingBytes += item.bytes;
    for (const item of state.outgoingSpool.values()) outgoingBytes += item.bytes;
    return {
      incomingCount: state.incomingSpool.size,
      outgoingCount: state.outgoingSpool.size,
      incomingBytes,
      outgoingBytes,
      totalBytes: incomingBytes + outgoingBytes,
      pendingEventIds: [...state.incomingSpool.keys()],
    };
  }

  #routesForMachine(machineId) {
    const local = this.#machines.get(machineId);
    if (!local) throw invalidInput(`未知机器: ${machineId}`);
    const list = [];
    for (const route of this.#routes.values()) {
      if (!route.members.includes(machineId)) continue;
      const peerMachineId = route.members[0] === machineId ? route.members[1] : route.members[0];
      const peer = this.#machines.get(peerMachineId);
      list.push({
        relay_key: route.relay_key,
        generation: route.generation,
        group_id: route.group_id,
        expected_group_name: route.expected_group_name,
        channel: route.channel,
        local_machine_id: machineId,
        expected_self_id: local.qq_id,
        peer_machine_id: peerMachineId,
        peer_qq_id: peer.qq_id,
        role: route.role,
        enabled: route.enabled,
        drain_until: route.drain_until,
        legacy_training_coexistence: route.legacy_training_coexistence,
        allow_file_bundle_write: route.allow_file_bundle_write,
        allow_recipient_list_disclosure: route.allow_recipient_list_disclosure,
      });
    }
    return list;
  }

  #resolveRouteForSend(machineId, input, { forBundle = false } = {}) {
    const channel = input.channel ?? "qq";
    const hasReplyPin = input.reply_relay_key !== undefined;
    if (hasReplyPin) {
      const route = this.#routes.get(input.reply_relay_key);
      if (!route || !route.enabled || !route.members.includes(machineId)
        || !route.members.includes(input.target_machine) || route.channel !== channel) {
        return { error: busError("RELAY_ROUTE_NOT_FOUND", "未找到指定的原路回执路由", { relay_key: input.reply_relay_key }) };
      }
      if (route.group_id !== input.reply_group_id || route.generation !== input.reply_route_generation) {
        return {
          error: busError("RELAY_ROUTE_CHANGED", "原路回执路由群号或代次已变化", {
            relay_key: route.relay_key,
            expected_generation: input.reply_route_generation,
            current_generation: route.generation,
            group_id: route.group_id,
          }),
        };
      }
      if (route.role === "draining_read" && route.drain_until !== null) {
        const deadlineMs = Date.parse(route.drain_until);
        if (Number.isFinite(deadlineMs) && this.#now() > deadlineMs) {
          return {
            error: busError("RELAY_ROUTE_DRAIN_EXPIRED", "旧中继群排空期已过，禁止继续回执", {
              relay_key: route.relay_key,
              group_id: route.group_id,
              route_generation: route.generation,
              drain_until: route.drain_until,
            }),
          };
        }
      }
      if (forBundle && (route.role !== "active_write" || route.legacy_training_coexistence || route.allow_file_bundle_write !== true)) {
        return {
          error: busError("RELAY_FILE_ROUTE_DENIED", "该中继路由未获准纯数据文件包写入", {
            relay_key: route.relay_key,
            role: route.role,
            legacy_training_coexistence: route.legacy_training_coexistence,
          }),
        };
      }
      return { route };
    }

    const candidates = [...this.#routes.values()].filter(route =>
      route.enabled
      && route.role === "active_write"
      && route.channel === channel
      && route.members.includes(machineId)
      && route.members.includes(input.target_machine));

    if (candidates.length === 0) {
      return { error: busError("RELAY_ROUTE_NOT_FOUND", "未找到发往目标机器的可用写入路由", { target_machine: input.target_machine }) };
    }
    if (candidates.length > 1) {
      return {
        error: busError("RELAY_ROUTE_AMBIGUOUS", "存在多条目标机器写入路由，请明确指定路线", {
          target_machine: input.target_machine,
          candidates: candidates.map(c => c.relay_key),
        }),
      };
    }
    const route = candidates[0];
    if (forBundle && (route.legacy_training_coexistence || route.allow_file_bundle_write !== true)) {
      return {
        error: busError("RELAY_FILE_ROUTE_DENIED", "该中继路由未获准纯数据文件包写入", {
          relay_key: route.relay_key,
          legacy_training_coexistence: route.legacy_training_coexistence,
        }),
      };
    }
    return { route };
  }

  #checkRecipientDisclosure(route, input) {
    const totalRecipients = Math.max(
      input.recipients?.length ?? 0,
      Array.isArray(input.meta?.all_recipients) ? input.meta.all_recipients.length : 0,
    );
    if (totalRecipients > 1 && (input.allow_disclose_recipients === false || route.allow_recipient_list_disclosure !== true)) {
      return busError("RELAY_RECIPIENT_DISCLOSURE_BLOCKED", "当前中继群未获准公开多收件人名单", {
        relay_key: route.relay_key,
        recipient_count: totalRecipients,
      });
    }
    return null;
  }

  #encodeFrame(route, fromMachine, input) {
    const codecFn = this.#frameCodec && typeof this.#frameCodec.encodeRelayFrame === "function"
      ? this.#frameCodec.encodeRelayFrame.bind(this.#frameCodec)
      : this.#frameCodec && typeof this.#frameCodec.encode === "function"
        ? this.#frameCodec.encode.bind(this.#frameCodec)
        : null;
    if (codecFn) {
      let encoded;
      try {
        encoded = codecFn({
          op: input.op,
          from_machine: fromMachine,
          to_machine: input.target_machine,
          source: input.source,
          recipients: input.recipients,
          body: input.body,
          in_reply_to: input.in_reply_to,
          meta: input.meta,
        }, { maxFrameChars: route.max_frame_chars });
      } catch (error) {
        if (error instanceof CoreError && error.code === "relay_frame_too_large") {
          return {
            error: busError("RELAY_FRAME_TOO_LARGE", error.message, {
              frame_length: error.details?.frame_length,
              cq_encoded_length: error.details?.cq_encoded_length,
              max_frame_chars: route.max_frame_chars,
              suggest_file_bundle: true,
            }),
          };
        }
        throw error;
      }
      const cqLength = typeof encoded.cqLength === "number"
        ? encoded.cqLength
        : typeof this.#frameCodec.cqEncodedLength === "function"
          ? this.#frameCodec.cqEncodedLength(encoded.frameText)
          : defaultCqEncodedLength(encoded.frameText);
      const charLength = typeof encoded.charLength === "number"
        ? encoded.charLength
        : encoded.frameText.length;
      return {
        relayId: encoded.relayId,
        frameText: encoded.frameText,
        bodySha256: encoded.bodySha256,
        normalizedBody: normalizeNewlines(input.body ?? ""),
        charLength,
        cqLength,
        exceedsLimit: charLength > route.max_frame_chars || cqLength > route.max_frame_chars,
        maxFrameChars: route.max_frame_chars,
      };
    }
    return defaultEncodeFrame({
      op: input.op,
      from_machine: fromMachine,
      to_machine: input.target_machine,
      source: input.source,
      recipients: input.recipients,
      body: input.body,
      in_reply_to: input.in_reply_to,
      meta: input.meta,
    }, { maxFrameChars: route.max_frame_chars });
  }

  #checkRateLimit(state, route) {
    const nowMs = this.#now();
    const key = route.relay_key;
    const timestamps = (state.rateBuckets.get(key) ?? []).filter(ts => nowMs - ts < RATE_LIMIT_WINDOW_MS);
    if (timestamps.length >= route.rate_limit_per_minute) {
      const oldest = timestamps[0];
      const retryAfterMs = Math.max(1, RATE_LIMIT_WINDOW_MS - (nowMs - oldest));
      state.rateBuckets.set(key, timestamps);
      return busError("RELAY_RATE_LIMITED", "中继群发送频率超出每分钟上限", {
        relay_key: route.relay_key,
        retry_after_ms: retryAfterMs,
        limit: route.rate_limit_per_minute,
        window_ms: RATE_LIMIT_WINDOW_MS,
      });
    }
    timestamps.push(nowMs);
    state.rateBuckets.set(key, timestamps);
    return null;
  }

  #handleStatus(machineId, args) {
    const local = this.#machines.get(machineId);
    const routes = this.#routesForMachine(machineId);
    const peerMap = new Map();
    for (const route of routes) {
      if (!peerMap.has(route.peer_machine_id)) {
        peerMap.set(route.peer_machine_id, {
          machine_id: route.peer_machine_id,
          qq_id: route.peer_qq_id,
          channel: route.channel,
        });
      }
    }
    return busSuccess({
      ok: true,
      local_machine_id: machineId,
      expected_self_id: local.qq_id,
      routes,
      peers: [...peerMap.values()],
      conflicts: [],
      limits: {
        max_frame_chars: DEFAULT_MAX_FRAME_CHARS,
        rate_limit_per_minute: DEFAULT_RATE_LIMIT_PER_MINUTE,
      },
      retention: {
        max_events_per_route: this.#maxEventsPerRoute,
        retention_ms: this.#retentionMs,
      },
      ...(args.include_live_check === true
        ? { live_check: { ok: true, checked_at: new Date(this.#now()).toISOString() } }
        : {}),
    });
  }

  #handleSend(machineId, args) {
    const local = this.#machines.get(machineId);
    const state = this.#ensureMachineState(machineId);

    const fingerprint = sha256Hex(stableStringify({
      target_machine: args.target_machine,
      channel: args.channel ?? "qq",
      reply_relay_key: args.reply_relay_key ?? null,
      reply_group_id: args.reply_group_id ?? null,
      reply_route_generation: args.reply_route_generation ?? null,
      op: args.op,
      source: args.source,
      recipients: args.recipients,
      body: args.body,
      in_reply_to: args.in_reply_to ?? null,
      meta: args.meta ?? null,
      allow_disclose_recipients: args.allow_disclose_recipients ?? null,
    }));

    const existing = state.dedupeMap.get(args.dedupe_key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return busError("RELAY_DEDUPE_CONFLICT", "同一 dedupe_key 已被用于不同内容或目标", {
          dedupe_key: args.dedupe_key,
        });
      }
      return busSuccess({
        ...existing.receipt,
        status: "duplicate",
      });
    }

    const { route, error: routeError } = this.#resolveRouteForSend(machineId, args, { forBundle: false });
    if (routeError) return routeError;

    const disclosureError = this.#checkRecipientDisclosure(route, args);
    if (disclosureError) return disclosureError;

    const encoded = this.#encodeFrame(route, machineId, args);
    if (encoded.error) return encoded.error;
    if (encoded.exceedsLimit) {
      return busError("RELAY_FRAME_TOO_LARGE", "明文帧超出 UTF-16 或 CQ 编码长度上限", {
        frame_length: encoded.charLength,
        cq_encoded_length: encoded.cqLength,
        max_frame_chars: encoded.maxFrameChars,
        suggest_file_bundle: true,
      });
    }

    const rateError = this.#checkRateLimit(state, route);
    if (rateError) return rateError;

    this.#seqCounter += 1;
    const realSeq = String(this.#seqCounter);
    const onebotMessageId = `ob_${this.#seqCounter}`;
    const receivedAt = new Date(this.#now()).toISOString();

    const messageRecord = {
      seq: this.#seqCounter,
      real_seq: realSeq,
      onebot_message_id: onebotMessageId,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.generation,
      sender_id: local.qq_id,
      source_machine: machineId,
      received_at: receivedAt,
      frame: {
        relay_id: encoded.relayId,
        op: args.op,
        from_machine: machineId,
        to_machine: args.target_machine,
        source: args.source,
        recipients: [...args.recipients],
        in_reply_to: args.in_reply_to ?? null,
        body: encoded.normalizedBody,
        body_sha256: encoded.bodySha256,
        meta: args.meta ?? {},
        raw_frame: encoded.frameText,
      },
    };
    const groupMessages = this.#groupMessages.get(route.relay_key);
    groupMessages.push(messageRecord);
    if (groupMessages.length > DEFAULT_MAX_GROUP_MESSAGES) {
      groupMessages.splice(0, groupMessages.length - DEFAULT_MAX_GROUP_MESSAGES);
    }

    const receipt = {
      ok: true,
      status: "sent_verified",
      transport_stage: "group_received",
      relay_id: encoded.relayId,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.generation,
      onebot_message_id: onebotMessageId,
      real_seq: realSeq,
      body_sha256: encoded.bodySha256,
      outcome_unknown: false,
      frame_length: encoded.charLength,
    };
    setBoundedMap(state.dedupeMap, args.dedupe_key, { fingerprint, receipt });
    return busSuccess(receipt);
  }

  #pruneMachineEvents(state) {
    const perRouteCounts = new Map();
    const keepFlags = new Array(state.events.length).fill(false);
    const evictedMaxSeqByRoute = new Map();
    for (let i = state.events.length - 1; i >= 0; i -= 1) {
      const evt = state.events[i];
      const count = perRouteCounts.get(evt.relay_key) ?? 0;
      if (count < this.#maxEventsPerRoute) {
        perRouteCounts.set(evt.relay_key, count + 1);
        keepFlags[i] = true;
      } else {
        const prev = evictedMaxSeqByRoute.get(evt.relay_key) ?? 0;
        if (evt.sequence > prev) {
          evictedMaxSeqByRoute.set(evt.relay_key, evt.sequence);
        }
      }
    }
    if (evictedMaxSeqByRoute.size > 0) {
      state.events = state.events.filter((_, idx) => keepFlags[idx]);
      for (const [relayKey, evictedSeq] of evictedMaxSeqByRoute.entries()) {
        const prevMin = state.minRetainedSeqByRoute.get(relayKey) ?? 1;
        const nextMin = evictedSeq + 1;
        if (nextMin > prevMin) {
          state.minRetainedSeqByRoute.set(relayKey, nextMin);
        }
      }
    }
  }

  #handlePoll(machineId, args) {
    const state = this.#ensureMachineState(machineId);
    const machineRoutes = this.#routesForMachine(machineId);
    const requestedKeys = args.relay_keys ? new Set(args.relay_keys) : null;
    const selectedRoutes = machineRoutes.filter(r => !requestedKeys || requestedKeys.has(r.relay_key));

    const scannedRoutes = [];
    const historyGaps = [];
    let ingestedCount = 0;
    let ignoredCount = 0;

    for (const routeView of selectedRoutes) {
      const messages = this.#groupMessages.get(routeView.relay_key) ?? [];
      const lastPolledSeq = state.pollOffsets.get(routeView.relay_key) ?? 0;
      const fresh = messages.filter(msg => msg.seq > lastPolledSeq);
      let routeIngested = 0;
      let routeIgnored = 0;

      for (const msg of fresh) {
        if (msg.source_machine === machineId) {
          routeIgnored += 1;
          ignoredCount += 1;
          continue;
        }
        if (msg.sender_id !== routeView.peer_qq_id) {
          routeIgnored += 1;
          ignoredCount += 1;
          continue;
        }
        state.eventSeq += 1;
        state.events.push({
          event_id: `evt_${machineId}_${state.eventSeq}`,
          sequence: state.eventSeq,
          relay_key: msg.relay_key,
          group_id: msg.group_id,
          route_generation: msg.route_generation,
          sender_id: msg.sender_id,
          source_machine: msg.source_machine,
          received_at: msg.received_at,
          frame: structuredClone(msg.frame),
        });
        routeIngested += 1;
        ingestedCount += 1;
      }
      if (messages.length > 0) {
        state.pollOffsets.set(routeView.relay_key, messages[messages.length - 1].seq);
      }

      const gaps = state.pendingGaps.get(routeView.relay_key) ?? [];
      for (const gap of gaps) historyGaps.push({ ...gap });

      scannedRoutes.push({
        relay_key: routeView.relay_key,
        group_id: routeView.group_id,
        route_generation: routeView.generation,
        role: routeView.role,
        ingested_count: routeIngested,
        ignored_count: routeIgnored,
      });
    }

    this.#pruneMachineEvents(state);

    return busSuccess({
      ok: true,
      scanned_routes: scannedRoutes,
      ingested_count: ingestedCount,
      ignored_count: ignoredCount,
      history_gaps: historyGaps,
      retention: {
        max_events_per_route: this.#maxEventsPerRoute,
        retention_ms: this.#retentionMs,
      },
    });
  }

  #handleEventsRead(machineId, args) {
    const state = this.#ensureMachineState(machineId);
    const scopeRelayKey = args.relay_key ?? null;
    const limit = args.limit ?? 20;
    let afterSeq = 0;

    if (args.cursor !== undefined) {
      const decoded = decodeBusCursor(args.cursor);
      if (!decoded) {
        return busError("RELAY_CURSOR_INVALID", "中继事件游标格式无效");
      }
      if (decoded.relay_key !== scopeRelayKey) {
        return busError("RELAY_CURSOR_SCOPE_MISMATCH", "中继事件游标与当前查询路由范围不匹配", {
          expected_relay_key: decoded.relay_key,
          actual_relay_key: scopeRelayKey,
        });
      }
      const effectiveMinRetained = scopeRelayKey !== null
        ? Math.max(state.minRetainedSeq, state.minRetainedSeqByRoute.get(scopeRelayKey) ?? 1)
        : Math.max(state.minRetainedSeq, ...state.minRetainedSeqByRoute.values());
      if (decoded.seq > 0 && decoded.seq < effectiveMinRetained - 1) {
        return busError("RELAY_CURSOR_EXPIRED", "中继事件游标已超出本机保留窗口", {
          cursor_seq: decoded.seq,
          min_retained_seq: effectiveMinRetained,
        });
      }
      afterSeq = decoded.seq;
    }

    const filtered = state.events.filter(evt =>
      evt.sequence > afterSeq && (!scopeRelayKey || evt.relay_key === scopeRelayKey));
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const lastSeq = page.length > 0 ? page[page.length - 1].sequence : afterSeq;
    const nextCursor = lastSeq > 0 ? encodeBusCursor(lastSeq, scopeRelayKey) : null;

    const routeGaps = [];
    for (const [relayKey, gaps] of state.pendingGaps.entries()) {
      if (scopeRelayKey && relayKey !== scopeRelayKey) continue;
      for (const gap of gaps) routeGaps.push({ ...gap });
    }

    return busSuccess({
      ok: true,
      events: structuredClone(page),
      next_cursor: nextCursor,
      has_more: hasMore,
      retention: {
        max_events_per_route: this.#maxEventsPerRoute,
        retention_ms: this.#retentionMs,
      },
      route_gaps: routeGaps,
    });
  }

  #handleBundleSend(machineId, args) {
    const local = this.#machines.get(machineId);
    if (!local.bundle_enabled) {
      return busError("RELAY_FILE_INTEGRATION_DISABLED", "本机文件包入口未启用");
    }
    const state = this.#ensureMachineState(machineId);

    const payloadBytes = Buffer.byteLength(JSON.stringify(args.payload_json), "utf8");
    const attachmentCount = args.attachments?.length ?? 0;
    const estimatedBytes = payloadBytes + attachmentCount * 4096;

    const fingerprint = sha256Hex(stableStringify({
      target_machine: args.target_machine,
      channel: args.channel ?? "qq",
      reply_relay_key: args.reply_relay_key ?? null,
      reply_group_id: args.reply_group_id ?? null,
      reply_route_generation: args.reply_route_generation ?? null,
      allow_disclose_recipients: args.allow_disclose_recipients ?? null,
      op: args.op,
      source: args.source,
      recipients: args.recipients,
      meta: args.meta,
      payload_json: args.payload_json,
      attachments: args.attachments ?? [],
    }));

    const dedupeScopeKey = `${args.source}\0${args.dedupe_key}`;
    const existing = state.bundleDedupe.get(dedupeScopeKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return busError("RELAY_FILE_ID_CONFLICT", "同一去重编号已用于内容或目标不同的一笔文件传输", {
          dedupe_key: args.dedupe_key,
        });
      }
      return busSuccess({
        ...existing.receipt,
        status: "duplicate",
      });
    }

    const { route, error: routeError } = this.#resolveRouteForSend(machineId, args, { forBundle: true });
    if (routeError) return routeError;

    const disclosureError = this.#checkRecipientDisclosure(route, args);
    if (disclosureError) return disclosureError;

    const bundleId = randomUUID();
    const bundleSha256 = sha256Hex(`${bundleId}:${fingerprint}`);
    const eventId = sha256Hex(JSON.stringify([
      machineId,
      args.target_machine,
      bundleId,
      bundleSha256,
      route.group_id,
      route.generation,
    ]));

    const transfer = {
      event_id: eventId,
      bundle_id: bundleId,
      bundle_sha256: bundleSha256,
      bytes: estimatedBytes,
      sender_id: local.qq_id,
      source_machine: machineId,
      target_machine: args.target_machine,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.generation,
      op: args.op,
      source: args.source,
      recipients: [...args.recipients],
      meta: structuredClone(args.meta),
      payload_json: structuredClone(args.payload_json),
      staged_files: (args.attachments ?? []).map((att, index) => ({
        name: att.name,
        filePath: `spool://${args.target_machine}/${eventId.slice(0, 12)}/${index}-${att.name}`,
        bytes: 4096,
        sha256: sha256Hex(`${eventId}:${att.name}:${att.filePath}`),
      })),
      created_at: new Date(this.#now()).toISOString(),
    };

    setBoundedMap(this.#bundleTransfers, eventId, transfer);
    state.outgoingSpool.set(eventId, { event_id: eventId, bundle_id: bundleId, bytes: estimatedBytes });

    const targetState = this.#ensureMachineState(args.target_machine);
    targetState.incomingBundlesPendingPoll.push(transfer);

    const receipt = {
      ok: true,
      status: "sent_verified",
      stage: "uploaded",
      bundle_id: bundleId,
      bundle_sha256: bundleSha256,
      bytes: estimatedBytes,
      relay_key: route.relay_key,
      group_id: route.group_id,
      route_generation: route.generation,
      outcome_unknown: false,
      reason: null,
    };
    setBoundedMap(state.bundleDedupe, dedupeScopeKey, { fingerprint, receipt });
    return busSuccess(receipt);
  }

  #handleBundlePoll(machineId, args) {
    const local = this.#machines.get(machineId);
    if (!local.bundle_enabled) {
      return busError("RELAY_FILE_INTEGRATION_DISABLED", "本机文件包入口未启用");
    }
    const state = this.#ensureMachineState(machineId);
    const limit = args.limit ?? 16;
    const relayFilter = args.relay_keys ? new Set(args.relay_keys) : null;
    const cursor = args.cursor ?? null;

    const remaining = [];
    const matched = [];
    for (const transfer of state.incomingBundlesPendingPoll) {
      if (relayFilter && !relayFilter.has(transfer.relay_key)) {
        remaining.push(transfer);
        continue;
      }
      if (cursor && transfer.event_id <= cursor) {
        remaining.push(transfer);
        continue;
      }
      matched.push(transfer);
    }

    matched.sort((a, b) => a.event_id.localeCompare(b.event_id));
    const page = matched.slice(0, limit);
    const overflow = matched.slice(limit);
    state.incomingBundlesPendingPoll = [...remaining, ...overflow];

    const results = [];
    for (const transfer of page) {
      const senderMachine = this.#machines.get(transfer.source_machine);
      const verifiedSenderId = senderMachine?.qq_id ?? transfer.sender_id;
      const stagedEvent = {
        event_id: transfer.event_id,
        bundle_id: transfer.bundle_id,
        sender_id: verifiedSenderId,
        source_machine: transfer.source_machine,
        target_machine: transfer.target_machine,
        relay_key: transfer.relay_key,
        group_id: transfer.group_id,
        route_generation: transfer.route_generation,
        received_at: new Date(this.#now()).toISOString(),
        op: transfer.op,
        source: transfer.source,
        recipients: [...transfer.recipients],
        meta: structuredClone(transfer.meta),
        payload_json: structuredClone(transfer.payload_json),
        staged_files: structuredClone(transfer.staged_files),
      };
      state.incomingSpool.set(transfer.event_id, {
        event: stagedEvent,
        bytes: transfer.bytes,
      });
      results.push({
        event_id: transfer.event_id,
        bundle_id: transfer.bundle_id,
        relay_key: transfer.relay_key,
        status: "received",
      });
    }

    const nextCursor = overflow.length > 0 && page.length > 0 ? page[page.length - 1].event_id : null;
    return busSuccess({
      ok: true,
      results,
      next_cursor: nextCursor,
      maintenance: { archived: 0, needs_review: 0 },
    });
  }

  #handleBundleEventsRead(machineId, args) {
    const local = this.#machines.get(machineId);
    if (!local.bundle_enabled) {
      return busError("RELAY_FILE_INTEGRATION_DISABLED", "本机文件包入口未启用");
    }
    const state = this.#ensureMachineState(machineId);
    const limit = args.limit ?? 16;
    const cursor = args.cursor ?? null;

    const readyIds = [...state.incomingSpool.keys()]
      .filter(id => !state.ackedEventIds.has(id) && (!cursor || id > cursor))
      .sort();
    const pageIds = readyIds.slice(0, limit);
    const hasMore = readyIds.length > limit;
    const events = pageIds.map(id => structuredClone(state.incomingSpool.get(id).event));

    return busSuccess({
      ok: true,
      events,
      errors: [],
      next_cursor: hasMore && pageIds.length > 0 ? pageIds[pageIds.length - 1] : null,
    });
  }

  #handleBundleEventsAck(machineId, args) {
    const local = this.#machines.get(machineId);
    if (!local.bundle_enabled) {
      return busError("RELAY_FILE_INTEGRATION_DISABLED", "本机文件包入口未启用");
    }
    const state = this.#ensureMachineState(machineId);
    const results = [];
    const notFound = [];

    for (const eventId of new Set(args.event_ids)) {
      if (state.ackedEventIds.has(eventId)) {
        results.push({ event_id: eventId, status: "recorded", release: "released" });
        continue;
      }
      const staged = state.incomingSpool.get(eventId);
      if (!staged) {
        notFound.push(eventId);
        continue;
      }
      state.incomingSpool.delete(eventId);
      addBoundedSet(state.ackedEventIds, eventId);
      this.#bundleTransfers.delete(eventId);
      const sourceState = this.#ensureMachineState(staged.event.source_machine);
      sourceState.outgoingSpool.delete(eventId);
      results.push({ event_id: eventId, status: "recorded", release: "released" });
    }

    return busSuccess({
      ok: true,
      results,
      not_found: notFound,
    });
  }

  #invokeTool(machineId, name, args) {
    switch (name) {
      case "napcat_relay_status":
        return this.#handleStatus(machineId, args);
      case "napcat_relay_send":
        return this.#handleSend(machineId, args);
      case "napcat_relay_poll":
        return this.#handlePoll(machineId, args);
      case "napcat_relay_events_read":
        return this.#handleEventsRead(machineId, args);
      case "napcat_file_bundle_send":
        return this.#handleBundleSend(machineId, args);
      case "napcat_file_bundle_poll":
        return this.#handleBundlePoll(machineId, args);
      case "napcat_file_bundle_events_read":
        return this.#handleBundleEventsRead(machineId, args);
      case "napcat_file_bundle_events_ack":
        return this.#handleBundleEventsAck(machineId, args);
      default:
        return busError("RELAY_TOOL_UNKNOWN", `未知中继工具: ${name}`);
    }
  }

  createTransportFor(machineId, options = {}) {
    if (!this.#machines.has(machineId)) {
      throw invalidInput(`未知机器: ${machineId}`);
    }
    const opts = copyPlainRecord(options, ["bundleEnabled", "timeoutMs", "bundleTimeoutMs"], () => invalidConfig("createTransportFor 选项无效"));
    return new NapcatRelayTransport({
      ...opts,
      clientFactory: () => ({
        async connect() {},
        callTool: async ({ name, arguments: args }) => this.#invokeTool(machineId, name, args ?? {}),
        async close() {},
      }),
    });
  }
}
