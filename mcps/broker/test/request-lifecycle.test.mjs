import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_REQUEST_META_KEY,
  attachBrokerRequestMeta,
  createBackendRequestOptions,
  createBrokerBackendTimeoutResult,
  createBrokerRequestTimeoutError,
  isFatalBackendTransportError,
  isRequestTimeoutError,
  remainingBudgetMs,
  resolveToolCallBudget,
  shouldTrackBackendWork,
} from "../request-lifecycle.mjs";

test("long-lived GET subscriptions do not block scoped backend reload", () => {
  assert.equal(shouldTrackBackendWork("GET"), false);
  assert.equal(shouldTrackBackendWork("get"), false);
});

test("mutating and request-bearing methods still drain before reload", () => {
  assert.equal(shouldTrackBackendWork("POST"), true);
  assert.equal(shouldTrackBackendWork("DELETE"), true);
  assert.equal(shouldTrackBackendWork(undefined), true);
});

test("tool call budget keeps the broker default and caps caller extensions", () => {
  const defaults = { requestTimeoutMs: 120000, waitTimeoutCapMs: 1800000, nowMs: 1000 };
  assert.deepEqual(resolveToolCallBudget({}, defaults), {
    timeoutMs: 120000,
    timeoutSource: "broker_default",
    deadlineOwner: "broker",
    deadlineAtMs: 121000,
  });
  assert.deepEqual(resolveToolCallBudget({ timeout: 300000 }, defaults), {
    timeoutMs: 315000,
    timeoutSource: "caller_execution_timeout",
    deadlineOwner: "caller",
    deadlineAtMs: 316000,
  });
  assert.deepEqual(resolveToolCallBudget({ timeout: 120000 }, defaults), {
    timeoutMs: 135000,
    timeoutSource: "caller_execution_timeout",
    deadlineOwner: "caller",
    deadlineAtMs: 136000,
  });
  assert.deepEqual(resolveToolCallBudget({ timeout: 1000 }, defaults), {
    timeoutMs: 120000,
    timeoutSource: "caller_execution_timeout",
    deadlineOwner: "broker",
    deadlineAtMs: 121000,
  });
  assert.deepEqual(resolveToolCallBudget({ waitSeconds: 4000 }, defaults), {
    timeoutMs: 1800000,
    timeoutSource: "caller_wait_seconds",
    deadlineOwner: "broker",
    deadlineAtMs: 1801000,
  });
  assert.deepEqual(resolveToolCallBudget({ timeout: 0 }, defaults), {
    timeoutMs: 1800000,
    timeoutSource: "caller_no_execution_timeout",
    deadlineOwner: "broker",
    deadlineAtMs: 1801000,
  });
});

test("broker metadata preserves caller metadata and exposes one absolute deadline", () => {
  const params = attachBrokerRequestMeta(
    { name: "sandbox_exec", arguments: { command: "echo ok" }, _meta: { traceId: "abc" } },
    { timeoutMs: 120000, timeoutSource: "broker_default", deadlineOwner: "broker", deadlineAtMs: 121000 },
  );
  assert.equal(params._meta.traceId, "abc");
  assert.deepEqual(params._meta[BROKER_REQUEST_META_KEY], {
    schemaVersion: 1,
    timeoutMs: 120000,
    timeoutSource: "broker_default",
    deadlineOwner: "broker",
    deadlineAtMs: 121000,
  });
});

test("backend request options propagate cancellation and enforce a total deadline", () => {
  const controller = new AbortController();
  assert.deepEqual(createBackendRequestOptions(45000, controller.signal), {
    timeout: 45000,
    maxTotalTimeout: 45000,
    signal: controller.signal,
  });
  assert.equal(remainingBudgetMs(1000, 250), 750);
  assert.equal(remainingBudgetMs(1000, 1250), 0);
});

test("only MCP request timeout errors become broker backend timeout results", () => {
  assert.equal(isRequestTimeoutError({ code: -32001 }), false);
  assert.equal(isRequestTimeoutError({
    code: -32001,
    message: "Request timed out",
    data: { timeout: 120000 },
  }), true);
  assert.equal(isRequestTimeoutError(createBrokerRequestTimeoutError("connect timed out", { timeout: 1000 })), true);
  assert.equal(isRequestTimeoutError(new Error("command execution timed out")), false);
  const result = createBrokerBackendTimeoutResult({
    endpoint: "sandbox",
    toolName: "sandbox_exec",
    budget: { timeoutMs: 120000, timeoutSource: "broker_default", deadlineOwner: "broker", deadlineAtMs: 121000 },
    backendStatus: { generation: 2, pid: 1234 },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorType, "broker_backend_timeout");
  assert.equal(result.structuredContent.retryable, false);
  assert.equal(result.structuredContent.mayHaveStarted, true);
  assert.match(result.content[0].text, /^broker_backend_timeout:/);

  const callerResult = createBrokerBackendTimeoutResult({
    endpoint: "sandbox",
    toolName: "sandbox_exec",
    budget: { timeoutMs: 315000, timeoutSource: "caller_execution_timeout", deadlineOwner: "caller", deadlineAtMs: 316000 },
    backendStatus: { generation: 2, pid: 1234 },
  });
  assert.equal(callerResult.structuredContent.errorType, "caller_deadline_exceeded");
  assert.equal(callerResult.structuredContent.totalMs, 315000);
  assert.match(callerResult.content[0].text, /^caller_deadline_exceeded:/);
});

test("fatal backend transport errors are separated from ordinary tool failures", () => {
  assert.equal(isFatalBackendTransportError(new Error("Transport send error: HTTP request failed")), true);
  const nested = new Error("outer failure", { cause: Object.assign(new Error("write failed"), { code: "EPIPE" }) });
  assert.equal(isFatalBackendTransportError(nested), true);
  assert.equal(isFatalBackendTransportError(new Error("transport is not connected")), true);
  assert.equal(isFatalBackendTransportError(new Error("service is not connected to the configured account")), false);
  assert.equal(isFatalBackendTransportError(new Error("HTTP request failed")), false);
  assert.equal(isFatalBackendTransportError({ code: -32001, message: "Request timed out" }), false);
});
