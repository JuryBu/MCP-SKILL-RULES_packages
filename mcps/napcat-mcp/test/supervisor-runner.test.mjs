import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  buildQuickLoginArguments,
  checkNapCatRuntime,
  createSupervisorDependencies,
  findBrokerProcesses,
  findCodexProcesses,
  findNapCatProcesses,
  normalizeNapCatStatus,
  parseArguments,
  processSnapshotFingerprint,
  processTreeRootIds,
  runQuickLogin,
  runSupervisorService,
  stopWindowsProcessTrees,
  invokePowerShellScript,
} from "../src/supervisor-runner.mjs";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-supervisor-test-"));
  const fixture = {
    root,
    bindingPath: path.join(root, "binding.json"),
    registryPath: path.join(root, "state", "task-registry.json"),
    runtimeStatePath: path.join(root, "state", "supervisor-runtime.json"),
    logPath: path.join(root, "state", "supervisor.jsonl"),
    stopFilePath: path.join(root, "state", "supervisor.stop"),
    lockPath: path.join(root, "state", "supervisor.lock"),
    privateEnvPath: path.join(root, "broker-private.env.json"),
    brokerStartScriptPath: path.join(root, "start-broker.ps1"),
    loginScriptPath: path.join(root, "login.ps1"),
    napcatRoot: path.join(root, "NapCat"),
    qqExePath: path.join(root, "QQ", "QQ.exe"),
  };
  fs.writeFileSync(fixture.bindingPath, JSON.stringify({
    expectedSelfId: "1000000001",
    expectedNickname: "ExampleBot",
    groupId: "2000000001",
  }), "utf8");
  fs.writeFileSync(fixture.privateEnvPath, JSON.stringify({
    NAPCAT_HTTP_URL: "http://127.0.0.1:3010",
    NAPCAT_ACCESS_TOKEN: "test-token",
  }), "utf8");
  return {
    ...fixture,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseOptions(fixture, overrides = {}) {
  return {
    ...fixture,
    scanIntervalMs: 10,
    probeTimeoutMs: 20,
    loginTimeoutMs: 30_000,
    loginCooldownMs: 100,
    brokerStartCooldownMs: 100,
    pid: 4101,
    now: () => new Date("2026-07-24T08:00:00.000Z"),
    installSignalHandlers: false,
    once: true,
    checkBrokerHealth: async () => ({ known: true, healthy: true, reachable: true }),
    checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true }),
    checkNapCatRuntime: async () => ({ known: true, ready: true, requiredFiles: [], missingFiles: [] }),
    checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7003, name: "NapCat.exe" }] }),
    checkCodexProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7001, name: "Codex.exe" }] }),
    checkBrokerProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7002, name: "node.exe" }] }),
    getOpenTaskCount: async () => 1,
    routerController: {
      status() {
        return { alive: false, state: "stopped" };
      },
      ensureStarted() {
        return { started: true, pid: 5001 };
      },
    },
    ...overrides,
  };
}

function readRuntime(fixture) {
  return JSON.parse(fs.readFileSync(fixture.runtimeStatePath, "utf8"));
}

test("生产 CLI 解析约定参数，并保留可选脚本路径", () => {
  const fixture = createFixture();
  try {
    const parsed = parseArguments([
      "--private-env", fixture.privateEnvPath,
      "--binding", fixture.bindingPath,
      "--registry", fixture.registryPath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--interval-ms", "30000",
      "--broker-health-url", "http://127.0.0.1:14588/health",
      "--broker-start-script", fixture.brokerStartScriptPath,
      "--login-script", fixture.loginScriptPath,
      "--napcat-root", fixture.napcatRoot,
      "--qq-exe-path", fixture.qqExePath,
      "--stale-napcat-unknown-ms", "180000",
    ]);
    assert.equal(parsed.scanIntervalMs, 30000);
    assert.equal(parsed.brokerHealthUrl, "http://127.0.0.1:14588/health");
    assert.equal(parsed.privateEnvPath, path.resolve(fixture.privateEnvPath));
    assert.equal(parsed.loginScriptPath, path.resolve(fixture.loginScriptPath));
    assert.equal(parsed.napcatRoot, path.resolve(fixture.napcatRoot));
    assert.equal(parsed.qqExePath, path.resolve(fixture.qqExePath));
    assert.equal(parsed.staleNapCatUnknownMs, 180_000);
    assert.throws(() => parseArguments(["--binding", fixture.bindingPath]), /缺少参数 --registry/);
    assert.throws(() => parseArguments([
      "--binding", fixture.bindingPath,
      "--registry", fixture.registryPath,
      "--runtime-state", fixture.runtimeStatePath,
      "--log", fixture.logPath,
      "--stop-file", fixture.stopFilePath,
      "--lock", fixture.lockPath,
      "--broker-health-url", "http://127.0.0.1:14588/health",
      "--interval-ms", "0",
    ]), /--interval-ms 必须是不小于 1 的整数/);
  } finally {
    fixture.cleanup();
  }
});

test("quick-login 参数固定带 -NoQr、短 timeout 和 NapCat 根目录", () => {
  const fixture = createFixture();
  try {
    const argumentsList = buildQuickLoginArguments({
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
      timeoutMs: 35_000,
      codexHome: fixture.root,
    });
    assert.deepEqual(argumentsList.slice(0, 4), ["-NoQr", "-TimeoutSeconds", "35", "-NapCatRoot"]);
    assert.equal(argumentsList.includes("-Qr"), false);
    const qqPathIndex = argumentsList.indexOf("-QqExePath");
    assert.equal(argumentsList[qqPathIndex + 1], path.resolve(fixture.qqExePath));
    assert.equal(argumentsList.at(-1), path.resolve(fixture.root));
  } finally {
    fixture.cleanup();
  }
});

test("quick-login 给登录脚本保留清理隐藏进程的超时余量", async () => {
  const fixture = createFixture();
  const calls = [];
  try {
    await runQuickLogin({
      loginScriptPath: fixture.loginScriptPath,
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
      timeoutMs: 35_000,
      execFileImpl(executable, argumentsList, options, callback) {
        calls.push({ executable, argumentsList, options });
        callback(null, "{}\n", "");
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeout, 50_000);
    assert.deepEqual(
      calls[0].argumentsList.slice(-7),
      ["-NoQr", "-TimeoutSeconds", "35", "-NapCatRoot", path.resolve(fixture.napcatRoot), "-QqExePath", path.resolve(fixture.qqExePath)],
    );
  } finally {
    fixture.cleanup();
  }
});

test("独立 QQ 路径会纳入运行完整性检查，旧配置仍保持兼容", () => {
  const fixture = createFixture();
  try {
    fs.mkdirSync(fixture.napcatRoot, { recursive: true });
    fs.writeFileSync(path.join(fixture.napcatRoot, "launcher-user.bat"), "@echo off", "utf8");
    fs.writeFileSync(path.join(fixture.napcatRoot, "napcat.mjs"), "", "utf8");
    assert.equal(checkNapCatRuntime({ napcatRoot: fixture.napcatRoot }).ready, true);

    const missingPinnedRuntime = checkNapCatRuntime({
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
    });
    assert.equal(missingPinnedRuntime.ready, false);
    assert.equal(missingPinnedRuntime.missingFiles.includes(path.resolve(fixture.qqExePath)), true);

    fs.mkdirSync(path.dirname(fixture.qqExePath), { recursive: true });
    fs.writeFileSync(fixture.qqExePath, "", "utf8");
    fs.writeFileSync(path.join(fixture.napcatRoot, "NapCatWinBootMain.exe"), "", "utf8");
    fs.writeFileSync(path.join(fixture.napcatRoot, "NapCatWinBootHook.dll"), "", "utf8");
    fs.unlinkSync(path.join(fixture.napcatRoot, "launcher-user.bat"));
    assert.equal(checkNapCatRuntime({
      napcatRoot: fixture.napcatRoot,
      qqExePath: fixture.qqExePath,
    }).ready, true);

    assert.equal(checkNapCatRuntime({ napcatRoot: fixture.napcatRoot }).ready, false);
  } finally {
    fixture.cleanup();
  }
});

test("进程识别不会把监督器自身、桌面 QQ 或任意 broker 路径误判为目标进程", () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat-Codex";
  const pinnedQqPath = "C:\\Users\\ExampleUser\\NapCat-QQ\\QQ.exe";
  const processes = [
    { ProcessId: 1, Name: "node.exe", CommandLine: `node C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\src\\supervisor-runner.mjs --login-script C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\ops\\start-napcat-login.ps1 --napcat-root "${napcatRoot}"` },
    { ProcessId: 2, Name: "QQ.exe", CommandLine: '"C:\\Program Files\\Tencent\\QQNT\\QQ.exe"' },
    { ProcessId: 3, Name: "NapCatWinBootMain.exe", CommandLine: `"${napcatRoot}\\NapCatWinBootMain.exe"` },
    { ProcessId: 4, Name: "node.exe", CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\broker.mjs' },
    { ProcessId: 5, Name: "ChatGPT.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe" --type=crashpad-handler --user-data-dir=C:\\Users\\ExampleUser\\AppData\\Roaming\\Codex' },
    { ProcessId: 6, Name: "ChatGPT.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe"' },
    { ProcessId: 7, Name: "codex.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\resources\\codex.exe" app-server' },
    { ProcessId: 8, Name: "NapCatWinBootMain.exe", CommandLine: '"C:\\Users\\Other\\NapCatWinBootMain.exe"' },
    { ProcessId: 9, Name: "node.exe", CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${napcatRoot}\\index.js"` },
    { ProcessId: 10, Name: "node.exe", CommandLine: `"C:\\Program Files\\nodejs\\node.exe" "${napcatRoot}\\napcat\\napcat.mjs" 10001` },
    { ProcessId: 11, Name: "QQ.exe", CommandLine: `"${pinnedQqPath}" --no-sandbox` },
    { ProcessId: 12, Name: "QQ.exe", CommandLine: `"${pinnedQqPath}"` },
    { ProcessId: 13, Name: "NapCatWinBootMain.exe", CommandLine: '"C:\\Users\\ExampleUser\\NapCat-Codex-Other\\NapCatWinBootMain.exe"' },
  ];
  assert.deepEqual(findNapCatProcesses(processes, napcatRoot, pinnedQqPath).map((item) => item.ProcessId), [3, 9, 10, 11, 12]);
  assert.deepEqual(findBrokerProcesses(processes, "C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp").map((item) => item.ProcessId), [4]);
  assert.deepEqual(findCodexProcesses(processes).map((item) => item.ProcessId), [6, 7]);
});

test("单次缺失 online 字段只开始未知状态宽限期，不会立即停止进程", async () => {
  const fixture = createFixture();
  let stopCount = 0;
  const processes = [{ pid: 6001, parentPid: 5000, name: "node.exe" }];
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        offlineProcessFingerprint: processSnapshotFingerprint(processes),
      },
    });
    assert.equal(normalizeNapCatStatus({ reachable: true, accountMatches: true }).known, false);
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      checkNapCatStatus: async () => ({ reachable: true, accountMatches: true }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes }),
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    assert.equal(stopCount, 0);
    const runtime = readRuntime(fixture);
    assert.equal(runtime.login.unknownProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.actions.staleNapCatRecovery.trigger, "status_unknown");
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "grace_period");
  } finally {
    fixture.cleanup();
  }
});

test("监督器与 task router 使用彼此独立的 runtime、stop 和 lock 文件", () => {
  const fixture = createFixture();
  try {
    const dependencies = createSupervisorDependencies({
      ...fixture,
      notifier: {},
      registry: {},
      routerController: {},
    });
    assert.equal(dependencies.environment.NAPCAT_TASK_ROUTER_RUNTIME_PATH, path.join(fixture.root, "state", "task-router-runtime.json"));
    assert.equal(dependencies.environment.NAPCAT_TASK_ROUTER_STOP_PATH, path.join(fixture.root, "state", "task-router.stop"));
    assert.equal(dependencies.environment.NAPCAT_TASK_ROUTER_LOCK_PATH, path.join(fixture.root, "state", "task-router.lock"));
    assert.notEqual(dependencies.environment.NAPCAT_TASK_ROUTER_RUNTIME_PATH, fixture.runtimeStatePath);
    assert.notEqual(dependencies.environment.NAPCAT_TASK_ROUTER_STOP_PATH, fixture.stopFilePath);
    assert.notEqual(dependencies.environment.NAPCAT_TASK_ROUTER_LOCK_PATH, fixture.lockPath);
  } finally {
    fixture.cleanup();
  }
});

test("监督器从 NAPCAT_MCP_ROOT 启动 task router，但仍把状态保存在 DataRoot", () => {
  const fixture = createFixture();
  const codeRoot = path.join(fixture.root, "services", "napcat-bridge", "current");
  let controllerOptions = null;
  try {
    const dependencies = createSupervisorDependencies({
      ...fixture,
      privateEnvironment: {
        NAPCAT_MCP_ROOT: codeRoot,
        NAPCAT_HTTP_URL: "http://127.0.0.1:3010",
        NAPCAT_ACCESS_TOKEN: "test-token",
      },
      notifier: {},
      registry: {},
      createTaskRouterController(options) {
        controllerOptions = options;
        return {};
      },
    });
    assert.equal(dependencies.codeRoot, path.resolve(codeRoot));
    assert.equal(controllerOptions.rootDir, path.resolve(fixture.root));
    assert.equal(controllerOptions.runnerPath, path.join(path.resolve(codeRoot), "src", "task-router-runner.mjs"));
    assert.equal(controllerOptions.env.NAPCAT_TASK_REGISTRY_PATH, path.resolve(fixture.registryPath));
  } finally {
    fixture.cleanup();
  }
});

test("满足 broker、NapCat 固定账号、Codex 和 open task 后才启动 task router", async () => {
  const fixture = createFixture();
  let startCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      startTaskRouter() {
        startCount += 1;
        return { started: true, pid: 5001 };
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "once_completed");
    assert.equal(startCount, 1);
    assert.equal(runtime.checks.gate, true);
    assert.equal(runtime.openTaskCount, 1);
    assert.equal(runtime.actions.taskRouter.succeeded, true);
    assert.equal(fs.existsSync(fixture.lockPath), false);
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.runtimeStatePath)).filter((name) => name.includes(".tmp-")), []);
    assert.match(fs.readFileSync(fixture.logPath, "utf8"), /"type":"supervisor_check"/);
  } finally {
    fixture.cleanup();
  }
});

test("任一前置条件不满足时不启动 task router，也不恢复 heartbeat", async () => {
  const fixture = createFixture();
  let startCount = 0;
  let heartbeatCalls = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      checkBrokerHealth: async () => ({ known: true, healthy: false, reachable: true }),
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true }),
      checkCodexProcesses: async () => ({ known: true, present: true }),
      getOpenTaskCount: async () => 1,
      startTaskRouter() {
        startCount += 1;
        return { started: true };
      },
      resumeHeartbeat() {
        heartbeatCalls += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(result.state, "stopped");
    assert.equal(startCount, 0);
    assert.equal(heartbeatCalls, 0);
    assert.equal(runtime.checks.gate, false);
    assert.equal(runtime.actions.taskRouter.reason, "gate_closed");
  } finally {
    fixture.cleanup();
  }
});

test("broker 或 NapCat 进程缺失时即使接口健康也关闭 router 门槛", async () => {
  for (const missingProcess of ["broker", "napcat"]) {
    const fixture = createFixture();
    let startCount = 0;
    try {
      await runSupervisorService(baseOptions(fixture, {
        ...(missingProcess === "broker"
          ? { checkBrokerProcesses: async () => ({ known: true, present: false, processes: [] }) }
          : { checkNapCatProcesses: async () => ({ known: true, present: false, processes: [] }) }),
        startTaskRouter() {
          startCount += 1;
          return { started: true };
        },
      }));
      const runtime = readRuntime(fixture);
      assert.equal(startCount, 0);
      assert.equal(runtime.checks.gate, false);
      assert.equal(runtime.actions.taskRouter.reason, "gate_closed");
    } finally {
      fixture.cleanup();
    }
  }
});

test("broker health 离线且没有 broker 进程时才调用隐藏启动回调", async () => {
  const fixture = createFixture();
  let startCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      checkBrokerHealth: async () => ({ known: true, healthy: false, reachable: true }),
      checkBrokerProcesses: async () => ({ known: true, present: false }),
      startBroker(input) {
        startCount += 1;
        assert.equal(input.hidden, true);
        return { started: true };
      },
    }));
    assert.equal(result.state, "stopped");
    assert.equal(startCount, 1);
    assert.equal(readRuntime(fixture).actions.brokerStart.succeeded, true);
  } finally {
    fixture.cleanup();
  }
});

test("OneBot 离线但已有 NapCat 进程时不启动第二份，且无 open task 不启动 router", async () => {
  const fixture = createFixture();
  let loginCount = 0;
  let routerCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 6001, name: "NapCat.exe" }] }),
      getOpenTaskCount: async () => 0,
      quickLogin() {
        loginCount += 1;
      },
      startTaskRouter() {
        routerCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(result.state, "stopped");
    assert.equal(loginCount, 0);
    assert.equal(routerCount, 0);
    assert.equal(runtime.actions.quickLogin.reason, "napcat_process_present");
    assert.equal(runtime.checks.gate, false);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 离线且无进程时调用无二维码登录，并在冷却内抑制重复调用", async () => {
  const fixture = createFixture();
  const attempts = [];
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  try {
    const result = await runSupervisorService(baseOptions(fixture, {
      once: false,
      now: () => currentTime,
      loginCooldownMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin(input) {
        attempts.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 1_000);
        if (waitCount >= 3) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    assert.equal(result.state, "stopped");
    assert.equal(result.stopReason, "stop_file");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].noQr, true);
    assert.equal(attempts[0].timeoutMs, 30_000);
    assert.equal(waitCount, 3);
    assert.equal(readRuntime(fixture).login.lastResult, "started");
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 核心文件缺失时不把运行损坏误判为快速登录授权过期", async () => {
  const fixture = createFixture();
  let loginCount = 0;
  try {
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: false, online: false, accountMatches: false }),
      checkNapCatRuntime: async () => ({
        known: true,
        ready: false,
        napcatRoot: fixture.napcatRoot,
        requiredFiles: [path.join(fixture.napcatRoot, "launcher-user.bat"), path.join(fixture.napcatRoot, "napcat.mjs")],
        missingFiles: [path.join(fixture.napcatRoot, "napcat.mjs")],
        error: {
          code: "NAPCAT_RUNTIME_INCOMPLETE",
          message: "NapCat 运行文件缺失",
          outcomeUnknown: false,
        },
      }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin() {
        loginCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(loginCount, 0);
    assert.equal(runtime.actions.quickLogin.reason, "runtime_incomplete");
    assert.equal(runtime.actions.quickLogin.error.code, "NAPCAT_RUNTIME_INCOMPLETE");
    assert.equal(runtime.checks.napcatRuntime.ready, false);
    assert.deepEqual(runtime.checks.napcatRuntime.missingFiles, [path.join(fixture.napcatRoot, "napcat.mjs")]);
    assert.equal(runtime.checks.gate, false);
  } finally {
    fixture.cleanup();
  }
});

test("OneBot 端口不可达且没有 NapCat 进程时仍尝试快速登录", async () => {
  const fixture = createFixture();
  let loginCount = 0;
  try {
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3010"); },
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      quickLogin() {
        loginCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(loginCount, 1);
    assert.equal(runtime.actions.quickLogin.succeeded, true);
    assert.equal(runtime.checks.napcat.known, false);
  } finally {
    fixture.cleanup();
  }
});

test("runtime 中的 quick-login 冷却会跨监督器重启保留", async () => {
  const fixture = createFixture();
  const attempts = [];
  try {
    const common = {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: false }),
      getOpenTaskCount: async () => 0,
      loginCooldownMs: 60_000,
      quickLogin(input) {
        attempts.push(input);
      },
    };
    await runSupervisorService(baseOptions(fixture, common));
    await runSupervisorService(baseOptions(fixture, {
      ...common,
      now: () => new Date("2026-07-24T08:00:01.000Z"),
    }));
    assert.equal(attempts.length, 1);
    assert.equal(readRuntime(fixture).actions.quickLogin.reason, "cooldown");
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 恢复在线后会清除跨重启保留的离线进程计时", async () => {
  const fixture = createFixture();
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        staleRecoveryLastAttemptAt: "2026-07-24T07:05:00.000Z",
        staleRecoveryNextAllowedAt: "2026-07-24T07:10:00.000Z",
        staleRecoveryCount: 2,
        staleRecoveryLastResult: "stopped",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 7003, name: "node.exe" }] }),
    }));
    const runtime = readRuntime(fixture);
    assert.equal(runtime.login.offlineProcessSince, null);
    assert.equal(runtime.login.staleRecoveryCount, 2);
    assert.equal(runtime.actions.staleNapCatRecovery, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("跨重启发现新的 NapCat 进程身份后重新开始离线宽限期", async () => {
  const fixture = createFixture();
  let stopCount = 0;
  const currentProcesses = [{ pid: 7101, parentPid: 5000, name: "node.exe" }];
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
        offlineProcessFingerprint: "old-process-fingerprint",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: currentProcesses }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCount, 0);
    assert.equal(runtime.login.offlineProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.login.offlineProcessFingerprint, processSnapshotFingerprint(currentProcesses));
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "grace_period");
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 连续离线超过宽限期时只停止匹配进程树并立即无二维码恢复", async () => {
  const fixture = createFixture();
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  const stopCalls = [];
  const loginCalls = [];
  try {
    await runSupervisorService(baseOptions(fixture, {
      once: false,
      now: () => currentTime,
      scanIntervalMs: 60_000,
      staleNapCatOfflineMs: 120_000,
      staleNapCatRecoveryCooldownMs: 300_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({
        known: true,
        present: true,
        processes: [
          { pid: 6001, parentPid: 5000, name: "cmd.exe" },
          { pid: 6002, parentPid: 6001, name: "node.exe" },
        ],
      }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses(input) {
        stopCalls.push(input);
        return { stopped: true, rootProcessIds: [6001] };
      },
      quickLogin(input) {
        loginCalls.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 60_000);
        if (waitCount >= 3) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCalls.length, 1);
    assert.deepEqual(stopCalls[0].processes.map((item) => item.pid), [6001, 6002]);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].noQr, true);
    assert.equal(runtime.login.staleRecoveryCount, 1);
    assert.equal(runtime.login.offlineProcessSince, null);
    assert.equal(runtime.actions.staleNapCatRecovery.succeeded, true);
    assert.equal(runtime.actions.quickLogin.succeeded, true);
  } finally {
    fixture.cleanup();
  }
});

test("人工登录阻断时不会停止现有 NapCat 进程", async () => {
  const fixture = createFixture();
  let stopCount = 0;
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        blocked: true,
        blockedAt: "2026-07-24T07:00:00.000Z",
        blockedReason: { code: "NAPCAT_MANUAL_LOGIN_REQUIRED", message: "需要人工登录" },
        offlineProcessSince: "2026-07-24T07:00:00.000Z",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatOfflineMs: 60_000,
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: false, accountMatches: false }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: [{ pid: 6001, parentPid: 5000, name: "cmd.exe" }] }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    assert.equal(stopCount, 0);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat 状态持续未知超过宽限期时停止同一进程树并立即无二维码恢复", async () => {
  const fixture = createFixture();
  let currentTime = new Date("2026-07-24T08:00:00.000Z");
  let waitCount = 0;
  const processes = [
    { pid: 6301, parentPid: 5300, name: "cmd.exe" },
    { pid: 6302, parentPid: 6301, name: "node.exe" },
  ];
  const stopCalls = [];
  const loginCalls = [];
  try {
    await runSupervisorService(baseOptions(fixture, {
      once: false,
      now: () => currentTime,
      scanIntervalMs: 60_000,
      staleNapCatUnknownMs: 180_000,
      staleNapCatRecoveryCooldownMs: 300_000,
      checkNapCatStatus: async () => ({
        known: false,
        reachable: false,
        online: false,
        accountMatches: false,
        error: { code: "ONEBOT_TIMEOUT", message: "timeout" },
      }),
      checkNapCatRuntime: async () => ({ known: true, ready: true, requiredFiles: [], missingFiles: [] }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses(input) {
        stopCalls.push(input);
        return { stopped: true, rootProcessIds: [6301] };
      },
      quickLogin(input) {
        loginCalls.push(input);
      },
      wait: async () => {
        waitCount += 1;
        currentTime = new Date(currentTime.getTime() + 60_000);
        if (waitCount >= 4) fs.writeFileSync(fixture.stopFilePath, "stop\n", "utf8");
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCalls.length, 1);
    assert.deepEqual(stopCalls[0].processes.map((item) => item.pid), [6301, 6302]);
    assert.equal(stopCalls[0].qqExePath, fixture.qqExePath);
    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0].noQr, true);
    assert.equal(runtime.actions.staleNapCatRecovery.succeeded, true);
    assert.equal(runtime.actions.staleNapCatRecovery.trigger, "status_unknown");
    assert.equal(runtime.login.unknownProcessSince, null);
  } finally {
    fixture.cleanup();
  }
});

test("未知状态期间 NapCat 进程身份变化会重新开始宽限期", async () => {
  const fixture = createFixture();
  const currentProcesses = [{ pid: 6401, parentPid: 5400, name: "node.exe" }];
  let stopCount = 0;
  try {
    atomicWriteJson(fixture.runtimeStatePath, {
      login: {
        unknownProcessSince: "2026-07-24T07:00:00.000Z",
        unknownProcessFingerprint: "old-process-fingerprint",
      },
    });
    await runSupervisorService(baseOptions(fixture, {
      now: () => new Date("2026-07-24T08:00:00.000Z"),
      staleNapCatUnknownMs: 60_000,
      checkNapCatStatus: async () => ({
        known: false,
        reachable: false,
        online: false,
        accountMatches: false,
        error: { code: "ONEBOT_TIMEOUT", message: "timeout" },
      }),
      checkNapCatRuntime: async () => ({ known: true, ready: true, requiredFiles: [], missingFiles: [] }),
      checkNapCatProcesses: async () => ({ known: true, present: true, processes: currentProcesses }),
      getOpenTaskCount: async () => 0,
      stopNapCatProcesses() {
        stopCount += 1;
      },
    }));
    const runtime = readRuntime(fixture);
    assert.equal(stopCount, 0);
    assert.equal(runtime.login.unknownProcessSince, "2026-07-24T08:00:00.000Z");
    assert.equal(runtime.login.unknownProcessFingerprint, processSnapshotFingerprint(currentProcesses));
    assert.equal(runtime.actions.staleNapCatRecovery.reason, "grace_period");
  } finally {
    fixture.cleanup();
  }
});

test("进程树根节点计算与 taskkill 调用只覆盖匹配根进程", async () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat";
  const processes = [
    { pid: 6101, parentPid: 5000, name: "cmd.exe", commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"` },
    { pid: 6102, parentPid: 6101, name: "node.exe", commandLine: `node "${napcatRoot}\\index.js"` },
    { pid: 6201, parentPid: 5001, name: "cmd.exe", commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"` },
  ];
  assert.deepEqual(processTreeRootIds(processes), [6101, 6201]);
  const calls = [];
  await stopWindowsProcessTrees(processes, {
    currentPid: 9999,
    napcatRoot,
    taskkillPath: "taskkill.exe",
    listProcesses: async () => processes,
    execFileImpl(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, "SUCCESS", "");
    },
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ["/PID", "6101", "/T", "/F"],
    ["/PID", "6201", "/T", "/F"],
  ]);
});

test("停止前 PID 身份改变时拒绝 taskkill", async () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat";
  const snapshot = [{
    pid: 6101,
    parentPid: 5000,
    name: "cmd.exe",
    commandLine: `cmd /c "${napcatRoot}\\launcher-user.bat"`,
  }];
  let taskkillCount = 0;
  await assert.rejects(
    stopWindowsProcessTrees(snapshot, {
      currentPid: 9999,
      napcatRoot,
      listProcesses: async () => [{
        pid: 6101,
        parentPid: 5000,
        name: "codex.exe",
        commandLine: "codex.exe app-server",
      }],
      execFileImpl(file, args, options, callback) {
        taskkillCount += 1;
        callback(null, "SUCCESS", "");
      },
    }),
    (error) => error.code === "NAPCAT_PROCESS_IDENTITY_CHANGED",
  );
  assert.equal(taskkillCount, 0);
});

test("快速登录明确要求人工扫码后跨监督器重启停止重试，真实在线后自动解除", async () => {
  const fixture = createFixture();
  let attempts = 0;
  const offline = async () => ({ known: true, reachable: true, online: false, accountMatches: false });
  const noProcess = async () => ({ known: true, present: false });
  try {
    const common = {
      checkNapCatStatus: offline,
      checkNapCatProcesses: noProcess,
      getOpenTaskCount: async () => 0,
      quickLogin() {
        attempts += 1;
        const error = new Error("[NAPCAT_MANUAL_LOGIN_REQUIRED] 快速登录记录已不可用");
        error.code = "NAPCAT_MANUAL_LOGIN_REQUIRED";
        throw error;
      },
    };
    await runSupervisorService(baseOptions(fixture, common));
    let runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.login.blocked, true);
    assert.equal(runtime.login.blockedReason.code, "NAPCAT_MANUAL_LOGIN_REQUIRED");

    await runSupervisorService(baseOptions(fixture, {
      ...common,
      now: () => new Date("2026-07-24T08:05:00.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(attempts, 1);
    assert.equal(runtime.actions.quickLogin.reason, "manual_login_required");

    await runSupervisorService(baseOptions(fixture, {
      checkNapCatStatus: async () => ({ known: true, reachable: true, online: true, accountMatches: true, ready: true }),
      checkNapCatProcesses: async () => ({ known: true, present: true }),
      getOpenTaskCount: async () => 0,
      now: () => new Date("2026-07-24T08:06:00.000Z"),
    }));
    runtime = readRuntime(fixture);
    assert.equal(runtime.login.blocked, false);
    assert.equal(runtime.login.blockedAt, null);
    assert.equal(runtime.login.blockedReason, null);
  } finally {
    fixture.cleanup();
  }
});

test("陈旧锁可恢复，活锁会返回 duplicate，runtime JSON 始终原子替换", async () => {
  const staleFixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(staleFixture.lockPath), { recursive: true });
    fs.writeFileSync(staleFixture.lockPath, JSON.stringify({ pid: 9001, startedAt: "old" }), "utf8");
    const recovered = await runSupervisorService(baseOptions(staleFixture, {
      isProcessAlive: () => false,
      getOpenTaskCount: async () => 0,
    }));
    assert.equal(recovered.state, "stopped");
    assert.equal(fs.existsSync(staleFixture.lockPath), false);
    assert.equal(readRuntime(staleFixture).schemaVersion, 1);
    atomicWriteJson(staleFixture.runtimeStatePath, { marker: "replaced" });
    assert.deepEqual(JSON.parse(fs.readFileSync(staleFixture.runtimeStatePath, "utf8")), { marker: "replaced" });
    assert.deepEqual(fs.readdirSync(path.dirname(staleFixture.runtimeStatePath)).filter((name) => name.includes(".tmp-")), []);
  } finally {
    staleFixture.cleanup();
  }

  const liveFixture = createFixture();
  try {
    fs.mkdirSync(path.dirname(liveFixture.lockPath), { recursive: true });
    fs.writeFileSync(liveFixture.lockPath, JSON.stringify({ pid: 9002, startedAt: "2026-07-24T08:00:00.000Z" }), "utf8");
    const duplicate = await runSupervisorService(baseOptions(liveFixture, {
      isProcessAlive: (pid) => pid === 9002,
    }));
    assert.equal(duplicate.state, "duplicate");
    assert.equal(fs.existsSync(liveFixture.runtimeStatePath), false);
  } finally {
    liveFixture.cleanup();
  }
});

test("PowerShell 调用默认隐藏，登录脚本通过 execFile 时仍保留 -NoQr", async () => {
  const calls = [];
  const result = await invokePowerShellScript("C:\\ops\\login.ps1", ["-NoQr"], {
    execFileImpl(executable, argumentsList, options, callback) {
      calls.push({ executable, argumentsList, options });
      callback(null, "ok\n", "");
    },
  });
  assert.equal(result.stdout, "ok\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].argumentsList.includes("-NoQr"), true);
  assert.equal(calls[0].argumentsList.includes("-WindowStyle"), true);
  assert.equal(calls[0].argumentsList[calls[0].argumentsList.indexOf("-WindowStyle") + 1], "Hidden");
});
