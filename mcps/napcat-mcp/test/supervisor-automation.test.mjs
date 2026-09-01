import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

test("登录时间线采集脚本联合输出登录、掉线、profile 和进程线索", () => {
  const script = fs.readFileSync(fileURLToPath(new URL("../ops/collect-napcat-login-timeline.ps1", import.meta.url)), "utf8");
  assert.match(script, /codex-login-\*\.log/);
  assert.match(script, /KickedOffLine/);
  assert.match(script, /账号状态变更为离线/);
  assert.match(script, /本账号数据\/缓存目录/);
  assert.match(script, /cleanProfileRecentWrites/);
  assert.match(script, /legacyProfileRecentWrites/);
  assert.match(script, /relevantProcesses/);
  assert.match(script, /expectedSelfId/);
});

test("登录与监督器脚本从 runtime 读取独立 QQ，并保留未配置时的旧启动方式", () => {
  const loginScript = fs.readFileSync(fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url)), "utf8");
  const credentialSetterScript = fs.readFileSync(fileURLToPath(new URL("../ops/set-napcat-quick-login-credential.ps1", import.meta.url)), "utf8");
  const supervisorScript = fs.readFileSync(fileURLToPath(new URL("../ops/start-napcat-supervisor.ps1", import.meta.url)), "utf8");
  assert.match(loginScript, /\$RuntimeConfiguration\.qqExePath/);
  assert.match(loginScript, /\$RuntimeConfiguration\.qqUserDataDir/);
  assert.match(loginScript, /\$NodeCoreModule = Join-Path \$NapCatRoot "napcat\\napcat\.mjs"/);
  assert.match(loginScript, /\$ManualLauncher = Join-Path \$NapCatRoot "napcat\.bat"/);
  assert.match(loginScript, /\$NoQr -or \$HasPasswordFallback/);
  assert.match(loginScript, /\$SelectedLauncher = if \(-not \[string\]::IsNullOrWhiteSpace\(\$ExpectedSelfId\)\) \{ \$Launcher \} else \{ \$ManualLauncher \}/);
  assert.match(loginScript, /\$LauncherArguments = if \(\[string\]::IsNullOrWhiteSpace\(\$ExpectedSelfId\)\)/);
  assert.match(loginScript, /" `"\$ExpectedSelfId`""/);
  assert.match(loginScript, /EnvironmentVariables\["APPDATA"\]/);
  assert.match(loginScript, /NAPCAT_QQ_USER_DATA_DIR/);
  assert.doesNotMatch(loginScript, /--user-data-dir/);
  assert.match(loginScript, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
  assert.match(loginScript, /napcat\\cache\\qrcode\.png/);
  assert.match(loginScript, /cache\\qrcode\.png/);
  assert.match(loginScript, /Get-FreshQrCode/);
  assert.match(loginScript, /\$NoQr -and \$null -ne \$QrCode/);
  assert.match(loginScript, /CommandLineHints/);
  assert.match(loginScript, /Stop-LaunchedProcessTree -RootProcessId \$ProcessId -CommandLineHints @\(\$NapCatRoot, \$QqExePath\)/);
  assert.match(loginScript, /taskkill\.exe" \/PID \$RootProcessId \/T \/F/);
  assert.doesNotMatch(loginScript, /Get-CimInstance Win32_Process\s*\|[\s\S]*Stop-Process/);
  assert.match(loginScript, /Test-PasswordFallbackNeedsHuman/);
  assert.match(loginScript, /proofWaterUrl/);
  assert.match(loginScript, /sms-verify-login/);
  assert.match(loginScript, /KickedOffLine/);
  assert.match(loginScript, /\$ActualNickname\) -and \$ActualNickname -ne \$ExpectedNickname/);
  assert.match(loginScript, /按安全策略停止自动重试/);
  assert.match(loginScript, /短信验证/);
  assert.match(loginScript, /Read-NapCatQuickLoginCredential/);
  assert.match(loginScript, /\$NoQr -and \(-not \$NoPasswordFallback\)/);
  assert.match(loginScript, /ManualVerificationExtensionSeconds/);
  assert.match(loginScript, /\$ExtendedDeadline -gt \$Deadline/);
  assert.match(loginScript, /\[switch\]\$NoPasswordFallback/);
  assert.doesNotMatch(loginScript, /\$QuickPasswordMd5 = if \(\$NoPasswordFallback\)/);
  assert.match(loginScript, /自动路径已禁用密码回退/);
  assert.match(loginScript, /NAPCAT_QUICK_PASSWORD_MD5/);
  assert.match(loginScript, /PasswordFallbackDeadlineUtc/);
  assert.match(loginScript, /NapCatWinBootMain\.exe/);
  assert.match(loginScript, /NapCatWinBootHook\.dll/);
  assert.match(loginScript, /\$Launcher/);
  assert.match(loginScript, /\$BootMain/);
  assert.match(loginScript, /napcat-login-attempt-\$SafeAccount\.lock/);
  assert.match(loginScript, /\[System\.IO\.FileShare\]::None/);
  assert.match(loginScript, /NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS/);
  assert.match(loginScript, /Release-NapCatLoginAttemptLock -Lock \$LoginAttemptLock/);
  assert.doesNotMatch(credentialSetterScript, /\[string\]\$PasswordMd5/);
  assert.doesNotMatch(credentialSetterScript, /TestPasswordMd5/);
  assert.match(supervisorScript, /\$RuntimeConfiguration\.qqExePath/);
  assert.match(supervisorScript, /"--qq-exe-path"/);
});

test("Node 一键包生成嵌套二维码后 NoQr 立即进入人工登录阻断", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-login-qrcode-layout-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  const nestedQrPath = path.join(runtimeRoot, "napcat", "cache", "qrcode.png");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "napcat.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(runtimeRoot, "launcher-user.bat"),
    [
      "@echo off",
      'if not exist "%~dp0napcat\\cache" mkdir "%~dp0napcat\\cache"',
      `> "${nestedQrPath}" echo qr`,
      "ping 127.0.0.1 -n 60 >nul",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeJson(path.join(brokerRoot, "broker-private.env.json"), {
    NAPCAT_HTTP_URL: "http://127.0.0.1:65534",
    NAPCAT_ACCESS_TOKEN: "test-token",
  });
  writeJson(path.join(dataRoot, "binding.json"), {
    expectedSelfId: "10001",
    expectedNickname: "test-account",
  });

  const scriptPath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
  const startedAt = Date.now();
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-NoQr",
    "-TimeoutSeconds", "30",
    "-NapCatRoot", runtimeRoot,
    "-DataRoot", dataRoot,
    "-BrokerRoot", brokerRoot,
  ], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
  assert.ok(Date.now() - startedAt < 10_000, "NoQr should stop after detecting the fresh QR instead of waiting 30 seconds");
});

test("加密密码回退明确返回密码错误时才禁用 DPAPI 凭据", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-login-password-fallback-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  const markerPath = path.join(root, "password-env-present.txt");
  const nestedQrPath = path.join(runtimeRoot, "napcat", "cache", "qrcode.png");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "napcat.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(runtimeRoot, "launcher-user.bat"),
    [
      "@echo off",
      `if defined NAPCAT_QUICK_PASSWORD_MD5 (> "${markerPath}" echo present)`,
      'if not exist "%~dp0napcat\\cache" mkdir "%~dp0napcat\\cache"',
      `> "${nestedQrPath}" echo qr`,
      "ping 127.0.0.1 -n 3 >nul",
      "echo incorrect password",
      "ping 127.0.0.1 -n 60 >nul",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeJson(path.join(brokerRoot, "broker-private.env.json"), {
    NAPCAT_HTTP_URL: "http://127.0.0.1:65534",
    NAPCAT_ACCESS_TOKEN: "test-token",
  });
  writeJson(path.join(dataRoot, "binding.json"), {
    expectedSelfId: "10001",
    expectedNickname: "test-account",
  });

  const setterPath = fileURLToPath(new URL("../ops/set-napcat-quick-login-credential.ps1", import.meta.url));
  const testPassword = "napcat-test-password";
  const testPasswordMd5 = createHash("md5").update(testPassword, "utf8").digest("hex");
  const setterInvocationPath = path.join(root, "configure-test-credential.ps1");
  const quotePowerShell = (value) => String(value).replaceAll("'", "''");
  fs.writeFileSync(setterInvocationPath, `\uFEFF${[
    `$password = ConvertTo-SecureString '${quotePowerShell(testPassword)}' -AsPlainText -Force`,
    `& '${quotePowerShell(setterPath)}' -Password $password -DataRoot '${quotePowerShell(dataRoot)}' -BrokerRoot '${quotePowerShell(brokerRoot)}'`,
    "",
  ].join("\r\n")}`, "utf8");
  const configured = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", setterInvocationPath,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);
  const credentialPath = path.join(dataRoot, "private", "napcat-login", "credential.json");
  const credentialText = fs.readFileSync(credentialPath, "utf8");
  assert.equal(credentialText.includes(testPasswordMd5), false);
  assert.doesNotMatch(credentialText, /10001/);
  assert.equal(Object.hasOwn(JSON.parse(credentialText), "accountSha256"), false);
  const aclCommand = [
    `$acl = Get-Acl -LiteralPath '${quotePowerShell(credentialPath)}'`,
    "$rules = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })",
    "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; rules = $rules; currentSid = $currentSid } | ConvertTo-Json -Depth 3 -Compress",
  ].join("; ");
  const aclResult = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", aclCommand], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(aclResult.status, 0, `${aclResult.stdout}\n${aclResult.stderr}`);
  const acl = JSON.parse(aclResult.stdout.trim());
  assert.equal(acl.protected, true);
  assert.deepEqual(new Set(acl.rules), new Set(["S-1-5-18", acl.currentSid]));

  const loginScriptPath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
  const startedAt = Date.now();
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", loginScriptPath,
    "-NoQr",
    "-TimeoutSeconds", "30",
    "-NapCatRoot", runtimeRoot,
    "-DataRoot", dataRoot,
    "-BrokerRoot", brokerRoot,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const elapsedMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim(), "present");
  assert.equal(fs.existsSync(credentialPath), false);
  const disabledMarker = readJson(path.join(dataRoot, "private", "napcat-login", "credential.disabled.json"));
  assert.equal(disabledMarker.reason, "password_fallback_login_failed");
  assert.equal(fs.existsSync(disabledMarker.disabledCredentialPath), true);
  const loginLogs = fs.readdirSync(path.join(runtimeRoot, "logs"))
    .filter((name) => name.startsWith("codex-login-"))
    .map((name) => fs.readFileSync(path.join(runtimeRoot, "logs", name), "utf8"))
    .join("\n");
  assert.equal(loginLogs.includes(testPasswordMd5), false);
  assert.ok(elapsedMs >= 1_500, `password fallback should receive a grace period, elapsed=${elapsedMs}`);
  assert.ok(elapsedMs < 10_000, `explicit password fallback failure should stop quickly, elapsed=${elapsedMs}`);
});

test("加密密码回退密码错误后进程立即退出也会阻断自动重试", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-login-password-fast-exit-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  const markerPath = path.join(root, "password-env-present.txt");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "napcat.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(runtimeRoot, "launcher-user.bat"),
    [
      "@echo off",
      `if defined NAPCAT_QUICK_PASSWORD_MD5 (> "${markerPath}" echo present)`,
      "echo incorrect password",
      "exit /b 3",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeJson(path.join(brokerRoot, "broker-private.env.json"), {
    NAPCAT_HTTP_URL: "http://127.0.0.1:65534",
    NAPCAT_ACCESS_TOKEN: "test-token",
  });
  writeJson(path.join(dataRoot, "binding.json"), {
    expectedSelfId: "10001",
    expectedNickname: "test-account",
  });

  const setterPath = fileURLToPath(new URL("../ops/set-napcat-quick-login-credential.ps1", import.meta.url));
  const testPassword = "napcat-test-password";
  const setterInvocationPath = path.join(root, "configure-test-credential.ps1");
  const quotePowerShell = (value) => String(value).replaceAll("'", "''");
  fs.writeFileSync(setterInvocationPath, `\uFEFF${[
    `$password = ConvertTo-SecureString '${quotePowerShell(testPassword)}' -AsPlainText -Force`,
    `& '${quotePowerShell(setterPath)}' -Password $password -DataRoot '${quotePowerShell(dataRoot)}' -BrokerRoot '${quotePowerShell(brokerRoot)}'`,
    "",
  ].join("\r\n")}`, "utf8");
  const configured = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", setterInvocationPath,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);

  const credentialPath = path.join(dataRoot, "private", "napcat-login", "credential.json");
  const loginScriptPath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
  const startedAt = Date.now();
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", loginScriptPath,
    "-NoQr",
    "-TimeoutSeconds", "30",
    "-NapCatRoot", runtimeRoot,
    "-DataRoot", dataRoot,
    "-BrokerRoot", brokerRoot,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const elapsedMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim(), "present");
  assert.equal(fs.existsSync(credentialPath), false);
  const disabledMarker = readJson(path.join(dataRoot, "private", "napcat-login", "credential.disabled.json"));
  assert.equal(disabledMarker.reason, "password_fallback_login_failed");
  assert.ok(elapsedMs < 10_000, `fast password fallback failure should stop quickly, elapsed=${elapsedMs}`);
});

test("密码回退要求短信验证且没有二维码文件时 NoQr 也会阻断自动重试", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-login-password-captcha-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "napcat.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(runtimeRoot, "launcher-user.bat"),
    [
      "@echo off",
      "ping 127.0.0.1 -n 3 >nul",
      "echo 快速登录错误： 登录态已失效，请重新登录。",
      "echo 正在尝试密码回退登录 10001",
      "echo 需要验证码, proofWaterUrl: https://ti.qq.com/safe/tools/captcha/sms-verify-login",
      "echo 密码回退登录失败",
      "ping 127.0.0.1 -n 60 >nul",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeJson(path.join(brokerRoot, "broker-private.env.json"), {
    NAPCAT_HTTP_URL: "http://127.0.0.1:65534",
    NAPCAT_ACCESS_TOKEN: "test-token",
  });
  writeJson(path.join(dataRoot, "binding.json"), {
    expectedSelfId: "10001",
    expectedNickname: "test-account",
  });

  const setterPath = fileURLToPath(new URL("../ops/set-napcat-quick-login-credential.ps1", import.meta.url));
  const setterInvocationPath = path.join(root, "configure-test-credential.ps1");
  const quotePowerShell = (value) => String(value).replaceAll("'", "''");
  fs.writeFileSync(setterInvocationPath, `\uFEFF${[
    "$password = ConvertTo-SecureString 'napcat-test-password' -AsPlainText -Force",
    `& '${quotePowerShell(setterPath)}' -Password $password -DataRoot '${quotePowerShell(dataRoot)}' -BrokerRoot '${quotePowerShell(brokerRoot)}'`,
    "",
  ].join("\r\n")}`, "utf8");
  const configured = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", setterInvocationPath,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);

  const loginScriptPath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
  const startedAt = Date.now();
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", loginScriptPath,
    "-NoQr",
    "-TimeoutSeconds", "30",
    "-NapCatRoot", runtimeRoot,
    "-DataRoot", dataRoot,
    "-BrokerRoot", brokerRoot,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const elapsedMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
  assert.ok(elapsedMs >= 1_500, `password fallback should have a short grace period, elapsed=${elapsedMs}`);
  assert.ok(elapsedMs < 10_000, `SMS verification should stop quickly without requiring a QR file, elapsed=${elapsedMs}`);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "napcat", "cache", "qrcode.png")), false);
  const credentialPath = path.join(dataRoot, "private", "napcat-login", "credential.json");
  assert.equal(fs.existsSync(credentialPath), true);
  assert.equal(fs.existsSync(path.join(dataRoot, "private", "napcat-login", "credential.disabled.json")), false);
});

test("登录进程提前退出前输出 KickedOffLine 时 NoQr 仍会持久阻断", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-login-fast-exit-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "napcat.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(runtimeRoot, "launcher-user.bat"),
    [
      "@echo off",
      "echo [KickedOffLine] 你的帐号当前登录态失效，请重新登录",
      "exit /b 1",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeJson(path.join(brokerRoot, "broker-private.env.json"), {
    NAPCAT_HTTP_URL: "http://127.0.0.1:65534",
    NAPCAT_ACCESS_TOKEN: "test-token",
  });
  writeJson(path.join(dataRoot, "binding.json"), {
    expectedSelfId: "10001",
    expectedNickname: "test-account",
  });

  const loginScriptPath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", loginScriptPath,
    "-NoQr",
    "-TimeoutSeconds", "30",
    "-NapCatRoot", runtimeRoot,
    "-DataRoot", dataRoot,
    "-BrokerRoot", brokerRoot,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
});

test("密码回退把验证码写入 stderr 时 NoQr 也会停止重试", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-login-stderr-captcha-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "napcat.mjs"), "export {};\n", "utf8");
  fs.writeFileSync(
    path.join(runtimeRoot, "launcher-user.bat"),
    [
      "@echo off",
      "ping 127.0.0.1 -n 3 >nul",
      ">&2 echo 正在尝试密码回退登录 10001",
      ">&2 echo 需要短信验证, proofWaterUrl: https://ti.qq.com/safe/tools/captcha/sms-verify-login",
      ">&2 echo 密码回退登录失败",
      "ping 127.0.0.1 -n 60 >nul",
      "",
    ].join("\r\n"),
    "utf8",
  );
  writeJson(path.join(brokerRoot, "broker-private.env.json"), {
    NAPCAT_HTTP_URL: "http://127.0.0.1:65534",
    NAPCAT_ACCESS_TOKEN: "test-token",
  });
  writeJson(path.join(dataRoot, "binding.json"), {
    expectedSelfId: "10001",
    expectedNickname: "test-account",
  });

  const setterPath = fileURLToPath(new URL("../ops/set-napcat-quick-login-credential.ps1", import.meta.url));
  const setterInvocationPath = path.join(root, "configure-test-credential.ps1");
  const quotePowerShell = (value) => String(value).replaceAll("'", "''");
  fs.writeFileSync(setterInvocationPath, `\uFEFF${[
    "$password = ConvertTo-SecureString 'napcat-test-password' -AsPlainText -Force",
    `& '${quotePowerShell(setterPath)}' -Password $password -DataRoot '${quotePowerShell(dataRoot)}' -BrokerRoot '${quotePowerShell(brokerRoot)}'`,
    "",
  ].join("\r\n")}`, "utf8");
  const configured = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", setterInvocationPath,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(configured.status, 0, `${configured.stdout}\n${configured.stderr}`);

  const loginScriptPath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
  const startedAt = Date.now();
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", loginScriptPath,
    "-NoQr",
    "-TimeoutSeconds", "30",
    "-NapCatRoot", runtimeRoot,
    "-DataRoot", dataRoot,
    "-BrokerRoot", brokerRoot,
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  const elapsedMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0);
  assert.match(output, /NAPCAT_MANUAL_LOGIN_REQUIRED/);
  assert.ok(elapsedMs >= 1_500, `password fallback should have a short grace period, elapsed=${elapsedMs}`);
  assert.ok(elapsedMs < 10_000, `stderr SMS verification should stop quickly, elapsed=${elapsedMs}`);
  const credentialPath = path.join(dataRoot, "private", "napcat-login", "credential.json");
  assert.equal(fs.existsSync(credentialPath), true);
  assert.equal(fs.existsSync(path.join(dataRoot, "private", "napcat-login", "credential.disabled.json")), false);
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
  fs.copyFileSync(fileURLToPath(new URL("../ops/resolve-napcat-data-root.ps1", import.meta.url)), path.join(opsRoot, "resolve-napcat-data-root.ps1"));
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

test("已被健康实例取代的旧告警不会重新发送", async () => {
  const fixture = createFixture();
  const sends = [];
  try {
    writeJson(fixture.automationAlertPath, {
      status: "superseded",
      pending: false,
      incidentKey: "codex-app-server-proxy:LISTEN_FAILED",
      text: "这条旧告警不应重新发送",
      supersededAt: "2026-08-26T08:36:42.403Z",
      supersededBy: "healthy-proxy:test-instance",
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
    assert.equal(runtime.alert.status, "superseded");
    assert.equal(runtime.alert.pending, false);
    assert.equal(Object.hasOwn(runtime.actions, "alert"), false);
    assert.equal(alertFile.status, "superseded");
    assert.equal(alertFile.pending, false);
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
