import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const RELAY_GROUPS_SCHEMA_VERSION = 1;
export const ALLOWED_RELAY_ROLES = Object.freeze(["active_write", "draining_read"]);
export const DEFAULT_RELAY_LIMITS = Object.freeze({
  max_frame_chars: 1800,
  max_recipients_per_frame: 16,
  max_sends_per_minute_per_group: 20,
  max_poll_pages: 10,
  max_history_pages_per_poll: 10,
  max_events_per_route: 2000,
  max_global_events: 2000,
  max_cache_bytes: 1024 * 1024,
  max_send_records: 2000,
});

const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const NUMERIC_ID_RE = /^[1-9]\d{0,19}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const TOP_LEVEL_KEYS = [
  "schema_version",
  "schemaVersion",
  "local_machine_id",
  "expected_self_id",
  "limits",
  "peers",
  "relays",
];

const LIMIT_SPECS = Object.freeze({
  max_frame_chars: { defaultValue: 1800, min: 256, max: 1900 },
  max_recipients_per_frame: { defaultValue: 16, min: 1, max: 64 },
  max_sends_per_minute_per_group: { defaultValue: 20, min: 1, max: 120 },
  max_poll_pages: { defaultValue: 10, min: 1, max: 50 },
  max_history_pages_per_poll: { defaultValue: 10, min: 1, max: 50 },
  max_events_per_route: { defaultValue: 2000, min: 50, max: 2000 },
  max_global_events: { defaultValue: 2000, min: 50, max: 2000 },
  max_cache_bytes: { defaultValue: 1024 * 1024, min: 65536, max: 1024 * 1024 },
  max_send_records: { defaultValue: 2000, min: 100, max: 5000 },
});

const PEER_KEYS = ["qq_id", "enabled", "display_name", "channels", "allowed_relays"];

const RELAY_KEYS = [
  "group_id",
  "channel",
  "role",
  "enabled",
  "generation",
  "target_machines",
  "allowed_peers",
  "expected_group_name",
  "expected_member_count",
  "verify_member_count",
  "drain_until",
  "bootstrap_at",
  "allow_recipient_list_disclosure",
  "legacy_training_coexistence",
  "allow_file_bundle_write",
  "file_bundle_folder_id",
  "file_bundle_folder_name",
];

const RESOLVE_ROUTE_OPTION_KEYS = [
  "target_machine",
  "channel",
  "mode",
  "relay_key",
  "expected_generation",
  "expected_group_id",
  "now",
];

const REVERIFY_OPTION_KEYS = ["allowDraining", "requireFileBundleWrite", "now"];

const FROZEN_ROUTE_KEYS = [
  "relay_key",
  "generation",
  "group_id",
  "channel",
  "local_machine_id",
  "expected_self_id",
  "peer_machine_id",
  "peer_qq_id",
  "role",
  "drain_until",
  "expected_group_name",
  "expected_member_count",
  "verify_member_count",
  "allow_recipient_list_disclosure",
  "legacy_training_coexistence",
  "allow_file_bundle_write",
  "file_bundle_folder_id",
  "file_bundle_folder_name",
];

export class RelayError extends Error {
  constructor(code, message, details = null, options = {}) {
    const safeOptions = options && typeof options === "object" ? options : {};
    super(message, safeOptions.cause ? { cause: safeOptions.cause } : undefined);
    this.name = "RelayError";
    this.code = code;
    this.details = details ?? null;
    this.outcomeUnknown = Boolean(safeOptions.outcomeUnknown);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key]);
    }
  }
  return Object.freeze(value);
}

function assertPlainObject(value, name, allowedKeys = null, errorCode = "RELAY_CONFIG_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RelayError(errorCode, `${name} 必须是普通对象`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new RelayError(errorCode, `${name} 必须是普通对象`);
  }
  const allowedSet = allowedKeys ? new Set(allowedKeys) : null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new RelayError(errorCode, `${name} 包含非字符串属性键`);
    }
    if (FORBIDDEN_KEYS.has(key)) {
      throw new RelayError(errorCode, `${name} 禁止包含原型保留键：${key}`);
    }
    if (CONTROL_CHAR_RE.test(key)) {
      throw new RelayError(errorCode, `${name} 包含含控制字符的属性键`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new RelayError(errorCode, `${name}.${key} 必须是普通数据属性`);
    }
    if (allowedSet && !allowedSet.has(key)) {
      throw new RelayError(errorCode, `${name} 包含未允许字段：${key}`, { field: key });
    }
  }
}

function assertNoPrototypeKeysRecursive(value, name, depth = 0, errorCode = "RELAY_CONFIG_INVALID") {
  if (depth > 24) {
    throw new RelayError(errorCode, `${name} 嵌套层级过深`);
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoPrototypeKeysRecursive(value[i], `${name}[${i}]`, depth + 1, errorCode);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new RelayError(errorCode, `${name} 包含非法对象原型`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key) || CONTROL_CHAR_RE.test(key)) {
      throw new RelayError(errorCode, `${name} 包含非法属性键`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new RelayError(errorCode, `${name}.${key} 必须是普通数据属性`);
    }
    assertNoPrototypeKeysRecursive(descriptor.value, `${name}.${key}`, depth + 1, errorCode);
  }
}

function validateSafeIdentifier(value, name, errorCode = "RELAY_CONFIG_INVALID") {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || CONTROL_CHAR_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || value === "*"
    || !SAFE_ID_RE.test(value)
  ) {
    throw new RelayError(errorCode, `${name} 必须是合法标识符（1-64 位字母数字及 ._-，无空白/控制字符）`);
  }
  return value;
}

function validateChannel(value, name, errorCode = "RELAY_CONFIG_INVALID") {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || CONTROL_CHAR_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || !CHANNEL_RE.test(value)
  ) {
    throw new RelayError(errorCode, `${name} 必须是合法通道名（小写字母开头，1-32 位）`);
  }
  return value;
}

function normalizeNumericId(value, name, errorCode = "RELAY_CONFIG_INVALID", required = true) {
  if (value === undefined || value === null || value === "") {
    if (!required) return "";
    throw new RelayError(errorCode, `${name} 不能为空`);
  }
  let normalized;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RelayError(errorCode, `${name} 必须是正整数或数字字符串`);
    }
    normalized = String(value);
  } else if (typeof value === "string") {
    if (value.trim() !== value || CONTROL_CHAR_RE.test(value)) {
      throw new RelayError(errorCode, `${name} 不能包含首尾空白或控制字符`);
    }
    normalized = value;
  } else {
    throw new RelayError(errorCode, `${name} 必须是数字字符串`);
  }
  if (!NUMERIC_ID_RE.test(normalized)) {
    throw new RelayError(errorCode, `${name} 必须是 1-20 位正数字标识`);
  }
  return normalized;
}

function validateOptionalLabel(value, name, maxLength = 128, errorCode = "RELAY_CONFIG_INVALID") {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim() !== value || value.length > maxLength || CONTROL_CHAR_RE.test(value)) {
    throw new RelayError(errorCode, `${name} 必须是长度不超过 ${maxLength} 且无控制字符的单行字符串`);
  }
  return value;
}

function validateOptionalIsoDate(value, name, errorCode = "RELAY_CONFIG_INVALID") {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() !== value || value.length > 64 || CONTROL_CHAR_RE.test(value)) {
    throw new RelayError(errorCode, `${name} 必须是合法 ISO-8601 时间字符串`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RelayError(errorCode, `${name} 无法解析为有效时间戳`);
  }
  return new Date(parsed).toISOString();
}

function validateBoolean(value, name, defaultValue, errorCode = "RELAY_CONFIG_INVALID") {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new RelayError(errorCode, `${name} 必须是布尔值`);
  }
  return value;
}

function validateOptionalBundleFolderId(value, name, errorCode = "RELAY_CONFIG_INVALID") {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || !value
    || value.length > 512
    || value === "/"
    || value === "."
    || value === ".."
    || /[\\\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RelayError(errorCode, `${name} 必须是非根、无空白与控制字符的有效群文件目录 ID（1-512 位）`);
  }
  return value;
}

function validateOptionalBundleFolderName(value, name, errorCode = "RELAY_CONFIG_INVALID") {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || CONTROL_CHAR_RE.test(value)
    || FORBIDDEN_KEYS.has(value)
    || !SAFE_ID_RE.test(value)
  ) {
    throw new RelayError(errorCode, `${name} 必须是合法单级目录名（1-64 位字母数字及 ._-）`);
  }
  return value;
}

function validatePathString(value, name, errorCode = "RELAY_INVALID_ARGUMENT") {
  if (typeof value !== "string" || !value.trim() || CONTROL_CHAR_RE.test(value)) {
    throw new RelayError(errorCode, `${name} 必须是有效非空路径字符串且不含控制字符`);
  }
  return value.trim();
}

function expandEnvVars(value, env) {
  return String(value).replace(/%([^%]+)%/g, (match, key) => (env && Object.hasOwn(env, key) ? String(env[key]) : match));
}

function readJsonStrict(filePath, missingCode, invalidJsonCode, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new RelayError(missingCode, `${label} 不存在：${filePath}`, { path: filePath }, { cause: error });
    }
    throw new RelayError(invalidJsonCode, `无法访问 ${label}：${filePath}`, { path: filePath }, { cause: error });
  }
  if (!stat.isFile()) {
    throw new RelayError(invalidJsonCode, `${label} 必须是普通文件：${filePath}`, { path: filePath });
  }
  if (stat.size <= 0 || stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new RelayError(
      invalidJsonCode,
      `${label} 大小异常（${stat.size} 字节，上限 ${MAX_CONFIG_FILE_BYTES}）`,
      { path: filePath, size: stat.size },
    );
  }
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    throw new RelayError(invalidJsonCode, `无法读取 ${label}：${filePath}`, { path: filePath }, { cause: error });
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new RelayError(invalidJsonCode, `${label} JSON 解析失败：${filePath}`, { path: filePath }, { cause: error });
  }
  assertNoPrototypeKeysRecursive(parsed, label, 0, invalidJsonCode);
  return parsed;
}

function canonicalizeForHash(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  const sorted = {};
  const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of keys) {
    if (value[key] === undefined) continue;
    sorted[key] = canonicalizeForHash(value[key]);
  }
  return sorted;
}

function readBindingSummary(bindingPath) {
  const resolvedBindingPath = path.resolve(validatePathString(bindingPath, "bindingPath", "RELAY_CONFIG_PATH_UNRESOLVED"));
  const raw = readJsonStrict(
    resolvedBindingPath,
    "RELAY_BINDING_NOT_FOUND",
    "RELAY_BINDING_INVALID_JSON",
    "binding.json",
  );
  assertPlainObject(raw, "binding.json", null, "RELAY_BINDING_INVALID");
  const expectedSelfId = normalizeNumericId(raw.expectedSelfId, "binding.expectedSelfId", "RELAY_BINDING_INVALID", false);
  const groupId = normalizeNumericId(raw.groupId, "binding.groupId", "RELAY_BINDING_INVALID", false);
  const controlPlaneTargetKeys = new Set();
  const controlPlaneTargetsById = new Map();

  if (raw.controlPlane !== undefined && raw.controlPlane !== null) {
    assertPlainObject(raw.controlPlane, "binding.controlPlane", null, "RELAY_BINDING_INVALID");
    if (raw.controlPlane.targets !== undefined && raw.controlPlane.targets !== null) {
      assertPlainObject(raw.controlPlane.targets, "binding.controlPlane.targets", null, "RELAY_BINDING_INVALID");
      for (const [targetKey, rawTarget] of Object.entries(raw.controlPlane.targets)) {
        const trimmedKey = targetKey.trim();
        if (trimmedKey) controlPlaneTargetKeys.add(trimmedKey);
        if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) continue;
        const targetId = rawTarget.id === undefined || rawTarget.id === null ? "" : String(rawTarget.id).trim();
        if (!targetId) continue;
        const existing = controlPlaneTargetsById.get(targetId) ?? [];
        existing.push({
          target_key: trimmedKey,
          type: typeof rawTarget.type === "string" ? rawTarget.type.trim().toLowerCase() : "",
        });
        controlPlaneTargetsById.set(targetId, existing);
      }
    }
  }

  return {
    bindingPath: resolvedBindingPath,
    expectedSelfId,
    groupId,
    controlPlaneTargetKeys,
    controlPlaneTargetsById,
  };
}

function validateLimits(rawLimits) {
  if (rawLimits === undefined) {
    return { ...DEFAULT_RELAY_LIMITS };
  }
  assertPlainObject(rawLimits, "limits", Object.keys(LIMIT_SPECS));
  const normalized = {};
  for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
    if (rawLimits[key] === undefined) {
      normalized[key] = spec.defaultValue;
      continue;
    }
    const value = rawLimits[key];
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
      throw new RelayError(
        "RELAY_CONFIG_INVALID",
        `limits.${key} 必须是 ${spec.min}..${spec.max} 范围内的安全整数`,
        { field: `limits.${key}`, min: spec.min, max: spec.max },
      );
    }
    normalized[key] = value;
  }
  if (rawLimits.max_poll_pages !== undefined && rawLimits.max_history_pages_per_poll !== undefined
    && rawLimits.max_poll_pages !== rawLimits.max_history_pages_per_poll) {
    throw new RelayError("RELAY_CONFIG_INVALID", "limits.max_poll_pages 与 limits.max_history_pages_per_poll 不一致");
  }
  if (rawLimits.max_history_pages_per_poll !== undefined && rawLimits.max_poll_pages === undefined) {
    normalized.max_poll_pages = normalized.max_history_pages_per_poll;
  } else if (rawLimits.max_poll_pages !== undefined && rawLimits.max_history_pages_per_poll === undefined) {
    normalized.max_history_pages_per_poll = normalized.max_poll_pages;
  }
  return normalized;
}

function validateStringArray(value, name, itemValidator, { required = false, allowEmpty = false, maxLength = 64 } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new RelayError("RELAY_CONFIG_INVALID", `${name} 必须是非空数组`);
    }
    return null;
  }
  if (!Array.isArray(value)) {
    throw new RelayError("RELAY_CONFIG_INVALID", `${name} 必须是数组`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new RelayError("RELAY_CONFIG_INVALID", `${name} 不能为空数组`);
  }
  if (value.length > maxLength) {
    throw new RelayError("RELAY_CONFIG_INVALID", `${name} 数量超过上限 ${maxLength}`);
  }
  const seen = new Set();
  const result = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = itemValidator(value[i], `${name}[${i}]`);
    if (seen.has(item)) {
      throw new RelayError("RELAY_CONFIG_INVALID", `${name} 包含重复项：${item}`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function makeConflict({ code, scope, relay_key = null, group_id = null, target_machine = null, channel = null, peer_machine_id = null, message, details = null }) {
  return {
    code,
    severity: "error",
    scope,
    relay_key,
    group_id,
    target_machine,
    channel,
    peer_machine_id,
    message,
    details: details ?? null,
  };
}

function assertValidConfigObject(config) {
  if (
    !config
    || typeof config !== "object"
    || config.schema_version !== RELAY_GROUPS_SCHEMA_VERSION
    || typeof config.local_machine_id !== "string"
    || typeof config.expected_self_id !== "string"
    || !config.peers
    || typeof config.peers !== "object"
    || !config.relays
    || typeof config.relays !== "object"
    || !Array.isArray(config.conflicts)
  ) {
    throw new RelayError("RELAY_CONFIG_INVALID", "传入的 relay 配置快照无效");
  }
}

function resolveNowMs(nowOption) {
  if (nowOption === undefined || nowOption === null) return Date.now();
  const raw = typeof nowOption === "function" ? nowOption() : nowOption;
  const ms = raw instanceof Date ? raw.getTime() : (typeof raw === "number" ? raw : Date.parse(String(raw)));
  if (!Number.isFinite(ms)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "now 必须是有效时间戳或 Date");
  }
  return ms;
}

export function isRelayRouteDrainExpired(route, nowOption = Date.now()) {
  if (!route || route.role !== "draining_read" || !route.drain_until) return false;
  const drainMs = Date.parse(route.drain_until);
  if (!Number.isFinite(drainMs)) return true;
  return resolveNowMs(nowOption) >= drainMs;
}

function buildFrozenRouteSnapshot(config, route, peer) {
  return Object.freeze({
    relay_key: route.relay_key,
    generation: route.generation,
    group_id: route.group_id,
    channel: route.channel,
    local_machine_id: config.local_machine_id,
    expected_self_id: config.expected_self_id,
    peer_machine_id: peer ? peer.machine_id : null,
    peer_qq_id: peer ? peer.qq_id : null,
    role: route.role,
    drain_until: route.drain_until,
    expected_group_name: route.expected_group_name,
    expected_member_count: route.expected_member_count,
    verify_member_count: route.verify_member_count,
    allow_recipient_list_disclosure: route.allow_recipient_list_disclosure,
    legacy_training_coexistence: route.legacy_training_coexistence,
    allow_file_bundle_write: route.allow_file_bundle_write,
    file_bundle_folder_id: route.file_bundle_folder_id,
    file_bundle_folder_name: route.file_bundle_folder_name,
  });
}

function throwFirstConflict(conflicts, fallbackMessage) {
  const first = conflicts[0];
  throw new RelayError(
    first.code,
    first.message || fallbackMessage,
    {
      conflict: first,
      conflicts,
      ...(first.details && typeof first.details === "object" ? first.details : {}),
    },
  );
}

export function resolveRelayGroupsPath({ bindingPath, relayGroupsPath, env = process.env } = {}) {
  if (relayGroupsPath !== undefined && relayGroupsPath !== null && relayGroupsPath !== "") {
    const validated = validatePathString(relayGroupsPath, "relayGroupsPath", "RELAY_CONFIG_PATH_UNRESOLVED");
    return path.resolve(expandEnvVars(validated, env));
  }
  const envPath = env?.NAPCAT_RELAY_GROUPS_PATH;
  if (envPath !== undefined && envPath !== null && String(envPath).trim() !== "") {
    const validated = validatePathString(String(envPath), "NAPCAT_RELAY_GROUPS_PATH", "RELAY_CONFIG_PATH_UNRESOLVED");
    return path.resolve(expandEnvVars(validated, env));
  }
  if (bindingPath !== undefined && bindingPath !== null && String(bindingPath).trim() !== "") {
    const validatedBinding = validatePathString(String(bindingPath), "bindingPath", "RELAY_CONFIG_PATH_UNRESOLVED");
    return path.join(path.dirname(path.resolve(expandEnvVars(validatedBinding, env))), "relay-groups.json");
  }
  throw new RelayError(
    "RELAY_CONFIG_PATH_UNRESOLVED",
    "无法解析 relay-groups.json 路径：缺少 relayGroupsPath、NAPCAT_RELAY_GROUPS_PATH 或 bindingPath",
  );
}

export function loadAndValidateRelayConfig({ bindingPath, relayGroupsPath, env = process.env } = {}) {
  const binding = readBindingSummary(bindingPath);
  const resolvedRelayGroupsPath = resolveRelayGroupsPath({
    bindingPath: binding.bindingPath,
    relayGroupsPath,
    env,
  });

  const raw = readJsonStrict(
    resolvedRelayGroupsPath,
    "RELAY_CONFIG_NOT_FOUND",
    "RELAY_CONFIG_INVALID_JSON",
    "relay-groups.json",
  );
  assertPlainObject(raw, "relay-groups.json", TOP_LEVEL_KEYS);

  if (raw.schema_version !== undefined && raw.schemaVersion !== undefined) {
    throw new RelayError("RELAY_CONFIG_INVALID", "relay-groups.json 不能同时声明 schema_version 与 schemaVersion");
  }
  const schemaVersion = raw.schema_version ?? raw.schemaVersion;
  if (schemaVersion !== RELAY_GROUPS_SCHEMA_VERSION) {
    throw new RelayError(
      "RELAY_CONFIG_INVALID",
      `不支持的 relay-groups schema_version=${String(schemaVersion)}，仅支持 ${RELAY_GROUPS_SCHEMA_VERSION}`,
    );
  }

  const localMachineId = validateSafeIdentifier(raw.local_machine_id, "local_machine_id");
  const declaredExpectedSelfId = normalizeNumericId(raw.expected_self_id, "expected_self_id", "RELAY_CONFIG_INVALID", false);
  const effectiveExpectedSelfId = declaredExpectedSelfId || binding.expectedSelfId;
  if (!effectiveExpectedSelfId) {
    throw new RelayError("RELAY_CONFIG_INVALID", "relay-groups.json 与 binding.json 均未声明有效的 expected_self_id");
  }

  const limits = validateLimits(raw.limits);

  assertPlainObject(raw.peers, "peers");
  assertPlainObject(raw.relays, "relays");

  const conflicts = [];
  const globalConflicts = [];
  const routeConflictsByKey = new Map();
  const peerConflictsByMachine = new Map();

  function recordConflict(conflict) {
    conflicts.push(conflict);
    if (conflict.scope === "global") {
      globalConflicts.push(conflict);
    }
    if (conflict.relay_key) {
      const list = routeConflictsByKey.get(conflict.relay_key) ?? [];
      list.push(conflict);
      routeConflictsByKey.set(conflict.relay_key, list);
    }
    if (conflict.peer_machine_id) {
      const list = peerConflictsByMachine.get(conflict.peer_machine_id) ?? [];
      list.push(conflict);
      peerConflictsByMachine.set(conflict.peer_machine_id, list);
    }
  }

  if (declaredExpectedSelfId && binding.expectedSelfId && declaredExpectedSelfId !== binding.expectedSelfId) {
    recordConflict(makeConflict({
      code: "RELAY_SELF_ID_MISMATCH",
      scope: "global",
      message: `relay-groups.json 的 expected_self_id (${declaredExpectedSelfId}) 与 binding.expectedSelfId (${binding.expectedSelfId}) 不一致`,
      details: {
        declared_expected_self_id: declaredExpectedSelfId,
        binding_expected_self_id: binding.expectedSelfId,
      },
    }));
  }

  // 解析并校验 peers
  const peers = {};
  const peerMachinesByQq = new Map();
  const sortedPeerKeys = Object.keys(raw.peers).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const rawPeerKey of sortedPeerKeys) {
    const machineId = validateSafeIdentifier(rawPeerKey, `peers.${rawPeerKey}`);
    if (machineId === localMachineId) {
      throw new RelayError("RELAY_CONFIG_INVALID", `peers 不得包含本机 local_machine_id (${localMachineId})`);
    }
    const rawPeer = raw.peers[rawPeerKey];
    assertPlainObject(rawPeer, `peers.${machineId}`, PEER_KEYS);
    const qqId = normalizeNumericId(rawPeer.qq_id, `peers.${machineId}.qq_id`, "RELAY_CONFIG_INVALID", true);
    const enabled = validateBoolean(rawPeer.enabled, `peers.${machineId}.enabled`, true);
    const displayName = validateOptionalLabel(rawPeer.display_name, `peers.${machineId}.display_name`, 128);
    const channels = validateStringArray(
      rawPeer.channels,
      `peers.${machineId}.channels`,
      (item, itemName) => validateChannel(item, itemName),
      { required: false, allowEmpty: false, maxLength: 16 },
    ) ?? ["qq"];
    const allowedRelays = validateStringArray(
      rawPeer.allowed_relays,
      `peers.${machineId}.allowed_relays`,
      (item, itemName) => validateSafeIdentifier(item, itemName),
      { required: false, allowEmpty: true, maxLength: 128 },
    );

    peers[machineId] = {
      machine_id: machineId,
      qq_id: qqId,
      enabled,
      display_name: displayName,
      channels,
      allowed_relays: allowedRelays,
      conflicts: [],
    };

    if (qqId === effectiveExpectedSelfId || (binding.expectedSelfId && qqId === binding.expectedSelfId)) {
      recordConflict(makeConflict({
        code: "RELAY_PEER_QQ_CONFLICTS_WITH_SELF",
        scope: "peer",
        peer_machine_id: machineId,
        message: `对端机器 ${machineId} 的 qq_id (${qqId}) 与本机 expected_self_id 冲突`,
        details: { peer_machine_id: machineId, qq_id: qqId },
      }));
    }

    const machinesForQq = peerMachinesByQq.get(qqId) ?? [];
    machinesForQq.push(machineId);
    peerMachinesByQq.set(qqId, machinesForQq);
  }

  for (const [qqId, machines] of peerMachinesByQq.entries()) {
    if (machines.length > 1) {
      for (const machineId of machines) {
        recordConflict(makeConflict({
          code: "RELAY_PEER_QQ_DUPLICATE",
          scope: "peer",
          peer_machine_id: machineId,
          message: `多个对端机器共用了相同的 qq_id (${qqId})：${machines.join(", ")}`,
          details: { qq_id: qqId, peer_machines: [...machines] },
        }));
      }
    }
  }

  // 解析并校验 relays
  const relays = {};
  const relayKeysByGroupId = new Map();
  const activeWriteByTargetChannel = new Map();
  const sortedRelayKeys = Object.keys(raw.relays).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const rawRelayKey of sortedRelayKeys) {
    const relayKey = validateSafeIdentifier(rawRelayKey, `relays.${rawRelayKey}`);
    const rawRelay = raw.relays[rawRelayKey];
    assertPlainObject(rawRelay, `relays.${relayKey}`, RELAY_KEYS);

    const groupId = normalizeNumericId(rawRelay.group_id, `relays.${relayKey}.group_id`, "RELAY_CONFIG_INVALID", true);
    const channel = rawRelay.channel === undefined
      ? "qq"
      : validateChannel(rawRelay.channel, `relays.${relayKey}.channel`);

    if (typeof rawRelay.role !== "string" || !ALLOWED_RELAY_ROLES.includes(rawRelay.role)) {
      throw new RelayError(
        "RELAY_CONFIG_INVALID",
        `relays.${relayKey}.role 必须是 ${ALLOWED_RELAY_ROLES.join(" 或 ")}`,
      );
    }
    const role = rawRelay.role;
    const enabled = validateBoolean(rawRelay.enabled, `relays.${relayKey}.enabled`, true);

    let generation = 1;
    if (rawRelay.generation !== undefined) {
      if (!Number.isSafeInteger(rawRelay.generation) || rawRelay.generation < 1) {
        throw new RelayError("RELAY_CONFIG_INVALID", `relays.${relayKey}.generation 必须是正安全整数`);
      }
      generation = rawRelay.generation;
    }

    const targetMachines = validateStringArray(
      rawRelay.target_machines,
      `relays.${relayKey}.target_machines`,
      (item, itemName) => validateSafeIdentifier(item, itemName),
      { required: true, allowEmpty: false, maxLength: 64 },
    );
    const allowedPeers = validateStringArray(
      rawRelay.allowed_peers,
      `relays.${relayKey}.allowed_peers`,
      (item, itemName) => validateSafeIdentifier(item, itemName),
      { required: false, allowEmpty: false, maxLength: 64 },
    ) ?? [...targetMachines];

    const expectedGroupName = validateOptionalLabel(
      rawRelay.expected_group_name,
      `relays.${relayKey}.expected_group_name`,
      128,
    );
    const verifyMemberCount = validateBoolean(
      rawRelay.verify_member_count,
      `relays.${relayKey}.verify_member_count`,
      false,
    );
    let expectedMemberCount = null;
    if (rawRelay.expected_member_count !== undefined && rawRelay.expected_member_count !== null) {
      if (!Number.isSafeInteger(rawRelay.expected_member_count) || rawRelay.expected_member_count < 1 || rawRelay.expected_member_count > 1000000) {
        throw new RelayError("RELAY_CONFIG_INVALID", `relays.${relayKey}.expected_member_count 必须是正安全整数`);
      }
      expectedMemberCount = rawRelay.expected_member_count;
    }
    if (verifyMemberCount && expectedMemberCount === null) {
      throw new RelayError(
        "RELAY_CONFIG_INVALID",
        `relays.${relayKey} 启用 verify_member_count=true 时必须声明正整数 expected_member_count`,
      );
    }

    const drainUntil = validateOptionalIsoDate(rawRelay.drain_until, `relays.${relayKey}.drain_until`);
    const bootstrapAt = validateOptionalIsoDate(rawRelay.bootstrap_at, `relays.${relayKey}.bootstrap_at`);
    const allowRecipientListDisclosure = validateBoolean(
      rawRelay.allow_recipient_list_disclosure,
      `relays.${relayKey}.allow_recipient_list_disclosure`,
      false,
    );
    const legacyTrainingCoexistence = validateBoolean(
      rawRelay.legacy_training_coexistence,
      `relays.${relayKey}.legacy_training_coexistence`,
      false,
    );

    const fileBundleFolderId = validateOptionalBundleFolderId(
      rawRelay.file_bundle_folder_id,
      `relays.${relayKey}.file_bundle_folder_id`,
    );
    const fileBundleFolderName = validateOptionalBundleFolderName(
      rawRelay.file_bundle_folder_name,
      `relays.${relayKey}.file_bundle_folder_name`,
    );
    if ((fileBundleFolderId !== null) !== (fileBundleFolderName !== null)) {
      throw new RelayError(
        "RELAY_CONFIG_INVALID",
        `relays.${relayKey} 的 file_bundle_folder_id 与 file_bundle_folder_name 必须同时声明或同时省略`,
      );
    }

    const explicitAllowFileBundleWrite = rawRelay.allow_file_bundle_write;
    if (explicitAllowFileBundleWrite !== undefined && typeof explicitAllowFileBundleWrite !== "boolean") {
      throw new RelayError("RELAY_CONFIG_INVALID", `relays.${relayKey}.allow_file_bundle_write 必须是布尔值`);
    }

    const hasPinnedBundleFolder = fileBundleFolderId !== null && fileBundleFolderName !== null;
    let allowFileBundleWrite = legacyTrainingCoexistence
      ? (explicitAllowFileBundleWrite === true && hasPinnedBundleFolder)
      : (explicitAllowFileBundleWrite ?? true);

    if (legacyTrainingCoexistence && explicitAllowFileBundleWrite === true && !hasPinnedBundleFolder) {
      allowFileBundleWrite = false;
      recordConflict(makeConflict({
        code: "RELAY_COEXISTENCE_FILE_BUNDLE_FOLDER_REQUIRED",
        scope: "route",
        relay_key: relayKey,
        group_id: groupId,
        channel,
        message: `中继路由 ${relayKey} 声明了 legacy_training_coexistence=true 且开启 allow_file_bundle_write=true，必须同时绑定独立的 file_bundle_folder_id 与 file_bundle_folder_name`,
        details: { relay_key: relayKey, group_id: groupId },
      }));
    }

    // 硬互斥 1：relay_key 不得与 binding.controlPlane.targets 键重名
    if (binding.controlPlaneTargetKeys.has(relayKey)) {
      recordConflict(makeConflict({
        code: "RELAY_KEY_CONFLICTS_WITH_CONTROL_PLANE",
        scope: "route",
        relay_key: relayKey,
        group_id: groupId,
        channel,
        message: `中继路由键 ${relayKey} 与 binding.controlPlane.targets 键重名`,
        details: { relay_key: relayKey },
      }));
    }

    // 硬互斥 2：group_id 严禁等于 binding.controlPlane.targets[*].id（绝对无例外）
    const cpTargets = binding.controlPlaneTargetsById.get(groupId);
    if (cpTargets && cpTargets.length > 0) {
      recordConflict(makeConflict({
        code: "RELAY_GROUP_CONFLICTS_WITH_CONTROL_PLANE",
        scope: "route",
        relay_key: relayKey,
        group_id: groupId,
        channel,
        message: `中继路由 ${relayKey} 的群号 ${groupId} 与 binding.controlPlane.targets (${cpTargets.map((t) => t.target_key).join(", ")}) 冲突`,
        details: {
          relay_key: relayKey,
          group_id: groupId,
          conflicting_targets: cpTargets.map((t) => ({ ...t })),
        },
      }));
    }

    // 硬互斥 3：默认严禁等于 binding.groupId，除非显式声明 legacy_training_coexistence: true
    if (binding.groupId && groupId === binding.groupId && !legacyTrainingCoexistence) {
      recordConflict(makeConflict({
        code: "RELAY_GROUP_CONFLICTS_WITH_LEGACY_BINDING",
        scope: "route",
        relay_key: relayKey,
        group_id: groupId,
        channel,
        message: `中继路由 ${relayKey} 的群号 ${groupId} 与旧固定训练群 binding.groupId 冲突（未显式声明 legacy_training_coexistence: true）`,
        details: { relay_key: relayKey, group_id: groupId, binding_group_id: binding.groupId },
      }));
    }

    // 校验引用的 peers 存在
    const allReferencedPeers = new Set([...targetMachines, ...allowedPeers]);
    for (const peerId of allReferencedPeers) {
      if (!Object.hasOwn(peers, peerId)) {
        recordConflict(makeConflict({
          code: "RELAY_UNKNOWN_PEER_REFERENCE",
          scope: "route",
          relay_key: relayKey,
          group_id: groupId,
          channel,
          target_machine: peerId,
          message: `中继路由 ${relayKey} 引用了未在 peers 中声明的机器：${peerId}`,
          details: { relay_key: relayKey, missing_peer: peerId },
        }));
      }
    }

    // 登记群号查重
    const keysForGroup = relayKeysByGroupId.get(groupId) ?? [];
    keysForGroup.push(relayKey);
    relayKeysByGroupId.set(groupId, keysForGroup);

    // 登记单路线唯一性查重（active_write && enabled）
    if (enabled && role === "active_write") {
      for (const targetMachine of targetMachines) {
        const tupleKey = `${targetMachine}\0${channel}`;
        const list = activeWriteByTargetChannel.get(tupleKey) ?? [];
        list.push(relayKey);
        activeWriteByTargetChannel.set(tupleKey, list);
      }
    }

    relays[relayKey] = {
      relay_key: relayKey,
      generation,
      group_id: groupId,
      channel,
      role,
      enabled,
      target_machines: targetMachines,
      allowed_peers: allowedPeers,
      expected_group_name: expectedGroupName,
      expected_member_count: expectedMemberCount,
      verify_member_count: verifyMemberCount,
      drain_until: drainUntil,
      bootstrap_at: bootstrapAt,
      allow_recipient_list_disclosure: allowRecipientListDisclosure,
      legacy_training_coexistence: legacyTrainingCoexistence,
      allow_file_bundle_write: allowFileBundleWrite,
      file_bundle_folder_id: fileBundleFolderId,
      file_bundle_folder_name: fileBundleFolderName,
      conflicts: [],
      valid: true,
    };
  }

  // 硬互斥 4：中继内不同 relay_key 的 group_id 不可重复
  for (const [groupId, keys] of relayKeysByGroupId.entries()) {
    if (keys.length > 1) {
      for (const relayKey of keys) {
        recordConflict(makeConflict({
          code: "RELAY_GROUP_ID_DUPLICATE",
          scope: "route",
          relay_key: relayKey,
          group_id: groupId,
          channel: relays[relayKey].channel,
          message: `多个中继路由共用了相同的 group_id (${groupId})：${keys.join(", ")}`,
          details: { group_id: groupId, duplicate_relay_keys: [...keys] },
        }));
      }
    }
  }

  // 单路线唯一性冲突记录（同一 target_machine + channel 存在 >=2 条启用 active_write）
  for (const [tupleKey, keys] of activeWriteByTargetChannel.entries()) {
    if (keys.length > 1) {
      const [targetMachine, channel] = tupleKey.split("\0");
      for (const relayKey of keys) {
        recordConflict(makeConflict({
          code: "RELAY_ROUTE_AMBIGUOUS",
          scope: "route",
          relay_key: relayKey,
          group_id: relays[relayKey].group_id,
          target_machine: targetMachine,
          channel,
          message: `目标机器 ${targetMachine}（渠道 ${channel}）存在多条启用的 active_write 路由：${keys.join(", ")}`,
          details: { target_machine: targetMachine, channel, matching_relay_keys: [...keys] },
        }));
      }
    }
  }

  // 校验 peer.allowed_relays 若声明则引用的 relay_key 必须存在
  for (const peer of Object.values(peers)) {
    if (Array.isArray(peer.allowed_relays)) {
      for (const relayKey of peer.allowed_relays) {
        if (!Object.hasOwn(relays, relayKey)) {
          recordConflict(makeConflict({
            code: "RELAY_UNKNOWN_RELAY_REFERENCE",
            scope: "peer",
            peer_machine_id: peer.machine_id,
            relay_key: null,
            message: `对端机器 ${peer.machine_id} 的 allowed_relays 引用了不存在的路由键：${relayKey}`,
            details: { peer_machine_id: peer.machine_id, missing_relay_key: relayKey },
          }));
        }
      }
    }
  }

  // 回填每条 peer / route 的局部冲突清单与 valid 标志
  for (const peer of Object.values(peers)) {
    peer.conflicts = [...(peerConflictsByMachine.get(peer.machine_id) ?? [])];
  }
  for (const route of Object.values(relays)) {
    route.conflicts = [...(routeConflictsByKey.get(route.relay_key) ?? [])];
    route.valid = route.conflicts.length === 0 && globalConflicts.length === 0;
  }

  const hashPayload = canonicalizeForHash({
    schema_version: RELAY_GROUPS_SCHEMA_VERSION,
    local_machine_id: localMachineId,
    expected_self_id: effectiveExpectedSelfId,
    limits,
    peers: Object.fromEntries(Object.entries(peers).map(([k, p]) => [k, {
      machine_id: p.machine_id,
      qq_id: p.qq_id,
      enabled: p.enabled,
      display_name: p.display_name,
      channels: p.channels,
      allowed_relays: p.allowed_relays,
    }])),
    relays: Object.fromEntries(Object.entries(relays).map(([k, r]) => [k, {
      relay_key: r.relay_key,
      generation: r.generation,
      group_id: r.group_id,
      channel: r.channel,
      role: r.role,
      enabled: r.enabled,
      target_machines: r.target_machines,
      allowed_peers: r.allowed_peers,
      expected_group_name: r.expected_group_name,
      expected_member_count: r.expected_member_count,
      verify_member_count: r.verify_member_count,
      drain_until: r.drain_until,
      bootstrap_at: r.bootstrap_at,
      allow_recipient_list_disclosure: r.allow_recipient_list_disclosure,
      legacy_training_coexistence: r.legacy_training_coexistence,
      allow_file_bundle_write: r.allow_file_bundle_write,
      file_bundle_folder_id: r.file_bundle_folder_id,
      file_bundle_folder_name: r.file_bundle_folder_name,
    }])),
  });
  const configHash = createHash("sha256").update(JSON.stringify(hashPayload), "utf8").digest("hex");

  return deepFreeze({
    schema_version: RELAY_GROUPS_SCHEMA_VERSION,
    local_machine_id: localMachineId,
    expected_self_id: effectiveExpectedSelfId,
    limits,
    peers,
    relays,
    conflicts,
    global_conflicts: globalConflicts,
    config_hash: configHash,
  });
}

function validatePeerForRoute(config, route, targetMachine) {
  if (!Object.hasOwn(config.peers, targetMachine)) {
    throw new RelayError(
      "RELAY_PEER_NOT_FOUND",
      `未在 peers 配置中找到目标机器：${targetMachine}`,
      { target_machine: targetMachine, relay_key: route.relay_key },
    );
  }
  const peer = config.peers[targetMachine];
  if (peer.conflicts.length > 0) {
    throwFirstConflict(peer.conflicts, `目标机器 ${targetMachine} 存在配置冲突`);
  }
  if (!peer.enabled) {
    throw new RelayError(
      "RELAY_PEER_DISABLED",
      `目标机器 ${targetMachine} 已被禁用`,
      { target_machine: targetMachine, relay_key: route.relay_key },
    );
  }
  if (Array.isArray(peer.channels) && !peer.channels.includes(route.channel)) {
    throw new RelayError(
      "RELAY_PEER_CHANNEL_NOT_ALLOWED",
      `目标机器 ${targetMachine} 未授权使用通道 ${route.channel}`,
      { target_machine: targetMachine, channel: route.channel, relay_key: route.relay_key },
    );
  }
  if (Array.isArray(peer.allowed_relays) && !peer.allowed_relays.includes(route.relay_key)) {
    throw new RelayError(
      "RELAY_PEER_NOT_ALLOWED_ON_ROUTE",
      `目标机器 ${targetMachine} 未被授权使用中继路由 ${route.relay_key}`,
      { target_machine: targetMachine, relay_key: route.relay_key },
    );
  }
  return peer;
}

function assertRouteHealthy(config, route, { ignoreAmbiguous = false } = {}) {
  if (config.global_conflicts.length > 0) {
    throwFirstConflict(config.global_conflicts, "中继配置存在全局冲突");
  }
  const blocking = ignoreAmbiguous
    ? route.conflicts.filter((item) => item.code !== "RELAY_ROUTE_AMBIGUOUS")
    : route.conflicts;
  if (blocking.length > 0) {
    throwFirstConflict(blocking, `中继路由 ${route.relay_key} 存在配置冲突`);
  }
}

export function resolveRelayRoute(config, options = {}) {
  assertValidConfigObject(config);
  assertPlainObject(options, "resolveRelayRoute options", RESOLVE_ROUTE_OPTION_KEYS, "RELAY_INVALID_ARGUMENT");

  const mode = options.mode === undefined ? "write" : options.mode;
  if (!["write", "reply", "read"].includes(mode)) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", `不支持的选路模式 mode=${String(mode)}，仅支持 write/reply/read`);
  }

  const channel = options.channel === undefined
    ? "qq"
    : validateChannel(options.channel, "channel", "RELAY_INVALID_ARGUMENT");

  const targetMachine = options.target_machine === undefined
    ? null
    : validateSafeIdentifier(options.target_machine, "target_machine", "RELAY_INVALID_ARGUMENT");

  const relayKey = options.relay_key === undefined
    ? null
    : validateSafeIdentifier(options.relay_key, "relay_key", "RELAY_INVALID_ARGUMENT");

  let expectedGeneration = null;
  if (options.expected_generation !== undefined) {
    if (!Number.isSafeInteger(options.expected_generation) || options.expected_generation < 1) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "expected_generation 必须是正安全整数");
    }
    expectedGeneration = options.expected_generation;
  }

  const expectedGroupId = options.expected_group_id === undefined
    ? null
    : normalizeNumericId(options.expected_group_id, "expected_group_id", "RELAY_INVALID_ARGUMENT", true);
  const nowMs = resolveNowMs(options.now);

  // 全局配置冲突一律 fail-closed
  if (config.global_conflicts.length > 0) {
    throwFirstConflict(config.global_conflicts, "中继全局配置冲突");
  }

  let selectedRoute = null;

  if (mode === "write") {
    if (!targetMachine) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "write 模式必须提供 target_machine");
    }
    const candidates = Object.values(config.relays).filter((route) =>
      route.enabled === true
      && route.role === "active_write"
      && route.channel === channel
      && route.target_machines.includes(targetMachine));

    if (candidates.length === 0) {
      throw new RelayError(
        "RELAY_ROUTE_NOT_FOUND",
        `找不到目标机器 ${targetMachine}（渠道 ${channel}）可用的 active_write 中继路由`,
        { target_machine: targetMachine, channel, mode },
      );
    }
    if (candidates.length >= 2) {
      throw new RelayError(
        "RELAY_ROUTE_AMBIGUOUS",
        `目标机器 ${targetMachine}（渠道 ${channel}）匹配到 ${candidates.length} 条启用的 active_write 路由，禁止广播`,
        {
          target_machine: targetMachine,
          channel,
          mode,
          matching_relay_keys: candidates.map((item) => item.relay_key),
        },
      );
    }
    selectedRoute = candidates[0];
    if (relayKey !== null && selectedRoute.relay_key !== relayKey) {
      throw new RelayError(
        "RELAY_ROUTE_NOT_FOUND",
        `指定 relay_key=${relayKey} 不是目标机器 ${targetMachine}（渠道 ${channel}）的唯一 active_write 路由`,
        { target_machine: targetMachine, channel, relay_key: relayKey, active_relay_key: selectedRoute.relay_key },
      );
    }
    assertRouteHealthy(config, selectedRoute);
  } else if (mode === "reply") {
    if (!relayKey) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "reply 模式必须显式指定 relay_key");
    }
    if (!targetMachine) {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "reply 模式必须提供 target_machine");
    }
    if (!Object.hasOwn(config.relays, relayKey)) {
      throw new RelayError("RELAY_ROUTE_NOT_FOUND", `找不到指定中继路由：${relayKey}`, { relay_key: relayKey, mode });
    }
    selectedRoute = config.relays[relayKey];
    assertRouteHealthy(config, selectedRoute, { ignoreAmbiguous: selectedRoute.role === "draining_read" });
    if (!selectedRoute.enabled) {
      throw new RelayError("RELAY_ROUTE_DISABLED", `中继路由 ${relayKey} 已禁用`, { relay_key: relayKey });
    }
    if (isRelayRouteDrainExpired(selectedRoute, nowMs)) {
      throw new RelayError(
        "RELAY_ROUTE_DRAIN_EXPIRED",
        `排空路由 ${relayKey} 已超过 drain_until (${selectedRoute.drain_until})，停止原路回执`,
        { relay_key: relayKey, group_id: selectedRoute.group_id, drain_until: selectedRoute.drain_until },
      );
    }
    if (selectedRoute.channel !== channel) {
      throw new RelayError(
        "RELAY_ROUTE_CHANGED",
        `中继路由 ${relayKey} 的渠道为 ${selectedRoute.channel}，与请求的 ${channel} 不匹配`,
        { relay_key: relayKey, change_reason: "channel_mismatch", expected_channel: channel, actual_channel: selectedRoute.channel },
      );
    }
    if (!selectedRoute.target_machines.includes(targetMachine)) {
      throw new RelayError(
        "RELAY_ROUTE_CHANGED",
        `目标机器 ${targetMachine} 不在中继路由 ${relayKey} 的 target_machines 内`,
        { relay_key: relayKey, change_reason: "target_mismatch", target_machine: targetMachine },
      );
    }
  } else {
    // mode === "read"
    if (relayKey) {
      if (!Object.hasOwn(config.relays, relayKey)) {
        throw new RelayError("RELAY_ROUTE_NOT_FOUND", `找不到指定中继路由：${relayKey}`, { relay_key: relayKey, mode });
      }
      selectedRoute = config.relays[relayKey];
      assertRouteHealthy(config, selectedRoute, { ignoreAmbiguous: true });
      if (!selectedRoute.enabled) {
        throw new RelayError("RELAY_ROUTE_DISABLED", `中继路由 ${relayKey} 已禁用`, { relay_key: relayKey });
      }
      if (isRelayRouteDrainExpired(selectedRoute, nowMs)) {
        throw new RelayError(
          "RELAY_ROUTE_DRAIN_EXPIRED",
          `排空路由 ${relayKey} 已超过 drain_until (${selectedRoute.drain_until})`,
          { relay_key: relayKey, group_id: selectedRoute.group_id, drain_until: selectedRoute.drain_until },
        );
      }
      if (selectedRoute.channel !== channel) {
        throw new RelayError(
          "RELAY_ROUTE_CHANGED",
          `中继路由 ${relayKey} 的渠道为 ${selectedRoute.channel}，与请求的 ${channel} 不匹配`,
          { relay_key: relayKey, change_reason: "channel_mismatch", expected_channel: channel, actual_channel: selectedRoute.channel },
        );
      }
      if (targetMachine && !selectedRoute.target_machines.includes(targetMachine)) {
        throw new RelayError(
          "RELAY_ROUTE_CHANGED",
          `目标机器 ${targetMachine} 不在中继路由 ${relayKey} 的 target_machines 内`,
          { relay_key: relayKey, change_reason: "target_mismatch", target_machine: targetMachine },
        );
      }
    } else if (targetMachine) {
      const candidates = Object.values(config.relays).filter((route) =>
        route.enabled === true
        && route.channel === channel
        && route.target_machines.includes(targetMachine)
        && !isRelayRouteDrainExpired(route, nowMs));
      if (candidates.length === 0) {
        throw new RelayError(
          "RELAY_ROUTE_NOT_FOUND",
          `找不到目标机器 ${targetMachine}（渠道 ${channel}）可用的可读中继路由`,
          { target_machine: targetMachine, channel, mode },
        );
      }
      if (candidates.length >= 2) {
        throw new RelayError(
          "RELAY_ROUTE_AMBIGUOUS",
          `目标机器 ${targetMachine}（渠道 ${channel}）匹配到 ${candidates.length} 条可读路由，请显式指定 relay_key`,
          { target_machine: targetMachine, channel, mode, matching_relay_keys: candidates.map((item) => item.relay_key) },
        );
      }
      selectedRoute = candidates[0];
      assertRouteHealthy(config, selectedRoute, { ignoreAmbiguous: true });
    } else {
      throw new RelayError("RELAY_INVALID_ARGUMENT", "read 模式必须提供 relay_key 或 target_machine");
    }
  }

  if (expectedGeneration !== null && selectedRoute.generation !== expectedGeneration) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      `中继路由 ${selectedRoute.relay_key} 当前代次为 ${selectedRoute.generation}，与预期 ${expectedGeneration} 不一致`,
      {
        relay_key: selectedRoute.relay_key,
        change_reason: "generation_mismatch",
        expected_generation: expectedGeneration,
        current_generation: selectedRoute.generation,
        actual_generation: selectedRoute.generation,
      },
    );
  }
  if (expectedGroupId !== null && selectedRoute.group_id !== expectedGroupId) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      `中继路由 ${selectedRoute.relay_key} 当前群号为 ${selectedRoute.group_id}，与预期 ${expectedGroupId} 不一致`,
      {
        relay_key: selectedRoute.relay_key,
        change_reason: "group_mismatch",
        expected_group_id: expectedGroupId,
        actual_group_id: selectedRoute.group_id,
      },
    );
  }

  let peer = null;
  if (targetMachine) {
    peer = validatePeerForRoute(config, selectedRoute, targetMachine);
  } else if (selectedRoute.target_machines.length === 1) {
    peer = validatePeerForRoute(config, selectedRoute, selectedRoute.target_machines[0]);
  }

  return buildFrozenRouteSnapshot(config, selectedRoute, peer);
}

export function reverifyFrozenRelayRoute(config, frozenRoute, options = {}) {
  assertValidConfigObject(config);
  assertPlainObject(options, "reverifyFrozenRelayRoute options", REVERIFY_OPTION_KEYS, "RELAY_INVALID_ARGUMENT");
  const allowDraining = validateBoolean(options.allowDraining, "allowDraining", true, "RELAY_INVALID_ARGUMENT");
  const requireFileBundleWrite = validateBoolean(
    options.requireFileBundleWrite,
    "requireFileBundleWrite",
    false,
    "RELAY_INVALID_ARGUMENT",
  );
  const nowMs = resolveNowMs(options.now);

  assertPlainObject(frozenRoute, "frozenRoute", FROZEN_ROUTE_KEYS, "RELAY_INVALID_ARGUMENT");
  const relayKey = validateSafeIdentifier(frozenRoute.relay_key, "frozenRoute.relay_key", "RELAY_INVALID_ARGUMENT");
  if (!Number.isSafeInteger(frozenRoute.generation) || frozenRoute.generation < 1) {
    throw new RelayError("RELAY_INVALID_ARGUMENT", "frozenRoute.generation 必须是正安全整数");
  }
  const groupId = normalizeNumericId(frozenRoute.group_id, "frozenRoute.group_id", "RELAY_INVALID_ARGUMENT", true);
  const channel = validateChannel(frozenRoute.channel, "frozenRoute.channel", "RELAY_INVALID_ARGUMENT");
  const localMachineId = validateSafeIdentifier(
    frozenRoute.local_machine_id,
    "frozenRoute.local_machine_id",
    "RELAY_INVALID_ARGUMENT",
  );
  const expectedSelfId = normalizeNumericId(
    frozenRoute.expected_self_id,
    "frozenRoute.expected_self_id",
    "RELAY_INVALID_ARGUMENT",
    true,
  );

  const peerMachineId = frozenRoute.peer_machine_id === null || frozenRoute.peer_machine_id === undefined
    ? null
    : validateSafeIdentifier(frozenRoute.peer_machine_id, "frozenRoute.peer_machine_id", "RELAY_INVALID_ARGUMENT");
  const peerQqId = frozenRoute.peer_qq_id === null || frozenRoute.peer_qq_id === undefined
    ? null
    : normalizeNumericId(frozenRoute.peer_qq_id, "frozenRoute.peer_qq_id", "RELAY_INVALID_ARGUMENT", true);
  const frozenFolderId = validateOptionalBundleFolderId(
    frozenRoute.file_bundle_folder_id,
    "frozenRoute.file_bundle_folder_id",
    "RELAY_INVALID_ARGUMENT",
  );
  const frozenFolderName = validateOptionalBundleFolderName(
    frozenRoute.file_bundle_folder_name,
    "frozenRoute.file_bundle_folder_name",
    "RELAY_INVALID_ARGUMENT",
  );

  if ((peerMachineId === null) !== (peerQqId === null)) {
    throw new RelayError("RELAY_ROUTE_CHANGED", "冻结路由的 peer_machine_id 与 peer_qq_id 必须同时提供或同时为空", {
      change_reason: "peer_pair_incomplete",
    });
  }
  if ((frozenFolderId === null) !== (frozenFolderName === null)) {
    throw new RelayError("RELAY_ROUTE_CHANGED", "冻结路由的 file_bundle_folder_id 与 file_bundle_folder_name 必须同时提供或同时为空", {
      change_reason: "file_bundle_folder_pair_incomplete",
    });
  }

  if (config.global_conflicts.length > 0) {
    throwFirstConflict(config.global_conflicts, "中继全局配置冲突");
  }

  if (config.local_machine_id !== localMachineId || config.expected_self_id !== expectedSelfId) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      "当前本机中继身份（local_machine_id 或 expected_self_id）已偏离原冻结路由",
      {
        relay_key: relayKey,
        change_reason: "local_identity_mismatch",
        frozen_local_machine_id: localMachineId,
        actual_local_machine_id: config.local_machine_id,
        frozen_expected_self_id: expectedSelfId,
        actual_expected_self_id: config.expected_self_id,
      },
    );
  }

  if (!Object.hasOwn(config.relays, relayKey)) {
    throw new RelayError(
      "RELAY_ROUTE_NOT_FOUND",
      `原冻结中继路由 ${relayKey} 已从当前配置中移除`,
      { relay_key: relayKey, group_id: groupId, generation: frozenRoute.generation },
    );
  }
  const currentRoute = config.relays[relayKey];

  // 允许 active_write -> draining_read 过渡，但硬互斥与重复群冲突绝不放过
  assertRouteHealthy(config, currentRoute, { ignoreAmbiguous: currentRoute.role === "draining_read" });

  if (!currentRoute.enabled) {
    throw new RelayError(
      "RELAY_ROUTE_DISABLED",
      `原冻结中继路由 ${relayKey} 已被禁用`,
      { relay_key: relayKey, group_id: currentRoute.group_id, generation: currentRoute.generation },
    );
  }

  if (currentRoute.generation !== frozenRoute.generation) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      `原冻结中继路由 ${relayKey} 的代次已变化（冻结=${frozenRoute.generation}，当前=${currentRoute.generation}）`,
      {
        relay_key: relayKey,
        change_reason: "generation_mismatch",
        expected_generation: frozenRoute.generation,
        current_generation: currentRoute.generation,
        frozen_generation: frozenRoute.generation,
        actual_generation: currentRoute.generation,
      },
    );
  }

  if (currentRoute.group_id !== groupId) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      `原冻结中继路由 ${relayKey} 的群号已变化（冻结=${groupId}，当前=${currentRoute.group_id}）`,
      {
        relay_key: relayKey,
        change_reason: "group_mismatch",
        frozen_group_id: groupId,
        actual_group_id: currentRoute.group_id,
      },
    );
  }

  if (currentRoute.channel !== channel) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      `原冻结中继路由 ${relayKey} 的通道已变化（冻结=${channel}，当前=${currentRoute.channel}）`,
      {
        relay_key: relayKey,
        change_reason: "channel_mismatch",
        frozen_channel: channel,
        actual_channel: currentRoute.channel,
      },
    );
  }

  if (currentRoute.role === "draining_read") {
    if (!allowDraining) {
      throw new RelayError(
        "RELAY_ROUTE_DRAINING",
        `原冻结中继路由 ${relayKey} 已进入 draining_read 排空态，当前操作不允许在排空态继续`,
        { relay_key: relayKey, group_id: currentRoute.group_id, drain_until: currentRoute.drain_until },
      );
    }
    if (isRelayRouteDrainExpired(currentRoute, nowMs)) {
      throw new RelayError(
        "RELAY_ROUTE_DRAIN_EXPIRED",
        `原冻结排空路由 ${relayKey} 已超过 drain_until (${currentRoute.drain_until})`,
        { relay_key: relayKey, group_id: currentRoute.group_id, drain_until: currentRoute.drain_until },
      );
    }
  }

  let peer = null;
  if (peerMachineId !== null) {
    if (!currentRoute.target_machines.includes(peerMachineId)) {
      throw new RelayError(
        "RELAY_ROUTE_CHANGED",
        `对端机器 ${peerMachineId} 已不在中继路由 ${relayKey} 的 target_machines 内`,
        { relay_key: relayKey, change_reason: "target_mismatch", peer_machine_id: peerMachineId },
      );
    }
    peer = validatePeerForRoute(config, currentRoute, peerMachineId);
    if (peer.qq_id !== peerQqId) {
      throw new RelayError(
        "RELAY_ROUTE_CHANGED",
        `对端机器 ${peerMachineId} 的 QQ 号已变化（冻结=${peerQqId}，当前=${peer.qq_id}）`,
        {
          relay_key: relayKey,
          change_reason: "peer_qq_mismatch",
          peer_machine_id: peerMachineId,
          frozen_peer_qq_id: peerQqId,
          actual_peer_qq_id: peer.qq_id,
        },
      );
    }
  }

  if (
    currentRoute.file_bundle_folder_id !== frozenFolderId
    || currentRoute.file_bundle_folder_name !== frozenFolderName
  ) {
    throw new RelayError(
      "RELAY_ROUTE_CHANGED",
      `原冻结中继路由 ${relayKey} 的独立群文件目录已变化（冻结=${frozenFolderId ?? "null"}/${frozenFolderName ?? "null"}，当前=${currentRoute.file_bundle_folder_id ?? "null"}/${currentRoute.file_bundle_folder_name ?? "null"}）`,
      {
        relay_key: relayKey,
        change_reason: "file_bundle_folder_mismatch",
        frozen_file_bundle_folder_id: frozenFolderId,
        actual_file_bundle_folder_id: currentRoute.file_bundle_folder_id,
        frozen_file_bundle_folder_name: frozenFolderName,
        actual_file_bundle_folder_name: currentRoute.file_bundle_folder_name,
      },
    );
  }

  const folderPinned = Boolean(currentRoute.file_bundle_folder_id && currentRoute.file_bundle_folder_name);
  if (
    requireFileBundleWrite
    && (currentRoute.allow_file_bundle_write !== true || (currentRoute.legacy_training_coexistence === true && !folderPinned))
  ) {
    throw new RelayError(
      "RELAY_FILE_BUNDLE_WRITE_FORBIDDEN",
      `中继路由 ${relayKey} 禁止文件包写入操作`,
      {
        relay_key: relayKey,
        group_id: currentRoute.group_id,
        legacy_training_coexistence: currentRoute.legacy_training_coexistence,
        allow_file_bundle_write: currentRoute.allow_file_bundle_write,
        file_bundle_folder_id: currentRoute.file_bundle_folder_id,
        file_bundle_folder_name: currentRoute.file_bundle_folder_name,
      },
    );
  }

  return buildFrozenRouteSnapshot(config, currentRoute, peer);
}

export function findPeerMachineByQq(config, qqId) {
  assertValidConfigObject(config);
  if (Array.isArray(config.global_conflicts) && config.global_conflicts.length > 0) {
    return null;
  }
  if (qqId === undefined || qqId === null || qqId === "") return null;
  let normalized;
  try {
    normalized = normalizeNumericId(qqId, "qqId", "RELAY_INVALID_ARGUMENT", true);
  } catch {
    return null;
  }
  if (normalized === config.expected_self_id) return null;

  const matched = [];
  for (const peer of Object.values(config.peers)) {
    if (peer.qq_id !== normalized) continue;
    if (!peer.enabled || peer.conflicts.length > 0) {
      return null;
    }
    matched.push(peer.machine_id);
  }
  return matched.length === 1 ? matched[0] : null;
}

export function buildSanitizedRelayView(config) {
  assertValidConfigObject(config);
  const peers = Object.values(config.peers)
    .sort((a, b) => (a.machine_id < b.machine_id ? -1 : a.machine_id > b.machine_id ? 1 : 0))
    .map((peer) => ({
      machine_id: peer.machine_id,
      qq_id: peer.qq_id,
      enabled: peer.enabled,
      display_name: peer.display_name,
      channels: [...peer.channels],
      allowed_relays: peer.allowed_relays ? [...peer.allowed_relays] : null,
      valid: peer.conflicts.length === 0,
    }));

  const routes = Object.values(config.relays)
    .sort((a, b) => (a.relay_key < b.relay_key ? -1 : a.relay_key > b.relay_key ? 1 : 0))
    .map((route) => {
      const peerBindings = route.target_machines.map((machineId) => {
        const peerObj = Object.hasOwn(config.peers, machineId) ? config.peers[machineId] : null;
        return {
          machine_id: machineId,
          qq_id: peerObj ? peerObj.qq_id : null,
        };
      });
      const primaryPeer = peerBindings[0] ?? null;
      return {
        relay_key: route.relay_key,
        generation: route.generation,
        group_id: route.group_id,
        channel: route.channel,
        local_machine_id: config.local_machine_id,
        expected_self_id: config.expected_self_id,
        peer_machine_id: primaryPeer ? primaryPeer.machine_id : null,
        peer_qq_id: primaryPeer ? primaryPeer.qq_id : null,
        peer_bindings: peerBindings,
        role: route.role,
        enabled: route.enabled,
        target_machines: [...route.target_machines],
        allowed_peers: [...route.allowed_peers],
        drain_until: route.drain_until,
        bootstrap_at: route.bootstrap_at,
        expected_group_name: route.expected_group_name,
        expected_member_count: route.expected_member_count,
        verify_member_count: route.verify_member_count,
        allow_recipient_list_disclosure: route.allow_recipient_list_disclosure,
        legacy_training_coexistence: route.legacy_training_coexistence,
        allow_file_bundle_write: route.allow_file_bundle_write,
        file_bundle_folder_id: route.file_bundle_folder_id,
        file_bundle_folder_name: route.file_bundle_folder_name,
        valid: route.valid,
        conflicts: route.conflicts.map((conflict) => ({ ...conflict })),
      };
    });

  return deepFreeze({
    schema_version: config.schema_version,
    local_machine_id: config.local_machine_id,
    expected_self_id: config.expected_self_id,
    config_hash: config.config_hash,
    limits: { ...config.limits },
    peers,
    routes,
    conflicts: config.conflicts.map((conflict) => ({ ...conflict })),
  });
}
