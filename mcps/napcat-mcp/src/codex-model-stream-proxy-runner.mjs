import fs from "node:fs";
import path from "node:path";
import { createBoundedJsonlWriter } from "./bounded-jsonl-log.mjs";
import process from "node:process";
import crypto from "node:crypto";
import { createCodexModelStreamProxy } from "./codex-model-stream-proxy.mjs";
import { renameReplaceSync } from "./atomic-file.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameReplaceSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

const stateRoot = path.resolve(process.env.CODEX_MODEL_STREAM_PROXY_STATE_ROOT
  ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".codex-toolkit", "napcat-mcp", "state"));
const runtimePath = path.join(stateRoot, "codex-model-stream-proxy-runtime.json");
const logPath = path.join(stateRoot, "codex-model-stream-proxy.jsonl");
const stopPath = path.join(stateRoot, "codex-model-stream-proxy.stop");
const lockPath = path.join(stateRoot, "codex-model-stream-proxy.lock.json");
fs.mkdirSync(stateRoot, { recursive: true });

const operationalLog = createBoundedJsonlWriter({ filePath: logPath });
const anomalyLog = createBoundedJsonlWriter({
  filePath: path.join(stateRoot, "codex-model-stream-anomalies.jsonl"),
});
const ANOMALY_EVENT_TYPES = new Set([
  "attempt_progress_timeout",
  "native_retry_signal",
  "retry_exhausted_completed_idle",
  "usage_limit_completed_idle",
  "permanent_failure_completed_idle",
  "compaction_retry_signal",
  "guarded_request_error",
  "guarded_error_retry_signal",
  "guarded_error_completed_idle",
  "passthrough_error",
]);

function appendRunnerEvent(event) {
  try {
    operationalLog.append({ at: new Date().toISOString(), ...event });
    if (ANOMALY_EVENT_TYPES.has(event.type)) {
      anomalyLog.append({ at: new Date().toISOString(), layer: "model_stream_proxy", ...event });
    }
    return true;
  } catch (error) {
    try {
      process.stderr.write(`model stream proxy log write failed: ${error.code ?? "LOG_WRITE_FAILED"}: ${error.message}\n`);
    } catch {}
    return false;
  }
}

const startedAt = new Date().toISOString();
const instanceToken = crypto.randomUUID();
const lockHandle = fs.openSync(lockPath, "wx");
fs.writeFileSync(lockHandle, `${JSON.stringify({ pid: process.pid, instanceToken, startedAt })}\n`, "utf8");
fs.closeSync(lockHandle);

let stopping = false;
let heartbeat = null;
let stopWatcher = null;
let consecutiveRuntimeWriteFailures = 0;
const heartbeatIntervalMs = integerEnvironment("CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS", 5_000, 100, 60_000);
const proxy = createCodexModelStreamProxy({
  host: process.env.CODEX_MODEL_STREAM_PROXY_HOST ?? "127.0.0.1",
  port: integerEnvironment("CODEX_MODEL_STREAM_PROXY_PORT", 18435, 1, 65535),
  upstreamOrigin: process.env.CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN ?? "https://chatgpt.com",
  firstProgressTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_FIRST_PROGRESS_TIMEOUT_MS", 30_000, 1_000, 300_000),
  progressIdleTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_PROGRESS_IDLE_TIMEOUT_MS", 20_000, 1_000, 300_000),
  compactionAttemptTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_COMPACTION_ATTEMPT_TIMEOUT_MS", 150_000, 10_000, 600_000),
  maxConsecutiveAttempts: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_CONSECUTIVE_ATTEMPTS", 6, 1, 20),
  maxBufferedRequestBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_BUFFERED_REQUEST_BYTES", 64 * 1024 * 1024, 1_024, 256 * 1024 * 1024),
  onEvent(event) {
    appendRunnerEvent(event);
  },
});

function runtimeState(status = "running", error = null) {
  return {
    schemaVersion: 1,
    status,
    pid: process.pid,
    instanceToken,
    startedAt,
    livenessAt: new Date().toISOString(),
    endpoint: `http://${proxy.status().host}:${proxy.status().port}`,
    upstreamOrigin: proxy.status().upstreamOrigin,
    firstProgressTimeoutMs: proxy.status().firstProgressTimeoutMs,
    progressIdleTimeoutMs: proxy.status().progressIdleTimeoutMs,
    compactionAttemptTimeoutMs: proxy.status().compactionAttemptTimeoutMs,
    maxConsecutiveAttempts: proxy.status().maxConsecutiveAttempts,
    heartbeatIntervalMs,
    activeRequests: proxy.status().activeRequests,
    counters: proxy.status().counters,
    error,
  };
}

function writeRuntimeState(status = "running", error = null, phase = "heartbeat", fatal = false) {
  try {
    writeJsonAtomic(runtimePath, runtimeState(status, error));
    if (consecutiveRuntimeWriteFailures > 0) {
      appendRunnerEvent({
        type: "runtime_state_write_recovered",
        phase,
        previousConsecutiveFailures: consecutiveRuntimeWriteFailures,
      });
    }
    consecutiveRuntimeWriteFailures = 0;
    return true;
  } catch (writeError) {
    consecutiveRuntimeWriteFailures += 1;
    appendRunnerEvent({
      type: "runtime_state_write_failed",
      phase,
      consecutiveFailures: consecutiveRuntimeWriteFailures,
      code: writeError.code ?? "RUNTIME_STATE_WRITE_FAILED",
      message: writeError.message,
    });
    if (fatal) throw writeError;
    return false;
  }
}

async function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  clearInterval(stopWatcher);
  try {
    await proxy.stop();
    writeRuntimeState("stopped", null, "shutdown");
  } catch (error) {
    writeRuntimeState("failed", { code: error.code ?? "STOP_FAILED", message: error.message }, "shutdown_failed");
    exitCode = 1;
  }
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.pid === process.pid && lock.instanceToken === instanceToken) fs.unlinkSync(lockPath);
  } catch {}
  appendRunnerEvent({ type: "runner_stopped", reason, exitCode });
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  appendRunnerEvent({ type: "runner_uncaught_exception", code: error.code ?? "UNCAUGHT", message: error.message });
  void shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (error) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  appendRunnerEvent({ type: "runner_unhandled_rejection", code: normalized.code ?? "UNHANDLED", message: normalized.message });
  void shutdown("unhandledRejection", 1);
});

try {
  await proxy.start();
  writeRuntimeState("running", null, "startup", true);
  appendRunnerEvent({ type: "runner_started", pid: process.pid, endpoint: runtimeState().endpoint });
  heartbeat = setInterval(() => writeRuntimeState("running", null, "heartbeat"), heartbeatIntervalMs);
  heartbeat.unref?.();
  stopWatcher = setInterval(() => {
    if (fs.existsSync(stopPath)) void shutdown("stop_file");
  }, 500);
} catch (error) {
  writeRuntimeState("failed", { code: error.code ?? "START_FAILED", message: error.message }, "startup_failed");
  try { fs.unlinkSync(lockPath); } catch {}
  throw error;
}
