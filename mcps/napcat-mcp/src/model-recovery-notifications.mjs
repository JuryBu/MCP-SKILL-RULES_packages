import crypto from "node:crypto";

const phases = new Set(["waiting", "retrying", "resumed", "completed", "failed", "stopped"]);
const terminal = new Set(["completed", "failed", "stopped"]);
const textId = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\u0000");
const digest = (value, capability) => crypto.createHmac("sha256", Buffer.from(capability, "hex"))
  .update(JSON.stringify(value)).digest("hex");
const payload = envelope => Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "signature"));
const safeToken = value => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u.test(value);
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
const userInterrupted = event => event.userRequested === true && event.reason === "user_interrupt";

function safeFailureDiagnostics(input) {
  if (!input || typeof input !== "object") return undefined;
  const result = {};
  for (const key of ["stage", "errorSource", "transportCode", "responseFormat", "httpRefusalSignal"]) {
    if (safeToken(input[key])) result[key] = input[key];
  }
  for (const key of ["version", "requestBodyBytes", "responseBytes", "responseFrames"]) {
    if (nonnegative(input[key])) result[key] = input[key];
  }
  if (httpStatus(input.statusCode)) result.statusCode = input.statusCode;
  for (const key of ["socketAssigned", "connectionObserved", "tlsObserved", "reusedSocket", "requestFinished",
    "responseStarted", "progressObserved", "cfRayHeaderPresent", "challengeSignal", "authenticationSignal",
    "securitySignal", "usageLimitSignal"]) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  return Object.keys(result).length ? result : undefined;
}

function recoveryDetails(event, previous) {
  const result = { type: event.type, requestId: event.requestId, threadId: event.threadId, turnId: event.turnId,
    phase: event.phase, sequence: event.sequence };
  for (const key of ["operationId", "recoveryCycleId"]) if (textId(event[key])) result[key] = event[key];
  const priorFailure = ["waiting", "resumed"].includes(event.phase) ? undefined : previous;
  for (const key of ["requestKind", "reason", "originalReason", "category", "code", "waitContext"]) {
    const value = Object.hasOwn(event, key) ? event[key] : priorFailure?.[key];
    if (safeToken(value)) result[key] = value;
  }
  for (const key of ["retryNumber", "admissionRetryNumber", "serverAttempt", "nextServerAttempt", "nativeAttempt", "startedAt",
    "attemptStartedAt", "operationElapsedMs", "attemptElapsedMs", "retryAfterMs"]) {
    if (nonnegative(event[key])) result[key] = event[key];
  }
  for (const key of ["transport", "nextTransport"]) {
    if (["ws", "http"].includes(event[key])) result[key] = event[key];
  }
  if (["retry", "reconnect"].includes(event.retryAction)) result.retryAction = event.retryAction;
  if (typeof event.attemptStarted === "boolean") result.attemptStarted = event.attemptStarted;
  if (userInterrupted(event)) result.userRequested = true;
  else if (event.userRequested === false) result.userRequested = false;
  if (["request", "turn"].includes(event.cancellationScope)) result.cancellationScope = event.cancellationScope;
  if (safeToken(event.cancellationOrigin)) result.cancellationOrigin = event.cancellationOrigin;
  const acceptance = Object.hasOwn(event, "acceptance") ? event.acceptance : priorFailure?.acceptance;
  if (["rejected", "not_sent", "accepted", "unknown"].includes(acceptance)) result.acceptance = acceptance;
  const status = event.httpStatusCode === undefined ? priorFailure?.httpStatusCode : event.httpStatusCode;
  if (httpStatus(status)) result.httpStatusCode = status;
  const diagnostic = safeFailureDiagnostics(event.failureDiagnostics === undefined ? priorFailure?.failureDiagnostics : event.failureDiagnostics);
  if (diagnostic) result.failureDiagnostics = diagnostic;
  result.willRetry = !terminal.has(event.phase) && event.phase !== "resumed" && event.willRetry === true;
  result.canContinueHttp = event.phase === "waiting" && event.canContinueHttp === true;
  return result;
}

function recoveryProgressState(event) {
  if (event.phase === "waiting") return event.willRetry ? "backoff" : "awaiting_action";
  if (event.phase === "retrying") return event.attemptStarted === true ? "attempt_started" : "retry_pending";
  return event.phase === "stopped" ? userInterrupted(event) ? "cancelled" : "request_closed" : event.phase;
}

function recoveryCycleIdentity(event, previous) {
  if (!["waiting", "retrying"].includes(event.phase)) return null;
  const native = event.operationId === event.requestId;
  const transport = event.attemptStarted === true ? event.transport : event.nextTransport ?? event.transport;
  const serverAttempt = event.attemptStarted === true ? event.serverAttempt : event.nextServerAttempt;
  const kind = event.waitContext === "root_admission" ? "root_admission"
    : event.waitContext === "native_request_admission" ? "native_admission"
      : transport === "ws" && (event.retryAction === "reconnect" || native && event.retryAction === undefined)
        ? "ws_reconnect" : transport === "http" ? "http_retry" : "request_retry";
  const suppliedRetryNumber = kind === "native_admission" ? event.admissionRetryNumber : event.retryNumber;
  const prior = previous?.recoveryCycle;
  const continuing = event.phase === "retrying" && prior?.kind === kind && (kind === "http_retry"
    ? prior.serverAttempt === serverAttempt : prior.retryNumber === suppliedRetryNumber);
  const retryNumber = kind === "http_retry" && continuing && !nonnegative(suppliedRetryNumber)
    ? prior.retryNumber : suppliedRetryNumber;
  const startedAt = nonnegative(event.startedAt) ? event.startedAt
    : (native || kind === "http_retry") && continuing ? prior.startedAt : undefined;
  const cycleId = event.recoveryCycleId ?? ((native || kind === "http_retry") && continuing ? prior.cycleId : undefined);
  return { kind, retryNumber, startedAt, cycleId, serverAttempt, nativeAttempt: event.nativeAttempt,
    operationId: event.operationId, waitContext: event.waitContext };
}

function automaticRecoveryCycle(event, cycle = recoveryCycleIdentity(event)) {
  const numberedAttempt = nonnegative(cycle?.serverAttempt) && cycle.serverAttempt >= 1;
  const timedCycle = nonnegative(cycle?.retryNumber) && cycle.retryNumber >= 1 && nonnegative(cycle?.startedAt);
  const capacityHandoff = cycle?.kind === "http_retry" && event.category === "payload_too_large"
    && event.reason === "websocket_payload_requires_http" && event.acceptance === "not_sent" && numberedAttempt;
  if (!["ws_reconnect", "http_retry"].includes(cycle?.kind) || !event.willRetry || event.canContinueHttp
    || cycle.kind === "http_retry" && (event.retryAction !== "retry"
      || !numberedAttempt && !(timedCycle && cycle.operationId === event.requestId))
    || !["rejected", "not_sent", "accepted", "unknown"].includes(event.acceptance)
    || event.category !== undefined && !["temporary", "acceptance_unknown"].includes(event.category) && !capacityHandoff
    || ["authenticationSignal", "securitySignal", "usageLimitSignal", "challengeSignal"]
      .some(key => event.failureDiagnostics?.[key] === true)
    || cycle.kind === "ws_reconnect" && (!timedCycle
      || cycle.operationId !== event.requestId && !numberedAttempt)) return null;
  return JSON.stringify([cycle, event.reason, event.originalReason, event.category, event.code,
    event.acceptance, event.httpStatusCode, event.failureDiagnostics]);
}

function recoveryMessageBody(event) {
  if (event.waitContext === "root_admission") {
    if (event.phase === "waiting") return event.willRetry
      ? "本机转发正在恢复，仍在处理同一请求，可取消当前回合"
      : "本机转发正在等待核对当前请求，可取消当前回合";
    if (event.phase === "failed") return event.acceptance === "not_sent"
      ? "本机转发恢复未能完成，本次请求尚未发送给模型，正在结束当前回合"
      : "本机转发恢复未能完成，已保留当前状态，正在结束当前回合";
  }
  if (event.waitContext === "native_request_admission" && event.admissionRetryNumber > 0
    && ["waiting", "retrying"].includes(event.phase)) {
    return `本机暂忙，${event.phase === "waiting" ? "等待" : "正在准备"}第${event.admissionRetryNumber}次重新尝试，可取消当前回合`;
  }
  const status = event.httpStatusCode >= 400 ? event.httpStatusCode : null;
  const cause = `模型请求遇到${status ? ` HTTP ${status} 故障` : "连接或传输故障"}`;
  const action = event.retryAction === "reconnect" ? "自动重连" : "自动重试";
  const attempt = event.retryNumber > 0 ? `第${event.retryNumber}次${action}` : `下一次${action}`;
  const transport = event.attemptStarted === true ? event.transport : event.nextTransport ?? event.transport;
  const serverAttempt = event.attemptStarted === true ? event.serverAttempt : event.nextServerAttempt;
  const context = [transport === "http" ? "HTTP" : transport === "ws" ? "WebSocket" : null,
    serverAttempt > 0 ? `上游请求第${serverAttempt}次` : null].filter(Boolean);
  let message;
  if (event.phase === "failed") message = `${cause}，本次请求的自动恢复已结束，请核对错误后继续`;
  else if (event.phase === "stopped") message = userInterrupted(event) ? "当前回合已按请求停止" : "本次请求连接已关闭";
  else if (event.phase === "waiting") message = event.willRetry
    ? automaticRecoveryCycle(event)
      ? `${cause}，正在等待退避，随后${transport === "http"
        ? `${event.retryNumber > 0 ? `进行第${event.retryNumber}次 HTTP 重试` : "通过 HTTP 继续请求"}${serverAttempt > 0 ? `（上游请求第${serverAttempt}次）` : ""}`
        : `进行第${event.retryNumber}次 WebSocket 重连`}，可取消当前回合`
      : `${cause}，${attempt}前正在等待退避，可取消当前回合`
    : `${cause}，当前请求正在等待核对，可取消当前回合或核对上游状态`;
  else if (transport === "http" && !(event.retryNumber > 0)) message = `${cause}，正在${event.transport === "ws"
    ? "改用" : "通过"} HTTP 继续请求${serverAttempt > 0 ? `（上游请求第${serverAttempt}次）` : ""}，可取消当前回合`;
  else message = `${cause}，${event.attemptStarted === true ? "正在执行" : "正在准备"}${attempt}${context.length
    ? `（${context.join("，")}）` : ""}，可取消当前回合`;
  return message;
}

function recoveryMessage(event) {
  const message = recoveryMessageBody(event);
  const duration = [];
  if (nonnegative(event.operationElapsedMs)) duration.push(`累计耗时${event.operationElapsedMs / 1000}秒`);
  if (nonnegative(event.attemptElapsedMs)) duration.push(`本次请求耗时${event.attemptElapsedMs / 1000}秒`);
  return duration.length ? `${message}，${duration.join("，")}` : message;
}

export function recoveryIdentityMatches(envelope, expected) {
  return ["ownerId", "nativeSourceId", "producerId", "producerPid", "connectionGeneration"].every(key =>
    expected?.[key] !== undefined && envelope?.[key] === expected[key])
    && ["core", "helper", "runner", "control"].every(key => typeof expected.sourceHashes?.[key] === "string"
      && envelope.sourceHashes?.[key] === expected.sourceHashes[key]);
}

export function signRecoveryEnvelope(identity, event, capability) {
  const envelope = { ...identity, recovery: structuredClone(event) };
  return { ...envelope, signature: digest(envelope, capability) };
}

export function validateRecoveryEnvelope(envelope, expected, capability) {
  const event = envelope?.recovery;
  if (!recoveryIdentityMatches(envelope, expected) || !event || event.type !== "model_recovery_state"
    || ![event.requestId, event.threadId, event.turnId].every(textId)
    || event.threadId !== expected.threadId || event.turnId !== expected.turnId
    || expected.requestId !== undefined && event.requestId !== expected.requestId
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !phases.has(event.phase)
    || typeof event.willRetry !== "boolean" || typeof event.canContinueHttp !== "boolean"
    || typeof envelope.signature !== "string" || !/^[0-9a-f]{64}$/u.test(envelope.signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(envelope.signature, "hex"), Buffer.from(digest(payload(envelope), capability), "hex"));
}

export function canContinueRecovery(event) {
  return event?.phase === "waiting" && event.canContinueHttp === true
    && ["rejected", "not_sent"].includes(event.acceptance) && textId(event.requestId);
}

export function createRecoveryNotificationRouter({ ownerId, nativeSourceId, bindingFor, sendNotification, limit = 128 }) {
  const pending = new WeakMap();
  const subscriptions = new Map();
  const records = new Map();
  const trim = map => { while (map.size > limit) map.delete(map.keys().next().value); };
  return {
    expectTurn(client, threadId, requestId = Symbol(), connectionGeneration = client.metadataUpstreamGeneration) {
      if (!textId(threadId)) return;
      const requests = pending.get(client) ?? new Map();
      requests.set(requestId, { threadId, connectionGeneration });
      trim(requests);
      pending.set(client, requests);
    },
    rejectExpectedTurn(client, requestId, connectionGeneration) {
      const requests = pending.get(client);
      const expected = requests?.get(requestId);
      if (!expected || expected.connectionGeneration !== connectionGeneration) return false;
      return requests.delete(requestId);
    },
    observeNative(client, message, connectionGeneration) {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turn?.id;
      const requests = pending.get(client);
      const expected = message.method === "turn/started" && textId(turnId)
        ? [...(requests ?? [])].find(([, request]) => request.threadId === threadId
          && request.connectionGeneration === connectionGeneration) : null;
      if (expected) {
        requests.delete(expected[0]);
        const previous = subscriptions.get(threadId);
        if (previous && previous.turnId === turnId && previous.client !== client) return false;
        subscriptions.set(threadId, { client, turnId, connectionGeneration, active: true });
        trim(subscriptions);
        return true;
      }
      const subscription = subscriptions.get(threadId);
      if (message.method === "turn/completed" && subscription?.turnId === turnId) subscription.active = false;
      return subscription?.active === true && subscription.client === client && subscription.turnId === turnId;
    },
    accept(envelope) {
      const event = envelope?.recovery;
      if (!event) return { accepted: false };
      const subscription = subscriptions.get(event.threadId);
      const expected = bindingFor(event.threadId, event.turnId, event.requestId);
      if (!subscription?.active || subscription.turnId !== event.turnId || subscription.client.closed
        || subscription.client.metadataUpstreamGeneration !== subscription.connectionGeneration
        || envelope.ownerId !== ownerId || envelope.nativeSourceId !== nativeSourceId
        || envelope.connectionGeneration !== subscription.connectionGeneration
        || !recoveryIdentityMatches(envelope, expected)
        || JSON.stringify(expected?.current) !== JSON.stringify(envelope)) return { accepted: false };
      const producer = [envelope.producerId, envelope.producerPid, envelope.connectionGeneration,
        ...["core", "helper", "runner", "control"].map(name => envelope.sourceHashes[name])];
      const key = JSON.stringify([event.threadId, event.turnId, event.requestId, producer]);
      const previous = records.get(key);
      if (previous?.terminal || event.sequence <= (previous?.sequence ?? 0)) return { accepted: false };
      if (!previous && records.size >= limit) {
        for (const [recordKey, record] of records) {
          const active = subscriptions.get(record.threadId);
          if (!active?.active || active.turnId !== record.turnId) records.delete(recordKey);
        }
        if (records.size >= limit) return { accepted: false };
      }
      const details = recoveryDetails(event, previous);
      const recoveryCycle = recoveryCycleIdentity(details, previous);
      const record = { ...details, displayState: event.phase === "stopped" ? recoveryProgressState(details) : event.phase,
        recoveryCycle,
        progressState: recoveryProgressState(details),
        actionRequired: canContinueRecovery(details) ? "choose_http_or_cancel" : event.phase === "waiting" && !details.willRetry
          ? details.acceptance === "unknown" ? "verify_request_state" : "cancel_or_verify" : "none",
        terminal: terminal.has(event.phase), noticeKeys: event.phase === "resumed" ? {} : { ...previous?.noticeKeys } };
      records.set(key, record);
      const cycle = automaticRecoveryCycle(details, recoveryCycle);
      const mergedCycle = cycle ? JSON.stringify([producer, cycle]) : null;
      if (mergedCycle !== record.noticeKeys.automaticRecoveryCycle) delete record.noticeKeys.automaticRecoveryCycle;
      if (!["waiting", "retrying"].includes(event.phase) || !details.willRetry || details.canContinueHttp) {
        return { accepted: true, notified: false };
      }
      if (event.phase === "retrying" && mergedCycle && record.noticeKeys.automaticRecoveryCycle === mergedCycle) {
        return { accepted: true, notified: false };
      }
      const noticeKey = JSON.stringify([details.serverAttempt, details.nextServerAttempt, details.retryNumber,
        details.admissionRetryNumber, details.waitContext, details.transport, details.nextTransport,
        details.retryAction, details.willRetry, details.canContinueHttp, mergedCycle, details.reason, details.originalReason,
        details.category, details.code, details.acceptance, details.httpStatusCode, details.failureDiagnostics]);
      if (record.noticeKeys[record.progressState] === noticeKey) return { accepted: true, notified: false };
      const status = details.httpStatusCode >= 400 ? details.httpStatusCode : null;
      const notification = { method: "error", params: { threadId: event.threadId, turnId: event.turnId,
        willRetry: details.willRetry, error: { message: recoveryMessage(details),
          additionalDetails: JSON.stringify({ modelRecovery: { version: 1, ...details, progressState: record.progressState } }),
          ...(status ? { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } } } : {}) } } };
      const sent = sendNotification(subscription.client, notification, { connectionGeneration: subscription.connectionGeneration });
      if (sent === true) {
        record.noticeKeys[record.progressState] = noticeKey;
        if (mergedCycle && (event.phase === "waiting" || recoveryCycle.kind === "http_retry")) {
          record.noticeKeys.automaticRecoveryCycle = mergedCycle;
        }
      }
      return { accepted: true, notified: sent === true };
    },
    closeClient(client) {
      pending.delete(client);
      for (const subscription of subscriptions.values()) if (subscription.client === client) subscription.active = false;
    },
    status() { return [...records.values()].map(({ noticeKeys, terminal: finished, ...record }) => structuredClone(record)); },
  };
}
