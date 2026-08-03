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

  if (args.timeout === 0) {
    timeoutMs = waitTimeoutCapMs;
    timeoutSource = "caller_no_execution_timeout";
  } else if (typeof args.waitSeconds === "number" && args.waitSeconds > 0) {
    timeoutMs = Math.min(
      Math.max(args.waitSeconds * 1000 + 15000, requestTimeoutMs),
      waitTimeoutCapMs,
    );
    timeoutSource = "caller_wait_seconds";
  } else if (typeof args.timeout === "number" && args.timeout > requestTimeoutMs) {
    timeoutMs = Math.min(args.timeout + 15000, waitTimeoutCapMs);
    timeoutSource = "caller_execution_timeout";
  }

  return {
    timeoutMs,
    timeoutSource,
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
  const details = {
    errorType: "broker_backend_timeout",
    message: "Broker 与后端通信超过总期限；不能据此判断命令是否已经启动。",
    endpoint,
    toolName,
    timeoutMs: budget.timeoutMs,
    deadlineAtMs: budget.deadlineAtMs,
    backendStatus,
    retryable: false,
    mayHaveStarted: true,
    retryAdvice: "先检查 backend 状态或命令副作用，再决定是否重试。",
  };
  return {
    isError: true,
    content: [{ type: "text", text: `${details.errorType}: ${details.message}` }],
    structuredContent: details,
  };
}
