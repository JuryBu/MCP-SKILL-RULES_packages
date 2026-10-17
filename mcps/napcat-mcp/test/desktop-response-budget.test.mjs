import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopResponseBudgetError,
  DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES,
  DESKTOP_RESPONSE_BUDGET_ERROR_CODE,
} from "../src/codex-app-server-proxy.mjs";

function oversizedHistory(overrides = {}) {
  return {
    requestId: "history-request",
    method: "thread/read",
    responseBytes: 33,
    limit: 32,
    ...overrides,
  };
}

test("default budget leaves headroom below the Desktop 100 MiB receiver limit", () => {
  assert.equal(DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES, 64 * 1024 * 1024);
  assert.ok(DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES < 100 * 1024 * 1024);
  assert.equal(createDesktopResponseBudgetError({
    requestId: "at-default-limit",
    method: "thread/read",
    responseBytes: DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES,
  }), null);
  const response = createDesktopResponseBudgetError({
    requestId: "over-default-limit",
    method: "thread/read",
    responseBytes: DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES + 1,
  });
  assert.equal(response.error.data.limit, DEFAULT_DESKTOP_RESPONSE_LIMIT_BYTES);
});

for (const method of ["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"]) {
  test(`oversized ${method} returns a matching RPC error`, () => {
    const response = createDesktopResponseBudgetError(oversizedHistory({ method }));
    assert.equal(response.id, "history-request");
    assert.equal(response.error.code, DESKTOP_RESPONSE_BUDGET_ERROR_CODE);
    assert.ok(response.error.code >= -32099 && response.error.code <= -32000);
    assert.deepEqual(Object.keys(response).sort(), ["error", "id"]);
    assert.equal(response.error.data.reason, "DESKTOP_RESPONSE_BUDGET_EXCEEDED");
    assert.equal(response.error.data.method, method);
    assert.equal(response.error.data.bytes, 33);
    assert.equal(response.error.data.limit, 32);
    assert.equal(response.error.data.retrySameRequest, false);
  });
}

test("errors carry usable summary and cursor pagination guidance", () => {
  const response = createDesktopResponseBudgetError(oversizedHistory());
  assert.deepEqual(response.error.data.pagination, {
    summaryMethod: "thread/read",
    includeTurns: false,
    turnsMethod: "thread/turns/list",
    itemsMethod: "thread/items/list",
    itemsView: "notLoaded",
    useCursor: true,
  });
  assert.match(response.error.data.hint, /threadId/);
  assert.match(response.error.data.hint, /nextCursor/);
});

test("resume errors preserve the possibility that upstream state already changed", () => {
  const response = createDesktopResponseBudgetError(oversizedHistory({ method: "thread/resume" }));
  assert.equal(response.error.data.upstreamStateMayHaveChanged, true);
  assert.match(response.error.data.hint, /先核对线程状态/);
  assert.equal(createDesktopResponseBudgetError(oversizedHistory()).error.data.upstreamStateMayHaveChanged, false);
});

test("small responses and the exact boundary return null without replacing a response", () => {
  for (const responseBytes of [0, 1, 31, 32]) {
    assert.equal(createDesktopResponseBudgetError(oversizedHistory({ responseBytes })), null);
  }
});

test("custom budgets are applied without allocating a response body", () => {
  assert.equal(createDesktopResponseBudgetError(oversizedHistory({ limit: 64 })), null);
  const response = createDesktopResponseBudgetError(oversizedHistory({ responseBytes: 2, limit: 1 }));
  assert.equal(response.error.data.bytes, 2);
  assert.equal(response.error.data.limit, 1);
});

test("string and finite numeric request IDs retain their value and type", () => {
  for (const requestId of ["", "request-1", "01", "0010000000000000000000", 0, -7, 1.5]) {
    const response = createDesktopResponseBudgetError(oversizedHistory({ requestId }));
    assert.equal(response.id, requestId);
    assert.equal(typeof response.id, typeof requestId);
    assert.equal(JSON.parse(JSON.stringify(response)).id, requestId);
  }
});

test("missing and invalid IDs never manufacture notification responses", () => {
  assert.equal(createDesktopResponseBudgetError(), null);
  for (const requestId of [undefined, null, false, true, {}, [], NaN, Infinity, -Infinity, 1n]) {
    assert.equal(createDesktopResponseBudgetError(oversizedHistory({ requestId })), null);
  }
});

test("notifications, non-history RPCs and similar method names are untouched", () => {
  for (const method of [
    "turn/start", "item/completed", "thread/status/changed", "thread/list", "thread/fork",
    "tools/call", "thread/read/", "thread/readAnything", "THREAD/READ", " thread/read",
    "thread/read ", "", undefined, null, {}, ["thread/read"],
  ]) {
    assert.equal(createDesktopResponseBudgetError(oversizedHistory({ method })), null);
  }
  assert.equal(createDesktopResponseBudgetError(oversizedHistory({ requestId: undefined })), null);
});

test("invalid byte counts never create misleading budget errors", () => {
  for (const responseBytes of [undefined, null, "33", -1, 1.5, NaN, Infinity, -Infinity, {}, 33n, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(createDesktopResponseBudgetError(oversizedHistory({ responseBytes })), null);
  }
});

test("invalid configuration fails explicitly for a matched history request", () => {
  for (const limit of [null, "32", 0, -1, 1.5, NaN, Infinity, {}, 32n, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createDesktopResponseBudgetError(oversizedHistory({ limit })), RangeError);
  }
});

test("irrelevant methods and notifications need no budget configuration", () => {
  assert.equal(createDesktopResponseBudgetError(oversizedHistory({ method: "turn/start", limit: 0 })), null);
  assert.equal(createDesktopResponseBudgetError(oversizedHistory({ requestId: null, limit: 0 })), null);
});

test("the pure function leaves inputs unchanged and returns independent error objects", () => {
  const input = Object.freeze(oversizedHistory());
  const first = createDesktopResponseBudgetError(input);
  const second = createDesktopResponseBudgetError(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, oversizedHistory());
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.error, second.error);
  assert.notStrictEqual(first.error.data, second.error.data);
  assert.notStrictEqual(first.error.data.pagination, second.error.data.pagination);
  first.error.data.pagination.includeTurns = true;
  assert.equal(second.error.data.pagination.includeTurns, false);
});
