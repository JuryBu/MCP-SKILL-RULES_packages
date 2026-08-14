import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { createCodexModelStreamProxy } from "./codex-model-stream-proxy.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

const stateRoot = path.resolve(process.env.CODEX_MODEL_STREAM_PROXY_STATE_ROOT
  ?? path.join(process.env.USERPROFILE ?? process.cwd(), ".codex-toolkit", "napcat-mcp", "state"));
const runtimePath = path.join(stateRoot, "codex-model-stream-proxy-runtime.json");
const logPath = path.join(stateRoot, "codex-model-stream-proxy.jsonl");
const stopPath = path.join(stateRoot, "codex-model-stream-proxy.stop");
const lockPath = path.join(stateRoot, "codex-model-stream-proxy.lock.json");
fs.mkdirSync(stateRoot, { recursive: true });

const startedAt = new Date().toISOString();
const instanceToken = crypto.randomUUID();
const lockHandle = fs.openSync(lockPath, "wx");
fs.writeFileSync(lockHandle, `${JSON.stringify({ pid: process.pid, instanceToken, startedAt })}\n`, "utf8");
fs.closeSync(lockHandle);

let stopping = false;
let heartbeat = null;
let stopWatcher = null;
const proxy = createCodexModelStreamProxy({
  host: process.env.CODEX_MODEL_STREAM_PROXY_HOST ?? "127.0.0.1",
  port: integerEnvironment("CODEX_MODEL_STREAM_PROXY_PORT", 18435, 1, 65535),
  upstreamOrigin: process.env.CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN ?? "https://chatgpt.com",
  firstProgressTimeoutMs: integerEnvironment("CODEX_MODEL_STREAM_PROXY_FIRST_PROGRESS_TIMEOUT_MS", 60_000, 1_000, 300_000),
  maxBufferedRequestBytes: integerEnvironment("CODEX_MODEL_STREAM_PROXY_MAX_BUFFERED_REQUEST_BYTES", 64 * 1024 * 1024, 1_024, 256 * 1024 * 1024),
  onEvent(event) {
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
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
    activeRequests: proxy.status().activeRequests,
    counters: proxy.status().counters,
    error,
  };
}

async function shutdown(reason, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  clearInterval(stopWatcher);
  try {
    await proxy.stop();
    writeJsonAtomic(runtimePath, runtimeState("stopped", null));
  } catch (error) {
    writeJsonAtomic(runtimePath, runtimeState("failed", { code: error.code ?? "STOP_FAILED", message: error.message }));
    exitCode = 1;
  }
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (lock.pid === process.pid && lock.instanceToken === instanceToken) fs.unlinkSync(lockPath);
  } catch {}
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), type: "runner_stopped", reason, exitCode })}\n`, "utf8");
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), type: "runner_uncaught_exception", code: error.code ?? "UNCAUGHT", message: error.message })}\n`, "utf8");
  void shutdown("uncaughtException", 1);
});
process.once("unhandledRejection", (error) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), type: "runner_unhandled_rejection", code: normalized.code ?? "UNHANDLED", message: normalized.message })}\n`, "utf8");
  void shutdown("unhandledRejection", 1);
});

try {
  await proxy.start();
  writeJsonAtomic(runtimePath, runtimeState());
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), type: "runner_started", pid: process.pid, endpoint: runtimeState().endpoint })}\n`, "utf8");
  heartbeat = setInterval(() => writeJsonAtomic(runtimePath, runtimeState()), 5_000);
  heartbeat.unref?.();
  stopWatcher = setInterval(() => {
    if (fs.existsSync(stopPath)) void shutdown("stop_file");
  }, 500);
} catch (error) {
  writeJsonAtomic(runtimePath, runtimeState("failed", { code: error.code ?? "START_FAILED", message: error.message }));
  try { fs.unlinkSync(lockPath); } catch {}
  throw error;
}
