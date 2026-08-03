import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const DEFAULT_START_TIMEOUT_MS = 12000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1500;
const DEFAULT_PROXY_RECONCILE_TIMEOUT_MS = 45000;
const DEFAULT_PROXY_RECONCILE_POLL_MS = 250;
const MAX_STDERR_CHARACTERS = 12000;

const BUSY_PROTOCOL_STATUSES = new Set([
  "active",
  "inprogress",
  "pending",
  "queued",
  "running",
  "starting",
  "streaming",
  "working",
]);

const IDLE_PROTOCOL_STATUSES = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "completed",
  "done",
  "failed",
  "idle",
  "interrupted",
  "stopped",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function requiredString(value, name, maximum = 100000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new CodexThreadBridgeError("INVALID_ARGUMENT", `${name} 不能为空`);
  }
  if (normalized.length > maximum) {
    throw new CodexThreadBridgeError("INVALID_ARGUMENT", `${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function optionalString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readWakeMessageVisibility(bindingPath, fsImpl = fs) {
  if (!bindingPath) return "visible";
  let binding;
  try {
    binding = JSON.parse(fsImpl.readFileSync(bindingPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (cause) {
    throw new CodexThreadBridgeError(
      "BINDING_READ_FAILED",
      `无法读取 NapCat binding：${bindingPath}`,
      { cause },
    );
  }
  const visibility = optionalString(binding.codexWakeMessageVisibility, "visible").toLowerCase();
  if (!["visible", "hidden"].includes(visibility)) {
    throw new CodexThreadBridgeError(
      "BINDING_INVALID",
      "codexWakeMessageVisibility 只支持 visible 或 hidden",
      { details: { bindingPath, visibility } },
    );
  }
  return visibility;
}

function normalizeProtocolStatus(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function bridgeStatusFromProtocolStatus(value) {
  const normalized = normalizeProtocolStatus(value);
  if (!normalized) return null;
  if (normalized.includes("notfound") || normalized === "missing" || normalized === "deleted") {
    return "not_found";
  }
  if (BUSY_PROTOCOL_STATUSES.has(normalized)) return "busy";
  if (IDLE_PROTOCOL_STATUSES.has(normalized)) return "idle";
  return null;
}

function collectProtocolStatuses(value, statuses = [], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return statuses;
  if (Array.isArray(value)) {
    for (const item of value) collectProtocolStatuses(item, statuses, depth + 1);
    return statuses;
  }
  if (!isObject(value)) return statuses;
  for (const [key, item] of Object.entries(value)) {
    if (key === "status" || key === "state" || key === "turnStatus") {
      const status = bridgeStatusFromProtocolStatus(item);
      if (status) statuses.push(status);
    }
    if (isObject(item) || Array.isArray(item)) {
      collectProtocolStatuses(item, statuses, depth + 1);
    }
  }
  return statuses;
}

function threadExistsInPayload(value, threadId, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.some((item) => threadExistsInPayload(item, threadId, depth + 1));
  }
  if (!isObject(value)) return false;
  if (String(value.id ?? value.threadId ?? "") === threadId) return true;
  return Object.values(value).some((item) => threadExistsInPayload(item, threadId, depth + 1));
}

function extractThread(value, threadId, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const thread = extractThread(item, threadId, depth + 1);
      if (thread) return thread;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if ((value.id === threadId || value.threadId === threadId) && ("status" in value || "turns" in value || "preview" in value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    const thread = extractThread(item, threadId, depth + 1);
    if (thread) return thread;
  }
  return null;
}

function extractTurn(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const turn = extractTurn(item, depth + 1);
      if (turn) return turn;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (("id" in value || "turnId" in value) && ("status" in value || "state" in value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    const turn = extractTurn(item, depth + 1);
    if (turn) return turn;
  }
  return null;
}

function responseIndicatesNotFound(value) {
  if (value === null) return true;
  if (!isObject(value)) return false;
  if (value.found === false || value.thread === null) return true;
  return bridgeStatusFromProtocolStatus(value.status ?? value.state) === "not_found";
}

function interpretThreadResponse(threadId, response, source) {
  let status = "unknown";
  if (responseIndicatesNotFound(response)) {
    status = "not_found";
  } else {
    const statuses = collectProtocolStatuses(response);
    if (statuses.includes("not_found")) {
      status = "not_found";
    } else if (statuses.includes("busy")) {
      status = "busy";
    } else if (statuses.includes("idle")) {
      status = "idle";
    } else if (threadExistsInPayload(response, threadId)) {
      status = "unknown";
    }
  }
  return {
    threadId,
    status,
    busy: status === "busy",
    found: status === "idle" || status === "busy",
    source,
    thread: extractThread(response, threadId),
    raw: response,
  };
}

function errorSummary(error) {
  return {
    code: error?.code || "UNEXPECTED_ERROR",
    message: error?.message || String(error),
    outcomeUnknown: Boolean(error?.outcomeUnknown),
    details: error?.details ?? null,
  };
}

function isNotFoundRpcError(error) {
  if (!(error instanceof CodexThreadBridgeError) || error.code !== "APP_SERVER_RPC_ERROR") {
    return false;
  }
  const rpcError = error.details?.rpcError;
  const text = `${rpcError?.message ?? ""} ${rpcError?.code ?? ""}`.toLowerCase();
  return /not[ _-]?found|unknown[ _-]?thread|thread.+does not exist|missing/.test(text);
}

function isFile(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeExecutablePath(value, env) {
  if (!value) return "";
  const expanded = String(value).replace(/%([^%]+)%/g, (match, key) => env[key] ?? match);
  return path.resolve(expanded);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return Promise.race([
    new Promise((resolve) => {
      child.once("exit", resolve);
      child.once("error", resolve);
    }),
    wait(timeoutMs),
  ]);
}

export class CodexThreadBridgeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodexThreadBridgeError";
    this.code = code;
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
    this.details = options.details ?? null;
  }
}

function findDesktopCodexCandidates(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const env = options.env ?? process.env;
  const localAppData = options.localAppData ?? env.LOCALAPPDATA;
  if (!localAppData) return [];
  const binDirectory = path.join(localAppData, "OpenAI", "Codex", "bin");
  let entries;
  try {
    entries = fsImpl.readdirSync(binDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [path.join(binDirectory, "codex.exe")];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push(path.join(binDirectory, entry.name, "codex.exe"));
    }
  }
  return [...new Set(candidates)]
    .filter((candidate) => isFile(candidate, fsImpl))
    .map((candidate) => {
      let modifiedAt = 0;
      try {
        modifiedAt = fsImpl.statSync(candidate).mtimeMs;
      } catch {
        modifiedAt = 0;
      }
      return { candidate, modifiedAt };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.candidate.localeCompare(left.candidate))
    .map(({ candidate }) => candidate);
}

function resolveCodexAppServerExecutable(options) {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const explicitPath = normalizeExecutablePath(options.executablePath ?? env.CODEX_APP_SERVER_EXE, env);
  if (explicitPath) {
    if (!isFile(explicitPath, fsImpl)) {
      throw new CodexThreadBridgeError(
        "CODEX_APP_SERVER_NOT_FOUND",
        `显式 Codex 可执行文件不存在：${explicitPath}`,
        { details: { executablePath: explicitPath } },
      );
    }
    return explicitPath;
  }
  const candidates = findDesktopCodexCandidates({ ...options, env, fsImpl });
  if (!candidates.length) {
    throw new CodexThreadBridgeError(
      "CODEX_APP_SERVER_NOT_FOUND",
      "未在 %LOCALAPPDATA%\\OpenAI\\Codex\\bin 下找到 Codex 桌面版可执行文件",
      { details: { localAppData: env.LOCALAPPDATA ?? null } },
    );
  }
  return candidates[0];
}

class CodexThreadBridge {
  constructor(options = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 250, 300000);
    this.reconcileTimeoutMs = positiveInteger(
      options.reconcileTimeoutMs ?? this.env.CODEX_APP_SERVER_PROXY_RECONCILE_TIMEOUT_MS,
      DEFAULT_PROXY_RECONCILE_TIMEOUT_MS,
      1000,
      300000,
    );
    this.reconcilePollMs = positiveInteger(
      options.reconcilePollMs ?? this.env.CODEX_APP_SERVER_PROXY_RECONCILE_POLL_MS,
      DEFAULT_PROXY_RECONCILE_POLL_MS,
      25,
      10000,
    );
    this.startTimeoutMs = positiveInteger(options.startTimeoutMs, this.requestTimeoutMs, 250, 300000);
    this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 50, 30000);
    this.clientInfo = {
      name: optionalString(options.clientName, "napcat-mcp-codex-thread-bridge"),
      version: optionalString(options.clientVersion, "1.0.0"),
    };
    this.clientCapabilities = isObject(options.clientCapabilities) ? options.clientCapabilities : {};
    this.appServerArgs = Array.isArray(options.appServerArgs) && options.appServerArgs.length
      ? options.appServerArgs.map(String)
      : ["app-server", "--stdio"];
    this.makeResumeParams = typeof options.makeResumeParams === "function"
      ? options.makeResumeParams
      : (threadId) => ({ threadId });
    this.makeTurnStartParams = typeof options.makeTurnStartParams === "function"
      ? options.makeTurnStartParams
      : ({ threadId, prompt }) => ({
        threadId,
        input: [{ type: "text", text: prompt }],
      });
    this.onNotification = typeof options.onNotification === "function" ? options.onNotification : null;
    this.onStderr = typeof options.onStderr === "function" ? options.onStderr : null;
    this.child = null;
    this.executablePath = null;
    this.initialized = false;
    this.closed = false;
    this.startPromise = null;
    this.closePromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.threadStates = new Map();
    this.stdoutBuffer = "";
    this.stderr = "";
    this.lastExit = null;
    this.lastProcessError = null;
  }

  async inspectThread(threadId) {
    const normalizedThreadId = requiredString(threadId, "threadId", 256);
    try {
      await this.#ensureStarted();
      const response = await this.#request(
        "thread/resume",
        this.makeResumeParams(normalizedThreadId),
        { threadId: normalizedThreadId },
      );
      return this.#cacheThreadState(interpretThreadResponse(normalizedThreadId, response, "thread/resume"));
    } catch (error) {
      if (isNotFoundRpcError(error)) {
        return this.#cacheThreadState({
          threadId: normalizedThreadId,
          status: "not_found",
          busy: false,
          found: false,
          source: "thread/resume",
          thread: null,
          raw: error.details?.rpcError ?? null,
        });
      }
      throw error;
    }
  }

  async wake(input) {
    if (!isObject(input)) {
      throw new CodexThreadBridgeError("INVALID_ARGUMENT", "wake 必须接收 { threadId, prompt }");
    }
    const threadId = requiredString(input.threadId, "threadId", 256);
    const prompt = requiredString(input.prompt, "prompt", 100000);
    const current = await this.inspectThread(threadId);
    if (current.status === "busy") {
      return {
        threadId,
        status: "busy",
        outcome: "busy",
        started: false,
        thread: current.thread,
      };
    }
    if (current.status !== "idle") {
      return {
        threadId,
        status: current.status,
        outcome: "unknown",
        started: null,
        reason: current.status === "not_found" ? "thread_not_found" : "thread_state_unknown",
        thread: current.thread,
      };
    }
    try {
      const response = await this.#request(
        "turn/start",
        this.makeTurnStartParams({ threadId, prompt }),
        { mutating: true, threadId },
      );
      const interpreted = interpretThreadResponse(threadId, response, "turn/start");
      const status = interpreted.status === "idle" ? "idle" : "busy";
      const snapshot = this.#cacheThreadState({
        ...interpreted,
        status,
        busy: status === "busy",
        found: true,
      });
      return {
        threadId,
        status: snapshot.status,
        outcome: snapshot.status === "idle" ? "completed" : "accepted",
        started: true,
        turn: extractTurn(response),
        raw: response,
      };
    } catch (error) {
      if (error?.outcomeUnknown) {
        this.#cacheThreadState({
          threadId,
          status: "unknown",
          busy: null,
          found: null,
          source: "turn/start",
          thread: current.thread,
          raw: null,
        });
        return {
          threadId,
          status: "unknown",
          outcome: "unknown",
          started: null,
          error: errorSummary(error),
        };
      }
      throw error;
    }
  }

  status() {
    return {
      closed: this.closed,
      initialized: this.initialized,
      running: Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null),
      executablePath: this.executablePath,
      pid: this.child?.pid ?? null,
      pendingRequestCount: this.pending.size,
      stderr: this.stderr || null,
      lastExit: this.lastExit,
      lastProcessError: this.lastProcessError,
      threads: [...this.threadStates.values()].map((state) => ({
        threadId: state.threadId,
        status: state.status,
        busy: state.busy,
        found: state.found,
        source: state.source,
      })),
    };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.initialized = false;
    const child = this.child;
    this.child = null;
    const error = new CodexThreadBridgeError("BRIDGE_CLOSED", "Codex 线程桥已关闭");
    this.#rejectAllPending(error, (pending) => pending.mutating && pending.written);
    this.closePromise = this.#terminateChild(child).then(() => ({ closed: true }));
    return this.closePromise;
  }

  async #ensureStarted() {
    if (this.closed) {
      throw new CodexThreadBridgeError("BRIDGE_CLOSED", "Codex 线程桥已关闭");
    }
    if (this.initialized && this.child) return;
    if (!this.startPromise) {
      this.startPromise = this.#start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  async #start() {
    let child;
    try {
      const executablePath = resolveCodexAppServerExecutable({
        ...this.options,
        env: this.env,
        spawnImpl: this.spawnImpl,
      });
      if (this.closed) {
        throw new CodexThreadBridgeError("BRIDGE_CLOSED", "Codex 线程桥已关闭");
      }
      child = this.spawnImpl(executablePath, this.appServerArgs, {
        cwd: this.options.cwd,
        env: this.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child?.stdin || !child?.stdout || !child?.stderr) {
        throw new CodexThreadBridgeError("APP_SERVER_SPAWN_FAILED", "无法取得 app-server 的 stdio 管道");
      }
      this.child = child;
      this.executablePath = executablePath;
      this.#attachChild(child);
      await this.#request(
        "initialize",
        {
          clientInfo: this.clientInfo,
          capabilities: this.clientCapabilities,
        },
        { timeoutMs: this.startTimeoutMs },
      );
      this.#notify("initialized", {});
      this.initialized = true;
    } catch (error) {
      this.initialized = false;
      if (this.child === child) this.child = null;
      await this.#terminateChild(child);
      if (error instanceof CodexThreadBridgeError) throw error;
      throw new CodexThreadBridgeError(
        "APP_SERVER_SPAWN_FAILED",
        `无法启动 Codex app-server：${error?.message || String(error)}`,
        { cause: error },
      );
    }
  }

  #attachChild(child) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#handleStdout(child, chunk));
    child.stderr.on("data", (chunk) => this.#appendStderr(chunk));
    child.stdin.on("error", (error) => this.#handleProcessError(child, error));
    child.on("error", (error) => this.#handleProcessError(child, error));
    child.on("exit", (code, signal) => this.#handleExit(child, code, signal));
  }

  #handleStdout(child, chunk) {
    if (child !== this.child) return;
    this.stdoutBuffer += String(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#appendStderr(`app-server stdout 不是 JSONL：${line.slice(0, 1000)}\n`);
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (!isObject(message)) return;
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (isObject(message.error)) {
        pending.reject(new CodexThreadBridgeError(
          "APP_SERVER_RPC_ERROR",
          message.error.message || `app-server 请求失败：${pending.method}`,
          {
            details: {
              method: pending.method,
              requestId: pending.id,
              rpcError: message.error,
              stderr: this.stderr || null,
            },
          },
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      this.#handleNotification(message);
    }
  }

  #handleNotification(message) {
    const params = isObject(message.params) ? message.params : {};
    const threadId = optionalString(params.threadId ?? params.thread_id ?? params.thread?.id);
    let snapshot = null;
    if (threadId) {
      let status = null;
      const method = message.method.toLowerCase();
      if (/not[ _/-]?found|deleted/.test(method)) status = "not_found";
      else if (/completed|failed|cancelled|canceled|stopped|interrupted/.test(method)) status = "idle";
      else if (/started|running|streaming|updated/.test(method)) status = "busy";
      if (!status) status = interpretThreadResponse(threadId, params, message.method).status;
      snapshot = this.#cacheThreadState({
        threadId,
        status,
        busy: status === "busy",
        found: status === "idle" || status === "busy",
        source: message.method,
        thread: extractThread(params, threadId),
        raw: params,
      });
    }
    try {
      this.onNotification?.(message, snapshot);
    } catch (error) {
      this.#appendStderr(`onNotification 回调失败：${error?.message || String(error)}\n`);
    }
  }

  #appendStderr(chunk) {
    const text = String(chunk);
    this.stderr = `${this.stderr}${text}`.slice(-MAX_STDERR_CHARACTERS);
    try {
      this.onStderr?.(text);
    } catch {
    }
  }

  #handleProcessError(child, cause) {
    if (child !== this.child) return;
    this.lastProcessError = {
      code: cause?.code ?? null,
      message: cause?.message || String(cause),
    };
    this.#rejectAllPending(new CodexThreadBridgeError(
      "APP_SERVER_IO_ERROR",
      `Codex app-server 的 stdio 连接失败：${this.lastProcessError.message}`,
      { cause, details: { stderr: this.stderr || null } },
    ), (pending) => pending.mutating && pending.written);
  }

  #handleExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null;
    this.initialized = false;
    this.lastExit = { code, signal };
    this.#rejectAllPending(new CodexThreadBridgeError(
      "APP_SERVER_EXIT",
      `Codex app-server 已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`,
      { details: { code, signal, stderr: this.stderr || null } },
    ), (pending) => pending.mutating && pending.written);
  }

  #request(method, params, options = {}) {
    if (this.closed) {
      return Promise.reject(new CodexThreadBridgeError("BRIDGE_CLOSED", "Codex 线程桥已关闭"));
    }
    const child = this.child;
    if (!child?.stdin || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new CodexThreadBridgeError("APP_SERVER_NOT_RUNNING", "Codex app-server 尚未运行"));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = positiveInteger(options.timeoutMs, this.requestTimeoutMs, 250, 300000);
    return new Promise((resolve, reject) => {
      const pending = {
        id,
        method,
        mutating: Boolean(options.mutating),
        threadId: options.threadId ?? null,
        written: false,
        resolve,
        reject,
        timeout: null,
      };
      pending.timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const outcomeUnknown = pending.mutating && pending.written;
        if (outcomeUnknown && pending.threadId) this.#markThreadUnknown(pending.threadId, method);
        reject(new CodexThreadBridgeError(
          "APP_SERVER_TIMEOUT",
          `Codex app-server 在 ${timeoutMs}ms 内未响应：${method}`,
          {
            outcomeUnknown,
            details: {
              method,
              requestId: id,
              timeoutMs,
              stderr: this.stderr || null,
            },
          },
        ));
      }, timeoutMs);
      this.pending.set(id, pending);
      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
      try {
        child.stdin.write(payload, "utf8");
        pending.written = true;
      } catch (cause) {
        if (!this.pending.delete(id)) return;
        clearTimeout(pending.timeout);
        if (pending.mutating && pending.threadId) this.#markThreadUnknown(pending.threadId, method);
        reject(new CodexThreadBridgeError(
          "APP_SERVER_WRITE_FAILED",
          `无法向 Codex app-server 写入请求：${method}`,
          {
            cause,
            outcomeUnknown: pending.mutating,
            details: { method, requestId: id, stderr: this.stderr || null },
          },
        ));
      }
    });
  }

  #notify(method, params) {
    const child = this.child;
    if (!child?.stdin || child.exitCode !== null || child.signalCode !== null) {
      throw new CodexThreadBridgeError("APP_SERVER_NOT_RUNNING", "Codex app-server 尚未运行");
    }
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
    } catch (cause) {
      throw new CodexThreadBridgeError(
        "APP_SERVER_WRITE_FAILED",
        `无法向 Codex app-server 写入通知：${method}`,
        { cause, details: { method, stderr: this.stderr || null } },
      );
    }
  }

  #cacheThreadState(state) {
    const snapshot = {
      ...state,
      busy: state.status === "busy" ? true : state.status === "unknown" ? null : false,
      found: state.status === "idle" || state.status === "busy" ? true : state.status === "unknown" ? null : false,
    };
    this.threadStates.set(snapshot.threadId, snapshot);
    return snapshot;
  }

  #markThreadUnknown(threadId, source) {
    const current = this.threadStates.get(threadId);
    this.#cacheThreadState({
      threadId,
      status: "unknown",
      busy: null,
      found: null,
      source,
      thread: current?.thread ?? null,
      raw: null,
    });
  }

  #rejectAllPending(error, isOutcomeUnknown) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      const outcomeUnknown = Boolean(isOutcomeUnknown(pending));
      if (outcomeUnknown && pending.threadId) this.#markThreadUnknown(pending.threadId, pending.method);
      pending.reject(new CodexThreadBridgeError(error.code, error.message, {
        cause: error.cause,
        outcomeUnknown,
        details: {
          ...(error.details ?? {}),
          method: pending.method,
          requestId: pending.id,
        },
      }));
    }
    this.pending.clear();
  }

  async #terminateChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
    } catch {
    }
    await waitForExit(child, this.closeTimeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill();
    } catch {
    }
    await waitForExit(child, this.closeTimeoutMs);
  }
}

class CodexProxyThreadBridge {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.fsImpl = options.fsImpl ?? fs;
    this.bindingPath = optionalString(
      options.bindingPath ?? this.env.NAPCAT_MCP_BINDING_PATH,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.controlUrl = optionalString(
      options.controlUrl ?? this.env.CODEX_APP_SERVER_PROXY_CONTROL_URL,
      "http://127.0.0.1:18431",
    ).replace(/\/$/, "");
    this.controlToken = optionalString(options.controlToken ?? this.env.CODEX_APP_SERVER_PROXY_TOKEN);
    const tokenFilePath = optionalString(options.tokenFilePath ?? this.env.CODEX_APP_SERVER_PROXY_TOKEN_FILE);
    if (!this.controlToken && tokenFilePath) {
      try {
        this.controlToken = fs.readFileSync(tokenFilePath, "utf8").trim();
      } catch (cause) {
        throw new CodexThreadBridgeError(
          "PROXY_TOKEN_READ_FAILED",
          `无法读取 Codex 代理控制口令：${tokenFilePath}`,
          { cause },
        );
      }
    }
    if (!this.controlToken) {
      throw new CodexThreadBridgeError("PROXY_TOKEN_MISSING", "Codex 代理控制口令未配置");
    }
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 250, 300000);
    this.reconcileTimeoutMs = positiveInteger(
      options.reconcileTimeoutMs ?? this.env.CODEX_APP_SERVER_PROXY_RECONCILE_TIMEOUT_MS,
      DEFAULT_PROXY_RECONCILE_TIMEOUT_MS,
      250,
      300000,
    );
    this.reconcilePollMs = positiveInteger(
      options.reconcilePollMs ?? this.env.CODEX_APP_SERVER_PROXY_RECONCILE_POLL_MS,
      DEFAULT_PROXY_RECONCILE_POLL_MS,
      10,
      5000,
    );
    this.closed = false;
    this.lastStatus = null;
    this.lastError = null;
  }

  async inspectThread(threadId) {
    const normalizedThreadId = requiredString(threadId, "threadId", 256);
    const response = await this.#request("/subscribe", { threadId: normalizedThreadId });
    return {
      threadId: normalizedThreadId,
      status: "unknown",
      busy: null,
      found: true,
      source: "proxy/thread/resume",
      raw: response,
    };
  }

  async wake(input) {
    if (!isObject(input)) {
      throw new CodexThreadBridgeError("INVALID_ARGUMENT", "wake 必须接收 { threadId, prompt, wakeId }");
    }
    const threadId = requiredString(input.threadId, "threadId", 256);
    const prompt = requiredString(input.prompt, "prompt", 100000);
    const wakeId = requiredString(input.wakeId, "wakeId", 256);
    const taskId = requiredString(input.taskId, "taskId", 128);
    const generation = positiveInteger(input.generation, 0, 1, Number.MAX_SAFE_INTEGER);
    const messageVisibility = readWakeMessageVisibility(this.bindingPath, this.fsImpl);
    const subscription = {
      taskId,
      generation,
      threadId,
      localRole: requiredString(input.localRole, "localRole", 128),
      sourceMachine: requiredString(input.sourceMachine, "sourceMachine", 128),
      targetMachine: requiredString(input.targetMachine, "targetMachine", 128),
      trustedPeerQq: requiredString(input.trustedPeerQq, "trustedPeerQq", 64),
    };
    try {
      await this.#request("/v1/subscriptions", subscription);
      const response = await this.#request("/v1/wakes", {
        ...subscription,
        prompt,
        wakeId,
        pendingThroughSequence: input.pendingThroughSequence,
        pendingThroughTime: input.pendingThroughTime,
        promptSha256: input.promptSha256,
        messageVisibility,
      }, { mutating: true });
      return {
        threadId,
        status: response.outcome === "completed" ? "idle" : response.outcome === "accepted" ? "busy" : "unknown",
        outcome: response.outcome ?? "unknown",
        started: response.started ?? null,
        duplicateSuppressed: Boolean(response.duplicateSuppressed),
        recovered: Boolean(response.recovered),
        turn: response.turn ?? null,
        raw: response,
        ...(response.error ? { error: response.error } : {}),
      };
    } catch (error) {
      if (error?.outcomeUnknown) {
        const reconciled = await this.#reconcileWake(wakeId);
        if (reconciled !== null) return reconciled;
        return {
          threadId,
          status: "unknown",
          outcome: "unknown",
          started: null,
          error: errorSummary(error),
        };
      }
      throw error;
    }
  }

  status() {
    return {
      closed: this.closed,
      mode: "transparent_proxy",
      controlUrl: this.controlUrl,
      bindingPath: this.bindingPath || null,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
    };
  }

  async close() {
    this.closed = true;
    return { closed: true };
  }

  async #request(route, body, options = {}) {
    if (this.closed) throw new CodexThreadBridgeError("BRIDGE_CLOSED", "Codex 线程桥已关闭");
    const controller = new AbortController();
    const requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      this.requestTimeoutMs,
      250,
      300000,
    );
    const method = options.method ?? "POST";
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.controlUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.controlToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      this.lastStatus = { at: new Date().toISOString(), route, status: response.status };
      if (!response.ok || payload.ok === false) {
        const remoteError = payload.error ?? {};
        throw new CodexThreadBridgeError(
          remoteError.code ?? "PROXY_REQUEST_FAILED",
          remoteError.message ?? `Codex 代理请求失败：HTTP ${response.status}`,
          {
            outcomeUnknown: Boolean(remoteError.outcomeUnknown),
            details: { route, status: response.status, remoteError },
          },
        );
      }
      this.lastError = null;
      return payload;
    } catch (cause) {
      const error = cause instanceof CodexThreadBridgeError
        ? cause
        : new CodexThreadBridgeError(
          cause?.name === "AbortError" ? "PROXY_TIMEOUT" : "PROXY_UNREACHABLE",
          cause?.name === "AbortError"
            ? `Codex 代理在 ${requestTimeoutMs}ms 内未响应`
            : `无法连接 Codex 代理：${cause?.message ?? String(cause)}`,
          { cause, outcomeUnknown: Boolean(options.mutating), details: { route } },
        );
      this.lastError = errorSummary(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #reconcileWake(wakeId) {
    const deadline = Date.now() + this.reconcileTimeoutMs;
    while (Date.now() < deadline) {
      let wake = null;
      try {
        const remainingMs = Math.max(250, deadline - Date.now());
        const payload = await this.#request(
          `/v1/wakes/${encodeURIComponent(wakeId)}`,
          null,
          { method: "GET", requestTimeoutMs: Math.min(this.requestTimeoutMs, remainingMs) },
        );
        wake = payload?.wake ?? null;
      } catch {
      }
      if (wake) {
        if (["accepted", "completed", "recovered"].includes(wake.status)) {
          const outcome = wake.status === "completed" ? "completed" : "accepted";
          return {
            threadId: wake.threadId,
            status: outcome === "completed" ? "idle" : "busy",
            outcome,
            started: true,
            duplicateSuppressed: true,
            recovered: true,
            turn: wake.turnId ? { id: wake.turnId, status: wake.turnStatus ?? null } : null,
            raw: { wake },
          };
        }
        if (wake.status === "failed_before_send") {
          throw new CodexThreadBridgeError(
            wake.error?.code ?? "PROXY_WAKE_FAILED_BEFORE_SEND",
            wake.error?.message ?? `Codex 唤醒在发送前失败：${wakeId}`,
            { outcomeUnknown: false, details: { wake } },
          );
        }
        if (wake.status === "unknown") {
          return {
            threadId: wake.threadId,
            status: "unknown",
            outcome: "unknown",
            started: null,
            error: wake.error ?? {
              code: "PROXY_WAKE_OUTCOME_UNKNOWN",
              message: `Codex 唤醒结果未知：${wakeId}`,
              outcomeUnknown: true,
            },
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, this.reconcilePollMs));
    }
    return null;
  }
}

export function createCodexThreadBridge(options = {}) {
  const env = options.env ?? process.env;
  const proxyEnabled = options.mode === "transparent_proxy"
    || optionalString(options.controlUrl ?? env.CODEX_APP_SERVER_PROXY_CONTROL_URL) !== "";
  if (proxyEnabled) return new CodexProxyThreadBridge(options);
  return new CodexThreadBridge(options);
}
