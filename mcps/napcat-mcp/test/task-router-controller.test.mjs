import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTaskRouterController } from "../src/task-router-controller.mjs";

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-router-controller-"));
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "src", "task-router-runner.mjs"), "", "utf8");
  return rootDir;
}

test("autostart launches one hidden detached runner with fixed paths", () => {
  const rootDir = fixture();
  const calls = [];
  const controller = createTaskRouterController({
    rootDir,
    env: { NAPCAT_TASK_ROUTER_INTERVAL_MS: "45000" },
    processKill: () => { const error = new Error("missing"); error.code = "ESRCH"; throw error; },
    spawnProcess(executable, args, options) {
      calls.push({ executable, args, options });
      return { pid: 321, unref() { calls[0].unref = true; } };
    },
    nodePath: "node-test",
  });
  const result = controller.ensureStarted();
  assert.equal(result.started, true);
  assert.equal(result.pid, 321);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "node-test");
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].unref, true);
  assert.deepEqual(calls[0].args.slice(-6), [
    "--maintenance-file", path.join(rootDir, "state", "task-router.maintenance.json"),
    "--alert-file", path.join(rootDir, "state", "automation-alert.json"),
    "--interval-ms", "45000",
  ]);
});

test("a configured task registry anchors all default runtime state paths", () => {
  const rootDir = fixture();
  const dataStateDir = path.join(rootDir, "private-data", "state");
  const registryPath = path.join(dataStateDir, "task-registry.json");
  const controller = createTaskRouterController({
    rootDir,
    env: { NAPCAT_TASK_REGISTRY_PATH: registryPath },
    processKill: () => { const error = new Error("missing"); error.code = "ESRCH"; throw error; },
  });
  const status = controller.status();
  assert.equal(status.paths.registry, registryPath);
  assert.equal(status.paths.runtimeState, path.join(dataStateDir, "task-router-runtime.json"));
  assert.equal(status.paths.maintenance, path.join(dataStateDir, "task-router.maintenance.json"));
  assert.equal(status.paths.alert, path.join(dataStateDir, "automation-alert.json"));
});

test("live runtime suppresses duplicate spawn", () => {
  const rootDir = fixture();
  const runtimePath = path.join(rootDir, "state", "task-router-runtime.json");
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  const startedAt = "2026-07-24T08:00:00.000Z";
  fs.writeFileSync(runtimePath, JSON.stringify({ pid: 999, state: "running", startedAt }), "utf8");
  fs.writeFileSync(path.join(rootDir, "state", "task-router.lock"), JSON.stringify({ pid: 999, startedAt }), "utf8");
  let spawnCount = 0;
  const controller = createTaskRouterController({
    rootDir,
    env: {},
    processKill: () => {},
    spawnProcess() { spawnCount += 1; return { pid: 1, unref() {} }; },
  });
  const result = controller.ensureStarted();
  assert.equal(result.started, false);
  assert.equal(result.reason, "already_running");
  assert.equal(result.alive, true);
  assert.equal(spawnCount, 0);
});

test("stale runtime without matching lock never suppresses restart", () => {
  const rootDir = fixture();
  const runtimePath = path.join(rootDir, "state", "task-router-runtime.json");
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify({ pid: 999, state: "running", startedAt: "old" }), "utf8");
  let spawnCount = 0;
  const controller = createTaskRouterController({
    rootDir,
    env: {},
    processKill: () => {},
    spawnProcess() { spawnCount += 1; return { pid: 1000, unref() {} }; },
  });
  assert.equal(controller.ensureStarted().started, true);
  assert.equal(spawnCount, 1);
});

test("autostart can be explicitly disabled for tests and maintenance", () => {
  const rootDir = fixture();
  let spawnCount = 0;
  const controller = createTaskRouterController({
    rootDir,
    env: { NAPCAT_TASK_ROUTER_AUTOSTART: "0" },
    spawnProcess() { spawnCount += 1; return { pid: 1, unref() {} }; },
  });
  const result = controller.ensureStarted();
  assert.equal(result.reason, "autostart_disabled");
  assert.equal(result.enabled, false);
  assert.equal(spawnCount, 0);
});
