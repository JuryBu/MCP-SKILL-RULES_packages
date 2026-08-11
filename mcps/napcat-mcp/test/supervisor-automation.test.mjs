import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArguments, runSupervisorService } from "../src/supervisor-runner.mjs";

const syncWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function waitSync(milliseconds) {
  Atomics.wait(syncWaitBuffer, 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForJsonFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (fs.existsSync(filePath)) {
      try {
        return readJson(filePath);
      } catch {
      }
    }
    waitSync(25);
  } while (Date.now() < deadline);
  return null;
}

function terminateProcessTreeAndWait(pid, timeoutMs = 5_000) {
  if (!isProcessAlive(pid)) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) waitSync(25);
  if (isProcessAlive(pid)) throw new Error(`Timed out waiting for test process tree to exit: PID ${pid}`);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-supervisor-automation-test-"));
  const fixture = {
    root,
    bindingPath: path.join(root, "binding.json"),
    registryPath: path.join(root, "state", "task-registry.json"),
    runtimeStatePath: path.join(root, "state", "supervisor-runtime.json"),
    logPath: path.join(root, "state", "supervisor.jsonl"),
    stopFilePath: path.join(root, "state", "supervisor.stop"),
    lockPath: path.join(root, "state", "supervisor.lock"),
    automationMaintenancePath: path.join(root, "state", "automation-maintenance.json"),
    automationAlertPath: path.join(root, "state", "automation-alert.json"),
  };
  fs.mkdirSync(path.dirname(fixture.bindingPath), { recursive: true });
  fs.mkdirSync(path.dirname(fixture.registryPath), { recursive: true });
  fs.writeFileSync(fixture.bindingPath, "{}\n", "utf8");
  fs.writeFileSync(fixture.registryPath, "registry-unchanged\n", "utf8");
  return {
    ...fixture,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function baseOptions(fixture, overrides = {}) {
  const notifier = overrides.notifier ?? {
    async sendTextMessage() {
      return { sent: true, messageId: "alert-1" };
    },
  };
  const routerController = overrides.routerController ?? {
    status() {
      return { alive: false, state: "stopped" };
    },
    ensureStarted() {
      return { started: true, pid: 9001 };
    },
  };
  return {
    ...fixture,
    scanIntervalMs: 10,
    probeTimeoutMs: 20,
    loginTimeoutMs: 30_000,
    loginCooldownMs: 100,
    brokerStartCooldownMs: 100,
    pid: 9101,
    now: () => new Date("2026-08-02T08:00:00.000Z"),
    installSignalHandlers: false,
    once: true,
    checkBrokerHealth: async () => ({ known: true, healthy: true, reachable: true }),
    checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true, ready: true }),
    checkNapCatRuntime: async () => ({ known: true, ready: true }),
    checkNapCatProcesses: async () => ({ known: true, present: true }),
    checkCodexProcesses: async () => ({ known: true, present: true }),
    checkBrokerProcesses: async () => ({ known: true, present: true }),
    getOpenTaskCount: async () => 0,
    dependencies: {
      notifier,
      routerController,
    },
    ...overrides,
  };
}

test("CLI 与 PowerShell 都传入 automation maintenance/alert 文件", () => {
  const fixture = createFixture();
  try {
    const parsed = parseArguments([
      "--binding", fixture.bindingPath,
      "--registry", fixture.registryPath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--broker-health-url", "http://127.0.0.1:14588/health",
      "--maintenance-file", fixture.automationMaintenancePath,
      "--alert-file", fixture.automationAlertPath,
    ]);
    assert.equal(parsed.automationMaintenancePath, path.resolve(fixture.automationMaintenancePath));
    assert.equal(parsed.automationAlertPath, path.resolve(fixture.automationAlertPath));
    assert.equal(parsed.maintenanceFilePath, path.resolve(fixture.automationMaintenancePath));
    assert.equal(parsed.alertFilePath, path.resolve(fixture.automationAlertPath));

    const scriptPath = fileURLToPath(new URL("../ops/start-napcat-supervisor.ps1", import.meta.url));
    const script = fs.readFileSync(scriptPath, "utf8");
    assert.match(script, /"--maintenance-file", \$AutomationMaintenancePath/);
    assert.match(script, /"--alert-file", \$AutomationAlertPath/);
  } finally {
    fixture.cleanup();
  }
});

test("后台启动脚本在 PATH 缺少 node 时回退到受管服务清单", () => {
  for (const scriptName of [
    "start-codex-app-server-proxy.ps1",
    "start-napcat-supervisor.ps1",
    "start-napcat-task-router.ps1",
    "start-napcat-heartbeat.ps1",
  ]) {
    const scriptPath = fileURLToPath(new URL(`../ops/${scriptName}`, import.meta.url));
    const script = fs.readFileSync(scriptPath, "utf8");
    assert.match(script, /CODEX_TOOLKIT_NODE_EXE/);
    assert.match(script, /service-manifest\.json/);
    assert.match(script, /Get-Command node -ErrorAction SilentlyContinue/);
    assert.doesNotMatch(script, /Get-Command node -ErrorAction Stop/);
  }
});

test("CodeRoot 与便携 broker release 分离时使用清单启动器并校验 BrokerRoot", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-supervisor-manifest-test-"));
  const codeRoot = path.join(root, "code-root");
  const napcatMcpRoot = path.join(codeRoot, "napcat-mcp");
  const opsRoot = path.join(napcatMcpRoot, "ops");
  const brokerReleaseRoot = path.join(root, "portable-broker-release");
  const brokerRoot = path.join(brokerReleaseRoot, "broker");
  const brokerScriptPath = path.join(brokerRoot, "broker.mjs");
  const manifestStartScriptPath = path.join(brokerReleaseRoot, "install", "Start-CodexMcpBroker.ps1");
  const decoyStartScriptPath = path.join(brokerRoot, "Start-CodexMcpBroker.ps1");
  const serviceManifestPath = path.join(root, ".codex-toolkit", "services", "infrastructure", "service-manifest.json");
  const startScriptPath = path.join(opsRoot, "start-napcat-supervisor.ps1");
  const runnerPath = path.join(napcatMcpRoot, "src", "supervisor-runner.mjs");
  const startedPids = new Set();

  t.after(() => {
    for (const pid of startedPids) {
      terminateProcessTreeAndWait(pid);
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false, "manifest regression TEMP root must be removed");
  });

  fs.mkdirSync(opsRoot, { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL("../ops/start-napcat-supervisor.ps1", import.meta.url)), startScriptPath);
  fs.writeFileSync(path.join(opsRoot, "start-napcat-login.ps1"), "param()\n", "utf8");
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.writeFileSync(
    runnerPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      "const valueOf = (name) => args[args.indexOf(name) + 1];",
      'const token = "manifest-regression-token";',
      'const runtimeStatePath = valueOf("--runtime-state");',
      'const lockPath = valueOf("--lock");',
      "fs.mkdirSync(path.dirname(runtimeStatePath), { recursive: true });",
      "fs.writeFileSync(process.env.NAPCAT_SUPERVISOR_CAPTURE_PATH, JSON.stringify({ brokerStartScript: valueOf(\"--broker-start-script\") }), \"utf8\");",
      "fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token }), \"utf8\");",
      "fs.writeFileSync(runtimeStatePath, JSON.stringify({ state: \"running\", pid: process.pid, instanceToken: token }), \"utf8\");",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(brokerRoot, "broker-private.env.json"), "{}\n", "utf8");
  fs.writeFileSync(brokerScriptPath, "export {};\n", "utf8");
  fs.mkdirSync(path.dirname(manifestStartScriptPath), { recursive: true });
  fs.writeFileSync(manifestStartScriptPath, "Write-Output 'manifest launcher'\n", "utf8");
  fs.writeFileSync(decoyStartScriptPath, "Write-Output 'wrong flat launcher'\n", "utf8");

  const serviceManifest = {
    broker: {
      nodeExe: process.execPath,
      startScript: manifestStartScriptPath,
      brokerScript: brokerScriptPath,
    },
  };
  writeJson(serviceManifestPath, serviceManifest);
  assert.equal(path.dirname(path.resolve(serviceManifest.broker.brokerScript)), path.resolve(brokerRoot));

  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
    "path",
    "userprofile",
    "codex_toolkit_node_exe",
    "codex_toolkit_broker_root",
    "codex_toolkit_napcat_data_root",
    "napcat_supervisor_capture_path",
  ].includes(key.toLowerCase())));
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";

  function runStart(runName) {
    const dataRoot = path.join(root, runName, "data");
    const capturePath = path.join(root, runName, "captured.json");
    const runtimeStatePath = path.join(dataRoot, "state", "supervisor-runtime.json");
    writeJson(path.join(dataRoot, "binding.json"), {});
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", startScriptPath,
        "-DataRoot", dataRoot,
        "-BrokerRoot", brokerRoot,
        "-NapCatRoot", path.join(root, "napcat-runtime"),
      ],
      {
        cwd: opsRoot,
        encoding: "utf8",
        env: {
          ...inheritedEnv,
          Path: `${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
          USERPROFILE: root,
          CODEX_TOOLKIT_NODE_EXE: "",
          CODEX_TOOLKIT_BROKER_ROOT: "",
          CODEX_TOOLKIT_NAPCAT_DATA_ROOT: "",
          NAPCAT_SUPERVISOR_CAPTURE_PATH: capturePath,
        },
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (result.status === 0) {
      const runtimeState = waitForJsonFile(runtimeStatePath, 3_000);
      assert.ok(runtimeState?.pid, `successful supervisor start did not publish a PID: ${runtimeStatePath}`);
      startedPids.add(runtimeState.pid);
    }
    return { result, capturePath };
  }

  const validRun = runStart("valid-manifest");
  const validOutput = `${validRun.result.stdout ?? ""}\n${validRun.result.stderr ?? ""}`;
  assert.equal(validRun.result.status, 0, validOutput);
  assert.equal(
    fs.realpathSync.native(readJson(validRun.capturePath).brokerStartScript).toLowerCase(),
    fs.realpathSync.native(manifestStartScriptPath).toLowerCase(),
    "supervisor must pass service-manifest broker.startScript instead of BrokerRoot\\Start-CodexMcpBroker.ps1",
  );

  serviceManifest.broker.brokerScript = path.join(root, "other-broker", "broker.mjs");
  fs.mkdirSync(path.dirname(serviceManifest.broker.brokerScript), { recursive: true });
  fs.writeFileSync(serviceManifest.broker.brokerScript, "export {};\n", "utf8");
  writeJson(serviceManifestPath, serviceManifest);
  const mismatchedRun = runStart("mismatched-broker-root");
  const mismatchedOutput = `${mismatchedRun.result.stdout ?? ""}\n${mismatchedRun.result.stderr ?? ""}`;
  assert.notEqual(mismatchedRun.result.status, 0, mismatchedOutput);
  assert.equal(fs.existsSync(mismatchedRun.capturePath), false, "brokerScript outside BrokerRoot must fail before supervisor launch");
});

test("监督器计划任务同时使用登录触发与每分钟恢复触发", () => {
  const scriptPath = fileURLToPath(new URL("../ops/install-napcat-autostart.ps1", import.meta.url));
  const script = fs.readFileSync(scriptPath, "utf8");
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /New-ScheduledTaskTrigger -Once/);
  assert.match(script, /-RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /-Trigger \$Triggers/);
});

test("维护活跃时关闭 supervisor gate，不启动 task router，也不改 task registry", async () => {
  const fixture = createFixture();
  let routerStartCount = 0;
  try {
    writeJson(fixture.automationMaintenancePath, {
      schemaVersion: 1,
      reasons: {
        scheduled: { message: "scheduled maintenance" },
      },
    });
    const result = await runSupervisorService(baseOptions(fixture, {
      getOpenTaskCount: async () => 1,
      routerController: {
        status() {
          return { alive: false, state: "stopped" };
        },
        ensureStarted() {
          routerStartCount += 1;
          return { started: true };
        },
      },
    }));
    const runtime = readJson(fixture.runtimeStatePath);
    assert.equal(result.state, "stopped");
    assert.equal(routerStartCount, 0);
    assert.equal(runtime.maintenance.active, true);
    assert.deepEqual(runtime.maintenance.reasons, ["scheduled"]);
    assert.equal(runtime.checks.gate, false);
    assert.equal(runtime.actions.taskRouter.reason, "maintenance_active");
    assert.equal(fs.readFileSync(fixture.registryPath, "utf8"), "registry-unchanged\n");
  } finally {
    fixture.cleanup();
  }
});

test("只有 automationBridge 维护时启动 router 让它核对代理日志并自愈", async () => {
  const fixture = createFixture();
  let routerStartCount = 0;
  try {
    writeJson(fixture.automationMaintenancePath, {
      schemaVersion: 1,
      reasons: {
        automationBridge: {
          code: "PROXY_TIMEOUT",
          outcomeUnknown: true,
          wakeId: "wake-reconcile-1",
        },
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      getOpenTaskCount: async () => 1,
      routerController: {
        status() {
          return { alive: false, state: "stopped" };
        },
        ensureStarted() {
          routerStartCount += 1;
          return { started: true, pid: 9002 };
        },
      },
    }));
    const runtime = readJson(fixture.runtimeStatePath);
    assert.equal(routerStartCount, 1);
    assert.equal(runtime.maintenance.active, true);
    assert.deepEqual(runtime.maintenance.reasons, ["automationBridge"]);
    assert.equal(runtime.actions.maintenance.routerCanReconcile, true);
    assert.equal(runtime.checks.gate, true);
    assert.equal(runtime.actions.taskRouter.succeeded, true);
    assert.equal(fs.readFileSync(fixture.registryPath, "utf8"), "registry-unchanged\n");
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 离线时 pending 固定群告警不发送，仍保留 pending", async () => {
  const fixture = createFixture();
  const sends = [];
  try {
    writeJson(fixture.automationAlertPath, {
      status: "pending",
      incidentKey: "example-group-duplicate-1001",
      text: "ExampleGroup 去重告警",
    });
    const result = await runSupervisorService(baseOptions(fixture, {
      notifier: {
        async sendTextMessage(input) {
          sends.push(input);
          return { sent: true };
        },
      },
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false, ready: false }),
    }));
    const runtime = readJson(fixture.runtimeStatePath);
    const alertFile = readJson(fixture.automationAlertPath);
    assert.equal(result.state, "stopped");
    assert.equal(sends.length, 0);
    assert.equal(runtime.alert.status, "pending");
    assert.equal(runtime.actions.alert.reason, "napcat_not_ready");
    assert.equal(alertFile.status, "pending");
    assert.equal(alertFile.attempts ?? 0, 0);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 恢复后发送一次无 task_id 告警，重复 cycle 不重复发送", async () => {
  const fixture = createFixture();
  const sends = [];
  let waitCount = 0;
  try {
    writeJson(fixture.automationAlertPath, {
      status: "pending",
      incidentKey: "example-group-duplicate-1002",
      text: "ExampleGroup 重复消息已抑制",
    });
    const result = await runSupervisorService(baseOptions(fixture, {
      once: false,
      notifier: {
        async sendTextMessage(input) {
          sends.push(input);
          return { sent: true, messageId: "alert-1002" };
        },
      },
      wait: async () => {
        waitCount += 1;
        if (waitCount >= 2) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const runtime = readJson(fixture.runtimeStatePath);
    const alertFile = readJson(fixture.automationAlertPath);
    assert.equal(result.stopReason, "stop_file");
    assert.equal(sends.length, 1);
    assert.equal(Object.hasOwn(sends[0], "task_id"), false);
    assert.equal(sends[0].dedupe_key, "example-group-duplicate-1002");
    assert.equal(alertFile.status, "sent");
    assert.equal(alertFile.pending, false);
    assert.equal(runtime.alert.status, "sent");
    assert.equal(runtime.alert.sentIncidentKeys["example-group-duplicate-1002"] !== undefined, true);
  } finally {
    fixture.cleanup();
  }
});

test("已发送事件被旧组件重写为 pending 时自动恢复 sent 状态", async () => {
  const fixture = createFixture();
  const incidentKey = "example-group-recovered-1003";
  const sentAt = "2026-08-02T01:00:00.000Z";
  const sends = [];
  try {
    writeJson(fixture.runtimeStatePath, {
      alert: { sentIncidentKeys: { [incidentKey]: sentAt } },
    });
    writeJson(fixture.automationAlertPath, {
      status: "pending",
      pending: true,
      incidentKey,
      text: "ExampleGroup 旧告警不应重复发送",
    });
    await runSupervisorService(baseOptions(fixture, {
      notifier: {
        async sendTextMessage(input) {
          sends.push(input);
          return { sent: true, messageId: "unexpected" };
        },
      },
    }));
    const runtime = readJson(fixture.runtimeStatePath);
    const alertFile = readJson(fixture.automationAlertPath);
    assert.equal(sends.length, 0);
    assert.equal(runtime.actions.alert.reason, "incident_already_sent");
    assert.equal(runtime.alert.status, "sent");
    assert.equal(runtime.alert.pending, false);
    assert.equal(alertFile.status, "sent");
    assert.equal(alertFile.pending, false);
    assert.equal(alertFile.sentAt, sentAt);
  } finally {
    fixture.cleanup();
  }
});

test("告警发送失败保留 pending 并递增重试，下一次恢复后才标 sent", async () => {
  const fixture = createFixture();
  const sends = [];
  let shouldFail = true;
  try {
    writeJson(fixture.automationAlertPath, {
      status: "pending",
      incidentKey: "example-group-duplicate-1003",
      text: "ExampleGroup 去重告警需要重试",
    });
    const notifier = {
      async sendTextMessage(input) {
        sends.push(input);
        if (shouldFail) {
          const error = new Error("OneBot 暂时不可用");
          error.code = "ONEBOT_NETWORK_ERROR";
          throw error;
        }
        return { sent: true, messageId: "alert-1003" };
      },
    };
    await runSupervisorService(baseOptions(fixture, { notifier }));
    const failedFile = readJson(fixture.automationAlertPath);
    assert.equal(failedFile.status, "pending");
    assert.equal(failedFile.pending, true);
    assert.equal(failedFile.attempts, 1);
    assert.equal(failedFile.lastError.code, "ONEBOT_NETWORK_ERROR");

    shouldFail = false;
    await runSupervisorService(baseOptions(fixture, { notifier }));
    const recoveredFile = readJson(fixture.automationAlertPath);
    assert.equal(sends.length, 2);
    assert.equal(recoveredFile.status, "sent");
    assert.equal(recoveredFile.attempts, 2);
    assert.equal(recoveredFile.pending, false);
  } finally {
    fixture.cleanup();
  }
});
