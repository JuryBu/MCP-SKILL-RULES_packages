import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RESUME_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, name, maximum = 100000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new CodexAppServerProxyError("INVALID_ARGUMENT", `${name} 不能为空`);
  if (normalized.length > maximum) {
    throw new CodexAppServerProxyError("INVALID_ARGUMENT", `${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function parseJsonMessage(data) {
  try {
    return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  } catch {
    return null;
  }
}

function recursiveContainsString(value, expected, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.includes(expected);
  if (Array.isArray(value)) return value.some((item) => recursiveContainsString(item, expected, depth + 1));
  if (!isObject(value)) return false;
  return Object.values(value).some((item) => recursiveContainsString(item, expected, depth + 1));
}

function responseTurn(response) {
  if (!isObject(response)) return null;
  if (isObject(response.turn)) return response.turn;
  if (isObject(response.result?.turn)) return response.result.turn;
  return null;
}

function normalizeWakeMessageVisibility(value) {
  const visibility = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "visible";
  if (!["visible", "hidden"].includes(visibility)) {
    throw new CodexAppServerProxyError(
      "INVALID_ARGUMENT",
      "messageVisibility 只支持 visible 或 hidden",
    );
  }
  return visibility;
}

function normalizeTurnStatus(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

const ACTIVE_TURN_STATUSES = new Set([
  "active",
  "inprogress",
  "pending",
  "queued",
  "running",
  "starting",
  "streaming",
  "working",
]);

function resumeResultIndicatesBusy(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => resumeResultIndicatesBusy(item, depth + 1));
  if (!isObject(value)) return false;
  const status = normalizeTurnStatus(value.status ?? value.state);
  if (ACTIVE_TURN_STATUSES.has(status)) return true;
  if (Array.isArray(value.turns) && value.turns.some((turn) => ACTIVE_TURN_STATUSES.has(normalizeTurnStatus(turn?.status ?? turn?.state)))) {
    return true;
  }
  return Object.values(value).some((child) => resumeResultIndicatesBusy(child, depth + 1));
}

function activeTurnFromResumeResult(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const active = activeTurnFromResumeResult(value[index], depth + 1);
      if (active) return active;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (Array.isArray(value.turns)) {
    for (let index = value.turns.length - 1; index >= 0; index -= 1) {
      const turn = value.turns[index];
      const status = normalizeTurnStatus(turn?.status ?? turn?.state);
      if (
        isObject(turn)
        && typeof (turn.id ?? turn.turnId) === "string"
        && ACTIVE_TURN_STATUSES.has(status)
      ) return turn;
    }
  }
  for (const child of Object.values(value)) {
    const active = activeTurnFromResumeResult(child, depth + 1);
    if (active) return active;
  }
  return null;
}

function publicError(error) {
  return {
    code: error?.code ?? "UNEXPECTED_ERROR",
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

function readJournal(filePath, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    if (parsed?.schemaVersion === 2 && isObject(parsed.subscriptions) && isObject(parsed.wakes)) return parsed;
    if (parsed?.schemaVersion === 1 && isObject(parsed.wakes)) {
      return { schemaVersion: 2, subscriptions: {}, wakes: parsed.wakes };
    }
    throw new CodexAppServerProxyError("WAKE_JOURNAL_INVALID", `唤醒日志结构无效：${filePath}`);
  } catch (cause) {
    if (cause?.code === "ENOENT") return { schemaVersion: 2, subscriptions: {}, wakes: {} };
    if (cause instanceof CodexAppServerProxyError) throw cause;
    throw new CodexAppServerProxyError(
      "WAKE_JOURNAL_INVALID",
      `无法读取唤醒日志，已停止自动注入：${filePath}`,
      { cause },
    );
  }
}

function promptSha256(prompt) {
  return crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
}

const SUBSCRIPTION_FIELDS = [
  "taskId",
  "generation",
  "threadId",
  "localRole",
  "sourceMachine",
  "targetMachine",
  "trustedPeerQq",
];

function normalizeSubscription(input) {
  if (!isObject(input)) throw new CodexAppServerProxyError("INVALID_ARGUMENT", "subscription 必须接收对象");
  const generation = Number(input.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new CodexAppServerProxyError("INVALID_ARGUMENT", "generation 必须是正安全整数");
  }
  return {
    taskId: requiredString(input.taskId, "taskId", 128),
    generation,
    threadId: requiredString(input.threadId, "threadId", 256),
    localRole: requiredString(input.localRole, "localRole", 128),
    sourceMachine: requiredString(input.sourceMachine, "sourceMachine", 128),
    targetMachine: requiredString(input.targetMachine, "targetMachine", 128),
    trustedPeerQq: requiredString(input.trustedPeerQq, "trustedPeerQq", 64),
  };
}

function sameFields(left, right, fields) {
  return fields.every((field) => left?.[field] === right?.[field]);
}

export class CodexAppServerProxyError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodexAppServerProxyError";
    this.code = code;
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
    this.details = options.details ?? null;
  }
}

export function createWakeJournal(options = {}) {
  const filePath = requiredString(options.filePath, "filePath", 32768);
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());

  function getWake(wakeId) {
    const state = readJournal(filePath, fsImpl);
    return state.wakes[wakeId] ?? null;
  }

  function writeWake(wakeId, patch, expectedStatuses = null) {
    const state = readJournal(filePath, fsImpl);
    const current = state.wakes[wakeId] ?? {};
    if (expectedStatuses && !expectedStatuses.includes(current.status)) {
      throw new CodexAppServerProxyError(
        "WAKE_STATE_CONFLICT",
        `wakeId 状态已变化：${wakeId}`,
        { details: { wakeId, expectedStatuses, actualStatus: current.status ?? null } },
      );
    }
    const next = {
      ...current,
      ...patch,
      wakeId,
      createdAt: current.createdAt ?? now().toISOString(),
      updatedAt: now().toISOString(),
    };
    state.wakes[wakeId] = next;
    atomicWriteJson(filePath, state, fsImpl);
    return next;
  }

  function registerSubscription(input) {
    const subscription = normalizeSubscription(input);
    const state = readJournal(filePath, fsImpl);
    const existing = state.subscriptions[subscription.taskId] ?? null;
    if (existing && sameFields(existing, subscription, SUBSCRIPTION_FIELDS)) {
      return { subscription: existing, created: false, updated: false };
    }
    if (existing && subscription.generation > Number(existing.generation)) {
      const next = { ...subscription, createdAt: existing.createdAt, updatedAt: now().toISOString() };
      state.subscriptions[subscription.taskId] = next;
      atomicWriteJson(filePath, state, fsImpl);
      return { subscription: next, created: false, updated: true };
    }
    if (existing) {
      throw new CodexAppServerProxyError(
        "SUBSCRIPTION_CONFLICT",
        `taskId 已登记不同的 Codex 订阅：${subscription.taskId}`,
        { details: { existing, requested: subscription } },
      );
    }
    const nowIso = now().toISOString();
    const next = { ...subscription, createdAt: nowIso, updatedAt: nowIso };
    state.subscriptions[subscription.taskId] = next;
    atomicWriteJson(filePath, state, fsImpl);
    return { subscription: next, created: true, updated: false };
  }

  function claimWake(input) {
    const wakeId = requiredString(input.wakeId, "wakeId", 256);
    const state = readJournal(filePath, fsImpl);
    const existing = state.wakes[wakeId] ?? null;
    const messageVisibility = normalizeWakeMessageVisibility(input.messageVisibility);
    const identity = {
      wakeId,
      taskId: requiredString(input.taskId, "taskId", 128),
      generation: Number(input.generation),
      threadId: requiredString(input.threadId, "threadId", 256),
      promptSha256: requiredString(input.promptSha256, "promptSha256", 128),
      pendingThroughSequence: Number(input.pendingThroughSequence),
      pendingThroughTime: requiredString(input.pendingThroughTime, "pendingThroughTime", 128),
    };
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
      throw new CodexAppServerProxyError("INVALID_ARGUMENT", "generation 必须是正安全整数");
    }
    if (!Number.isSafeInteger(identity.pendingThroughSequence) || identity.pendingThroughSequence < 0) {
      throw new CodexAppServerProxyError("INVALID_ARGUMENT", "pendingThroughSequence 必须是非负安全整数");
    }
    const identityFields = [
      "taskId",
      "generation",
      "threadId",
      "promptSha256",
      "pendingThroughSequence",
      "pendingThroughTime",
    ];
    if (existing && !sameFields(existing, identity, identityFields)) {
      throw new CodexAppServerProxyError("WAKE_ID_CONFLICT", `wakeId 已被不同请求使用：${wakeId}`);
    }
    if (
      existing?.status !== "failed_before_send"
      && existing?.messageVisibility
      && existing.messageVisibility !== messageVisibility
    ) {
      throw new CodexAppServerProxyError("WAKE_ID_CONFLICT", `wakeId 已绑定不同的消息可见性：${wakeId}`);
    }
    if (existing && existing.status !== "failed_before_send") {
      return { wake: existing, acquired: false };
    }
    const nowIso = now().toISOString();
    const next = {
      ...(existing ?? {}),
      ...identity,
      messageVisibility,
      clientUserMessageId: messageVisibility === "visible"
        ? existing?.clientUserMessageId ?? crypto.randomUUID()
        : null,
      status: "prepared",
      attempt: Number(existing?.attempt ?? 0) + 1,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      error: null,
    };
    state.wakes[wakeId] = next;
    atomicWriteJson(filePath, state, fsImpl);
    return { wake: next, acquired: true };
  }

  function status() {
    const state = readJournal(filePath, fsImpl);
    return {
      schemaVersion: state.schemaVersion,
      subscriptionCount: Object.keys(state.subscriptions).length,
      wakeCount: Object.keys(state.wakes).length,
      unknownWakeCount: Object.values(state.wakes).filter((wake) => wake.status === "unknown").length,
    };
  }

  return {
    filePath,
    get: getWake,
    write: writeWake,
    getWake,
    writeWake,
    registerSubscription,
    claimWake,
    status,
  };
}

export class CodexAppServerProxy {
  constructor(options = {}) {
    this.downstreamHost = options.downstreamHost ?? "127.0.0.1";
    this.downstreamPort = boundedInteger(options.downstreamPort, 18432, 1, 65535);
    this.controlHost = options.controlHost ?? "127.0.0.1";
    this.controlPort = boundedInteger(options.controlPort, 18431, 1, 65535);
    this.upstreamUrl = requiredString(options.upstreamUrl ?? "ws://127.0.0.1:18433", "upstreamUrl", 2048);
    this.controlToken = requiredString(options.controlToken, "controlToken", 4096);
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 250, 300000);
    this.resumeRequestTimeoutMs = boundedInteger(
      options.resumeRequestTimeoutMs,
      DEFAULT_RESUME_REQUEST_TIMEOUT_MS,
      this.requestTimeoutMs,
      300000,
    );
    this.maxBodyBytes = boundedInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, 16 * 1024 * 1024);
    this.reconnectInitialMs = boundedInteger(options.reconnectInitialMs, 250, 50, 60000);
    this.reconnectMaxMs = boundedInteger(options.reconnectMaxMs, 5000, this.reconnectInitialMs, 300000);
    this.maxQueuedMessages = boundedInteger(options.maxQueuedMessages, 1000, 1, 10000);
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.WebSocketServerImpl = options.WebSocketServerImpl ?? WebSocketServer;
    this.journal = options.journal ?? null;
    this.maintenanceFilePath = options.maintenanceFilePath
      ? path.resolve(String(options.maintenanceFilePath))
      : null;
    this.writerEpoch = requiredString(options.writerEpoch ?? crypto.randomUUID(), "writerEpoch", 256);
    this.onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
    this.clients = new Set();
    this.nextInjectedRequestId = -1_000_000_000;
    this.websocketServer = null;
    this.controlServer = null;
    this.startedAt = null;
    this.closed = false;
    this.lastError = null;
  }

  async start() {
    if (this.websocketServer || this.controlServer) return this.status();
    this.closed = false;
    try {
      this.websocketServer = new this.WebSocketServerImpl({
        host: this.downstreamHost,
        port: this.downstreamPort,
      });
      this.websocketServer.on("connection", (socket) => this.#acceptDownstream(socket));
      this.websocketServer.on("error", (error) => this.#recordError("downstream_server", error));
      await this.#waitForListening(this.websocketServer, "WebSocket");

      this.controlServer = http.createServer((request, response) => {
        this.#handleControlRequest(request, response).catch((error) => {
          this.#recordError("control_request", error);
          if (!response.headersSent) response.setHeader("content-type", "application/json; charset=utf-8");
          response.statusCode = error?.code === "UNAUTHORIZED"
            ? 401
            : ["SUBSCRIPTION_CONFLICT", "WAKE_ID_CONFLICT", "WAKE_STATE_CONFLICT"].includes(error?.code)
              ? 409
              : error?.code === "AUTOMATION_PAUSED"
                ? 503
                : 500;
          response.end(JSON.stringify({ ok: false, error: publicError(error) }));
        });
      });
      this.controlServer.on("error", (error) => this.#recordError("control_server", error));
      await this.#listenHttp(this.controlServer, this.controlPort, this.controlHost);
      this.startedAt = new Date().toISOString();
      this.onEvent({ type: "proxy_started", status: this.status() });
      return this.status();
    } catch (error) {
      await Promise.all([
        this.#closeServer(this.websocketServer),
        this.#closeServer(this.controlServer),
      ]);
      this.websocketServer = null;
      this.controlServer = null;
      throw error;
    }
  }

  status() {
    const clients = [...this.clients].map((client) => ({
      initialized: client.initialized,
      downstreamState: client.downstream.readyState,
      upstreamState: client.upstream?.readyState ?? this.WebSocketImpl.CLOSED,
      upstreamReady: client.upstreamReady,
      pendingInjectionCount: client.injected.size,
      queuedMessageCount: client.queued.length,
      reconnectAttempt: client.reconnectAttempt,
      nextReconnectAt: client.nextReconnectAt,
      connectedAt: client.connectedAt,
    }));
    return {
      ok: true,
      startedAt: this.startedAt,
      closed: this.closed,
      downstreamUrl: `ws://${this.downstreamHost}:${this.downstreamPort}`,
      controlUrl: `http://${this.controlHost}:${this.controlPort}`,
      upstreamUrl: this.upstreamUrl,
      clientCount: clients.length,
      initializedClientCount: clients.filter((client) => client.initialized).length,
      readyClientCount: clients.filter((client) =>
      client.initialized
      && client.upstreamReady
      && client.downstreamState === this.WebSocketImpl.OPEN
        && client.upstreamState === this.WebSocketImpl.OPEN
      ).length,
      clients,
      writerEpoch: this.writerEpoch,
      maintenance: this.#maintenanceStatus(),
      journal: this.journal?.status?.() ?? null,
      lastError: this.lastError,
    };
  }

  async subscribeThread(threadId) {
    const normalizedThreadId = requiredString(threadId, "threadId", 256);
    const readyClients = this.#readyClients();
    if (!readyClients.length) {
      throw new CodexAppServerProxyError(
        "NO_DESKTOP_CLIENT",
        "没有已初始化且上下游均在线的 Codex Desktop 连接",
      );
    }
    const results = await Promise.all(
      readyClients.map((client) => this.#injectRequest(
        client,
        "thread/resume",
        { threadId: normalizedThreadId },
        { threadId: normalizedThreadId, timeoutMs: this.resumeRequestTimeoutMs },
      )),
    );
    return { threadId: normalizedThreadId, readyClients, results };
  }

  async subscribeTask(input) {
    if (!this.journal?.registerSubscription) {
      throw new CodexAppServerProxyError("WAKE_JOURNAL_REQUIRED", "任务订阅需要持久化唤醒日志");
    }
    const subscription = normalizeSubscription(input);
    const readyClients = this.#readyClients();
    if (!readyClients.length) {
      throw new CodexAppServerProxyError(
        "NO_DESKTOP_CLIENT",
        "没有已初始化且上下游均在线的 Codex Desktop 连接",
      );
    }
    const registration = this.journal.registerSubscription(subscription);
    return {
      ...registration,
      threadId: subscription.threadId,
      readyClientCount: readyClients.length,
    };
  }

  async wakeThread(input) {
    if (!isObject(input)) throw new CodexAppServerProxyError("INVALID_ARGUMENT", "wake 必须接收对象");
    if (!this.journal?.claimWake || !this.journal?.registerSubscription) {
      throw new CodexAppServerProxyError("WAKE_JOURNAL_REQUIRED", "自动唤醒需要持久化唤醒日志");
    }
    const subscriptionInput = normalizeSubscription(input);
    const threadId = subscriptionInput.threadId;
    const prompt = requiredString(input.prompt, "prompt", 100000);
    const wakeId = requiredString(input.wakeId, "wakeId", 256);
    const messageVisibility = normalizeWakeMessageVisibility(input.messageVisibility);
    const promptHash = promptSha256(prompt);
    if (input.promptSha256 && input.promptSha256 !== promptHash) {
      throw new CodexAppServerProxyError("PROMPT_HASH_MISMATCH", `promptSha256 与正文不一致：${wakeId}`);
    }
    this.journal.registerSubscription(subscriptionInput);
    const claim = this.journal.claimWake({
      ...subscriptionInput,
      wakeId,
      promptSha256: promptHash,
      pendingThroughSequence: input.pendingThroughSequence,
      pendingThroughTime: input.pendingThroughTime,
      messageVisibility,
    });
    const existing = claim.wake;
    if (!claim.acquired && ["accepted", "completed", "recovered"].includes(existing.status)) {
      return {
        threadId,
        wakeId,
        outcome: existing.status === "completed" ? "completed" : "accepted",
        started: false,
        duplicateSuppressed: true,
        recovered: existing.status === "recovered",
        turn: existing.turnId ? { id: existing.turnId, status: existing.turnStatus ?? null } : null,
        messageVisibility: existing.messageVisibility ?? "hidden",
        clientUserMessageId: existing.clientUserMessageId ?? null,
      };
    }

    if (!claim.acquired) {
      return {
        threadId,
        wakeId,
        outcome: "unknown",
        started: null,
        duplicateSuppressed: true,
        recovered: false,
        error: {
          code: "PREVIOUS_WAKE_OUTCOME_UNKNOWN",
          message: "同一 wakeId 已在准备、发送或结果未知状态，拒绝自动重复发送",
          outcomeUnknown: true,
        },
      };
    }

    let subscription;
    try {
      subscription = await this.subscribeThread(threadId);
      const priorTurnVisible = subscription.results.some((result) => recursiveContainsString(result, wakeId));
      if (priorTurnVisible) {
        const recovered = this.journal.writeWake(wakeId, {
          status: "recovered",
          recoveredFromThread: true,
        }, ["prepared"]);
        return {
          threadId,
          wakeId,
          outcome: "accepted",
          started: false,
          duplicateSuppressed: true,
          recovered: true,
          turn: recovered?.turnId ? { id: recovered.turnId, status: recovered.turnStatus ?? null } : null,
        };
      }
    } catch (error) {
      try {
        this.journal.writeWake(wakeId, {
          status: "failed_before_send",
          error: publicError(error),
        }, ["prepared"]);
      } catch {
      }
      throw error;
    }

    let mutationAttempted = false;
    try {
      const maintenance = this.#maintenanceStatus();
      if (maintenance.active) {
        throw new CodexAppServerProxyError(
          "AUTOMATION_PAUSED",
          "自动唤醒处于维护暂停状态",
          { details: maintenance },
        );
      }
      const primary = subscription.readyClients[0];
      const resumeBusy = subscription.results.some((result) => resumeResultIndicatesBusy(result));
      const activeTurn = messageVisibility === "visible"
        ? subscription.results.map((result) => activeTurnFromResumeResult(result)).find(Boolean) ?? null
        : null;
      if (resumeBusy && (messageVisibility === "hidden" || !activeTurn)) {
        const busy = this.journal.writeWake(wakeId, {
          status: "failed_before_send",
          error: {
            code: "THREAD_BUSY",
            message: messageVisibility === "hidden"
              ? "目标线程忙碌，hidden 模式等待当前轮次结束后重试"
              : "目标线程忙碌，但 App Server 未返回可安全 steer 的 active turn id",
          },
        }, ["prepared"]);
        return {
          threadId,
          wakeId,
          outcome: "busy",
          started: false,
          duplicateSuppressed: false,
          recovered: false,
          messageVisibility,
          clientUserMessageId: busy?.clientUserMessageId ?? existing.clientUserMessageId ?? null,
          turn: null,
        };
      }
      this.journal.writeWake(wakeId, {
        status: "dispatching",
        writerEpoch: this.writerEpoch,
      }, ["prepared"]);
      const method = activeTurn ? "turn/steer" : "turn/start";
      const params = {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(activeTurn ? { expectedTurnId: activeTurn.id ?? activeTurn.turnId } : {}),
        ...(messageVisibility === "visible"
          ? { clientUserMessageId: existing.clientUserMessageId }
          : {}),
      };
      mutationAttempted = true;
      const result = await this.#injectRequest(
        primary,
        method,
        params,
        { mutating: true, threadId },
      );
      const turn = responseTurn(result);
      const status = String(turn?.status ?? "").toLowerCase();
      const outcome = ["completed", "done", "failed", "cancelled", "canceled"].includes(status)
        ? "completed"
        : "accepted";
      try {
        this.journal.writeWake(wakeId, {
          status: outcome,
          turnId: turn?.id ?? turn?.turnId ?? null,
          turnStatus: turn?.status ?? null,
          injectionMethod: method,
        }, ["dispatching"]);
      } catch (cause) {
        throw new CodexAppServerProxyError(
          "WAKE_JOURNAL_COMMIT_FAILED",
          `App Server 已响应，但无法持久化唤醒结果：${wakeId}`,
          { cause, outcomeUnknown: true },
        );
      }
      return {
        threadId,
        wakeId,
        outcome,
        started: true,
        duplicateSuppressed: false,
        recovered: false,
        messageVisibility,
        clientUserMessageId: existing.clientUserMessageId ?? null,
        injectionMethod: method,
        subscribedClientCount: subscription.readyClients.length,
        turn,
        raw: result,
      };
    } catch (error) {
      const outcomeUnknown = Boolean(error?.outcomeUnknown);
      try {
        this.journal.writeWake(wakeId, {
          status: outcomeUnknown ? "unknown" : "failed_before_send",
          error: publicError(error),
        }, mutationAttempted ? ["dispatching"] : ["prepared"]);
      } catch {
      }
      throw error;
    }
  }

  async close() {
    if (this.closed) return { closed: true };
    this.closed = true;
    for (const client of [...this.clients]) this.#closeClient(client, "proxy_closed");
    await Promise.all([
      this.#closeServer(this.websocketServer),
      this.#closeServer(this.controlServer),
    ]);
    this.websocketServer = null;
    this.controlServer = null;
    this.onEvent({ type: "proxy_closed" });
    return { closed: true };
  }

  #readyClients() {
    return [...this.clients].filter((client) =>
      client.initialized
      && client.upstreamReady
      && client.downstream.readyState === this.WebSocketImpl.OPEN
      && client.upstream?.readyState === this.WebSocketImpl.OPEN
    );
  }

  #maintenanceStatus() {
    if (!this.maintenanceFilePath) return { active: false, reasons: [] };
    try {
      const state = JSON.parse(fs.readFileSync(this.maintenanceFilePath, "utf8").replace(/^\uFEFF/, ""));
      const reasons = isObject(state?.reasons)
        ? Object.keys(state.reasons)
        : Array.isArray(state?.reasons)
          ? state.reasons.map(String)
          : [];
      return {
        active: Boolean(state?.active || state?.enabled || state?.paused || reasons.length),
        reasons,
        updatedAt: state?.updatedAt ?? null,
      };
    } catch (cause) {
      if (cause?.code === "ENOENT") return { active: false, reasons: [] };
      return {
        active: true,
        reasons: ["maintenance_state_unreadable"],
        error: publicError(cause),
      };
    }
  }

  #acceptDownstream(downstream) {
    const client = {
      downstream,
      upstream: null,
      initialized: false,
      initializationRequestId: null,
      initializeParams: null,
      initializedNotification: null,
      upstreamReady: false,
      hasConnectedBefore: false,
      queued: [],
      injected: new Map(),
      connectedAt: new Date().toISOString(),
      closed: false,
      reconnectTimer: null,
      reconnectAttempt: 0,
      nextReconnectAt: null,
    };
    this.clients.add(client);
    downstream.on("message", (data, isBinary) => {
      const message = parseJsonMessage(data);
      if (message?.method === "initialize") {
        client.initializationRequestId = message.id ?? null;
        client.initializeParams = message.params ?? {};
      } else if (message?.method === "initialized") {
        client.initialized = true;
        client.initializedNotification = { data: isBinary ? data : data.toString("utf8"), isBinary };
      }
      const payload = isBinary ? data : data.toString("utf8");
      if (client.upstreamReady && client.upstream?.readyState === this.WebSocketImpl.OPEN) {
        client.upstream.send(payload, { binary: isBinary });
        return;
      }
      if (client.queued.length >= this.maxQueuedMessages) {
        this.#closeClient(client, "downstream_queue_overflow", new CodexAppServerProxyError(
          "DOWNSTREAM_QUEUE_OVERFLOW",
          `App Server 离线期间累计消息超过 ${this.maxQueuedMessages} 条，已关闭当前连接以避免无界占用`,
        ));
        return;
      }
      client.queued.push({ data: payload, isBinary });
    });
    downstream.on("close", () => this.#closeClient(client, "downstream_closed"));
    downstream.on("error", (error) => this.#closeClient(client, "downstream_error", error));
    this.#connectUpstream(client);
  }

  #connectUpstream(client) {
    if (
      client.closed
      || this.closed
      || client.downstream.readyState >= this.WebSocketImpl.CLOSING
      || [this.WebSocketImpl.CONNECTING, this.WebSocketImpl.OPEN].includes(client.upstream?.readyState)
    ) return;
    if (client.reconnectTimer) {
      clearTimeout(client.reconnectTimer);
      client.reconnectTimer = null;
    }
    client.nextReconnectAt = null;
    const upstream = new this.WebSocketImpl(this.upstreamUrl);
    client.upstream = upstream;
    upstream.on("open", () => {
      if (client.closed || client.upstream !== upstream) return;
      client.reconnectAttempt = 0;
      client.nextReconnectAt = null;
      if (!client.hasConnectedBefore) {
        client.hasConnectedBefore = true;
        client.upstreamReady = true;
        this.#flushQueuedMessages(client, upstream);
        this.onEvent({ type: "upstream_connected", connectedAt: client.connectedAt, restored: false });
        return;
      }
      this.#restoreUpstream(client, upstream).catch((error) => {
        if (client.closed || client.upstream !== upstream) return;
        this.#recordError("upstream_restore_failed", error);
        upstream.close();
      });
    });
    upstream.on("message", (data, isBinary) => {
      if (client.closed || client.upstream !== upstream) return;
      const message = parseJsonMessage(data);
      if (
        message
        && client.initializationRequestId !== null
        && message.id === client.initializationRequestId
        && !message.error
      ) client.initialized = true;
      if (message && Object.hasOwn(message, "id") && client.injected.has(message.id)) {
        const pending = client.injected.get(message.id);
        client.injected.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) {
          pending.reject(new CodexAppServerProxyError(
            "APP_SERVER_RPC_ERROR",
            message.error.message ?? `App Server 请求失败：${pending.method}`,
            { details: { method: pending.method, rpcError: message.error } },
          ));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (client.downstream.readyState === this.WebSocketImpl.OPEN) {
        client.downstream.send(isBinary ? data : data.toString("utf8"), { binary: isBinary });
      }
    });
    upstream.on("close", () => this.#handleUpstreamDisconnect(client, upstream, "upstream_closed"));
    upstream.on("error", (error) => this.#handleUpstreamDisconnect(client, upstream, "upstream_error", error));
  }

  #handleUpstreamDisconnect(client, upstream, reason, error = null) {
    if (client.closed || client.upstream !== upstream) return;
    client.upstream = null;
    client.upstreamReady = false;
    for (const pending of client.injected.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerProxyError(
        "UPSTREAM_RECONNECTING",
        `App Server 上游连接中断，透明中转正在恢复：${reason}`,
        { outcomeUnknown: pending.mutating && pending.written, details: { method: pending.method } },
      ));
    }
    client.injected.clear();
    if (error) this.#recordError(reason, error);
    this.#scheduleReconnect(client, reason);
  }

  async #restoreUpstream(client, upstream) {
    if (client.initializeParams !== null) {
      await this.#injectRequest(client, "initialize", client.initializeParams);
    }
    if (client.closed || client.upstream !== upstream || upstream.readyState !== this.WebSocketImpl.OPEN) return;
    if (client.initializedNotification) {
      upstream.send(client.initializedNotification.data, { binary: client.initializedNotification.isBinary });
    }
    client.upstreamReady = true;
    this.#flushQueuedMessages(client, upstream);
    this.onEvent({ type: "upstream_connected", connectedAt: client.connectedAt, restored: true });
  }

  #flushQueuedMessages(client, upstream) {
    if (client.closed || client.upstream !== upstream || upstream.readyState !== this.WebSocketImpl.OPEN) return;
    for (const queued of client.queued.splice(0)) upstream.send(queued.data, { binary: queued.isBinary });
  }

  #scheduleReconnect(client, reason) {
    if (client.closed || this.closed || client.reconnectTimer) return;
    client.reconnectAttempt += 1;
    const delayMs = Math.min(
      this.reconnectMaxMs,
      this.reconnectInitialMs * (2 ** Math.min(client.reconnectAttempt - 1, 10)),
    );
    client.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    this.onEvent({
      type: "upstream_reconnect_scheduled",
      reason,
      attempt: client.reconnectAttempt,
      delayMs,
      connectedAt: client.connectedAt,
    });
    client.reconnectTimer = setTimeout(() => {
      client.reconnectTimer = null;
      this.#connectUpstream(client);
    }, delayMs);
  }

  #injectRequest(client, method, params, options = {}) {
    if (client.upstream?.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.reject(new CodexAppServerProxyError("UPSTREAM_NOT_OPEN", "App Server 上游连接未就绪"));
    }
    const id = this.nextInjectedRequestId;
    this.nextInjectedRequestId -= 1;
    const timeoutMs = boundedInteger(options.timeoutMs, this.requestTimeoutMs, 250, 300000);
    return new Promise((resolve, reject) => {
      const pending = {
        id,
        method,
        mutating: Boolean(options.mutating),
        written: false,
        resolve,
        reject,
        timeout: null,
      };
      pending.timeout = setTimeout(() => {
        if (!client.injected.delete(id)) return;
        reject(new CodexAppServerProxyError(
          "APP_SERVER_TIMEOUT",
          `App Server 在 ${timeoutMs}ms 内未响应：${method}`,
          { outcomeUnknown: pending.mutating && pending.written, details: { method, id } },
        ));
      }, timeoutMs);
      client.injected.set(id, pending);
      try {
        client.upstream.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        pending.written = true;
      } catch (cause) {
        client.injected.delete(id);
        clearTimeout(pending.timeout);
        reject(new CodexAppServerProxyError(
          "APP_SERVER_WRITE_FAILED",
          `无法向 App Server 写入请求：${method}`,
          { cause, outcomeUnknown: pending.mutating, details: { method, id } },
        ));
      }
    });
  }

  #closeClient(client, reason, error = null) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    if (client.reconnectTimer) clearTimeout(client.reconnectTimer);
    client.reconnectTimer = null;
    for (const pending of client.injected.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerProxyError(
        "CONNECTION_CLOSED",
        `透明中转连接已关闭：${reason}`,
        { outcomeUnknown: pending.mutating && pending.written, details: { method: pending.method } },
      ));
    }
    client.injected.clear();
    if (client.downstream.readyState < this.WebSocketImpl.CLOSING) client.downstream.close();
    if (client.upstream?.readyState < this.WebSocketImpl.CLOSING) client.upstream.close();
    if (error) this.#recordError(reason, error);
    this.onEvent({ type: "client_closed", reason, connectedAt: client.connectedAt });
  }

  async #handleControlRequest(request, response) {
    response.setHeader("content-type", "application/json; charset=utf-8");
    const authorization = String(request.headers.authorization ?? "");
    const expectedAuthorization = `Bearer ${this.controlToken}`;
    const authorized = authorization.length === expectedAuthorization.length
      && crypto.timingSafeEqual(Buffer.from(authorization), Buffer.from(expectedAuthorization));
    if (!authorized) throw new CodexAppServerProxyError("UNAUTHORIZED", "代理控制口令不正确");
    const requestUrl = new URL(request.url ?? "/", `http://${this.controlHost}:${this.controlPort}`);
    if (request.method === "GET" && ["/status", "/v1/status"].includes(requestUrl.pathname)) {
      response.end(JSON.stringify(this.status()));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname.startsWith("/v1/wakes/")) {
      const wakeId = decodeURIComponent(requestUrl.pathname.slice("/v1/wakes/".length));
      response.end(JSON.stringify({ ok: true, wake: this.journal?.getWake?.(wakeId) ?? null }));
      return;
    }
    const postRoutes = ["/subscribe", "/wake", "/v1/subscriptions", "/v1/wakes"];
    if (request.method !== "POST" || !postRoutes.includes(requestUrl.pathname)) {
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "控制接口不存在" } }));
      return;
    }
    const body = await this.#readBody(request);
    const input = JSON.parse(body || "{}");
    const result = requestUrl.pathname === "/subscribe"
      ? await this.subscribeThread(input.threadId)
      : requestUrl.pathname === "/v1/subscriptions"
        ? await this.subscribeTask(input)
        : await this.wakeThread(input);
    response.end(JSON.stringify({
      ok: true,
      ...result,
      readyClients: undefined,
      results: undefined,
    }));
  }

  async #readBody(request) {
    let total = 0;
    const chunks = [];
    for await (const chunk of request) {
      total += chunk.length;
      if (total > this.maxBodyBytes) {
        throw new CodexAppServerProxyError("BODY_TOO_LARGE", "控制请求正文过大");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  #recordError(source, error) {
    this.lastError = {
      at: new Date().toISOString(),
      source,
      ...publicError(error),
    };
    this.onEvent({ type: "proxy_error", error: this.lastError });
  }

  #waitForListening(server, name) {
    if (server.address()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (cause) => {
        cleanup();
        reject(new CodexAppServerProxyError("LISTEN_FAILED", `${name} 监听失败：${cause.message}`, { cause }));
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
  }

  #listenHttp(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (cause) => {
        server.off("listening", onListening);
        reject(new CodexAppServerProxyError("LISTEN_FAILED", `控制端口监听失败：${cause.message}`, { cause }));
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  }

  #closeServer(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

export function createCodexAppServerProxy(options = {}) {
  return new CodexAppServerProxy(options);
}
