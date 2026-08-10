import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createNapCatNotifier } from "./core.mjs";
import { createCodexThreadBridge } from "./codex-thread-bridge.mjs";
import { createTaskRegistry } from "./task-registry.mjs";
import { createTaskRouter } from "./task-router.mjs";
import { createControlState } from "./control-state.mjs";
import { createControlPlane } from "./control-plane.mjs";

export const DEFAULT_SCAN_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_BACKOFF_MS = 300_000;
export const DEFAULT_STOP_POLL_MS = 250;

const CLI_OPTIONS = new Set([
  "registry",
  "binding",
  "state",
  "runtime-state",
  "log",
  "stop-file",
  "lock",
  "maintenance-file",
  "alert-file",
  "interval-ms",
  "private-env",
]);

function normalizePositiveInteger(value, name, fallback = undefined) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} 必须是大于 0 的整数`);
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, name, fallback = undefined) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return parsed;
}

function resolveRequiredPath(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${name} 不能为空`);
  }
  return path.resolve(String(value));
}

function resolveOptionalPath(value) {
  return value === undefined || value === null || String(value).trim() === ""
    ? null
    : path.resolve(String(value));
}

function readJsonFile(filePath, description) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`无法读取 ${description}：${filePath}`, { cause: error });
  }
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`无效参数：${item}`);
    const name = item.slice(2);
    if (!CLI_OPTIONS.has(name)) throw new Error(`不支持参数：${item}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数缺少值：${item}`);
    }
    values[name] = argv[index + 1];
    index += 1;
  }

  const required = [
    ["registry", "--registry"],
    ["binding", "--binding"],
    ["state", "--state"],
    ["runtime-state", "--runtime-state"],
    ["log", "--log"],
    ["stop-file", "--stop-file"],
    ["lock", "--lock"],
  ];
  for (const [name, flag] of required) {
    if (values[name] === undefined) throw new Error(`缺少参数 ${flag}`);
  }

  return {
    registryPath: resolveRequiredPath(values.registry, "--registry"),
    bindingPath: resolveRequiredPath(values.binding, "--binding"),
    statePath: resolveRequiredPath(values.state, "--state"),
    runtimeStatePath: resolveRequiredPath(values["runtime-state"], "--runtime-state"),
    logPath: resolveRequiredPath(values.log, "--log"),
    stopFilePath: resolveRequiredPath(values["stop-file"], "--stop-file"),
    lockPath: resolveRequiredPath(values.lock, "--lock"),
    maintenanceFilePath: resolveOptionalPath(values["maintenance-file"]),
    alertFilePath: resolveOptionalPath(values["alert-file"]),
    scanIntervalMs: normalizePositiveInteger(
      values["interval-ms"],
      "--interval-ms",
      DEFAULT_SCAN_INTERVAL_MS,
    ),
    privateEnvPath: resolveOptionalPath(values["private-env"]),
  };
}

export function readPrivateEnvironment(filePath) {
  const raw = readJsonFile(filePath, "private-env");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`private-env 必须是 JSON 对象：${filePath}`);
  }
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([name]) => name.startsWith("NAPCAT_") || name.startsWith("CODEX_APP_SERVER_PROXY_"))
      .map(([name, value]) => [name, String(value ?? "")]),
  );
}

function readExistingJson(filePath, fsImpl) {
  if (!fsImpl.existsSync(filePath)) return {};
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function resolveAutomaticProxyBridgeOptions(registryPath, bridgeOptions = {}, fsImpl = fs) {
  const hasExplicitString = (value) => typeof value === "string" && value.trim().length > 0;
  const explicitProxyConfiguration = bridgeOptions.mode === "transparent_proxy"
    || hasExplicitString(bridgeOptions.controlUrl)
    || hasExplicitString(bridgeOptions.controlToken)
    || hasExplicitString(bridgeOptions.tokenFilePath);
  if (explicitProxyConfiguration) return { ...bridgeOptions };

  const stateRoot = path.dirname(registryPath);
  const runtimePath = path.join(stateRoot, "codex-app-server-proxy-runtime.json");
  const tokenFilePath = path.join(stateRoot, "codex-app-server-proxy-token.txt");
  const proxyArtifactsPresent = fsImpl.existsSync(runtimePath) || fsImpl.existsSync(tokenFilePath);
  if (!proxyArtifactsPresent) return { ...bridgeOptions };

  const runtime = readExistingJson(runtimePath, fsImpl);
  const controlUrl = typeof runtime.controlUrl === "string" && runtime.controlUrl.trim()
    ? runtime.controlUrl.trim()
    : "http://127.0.0.1:18431";
  return {
    ...bridgeOptions,
    mode: "transparent_proxy",
    controlUrl,
    tokenFilePath,
  };
}

function atomicWriteJson(filePath, value, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporaryPath, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (typeof fsImpl.fsyncSync === "function") fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    try {
      fsImpl.unlinkSync(temporaryPath);
    } catch {
    }
    throw error;
  }
}

function pauseAutomation(options, failure, fsImpl, now) {
  if (!options.maintenanceFilePath) return null;
  const at = nowIso(now);
  const maintenance = readExistingJson(options.maintenanceFilePath, fsImpl);
  const reasons = maintenance.reasons && typeof maintenance.reasons === "object"
    ? { ...maintenance.reasons }
    : {};
  reasons.automationBridge = {
    at,
    taskId: failure.taskId ?? null,
    outcome: failure.outcome ?? null,
    code: failure.error?.code ?? failure.threadStatus ?? "AUTOMATION_BRIDGE_FAILED",
    message: failure.error?.message ?? `Codex 自动唤醒失败：${failure.outcome ?? "unknown"}`,
    outcomeUnknown: Boolean(failure.error?.outcomeUnknown),
    wakeId: failure.wakeId ?? null,
    pendingThroughSequence: failure.pendingThroughSequence ?? null,
  };
  const nextMaintenance = { schemaVersion: 1, reasons };
  atomicWriteJson(options.maintenanceFilePath, nextMaintenance, fsImpl);
  if (options.alertFilePath) {
    const currentAlert = readExistingJson(options.alertFilePath, fsImpl);
    if (!currentAlert.pending) {
      atomicWriteJson(options.alertFilePath, {
        schemaVersion: 1,
        pending: true,
        createdAt: at,
        source: "task-router",
        ...reasons.automationBridge,
      }, fsImpl);
    }
  }
  return reasons.automationBridge;
}

const DELIVERED_WAKE_STATUSES = new Set(["accepted", "completed", "recovered"]);
const FATAL_AUTOMATION_CODES = new Set([
  "UNAUTHORIZED",
  "PROXY_TOKEN_MISSING",
  "PROXY_TOKEN_READ_FAILED",
  "WAKE_ID_CONFLICT",
  "WAKE_STATE_CONFLICT",
  "WAKE_JOURNAL_REQUIRED",
  "WAKE_JOURNAL_INVALID",
  "WAKE_JOURNAL_COMMIT_FAILED",
]);

function shouldPauseAutomation(result) {
  if (!result) return false;
  if (result.outcome === "wake_unknown" && result.error?.outcomeUnknown) return true;
  return result.outcome === "wake_failed" && FATAL_AUTOMATION_CODES.has(result.error?.code);
}

function clearAutomationMaintenance(options, maintenance, fsImpl, now) {
  const reasons = { ...(maintenance.reasons ?? {}) };
  delete reasons.automationBridge;
  if (Object.keys(reasons).length > 0) {
    atomicWriteJson(options.maintenanceFilePath, { schemaVersion: 1, reasons }, fsImpl);
  } else if (fsImpl.existsSync(options.maintenanceFilePath)) {
    fsImpl.unlinkSync(options.maintenanceFilePath);
  }
  if (options.alertFilePath && fsImpl.existsSync(options.alertFilePath)) {
    const alert = readExistingJson(options.alertFilePath, fsImpl);
    if (alert.source === "task-router") {
      atomicWriteJson(options.alertFilePath, {
        ...alert,
        pending: false,
        resolvedAt: nowIso(now),
        resolution: "journal_reconciled",
      }, fsImpl);
    }
  }
}

export function reconcileAutomationMaintenance(options, components, maintenance, fsImpl = fs, now = () => new Date()) {
  const reason = maintenance?.reasons?.automationBridge;
  if (!reason?.wakeId || !reason?.taskId || !options.maintenanceFilePath) return { resolved: false };
  const journalPath = options.wakeJournalPath
    ?? path.join(path.dirname(options.registryPath), "codex-app-server-wake-journal.json");
  const journal = readExistingJson(journalPath, fsImpl);
  const wake = journal.wakes?.[reason.wakeId] ?? null;
  const task = components.registry?.get?.(reason.taskId) ?? null;
  const activeWake = task?.activeWakes?.find((candidate) => candidate.wakeId === reason.wakeId) ?? null;
  if (!task || task.status === "closed" || !activeWake) {
    clearAutomationMaintenance(options, maintenance, fsImpl, now);
    return { resolved: true, outcome: "task_resolved", wake };
  }
  if (wake?.status === "failed_before_send") {
    components.registry.reconcileFailedWake({
      taskId: reason.taskId,
      expectedGeneration: task.generation,
      wakeId: reason.wakeId,
    });
    clearAutomationMaintenance(options, maintenance, fsImpl, now);
    return { resolved: true, outcome: "failed_before_send", wake };
  }
  if (DELIVERED_WAKE_STATUSES.has(wake?.status)) {
    clearAutomationMaintenance(options, maintenance, fsImpl, now);
    return { resolved: true, outcome: wake.status, wake };
  }
  return { resolved: false, wake };
}

export function writeRuntimeState(runtimeStatePath, patch = {}, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const current = readExistingJson(runtimeStatePath, fsImpl);
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const next = {
    schemaVersion: 1,
    ...current,
    ...definedPatch,
  };
  const defaults = {
    pid: options.pid ?? current.pid ?? process.pid,
    startedAt: current.startedAt ?? null,
    lastScanAt: current.lastScanAt ?? null,
    nextScanAt: current.nextScanAt ?? null,
    openTaskCount: current.openTaskCount ?? 0,
    lastError: current.lastError ?? null,
    state: current.state ?? "starting",
  };
  for (const [name, value] of Object.entries(defaults)) {
    if (next[name] === undefined) next[name] = value;
  }
  atomicWriteJson(runtimeStatePath, next, fsImpl);
  return next;
}

export function publicError(error, fallbackCode = "TASK_ROUTER_ERROR") {
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
  };
}

export function isProcessAlive(processId, processImpl = process) {
  const pid = Number(processId);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    processImpl.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockSnapshot(lockPath, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(lockPath, "utf8");
    let metadata = null;
    try {
      metadata = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
    }
    return { raw, metadata };
  } catch {
    return { raw: null, metadata: null };
  }
}

export function acquireInstanceLock(lockPath, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const processId = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const isAlive = options.isProcessAlive ?? ((pid) => isProcessAlive(pid, options.processObject ?? process));
  const normalizedLockPath = path.resolve(lockPath);
  const startedAt = new Date(now()).toISOString();
  const token = randomUUID();
  fsImpl.mkdirSync(path.dirname(normalizedLockPath), { recursive: true });

  while (true) {
    let descriptor;
    const metadata = { pid: processId, startedAt, token };
    try {
      descriptor = fsImpl.openSync(normalizedLockPath, "wx", 0o600);
      fsImpl.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
      if (typeof fsImpl.fsyncSync === "function") fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      return {
        acquired: true,
        lockPath: normalizedLockPath,
        metadata,
        release() {
          const current = readLockSnapshot(normalizedLockPath, fsImpl).metadata;
          if (current?.token !== token) return;
          try {
            fsImpl.unlinkSync(normalizedLockPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (descriptor !== undefined) fsImpl.closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;

      const snapshot = readLockSnapshot(normalizedLockPath, fsImpl);
      const existingPid = snapshot.metadata?.pid;
      let existingOwnerValid = existingPid !== undefined && isAlive(existingPid);
      if (existingOwnerValid && typeof options.validateExistingLock === "function") {
        try {
          existingOwnerValid = options.validateExistingLock(snapshot.metadata) !== false;
        } catch {
          existingOwnerValid = false;
        }
      }
      if (existingOwnerValid) {
        return {
          acquired: false,
          lockPath: normalizedLockPath,
          existingLock: snapshot.metadata,
        };
      }

      const currentSnapshot = readLockSnapshot(normalizedLockPath, fsImpl);
      if (currentSnapshot.raw !== snapshot.raw) continue;
      try {
        fsImpl.unlinkSync(normalizedLockPath);
      } catch (unlinkError) {
        if (unlinkError?.code === "ENOENT") continue;
        throw unlinkError;
      }
    }
  }
}

export function calculateBackoffMs(scanIntervalMs, failureCount, maxBackoffMs = DEFAULT_MAX_BACKOFF_MS) {
  const interval = normalizePositiveInteger(scanIntervalMs, "scanIntervalMs");
  const failures = normalizePositiveInteger(failureCount, "failureCount");
  const maximum = Math.max(interval, normalizePositiveInteger(maxBackoffMs, "maxBackoffMs"));
  return Math.min(maximum, interval * (2 ** Math.min(failures - 1, 30)));
}

function fileExists(filePath, fsImpl) {
  try {
    return Boolean(filePath && fsImpl.existsSync(filePath));
  } catch {
    return false;
  }
}

function nowDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("now 返回了无效时间");
  return date;
}

function nowIso(now) {
  return nowDate(now).toISOString();
}

function nextTimeIso(now, delayMs) {
  return new Date(nowDate(now).getTime() + delayMs).toISOString();
}

function appendLog(logPath, entry, fsImpl) {
  if (!logPath) return;
  try {
    fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
    fsImpl.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
  }
}

export function waitForNextScan(milliseconds, options = {}) {
  const delayMs = Math.max(0, Number(milliseconds));
  const fsImpl = options.fsImpl ?? fs;
  const stopFilePath = options.stopFilePath;
  const pollMs = Math.max(1, Number(options.pollMs ?? DEFAULT_STOP_POLL_MS));
  const isStopRequested = options.isStopRequested ?? (() => fileExists(stopFilePath, fsImpl));
  return new Promise((resolve) => {
    const deadline = Date.now() + delayMs;
    let timer;
    const check = () => {
      if (isStopRequested() || Date.now() >= deadline) {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
        return;
      }
      timer = setTimeout(check, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    };
    check();
  });
}

function installSignalHandlers(processObject, requestStop) {
  if (!processObject || typeof processObject.on !== "function") return () => {};
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => requestStop(`signal:${signal}`);
    processObject.on(signal, handler);
    handlers.set(signal, handler);
  }
  return () => {
    if (typeof processObject.removeListener !== "function") return;
    for (const [signal, handler] of handlers) processObject.removeListener(signal, handler);
  };
}

export function createTaskRouterDependencies(options = {}) {
  const registryPath = resolveRequiredPath(options.registryPath ?? options.registry, "registryPath");
  const bindingPath = resolveRequiredPath(options.bindingPath ?? options.binding, "bindingPath");
  const statePath = resolveRequiredPath(options.statePath ?? options.state, "statePath");
  const privateEnvironment = options.privateEnvironment
    ?? (options.privateEnvPath ? readPrivateEnvironment(options.privateEnvPath) : {});
  const env = {
    ...process.env,
    ...(options.env ?? {}),
    ...privateEnvironment,
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: statePath,
  };
  const cwd = options.cwd ?? path.dirname(bindingPath);
  const registryFactory = options.createRegistry ?? createTaskRegistry;
  const notifierFactory = options.createNotifier ?? createNapCatNotifier;
  const bridgeFactory = options.createBridge ?? createCodexThreadBridge;
  const routerFactory = options.createRouter ?? createTaskRouter;
  const controlStateFactory = options.createControlState ?? createControlState;
  const controlPlaneFactory = options.createControlPlane ?? createControlPlane;
  const bridgeOptions = resolveAutomaticProxyBridgeOptions(
    registryPath,
    options.bridgeOptions,
    options.fsImpl ?? fs,
  );
  const registry = options.registry ?? registryFactory({
    statePath: registryPath,
    ...(options.registryOptions ?? {}),
  });
  const notifier = options.notifier ?? notifierFactory({ cwd, env });
  const bridge = options.bridge ?? bridgeFactory({
    ...bridgeOptions,
    cwd,
    env,
  });
  const controlState = options.controlState ?? controlStateFactory({
    statePath: options.controlStatePath
      ?? env.NAPCAT_CONTROL_STATE_PATH
      ?? path.join(path.dirname(registryPath), "control-state.json"),
    ...(options.controlStateOptions ?? {}),
  });
  const controlPlane = options.controlPlane ?? controlPlaneFactory({
    ...(options.controlPlaneOptions ?? {}),
    machineReceiptAlertMs: normalizeNonNegativeInteger(
      options.controlPlaneOptions?.machineReceiptAlertMs ?? env.NAPCAT_DELIVERY_MACHINE_ALERT_MS,
      "NAPCAT_DELIVERY_MACHINE_ALERT_MS",
      2 * 60 * 1000,
    ),
    conversationReceiptAlertMs: normalizeNonNegativeInteger(
      options.controlPlaneOptions?.conversationReceiptAlertMs ?? env.NAPCAT_DELIVERY_CONVERSATION_ALERT_MS,
      "NAPCAT_DELIVERY_CONVERSATION_ALERT_MS",
      5 * 60 * 1000,
    ),
    notifier,
    bridge,
    state: controlState,
  });
  const router = options.router ?? routerFactory({
    ...(options.routerOptions ?? {}),
    historyMaxPages: normalizePositiveInteger(
      options.routerOptions?.historyMaxPages ?? env.NAPCAT_ROUTER_HISTORY_MAX_PAGES,
      "NAPCAT_ROUTER_HISTORY_MAX_PAGES",
      40,
    ),
    controlHistoryLookbackMs: normalizeNonNegativeInteger(
      options.routerOptions?.controlHistoryLookbackMs ?? env.NAPCAT_CONTROL_HISTORY_LOOKBACK_MS,
      "NAPCAT_CONTROL_HISTORY_LOOKBACK_MS",
      15 * 60 * 1000,
    ),
    registry,
    notifier,
    bridge,
    controlPlane,
    isMaintenanceActive: () => {
      if (!options.maintenanceFilePath) return false;
      const maintenance = readExistingJson(options.maintenanceFilePath, options.fsImpl ?? fs);
      const reasons = maintenance.reasons && typeof maintenance.reasons === "object"
        ? maintenance.reasons
        : {};
      return Object.keys(reasons).length > 0;
    },
  });
  if (!router || typeof router.scanOnce !== "function") {
    throw new Error("task router 必须提供 scanOnce() 方法");
  }
  return { router, registry, notifier, bridge, controlState, controlPlane };
}

function parseOpenTaskCount(scanResult) {
  const count = Number(scanResult?.openTaskCount);
  if (!Number.isSafeInteger(count) || count < 0) {
    const error = new Error("scanOnce 返回的 openTaskCount 无效");
    error.code = "INVALID_SCAN_RESULT";
    throw error;
  }
  return count;
}

function parseKeepAlive(scanResult) {
  return scanResult?.keepAlive === true;
}

function scanResultError(scanResult) {
  if (!Array.isArray(scanResult?.results)) return null;
  const failedResult = scanResult.results.find((result) => result?.outcome === "scan_error");
  if (!failedResult) return null;
  const error = new Error(failedResult.error?.message ?? "任务扫描失败");
  error.code = failedResult.error?.code ?? "TASK_SCAN_ERROR";
  error.outcomeUnknown = Boolean(failedResult.error?.outcomeUnknown);
  error.openTaskCount = Number(scanResult.openTaskCount);
  error.scanAt = typeof scanResult.scannedAt === "string" && scanResult.scannedAt
    ? scanResult.scannedAt
    : null;
  return error;
}

async function closeBridge(components) {
  if (!components?.bridge || typeof components.bridge.close !== "function") return;
  await components.bridge.close();
}

export async function runTaskRouterService(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const processObject = options.processObject ?? process;
  const pid = options.pid ?? processObject.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const runtimeStatePath = resolveRequiredPath(options.runtimeStatePath ?? options["runtime-state"], "runtimeStatePath");
  const stopFilePath = resolveRequiredPath(options.stopFilePath ?? options["stop-file"], "stopFilePath");
  const lockPath = resolveRequiredPath(options.lockPath ?? options.lock ?? options["lock"], "lockPath");
  const logPath = resolveOptionalPath(options.logPath ?? options.log);
  const scanIntervalMs = normalizePositiveInteger(
    options.scanIntervalMs ?? options["interval-ms"],
    "scanIntervalMs",
    DEFAULT_SCAN_INTERVAL_MS,
  );
  const maxBackoffMs = Math.max(
    scanIntervalMs,
    normalizePositiveInteger(options.maxBackoffMs, "maxBackoffMs", DEFAULT_MAX_BACKOFF_MS),
  );
  const startedAt = nowIso(now);
  const lock = acquireInstanceLock(lockPath, {
    fsImpl,
    pid,
    now: () => new Date(startedAt),
    isProcessAlive: options.isProcessAlive,
    processObject,
    validateExistingLock: (metadata) => {
      const lockStartedAt = Date.parse(metadata?.startedAt ?? "");
      const currentMs = new Date(now()).getTime();
      if (Number.isFinite(lockStartedAt) && currentMs >= lockStartedAt && currentMs - lockStartedAt < 15_000) return true;
      const runtime = readExistingJson(runtimeStatePath, fsImpl);
      const updatedAt = Date.parse(runtime.updatedAt ?? runtime.lastScanAt ?? runtime.startedAt ?? "");
      return Number(runtime.pid) === Number(metadata?.pid)
        && runtime.instanceToken === metadata?.token
        && ["starting", "running"].includes(runtime.state)
        && Number.isFinite(updatedAt)
        && currentMs - updatedAt < Math.max(300_000, scanIntervalMs * 4);
    },
  });
  if (!lock.acquired) {
    return {
      state: "duplicate",
      pid,
      lockPath,
      existingLock: lock.existingLock,
    };
  }

  let status = {
    schemaVersion: 1,
    pid,
    instanceToken: lock.metadata.token,
    startedAt,
    lastScanAt: null,
    nextScanAt: null,
    openTaskCount: 0,
    lastError: null,
    state: "starting",
    stopFilePath,
    lockPath,
    scanIntervalMs,
  };
  let components = null;
  let componentsClosed = false;
  let signalCleanup = () => {};
  let stopReason = null;
  let stopRequested = false;
  let failureCount = 0;
  let scanCount = 0;
  let lastMaintenanceFingerprint = null;

  const persist = (patch) => {
    status = { ...status, ...patch, updatedAt: nowIso(now) };
    status = writeRuntimeState(runtimeStatePath, status, { fsImpl, pid });
    return status;
  };
  const requestStop = (reason) => {
    stopRequested = true;
    if (!stopReason) stopReason = reason;
  };
  const detectStop = () => {
    if (stopRequested) return true;
    if (fileExists(stopFilePath, fsImpl)) {
      requestStop("stop_file");
      return true;
    }
    return false;
  };

  try {
    persist({ state: "running", lastError: null, nextScanAt: null, lastScanAt: null, openTaskCount: 0, inFlightScan: false, maintenance: null });
    signalCleanup = options.installSignalHandlers === false
      ? () => {}
      : installSignalHandlers(processObject, requestStop);
    appendLog(logPath, { at: startedAt, type: "runner_started", pid, scanIntervalMs }, fsImpl);

    if (!detectStop()) {
      components = options.router
        ? { router: options.router, bridge: options.bridge ?? null }
        : createTaskRouterDependencies({
          ...options,
          registryPath: options.registryPath ?? options.registry,
          bindingPath: options.bindingPath ?? options.binding,
          statePath: options.statePath ?? options.state,
        });
      if (!components.router || typeof components.router.scanOnce !== "function") {
        throw new Error("task router 必须提供 scanOnce() 方法");
      }
    }

    while (!detectStop()) {
      let maintenance = options.maintenanceFilePath
        ? readExistingJson(options.maintenanceFilePath, fsImpl)
        : {};
      const reconciliation = reconcileAutomationMaintenance(options, components, maintenance, fsImpl, now);
      if (reconciliation.resolved) {
        appendLog(logPath, {
          at: nowIso(now),
          type: "maintenance_reconciled",
          pid,
          taskId: maintenance.reasons?.automationBridge?.taskId ?? null,
          wakeId: maintenance.reasons?.automationBridge?.wakeId ?? null,
          outcome: reconciliation.outcome,
        }, fsImpl);
        maintenance = options.maintenanceFilePath
          ? readExistingJson(options.maintenanceFilePath, fsImpl)
          : {};
      }
      const maintenanceReasons = maintenance.reasons && typeof maintenance.reasons === "object"
        ? maintenance.reasons
        : {};
      if (Object.keys(maintenanceReasons).length > 0) {
        const openTaskCount = components.registry && typeof components.registry.list === "function"
          ? components.registry.list({ status: "open" }).length
          : status.openTaskCount;
        const fingerprint = JSON.stringify(maintenanceReasons);
        persist({
          state: "maintenance",
          inFlightScan: false,
          maintenance: maintenanceReasons,
          openTaskCount,
          nextScanAt: nextTimeIso(now, scanIntervalMs),
          lastError: null,
        });
        if (fingerprint !== lastMaintenanceFingerprint) {
          appendLog(logPath, {
            at: nowIso(now),
            type: "maintenance",
            pid,
            openTaskCount,
            reasons: maintenanceReasons,
          }, fsImpl);
          lastMaintenanceFingerprint = fingerprint;
        }
        if (detectStop()) break;
        await (options.wait ?? waitForNextScan)(scanIntervalMs, {
          fsImpl,
          stopFilePath,
          pollMs: options.stopPollMs,
          isStopRequested: () => stopRequested || fileExists(stopFilePath, fsImpl),
        });
        continue;
      }
      lastMaintenanceFingerprint = null;
      scanCount += 1;
      try {
        persist({ state: "running", inFlightScan: true, maintenance: null });
        const scanResult = await components.router.scanOnce();
        const openTaskCount = parseOpenTaskCount(scanResult);
        const keepAlive = parseKeepAlive(scanResult);
        const scanAt = typeof scanResult?.scannedAt === "string" && scanResult.scannedAt
          ? scanResult.scannedAt
          : nowIso(now);
        const taskScanError = scanResultError(scanResult);
        if (taskScanError) throw taskScanError;
        const automationFailure = Array.isArray(scanResult?.results)
          ? scanResult.results.find((result) => shouldPauseAutomation(result))
          : null;
        const automationPause = automationFailure
          ? pauseAutomation(options, automationFailure, fsImpl, now)
          : null;
        failureCount = 0;
        status = {
          ...status,
          lastScanAt: scanAt,
          nextScanAt: openTaskCount > 0 || keepAlive ? nextTimeIso(now, scanIntervalMs) : null,
          openTaskCount,
          keepAlive,
          lastError: null,
          state: automationPause ? "maintenance" : "running",
          inFlightScan: false,
          maintenance: automationPause ? { automationBridge: automationPause } : null,
        };
        persist(status);
        appendLog(logPath, {
          at: scanAt,
          type: "scan",
          pid,
          openTaskCount,
          keepAlive,
          wakeCount: Number(scanResult?.wakeCount ?? 0),
        }, fsImpl);
        if (openTaskCount === 0 && !keepAlive) {
          stopReason = "no_open_tasks";
          break;
        }
      } catch (error) {
        failureCount += 1;
        const errorValue = publicError(error);
        const delayMs = calculateBackoffMs(scanIntervalMs, failureCount, maxBackoffMs);
        const scanAt = error.scanAt ?? nowIso(now);
        persist({
          lastScanAt: scanAt,
          nextScanAt: nextTimeIso(now, delayMs),
          ...(Number.isSafeInteger(error.openTaskCount) && error.openTaskCount >= 0
            ? { openTaskCount: error.openTaskCount }
            : {}),
          lastError: errorValue,
          state: "running",
          inFlightScan: false,
          maintenance: null,
        });
        appendLog(logPath, {
          at: scanAt,
          type: "scan_error",
          pid,
          error: errorValue,
          delayMs,
        }, fsImpl);
        if (detectStop()) break;
        await (options.wait ?? waitForNextScan)(delayMs, {
          fsImpl,
          stopFilePath,
          pollMs: options.stopPollMs,
          isStopRequested: () => stopRequested || fileExists(stopFilePath, fsImpl),
        });
        continue;
      }

      if (detectStop()) break;
      await (options.wait ?? waitForNextScan)(scanIntervalMs, {
        fsImpl,
        stopFilePath,
        pollMs: options.stopPollMs,
        isStopRequested: () => stopRequested || fileExists(stopFilePath, fsImpl),
      });
    }

    if (!stopReason) stopReason = "stop_requested";
    await closeBridge(components);
    componentsClosed = true;
    const stoppedAt = nowIso(now);
    persist({ state: "stopped", nextScanAt: null, stoppedAt, stopReason, inFlightScan: false });
    appendLog(logPath, { at: stoppedAt, type: "runner_stopped", pid, stopReason }, fsImpl);
    return { ...status, scanCount, failureCount, stopReason };
  } catch (error) {
    const errorValue = publicError(error, "TASK_ROUTER_RUNNER_FAILED");
    if (!componentsClosed) {
      try {
        await closeBridge(components);
      } catch {
      }
    }
    const failedAt = nowIso(now);
    try {
      persist({ state: "failed", nextScanAt: null, lastError: errorValue, failedAt, inFlightScan: false });
    } catch {
      status = { ...status, state: "failed", nextScanAt: null, lastError: errorValue, failedAt };
    }
    appendLog(logPath, { at: failedAt, type: "runner_failed", pid, error: errorValue }, fsImpl);
    return { ...status, scanCount, failureCount, error: errorValue };
  } finally {
    signalCleanup();
    lock.release();
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseArguments(argv);
  return runTaskRouterService({ ...parsed, ...dependencies });
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().then((result) => {
    if (result.state === "failed") process.exitCode = 1;
  }).catch((error) => {
    console.error(`[task-router-runner] ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}
