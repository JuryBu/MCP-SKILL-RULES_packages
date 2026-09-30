import assert from "node:assert/strict";
import test from "node:test";
import { createRequestWaitBudget, mergeRequestWaitState, requestUploadAllowanceMs } from "../src/request-wait-budget.mjs";

test("upload allowance uses encoded bytes, rounds milliseconds and has a cap", () => {
  assert.equal(requestUploadAllowanceMs(0), 0);
  assert.equal(requestUploadAllowanceMs(1), 1);
  assert.equal(requestUploadAllowanceMs(1024 * 1024), 1000);
  assert.equal(requestUploadAllowanceMs(72_254_445), 68_908);
  assert.equal(requestUploadAllowanceMs(200 * 1024 * 1024), 128_000);
  assert.equal(requestUploadAllowanceMs(1024, 0), 0);
  assert.throws(() => requestUploadAllowanceMs(-1), RangeError);
});

test("upload allowance and the reconnect gap do not debit the recovery balance", () => {
  const first = createRequestWaitBudget({ startedAt: 1000, uploadAllowanceMs: 70, waitLimitMs: 300 });
  assert.equal(first.deadline(), 1370);
  assert.equal(first.remainingMs(1050), 300);
  assert.equal(first.snapshot(1110).waitBudgetSpentMs, 40);
  const retry = createRequestWaitBudget({ startedAt: 10_000, uploadAllowanceMs: 70,
    waitLimitMs: 300, previous: first.snapshot(1110) });
  assert.equal(retry.deadline(), 10_330);
  assert.equal(retry.remainingMs(10_020), 260);
  assert.equal(retry.snapshot(10_160).waitBudgetSpentMs, 130);
});

test("meaningful progress ends the startup allowance and permits a healthy long response", () => {
  const budget = createRequestWaitBudget({ startedAt: 1000, uploadAllowanceMs: 70,
    waitLimitMs: 300, previous: { waitBudgetSpentMs: 290 } });
  assert.equal(budget.noteProgress(1050), true);
  assert.equal(budget.firstProgressDelayMs(), 50);
  assert.equal(budget.deadline(), 1350);
  assert.equal(budget.noteProgress(1300), false);
  budget.noteProgress(1550);
  assert.equal(budget.deadline(), 1850);
  assert.equal(budget.snapshot(1560).waitBudgetSpentMs, 10);
});

test("older completion bookkeeping cannot restore a consumed balance after newer progress", () => {
  const newer = { waitBudgetProgressAt: 500, waitBudgetSpentMs: 20 };
  assert.deepEqual(mergeRequestWaitState(newer, { waitBudgetProgressAt: 0, waitBudgetSpentMs: 280 }), newer);
  assert.deepEqual(mergeRequestWaitState({ waitBudgetProgressAt: 0, waitBudgetSpentMs: 280 }, newer), newer);
  assert.deepEqual(mergeRequestWaitState(newer, { waitBudgetProgressAt: 500, waitBudgetSpentMs: 30 }),
    { waitBudgetProgressAt: 500, waitBudgetSpentMs: 30 });
});
