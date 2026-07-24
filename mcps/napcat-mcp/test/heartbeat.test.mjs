import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHeartbeatInput,
  loadHeartbeatConfig,
  runHeartbeatAttempt,
} from "../src/heartbeat.mjs";

function createHeartbeatFixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-heartbeat-test-"));
  const configPath = path.join(root, "heartbeat.json");
  const runtimeStatePath = path.join(root, "state", "heartbeat-runtime.json");
  const logPath = path.join(root, "state", "heartbeat.jsonl");
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    taskId: "training-001",
    runId: "run-001",
    intervalMinutes: 30,
    summary: "训练正常",
    progress: "epoch 2/10",
    checkpointAt: "checkpoint-002",
    ...overrides,
  }, null, 2)}\n`, "utf8");
  return {
    root,
    configPath,
    runtimeStatePath,
    logPath,
    close() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("heartbeat config creates a stable time-slot dedupe key", () => {
  const fixture = createHeartbeatFixture();
  try {
    const config = loadHeartbeatConfig(fixture.configPath);
    const now = new Date("2026-07-24T06:00:00.000Z");
    const first = buildHeartbeatInput(config, now);
    const second = buildHeartbeatInput(config, new Date("2026-07-24T06:20:00.000Z"));
    assert.equal(first.dedupe_key, second.dedupe_key);
    assert.equal(first.next_check_at, "2026-07-24T06:30:00.000Z");
    assert.equal(first.checkpoint_at, "checkpoint-002");
  } finally {
    fixture.close();
  }
});

test("heartbeat attempt records successful send without secrets", async () => {
  const fixture = createHeartbeatFixture();
  try {
    const inputs = [];
    const result = await runHeartbeatAttempt({
      notifier: {
        async sendTrainingEvent(input) {
          inputs.push(input);
          return { sent: true, verified: true, messageId: "1001" };
        },
      },
      configPath: fixture.configPath,
      runtimeStatePath: fixture.runtimeStatePath,
      logPath: fixture.logPath,
      pid: 1234,
      now: () => new Date("2026-07-24T06:00:00.000Z"),
    });
    assert.equal(inputs.length, 1);
    assert.equal(result.result.sent, true);
    const state = JSON.parse(fs.readFileSync(fixture.runtimeStatePath, "utf8"));
    assert.equal(state.status, "running");
    assert.equal(state.pid, 1234);
    assert.equal(state.lastSuccessAt, "2026-07-24T06:00:00.000Z");
    const log = fs.readFileSync(fixture.logPath, "utf8");
    assert.match(log, /"ok":true/);
    assert.doesNotMatch(log, /token|authorization/i);
  } finally {
    fixture.close();
  }
});

test("heartbeat attempt records an error and lets the runner continue", async () => {
  const fixture = createHeartbeatFixture();
  try {
    const result = await runHeartbeatAttempt({
      notifier: {
        async sendTrainingEvent() {
          const error = new Error("NapCat 暂时离线");
          error.code = "NAPCAT_NOT_READY";
          throw error;
        },
      },
      configPath: fixture.configPath,
      runtimeStatePath: fixture.runtimeStatePath,
      logPath: fixture.logPath,
      pid: 1234,
      now: () => new Date("2026-07-24T06:00:00.000Z"),
    });
    assert.equal(result.error.code, "NAPCAT_NOT_READY");
    const state = JSON.parse(fs.readFileSync(fixture.runtimeStatePath, "utf8"));
    assert.equal(state.status, "running");
    assert.equal(state.lastError.code, "NAPCAT_NOT_READY");
    assert.match(fs.readFileSync(fixture.logPath, "utf8"), /"ok":false/);
  } finally {
    fixture.close();
  }
});
