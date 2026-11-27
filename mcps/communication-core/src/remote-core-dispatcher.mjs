import { createHash, randomUUID } from "node:crypto";
import { CoreError, digest, requireInteger, requireText } from "./contracts.mjs";
import {
  RELAY_FRAME_START,
  RELAY_FRAME_END,
  ALLOWED_RELAY_OPS,
  cqEncodedLength as envelopeCqEncodedLength,
  computeBodySha256 as envelopeComputeBodySha256,
  encodeRelayFrame as envelopeEncodeRelayFrame,
  decodeRelayFrame as envelopeDecodeRelayFrame,
  parseEndpoint as envelopeParseEndpoint,
  formatEndpoint as envelopeFormatEndpoint,
} from "./relay-envelope.mjs";
import { RELAY_ERROR_CODE_MAP, mapRelayProviderErrorCode } from "./transports/napcat-relay.mjs";

export { RELAY_FRAME_START, RELAY_FRAME_END, ALLOWED_RELAY_OPS };

export const PROCESSING_RANK = Object.freeze({
  pending: 0,
  processing: 1,
  done: 2,
  failed: 2,
});

export const PERMANENT_OUTBOX_ERROR_CODES = Object.freeze(new Set([
  "relay_route_not_found",
  "relay_route_drain_expired",
  "relay_route_changed",
  "relay_recipient_disclosure_blocked",
  "relay_dedupe_conflict",
  "relay_frame_too_large",
  "invalid_input",
  "unsupported_op",
  "relay_file_route_denied",
  "relay_file_id_conflict",
  "relay_file_reply_route_unbound",
  "relay_bundle_too_large",
]));

export const DEFAULT_OUTBOX_LIMITS = Object.freeze({
  maxOutbox: 2048,
  maxOutboxBytes: 16 * 1024 * 1024,
  ttlMs: 24 * 60 * 60 * 1000,
  baseRetryMs: 1000,
  maxRetryMs: 60000,
});

export const DEFAULT_DISPATCHER_LIMITS = Object.freeze({
  maxPendingRequests: 512,
  maxProcessedCache: 4096,
  queryTimeoutMs: 12000,
  maxFrameChars: 1800,
  maxConcurrent: 4,
  pollIntervalMs: 1500,
  idlePollIntervalMs: 5000,
  bundleAckDeadlineMs: 5000,
  readLimit: 50,
  bundleReadLimit: 32,
  maxAttachments: 63,
  defaultSnapshotMaxChars: 1100,
});

export const DEFAULT_REMOTE_HOSTS = Object.freeze(["antigravity", "codex", "windsurf"]);

const TWO_PART_HOSTS = new Set(["antigravity", "codex", "windsurf"]);
const ENDPOINT_FORBIDDEN_RE = /[/,\s*\u0000-\u001f\u007f]/u;
const VALID_ACK_PROCESSING = new Set(["processing", "done", "failed"]);
const REPLY_OPS = new Set(["status_reply", "list_reply", "snapshot_reply"]);
const BUNDLE_DEGRADE_ERROR_CODES = new Set([
  "bundle_transport_unavailable",
  "relay_file_route_denied",
  "relay_file_integration_disabled",
  "relay_file_tool_unknown",
  "relay_file_route_unavailable",
]);
const HOST_SNAPSHOT_BODY_ROLES = new Set(["user", "assistant", "activity", "external"]);
const QUERY_REPLY_OP = Object.freeze({
  status_query: "status_reply",
  list_query: "list_reply",
  snapshot_query: "snapshot_reply",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLineEndings(text) {
  return String(text ?? "").replace(/\r\n|\r/gu, "\n");
}

export function cqEncodedLength(text) {
  return envelopeCqEncodedLength(String(text ?? ""));
}

export function computeBodySha256(body) {
  return envelopeComputeBodySha256(String(body ?? ""));
}

function validateEndpointSegment(segment, name) {
  if (typeof segment !== "string" || !segment || segment.length > 256 || ENDPOINT_FORBIDDEN_RE.test(segment)) {
    throw new CoreError("invalid_input", `${name}包含非法字符或为空`);
  }
  return segment;
}

function parseEndpoint(text) {
  return envelopeParseEndpoint(text);
}

function formatEndpoint(value, name = "endpoint") {
  if (typeof value === "string") {
    const parsed = parseEndpoint(value);
    return `${parsed.host}/${parsed.surface}/${parsed.conversation_id}`;
  }
  if (!isPlainObject(value)) {
    throw new CoreError("invalid_input", `${name}必须是对象或合法endpoint字符串`);
  }
  const host = validateEndpointSegment(value.host, `${name}.host`);
  if (value.surface === undefined && !TWO_PART_HOSTS.has(host)) {
    throw new CoreError("invalid_input", `宿主 ${host} 必须显式指定 surface，不可省略`);
  }
  return envelopeFormatEndpoint(value);
}

function safeEndpointOrSystem(value) {
  if (typeof value === "string") {
    try {
      return formatEndpoint(value, "endpoint");
    } catch {
      return "core/system/dispatcher";
    }
  }
  return "core/system/dispatcher";
}

function formatFullRecipientRef(value, defaultMachineId) {
  if (typeof value === "string") {
    requireText(value, "all_recipient", 640);
    const parts = value.split("/");
    if (parts.length === 4) {
      parts.forEach((part, idx) => validateEndpointSegment(part, `all_recipient[${idx}]`));
      return value;
    }
    const endpoint = formatEndpoint(value, "all_recipient");
    if (!defaultMachineId) throw new CoreError("invalid_input", "all_recipients 缺少 machine_id");
    validateEndpointSegment(defaultMachineId, "machine_id");
    return `${defaultMachineId}/${endpoint}`;
  }
  if (!isPlainObject(value)) {
    throw new CoreError("invalid_input", "all_recipients 项必须是字符串或对象");
  }
  const machineId = validateEndpointSegment(value.machine_id ?? defaultMachineId, "all_recipient.machine_id");
  const endpoint = formatEndpoint(value, "all_recipient");
  return `${machineId}/${endpoint}`;
}

function endpointFromTargetKey(targetKey) {
  try {
    const parsed = JSON.parse(targetKey);
    if (Array.isArray(parsed) && parsed.length === 4) {
      return formatEndpoint({ host: parsed[1], surface: parsed[2], conversation_id: parsed[3] }, "target_key");
    }
  } catch {
    // 回退系统端点
  }
  return "core/system/dispatcher";
}

function normalizeRelayErrorCode(error) {
  const raw = typeof error === "string"
    ? error
    : (typeof error?.code === "string" ? error.code : "relay_provider_error");
  if (Object.hasOwn(RELAY_ERROR_CODE_MAP, raw)) return mapRelayProviderErrorCode(raw);
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(raw)) return raw;
  const lowered = raw.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (/^[a-z][a-z0-9_]{0,63}$/u.test(lowered)) return lowered;
  return "relay_provider_error";
}

function extractRetryAfterMs(error) {
  const candidates = [
    error?.details?.retry_after_ms,
    error?.retry_after_ms,
    error?.details?.retryAfterMs,
  ];
  for (const value of candidates) {
    if (Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  return 0;
}

function isOutcomeUnknownResult(result) {
  return Boolean(
    result?.outcome_unknown === true
    || result?.outcomeUnknown === true
    || result?.status === "sent_unverified"
    || result?.transport_stage === "group_unverified",
  );
}

function isOutcomeUnknownError(error) {
  return Boolean(
    error?.outcomeUnknown === true
    || error?.outcome_unknown === true
    || error?.details?.outcome_unknown === true
    || error?.details?.outcomeUnknown === true,
  );
}

function normalizeNote(note) {
  if (note === undefined || note === null) return null;
  if (typeof note !== "string" || Buffer.byteLength(note, "utf8") > 1200) {
    throw new CoreError("invalid_input", "note必须是非空且不超过280字符和1200字节的文本");
  }
  const trimmed = note.trim();
  if (!trimmed || [...trimmed].length > 280) {
    throw new CoreError("invalid_input", "note必须是非空且不超过280字符和1200字节的文本");
  }
  return trimmed;
}

function extractTypedDenial(resultOrError, fallbackCode = "forbidden", fallbackMessage = "本机拒绝执行该跨机请求") {
  if (resultOrError instanceof CoreError) {
    return {
      code: normalizeRelayErrorCode(resultOrError.code || fallbackCode),
      message: typeof resultOrError.message === "string" && resultOrError.message.trim()
        ? resultOrError.message.trim().slice(0, 240)
        : fallbackMessage,
    };
  }
  if (isPlainObject(resultOrError) && resultOrError.ok === false) {
    const err = isPlainObject(resultOrError.error) ? resultOrError.error : resultOrError;
    return {
      code: normalizeRelayErrorCode(err.code || fallbackCode),
      message: typeof err.message === "string" && err.message.trim()
        ? err.message.trim().slice(0, 240)
        : fallbackMessage,
    };
  }
  return null;
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * 判定跨机 processing_ack 状态偏序是否应被接受。
 * 偏序：pending(0) < processing(1) < done(2) | failed(2)。
 * 终态不可回退亦不可被覆盖；同阶 processing -> processing 仅在 ack_seq 严格递增时允许更新 note。
 */
export function shouldAcceptProcessingUpdate(current, incoming) {
  const curObj = typeof current === "string" ? { processing: current } : (isPlainObject(current) ? current : {});
  const inObj = typeof incoming === "string" ? { processing: incoming } : (isPlainObject(incoming) ? incoming : {});

  const curState = curObj.processing ?? "pending";
  const inState = inObj.processing;
  if (!Object.hasOwn(PROCESSING_RANK, curState) || !Object.hasOwn(PROCESSING_RANK, inState)) {
    return false;
  }

  const curRank = PROCESSING_RANK[curState];
  const inRank = PROCESSING_RANK[inState];

  if (curRank >= PROCESSING_RANK.done) return false;
  if (inRank < curRank) return false;

  const hasCurSeq = Number.isSafeInteger(curObj.ack_seq) && curObj.ack_seq >= 0;
  const hasInSeq = Number.isSafeInteger(inObj.ack_seq) && inObj.ack_seq > 0;

  if (inRank > curRank) {
    if (hasCurSeq && curObj.ack_seq > 0 && hasInSeq && inObj.ack_seq <= curObj.ack_seq) {
      return false;
    }
    return true;
  }

  if (curState === "processing" && inState === "processing") {
    if (!hasInSeq) return false;
    const baseSeq = hasCurSeq ? curObj.ack_seq : 0;
    return inObj.ack_seq > baseSeq;
  }

  return false;
}

export class RelayOutboxStore {
  #database;
  #transaction;
  #maxOutbox;
  #maxOutboxBytes;
  #ttlMs;
  #baseRetryMs;
  #maxRetryMs;
  #now;
  #inboundMap;
  #outboxMap;
  #outboxEntryBytes;
  #outboxBytes = 0;
  #maxInboundMappings;
  #savepointSeq = 0;

  constructor({
    database = null,
    transaction = null,
    maxOutbox = DEFAULT_OUTBOX_LIMITS.maxOutbox,
    maxOutboxBytes = DEFAULT_OUTBOX_LIMITS.maxOutboxBytes,
    ttlMs = DEFAULT_OUTBOX_LIMITS.ttlMs,
    baseRetryMs = DEFAULT_OUTBOX_LIMITS.baseRetryMs,
    maxRetryMs = DEFAULT_OUTBOX_LIMITS.maxRetryMs,
    now = () => Date.now(),
  } = {}) {
    if (typeof now !== "function") throw new CoreError("invalid_input", "now必须是函数");
    if (transaction !== null && transaction !== undefined && typeof transaction !== "function") {
      throw new CoreError("invalid_input", "transaction必须是同步回调封装函数");
    }
    this.#maxOutbox = requireInteger(maxOutbox, "maxOutbox", 1, 100000);
    this.#maxOutboxBytes = requireInteger(maxOutboxBytes, "maxOutboxBytes", 1024, 512 * 1024 * 1024);
    this.#ttlMs = requireInteger(ttlMs, "ttlMs", 1000, 30 * 24 * 60 * 60 * 1000);
    this.#baseRetryMs = requireInteger(baseRetryMs, "baseRetryMs", 1, 60000);
    this.#maxRetryMs = requireInteger(maxRetryMs, "maxRetryMs", this.#baseRetryMs, 3600000);
    this.#now = now;
    this.#database = database ?? null;
    this.#transaction = transaction ?? null;

    this.#maxInboundMappings = Math.max(this.#maxOutbox * 2, 4096);
    if (this.#database) {
      this.#initTables();
    } else {
      this.#inboundMap = new Map();
      this.#outboxMap = new Map();
      this.#outboxEntryBytes = new Map();
      this.#outboxBytes = 0;
    }
  }

  #initTables() {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS relay_dispatcher_inbound_map (
        local_message_id TEXT PRIMARY KEY NOT NULL,
        origin_relay_id TEXT NOT NULL,
        origin_message_id TEXT NOT NULL,
        from_machine TEXT NOT NULL,
        reply_relay_key TEXT NOT NULL,
        reply_group_id TEXT NOT NULL,
        reply_route_generation INTEGER NOT NULL CHECK (reply_route_generation >= 1),
        target_key TEXT NOT NULL,
        source_endpoint TEXT NOT NULL DEFAULT '',
        origin_source_endpoint TEXT NOT NULL DEFAULT '',
        ack_seq INTEGER NOT NULL DEFAULT 0 CHECK (ack_seq >= 0),
        last_processing TEXT NOT NULL DEFAULT 'pending' CHECK (last_processing IN ('pending', 'processing', 'done', 'failed')),
        last_note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relay_dispatcher_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        local_message_id TEXT NOT NULL,
        origin_relay_id TEXT NOT NULL,
        origin_message_id TEXT NOT NULL,
        from_machine TEXT NOT NULL,
        reply_relay_key TEXT NOT NULL,
        reply_group_id TEXT NOT NULL,
        reply_route_generation INTEGER NOT NULL CHECK (reply_route_generation >= 1),
        target_key TEXT NOT NULL,
        source_endpoint TEXT NOT NULL DEFAULT '',
        origin_source_endpoint TEXT NOT NULL DEFAULT '',
        ack_seq INTEGER NOT NULL CHECK (ack_seq >= 1),
        processing TEXT NOT NULL CHECK (processing IN ('processing', 'done', 'failed')),
        note TEXT,
        reply_message_id TEXT,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'unknown', 'sent', 'dead_letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL,
        last_error_code TEXT,
        evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE (local_message_id, ack_seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_relay_dispatcher_outbox_due ON relay_dispatcher_outbox (status, next_attempt_at, created_at, ack_seq);
      CREATE INDEX IF NOT EXISTS idx_relay_dispatcher_outbox_expires ON relay_dispatcher_outbox (status, expires_at);
    `);
  }

  #runAtomic(fn) {
    if (this.#transaction) {
      const result = this.#transaction(fn);
      if (result && typeof result.then === "function") {
        throw new CoreError("invalid_state", "外部事务回调必须是纯同步函数，禁止返回Promise");
      }
      return result;
    }
    if (!this.#database) return fn();
    const sp = `relay_dispatcher_outbox_sp_${++this.#savepointSeq}`;
    this.#database.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      this.#database.exec(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (error) {
      try {
        this.#database.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        this.#database.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // 保持原始错误抛出
      }
      throw error;
    }
  }

  #rowToMapping(row) {
    if (!row) return null;
    return {
      local_message_id: row.local_message_id,
      origin_relay_id: row.origin_relay_id,
      origin_message_id: row.origin_message_id,
      from_machine: row.from_machine,
      reply_relay_key: row.reply_relay_key,
      reply_group_id: row.reply_group_id,
      reply_route_generation: row.reply_route_generation,
      target_key: row.target_key,
      source_endpoint: row.source_endpoint ?? "",
      origin_source_endpoint: row.origin_source_endpoint ?? "",
      ack_seq: row.ack_seq,
      last_processing: row.last_processing,
      last_note: row.last_note ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  #rowToOutbox(row) {
    if (!row) return null;
    return {
      id: row.id,
      local_message_id: row.local_message_id,
      origin_relay_id: row.origin_relay_id,
      origin_message_id: row.origin_message_id,
      from_machine: row.from_machine,
      reply_relay_key: row.reply_relay_key,
      reply_group_id: row.reply_group_id,
      reply_route_generation: row.reply_route_generation,
      target_key: row.target_key,
      source_endpoint: row.source_endpoint ?? "",
      origin_source_endpoint: row.origin_source_endpoint ?? "",
      ack_seq: row.ack_seq,
      processing: row.processing,
      note: row.note ?? null,
      reply_message_id: row.reply_message_id ?? null,
      dedupe_key: row.dedupe_key,
      status: row.status,
      outcome_unknown: row.status === "unknown",
      retryable: row.status === "pending",
      attempt_count: row.attempt_count,
      next_attempt_at: row.next_attempt_at,
      last_error_code: row.last_error_code ?? null,
      evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
    };
  }

  recordInboundMapping(input) {
    if (!isPlainObject(input)) throw new CoreError("invalid_input", "入站映射必须是对象");
    const localMessageId = requireText(input.local_message_id, "local_message_id", 256);
    const originRelayId = requireText(input.origin_relay_id, "origin_relay_id", 256);
    const originMessageId = requireText(input.origin_message_id, "origin_message_id", 256);
    const fromMachine = requireText(input.from_machine, "from_machine", 128);
    const replyRelayKey = requireText(input.reply_relay_key, "reply_relay_key", 256);
    const replyGroupId = requireText(String(input.reply_group_id ?? ""), "reply_group_id", 128);
    const replyRouteGeneration = requireInteger(input.reply_route_generation, "reply_route_generation", 1);
    const targetKey = requireText(input.target_key, "target_key", 1024);
    const sourceEndpoint = input.source_endpoint ? formatEndpoint(input.source_endpoint, "source_endpoint") : "";
    const originSourceEndpoint = input.origin_source_endpoint
      ? formatEndpoint(input.origin_source_endpoint, "origin_source_endpoint")
      : "";
    const nowMs = input.nowMs === undefined ? this.#now() : requireInteger(input.nowMs, "nowMs", 0);

    return this.#runAtomic(() => {
      const existing = this.getInboundMapping(localMessageId);
      if (existing) {
        const same = existing.origin_relay_id === originRelayId
          && existing.origin_message_id === originMessageId
          && existing.from_machine === fromMachine
          && existing.reply_relay_key === replyRelayKey
          && existing.reply_group_id === replyGroupId
          && existing.reply_route_generation === replyRouteGeneration
          && existing.target_key === targetKey;
        if (!same) {
          throw new CoreError("relay_route_changed", "已登记入站消息的原路回执路由不可修改", {
            local_message_id: localMessageId,
          });
        }
        return existing;
      }

      const record = {
        local_message_id: localMessageId,
        origin_relay_id: originRelayId,
        origin_message_id: originMessageId,
        from_machine: fromMachine,
        reply_relay_key: replyRelayKey,
        reply_group_id: replyGroupId,
        reply_route_generation: replyRouteGeneration,
        target_key: targetKey,
        source_endpoint: sourceEndpoint,
        origin_source_endpoint: originSourceEndpoint,
        ack_seq: 0,
        last_processing: "pending",
        last_note: null,
        created_at: nowMs,
        updated_at: nowMs,
      };

      if (this.#database) {
        this.#database.prepare(`
          INSERT INTO relay_dispatcher_inbound_map (
            local_message_id, origin_relay_id, origin_message_id, from_machine,
            reply_relay_key, reply_group_id, reply_route_generation, target_key,
            source_endpoint, origin_source_endpoint, ack_seq, last_processing,
            last_note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, ?)
        `).run(
          record.local_message_id,
          record.origin_relay_id,
          record.origin_message_id,
          record.from_machine,
          record.reply_relay_key,
          record.reply_group_id,
          record.reply_route_generation,
          record.target_key,
          record.source_endpoint,
          record.origin_source_endpoint,
          record.created_at,
          record.updated_at,
        );
      } else {
        this.#inboundMap.set(localMessageId, record);
        if (this.#inboundMap.size > this.#maxInboundMappings) {
          for (const [oldId, oldRec] of this.#inboundMap.entries()) {
            if (oldId !== localMessageId && (oldRec.last_processing === "done" || oldRec.last_processing === "failed")) {
              this.#inboundMap.delete(oldId);
              if (this.#inboundMap.size <= this.#maxInboundMappings) break;
            }
          }
        }
      }
      return cloneJson(record);
    });
  }

  getInboundMapping(localMessageId) {
    requireText(localMessageId, "local_message_id", 256);
    if (this.#database) {
      const row = this.#database.prepare(
        "SELECT * FROM relay_dispatcher_inbound_map WHERE local_message_id = ?",
      ).get(localMessageId);
      return this.#rowToMapping(row);
    }
    const found = this.#inboundMap.get(localMessageId);
    return found ? cloneJson(found) : null;
  }

  enqueueAck(input) {
    if (!isPlainObject(input)) throw new CoreError("invalid_input", "入队ACK参数必须是对象");
    const localMessageId = requireText(input.local_message_id, "local_message_id", 256);
    const processing = requireText(input.processing, "processing", 32);
    if (!VALID_ACK_PROCESSING.has(processing)) {
      throw new CoreError("invalid_input", "processing必须是processing、done或failed");
    }
    const note = normalizeNote(input.note);
    const replyMessageId = input.reply_message_id === undefined || input.reply_message_id === null
      ? null
      : requireText(input.reply_message_id, "reply_message_id", 256);
    const nowMs = input.nowMs === undefined ? this.#now() : requireInteger(input.nowMs, "nowMs", 0);

    return this.#runAtomic(() => {
      const mapping = this.getInboundMapping(localMessageId);
      if (!mapping) return null;

      if (PROCESSING_RANK[mapping.last_processing] >= PROCESSING_RANK.done) {
        if (mapping.last_processing !== processing) {
          throw new CoreError("processing_conflict", "原入站消息已达到终态，不能变更处理回执状态", {
            local_message_id: localMessageId,
            current_processing: mapping.last_processing,
            requested_processing: processing,
          });
        }
        return this.#getLatestOutboxForMessage(localMessageId);
      }

      this.#deleteExpiredTerminals(nowMs);
      const usage = this.#measureOutboxUsage();
      const ackSeq = mapping.ack_seq + 1;
      const id = `obx_${digest({ localMessageId, ackSeq, originRelayId: mapping.origin_relay_id }).slice(0, 24)}`;
      const dedupeKey = `rack:${digest({ localMessageId, ackSeq, originRelayId: mapping.origin_relay_id }).slice(0, 28)}`;

      const entry = {
        id,
        local_message_id: localMessageId,
        origin_relay_id: mapping.origin_relay_id,
        origin_message_id: mapping.origin_message_id,
        from_machine: mapping.from_machine,
        reply_relay_key: mapping.reply_relay_key,
        reply_group_id: mapping.reply_group_id,
        reply_route_generation: mapping.reply_route_generation,
        target_key: mapping.target_key,
        source_endpoint: mapping.source_endpoint,
        origin_source_endpoint: mapping.origin_source_endpoint,
        ack_seq: ackSeq,
        processing,
        note,
        reply_message_id: replyMessageId,
        dedupe_key: dedupeKey,
        status: "pending",
        outcome_unknown: false,
        retryable: true,
        attempt_count: 0,
        next_attempt_at: nowMs,
        last_error_code: null,
        evidence: null,
        created_at: nowMs,
        updated_at: nowMs,
        expires_at: nowMs + this.#ttlMs,
      };

      const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (usage.count >= this.#maxOutbox || usage.bytes + entryBytes > this.#maxOutboxBytes) {
        throw new CoreError("relay_outbox_full", "跨机ACK外发队列已达到容量上限", {
          max_outbox: this.#maxOutbox,
          current_count: usage.count,
          max_outbox_bytes: this.#maxOutboxBytes,
          current_bytes: usage.bytes,
        });
      }

      if (this.#database) {
        this.#database.prepare(`
          INSERT INTO relay_dispatcher_outbox (
            id, local_message_id, origin_relay_id, origin_message_id, from_machine,
            reply_relay_key, reply_group_id, reply_route_generation, target_key,
            source_endpoint, origin_source_endpoint, ack_seq, processing, note,
            reply_message_id, dedupe_key, status, attempt_count, next_attempt_at,
            last_error_code, evidence_json, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?, ?)
        `).run(
          entry.id,
          entry.local_message_id,
          entry.origin_relay_id,
          entry.origin_message_id,
          entry.from_machine,
          entry.reply_relay_key,
          entry.reply_group_id,
          entry.reply_route_generation,
          entry.target_key,
          entry.source_endpoint,
          entry.origin_source_endpoint,
          entry.ack_seq,
          entry.processing,
          entry.note,
          entry.reply_message_id,
          entry.dedupe_key,
          entry.next_attempt_at,
          entry.created_at,
          entry.updated_at,
          entry.expires_at,
        );
        this.#database.prepare(`
          UPDATE relay_dispatcher_inbound_map
          SET ack_seq = ?, last_processing = ?, last_note = ?, updated_at = ?
          WHERE local_message_id = ?
        `).run(ackSeq, processing, note, nowMs, localMessageId);
      } else {
        this.#setMemoryOutbox(entry.id, entry, entryBytes);
        const liveMapping = this.#inboundMap.get(localMessageId);
        liveMapping.ack_seq = ackSeq;
        liveMapping.last_processing = processing;
        liveMapping.last_note = note;
        liveMapping.updated_at = nowMs;
      }
      return cloneJson(entry);
    });
  }

  #getLatestOutboxForMessage(localMessageId) {
    if (this.#database) {
      const row = this.#database.prepare(
        "SELECT * FROM relay_dispatcher_outbox WHERE local_message_id = ? ORDER BY ack_seq DESC LIMIT 1",
      ).get(localMessageId);
      return this.#rowToOutbox(row);
    }
    let latest = null;
    for (const item of this.#outboxMap.values()) {
      if (item.local_message_id === localMessageId && (!latest || item.ack_seq > latest.ack_seq)) {
        latest = item;
      }
    }
    return latest ? cloneJson(latest) : null;
  }

  #deleteExpiredTerminals(nowMs) {
    if (this.#database) {
      const result = this.#database.prepare(
        "DELETE FROM relay_dispatcher_outbox WHERE status IN ('sent', 'dead_letter') AND expires_at <= ?",
      ).run(nowMs);
      return result.changes;
    }
    let deleted = 0;
    for (const [id, entry] of this.#outboxMap.entries()) {
      if ((entry.status === "sent" || entry.status === "dead_letter") && entry.expires_at <= nowMs) {
        this.#deleteMemoryOutbox(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  #measureOutboxUsage() {
    if (this.#database) {
      const row = this.#database.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(
                 length(CAST(id AS BLOB)) + length(CAST(local_message_id AS BLOB))
                 + length(CAST(origin_relay_id AS BLOB)) + length(CAST(origin_message_id AS BLOB))
                 + length(CAST(target_key AS BLOB)) + length(CAST(dedupe_key AS BLOB))
                 + COALESCE(length(CAST(note AS BLOB)), 0)
                 + COALESCE(length(CAST(evidence_json AS BLOB)), 0) + 128
               ), 0) AS bytes
        FROM relay_dispatcher_outbox
      `).get();
      return { count: Number(row.total), bytes: Number(row.bytes) };
    }
    return { count: this.#outboxMap.size, bytes: this.#outboxBytes };
  }

  #listByStatusDue(status, nowMs, limit) {
    const at = requireInteger(nowMs, "nowMs", 0);
    const maxItems = requireInteger(limit, "limit", 1, 2048);
    if (this.#database) {
      const rows = this.#database.prepare(`
        SELECT * FROM relay_dispatcher_outbox
        WHERE status = ? AND next_attempt_at <= ? AND expires_at > ?
        ORDER BY next_attempt_at ASC, created_at ASC, ack_seq ASC
        LIMIT ?
      `).all(status, at, at, maxItems);
      return rows.map(row => this.#rowToOutbox(row));
    }
    const items = [];
    for (const entry of this.#outboxMap.values()) {
      if (entry.status === status && entry.next_attempt_at <= at && entry.expires_at > at) {
        items.push(entry);
      }
    }
    items.sort((a, b) => (a.next_attempt_at - b.next_attempt_at)
      || (a.created_at - b.created_at)
      || (a.ack_seq - b.ack_seq));
    return items.slice(0, maxItems).map(item => cloneJson(item));
  }

  listDueOutbox(nowMs = this.#now(), limit = 32) {
    return this.#listByStatusDue("pending", nowMs, limit);
  }

  listUnknownOutbox(nowMs = this.#now(), limit = 32) {
    return this.#listByStatusDue("unknown", nowMs, limit);
  }

  getOutboxEntry(id) {
    requireText(id, "id", 128);
    if (this.#database) {
      const row = this.#database.prepare("SELECT * FROM relay_dispatcher_outbox WHERE id = ?").get(id);
      return this.#rowToOutbox(row);
    }
    const found = this.#outboxMap.get(id);
    return found ? cloneJson(found) : null;
  }

  listOutbox({ status, local_message_id: localMessageId, limit = 100 } = {}) {
    const maxItems = requireInteger(limit, "limit", 1, 2048);
    if (this.#database) {
      const clauses = [];
      const params = [];
      if (status !== undefined) {
        clauses.push("status = ?");
        params.push(requireText(status, "status", 32));
      }
      if (localMessageId !== undefined) {
        clauses.push("local_message_id = ?");
        params.push(requireText(localMessageId, "local_message_id", 256));
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(maxItems);
      return this.#database.prepare(
        `SELECT * FROM relay_dispatcher_outbox ${where} ORDER BY created_at ASC, ack_seq ASC LIMIT ?`,
      ).all(...params).map(row => this.#rowToOutbox(row));
    }
    const out = [];
    for (const entry of this.#outboxMap.values()) {
      if (status !== undefined && entry.status !== status) continue;
      if (localMessageId !== undefined && entry.local_message_id !== localMessageId) continue;
      out.push(entry);
    }
    out.sort((a, b) => (a.created_at - b.created_at) || (a.ack_seq - b.ack_seq));
    return out.slice(0, maxItems).map(item => cloneJson(item));
  }

  claimOutbox(id, nowMs = this.#now()) {
    requireText(id, "id", 128);
    const at = requireInteger(nowMs, "nowMs", 0);
    return this.#runAtomic(() => {
      if (this.#database) {
        const res = this.#database.prepare(`
          UPDATE relay_dispatcher_outbox
          SET status = 'dispatching', updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(at, id);
        if (res.changes !== 1) return null;
        return this.getOutboxEntry(id);
      }
      const live = this.#outboxMap.get(id);
      if (!live || live.status !== "pending") return null;
      live.status = "dispatching";
      live.outcome_unknown = false;
      live.retryable = false;
      live.updated_at = at;
      this.#setMemoryOutbox(id, live);
      return cloneJson(live);
    });
  }

  markOutboxSent(id, evidence = null, nowMs = this.#now()) {
    requireText(id, "id", 128);
    const at = requireInteger(nowMs, "nowMs", 0);
    const evidenceJson = evidence === null || evidence === undefined ? null : JSON.stringify(evidence);
    const expiresAt = at + this.#ttlMs;

    return this.#runAtomic(() => {
      const existing = this.getOutboxEntry(id);
      if (!existing) return null;
      if (this.#database) {
        this.#database.prepare(`
          UPDATE relay_dispatcher_outbox
          SET status = 'sent', evidence_json = ?, last_error_code = NULL, updated_at = ?, expires_at = ?
          WHERE id = ?
        `).run(evidenceJson, at, expiresAt, id);
        return this.getOutboxEntry(id);
      }
      const live = this.#outboxMap.get(id);
      live.status = "sent";
      live.outcome_unknown = false;
      live.retryable = false;
      live.evidence = evidenceJson ? JSON.parse(evidenceJson) : null;
      live.last_error_code = null;
      live.updated_at = at;
      live.expires_at = expiresAt;
      this.#setMemoryOutbox(id, live);
      return cloneJson(live);
    });
  }

  /**
   * 标记发送结果未知（如网络超时或 sent_unverified）：
   * 严禁更换 dedupe_key 盲重发，保留原 dedupe_key 与原 relay_id 证据供后续按原次查证。
   */
  markOutboxUnknown(id, evidence = null, nowMs = this.#now()) {
    requireText(id, "id", 128);
    const at = requireInteger(nowMs, "nowMs", 0);

    return this.#runAtomic(() => {
      const existing = this.getOutboxEntry(id);
      if (!existing) return null;
      if (existing.status === "sent" || existing.status === "dead_letter") return existing;

      const attemptCount = existing.attempt_count + 1;
      const mergedEvidence = {
        ...(isPlainObject(existing.evidence) ? existing.evidence : {}),
        ...(isPlainObject(evidence) ? evidence : (evidence !== null && evidence !== undefined ? { detail: evidence } : {})),
        dedupe_key: existing.dedupe_key,
        outcome_unknown: true,
      };
      const errorCode = normalizeRelayErrorCode(mergedEvidence.error_code ?? mergedEvidence.code ?? "relay_outcome_unknown");
      const expired = at >= existing.expires_at || (at - existing.created_at) >= this.#ttlMs;

      if (expired) {
        const nextExpires = at + this.#ttlMs;
        const evidenceJson = JSON.stringify(mergedEvidence);
        if (this.#database) {
          this.#database.prepare(`
            UPDATE relay_dispatcher_outbox
            SET status = 'dead_letter', attempt_count = ?, last_error_code = ?, evidence_json = ?, updated_at = ?, expires_at = ?
            WHERE id = ?
          `).run(attemptCount, errorCode, evidenceJson, at, nextExpires, id);
          return this.getOutboxEntry(id);
        }
        const live = this.#outboxMap.get(id);
        live.status = "dead_letter";
        live.outcome_unknown = false;
        live.retryable = false;
        live.attempt_count = attemptCount;
        live.last_error_code = errorCode;
        live.evidence = mergedEvidence;
        live.updated_at = at;
        live.expires_at = nextExpires;
        this.#setMemoryOutbox(id, live);
        return cloneJson(live);
      }

      const hintedDelay = extractRetryAfterMs(mergedEvidence);
      const expDelay = Math.min(this.#maxRetryMs, this.#baseRetryMs * (2 ** Math.min(10, attemptCount - 1)));
      const delay = Math.max(expDelay, hintedDelay);
      const nextAttemptAt = at + delay;
      const evidenceJson = JSON.stringify(mergedEvidence);

      if (this.#database) {
        this.#database.prepare(`
          UPDATE relay_dispatcher_outbox
          SET status = 'unknown', attempt_count = ?, next_attempt_at = ?, last_error_code = ?, evidence_json = ?, updated_at = ?
          WHERE id = ?
        `).run(attemptCount, nextAttemptAt, errorCode, evidenceJson, at, id);
        return this.getOutboxEntry(id);
      }
      const live = this.#outboxMap.get(id);
      live.status = "unknown";
      live.outcome_unknown = true;
      live.retryable = false;
      live.attempt_count = attemptCount;
      live.next_attempt_at = nextAttemptAt;
      live.last_error_code = errorCode;
      live.evidence = mergedEvidence;
      live.updated_at = at;
      this.#setMemoryOutbox(id, live);
      return cloneJson(live);
    });
  }

  markOutboxRetry(id, errorCode, retryAfterMs = 0, nowMs = this.#now(), { confirmedNotSent = false } = {}) {
    requireText(id, "id", 128);
    const normalizedCode = normalizeRelayErrorCode(errorCode);
    const at = requireInteger(nowMs, "nowMs", 0);
    const hintedDelay = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.ceil(retryAfterMs) : 0;

    return this.#runAtomic(() => {
      const existing = this.getOutboxEntry(id);
      if (!existing) return null;
      if (existing.status === "sent" || existing.status === "dead_letter") return existing;

      // 结果未知记录仅在永久拒绝、超时或查证确认原次未发出时才退出 unknown 态
      if (existing.status === "unknown" && !confirmedNotSent && !PERMANENT_OUTBOX_ERROR_CODES.has(normalizedCode)) {
        const expiredUnknown = at >= existing.expires_at || (at - existing.created_at) >= this.#ttlMs;
        if (!expiredUnknown) {
          return this.markOutboxUnknown(id, {
            error_code: normalizedCode,
            ...(hintedDelay > 0 ? { retry_after_ms: hintedDelay } : {}),
          }, at);
        }
      }

      const attemptCount = existing.attempt_count + 1;
      const expired = at >= existing.expires_at || (at - existing.created_at) >= this.#ttlMs;
      const permanent = PERMANENT_OUTBOX_ERROR_CODES.has(normalizedCode);

      if (permanent || expired) {
        const nextExpires = at + this.#ttlMs;
        if (this.#database) {
          this.#database.prepare(`
            UPDATE relay_dispatcher_outbox
            SET status = 'dead_letter', attempt_count = ?, last_error_code = ?, updated_at = ?, expires_at = ?
            WHERE id = ?
          `).run(attemptCount, normalizedCode, at, nextExpires, id);
          return this.getOutboxEntry(id);
        }
        const live = this.#outboxMap.get(id);
        live.status = "dead_letter";
        live.outcome_unknown = false;
        live.retryable = false;
        live.attempt_count = attemptCount;
        live.last_error_code = normalizedCode;
        live.updated_at = at;
        live.expires_at = nextExpires;
        this.#setMemoryOutbox(id, live);
        return cloneJson(live);
      }

      const expDelay = Math.min(this.#maxRetryMs, this.#baseRetryMs * (2 ** Math.min(10, attemptCount - 1)));
      const delay = Math.max(expDelay, hintedDelay);
      const nextAttemptAt = at + delay;

      if (this.#database) {
        this.#database.prepare(`
          UPDATE relay_dispatcher_outbox
          SET status = 'pending', attempt_count = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
          WHERE id = ?
        `).run(attemptCount, nextAttemptAt, normalizedCode, at, id);
        return this.getOutboxEntry(id);
      }
      const live = this.#outboxMap.get(id);
      live.status = "pending";
      live.outcome_unknown = false;
      live.retryable = true;
      live.attempt_count = attemptCount;
      live.next_attempt_at = nextAttemptAt;
      live.last_error_code = normalizedCode;
      live.updated_at = at;
      this.#setMemoryOutbox(id, live);
      return cloneJson(live);
    });
  }

  pruneExpired(nowMs = this.#now()) {
    const at = requireInteger(nowMs, "nowMs", 0);
    return this.#runAtomic(() => {
      let deadLettered = 0;
      const terminalExpires = at + this.#ttlMs;
      if (this.#database) {
        const res = this.#database.prepare(`
          UPDATE relay_dispatcher_outbox
          SET status = 'dead_letter',
              last_error_code = COALESCE(last_error_code, 'relay_outbox_expired'),
              updated_at = ?,
              expires_at = ?
          WHERE status IN ('pending', 'unknown') AND expires_at <= ?
        `).run(at, terminalExpires, at);
        deadLettered = res.changes;
      } else {
        for (const entry of this.#outboxMap.values()) {
          if ((entry.status === "pending" || entry.status === "unknown") && entry.expires_at <= at) {
            entry.status = "dead_letter";
            entry.outcome_unknown = false;
            entry.retryable = false;
            entry.last_error_code = entry.last_error_code ?? "relay_outbox_expired";
            entry.updated_at = at;
            entry.expires_at = terminalExpires;
            deadLettered += 1;
          }
        }
      }
      const deleted = this.#deleteExpiredTerminals(at);
      const inboundCutoff = at - this.#ttlMs;
      if (this.#database) {
        this.#database.prepare(`
          DELETE FROM relay_dispatcher_inbound_map
          WHERE last_processing IN ('done', 'failed')
            AND updated_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM relay_dispatcher_outbox o
              WHERE o.local_message_id = relay_dispatcher_inbound_map.local_message_id
                AND o.status IN ('pending', 'dispatching', 'unknown')
            )
        `).run(inboundCutoff);
      } else {
        for (const [msgId, rec] of this.#inboundMap.entries()) {
          if ((rec.last_processing === "done" || rec.last_processing === "failed") && rec.updated_at <= inboundCutoff) {
            let hasActive = false;
            for (const o of this.#outboxMap.values()) {
              if (o.local_message_id === msgId && (o.status === "pending" || o.status === "dispatching" || o.status === "unknown")) {
                hasActive = true;
                break;
              }
            }
            if (!hasActive) this.#inboundMap.delete(msgId);
          }
        }
      }
      return { dead_lettered: deadLettered, deleted };
    });
  }

  #setMemoryOutbox(id, entry, knownBytes = null) {
    const prev = this.#outboxEntryBytes.get(id) ?? 0;
    const nextBytes = knownBytes ?? Buffer.byteLength(JSON.stringify(entry), "utf8");
    this.#outboxMap.set(id, entry);
    this.#outboxEntryBytes.set(id, nextBytes);
    this.#outboxBytes = Math.max(0, this.#outboxBytes - prev + nextBytes);
  }

  #deleteMemoryOutbox(id) {
    const prev = this.#outboxEntryBytes.get(id) ?? 0;
    this.#outboxMap.delete(id);
    this.#outboxEntryBytes.delete(id);
    this.#outboxBytes = Math.max(0, this.#outboxBytes - prev);
  }

  recoverInterrupted(nowMs = this.#now()) {
    const at = requireInteger(nowMs, "nowMs", 0);
    return this.#runAtomic(() => {
      if (this.#database) {
        return this.#database.prepare(
          "UPDATE relay_dispatcher_outbox SET status = 'unknown', updated_at = ? WHERE status = 'dispatching'",
        ).run(at).changes;
      }
      let changed = 0;
      for (const entry of this.#outboxMap.values()) {
        if (entry.status === "dispatching") {
          entry.status = "unknown";
          entry.outcome_unknown = true;
          entry.updated_at = at;
          changed += 1;
        }
      }
      return changed;
    });
  }

  stats() {
    if (this.#database) {
      const mappingRow = this.#database.prepare("SELECT COUNT(*) AS c FROM relay_dispatcher_inbound_map").get();
      const rows = this.#database.prepare("SELECT status, COUNT(*) AS c FROM relay_dispatcher_outbox GROUP BY status").all();
      const counts = { pending: 0, dispatching: 0, unknown: 0, sent: 0, dead_letter: 0 };
      for (const row of rows) counts[row.status] = Number(row.c);
      return {
        inbound_mappings: Number(mappingRow.c),
        total_outbox: counts.pending + counts.dispatching + counts.unknown + counts.sent + counts.dead_letter,
        ...counts,
        max_outbox: this.#maxOutbox,
      };
    }
    const counts = { pending: 0, dispatching: 0, unknown: 0, sent: 0, dead_letter: 0 };
    for (const entry of this.#outboxMap.values()) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return {
      inbound_mappings: this.#inboundMap.size,
      total_outbox: this.#outboxMap.size,
      ...counts,
      max_outbox: this.#maxOutbox,
    };
  }
}

class LruMap {
  #limit;
  #map = new Map();

  constructor(limit) {
    this.#limit = limit;
  }

  get size() {
    return this.#map.size;
  }

  has(key) {
    if (!this.#map.has(key)) return false;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return true;
  }

  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#limit) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, value);
  }

  clear() {
    this.#map.clear();
  }
}

function createAbortError(code, message) {
  return new CoreError(code, message);
}

function composeSignals(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 0) return { signal: undefined, cleanup: () => {} };
  if (valid.length === 1) return { signal: valid[0], cleanup: () => {} };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(valid), cleanup: () => {} };
  }
  const controller = new AbortController();
  const cleanups = [];
  const cleanupAll = () => {
    while (cleanups.length > 0) cleanups.pop()();
  };
  const abortWith = source => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason ?? createAbortError("aborted", "操作已取消"));
    }
    cleanupAll();
  };
  for (const sig of valid) {
    if (sig.aborted) {
      cleanupAll();
      abortWith(sig);
      return { signal: controller.signal, cleanup: () => {} };
    }
    const listener = () => abortWith(sig);
    sig.addEventListener("abort", listener, { once: true });
    cleanups.push(() => sig.removeEventListener("abort", listener));
  }
  return { signal: controller.signal, cleanup: cleanupAll };
}

/**
 * 构造可直接挂入 HostStatusProvider / HostConversationContent `machineProviders`（Map<machineId, Map<host, provider>>）的只读代理集合。
 */
export function createRemoteMachineProviders(
  dispatcher,
  targetMachine,
  hosts = DEFAULT_REMOTE_HOSTS,
  options = {},
) {
  if (!dispatcher || typeof dispatcher.queryStatus !== "function"
    || typeof dispatcher.queryDirectory !== "function"
    || typeof dispatcher.querySnapshot !== "function") {
    throw new CoreError("invalid_input", "dispatcher必须是有效的RemoteCoreDispatcher实例");
  }
  const machines = Array.isArray(targetMachine) ? targetMachine : [targetMachine];
  if (machines.length === 0) throw new CoreError("invalid_input", "targetMachine不能为空");
  if (!Array.isArray(hosts) || hosts.length === 0) throw new CoreError("invalid_input", "hosts必须是非空数组");

  const resolveConfiguredModes = hostName => {
    if (isPlainObject(options.configured_delivery_modes)) {
      if (isPlainObject(options.configured_delivery_modes[hostName])) {
        const specific = options.configured_delivery_modes[hostName];
        return {
          next_model_boundary: typeof specific.next_model_boundary === "boolean" ? specific.next_model_boundary : "unknown",
          when_idle: typeof specific.when_idle === "boolean" ? specific.when_idle : "unknown",
        };
      }
      return {
        next_model_boundary: typeof options.configured_delivery_modes.next_model_boundary === "boolean"
          ? options.configured_delivery_modes.next_model_boundary
          : "unknown",
        when_idle: typeof options.configured_delivery_modes.when_idle === "boolean"
          ? options.configured_delivery_modes.when_idle
          : "unknown",
      };
    }
    return { next_model_boundary: "unknown", when_idle: "unknown" };
  };
  const getCursorGeneration = typeof options.getCursorGeneration === "function"
    ? options.getCursorGeneration
    : (options.cursorGeneration !== undefined ? () => options.cursorGeneration : () => null);
  const timeoutMs = options.timeoutMs;
  const channel = options.channel;

  const machineMap = new Map();

  for (const rawMachine of machines) {
    const machineId = requireText(rawMachine, "targetMachine", 128);
    const hostMap = new Map();

    for (const rawHost of hosts) {
      const host = requireText(rawHost, "host", 64);
      const inflightStatus = new Map();
      const configuredDeliveryModes = resolveConfiguredModes(host);

      const awaitWithSignal = (promise, signal) => {
        if (!signal) return promise;
        if (signal.aborted) {
          return Promise.reject(createAbortError("remote_cancelled", "跨机查询已取消"));
        }
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(createAbortError("remote_cancelled", "跨机查询已取消"));
          signal.addEventListener("abort", onAbort, { once: true });
          promise.then(
            value => { signal.removeEventListener("abort", onAbort); resolve(value); },
            err => { signal.removeEventListener("abort", onAbort); reject(err); },
          );
        });
      };

      const sharedQueryStatus = (target, signal) => {
        const generation = getCursorGeneration(machineId, host);
        const key = digest({
          machine_id: machineId,
          host,
          surface: target?.surface ?? "desktop",
          conversation_id: target?.conversation_id ?? null,
          generation: generation ?? null,
        });
        const existing = inflightStatus.get(key);
        if (existing) return awaitWithSignal(existing, signal);

        const scope = target?.conversation_id !== undefined ? "conversation" : "host";
        const queryTarget = {
          machine_id: machineId,
          host,
          surface: target?.surface ?? "desktop",
          ...(target?.conversation_id !== undefined ? { conversation_id: target.conversation_id } : {}),
        };
        const promise = dispatcher.queryStatus({
          targetMachine: machineId,
          channel,
          scope,
          target: queryTarget,
          timeoutMs,
        }).finally(() => {
          if (inflightStatus.get(key) === promise) inflightStatus.delete(key);
        });
        inflightStatus.set(key, promise);
        return awaitWithSignal(promise, signal);
      };

      const provider = {
        source: "remote_core_relay",
        machine_id: machineId,
        host,
        configured_delivery_modes: { ...configuredDeliveryModes },
        get cursorGeneration() {
          return getCursorGeneration(machineId, host);
        },

        async getHostStatus(target, { signal } = {}) {
          const snapshot = await sharedQueryStatus(target, signal);
          return {
            host_online: snapshot.host_online ?? "unknown",
            transport_ready: snapshot.transport_ready ?? "unknown",
            control_enabled: snapshot.control_enabled ?? "unknown",
            control_ready: snapshot.control_ready ?? "unknown",
            ...(snapshot.host_can_receive !== undefined ? { host_can_receive: snapshot.host_can_receive } : {}),
            ...(snapshot.configured_delivery_modes !== undefined
              ? { configured_delivery_modes: snapshot.configured_delivery_modes }
              : {}),
            ...(snapshot.code ? { code: snapshot.code } : {}),
            ...(snapshot.last_observed ? { last_observed: snapshot.last_observed } : {}),
          };
        },

        async describeConversation(target, { signal } = {}) {
          const snapshot = await sharedQueryStatus(target, signal);
          return {
            host_online: snapshot.host_online ?? "unknown",
            conversation_exists: snapshot.conversation_exists ?? "unknown",
            conversation_running: snapshot.conversation_running ?? "unknown",
            ...(snapshot.can_accept_direct_input !== undefined
              ? { can_accept_direct_input: snapshot.can_accept_direct_input }
              : {}),
            ...(snapshot.model_observation !== undefined
              ? { model_observation: snapshot.model_observation }
              : {}),
            ...(snapshot.raw_status !== undefined ? { raw_status: snapshot.raw_status } : {}),
            ...(snapshot.code ? { code: snapshot.code } : {}),
          };
        },

        async list(scope, { cursor = null, limit = 20, signal } = {}) {
          const reply = await dispatcher.queryDirectory({
            targetMachine: machineId,
            channel,
            host: scope?.host ?? host,
            surface: scope?.surface ?? "desktop",
            limit,
            cursor,
            timeoutMs,
            signal,
          });
          const conversations = Array.isArray(reply?.conversations)
            ? reply.conversations
            : (Array.isArray(reply?.items) ? reply.items : []);
          return {
            conversations,
            next_cursor: reply?.next_cursor ?? null,
            ...(reply?.partial === true ? { partial: true } : {}),
            ...(reply?.coverage_source ? { coverage_source: reply.coverage_source } : {}),
            ...(Array.isArray(reply?.coverage_reasons) ? { coverage_reasons: reply.coverage_reasons } : {}),
          };
        },

        async readRecent(target, { lastRounds = 3, maxBytes, maxChars, source, sourceIdentityVerified, signal } = {}) {
          const reply = await dispatcher.querySnapshot({
            targetMachine: machineId,
            channel,
            target: {
              machine_id: machineId,
              host: target?.host ?? host,
              surface: target?.surface ?? "desktop",
              conversation_id: target?.conversation_id,
            },
            last_rounds: lastRounds,
            ...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}),
            ...(maxChars !== undefined ? { max_chars: maxChars } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(sourceIdentityVerified !== undefined ? { sourceIdentityVerified } : {}),
            timeoutMs,
            signal,
          });
          const snap = isPlainObject(reply?.snapshot) ? reply.snapshot : {};
          if (Array.isArray(snap.rounds)) {
            return {
              ...snap,
              ...(snap.conversation_id !== undefined ? { conversation_id: snap.conversation_id } : {}),
              ...(reply?.truncated === true || snap.truncated === true ? { partial: true } : {}),
            };
          }
          const previewText = typeof snap.text === "string"
            ? snap.text
            : (typeof snap.preview === "string" ? snap.preview : "");
          const truncated = reply?.truncated === true || snap.truncated === true || reply?.omitted === true;
          const safeRole = HOST_SNAPSHOT_BODY_ROLES.has(snap.role) ? snap.role : "external";
          return {
            ...(snap.conversation_id !== undefined ? { conversation_id: snap.conversation_id } : {}),
            observed_at: snap.observed_at ?? new Date().toISOString(),
            status: snap.status ?? "unknown",
            ...(snap.title ? { title: snap.title } : {}),
            rounds: previewText ? [{ messages: [{ role: safeRole, text: previewText }] }] : [],
            partial: truncated,
            ...(truncated ? { coverage_reasons: ["text_limited"] } : {}),
          };
        },
      };

      hostMap.set(host, provider);
    }

    machineMap.set(machineId, hostMap);
  }

  return machineMap;
}

export class RemoteCoreDispatcher {
  #localMachineId;
  #transport;
  #outboxStore;
  #ackStore;
  #flushInFlight = null;
  #flushRequestedAgain = false;
  #localHandlers;
  #policy;
  #limits;
  #frameCodec;
  #signDirectoryCursor;
  #now;
  #onError;

  #closed = false;
  #lifecycleAbort = new AbortController();
  #pendingRequests = new Map();
  #processedCache;
  #outboundRecords;
  #lastObservedStatus;
  #remoteProcessingState;
  #opHandlers = new Map();

  #textCursor = null;
  #bundlePollCursor = null;
  #pollTimer = null;
  #polling = false;
  #pollIntervalOverride = null;
  #pollInFlight = null;
  #backoffUntilMs = 0;
  #consecutiveIdlePolls = 0;

  #activeConcurrency = 0;
  #concurrencyWaiters = [];
  #bundleAckLatencies = [];

  static #isRelayAckStore(candidate) {
    return Boolean(
      candidate
      && typeof candidate === "object"
      && typeof candidate.bindInbound === "function"
      && typeof candidate.stageProcessing === "function"
      && typeof candidate.ready === "function"
      && typeof candidate.claim === "function"
      && typeof candidate.settle === "function",
    );
  }

  constructor({
    localMachineId,
    transport,
    outboxStore,
    ackStore = null,
    localHandlers = {},
    policy = {},
    limits = {},
    frameCodec = null,
    signDirectoryCursor = false,
    now = () => Date.now(),
    onError = () => {},
  } = {}) {
    this.#localMachineId = requireText(localMachineId, "localMachineId", 128);
    if (!transport || typeof transport !== "object") {
      throw new CoreError("invalid_input", "transport必须是有效传输实例");
    }
    if (typeof now !== "function") throw new CoreError("invalid_input", "now必须是函数");
    if (typeof onError !== "function") throw new CoreError("invalid_input", "onError必须是函数");

    this.#transport = transport;
    const detectedAckStore = ackStore ?? (RemoteCoreDispatcher.#isRelayAckStore(outboxStore) ? outboxStore : null);
    this.#ackStore = detectedAckStore;
    this.#outboxStore = detectedAckStore ? null : (outboxStore ?? new RelayOutboxStore({ now }));
    this.#localHandlers = isPlainObject(localHandlers) ? localHandlers : {};
    this.#policy = isPlainObject(policy) ? policy : {};
    this.#frameCodec = frameCodec && typeof frameCodec === "object" ? frameCodec : null;
    this.#signDirectoryCursor = signDirectoryCursor === true;
    this.#now = now;
    this.#onError = onError;

    const mergedLimits = { ...DEFAULT_DISPATCHER_LIMITS, ...(isPlainObject(limits) ? limits : {}) };
    this.#limits = Object.freeze({
      maxPendingRequests: requireInteger(mergedLimits.maxPendingRequests, "limits.maxPendingRequests", 1, 100000),
      maxProcessedCache: requireInteger(mergedLimits.maxProcessedCache, "limits.maxProcessedCache", 1, 200000),
      queryTimeoutMs: requireInteger(mergedLimits.queryTimeoutMs, "limits.queryTimeoutMs", 1, 120000),
      maxFrameChars: requireInteger(mergedLimits.maxFrameChars, "limits.maxFrameChars", 256, 1900),
      maxConcurrent: requireInteger(mergedLimits.maxConcurrent, "limits.maxConcurrent", 1, 64),
      pollIntervalMs: requireInteger(mergedLimits.pollIntervalMs, "limits.pollIntervalMs", 10, 60000),
      idlePollIntervalMs: requireInteger(mergedLimits.idlePollIntervalMs, "limits.idlePollIntervalMs", 10, 120000),
      bundleAckDeadlineMs: requireInteger(mergedLimits.bundleAckDeadlineMs, "limits.bundleAckDeadlineMs", 10, 60000),
      readLimit: requireInteger(mergedLimits.readLimit, "limits.readLimit", 1, 50),
      bundleReadLimit: requireInteger(mergedLimits.bundleReadLimit, "limits.bundleReadLimit", 1, 32),
      maxAttachments: requireInteger(mergedLimits.maxAttachments, "limits.maxAttachments", 1, 63),
      defaultSnapshotMaxChars: requireInteger(mergedLimits.defaultSnapshotMaxChars, "limits.defaultSnapshotMaxChars", 64, 1800),
    });

    this.#processedCache = new LruMap(this.#limits.maxProcessedCache);
    this.#outboundRecords = new LruMap(this.#limits.maxProcessedCache);
    this.#lastObservedStatus = new LruMap(this.#limits.maxPendingRequests);
    this.#remoteProcessingState = new LruMap(this.#limits.maxProcessedCache);
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

  get outboxStore() {
    return this.#ackStore ?? this.#outboxStore;
  }

  createRemoteMachineProviders(targetMachine, hosts = DEFAULT_REMOTE_HOSTS, options = {}) {
    return createRemoteMachineProviders(this, targetMachine, hosts, options);
  }

  getMetrics() {
    return {
      closed: this.#closed,
      polling: this.#polling,
      pending_requests: this.#pendingRequests.size,
      processed_cache_size: this.#processedCache.size,
      outbound_records_size: this.#outboundRecords.size,
      active_concurrency: this.#activeConcurrency,
      concurrency_waiters: this.#concurrencyWaiters.length,
      backoff_until_ms: this.#backoffUntilMs,
      has_poll_timer: this.#pollTimer !== null,
      bundle_ack_latencies_ms: [...this.#bundleAckLatencies],
      outbox: typeof this.#outboxStore?.stats === "function" ? this.#outboxStore.stats() : null,
      using_shared_ack_store: this.#ackStore !== null,
    };
  }

  #assertOpen() {
    if (this.#closed) throw new CoreError("dispatcher_closed", "跨机调度器已关闭");
  }

  #peerPolicy(fromMachine) {
    const defaults = isPlainObject(this.#policy.defaults) ? this.#policy.defaults : {};
    const peers = isPlainObject(this.#policy.peers) ? this.#policy.peers : this.#policy;
    const override = isPlainObject(peers[fromMachine]) ? peers[fromMachine] : {};
    return {
      allow_message: true,
      allow_status: true,
      allow_directory: true,
      allow_snapshot: true,
      allow_file_bundle: true,
      group_visibility_policy: "full",
      ...defaults,
      ...override,
    };
  }

  #measureFrame(frameInput) {
    const encoder = this.#frameCodec && typeof this.#frameCodec.encodeRelayFrame === "function"
      ? this.#frameCodec.encodeRelayFrame
      : envelopeEncodeRelayFrame;
    try {
      const encoded = encoder(frameInput, {
        maxFrameChars: this.#limits.maxFrameChars,
        enforceCqBudget: true,
      });
      return {
        charLength: encoded.charLength ?? encoded.frameText.length,
        cqLength: encoded.cqLength ?? cqEncodedLength(encoded.frameText),
        bodySha256: encoded.bodySha256 ?? computeBodySha256(frameInput.body ?? ""),
      };
    } catch (error) {
      if (error?.code === "relay_frame_too_large" && error?.details) {
        return {
          charLength: error.details.frame_length ?? Infinity,
          cqLength: error.details.cq_encoded_length ?? Infinity,
          bodySha256: computeBodySha256(frameInput.body ?? ""),
        };
      }
      throw error;
    }
  }

  #recordRateLimit(error) {
    const code = normalizeRelayErrorCode(error);
    if (code !== "relay_rate_limited") return 0;
    const retryAfterMs = Math.max(1, extractRetryAfterMs(error) || 1000);
    const targetUntil = this.#now() + retryAfterMs;
    if (targetUntil > this.#backoffUntilMs) this.#backoffUntilMs = targetUntil;
    return retryAfterMs;
  }

  async #withConcurrency(signal, task) {
    this.#assertOpen();
    if (signal?.aborted) throw createAbortError("aborted", "请求已取消");

    if (this.#activeConcurrency >= this.#limits.maxConcurrent) {
      await new Promise((resolve, reject) => {
        const waiter = {
          resolve: null,
          reject: null,
          cleanup: () => {},
        };
        const onAbort = () => {
          const idx = this.#concurrencyWaiters.indexOf(waiter);
          if (idx !== -1) this.#concurrencyWaiters.splice(idx, 1);
          waiter.cleanup();
          reject(createAbortError(this.#closed ? "dispatcher_closed" : "aborted", "等待并发槽位已取消"));
        };
        const { signal: merged, cleanup } = composeSignals([this.#lifecycleAbort.signal, signal]);
        waiter.cleanup = () => {
          merged?.removeEventListener("abort", onAbort);
          cleanup();
        };
        waiter.resolve = () => {
          waiter.cleanup();
          resolve();
        };
        waiter.reject = err => {
          waiter.cleanup();
          reject(err);
        };
        if (merged?.aborted) {
          onAbort();
          return;
        }
        merged?.addEventListener("abort", onAbort, { once: true });
        this.#concurrencyWaiters.push(waiter);
      });
    }

    this.#activeConcurrency += 1;
    try {
      this.#assertOpen();
      return await task();
    } finally {
      this.#activeConcurrency -= 1;
      const next = this.#concurrencyWaiters.shift();
      if (next) next.resolve();
    }
  }

  registerOpHandler(op, handler) {
    const normalizedOp = requireText(op, "op", 64);
    if (typeof handler !== "function") {
      throw new CoreError("invalid_input", "op handler 必须是函数");
    }
    this.#opHandlers.set(normalizedOp, handler);
    return () => {
      if (this.#opHandlers.get(normalizedOp) === handler) {
        this.#opHandlers.delete(normalizedOp);
      }
    };
  }

  // 纯同步代理到 ackStore / outboxStore，绝不返回 Promise/thenable
  recordInboundMessageMapping(mapping) {
    if (this.#ackStore) {
      return this.#ackStore.bindInbound({
        local_message_id: mapping.local_message_id,
        origin_relay_id: mapping.origin_relay_id,
        origin_message_id: mapping.origin_message_id,
        from_machine: mapping.from_machine,
        reply_relay_key: mapping.reply_relay_key,
        reply_group_id: String(mapping.reply_group_id ?? ""),
        reply_route_generation: mapping.reply_route_generation,
        target_key: mapping.target_key,
      });
    }
    return this.#outboxStore.recordInboundMapping(mapping);
  }

  // 纯同步代理到 ackStore / outboxStore，绝不返回 Promise/thenable
  enqueueProcessingAck(input) {
    if (this.#ackStore) {
      if (!isPlainObject(input)) throw new CoreError("invalid_input", "入队ACK参数必须是对象");
      return this.#ackStore.stageProcessing(input.local_message_id, input.processing);
    }
    return this.#outboxStore.enqueueAck(input);
  }

  // 启动恢复：将中断在 dispatching 的记录转为 unknown，避免重启后盲目重发
  recoverInterruptedOutbox() {
    if (this.#ackStore && typeof this.#ackStore.recoverInterrupted === "function") {
      return this.#ackStore.recoverInterrupted();
    }
    if (this.#outboxStore && typeof this.#outboxStore.recoverInterrupted === "function") {
      return this.#outboxStore.recoverInterrupted(this.#now());
    }
    return 0;
  }

  // 供 Core.attachRelayAcknowledgements({ onReady }) 回调的非阻塞刷盘触发口
  triggerFlush() {
    if (this.#closed) return null;
    return this.flushOutbox().catch(error => {
      if (!this.#closed) this.#onError(error);
      return null;
    });
  }

  async dispatchMessage({
    dedupeKey,
    targetMachine,
    channel,
    source,
    recipients,
    allRecipients,
    body,
    inReplyTo = null,
    meta = {},
    attachments = [],
    sourceIdentityVerified = false,
    allowDiscloseRecipients = true,
    signal,
  } = {}) {
    this.#assertOpen();
    const cleanDedupeKey = requireText(dedupeKey, "dedupeKey", 128);
    const cleanTargetMachine = requireText(targetMachine, "targetMachine", 128);
    if (cleanTargetMachine === this.#localMachineId) {
      throw new CoreError("invalid_input", "跨机派发目标机器不能是本机");
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      throw new CoreError("invalid_input", "recipients必须是非空数组");
    }
    if (typeof body !== "string") {
      throw new CoreError("invalid_input", "body必须是字符串");
    }
    if (!Array.isArray(attachments) || attachments.length > this.#limits.maxAttachments) {
      throw new CoreError("invalid_input", `attachments数量不能超过${this.#limits.maxAttachments}`);
    }

    const sourceEndpoint = formatEndpoint(source, "source");
    const recipientEndpoints = recipients.map((item, idx) => formatEndpoint(item, `recipients[${idx}]`));
    const normalizedAllRecipients = Array.isArray(allRecipients) && allRecipients.length > 0
      ? allRecipients.map(item => formatFullRecipientRef(item, cleanTargetMachine))
      : recipientEndpoints.map(ep => `${cleanTargetMachine}/${ep}`);

    const cleanMeta = isPlainObject(meta) ? cloneJson(meta) : {};
    const requestId = cleanMeta.request_id
      ? requireText(cleanMeta.request_id, "meta.request_id", 128)
      : `req_${randomUUID()}`;
    const frameMeta = {
      ...cleanMeta,
      request_id: requestId,
      hop_count: 1,
      source_identity_verified: Boolean(sourceIdentityVerified),
      all_recipients: normalizedAllRecipients,
    };
    const cleanInReplyTo = inReplyTo ? requireText(inReplyTo, "inReplyTo", 256) : null;
    const bodySha256 = computeBodySha256(body);

    const frameEstimate = this.#measureFrame({
      relay_id: "rly_00000000-0000-0000-0000-000000000000",
      op: "message",
      from_machine: this.#localMachineId,
      to_machine: cleanTargetMachine,
      source: sourceEndpoint,
      recipients: recipientEndpoints,
      in_reply_to: cleanInReplyTo,
      body,
      meta: frameMeta,
    });

    const hasAttachments = attachments.length > 0;
    const exceedsTextBudget = frameEstimate.charLength > this.#limits.maxFrameChars
      || frameEstimate.cqLength > this.#limits.maxFrameChars;
    const canSendBundle = typeof this.#transport.sendBundle === "function";

    const sendViaBundle = async () => {
      if (!canSendBundle) {
        if (hasAttachments) {
          throw new CoreError("bundle_transport_unavailable", "纯数据文件包通道未启用，无法发送附件");
        }
        throw new CoreError("relay_frame_too_large", "文本帧超出长度或CQ膨胀上限且文件包通道未启用", {
          frame_length: frameEstimate.charLength,
          cq_encoded_length: frameEstimate.cqLength,
          max_frame_chars: this.#limits.maxFrameChars,
          suggest_file_bundle: true,
        });
      }
      const bundleInput = {
        dedupe_key: cleanDedupeKey,
        target_machine: cleanTargetMachine,
        ...(channel ? { channel } : {}),
        op: "message",
        source: sourceEndpoint,
        recipients: recipientEndpoints,
        meta: frameMeta,
        payload_json: {
          op: "message",
          from_machine: this.#localMachineId,
          to_machine: cleanTargetMachine,
          source: sourceEndpoint,
          recipients: recipientEndpoints,
          ...(cleanInReplyTo ? { in_reply_to: cleanInReplyTo } : {}),
          body,
          body_sha256: bodySha256,
          meta: frameMeta,
        },
        allow_disclose_recipients: Boolean(allowDiscloseRecipients),
        ...(hasAttachments ? { attachments: [...attachments] } : {}),
      };
      return this.#transport.sendBundle(bundleInput, { signal });
    };

    let viaBundle = hasAttachments || exceedsTextBudget;
    let transportResult;

    try {
      transportResult = await this.#withConcurrency(signal, async () => {
        if (viaBundle) return sendViaBundle();
        try {
          return await this.#transport.sendFrame({
            dedupe_key: cleanDedupeKey,
            target_machine: cleanTargetMachine,
            ...(channel ? { channel } : {}),
            op: "message",
            source: sourceEndpoint,
            recipients: recipientEndpoints,
            body,
            ...(cleanInReplyTo ? { in_reply_to: cleanInReplyTo } : {}),
            meta: frameMeta,
            allow_disclose_recipients: Boolean(allowDiscloseRecipients),
          }, { signal });
        } catch (error) {
          if (normalizeRelayErrorCode(error) === "relay_frame_too_large" && canSendBundle) {
            viaBundle = true;
            return sendViaBundle();
          }
          throw error;
        }
      });
    } catch (error) {
      this.#recordRateLimit(error);
      throw error;
    }

    const resultStatus = typeof transportResult?.status === "string" ? transportResult.status : "sent_verified";
    if (resultStatus === "too_large") {
      throw new CoreError("relay_bundle_too_large", "纯数据文件包超出单包体积限制", {
        target_machine: cleanTargetMachine,
        status: resultStatus,
        reason: transportResult?.reason ?? "too_large",
      });
    }

    const acceptedAt = new Date(this.#now()).toISOString();
    const relayId = viaBundle
      ? (transportResult?.bundle_id ?? transportResult?.relay_id ?? null)
      : (transportResult?.relay_id ?? transportResult?.bundle_id ?? null);
    const isPendingCapacity = resultStatus === "pending_capacity";
    const isUnknown = resultStatus === "unknown" || isOutcomeUnknownResult(transportResult);
    const acceptedOk = !isPendingCapacity && !isUnknown && transportResult?.ok !== false;

    const stages = {
      relay_accepted: {
        ok: acceptedOk,
        status: resultStatus,
        transport_stage: transportResult?.transport_stage ?? (viaBundle ? "bundle_group_received" : "group_received"),
        relay_id: relayId,
        relay_key: transportResult?.relay_key ?? null,
        group_id: transportResult?.group_id ?? null,
        route_generation: transportResult?.route_generation ?? null,
        onebot_message_id: transportResult?.onebot_message_id ?? null,
        real_seq: transportResult?.real_seq ?? null,
        body_sha256: transportResult?.body_sha256 ?? bodySha256,
        outcome_unknown: isUnknown,
        at: acceptedAt,
      },
      remote_core_persisted: { ok: false },
      target_delivered: { status: "unknown" },
      target_processing: { status: "pending", ack_seq: 0 },
    };

    const record = {
      request_id: requestId,
      relay_id: relayId,
      target_machine: cleanTargetMachine,
      relay_key: transportResult?.relay_key ?? null,
      group_id: transportResult?.group_id ?? null,
      route_generation: transportResult?.route_generation ?? null,
      transport_mode: viaBundle ? "file_bundle" : "text_relay",
      stages,
    };
    this.#outboundRecords.set(requestId, record);
    if (relayId) this.#outboundRecords.set(relayId, record);

    const stage = isPendingCapacity
      ? "pending_capacity"
      : (isUnknown ? "relay_unknown" : "relay_accepted");

    return {
      ok: acceptedOk,
      request_id: requestId,
      relay_id: relayId,
      transport_mode: record.transport_mode,
      stage,
      ...(isUnknown ? { outcome_unknown: true } : {}),
      stages: cloneJson(stages),
      transport_result: transportResult,
    };
  }

  getOutboundStatus(key) {
    const rec = this.#outboundRecords.get(key);
    return rec ? cloneJson(rec) : null;
  }

  #buildStatusSnapshot(targetMachine, target, code, reason, lastObserved) {
    const normalizedTarget = isPlainObject(target)
      ? { machine_id: targetMachine, ...cloneJson(target) }
      : { machine_id: targetMachine };
    return {
      target: normalizedTarget,
      observed_at: new Date(this.#now()).toISOString(),
      source: "remote_core_relay",
      host_online: "unknown",
      conversation_exists: "unknown",
      conversation_running: "unknown",
      can_deliver: "unknown",
      ...(code ? { code } : {}),
      ...(reason ? { reason } : {}),
      ...(lastObserved ? { last_observed: cloneJson(lastObserved) } : {}),
    };
  }

  async #sendQueryAndAwaitReply({
    op,
    targetMachine,
    channel,
    meta,
    source,
    sourceIdentityVerified,
    timeoutMs,
    signal,
  }) {
    this.#assertOpen();
    const cleanTargetMachine = requireText(targetMachine, "targetMachine", 128);
    if (cleanTargetMachine === this.#localMachineId) {
      throw new CoreError("invalid_input", "跨机查询目标不能是本机");
    }
    const expectedOp = QUERY_REPLY_OP[op];
    if (!expectedOp) throw new CoreError("unsupported_op", `不支持的查询操作: ${op}`);

    const hasExplicitSource = source !== undefined && source !== null;
    let frameSource = "core/system/dispatcher";
    if (hasExplicitSource) {
      frameSource = formatEndpoint(source, "source");
      if (frameSource === "core/system/dispatcher") {
        throw new CoreError("invalid_input", "显式调用来源不能使用系统占位端点");
      }
    }
    if (sourceIdentityVerified !== undefined && typeof sourceIdentityVerified !== "boolean") {
      throw new CoreError("invalid_input", "sourceIdentityVerified 必须为布尔值");
    }
    if (sourceIdentityVerified === true && !hasExplicitSource) {
      throw new CoreError("invalid_input", "sourceIdentityVerified=true 必须提供具体调用来源");
    }

    if (this.#pendingRequests.size >= this.#limits.maxPendingRequests) {
      throw new CoreError("relay_pending_limit_exceeded", "挂起的跨机查询数已达上限", {
        max_pending_requests: this.#limits.maxPendingRequests,
        current_pending: this.#pendingRequests.size,
      });
    }

    const effectiveTimeout = timeoutMs === undefined
      ? this.#limits.queryTimeoutMs
      : requireInteger(timeoutMs, "timeoutMs", 1, 120000);
    const requestId = `req_${randomUUID()}`;
    const dedupeKey = `q:${requestId}`;

    let resolvePending;
    let rejectPending;
    const replyPromise = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });

    const { signal: combinedSignal, cleanup: cleanupCombined } = composeSignals([
      this.#lifecycleAbort.signal,
      signal,
    ]);

    const pendingEntry = {
      requestId,
      expectedOp,
      expectedTargetMachine: cleanTargetMachine,
      expectedRelayKey: null,
      expectedGroupId: null,
      expectedRouteGeneration: null,
      originRelayId: null,
      strictReplyPairing: hasExplicitSource,
      startedAt: this.#now(),
      timer: null,
      settled: false,
      cleanup: () => {},
      resolve: value => {
        if (pendingEntry.settled) return;
        pendingEntry.settled = true;
        pendingEntry.cleanup();
        resolvePending(value);
      },
      reject: error => {
        if (pendingEntry.settled) return;
        pendingEntry.settled = true;
        pendingEntry.cleanup();
        rejectPending(error);
      },
    };

    const onAbort = () => {
      const code = this.#closed ? "dispatcher_closed" : "remote_cancelled";
      pendingEntry.reject(new CoreError(code, this.#closed ? "调度器已关闭" : "跨机查询已取消"));
    };

    pendingEntry.cleanup = () => {
      if (pendingEntry.timer !== null) {
        clearTimeout(pendingEntry.timer);
        pendingEntry.timer = null;
      }
      combinedSignal?.removeEventListener("abort", onAbort);
      cleanupCombined();
      if (this.#pendingRequests.get(requestId) === pendingEntry) {
        this.#pendingRequests.delete(requestId);
      }
    };

    if (combinedSignal?.aborted) {
      cleanupCombined();
      throw new CoreError(this.#closed ? "dispatcher_closed" : "remote_cancelled", "跨机查询已取消");
    }

    combinedSignal?.addEventListener("abort", onAbort, { once: true });
    pendingEntry.timer = setTimeout(() => {
      pendingEntry.reject(new CoreError("remote_timeout", "远端机器在等待窗口内未返回结果", {
        request_id: requestId,
        target_machine: cleanTargetMachine,
        op,
        timeout_ms: effectiveTimeout,
      }));
    }, effectiveTimeout);

    this.#pendingRequests.set(requestId, pendingEntry);

    try {
      const sendResult = await this.#withConcurrency(combinedSignal, () => this.#transport.sendFrame({
        dedupe_key: dedupeKey,
        target_machine: cleanTargetMachine,
        ...(channel ? { channel } : {}),
        op,
        source: frameSource,
        recipients: ["core/system/dispatcher"],
        body: "",
        meta: {
          ...meta,
          request_id: requestId,
          hop_count: 1,
          ...(sourceIdentityVerified !== undefined ? { source_identity_verified: sourceIdentityVerified } : {}),
        },
        allow_disclose_recipients: false,
      }, { signal: combinedSignal }));

      pendingEntry.expectedRelayKey = sendResult?.relay_key ?? null;
      pendingEntry.originRelayId = sendResult?.relay_id ?? null;
      pendingEntry.expectedGroupId = sendResult?.group_id !== undefined && sendResult?.group_id !== null
        ? String(sendResult.group_id)
        : null;
      pendingEntry.expectedRouteGeneration = Number.isSafeInteger(sendResult?.route_generation)
        ? sendResult.route_generation
        : null;
    } catch (error) {
      this.#recordRateLimit(error);
      pendingEntry.cleanup();
      throw error;
    }

    return replyPromise;
  }

  async queryStatus({ targetMachine, channel, scope = "conversation", target, timeoutMs, signal } = {}) {
    const cleanTargetMachine = requireText(targetMachine, "targetMachine", 128);
    const cacheKey = digest({ targetMachine: cleanTargetMachine, scope, target: target ?? null });
    const lastObserved = this.#lastObservedStatus.get(cacheKey);
    try {
      const reply = await this.#sendQueryAndAwaitReply({
        op: "status_query",
        targetMachine: cleanTargetMachine,
        channel,
        meta: {
          scope,
          ...(target !== undefined ? { target } : {}),
        },
        timeoutMs,
        signal,
      });
      const payload = reply.payload;
      if (payload?.ok === false) {
        const errCode = normalizeRelayErrorCode(payload.error?.code ?? "forbidden");
        return this.#buildStatusSnapshot(
          cleanTargetMachine,
          target,
          errCode,
          payload.error?.message ?? "远端拒绝提供状态",
          lastObserved,
        );
      }
      const statusResult = isPlainObject(payload?.status) ? cloneJson(payload.status) : cloneJson(payload ?? {});
      const normalized = {
        ...this.#buildStatusSnapshot(cleanTargetMachine, target, undefined, undefined, undefined),
        ...statusResult,
        target: isPlainObject(statusResult.target)
          ? { machine_id: cleanTargetMachine, ...statusResult.target }
          : (isPlainObject(target) ? { machine_id: cleanTargetMachine, ...cloneJson(target) } : { machine_id: cleanTargetMachine }),
        source: "remote_core_relay",
        observed_at: statusResult.observed_at ?? new Date(this.#now()).toISOString(),
      };
      this.#lastObservedStatus.set(cacheKey, cloneJson(normalized));
      return normalized;
    } catch (error) {
      if (error?.code === "remote_timeout") {
        return this.#buildStatusSnapshot(
          cleanTargetMachine,
          target,
          "remote_timeout",
          "远端机器在等待窗口内未返回状态",
          lastObserved,
        );
      }
      if (error?.code === "dispatcher_closed" || error?.code === "remote_cancelled") {
        return this.#buildStatusSnapshot(
          cleanTargetMachine,
          target,
          error.code,
          error.message,
          lastObserved,
        );
      }
      throw error;
    }
  }

  async queryDirectory({ targetMachine, channel, host, surface, limit, cursor, timeoutMs, signal } = {}) {
    const reply = await this.#sendQueryAndAwaitReply({
      op: "list_query",
      targetMachine,
      channel,
      meta: {
        ...(host !== undefined ? { host } : {}),
        ...(surface !== undefined ? { surface } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
      },
      timeoutMs,
      signal,
    });
    const payload = reply.payload;
    if (payload?.ok === false) {
      throw new CoreError(
        normalizeRelayErrorCode(payload.error?.code ?? "forbidden"),
        payload.error?.message ?? "远端拒绝目录查询",
      );
    }
    return payload;
  }

  async querySnapshot({ targetMachine, channel, target, last_rounds, max_bytes, max_chars, source, sourceIdentityVerified, timeoutMs, signal } = {}) {
    const reply = await this.#sendQueryAndAwaitReply({
      op: "snapshot_query",
      targetMachine,
      channel,
      ...(source !== undefined ? { source } : {}),
      ...(sourceIdentityVerified !== undefined ? { sourceIdentityVerified } : {}),
      meta: {
        ...(target !== undefined ? { target } : {}),
        ...(last_rounds !== undefined ? { last_rounds } : {}),
        ...(max_bytes !== undefined ? { max_bytes } : {}),
        ...(max_chars !== undefined ? { max_chars } : {}),
      },
      timeoutMs,
      signal,
    });
    const payload = reply.payload;
    if (payload?.ok === false) {
      throw new CoreError(
        normalizeRelayErrorCode(payload.error?.code ?? "forbidden"),
        payload.error?.message ?? "远端拒绝快照查询",
      );
    }
    return payload;
  }

  #encodeSignedCursor(ownerMachine, rawCursor) {
    if (rawCursor === null || rawCursor === undefined) return null;
    const raw = String(rawCursor);
    const sig = createHash("sha256")
      .update(`${this.#localMachineId}\0${ownerMachine}\0${raw}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    return Buffer.from(JSON.stringify({ owner_machine: ownerMachine, cursor: raw, sig }), "utf8").toString("base64url");
  }

  #decodeSignedCursor(ownerMachine, signedCursor) {
    if (signedCursor === null || signedCursor === undefined || signedCursor === "") {
      return { ok: true, cursor: null };
    }
    try {
      const parsed = JSON.parse(Buffer.from(String(signedCursor), "base64url").toString("utf8"));
      if (!isPlainObject(parsed) || parsed.owner_machine !== ownerMachine || typeof parsed.cursor !== "string") {
        return { ok: false, code: "relay_cursor_scope_mismatch" };
      }
      const expectedSig = createHash("sha256")
        .update(`${this.#localMachineId}\0${ownerMachine}\0${parsed.cursor}`, "utf8")
        .digest("hex")
        .slice(0, 16);
      if (parsed.sig !== expectedSig) {
        return { ok: false, code: "relay_cursor_invalid" };
      }
      return { ok: true, cursor: parsed.cursor };
    } catch {
      return { ok: false, code: "relay_cursor_invalid" };
    }
  }

  #applyGroupVisibilityToRecipients(allRecipients, localRecipients, policy) {
    if (!Array.isArray(allRecipients)) return [];
    const vis = policy.group_visibility_policy;
    if (vis === "none" || (isPlainObject(vis) && vis.mode === "none")) {
      return [];
    }
    if (vis === "redacted" || (isPlainObject(vis) && (vis.mode === "redacted" || vis.redact_recipients === true))) {
      const localSet = new Set(localRecipients.map(ep => `${this.#localMachineId}/${ep}`));
      return allRecipients.filter(item => localSet.has(item));
    }
    return [...allRecipients];
  }

  #applyGroupVisibilityToDirectory(items, policy) {
    if (!Array.isArray(items)) return [];
    const vis = policy.group_visibility_policy;
    if (vis === "none" || (isPlainObject(vis) && vis.mode === "none")) {
      return [];
    }
    if (vis === "redacted" || (isPlainObject(vis) && (vis.mode === "redacted" || vis.redact_titles === true))) {
      return items.map(item => {
        if (!isPlainObject(item)) return item;
        const copy = { ...item };
        delete copy.title;
        delete copy.participants;
        delete copy.group_members;
        copy.redacted = true;
        return copy;
      });
    }
    return cloneJson(items);
  }

  async #sendOriginalRouteReply(event, frame, { op, body = "", meta = {}, dedupeSuffix, payloadJson, allowBundle = false, signal }) {
    const replyRoute = {
      reply_relay_key: event.relay_key,
      reply_group_id: String(event.group_id),
      reply_route_generation: event.route_generation,
    };
    const replyMeta = {
      ...meta,
      hop_count: 1,
      observed_at: new Date(this.#now()).toISOString(),
    };
    const targetMachine = frame.from_machine;
    const dedupeKey = `rep:${digest({
      originRelayId: frame.relay_id ?? event.event_id,
      op,
      suffix: dedupeSuffix ?? "",
    }).slice(0, 28)}`;
    const source = "core/system/dispatcher";
    let safeReplyRecipient = "core/system/dispatcher";
    if (typeof frame.source === "string") {
      try {
        safeReplyRecipient = formatEndpoint(frame.source, "reply_recipient");
      } catch {
        safeReplyRecipient = "core/system/dispatcher";
      }
    }
    const recipients = [safeReplyRecipient];

    const estimate = this.#measureFrame({
      relay_id: "rly_00000000-0000-0000-0000-000000000000",
      op,
      from_machine: this.#localMachineId,
      to_machine: targetMachine,
      source,
      recipients,
      in_reply_to: frame.relay_id,
      body,
      meta: replyMeta,
    });

    const exceeds = estimate.charLength > this.#limits.maxFrameChars || estimate.cqLength > this.#limits.maxFrameChars;
    if (exceeds && allowBundle && typeof this.#transport.sendBundle === "function") {
      return this.#transport.sendBundle({
        dedupe_key: dedupeKey,
        target_machine: targetMachine,
        ...replyRoute,
        op,
        source,
        recipients,
        meta: replyMeta,
        payload_json: {
          op,
          from_machine: this.#localMachineId,
          to_machine: targetMachine,
          source,
          recipients,
          ...(frame.relay_id ? { in_reply_to: frame.relay_id } : {}),
          body,
          body_sha256: computeBodySha256(body),
          meta: replyMeta,
          ...(isPlainObject(payloadJson) ? payloadJson : {}),
        },
        allow_disclose_recipients: false,
      }, { signal });
    }

    return this.#transport.sendFrame({
      dedupe_key: dedupeKey,
      target_machine: targetMachine,
      ...replyRoute,
      op,
      source,
      recipients,
      body,
      ...(frame.relay_id ? { in_reply_to: frame.relay_id } : {}),
      meta: replyMeta,
      allow_disclose_recipients: false,
    }, { signal });
  }

  #buildTruncatedSnapshotText(fullText, queryMeta, event, frame, baseMeta) {
    const requestedMax = Number.isSafeInteger(queryMeta?.max_chars) && queryMeta.max_chars > 0
      ? queryMeta.max_chars
      : this.#limits.defaultSnapshotMaxChars;
    const chars = [...fullText];
    const maxAllowed = Math.min(chars.length, requestedMax);
    const safeRecipient = safeEndpointOrSystem(frame.source);
    const observedAtPlaceholder = new Date(this.#now()).toISOString();

    const buildCandidate = len => {
      const slice = chars.slice(0, Math.max(0, len)).join("");
      const candidateMeta = {
        ...baseMeta,
        truncated: true,
        omitted: true,
        original_chars: chars.length,
        returned_chars: len,
      };
      const measuredMeta = {
        ...candidateMeta,
        hop_count: 1,
        observed_at: observedAtPlaceholder,
      };
      const size = this.#measureFrame({
        relay_id: "rly_00000000-0000-0000-0000-000000000000",
        op: "snapshot_reply",
        from_machine: this.#localMachineId,
        to_machine: frame.from_machine,
        source: "core/system/dispatcher",
        recipients: [safeRecipient],
        in_reply_to: frame.relay_id,
        body: slice,
        meta: measuredMeta,
      });
      return {
        slice,
        candidateMeta,
        size,
        fits: size.charLength <= this.#limits.maxFrameChars && size.cqLength <= this.#limits.maxFrameChars,
      };
    };

    const fullTry = buildCandidate(maxAllowed);
    if (fullTry.fits) return fullTry;

    let low = 0;
    let high = maxAllowed;
    let best = buildCandidate(0);
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const attempt = buildCandidate(mid);
      if (attempt.fits) {
        best = attempt;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  #normalizeInboundEventFrame(event, isBundle) {
    if (isBundle) {
      const payload = isPlainObject(event.payload_json) ? event.payload_json : null;
      if (!payload) return { ok: false, reason: "missing_bundle_payload" };
      const trustedBundleId = typeof event.bundle_id === "string" && event.bundle_id.trim()
        ? event.bundle_id.trim()
        : null;
      const topRelayId = typeof event.relay_id === "string" && event.relay_id.trim()
        ? event.relay_id.trim()
        : null;
      const payloadRelayId = typeof payload.relay_id === "string" && payload.relay_id.trim()
        ? payload.relay_id.trim()
        : null;
      const payloadBundleId = typeof payload.bundle_id === "string" && payload.bundle_id.trim()
        ? payload.bundle_id.trim()
        : null;
      let resolvedRelayId;
      if (trustedBundleId) {
        if ((topRelayId && topRelayId !== trustedBundleId)
          || (payloadRelayId && payloadRelayId !== trustedBundleId)
          || (payloadBundleId && payloadBundleId !== trustedBundleId)) {
          return { ok: false, reason: "bundle_id_mismatch" };
        }
        resolvedRelayId = trustedBundleId;
      } else {
        if (topRelayId && payloadRelayId && topRelayId !== payloadRelayId) {
          return { ok: false, reason: "bundle_id_mismatch" };
        }
        resolvedRelayId = topRelayId
          ?? payloadRelayId
          ?? payloadBundleId
          ?? (event.event_id ? `bnd_${event.event_id}` : null);
        if (!resolvedRelayId) {
          return { ok: false, reason: "missing_bundle_id" };
        }
      }
      const frame = {
        relay_id: resolvedRelayId,
        ...(trustedBundleId ? { bundle_id: trustedBundleId } : {}),
        op: payload.op ?? event.op,
        from_machine: payload.from_machine ?? event.source_machine,
        to_machine: payload.to_machine ?? this.#localMachineId,
        source: payload.source ?? event.source ?? "core/system/dispatcher",
        recipients: Array.isArray(payload.recipients) ? payload.recipients : (event.recipients ?? []),
        ...(payload.in_reply_to ? { in_reply_to: payload.in_reply_to } : {}),
        body: typeof payload.body === "string" ? payload.body : "",
        body_sha256: payload.body_sha256 ?? computeBodySha256(typeof payload.body === "string" ? payload.body : ""),
        meta: isPlainObject(payload.meta) ? payload.meta : (isPlainObject(event.meta) ? event.meta : {}),
        payload_json: payload,
      };
      if (payload.body_sha256 && computeBodySha256(frame.body) !== payload.body_sha256) {
        return { ok: false, reason: "body_sha256_mismatch" };
      }
      return { ok: true, frame };
    }

    const normalizeDecodedFrame = raw => {
      const normalizedSource = typeof raw.source === "string"
        ? raw.source
        : (typeof raw.source_text === "string" ? raw.source_text : (raw.source ? formatEndpoint(raw.source, "source") : "core/system/dispatcher"));
      const normalizedRecipients = Array.isArray(raw.recipients_text)
        ? [...raw.recipients_text]
        : (Array.isArray(raw.recipients)
          ? raw.recipients.map((entry, idx) => (typeof entry === "string" ? entry : formatEndpoint(entry, `recipients[${idx}]`)))
          : []);
      return { ...raw, source: normalizedSource, recipients: normalizedRecipients };
    };

    if (isPlainObject(event.frame)) {
      const raw = event.frame;
      if (raw.body_sha256 && typeof raw.body === "string" && computeBodySha256(raw.body) !== raw.body_sha256) {
        return { ok: false, reason: "body_sha256_mismatch" };
      }
      return { ok: true, frame: normalizeDecodedFrame(raw) };
    }
    if (typeof event.frame_text === "string") {
      const decoded = this.#frameCodec && typeof this.#frameCodec.decodeRelayFrame === "function"
        ? this.#frameCodec.decodeRelayFrame(event.frame_text)
        : envelopeDecodeRelayFrame(event.frame_text);
      if (!decoded?.ok || !isPlainObject(decoded.frame)) return decoded;
      return { ok: true, frame: normalizeDecodedFrame(decoded.frame) };
    }
    return { ok: false, reason: "missing_frame" };
  }

  async handleInboundEvent(event, { isBundle = false, signal } = {}) {
    if (!isPlainObject(event)) {
      return { handled: false, status: "rejected", code: "invalid_event" };
    }

    const parsed = this.#normalizeInboundEventFrame(event, isBundle);
    if (!parsed.ok) {
      return { handled: false, status: "rejected", code: parsed.reason };
    }
    const frame = parsed.frame;
    const fromMachine = frame.from_machine;

    // 1. 自回声丢弃
    if (fromMachine === this.#localMachineId || event.source_machine === this.#localMachineId) {
      return { handled: false, status: "ignored", code: "self_echo", relay_id: frame.relay_id };
    }

    // 2. 目标机不匹配丢弃
    if (frame.to_machine && frame.to_machine !== this.#localMachineId) {
      return { handled: false, status: "ignored", code: "wrong_target_machine", relay_id: frame.relay_id };
    }

    // 3. 伪造来源机 / 未核验发送者拒收
    if (event.sender_verified === false) {
      return {
        handled: false,
        status: "rejected",
        code: isBundle ? "relay_file_sender_unverified" : "sender_unverified",
        ...(isBundle ? { retain_bundle: true } : {}),
        relay_id: frame.relay_id,
      };
    }
    if (isBundle && event.sender_id !== undefined && (typeof event.sender_id !== "string" || !event.sender_id.trim())) {
      return {
        handled: false,
        status: "rejected",
        code: "relay_file_sender_unverified",
        retain_bundle: true,
        relay_id: frame.relay_id,
      };
    }
    if (event.source_machine && fromMachine && event.source_machine !== fromMachine) {
      return { handled: false, status: "rejected", code: "source_machine_mismatch", relay_id: frame.relay_id };
    }

    // 4. 防环 hop_count > 1 拒收
    const hopCount = frame.meta?.hop_count ?? 1;
    if (!Number.isSafeInteger(hopCount) || hopCount < 1 || hopCount > 1) {
      return { handled: false, status: "rejected", code: "hop_limit_exceeded", relay_id: frame.relay_id };
    }

    // 5. 真 LRU 去重检查
    const dedupeId = isBundle
      ? `bundle:${event.event_id ?? frame.relay_id}`
      : `text:${event.event_id ?? frame.relay_id}`;
    if (dedupeId && this.#processedCache.has(dedupeId)) {
      return { handled: false, status: "duplicate", code: "duplicate_event", relay_id: frame.relay_id };
    }

    const op = frame.op;

    // 6. 应答类 op：严格三元配对 (request_id, expectedTargetMachine, relay_key)
    if (REPLY_OPS.has(op)) {
      const requestId = frame.meta?.in_reply_to_request_id ?? frame.meta?.request_id;
      const pending = requestId ? this.#pendingRequests.get(requestId) : null;
      if (!pending) {
        return { handled: false, status: "ignored", code: "unknown_request_id", relay_id: frame.relay_id };
      }
      const eventSourceMachine = event.source_machine ?? fromMachine;
      let matched = pending.expectedOp === op
        && pending.expectedTargetMachine === fromMachine
        && pending.expectedTargetMachine === eventSourceMachine
        && pending.expectedRelayKey !== null
        && pending.expectedRelayKey === event.relay_key;
      if (matched && (pending.strictReplyPairing === true || op === "snapshot_reply")) {
        const replyInReplyTo = typeof frame.in_reply_to === "string" && frame.in_reply_to.trim()
          ? frame.in_reply_to.trim()
          : null;
        const replyGroupId = event.group_id !== undefined && event.group_id !== null
          ? String(event.group_id)
          : null;
        const replyRouteGen = Number.isSafeInteger(event.route_generation)
          ? event.route_generation
          : null;
        if (pending.strictReplyPairing === true) {
          matched = Boolean(
            pending.originRelayId !== null
            && replyInReplyTo === pending.originRelayId
            && pending.expectedGroupId !== null
            && replyGroupId === pending.expectedGroupId
            && pending.expectedRouteGeneration !== null
            && replyRouteGen === pending.expectedRouteGeneration,
          );
        } else {
          if (pending.originRelayId !== null && replyInReplyTo !== pending.originRelayId) matched = false;
          if (pending.expectedGroupId !== null && replyGroupId !== pending.expectedGroupId) matched = false;
          if (pending.expectedRouteGeneration !== null && replyRouteGen !== pending.expectedRouteGeneration) matched = false;
        }
      }
      if (!matched) {
        return { handled: false, status: "rejected", code: "request_pairing_mismatch", relay_id: frame.relay_id };
      }

      let payload;
      if (isBundle && isPlainObject(frame.payload_json?.reply)) {
        payload = cloneJson(frame.payload_json.reply);
      } else if (isPlainObject(frame.meta?.reply)) {
        payload = cloneJson(frame.meta.reply);
      } else if (op === "snapshot_reply") {
        let parsedSnapshotBody = null;
        if (frame.body && frame.body.trim().startsWith("{") && frame.meta?.structured_body === true) {
          try {
            parsedSnapshotBody = JSON.parse(frame.body);
          } catch {
            parsedSnapshotBody = null;
          }
        }
        payload = {
          ok: frame.meta?.ok !== false,
          ...(frame.meta?.error ? { error: cloneJson(frame.meta.error) } : {}),
          snapshot: parsedSnapshotBody ?? {
            text: frame.body,
            preview: frame.body,
            ...(isPlainObject(frame.meta?.snapshot_meta) ? cloneJson(frame.meta.snapshot_meta) : {}),
            truncated: frame.meta?.truncated === true,
            omitted: frame.meta?.omitted === true,
          },
          truncated: frame.meta?.truncated === true,
          omitted: frame.meta?.omitted === true,
          ...(frame.meta?.original_chars !== undefined ? { original_chars: frame.meta.original_chars } : {}),
          ...(frame.meta?.returned_chars !== undefined ? { returned_chars: frame.meta.returned_chars } : {}),
        };
      } else {
        let parsedBody = null;
        if (frame.body && frame.body.trim().startsWith("{")) {
          try {
            parsedBody = JSON.parse(frame.body);
          } catch {
            parsedBody = null;
          }
        }
        payload = parsedBody ?? {
          ok: frame.meta?.ok !== false,
          ...(frame.meta?.error ? { error: cloneJson(frame.meta.error) } : {}),
          ...(frame.meta?.status ? { status: cloneJson(frame.meta.status) } : {}),
          ...(frame.meta?.items ? { items: cloneJson(frame.meta.items) } : {}),
          ...(frame.meta?.conversations ? { conversations: cloneJson(frame.meta.conversations) } : {}),
          ...(frame.meta?.next_cursor !== undefined ? { next_cursor: frame.meta.next_cursor } : {}),
        };
      }

      this.#processedCache.set(dedupeId, this.#now());
      pending.resolve({ event, frame, payload });
      return { handled: true, status: "applied", op, relay_id: frame.relay_id };
    }

    // 7. delivery_ack：推进 4 层状态
    if (op === "delivery_ack") {
      const originKey = frame.meta?.origin_relay_id ?? frame.in_reply_to ?? frame.meta?.request_id;
      const outbound = originKey ? this.#outboundRecords.get(originKey) : null;
      if (outbound) {
        if (outbound.target_machine !== fromMachine || (outbound.relay_key && event.relay_key && outbound.relay_key !== event.relay_key)) {
          return { handled: false, status: "rejected", code: "ack_pairing_mismatch", relay_id: frame.relay_id };
        }
        outbound.stages.remote_core_persisted = {
          ok: frame.meta?.ok !== false,
          at: new Date(this.#now()).toISOString(),
          ...(frame.meta?.error ? { error: cloneJson(frame.meta.error) } : {}),
        };
        if (Array.isArray(frame.meta?.recipient_deliveries)) {
          outbound.stages.target_delivered = {
            status: frame.meta.recipient_deliveries.every(d => d.delivery_status === "accepted") ? "accepted" : "partial",
            recipients: cloneJson(frame.meta.recipient_deliveries),
          };
        }
      }
      if (typeof this.#localHandlers.applyRemoteDeliveryAck === "function") {
        await this.#localHandlers.applyRemoteDeliveryAck({
          event,
          frame,
          from_machine: fromMachine,
          origin_relay_id: frame.meta?.origin_relay_id ?? frame.in_reply_to ?? null,
          request_id: frame.meta?.request_id ?? null,
          recipient_deliveries: frame.meta?.recipient_deliveries ?? [],
          ok: frame.meta?.ok !== false,
          error: frame.meta?.error ?? null,
        });
      }
      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id };
    }

    // 8. processing_ack：先鉴源配对，再做偏序保护防乱序回退
    if (op === "processing_ack") {
      const outbound = (frame.meta?.origin_relay_id && this.#outboundRecords.get(frame.meta.origin_relay_id))
        || (frame.in_reply_to && this.#outboundRecords.get(frame.in_reply_to));
      if (outbound && (outbound.target_machine !== fromMachine || (outbound.relay_key && event.relay_key && outbound.relay_key !== event.relay_key))) {
        return { handled: false, status: "rejected", code: "ack_pairing_mismatch", relay_id: frame.relay_id };
      }
      const originMessageId = frame.meta?.origin_message_id ?? frame.meta?.request_id ?? frame.in_reply_to;
      const incoming = {
        processing: frame.meta?.processing,
        ack_seq: frame.meta?.ack_seq,
        note: frame.meta?.note ?? null,
      };
      let current = originMessageId ? this.#remoteProcessingState.get(originMessageId) : null;
      if (originMessageId && typeof this.#localHandlers.getMessageProcessingState === "function") {
        const authoritative = await this.#localHandlers.getMessageProcessingState(originMessageId);
        if (authoritative) current = authoritative;
      }
      if (!shouldAcceptProcessingUpdate(current, incoming)) {
        this.#processedCache.set(dedupeId, this.#now());
        return {
          handled: false,
          status: "ignored",
          code: "stale_processing_ack",
          op,
          relay_id: frame.relay_id,
        };
      }
      if (originMessageId) {
        this.#remoteProcessingState.set(originMessageId, {
          processing: incoming.processing,
          ack_seq: incoming.ack_seq ?? ((current?.ack_seq ?? 0) + 1),
          note: incoming.note,
          updated_at: this.#now(),
        });
      }
      if (outbound) {
        outbound.stages.target_processing = {
          status: incoming.processing,
          ack_seq: incoming.ack_seq ?? 0,
          ...(incoming.note ? { note: incoming.note } : {}),
          at: new Date(this.#now()).toISOString(),
        };
      }
      if (typeof this.#localHandlers.applyRemoteProcessingAck === "function") {
        await this.#localHandlers.applyRemoteProcessingAck({
          event,
          frame,
          from_machine: fromMachine,
          origin_relay_id: frame.meta?.origin_relay_id ?? frame.in_reply_to ?? null,
          origin_message_id: originMessageId ?? null,
          local_message_id: frame.meta?.local_message_id ?? null,
          processing: incoming.processing,
          ack_seq: incoming.ack_seq ?? null,
          note: incoming.note,
          reply_message_id: frame.meta?.reply_message_id ?? null,
          reply_route: {
            relay_key: event.relay_key,
            group_id: event.group_id,
            route_generation: event.route_generation,
          },
        });
      }
      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id };
    }

    const peerPolicy = this.#peerPolicy(fromMachine);
    const verifiedSenderId = typeof event.sender_id === "string" && event.sender_id.trim()
      ? event.sender_id.trim()
      : null;
    const remotePrincipal = Object.freeze({
      kind: "remote_peer_principal",
      from_machine: fromMachine,
      sender_id: verifiedSenderId,
      relay_key: event.relay_key,
      group_id: event.group_id,
      route_generation: event.route_generation,
      policy: Object.freeze({ ...peerPolicy }),
    });

    // 9. 自定义已注册 op（第二波交流板 board_delta / board_dissolved / board_state_sync / board_ack 等）
    if (this.#opHandlers.has(op)) {
      const handler = this.#opHandlers.get(op);
      const result = await handler({
        event,
        frame,
        isBundle,
        staged_files: event.staged_files ?? [],
        remotePrincipal,
        reply: async ({ op: replyOp, body = "", meta = {}, payloadJson, allowBundle = false }) => {
          return this.#sendOriginalRouteReply(event, frame, {
            op: replyOp,
            body,
            meta,
            payloadJson,
            allowBundle,
            dedupeSuffix: replyOp,
            signal,
          });
        },
      });
      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id, result };
    }

    // 10. 入站 message
    if (op === "message") {
      if (peerPolicy.allow_message !== true) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "delivery_ack",
          meta: {
            ok: false,
            origin_relay_id: frame.relay_id,
            request_id: frame.meta?.request_id ?? null,
            error: { code: "forbidden", message: "来源机器未获跨机投递授权" },
          },
          dedupeSuffix: "delivery_ack_denied",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: "forbidden", op, relay_id: frame.relay_id };
      }

      let sourceEndpointValid = false;
      try {
        if (typeof frame.source === "string" && frame.source !== "core/system/dispatcher") {
          const parsedSource = parseEndpoint(frame.source);
          sourceEndpointValid = Boolean(parsedSource.host && parsedSource.surface && parsedSource.conversation_id);
        }
      } catch {
        sourceEndpointValid = false;
      }
      const senderAccountOk = event.sender_id === undefined || Boolean(verifiedSenderId);
      const sourceIdentityVerified = Boolean(
        sourceEndpointValid
        && senderAccountOk
        && event.source_machine === frame.from_machine
        && event.sender_verified !== false
        && frame.meta?.source_identity_verified === true,
      );
      const visibleAllRecipients = this.#applyGroupVisibilityToRecipients(
        frame.meta?.all_recipients ?? [],
        frame.recipients ?? [],
        peerPolicy,
      );
      const replyRoute = {
        relay_key: event.relay_key,
        group_id: String(event.group_id),
        route_generation: event.route_generation,
      };

      if (typeof this.#localHandlers.deliverInboundMessage !== "function") {
        throw new CoreError("invalid_state", "未配置 deliverInboundMessage 本地处理器");
      }

      const boundInTransaction = new Set();
      const bindInboundMapping = item => {
        if (!item?.local_message_id || !item?.target_key) return null;
        const bound = this.recordInboundMessageMapping({
          local_message_id: item.local_message_id,
          origin_relay_id: frame.relay_id,
          origin_message_id: item.origin_message_id ?? frame.meta?.origin_message_id ?? frame.meta?.request_id ?? frame.relay_id,
          from_machine: fromMachine,
          reply_relay_key: replyRoute.relay_key,
          reply_group_id: replyRoute.group_id,
          reply_route_generation: replyRoute.route_generation,
          target_key: item.target_key,
          source_endpoint: item.source_endpoint ?? endpointFromTargetKey(item.target_key),
          origin_source_endpoint: sourceEndpointValid ? frame.source : "",
          nowMs: this.#now(),
        });
        boundInTransaction.add(item.local_message_id);
        return bound;
      };

      let deliveryResult;
      let deliveryDenial = null;
      try {
        deliveryResult = await this.#localHandlers.deliverInboundMessage({
          event,
          frame,
          from_machine: fromMachine,
          source: frame.source,
          recipients: [...(frame.recipients ?? [])],
          all_recipients: visibleAllRecipients,
          body: frame.body,
          in_reply_to: frame.in_reply_to ?? null,
          meta: cloneJson(frame.meta ?? {}),
          staged_files: Array.isArray(event.staged_files) ? cloneJson(event.staged_files) : [],
          sender_id: verifiedSenderId,
          source_identity_verified: sourceIdentityVerified,
          remotePrincipal,
          reply_route: replyRoute,
          bindInboundMapping,
        });
        deliveryDenial = extractTypedDenial(deliveryResult, "forbidden", "本机拒绝接收跨机消息");
      } catch (error) {
        if (error instanceof CoreError) {
          deliveryDenial = extractTypedDenial(error, "forbidden", "本机拒绝接收跨机消息");
        } else {
          throw error;
        }
      }
      if (deliveryDenial) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "delivery_ack",
          meta: {
            ok: false,
            origin_relay_id: frame.relay_id,
            request_id: frame.meta?.request_id ?? null,
            error: deliveryDenial,
          },
          dedupeSuffix: `delivery_ack_denied_${deliveryDenial.code}`,
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: deliveryDenial.code, op, relay_id: frame.relay_id };
      }

      const deliveredList = Array.isArray(deliveryResult?.deliveries)
        ? deliveryResult.deliveries
        : (deliveryResult?.local_message_id ? [deliveryResult] : []);

      for (const item of deliveredList) {
        if (item?.local_message_id && item?.target_key && !boundInTransaction.has(item.local_message_id)) {
          this.recordInboundMessageMapping({
            local_message_id: item.local_message_id,
            origin_relay_id: frame.relay_id,
            origin_message_id: item.origin_message_id ?? frame.meta?.origin_message_id ?? frame.meta?.request_id ?? frame.relay_id,
            from_machine: fromMachine,
            reply_relay_key: replyRoute.relay_key,
            reply_group_id: replyRoute.group_id,
            reply_route_generation: replyRoute.route_generation,
            target_key: item.target_key,
            source_endpoint: item.source_endpoint ?? endpointFromTargetKey(item.target_key),
            origin_source_endpoint: sourceEndpointValid ? frame.source : "",
            nowMs: this.#now(),
          });
        }
      }

      await this.#sendOriginalRouteReply(event, frame, {
        op: "delivery_ack",
        meta: {
          ok: true,
          origin_relay_id: frame.relay_id,
          request_id: frame.meta?.request_id ?? null,
          recipient_deliveries: deliveredList.map(item => ({
            local_message_id: item.local_message_id ?? null,
            target_key: item.target_key ?? null,
            delivery_status: item.delivery_status ?? "accepted",
          })),
        },
        dedupeSuffix: "delivery_ack",
        signal,
      });

      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id, source_identity_verified: sourceIdentityVerified };
    }

    // 11. 入站 status_query
    if (op === "status_query") {
      const requestId = frame.meta?.request_id ?? null;
      if (peerPolicy.allow_status !== true) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "status_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: "forbidden", message: "来源机器未获跨机状态查询授权" },
          },
          dedupeSuffix: "status_reply_denied",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: "forbidden", op, relay_id: frame.relay_id };
      }
      if (typeof this.#localHandlers.queryLocalStatus !== "function") {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "status_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: "status_reader_not_configured", message: "本机未配置状态查询处理器" },
          },
          dedupeSuffix: "status_reply_unconfigured",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: true, status: "applied", op, relay_id: frame.relay_id };
      }
      let status;
      let statusDenial = null;
      try {
        status = await this.#localHandlers.queryLocalStatus({
          scope: frame.meta?.scope ?? "conversation",
          target: frame.meta?.target,
          remotePrincipal,
        });
        statusDenial = extractTypedDenial(status, "forbidden", "本机拒绝提供状态查询");
      } catch (error) {
        if (error instanceof CoreError) {
          statusDenial = extractTypedDenial(error, "forbidden", "本机拒绝提供状态查询");
        } else {
          throw error;
        }
      }
      if (statusDenial) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "status_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: statusDenial,
          },
          dedupeSuffix: `status_reply_denied_${statusDenial.code}`,
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: statusDenial.code, op, relay_id: frame.relay_id };
      }
      await this.#sendOriginalRouteReply(event, frame, {
        op: "status_reply",
        body: JSON.stringify({ ok: true, status }),
        meta: {
          in_reply_to_request_id: requestId,
          ok: true,
        },
        dedupeSuffix: "status_reply",
        signal,
      });
      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id };
    }

    // 12. 入站 list_query
    if (op === "list_query") {
      const requestId = frame.meta?.request_id ?? null;
      const requestedHost = frame.meta?.host;
      const hostAllowed = !Array.isArray(peerPolicy.allowed_host_lists)
        || (requestedHost !== undefined && peerPolicy.allowed_host_lists.includes(requestedHost));
      if (peerPolicy.allow_directory !== true || !hostAllowed) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "list_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: "forbidden", message: "来源机器未获目录查询授权" },
          },
          dedupeSuffix: "list_reply_denied",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: "forbidden", op, relay_id: frame.relay_id };
      }
      const passthroughCursor = !this.#signDirectoryCursor || peerPolicy.passthrough_directory_cursor === true;
      const decodedCursor = passthroughCursor
        ? { ok: true, cursor: frame.meta?.cursor ?? null }
        : this.#decodeSignedCursor(fromMachine, frame.meta?.cursor);
      if (!decodedCursor.ok) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "list_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: decodedCursor.code, message: "目录查询游标归属校验失败" },
          },
          dedupeSuffix: "list_reply_bad_cursor",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: decodedCursor.code, op, relay_id: frame.relay_id };
      }
      if (typeof this.#localHandlers.queryLocalDirectory !== "function") {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "list_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: "unsupported_op", message: "本机未配置目录查询处理器" },
          },
          dedupeSuffix: "list_reply_unconfigured",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: true, status: "applied", op, relay_id: frame.relay_id };
      }
      let dirResult;
      let dirDenial = null;
      try {
        dirResult = await this.#localHandlers.queryLocalDirectory({
          host: requestedHost,
          surface: frame.meta?.surface,
          limit: frame.meta?.limit,
          cursor: decodedCursor.cursor,
          remotePrincipal,
        });
        dirDenial = extractTypedDenial(dirResult, "forbidden", "本机拒绝提供目录查询");
      } catch (error) {
        if (error instanceof CoreError) {
          dirDenial = extractTypedDenial(error, "forbidden", "本机拒绝提供目录查询");
        } else {
          throw error;
        }
      }
      if (dirDenial) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "list_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: dirDenial,
          },
          dedupeSuffix: `list_reply_denied_${dirDenial.code}`,
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: dirDenial.code, op, relay_id: frame.relay_id };
      }
      const rawItems = Array.isArray(dirResult?.conversations)
        ? dirResult.conversations
        : (Array.isArray(dirResult?.items) ? dirResult.items : []);
      const filteredItems = this.#applyGroupVisibilityToDirectory(rawItems, peerPolicy);
      const signedNextCursor = passthroughCursor
        ? (dirResult?.next_cursor ?? null)
        : this.#encodeSignedCursor(fromMachine, dirResult?.next_cursor ?? null);
      const replyPayload = {
        ok: true,
        items: filteredItems,
        conversations: filteredItems,
        next_cursor: signedNextCursor,
        ...(dirResult?.partial === true ? { partial: true } : {}),
        ...(dirResult?.coverage_source ? { coverage_source: dirResult.coverage_source } : {}),
        ...(Array.isArray(dirResult?.coverage_reasons) ? { coverage_reasons: dirResult.coverage_reasons } : {}),
      };
      await this.#sendOriginalRouteReply(event, frame, {
        op: "list_reply",
        body: JSON.stringify(replyPayload),
        meta: {
          in_reply_to_request_id: requestId,
          ok: true,
        },
        payloadJson: { reply: replyPayload },
        allowBundle: peerPolicy.allow_file_bundle !== false,
        dedupeSuffix: "list_reply",
        signal,
      });
      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id };
    }

    // 13. 入站 snapshot_query
    if (op === "snapshot_query") {
      const requestId = frame.meta?.request_id ?? null;
      const targetHost = frame.meta?.target?.host;
      const hostAllowed = !Array.isArray(peerPolicy.allowed_host_snapshots)
        || (targetHost !== undefined && peerPolicy.allowed_host_snapshots.includes(targetHost));
      if (peerPolicy.allow_snapshot !== true || !hostAllowed) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "snapshot_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: "forbidden", message: "来源机器未获快照查询授权" },
          },
          dedupeSuffix: "snapshot_reply_denied",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: "forbidden", op, relay_id: frame.relay_id };
      }
      if (typeof this.#localHandlers.queryLocalSnapshot !== "function") {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "snapshot_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: { code: "unsupported_op", message: "本机未配置快照查询处理器" },
          },
          dedupeSuffix: "snapshot_reply_unconfigured",
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: true, status: "applied", op, relay_id: frame.relay_id };
      }

      let snapSourceEndpoint = null;
      try {
        if (typeof frame.source === "string" && frame.source !== "core/system/dispatcher") {
          const parsedSnapSource = parseEndpoint(frame.source);
          if (parsedSnapSource.host && parsedSnapSource.surface && parsedSnapSource.conversation_id) {
            snapSourceEndpoint = frame.source;
          }
        }
      } catch {
        snapSourceEndpoint = null;
      }
      const snapSenderAccountOk = event.sender_id === undefined || Boolean(verifiedSenderId);
      const snapSourceIdentityVerified = Boolean(
        snapSourceEndpoint
        && snapSenderAccountOk
        && event.source_machine === frame.from_machine
        && event.sender_verified !== false
        && frame.meta?.source_identity_verified === true,
      );
      const snapshotPrincipal = Object.freeze({
        ...remotePrincipal,
        source_endpoint: snapSourceEndpoint,
        source_identity_verified: snapSourceIdentityVerified,
      });

      let rawSnapshot;
      let snapDenial = null;
      try {
        rawSnapshot = await this.#localHandlers.queryLocalSnapshot({
          target: frame.meta?.target,
          last_rounds: frame.meta?.last_rounds,
          max_bytes: frame.meta?.max_bytes,
          max_chars: frame.meta?.max_chars,
          source_endpoint: snapSourceEndpoint,
          source_identity_verified: snapSourceIdentityVerified,
          remotePrincipal: snapshotPrincipal,
          signal,
        });
        snapDenial = extractTypedDenial(rawSnapshot, "forbidden", "本机拒绝提供快照查询");
      } catch (error) {
        if (error instanceof CoreError) {
          snapDenial = extractTypedDenial(error, "forbidden", "本机拒绝提供快照查询");
        } else {
          throw error;
        }
      }
      if (snapDenial) {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "snapshot_reply",
          meta: {
            in_reply_to_request_id: requestId,
            ok: false,
            error: snapDenial,
          },
          dedupeSuffix: `snapshot_reply_denied_${snapDenial.code}`,
          signal,
        });
        this.#processedCache.set(dedupeId, this.#now());
        return { handled: false, status: "rejected", code: snapDenial.code, op, relay_id: frame.relay_id };
      }

      const isStructuredRounds = isPlainObject(rawSnapshot) && Array.isArray(rawSnapshot.rounds);
      const snapshotText = isStructuredRounds
        ? JSON.stringify(rawSnapshot)
        : (typeof rawSnapshot === "string"
          ? rawSnapshot
          : (typeof rawSnapshot?.text === "string"
            ? rawSnapshot.text
            : (typeof rawSnapshot?.content === "string" ? rawSnapshot.content : JSON.stringify(rawSnapshot ?? {}))));

      const baseMeta = {
        in_reply_to_request_id: requestId,
        ok: true,
        truncated: false,
        omitted: false,
        ...(isStructuredRounds ? { structured_body: true } : {}),
      };
      const requestedMaxChars = Number.isSafeInteger(frame.meta?.max_chars) && frame.meta.max_chars > 0
        ? frame.meta.max_chars
        : null;
      const snapshotMeta = isPlainObject(rawSnapshot) ? {
        ...(rawSnapshot.conversation_id !== undefined ? { conversation_id: rawSnapshot.conversation_id } : {}),
        ...(rawSnapshot.status !== undefined ? { status: rawSnapshot.status } : {}),
        ...(rawSnapshot.observed_at !== undefined ? { observed_at: rawSnapshot.observed_at } : {}),
        ...(rawSnapshot.title !== undefined ? { title: rawSnapshot.title } : {}),
      } : {};
      const fullEstimate = this.#measureFrame({
        relay_id: "rly_00000000-0000-0000-0000-000000000000",
        op: "snapshot_reply",
        from_machine: this.#localMachineId,
        to_machine: fromMachine,
        source: "core/system/dispatcher",
        recipients: [safeEndpointOrSystem(frame.source)],
        in_reply_to: frame.relay_id,
        body: snapshotText,
        meta: {
          ...(Object.keys(snapshotMeta).length ? { ...baseMeta, snapshot_meta: snapshotMeta } : baseMeta),
          hop_count: 1,
          observed_at: new Date(this.#now()).toISOString(),
        },
      });

      const exceedsFrame = fullEstimate.charLength > this.#limits.maxFrameChars
        || fullEstimate.cqLength > this.#limits.maxFrameChars;
      const exceedsRequested = requestedMaxChars !== null && [...snapshotText].length > requestedMaxChars;
      const canUseBundle = typeof this.#transport.sendBundle === "function"
        && this.#transport.bundleEnabled !== false
        && peerPolicy.allow_file_bundle !== false;

      if (exceedsFrame && canUseBundle && !exceedsRequested) {
        try {
          const fullReply = {
            ok: true,
            snapshot: isPlainObject(rawSnapshot) ? cloneJson(rawSnapshot) : { text: snapshotText },
            truncated: false,
            omitted: false,
          };
          await this.#sendOriginalRouteReply(event, frame, {
            op: "snapshot_reply",
            body: snapshotText,
            meta: baseMeta,
            payloadJson: { reply: fullReply },
            allowBundle: true,
            dedupeSuffix: "snapshot_reply_bundle",
            signal,
          });
          this.#processedCache.set(dedupeId, this.#now());
          return { handled: true, status: "applied", op, relay_id: frame.relay_id, via_bundle: true };
        } catch (error) {
          if (!BUNDLE_DEGRADE_ERROR_CODES.has(normalizeRelayErrorCode(error))) throw error;
        }
      }

      if (exceedsFrame || exceedsRequested) {
        const plainSource = isStructuredRounds
          ? rawSnapshot.rounds.flatMap(r => (r.messages ?? []).map(m => `${m.role}: ${m.text}`)).join("\n")
          : snapshotText;
        const truncated = this.#buildTruncatedSnapshotText(plainSource, frame.meta, event, frame, {
          in_reply_to_request_id: requestId,
          ok: true,
          ...(Object.keys(snapshotMeta).length ? { snapshot_meta: snapshotMeta } : {}),
        });
        await this.#sendOriginalRouteReply(event, frame, {
          op: "snapshot_reply",
          body: truncated.slice,
          meta: truncated.candidateMeta,
          allowBundle: false,
          dedupeSuffix: "snapshot_reply_truncated",
          signal,
        });
      } else {
        await this.#sendOriginalRouteReply(event, frame, {
          op: "snapshot_reply",
          body: snapshotText,
          meta: baseMeta,
          allowBundle: false,
          dedupeSuffix: "snapshot_reply",
          signal,
        });
      }

      this.#processedCache.set(dedupeId, this.#now());
      return { handled: true, status: "applied", op, relay_id: frame.relay_id };
    }

    // 14. 未知或未注册的 op：绝不走旧任务或消息投递，直接报 unsupported_op
    return {
      handled: false,
      status: "rejected",
      code: "unsupported_op",
      op,
      relay_id: frame.relay_id,
    };
  }

  async pollOnce({ signal } = {}) {
    this.#assertOpen();
    if (this.#pollInFlight) return this.#pollInFlight;

    const run = async () => {
      const nowMs = this.#now();
      if (nowMs < this.#backoffUntilMs) {
        return {
          processed: 0,
          ignored: 0,
          rejected: [],
          bundle_acked: 0,
          skipped_backoff: true,
          backoff_until_ms: this.#backoffUntilMs,
        };
      }

      const { signal: mergedSignal, cleanup } = composeSignals([this.#lifecycleAbort.signal, signal]);
      const summary = {
        processed: 0,
        ignored: 0,
        rejected: [],
        bundle_acked: 0,
        bundle_errors: [],
        skipped_backoff: false,
        backoff_until_ms: this.#backoffUntilMs,
      };

      try {
        if (typeof this.#transport.poll === "function") {
          try {
            await this.#transport.poll({}, { signal: mergedSignal });
          } catch (error) {
            const retryMs = this.#recordRateLimit(error);
            if (retryMs > 0) {
              summary.skipped_backoff = true;
              summary.backoff_until_ms = this.#backoffUntilMs;
              return summary;
            }
            throw error;
          }
        }

        if (typeof this.#transport.readEvents === "function") {
          let textResult;
          try {
            textResult = await this.#transport.readEvents({
              ...(this.#textCursor !== null ? { cursor: this.#textCursor } : {}),
              limit: this.#limits.readLimit,
            }, { signal: mergedSignal });
          } catch (error) {
            const retryMs = this.#recordRateLimit(error);
            if (retryMs > 0) {
              summary.skipped_backoff = true;
              summary.backoff_until_ms = this.#backoffUntilMs;
              return summary;
            }
            throw error;
          }

          const events = Array.isArray(textResult?.events) ? textResult.events : [];
          let textPageCompleted = true;
          for (const event of events) {
            if (this.#closed || mergedSignal?.aborted) {
              textPageCompleted = false;
              break;
            }
            const outcome = await this.handleInboundEvent(event, { isBundle: false, signal: mergedSignal });
            if (outcome.handled) summary.processed += 1;
            else if (outcome.status === "rejected") summary.rejected.push(outcome);
            else summary.ignored += 1;
          }
          if (textPageCompleted && textResult?.next_cursor !== undefined && textResult.next_cursor !== null) {
            this.#textCursor = textResult.next_cursor;
          }
        }

        if (typeof this.#transport.pollBundles === "function") {
          try {
            const pollRes = await this.#transport.pollBundles({
              cursor: this.#bundlePollCursor,
              limit: this.#limits.bundleReadLimit,
            }, { signal: mergedSignal });
            this.#bundlePollCursor = pollRes?.next_cursor ?? null;
          } catch (error) {
            const code = normalizeRelayErrorCode(error);
            if (code !== "bundle_transport_unavailable") {
              const retryMs = this.#recordRateLimit(error);
              if (retryMs > 0) {
                summary.skipped_backoff = true;
                summary.backoff_until_ms = this.#backoffUntilMs;
                return summary;
              }
              throw error;
            }
          }
        }

        if (typeof this.#transport.readBundleEvents === "function") {
          // 整块 B events_read 按 64 位 SHA-256 hex 字典序分页，每轮必须从 cursor=null 起步扫完本轮分页，绝不跨轮冻结游标
          const maxBundlePages = 16;
          let pageCursor = null;
          for (let page = 0; page < maxBundlePages; page += 1) {
            if (this.#closed || mergedSignal?.aborted) break;
            let bundleResult = null;
            try {
              bundleResult = await this.#transport.readBundleEvents({
                cursor: pageCursor,
                limit: this.#limits.bundleReadLimit,
              }, { signal: mergedSignal });
            } catch (error) {
              const code = normalizeRelayErrorCode(error);
              if (code !== "bundle_transport_unavailable") {
                const retryMs = this.#recordRateLimit(error);
                if (retryMs > 0) {
                  summary.skipped_backoff = true;
                  summary.backoff_until_ms = this.#backoffUntilMs;
                  return summary;
                }
                throw error;
              }
              break;
            }

            if (Array.isArray(bundleResult?.errors) && bundleResult.errors.length > 0) {
              for (const bErr of bundleResult.errors) {
                summary.bundle_errors.push(bErr);
                this.#onError(new CoreError(
                  normalizeRelayErrorCode(bErr?.code ?? "relay_file_body_invalid"),
                  bErr?.message ?? "文件包事件读取上报异常",
                  { bundle_error: bErr },
                ));
              }
            }

            const bundleEvents = Array.isArray(bundleResult?.events) ? bundleResult.events : [];
            let pageAborted = false;
            for (const event of bundleEvents) {
              if (this.#closed || mergedSignal?.aborted) {
                pageAborted = true;
                break;
              }
              const takeoverStarted = this.#now();
              const outcome = await this.handleInboundEvent(event, { isBundle: true, signal: mergedSignal });
              if (outcome.handled) summary.processed += 1;
              else if (outcome.status === "rejected") summary.rejected.push(outcome);
              else summary.ignored += 1;

              const shouldAckBundle = Boolean(
                event.event_id
                && outcome.retain_bundle !== true
                && typeof this.#transport.ackBundleEvents === "function"
                && (outcome.handled || outcome.status === "duplicate" || outcome.status === "ignored" || outcome.status === "rejected"),
              );
              if (shouldAckBundle) {
                await this.#transport.ackBundleEvents({ event_ids: [event.event_id] }, { signal: mergedSignal });
                const latencyMs = Math.max(0, this.#now() - takeoverStarted);
                this.#bundleAckLatencies.push(latencyMs);
                if (this.#bundleAckLatencies.length > 64) this.#bundleAckLatencies.shift();
                summary.bundle_acked += 1;
                if (latencyMs > this.#limits.bundleAckDeadlineMs) {
                  this.#onError(new CoreError("bundle_ack_deadline_exceeded", "文件包 spool 释放超过预设时限", {
                    event_id: event.event_id,
                    latency_ms: latencyMs,
                    deadline_ms: this.#limits.bundleAckDeadlineMs,
                  }));
                }
              }
            }

            const bundleErrors = Array.isArray(bundleResult?.errors) ? bundleResult.errors : [];
            const nextCursor = bundleResult?.next_cursor ?? null;
            if (pageAborted || nextCursor === null || nextCursor === pageCursor || (bundleEvents.length === 0 && bundleErrors.length === 0)) {
              break;
            }
            pageCursor = nextCursor;
          }
        }

        if (summary.processed > 0 || summary.bundle_acked > 0) {
          this.#consecutiveIdlePolls = 0;
        } else {
          this.#consecutiveIdlePolls += 1;
        }
        return summary;
      } finally {
        cleanup();
      }
    };

    const promise = run().finally(() => {
      if (this.#pollInFlight === promise) this.#pollInFlight = null;
    });
    this.#pollInFlight = promise;
    return promise;
  }

  /**
   * 外发与原次查证统一调度：
   * 1. 对 status === 'unknown' 条目严格走原 dedupe_key / relay_id 查证，绝不更换去重键盲重发；
   * 2. 仅对 status === 'pending'（明确未发）条目沿原三元组 (reply_relay_key, reply_group_id, reply_route_generation) 续发。
   */
  async flushOutbox({ signal, limit = 32 } = {}) {
    this.#assertOpen();
    if (this.#flushInFlight) {
      this.#flushRequestedAgain = true;
      return this.#flushInFlight;
    }
    const runFlushLoop = async () => {
      let combined = null;
      for (let pass = 0; pass < 8; pass += 1) {
        this.#flushRequestedAgain = false;
        const step = await this.#executeFlushOutbox({ signal, limit });
        if (!combined) {
          combined = { ...step };
        } else {
          combined.flushed += step.flushed;
          combined.retried += step.retried;
          combined.unknown += step.unknown;
          combined.verified_sent += step.verified_sent;
          combined.verified_requeued += step.verified_requeued;
          combined.dead_lettered += step.dead_lettered;
          combined.deleted_expired += step.deleted_expired;
          combined.skipped_backoff = step.skipped_backoff;
          combined.backoff_until_ms = step.backoff_until_ms;
        }
        if (!this.#flushRequestedAgain || this.#closed || signal?.aborted || step.skipped_backoff) {
          break;
        }
      }
      return combined;
    };
    const promise = runFlushLoop().finally(() => {
      if (this.#flushInFlight === promise) this.#flushInFlight = null;
    });
    this.#flushInFlight = promise;
    return promise;
  }

  async #executeFlushOutbox({ signal, limit = 32 } = {}) {
    this.#assertOpen();
    const nowMs = this.#now();

    if (this.#ackStore) {
      if (nowMs < this.#backoffUntilMs) {
        return {
          flushed: 0,
          retried: 0,
          unknown: 0,
          verified_sent: 0,
          verified_requeued: 0,
          dead_lettered: 0,
          deleted_expired: 0,
          skipped_backoff: true,
          backoff_until_ms: this.#backoffUntilMs,
        };
      }
      const readyEntries = this.#ackStore.ready(Math.min(50, limit));
      let flushed = 0;
      let retried = 0;
      let unknownCount = 0;
      let deadLettered = 0;

      for (const candidate of readyEntries) {
        if (this.#closed || signal?.aborted) break;
        if (this.#now() < this.#backoffUntilMs) break;
        const entry = this.#ackStore.claim(candidate.event_id);
        if (!entry) continue;

        const sourceEndpoint = endpointFromTargetKey(entry.target_key);
        const dedupeKey = `rack:${entry.event_id.slice(0, 32)}`;
        let requestStarted = false;
        try {
          const result = await this.#withConcurrency(signal, () => this.#transport.sendFrame({
            dedupe_key: dedupeKey,
            target_machine: entry.from_machine,
            reply_relay_key: entry.reply_relay_key,
            reply_group_id: entry.reply_group_id,
            reply_route_generation: entry.reply_route_generation,
            op: "processing_ack",
            source: sourceEndpoint,
            recipients: ["core/system/dispatcher"],
            in_reply_to: entry.origin_relay_id,
            body: "",
            meta: {
              hop_count: 1,
              origin_relay_id: entry.origin_relay_id,
              origin_message_id: entry.origin_message_id,
              local_message_id: entry.local_message_id,
              ack_seq: entry.ack_seq,
              processing: entry.processing,
              observed_at: new Date(this.#now()).toISOString(),
            },
            allow_disclose_recipients: false,
          }, { signal, onRequestStarted: () => { requestStarted = true; } }));

          if (isOutcomeUnknownResult(result)) {
            this.#ackStore.settle(entry.event_id, entry.attempt, "unknown");
            unknownCount += 1;
          } else {
            this.#ackStore.settle(entry.event_id, entry.attempt, "accepted");
            flushed += 1;
          }
        } catch (error) {
          const code = normalizeRelayErrorCode(error);
          this.#recordRateLimit(error);
          if (PERMANENT_OUTBOX_ERROR_CODES.has(code)) {
            this.#ackStore.settle(entry.event_id, entry.attempt, "permanent_rejection");
            deadLettered += 1;
          } else {
            const explicitNotSent = (error?.outcomeUnknown === false && error?.details?.request_sent === false)
              || code === "relay_rate_limited"
              || (!requestStarted && error instanceof CoreError && !isOutcomeUnknownError(error) && error?.details?.request_sent !== true);
            if (explicitNotSent && !isOutcomeUnknownError(error)) {
              this.#ackStore.settle(entry.event_id, entry.attempt, "failed_before_send");
              retried += 1;
            } else {
              // Fail-closed：任何未明确证实发送前失败的异常（含网络断连/普通 Error）一律标 unknown，严禁退回 prepared 盲重发
              this.#ackStore.settle(entry.event_id, entry.attempt, "unknown");
              unknownCount += 1;
            }
          }
          if (code === "relay_rate_limited") break;
        }
      }

      return {
        flushed,
        retried,
        unknown: unknownCount,
        verified_sent: 0,
        verified_requeued: 0,
        dead_lettered: deadLettered,
        deleted_expired: 0,
        skipped_backoff: false,
        backoff_until_ms: this.#backoffUntilMs,
      };
    }

    const pruned = this.#outboxStore.pruneExpired(nowMs);

    if (nowMs < this.#backoffUntilMs) {
      return {
        flushed: 0,
        retried: 0,
        unknown: 0,
        verified_sent: 0,
        verified_requeued: 0,
        dead_lettered: pruned.dead_lettered,
        deleted_expired: pruned.deleted,
        skipped_backoff: true,
        backoff_until_ms: this.#backoffUntilMs,
      };
    }

    let flushed = 0;
    let retried = 0;
    let unknownCount = 0;
    let verifiedSent = 0;
    let verifiedRequeued = 0;
    let deadLettered = pruned.dead_lettered;

    // 阶段 1：对结果未知条目只沿原 dedupe_key / relay_id 查证，绝不盲重发
    const unknownEntries = typeof this.#outboxStore.listUnknownOutbox === "function"
      ? this.#outboxStore.listUnknownOutbox(nowMs, limit)
      : [];
    const verifier = typeof this.#transport.verifyFrameDelivery === "function"
      ? this.#transport.verifyFrameDelivery.bind(this.#transport)
      : (typeof this.#transport.queryFrameReceipt === "function"
        ? this.#transport.queryFrameReceipt.bind(this.#transport)
        : null);

    for (const entry of unknownEntries) {
      if (this.#closed || signal?.aborted) break;
      if (this.#now() < this.#backoffUntilMs) break;

      if (!verifier) {
        const kept = this.#outboxStore.markOutboxUnknown(entry.id, {
          verify_status: "verifier_unavailable",
          dedupe_key: entry.dedupe_key,
        }, this.#now());
        if (kept?.status === "dead_letter") deadLettered += 1;
        else unknownCount += 1;
        continue;
      }

      try {
        const probe = await this.#withConcurrency(signal, () => verifier({
          dedupe_key: entry.dedupe_key,
          relay_id: entry.evidence?.relay_id ?? null,
          target_machine: entry.from_machine,
          reply_relay_key: entry.reply_relay_key,
          reply_group_id: entry.reply_group_id,
          reply_route_generation: entry.reply_route_generation,
        }, { signal }));

        if (probe?.confirmed === true || probe?.status === "sent_verified" || probe?.status === "duplicate") {
          this.#outboxStore.markOutboxSent(entry.id, probe, this.#now());
          verifiedSent += 1;
          flushed += 1;
        } else if (probe?.not_sent === true || probe?.status === "not_sent") {
          const requeued = this.#outboxStore.markOutboxRetry(
            entry.id,
            probe?.code ?? "relay_not_sent",
            extractRetryAfterMs(probe),
            this.#now(),
            { confirmedNotSent: true },
          );
          if (requeued?.status === "dead_letter") deadLettered += 1;
          else verifiedRequeued += 1;
        } else if (probe?.code && PERMANENT_OUTBOX_ERROR_CODES.has(normalizeRelayErrorCode(probe.code))) {
          this.#outboxStore.markOutboxRetry(entry.id, probe.code, 0, this.#now());
          deadLettered += 1;
        } else {
          const kept = this.#outboxStore.markOutboxUnknown(entry.id, probe ?? { verify_status: "still_unknown" }, this.#now());
          if (kept?.status === "dead_letter") deadLettered += 1;
          else unknownCount += 1;
        }
      } catch (error) {
        const code = normalizeRelayErrorCode(error);
        const retryAfterMs = this.#recordRateLimit(error) || extractRetryAfterMs(error);
        if (PERMANENT_OUTBOX_ERROR_CODES.has(code)) {
          this.#outboxStore.markOutboxRetry(entry.id, code, 0, this.#now());
          deadLettered += 1;
        } else {
          const kept = this.#outboxStore.markOutboxUnknown(entry.id, {
            error_code: code,
            ...(retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}),
          }, this.#now());
          if (kept?.status === "dead_letter") deadLettered += 1;
          else unknownCount += 1;
        }
        if (code === "relay_rate_limited") break;
      }
    }

    // 阶段 2：仅对明确未发 (status === 'pending') 条目先原子标记 dispatching 再沿原三元组外发
    const dueEntries = this.#outboxStore.listDueOutbox(this.#now(), limit);
    for (const candidate of dueEntries) {
      if (this.#closed || signal?.aborted) break;
      if (this.#now() < this.#backoffUntilMs) break;

      const entry = typeof this.#outboxStore.claimOutbox === "function"
        ? this.#outboxStore.claimOutbox(candidate.id, this.#now())
        : candidate;
      if (!entry) continue;

      const sourceEndpoint = entry.source_endpoint || endpointFromTargetKey(entry.target_key);
      const recipientEndpoint = entry.origin_source_endpoint || "core/system/dispatcher";

      let requestStarted = false;
      try {
        const result = await this.#withConcurrency(signal, () => this.#transport.sendFrame({
          dedupe_key: entry.dedupe_key,
          target_machine: entry.from_machine,
          reply_relay_key: entry.reply_relay_key,
          reply_group_id: entry.reply_group_id,
          reply_route_generation: entry.reply_route_generation,
          op: "processing_ack",
          source: sourceEndpoint,
          recipients: [recipientEndpoint],
          in_reply_to: entry.origin_relay_id,
          body: "",
          meta: {
            hop_count: 1,
            origin_relay_id: entry.origin_relay_id,
            origin_message_id: entry.origin_message_id,
            local_message_id: entry.local_message_id,
            ack_seq: entry.ack_seq,
            processing: entry.processing,
            ...(entry.note !== null ? { note: entry.note } : {}),
            ...(entry.reply_message_id !== null ? { reply_message_id: entry.reply_message_id } : {}),
            observed_at: new Date(this.#now()).toISOString(),
          },
          allow_disclose_recipients: false,
        }, { signal, onRequestStarted: () => { requestStarted = true; } }));

        if (isOutcomeUnknownResult(result)) {
          const marked = this.#outboxStore.markOutboxUnknown(entry.id, result, this.#now());
          if (marked?.status === "dead_letter") deadLettered += 1;
          else unknownCount += 1;
        } else {
          this.#outboxStore.markOutboxSent(entry.id, result, this.#now());
          flushed += 1;
        }
      } catch (error) {
        const code = normalizeRelayErrorCode(error);
        const retryAfterMs = this.#recordRateLimit(error) || extractRetryAfterMs(error);
        if (PERMANENT_OUTBOX_ERROR_CODES.has(code)) {
          this.#outboxStore.markOutboxRetry(entry.id, code, retryAfterMs, this.#now());
          deadLettered += 1;
        } else {
          const explicitNotSent = (error?.outcomeUnknown === false && error?.details?.request_sent === false)
            || code === "relay_rate_limited"
            || (!requestStarted && error instanceof CoreError && !isOutcomeUnknownError(error) && error?.details?.request_sent !== true);
          if (!explicitNotSent || isOutcomeUnknownError(error)) {
            const marked = this.#outboxStore.markOutboxUnknown(entry.id, {
              error_code: code,
              message: error?.message ?? "",
              ...(error?.details?.relay_id ? { relay_id: error.details.relay_id } : {}),
              ...(retryAfterMs > 0 ? { retry_after_ms: retryAfterMs } : {}),
            }, this.#now());
            if (marked?.status === "dead_letter") deadLettered += 1;
            else unknownCount += 1;
          } else {
            const updated = this.#outboxStore.markOutboxRetry(entry.id, code, retryAfterMs, this.#now());
            if (updated?.status === "dead_letter") {
              deadLettered += 1;
            } else {
              retried += 1;
            }
          }
        }
        if (code === "relay_rate_limited") break;
      }
    }

    return {
      flushed,
      retried,
      unknown: unknownCount,
      verified_sent: verifiedSent,
      verified_requeued: verifiedRequeued,
      dead_lettered: deadLettered,
      deleted_expired: pruned.deleted,
      skipped_backoff: false,
      backoff_until_ms: this.#backoffUntilMs,
    };
  }

  startPolling(intervalMs) {
    this.#assertOpen();
    if (intervalMs !== undefined) {
      this.#pollIntervalOverride = requireInteger(intervalMs, "intervalMs", 10, 120000);
    }
    if (this.#polling) return;
    this.#polling = true;

    const scheduleNext = () => {
      if (!this.#polling || this.#closed) return;
      const base = this.#pollIntervalOverride ?? this.#limits.pollIntervalMs;
      const idle = Math.max(base, this.#limits.idlePollIntervalMs);
      let delay = this.#consecutiveIdlePolls >= 2 ? idle : base;
      const backoffRemaining = this.#backoffUntilMs - this.#now();
      if (backoffRemaining > delay) delay = backoffRemaining;

      this.#pollTimer = setTimeout(async () => {
        this.#pollTimer = null;
        if (!this.#polling || this.#closed) return;
        try {
          await this.pollOnce();
          if (!this.#closed) await this.flushOutbox();
        } catch (error) {
          if (!this.#closed) this.#onError(error);
        } finally {
          scheduleNext();
        }
      }, Math.max(1, delay));
    };

    scheduleNext();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#polling = false;

    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }

    if (!this.#lifecycleAbort.signal.aborted) {
      this.#lifecycleAbort.abort(new CoreError("dispatcher_closed", "跨机调度器已关闭"));
    }

    const pendingList = [...this.#pendingRequests.values()];
    this.#pendingRequests.clear();
    for (const entry of pendingList) {
      entry.reject(new CoreError("dispatcher_closed", "跨机调度器已关闭"));
    }

    const waiters = this.#concurrencyWaiters.splice(0, this.#concurrencyWaiters.length);
    for (const waiter of waiters) {
      waiter.reject(new CoreError("dispatcher_closed", "跨机调度器已关闭"));
    }

    if (this.#pollInFlight) {
      try {
        await this.#pollInFlight;
      } catch {
        // 关闭期忽略在途轮询中止错误
      }
    }
    if (this.#flushInFlight) {
      try {
        await this.#flushInFlight;
      } catch {
        // 关闭期忽略在途外发中止错误
      }
    }

    this.#processedCache.clear();
    this.#outboundRecords.clear();
    this.#lastObservedStatus.clear();
    this.#remoteProcessingState.clear();
    this.#bundleAckLatencies.length = 0;
  }
}
