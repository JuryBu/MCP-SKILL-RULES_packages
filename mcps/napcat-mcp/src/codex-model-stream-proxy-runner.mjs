import fs from "node:fs";
import path from "node:path";
import { createBoundedJsonlWriter } from "./bounded-jsonl-log.mjs";
import process from "node:process";
import crypto from "node:crypto";
import { createCodexModelStreamProxy } from "./codex-model-stream-proxy.mjs";
import { createModelObserver } from "./model-observer.mjs";
import { renameReplaceSync } from "./atomic-file.mjs";
import { parseToolDeliveryProfile } from "./tool-delivery-profile.mjs";
import { createAdaptiveDeliveryRegistry } from "./adaptive-delivery.mjs";
import { isolatedHandoffConfiguration, attachInnerRunnerHandoffControl } from "./inner-runner-handoff-control.mjs";
import { readUploadAllowancePolicy } from "./upload-allowance-policy.mjs";
import { createIncrementalResponsesTransport } from "./incremental-responses-transport.mjs";
import { readModelRuntimeEnvironment } from "./model-runtime-policy.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(effectiveEnvironment[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function booleanEnvironment(name, fallback = false) {
  const value = effectiveEnvironment[name];
  if (value === undefined) return fallback;
  if (value !== "0" && value !== "1") throw new Error(`${name} must be 0 or 1`);
  return value === "1";
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx");
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    renameReplaceSync(temporaryPath, filePath);
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(filePath), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
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
const deliveryProfilePath = path.join(stateRoot, "codex-model-stream-delivery-profiles.json");
const adaptiveStatePath = path.join(stateRoot, "codex-model-adaptive-delivery.json");
const operationStatePath = path.join(stateRoot, "codex-model-operation-state.json");
const durableRecoveryStatePath = path.join(stateRoot, "codex-model-recovery-state.json");
const handoffConfig = isolatedHandoffConfiguration({
  stateRoot,
  host: process.env.CODEX_MODEL_STREAM_PROXY_HOST ?? "127.0.0.1",
  upstreamOrigin: process.env.CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN ?? "https://chatgpt.com",
});
const effectiveEnvironment = readModelRuntimeEnvironment({ stateRoot: handoffConfig?.runtimeProfile?.stateRoot ?? stateRoot,
  corePath: new URL("./codex-model-stream-proxy.mjs", import.meta.url) });
const managedRecovery = booleanEnvironment("CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY");
const incrementalEnabled = booleanEnvironment("CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS");
const incrementalImagesEnabled = booleanEnvironment("CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES");
if (incrementalEnabled && !managedRecovery) throw new Error("Incremental WS requires managed recovery");
if (incrementalImagesEnabled && !incrementalEnabled) throw new Error("Incremental images require incremental WS");
const incrementalUpstreamUrl = process.env.CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL;
if (incrementalEnabled && !/^wss?:\/\//u.test(incrementalUpstreamUrl ?? "")) {
  throw new Error("Incremental WS requires an explicit ws or wss upstream URL");
}
fs.mkdirSync(stateRoot, { recursive: true });

function readToolDeliveryProfile() {
  if (!fs.existsSync(deliveryProfilePath)) {
    return { schemaVersion: 1, bufferedToolIdentityHashes: [] };
  }
  return parseToolDeliveryProfile(fs.readFileSync(deliveryProfilePath, "utf8"));
}

const deliveryProfile = readToolDeliveryProfile();

const operationalLog = createBoundedJsonlWriter({ filePath: logPath });
const anomalyLog = createBoundedJsonlWriter({
  filePath: path.join(stateRoot, "codex-model-stream-anomalies.jsonl"),
});
const ANOMALY_EVENT_TYPES = new Set([
  "attempt_progress_timeout",
  "native_retry_signal",
  "local_tool_phase_retry_signal",
  "local_tool_phase_timeout",
  "retry_exhausted_terminal_failure",
  "usage_limit_terminal_failure",
  "permanent_failure_terminal_failure",
  "safety_policy_terminal_failure",
  "compaction_retry_signal",
  "guarded_request_error",
  "guarded_error_retry_signal",
  "guarded_error_terminal_failure",
  "model_terminal_failure",
  "request_acceptance_unresolved",
  "model_recovery_state",
  "passthrough_error",
  "adaptive_delivery_probe_started",
  "adaptive_delivery_mode_changed",
  "adaptive_late_streaming_success",
  "adaptive_wait_stopped",
  "adaptive_delivery_state_write_failed",
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

let stopping = false;
let heartbeat = null;
let stopWatcher = null;
let handoffControl = null;
let consecutiveRuntimeWriteFailures = 0;
const heartbeatIntervalMs = integerEnvironment("CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS", 5_000, 100, 60_000);
const drainTimeoutMs = integerEnvironment("CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS", 45_000, 100, 120_000);
function readAdaptiveState() {
  if (!fs.existsSync(adaptiveStatePath)) return undefined;
  try {
    if (fs.statSync(adaptiveStatePath).size > 128 * 1024) throw new Error("State exceeds size limit");
    return createAdaptiveDeliveryRegistry({ state: JSON.parse(fs.readFileSync(adaptiveStatePath, "utf8")) }).snapshot();
  } catch {
    appendRunnerEvent({ type: "adaptive_delivery_state_ignored", reason: "invalid_or_expired_state" });
    return undefined;
  }
}
function readOperationState() {
  if (!fs.existsSync(operationStatePath)) return undefined;
  if (fs.statSync(operationStatePath).size > 2 * 1024 * 1024) throw new Error("MODEL_OPERATION_STATE_TOO_LARGE");
  const state = JSON.parse(fs.readFileSync(operationStatePath, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("MODEL_OPERATION_STATE_INVALID");
  return state;
}
function readDurableRecoveryState() {
  if (!fs.existsSync(durableRecoveryStatePath)) return undefined;
  if (fs.statSync(durableRecoveryStatePath).size > 2 * 1024 * 1024) throw new Error("MODEL_OPERATION_RECOVERY_STATE_TOO_LARGE");
  return JSON.parse(fs.readFileSync(durableRecoveryStatePath, "utf8"));
}
const incrementalTransport = incrementalEnabled ? createIncrementalResponsesTransport({
  allowImagePrewarm: incrementalImagesEnabled,
  maxSessions: integerEnvironment("CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS", 32, 1, 128),
  maxSessionBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSION_BYTES", 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  maxMessageBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_WS_MAX_MESSAGE_BYTES", 1024 * 1024, 1024, 16 * 1024 * 1024),
}) : null;
const proxy = createCodexModelStreamProxy({
  ...readUploadAllowancePolicy(handoffConfig?.runtimeProfile?.stateRoot ?? stateRoot, effectiveEnvironment),
  onModelObservation: event => modelObserver.observe(event),
  instanceToken,
  host: process.env.CODEX_MODEL_STREAM_PROXY_HOST ?? "127.0.0.1",
  port: integerEnvironment("CODEX_MODEL_STREAM_PROXY_PORT", 18435, handoffConfig ? 0 : 1, 65535),
  upstreamOrigin: process.env.CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN ?? "https://chatgpt.com",
  heartbeatIntervalMs,
  managedRecovery,
  managedRetryBaseMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MANAGED_RETRY_BASE_MS", 5000, 10, 60000),
  largeHttpBodyBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_LARGE_HTTP_BODY_BYTES", 4 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  operationState: readOperationState(),
  onOperationStateChange(state) { writeJsonAtomic(operationStatePath, state); },
  durableRecoveryState: readDurableRecoveryState(),
  onDurableRecoveryStateChange(state) { writeJsonAtomic(durableRecoveryStatePath, state); },
  onRecoveryState(event) { handoffControl?.publishRecovery(event); },
  incrementalTransport,
  incrementalUpstreamUrl,
  incrementalImagesEnabled,
  firstProgressTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_FIRST_PROGRESS_TIMEOUT_MS", 40_000, 1_000, 300_000),
  progressIdleTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_PROGRESS_IDLE_TIMEOUT_MS", 40_000, 1_000, 300_000),
  adaptiveWaitLimitMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_ADAPTIVE_WAIT_LIMIT_MS", 300_000, 1_000, 300_000),
  upstreamIdleTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS", 90_000, 1_000, 300_000),
  adaptiveDeliveryState: readAdaptiveState(),
  onAdaptiveDeliveryStateChange(state) { writeJsonAtomic(adaptiveStatePath, state); },
  compactionAttemptTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_COMPACTION_ATTEMPT_TIMEOUT_MS", 600_000, 10_000, 600_000),
  maxConsecutiveAttempts: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_CONSECUTIVE_ATTEMPTS", 6, 1, 20),
  maxBufferedRequestBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_BUFFERED_REQUEST_BYTES", 128 * 1024 * 1024, 1_024, 256 * 1024 * 1024),
  maxDecodedRequestBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_DECODED_REQUEST_BYTES", 192 * 1024 * 1024, 1_024, 256 * 1024 * 1024),
  maxTotalRequestBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_TOTAL_REQUEST_BYTES", 256 * 1024 * 1024, 1_024, 512 * 1024 * 1024),
  bufferedToolIdentityHashes: deliveryProfile.bufferedToolIdentityHashes,
  bufferedToolPreparationGraceMs: 300_000,
  onEvent(event) {
    appendRunnerEvent(event);
  },
});

const lockHandle = fs.openSync(lockPath, "wx");
try {
  fs.writeFileSync(lockHandle, `${JSON.stringify({ pid: process.pid, instanceToken, startedAt })}\n`, "utf8");
} finally {
  fs.closeSync(lockHandle);
}
const modelObserver = createModelObserver({
  filePath: path.join(stateRoot, "codex-model-observations.jsonl"),
  statusPath: path.join(stateRoot, "codex-model-observer-runtime.json"),
  producerInstance: instanceToken,
});

function releaseOwnLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.pid === process.pid && lock.instanceToken === instanceToken) fs.unlinkSync(lockPath);
  } catch {}
}

function runtimeState(status = "running", error = null) {
  return {
    schemaVersion: 1,
    status,
    pid: process.pid,
    instanceToken,
    implementationVersion: proxy.status().implementationVersion,
    startedAt,
    livenessAt: new Date().toISOString(),
    endpoint: `http://${proxy.status().host}:${proxy.status().port}`,
    upstreamOrigin: proxy.status().upstreamOrigin,
    firstProgressTimeoutMs: proxy.status().firstProgressTimeoutMs,
    uploadAllowanceMsPerMiB: proxy.status().uploadAllowanceMsPerMiB,
    maxUploadAllowanceMs: proxy.status().maxUploadAllowanceMs,
    toolPreparationGraceMs: proxy.status().toolPreparationGraceMs,
    bufferedToolPreparationGraceMs: proxy.status().bufferedToolPreparationGraceMs,
    bufferedToolProfileCount: proxy.status().bufferedToolProfileCount,
    progressIdleTimeoutMs: proxy.status().progressIdleTimeoutMs,
    adaptiveWaitLimitMs: proxy.status().adaptiveWaitLimitMs,
    upstreamIdleTimeoutMs: proxy.status().upstreamIdleTimeoutMs,
    adaptiveDelivery: proxy.status().adaptiveDelivery,
    compactionAttemptTimeoutMs: proxy.status().compactionAttemptTimeoutMs,
    maxConsecutiveAttempts: proxy.status().maxConsecutiveAttempts,
    maxLocalToolAttempts: proxy.status().maxLocalToolAttempts,
    retryDelaysMs: proxy.status().retryDelaysMs,
    heartbeatIntervalMs,
    drainTimeoutMs,
    draining: proxy.status().draining,
    activeRequests: proxy.status().activeRequests,
    managedRecovery: proxy.status().managedRecovery,
    incrementalEnabled,
    incrementalImagesEnabled,
    recoveryWaitingRequests: proxy.status().recoveryWaitingRequests,
    operationLedger: proxy.status().operationLedger,
    incrementalTransport: proxy.status().incrementalTransport,
    maxBufferedRequestBytes: proxy.status().maxBufferedRequestBytes,
    maxDecodedRequestBytes: proxy.status().maxDecodedRequestBytes,
    requestBuffer: proxy.status().requestBuffer,
    requestInspection: proxy.status().requestInspection,
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

async function closeModelObserver() {
  const timely = await modelObserver.close();
  if (!timely) {
    writeRuntimeState("failed", { code: "MODEL_OBSERVER_CLOSE_PENDING", message: "Observer writes are still settling; instance lock is retained." }, "observer_close_pending");
    await modelObserver.flush();
  }
  return timely;
}

async function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  clearInterval(stopWatcher);
  try {
    proxy.beginDrain();
    writeRuntimeState("draining", null, "drain");
    const deadline = Date.now() + drainTimeoutMs;
    while (proxy.status().activeRequests > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (proxy.status().activeRequests > 0) appendRunnerEvent({ type: "drain_timeout", activeRequests: proxy.status().activeRequests });
    await proxy.stop();
  } catch (error) {
    writeRuntimeState("failed", { code: error.code ?? "STOP_FAILED", message: error.message }, "shutdown_failed");
    exitCode = 1;
  }
  try {
    if (!await closeModelObserver()) exitCode = 1;
    if (!proxy.status().running && proxy.status().activeRequests === 0) {
      writeRuntimeState("stopped", null, "shutdown");
      releaseOwnLock();
    } else exitCode = 1;
  } catch (error) {
    writeRuntimeState("failed", { code: "MODEL_OBSERVER_CLOSE_FAILED", message: "Observer ownership was not released." }, "observer_close_failed");
    exitCode = 1;
  }
  appendRunnerEvent({ type: "runner_stopped", reason, exitCode });
  process.exitCode = exitCode;
  handoffControl?.close();
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
  handoffControl = attachInnerRunnerHandoffControl({
    config: handoffConfig, proxy, instanceToken, runnerPath: new URL(import.meta.url),
    onEvent: appendRunnerEvent, shutdown, isStopping: () => stopping,
  });
  heartbeat = setInterval(() => writeRuntimeState("running", null, "heartbeat"), heartbeatIntervalMs);
  heartbeat.unref?.();
  stopWatcher = setInterval(() => {
    if (fs.existsSync(stopPath)) void shutdown("stop_file");
  }, 500);
} catch (error) {
  writeRuntimeState("failed", { code: error.code ?? "START_FAILED", message: error.message }, "startup_failed");
  appendRunnerEvent({ type: "runner_start_failed", code: error.code ?? "START_FAILED", message: error.message });
  await proxy.stop();
  await closeModelObserver();
  if (!proxy.status().running && proxy.status().activeRequests === 0) releaseOwnLock();
  process.exitCode = 1;
  handoffControl?.close();
}
