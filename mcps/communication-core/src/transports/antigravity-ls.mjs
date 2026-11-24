import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, win32 } from "node:path";
import { CoreError, requireInteger, requireText } from "../contracts.mjs";
import { readAntigravityRendererModel } from "../host-model-observation.mjs";
import { antigravityWorkspaceLabels } from "../antigravity-summary-index.mjs";

const execute = promisify(execFile);
const discoveryFlights = new Map();
const SERVICE = "exa.language_server_pb.LanguageServerService";
const METHODS = new Set(["GetAllCascadeTrajectories", "GetCascadeTrajectorySteps", "GetCascadeTrajectoryGeneratorMetadata", "GetCascadeModelConfigData", "SendUserCascadeMessage"]);
const CONTENT_INDEX_BYTES = 2 * 1024 * 1024;
const CONTENT_TAIL_BYTES = 768 * 1024;
const CONTENT_TAIL_STEPS = 128;
const CONTENT_INDEX_ENTRIES = 4000;
const HUB_MAX_BYTES = 16 * 1024;
const HUB_FALLBACK_STAT_LIMIT = 64;
const HUB_FALLBACK_READ_LIMIT = 16;
const HUB_CLOCK_SKEW_MS = 15000;

function workspaceLabels(summary, metadata) {
  const uris = [
    ...[summary.workspaces, metadata.workspaces].flatMap(rows => Array.isArray(rows) ? rows.slice(0, 4).map(row => row?.workspaceFolderAbsoluteUri) : []),
    ...(Array.isArray(metadata.workspaceUris) ? metadata.workspaceUris.slice(0, 4) : []),
  ];
  return antigravityWorkspaceLabels(uris);
}

function failure(code = "ls_unavailable") {
  return new CoreError(code, "反重力对话接口未取得可核对结果");
}

function discoveryPath(executablePath) {
  const requested = executablePath ?? join(process.env.LOCALAPPDATA ?? "", "Programs", "antigravity", "resources", "bin", "language_server.exe");
  if (typeof requested !== "string" || !/^[A-Za-z]:[\\/]/.test(requested) || /[\u0000-\u001f\u007f]/.test(requested)) throw failure("ls_path_missing");
  const expected = win32.normalize(requested);
  const executableName = win32.basename(expected);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.exe$/i.test(executableName)) throw failure("ls_path_missing");
  return expected;
}

function resolveDaemonDir(daemonDir, expectedExecutable) {
  if (daemonDir === undefined) {
    const lower = expectedExecutable.toLowerCase();
    if (win32.basename(lower) !== "language_server.exe" || !lower.includes("antigravity")) return null;
    const defaultRoot = process.env.USERPROFILE ? join(process.env.USERPROFILE, ".gemini", "antigravity", "daemon") : null;
    if (!defaultRoot || !/^[A-Za-z]:[\\/]/.test(defaultRoot) || /[\u0000-\u001f\u007f]/.test(defaultRoot)) return null;
    return win32.normalize(defaultRoot);
  }
  if (daemonDir === null) return null;
  if (typeof daemonDir !== "string" || !/^[A-Za-z]:[\\/]/.test(daemonDir) || /[\u0000-\u001f\u007f]/.test(daemonDir)) {
    throw failure("ls_path_missing");
  }
  return win32.normalize(daemonDir);
}

function validCsrfText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 4096 || /[^\u0021-\u007e]/.test(trimmed)) return null;
  return trimmed;
}

async function parseHubContent(filePath, mtimeMs, pid, portSet, signal) {
  if (signal?.aborted) throw failure("ls_cancelled");
  let raw;
  try {
    raw = await readFile(filePath, { encoding: "utf8", signal });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw failure("ls_cancelled");
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > HUB_MAX_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.pid !== pid || !Number.isInteger(parsed.httpPort) || !portSet.has(parsed.httpPort)) return null;
  const csrf = validCsrfText(parsed.csrfToken);
  if (!csrf) return null;
  return { csrf, httpPort: parsed.httpPort, mtimeMs };
}

async function readHubRecord(filePath, pid, portSet, minMtimeMs, signal) {
  if (signal?.aborted) throw failure("ls_cancelled");
  let stat;
  try {
    stat = await lstat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > HUB_MAX_BYTES) return null;
  const mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
  if (minMtimeMs !== null && mtimeMs < minMtimeMs) return null;
  return parseHubContent(filePath, mtimeMs, pid, portSet, signal);
}

async function resolveHubDaemonCandidate(pid, allPorts, createdMs, daemonDir, signal) {
  if (signal?.aborted) throw failure("ls_cancelled");
  if (!daemonDir || !allPorts.length) return null;
  try {
    const dirStat = await lstat(daemonDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const portSet = new Set(allPorts);
  const minMtimeMs = Number.isSafeInteger(createdMs) && createdMs > 0 ? createdMs - HUB_CLOCK_SKEW_MS : null;
  const directMatches = [];
  for (const port of allPorts) {
    if (signal?.aborted) throw failure("ls_cancelled");
    const record = await readHubRecord(win32.join(daemonDir, `hub_${port}.json`), pid, portSet, minMtimeMs, signal);
    if (record && record.httpPort === port) directMatches.push(record);
  }
  let matches = directMatches;
  if (!matches.length) {
    if (signal?.aborted) throw failure("ls_cancelled");
    let entries;
    try {
      entries = await readdir(daemonDir, { withFileTypes: true });
    } catch {
      return null;
    }
    if (signal?.aborted) throw failure("ls_cancelled");
    const candidates = [];
    let stated = 0;
    for (const entry of entries) {
      if (signal?.aborted) throw failure("ls_cancelled");
      if (!entry.isFile() || entry.isSymbolicLink() || !/^hub_[A-Za-z0-9_.-]{1,64}\.json$/i.test(entry.name)) continue;
      if (stated >= HUB_FALLBACK_STAT_LIMIT) break;
      stated += 1;
      const fullPath = win32.join(daemonDir, entry.name);
      try {
        const st = await lstat(fullPath);
        if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > HUB_MAX_BYTES) continue;
        const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
        if (minMtimeMs !== null && mtimeMs < minMtimeMs) continue;
        candidates.push({ fullPath, mtimeMs });
      } catch {}
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const fallbackMatches = [];
    for (const item of candidates.slice(0, HUB_FALLBACK_READ_LIMIT)) {
      if (signal?.aborted) throw failure("ls_cancelled");
      const record = await parseHubContent(item.fullPath, item.mtimeMs, pid, portSet, signal);
      if (record) fallbackMatches.push(record);
    }
    matches = fallbackMatches;
  }
  if (!matches.length) return null;
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const best = matches[0];
  if (matches.some(item => item.mtimeMs === best.mtimeMs && (item.csrf !== best.csrf || item.httpPort !== best.httpPort))) {
    return null;
  }
  return { csrf: best.csrf, ports: [best.httpPort, ...allPorts.filter(port => port !== best.httpPort)].slice(0, 8) };
}

function waitForDiscovery(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(failure("ls_cancelled"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export async function discoverAntigravityProcesses({ signal, executablePath, daemonDir } = {}) {
  const expected = discoveryPath(executablePath);
  const resolvedDaemonDir = resolveDaemonDir(daemonDir, expected);
  if (signal?.aborted) throw failure("ls_cancelled");
  const key = `${expected.toLowerCase()}\0${resolvedDaemonDir ? resolvedDaemonDir.toLowerCase() : ""}`;
  let flight = discoveryFlights.get(key);
  if (flight?.controller.signal.aborted) {
    await waitForDiscovery(flight.promise.catch(() => {}), signal);
    return discoverAntigravityProcesses({ signal, executablePath: expected, daemonDir: resolvedDaemonDir });
  }
  if (!flight) {
    flight = { controller: new AbortController(), waiters: 0, settled: false };
    const current = flight;
    flight.promise = queryAntigravityProcesses(expected, resolvedDaemonDir, flight.controller.signal).finally(() => {
      current.settled = true;
      if (discoveryFlights.get(key) === current) discoveryFlights.delete(key);
    });
    discoveryFlights.set(key, flight);
  }
  flight.waiters += 1;
  try {
    return structuredClone(await waitForDiscovery(flight.promise, signal));
  } finally {
    flight.waiters -= 1;
    if (!flight.waiters && !flight.settled) flight.controller.abort();
  }
}

async function queryAntigravityProcesses(expected, daemonDir, signal) {
  const executableName = win32.basename(expected);
  const escaped = expected.replaceAll("'", "''");
  const escapedName = executableName.replaceAll("'", "''");
  const hostExecutable = win32.join(win32.dirname(win32.dirname(win32.dirname(expected))), "Antigravity.exe").replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@(); $processes=@(Get-CimInstance Win32_Process -Filter "Name='${escapedName}'"); $listening=@(); if($processes.Count){$listening=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)}; foreach($process in $processes){if($process.ExecutablePath -ne '${escaped}'){continue}; $match=[regex]::Match([string]$process.CommandLine,'--csrf_token(?:=|\\s+)([^\\s]+)'); $rawCsrf=if($match.Success){$match.Groups[1].Value.Trim('"')}else{''}; $csrf=if($rawCsrf.Length -gt 0){$rawCsrf}else{$null}; $createdMs=$null; try{if($process.CreationDate){$createdMs=[int64][Math]::Floor(($process.CreationDate.ToUniversalTime()-[datetime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)).TotalMilliseconds)}}catch{$createdMs=$null}; $ports=@($listening | Where-Object OwningProcess -eq $process.ProcessId | Select-Object -ExpandProperty LocalPort -Unique); $hostId=$null; $hostPorts=@(); try{$hostProcess=Get-Process -Id $process.ParentProcessId -ErrorAction SilentlyContinue; if($hostProcess -and $hostProcess.Path -eq '${hostExecutable}'){$hostId=$hostProcess.Id; $hostPorts=@($listening | Where-Object OwningProcess -eq $hostId | Select-Object -ExpandProperty LocalPort -Unique)}}catch{$hostId=$null; $hostPorts=@()}; $items+=[PSCustomObject]@{pid=$process.ProcessId;csrf=$csrf;created_ms=$createdMs;ports=$ports;host_pid=$hostId;host_ports=$hostPorts}}; ConvertTo-Json -InputObject @($items) -Compress -Depth 4`;
  let closed;
  try {
    const pending = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { signal, windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: "utf8" });
    if (pending.child) closed = new Promise(resolve => pending.child.once("close", resolve));
    const { stdout } = await pending;
    const decoded = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (!Array.isArray(decoded) || decoded.length > 16) throw failure();
    const results = [];
    for (const candidate of decoded) {
      if (signal?.aborted) throw failure("ls_cancelled");
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw failure();
      const pid = requireInteger(candidate.pid, "pid", 1, 2147483647);
      if (!Array.isArray(candidate.ports)) throw failure();
      const allPorts = [...new Set(candidate.ports)].slice(0, 16).map(port => requireInteger(port, "port", 1, 65535));
      let ports = allPorts.slice(0, 8);
      let csrf;
      if (candidate.csrf === null && Object.hasOwn(candidate, "csrf")) {
        const resolved = await resolveHubDaemonCandidate(pid, allPorts, candidate.created_ms, daemonDir, signal);
        if (!resolved) continue;
        csrf = requireText(resolved.csrf, "csrf", 4096);
        ports = resolved.ports;
      } else {
        const checked = validCsrfText(requireText(candidate.csrf, "csrf", 4096));
        if (!checked) throw failure();
        csrf = checked;
      }
      results.push({
        pid,
        csrf,
        ports,
        ...(Number.isSafeInteger(candidate.host_pid) && candidate.host_pid > 0 && Array.isArray(candidate.host_ports) ? {
          host_pid: candidate.host_pid,
          host_ports: [...new Set(candidate.host_ports)].filter(port => Number.isInteger(port) && port > 0 && port <= 65535).sort((left, right) => left - right).slice(0, 4),
        } : {}),
      });
    }
    if (results.length > 8) throw failure();
    return results;
  } catch (error) {
    if (error instanceof CoreError && error.code === "ls_cancelled") throw error;
    throw failure("ls_discovery_failed");
  } finally {
    await closed;
  }
}

function contentDescription(id, value) {
  const metadata = value?.trajectoryMetadata;
  if (metadata?.rootConversationId !== id || !id.trim() || Buffer.byteLength(id, "utf8") > 256
    || typeof value.trajectoryId !== "string" || !value.trajectoryId
    || !Number.isSafeInteger(value.stepCount ?? 0) || (value.stepCount ?? 0) < 0) return null;
  return {
    cascade_id: id, trajectory_id: value.trajectoryId, status: value.status, step_count: value.stepCount ?? 0,
    title: value.summary, workspace: workspaceLabels(value, metadata),
    updated_at: value.lastModifiedTime ?? value.updatedAt ?? value.lastModified,
  };
}

export function compactAntigravitySteps(body, stepOffset = 0) {
  if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0) return { steps: [] };
  if (!Array.isArray(body?.steps) || body.steps.length > 2000) throw failure("ls_invalid_steps");
  return {
    steps: body.steps.map((step, offset) => {
      const source = step.metadata?.sourceTrajectoryStepInfo;
      const index = Number.isSafeInteger(source?.stepIndex) ? source.stepIndex : stepOffset + offset;
      const input = step.userInput;
      const response = step.plannerResponse;
      const toolCalls = response?.toolCalls;
      return {
        index,
        type: typeof step.type === "string" ? step.type : "",
        status: typeof step.status === "string" ? step.status : "",
        cascade_id: typeof source?.cascadeId === "string" ? source.cascadeId : null,
        trajectory_id: typeof source?.trajectoryId === "string" ? source.trajectoryId : null,
        timestamp: step.metadata?.createdAt ?? null,
        started_at: step.metadata?.startedAt ?? null,
        completed_at: step.metadata?.completedAt ?? null,
        execution_id: typeof step.metadata?.executionId === "string" ? step.metadata.executionId : null,
        ...(step.metadata?.isInterruptingStep === true ? { interrupting: true } : {}),
        model: typeof step.metadata?.modelUsage?.model === "string" ? step.metadata.modelUsage.model : null,
        ...(input ? { user_input: {
          text: Array.isArray(input.items) ? input.items.map(item => typeof item.text === "string" ? item.text : "").join("\n") : "",
          client_message_id: typeof input.clientMessageId === "string" ? input.clientMessageId : null,
        } } : {}),
        ...(response ? { assistant_response: {
          text: typeof response.response === "string" ? response.response : typeof response.modifiedResponse === "string" ? response.modifiedResponse : "",
          message_id: typeof response.messageId === "string" ? response.messageId : null,
          final: response.stopReason === "STOP_REASON_STOP_PATTERN" && (toolCalls == null || (Array.isArray(toolCalls) && toolCalls.length === 0)),
          ...(Array.isArray(toolCalls) && toolCalls.length ? { has_tool_calls: true } : {}),
        } } : {}),
      };
    }),
  };
}

export class AntigravityLsTransport {
  constructor({ discover = discoverAntigravityProcesses, fetchImpl = fetch, WebSocketImpl = WebSocket, timeoutMs = 8000, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
    this.discover = discover;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.timeoutMs = requireInteger(timeoutMs, "timeoutMs", 50, 30000);
    this.maxResponseBytes = requireInteger(maxResponseBytes, "maxResponseBytes", 1024, 16 * 1024 * 1024);
    this.endpoints = new Map();
    this.closeController = new AbortController();
    this.closed = false;
    this.submissionTracking = true;
  }

  async request(endpoint, method, payload, signal, { maxResponseBytes = this.maxResponseBytes, discardBody = false } = {}) {
    if (this.closed || !METHODS.has(method) || (discardBody && method !== "GetCascadeTrajectoryGeneratorMetadata")) throw failure("ls_method_rejected");
    const combined = AbortSignal.any([this.closeController.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    if (combined.aborted) throw failure("ls_cancelled");
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${endpoint.port}/${SERVICE}/${method}`, {
        method: "POST", redirect: "error", signal: combined,
        headers: { "content-type": "application/json", "x-codeium-csrf-token": endpoint.csrf },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw failure("ls_http_error");
      if (discardBody) {
        await response.body?.cancel();
        if (combined.aborted) throw failure("ls_cancelled");
        return {};
      }
      const reader = response.body?.getReader();
      if (!reader) return {};
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > Math.min(this.maxResponseBytes, maxResponseBytes)) throw failure("ls_response_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("ls_invalid_json");
      return body;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw failure();
    }
  }

  async resolve(target, { signal } = {}) {
    const cascadeId = requireText(target?.conversation_id, "conversation_id", 256);
    const operationSignal = AbortSignal.any([this.closeController.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    if (operationSignal.aborted) throw failure("ls_cancelled");
    const candidates = await waitForDiscovery(this.discover({ signal: operationSignal }), operationSignal);
    if (operationSignal.aborted) throw failure("ls_cancelled");
    const matches = [];
    for (const candidate of candidates) {
      for (const port of candidate.ports) {
        const endpoint = { pid: candidate.pid, csrf: candidate.csrf, port, ls_ports: candidate.ports,
          ...(candidate.host_pid ? { host_pid: candidate.host_pid, host_ports: candidate.host_ports } : {}),
        };
        try {
          const body = await this.request(endpoint, "GetAllCascadeTrajectories", {}, operationSignal);
          const summary = body.trajectorySummaries?.[cascadeId];
          let description;
          if (summary) {
            if (summary.trajectoryMetadata?.rootConversationId !== cascadeId) continue;
            description = {
              cascade_id: cascadeId,
              trajectory_id: requireText(summary.trajectoryId, "trajectory_id", 256),
              status: requireText(summary.status, "status", 128),
              step_count: requireInteger(summary.stepCount ?? 0, "step_count", 0),
              title: typeof summary.summary === "string" ? summary.summary : "",
            };
          } else {
            const stored = await this.request(endpoint, "GetCascadeTrajectorySteps", { cascadeId, stepOffset: 0 }, operationSignal);
            const { steps } = compactAntigravitySteps(stored);
            if (!steps.length || steps.length >= 2000 || steps.some((step, index) => step.index !== index || step.cascade_id !== cascadeId)) continue;
            const trajectories = new Set(steps.map(step => step.trajectory_id));
            if (trajectories.size !== 1) continue;
            const trajectoryId = requireText(steps[0].trajectory_id, "trajectory_id", 256);
            description = { cascade_id: cascadeId, trajectory_id: trajectoryId, status: "CASCADE_RUN_STATUS_NOT_LOADED", step_count: steps.length, title: "", identity_source: "persisted_trajectory_steps" };
          }
          matches.push({ endpoint, description });
        } catch {
        }
        if (operationSignal.aborted) throw failure("ls_cancelled");
      }
    }
    if (matches.length !== 1) throw failure(matches.length ? "ls_target_ambiguous" : "ls_target_unavailable");
    this.endpoints.set(cascadeId, { ...matches[0].endpoint, trajectory_id: matches[0].description.trajectory_id, observed_at: Date.now() });
    return matches[0];
  }

  async describe(target, options = {}) {
    return (await this.resolve(target, options)).description;
  }

  async #contentIndex(signal) {
    if (this.closed || signal.aborted) throw failure("ls_cancelled");
    const candidates = await waitForDiscovery(this.discover({ signal }), signal);
    const entries = new Map();
    const ambiguous = new Set();
    const respondingEndpoints = [];
    let partial = false;
    for (const candidate of candidates) {
      let accepted = false;
      for (const port of candidate.ports) {
        if (signal.aborted) throw failure("ls_cancelled");
        const endpoint = { pid: candidate.pid, csrf: candidate.csrf, port, ls_ports: candidate.ports,
          ...(candidate.host_pid ? { host_pid: candidate.host_pid, host_ports: candidate.host_ports } : {}) };
        let body;
        try {
          body = await this.request(endpoint, "GetAllCascadeTrajectories", {}, signal, { maxResponseBytes: CONTENT_INDEX_BYTES });
        } catch (error) {
          if (error?.code === "ls_response_too_large") partial = true;
          continue;
        }
        const summaries = body.trajectorySummaries;
        if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) continue;
        accepted = true;
        respondingEndpoints.push(endpoint);
        if (Object.keys(summaries).length >= 50) partial = true;
        for (const [id, value] of Object.entries(summaries)) {
          if (entries.size >= CONTENT_INDEX_ENTRIES) {
            partial = true;
            break;
          }
          const description = contentDescription(id, value);
          if (!description) {
            partial = true;
            continue;
          }
          if (entries.has(id) || ambiguous.has(id)) {
            entries.delete(id);
            ambiguous.add(id);
            partial = true;
          } else {
            entries.set(id, { endpoint, description });
          }
        }
        break;
      }
      if (!accepted) partial = true;
    }
    if (signal.aborted) throw failure("ls_cancelled");
    if (!respondingEndpoints.length) throw failure("ls_host_unavailable");
    return { entries, partial, ambiguous, respondingEndpoints };
  }

  async listContentIndex({ signal } = {}) {
    const deadline = AbortSignal.any([this.closeController.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const { entries, partial } = await this.#contentIndex(deadline);
    return { conversations: [...entries.values()].map(entry => entry.description), partial };
  }

  async readContentTail(target, { signal, verifyColdTarget } = {}) {
    const deadline = AbortSignal.any([this.closeController.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const id = requireText(target?.conversation_id, "conversation_id", 256);
    const { entries, ambiguous, respondingEndpoints } = await this.#contentIndex(deadline);
    let match = entries.get(id);
    let cold = false;
    if (!match && !ambiguous.has(id) && respondingEndpoints.length === 1 && typeof verifyColdTarget === "function"
      && await verifyColdTarget(deadline) === true && !deadline.aborted) {
      const endpoint = respondingEndpoints[0];
      await this.request(endpoint, "GetCascadeTrajectoryGeneratorMetadata", { cascadeId: id }, deadline, { discardBody: true });
      const refreshed = await this.request(endpoint, "GetAllCascadeTrajectories", {}, deadline, { maxResponseBytes: CONTENT_INDEX_BYTES });
      const row = refreshed.trajectorySummaries;
      if (row && typeof row === "object" && !Array.isArray(row) && Object.hasOwn(row, id)) {
        const description = contentDescription(id, row[id]);
        if (description && Number.isSafeInteger(row[id].stepCount) && row[id].stepCount > 0) {
          match = { endpoint, description };
          cold = true;
        }
      }
    }
    if (!match) throw failure("ls_target_unavailable");
    const { endpoint, description } = match;
    const offsets = [...new Set([CONTENT_TAIL_STEPS, 32, 8].map(count => Math.max(0, description.step_count - count)))];
    let offset;
    let raw;
    for (const start of offsets) {
      try {
        raw = await this.request(endpoint, "GetCascadeTrajectorySteps", { cascadeId: id, stepOffset: start }, deadline,
          { maxResponseBytes: CONTENT_TAIL_BYTES });
        offset = start;
        break;
      } catch (error) {
        if (error?.code !== "ls_response_too_large" || deadline.aborted) throw error;
      }
    }
    if (raw === undefined) throw failure("ls_response_too_large");
    const { steps } = compactAntigravitySteps(raw, offset);
    if (steps.length > CONTENT_TAIL_STEPS || steps.some((step, index) => step.index !== offset + index
      || ((cold || step.cascade_id) && step.cascade_id !== id)
      || ((cold || step.trajectory_id) && step.trajectory_id !== description.trajectory_id))) {
      throw failure("ls_invalid_steps");
    }
    const observedStep = steps.findLast(step => ["CORTEX_STEP_TYPE_PLANNER_RESPONSE", "planner_response"].includes(step.type)
      && typeof step.model === "string");
    let current;
    let catalog;
    if (deadline.aborted) throw failure("ls_cancelled");
    const metadataSignal = AbortSignal.any([deadline, AbortSignal.timeout(1200)]);
    await Promise.all([
      readAntigravityRendererModel(target, endpoint, { signal: metadataSignal, WebSocketImpl: this.WebSocketImpl, fetchImpl: this.fetchImpl })
        .then(value => { current = value; }, () => {}),
      this.request(endpoint, "GetCascadeModelConfigData", {}, metadataSignal, { maxResponseBytes: 256 * 1024 })
        .then(value => { catalog = value?.clientModelConfigs; }, () => {}),
    ]);
    if (deadline.aborted) throw failure("ls_cancelled");
    const named = model => {
      if (typeof model !== "string" || model === "unknown") return undefined;
      const matches = Array.isArray(catalog) ? catalog.filter(entry => entry?.modelOrAlias?.model === model || entry?.modelId === model) : [];
      return matches.length === 1 && typeof matches[0].label === "string" ? matches[0].label : model;
    };
    const selection = named(current?.model);
    const invocation = named(observedStep?.model);
    return { description, steps, omitted_earlier: offset > 0, partial: offset + steps.length < description.step_count,
      current_selection: selection, current_selection_at: selection ? current?.observed_at : undefined,
      last_invocation: invocation, last_invocation_at: invocation ? observedStep.started_at ?? observedStep.timestamp : undefined };
  }

  async describeModel(target, { signal, description, kind } = {}) {
    const source = kind === "current_selection" ? "antigravity_renderer_model_selection" : "antigravity_ls_model_usage";
    const missing = code => ({ model: "unknown", source, code });
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500);
    const endpoint = this.endpoints.get(target?.conversation_id);
    if (this.closed || operationSignal.aborted || description?.cascade_id !== target?.conversation_id
      || typeof description?.trajectory_id !== "string" || description.trajectory_id !== endpoint?.trajectory_id
      || !Number.isFinite(endpoint?.observed_at) || Date.now() - endpoint.observed_at < 0 || Date.now() - endpoint.observed_at > 8000) return missing("model_observation_unavailable");
    if (kind === "current_selection") return readAntigravityRendererModel(target, endpoint, {
      fetchImpl: this.fetchImpl, WebSocketImpl: this.WebSocketImpl, signal: operationSignal,
    });
    if (kind !== "last_invocation" || !Number.isSafeInteger(description.step_count) || description.step_count < 1) return missing("model_tail_unavailable");
    const offset = Math.max(0, description.step_count - 32);
    try {
      const body = await this.request(endpoint, "GetCascadeTrajectorySteps", { cascadeId: target.conversation_id, stepOffset: offset }, operationSignal);
      if (!Array.isArray(body.steps) || body.steps.length > 32) return missing("model_tail_mismatch");
      let latest;
      for (const [index, step] of body.steps.entries()) {
        const identity = step.metadata?.sourceTrajectoryStepInfo;
        if (identity?.cascadeId !== target.conversation_id || identity?.trajectoryId !== description.trajectory_id
          || identity.stepIndex !== offset + index) return missing("model_tail_mismatch");
        if (typeof step.metadata?.modelUsage?.model === "string") latest = { step, index: identity.stepIndex };
      }
      if (!latest) return missing("model_tail_unavailable");
      return {
        model: latest.step.metadata.modelUsage.model, source, field: "steps.metadata.modelUsage.model", observed_at: new Date().toISOString(),
        conversation_id: target.conversation_id, trajectory_id: description.trajectory_id, step_index: latest.index,
        tail_offset: offset, tail_count: body.steps.length,
        ...(typeof latest.step.metadata.createdAt === "string" ? { step_created_at: latest.step.metadata.createdAt } : {}),
        ...(typeof latest.step.metadata.startedAt === "string" ? { step_started_at: latest.step.metadata.startedAt } : {}),
        ...(typeof latest.step.metadata.completedAt === "string" ? { step_completed_at: latest.step.metadata.completedAt } : {}),
        ...(typeof latest.step.metadata.modelUsage.apiProvider === "string" ? { provider: latest.step.metadata.modelUsage.apiProvider } : {}),
      };
    } catch {
      return missing(operationSignal.aborted ? "model_observation_timeout" : "model_observation_unavailable");
    }
  }

  async describeModelCatalog(target, { signal, description, model } = {}) {
    const source = "antigravity_ls_model_config_data";
    const missing = code => ({ catalog_source: source, catalog_code: code });
    const endpoint = this.endpoints.get(target?.conversation_id);
    if (this.closed || signal?.aborted || typeof model !== "string" || !model.trim() || model === "unknown"
      || description?.cascade_id !== target?.conversation_id || description?.trajectory_id !== endpoint?.trajectory_id
      || !Number.isFinite(endpoint?.observed_at) || Date.now() - endpoint.observed_at < 0 || Date.now() - endpoint.observed_at > 8000) return missing("model_catalog_unavailable");
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500);
    try {
      const body = await this.request(endpoint, "GetCascadeModelConfigData", {}, operationSignal);
      const configs = body.clientModelConfigs;
      if (!Array.isArray(configs) || configs.length > 512) return missing("model_catalog_unavailable");
      const matches = configs.filter(config => config.modelOrAlias?.model === model);
      if (matches.length !== 1) return missing("model_catalog_match_missing");
      return {
        catalog_source: source, catalog_observed_at: new Date().toISOString(),
        catalog_field: "clientModelConfigs.modelOrAlias.model",
        ...(typeof matches[0].modelId === "string" ? { catalog_model_id: matches[0].modelId } : {}),
        ...(typeof matches[0].label === "string" ? { catalog_label: matches[0].label } : {}),
      };
    } catch {
      return missing(operationSignal.aborted ? "model_observation_timeout" : "model_catalog_unavailable");
    }
  }

  async describeHost({ signal } = {}) {
    const source = "antigravity_ls";
    if (this.closed) return { source, host_online: "unknown", code: "ls_closed" };
    if (signal?.aborted) return { source, host_online: "unknown", code: "ls_cancelled" };
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([this.closeController.signal, ...(signal ? [signal] : [])]);
    const onAbort = () => controller.abort(this.closed ? "ls_closed" : "ls_cancelled");
    operationSignal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort("ls_timeout"), Math.min(this.timeoutMs, 8000));
    const aborted = new Promise((resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(failure(controller.signal.reason)), { once: true });
    });
    let instanceCount;
    try {
      const candidates = await Promise.race([this.discover({ signal: controller.signal }), aborted]);
      if (!Array.isArray(candidates)) throw failure("ls_discovery_failed");
      instanceCount = candidates.length;
      if (!instanceCount) return { source, host_online: false, instance_count: 0, code: "ls_process_not_found" };
      const probes = candidates.flatMap(candidate => candidate.ports.map(async port => {
        await Promise.race([this.request({ pid: candidate.pid, csrf: candidate.csrf, port }, "GetAllCascadeTrajectories", {}, controller.signal), aborted]);
        return candidate.pid;
      }));
      if (!probes.length) return { source, host_online: "unknown", instance_count: instanceCount, code: "ls_endpoint_not_found" };
      const pid = await Promise.any(probes);
      if (controller.signal.aborted || this.closed) return { source, host_online: "unknown", instance_count: instanceCount, code: this.closed ? "ls_closed" : controller.signal.reason };
      return { source, host_online: true, instance_count: instanceCount, responding_pid: pid };
    } catch {
      const code = controller.signal.aborted ? controller.signal.reason : instanceCount === undefined ? "ls_discovery_failed" : "ls_host_unavailable";
      return { source, host_online: "unknown", ...(instanceCount === undefined ? {} : { instance_count: instanceCount }), code };
    } finally {
      clearTimeout(timer);
      operationSignal.removeEventListener("abort", onAbort);
      controller.abort("ls_probe_finished");
    }
  }

  async call(method, payload, { target, signal, onRequestStarted } = {}) {
    if (method !== "SendUserCascadeMessage" || payload?.cascadeId !== target?.conversation_id) throw Object.assign(failure("ls_target_mismatch"), { requestSent: false });
    let endpoint;
    try { ({ endpoint } = await this.resolve(target, { signal })); } catch (error) { error.requestSent = false; throw error; }
    if (signal?.aborted || this.closed) throw Object.assign(failure("ls_cancelled"), { requestSent: false });
    onRequestStarted?.();
    return this.request(endpoint, method, payload, signal);
  }

  async readSteps(target, { stepOffset = 0, signal } = {}) {
    requireInteger(stepOffset, "stepOffset", 0);
    const { endpoint } = await this.resolve(target, { signal });
    const body = await this.request(endpoint, "GetCascadeTrajectorySteps", { cascadeId: target.conversation_id, stepOffset }, signal);
    return compactAntigravitySteps(body, stepOffset);
  }

  async close() {
    this.closed = true;
    this.closeController.abort();
    this.endpoints.clear();
  }
}
