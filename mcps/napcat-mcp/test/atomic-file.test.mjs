import assert from "node:assert/strict";
import test from "node:test";
import { renameReplaceSync } from "../src/atomic-file.mjs";

test("Windows transient rename failures use bounded exponential retry", () => {
  const delays = [];
  let attempts = 0;
  renameReplaceSync("source", "destination", {
    platform: "win32",
    maximumAttempts: 6,
    initialDelayMs: 10,
    sleep: (milliseconds) => delays.push(milliseconds),
    renameSync: () => {
      attempts += 1;
      if (attempts < 4) {
        const error = new Error("busy");
        error.code = attempts === 1 ? "EPERM" : attempts === 2 ? "EBUSY" : "EACCES";
        throw error;
      }
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 40]);
});

test("non-Windows and non-transient rename failures are not retried", () => {
  for (const [platform, code] of [["linux", "EPERM"], ["win32", "ENOENT"]]) {
    let attempts = 0;
    assert.throws(() => renameReplaceSync("source", "destination", {
      platform,
      sleep: () => assert.fail("sleep must not run"),
      renameSync: () => {
        attempts += 1;
        const error = new Error(code);
        error.code = code;
        throw error;
      },
    }), (error) => error?.code === code);
    assert.equal(attempts, 1);
  }
});

test("Windows transient rename retries stop at the configured limit", () => {
  let attempts = 0;
  assert.throws(() => renameReplaceSync("source", "destination", {
    platform: "win32",
    maximumAttempts: 3,
    initialDelayMs: 1,
    sleep: () => {},
    renameSync: () => {
      attempts += 1;
      const error = new Error("busy");
      error.code = "EPERM";
      throw error;
    },
  }), (error) => error?.code === "EPERM");
  assert.equal(attempts, 3);
});
