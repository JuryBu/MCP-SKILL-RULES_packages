import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createNapCatNotifier } from "./core.mjs";
import { createTaskRegistry } from "./task-registry.mjs";
import { createTaskRouterController } from "./task-router-controller.mjs";
import { acquireInstanceLock, readPrivateEnvironment } from "./task-router-runner.mjs";

export const DEFAULT_SUPERVISOR_INTERVAL_MS = 15_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 35_000;
export const DEFAULT_LOGIN_COOLDOWN_MS = 120_000;
export const DEFAULT_BROKER_START_COOLDOWN_MS = 60_000;
export const DEFAULT_STOP_POLL_MS = 250;

const CLI_OPTIONS = new Set([
  "private-env",
  "binding",
  "registry",
  "runtime-state",
  "log",
  "stop-file",
  "lock",
  "interval-ms",
  "broker-health-url",
  "broker-start-script",
  "login-script",
  "napcat-root",
  "probe-timeout-ms",
  "login-timeout-ms",
  "login-cooldown-ms",
  "broker-start-cooldown-ms",
  "automation-maintenance",
  "automation-alert",
  "automation-maintenance-path",
  "automation-alert-path",
  "maintenance-file",
  "alert-file",
  "maintenance",
  "alert",
  "once",
]);

function normalizePositiveInteger(value, name, fallback, minimum = 1) {
  const candidate = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
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

function normalizeClock(clock) {
  if (typeof clock === "function") return clock;
  if (clock === undefined) return () => new Date();
  return () => clock;
}

function nowDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("now 返回了无效时间");
  return date;
}

function nowIso(clock) {
  return nowDate(clock).toISOString();
}

function nowMs(clock) {
  return nowDate(clock).getTime();
}

function nextTimeIso(clock, delayMs) {
  return new Date(nowMs(clock) + delayMs).toISOString();
}

function fileExists(filePath, fsImpl) {
  try {
    return Boolean(filePath && fsImpl.existsSync(filePath));
  } catch {
    return false;
  }
}

function readJsonObject(filePath, fsImpl) {
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readAutomationFile(filePath, fsImpl) {
  if (!filePath || !fileExists(filePath, fsImpl)) {
    return { path: filePath ?? null, present: false, value: {}, error: null };
  }
  try {
    const value = JSON.parse(fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("自动化控制文件必须是 JSON 对象");
    }
    return { path: filePath, present: true, value, error: null };
  } catch (error) {
    return {
      path: filePath,
      present: true,
      value: {},
      error: publicError(error, "AUTOMATION_FILE_INVALID"),
    };
  }
}

function textValue(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const normalized = textValue(value).toLowerCase();
  if (["true", "1", "yes", "active", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "inactive", "off"].includes(normalized)) return false;
  return null;
}

function normalizeMaintenanceFile(filePath, fsImpl) {
  const file = readAutomationFile(filePath, fsImpl);
  if (!file.present) {
    return {
      path: filePath,
      present: false,
      known: true,
      active: false,
      status: "inactive",
      reason: null,
      reasons: [],
      lastError: null,
    };
  }
  if (file.error) {
    return {
      path: filePath,
      present: true,
      known: false,
      active: true,
      status: "invalid",
      reason: "invalid_file",
      reasons: [],
      lastError: file.error,
    };
  }
  const rawStatus = textValue(file.value.status ?? file.value.state ?? file.value.mode).toLowerCase();
  const reasons = file.value.reasons && typeof file.value.reasons === "object"
    ? (Array.isArray(file.value.reasons)
      ? file.value.reasons.map((reason) => textValue(reason)).filter(Boolean)
      : Object.keys(file.value.reasons))
    : [];
  const active = booleanValue(file.value.active) === true
    || booleanValue(file.value.maintenance) === true
    || booleanValue(file.value.paused) === true
    || reasons.length > 0
    || ["active", "maintenance", "paused", "pause"].includes(rawStatus);
  return {
    path: filePath,
    present: true,
    known: true,
    active,
    status: active ? "active" : (rawStatus || "inactive"),
    reason: textValue(file.value.reason ?? file.value.message ?? file.value.summary) || null,
    reasons,
    updatedAt: textValue(file.value.updatedAt ?? file.value.updated_at) || null,
    lastError: null,
  };
}

function normalizeAlertFile(filePath, fsImpl) {
  const file = readAutomationFile(filePath, fsImpl);
  if (!file.present) {
    return {
      path: filePath,
      present: false,
      known: true,
      raw: {},
      status: "none",
      pending: false,
      incidentKey: null,
      text: "",
      attempts: 0,
      lastAttemptAt: null,
      sentAt: null,
      lastError: null,
    };
  }
  if (file.error) {
    return {
      path: filePath,
      present: true,
      known: false,
      raw: {},
      status: "invalid",
      pending: false,
      incidentKey: null,
      text: "",
      attempts: 0,
      lastAttemptAt: null,
      sentAt: null,
      lastError: file.error,
    };
  }
  const nested = file.value.alert && typeof file.value.alert === "object" && !Array.isArray(file.value.alert)
    ? file.value.alert
    : {};
  const readValue = (...keys) => {
    for (const key of keys) {
      if (file.value[key] !== undefined && file.value[key] !== null) return file.value[key];
      if (nested[key] !== undefined && nested[key] !== null) return nested[key];
    }
    return undefined;
  };
  const status = textValue(readValue("status", "state")).toLowerCase();
  const sent = booleanValue(readValue("sent")) === true || ["sent", "delivered"].includes(status);
  const explicitIncidentKey = textValue(readValue("incidentKey", "incident_key", "key"));
  const source = textValue(readValue("source"));
  const taskId = textValue(readValue("taskId", "task_id"));
  const outcome = textValue(readValue("outcome"));
  const code = textValue(readValue("code"));
  const incidentKey = explicitIncidentKey || (
    source && (taskId || outcome || code)
      ? [source, taskId || "no-task", outcome || "no-outcome", code || "no-code"].join(":")
      : ""
  );
  const text = textValue(readValue("text", "message", "alertText", "summary"));
  const pending = !sent && (
    booleanValue(readValue("pending")) === true
    || ["pending", "retry", "queued"].includes(status)
    || Boolean(incidentKey)
  );
  const attemptsValue = Number(readValue("attempts", "retryCount", "retry_count") ?? 0);
  const attempts = Number.isSafeInteger(attemptsValue) && attemptsValue >= 0 ? attemptsValue : 0;
  return {
    path: filePath,
    present: true,
    known: true,
    raw: file.value,
    status: sent ? "sent" : (pending ? "pending" : (status || "none")),
    pending,
    incidentKey: incidentKey || null,
    text,
    attempts,
    lastAttemptAt: textValue(readValue("lastAttemptAt", "last_attempt_at")) || null,
    sentAt: textValue(readValue("sentAt", "sent_at")) || null,
    lastError: readValue("lastError", "last_error") ?? null,
  };
}

function normalizeSentIncidentKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, sentAt]) => textValue(key) && textValue(sentAt))
    .slice(-100));
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/(authorization|access[_-]?token|password|secret)(\s*[=:]\s*)[^\s,;}]+/gi, "$1$2[redacted]")
    .slice(0, 1000);
}

export function publicError(error, fallbackCode = "SUPERVISOR_ERROR") {
  return {
    code: error?.code ?? fallbackCode,
    message: sanitizeText(error?.message ?? String(error)),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
  };
}

export function atomicWriteJson(filePath, value, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const normalizedPath = path.resolve(filePath);
  fsImpl.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  const timestamp = options.now ? nowMs(normalizeClock(options.now)) : Date.now();
  const temporaryPath = `${normalizedPath}.tmp-${options.pid ?? process.pid}-${timestamp}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(temporaryPath, "wx", 0o600);
    fsImpl.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (typeof fsImpl.fsyncSync === "function") fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    fsImpl.renameSync(temporaryPath, normalizedPath);
  } catch (error) {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    try {
      fsImpl.unlinkSync(temporaryPath);
    } catch {
    }
    throw error;
  }
}

export function writeRuntimeState(runtimeStatePath, patch = {}, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  let current = {};
  try {
    current = JSON.parse(fsImpl.readFileSync(runtimeStatePath, "utf8").replace(/^\uFEFF/, ""));
    if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
  } catch {
    current = {};
  }
  const next = {
    schemaVersion: 1,
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  };
  atomicWriteJson(runtimeStatePath, next, options);
  return next;
}

function appendLog(logPath, entry, fsImpl) {
  if (!logPath) return;
  try {
    fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
    fsImpl.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
  }
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`无效参数：${item}`);
    const name = item.slice(2);
    if (!CLI_OPTIONS.has(name)) throw new Error(`不支持参数：${item}`);
    if (name === "once") {
      values[name] = true;
      continue;
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`参数缺少值：${item}`);
    }
    values[name] = argv[index + 1];
    index += 1;
  }

  const required = [
    ["binding", "--binding"],
    ["registry", "--registry"],
    ["runtime-state", "--runtime-state"],
    ["log", "--log"],
    ["stop-file", "--stop-file"],
    ["lock", "--lock"],
    ["broker-health-url", "--broker-health-url"],
  ];
  for (const [name, flag] of required) {
    if (values[name] === undefined) throw new Error(`缺少参数 ${flag}`);
  }

  const intervalMs = normalizePositiveInteger(
    values["interval-ms"],
    "--interval-ms",
    DEFAULT_SUPERVISOR_INTERVAL_MS,
  );
  const probeTimeoutMs = normalizePositiveInteger(
    values["probe-timeout-ms"],
    "--probe-timeout-ms",
    DEFAULT_PROBE_TIMEOUT_MS,
  );
  const loginTimeoutMs = normalizePositiveInteger(
    values["login-timeout-ms"],
    "--login-timeout-ms",
    DEFAULT_LOGIN_TIMEOUT_MS,
  );
  const loginCooldownMs = normalizePositiveInteger(
    values["login-cooldown-ms"],
    "--login-cooldown-ms",
    DEFAULT_LOGIN_COOLDOWN_MS,
  );
  const brokerStartCooldownMs = normalizePositiveInteger(
    values["broker-start-cooldown-ms"],
    "--broker-start-cooldown-ms",
    DEFAULT_BROKER_START_COOLDOWN_MS,
  );
  const automationMaintenancePath = resolveOptionalPath(
    values["automation-maintenance"]
      ?? values["automation-maintenance-path"]
      ?? values["maintenance-file"]
      ?? values.maintenance,
  );
  const automationAlertPath = resolveOptionalPath(
    values["automation-alert"]
      ?? values["automation-alert-path"]
      ?? values["alert-file"]
      ?? values.alert,
  );

  return {
    privateEnvPath: resolveOptionalPath(values["private-env"]),
    bindingPath: resolveRequiredPath(values.binding, "--binding"),
    registryPath: resolveRequiredPath(values.registry, "--registry"),
    runtimeStatePath: resolveRequiredPath(values["runtime-state"], "--runtime-state"),
    logPath: resolveRequiredPath(values.log, "--log"),
    stopFilePath: resolveRequiredPath(values["stop-file"], "--stop-file"),
    lockPath: resolveRequiredPath(values.lock, "--lock"),
    scanIntervalMs: intervalMs,
    intervalMs,
    probeTimeoutMs,
    loginTimeoutMs,
    loginCooldownMs,
    brokerStartCooldownMs,
    automationMaintenancePath,
    automationAlertPath,
    maintenanceFilePath: automationMaintenancePath,
    alertFilePath: automationAlertPath,
    maintenancePath: automationMaintenancePath,
    alertPath: automationAlertPath,
    brokerHealthUrl: String(values["broker-health-url"]).trim(),
    brokerStartScriptPath: resolveOptionalPath(values["broker-start-script"]),
    loginScriptPath: resolveOptionalPath(values["login-script"]),
    napcatRoot: resolveOptionalPath(values["napcat-root"]),
    once: values.once === true,
  };
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function execFilePromise(executable, args, options = {}) {
  const execFileImpl = options.execFileImpl ?? execFile;
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, {
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      cwd: options.cwd,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export async function invokePowerShellScript(scriptPath, scriptArguments = [], options = {}) {
  const normalizedScriptPath = resolveRequiredPath(scriptPath, "PowerShell 脚本");
  const argumentsList = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    normalizedScriptPath,
    ...scriptArguments.map((value) => String(value)),
  ];
  return execFilePromise(options.powershellPath ?? "powershell.exe", argumentsList, options);
}

export async function invokePowerShellCommand(command, options = {}) {
  const argumentsList = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-Command",
    String(command),
  ];
  const result = await execFilePromise(options.powershellPath ?? "powershell.exe", argumentsList, options);
  return { ...result, value: parseJsonOutput(result.stdout) };
}

export function buildQuickLoginArguments(options = {}) {
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    "loginTimeoutMs",
    DEFAULT_LOGIN_TIMEOUT_MS,
  );
  const timeoutSeconds = Math.max(30, Math.ceil(timeoutMs / 1000));
  const argumentsList = [
    "-NoQr",
    "-TimeoutSeconds",
    String(timeoutSeconds),
    "-NapCatRoot",
    resolveRequiredPath(options.napcatRoot, "napcatRoot"),
  ];
  if (options.codexHome) {
    argumentsList.push("-CodexHome", resolveRequiredPath(options.codexHome, "codexHome"));
  }
  return argumentsList;
}

export async function runQuickLogin(options = {}) {
  if (typeof options.quickLogin === "function") return options.quickLogin(options);
  const loginTimeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    "loginTimeoutMs",
    DEFAULT_LOGIN_TIMEOUT_MS,
  );
  return invokePowerShellScript(
    options.loginScriptPath,
    buildQuickLoginArguments({ ...options, timeoutMs: loginTimeoutMs }),
    { ...options, timeoutMs: loginTimeoutMs + 15_000 },
  );
}

export async function runBrokerStart(options = {}) {
  if (typeof options.startBroker === "function") return options.startBroker(options);
  return invokePowerShellScript(options.brokerStartScriptPath, [], options);
}

export async function checkBrokerHealth(options = {}) {
  const url = String(options.url ?? options.brokerHealthUrl ?? "").trim();
  if (!url) throw new Error("brokerHealthUrl 不能为空");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node 运行时没有 fetch 支持");
  const controller = new AbortController();
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    "probeTimeoutMs",
    DEFAULT_PROBE_TIMEOUT_MS,
  );
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain" },
    });
    let data = null;
    if (typeof response?.text === "function") {
      const text = await response.text();
      try {
        data = text.trim() ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    } else if (typeof response?.json === "function") {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }
    const status = Number(response?.status ?? 0);
    const httpHealthy = response?.ok === true
      || (response?.ok === undefined && status >= 200 && status < 300);
    const healthy = Boolean(
      httpHealthy
      && data?.ok !== false
      && data?.healthy !== false
      && data?.status !== "error",
    );
    return {
      known: true,
      healthy,
      reachable: true,
      status,
      data: data && typeof data === "object" ? data : null,
    };
  } catch (error) {
    const wrapped = new Error(`broker health 检查失败：${error?.message ?? String(error)}`, { cause: error });
    wrapped.code = error?.name === "AbortError" ? "BROKER_HEALTH_TIMEOUT" : "BROKER_HEALTH_UNAVAILABLE";
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
}

export async function listWindowsProcesses(options = {}) {
  const command = "$items = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine); if ($items.Count -eq 0) { '[]' } else { $items | ConvertTo-Json -Compress }";
  const result = await invokePowerShellCommand(command, options);
  return result.value;
}

function processText(processRecord) {
  return `${processRecord?.Name ?? processRecord?.name ?? ""}\n${processRecord?.CommandLine ?? processRecord?.commandLine ?? ""}`.toLowerCase();
}

function processId(processRecord) {
  const value = Number(processRecord?.ProcessId ?? processRecord?.pid ?? processRecord?.processId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function summarizeProcesses(processes) {
  return processes.map((item) => ({
    pid: processId(item),
    name: String(item?.Name ?? item?.name ?? "").slice(0, 120),
  }));
}

function normalizeProcessRecords(processes) {
  if (!Array.isArray(processes)) return [];
  return processes.filter((item) => item && typeof item === "object");
}

export function findNapCatProcesses(processes, napcatRoot) {
  const normalizedRoot = napcatRoot ? path.resolve(napcatRoot).replaceAll("\\", "/").toLowerCase() : null;
  return normalizeProcessRecords(processes).filter((item) => {
    const text = processText(item).replaceAll("\\", "/");
    const name = String(item?.Name ?? item?.name ?? "");
    const belongsToRuntime = Boolean(normalizedRoot && text.includes(normalizedRoot));
    return Boolean(
      /^napcatwinbootmain\.exe$/i.test(name)
      || (belongsToRuntime && /launcher-user\.bat/i.test(text))
      || (belongsToRuntime && /^(powershell|pwsh)(\.exe)?$/i.test(name) && /start-napcat-login\.ps1/i.test(text)),
    );
  });
}

export function findCodexProcesses(processes) {
  return normalizeProcessRecords(processes).filter((item) => {
    const text = processText(item);
    const name = String(item?.Name ?? item?.name ?? "");
    const isElectronHelper = /\s--type=/i.test(text);
    return Boolean(
      /^(codex|codex-cli)(\.exe|\.cmd)?$/i.test(name)
      || /codex app-server/i.test(text)
      || (/^chatgpt\.exe$/i.test(name) && !isElectronHelper && /openai\.codex_/i.test(text)),
    );
  });
}

export function findBrokerProcesses(processes, brokerRoot) {
  void brokerRoot;
  return normalizeProcessRecords(processes).filter((item) => {
    const text = processText(item).replaceAll("\\", "/");
    const name = String(item?.Name ?? item?.name ?? "");
    return Boolean(
      /^node(?:\.exe)?$/i.test(name)
      && /(?:^|[\s"])[^\r\n"]*broker\.mjs(?:[\s"]|$)/i.test(text),
    );
  });
}

function processCheckResult(processes) {
  const normalized = normalizeProcessRecords(processes);
  return {
    known: true,
    present: normalized.length > 0,
    count: normalized.length,
    processes: summarizeProcesses(normalized),
  };
}

export async function checkNapCatProcesses(options = {}) {
  const processes = options.processes ?? await listWindowsProcesses(options);
  return processCheckResult(findNapCatProcesses(processes, options.napcatRoot));
}

export async function checkCodexProcesses(options = {}) {
  const processes = options.processes ?? await listWindowsProcesses(options);
  return processCheckResult(findCodexProcesses(processes));
}

export async function checkBrokerProcesses(options = {}) {
  const processes = options.processes ?? await listWindowsProcesses(options);
  return processCheckResult(findBrokerProcesses(processes, options.brokerRoot));
}

function normalizeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

export function normalizeBrokerHealth(value) {
  if (typeof value === "boolean") return { known: true, healthy: value, reachable: value };
  const healthy = normalizeBoolean(value?.healthy)
    ?? normalizeBoolean(value?.ok)
    ?? (value?.status === "ok" ? true : null);
  return {
    known: value?.known !== false && healthy !== null,
    healthy: healthy === true,
    reachable: value?.reachable !== false,
    status: value?.status ?? null,
    error: value?.error ?? null,
  };
}

export function normalizeNapCatStatus(value) {
  if (typeof value === "boolean") {
    return { known: true, reachable: value, online: value, accountMatches: value, ready: value };
  }
  const runtimeOnline = normalizeBoolean(value?.runtimeStatus?.online);
  const online = normalizeBoolean(value?.online) ?? runtimeOnline ?? (value?.ready === true ? true : false);
  const accountMatches = normalizeBoolean(value?.accountMatches)
    ?? (value?.identityError ? false : value?.identity ? true : value?.ready === true);
  const reachable = value?.reachable !== false;
  return {
    known: value?.known !== false && !value?.error,
    reachable,
    online,
    accountMatches,
    ready: reachable && online && accountMatches,
    error: value?.error ?? value?.identityError ?? null,
    runtimeStatus: value?.runtimeStatus ?? null,
    identity: value?.identity ?? null,
  };
}

export function checkNapCatRuntime(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const napcatRoot = resolveOptionalPath(options.napcatRoot);
  if (!napcatRoot) {
    return {
      known: false,
      ready: false,
      napcatRoot: null,
      requiredFiles: [],
      missingFiles: [],
      error: {
        code: "NAPCAT_ROOT_UNKNOWN",
        message: "NapCatRoot 未配置，无法判断运行文件是否完整",
        outcomeUnknown: false,
      },
    };
  }
  const requiredFiles = [
    path.join(napcatRoot, "launcher-user.bat"),
    path.join(napcatRoot, "napcat.mjs"),
  ];
  const missingFiles = requiredFiles.filter((filePath) => !fileExists(filePath, fsImpl));
  return {
    known: true,
    ready: missingFiles.length === 0,
    napcatRoot,
    requiredFiles,
    missingFiles,
    error: missingFiles.length > 0
      ? {
        code: "NAPCAT_RUNTIME_INCOMPLETE",
        message: `NapCat 运行文件缺失：${missingFiles.join(", ")}。可能被安全软件隔离或安装损坏，这不表示快速登录授权已过期。`,
        outcomeUnknown: false,
      }
      : null,
  };
}

export function normalizeNapCatRuntime(value) {
  const ready = normalizeBoolean(value?.ready);
  return {
    known: value?.known !== false && ready !== null,
    ready: ready === true,
    napcatRoot: value?.napcatRoot ?? null,
    requiredFiles: Array.isArray(value?.requiredFiles) ? value.requiredFiles : [],
    missingFiles: Array.isArray(value?.missingFiles) ? value.missingFiles : [],
    error: value?.error ?? null,
  };
}

export function normalizeProcessCheck(value) {
  if (Array.isArray(value)) {
    return processCheckResult(value);
  }
  if (typeof value === "boolean") return { known: true, present: value, count: value ? 1 : 0, processes: [] };
  const present = normalizeBoolean(value?.present)
    ?? normalizeBoolean(value?.running)
    ?? normalizeBoolean(value?.alive);
  return {
    known: value?.known !== false && present !== null,
    present: present === true,
    count: Number.isSafeInteger(Number(value?.count)) ? Number(value.count) : (present ? 1 : 0),
    processes: Array.isArray(value?.processes) ? value.processes : [],
    error: value?.error ?? null,
  };
}

export function normalizeRouterStatus(value) {
  if (typeof value === "boolean") return { known: true, alive: value, state: value ? "running" : "stopped" };
  const alive = normalizeBoolean(value?.alive)
    ?? normalizeBoolean(value?.running)
    ?? false;
  return {
    known: value?.known !== false && (value !== null && value !== undefined),
    alive,
    state: value?.state ?? (alive ? "running" : "stopped"),
    pid: value?.runtime?.pid ?? value?.pid ?? null,
    runtime: value?.runtime ?? null,
    error: value?.error ?? null,
  };
}

function normalizeOpenTaskCount(value) {
  const candidate = Array.isArray(value) ? value.length : Number(value?.openTaskCount ?? value?.count ?? value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error("open task 数量无效");
  }
  return candidate;
}

function deriveCodexHome(privateEnvPath) {
  if (!privateEnvPath) return null;
  return path.dirname(path.dirname(path.resolve(privateEnvPath)));
}

export function createSupervisorDependencies(options = {}) {
  const bindingPath = resolveRequiredPath(options.bindingPath ?? options.binding, "bindingPath");
  const registryPath = resolveRequiredPath(options.registryPath ?? options.registry, "registryPath");
  const runtimeStatePath = resolveRequiredPath(options.runtimeStatePath ?? options["runtime-state"], "runtimeStatePath");
  const logPath = resolveOptionalPath(options.logPath ?? options.log);
  const stopFilePath = resolveRequiredPath(options.stopFilePath ?? options["stop-file"], "stopFilePath");
  const lockPath = resolveRequiredPath(options.lockPath ?? options.lock, "lockPath");
  const privateEnvPath = resolveOptionalPath(options.privateEnvPath ?? options["private-env"]);
  const privateEnvironment = options.privateEnvironment
    ?? (privateEnvPath ? readPrivateEnvironment(privateEnvPath) : {});
  const rootDir = path.resolve(options.rootDir ?? path.dirname(bindingPath));
  const codeRoot = path.resolve(
    options.codeRoot
      ?? privateEnvironment.NAPCAT_MCP_ROOT
      ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  );
  const statePath = path.resolve(options.statePath ?? path.join(rootDir, "state", "dedupe.json"));
  const automationMaintenancePath = path.resolve(
    options.automationMaintenancePath
      ?? options.maintenancePath
      ?? options["automation-maintenance"]
      ?? options.maintenanceFilePath
      ?? options["maintenance-file"]
      ?? path.join(rootDir, "state", "task-router.maintenance.json"),
  );
  const automationAlertPath = path.resolve(
    options.automationAlertPath
      ?? options.alertPath
      ?? options["automation-alert"]
      ?? options.alertFilePath
      ?? options["alert-file"]
      ?? path.join(rootDir, "state", "automation-alert.json"),
  );
  const taskRouterRuntimePath = path.resolve(options.taskRouterRuntimePath ?? path.join(rootDir, "state", "task-router-runtime.json"));
  const taskRouterLogPath = path.resolve(options.taskRouterLogPath ?? path.join(rootDir, "state", "task-router.jsonl"));
  const taskRouterStopPath = path.resolve(options.taskRouterStopPath ?? path.join(rootDir, "state", "task-router.stop"));
  const taskRouterLockPath = path.resolve(options.taskRouterLockPath ?? path.join(rootDir, "state", "task-router.lock"));
  const environment = {
    ...process.env,
    ...privateEnvironment,
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: statePath,
    NAPCAT_TASK_REGISTRY_PATH: registryPath,
    NAPCAT_TASK_ROUTER_RUNTIME_PATH: taskRouterRuntimePath,
    NAPCAT_TASK_ROUTER_LOG_PATH: taskRouterLogPath,
    NAPCAT_TASK_ROUTER_STOP_PATH: taskRouterStopPath,
    NAPCAT_TASK_ROUTER_LOCK_PATH: taskRouterLockPath,
  };
  const notifier = options.notifier ?? createNapCatNotifier({
    cwd: rootDir,
    env: environment,
    fetchImpl: options.fetchImpl,
    now: options.now === undefined ? undefined : normalizeClock(options.now),
  });
  const registry = options.registry ?? createTaskRegistry({
    statePath: registryPath,
    now: options.now,
  });
  const routerController = options.routerController ?? (options.createTaskRouterController ?? createTaskRouterController)({
    ...(options.routerControllerOptions ?? {}),
    rootDir,
    runnerPath: options.routerControllerOptions?.runnerPath ?? path.join(codeRoot, "src", "task-router-runner.mjs"),
    env: environment,
  });
  return {
    bindingPath,
    registryPath,
    runtimeStatePath,
    logPath,
    stopFilePath,
    lockPath,
    privateEnvPath,
    privateEnvironment,
    codeRoot,
    environment,
    rootDir,
    statePath,
    automationMaintenancePath,
    automationAlertPath,
    maintenanceFilePath: automationMaintenancePath,
    alertFilePath: automationAlertPath,
    codexHome: options.codexHome ?? deriveCodexHome(privateEnvPath),
    brokerStartScriptPath: resolveOptionalPath(options.brokerStartScriptPath ?? options["broker-start-script"]),
    loginScriptPath: resolveOptionalPath(options.loginScriptPath ?? options["login-script"]),
    napcatRoot: resolveOptionalPath(options.napcatRoot ?? options["napcat-root"]),
    notifier,
    registry,
    routerController,
  };
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

export function waitForNextScan(milliseconds, options = {}) {
  const delayMs = Math.max(0, Number(milliseconds));
  const fsImpl = options.fsImpl ?? fs;
  const stopFilePath = options.stopFilePath;
  const pollMs = Math.max(1, Number(options.pollMs ?? DEFAULT_STOP_POLL_MS));
  const clock = normalizeClock(options.now ?? (() => Date.now()));
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const getNowMs = () => nowMs(clock);
  const isStopRequested = options.isStopRequested ?? (() => fileExists(stopFilePath, fsImpl));
  return new Promise((resolve) => {
    const deadline = getNowMs() + delayMs;
    let timer;
    const check = () => {
      if (isStopRequested() || getNowMs() >= deadline) {
        if (timer !== undefined) clearTimeoutImpl(timer);
        resolve();
        return;
      }
      timer = setTimeoutImpl(check, Math.min(pollMs, Math.max(1, deadline - getNowMs())));
    };
    check();
  });
}

function processSnapshotOptions(dependencies, options, snapshot) {
  return {
    ...options,
    ...dependencies,
    processes: snapshot,
    timeoutMs: options.probeTimeoutMs,
    brokerRoot: dependencies.rootDir,
    napcatRoot: options.napcatRoot,
  };
}

function summarizeCheck(check) {
  const summary = { known: Boolean(check?.known) };
  for (const field of ["healthy", "reachable", "online", "accountMatches", "ready", "present", "count", "alive", "state", "pid", "napcatRoot", "requiredFiles", "missingFiles", "error"]) {
    if (check?.[field] !== undefined) summary[field] = check[field];
  }
  return summary;
}

function cooldownReady(lastAttemptAt, clock, cooldownMs) {
  if (!lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(lastAttemptAt);
  return !Number.isFinite(lastAttemptMs) || nowMs(clock) >= lastAttemptMs + cooldownMs;
}

function actionError(error) {
  return publicError(error, "SUPERVISOR_ACTION_FAILED");
}

export async function runSupervisorService(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const processObject = options.processObject ?? process;
  const pid = options.pid ?? processObject.pid ?? process.pid;
  const clock = normalizeClock(options.now);
  const runtimeStatePath = resolveRequiredPath(options.runtimeStatePath ?? options["runtime-state"], "runtimeStatePath");
  const stopFilePath = resolveRequiredPath(options.stopFilePath ?? options["stop-file"], "stopFilePath");
  const lockPath = resolveRequiredPath(options.lockPath ?? options.lock, "lockPath");
  const logPath = resolveOptionalPath(options.logPath ?? options.log);
  const bindingPath = resolveRequiredPath(options.bindingPath ?? options.binding, "bindingPath");
  const registryPath = resolveRequiredPath(options.registryPath ?? options.registry, "registryPath");
  const privateEnvPath = resolveOptionalPath(options.privateEnvPath ?? options["private-env"]);
  const automationMaintenancePath = resolveOptionalPath(
    options.automationMaintenancePath
      ?? options.maintenancePath
      ?? options["automation-maintenance"]
      ?? options["automation-maintenance-path"]
      ?? options.maintenanceFilePath
      ?? options["maintenance-file"]
      ?? options.maintenance,
  ) ?? path.join(path.dirname(runtimeStatePath), "task-router.maintenance.json");
  const automationAlertPath = resolveOptionalPath(
    options.automationAlertPath
      ?? options.alertPath
      ?? options["automation-alert"]
      ?? options["automation-alert-path"]
      ?? options.alertFilePath
      ?? options["alert-file"]
      ?? options.alert,
  ) ?? path.join(path.dirname(runtimeStatePath), "automation-alert.json");
  const brokerHealthUrl = String(options.brokerHealthUrl ?? options["broker-health-url"] ?? "").trim();
  const scanIntervalMs = normalizePositiveInteger(
    options.scanIntervalMs ?? options.intervalMs ?? options["interval-ms"],
    "scanIntervalMs",
    DEFAULT_SUPERVISOR_INTERVAL_MS,
  );
  const probeTimeoutMs = normalizePositiveInteger(options.probeTimeoutMs, "probeTimeoutMs", DEFAULT_PROBE_TIMEOUT_MS);
  const loginTimeoutMs = normalizePositiveInteger(options.loginTimeoutMs, "loginTimeoutMs", DEFAULT_LOGIN_TIMEOUT_MS);
  const loginCooldownMs = normalizePositiveInteger(options.loginCooldownMs, "loginCooldownMs", DEFAULT_LOGIN_COOLDOWN_MS);
  const brokerStartCooldownMs = normalizePositiveInteger(
    options.brokerStartCooldownMs,
    "brokerStartCooldownMs",
    DEFAULT_BROKER_START_COOLDOWN_MS,
  );
  const startedAt = nowIso(clock);
  const lock = acquireInstanceLock(lockPath, {
    fsImpl,
    pid,
    now: () => new Date(startedAt),
    isProcessAlive: options.isProcessAlive,
    processObject,
    validateExistingLock: (metadata) => {
      const lockStartedAt = Date.parse(metadata?.startedAt ?? "");
      const currentMs = nowMs(clock);
      if (Number.isFinite(lockStartedAt) && currentMs >= lockStartedAt && currentMs - lockStartedAt < 15_000) return true;
      const runtime = readJsonObject(runtimeStatePath, fsImpl);
      const updatedAt = Date.parse(runtime.updatedAt ?? runtime.lastCheckAt ?? runtime.startedAt ?? "");
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

  let dependencies;
  try {
    dependencies = options.dependencies ?? createSupervisorDependencies({
      ...options,
      bindingPath,
      registryPath,
      runtimeStatePath,
      logPath,
      stopFilePath,
      lockPath,
      privateEnvPath,
    });
  } catch (error) {
    lock.release();
    return {
      state: "failed",
      pid,
      lockPath,
      error: publicError(error, "SUPERVISOR_DEPENDENCY_FAILED"),
    };
  }
  const previousRuntime = readJsonObject(runtimeStatePath, fsImpl);
  const previousLogin = previousRuntime.login && typeof previousRuntime.login === "object"
    ? previousRuntime.login
    : {};
  const previousBrokerStart = previousRuntime.brokerStart && typeof previousRuntime.brokerStart === "object"
    ? previousRuntime.brokerStart
    : {};
  const previousAlert = previousRuntime.alert && typeof previousRuntime.alert === "object"
    ? previousRuntime.alert
    : {};
  const sentIncidentKeys = normalizeSentIncidentKeys(previousAlert.sentIncidentKeys);
  let status = {
    schemaVersion: 1,
    pid,
    instanceToken: lock.metadata.token,
    startedAt,
    lastCheckAt: null,
    nextCheckAt: null,
    state: "starting",
    stopReason: null,
    checks: null,
    actions: {},
    openTaskCount: 0,
    lastError: null,
    login: {
      lastAttemptAt: previousLogin.lastAttemptAt ?? null,
      nextAllowedAt: previousLogin.nextAllowedAt ?? null,
      lastResult: previousLogin.lastResult ?? null,
    },
    brokerStart: {
      lastAttemptAt: previousBrokerStart.lastAttemptAt ?? null,
      nextAllowedAt: previousBrokerStart.nextAllowedAt ?? null,
      lastResult: previousBrokerStart.lastResult ?? null,
    },
    maintenance: {
      path: automationMaintenancePath,
      present: false,
      known: true,
      active: false,
      status: "inactive",
      reason: null,
      lastError: null,
    },
    alert: {
      path: automationAlertPath,
      present: false,
      known: true,
      status: "none",
      pending: false,
      incidentKey: null,
      attempts: 0,
      retryCount: 0,
      lastAttemptAt: previousAlert.lastAttemptAt ?? null,
      sentAt: previousAlert.sentAt ?? null,
      lastError: previousAlert.lastError ?? null,
      sentIncidentKeys,
    },
    runtimeStatePath,
    stopFilePath,
    lockPath,
    scanIntervalMs,
  };
  let signalCleanup = () => {};
  let stopRequested = false;
  let stopReason = null;
  let cycleCount = 0;
  let loginLastAttemptAt = previousLogin.lastAttemptAt ?? null;
  let loginNextAllowedAt = previousLogin.nextAllowedAt ?? null;
  let brokerLastAttemptAt = previousBrokerStart.lastAttemptAt ?? null;
  let brokerNextAllowedAt = previousBrokerStart.nextAllowedAt ?? null;

  const persist = (patch) => {
    status = { ...status, ...patch, updatedAt: nowIso(clock) };
    atomicWriteJson(runtimeStatePath, status, { fsImpl, pid, now: clock });
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

  const checkBroker = options.checkBrokerHealth
    ?? options.brokerHealthCheck
    ?? ((input) => checkBrokerHealth(input));
  const checkNapCat = options.checkNapCatStatus
    ?? options.napcatStatusCheck
    ?? (async () => dependencies.notifier.status({ include_group: false }));
  const checkRuntime = options.checkNapCatRuntime
    ?? options.napcatRuntimeCheck
    ?? ((input) => checkNapCatRuntime(input));
  const checkTasks = options.getOpenTaskCount
    ?? options.openTaskCountCheck
    ?? (() => dependencies.registry.list({ status: "open" }).length);
  const checkRouter = options.checkRouterStatus
    ?? options.routerStatusCheck
    ?? (() => dependencies.routerController.status());
  const startRouter = options.startTaskRouter
    ?? options.startRouter
    ?? (() => dependencies.routerController.ensureStarted());
  const runLogin = options.quickLogin
    ?? (dependencies.loginScriptPath || options.loginScriptPath
      ? (input) => runQuickLogin({
        ...input,
        ...options,
        loginScriptPath: options.loginScriptPath ?? dependencies.loginScriptPath,
        napcatRoot: options.napcatRoot,
        codexHome: dependencies.codexHome,
        timeoutMs: loginTimeoutMs,
      })
      : null);
  const startBroker = options.startBroker
    ?? (dependencies.brokerStartScriptPath || options.brokerStartScriptPath
      ? (input) => runBrokerStart({
        ...input,
        ...options,
        brokerStartScriptPath: options.brokerStartScriptPath ?? dependencies.brokerStartScriptPath,
        timeoutMs: probeTimeoutMs,
      })
      : null);

  const writeAlertState = (raw, patch) => {
    const next = { ...raw, ...patch };
    atomicWriteJson(automationAlertPath, next, { fsImpl, pid, now: clock });
    return next;
  };

  let processSnapshotPromise = null;
  const getProcessSnapshot = async () => {
    if (!processSnapshotPromise) {
      processSnapshotPromise = (options.listProcesses ?? listWindowsProcesses)({
        ...options,
        timeoutMs: probeTimeoutMs,
      });
    }
    return processSnapshotPromise;
  };
  const checkNapCatProcess = options.checkNapCatProcesses
    ?? options.napcatProcessCheck
    ?? (() => getProcessSnapshot().then((processes) => checkNapCatProcesses(processSnapshotOptions(dependencies, options, processes))));
  const checkCodexProcess = options.checkCodexProcesses
    ?? options.codexProcessCheck
    ?? (() => getProcessSnapshot().then((processes) => checkCodexProcesses(processSnapshotOptions(dependencies, options, processes))));
  const checkBrokerProcess = options.checkBrokerProcesses
    ?? options.brokerProcessCheck
    ?? (() => getProcessSnapshot().then((processes) => checkBrokerProcesses(processSnapshotOptions(dependencies, options, processes))));

  const capture = async (callback, input, fallback) => {
    try {
      return await callback(input);
    } catch (error) {
      return { ...fallback, known: false, error: publicError(error) };
    }
  };

  try {
    persist({ state: "running", lastError: null, nextCheckAt: null });
    signalCleanup = options.installSignalHandlers === false
      ? () => {}
      : installSignalHandlers(processObject, requestStop);
    appendLog(logPath, { at: startedAt, type: "supervisor_started", pid, scanIntervalMs }, fsImpl);

    while (!detectStop()) {
      cycleCount += 1;
      processSnapshotPromise = null;
      const checkAt = nowIso(clock);
      const errors = [];
      const broker = normalizeBrokerHealth(await capture(
        checkBroker,
        { brokerHealthUrl, url: brokerHealthUrl, timeoutMs: probeTimeoutMs, now: clock },
        { known: false, healthy: false, reachable: false },
      ));
      if (broker.error) errors.push({ source: "broker", error: broker.error });

      const napcat = normalizeNapCatStatus(await capture(
        checkNapCat,
        { bindingPath, privateEnvPath, timeoutMs: probeTimeoutMs, now: clock },
        { known: false, reachable: false, online: false, accountMatches: false },
      ));
      if (napcat.error) errors.push({ source: "napcat", error: napcat.error });

      const napcatRuntime = normalizeNapCatRuntime(await capture(
        checkRuntime,
        { napcatRoot: options.napcatRoot ?? dependencies.napcatRoot, fsImpl },
        { known: false, ready: false, requiredFiles: [], missingFiles: [] },
      ));
      if (napcatRuntime.error) errors.push({ source: "napcat_runtime", error: napcatRuntime.error });

      const napcatProcess = normalizeProcessCheck(await capture(
        checkNapCatProcess,
        { napcatRoot: options.napcatRoot, timeoutMs: probeTimeoutMs },
        { known: false, present: false },
      ));
      if (napcatProcess.error) errors.push({ source: "napcat_process", error: napcatProcess.error });

      const codexProcess = normalizeProcessCheck(await capture(
        checkCodexProcess,
        { timeoutMs: probeTimeoutMs },
        { known: false, present: false },
      ));
      if (codexProcess.error) errors.push({ source: "codex_process", error: codexProcess.error });

      const brokerProcess = normalizeProcessCheck(await capture(
        checkBrokerProcess,
        { timeoutMs: probeTimeoutMs },
        { known: false, present: false },
      ));
      if (brokerProcess.error) errors.push({ source: "broker_process", error: brokerProcess.error });

      let openTaskCount = 0;
      let tasksKnown = true;
      try {
        openTaskCount = normalizeOpenTaskCount(await checkTasks({ registryPath, status: "open" }));
      } catch (error) {
        tasksKnown = false;
        errors.push({ source: "tasks", error: publicError(error) });
      }

      const router = normalizeRouterStatus(await capture(
        checkRouter,
        { runtimeStatePath, lockPath },
        { known: false, alive: false },
      ));
      if (router.error) errors.push({ source: "router", error: router.error });

      const maintenance = normalizeMaintenanceFile(automationMaintenancePath, fsImpl);
      const alert = normalizeAlertFile(automationAlertPath, fsImpl);
      let maintenanceSummary = maintenance;
      let alertSummary = {
        path: alert.path,
        present: alert.present,
        known: alert.known,
        status: alert.status,
        pending: alert.pending,
        incidentKey: alert.incidentKey,
        attempts: alert.attempts,
        retryCount: alert.attempts,
        lastAttemptAt: alert.lastAttemptAt,
        sentAt: alert.sentAt,
        lastError: alert.lastError,
        sentIncidentKeys: { ...sentIncidentKeys },
      };
      const actions = {};
      actions.maintenance = {
        active: maintenance.active,
        reason: maintenance.reason,
        reasons: maintenance.reasons,
      };
      const routerCanReconcileMaintenance = Boolean(
        maintenance.active
        && maintenance.known
        && maintenance.reasons.length === 1
        && maintenance.reasons[0] === "automationBridge"
      );
      const maintenanceBlocksRouter = maintenance.active && !routerCanReconcileMaintenance;
      actions.maintenance.routerCanReconcile = routerCanReconcileMaintenance;
      if (
        !broker.healthy
        && brokerProcess.known
        && !brokerProcess.present
        && typeof startBroker === "function"
        && cooldownReady(brokerLastAttemptAt, clock, brokerStartCooldownMs)
      ) {
        brokerLastAttemptAt = checkAt;
        brokerNextAllowedAt = nextTimeIso(clock, brokerStartCooldownMs);
        try {
          await startBroker({
            brokerHealthUrl,
            brokerStartScriptPath: options.brokerStartScriptPath ?? dependencies.brokerStartScriptPath,
            startedAt: checkAt,
            timeoutMs: probeTimeoutMs,
            hidden: true,
          });
          actions.brokerStart = { attempted: true, succeeded: true };
          status.brokerStart = { lastAttemptAt: brokerLastAttemptAt, nextAllowedAt: brokerNextAllowedAt, lastResult: "started" };
        } catch (error) {
          const value = actionError(error);
          actions.brokerStart = { attempted: true, succeeded: false, error: value };
          errors.push({ source: "broker_start", error: value });
          status.brokerStart = { lastAttemptAt: brokerLastAttemptAt, nextAllowedAt: brokerNextAllowedAt, lastResult: value };
        }
      } else if (!broker.healthy && !brokerProcess.present && brokerProcess.known && typeof startBroker !== "function") {
        actions.brokerStart = { attempted: false, reason: "script_missing" };
      }

      const quickLoginEligible = Boolean(
        !napcat.online
        && napcatRuntime.known
        && napcatRuntime.ready
        && napcatProcess.known
        && !napcatProcess.present
      );
      if (
        quickLoginEligible
        && typeof runLogin === "function"
        && cooldownReady(loginLastAttemptAt, clock, loginCooldownMs)
      ) {
        loginLastAttemptAt = checkAt;
        loginNextAllowedAt = nextTimeIso(clock, loginCooldownMs);
        try {
          await runLogin({
            loginScriptPath: options.loginScriptPath ?? dependencies.loginScriptPath,
            napcatRoot: options.napcatRoot,
            bindingPath,
            privateEnvPath,
            noQr: true,
            timeoutMs: loginTimeoutMs,
            hidden: true,
          });
          actions.quickLogin = { attempted: true, succeeded: true, noQr: true };
          status.login = { lastAttemptAt: loginLastAttemptAt, nextAllowedAt: loginNextAllowedAt, lastResult: "started" };
        } catch (error) {
          const value = actionError(error);
          actions.quickLogin = { attempted: true, succeeded: false, noQr: true, error: value };
          errors.push({ source: "quick_login", error: value });
          status.login = { lastAttemptAt: loginLastAttemptAt, nextAllowedAt: loginNextAllowedAt, lastResult: value };
        }
      } else if (!napcatRuntime.known) {
        actions.quickLogin = { attempted: false, reason: "runtime_unknown", noQr: true };
      } else if (!napcatRuntime.ready) {
        actions.quickLogin = {
          attempted: false,
          reason: "runtime_incomplete",
          noQr: true,
          error: napcatRuntime.error,
        };
      } else if (quickLoginEligible && typeof runLogin !== "function") {
        actions.quickLogin = { attempted: false, reason: "script_missing", noQr: true };
      } else if (!napcat.online && napcatProcess.present) {
        actions.quickLogin = { attempted: false, reason: "napcat_process_present", noQr: true };
      } else if (quickLoginEligible && !cooldownReady(loginLastAttemptAt, clock, loginCooldownMs)) {
        actions.quickLogin = { attempted: false, reason: "cooldown", noQr: true };
      }

      if (alert.pending) {
        const alreadySent = Boolean(alert.incidentKey && sentIncidentKeys[alert.incidentKey]);
        if (!napcat.ready) {
          actions.alert = {
            attempted: false,
            reason: "napcat_not_ready",
            incidentKey: alert.incidentKey,
          };
        } else if (alreadySent) {
          const sentAt = sentIncidentKeys[alert.incidentKey];
          writeAlertState(alert.raw, {
            status: "sent",
            pending: false,
            sent: true,
            incidentKey: alert.incidentKey,
            attempts: alert.attempts,
            retryCount: alert.attempts,
            lastAttemptAt: alert.lastAttemptAt,
            lastError: null,
            sentAt,
          });
          alertSummary = {
            ...alertSummary,
            status: "sent",
            pending: false,
            sentAt,
            lastError: null,
          };
          actions.alert = {
            attempted: false,
            reason: "incident_already_sent",
            incidentKey: alert.incidentKey,
          };
        } else if (!alert.incidentKey || !alert.text) {
          actions.alert = {
            attempted: false,
            reason: "invalid_alert",
            incidentKey: alert.incidentKey,
          };
        } else {
          const attempts = alert.attempts + 1;
          try {
            if (typeof dependencies.notifier?.sendTextMessage !== "function") {
              const missingNotifier = new Error("NapCat notifier 未提供 sendTextMessage");
              missingNotifier.code = "ALERT_NOTIFIER_MISSING";
              throw missingNotifier;
            }
            const sendResult = await dependencies.notifier.sendTextMessage({
              dedupe_key: alert.incidentKey,
              text: alert.text,
            });
            if (sendResult?.sent !== true) {
              const notSent = new Error(`告警发送未确认成功：${sendResult?.reason ?? "unknown"}`);
              notSent.code = "ALERT_NOT_SENT";
              throw notSent;
            }
            const sentAt = checkAt;
            writeAlertState(alert.raw, {
              status: "sent",
              pending: false,
              sent: true,
              incidentKey: alert.incidentKey,
              attempts,
              retryCount: attempts,
              lastAttemptAt: checkAt,
              lastError: null,
              sentAt,
            });
            sentIncidentKeys[alert.incidentKey] = sentAt;
            const limitedSentIncidentKeys = normalizeSentIncidentKeys(sentIncidentKeys);
            for (const key of Object.keys(sentIncidentKeys)) {
              if (!(key in limitedSentIncidentKeys)) delete sentIncidentKeys[key];
            }
            alertSummary = {
              ...alertSummary,
              status: "sent",
              pending: false,
              attempts,
              retryCount: attempts,
              lastAttemptAt: checkAt,
              sentAt,
              lastError: null,
              sentIncidentKeys: { ...sentIncidentKeys },
            };
            actions.alert = {
              attempted: true,
              succeeded: true,
              incidentKey: alert.incidentKey,
              attempts,
            };
          } catch (error) {
            const errorValue = publicError(error, "ALERT_SEND_FAILED");
            try {
              writeAlertState(alert.raw, {
                status: "pending",
                pending: true,
                sent: false,
                incidentKey: alert.incidentKey,
                attempts,
                retryCount: attempts,
                lastAttemptAt: checkAt,
                lastError: errorValue,
              });
            } catch (stateError) {
              errors.push({ source: "alert_state", error: publicError(stateError, "ALERT_STATE_WRITE_FAILED") });
            }
            alertSummary = {
              ...alertSummary,
              status: "pending",
              pending: true,
              attempts,
              retryCount: attempts,
              lastAttemptAt: checkAt,
              lastError: errorValue,
              sentIncidentKeys: { ...sentIncidentKeys },
            };
            actions.alert = {
              attempted: true,
              succeeded: false,
              incidentKey: alert.incidentKey,
              attempts,
              error: errorValue,
            };
            errors.push({ source: "alert", error: errorValue });
          }
        }
      }

      const gate = Boolean(
        broker.known
        && broker.healthy
        && brokerProcess.known
        && brokerProcess.present
        && napcat.known
        && napcat.ready
        && napcatRuntime.known
        && napcatRuntime.ready
        && napcatProcess.known
        && napcatProcess.present
        && codexProcess.known
        && codexProcess.present
        && tasksKnown
        && (
          openTaskCount > 0
          || (() => {
            try {
              const control = dependencies.notifier.getControlPlaneConfig();
              return control.enabled === true && control.machineIngressEnabled === true;
            } catch {
              return false;
            }
          })()
        )
        && !maintenanceBlocksRouter,
      );
      let finalRouter = router;
      if (gate && router.known && !router.alive) {
        try {
          const result = await startRouter({
            registryPath,
            bindingPath,
            runtimeStatePath,
            openTaskCount,
            hidden: true,
          });
          actions.taskRouter = { attempted: true, succeeded: true, result: result && typeof result === "object" ? {
            started: result.started ?? null,
            reason: result.reason ?? null,
            pid: result.pid ?? null,
          } : null };
          if (dependencies.routerController && typeof dependencies.routerController.status === "function") {
            finalRouter = normalizeRouterStatus(dependencies.routerController.status());
          }
        } catch (error) {
          const value = actionError(error);
          actions.taskRouter = { attempted: true, succeeded: false, error: value };
          errors.push({ source: "task_router_start", error: value });
        }
      } else if (!gate) {
        actions.taskRouter = {
          attempted: false,
          reason: maintenanceBlocksRouter ? "maintenance_active" : "gate_closed",
        };
      } else {
        actions.taskRouter = { attempted: false, reason: "already_running" };
      }

      const checkSummary = {
        broker: summarizeCheck(broker),
        napcat: summarizeCheck(napcat),
        napcatRuntime: summarizeCheck(napcatRuntime),
        napcatProcess: summarizeCheck(napcatProcess),
        codexProcess: summarizeCheck(codexProcess),
        brokerProcess: summarizeCheck(brokerProcess),
        tasks: { known: tasksKnown, openTaskCount },
        router: summarizeCheck(finalRouter),
        maintenance: maintenanceSummary,
        alert: alertSummary,
        gate,
      };
      const cycleError = errors.length > 0
        ? { code: "SUPERVISOR_CHECK_FAILED", message: errors.map((item) => `${item.source}: ${item.error.message}`).join("; "), checks: errors }
        : null;
      status.login = {
        ...status.login,
        lastAttemptAt: loginLastAttemptAt,
        nextAllowedAt: loginNextAllowedAt,
      };
      status.brokerStart = {
        ...status.brokerStart,
        lastAttemptAt: brokerLastAttemptAt,
        nextAllowedAt: brokerNextAllowedAt,
      };
      persist({
        state: "running",
        lastCheckAt: checkAt,
        nextCheckAt: nextTimeIso(clock, scanIntervalMs),
        checks: checkSummary,
        actions,
        openTaskCount,
        maintenance: maintenanceSummary,
        alert: alertSummary,
        lastError: cycleError,
      });
      appendLog(logPath, {
        at: checkAt,
        type: "supervisor_check",
        pid,
        gate,
        openTaskCount,
        checks: checkSummary,
        actions,
        maintenance: maintenanceSummary,
        alert: alertSummary,
        error: cycleError ? { code: cycleError.code, message: cycleError.message } : null,
      }, fsImpl);

      if (options.once === true) {
        stopReason = "once_completed";
        break;
      }
      if (detectStop()) break;
      await (options.wait ?? waitForNextScan)(scanIntervalMs, {
        fsImpl,
        stopFilePath,
        pollMs: options.stopPollMs,
        now: clock,
        isStopRequested: () => stopRequested || fileExists(stopFilePath, fsImpl),
      });
    }

    if (!stopReason) stopReason = "stop_requested";
    const stoppedAt = nowIso(clock);
    persist({ state: "stopped", nextCheckAt: null, stoppedAt, stopReason });
    appendLog(logPath, { at: stoppedAt, type: "supervisor_stopped", pid, stopReason }, fsImpl);
    return { ...status, cycleCount, stopReason };
  } catch (error) {
    const errorValue = publicError(error, "SUPERVISOR_RUNNER_FAILED");
    const failedAt = nowIso(clock);
    try {
      persist({ state: "failed", nextCheckAt: null, failedAt, lastError: errorValue });
    } catch {
      status = { ...status, state: "failed", nextCheckAt: null, failedAt, lastError: errorValue };
    }
    appendLog(logPath, { at: failedAt, type: "supervisor_failed", pid, error: errorValue }, fsImpl);
    return { ...status, cycleCount, error: errorValue };
  } finally {
    signalCleanup();
    lock.release();
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseArguments(argv);
  return runSupervisorService({ ...parsed, ...dependencies });
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  main().then((result) => {
    if (result.state === "failed") process.exitCode = 1;
  }).catch((error) => {
    console.error(`[supervisor-runner] ${error?.message || String(error)}`);
    process.exitCode = 1;
  });
}

export {
  acquireInstanceLock,
  readPrivateEnvironment,
  runSupervisorService as runSupervisor,
  runSupervisorService as runSupervisorRunner,
};
