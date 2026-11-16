import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, win32 } from "node:path";
import { CoreError, requireInteger, requireText } from "../contracts.mjs";
import { readAntigravityRendererModel } from "../host-model-observation.mjs";

const execute = promisify(execFile);
const discoveryFlights = new Map();
const SERVICE = "exa.language_server_pb.LanguageServerService";
const METHODS = new Set(["GetAllCascadeTrajectories", "GetCascadeTrajectorySteps", "GetCascadeModelConfigData", "SendUserCascadeMessage"]);

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

export async function discoverAntigravityProcesses({ signal, executablePath } = {}) {
  const expected = discoveryPath(executablePath);
  if (signal?.aborted) throw failure("ls_cancelled");
  const key = expected.toLowerCase();
  let flight = discoveryFlights.get(key);
  if (flight?.controller.signal.aborted) {
    await waitForDiscovery(flight.promise.catch(() => {}), signal);
    return discoverAntigravityProcesses({ signal, executablePath: expected });
  }
  if (!flight) {
    flight = { controller: new AbortController(), waiters: 0, settled: false };
    const current = flight;
    flight.promise = queryAntigravityProcesses(expected, flight.controller.signal).finally(() => {
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

async function queryAntigravityProcesses(expected, signal) {
  const executableName = win32.basename(expected);
  const escaped = expected.replaceAll("'", "''");
  const escapedName = executableName.replaceAll("'", "''");
  const hostExecutable = win32.join(win32.dirname(win32.dirname(win32.dirname(expected))), "Antigravity.exe").replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $items=@(); $processes=@(Get-CimInstance Win32_Process -Filter "Name='${escapedName}'"); $listening=@(); if($processes.Count){$listening=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)}; foreach($process in $processes){if($process.ExecutablePath -ne '${escaped}'){continue}; $match=[regex]::Match($process.CommandLine,'--csrf_token(?:=|\\s+)([^\\s]+)'); if(-not $match.Success){continue}; $ports=@($listening | Where-Object OwningProcess -eq $process.ProcessId | Select-Object -ExpandProperty LocalPort -Unique); $hostId=$null; $hostPorts=@(); try{$hostProcess=Get-Process -Id $process.ParentProcessId -ErrorAction SilentlyContinue; if($hostProcess -and $hostProcess.Path -eq '${hostExecutable}'){$hostId=$hostProcess.Id; $hostPorts=@($listening | Where-Object OwningProcess -eq $hostId | Select-Object -ExpandProperty LocalPort -Unique)}}catch{$hostId=$null; $hostPorts=@()}; $items+=[PSCustomObject]@{pid=$process.ProcessId;csrf=$match.Groups[1].Value.Trim('"');ports=$ports;host_pid=$hostId;host_ports=$hostPorts}}; ConvertTo-Json -InputObject @($items) -Compress -Depth 4`;
  let closed;
  try {
    const pending = execute("powershell.exe", ["-NoProfile", "-Command", script], { signal, windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: "utf8" });
    if (pending.child) closed = new Promise(resolve => pending.child.once("close", resolve));
    const { stdout } = await pending;
    const decoded = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (!Array.isArray(decoded) || decoded.length > 8) throw failure();
    return decoded.map(candidate => ({
      pid: requireInteger(candidate.pid, "pid", 1, 2147483647),
      csrf: requireText(candidate.csrf, "csrf", 4096),
      ports: [...new Set(candidate.ports)].slice(0, 8).map(port => requireInteger(port, "port", 1, 65535)),
      ...(Number.isSafeInteger(candidate.host_pid) && candidate.host_pid > 0 && Array.isArray(candidate.host_ports) ? {
        host_pid: candidate.host_pid,
        host_ports: [...new Set(candidate.host_ports)].filter(port => Number.isInteger(port) && port > 0 && port <= 65535).sort((left, right) => left - right).slice(0, 4),
      } : {}),
    }));
  } catch {
    throw failure("ls_discovery_failed");
  } finally {
    await closed;
  }
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
        model: typeof step.metadata?.modelUsage?.model === "string" ? step.metadata.modelUsage.model : null,
        ...(input ? { user_input: {
          text: Array.isArray(input.items) ? input.items.map(item => typeof item.text === "string" ? item.text : "").join("\n") : "",
          client_message_id: typeof input.clientMessageId === "string" ? input.clientMessageId : null,
        } } : {}),
        ...(response ? { assistant_response: {
          text: typeof response.response === "string" ? response.response : typeof response.modifiedResponse === "string" ? response.modifiedResponse : "",
          message_id: typeof response.messageId === "string" ? response.messageId : null,
          final: response.stopReason === "STOP_REASON_STOP_PATTERN",
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

  async request(endpoint, method, payload, signal) {
    if (this.closed || !METHODS.has(method)) throw failure("ls_method_rejected");
    const combined = AbortSignal.any([this.closeController.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    if (combined.aborted) throw failure("ls_cancelled");
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${endpoint.port}/${SERVICE}/${method}`, {
        method: "POST", redirect: "error", signal: combined,
        headers: { "content-type": "application/json", "x-codeium-csrf-token": endpoint.csrf },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw failure("ls_http_error");
      const reader = response.body?.getReader();
      if (!reader) return {};
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maxResponseBytes) throw failure("ls_response_too_large");
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
