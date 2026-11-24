import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, constants as sqlite } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CoreError } from "./contracts.mjs";
import { projectModelObservation, unknownModelObservation } from "./host-model-observation.mjs";

const SOURCE = "windsurf_devin_desktop_process_and_readonly_sqlite";
const UNKNOWN = "unknown";
const MODES = Object.freeze({ next_model_boundary: false, when_idle: false });
const executeFile = promisify(execFile);
const HEX = /^[a-f0-9]{40}$/iu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAPPING_PREFIX = "windsurf.acp.messageStore.session.acp/devin-cli/";
const QUERY_ARGUMENT = "--windsurf-desktop-status-readonly-query";
const MAX_DESKTOP_INFO_BYTES = 1024 * 1024;
const MAX_CONFIG_OPTIONS = 64;
const MAX_INVOCATION_NODES = 32;
const INVOCATION_SOURCE = "windsurf_devin_cli_message_nodes_metadata";
const PROCESS_SCRIPT = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $items=@(Get-CimInstance Win32_Process -Filter \"Name='Devin.exe' OR Name='Windsurf.exe'\"); if($items.Count -gt 256){throw 'process_budget'}; $rows=@($items | ForEach-Object {[PSCustomObject]@{pid=[int]$_.ProcessId; parent_pid=[int]$_.ParentProcessId; name=$_.Name; executable_path=$_.ExecutablePath; command_line=$_.CommandLine; created_at=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}}}); [PSCustomObject]@{complete=$true; processes=$rows} | ConvertTo-Json -Compress -Depth 4";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, limit = 4096) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
}

function persistedModel(value) {
  return boundedString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
    && !/^(?:sk[-_]|AIza|gh[pousr]_|github_pat_|xox[baprs]-|eyJ)/u.test(value) ? value : undefined;
}

function processPath(value) {
  return boundedString(value) ? path.win32.normalize(value).toLowerCase() : undefined;
}

function cancellable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function argumentsOf(commandLine) {
  if (!boundedString(commandLine, 16384)) return undefined;
  const argumentsList = [];
  let token = "";
  let quoted = false;
  let started = false;
  for (let offset = 0; offset < commandLine.length; offset += 1) {
    const character = commandLine[offset];
    if (character === "\\") {
      let count = 1;
      while (commandLine[offset + count] === "\\") count += 1;
      if (commandLine[offset + count] === '"') {
        token += "\\".repeat(Math.floor(count / 2));
        if (count % 2) token += '"';
        else quoted = !quoted;
        offset += count;
      } else {
        token += "\\".repeat(count);
        offset += count - 1;
      }
      started = true;
    } else if (character === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/u.test(character) && !quoted) {
      if (started) argumentsList.push(token);
      token = "";
      started = false;
    } else {
      token += character;
      started = true;
    }
    if (argumentsList.length > 128) return undefined;
  }
  if (quoted) return undefined;
  if (started) argumentsList.push(token);
  return argumentsList;
}

function processSnapshot(value, installRoots) {
  const entries = Array.isArray(value) ? value : value?.processes;
  if (!Array.isArray(entries) || entries.length > 256 || !Array.isArray(value) && value.complete !== true) return { host_online: UNKNOWN };
  const byPid = new Map();
  const main = new Set();
  const engines = new Set();
  const duplicates = new Set();
  let uncertain = false;
  for (const entry of entries) {
    if (!record(entry)) {
      uncertain = true;
      continue;
    }
    const pid = entry.pid ?? entry.ProcessId;
    const parentPid = entry.parent_pid ?? entry.ParentProcessId;
    const executablePath = processPath(entry.executable_path ?? entry.ExecutablePath);
    const suppliedName = entry.name ?? entry.Name;
    const executableName = executablePath ? path.win32.basename(executablePath) : undefined;
    const name = boundedString(suppliedName, 256) ? suppliedName.toLowerCase() : executableName;
    if (name && !["devin.exe", "windsurf.exe"].includes(name) && (!executableName || !["devin.exe", "windsurf.exe"].includes(executableName))) continue;
    if (suppliedName !== undefined && (!boundedString(suppliedName, 256) || executableName && name !== executableName)) {
      uncertain = true;
      continue;
    }
    const command = argumentsOf(entry.command_line ?? entry.CommandLine);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || byPid.has(pid) || duplicates.has(pid)) {
      uncertain = true;
      if (byPid.has(pid)) {
        byPid.delete(pid);
        main.delete(pid);
        engines.delete(pid);
        duplicates.add(pid);
      }
      continue;
    }
    const root = installRoots.find(candidate => executablePath === processPath(path.join(candidate, "Devin.exe"))
      || executablePath === processPath(path.join(candidate, "Windsurf.exe"))
      || executablePath === processPath(path.join(candidate, "resources", "app", "extensions", "windsurf", "devin", "bin", "devin.exe")));
    const createdAt = Date.parse(entry.created_at ?? entry.CreationDate);
    const info = { pid, parentPid, executablePath, root, createdAt, verified: false };
    byPid.set(pid, info);
    if (!root || !command?.length || processPath(command[0]) !== executablePath) {
      uncertain = true;
      continue;
    }
    info.verified = true;
    const enginePath = processPath(path.join(root, "resources", "app", "extensions", "windsurf", "devin", "bin", "devin.exe"));
    if (executablePath === enginePath) {
      if (command[1] === "acp") engines.add(pid);
      continue;
    }
    const helper = command.slice(1).some(argument => /^--(?:type(?:=|$)|utility-sub-type(?:=|$)|ms-enable-electron-run-as-node(?:=|$)|crash-handler(?:=|$))/iu.test(argument));
    if (!helper) main.add(pid);
  }
  const acp = [];
  for (const pid of engines) {
    const engine = byPid.get(pid);
    const visited = new Set([pid]);
    let child = engine;
    for (let depth = 0; depth < 8; depth += 1) {
      const parent = byPid.get(child.parentPid);
      if (!parent || !parent.verified || visited.has(parent.pid) || parent.root !== engine.root || !Number.isFinite(parent.createdAt)
        || !Number.isFinite(child.createdAt) || parent.createdAt > child.createdAt) break;
      visited.add(parent.pid);
      if (main.has(parent.pid)) {
        acp.push(engine);
        break;
      }
      child = parent;
    }
  }
  return { host_online: main.size ? true : uncertain || engines.size ? UNKNOWN : false, acp, main };
}

function conversationIdentity(target) {
  if (!record(target) || target.host !== undefined && target.host !== "windsurf") return undefined;
  const identifier = target.conversation_id;
  if (!boundedString(identifier, 128)) return undefined;
  if (HEX.test(identifier)) return { desktopId: identifier.toLowerCase() };
  if (!SLUG.test(identifier)) return undefined;
  return { slug: identifier, desktopId: createHash("sha1").update(`devin-acp/devin-cli/${identifier}`).digest("hex") };
}

function safeJson(value, maxBytes) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("record_budget");
  const parsed = JSON.parse(value);
  const pending = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    visited += 1;
    if (visited > 2048 || item.depth > 12) throw new Error("record_budget");
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
      if (pending.length > 2048) throw new Error("record_budget");
    }
  }
  return parsed;
}

async function safeFile(root, parts, signal) {
  signal.throwIfAborted();
  if (!root) return { state: "missing" };
  try {
    const canonicalRoot = await files.realpath(root);
    let candidate = path.resolve(root);
    for (const part of parts) {
      candidate = path.join(candidate, part);
      const entry = await files.lstat(candidate);
      if (entry.isSymbolicLink()) return { state: "unsafe" };
    }
    const canonicalFile = await files.realpath(candidate);
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return { state: "unsafe" };
    const metadata = await files.stat(canonicalFile);
    signal.throwIfAborted();
    return metadata.isFile() ? { state: "ready", path: canonicalFile, modifiedAt: metadata.mtime.toISOString() } : { state: "unsafe" };
  } catch (error) {
    signal.throwIfAborted();
    return { state: ["ENOENT", "ENOTDIR"].includes(error.code) ? "missing" : "unavailable" };
  }
}

function sqlitePointQuery(request) {
  const queries = {
    cli_session: { table: "sessions", sql: "SELECT id FROM sessions WHERE id = ?", parameters: [request.key] },
    desktop_mapping: { table: "ItemTable", sql: "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ? THEN CAST(value AS TEXT) END AS value, length(CAST(value AS BLOB)) AS bytes FROM ItemTable WHERE key = ?", parameters: [request.maxRecordBytes, request.key] },
    desktop_info: { table: "meta", sql: "SELECT length(CAST(value AS BLOB)) AS bytes, typeof(value) AS storage FROM meta WHERE key = ?", parameters: ["info"] },
  };
  const query = queries[request.kind];
  if (!query || !boundedString(request.path) || !path.isAbsolute(request.path)
    || !Number.isInteger(request.maxRecordBytes) || request.maxRecordBytes < 256 || request.maxRecordBytes > 1048576
    || request.kind === "cli_session" && (!boundedString(request.key, 128) || !SLUG.test(request.key))
    || request.kind === "desktop_mapping" && (!boundedString(request.key, 256) || !request.key.startsWith(MAPPING_PREFIX)
      || !SLUG.test(request.key.slice(MAPPING_PREFIX.length)))) return { state: "unavailable" };
  let database;
  try {
    database = new DatabaseSync(request.path, { readOnly: true, timeout: 350, allowExtension: false });
    database.enableDefensive(true);
    database.setAuthorizer((action, first, second) => {
      if (action === sqlite.SQLITE_SELECT) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_TRANSACTION && ["BEGIN", "ROLLBACK"].includes(first)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_FUNCTION && ["length", "typeof", "json_valid", "json_type", "json_array_length", "json_extract"].includes(second)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_READ && first === query.table && ["id", "key", "value"].includes(second)) return sqlite.SQLITE_OK;
      if (action === sqlite.SQLITE_READ && request.kind === "cli_session"
        && (first === "sessions" && second === "main_chain_id"
          || first === "message_nodes" && ["session_id", "node_id", "parent_node_id", "created_at", "chat_message"].includes(second))) return sqlite.SQLITE_OK;
      return sqlite.SQLITE_DENY;
    });
    database.exec("BEGIN DEFERRED");
    const point = (sql, parameters) => {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters);
      if (plan.length > 8 || !plan.some(entry => /\bSEARCH\b.*\bUSING\b/u.test(entry.detail))
        || plan.some(entry => /\bSCAN\b/u.test(entry.detail))) throw new Error("point_query_required");
      return database.prepare(sql).get(...parameters);
    };
    const row = point(query.sql, query.parameters);
    if (!row) return { state: "ready", found: false };
    if (request.kind === "cli_session") {
      let invocation;
      try {
        const head = point("SELECT main_chain_id FROM sessions WHERE id = ?", [request.key]);
        let nodeId = head?.main_chain_id;
        const visited = new Set();
        for (let offset = 0; nodeId !== null && offset < MAX_INVOCATION_NODES; offset += 1) {
          if (!Number.isSafeInteger(nodeId) || nodeId < 0 || visited.has(nodeId)) throw new Error("invocation_chain_invalid");
          visited.add(nodeId);
          const node = point("SELECT node_id, parent_node_id, created_at, length(CAST(chat_message AS BLOB)) AS bytes, CASE WHEN length(CAST(chat_message AS BLOB)) BETWEEN 2 AND ? THEN json_valid(chat_message) ELSE json_valid(chat_message) END AS valid FROM message_nodes WHERE session_id = ? AND node_id = ?", [request.maxRecordBytes, request.key, nodeId]);
          if (!node || node.valid !== 1 || node.node_id !== nodeId
            || node.parent_node_id !== null && (!Number.isSafeInteger(node.parent_node_id) || node.parent_node_id < 0 || node.parent_node_id >= nodeId)) throw new Error("invocation_node_invalid");
          if (Number(node.bytes) > request.maxRecordBytes) {
            const roleOnly = point("SELECT CASE WHEN json_type(chat_message, '$.role') = 'text' AND length(CAST(json_extract(chat_message, '$.role') AS BLOB)) BETWEEN 1 AND 32 THEN json_extract(chat_message, '$.role') END AS role FROM message_nodes WHERE session_id = ? AND node_id = ?", [request.key, nodeId]);
            if (!["assistant", "user", "tool", "system"].includes(roleOnly?.role)) throw new Error("invocation_role_invalid");
            if (roleOnly.role !== "assistant") {
              nodeId = node.parent_node_id;
              continue;
            }
            throw new Error("invocation_node_invalid");
          }
          const fields = { role: "$.role", model: "$.metadata.generation_model", request_id: "$.metadata.request_id",
            started_at: "$.metadata.started_generation_at", completed_at: "$.metadata.created_at", finish_reason: "$.metadata.finish_reason",
            telemetry_op: "$.metadata.telemetry.operation" };
          const projection = [
            ...Object.entries(fields).map(([name, field]) => `CASE WHEN json_type(chat_message, '${field}') = 'text' AND length(CAST(json_extract(chat_message, '${field}') AS BLOB)) BETWEEN 1 AND 128 THEN json_extract(chat_message, '${field}') END AS ${name}`),
            "json_type(chat_message, '$.metadata.finish_reason') AS finish_reason_type",
          ];
          const selected = point(`SELECT ${projection.join(", ")} FROM message_nodes WHERE session_id = ? AND node_id = ?`, [request.key, nodeId]);
          if (!["assistant", "user", "tool", "system"].includes(selected?.role)) throw new Error("invocation_role_invalid");
          if (selected.role === "assistant") {
            if (typeof selected.model === "string" && selected.model.toLowerCase() === "compactor") {
              nodeId = node.parent_node_id;
              continue;
            }
            const timestamp = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
            if (!persistedModel(selected.model) || [UNKNOWN, "model_observed"].includes(selected.model.toLowerCase())
              || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(selected.request_id ?? "")
              || !timestamp(selected.started_at) || !timestamp(selected.completed_at)
              || Date.parse(selected.started_at) > Date.parse(selected.completed_at)
              || !(persistedModel(selected.finish_reason) || (selected.finish_reason === null && selected.finish_reason_type === "null" && selected.telemetry_op === "inference"))
              || !Number.isSafeInteger(node.created_at) || node.created_at < 0 || !Number.isFinite(new Date(node.created_at * 1000).getTime())) throw new Error("invocation_metadata_invalid");
            if (invocation && selected.request_id !== invocation.request_id) break;
            if (invocation && ["model", "started_at", "completed_at", "finish_reason"].some(field => selected[field] !== invocation[field])) throw new Error("invocation_duplicate_conflict");
            const { telemetry_op: _telemetryOp, finish_reason_type: _finishReasonType, ...invocationFields } = selected;
            invocation ??= { ...invocationFields, node_id: nodeId, created_at: new Date(node.created_at * 1000).toISOString() };
          }
          nodeId = node.parent_node_id;
        }
        if (invocation && Buffer.byteLength(JSON.stringify(invocation), "utf8") > request.maxRecordBytes) invocation = undefined;
      } catch {
        invocation = undefined;
      }
      return { state: "ready", found: row.id === request.key, ...(invocation ? { invocation } : {}) };
    }
    if (request.kind === "desktop_info") {
      if (row.storage !== "text" || !Number.isSafeInteger(row.bytes) || row.bytes < 2 || row.bytes > MAX_DESKTOP_INFO_BYTES) return { state: "unavailable" };
      const shape = point("SELECT CASE WHEN json_valid(value) = 1 THEN CASE WHEN json_type(value) = 'object' AND json_type(value, '$.configOptions') = 'array' THEN json_array_length(value, '$.configOptions') END END AS option_count FROM meta WHERE key = ?", ["info"]);
      if (!Number.isSafeInteger(shape?.option_count) || shape.option_count < 0 || shape.option_count > MAX_CONFIG_OPTIONS) return { state: "unavailable" };
      const count = shape.option_count;
      const fields = Array.from({ length: count }, (unused, index) => {
        const field = `$.configOptions[${index}].id`;
        return `CASE WHEN json_type(value, '${field}') = 'text' AND length(CAST(json_extract(value, '${field}') AS BLOB)) BETWEEN 1 AND 128 THEN json_extract(value, '${field}') END AS id_${index}`;
      });
      const projected = count ? point(`SELECT ${fields.join(", ")} FROM meta WHERE key = ?`, ["info"]) : {};
      const identifiers = Array.from({ length: count }, (unused, index) => projected?.[`id_${index}`]);
      if (!identifiers.every(identifier => boundedString(identifier, 128)) || new Set(identifiers).size !== count) return { state: "unavailable" };
      const modelIndex = identifiers.indexOf("model");
      let model;
      if (modelIndex >= 0) {
        const field = `$.configOptions[${modelIndex}].currentValue`;
        const selected = point(`SELECT CASE WHEN json_type(value, '${field}') = 'text' AND length(CAST(json_extract(value, '${field}') AS BLOB)) BETWEEN 1 AND 128 THEN json_extract(value, '${field}') END AS model FROM meta WHERE key = ?`, ["info"]);
        model = persistedModel(selected?.model);
      }
      const value = JSON.stringify({ configOptions: model ? [{ id: "model", currentValue: model }] : [] });
      return Buffer.byteLength(value, "utf8") <= request.maxRecordBytes ? { state: "ready", found: true, value } : { state: "unavailable" };
    }
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > request.maxRecordBytes
      || typeof row.value !== "string") return { state: "unavailable" };
    return { state: "ready", found: true, value: row.value };
  } catch (error) {
    return { state: [5, 6].includes(error.errcode) ? "busy" : "unavailable" };
  } finally {
    if (database?.isOpen) {
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  }
}

async function defaultQueryDatabase(request, { signal, timeoutMs, execute = executeFile }) {
  let childClosed;
  try {
    const execution = execute(process.execPath, ["--max-old-space-size=64", fileURLToPath(import.meta.url), QUERY_ARGUMENT, JSON.stringify(request)], {
      signal, windowsHide: true, timeout: timeoutMs, maxBuffer: 131072, encoding: "utf8",
    });
    if (execution?.child) childClosed = new Promise(resolve => execution.child.once("close", resolve));
    const { stdout } = await execution;
    signal.throwIfAborted();
    return safeJson(stdout, 131072);
  } catch {
    signal.throwIfAborted();
    return { state: "unavailable" };
  } finally {
    await childClosed;
  }
}

export function createWindsurfDesktopStatusReader({
  appDataDir = process.env.APPDATA,
  localAppDataDir = process.env.LOCALAPPDATA,
  userDataDir = appDataDir ? path.join(appDataDir, "Devin", "User") : undefined,
  cliDataDir = appDataDir ? path.join(appDataDir, "Devin", "cli") : undefined,
  installRoots = localAppDataDir ? [path.join(localAppDataDir, "Programs", "Devin"), path.join(localAppDataDir, "Programs", "Windsurf")] : [],
  execute = executeFile,
  executeDatabase = executeFile,
  listProcesses,
  queryDatabase = defaultQueryDatabase,
  configured_delivery_modes = MODES,
  transportProbe,
  now = () => Date.now(),
  timeoutMs = 4000,
  databaseTimeoutMs = 750,
  maxRecordBytes = 65536,
  processCacheTtlMs = 2500,
  serializeDatabase = false,
} = {}) {
  if (typeof execute !== "function" || typeof executeDatabase !== "function" || listProcesses !== undefined && typeof listProcesses !== "function"
    || typeof queryDatabase !== "function" || typeof now !== "function" || !Array.isArray(installRoots)
    || installRoots.length > 16 || !installRoots.every(root => boundedString(root) && path.isAbsolute(root))
    || [userDataDir, cliDataDir].some(root => root !== undefined && (!boundedString(root) || !path.isAbsolute(root)))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000
    || !Number.isInteger(databaseTimeoutMs) || databaseTimeoutMs < 1 || databaseTimeoutMs > 4000
    || !Number.isInteger(maxRecordBytes) || maxRecordBytes < 256 || maxRecordBytes > 1048576
    || !Number.isInteger(processCacheTtlMs) || processCacheTtlMs < 0 || processCacheTtlMs > 10000
    || typeof serializeDatabase !== "boolean") {
    throw new CoreError("invalid_config", "WSF Desktop只读状态读取器配置无效");
  }
  installRoots = [...installRoots];
  let closed = false;
  const pending = new Set();
  const controllers = new Set();
  const nativeExecutions = new Set();
  const MAX_DATABASE_QUEUE = 16;
  const databaseQueue = [];
  let databaseActive = false;
  const useProcessCache = !listProcesses && execute === executeFile && processCacheTtlMs > 0;
  let processCache;
  let processFlight;

  function dependency(promise, signal, owned = false) {
    if (owned) {
      nativeExecutions.add(promise);
      Promise.resolve(promise).finally(() => nativeExecutions.delete(promise)).catch(() => {});
      return promise;
    }
    return cancellable(promise, signal);
  }

  async function operation(callback, outerSignal) {
    if (closed) throw new CoreError("ls_closed", "WSF Desktop只读状态读取器已关闭");
    const controller = new AbortController();
    controllers.add(controller);
    const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort("status_timeout"), timeoutMs);
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return callback(signal);
    });
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => {});
    const promise = cancellable(work, signal);
    try {
      const result = await promise;
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw new CoreError(closed ? "ls_closed" : controller.signal.aborted ? "ls_timeout" : "ls_cancelled", "WSF Desktop只读状态读取已结束");
      throw error;
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function queryProcesses(signal) {
    let childClosed;
    try {
      signal.throwIfAborted();
      const execution = listProcesses ? listProcesses({ signal }) : execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SCRIPT], {
        signal, windowsHide: true, timeout: 0, maxBuffer: 262144, encoding: "utf8",
      });
      if (execution?.child) childClosed = new Promise(resolve => execution.child.once("close", resolve));
      const response = await dependency(execution, signal, !listProcesses && execute === executeFile);
      const value = listProcesses ? response : safeJson(response.stdout.replace(/^\uFEFF/u, ""), 262144);
      signal.throwIfAborted();
      return processSnapshot(value, installRoots);
    } catch {
      signal.throwIfAborted();
      return { host_online: UNKNOWN };
    } finally {
      await childClosed;
    }
  }

  async function processes(signal) {
    signal.throwIfAborted();
    if (useProcessCache && processCache) {
      const age = now() - processCache.at;
      if (age >= 0 && age < processCacheTtlMs) return structuredClone(processCache.snapshot);
      processCache = undefined;
    }
    let flight = processFlight;
    while (flight?.controller.signal.aborted) {
      await cancellable(flight.promise.catch(() => {}), signal);
      signal.throwIfAborted();
      flight = processFlight;
    }
    if (!flight) {
      flight = { controller: new AbortController(), waiters: 0, settled: false };
      const current = flight;
      flight.promise = Promise.resolve().then(async () => {
        const result = await queryProcesses(current.controller.signal);
        if (useProcessCache && !closed && result?.host_online !== UNKNOWN) {
          processCache = { at: now(), snapshot: structuredClone(result) };
        }
        return result;
      }).finally(() => {
        current.settled = true;
        if (processFlight === current) processFlight = undefined;
      });
      processFlight = flight;
    }
    flight.waiters += 1;
    try {
      return structuredClone(await cancellable(flight.promise, signal));
    } finally {
      flight.waiters -= 1;
      if (!flight.waiters && !flight.settled) flight.controller.abort("status_cancelled");
    }
  }

  function acquireDatabaseSlot(signal) {
    signal.throwIfAborted();
    if (!databaseActive) {
      databaseActive = true;
      return Promise.resolve(true);
    }
    if (!serializeDatabase || databaseQueue.length >= MAX_DATABASE_QUEUE) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        settled: false,
        resolve,
        reject,
        onAbort() {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = databaseQueue.indexOf(waiter);
          if (index >= 0) databaseQueue.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      databaseQueue.push(waiter);
    });
  }

  function releaseDatabaseSlot() {
    while (databaseQueue.length > 0) {
      const next = databaseQueue.shift();
      if (next.settled) continue;
      next.settled = true;
      next.signal.removeEventListener("abort", next.onAbort);
      if (next.signal.aborted) {
        next.reject(next.signal.reason);
        continue;
      }
      next.resolve(true);
      return;
    }
    databaseActive = false;
  }

  async function pointQuery(root, parts, kind, key, signal) {
    const file = await safeFile(root, parts, signal);
    if (file.state !== "ready") return file;
    const acquired = await acquireDatabaseSlot(signal);
    if (!acquired) return { state: "busy" };
    let headerHandle;
    try {
      signal.throwIfAborted();
      const sidecars = {};
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const entry = await files.lstat(`${file.path}${suffix}`).catch(error => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (entry && (!entry.isFile() || entry.isSymbolicLink())) return { state: "unsafe" };
        sidecars[suffix] = entry;
      }
      headerHandle = await files.open(file.path, "r");
      const header = Buffer.alloc(20);
      const { bytesRead } = await headerHandle.read(header, 0, header.length, 0);
      await headerHandle.close();
      headerHandle = undefined;
      const usesWal = bytesRead === 20 && (header[18] === 2 || header[19] === 2);
      if ((usesWal || sidecars["-wal"]) && (!sidecars["-wal"] || !sidecars["-shm"])) return { state: "unavailable" };
      signal.throwIfAborted();
      const value = await dependency(queryDatabase({ path: file.path, kind, key, maxRecordBytes }, { signal, timeoutMs: databaseTimeoutMs, execute: executeDatabase }), signal,
        queryDatabase === defaultQueryDatabase);
      signal.throwIfAborted();
      if (!record(value) || !["ready", "unavailable", "busy"].includes(value.state)
        || value.state === "ready" && typeof value.found !== "boolean") return { state: "unavailable" };
      return value;
    } catch {
      signal.throwIfAborted();
      return { state: "unavailable" };
    } finally {
      try {
        await headerHandle?.close();
      } finally {
        releaseDatabaseSlot();
      }
    }
  }

  async function lockEvidence(slug, snapshot, signal) {
    if (!slug) return "unknown_identity";
    const file = await safeFile(cliDataDir, ["session_locks", `${slug}.lock`], signal);
    if (file.state !== "ready") return file.state;
    let handle;
    try {
      handle = await files.open(file.path, "r");
      const before = await handle.stat();
      if (before.size < 1 || before.size > 16) return "unverified_format";
      const buffer = Buffer.alloc(17);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      signal.throwIfAborted();
      if (before.size !== bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return "changed";
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      if (!/^[1-9]\d{0,9}\r?\n?$/u.test(text)) return "unverified_format";
      const pid = Number(text.trim());
      if (!Number.isSafeInteger(pid) || pid > 0xffffffff) return "unverified_format";
      const owner = snapshot.acp?.find(entry => entry.pid === pid);
      if (!owner) return "owner_not_verified";
      if (!Number.isFinite(owner.createdAt) || before.mtimeMs < owner.createdAt) return "pid_reused";
      if (before.mtimeMs > now() + 5000) return "unverified_time";
      return "pid_candidate_lock_ownership_unknown";
    } catch {
      signal.throwIfAborted();
      return "unavailable";
    } finally {
      await handle?.close();
    }
  }

  async function describe(target, signal) {
    const identity = conversationIdentity(target);
    const observation = unknownModelObservation(SOURCE);
    if (!identity) return { conversation_exists: UNKNOWN, conversation_running: UNKNOWN, can_deliver: false, code: "ls_target_mismatch", model_observation: observation };
    const snapshot = await processes(signal);
    const observedAt = new Date(now()).toISOString();
    const identityEvidence = { desktop_id: identity.desktopId, cli_session_id: identity.slug ?? UNKNOWN,
      source: identity.slug ? "devin_acp_cli_slug_sha1" : "devin_desktop_id_without_reverse_mapping" };
    const result = { host_online: snapshot.host_online, observed_at: observedAt, conversation_exists: UNKNOWN,
      conversation_running: snapshot.host_online === false ? false : UNKNOWN, can_deliver: false,
      identity: identityEvidence, model_observation: observation };
    if (identity.slug) {
      const mapping = await pointQuery(userDataDir, ["globalStorage", "state.vscdb"], "desktop_mapping", `${MAPPING_PREFIX}${identity.slug}`, signal);
      if (mapping.state === "ready" && mapping.found) {
        try {
          const value = safeJson(mapping.value, maxRecordBytes);
          if (!record(value) || !HEX.test(value.uuid) || value.uuid.toLowerCase() !== identity.desktopId) throw new Error("identity_conflict");
          identityEvidence.source = "devin_state_vscdb_uuid_and_cli_slug_sha1";
        } catch {
          result.identity = { desktop_id: UNKNOWN, cli_session_id: UNKNOWN, source: "devin_identity_conflict" };
          result.conversation_running = UNKNOWN;
          return { ...result, code: "ls_target_ambiguous" };
        }
      } else if (!["ready", "missing"].includes(mapping.state)) return { ...result, code: "ls_target_unavailable" };
    }
    const cli = identity.slug ? await pointQuery(cliDataDir, ["sessions.db"], "cli_session", identity.slug, signal) : { state: "missing" };
    const desktop = await pointQuery(userDataDir, ["acp-messages", `${identity.desktopId}.db`], "desktop_info", "info", signal);
    let info;
    if (desktop.state === "ready" && desktop.found) {
      try {
        info = safeJson(desktop.value, maxRecordBytes);
        if (!record(info)) throw new Error("invalid_info");
      } catch {
        return cli.state === "ready" && cli.found ? { ...result, conversation_exists: true }
          : { ...result, code: "ls_target_unavailable" };
      }
    }
    result.conversation_exists = cli.state === "ready" && cli.found || info ? true
      : cli.state === "ready" && !cli.found && (desktop.state === "missing" || desktop.state === "ready" && !desktop.found) ? false : UNKNOWN;
    if (result.conversation_exists === false) result.conversation_running = false;
    const modelOptions = Array.isArray(info?.configOptions) ? info.configOptions.filter(entry => record(entry) && entry.id === "model") : [];
    const selection = modelOptions.length === 1 ? persistedModel(modelOptions[0].currentValue) : undefined;
    const liveTransport = typeof transportProbe === "function" ? await transportProbe(target, { signal }).catch(() => null) : null;
    if (liveTransport?.live_model && persistedModel(liveTransport.live_model)) {
      observation.current_selection = {
        model: liveTransport.live_model,
        source: "windsurf_devin_acp_live_config_options",
        field: "configOptions.model.currentValue",
        conversation_id: identity.slug ?? identity.desktopId,
        observed_at: observedAt,
      };
    } else if (liveTransport && selection && (liveTransport.persisted_model === selection || liveTransport.persisted_model === null)) {
      observation.current_selection = {
        model: selection,
        source: "windsurf_devin_meta_info_configOptions_model_currentValue_persisted",
        field: "configOptions.model.currentValue",
        conversation_id: identity.desktopId,
        observed_at: observedAt,
      };
    } else {
      observation.current_selection = { model: UNKNOWN, code: "model_renderer_selection_missing",
        source: "windsurf_devin_meta_info_configOptions_model_currentValue_persisted", observed_at: observedAt,
        conversation_id: identity.desktopId, ...(boundedString(selection, 128) ? { raw_model: selection } : {}) };
    }
    observation.last_invocation = { model: UNKNOWN, source: "windsurf_devin_invocation_metadata_not_observed", code: "model_invocation_not_exposed", observed_at: observedAt };
    if (record(cli.invocation)) {
      const invocation = cli.invocation;
      observation.last_invocation = { model: invocation.model, source: INVOCATION_SOURCE,
        field: `message_nodes/${invocation.node_id}/request/${invocation.request_id}/chat_message.metadata.generation_model`,
        conversation_id: identity.slug, step_index: invocation.node_id, observed_at: observedAt,
        step_created_at: invocation.created_at, step_started_at: invocation.started_at, step_completed_at: invocation.completed_at };
    }
    result.model_observation = projectModelObservation(observation, SOURCE);
    result.session_lock_evidence = await lockEvidence(identity.slug, snapshot, signal);
    if (result.conversation_exists === true && liveTransport) {
      if (typeof liveTransport.conversation_running === "boolean") result.conversation_running = liveTransport.conversation_running;
      if (snapshot.host_online === true && liveTransport.can_deliver === true) result.can_deliver = true;
    }
    if (result.conversation_exists === UNKNOWN) result.code = "ls_target_unavailable";
    return result;
  }

  const effectiveModes = Object.freeze({
    next_model_boundary: configured_delivery_modes?.next_model_boundary === true,
    when_idle: configured_delivery_modes?.when_idle === true,
  });

  return {
    source: SOURCE,
    requires_host_status: true,
    configured_delivery_modes: effectiveModes,
    getHostStatus(target, { signal } = {}) {
      return operation(async currentSignal => {
        if (!record(target) || target.host !== undefined && target.host !== "windsurf") return { host_online: UNKNOWN, can_deliver: false, code: "ls_target_mismatch" };
        const snapshot = await processes(currentSignal);
        const liveHost = typeof transportProbe === "function" && snapshot.host_online === true
          ? await transportProbe(null, { signal: currentSignal }).catch(() => null)
          : null;
        const transportReady = Boolean(snapshot.host_online === true && liveHost?.transport_ready === true && (effectiveModes.next_model_boundary || effectiveModes.when_idle));
        return { host_online: snapshot.host_online, observed_at: new Date(now()).toISOString(),
          transport_ready: transportReady, host_can_receive: transportReady, can_deliver: false,
          ...(snapshot.host_online === false ? { code: "ls_process_not_found" } : snapshot.host_online === UNKNOWN ? { code: "ls_discovery_failed" } : {}) };
      }, signal);
    },
    describeConversation(target, { signal } = {}) {
      return operation(currentSignal => describe(target, currentSignal), signal);
    },
    async close() {
      closed = true;
      processCache = undefined;
      const discovery = processFlight;
      discovery?.controller.abort("status_closed");
      for (const controller of controllers) controller.abort("status_closed");
      await Promise.allSettled([...pending]);
      if (discovery) await Promise.allSettled([discovery.promise]);
      await Promise.allSettled([...nativeExecutions]);
    },
  };
}

if (process.argv[2] === QUERY_ARGUMENT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    result = sqlitePointQuery(safeJson(process.argv[3], 16384));
  } catch {
    result = { state: "unavailable" };
  }
  process.stdout.write(JSON.stringify(result));
}
