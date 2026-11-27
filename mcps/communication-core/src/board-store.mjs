import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { types } from "node:util";
import {
  assertExactKeys,
  CoreError,
  digest,
  identityKey,
  normalizeIdentity,
  requireInteger,
  requireText,
} from "./contracts.mjs";

export const BOARD_LIMITS = Object.freeze({
  maxBodyBytes: 65536,
  maxTitleChars: 128,
  maxMembersPerBoard: 128,
  maxFilesPerPost: 16,
  maxFileBytes: 15 * 1024 * 1024,
  maxBoardFilesBytes: 256 * 1024 * 1024,
  maxTotalFilesBytes: 2 * 1024 * 1024 * 1024,
  maxOutboxEntries: 2048,
  minPollIntervalSec: 60,
  maxPollIntervalSec: 3600,
  defaultPollIntervalSec: 90,
  minAutoArchiveDays: 1,
  maxAutoArchiveDays: 3650,
  defaultAutoArchiveDays: 31,
  doneFileOpRetentionMs: 7 * 24 * 3600 * 1000,
});

const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STAGING_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.tmp$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_FILENAME_CHARS_RE = /[\\/:*?"<>|]/u;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const BIDI_CHARS_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const TRAILING_SPACE_OR_DOT_RE = /[\s.]$/u;
const WINDOWS_RESERVED_STEM_RE = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/iu;
const MAX_SAFE_FILENAME_UTF8_BYTES = 120;
const COPY_CHUNK_BYTES = 64 * 1024;
const RETRYABLE_FS_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

const BOARD_STATUSES = new Set(["active", "archived"]);
const ARCHIVE_REASONS = new Set(["manual_dissolve", "auto_inactive_31d"]);
const SUBSCRIPTION_STATES = new Set(["active", "unsubscribed"]);
const DELIVERY_MODES = new Set(["poll", "event"]);
const FILTER_MODES = new Set(["all", "only", "mute"]);
const FILE_LOCAL_STATUSES = new Set(["ready", "pending_sync", "not_targeted", "failed"]);
const FILE_SYNC_STATUSES = new Set(["pending", "sending", "acked", "failed", "not_applicable"]);
const OUTBOX_STATUSES = new Set([
  "pending",
  "dispatching",
  "unknown",
  "sent",
  "acked",
  "rejected_archived",
  "rejected_deleted",
  "dead_letter",
]);
const TERMINAL_OUTBOX_STATUSES = new Set([
  "acked",
  "rejected_archived",
  "rejected_deleted",
  "dead_letter",
]);
const NOTIFICATION_KINDS = new Set(["poll_digest", "event_post", "dissolved"]);
const NOTIFICATION_STATUSES = new Set(["pending", "sent", "failed", "cancelled"]);
const SETTINGS_KEYS = ["default_file_sync_machines", "auto_archive_days", "default_poll_interval_sec"];

const BOARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS boards (
  board_id TEXT PRIMARY KEY NOT NULL,
  host_machine_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  meta_version INTEGER NOT NULL DEFAULT 1 CHECK (meta_version >= 1),
  archive_version INTEGER NOT NULL DEFAULT 0 CHECK (archive_version >= 0),
  archive_reason TEXT CHECK (archive_reason IS NULL OR archive_reason IN ('manual_dissolve', 'auto_inactive_31d')),
  archive_format TEXT NOT NULL DEFAULT 'dir' CHECK (archive_format IN ('dir', 'tar_gz')),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  board_seq INTEGER NOT NULL DEFAULT 0 CHECK (board_seq >= 0),
  creator_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived_at TEXT,
  dissolved_by_key TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS board_members (
  board_id TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
  member_key TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host TEXT NOT NULL,
  surface TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  subscription_state TEXT NOT NULL DEFAULT 'active' CHECK (subscription_state IN ('active', 'unsubscribed')),
  delivery_mode TEXT NOT NULL DEFAULT 'poll' CHECK (delivery_mode IN ('poll', 'event')),
  filter_mode TEXT NOT NULL DEFAULT 'all' CHECK (filter_mode IN ('all', 'only', 'mute')),
  filter_targets_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(filter_targets_json)),
  last_read_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
  last_notified_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_notified_seq >= 0),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (board_id, member_key)
) STRICT;

CREATE TABLE IF NOT EXISTS board_posts (
  board_id TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  author_key TEXT NOT NULL,
  author_json TEXT NOT NULL CHECK (json_valid(author_json)),
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(mentions_json)),
  files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_json)),
  created_at TEXT NOT NULL,
  origin_client_post_id TEXT NOT NULL,
  PRIMARY KEY (board_id, seq),
  UNIQUE (board_id, author_key, origin_client_post_id)
) STRICT;

CREATE TABLE IF NOT EXISTS board_sync_state (
  board_id TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
  peer_machine_id TEXT NOT NULL,
  last_acked_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_acked_seq >= 0),
  last_acked_state_version INTEGER NOT NULL DEFAULT 0 CHECK (last_acked_state_version >= 0),
  last_acked_meta_version INTEGER NOT NULL DEFAULT 0 CHECK (last_acked_meta_version >= 0),
  last_notified_dissolve_version INTEGER NOT NULL DEFAULT 0 CHECK (last_notified_dissolve_version >= 0),
  last_synced_at TEXT,
  PRIMARY KEY (board_id, peer_machine_id)
) STRICT;

CREATE TABLE IF NOT EXISTS board_file_sync_queue (
  board_id TEXT NOT NULL REFERENCES boards(board_id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  peer_machine_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'acked', 'failed', 'not_applicable')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at INTEGER NOT NULL DEFAULT 0 CHECK (next_retry_at >= 0),
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (board_id, file_id, peer_machine_id)
) STRICT;

CREATE TABLE IF NOT EXISTS board_remote_outbox (
  local_post_id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  board_id TEXT NOT NULL,
  host_machine_id TEXT NOT NULL,
  author_key TEXT NOT NULL,
  op_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'unknown', 'sent', 'acked', 'rejected_archived', 'rejected_deleted', 'dead_letter')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at INTEGER NOT NULL DEFAULT 0 CHECK (next_retry_at >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS board_tombstones (
  board_id TEXT PRIMARY KEY NOT NULL,
  host_machine_id TEXT NOT NULL,
  final_state_version INTEGER NOT NULL CHECK (final_state_version >= 1),
  deleted_by_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS board_tombstone_sync (
  board_id TEXT NOT NULL,
  peer_machine_id TEXT NOT NULL,
  final_state_version INTEGER NOT NULL CHECK (final_state_version >= 1),
  acked INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0, 1)),
  next_retry_at INTEGER NOT NULL DEFAULT 0 CHECK (next_retry_at >= 0),
  PRIMARY KEY (board_id, peer_machine_id)
) STRICT;

CREATE TABLE IF NOT EXISTS board_file_ops (
  op_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  board_id TEXT NOT NULL,
  op_kind TEXT NOT NULL CHECK (op_kind IN ('stage_file', 'move_to_archive', 'restore_from_archive', 'purge_archived_dir')),
  staging_name TEXT,
  file_id TEXT,
  safe_name TEXT,
  expected_sha256 TEXT,
  expected_bytes INTEGER,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS board_notifications (
  dedupe_key TEXT PRIMARY KEY NOT NULL,
  board_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  member_json TEXT NOT NULL CHECK (json_valid(member_json)),
  kind TEXT NOT NULL CHECK (kind IN ('poll_digest', 'event_post', 'dissolved')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at INTEGER NOT NULL DEFAULT 0 CHECK (next_retry_at >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_boards_status_active ON boards(status, last_active_at);
CREATE INDEX IF NOT EXISTS idx_board_members_member ON board_members(member_key, subscription_state, board_id);
CREATE INDEX IF NOT EXISTS idx_board_members_machine ON board_members(machine_id, subscription_state, board_id);
CREATE INDEX IF NOT EXISTS idx_board_file_sync_due ON board_file_sync_queue(status, peer_machine_id, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_board_outbox_due ON board_remote_outbox(status, host_machine_id, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_board_file_ops_pending ON board_file_ops(board_id, state_version, op_seq) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_board_notifications_due ON board_notifications(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_board_tombstone_sync_due ON board_tombstone_sync(peer_machine_id, next_retry_at, board_id) WHERE acked = 0;
CREATE INDEX IF NOT EXISTS idx_board_remote_outbox_board ON board_remote_outbox(board_id, status);
CREATE INDEX IF NOT EXISTS idx_board_file_ops_status_updated ON board_file_ops(status, updated_at) WHERE status IN ('done', 'superseded');
`;

export function validateBoardId(boardId) {
  if (typeof boardId !== "string" || !BOARD_ID_RE.test(boardId)) {
    throw new CoreError("invalid_input", "board_id必须匹配/^[a-z0-9][a-z0-9_-]{0,127}$/");
  }
  return boardId;
}

function validateSafeId(value, name) {
  if (typeof value !== "string" || !SAFE_ID_RE.test(value)) {
    throw new CoreError("invalid_input", `${name}必须是安全标识符`);
  }
  return value;
}

function validateStagingName(value) {
  if (typeof value !== "string" || !STAGING_NAME_RE.test(value) || value.includes("..")) {
    throw new CoreError("invalid_input", "staging_name格式无效");
  }
  return value;
}

function validateMachineId(value, name = "machine_id") {
  const text = requireText(value, name, 128);
  if (text === "*" || text !== text.trim() || CONTROL_CHARS_RE.test(text)) {
    throw new CoreError("invalid_input", `${name}必须是有效的机器标识`);
  }
  return text;
}

function validateIsoTimestamp(value, name) {
  const text = requireText(value, name, 64);
  if (CONTROL_CHARS_RE.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new CoreError("invalid_input", `${name}必须是有效的ISO时间戳`);
  }
  return text;
}

function validateTitle(title, maxTitleChars = BOARD_LIMITS.maxTitleChars) {
  const text = requireText(title, "title", maxTitleChars * 4);
  if (CONTROL_CHARS_RE.test(text)) {
    throw new CoreError("invalid_input", "title不能包含控制字符");
  }
  const trimmed = text.trim();
  if (!trimmed || [...trimmed].length > maxTitleChars) {
    throw new CoreError("invalid_input", `title长度必须在1到${maxTitleChars}字符之间`);
  }
  return trimmed;
}

function validateSha256(value, name = "sha256") {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new CoreError("invalid_input", `${name}必须是64位小写十六进制SHA-256`);
  }
  return value;
}

function validateSafeRelPath(value, name = "rel_path") {
  const relPath = requireText(value, name, 512);
  if (
    CONTROL_CHARS_RE.test(relPath)
    || relPath.includes("\\")
    || /^[A-Za-z]:/.test(relPath)
    || relPath.split("/").some(seg => seg === "" || seg === "." || seg === "..")
  ) {
    throw new CoreError("invalid_input", `${name}无效`);
  }
  return relPath;
}

export function sanitizeSafeFileName(rawName) {
  if (typeof rawName !== "string" || rawName.length === 0 || rawName.trim().length === 0) {
    throw new CoreError("invalid_input", "文件名不能为空");
  }
  if (rawName === "." || rawName === "..") {
    throw new CoreError("invalid_input", "文件名不能为.或..");
  }
  if (FORBIDDEN_FILENAME_CHARS_RE.test(rawName)) {
    throw new CoreError("invalid_input", "文件名包含禁止的路径或通配字符");
  }
  if (CONTROL_CHARS_RE.test(rawName)) {
    throw new CoreError("invalid_input", "文件名不能包含控制字符");
  }
  if (BIDI_CHARS_RE.test(rawName)) {
    throw new CoreError("invalid_input", "文件名不能包含Unicode双向控制字符");
  }
  if (TRAILING_SPACE_OR_DOT_RE.test(rawName)) {
    throw new CoreError("invalid_input", "文件名不能以空白或句点结尾");
  }
  if (Buffer.byteLength(rawName, "utf8") > MAX_SAFE_FILENAME_UTF8_BYTES) {
    throw new CoreError("invalid_input", `文件名UTF-8编码长度不能超过${MAX_SAFE_FILENAME_UTF8_BYTES}字节`);
  }
  const firstDot = rawName.indexOf(".");
  const stem = (firstDot === -1 ? rawName : rawName.slice(0, firstDot)).trimEnd();
  if (stem.length > 0 && WINDOWS_RESERVED_STEM_RE.test(stem)) {
    throw new CoreError("invalid_input", "文件名使用了Windows保留设备名");
  }
  return rawName;
}

export function normalizeMemberIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new CoreError("invalid_input", "成员身份必须是包含4个字段的对象");
  }
  requireText(identity.surface, "surface", 64);
  const normalized = normalizeIdentity(identity);
  for (const [field, value] of Object.entries(normalized)) {
    if (value === "*" || value !== value.trim() || CONTROL_CHARS_RE.test(value)) {
      throw new CoreError("invalid_input", `成员身份字段${field}无效`);
    }
  }
  return Object.freeze(normalized);
}

export function normalizeBoardSettings(settings = {}, existing = null) {
  if (settings !== undefined && settings !== null) {
    assertExactKeys(settings, SETTINGS_KEYS, "交流板设置");
  }
  const base = existing ?? {
    default_file_sync_machines: ["*"],
    auto_archive_days: BOARD_LIMITS.defaultAutoArchiveDays,
    default_poll_interval_sec: BOARD_LIMITS.defaultPollIntervalSec,
  };
  const input = settings ?? {};
  const rawMachines = input.default_file_sync_machines !== undefined
    ? input.default_file_sync_machines
    : base.default_file_sync_machines;
  if (!Array.isArray(rawMachines) || rawMachines.length === 0 || rawMachines.length > 128) {
    throw new CoreError("invalid_input", "default_file_sync_machines必须是非空字符串数组");
  }
  const machines = [];
  const seen = new Set();
  for (const item of rawMachines) {
    const text = requireText(item, "default_file_sync_machines[]", 128);
    if (text !== text.trim() || CONTROL_CHARS_RE.test(text)) {
      throw new CoreError("invalid_input", "default_file_sync_machines包含非法机器标识");
    }
    if (!seen.has(text)) {
      seen.add(text);
      machines.push(text);
    }
  }
  if (seen.has("*") && machines.length > 1) {
    throw new CoreError("invalid_input", "default_file_sync_machines使用通配符*时不能混用具体机器名");
  }
  const autoArchiveDays = requireInteger(
    input.auto_archive_days !== undefined ? input.auto_archive_days : base.auto_archive_days,
    "auto_archive_days",
    BOARD_LIMITS.minAutoArchiveDays,
    BOARD_LIMITS.maxAutoArchiveDays,
  );
  const defaultPollIntervalSec = requireInteger(
    input.default_poll_interval_sec !== undefined ? input.default_poll_interval_sec : base.default_poll_interval_sec,
    "default_poll_interval_sec",
    BOARD_LIMITS.minPollIntervalSec,
    BOARD_LIMITS.maxPollIntervalSec,
  );
  return {
    default_file_sync_machines: machines,
    auto_archive_days: autoArchiveDays,
    default_poll_interval_sec: defaultPollIntervalSec,
  };
}

function normalizePathForCompare(targetPath) {
  const resolved = resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithinRoot(rootPath, candidatePath, { allowEqual = false } = {}) {
  const normRoot = normalizePathForCompare(rootPath);
  const normCandidate = normalizePathForCompare(candidatePath);
  const rel = relative(normRoot, normCandidate);
  if (rel === "") return allowEqual;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    return false;
  }
  return true;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFsRetry(action, { attempts = 4, baseDelayMs = 15 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return action();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_FS_CODES.has(error?.code) || attempt === attempts - 1) throw error;
      sleepSync(baseDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function computeFileHashAndBytes(filePath) {
  const lstatInfo = lstatSync(filePath, { bigint: true });
  if (lstatInfo.isSymbolicLink() || !lstatInfo.isFile()) {
    throw new CoreError("invalid_input", "目标路径不是普通文件");
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const fd = openSync(filePath, flags);
  try {
    const fstatInfo = fstatSync(fd, { bigint: true });
    if (!fstatInfo.isFile() || fstatInfo.dev !== lstatInfo.dev || fstatInfo.ino !== lstatInfo.ino) {
      throw new CoreError("upload_toctou_detected", "文件校验过程中发生变动");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let totalBytes = 0;
    for (;;) {
      const readBytes = readSync(fd, buffer, 0, buffer.length, null);
      if (readBytes === 0) break;
      totalBytes += readBytes;
      hash.update(buffer.subarray(0, readBytes));
    }
    return { sha256: hash.digest("hex"), bytes: totalBytes };
  } finally {
    closeSync(fd);
  }
}

function writeAllSync(fd, buffer, length) {
  let offset = 0;
  while (offset < length) {
    const written = writeSync(fd, buffer, offset, length - offset);
    if (written <= 0) throw new Error("short_write");
    offset += written;
  }
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
    const childPath = join(dirPath, entry.name);
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

function pathExists(targetPath) {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function mergeMoveDirectory(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      withFsRetry(() => rmSync(join(srcDir, entry.name), { force: true }));
      continue;
    }
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      mergeMoveDirectory(srcPath, dstPath);
      withFsRetry(() => rmSync(srcPath, { recursive: true, force: true }));
    } else if (entry.isFile()) {
      if (!pathExists(dstPath)) {
        moveFileWithFallback(srcPath, dstPath);
      } else {
        const srcMeta = computeFileHashAndBytes(srcPath);
        const dstMeta = computeFileHashAndBytes(dstPath);
        if (srcMeta.sha256 === dstMeta.sha256 && srcMeta.bytes === dstMeta.bytes) {
          withFsRetry(() => rmSync(srcPath, { force: true }));
        } else {
          throw new CoreError("board_file_hash_conflict", `目录合并发现同名异容文件: ${entry.name}`);
        }
      }
    }
  }
}

function moveFileWithFallback(srcPath, dstPath) {
  try {
    withFsRetry(() => renameSync(srcPath, dstPath));
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    const srcFd = openSync(srcPath, flags);
    const tmpDst = `${dstPath}.${randomUUID()}.tmp`;
    let dstFd = -1;
    try {
      dstFd = openSync(tmpDst, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const n = readSync(srcFd, buf, 0, buf.length, null);
        if (n === 0) break;
        writeAllSync(dstFd, buf, n);
      }
      fsyncSync(dstFd);
      closeSync(dstFd);
      dstFd = -1;
      withFsRetry(() => renameSync(tmpDst, dstPath));
      withFsRetry(() => rmSync(srcPath, { force: true }));
    } catch (copyErr) {
      if (dstFd !== -1) {
        try { closeSync(dstFd); } catch { /* ignore */ }
      }
      try { rmSync(tmpDst, { force: true }); } catch { /* ignore */ }
      throw copyErr;
    } finally {
      closeSync(srcFd);
    }
  }
}

function moveDirectoryIdempotent(srcDir, dstDir) {
  const srcExists = pathExists(srcDir);
  const dstExists = pathExists(dstDir);
  if (!srcExists) return;
  if (!dstExists) {
    try {
      withFsRetry(() => renameSync(srcDir, dstDir));
      return;
    } catch (error) {
      if (error?.code !== "EXDEV" && error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    }
  }
  mergeMoveDirectory(srcDir, dstDir);
  withFsRetry(() => rmSync(srcDir, { recursive: true, force: true }));
}

function decodeBoardRow(row) {
  if (!row) return null;
  return {
    board_id: row.board_id,
    host_machine_id: row.host_machine_id,
    title: row.title,
    status: row.status,
    state_version: row.state_version,
    meta_version: row.meta_version,
    archive_version: row.archive_version,
    archive_reason: row.archive_reason ?? null,
    archive_format: row.archive_format,
    settings: JSON.parse(row.settings_json),
    board_seq: row.board_seq,
    creator_key: row.creator_key,
    created_at: row.created_at,
    last_active_at: row.last_active_at,
    archived_at: row.archived_at ?? null,
    dissolved_by_key: row.dissolved_by_key ?? null,
  };
}

function decodeMemberRow(row) {
  if (!row) return null;
  const identity = {
    machine_id: row.machine_id,
    host: row.host,
    surface: row.surface,
    conversation_id: row.conversation_id,
  };
  return {
    board_id: row.board_id,
    member_key: row.member_key,
    ...identity,
    identity,
    subscription_state: row.subscription_state,
    delivery_mode: row.delivery_mode,
    filter_mode: row.filter_mode,
    filter_targets: JSON.parse(row.filter_targets_json),
    last_read_seq: row.last_read_seq,
    last_notified_seq: row.last_notified_seq,
    joined_at: row.joined_at,
  };
}

function decodePostRow(row) {
  if (!row) return null;
  return {
    board_id: row.board_id,
    seq: row.seq,
    author_key: row.author_key,
    author: JSON.parse(row.author_json),
    body: row.body,
    mentions: JSON.parse(row.mentions_json),
    files: JSON.parse(row.files_json),
    created_at: row.created_at,
    origin_client_post_id: row.origin_client_post_id,
  };
}

function decodeSyncStateRow(row) {
  if (!row) return null;
  return {
    board_id: row.board_id,
    peer_machine_id: row.peer_machine_id,
    last_acked_seq: row.last_acked_seq,
    last_acked_state_version: row.last_acked_state_version,
    last_acked_meta_version: row.last_acked_meta_version,
    last_notified_dissolve_version: row.last_notified_dissolve_version,
    last_synced_at: row.last_synced_at ?? null,
  };
}

function decodeTombstoneRow(row) {
  if (!row) return null;
  return {
    board_id: row.board_id,
    host_machine_id: row.host_machine_id,
    final_state_version: row.final_state_version,
    deleted_by_key: row.deleted_by_key,
    deleted_at: row.deleted_at,
  };
}

function decodeFileSyncRow(row) {
  if (!row) return null;
  return {
    board_id: row.board_id,
    file_id: row.file_id,
    peer_machine_id: row.peer_machine_id,
    seq: row.seq,
    status: row.status,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at,
    last_error: row.last_error ?? null,
    updated_at: row.updated_at,
  };
}

function decodeOutboxRow(row) {
  if (!row) return null;
  return {
    local_post_id: row.local_post_id,
    dedupe_key: row.dedupe_key,
    board_id: row.board_id,
    host_machine_id: row.host_machine_id,
    author_key: row.author_key,
    op_kind: row.op_kind,
    payload_json: row.payload_json,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at,
    last_error_code: row.last_error_code ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function decodeNotificationRow(row) {
  if (!row) return null;
  return {
    dedupe_key: row.dedupe_key,
    board_id: row.board_id,
    member_key: row.member_key,
    member: JSON.parse(row.member_json),
    member_json: row.member_json,
    kind: row.kind,
    state_version: row.state_version,
    payload: JSON.parse(row.payload_json),
    payload_json: row.payload_json,
    status: row.status,
    retry_count: row.retry_count,
    next_retry_at: row.next_retry_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeJsonText(value, name) {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      throw new CoreError("invalid_input", `${name}必须是有效的JSON文本`);
    }
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined_json");
    return serialized;
  } catch {
    throw new CoreError("invalid_input", `${name}必须可以序列化为JSON`);
  }
}

function normalizeStringList(values, name, maxItems = 256, maxItemBytes = 1024) {
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new CoreError("invalid_input", `${name}必须是大小受限的数组`);
  }
  const result = [];
  const seen = new Set();
  for (const item of values) {
    const text = requireText(item, `${name}[]`, maxItemBytes);
    if (CONTROL_CHARS_RE.test(text)) {
      throw new CoreError("invalid_input", `${name}不能包含控制字符`);
    }
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function normalizePostFiles(files, maxFilesPerPost, maxFileBytes, defaultUploadedAt) {
  if (!Array.isArray(files)) {
    throw new CoreError("invalid_input", "files必须是数组");
  }
  if (files.length > maxFilesPerPost) {
    throw new CoreError("board_too_many_files", `单帖附件数量不能超过${maxFilesPerPost}`);
  }
  const seenFileIds = new Set();
  return files.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CoreError("invalid_input", "附件元数据必须是对象");
    }
    const fileId = validateSafeId(item.file_id, "file_id");
    if (seenFileIds.has(fileId)) {
      throw new CoreError("invalid_input", `单帖包含重复file_id: ${fileId}`);
    }
    seenFileIds.add(fileId);
    const safeName = sanitizeSafeFileName(item.safe_name);
    const bytes = requireInteger(item.bytes, "bytes", 0, maxFileBytes);
    const sha256 = validateSha256(item.sha256, "sha256");
    const relPath = validateSafeRelPath(item.rel_path, "rel_path");
    const localStatus = item.local_status ?? "ready";
    if (!FILE_LOCAL_STATUSES.has(localStatus)) {
      throw new CoreError("invalid_input", "附件local_status无效");
    }
    const syncMachines = item.sync_machines === undefined
      ? []
      : normalizeStringList(item.sync_machines, "sync_machines", 128, 128);
    const uploadedAt = item.uploaded_at !== undefined
      ? validateIsoTimestamp(item.uploaded_at, "uploaded_at")
      : defaultUploadedAt;
    const record = {
      file_id: fileId,
      safe_name: safeName,
      bytes,
      sha256,
      rel_path: relPath,
      local_status: localStatus,
      sync_machines: syncMachines,
      uploaded_at: uploadedAt,
    };
    if (item.bundle_id !== undefined && item.bundle_id !== null) {
      record.bundle_id = requireText(item.bundle_id, "bundle_id", 128);
    }
    if (item.bundle_label !== undefined && item.bundle_label !== null) {
      record.bundle_label = requireText(item.bundle_label, "bundle_label", 256);
    }
    return record;
  });
}

function postContentFingerprint({ body, mentions, files }) {
  return digest({
    body,
    mentions,
    files: files.map(f => ({
      file_id: f.file_id,
      safe_name: f.safe_name,
      bytes: f.bytes,
      sha256: f.sha256,
      bundle_id: f.bundle_id ?? null,
      bundle_label: f.bundle_label ?? null,
    })),
  });
}

export class BoardStore {
  #database;
  #transaction;
  #transactionDepth = 0;
  #privateRoot;
  #allowedUploadRoots;
  #limits;
  #now;

  constructor({
    database,
    transaction = null,
    privateRoot,
    allowedUploadRoots = [],
    limits = {},
    now = () => Date.now(),
  } = {}) {
    if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
      throw new CoreError("invalid_config", "BoardStore需要有效的SQLite数据库连接");
    }
    if (transaction !== null && transaction !== undefined && typeof transaction !== "function") {
      throw new CoreError("invalid_config", "transaction必须是函数");
    }
    const rootText = requireText(privateRoot, "privateRoot", 32768);
    if (rootText.includes("\0") || CONTROL_CHARS_RE.test(rootText)) {
      throw new CoreError("invalid_config", "privateRoot包含非法字符");
    }
    if (!Array.isArray(allowedUploadRoots)) {
      throw new CoreError("invalid_config", "allowedUploadRoots必须是路径数组");
    }
    const normalizedRoots = allowedUploadRoots.map(rootPath => {
      const text = requireText(rootPath, "allowedUploadRoots[]", 32768);
      if (text.includes("\0") || CONTROL_CHARS_RE.test(text)) {
        throw new CoreError("invalid_config", "allowedUploadRoots包含非法字符");
      }
      return resolve(text);
    });
    if (typeof now !== "function") {
      throw new CoreError("invalid_config", "now必须是函数");
    }

    this.#database = database;
    this.#transaction = transaction;
    this.#privateRoot = resolve(rootText);
    this.#allowedUploadRoots = Object.freeze(normalizedRoots);
    this.#limits = Object.freeze({ ...BOARD_LIMITS, ...limits });
    this.#now = now;

    if (!this.#database.isTransaction) {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
    this.runInTransaction(() => {
      this.#database.exec(BOARD_SCHEMA_SQL);
      const boardColumns = new Set(
        this.#database.prepare("PRAGMA table_info(boards)").all().map(col => col.name),
      );
      if (!boardColumns.has("dissolved_by_key")) {
        this.#database.exec("ALTER TABLE boards ADD COLUMN dissolved_by_key TEXT;");
      }
    });
  }

  #assertOpen() {
    if (this.#database.isOpen === false) {
      throw new CoreError("store_closed", "交流板存储已关闭");
    }
  }

  #nowIso(explicitIso) {
    return explicitIso !== undefined && explicitIso !== null
      ? validateIsoTimestamp(explicitIso, "nowIso")
      : new Date(this.#now()).toISOString();
  }

  runInTransaction(fn) {
    this.#assertOpen();
    if (typeof fn !== "function" || types.isAsyncFunction(fn)) {
      throw new CoreError("invalid_input", "transaction需要同步回调");
    }
    if (this.#transaction) {
      return this.#transaction(() => {
        const result = fn(this);
        if (result && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {});
          throw new CoreError("invalid_input", "transaction回调不能返回Promise或thenable");
        }
        return result;
      });
    }
    const outermost = this.#transactionDepth === 0 && !this.#database.isTransaction;
    const savepoint = `board_store_tx_${this.#transactionDepth}`;
    this.#database.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = fn(this);
      if (result && typeof result.then === "function") {
        Promise.resolve(result).catch(() => {});
        throw new CoreError("invalid_input", "transaction回调不能返回Promise或thenable");
      }
      this.#database.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (this.#database.isTransaction) {
          this.#database.exec(
            outermost
              ? "ROLLBACK"
              : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`,
          );
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "交流板事务执行与回滚均失败", { cause: error });
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  // ==================== 物理文件区与 TOCTOU 防线 ====================

  #getBoardsRoot() {
    return join(this.#privateRoot, "boards");
  }

  #getArchiveRoot() {
    return join(this.#privateRoot, "boards-archive");
  }

  #getBoardDir(boardId) {
    return join(this.#getBoardsRoot(), validateBoardId(boardId));
  }

  getBoardFilesDir(boardId) {
    return join(this.#getBoardDir(boardId), "files");
  }

  getBoardArchiveDir(boardId) {
    return join(this.#getArchiveRoot(), validateBoardId(boardId));
  }

  getStagingDir() {
    return join(this.#getBoardsRoot(), ".staging");
  }

  #getOutboxRoot() {
    return join(this.#getBoardsRoot(), ".outbox");
  }

  getOutboxDir(localPostId) {
    return join(this.#getOutboxRoot(), validateSafeId(localPostId, "local_post_id"));
  }

  resolveSafeBoardFilePath(boardId, fileId, safeName, { archived = false } = {}) {
    const validBoardId = validateBoardId(boardId);
    const validFileId = validateSafeId(fileId, "file_id");
    const cleanName = sanitizeSafeFileName(safeName);
    const baseDir = archived
      ? join(this.getBoardArchiveDir(validBoardId), "files")
      : this.getBoardFilesDir(validBoardId);
    const fullPath = join(baseDir, `${validFileId}_${cleanName}`);
    if (!isPathWithinRoot(baseDir, fullPath)) {
      throw new CoreError("invalid_input", "文件路径越界");
    }
    return fullPath;
  }

  #assertWithinPrivateSubtree(targetPath, allowedSubtreeRoot) {
    if (!isPathWithinRoot(allowedSubtreeRoot, targetPath)) {
      throw new CoreError("invalid_input", "目标路径超出受控目录边界");
    }
    if (pathExists(allowedSubtreeRoot) && pathExists(targetPath)) {
      const realRoot = realpathSync(allowedSubtreeRoot);
      const lstatInfo = lstatSync(targetPath);
      if (lstatInfo.isSymbolicLink()) {
        throw new CoreError("invalid_input", "受控目录内禁止符号链接");
      }
      const realTarget = realpathSync(targetPath);
      if (!isPathWithinRoot(realRoot, realTarget)) {
        throw new CoreError("invalid_input", "真实路径超出受控目录边界");
      }
    }
  }

  #openVerifiedAllowedSource(sourcePath) {
    const sourceText = requireText(sourcePath, "sourcePath", 32768);
    if (sourceText.includes("\0") || CONTROL_CHARS_RE.test(sourceText)) {
      throw new CoreError("invalid_input", "sourcePath包含非法字符");
    }
    if (this.#allowedUploadRoots.length === 0) {
      throw new CoreError("upload_path_denied", "未配置允许的本地上传根目录");
    }
    let lstatInfo;
    try {
      lstatInfo = lstatSync(sourceText, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new CoreError("file_not_found", "上传源文件不存在");
      }
      throw error;
    }
    if (lstatInfo.isSymbolicLink()) {
      throw new CoreError("upload_path_denied", "禁止上传符号链接文件");
    }
    if (!lstatInfo.isFile()) {
      throw new CoreError("invalid_input", "上传源必须是普通文件");
    }
    let realSource;
    try {
      realSource = realpathSync(sourceText);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new CoreError("file_not_found", "上传源文件不存在");
      }
      throw error;
    }
    let withinAllowed = false;
    for (const allowedRoot of this.#allowedUploadRoots) {
      let realRoot;
      try {
        realRoot = realpathSync(allowedRoot);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (isPathWithinRoot(realRoot, realSource)) {
        withinAllowed = true;
        break;
      }
    }
    if (!withinAllowed) {
      throw new CoreError("upload_path_denied", "文件路径超出允许的上传目录范围");
    }

    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
    const fd = openSync(realSource, flags);
    try {
      const fstatInfo = fstatSync(fd, { bigint: true });
      if (!fstatInfo.isFile()) {
        throw new CoreError("invalid_input", "上传源必须是普通文件");
      }
      if (fstatInfo.dev !== lstatInfo.dev || fstatInfo.ino !== lstatInfo.ino) {
        throw new CoreError("upload_toctou_detected", "源文件在打开前后发生替换");
      }
      const expectedSize = Number(fstatInfo.size);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        throw new CoreError("board_file_too_large", "文件大小超出安全范围");
      }
      if (expectedSize > this.#limits.maxFileBytes) {
        throw new CoreError("board_file_too_large", `单文件不能超过${this.#limits.maxFileBytes}字节`);
      }
      return { fd, expectedSize, realSource };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  getBoardFilesTotalBytes(boardId) {
    const filesDir = this.getBoardFilesDir(boardId);
    return sumDirectoryBytes(filesDir);
  }

  getGlobalFilesTotalBytes() {
    return sumDirectoryBytes(this.#getBoardsRoot()) + sumDirectoryBytes(this.#getArchiveRoot());
  }

  stageLocalUploadFile({ sourcePath, originalName, fileId, opId, boardId }) {
    const validBoardId = validateBoardId(boardId);
    const validFileId = fileId !== undefined && fileId !== null
      ? validateSafeId(fileId, "file_id")
      : randomUUID();
    const validOpId = opId !== undefined && opId !== null
      ? validateSafeId(opId, "op_id")
      : randomUUID();
    const rawName = originalName !== undefined && originalName !== null
      ? originalName
      : (typeof sourcePath === "string" ? basename(sourcePath) : "");
    const safeName = sanitizeSafeFileName(rawName);

    const { fd: srcFd, expectedSize } = this.#openVerifiedAllowedSource(sourcePath);
    const stagingDir = this.getStagingDir();
    const stagingName = `${validOpId}.tmp`;
    const stagingPath = join(stagingDir, stagingName);
    let dstFd = -1;
    let createdTmp = false;
    try {
      const boardBytes = this.getBoardFilesTotalBytes(validBoardId);
      if (boardBytes + expectedSize > this.#limits.maxBoardFilesBytes) {
        throw new CoreError("board_quota_exceeded", "超出单板文件总大小配额");
      }
      const globalBytes = this.getGlobalFilesTotalBytes();
      if (globalBytes + expectedSize > this.#limits.maxTotalFilesBytes) {
        throw new CoreError("board_quota_exceeded", "超出本机交流板全局文件总大小配额");
      }

      mkdirSync(stagingDir, { recursive: true });
      dstFd = openSync(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      createdTmp = true;

      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let actualBytes = 0;
      for (;;) {
        const readBytes = readSync(srcFd, chunk, 0, chunk.length, null);
        if (readBytes === 0) break;
        actualBytes += readBytes;
        if (actualBytes > this.#limits.maxFileBytes) {
          throw new CoreError("board_file_too_large", `单文件不能超过${this.#limits.maxFileBytes}字节`);
        }
        if (boardBytes + actualBytes > this.#limits.maxBoardFilesBytes
          || globalBytes + actualBytes > this.#limits.maxTotalFilesBytes) {
          throw new CoreError("board_quota_exceeded", "写入过程中超出交流板文件配额");
        }
        writeAllSync(dstFd, chunk, readBytes);
        hash.update(chunk.subarray(0, readBytes));
      }
      if (actualBytes !== expectedSize) {
        throw new CoreError("upload_toctou_detected", "源文件在读取过程中大小发生变化");
      }
      fsyncSync(dstFd);
      closeSync(dstFd);
      dstFd = -1;

      const sha256 = hash.digest("hex");
      const localPath = this.resolveSafeBoardFilePath(validBoardId, validFileId, safeName);
      const relPath = `boards/${validBoardId}/files/${validFileId}_${safeName}`;
      return {
        op_id: validOpId,
        staging_name: stagingName,
        file_id: validFileId,
        safe_name: safeName,
        bytes: actualBytes,
        sha256,
        rel_path: relPath,
        local_path: localPath,
      };
    } catch (error) {
      if (dstFd !== -1) {
        try { closeSync(dstFd); } catch { /* ignore */ }
      }
      if (createdTmp) {
        try { rmSync(stagingPath, { force: true }); } catch { /* ignore */ }
      }
      throw error;
    } finally {
      closeSync(srcFd);
    }
  }

  stageOutboxAttachment({ sourcePath, originalName, localPostId, fileId }) {
    const validLocalPostId = validateSafeId(localPostId, "local_post_id");
    const validFileId = fileId !== undefined && fileId !== null
      ? validateSafeId(fileId, "file_id")
      : randomUUID();
    const rawName = originalName !== undefined && originalName !== null
      ? originalName
      : (typeof sourcePath === "string" ? basename(sourcePath) : "");
    const safeName = sanitizeSafeFileName(rawName);

    const { fd: srcFd, expectedSize } = this.#openVerifiedAllowedSource(sourcePath);
    const outboxDir = this.getOutboxDir(validLocalPostId);
    const finalName = `${validFileId}_${safeName}`;
    const finalPath = join(outboxDir, finalName);
    if (!isPathWithinRoot(outboxDir, finalPath)) {
      closeSync(srcFd);
      throw new CoreError("invalid_input", "outbox附件路径越界");
    }
    const tmpPath = join(outboxDir, `.ob_${validFileId}_${randomUUID()}.tmp`);
    let dstFd = -1;
    let createdTmp = false;
    try {
      const globalBytes = this.getGlobalFilesTotalBytes();
      if (globalBytes + expectedSize > this.#limits.maxTotalFilesBytes) {
        throw new CoreError("board_quota_exceeded", "超出本机交流板全局文件总大小配额");
      }
      mkdirSync(outboxDir, { recursive: true });
      dstFd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      createdTmp = true;

      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let actualBytes = 0;
      for (;;) {
        const readBytes = readSync(srcFd, chunk, 0, chunk.length, null);
        if (readBytes === 0) break;
        actualBytes += readBytes;
        if (actualBytes > this.#limits.maxFileBytes) {
          throw new CoreError("board_file_too_large", `单文件不能超过${this.#limits.maxFileBytes}字节`);
        }
        if (globalBytes + actualBytes > this.#limits.maxTotalFilesBytes) {
          throw new CoreError("board_quota_exceeded", "写入过程中超出交流板全局文件配额");
        }
        writeAllSync(dstFd, chunk, readBytes);
        hash.update(chunk.subarray(0, readBytes));
      }
      if (actualBytes !== expectedSize) {
        throw new CoreError("upload_toctou_detected", "源文件在读取过程中大小发生变化");
      }
      fsyncSync(dstFd);
      closeSync(dstFd);
      dstFd = -1;

      const sha256 = hash.digest("hex");
      if (pathExists(finalPath)) {
        const existing = computeFileHashAndBytes(finalPath);
        if (existing.sha256 === sha256 && existing.bytes === actualBytes) {
          rmSync(tmpPath, { force: true });
        } else {
          rmSync(tmpPath, { force: true });
          throw new CoreError("board_file_hash_conflict", "outbox已存在同ID异容附件");
        }
      } else {
        withFsRetry(() => renameSync(tmpPath, finalPath));
      }
      createdTmp = false;
      return {
        file_id: validFileId,
        safe_name: safeName,
        bytes: actualBytes,
        sha256,
        outbox_path: finalPath,
        rel_path: `boards/.outbox/${validLocalPostId}/${finalName}`,
      };
    } catch (error) {
      if (dstFd !== -1) {
        try { closeSync(dstFd); } catch { /* ignore */ }
      }
      if (createdTmp) {
        try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      }
      throw error;
    } finally {
      closeSync(srcFd);
    }
  }

  stageRemoteFileBufferOrPath({
    sourcePath = null,
    buffer = null,
    boardId,
    fileId,
    safeName,
    expectedSha256,
    expectedBytes = null,
    archived = false,
  }) {
    const validBoardId = validateBoardId(boardId);
    const validFileId = validateSafeId(fileId, "file_id");
    const cleanName = sanitizeSafeFileName(safeName);
    const validExpectedSha256 = validateSha256(expectedSha256, "expectedSha256");
    if (typeof archived !== "boolean") {
      throw new CoreError("invalid_input", "archived必须是布尔值");
    }
    const hasExpectedBytes = expectedBytes !== undefined && expectedBytes !== null;
    if (hasExpectedBytes) {
      requireInteger(expectedBytes, "expectedBytes", 0);
      if (expectedBytes > this.#limits.maxFileBytes) {
        throw new CoreError("board_file_too_large", `远端文件大小超过${this.#limits.maxFileBytes}字节上限`);
      }
    }
    const hasBuffer = buffer !== undefined && buffer !== null;
    const hasSourcePath = sourcePath !== undefined && sourcePath !== null;
    if (hasBuffer === hasSourcePath) {
      throw new CoreError("invalid_input", "sourcePath与buffer必须且只能提供一个");
    }

    const filesDir = archived
      ? join(this.getBoardArchiveDir(validBoardId), "files")
      : this.getBoardFilesDir(validBoardId);
    const finalPath = this.resolveSafeBoardFilePath(validBoardId, validFileId, cleanName, { archived });
    const relPath = archived
      ? `boards-archive/${validBoardId}/files/${validFileId}_${cleanName}`
      : `boards/${validBoardId}/files/${validFileId}_${cleanName}`;
    const targetAlreadyExists = pathExists(finalPath);

    let incomingBytesEstimate = 0;
    let rawBuffer = null;
    let srcFd = -1;
    let srcLstat = null;

    if (hasBuffer) {
      if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
        throw new CoreError("invalid_input", "buffer必须是Buffer或Uint8Array");
      }
      rawBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      incomingBytesEstimate = rawBuffer.byteLength;
      if (incomingBytesEstimate > this.#limits.maxFileBytes) {
        throw new CoreError("board_file_too_large", `远端文件超过${this.#limits.maxFileBytes}字节上限`);
      }
    } else {
      const sourceText = requireText(sourcePath, "sourcePath", 32768);
      if (sourceText.includes("\0") || CONTROL_CHARS_RE.test(sourceText)) {
        throw new CoreError("invalid_input", "sourcePath包含非法字符");
      }
      try {
        srcLstat = lstatSync(sourceText, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") throw new CoreError("file_not_found", "远端文件暂存源不存在");
        throw error;
      }
      if (srcLstat.isSymbolicLink() || !srcLstat.isFile()) {
        throw new CoreError("upload_path_denied", "远端文件源不能为符号链接或非普通文件");
      }
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
      srcFd = openSync(sourceText, flags);
      const srcFstat = fstatSync(srcFd, { bigint: true });
      if (!srcFstat.isFile() || srcFstat.dev !== srcLstat.dev || srcFstat.ino !== srcLstat.ino) {
        closeSync(srcFd);
        throw new CoreError("upload_toctou_detected", "远端文件源在打开前后发生变动");
      }
      incomingBytesEstimate = Number(srcFstat.size);
      if (!Number.isSafeInteger(incomingBytesEstimate) || incomingBytesEstimate > this.#limits.maxFileBytes) {
        closeSync(srcFd);
        throw new CoreError("board_file_too_large", `远端文件超过${this.#limits.maxFileBytes}字节上限`);
      }
    }

    mkdirSync(filesDir, { recursive: true });
    const tmpPath = join(filesDir, `.rx_${validFileId}_${randomUUID()}.tmp`);
    let dstFd = -1;
    let createdTmp = false;

    try {
      if (!targetAlreadyExists) {
        const boardBytes = this.getBoardFilesTotalBytes(validBoardId) + (archived ? sumDirectoryBytes(filesDir) : 0);
        if (boardBytes + incomingBytesEstimate > this.#limits.maxBoardFilesBytes) {
          throw new CoreError("board_quota_exceeded", "超出单板文件总大小配额");
        }
        const globalBytes = this.getGlobalFilesTotalBytes();
        if (globalBytes + incomingBytesEstimate > this.#limits.maxTotalFilesBytes) {
          throw new CoreError("board_quota_exceeded", "超出本机交流板全局文件总大小配额");
        }
      }

      dstFd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      createdTmp = true;

      const hash = createHash("sha256");
      let actualBytes = 0;

      if (rawBuffer !== null) {
        if (rawBuffer.byteLength > 0) {
          writeAllSync(dstFd, rawBuffer, rawBuffer.byteLength);
          hash.update(rawBuffer);
          actualBytes = rawBuffer.byteLength;
        }
      } else {
        const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        for (;;) {
          const readBytes = readSync(srcFd, chunk, 0, chunk.length, null);
          if (readBytes === 0) break;
          actualBytes += readBytes;
          if (actualBytes > this.#limits.maxFileBytes) {
            throw new CoreError("board_file_too_large", `远端文件超过${this.#limits.maxFileBytes}字节上限`);
          }
          writeAllSync(dstFd, chunk, readBytes);
          hash.update(chunk.subarray(0, readBytes));
        }
      }

      fsyncSync(dstFd);
      closeSync(dstFd);
      dstFd = -1;

      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== validExpectedSha256) {
        throw new CoreError("board_file_hash_conflict", "远端文件SHA-256验签失败", {
          expected_sha256: validExpectedSha256,
          actual_sha256: actualSha256,
        });
      }
      if (hasExpectedBytes && actualBytes !== expectedBytes) {
        throw new CoreError("board_file_hash_conflict", "远端文件字节数与预期不符", {
          expected_bytes: expectedBytes,
          actual_bytes: actualBytes,
        });
      }

      if (pathExists(finalPath)) {
        const existing = computeFileHashAndBytes(finalPath);
        if (existing.sha256 === actualSha256 && existing.bytes === actualBytes) {
          rmSync(tmpPath, { force: true });
          createdTmp = false;
          return {
            local_path: finalPath,
            rel_path: relPath,
            bytes: actualBytes,
            sha256: actualSha256,
          };
        }
        throw new CoreError("board_file_hash_conflict", "本地已存在同file_id但哈希冲突的文件", {
          expected_sha256: actualSha256,
          existing_sha256: existing.sha256,
        });
      }

      withFsRetry(() => renameSync(tmpPath, finalPath));
      createdTmp = false;
      return {
        local_path: finalPath,
        rel_path: relPath,
        bytes: actualBytes,
        sha256: actualSha256,
      };
    } catch (error) {
      if (dstFd !== -1) {
        try { closeSync(dstFd); } catch { /* ignore */ }
      }
      if (createdTmp) {
        try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      }
      throw error;
    } finally {
      if (srcFd !== -1) {
        try { closeSync(srcFd); } catch { /* ignore */ }
      }
    }
  }

  commitStagedFileOps(opIds) {
    this.#assertOpen();
    if (!Array.isArray(opIds) || opIds.length === 0) {
      return { committed: [], skipped: [], failed: [] };
    }
    const committed = [];
    const skipped = [];
    const failed = [];
    const stagingDir = this.getStagingDir();
    const boardsRoot = this.#getBoardsRoot();

    for (const rawOpId of opIds) {
      const opId = validateSafeId(rawOpId, "op_id");
      const op = this.#database.prepare("SELECT * FROM board_file_ops WHERE op_id = ?").get(opId);
      if (!op || op.status !== "pending" || op.op_kind !== "stage_file") {
        skipped.push(opId);
        continue;
      }
      const ts = this.#nowIso();
      if (this.getTombstone(op.board_id)) {
        if (op.staging_name) {
          const safeStaging = validateStagingName(op.staging_name);
          const sp = join(stagingDir, safeStaging);
          if (isPathWithinRoot(stagingDir, sp) && pathExists(sp)) {
            withFsRetry(() => rmSync(sp, { force: true }));
          }
        }
        this.#database.prepare("UPDATE board_file_ops SET status = 'superseded', updated_at = ? WHERE op_id = ?")
          .run(ts, opId);
        skipped.push(opId);
        continue;
      }
      const board = this.getBoard(op.board_id);
      if (!board) {
        skipped.push(opId);
        continue;
      }
      try {
        const archived = board.status === "archived";
        const targetPath = this.resolveSafeBoardFilePath(op.board_id, op.file_id, op.safe_name, { archived });
        const targetDir = archived ? join(this.getBoardArchiveDir(op.board_id), "files") : this.getBoardFilesDir(op.board_id);
        const safeStaging = validateStagingName(op.staging_name);
        const stagingPath = join(stagingDir, safeStaging);
        this.#assertWithinPrivateSubtree(stagingPath, stagingDir);
        this.#assertWithinPrivateSubtree(targetPath, archived ? this.#getArchiveRoot() : boardsRoot);

        mkdirSync(targetDir, { recursive: true });
        if (pathExists(stagingPath)) {
          if (pathExists(targetPath)) {
            const existing = computeFileHashAndBytes(targetPath);
            if (!op.expected_sha256 || existing.sha256 === op.expected_sha256) {
              withFsRetry(() => rmSync(stagingPath, { force: true }));
            } else {
              throw new CoreError("board_file_hash_conflict", "终目录已有同ID异容文件");
            }
          } else {
            moveFileWithFallback(stagingPath, targetPath);
          }
        } else if (pathExists(targetPath)) {
          const existing = computeFileHashAndBytes(targetPath);
          if (op.expected_sha256 && existing.sha256 !== op.expected_sha256) {
            throw new CoreError("board_file_hash_conflict", "已落盘文件哈希与记录不一致");
          }
        } else {
          throw new CoreError("file_not_found", "暂存文件与目标文件均缺失");
        }

        this.#database.prepare("UPDATE board_file_ops SET status = 'done', updated_at = ? WHERE op_id = ?")
          .run(ts, opId);
        committed.push(opId);
      } catch (error) {
        failed.push({ op_id: opId, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
      }
    }
    return { committed, skipped, failed };
  }

  cleanupStagedTempFiles(opIds) {
    if (!Array.isArray(opIds) || opIds.length === 0) {
      return { cleaned: [], skipped: [], failed: [] };
    }
    const stagingDir = this.getStagingDir();
    const cleaned = [];
    const skipped = [];
    const failed = [];
    for (const rawItem of opIds) {
      try {
        let stagingName;
        let label;
        if (rawItem && typeof rawItem === "object") {
          if (typeof rawItem.staging_name === "string" && rawItem.staging_name.length > 0) {
            stagingName = validateStagingName(rawItem.staging_name);
            label = rawItem.op_id ?? stagingName;
          } else {
            const validOpId = validateSafeId(rawItem.op_id, "op_id");
            stagingName = `${validOpId}.tmp`;
            label = validOpId;
          }
        } else if (typeof rawItem === "string" && rawItem.endsWith(".tmp")) {
          stagingName = validateStagingName(rawItem);
          label = stagingName;
        } else {
          const validOpId = validateSafeId(rawItem, "op_id");
          stagingName = `${validOpId}.tmp`;
          label = validOpId;
        }
        const targetPath = join(stagingDir, stagingName);
        this.#assertWithinPrivateSubtree(targetPath, stagingDir);
        if (!pathExists(targetPath)) {
          skipped.push(label);
          continue;
        }
        withFsRetry(() => rmSync(targetPath, { force: true }));
        cleaned.push(label);
      } catch (error) {
        failed.push({
          item: typeof rawItem === "string" ? rawItem : (rawItem?.op_id ?? rawItem?.staging_name ?? null),
          code: error?.code ?? "fs_error",
          message: error?.message ?? String(error),
        });
      }
    }
    return { cleaned, skipped, failed };
  }

  cleanupOutboxDir(localPostId) {
    const validLocalPostId = validateSafeId(localPostId, "local_post_id");
    const outboxRoot = this.#getOutboxRoot();
    const targetDir = this.getOutboxDir(validLocalPostId);
    this.#assertWithinPrivateSubtree(targetDir, outboxRoot);
    if (!pathExists(targetDir)) return false;
    withFsRetry(() => rmSync(targetDir, { recursive: true, force: true }));
    return true;
  }

  reconcilePendingFileOps({ pruneDoneOlderThanMs } = {}) {
    this.#assertOpen();
    let processed = 0;
    let superseded = 0;
    const errors = [];
    const ts = this.#nowIso();
    const nowMs = this.#now();

    const pendingOps = this.#database.prepare(`
      SELECT * FROM board_file_ops
      INDEXED BY idx_board_file_ops_pending
      WHERE status = 'pending'
      ORDER BY board_id ASC, state_version ASC, op_seq ASC
    `).all();

    const byBoard = new Map();
    for (const op of pendingOps) {
      if (!byBoard.has(op.board_id)) byBoard.set(op.board_id, []);
      byBoard.get(op.board_id).push(op);
    }

    const stagingDir = this.getStagingDir();
    const boardsRoot = this.#getBoardsRoot();
    const archiveRoot = this.#getArchiveRoot();
    const markStatusStmt = this.#database.prepare(
      "UPDATE board_file_ops SET status = ?, updated_at = ? WHERE op_seq = ?",
    );

    const safeRemoveStaging = (stagingName) => {
      if (!stagingName) return;
      const safeName = validateStagingName(stagingName);
      const sp = join(stagingDir, safeName);
      this.#assertWithinPrivateSubtree(sp, stagingDir);
      if (pathExists(sp)) {
        withFsRetry(() => rmSync(sp, { force: true }));
      }
    };

    for (const [boardId, ops] of byBoard.entries()) {
      let validBoardId;
      try {
        validBoardId = validateBoardId(boardId);
      } catch (error) {
        for (const op of ops) {
          markStatusStmt.run("superseded", ts, op.op_seq);
          superseded += 1;
        }
        errors.push({ board_id: boardId, code: error.code, message: error.message });
        continue;
      }

      const activeDir = this.#getBoardDir(validBoardId);
      const archiveDir = this.getBoardArchiveDir(validBoardId);
      const tombstone = this.getTombstone(validBoardId);

      if (tombstone) {
        let latestPurgeOp = null;
        for (const op of ops) {
          if (op.op_kind === "purge_archived_dir") {
            latestPurgeOp = op;
          }
        }
        for (const op of ops) {
          if (latestPurgeOp && op.op_seq === latestPurgeOp.op_seq) continue;
          try {
            if (op.op_kind === "stage_file") safeRemoveStaging(op.staging_name);
          } catch (error) {
            errors.push({ board_id: validBoardId, op_id: op.op_id, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
          }
          markStatusStmt.run("superseded", ts, op.op_seq);
          superseded += 1;
        }
        try {
          this.#assertWithinPrivateSubtree(activeDir, boardsRoot);
          this.#assertWithinPrivateSubtree(archiveDir, archiveRoot);
          if (pathExists(activeDir)) {
            withFsRetry(() => rmSync(activeDir, { recursive: true, force: true }));
          }
          if (pathExists(archiveDir)) {
            withFsRetry(() => rmSync(archiveDir, { recursive: true, force: true }));
          }
          if (latestPurgeOp) {
            markStatusStmt.run("done", ts, latestPurgeOp.op_seq);
            processed += 1;
          }
        } catch (error) {
          errors.push({
            board_id: validBoardId,
            op_id: latestPurgeOp?.op_id ?? null,
            code: error?.code ?? "fs_error",
            message: error?.message ?? String(error),
          });
        }
        continue;
      }

      const board = this.getBoard(validBoardId);
      if (!board) {
        for (const op of ops) {
          try {
            if (op.op_kind === "stage_file") safeRemoveStaging(op.staging_name);
          } catch (error) {
            errors.push({ board_id: validBoardId, op_id: op.op_id, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
          }
          markStatusStmt.run("superseded", ts, op.op_seq);
          superseded += 1;
        }
        continue;
      }

      // 1. 先处理 stage_file，将已提交帖子对应的暂存文件收敛到与当前板状态一致的目标目录
      const archived = board.status === "archived";
      for (const op of ops) {
        if (op.op_kind !== "stage_file") continue;
        try {
          const targetPath = this.resolveSafeBoardFilePath(validBoardId, op.file_id, op.safe_name, { archived });
          const altPath = this.resolveSafeBoardFilePath(validBoardId, op.file_id, op.safe_name, { archived: !archived });
          const targetDir = archived ? join(archiveDir, "files") : this.getBoardFilesDir(validBoardId);
          const safeStaging = validateStagingName(op.staging_name);
          const stagingPath = join(stagingDir, safeStaging);
          this.#assertWithinPrivateSubtree(stagingPath, stagingDir);
          this.#assertWithinPrivateSubtree(targetPath, archived ? archiveRoot : boardsRoot);

          mkdirSync(targetDir, { recursive: true });
          if (pathExists(stagingPath)) {
            if (op.expected_sha256) {
              const stagedMeta = computeFileHashAndBytes(stagingPath);
              if (stagedMeta.sha256 !== op.expected_sha256) {
                throw new CoreError("board_file_hash_conflict", "暂存文件哈希校验失败");
              }
            }
            if (pathExists(targetPath)) {
              const existing = computeFileHashAndBytes(targetPath);
              if (!op.expected_sha256 || existing.sha256 === op.expected_sha256) {
                withFsRetry(() => rmSync(stagingPath, { force: true }));
              } else {
                throw new CoreError("board_file_hash_conflict", "目标文件已存在且哈希冲突");
              }
            } else {
              moveFileWithFallback(stagingPath, targetPath);
            }
            markStatusStmt.run("done", ts, op.op_seq);
            processed += 1;
          } else if (pathExists(targetPath)) {
            if (op.expected_sha256) {
              const existing = computeFileHashAndBytes(targetPath);
              if (existing.sha256 !== op.expected_sha256) {
                throw new CoreError("board_file_hash_conflict", "目标文件哈希不匹配");
              }
            }
            markStatusStmt.run("done", ts, op.op_seq);
            processed += 1;
          } else if (pathExists(altPath)) {
            moveFileWithFallback(altPath, targetPath);
            markStatusStmt.run("done", ts, op.op_seq);
            processed += 1;
          } else if (op.state_version < board.state_version) {
            markStatusStmt.run("superseded", ts, op.op_seq);
            superseded += 1;
          } else {
            errors.push({ board_id: validBoardId, op_id: op.op_id, code: "file_not_found", message: "暂存文件与目标文件均缺失" });
          }
        } catch (error) {
          errors.push({ board_id: validBoardId, op_id: op.op_id, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
        }
      }

      // 2. 再处理目录状态迁移（move_to_archive / restore_from_archive），仅对齐当前最终 (status, state_version)
      const dirOps = ops.filter(op => op.op_kind !== "stage_file");
      const expectedOpKind = board.status === "archived" ? "move_to_archive" : "restore_from_archive";
      let targetDirOp = null;
      for (const op of dirOps) {
        if (op.state_version === board.state_version && op.op_kind === expectedOpKind) {
          targetDirOp = op;
        }
      }
      for (const op of dirOps) {
        if (targetDirOp && op.op_seq === targetDirOp.op_seq) continue;
        markStatusStmt.run("superseded", ts, op.op_seq);
        superseded += 1;
      }
      if (targetDirOp) {
        try {
          this.#assertWithinPrivateSubtree(activeDir, boardsRoot);
          this.#assertWithinPrivateSubtree(archiveDir, archiveRoot);
          if (expectedOpKind === "move_to_archive") {
            mkdirSync(archiveRoot, { recursive: true });
            moveDirectoryIdempotent(activeDir, archiveDir);
          } else {
            mkdirSync(boardsRoot, { recursive: true });
            moveDirectoryIdempotent(archiveDir, activeDir);
          }
          markStatusStmt.run("done", ts, targetDirOp.op_seq);
          processed += 1;
        } catch (error) {
          errors.push({ board_id: validBoardId, op_id: targetDirOp.op_id, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
        }
      }
    }

    // 3. 定期清理超期 done/superseded 记录与无引用孤儿 .staging/*.tmp
    const retentionMs = pruneDoneOlderThanMs !== undefined
      ? requireInteger(pruneDoneOlderThanMs, "pruneDoneOlderThanMs", 0)
      : this.#limits.doneFileOpRetentionMs;
    const cutoffIso = new Date(nowMs - retentionMs).toISOString();
    const cleanedDone = this.#database.prepare(`
      DELETE FROM board_file_ops
      WHERE status IN ('done', 'superseded') AND updated_at <= ?
    `).run(cutoffIso).changes;

    let cleanedStaging = 0;
    if (pathExists(stagingDir)) {
      const referenced = new Set(
        this.#database.prepare(`
          SELECT staging_name FROM board_file_ops
          WHERE status = 'pending' AND staging_name IS NOT NULL
        `).all().map(row => row.staging_name),
      );
      const orphanGraceMs = Math.min(retentionMs, 5 * 60 * 1000);
      for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
        if (referenced.has(entry.name)) continue;
        const candidatePath = join(stagingDir, entry.name);
        if (!isPathWithinRoot(stagingDir, candidatePath)) continue;
        try {
          const stat = lstatSync(candidatePath);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          if (stat.mtimeMs <= nowMs - orphanGraceMs) {
            withFsRetry(() => rmSync(candidatePath, { force: true }));
            cleanedStaging += 1;
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            errors.push({ staging_name: entry.name, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
          }
        }
      }
    }

    let cleanedOutbox = 0;
    const outboxRoot = this.#getOutboxRoot();
    if (pathExists(outboxRoot)) {
      const activeOutboxIds = new Set(
        this.#database.prepare(`
          SELECT local_post_id FROM board_remote_outbox
          WHERE status NOT IN ('acked', 'rejected_archived', 'rejected_deleted', 'dead_letter')
        `).all().map(row => row.local_post_id),
      );
      for (const entry of readdirSync(outboxRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        if (activeOutboxIds.has(entry.name)) continue;
        const candidateDir = join(outboxRoot, entry.name);
        try {
          this.#assertWithinPrivateSubtree(candidateDir, outboxRoot);
          withFsRetry(() => rmSync(candidateDir, { recursive: true, force: true }));
          cleanedOutbox += 1;
        } catch (error) {
          if (error?.code !== "ENOENT") {
            errors.push({ outbox_id: entry.name, code: error?.code ?? "fs_error", message: error?.message ?? String(error) });
          }
        }
      }
    }

    return {
      processed,
      superseded,
      cleaned_done: cleanedDone,
      cleaned_staging: cleanedStaging,
      cleaned_outbox: cleanedOutbox,
      errors,
    };
  }

  // ==================== 板、成员、帖子与生命周期 ====================

  getBoard(boardId) {
    this.#assertOpen();
    validateBoardId(boardId);
    return decodeBoardRow(this.#database.prepare("SELECT * FROM boards WHERE board_id = ?").get(boardId));
  }

  getTombstone(boardId) {
    this.#assertOpen();
    validateBoardId(boardId);
    return decodeTombstoneRow(this.#database.prepare("SELECT * FROM board_tombstones WHERE board_id = ?").get(boardId));
  }

  createBoard({ board_id, host_machine_id, title, settings = {}, creator, nowIso } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(board_id);
    const validHostMachine = validateMachineId(host_machine_id, "host_machine_id");
    const validTitle = validateTitle(title, this.#limits.maxTitleChars);
    const normalizedSettings = normalizeBoardSettings(settings);
    const creatorIdentity = normalizeMemberIdentity(creator);
    const creatorKey = identityKey(creatorIdentity);
    const ts = this.#nowIso(nowIso);

    return this.runInTransaction(() => {
      if (this.getTombstone(validBoardId)) {
        throw new CoreError("board_deleted_tombstone", "该交流板已被永久删除，不能复用原标识");
      }
      if (this.getBoard(validBoardId)) {
        throw new CoreError("board_already_exists", "该交流板标识已存在");
      }
      this.#database.prepare(`
        INSERT INTO boards (
          board_id, host_machine_id, title, status, state_version, meta_version,
          archive_version, archive_reason, archive_format, settings_json,
          board_seq, creator_key, created_at, last_active_at, archived_at, dissolved_by_key
        ) VALUES (?, ?, ?, 'active', 0, 1, 0, NULL, 'dir', ?, 0, ?, ?, ?, NULL, NULL)
      `).run(
        validBoardId,
        validHostMachine,
        validTitle,
        JSON.stringify(normalizedSettings),
        creatorKey,
        ts,
        ts,
      );
      this.#database.prepare(`
        INSERT INTO board_members (
          board_id, member_key, machine_id, host, surface, conversation_id,
          subscription_state, delivery_mode, filter_mode, filter_targets_json,
          last_read_seq, last_notified_seq, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'poll', 'all', '[]', 0, 0, ?)
      `).run(
        validBoardId,
        creatorKey,
        creatorIdentity.machine_id,
        creatorIdentity.host,
        creatorIdentity.surface,
        creatorIdentity.conversation_id,
        ts,
      );
      return this.getBoard(validBoardId);
    });
  }

  upsertBoardFromRemote({
    board_id,
    host_machine_id,
    title,
    status,
    state_version,
    meta_version,
    archive_version = 0,
    archive_reason = null,
    settings = {},
    creator_key,
    created_at,
    last_active_at,
    archived_at = null,
    dissolved_by_key = null,
    members = [],
  } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(board_id);
    const validHostMachine = validateMachineId(host_machine_id, "host_machine_id");
    const validTitle = validateTitle(title, this.#limits.maxTitleChars);
    if (!BOARD_STATUSES.has(status)) {
      throw new CoreError("invalid_input", "status必须是active或archived");
    }
    const validStateVersion = requireInteger(state_version, "state_version", 0);
    const validMetaVersion = requireInteger(meta_version, "meta_version", 1);
    const validArchiveVersion = requireInteger(archive_version, "archive_version", 0);
    if (archive_reason !== null && archive_reason !== undefined && !ARCHIVE_REASONS.has(archive_reason)) {
      throw new CoreError("invalid_input", "archive_reason无效");
    }
    const normalizedSettings = normalizeBoardSettings(settings);
    const validCreatorKey = (
      creator_key === undefined
      || creator_key === null
      || (typeof creator_key === "string" && creator_key.trim().length === 0)
    )
      ? "system:unknown"
      : requireText(creator_key, "creator_key", 1024);
    const validCreatedAt = validateIsoTimestamp(created_at, "created_at");
    const validLastActiveAt = validateIsoTimestamp(last_active_at, "last_active_at");
    const validArchivedAt = archived_at !== null && archived_at !== undefined
      ? validateIsoTimestamp(archived_at, "archived_at")
      : null;
    const validDissolvedByKey = (
      status === "archived"
      && archive_reason === "manual_dissolve"
      && dissolved_by_key !== null
      && dissolved_by_key !== undefined
      && !(typeof dissolved_by_key === "string" && dissolved_by_key.trim().length === 0)
    )
      ? requireText(dissolved_by_key, "dissolved_by_key", 1024)
      : null;
    if (!Array.isArray(members)) {
      throw new CoreError("invalid_input", "members必须是数组");
    }

    const parsedMembers = members.map(item => {
      const identity = normalizeMemberIdentity(item.identity ?? item);
      const memberKey = identityKey(identity);
      const subState = item.subscription_state ?? "active";
      if (!SUBSCRIPTION_STATES.has(subState)) {
        throw new CoreError("invalid_input", "成员subscription_state无效");
      }
      const deliveryMode = item.delivery_mode ?? "poll";
      if (!DELIVERY_MODES.has(deliveryMode)) {
        throw new CoreError("invalid_input", "成员delivery_mode无效");
      }
      const filterMode = item.filter_mode ?? "all";
      if (!FILTER_MODES.has(filterMode)) {
        throw new CoreError("invalid_input", "成员filter_mode无效");
      }
      const filterTargets = item.filter_targets !== undefined
        ? normalizeStringList(item.filter_targets, "filter_targets")
        : [];
      const joinedAt = item.joined_at !== undefined
        ? validateIsoTimestamp(item.joined_at, "joined_at")
        : validCreatedAt;
      return {
        identity,
        member_key: memberKey,
        subscription_state: subState,
        delivery_mode: deliveryMode,
        filter_mode: filterMode,
        filter_targets: filterTargets,
        joined_at: joinedAt,
      };
    });

    return this.runInTransaction(() => {
      if (this.getTombstone(validBoardId)) {
        return {
          applied: false,
          code: "board_deleted_tombstone",
          created: false,
          state_changed: false,
          meta_changed: false,
          newly_added_members: [],
        };
      }

      const local = this.getBoard(validBoardId);
      const ts = this.#nowIso();

      const syncMembers = () => {
        const newlyAdded = [];
        for (const m of parsedMembers) {
          const existing = this.getMember(validBoardId, m.member_key);
          if (!existing) {
            const count = this.#database.prepare(
              "SELECT count(*) AS total FROM board_members WHERE board_id = ?",
            ).get(validBoardId).total;
            if (count >= this.#limits.maxMembersPerBoard) {
              throw new CoreError("board_member_limit", "交流板成员数量已达上限");
            }
            this.#database.prepare(`
              INSERT INTO board_members (
                board_id, member_key, machine_id, host, surface, conversation_id,
                subscription_state, delivery_mode, filter_mode, filter_targets_json,
                last_read_seq, last_notified_seq, joined_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
            `).run(
              validBoardId,
              m.member_key,
              m.identity.machine_id,
              m.identity.host,
              m.identity.surface,
              m.identity.conversation_id,
              m.subscription_state,
              m.delivery_mode,
              m.filter_mode,
              JSON.stringify(m.filter_targets),
              m.joined_at,
            );
            newlyAdded.push(this.getMember(validBoardId, m.member_key));
          } else if (existing.subscription_state !== m.subscription_state) {
            this.#database.prepare(`
              UPDATE board_members SET subscription_state = ?
              WHERE board_id = ? AND member_key = ?
            `).run(m.subscription_state, validBoardId, m.member_key);
          }
        }
        return newlyAdded;
      };

      if (!local) {
        this.#database.prepare(`
          INSERT INTO boards (
            board_id, host_machine_id, title, status, state_version, meta_version,
            archive_version, archive_reason, archive_format, settings_json,
            board_seq, creator_key, created_at, last_active_at, archived_at, dissolved_by_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dir', ?, 0, ?, ?, ?, ?, ?)
        `).run(
          validBoardId,
          validHostMachine,
          validTitle,
          status,
          validStateVersion,
          validMetaVersion,
          validArchiveVersion,
          archive_reason ?? null,
          JSON.stringify(normalizedSettings),
          validCreatorKey,
          validCreatedAt,
          validLastActiveAt,
          validArchivedAt,
          validDissolvedByKey,
        );
        const newlyAdded = syncMembers();
        return {
          applied: true,
          created: true,
          state_changed: true,
          meta_changed: true,
          newly_added_members: newlyAdded,
        };
      }

      if (local.host_machine_id !== validHostMachine) {
        throw new CoreError("board_host_mismatch", "远端建板机标识与本地记录不一致");
      }

      if (validStateVersion < local.state_version) {
        return {
          applied: false,
          code: "stale_state_version",
          created: false,
          state_changed: false,
          meta_changed: false,
          newly_added_members: [],
        };
      }

      let stateChanged = false;
      let metaChanged = false;
      let newlyAddedMembers = [];
      let fileOpId = null;

      if (validStateVersion > local.state_version) {
        const nextArchiveVersion = Math.max(local.archive_version, validArchiveVersion);
        this.#database.prepare(`
          UPDATE boards
          SET status = ?, state_version = ?, archive_version = ?, archive_reason = ?, archived_at = ?, dissolved_by_key = ?
          WHERE board_id = ?
        `).run(status, validStateVersion, nextArchiveVersion, archive_reason ?? null, validArchivedAt, validDissolvedByKey, validBoardId);
        stateChanged = true;

        if (local.status === "active" && status === "archived") {
          fileOpId = randomUUID();
          this.#database.prepare(`
            INSERT INTO board_file_ops (
              op_id, board_id, op_kind, state_version, status, created_at, updated_at
            ) VALUES (?, ?, 'move_to_archive', ?, 'pending', ?, ?)
          `).run(fileOpId, validBoardId, validStateVersion, ts, ts);
        } else if (local.status === "archived" && status === "active") {
          fileOpId = randomUUID();
          this.#database.prepare(`
            INSERT INTO board_file_ops (
              op_id, board_id, op_kind, state_version, status, created_at, updated_at
            ) VALUES (?, ?, 'restore_from_archive', ?, 'pending', ?, ?)
          `).run(fileOpId, validBoardId, validStateVersion, ts, ts);
          this.#database.prepare(`
            UPDATE board_notifications
            SET status = 'cancelled', updated_at = ?
            WHERE board_id = ? AND kind = 'dissolved' AND status = 'pending'
          `).run(ts, validBoardId);
        }
      }

      if (validStateVersion >= local.state_version && validMetaVersion > local.meta_version) {
        this.#database.prepare(`
          UPDATE boards
          SET title = ?, settings_json = ?, meta_version = ?
          WHERE board_id = ?
        `).run(validTitle, JSON.stringify(normalizedSettings), validMetaVersion, validBoardId);
        newlyAddedMembers = syncMembers();
        metaChanged = true;
      }

      if (validLastActiveAt > local.last_active_at) {
        this.#database.prepare("UPDATE boards SET last_active_at = ? WHERE board_id = ?")
          .run(validLastActiveAt, validBoardId);
      }

      return {
        applied: stateChanged || metaChanged,
        created: false,
        state_changed: stateChanged,
        meta_changed: metaChanged,
        newly_added_members: newlyAddedMembers,
        ...(fileOpId ? { file_op_id: fileOpId } : {}),
      };
    });
  }

  listBoardsForActor({ actorKey = null, isSuperAdmin = false, status = null, limit = 30, offset = 0 } = {}) {
    this.#assertOpen();
    requireInteger(limit, "limit", 1, 100);
    requireInteger(offset, "offset", 0);
    if (status !== null && status !== undefined && !BOARD_STATUSES.has(status)) {
      throw new CoreError("invalid_input", "status过滤必须是active或archived");
    }

    if (isSuperAdmin) {
      const validActorKey = actorKey ? requireText(actorKey, "actorKey", 1024) : "";
      const total = status
        ? this.#database.prepare("SELECT count(*) AS total FROM boards WHERE status = ?").get(status).total
        : this.#database.prepare("SELECT count(*) AS total FROM boards").get().total;
      const rows = status
        ? this.#database.prepare(`
            SELECT b.*, m.subscription_state, m.delivery_mode, m.last_read_seq,
                   (SELECT MAX(s.last_synced_at) FROM board_sync_state s WHERE s.board_id = b.board_id) AS last_synced_at
            FROM boards b
            LEFT JOIN board_members m ON m.board_id = b.board_id AND m.member_key = ?
            WHERE b.status = ?
            ORDER BY b.last_active_at DESC, b.board_id ASC
            LIMIT ? OFFSET ?
          `).all(validActorKey, status, limit, offset)
        : this.#database.prepare(`
            SELECT b.*, m.subscription_state, m.delivery_mode, m.last_read_seq,
                   (SELECT MAX(s.last_synced_at) FROM board_sync_state s WHERE s.board_id = b.board_id) AS last_synced_at
            FROM boards b
            LEFT JOIN board_members m ON m.board_id = b.board_id AND m.member_key = ?
            ORDER BY b.last_active_at DESC, b.board_id ASC
            LIMIT ? OFFSET ?
          `).all(validActorKey, limit, offset);
      const items = rows.map(row => {
        const board = decodeBoardRow(row);
        return {
          ...board,
          subscription_state: row.subscription_state ?? null,
          delivery_mode: row.delivery_mode ?? null,
          last_read_seq: row.last_read_seq ?? 0,
          unread_count: row.subscription_state === "active"
            ? Math.max(0, board.board_seq - (row.last_read_seq ?? 0))
            : 0,
          last_synced_at: row.last_synced_at ?? null,
        };
      });
      return {
        items,
        total,
        next_offset: offset + items.length < total ? offset + items.length : null,
      };
    }

    const validActorKey = requireText(actorKey, "actorKey", 1024);
    const total = status
      ? this.#database.prepare(`
          SELECT count(*) AS total
          FROM board_members m
          JOIN boards b ON b.board_id = m.board_id
          WHERE m.member_key = ? AND b.status = ?
        `).get(validActorKey, status).total
      : this.#database.prepare(`
          SELECT count(*) AS total
          FROM board_members m
          WHERE m.member_key = ?
        `).get(validActorKey).total;
    const rows = status
      ? this.#database.prepare(`
          SELECT b.*, m.subscription_state, m.delivery_mode, m.last_read_seq,
                 (SELECT MAX(s.last_synced_at) FROM board_sync_state s WHERE s.board_id = b.board_id) AS last_synced_at
          FROM board_members m
          JOIN boards b ON b.board_id = m.board_id
          WHERE m.member_key = ? AND b.status = ?
          ORDER BY b.last_active_at DESC, b.board_id ASC
          LIMIT ? OFFSET ?
        `).all(validActorKey, status, limit, offset)
      : this.#database.prepare(`
          SELECT b.*, m.subscription_state, m.delivery_mode, m.last_read_seq,
                 (SELECT MAX(s.last_synced_at) FROM board_sync_state s WHERE s.board_id = b.board_id) AS last_synced_at
          FROM board_members m
          JOIN boards b ON b.board_id = m.board_id
          WHERE m.member_key = ?
          ORDER BY b.last_active_at DESC, b.board_id ASC
          LIMIT ? OFFSET ?
        `).all(validActorKey, limit, offset);
    const items = rows.map(row => {
      const board = decodeBoardRow(row);
      return {
        ...board,
        subscription_state: row.subscription_state,
        delivery_mode: row.delivery_mode,
        last_read_seq: row.last_read_seq,
        unread_count: row.subscription_state === "active"
          ? Math.max(0, board.board_seq - row.last_read_seq)
          : 0,
        last_synced_at: row.last_synced_at ?? null,
      };
    });
    return {
      items,
      total,
      next_offset: offset + items.length < total ? offset + items.length : null,
    };
  }

  getMember(boardId, memberKey) {
    this.#assertOpen();
    validateBoardId(boardId);
    requireText(memberKey, "memberKey", 1024);
    return decodeMemberRow(this.#database.prepare(
      "SELECT * FROM board_members WHERE board_id = ? AND member_key = ?",
    ).get(boardId, memberKey));
  }

  listMembers(boardId, { activeOnly = false } = {}) {
    this.#assertOpen();
    validateBoardId(boardId);
    const rows = activeOnly
      ? this.#database.prepare(`
          SELECT * FROM board_members
          WHERE board_id = ? AND subscription_state = 'active'
          ORDER BY joined_at ASC, member_key ASC
        `).all(boardId)
      : this.#database.prepare(`
          SELECT * FROM board_members
          WHERE board_id = ?
          ORDER BY joined_at ASC, member_key ASC
        `).all(boardId);
    return rows.map(decodeMemberRow);
  }

  listActiveRemotePeerMachines(boardId, localMachineId) {
    this.#assertOpen();
    validateBoardId(boardId);
    const validLocal = validateMachineId(localMachineId, "localMachineId");
    return this.#database.prepare(`
      SELECT DISTINCT machine_id FROM board_members
      WHERE board_id = ? AND subscription_state = 'active' AND machine_id != ?
      ORDER BY machine_id ASC
    `).all(boardId, validLocal).map(row => row.machine_id);
  }

  listKnownPeerMachines(localMachineId) {
    this.#assertOpen();
    const validLocal = validateMachineId(localMachineId, "localMachineId");
    return this.#database.prepare(`
      SELECT machine_id FROM (
        SELECT machine_id AS machine_id FROM board_members
        UNION
        SELECT peer_machine_id AS machine_id FROM board_sync_state
        UNION
        SELECT peer_machine_id AS machine_id FROM board_tombstone_sync
        UNION
        SELECT peer_machine_id AS machine_id FROM board_file_sync_queue
        UNION
        SELECT host_machine_id AS machine_id FROM board_remote_outbox
      )
      WHERE machine_id != ? AND machine_id != ''
      ORDER BY machine_id ASC
    `).all(validLocal).map(row => row.machine_id);
  }

  upsertMember(
    boardId,
    memberIdentity,
    {
      subscription_state = "active",
      delivery_mode = "poll",
      filter_mode = "all",
      filter_targets = [],
      bumpMetaVersion = true,
      nowIso,
    } = {},
  ) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const identity = normalizeMemberIdentity(memberIdentity);
    const memberKey = identityKey(identity);
    if (!SUBSCRIPTION_STATES.has(subscription_state)) {
      throw new CoreError("invalid_input", "subscription_state无效");
    }
    if (!DELIVERY_MODES.has(delivery_mode)) {
      throw new CoreError("invalid_input", "delivery_mode无效");
    }
    if (!FILTER_MODES.has(filter_mode)) {
      throw new CoreError("invalid_input", "filter_mode无效");
    }
    const targets = normalizeStringList(filter_targets, "filter_targets");
    const ts = this.#nowIso(nowIso);

    return this.runInTransaction(() => {
      if (!this.getBoard(validBoardId)) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      const existing = this.getMember(validBoardId, memberKey);
      if (!existing) {
        const count = this.#database.prepare(
          "SELECT count(*) AS total FROM board_members WHERE board_id = ?",
        ).get(validBoardId).total;
        if (count >= this.#limits.maxMembersPerBoard) {
          throw new CoreError("board_member_limit", "交流板成员数量已达上限");
        }
        this.#database.prepare(`
          INSERT INTO board_members (
            board_id, member_key, machine_id, host, surface, conversation_id,
            subscription_state, delivery_mode, filter_mode, filter_targets_json,
            last_read_seq, last_notified_seq, joined_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        `).run(
          validBoardId,
          memberKey,
          identity.machine_id,
          identity.host,
          identity.surface,
          identity.conversation_id,
          subscription_state,
          delivery_mode,
          filter_mode,
          JSON.stringify(targets),
          ts,
        );
        if (bumpMetaVersion) {
          this.#database.prepare("UPDATE boards SET meta_version = meta_version + 1 WHERE board_id = ?")
            .run(validBoardId);
        }
        return { member: this.getMember(validBoardId, memberKey), changed: true };
      }

      const subChanged = existing.subscription_state !== subscription_state;
      if (subChanged) {
        this.#database.prepare(`
          UPDATE board_members SET subscription_state = ?
          WHERE board_id = ? AND member_key = ?
        `).run(subscription_state, validBoardId, memberKey);
        if (bumpMetaVersion) {
          this.#database.prepare("UPDATE boards SET meta_version = meta_version + 1 WHERE board_id = ?")
            .run(validBoardId);
        }
      }
      return { member: this.getMember(validBoardId, memberKey), changed: subChanged };
    });
  }

  setMemberSubscriptionState(boardId, memberKey, subscriptionState, { bumpMetaVersion = true } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    requireText(memberKey, "memberKey", 1024);
    if (!SUBSCRIPTION_STATES.has(subscriptionState)) {
      throw new CoreError("invalid_input", "subscriptionState无效");
    }
    return this.runInTransaction(() => {
      const existing = this.getMember(validBoardId, memberKey);
      if (!existing) {
        throw new CoreError("member_not_found", "该成员不在交流板内");
      }
      if (existing.subscription_state === subscriptionState) {
        return { member: existing, changed: false };
      }
      this.#database.prepare(`
        UPDATE board_members SET subscription_state = ?
        WHERE board_id = ? AND member_key = ?
      `).run(subscriptionState, validBoardId, memberKey);
      if (bumpMetaVersion) {
        this.#database.prepare("UPDATE boards SET meta_version = meta_version + 1 WHERE board_id = ?")
          .run(validBoardId);
      }
      return { member: this.getMember(validBoardId, memberKey), changed: true };
    });
  }

  updateMemberPreferences(boardId, memberKey, { delivery_mode, filter_mode, filter_targets } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    requireText(memberKey, "memberKey", 1024);
    return this.runInTransaction(() => {
      const existing = this.getMember(validBoardId, memberKey);
      if (!existing) {
        throw new CoreError("member_not_found", "该成员不在交流板内");
      }
      const nextDelivery = delivery_mode !== undefined ? delivery_mode : existing.delivery_mode;
      const nextFilter = filter_mode !== undefined ? filter_mode : existing.filter_mode;
      const nextTargets = filter_targets !== undefined
        ? normalizeStringList(filter_targets, "filter_targets")
        : existing.filter_targets;
      if (!DELIVERY_MODES.has(nextDelivery)) {
        throw new CoreError("invalid_input", "delivery_mode无效");
      }
      if (!FILTER_MODES.has(nextFilter)) {
        throw new CoreError("invalid_input", "filter_mode无效");
      }
      this.#database.prepare(`
        UPDATE board_members
        SET delivery_mode = ?, filter_mode = ?, filter_targets_json = ?
        WHERE board_id = ? AND member_key = ?
      `).run(nextDelivery, nextFilter, JSON.stringify(nextTargets), validBoardId, memberKey);
      return this.getMember(validBoardId, memberKey);
    });
  }

  updateMemberReadCursor(boardId, memberKey, seq) {
    this.#assertOpen();
    validateBoardId(boardId);
    requireText(memberKey, "memberKey", 1024);
    requireInteger(seq, "seq", 0);
    this.#database.prepare(`
      UPDATE board_members
      SET last_read_seq = MAX(last_read_seq, ?)
      WHERE board_id = ? AND member_key = ?
    `).run(seq, boardId, memberKey);
    return this.getMember(boardId, memberKey);
  }

  updateMemberNotifiedCursor(boardId, memberKey, seq) {
    this.#assertOpen();
    validateBoardId(boardId);
    requireText(memberKey, "memberKey", 1024);
    requireInteger(seq, "seq", 0);
    this.#database.prepare(`
      UPDATE board_members
      SET last_notified_seq = MAX(last_notified_seq, ?)
      WHERE board_id = ? AND member_key = ?
    `).run(seq, boardId, memberKey);
    return this.getMember(boardId, memberKey);
  }

  updateBoardSettings(boardId, settingsPatch, { nowIso } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    if (nowIso !== undefined && nowIso !== null) validateIsoTimestamp(nowIso, "nowIso");
    return this.runInTransaction(() => {
      const board = this.getBoard(validBoardId);
      if (!board) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      const nextSettings = normalizeBoardSettings(settingsPatch, board.settings);
      this.#database.prepare(`
        UPDATE boards SET settings_json = ?, meta_version = meta_version + 1
        WHERE board_id = ?
      `).run(JSON.stringify(nextSettings), validBoardId);
      return this.getBoard(validBoardId);
    });
  }

  appendPost({
    boardId,
    author,
    body = "",
    mentions = [],
    files = [],
    originClientPostId,
    stagedFileOps = [],
    fileSyncTargets = [],
    nowIso,
  } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const authorIdentity = normalizeMemberIdentity(author);
    const authorKey = identityKey(authorIdentity);
    if (typeof body !== "string") {
      throw new CoreError("invalid_input", "body必须是字符串");
    }
    if (Buffer.byteLength(body, "utf8") > this.#limits.maxBodyBytes) {
      throw new CoreError("board_body_too_large", `单帖正文不能超过${this.#limits.maxBodyBytes}字节`);
    }
    const normalizedMentions = normalizeStringList(mentions, "mentions");
    const ts = this.#nowIso(nowIso);
    const normalizedFiles = normalizePostFiles(files, this.#limits.maxFilesPerPost, this.#limits.maxFileBytes, ts);
    if (body.trim().length === 0 && normalizedFiles.length === 0) {
      throw new CoreError("invalid_input", "发帖正文与附件不能同时为空");
    }
    const validOriginPostId = requireText(originClientPostId, "originClientPostId", 256);
    if (CONTROL_CHARS_RE.test(validOriginPostId)) {
      throw new CoreError("invalid_input", "originClientPostId不能包含控制字符");
    }
    if (!Array.isArray(stagedFileOps)) {
      throw new CoreError("invalid_input", "stagedFileOps必须是数组");
    }
    if (!Array.isArray(fileSyncTargets)) {
      throw new CoreError("invalid_input", "fileSyncTargets必须是数组");
    }

    const incomingFingerprint = postContentFingerprint({
      body,
      mentions: normalizedMentions,
      files: normalizedFiles,
    });

    return this.runInTransaction(() => {
      const board = this.getBoard(validBoardId);
      if (!board) {
        if (this.getTombstone(validBoardId)) {
          throw new CoreError("board_deleted_tombstone", "交流板已永久删除");
        }
        throw new CoreError("board_not_found", "交流板不存在");
      }
      if (board.status !== "active") {
        throw new CoreError("board_archived", "交流板已归档，不能继续发帖");
      }

      const existing = this.#database.prepare(`
        SELECT * FROM board_posts
        WHERE board_id = ? AND author_key = ? AND origin_client_post_id = ?
      `).get(validBoardId, authorKey, validOriginPostId);

      if (existing) {
        const decodedExisting = decodePostRow(existing);
        const existingFingerprint = postContentFingerprint({
          body: decodedExisting.body,
          mentions: decodedExisting.mentions,
          files: decodedExisting.files,
        });
        if (existingFingerprint !== incomingFingerprint) {
          throw new CoreError("board_post_conflict", "同一去重键已存在不同内容的帖子");
        }
        return { post: decodedExisting, deduplicated: true, file_op_ids: [] };
      }

      const nextSeq = board.board_seq + 1;
      this.#database.prepare(`
        INSERT INTO board_posts (
          board_id, seq, author_key, author_json, body, mentions_json, files_json, created_at, origin_client_post_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validBoardId,
        nextSeq,
        authorKey,
        JSON.stringify(authorIdentity),
        body,
        JSON.stringify(normalizedMentions),
        JSON.stringify(normalizedFiles),
        ts,
        validOriginPostId,
      );

      this.#database.prepare(`
        UPDATE boards
        SET board_seq = ?,
            last_active_at = CASE WHEN ? > last_active_at THEN ? ELSE last_active_at END
        WHERE board_id = ?
      `).run(nextSeq, ts, ts, validBoardId);

      const fileOpIds = [];
      for (const op of stagedFileOps) {
        const opId = validateSafeId(op.op_id, "op_id");
        const stagingName = validateStagingName(op.staging_name);
        const fileId = validateSafeId(op.file_id, "file_id");
        const safeName = sanitizeSafeFileName(op.safe_name);
        const expectedSha = op.sha256 ?? op.expected_sha256 ?? null;
        if (expectedSha !== null) validateSha256(expectedSha, "expected_sha256");
        const expectedBytes = op.bytes ?? op.expected_bytes ?? null;
        if (expectedBytes !== null) requireInteger(expectedBytes, "expected_bytes", 0, this.#limits.maxFileBytes);
        this.#database.prepare(`
          INSERT INTO board_file_ops (
            op_id, board_id, op_kind, staging_name, file_id, safe_name,
            expected_sha256, expected_bytes, state_version, status, created_at, updated_at
          ) VALUES (?, ?, 'stage_file', ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          opId,
          validBoardId,
          stagingName,
          fileId,
          safeName,
          expectedSha,
          expectedBytes,
          board.state_version,
          ts,
          ts,
        );
        fileOpIds.push(opId);
      }

      const enqueueSyncStmt = this.#database.prepare(`
        INSERT OR IGNORE INTO board_file_sync_queue (
          board_id, file_id, peer_machine_id, seq, status, retry_count, next_retry_at, last_error, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?)
      `);
      for (const target of fileSyncTargets) {
        if (typeof target === "string") {
          const peerMachine = validateMachineId(target, "peer_machine_id");
          for (const file of normalizedFiles) {
            enqueueSyncStmt.run(validBoardId, file.file_id, peerMachine, nextSeq, "pending", ts);
          }
        } else if (target && typeof target === "object") {
          const fileId = validateSafeId(target.file_id, "file_id");
          const peerMachine = validateMachineId(target.peer_machine_id, "peer_machine_id");
          const syncStatus = target.status ?? "pending";
          if (!FILE_SYNC_STATUSES.has(syncStatus)) {
            throw new CoreError("invalid_input", "fileSyncTargets包含无效status");
          }
          enqueueSyncStmt.run(validBoardId, fileId, peerMachine, nextSeq, syncStatus, ts);
        } else {
          throw new CoreError("invalid_input", "fileSyncTargets元素格式无效");
        }
      }

      const inserted = this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(validBoardId, nextSeq);
      return { post: decodePostRow(inserted), deduplicated: false, file_op_ids: fileOpIds };
    });
  }

  getContiguousBoardSeq(boardId) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const summary = this.#database.prepare(
      "SELECT COUNT(*) AS cnt, COALESCE(MAX(seq), 0) AS max_seq FROM board_posts WHERE board_id = ?",
    ).get(validBoardId);
    if (!summary || summary.cnt === 0) return 0;
    if (summary.cnt === summary.max_seq) return summary.max_seq;
    const hasFirst = this.#database.prepare(
      "SELECT 1 FROM board_posts WHERE board_id = ? AND seq = 1",
    ).get(validBoardId);
    if (!hasFirst) return 0;
    const row = this.#database.prepare(`
      SELECT p.seq AS contiguous_seq
      FROM board_posts p
      WHERE p.board_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM board_posts p2
          WHERE p2.board_id = p.board_id AND p2.seq = p.seq + 1
        )
      ORDER BY p.seq ASC
      LIMIT 1
    `).get(validBoardId);
    return row?.contiguous_seq ?? 0;
  }

  applyRemotePost({
    boardId,
    seq,
    author,
    body = "",
    mentions = [],
    files = [],
    created_at,
    origin_client_post_id,
    incomingStateVersion,
  } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validSeq = requireInteger(seq, "seq", 1);
    const authorIdentity = normalizeMemberIdentity(author);
    const authorKey = identityKey(authorIdentity);
    if (typeof body !== "string") {
      throw new CoreError("invalid_input", "body必须是字符串");
    }
    if (Buffer.byteLength(body, "utf8") > this.#limits.maxBodyBytes) {
      throw new CoreError("board_body_too_large", `单帖正文不能超过${this.#limits.maxBodyBytes}字节`);
    }
    const normalizedMentions = normalizeStringList(mentions, "mentions");
    const validCreatedAt = validateIsoTimestamp(created_at, "created_at");
    const normalizedFiles = normalizePostFiles(files, this.#limits.maxFilesPerPost, this.#limits.maxFileBytes, validCreatedAt);
    const validOriginPostId = requireText(origin_client_post_id, "origin_client_post_id", 256);
    const validStateVersion = requireInteger(incomingStateVersion, "incomingStateVersion", 0);

    const incomingFingerprint = postContentFingerprint({
      body,
      mentions: normalizedMentions,
      files: normalizedFiles,
    });

    return this.runInTransaction(() => {
      if (this.getTombstone(validBoardId)) {
        return { applied: false, deduplicated: false, post: null, code: "board_deleted_tombstone" };
      }
      const board = this.getBoard(validBoardId);
      if (!board) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      if (validStateVersion < board.state_version) {
        return { applied: false, deduplicated: false, post: null, code: "stale_state_version" };
      }
      if (board.status !== "active") {
        return { applied: false, deduplicated: false, post: null, code: "board_archived" };
      }

      const existingBySeq = this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(validBoardId, validSeq);
      if (existingBySeq) {
        const decoded = decodePostRow(existingBySeq);
        const existingFingerprint = postContentFingerprint({
          body: decoded.body,
          mentions: decoded.mentions,
          files: decoded.files,
        });
        if (decoded.author_key === authorKey
          && decoded.origin_client_post_id === validOriginPostId
          && existingFingerprint === incomingFingerprint) {
          return { applied: false, deduplicated: true, post: decoded };
        }
        throw new CoreError("board_post_conflict", "远端帖子序号与本地已有记录内容冲突");
      }

      const existingByOrigin = this.#database.prepare(`
        SELECT * FROM board_posts
        WHERE board_id = ? AND author_key = ? AND origin_client_post_id = ?
      `).get(validBoardId, authorKey, validOriginPostId);
      if (existingByOrigin) {
        throw new CoreError("board_post_conflict", "远端帖子去重键与本地已有序号冲突");
      }

      this.#database.prepare(`
        INSERT INTO board_posts (
          board_id, seq, author_key, author_json, body, mentions_json, files_json, created_at, origin_client_post_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        validBoardId,
        validSeq,
        authorKey,
        JSON.stringify(authorIdentity),
        body,
        JSON.stringify(normalizedMentions),
        JSON.stringify(normalizedFiles),
        validCreatedAt,
        validOriginPostId,
      );

      const contiguousSeq = this.getContiguousBoardSeq(validBoardId);
      this.#database.prepare(`
        UPDATE boards
        SET board_seq = MAX(board_seq, ?),
            last_active_at = CASE WHEN ? > last_active_at THEN ? ELSE last_active_at END
        WHERE board_id = ?
      `).run(contiguousSeq, validCreatedAt, validCreatedAt, validBoardId);

      const inserted = this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(validBoardId, validSeq);
      return { applied: true, deduplicated: false, post: decodePostRow(inserted) };
    });
  }

  updatePostFileLocalStatus(boardId, seq, fileId, { local_status, local_path: _localPath, rel_path } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validSeq = requireInteger(seq, "seq", 1);
    const validFileId = validateSafeId(fileId, "file_id");
    if (!FILE_LOCAL_STATUSES.has(local_status)) {
      throw new CoreError("invalid_input", "local_status无效");
    }
    let validRelPath = null;
    if (rel_path !== undefined && rel_path !== null) {
      validRelPath = validateSafeRelPath(rel_path, "rel_path");
    }
    return this.runInTransaction(() => {
      const row = this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(validBoardId, validSeq);
      if (!row) return null;
      const files = JSON.parse(row.files_json);
      let matched = false;
      for (const file of files) {
        if (file.file_id === validFileId) {
          file.local_status = local_status;
          if (validRelPath !== null) {
            file.rel_path = validRelPath;
          }
          matched = true;
        }
      }
      if (!matched) return null;
      this.#database.prepare(
        "UPDATE board_posts SET files_json = ? WHERE board_id = ? AND seq = ?",
      ).run(JSON.stringify(files), validBoardId, validSeq);
      return decodePostRow(this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(validBoardId, validSeq));
    });
  }

  readPosts({ boardId, afterSeq = 0, seq = null, authorKeys = null, limit = 50 } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    let normalizedAuthors = null;
    if (authorKeys !== null && authorKeys !== undefined) {
      normalizedAuthors = normalizeStringList(authorKeys, "authorKeys");
      if (normalizedAuthors.length === 0) return [];
    }
    if (seq !== null && seq !== undefined) {
      const targetSeq = requireInteger(seq, "seq", 1);
      const row = this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(validBoardId, targetSeq);
      if (!row) return [];
      const post = decodePostRow(row);
      if (normalizedAuthors && !normalizedAuthors.includes(post.author_key)) return [];
      return [post];
    }
    const validAfter = requireInteger(afterSeq, "afterSeq", 0);
    const validLimit = requireInteger(limit, "limit", 1, 200);
    if (normalizedAuthors) {
      const placeholders = normalizedAuthors.map(() => "?").join(", ");
      return this.#database.prepare(`
        SELECT * FROM board_posts
        WHERE board_id = ? AND seq > ? AND author_key IN (${placeholders})
        ORDER BY seq ASC
        LIMIT ?
      `).all(validBoardId, validAfter, ...normalizedAuthors, validLimit).map(decodePostRow);
    }
    return this.#database.prepare(`
      SELECT * FROM board_posts
      WHERE board_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(validBoardId, validAfter, validLimit).map(decodePostRow);
  }

  getPostsRange(boardId, afterSeq = 0, limit = 128) {
    this.#assertOpen();
    validateBoardId(boardId);
    requireInteger(afterSeq, "afterSeq", 0);
    requireInteger(limit, "limit", 1, 500);
    return this.#database.prepare(`
      SELECT * FROM board_posts
      WHERE board_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(boardId, afterSeq, limit).map(decodePostRow);
  }

  getPostByFileId(boardId, fileId) {
    this.#assertOpen();
    validateBoardId(boardId);
    const validFileId = validateSafeId(fileId, "file_id");
    const queued = this.#database.prepare(
      "SELECT seq FROM board_file_sync_queue WHERE board_id = ? AND file_id = ? LIMIT 1",
    ).get(boardId, validFileId);
    if (queued) {
      const direct = this.#database.prepare(
        "SELECT * FROM board_posts WHERE board_id = ? AND seq = ?",
      ).get(boardId, queued.seq);
      if (direct) {
        const post = decodePostRow(direct);
        if (post.files.some(f => f.file_id === validFileId)) return post;
      }
    }
    const rows = this.#database.prepare(
      "SELECT * FROM board_posts WHERE board_id = ? ORDER BY seq ASC",
    ).all(boardId);
    for (const row of rows) {
      const post = decodePostRow(row);
      if (post.files.some(f => f.file_id === validFileId)) return post;
    }
    return null;
  }

  archiveBoard({ boardId, reason, actorKey, nowIso, enqueueNotifications = true } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    if (!ARCHIVE_REASONS.has(reason)) {
      throw new CoreError("invalid_input", "archive reason无效");
    }
    const validActorKey = requireText(actorKey, "actorKey", 1024);
    const ts = this.#nowIso(nowIso);

    return this.runInTransaction(() => {
      const board = this.getBoard(validBoardId);
      if (!board) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      if (board.status === "archived") {
        throw new CoreError("board_already_archived", "交流板已归档");
      }
      const nextStateVersion = board.state_version + 1;
      const nextArchiveVersion = board.archive_version + 1;
      const dissolvedByKey = reason === "manual_dissolve" ? validActorKey : null;
      this.#database.prepare(`
        UPDATE boards
        SET status = 'archived',
            state_version = ?,
            archive_version = ?,
            archive_reason = ?,
            archived_at = ?,
            dissolved_by_key = ?
        WHERE board_id = ?
      `).run(nextStateVersion, nextArchiveVersion, reason, ts, dissolvedByKey, validBoardId);

      const fileOpId = randomUUID();
      this.#database.prepare(`
        INSERT INTO board_file_ops (
          op_id, board_id, op_kind, state_version, status, created_at, updated_at
        ) VALUES (?, ?, 'move_to_archive', ?, 'pending', ?, ?)
      `).run(fileOpId, validBoardId, nextStateVersion, ts, ts);

      if (reason === "manual_dissolve" && enqueueNotifications === true) {
        const activeMembers = this.listMembers(validBoardId, { activeOnly: true });
        const insertNotif = this.#database.prepare(`
          INSERT OR IGNORE INTO board_notifications (
            dedupe_key, board_id, member_key, member_json, kind, state_version,
            payload_json, status, retry_count, next_retry_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'dissolved', ?, ?, 'pending', 0, 0, ?, ?)
        `);
        const payloadJson = JSON.stringify({
          board_id: validBoardId,
          host_machine_id: board.host_machine_id,
          title: board.title,
          state_version: nextStateVersion,
          archive_version: nextArchiveVersion,
          archive_reason: reason,
          dissolved_by_key: validActorKey,
          restorable: true,
          archived_at: ts,
        });
        for (const member of activeMembers) {
          if (member.machine_id !== board.host_machine_id) continue;
          const dedupeKey = `dissolved:${validBoardId}:${nextArchiveVersion}:${member.member_key}`;
          insertNotif.run(
            dedupeKey,
            validBoardId,
            member.member_key,
            JSON.stringify(member.identity),
            nextStateVersion,
            payloadJson,
            ts,
            ts,
          );
        }
      }

      return { board: this.getBoard(validBoardId), file_op_id: fileOpId };
    });
  }

  restoreBoard({ boardId, actorKey, nowIso } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    requireText(actorKey, "actorKey", 1024);
    const ts = this.#nowIso(nowIso);

    return this.runInTransaction(() => {
      if (this.getTombstone(validBoardId)) {
        throw new CoreError("board_deleted_tombstone", "交流板已永久删除，无法恢复");
      }
      const board = this.getBoard(validBoardId);
      if (!board) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      if (board.status !== "archived") {
        throw new CoreError("board_not_archived", "仅已归档的交流板可恢复");
      }
      const nextStateVersion = board.state_version + 1;
      this.#database.prepare(`
        UPDATE boards
        SET status = 'active',
            state_version = ?,
            archive_reason = NULL,
            archived_at = NULL,
            dissolved_by_key = NULL,
            last_active_at = CASE WHEN ? > last_active_at THEN ? ELSE last_active_at END
        WHERE board_id = ?
      `).run(nextStateVersion, ts, ts, validBoardId);

      const fileOpId = randomUUID();
      this.#database.prepare(`
        INSERT INTO board_file_ops (
          op_id, board_id, op_kind, state_version, status, created_at, updated_at
        ) VALUES (?, ?, 'restore_from_archive', ?, 'pending', ?, ?)
      `).run(fileOpId, validBoardId, nextStateVersion, ts, ts);

      const cancelledNotifications = this.#database.prepare(`
        UPDATE board_notifications
        SET status = 'cancelled', updated_at = ?
        WHERE board_id = ? AND kind = 'dissolved' AND status = 'pending'
      `).run(ts, validBoardId).changes;

      return {
        board: this.getBoard(validBoardId),
        file_op_id: fileOpId,
        cancelled_notifications: cancelledNotifications,
      };
    });
  }

  deleteArchivedBoard({
    boardId,
    expectedArchiveVersion,
    expectedStateVersion = null,
    actorKey,
    peerMachines = [],
    nowIso,
  } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validExpectedArchive = requireInteger(expectedArchiveVersion, "expectedArchiveVersion", 1);
    const hasExpectedState = expectedStateVersion !== null && expectedStateVersion !== undefined;
    if (hasExpectedState) {
      requireInteger(expectedStateVersion, "expectedStateVersion", 1);
    }
    const validActorKey = requireText(actorKey, "actorKey", 1024);
    if (!Array.isArray(peerMachines)) {
      throw new CoreError("invalid_input", "peerMachines必须是数组");
    }
    const explicitPeers = peerMachines.map(machine => validateMachineId(machine, "peerMachines[]"));
    const ts = this.#nowIso(nowIso);

    return this.runInTransaction(() => {
      if (this.getTombstone(validBoardId)) {
        throw new CoreError("board_deleted_tombstone", "交流板已被永久删除");
      }
      const board = this.getBoard(validBoardId);
      if (!board) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      if (board.status !== "archived") {
        throw new CoreError("board_not_archived", "仅已归档的交流板允许永久删除");
      }
      if (board.archive_version !== validExpectedArchive) {
        throw new CoreError("board_version_mismatch", "归档版本号不匹配");
      }
      if (hasExpectedState && board.state_version !== expectedStateVersion) {
        throw new CoreError("board_version_mismatch", "状态版本号不匹配");
      }

      const finalStateVersion = board.state_version + 1;

      const peerSet = new Set(explicitPeers);
      for (const row of this.#database.prepare(
        "SELECT DISTINCT peer_machine_id FROM board_sync_state WHERE board_id = ?",
      ).all(validBoardId)) {
        peerSet.add(row.peer_machine_id);
      }
      for (const row of this.#database.prepare(
        "SELECT DISTINCT machine_id FROM board_members WHERE board_id = ?",
      ).all(validBoardId)) {
        peerSet.add(row.machine_id);
      }
      peerSet.delete(board.host_machine_id);

      this.#database.prepare(`
        INSERT INTO board_tombstones (
          board_id, host_machine_id, final_state_version, deleted_by_key, deleted_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(validBoardId, board.host_machine_id, finalStateVersion, validActorKey, ts);

      const insertTombstoneSync = this.#database.prepare(`
        INSERT INTO board_tombstone_sync (
          board_id, peer_machine_id, final_state_version, acked, next_retry_at
        ) VALUES (?, ?, ?, 0, 0)
        ON CONFLICT(board_id, peer_machine_id) DO UPDATE SET
          final_state_version = MAX(final_state_version, excluded.final_state_version),
          acked = 0,
          next_retry_at = 0
      `);
      for (const peer of peerSet) {
        insertTombstoneSync.run(validBoardId, peer, finalStateVersion);
      }

      const fileOpId = randomUUID();
      this.#database.prepare(`
        INSERT INTO board_file_ops (
          op_id, board_id, op_kind, state_version, status, created_at, updated_at
        ) VALUES (?, ?, 'purge_archived_dir', ?, 'pending', ?, ?)
      `).run(fileOpId, validBoardId, finalStateVersion, ts, ts);

      const cancelledNotifications = this.#database.prepare(`
        UPDATE board_notifications
        SET status = 'cancelled', updated_at = ?
        WHERE board_id = ? AND status = 'pending'
      `).run(ts, validBoardId).changes;

      this.#database.prepare(`
        UPDATE board_remote_outbox
        SET status = 'rejected_deleted', last_error_code = 'board_deleted_tombstone', updated_at = ?
        WHERE board_id = ? AND status IN ('pending', 'dispatching', 'unknown')
      `).run(ts, validBoardId);

      this.#database.prepare("DELETE FROM boards WHERE board_id = ?").run(validBoardId);

      return {
        tombstone: this.getTombstone(validBoardId),
        file_op_id: fileOpId,
        cancelled_notifications: cancelledNotifications,
      };
    });
  }

  applyRemoteTombstone({
    board_id,
    host_machine_id,
    final_state_version,
    deleted_by_key,
    deleted_at,
  } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(board_id);
    const validHostMachine = validateMachineId(host_machine_id, "host_machine_id");
    const validFinalStateVersion = requireInteger(final_state_version, "final_state_version", 1);
    const validDeletedByKey = (
      deleted_by_key === undefined
      || deleted_by_key === null
      || (typeof deleted_by_key === "string" && deleted_by_key.trim().length === 0)
    )
      ? "system:unknown"
      : requireText(deleted_by_key, "deleted_by_key", 1024);
    const validDeletedAt = validateIsoTimestamp(deleted_at, "deleted_at");
    const ts = this.#nowIso();

    return this.runInTransaction(() => {
      const existing = this.getTombstone(validBoardId);
      if (existing) {
        if (existing.host_machine_id !== validHostMachine) {
          throw new CoreError("board_host_mismatch", "远端墓碑建板机标识不匹配");
        }
        if (validFinalStateVersion > existing.final_state_version) {
          this.#database.prepare(`
            UPDATE board_tombstones SET final_state_version = ? WHERE board_id = ?
          `).run(validFinalStateVersion, validBoardId);
        }
        return {
          applied: false,
          tombstone: this.getTombstone(validBoardId),
          file_op_id: null,
        };
      }

      const localBoard = this.getBoard(validBoardId);
      if (localBoard && localBoard.host_machine_id !== validHostMachine) {
        throw new CoreError("board_host_mismatch", "远端墓碑建板机与本地记录不一致");
      }

      this.#database.prepare(`
        INSERT INTO board_tombstones (
          board_id, host_machine_id, final_state_version, deleted_by_key, deleted_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(validBoardId, validHostMachine, validFinalStateVersion, validDeletedByKey, validDeletedAt);

      const fileOpId = randomUUID();
      this.#database.prepare(`
        INSERT INTO board_file_ops (
          op_id, board_id, op_kind, state_version, status, created_at, updated_at
        ) VALUES (?, ?, 'purge_archived_dir', ?, 'pending', ?, ?)
      `).run(fileOpId, validBoardId, validFinalStateVersion, ts, ts);

      this.#database.prepare(`
        UPDATE board_notifications
        SET status = 'cancelled', updated_at = ?
        WHERE board_id = ? AND status = 'pending'
      `).run(ts, validBoardId);

      this.#database.prepare(`
        UPDATE board_remote_outbox
        SET status = 'rejected_deleted', last_error_code = 'board_deleted_tombstone', updated_at = ?
        WHERE board_id = ? AND status IN ('pending', 'dispatching', 'unknown')
      `).run(ts, validBoardId);

      if (localBoard) {
        this.#database.prepare("DELETE FROM boards WHERE board_id = ?").run(validBoardId);
      }

      return {
        applied: true,
        tombstone: this.getTombstone(validBoardId),
        file_op_id: fileOpId,
      };
    });
  }

  findInactiveBoardsForAutoArchive(localMachineId, nowMs = this.#now()) {
    this.#assertOpen();
    const validLocal = validateMachineId(localMachineId, "localMachineId");
    requireInteger(nowMs, "nowMs", 0);
    const minCutoffIso = new Date(nowMs - this.#limits.minAutoArchiveDays * 86400000).toISOString();
    const rows = this.#database.prepare(`
      SELECT * FROM boards
      WHERE status = 'active' AND last_active_at <= ?
      ORDER BY last_active_at ASC
    `).all(minCutoffIso);
    const results = [];
    for (const row of rows) {
      if (row.host_machine_id !== validLocal) continue;
      const board = decodeBoardRow(row);
      const lastActiveMs = Date.parse(board.last_active_at);
      if (Number.isFinite(lastActiveMs) && lastActiveMs <= nowMs - board.settings.auto_archive_days * 86400000) {
        results.push(board);
      }
    }
    return results;
  }

  // ==================== 同步状态、队列与通知 ====================

  getSyncState(boardId, peerMachineId) {
    this.#assertOpen();
    validateBoardId(boardId);
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    return decodeSyncStateRow(this.#database.prepare(
      "SELECT * FROM board_sync_state WHERE board_id = ? AND peer_machine_id = ?",
    ).get(boardId, validPeer));
  }

  advanceSyncState(
    boardId,
    peerMachineId,
    {
      acked_seq = 0,
      acked_state_version = 0,
      acked_meta_version = 0,
      notified_dissolve_version = 0,
      synced_at = null,
    } = {},
  ) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    requireInteger(acked_seq, "acked_seq", 0);
    requireInteger(acked_state_version, "acked_state_version", 0);
    requireInteger(acked_meta_version, "acked_meta_version", 0);
    requireInteger(notified_dissolve_version, "notified_dissolve_version", 0);
    const validSyncedAt = synced_at !== null && synced_at !== undefined
      ? validateIsoTimestamp(synced_at, "synced_at")
      : null;

    return this.runInTransaction(() => {
      if (!this.getBoard(validBoardId)) {
        throw new CoreError("board_not_found", "交流板不存在");
      }
      this.#database.prepare(`
        INSERT INTO board_sync_state (
          board_id, peer_machine_id, last_acked_seq, last_acked_state_version,
          last_acked_meta_version, last_notified_dissolve_version, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(board_id, peer_machine_id) DO UPDATE SET
          last_acked_seq = MAX(last_acked_seq, excluded.last_acked_seq),
          last_acked_state_version = MAX(last_acked_state_version, excluded.last_acked_state_version),
          last_acked_meta_version = MAX(last_acked_meta_version, excluded.last_acked_meta_version),
          last_notified_dissolve_version = MAX(last_notified_dissolve_version, excluded.last_notified_dissolve_version),
          last_synced_at = COALESCE(excluded.last_synced_at, last_synced_at)
      `).run(
        validBoardId,
        validPeer,
        acked_seq,
        acked_state_version,
        acked_meta_version,
        notified_dissolve_version,
        validSyncedAt,
      );
      return this.getSyncState(validBoardId, validPeer);
    });
  }

  listBoardsNeedingSyncForPeer(localMachineId, peerMachineId) {
    this.#assertOpen();
    const validLocal = validateMachineId(localMachineId, "localMachineId");
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");

    // 先经由 idx_board_members_machine 覆盖索引定位该 peer 参与的板子，绝不触发 boards 全表扫描
    const memberRows = this.#database.prepare(`
      SELECT board_id, subscription_state
      FROM board_members
      WHERE machine_id = ?
    `).all(validPeer);

    const activeByBoard = new Map();
    for (const row of memberRows) {
      const prev = activeByBoard.get(row.board_id) ?? false;
      activeByBoard.set(row.board_id, prev || row.subscription_state === "active");
    }

    const sortedBoardIds = [...activeByBoard.keys()].sort();
    const results = [];
    for (const boardId of sortedBoardIds) {
      const hasActiveMember = activeByBoard.get(boardId);
      const board = this.getBoard(boardId);
      if (!board || board.host_machine_id !== validLocal) continue;
      const syncState = this.getSyncState(boardId, validPeer);
      if (!hasActiveMember && !syncState) continue;

      const lastAckedSeq = syncState?.last_acked_seq ?? 0;
      const lastAckedStateVersion = syncState?.last_acked_state_version ?? 0;
      const lastAckedMetaVersion = syncState?.last_acked_meta_version ?? 0;
      const lastNotifiedDissolveVersion = syncState?.last_notified_dissolve_version ?? 0;

      const needsPosts = hasActiveMember && board.status === "active" && board.board_seq > lastAckedSeq;
      const needsState = hasActiveMember && board.state_version > lastAckedStateVersion;
      const needsMeta = board.meta_version > lastAckedMetaVersion;
      const needsDissolve = hasActiveMember
        && board.status === "archived"
        && board.archive_reason === "manual_dissolve"
        && board.archive_version > lastNotifiedDissolveVersion;

      if (needsPosts || needsState || needsMeta || needsDissolve) {
        results.push({
          ...board,
          has_active_peer_member: hasActiveMember,
          unsubscribe_sync_only: !hasActiveMember,
          sync_state: {
            board_id: boardId,
            peer_machine_id: validPeer,
            last_acked_seq: lastAckedSeq,
            last_acked_state_version: lastAckedStateVersion,
            last_acked_meta_version: lastAckedMetaVersion,
            last_notified_dissolve_version: lastNotifiedDissolveVersion,
            last_synced_at: syncState?.last_synced_at ?? null,
          },
        });
      }
    }
    return results;
  }

  recoverInterruptedSyncState({ sendingLeaseMs = 0, nowMs = this.#now() } = {}) {
    this.#assertOpen();
    const validLeaseMs = requireInteger(sendingLeaseMs, "sendingLeaseMs", 0);
    const validNowMs = requireInteger(nowMs, "nowMs", 0);
    const ts = new Date(validNowMs).toISOString();

    return this.runInTransaction(() => {
      const recoveredOutbox = this.#database.prepare(`
        UPDATE board_remote_outbox
        SET status = 'unknown', next_retry_at = ?, updated_at = ?
        WHERE status = 'dispatching'
      `).run(validNowMs, ts).changes;

      let recoveredFiles;
      if (validLeaseMs === 0) {
        recoveredFiles = this.#database.prepare(`
          UPDATE board_file_sync_queue
          SET status = 'pending', next_retry_at = ?, updated_at = ?
          WHERE status = 'sending'
        `).run(validNowMs, ts).changes;
      } else {
        const leaseCutoffIso = new Date(Math.max(0, validNowMs - validLeaseMs)).toISOString();
        recoveredFiles = this.#database.prepare(`
          UPDATE board_file_sync_queue
          SET status = 'pending', next_retry_at = ?, updated_at = ?
          WHERE status = 'sending'
            AND (
              (next_retry_at > 0 AND next_retry_at <= ?)
              OR (next_retry_at = 0 AND updated_at <= ?)
            )
        `).run(validNowMs, ts, validNowMs, leaseCutoffIso).changes;
      }

      return {
        recovered_outbox: recoveredOutbox,
        recovered_files: recoveredFiles,
      };
    });
  }

  getFileSyncItem(boardId, fileId, peerMachineId) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validFileId = validateSafeId(fileId, "file_id");
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    return decodeFileSyncRow(this.#database.prepare(`
      SELECT * FROM board_file_sync_queue
      WHERE board_id = ? AND file_id = ? AND peer_machine_id = ?
    `).get(validBoardId, validFileId, validPeer));
  }

  listDueFileSyncItems(peerMachineId, nowMs = this.#now(), limit = 63) {
    this.#assertOpen();
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    requireInteger(nowMs, "nowMs", 0);
    requireInteger(limit, "limit", 1, 256);
    return this.#database.prepare(`
      SELECT * FROM board_file_sync_queue
      WHERE status IN ('pending', 'sending')
        AND peer_machine_id = ?
        AND next_retry_at <= ?
        AND (status = 'pending' OR next_retry_at > 0)
      ORDER BY next_retry_at ASC, seq ASC
      LIMIT ?
    `).all(validPeer, nowMs, limit).map(decodeFileSyncRow);
  }

  updateFileSyncItemStatus(
    boardId,
    fileId,
    peerMachineId,
    { status, retry_count, next_retry_at, last_error, nowIso } = {},
  ) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validFileId = validateSafeId(fileId, "file_id");
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    if (!FILE_SYNC_STATUSES.has(status)) {
      throw new CoreError("invalid_input", "文件同步状态无效");
    }
    const ts = this.#nowIso(nowIso);
    return this.runInTransaction(() => {
      const existing = this.#database.prepare(`
        SELECT * FROM board_file_sync_queue
        WHERE board_id = ? AND file_id = ? AND peer_machine_id = ?
      `).get(validBoardId, validFileId, validPeer);
      if (!existing) return null;
      const nextRetryCount = retry_count !== undefined
        ? requireInteger(retry_count, "retry_count", 0)
        : existing.retry_count;
      const nextRetryAt = next_retry_at !== undefined
        ? requireInteger(next_retry_at, "next_retry_at", 0)
        : existing.next_retry_at;
      const nextLastError = last_error !== undefined
        ? (last_error === null ? null : requireText(String(last_error), "last_error", 1024))
        : existing.last_error;
      this.#database.prepare(`
        UPDATE board_file_sync_queue
        SET status = ?, retry_count = ?, next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE board_id = ? AND file_id = ? AND peer_machine_id = ?
      `).run(status, nextRetryCount, nextRetryAt, nextLastError, ts, validBoardId, validFileId, validPeer);
      return decodeFileSyncRow(this.#database.prepare(`
        SELECT * FROM board_file_sync_queue
        WHERE board_id = ? AND file_id = ? AND peer_machine_id = ?
      `).get(validBoardId, validFileId, validPeer));
    });
  }

  listPendingTombstoneSyncs(peerMachineId, nowMs = this.#now(), limit = 64) {
    this.#assertOpen();
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    requireInteger(nowMs, "nowMs", 0);
    requireInteger(limit, "limit", 1, 256);
    return this.#database.prepare(`
      SELECT ts.board_id, ts.peer_machine_id, ts.final_state_version, ts.acked, ts.next_retry_at,
             t.host_machine_id, t.deleted_by_key, t.deleted_at
      FROM board_tombstone_sync ts
      JOIN board_tombstones t ON t.board_id = ts.board_id
      WHERE ts.peer_machine_id = ? AND ts.acked = 0 AND ts.next_retry_at <= ?
      ORDER BY ts.next_retry_at ASC, ts.board_id ASC
      LIMIT ?
    `).all(validPeer, nowMs, limit).map(row => ({
      board_id: row.board_id,
      peer_machine_id: row.peer_machine_id,
      host_machine_id: row.host_machine_id,
      final_state_version: row.final_state_version,
      deleted_by_key: row.deleted_by_key,
      deleted_at: row.deleted_at,
      acked: row.acked === 1,
      next_retry_at: row.next_retry_at,
    }));
  }

  ackTombstoneSync(boardId, peerMachineId, finalStateVersion) {
    this.#assertOpen();
    validateBoardId(boardId);
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    requireInteger(finalStateVersion, "finalStateVersion", 1);
    const result = this.#database.prepare(`
      UPDATE board_tombstone_sync
      SET acked = 1
      WHERE board_id = ? AND peer_machine_id = ? AND final_state_version <= ?
    `).run(boardId, validPeer, finalStateVersion);
    return result.changes > 0;
  }

  updateTombstoneSyncBackoff(boardId, peerMachineId, { next_retry_at } = {}) {
    this.#assertOpen();
    const validBoardId = validateBoardId(boardId);
    const validPeer = validateMachineId(peerMachineId, "peerMachineId");
    const validNextRetryAt = requireInteger(next_retry_at, "next_retry_at", 0);
    const result = this.#database.prepare(`
      UPDATE board_tombstone_sync
      SET next_retry_at = ?
      WHERE board_id = ? AND peer_machine_id = ? AND acked = 0
    `).run(validNextRetryAt, validBoardId, validPeer);
    return result.changes > 0;
  }

  getRemoteOutbox(localPostId) {
    this.#assertOpen();
    const validLocalPostId = validateSafeId(localPostId, "local_post_id");
    return decodeOutboxRow(this.#database.prepare(
      "SELECT * FROM board_remote_outbox WHERE local_post_id = ?",
    ).get(validLocalPostId));
  }

  enqueueRemoteOutbox({
    local_post_id,
    dedupe_key,
    board_id,
    host_machine_id,
    author_key,
    op_kind,
    payload_json,
    nowIso,
  } = {}) {
    this.#assertOpen();
    const validLocalPostId = validateSafeId(local_post_id, "local_post_id");
    const validDedupeKey = requireText(dedupe_key, "dedupe_key", 256);
    const validBoardId = validateBoardId(board_id);
    const validHostMachine = validateMachineId(host_machine_id, "host_machine_id");
    const validAuthorKey = requireText(author_key, "author_key", 1024);
    const validOpKind = requireText(op_kind, "op_kind", 64);
    const normalizedPayload = normalizeJsonText(payload_json, "payload_json");
    const ts = this.#nowIso(nowIso);

    return this.runInTransaction(() => {
      const existingByDedupe = this.#database.prepare(
        "SELECT * FROM board_remote_outbox WHERE dedupe_key = ?",
      ).get(validDedupeKey);
      if (existingByDedupe) {
        if (existingByDedupe.payload_json !== normalizedPayload) {
          throw new CoreError("dedupe_conflict", "同一outbox去重键已存在不同负载");
        }
        return decodeOutboxRow(existingByDedupe);
      }

      const countRow = this.#database.prepare("SELECT count(*) AS total FROM board_remote_outbox").get();
      if (countRow.total >= this.#limits.maxOutboxEntries) {
        const pruneCutoff = new Date(this.#now() - this.#limits.doneFileOpRetentionMs).toISOString();
        this.#database.prepare(`
          DELETE FROM board_remote_outbox
          WHERE status IN ('acked', 'rejected_archived', 'rejected_deleted', 'dead_letter')
            AND updated_at <= ?
        `).run(pruneCutoff);
        const afterPrune = this.#database.prepare("SELECT count(*) AS total FROM board_remote_outbox").get().total;
        if (afterPrune >= this.#limits.maxOutboxEntries) {
          throw new CoreError("board_outbox_full", `客机离线写队列已达上限(${this.#limits.maxOutboxEntries})`);
        }
      }

      this.#database.prepare(`
        INSERT INTO board_remote_outbox (
          local_post_id, dedupe_key, board_id, host_machine_id, author_key,
          op_kind, payload_json, status, retry_count, next_retry_at, last_error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?)
      `).run(
        validLocalPostId,
        validDedupeKey,
        validBoardId,
        validHostMachine,
        validAuthorKey,
        validOpKind,
        normalizedPayload,
        ts,
        ts,
      );
      return decodeOutboxRow(this.#database.prepare(
        "SELECT * FROM board_remote_outbox WHERE local_post_id = ?",
      ).get(validLocalPostId));
    });
  }

  listDueRemoteOutbox(hostMachineId, nowMs = this.#now(), limit = 32) {
    this.#assertOpen();
    const validHost = validateMachineId(hostMachineId, "hostMachineId");
    requireInteger(nowMs, "nowMs", 0);
    requireInteger(limit, "limit", 1, 256);
    return this.#database.prepare(`
      SELECT * FROM board_remote_outbox
      WHERE status IN ('pending', 'unknown') AND host_machine_id = ? AND next_retry_at <= ?
      ORDER BY next_retry_at ASC, created_at ASC
      LIMIT ?
    `).all(validHost, nowMs, limit).map(decodeOutboxRow);
  }

  claimRemoteOutbox(localPostId, nowIso) {
    this.#assertOpen();
    const validLocalPostId = validateSafeId(localPostId, "local_post_id");
    const ts = this.#nowIso(nowIso);
    const row = this.#database.prepare(`
      UPDATE board_remote_outbox
      SET status = 'dispatching', updated_at = ?
      WHERE local_post_id = ? AND status IN ('pending', 'unknown')
      RETURNING *
    `).get(ts, validLocalPostId);
    return decodeOutboxRow(row);
  }

  updateRemoteOutboxStatus(
    localPostId,
    { status, retry_count, next_retry_at, last_error_code, nowIso } = {},
  ) {
    this.#assertOpen();
    const validLocalPostId = validateSafeId(localPostId, "local_post_id");
    if (!OUTBOX_STATUSES.has(status)) {
      throw new CoreError("invalid_input", "outbox状态无效");
    }
    const ts = this.#nowIso(nowIso);
    const updated = this.runInTransaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM board_remote_outbox WHERE local_post_id = ?",
      ).get(validLocalPostId);
      if (!existing) return null;
      const nextRetryCount = retry_count !== undefined
        ? requireInteger(retry_count, "retry_count", 0)
        : existing.retry_count;
      const nextRetryAt = next_retry_at !== undefined
        ? requireInteger(next_retry_at, "next_retry_at", 0)
        : existing.next_retry_at;
      const nextErr = last_error_code !== undefined
        ? (last_error_code === null ? null : requireText(String(last_error_code), "last_error_code", 128))
        : existing.last_error_code;
      this.#database.prepare(`
        UPDATE board_remote_outbox
        SET status = ?, retry_count = ?, next_retry_at = ?, last_error_code = ?, updated_at = ?
        WHERE local_post_id = ?
      `).run(status, nextRetryCount, nextRetryAt, nextErr, ts, validLocalPostId);
      return decodeOutboxRow(this.#database.prepare(
        "SELECT * FROM board_remote_outbox WHERE local_post_id = ?",
      ).get(validLocalPostId));
    });
    if (updated && TERMINAL_OUTBOX_STATUSES.has(status)) {
      try {
        this.cleanupOutboxDir(validLocalPostId);
      } catch {
        // 文件系统短暂占用时留待 reconcilePendingFileOps 补偿清理
      }
    }
    return updated;
  }

  enqueueNotification({
    dedupe_key,
    board_id,
    member_key,
    member_json,
    kind,
    state_version = 0,
    payload_json,
    nowIso,
  } = {}) {
    this.#assertOpen();
    const validDedupeKey = requireText(dedupe_key, "dedupe_key", 512);
    const validBoardId = validateBoardId(board_id);
    const validMemberKey = requireText(member_key, "member_key", 1024);
    const normalizedMemberJson = normalizeJsonText(member_json, "member_json");
    if (!NOTIFICATION_KINDS.has(kind)) {
      throw new CoreError("invalid_input", "通知kind无效");
    }
    const validStateVersion = requireInteger(state_version, "state_version", 0);
    const normalizedPayloadJson = normalizeJsonText(payload_json, "payload_json");
    const ts = this.#nowIso(nowIso);

    const res = this.#database.prepare(`
      INSERT OR IGNORE INTO board_notifications (
        dedupe_key, board_id, member_key, member_json, kind, state_version,
        payload_json, status, retry_count, next_retry_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
    `).run(
      validDedupeKey,
      validBoardId,
      validMemberKey,
      normalizedMemberJson,
      kind,
      validStateVersion,
      normalizedPayloadJson,
      ts,
      ts,
    );
    const notification = decodeNotificationRow(this.#database.prepare(
      "SELECT * FROM board_notifications WHERE dedupe_key = ?",
    ).get(validDedupeKey));
    return { enqueued: res.changes === 1, notification };
  }

  listDueNotifications(nowMs = this.#now(), limit = 64) {
    this.#assertOpen();
    requireInteger(nowMs, "nowMs", 0);
    requireInteger(limit, "limit", 1, 256);
    return this.#database.prepare(`
      SELECT * FROM board_notifications
      WHERE status = 'pending' AND next_retry_at <= ?
      ORDER BY next_retry_at ASC, created_at ASC
      LIMIT ?
    `).all(nowMs, limit).map(decodeNotificationRow);
  }

  markNotificationStatus(dedupeKey, { status, retry_count, next_retry_at, nowIso } = {}) {
    this.#assertOpen();
    const validKey = requireText(dedupeKey, "dedupe_key", 512);
    if (!NOTIFICATION_STATUSES.has(status)) {
      throw new CoreError("invalid_input", "通知status无效");
    }
    const ts = this.#nowIso(nowIso);
    return this.runInTransaction(() => {
      const existing = this.#database.prepare(
        "SELECT * FROM board_notifications WHERE dedupe_key = ?",
      ).get(validKey);
      if (!existing) return null;
      const nextRetryCount = retry_count !== undefined
        ? requireInteger(retry_count, "retry_count", 0)
        : existing.retry_count;
      const nextRetryAt = next_retry_at !== undefined
        ? requireInteger(next_retry_at, "next_retry_at", 0)
        : existing.next_retry_at;
      this.#database.prepare(`
        UPDATE board_notifications
        SET status = ?, retry_count = ?, next_retry_at = ?, updated_at = ?
        WHERE dedupe_key = ?
      `).run(status, nextRetryCount, nextRetryAt, ts, validKey);
      return decodeNotificationRow(this.#database.prepare(
        "SELECT * FROM board_notifications WHERE dedupe_key = ?",
      ).get(validKey));
    });
  }
}
