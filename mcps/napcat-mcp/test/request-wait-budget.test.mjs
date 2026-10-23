import assert from "node:assert/strict";
import test from "node:test";
import { createRequestWaitBudget, mergeRequestWaitState, requestUploadAllowanceMs, DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB } from "../src/request-wait-budget.mjs";

test("upload allowance uses encoded bytes, rounds milliseconds and has a cap", () => {
  assert.equal(requestUploadAllowanceMs(0), 0);
  assert.equal(requestUploadAllowanceMs(1), 1);
  assert.equal(DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB, 33555);
  assert.equal(requestUploadAllowanceMs(1024 * 1024), 33555);
  assert.equal(requestUploadAllowanceMs(72_254_445), Math.ceil(72_254_445 / 1048576 * 33555));
  assert.equal(requestUploadAllowanceMs(200 * 1024 * 1024), 128 * 33555);
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

test("trusted preparation acknowledgements renew waiting without claiming business progress", () => {
  const budget = createRequestWaitBudget({ startedAt: 1000, uploadAllowanceMs: 70,
    waitLimitMs: 300, previous: { waitBudgetSpentMs: 250 } });
  budget.notePreparation(1100);
  assert.equal(budget.deadline(), 1400);
  assert.equal(budget.hasProgress(), false);
  assert.equal(budget.firstProgressDelayMs(), null);
  assert.deepEqual(budget.snapshot(1120), { waitBudgetProgressAt: 0, waitBudgetSpentMs: 20 });
  budget.notePreparation(1300);
  assert.equal(budget.deadline(), 1600);
  assert.equal(budget.noteProgress(1400), true);
  assert.equal(budget.firstProgressDelayMs(), 400);
});

test("each packet upload allowance protects only its own upload before business progress", () => {
  const budget = createRequestWaitBudget({ startedAt: 1000, uploadAllowanceMs: 5, waitLimitMs: 100 });
  budget.noteUpload(1020, 400);
  assert.equal(budget.uploadDeadline(), 1420);
  assert.equal(budget.deadline(), 1505);
  assert.equal(budget.remainingMs(1390), 85);
  budget.notePreparation(1450);
  budget.noteUpload(1450, 250);
  assert.equal(budget.uploadDeadline(), 1700);
  assert.equal(budget.snapshot(1720).waitBudgetSpentMs, 20);
  assert.equal(budget.hasProgress(), false);
  assert.throws(() => budget.noteUpload(1800, -1), RangeError);
  assert.equal(budget.uploadDeadline(), 1700);
  budget.noteProgress(1750);
  assert.equal(budget.uploadDeadline(), 1000);
  assert.equal(budget.deadline(), 1850);
});

test("local packet sending preserves inherited waiting until a trusted preparation acknowledgement", () => {
  const budget = createRequestWaitBudget({ startedAt: 1000, uploadAllowanceMs: 0, waitLimitMs: 300,
    previous: { waitBudgetProgressAt: 0, waitBudgetSpentMs: 250 } });
  assert.equal(budget.deadline(), 1050);
  budget.noteUpload(1000, 100);
  assert.equal(budget.deadline(), 1150);
  assert.deepEqual(budget.snapshot(1100), { waitBudgetProgressAt: 0, waitBudgetSpentMs: 250 });
  assert.equal(budget.hasProgress(), false);
  budget.noteUpload(1120, 200);
  assert.equal(budget.deadline(), 1350);
  assert.equal(budget.snapshot(1120).waitBudgetSpentMs, 270);
  budget.notePreparation(1300);
  budget.noteUpload(1300, 100);
  assert.equal(budget.deadline(), 1700);
  assert.equal(budget.snapshot(1400).waitBudgetSpentMs, 0);
  assert.equal(budget.hasProgress(), false);
});
