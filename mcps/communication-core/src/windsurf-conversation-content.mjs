import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import * as files from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, constants as sqlite } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { CoreError, identityKey } from "./contracts.mjs";

const executeFile = promisify(execFile);
const QUERY_ARG = "--windsurf-conversation-content-readonly-query";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CURSOR_RE = /^wsf:(\d{1,14}):([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const RELAY_MARKER_RE = /\[COMMUNICATION_CORE message_id=([0-9a-f-]{36}) delivery_id=([0-9a-f-]{36})\]/iu;
const RELAY_HEADER_RE = /^(?:\[COMMUNICATION_CORE(?: |\])|主人在QQ(?:中的引用回信|窗口中的来信)，由交流核心转送。|这条消息来自「[^\r\n]+」代理对话「[^\r\n]+」，由交流核心转送。)/u;
const MAX_WALK_NODES = 96;
const SQL_EXCERPT_CHARS = 8400;
const FULL_MESSAGE_BYTES = 8192;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, limit = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function safeSessionsDb(cliDataDir, signal) {
  signal?.throwIfAborted?.();
  if (!cliDataDir) return null;
  try {
    const canonicalRoot = await files.realpath(cliDataDir);
    const candidate = path.join(path.resolve(cliDataDir), "sessions.db");
    const lstat = await files.lstat(candidate);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    const canonical = await files.realpath(candidate);
    const rel = path.relative(canonicalRoot, canonical);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) return null;
    const wal = await files.lstat(`${canonical}-wal`).catch(() => null);
    const shm = await files.lstat(`${canonical}-shm`).catch(() => null);
    if (wal?.isSymbolicLink() || shm?.isSymbolicLink()) return null;
    if ((wal && !shm) || (!wal && shm)) return null;
    return canonical;
  } catch {
    return null;
  }
}

function openReadOnlySqlite(filePath, timeout) {
  let useImmutable = false;
  try {
    if (!existsSync(`${filePath}-wal`) && !existsSync(`${filePath}-shm`)) {
      const fd = openSync(filePath, "r");
      try {
        const hdr = Buffer.alloc(20);
        const n = readSync(fd, hdr, 0, 20, 0);
        useImmutable = n === 20 && (hdr[18] === 2 || hdr[19] === 2);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    useImmutable = false;
  }
  const location = useImmutable ? `${pathToFileURL(filePath).href}?immutable=1` : filePath;
  return new DatabaseSync(location, { readOnly: true, timeout, allowExtension: false });
}

function runContentQuerySync(request) {
  if (!record(request) || !boundedString(request.path) || !path.isAbsolute(request.path)) return { state: "unavailable" };
  let db;
  try {
    db = openReadOnlySqlite(request.path, 1200);
    db.enableDefensive(true);
    db.exec("PRAGMA cache_size = -4096; PRAGMA mmap_size = 0;");
    db.setAuthorizer((action, first, second) => {
      if (action === sqlite.SQLITE_SELECT) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_PRAGMA && ["cache_size", "mmap_size"].includes(first)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_TRANSACTION && ["BEGIN", "ROLLBACK"].includes(first)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_FUNCTION && ["length", "typeof", "substr", "coalesce", "json_valid", "json_type", "json_array_length", "json_extract"].includes(second)) {
        return sqlite.SQLITE_OK;
      }
      if (action === sqlite.SQLITE_READ && first === "sessions"
        && ["id", "working_directory", "model", "agent_mode", "created_at", "last_activity_at", "title", "main_chain_id", "hidden"].includes(second)) {
        return sqlite.SQLITE_OK;
      }
      if (action === sqlite.SQLITE_READ && first === "message_nodes"
        && ["session_id", "node_id", "parent_node_id", "created_at", "chat_message"].includes(second)) {
        return sqlite.SQLITE_OK;
      }
      return sqlite.SQLITE_DENY;
    });
    db.exec("BEGIN DEFERRED");

    const prepareIndexed = (sql, params) => {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      if (plan.some(entry => /\bSCAN\s+(?:sessions|message_nodes)\b(?!.*\bUSING\s+(?:COVERING\s+)?INDEX\b)/iu.test(entry.detail ?? ""))) {
        throw new Error("unindexed_scan_blocked");
      }
      return db.prepare(sql);
    };

    if (request.kind === "list") {
      const limit = Math.max(1, Math.min(50, Number(request.limit) || 20));
      const hasCursor = Number.isSafeInteger(request.afterTs) && SLUG.test(request.afterId ?? "");
      const sql = hasCursor
        ? `SELECT id, title, working_directory, last_activity_at, main_chain_id
           FROM sessions
           WHERE hidden = 0 AND (last_activity_at < ? OR (last_activity_at = ? AND id > ?))
           ORDER BY last_activity_at DESC, id ASC
           LIMIT ?`
        : `SELECT id, title, working_directory, last_activity_at, main_chain_id
           FROM sessions
           WHERE hidden = 0
           ORDER BY last_activity_at DESC, id ASC
           LIMIT ?`;
      const params = hasCursor ? [request.afterTs, request.afterTs, request.afterId, limit + 1] : [limit + 1];
      const rows = prepareIndexed(sql, params).all(...params);
      return { state: "ready", rows };
    }

    if (request.kind === "title") {
      if (!SLUG.test(request.slug ?? "")) return { state: "unavailable" };
      const session = prepareIndexed(
        "SELECT id, title FROM sessions WHERE id = ?",
        [request.slug],
      ).get(request.slug);
      if (!session) return { state: "ready", found: false };
      return { state: "ready", found: true, title: session.title };
    }

    if (request.kind === "tail") {
      if (!SLUG.test(request.slug ?? "")) return { state: "unavailable" };
      const session = prepareIndexed(
        "SELECT id, title, working_directory, model, agent_mode, last_activity_at, main_chain_id FROM sessions WHERE id = ?",
        [request.slug],
      ).get(request.slug);
      if (!session) return { state: "ready", found: false };

      const nodeStmt = prepareIndexed(
        `SELECT node_id, parent_node_id, created_at,
                length(CAST(chat_message AS BLOB)) AS raw_bytes,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.role') END AS role,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.message_id') END AS message_id,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.is_user_input') END AS is_user_input,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.generation_model') END AS generation_model,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.request_id') END AS request_id,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.completed_at') END AS meta_completed_at,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.created_at') END AS meta_created_at,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.finish_reason') END AS finish_reason,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.tool_calls') = 'array' THEN json_array_length(chat_message, '$.tool_calls') ELSE 0 END AS tool_calls_count,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.content') = 'text' THEN length(CAST(json_extract(chat_message, '$.content') AS BLOB)) ELSE 0 END AS content_bytes,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.content') = 'text' THEN substr(json_extract(chat_message, '$.content'), 1, ${SQL_EXCERPT_CHARS}) ELSE '' END AS content_excerpt
         FROM message_nodes WHERE session_id = ? AND node_id = ?`,
        [request.slug, 0],
      );

      const chain = [];
      let nodeId = session.main_chain_id;
      const visited = new Set();
      while (nodeId !== null && chain.length < MAX_WALK_NODES) {
        if (!Number.isSafeInteger(nodeId) || nodeId < 0 || visited.has(nodeId)) break;
        visited.add(nodeId);
        const node = nodeStmt.get(request.slug, nodeId);
        if (!node) break;
        chain.push(node);
        nodeId = node.parent_node_id;
      }
      const omittedEarlier = nodeId !== null;
      chain.reverse();
      return { state: "ready", found: true, session, nodes: chain, omitted_earlier: omittedEarlier };
    }

    return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  } finally {
    if (db?.isOpen) {
      try { if (db.isTransaction) db.exec("ROLLBACK"); } catch {}
      try { db.close(); } catch {}
    }
  }
}

function isoFromSeconds(sec) {
  return Number.isSafeInteger(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : undefined;
}

function resolveExternalMessage(text, target, atIso, getMessageForDelivery, truncatedInSql = false) {
  const hasRelayHeader = typeof text === "string" && RELAY_HEADER_RE.test(text);
  const match = typeof text === "string" ? RELAY_MARKER_RE.exec(text) : null;
  if (!hasRelayHeader && !match) return null;
  if (!match || typeof getMessageForDelivery !== "function") return { omitted: true, partial: true };
  const [, msgId, delivId] = match;
  const original = getMessageForDelivery(delivId);
  if (!original || original.message_id !== msgId || original.target_key !== identityKey(target)) {
    return { omitted: true, partial: true };
  }
  const envelope = original.envelope;
  if (envelope?.message_visibility === "hidden") return { omitted: true, partial: false };
  if (!envelope || typeof envelope.text !== "string") {
    return { omitted: true, partial: true };
  }
  const markerEnd = match.index + match[0].length;
  const bodyAfterMarker = text.slice(markerEnd).replace(/^\r?\n\r?\n/u, "");
  const exactMatch = text.endsWith(`\n\n${envelope.text}`);
  const prefixMatch = truncatedInSql && bodyAfterMarker.length >= 256 && envelope.text.startsWith(bodyAfterMarker);
  if (!exactMatch && !prefixMatch) {
    return { omitted: true, partial: true };
  }
  return {
    role: "external",
    text: envelope.text,
    from_host: envelope.caller?.host,
    visibility: "visible",
    at: atIso,
  };
}

export function projectWindsurfTail(raw, target, lastRounds, getMessageForDelivery) {
  if (!record(raw) || raw.session?.id !== target.conversation_id || !Array.isArray(raw.nodes)) {
    throw new CoreError("host_content_unverified", "WSF尾步记录与目标对话不匹配");
  }
  const rounds = [];
  let current = null;
  let activityCount = 0;
  let partial = false;
  let textLimited = false;
  let turnInProgress = false;
  let lastInvocation = null;
  let lastInvocationAt = null;
  const seenMessageIds = new Set();

  function flushActivity() {
    if (activityCount > 0 && current?.messages.length) {
      current.messages.push({ role: "activity", text: `该轮还有 ${activityCount} 条工具或活动记录` });
    }
    activityCount = 0;
  }

  function startRound() {
    flushActivity();
    current = { messages: [] };
    rounds.push(current);
  }

  function appendEntry(entry, wasTruncated = false) {
    if (!entry || typeof entry.text !== "string" || !entry.text.trim() || entry.visibility === "hidden") return;
    let body = entry.text;
    if (wasTruncated || Buffer.byteLength(body, "utf8") > FULL_MESSAGE_BYTES) {
      partial = true;
      textLimited = true;
      while (Buffer.byteLength(body, "utf8") > FULL_MESSAGE_BYTES - 16) {
        body = body.slice(0, Math.max(64, Math.floor(body.length * 0.85)));
      }
      body = `${body}…`;
    }
    if (current.messages.length >= 31) {
      partial = true;
      return;
    }
    current.messages.push({ ...entry, text: body });
  }

  for (const node of raw.nodes) {
    if (typeof node.message_id === "string" && node.message_id.length > 0) {
      if (seenMessageIds.has(node.message_id)) continue;
      seenMessageIds.add(node.message_id);
    }
    const role = node.role;
    if (role === "system") continue;
    const atIso = isoFromSeconds(node.created_at);
    const truncatedInSql = Number(node.content_bytes) > Buffer.byteLength(node.content_excerpt ?? "", "utf8");

    if (role === "user") {
      const text = node.content_excerpt ?? "";
      const ext = resolveExternalMessage(text, target, atIso, getMessageForDelivery, truncatedInSql);
      if (ext) {
        if (ext.omitted) {
          partial ||= ext.partial === true;
          continue;
        }
        if (!current || activityCount > 0 || current.messages.some(m => m.role === "assistant")) startRound();
        appendEntry(ext, false);
        turnInProgress = true;
        continue;
      }
      if (node.is_user_input !== 1 && node.is_user_input !== true && text.startsWith("<")) {
        activityCount += 1;
        continue;
      }
      startRound();
      appendEntry({ role: "user", text, at: atIso }, truncatedInSql);
      turnInProgress = true;
    } else if (role === "tool") {
      if (current) activityCount += 1;
      turnInProgress = true;
    } else if (role === "assistant") {
      if (typeof node.generation_model === "string" && node.generation_model) {
        lastInvocation = node.generation_model;
        lastInvocationAt = typeof node.meta_created_at === "string" ? node.meta_created_at : atIso;
      }
      const hasTools = Number(node.tool_calls_count) > 0;
      if (hasTools) {
        if (!current) startRound();
        activityCount += 1;
        turnInProgress = true;
      } else {
        if (!current) {
          partial = true;
          startRound();
        }
        appendEntry({ role: "assistant", text: node.content_excerpt ?? "", at: atIso }, truncatedInSql);
        turnInProgress = !["stop", "end_turn"].includes(node.finish_reason ?? "stop");
      }
    }
  }
  flushActivity();

  const visible = rounds.filter(r => r.messages.length > 0);
  if (raw.omitted_earlier && visible.length < lastRounds) partial = true;
  if (turnInProgress) partial = true;
  const reasons = [];
  if (textLimited) reasons.push("text_limited");
  if (turnInProgress) reasons.push("turn_in_progress");
  if (raw.omitted_earlier && visible.length < lastRounds) reasons.push("item_page_limited");

  return {
    rounds: visible.slice(-lastRounds),
    partial,
    status: turnInProgress ? "running" : "idle",
    last_invocation: lastInvocation,
    last_invocation_at: lastInvocationAt,
    ...(reasons.length ? { coverage_reasons: reasons } : {}),
  };
}

export function createWindsurfConversationContent({
  appDataDir = process.env.APPDATA,
  cliDataDir = appDataDir ? path.join(appDataDir, "Devin", "cli") : undefined,
  transport,
  getMessageForDelivery,
  execute = executeFile,
  now = () => Date.now(),
} = {}) {
  async function queryDb(request, signal) {
    const dbPath = await safeSessionsDb(cliDataDir, signal);
    if (!dbPath) throw new CoreError("host_content_unavailable", "WSF会话数据库未就绪");
    let childClosed;
    try {
      const execPromise = execute(
        process.execPath,
        ["--max-old-space-size=64", fileURLToPath(import.meta.url), QUERY_ARG, JSON.stringify({ ...request, path: dbPath })],
        { signal, windowsHide: true, timeout: 4000, maxBuffer: 262144, encoding: "utf8" },
      );
      if (execPromise?.child) childClosed = new Promise(resolve => execPromise.child.once("close", resolve));
      const { stdout } = await execPromise;
      const parsed = JSON.parse(stdout.trim());
      if (parsed?.state !== "ready") throw new CoreError("host_content_unavailable", "WSF会话读取不可用");
      return parsed;
    } catch (err) {
      if (err instanceof CoreError) throw err;
      throw new CoreError("host_content_unavailable", "WSF会话查询超时或不可用");
    } finally {
      await childClosed;
    }
  }

  return {
    async list(scope, { limit, cursor, signal }) {
      let afterTs = null;
      let afterId = null;
      if (cursor !== null && cursor !== undefined) {
        const match = typeof cursor === "string" ? CURSOR_RE.exec(cursor) : null;
        if (!match) throw new CoreError("invalid_cursor", "请使用同一WSF会话目录游标");
        afterTs = Number(match[1]);
        afterId = match[2];
      }
      const res = await queryDb({ kind: "list", limit, afterTs, afterId }, signal);
      const hasMore = res.rows.length > limit;
      const selected = res.rows.slice(0, limit);
      const daemon = await transport?.checkDaemonStatus?.(signal).catch(() => ({ running: false }));
      const conversations = selected.map(row => ({
        ...scope,
        conversation_id: row.id,
        title: boundedString(row.title, 512) ? row.title : row.id,
        workspace: boundedString(row.working_directory, 512) ? row.working_directory : undefined,
        updated_at: isoFromSeconds(row.last_activity_at),
        status: daemon?.running ? "idle" : "unknown",
      }));
      const last = selected.at(-1);
      const nextCursor = hasMore && last ? `wsf:${last.last_activity_at}:${last.id}` : null;
      return {
        conversations,
        next_cursor: nextCursor,
        partial: false,
        coverage_source: "desktop_catalog",
      };
    },

    async readTitle(target, { signal } = {}) {
      if (!SLUG.test(target?.conversation_id ?? "")) return null;
      const res = await queryDb({ kind: "title", slug: target.conversation_id }, signal);
      if (!res.found || !boundedString(res.title, 256)) return null;
      const trimmed = res.title.trim();
      return trimmed && trimmed !== target.conversation_id ? trimmed : null;
    },

    async readRecent(target, { lastRounds, signal }) {
      if (!SLUG.test(target.conversation_id ?? "")) {
        throw new CoreError("host_content_unavailable", "WSF近期内容请传入词对会话ID");
      }
      const res = await queryDb({ kind: "tail", slug: target.conversation_id }, signal);
      if (!res.found) throw new CoreError("host_content_unavailable", "未找到对应的WSF对话");
      const projected = projectWindsurfTail(res, target, lastRounds, getMessageForDelivery);
      const liveProbe = await transport?.probeStatus?.(target, { signal }).catch(() => null);
      const observedAt = new Date(now()).toISOString();
      const persistedModel = boundedString(res.session.model, 128) ? res.session.model : undefined;
      return {
        ...target,
        title: boundedString(res.session.title, 512) ? res.session.title : target.conversation_id,
        workspace: boundedString(res.session.working_directory, 512) ? res.session.working_directory : undefined,
        status: liveProbe?.conversation_running === true ? "running" : liveProbe?.conversation_running === false ? "idle" : projected.status,
        observed_at: observedAt,
        current_selection: liveProbe?.live_model ?? (persistedModel ? `${persistedModel} (persisted)` : undefined),
        current_selection_at: liveProbe?.live_model ? observedAt : isoFromSeconds(res.session.last_activity_at),
        last_invocation: projected.last_invocation ?? undefined,
        last_invocation_at: projected.last_invocation_at ?? undefined,
        rounds: projected.rounds,
        partial: projected.partial,
        ...(projected.coverage_reasons ? { coverage_reasons: projected.coverage_reasons } : {}),
      };
    },
  };
}

if (process.argv[2] === QUERY_ARG && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let out;
  try {
    out = runContentQuerySync(JSON.parse(process.argv[3]));
  } catch {
    out = { state: "unavailable" };
  }
  process.stdout.write(JSON.stringify(out));
}
