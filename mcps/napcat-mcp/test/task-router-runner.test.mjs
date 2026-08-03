import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireInstanceLock,
  calculateBackoffMs,
  createTaskRouterDependencies,
  parseArguments,
  readPrivateEnvironment,
  reconcileAutomationMaintenance,
  runTaskRouterService,
  writeRuntimeState,
} from "../src/task-router-runner.mjs";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-task-router-runner-test-"));
  const paths = {
    root,
    registryPath: path.join(root, "state", "task-registry.json"),
    bindingPath: path.join(root, "binding.json"),
    statePath: path.join(root, "state", "dedupe.json"),
    runtimeStatePath: path.join(root, "state", "task-router-runtime.json"),
    logPath: path.join(root, "state", "task-router.jsonl"),
    stopFilePath: path.join(root, "state", "task-router.stop"),
    lockPath: path.join(root, "state", "task-router.lock"),
  };
  return {
    ...paths,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function serviceOptions(fixture, overrides = {}) {
  return {
    ...fixture,
    scanIntervalMs: 20,
    maxBackoffMs: 50,
    pid: 4321,
    now: () => new Date("2026-07-24T08:00:00.000Z"),
    installSignalHandlers: false,
    ...overrides,
  };
}

function readRuntimeState(fixture) {
  return JSON.parse(fs.readFileSync(fixture.runtimeStatePath, "utf8"));
}

test("CLI 固定参数解析并加载 private-env 的 NapCat 配置", () => {
  const fixture = createFixture();
  const privateEnvPath = path.join(fixture.root, "private-env.json");
  fs.writeFileSync(privateEnvPath, JSON.stringify({
    NAPCAT_HTTP_URL: "http://127.0.0.1:3301",
    NAPCAT_ACCESS_TOKEN: "secret",
    NAPCAT_HTTP_TIMEOUT_MS: "7000",
    OTHER_SECRET: "ignored",
  }), "utf8");
  try {
    const parsed = parseArguments([
      "--registry", fixture.registryPath,
      "--binding", fixture.bindingPath,
      "--state", fixture.statePath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--interval-ms", "30000",
      "--private-env", privateEnvPath,
    ]);
    assert.equal(parsed.scanIntervalMs, 30000);
    assert.equal(parsed.privateEnvPath, path.resolve(privateEnvPath));
    assert.deepEqual(readPrivateEnvironment(privateEnvPath), {
      NAPCAT_HTTP_URL: "http://127.0.0.1:3301",
      NAPCAT_ACCESS_TOKEN: "secret",
      NAPCAT_HTTP_TIMEOUT_MS: "7000",
    });
    assert.throws(() => parseArguments(["--registry", fixture.registryPath]), /缺少参数 --binding/);
    assert.throws(() => parseArguments([
      "--registry", fixture.registryPath,
      "--binding", fixture.bindingPath,
      "--state", fixture.statePath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--interval-ms", "0",
    ]), /--interval-ms 必须是大于 0 的整数/);
    const defaultInterval = parseArguments([
      "--registry", fixture.registryPath,
      "--binding", fixture.bindingPath,
      "--state", fixture.statePath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
    ]);
    assert.equal(defaultInterval.scanIntervalMs, 30000);
  } finally {
    fixture.cleanup();
  }
});

test("task router 自动使用同一 state 目录的透明代理控制面", () => {
  const fixture = createFixture();
  const stateRoot = path.dirname(fixture.registryPath);
  const runtimePath = path.join(stateRoot, "codex-app-server-proxy-runtime.json");
  const tokenFilePath = path.join(stateRoot, "codex-app-server-proxy-token.txt");
  let capturedBridgeOptions;
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(runtimePath, JSON.stringify({ controlUrl: "http://127.0.0.1:19431" }), "utf8");
  fs.writeFileSync(tokenFilePath, "test-token\n", "utf8");
  try {
    createTaskRouterDependencies({
      registryPath: fixture.registryPath,
      bindingPath: fixture.bindingPath,
      statePath: fixture.statePath,
      createRegistry: () => ({}),
      createNotifier: () => ({}),
      createBridge: (options) => {
        capturedBridgeOptions = options;
        return { async close() {} };
      },
      createRouter: () => ({ async scanOnce() { return { openTaskCount: 0 }; } }),
      env: {},
    });
    assert.equal(capturedBridgeOptions.mode, "transparent_proxy");
    assert.equal(capturedBridgeOptions.controlUrl, "http://127.0.0.1:19431");
    assert.equal(capturedBridgeOptions.tokenFilePath, tokenFilePath);
  } finally {
    fixture.cleanup();
  }
});

test("空白桥配置不会绕过透明代理自动发现", () => {
  const fixture = createFixture();
  const stateRoot = path.dirname(fixture.registryPath);
  const tokenFilePath = path.join(stateRoot, "codex-app-server-proxy-token.txt");
  let capturedBridgeOptions;
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(tokenFilePath, "test-token\n", "utf8");
  try {
    createTaskRouterDependencies({
      registryPath: fixture.registryPath,
      bindingPath: fixture.bindingPath,
      statePath: fixture.statePath,
      bridgeOptions: { controlUrl: " ", controlToken: "", tokenFilePath: "\t" },
      createRegistry: () => ({}),
      createNotifier: () => ({}),
      createBridge: (options) => {
        capturedBridgeOptions = options;
        return { async close() {} };
      },
      createRouter: () => ({ async scanOnce() { return { openTaskCount: 0 }; } }),
      env: {},
    });
    assert.equal(capturedBridgeOptions.mode, "transparent_proxy");
    assert.equal(capturedBridgeOptions.controlUrl, "http://127.0.0.1:18431");
    assert.equal(capturedBridgeOptions.tokenFilePath, tokenFilePath);
  } finally {
    fixture.cleanup();
  }
});

test("task router 发现不完整代理产物时不静默回退旧桥", () => {
  const fixture = createFixture();
  const stateRoot = path.dirname(fixture.registryPath);
  let capturedBridgeOptions;
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "codex-app-server-proxy-runtime.json"), "{}", "utf8");
  try {
    createTaskRouterDependencies({
      registryPath: fixture.registryPath,
      bindingPath: fixture.bindingPath,
      statePath: fixture.statePath,
      createRegistry: () => ({}),
      createNotifier: () => ({}),
      createBridge: (options) => {
        capturedBridgeOptions = options;
        return { async close() {} };
      },
      createRouter: () => ({ async scanOnce() { return { openTaskCount: 0 }; } }),
      env: {},
    });
    assert.equal(capturedBridgeOptions.mode, "transparent_proxy");
    assert.equal(capturedBridgeOptions.controlUrl, "http://127.0.0.1:18431");
    assert.equal(
      capturedBridgeOptions.tokenFilePath,
      path.join(stateRoot, "codex-app-server-proxy-token.txt"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("首次扫描无 open task 时退出并原子写完整 runtime status", async () => {
  const fixture = createFixture();
  let scanCount = 0;
  try {
    const result = await runTaskRouterService(serviceOptions(fixture, {
      router: {
        async scanOnce() {
          scanCount += 1;
          return {
            scannedAt: "2026-07-24T08:00:01.000Z",
            openTaskCount: 0,
            wakeCount: 0,
            results: [],
          };
        },
      },
    }));
    const state = readRuntimeState(fixture);
    assert.equal(scanCount, 1);
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "no_open_tasks");
    assert.equal(state.pid, 4321);
    assert.equal(state.startedAt, "2026-07-24T08:00:00.000Z");
    assert.equal(state.lastScanAt, "2026-07-24T08:00:01.000Z");
    assert.equal(state.nextScanAt, null);
    assert.equal(state.openTaskCount, 0);
    assert.equal(state.lastError, null);
    assert.equal(state.state, "stopped");
    assert.equal(fs.existsSync(fixture.lockPath), false);
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.runtimeStatePath)).filter((name) => name.includes(".tmp-")), []);
    assert.match(fs.readFileSync(fixture.logPath, "utf8"), /"type":"runner_started"/);
    assert.match(fs.readFileSync(fixture.logPath, "utf8"), /"type":"scan"/);
    assert.match(fs.readFileSync(fixture.logPath, "utf8"), /"stopReason":"no_open_tasks"/);
  } finally {
    fixture.cleanup();
  }
});

test("stop 文件会让有 open task 的 runner 优雅退出", async () => {
  const fixture = createFixture();
  let scanCount = 0;
  try {
    const result = await runTaskRouterService(serviceOptions(fixture, {
      router: {
        async scanOnce() {
          scanCount += 1;
          return { scannedAt: "2026-07-24T08:00:01.000Z", openTaskCount: 1, wakeCount: 0 };
        },
      },
      wait: async () => {
        fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const state = readRuntimeState(fixture);
    assert.equal(scanCount, 1);
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "stop_file");
    assert.equal(state.state, "stopped");
    assert.equal(state.openTaskCount, 1);
    assert.equal(state.nextScanAt, null);
    assert.equal(fs.existsSync(fixture.lockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("扫描异常按指数退避并在上限后继续存活", async () => {
  const fixture = createFixture();
  const delays = [];
  let scanCount = 0;
  try {
    const result = await runTaskRouterService(serviceOptions(fixture, {
      router: {
        async scanOnce() {
          scanCount += 1;
          const error = new Error(`暂时失败 ${scanCount}`);
          error.code = "TEMPORARY_SCAN_FAILURE";
          throw error;
        },
      },
      wait: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 3) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const state = readRuntimeState(fixture);
    assert.equal(scanCount, 3);
    assert.deepEqual(delays, [20, 40, 50]);
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "stop_file");
    assert.equal(state.lastError.code, "TEMPORARY_SCAN_FAILURE");
    assert.equal(state.nextScanAt, null);
    assert.equal(state.state, "stopped");
  } finally {
    fixture.cleanup();
  }
});

test("known-before-send wake failure stays retryable instead of entering maintenance", async () => {
  const fixture = createFixture();
  let scanCount = 0;
  try {
    const result = await runTaskRouterService(serviceOptions(fixture, {
      maintenanceFilePath: path.join(fixture.root, "state", "maintenance.json"),
      router: {
        async scanOnce() {
          scanCount += 1;
          return {
            scannedAt: "2026-07-24T08:00:01.000Z",
            openTaskCount: 1,
            wakeCount: 0,
            results: [{
              taskId: "task-001",
              wakeId: "wake-known-failure",
              outcome: "wake_failed",
              error: { code: "APP_SERVER_TIMEOUT", message: "发送前失败", outcomeUnknown: false },
            }],
          };
        },
      },
      wait: async () => fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8"),
    }));
    assert.equal(scanCount, 1);
    assert.equal(result.stopReason, "stop_file");
    assert.equal(fs.existsSync(path.join(fixture.root, "state", "maintenance.json")), false);
  } finally {
    fixture.cleanup();
  }
});

test("true unknown wake result still enters maintenance", async () => {
  const fixture = createFixture();
  const maintenanceFilePath = path.join(fixture.root, "state", "maintenance.json");
  try {
    await runTaskRouterService(serviceOptions(fixture, {
      maintenanceFilePath,
      router: {
        async scanOnce() {
          return {
            scannedAt: "2026-07-24T08:00:01.000Z",
            openTaskCount: 1,
            wakeCount: 0,
            results: [{
              taskId: "task-001",
              wakeId: "wake-unknown",
              outcome: "wake_unknown",
              error: { code: "PROXY_WAKE_OUTCOME_UNKNOWN", message: "结果未知", outcomeUnknown: true },
            }],
          };
        },
      },
      wait: async () => fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8"),
    }));
    const maintenance = JSON.parse(fs.readFileSync(maintenanceFilePath, "utf8"));
    assert.equal(maintenance.reasons.automationBridge.wakeId, "wake-unknown");
    assert.equal(maintenance.reasons.automationBridge.outcomeUnknown, true);
  } finally {
    fixture.cleanup();
  }
});

test("maintenance reconciliation restores failed-before-send wake and clears only automation pause", () => {
  const fixture = createFixture();
  const maintenanceFilePath = path.join(fixture.root, "state", "maintenance.json");
  const alertFilePath = path.join(fixture.root, "state", "alert.json");
  const wakeJournalPath = path.join(fixture.root, "state", "codex-app-server-wake-journal.json");
  const maintenance = {
    schemaVersion: 1,
    reasons: {
      automationBridge: { taskId: "task-001", wakeId: "wake-failed", code: "PROXY_TIMEOUT" },
    },
  };
  const reconciled = [];
  fs.mkdirSync(path.dirname(maintenanceFilePath), { recursive: true });
  fs.writeFileSync(maintenanceFilePath, JSON.stringify(maintenance), "utf8");
  fs.writeFileSync(alertFilePath, JSON.stringify({ pending: true, source: "task-router" }), "utf8");
  fs.writeFileSync(wakeJournalPath, JSON.stringify({
    wakes: { "wake-failed": { status: "failed_before_send", error: { code: "APP_SERVER_TIMEOUT" } } },
  }), "utf8");
  try {
    const result = reconcileAutomationMaintenance({
      registryPath: fixture.registryPath,
      maintenanceFilePath,
      alertFilePath,
      wakeJournalPath,
    }, {
      registry: {
        get: () => ({
          taskId: "task-001",
          generation: 1,
          status: "open",
          activeWakes: [{ wakeId: "wake-failed" }],
        }),
        reconcileFailedWake: (input) => reconciled.push(input),
      },
    }, maintenance);
    assert.equal(result.resolved, true);
    assert.equal(result.outcome, "failed_before_send");
    assert.deepEqual(reconciled, [{ taskId: "task-001", expectedGeneration: 1, wakeId: "wake-failed" }]);
    assert.equal(fs.existsSync(maintenanceFilePath), false);
    const alert = JSON.parse(fs.readFileSync(alertFilePath, "utf8"));
    assert.equal(alert.pending, false);
    assert.equal(alert.resolution, "journal_reconciled");
  } finally {
    fixture.cleanup();
  }
});

test("scanOnce 返回的单任务 scan_error 也会记录并退避", async () => {
  const fixture = createFixture();
  const delays = [];
  try {
    const result = await runTaskRouterService(serviceOptions(fixture, {
      router: {
        async scanOnce() {
          return {
            scannedAt: "2026-07-24T08:00:02.000Z",
            openTaskCount: 1,
            results: [{
              outcome: "scan_error",
              error: { code: "NAPCAT_NOT_READY", message: "NapCat 暂时离线" },
            }],
          };
        },
      },
      wait: async (delayMs) => {
        delays.push(delayMs);
        fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const state = readRuntimeState(fixture);
    assert.deepEqual(delays, [20]);
    assert.equal(result.stopReason, "stop_file");
    assert.equal(state.openTaskCount, 1);
    assert.equal(state.lastError.code, "NAPCAT_NOT_READY");
  } finally {
    fixture.cleanup();
  }
});

test("存活锁会合并重复启动，陈旧锁可恢复", async () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.lockPath), { recursive: true });
    fs.writeFileSync(fixture.lockPath, JSON.stringify({ pid: 9001, startedAt: "2026-07-24T08:00:00.000Z" }), "utf8");
    let duplicateScanCount = 0;
    const duplicate = await runTaskRouterService(serviceOptions(fixture, {
      router: { async scanOnce() { duplicateScanCount += 1; return { openTaskCount: 0 }; } },
      isProcessAlive: (pid) => pid === 9001,
    }));
    assert.equal(duplicate.state, "duplicate");
    assert.equal(duplicateScanCount, 0);
    assert.equal(fs.existsSync(fixture.runtimeStatePath), false);

    fs.writeFileSync(fixture.lockPath, JSON.stringify({ pid: 9002, startedAt: "2026-07-24T08:00:00.000Z" }), "utf8");
    const recovered = await runTaskRouterService(serviceOptions(fixture, {
      router: { async scanOnce() { return { openTaskCount: 0 }; } },
      isProcessAlive: () => false,
    }));
    assert.equal(recovered.state, "stopped");
    assert.equal(recovered.stopReason, "no_open_tasks");
    assert.equal(fs.existsSync(fixture.lockPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("runtime status 写入保留必需字段，退避计算有明确上限", () => {
  const fixture = createFixture();
  try {
    const state = writeRuntimeState(fixture.runtimeStatePath, {
      pid: 99,
      startedAt: "2026-07-24T08:00:00.000Z",
      state: "running",
    });
    assert.deepEqual({
      pid: state.pid,
      startedAt: state.startedAt,
      lastScanAt: state.lastScanAt,
      nextScanAt: state.nextScanAt,
      openTaskCount: state.openTaskCount,
      lastError: state.lastError,
      state: state.state,
    }, {
      pid: 99,
      startedAt: "2026-07-24T08:00:00.000Z",
      lastScanAt: null,
      nextScanAt: null,
      openTaskCount: 0,
      lastError: null,
      state: "running",
    });
    assert.equal(calculateBackoffMs(30, 1, 100), 30);
    assert.equal(calculateBackoffMs(30, 2, 100), 60);
    assert.equal(calculateBackoffMs(30, 8, 100), 100);
  } finally {
    fixture.cleanup();
  }
});

test("锁释放只删除自己持有的锁", () => {
  const fixture = createFixture();
  try {
    const lock = acquireInstanceLock(fixture.lockPath, { pid: 7, now: () => new Date("2026-07-24T08:00:00.000Z") });
    fs.writeFileSync(fixture.lockPath, JSON.stringify({ pid: 8, token: "other" }), "utf8");
    lock.release();
    assert.equal(JSON.parse(fs.readFileSync(fixture.lockPath, "utf8")).pid, 8);
    fs.unlinkSync(fixture.lockPath);
  } finally {
    fixture.cleanup();
  }
});

test("PID 存活但实例身份校验失败时回收陈旧锁", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.lockPath), { recursive: true });
    fs.writeFileSync(fixture.lockPath, JSON.stringify({
      pid: 9001,
      startedAt: "2026-07-24T07:00:00.000Z",
      token: "stale-token",
    }), "utf8");
    const lock = acquireInstanceLock(fixture.lockPath, {
      pid: 7,
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      isProcessAlive: () => true,
      validateExistingLock: () => false,
    });
    assert.equal(lock.acquired, true);
    assert.equal(JSON.parse(fs.readFileSync(fixture.lockPath, "utf8")).pid, 7);
    lock.release();
  } finally {
    fixture.cleanup();
  }
});
