import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import * as files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, constants as sqlite } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createDevinSessionClient } from "./devin-session-client.mjs";

const executeFile = promisify(execFile);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEX = /^[a-f0-9]{40}$/iu;
const UUID_OR_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const MAPPING_PREFIX = "windsurf.acp.messageStore.session.acp/devin-cli/";
const QUERY_ARG = "--windsurf-acp-transport-sqlite-query";
const MAX_FRAME_BYTES = 2097152;
const STALE_TURN_RECONCILE_MS = 15000;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, limit = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

function unrefSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let onAbort;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function safeRegularFile(root, parts) {
  if (!root) return null;
  try {
    const canonicalRoot = await files.realpath(root);
    let current = path.resolve(root);
    for (const part of parts) {
      current = path.join(current, part);
      const st = await files.lstat(current);
      if (st.isSymbolicLink()) return null;
    }
    const canonical = await files.realpath(current);
    const rel = path.relative(canonicalRoot, canonical);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) return null;
    const info = await files.stat(canonical);
    if (!info.isFile()) return null;
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

function runSqliteQuerySync(request) {
  if (!record(request) || !boundedString(request.path) || !path.isAbsolute(request.path)) return { state: "unavailable" };
  let db;
  try {
    db = openReadOnlySqlite(request.path, 600);
    db.enableDefensive(true);
    db.exec("PRAGMA cache_size = -4096; PRAGMA mmap_size = 0;");
    db.setAuthorizer((action, first, second) => {
      if (action === sqlite.SQLITE_SELECT) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_PRAGMA && ["cache_size", "mmap_size"].includes(first)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_TRANSACTION && ["BEGIN", "ROLLBACK"].includes(first)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_FUNCTION && ["length", "typeof", "substr", "instr", "json_valid", "json_type", "json_array_length", "json_extract"].includes(second)) {
        return sqlite.SQLITE_OK;
      }
      if (action === sqlite.SQLITE_READ && first === "sessions" && ["id", "working_directory", "main_chain_id", "model", "agent_mode", "hidden"].includes(second)) {
        return sqlite.SQLITE_OK;
      }
      if (action === sqlite.SQLITE_READ && first === "message_nodes" && ["session_id", "node_id", "parent_node_id", "created_at", "chat_message"].includes(second)) {
        return sqlite.SQLITE_OK;
      }
      if (action === sqlite.SQLITE_READ && first === "ItemTable" && ["key", "value"].includes(second)) return sqlite.SQLITE_OK;
      return sqlite.SQLITE_DENY;
    });
    db.exec("BEGIN DEFERRED");

    const assertIndexed = (sql, params) => {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
      if (plan.some(entry => /\bSCAN\s+(?:sessions|message_nodes|ItemTable)\b(?!.*\bUSING\s+(?:COVERING\s+)?INDEX\b)/iu.test(entry.detail ?? ""))) {
        throw new Error("unindexed_scan_blocked");
      }
      return db.prepare(sql);
    };

    if (request.kind === "windsurf_auth") {
      const row = assertIndexed(
        `SELECT
           CASE WHEN typeof(k) = 'text' AND length(k) BETWEEN 8 AND 4096 THEN k END AS api_key,
           CASE WHEN typeof(u) = 'text' AND length(u) BETWEEN 8 AND 512 THEN u END AS api_server_url
         FROM (
           SELECT
             CASE WHEN length(CAST(value AS BLOB)) <= 4194304 AND json_valid(value) = 1 THEN json_extract(value, '$.apiKey') END AS k,
             CASE WHEN length(CAST(value AS BLOB)) <= 4194304 AND json_valid(value) = 1 THEN json_extract(value, '$.apiServerUrl') END AS u
           FROM ItemTable WHERE key = ?
         )`,
        ["windsurfAuthStatus"],
      ).get("windsurfAuthStatus");
      if (!row?.api_key) return { state: "ready", found: false };
      return {
        state: "ready",
        found: true,
        api_key: row.api_key,
        api_server_url: row.api_server_url || "https://server.codeium.com",
      };
    }

    if (request.kind === "reverse_desktop_id") {
      if (!HEX.test(request.desktopId ?? "")) return { state: "unavailable" };
      const targetHex = request.desktopId.toLowerCase();
      const stmt = assertIndexed(
        "SELECT key FROM ItemTable WHERE key >= ? AND key < ? LIMIT 512",
        [MAPPING_PREFIX, `${MAPPING_PREFIX}\uffff`],
      );
      for (const row of stmt.all(MAPPING_PREFIX, `${MAPPING_PREFIX}\uffff`)) {
        const slug = typeof row.key === "string" && row.key.startsWith(MAPPING_PREFIX) ? row.key.slice(MAPPING_PREFIX.length) : "";
        if (!SLUG.test(slug)) continue;
        const sha = createHash("sha1").update(`devin-acp/devin-cli/${slug}`).digest("hex");
        if (sha === targetHex) return { state: "ready", found: true, slug };
      }
      return { state: "ready", found: false };
    }

    if (!SLUG.test(request.slug ?? "")) return { state: "unavailable" };

    if (request.kind === "session_meta") {
      const row = assertIndexed(
        "SELECT id, working_directory, main_chain_id, model, agent_mode FROM sessions WHERE id = ?",
        [request.slug],
      ).get(request.slug);
      if (!row) return { state: "ready", found: false };
      return {
        state: "ready",
        found: true,
        slug: row.id,
        cwd: boundedString(row.working_directory, 4096) ? row.working_directory : null,
        main_chain_id: row.main_chain_id,
        model: boundedString(row.model, 128) ? row.model : null,
        agent_mode: boundedString(row.agent_mode, 128) ? row.agent_mode : null,
      };
    }

    const evaluateIdle = (slug, mainChainId) => {
      let nodeId = mainChainId;
      if (nodeId === null) return { idle: true };
      const visited = new Set();
      const validIso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
      const stmt = assertIndexed(
        `SELECT node_id, parent_node_id, created_at,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.role') END AS role,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.tool_calls') = 'array' THEN json_array_length(chat_message, '$.tool_calls') ELSE 0 END AS tool_calls_count,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.metadata.finish_reason') END AS finish_reason,
                CASE WHEN json_valid(chat_message) = 1 THEN json_type(chat_message, '$.metadata.finish_reason') END AS finish_reason_type,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.metadata.created_at') = 'text' THEN json_extract(chat_message, '$.metadata.created_at') END AS meta_created_at,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.metadata.telemetry.operation') = 'text' THEN json_extract(chat_message, '$.metadata.telemetry.operation') END AS telemetry_op,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.metadata.generation_model') = 'text' THEN json_extract(chat_message, '$.metadata.generation_model') END AS gen_model
         FROM message_nodes WHERE session_id = ? AND node_id = ?`,
        [slug, 0],
      );
      for (let step = 0; nodeId !== null && step < 16; step += 1) {
        if (!Number.isSafeInteger(nodeId) || nodeId < 0 || visited.has(nodeId)) return { idle: false, reason: "chain_invalid" };
        visited.add(nodeId);
        const node = stmt.get(slug, nodeId);
        if (!node) return { idle: false, reason: "head_node_missing" };
        if (node.role === "system") {
          nodeId = node.parent_node_id;
          continue;
        }
        if (node.role === "assistant") {
          if (typeof node.gen_model === "string" && node.gen_model.toLowerCase() === "compactor") {
            return { idle: false, reason: "compactor_summary_node_active" };
          }
          if (Number(node.tool_calls_count) === 0
            && ((node.finish_reason_type === "text" && ["stop", "end_turn"].includes(node.finish_reason))
              || (node.finish_reason === null && node.finish_reason_type === "null" && node.telemetry_op === "inference" && validIso(node.meta_created_at)))) {
            return { idle: true, head_node_id: node.node_id };
          }
        }
        return { idle: false, reason: `latest_node_${node.role ?? "unknown"}_active` };
      }
      return { idle: false, reason: "system_chain_depth_exceeded" };
    };

    if (request.kind === "probe_session") {
      const row = assertIndexed(
        "SELECT id, working_directory, main_chain_id, model, agent_mode FROM sessions WHERE id = ?",
        [request.slug],
      ).get(request.slug);
      if (!row) return { state: "ready", found: false };
      const idleInfo = evaluateIdle(request.slug, row.main_chain_id);
      return {
        state: "ready",
        found: true,
        slug: row.id,
        cwd: boundedString(row.working_directory, 4096) ? row.working_directory : null,
        main_chain_id: row.main_chain_id,
        model: boundedString(row.model, 128) ? row.model : null,
        agent_mode: boundedString(row.agent_mode, 128) ? row.agent_mode : null,
        idle: idleInfo.idle,
        ...(idleInfo.head_node_id !== undefined ? { head_node_id: idleInfo.head_node_id } : {}),
        ...(idleInfo.reason !== undefined ? { reason: idleInfo.reason } : {}),
      };
    }

    if (request.kind === "check_idle") {
      const head = assertIndexed("SELECT id, main_chain_id FROM sessions WHERE id = ?", [request.slug]).get(request.slug);
      if (!head) return { state: "ready", found: false, idle: false, reason: "session_not_found" };
      return { state: "ready", found: true, ...evaluateIdle(request.slug, head.main_chain_id) };
    }

    if (request.kind === "verify_persisted") {
      if (!UUID_OR_ID.test(request.messageId ?? "") || !UUID_OR_ID.test(request.deliveryId ?? "")) return { state: "unavailable" };
      const marker = `[COMMUNICATION_CORE message_id=${request.messageId} delivery_id=${request.deliveryId}]`;
      const head = assertIndexed("SELECT main_chain_id FROM sessions WHERE id = ?", [request.slug]).get(request.slug);
      let nodeId = head?.main_chain_id ?? null;
      const visited = new Set();
      const stmt = assertIndexed(
        `SELECT node_id, parent_node_id, created_at,
                CASE WHEN json_valid(chat_message) = 1 THEN json_extract(chat_message, '$.role') END AS role,
                CASE WHEN json_valid(chat_message) = 1 AND json_type(chat_message, '$.content') = 'text'
                     THEN instr(substr(json_extract(chat_message, '$.content'), 1, 2048), ?) > 0 ELSE 0 END AS matched
         FROM message_nodes WHERE session_id = ? AND node_id = ?`,
        [marker, request.slug, 0],
      );
      for (let step = 0; nodeId !== null && step < 24; step += 1) {
        if (!Number.isSafeInteger(nodeId) || nodeId < 0 || visited.has(nodeId)) break;
        visited.add(nodeId);
        const node = stmt.get(marker, request.slug, nodeId);
        if (!node) break;
        if (node.role === "user" && Number(node.matched) === 1) {
          return {
            state: "ready",
            found: true,
            verified: true,
            node_id: node.node_id,
            created_at: Number.isSafeInteger(node.created_at) ? new Date(node.created_at * 1000).toISOString() : undefined,
          };
        }
        nodeId = node.parent_node_id;
      }
      return { state: "ready", found: true, verified: false };
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

export class WindsurfAcpTransport {
  constructor({
    appDataDir = process.env.APPDATA,
    localAppDataDir = process.env.LOCALAPPDATA,
    userHomeDir = os.homedir(),
    devinBinaryPath = localAppDataDir
      ? path.join(localAppDataDir, "Programs", "Devin", "resources", "app", "extensions", "windsurf", "devin", "bin", "devin.exe")
      : undefined,
    codeiumDir = userHomeDir ? path.join(userHomeDir, ".codeium", "windsurf") : undefined,
    maxActiveClients = 8,
    maxRetainedClosed = 8,
    idleTtlMs = 180000,
    settleDelayMs = 900,
    verifyNegativeCacheMs = 5000,
    now = () => Date.now(),
    execute = executeFile,
    spawnProcess = spawn,
  } = {}) {
    this.appDataDir = appDataDir;
    this.userDataDir = appDataDir ? path.join(appDataDir, "Devin", "User") : undefined;
    this.cliDataDir = appDataDir ? path.join(appDataDir, "Devin", "cli") : undefined;
    this.devinBinaryPath = devinBinaryPath;
    this.codeiumDir = codeiumDir;
    this.maxActiveClients = Math.max(1, Math.min(16, maxActiveClients));
    this.maxRetainedClosed = Math.max(1, Math.min(16, maxRetainedClosed));
    this.idleTtlMs = Math.max(15000, idleTtlMs);
    this.settleDelayMs = Math.max(0, Math.min(5000, settleDelayMs));
    this.verifyNegativeCacheMs = Math.max(0, Math.min(45000, verifyNegativeCacheMs));
    this.now = now;
    this.execute = execute;
    this.spawnProcess = spawnProcess;

    this.active = new Map();
    this.connecting = new Map();
    this.poolLock = Promise.resolve();
    this.inflightExecs = new Set();
    this.unknownVerifyCache = new Map();
    this.closeController = new AbortController();
    this.retainedClosed = [];
    this.closed = false;
    this.daemonCache = { at: 0, running: false, pid: null, sessionsLoaded: 0, promise: null };
    this.reaperTimer = setInterval(() => this.reapIdle(), 30000);
    this.reaperTimer.unref?.();
  }

  effectiveSignal(signal) {
    if (!signal) return this.closeController.signal;
    return AbortSignal.any([this.closeController.signal, signal]);
  }

  async trackExec(fn) {
    const task = (async () => fn())();
    this.inflightExecs.add(task);
    try {
      return await task;
    } finally {
      this.inflightExecs.delete(task);
    }
  }

  async sqliteQuery(request, signal) {
    if (this.closed) return { state: "unavailable" };
    return this.trackExec(async () => {
      let childClosed;
      try {
        const execPromise = this.execute(
          process.execPath,
          ["--max-old-space-size=64", fileURLToPath(import.meta.url), QUERY_ARG, JSON.stringify(request)],
          { signal: this.effectiveSignal(signal), windowsHide: true, timeout: 1800, maxBuffer: 131072, encoding: "utf8" },
        );
        if (execPromise?.child) childClosed = new Promise(resolve => execPromise.child.once("close", resolve));
        const { stdout } = await execPromise;
        return JSON.parse(stdout.trim());
      } catch {
        return { state: "unavailable" };
      } finally {
        await childClosed;
      }
    });
  }

  async resolveSlug(conversationId, signal) {
    if (SLUG.test(conversationId ?? "")) return conversationId;
    if (HEX.test(conversationId ?? "")) {
      const stateDb = await safeRegularFile(this.userDataDir, ["globalStorage", "state.vscdb"]);
      if (!stateDb) return null;
      const rev = await this.sqliteQuery({ path: stateDb, kind: "reverse_desktop_id", desktopId: conversationId }, signal);
      if (rev.state === "ready" && rev.found && SLUG.test(rev.slug)) return rev.slug;
    }
    return null;
  }

  async resolveSlugAndMeta(conversationId, signal) {
    const slug = await this.resolveSlug(conversationId, signal);
    if (!slug) return null;
    const sessionsDb = await safeRegularFile(this.cliDataDir, ["sessions.db"]);
    if (!sessionsDb) return null;
    const meta = await this.sqliteQuery({ path: sessionsDb, kind: "session_meta", slug }, signal);
    if (meta.state !== "ready" || !meta.found || !meta.cwd) return null;
    return { slug, cwd: meta.cwd, sessionsDb, model: meta.model, agent_mode: meta.agent_mode };
  }

  async checkDaemonStatus(signal, maxAgeMs = 1500) {
    if (this.closed) return { running: false, pid: null };
    const now = Date.now();
    if (now - this.daemonCache.at <= maxAgeMs && !this.daemonCache.promise) {
      return { running: this.daemonCache.running, pid: this.daemonCache.pid, sessionsLoaded: this.daemonCache.sessionsLoaded };
    }
    if (!this.daemonCache.promise) {
      this.daemonCache.promise = this.trackExec(async () => {
        let childClosed;
        try {
          if (!this.devinBinaryPath) return { running: false, pid: null, sessionsLoaded: 0 };
          const st = await files.stat(this.devinBinaryPath).catch(() => null);
          if (!st?.isFile()) return { running: false, pid: null, sessionsLoaded: 0 };
          const execPromise = this.execute(this.devinBinaryPath, ["daemon", "status"], {
            signal: this.closeController.signal,
            windowsHide: true,
            timeout: 4000,
            maxBuffer: 16384,
            encoding: "utf8",
          });
          if (execPromise?.child) childClosed = new Promise(resolve => execPromise.child.once("close", resolve));
          const { stdout } = await execPromise;
          const text = stdout.trim();
          const match = /running\s*\(pid\s+(\d+)\)(?:,\s*(\d+)\s+session\(s\)\s+loaded)?/iu.exec(text);
          const next = match
            ? { running: true, pid: Number(match[1]), sessionsLoaded: match[2] ? Number(match[2]) : 0 }
            : { running: false, pid: null, sessionsLoaded: 0 };
          this.daemonCache = { ...next, at: Date.now(), promise: null };
          return next;
        } catch {
          const fallback = { running: false, pid: null, sessionsLoaded: 0 };
          this.daemonCache = { ...fallback, at: Date.now(), promise: null };
          return fallback;
        } finally {
          await childClosed;
        }
      });
    }
    const result = await this.daemonCache.promise;
    signal?.throwIfAborted?.();
    return result;
  }

  async probeStatus(target, { signal } = {}) {
    const daemon = await this.checkDaemonStatus(signal, 3000);
    if (!target?.conversation_id) {
      return { transport_ready: daemon.running, daemon_pid: daemon.pid };
    }
    const slug = await this.resolveSlug(target.conversation_id, signal);
    if (!slug) {
      return { transport_ready: daemon.running, can_deliver: false, conversation_running: "unknown" };
    }
    const sessionsDb = await safeRegularFile(this.cliDataDir, ["sessions.db"]);
    if (!sessionsDb) {
      return { transport_ready: daemon.running, can_deliver: false, conversation_running: "unknown" };
    }
    const probe = await this.sqliteQuery({ path: sessionsDb, kind: "probe_session", slug }, signal);
    if (probe.state !== "ready" || !probe.found || !probe.cwd) {
      return { transport_ready: daemon.running, can_deliver: false, conversation_running: "unknown" };
    }
    const entry = this.active.get(probe.slug);
    let desc = entry?.client.describe();
    const chainWorking = typeof probe.idle === "boolean" ? !probe.idle : null;
    if (desc?.ready && desc.turn_active && chainWorking === false && Date.now() - desc.last_activity_at > STALE_TURN_RECONCILE_MS) {
      entry.client.clearStaleTurnActive?.();
      desc = entry.client.describe();
    }
    const running = desc?.ready
      ? Boolean(desc.turn_active || chainWorking)
      : daemon.running && chainWorking !== null
        ? chainWorking
        : "unknown";
    return {
      transport_ready: daemon.running,
      can_deliver: daemon.running,
      conversation_running: running,
      live_model: desc?.ready ? desc.model_id : null,
      persisted_model: probe.model,
      daemon_pid: daemon.pid,
    };
  }

  async verifyPersistedDelivery(target, { messageId, deliveryId, signal } = {}) {
    const cacheKey = `${target?.conversation_id ?? ""}:${messageId ?? ""}:${deliveryId ?? ""}`;
    if (this.verifyNegativeCacheMs > 0) {
      const retryAt = this.unknownVerifyCache.get(cacheKey);
      if (retryAt !== undefined && this.now() < retryAt) return { verified: false, throttled: true };
    }
    const resolved = await this.resolveSlugAndMeta(target?.conversation_id, signal);
    if (!resolved) {
      if (this.verifyNegativeCacheMs > 0) {
        if (this.unknownVerifyCache.size >= 128) this.unknownVerifyCache.delete(this.unknownVerifyCache.keys().next().value);
        this.unknownVerifyCache.set(cacheKey, this.now() + this.verifyNegativeCacheMs);
      }
      return { verified: false };
    }
    const res = await this.sqliteQuery({
      path: resolved.sessionsDb,
      kind: "verify_persisted",
      slug: resolved.slug,
      messageId,
      deliveryId,
    }, signal);
    if (res.state === "ready" && res.verified === true) {
      this.unknownVerifyCache.delete(cacheKey);
      return { verified: true, slug: resolved.slug, node_id: res.node_id, created_at: res.created_at };
    }
    if (this.verifyNegativeCacheMs > 0) {
      if (this.unknownVerifyCache.size >= 128) this.unknownVerifyCache.delete(this.unknownVerifyCache.keys().next().value);
      this.unknownVerifyCache.set(cacheKey, this.now() + this.verifyNegativeCacheMs);
    }
    return { verified: false };
  }

  retainClosedClient(slug, client) {
    this.retainedClosed.push({ slug, client, closedAt: Date.now() });
    while (this.retainedClosed.length > this.maxRetainedClosed) {
      this.retainedClosed.shift();
    }
  }

  async closeEntry(slug, reason = "transport_evict") {
    const entry = this.active.get(slug);
    if (!entry) return;
    this.active.delete(slug);
    entry.client.close(reason);
    this.retainClosedClient(slug, entry.client);
    await entry.terminateChild();
  }

  reapIdle() {
    if (this.closed) return;
    const now = Date.now();
    for (const [slug, entry] of this.active.entries()) {
      const desc = entry.client.describe();
      if (!desc.ready) {
        void this.closeEntry(slug, "idle_ttl_expired");
        continue;
      }
      if (desc.awaiting_responses === 0 && desc.queued_writes === 0 && now - desc.last_activity_at > this.idleTtlMs) {
        if (!desc.turn_active) {
          void this.withPoolLock(async () => {
            if (this.closed || this.active.get(slug) !== entry) return;
            const latest = entry.client.describe();
            if (!latest.turn_active && latest.awaiting_responses === 0 && latest.queued_writes === 0 && Date.now() - latest.last_activity_at > this.idleTtlMs) {
              await this.closeEntry(slug, "idle_ttl_expired");
            }
          });
        } else if (entry.sessionsDb) {
          void this.sqliteQuery({ path: entry.sessionsDb, kind: "check_idle", slug }).then(res => {
            if (!this.closed && res.state === "ready" && res.found && res.idle === true) {
              return this.withPoolLock(async () => {
                if (this.closed || this.active.get(slug) !== entry) return;
                const latest = entry.client.describe();
                if (latest.awaiting_responses === 0 && latest.queued_writes === 0 && Date.now() - latest.last_activity_at > this.idleTtlMs) {
                  entry.client.clearStaleTurnActive?.();
                  await this.closeEntry(slug, "idle_ttl_reconciled");
                }
              });
            }
          });
        }
      }
    }
  }

  async reservePoolSlot() {
    if (this.active.size + this.connecting.size < this.maxActiveClients) return true;
    let oldestIdleSlug = null;
    let oldestIdleTime = Infinity;
    let oldestDetachableSlug = null;
    let oldestDetachableTime = Infinity;
    for (const [slug, entry] of this.active.entries()) {
      const desc = entry.client.describe();
      if (!desc.turn_active && desc.awaiting_responses === 0 && desc.queued_writes === 0) {
        if (desc.last_activity_at < oldestIdleTime) {
          oldestIdleTime = desc.last_activity_at;
          oldestIdleSlug = slug;
        }
      } else if (desc.can_detach_safely === true && desc.queued_writes === 0) {
        if (desc.last_activity_at < oldestDetachableTime) {
          oldestDetachableTime = desc.last_activity_at;
          oldestDetachableSlug = slug;
        }
      }
    }
    const victim = oldestIdleSlug ?? oldestDetachableSlug;
    if (!victim) return false;
    await this.closeEntry(victim, oldestIdleSlug ? "pool_lru_evict" : "pool_detach_settled_evict");
    return this.active.size + this.connecting.size < this.maxActiveClients;
  }

  withPoolLock(fn) {
    const run = this.poolLock.then(fn, fn);
    this.poolLock = run.then(() => undefined, () => undefined);
    return run;
  }

  async clientForTarget(target, { signal, queryOnly = false } = {}) {
    if (this.closed) return null;
    const rawId = target?.conversation_id;
    if (queryOnly) {
      const direct = this.active.get(rawId);
      if (direct) return direct.client;
      for (let i = this.retainedClosed.length - 1; i >= 0; i -= 1) {
        if (this.retainedClosed[i].slug === rawId) return this.retainedClosed[i].client;
      }
      return null;
    }

    const resolved = await this.resolveSlugAndMeta(rawId, signal);
    if (!resolved || resolved.slug !== rawId || this.closed) return null;

    const effSignal = this.effectiveSignal(signal);
    const pendingOrClient = await this.withPoolLock(async () => {
      if (this.closed || effSignal.aborted) return null;
      const existing = this.active.get(resolved.slug);
      if (existing && existing.client.describe().ready) return { readyClient: existing.client };
      if (existing) await this.closeEntry(resolved.slug, "stale_entry");
      if (this.closed || effSignal.aborted) return null;

      if (this.connecting.has(resolved.slug)) return { pendingConnect: this.connecting.get(resolved.slug) };
      if (!(await this.reservePoolSlot())) return null;
      if (this.closed || effSignal.aborted) return null;
      if (this.connecting.has(resolved.slug)) return { pendingConnect: this.connecting.get(resolved.slug) };

      const connectPromise = (async () => {
        let client = null;
        let terminateChild = async () => {};
        try {
          const daemon = await this.checkDaemonStatus(effSignal, 500);
          if (!daemon.running || this.closed) return null;

          const env = { ...process.env };
          delete env.ACP_BACKEND;
          const child = this.spawnProcess(this.devinBinaryPath, ["acp", "--process-model", "daemon"], {
            cwd: resolved.cwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: false,
          });

          let exited = false;
          const exitPromise = new Promise(resolveExit => {
            child.once("exit", () => { exited = true; resolveExit(); });
            child.once("error", () => { exited = true; resolveExit(); });
          });

          terminateChild = async () => {
            try { child.stdin?.end(); } catch {}
            if (!exited) {
              try { child.kill("SIGTERM"); } catch {}
              await Promise.race([exitPromise, unrefSleep(1500)]);
              if (!exited) {
                try { child.kill("SIGKILL"); } catch {}
                await Promise.race([exitPromise, unrefSleep(1000)]);
              }
            }
          };

        client = createDevinSessionClient({
          connectorId: "devin-cli",
          sessionId: resolved.slug,
          cwd: resolved.cwd,
          requestTimeoutMs: 12000,
          evictSettled: true,
          sendLine: line => new Promise((resolveWrite, rejectWrite) => {
            if (exited || !child.stdin?.writable) {
              rejectWrite(new Error("stdin_closed"));
              return;
            }
            child.stdin.write(line, "utf8", err => (err ? rejectWrite(err) : resolveWrite()));
          }),
          verifyPersisted: ({ messageId, deliveryId, signal: pollSignal }) => this.sqliteQuery({
            path: resolved.sessionsDb,
            kind: "verify_persisted",
            slug: resolved.slug,
            messageId,
            deliveryId,
          }, pollSignal),
          checkSessionIdle: async ({ signal: idleSignal }) => {
            const res = await this.sqliteQuery({ path: resolved.sessionsDb, kind: "check_idle", slug: resolved.slug }, idleSignal);
            return res.state === "ready" && res.found ? { idle: res.idle === true, reason: res.reason } : { idle: false, reason: "sqlite_unavailable" };
          },
        });

        let chunks = [];
        let bufferedBytes = 0;
        let droppingOversizedLine = false;
        child.stdout?.on("data", chunk => {
          let offset = 0;
          while (offset < chunk.length) {
            const nl = chunk.indexOf(0x0a, offset);
            if (nl === -1) {
              const tail = chunk.subarray(offset);
              if (!droppingOversizedLine) {
                if (bufferedBytes + tail.length > MAX_FRAME_BYTES) {
                  droppingOversizedLine = true;
                  chunks = [];
                  bufferedBytes = 0;
                } else {
                  chunks.push(tail);
                  bufferedBytes += tail.length;
                }
              }
              break;
            }
            const segment = chunk.subarray(offset, nl);
            offset = nl + 1;
            if (droppingOversizedLine) {
              droppingOversizedLine = false;
              chunks = [];
              bufferedBytes = 0;
              continue;
            }
            if (bufferedBytes + segment.length > MAX_FRAME_BYTES) {
              chunks = [];
              bufferedBytes = 0;
              continue;
            }
            const full = chunks.length === 0 ? segment : Buffer.concat([...chunks, segment], bufferedBytes + segment.length);
            chunks = [];
            bufferedBytes = 0;
            const line = full.toString("utf8").replace(/\r$/u, "");
            if (line) client.feedLine(line);
          }
        });
        child.stderr?.on("data", () => {});
        child.stdout?.on("end", () => {
          if (!this.closed) client.feedLine(null);
        });
        child.once("exit", () => {
          if (this.active.get(resolved.slug)?.client === client) {
            this.active.delete(resolved.slug);
            client.close("process_exited");
            this.retainClosedClient(resolved.slug, client);
          }
        });

        const initRes = await client.initialize({ signal: effSignal });
        if (initRes.outcome !== "accepted") {
          client.close("initialize_failed");
          await terminateChild();
          return null;
        }
        const stateDb = await safeRegularFile(this.userDataDir, ["globalStorage", "state.vscdb"]);
        const authInfo = stateDb ? await this.sqliteQuery({ path: stateDb, kind: "windsurf_auth" }, effSignal) : null;
        if (!authInfo || authInfo.state !== "ready" || !authInfo.found || !authInfo.api_key) {
          client.close("auth_unavailable");
          await terminateChild();
          return null;
        }
        const authRes = await client.authenticate({
          apiKey: authInfo.api_key,
          apiServerUrl: authInfo.api_server_url || "https://server.codeium.com",
          signal: effSignal,
        });
        if (authRes.outcome !== "accepted") {
          client.close("authenticate_failed");
          await terminateChild();
          return null;
        }
        const attachRes = await client.attach({ signal: effSignal });
        if (attachRes.outcome !== "accepted") {
          client.close("attach_failed");
          await terminateChild();
          return null;
        }
        if (this.settleDelayMs > 0) {
          const ok = await unrefSleep(this.settleDelayMs, effSignal);
          if (!ok || this.closed) {
            client.close(this.closed ? "transport_closed" : "cancelled_before_ready");
            await terminateChild();
            return null;
          }
        }
          if (this.closed || exited || !client.describe().ready) {
            client.close(this.closed ? "transport_closed" : "process_exited_before_ready");
            await terminateChild();
            return null;
          }
          this.active.set(resolved.slug, { client, child, terminateChild, sessionsDb: resolved.sessionsDb });
        return client;
      } catch {
        try { client?.close("connect_exception"); } catch {}
        try { await terminateChild(); } catch {}
        return null;
      }
      })().finally(() => {
        this.connecting.delete(resolved.slug);
      });

      this.connecting.set(resolved.slug, connectPromise);
      return { pendingConnect: connectPromise };
    });

    if (!pendingOrClient) return null;
    if (pendingOrClient.readyClient) return pendingOrClient.readyClient;
    return pendingOrClient.pendingConnect;
  }

  async setSessionModelForTest(sessionId, modelValue, { signal } = {}) {
    const client = await this.clientForTarget({ host: "windsurf", surface: "desktop", conversation_id: sessionId }, { signal });
    if (!client) throw new Error("wsf_session_client_unavailable");
    return client.setConfigOption({ configId: "model", value: modelValue, signal });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reaperTimer);
    this.closeController.abort(new Error("transport_closed"));
    await this.poolLock.catch(() => {});
    await Promise.allSettled([...this.connecting.values()]);
    const closing = [...this.active.keys()].map(slug => this.closeEntry(slug, "transport_closed"));
    await Promise.allSettled(closing);
    await Promise.allSettled([...this.inflightExecs]);
  }
}

if (process.argv[2] === QUERY_ARG && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let out;
  try {
    out = runSqliteQuerySync(JSON.parse(process.argv[3]));
  } catch {
    out = { state: "unavailable" };
  }
  process.stdout.write(JSON.stringify(out));
}
