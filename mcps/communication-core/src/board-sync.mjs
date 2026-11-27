import { existsSync, rmSync, statSync } from "node:fs";
import {
  CoreError,
  digest,
  identityKey,
  normalizeIdentity,
  requireInteger,
  requireText,
} from "./contracts.mjs";
import {
  DEFAULT_MAX_FRAME_CHARS,
  encodeRelayFrame,
  formatEndpoint,
} from "./relay-envelope.mjs";
import { BoardStore } from "./board-store.mjs";
import { BoardEngine } from "./board-engine.mjs";

export const BOARD_SYNC_OPS = Object.freeze([
  "board_delta",
  "board_dissolved",
  "board_state_sync",
  "board_ack",
]);

export const BOARD_SYNC_LIMITS = Object.freeze({
  maxBoardsPerBatch: 32,
  maxPostsPerBatch: 128,
  maxPayloadJsonBytes: 960 * 1024,
  maxBundleAttachments: 63,
  maxBundleTotalBytes: 16 * 1024 * 1024 - 256 * 1024,
  defaultSyncIntervalMs: 90000,
  defaultNotifyIntervalMs: 90000,
});

const SYSTEM_SYNC_ENDPOINT = "core/system/board_sync";
const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

const ALLOWED_CLIENT_CONTROL_ACTIONS = new Set([
  "dissolve",
  "restore",
  "delete_archived",
  "invite",
  "subscribe",
  "unsubscribe",
  "update_settings",
]);

const BUNDLE_DEGRADE_ERROR_CODES = new Set([
  "bundle_transport_unavailable",
  "relay_file_route_denied",
  "relay_file_integration_disabled",
  "relay_file_tool_unknown",
  "relay_file_route_unavailable",
]);

const TRANSIENT_STORAGE_ERROR_CODES = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EBUSY",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EIO",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "storage_temp_error",
]);

const PERMANENT_FILE_ERROR_CODES = new Set([
  "board_file_hash_conflict",
  "board_file_too_large",
  "board_quota_exceeded",
  "invalid_input",
  "source_file_missing",
  "host_authority_mismatch",
]);

const PERMANENT_OUTBOX_ERROR_CODES = new Set([
  "relay_route_not_found",
  "relay_route_drain_expired",
  "relay_route_changed",
  "relay_recipient_disclosure_blocked",
  "relay_dedupe_conflict",
  "relay_frame_too_large",
  "relay_file_route_denied",
  "relay_file_id_conflict",
  "relay_file_reply_route_unbound",
  "relay_bundle_too_large",
  "invalid_input",
  "unsupported_op",
  "forbidden",
  "source_identity_unverified",
  "host_authority_mismatch",
  "board_post_conflict",
  "unsupported_control_action",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonSafe(value, fallback) {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeErrorCode(error) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof error?.code === "string" && error.code.trim()) return error.code.trim();
  return "sync_error";
}

function extractRetryAfterMs(error) {
  const candidates = [
    error?.details?.retry_after_ms,
    error?.retry_after_ms,
    error?.details?.retryAfterMs,
  ];
  for (const val of candidates) {
    if (Number.isFinite(val) && val > 0) return Math.ceil(val);
  }
  return 0;
}

function isBundleDegradeError(error) {
  return BUNDLE_DEGRADE_ERROR_CODES.has(normalizeErrorCode(error));
}

function isTransientStorageError(error) {
  const candidates = [
    error?.code,
    error?.errno,
    error?.cause?.code,
    error?.details?.code,
    error?.details?.errno,
  ];
  return candidates.some(code => typeof code === "string" && TRANSIENT_STORAGE_ERROR_CODES.has(code));
}

function isOutcomeUnknown(resultOrError) {
  return Boolean(
    resultOrError?.outcome_unknown === true
    || resultOrError?.outcomeUnknown === true
    || resultOrError?.status === "unknown"
    || resultOrError?.status === "sent_unverified"
    || resultOrError?.stage === "relay_unknown"
    || resultOrError?.details?.outcome_unknown === true
    || resultOrError?.details?.outcomeUnknown === true,
  );
}

function validateBoardIdValue(boardId) {
  if (typeof boardId !== "string" || !BOARD_ID_RE.test(boardId)) {
    throw new CoreError("invalid_input", "board_id 格式不合法");
  }
  return boardId;
}

function parseStrictIdentity4(raw) {
  if (!isPlainObject(raw)) return null;
  try {
    const id = normalizeIdentity(raw);
    const values = [id.machine_id, id.host, id.surface, id.conversation_id];
    if (values.some(v => v === "*" || v !== v.trim() || CONTROL_CHAR_RE.test(v))) {
      return null;
    }
    return {
      machine_id: id.machine_id,
      host: id.host,
      surface: id.surface,
      conversation_id: id.conversation_id,
    };
  } catch {
    return null;
  }
}

function parseIdentityFromAuthorKey(authorKey) {
  if (typeof authorKey !== "string" || !authorKey) return null;
  try {
    const arr = JSON.parse(authorKey);
    if (!Array.isArray(arr) || arr.length !== 4) return null;
    return parseStrictIdentity4({
      machine_id: arr[0],
      host: arr[1],
      surface: arr[2],
      conversation_id: arr[3],
    });
  } catch {
    return null;
  }
}

function makeAttachmentName(boardId, fileId) {
  return `${boardId}__${fileId}`;
}

function parseAttachmentName(name) {
  if (typeof name !== "string") return null;
  const idx = name.indexOf("__");
  if (idx <= 0 || idx + 2 >= name.length) return null;
  const boardId = name.slice(0, idx);
  const fileId = name.slice(idx + 2);
  if (!BOARD_ID_RE.test(boardId) || !fileId || fileId.includes("/") || fileId.includes("\\")) {
    return null;
  }
  return { board_id: boardId, file_id: fileId };
}

function extractInboundPayload(ctx) {
  const frame = ctx?.frame;
  if (!isPlainObject(frame)) return null;

  if (isPlainObject(frame.payload_json?.data)) {
    return frame.payload_json.data;
  }
  if (typeof frame.body === "string" && frame.body.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(frame.body);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  if (isPlainObject(frame.payload_json) && (
    frame.payload_json.kind !== undefined
    || Array.isArray(frame.payload_json.boards)
    || Array.isArray(frame.payload_json.tombstones)
    || frame.payload_json.board_id !== undefined
    || frame.payload_json.control_reply !== undefined
  )) {
    return frame.payload_json;
  }
  if (isPlainObject(frame.meta) && (
    frame.meta.kind !== undefined
    || Array.isArray(frame.meta.boards)
    || Array.isArray(frame.meta.tombstones)
    || frame.meta.board_id !== undefined
    || frame.meta.control_reply !== undefined
  )) {
    return frame.meta;
  }
  return null;
}

function nonEmptyActorKey(...candidates) {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "system:unknown";
}

function normalizePeerCollection(rawPeers, localMachineId = null) {
  const set = new Set();
  const items = Array.isArray(rawPeers)
    ? rawPeers
    : (rawPeers instanceof Set ? [...rawPeers] : []);
  for (const item of items) {
    if (typeof item === "string" && item.trim() && item.trim() !== localMachineId) {
      set.add(item.trim());
    }
  }
  return [...set];
}

function unwrapBoardAndSyncState(entry, store, peerMachineId) {
  const board = isPlainObject(entry?.board) ? entry.board : entry;
  if (!isPlainObject(board) || typeof board.board_id !== "string") return null;
  let syncState = isPlainObject(entry?.sync_state) ? entry.sync_state : null;
  if (!syncState && (
    entry.last_acked_seq !== undefined
    || entry.last_acked_state_version !== undefined
    || entry.last_acked_meta_version !== undefined
    || entry.last_notified_dissolve_version !== undefined
  )) {
    syncState = {
      last_acked_seq: entry.last_acked_seq ?? 0,
      last_acked_state_version: entry.last_acked_state_version ?? 0,
      last_acked_meta_version: entry.last_acked_meta_version ?? 0,
      last_notified_dissolve_version: entry.last_notified_dissolve_version ?? 0,
    };
  }
  if (!syncState && typeof store.getSyncState === "function") {
    syncState = store.getSyncState(board.board_id, peerMachineId) ?? null;
  }
  const hasActivePeerMember = entry?.has_active_peer_member !== undefined
    ? entry.has_active_peer_member
    : board.has_active_peer_member;
  const unsubscribeSyncOnly = entry?.unsubscribe_sync_only === true
    || board.unsubscribe_sync_only === true
    || hasActivePeerMember === false;
  return {
    board,
    hasActivePeerMember: hasActivePeerMember !== false,
    unsubscribeSyncOnly,
    syncState: {
      last_acked_seq: Number.isSafeInteger(syncState?.last_acked_seq) ? syncState.last_acked_seq : 0,
      last_acked_state_version: Number.isSafeInteger(syncState?.last_acked_state_version) ? syncState.last_acked_state_version : 0,
      last_acked_meta_version: Number.isSafeInteger(syncState?.last_acked_meta_version) ? syncState.last_acked_meta_version : 0,
      last_notified_dissolve_version: Number.isSafeInteger(syncState?.last_notified_dissolve_version) ? syncState.last_notified_dissolve_version : 0,
    },
  };
}

function extractPostFiles(post) {
  if (Array.isArray(post?.files)) return post.files;
  if (typeof post?.files_json === "string") {
    const parsed = parseJsonSafe(post.files_json, []);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

function extractPostMentions(post) {
  if (Array.isArray(post?.mentions)) return post.mentions;
  if (typeof post?.mentions_json === "string") {
    const parsed = parseJsonSafe(post.mentions_json, []);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

function extractPostAuthor(post) {
  if (isPlainObject(post?.author)) return post.author;
  if (typeof post?.author_json === "string") {
    const parsed = parseJsonSafe(post.author_json, null);
    if (isPlainObject(parsed)) return parsed;
  }
  return parseIdentityFromAuthorKey(post?.author_key);
}

function extractBoardSettings(board) {
  if (isPlainObject(board?.settings)) return board.settings;
  if (typeof board?.settings_json === "string") {
    const parsed = parseJsonSafe(board.settings_json, {});
    if (isPlainObject(parsed)) return parsed;
  }
  return {};
}

function normalizeMemberForWire(member) {
  const id = parseStrictIdentity4(member);
  if (!id) return null;
  return {
    machine_id: id.machine_id,
    host: id.host,
    surface: id.surface,
    conversation_id: id.conversation_id,
    member_key: member.member_key ?? identityKey(id),
    subscription_state: member.subscription_state ?? "active",
    delivery_mode: member.delivery_mode ?? "poll",
    filter_mode: member.filter_mode ?? "all",
    filter_targets: Array.isArray(member.filter_targets)
      ? member.filter_targets
      : parseJsonSafe(member.filter_targets_json, []),
    joined_at: member.joined_at ?? null,
  };
}

function compactMemberForTextFrame(member) {
  const id = parseStrictIdentity4(member);
  if (!id) return null;
  const filterTargets = Array.isArray(member.filter_targets)
    ? member.filter_targets
    : parseJsonSafe(member.filter_targets_json, []);
  return {
    machine_id: id.machine_id,
    host: id.host,
    surface: id.surface,
    conversation_id: id.conversation_id,
    ...(member.subscription_state && member.subscription_state !== "active"
      ? { subscription_state: member.subscription_state }
      : {}),
    ...(member.delivery_mode && member.delivery_mode !== "poll"
      ? { delivery_mode: member.delivery_mode }
      : {}),
    ...(member.filter_mode && member.filter_mode !== "all"
      ? { filter_mode: member.filter_mode }
      : {}),
    ...(Array.isArray(filterTargets) && filterTargets.length > 0
      ? { filter_targets: filterTargets }
      : {}),
    ...(member.joined_at ? { joined_at: member.joined_at } : {}),
  };
}

function compactBoardHeadForTextFrame(boardEntry, { includeMembers }) {
  const compact = {
    board_id: boardEntry.board_id,
    host_machine_id: boardEntry.host_machine_id,
    title: boardEntry.title,
    status: boardEntry.status,
    state_version: boardEntry.state_version,
    meta_version: boardEntry.meta_version,
    archive_version: boardEntry.archive_version ?? 0,
    ...(boardEntry.archive_reason ? { archive_reason: boardEntry.archive_reason } : {}),
    ...(isPlainObject(boardEntry.settings) && Object.keys(boardEntry.settings).length > 0
      ? { settings: boardEntry.settings }
      : {}),
    ...(boardEntry.creator_key ? { creator_key: boardEntry.creator_key } : {}),
    ...(boardEntry.created_at ? { created_at: boardEntry.created_at } : {}),
    ...(boardEntry.last_active_at ? { last_active_at: boardEntry.last_active_at } : {}),
    ...(boardEntry.archived_at ? { archived_at: boardEntry.archived_at } : {}),
    ...(boardEntry.unsubscribe_sync_only === true ? { unsubscribe_sync_only: true } : {}),
    members_included: includeMembers,
    posts: [],
  };
  if (includeMembers && Array.isArray(boardEntry.members)) {
    compact.members = boardEntry.members.map(compactMemberForTextFrame).filter(Boolean);
  }
  return compact;
}

function projectPostForWire(post) {
  const author = extractPostAuthor(post);
  const files = extractPostFiles(post).map(f => ({
    file_id: f.file_id,
    safe_name: f.safe_name,
    bytes: f.bytes,
    sha256: f.sha256,
    ...(f.rel_path !== undefined ? { rel_path: f.rel_path } : {}),
    ...(Array.isArray(f.sync_machines) ? { sync_machines: [...f.sync_machines] } : {}),
    ...(f.bundle_id !== undefined ? { bundle_id: f.bundle_id } : {}),
    ...(f.bundle_label !== undefined ? { bundle_label: f.bundle_label } : {}),
    ...(f.uploaded_at !== undefined ? { uploaded_at: f.uploaded_at } : {}),
  }));
  return {
    seq: post.seq,
    author,
    author_key: post.author_key ?? (author ? identityKey(author) : null),
    body: typeof post.body === "string" ? post.body : "",
    mentions: extractPostMentions(post),
    files,
    created_at: post.created_at ?? null,
    origin_client_post_id: post.origin_client_post_id ?? `host_seq_${post.seq}`,
  };
}

function isMachineTargetedForFile(file, machineId) {
  const targets = Array.isArray(file?.sync_machines) ? file.sync_machines : [];
  return targets.includes("*") || targets.includes(machineId);
}

export class BoardSyncCoordinator {
  #store;
  #engine;
  #localMachineId;
  #relaySender;
  #dispatcher;
  #peerMachines;
  #hasExplicitPeerAllowlist;
  #allowedPeerSet;
  #discoveredPeerMachines;
  #hasExplicitFileBundlePeers;
  #allowedFileBundlePeerSet;
  #peerCapabilitiesProvider;
  #addressBookAdapter;
  #limits;
  #now;
  #onError;

  #closed = false;
  #lifecycleAbort = new AbortController();
  #unregisterHandlers = [];
  #loopRunning = false;
  #syncTimer = null;
  #notifyTimer = null;
  #syncInFlight = null;
  #notifyInFlight = null;

  constructor({
    store,
    engine = null,
    localMachineId,
    relaySender = null,
    dispatcher = null,
    peerMachines = undefined,
    peerMachineIds = undefined,
    discoveredPeerMachines = undefined,
    fileBundlePeers = undefined,
    peerCapabilitiesProvider = null,
    addressBookAdapter = null,
    limits = {},
    now = () => Date.now(),
    onError = () => {},
  } = {}) {
    if (!store || typeof store !== "object") {
      throw new CoreError("invalid_input", "store 必须是有效的 BoardStore 实例");
    }
    this.#localMachineId = requireText(localMachineId, "localMachineId", 128);
    if (typeof now !== "function") {
      throw new CoreError("invalid_input", "now 必须是函数");
    }
    if (typeof onError !== "function") {
      throw new CoreError("invalid_input", "onError 必须是函数");
    }

    const mergedLimits = {
      ...BOARD_SYNC_LIMITS,
      maxTextFrameChars: DEFAULT_MAX_FRAME_CHARS,
      baseRetryMs: 5000,
      maxRetryMs: 300000,
      maxRetryCount: 12,
      sendingLeaseMs: 120000,
      ...(isPlainObject(limits) ? limits : {}),
    };
    this.#limits = Object.freeze({
      maxBoardsPerBatch: requireInteger(mergedLimits.maxBoardsPerBatch, "limits.maxBoardsPerBatch", 1, 256),
      maxPostsPerBatch: requireInteger(mergedLimits.maxPostsPerBatch, "limits.maxPostsPerBatch", 1, 1024),
      maxPayloadJsonBytes: requireInteger(mergedLimits.maxPayloadJsonBytes, "limits.maxPayloadJsonBytes", 1024, 4 * 1024 * 1024),
      maxBundleAttachments: requireInteger(mergedLimits.maxBundleAttachments, "limits.maxBundleAttachments", 1, 63),
      maxBundleTotalBytes: requireInteger(mergedLimits.maxBundleTotalBytes, "limits.maxBundleTotalBytes", 1024, 16 * 1024 * 1024),
      defaultSyncIntervalMs: requireInteger(mergedLimits.defaultSyncIntervalMs, "limits.defaultSyncIntervalMs", 10, 3600000),
      defaultNotifyIntervalMs: requireInteger(mergedLimits.defaultNotifyIntervalMs, "limits.defaultNotifyIntervalMs", 10, 3600000),
      maxTextFrameChars: requireInteger(mergedLimits.maxTextFrameChars, "limits.maxTextFrameChars", 256, 1900),
      baseRetryMs: requireInteger(mergedLimits.baseRetryMs, "limits.baseRetryMs", 1, 600000),
      maxRetryMs: requireInteger(mergedLimits.maxRetryMs, "limits.maxRetryMs", 1, 86400000),
      maxRetryCount: requireInteger(mergedLimits.maxRetryCount, "limits.maxRetryCount", 1, 1000),
      sendingLeaseMs: requireInteger(mergedLimits.sendingLeaseMs, "limits.sendingLeaseMs", 1000, 3600000),
    });

    this.#store = store;
    this.#engine = engine ?? null;
    this.#dispatcher = dispatcher ?? null;
    this.#addressBookAdapter = addressBookAdapter ?? null;
    this.#peerCapabilitiesProvider = peerCapabilitiesProvider ?? null;
    this.#now = now;
    this.#onError = onError;

    if (relaySender !== null && relaySender !== undefined) {
      if (typeof relaySender === "function") {
        this.#relaySender = { send: relaySender };
      } else if (typeof relaySender === "object" && typeof relaySender.send === "function") {
        this.#relaySender = relaySender;
      } else {
        throw new CoreError("invalid_input", "relaySender 必须是含 send 方法的对象或函数");
      }
    } else if (dispatcher && typeof dispatcher.dispatchCustomOp === "function") {
      this.#relaySender = {
        send: args => dispatcher.dispatchCustomOp(args),
      };
    } else {
      this.#relaySender = null;
    }

    const explicitPeersInput = peerMachineIds !== undefined ? peerMachineIds : peerMachines;
    this.#hasExplicitPeerAllowlist = explicitPeersInput !== undefined;
    this.#peerMachines = this.#hasExplicitPeerAllowlist
      ? this.#normalizePeerList(explicitPeersInput)
      : [];
    this.#allowedPeerSet = new Set(this.#peerMachines);
    this.#discoveredPeerMachines = this.#hasExplicitPeerAllowlist
      ? []
      : this.#normalizePeerList(discoveredPeerMachines);

    this.#hasExplicitFileBundlePeers = fileBundlePeers !== undefined;
    this.#allowedFileBundlePeerSet = new Set(
      this.#hasExplicitFileBundlePeers ? this.#normalizePeerList(fileBundlePeers) : [],
    );

    if (this.#dispatcher && typeof this.#dispatcher.registerOpHandler === "function") {
      this.#unregisterHandlers.push(
        this.#dispatcher.registerOpHandler("board_delta", ctx => this.handleInboundBoardDelta(ctx)),
        this.#dispatcher.registerOpHandler("board_dissolved", ctx => this.handleInboundBoardDissolved(ctx)),
        this.#dispatcher.registerOpHandler("board_state_sync", ctx => this.handleInboundBoardStateSync(ctx)),
        this.#dispatcher.registerOpHandler("board_ack", ctx => this.handleInboundBoardAck(ctx)),
      );
    }
  }

  get localMachineId() {
    return this.#localMachineId;
  }

  get closed() {
    return this.#closed;
  }

  get limits() {
    return this.#limits;
  }

  #assertOpen() {
    if (this.#closed) {
      throw new CoreError("coordinator_closed", "交流板同步协调器已关闭");
    }
  }

  #nowIso() {
    return new Date(this.#now()).toISOString();
  }

  #computeBackoffMs(retryCount, retryAfterMs = 0) {
    const exp = Math.min(
      this.#limits.maxRetryMs,
      this.#limits.baseRetryMs * (2 ** Math.min(12, Math.max(0, retryCount - 1))),
    );
    return Math.max(exp, retryAfterMs > 0 ? retryAfterMs : 0);
  }

  #normalizePeerList(rawPeers) {
    return normalizePeerCollection(rawPeers, this.#localMachineId);
  }

  #isPeerAllowed(peerMachineId) {
    if (!this.#hasExplicitPeerAllowlist) return true;
    return typeof peerMachineId === "string" && this.#allowedPeerSet.has(peerMachineId);
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
    if (isPlainObject(provider)) {
      return Object.hasOwn(provider, machineId) ? provider[machineId] : null;
    }
    return null;
  }

  #isFileBundleAllowedForPeer(peerMachineId) {
    if (typeof peerMachineId !== "string" || !peerMachineId || peerMachineId === this.#localMachineId) {
      return false;
    }
    if (this.#hasExplicitPeerAllowlist && !this.#allowedPeerSet.has(peerMachineId)) {
      return false;
    }
    if (this.#hasExplicitFileBundlePeers && !this.#allowedFileBundlePeerSet.has(peerMachineId)) {
      return false;
    }
    if (this.#peerCapabilitiesProvider) {
      const capability = this.#lookupPeerCapability(peerMachineId);
      return Boolean(
        capability
        && capability.known !== false
        && capability.reachable !== false
        && capability.allow_file_bundle === true,
      );
    }
    return true;
  }

  #checkActorPostEligibility(actor, boardId) {
    if (typeof this.#engine?.canActorPostToBoard === "function") {
      const verdict = this.#engine.canActorPostToBoard(actor, boardId);
      if (typeof verdict === "boolean") {
        return verdict ? { allowed: true } : { allowed: false, reason: "forbidden" };
      }
      if (isPlainObject(verdict) && typeof verdict.allowed === "boolean") {
        return verdict.allowed
          ? { allowed: true }
          : { allowed: false, reason: typeof verdict.reason === "string" && verdict.reason ? verdict.reason : "forbidden" };
      }
      if (isPlainObject(verdict) && typeof verdict.ok === "boolean") {
        return verdict.ok
          ? { allowed: true }
          : { allowed: false, reason: typeof verdict.code === "string" && verdict.code ? verdict.code : "forbidden" };
      }
      return verdict ? { allowed: true } : { allowed: false, reason: "forbidden" };
    }

    const tombstone = typeof this.#store.getTombstone === "function" ? this.#store.getTombstone(boardId) : null;
    const board = !tombstone && typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
    if (tombstone || !board) {
      return { allowed: false, reason: "board_not_found" };
    }
    if (board.host_machine_id !== this.#localMachineId) {
      return { allowed: false, reason: "host_authority_mismatch" };
    }
    const isAdmin = typeof this.#engine?.isSuperAdmin === "function" && this.#engine.isSuperAdmin(actor) === true;
    if (!isAdmin) {
      const actorKey = identityKey(actor);
      let isActiveMember = false;
      if (typeof this.#store.getMember === "function") {
        const member = this.#store.getMember(boardId, actorKey);
        isActiveMember = Boolean(member && member.subscription_state === "active");
      } else if (typeof this.#store.listMembers === "function") {
        const members = this.#store.listMembers(boardId, { activeOnly: true }) ?? [];
        isActiveMember = members.some(m => {
          const key = typeof m?.member_key === "string" && m.member_key
            ? m.member_key
            : (parseStrictIdentity4(m) ? identityKey(parseStrictIdentity4(m)) : null);
          return key === actorKey;
        });
      }
      if (!isActiveMember) {
        return { allowed: false, reason: "forbidden" };
      }
    }
    if (board.status === "archived") {
      return { allowed: false, reason: "board_archived" };
    }
    return { allowed: true };
  }

  #resolvePeerMachines(overridePeers) {
    if (this.#hasExplicitPeerAllowlist) {
      if (Array.isArray(overridePeers) || overridePeers instanceof Set) {
        return this.#normalizePeerList(overridePeers).filter(id => this.#allowedPeerSet.has(id));
      }
      return [...this.#peerMachines];
    }
    if (Array.isArray(overridePeers) || overridePeers instanceof Set) {
      return this.#normalizePeerList(overridePeers);
    }
    const merged = new Set(this.#discoveredPeerMachines);
    if (typeof this.#store.listKnownPeerMachines === "function") {
      for (const id of this.#normalizePeerList(this.#store.listKnownPeerMachines(this.#localMachineId))) {
        merged.add(id);
      }
    }
    return [...merged];
  }

  async #sendRelay(args) {
    this.#assertOpen();
    if (!this.#relaySender) {
      throw new CoreError("relay_sender_not_configured", "未配置跨机中继发送器");
    }
    return this.#relaySender.send(args);
  }

  #fitsTextFrame({ op, targetMachine, source, recipients, payloadJson, meta }) {
    try {
      const body = JSON.stringify(payloadJson);
      encodeRelayFrame({
        relay_id: "rly_00000000-0000-0000-0000-000000000000",
        op,
        from_machine: this.#localMachineId,
        to_machine: targetMachine,
        source,
        recipients,
        body,
        meta: {
          ...meta,
          request_id: "req_00000000-0000-0000-0000-000000000000",
          hop_count: 1,
          structured_body: true,
        },
      }, {
        maxFrameChars: this.#limits.maxTextFrameChars,
        enforceCqBudget: true,
      });
      return true;
    } catch (error) {
      if (error?.code === "relay_frame_too_large") return false;
      throw error;
    }
  }

  #resolveFileDescriptor(fileSyncItem) {
    const boardId = fileSyncItem.board_id;
    const fileId = fileSyncItem.file_id;
    let safeName = fileSyncItem.safe_name ?? null;
    let bytes = Number.isSafeInteger(fileSyncItem.bytes) ? fileSyncItem.bytes : null;
    let sha256 = typeof fileSyncItem.sha256 === "string" ? fileSyncItem.sha256 : null;
    let filePath = typeof fileSyncItem.local_path === "string" ? fileSyncItem.local_path : null;
    let seq = Number.isSafeInteger(fileSyncItem.seq) ? fileSyncItem.seq : null;

    if ((!safeName || bytes === null || !sha256 || !filePath) && typeof this.#store.getPostByFileId === "function") {
      const post = this.#store.getPostByFileId(boardId, fileId);
      if (post) {
        if (seq === null && Number.isSafeInteger(post.seq)) seq = post.seq;
        const files = extractPostFiles(post);
        const matched = files.find(f => f?.file_id === fileId);
        if (matched) {
          safeName = safeName ?? matched.safe_name ?? null;
          bytes = bytes ?? (Number.isSafeInteger(matched.bytes) ? matched.bytes : null);
          sha256 = sha256 ?? (typeof matched.sha256 === "string" ? matched.sha256 : null);
          filePath = filePath ?? (typeof matched.local_path === "string" ? matched.local_path : null);
        }
      }
    }

    if (!filePath && safeName && typeof this.#store.resolveSafeBoardFilePath === "function") {
      const board = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
      filePath = this.#store.resolveSafeBoardFilePath(boardId, fileId, safeName, {
        archived: board?.status === "archived",
      });
    }

    if (bytes === null && filePath) {
      try {
        bytes = statSync(filePath).size;
      } catch {
        bytes = null;
      }
    }

    return {
      board_id: boardId,
      file_id: fileId,
      seq,
      safe_name: safeName,
      bytes,
      sha256,
      filePath,
      attachment_name: makeAttachmentName(boardId, fileId),
      retry_count: Number.isSafeInteger(fileSyncItem.retry_count) ? fileSyncItem.retry_count : 0,
    };
  }

  #buildBoardWireSummary(board, { includeMembers = false } = {}) {
    const summary = {
      board_id: board.board_id,
      host_machine_id: board.host_machine_id ?? this.#localMachineId,
      title: board.title,
      status: board.status,
      state_version: board.state_version,
      meta_version: board.meta_version,
      archive_version: board.archive_version ?? 0,
      archive_reason: board.archive_reason ?? null,
      settings: extractBoardSettings(board),
      creator_key: nonEmptyActorKey(board.creator_key),
      created_at: board.created_at ?? null,
      last_active_at: board.last_active_at ?? null,
      archived_at: board.archived_at ?? null,
      members_included: false,
    };
    if (includeMembers && typeof this.#store.listMembers === "function") {
      const members = this.#store.listMembers(board.board_id) ?? [];
      summary.members = members.map(normalizeMemberForWire).filter(Boolean);
      summary.members_included = true;
    }
    return summary;
  }

  #packDeltaBatches(activeDeltaCandidates) {
    const batches = [];
    let currentBoards = [];
    let currentPostCount = 0;

    const flushBatch = () => {
      if (currentBoards.length > 0) {
        batches.push({ kind: "host_push_batch", boards: currentBoards });
        currentBoards = [];
        currentPostCount = 0;
      }
    };

    for (const candidate of activeDeltaCandidates) {
      const { board, syncState } = candidate;
      const isUnsubscribeOnly = candidate.unsubscribeSyncOnly === true
        || board.has_active_peer_member === false
        || board.unsubscribe_sync_only === true;
      const includeMembers = isUnsubscribeOnly
        || board.meta_version > syncState.last_acked_meta_version
        || syncState.last_acked_meta_version === 0;
      const rawPosts = !isUnsubscribeOnly
        && board.board_seq > syncState.last_acked_seq
        && typeof this.#store.getPostsRange === "function"
        ? (this.#store.getPostsRange(board.board_id, syncState.last_acked_seq, this.#limits.maxPostsPerBatch) ?? [])
        : [];
      const wirePosts = isUnsubscribeOnly ? [] : rawPosts.map(projectPostForWire);

      if (wirePosts.length === 0) {
        const entry = {
          ...this.#buildBoardWireSummary(board, { includeMembers }),
          ...(isUnsubscribeOnly ? { unsubscribe_sync_only: true } : {}),
          posts: [],
        };
        const candidateBoards = [...currentBoards, entry];
        if (
          currentBoards.length >= this.#limits.maxBoardsPerBatch
          || (currentBoards.length > 0 && jsonByteLength({ kind: "host_push_batch", boards: candidateBoards }) > this.#limits.maxPayloadJsonBytes)
        ) {
          flushBatch();
        }
        currentBoards.push(entry);
        continue;
      }

      let cursor = 0;
      let membersPending = includeMembers;
      while (cursor < wirePosts.length) {
        if (
          currentBoards.length >= this.#limits.maxBoardsPerBatch
          || currentPostCount >= this.#limits.maxPostsPerBatch
        ) {
          flushBatch();
        }
        const baseSummary = this.#buildBoardWireSummary(board, { includeMembers: membersPending });
        const remainingPosts = this.#limits.maxPostsPerBatch - currentPostCount;
        const chunk = [];
        while (cursor < wirePosts.length && chunk.length < remainingPosts) {
          const nextPost = wirePosts[cursor];
          const trialEntry = { ...baseSummary, posts: [...chunk, nextPost] };
          const trialPayload = { kind: "host_push_batch", boards: [...currentBoards, trialEntry] };
          if (jsonByteLength(trialPayload) > this.#limits.maxPayloadJsonBytes) {
            if (chunk.length === 0 && currentBoards.length > 0) {
              flushBatch();
              break;
            }
            if (chunk.length === 0 && membersPending) {
              // 含成员表的板头+首帖超预算时，先将板头与成员单独成帧，再发帖子
              batches.push({ kind: "host_push_batch", boards: [{ ...baseSummary, posts: [] }] });
              membersPending = false;
              break;
            }
            if (chunk.length === 0) {
              // 单帖自身仍超上限时不死循环，单独发出由下层裁决
              chunk.push(nextPost);
              cursor += 1;
            }
            break;
          }
          chunk.push(nextPost);
          cursor += 1;
        }
        if (chunk.length > 0) {
          currentBoards.push({ ...baseSummary, posts: chunk });
          currentPostCount += chunk.length;
          membersPending = false;
        }
      }
    }

    flushBatch();
    return batches;
  }

  #splitPayloadIntoSmallTextFrames(payload, targetMachine, blockedBoards = new Set()) {
    const meta = { kind: "host_push_batch", degraded_text_only: true };
    const newlyBlocked = [];
    const eligibleBoards = (payload.boards ?? [])
      .filter(b => isPlainObject(b) && typeof b.board_id === "string" && !blockedBoards.has(b.board_id))
      .map(b => ({
        ...b,
        members_included: b.members_included === true || Array.isArray(b.members),
      }));

    if (eligibleBoards.length === 0) {
      return { frames: [], blockedBoards, newlyBlocked };
    }

    const cleanPayload = {
      kind: "host_push_batch",
      boards: eligibleBoards,
    };

    if (this.#fitsTextFrame({
      op: "board_delta",
      targetMachine,
      source: SYSTEM_SYNC_ENDPOINT,
      recipients: [SYSTEM_SYNC_ENDPOINT],
      payloadJson: cleanPayload,
      meta,
    })) {
      return { frames: [cleanPayload], blockedBoards, newlyBlocked };
    }

    const frames = [];
    let currentBoards = [];
    const flush = () => {
      if (currentBoards.length > 0) {
        frames.push({ kind: "host_push_batch", boards: currentBoards });
        currentBoards = [];
      }
    };

    for (const boardEntry of eligibleBoards) {
      if (blockedBoards.has(boardEntry.board_id)) continue;

      const posts = Array.isArray(boardEntry.posts) ? boardEntry.posts : [];
      const hasMembers = boardEntry.members_included === true || Array.isArray(boardEntry.members);
      const baseWithoutPosts = compactBoardHeadForTextFrame(boardEntry, { includeMembers: hasMembers });

      if (posts.length === 0) {
        const trial = { kind: "host_push_batch", boards: [...currentBoards, baseWithoutPosts] };
        if (currentBoards.length > 0 && !this.#fitsTextFrame({
          op: "board_delta",
          targetMachine,
          source: SYSTEM_SYNC_ENDPOINT,
          recipients: [SYSTEM_SYNC_ENDPOINT],
          payloadJson: trial,
          meta,
        })) {
          flush();
        }
        const singleMetaPayload = { kind: "host_push_batch", boards: [baseWithoutPosts] };
        if (!this.#fitsTextFrame({
          op: "board_delta",
          targetMachine,
          source: SYSTEM_SYNC_ENDPOINT,
          recipients: [SYSTEM_SYNC_ENDPOINT],
          payloadJson: singleMetaPayload,
          meta,
        })) {
          blockedBoards.add(boardEntry.board_id);
          newlyBlocked.push(boardEntry.board_id);
          continue;
        }
        currentBoards.push(baseWithoutPosts);
        continue;
      }

      let idx = 0;
      let isFirstChunk = true;
      let boardBlocked = false;
      while (idx < posts.length && !boardBlocked) {
        const compactBase = isFirstChunk
          ? baseWithoutPosts
          : {
              board_id: boardEntry.board_id,
              host_machine_id: boardEntry.host_machine_id,
              title: boardEntry.title,
              status: boardEntry.status,
              state_version: boardEntry.state_version,
              meta_version: boardEntry.meta_version,
              archive_version: boardEntry.archive_version,
              members_included: false,
              posts: [],
            };
        const chunk = [];
        while (idx < posts.length) {
          const nextPost = posts[idx];
          const trialEntry = { ...compactBase, posts: [...chunk, nextPost] };
          const trialPayload = { kind: "host_push_batch", boards: [...currentBoards, trialEntry] };
          if (!this.#fitsTextFrame({
            op: "board_delta",
            targetMachine,
            source: SYSTEM_SYNC_ENDPOINT,
            recipients: [SYSTEM_SYNC_ENDPOINT],
            payloadJson: trialPayload,
            meta,
          })) {
            if (chunk.length === 0 && currentBoards.length > 0) {
              flush();
              break;
            }
            if (chunk.length === 0) {
              // 单条含大元信息时先试去掉重复成员数组，让单帖尽可能装进小帧
              const leanBase = {
                board_id: boardEntry.board_id,
                host_machine_id: boardEntry.host_machine_id,
                title: boardEntry.title,
                status: boardEntry.status,
                state_version: boardEntry.state_version,
                meta_version: boardEntry.meta_version,
                archive_version: boardEntry.archive_version,
                members_included: false,
                posts: [nextPost],
              };
              const leanPayload = { kind: "host_push_batch", boards: [leanBase] };
              if (!this.#fitsTextFrame({
                op: "board_delta",
                targetMachine,
                source: SYSTEM_SYNC_ENDPOINT,
                recipients: [SYSTEM_SYNC_ENDPOINT],
                payloadJson: leanPayload,
                meta,
              })) {
                // B-P0-3 防跳号静默丢帖：单帖拆成 leanBase 仍超 1800 CQ 小帧时，立即阻断该板后续所有更大 seq！
                blockedBoards.add(boardEntry.board_id);
                newlyBlocked.push(boardEntry.board_id);
                boardBlocked = true;
                break;
              }
              if (isFirstChunk && hasMembers) {
                const membersFrame = { kind: "host_push_batch", boards: [baseWithoutPosts] };
                if (this.#fitsTextFrame({
                  op: "board_delta",
                  targetMachine,
                  source: SYSTEM_SYNC_ENDPOINT,
                  recipients: [SYSTEM_SYNC_ENDPOINT],
                  payloadJson: membersFrame,
                  meta,
                })) {
                  frames.push(membersFrame);
                }
                isFirstChunk = false;
              }
              frames.push(leanPayload);
              idx += 1;
              break;
            }
            break;
          }
          chunk.push(nextPost);
          idx += 1;
        }
        if (chunk.length > 0) {
          currentBoards.push({ ...compactBase, posts: chunk });
          isFirstChunk = false;
        }
      }
    }

    flush();
    return { frames, blockedBoards, newlyBlocked };
  }

  #packFilesWithinBudget(descriptors) {
    const packed = [];
    const remaining = [];
    let totalBytes = 0;

    for (const desc of descriptors) {
      const size = desc.bytes ?? 0;
      if (
        packed.length < this.#limits.maxBundleAttachments
        && totalBytes + size <= this.#limits.maxBundleTotalBytes
      ) {
        packed.push(desc);
        totalBytes += size;
      } else {
        remaining.push(desc);
      }
    }
    return { packed, remaining, totalBytes };
  }

  #markFilesBackoff(fileDescriptors, peerMachineId, errorCode, retryAfterMs = 0) {
    if (typeof this.#store.updateFileSyncItemStatus !== "function") return;
    const nowMs = this.#now();
    const nowIso = new Date(nowMs).toISOString();
    for (const desc of fileDescriptors) {
      const nextRetry = (desc.retry_count ?? 0) + 1;
      const backoff = this.#computeBackoffMs(nextRetry, retryAfterMs);
      this.#store.updateFileSyncItemStatus(desc.board_id, desc.file_id, peerMachineId, {
        status: "pending",
        retry_count: nextRetry,
        next_retry_at: nowMs + backoff,
        last_error: errorCode,
        nowIso,
      });
    }
  }

  #markFilesStatus(fileDescriptors, peerMachineId, status, lastError = null) {
    if (typeof this.#store.updateFileSyncItemStatus !== "function") return;
    const nowMs = this.#now();
    const nowIso = new Date(nowMs).toISOString();
    const nextRetryAt = status === "sending" ? nowMs + this.#limits.sendingLeaseMs : 0;
    for (const desc of fileDescriptors) {
      this.#store.updateFileSyncItemStatus(desc.board_id, desc.file_id, peerMachineId, {
        status,
        retry_count: desc.retry_count ?? 0,
        next_retry_at: nextRetryAt,
        last_error: lastError,
        nowIso,
      });
    }
  }

  async syncTick({ peerMachines, signal } = {}) {
    this.#assertOpen();
    if (this.#syncInFlight) return this.#syncInFlight;

    const effectiveSignal = signal
      ? AbortSignal.any([this.#lifecycleAbort.signal, signal])
      : this.#lifecycleAbort.signal;

    const run = async () => {
      const peers = this.#resolvePeerMachines(peerMachines);
      let totalSentFrames = 0;
      const skippedPeers = [];
      const byPeer = {};

      for (const peerMachineId of peers) {
        if (this.#closed || effectiveSignal.aborted) break;
        const peerStats = await this.#syncPeer(peerMachineId, { signal: effectiveSignal });
        byPeer[peerMachineId] = peerStats;
        totalSentFrames += peerStats.sent_frames;
        if (peerStats.skipped) {
          skippedPeers.push(peerMachineId);
        }
      }

      return {
        sent_frames: totalSentFrames,
        skipped_peers: skippedPeers,
        by_peer: byPeer,
      };
    };

    const promise = run().finally(() => {
      if (this.#syncInFlight === promise) this.#syncInFlight = null;
    });
    this.#syncInFlight = promise;
    return promise;
  }

  async #syncPeer(peerMachineId, { signal } = {}) {
    const nowMs = this.#now();
    const stats = {
      sent_frames: 0,
      dissolved_frames: 0,
      tombstone_frames: 0,
      state_frames: 0,
      delta_frames: 0,
      degraded_text_frames: 0,
      file_frames: 0,
      outbox_frames: 0,
      skipped: false,
      errors: [],
    };

    if (!this.#isPeerAllowed(peerMachineId)) {
      stats.skipped = true;
      return stats;
    }

    const peerAllowsFileBundle = this.#isFileBundleAllowedForPeer(peerMachineId);

    const rawBoardCandidates = typeof this.#store.listBoardsNeedingSyncForPeer === "function"
      ? (this.#store.listBoardsNeedingSyncForPeer(this.#localMachineId, peerMachineId) ?? [])
      : [];
    const boardCandidates = rawBoardCandidates
      .map(item => unwrapBoardAndSyncState(item, this.#store, peerMachineId))
      .filter(Boolean)
      .filter(item => item.board.host_machine_id === this.#localMachineId);

    // 分类：① 手动解散、③ 状态同步、④ 活跃板增量与元数据同步（含退订仅同步一次元数据）
    const manualDissolveItems = [];
    const stateSyncItems = [];
    const activeDeltaItems = [];

    for (const item of boardCandidates) {
      const { board, syncState, unsubscribeSyncOnly } = item;
      const isUnsubscribeOnly = unsubscribeSyncOnly
        || board.has_active_peer_member === false
        || board.unsubscribe_sync_only === true;

      if (isUnsubscribeOnly) {
        // 退订停止跨机推送：绝不触发 board_dissolved，绝不推新帖，仅在 meta_version 落后时推一次携带 members 的退订同步帧
        if (board.meta_version > syncState.last_acked_meta_version) {
          activeDeltaItems.push({ ...item, unsubscribeSyncOnly: true });
        }
        continue;
      }

      const archiveVersion = board.archive_version ?? 0;
      const needsManualDissolve = board.status === "archived"
        && board.archive_reason === "manual_dissolve"
        && archiveVersion > 0
        && syncState.last_notified_dissolve_version < archiveVersion;

      if (needsManualDissolve) {
        manualDissolveItems.push(item);
        continue;
      }

      const needsStateSync = board.state_version > syncState.last_acked_state_version;
      const needsActiveDelta = board.status === "active"
        && (board.board_seq > syncState.last_acked_seq || board.meta_version > syncState.last_acked_meta_version);

      if (needsStateSync) {
        stateSyncItems.push(item);
      }
      if (needsActiveDelta) {
        activeDeltaItems.push(item);
      }
    }

    // ② 墓碑广播
    const pendingTombstones = typeof this.#store.listPendingTombstoneSyncs === "function"
      ? (this.#store.listPendingTombstoneSyncs(peerMachineId, nowMs, 64) ?? [])
      : [];

    // ⑤ 未发文件补发队列（未获交流板文件包许可时跳过附件调度）
    const dueFileSyncItems = peerAllowsFileBundle && typeof this.#store.listDueFileSyncItems === "function"
      ? (this.#store.listDueFileSyncItems(peerMachineId, nowMs, this.#limits.maxBundleAttachments * 2) ?? [])
      : [];

    // ⑥ 客机离线写队列
    const dueOutboxItems = typeof this.#store.listDueRemoteOutbox === "function"
      ? (this.#store.listDueRemoteOutbox(peerMachineId, nowMs, 32) ?? [])
      : [];

    // ⑦ 绝对零空轮询：7 类全空时发 0 帧
    const hasAnyWork = manualDissolveItems.length > 0
      || pendingTombstones.length > 0
      || stateSyncItems.length > 0
      || activeDeltaItems.length > 0
      || dueFileSyncItems.length > 0
      || dueOutboxItems.length > 0;

    if (!hasAnyWork) {
      stats.skipped = true;
      return stats;
    }

    // ① 最高优先级：手动解散快车道小帧（allowBundle: false，绝不排在文件包后）
    for (const { board } of manualDissolveItems) {
      if (this.#closed || signal?.aborted) break;
      const activeMembers = typeof this.#store.listMembers === "function"
        ? (this.#store.listMembers(board.board_id, { activeOnly: true }) ?? [])
            .map(normalizeMemberForWire)
            .filter(Boolean)
        : [];
      const baseDissolvedPayload = {
        kind: "board_dissolved",
        board_id: board.board_id,
        host_machine_id: this.#localMachineId,
        title: typeof board.title === "string" && board.title.trim() ? board.title : board.board_id,
        state_version: board.state_version,
        meta_version: board.meta_version,
        archive_version: board.archive_version,
        archive_reason: "manual_dissolve",
        settings: extractBoardSettings(board),
        creator_key: nonEmptyActorKey(board.creator_key),
        created_at: board.created_at ?? this.#nowIso(),
        last_active_at: board.last_active_at ?? board.archived_at ?? this.#nowIso(),
        dissolved_by_key: nonEmptyActorKey(board.dissolved_by_key, board.archived_by_key, board.creator_key),
        archived_at: board.archived_at ?? this.#nowIso(),
      };
      const dissolvedMeta = { kind: "board_dissolved", board_id: board.board_id, priority: "high" };
      let payloadJson = {
        ...baseDissolvedPayload,
        members: activeMembers,
        members_included: true,
      };
      if (!this.#fitsTextFrame({
        op: "board_dissolved",
        targetMachine: peerMachineId,
        source: SYSTEM_SYNC_ENDPOINT,
        recipients: [SYSTEM_SYNC_ENDPOINT],
        payloadJson,
        meta: dissolvedMeta,
      })) {
        const compactMembersPayload = {
          ...baseDissolvedPayload,
          members: activeMembers.map(compactMemberForTextFrame).filter(Boolean),
          members_included: true,
        };
        if (this.#fitsTextFrame({
          op: "board_dissolved",
          targetMachine: peerMachineId,
          source: SYSTEM_SYNC_ENDPOINT,
          recipients: [SYSTEM_SYNC_ENDPOINT],
          payloadJson: compactMembersPayload,
          meta: dissolvedMeta,
        })) {
          payloadJson = compactMembersPayload;
        } else {
          const peerOnlyMembers = activeMembers
            .filter(m => m.machine_id === peerMachineId)
            .map(compactMemberForTextFrame)
            .filter(Boolean);
          const peerPayload = {
            ...baseDissolvedPayload,
            members: peerOnlyMembers,
            members_included: false,
          };
          if (this.#fitsTextFrame({
            op: "board_dissolved",
            targetMachine: peerMachineId,
            source: SYSTEM_SYNC_ENDPOINT,
            recipients: [SYSTEM_SYNC_ENDPOINT],
            payloadJson: peerPayload,
            meta: dissolvedMeta,
          })) {
            payloadJson = peerPayload;
          } else {
            payloadJson = {
              ...baseDissolvedPayload,
              members: [],
              members_included: false,
            };
          }
        }
      }

      const dedupeKey = `bdiss:${digest({
        target: peerMachineId,
        board_id: board.board_id,
        state_version: board.state_version,
        archive_version: board.archive_version,
      }).slice(0, 28)}`;

      try {
        await this.#sendRelay({
          op: "board_dissolved",
          dedupeKey,
          targetMachine: peerMachineId,
          source: SYSTEM_SYNC_ENDPOINT,
          recipients: [SYSTEM_SYNC_ENDPOINT],
          body: "",
          meta: dissolvedMeta,
          payloadJson,
          attachments: [],
          allowBundle: false,
          allowDiscloseRecipients: false,
          signal,
        });
        stats.dissolved_frames += 1;
        stats.sent_frames += 1;
      } catch (error) {
        stats.errors.push({ stage: "board_dissolved", board_id: board.board_id, code: normalizeErrorCode(error) });
        this.#onError(error);
      }
    }

    // ② 墓碑广播 board_tombstone_sync(acked=0)
    if (pendingTombstones.length > 0 && !this.#closed && !signal?.aborted) {
      const backoffTombstones = (slice, errorOrRes) => {
        if (typeof this.#store.updateTombstoneSyncBackoff !== "function") return;
        const retryAfterMs = extractRetryAfterMs(errorOrRes);
        const nextRetryAt = this.#now() + this.#computeBackoffMs(1, retryAfterMs);
        for (const tomb of slice) {
          try {
            this.#store.updateTombstoneSyncBackoff(tomb.board_id, peerMachineId, {
              next_retry_at: nextRetryAt,
            });
          } catch (backoffErr) {
            this.#onError(backoffErr);
          }
        }
      };

      for (let i = 0; i < pendingTombstones.length; i += this.#limits.maxBoardsPerBatch) {
        if (this.#closed || signal?.aborted) break;
        const slice = pendingTombstones.slice(i, i + this.#limits.maxBoardsPerBatch);
        const tombstones = slice.map(t => ({
          board_id: t.board_id,
          host_machine_id: t.host_machine_id ?? this.#localMachineId,
          final_state_version: t.final_state_version,
          deleted_by_key: nonEmptyActorKey(t.deleted_by_key),
          deleted_at: t.deleted_at ?? null,
        }));
        const payloadJson = { kind: "host_deleted_tombstone", tombstones };
        const dedupeKey = `btomb:${digest({ target: peerMachineId, tombstones }).slice(0, 28)}`;

        try {
          const tombRes = await this.#sendRelay({
            op: "board_state_sync",
            dedupeKey,
            targetMachine: peerMachineId,
            source: SYSTEM_SYNC_ENDPOINT,
            recipients: [SYSTEM_SYNC_ENDPOINT],
            body: "",
            meta: { kind: "host_deleted_tombstone" },
            payloadJson,
            attachments: [],
            allowBundle: peerAllowsFileBundle,
            allowDiscloseRecipients: false,
            signal,
          });
          if (tombRes && (tombRes.ok === false || tombRes.status === "pending_capacity" || tombRes.stage === "pending_capacity")) {
            backoffTombstones(slice, tombRes);
            stats.errors.push({
              stage: "tombstone_sync",
              code: normalizeErrorCode(tombRes.code ?? tombRes.error_code ?? tombRes.status ?? "tombstone_sync_failed"),
            });
          } else {
            stats.tombstone_frames += 1;
            stats.sent_frames += 1;
          }
        } catch (error) {
          backoffTombstones(slice, error);
          stats.errors.push({ stage: "tombstone_sync", code: normalizeErrorCode(error) });
          this.#onError(error);
        }
      }
    }

    // ③ 归档 / 恢复状态同步 state_version > last_acked_state_version
    if (stateSyncItems.length > 0 && !this.#closed && !signal?.aborted) {
      for (let i = 0; i < stateSyncItems.length; i += this.#limits.maxBoardsPerBatch) {
        if (this.#closed || signal?.aborted) break;
        const slice = stateSyncItems.slice(i, i + this.#limits.maxBoardsPerBatch);
        const boards = slice.map(({ board, syncState }) => this.#buildBoardWireSummary(board, {
          includeMembers: board.meta_version > syncState.last_acked_meta_version || syncState.last_acked_meta_version === 0,
        }));
        const payloadJson = { kind: "host_state_push", boards };
        const dedupeKey = `bstat:${digest({ target: peerMachineId, boards }).slice(0, 28)}`;

        try {
          await this.#sendRelay({
            op: "board_state_sync",
            dedupeKey,
            targetMachine: peerMachineId,
            source: SYSTEM_SYNC_ENDPOINT,
            recipients: [SYSTEM_SYNC_ENDPOINT],
            body: "",
            meta: { kind: "host_state_push" },
            payloadJson,
            attachments: [],
            allowBundle: peerAllowsFileBundle,
            allowDiscloseRecipients: false,
            signal,
          });
          stats.state_frames += 1;
          stats.sent_frames += 1;
        } catch (error) {
          stats.errors.push({ stage: "state_sync", code: normalizeErrorCode(error) });
          this.#onError(error);
        }
      }
    }

    // 准备待发文件描述符（过滤缺失源文件的坏项，不堵死主链路）
    const readyFileDescriptors = [];
    for (const item of dueFileSyncItems) {
      const desc = this.#resolveFileDescriptor(item);
      if (!desc.filePath || !desc.safe_name || !desc.sha256 || !Number.isSafeInteger(desc.bytes) || desc.bytes < 0) {
        this.#markFilesStatus([desc], peerMachineId, "failed", "source_file_missing");
        stats.errors.push({ stage: "file_prepare", board_id: desc.board_id, file_id: desc.file_id, code: "source_file_missing" });
        continue;
      }
      if (desc.bytes > this.#limits.maxBundleTotalBytes) {
        this.#markFilesStatus([desc], peerMachineId, "failed", "board_file_too_large");
        stats.errors.push({ stage: "file_prepare", board_id: desc.board_id, file_id: desc.file_id, code: "board_file_too_large" });
        continue;
      }
      readyFileDescriptors.push(desc);
    }

    let remainingFiles = [...readyFileDescriptors];
    let bundleUnavailableForPeer = !peerAllowsFileBundle;

    // ④ 活跃板增量与元数据多板合帧（支持附带到期文件并在满容/不可用时瞬间解耦降级纯文本小帧，严防跳号丢帖）
    if (activeDeltaItems.length > 0 && !this.#closed && !signal?.aborted) {
      const deltaBatches = this.#packDeltaBatches(activeDeltaItems);
      const blockedBoards = new Set();

      for (const batch of deltaBatches) {
        if (this.#closed || signal?.aborted) break;

        const eligibleBoards = batch.boards.filter(b => !blockedBoards.has(b.board_id));
        if (eligibleBoards.length === 0) continue;
        const effectiveBatch = eligibleBoards.length === batch.boards.length
          ? batch
          : { ...batch, boards: eligibleBoards };

        const canSendBundleNow = !bundleUnavailableForPeer && this.#isFileBundleAllowedForPeer(peerMachineId);
        let attachedDescriptors = [];
        if (canSendBundleNow && remainingFiles.length > 0) {
          const batchBoardIds = new Set(
            effectiveBatch.boards
              .filter(b => b.unsubscribe_sync_only !== true)
              .map(b => b.board_id),
          );
          const matching = remainingFiles.filter(f => batchBoardIds.has(f.board_id));
          const nonMatching = remainingFiles.filter(f => !batchBoardIds.has(f.board_id));
          if (matching.length > 0) {
            const { packed, remaining } = this.#packFilesWithinBudget(matching);
            const fitted = [];
            const overflow = [];
            const manifestTrial = [];
            for (const d of packed) {
              const entry = {
                board_id: d.board_id,
                seq: d.seq,
                file_id: d.file_id,
                safe_name: d.safe_name,
                bytes: d.bytes,
                sha256: d.sha256,
                attachment_name: d.attachment_name,
              };
              if (jsonByteLength({ ...effectiveBatch, file_manifest: [...manifestTrial, entry] }) <= this.#limits.maxPayloadJsonBytes) {
                fitted.push(d);
                manifestTrial.push(entry);
              } else {
                overflow.push(d);
              }
            }
            attachedDescriptors = fitted;
            remainingFiles = [...overflow, ...remaining, ...nonMatching];
          }
        }

        let needsTextDegrade = !canSendBundleNow;
        let degradeReason = !canSendBundleNow ? (peerAllowsFileBundle ? "bundle_unavailable_cached" : "file_bundle_disabled") : null;

        if (!needsTextDegrade) {
          const payloadWithFiles = attachedDescriptors.length > 0
            ? {
                ...effectiveBatch,
                file_manifest: attachedDescriptors.map(d => ({
                  board_id: d.board_id,
                  seq: d.seq,
                  file_id: d.file_id,
                  safe_name: d.safe_name,
                  bytes: d.bytes,
                  sha256: d.sha256,
                  attachment_name: d.attachment_name,
                })),
              }
            : effectiveBatch;

          const attachments = attachedDescriptors.map(d => ({
            name: d.attachment_name,
            filePath: d.filePath,
          }));

          const dedupeKey = `bdelt:${digest({
            target: peerMachineId,
            payload: payloadWithFiles,
            attachments: attachments.map(a => a.name),
          }).slice(0, 28)}`;

          try {
            if (attachedDescriptors.length > 0) {
              this.#markFilesStatus(attachedDescriptors, peerMachineId, "sending", null);
            }
            const sendResult = await this.#sendRelay({
              op: "board_delta",
              dedupeKey,
              targetMachine: peerMachineId,
              source: SYSTEM_SYNC_ENDPOINT,
              recipients: [SYSTEM_SYNC_ENDPOINT],
              body: "",
              meta: { kind: "host_push_batch" },
              payloadJson: payloadWithFiles,
              attachments,
              allowBundle: true,
              allowDiscloseRecipients: false,
              signal,
            });

            if (sendResult?.status === "pending_capacity" || sendResult?.stage === "pending_capacity") {
              needsTextDegrade = true;
              degradeReason = "pending_capacity";
            } else if (sendResult && sendResult.ok === false) {
              const failCode = normalizeErrorCode(sendResult.code ?? sendResult.error_code ?? sendResult.status);
              if (attachedDescriptors.length > 0) {
                this.#markFilesBackoff(attachedDescriptors, peerMachineId, failCode, extractRetryAfterMs(sendResult));
              }
              for (const b of effectiveBatch.boards) blockedBoards.add(b.board_id);
              stats.errors.push({ stage: "board_delta", code: failCode });
              continue;
            } else {
              stats.delta_frames += 1;
              stats.sent_frames += 1;
            }
          } catch (error) {
            const code = normalizeErrorCode(error);
            if (isBundleDegradeError(error)) {
              needsTextDegrade = true;
              degradeReason = code;
            } else {
              if (attachedDescriptors.length > 0) {
                this.#markFilesBackoff(attachedDescriptors, peerMachineId, code, extractRetryAfterMs(error));
              }
              for (const b of effectiveBatch.boards) blockedBoards.add(b.board_id);
              stats.errors.push({ stage: "board_delta", code });
              this.#onError(error);
              continue;
            }
          }
        }

        // 文本 / 文件解耦降级：附件留队列退避，纯文本立刻切 1800 CQ 小帧发完；单帖超限或发帧失败立刻阻断该板防跳号！
        if (needsTextDegrade) {
          bundleUnavailableForPeer = true;
          if (attachedDescriptors.length > 0) {
            this.#markFilesBackoff(attachedDescriptors, peerMachineId, degradeReason);
          }
          const { frames: smallFrames, newlyBlocked } = this.#splitPayloadIntoSmallTextFrames(
            effectiveBatch,
            peerMachineId,
            blockedBoards,
          );
          for (const blockedBoardId of newlyBlocked) {
            stats.errors.push({
              stage: "board_delta_degraded_text",
              board_id: blockedBoardId,
              code: "relay_frame_too_large",
            });
          }
          for (const smallPayload of smallFrames) {
            if (this.#closed || signal?.aborted) break;
            const remainingSmallBoards = smallPayload.boards.filter(b => !blockedBoards.has(b.board_id));
            if (remainingSmallBoards.length === 0) continue;
            const effectiveSmallPayload = remainingSmallBoards.length === smallPayload.boards.length
              ? smallPayload
              : { ...smallPayload, boards: remainingSmallBoards };
            const textDedupeKey = `bdtxt:${digest({ target: peerMachineId, payload: effectiveSmallPayload }).slice(0, 28)}`;
            try {
              const textRes = await this.#sendRelay({
                op: "board_delta",
                dedupeKey: textDedupeKey,
                targetMachine: peerMachineId,
                source: SYSTEM_SYNC_ENDPOINT,
                recipients: [SYSTEM_SYNC_ENDPOINT],
                body: "",
                meta: { kind: "host_push_batch", degraded_text_only: true },
                payloadJson: effectiveSmallPayload,
                attachments: [],
                allowBundle: false,
                allowDiscloseRecipients: false,
                signal,
              });
              if (textRes && textRes.ok === false) {
                for (const b of effectiveSmallPayload.boards) blockedBoards.add(b.board_id);
                stats.errors.push({
                  stage: "board_delta_degraded_text",
                  code: normalizeErrorCode(textRes.code ?? textRes.error_code ?? textRes.status),
                });
                continue;
              }
              stats.degraded_text_frames += 1;
              stats.delta_frames += 1;
              stats.sent_frames += 1;
            } catch (textErr) {
              for (const b of effectiveSmallPayload.boards) blockedBoards.add(b.board_id);
              stats.errors.push({ stage: "board_delta_degraded_text", code: normalizeErrorCode(textErr) });
              this.#onError(textErr);
            }
          }
        }
      }
    }

    // ⑤ 未发文件补发队列（独立装箱 <= 63 文件、<= 16 MiB - 256 KiB；每次实时重核交流板文件包许可）
    while (
      remainingFiles.length > 0
      && !bundleUnavailableForPeer
      && this.#isFileBundleAllowedForPeer(peerMachineId)
      && !this.#closed
      && !signal?.aborted
    ) {
      const { packed, remaining } = this.#packFilesWithinBudget(remainingFiles);
      if (packed.length === 0) break;
      remainingFiles = remaining;

      const boardMap = new Map();
      for (const desc of packed) {
        if (!boardMap.has(desc.board_id)) {
          const board = typeof this.#store.getBoard === "function" ? this.#store.getBoard(desc.board_id) : null;
          boardMap.set(desc.board_id, board
            ? { ...this.#buildBoardWireSummary(board, { includeMembers: false }), posts: [] }
            : { board_id: desc.board_id, host_machine_id: this.#localMachineId, members_included: false, posts: [] });
        }
      }

      const payloadJson = {
        kind: "host_push_batch",
        file_sync_only: true,
        boards: [...boardMap.values()],
        file_manifest: packed.map(d => ({
          board_id: d.board_id,
          seq: d.seq,
          file_id: d.file_id,
          safe_name: d.safe_name,
          bytes: d.bytes,
          sha256: d.sha256,
          attachment_name: d.attachment_name,
        })),
      };
      const attachments = packed.map(d => ({
        name: d.attachment_name,
        filePath: d.filePath,
      }));
      const dedupeKey = `bfile:${digest({
        target: peerMachineId,
        manifest: payloadJson.file_manifest,
      }).slice(0, 28)}`;

      try {
        this.#markFilesStatus(packed, peerMachineId, "sending", null);
        const sendResult = await this.#sendRelay({
          op: "board_delta",
          dedupeKey,
          targetMachine: peerMachineId,
          source: SYSTEM_SYNC_ENDPOINT,
          recipients: [SYSTEM_SYNC_ENDPOINT],
          body: "",
          meta: { kind: "host_push_batch", file_sync_only: true },
          payloadJson,
          attachments,
          allowBundle: true,
          allowDiscloseRecipients: false,
          signal,
        });

        if (sendResult?.status === "pending_capacity" || sendResult?.stage === "pending_capacity") {
          this.#markFilesBackoff(packed, peerMachineId, "pending_capacity");
          bundleUnavailableForPeer = true;
          break;
        }
        if (sendResult && sendResult.ok === false) {
          const failCode = normalizeErrorCode(sendResult.code ?? sendResult.error_code ?? sendResult.status);
          this.#markFilesBackoff(packed, peerMachineId, failCode, extractRetryAfterMs(sendResult));
          if (isBundleDegradeError(failCode)) {
            bundleUnavailableForPeer = true;
          }
          stats.errors.push({ stage: "file_sync_queue", code: failCode });
          if (bundleUnavailableForPeer) break;
          continue;
        }
        stats.file_frames += 1;
        stats.sent_frames += 1;
      } catch (error) {
        const code = normalizeErrorCode(error);
        this.#markFilesBackoff(packed, peerMachineId, code, extractRetryAfterMs(error));
        if (isBundleDegradeError(error)) {
          bundleUnavailableForPeer = true;
        }
        stats.errors.push({ stage: "file_sync_queue", code });
        this.#onError(error);
        if (bundleUnavailableForPeer) break;
      }
    }

    // ⑥ 客机离线写队列 board_remote_outbox(pending due)
    for (const candidate of dueOutboxItems) {
      if (this.#closed || signal?.aborted) break;
      const nowIso = this.#nowIso();
      const entry = typeof this.#store.claimRemoteOutbox === "function"
        ? this.#store.claimRemoteOutbox(candidate.local_post_id, nowIso)
        : candidate;
      if (!entry) continue;

      const parsedPayload = parseJsonSafe(entry.payload_json, null);
      if (!isPlainObject(parsedPayload)) {
        this.#updateOutbox(entry.local_post_id, {
          status: "dead_letter",
          retry_count: (entry.retry_count ?? 0) + 1,
          next_retry_at: 0,
          last_error_code: "invalid_input",
        });
        continue;
      }

      const actor = parseStrictIdentity4(parsedPayload.actor)
        ?? parseStrictIdentity4(parsedPayload.author)
        ?? parseIdentityFromAuthorKey(entry.author_key);
      if (!actor || actor.machine_id !== this.#localMachineId) {
        this.#updateOutbox(entry.local_post_id, {
          status: "dead_letter",
          retry_count: (entry.retry_count ?? 0) + 1,
          next_retry_at: 0,
          last_error_code: "invalid_source_identity",
        });
        continue;
      }

      const sourceEndpoint = formatEndpoint(actor);
      if (sourceEndpoint.startsWith("core/system/")) {
        this.#updateOutbox(entry.local_post_id, {
          status: "dead_letter",
          retry_count: (entry.retry_count ?? 0) + 1,
          next_retry_at: 0,
          last_error_code: "invalid_source_identity",
        });
        continue;
      }

      const isPostSubmit = entry.op_kind === "post" || entry.op_kind === "client_post_submit";
      const op = isPostSubmit ? "board_delta" : "board_state_sync";
      const kind = isPostSubmit ? "client_post_submit" : "client_control_request";

      const outboxAttachments = [];
      let totalAttachmentBytes = 0;
      let outboxAttachmentErrorCode = null;
      if (isPostSubmit && Array.isArray(parsedPayload.files) && parsedPayload.files.length > 0) {
        if (parsedPayload.files.length > this.#limits.maxBundleAttachments) {
          outboxAttachmentErrorCode = "relay_bundle_too_large";
        } else {
          for (const f of parsedPayload.files) {
            const pathCandidate = f?.outbox_path ?? f?.local_path ?? null;
            if (!pathCandidate || typeof pathCandidate !== "string" || !f?.file_id || !existsSync(pathCandidate)) {
              outboxAttachmentErrorCode = "source_file_missing";
              break;
            }
            const fileBytes = Number.isSafeInteger(f.bytes) && f.bytes >= 0 ? f.bytes : 0;
            if (totalAttachmentBytes + fileBytes > this.#limits.maxBundleTotalBytes) {
              outboxAttachmentErrorCode = "relay_bundle_too_large";
              break;
            }
            outboxAttachments.push({
              name: makeAttachmentName(entry.board_id, f.file_id),
              filePath: pathCandidate,
            });
            totalAttachmentBytes += fileBytes;
          }
        }
      }
      if (outboxAttachmentErrorCode) {
        this.#updateOutbox(entry.local_post_id, {
          status: "dead_letter",
          retry_count: (entry.retry_count ?? 0) + 1,
          next_retry_at: 0,
          last_error_code: outboxAttachmentErrorCode,
        });
        if (typeof this.#store.cleanupOutboxDir === "function") {
          try {
            this.#store.cleanupOutboxDir(entry.local_post_id);
          } catch {
            // 清理失败交由下次重启 reconcile 兜底
          }
        }
        stats.errors.push({ stage: "remote_outbox", code: outboxAttachmentErrorCode });
        continue;
      }

      const hostAllowsFileBundle = this.#isFileBundleAllowedForPeer(entry.host_machine_id);
      if (outboxAttachments.length > 0 && !hostAllowsFileBundle) {
        const nextRetry = (entry.retry_count ?? 0) + 1;
        this.#updateOutbox(entry.local_post_id, {
          status: "pending",
          retry_count: nextRetry,
          next_retry_at: this.#now() + this.#computeBackoffMs(nextRetry),
          last_error_code: "file_bundle_disabled",
        });
        continue;
      }

      const payloadJson = isPostSubmit
        ? {
            kind: "client_post_submit",
            local_post_id: entry.local_post_id,
            board_id: entry.board_id,
            host_machine_id: entry.host_machine_id,
            actor,
            body: typeof parsedPayload.body === "string" ? parsedPayload.body : "",
            mentions: Array.isArray(parsedPayload.mentions) ? parsedPayload.mentions : [],
            files: Array.isArray(parsedPayload.files)
              ? parsedPayload.files.map(f => ({
                  file_id: f.file_id,
                  safe_name: f.safe_name,
                  bytes: f.bytes,
                  sha256: f.sha256,
                  ...(f.bundle_id !== undefined ? { bundle_id: f.bundle_id } : {}),
                  ...(f.bundle_label !== undefined ? { bundle_label: f.bundle_label } : {}),
                }))
              : [],
            ...(Array.isArray(parsedPayload.sync_machines) ? { sync_machines: parsedPayload.sync_machines } : {}),
            origin_client_post_id: parsedPayload.origin_client_post_id ?? parsedPayload.client_post_id ?? entry.local_post_id,
          }
        : {
            kind: "client_control_request",
            local_post_id: entry.local_post_id,
            board_id: entry.board_id,
            host_machine_id: entry.host_machine_id,
            action: parsedPayload.action ?? entry.op_kind,
            actor,
            params: isPlainObject(parsedPayload.params)
              ? parsedPayload.params
              : (isPlainObject(parsedPayload.payload) ? parsedPayload.payload : {}),
          };

      const dedupeKey = typeof entry.dedupe_key === "string" && entry.dedupe_key.length > 0 && entry.dedupe_key.length <= 128
        ? entry.dedupe_key
        : `bout:${digest(entry.dedupe_key ?? entry.local_post_id).slice(0, 28)}`;

      try {
        const result = await this.#sendRelay({
          op,
          dedupeKey,
          targetMachine: entry.host_machine_id,
          source: sourceEndpoint,
          recipients: [SYSTEM_SYNC_ENDPOINT],
          body: "",
          meta: {
            kind,
            local_post_id: entry.local_post_id,
            board_id: entry.board_id,
          },
          payloadJson,
          attachments: outboxAttachments,
          allowBundle: hostAllowsFileBundle,
          allowDiscloseRecipients: false,
          sourceIdentityVerified: true,
          signal,
        });

        if (isOutcomeUnknown(result)) {
          const nextRetry = (entry.retry_count ?? 0) + 1;
          this.#updateOutbox(entry.local_post_id, {
            status: "unknown",
            retry_count: nextRetry,
            next_retry_at: this.#now() + this.#computeBackoffMs(nextRetry),
            last_error_code: "relay_outcome_unknown",
          });
        } else if (result?.status === "pending_capacity" || result?.stage === "pending_capacity") {
          const nextRetry = (entry.retry_count ?? 0) + 1;
          this.#updateOutbox(entry.local_post_id, {
            status: "pending",
            retry_count: nextRetry,
            next_retry_at: this.#now() + this.#computeBackoffMs(nextRetry),
            last_error_code: "pending_capacity",
          });
        } else {
          this.#updateOutbox(entry.local_post_id, {
            status: "sent",
            retry_count: entry.retry_count ?? 0,
            next_retry_at: 0,
            last_error_code: null,
          });
          stats.outbox_frames += 1;
          stats.sent_frames += 1;
        }
      } catch (error) {
        const code = normalizeErrorCode(error);
        const nextRetry = (entry.retry_count ?? 0) + 1;
        if (PERMANENT_OUTBOX_ERROR_CODES.has(code) || nextRetry > this.#limits.maxRetryCount) {
          this.#updateOutbox(entry.local_post_id, {
            status: "dead_letter",
            retry_count: nextRetry,
            next_retry_at: 0,
            last_error_code: code,
          });
        } else if (isOutcomeUnknown(error)) {
          this.#updateOutbox(entry.local_post_id, {
            status: "unknown",
            retry_count: nextRetry,
            next_retry_at: this.#now() + this.#computeBackoffMs(nextRetry, extractRetryAfterMs(error)),
            last_error_code: code,
          });
        } else {
          this.#updateOutbox(entry.local_post_id, {
            status: "pending",
            retry_count: nextRetry,
            next_retry_at: this.#now() + this.#computeBackoffMs(nextRetry, extractRetryAfterMs(error)),
            last_error_code: code,
          });
        }
        stats.errors.push({ stage: "remote_outbox", local_post_id: entry.local_post_id, code });
        this.#onError(error);
      }
    }

    return stats;
  }

  #updateOutbox(localPostId, patch) {
    if (typeof this.#store.updateRemoteOutboxStatus !== "function") return;
    this.#store.updateRemoteOutboxStatus(localPostId, {
      ...patch,
      nowIso: this.#nowIso(),
    });
  }

  async #sendBoardAck(ctx, ackPayload) {
    const targetMachine = ctx?.remotePrincipal?.from_machine ?? ctx?.frame?.from_machine;
    if (!targetMachine) return null;
    const allowBundleForAck = this.#isFileBundleAllowedForPeer(targetMachine);

    const body = JSON.stringify(ackPayload);
    if (typeof ctx?.reply === "function") {
      return ctx.reply({
        op: "board_ack",
        body,
        meta: { kind: "board_ack", structured_body: true },
        payloadJson: { data: ackPayload },
        allowBundle: allowBundleForAck,
      });
    }

    if (!this.#relaySender) return null;
    const replyRoute = ctx?.remotePrincipal?.relay_key
      ? {
          relay_key: ctx.remotePrincipal.relay_key,
          group_id: ctx.remotePrincipal.group_id,
          route_generation: ctx.remotePrincipal.route_generation,
        }
      : null;

    return this.#sendRelay({
      op: "board_ack",
      dedupeKey: `back:${digest({
        target: targetMachine,
        inReplyTo: ctx?.frame?.relay_id ?? null,
        ackPayload,
      }).slice(0, 28)}`,
      targetMachine,
      source: SYSTEM_SYNC_ENDPOINT,
      recipients: [SYSTEM_SYNC_ENDPOINT],
      inReplyTo: ctx?.frame?.relay_id ?? null,
      body: "",
      meta: { kind: "board_ack" },
      payloadJson: ackPayload,
      attachments: [],
      allowBundle: allowBundleForAck,
      allowDiscloseRecipients: false,
      replyRoute,
    });
  }

  #allocateAliasesForLocalMembers(hostMachineId, boardId, baseTitle, members) {
    if (!this.#addressBookAdapter || typeof this.#addressBookAdapter.saveBoardForIdentity !== "function") {
      return;
    }
    if (!Array.isArray(members) || members.length === 0) return;

    const seenKeys = new Set();
    for (const rawMember of members) {
      if (rawMember?.subscription_state && rawMember.subscription_state !== "active") continue;
      const memberIdentity = parseStrictIdentity4(rawMember);
      if (!memberIdentity || memberIdentity.machine_id !== this.#localMachineId) continue;
      const key = identityKey(memberIdentity);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      try {
        this.#addressBookAdapter.saveBoardForIdentity(memberIdentity, {
          machine_id: hostMachineId,
          board_id: boardId,
          baseTitle: typeof baseTitle === "string" && baseTitle.trim() ? baseTitle.trim() : boardId,
        });
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  #verifyClientSourcePrincipal(ctx, actorRaw) {
    const principal = ctx?.remotePrincipal;
    const fromMachine = principal?.from_machine ?? ctx?.frame?.from_machine ?? null;
    if (!fromMachine) {
      return { ok: false, code: "source_identity_unverified", message: "缺少来源机器标识" };
    }
    if (principal?.trust_source_identity !== true) {
      return { ok: false, code: "source_identity_unverified", message: "来源机器未配置信任源身份策略" };
    }
    const verified = principal?.source_identity_verified === true && ctx?.source_identity_verified !== false;
    if (!verified) {
      return { ok: false, code: "source_identity_unverified", message: "来源对话身份未通过双层校验" };
    }
    const sourceEndpoint = typeof principal?.source_endpoint === "string" && principal.source_endpoint
      ? principal.source_endpoint
      : (typeof ctx?.source_endpoint === "string" ? ctx.source_endpoint : null);
    if (!sourceEndpoint || sourceEndpoint.startsWith("core/system/")) {
      return { ok: false, code: "source_identity_unverified", message: "来源端点缺失或为系统端点" };
    }

    const actor = parseStrictIdentity4(actorRaw);
    if (!actor) {
      return { ok: false, code: "invalid_input", message: "actor 必须是完整的四字段对话身份" };
    }
    if (actor.machine_id !== fromMachine) {
      return { ok: false, code: "source_identity_unverified", message: "actor.machine_id 与来源机器不一致" };
    }
    const actorEndpoint = formatEndpoint(actor);
    if (actorEndpoint !== sourceEndpoint) {
      return { ok: false, code: "source_identity_unverified", message: "actor 端点与帧头核验来源端点不一致" };
    }
    return { ok: true, actor, fromMachine };
  }

  #buildGuardedUpsertInput(incoming, localBoard, fromMachine, { requireExplicitMembersForMeta = false } = {}) {
    const incomingStateVersion = Number.isSafeInteger(incoming.state_version) ? incoming.state_version : 0;
    const incomingMetaVersion = Number.isSafeInteger(incoming.meta_version) ? incoming.meta_version : 1;
    const hasMembersSnapshot = incoming.members_included === true || Array.isArray(incoming.members);
    const metaAllowed = requireExplicitMembersForMeta
      ? hasMembersSnapshot
      : (incoming.members_included !== false);

    if (!localBoard) {
      return {
        shouldUpsert: true,
        canUpdateState: true,
        canUpdateMeta: metaAllowed,
        input: {
          board_id: incoming.board_id,
          host_machine_id: fromMachine,
          title: typeof incoming.title === "string" && incoming.title.trim() ? incoming.title : incoming.board_id,
          status: incoming.status === "archived" ? "archived" : "active",
          state_version: incomingStateVersion,
          meta_version: metaAllowed ? Math.max(1, incomingMetaVersion) : 1,
          archive_version: Number.isSafeInteger(incoming.archive_version) ? incoming.archive_version : 0,
          archive_reason: incoming.archive_reason ?? null,
          settings: extractBoardSettings(incoming),
          creator_key: nonEmptyActorKey(incoming.creator_key),
          created_at: incoming.created_at ?? this.#nowIso(),
          last_active_at: incoming.last_active_at ?? this.#nowIso(),
          archived_at: incoming.archived_at ?? null,
          members: metaAllowed && Array.isArray(incoming.members) ? incoming.members : [],
        },
      };
    }

    const localStateVersion = Number.isSafeInteger(localBoard.state_version) ? localBoard.state_version : 0;
    const localMetaVersion = Number.isSafeInteger(localBoard.meta_version) ? localBoard.meta_version : 1;
    const canUpdateState = incomingStateVersion > localStateVersion;
    const canUpdateMeta = metaAllowed
      && incomingStateVersion >= localStateVersion
      && incomingMetaVersion > localMetaVersion;

    if (!canUpdateState && !canUpdateMeta) {
      return { shouldUpsert: false, canUpdateState: false, canUpdateMeta: false, input: null };
    }

    return {
      shouldUpsert: true,
      canUpdateState,
      canUpdateMeta,
      input: {
        board_id: incoming.board_id,
        host_machine_id: fromMachine,
        title: canUpdateMeta && typeof incoming.title === "string" && incoming.title.trim()
          ? incoming.title
          : localBoard.title,
        status: canUpdateState && (incoming.status === "active" || incoming.status === "archived")
          ? incoming.status
          : localBoard.status,
        state_version: canUpdateState ? incomingStateVersion : localStateVersion,
        meta_version: canUpdateMeta ? incomingMetaVersion : localMetaVersion,
        archive_version: canUpdateState && Number.isSafeInteger(incoming.archive_version)
          ? incoming.archive_version
          : (localBoard.archive_version ?? 0),
        archive_reason: canUpdateState ? (incoming.archive_reason ?? null) : (localBoard.archive_reason ?? null),
        settings: canUpdateMeta ? extractBoardSettings(incoming) : extractBoardSettings(localBoard),
        creator_key: nonEmptyActorKey(localBoard.creator_key, incoming.creator_key),
        created_at: localBoard.created_at ?? incoming.created_at ?? this.#nowIso(),
        last_active_at: incoming.last_active_at ?? localBoard.last_active_at ?? this.#nowIso(),
        archived_at: canUpdateState ? (incoming.archived_at ?? null) : (localBoard.archived_at ?? null),
        members: canUpdateMeta && Array.isArray(incoming.members) ? incoming.members : [],
      },
    };
  }

  #buildStagedFilesIndex(stagedFiles) {
    const byName = new Map();
    if (Array.isArray(stagedFiles)) {
      for (const item of stagedFiles) {
        if (isPlainObject(item) && typeof item.name === "string" && item.name) {
          byName.set(item.name, item);
        }
      }
    }
    return byName;
  }

  async handleInboundBoardDelta(ctx) {
    const payload = extractInboundPayload(ctx);
    if (!isPlainObject(payload)) {
      return { ok: false, code: "invalid_payload" };
    }

    const fromMachine = ctx?.remotePrincipal?.from_machine ?? ctx?.frame?.from_machine ?? null;
    if (!fromMachine) {
      return { ok: false, code: "missing_from_machine" };
    }
    if (!this.#isPeerAllowed(fromMachine)) {
      return { ok: false, code: "board_peer_not_allowed" };
    }

    const kind = payload.kind ?? ctx?.frame?.meta?.kind ?? "host_push_batch";
    if (kind === "client_post_submit") {
      return this.#handleInboundClientPostSubmit(ctx, payload);
    }
    if (kind !== "host_push_batch") {
      return { ok: false, code: "unsupported_delta_kind" };
    }

    const stagedByName = this.#buildStagedFilesIndex(ctx?.staged_files);
    if (stagedByName.size > 0 && !this.#isFileBundleAllowedForPeer(fromMachine)) {
      return { ok: false, code: "relay_file_route_denied" };
    }

    const incomingBoards = Array.isArray(payload.boards) ? payload.boards : [];
    const fileManifest = Array.isArray(payload.file_manifest) ? payload.file_manifest : [];

    const manifestByBoard = new Map();
    for (const mf of fileManifest) {
      if (!isPlainObject(mf) || typeof mf.board_id !== "string" || typeof mf.file_id !== "string") continue;
      if (!manifestByBoard.has(mf.board_id)) manifestByBoard.set(mf.board_id, []);
      manifestByBoard.get(mf.board_id).push(mf);
    }

    const ackBoards = [];

    for (const incoming of incomingBoards) {
      if (!isPlainObject(incoming) || typeof incoming.board_id !== "string") continue;
      const boardId = incoming.board_id;

      try {
        validateBoardIdValue(boardId);
      } catch {
        ackBoards.push({ board_id: boardId, ok: false, error_code: "invalid_input" });
        continue;
      }

      // 1. 强校权威源
      if (incoming.host_machine_id && incoming.host_machine_id !== fromMachine) {
        ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
        continue;
      }

      // 2. 命中墓碑直接丢弃并回 ack 释放 spool，绝不复活
      const tombstone = typeof this.#store.getTombstone === "function" ? this.#store.getTombstone(boardId) : null;
      if (tombstone) {
        if (tombstone.host_machine_id && tombstone.host_machine_id !== fromMachine) {
          ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
          continue;
        }
        ackBoards.push({
          board_id: boardId,
          state_version: tombstone.final_state_version,
          ok: true,
          tombstoned: true,
        });
        continue;
      }

      const localBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
      if (localBoard && localBoard.host_machine_id !== fromMachine) {
        ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
        continue;
      }

      // 纯文件补发场景允许只带 board_id 而无状态版本
      const isFileSyncOnly = payload.file_sync_only === true && (!Array.isArray(incoming.posts) || incoming.posts.length === 0);
      const hasMembersSnapshot = incoming.members_included === true || Array.isArray(incoming.members);
      const incomingStateVersion = Number.isSafeInteger(incoming.state_version)
        ? incoming.state_version
        : (localBoard?.state_version ?? 0);

      if (localBoard && !isFileSyncOnly && incomingStateVersion < localBoard.state_version) {
        ackBoards.push({
          board_id: boardId,
          state_version: localBoard.state_version,
          ...(hasMembersSnapshot
            ? {
                meta_version: localBoard.meta_version,
                acked_meta_version: localBoard.meta_version,
              }
            : {}),
          acked_seq: localBoard.board_seq ?? 0,
          ok: true,
          ignored_stale: true,
        });
        continue;
      }

      // 3. 生命周期与元数据防回退落库（审查 A R3 + A-P0-4 仅携带 members 快照时推进 meta_version）
      let upsertResult = null;
      if (!isFileSyncOnly || !localBoard) {
        const guarded = this.#buildGuardedUpsertInput(incoming, localBoard, fromMachine, {
          requireExplicitMembersForMeta: true,
        });
        if (guarded.shouldUpsert && typeof this.#store.upsertBoardFromRemote === "function") {
          try {
            upsertResult = this.#store.upsertBoardFromRemote(guarded.input);
          } catch (error) {
            if (isTransientStorageError(error)) {
              return { retain_bundle: true, code: "storage_temp_error", message: error.message };
            }
            ackBoards.push({ board_id: boardId, ok: false, error_code: normalizeErrorCode(error) });
            this.#onError(error);
            continue;
          }
          if (upsertResult?.code === "board_deleted_tombstone") {
            const tombNow = this.#store.getTombstone?.(boardId);
            ackBoards.push({
              board_id: boardId,
              state_version: tombNow?.final_state_version ?? incomingStateVersion,
              ok: true,
              tombstoned: true,
            });
            continue;
          }
        }
      }

      const currentBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : localBoard;

      // 4. 跨机受邀本机成员首次落地分配本机短代号
      if (upsertResult?.applied !== false && hasMembersSnapshot) {
        const membersForAlias = Array.isArray(upsertResult?.newly_added_members) && upsertResult.newly_added_members.length > 0
          ? upsertResult.newly_added_members
          : ((!localBoard || upsertResult?.created === true || upsertResult?.meta_changed === true) && Array.isArray(incoming.members)
              ? incoming.members
              : []);
        if (membersForAlias.length > 0) {
          this.#allocateAliasesForLocalMembers(
            fromMachine,
            boardId,
            currentBoard?.title ?? incoming.title ?? boardId,
            membersForAlias,
          );
        }
      }

      // 5. 增量帖按 seq ASC 连续落库（B-P0-3：任一帖失败或检测到空洞立刻 break，绝不越洞推进 acked_seq）
      let contiguousAckedSeq = currentBoard?.board_seq ?? 0;
      let postApplyFailed = false;
      let postApplyErrorCode = null;
      const fileTasks = new Map();
      const posts = Array.isArray(incoming.posts) ? [...incoming.posts].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0)) : [];

      if (currentBoard && currentBoard.status === "active" && incomingStateVersion >= currentBoard.state_version) {
        for (const post of posts) {
          if (!isPlainObject(post) || !Number.isSafeInteger(post.seq) || post.seq < 1) {
            postApplyFailed = true;
            postApplyErrorCode = "invalid_input";
            break;
          }

          const expectedNextSeq = contiguousAckedSeq + 1;
          if (post.seq > expectedNextSeq) {
            postApplyFailed = true;
            postApplyErrorCode = "seq_gap_detected";
            break;
          }

          const stagedTasksForPost = [];
          const postFiles = extractPostFiles(post).map(f => {
            const attName = makeAttachmentName(boardId, f.file_id);
            const hasStaged = stagedByName.has(attName);
            const targeted = isMachineTargetedForFile(f, this.#localMachineId);
            if (hasStaged) {
              stagedTasksForPost.push({
                board_id: boardId,
                seq: post.seq,
                file_id: f.file_id,
                safe_name: f.safe_name,
                expected_sha256: f.sha256,
                expected_bytes: f.bytes,
                attachment_name: attName,
                required: true,
              });
            }
            return {
              ...f,
              local_status: (targeted || hasStaged) ? "pending_sync" : "not_targeted",
            };
          });

          try {
            let applyRes = null;
            if (typeof this.#store.applyRemotePost === "function") {
              applyRes = this.#store.applyRemotePost({
                boardId,
                seq: post.seq,
                author: extractPostAuthor(post),
                body: typeof post.body === "string" ? post.body : "",
                mentions: extractPostMentions(post),
                files: postFiles,
                created_at: post.created_at ?? this.#nowIso(),
                origin_client_post_id: post.origin_client_post_id ?? `host_seq_${post.seq}`,
                incomingStateVersion,
              });
            }
            if (applyRes && applyRes.applied === false && applyRes.deduplicated !== true) {
              postApplyFailed = true;
              postApplyErrorCode = normalizeErrorCode(applyRes.code ?? "post_not_applied");
              break;
            }
            if (post.seq === expectedNextSeq) {
              contiguousAckedSeq = post.seq;
            }
            for (const task of stagedTasksForPost) {
              fileTasks.set(task.file_id, task);
            }
          } catch (error) {
            if (isTransientStorageError(error)) {
              return { retain_bundle: true, code: "storage_temp_error", message: error.message };
            }
            postApplyFailed = true;
            postApplyErrorCode = normalizeErrorCode(error);
            this.#onError(error);
            break;
          }
        }
      }

      // 合并 file_manifest 中归属本板的文件任务（跳过未落库空洞帖的附件）
      for (const mf of (manifestByBoard.get(boardId) ?? [])) {
        if (postApplyFailed && Number.isSafeInteger(mf.seq) && mf.seq > contiguousAckedSeq) continue;
        if (!fileTasks.has(mf.file_id)) {
          fileTasks.set(mf.file_id, {
            board_id: boardId,
            seq: Number.isSafeInteger(mf.seq) ? mf.seq : null,
            file_id: mf.file_id,
            safe_name: mf.safe_name,
            expected_sha256: mf.sha256,
            expected_bytes: mf.bytes,
            attachment_name: mf.attachment_name ?? makeAttachmentName(boardId, mf.file_id),
            required: true,
          });
        }
      }

      // 兼容直接随 staged_files 到来但未写 file_manifest 的本板文件
      for (const [attName, staged] of stagedByName.entries()) {
        const parsedName = parseAttachmentName(attName);
        if (!parsedName || parsedName.board_id !== boardId) continue;
        if (fileTasks.has(parsedName.file_id)) continue;
        const knownPost = typeof this.#store.getPostByFileId === "function"
          ? this.#store.getPostByFileId(boardId, parsedName.file_id)
          : null;
        const knownFile = knownPost
          ? extractPostFiles(knownPost).find(f => f?.file_id === parsedName.file_id)
          : null;
        if (knownFile) {
          fileTasks.set(parsedName.file_id, {
            board_id: boardId,
            seq: knownPost.seq,
            file_id: parsedName.file_id,
            safe_name: knownFile.safe_name,
            expected_sha256: knownFile.sha256,
            expected_bytes: knownFile.bytes,
            attachment_name: attName,
            required: true,
            staged,
          });
        }
      }

      // 6. 远端文件原子落盘后再释放 spool（单文件坏哈希隔离，临时存储错返回 retain_bundle: true，归档板传 archived）
      const filesAcked = [];
      const filesFailed = [];

      for (const task of fileTasks.values()) {
        const staged = stagedByName.get(task.attachment_name);
        if (!staged) {
          filesFailed.push({ file_id: task.file_id, code: "staged_file_missing" });
          continue;
        }

        // 若本机帖子记录里有权威期望哈希/字节/safe_name，优先对齐防伪
        let seq = task.seq;
        let safeName = task.safe_name;
        let expectedSha256 = task.expected_sha256;
        let expectedBytes = task.expected_bytes;
        if ((seq === null || !safeName || !expectedSha256) && typeof this.#store.getPostByFileId === "function") {
          const postRec = this.#store.getPostByFileId(boardId, task.file_id);
          if (postRec) {
            if (seq === null && Number.isSafeInteger(postRec.seq)) seq = postRec.seq;
            const fRec = extractPostFiles(postRec).find(f => f?.file_id === task.file_id);
            if (fRec) {
              safeName = safeName ?? fRec.safe_name;
              expectedSha256 = expectedSha256 ?? fRec.sha256;
              expectedBytes = expectedBytes ?? fRec.bytes;
            }
          }
        }

        try {
          const stagedResult = this.#store.stageRemoteFileBufferOrPath({
            sourcePath: staged.filePath,
            buffer: staged.buffer,
            boardId,
            fileId: task.file_id,
            safeName,
            expectedSha256,
            expectedBytes,
            archived: currentBoard?.status === "archived",
          });
          if (seq !== null && typeof this.#store.updatePostFileLocalStatus === "function") {
            this.#store.updatePostFileLocalStatus(boardId, seq, task.file_id, {
              local_status: "ready",
              local_path: stagedResult.local_path,
              rel_path: stagedResult.rel_path,
            });
          }
          filesAcked.push(task.file_id);
        } catch (error) {
          if (isTransientStorageError(error)) {
            return {
              retain_bundle: true,
              code: "storage_temp_error",
              message: error.message ?? "远端文件暂存落盘遇到临时存储错误",
            };
          }
          const failCode = normalizeErrorCode(error);
          if (seq !== null && typeof this.#store.updatePostFileLocalStatus === "function") {
            this.#store.updatePostFileLocalStatus(boardId, seq, task.file_id, {
              local_status: "failed",
              local_path: null,
              rel_path: null,
            });
          }
          filesFailed.push({ file_id: task.file_id, code: failCode });
          this.#onError(error);
        }
      }

      const refreshedBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : currentBoard;
      ackBoards.push({
        board_id: boardId,
        state_version: refreshedBoard?.state_version ?? incomingStateVersion,
        ...(hasMembersSnapshot
          ? {
              meta_version: refreshedBoard?.meta_version ?? incoming.meta_version ?? 1,
              acked_meta_version: refreshedBoard?.meta_version ?? incoming.meta_version ?? 1,
            }
          : {}),
        acked_seq: contiguousAckedSeq,
        ok: !postApplyFailed,
        ...(postApplyFailed ? { error_code: postApplyErrorCode ?? "post_apply_failed" } : {}),
        ...(filesAcked.length > 0 ? { files_acked: filesAcked } : {}),
        ...(filesFailed.length > 0 ? { files_failed: filesFailed } : {}),
      });
    }

    const ackPayload = { kind: "board_ack", boards: ackBoards };
    await this.#sendBoardAck(ctx, ackPayload);
    return { ok: true, boards: ackBoards };
  }

  async #handleInboundClientPostSubmit(ctx, payload) {
    const localPostId = typeof payload.local_post_id === "string" ? payload.local_post_id : null;
    const boardId = typeof payload.board_id === "string" ? payload.board_id : null;

    const sendReply = async controlReply => {
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [], control_reply: controlReply });
      return { ok: controlReply.ok === true, control_reply: controlReply };
    };

    const auth = this.#verifyClientSourcePrincipal(ctx, payload.actor);
    if (!auth.ok) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: false,
        status: "rejected",
        error_code: auth.code,
        error_message: auth.message,
      });
    }

    if (!boardId || !BOARD_ID_RE.test(boardId)) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: false,
        status: "rejected",
        error_code: "invalid_input",
      });
    }

    if (
      !this.#engine
      || (
        typeof this.#engine.postFromRemoteClient !== "function"
        && typeof this.#engine.postMessage !== "function"
        && typeof this.#engine.invoke !== "function"
      )
    ) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: false,
        status: "rejected",
        error_code: "engine_not_configured",
      });
    }

    // 鉴权与权威先核（严禁对非成员提前区分 board_deleted / board_archived vs board_not_found，更严禁在鉴权前落盘客机附件！）
    const eligibility = this.#checkActorPostEligibility(auth.actor, boardId);
    if (!eligibility.allowed) {
      const reason = eligibility.reason ?? "forbidden";
      const status = reason === "board_archived"
        ? "rejected_archived"
        : (reason === "board_not_found" || reason === "board_deleted" ? "rejected_deleted" : "rejected");
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: false,
        status,
        error_code: reason,
        ...(reason === "forbidden" ? { error_message: "仅交流板活跃成员或管理员可执行该操作" } : {}),
      });
    }

    const board = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;

    // 鉴权与活跃状态通过后再检查附件许可并落盘验 SHA-256（失败零残留兜底清理）
    const stagedByName = this.#buildStagedFilesIndex(ctx?.staged_files);
    const incomingFiles = Array.isArray(payload.files) ? payload.files : [];
    if ((stagedByName.size > 0 || incomingFiles.length > 0) && !this.#isFileBundleAllowedForPeer(auth.fromMachine)) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: false,
        status: "rejected",
        error_code: "relay_file_route_denied",
        error_message: "来源机器未获准同步交流板附件",
      });
    }

    const preparedFiles = [];
    const createdStagedPaths = [];
    const cleanupCreatedStagedFiles = () => {
      for (const stagedPath of createdStagedPaths) {
        try {
          rmSync(stagedPath, { force: true });
        } catch {
          // 忽略已被 postFromRemoteClient 清理或不存在的路径
        }
      }
      createdStagedPaths.length = 0;
    };

    if (incomingFiles.length > 0) {
      for (const f of incomingFiles) {
        if (!isPlainObject(f) || typeof f.file_id !== "string") {
          cleanupCreatedStagedFiles();
          return sendReply({
            local_post_id: localPostId,
            board_id: boardId,
            ok: false,
            status: "rejected",
            error_code: "invalid_input",
            error_message: "客机发帖附件元数据无效",
          });
        }
        const attName = makeAttachmentName(boardId, f.file_id);
        const staged = stagedByName.get(attName);
        if (!staged || typeof this.#store.stageRemoteFileBufferOrPath !== "function") {
          cleanupCreatedStagedFiles();
          return sendReply({
            local_post_id: localPostId,
            board_id: boardId,
            ok: false,
            status: "rejected",
            error_code: "staged_file_missing",
            error_message: "缺少客机随帖上传的暂存附件",
          });
        }

        let existedBefore = false;
        if (typeof this.#store.resolveSafeBoardFilePath === "function" && typeof f.safe_name === "string") {
          try {
            const candidatePath = this.#store.resolveSafeBoardFilePath(boardId, f.file_id, f.safe_name, { archived: false });
            existedBefore = existsSync(candidatePath);
          } catch {
            existedBefore = false;
          }
        }

        try {
          const stored = this.#store.stageRemoteFileBufferOrPath({
            sourcePath: staged.filePath,
            buffer: staged.buffer,
            boardId,
            fileId: f.file_id,
            safeName: f.safe_name,
            expectedSha256: f.sha256,
            expectedBytes: f.bytes,
            archived: false,
          });
          if (!existedBefore && typeof stored?.local_path === "string") {
            createdStagedPaths.push(stored.local_path);
          }
          preparedFiles.push({
            ...f,
            safe_name: stored.safe_name ?? f.safe_name,
            local_path: stored.local_path,
            rel_path: stored.rel_path,
            bytes: stored.bytes,
            sha256: stored.sha256,
            pre_staged: true,
          });
        } catch (error) {
          cleanupCreatedStagedFiles();
          if (isTransientStorageError(error)) {
            return { retain_bundle: true, code: "storage_temp_error", message: error.message };
          }
          return sendReply({
            local_post_id: localPostId,
            board_id: boardId,
            ok: false,
            status: "rejected",
            error_code: normalizeErrorCode(error),
            error_message: error.message,
          });
        }
      }
    }

    try {
      const clientPostId = payload.origin_client_post_id ?? payload.client_post_id ?? localPostId;
      const postParams = {
        body: typeof payload.body === "string" ? payload.body : "",
        mentions: Array.isArray(payload.mentions) ? payload.mentions : [],
        files: preparedFiles,
        ...(Array.isArray(payload.sync_machines) ? { sync_machines: payload.sync_machines } : {}),
        client_post_id: clientPostId,
      };
      const boardRef = { machine_id: this.#localMachineId, board_id: boardId };
      let postResult;
      if (typeof this.#engine.postFromRemoteClient === "function") {
        postResult = await this.#engine.postFromRemoteClient(auth.actor, postParams, {
          board: boardRef,
          preStagedFiles: preparedFiles,
          remotePrincipal: ctx?.remotePrincipal ?? null,
        });
      } else if (typeof this.#engine.postMessage === "function") {
        postResult = await this.#engine.postMessage(auth.actor, postParams, {
          board: boardRef,
          remotePrincipal: ctx?.remotePrincipal ?? null,
        });
      } else {
        postResult = await this.#engine.invoke({
          action: "post",
          actorIdentity: auth.actor,
          board: boardRef,
          params: postParams,
          remotePrincipal: ctx?.remotePrincipal ?? null,
        });
      }

      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: true,
        status: "acked",
        seq: postResult?.seq ?? null,
        state_version: board?.state_version ?? 0,
        meta_version: board?.meta_version ?? 1,
      });
    } catch (error) {
      cleanupCreatedStagedFiles();
      if (isTransientStorageError(error)) {
        return { retain_bundle: true, code: "storage_temp_error", message: error.message };
      }
      const code = normalizeErrorCode(error);
      const status = code === "board_archived"
        ? "rejected_archived"
        : (code === "board_deleted" || code === "board_not_found" ? "rejected_deleted" : "rejected");
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        ok: false,
        status,
        error_code: code,
        error_message: error?.message ?? "",
      });
    }
  }

  async handleInboundBoardDissolved(ctx) {
    const payload = extractInboundPayload(ctx);
    if (!isPlainObject(payload) || typeof payload.board_id !== "string") {
      return { ok: false, code: "invalid_payload" };
    }

    const fromMachine = ctx?.remotePrincipal?.from_machine ?? ctx?.frame?.from_machine ?? null;
    if (!fromMachine) {
      return { ok: false, code: "missing_from_machine" };
    }
    if (!this.#isPeerAllowed(fromMachine)) {
      return { ok: false, code: "board_peer_not_allowed" };
    }

    const boardId = payload.board_id;
    try {
      validateBoardIdValue(boardId);
    } catch {
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [{ board_id: boardId, ok: false, error_code: "invalid_input" }] });
      return { ok: false, code: "invalid_input" };
    }

    if (payload.host_machine_id && payload.host_machine_id !== fromMachine) {
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [{ board_id: boardId, ok: false, error_code: "host_authority_mismatch" }] });
      return { ok: false, code: "host_authority_mismatch" };
    }

    // 命中墓碑绝不复活
    const tombstone = typeof this.#store.getTombstone === "function" ? this.#store.getTombstone(boardId) : null;
    if (tombstone) {
      if (tombstone.host_machine_id && tombstone.host_machine_id !== fromMachine) {
        await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [{ board_id: boardId, ok: false, error_code: "host_authority_mismatch" }] });
        return { ok: false, code: "host_authority_mismatch" };
      }
      const ackBoard = {
        board_id: boardId,
        state_version: tombstone.final_state_version,
        ok: true,
        tombstoned: true,
      };
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [ackBoard] });
      return { ok: true, tombstoned: true, boards: [ackBoard] };
    }

    const localBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
    if (localBoard && localBoard.host_machine_id !== fromMachine) {
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [{ board_id: boardId, ok: false, error_code: "host_authority_mismatch" }] });
      return { ok: false, code: "host_authority_mismatch" };
    }

    const incomingStateVersion = Number.isSafeInteger(payload.state_version) ? payload.state_version : -1;
    const incomingArchiveVersion = Number.isSafeInteger(payload.archive_version) ? payload.archive_version : -1;
    if (incomingStateVersion < 1 || incomingArchiveVersion < 1) {
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [{ board_id: boardId, ok: false, error_code: "invalid_input" }] });
      return { ok: false, code: "invalid_input" };
    }
    const isNewerState = !localBoard || incomingStateVersion > localBoard.state_version;
    const canAckMeta = payload.members_included !== false;
    let enqueuedDissolvedCount = 0;

    if (isNewerState && typeof this.#store.upsertBoardFromRemote === "function") {
      const guarded = this.#buildGuardedUpsertInput({
        ...payload,
        status: "archived",
        archive_reason: "manual_dissolve",
        state_version: incomingStateVersion,
        archive_version: incomingArchiveVersion,
      }, localBoard, fromMachine, { requireExplicitMembersForMeta: false });
      let upsertResult = null;
      if (guarded.shouldUpsert) {
        try {
          upsertResult = this.#store.upsertBoardFromRemote(guarded.input);
        } catch (error) {
          if (isTransientStorageError(error)) {
            return { retain_bundle: true, code: "storage_temp_error", message: error.message };
          }
          const code = normalizeErrorCode(error);
          this.#onError(error);
          await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [{ board_id: boardId, ok: false, error_code: code }] });
          return { ok: false, code };
        }
        if (upsertResult?.code === "board_deleted_tombstone") {
          const tombNow = this.#store.getTombstone?.(boardId);
          const ackBoard = {
            board_id: boardId,
            state_version: tombNow?.final_state_version ?? incomingStateVersion,
            ok: true,
            tombstoned: true,
          };
          await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [ackBoard] });
          return { ok: true, tombstoned: true, boards: [ackBoard] };
        }
      }

      // 为本机活跃成员入队手动解散提醒（持久去重）
      if (typeof this.#store.listMembers === "function" && typeof this.#store.enqueueNotification === "function") {
        const storedActiveMembers = this.#store.listMembers(boardId, { activeOnly: true }) ?? [];
        const fallbackPayloadMembers = storedActiveMembers.length === 0 && Array.isArray(payload.members)
          ? payload.members.filter(m => !m?.subscription_state || m.subscription_state === "active")
          : [];
        const notifyMembers = storedActiveMembers.length > 0 ? storedActiveMembers : fallbackPayloadMembers;
        const nowIso = this.#nowIso();
        const dissolvedTitle = typeof payload.title === "string" && payload.title.trim()
          ? payload.title.trim()
          : (localBoard?.title ?? boardId);
        const dissolvedByKey = nonEmptyActorKey(payload.dissolved_by_key, payload.creator_key);
        try {
          for (const member of notifyMembers) {
            if (member.machine_id !== this.#localMachineId) continue;
            const memberId = parseStrictIdentity4(member);
            if (!memberId) continue;
            const memberKey = member.member_key ?? identityKey(memberId);
            this.#store.enqueueNotification({
              dedupe_key: `dissolved:${boardId}:${incomingArchiveVersion}:${memberKey}`,
              board_id: boardId,
              member_key: memberKey,
              member_json: JSON.stringify(memberId),
              kind: "dissolved",
              state_version: incomingStateVersion,
              payload_json: JSON.stringify({
                board_id: boardId,
                host_machine_id: fromMachine,
                title: dissolvedTitle,
                state_version: incomingStateVersion,
                archive_version: incomingArchiveVersion,
                archive_reason: "manual_dissolve",
                dissolved_by_key: dissolvedByKey,
              }),
              nowIso,
            });
            enqueuedDissolvedCount += 1;
          }
        } catch (error) {
          if (isTransientStorageError(error)) {
            return { retain_bundle: true, code: "storage_temp_error", message: error.message };
          }
          this.#onError(error);
        }
      }

      if (typeof this.#store.reconcilePendingFileOps === "function") {
        try {
          this.#store.reconcilePendingFileOps();
        } catch (error) {
          this.#onError(error);
        }
      }

      // 客机高优解散提醒实时送达（捕获错转 onError，不阻断 ACK）
      if (enqueuedDissolvedCount > 0 && !this.#closed && typeof this.#engine?.localNotifyTick === "function") {
        try {
          await this.#engine.localNotifyTick({ signal: this.#lifecycleAbort.signal });
        } catch (error) {
          this.#onError(error);
        }
      }
    }

    const currentBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : localBoard;
    const ackBoard = {
      board_id: boardId,
      state_version: currentBoard?.state_version ?? incomingStateVersion,
      ...(canAckMeta
        ? {
            meta_version: currentBoard?.meta_version ?? payload.meta_version ?? 1,
            acked_meta_version: currentBoard?.meta_version ?? payload.meta_version ?? 1,
          }
        : {}),
      ...(currentBoard?.status === "archived" || isNewerState
        ? { notified_dissolve_version: Math.max(currentBoard?.archive_version ?? 0, isNewerState ? incomingArchiveVersion : 0) }
        : {}),
      ok: true,
    };
    await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [ackBoard] });
    return { ok: true, boards: [ackBoard] };
  }

  async handleInboundBoardStateSync(ctx) {
    const payload = extractInboundPayload(ctx);
    if (!isPlainObject(payload)) {
      return { ok: false, code: "invalid_payload" };
    }

    const fromMachine = ctx?.remotePrincipal?.from_machine ?? ctx?.frame?.from_machine ?? null;
    if (!fromMachine) {
      return { ok: false, code: "missing_from_machine" };
    }
    if (!this.#isPeerAllowed(fromMachine)) {
      return { ok: false, code: "board_peer_not_allowed" };
    }

    const kind = payload.kind ?? ctx?.frame?.meta?.kind;
    if (kind === "client_control_request") {
      return this.#handleInboundClientControlRequest(ctx, payload);
    }

    if (kind === "host_deleted_tombstone") {
      const list = Array.isArray(payload.tombstones)
        ? payload.tombstones
        : (typeof payload.board_id === "string" ? [payload] : []);
      const ackTombstones = [];
      const ackBoards = [];

      for (const item of list) {
        if (!isPlainObject(item) || typeof item.board_id !== "string") continue;
        const boardId = item.board_id;
        try {
          validateBoardIdValue(boardId);
        } catch {
          ackTombstones.push({ board_id: boardId, ok: false, error_code: "invalid_input" });
          continue;
        }

        const localBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
        const localTomb = typeof this.#store.getTombstone === "function" ? this.#store.getTombstone(boardId) : null;
        if (
          (item.host_machine_id && item.host_machine_id !== fromMachine)
          || (localBoard && localBoard.host_machine_id !== fromMachine)
          || (localTomb && localTomb.host_machine_id !== fromMachine)
        ) {
          ackTombstones.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
          ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
          continue;
        }

        const finalStateVersion = Number.isSafeInteger(item.final_state_version) && item.final_state_version >= 1
          ? item.final_state_version
          : Math.max(1, (localBoard?.state_version ?? 0) + 1);

        if (typeof this.#store.applyRemoteTombstone === "function") {
          try {
            this.#store.applyRemoteTombstone({
              board_id: boardId,
              host_machine_id: fromMachine,
              final_state_version: finalStateVersion,
              deleted_by_key: nonEmptyActorKey(item.deleted_by_key),
              deleted_at: item.deleted_at ?? this.#nowIso(),
            });
          } catch (error) {
            if (isTransientStorageError(error)) {
              return { retain_bundle: true, code: "storage_temp_error", message: error.message };
            }
            const code = normalizeErrorCode(error);
            ackTombstones.push({ board_id: boardId, ok: false, error_code: code });
            ackBoards.push({ board_id: boardId, ok: false, error_code: code });
            this.#onError(error);
            continue;
          }
        }
        ackTombstones.push({ board_id: boardId, final_state_version: finalStateVersion, ok: true });
        ackBoards.push({ board_id: boardId, state_version: finalStateVersion, ok: true, tombstoned: true });
      }

      if (typeof this.#store.reconcilePendingFileOps === "function") {
        try {
          this.#store.reconcilePendingFileOps();
        } catch (error) {
          this.#onError(error);
        }
      }

      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: ackBoards, tombstones: ackTombstones });
      return { ok: true, tombstones: ackTombstones, boards: ackBoards };
    }

    if (kind === "host_state_push") {
      const list = Array.isArray(payload.boards)
        ? payload.boards
        : (typeof payload.board_id === "string" ? [payload] : []);
      const ackBoards = [];
      let needsReconcile = false;

      for (const incoming of list) {
        if (!isPlainObject(incoming) || typeof incoming.board_id !== "string") continue;
        const boardId = incoming.board_id;
        try {
          validateBoardIdValue(boardId);
        } catch {
          ackBoards.push({ board_id: boardId, ok: false, error_code: "invalid_input" });
          continue;
        }

        if (incoming.host_machine_id && incoming.host_machine_id !== fromMachine) {
          ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
          continue;
        }

        const tombstone = typeof this.#store.getTombstone === "function" ? this.#store.getTombstone(boardId) : null;
        if (tombstone) {
          if (tombstone.host_machine_id && tombstone.host_machine_id !== fromMachine) {
            ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
            continue;
          }
          ackBoards.push({
            board_id: boardId,
            state_version: tombstone.final_state_version,
            ok: true,
            tombstoned: true,
          });
          continue;
        }

        const localBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
        if (localBoard && localBoard.host_machine_id !== fromMachine) {
          ackBoards.push({ board_id: boardId, ok: false, error_code: "host_authority_mismatch" });
          continue;
        }

        const canAckMeta = incoming.members_included !== false;
        const guarded = this.#buildGuardedUpsertInput(incoming, localBoard, fromMachine, {
          requireExplicitMembersForMeta: false,
        });
        let upsertResult = null;
        if (guarded.shouldUpsert && typeof this.#store.upsertBoardFromRemote === "function") {
          try {
            upsertResult = this.#store.upsertBoardFromRemote(guarded.input);
          } catch (error) {
            if (isTransientStorageError(error)) {
              return { retain_bundle: true, code: "storage_temp_error", message: error.message };
            }
            ackBoards.push({ board_id: boardId, ok: false, error_code: normalizeErrorCode(error) });
            this.#onError(error);
            continue;
          }
          if (upsertResult?.code === "board_deleted_tombstone") {
            const tombNow = this.#store.getTombstone?.(boardId);
            ackBoards.push({
              board_id: boardId,
              state_version: tombNow?.final_state_version ?? incoming.state_version ?? 1,
              ok: true,
              tombstoned: true,
            });
            continue;
          }
          if (guarded.canUpdateState) needsReconcile = true;
          if (upsertResult?.applied !== false && canAckMeta) {
            const aliasCandidates = Array.isArray(upsertResult?.newly_added_members) && upsertResult.newly_added_members.length > 0
              ? upsertResult.newly_added_members
              : ((!localBoard || upsertResult?.created === true || upsertResult?.meta_changed === true) && Array.isArray(incoming.members)
                  ? incoming.members
                  : []);
            if (aliasCandidates.length > 0) {
              this.#allocateAliasesForLocalMembers(fromMachine, boardId, guarded.input.title, aliasCandidates);
            }
          }
        }

        const refreshed = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : localBoard;
        ackBoards.push({
          board_id: boardId,
          state_version: refreshed?.state_version ?? incoming.state_version ?? 0,
          ...(canAckMeta
            ? {
                meta_version: refreshed?.meta_version ?? incoming.meta_version ?? 1,
                acked_meta_version: refreshed?.meta_version ?? incoming.meta_version ?? 1,
              }
            : {}),
          ok: true,
        });
      }

      if (needsReconcile && typeof this.#store.reconcilePendingFileOps === "function") {
        try {
          this.#store.reconcilePendingFileOps();
        } catch (error) {
          this.#onError(error);
        }
      }

      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: ackBoards });
      return { ok: true, boards: ackBoards };
    }

    return { ok: false, code: "unsupported_state_sync_kind" };
  }

  async #handleInboundClientControlRequest(ctx, payload) {
    const localPostId = typeof payload.local_post_id === "string" ? payload.local_post_id : null;
    const boardId = typeof payload.board_id === "string" ? payload.board_id : null;
    const action = typeof payload.action === "string" ? payload.action : null;

    const sendReply = async controlReply => {
      await this.#sendBoardAck(ctx, { kind: "board_ack", boards: [], control_reply: controlReply });
      return { ok: controlReply.ok === true, control_reply: controlReply };
    };

    const auth = this.#verifyClientSourcePrincipal(ctx, payload.actor);
    if (!auth.ok) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        action,
        ok: false,
        status: "rejected",
        error_code: auth.code,
        error_message: auth.message,
      });
    }

    if (!action || !ALLOWED_CLIENT_CONTROL_ACTIONS.has(action)) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        action,
        ok: false,
        status: "rejected",
        error_code: "unsupported_control_action",
      });
    }

    if (!boardId || !BOARD_ID_RE.test(boardId)) {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        action,
        ok: false,
        status: "rejected",
        error_code: "invalid_input",
      });
    }

    if (!this.#engine || typeof this.#engine.invoke !== "function") {
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        action,
        ok: false,
        status: "rejected",
        error_code: "engine_not_configured",
      });
    }

    // 统一交由 engine.invoke 执行权限判定与脱敏报错，绝不在同步层提前区分 board_deleted / board_not_found
    const params = isPlainObject(payload.params)
      ? payload.params
      : (isPlainObject(payload.payload) ? payload.payload : {});

    try {
      const result = await this.#engine.invoke({
        action,
        actorIdentity: auth.actor,
        board: { machine_id: this.#localMachineId, board_id: boardId },
        params,
        remotePrincipal: ctx?.remotePrincipal ?? null,
      });
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        action,
        ok: true,
        status: "acked",
        result: isPlainObject(result) ? result : {},
      });
    } catch (error) {
      if (isTransientStorageError(error)) {
        return { retain_bundle: true, code: "storage_temp_error", message: error.message };
      }
      const code = normalizeErrorCode(error);
      const status = code === "board_archived"
        ? "rejected_archived"
        : (code === "board_deleted" || code === "board_not_found" ? "rejected_deleted" : "rejected");
      return sendReply({
        local_post_id: localPostId,
        board_id: boardId,
        action,
        ok: false,
        status,
        error_code: code,
        error_message: error?.message ?? "",
      });
    }
  }

  async handleInboundBoardAck(ctx) {
    const payload = extractInboundPayload(ctx);
    if (!isPlainObject(payload)) {
      return { ok: false, code: "invalid_payload" };
    }

    const peerMachineId = ctx?.remotePrincipal?.from_machine ?? ctx?.frame?.from_machine ?? null;
    if (!peerMachineId) {
      return { ok: false, code: "missing_from_machine" };
    }
    if (!this.#isPeerAllowed(peerMachineId)) {
      return { ok: false, code: "board_peer_not_allowed" };
    }

    const nowMs = this.#now();
    const nowIso = new Date(nowMs).toISOString();
    let advancedBoards = 0;
    let ackedFiles = 0;
    let failedFiles = 0;
    let ackedTombstones = 0;
    let updatedOutbox = 0;

    // 1. 逐板逐文件单调推进（仅 ok === true 按 MAX 推进）
    const boards = Array.isArray(payload.boards) ? payload.boards : [];
    for (const item of boards) {
      if (!isPlainObject(item) || typeof item.board_id !== "string") continue;
      const boardId = item.board_id;

      if (item.ok === true) {
        const localBoard = typeof this.#store.getBoard === "function" ? this.#store.getBoard(boardId) : null;
        if (localBoard && localBoard.host_machine_id === this.#localMachineId && typeof this.#store.advanceSyncState === "function") {
          const curSync = typeof this.#store.getSyncState === "function"
            ? (this.#store.getSyncState(boardId, peerMachineId) ?? {})
            : {};
          const patch = { synced_at: nowIso };
          if (Number.isSafeInteger(item.acked_seq) && item.acked_seq >= 0) {
            patch.acked_seq = Math.max(curSync.last_acked_seq ?? 0, item.acked_seq);
          }
          if (Number.isSafeInteger(item.state_version) && item.state_version >= 0) {
            patch.acked_state_version = Math.max(curSync.last_acked_state_version ?? 0, item.state_version);
          }
          const incomingMetaVer = Number.isSafeInteger(item.acked_meta_version)
            ? item.acked_meta_version
            : (Number.isSafeInteger(item.meta_version) ? item.meta_version : null);
          if (incomingMetaVer !== null && incomingMetaVer >= 0) {
            patch.acked_meta_version = Math.max(curSync.last_acked_meta_version ?? 0, incomingMetaVer);
          }
          if (Number.isSafeInteger(item.notified_dissolve_version) && item.notified_dissolve_version >= 0) {
            patch.notified_dissolve_version = Math.max(curSync.last_notified_dissolve_version ?? 0, item.notified_dissolve_version);
          }
          this.#store.advanceSyncState(boardId, peerMachineId, patch);
          advancedBoards += 1;
        }

        if (item.tombstoned === true && typeof this.#store.ackTombstoneSync === "function") {
          const tomb = typeof this.#store.getTombstone === "function" ? this.#store.getTombstone(boardId) : null;
          if (tomb && tomb.host_machine_id === this.#localMachineId) {
            this.#store.ackTombstoneSync(boardId, peerMachineId, item.state_version ?? tomb.final_state_version);
            ackedTombstones += 1;
          }
        }

        if (Array.isArray(item.files_acked) && typeof this.#store.updateFileSyncItemStatus === "function") {
          for (const fileId of item.files_acked) {
            if (typeof fileId !== "string" || !fileId) continue;
            this.#store.updateFileSyncItemStatus(boardId, fileId, peerMachineId, {
              status: "acked",
              retry_count: 0,
              next_retry_at: 0,
              last_error: null,
              nowIso,
            });
            ackedFiles += 1;
          }
        }
      }

      if (Array.isArray(item.files_failed) && typeof this.#store.updateFileSyncItemStatus === "function") {
        for (const fail of item.files_failed) {
          if (!isPlainObject(fail) || typeof fail.file_id !== "string" || !fail.file_id) continue;
          const failCode = typeof fail.code === "string" && fail.code ? fail.code : "file_sync_failed";
          const currentItem = typeof this.#store.getFileSyncItem === "function"
            ? this.#store.getFileSyncItem(boardId, fail.file_id, peerMachineId)
            : null;
          const nextRetry = (currentItem?.retry_count ?? 0) + 1;
          const permanent = PERMANENT_FILE_ERROR_CODES.has(failCode) || nextRetry > this.#limits.maxRetryCount;
          this.#store.updateFileSyncItemStatus(boardId, fail.file_id, peerMachineId, {
            status: permanent ? "failed" : "pending",
            retry_count: nextRetry,
            next_retry_at: permanent ? 0 : nowMs + this.#computeBackoffMs(nextRetry),
            last_error: failCode,
            nowIso,
          });
          failedFiles += 1;
        }
      }
    }

    // 2. 墓碑确认（与 boards[].tombstoned 保持同口径 host_machine_id 核对）
    const tombstones = Array.isArray(payload.tombstones) ? payload.tombstones : [];
    for (const tomb of tombstones) {
      if (!isPlainObject(tomb) || tomb.ok !== true || typeof tomb.board_id !== "string") continue;
      const localTomb = typeof this.#store.getTombstone === "function"
        ? this.#store.getTombstone(tomb.board_id)
        : null;
      if (localTomb && localTomb.host_machine_id !== this.#localMachineId) continue;
      if (typeof this.#store.ackTombstoneSync === "function") {
        this.#store.ackTombstoneSync(tomb.board_id, peerMachineId, tomb.final_state_version);
        ackedTombstones += 1;
      }
    }

    // 3. 客机控制/发帖回执推进 board_remote_outbox（B-P1-1：严格 fail-closed，查无记录或非对应建板机一律丢弃）
    const controlReplies = [];
    if (isPlainObject(payload.control_reply)) controlReplies.push(payload.control_reply);
    if (Array.isArray(payload.control_replies)) {
      for (const r of payload.control_replies) {
        if (isPlainObject(r)) controlReplies.push(r);
      }
    }

    for (const reply of controlReplies) {
      const localPostId = typeof reply.local_post_id === "string" ? reply.local_post_id : null;
      if (!localPostId) continue;

      if (typeof this.#store.getRemoteOutbox !== "function") {
        continue;
      }
      const outboxRec = this.#store.getRemoteOutbox(localPostId);
      if (!outboxRec || outboxRec.host_machine_id !== peerMachineId) {
        // 严格 fail-closed：未知记录或第三方伪造回执一律丢弃，绝不改写 outbox
        continue;
      }
      if (typeof reply.board_id === "string") {
        if (outboxRec.board_id && outboxRec.board_id !== reply.board_id) {
          continue;
        }
        if (typeof this.#store.getBoard === "function") {
          const localBoard = this.#store.getBoard(reply.board_id);
          if (localBoard && localBoard.host_machine_id !== peerMachineId) {
            continue;
          }
        }
      }

      const errorCode = typeof reply.error_code === "string" && reply.error_code ? reply.error_code : null;
      let targetStatus;
      if (reply.ok === true || reply.status === "acked") {
        targetStatus = "acked";
      } else if (reply.status === "rejected_archived" || errorCode === "board_archived") {
        targetStatus = "rejected_archived";
      } else if (reply.status === "rejected_deleted" || errorCode === "board_deleted" || errorCode === "board_not_found") {
        targetStatus = "rejected_deleted";
      } else if (PERMANENT_OUTBOX_ERROR_CODES.has(errorCode ?? "") || reply.status === "rejected") {
        targetStatus = "dead_letter";
      } else {
        targetStatus = "pending";
      }

      this.#updateOutbox(localPostId, {
        status: targetStatus,
        retry_count: targetStatus === "pending" ? 1 : 0,
        next_retry_at: targetStatus === "pending" ? nowMs + this.#computeBackoffMs(1) : 0,
        last_error_code: targetStatus === "acked" ? null : (errorCode ?? targetStatus),
      });
      updatedOutbox += 1;
    }

    return {
      ok: true,
      advanced_boards: advancedBoards,
      acked_files: ackedFiles,
      failed_files: failedFiles,
      acked_tombstones: ackedTombstones,
      updated_outbox: updatedOutbox,
    };
  }

  startSyncLoop({ syncIntervalMs, notifyIntervalMs } = {}) {
    this.#assertOpen();
    const effectiveSyncMs = syncIntervalMs === undefined
      ? this.#limits.defaultSyncIntervalMs
      : requireInteger(syncIntervalMs, "syncIntervalMs", 10, 3600000);
    const effectiveNotifyMs = notifyIntervalMs === undefined
      ? this.#limits.defaultNotifyIntervalMs
      : (notifyIntervalMs === null || notifyIntervalMs === 0
          ? 0
          : requireInteger(notifyIntervalMs, "notifyIntervalMs", 10, 3600000));

    if (this.#loopRunning) return;
    this.#loopRunning = true;

    const hasNotifyTimer = effectiveNotifyMs > 0
      && this.#engine
      && (typeof this.#engine.localNotifyTick === "function" || typeof this.#engine.runAutoArchiveSweep === "function");

    const scheduleSync = () => {
      if (!this.#loopRunning || this.#closed) return;
      this.#syncTimer = setTimeout(async () => {
        this.#syncTimer = null;
        if (!this.#loopRunning || this.#closed) return;
        try {
          if (!hasNotifyTimer && typeof this.#engine?.runAutoArchiveSweep === "function") {
            await this.#engine.runAutoArchiveSweep();
          }
          if (!this.#loopRunning || this.#closed) return;
          await this.syncTick({ signal: this.#lifecycleAbort.signal });
        } catch (error) {
          if (!this.#closed) this.#onError(error);
        } finally {
          scheduleSync();
        }
      }, effectiveSyncMs);
    };
    scheduleSync();

    if (hasNotifyTimer) {
      const scheduleNotify = () => {
        if (!this.#loopRunning || this.#closed) return;
        this.#notifyTimer = setTimeout(async () => {
          this.#notifyTimer = null;
          if (!this.#loopRunning || this.#closed) return;
          const runNotify = async () => {
            if (typeof this.#engine.runAutoArchiveSweep === "function") {
              await this.#engine.runAutoArchiveSweep();
            }
            if (!this.#loopRunning || this.#closed) return;
            if (typeof this.#engine.localNotifyTick === "function") {
              await this.#engine.localNotifyTick({ signal: this.#lifecycleAbort.signal });
            }
          };
          const promise = runNotify().catch(error => {
            if (!this.#closed) this.#onError(error);
          }).finally(() => {
            if (this.#notifyInFlight === promise) this.#notifyInFlight = null;
            scheduleNotify();
          });
          this.#notifyInFlight = promise;
          await promise;
        }, effectiveNotifyMs);
      };
      scheduleNotify();
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#loopRunning = false;

    if (this.#syncTimer !== null) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
    }
    if (this.#notifyTimer !== null) {
      clearTimeout(this.#notifyTimer);
      this.#notifyTimer = null;
    }

    if (!this.#lifecycleAbort.signal.aborted) {
      this.#lifecycleAbort.abort(new CoreError("coordinator_closed", "交流板同步协调器已关闭"));
    }

    const unregisters = this.#unregisterHandlers.splice(0, this.#unregisterHandlers.length);
    for (const unregister of unregisters) {
      try {
        unregister();
      } catch (error) {
        this.#onError(error);
      }
    }

    const inflight = [this.#syncInFlight, this.#notifyInFlight].filter(Boolean);
    if (inflight.length > 0) {
      await Promise.allSettled(inflight);
    }
  }
}

/**
 * 面向 live-runtime.mjs boards.open 契约的开箱即用工厂入口：
 * 接收 { localMachineId, privateRoot, superAdminIdentities, allowedUploadRoots, openStore, addressBookAdapter, relayDispatcher, peerMachineIds, peerMachines, fileBundlePeers, archiveSweepIntervalMs, ... }，
 * 返回 { store, engine, sync, invoke, start, close }（兼容纯本机无 relayDispatcher 与跨机带 relayDispatcher 两种模式）。
 */
export function openBoardRuntime({
  localMachineId,
  privateRoot,
  superAdminIdentities = [],
  allowedUploadRoots = [],
  openStore,
  addressBookAdapter = null,
  relayDispatcher = null,
  relaySender = null,
  peerMachineIds = undefined,
  peerMachines = undefined,
  fileBundlePeers = undefined,
  peerCapabilitiesProvider = null,
  notifyLocalMember = null,
  onBoardChanged = null,
  syncIntervalMs,
  notifyIntervalMs,
  archiveSweepIntervalMs = undefined,
  limits = {},
  storeLimits = {},
  engineLimits = {},
  now,
  onError = () => {},
} = {}) {
  if (typeof openStore !== "function") {
    throw new CoreError("invalid_config", "openBoardRuntime 需要提供 openStore 工厂函数");
  }

  // 时钟对齐：当调用方未直接传 now 时，自动复用 openStore(storeOptions => ...) 中的 storeOptions.now
  let capturedStoreNow = null;
  const store = openStore(storeOptions => {
    if (typeof storeOptions?.now === "function") {
      capturedStoreNow = storeOptions.now;
    }
    return new BoardStore({
      ...storeOptions,
      ...(privateRoot !== undefined ? { privateRoot } : {}),
      ...(allowedUploadRoots !== undefined ? { allowedUploadRoots } : {}),
      ...(typeof now === "function" ? { now } : {}),
      limits: storeLimits,
    });
  });

  const effectiveNow = typeof now === "function"
    ? now
    : (capturedStoreNow ?? (() => Date.now()));

  // 显式 peerMachineIds / peerMachines（含空数组 []！）严格 Fail-Closed，绝不从 relayDispatcher/store 自动扩权；
  // 仅当两者均为 undefined 时才从 relayDispatcher.listPeerPolicies() 自动派生
  const hasExplicitPeers = peerMachineIds !== undefined || peerMachines !== undefined;
  const explicitPeers = hasExplicitPeers
    ? normalizePeerCollection(peerMachineIds !== undefined ? peerMachineIds : peerMachines, localMachineId)
    : undefined;
  const explicitPeerSet = hasExplicitPeers ? new Set(explicitPeers) : null;

  let discoveredPeerMachines;
  if (!hasExplicitPeers && relayDispatcher && typeof relayDispatcher.listPeerPolicies === "function") {
    const policies = relayDispatcher.listPeerPolicies();
    if (isPlainObject(policies)) {
      discoveredPeerMachines = Object.entries(policies)
        .filter(([id, pol]) => id !== localMachineId && (!isPlainObject(pol) || pol.known !== false))
        .map(([id]) => id);
    } else if (Array.isArray(policies)) {
      discoveredPeerMachines = normalizePeerCollection(
        policies.map(item => (typeof item === "string" ? item : item?.machine_id)),
        localMachineId,
      );
    }
  }

  const hasExplicitFileBundlePeers = fileBundlePeers !== undefined;
  const explicitFileBundlePeerSet = hasExplicitFileBundlePeers
    ? new Set(normalizePeerCollection(fileBundlePeers, localMachineId))
    : null;

  const lookupBaseCapability = (provider, machineId) => {
    if (!provider) return null;
    if (typeof provider === "function") return provider(machineId) ?? null;
    if (provider instanceof Map) return provider.get(machineId) ?? null;
    if (isPlainObject(provider)) return Object.hasOwn(provider, machineId) ? provider[machineId] : null;
    return null;
  };

  let baseCapabilitiesProvider = peerCapabilitiesProvider ?? null;
  if (!baseCapabilitiesProvider && relayDispatcher && (
    typeof relayDispatcher.getPeerPolicy === "function"
    || typeof relayDispatcher.listPeerPolicies === "function"
  )) {
    baseCapabilitiesProvider = machineId => {
      if (typeof machineId !== "string" || !machineId || machineId === localMachineId) return null;
      if (typeof relayDispatcher.getPeerPolicy === "function") {
        const policy = relayDispatcher.getPeerPolicy(machineId);
        if (!isPlainObject(policy) || policy.known === false) return null;
        return {
          known: true,
          allow_file_bundle: policy.allow_file_bundle === true,
          ...(policy.reachable !== undefined ? { reachable: policy.reachable } : {}),
          ...(policy.reason !== undefined ? { reason: policy.reason } : {}),
        };
      }
      const allPolicies = relayDispatcher.listPeerPolicies?.();
      const matched = isPlainObject(allPolicies) ? allPolicies[machineId] : null;
      if (!isPlainObject(matched) || matched.known === false) return null;
      return {
        known: true,
        allow_file_bundle: matched.allow_file_bundle === true,
        ...(matched.reachable !== undefined ? { reachable: matched.reachable } : {}),
        ...(matched.reason !== undefined ? { reason: matched.reason } : {}),
      };
    };
  }

  const effectivePeerCapabilitiesProvider = (hasExplicitPeers || hasExplicitFileBundlePeers || baseCapabilitiesProvider)
    ? machineId => {
        if (typeof machineId !== "string" || !machineId || machineId === localMachineId) return null;
        if (explicitPeerSet && !explicitPeerSet.has(machineId)) return null;
        const baseCap = lookupBaseCapability(baseCapabilitiesProvider, machineId);
        if (baseCapabilitiesProvider && (!baseCap || baseCap.known === false)) {
          return null;
        }
        const allowedByBundleList = !explicitFileBundlePeerSet || explicitFileBundlePeerSet.has(machineId);
        const allowFileBundle = baseCap
          ? (baseCap.allow_file_bundle === true && allowedByBundleList)
          : (hasExplicitFileBundlePeers ? allowedByBundleList : false);
        return {
          known: true,
          ...(baseCap?.reachable !== undefined ? { reachable: baseCap.reachable } : {}),
          ...(baseCap?.reason !== undefined ? { reason: baseCap.reason } : {}),
          allow_file_bundle: allowFileBundle,
        };
      }
    : null;

  let sync = null;
  let started = false;
  let closed = false;

  const handleBoardChanged = event => {
    if (typeof onBoardChanged === "function") {
      try {
        onBoardChanged(event);
      } catch (error) {
        onError(error);
      }
    }
    // 高优手动解散即时触达同步，不干等 90s 周期
    if (event?.kind === "board_dissolved" && sync && started && !closed && !sync.closed) {
      Promise.resolve()
        .then(() => {
          if (!closed && sync && !sync.closed) {
            return sync.syncTick();
          }
          return undefined;
        })
        .catch(error => {
          if (!closed) onError(error);
        });
    }
  };

  const engine = new BoardEngine({
    store,
    localMachineId,
    addressBookAdapter,
    superAdminIdentities,
    peerCapabilitiesProvider: effectivePeerCapabilitiesProvider,
    notifyLocalMember,
    onBoardChanged: handleBoardChanged,
    limits: engineLimits,
    now: effectiveNow,
  });

  const hasSyncTransport = Boolean(relayDispatcher || relaySender);
  sync = hasSyncTransport
    ? new BoardSyncCoordinator({
        store,
        engine,
        localMachineId,
        dispatcher: relayDispatcher,
        relaySender,
        ...(hasExplicitPeers ? { peerMachineIds: explicitPeers } : { discoveredPeerMachines }),
        ...(hasExplicitFileBundlePeers ? { fileBundlePeers: [...explicitFileBundlePeerSet] } : {}),
        peerCapabilitiesProvider: effectivePeerCapabilitiesProvider,
        addressBookAdapter,
        limits,
        now: effectiveNow,
        onError,
      })
    : null;

  let localTimer = null;
  let localTickInFlight = null;
  const localAbort = new AbortController();

  async function start() {
    if (closed || started) return;
    started = true;
    if (typeof store.recoverInterruptedSyncState === "function") {
      store.recoverInterruptedSyncState();
    }
    if (typeof store.reconcilePendingFileOps === "function") {
      store.reconcilePendingFileOps();
    }
    if (sync) {
      if (typeof engine.runAutoArchiveSweep === "function") {
        await engine.runAutoArchiveSweep();
      }
      if (!closed) {
        sync.startSyncLoop({ syncIntervalMs, notifyIntervalMs });
      }
      return;
    }

    // 纯本机模式（无 relayDispatcher / relaySender）：
    // 启动立刻执行一次 31 天静默自动归档扫描，且只要周期不为 0 即启动定时器（无通知回调时完全静默归档、零唤醒）
    if (typeof engine.runAutoArchiveSweep === "function") {
      await engine.runAutoArchiveSweep();
    }
    if (closed || localAbort.signal.aborted) return;

    const defaultLocalIntervalMs = Number.isSafeInteger(limits?.defaultNotifyIntervalMs) && limits.defaultNotifyIntervalMs >= 10
      ? limits.defaultNotifyIntervalMs
      : BOARD_SYNC_LIMITS.defaultNotifyIntervalMs;
    const effectiveNotifyIntervalMs = notifyIntervalMs === undefined || notifyIntervalMs === null
      ? defaultLocalIntervalMs
      : (notifyIntervalMs === 0
          ? 0
          : requireInteger(notifyIntervalMs, "notifyIntervalMs", 10, 3600000));
    const effectiveArchiveSweepIntervalMs = archiveSweepIntervalMs === undefined || archiveSweepIntervalMs === null
      ? effectiveNotifyIntervalMs
      : (archiveSweepIntervalMs === 0
          ? 0
          : requireInteger(archiveSweepIntervalMs, "archiveSweepIntervalMs", 10, 3600000));
    const positiveIntervals = [effectiveArchiveSweepIntervalMs, typeof notifyLocalMember === "function" ? effectiveNotifyIntervalMs : 0]
      .filter(v => v > 0);
    const effectiveIntervalMs = positiveIntervals.length > 0 ? Math.min(...positiveIntervals) : 0;

    if (effectiveIntervalMs > 0) {
      let lastArchiveRunAt = effectiveNow();
      let lastNotifyRunAt = effectiveNow();
      const scheduleLocalTick = () => {
        if (closed || localAbort.signal.aborted) return;
        localTimer = setTimeout(async () => {
          localTimer = null;
          if (closed || localAbort.signal.aborted) return;
          const runLocalTick = async () => {
            const nowMs = effectiveNow();
            if (
              effectiveArchiveSweepIntervalMs > 0
              && typeof engine.runAutoArchiveSweep === "function"
              && (effectiveArchiveSweepIntervalMs === effectiveIntervalMs || nowMs - lastArchiveRunAt >= effectiveArchiveSweepIntervalMs)
            ) {
              lastArchiveRunAt = nowMs;
              await engine.runAutoArchiveSweep();
            }
            if (
              effectiveNotifyIntervalMs > 0
              && typeof notifyLocalMember === "function"
              && !closed
              && !localAbort.signal.aborted
              && (effectiveNotifyIntervalMs === effectiveIntervalMs || nowMs - lastNotifyRunAt >= effectiveNotifyIntervalMs)
            ) {
              lastNotifyRunAt = nowMs;
              await engine.localNotifyTick({ signal: localAbort.signal });
            }
          };
          const p = runLocalTick().catch(err => {
            if (!closed) onError(err);
          }).finally(() => {
            if (localTickInFlight === p) localTickInFlight = null;
            if (!closed && !localAbort.signal.aborted) scheduleLocalTick();
          });
          localTickInFlight = p;
          await p;
        }, effectiveIntervalMs);
      };
      scheduleLocalTick();
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (localTimer !== null) {
      clearTimeout(localTimer);
      localTimer = null;
    }
    if (!localAbort.signal.aborted) {
      localAbort.abort(new CoreError("runtime_closed", "交流板运行时已关闭"));
    }
    if (localTickInFlight) {
      await Promise.allSettled([localTickInFlight]);
    }
    if (sync) {
      await sync.close();
    }
    engine.close();
  }

  return {
    store,
    engine,
    sync,
    invoke: invocation => engine.invoke(invocation),
    start,
    close,
  };
}
