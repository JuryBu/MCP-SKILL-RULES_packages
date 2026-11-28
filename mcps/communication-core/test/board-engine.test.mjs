import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CoreError, digest, identityKey, normalizeIdentity } from "../src/contracts.mjs";
import { ConversationAddressBook } from "../src/conversation-address-book.mjs";
import { normalizeBoardInvocation } from "../src/board-entry-contract.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { createMcpHttpServer } from "../src/mcp-server.mjs";
import { MessageStore } from "../src/store.mjs";
import {
  allocateBoardAlias,
  BOARD_ACTIONS,
  BoardEngine,
  shouldNotifyMemberForPost,
} from "../src/board-engine.mjs";

const DEV_MACHINE = "sample-dev";
const TRAIN_MACHINE = "sample-train";
const PEER_NO_BUNDLE = "sample-lite";
const PEER_OFFLINE = "sample-offline";
const PEER_UNSUBSCRIBED = "sample-idle";

const ALICE = Object.freeze({ machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-alice" });
const BOB = Object.freeze({ machine_id: DEV_MACHINE, host: "antigravity", surface: "desktop", conversation_id: "conv-bob" });
const CAROL = Object.freeze({ machine_id: DEV_MACHINE, host: "windsurf", surface: "desktop", conversation_id: "conv-carol" });
const ADMIN = Object.freeze({ machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-admin" });
const OUTSIDER = Object.freeze({ machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-outsider" });
const REMOTE_DAVE = Object.freeze({ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-dave" });
const REMOTE_LITE = Object.freeze({ machine_id: PEER_NO_BUNDLE, host: "codex", surface: "desktop", conversation_id: "conv-lite" });
const REMOTE_OFFLINE = Object.freeze({ machine_id: PEER_OFFLINE, host: "codex", surface: "desktop", conversation_id: "conv-offline" });

const principal = identity => ({ identity, address_book_identity_bound: true });

function sanitizeName(raw) {
  return String(raw || "file.bin").replace(/[\\/:*?"<>|]/g, "_").trim() || "file.bin";
}

/**
 * 严格遵循 wave2-internal-signatures.md 契约的高保真内存 BoardStore（含真实物理目录 staging/outbox/archive）
 */
class InMemoryBoardStore {
  constructor({ privateRoot, now = () => Date.now() }) {
    this.privateRoot = privateRoot;
    this.now = now;
    this.boards = new Map();
    this.members = new Map(); // boardId -> Map<memberKey, member>
    this.posts = new Map(); // boardId -> Post[]
    this.syncStates = new Map(); // `${boardId}\0${peer}` -> state
    this.fileSyncQueue = [];
    this.outbox = [];
    this.tombstones = new Map();
    this.tombstoneSync = [];
    this.fileOps = [];
    this.notifications = new Map(); // dedupe_key -> notif
    this.nextOpSeq = 1;
    this.reconcileCalls = 0;
  }

  runInTransaction(fn) {
    const result = fn();
    if (result && typeof result.then === "function") {
      throw new CoreError("invalid_state", "事务回调必须为同步函数");
    }
    return result;
  }

  getBoardFilesDir(boardId) {
    return join(this.privateRoot, "boards", boardId, "files");
  }

  getBoardArchiveDir(boardId) {
    return join(this.privateRoot, "boards-archive", boardId);
  }

  getStagingDir() {
    return join(this.privateRoot, "boards", ".staging");
  }

  getOutboxDir(localPostId) {
    return join(this.privateRoot, "boards", ".outbox", localPostId);
  }

  resolveSafeBoardFilePath(boardId, fileId, safeName, { archived = false } = {}) {
    if (archived) {
      return join(this.getBoardArchiveDir(boardId), "files", `${fileId}_${safeName}`);
    }
    return join(this.getBoardFilesDir(boardId), `${fileId}_${safeName}`);
  }

  stageLocalUploadFile({ sourcePath, originalName, fileId, opId, boardId }) {
    const data = readFileSync(sourcePath);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const safeName = sanitizeName(originalName ?? basename(sourcePath));
    mkdirSync(this.getStagingDir(), { recursive: true });
    const stagingName = `${opId}.tmp`;
    copyFileSync(sourcePath, join(this.getStagingDir(), stagingName));
    const localPath = this.resolveSafeBoardFilePath(boardId, fileId, safeName, { archived: false });
    return {
      op_id: opId,
      staging_name: stagingName,
      file_id: fileId,
      safe_name: safeName,
      bytes: data.length,
      sha256,
      rel_path: `boards/${boardId}/files/${fileId}_${safeName}`,
      local_path: localPath,
    };
  }

  stageOutboxAttachment({ sourcePath, originalName, localPostId, fileId }) {
    const data = readFileSync(sourcePath);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const safeName = sanitizeName(originalName ?? basename(sourcePath));
    const dir = this.getOutboxDir(localPostId);
    mkdirSync(dir, { recursive: true });
    const outboxPath = join(dir, `${fileId}_${safeName}`);
    copyFileSync(sourcePath, outboxPath);
    return {
      file_id: fileId,
      safe_name: safeName,
      bytes: data.length,
      sha256,
      outbox_path: outboxPath,
      rel_path: `boards/.outbox/${localPostId}/${fileId}_${safeName}`,
    };
  }

  commitStagedFileOps(opIds) {
    for (const opId of opIds) {
      const op = this.fileOps.find(item => item.op_id === opId && item.status === "pending");
      if (!op || op.op_kind !== "stage_file") continue;
      const src = join(this.getStagingDir(), op.staging_name);
      const dst = this.resolveSafeBoardFilePath(op.board_id, op.file_id, op.safe_name, { archived: false });
      mkdirSync(this.getBoardFilesDir(op.board_id), { recursive: true });
      if (existsSync(src)) {
        renameSync(src, dst);
      }
      op.status = "done";
      op.updated_at = new Date(this.now()).toISOString();
    }
  }

  reconcilePendingFileOps() {
    this.reconcileCalls += 1;
    let processed = 0;
    let superseded = 0;
    for (const op of this.fileOps) {
      if (op.status !== "pending") continue;
      const tombstone = this.tombstones.get(op.board_id);
      if (tombstone) {
        rmSync(join(this.privateRoot, "boards", op.board_id), { recursive: true, force: true });
        rmSync(this.getBoardArchiveDir(op.board_id), { recursive: true, force: true });
        op.status = op.op_kind === "purge_archived_dir" ? "done" : "superseded";
        if (op.status === "done") processed += 1;
        else superseded += 1;
        continue;
      }
      const board = this.boards.get(op.board_id);
      if (!board) continue;
      if (op.state_version < board.state_version) {
        op.status = "superseded";
        superseded += 1;
        continue;
      }
      if (op.op_kind === "move_to_archive" && board.status === "archived") {
        const activeDir = join(this.privateRoot, "boards", op.board_id);
        const archiveDir = this.getBoardArchiveDir(op.board_id);
        if (existsSync(activeDir)) {
          mkdirSync(join(this.privateRoot, "boards-archive"), { recursive: true });
          renameSync(activeDir, archiveDir);
        }
        op.status = "done";
        processed += 1;
      } else if (op.op_kind === "restore_from_archive" && board.status === "active") {
        const activeDir = join(this.privateRoot, "boards", op.board_id);
        const archiveDir = this.getBoardArchiveDir(op.board_id);
        if (existsSync(archiveDir)) {
          mkdirSync(join(this.privateRoot, "boards"), { recursive: true });
          renameSync(archiveDir, activeDir);
        }
        op.status = "done";
        processed += 1;
      }
    }
    return { processed, superseded, cleaned_done: 0, cleaned_staging: 0, errors: [] };
  }

  getBoardFilesTotalBytes(boardId) {
    let total = 0;
    for (const post of this.posts.get(boardId) ?? []) {
      for (const file of post.files ?? []) {
        if (file.local_status === "ready") total += file.bytes;
      }
    }
    return total;
  }

  getGlobalFilesTotalBytes() {
    let total = 0;
    for (const boardId of this.boards.keys()) {
      total += this.getBoardFilesTotalBytes(boardId);
    }
    return total;
  }

  getBoard(boardId) {
    const board = this.boards.get(boardId);
    return board ? structuredClone(board) : null;
  }

  getTombstone(boardId) {
    const tombstone = this.tombstones.get(boardId);
    return tombstone ? structuredClone(tombstone) : null;
  }

  createBoard({ board_id, host_machine_id, title, settings, creator, nowIso }) {
    const creatorKey = identityKey(creator);
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
      settings: structuredClone(settings),
      board_seq: 0,
      creator_key: creatorKey,
      created_at: nowIso,
      last_active_at: nowIso,
      archived_at: null,
    };
    this.boards.set(board_id, board);
    this.posts.set(board_id, []);
    const memberMap = new Map();
    memberMap.set(creatorKey, {
      board_id,
      member_key: creatorKey,
      machine_id: creator.machine_id,
      host: creator.host,
      surface: creator.surface,
      conversation_id: creator.conversation_id,
      subscription_state: "active",
      delivery_mode: "poll",
      filter_mode: "all",
      filter_targets: [],
      last_read_seq: 0,
      last_notified_seq: 0,
      joined_at: nowIso,
    });
    this.members.set(board_id, memberMap);
    return structuredClone(board);
  }

  seedRemoteBoard({ board, members = [], posts = [], lastSyncedAt = null }) {
    this.boards.set(board.board_id, structuredClone(board));
    const memberMap = new Map();
    for (const member of members) {
      const key = member.member_key ?? identityKey(member);
      memberMap.set(key, {
        board_id: board.board_id,
        member_key: key,
        machine_id: member.machine_id,
        host: member.host,
        surface: member.surface,
        conversation_id: member.conversation_id,
        subscription_state: member.subscription_state ?? "active",
        delivery_mode: member.delivery_mode ?? "poll",
        filter_mode: member.filter_mode ?? "all",
        filter_targets: [...(member.filter_targets ?? [])],
        last_read_seq: member.last_read_seq ?? 0,
        last_notified_seq: member.last_notified_seq ?? 0,
        joined_at: member.joined_at ?? board.created_at,
      });
    }
    this.members.set(board.board_id, memberMap);
    this.posts.set(board.board_id, structuredClone(posts));
    if (lastSyncedAt !== null) {
      this.syncStates.set(`${board.board_id}\0${board.host_machine_id}`, {
        board_id: board.board_id,
        peer_machine_id: board.host_machine_id,
        last_acked_seq: board.board_seq,
        last_acked_state_version: board.state_version,
        last_acked_meta_version: board.meta_version,
        last_notified_dissolve_version: 0,
        last_synced_at: lastSyncedAt,
      });
    }
  }

  listBoardsForActor({ actorKey, isSuperAdmin = false, status = null, limit = 30, offset = 0 }) {
    const all = [...this.boards.values()]
      .filter(board => (status === null || board.status === status))
      .filter(board => isSuperAdmin || (actorKey && this.members.get(board.board_id)?.has(actorKey)))
      .sort((a, b) => b.last_active_at.localeCompare(a.last_active_at) || a.board_id.localeCompare(b.board_id));
    const page = all.slice(offset, offset + limit).map(board => structuredClone(board));
    const nextOffset = offset + page.length < all.length ? offset + page.length : null;
    return { items: page, total: all.length, next_offset: nextOffset };
  }

  getMember(boardId, memberKey) {
    const member = this.members.get(boardId)?.get(memberKey);
    return member ? structuredClone(member) : null;
  }

  listMembers(boardId, { activeOnly = false } = {}) {
    const list = [...(this.members.get(boardId)?.values() ?? [])];
    return list
      .filter(member => !activeOnly || member.subscription_state === "active")
      .map(member => structuredClone(member));
  }

  listActiveRemotePeerMachines(boardId, localMachineId) {
    const machines = new Set();
    for (const member of this.members.get(boardId)?.values() ?? []) {
      if (member.subscription_state === "active" && member.machine_id !== localMachineId) {
        machines.add(member.machine_id);
      }
    }
    return [...machines].sort();
  }

  upsertMember(boardId, memberIdentity, {
    subscription_state = "active",
    delivery_mode = "poll",
    filter_mode = "all",
    filter_targets = [],
    bumpMetaVersion = true,
    nowIso,
  } = {}) {
    const board = this.boards.get(boardId);
    const key = identityKey(memberIdentity);
    const memberMap = this.members.get(boardId);
    const prev = memberMap.get(key);
    let changed = false;
    if (!prev) {
      changed = true;
      memberMap.set(key, {
        board_id: boardId,
        member_key: key,
        machine_id: memberIdentity.machine_id,
        host: memberIdentity.host,
        surface: memberIdentity.surface,
        conversation_id: memberIdentity.conversation_id,
        subscription_state,
        delivery_mode,
        filter_mode,
        filter_targets: [...filter_targets],
        last_read_seq: 0,
        last_notified_seq: 0,
        joined_at: nowIso,
      });
    } else if (prev.subscription_state !== subscription_state) {
      changed = true;
      prev.subscription_state = subscription_state;
      prev.delivery_mode = delivery_mode;
      prev.filter_mode = filter_mode;
      prev.filter_targets = [...filter_targets];
    }
    if (changed && bumpMetaVersion) {
      board.meta_version += 1;
    }
    return { member: structuredClone(memberMap.get(key)), changed };
  }

  setMemberSubscriptionState(boardId, memberKey, subscriptionState, { bumpMetaVersion = true } = {}) {
    const board = this.boards.get(boardId);
    const member = this.members.get(boardId)?.get(memberKey);
    if (!member) return { member: null, changed: false };
    const changed = member.subscription_state !== subscriptionState;
    if (changed) {
      member.subscription_state = subscriptionState;
      if (bumpMetaVersion) board.meta_version += 1;
    }
    return { member: structuredClone(member), changed };
  }

  updateMemberPreferences(boardId, memberKey, { delivery_mode, filter_mode, filter_targets }) {
    const member = this.members.get(boardId)?.get(memberKey);
    if (!member) throw new CoreError("not_found", "成员不存在");
    member.delivery_mode = delivery_mode;
    member.filter_mode = filter_mode;
    member.filter_targets = [...filter_targets];
    return structuredClone(member);
  }

  updateMemberReadCursor(boardId, memberKey, seq) {
    const member = this.members.get(boardId)?.get(memberKey);
    if (member && seq > member.last_read_seq) {
      member.last_read_seq = seq;
    }
  }

  updateMemberNotifiedCursor(boardId, memberKey, seq) {
    const member = this.members.get(boardId)?.get(memberKey);
    if (member && seq > member.last_notified_seq) {
      member.last_notified_seq = seq;
    }
  }

  updateBoardSettings(boardId, settingsPatch, { nowIso } = {}) {
    const board = this.boards.get(boardId);
    board.settings = structuredClone(settingsPatch);
    board.meta_version += 1;
    if (nowIso) board.last_active_at = nowIso;
    return structuredClone(board);
  }

  appendPost({
    boardId,
    author,
    body,
    mentions = [],
    files = [],
    originClientPostId,
    stagedFileOps = [],
    fileSyncTargets = [],
    nowIso,
  }) {
    const board = this.boards.get(boardId);
    const posts = this.posts.get(boardId);
    const authorKey = identityKey(author);
    const contentFingerprint = digest({
      body,
      mentions,
      files: files.map(f => ({
        safe_name: f.safe_name,
        bytes: f.bytes,
        sha256: f.sha256,
        bundle_id: f.bundle_id ?? null,
        bundle_label: f.bundle_label ?? null,
      })),
    });

    const existing = posts.find(
      post => post.author_key === authorKey && post.origin_client_post_id === originClientPostId,
    );
    if (existing) {
      if (existing._fingerprint !== contentFingerprint) {
        throw new CoreError("board_post_conflict", "相同发帖标识对应的内容不一致");
      }
      return { post: structuredClone(existing), deduplicated: true, file_op_ids: [] };
    }

    board.board_seq += 1;
    board.last_active_at = nowIso;
    const seq = board.board_seq;
    const post = {
      board_id: boardId,
      seq,
      author_key: authorKey,
      author: structuredClone(author),
      body,
      mentions: [...mentions],
      files: structuredClone(files),
      created_at: nowIso,
      origin_client_post_id: originClientPostId,
      _fingerprint: contentFingerprint,
    };
    posts.push(post);

    const fileOpIds = [];
    for (const op of stagedFileOps) {
      this.fileOps.push({
        op_seq: this.nextOpSeq++,
        op_id: op.op_id,
        board_id: boardId,
        op_kind: "stage_file",
        staging_name: op.staging_name,
        file_id: op.file_id,
        safe_name: op.safe_name,
        expected_sha256: op.expected_sha256,
        expected_bytes: op.expected_bytes,
        state_version: board.state_version,
        status: "pending",
        created_at: nowIso,
        updated_at: nowIso,
      });
      fileOpIds.push(op.op_id);
    }

    for (const file of files) {
      for (const peerMachineId of fileSyncTargets) {
        this.fileSyncQueue.push({
          board_id: boardId,
          file_id: file.file_id,
          peer_machine_id: peerMachineId,
          seq,
          status: "pending",
          retry_count: 0,
          next_retry_at: 0,
          last_error: null,
          updated_at: nowIso,
        });
      }
    }

    return { post: structuredClone(post), deduplicated: false, file_op_ids: fileOpIds };
  }

  readPosts({ boardId, afterSeq = 0, seq = null, authorKeys = null, limit = 50 }) {
    const posts = this.posts.get(boardId) ?? [];
    if (seq !== null) {
      const found = posts.find(post => post.seq === seq);
      if (!found) return [];
      if (authorKeys !== null && !authorKeys.includes(found.author_key)) return [];
      return [structuredClone(found)];
    }
    return posts
      .filter(post => post.seq > afterSeq)
      .filter(post => authorKeys === null || authorKeys.includes(post.author_key))
      .slice(0, limit)
      .map(post => structuredClone(post));
  }

  getPostByFileId(boardId, fileId) {
    for (const post of this.posts.get(boardId) ?? []) {
      if ((post.files ?? []).some(f => f.file_id === fileId)) {
        return structuredClone(post);
      }
    }
    return null;
  }

  archiveBoard({ boardId, reason, actorKey, nowIso, enqueueNotifications = true }) {
    const board = this.boards.get(boardId);
    board.status = "archived";
    board.state_version += 1;
    board.archive_version += 1;
    board.archive_reason = reason;
    board.archived_at = nowIso;
    const opId = `op-archive-${this.nextOpSeq}`;
    this.fileOps.push({
      op_seq: this.nextOpSeq++,
      op_id: opId,
      board_id: boardId,
      op_kind: "move_to_archive",
      state_version: board.state_version,
      status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    });
    if (enqueueNotifications) {
      for (const member of this.members.get(boardId)?.values() ?? []) {
        if (member.subscription_state !== "active") continue;
        const dedupeKey = `dissolved:${boardId}:${board.archive_version}:${member.member_key}`;
        this.enqueueNotification({
          dedupe_key: dedupeKey,
          board_id: boardId,
          member_key: member.member_key,
          member_json: JSON.stringify({
            machine_id: member.machine_id,
            host: member.host,
            surface: member.surface,
            conversation_id: member.conversation_id,
          }),
          kind: "dissolved",
          state_version: board.state_version,
          payload_json: JSON.stringify({
            board_id: boardId,
            title: board.title,
            state_version: board.state_version,
            archive_version: board.archive_version,
            dissolved_by_key: actorKey,
            restorable: true,
          }),
          nowIso,
        });
      }
    }
    return { board: structuredClone(board), file_op_id: opId };
  }

  restoreBoard({ boardId, nowIso }) {
    const board = this.boards.get(boardId);
    board.status = "active";
    board.state_version += 1;
    board.archive_reason = null;
    board.archived_at = null;
    board.last_active_at = nowIso;
    const opId = `op-restore-${this.nextOpSeq}`;
    this.fileOps.push({
      op_seq: this.nextOpSeq++,
      op_id: opId,
      board_id: boardId,
      op_kind: "restore_from_archive",
      state_version: board.state_version,
      status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    });
    return { board: structuredClone(board), file_op_id: opId };
  }

  deleteArchivedBoard({ boardId, expectedArchiveVersion, expectedStateVersion = null, actorKey, peerMachines = [], nowIso }) {
    const board = this.boards.get(boardId);
    if (!board || board.status !== "archived" || board.archive_version !== expectedArchiveVersion) {
      throw new CoreError("invalid_state", "归档板状态或版本不匹配");
    }
    if (expectedStateVersion !== null && board.state_version !== expectedStateVersion) {
      throw new CoreError("invalid_state", "状态版本不匹配");
    }
    const finalStateVersion = board.state_version + 1;
    const tombstone = {
      board_id: boardId,
      host_machine_id: board.host_machine_id,
      final_state_version: finalStateVersion,
      deleted_by_key: actorKey,
      deleted_at: nowIso,
    };
    this.tombstones.set(boardId, tombstone);
    for (const peer of peerMachines) {
      this.tombstoneSync.push({
        board_id: boardId,
        peer_machine_id: peer,
        final_state_version: finalStateVersion,
        acked: 0,
        next_retry_at: 0,
      });
    }
    const opId = `op-purge-${this.nextOpSeq}`;
    this.fileOps.push({
      op_seq: this.nextOpSeq++,
      op_id: opId,
      board_id: boardId,
      op_kind: "purge_archived_dir",
      state_version: finalStateVersion,
      status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    });
    let cancelledNotifications = 0;
    for (const notif of this.notifications.values()) {
      if (notif.board_id === boardId && notif.status === "pending") {
        notif.status = "cancelled";
        notif.updated_at = nowIso;
        cancelledNotifications += 1;
      }
    }
    this.boards.delete(boardId);
    this.members.delete(boardId);
    this.posts.delete(boardId);
    return {
      tombstone: structuredClone(tombstone),
      file_op_id: opId,
      cancelled_notifications: cancelledNotifications,
    };
  }

  findInactiveBoardsForAutoArchive(localMachineId, nowMs) {
    const due = [];
    for (const board of this.boards.values()) {
      if (board.host_machine_id !== localMachineId || board.status !== "active") continue;
      const days = board.settings?.auto_archive_days ?? 31;
      const cutoff = nowMs - days * 24 * 3600 * 1000;
      if (Date.parse(board.last_active_at) <= cutoff) {
        due.push(structuredClone(board));
      }
    }
    return due;
  }

  getSyncState(boardId, peerMachineId) {
    return structuredClone(this.syncStates.get(`${boardId}\0${peerMachineId}`) ?? null);
  }

  enqueueRemoteOutbox(entry) {
    if (this.outbox.length >= 2048) {
      throw new CoreError("board_quota_exceeded", "客机离线队列已满");
    }
    this.outbox.push({
      ...entry,
      status: "pending",
      retry_count: 0,
      next_retry_at: 0,
      last_error_code: null,
      created_at: entry.nowIso,
      updated_at: entry.nowIso,
    });
  }

  enqueueNotification(entry) {
    if (this.notifications.has(entry.dedupe_key)) {
      return { enqueued: false, notification: structuredClone(this.notifications.get(entry.dedupe_key)) };
    }
    const row = {
      ...entry,
      status: "pending",
      retry_count: 0,
      next_retry_at: 0,
      created_at: entry.nowIso,
      updated_at: entry.nowIso,
    };
    this.notifications.set(entry.dedupe_key, row);
    return { enqueued: true, notification: structuredClone(row) };
  }

  listDueNotifications(nowMs, limit = 64) {
    return [...this.notifications.values()]
      .filter(item => item.status === "pending" && item.next_retry_at <= nowMs)
      .slice(0, limit)
      .map(item => structuredClone(item));
  }

  markNotificationStatus(dedupeKey, { status, retry_count, next_retry_at, nowIso }) {
    const item = this.notifications.get(dedupeKey);
    if (!item) return;
    item.status = status;
    item.retry_count = retry_count;
    item.next_retry_at = next_retry_at;
    item.updated_at = nowIso;
  }
}

function createHarness(t, options = {}) {
  let clockMs = options.initialNowMs ?? Date.parse("2026-11-27T08:00:00.000Z");
  const now = () => clockMs;
  const advanceMs = delta => { clockMs += delta; };

  const tempDir = mkdtempSync(join(tmpdir(), "board-engine-test-"));
  const privateRoot = join(tempDir, "private");
  const uploadsDir = join(tempDir, "uploads");
  mkdirSync(privateRoot, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });

  const bookDb = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const addressBook = new ConversationAddressBook({
    database: bookDb,
    machineId: options.localMachineId ?? DEV_MACHINE,
    sharedContacts: options.sharedContacts ?? [],
    now: () => new Date(clockMs).toISOString(),
  });

  const store = new InMemoryBoardStore({ privateRoot, now });
  const deliveredNotifications = [];
  const boardChanges = [];

  const peerCapabilities = options.peerCapabilities ?? new Map([
    [TRAIN_MACHINE, { known: true, reachable: true, allow_file_bundle: true }],
    [PEER_NO_BUNDLE, { known: true, reachable: true, allow_file_bundle: false }],
    [PEER_OFFLINE, { known: true, reachable: false, allow_file_bundle: true, reason: "peer_offline" }],
    [PEER_UNSUBSCRIBED, { known: true, reachable: true, allow_file_bundle: true }],
  ]);

  let notifyImpl = options.notifyLocalMember ?? (async event => {
    deliveredNotifications.push(event);
    return { delivered: true };
  });

  const engine = new BoardEngine({
    store,
    localMachineId: options.localMachineId ?? DEV_MACHINE,
    addressBookAdapter: options.addressBookAdapter === undefined ? addressBook : options.addressBookAdapter,
    superAdminIdentities: options.superAdminIdentities ?? [ADMIN],
    peerCapabilitiesProvider: options.peerCapabilitiesProvider === undefined ? peerCapabilities : options.peerCapabilitiesProvider,
    notifyLocalMember: options.disableNotifier ? null : (async (event, opts) => notifyImpl(event, opts)),
    onBoardChanged: event => boardChanges.push(event),
    limits: options.limits,
    now,
  });

  t.after(() => {
    engine.close();
    if (bookDb.isOpen) bookDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeUpload = (filename, content) => {
    const filePath = join(uploadsDir, filename);
    writeFileSync(filePath, content);
    return filePath;
  };

  return {
    engine,
    store,
    addressBook,
    bookDb,
    tempDir,
    privateRoot,
    uploadsDir,
    deliveredNotifications,
    boardChanges,
    now,
    advanceMs,
    writeUpload,
    setNotifyImpl: fn => { notifyImpl = fn; },
  };
}

test("BOARD_ACTIONS exports exact 13 actions and invoke enforces concrete identities without wildcards", async t => {
  assert.equal(BOARD_ACTIONS.size, 13);
  const { engine, addressBook } = createHarness(t);

  // 构造时 superAdminIdentities 禁止通配符
  assert.throws(
    () => new BoardEngine({
      store: {},
      localMachineId: DEV_MACHINE,
      superAdminIdentities: [{ ...ADMIN, conversation_id: "*" }],
    }),
    { code: "invalid_input" },
  );

  // 任意字段含 '*' 均拒绝
  for (const badActor of [
    { ...ALICE, machine_id: "*" },
    { ...ALICE, host: "*" },
    { ...ALICE, surface: "*" },
    { ...ALICE, conversation_id: "*" },
  ]) {
    await assert.rejects(
      engine.invoke({ action: "list", actorIdentity: badActor, params: {} }),
      { code: "invalid_input" },
    );
  }

  await assert.rejects(
    engine.invoke({ action: "unknown_action", actorIdentity: ALICE, params: {} }),
    { code: "invalid_input" },
  );

  // 支持与 normalizeBoardInvocation 产物无缝对接，也支持直接 params.board_id
  const created = await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "架构联调板" },
  });
  assert.equal(created.alias_allocated, true);
  assert.equal(created.alias, "架构联调板");

  const invocationFromEntry = normalizeBoardInvocation(
    { caller: ALICE, action: "read", board: { contact: "架构联调板" } },
    principal(ALICE),
    addressBook,
    DEV_MACHINE,
  );
  const readViaEntry = await engine.invoke(invocationFromEntry);
  assert.equal(readViaEntry.board_id, created.board_id);

  const readViaParams = await engine.invoke({
    action: "read",
    actorIdentity: ALICE,
    params: { board_id: created.board_id },
  });
  assert.equal(readViaParams.board_id, created.board_id);

  // 已取消 signal 立即拒
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    engine.invoke({ action: "list", actorIdentity: ALICE, signal: ac.signal }),
    { code: "request_cancelled" },
  );

  // close() 后拒
  engine.close();
  await assert.rejects(
    engine.invoke({ action: "list", actorIdentity: ALICE }),
    { code: "closed" },
  );
});

test("closed permission matrix blocks unsubscribed former members and outsiders across active operations and restore", async t => {
  const { engine, store } = createHarness(t);

  const created = await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "权限测试私密板", board_id: "priv-board-1" },
  });
  assert.equal(created.state_version, 0);
  assert.equal(created.meta_version, 1);
  assert.equal(created.archive_version, 0);

  // 邀请 BOB 入板
  const inv = await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
    params: { members: [BOB] },
  });
  assert.equal(inv.meta_version, 2);
  assert.equal(inv.added_count, 1);

  // BOB 主动退订 -> meta_version +1
  const unsub = await engine.invoke({
    action: "unsubscribe",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
  });
  assert.equal(unsub.subscription_state, "unsubscribed");
  assert.equal(unsub.changed, true);
  assert.equal(unsub.meta_version, 3);

  // 已退订前成员 BOB 与无关非成员 OUTSIDER 对全部成员动作均被拒 forbidden
  const activeOps = [
    { action: "invite", params: { members: [CAROL] } },
    { action: "post", params: { body: "不应通过" } },
    { action: "read", params: {} },
    { action: "set_subscription", params: { delivery_mode: "event" } },
    { action: "query_members", params: {} },
    { action: "update_settings", params: { settings: { auto_archive_days: 10 } } },
    { action: "dissolve", params: {} },
    { action: "unsubscribe", params: {} },
  ];

  for (const deniedActor of [BOB, OUTSIDER]) {
    for (const op of activeOps) {
      await assert.rejects(
        engine.invoke({
          action: op.action,
          actorIdentity: deniedActor,
          board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
          params: op.params,
        }),
        { code: "forbidden" },
        `${deniedActor.conversation_id} 应被拒绝执行 ${op.action}`,
      );
    }
  }

  // 解散后：已退订前成员 BOB 和无关非成员 OUTSIDER 均不得 restore，仅原活跃成员 ALICE 或超管 ADMIN 可 restore
  const dissolved = await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
  });
  assert.equal(dissolved.status, "archived");
  assert.equal(dissolved.state_version, 1);
  assert.equal(dissolved.archive_version, 1);
  assert.equal(dissolved.archive_reason, "manual_dissolve");

  for (const deniedActor of [BOB, OUTSIDER]) {
    await assert.rejects(
      engine.invoke({
        action: "restore",
        actorIdentity: deniedActor,
        board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
      }),
      { code: "forbidden" },
    );
  }

  // 非成员超管（通过 superAdminIdentities 注入）可以恢复
  assert.equal(engine.isSuperAdmin(ADMIN), true);
  assert.equal(engine.isSuperAdmin(OUTSIDER), false);
  const restored = await engine.invoke({
    action: "restore",
    actorIdentity: ADMIN,
    board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
  });
  assert.equal(restored.status, "active");
  assert.equal(restored.state_version, 2);
  assert.equal(restored.archive_version, 1);

  // BOB 重新主动 subscribe：unsubscribed -> active，meta_version += 1；再次 subscribe 幂等不增版本
  const sub1 = await engine.invoke({
    action: "subscribe",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
  });
  assert.equal(sub1.subscription_state, "active");
  assert.equal(sub1.changed, true);
  assert.equal(sub1.meta_version, 4);

  const sub2 = await engine.invoke({
    action: "subscribe",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "priv-board-1" },
  });
  assert.equal(sub2.changed, false);
  assert.equal(sub2.meta_version, 4);

  // 确认超管非成员也能 list 看到该板并直接发帖
  const adminList = await engine.invoke({ action: "list", actorIdentity: ADMIN });
  assert.equal(adminList.boards.some(b => b.board_id === "priv-board-1"), true);
  assert.equal(store.getBoard("priv-board-1").status, "active");
});

test("delete_archived allows any authenticated caller with exact archive_version, leaks nothing on non-member failure, and emits zero notifications", async t => {
  const { engine, store, deliveredNotifications, setNotifyImpl } = createHarness(t);

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "绝密核心代号Alpha99", board_id: "secret-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "secret-board" },
    params: { members: [BOB] },
  });

  // 活跃态时非成员尝试 delete_archived -> 统一脱敏错误，不泄露标题/成员/状态/真实版本
  let errActive;
  try {
    await engine.invoke({
      action: "delete_archived",
      actorIdentity: OUTSIDER,
      board: { machine_id: DEV_MACHINE, board_id: "secret-board" },
      params: { expected_archive_version: 1 },
    });
  } catch (error) {
    errActive = error;
  }
  assert.equal(errActive?.code, "board_not_found");
  assert.equal(errActive.message.includes("绝密核心代号Alpha99"), false);
  assert.equal(errActive.message.includes("conv-alice"), false);
  assert.deepEqual(errActive.details, {});

  // 解散板，故意让本机通知投递失败以留存 pending 的 dissolved 通知
  setNotifyImpl(async () => ({ delivered: false }));
  const dissolved = await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "secret-board" },
  });
  assert.equal(dissolved.archive_version, 1);
  assert.equal(dissolved.state_version, 1);
  const pendingBeforeDelete = [...store.notifications.values()].filter(n => n.status === "pending");
  assert.ok(pendingBeforeDelete.length >= 1);

  // 非成员用错误 archive_version / state_version 探测 -> 同样脱敏且不吐真实版本
  for (const badParams of [
    { expected_archive_version: 2 },
    { expected_archive_version: 1, expected_state_version: 99 },
  ]) {
    let errWrong;
    try {
      await engine.invoke({
        action: "delete_archived",
        actorIdentity: OUTSIDER,
        board: { machine_id: DEV_MACHINE, board_id: "secret-board" },
        params: badParams,
      });
    } catch (error) {
      errWrong = error;
    }
    assert.equal(errWrong?.code, "board_not_found");
    assert.equal(errWrong.message.includes("绝密核心代号Alpha99"), false);
    assert.equal(errWrong.message.includes("archive_version"), false);
    assert.deepEqual(errWrong.details, {});
  }

  // 跨机 remotePrincipal 未过双鉴源校验时拒绝
  await assert.rejects(
    engine.deleteArchivedBoard(
      REMOTE_DAVE,
      { expected_archive_version: 1 },
      {
        board: { machine_id: DEV_MACHINE, board_id: "secret-board" },
        remotePrincipal: { trust_source_identity: true, source_identity_verified: false, from_machine: TRAIN_MACHINE },
      },
    ),
    { code: "source_unverified" },
  );

  // 恢复通知器计数，非成员提供正确版本成功删除归档板 -> 0 通知 + 残留 pending dissolved 通知全部置 cancelled
  const countBefore = deliveredNotifications.length;
  setNotifyImpl(async event => {
    deliveredNotifications.push(event);
    return { delivered: true };
  });

  const deleted = await engine.invoke({
    action: "delete_archived",
    actorIdentity: OUTSIDER,
    board: { machine_id: DEV_MACHINE, board_id: "secret-board" },
    params: { expected_archive_version: 1, expected_state_version: 1 },
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.final_state_version, 2);
  assert.ok(deleted.cancelled_notifications >= 1);
  assert.equal(Object.hasOwn(deleted, "title"), false);
  assert.equal(deliveredNotifications.length, countBefore);
  assert.ok(store.getTombstone("secret-board"));

  // 后续通知 tick 不会再发出已删除板的滞后解散提醒
  await engine.localNotifyTick();
  assert.equal(deliveredNotifications.length, countBefore);
});

test("allocateBoardAlias enforces exact 3 keys, degrades gracefully at 512 limit, and invite never leaks personal #2/#3 aliases", async t => {
  const { engine, addressBook, bookDb } = createHarness(t, {
    sharedContacts: [{
      id: "shared-collab",
      alias: "协作总板",
      note: "共有备注",
      entry_kind: "contact",
      target: REMOTE_DAVE,
    }],
  });

  // 1. 精确 3 键断言（直接校验传给 saveBoardForIdentity 的实参键集）
  const recordedKeySets = [];
  const origSaveBoard = addressBook.saveBoardForIdentity.bind(addressBook);
  addressBook.saveBoardForIdentity = (memberId, boardArg) => {
    recordedKeySets.push(Object.keys(boardArg));
    return origSaveBoard(memberId, boardArg);
  };

  // BOB 个人通讯录里先占掉 "协作总板#2"（加上共有 "协作总板"，新板应落到 "协作总板#3"）
  addressBook.saveAddress(principal(BOB), { alias: "协作总板#2", target: CAROL, note: "私人备注" });

  // CAROL 通讯录填满 512 条个人联系人，验证 contact_limit 优雅降级不阻断入板
  bookDb.exec("BEGIN");
  try {
    for (let i = 0; i < 512; i += 1) {
      addressBook.saveAddress(principal(CAROL), { alias: `满员联系人${i}`, target: REMOTE_DAVE });
    }
    bookDb.exec("COMMIT");
  } catch (error) {
    bookDb.exec("ROLLBACK");
    throw error;
  }

  const created = await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "协作总板", board_id: "alias-board" },
  });
  assert.equal(created.alias_allocated, true);
  assert.equal(created.alias, "协作总板#2"); // ALICE 避开共有 "协作总板"

  // 邀请 BOB（本机冲突 -> #3）、CAROL（本机满 512 -> contact_limit）、REMOTE_DAVE（跨机 -> 不调本机通讯录）
  const invited = await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "alias-board" },
    params: { members: [BOB, CAROL, REMOTE_DAVE] },
  });

  // 校验精确 3 键
  assert.ok(recordedKeySets.length >= 2);
  for (const keys of recordedKeySets) {
    assert.deepEqual(keys.sort(), ["baseTitle", "board_id", "machine_id"]);
  }

  // 校验隐私铁律：invite 返回值绝不暴露任何受邀者的个人 alias 或 #2/#3
  const serializedInvite = JSON.stringify(invited);
  assert.equal(serializedInvite.includes("#2"), false);
  assert.equal(serializedInvite.includes("#3"), false);
  for (const entry of invited.invited) {
    assert.equal(Object.hasOwn(entry, "alias"), false);
  }

  const bobResult = invited.invited.find(i => i.identity.conversation_id === "conv-bob");
  const carolResult = invited.invited.find(i => i.identity.conversation_id === "conv-carol");
  const daveResult = invited.invited.find(i => i.identity.conversation_id === "conv-dave");
  assert.equal(bobResult.alias_allocated, true);
  assert.equal(carolResult.alias_allocated, false);
  assert.equal(carolResult.alias_warning, "contact_limit");
  assert.equal(daveResult.alias_allocated, false);
  assert.equal(daveResult.alias_warning, "remote_member_deferred");

  // 确认 BOB 个人通讯录里确实拿到了 "协作总板#3"，且 CAROL 虽然没分到短代号但已成功成为活跃成员
  const bobEntry = addressBook.list(principal(BOB)).contacts.find(c => c.entry_kind === "board");
  assert.equal(bobEntry.alias, "协作总板#3");
  const carolRead = await engine.invoke({
    action: "read",
    actorIdentity: CAROL,
    board: { machine_id: DEV_MACHINE, board_id: "alias-board" },
  });
  assert.equal(carolRead.board_id, "alias-board");

  // 独立测试 allocateBoardAlias 跨机保护
  const remoteRes = allocateBoardAlias(addressBook, REMOTE_DAVE, {
    machine_id: DEV_MACHINE,
    board_id: "alias-board",
    baseTitle: "协作总板",
  }, DEV_MACHINE);
  assert.deepEqual(remoteRes, { alias_allocated: false, alias_warning: "remote_member_deferred" });
});

test("read and query_members resolve display names per local reader without leaking notes and fallback safely for remote readers", async t => {
  const { engine, addressBook } = createHarness(t);

  addressBook.saveAddress(principal(ALICE), { alias: "爱丽丝眼里的鲍勃", target: BOB, note: "绝对不能泄露的私人备注A" });
  addressBook.saveAddress(principal(BOB), { alias: "鲍勃眼里的爱丽丝", target: ALICE, note: "绝对不能泄露的私人备注B" });

  let resolveCallsForRemote = 0;
  const origResolveDisplay = addressBook.resolveDisplayName.bind(addressBook);
  addressBook.resolveDisplayName = (reader, peer) => {
    if (reader.machine_id !== DEV_MACHINE) resolveCallsForRemote += 1;
    return origResolveDisplay(reader, peer);
  };

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "译名测试板", board_id: "display-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
    params: { members: [BOB, CAROL, REMOTE_DAVE] },
  });

  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
    params: { body: "第一条消息" },
  });
  await engine.invoke({
    action: "post",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
    params: { body: "第二条消息" },
  });

  // BOB 读板：看到自己的别名，未设别名的 CAROL 回退三段，绝不吐备注
  const bobRead = await engine.invoke({
    action: "read",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
  });
  assert.equal(bobRead.posts[0].author_display, "鲍勃眼里的爱丽丝");
  assert.equal(bobRead.posts[1].author_display, `${DEV_MACHINE}/antigravity/conv-bob`);
  assert.equal(JSON.stringify(bobRead).includes("私人备注"), false);

  // ALICE 查成员：看到自己的别名，不泄露 BOB 的别名与备注
  const aliceMembers = await engine.invoke({
    action: "query_members",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
  });
  const bobInAliceView = aliceMembers.members.find(m => m.identity.conversation_id === "conv-bob");
  const carolInAliceView = aliceMembers.members.find(m => m.identity.conversation_id === "conv-carol");
  assert.equal(bobInAliceView.display_name, "爱丽丝眼里的鲍勃");
  assert.equal(carolInAliceView.display_name, `${DEV_MACHINE}/windsurf/conv-carol`);
  assert.equal(JSON.stringify(aliceMembers).includes("私人备注"), false);

  // 跨机读者 REMOTE_DAVE 读板与查成员：绝不调用本机 resolveDisplayName，全部安全回退 machine_id/host/conversation_id
  const remoteRead = await engine.invoke({
    action: "read",
    actorIdentity: REMOTE_DAVE,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
  });
  assert.equal(remoteRead.posts[0].author_display, `${DEV_MACHINE}/codex/conv-alice`);
  assert.equal(remoteRead.posts[1].author_display, `${DEV_MACHINE}/antigravity/conv-bob`);

  const remoteMembers = await engine.invoke({
    action: "query_members",
    actorIdentity: REMOTE_DAVE,
    board: { machine_id: DEV_MACHINE, board_id: "display-board" },
  });
  const bobInRemoteView = remoteMembers.members.find(m => m.identity.conversation_id === "conv-bob");
  assert.equal(bobInRemoteView.display_name, `${DEV_MACHINE}/antigravity/conv-bob`);
  assert.equal(resolveCallsForRemote, 0);
});

test("host post supports multi-file logical bundles, sync_machines override, unreachable reporting, settings validation, and idempotency", async t => {
  const { engine, store, writeUpload } = createHarness(t);

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "文件同步板", board_id: "file-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "file-board" },
    params: { members: [REMOTE_DAVE, REMOTE_LITE, REMOTE_OFFLINE] },
  });

  // update_settings 范围校验
  await assert.rejects(
    engine.invoke({
      action: "update_settings",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "file-board" },
      params: { settings: { default_poll_interval_sec: 30 } },
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    engine.invoke({
      action: "update_settings",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "file-board" },
      params: { settings: { auto_archive_days: 0 } },
    }),
    { code: "invalid_input" },
  );
  const updatedSettings = await engine.invoke({
    action: "update_settings",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "file-board" },
    params: { settings: { default_poll_interval_sec: 120, auto_archive_days: 45, default_file_sync_machines: ["*"] } },
  });
  assert.equal(updatedSettings.meta_version, 3);
  assert.equal(updatedSettings.settings.default_poll_interval_sec, 120);

  const fileA = writeUpload("report-a.txt", "报告A正文内容");
  const fileB = writeUpload("report-b.txt", "报告B正文内容");

  // 1. 使用群默认 ["*"]：TRAIN_MACHINE 可达，PEER_NO_BUNDLE 禁用文件包，PEER_OFFLINE 不可达；本机不入队
  const post1 = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "file-board" },
    params: {
      body: "上传逻辑文件包",
      client_post_id: "cpost-1",
      files: [
        { path: fileA, name: "report-a.txt", bundle_id: "bundle-01", bundle_label: "第1轮评审材料" },
        { path: fileB, name: "report-b.txt", bundle_id: "bundle-01", bundle_label: "第1轮评审材料" },
      ],
    },
  });

  assert.equal(post1.board_id, "file-board");
  assert.equal(post1.seq, 1);
  assert.equal(post1.pending_sync, true);
  assert.equal(post1.uploaded_files.length, 2);
  assert.equal(post1.uploaded_files[0].bundle_id, "bundle-01");
  assert.equal(post1.uploaded_files[0].bundle_label, "第1轮评审材料");
  assert.ok(existsSync(post1.uploaded_files[0].local_path));
  assert.deepEqual(post1.target_sync_machines, [TRAIN_MACHINE]);
  assert.deepEqual(
    post1.unreachable_machines.sort((a, b) => a.machine_id.localeCompare(b.machine_id)),
    [
      { machine_id: PEER_NO_BUNDLE, reason: "file_bundle_disabled" },
      { machine_id: PEER_OFFLINE, reason: "peer_offline" },
    ],
  );
  assert.equal(store.fileSyncQueue.length, 2);

  // 2. 单次 sync_machines[] 覆盖群设置：含本机（应剔除）、未知机、无订阅机与可达机
  const post2 = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "file-board" },
    params: {
      body: "定点同步覆盖",
      files: [{ path: fileA }],
      sync_machines: [DEV_MACHINE, TRAIN_MACHINE, PEER_UNSUBSCRIBED, "ghost-machine"],
    },
  });
  assert.equal(post2.seq, 2);
  assert.deepEqual(post2.target_sync_machines, [TRAIN_MACHINE]);
  assert.deepEqual(post2.unreachable_machines, [
    { machine_id: PEER_UNSUBSCRIBED, reason: "no_active_subscription" },
    { machine_id: "ghost-machine", reason: "unknown_peer" },
  ]);

  // 3. 相同 client_post_id 幂等重放 vs 异容冲突
  const replay = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "file-board" },
    params: {
      body: "上传逻辑文件包",
      client_post_id: "cpost-1",
      files: [
        { path: fileA, name: "report-a.txt", bundle_id: "bundle-01", bundle_label: "第1轮评审材料" },
        { path: fileB, name: "report-b.txt", bundle_id: "bundle-01", bundle_label: "第1轮评审材料" },
      ],
    },
  });
  assert.equal(replay.seq, 1);
  assert.equal(replay.deduplicated, true);

  await assert.rejects(
    engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "file-board" },
      params: { body: "篡改内容", client_post_id: "cpost-1" },
    }),
    { code: "board_post_conflict" },
  );
});

test("client machine offline post stages files to .outbox/ and enqueues outbox; client control actions enqueue client_control_request", async t => {
  const { engine, store, writeUpload } = createHarness(t, { localMachineId: DEV_MACHINE });
  const nowIso = new Date().toISOString();

  // 模拟一块由 TRAIN_MACHINE 建板并同步到本地的跨机板
  store.seedRemoteBoard({
    board: {
      board_id: "remote-board",
      host_machine_id: TRAIN_MACHINE,
      title: "远端协作板",
      status: "active",
      state_version: 0,
      meta_version: 2,
      archive_version: 0,
      archive_reason: null,
      settings: { default_file_sync_machines: ["*"], auto_archive_days: 31, default_poll_interval_sec: 90 },
      board_seq: 1,
      creator_key: identityKey(REMOTE_DAVE),
      created_at: nowIso,
      last_active_at: nowIso,
      archived_at: null,
    },
    members: [REMOTE_DAVE, ALICE],
    posts: [],
    lastSyncedAt: "2026-11-27T07:55:00.000Z",
  });

  // 客机离线发帖带附件
  const uploadPath = writeUpload("client-note.txt", "来自客机的离线附件");
  const clientPost = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "remote-board" },
    params: {
      body: "客机离线发帖",
      client_post_id: "local-post-100",
      files: [{ path: uploadPath, bundle_id: "b-client", bundle_label: "客机包" }],
    },
  });
  assert.equal(clientPost.board_id, "remote-board");
  assert.equal(clientPost.seq, null);
  assert.equal(clientPost.local_post_id, "local-post-100");
  assert.equal(clientPost.pending_host_ack, true);
  assert.equal(clientPost.uploaded_files.length, 1);
  assert.ok(clientPost.uploaded_files[0].local_path.includes(".outbox"));
  assert.ok(existsSync(clientPost.uploaded_files[0].local_path));
  assert.deepEqual(clientPost.target_sync_machines, [TRAIN_MACHINE]);
  assert.equal(store.outbox.length, 1);
  assert.equal(store.outbox[0].op_kind, "client_post_submit");

  // 客机写控制类操作（invite / subscribe / unsubscribe / update_settings / dissolve）
  const ctrlCases = [
    { action: "invite", params: { members: [BOB] } },
    { action: "subscribe", params: {} },
    { action: "unsubscribe", params: {} },
    { action: "update_settings", params: { settings: { auto_archive_days: 14 } } },
    { action: "dissolve", params: {} },
  ];
  for (const item of ctrlCases) {
    const res = await engine.invoke({
      action: item.action,
      actorIdentity: ALICE,
      board: { machine_id: TRAIN_MACHINE, board_id: "remote-board" },
      params: item.params,
    });
    assert.equal(res.board_id, "remote-board");
    assert.equal(res.pending_host_ack, true);
    assert.equal(res.action, item.action);
    assert.ok(typeof res.request_id === "string" && res.request_id.length > 0);
  }

  // 未缓存远端板的 subscribe 与 delete_archived 也能正常入队 client_control_request
  const subUncached = await engine.invoke({
    action: "subscribe",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "unseen-remote-board" },
  });
  assert.equal(subUncached.pending_host_ack, true);
  assert.equal(subUncached.action, "subscribe");

  // 归档态远端板的 restore 与 delete_archived
  store.seedRemoteBoard({
    board: {
      board_id: "remote-archived",
      host_machine_id: TRAIN_MACHINE,
      title: "远端已归档板",
      status: "archived",
      state_version: 1,
      meta_version: 2,
      archive_version: 1,
      archive_reason: "manual_dissolve",
      settings: { default_file_sync_machines: ["*"], auto_archive_days: 31, default_poll_interval_sec: 90 },
      board_seq: 0,
      creator_key: identityKey(REMOTE_DAVE),
      created_at: nowIso,
      last_active_at: nowIso,
      archived_at: nowIso,
    },
    members: [REMOTE_DAVE, ALICE],
    posts: [],
    lastSyncedAt: "2026-11-27T07:55:00.000Z",
  });

  const restoreReq = await engine.invoke({
    action: "restore",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "remote-archived" },
  });
  assert.equal(restoreReq.pending_host_ack, true);
  assert.equal(restoreReq.action, "restore");

  const delReq = await engine.invoke({
    action: "delete_archived",
    actorIdentity: OUTSIDER,
    board: { machine_id: TRAIN_MACHINE, board_id: "remote-archived" },
    params: { expected_archive_version: 1 },
  });
  assert.equal(delReq.pending_host_ack, true);
  assert.equal(delReq.action, "delete_archived");

  const controlEntries = store.outbox.filter(entry => entry.op_kind === "client_control_request");
  assert.equal(controlEntries.length, 8);
});

test("read respects budget truncation (< 9 KiB default), ignores mute/only filter, gates local_path by local_status, and annotates stale_cache/board_archived", async t => {
  const { engine, store } = createHarness(t);
  const nowIso = "2026-11-27T08:00:00.000Z";

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "阅读预算测试板", board_id: "read-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { members: [BOB] },
  });

  // BOB 设为全静音 mute，但 read 不受 mute/only 过滤阻挡，默认读全板
  await engine.invoke({
    action: "set_subscription",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { filter_mode: "mute", filter_targets: [] },
  });

  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { body: "A".repeat(7500) },
  });
  await engine.invoke({
    action: "post",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { body: "短回复B" },
  });

  // 默认 max_total_chars=6000 截断超长单帖并保证常规 JSON < 9 KiB
  const readDefault = await engine.invoke({
    action: "read",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
  });
  assert.equal(readDefault.posts.length, 1);
  assert.equal(readDefault.posts[0].seq, 1);
  assert.equal(readDefault.posts[0].body.length, 6000);
  assert.equal(readDefault.posts[0].truncated, true);
  assert.equal(readDefault.posts[0].full_body_chars, 7500);
  assert.equal(readDefault.has_more, true);
  assert.ok(Buffer.byteLength(JSON.stringify(readDefault), "utf8") < 9 * 1024);

  // seq 单帖精读全文
  const readSingle = await engine.invoke({
    action: "read",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { seq: 1, max_total_chars: 10000 },
  });
  assert.equal(readSingle.posts.length, 1);
  assert.equal(readSingle.posts[0].body.length, 7500);
  assert.equal(readSingle.posts[0].truncated, false);

  // author_keys 可选过滤
  const readOnlyBob = await engine.invoke({
    action: "read",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { author_keys: [identityKey(BOB)] },
  });
  assert.equal(readOnlyBob.posts.length, 1);
  assert.equal(readOnlyBob.posts[0].seq, 2);

  // 解散归档后，原活跃成员仍可只读并标注 board_archived: true
  await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
  });
  const readArchived = await engine.invoke({
    action: "read",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "read-board" },
    params: { after_seq: 1 },
  });
  assert.equal(readArchived.board_archived, true);
  assert.equal(readArchived.posts[0].body, "短回复B");

  // 跨机板读缓存标注 stale_cache: true, last_synced_at；且附件仅 local_status === 'ready' 才给 local_path
  store.seedRemoteBoard({
    board: {
      board_id: "cached-remote",
      host_machine_id: TRAIN_MACHINE,
      title: "跨机缓存板",
      status: "active",
      state_version: 0,
      meta_version: 1,
      archive_version: 0,
      archive_reason: null,
      settings: { default_file_sync_machines: ["*"], auto_archive_days: 31, default_poll_interval_sec: 90 },
      board_seq: 1,
      creator_key: identityKey(REMOTE_DAVE),
      created_at: nowIso,
      last_active_at: nowIso,
      archived_at: null,
    },
    members: [REMOTE_DAVE, ALICE],
    posts: [{
      board_id: "cached-remote",
      seq: 1,
      author_key: identityKey(REMOTE_DAVE),
      author: REMOTE_DAVE,
      body: "含多种附件状态",
      mentions: [],
      files: [
        { file_id: "f-ready", safe_name: "ok.txt", bytes: 10, sha256: "aaa", local_status: "ready" },
        { file_id: "f-pend", safe_name: "wait.txt", bytes: 20, sha256: "bbb", local_status: "pending_sync", local_path: "/should/not/leak" },
        { file_id: "f-skip", safe_name: "skip.txt", bytes: 30, sha256: "ccc", local_status: "not_targeted" },
        { file_id: "f-fail", safe_name: "bad.txt", bytes: 40, sha256: "ddd", local_status: "failed" },
      ],
      created_at: nowIso,
      origin_client_post_id: "rp-1",
    }],
    lastSyncedAt: "2026-11-27T07:30:00.000Z",
  });

  const cachedRead = await engine.invoke({
    action: "read",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "cached-remote" },
  });
  assert.equal(cachedRead.stale_cache, true);
  assert.equal(cachedRead.last_synced_at, "2026-11-27T07:30:00.000Z");
  const filesById = new Map(cachedRead.posts[0].files.map(f => [f.file_id, f]));
  assert.ok(typeof filesById.get("f-ready").local_path === "string");
  assert.equal(Object.hasOwn(filesById.get("f-pend"), "local_path"), false);
  assert.equal(Object.hasOwn(filesById.get("f-skip"), "local_path"), false);
  assert.equal(Object.hasOwn(filesById.get("f-fail"), "local_path"), false);
});

test("list paginates with default 30, hard cap 100, and returns versions, last_active_at, unread_count, and alias", async t => {
  const { engine, advanceMs } = createHarness(t);

  for (let i = 1; i <= 35; i += 1) {
    advanceMs(1000);
    await engine.invoke({
      action: "create",
      actorIdentity: ALICE,
      params: { title: `列表板-${i}`, board_id: `list-board-${String(i).padStart(2, "0")}` },
    });
  }

  // 给最新板发 2 条帖制造未读
  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "list-board-35" },
    params: { body: "消息1" },
  });
  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "list-board-35" },
    params: { body: "消息2" },
  });

  const page1 = await engine.invoke({ action: "list", actorIdentity: ALICE });
  assert.equal(page1.boards.length, 30);
  assert.equal(page1.total, 35);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);

  const top = page1.boards[0];
  assert.equal(top.board_id, "list-board-35");
  assert.equal(top.alias, "列表板-35");
  assert.equal(top.meta_version, 1);
  assert.equal(top.state_version, 0);
  assert.equal(top.archive_version, 0);
  assert.equal(top.unread_count, 2);
  assert.ok(Number.isFinite(Date.parse(top.last_active_at)));

  const page2 = await engine.invoke({
    action: "list",
    actorIdentity: ALICE,
    params: { cursor: page1.next_cursor },
  });
  assert.equal(page2.boards.length, 5);
  assert.equal(page2.has_more, false);
  assert.equal(page2.next_cursor, null);

  // 硬顶 100 允许，101 拒绝
  const all100 = await engine.invoke({ action: "list", actorIdentity: ALICE, params: { limit: 100 } });
  assert.equal(all100.boards.length, 35);
  await assert.rejects(
    engine.invoke({ action: "list", actorIdentity: ALICE, params: { limit: 101 } }),
    { code: "invalid_input" },
  );
});

test("shouldNotifyMemberForPost @ mention pierces mute/only without changing poll cadence, and cross-machine forces poll_cross_machine", async t => {
  const aliceKey = identityKey(ALICE);
  const bobKey = identityKey(BOB);
  const carolKey = identityKey(CAROL);

  // @ 穿透全静音 mute
  assert.deepEqual(
    shouldNotifyMemberForPost(
      { ...BOB, member_key: bobKey, subscription_state: "active", filter_mode: "mute", filter_targets: [] },
      { author_key: aliceKey, mentions: [bobKey] },
    ),
    { notify: true, reason: "mentioned", changePollCadence: false },
  );

  // @ 穿透屏蔽指定作者 mute
  assert.deepEqual(
    shouldNotifyMemberForPost(
      { ...BOB, member_key: bobKey, subscription_state: "active", filter_mode: "mute", filter_targets: [aliceKey] },
      { author_key: aliceKey, mentions: [bobKey] },
    ),
    { notify: true, reason: "mentioned", changePollCadence: false },
  );

  // @ 穿透 only
  assert.deepEqual(
    shouldNotifyMemberForPost(
      { ...BOB, member_key: bobKey, subscription_state: "active", filter_mode: "only", filter_targets: [carolKey] },
      { author_key: aliceKey, mentions: [bobKey] },
    ),
    { notify: true, reason: "mentioned", changePollCadence: false },
  );

  // 无 @ 时 mute / only 正确拦截
  assert.deepEqual(
    shouldNotifyMemberForPost(
      { ...BOB, member_key: bobKey, subscription_state: "active", filter_mode: "only", filter_targets: [carolKey] },
      { author_key: aliceKey, mentions: [] },
    ),
    { notify: false, reason: "only_filtered", changePollCadence: false },
  );
  assert.deepEqual(
    shouldNotifyMemberForPost(
      { ...BOB, member_key: bobKey, subscription_state: "active", filter_mode: "only", filter_targets: [aliceKey] },
      { author_key: aliceKey, mentions: [] },
    ),
    { notify: true, reason: "only_matched", changePollCadence: false },
  );
  assert.deepEqual(
    shouldNotifyMemberForPost(
      { ...BOB, member_key: bobKey, subscription_state: "active", filter_mode: "all", filter_targets: [] },
      { author_key: bobKey, mentions: [bobKey] },
    ),
    { notify: false, reason: "self_post", changePollCadence: false },
  );

  // set_subscription：本机成员允许 event，跨机成员强置 poll_cross_machine 且不走本机 event 推送
  const { engine, deliveredNotifications } = createHarness(t);
  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "通知模式板", board_id: "notify-mode-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "notify-mode-board" },
    params: { members: [BOB, REMOTE_DAVE] },
  });

  const localPref = await engine.invoke({
    action: "set_subscription",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "notify-mode-board" },
    params: { delivery_mode: "event", filter_mode: "all" },
  });
  assert.equal(localPref.delivery_mode, "event");
  assert.equal(localPref.effective_delivery_mode, "event");

  const remotePref = await engine.invoke({
    action: "set_subscription",
    actorIdentity: REMOTE_DAVE,
    board: { machine_id: DEV_MACHINE, board_id: "notify-mode-board" },
    params: { delivery_mode: "event", filter_mode: "all" },
  });
  assert.equal(remotePref.delivery_mode, "poll");
  assert.equal(remotePref.effective_delivery_mode, "poll_cross_machine");

  // ALICE 发帖：仅本机 event 成员 BOB 立即收到 event_post，REMOTE_DAVE 不走本机 event
  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "notify-mode-board" },
    params: { body: "实时通知验证" },
  });
  assert.equal(deliveredNotifications.length, 1);
  assert.equal(deliveredNotifications[0].kind, "event_post");
  assert.equal(deliveredNotifications[0].member.conversation_id, "conv-bob");
});

test("localNotifyTick aggregates poll posts into 1 digest, sends 0 on no match, retries failed pending notifications, and runAutoArchiveSweep archives silently", async t => {
  const { engine, store, deliveredNotifications, advanceMs, setNotifyImpl } = createHarness(t, {
    limits: { notifyRetryBaseMs: 1000, notifyRetryMaxMs: 8000 },
  });

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "扫板聚合与静默归档板", board_id: "tick-board", settings: { auto_archive_days: 31 } },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "tick-board" },
    params: { members: [BOB, CAROL] },
  });

  // CAROL 静音整板（无 @ 命中应为 0 提醒），BOB 保持默认 poll
  await engine.invoke({
    action: "set_subscription",
    actorIdentity: CAROL,
    board: { machine_id: DEV_MACHINE, board_id: "tick-board" },
    params: { delivery_mode: "poll", filter_mode: "mute", filter_targets: [] },
  });

  // ALICE 连续发 3 帖（不 @ CAROL）
  for (let i = 1; i <= 3; i += 1) {
    await engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "tick-board" },
      params: { body: `第 ${i} 条进展` },
    });
  }

  // 第一次 tick 故意投递失败，验证持久保留 pending 并在退避到期后重试成功
  let shouldFail = true;
  setNotifyImpl(async event => {
    if (shouldFail) return { delivered: false };
    deliveredNotifications.push(event);
    return { delivered: true };
  });

  const tick1 = await engine.localNotifyTick();
  assert.equal(tick1.digests_enqueued, 1); // 仅 BOB 有 1 条聚合摘要，CAROL 与 ALICE 均 0 提醒
  assert.equal(tick1.failed, 1);
  assert.equal(deliveredNotifications.length, 0);

  // 未到退避时间，不会提前重发
  const tickEarly = await engine.localNotifyTick();
  assert.equal(tickEarly.delivered, 0);
  assert.equal(tickEarly.digests_enqueued, 0);

  // 推进时间并恢复送达，重试送出那 1 条聚合摘要（含 3 条帖子）
  shouldFail = false;
  advanceMs(2000);
  const tick2 = await engine.localNotifyTick();
  assert.equal(tick2.delivered, 1);
  assert.equal(deliveredNotifications.length, 1);
  assert.equal(deliveredNotifications[0].kind, "poll_digest");
  assert.equal(deliveredNotifications[0].member.conversation_id, "conv-bob");
  assert.equal(deliveredNotifications[0].payload.matched_count, 3);
  assert.equal(deliveredNotifications[0].payload.from_seq, 1);
  assert.equal(deliveredNotifications[0].payload.to_seq, 3);

  // 验证 @ 穿透 mute：ALICE 发第 4 条 @ CAROL -> CAROL 收到 1 条摘要
  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "tick-board" },
    params: { body: "请 Carol 看下", mentions: [CAROL] },
  });
  const tick3 = await engine.localNotifyTick();
  assert.equal(tick3.delivered, 2); // BOB 和 CAROL 各 1 条
  const carolDigest = deliveredNotifications.find(n => n.member.conversation_id === "conv-carol");
  assert.ok(carolDigest);
  assert.equal(carolDigest.payload.mentioned_count, 1);

  // runAutoArchiveSweep：超过 31 天静默归档且零通知！
  const notifCountBeforeSweep = deliveredNotifications.length;
  const totalNotifRowsBeforeSweep = store.notifications.size;
  advanceMs(32 * 24 * 3600 * 1000);
  const sweep = engine.runAutoArchiveSweep();
  assert.equal(sweep.archived_boards.length, 1);
  assert.equal(sweep.archived_boards[0].board_id, "tick-board");
  assert.equal(sweep.archived_boards[0].archive_reason, "auto_inactive_31d");
  assert.ok(store.reconcileCalls >= 1);
  assert.equal(store.notifications.size, totalNotifRowsBeforeSweep);
  assert.equal(deliveredNotifications.length, notifCountBeforeSweep);

  // tick 也不会发出任何自动归档通知
  await engine.localNotifyTick();
  assert.equal(deliveredNotifications.length, notifCountBeforeSweep);
});

test("CommunicationCore.attachBoardEntry integrates cleanly with BoardEngine.invoke via contact alias", async t => {
  const tempDir = mkdtempSync(join(tmpdir(), "board-core-wire-"));
  const coreStore = new MessageStore({ filePath: join(tempDir, "core.sqlite") });
  const core = new CommunicationCore({
    store: coreStore,
    targets: [],
    principals: [{
      id: "p-alice",
      identity: ALICE,
      address_book_identity_bound: true,
      allowed_targets: [],
    }],
    adapters: {},
  });
  core.attachAddressBook({ machineId: DEV_MACHINE });
  const boardStore = new InMemoryBoardStore({ privateRoot: join(tempDir, "private") });
  const engine = new BoardEngine({
    store: boardStore,
    localMachineId: DEV_MACHINE,
    addressBookAdapter: core.addressBook,
    superAdminIdentities: [ADMIN],
  });
  const detach = core.attachBoardEntry({ invoke: arg => engine.invoke(arg), principalIds: ["p-alice"] });

  t.after(async () => {
    await detach();
    engine.close();
    await core.close();
    coreStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const ctx = { principal_id: "p-alice" };
  const created = await core.board(ctx, { caller: ALICE, action: "create", title: "端到端联调板" });
  assert.equal(created.alias, "端到端联调板");

  const posted = await core.board(ctx, {
    caller: ALICE,
    action: "post",
    board: { contact: "端到端联调板" },
    body: "经 core.board 入口发出",
  });
  assert.equal(posted.seq, 1);

  const read = await core.board(ctx, {
    caller: ALICE,
    action: "read",
    board: { contact: "端到端联调板" },
  });
  assert.equal(read.posts.length, 1);
  assert.equal(read.posts[0].body, "经 core.board 入口发出");
});

test("BoardEngine works end-to-end against real SQLite BoardStore when present", async t => {
  const storeModuleUrl = new URL("../src/board-store.mjs", import.meta.url);
  if (!existsSync(storeModuleUrl)) {
    return;
  }
  const { BoardStore } = await import(storeModuleUrl.href);
  let clockMs = Date.parse("2026-11-27T08:00:00.000Z");
  const now = () => clockMs;
  const tempDir = mkdtempSync(join(tmpdir(), "board-real-store-"));
  const privateRoot = join(tempDir, "private");
  const uploadsDir = join(tempDir, "uploads");
  mkdirSync(privateRoot, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });

  const db = new DatabaseSync(join(tempDir, "boards.sqlite"), { enableForeignKeyConstraints: true });
  const addressBook = new ConversationAddressBook({
    database: db,
    machineId: DEV_MACHINE,
    now: () => new Date(clockMs).toISOString(),
  });
  const realStore = new BoardStore({
    database: db,
    privateRoot,
    allowedUploadRoots: [uploadsDir],
    now,
  });

  const delivered = [];
  const engine = new BoardEngine({
    store: realStore,
    localMachineId: DEV_MACHINE,
    addressBookAdapter: addressBook,
    superAdminIdentities: [ADMIN],
    peerCapabilitiesProvider: new Map([
      [TRAIN_MACHINE, { known: true, reachable: true, allow_file_bundle: true }],
    ]),
    notifyLocalMember: async event => {
      delivered.push(event);
      return { delivered: true };
    },
    now,
  });

  t.after(() => {
    engine.close();
    if (db.isOpen) db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const created = await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "真SQLite集成板", board_id: "real-sqlite-board" },
  });
  assert.equal(created.meta_version, 1);

  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
    params: { members: [BOB, REMOTE_DAVE] },
  });

  const filePath = join(uploadsDir, "sample.txt");
  writeFileSync(filePath, "真实SQLite与TOCTOU上传文件内容");

  const posted = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
    params: {
      body: "真库发帖",
      client_post_id: "real-cpost-1",
      files: [{ path: filePath, bundle_id: "real-b1", bundle_label: "真库包" }],
    },
  });
  assert.equal(posted.seq, 1);
  assert.ok(existsSync(posted.uploaded_files[0].local_path));
  assert.deepEqual(posted.target_sync_machines, [TRAIN_MACHINE]);

  // 幂等重放与真库 fingerprint 完全匹配
  const replayed = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
    params: {
      body: "真库发帖",
      client_post_id: "real-cpost-1",
      files: [{ path: filePath, bundle_id: "real-b1", bundle_label: "真库包" }],
    },
  });
  assert.equal(replayed.seq, 1);
  assert.equal(replayed.deduplicated, true);

  // 扫板聚合通知真库落地
  const tick = await engine.localNotifyTick();
  assert.equal(tick.digests_enqueued, 1);
  assert.equal(tick.delivered, 1);
  assert.equal(delivered.length, 1);

  // 解散 -> 恢复 -> 再解散 -> 非成员精确版本永久删除（零通知）
  const d1 = await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
  });
  assert.equal(d1.archive_version, 1);
  assert.equal(d1.state_version, 1);

  const r1 = await engine.invoke({
    action: "restore",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
  });
  assert.equal(r1.status, "active");
  assert.equal(r1.state_version, 2);

  const d2 = await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
  });
  assert.equal(d2.archive_version, 2);
  assert.equal(d2.state_version, 3);

  const notifBeforeDel = delivered.length;
  const del = await engine.invoke({
    action: "delete_archived",
    actorIdentity: OUTSIDER,
    board: { machine_id: DEV_MACHINE, board_id: "real-sqlite-board" },
    params: { expected_archive_version: 2, expected_state_version: 3 },
  });
  assert.equal(del.deleted, true);
  assert.equal(del.final_state_version, 4);
  assert.equal(delivered.length, notifBeforeDel);
  assert.ok(realStore.getTombstone("real-sqlite-board"));

  // 验证客机向真实 BoardStore 写入远端板离线发帖（含特殊字符 client_post_id）与控制请求
  realStore.upsertBoardFromRemote({
    board_id: "real-remote-board",
    host_machine_id: TRAIN_MACHINE,
    title: "真库远端板",
    status: "active",
    state_version: 0,
    meta_version: 1,
    archive_version: 0,
    archive_reason: null,
    settings: { default_file_sync_machines: ["*"], auto_archive_days: 31, default_poll_interval_sec: 90 },
    creator_key: identityKey(REMOTE_DAVE),
    created_at: new Date(clockMs).toISOString(),
    last_active_at: new Date(clockMs).toISOString(),
    archived_at: null,
    members: [REMOTE_DAVE, ALICE],
  });
  const remoteOutboxPost = await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "real-remote-board" },
    params: {
      body: "客机真库离线发帖",
      client_post_id: "req:2026/11/27:special",
      files: [{ path: filePath, bundle_id: "rb-1", bundle_label: "客机真库包" }],
    },
  });
  assert.equal(remoteOutboxPost.pending_host_ack, true);
  assert.equal(remoteOutboxPost.seq, null);
  assert.ok(existsSync(remoteOutboxPost.uploaded_files[0].local_path));
  assert.equal(realStore.listDueRemoteOutbox(TRAIN_MACHINE, clockMs).length, 1);
});

test("postFromRemoteClient and canActorPostToBoard enforce membership-first auth, exclude sender machine from sync targets, and clean up orphaned files on failure", async t => {
  const PEER_BETA = "sample-peer-b";
  const REMOTE_BETA = Object.freeze({ machine_id: PEER_BETA, host: "codex", surface: "desktop", conversation_id: "conv-beta" });
  const REMOTE_OUTSIDER = Object.freeze({ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-r-outsider" });
  const verifiedRemotePrincipal = actor => ({
    trust_source_identity: true,
    source_identity_verified: true,
    from_machine: actor.machine_id,
  });

  const { engine, store, deliveredNotifications, boardChanges, tempDir } = createHarness(t, {
    peerCapabilities: new Map([
      [TRAIN_MACHINE, { known: true, reachable: true, allow_file_bundle: true }],
      [PEER_BETA, { known: true, reachable: true, allow_file_bundle: true }],
    ]),
    limits: { maxFileBytes: 1024, maxBoardFilesBytes: 1500, maxTotalFilesBytes: 2500 },
  });

  // 严禁经由外部 invoke() 暴露
  assert.equal(BOARD_ACTIONS.has("postFromRemoteClient"), false);
  await assert.rejects(
    engine.invoke({ action: "postFromRemoteClient", actorIdentity: REMOTE_DAVE, params: { board_id: "rc-board", body: "nope" } }),
    { code: "invalid_input" },
  );

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "远端发帖测试板", board_id: "rc-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
    params: { members: [BOB, REMOTE_DAVE, REMOTE_BETA] },
  });
  await engine.invoke({
    action: "set_subscription",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
    params: { delivery_mode: "event", filter_mode: "all" },
  });

  // 只读权限辅助方法 canActorPostToBoard 零副作用校验
  assert.deepEqual(engine.canActorPostToBoard(REMOTE_DAVE, "rc-board"), { allowed: true });
  assert.deepEqual(engine.canActorPostToBoard(ADMIN, "rc-board"), { allowed: true });
  assert.deepEqual(engine.canActorPostToBoard(REMOTE_OUTSIDER, "rc-board"), { allowed: false, reason: "forbidden" });
  assert.deepEqual(engine.canActorPostToBoard(REMOTE_DAVE, "no-such-board"), { allowed: false, reason: "board_not_found" });

  const makePreStaged = (boardId, fileId, safeName, content) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const filesDir = store.getBoardFilesDir(boardId);
    mkdirSync(filesDir, { recursive: true });
    const localPath = store.resolveSafeBoardFilePath(boardId, fileId, safeName);
    writeFileSync(localPath, buf);
    return {
      file_id: fileId,
      safe_name: safeName,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      rel_path: `boards/${boardId}/files/${fileId}_${safeName}`,
      local_path: localPath,
    };
  };

  // 1. 成功路径：发件客机 TRAIN_MACHINE 必须从 target_sync_machines 中排除，仅同步给另一远端机 PEER_BETA；触发本机 event 提醒与变更事件
  const okFile = makePreStaged("rc-board", "rf-1", "remote.txt", "来自远端客机的附件");
  const changesBefore = boardChanges.length;
  const posted = await engine.postFromRemoteClient(
    REMOTE_DAVE,
    { body: "远端成员带附件发帖", client_post_id: "rc-p1" },
    {
      board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
      preStagedFiles: [okFile],
      remotePrincipal: verifiedRemotePrincipal(REMOTE_DAVE),
    },
  );
  assert.equal(posted.seq, 1);
  assert.deepEqual(posted.target_sync_machines, [PEER_BETA]);
  assert.equal(posted.target_sync_machines.includes(TRAIN_MACHINE), false);
  assert.equal(posted.unreachable_machines.length, 0);
  assert.equal(store.fileSyncQueue.length, 1);
  assert.equal(store.fileSyncQueue[0].peer_machine_id, PEER_BETA);
  assert.equal(existsSync(okFile.local_path), true);
  assert.equal(deliveredNotifications.length, 1);
  assert.equal(deliveredNotifications[0].kind, "event_post");
  assert.equal(deliveredNotifications[0].member.conversation_id, "conv-bob");
  assert.equal(boardChanges.slice(changesBefore).some(e => e.kind === "post_created" && e.seq === 1), true);

  // 2. 失败清理孤儿文件：board_post_conflict（同名去重键不同内容）清理本次新落盘文件，但不误删已提交帖子引用的文件
  const orphanConflict = makePreStaged("rc-board", "rf-conflict", "orphan.txt", "冲突孤儿");
  await assert.rejects(
    engine.postFromRemoteClient(
      REMOTE_DAVE,
      { body: "篡改内容制造冲突", client_post_id: "rc-p1" },
      {
        board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
        preStagedFiles: [orphanConflict],
        remotePrincipal: verifiedRemotePrincipal(REMOTE_DAVE),
      },
    ),
    { code: "board_post_conflict" },
  );
  assert.equal(existsSync(orphanConflict.local_path), false, "冲突失败必须清理本次新落盘孤儿文件");
  assert.equal(existsSync(okFile.local_path), true, "已提交帖子引用的文件绝不可被误删");

  // 3. 单文件超 15 MiB（测试定制 1024 B）与超单板配额（1500 B）均拒且立即清孤儿
  const tooLargeFile = makePreStaged("rc-board", "rf-big", "big.bin", Buffer.alloc(1025, 0x61));
  await assert.rejects(
    engine.postFromRemoteClient(
      REMOTE_DAVE,
      { body: "单文件超限", client_post_id: "rc-big" },
      {
        board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
        preStagedFiles: [tooLargeFile],
        remotePrincipal: verifiedRemotePrincipal(REMOTE_DAVE),
      },
    ),
    { code: "board_file_too_large" },
  );
  assert.equal(existsSync(tooLargeFile.local_path), false);

  const q1 = makePreStaged("rc-board", "rf-q1", "q1.bin", Buffer.alloc(800, 0x62));
  const q2 = makePreStaged("rc-board", "rf-q2", "q2.bin", Buffer.alloc(800, 0x63));
  await assert.rejects(
    engine.postFromRemoteClient(
      REMOTE_DAVE,
      { body: "单板配额超限", client_post_id: "rc-quota" },
      {
        board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
        preStagedFiles: [q1, q2],
        remotePrincipal: verifiedRemotePrincipal(REMOTE_DAVE),
      },
    ),
    { code: "board_quota_exceeded" },
  );
  assert.equal(existsSync(q1.local_path), false);
  assert.equal(existsSync(q2.local_path), false);

  // 4. 越界路径绝不允许且绝不误删板外文件
  const outsideFile = join(tempDir, "outside-keep.txt");
  writeFileSync(outsideFile, "板外宝贵文件");
  await assert.rejects(
    engine.postFromRemoteClient(
      REMOTE_DAVE,
      { body: "越界路径探测", client_post_id: "rc-escape" },
      {
        board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
        preStagedFiles: [{
          file_id: "rf-esc",
          safe_name: "outside-keep.txt",
          bytes: 18,
          sha256: createHash("sha256").update("板外宝贵文件").digest("hex"),
          rel_path: "boards/rc-board/files/rf-esc_outside-keep.txt",
          local_path: outsideFile,
        }],
        remotePrincipal: verifiedRemotePrincipal(REMOTE_DAVE),
      },
    ),
    { code: "invalid_input" },
  );
  assert.equal(existsSync(outsideFile), true, "板外文件绝不可被清理逻辑删除");

  // 5. 归档板对非成员仍先拒 forbidden（不泄露 board_archived）且清理新落盘孤儿文件；活跃成员则看到 board_archived
  await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
  });
  assert.deepEqual(engine.canActorPostToBoard(REMOTE_OUTSIDER, "rc-board"), { allowed: false, reason: "forbidden" });
  assert.deepEqual(engine.canActorPostToBoard(REMOTE_DAVE, "rc-board"), { allowed: false, reason: "board_archived" });

  const orphanForbidden = makePreStaged("rc-board", "rf-forb", "forb.txt", "非成员孤儿");
  await assert.rejects(
    engine.postFromRemoteClient(
      REMOTE_OUTSIDER,
      { body: "非成员探测归档板", client_post_id: "rc-forb" },
      {
        board: { machine_id: DEV_MACHINE, board_id: "rc-board" },
        preStagedFiles: [orphanForbidden],
        remotePrincipal: verifiedRemotePrincipal(REMOTE_OUTSIDER),
      },
    ),
    { code: "forbidden" },
  );
  assert.equal(existsSync(orphanForbidden.local_path), false);
});

test("client control outbox writes params key aligned with board-sync.mjs and multi-file upload rollback cleans .staging and .outbox", async t => {
  // Part 1：验证 #enqueueClientControlRequest 写入 params 字段（而非旧 payload 字段）
  const { engine, store, writeUpload } = createHarness(t);
  const nowIso = "2026-11-27T08:00:00.000Z";
  store.seedRemoteBoard({
    board: {
      board_id: "ctrl-remote-board",
      host_machine_id: TRAIN_MACHINE,
      title: "控制对齐板",
      status: "active",
      state_version: 0,
      meta_version: 1,
      archive_version: 0,
      archive_reason: null,
      settings: { default_file_sync_machines: ["*"], auto_archive_days: 31, default_poll_interval_sec: 90 },
      board_seq: 0,
      creator_key: identityKey(REMOTE_DAVE),
      created_at: nowIso,
      last_active_at: nowIso,
      archived_at: null,
    },
    members: [REMOTE_DAVE, ALICE],
    posts: [],
  });

  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "ctrl-remote-board" },
    params: { members: [BOB] },
  });
  await engine.invoke({
    action: "update_settings",
    actorIdentity: ALICE,
    board: { machine_id: TRAIN_MACHINE, board_id: "ctrl-remote-board" },
    params: { settings: { auto_archive_days: 20 } },
  });

  const invitePayload = JSON.parse(store.outbox[0].payload_json);
  assert.deepEqual(invitePayload.params, { members: [BOB] });
  assert.equal(Object.hasOwn(invitePayload, "payload"), false);

  const settingsPayload = JSON.parse(store.outbox[1].payload_json);
  assert.deepEqual(settingsPayload.params, { settings: { auto_archive_days: 20 } });
  assert.equal(Object.hasOwn(settingsPayload, "payload"), false);

  // Part 2：多文件上传第 2 个失败立即回滚清理第 1 个 .staging 文件与 .outbox 目录（含优先调 store cleanup 钩子与默认 fs 回退）
  const f1 = writeUpload("good-1.txt", "文件一内容-100字节".padEnd(100, "x"));
  const f2 = writeUpload("good-2.txt", "文件二内容-100字节".padEnd(100, "y"));

  // 2a. 建板机 .staging 回滚（fs.rmSync 默认回退）：总配额 150 B，第 1 个 100 B 落 .staging，第 2 个 100 B 触发 board_quota_exceeded
  const quotaHarness = createHarness(t, { limits: { maxBoardFilesBytes: 150, maxTotalFilesBytes: 1000 } });
  const qf1 = quotaHarness.writeUpload("q1.txt", "A".repeat(100));
  const qf2 = quotaHarness.writeUpload("q2.txt", "B".repeat(100));
  await quotaHarness.engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "回滚测试板", board_id: "rollback-board" },
  });
  await assert.rejects(
    quotaHarness.engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "rollback-board" },
      params: { body: "双文件超配额", files: [{ path: qf1 }, { path: qf2 }] },
    }),
    { code: "board_quota_exceeded" },
  );
  const stagingFilesAfterFail = existsSync(quotaHarness.store.getStagingDir())
    ? readdirSync(quotaHarness.store.getStagingDir())
    : [];
  assert.deepEqual(stagingFilesAfterFail, [], "第 2 个文件失败后 .staging 目录绝不可残留第 1 个 .tmp");

  // 2b. 建板机 .staging 回滚（真 SQLite BoardStore：第 2 个文件触发 upload_path_denied）
  const { BoardStore } = await import(new URL("../src/board-store.mjs", import.meta.url).href);
  const realTmp = mkdtempSync(join(tmpdir(), "board-rollback-real-"));
  const realPriv = join(realTmp, "private");
  const allowedDir = join(realTmp, "allowed");
  const deniedDir = join(realTmp, "denied");
  mkdirSync(realPriv, { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(deniedDir, { recursive: true });
  const realDb = new DatabaseSync(join(realTmp, "boards.sqlite"), { enableForeignKeyConstraints: true });
  const realStore = new BoardStore({ database: realDb, privateRoot: realPriv, allowedUploadRoots: [allowedDir] });
  const realEngine = new BoardEngine({ store: realStore, localMachineId: DEV_MACHINE });
  t.after(() => {
    realEngine.close();
    if (realDb.isOpen) realDb.close();
    rmSync(realTmp, { recursive: true, force: true });
  });

  await realEngine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "真库回滚板", board_id: "real-rb-board" },
  });
  const allowedFile = join(allowedDir, "ok.txt");
  const deniedFile = join(deniedDir, "blocked.txt");
  writeFileSync(allowedFile, "允许目录的合法文件");
  writeFileSync(deniedFile, "越权目录的非法文件");

  await assert.rejects(
    realEngine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "real-rb-board" },
      params: { body: "第2个路径越权", files: [{ path: allowedFile }, { path: deniedFile }] },
    }),
    { code: "upload_path_denied" },
  );
  const realStagingLeft = existsSync(realStore.getStagingDir()) ? readdirSync(realStore.getStagingDir()) : [];
  assert.deepEqual(realStagingLeft, [], "真库多文件第 2 个 upload_path_denied 后 .staging 必须清零");

  // 2c. 客机 .outbox 回滚（第 2 个文件 upload_path_denied 立即清整个 .outbox/<local_post_id>/）
  realStore.upsertBoardFromRemote({
    board_id: "real-rb-remote",
    host_machine_id: TRAIN_MACHINE,
    title: "真库远端回滚板",
    status: "active",
    state_version: 0,
    meta_version: 1,
    archive_version: 0,
    settings: { default_file_sync_machines: ["*"], auto_archive_days: 31, default_poll_interval_sec: 90 },
    creator_key: identityKey(REMOTE_DAVE),
    created_at: nowIso,
    last_active_at: nowIso,
    members: [REMOTE_DAVE, ALICE],
  });
  await assert.rejects(
    realEngine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: TRAIN_MACHINE, board_id: "real-rb-remote" },
      params: {
        body: "客机第2个越权",
        client_post_id: "rb-outbox-1",
        files: [{ path: allowedFile }, { path: deniedFile }],
      },
    }),
    { code: "upload_path_denied" },
  );
  assert.equal(existsSync(realStore.getOutboxDir("rb-outbox-1")), false, "客机第 2 个失败后整个 .outbox/<local_post_id> 必须立即删除");

  // 2d. 优先调用 store.cleanupStagedTempFiles 与 store.cleanupOutboxDir
  const cleanupCalls = { staged: [], outbox: [] };
  const origStageOutbox = store.stageOutboxAttachment.bind(store);
  let outboxCount = 0;
  store.stageOutboxAttachment = args => {
    outboxCount += 1;
    if (outboxCount === 2) throw new CoreError("board_file_too_large", "第二文件过大");
    return origStageOutbox(args);
  };
  store.cleanupOutboxDir = localPostId => {
    cleanupCalls.outbox.push(localPostId);
    rmSync(store.getOutboxDir(localPostId), { recursive: true, force: true });
  };
  await assert.rejects(
    engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: TRAIN_MACHINE, board_id: "ctrl-remote-board" },
      params: { body: "客机钩子清理", client_post_id: "hook-ob-1", files: [{ path: f1 }, { path: f2 }] },
    }),
    { code: "board_file_too_large" },
  );
  assert.deepEqual(cleanupCalls.outbox, ["hook-ob-1"]);
  assert.equal(existsSync(store.getOutboxDir("hook-ob-1")), false);

  store.cleanupStagedTempFiles = names => {
    cleanupCalls.staged.push(...names);
    for (const n of names) rmSync(join(store.getStagingDir(), n), { force: true });
  };
  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "钩子清理板", board_id: "hook-stage-board" },
  });
  const origStageLocal = store.stageLocalUploadFile.bind(store);
  let localCount = 0;
  store.stageLocalUploadFile = args => {
    localCount += 1;
    if (localCount === 2) throw new CoreError("upload_path_denied", "拒绝");
    return origStageLocal(args);
  };
  await assert.rejects(
    engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "hook-stage-board" },
      params: { body: "本地钩子清理", files: [{ path: f1 }, { path: f2 }] },
    }),
    { code: "upload_path_denied" },
  );
  assert.equal(cleanupCalls.staged.length, 1);

  // 2e. 真 SQLite BoardStore 上 postFromRemoteClient 零双算配额验证
  const realRemoteEngine = new BoardEngine({
    store: realStore,
    localMachineId: DEV_MACHINE,
    limits: { maxBoardFilesBytes: 500, maxTotalFilesBytes: 1000 },
  });
  t.after(() => realRemoteEngine.close());
  await realRemoteEngine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "real-rb-board" },
    params: { members: [REMOTE_DAVE] },
  });
  const buf300 = Buffer.alloc(300, 0x7a);
  const sha300 = createHash("sha256").update(buf300).digest("hex");
  const stagedRemote = realStore.stageRemoteFileBufferOrPath({
    buffer: buf300,
    boardId: "real-rb-board",
    fileId: "real-rf-300",
    safeName: "chunk300.bin",
    expectedSha256: sha300,
    expectedBytes: 300,
  });
  // 300 B <= 500 B（若错误双算 300+300=600 就会误拒！）
  const postedRealRemote = await realRemoteEngine.postFromRemoteClient(
    REMOTE_DAVE,
    { body: "真库零双算验证", client_post_id: "real-rc-300" },
    {
      board: { machine_id: DEV_MACHINE, board_id: "real-rb-board" },
      preStagedFiles: [{
        file_id: "real-rf-300",
        safe_name: "chunk300.bin",
        bytes: 300,
        sha256: sha300,
        rel_path: stagedRemote.rel_path,
        local_path: stagedRemote.local_path,
      }],
      remotePrincipal: { trust_source_identity: true, source_identity_verified: true, from_machine: TRAIN_MACHINE },
    },
  );
  assert.equal(postedRealRemote.seq, 1);
});

test("invoke forwards remotePrincipal and delete_archived enforces zero-leak sanitization for unauthorized cross-machine callers", async t => {
  const { engine, store, deliveredNotifications } = createHarness(t);
  const REMOTE_OUTSIDER = Object.freeze({ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-rem-out" });

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "机密代号Omega77", board_id: "omega-board" },
  });
  await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "omega-board" },
  });

  // 1. invoke 透传非法 remotePrincipal -> 拒 source_unverified（不暴露任何板信息）
  await assert.rejects(
    engine.invoke({
      action: "delete_archived",
      actorIdentity: REMOTE_OUTSIDER,
      board: { machine_id: DEV_MACHINE, board_id: "omega-board" },
      params: { expected_archive_version: 1 },
      remotePrincipal: { trust_source_identity: true, source_identity_verified: false, from_machine: TRAIN_MACHINE },
    }),
    { code: "source_unverified" },
  );

  // 其他写动作经 invoke 透传非法 remotePrincipal 也一致校验
  await assert.rejects(
    engine.invoke({
      action: "subscribe",
      actorIdentity: REMOTE_OUTSIDER,
      board: { machine_id: DEV_MACHINE, board_id: "omega-board" },
      params: {},
      remotePrincipal: { trust_source_identity: false, source_identity_verified: true, from_machine: TRAIN_MACHINE },
    }),
    { code: "source_unverified" },
  );

  // 2. 跨机未授权（无 remotePrincipal）调用 delete_archived -> 统一脱敏 board_not_found 且零泄露
  let errNoPrincipal;
  try {
    await engine.invoke({
      action: "delete_archived",
      actorIdentity: REMOTE_OUTSIDER,
      board: { machine_id: DEV_MACHINE, board_id: "omega-board" },
      params: { expected_archive_version: 1 },
    });
  } catch (error) {
    errNoPrincipal = error;
  }
  assert.equal(errNoPrincipal?.code, "board_not_found");
  assert.equal(errNoPrincipal.message.includes("机密代号Omega77"), false);
  assert.deepEqual(errNoPrincipal.details, {});
  assert.ok(store.getBoard("omega-board"), "未授权跨机请求绝不可删除归档板");

  // 3. 带合法 remotePrincipal 但版本不符 -> 统一脱敏 board_not_found
  await assert.rejects(
    engine.invoke({
      action: "delete_archived",
      actorIdentity: REMOTE_OUTSIDER,
      board: { machine_id: DEV_MACHINE, board_id: "omega-board" },
      params: { expected_archive_version: 99 },
      remotePrincipal: { trust_source_identity: true, source_identity_verified: true, from_machine: TRAIN_MACHINE },
    }),
    err => err.code === "board_not_found" && !err.message.includes("Omega77") && Object.keys(err.details ?? {}).length === 0,
  );

  // 4. 带合法 remotePrincipal 且精确版本 -> 允许删除且 0 通知
  const notifBefore = deliveredNotifications.length;
  const delOk = await engine.invoke({
    action: "delete_archived",
    actorIdentity: REMOTE_OUTSIDER,
    board: { machine_id: DEV_MACHINE, board_id: "omega-board" },
    params: { expected_archive_version: 1 },
    remotePrincipal: { trust_source_identity: true, source_identity_verified: true, from_machine: TRAIN_MACHINE },
  });
  assert.equal(delOk.deleted, true);
  assert.equal(deliveredNotifications.length, notifBefore);
  assert.ok(store.getTombstone("omega-board"));
});

test("dissolveBoard enqueues dissolved notifications only for local active members with unified archive_version dedupe_key and complete payload", async t => {
  const { engine, store, addressBook, deliveredNotifications } = createHarness(t);
  addressBook.saveAddress(principal(BOB), { alias: "解散人爱丽丝", target: ALICE });

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "解散去重验证板", board_id: "dissolve-dedupe-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "dissolve-dedupe-board" },
    params: { members: [BOB, CAROL, REMOTE_DAVE] },
  });
  // CAROL 退订，不应收到解散通知
  await engine.invoke({
    action: "unsubscribe",
    actorIdentity: CAROL,
    board: { machine_id: DEV_MACHINE, board_id: "dissolve-dedupe-board" },
  });

  // 验证 dissolveBoard 不再扫描全表 256 条 listDueNotifications
  let listDueCalls = 0;
  const origListDue = store.listDueNotifications.bind(store);
  store.listDueNotifications = (...args) => {
    listDueCalls += 1;
    return origListDue(...args);
  };

  // 第一次解散（archive_version=1, state_version=1）-> 恢复（state_version=2）-> 第二次解散（archive_version=2, state_version=3）
  await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "dissolve-dedupe-board" },
  });
  await engine.invoke({
    action: "restore",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "dissolve-dedupe-board" },
  });
  deliveredNotifications.length = 0;
  store.notifications.clear();

  const d2 = await engine.invoke({
    action: "dissolve",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "dissolve-dedupe-board" },
  });
  assert.equal(d2.archive_version, 2);
  assert.equal(d2.state_version, 3);
  assert.equal(listDueCalls, 0, "dissolveBoard 绝不依赖扫全表 listDueNotifications");

  // 仅本机活跃成员 ALICE、BOB 入队，绝无跨机 REMOTE_DAVE 或已退订 CAROL
  assert.equal(store.notifications.size, 2);
  const expectedKeys = [
    `dissolved:dissolve-dedupe-board:2:${identityKey(ALICE)}`,
    `dissolved:dissolve-dedupe-board:2:${identityKey(BOB)}`,
  ].sort();
  assert.deepEqual([...store.notifications.keys()].sort(), expectedKeys);

  // 校验 payload 完整字段
  const bobNotif = deliveredNotifications.find(n => n.member.conversation_id === "conv-bob");
  assert.ok(bobNotif);
  assert.equal(bobNotif.dedupe_key, `dissolved:dissolve-dedupe-board:2:${identityKey(BOB)}`);
  assert.equal(bobNotif.payload.host_machine_id, DEV_MACHINE);
  assert.equal(bobNotif.payload.dissolved_by_key, identityKey(ALICE));
  assert.equal(bobNotif.payload.dissolved_by_display, "解散人爱丽丝");
  assert.equal(bobNotif.payload.restorable, true);
});

test("MCP board read budgets the original submitted caller and preserves pagination and expanded reads", async t => {
  const { engine, tempDir } = createHarness(t);
  const caller = { ...ALICE, surface: "s".repeat(64), conversation_id: "bound-" + "\\".repeat(250) };
  const registered = { id: "synthetic-long-board-reader", token: "synthetic-long-board-reader-token",
    identity: caller, address_book_identity_bound: true, allowed_targets: [], origin_kinds: ["agent_message"] };
  const board = { machine_id: DEV_MACHINE, board_id: "mcp-budget-fixture" };
  const body = "汉🚲".repeat(2000);
  await engine.invoke({ action: "create", actorIdentity: caller, params: { title: "回执预算测试", board_id: board.board_id } });
  await engine.invoke({ action: "post", actorIdentity: caller, board, params: { body } });
  await engine.invoke({ action: "post", actorIdentity: caller, board, params: { body: "后续一页" } });
  const store = new MessageStore({ filePath: join(tempDir, "mcp-budget.sqlite") });
  const core = new CommunicationCore({ store, targets: [], principals: [registered], adapters: {} });
  core.attachAddressBook({ machineId: DEV_MACHINE });
  core.attachBoardEntry({ invoke: invocation => engine.invoke(invocation), principalIds: [registered.id] });
  const client = new Client({ name: "synthetic-board-budget-test", version: "1" });
  let service;
  try {
    await core.start();
    service = await createMcpHttpServer({ core, principals: [registered] });
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { Authorization: `Bearer ${registered.token}` } },
    }));
    async function read(params = {}) {
      const result = await client.callTool({ name: "communication_board", arguments: { caller, action: "read", board, ...params } });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.deepEqual(result.structuredContent.caller, caller);
      return result;
    }
    const first = await read();
    const serializedBytes = Buffer.byteLength(JSON.stringify(first.structuredContent), "utf8");
    const textBytes = Buffer.byteLength(first.content[0].text, "utf8");
    t.diagnostic(`Board read with caller: ${serializedBytes} structured bytes / ${textBytes} text bytes`);
    assert.ok(serializedBytes < 9216, `board data with caller exceeded 9 KiB: ${serializedBytes}`);
    assert.ok(textBytes < 9216);
    assert.equal(first.structuredContent.posts[0].truncated, true);
    assert.equal(first.structuredContent.posts[0].full_body_chars, [...body].length);
    assert.equal(first.structuredContent.has_more, true);
    assert.equal(first.structuredContent.next_after_seq, 1);
    const second = await read({ after_seq: first.structuredContent.next_after_seq });
    assert.deepEqual(second.structuredContent.posts.map(post => post.seq), [2]);
    assert.equal(second.structuredContent.has_more, false);
    const expanded = await read({ seq: 1, max_total_chars: 16000 });
    assert.equal(expanded.structuredContent.posts[0].body, body);
  } finally {
    await client.close();
    await service?.close();
    await core.close();
    store.close();
  }
});

test("read enforces < 9 KiB UTF-8 serialized byte budget on 50 Chinese posts, single giant Chinese post, and multi-file posts", async t => {
  const { engine, writeUpload } = createHarness(t);
  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "全中文序列化字节预算板", board_id: "cjk-budget-board" },
  });

  // 1. 全中文 50 帖（每帖 100 汉字 = 300 字节，50 帖总字符仅 5000 < 6000 但总 JSON > 25 KiB）
  for (let i = 1; i <= 50; i += 1) {
    await engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "cjk-budget-board" },
      params: { body: `第${String(i).padStart(2, "0")}帖：` + "汉".repeat(95) },
    });
  }

  let cursor = 0;
  const collectedSeqs = [];
  let pages = 0;
  while (pages < 20) {
    pages += 1;
    const page = await engine.invoke({
      action: "read",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "cjk-budget-board" },
      params: { after_seq: cursor },
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    assert.ok(serializedBytes <= 8900 && serializedBytes < 9216, `第 ${pages} 页序列化字节 ${serializedBytes} 必须 <= 8900 (< 9216 B)`);
    assert.ok(page.posts.length > 0);
    for (const p of page.posts) collectedSeqs.push(p.seq);
    cursor = page.next_after_seq;
    if (!page.has_more) break;
  }
  assert.ok(pages >= 2, "全中文 50 帖必须分页截断");
  assert.equal(collectedSeqs.length, 50, "逐页翻完应无遗漏拿齐全部 50 帖");
  assert.equal(collectedSeqs[49], 50);

  // 2. 超长全中文单帖（5000 汉字 = 15000 B UTF-8，字符数 < 6000 但字节远超 9 KiB）
  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "单帖全中文板", board_id: "cjk-single-board" },
  });
  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "cjk-single-board" },
    params: { body: "测".repeat(5000) },
  });
  const readGiant = await engine.invoke({
    action: "read",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "cjk-single-board" },
  });
  const giantBytes = Buffer.byteLength(JSON.stringify(readGiant), "utf8");
  assert.ok(giantBytes <= 8900 && giantBytes < 9216, `超长全中文单帖序列化字节 ${giantBytes} 必须 <= 8900`);
  assert.equal(readGiant.posts.length, 1);
  assert.equal(readGiant.posts[0].truncated, true);
  assert.equal(readGiant.posts[0].full_body_chars, 5000);
  assert.equal(readGiant.posts[0].body.includes("\ufffd"), false);

  // 显式传超大 max_total_chars 允许单帖精读全文
  const readFull = await engine.invoke({
    action: "read",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "cjk-single-board" },
    params: { seq: 1, max_total_chars: 16000 },
  });
  assert.equal(readFull.posts[0].truncated, false);
  assert.equal([...readFull.posts[0].body].length, 5000);

  // 3. 50 条多附件短帖同样严守 <= 8900 B
  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "多附件预算板", board_id: "files-budget-board" },
  });
  const att1 = writeUpload("att-budget-1.txt", "a");
  const att2 = writeUpload("att-budget-2.txt", "b");
  for (let i = 1; i <= 50; i += 1) {
    await engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "files-budget-board" },
      params: {
        body: `附${i}`,
        files: [
          { path: att1, name: `material-alpha-${i}.txt`, bundle_id: `b-${i}`, bundle_label: "评审附件包" },
          { path: att2, name: `material-beta-${i}.txt`, bundle_id: `b-${i}`, bundle_label: "评审附件包" },
        ],
      },
    });
  }
  const readFilesPage = await engine.invoke({
    action: "read",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "files-budget-board" },
  });
  const filesPageBytes = Buffer.byteLength(JSON.stringify(readFilesPage), "utf8");
  assert.ok(filesPageBytes <= 8900 && filesPageBytes < 9216, `多附件帖序列化字节 ${filesPageBytes} 必须 <= 8900`);
  assert.equal(readFilesPage.has_more, true);
  assert.ok(readFilesPage.posts.length < 50);
});

test("normalizeEngineSettings aligns default_file_sync_machines validation and listBoards reuses embedded member/last_synced_at without duplicate queries", async t => {
  const { engine, store } = createHarness(t);

  // 1. 禁止 "*" 与具体机器 ID 混用，上限统一 128
  await assert.rejects(
    engine.invoke({
      action: "create",
      actorIdentity: ALICE,
      params: { title: "非法混用板", settings: { default_file_sync_machines: ["*", TRAIN_MACHINE] } },
    }),
    { code: "invalid_input" },
  );

  const machines128 = Array.from({ length: 128 }, (_, i) => `machine-${i}`);
  const created128 = await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "128机上限板", board_id: "m128-board", settings: { default_file_sync_machines: machines128 } },
  });
  assert.equal(created128.settings.default_file_sync_machines.length, 128);

  const machines129 = Array.from({ length: 129 }, (_, i) => `machine-${i}`);
  await assert.rejects(
    engine.invoke({
      action: "update_settings",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "m128-board" },
      params: { settings: { default_file_sync_machines: machines129 } },
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    engine.invoke({
      action: "update_settings",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "m128-board" },
      params: { settings: { default_file_sync_machines: [TRAIN_MACHINE, "*"] } },
    }),
    { code: "invalid_input" },
  );

  // 2. listBoards 复用 rawItem.member / 扁平成员字段 / last_synced_at，0 次重复查询 getMember / getSyncState
  let getMemberCalls = 0;
  let getSyncStateCalls = 0;
  const origListBoards = store.listBoardsForActor.bind(store);
  store.listBoardsForActor = args => {
    const res = origListBoards(args);
    return {
      ...res,
      items: [
        // 形式 A：带嵌套 member 与 last_synced_at
        {
          ...res.items[0],
          board_seq: 5,
          member: { subscription_state: "active", delivery_mode: "event", last_read_seq: 2 },
          last_synced_at: "2026-11-27T08:05:00.000Z",
        },
        // 形式 B：真实 SQLite BoardStore 扁平返回字段（跨机板）
        {
          ...res.items[0],
          board_id: "flat-remote-board",
          host_machine_id: TRAIN_MACHINE,
          board_seq: 10,
          subscription_state: "active",
          delivery_mode: "poll",
          last_read_seq: 6,
          last_synced_at: "2026-11-27T08:10:00.000Z",
        },
      ],
      total: 2,
      next_offset: null,
    };
  };
  store.getMember = () => {
    getMemberCalls += 1;
    return null;
  };
  store.getSyncState = () => {
    getSyncStateCalls += 1;
    return null;
  };

  const listed = await engine.invoke({ action: "list", actorIdentity: ALICE });
  assert.equal(getMemberCalls, 0, "listBoards 复用已有 member 信息时不得重复查 getMember");
  assert.equal(getSyncStateCalls, 0, "listBoards 复用已有 last_synced_at 时不得重复查 getSyncState");
  assert.equal(listed.boards.length, 2);
  assert.equal(listed.boards[0].unread_count, 3);
  assert.equal(listed.boards[0].delivery_mode, "event");
  assert.equal(listed.boards[0].last_synced_at, "2026-11-27T08:05:00.000Z");
  assert.equal(listed.boards[1].unread_count, 4);
  assert.equal(listed.boards[1].last_synced_at, "2026-11-27T08:10:00.000Z");
});

test("notifyLocalMember marks sent and advances last_notified_seq ONLY on explicit acceptance credentials", async t => {
  const { engine, store, advanceMs, setNotifyImpl } = createHarness(t, {
    limits: { notifyRetryBaseMs: 1000, notifyRetryMaxMs: 8000 },
  });

  await engine.invoke({
    action: "create",
    actorIdentity: ALICE,
    params: { title: "接纳凭据验证板", board_id: "ack-cred-board" },
  });
  await engine.invoke({
    action: "invite",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "ack-cred-board" },
    params: { members: [BOB, CAROL] },
  });
  // BOB 走 event，CAROL 走 poll
  await engine.invoke({
    action: "set_subscription",
    actorIdentity: BOB,
    board: { machine_id: DEV_MACHINE, board_id: "ack-cred-board" },
    params: { delivery_mode: "event", filter_mode: "all" },
  });

  // 1. 逐一验证各种非明确接纳返回值（undefined / null / {} / { ok: false } / { accepted: false } / throw）一律保持 pending 且不推进 last_notified_seq
  const nonAcceptReturns = [
    () => undefined,
    () => null,
    () => ({}),
    () => ({ ok: false }),
    () => ({ accepted: false }),
    () => ({ delivery_status: "failed" }),
    () => { throw new Error("notifier_down"); },
  ];

  let nextReturnIndex = 0;
  let capturedSecondArg = null;
  setNotifyImpl(async (_record, opts) => {
    capturedSecondArg = opts;
    const fn = nonAcceptReturns[nextReturnIndex % nonAcceptReturns.length];
    nextReturnIndex += 1;
    return fn();
  });

  // ALICE 发 1 帖 -> BOB (event) 立即尝试投递，返回 undefined -> 不标 sent，last_notified_seq 保持 0
  await engine.invoke({
    action: "post",
    actorIdentity: ALICE,
    board: { machine_id: DEV_MACHINE, board_id: "ack-cred-board" },
    params: { body: "测试接纳凭据1" },
  });
  assert.ok(capturedSecondArg && Object.hasOwn(capturedSecondArg, "signal"), "调用 notifyLocalMember 应传入 { signal } 第二参数");
  const bobKey = identityKey(BOB);
  const carolKey = identityKey(CAROL);
  const bobEventNotif = store.notifications.get(`event_post:ack-cred-board:1:${bobKey}`);
  assert.equal(bobEventNotif.status, "pending", "返回 undefined 绝不可标 sent");
  assert.equal(store.getMember("ack-cred-board", bobKey).last_notified_seq, 0, "未接纳绝不可推进 event 成员水位");

  // 多次 tick 分别命中 null / {} / { ok: false } / { accepted: false } / { delivery_status: 'failed' } / throw
  for (let round = 0; round < 5; round += 1) {
    advanceMs(10_000);
    const tickRes = await engine.localNotifyTick();
    assert.equal(tickRes.delivered, 0);
    assert.ok(tickRes.failed >= 1);
    assert.equal(store.getMember("ack-cred-board", carolKey).last_notified_seq, 0, "poll_digest 未获明确接纳前绝不可提前推进 last_notified_seq");
    const carolDigestNotif = store.notifications.get(`poll_digest:ack-cred-board:${carolKey}:1-1`);
    assert.equal(carolDigestNotif.status, "pending");
  }

  // 2. 验证各类明确接纳凭据均正确标 sent 并推进 last_notified_seq
  const explicitCredentials = [
    { ok: true },
    { accepted: true },
    { delivery_status: "accepted" },
    { delivery_status: "prepared" },
    { message_id: "msg-accepted-001" },
  ];

  // 先用 { delivery_status: "accepted" } 和 { message_id: "msg-accepted-001" } 消化积压的 BOB event_post 与 CAROL poll_digest
  let credIdx = 0;
  setNotifyImpl(async () => explicitCredentials[credIdx++ % explicitCredentials.length]);
  advanceMs(60_000);
  const recovered = await engine.localNotifyTick();
  assert.equal(recovered.delivered, 2);
  assert.equal(store.notifications.get(`event_post:ack-cred-board:1:${bobKey}`).status, "sent");
  assert.equal(store.notifications.get(`poll_digest:ack-cred-board:${carolKey}:1-1`).status, "sent");
  assert.equal(store.getMember("ack-cred-board", bobKey).last_notified_seq, 1);
  assert.equal(store.getMember("ack-cred-board", carolKey).last_notified_seq, 1);

  // 继续发新帖覆盖其余接纳凭据：{ delivery_status: "accepted" } / { delivery_status: "prepared" } / { message_id: ... }
  for (let i = 2; i <= 4; i += 1) {
    await engine.invoke({
      action: "post",
      actorIdentity: ALICE,
      board: { machine_id: DEV_MACHINE, board_id: "ack-cred-board" },
      params: { body: `测试接纳凭据${i}` },
    });
    const tick = await engine.localNotifyTick();
    assert.equal(tick.delivered, 1);
    assert.equal(store.getMember("ack-cred-board", bobKey).last_notified_seq, i);
    assert.equal(store.getMember("ack-cred-board", carolKey).last_notified_seq, i);
  }
});

test("W2-3 R2-P1-1: guest multi-file post exceeding maxRemotePostBundleBytes fails fast with relay_bundle_too_large and cleans .outbox/", async t => {
  const { BoardStore } = await import("../src/board-store.mjs");
  const tmpDir = mkdtempSync(join(tmpdir(), "board-eng-r2p1-"));
  const uploadDir = join(tmpDir, "uploads");
  const privDir = join(tmpDir, "priv");
  mkdirSync(uploadDir, { recursive: true });
  mkdirSync(privDir, { recursive: true });
  const db = new DatabaseSync(join(tmpDir, "guest.sqlite"));
  db.exec("PRAGMA foreign_keys = ON;");
  t.after(() => {
    try { db.close(); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });
  const realStore = new BoardStore({ database: db, privateRoot: privDir, allowedUploadRoots: [uploadDir] });
  const guestActor = { machine_id: "train-r2", host: "codex", surface: "desktop", conversation_id: "conv-guest-r2" };
  realStore.upsertBoardFromRemote({
    board_id: "guest-bundle-cap",
    host_machine_id: "dev-r2",
    title: "客机单包上限板",
    status: "active",
    state_version: 1,
    meta_version: 1,
    archive_version: 0,
    settings: { auto_archive_days: 31, default_poll_interval_sec: 90, default_file_sync_machines: ["*"] },
    creator_key: identityKey({ machine_id: "dev-r2", host: "antigravity", surface: "desktop", conversation_id: "conv-host-r2" }),
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T01:00:00.000Z",
    members: [guestActor],
  });
  const guestEngine = new BoardEngine({
    store: realStore,
    localMachineId: "train-r2",
    limits: { maxRemotePostBundleBytes: 1024 },
  });
  const f1 = join(uploadDir, "part1.bin");
  const f2 = join(uploadDir, "part2.bin");
  writeFileSync(f1, Buffer.alloc(700, 0x41));
  writeFileSync(f2, Buffer.alloc(700, 0x42));

  await assert.rejects(
    () => guestEngine.invoke({
      action: "post",
      actorIdentity: guestActor,
      board: { machine_id: "dev-r2", board_id: "guest-bundle-cap" },
      params: {
        body: "两份合法附件合计超过单包预算",
        client_post_id: "guest-over-cap-1",
        files: [
          { path: f1, name: "part1.bin" },
          { path: f2, name: "part2.bin" },
        ],
      },
    }),
    err => err?.code === "relay_bundle_too_large",
  );
  assert.equal(realStore.getRemoteOutbox("guest-over-cap-1"), null, "超单包上限绝不可写入 board_remote_outbox");
  assert.equal(existsSync(realStore.getOutboxDir("guest-over-cap-1")), false, "失败必须立刻回滚清理 .outbox/<local_post_id>/");
});
