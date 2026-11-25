import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { invokeOfflineRecoveryGuard, runSupervisorService } from "../src/supervisor-runner.mjs";

const ops = fileURLToPath(new URL("../ops/", import.meta.url));
const defaultWinPs = path.join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
const powershell = process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH
  || process.env.NAPCAT_POWERSHELL_PATH
  || defaultWinPs;
const isPwsh = path.win32.basename(powershell).toLowerCase() === "pwsh.exe";
const windows = { skip: process.platform !== "win32", timeout: 90000 };
const fakeAccount = "123456";
const token = "fixture-not-a-real-secret";
const digest = value => createHash("sha256").update(value).digest("hex");
const quoted = value => "'" + value.replaceAll("'", "''") + "'";
const putJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value));
const noAction = reason => ({ status: "deferred", changed: false, reason, nativeQuickLoginVerified: false });
const online = value => ({ status: "ok", retcode: 0, data: { online: value, good: true } });

function start(fixture, executable, args, extraOptions = {}) {
  const child = spawn(executable, args, { cwd: fixture.root, windowsHide: true, stdio: "pipe", ...extraOptions });
  child.stdin.on("error", () => {});
  const completed = once(child, "close");
  fixture.children.push({ child, completed });
  return { child, completed };
}

function powerShellEnv(forPwsh = isPwsh) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase();
    if (lower === "psexecutionpolicypreference" || (forPwsh && lower === "psmodulepath")) {
      delete env[key];
    }
  }
  return env;
}

function psFile(fixture, filename) {
  return start(fixture, powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    ...(isPwsh ? [] : ["-ExecutionPolicy", "Bypass"]),
    "-File", filename,
  ], { env: powerShellEnv() });
}

function ps(fixture, script) {
  const filename = path.join(fixture.root, "guard-fixture-" + fixture.children.length + ".ps1");
  fs.writeFileSync(filename, "\ufeff$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n" + script);
  return psFile(fixture, filename);
}

async function receive({ child, completed }, input = "") {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdin.end(input);
  const [exitCode, signal] = await completed;
  assert.equal(exitCode, 0, JSON.stringify({ signal, stderr, stdout }));
  assert.equal(stderr, "");
  return stdout.trim();
}

if (process.platform === "win32") test.before(async () => {
  assert.ok(!process.env.PSExecutionPolicyPreference, "Use the normal Windows PowerShell policy without a process override");
  const script = path.join(ops, "invoke-napcat-offline-recovery.ps1");
  const result = await receive(psFile({ root: ops, children: [] }, script), "{}");
  assert.deepEqual(JSON.parse(result), noAction("invalid_request"));
});

test("the same native helper waits for permission before receiving the recovery request", windows, async context => {
  const fixture = await makeFixture(context);
  const actual = path.join(fixture.root, "ops", "invoke-napcat-offline-recovery.ps1");
  const protectedFiles = [fixture.paths.bindingPath, fixture.paths.privateEnvPath, fixture.paths.loginScriptPath,
    path.join(fixture.paths.accountStateDir, "deployment.json")];
  const original = protectedFiles.map(file => fs.readFileSync(file));
  const visibleFiles = fs.readdirSync(fixture.paths.accountStateDir);
  const request = { schema: "napcat.offline-recovery-request/v1", action: "quick-login", paths: fixture.paths,
    root: null, processes: [], deadlineAt: Date.now() + 75_000, timeoutSeconds: 30 };
  let decisions = 0;
  assert.deepEqual(await invokeOfflineRecoveryGuard(request, {
    scriptPath: actual, timeoutMs: 8000, beforeDispatch() { decisions += 1; return false; },
  }), noAction("maintenance_active"));
  assert.equal(decisions, 1);
  assert.deepEqual(fs.readdirSync(fixture.paths.accountStateDir), visibleFiles);
  assert.deepEqual(protectedFiles.map(file => fs.readFileSync(file)), original);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.loginCalls(), 0);
  const approved = await invokeOfflineRecoveryGuard(request, {
    scriptPath: actual, timeoutMs: 15_000, beforeDispatch() {
      assert.equal(fixture.loginCalls(), 0);
      decisions += 1;
      return true;
    },
  });
  assert.equal(approved.status, "started");
  assert.equal(approved.changed, true);
  assert.equal(decisions, 2);
  assert.equal(fixture.loginCalls(), 1);
});

test("a lost native result after actual dispatch stays unknown", windows, async context => {
  const fixture = await makeFixture(context);
  const scriptPath = path.join(fixture.root, "commit-and-lose-result.ps1");
  const receivedPath = path.join(fixture.root, "received.json");
  fs.writeFileSync(scriptPath, "\ufeffparam([switch]\$AwaitDurableCommit)\n"
    + "if (-not \$AwaitDurableCommit) { exit 24 }\n"
    + "[Console]::Out.WriteLine('NAPCAT_OFFLINE_GUARD_READY_V1')\n[Console]::Out.Flush()\n"
    + "[IO.File]::WriteAllText(" + quoted(receivedPath) + ", [Console]::In.ReadToEnd())\nexit 23\n");
  const request = { marker: "fixture-only", action: "not-a-real-operation" };
  let allowed = 0;
  await assert.rejects(invokeOfflineRecoveryGuard(request, {
    scriptPath, timeoutMs: 8_000, beforeDispatch() {
      assert.equal(fs.existsSync(receivedPath), false);
      allowed += 1;
      return true;
    },
  }), { code: "NAPCAT_OFFLINE_GUARD_OUTCOME_UNKNOWN", outcomeUnknown: true });
  assert.equal(allowed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(receivedPath, "utf8")), request);
  assert.equal(fixture.loginCalls(), 0);
});

test("native cleanup failure is recorded without replacing a verified login receipt", windows, async context => {
  const fixture = await makeFixture(context);
  const guard = path.join(fixture.root, "ops", "napcat-offline-recovery-guard.ps1");
  fs.appendFileSync(guard, String.raw`
$ExitFixtureGuard = (Get-Item Function:Exit-NapCatOfflineRecoveryGuard).ScriptBlock
function Exit-NapCatOfflineRecoveryGuard {
  param($Guard)
  & $ExitFixtureGuard -Guard $Guard
  throw 'fixture_cleanup_diagnostic'
}
`);
  const result = await fixture.invoke();
  assert.equal(result.status, "started");
  assert.equal(result.changed, true);
  assert.equal(result.cleanupFailed, true);
  assert.equal(fixture.loginCalls(), 1);
});

test("an unavailable native guard never reserves an offline recovery or blocks the prior login state", windows, async context => {
  const fixture = await makeFixture(context);
  const { paths } = fixture;
  const state = path.join(paths.dataRoot, "state");
  const stopFilePath = path.join(state, "supervisor.stop");
  const runtimeStatePath = path.join(state, "supervisor-runtime.json");
  const barrierPath = path.join(state, "napcat-offline-recovery.json");
  const registryPath = path.join(state, "task-registry.json");
  const missingCodeRoot = path.join(fixture.root, "missing-native-entry");
  const unwantedSecondTry = path.join(fixture.root, "unwanted-second-try");
  const blockedSamples = [];
  let cycles = 0;
  let observedAt = Date.now();
  const result = await runSupervisorService({
    ...paths, rootDir: paths.dataRoot, runtimeStatePath, stopFilePath,
    registryPath, logPath: path.join(state, "supervisor.jsonl"), lockPath: path.join(state, "supervisor.lock"),
    brokerHealthUrl: "http://127.0.0.1:1/unused", codeRoot: missingCodeRoot,
    useWindowsOfflineGuard: true, scanIntervalMs: 15_000, loginTimeoutMs: 35_000, installSignalHandlers: false,
    now: () => new Date(observedAt),
    checkBrokerHealth: async () => ({ known: true, healthy: true, reachable: true }),
    checkNapCatRuntime: async () => ({ known: true, ready: true }),
    listProcesses: async () => [],
    getOpenTaskCount: async () => 0,
    checkRouterStatus: async () => ({ known: true, alive: false, state: "stopped" }),
    fsImpl: { ...fs, renameSync(temporary, target) {
      if (target === runtimeStatePath) {
        blockedSamples.push(JSON.parse(fs.readFileSync(temporary, "utf8")).login?.blocked);
      }
      fs.renameSync(temporary, target);
    } },
    wait: async () => {
      if (++cycles === 1) {
        const folder = path.join(missingCodeRoot, "ops");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, "invoke-napcat-offline-recovery.ps1"), "\ufeffparam([switch]$AwaitDurableCommit)\n"
          + "[IO.File]::WriteAllText(" + quoted(unwantedSecondTry) + ", 'fixture-only')\n");
        observedAt += 10 * 60_000;
      } else fs.writeFileSync(stopFilePath, "isolated acceptance complete");
    },
  });
  assert.equal(result.state, "stopped");
  assert.ok(blockedSamples.length > 0);
  assert.ok(!blockedSamples.includes(true), "a definitely unstarted native guard must not reserve login");
  assert.equal(result.actions.quickLogin.attempted, false);
  assert.equal(result.actions.quickLogin.reason, "offline_guard_startup_unavailable");
  assert.equal(cycles, 2);
  assert.equal(fs.existsSync(unwantedSecondTry), false);
  if (fs.existsSync(barrierPath)) {
    const barrier = JSON.parse(fs.readFileSync(barrierPath, "utf8"));
    assert.equal(barrier.needsManual, false);
    assert.equal(barrier.attemptAt, null);
  }
  assert.equal(fixture.loginCalls(), 0);
});

test("one readiness timeout permits a single delayed launch without opening the old hold", windows, async context => {
  const fixture = await makeFixture(context);
  const { paths } = fixture;
  const state = path.join(paths.dataRoot, "state");
  const runtimeStatePath = path.join(state, "supervisor-runtime.json");
  const stopFilePath = path.join(state, "supervisor.stop");
  const barrier = path.join(state, "napcat-offline-recovery.json");
  const invoked = path.join(fixture.root, "startup-count.txt");
  const dispatched = path.join(fixture.root, "dispatched.txt");
  const reservationSnapshot = path.join(fixture.root, "native-reservation-snapshot.json");
  const fixtureFailure = path.join(fixture.root, "native-startup-fixture-error.txt");
  const entry = path.join(fixture.root, "ops", "invoke-napcat-offline-recovery.ps1");
  fs.writeFileSync(entry, "\ufeff" + [
    "param([switch]$AwaitDurableCommit)",
    "$ErrorActionPreference='Stop'",
    "if (-not $AwaitDurableCommit) { exit 24 }",
    "$Marker=" + quoted(invoked),
    "if (-not [IO.File]::Exists($Marker)) { [IO.File]::WriteAllText($Marker,'first'); Start-Sleep -Seconds 25 }",
    "else { [IO.File]::AppendAllText($Marker,'+second'); Start-Sleep -Milliseconds 7000 }",
    "[Console]::Out.WriteLine('NAPCAT_OFFLINE_GUARD_READY_V1')",
    "[Console]::Out.Flush()",
    "$Request=[Console]::In.ReadToEnd()",
    "if (-not $Request) { exit 25 }",
    "try {",
    "  $Snapshot=@{runtime=[IO.File]::ReadAllText(" + quoted(runtimeStatePath) + ");barrier=[IO.File]::ReadAllText(" + quoted(barrier) + ")}",
    "  [IO.File]::WriteAllText(" + quoted(reservationSnapshot) + ",($Snapshot | ConvertTo-Json -Compress))",
    "  [IO.File]::WriteAllText(" + quoted(dispatched) + ",$Request)",
    "  @{status='deferred';changed=$false;reason='fixture_ready'} | ConvertTo-Json -Compress",
    "} catch { [IO.File]::WriteAllText(" + quoted(fixtureFailure) + ",$_.Exception.Message); exit 26 }",
  ].join("\n"));
  let observedAt = Date.now();
  const rounds = [];
  await runSupervisorService({
    ...paths, rootDir: paths.dataRoot, runtimeStatePath, stopFilePath,
    registryPath: path.join(state, "task-registry.json"), logPath: path.join(state, "supervisor.jsonl"),
    lockPath: path.join(state, "supervisor.lock"), brokerHealthUrl: "http://127.0.0.1:1/unused",
    codeRoot: fixture.root, useWindowsOfflineGuard: true, scanIntervalMs: 15000, loginTimeoutMs: 35000,
    loginCooldownMs: 2000, now: () => new Date(observedAt), installSignalHandlers: false,
    checkBrokerHealth: async () => ({ known: true, healthy: true, reachable: true }),
    checkNapCatRuntime: async () => ({ known: true, ready: true }),
    listProcesses: async () => [],
    getOpenTaskCount: async () => 0,
    checkRouterStatus: async () => ({ known: true, alive: false, state: "stopped" }),
    wait: async () => {
      const runtime = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
      const marker = fs.existsSync(dispatched);
      rounds.push({ reason: runtime.actions.quickLogin?.reason, blocked: runtime.login.blocked, marker,
        calls: fs.readFileSync(invoked, "utf8") });
      if (rounds.length === 1) observedAt += 3000;
      else if (rounds.length === 2) observedAt += 60000;
      else fs.writeFileSync(stopFilePath, "isolated acceptance complete");
    },
  });
  if (fs.existsSync(fixtureFailure)) assert.fail(fs.readFileSync(fixtureFailure, "utf8"));
  assert.deepEqual(rounds, [
    { reason: "offline_guard_startup_timeout", blocked: false, marker: false, calls: "first" },
    { reason: "offline_guard_startup_timeout", blocked: false, marker: false, calls: "first" },
    { reason: "fixture_ready", blocked: false, marker: true, calls: "first+second" },
  ]);
  assert.equal(JSON.parse(fs.readFileSync(dispatched, "utf8")).action, "quick-login");
  const reservation = JSON.parse(fs.readFileSync(reservationSnapshot, "utf8"));
  assert.equal(JSON.parse(reservation.runtime).login.blocked, true);
  assert.equal(JSON.parse(reservation.barrier).needsManual, true);
  assert.equal(fixture.loginCalls(), 0);
});

async function mutexOrFileHolder(fixture, initialization, teardown = "") {
  const run = ps(fixture, initialization + "\n[Console]::WriteLine('held')\ntry { $null = [Console]::ReadLine() } finally { " + teardown + " }");
  await Promise.race([
    once(run.child.stdout, "data").then(([chunk]) => assert.equal(String(chunk).trim(), "held")),
    run.completed.then(() => assert.fail("fixture holder exited before acquiring")),
  ]);
  return async () => {
    run.child.stdin.end();
    assert.equal((await run.completed)[0], 0);
  };
}

async function makeFixture(context) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "napcat-offline-guard-"));
  const fixture = { root, children: [], calls: [], reply: () => online(false),
    inventory: { ids: [], unknown: false, simulatedListenerProcess: process.pid, listenerPid: null } };
  const file = name => path.join(root, name);
  const paths = fixture.paths = {
    dataRoot: file("data"), accountStateDir: file("account/state"), qqUserDataDir: file("profile"),
    napcatRoot: file("napcat"), qqExePath: file("QQ.exe"), brokerRoot: file("broker"),
    bindingPath: file("data/binding.json"), privateEnvPath: file("broker/broker-private.env.json"),
    loginScriptPath: file("ops/start-napcat-login.ps1"), maintenancePath: file("data/state/task-router.maintenance.json"),
  };
  const server = http.createServer(async (request, response) => {
    const data = [];
    for await (const chunk of request) data.push(chunk);
    fixture.calls.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      body: Buffer.concat(data).toString("utf8") });
    const next = fixture.reply(fixture.calls.length);
    if (next === null) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(next));
  });
  context.after(async () => {
    for (const { child } of fixture.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.allSettled(fixture.children.map(({ completed }) => completed));
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    }
    assert.equal(path.dirname(fs.realpathSync(root)), parent);
    assert.match(path.basename(root), /^napcat-offline-guard-[A-Za-z0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const folder of ["ops", "data/state", "account/state", "profile", "napcat", "broker"]) {
    fs.mkdirSync(file(folder), { recursive: true });
  }
  for (const name of ["napcat-offline-recovery-guard.ps1", "invoke-napcat-offline-recovery.ps1", "napcat-process-identity.ps1"]) {
    fs.copyFileSync(path.join(ops, name), file("ops/" + name));
  }
  fs.appendFileSync(file("ops/napcat-process-identity.ps1"), String.raw`
function Get-NapCatOwnershipSnapshot {
  $Fixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../inventory.json') -Raw | ConvertFrom-Json
  foreach ($ProcessId in $Fixture.ids) {
    if (($ProcessId -isnot [int] -and $ProcessId -isnot [long]) -or $ProcessId -lt 2) { throw 'fixture pid invalid' }
    $Record = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop |
      Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,ExecutablePath
    if ($null -ne $Record) {
      if ($Record.CreationDate -is [DateTime]) { $Record.CreationDate = $Record.CreationDate.ToUniversalTime().ToString('o') }
      if ($Record.Name -ieq 'QQ.exe' -and $Record.ExecutablePath -ieq (Join-Path (Split-Path $PSScriptRoot) 'QQ.exe')) {
        $Record | Add-Member -NotePropertyName ModuleScanState -NotePropertyValue 'ok'
        $Record | Add-Member -NotePropertyName ModulePaths -NotePropertyValue @(Join-Path (Split-Path $PSScriptRoot) 'napcat/napcatwinboothook.dll')
      }
      $Record
    }
  }
  if ($Fixture.unknown) {
    [pscustomobject]@{ ProcessId = 2147475000; ParentProcessId = 0; Name = 'QQ.exe'; CommandLine = ''; CreationDate = ''; ExecutablePath = '' }
  }
}
function Get-NapCatOfflineListenerOwners {
  param([int]$Port)
  $Owners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } |
    Select-Object -ExpandProperty OwningProcess -Unique)
  $Fixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../inventory.json') -Raw | ConvertFrom-Json
  if ($Owners.Count -eq 1 -and $Owners[0] -eq $Fixture.simulatedListenerProcess -and @($Fixture.ids).Count -gt 0) {
    if ($null -ne $Fixture.listenerPid) { return [int]$Fixture.listenerPid }
    return [int]$Fixture.ids[0]
  }
  return $Owners
}
`);
  const old = fs.readFileSync(path.join(ops, "start-napcat-login.ps1"), "utf8");
  const oldProfile = old.slice(old.indexOf("function Initialize-QqPathIdentityApi"), old.indexOf("function Get-VerifiedOnlineLogin"));
  const oldLock = old.slice(old.indexOf("function New-NapCatLoginAttemptLock"), old.indexOf("function ConvertTo-NapCatCommandLineText"));
  assert.match(oldProfile, /Get-QqLoginLockName/);
  assert.match(oldLock, /WaitOne\(0\)/);
  fs.writeFileSync(paths.loginScriptPath, "\ufeff" +
    "param($DataRoot,$BrokerRoot,$NapCatRoot,$QqExePath,$QqUserDataDir,$TimeoutSeconds,[switch]$NoQr,[switch]$NoPasswordFallback)\n"
    + oldProfile + oldLock + String.raw`
$ExpectedProcessPolicy = if ($PSVersionTable.PSEdition -ceq 'Core') { 'Undefined' } else { 'Bypass' }
if ($PSVersionTable.PSVersion.ToString() -notmatch '^(5\.1|7)\.' -or [string](Get-ExecutionPolicy -Scope Process) -ne $ExpectedProcessPolicy -or -not $NoQr -or -not $NoPasswordFallback -or $TimeoutSeconds -lt 30) {
  throw 'unexpected fixture invocation'
}
$AccountState = Join-Path $PSScriptRoot '../account/state'
foreach ($Path in @(
  (Join-Path $AccountState 'manual-recovery.lock'), (Join-Path $AccountState 'startup-recovery.lock'),
  (Join-Path $AccountState 'account-switch.lock'), (Join-Path $DataRoot 'state/napcat-bridge-update.lock')
)) {
  $Opened = $null
  try { $Opened = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None') }
  catch [IO.IOException] { if (($_.Exception.HResult -band 65535) -ne 32) { throw } }
  if ($null -ne $Opened) { $Opened.Dispose(); throw 'guard lock released early' }
}
$Lock = New-NapCatLoginAttemptLock -DataRoot $DataRoot -NapCatRoot $NapCatRoot -ExpectedSelfId '${fakeAccount}' -QqProfileRoot $QqUserDataDir -NoQr
try {
  [IO.File]::AppendAllText((Join-Path $PSScriptRoot '../login.log'), 'legacy-called' + [Environment]::NewLine)
  Write-Warning '${token}'
  $Mode = Join-Path $PSScriptRoot '../legacy-mode.txt'
  if ([IO.File]::Exists($Mode)) {
    switch ([IO.File]::ReadAllText($Mode)) {
      'manual' { throw '[NAPCAT_MANUAL_LOGIN_REQUIRED] ${token}' }
      'unknown' { throw '${token}' }
      'existing' { '{"state":"online_existing","launched":false,"userId":"${fakeAccount}","logPath":"${token}"}'; return }
      'already' { '{"state":"already_online","launched":false,"userId":"${fakeAccount}","logPath":"${token}"}'; return }
      'wrong-account' { '{"state":"online","launched":true,"processId":1234,"userId":"777777","logPath":"${token}"}'; return }
    }
  }
  '{"state":"online","launched":true,"processId":1234,"userId":"${fakeAccount}","logPath":"${token}"}'
} finally { Release-NapCatLoginAttemptLock -Lock $Lock }
`);
  fixture.loginCalls = () => fs.existsSync(file("login.log")) ? fs.readFileSync(file("login.log"), "utf8").trim().split(/\r?\n/).length : 0;
  fixture.setInventory = () => putJson(file("inventory.json"), fixture.inventory);
  fixture.setInventory();
  putJson(paths.bindingPath, { expectedSelfId: fakeAccount });
  fixture.writeDeployment = (patch = {}) => putJson(file("account/state/deployment.json"), {
    state: "active", account: fakeAccount, qqProfileLayout: "shared_root",
    dataRoot: paths.dataRoot, napCatRoot: paths.napcatRoot, brokerRoot: paths.brokerRoot,
    qqExePath: paths.qqExePath, qqUserDataDir: paths.qqUserDataDir, ...patch,
  });
  fixture.writeDeployment();
  const bind = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await bind;
  putJson(paths.privateEnvPath, { NAPCAT_HTTP_URL: "http://127.0.0.1:" + server.address().port, NAPCAT_ACCESS_TOKEN: token });
  fixture.disconnectLoopback = async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  };
  fixture.invoke = async (patch = {}) => {
    const request = { schema: "napcat.offline-recovery-request/v1", action: "quick-login", paths,
      root: null, processes: [], deadlineAt: Date.now() + 75000, timeoutSeconds: 30, ...patch };
    const run = psFile(fixture, file("ops/invoke-napcat-offline-recovery.ps1"));
    const result = await receive(run, JSON.stringify(request));
    assert.ok(!result.includes(token) && !result.includes(fakeAccount), "receipt contains a private fixture value");
    assert.match(result, /^\{[^\r\n]+\}$/);
    return JSON.parse(result);
  };
  fixture.makeProof = (startupKind = "ps7-plan") => {
    const deployment = file("account/state/deployment.json");
    const startup = file(startupKind === "ps7-plan" ? "account/state/startup-ps7.json" : "account/ops/start-local-napcat.ps1");
    const proofFile = file("account/state/native-quick-login-verified.json");
    fixture.writeDeployment();
    if (startupKind === "ps7-plan") putJson(startup, { fixtureOnly: true });
    else {
      fs.mkdirSync(path.dirname(startup), { recursive: true });
      fs.writeFileSync(startup, "throw 'fixture legacy launcher is not executed'\n");
      paths.legacyStartupSha256 = digest(fs.readFileSync(startup));
    }
    const sha256 = { deployment: digest(fs.readFileSync(deployment)), startup: digest(fs.readFileSync(startup)),
      binding: digest(fs.readFileSync(paths.bindingPath)), login: digest(fs.readFileSync(paths.loginScriptPath)),
      profile: digest(fs.realpathSync(paths.qqUserDataDir).toUpperCase()) };
    putJson(proofFile, { schema: "napcat.native-quick-login-verified/v1", mode: "no-qr-no-password-fallback",
      result: "verified-online-from-own-launch", provedAt: Date.now(), qqProfileLayout: "shared_root", startupKind, sha256 });
    return { fileSha256: digest(fs.readFileSync(proofFile)), sha256 };
  };
  return fixture;
}

async function startOwned(fixture, filename = "napcat.mjs", executable = process.execPath, extra = []) {
  const entry = path.join(fixture.paths.napcatRoot, filename);
  fs.writeFileSync(entry, "setInterval(() => {}, 10000);");
  const run = start(fixture, executable, [entry, ...extra]);
  await once(run.child, "spawn");
  const pid = run.child.pid;
  const record = JSON.parse(await receive(ps(fixture, String.raw`
$Record = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,ExecutablePath
$Record.CreationDate = $Record.CreationDate.ToUniversalTime().ToString('o')
$Record | ConvertTo-Json -Compress
`)));
  assert.equal(record.ProcessId, pid);
  assert.ok(record.CommandLine.includes(entry));
  fixture.inventory.ids.push(pid);
  fixture.setInventory();
  const identityKey = digest(JSON.stringify([pid, record.ParentProcessId || null, record.Name.toLowerCase(),
    record.CommandLine, record.CreationDate, record.ExecutablePath.toLowerCase()]));
  return { ...run, record, root: { pid, creationDate: record.CreationDate }, summary: { pid, identityKey } };
}

for (const startupKind of ["ps7-plan", "registered-legacy-launcher"]) test(
  "Windows shadow connects the supervisor snapshot, raw OneBot, durable debit and native guarded login: " + startupKind,
  windows, async context => {
  const fixture = await makeFixture(context);
  const { paths } = fixture;
  const state = path.join(paths.dataRoot, "state");
  const startupProof = fixture.makeProof(startupKind);
  const loopbackPort = path.join(fixture.root, "owned-loopback-port.txt");
  const loopbackLog = path.join(fixture.root, "owned-loopback-requests.txt");
  const baseline = ["control-state.json", "dedupe-store.json", "task-registry.json"].map(name => path.join(state, name));
  for (const protectedFile of baseline) putJson(protectedFile, { originalFixture: true });
  const oldLogin = paths.loginScriptPath;
  const privateFiles = [paths.bindingPath, paths.privateEnvPath, oldLogin, ...baseline,
    path.join(paths.accountStateDir, "deployment.json"),
    path.resolve(paths.accountStateDir, startupKind === "ps7-plan" ? "startup-ps7.json" : "../ops/start-local-napcat.ps1")];
  await fixture.disconnectLoopback();
  const fakeQq = String.raw`
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
public static class NapCatOwnedTestFixture {
  public static void Main(string[] args) {
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    File.WriteAllText(args[1], ((IPEndPoint)listener.LocalEndpoint).Port.ToString());
    while (true) {
      using (var client = listener.AcceptTcpClient())
      using (var stream = client.GetStream())
      using (var reader = new StreamReader(stream)) {
        var request = reader.ReadLine();
        if (String.IsNullOrEmpty(request)) continue;
        string line;
        bool authenticated = false;
        while (!String.IsNullOrEmpty(line = reader.ReadLine())) {
          if (line.Equals("Authorization: Bearer fixture-not-a-real-secret", StringComparison.OrdinalIgnoreCase)) authenticated = true;
        }
        if (!authenticated) continue;
        File.AppendAllText(args[2], request + Environment.NewLine);
        var result = request.StartsWith("POST /get_status ", StringComparison.Ordinal) ?
          "{\"status\":\"ok\",\"retcode\":0,\"data\":{\"online\":false,\"good\":true}}" :
          "{\"status\":\"failed\",\"retcode\":1}";
        var response = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + result.Length + "\r\nConnection: close\r\n\r\n" + result);
        stream.Write(response, 0, response.Length);
      }
    }
  }
}
`;
  const cscExe = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe");
  if (fs.existsSync(cscExe)) {
    const fakeQqSource = path.join(fixture.root, "fakeQq.cs");
    fs.writeFileSync(fakeQqSource, fakeQq, "utf8");
    await receive(start(fixture, cscExe, ["/nologo", "/target:exe", "/out:" + paths.qqExePath, fakeQqSource]));
  } else {
    const fallbackScript = path.join(fixture.root, "compile-fake-qq.ps1");
    fs.writeFileSync(fallbackScript, "\ufeff$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n"
      + "Add-Type -OutputType ConsoleApplication -OutputAssembly " + quoted(paths.qqExePath)
      + " -TypeDefinition " + quoted(fakeQq));
    await receive(start(fixture, defaultWinPs, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fallbackScript], {
      env: powerShellEnv(false),
    }));
  }
  fixture.inventory.simulatedListenerProcess = null;
  const owned = await startOwned(fixture, "napcat.mjs", paths.qqExePath, [loopbackPort, loopbackLog]);
  const bindDeadline = Date.now() + 3000;
  while (!fs.existsSync(loopbackPort) && Date.now() < bindDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  const boundPort = Number(fs.readFileSync(loopbackPort, "utf8"));
  assert.ok(Number.isSafeInteger(boundPort) && boundPort > 1024);
  putJson(paths.privateEnvPath, { NAPCAT_HTTP_URL: "http://127.0.0.1:" + boundPort, NAPCAT_ACCESS_TOKEN: token });
  const oldBytes = new Map(privateFiles.map(file => [file, fs.readFileSync(file)]));
  assert.equal(owned.record.Name.toLowerCase(), "qq.exe");
  const processRecord = { ...owned.record, ModuleScanState: "ok",
    ModulePaths: [path.join(paths.napcatRoot, "napcatwinboothook.dll")] };
  const stopFilePath = path.join(state, "supervisor.stop");
  const runtimeStatePath = path.join(state, "supervisor-runtime.json");
  const barrier = path.join(state, "napcat-offline-recovery.json");
  let simulatedTime = Date.now();
  let scans = 0;
  let dispatched = 0;
  const supervised = await runSupervisorService({
    ...paths, rootDir: paths.dataRoot, runtimeStatePath, stopFilePath,
    registryPath: baseline[2], logPath: path.join(state, "supervisor.jsonl"), lockPath: path.join(state, "supervisor.lock"),
    brokerHealthUrl: "http://127.0.0.1:1/unused",
    codeRoot: fixture.root, scanIntervalMs: 15_000, loginTimeoutMs: 35_000,
    now: () => new Date(simulatedTime), installSignalHandlers: false,
    checkBrokerHealth: async () => ({ known: true, healthy: true, reachable: true }),
    checkNapCatRuntime: async () => ({ known: true, ready: true }),
    listProcesses: async () => [processRecord],
    getOpenTaskCount: async () => 0, checkRouterStatus: async () => ({ known: true, alive: false, state: "stopped" }),
    wait: async () => {
      scans += 1;
      simulatedTime += 31 * 60_000;
      if (scans >= 2) fs.writeFileSync(stopFilePath, "isolated acceptance complete");
    },
    offlineRecoveryGuard: async (request, timeoutMs) => {
      dispatched += 1;
      assert.equal(request.action, "recover-reachable-offline");
      assert.deepEqual(request.root, owned.root);
      assert.deepEqual(request.processes, [owned.summary]);
      assert.equal(request.quickLoginProof.fileSha256, startupProof.fileSha256);
      assert.equal(JSON.parse(fs.readFileSync(barrier, "utf8")).attemptAt, simulatedTime);
      assert.equal(JSON.parse(fs.readFileSync(runtimeStatePath, "utf8")).login.blocked, true);
      return invokeOfflineRecoveryGuard(request, { timeoutMs, scriptPath: path.join(fixture.root, "ops", "invoke-napcat-offline-recovery.ps1") });
    },
  });
  assert.equal(supervised.state, "stopped");
  assert.equal(dispatched, 1);
  assert.equal(fixture.loginCalls(), 1);
  await owned.completed;
  const actual = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
  assert.equal(actual.actions.staleNapCatRecovery.succeeded, true);
  assert.equal(actual.actions.staleNapCatRecovery.nativeQuickLoginEvidenceUpdated, true);
  const recordedRequests = fs.readFileSync(loopbackLog, "utf8").trim().split(/\r?\n/u);
  assert.ok(recordedRequests.every(request => /^POST \/(?:get_status|get_login_info) HTTP\/1\.[01]$/u.test(request)));
  assert.ok(recordedRequests.filter(request => /^POST \/get_status /u.test(request)).length >= 4);
  for (const [file, bytes] of oldBytes) assert.deepEqual(fs.readFileSync(file), bytes);
  },
);

test("maintenance accepts empty or omitted reasons but inhibits active or malformed records before OneBot", windows, async context => {
  const fixture = await makeFixture(context);
  fixture.reply = () => online(true);
  for (const [label, maintenance, permitted] of [
    ["empty array", { schemaVersion: 1, reasons: [] }, true],
    ["empty map", { schemaVersion: 1, reasons: {} }, true],
    ["omitted reasons", { schemaVersion: 1 }, true],
    ["inactive optional fields", { schemaVersion: 1, status: "", state: "inactive", mode: "inactive",
      active: false, maintenance: false, paused: false }, true],
    ["active optional flag", { schemaVersion: 1, reasons: [], active: true }, false],
    ["unknown optional flag", { schemaVersion: 1, maintenance: "false" }, false],
    ["null optional flag", { schemaVersion: 1, paused: null }, false],
    ["unknown status", { schemaVersion: 1, status: "unknown" }, false],
    ["nonstring state", { schemaVersion: 1, state: [] }, false],
    ["occupied array", { schemaVersion: 1, reasons: ["maintenance"] }, false],
    ["falsey array entry", { schemaVersion: 1, reasons: [false] }, false],
    ["occupied map", { schemaVersion: 1, reasons: { maintenance: false } }, false],
    ["null reasons", { schemaVersion: 1, reasons: null }, false],
    ["noncollection reasons", { schemaVersion: 1, reasons: false }, false],
    ["wrong schema", { schemaVersion: true, reasons: {} }, false],
    ["wrong root shape", [{ schemaVersion: 1, reasons: {} }], false],
  ]) {
    const before = fixture.calls.length;
    putJson(fixture.paths.maintenancePath, maintenance);
    assert.deepEqual(await fixture.invoke(), noAction(permitted ? "onebot_online" : "maintenance_active"), label);
    assert.equal(fixture.calls.length - before, permitted ? 1 : 0, label);
  }
  assert.equal(fixture.loginCalls(), 0);
});

test("cleanup attempts every resource after disposal failures and keeps the handoff and same-thread checks strict", windows, async context => {
  const fixture = await makeFixture(context);
  const filename = path.join(fixture.root, "cleanup-fixture.lock");
  const result = await receive(ps(fixture, ". " + quoted(path.join(fixture.root, "ops/napcat-offline-recovery-guard.ps1")) +
    "\n$Path = " + quoted(filename) + String.raw`
$Events = [Collections.Generic.List[string]]::new()
function New-TrackedResource {
  param([string]$Name, [bool]$Fails, $NativeResource)
  $Resource = [pscustomobject]@{ name = $Name; events = $Events; fails = $Fails; native = $NativeResource }
  $Resource | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $this.events.Add($this.name)
    if ($this.fails) { throw 'fixture_dispose_failed' }
    if ($null -ne $this.native) { $this.native.Dispose() }
  }
  return $Resource
}
$File = [IO.File]::Open($Path, 'CreateNew', 'ReadWrite', 'None')
$Mutex = New-TrackedResource 'mutex' $true
$Mutex | Add-Member -MemberType ScriptMethod -Name ReleaseMutex -Value { $this.events.Add('release_mutex') }
$Thread = [Threading.Thread]::CurrentThread.ManagedThreadId
$Guard = [pscustomobject]@{
  acquired = $true; threadId = $Thread + 1; ownsMutex = $true; mutex = $Mutex
  identityFiles = [Collections.Generic.List[object]]::new()
  files = [Collections.Generic.List[object]]::new()
  loginAttemptFile = New-TrackedResource 'login_attempt' $true
}
$Guard.identityFiles.Add((New-TrackedResource 'identity_failed' $true))
$Guard.identityFiles.Add((New-TrackedResource 'identity_next' $false))
$Guard.files.Add((New-TrackedResource 'file_next' $false $File))
$Guard.files.Add((New-TrackedResource 'file_failed' $true))
$WrongThread = $false
try { Exit-NapCatOfflineRecoveryGuard -Guard $Guard }
catch { $WrongThread = $_.Exception.Message -ceq 'guard_wrong_thread' -and $Events.Count -eq 0 }
$Guard.threadId = $Thread
$HandoffFailed = $false
try { Release-NapCatOfflineLoginAttemptFile -Guard $Guard }
catch { $HandoffFailed = $null -ne $Guard.loginAttemptFile }
$CleanupFailed = $false
try { Exit-NapCatOfflineRecoveryGuard -Guard $Guard }
catch { $CleanupFailed = $_.Exception.Message -ceq 'guard_cleanup_failed' }
$ProcessCleanupFailed = $false
try {
  Close-NapCatOfflineProcessHandles -Handles @(
    @{ process = New-TrackedResource 'process_failed' $true },
    @{ process = New-TrackedResource 'process_next' $false }
  )
} catch { $ProcessCleanupFailed = $_.Exception.Message -ceq 'guard_cleanup_failed' }
$FileReleased = $false
try {
  $Reopened = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
  $Reopened.Dispose()
  $FileReleased = $true
} catch [IO.IOException] {}
[Console]::WriteLine((@{
  wrongThread = $WrongThread; failedHandoff = $HandoffFailed; failedCleanup = $CleanupFailed
  failedProcessCleanup = $ProcessCleanupFailed; fileReleased = $FileReleased; events = $Events.ToArray()
  loginAttemptCleared = $null -eq $Guard.loginAttemptFile
  acquired = $Guard.acquired; ownsMutex = $Guard.ownsMutex; remainingFiles = $Guard.files.Count + $Guard.identityFiles.Count
} | ConvertTo-Json -Compress))
`));
  assert.deepEqual(JSON.parse(result), {
    wrongThread: true, failedHandoff: true, failedCleanup: true, failedProcessCleanup: true, fileReleased: true,
    events: ["login_attempt", "identity_failed", "identity_next", "login_attempt", "release_mutex", "mutex",
      "file_failed", "file_next", "process_failed", "process_next"],
    acquired: false, ownsMutex: false, remainingFiles: 0, loginAttemptCleared: true,
  });
});

test("real named mutex ownership, harmless presence, and five existing zero-byte exclusive files", windows, async context => {
  const fixture = await makeFixture(context);
  const profilePrefix = ". " + quoted(path.join(fixture.root, "ops/napcat-offline-recovery-guard.ps1")) +
    "\n$Name = Get-NapCatOfflineQqMutexName -QqUserDataDir " + quoted(fixture.paths.qqUserDataDir) +
    "\n$Mutex = [Threading.Mutex]::new($false, $Name)\n";
  const releaseMutex = await mutexOrFileHolder(fixture, profilePrefix + "if (-not $Mutex.WaitOne(0)) { throw 'not acquired' }",
    "$Mutex.ReleaseMutex(); $Mutex.Dispose()");
  assert.deepEqual(await fixture.invoke(), noAction("profile_lock_unavailable"));
  assert.equal(fixture.calls.length, 0);
  await releaseMutex();
  const releaseIdleMutex = await mutexOrFileHolder(fixture, profilePrefix, "$Mutex.Dispose()");
  for (const [dir, name, reason] of [
    [fixture.paths.accountStateDir, "manual-recovery.lock", "manual_lock_unavailable"],
    [fixture.paths.accountStateDir, "startup-recovery.lock", "startup_lock_unavailable"],
    [fixture.paths.accountStateDir, "account-switch.lock", "account_lock_unavailable"],
    [path.join(fixture.paths.dataRoot, "state"), "napcat-bridge-update.lock", "update_lock_unavailable"],
    [path.join(fixture.paths.dataRoot, "state"), "napcat-login-attempt-" + fakeAccount + ".lock", "login_attempt_lock_unavailable"],
  ]) {
    const filename = path.join(dir, name);
    const release = await mutexOrFileHolder(fixture,
      "$File = [IO.File]::Open(" + quoted(filename) + ", 'OpenOrCreate', 'ReadWrite', 'None')", "$File.Dispose()");
    assert.deepEqual(await fixture.invoke(), noAction(reason));
    assert.equal(fixture.calls.length, 0);
    await release();
    assert.equal(fs.statSync(filename).size, 0);
  }
  assert.deepEqual(await fixture.invoke(), { status: "started", changed: true, reason: "verified_online", nativeQuickLoginVerified: true });
  assert.equal(fixture.loginCalls(), 1);
  await releaseIdleMutex();
});

test("recovered OneBot, non-boolean status, timeout, drift and unknown ownership preserve the live process", windows, async context => {
  const fixture = await makeFixture(context);
  const owned = await startOwned(fixture);
  const request = { action: "stop-stale-offline", root: owned.root, processes: [owned.summary] };
  fixture.reply = index => online(index === 2);
  assert.deepEqual(await fixture.invoke(request), noAction("onebot_online"));
  assert.equal(fixture.calls.length, 2);
  fixture.reply = () => online("false");
  assert.deepEqual(await fixture.invoke(request), noAction("onebot_unverified"));
  fixture.reply = () => online(undefined);
  assert.deepEqual(await fixture.invoke(request), noAction("onebot_unverified"));
  fixture.reply = () => online(null);
  assert.deepEqual(await fixture.invoke(request), noAction("onebot_unverified"));
  fixture.reply = () => null;
  assert.deepEqual(await fixture.invoke(request), noAction("onebot_unverified"));
  fixture.reply = () => online(false);
  assert.deepEqual(await fixture.invoke({ ...request, root: { ...owned.root, creationDate: "2000-01-01T00:00:00Z" } }),
    noAction("process_identity_unverified"));
  const added = await startOwned(fixture, "index.js");
  assert.deepEqual(await fixture.invoke(request), noAction("process_identity_unverified"));
  fixture.inventory.ids.pop();
  fixture.inventory.unknown = true;
  fixture.setInventory();
  assert.deepEqual(await fixture.invoke(request), noAction("process_identity_unverified"));
  assert.equal(owned.child.exitCode, null);
  assert.equal(added.child.exitCode, null);
  assert.equal(fixture.loginCalls(), 0);
});

test("explicit offline target stops with the retained handle; unrelated process survives", windows, async context => {
  const fixture = await makeFixture(context);
  const owned = await startOwned(fixture);
  const unrelated = start(fixture, process.execPath, ["-e", "setInterval(() => {}, 10000)"]);
  await once(unrelated.child, "spawn");
  fixture.inventory.ids.push(unrelated.child.pid);
  fixture.setInventory();
  assert.deepEqual(await fixture.invoke({ action: "stop-stale-offline", root: owned.root, processes: [owned.summary] }),
    { status: "stopped", changed: true, reason: "owned_processes_stopped", nativeQuickLoginVerified: false });
  await owned.completed;
  assert.equal(unrelated.child.exitCode, null);
  assert.equal(fixture.loginCalls(), 0);
  assert.deepEqual(fixture.calls, Array.from({ length: 2 }, () => ({
    method: "POST", url: "/get_status", authorization: "Bearer " + token, body: "{}",
  })));
});

for (const drift of ["process_set", "listener_owner", "target_bytes"]) test(
  "last OneBot response with drift preserves every fixture process: " + drift, windows, async context => {
    const fixture = await makeFixture(context);
    const old = await startOwned(fixture);
    fs.mkdirSync(path.join(fixture.paths.napcatRoot, "napcat"));
    const later = await startOwned(fixture, "napcat/napcat.mjs");
    fixture.inventory.ids = [old.root.pid];
    fixture.setInventory();
    fixture.reply = sample => {
      if (sample === 2) {
        if (drift === "process_set") {
          fixture.inventory.ids.push(later.root.pid);
          fixture.setInventory();
        } else if (drift === "listener_owner") {
          fixture.inventory.listenerPid = process.pid;
          fixture.setInventory();
        } else {
          const previous = JSON.parse(fs.readFileSync(fixture.paths.privateEnvPath, "utf8"));
          putJson(fixture.paths.privateEnvPath, { ...previous, fixtureChange: true });
        }
      }
      return online(false);
    };
    const reasons = { process_set: "process_identity_unverified", listener_owner: "onebot_owner_unverified",
      target_bytes: "onebot_target_changed" };
    assert.deepEqual(await fixture.invoke({ action: "stop-stale-offline", root: old.root, processes: [old.summary] }),
      noAction(reasons[drift]));
    assert.equal(old.child.exitCode, null);
    assert.equal(later.child.exitCode, null);
    assert.equal(fixture.loginCalls(), 0);
  },
);

test("a proven stale launcher with two connection refusals stays eligible for legacy recovery", windows, async context => {
  const fixture = await makeFixture(context);
  const owned = await startOwned(fixture);
  await fixture.disconnectLoopback();
  assert.deepEqual(await fixture.invoke({ action: "stop-stale-offline", root: owned.root, processes: [owned.summary] }),
    { status: "stopped", changed: true, reason: "owned_processes_stopped", nativeQuickLoginVerified: false });
  await owned.completed;
  assert.equal(fixture.loginCalls(), 0);
  assert.equal(fixture.calls.length, 0);
});

test("registered active deployment binds all modes before account locks; profile casing resolves to the same mutex", windows, async context => {
  const fixture = await makeFixture(context);
  const owned = await startOwned(fixture);
  const accountLockNames = ["manual-recovery.lock", "startup-recovery.lock", "account-switch.lock"];
  const stopRequest = { action: "stop-stale-offline", root: owned.root, processes: [owned.summary] };
  for (const mismatch of [
    { state: "inactive" },
    { account: "777777" },
    { dataRoot: path.join(fixture.root, "other-data") },
    { napCatRoot: path.join(fixture.root, "other-napcat") },
    { qqUserDataDir: fixture.root },
  ]) {
    fixture.writeDeployment(mismatch);
    assert.deepEqual(await fixture.invoke(), noAction("deployment_unverified"));
    assert.deepEqual(await fixture.invoke(stopRequest), noAction("deployment_unverified"));
    for (const filename of accountLockNames) {
      assert.equal(fs.existsSync(path.join(fixture.paths.accountStateDir, filename)), false);
    }
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(owned.child.exitCode, null);
  fixture.writeDeployment();
  const uppercase = { ...fixture.paths, qqUserDataDir: fixture.paths.qqUserDataDir.toUpperCase() };
  assert.deepEqual(await fixture.invoke({ ...stopRequest, paths: uppercase }),
    { status: "stopped", changed: true, reason: "owned_processes_stopped", nativeQuickLoginVerified: false });
  await owned.completed;
});

test("same lease verifies native quick-login evidence after the scan, then stops and invokes the original locks", windows, async context => {
  const fixture = await makeFixture(context);
  const owned = await startOwned(fixture);
  const request = { action: "recover-reachable-offline", root: owned.root, processes: [owned.root] };
  assert.deepEqual(await fixture.invoke(request), noAction("quick_login_proof_missing"));
  assert.equal(fixture.calls.length, 0);
  assert.equal(fs.existsSync(path.join(fixture.paths.accountStateDir, "manual-recovery.lock")), false);
  const beforeMissing = fixture.makeProof();
  fs.unlinkSync(path.join(fixture.paths.accountStateDir, "startup-ps7.json"));
  assert.deepEqual(await fixture.invoke({ ...request, quickLoginProof: beforeMissing }), noAction("quick_login_proof_changed"));
  assert.equal(owned.child.exitCode, null);
  const proof = fixture.makeProof();
  const beforeDrift = fixture.calls.length;
  fixture.reply = index => {
    if (index === beforeDrift + 1) putJson(path.join(fixture.paths.accountStateDir, "startup-ps7.json"), { fixtureOnly: false });
    return online(false);
  };
  assert.deepEqual(await fixture.invoke({ ...request, quickLoginProof: proof }), noAction("quick_login_proof_changed"));
  assert.equal(owned.child.exitCode, null);
  assert.equal(fixture.loginCalls(), 0);
  const reserved = fixture.calls.length;
  let proofWriteBlocked = false;
  fixture.reply = index => {
    if (index === reserved + 2) {
      try {
        putJson(path.join(fixture.paths.accountStateDir, "startup-ps7.json"), { writeDuringFinalProbe: true });
      } catch (error) {
        proofWriteBlocked = ["EACCES", "EPERM", "EBUSY"].includes(error.code);
      }
    }
    return online(false);
  };
  assert.deepEqual(await fixture.invoke({ ...request, quickLoginProof: fixture.makeProof() }),
    { status: "recovered", changed: true, reason: "verified_online", nativeQuickLoginVerified: true });
  assert.equal(proofWriteBlocked, true);
  await owned.completed;
  assert.equal(fixture.loginCalls(), 1);
});

test("quiet quick-login preserves the no-listener startup path; only a verified own launch supplies evidence", windows, async context => {
  const fixture = await makeFixture(context);
  for (const [mode, status, reason] of [
    ["existing", "deferred", "legacy_already_online"],
    ["already", "deferred", "legacy_already_online"],
    ["manual", "needs-manual", "manual_login_required"],
    ["unknown", "unknown", "login_unverified"],
    ["wrong-account", "unknown", "login_unverified"],
  ]) {
    fs.writeFileSync(path.join(fixture.root, "legacy-mode.txt"), mode);
    assert.deepEqual(await fixture.invoke(), { status, reason, nativeQuickLoginVerified: false,
      ...(status === "deferred" ? { changed: false } : {}) });
  }
  fs.unlinkSync(path.join(fixture.root, "legacy-mode.txt"));
  await fixture.disconnectLoopback();
  assert.deepEqual(await fixture.invoke(), { status: "started", changed: true, reason: "verified_online", nativeQuickLoginVerified: true });
  assert.equal(fixture.loginCalls(), 6);
});
