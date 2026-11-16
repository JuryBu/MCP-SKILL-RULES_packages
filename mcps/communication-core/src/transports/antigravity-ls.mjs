import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, win32 } from "node:path";
import { CoreError, requireInteger, requireText } from "../contracts.mjs";

const execute = promisify(execFile);
const SERVICE = "exa.language_server_pb.LanguageServerService";
const METHODS = new Set(["GetAllCascadeTrajectories", "GetCascadeTrajectorySteps", "SendUserCascadeMessage"]);

function failure(code = "ls_unavailable") {
  return new CoreError(code, "反重力对话接口未取得可核对结果");
}

export async function discoverAntigravityProcesses({ signal, executablePath } = {}) {
  const requested = executablePath ?? join(process.env.LOCALAPPDATA ?? "", "Programs", "antigravity", "resources", "bin", "language_server.exe");
  if (typeof requested !== "string" || !/^[A-Za-z]:[\\/]/.test(requested) || /[\u0000-\u001f\u007f]/.test(requested)) throw failure("ls_path_missing");
  const expected = win32.normalize(requested);
  const executableName = win32.basename(expected);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.exe$/i.test(executableName)) throw failure("ls_path_missing");
  const escaped = expected.replaceAll("'", "''");
  const escapedName = executableName.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; $items=@(); foreach($process in Get-CimInstance Win32_Process -Filter "Name='${escapedName}'"){if($process.ExecutablePath -ne '${escaped}'){continue}; $match=[regex]::Match($process.CommandLine,'--csrf_token(?:=|\\s+)([^\\s]+)'); if(-not $match.Success){continue}; $ports=@(Get-NetTCPConnection -OwningProcess $process.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique); $items+=[PSCustomObject]@{pid=$process.ProcessId;csrf=$match.Groups[1].Value.Trim('"');ports=$ports}}; ConvertTo-Json -InputObject @($items) -Compress -Depth 4`;
  try {
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-Command", script], { signal, windowsHide: true, timeout: 8000, maxBuffer: 128 * 1024, encoding: "utf8" });
    const decoded = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
    if (!Array.isArray(decoded) || decoded.length > 8) throw failure();
    return decoded.map(candidate => ({
      pid: requireInteger(candidate.pid, "pid", 1, 2147483647),
      csrf: requireText(candidate.csrf, "csrf", 4096),
      ports: [...new Set(candidate.ports)].slice(0, 8).map(port => requireInteger(port, "port", 1, 65535)),
    }));
  } catch {
    throw failure("ls_discovery_failed");
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
  constructor({ discover = discoverAntigravityProcesses, fetchImpl = fetch, timeoutMs = 8000, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
    this.discover = discover;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = requireInteger(timeoutMs, "timeoutMs", 50, 30000);
    this.maxResponseBytes = requireInteger(maxResponseBytes, "maxResponseBytes", 1024, 16 * 1024 * 1024);
    this.endpoints = new Map();
    this.closed = false;
    this.submissionTracking = true;
  }

  async request(endpoint, method, payload, signal) {
    if (this.closed || !METHODS.has(method)) throw failure("ls_method_rejected");
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
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
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    const candidates = await this.discover({ signal: operationSignal });
    const matches = [];
    for (const candidate of candidates) {
      for (const port of candidate.ports) {
        const endpoint = { pid: candidate.pid, csrf: candidate.csrf, port };
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
    this.endpoints.set(cascadeId, matches[0].endpoint);
    return matches[0];
  }

  async describe(target, options = {}) {
    return (await this.resolve(target, options)).description;
  }

  async describeHost({ signal } = {}) {
    const source = "antigravity_ls";
    if (this.closed) return { source, host_online: "unknown", code: "ls_closed" };
    if (signal?.aborted) return { source, host_online: "unknown", code: "ls_cancelled" };
    const controller = new AbortController();
    const onAbort = () => controller.abort("ls_cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
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
      signal?.removeEventListener("abort", onAbort);
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
    this.endpoints.clear();
  }
}
