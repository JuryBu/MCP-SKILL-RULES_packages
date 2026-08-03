import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_REQUEST_META_KEY,
  attachBrokerRequestMeta,
  createBackendRequestOptions,
  createBrokerBackendTimeoutResult,
  createBrokerRequestTimeoutError,
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
    deadlineAtMs: 121000,
  });
  assert.deepEqual(resolveToolCallBudget({ timeout: 300000 }, defaults), {
    timeoutMs: 315000,
    timeoutSource: "caller_execution_timeout",
    deadlineAtMs: 316000,
  });
  assert.deepEqual(resolveToolCallBudget({ waitSeconds: 4000 }, defaults), {
    timeoutMs: 1800000,
    timeoutSource: "caller_wait_seconds",
    deadlineAtMs: 1801000,
  });
  assert.deepEqual(resolveToolCallBudget({ timeout: 0 }, defaults), {
    timeoutMs: 1800000,
    timeoutSource: "caller_no_execution_timeout",
    deadlineAtMs: 1801000,
  });
});

test("broker metadata preserves caller metadata and exposes one absolute deadline", () => {
  const params = attachBrokerRequestMeta(
    { name: "sandbox_exec", arguments: { command: "echo ok" }, _meta: { traceId: "abc" } },
    { timeoutMs: 120000, timeoutSource: "broker_default", deadlineAtMs: 121000 },
  );
  assert.equal(params._meta.traceId, "abc");
  assert.deepEqual(params._meta[BROKER_REQUEST_META_KEY], {
    schemaVersion: 1,
    timeoutMs: 120000,
    timeoutSource: "broker_default",
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
    budget: { timeoutMs: 120000, deadlineAtMs: 121000 },
    backendStatus: { generation: 2, pid: 1234 },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorType, "broker_backend_timeout");
  assert.equal(result.structuredContent.retryable, false);
  assert.equal(result.structuredContent.mayHaveStarted, true);
  assert.match(result.content[0].text, /^broker_backend_timeout:/);
});
