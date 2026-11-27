import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { assertExactKeys, CoreError, digest, identityKey, normalizeIdentity, requireInteger, requireText } from "./contracts.mjs";
import { normalizeBoardAddress } from "./conversation-address-book.mjs";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]/u;
const ADDRESS_KEYS = ["machine_id", "host", "surface", "conversation_id"];
const SETTINGS_KEYS = ["default_file_sync_machines", "auto_archive_days", "default_poll_interval_sec"];
const POST_FILE_KEYS = ["path", "name", "bundle_id", "bundle_label"];
const DELIVERY_MODES = new Set(["poll", "event"]);
const FILTER_MODES = new Set(["all", "mute", "only"]);
const BOARD_STATUSES = new Set(["active", "archived"]);

const DEFAULT_ENGINE_LIMITS = Object.freeze({
  maxBodyBytes: 65536,
  maxTitleChars: 128,
  maxMembersPerBoard: 128,
  maxFilesPerPost: 16,
  maxFileBytes: 15 * 1024 * 1024,
  maxRemotePostBundleBytes: 16 * 1024 * 1024 - 256 * 1024,
  maxBoardFilesBytes: 256 * 1024 * 1024,
  maxTotalFilesBytes: 2 * 1024 * 1024 * 1024,
  minPollIntervalSec: 60,
  maxPollIntervalSec: 3600,
  defaultPollIntervalSec: 90,
  minAutoArchiveDays: 1,
  maxAutoArchiveDays: 3650,
  defaultAutoArchiveDays: 31,
  defaultListLimit: 30,
  maxListLimit: 100,
  defaultReadLimit: 50,
  maxReadLimit: 100,
  defaultReadMaxTotalChars: 6000,
  maxReadMaxTotalChars: 65536,
  defaultReadMaxResponseBytes: 8900,
  notifyRetryBaseMs: 15000,
  notifyRetryMaxMs: 30 * 60 * 1000,
  notifyBatchLimit: 64,
});

export const BOARD_ACTIONS = Object.freeze(new Set([
  "create",
  "list",
  "subscribe",
  "unsubscribe",
  "invite",
  "post",
  "read",
  "set_subscription",
  "query_members",
  "update_settings",
  "dissolve",
  "restore",
  "delete_archived",
]));

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreError("invalid_input", `${name}必须是对象`);
  }
}

function checkedLineText(value, name, maxBytes, maxChars = null) {
  const raw = requireText(value, name, maxBytes);
  if (CONTROL_CHARS.test(raw)) {
    throw new CoreError("invalid_input", `${name}不能包含控制字符`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CoreError("invalid_input", `${name}不能为空`);
  }
  if (maxChars !== null && [...trimmed].length > maxChars) {
    throw new CoreError("invalid_input", `${name}长度超出限制`);
  }
  return trimmed;
}

function checkedStrictToken(value, name, maxBytes = 128) {
  const raw = requireText(value, name, maxBytes);
  if (raw !== raw.trim() || raw === "*" || CONTROL_CHARS.test(raw)) {
    throw new CoreError("invalid_input", `${name}格式无效或不允许使用通配符`);
  }
  return raw;
}

function normalizeConcreteIdentity(identity, fallbackMachineId = null) {
  assertPlainObject(identity, "对话身份");
  const normalized = normalizeIdentity({
    ...identity,
    machine_id: identity.machine_id ?? fallbackMachineId,
  });
  for (const field of ADDRESS_KEYS) {
    const part = normalized[field];
    if (typeof part !== "string" || !part || part === "*" || part !== part.trim() || CONTROL_CHARS.test(part)) {
      throw new CoreError("invalid_input", `对话身份字段 ${field} 无效或包含通配符`);
    }
  }
  return Object.freeze({
    machine_id: normalized.machine_id,
    host: normalized.host,
    surface: normalized.surface,
    conversation_id: normalized.conversation_id,
  });
}

function safeParseJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseIdentityKeyString(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parts = JSON.parse(trimmed);
    if (!Array.isArray(parts) || parts.length !== 4 || parts.some(part => typeof part !== "string")) {
      return null;
    }
    return normalizeConcreteIdentity({
      machine_id: parts[0],
      host: parts[1],
      surface: parts[2],
      conversation_id: parts[3],
    });
  } catch {
    return null;
  }
}

function validateBoardIdValue(boardId) {
  const text = requireText(boardId, "board_id", 128);
  if (!BOARD_ID_PATTERN.test(text)) {
    throw new CoreError("invalid_input", "交流板标识格式无效");
  }
  return text;
}

function truncateUnicode(text, maxChars) {
  const chars = [...text];
  if (chars.length <= maxChars) return { text, truncated: false, totalChars: chars.length };
  return { text: chars.slice(0, maxChars).join(""), truncated: true, totalChars: chars.length };
}

function encodeOffsetCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeOffsetCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    requireText(cursor, "cursor", 1024);
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return requireInteger(parsed?.offset, "cursor.offset", 0);
  } catch {
    throw new CoreError("invalid_cursor", "交流板列表游标无效");
  }
}

function effectiveDeliveryMode(member, hostMachineId) {
  if (member.machine_id !== hostMachineId) {
    return "poll_cross_machine";
  }
  return member.delivery_mode === "event" ? "event" : "poll";
}

function fallbackDisplayName(identity) {
  return `${identity.machine_id}/${identity.host}/${identity.conversation_id}`;
}

function extractMemberKey(member) {
  if (typeof member?.member_key === "string" && member.member_key.length > 0) {
    return member.member_key;
  }
  return identityKey(normalizeConcreteIdentity(member));
}

function extractPostAuthorKey(post) {
  if (typeof post?.author_key === "string" && post.author_key.length > 0) {
    return post.author_key;
  }
  const author = post?.author ?? safeParseJson(post?.author_json, null);
  if (author && typeof author === "object") {
    return identityKey(normalizeConcreteIdentity(author));
  }
  return null;
}

function extractStringKeySet(raw) {
  const list = Array.isArray(raw) ? raw : safeParseJson(raw, []);
  const keys = new Set();
  if (!Array.isArray(list)) return keys;
  for (const item of list) {
    if (typeof item === "string" && item.length > 0) {
      keys.add(item);
    } else if (item && typeof item === "object") {
      try {
        keys.add(identityKey(normalizeConcreteIdentity(item)));
      } catch {
        // 忽略非法条目
      }
    }
  }
  return keys;
}

function normalizePathForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(rootPath, candidatePath) {
  const normRoot = normalizePathForCompare(rootPath);
  const normCandidate = normalizePathForCompare(candidatePath);
  const rel = path.relative(normRoot, normCandidate);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || rel.startsWith("..\\") || path.isAbsolute(rel)) {
    return false;
  }
  return true;
}

function sumDirectoryBytes(dirPath) {
  let stat;
  try {
    stat = lstatSync(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += sumDirectoryBytes(childPath);
    } else if (entry.isFile()) {
      try {
        const fileStat = lstatSync(childPath);
        if (fileStat.isFile()) total += fileStat.size;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}

function isNotificationAccepted(response) {
  if (!response || typeof response !== "object") {
    return false;
  }
  if (response.ok === false || response.accepted === false || response.delivered === false) {
    return false;
  }
  return response.ok === true
    || response.accepted === true
    || response.delivered === true
    || response.delivery_status === "accepted"
    || response.delivery_status === "prepared"
    || (typeof response.message_id === "string" && response.message_id.trim().length > 0);
}

function normalizeEngineSettings(input, existing, limits) {
  assertPlainObject(input ?? {}, "settings");
  assertExactKeys(input ?? {}, SETTINGS_KEYS, "交流板设置");
  const base = existing ?? {
    default_file_sync_machines: ["*"],
    auto_archive_days: limits.defaultAutoArchiveDays,
    default_poll_interval_sec: limits.defaultPollIntervalSec,
  };
  const next = {
    default_file_sync_machines: Array.isArray(base.default_file_sync_machines)
      ? [...base.default_file_sync_machines]
      : ["*"],
    auto_archive_days: base.auto_archive_days ?? limits.defaultAutoArchiveDays,
    default_poll_interval_sec: base.default_poll_interval_sec ?? limits.defaultPollIntervalSec,
  };

  if (input && Object.hasOwn(input, "default_file_sync_machines")) {
    const rawMachines = input.default_file_sync_machines;
    if (!Array.isArray(rawMachines) || rawMachines.length === 0 || rawMachines.length > 128) {
      throw new CoreError("invalid_input", "default_file_sync_machines 必须是非空机器标识数组");
    }
    const deduped = [];
    const seen = new Set();
    for (const item of rawMachines) {
      const value = requireText(item, "default_file_sync_machines[]", 128);
      if (value !== value.trim() || CONTROL_CHARS.test(value)) {
        throw new CoreError("invalid_input", "default_file_sync_machines 包含无效机器标识");
      }
      if (!seen.has(value)) {
        seen.add(value);
        deduped.push(value);
      }
    }
    if (seen.has("*") && deduped.length > 1) {
      throw new CoreError("invalid_input", "default_file_sync_machines 使用通配符 * 时不能混用具体机器标识");
    }
    next.default_file_sync_machines = deduped;
  }

  if (input && Object.hasOwn(input, "auto_archive_days")) {
    next.auto_archive_days = requireInteger(
      input.auto_archive_days,
      "auto_archive_days",
      limits.minAutoArchiveDays,
      limits.maxAutoArchiveDays,
    );
  }

  if (input && Object.hasOwn(input, "default_poll_interval_sec")) {
    next.default_poll_interval_sec = requireInteger(
      input.default_poll_interval_sec,
      "default_poll_interval_sec",
      limits.minPollIntervalSec,
      limits.maxPollIntervalSec,
    );
  }

  return next;
}

function hydrateBoard(raw) {
  if (!raw) return null;
  const settings = raw.settings ?? safeParseJson(raw.settings_json, {
    default_file_sync_machines: ["*"],
    auto_archive_days: DEFAULT_ENGINE_LIMITS.defaultAutoArchiveDays,
    default_poll_interval_sec: DEFAULT_ENGINE_LIMITS.defaultPollIntervalSec,
  });
  return {
    ...raw,
    settings,
  };
}

function hydrateMember(raw) {
  if (!raw) return null;
  const filterTargets = Array.isArray(raw.filter_targets)
    ? raw.filter_targets
    : safeParseJson(raw.filter_targets_json, []);
  return {
    ...raw,
    filter_targets: Array.isArray(filterTargets) ? filterTargets : [],
    last_read_seq: Number.isSafeInteger(raw.last_read_seq) ? raw.last_read_seq : 0,
    last_notified_seq: Number.isSafeInteger(raw.last_notified_seq) ? raw.last_notified_seq : 0,
  };
}

function hydratePost(raw) {
  if (!raw) return null;
  const author = raw.author ?? safeParseJson(raw.author_json, null);
  const mentions = Array.isArray(raw.mentions) ? raw.mentions : safeParseJson(raw.mentions_json, []);
  const files = Array.isArray(raw.files) ? raw.files : safeParseJson(raw.files_json, []);
  return {
    ...raw,
    author,
    mentions: Array.isArray(mentions) ? mentions : [],
    files: Array.isArray(files) ? files : [],
  };
}

export function shouldNotifyMemberForPost(member, post) {
  if (!member || typeof member !== "object" || !post || typeof post !== "object") {
    return { notify: false, reason: "invalid_input", changePollCadence: false };
  }
  if (member.subscription_state !== undefined && member.subscription_state !== "active") {
    return { notify: false, reason: "unsubscribed", changePollCadence: false };
  }
  let memberKey;
  let authorKey;
  try {
    memberKey = extractMemberKey(member);
    authorKey = extractPostAuthorKey(post);
  } catch {
    return { notify: false, reason: "invalid_input", changePollCadence: false };
  }

  if (authorKey !== null && memberKey === authorKey) {
    return { notify: false, reason: "self_post", changePollCadence: false };
  }

  const mentions = extractStringKeySet(post.mentions ?? post.mentions_json);
  if (mentions.has(memberKey)) {
    return { notify: true, reason: "mentioned", changePollCadence: false };
  }

  const filterMode = member.filter_mode ?? "all";
  const filterTargets = extractStringKeySet(member.filter_targets ?? member.filter_targets_json);

  if (filterMode === "mute") {
    if (filterTargets.size === 0) {
      return { notify: false, reason: "muted", changePollCadence: false };
    }
    if (authorKey !== null && filterTargets.has(authorKey)) {
      return { notify: false, reason: "muted_author", changePollCadence: false };
    }
    return { notify: true, reason: "not_muted", changePollCadence: false };
  }

  if (filterMode === "only") {
    if (authorKey !== null && filterTargets.has(authorKey)) {
      return { notify: true, reason: "only_matched", changePollCadence: false };
    }
    return { notify: false, reason: "only_filtered", changePollCadence: false };
  }

  return { notify: true, reason: "all", changePollCadence: false };
}

export function allocateBoardAlias(addressBookAdapter, memberIdentity, board, localMachineId) {
  const member = normalizeConcreteIdentity(memberIdentity);
  const localMachine = checkedStrictToken(localMachineId, "localMachineId", 128);
  assertPlainObject(board, "交流板短代号参数");
  const machineId = checkedStrictToken(board.machine_id, "machine_id", 128);
  const boardId = validateBoardIdValue(board.board_id);
  const baseTitle = checkedLineText(board.baseTitle, "baseTitle", 512, 128);

  if (member.machine_id !== localMachine) {
    return { alias_allocated: false, alias_warning: "remote_member_deferred" };
  }
  if (!addressBookAdapter || typeof addressBookAdapter.saveBoardForIdentity !== "function") {
    return { alias_allocated: false, alias_warning: "contacts_unavailable" };
  }

  const strictBoardPayload = {
    machine_id: machineId,
    board_id: boardId,
    baseTitle,
  };

  try {
    const result = addressBookAdapter.saveBoardForIdentity(
      {
        machine_id: member.machine_id,
        host: member.host,
        surface: member.surface,
        conversation_id: member.conversation_id,
      },
      strictBoardPayload,
    );
    if (result?.alias_allocated === true && typeof result.alias === "string") {
      return { alias_allocated: true, alias: result.alias };
    }
    return {
      alias_allocated: false,
      alias_warning: typeof result?.alias_warning === "string" ? result.alias_warning : "alias_unavailable",
    };
  } catch (error) {
    if (error instanceof CoreError && (error.code === "contact_limit" || error.code === "contact_alias_conflict")) {
      return { alias_allocated: false, alias_warning: error.code };
    }
    throw error;
  }
}

export class BoardEngine {
  #store;
  #localMachineId;
  #addressBookAdapter;
  #superAdminKeys;
  #peerCapabilitiesProvider;
  #notifyLocalMember;
  #onBoardChanged;
  #limits;
  #now;
  #closed = false;
  #pendingDigestByBoardMember = new Map();

  constructor({
    store,
    localMachineId,
    addressBookAdapter = null,
    superAdminIdentities = [],
    peerCapabilitiesProvider = null,
    notifyLocalMember = null,
    onBoardChanged = null,
    limits = {},
    now = () => Date.now(),
  } = {}) {
    if (!store || typeof store !== "object") {
      throw new CoreError("invalid_config", "BoardEngine 需要提供 store 实例");
    }
    this.#store = store;
    this.#localMachineId = checkedStrictToken(localMachineId, "localMachineId", 128);
    this.#addressBookAdapter = addressBookAdapter ?? null;
    if (!Array.isArray(superAdminIdentities)) {
      throw new CoreError("invalid_config", "superAdminIdentities 必须是身份数组");
    }
    const adminSet = new Set();
    for (const identity of superAdminIdentities) {
      const normalized = normalizeConcreteIdentity(identity);
      adminSet.add(identityKey(normalized));
    }
    this.#superAdminKeys = adminSet;
    this.#peerCapabilitiesProvider = peerCapabilitiesProvider ?? null;
    this.#notifyLocalMember = typeof notifyLocalMember === "function" ? notifyLocalMember : null;
    this.#onBoardChanged = typeof onBoardChanged === "function" ? onBoardChanged : null;
    this.#limits = Object.freeze({ ...DEFAULT_ENGINE_LIMITS, ...(limits ?? {}) });
    if (typeof now !== "function") {
      throw new CoreError("invalid_config", "now 必须是时钟函数");
    }
    this.#now = now;
  }

  #assertOpen(signal = null) {
    if (this.#closed) {
      throw new CoreError("closed", "交流板引擎已关闭");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof CoreError
        ? signal.reason
        : new CoreError("request_cancelled", "交流板请求已取消");
    }
  }

  #nowMs() {
    const value = this.#now();
    const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw new CoreError("invalid_input", "时钟返回的时间无效");
    }
    return ms;
  }

  #nowIso() {
    return new Date(this.#nowMs()).toISOString();
  }

  isSuperAdmin(identity) {
    try {
      const normalized = normalizeConcreteIdentity(identity);
      return this.#superAdminKeys.has(identityKey(normalized));
    } catch {
      return false;
    }
  }

  #emitBoardChanged(event) {
    if (!this.#onBoardChanged) return;
    try {
      this.#onBoardChanged(event);
    } catch {
      // 变更钩子异常不阻断已完成的主流程
    }
  }

  #resolveBoardRef(actor, boardInput, params) {
    let ref = boardInput;
    if (ref === undefined || ref === null) {
      if (params?.board !== undefined && params.board !== null) {
        ref = params.board;
      } else if (params?.board_id !== undefined) {
        ref = {
          board_id: params.board_id,
          ...(params.host_machine_id !== undefined
            ? { machine_id: params.host_machine_id }
            : params.machine_id !== undefined
              ? { machine_id: params.machine_id }
              : {}),
        };
      }
    }
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new CoreError("invalid_input", "缺少有效的交流板地址或标识");
    }
    if (Object.hasOwn(ref, "contact")) {
      assertExactKeys(ref, ["contact"], "交流板代号");
      if (actor.machine_id !== this.#localMachineId || !this.#addressBookAdapter || typeof this.#addressBookAdapter.resolveBoard !== "function") {
        throw new CoreError("contacts_unavailable", "当前调用者无法解析本机通讯录交流板代号");
      }
      const resolved = this.#addressBookAdapter.resolveBoard({ identity: actor, address_book_identity_bound: true }, ref.contact);
      return { machine_id: resolved.machine_id, board_id: resolved.board_id, explicit_machine: true };
    }
    const explicitMachine = ref.machine_id !== undefined && ref.machine_id !== null;
    const normalized = normalizeBoardAddress(ref, this.#localMachineId);
    return {
      machine_id: normalized.machine_id,
      board_id: normalized.board_id,
      explicit_machine: explicitMachine,
    };
  }

  #loadBoardForRef(ref) {
    const raw = this.#store.getBoard(ref.board_id);
    if (!raw) return null;
    const board = hydrateBoard(raw);
    if (ref.explicit_machine && board.host_machine_id !== ref.machine_id) {
      return null;
    }
    return board;
  }

  #assertActiveMemberOrAdmin(boardId, actorKey, isAdmin) {
    const member = hydrateMember(this.#store.getMember(boardId, actorKey));
    if (member && member.subscription_state === "active") {
      return member;
    }
    if (isAdmin) {
      return member;
    }
    throw new CoreError("forbidden", "仅交流板活跃成员或管理员可执行该操作");
  }

  #resolveContactIdentity(actor, alias) {
    if (actor.machine_id !== this.#localMachineId) {
      throw new CoreError("forbidden", "跨机调用不能使用本机通讯录联系人别名");
    }
    if (!this.#addressBookAdapter || typeof this.#addressBookAdapter.resolve !== "function") {
      throw new CoreError("contacts_unavailable", "本机通讯录尚未启用");
    }
    const entry = this.#addressBookAdapter.resolve({ identity: actor, address_book_identity_bound: true }, alias);
    if (entry.entry_kind === "board") {
      throw new CoreError("board_not_direct_target", "交流板代号不能作为成员身份");
    }
    return normalizeConcreteIdentity(entry.target);
  }

  #resolveMemberSpec(actor, item, { requireFullIdentity = false, boardMembers = null } = {}) {
    if (typeof item === "string") {
      const parsed = parseIdentityKeyString(item);
      if (parsed) {
        return { identity: parsed, member_key: identityKey(parsed) };
      }
      if (!requireFullIdentity && Array.isArray(boardMembers)) {
        const matched = boardMembers.find(member =>
          member.member_key === item
          || `${member.machine_id}/${member.host}/${member.conversation_id}` === item
          || `${member.machine_id}/${member.host}/${member.surface}/${member.conversation_id}` === item);
        if (matched) {
          const identity = normalizeConcreteIdentity(matched);
          return { identity, member_key: matched.member_key };
        }
      }
      throw new CoreError("invalid_input", "成员标识格式无效");
    }
    assertPlainObject(item, "成员参数");
    if (Object.hasOwn(item, "contact")) {
      assertExactKeys(item, ["contact"], "联系人引用");
      const resolved = this.#resolveContactIdentity(actor, item.contact);
      return { identity: resolved, member_key: identityKey(resolved) };
    }
    assertExactKeys(item, ADDRESS_KEYS, "成员地址");
    const identity = normalizeConcreteIdentity(item, actor.machine_id);
    return { identity, member_key: identityKey(identity) };
  }

  #resolveMemberKeysList(actor, list, fieldName, boardMembers = null) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || list.length > this.#limits.maxMembersPerBoard) {
      throw new CoreError("invalid_input", `${fieldName} 数量超出范围`);
    }
    const deduped = [];
    const seen = new Set();
    for (const item of list) {
      const { member_key } = this.#resolveMemberSpec(actor, item, { requireFullIdentity: false, boardMembers });
      if (!seen.has(member_key)) {
        seen.add(member_key);
        deduped.push(member_key);
      }
    }
    return deduped;
  }

  #resolvePeerDisplayName(readerIdentity, peerIdentity) {
    const reader = normalizeConcreteIdentity(readerIdentity);
    const peer = normalizeConcreteIdentity(peerIdentity);
    const fallback = fallbackDisplayName(peer);
    if (reader.machine_id !== this.#localMachineId) {
      return fallback;
    }
    if (!this.#addressBookAdapter || typeof this.#addressBookAdapter.resolveDisplayName !== "function") {
      return fallback;
    }
    try {
      const resolved = this.#addressBookAdapter.resolveDisplayName(
        {
          machine_id: reader.machine_id,
          host: reader.host,
          surface: reader.surface,
          conversation_id: reader.conversation_id,
        },
        {
          machine_id: peer.machine_id,
          host: peer.host,
          surface: peer.surface,
          conversation_id: peer.conversation_id,
        },
      );
      return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : fallback;
    } catch {
      return fallback;
    }
  }

  #loadBoardAliasMapForActor(actor) {
    const aliasMap = new Map();
    if (actor.machine_id !== this.#localMachineId || !this.#addressBookAdapter) {
      return aliasMap;
    }
    try {
      if (typeof this.#addressBookAdapter.listBoardsForIdentity === "function") {
        const entries = this.#addressBookAdapter.listBoardsForIdentity(actor) ?? [];
        for (const entry of entries) {
          if (entry?.target?.machine_id && entry?.target?.board_id && typeof entry.alias === "string") {
            aliasMap.set(`${entry.target.machine_id}\0${entry.target.board_id}`, entry.alias);
          }
        }
        return aliasMap;
      }
      if (typeof this.#addressBookAdapter.list === "function") {
        const listed = this.#addressBookAdapter.list({ identity: actor, address_book_identity_bound: true });
        for (const entry of listed?.contacts ?? []) {
          if (entry?.entry_kind !== "board" || !entry?.target?.machine_id || !entry?.target?.board_id) continue;
          const key = `${entry.target.machine_id}\0${entry.target.board_id}`;
          if (!aliasMap.has(key) || entry.scope === "personal") {
            aliasMap.set(key, entry.alias);
          }
        }
      }
    } catch {
      // 通讯录不可用时静默降级为无别名
    }
    return aliasMap;
  }

  #lookupPeerCapability(machineId) {
    const provider = this.#peerCapabilitiesProvider;
    if (!provider) return null;
    if (typeof provider === "function") {
      return provider(machineId) ?? null;
    }
    if (provider instanceof Map) {
      return provider.get(machineId) ?? null;
    }
    if (typeof provider === "object") {
      return Object.hasOwn(provider, machineId) ? provider[machineId] : null;
    }
    return null;
  }

  #evaluateFileSyncTargets(board, requestedSyncMachines, hasFiles, { excludeMachineIds = [] } = {}) {
    if (!hasFiles) {
      return { target_sync_machines: [], unreachable_machines: [] };
    }
    const excludedMachines = new Set([this.#localMachineId]);
    for (const machineId of excludeMachineIds) {
      if (typeof machineId === "string" && machineId.length > 0) {
        excludedMachines.add(machineId);
      }
    }
    const activeRemotePeers = new Set(
      (this.#store.listActiveRemotePeerMachines?.(board.board_id, this.#localMachineId) ?? [])
        .filter(machineId => typeof machineId === "string" && !excludedMachines.has(machineId)),
    );

    let candidates;
    if (requestedSyncMachines !== undefined && requestedSyncMachines !== null) {
      if (!Array.isArray(requestedSyncMachines) || requestedSyncMachines.length > 128) {
        throw new CoreError("invalid_input", "sync_machines 必须是机器标识数组");
      }
      candidates = requestedSyncMachines.map(item => {
        const value = requireText(item, "sync_machines[]", 128);
        if (value !== value.trim() || CONTROL_CHARS.test(value)) {
          throw new CoreError("invalid_input", "sync_machines 包含无效机器标识");
        }
        return value;
      });
    } else {
      candidates = Array.isArray(board.settings?.default_file_sync_machines)
        ? board.settings.default_file_sync_machines
        : ["*"];
    }

    const expanded = [];
    const seen = new Set();
    const pushUnique = machineId => {
      if (excludedMachines.has(machineId)) return;
      if (!seen.has(machineId)) {
        seen.add(machineId);
        expanded.push(machineId);
      }
    };

    for (const item of candidates) {
      if (item === "*") {
        for (const remoteMachineId of [...activeRemotePeers].sort()) {
          pushUnique(remoteMachineId);
        }
      } else {
        pushUnique(item);
      }
    }

    const targetSyncMachines = [];
    const unreachableMachines = [];

    for (const machineId of expanded) {
      const capability = this.#lookupPeerCapability(machineId);
      if (!capability || capability.known === false) {
        unreachableMachines.push({ machine_id: machineId, reason: "unknown_peer" });
        continue;
      }
      if (capability.reachable === false) {
        unreachableMachines.push({ machine_id: machineId, reason: capability.reason ?? "peer_unreachable" });
        continue;
      }
      if (capability.allow_file_bundle !== true) {
        unreachableMachines.push({ machine_id: machineId, reason: "file_bundle_disabled" });
        continue;
      }
      if (!activeRemotePeers.has(machineId)) {
        unreachableMachines.push({ machine_id: machineId, reason: "no_active_subscription" });
        continue;
      }
      targetSyncMachines.push(machineId);
    }

    return {
      target_sync_machines: targetSyncMachines,
      unreachable_machines: unreachableMachines,
    };
  }

  #assertVerifiedRemotePrincipal(actor, remotePrincipal, actionLabel = "跨机操作") {
    if (remotePrincipal === null || remotePrincipal === undefined) return;
    if (
      typeof remotePrincipal !== "object"
      || remotePrincipal.trust_source_identity !== true
      || remotePrincipal.source_identity_verified !== true
      || remotePrincipal.from_machine !== actor.machine_id
    ) {
      throw new CoreError("source_unverified", `${actionLabel}缺少可信来源身份校验`);
    }
  }

  #cleanupStagedTempFiles(stagingNames) {
    if (!Array.isArray(stagingNames) || stagingNames.length === 0) return;
    const names = [...new Set(stagingNames.filter(name => typeof name === "string" && name.length > 0))];
    if (names.length === 0) return;
    try {
      if (typeof this.#store.cleanupStagedTempFiles === "function") {
        this.#store.cleanupStagedTempFiles(names);
        return;
      }
      if (typeof this.#store.getStagingDir !== "function") return;
      const stagingDir = this.#store.getStagingDir();
      for (const stagingName of names) {
        if (stagingName.includes("/") || stagingName.includes("\\") || stagingName.includes("..")) continue;
        const stagingPath = path.join(stagingDir, stagingName);
        if (!isPathWithinRoot(stagingDir, stagingPath)) continue;
        try {
          const stat = lstatSync(stagingPath);
          if (!stat.isSymbolicLink() && stat.isFile()) {
            rmSync(stagingPath, { force: true });
          }
        } catch {
          // 忽略单文件清理异常
        }
      }
    } catch {
      // 清理失败绝不覆盖主错误
    }
  }

  #cleanupFailedOutboxFiles(localPostId, stagedOutboxFiles = []) {
    try {
      if (typeof this.#store.cleanupOutboxDir === "function") {
        this.#store.cleanupOutboxDir(localPostId);
        return;
      }
      if (typeof this.#store.getOutboxDir === "function") {
        const outboxDir = this.#store.getOutboxDir(localPostId);
        if (typeof outboxDir === "string" && path.basename(path.dirname(outboxDir)) === ".outbox") {
          rmSync(outboxDir, { recursive: true, force: true });
          return;
        }
      }
      for (const item of stagedOutboxFiles) {
        const filePath = item?.outbox_path;
        if (typeof filePath !== "string" || !filePath) continue;
        try {
          const stat = lstatSync(filePath);
          if (!stat.isSymbolicLink() && stat.isFile()) {
            rmSync(filePath, { force: true });
          }
        } catch {
          // 忽略单文件清理异常
        }
      }
    } catch {
      // 清理失败绝不覆盖主错误
    }
  }

  #cleanupPreStagedRemoteFiles(boardId, preStagedFiles) {
    if (!boardId || !BOARD_ID_PATTERN.test(boardId) || !Array.isArray(preStagedFiles) || preStagedFiles.length === 0) {
      return;
    }
    let boardFilesDir = null;
    try {
      if (typeof this.#store.getBoardFilesDir === "function") {
        boardFilesDir = this.#store.getBoardFilesDir(boardId);
      } else if (typeof this.#store.resolveSafeBoardFilePath === "function") {
        boardFilesDir = path.dirname(this.#store.resolveSafeBoardFilePath(boardId, "f-probe", "probe.bin", { archived: false }));
      }
    } catch {
      boardFilesDir = null;
    }
    if (typeof boardFilesDir !== "string" || !boardFilesDir) return;

    for (const item of preStagedFiles) {
      if (!item || typeof item !== "object") continue;
      if (item.newly_staged === false || item.already_existed === true) continue;
      const candidatePath = item.local_path;
      if (typeof candidatePath !== "string" || !candidatePath) continue;
      if (!isPathWithinRoot(boardFilesDir, candidatePath)) continue;
      if (typeof item.file_id === "string" && SAFE_ID_PATTERN.test(item.file_id)) {
        try {
          if (typeof this.#store.getPostByFileId === "function" && this.#store.getPostByFileId(boardId, item.file_id)) {
            continue;
          }
        } catch {
          // 查库异常时保守继续尝试按磁盘安全边界判断
        }
      }
      try {
        const stat = lstatSync(candidatePath);
        if (!stat.isSymbolicLink() && stat.isFile()) {
          rmSync(candidatePath, { force: true });
        }
      } catch {
        // 忽略单个孤儿文件清理异常
      }
    }
  }

  #enqueueClientControlRequest({ boardId, hostMachineId, actor, action, payload }) {
    const requestId = randomUUID();
    const nowIso = this.#nowIso();
    const actorKey = identityKey(actor);
    const dedupeKey = `client_ctrl:${action}:${boardId}:${requestId}`;
    this.#store.enqueueRemoteOutbox({
      local_post_id: requestId,
      dedupe_key: dedupeKey,
      board_id: boardId,
      host_machine_id: hostMachineId,
      author_key: actorKey,
      op_kind: "client_control_request",
      payload_json: JSON.stringify({
        request_id: requestId,
        action,
        board_id: boardId,
        actor,
        params: payload,
      }),
      nowIso,
    });
    this.#emitBoardChanged({
      kind: "outbox_enqueued",
      board_id: boardId,
      host_machine_id: hostMachineId,
      op_kind: "client_control_request",
      request_id: requestId,
      action,
    });
    return {
      board_id: boardId,
      pending_host_ack: true,
      request_id: requestId,
      action,
    };
  }

  #clearTrackedPendingDigest(record) {
    if (record?.kind !== "poll_digest") return;
    const key = `${record.board_id}\0${record.member_key}`;
    const tracked = this.#pendingDigestByBoardMember.get(key);
    if (tracked && tracked.dedupe_key === record.dedupe_key) {
      this.#pendingDigestByBoardMember.delete(key);
    }
  }

  async #deliverNotificationRecord(record, signal = null) {
    const member = safeParseJson(record.member_json, null);
    if (!member || member.machine_id !== this.#localMachineId) {
      if (member && member.machine_id && member.machine_id !== this.#localMachineId) {
        this.#store.markNotificationStatus?.(record.dedupe_key, {
          status: "cancelled",
          retry_count: record.retry_count ?? 0,
          next_retry_at: 0,
          nowIso: this.#nowIso(),
        });
        this.#clearTrackedPendingDigest(record);
      }
      return { outcome: "skipped" };
    }
    if (!this.#notifyLocalMember) {
      return { outcome: "skipped" };
    }
    if (this.#store.getTombstone?.(record.board_id)) {
      this.#store.markNotificationStatus(record.dedupe_key, {
        status: "cancelled",
        retry_count: record.retry_count ?? 0,
        next_retry_at: 0,
        nowIso: this.#nowIso(),
      });
      this.#clearTrackedPendingDigest(record);
      return { outcome: "cancelled" };
    }
    const payload = safeParseJson(record.payload_json, {});
    const nowMs = this.#nowMs();
    const nowIso = new Date(nowMs).toISOString();
    try {
      const response = await this.#notifyLocalMember(
        {
          dedupe_key: record.dedupe_key,
          kind: record.kind,
          board_id: record.board_id,
          member,
          member_key: record.member_key,
          state_version: record.state_version,
          payload,
          signal,
        },
        { signal },
      );
      if (isNotificationAccepted(response)) {
        this.#store.markNotificationStatus(record.dedupe_key, {
          status: "sent",
          retry_count: record.retry_count ?? 0,
          next_retry_at: 0,
          nowIso,
        });
        this.#clearTrackedPendingDigest(record);
        if (record.kind === "event_post" && Number.isSafeInteger(payload?.seq)) {
          const currentMember = hydrateMember(this.#store.getMember?.(record.board_id, record.member_key));
          if (!currentMember || payload.seq > currentMember.last_notified_seq) {
            this.#store.updateMemberNotifiedCursor?.(record.board_id, record.member_key, payload.seq);
          }
        } else if (record.kind === "poll_digest") {
          const targetSeq = Number.isSafeInteger(payload?.max_scanned_seq)
            ? payload.max_scanned_seq
            : (Number.isSafeInteger(payload?.to_seq) ? payload.to_seq : null);
          if (targetSeq !== null) {
            const currentMember = hydrateMember(this.#store.getMember?.(record.board_id, record.member_key));
            if (!currentMember || targetSeq > currentMember.last_notified_seq) {
              this.#store.updateMemberNotifiedCursor?.(record.board_id, record.member_key, targetSeq);
            }
          }
        }
        return { outcome: "delivered" };
      }
    } catch {
      // 投递失败保留在持久通知队列中按退避重试
    }
    const nextRetryCount = (record.retry_count ?? 0) + 1;
    const backoff = Math.min(
      this.#limits.notifyRetryMaxMs,
      this.#limits.notifyRetryBaseMs * (2 ** Math.min(nextRetryCount - 1, 7)),
    );
    this.#store.markNotificationStatus(record.dedupe_key, {
      status: "pending",
      retry_count: nextRetryCount,
      next_retry_at: nowMs + backoff,
      nowIso,
    });
    return { outcome: "failed" };
  }

  async invoke({ action, actorIdentity, board = null, params = {}, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    if (typeof action !== "string" || !BOARD_ACTIONS.has(action)) {
      throw new CoreError("invalid_input", "交流板操作无效");
    }
    const actor = normalizeConcreteIdentity(actorIdentity);
    const normalizedParams = params === undefined || params === null ? {} : params;
    assertPlainObject(normalizedParams, "params");

    const context = { board, signal, remotePrincipal };
    switch (action) {
      case "create": return this.createBoard(actor, normalizedParams, context);
      case "list": return this.listBoards(actor, normalizedParams, context);
      case "subscribe": return this.subscribeBoard(actor, normalizedParams, context);
      case "unsubscribe": return this.unsubscribeBoard(actor, normalizedParams, context);
      case "invite": return this.inviteMembers(actor, normalizedParams, context);
      case "post": return this.postMessage(actor, normalizedParams, context);
      case "read": return this.readBoard(actor, normalizedParams, context);
      case "set_subscription": return this.setSubscription(actor, normalizedParams, context);
      case "query_members": return this.queryMembers(actor, normalizedParams, context);
      case "update_settings": return this.updateSettings(actor, normalizedParams, context);
      case "dissolve": return this.dissolveBoard(actor, normalizedParams, context);
      case "restore": return this.restoreBoard(actor, normalizedParams, context);
      case "delete_archived": return this.deleteArchivedBoard(actor, normalizedParams, context);
      default:
        throw new CoreError("invalid_input", "交流板操作无效");
    }
  }

  async createBoard(actorIdentity, params = {}, { signal } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    assertPlainObject(params ?? {}, "create 参数");
    const title = checkedLineText(params.title, "title", 512, this.#limits.maxTitleChars);
    const boardId = params.board_id !== undefined
      ? validateBoardIdValue(params.board_id)
      : `b-${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    if (this.#store.getBoard(boardId) || this.#store.getTombstone?.(boardId)) {
      throw new CoreError("invalid_input", "交流板标识已存在或已永久删除");
    }

    const settings = normalizeEngineSettings(params.settings ?? {}, null, this.#limits);
    const nowIso = this.#nowIso();
    const created = hydrateBoard(this.#store.createBoard({
      board_id: boardId,
      host_machine_id: this.#localMachineId,
      title,
      settings,
      creator: actor,
      nowIso,
    }));

    const aliasResult = allocateBoardAlias(
      this.#addressBookAdapter,
      actor,
      { machine_id: created.host_machine_id, board_id: created.board_id, baseTitle: created.title },
      this.#localMachineId,
    );

    this.#emitBoardChanged({
      kind: "board_created",
      board_id: created.board_id,
      meta_version: created.meta_version,
    });

    return {
      board_id: created.board_id,
      host_machine_id: created.host_machine_id,
      title: created.title,
      status: created.status,
      state_version: created.state_version,
      meta_version: created.meta_version,
      archive_version: created.archive_version,
      settings: created.settings,
      created_at: created.created_at,
      last_active_at: created.last_active_at,
      alias_allocated: aliasResult.alias_allocated,
      ...(aliasResult.alias !== undefined ? { alias: aliasResult.alias } : {}),
      ...(aliasResult.alias_warning !== undefined ? { alias_warning: aliasResult.alias_warning } : {}),
    };
  }

  async listBoards(actorIdentity, params = {}, { signal } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    assertPlainObject(params ?? {}, "list 参数");
    const limit = params.limit === undefined
      ? this.#limits.defaultListLimit
      : requireInteger(params.limit, "limit", 1, this.#limits.maxListLimit);
    const offset = params.cursor !== undefined && params.cursor !== null
      ? decodeOffsetCursor(params.cursor)
      : params.offset === undefined
        ? 0
        : requireInteger(params.offset, "offset", 0);
    let status = null;
    if (params.status !== undefined && params.status !== null) {
      if (typeof params.status !== "string" || !BOARD_STATUSES.has(params.status)) {
        throw new CoreError("invalid_input", "status 只支持 active 或 archived");
      }
      status = params.status;
    }

    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);
    const listed = this.#store.listBoardsForActor({
      actorKey,
      isSuperAdmin: isAdmin,
      status,
      limit,
      offset,
    });

    const aliasMap = this.#loadBoardAliasMapForActor(actor);
    const boards = (listed?.items ?? []).map(rawItem => {
      const board = hydrateBoard(rawItem);
      const hasEmbeddedMemberFields = Object.hasOwn(rawItem, "subscription_state")
        && Object.hasOwn(rawItem, "delivery_mode");
      const member = rawItem.member !== undefined
        ? hydrateMember(rawItem.member)
        : hasEmbeddedMemberFields
          ? (rawItem.subscription_state !== null
              ? {
                  subscription_state: rawItem.subscription_state,
                  delivery_mode: rawItem.delivery_mode,
                  last_read_seq: Number.isSafeInteger(rawItem.last_read_seq) ? rawItem.last_read_seq : 0,
                }
              : null)
          : hydrateMember(this.#store.getMember(board.board_id, actorKey));
      const hasLastSyncedAt = Object.hasOwn(rawItem, "last_synced_at");
      const lastSyncedAt = hasLastSyncedAt
        ? (rawItem.last_synced_at ?? null)
        : (board.host_machine_id !== this.#localMachineId
            ? (this.#store.getSyncState?.(board.board_id, board.host_machine_id)?.last_synced_at ?? null)
            : null);
      const alias = aliasMap.get(`${board.host_machine_id}\0${board.board_id}`) ?? null;
      const boardSeq = Number.isSafeInteger(board.board_seq) ? board.board_seq : 0;
      const unreadCount = member && member.subscription_state === "active"
        ? Math.max(0, boardSeq - member.last_read_seq)
        : 0;
      return {
        board_id: board.board_id,
        host_machine_id: board.host_machine_id,
        title: board.title,
        alias,
        status: board.status,
        state_version: board.state_version,
        meta_version: board.meta_version,
        archive_version: board.archive_version,
        last_active_at: board.last_active_at,
        delivery_mode: member ? member.delivery_mode : null,
        subscription_state: member ? member.subscription_state : null,
        unread_count: unreadCount,
        last_synced_at: lastSyncedAt,
      };
    });

    const hasMore = listed?.next_offset !== null && listed?.next_offset !== undefined;
    return {
      boards,
      total: listed?.total ?? boards.length,
      next_cursor: hasMore ? encodeOffsetCursor(listed.next_offset) : null,
      has_more: hasMore,
    };
  }

  async subscribeBoard(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机订阅交流板");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }

    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      if (ref.machine_id !== this.#localMachineId) {
        return this.#enqueueClientControlRequest({
          boardId: ref.board_id,
          hostMachineId: ref.machine_id,
          actor,
          action: "subscribe",
          payload: {},
        });
      }
      throw new CoreError("board_not_found", "没有找到可订阅的交流板");
    }

    if (existing.status !== "active") {
      throw new CoreError("board_archived", "交流板已归档，无法订阅");
    }

    if (existing.host_machine_id !== this.#localMachineId) {
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "subscribe",
        payload: {},
      });
    }

    const currentMember = hydrateMember(this.#store.getMember(existing.board_id, actorKey));
    if (!currentMember) {
      const existingMembers = this.#store.listMembers(existing.board_id, { activeOnly: false }) ?? [];
      if (existingMembers.length >= this.#limits.maxMembersPerBoard) {
        throw new CoreError("board_quota_exceeded", "交流板成员数量已达到上限");
      }
    }

    const nowIso = this.#nowIso();
    const { member: rawMember, changed } = this.#store.upsertMember(existing.board_id, actor, {
      subscription_state: "active",
      delivery_mode: currentMember?.delivery_mode ?? "poll",
      filter_mode: currentMember?.filter_mode ?? "all",
      filter_targets: currentMember?.filter_targets ?? [],
      bumpMetaVersion: true,
      nowIso,
    });
    const member = hydrateMember(rawMember);
    const updatedBoard = hydrateBoard(this.#store.getBoard(existing.board_id));

    const aliasResult = allocateBoardAlias(
      this.#addressBookAdapter,
      actor,
      { machine_id: updatedBoard.host_machine_id, board_id: updatedBoard.board_id, baseTitle: updatedBoard.title },
      this.#localMachineId,
    );

    if (changed) {
      this.#emitBoardChanged({
        kind: "member_subscribed",
        board_id: updatedBoard.board_id,
        member_key: actorKey,
        meta_version: updatedBoard.meta_version,
      });
    }

    return {
      board_id: updatedBoard.board_id,
      host_machine_id: updatedBoard.host_machine_id,
      subscription_state: member.subscription_state,
      delivery_mode: member.delivery_mode,
      effective_delivery_mode: effectiveDeliveryMode(member, updatedBoard.host_machine_id),
      meta_version: updatedBoard.meta_version,
      changed: Boolean(changed),
      alias_allocated: aliasResult.alias_allocated,
      ...(aliasResult.alias !== undefined ? { alias: aliasResult.alias } : {}),
      ...(aliasResult.alias_warning !== undefined ? { alias_warning: aliasResult.alias_warning } : {}),
    };
  }

  async unsubscribeBoard(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机退订交流板");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    const member = this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
    if (existing.status !== "active") {
      throw new CoreError("board_archived", "交流板已归档");
    }

    if (existing.host_machine_id !== this.#localMachineId) {
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "unsubscribe",
        payload: {},
      });
    }

    if (!member) {
      return {
        board_id: existing.board_id,
        host_machine_id: existing.host_machine_id,
        subscription_state: "unsubscribed",
        meta_version: existing.meta_version,
        changed: false,
      };
    }

    const { changed } = this.#store.setMemberSubscriptionState(existing.board_id, actorKey, "unsubscribed", {
      bumpMetaVersion: true,
    });
    const updatedBoard = hydrateBoard(this.#store.getBoard(existing.board_id));

    if (changed) {
      this.#emitBoardChanged({
        kind: "member_unsubscribed",
        board_id: updatedBoard.board_id,
        member_key: actorKey,
        meta_version: updatedBoard.meta_version,
      });
    }

    return {
      board_id: updatedBoard.board_id,
      host_machine_id: updatedBoard.host_machine_id,
      subscription_state: "unsubscribed",
      meta_version: updatedBoard.meta_version,
      changed: Boolean(changed),
    };
  }

  async inviteMembers(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机邀请成员");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
    if (existing.status !== "active") {
      throw new CoreError("board_archived", "交流板已归档，无法邀请新成员");
    }

    if (!Array.isArray(params?.members) || params.members.length === 0 || params.members.length > this.#limits.maxMembersPerBoard) {
      throw new CoreError("invalid_input", "members 必须是非空且有界的成员数组");
    }

    const targets = [];
    const seen = new Set();
    for (const rawItem of params.members) {
      const resolved = this.#resolveMemberSpec(actor, rawItem, { requireFullIdentity: true });
      if (!seen.has(resolved.member_key)) {
        seen.add(resolved.member_key);
        targets.push(resolved);
      }
    }

    if (existing.host_machine_id !== this.#localMachineId) {
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "invite",
        payload: { members: targets.map(item => item.identity) },
      });
    }

    const currentMembers = (this.#store.listMembers(existing.board_id, { activeOnly: false }) ?? []).map(hydrateMember);
    const currentByKey = new Map(currentMembers.map(member => [member.member_key, member]));

    let newMemberAdditions = 0;
    const changingIndexes = [];
    for (let index = 0; index < targets.length; index += 1) {
      const prev = currentByKey.get(targets[index].member_key);
      if (!prev) {
        newMemberAdditions += 1;
        changingIndexes.push(index);
      } else if (prev.subscription_state !== "active") {
        changingIndexes.push(index);
      }
    }

    if (currentMembers.length + newMemberAdditions > this.#limits.maxMembersPerBoard) {
      throw new CoreError("board_quota_exceeded", "交流板成员数量超过上限");
    }

    const lastChangingIndex = changingIndexes.length > 0 ? changingIndexes[changingIndexes.length - 1] : -1;
    const nowIso = this.#nowIso();
    let addedCount = 0;
    let reactivatedCount = 0;
    let unchangedCount = 0;
    const invitedResults = [];

    const executeInvite = () => {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        const prev = currentByKey.get(target.member_key);
        const shouldBump = index === lastChangingIndex;
        let outcomeStatus;
        if (!prev) {
          this.#store.upsertMember(existing.board_id, target.identity, {
            subscription_state: "active",
            delivery_mode: "poll",
            filter_mode: "all",
            filter_targets: [],
            bumpMetaVersion: shouldBump,
            nowIso,
          });
          outcomeStatus = "added";
          addedCount += 1;
        } else if (prev.subscription_state !== "active") {
          this.#store.upsertMember(existing.board_id, target.identity, {
            subscription_state: "active",
            delivery_mode: prev.delivery_mode ?? "poll",
            filter_mode: prev.filter_mode ?? "all",
            filter_targets: prev.filter_targets ?? [],
            bumpMetaVersion: shouldBump,
            nowIso,
          });
          outcomeStatus = "reactivated";
          reactivatedCount += 1;
        } else {
          outcomeStatus = "already_active";
          unchangedCount += 1;
        }
        invitedResults.push({
          member_key: target.member_key,
          identity: target.identity,
          status: outcomeStatus,
        });
      }
    };

    if (typeof this.#store.runInTransaction === "function") {
      this.#store.runInTransaction(executeInvite);
    } else {
      executeInvite();
    }

    const updatedBoard = hydrateBoard(this.#store.getBoard(existing.board_id));
    // 隐私防线：仅给本机受邀者分配短代号，且绝不向邀请人返回受邀者个人 alias（含 #2/#3）
    const sanitizedInvited = invitedResults.map(entry => {
      const aliasOutcome = allocateBoardAlias(
        this.#addressBookAdapter,
        entry.identity,
        {
          machine_id: updatedBoard.host_machine_id,
          board_id: updatedBoard.board_id,
          baseTitle: updatedBoard.title,
        },
        this.#localMachineId,
      );
      return {
        member_key: entry.member_key,
        identity: entry.identity,
        status: entry.status,
        alias_allocated: aliasOutcome.alias_allocated,
        ...(aliasOutcome.alias_warning !== undefined ? { alias_warning: aliasOutcome.alias_warning } : {}),
      };
    });

    if (addedCount > 0 || reactivatedCount > 0) {
      this.#emitBoardChanged({
        kind: "members_invited",
        board_id: updatedBoard.board_id,
        meta_version: updatedBoard.meta_version,
        added_count: addedCount,
        reactivated_count: reactivatedCount,
      });
    }

    return {
      board_id: updatedBoard.board_id,
      host_machine_id: updatedBoard.host_machine_id,
      meta_version: updatedBoard.meta_version,
      added_count: addedCount,
      reactivated_count: reactivatedCount,
      unchanged_count: unchangedCount,
      invited: sanitizedInvited,
    };
  }

  canActorPostToBoard(actorIdentity, boardId) {
    if (this.#closed) {
      return { allowed: false, reason: "closed" };
    }
    let actor;
    let resolvedBoardId;
    let explicitMachine = null;
    try {
      actor = normalizeConcreteIdentity(actorIdentity);
      if (typeof boardId === "string") {
        resolvedBoardId = validateBoardIdValue(boardId);
      } else if (boardId && typeof boardId === "object" && !Array.isArray(boardId)) {
        resolvedBoardId = validateBoardIdValue(boardId.board_id);
        if (boardId.machine_id !== undefined && boardId.machine_id !== null) {
          explicitMachine = checkedStrictToken(boardId.machine_id, "machine_id", 128);
        }
      } else {
        return { allowed: false, reason: "invalid_input" };
      }
    } catch {
      return { allowed: false, reason: "invalid_input" };
    }

    if (this.#store.getTombstone?.(resolvedBoardId)) {
      return { allowed: false, reason: "board_not_found" };
    }
    const existing = hydrateBoard(this.#store.getBoard(resolvedBoardId));
    if (!existing || (explicitMachine !== null && existing.host_machine_id !== explicitMachine)) {
      return { allowed: false, reason: "board_not_found" };
    }
    if (existing.host_machine_id !== this.#localMachineId) {
      return { allowed: false, reason: "host_authority_mismatch" };
    }

    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);
    const member = hydrateMember(this.#store.getMember(existing.board_id, actorKey));
    if (!isAdmin && (!member || member.subscription_state !== "active")) {
      return { allowed: false, reason: "forbidden" };
    }
    if (existing.status !== "active") {
      return { allowed: false, reason: "board_archived" };
    }
    return { allowed: true };
  }

  async #finalizeHostPost({
    existing,
    post,
    deduplicated,
    targetSyncMachines,
    unreachableMachines,
    stagedPathsByFileId,
    nowIso,
    signal,
  }) {
    const updatedBoard = hydrateBoard(this.#store.getBoard(existing.board_id));

    // 本机 event 成员即时提醒（严限 member.machine_id === host_machine_id === localMachineId）
    if (!deduplicated) {
      const activeMembers = (this.#store.listMembers(existing.board_id, { activeOnly: true }) ?? []).map(hydrateMember);
      for (const member of activeMembers) {
        if (member.machine_id !== updatedBoard.host_machine_id || member.machine_id !== this.#localMachineId) {
          continue;
        }
        if (member.delivery_mode !== "event") {
          continue;
        }
        const decision = shouldNotifyMemberForPost(member, post);
        if (!decision.notify) continue;

        const memberIdentity = normalizeConcreteIdentity(member);
        const dedupeKey = `event_post:${existing.board_id}:${post.seq}:${member.member_key}`;
        const payload = {
          board_id: existing.board_id,
          host_machine_id: updatedBoard.host_machine_id,
          title: updatedBoard.title,
          seq: post.seq,
          author_key: post.author_key,
          author_display: this.#resolvePeerDisplayName(memberIdentity, post.author),
          reason: decision.reason,
          preview: truncateUnicode(post.body, 160).text,
          file_count: post.files.length,
        };
        const record = {
          dedupe_key: dedupeKey,
          board_id: existing.board_id,
          member_key: member.member_key,
          member_json: JSON.stringify(memberIdentity),
          kind: "event_post",
          state_version: updatedBoard.state_version,
          payload_json: JSON.stringify(payload),
          retry_count: 0,
        };
        this.#store.enqueueNotification({
          ...record,
          nowIso,
        });
        await this.#deliverNotificationRecord(record, signal);
      }
    }

    const activeRemotePeers = this.#store.listActiveRemotePeerMachines?.(existing.board_id, this.#localMachineId) ?? [];
    const pendingSync = activeRemotePeers.length > 0 || targetSyncMachines.length > 0;

    this.#emitBoardChanged({
      kind: "post_created",
      board_id: existing.board_id,
      seq: post.seq,
      deduplicated,
      has_files: post.files.length > 0,
    });

    const uploadedFiles = post.files.map(file => {
      const resolvedPath = typeof this.#store.resolveSafeBoardFilePath === "function"
        ? this.#store.resolveSafeBoardFilePath(existing.board_id, file.file_id, file.safe_name, { archived: false })
        : (file.local_path ?? stagedPathsByFileId.get(file.file_id));
      return {
        file_id: file.file_id,
        safe_name: file.safe_name,
        bytes: file.bytes,
        sha256: file.sha256,
        local_path: resolvedPath,
        ...(file.bundle_id !== undefined ? { bundle_id: file.bundle_id } : {}),
        ...(file.bundle_label !== undefined ? { bundle_label: file.bundle_label } : {}),
      };
    });

    return {
      board_id: existing.board_id,
      seq: post.seq,
      uploaded_files: uploadedFiles,
      target_sync_machines: targetSyncMachines,
      unreachable_machines: unreachableMachines,
      pending_sync: pendingSync,
      ...(deduplicated ? { deduplicated: true } : {}),
    };
  }

  /**
   * 仅供 BoardSyncCoordinator 内部调用的受控远端发帖入口（严禁经由外部 invoke() 暴露）。
   * 跳过 allowedUploadRoots 二次搬运，直接接收已由 store 预落盘验签的 preStagedFiles。
   */
  async postFromRemoteClient(
    actorIdentity,
    params = {},
    { board: boardInput = null, preStagedFiles = [], remotePrincipal = null, signal } = {},
  ) {
    const rawCandidateBoardId = boardInput?.board_id ?? params?.board?.board_id ?? params?.board_id;
    let cleanupBoardId = typeof rawCandidateBoardId === "string" && BOARD_ID_PATTERN.test(rawCandidateBoardId)
      ? rawCandidateBoardId
      : null;
    let postCommitted = false;

    try {
      this.#assertOpen(signal);
      const actor = normalizeConcreteIdentity(actorIdentity);
      this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机发帖");
      assertPlainObject(params ?? {}, "post 参数");
      const ref = this.#resolveBoardRef(actor, boardInput, params);
      cleanupBoardId = ref.board_id;
      const actorKey = identityKey(actor);
      const isAdmin = this.isSuperAdmin(actor);

      if (this.#store.getTombstone?.(ref.board_id)) {
        throw new CoreError("board_not_found", "交流板不存在或已永久删除");
      }
      const existing = this.#loadBoardForRef(ref);
      if (!existing) {
        throw new CoreError("board_not_found", "没有找到指定的交流板");
      }
      if (existing.host_machine_id !== this.#localMachineId) {
        throw new CoreError("host_authority_mismatch", "当前机器不是该交流板的权威建板机");
      }

      // 严格先核活跃成员/超管，非成员一律先拒 forbidden，绝不暴露板状态
      this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
      if (existing.status !== "active") {
        throw new CoreError("board_archived", "交流板已归档，无法继续发帖");
      }

      const body = params?.body === undefined || params?.body === null ? "" : params.body;
      if (typeof body !== "string") {
        throw new CoreError("invalid_input", "body 必须是字符串");
      }
      if (Buffer.byteLength(body, "utf8") > this.#limits.maxBodyBytes) {
        throw new CoreError("invalid_input", "帖子正文超过大小上限");
      }

      const rawStaged = preStagedFiles === undefined || preStagedFiles === null ? [] : preStagedFiles;
      if (!Array.isArray(rawStaged) || rawStaged.length > this.#limits.maxFilesPerPost) {
        throw new CoreError("invalid_input", `单帖附件数量不能超过 ${this.#limits.maxFilesPerPost} 个`);
      }
      if (!body.trim() && rawStaged.length === 0) {
        throw new CoreError("invalid_input", "帖子正文与附件不能同时为空");
      }

      const boardFilesDir = typeof this.#store.getBoardFilesDir === "function"
        ? this.#store.getBoardFilesDir(existing.board_id)
        : null;
      const seenFileIds = new Set();
      const validatedFiles = [];
      let batchBytes = 0;
      let stagedOnDiskBytes = 0;
      const seenDiskPaths = new Set();

      for (const file of rawStaged) {
        assertPlainObject(file, "预落盘远端附件");
        const fileId = requireText(file.file_id, "preStagedFiles[].file_id", 128);
        if (!SAFE_ID_PATTERN.test(fileId)) {
          throw new CoreError("invalid_input", "preStagedFiles[].file_id 格式无效");
        }
        if (seenFileIds.has(fileId)) {
          throw new CoreError("invalid_input", `单帖包含重复附件标识: ${fileId}`);
        }
        seenFileIds.add(fileId);

        const safeName = checkedLineText(file.safe_name, "preStagedFiles[].safe_name", 256, 128);
        if (safeName === "." || safeName === ".." || FORBIDDEN_FILENAME_CHARS.test(safeName)) {
          throw new CoreError("invalid_input", "preStagedFiles[].safe_name 包含非法字符");
        }
        const bytes = requireInteger(file.bytes, "preStagedFiles[].bytes", 0);
        if (bytes > this.#limits.maxFileBytes) {
          throw new CoreError("board_file_too_large", `单文件不能超过 ${this.#limits.maxFileBytes} 字节`);
        }
        const sha256 = requireText(file.sha256, "preStagedFiles[].sha256", 64);
        if (!SHA256_PATTERN.test(sha256)) {
          throw new CoreError("invalid_input", "preStagedFiles[].sha256 必须是 64 位小写十六进制");
        }
        const relPath = requireText(file.rel_path, "preStagedFiles[].rel_path", 512);
        const relSegments = relPath.split("/");
        if (
          CONTROL_CHARS.test(relPath)
          || relPath.includes("\\")
          || relPath.startsWith("/")
          || /^[A-Za-z]:/.test(relPath)
          || relSegments.some(seg => seg.length === 0 || seg === "." || seg === "..")
        ) {
          throw new CoreError("invalid_input", "preStagedFiles[].rel_path 无效");
        }
        const localPath = requireText(file.local_path, "preStagedFiles[].local_path", 4096);
        if (localPath.includes("\0") || CONTROL_CHARS.test(localPath)) {
          throw new CoreError("invalid_input", "preStagedFiles[].local_path 包含非法字符");
        }
        if (boardFilesDir && !isPathWithinRoot(boardFilesDir, localPath)) {
          throw new CoreError("invalid_input", "preStagedFiles[].local_path 超出本板附件目录边界");
        }

        const bundleId = file.bundle_id !== undefined && file.bundle_id !== null
          ? checkedLineText(file.bundle_id, "preStagedFiles[].bundle_id", 128)
          : undefined;
        const bundleLabel = file.bundle_label !== undefined && file.bundle_label !== null
          ? checkedLineText(file.bundle_label, "preStagedFiles[].bundle_label", 512)
          : undefined;

        batchBytes += bytes;
        if (boardFilesDir) {
          const normPath = normalizePathForCompare(localPath);
          if (!seenDiskPaths.has(normPath)) {
            seenDiskPaths.add(normPath);
            try {
              const stat = lstatSync(localPath);
              if (!stat.isSymbolicLink() && stat.isFile()) {
                stagedOnDiskBytes += stat.size;
              }
            } catch {
              // 兼容纯内存 mock store 未写磁盘的情况
            }
          }
        }

        validatedFiles.push({
          file_id: fileId,
          safe_name: safeName,
          bytes,
          sha256,
          rel_path: relPath,
          local_path: localPath,
          ...(bundleId !== undefined ? { bundle_id: bundleId } : {}),
          ...(bundleLabel !== undefined ? { bundle_label: bundleLabel } : {}),
        });
      }

      if (validatedFiles.length > 0) {
        const currentBoardBytes = typeof this.#store.getBoardFilesTotalBytes === "function"
          ? this.#store.getBoardFilesTotalBytes(existing.board_id)
          : 0;
        const currentGlobalBytes = typeof this.#store.getGlobalFilesTotalBytes === "function"
          ? this.#store.getGlobalFilesTotalBytes()
          : 0;
        const actualBoardDirBytes = boardFilesDir ? sumDirectoryBytes(boardFilesDir) : 0;
        const storeIncludesStagedOnDisk = stagedOnDiskBytes > 0 && currentBoardBytes === actualBoardDirBytes;

        const projectedBoardBytes = storeIncludesStagedOnDisk
          ? Math.max(currentBoardBytes, currentBoardBytes - stagedOnDiskBytes + batchBytes)
          : currentBoardBytes + batchBytes;
        const projectedGlobalBytes = storeIncludesStagedOnDisk && currentGlobalBytes >= currentBoardBytes
          ? Math.max(currentGlobalBytes, currentGlobalBytes - stagedOnDiskBytes + batchBytes)
          : currentGlobalBytes + batchBytes;

        if (projectedBoardBytes > this.#limits.maxBoardFilesBytes
          || projectedGlobalBytes > this.#limits.maxTotalFilesBytes) {
          throw new CoreError("board_quota_exceeded", "交流板文件总容量超过上限");
        }
      }

      const boardMembers = (this.#store.listMembers(existing.board_id, { activeOnly: false }) ?? []).map(hydrateMember);
      const mentions = this.#resolveMemberKeysList(actor, params?.mentions, "mentions", boardMembers);
      const clientPostId = params?.client_post_id !== undefined && params?.client_post_id !== null
        ? checkedLineText(params.client_post_id, "client_post_id", 256)
        : params?.origin_client_post_id !== undefined && params?.origin_client_post_id !== null
          ? checkedLineText(params.origin_client_post_id, "origin_client_post_id", 256)
          : randomUUID();

      // 评估 fileSyncTargets 时排除发件客机 actor.machine_id，避免附件回弹给原发件机
      const { target_sync_machines: targetSyncMachines, unreachable_machines: unreachableMachines } =
        this.#evaluateFileSyncTargets(existing, params?.sync_machines, validatedFiles.length > 0, {
          excludeMachineIds: [actor.machine_id],
        });
      const nowIso = this.#nowIso();

      const stagedPathsByFileId = new Map();
      const postFilesMeta = validatedFiles.map(file => {
        stagedPathsByFileId.set(file.file_id, file.local_path);
        return {
          file_id: file.file_id,
          safe_name: file.safe_name,
          bytes: file.bytes,
          sha256: file.sha256,
          rel_path: file.rel_path,
          local_status: "ready",
          sync_machines: [...targetSyncMachines],
          ...(file.bundle_id !== undefined ? { bundle_id: file.bundle_id } : {}),
          ...(file.bundle_label !== undefined ? { bundle_label: file.bundle_label } : {}),
          uploaded_at: nowIso,
        };
      });

      const appendResult = this.#store.appendPost({
        boardId: existing.board_id,
        author: actor,
        body,
        mentions,
        files: postFilesMeta,
        originClientPostId: clientPostId,
        stagedFileOps: [],
        fileSyncTargets: targetSyncMachines,
        nowIso,
      });
      postCommitted = true;

      const post = hydratePost(appendResult.post);
      const deduplicated = appendResult.deduplicated === true;

      return await this.#finalizeHostPost({
        existing,
        post,
        deduplicated,
        targetSyncMachines,
        unreachableMachines,
        stagedPathsByFileId,
        nowIso,
        signal,
      });
    } catch (error) {
      if (!postCommitted && Array.isArray(preStagedFiles) && preStagedFiles.length > 0) {
        this.#cleanupPreStagedRemoteFiles(cleanupBoardId, preStagedFiles);
      }
      throw error;
    }
  }

  async postMessage(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机发帖");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
    if (existing.status !== "active") {
      throw new CoreError("board_archived", "交流板已归档，无法继续发帖");
    }

    const body = params?.body === undefined || params?.body === null ? "" : params.body;
    if (typeof body !== "string") {
      throw new CoreError("invalid_input", "body 必须是字符串");
    }
    if (Buffer.byteLength(body, "utf8") > this.#limits.maxBodyBytes) {
      throw new CoreError("invalid_input", "帖子正文超过大小上限");
    }

    const rawFiles = params?.files === undefined || params?.files === null ? [] : params.files;
    if (!Array.isArray(rawFiles) || rawFiles.length > this.#limits.maxFilesPerPost) {
      throw new CoreError("invalid_input", `单帖附件数量不能超过 ${this.#limits.maxFilesPerPost} 个`);
    }
    if (!body.trim() && rawFiles.length === 0) {
      throw new CoreError("invalid_input", "帖子正文与附件不能同时为空");
    }

    const normalizedFileRequests = rawFiles.map(file => {
      assertPlainObject(file, "发帖附件");
      assertExactKeys(file, POST_FILE_KEYS, "发帖附件");
      const sourcePath = requireText(file.path, "files[].path", 4096);
      const originalName = file.name !== undefined
        ? requireText(file.name, "files[].name", 480)
        : path.basename(sourcePath);
      const bundleId = file.bundle_id !== undefined
        ? checkedLineText(file.bundle_id, "files[].bundle_id", 128)
        : undefined;
      const bundleLabel = file.bundle_label !== undefined
        ? checkedLineText(file.bundle_label, "files[].bundle_label", 512)
        : undefined;
      return {
        sourcePath,
        originalName,
        ...(bundleId !== undefined ? { bundle_id: bundleId } : {}),
        ...(bundleLabel !== undefined ? { bundle_label: bundleLabel } : {}),
      };
    });

    const boardMembers = (this.#store.listMembers(existing.board_id, { activeOnly: false }) ?? []).map(hydrateMember);
    const mentions = this.#resolveMemberKeysList(actor, params?.mentions, "mentions", boardMembers);
    const clientPostId = params?.client_post_id !== undefined && params?.client_post_id !== null
      ? checkedLineText(params.client_post_id, "client_post_id", 256)
      : params?.origin_client_post_id !== undefined && params?.origin_client_post_id !== null
        ? checkedLineText(params.origin_client_post_id, "origin_client_post_id", 256)
        : randomUUID();

    const { target_sync_machines: targetSyncMachines, unreachable_machines: unreachableMachines } =
      this.#evaluateFileSyncTargets(existing, params?.sync_machines, normalizedFileRequests.length > 0);
    const nowIso = this.#nowIso();

    // 客机离线发帖路径：附件进 .outbox/，操作进 board_remote_outbox；中途失败立即回滚清理 .outbox/<local_post_id>/
    if (existing.host_machine_id !== this.#localMachineId) {
      const safeLocalPostId = SAFE_ID_PATTERN.test(clientPostId)
        ? clientPostId
        : `lp-${digest({ board_id: existing.board_id, author_key: actorKey, client_post_id: clientPostId }).slice(0, 24)}`;
      const stagedOutboxFiles = [];
      let outboxTotalBytes = 0;
      let outboxEnqueued = false;
      try {
        for (let index = 0; index < normalizedFileRequests.length; index += 1) {
          const fileReq = normalizedFileRequests[index];
          const fileId = `f-${digest({ board_id: existing.board_id, author_key: actorKey, client_post_id: clientPostId, index }).slice(0, 20)}`;
          const staged = this.#store.stageOutboxAttachment({
            sourcePath: fileReq.sourcePath,
            originalName: fileReq.originalName,
            localPostId: safeLocalPostId,
            fileId,
          });
          stagedOutboxFiles.push({
            file_id: staged.file_id ?? fileId,
            safe_name: staged.safe_name,
            bytes: staged.bytes,
            sha256: staged.sha256,
            outbox_path: staged.outbox_path,
            rel_path: staged.rel_path,
            ...(fileReq.bundle_id !== undefined ? { bundle_id: fileReq.bundle_id } : {}),
            ...(fileReq.bundle_label !== undefined ? { bundle_label: fileReq.bundle_label } : {}),
          });
          outboxTotalBytes += Number.isSafeInteger(staged.bytes) ? staged.bytes : 0;
          if (outboxTotalBytes > this.#limits.maxRemotePostBundleBytes) {
            throw new CoreError(
              "relay_bundle_too_large",
              `跨机单帖附件总大小超过单包上限 ${this.#limits.maxRemotePostBundleBytes} 字节，请拆分为多条帖子发送`,
            );
          }
        }

        const dedupeKey = `client_post:${existing.board_id}:${actorKey}:${clientPostId}`;
        this.#store.enqueueRemoteOutbox({
          local_post_id: safeLocalPostId,
          dedupe_key: dedupeKey,
          board_id: existing.board_id,
          host_machine_id: existing.host_machine_id,
          author_key: actorKey,
          op_kind: "client_post_submit",
          payload_json: JSON.stringify({
            board_id: existing.board_id,
            author: actor,
            body,
            mentions,
            client_post_id: clientPostId,
            files: stagedOutboxFiles,
            sync_machines: params?.sync_machines ?? null,
            target_sync_machines: targetSyncMachines,
          }),
          nowIso,
        });
        outboxEnqueued = true;
      } catch (error) {
        if (!outboxEnqueued && stagedOutboxFiles.length > 0 && error?.code !== "dedupe_conflict") {
          this.#cleanupFailedOutboxFiles(safeLocalPostId, stagedOutboxFiles);
        }
        throw error;
      }

      this.#emitBoardChanged({
        kind: "outbox_enqueued",
        board_id: existing.board_id,
        host_machine_id: existing.host_machine_id,
        op_kind: "client_post_submit",
        local_post_id: safeLocalPostId,
      });

      return {
        board_id: existing.board_id,
        seq: null,
        local_post_id: safeLocalPostId,
        pending_host_ack: true,
        uploaded_files: stagedOutboxFiles.map(file => ({
          file_id: file.file_id,
          safe_name: file.safe_name,
          bytes: file.bytes,
          sha256: file.sha256,
          local_path: file.outbox_path,
          ...(file.bundle_id !== undefined ? { bundle_id: file.bundle_id } : {}),
          ...(file.bundle_label !== undefined ? { bundle_label: file.bundle_label } : {}),
        })),
        target_sync_machines: targetSyncMachines,
        unreachable_machines: unreachableMachines,
      };
    }

    // 建板机权威发帖路径：先落 .staging/，再同步事务提交，事务外原子 rename；中途失败立即清理本批 .staging/*.tmp
    const currentBoardBytes = typeof this.#store.getBoardFilesTotalBytes === "function"
      ? this.#store.getBoardFilesTotalBytes(existing.board_id)
      : 0;
    const currentGlobalBytes = typeof this.#store.getGlobalFilesTotalBytes === "function"
      ? this.#store.getGlobalFilesTotalBytes()
      : 0;

    let batchBytes = 0;
    const createdStagingNames = [];
    const stagedFileOps = [];
    const postFilesMeta = [];
    const stagedPathsByFileId = new Map();
    let appendResult;
    let postCommitted = false;

    try {
      for (let index = 0; index < normalizedFileRequests.length; index += 1) {
        const fileReq = normalizedFileRequests[index];
        const fileId = `f-${digest({ board_id: existing.board_id, author_key: actorKey, client_post_id: clientPostId, index }).slice(0, 20)}`;
        const opId = randomUUID();
        const staged = this.#store.stageLocalUploadFile({
          sourcePath: fileReq.sourcePath,
          originalName: fileReq.originalName,
          fileId,
          opId,
          boardId: existing.board_id,
        });
        if (staged?.staging_name) {
          createdStagingNames.push(staged.staging_name);
        }
        batchBytes += staged.bytes;
        if (currentBoardBytes + batchBytes > this.#limits.maxBoardFilesBytes
          || currentGlobalBytes + batchBytes > this.#limits.maxTotalFilesBytes) {
          throw new CoreError("board_quota_exceeded", "交流板文件总容量超过上限");
        }
        const resolvedFileId = staged.file_id ?? fileId;
        stagedPathsByFileId.set(resolvedFileId, staged.local_path);
        stagedFileOps.push({
          op_id: staged.op_id ?? opId,
          staging_name: staged.staging_name,
          file_id: resolvedFileId,
          safe_name: staged.safe_name,
          expected_sha256: staged.sha256,
          expected_bytes: staged.bytes,
        });
        postFilesMeta.push({
          file_id: resolvedFileId,
          safe_name: staged.safe_name,
          bytes: staged.bytes,
          sha256: staged.sha256,
          rel_path: staged.rel_path,
          local_status: "ready",
          sync_machines: [...targetSyncMachines],
          ...(fileReq.bundle_id !== undefined ? { bundle_id: fileReq.bundle_id } : {}),
          ...(fileReq.bundle_label !== undefined ? { bundle_label: fileReq.bundle_label } : {}),
          uploaded_at: nowIso,
        });
      }

      appendResult = this.#store.appendPost({
        boardId: existing.board_id,
        author: actor,
        body,
        mentions,
        files: postFilesMeta,
        originClientPostId: clientPostId,
        stagedFileOps,
        fileSyncTargets: targetSyncMachines,
        nowIso,
      });
      postCommitted = true;
    } catch (error) {
      if (!postCommitted && createdStagingNames.length > 0) {
        this.#cleanupStagedTempFiles(createdStagingNames);
      }
      throw error;
    }

    const post = hydratePost(appendResult.post);
    const deduplicated = appendResult.deduplicated === true;
    const fileOpIds = Array.isArray(appendResult.file_op_ids) ? appendResult.file_op_ids : [];

    if (deduplicated) {
      if (createdStagingNames.length > 0) {
        this.#cleanupStagedTempFiles(createdStagingNames);
      }
    } else if (fileOpIds.length > 0 && typeof this.#store.commitStagedFileOps === "function") {
      this.#store.commitStagedFileOps(fileOpIds);
    }

    return await this.#finalizeHostPost({
      existing,
      post,
      deduplicated,
      targetSyncMachines,
      unreachableMachines,
      stagedPathsByFileId,
      nowIso,
      signal,
    });
  }

  async readBoard(actorIdentity, params = {}, { board: boardInput = null, signal } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const board = this.#loadBoardForRef(ref);
    if (!board) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    const member = this.#assertActiveMemberOrAdmin(board.board_id, actorKey, isAdmin);

    const seq = params?.seq === undefined || params?.seq === null
      ? null
      : requireInteger(params.seq, "seq", 1);
    const afterSeq = params?.after_seq === undefined || params?.after_seq === null
      ? 0
      : requireInteger(params.after_seq, "after_seq", 0);
    const limit = params?.limit === undefined || params?.limit === null
      ? this.#limits.defaultReadLimit
      : requireInteger(params.limit, "limit", 1, this.#limits.maxReadLimit);
    const maxTotalChars = params?.max_total_chars === undefined || params?.max_total_chars === null
      ? this.#limits.defaultReadMaxTotalChars
      : requireInteger(params.max_total_chars, "max_total_chars", 1, this.#limits.maxReadMaxTotalChars);

    let authorKeys = null;
    if (params?.author_keys !== undefined && params?.author_keys !== null) {
      const boardMembers = (this.#store.listMembers(board.board_id, { activeOnly: false }) ?? []).map(hydrateMember);
      authorKeys = this.#resolveMemberKeysList(actor, params.author_keys, "author_keys", boardMembers);
    }

    const rawPosts = (this.#store.readPosts({
      boardId: board.board_id,
      afterSeq,
      seq,
      authorKeys,
      limit: seq !== null ? 1 : limit + 1,
    }) ?? []).map(hydratePost);

    const hasExtraInStore = seq === null && rawPosts.length > limit;
    const candidatePosts = seq === null ? rawPosts.slice(0, limit) : rawPosts;

    const renderedPosts = [];
    let usedChars = 0;
    let truncatedByBudget = false;
    const archived = board.status === "archived";
    const isCrossMachine = board.host_machine_id !== this.#localMachineId;
    const syncState = isCrossMachine ? this.#store.getSyncState?.(board.board_id, board.host_machine_id) : null;
    const lastSyncedAt = syncState?.last_synced_at ?? board.last_synced_at ?? null;
    const enforceResponseByteBudget = params?.max_total_chars === undefined
      || params?.max_total_chars === null
      || maxTotalChars <= this.#limits.defaultReadMaxTotalChars;
    const maxResponseBytes = this.#limits.defaultReadMaxResponseBytes;

    const buildResponse = (postsList, hasMoreFlag) => ({
      board_id: board.board_id,
      host_machine_id: board.host_machine_id,
      title: board.title,
      status: board.status,
      board_seq: board.board_seq,
      state_version: board.state_version,
      meta_version: board.meta_version,
      archive_version: board.archive_version,
      posts: postsList,
      next_after_seq: postsList.length > 0 ? postsList[postsList.length - 1].seq : afterSeq,
      has_more: hasMoreFlag,
      ...(archived ? { board_archived: true } : {}),
      ...(isCrossMachine ? { stale_cache: true, last_synced_at: lastSyncedAt } : {}),
    });

    const responseBytesOf = postsList => Buffer.byteLength(JSON.stringify(buildResponse(postsList, false)), "utf8");

    for (const post of candidatePosts) {
      const bodyChars = [...post.body].length;
      if (renderedPosts.length > 0 && usedChars + bodyChars > maxTotalChars) {
        truncatedByBudget = true;
        break;
      }

      const remaining = Math.max(1, maxTotalChars - usedChars);
      const { text: renderedBody, truncated: charTruncated, totalChars } = truncateUnicode(post.body, remaining);

      const files = post.files.map(file => {
        const isReady = file.local_status === "ready";
        const localPath = isReady
          ? (file.local_path ?? this.#store.resolveSafeBoardFilePath?.(board.board_id, file.file_id, file.safe_name, { archived }))
          : undefined;
        return {
          file_id: file.file_id,
          safe_name: file.safe_name,
          bytes: file.bytes,
          sha256: file.sha256,
          local_status: file.local_status,
          ...(isReady && localPath ? { local_path: localPath } : {}),
          ...(file.bundle_id !== undefined ? { bundle_id: file.bundle_id } : {}),
          ...(file.bundle_label !== undefined ? { bundle_label: file.bundle_label } : {}),
        };
      });

      let candidateItem = {
        seq: post.seq,
        author_key: post.author_key,
        author_display: this.#resolvePeerDisplayName(actor, post.author),
        body: renderedBody,
        ...(charTruncated ? { truncated: true, full_body_chars: totalChars } : { truncated: false }),
        mentions: post.mentions,
        files,
        created_at: post.created_at,
      };
      let itemTruncated = charTruncated;

      if (enforceResponseByteBudget && responseBytesOf([...renderedPosts, candidateItem]) > maxResponseBytes) {
        if (renderedPosts.length > 0) {
          truncatedByBudget = true;
          break;
        }
        // 首帖自身序列化即超过 8900 B 预算：按 Unicode 码点二分截断正文
        const chars = [...candidateItem.body];
        let lo = 0;
        let hi = chars.length;
        let best = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const trial = {
            ...candidateItem,
            body: chars.slice(0, mid).join(""),
            truncated: true,
            full_body_chars: totalChars,
          };
          if (responseBytesOf([trial]) <= maxResponseBytes) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        if (best >= 0) {
          candidateItem = {
            ...candidateItem,
            body: chars.slice(0, best).join(""),
            truncated: true,
            full_body_chars: totalChars,
          };
        } else {
          // 极端情形：即使正文清空仍被超大 files/mentions 撑爆，逐步裁剪至字节预算内
          let slimFiles = [...candidateItem.files];
          let slimMentions = [...candidateItem.mentions];
          candidateItem = {
            ...candidateItem,
            body: "",
            truncated: true,
            full_body_chars: totalChars,
          };
          while (slimFiles.length > 0 && responseBytesOf([{ ...candidateItem, files: slimFiles, files_truncated: true }]) > maxResponseBytes) {
            slimFiles.pop();
          }
          if (slimFiles.length < candidateItem.files.length) {
            candidateItem = { ...candidateItem, files: slimFiles, files_truncated: true };
          }
          while (slimMentions.length > 0 && responseBytesOf([{ ...candidateItem, mentions: slimMentions, mentions_truncated: true }]) > maxResponseBytes) {
            slimMentions.pop();
          }
          if (slimMentions.length < candidateItem.mentions.length) {
            candidateItem = { ...candidateItem, mentions: slimMentions, mentions_truncated: true };
          }
        }
        itemTruncated = true;
      }

      usedChars += [...candidateItem.body].length;
      renderedPosts.push(candidateItem);

      if (itemTruncated && seq === null) {
        if (candidatePosts.length > renderedPosts.length) {
          truncatedByBudget = true;
        }
        break;
      }
    }

    if (member && seq === null && authorKeys === null && renderedPosts.length > 0) {
      const maxReturnedSeq = renderedPosts[renderedPosts.length - 1].seq;
      if (afterSeq <= member.last_read_seq && maxReturnedSeq > member.last_read_seq) {
        this.#store.updateMemberReadCursor?.(board.board_id, actorKey, maxReturnedSeq);
      }
    }

    return buildResponse(renderedPosts, hasExtraInStore || truncatedByBudget);
  }

  async setSubscription(actorIdentity, params = {}, { board: boardInput = null, signal } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const board = this.#loadBoardForRef(ref);
    if (!board) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    const member = this.#assertActiveMemberOrAdmin(board.board_id, actorKey, isAdmin);
    if (board.status !== "active") {
      throw new CoreError("board_archived", "交流板已归档，无法修改订阅偏好");
    }
    if (!member) {
      throw new CoreError("forbidden", "请先订阅该交流板再调整个人偏好");
    }

    let nextDeliveryMode = member.delivery_mode ?? "poll";
    if (params?.delivery_mode !== undefined && params?.delivery_mode !== null) {
      if (typeof params.delivery_mode !== "string" || !DELIVERY_MODES.has(params.delivery_mode)) {
        throw new CoreError("invalid_input", "delivery_mode 只支持 poll 或 event");
      }
      nextDeliveryMode = params.delivery_mode;
    }

    // 跨机成员不支持本机即时 event 推送，强制落库 poll 且返回 poll_cross_machine
    const isCrossMachineMember = actor.machine_id !== board.host_machine_id;
    const storedDeliveryMode = isCrossMachineMember ? "poll" : nextDeliveryMode;

    let nextFilterMode = member.filter_mode ?? "all";
    if (params?.filter_mode !== undefined && params?.filter_mode !== null) {
      if (typeof params.filter_mode !== "string" || !FILTER_MODES.has(params.filter_mode)) {
        throw new CoreError("invalid_input", "filter_mode 只支持 all、mute 或 only");
      }
      nextFilterMode = params.filter_mode;
    }

    let nextFilterTargets = member.filter_targets ?? [];
    if (params?.filter_targets !== undefined) {
      const boardMembers = (this.#store.listMembers(board.board_id, { activeOnly: false }) ?? []).map(hydrateMember);
      nextFilterTargets = this.#resolveMemberKeysList(actor, params.filter_targets, "filter_targets", boardMembers);
    }

    const updated = hydrateMember(this.#store.updateMemberPreferences(board.board_id, actorKey, {
      delivery_mode: storedDeliveryMode,
      filter_mode: nextFilterMode,
      filter_targets: nextFilterTargets,
    }));

    return {
      board_id: board.board_id,
      host_machine_id: board.host_machine_id,
      member_key: actorKey,
      subscription_state: updated.subscription_state,
      delivery_mode: updated.delivery_mode,
      effective_delivery_mode: effectiveDeliveryMode(updated, board.host_machine_id),
      filter_mode: updated.filter_mode,
      filter_targets: updated.filter_targets,
    };
  }

  async queryMembers(actorIdentity, params = {}, { board: boardInput = null, signal } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const board = this.#loadBoardForRef(ref);
    if (!board) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    this.#assertActiveMemberOrAdmin(board.board_id, actorKey, isAdmin);
    const allMembers = (this.#store.listMembers(board.board_id, { activeOnly: false }) ?? []).map(hydrateMember);

    let selected = allMembers;
    if (params?.members !== undefined && params?.members !== null) {
      const filterKeys = new Set(this.#resolveMemberKeysList(actor, params.members, "members", allMembers));
      selected = allMembers.filter(member => filterKeys.has(member.member_key));
    }

    return {
      board_id: board.board_id,
      host_machine_id: board.host_machine_id,
      status: board.status,
      meta_version: board.meta_version,
      members: selected.map(member => {
        const identity = normalizeConcreteIdentity(member);
        return {
          member_key: member.member_key,
          identity,
          display_name: this.#resolvePeerDisplayName(actor, identity),
          subscription_state: member.subscription_state,
          delivery_mode: member.delivery_mode,
          effective_delivery_mode: effectiveDeliveryMode(member, board.host_machine_id),
          filter_mode: member.filter_mode,
          filter_targets: member.filter_targets,
          last_read_seq: member.last_read_seq,
          last_notified_seq: member.last_notified_seq,
          joined_at: member.joined_at,
        };
      }),
      ...(board.status === "archived" ? { board_archived: true } : {}),
    };
  }

  async updateSettings(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机修改设置");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
    if (existing.status !== "active") {
      throw new CoreError("board_archived", "交流板已归档，无法修改设置");
    }

    assertPlainObject(params?.settings, "settings");
    if (Object.keys(params.settings).length === 0) {
      throw new CoreError("invalid_input", "settings 至少需要提供一项设置字段");
    }
    const nextSettings = normalizeEngineSettings(params.settings, existing.settings, this.#limits);

    if (existing.host_machine_id !== this.#localMachineId) {
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "update_settings",
        payload: { settings: params.settings },
      });
    }

    const updated = hydrateBoard(this.#store.updateBoardSettings(existing.board_id, nextSettings, {
      nowIso: this.#nowIso(),
    }));

    this.#emitBoardChanged({
      kind: "settings_updated",
      board_id: updated.board_id,
      meta_version: updated.meta_version,
    });

    return {
      board_id: updated.board_id,
      host_machine_id: updated.host_machine_id,
      settings: updated.settings,
      meta_version: updated.meta_version,
    };
  }

  async dissolveBoard(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机解散交流板");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
    if (existing.status !== "active") {
      throw new CoreError("board_archived", "交流板已经处于归档状态");
    }

    if (existing.host_machine_id !== this.#localMachineId) {
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "dissolve",
        payload: {},
      });
    }

    const nowMs = this.#nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const activeLocalMembers = (this.#store.listMembers(existing.board_id, { activeOnly: true }) ?? [])
      .map(hydrateMember)
      .filter(member => member.machine_id === this.#localMachineId);

    const { board: rawArchived } = this.#store.archiveBoard({
      boardId: existing.board_id,
      reason: "manual_dissolve",
      actorKey,
      nowIso,
      enqueueNotifications: false,
    });
    const archived = hydrateBoard(rawArchived);

    if (typeof this.#store.reconcilePendingFileOps === "function") {
      this.#store.reconcilePendingFileOps();
    }

    // 仅针对本机活跃成员构造并投递统一格式的 dissolved 通知，绝不给跨机成员入队或扫全表 256 条
    const toDeliver = [];
    for (const member of activeLocalMembers) {
      const memberIdentity = normalizeConcreteIdentity(member);
      const record = {
        dedupe_key: `dissolved:${archived.board_id}:${archived.archive_version}:${member.member_key}`,
        board_id: archived.board_id,
        member_key: member.member_key,
        member_json: JSON.stringify(memberIdentity),
        kind: "dissolved",
        state_version: archived.state_version,
        payload_json: JSON.stringify({
          board_id: archived.board_id,
          host_machine_id: archived.host_machine_id,
          title: archived.title,
          state_version: archived.state_version,
          archive_version: archived.archive_version,
          archive_reason: "manual_dissolve",
          dissolved_by_key: actorKey,
          dissolved_by_display: this.#resolvePeerDisplayName(memberIdentity, actor),
          archived_at: archived.archived_at,
          restorable: true,
        }),
        retry_count: 0,
      };
      this.#store.enqueueNotification?.({ ...record, nowIso });
      toDeliver.push(record);
    }

    for (const record of toDeliver) {
      await this.#deliverNotificationRecord(record, signal);
    }

    this.#emitBoardChanged({
      kind: "board_dissolved",
      board_id: archived.board_id,
      state_version: archived.state_version,
      meta_version: archived.meta_version,
      archive_version: archived.archive_version,
      dissolved_by_key: actorKey,
    });

    return {
      board_id: archived.board_id,
      host_machine_id: archived.host_machine_id,
      status: archived.status,
      state_version: archived.state_version,
      meta_version: archived.meta_version,
      archive_version: archived.archive_version,
      archive_reason: archived.archive_reason,
      archived_at: archived.archived_at,
    };
  }

  async restoreBoard(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机恢复交流板");
    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw new CoreError("board_not_found", "交流板不存在或已永久删除");
    }
    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      throw new CoreError("board_not_found", "没有找到指定的交流板");
    }

    // 仅归档前原板活跃成员或超管可恢复，严禁非成员或已退订前成员复活私密板
    this.#assertActiveMemberOrAdmin(existing.board_id, actorKey, isAdmin);
    if (existing.status !== "archived") {
      throw new CoreError("invalid_state", "交流板当前不是归档状态，无需恢复");
    }

    if (existing.host_machine_id !== this.#localMachineId) {
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "restore",
        payload: {},
      });
    }

    const { board: rawRestored } = this.#store.restoreBoard({
      boardId: existing.board_id,
      actorKey,
      nowIso: this.#nowIso(),
    });
    const restored = hydrateBoard(rawRestored);

    if (typeof this.#store.reconcilePendingFileOps === "function") {
      this.#store.reconcilePendingFileOps();
    }

    this.#emitBoardChanged({
      kind: "board_restored",
      board_id: restored.board_id,
      state_version: restored.state_version,
      meta_version: restored.meta_version,
      archive_version: restored.archive_version,
    });

    return {
      board_id: restored.board_id,
      host_machine_id: restored.host_machine_id,
      status: restored.status,
      state_version: restored.state_version,
      meta_version: restored.meta_version,
      archive_version: restored.archive_version,
      last_active_at: restored.last_active_at,
    };
  }

  async deleteArchivedBoard(actorIdentity, params = {}, { board: boardInput = null, signal, remotePrincipal = null } = {}) {
    this.#assertOpen(signal);
    const actor = normalizeConcreteIdentity(actorIdentity);
    this.#assertVerifiedRemotePrincipal(actor, remotePrincipal, "跨机删除归档板");

    const ref = this.#resolveBoardRef(actor, boardInput, params);
    const expectedArchiveVersion = requireInteger(params?.expected_archive_version, "expected_archive_version", 1);
    const expectedStateVersion = params?.expected_state_version === undefined || params?.expected_state_version === null
      ? null
      : requireInteger(params.expected_state_version, "expected_state_version", 0);

    const sanitizedNotFound = () => new CoreError("board_not_found", "未找到符合该归档版本的可删除交流板");

    // 跨机身份未携带已验证 remotePrincipal 时一律脱敏拒绝，绝不暴露板存在性或版本
    if (actor.machine_id !== this.#localMachineId && (remotePrincipal === null || remotePrincipal === undefined)) {
      throw sanitizedNotFound();
    }

    const actorKey = identityKey(actor);
    const isAdmin = this.isSuperAdmin(actor);

    if (this.#store.getTombstone?.(ref.board_id)) {
      throw sanitizedNotFound();
    }

    const existing = this.#loadBoardForRef(ref);
    if (!existing) {
      if (ref.machine_id !== this.#localMachineId && actor.machine_id === this.#localMachineId) {
        return this.#enqueueClientControlRequest({
          boardId: ref.board_id,
          hostMachineId: ref.machine_id,
          actor,
          action: "delete_archived",
          payload: {
            expected_archive_version: expectedArchiveVersion,
            ...(expectedStateVersion !== null ? { expected_state_version: expectedStateVersion } : {}),
          },
        });
      }
      throw sanitizedNotFound();
    }

    if (existing.host_machine_id !== this.#localMachineId) {
      if (actor.machine_id !== this.#localMachineId) {
        throw sanitizedNotFound();
      }
      return this.#enqueueClientControlRequest({
        boardId: existing.board_id,
        hostMachineId: existing.host_machine_id,
        actor,
        action: "delete_archived",
        payload: {
          expected_archive_version: expectedArchiveVersion,
          ...(expectedStateVersion !== null ? { expected_state_version: expectedStateVersion } : {}),
        },
      });
    }

    const member = hydrateMember(this.#store.getMember(existing.board_id, actorKey));
    const isPrivileged = isAdmin || (member !== null && member.subscription_state === "active");

    const statusMatches = existing.status === "archived";
    const archiveVersionMatches = existing.archive_version === expectedArchiveVersion;
    const stateVersionMatches = expectedStateVersion === null || existing.state_version === expectedStateVersion;

    if (!statusMatches || !archiveVersionMatches || !stateVersionMatches) {
      // 非成员失败时绝不泄露板标题、成员、状态或真实版本号
      if (!isPrivileged) {
        throw sanitizedNotFound();
      }
      if (!statusMatches) {
        throw new CoreError("invalid_state", "只能永久删除已归档的交流板");
      }
      throw new CoreError("invalid_state", "归档版本或状态版本不匹配");
    }

    const allMembers = this.#store.listMembers(existing.board_id, { activeOnly: false }) ?? [];
    const peerMachines = [...new Set(
      allMembers
        .map(item => item.machine_id)
        .filter(machineId => typeof machineId === "string" && machineId !== this.#localMachineId),
    )];

    let result;
    try {
      result = this.#store.deleteArchivedBoard({
        boardId: existing.board_id,
        expectedArchiveVersion,
        expectedStateVersion,
        actorKey,
        peerMachines,
        nowIso: this.#nowIso(),
      });
    } catch (error) {
      if (!isPrivileged && error instanceof CoreError && (
        error.code === "board_not_found"
        || error.code === "board_deleted_tombstone"
        || error.code === "board_not_archived"
        || error.code === "board_version_mismatch"
        || error.code === "invalid_state"
      )) {
        throw sanitizedNotFound();
      }
      throw error;
    }

    for (const key of this.#pendingDigestByBoardMember.keys()) {
      if (key.startsWith(`${existing.board_id}\0`)) {
        this.#pendingDigestByBoardMember.delete(key);
      }
    }

    if (typeof this.#store.reconcilePendingFileOps === "function") {
      this.#store.reconcilePendingFileOps();
    }

    // 永久删除成功绝不发送任何成员通知
    this.#emitBoardChanged({
      kind: "board_deleted",
      board_id: existing.board_id,
      final_state_version: result.tombstone.final_state_version,
    });

    return {
      board_id: existing.board_id,
      deleted: true,
      final_state_version: result.tombstone.final_state_version,
      deleted_at: result.tombstone.deleted_at,
      cancelled_notifications: result.cancelled_notifications ?? 0,
    };
  }

  async localNotifyTick({ signal } = {}) {
    if (this.#closed || signal?.aborted) {
      return { digests_enqueued: 0, delivered: 0, failed: 0, skipped: 0 };
    }

    const nowMs = this.#nowMs();
    const nowIso = new Date(nowMs).toISOString();
    let digestsEnqueued = 0;

    // 阶段 1：扫描所有活跃板，为本机 poll 成员（及跨机板上的本机成员）聚合新帖摘要
    let offset = 0;
    while (offset !== null && offset !== undefined) {
      if (this.#closed || signal?.aborted) break;
      const page = this.#store.listBoardsForActor({
        actorKey: null,
        isSuperAdmin: true,
        status: "active",
        limit: this.#limits.maxListLimit,
        offset,
      });
      const items = page?.items ?? [];

      for (const rawBoard of items) {
        const board = hydrateBoard(rawBoard);
        if (board.status !== "active") continue;
        const boardSeq = Number.isSafeInteger(board.board_seq) ? board.board_seq : 0;
        if (boardSeq <= 0) continue;

        const members = (this.#store.listMembers(board.board_id, { activeOnly: true }) ?? []).map(hydrateMember);
        const pollMembers = members.filter(member =>
          member.machine_id === this.#localMachineId
          && (member.delivery_mode === "poll" || board.host_machine_id !== this.#localMachineId)
          && member.last_notified_seq < boardSeq);

        for (const member of pollMembers) {
          const memberIdentity = normalizeConcreteIdentity(member);
          const trackingKey = `${board.board_id}\0${member.member_key}`;
          const trackedPending = this.#pendingDigestByBoardMember.get(trackingKey);
          let cursor = Math.max(member.last_notified_seq, trackedPending?.max_scanned_seq ?? 0);
          if (cursor >= boardSeq) continue;

          const scannedPosts = [];
          while (cursor < boardSeq) {
            const batch = (this.#store.readPosts({
              boardId: board.board_id,
              afterSeq: cursor,
              seq: null,
              authorKeys: null,
              limit: 200,
            }) ?? []).map(hydratePost);
            if (batch.length === 0) break;
            scannedPosts.push(...batch);
            const nextCursor = batch[batch.length - 1].seq;
            if (nextCursor <= cursor) break;
            cursor = nextCursor;
          }
          if (scannedPosts.length === 0) continue;

          const maxScannedSeq = scannedPosts[scannedPosts.length - 1].seq;
          const matched = [];
          for (const post of scannedPosts) {
            const decision = shouldNotifyMemberForPost(member, post);
            if (decision.notify) {
              matched.push({ post, decision });
            }
          }

          if (matched.length === 0) {
            // 无命中帖子：0 提醒；若前面无未决 pending 摘要则推进扫描水位避免重复空扫
            if (!trackedPending) {
              this.#store.updateMemberNotifiedCursor?.(board.board_id, member.member_key, maxScannedSeq);
            }
            continue;
          }

          const fromSeq = matched[0].post.seq;
          const toSeq = matched[matched.length - 1].post.seq;
          const dedupeKey = `poll_digest:${board.board_id}:${member.member_key}:${fromSeq}-${toSeq}`;
          const payload = {
            board_id: board.board_id,
            host_machine_id: board.host_machine_id,
            title: board.title,
            from_seq: fromSeq,
            to_seq: toSeq,
            max_scanned_seq: maxScannedSeq,
            matched_count: matched.length,
            mentioned_count: matched.filter(item => item.decision.reason === "mentioned").length,
            items: matched.slice(0, 10).map(({ post, decision }) => ({
              seq: post.seq,
              author_key: post.author_key,
              author_display: this.#resolvePeerDisplayName(memberIdentity, post.author),
              reason: decision.reason,
              preview: truncateUnicode(post.body, 120).text,
              file_count: post.files.length,
            })),
          };

          const enqueueResult = this.#store.enqueueNotification({
            dedupe_key: dedupeKey,
            board_id: board.board_id,
            member_key: member.member_key,
            member_json: JSON.stringify(memberIdentity),
            kind: "poll_digest",
            state_version: board.state_version,
            payload_json: JSON.stringify(payload),
            nowIso,
          });
          // 仅跟踪未决摘要范围，绝不在投递获得明确接纳凭据前提前推进 last_notified_seq！
          this.#pendingDigestByBoardMember.set(trackingKey, {
            dedupe_key: dedupeKey,
            max_scanned_seq: maxScannedSeq,
          });
          if (enqueueResult?.enqueued !== false) {
            digestsEnqueued += 1;
          }
        }
      }

      offset = page?.next_offset ?? null;
    }

    // 阶段 2：投递并重试全部到期 pending 通知（含 poll_digest / event_post / dissolved）
    let delivered = 0;
    let failed = 0;
    let skipped = 0;
    const due = this.#store.listDueNotifications?.(nowMs, this.#limits.notifyBatchLimit) ?? [];
    for (const record of due) {
      if (this.#closed || signal?.aborted) break;
      const result = await this.#deliverNotificationRecord(record, signal);
      if (result.outcome === "delivered") delivered += 1;
      else if (result.outcome === "failed") failed += 1;
      else skipped += 1;
    }

    return {
      digests_enqueued: digestsEnqueued,
      delivered,
      failed,
      skipped,
    };
  }

  runAutoArchiveSweep() {
    if (this.#closed) {
      return { archived_boards: [], reconciled: null };
    }
    const nowMs = this.#nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const candidates = this.#store.findInactiveBoardsForAutoArchive?.(this.#localMachineId, nowMs) ?? [];
    const archivedBoards = [];

    for (const rawBoard of candidates) {
      const board = hydrateBoard(rawBoard);
      if (!board || board.host_machine_id !== this.#localMachineId || board.status !== "active") {
        continue;
      }
      const { board: rawArchived } = this.#store.archiveBoard({
        boardId: board.board_id,
        reason: "auto_inactive_31d",
        actorKey: "system:auto_archive",
        nowIso,
        enqueueNotifications: false,
      });
      const archived = hydrateBoard(rawArchived);
      archivedBoards.push({
        board_id: archived.board_id,
        state_version: archived.state_version,
        archive_version: archived.archive_version,
        archive_reason: archived.archive_reason,
        archived_at: archived.archived_at,
      });
      this.#emitBoardChanged({
        kind: "board_auto_archived",
        board_id: archived.board_id,
        state_version: archived.state_version,
        archive_version: archived.archive_version,
      });
    }

    const reconciled = typeof this.#store.reconcilePendingFileOps === "function"
      ? this.#store.reconcilePendingFileOps()
      : null;

    return {
      archived_boards: archivedBoards,
      reconciled,
    };
  }

  close() {
    this.#closed = true;
    this.#pendingDigestByBoardMember.clear();
  }
}
