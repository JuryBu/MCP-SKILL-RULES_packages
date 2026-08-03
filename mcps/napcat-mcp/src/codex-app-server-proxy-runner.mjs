import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  CodexAppServerProxyError,
  createCodexAppServerProxy,
  createWakeJournal,
} from "./codex-app-server-proxy.mjs";

const DEFAULT_DOWNSTREAM_PORT = 18432;
const DEFAULT_CONTROL_PORT = 18431;
const DEFAULT_UPSTREAM_PORT = 18433;
const DEFAULT_PROBE_PORT = 18434;
const DEFAULT_START_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RESUME_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_RESTART_BACKOFF_MS = [1000, 3000, 10000, 30000];

const CLI_OPTIONS = new Set([
  "runtime-state",
  "log",
  "stop-file",
  "lock",
  "journal",
  "token-file",
  "maintenance-file",
  "alert-file",
  "fallback-file",
  "downstream-port",
  "control-port",
  "upstream-port",
  "probe-port",
  "start-timeout-ms",
  "request-timeout-ms",
  "resume-timeout-ms",
  "codex-exe",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredPath(value, name) {
  const normalized = typeof value === "string" ? path.resolve(value) : "";
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function boundedInteger(value, name, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) throw new Error(`${name} 必须是数字`);
  const normalized = Math.trunc(parsed);
  if (normalized < minimum || normalized > maximum) throw new Error(`${name} 超出范围`);
  return normalized;
}

function publicError(error, fallbackCode = "UNEXPECTED_ERROR") {
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: error?.details ?? null,
  };
}

function atomicWriteJson(filePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fsImpl.renameSync(temporaryPath, filePath);
}

function readJsonObject(filePath, fsImpl = fs) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function appendJsonLine(filePath, value, fsImpl = fs) {
  if (!filePath) return;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function processAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function processCommandLine(pid) {
  if (process.platform !== "win32" || !processAlive(pid)) return "";
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction SilentlyContinue).CommandLine`;
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

function sameLockOwner(left, right) {
  return Number(left?.pid) === Number(right?.pid)
    && left?.token === right?.token
    && left?.startedAt === right?.startedAt;
}

function createLockFile(lockPath, metadata, fsImpl) {
  const temporaryPath = `${lockPath}.${metadata.pid}.${metadata.token}.candidate`;
  fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(metadata)}\n`, "utf8");
  try {
    fsImpl.linkSync(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    fsImpl.rmSync(temporaryPath, { force: true });
  }
}

function acquireRecoveryGuard(lockPath, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const guardPath = `${lockPath}.recovery`;
  const metadata = { pid: Number(options.pid ?? process.pid), token: crypto.randomUUID(), createdAt: new Date().toISOString() };
  try {
    const descriptor = fsImpl.openSync(guardPath, "wx");
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
    fsImpl.closeSync(descriptor);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = readJsonObject(guardPath, fsImpl);
    const ageMs = Date.now() - fsImpl.statSync(guardPath).mtimeMs;
    if (!processAlive(Number(existing.pid)) && ageMs > 30_000) {
      fsImpl.rmSync(guardPath, { force: true });
      return acquireRecoveryGuard(lockPath, options);
    }
    return null;
  }
  return {
    release() {
      const current = readJsonObject(guardPath, fsImpl);
      if (current.pid === metadata.pid && current.token === metadata.token) fsImpl.rmSync(guardPath, { force: true });
    },
  };
}

export function acquireInstanceLock(lockPath, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const pid = Number(options.pid ?? process.pid);
  const startedAt = options.startedAt ?? new Date().toISOString();
  const token = crypto.randomUUID();
  const metadata = { pid, startedAt, token };
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  const validateOwner = (existing) => {
    let existingOwnerValid = processAlive(Number(existing?.pid));
    if (existingOwnerValid && typeof options.validateExistingProcess === "function") {
      try {
        existingOwnerValid = options.validateExistingProcess(existing) !== false;
      } catch {
        existingOwnerValid = false;
      }
    }
    if (existingOwnerValid && typeof options.validateExistingLock === "function") {
      try {
        existingOwnerValid = options.validateExistingLock(existing) !== false;
      } catch {
        existingOwnerValid = false;
      }
    }
    return existingOwnerValid;
  };
  if (!createLockFile(lockPath, metadata, fsImpl)) {
    const existing = readJsonObject(lockPath, fsImpl);
    if (validateOwner(existing)) return { acquired: false, existing };
    const recovery = acquireRecoveryGuard(lockPath, { fsImpl, pid });
    if (!recovery) return { acquired: false, existing: { ...existing, recoveryInProgress: true } };
    try {
      const current = readJsonObject(lockPath, fsImpl);
      if (validateOwner(current)) return { acquired: false, existing: current };
      if (fsImpl.existsSync(lockPath)) {
        const stalePath = `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}`;
        fsImpl.renameSync(lockPath, stalePath);
      }
      if (!createLockFile(lockPath, metadata, fsImpl)) {
        return { acquired: false, existing: readJsonObject(lockPath, fsImpl) };
      }
    } finally {
      recovery.release();
    }
  }
  return {
    acquired: true,
    metadata,
    isOwner() {
      return sameLockOwner(readJsonObject(lockPath, fsImpl), metadata);
    },
    release() {
      const current = readJsonObject(lockPath, fsImpl);
      if (sameLockOwner(current, metadata)) fsImpl.rmSync(lockPath, { force: true });
    },
  };
}

function updateMaintenance(filePath, reasonKey, reasonValue, fsImpl = fs) {
  const state = readJsonObject(filePath, fsImpl);
  const reasons = isObject(state.reasons) ? { ...state.reasons } : {};
  if (reasonValue === null) delete reasons[reasonKey];
  else reasons[reasonKey] = reasonValue;
  if (!Object.keys(reasons).length) {
    fsImpl.rmSync(filePath, { force: true });
    return null;
  }
  const next = { schemaVersion: 1, reasons };
  atomicWriteJson(filePath, next, fsImpl);
  return next;
}

function resolveProxyFailureArtifacts(options, status, fsImpl = fs, now = () => new Date()) {
  const alert = readJsonObject(options.alertFilePath, fsImpl);
  if (alert.pending === true && alert.source === "codex-app-server-proxy") {
    atomicWriteJson(options.alertFilePath, {
      ...alert,
      pending: false,
      status: "superseded",
      supersededAt: now().toISOString(),
      supersededBy: `healthy-proxy:${status.instanceToken}`,
    }, fsImpl);
  }
  const fallback = readJsonObject(options.fallbackFilePath, fsImpl);
  if (fallback.pending === true && fallback.expectedProxyUrl === status.downstreamUrl) {
    fsImpl.rmSync(options.fallbackFilePath, { force: true });
  }
}

function ensureControlToken(tokenFilePath, fsImpl = fs) {
  try {
    const existing = fsImpl.readFileSync(tokenFilePath, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
  }
  const token = crypto.randomBytes(32).toString("hex");
  fsImpl.mkdirSync(path.dirname(tokenFilePath), { recursive: true });
  fsImpl.writeFileSync(tokenFilePath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

function codexCandidates(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const explicit = options.executablePath;
  if (explicit) return [path.resolve(explicit)].filter((candidate) => fsImpl.existsSync(candidate));
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const candidates = [path.join(binRoot, "codex.exe")];
  try {
    for (const entry of fsImpl.readdirSync(binRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(binRoot, entry.name, "codex.exe"));
    }
  } catch {
  }
  return [...new Set(candidates)]
    .filter((candidate) => {
      try {
        return fsImpl.statSync(candidate).isFile();
      } catch {
        return false;
      }
    })
    .map((candidate) => ({ candidate, modifiedAt: fsImpl.statSync(candidate).mtimeMs }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.candidate.localeCompare(left.candidate))
    .map((entry) => entry.candidate);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

async function terminateChild(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const pid = Number(child.pid);
  try {
    child.kill();
  } catch {
  }
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await wait(50);
  if (processAlive(pid) && process.platform === "win32") {
    try {
      const taskkill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await Promise.race([waitForExit(taskkill), wait(timeoutMs)]);
    } catch {
    }
  } else if (processAlive(pid)) {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  }
  const forceDeadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < forceDeadline) await wait(50);
  if (processAlive(pid)) {
    throw new CodexAppServerProxyError(
      "APP_SERVER_TERMINATION_FAILED",
      `Codex App Server 子进程 ${pid} 未能在受控退出后终止`,
      { details: { pid } },
    );
  }
  await Promise.race([waitForExit(child), wait(250)]);
  return true;
}

function loopbackPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function terminateManagedAppServer(child, port, options = {}) {
  if (!child) return true;
  await (options.terminateChild ?? terminateChild)(child);
  const verifyPortReleased = options.verifyPortReleased ?? loopbackPortAvailable;
  const deadline = Date.now() + (options.portReleaseTimeoutMs ?? 5000);
  let released = false;
  do {
    released = await verifyPortReleased(port);
    if (released || Date.now() >= deadline) break;
    await wait(options.portReleasePollIntervalMs ?? 50);
  } while (true);
  if (!released) {
    throw new CodexAppServerProxyError(
      "APP_SERVER_PORT_STILL_OCCUPIED",
      `受管 Codex App Server 退出后仍有进程监听回环端口 ${port}`,
      { details: { pid: child?.pid ?? null, port } },
    );
  }
  return true;
}

function spawnAppServer(executablePath, port, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(executablePath, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: options.env ?? process.env,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16000);
  });
  return { child, stderr: () => stderr };
}

function probeWebSocket(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const requestId = 1;
    const timeout = setTimeout(() => {
      cleanup();
      try {
        socket.close();
      } catch {
      }
      reject(new CodexAppServerProxyError("APP_SERVER_PROBE_TIMEOUT", `App Server 探针超时：${url}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeAllListeners();
    };
    socket.on("open", () => {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "initialize",
        params: {
          clientInfo: { name: "napcat-codex-app-server-probe", version: "1.0.0" },
          capabilities: {},
        },
      }));
    });
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      } catch {
        return;
      }
      if (message?.id !== requestId) return;
      cleanup();
      try {
        if (message.error) {
          reject(new CodexAppServerProxyError("APP_SERVER_PROBE_RPC_ERROR", message.error.message ?? "App Server 探针失败"));
        } else {
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          resolve(message.result);
        }
      } finally {
        socket.close();
      }
    });
    socket.on("error", (cause) => {
      cleanup();
      reject(new CodexAppServerProxyError("APP_SERVER_PROBE_CONNECT_FAILED", `无法连接 App Server 探针：${cause.message}`, { cause }));
    });
  });
}

async function waitForWebSocketReady(url, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await probeWebSocket(url, {
        ...options,
        timeoutMs: Math.min(1500, Math.max(250, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      await wait(150);
    }
  }
  throw lastError ?? new CodexAppServerProxyError("APP_SERVER_PROBE_TIMEOUT", `App Server 探针超时：${url}`);
}

async function probeExecutable(executablePath, port, options = {}) {
  const launched = spawnAppServer(executablePath, port, options);
  try {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let lastError = null;
    while (Date.now() < deadline) {
      if (launched.child.exitCode !== null || launched.child.signalCode !== null) {
        throw new CodexAppServerProxyError(
          "APP_SERVER_PROBE_EXITED",
          `App Server 探针提前退出：${launched.stderr() || "无 stderr"}`,
        );
      }
      try {
        const result = await probeWebSocket(`ws://127.0.0.1:${port}`, {
          ...options,
          timeoutMs: Math.min(1500, Math.max(250, deadline - Date.now())),
        });
        return result;
      } catch (error) {
        lastError = error;
        await wait(150);
      }
    }
    throw lastError ?? new CodexAppServerProxyError("APP_SERVER_PROBE_TIMEOUT", "App Server 探针超时");
  } finally {
    await terminateManagedAppServer(launched.child, port, options);
  }
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`无效参数：${item}`);
    const name = item.slice(2);
    if (!CLI_OPTIONS.has(name)) throw new Error(`不支持参数：${item}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) throw new Error(`参数缺少值：${item}`);
    values[name] = argv[index + 1];
    index += 1;
  }
  for (const name of [
    "runtime-state",
    "log",
    "stop-file",
    "lock",
    "journal",
    "token-file",
    "maintenance-file",
    "alert-file",
    "fallback-file",
  ]) {
    if (!values[name]) throw new Error(`缺少参数 --${name}`);
  }
  return {
    runtimeStatePath: requiredPath(values["runtime-state"], "runtime-state"),
    logPath: requiredPath(values.log, "log"),
    stopFilePath: requiredPath(values["stop-file"], "stop-file"),
    lockPath: requiredPath(values.lock, "lock"),
    journalPath: requiredPath(values.journal, "journal"),
    tokenFilePath: requiredPath(values["token-file"], "token-file"),
    maintenanceFilePath: requiredPath(values["maintenance-file"], "maintenance-file"),
    alertFilePath: requiredPath(values["alert-file"], "alert-file"),
    fallbackFilePath: requiredPath(values["fallback-file"], "fallback-file"),
    downstreamPort: boundedInteger(values["downstream-port"], "downstream-port", DEFAULT_DOWNSTREAM_PORT, 1, 65535),
    controlPort: boundedInteger(values["control-port"], "control-port", DEFAULT_CONTROL_PORT, 1, 65535),
    upstreamPort: boundedInteger(values["upstream-port"], "upstream-port", DEFAULT_UPSTREAM_PORT, 1, 65535),
    probePort: boundedInteger(values["probe-port"], "probe-port", DEFAULT_PROBE_PORT, 1, 65535),
    startTimeoutMs: boundedInteger(values["start-timeout-ms"], "start-timeout-ms", DEFAULT_START_TIMEOUT_MS, 1000, 300000),
    requestTimeoutMs: boundedInteger(values["request-timeout-ms"], "request-timeout-ms", DEFAULT_REQUEST_TIMEOUT_MS, 250, 300000),
    resumeRequestTimeoutMs: boundedInteger(
      values["resume-timeout-ms"],
      "resume-timeout-ms",
      DEFAULT_RESUME_REQUEST_TIMEOUT_MS,
      250,
      300000,
    ),
    executablePath: values["codex-exe"] ? path.resolve(values["codex-exe"]) : null,
  };
}

export async function runCodexAppServerProxyService(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());
  const pid = Number(options.pid ?? process.pid);
  const startedAt = now().toISOString();
  const lock = acquireInstanceLock(options.lockPath, {
    fsImpl,
    pid,
    startedAt,
    validateExistingProcess: (metadata) => {
      const commandLine = (options.processCommandLine ?? processCommandLine)(Number(metadata?.pid));
      const normalized = commandLine.toLowerCase();
      return normalized.includes("codex-app-server-proxy-runner.mjs")
        && normalized.includes(options.runtimeStatePath.toLowerCase())
        && normalized.includes(options.lockPath.toLowerCase());
    },
    validateExistingLock: (metadata) => {
      const lockStartedAt = Date.parse(metadata?.startedAt ?? "");
      const currentMs = new Date(now()).getTime();
      if (Number.isFinite(lockStartedAt) && currentMs >= lockStartedAt && currentMs - lockStartedAt <= (options.startupGraceMs ?? 60_000)) return true;
      const runtime = readJsonObject(options.runtimeStatePath, fsImpl);
      return Number(runtime.pid) === Number(metadata?.pid)
        && runtime.instanceToken === metadata?.token
        && runtime.startedAt === metadata?.startedAt
        && ["starting", "running"].includes(runtime.state)
        && processAlive(Number(metadata?.pid));
    },
  });
  if (!lock.acquired) return { state: "duplicate", pid, existingLock: lock.existing };
  fsImpl.rmSync(options.stopFilePath, { force: true });
  const controlToken = ensureControlToken(options.tokenFilePath, fsImpl);
  const previous = readJsonObject(options.runtimeStatePath, fsImpl);
  let currentExecutable = null;
  let appServer = null;
  let proxy = null;
  let stopRequested = false;
  let stopReason = null;
  let signalCleanup = () => {};
  let restartFailureCount = 0;
  let shutdownError = null;
  let status = {
    schemaVersion: 1,
    pid,
    instanceToken: lock.metadata.token,
    startedAt,
    state: "starting",
    compatible: null,
    automationEnabled: false,
    fallbackRequired: false,
    executablePath: null,
    lastKnownGoodExecutablePath: previous.lastKnownGoodExecutablePath ?? null,
    downstreamUrl: `ws://127.0.0.1:${options.downstreamPort}`,
    controlUrl: `http://127.0.0.1:${options.controlPort}`,
    upstreamUrl: `ws://127.0.0.1:${options.upstreamPort}`,
    appServerPid: null,
    proxy: null,
    restartFailureCount: 0,
    lastError: null,
    stopReason: null,
  };
  const ownsLock = () => lock.isOwner();
  const persist = (patch = {}) => {
    if (!ownsLock()) throw new CodexAppServerProxyError("INSTANCE_LOCK_LOST", "Codex App Server proxy instance no longer owns the lifecycle lock");
    status = { ...status, ...patch, updatedAt: now().toISOString() };
    atomicWriteJson(options.runtimeStatePath, status, fsImpl);
    return status;
  };
  const log = (type, details = {}) => appendJsonLine(options.logPath, {
    at: now().toISOString(),
    type,
    pid,
    ...details,
  }, fsImpl);
  const requestStop = (reason) => {
    stopRequested = true;
    if (!stopReason) stopReason = reason;
  };
  const installSignals = () => {
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => requestStop(`signal:${signal}`);
      process.on(signal, handler);
      handlers.set(signal, handler);
    }
    return () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
  };
  const markFatal = (error) => {
    if (!ownsLock()) return false;
    const errorValue = publicError(error, "CODEX_PROXY_INCOMPATIBLE");
    const at = now().toISOString();
    updateMaintenance(options.maintenanceFilePath, "codexAppServerProxy", {
      at,
      code: errorValue.code,
      message: errorValue.message,
    }, fsImpl);
    atomicWriteJson(options.alertFilePath, {
      schemaVersion: 1,
      pending: true,
      status: "pending",
      createdAt: at,
      source: "codex-app-server-proxy",
      incidentKey: `codex-app-server-proxy:${errorValue.code}`,
      code: errorValue.code,
      message: errorValue.message,
      text: `[Codex 自动唤醒已暂停]\n原因：${errorValue.code}\n详情：${errorValue.message}\n普通 Codex 启动将回退到原生 App Server，请检查本机状态。`,
    }, fsImpl);
    atomicWriteJson(options.fallbackFilePath, {
      schemaVersion: 1,
      pending: true,
      createdAt: at,
      expectedProxyUrl: status.downstreamUrl,
      code: errorValue.code,
      message: errorValue.message,
    }, fsImpl);
    persist({
      state: "degraded",
      compatible: false,
      automationEnabled: false,
      fallbackRequired: true,
      lastError: errorValue,
    });
    log("proxy_fatal", { error: errorValue });
    return true;
  };

  try {
    signalCleanup = installSignals();
    persist();
    const candidates = codexCandidates({
      fsImpl,
      executablePath: options.executablePath,
      localAppData: options.localAppData,
    });
    const orderedCandidates = [...new Set([
      ...candidates,
      status.lastKnownGoodExecutablePath,
    ].filter(Boolean))];
    let lastProbeError = null;
    for (const candidate of orderedCandidates) {
      try {
        await (options.probeExecutable ?? probeExecutable)(candidate, options.probePort, {
          ...options,
          timeoutMs: options.startTimeoutMs,
        });
        currentExecutable = candidate;
        break;
      } catch (error) {
        lastProbeError = error;
        log("candidate_probe_failed", { executablePath: candidate, error: publicError(error) });
      }
    }
    if (!currentExecutable) {
      throw lastProbeError ?? new CodexAppServerProxyError("CODEX_APP_SERVER_NOT_FOUND", "没有可用的 Codex App Server 可执行文件");
    }
    persist({
      executablePath: currentExecutable,
      lastKnownGoodExecutablePath: currentExecutable,
      compatible: true,
      fallbackRequired: false,
      lastError: null,
    });
    const journal = options.journal ?? createWakeJournal({ filePath: options.journalPath, fsImpl, now });
    const pauseForUpstream = (code, message) => ownsLock() && updateMaintenance(
      options.maintenanceFilePath,
      "codexAppServerProxyUpstream",
      { at: now().toISOString(), code, message },
      fsImpl,
    );
    const resumeAfterUpstream = () => ownsLock() && updateMaintenance(
      options.maintenanceFilePath,
      "codexAppServerProxyUpstream",
      null,
      fsImpl,
    );
    proxy = (options.createProxy ?? createCodexAppServerProxy)({
      downstreamPort: options.downstreamPort,
      controlPort: options.controlPort,
      upstreamUrl: status.upstreamUrl,
      controlToken,
      requestTimeoutMs: options.requestTimeoutMs,
      resumeRequestTimeoutMs: options.resumeRequestTimeoutMs,
      journal,
      maintenanceFilePath: options.maintenanceFilePath,
      onEvent: (event) => {
        if (event.type === "upstream_reconnect_scheduled") {
          pauseForUpstream("APP_SERVER_RECONNECTING", "Codex App Server 上游暂时不可用，自动唤醒已暂停并等待恢复");
        } else if (event.type === "upstream_connected") {
          resumeAfterUpstream();
        }
        if (event.type === "proxy_error") persist({ proxy: proxy?.status() ?? null, lastError: event.error });
        log(event.type, event);
      },
    });

    while (!stopRequested && !fsImpl.existsSync(options.stopFilePath)) {
      const launched = (options.spawnAppServer ?? spawnAppServer)(currentExecutable, options.upstreamPort, options);
      appServer = launched.child;
      persist({
        appServerPid: appServer.pid ?? null,
        appServerStartedAt: now().toISOString(),
      });
      try {
        await (options.waitForWebSocketReady ?? waitForWebSocketReady)(status.upstreamUrl, {
          ...options,
          timeoutMs: options.startTimeoutMs,
        });
        if (!proxy.startedAt) await proxy.start();
        resumeAfterUpstream();
        restartFailureCount = 0;
        persist({
          state: "running",
          compatible: true,
          automationEnabled: true,
          fallbackRequired: false,
          executablePath: currentExecutable,
          lastKnownGoodExecutablePath: currentExecutable,
          appServerPid: appServer.pid ?? null,
          proxy: proxy.status(),
          restartFailureCount,
          lastError: null,
        });
        if (ownsLock()) {
          updateMaintenance(options.maintenanceFilePath, "codexAppServerProxy", null, fsImpl);
          resolveProxyFailureArtifacts(options, status, fsImpl, now);
        }
        log("app_server_started", { executablePath: currentExecutable, appServerPid: appServer.pid ?? null });
        const exit = await Promise.race([
          waitForExit(appServer),
          (async () => {
            while (!stopRequested && !fsImpl.existsSync(options.stopFilePath)) await wait(250);
            return { code: null, signal: "stop_requested" };
          })(),
        ]);
        if (stopRequested || fsImpl.existsSync(options.stopFilePath)) break;
        restartFailureCount += 1;
        pauseForUpstream("APP_SERVER_EXITED", "Codex App Server 意外退出，自动唤醒已暂停并等待透明中转恢复");
        persist({
          state: "restarting",
          automationEnabled: false,
          appServerPid: null,
          proxy: proxy.status(),
          restartFailureCount,
          lastError: {
            code: "APP_SERVER_EXITED",
            message: `App Server 意外退出：code=${exit.code ?? "null"}, signal=${exit.signal ?? "null"}`,
            stderr: launched.stderr(),
          },
        });
        log("app_server_exited", { ...exit, stderr: launched.stderr(), restartFailureCount });
      } catch (error) {
        restartFailureCount += 1;
        pauseForUpstream("APP_SERVER_START_FAILED", "Codex App Server 启动失败，自动唤醒已暂停并等待重试");
        persist({
          state: "restarting",
          automationEnabled: false,
          appServerPid: null,
          restartFailureCount,
          lastError: publicError(error),
        });
        log("app_server_start_failed", { error: publicError(error), restartFailureCount });
      } finally {
        await terminateManagedAppServer(appServer, options.upstreamPort, options);
        appServer = null;
        persist({ appServerPid: null });
      }
      if (restartFailureCount >= DEFAULT_RESTART_BACKOFF_MS.length) {
        markFatal(new CodexAppServerProxyError(
          "APP_SERVER_RESTART_EXHAUSTED",
          "Codex App Server 连续恢复失败，已暂停 NapCat 自动唤醒并请求下次启动回到原生模式",
          { details: { restartFailureCount } },
        ));
        requestStop("fallback_required");
        break;
      }
      const backoff = DEFAULT_RESTART_BACKOFF_MS[Math.min(restartFailureCount - 1, DEFAULT_RESTART_BACKOFF_MS.length - 1)];
      await wait(backoff);
    }
    stopReason = stopReason ?? (fsImpl.existsSync(options.stopFilePath) ? "stop_file" : "requested");
    persist({ state: "stopping", automationEnabled: false, stopReason });
  } catch (error) {
    markFatal(error);
    return { state: "failed", pid, error: publicError(error) };
  } finally {
    signalCleanup();
    await proxy?.close().catch(() => {});
    try {
      await terminateManagedAppServer(appServer, options.upstreamPort, options);
      appServer = null;
    } catch (error) {
      shutdownError = error;
      markFatal(error);
      log("app_server_termination_failed", {
        appServerPid: appServer?.pid ?? status.appServerPid ?? null,
        error: publicError(error),
      });
    }
    if (ownsLock()) fsImpl.rmSync(options.stopFilePath, { force: true });
    if (ownsLock() && !shutdownError && status.state !== "degraded") {
      persist({
        state: "stopped",
        automationEnabled: false,
        appServerPid: null,
        proxy: proxy?.status() ?? null,
        stopReason: stopReason ?? "completed",
      });
    }
    log(ownsLock() ? (shutdownError ? "proxy_service_degraded" : "proxy_service_stopped") : "proxy_service_lock_lost", {
      stopReason: stopReason ?? "completed",
      appServerPid: shutdownError ? (appServer?.pid ?? status.appServerPid ?? null) : null,
      error: shutdownError ? publicError(shutdownError) : null,
    });
    lock.release();
  }
  return shutdownError
    ? { state: "failed", pid, stopReason, error: publicError(shutdownError) }
    : { state: "stopped", pid, stopReason };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await runCodexAppServerProxyService(options);
  if (result.state === "failed") {
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ state: "failed", error: publicError(error) })}\n`);
    process.exitCode = 1;
  });
}
