import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { renameReplaceSync } from "./atomic-file.mjs";
import { windowsPowerShellEnvironment } from "./windows-powershell-environment.mjs";
import { createManagedEventObserver } from "./inner-managed-events.mjs";
import { createProxyServiceCodeRuntime } from "./proxy-service-code-runtime.mjs";
import {
  digestCodexSource,
  inspectCodexSource,
  prepareCodexRuntimeBundle,
  verifyCodexRuntimeBundle,
} from "./codex-runtime-bundle.mjs";
import {
  CodexAppServerProxyError,
  createCodexAppServerProxy,
  createWakeJournal,
} from "./codex-app-server-proxy.mjs";

const DEFAULT_DOWNSTREAM_PORT = 18432;
const DEFAULT_CONTROL_PORT = 18431;
const DEFAULT_UPSTREAM_PORT = 18433;
const DEFAULT_PROBE_PORT = 18434;
const DEFAULT_START_TIMEOUT_MS = 45000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RESUME_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_RESTART_BACKOFF_MS = [1000, 3000, 10000, 30000];
const DEFAULT_EXECUTABLE_REFRESH_INTERVAL_MS = 250;
const DEFAULT_BUNDLE_DEEP_CHECK_INTERVAL_MS = 300000;
const DEFAULT_STARTUP_BUDGET_MS = 105000;
const DEFAULT_REFRESH_BUDGET_MS = 20000;
const DEFAULT_EMPTY_CLIENT_RESTART_MS = 10000;
const DEFAULT_LIVENESS_INTERVAL_MS = 15000;

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
  "startup-budget-ms",
  "request-timeout-ms",
  "resume-timeout-ms",
  "empty-client-restart-ms",
  "codex-exe",
  "display-policy-root",
  "outer-runtime-root",
  "request-metadata-enabled",
  "instance-token",
  "launch-receipt",
  "inner-managed-profile",
  "inner-managed-profile-sha256",
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

function strictBoolean(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} 必须为 true 或 false`);
}

export function observeEmptyDesktopRestart(previousState = {}, input = {}) {
  const restartMs = Number(input.restartMs ?? DEFAULT_EMPTY_CLIENT_RESTART_MS);
  if (!Number.isFinite(restartMs) || restartMs <= 0) {
    return { state: { sawDesktopClient: false, emptySinceMs: null }, shouldRestart: false, emptyForMs: 0 };
  }
  const nowMs = Number(input.nowMs);
  const rawClientCount = Number(input.clientCount);
  const clientCount = Number.isFinite(rawClientCount) && rawClientCount >= 0 ? rawClientCount : 1;
  const sawDesktopClient = Boolean(previousState.sawDesktopClient) || clientCount > 0;
  if (!sawDesktopClient) {
    return { state: { sawDesktopClient: false, emptySinceMs: null }, shouldRestart: false, emptyForMs: 0 };
  }
  if (clientCount > 0) {
    return { state: { sawDesktopClient: true, emptySinceMs: null }, shouldRestart: false, emptyForMs: 0 };
  }
  const emptySinceMs = previousState.emptySinceMs !== null
    && previousState.emptySinceMs !== undefined
    && Number.isFinite(Number(previousState.emptySinceMs))
    ? Number(previousState.emptySinceMs)
    : nowMs;
  const emptyForMs = Math.max(0, nowMs - emptySinceMs);
  return {
    state: { sawDesktopClient: true, emptySinceMs },
    shouldRestart: emptyForMs >= restartMs,
    emptyForMs,
  };
}

function publicError(error, fallbackCode = "UNEXPECTED_ERROR") {
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: error?.details ?? null,
  };
}

export function atomicWriteJson(filePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fsImpl.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameReplaceSync(temporaryPath, filePath, { renameSync: fsImpl.renameSync.bind(fsImpl) });
  } finally {
    fsImpl.rmSync(temporaryPath, { force: true });
  }
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
  if (process.platform !== "win32" || !processAlive(pid)) return null;
  const child = windowsPowerShellEnvironment();
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); (Get-CimInstance Win32_Process -Filter \"ProcessId = ${Number(pid)}\" -ErrorAction Stop).CommandLine`;
  const result = spawnSync(child.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: child.environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
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
  const token = options.instanceToken ?? crypto.randomUUID();
  if (typeof token !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) throw new Error("Invalid instance token");
  const metadata = { pid, startedAt, token };
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  const validateOwner = (existing) => {
    let existingOwnerValid = processAlive(Number(existing?.pid));
    if (existingOwnerValid && typeof options.validateExistingProcess === "function") {
      try {
        const identity = options.validateExistingProcess(existing);
        if (identity === null || identity === "unknown") return "unknown";
        existingOwnerValid = identity !== false;
      } catch {
        return "unknown";
      }
    }
    if (existingOwnerValid && typeof options.validateExistingLock === "function") {
      try {
        existingOwnerValid = options.validateExistingLock(existing) !== false;
      } catch {
        return "unknown";
      }
    }
    return existingOwnerValid ? "owned" : "absent";
  };
  if (!createLockFile(lockPath, metadata, fsImpl)) {
    const existing = readJsonObject(lockPath, fsImpl);
    const identity = validateOwner(existing);
    if (identity !== "absent") return { acquired: false, existing, identityUnknown: identity === "unknown" };
    const recovery = acquireRecoveryGuard(lockPath, { fsImpl, pid });
    if (!recovery) return { acquired: false, existing: { ...existing, recoveryInProgress: true } };
    try {
      const current = readJsonObject(lockPath, fsImpl);
      const currentIdentity = validateOwner(current);
      if (currentIdentity !== "absent") return { acquired: false, existing: current, identityUnknown: currentIdentity === "unknown" };
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
    .flatMap((candidate) => {
      try {
        const stat = fsImpl.statSync(candidate);
        if (!stat.isFile()) return [];
        const directory = fsImpl.statSync(path.dirname(candidate));
        return [{ candidate, installedAt: Math.max(stat.birthtimeMs, directory.birthtimeMs), modifiedAt: stat.mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.installedAt - left.installedAt || right.modifiedAt - left.modifiedAt || right.candidate.localeCompare(left.candidate))
    .map((entry) => entry.candidate);
}

function executableRevision(executablePath, fsImpl = fs) {
  if (!executablePath) return null;
  try {
    const stat = fsImpl.statSync(executablePath);
    return { executablePath: path.resolve(executablePath), modifiedAt: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

export async function findExecutableRefresh(currentRevision, options = {}) {
  options.checkActive?.();
  const fsImpl = options.fsImpl ?? fs;
  const candidate = codexCandidates({
    fsImpl,
    executablePath: options.executablePath,
    localAppData: options.localAppData,
  })[0];
  if (!options.executablePath) {
    if (!candidate || Number(options.proxyStatus?.()?.clientCount ?? 0) !== 0) return null;
    const refreshState = options.bundleRefreshState ?? {};
    const nowMs = options.nowMs?.() ?? Date.now();
    if (nowMs < (refreshState.nextAttemptAt ?? 0)) return null;
    const source = await inspectCodexSource(candidate, options);
    const sameMetadata = currentRevision?.sourcePath === source.sourcePath
      && currentRevision?.sourceMetadata === source.sourceMetadata;
    if (sameMetadata && nowMs < (refreshState.nextDeepCheckAt ?? 0)) return null;
    if (sameMetadata && await digestCodexSource(source, options) === currentRevision.digest) {
      refreshState.nextDeepCheckAt = nowMs + (options.bundleDeepCheckIntervalMs ?? DEFAULT_BUNDLE_DEEP_CHECK_INTERVAL_MS);
      return null;
    }
    const revision = await prepareCodexRuntimeBundle(candidate, {
      bundleRoot: options.bundleRoot ?? path.join(path.dirname(options.runtimeStatePath), "codex-runtime-bundles"),
      validateBundleSignature: options.validateBundleSignature,
      signal: options.signal,
      shouldStop: options.shouldStop,
    });
    options.checkActive?.();
    refreshState.nextDeepCheckAt = nowMs + (options.bundleDeepCheckIntervalMs ?? DEFAULT_BUNDLE_DEEP_CHECK_INTERVAL_MS);
    if (revision.digest === currentRevision?.digest && revision.executablePath === currentRevision.executablePath) {
      Object.assign(currentRevision, revision);
      return null;
    }
    await runExecutableProbe(revision.executablePath, options.probePort, {
      ...options,
      timeoutMs: options.startTimeoutMs,
    });
    options.checkActive?.();
    if (Number(options.proxyStatus?.()?.clientCount ?? 0) !== 0) return null;
    return revision;
  }
  const nextRevision = executableRevision(candidate, fsImpl);
  if (!nextRevision) return null;
  const changed = !currentRevision
    || nextRevision.executablePath !== currentRevision.executablePath
    || nextRevision.modifiedAt !== currentRevision.modifiedAt
    || nextRevision.size !== currentRevision.size;
  if (!changed || Number(options.proxyStatus?.()?.clientCount ?? 0) !== 0) return null;
  options.checkActive?.();
  await runExecutableProbe(nextRevision.executablePath, options.probePort, {
    ...options,
    timeoutMs: options.startTimeoutMs,
  });
  options.checkActive?.();
  if (Number(options.proxyStatus?.()?.clientCount ?? 0) !== 0) return null;
  return nextRevision;
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function operationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createOperationGuard(timeoutMs, shouldStop) {
  const controller = new AbortController();
  const inspectStop = () => {
    if (shouldStop()) controller.abort(operationError("APP_SERVER_START_CANCELLED", "Codex App Server 启动已停止"));
  };
  const stopTimer = setInterval(inspectStop, 25);
  const deadlineTimer = setTimeout(() => controller.abort(operationError("APP_SERVER_PREPARE_TIMEOUT", "Codex App Server 准备超过总截止时间")), timeoutMs);
  const check = () => {
    inspectStop();
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    check,
    close: () => { clearInterval(stopTimer); clearTimeout(deadlineTimer); },
  };
}

async function waitWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function runExecutableProbe(executablePath, port, options = {}) {
  const probe = options.probeExecutable ?? probeExecutable;
  const operation = probe(executablePath, port, options);
  return options.probeExecutable ? waitWithAbort(operation, options.signal) : operation;
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

export async function selectRecoveryUpstreamPort(basePort, excludedPorts, options = {}) {
  const available = options.verifyPortReleased ?? loopbackPortAvailable;
  for (let candidatePort = basePort + 2; candidatePort <= Math.min(65535, basePort + 32); candidatePort += 1) {
    if (options.shouldStop?.()) throw operationError("APP_SERVER_START_CANCELLED", "备用端口选择已停止");
    if (!excludedPorts.has(candidatePort) && await available(candidatePort)) return candidatePort;
  }
  throw new CodexAppServerProxyError(
    "APP_SERVER_RECOVERY_PORTS_EXHAUSTED",
    "受管 Codex App Server 的有限备用端口均不可用，未终止任何其它进程",
  );
}

async function verifyManagedListenerOwner(child, port, options = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  if (process.platform !== "win32") return true;
  const ownerPid = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${Number(port)} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique`,
    ], { windowsHide: true, timeout: 5000, maxBuffer: 4096, signal: options.signal }, (error, stdout) => {
      resolve(error ? null : Number(stdout.trim()));
    });
  });
  return ownerPid === Number(child.pid) && child.exitCode === null && child.signalCode === null;
}

export async function terminateManagedAppServer(child, port, options = {}) {
  if (!child) return true;
  await (options.terminateChild ?? terminateChild)(child);
  const verifyPortReleased = options.verifyPortReleased ?? loopbackPortAvailable;
  const deadline = Date.now() + (options.portReleaseTimeoutMs ?? 20000);
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
    if (options.signal?.aborted) return reject(options.signal.reason);
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
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
    };
    const onAbort = () => {
      cleanup();
      socket.close();
      reject(options.signal.reason);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
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
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      return await probeWebSocket(url, {
        ...options,
        timeoutMs: Math.min(1500, Math.max(250, deadline - Date.now())),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      lastError = error;
      await wait(150);
    }
  }
  throw lastError ?? new CodexAppServerProxyError("APP_SERVER_PROBE_TIMEOUT", `App Server 探针超时：${url}`);
}

export async function probeExecutable(executablePath, port, options = {}) {
  if (options.signal?.aborted) throw options.signal.reason;
  const launched = (options.spawnAppServer ?? spawnAppServer)(executablePath, port, options);
  let retained = false;
  try {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let lastError = null;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw options.signal.reason;
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
        if (options.signal?.aborted) throw options.signal.reason;
        if (options.keepAliveAfterProbe) {
          retained = true;
          return { result, launched };
        }
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        lastError = error;
        await wait(150);
      }
    }
    throw lastError ?? new CodexAppServerProxyError("APP_SERVER_PROBE_TIMEOUT", "App Server 探针超时");
  } finally {
    if (!retained) await terminateManagedAppServer(launched.child, port, options);
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
  if (values["codex-exe"] !== undefined && values["codex-exe"].trim().length === 0) {
    throw new Error("CODEX_EXECUTABLE_EXPLICIT_EMPTY");
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
  if (Boolean(values["inner-managed-profile"]) !== Boolean(values["inner-managed-profile-sha256"])
    || (values["inner-managed-profile-sha256"] && !/^[0-9a-f]{64}$/u.test(values["inner-managed-profile-sha256"]))) {
    throw new Error("INNER_PROFILE_PATH_SHA256_PAIR_REQUIRED");
  }
  return {
    ...(values["inner-managed-profile"] ? { innerManagedProfilePath: requiredPath(values["inner-managed-profile"], "inner-managed-profile"),
      innerManagedProfileSha256: values["inner-managed-profile-sha256"] } : {}),
    instanceToken: values["instance-token"] ?? null,
    launchReceiptPath: values["launch-receipt"] ? requiredPath(values["launch-receipt"], "launch-receipt") : null,
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
    startupBudgetMs: boundedInteger(values["startup-budget-ms"], "startup-budget-ms", DEFAULT_STARTUP_BUDGET_MS, 1000, 300000),
    requestTimeoutMs: boundedInteger(values["request-timeout-ms"], "request-timeout-ms", DEFAULT_REQUEST_TIMEOUT_MS, 250, 300000),
    resumeRequestTimeoutMs: boundedInteger(
      values["resume-timeout-ms"],
      "resume-timeout-ms",
      DEFAULT_RESUME_REQUEST_TIMEOUT_MS,
      250,
      300000,
    ),
    emptyClientRestartMs: boundedInteger(
      values["empty-client-restart-ms"],
      "empty-client-restart-ms",
      DEFAULT_EMPTY_CLIENT_RESTART_MS,
      0,
      300000,
    ),
    executablePath: values["codex-exe"] ? path.resolve(values["codex-exe"]) : null,
    displayPolicyRoot: values["display-policy-root"] ? requiredPath(values["display-policy-root"], "display-policy-root") : null,
    outerRuntimeRoot: values["outer-runtime-root"] ? requiredPath(values["outer-runtime-root"], "outer-runtime-root") : null,
    requestMetadata: { enabled: strictBoolean(values["request-metadata-enabled"], "request-metadata-enabled") },
  };
}

export async function waitForLaunchPublication(options = {}) {
  if (!options.launchReceiptPath) return true;
  const fsImpl = options.fsImpl ?? fs;
  const expectedPid = Number(options.pid ?? process.pid);
  const deadline = Date.now() + (options.launchPublicationTimeoutMs ?? 10000);
  do {
    try {
      const receiptBytes = fsImpl.readFileSync(options.launchReceiptPath);
      const ready = JSON.parse(fsImpl.readFileSync(`${options.launchReceiptPath}.ready`, "utf8"));
      const receipt = JSON.parse(receiptBytes.toString("utf8"));
      if (ready.instanceToken === options.instanceToken
        && ready.receiptSha256 === crypto.createHash("sha256").update(receiptBytes).digest("hex")
        && receipt.instanceToken === options.instanceToken
        && Number(receipt.pid) === expectedPid
        && path.resolve(receipt.runtimeStatePath) === path.resolve(options.runtimeStatePath)) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

export const proxyServiceDependencies = Object.freeze({
  atomicWriteJson, appendJsonLine, updateMaintenance, publicError, wait, observeEmptyDesktopRestart,
  createOperationGuard, findExecutableRefresh, createWakeJournal, createCodexAppServerProxy, codexCandidates,
  executableRevision, verifyCodexRuntimeBundle, prepareCodexRuntimeBundle, runExecutableProbe, spawnAppServer,
  waitWithAbort, waitForWebSocketReady, verifyManagedListenerOwner, resolveProxyFailureArtifacts, waitForExit,
  terminateManagedAppServer, processAlive, selectRecoveryUpstreamPort,
  defaults: Object.freeze({ emptyClientRestartMs: DEFAULT_EMPTY_CLIENT_RESTART_MS,
    executableRefreshIntervalMs: DEFAULT_EXECUTABLE_REFRESH_INTERVAL_MS, livenessIntervalMs: DEFAULT_LIVENESS_INTERVAL_MS,
    refreshBudgetMs: DEFAULT_REFRESH_BUDGET_MS, startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
    bundleDeepCheckIntervalMs: DEFAULT_BUNDLE_DEEP_CHECK_INTERVAL_MS, restartBackoffMs: DEFAULT_RESTART_BACKOFF_MS }),
});

export async function runCodexAppServerProxyService(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());
  const pid = Number(options.pid ?? process.pid);
  const startedAt = now().toISOString();
  const startupBudgetMs = options.startupBudgetMs ?? DEFAULT_STARTUP_BUDGET_MS;
  const startupDeadlineAt = Date.now() + startupBudgetMs;
  if (fsImpl.existsSync(options.stopFilePath)) {
    return { state: "failed", pid, error: { code: "STOP_REQUIREMENT_STILL_PRESENT", message: "The existing stop requirement must be resolved by its owner before starting." } };
  }
  if (!await waitForLaunchPublication({ ...options, fsImpl, pid })) {
    return { state: "failed", pid, error: { code: "START_LAUNCH_NOT_PUBLISHED", message: "The bound startup receipt was not completely published; runtime resources were not acquired." } };
  }
  const lock = acquireInstanceLock(options.lockPath, {
    fsImpl,
    pid,
    startedAt,
    instanceToken: options.instanceToken ?? undefined,
    validateExistingProcess: (metadata) => {
      const commandLine = (options.processCommandLine ?? processCommandLine)(Number(metadata?.pid));
      if (typeof commandLine !== "string" || !commandLine.trim()) return "unknown";
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
  if (!lock.acquired) {
    if (lock.identityUnknown) return { state: "failed", pid, existingLock: lock.existing, error: { code: "EXISTING_PROCESS_IDENTITY_UNKNOWN", message: "The existing process identity could not be queried; its runtime and lock were preserved." } };
    return { state: "duplicate", pid, existingLock: lock.existing };
  }
  if (fsImpl.existsSync(options.stopFilePath)) {
    lock.release();
    return { state: "failed", pid, error: { code: "STOP_REQUIREMENT_STILL_PRESENT", message: "A stop requirement appeared while acquiring the instance lock." } };
  }
  const controlToken = ensureControlToken(options.tokenFilePath, fsImpl);
  const previous = readJsonObject(options.runtimeStatePath, fsImpl);
  let currentExecutable = null;
  let currentExecutableRevision = null;
  let upstreamPort = options.upstreamPort;
  const excludedUpstreamPorts = new Set([options.downstreamPort, options.controlPort, options.probePort]);
  let preparedLaunch = null;
  const bundleRefreshState = { nextDeepCheckAt: 0 };
  let appServer = null;
  const createdChildPids = new Set();
  let proxy = null;
  let stopRequested = false;
  let stopReason = null;
  let signalCleanup = () => {};
  let startupGuard = null;
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
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
    appServerPid: null,
    emptyClientRestartMs: options.emptyClientRestartMs ?? DEFAULT_EMPTY_CLIENT_RESTART_MS,
    startupBudgetMs,
    startTimeoutMs: options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    proxy: null,
    restartFailureCount: 0,
    lastError: null,
    stopReason: null,
    livenessAt: startedAt,
  };
  const ownsLock = () => lock.isOwner();
  const diagnosticStorageFailures = new Set();
  const serviceRuntimeState = { options, fsImpl, now, pid, lock, diagnosticStorageFailures, bundleRefreshState,
    controlToken, createdChildPids, excludedUpstreamPorts, startupDeadlineAt, diagnosticStorageWarningAt: 0, dependencies: {} };
  Object.defineProperties(serviceRuntimeState, {
    currentExecutableRevision: { get: () => currentExecutableRevision, set: value => { currentExecutableRevision = value; } },
    currentExecutable: { get: () => currentExecutable, set: value => { currentExecutable = value; } },
    upstreamPort: { get: () => upstreamPort, set: value => { upstreamPort = value; } },
    preparedLaunch: { get: () => preparedLaunch, set: value => { preparedLaunch = value; } },
    appServer: { get: () => appServer, set: value => { appServer = value; } },
    proxy: { get: () => proxy, set: value => { proxy = value; } },
    stopRequested: { get: () => stopRequested, set: value => { stopRequested = value; } },
    stopReason: { get: () => stopReason, set: value => { stopReason = value; } },
    signalCleanup: { get: () => signalCleanup, set: value => { signalCleanup = value; } },
    startupGuard: { get: () => startupGuard, set: value => { startupGuard = value; } },
    restartFailureCount: { get: () => restartFailureCount, set: value => { restartFailureCount = value; } },
    shutdownError: { get: () => shutdownError, set: value => { shutdownError = value; } },
    status: { get: () => status, set: value => { status = value; } },
  });
  const serviceRuntime = createProxyServiceCodeRuntime(serviceRuntimeState);
  const { persist, log, requestStop, installSignals, markFatal, pauseForUpstream, resumeAfterUpstream } = serviceRuntime;

  try {
    options.onServiceCodeParticipant?.(serviceRuntime.liveCodeParticipant());
    await serviceRuntime.initializeService();
    while (!stopRequested && !fsImpl.existsSync(options.stopFilePath)) {
      const decision = await serviceRuntime.runBackendCycle();
      if (decision?.stop || stopRequested || fsImpl.existsSync(options.stopFilePath)) break;
      if (!decision?.skipBackoff && await serviceRuntime.restartBackoff()) break;
    }
    stopReason = stopReason ?? (fsImpl.existsSync(options.stopFilePath) ? "stop_file" : "requested");
    persist({ state: "stopping", automationEnabled: false, stopReason }, { allowStorageDegradation: true });
  } catch (error) {
    if (error?.code === "APP_SERVER_START_CANCELLED" || stopRequested || fsImpl.existsSync(options.stopFilePath)) {
      stopReason = stopReason ?? (fsImpl.existsSync(options.stopFilePath) ? "stop_file" : "requested");
      persist({ state: "stopping", automationEnabled: false, stopReason }, { allowStorageDegradation: true });
    } else {
      markFatal(error);
      return { state: "failed", pid, error: publicError(error) };
    }
  } finally {
    await serviceRuntime.finishService();
  }
  return shutdownError
    ? { state: "failed", pid, stopReason, error: publicError(shutdownError) }
    : { state: "stopped", pid, stopReason };
}
export async function runManagedInnerProfile(options, argv, serviceDependencies = {}) {
  const names = argv.filter((_value, index) => index % 2 === 0);
  if (names.filter(name => name === "--inner-managed-profile").length !== 1
    || names.filter(name => name === "--inner-managed-profile-sha256").length !== 1
    || new Set(names).size !== names.length) throw new Error("INNER_PROFILE_DUPLICATE_ARGUMENTS");
  if (!/^[0-9a-f]{64}$/u.test(options.innerManagedProfileSha256 ?? "")) throw new Error("INNER_PROFILE_PATH_SHA256_PAIR_REQUIRED");
  const { readInnerRuntimeProfile } = await import("./inner-runtime-profile.mjs");
  const profile = readInnerRuntimeProfile(options.innerManagedProfilePath, { options, runnerPath: fileURLToPath(import.meta.url) });
  if (!await waitForLaunchPublication(options)) throw new Error("START_LAUNCH_NOT_PUBLISHED");
  const outerArguments = argv.filter((value, index) => !["--inner-managed-profile", "--inner-managed-profile-sha256"].includes(value)
    && !["--inner-managed-profile", "--inner-managed-profile-sha256"].includes(argv[index - 1]));
  const { createManagedInnerProxySession } = await import("./inner-managed-session.mjs");
  const managedEvents = serviceDependencies.onManagedEvent ?? createManagedEventObserver({
    filePath: path.join(profile.stateRoot, "inner-coordinator-events.jsonl"),
  });
  const session = createManagedInnerProxySession({ ...profile, outerArguments }, managedEvents, serviceDependencies);
  await session.start();
  return session.waitForClose();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = options.innerManagedProfilePath
    ? await runManagedInnerProfile(options, process.argv.slice(2))
    : await runCodexAppServerProxyService(options);
  if (result.state === "stopped") process.exit(0);
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
