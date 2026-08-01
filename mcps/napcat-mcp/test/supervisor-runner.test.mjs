import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  buildQuickLoginArguments,
  createSupervisorDependencies,
  findBrokerProcesses,
  findCodexProcesses,
  findNapCatProcesses,
  parseArguments,
  runQuickLogin,
  runSupervisorService,
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
    ]);
    assert.equal(parsed.scanIntervalMs, 30000);
    assert.equal(parsed.brokerHealthUrl, "http://127.0.0.1:14588/health");
    assert.equal(parsed.privateEnvPath, path.resolve(fixture.privateEnvPath));
    assert.equal(parsed.loginScriptPath, path.resolve(fixture.loginScriptPath));
    assert.equal(parsed.napcatRoot, path.resolve(fixture.napcatRoot));
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
      timeoutMs: 35_000,
      codexHome: fixture.root,
    });
    assert.deepEqual(argumentsList.slice(0, 4), ["-NoQr", "-TimeoutSeconds", "35", "-NapCatRoot"]);
    assert.equal(argumentsList.includes("-Qr"), false);
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
      timeoutMs: 35_000,
      execFileImpl(executable, argumentsList, options, callback) {
        calls.push({ executable, argumentsList, options });
        callback(null, "{}\n", "");
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.timeout, 50_000);
    assert.deepEqual(
      calls[0].argumentsList.slice(-5),
      ["-NoQr", "-TimeoutSeconds", "35", "-NapCatRoot", path.resolve(fixture.napcatRoot)],
    );
  } finally {
    fixture.cleanup();
  }
});

test("进程识别不会把监督器自身、桌面 QQ 或任意 broker 路径误判为目标进程", () => {
  const napcatRoot = "C:\\Users\\ExampleUser\\NapCat-Codex";
  const processes = [
    { ProcessId: 1, Name: "node.exe", CommandLine: `node C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\src\\supervisor-runner.mjs --login-script C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp\\ops\\start-napcat-login.ps1 --napcat-root "${napcatRoot}"` },
    { ProcessId: 2, Name: "QQ.exe", CommandLine: '"C:\\Program Files\\Tencent\\QQNT\\QQ.exe"' },
    { ProcessId: 3, Name: "NapCatWinBootMain.exe", CommandLine: `"${napcatRoot}\\NapCatWinBootMain.exe"` },
    { ProcessId: 4, Name: "node.exe", CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\broker.mjs' },
    { ProcessId: 5, Name: "ChatGPT.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe" --type=crashpad-handler --user-data-dir=C:\\Users\\ExampleUser\\AppData\\Roaming\\Codex' },
    { ProcessId: 6, Name: "ChatGPT.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe"' },
    { ProcessId: 7, Name: "codex.exe", CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\resources\\codex.exe" app-server' },
  ];
  assert.deepEqual(findNapCatProcesses(processes, napcatRoot).map((item) => item.ProcessId), [3]);
  assert.deepEqual(findBrokerProcesses(processes, "C:\\Users\\ExampleUser\\.codex\\mcp-http-broker\\napcat-mcp").map((item) => item.ProcessId), [4]);
  assert.deepEqual(findCodexProcesses(processes).map((item) => item.ProcessId), [6, 7]);
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
