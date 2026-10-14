import crypto from "node:crypto";
import { CodexAppServerProxyError } from "./outer-runtime-contract.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcResponse(message) {
  return isObject(message) && Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")
    && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

function requiredString(value, name, maximum = 100000) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new CodexAppServerProxyError("INVALID_ARGUMENT", `${name} 不能为空`);
  if (normalized.length > maximum) {
    throw new CodexAppServerProxyError("INVALID_ARGUMENT", `${name} 不能超过 ${maximum} 个字符`);
  }
  return normalized;
}

function isNotFoundRpcError(error, threadId) {
  if (![-32602, -32004].includes(error?.code) || typeof error?.message !== "string") return false;
  const escapedId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const message = error.message.trim();
  return new RegExp(`^(?:thread not found|unknown thread|thread does not exist):\\s*["']?${escapedId}["']?[.!]?$`, "i").test(message)
    || new RegExp(`^thread\\s+["']?${escapedId}["']?\\s+(?:not found|does not exist)[.!]?$`, "i").test(message);
}

function responseTurn(response) {
  if (!isObject(response)) return null;
  if (isObject(response.turn)) return response.turn;
  if (isObject(response.result?.turn)) return response.result.turn;
  if (typeof response.turnId === "string" && response.turnId) return { id: response.turnId, status: "inProgress" };
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
  const status = isObject(value) ? value.type : value;
  return typeof status === "string" ? status.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
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

function resumeThreadState(result, threadId) {
  const thread = result?.thread;
  if (!isObject(thread) || thread.id !== threadId) {
    throw new CodexAppServerProxyError("INVALID_THREAD_SUMMARY", "App Server 未返回匹配的恢复对话摘要");
  }
  const explicitStatus = thread.status ?? thread.state;
  let status = normalizeTurnStatus(explicitStatus);
  if (explicitStatus === undefined || explicitStatus === null) {
    if (Array.isArray(thread.turns)) {
      if (!thread.turns.length) status = "idle";
      else {
        status = normalizeTurnStatus(thread.turns.at(-1)?.status ?? thread.turns.at(-1)?.state);
        if (["completed", "done", "failed", "cancelled", "canceled", "interrupted"].includes(status)) status = "idle";
      }
    }
  }
  if (status === "idle") return "idle";
  if (ACTIVE_TURN_STATUSES.has(status)) return "busy";
  throw new CodexAppServerProxyError("THREAD_NOT_IDLE", "App Server 恢复摘要未确认对话空闲或可定位的活动状态", {
    details: { threadId, status: explicitStatus ?? status ?? null },
  });
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
  const candidates = Array.isArray(value.turns) ? value.turns : Array.isArray(value.data) ? value.data : null;
  if (candidates) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const turn = candidates[index];
      const status = normalizeTurnStatus(turn?.status ?? turn?.state);
      if (
        isObject(turn)
        && typeof (turn.id ?? turn.turnId) === "string"
        && (turn.id ?? turn.turnId).trim().length > 0
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

class OuterEngine {
  constructor(host) { this.host = host; }

  async inspectThread(threadId) {
    const normalizedThreadId = requiredString(threadId, "threadId", 256);
    const primary = this.host.readyClients()[0];
    if (!primary) {
      throw new CodexAppServerProxyError(
        "NO_DESKTOP_CLIENT",
        "没有已初始化且上下游均在线的 Codex Desktop 连接",
      );
    }
    let result;
    try {
      result = await this.host.injectRequest(
        primary,
        "thread/read",
        { threadId: normalizedThreadId, includeTurns: false },
        { threadId: normalizedThreadId },
      );
    } catch (error) {
      if (error.code === "APP_SERVER_RPC_ERROR"
        && isNotFoundRpcError(error.details?.rpcError, normalizedThreadId)) {
        return { threadId: normalizedThreadId, found: false, thread: null };
      }
      throw error;
    }
    if (!isObject(result?.thread) || result.thread.id !== normalizedThreadId) {
      throw new CodexAppServerProxyError("INVALID_THREAD_SUMMARY", "App Server 未返回匹配的对话摘要");
    }
    return { threadId: normalizedThreadId, found: true, thread: result.thread };
  }

  async subscribeThread(threadId) {
    const normalizedThreadId = requiredString(threadId, "threadId", 256);
    const readyClients = this.host.readyClients();
    if (!readyClients.length) {
      throw new CodexAppServerProxyError(
        "NO_DESKTOP_CLIENT",
        "没有已初始化且上下游均在线的 Codex Desktop 连接",
      );
    }
    const primary = readyClients[0];
    const result = await this.host.injectRequest(
      primary,
      "thread/resume",
      { threadId: normalizedThreadId, excludeTurns: true },
      { threadId: normalizedThreadId, timeoutMs: this.host.state.resumeRequestTimeoutMs },
    );
    return { threadId: normalizedThreadId, readyClients: [primary], results: [result] };
  }

  async subscribeTask(input) {
    if (!this.host.state.journal?.registerSubscription) {
      throw new CodexAppServerProxyError("WAKE_JOURNAL_REQUIRED", "任务订阅需要持久化唤醒日志");
    }
    const subscription = normalizeSubscription(input);
    const readyClients = this.host.readyClients();
    if (!readyClients.length) {
      throw new CodexAppServerProxyError(
        "NO_DESKTOP_CLIENT",
        "没有已初始化且上下游均在线的 Codex Desktop 连接",
      );
    }
    const registration = this.host.state.journal.registerSubscription(subscription);
    return {
      ...registration,
      threadId: subscription.threadId,
      readyClientCount: readyClients.length,
    };
  }

  async wakeThread(input) {
    if (!isObject(input)) throw new CodexAppServerProxyError("INVALID_ARGUMENT", "wake 必须接收对象");
    if (!this.host.state.journal?.claimWake || !this.host.state.journal?.registerSubscription) {
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
    this.host.state.journal.registerSubscription(subscriptionInput);
    const claim = this.host.state.journal.claimWake({
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
    } catch (error) {
      try {
        this.host.state.journal.writeWake(wakeId, {
          status: "failed_before_send",
          error: publicError(error),
        }, ["prepared"]);
      } catch {
      }
      throw error;
    }

    let mutationAttempted = false;
    let visibilityRegistration = null;
    try {
      const maintenance = this.host.maintenanceStatus();
      if (maintenance.active) {
        throw new CodexAppServerProxyError(
          "AUTOMATION_PAUSED",
          "自动唤醒处于维护暂停状态",
          { details: maintenance },
        );
      }
      const primary = subscription.readyClients[0];
      const resumeBusy = subscription.results.map((result) => resumeThreadState(result, threadId)).includes("busy");
      let activeTurn = resumeBusy ? subscription.results
        .map((result) => activeTurnFromResumeResult(result.thread))
        .find(Boolean) ?? null : null;
      if (resumeBusy && !activeTurn) {
        try {
          const latest = await this.host.injectRequest(primary, "thread/turns/list", {
            threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
          }, { threadId });
          activeTurn = activeTurnFromResumeResult(latest);
        } catch (error) {
          this.host.recordError("active_turn_lookup", error);
        }
      }
      if (resumeBusy && !activeTurn) {
        const busy = this.host.state.journal.writeWake(wakeId, {
          status: "failed_before_send",
          error: {
            code: "THREAD_BUSY",
            message: "目标线程忙碌，但 App Server 未返回可安全 steer 的 active turn id",
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
      const method = activeTurn ? "turn/steer" : "turn/start";
      this.host.state.journal.writeWake(wakeId, {
        status: "dispatching",
        writerEpoch: this.host.state.writerEpoch,
        turnId: activeTurn?.id ?? activeTurn?.turnId ?? null,
        injectionMethod: method,
      }, ["prepared"]);
      const params = {
        threadId,
        input: [{ type: "text", text: prompt }],
        ...(activeTurn ? { expectedTurnId: activeTurn.id ?? activeTurn.turnId } : {}),
        clientUserMessageId: existing.clientUserMessageId ?? existing.visibilityClientId,
      };
      mutationAttempted = true;
      visibilityRegistration = this.host.state.wakeVisibility.registerWake({
        threadId,
        wakeId,
        prompt,
        messageVisibility,
        turnId: activeTurn?.id ?? activeTurn?.turnId ?? null,
        injectionMethod: method,
        visibilityClientId: existing.visibilityClientId ?? existing.clientUserMessageId,
      });
      this.host.state.displayPolicy.registerReminder(visibilityRegistration);
      const result = await this.host.injectRequest(
        primary,
        method,
        params,
        { mutating: true, threadId },
      );
      const turn = responseTurn(result);
      if (activeTurn && turn?.id !== (activeTurn.id ?? activeTurn.turnId)) {
        throw new CodexAppServerProxyError("WAKE_RESULT_IDENTITY_MISMATCH", "App Server 返回的轮次身份与当前轮次不一致", { outcomeUnknown: true });
      }
      if (visibilityRegistration && turn?.id) visibilityRegistration.turnId = turn.id;
      const status = String(turn?.status ?? "").toLowerCase();
      const outcome = ["completed", "done", "failed", "cancelled", "canceled"].includes(status)
        ? "completed"
        : "accepted";
      try {
        this.host.state.journal.writeWake(wakeId, {
          status: outcome,
          turnId: turn?.id ?? turn?.turnId ?? null,
          turnStatus: turn?.status ?? null,
          injectionMethod: method,
          visibilityItemKey: visibilityRegistration?.itemKey ?? null,
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
      if (!outcomeUnknown) {
        this.host.state.wakeVisibility.forgetWake(visibilityRegistration);
        this.host.state.displayPolicy.forgetReminder(visibilityRegistration);
      }
      try {
        this.host.state.journal.writeWake(wakeId, {
          status: outcomeUnknown ? "unknown" : "failed_before_send",
          ...(visibilityRegistration ? {
            turnId: visibilityRegistration.turnId,
            injectionMethod: visibilityRegistration.injectionMethod,
            visibilityItemKey: visibilityRegistration.itemKey,
          } : {}),
          error: publicError(error),
        }, mutationAttempted ? ["dispatching"] : ["prepared"]);
      } catch {
      }
      throw error;
    }
  }

  observeDownstream(client, message) {
    client.wakeVisibility.observeRequest(message);
    client.displayPolicy.observeRequest(message);
    client.reasoningPlaceholder.observeRequest(message);
    client.turnObserver.observeDownstream(message);
  }

  observeInjectedRequest(client, message) { client.displayPolicy.observeRequest(message); }

  observeInjectedResponse(client, message) { client.displayPolicy.observeUpstream(message); }

  projectUpstream(client, message) {
    client.displayPolicy.observeUpstream(message);
    const suppressed = client.wakeVisibility.shouldSuppress(message);
    const stableProjection = suppressed ? message : client.wakeVisibility.project(message);
    const displayProjection = client.displayPolicy.project(message, stableProjection, suppressed);
    if (!displayProjection && message) return null;
    return client.reasoningPlaceholder.project(displayProjection);
  }
}

export function createOuterEngine(host) { return new OuterEngine(host); }
export default { apiVersion: 1, version: "original", createEngine: createOuterEngine };
