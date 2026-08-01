import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireInstanceLock,
  parseArguments,
  runCodexAppServerProxyService,
} from "../src/codex-app-server-proxy-runner.mjs";

function runtimePaths(root) {
  return {
    runtimeStatePath: path.join(root, "proxy-runtime.json"),
    logPath: path.join(root, "proxy.jsonl"),
    stopFilePath: path.join(root, "proxy.stop"),
    lockPath: path.join(root, "proxy.lock"),
    journalPath: path.join(root, "wake-journal.json"),
    tokenFilePath: path.join(root, "proxy-token.txt"),
    maintenanceFilePath: path.join(root, "task-router.maintenance.json"),
    alertFilePath: path.join(root, "proxy-alert.json"),
    fallbackFilePath: path.join(root, "proxy-fallback.json"),
    downstreamPort: 18452,
    controlPort: 18451,
    upstreamPort: 18453,
    probePort: 18454,
    startTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  };
}

test("parseArguments requires all durable state paths", () => {
  const root = path.resolve("test-root");
  const parsed = parseArguments([
    "--runtime-state", path.join(root, "runtime.json"),
    "--log", path.join(root, "proxy.jsonl"),
    "--stop-file", path.join(root, "proxy.stop"),
    "--lock", path.join(root, "proxy.lock"),
    "--journal", path.join(root, "journal.json"),
    "--token-file", path.join(root, "token.txt"),
    "--maintenance-file", path.join(root, "maintenance.json"),
    "--alert-file", path.join(root, "alert.json"),
    "--fallback-file", path.join(root, "fallback.json"),
  ]);
  assert.equal(parsed.downstreamPort, 18432);
  assert.equal(parsed.controlPort, 18431);
  assert.equal(parsed.upstreamPort, 18433);
});

test("missing compatible Codex binary pauses automation and requests native fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-runner-test-"));
  const paths = runtimePaths(root);
  const result = await runCodexAppServerProxyService({
    ...paths,
    localAppData: path.join(root, "missing-local-app-data"),
    pid: process.pid,
  });
  assert.equal(result.state, "failed");
  const runtime = JSON.parse(fs.readFileSync(paths.runtimeStatePath, "utf8"));
  assert.equal(runtime.state, "degraded");
  assert.equal(runtime.automationEnabled, false);
  assert.equal(runtime.fallbackRequired, true);
  const maintenance = JSON.parse(fs.readFileSync(paths.maintenanceFilePath, "utf8"));
  assert.equal(typeof maintenance.reasons.codexAppServerProxy.message, "string");
  const alert = JSON.parse(fs.readFileSync(paths.alertFilePath, "utf8"));
  assert.equal(alert.pending, true);
  const fallback = JSON.parse(fs.readFileSync(paths.fallbackFilePath, "utf8"));
  assert.equal(fallback.pending, true);
});

test("proxy lock rejects a live PID whose instance token is stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-lock-test-"));
  const lockPath = path.join(root, "proxy.lock");
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      startedAt: "2026-07-24T07:00:00.000Z",
      token: "stale-token",
    })}\n`, "utf8");
    const lock = acquireInstanceLock(lockPath, {
      pid: process.pid,
      startedAt: "2026-07-24T08:00:00.000Z",
      validateExistingLock: () => false,
    });
    assert.equal(lock.acquired, true);
    assert.notEqual(lock.metadata.token, "stale-token");
    lock.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
