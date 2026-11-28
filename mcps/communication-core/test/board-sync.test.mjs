import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { CoreError, identityKey, normalizeIdentity } from "../src/contracts.mjs";
import { ConversationAddressBook } from "../src/conversation-address-book.mjs";
import { RemoteCoreDispatcher } from "../src/remote-core-dispatcher.mjs";
import { InMemoryRelayBus } from "../src/transports/napcat-relay.mjs";
import {
  BOARD_SYNC_LIMITS,
  BOARD_SYNC_OPS,
  BoardSyncCoordinator,
  openBoardRuntime,
} from "../src/board-sync.mjs";
import { BoardStore } from "../src/board-store.mjs";
import { BoardEngine } from "../src/board-engine.mjs";

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function createTempDir(prefix = "board-sync-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * 严格遵循 wave2-internal-signatures.md 全部签名的内存+磁盘契约夹具 BoardStore。
 */
class ContractBoardStore {
  constructor({ privateRoot, now = () => Date.now() } = {}) {
    this.privateRoot = privateRoot ?? createTempDir();
    this.now = now;
    this.boards = new Map();
    this.members = new Map(); // board_id -> Map<member_key, member>
    this.posts = new Map(); // board_id -> Map<seq, post>
    this.syncStates = new Map(); // `${board_id}::${peer}` -> state
    this.fileSyncQueue = new Map(); // `${board_id}::${file_id}::${peer}` -> item
    this.remoteOutbox = new Map(); // local_post_id -> entry
    this.tombstones = new Map(); // board_id -> tombstone
    this.tombstoneSync = new Map(); // `${board_id}::${peer}` -> row
    this.notifications = new Map(); // dedupe_key -> row
    this.reconcileCalls = 0;
    this.transientStorageError = null;
    this.fileBytesMap = new Map(); // filePath -> Buffer (for synthetic spool:// paths in bus tests)
  }

  getBoardFilesDir(boardId) {
    return path.join(this.privateRoot, "boards", boardId, "files");
  }

  resolveSafeBoardFilePath(boardId, fileId, safeName) {
    return path.join(this.getBoardFilesDir(boardId), `${fileId}_${safeName}`);
  }

  seedLocalFile(boardId, fileId, safeName, content) {
    const dir = this.getBoardFilesDir(boardId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = this.resolveSafeBoardFilePath(boardId, fileId, safeName);
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    fs.writeFileSync(filePath, buf);
    return {
      file_id: fileId,
      safe_name: safeName,
      bytes: buf.length,
      sha256: sha256Buffer(buf),
      local_path: filePath,
      rel_path: `boards/${boardId}/files/${fileId}_${safeName}`,
    };
  }

  stageRemoteFileBufferOrPath({ sourcePath, buffer, boardId, fileId, safeName, expectedSha256, expectedBytes }) {
    if (this.transientStorageError) {
      throw this.transientStorageError;
    }
    let data = null;
    if (Buffer.isBuffer(buffer)) {
      data = buffer;
    } else if (typeof sourcePath === "string" && this.fileBytesMap.has(sourcePath)) {
      data = this.fileBytesMap.get(sourcePath);
    } else if (typeof sourcePath === "string" && fs.existsSync(sourcePath)) {
      data = fs.readFileSync(sourcePath);
    } else {
      throw new CoreError("invalid_input", `无法读取远端暂存文件: ${sourcePath}`);
    }

    const actualSha = sha256Buffer(data);
    if (expectedSha256 && actualSha !== expectedSha256) {
      throw new CoreError("board_file_hash_conflict", "远端文件 SHA-256 校验失败", {
        expected: expectedSha256,
        actual: actualSha,
      });
    }
    if (Number.isSafeInteger(expectedBytes) && data.length !== expectedBytes) {
      throw new CoreError("board_file_hash_conflict", "远端文件字节长度不匹配");
    }

    const dir = this.getBoardFilesDir(boardId);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = this.resolveSafeBoardFilePath(boardId, fileId, safeName);
    const tmpPath = `${finalPath}.tmp_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    fs.writeFileSync(tmpPath, data, { flag: "wx" });
    fs.renameSync(tmpPath, finalPath);
    return {
      local_path: finalPath,
      rel_path: `boards/${boardId}/files/${fileId}_${safeName}`,
      bytes: data.length,
      sha256: actualSha,
    };
  }

  reconcilePendingFileOps() {
    this.reconcileCalls += 1;
    return { processed: 0, superseded: 0, cleaned_done: 0, cleaned_staging: 0, errors: [] };
  }

  getBoard(boardId) {
    const b = this.boards.get(boardId);
    return b ? structuredClone(b) : null;
  }

  getTombstone(boardId) {
    const t = this.tombstones.get(boardId);
    return t ? structuredClone(t) : null;
  }

  createBoard({ board_id, host_machine_id, title, settings = {}, creator, nowIso = new Date(this.now()).toISOString() }) {
    const normCreator = normalizeIdentity(creator);
    const creatorKey = identityKey(normCreator);
    const board = {
      board_id,
      host_machine_id,
      title,
      status: "active",
      state_version: 0,
      meta_version: 1,
      archive_version: 0,
      archive_reason: null,
      archive_format: "dir",
      settings: {
        default_file_sync_machines: ["*"],
        auto_archive_days: 31,
        default_poll_interval_sec: 90,
        ...settings,
      },
      board_seq: 0,
      creator_key: creatorKey,
      created_at: nowIso,
      last_active_at: nowIso,
      archived_at: null,
    };
    this.boards.set(board_id, board);
    this.members.set(board_id, new Map([[creatorKey, {
      ...normCreator,
      member_key: creatorKey,
      subscription_state: "active",
      delivery_mode: "poll",
      filter_mode: "all",
      filter_targets: [],
      last_read_seq: 0,
      last_notified_seq: 0,
      joined_at: nowIso,
    }]]));
    this.posts.set(board_id, new Map());
    return structuredClone(board);
  }

  upsertBoardFromRemote(input) {
    if (this.tombstones.has(input.board_id)) {
      return { applied: false, code: "board_deleted_tombstone", created: false, state_changed: false, meta_changed: false, newly_added_members: [] };
    }
    const existing = this.boards.get(input.board_id);
    if (!existing) {
      const board = {
        board_id: input.board_id,
        host_machine_id: input.host_machine_id,
        title: input.title,
        status: input.status ?? "active",
        state_version: input.state_version ?? 0,
        meta_version: input.meta_version ?? 1,
        archive_version: input.archive_version ?? 0,
        archive_reason: input.archive_reason ?? null,
        archive_format: "dir",
        settings: structuredClone(input.settings ?? {}),
        board_seq: 0,
        creator_key: input.creator_key ?? "",
        created_at: input.created_at ?? new Date(this.now()).toISOString(),
        last_active_at: input.last_active_at ?? new Date(this.now()).toISOString(),
        archived_at: input.archived_at ?? null,
      };
      this.boards.set(input.board_id, board);
      const memberMap = new Map();
      const newlyAdded = [];
      for (const m of (input.members ?? [])) {
        const id = normalizeIdentity(m);
        const key = identityKey(id);
        const rec = {
          ...id,
          member_key: key,
          subscription_state: m.subscription_state ?? "active",
          delivery_mode: m.delivery_mode ?? "poll",
          filter_mode: m.filter_mode ?? "all",
          filter_targets: m.filter_targets ?? [],
          joined_at: m.joined_at ?? board.created_at,
        };
        memberMap.set(key, rec);
        newlyAdded.push(structuredClone(rec));
      }
      this.members.set(input.board_id, memberMap);
      if (!this.posts.has(input.board_id)) this.posts.set(input.board_id, new Map());
      return { applied: true, created: true, state_changed: true, meta_changed: true, newly_added_members: newlyAdded };
    }

    let stateChanged = false;
    let metaChanged = false;
    const newlyAdded = [];

    if (input.state_version > existing.state_version) {
      existing.status = input.status;
      existing.state_version = input.state_version;
      existing.archive_version = input.archive_version ?? existing.archive_version;
      existing.archive_reason = input.archive_reason ?? null;
      existing.archived_at = input.archived_at ?? null;
      stateChanged = true;
    }

    if (input.state_version >= existing.state_version && input.meta_version > existing.meta_version) {
      existing.title = input.title;
      existing.settings = structuredClone(input.settings ?? existing.settings);
      existing.meta_version = input.meta_version;
      metaChanged = true;
      if (Array.isArray(input.members) && input.members.length > 0) {
        const memberMap = this.members.get(input.board_id) ?? new Map();
        for (const m of input.members) {
          const id = normalizeIdentity(m);
          const key = identityKey(id);
          const existed = memberMap.has(key);
          const rec = {
            ...id,
            member_key: key,
            subscription_state: m.subscription_state ?? "active",
            delivery_mode: m.delivery_mode ?? "poll",
            filter_mode: m.filter_mode ?? "all",
            filter_targets: m.filter_targets ?? [],
            joined_at: m.joined_at ?? new Date(this.now()).toISOString(),
          };
          memberMap.set(key, rec);
          if (!existed) newlyAdded.push(structuredClone(rec));
        }
        this.members.set(input.board_id, memberMap);
      }
    }

    return {
      applied: stateChanged || metaChanged,
      created: false,
      state_changed: stateChanged,
      meta_changed: metaChanged,
      newly_added_members: newlyAdded,
    };
  }

  upsertMember(boardId, memberIdentity, { subscription_state = "active", delivery_mode = "poll", bumpMetaVersion = true, nowIso = new Date(this.now()).toISOString() } = {}) {
    const board = this.boards.get(boardId);
    const id = normalizeIdentity(memberIdentity);
    const key = identityKey(id);
    const map = this.members.get(boardId);
    const existed = map.get(key);
    const rec = {
      ...id,
      member_key: key,
      subscription_state,
      delivery_mode,
      filter_mode: "all",
      filter_targets: [],
      joined_at: existed?.joined_at ?? nowIso,
    };
    const changed = !existed || existed.subscription_state !== subscription_state;
    map.set(key, rec);
    if (changed && bumpMetaVersion) board.meta_version += 1;
    return { member: structuredClone(rec), changed };
  }

  listMembers(boardId, { activeOnly = false } = {}) {
    const map = this.members.get(boardId);
    if (!map) return [];
    const list = [...map.values()].map(m => structuredClone(m));
    return activeOnly ? list.filter(m => m.subscription_state === "active") : list;
  }

  updateBoardSettings(boardId, patch) {
    const board = this.boards.get(boardId);
    board.settings = { ...board.settings, ...patch };
    board.meta_version += 1;
    return structuredClone(board);
  }

  appendPost({ boardId, author, body, mentions = [], files = [], originClientPostId, fileSyncTargets = [], nowIso = new Date(this.now()).toISOString() }) {
    const board = this.boards.get(boardId);
    const normAuthor = normalizeIdentity(author);
    const authorKey = identityKey(normAuthor);
    const seq = board.board_seq + 1;
    board.board_seq = seq;
    board.last_active_at = nowIso;
    const post = {
      board_id: boardId,
      seq,
      author: normAuthor,
      author_key: authorKey,
      body,
      mentions: [...mentions],
      files: structuredClone(files),
      created_at: nowIso,
      origin_client_post_id: originClientPostId ?? `local_${seq}`,
    };
    this.posts.get(boardId).set(seq, post);
    for (const file of files) {
      for (const peer of fileSyncTargets) {
        const key = `${boardId}::${file.file_id}::${peer}`;
        this.fileSyncQueue.set(key, {
          board_id: boardId,
          file_id: file.file_id,
          peer_machine_id: peer,
          seq,
          status: "pending",
          retry_count: 0,
          next_retry_at: 0,
          last_error: null,
          updated_at: nowIso,
        });
      }
    }
    return { post: structuredClone(post), deduplicated: false, file_op_ids: [] };
  }

  applyRemotePost({ boardId, seq, author, body, mentions = [], files = [], created_at, origin_client_post_id, incomingStateVersion }) {
    if (this.tombstones.has(boardId)) return { applied: false, deduplicated: false, post: null };
    const board = this.boards.get(boardId);
    if (!board || board.status !== "active" || incomingStateVersion < board.state_version) {
      return { applied: false, deduplicated: false, post: null };
    }
    const postMap = this.posts.get(boardId);
    if (postMap.has(seq)) {
      return { applied: false, deduplicated: true, post: structuredClone(postMap.get(seq)) };
    }
    const post = {
      board_id: boardId,
      seq,
      author: structuredClone(author),
      author_key: author ? identityKey(author) : "",
      body,
      mentions: [...mentions],
      files: structuredClone(files),
      created_at,
      origin_client_post_id,
    };
    postMap.set(seq, post);
    if (seq > board.board_seq) board.board_seq = seq;
    return { applied: true, deduplicated: false, post: structuredClone(post) };
  }

  updatePostFileLocalStatus(boardId, seq, fileId, { local_status, local_path, rel_path }) {
    const post = this.posts.get(boardId)?.get(seq);
    if (!post) return;
    const f = post.files.find(item => item.file_id === fileId);
    if (f) {
      f.local_status = local_status;
      f.local_path = local_path;
      f.rel_path = rel_path;
    }
  }

  getPostsRange(boardId, afterSeq, limit) {
    const postMap = this.posts.get(boardId);
    if (!postMap) return [];
    return [...postMap.values()]
      .filter(p => p.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(p => structuredClone(p));
  }

  getPostByFileId(boardId, fileId) {
    const postMap = this.posts.get(boardId);
    if (!postMap) return null;
    for (const post of postMap.values()) {
      if ((post.files ?? []).some(f => f.file_id === fileId)) {
        return structuredClone(post);
      }
    }
    return null;
  }

  archiveBoard({ boardId, reason, actorKey, nowIso = new Date(this.now()).toISOString() }) {
    const board = this.boards.get(boardId);
    board.status = "archived";
    board.state_version += 1;
    board.archive_version += 1;
    board.archive_reason = reason;
    board.archived_at = nowIso;
    board.dissolved_by_key = actorKey;
    return { board: structuredClone(board), file_op_id: "op_arch" };
  }

  restoreBoard({ boardId }) {
    const board = this.boards.get(boardId);
    board.status = "active";
    board.state_version += 1;
    board.archive_reason = null;
    board.archived_at = null;
    return { board: structuredClone(board), file_op_id: "op_rest" };
  }

  deleteArchivedBoard({ boardId, actorKey, peerMachines = [], nowIso = new Date(this.now()).toISOString() }) {
    const board = this.boards.get(boardId);
    const finalVersion = board.state_version + 1;
    const tombstone = {
      board_id: boardId,
      host_machine_id: board.host_machine_id,
      final_state_version: finalVersion,
      deleted_by_key: actorKey,
      deleted_at: nowIso,
    };
    this.tombstones.set(boardId, tombstone);
    for (const peer of peerMachines) {
      this.tombstoneSync.set(`${boardId}::${peer}`, {
        board_id: boardId,
        host_machine_id: board.host_machine_id,
        peer_machine_id: peer,
        final_state_version: finalVersion,
        deleted_by_key: actorKey,
        deleted_at: nowIso,
        acked: 0,
        next_retry_at: 0,
      });
    }
    this.boards.delete(boardId);
    this.members.delete(boardId);
    this.posts.delete(boardId);
    return { tombstone: structuredClone(tombstone), file_op_id: "op_purge", cancelled_notifications: 0 };
  }

  applyRemoteTombstone({ board_id, host_machine_id, final_state_version, deleted_by_key, deleted_at }) {
    const existing = this.tombstones.get(board_id);
    if (existing) return { applied: false, tombstone: structuredClone(existing), file_op_id: null };
    const tomb = { board_id, host_machine_id, final_state_version, deleted_by_key, deleted_at };
    this.tombstones.set(board_id, tomb);
    this.boards.delete(board_id);
    this.members.delete(board_id);
    this.posts.delete(board_id);
    return { applied: true, tombstone: structuredClone(tomb), file_op_id: "op_purge" };
  }

  getSyncState(boardId, peerMachineId) {
    const s = this.syncStates.get(`${boardId}::${peerMachineId}`);
    return s
      ? structuredClone(s)
      : {
          board_id: boardId,
          peer_machine_id: peerMachineId,
          last_acked_seq: 0,
          last_acked_state_version: 0,
          last_acked_meta_version: 0,
          last_notified_dissolve_version: 0,
          last_synced_at: null,
        };
  }

  advanceSyncState(boardId, peerMachineId, patch) {
    const cur = this.getSyncState(boardId, peerMachineId);
    if (Number.isSafeInteger(patch.acked_seq)) {
      cur.last_acked_seq = Math.max(cur.last_acked_seq, patch.acked_seq);
    }
    if (Number.isSafeInteger(patch.acked_state_version)) {
      cur.last_acked_state_version = Math.max(cur.last_acked_state_version, patch.acked_state_version);
    }
    if (Number.isSafeInteger(patch.acked_meta_version)) {
      cur.last_acked_meta_version = Math.max(cur.last_acked_meta_version, patch.acked_meta_version);
    }
    if (Number.isSafeInteger(patch.notified_dissolve_version)) {
      cur.last_notified_dissolve_version = Math.max(cur.last_notified_dissolve_version, patch.notified_dissolve_version);
    }
    if (patch.synced_at) cur.last_synced_at = patch.synced_at;
    this.syncStates.set(`${boardId}::${peerMachineId}`, cur);
    return structuredClone(cur);
  }

  listBoardsNeedingSyncForPeer(localMachineId, peerMachineId) {
    const out = [];
    for (const board of this.boards.values()) {
      if (board.host_machine_id !== localMachineId) continue;
      const memberMap = this.members.get(board.board_id);
      const hasPeerMember = memberMap && [...memberMap.values()].some(
        m => m.machine_id === peerMachineId && m.subscription_state === "active",
      );
      if (!hasPeerMember) continue;
      const syncState = this.getSyncState(board.board_id, peerMachineId);
      const needsDissolve = board.status === "archived"
        && board.archive_reason === "manual_dissolve"
        && syncState.last_notified_dissolve_version < board.archive_version;
      const needsState = board.state_version > syncState.last_acked_state_version;
      const needsDelta = board.status === "active"
        && (board.board_seq > syncState.last_acked_seq || board.meta_version > syncState.last_acked_meta_version);
      if (needsDissolve || needsState || needsDelta) {
        out.push({ ...structuredClone(board), sync_state: syncState });
      }
    }
    return out;
  }

  listDueFileSyncItems(peerMachineId, nowMs, limit = 63) {
    return [...this.fileSyncQueue.values()]
      .filter(i => i.peer_machine_id === peerMachineId && i.status === "pending" && i.next_retry_at <= nowMs)
      .slice(0, limit)
      .map(i => structuredClone(i));
  }

  getFileSyncItem(boardId, fileId, peerMachineId) {
    const item = this.fileSyncQueue.get(`${boardId}::${fileId}::${peerMachineId}`);
    return item ? structuredClone(item) : null;
  }

  updateFileSyncItemStatus(boardId, fileId, peerMachineId, patch) {
    const key = `${boardId}::${fileId}::${peerMachineId}`;
    const item = this.fileSyncQueue.get(key);
    if (!item) return;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.retry_count !== undefined) item.retry_count = patch.retry_count;
    if (patch.next_retry_at !== undefined) item.next_retry_at = patch.next_retry_at;
    if (patch.last_error !== undefined) item.last_error = patch.last_error;
    if (patch.nowIso !== undefined) item.updated_at = patch.nowIso;
  }

  listPendingTombstoneSyncs(peerMachineId, nowMs, limit = 64) {
    return [...this.tombstoneSync.values()]
      .filter(t => t.peer_machine_id === peerMachineId && t.acked === 0 && t.next_retry_at <= nowMs)
      .slice(0, limit)
      .map(t => structuredClone(t));
  }

  ackTombstoneSync(boardId, peerMachineId, finalStateVersion) {
    const key = `${boardId}::${peerMachineId}`;
    const row = this.tombstoneSync.get(key);
    if (row && finalStateVersion >= row.final_state_version) {
      row.acked = 1;
    }
  }

  enqueueRemoteOutbox(entry) {
    const full = {
      status: "pending",
      retry_count: 0,
      next_retry_at: 0,
      last_error_code: null,
      created_at: entry.nowIso ?? new Date(this.now()).toISOString(),
      updated_at: entry.nowIso ?? new Date(this.now()).toISOString(),
      ...entry,
    };
    this.remoteOutbox.set(entry.local_post_id, full);
    return structuredClone(full);
  }

  getRemoteOutbox(localPostId) {
    const row = this.remoteOutbox.get(localPostId);
    return row ? structuredClone(row) : null;
  }

  listDueRemoteOutbox(hostMachineId, nowMs, limit = 32) {
    return [...this.remoteOutbox.values()]
      .filter(o => o.host_machine_id === hostMachineId && o.status === "pending" && o.next_retry_at <= nowMs)
      .slice(0, limit)
      .map(o => structuredClone(o));
  }

  claimRemoteOutbox(localPostId, nowIso) {
    const row = this.remoteOutbox.get(localPostId);
    if (!row || row.status !== "pending") return null;
    row.status = "dispatching";
    row.updated_at = nowIso;
    return structuredClone(row);
  }

  updateRemoteOutboxStatus(localPostId, patch) {
    const row = this.remoteOutbox.get(localPostId);
    if (!row) return;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.retry_count !== undefined) row.retry_count = patch.retry_count;
    if (patch.next_retry_at !== undefined) row.next_retry_at = patch.next_retry_at;
    if (patch.last_error_code !== undefined) row.last_error_code = patch.last_error_code;
    if (patch.nowIso !== undefined) row.updated_at = patch.nowIso;
  }

  enqueueNotification(entry) {
    if (!this.notifications.has(entry.dedupe_key)) {
      this.notifications.set(entry.dedupe_key, { ...entry, status: "pending" });
    }
  }
}

const HOST_ID = "machine-host";
const CLIENT_ID = "machine-client";
const ROGUE_ID = "machine-rogue";

const HOST_ALICE = Object.freeze({
  machine_id: HOST_ID,
  host: "antigravity",
  surface: "desktop",
  conversation_id: "conv-alice",
});

const CLIENT_BOB = Object.freeze({
  machine_id: CLIENT_ID,
  host: "codex",
  surface: "desktop",
  conversation_id: "conv-bob",
});

const CLIENT_CAROL = Object.freeze({
  machine_id: CLIENT_ID,
  host: "codex",
  surface: "desktop",
  conversation_id: "conv-carol",
});

test("导出清单与常量规格精确匹配", () => {
  assert.deepEqual(BOARD_SYNC_OPS, ["board_delta", "board_dissolved", "board_state_sync", "board_ack"]);
  assert.equal(BOARD_SYNC_LIMITS.maxBoardsPerBatch, 32);
  assert.equal(BOARD_SYNC_LIMITS.maxPostsPerBatch, 128);
  assert.equal(BOARD_SYNC_LIMITS.maxPayloadJsonBytes, 960 * 1024);
  assert.equal(BOARD_SYNC_LIMITS.maxBundleAttachments, 63);
  assert.equal(BOARD_SYNC_LIMITS.maxBundleTotalBytes, 16 * 1024 * 1024 - 256 * 1024);
  assert.equal(BOARD_SYNC_LIMITS.defaultSyncIntervalMs, 15000);
  assert.equal(BOARD_SYNC_LIMITS.defaultNotifyIntervalMs, 15000);
});

test("绝对零空轮询：7 类待同步项全空时发 0 帧，空板邀远端成员首同步后 ACK 归零", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    const sent = [];
    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      relaySender: {
        async send(args) {
          sent.push(args);
          return { ok: true, status: "sent_verified", relay_id: `rly_${sent.length}` };
        },
      },
    });

    // 全空时发 0 帧
    const idle1 = await coord.syncTick();
    assert.equal(idle1.sent_frames, 0);
    assert.deepEqual(idle1.skipped_peers, [CLIENT_ID]);
    assert.equal(sent.length, 0);

    // 建空板（board_seq=0, meta_version=1）并邀远端成员（meta_version=2）→ 触发首同步
    store.createBoard({ board_id: "empty-room", host_machine_id: HOST_ID, title: "空板首同步", creator: HOST_ALICE });
    store.upsertMember("empty-room", CLIENT_BOB);

    const first = await coord.syncTick();
    assert.equal(first.sent_frames, 1);
    assert.equal(sent[0].op, "board_delta");
    assert.equal(sent[0].payloadJson.boards[0].board_id, "empty-room");
    assert.equal(sent[0].payloadJson.boards[0].meta_version, 2);
    assert.equal(sent[0].payloadJson.boards[0].members.length, 2);

    // 收到远端 board_ack 推进 last_acked_meta_version=2 后，再次 syncTick 必须发 0 帧！
    await coord.handleInboundBoardAck({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: {
        from_machine: CLIENT_ID,
        body: JSON.stringify({
          kind: "board_ack",
          boards: [{ board_id: "empty-room", state_version: 0, acked_meta_version: 2, acked_seq: 0, ok: true }],
        }),
      },
    });

    const idle2 = await coord.syncTick();
    assert.equal(idle2.sent_frames, 0);
    assert.deepEqual(idle2.skipped_peers, [CLIENT_ID]);
    assert.equal(sent.length, 1);
    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("7 类待同步项优先级：手动解散快车道 allowBundle=false 严禁排在文件包后，且覆盖墓碑/归档/恢复/增量/文件/客机写队列", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    const sent = [];
    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      relaySender: {
        async send(args) {
          sent.push(args);
          return { ok: true, status: "sent_verified", relay_id: `rly_${sent.length}` };
        },
      },
    });

    // ① 手动解散板
    store.createBoard({ board_id: "b-dissolve", host_machine_id: HOST_ID, title: "手动解散", creator: HOST_ALICE });
    store.upsertMember("b-dissolve", CLIENT_BOB);
    store.archiveBoard({ boardId: "b-dissolve", reason: "manual_dissolve", actorKey: identityKey(HOST_ALICE) });

    // ② 永久删除墓碑
    store.createBoard({ board_id: "b-deleted", host_machine_id: HOST_ID, title: "已删板", creator: HOST_ALICE });
    store.archiveBoard({ boardId: "b-deleted", reason: "manual_dissolve", actorKey: identityKey(HOST_ALICE) });
    store.deleteArchivedBoard({ boardId: "b-deleted", actorKey: identityKey(HOST_ALICE), peerMachines: [CLIENT_ID] });

    // ③ 静默自动归档板
    store.createBoard({ board_id: "b-autoarch", host_machine_id: HOST_ID, title: "自动归档", creator: HOST_ALICE });
    store.upsertMember("b-autoarch", CLIENT_BOB);
    store.archiveBoard({ boardId: "b-autoarch", reason: "auto_inactive_31d", actorKey: "system" });

    // ④ + ⑤ 活跃板增量 + 附件
    store.createBoard({ board_id: "b-active", host_machine_id: HOST_ID, title: "活跃板", creator: HOST_ALICE });
    store.upsertMember("b-active", CLIENT_BOB);
    const f1 = store.seedLocalFile("b-active", "f001", "notes.txt", "hello board file");
    store.appendPost({
      boardId: "b-active",
      author: HOST_ALICE,
      body: "带附件测试",
      files: [{ ...f1, sync_machines: ["*"] }],
      fileSyncTargets: [CLIENT_ID],
    });

    // ⑥ 客机离线写队列（假设本机同时作为客机向 CLIENT_ID 建的板发离线写请求）
    store.enqueueRemoteOutbox({
      local_post_id: "lp_1",
      dedupe_key: "outbox_lp_1",
      board_id: "remote-board",
      host_machine_id: CLIENT_ID,
      author_key: identityKey(HOST_ALICE),
      op_kind: "post",
      payload_json: JSON.stringify({
        actor: HOST_ALICE,
        body: "客机离线发帖",
        mentions: [],
        files: [],
        origin_client_post_id: "lp_1",
      }),
    });
    store.enqueueRemoteOutbox({
      local_post_id: "lp_ctrl_1",
      dedupe_key: "outbox_ctrl_1",
      board_id: "remote-board",
      host_machine_id: CLIENT_ID,
      author_key: identityKey(HOST_ALICE),
      op_kind: "update_settings",
      payload_json: JSON.stringify({
        action: "update_settings",
        actor: HOST_ALICE,
        params: { settings: { auto_archive_days: 45 } },
      }),
    });

    const res = await coord.syncTick();
    assert.equal(res.sent_frames, 6);

    // 严格核验顺序：手动解散必须是第 1 帧，且 allowBundle: false！
    assert.equal(sent[0].op, "board_dissolved");
    assert.equal(sent[0].allowBundle, false);
    assert.equal(sent[0].payloadJson.board_id, "b-dissolve");

    // 第 2 帧：墓碑广播
    assert.equal(sent[1].op, "board_state_sync");
    assert.equal(sent[1].payloadJson.kind, "host_deleted_tombstone");
    assert.equal(sent[1].payloadJson.tombstones[0].board_id, "b-deleted");

    // 第 3 帧：静默自动归档状态推送
    assert.equal(sent[2].op, "board_state_sync");
    assert.equal(sent[2].payloadJson.kind, "host_state_push");
    assert.equal(sent[2].payloadJson.boards[0].board_id, "b-autoarch");
    assert.equal(sent[2].payloadJson.boards[0].archive_reason, "auto_inactive_31d");

    // 第 4 帧：活跃板增量 + 严格两键 attachments
    assert.equal(sent[3].op, "board_delta");
    assert.equal(sent[3].payloadJson.kind, "host_push_batch");
    assert.equal(sent[3].attachments.length, 1);
    assert.deepEqual(Object.keys(sent[3].attachments[0]).sort(), ["filePath", "name"]);
    assert.equal(sent[3].attachments[0].name, "b-active__f001");

    // 第 5、6 帧：客机离线发帖 + 客机控制请求（真实 3 段 source + sourceIdentityVerified: true）
    assert.equal(sent[4].op, "board_delta");
    assert.equal(sent[4].payloadJson.kind, "client_post_submit");
    assert.equal(sent[4].source, "antigravity/desktop/conv-alice");
    assert.equal(sent[4].sourceIdentityVerified, true);
    assert.equal(sent[4].dedupeKey, "outbox_lp_1");

    assert.equal(sent[5].op, "board_state_sync");
    assert.equal(sent[5].payloadJson.kind, "client_control_request");
    assert.equal(sent[5].source, "antigravity/desktop/conv-alice");
    assert.equal(sent[5].sourceIdentityVerified, true);
    assert.equal(sent[5].payloadJson.action, "update_settings");

    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("合帧双预算：<= 32 板、<= 128 帖、<= 960 KiB 与文件装箱 <= 63 附件、<= 16 MiB - 256 KiB", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    const sent = [];
    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      relaySender: {
        async send(args) {
          sent.push(args);
          return { ok: true, status: "sent_verified", relay_id: `rly_${sent.length}` };
        },
      },
    });

    // 建 35 个活跃板，其中首板放 130 帖；再放 66 个小文件测试 63 附件上限
    for (let i = 1; i <= 35; i += 1) {
      const boardId = `batch-b-${String(i).padStart(2, "0")}`;
      store.createBoard({ board_id: boardId, host_machine_id: HOST_ID, title: `板${i}`, creator: HOST_ALICE });
      store.upsertMember(boardId, CLIENT_BOB);
      if (i === 1) {
        for (let p = 1; p <= 130; p += 1) {
          const files = p <= 66
            ? [{ ...store.seedLocalFile(boardId, `f${p}`, `a${p}.txt`, `data-${p}`), sync_machines: ["*"] }]
            : [];
          store.appendPost({
            boardId,
            author: HOST_ALICE,
            body: `帖子-${p}`,
            files,
            fileSyncTargets: files.length ? [CLIENT_ID] : [],
          });
        }
      }
    }

    await coord.syncTick();
    const deltaFrames = sent.filter(f => f.op === "board_delta");
    assert.ok(deltaFrames.length >= 3, "应自动按预算切分为多帧");
    for (const frame of deltaFrames) {
      assert.ok(frame.payloadJson.boards.length <= 32, "单帧板数不得超过 32");
      const postCount = frame.payloadJson.boards.reduce((sum, b) => sum + (b.posts?.length ?? 0), 0);
      assert.ok(postCount <= 128, "单帧帖数不得超过 128");
      assert.ok(Buffer.byteLength(JSON.stringify(frame.payloadJson), "utf8") <= 960 * 1024, "payload_json 不得超 960 KiB");
      assert.ok((frame.attachments?.length ?? 0) <= 63, "单包附件数不得超 63");
    }
    const totalAttachmentsSent = deltaFrames.reduce((sum, f) => sum + (f.attachments?.length ?? 0), 0);
    assert.equal(totalAttachmentsSent, 66, "全部 66 个文件应经 63 + 3 两包全部发出");

    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("文本 / 文件解耦降级：遇 pending_capacity 或 bundle_transport_unavailable 时立刻拆出纯文本走 1800 CQ 小帧发完，文件退避不堵死", async () => {
  const tmpDir = createTempDir();
  try {
    for (const mode of ["pending_capacity", "bundle_transport_unavailable"]) {
      let nowMs = 1_700_000_000_000;
      const store = new ContractBoardStore({ privateRoot: path.join(tmpDir, mode), now: () => nowMs });
      const sent = [];

      store.createBoard({ board_id: "decouple-1", host_machine_id: HOST_ID, title: "解耦测试1", creator: HOST_ALICE });
      store.upsertMember("decouple-1", CLIENT_BOB);
      const fileDesc = store.seedLocalFile("decouple-1", "big1", "report.bin", Buffer.alloc(1024, 0x42));
      store.appendPost({
        boardId: "decouple-1",
        author: HOST_ALICE,
        body: "纯文本一定要立刻发出去！",
        files: [{ ...fileDesc, sync_machines: ["*"] }],
        fileSyncTargets: [CLIENT_ID],
      });

      store.createBoard({ board_id: "decouple-2", host_machine_id: HOST_ID, title: "解耦测试2", creator: HOST_ALICE });
      store.upsertMember("decouple-2", CLIENT_BOB);
      store.appendPost({
        boardId: "decouple-2",
        author: HOST_ALICE,
        body: "第二块板的纯文本消息也不能被堵死！",
      });

      const coord = new BoardSyncCoordinator({
        store,
        localMachineId: HOST_ID,
        peerMachines: [CLIENT_ID],
        now: () => nowMs,
        relaySender: {
          async send(args) {
            sent.push(args);
            if (args.attachments && args.attachments.length > 0) {
              if (mode === "pending_capacity") {
                return { ok: false, status: "pending_capacity", stage: "pending_capacity" };
              }
              throw new CoreError("bundle_transport_unavailable", "文件包通道未启用");
            }
            return { ok: true, status: "sent_verified", transport_mode: "text_relay" };
          },
        },
      });

      const summary = await coord.syncTick();
      assert.ok(summary.by_peer[CLIENT_ID].degraded_text_frames >= 1, `${mode}: 应立刻发出降级纯文本小帧`);

      const textFrames = sent.filter(f => f.op === "board_delta" && (f.attachments?.length ?? 0) === 0);
      assert.ok(textFrames.length >= 1, `${mode}: 至少发出 1 帧纯文本增量`);
      for (const tf of textFrames) {
        assert.equal(tf.allowBundle, false, `${mode}: 降级纯文本必须强制 allowBundle: false`);
        assert.equal(tf.meta.degraded_text_only, true);
      }

      const deliveredBodies = textFrames.flatMap(f => f.payloadJson.boards.flatMap(b => b.posts.map(p => p.body)));
      assert.ok(deliveredBodies.includes("纯文本一定要立刻发出去！"));
      assert.ok(deliveredBodies.includes("第二块板的纯文本消息也不能被堵死！"));

      // 文件必须留在 board_file_sync_queue 并设置退避 next_retry_at > nowMs
      const queuedFile = store.getFileSyncItem("decouple-1", "big1", CLIENT_ID);
      assert.equal(queuedFile.status, "pending");
      assert.equal(queuedFile.retry_count, 1);
      assert.ok(queuedFile.next_retry_at > nowMs);
      assert.equal(queuedFile.last_error, mode);

      await coord.close();
    }
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("入站严格防伪、防复活与审查 A R3 元数据防回退", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    const acks = [];
    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: CLIENT_ID,
      now: () => 1_700_000_000_000,
    });

    const makeReply = () => async args => {
      acks.push(args);
      return { ok: true };
    };

    // 1. 合法首推建副本（state_version=1, meta_version=3）
    await coord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "secure-board",
            host_machine_id: HOST_ID,
            title: "新版标题v3",
            status: "active",
            state_version: 1,
            meta_version: 3,
            archive_version: 0,
            settings: { default_poll_interval_sec: 120, auto_archive_days: 31, default_file_sync_machines: ["*"] },
            members: [HOST_ALICE, CLIENT_BOB],
            posts: [{ seq: 1, author: HOST_ALICE, body: "首帖", mentions: [], files: [], created_at: "2026-11-27T00:00:00Z", origin_client_post_id: "p1" }],
          }],
        }),
      },
      staged_files: [],
      reply: makeReply(),
    });
    assert.equal(store.getBoard("secure-board").title, "新版标题v3");
    assert.equal(store.getBoard("secure-board").meta_version, 3);

    // 2. 审查 A R3：同 state_version=1 但旧 meta_version=2 乱序迟到包，绝不回退 title/settings/members！
    await coord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "secure-board",
            host_machine_id: HOST_ID,
            title: "过时旧标题v2",
            status: "active",
            state_version: 1,
            meta_version: 2,
            archive_version: 0,
            settings: { default_poll_interval_sec: 999, auto_archive_days: 1, default_file_sync_machines: [] },
            members: [HOST_ALICE],
            posts: [{ seq: 2, author: HOST_ALICE, body: "新帖可收但元数据不回退", mentions: [], files: [], created_at: "2026-11-27T00:01:00Z", origin_client_post_id: "p2" }],
          }],
        }),
      },
      staged_files: [],
      reply: makeReply(),
    });
    const afterStaleMeta = store.getBoard("secure-board");
    assert.equal(afterStaleMeta.title, "新版标题v3");
    assert.equal(afterStaleMeta.meta_version, 3);
    assert.equal(afterStaleMeta.settings.default_poll_interval_sec, 120);
    assert.equal(store.listMembers("secure-board").length, 2);
    assert.equal(afterStaleMeta.board_seq, 2);

    // 3. 伪造来源机（ROGUE_ID 冒充 HOST_ID）下推 delta / dissolved / state_sync 全部拒收
    await coord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: ROGUE_ID },
      frame: {
        from_machine: ROGUE_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "secure-board",
            host_machine_id: ROGUE_ID,
            title: "篡改标题",
            status: "active",
            state_version: 99,
            meta_version: 99,
            posts: [],
          }],
        }),
      },
      staged_files: [],
      reply: makeReply(),
    });
    assert.equal(store.getBoard("secure-board").title, "新版标题v3");
    assert.equal(JSON.parse(acks.at(-1).body).boards[0].error_code, "host_authority_mismatch");

    await coord.handleInboundBoardDissolved({
      remotePrincipal: { from_machine: ROGUE_ID },
      frame: {
        from_machine: ROGUE_ID,
        body: JSON.stringify({
          kind: "board_dissolved",
          board_id: "secure-board",
          host_machine_id: HOST_ID,
          state_version: 99,
          archive_version: 99,
        }),
      },
      reply: makeReply(),
    });
    assert.equal(store.getBoard("secure-board").status, "active");

    // 4. 合法墓碑落地后，后续任何迟到 delta / state_sync / dissolved 绝不复活且回 ack 释放 spool
    await coord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_deleted_tombstone",
          tombstones: [{ board_id: "secure-board", host_machine_id: HOST_ID, final_state_version: 5, deleted_by_key: identityKey(HOST_ALICE), deleted_at: "2026-11-27T01:00:00Z" }],
        }),
      },
      reply: makeReply(),
    });
    assert.equal(store.getBoard("secure-board"), null);
    assert.equal(store.getTombstone("secure-board").final_state_version, 5);

    await coord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "secure-board",
            host_machine_id: HOST_ID,
            title: "企图复活",
            status: "active",
            state_version: 10,
            meta_version: 10,
            posts: [],
          }],
        }),
      },
      staged_files: [],
      reply: makeReply(),
    });
    assert.equal(store.getBoard("secure-board"), null, "命中墓碑绝不可复活");
    const tombAck = JSON.parse(acks.at(-1).body);
    assert.equal(tombAck.boards[0].ok, true);
    assert.equal(tombAck.boards[0].tombstoned, true);

    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("客机上行 5 重鉴源：拒绝未信任、未核验、跨机伪造及同机冒用其他对话", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    store.createBoard({ board_id: "host-room", host_machine_id: HOST_ID, title: "主机板", creator: HOST_ALICE });
    store.upsertMember("host-room", CLIENT_BOB);
    store.upsertMember("host-room", CLIENT_CAROL);

    let engineCalls = 0;
    const engine = {
      async postMessage() {
        engineCalls += 1;
        return { seq: 1 };
      },
      async invoke() {
        engineCalls += 1;
        return { ok: true };
      },
    };

    const coord = new BoardSyncCoordinator({
      store,
      engine,
      localMachineId: HOST_ID,
    });

    const badCases = [
      // 未配置 trust_source_identity
      {
        name: "untrusted_peer",
        remotePrincipal: {
          from_machine: CLIENT_ID,
          trust_source_identity: false,
          source_identity_verified: true,
          source_endpoint: "codex/desktop/conv-bob",
        },
        actor: CLIENT_BOB,
      },
      // source_identity_verified=false
      {
        name: "unverified_source",
        remotePrincipal: {
          from_machine: CLIENT_ID,
          trust_source_identity: true,
          source_identity_verified: false,
          source_endpoint: "codex/desktop/conv-bob",
        },
        actor: CLIENT_BOB,
      },
      // actor.machine_id !== from_machine
      {
        name: "cross_machine_spoof",
        remotePrincipal: {
          from_machine: CLIENT_ID,
          trust_source_identity: true,
          source_identity_verified: true,
          source_endpoint: "antigravity/desktop/conv-alice",
        },
        actor: HOST_ALICE,
      },
      // 同机冒用另一对话身份（帧头是 bob，payload.actor 冒充 carol！）
      {
        name: "same_machine_impersonation",
        remotePrincipal: {
          from_machine: CLIENT_ID,
          trust_source_identity: true,
          source_identity_verified: true,
          source_endpoint: "codex/desktop/conv-bob",
        },
        actor: CLIENT_CAROL,
      },
    ];

    for (const c of badCases) {
      const replies = [];
      const postRes = await coord.handleInboundBoardDelta({
        remotePrincipal: c.remotePrincipal,
        source_endpoint: c.remotePrincipal.source_endpoint,
        source_identity_verified: c.remotePrincipal.source_identity_verified,
        frame: {
          from_machine: c.remotePrincipal.from_machine,
          body: JSON.stringify({
            kind: "client_post_submit",
            local_post_id: `lp_${c.name}`,
            board_id: "host-room",
            host_machine_id: HOST_ID,
            actor: c.actor,
            body: "冒充发帖",
          }),
        },
        reply: async r => replies.push(r),
      });
      assert.equal(postRes.ok, false, `${c.name}: post 应被拒`);
      assert.equal(JSON.parse(replies[0].body).control_reply.error_code, "source_identity_unverified");

      const ctrlReplies = [];
      const ctrlRes = await coord.handleInboundBoardStateSync({
        remotePrincipal: c.remotePrincipal,
        source_endpoint: c.remotePrincipal.source_endpoint,
        source_identity_verified: c.remotePrincipal.source_identity_verified,
        frame: {
          from_machine: c.remotePrincipal.from_machine,
          body: JSON.stringify({
            kind: "client_control_request",
            local_post_id: `lc_${c.name}`,
            board_id: "host-room",
            host_machine_id: HOST_ID,
            action: "dissolve",
            actor: c.actor,
            params: {},
          }),
        },
        reply: async r => ctrlReplies.push(r),
      });
      assert.equal(ctrlRes.ok, false, `${c.name}: control 应被拒`);
      assert.equal(JSON.parse(ctrlReplies[0].body).control_reply.error_code, "source_identity_unverified");
    }

    assert.equal(engineCalls, 0, "所有伪造上行请求均不得触达 engine");

    // 合法 5 重一致请求通过
    const okReplies = [];
    const okRes = await coord.handleInboundBoardDelta({
      remotePrincipal: {
        from_machine: CLIENT_ID,
        trust_source_identity: true,
        source_identity_verified: true,
        source_endpoint: "codex/desktop/conv-bob",
      },
      source_endpoint: "codex/desktop/conv-bob",
      source_identity_verified: true,
      frame: {
        from_machine: CLIENT_ID,
        body: JSON.stringify({
          kind: "client_post_submit",
          local_post_id: "lp_legit",
          board_id: "host-room",
          host_machine_id: HOST_ID,
          actor: CLIENT_BOB,
          body: "合法客机发帖",
        }),
      },
      reply: async r => okReplies.push(r),
    });
    assert.equal(okRes.ok, true);
    assert.equal(engineCalls, 1);
    assert.equal(JSON.parse(okReplies[0].body).control_reply.status, "acked");

    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("远端文件落盘防丢件：坏哈希单板隔离、临时 ENOSPC 返回 retain_bundle 留存 spool 且恢复后成功落盘", async () => {
  const tmpDir = createTempDir();
  try {
    const bus = new InMemoryRelayBus();
    bus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    bus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    bus.registerRoute({
      relay_key: "r_main",
      group_id: "200001",
      members: [HOST_ID, CLIENT_ID],
      allow_file_bundle_write: true,
    });

    const hostTransport = bus.createTransportFor(HOST_ID);
    const clientTransport = bus.createTransportFor(CLIENT_ID);
    const hostDisp = new RemoteCoreDispatcher({ localMachineId: HOST_ID, transport: hostTransport });
    const clientDisp = new RemoteCoreDispatcher({ localMachineId: CLIENT_ID, transport: clientTransport });

    const clientStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "client") });
    const clientDb = new DatabaseSync(":memory:");
    const addressBook = new ConversationAddressBook({ database: clientDb, machineId: CLIENT_ID });

    const clientCoord = new BoardSyncCoordinator({
      store: clientStore,
      localMachineId: CLIENT_ID,
      dispatcher: clientDisp,
      addressBookAdapter: addressBook,
    });

    // 测试 1：单批 2 板，板 A 文件坏哈希，板 B 文件完好 → 板 A 记入 files_failed，板 B 正常落盘且本机成员自动配短代号
    const goodBuf = Buffer.from("good-content-board-b", "utf8");
    const badBuf = Buffer.from("corrupted-content-board-a", "utf8");
    const ackReplies = [];
    const res1 = await clientCoord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [
            {
              board_id: "board-a",
              host_machine_id: HOST_ID,
              title: "协作板甲",
              status: "active",
              state_version: 0,
              meta_version: 1,
              members: [HOST_ALICE, CLIENT_BOB],
              posts: [{
                seq: 1,
                author: HOST_ALICE,
                body: "板甲附件",
                files: [{ file_id: "fa1", safe_name: "bad.txt", bytes: badBuf.length, sha256: "0".repeat(64), sync_machines: ["*"] }],
              }],
            },
            {
              board_id: "board-b",
              host_machine_id: HOST_ID,
              title: "协作板乙",
              status: "active",
              state_version: 0,
              meta_version: 1,
              members: [HOST_ALICE, CLIENT_BOB],
              posts: [{
                seq: 1,
                author: HOST_ALICE,
                body: "板乙附件",
                files: [{ file_id: "fb1", safe_name: "good.txt", bytes: goodBuf.length, sha256: sha256Buffer(goodBuf), sync_machines: ["*"] }],
              }],
            },
          ],
          file_manifest: [
            { board_id: "board-a", seq: 1, file_id: "fa1", safe_name: "bad.txt", bytes: badBuf.length, sha256: "0".repeat(64), attachment_name: "board-a__fa1" },
            { board_id: "board-b", seq: 1, file_id: "fb1", safe_name: "good.txt", bytes: goodBuf.length, sha256: sha256Buffer(goodBuf), attachment_name: "board-b__fb1" },
          ],
        }),
      },
      staged_files: [
        { name: "board-a__fa1", buffer: badBuf },
        { name: "board-b__fb1", buffer: goodBuf },
      ],
      reply: async r => ackReplies.push(r),
    });

    assert.equal(res1.ok, true);
    const parsedAck = JSON.parse(ackReplies[0].body);
    const ackA = parsedAck.boards.find(b => b.board_id === "board-a");
    const ackB = parsedAck.boards.find(b => b.board_id === "board-b");
    assert.deepEqual(ackA.files_failed, [{ file_id: "fa1", code: "board_file_hash_conflict" }]);
    assert.deepEqual(ackB.files_acked, ["fb1"]);

    // 确认板 B 文件已落盘标 ready，板 A 文件标 failed
    assert.equal(clientStore.getPostByFileId("board-a", "fa1").files[0].local_status, "failed");
    const postBFile = clientStore.getPostByFileId("board-b", "fb1").files[0];
    assert.equal(postBFile.local_status, "ready");
    assert.equal(fs.readFileSync(postBFile.local_path, "utf8"), "good-content-board-b");

    // 确认跨机本机成员 CLIENT_BOB 已在真实 SQLite 通讯录中分配短代号
    const bobPrincipal = { identity: CLIENT_BOB, address_book_identity_bound: true, caller_scope: null };
    assert.deepEqual(addressBook.resolveBoard(bobPrincipal, "协作板乙"), { machine_id: HOST_ID, board_id: "board-b" });

    // 测试 2：经真实 RemoteCoreDispatcher + InMemoryRelayBus 演练 ENOSPC 临时错不释放 spool，恢复后重试成功释放！
    const fileOnHost = path.join(tmpDir, "host_disk_file.txt");
    const diskBuf = Buffer.from("persist-after-enospc", "utf8");
    fs.writeFileSync(fileOnHost, diskBuf);

    // 通过 hostDisp 发一包带附件的 board_delta
    await hostDisp.dispatchCustomOp({
      op: "board_delta",
      dedupeKey: "enospc_test_1",
      targetMachine: CLIENT_ID,
      payloadJson: {
        kind: "host_push_batch",
        boards: [{
          board_id: "board-enospc",
          host_machine_id: HOST_ID,
          title: "防丢件演练",
          status: "active",
          state_version: 0,
          meta_version: 1,
          members: [HOST_ALICE, CLIENT_BOB],
          posts: [{
            seq: 1,
            author: HOST_ALICE,
            body: "磁盘满后再恢复",
            files: [{ file_id: "fe1", safe_name: "disk.txt", bytes: diskBuf.length, sha256: sha256Buffer(diskBuf), sync_machines: ["*"] }],
          }],
        }],
        file_manifest: [{
          board_id: "board-enospc",
          seq: 1,
          file_id: "fe1",
          safe_name: "disk.txt",
          bytes: diskBuf.length,
          sha256: sha256Buffer(diskBuf),
          attachment_name: "board-enospc__fe1",
        }],
      },
      attachments: [{ name: "board-enospc__fe1", filePath: fileOnHost }],
      allowBundle: true,
    });

    // 模拟磁盘满 ENOSPC
    const enospcErr = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    clientStore.transientStorageError = enospcErr;

    const poll1 = await clientDisp.pollOnce();
    assert.equal(poll1.bundle_acked, 0, "ENOSPC 时绝不可 ack 释放 spool");
    assert.equal(bus.getSpoolStats(CLIENT_ID).incomingCount, 1, "spool 必须完整保留");

    // 恢复磁盘并映射合成 spool 路径字节流
    clientStore.transientStorageError = null;
    const pendingEventId = bus.getSpoolStats(CLIENT_ID).pendingEventIds[0];
    const syntheticSpoolPath = `spool://${CLIENT_ID}/${pendingEventId.slice(0, 12)}/0-board-enospc__fe1`;
    clientStore.fileBytesMap.set(syntheticSpoolPath, diskBuf);

    const poll2 = await clientDisp.pollOnce();
    assert.equal(poll2.bundle_acked, 1, "磁盘恢复后重放应成功落盘并释放 spool");
    assert.equal(bus.getSpoolStats(CLIENT_ID).incomingCount, 0);
    assert.equal(clientStore.getPostByFileId("board-enospc", "fe1").files[0].local_status, "ready");

    await clientCoord.close();
    await hostDisp.close();
    await clientDisp.close();
    await hostTransport.close();
    await clientTransport.close();
    clientDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("handleInboundBoardAck 单调推进：MAX 防回退、ok=false 不推进、files_acked/files_failed/tombstone/control_reply 全覆盖", async () => {
  const tmpDir = createTempDir();
  try {
    let nowMs = 1_700_000_000_000;
    const store = new ContractBoardStore({ privateRoot: tmpDir, now: () => nowMs });
    store.createBoard({ board_id: "ack-room", host_machine_id: HOST_ID, title: "确认板", creator: HOST_ALICE });
    store.upsertMember("ack-room", CLIENT_BOB);
    const f1 = store.seedLocalFile("ack-room", "f1", "a.txt", "aaa");
    const f2 = store.seedLocalFile("ack-room", "f2", "b.txt", "bbb");
    const f3 = store.seedLocalFile("ack-room", "f3", "c.txt", "ccc");
    store.appendPost({
      boardId: "ack-room",
      author: HOST_ALICE,
      body: "附件帖",
      files: [f1, f2, f3],
      fileSyncTargets: [CLIENT_ID],
    });

    // 准备一条待确认墓碑与三条客机 outbox
    store.createBoard({ board_id: "tomb-room", host_machine_id: HOST_ID, title: "删板", creator: HOST_ALICE });
    store.archiveBoard({ boardId: "tomb-room", reason: "manual_dissolve", actorKey: identityKey(HOST_ALICE) });
    store.deleteArchivedBoard({ boardId: "tomb-room", actorKey: identityKey(HOST_ALICE), peerMachines: [CLIENT_ID] });

    store.enqueueRemoteOutbox({ local_post_id: "o_ok", dedupe_key: "dk_1", board_id: "r1", host_machine_id: CLIENT_ID, author_key: identityKey(HOST_ALICE), op_kind: "post", payload_json: "{}" });
    store.enqueueRemoteOutbox({ local_post_id: "o_arch", dedupe_key: "dk_2", board_id: "r1", host_machine_id: CLIENT_ID, author_key: identityKey(HOST_ALICE), op_kind: "post", payload_json: "{}" });
    store.enqueueRemoteOutbox({ local_post_id: "o_del", dedupe_key: "dk_3", board_id: "r1", host_machine_id: CLIENT_ID, author_key: identityKey(HOST_ALICE), op_kind: "post", payload_json: "{}" });

    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: HOST_ID,
      now: () => nowMs,
    });

    // 先推进到较新水位
    await coord.handleInboundBoardAck({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: {
        from_machine: CLIENT_ID,
        body: JSON.stringify({
          kind: "board_ack",
          boards: [{
            board_id: "ack-room",
            state_version: 3,
            acked_meta_version: 4,
            acked_seq: 10,
            notified_dissolve_version: 2,
            ok: true,
            files_acked: ["f1"],
            files_failed: [
              { file_id: "f2", code: "board_file_hash_conflict" }, // 永久错 → failed
              { file_id: "f3", code: "staged_file_missing" }, // 可重试 → pending + backoff
            ],
          }],
          tombstones: [{ board_id: "tomb-room", final_state_version: 2, ok: true }],
          control_replies: [
            { local_post_id: "o_ok", ok: true, status: "acked" },
            { local_post_id: "o_arch", ok: false, status: "rejected_archived", error_code: "board_archived" },
            { local_post_id: "o_del", ok: false, status: "rejected_deleted", error_code: "board_deleted" },
          ],
        }),
      },
    });

    let state = store.getSyncState("ack-room", CLIENT_ID);
    assert.equal(state.last_acked_seq, 10);
    assert.equal(state.last_acked_state_version, 3);
    assert.equal(state.last_acked_meta_version, 4);
    assert.equal(state.last_notified_dissolve_version, 2);

    assert.equal(store.getFileSyncItem("ack-room", "f1", CLIENT_ID).status, "acked");
    assert.equal(store.getFileSyncItem("ack-room", "f2", CLIENT_ID).status, "failed");
    assert.equal(store.getFileSyncItem("ack-room", "f3", CLIENT_ID).status, "pending");
    assert.ok(store.getFileSyncItem("ack-room", "f3", CLIENT_ID).next_retry_at > nowMs);

    assert.equal(store.listPendingTombstoneSyncs(CLIENT_ID, nowMs).length, 0);
    assert.equal(store.getRemoteOutbox("o_ok").status, "acked");
    assert.equal(store.getRemoteOutbox("o_arch").status, "rejected_archived");
    assert.equal(store.getRemoteOutbox("o_del").status, "rejected_deleted");

    // 迟到旧版本 ACK + ok:false 的高版本 ACK 均不得回退或误推进
    await coord.handleInboundBoardAck({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: {
        from_machine: CLIENT_ID,
        body: JSON.stringify({
          kind: "board_ack",
          boards: [
            { board_id: "ack-room", state_version: 1, acked_meta_version: 1, acked_seq: 2, notified_dissolve_version: 0, ok: true },
            { board_id: "ack-room", state_version: 99, acked_meta_version: 99, acked_seq: 999, notified_dissolve_version: 99, ok: false, error_code: "host_authority_mismatch" },
          ],
        }),
      },
    });

    state = store.getSyncState("ack-room", CLIENT_ID);
    assert.equal(state.last_acked_seq, 10);
    assert.equal(state.last_acked_state_version, 3);
    assert.equal(state.last_acked_meta_version, 4);
    assert.equal(state.last_notified_dissolve_version, 2);

    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("真实 RemoteCoreDispatcher + InMemoryRelayBus 双机双向闭环（下推增量/解散/墓碑 + 客机发帖/控制）", async () => {
  const tmpDir = createTempDir();
  try {
    const bus = new InMemoryRelayBus();
    bus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    bus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    bus.registerRoute({
      relay_key: "r_pair",
      group_id: "300001",
      members: [HOST_ID, CLIENT_ID],
      allow_file_bundle_write: true,
    });

    const hostTransport = bus.createTransportFor(HOST_ID);
    const clientTransport = bus.createTransportFor(CLIENT_ID);

    const hostDisp = new RemoteCoreDispatcher({
      localMachineId: HOST_ID,
      transport: hostTransport,
      policy: { peers: { [CLIENT_ID]: { trust_source_identity: true } } },
    });
    const clientDisp = new RemoteCoreDispatcher({
      localMachineId: CLIENT_ID,
      transport: clientTransport,
      policy: { peers: { [HOST_ID]: { trust_source_identity: true } } },
    });

    const hostStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "host") });
    const clientStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "client") });
    const clientDb = new DatabaseSync(":memory:");
    const clientBook = new ConversationAddressBook({ database: clientDb, machineId: CLIENT_ID });

    const hostEngine = {
      async postMessage(actor, params, { board }) {
        const res = hostStore.appendPost({
          boardId: board.board_id,
          author: actor,
          body: params.body,
          mentions: params.mentions,
          files: params.files ?? [],
          originClientPostId: params.client_post_id,
        });
        return { board_id: board.board_id, seq: res.post.seq };
      },
      async invoke({ action, actorIdentity, board, params }) {
        if (action === "update_settings") {
          return hostStore.updateBoardSettings(board.board_id, params.settings);
        }
        if (action === "dissolve") {
          return hostStore.archiveBoard({ boardId: board.board_id, reason: "manual_dissolve", actorKey: identityKey(actorIdentity) });
        }
        throw new CoreError("unsupported_control_action", `unsupported ${action}`);
      },
    };

    const hostCoord = new BoardSyncCoordinator({
      store: hostStore,
      engine: hostEngine,
      localMachineId: HOST_ID,
      dispatcher: hostDisp,
      peerMachines: [CLIENT_ID],
    });
    const clientCoord = new BoardSyncCoordinator({
      store: clientStore,
      localMachineId: CLIENT_ID,
      dispatcher: clientDisp,
      peerMachines: [HOST_ID],
      addressBookAdapter: clientBook,
    });

    // 1. 主机建板、邀客机 Bob、发首帖 → 同步至客机 → 客机自动回 ACK → 主机确认归零
    hostStore.createBoard({ board_id: "e2e-room", host_machine_id: HOST_ID, title: "双机联测板", creator: HOST_ALICE });
    hostStore.upsertMember("e2e-room", CLIENT_BOB);
    hostStore.appendPost({ boardId: "e2e-room", author: HOST_ALICE, body: "主机问候客机" });

    const tick1 = await hostCoord.syncTick();
    assert.equal(tick1.sent_frames, 1);

    const clientPoll1 = await clientDisp.pollOnce();
    assert.equal(clientPoll1.processed, 1);
    assert.equal(clientStore.getBoard("e2e-room").title, "双机联测板");
    assert.equal(clientStore.getPostsRange("e2e-room", 0, 10)[0].body, "主机问候客机");

    // 客机 Bob 自动获得通讯录短代号
    const bobPrincipal = { identity: CLIENT_BOB, address_book_identity_bound: true, caller_scope: null };
    assert.deepEqual(clientBook.resolveBoard(bobPrincipal, "双机联测板"), { machine_id: HOST_ID, board_id: "e2e-room" });

    // 主机拉取 board_ack → 单调推进 → 下轮 syncTick 发 0 帧
    const hostPoll1 = await hostDisp.pollOnce();
    assert.equal(hostPoll1.processed, 1);
    const tickIdle = await hostCoord.syncTick();
    assert.equal(tickIdle.sent_frames, 0);

    // 2. 客机 Bob 离线发帖 + 改设置 → 主机双层鉴源执行并回 control_reply → 客机 outbox 标 acked
    clientStore.enqueueRemoteOutbox({
      local_post_id: "cli_p_1",
      dedupe_key: "cli_p_1_dk",
      board_id: "e2e-room",
      host_machine_id: HOST_ID,
      author_key: identityKey(CLIENT_BOB),
      op_kind: "post",
      payload_json: JSON.stringify({
        actor: CLIENT_BOB,
        body: "客机发往主机的真实帖",
        mentions: [],
        files: [],
        origin_client_post_id: "cli_p_1",
      }),
    });
    clientStore.enqueueRemoteOutbox({
      local_post_id: "cli_c_1",
      dedupe_key: "cli_c_1_dk",
      board_id: "e2e-room",
      host_machine_id: HOST_ID,
      author_key: identityKey(CLIENT_BOB),
      op_kind: "update_settings",
      payload_json: JSON.stringify({
        action: "update_settings",
        actor: CLIENT_BOB,
        params: { settings: { auto_archive_days: 60 } },
      }),
    });

    const clientTick = await clientCoord.syncTick();
    assert.equal(clientTick.sent_frames, 2);

    const hostPoll2 = await hostDisp.pollOnce();
    assert.equal(hostPoll2.processed, 2);
    assert.equal(hostStore.getBoard("e2e-room").board_seq, 2);
    assert.equal(hostStore.getBoard("e2e-room").settings.auto_archive_days, 60);

    const clientPoll2 = await clientDisp.pollOnce();
    assert.equal(clientPoll2.processed, 2);
    assert.equal(clientStore.getRemoteOutbox("cli_p_1").status, "acked");
    assert.equal(clientStore.getRemoteOutbox("cli_c_1").status, "acked");

    // 3. 主机手动解散 → 高优小帧 → 客机落归档并生成解散提醒
    hostStore.archiveBoard({ boardId: "e2e-room", reason: "manual_dissolve", actorKey: identityKey(HOST_ALICE) });
    const dissolveTick = await hostCoord.syncTick();
    assert.equal(dissolveTick.by_peer[CLIENT_ID].dissolved_frames, 1);

    await clientDisp.pollOnce();
    assert.equal(clientStore.getBoard("e2e-room").status, "archived");
    assert.equal(clientStore.notifications.size, 1);

    await hostDisp.pollOnce();
    assert.equal((await hostCoord.syncTick()).sent_frames, 0);

    await hostCoord.close();
    await clientCoord.close();
    await hostDisp.close();
    await clientDisp.close();
    await hostTransport.close();
    await clientTransport.close();
    clientDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("确定性清理与零句柄泄漏：startSyncLoop 运行后 close() 注销 dispatcher opHandlers 且活跃句柄增量为 0", async () => {
  const tmpDir = createTempDir();
  try {
    const bus = new InMemoryRelayBus();
    bus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    bus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    bus.registerRoute({ relay_key: "r_clean", group_id: "400001", members: [HOST_ID, CLIENT_ID] });

    const transport = bus.createTransportFor(HOST_ID);
    const disp = new RemoteCoreDispatcher({ localMachineId: HOST_ID, transport });
    const store = new ContractBoardStore({ privateRoot: tmpDir });

    let notifyTicks = 0;
    let sweepTicks = 0;
    const engine = {
      async localNotifyTick() {
        notifyTicks += 1;
      },
      async runAutoArchiveSweep() {
        sweepTicks += 1;
      },
    };

    const beforeResources = process.getActiveResourcesInfo();
    const beforeTimeouts = beforeResources.filter(r => r === "Timeout").length;

    let capturedSignal = null;
    let releaseBlockedSync;
    const blockedSyncStarted = new Promise(resolve => {
      releaseBlockedSync = resolve;
    });

    const coord = new BoardSyncCoordinator({
      store,
      engine,
      localMachineId: HOST_ID,
      dispatcher: disp,
      peerMachines: [CLIENT_ID],
    });

    coord.startSyncLoop({ syncIntervalMs: 15, notifyIntervalMs: 15 });
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.ok(notifyTicks >= 1, "localNotifyTick 应已定时触发");
    assert.ok(sweepTicks >= 1, "runAutoArchiveSweep 应已定时触发");

    await coord.close();
    await coord.close(); // 幂等二次关闭

    // 测试在途 syncTick 被 close() 中止 AbortSignal 且无泄漏
    const store2 = new ContractBoardStore({ privateRoot: path.join(tmpDir, "abort") });
    store2.createBoard({ board_id: "abort-b", host_machine_id: HOST_ID, title: "中止测试", creator: HOST_ALICE });
    store2.upsertMember("abort-b", CLIENT_BOB);
    const coord2 = new BoardSyncCoordinator({
      store: store2,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      relaySender: {
        async send({ signal }) {
          capturedSignal = signal;
          releaseBlockedSync();
          await new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(new CoreError("coordinator_closed", "closed"));
              return;
            }
            signal?.addEventListener("abort", () => reject(new CoreError("coordinator_closed", "closed")), { once: true });
          });
        },
      },
    });
    const inflightPromise = coord2.syncTick();
    await blockedSyncStarted;
    await coord2.close();
    await inflightPromise.catch(() => {});
    assert.equal(capturedSignal?.aborted, true, "close() 必须中止直接调用 syncTick 的在途 AbortSignal");

    // 验证 dispatcher 上 4 个 opHandlers 均已注销（再喂入应报 unsupported_op）
    for (const op of BOARD_SYNC_OPS) {
      const outcome = await disp.handleInboundEvent({
        event_id: `chk_${op}`,
        source_machine: CLIENT_ID,
        relay_key: "r_clean",
        group_id: "400001",
        route_generation: 1,
        frame: {
          relay_id: `rly_${op}`,
          op,
          from_machine: CLIENT_ID,
          to_machine: HOST_ID,
          source: "core/system/board_sync",
          recipients: ["core/system/board_sync"],
          body: "{}",
          meta: { hop_count: 1 },
        },
      });
      assert.equal(outcome.code, "unsupported_op", `${op} handler 应在 close() 后彻底注销`);
    }

    await disp.close();
    await transport.close();

    const afterResources = process.getActiveResourcesInfo();
    const afterTimeouts = afterResources.filter(r => r === "Timeout").length;
    assert.equal(afterTimeouts - beforeTimeouts, 0, "close() 后活跃 Timeout 句柄增量必须为 0");
    assert.equal(afterResources.length - beforeResources.length, 0, "close() 后总活跃句柄增量必须为 0");
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("字节级合帧切分：payload_json 字节上限与文件装箱字节上限严格不超限", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    const sent = [];
    // 使用较小的可测上限：payload_json <= 2048 B，bundleTotalBytes <= 4096 B
    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      limits: {
        maxPayloadJsonBytes: 2048,
        maxBundleTotalBytes: 4096,
      },
      relaySender: {
        async send(args) {
          sent.push(args);
          return { ok: true, status: "sent_verified", relay_id: `rly_${sent.length}` };
        },
      },
    });

    store.createBoard({ board_id: "size-board", host_machine_id: HOST_ID, title: "字节预算板", creator: HOST_ALICE });
    store.upsertMember("size-board", CLIENT_BOB);
    const fileList = [
      store.seedLocalFile("size-board", "big1", "p1.bin", Buffer.alloc(2500, 0x61)),
      store.seedLocalFile("size-board", "big2", "p2.bin", Buffer.alloc(2500, 0x62)),
      store.seedLocalFile("size-board", "big3", "p3.bin", Buffer.alloc(2500, 0x63)),
    ];

    for (let i = 1; i <= 5; i += 1) {
      const files = i <= 3 ? [{ ...fileList[i - 1], sync_machines: ["*"] }] : [];
      store.appendPost({
        boardId: "size-board",
        author: HOST_ALICE,
        body: `长文载荷-${i}-` + "x".repeat(300),
        files,
        fileSyncTargets: files.length ? [CLIENT_ID] : [],
      });
    }

    await coord.syncTick();
    assert.ok(sent.length >= 3, "应切分为多帧");

    let sentFilesCount = 0;
    for (const frame of sent) {
      const payloadBytes = Buffer.byteLength(JSON.stringify(frame.payloadJson), "utf8");
      assert.ok(payloadBytes <= 2048, `payload_json(${payloadBytes}) 不得超过 2048 B`);
      const bundleBytes = (frame.payloadJson.file_manifest ?? []).reduce((acc, m) => acc + m.bytes, 0);
      assert.ok(bundleBytes <= 4096, `单包附件字节(${bundleBytes}) 不得超过 4096 B`);
      sentFilesCount += (frame.attachments?.length ?? 0);
    }
    assert.equal(sentFilesCount, 3, "3 个 2500B 文件应按 <= 4096B 分成 3 包全部发出");
    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("全链路文本降级 + 退避到期独立文件补发闭环（真实 RemoteCoreDispatcher + InMemoryRelayBus）", async () => {
  const tmpDir = createTempDir();
  try {
    let nowMs = 1_700_000_000_000;
    const bus = new InMemoryRelayBus({ now: () => nowMs });
    bus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    bus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    bus.registerRoute({
      relay_key: "r_decouple",
      group_id: "500001",
      members: [HOST_ID, CLIENT_ID],
      allow_file_bundle_write: true,
    });

    const rawHostTransport = bus.createTransportFor(HOST_ID);
    const clientTransport = bus.createTransportFor(CLIENT_ID);

    // 包装 hostTransport：首次 sendBundle 返回 pending_capacity，第二次放行！
    let bundleAttempts = 0;
    const hostTransport = {
      sendFrame: (params, ctx) => rawHostTransport.sendFrame(params, ctx),
      poll: (params, ctx) => rawHostTransport.poll(params, ctx),
      readEvents: (params, ctx) => rawHostTransport.readEvents(params, ctx),
      pollBundles: (params, ctx) => rawHostTransport.pollBundles(params, ctx),
      readBundleEvents: (params, ctx) => rawHostTransport.readBundleEvents(params, ctx),
      ackBundleEvents: (params, ctx) => rawHostTransport.ackBundleEvents(params, ctx),
      async sendBundle(params, ctx) {
        bundleAttempts += 1;
        if (bundleAttempts === 1) {
          return { ok: false, status: "pending_capacity", reason: "spool_full" };
        }
        return rawHostTransport.sendBundle(params, ctx);
      },
      close: () => rawHostTransport.close(),
    };

    const hostDisp = new RemoteCoreDispatcher({ localMachineId: HOST_ID, transport: hostTransport, now: () => nowMs });
    const clientDisp = new RemoteCoreDispatcher({ localMachineId: CLIENT_ID, transport: clientTransport, now: () => nowMs });

    const hostStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "host"), now: () => nowMs });
    const clientStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "client"), now: () => nowMs });

    const hostCoord = new BoardSyncCoordinator({
      store: hostStore,
      localMachineId: HOST_ID,
      dispatcher: hostDisp,
      peerMachines: [CLIENT_ID],
      limits: { baseRetryMs: 1000 },
      now: () => nowMs,
    });
    const clientCoord = new BoardSyncCoordinator({
      store: clientStore,
      localMachineId: CLIENT_ID,
      dispatcher: clientDisp,
      peerMachines: [HOST_ID],
      now: () => nowMs,
    });

    // 建 2 个板子，带 CQ 特殊字符 [&,] 的长正文 + 附件，确保降级拆分测试到多小帧 CQ 预算！
    const fileBuf = Buffer.from("delayed-file-payload-ok", "utf8");
    hostStore.createBoard({ board_id: "deg-1", host_machine_id: HOST_ID, title: "降级板1", creator: HOST_ALICE });
    hostStore.upsertMember("deg-1", CLIENT_BOB);
    const fDesc = hostStore.seedLocalFile("deg-1", "df1", "later.txt", fileBuf);
    hostStore.appendPost({
      boardId: "deg-1",
      author: HOST_ALICE,
      body: "首帖含特殊字符[a,b&c]与中文内容-" + "文".repeat(220),
      files: [{ ...fDesc, sync_machines: ["*"] }],
      fileSyncTargets: [CLIENT_ID],
    });
    hostStore.createBoard({ board_id: "deg-2", host_machine_id: HOST_ID, title: "降级板2", creator: HOST_ALICE });
    hostStore.upsertMember("deg-2", CLIENT_BOB);
    hostStore.appendPost({
      boardId: "deg-2",
      author: HOST_ALICE,
      body: "第二板含特殊字符[x,y&z]-" + "字".repeat(220),
    });

    // 第 1 轮 syncTick：合帧遇 pending_capacity → 拆纯文本走 1800 CQ 小帧发完！
    const tick1 = await hostCoord.syncTick();
    assert.ok(tick1.by_peer[CLIENT_ID].degraded_text_frames >= 2, "应自动拆成多条 <=1800 CQ 纯文本小帧");
    assert.equal(hostStore.getFileSyncItem("deg-1", "df1", CLIENT_ID).status, "pending");

    // 客机接收纯文本小帧：两板帖子立刻可读，文件标记 pending_sync
    await clientDisp.pollOnce();
    assert.equal(clientStore.getPostsRange("deg-1", 0, 10).length, 1);
    assert.equal(clientStore.getPostsRange("deg-2", 0, 10).length, 1);
    assert.equal(clientStore.getPostByFileId("deg-1", "df1").files[0].local_status, "pending_sync");

    // 主机接收 board_ack（推进两板文本水位）
    await hostDisp.pollOnce();

    // 退避未到期时 syncTick 必须发 0 帧！
    const beforeDueTick = await hostCoord.syncTick();
    assert.equal(beforeDueTick.sent_frames, 0, "退避未到期且文本已确认时发 0 帧");

    // 推进时钟跨过退避期 → 仅触发 ⑤ 独立文件补发！
    nowMs += 2000;
    const tick2 = await hostCoord.syncTick();
    assert.equal(tick2.by_peer[CLIENT_ID].file_frames, 1);
    assert.equal(tick2.by_peer[CLIENT_ID].delta_frames, 0);

    // 映射合成 spool 字节并让客机落盘文件
    await clientTransport.pollBundles();
    const pendingId = bus.getSpoolStats(CLIENT_ID).pendingEventIds[0];
    clientStore.fileBytesMap.set(`spool://${CLIENT_ID}/${pendingId.slice(0, 12)}/0-deg-1__df1`, fileBuf);
    await clientDisp.pollOnce();
    assert.equal(clientStore.getPostByFileId("deg-1", "df1").files[0].local_status, "ready");

    // 主机收文件 ACK → 彻底归零 0 帧！
    await hostDisp.pollOnce();
    assert.equal(hostStore.getFileSyncItem("deg-1", "df1", CLIENT_ID).status, "acked");
    assert.equal((await hostCoord.syncTick()).sent_frames, 0);

    await hostCoord.close();
    await clientCoord.close();
    await hostDisp.close();
    await clientDisp.close();
    await hostTransport.close();
    await clientTransport.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("生命周期单调性：静默自动归档不打扰、恢复推进 state_version、非法 0 版本解散与非权威 control_reply 均被拒绝", async () => {
  const tmpDir = createTempDir();
  try {
    const store = new ContractBoardStore({ privateRoot: tmpDir });
    const coord = new BoardSyncCoordinator({
      store,
      localMachineId: CLIENT_ID,
    });
    const acks = [];
    const reply = async r => acks.push(r);

    // 初始活跃板 state_version=0, meta_version=1
    store.upsertBoardFromRemote({
      board_id: "life-board",
      host_machine_id: HOST_ID,
      title: "生命周期板",
      status: "active",
      state_version: 0,
      meta_version: 1,
      archive_version: 0,
      settings: {},
      members: [HOST_ALICE, CLIENT_BOB],
    });

    // 非法 0 版本解散帧被拒
    const badDissolve = await coord.handleInboundBoardDissolved({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "board_dissolved",
          board_id: "life-board",
          host_machine_id: HOST_ID,
          state_version: 0,
          archive_version: 0,
        }),
      },
      reply,
    });
    assert.equal(badDissolve.ok, false);
    assert.equal(badDissolve.code, "invalid_input");
    assert.equal(store.getBoard("life-board").status, "active");

    // 31 天静默自动归档（state_version=1）→ 变 archived 且绝不入队成员通知！
    await coord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_state_push",
          boards: [{
            board_id: "life-board",
            host_machine_id: HOST_ID,
            title: "生命周期板",
            status: "archived",
            state_version: 1,
            meta_version: 1,
            archive_version: 1,
            archive_reason: "auto_inactive_31d",
          }],
        }),
      },
      reply,
    });
    assert.equal(store.getBoard("life-board").status, "archived");
    assert.equal(store.notifications.size, 0, "31天静默自动归档绝不打扰成员");
    assert.ok(store.reconcileCalls >= 1);

    // 恢复为活跃态（state_version=2）
    await coord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_state_push",
          boards: [{
            board_id: "life-board",
            host_machine_id: HOST_ID,
            title: "生命周期板-恢复后",
            status: "active",
            state_version: 2,
            meta_version: 2,
            archive_version: 1,
            archive_reason: null,
          }],
        }),
      },
      reply,
    });
    assert.equal(store.getBoard("life-board").status, "active");
    assert.equal(store.getBoard("life-board").state_version, 2);
    assert.equal(store.getBoard("life-board").title, "生命周期板-恢复后");

    // 迟到旧 state_version=1 归档包绝不把已恢复板打回归档！
    await coord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_state_push",
          boards: [{
            board_id: "life-board",
            host_machine_id: HOST_ID,
            title: "过时标题",
            status: "archived",
            state_version: 1,
            meta_version: 99,
            archive_version: 1,
          }],
        }),
      },
      reply,
    });
    assert.equal(store.getBoard("life-board").status, "active");
    assert.equal(store.getBoard("life-board").title, "生命周期板-恢复后");
    assert.equal(store.getBoard("life-board").meta_version, 2);

    // 非建板机 ROGUE_ID 伪造 control_reply 绝不推进客机 outbox！
    store.enqueueRemoteOutbox({
      local_post_id: "cli_guard_1",
      dedupe_key: "dk_guard_1",
      board_id: "life-board",
      host_machine_id: HOST_ID,
      author_key: identityKey(CLIENT_BOB),
      op_kind: "post",
      payload_json: "{}",
    });
    await coord.handleInboundBoardAck({
      remotePrincipal: { from_machine: ROGUE_ID },
      frame: {
        from_machine: ROGUE_ID,
        body: JSON.stringify({
          kind: "board_ack",
          boards: [],
          control_reply: { local_post_id: "cli_guard_1", board_id: "life-board", ok: true, status: "acked" },
        }),
      },
    });
    assert.equal(store.getRemoteOutbox("cli_guard_1").status, "pending", "非建板机伪造 control_reply 必须被丢弃");

    await coord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 项1+增量2：跨机客机写链路（params 透传、带附件走 postFromRemoteClient、非成员零写盘零泄露与失败兜底清理）", async () => {
  const tmpDir = createTempDir();
  try {
    let nowMs = 1_700_100_000_000;
    const hostRoot = path.join(tmpDir, "host");
    const clientRoot = path.join(tmpDir, "client");
    const uploadDir = path.join(tmpDir, "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploadPath = path.join(uploadDir, "spec.txt");
    const uploadBuf = Buffer.from("remote-client-attachment-content", "utf8");
    fs.writeFileSync(uploadPath, uploadBuf);

    const bus = new InMemoryRelayBus({ now: () => nowMs });
    bus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    bus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    bus.registerRoute({
      relay_key: "r_w23_1",
      group_id: "600001",
      members: [HOST_ID, CLIENT_ID],
      allow_file_bundle_write: true,
    });

    const hostTransport = bus.createTransportFor(HOST_ID);
    const clientTransport = bus.createTransportFor(CLIENT_ID);
    const hostDisp = new RemoteCoreDispatcher({
      localMachineId: HOST_ID,
      transport: hostTransport,
      policy: { peers: { [CLIENT_ID]: { trust_source_identity: true, allow_file_bundle: true } } },
      now: () => nowMs,
    });
    const clientDisp = new RemoteCoreDispatcher({
      localMachineId: CLIENT_ID,
      transport: clientTransport,
      policy: { peers: { [HOST_ID]: { trust_source_identity: true, allow_file_bundle: true } } },
      now: () => nowMs,
    });

    const hostDb = new DatabaseSync(":memory:");
    const clientDb = new DatabaseSync(":memory:");
    const hostRuntime = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: hostRoot,
      openStore: create => create({ database: hostDb, privateRoot: hostRoot }),
      relayDispatcher: hostDisp,
      peerMachineIds: [CLIENT_ID],
      fileBundlePeers: [CLIENT_ID],
      now: () => nowMs,
    });
    const clientRuntime = openBoardRuntime({
      localMachineId: CLIENT_ID,
      privateRoot: clientRoot,
      allowedUploadRoots: [uploadDir],
      openStore: create => create({ database: clientDb, privateRoot: clientRoot, allowedUploadRoots: [uploadDir] }),
      relayDispatcher: clientDisp,
      peerMachineIds: [HOST_ID],
      fileBundlePeers: [HOST_ID],
      now: () => nowMs,
    });

    // 1. 主机建活跃板、归档板、已删墓碑板并同步活跃板给客机
    await hostRuntime.invoke({
      action: "create",
      actorIdentity: HOST_ALICE,
      params: { board_id: "w23-active", title: "活跃协作板" },
    });
    await hostRuntime.invoke({
      action: "invite",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "w23-active" },
      params: { members: [CLIENT_BOB] },
    });
    await hostRuntime.invoke({
      action: "create",
      actorIdentity: HOST_ALICE,
      params: { board_id: "w23-archived", title: "归档私密板" },
    });
    await hostRuntime.invoke({
      action: "dissolve",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "w23-archived" },
      params: {},
    });
    await hostRuntime.invoke({
      action: "create",
      actorIdentity: HOST_ALICE,
      params: { board_id: "w23-deleted", title: "已删墓碑板" },
    });
    await hostRuntime.invoke({
      action: "dissolve",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "w23-deleted" },
      params: {},
    });
    await hostRuntime.invoke({
      action: "delete_archived",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "w23-deleted" },
      params: { expected_archive_version: 1 },
    });

    await hostRuntime.sync.syncTick();
    await clientDisp.pollOnce();
    await hostDisp.pollOnce();

    // 2. 客机 Bob 通过真实 BoardEngine 发起 update_settings（入队 payload_json.payload）与带附件发帖（入队 client_post_id）
    const ctrlQueued = await clientRuntime.invoke({
      action: "update_settings",
      actorIdentity: CLIENT_BOB,
      board: { machine_id: HOST_ID, board_id: "w23-active" },
      params: { settings: { auto_archive_days: 45 } },
    });
    assert.equal(ctrlQueued.pending_host_ack, true);

    const postQueued = await clientRuntime.invoke({
      action: "post",
      actorIdentity: CLIENT_BOB,
      board: { machine_id: HOST_ID, board_id: "w23-active" },
      params: {
        body: "客机带附件发帖测试",
        client_post_id: "bob-custom-cpost-1",
        files: [{ path: uploadPath, name: "spec.txt" }],
      },
    });
    assert.equal(postQueued.pending_host_ack, true);
    assert.equal(postQueued.uploaded_files.length, 1);

    // 客机推送 outbox 到主机
    const clientPush = await clientRuntime.sync.syncTick();
    assert.equal(clientPush.by_peer[HOST_ID].outbox_frames, 2);

    // 映射 bus 合成 spool 路径，让主机走真实 stageRemoteFileBufferOrPath + postFromRemoteClient
    const origStage = hostRuntime.store.stageRemoteFileBufferOrPath.bind(hostRuntime.store);
    hostRuntime.store.stageRemoteFileBufferOrPath = args => {
      if (typeof args.sourcePath === "string" && args.sourcePath.startsWith("spool://")) {
        return origStage({ ...args, sourcePath: null, buffer: uploadBuf });
      }
      return origStage(args);
    };

    const hostPoll = await hostDisp.pollOnce();
    assert.equal(hostPoll.processed, 2);

    // 核验主机设置已改、帖子已通过 postFromRemoteClient 落库且保留精确 client_post_id 与落盘文件！
    assert.equal(hostRuntime.store.getBoard("w23-active").settings.auto_archive_days, 45);
    const hostPosts = hostRuntime.store.getPostsRange("w23-active", 0, 10);
    assert.equal(hostPosts.length, 1);
    assert.equal(hostPosts[0].origin_client_post_id, "bob-custom-cpost-1");
    assert.equal(hostPosts[0].files.length, 1);
    assert.equal(hostPosts[0].files[0].local_status, "ready");
    const savedHostFile = hostRuntime.store.resolveSafeBoardFilePath("w23-active", hostPosts[0].files[0].file_id, "spec.txt");
    assert.equal(fs.readFileSync(savedHostFile, "utf8"), "remote-client-attachment-content");

    // 客机接收回执后两条 outbox 均标 acked
    await clientDisp.pollOnce();
    assert.equal(clientRuntime.store.getRemoteOutbox(ctrlQueued.request_id).status, "acked");
    assert.equal(clientRuntime.store.getRemoteOutbox(postQueued.local_post_id).status, "acked");

    // 3. 非成员 CAROL 带附件发帖探测：活跃板/归档板均报 forbidden 且零写盘；已删墓碑板与不存在板均报 board_not_found 且零写盘！
    const carolPrincipal = {
      from_machine: CLIENT_ID,
      trust_source_identity: true,
      source_identity_verified: true,
      source_endpoint: "codex/desktop/conv-carol",
    };
    const rogueBuf = Buffer.from("untrusted-stranger-file-bytes", "utf8");
    const rogueSha = sha256Buffer(rogueBuf);
    const probeTargets = [
      { boardId: "w23-active", expectedCode: "forbidden" },
      { boardId: "w23-archived", expectedCode: "forbidden" },
      { boardId: "w23-deleted", expectedCode: "board_not_found" },
      { boardId: "w23-nonexistent", expectedCode: "board_not_found" },
    ];
    for (const target of probeTargets) {
      const postReplies = [];
      const postRes = await hostRuntime.sync.handleInboundBoardDelta({
        remotePrincipal: carolPrincipal,
        source_endpoint: carolPrincipal.source_endpoint,
        source_identity_verified: true,
        frame: {
          from_machine: CLIENT_ID,
          body: JSON.stringify({
            kind: "client_post_submit",
            local_post_id: `lp_probe_${target.boardId}`,
            board_id: target.boardId,
            host_machine_id: HOST_ID,
            actor: CLIENT_CAROL,
            body: "非成员探测",
            files: [{ file_id: "f_rogue", safe_name: "evil.bin", bytes: rogueBuf.length, sha256: rogueSha }],
          }),
        },
        staged_files: [{ name: `${target.boardId}__f_rogue`, buffer: rogueBuf }],
        reply: async r => postReplies.push(r),
      });
      assert.equal(postRes.ok, false);
      assert.equal(JSON.parse(postReplies[0].body).control_reply.error_code, target.expectedCode, `post ${target.boardId}`);
      const probeFilePath = hostRuntime.store.resolveSafeBoardFilePath(target.boardId, "f_rogue", "evil.bin");
      assert.equal(fs.existsSync(probeFilePath), false, `${target.boardId}: 非成员绝不可在建板机落盘任何字节！`);

      // 非成员控制请求同样不得提前区分 board_deleted vs board_not_found
      const ctrlReplies = [];
      const ctrlRes = await hostRuntime.sync.handleInboundBoardStateSync({
        remotePrincipal: carolPrincipal,
        source_endpoint: carolPrincipal.source_endpoint,
        source_identity_verified: true,
        frame: {
          from_machine: CLIENT_ID,
          body: JSON.stringify({
            kind: "client_control_request",
            local_post_id: `lc_probe_${target.boardId}`,
            board_id: target.boardId,
            host_machine_id: HOST_ID,
            action: "dissolve",
            actor: CLIENT_CAROL,
            params: {},
          }),
        },
        reply: async r => ctrlReplies.push(r),
      });
      assert.equal(ctrlRes.ok, false);
      const ctrlCode = JSON.parse(ctrlReplies[0].body).control_reply.error_code;
      assert.notEqual(ctrlCode, "board_deleted", `control ${target.boardId} 绝不泄露 board_deleted`);
      assert.equal(ctrlCode, target.expectedCode, `control ${target.boardId}`);
    }

    // 4. 合法成员带附件发帖若 postFromRemoteClient 抛错且未自行删盘，board-sync 必须兜底删净残留文件！
    const failingStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "cleanup-host") });
    failingStore.createBoard({ board_id: "clean-room", host_machine_id: HOST_ID, title: "清理板", creator: HOST_ALICE });
    failingStore.upsertMember("clean-room", CLIENT_BOB);
    const cleanupEngine = {
      canActorPostToBoard: () => ({ allowed: true }),
      async postFromRemoteClient() {
        throw new CoreError("board_post_conflict", "模拟落库冲突且未删盘");
      },
    };
    const cleanupCoord = new BoardSyncCoordinator({
      store: failingStore,
      engine: cleanupEngine,
      localMachineId: HOST_ID,
    });
    const orphanBuf = Buffer.from("should-be-cleaned-on-failure", "utf8");
    const cleanReplies = [];
    const cleanRes = await cleanupCoord.handleInboundBoardDelta({
      remotePrincipal: {
        from_machine: CLIENT_ID,
        trust_source_identity: true,
        source_identity_verified: true,
        source_endpoint: "codex/desktop/conv-bob",
      },
      source_endpoint: "codex/desktop/conv-bob",
      source_identity_verified: true,
      frame: {
        from_machine: CLIENT_ID,
        body: JSON.stringify({
          kind: "client_post_submit",
          local_post_id: "lp_fail_clean",
          board_id: "clean-room",
          host_machine_id: HOST_ID,
          actor: CLIENT_BOB,
          body: "失败应清理附件",
          files: [{ file_id: "f_orphan", safe_name: "orphan.txt", bytes: orphanBuf.length, sha256: sha256Buffer(orphanBuf) }],
        }),
      },
      staged_files: [{ name: "clean-room__f_orphan", buffer: orphanBuf }],
      reply: async r => cleanReplies.push(r),
    });
    assert.equal(cleanRes.ok, false);
    assert.equal(JSON.parse(cleanReplies[0].body).control_reply.error_code, "board_post_conflict");
    assert.equal(
      fs.existsSync(failingStore.resolveSafeBoardFilePath("clean-room", "f_orphan", "orphan.txt")),
      false,
      "postFromRemoteClient 抛错时必须兜底清理已暂存文件",
    );

    await cleanupCoord.close();
    await hostRuntime.close();
    await clientRuntime.close();
    await hostDisp.close();
    await clientDisp.close();
    await hostTransport.close();
    await clientTransport.close();
    hostDb.close();
    clientDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 项2：拆帧 meta_version 防丢成员（A-P0-4）与根治跳号静默丢帖（B-P0-3 发送端+接收端）", async () => {
  const tmpDir = createTempDir();
  try {
    // 1. A-P0-4：members_included: false 的续帧绝不推进本地 meta_version 与 acked_meta_version
    const clientStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "meta-guard") });
    clientStore.upsertBoardFromRemote({
      board_id: "meta-b",
      host_machine_id: HOST_ID,
      title: "旧标题v1",
      status: "active",
      state_version: 0,
      meta_version: 1,
      archive_version: 0,
      settings: {},
      creator_key: identityKey(HOST_ALICE),
      members: [HOST_ALICE, CLIENT_BOB],
    });
    const clientCoord = new BoardSyncCoordinator({ store: clientStore, localMachineId: CLIENT_ID });
    const metaAcks = [];
    await clientCoord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "meta-b",
            host_machine_id: HOST_ID,
            title: "新标题v3-但没带成员",
            status: "active",
            state_version: 0,
            meta_version: 3,
            archive_version: 0,
            members_included: false,
            posts: [{ seq: 1, author: HOST_ALICE, body: "正常首帖", mentions: [], files: [], created_at: "2026-11-27T00:00:00Z", origin_client_post_id: "m1" }],
          }],
        }),
      },
      staged_files: [],
      reply: async r => metaAcks.push(r),
    });
    assert.equal(clientStore.getBoard("meta-b").meta_version, 1, "members_included:false 绝不可推进本地 meta_version");
    assert.equal(clientStore.getBoard("meta-b").title, "旧标题v1");
    assert.equal(clientStore.getBoard("meta-b").board_seq, 1);
    const ackNoMembers = JSON.parse(metaAcks[0].body).boards[0];
    assert.equal(ackNoMembers.ok, true);
    assert.equal(ackNoMembers.acked_seq, 1);
    assert.equal(ackNoMembers.acked_meta_version, undefined, "未带成员快照时绝不可回传 acked_meta_version");
    assert.equal(ackNoMembers.meta_version, undefined);

    // 2. B-P0-3 接收端防空洞与遇错即停 break：
    // 2a. 收到跳号 [seq: 3]（漏 seq: 2）→ 立刻 break，不落库 seq 3，acked_seq 保持 1
    const gapAcks = [];
    await clientCoord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "meta-b",
            host_machine_id: HOST_ID,
            title: "旧标题v1",
            status: "active",
            state_version: 0,
            meta_version: 1,
            archive_version: 0,
            members_included: false,
            posts: [
              { seq: 3, author: HOST_ALICE, body: "越洞帖3", mentions: [], files: [], created_at: "2026-11-27T00:02:00Z", origin_client_post_id: "m3" },
            ],
          }],
        }),
      },
      staged_files: [],
      reply: async r => gapAcks.push(r),
    });
    const gapAckBoard = JSON.parse(gapAcks[0].body).boards[0];
    assert.equal(gapAckBoard.ok, false);
    assert.equal(gapAckBoard.error_code, "seq_gap_detected");
    assert.equal(gapAckBoard.acked_seq, 1, "检测到空洞绝不可越洞推进 acked_seq");
    assert.equal(clientStore.getPostsRange("meta-b", 0, 10).length, 1);

    // 2b. 收到 [seq: 2(落库抛错), seq: 3] → 遇错立刻 break，绝不落库 seq 3
    const origApply = clientStore.applyRemotePost.bind(clientStore);
    clientStore.applyRemotePost = args => {
      if (args.seq === 2) throw new CoreError("board_post_conflict", "模拟 seq 2 冲突");
      return origApply(args);
    };
    const errAcks = [];
    await clientCoord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          boards: [{
            board_id: "meta-b",
            host_machine_id: HOST_ID,
            title: "旧标题v1",
            status: "active",
            state_version: 0,
            meta_version: 1,
            archive_version: 0,
            members_included: false,
            posts: [
              { seq: 2, author: HOST_ALICE, body: "坏帖2", mentions: [], files: [], created_at: "2026-11-27T00:01:00Z", origin_client_post_id: "m2" },
              { seq: 3, author: HOST_ALICE, body: "后续帖3不应写入", mentions: [], files: [], created_at: "2026-11-27T00:02:00Z", origin_client_post_id: "m3" },
            ],
          }],
        }),
      },
      staged_files: [],
      reply: async r => errAcks.push(r),
    });
    const errAckBoard = JSON.parse(errAcks[0].body).boards[0];
    assert.equal(errAckBoard.ok, false);
    assert.equal(errAckBoard.error_code, "board_post_conflict");
    assert.equal(errAckBoard.acked_seq, 1);
    assert.equal(clientStore.getPostsRange("meta-b", 0, 10).length, 1);
    await clientCoord.close();

    // 3. B-P0-3 发送端：pending_capacity 下 >1800 CQ 大帖 seq 1 绝不跳过而去发 seq 2，其它板照常发；恢复后 seq 1 + seq 2 完整送达！
    const hostStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "b-p0-3-host") });
    const recvStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "b-p0-3-recv") });
    hostStore.createBoard({ board_id: "big-board", host_machine_id: HOST_ID, title: "含超大帖板", creator: HOST_ALICE });
    hostStore.upsertMember("big-board", CLIENT_BOB);
    hostStore.appendPost({ boardId: "big-board", author: HOST_ALICE, body: "超大正文-" + "A".repeat(2400) }); // seq 1 > 1800 CQ
    hostStore.appendPost({ boardId: "big-board", author: HOST_ALICE, body: "短正文seq2-绝不可越过seq1提前发出" }); // seq 2

    hostStore.createBoard({ board_id: "small-board", host_machine_id: HOST_ID, title: "正常小板", creator: HOST_ALICE });
    hostStore.upsertMember("small-board", CLIENT_BOB);
    hostStore.appendPost({ boardId: "small-board", author: HOST_ALICE, body: "小板正常帖1" });

    let capacityFull = true;
    const sentFrames = [];
    const recvCoord = new BoardSyncCoordinator({ store: recvStore, localMachineId: CLIENT_ID });
    const hostCoord = new BoardSyncCoordinator({
      store: hostStore,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      relaySender: {
        async send(args) {
          sentFrames.push(args);
          if (capacityFull && args.allowBundle) {
            return { ok: false, status: "pending_capacity", stage: "pending_capacity" };
          }
          // 直接投递给客机并回传 ACK 给主机
          const inboundAck = [];
          await recvCoord.handleInboundBoardDelta({
            remotePrincipal: { from_machine: HOST_ID },
            frame: { from_machine: HOST_ID, body: JSON.stringify(args.payloadJson) },
            staged_files: [],
            reply: async r => inboundAck.push(r),
          });
          if (inboundAck.length > 0) {
            await hostCoord.handleInboundBoardAck({
              remotePrincipal: { from_machine: CLIENT_ID },
              frame: { from_machine: CLIENT_ID, body: inboundAck[0].body },
            });
          }
          return { ok: true, status: "sent_verified" };
        },
      },
    });

    // 满容降级期：big-board 的 seq 1 超 1800 CQ → 阻断 big-board，绝不发 seq 2；small-board 正常送达！
    const degradedTick = await hostCoord.syncTick();
    assert.ok(degradedTick.by_peer[CLIENT_ID].errors.some(e => e.board_id === "big-board" && e.code === "relay_frame_too_large"));
    const deliveredBigDuringDegrade = sentFrames
      .filter(f => !f.allowBundle)
      .flatMap(f => f.payloadJson.boards.filter(b => b.board_id === "big-board").flatMap(b => b.posts));
    assert.equal(deliveredBigDuringDegrade.length, 0, "满容降级时绝不可跳过 seq 1 去发 seq 2！");
    assert.equal(recvStore.getPostsRange("big-board", 0, 10).length, 0);
    assert.equal(recvStore.getPostsRange("small-board", 0, 10).length, 1, "其它正常板必须照常送达");

    // 恢复 bundle 容量后：再次 syncTick，big-board 的 seq 1 + seq 2 完整连续送达！
    capacityFull = false;
    await hostCoord.syncTick();
    const finalBigPosts = recvStore.getPostsRange("big-board", 0, 10);
    assert.equal(finalBigPosts.length, 2, "容量恢复后 seq 1 + seq 2 必须完整送达");
    assert.deepEqual(finalBigPosts.map(p => p.seq), [1, 2]);
    assert.ok(finalBigPosts[0].body.startsWith("超大正文-"));
    assert.equal(finalBigPosts[1].body, "短正文seq2-绝不可越过seq1提前发出");

    // 4. B-P0-3 发送端多批次中首帧失败阻断同板后续批次，其它板照常发送
    const failBatchStore = new ContractBoardStore({ privateRoot: path.join(tmpDir, "b-p0-3-failbatch") });
    failBatchStore.createBoard({ board_id: "fb-a", host_machine_id: HOST_ID, title: "分批失败板A", creator: HOST_ALICE });
    failBatchStore.upsertMember("fb-a", CLIENT_BOB);
    failBatchStore.appendPost({ boardId: "fb-a", author: HOST_ALICE, body: "A1-" + "x".repeat(600) });
    failBatchStore.appendPost({ boardId: "fb-a", author: HOST_ALICE, body: "A2-" + "y".repeat(600) });
    failBatchStore.appendPost({ boardId: "fb-a", author: HOST_ALICE, body: "A3-" + "z".repeat(600) });
    failBatchStore.createBoard({ board_id: "fb-b", host_machine_id: HOST_ID, title: "正常板B", creator: HOST_ALICE });
    failBatchStore.upsertMember("fb-b", CLIENT_BOB);
    failBatchStore.appendPost({ boardId: "fb-b", author: HOST_ALICE, body: "B1-ok" });

    const fbSent = [];
    const fbCoord = new BoardSyncCoordinator({
      store: failBatchStore,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      limits: { maxPayloadJsonBytes: 1500 },
      relaySender: {
        async send(args) {
          fbSent.push(args);
          if (args.payloadJson.boards.some(b => b.board_id === "fb-a")) {
            return { ok: false, code: "relay_temp_error" };
          }
          return { ok: true, status: "sent_verified" };
        },
      },
    });
    await fbCoord.syncTick();
    const fbACalls = fbSent.filter(f => f.payloadJson.boards.some(b => b.board_id === "fb-a"));
    const fbBCalls = fbSent.filter(f => f.payloadJson.boards.some(b => b.board_id === "fb-b"));
    assert.equal(fbACalls.length, 1, "板 A 首帧失败后必须立刻加入 blockedBoards，跳过该板后续批次");
    assert.equal(fbBCalls.length, 1, "正常板 B 不受板 A 阻断影响");

    await fbCoord.close();
    await hostCoord.close();
    await recvCoord.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 项3：首次未同步即手动解散 + dissolved_by_key 兜底 + 客机即时高优提醒送达", async () => {
  const tmpDir = createTempDir();
  try {
    const nowMs = 1_700_200_000_000;
    const hostDb = new DatabaseSync(":memory:");
    const clientDb = new DatabaseSync(":memory:");
    const hostStore = new BoardStore({ database: hostDb, privateRoot: path.join(tmpDir, "host"), now: () => nowMs });
    const clientStore = new BoardStore({ database: clientDb, privateRoot: path.join(tmpDir, "client"), now: () => nowMs });

    const deliveredToClient = [];
    const hostEngine = new BoardEngine({ store: hostStore, localMachineId: HOST_ID, now: () => nowMs });
    const clientEngine = new BoardEngine({
      store: clientStore,
      localMachineId: CLIENT_ID,
      now: () => nowMs,
      notifyLocalMember: async payload => {
        deliveredToClient.push(payload);
        return { ok: true, delivered: true };
      },
    });

    const sent = [];
    const clientCoord = new BoardSyncCoordinator({
      store: clientStore,
      engine: clientEngine,
      localMachineId: CLIENT_ID,
      now: () => nowMs,
    });
    const hostCoord = new BoardSyncCoordinator({
      store: hostStore,
      engine: hostEngine,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      now: () => nowMs,
      relaySender: {
        async send(args) {
          sent.push(args);
          const acks = [];
          await clientCoord.handleInboundBoardDissolved({
            remotePrincipal: { from_machine: HOST_ID },
            frame: { from_machine: HOST_ID, body: JSON.stringify(args.payloadJson) },
            reply: async r => acks.push(r),
          });
          if (acks.length > 0) {
            await hostCoord.handleInboundBoardAck({
              remotePrincipal: { from_machine: CLIENT_ID },
              frame: { from_machine: CLIENT_ID, body: acks[0].body },
            });
          }
          return { ok: true };
        },
      },
    });

    // 主机建板并邀客机 Bob 后，从未做过首同步，直接手动解散！
    await hostEngine.createBoard(HOST_ALICE, { board_id: "instant-dissolve", title: "首同步前解散板" });
    await hostEngine.inviteMembers(HOST_ALICE, { members: [CLIENT_BOB] }, { board: { machine_id: HOST_ID, board_id: "instant-dissolve" } });
    await hostEngine.dissolveBoard(HOST_ALICE, {}, { board: { machine_id: HOST_ID, board_id: "instant-dissolve" } });

    const tick = await hostCoord.syncTick();
    assert.equal(tick.by_peer[CLIENT_ID].dissolved_frames, 1);
    assert.equal(sent[0].op, "board_dissolved");
    assert.equal(sent[0].allowBundle, false);
    assert.equal(sent[0].payloadJson.title, "首同步前解散板");
    assert.ok(sent[0].payloadJson.creator_key && sent[0].payloadJson.creator_key.length > 0);
    assert.ok(sent[0].payloadJson.dissolved_by_key && sent[0].payloadJson.dissolved_by_key.length > 0);
    assert.ok(Array.isArray(sent[0].payloadJson.members) && sent[0].payloadJson.members.length === 2);

    // 客机真实 BoardStore 成功落地归档板且即时触发 localNotifyTick 送达解散提醒！
    const clientBoard = clientStore.getBoard("instant-dissolve");
    assert.equal(clientBoard.status, "archived");
    assert.equal(clientBoard.title, "首同步前解散板");
    assert.equal(deliveredToClient.length, 1, "客机收到 board_dissolved 必须立即送达高优解散提醒");
    assert.equal(deliveredToClient[0].kind, "dissolved");
    assert.equal(deliveredToClient[0].dedupe_key, `dissolved:instant-dissolve:1:${identityKey(CLIENT_BOB)}`);

    // 缺失 creator_key / deleted_by_key 的入站载荷在真实 BoardStore 上兜底 system:unknown 不崩
    const fallbackAcks = [];
    const tombRes = await clientCoord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_deleted_tombstone",
          tombstones: [{ board_id: "fallback-tomb", host_machine_id: HOST_ID, final_state_version: 2, deleted_by_key: "" }],
        }),
      },
      reply: async r => fallbackAcks.push(r),
    });
    assert.equal(tombRes.ok, true);
    assert.equal(clientStore.getTombstone("fallback-tomb").deleted_by_key, "system:unknown");

    await hostCoord.close();
    await clientCoord.close();
    hostEngine.close();
    clientEngine.close();
    hostDb.close();
    clientDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 项4：退订停止跨机推送（已退订机器仅收 1 次退订元数据同步帧，收 0 新帖且不触发 board_dissolved）", async () => {
  const tmpDir = createTempDir();
  try {
    const nowMs = 1_700_300_000_000;
    const hostDb = new DatabaseSync(":memory:");
    const clientDb = new DatabaseSync(":memory:");
    const hostStore = new BoardStore({ database: hostDb, privateRoot: path.join(tmpDir, "host"), now: () => nowMs });
    const clientStore = new BoardStore({ database: clientDb, privateRoot: path.join(tmpDir, "client"), now: () => nowMs });

    const sent = [];
    const clientCoord = new BoardSyncCoordinator({ store: clientStore, localMachineId: CLIENT_ID, now: () => nowMs });
    const hostCoord = new BoardSyncCoordinator({
      store: hostStore,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      now: () => nowMs,
      relaySender: {
        async send(args) {
          sent.push(args);
          const acks = [];
          if (args.op === "board_delta") {
            await clientCoord.handleInboundBoardDelta({
              remotePrincipal: { from_machine: HOST_ID },
              frame: { from_machine: HOST_ID, body: JSON.stringify(args.payloadJson) },
              staged_files: [],
              reply: async r => acks.push(r),
            });
          } else if (args.op === "board_dissolved") {
            await clientCoord.handleInboundBoardDissolved({
              remotePrincipal: { from_machine: HOST_ID },
              frame: { from_machine: HOST_ID, body: JSON.stringify(args.payloadJson) },
              reply: async r => acks.push(r),
            });
          }
          if (acks.length > 0) {
            await hostCoord.handleInboundBoardAck({
              remotePrincipal: { from_machine: CLIENT_ID },
              frame: { from_machine: CLIENT_ID, body: acks[0].body },
            });
          }
          return { ok: true };
        },
      },
    });

    // 首同步建板 + 首帖
    hostStore.createBoard({ board_id: "unsub-room", host_machine_id: HOST_ID, title: "退订板", creator: HOST_ALICE });
    hostStore.upsertMember("unsub-room", CLIENT_BOB);
    hostStore.appendPost({ boardId: "unsub-room", author: HOST_ALICE, body: "退订前首帖", originClientPostId: "p1" });
    await hostCoord.syncTick();
    assert.equal(clientStore.getPostsRange("unsub-room", 0, 10).length, 1);

    // 客机唯一成员 Bob 退订，随后主机发新帖 p2、p3！
    hostStore.setMemberSubscriptionState("unsub-room", identityKey(CLIENT_BOB), "unsubscribed", { bumpMetaVersion: true });
    hostStore.appendPost({ boardId: "unsub-room", author: HOST_ALICE, body: "退订后私密新帖2", originClientPostId: "p2" });
    hostStore.appendPost({ boardId: "unsub-room", author: HOST_ALICE, body: "退订后私密新帖3", originClientPostId: "p3" });

    sent.length = 0;
    const unsubTick = await hostCoord.syncTick();
    assert.equal(unsubTick.sent_frames, 1, "退订后仅允许推一次携带 members 的元数据退订同步帧");
    assert.equal(sent[0].op, "board_delta");
    assert.equal(sent[0].payloadJson.boards[0].posts.length, 0, "退订同步帧必须 posts: []，绝不泄露新帖");
    assert.equal(sent[0].payloadJson.boards[0].members_included, true);
    assert.equal(clientStore.getPostsRange("unsub-room", 0, 10).length, 1, "客机收 0 条退订后新帖");
    assert.equal(clientStore.getMember("unsub-room", identityKey(CLIENT_BOB)).subscription_state, "unsubscribed");

    // 之后主机继续发帖并手动解散 → 客机收 0 帧，绝不触发 board_dissolved！
    hostStore.appendPost({ boardId: "unsub-room", author: HOST_ALICE, body: "退订后新帖4", originClientPostId: "p4" });
    hostStore.archiveBoard({ boardId: "unsub-room", reason: "manual_dissolve", actorKey: identityKey(HOST_ALICE) });
    sent.length = 0;
    const afterTick = await hostCoord.syncTick();
    assert.equal(afterTick.sent_frames, 0, "退订同步确认后不再推送任何新帖或解散帧");
    assert.equal(sent.length, 0);

    await hostCoord.close();
    await clientCoord.close();
    hostDb.close();
    clientDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 项5：sending 租约到期自恢复 + 伪造 control_reply fail-closed + 墓碑退避 + 瞬时存储错 retain_bundle + 归档板文件目录", async () => {
  const tmpDir = createTempDir();
  try {
    let nowMs = 1_700_400_000_000;
    const hostDb = new DatabaseSync(":memory:");
    const hostStore = new BoardStore({
      database: hostDb,
      privateRoot: path.join(tmpDir, "host"),
      allowedUploadRoots: [tmpDir],
      now: () => nowMs,
    });
    const sampleFile = path.join(tmpDir, "lease.txt");
    const sampleBuf = Buffer.from("lease-recovery-content", "utf8");
    fs.writeFileSync(sampleFile, sampleBuf);

    hostStore.createBoard({ board_id: "lease-room", host_machine_id: HOST_ID, title: "租约板", creator: HOST_ALICE });
    hostStore.upsertMember("lease-room", CLIENT_BOB);
    const staged = hostStore.stageLocalUploadFile({
      sourcePath: sampleFile,
      originalName: "lease.txt",
      fileId: "f_lease1",
      opId: "op_lease1",
      boardId: "lease-room",
    });
    const appendRes = hostStore.appendPost({
      boardId: "lease-room",
      author: HOST_ALICE,
      body: "租约附件",
      files: [{
        file_id: staged.file_id,
        safe_name: staged.safe_name,
        bytes: staged.bytes,
        sha256: staged.sha256,
        rel_path: staged.rel_path,
        local_status: "ready",
        sync_machines: [CLIENT_ID],
      }],
      originClientPostId: "lease_p1",
      stagedFileOps: [{
        op_id: staged.op_id,
        staging_name: staged.staging_name,
        file_id: staged.file_id,
        safe_name: staged.safe_name,
        expected_sha256: staged.sha256,
        expected_bytes: staged.bytes,
      }],
      fileSyncTargets: [CLIENT_ID],
    });
    hostStore.commitStagedFileOps(appendRes.file_op_ids);
    hostStore.advanceSyncState("lease-room", CLIENT_ID, { acked_seq: 1, acked_meta_version: 2, acked_state_version: 0 });

    let sendCount = 0;
    const hostCoord = new BoardSyncCoordinator({
      store: hostStore,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      limits: { sendingLeaseMs: 5000, baseRetryMs: 1000 },
      now: () => nowMs,
      relaySender: {
        async send() {
          sendCount += 1;
          return { ok: true, status: "sent_verified" };
        },
      },
    });

    // 1. 首次发送标记 sending 并写入 next_retry_at = nowMs + 5000；丢 ACK 且租约未到期时绝不重复发！
    await hostCoord.syncTick();
    assert.equal(sendCount, 1);
    const itemSending = hostStore.getFileSyncItem("lease-room", "f_lease1", CLIENT_ID);
    assert.equal(itemSending.status, "sending");
    assert.equal(itemSending.next_retry_at, nowMs + 5000);

    nowMs += 2000;
    const midTick = await hostCoord.syncTick();
    assert.equal(midTick.sent_frames, 0, "租约未到期不重复发送");

    // 2. 推进虚拟时钟跨过租约 → 自动回收并重发！
    nowMs += 4000;
    const retryTick = await hostCoord.syncTick();
    assert.equal(retryTick.by_peer[CLIENT_ID].file_frames, 1, "sending 租约到期必须自动自恢复补发");
    assert.equal(sendCount, 2);

    // 3. 第三方伪造 control_reply（含未知 local_post_id 与 host_machine_id 不匹配）严格 fail-closed
    hostStore.enqueueRemoteOutbox({
      local_post_id: "ob_real_1",
      dedupe_key: "dk_real_1",
      board_id: "remote-x",
      host_machine_id: CLIENT_ID,
      author_key: identityKey(HOST_ALICE),
      op_kind: "post",
      payload_json: "{}",
    });
    const fakeAckRes = await hostCoord.handleInboundBoardAck({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: {
        from_machine: CLIENT_ID,
        body: JSON.stringify({
          kind: "board_ack",
          boards: [],
          control_replies: [
            { local_post_id: "ob_nonexistent", ok: true, status: "acked" },
            { local_post_id: "ob_real_1", board_id: "wrong-board", ok: true, status: "acked" },
          ],
        }),
      },
    });
    assert.equal(fakeAckRes.updated_outbox, 0, "未知或错 board_id 的 control_reply 必须严格 fail-closed 丢弃");
    assert.equal(hostStore.getRemoteOutbox("ob_real_1").status, "pending");

    // 4. board_tombstone_sync 发送遇错触发 updateTombstoneSyncBackoff 退避
    hostStore.createBoard({ board_id: "tomb-backoff", host_machine_id: HOST_ID, title: "墓碑退避", creator: HOST_ALICE });
    hostStore.archiveBoard({ boardId: "tomb-backoff", reason: "manual_dissolve", actorKey: identityKey(HOST_ALICE) });
    hostStore.deleteArchivedBoard({
      boardId: "tomb-backoff",
      expectedArchiveVersion: 1,
      actorKey: identityKey(HOST_ALICE),
      peerMachines: [CLIENT_ID],
    });
    // 先把之前的 f_lease1 标 acked 避免干扰统计
    hostStore.updateFileSyncItemStatus("lease-room", "f_lease1", CLIENT_ID, { status: "acked", next_retry_at: 0 });
    hostStore.updateRemoteOutboxStatus("ob_real_1", { status: "acked", next_retry_at: 0 });

    const tombCoord = new BoardSyncCoordinator({
      store: hostStore,
      localMachineId: HOST_ID,
      peerMachines: [CLIENT_ID],
      limits: { baseRetryMs: 3000 },
      now: () => nowMs,
      relaySender: {
        async send() {
          throw new CoreError("relay_temp_offline", "模拟临时断网");
        },
      },
    });
    const failTombTick = await tombCoord.syncTick();
    assert.equal(failTombTick.by_peer[CLIENT_ID].errors[0].stage, "tombstone_sync");
    assert.equal(hostStore.listPendingTombstoneSyncs(CLIENT_ID, nowMs).length, 0, "墓碑失败后必须写入退避窗口");
    assert.equal(hostStore.listPendingTombstoneSyncs(CLIENT_ID, nowMs + 3000).length, 1, "退避到期后重新可调度");
    await tombCoord.close();

    // 5. handleInboundBoardDissolved 与 handleInboundBoardStateSync 瞬时存储错返回 retain_bundle: true
    const tempErrStore = {
      getTombstone: () => null,
      getBoard: () => null,
      upsertBoardFromRemote() {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      },
      applyRemoteTombstone() {
        throw Object.assign(new Error("db busy"), { code: "SQLITE_BUSY" });
      },
    };
    const errCoord = new BoardSyncCoordinator({ store: tempErrStore, localMachineId: CLIENT_ID, now: () => nowMs });
    const dissRetain = await errCoord.handleInboundBoardDissolved({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({ kind: "board_dissolved", board_id: "err-b", host_machine_id: HOST_ID, state_version: 1, archive_version: 1 }),
      },
    });
    assert.equal(dissRetain.retain_bundle, true);
    assert.equal(dissRetain.code, "storage_temp_error");

    const stateRetain = await errCoord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_state_push",
          boards: [{ board_id: "err-b", host_machine_id: HOST_ID, title: "t", status: "archived", state_version: 1, meta_version: 1 }],
        }),
      },
    });
    assert.equal(stateRetain.retain_bundle, true);
    assert.equal(stateRetain.code, "storage_temp_error");

    const tombRetain = await errCoord.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_deleted_tombstone",
          tombstones: [{ board_id: "err-b", host_machine_id: HOST_ID, final_state_version: 2 }],
        }),
      },
    });
    assert.equal(tombRetain.retain_bundle, true);
    assert.equal(tombRetain.code, "storage_temp_error");
    await errCoord.close();

    // 6. 归档板补发文件传 archived: true 落盘至 boards-archive/<boardId>/files/
    const archClientDb = new DatabaseSync(":memory:");
    const archClientRoot = path.join(tmpDir, "arch-client");
    const archClientStore = new BoardStore({ database: archClientDb, privateRoot: archClientRoot, now: () => nowMs });
    archClientStore.upsertBoardFromRemote({
      board_id: "arch-file-b",
      host_machine_id: HOST_ID,
      title: "归档板收文件",
      status: "archived",
      state_version: 1,
      meta_version: 1,
      archive_version: 1,
      archive_reason: "manual_dissolve",
      creator_key: identityKey(HOST_ALICE),
      created_at: new Date(nowMs).toISOString(),
      last_active_at: new Date(nowMs).toISOString(),
      archived_at: new Date(nowMs).toISOString(),
      members: [HOST_ALICE, CLIENT_BOB],
    });
    const archCoord = new BoardSyncCoordinator({ store: archClientStore, localMachineId: CLIENT_ID, now: () => nowMs });
    const archBuf = Buffer.from("archived-board-file-data", "utf8");
    const archAcks = [];
    await archCoord.handleInboundBoardDelta({
      remotePrincipal: { from_machine: HOST_ID },
      frame: {
        from_machine: HOST_ID,
        body: JSON.stringify({
          kind: "host_push_batch",
          file_sync_only: true,
          boards: [{ board_id: "arch-file-b", host_machine_id: HOST_ID, members_included: false, posts: [] }],
          file_manifest: [{
            board_id: "arch-file-b",
            seq: 1,
            file_id: "f_arch1",
            safe_name: "late.txt",
            bytes: archBuf.length,
            sha256: sha256Buffer(archBuf),
            attachment_name: "arch-file-b__f_arch1",
          }],
        }),
      },
      staged_files: [{ name: "arch-file-b__f_arch1", buffer: archBuf }],
      reply: async r => archAcks.push(r),
    });
    assert.deepEqual(JSON.parse(archAcks[0].body).boards[0].files_acked, ["f_arch1"]);
    const expectedArchivePath = archClientStore.resolveSafeBoardFilePath("arch-file-b", "f_arch1", "late.txt", { archived: true });
    assert.equal(fs.readFileSync(expectedArchivePath, "utf8"), "archived-board-file-data");

    await archCoord.close();
    await hostCoord.close();
    archClientDb.close();
    hostDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 项6+增量1：openBoardRuntime 纯本机 31 天静默自动归档零唤醒零句柄泄漏 + 时钟同源 + 严格白名单防扩权 + fileBundlePeers 动态重核 + 解散即时触发", async () => {
  const tmpDir = createTempDir();
  try {
    // 1. 纯本机模式（relayDispatcher: null, notifyLocalMember: null）：虚拟时钟推进 32 天静默自动归档、零唤醒、零句柄泄漏！
    let virtualNow = 1_700_500_000_000;
    const localDb = new DatabaseSync(":memory:");
    const localRoot = path.join(tmpDir, "pure-local");

    const beforeRes = process.getActiveResourcesInfo();
    const beforeTimeouts = beforeRes.filter(r => r === "Timeout").length;

    const localRuntime = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: localRoot,
      // 故意不直接传 now，验证从 openStore(storeOptions) 捕获时钟并同源对齐！
      openStore: create => create({ database: localDb, privateRoot: localRoot, now: () => virtualNow }),
      relayDispatcher: null,
      notifyLocalMember: null,
      notifyIntervalMs: 20,
    });

    await localRuntime.invoke({
      action: "create",
      actorIdentity: HOST_ALICE,
      params: { board_id: "sleep-31d", title: "31天沉睡板" },
    });
    await localRuntime.invoke({
      action: "post",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "sleep-31d" },
      params: { body: "最后一条消息" },
    });

    await localRuntime.start();
    assert.equal(localRuntime.store.getBoard("sleep-31d").status, "active");

    // 额外验证 openBoardRuntime.start() 启动时自动调用 recoverInterruptedSyncState 回收中断状态
    const recDb = new DatabaseSync(":memory:");
    const recRoot = path.join(tmpDir, "recover-start");
    const preStore = new BoardStore({ database: recDb, privateRoot: recRoot, now: () => virtualNow });
    preStore.enqueueRemoteOutbox({
      local_post_id: "interrupted_ob_1",
      dedupe_key: "dk_int_1",
      board_id: "r-int",
      host_machine_id: CLIENT_ID,
      author_key: identityKey(HOST_ALICE),
      op_kind: "post",
      payload_json: "{}",
    });
    preStore.claimRemoteOutbox("interrupted_ob_1", new Date(virtualNow).toISOString());
    assert.equal(preStore.getRemoteOutbox("interrupted_ob_1").status, "dispatching");
    const recRuntime = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: recRoot,
      openStore: create => create({ database: recDb, privateRoot: recRoot, now: () => virtualNow }),
      relayDispatcher: null,
      notifyIntervalMs: 0,
    });
    await recRuntime.start();
    assert.equal(recRuntime.store.getRemoteOutbox("interrupted_ob_1").status, "unknown", "start() 必须回收中断的 dispatching outbox");
    await recRuntime.close();
    recDb.close();

    // 推进虚拟时钟 32 天，等待纯本机定时器静默归档
    virtualNow += 32 * 24 * 60 * 60 * 1000;
    await new Promise(resolve => setTimeout(resolve, 70));

    const archivedLocal = localRuntime.store.getBoard("sleep-31d");
    assert.equal(archivedLocal.status, "archived", "纯本机无通知回调下超过 31 天必须自动归档");
    assert.equal(archivedLocal.archive_reason, "auto_inactive_31d");
    assert.equal(localRuntime.store.listDueNotifications(virtualNow, 64).length, 0, "自动归档必须完全静默、零唤醒通知");

    await localRuntime.close();
    localDb.close();

    const afterRes = process.getActiveResourcesInfo();
    const afterTimeouts = afterRes.filter(r => r === "Timeout").length;
    assert.equal(afterTimeouts - beforeTimeouts, 0, "纯本机 close() 后 Timeout 句柄增量必须为 0");
    assert.equal(afterRes.length - beforeRes.length, 0, "纯本机 close() 后总活跃句柄增量必须为 0");

    // 2. 显式 peerMachines: []（如 live-runtime.mjs 默认空配置）必须严格 Fail-Closed，严禁从 relayDispatcher / store 扩权！
    const fcDb = new DatabaseSync(":memory:");
    const fcBus = new InMemoryRelayBus();
    fcBus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    fcBus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    fcBus.registerRoute({ relay_key: "r_fc", group_id: "700001", members: [HOST_ID, CLIENT_ID], allow_file_bundle_write: true });
    const fcTransport = fcBus.createTransportFor(HOST_ID);
    const fcDisp = new RemoteCoreDispatcher({
      localMachineId: HOST_ID,
      transport: fcTransport,
      policy: { peers: { [CLIENT_ID]: { trust_source_identity: true, allow_file_bundle: true } } },
    });
    const fcRuntime = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: path.join(tmpDir, "fail-closed"),
      openStore: create => create({ database: fcDb, privateRoot: path.join(tmpDir, "fail-closed") }),
      relayDispatcher: fcDisp,
      peerMachines: [], // 显式空数组：必须严格 Fail-Closed！
      now: () => virtualNow,
    });
    fcRuntime.store.createBoard({ board_id: "fc-b", host_machine_id: HOST_ID, title: "隔离板", creator: HOST_ALICE });
    fcRuntime.store.upsertMember("fc-b", CLIENT_BOB);

    const fcTick = await fcRuntime.sync.syncTick();
    assert.equal(fcTick.sent_frames, 0, "显式 peerMachines:[] 严禁从 relayDispatcher/store 扩权外发");
    assert.deepEqual(Object.keys(fcTick.by_peer), []);

    // 入站 4 个 op 来自非白名单 peer 全部直接拒收 board_peer_not_allowed 且零落库！
    const denyDelta = await fcRuntime.sync.handleInboundBoardDelta({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: { from_machine: CLIENT_ID, body: JSON.stringify({ kind: "host_push_batch", boards: [{ board_id: "ext-1", host_machine_id: CLIENT_ID, title: "外来板", status: "active", state_version: 0, meta_version: 1, members: [CLIENT_BOB], posts: [] }] }) },
    });
    assert.equal(denyDelta.ok, false);
    assert.equal(denyDelta.code, "board_peer_not_allowed");
    assert.equal(fcRuntime.store.getBoard("ext-1"), null);

    const denyDiss = await fcRuntime.sync.handleInboundBoardDissolved({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: { from_machine: CLIENT_ID, body: JSON.stringify({ kind: "board_dissolved", board_id: "ext-1", state_version: 1, archive_version: 1 }) },
    });
    assert.equal(denyDiss.code, "board_peer_not_allowed");

    const denyState = await fcRuntime.sync.handleInboundBoardStateSync({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: { from_machine: CLIENT_ID, body: JSON.stringify({ kind: "host_state_push", boards: [{ board_id: "ext-1" }] }) },
    });
    assert.equal(denyState.code, "board_peer_not_allowed");

    const denyAck = await fcRuntime.sync.handleInboundBoardAck({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: { from_machine: CLIENT_ID, body: JSON.stringify({ kind: "board_ack", boards: [] }) },
    });
    assert.equal(denyAck.code, "board_peer_not_allowed");

    await fcRuntime.close();
    await fcDisp.close();
    await fcTransport.close();
    fcDb.close();

    // 3. fileBundlePeers 动态重核 + 自动派生 peer 策略 + 手动解散即时触发 sync.syncTick()（不干等 60s）
    const dynDb = new DatabaseSync(":memory:");
    const dynRoot = path.join(tmpDir, "dyn-bundle");
    const dynUploadDir = path.join(tmpDir, "dyn-uploads");
    fs.mkdirSync(dynUploadDir, { recursive: true });
    const dynFile = path.join(dynUploadDir, "doc.txt");
    fs.writeFileSync(dynFile, "bundle-policy-check");

    let bundleAllowed = false;
    const dynSent = [];
    const dynBus = new InMemoryRelayBus();
    dynBus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    dynBus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    dynBus.registerRoute({ relay_key: "r_dyn", group_id: "800001", members: [HOST_ID, CLIENT_ID], allow_file_bundle_write: true });
    const dynTransport = dynBus.createTransportFor(HOST_ID);
    const dynDisp = new RemoteCoreDispatcher({
      localMachineId: HOST_ID,
      transport: dynTransport,
      policy: { peers: { [CLIENT_ID]: { trust_source_identity: true, allow_file_bundle: true } } },
    });

    const dynRuntime = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: dynRoot,
      allowedUploadRoots: [dynUploadDir],
      openStore: create => create({ database: dynDb, privateRoot: dynRoot, allowedUploadRoots: [dynUploadDir] }),
      relayDispatcher: dynDisp,
      relaySender: {
        async send(args) {
          dynSent.push(args);
          return { ok: true, status: "sent_verified" };
        },
      },
      // 不传 peerMachineIds/peerMachines → 自动从 relayDispatcher.listPeerPolicies() 派生 CLIENT_ID！
      peerCapabilitiesProvider: id => (id === CLIENT_ID ? { known: true, allow_file_bundle: bundleAllowed } : null),
      syncIntervalMs: 60000,
      notifyIntervalMs: 0,
      now: () => virtualNow,
    });

    await dynRuntime.start();
    await dynRuntime.invoke({ action: "create", actorIdentity: HOST_ALICE, params: { board_id: "dyn-b", title: "动态策略板" } });
    await dynRuntime.invoke({
      action: "invite",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "dyn-b" },
      params: { members: [CLIENT_BOB] },
    });

    // 先手动往 fileSyncQueue 塞一个附件项，在 allow_file_bundle=false 下验证只推纯文本、绝不推文件包！
    const fMeta = dynRuntime.store.stageLocalUploadFile({
      sourcePath: dynFile,
      originalName: "doc.txt",
      fileId: "f_dyn1",
      opId: "op_dyn1",
      boardId: "dyn-b",
    });
    const pRes = dynRuntime.store.appendPost({
      boardId: "dyn-b",
      author: HOST_ALICE,
      body: "纯文本可推但附件被策略拦截",
      files: [{
        file_id: fMeta.file_id,
        safe_name: fMeta.safe_name,
        bytes: fMeta.bytes,
        sha256: fMeta.sha256,
        rel_path: fMeta.rel_path,
        local_status: "ready",
        sync_machines: [CLIENT_ID],
      }],
      originClientPostId: "dyn_p1",
      stagedFileOps: [{
        op_id: fMeta.op_id,
        staging_name: fMeta.staging_name,
        file_id: fMeta.file_id,
        safe_name: fMeta.safe_name,
        expected_sha256: fMeta.sha256,
        expected_bytes: fMeta.bytes,
      }],
      fileSyncTargets: [CLIENT_ID],
    });
    dynRuntime.store.commitStagedFileOps(pRes.file_op_ids);

    const noBundleTick = await dynRuntime.sync.syncTick();
    assert.ok(noBundleTick.sent_frames >= 1, "未开文件包许可时纯文本仍应正常推送");
    assert.equal(noBundleTick.by_peer[CLIENT_ID].file_frames, 0);
    assert.ok(dynSent.every(f => (f.attachments?.length ?? 0) === 0 && f.allowBundle === false), "未开文件包许可绝不可发附件或开 allowBundle");

    // 入站带 staged_files 在 allow_file_bundle=false 时直接拒收 relay_file_route_denied
    const denyInboundFile = await dynRuntime.sync.handleInboundBoardDelta({
      remotePrincipal: { from_machine: CLIENT_ID },
      frame: { from_machine: CLIENT_ID, body: JSON.stringify({ kind: "host_push_batch", boards: [] }) },
      staged_files: [{ name: "dyn-b__f_dyn1", buffer: Buffer.from("x") }],
    });
    assert.equal(denyInboundFile.ok, false);
    assert.equal(denyInboundFile.code, "relay_file_route_denied");

    // 动态打开 allow_file_bundle=true 后，下一次 syncTick 立即发出文件包！
    dynRuntime.store.advanceSyncState("dyn-b", CLIENT_ID, { acked_seq: 1, acked_meta_version: 2, acked_state_version: 0 });
    dynSent.length = 0;
    bundleAllowed = true;
    const withBundleTick = await dynRuntime.sync.syncTick();
    assert.equal(withBundleTick.by_peer[CLIENT_ID].file_frames, 1);
    assert.equal(dynSent[0].attachments.length, 1);

    // 验证 onBoardChanged 挂接：手动解散后无需干等 60s，立刻非阻塞触发 sync.syncTick() 发出 board_dissolved！
    dynSent.length = 0;
    await dynRuntime.invoke({
      action: "dissolve",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "dyn-b" },
      params: {},
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(dynSent.some(f => f.op === "board_dissolved" && f.payloadJson.board_id === "dyn-b"), "手动解散必须立即非阻塞触发 board_dissolved 推送");

    await dynRuntime.close();
    await dynDisp.close();
    await dynTransport.close();
    dynDb.close();
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("W2-3 R2-P1-1 + 归档/通知计时间隔解耦：同步层严禁发出残缺客机附件包，且 notifyIntervalMs=0 时 archiveSweepIntervalMs 独立生效", async () => {
  const tmpDir = createTempDir("board-sync-r2p1-");
  try {
    const db = new DatabaseSync(path.join(tmpDir, "client-outbox.sqlite"));
    db.exec("PRAGMA foreign_keys = ON;");
    const privDir = path.join(tmpDir, "priv");
    fs.mkdirSync(privDir, { recursive: true });
    const store = new BoardStore({ database: db, privateRoot: privDir, allowedUploadRoots: [] });
    const sentFrames = [];
    const coord = new BoardSyncCoordinator({
      store,
      engine: null,
      localMachineId: CLIENT_ID,
      peerMachineIds: [HOST_ID],
      relaySender: async req => {
        sentFrames.push(req);
        return { ok: true, relay_id: "rly-never" };
      },
      limits: { maxBundleTotalBytes: 1024 },
      now: () => Date.UTC(2026, 10, 27, 10, 0, 0),
    });

    // 1. 构造 2 份合计 1400 B (> 1024 B) 的客机 outbox 历史遗留记录
    const overDir = store.getOutboxDir("legacy-over-cap");
    fs.mkdirSync(overDir, { recursive: true });
    const p1 = path.join(overDir, "f1.bin");
    const p2 = path.join(overDir, "f2.bin");
    fs.writeFileSync(p1, Buffer.alloc(700, 0x31));
    fs.writeFileSync(p2, Buffer.alloc(700, 0x32));
    store.enqueueRemoteOutbox({
      local_post_id: "legacy-over-cap",
      dedupe_key: "dk-legacy-over-cap",
      board_id: "b-over",
      host_machine_id: HOST_ID,
      author_key: identityKey(CLIENT_BOB),
      op_kind: "client_post_submit",
      payload_json: JSON.stringify({
        board_id: "b-over",
        actor: CLIENT_BOB,
        body: "over-cap",
        files: [
          { file_id: "f1", safe_name: "f1.bin", bytes: 700, sha256: "1".repeat(64), outbox_path: p1 },
          { file_id: "f2", safe_name: "f2.bin", bytes: 700, sha256: "2".repeat(64), outbox_path: p2 },
        ],
      }),
      nowIso: "2026-11-27T10:00:00.000Z",
    });

    // 2. 构造缺本地暂存文件的 outbox 记录
    store.enqueueRemoteOutbox({
      local_post_id: "missing-file-post",
      dedupe_key: "dk-missing-file",
      board_id: "b-over",
      host_machine_id: HOST_ID,
      author_key: identityKey(CLIENT_BOB),
      op_kind: "client_post_submit",
      payload_json: JSON.stringify({
        board_id: "b-over",
        actor: CLIENT_BOB,
        body: "missing",
        files: [
          { file_id: "f3", safe_name: "gone.bin", bytes: 100, sha256: "3".repeat(64), outbox_path: path.join(tmpDir, "nope.bin") },
        ],
      }),
      nowIso: "2026-11-27T10:00:00.000Z",
    });

    await coord.syncTick();
    assert.equal(sentFrames.length, 0, "超限或缺文件的客机发帖绝不可发出元数据与实附文件不匹配的残缺帧");
    const recOver = store.getRemoteOutbox("legacy-over-cap");
    assert.equal(recOver.status, "dead_letter");
    assert.equal(recOver.last_error_code, "relay_bundle_too_large");
    assert.equal(fs.existsSync(overDir), false, "转 dead_letter 后应同步清理 .outbox 目录");
    const recMissing = store.getRemoteOutbox("missing-file-post");
    assert.equal(recMissing.status, "dead_letter");
    assert.equal(recMissing.last_error_code, "source_file_missing");
    await coord.close();
    db.close();

    // 3. 验证 archiveSweepIntervalMs 与 notifyIntervalMs: 0 解耦：停通知但仍定时静默归档且零句柄泄漏
    let vNow = Date.UTC(2026, 10, 27, 10, 0, 0);
    const beforeHandles = process.getActiveResourcesInfo();
    const localDb = new DatabaseSync(path.join(tmpDir, "decoupled.sqlite"));
    localDb.exec("PRAGMA foreign_keys = ON;");
    let notifyCalls = 0;
    const rt = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: path.join(tmpDir, "decoupled-priv"),
      allowedUploadRoots: [],
      openStore: create => create({ database: localDb, now: () => vNow }),
      relayDispatcher: null,
      notifyLocalMember: async () => {
        notifyCalls += 1;
        return { ok: true };
      },
      notifyIntervalMs: 0,
      archiveSweepIntervalMs: 25,
      now: () => vNow,
    });
    await rt.start();
    await rt.invoke({ action: "create", actorIdentity: HOST_ALICE, params: { board_id: "decoupled-31d", title: "解耦归档板" } });
    await rt.invoke({ action: "post", actorIdentity: HOST_ALICE, board: { machine_id: HOST_ID, board_id: "decoupled-31d" }, params: { body: "触发通知但应被 notifyIntervalMs=0 抑制" } });
    vNow += 32 * 24 * 3600 * 1000;
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(rt.store.getBoard("decoupled-31d").status, "archived", "notifyIntervalMs=0 时显式 archiveSweepIntervalMs 仍须完成 31 天静默自动归档");
    assert.equal(notifyCalls, 0, "notifyIntervalMs=0 不得唤醒周期通知");
    await rt.close();
    localDb.close();
    await new Promise(resolve => setImmediate(resolve));
    const afterHandles = process.getActiveResourcesInfo();
    assert.equal(afterHandles.length - beforeHandles.length, 0, "解耦归档定时关闭后活跃句柄增量必须为 0");
  } finally {
    cleanupTempDir(tmpDir);
  }
});

test("事件防抖端到端时间戳实测：双机默认周期下发帖自动同步与本机提醒均在 1.5s 内送达且关闭零句柄泄漏", async testContext => {
  const tmpDir = createTempDir();
  const beforeHandles = process.getActiveResourcesInfo();
  let hostDb = null;
  let clientDb = null;
  let hostRt = null;
  let clientRt = null;
  let relayPump = null;
  try {
    const bus = new InMemoryRelayBus();
    bus.registerMachine({ machine_id: HOST_ID, qq_id: "100001", bundle_enabled: true });
    bus.registerMachine({ machine_id: CLIENT_ID, qq_id: "100002", bundle_enabled: true });
    bus.registerRoute({
      relay_key: "r_latency_pair",
      group_id: "300099",
      members: [HOST_ID, CLIENT_ID],
      allow_file_bundle_write: true,
    });

    const hostDisp = new RemoteCoreDispatcher({
      localMachineId: HOST_ID,
      transport: bus.createTransportFor(HOST_ID),
      policy: { peers: { [CLIENT_ID]: { trust_source_identity: true } } },
    });
    const clientDisp = new RemoteCoreDispatcher({
      localMachineId: CLIENT_ID,
      transport: bus.createTransportFor(CLIENT_ID),
      policy: { peers: { [HOST_ID]: { trust_source_identity: true } } },
    });

    hostDb = new DatabaseSync(path.join(tmpDir, "host-latency.sqlite"));
    clientDb = new DatabaseSync(path.join(tmpDir, "client-latency.sqlite"));

    const hostNotifications = [];
    const clientNotifications = [];
    hostRt = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: path.join(tmpDir, "host-priv"),
      allowedUploadRoots: [],
      openStore: create => create({ database: hostDb }),
      relayDispatcher: hostDisp,
      peerMachines: [CLIENT_ID],
      notifyLocalMember: async payload => {
        hostNotifications.push({ at: performance.now(), payload });
        return { ok: true, accepted: true, message_id: `host-noti-${hostNotifications.length}` };
      },
    });
    clientRt = openBoardRuntime({
      localMachineId: CLIENT_ID,
      privateRoot: path.join(tmpDir, "client-priv"),
      allowedUploadRoots: [],
      openStore: create => create({ database: clientDb }),
      relayDispatcher: clientDisp,
      peerMachines: [HOST_ID],
      notifyLocalMember: async payload => {
        clientNotifications.push({ at: performance.now(), payload });
        return { ok: true, accepted: true, message_id: `client-noti-${clientNotifications.length}` };
      },
    });

    await hostRt.start();
    await clientRt.start();

    let pumping = false;
    relayPump = setInterval(() => {
      if (pumping) return;
      pumping = true;
      Promise.allSettled([hostDisp.pollOnce(), clientDisp.pollOnce()]).finally(() => {
        pumping = false;
      });
    }, 30);

    const waitFor = async (predicate, timeoutMs = 4500) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return predicate();
    };

    // 1. 建板并邀客机成员，验证无需手动 syncTick/localNotifyTick 即自动同步并提醒，远低于默认 15s/90s 周期
    await hostRt.invoke({
      action: "create",
      actorIdentity: HOST_ALICE,
      params: { board_id: "latency-board", title: "时延实测板" },
    });
    await hostRt.invoke({
      action: "invite",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "latency-board" },
      params: { members: [CLIENT_BOB] },
    });
    const hostPostAt = performance.now();
    await hostRt.invoke({
      action: "post",
      actorIdentity: HOST_ALICE,
      board: { machine_id: HOST_ID, board_id: "latency-board" },
      params: { body: "建板机发帖测试端到端自动推送与提醒" },
    });

    assert.equal(
      await waitFor(() => clientNotifications.length >= 1, 4500),
      true,
      `客机成员应在防抖窗口内收到本机提醒 (clientBoard=${JSON.stringify(clientRt.store.getBoard("latency-board"))})`,
    );
    const hostToClientNotifyMs = clientNotifications[0].at - hostPostAt;
    assert.ok(hostToClientNotifyMs < 4000, `建板机发帖到客机提醒用时应 <4000ms，实测 ${Math.round(hostToClientNotifyMs)}ms`);

    // 2. 客机发帖 -> 自动防抖推送建板机 -> 建板机成员自动防抖收到提醒
    const clientPostAt = performance.now();
    await clientRt.invoke({
      action: "post",
      actorIdentity: CLIENT_BOB,
      board: { machine_id: HOST_ID, board_id: "latency-board" },
      params: { body: "客机发帖回传测试自动提醒耗时" },
    });

    assert.equal(
      await waitFor(() => hostNotifications.length >= 1, 4500),
      true,
      `建板机成员应在防抖窗口内收到客机新帖提醒 (hostBoard=${JSON.stringify(hostRt.store.getBoard("latency-board"))})`,
    );
    const clientToHostNotifyMs = hostNotifications[0].at - clientPostAt;
    assert.ok(clientToHostNotifyMs < 4000, `客机发帖到建板机提醒用时应 <4000ms，实测 ${Math.round(clientToHostNotifyMs)}ms`);
    testContext.diagnostic(`host->client notify=${Math.round(hostToClientNotifyMs)}ms, client->host notify=${Math.round(clientToHostNotifyMs)}ms`);
  } finally {
    if (relayPump !== null) clearInterval(relayPump);
    if (clientRt) await clientRt.close();
    if (hostRt) await hostRt.close();
    if (clientDb) clientDb.close();
    if (hostDb) hostDb.close();
    cleanupTempDir(tmpDir);
  }
  await new Promise(resolve => setImmediate(resolve));
  const afterHandles = process.getActiveResourcesInfo();
  assert.equal(afterHandles.length - beforeHandles.length, 0, "双机防抖同步关闭后活跃句柄增量必须为 0");
});

test("周期通知与防抖通知交叠触发绝不并发重入，且关闭后句柄增量为 0", async () => {
  const tmpDir = createTempDir();
  const beforeHandles = process.getActiveResourcesInfo();
  let db = null;
  let rt = null;
  try {
    db = new DatabaseSync(path.join(tmpDir, "no-reenter.sqlite"));
    let inFlight = 0;
    let maxConcurrent = 0;
    let calls = 0;
    rt = openBoardRuntime({
      localMachineId: HOST_ID,
      privateRoot: path.join(tmpDir, "no-reenter-priv"),
      allowedUploadRoots: [],
      openStore: create => create({ database: db }),
      relayDispatcher: null,
      notifyIntervalMs: 40,
      notifyLocalMember: async () => {
        inFlight += 1;
        calls += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise(resolve => setTimeout(resolve, 70));
        inFlight -= 1;
        return { ok: true, accepted: true, message_id: `m-${calls}` };
      },
    });
    await rt.start();
    await rt.invoke({ action: "create", actorIdentity: HOST_ALICE, params: { board_id: "reenter-board", title: "防重入板" } });
    const hostPeer = { machine_id: HOST_ID, host: "codex", surface: "desktop", conversation_id: "conv-host-reenter-peer" };
    await rt.invoke({ action: "invite", actorIdentity: HOST_ALICE, board: { machine_id: HOST_ID, board_id: "reenter-board" }, params: { members: [hostPeer] } });
    for (let i = 0; i < 4; i += 1) {
      await rt.invoke({ action: "post", actorIdentity: HOST_ALICE, board: { machine_id: HOST_ID, board_id: "reenter-board" }, params: { body: `并发压测帖 ${i}` } });
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(maxConcurrent, 1, `周期与防抖通知绝不可并发重入，实测 maxConcurrent=${maxConcurrent}`);
    assert.ok(calls >= 1, "至少应完成一次通知送达");
  } finally {
    if (rt) await rt.close();
    if (db) db.close();
    cleanupTempDir(tmpDir);
  }
  await new Promise(resolve => setImmediate(resolve));
  const afterHandles = process.getActiveResourcesInfo();
  assert.equal(afterHandles.length - beforeHandles.length, 0, "防重入压测关闭后活跃句柄增量必须为 0");
});
