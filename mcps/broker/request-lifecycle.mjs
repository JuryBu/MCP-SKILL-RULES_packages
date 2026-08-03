export const BROKER_REQUEST_META_KEY = "io.github.jurybu/broker";

const REQUEST_TIMEOUT_ERROR_CODE = -32001;

export function shouldTrackBackendWork(method) {
  return String(method ?? "").toUpperCase() !== "GET";
}

export function resolveToolCallBudget(args, options) {
  const requestTimeoutMs = options.requestTimeoutMs;
  const waitTimeoutCapMs = options.waitTimeoutCapMs;
  const nowMs = options.nowMs ?? Date.now();
  let timeoutMs = requestTimeoutMs;
  let timeoutSource = "broker_default";
  let deadlineOwner = "broker";

  if (args.timeout === 0) {
    timeoutMs = waitTimeoutCapMs;
    timeoutSource = "caller_no_execution_timeout";
  } else if (typeof args.waitSeconds === "number" && args.waitSeconds > 0) {
    const requestedTimeoutMs = Math.max(args.waitSeconds * 1000 + 15000, requestTimeoutMs);
    timeoutMs = Math.min(requestedTimeoutMs, waitTimeoutCapMs);
    timeoutSource = "caller_wait_seconds";
    deadlineOwner = requestedTimeoutMs <= waitTimeoutCapMs && requestedTimeoutMs > requestTimeoutMs ? "caller" : "broker";
  } else if (typeof args.timeout === "number" && args.timeout > 0) {
    const requestedTimeoutMs = Math.max(args.timeout + 15000, requestTimeoutMs);
    timeoutMs = Math.min(requestedTimeoutMs, waitTimeoutCapMs);
    timeoutSource = "caller_execution_timeout";
    deadlineOwner = requestedTimeoutMs <= waitTimeoutCapMs && requestedTimeoutMs > requestTimeoutMs ? "caller" : "broker";
  }

  return {
    timeoutMs,
    timeoutSource,
    deadlineOwner,
    deadlineAtMs: nowMs + timeoutMs,
  };
}

export function attachBrokerRequestMeta(params, budget) {
  const existingMeta = params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta)
    ? params._meta
    : {};
  return {
    ...params,
    _meta: {
      ...existingMeta,
      [BROKER_REQUEST_META_KEY]: {
        schemaVersion: 1,
        timeoutMs: budget.timeoutMs,
        timeoutSource: budget.timeoutSource,
        deadlineOwner: budget.deadlineOwner,
        deadlineAtMs: budget.deadlineAtMs,
      },
    },
  };
}

export function createBackendRequestOptions(timeoutMs, signal) {
  return {
    timeout: timeoutMs,
    maxTotalTimeout: timeoutMs,
    ...(signal ? { signal } : {}),
  };
}

export function remainingBudgetMs(deadlineAtMs, nowMs = Date.now()) {
  return Math.max(0, Math.floor(deadlineAtMs - nowMs));
}

export function createBrokerRequestTimeoutError(message, data = {}) {
  const error = new Error(message);
  error.code = REQUEST_TIMEOUT_ERROR_CODE;
  error.brokerRequestTimeout = true;
  error.data = data;
  return error;
}

export function isRequestTimeoutError(error) {
  if (error?.brokerRequestTimeout === true) return true;
  if (Number(error?.code) !== REQUEST_TIMEOUT_ERROR_CODE) return false;
  const hasSdkTimeoutData = Number.isFinite(error?.data?.timeout) || Number.isFinite(error?.data?.maxTotalTimeout);
  const hasSdkTimeoutMessage = error?.message?.includes("Request timed out")
    || error?.message?.includes("Maximum total timeout exceeded");
  return hasSdkTimeoutData && hasSdkTimeoutMessage;
}

export function createBrokerBackendTimeoutResult({ endpoint, toolName, budget, backendStatus }) {
  const callerDeadline = budget.deadlineOwner === "caller";
  const details = {
    errorType: callerDeadline ? "caller_deadline_exceeded" : "broker_backend_timeout",
    message: callerDeadline
      ? "排队与执行合计超过调用方总期限；不能据此判断命令是否已经启动。"
      : "Broker 与后端通信超过自身总期限；不能据此判断命令是否已经启动。",
    endpoint,
    toolName,
    timeoutMs: budget.timeoutMs,
    timeoutSource: budget.timeoutSource,
    deadlineOwner: budget.deadlineOwner,
    deadlineAtMs: budget.deadlineAtMs,
    totalMs: budget.timeoutMs,
    queueWaitMs: null,
    runMs: null,
    backendStatus,
    retryable: false,
    mayHaveStarted: true,
    retryAdvice: callerDeadline
      ? "调用方总期限已耗尽；先检查任务状态和副作用，再提高总期限或改用后台模式。"
      : "先检查 backend 状态或命令副作用，再决定是否重试。",
  };
  return {
    isError: true,
    content: [{ type: "text", text: `${details.errorType}: ${details.message}` }],
    structuredContent: details,
  };
}
