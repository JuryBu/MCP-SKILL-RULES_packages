import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const windows = process.platform === "win32";
const ops = fileURLToPath(new URL("../ops/", import.meta.url));
const powershell = windows && (
  (process.env.NAPCAT_OFFLINE_GUARD_POWERSHELL_PATH || process.env.NAPCAT_POWERSHELL_PATH || "").trim() ||
  path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
);
const isPwsh = Boolean(powershell) && path.win32.basename(powershell).toLowerCase() === "pwsh.exe";
const manualName = "restart-napcat-qr-login.ps1";
const guardName = "napcat-offline-recovery-guard.ps1";
const identityName = "napcat-process-identity.ps1";
const legacyName = "start-napcat-login.ps1";
const noticeName = "show-napcat-offline-notice.ps1";
const expectedAccount = "123456789";
const ps = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const childEnv = { ...process.env };
for (const name of Object.keys(childEnv)) {
  const lower = name.toLowerCase();
  if (isPwsh && (lower === "psmodulepath" || lower === "psexecutionpolicypreference")) {
    delete childEnv[name];
  } else if (lower === "psexecutionpolicypreference" && String(childEnv[name]).toLowerCase() === "bypass") {
    delete childEnv[name];
  }
}
const childOptions = { windowsHide: true, timeout: 35000, env: childEnv };
const flag = (name, value) => ["-" + name, value];
const psFlags = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta"];
let ordinaryWinPs;

async function checkOrdinaryWinPs() {
  const expression = "@{ version=$PSVersionTable.PSVersion.ToString(); effective=(Get-ExecutionPolicy).ToString(); process=(Get-ExecutionPolicy -Scope Process).ToString() } | ConvertTo-Json -Compress";
  const { stdout } = await run(powershell, [...psFlags, "-Command", expression], childOptions);
  const policy = JSON.parse(stdout.trim());
  assert.match(policy.version, /^(5\.1|7)\./);
  assert.equal(policy.process, "Undefined", "A tool-supplied process override must be absent");
  assert.notEqual(policy.effective, "Bypass");
  if (isPwsh) {
    assert.notEqual(policy.effective, "Restricted", "Local scripts cannot run under Restricted execution policy");
    assert.notEqual(policy.effective, "AllSigned", "Unsigned local fixture scripts cannot run under AllSigned execution policy");
  }
  return policy;
}

async function runPs(script, args = []) {
  await (ordinaryWinPs ??= checkOrdinaryWinPs());
  const policyFlags = isPwsh ? [] : ["-ExecutionPolicy", "Bypass"];
  const { stdout } = await run(powershell, [...psFlags, ...policyFlags, "-File", script, ...args], childOptions);
  return JSON.parse(stdout.trim());
}

async function runPsStatus(script, args) {
  try { return await runPs(script, args); }
  catch (error) {
    assert.equal(error.code, 1, error.stderr);
    return JSON.parse(error.stdout.trim());
  }
}

async function json(file, value) {
  await writeFile(file, JSON.stringify(value), "utf8");
}

async function readJsonEventually(file, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if (!["ENOENT", "EPERM", "EACCES"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
      await delay(90);
    }
  }
  assert.fail("Missing fixture result: " + file);
}

async function makeFixture(context, scenario = "offline", machineRole = "development") {
  const root = await mkdtemp(path.join(tmpdir(), "napcat-manual-fixture-"));
  const fakeChildren = [];
  context.after(async () => {
    for (const child of fakeChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^napcat-manual-fixture-/);
    await rm(root, { recursive: true, force: true });
  });
  const fixtureOps = path.join(root, "ops");
  const configPath = path.join(root, "interaction.json");
  const readyPath = path.join(root, "fake-login-proof.json");
  const releasePath = path.join(root, "release.txt");
  const requestLog = path.join(root, "onebot-actions.txt");
  const dataRoot = path.join(root, "data");
  const accountStateDir = path.join(root, "account", "state");
  const brokerRoot = path.join(root, "broker");
  const napCatRoot = path.join(root, "runtime");
  const qqUserDataDir = path.join(root, "test-profile");
  for (const dir of [fixtureOps, accountStateDir, brokerRoot, napCatRoot, qqUserDataDir, path.join(dataRoot, "state")]) {
    await mkdir(dir, { recursive: true });
  }
  for (const name of [manualName, guardName, identityName, noticeName]) {
    await copyFile(path.join(ops, name), path.join(fixtureOps, name));
  }

  const old = await readFile(path.join(ops, legacyName), "utf8");
  const canonicalizer = old.slice(old.indexOf("function Initialize-QqPathIdentityApi"), old.indexOf("function Get-VerifiedOnlineLogin"));
  assert.match(canonicalizer, /function Get-QqLoginLockName/);
  const legacy = [
    "param($DataRoot,$BrokerRoot,$NapCatRoot,$QqExePath,$QqUserDataDir,[int]$TimeoutSeconds,[switch]$NoQr,[switch]$NoPasswordFallback)",
    canonicalizer,
    "$ErrorActionPreference='Stop'",
    "if ($NoQr -or -not $NoPasswordFallback) { throw 'fixture_wrong_mode' }",
    "$Mutex = [Threading.Mutex]::new($false,(Get-QqLoginLockName -UserDataDir $QqUserDataDir))",
    "if (-not $Mutex.WaitOne(0)) { throw 'fixture_mutex_not_reentrant' }",
    "try {",
    "  if (-not [NapCatQrNative]::OwnsMutex($Mutex)) { throw 'fixture_no_mutex' }",
    "  $ManualPath = " + ps(path.join(accountStateDir, "manual-recovery.lock")),
    "  $ManualLocked=$false",
    "  try { $Probe = [IO.File]::Open($ManualPath,'Open','Read','ReadWrite'); $Probe.Dispose() }",
    "  catch [IO.IOException] { $ManualLocked=($_.Exception.HResult -band 65535) -eq 32 }",
    "  if (-not $ManualLocked) { throw 'fixture_no_manual_lock' }",
    "  $OldLock = [IO.File]::Open((Join-Path $DataRoot 'state\\napcat-login-attempt-" + expectedAccount + ".lock'),'OpenOrCreate','ReadWrite','None')",
    "  try {",
    "    $Proof = @{ pid=$PID; threadId=[Threading.Thread]::CurrentThread.ManagedThreadId; noQr=[bool]$NoQr; manualLocked=$ManualLocked; qqExePath=[string]$QqExePath; profileCanonical=($QqUserDataDir -ceq (Get-NormalizedQqPath -Path $QqUserDataDir)); timeoutSeconds=$TimeoutSeconds }",
    ...(scenario === "caller-exits" ? [
      "    $LauncherPid=(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId",
      "    $ParentLimit=[DateTime]::UtcNow.AddSeconds(2)",
      "    do { $LauncherAlive=$null -ne (Get-Process -Id $LauncherPid -ErrorAction SilentlyContinue); if ($LauncherAlive) { Start-Sleep -Milliseconds 60 } } while ($LauncherAlive -and [DateTime]::UtcNow -lt $ParentLimit)",
      "    $Proof.callerExited=-not $LauncherAlive",
    ] : []),
    "    [IO.File]::WriteAllText(" + ps(readyPath) + ",($Proof | ConvertTo-Json -Compress))",
    "    $Limit = [DateTime]::UtcNow.AddSeconds(10)",
    "    while (-not [IO.File]::Exists(" + ps(releasePath) + ") -and [DateTime]::UtcNow -lt $Limit) { Start-Sleep -Milliseconds 100 }",
    "    @{ state='online'; userId='" + expectedAccount + "' } | ConvertTo-Json -Compress",
    ...(scenario === "legacy-nonzero" ? ["    exit 7"] : []),
    "  } finally { $OldLock.Dispose() }",
    "} finally { $Mutex.ReleaseMutex(); $Mutex.Dispose() }",
  ].join("\r\n");
  await writeFile(path.join(fixtureOps, legacyName), legacy, "utf8");
  const config = {
    schemaVersion: 1,
    machineRole,
    manualQrEnabled: true,
    offlineNoticeEnabled: true,
    expectedAccount,
    dataRoot,
    accountStateDir,
    brokerRoot,
    napCatRoot,
    qqUserDataDir,
    qqExePath: scenario === "empty-exe" ? null : path.join(root, "fake-qq.exe"),
    loginSha256: createHash("sha256").update(legacy).digest("hex"),
  };
  const fakeOneBot = path.join(scenario === "identity-unavailable-unowned" ? root : napCatRoot, "napcat.mjs");
  await writeFile(fakeOneBot, [
    'import { appendFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    "let count = 0;",
    "let accountReads = 0;",
    "const actions = " + JSON.stringify(requestLog) + ";",
    "const scenario = " + JSON.stringify(scenario) + ";",
    "const server = createServer((req, res) => {",
    '  req.resume();',
    '  req.once("end", () => {',
    '  appendFileSync(actions, req.url + "\\n");',
    '  if (req.method !== "POST" || req.headers.authorization !== "Bearer test-only-onebot-token") { res.writeHead(403); res.end(); return; }',
    '  if (scenario === "unknown") { res.writeHead(503); res.end(); return; }',
    '  if (scenario === "timeout") return;',
    '  if (["identity-unavailable","identity-unavailable-unowned","online-without-identity","notice-recovered-missing"].includes(scenario) && req.url === "/get_login_info") { res.writeHead(503); res.end(); return; }',
    '  let data;',
    '  if (req.url === "/get_status") { count++; data = { online: scenario === "string-status" ? "false" : ["online","online-without-identity"].includes(scenario) || (["recovered","notice-recovered-missing"].includes(scenario) && count > 1), good: true }; }',
    '  else if (req.url === "/get_login_info") { accountReads++; data = { user_id: scenario === "zero" ? 0 : ["wrong","failed-wrong"].includes(scenario) || (scenario === "late-wrong" && accountReads > 1) ? "999999999" : "' + expectedAccount + '" }; }',
    '  else { res.writeHead(404); res.end(); return; }',
    '  const body = JSON.stringify({status:"ok",retcode:0,data});',
    '  res.writeHead(scenario === "failed-wrong" && req.url === "/get_login_info" ? 503 : 200, {"content-type":"application/json", "content-length":Buffer.byteLength(body)});',
    '  res.end(body);',
    '  });',
    '});',
    'server.listen(0, scenario === "refused-other-listener" ? "127.0.0.2" : "127.0.0.1", () => {',
    '  const port = server.address().port;',
    '  if (scenario === "refused-empty" || scenario === "refused-owned") {',
    '    if (scenario === "refused-owned") setInterval(() => {}, 1000);',
    '    server.close(() => console.log(port));',
    '  } else console.log(port);',
    '});',
  ].join("\n"), "utf8");
  await json(path.join(dataRoot, "binding.json"), { expectedSelfId: expectedAccount, controlPlane: { localMachine: machineRole } });
  await json(path.join(accountStateDir, "deployment.json"), { ...config, state: "active", account: expectedAccount });
  async function startOneBot() {
    const oneBot = spawn(process.execPath, [fakeOneBot], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    fakeChildren.push(oneBot);
    const port = Number(String((await once(oneBot.stdout, "data"))[0]).trim());
    assert.ok(port > 0);
    if (scenario === "refused-empty" && oneBot.exitCode === null) await once(oneBot, "exit");
    await json(path.join(brokerRoot, "broker-private.env.json"), {
      NAPCAT_HTTP_URL: "http://127.0.0.1:" + port, NAPCAT_ACCESS_TOKEN: "test-only-onebot-token",
    });
    return { oneBot, port };
  }
  await json(configPath, config);
  return { root, fixtureOps, configPath, releasePath, readyPath, requestLog, scenario, startOneBot, ...await startOneBot() };
}

function pathsPrelude(fixture) {
  const { fixtureOps, configPath, oneBot } = fixture;
  return [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "$Entry=" + ps(path.join(fixtureOps, manualName)),
    "$GuardPath=" + ps(path.join(fixtureOps, guardName)),
    "$IdentityPath=" + ps(path.join(fixtureOps, identityName)),
    "$LegacyPath=" + ps(path.join(fixtureOps, legacyName)),
    ". $Entry",
    "$script:OrigGetNapCatQrWorkerIdentity = (Get-Command Get-NapCatQrWorkerIdentity -CommandType Function).ScriptBlock",
    "function Get-NapCatQrWorkerIdentity { param([int]$ProcessId) $w = & $script:OrigGetNapCatQrWorkerIdentity $ProcessId; if ($w.sessionId -eq 0) { $w.sessionId = 1 }; return $w }",
    "$ConfigPath=" + ps(configPath),
    "Initialize-NapCatQrPowerShell",
    "function Get-NapCatQrOwnedSnapshot {",
    "  param($Guard)",
    fixture.scenario === "refused-other-listener" ? "  $Records=@()" :
      "  $Records = @(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" + oneBot.pid + "' -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,ExecutablePath)",
    "  foreach ($Record in $Records) { $Record.CreationDate = $Record.CreationDate.ToUniversalTime().ToString('o') }",
    "  Get-NapCatProcessClassification -Processes $Records -NapCatRoot $Guard.paths.napCatRoot",
    "}",
  ].join("\r\n");
}

async function runWorkerCase(fixture, options = {}) {
  const { root, configPath, readyPath, releasePath } = fixture;
  const workerPath = path.join(root, "fixture-worker.ps1");
  const diagnosticPath = path.join(root, "fixture-worker-errors.json");
  await rm(diagnosticPath, { force: true });
  const worker = [
    "param($Mode,$RequestId,$RequestSha256)",
    "$Id=$RequestId; $Hash=$RequestSha256",
    pathsPrelude(fixture),
    "$Process = [Diagnostics.Process]::GetCurrentProcess()",
    "$CurrentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$Worker = Get-NapCatQrWorkerIdentity $PID",
    "$Desktop = @{ sid=$CurrentOwner; sessionId=[Math]::Max(1,$Process.SessionId); explorerId=$Worker.parentPid }",
    "function Get-NapCatQrDesktopIdentity { $Desktop }",
    "$RequestDirectory=Get-NapCatQrRequestDirectory $Id " + ps(root),
    "$Request = Get-NapCatQrRequest $RequestDirectory $Id $Hash $Desktop",
    "try { $null = Invoke-NapCatQrWorker $RequestDirectory $Request $Desktop $Entry $GuardPath $IdentityPath $LegacyPath {",
    "  if ($PID -ne $Worker.pid -or [Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { throw 'fixture_worker_moved' }",
    "} }",
    "finally { $Events=@($Error | Select-Object -First 6 | ForEach-Object { @{ message=$_.Exception.Message; errorId=$_.FullyQualifiedErrorId; position=$_.InvocationInfo.PositionMessage } }); [IO.File]::WriteAllText(" + ps(diagnosticPath) + ",(ConvertTo-Json -InputObject $Events -Compress)) }",
  ];
  await writeFile(workerPath, worker.join("\r\n"), "utf8");

  const callerPath = path.join(root, "fixture-caller.ps1");
  const caller = [
    pathsPrelude(fixture),
    ". $IdentityPath",
    ". $GuardPath",
    "$Process = [Diagnostics.Process]::GetCurrentProcess()",
    "$Owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$Desktop = @{ sid=$Owner; sessionId=[Math]::Max(1,$Process.SessionId); explorerId=$PID; birth=$Process.StartTime.ToFileTimeUtc() }",
    "$Config = ConvertFrom-NapCatQrFile (Read-NapCatQrFile $ConfigPath)",
    "$Config | Add-Member -NotePropertyName computerName -NotePropertyValue ([Environment]::MachineName) -Force",
    "$Config | Add-Member -NotePropertyName userSid -NotePropertyValue $Owner -Force",
    "[IO.File]::WriteAllText($ConfigPath,($Config | ConvertTo-Json -Compress))",
    "$ConfigFingerprint=(Read-NapCatQrFile $ConfigPath).sha",
    "$Nonce=[Guid]::NewGuid().ToString('N')",
    "$Directory=Get-NapCatQrRequestDirectory $Nonce " + ps(root),
    "$Now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()" + (options.expired ? " - 46000" : ""),
    "$Data=@{ schema='napcat.manual-qr/v1'; id=$Nonce; sid=$Owner; sessionId=$Desktop.sessionId; explorerId=$PID; requesterPid=$PID; requesterBirth=$Desktop.birth; createdAt=$Now; deadlineAt=$Now+45000; configPath=$ConfigPath; configSha=$ConfigFingerprint; bindingSha=(Read-NapCatQrFile (Join-Path $Config.dataRoot 'binding.json') 65536).sha; deploymentSha=(Read-NapCatQrFile (Join-Path $Config.accountStateDir 'deployment.json')).sha; entrySha=(Read-NapCatQrFile $Entry 524288).sha; guardSha=(Read-NapCatQrFile $GuardPath 524288).sha; identitySha=(Read-NapCatQrFile $IdentityPath 524288).sha; loginSha=(Read-NapCatQrFile $LegacyPath 524288).sha }",
    ...(options.supersedes ? ["$Data.supersedesRequestId=[Guid]::NewGuid().ToString('N')"] : []),
    "$script:FixtureRequest=$null; $script:Started=$null; $script:Launches=0; $script:BeforeWorker=$null",
    "$Create = {",
    "  param($SupersededOffline,$UncertainRequestId)",
    "  if ($UncertainRequestId) { $Data.supersedesRequestId=$UncertainRequestId }",
    "  if ($null -ne $SupersededOffline) { $Data.supersededOffline=$SupersededOffline }",
    "  New-NapCatQrRequestDirectory $Directory $Owner",
    "  Write-NapCatQrRecord $Directory 'request' $Data",
    "  $script:FixtureRequest=Get-NapCatQrRequest $Directory $Nonce '' $Desktop",
    "  @{ directory=$Directory; request=$script:FixtureRequest }",
    "}",
    "$Manual = $null; $Mutex = $null",
    "try {",
    ...(options.manualBusy ? [
      "  $Manual=[IO.File]::Open((Join-Path $Config.accountStateDir 'manual-recovery.lock'),'OpenOrCreate','ReadWrite','None')",
    ] : []),
    ...(options.profileBusy ? [
      "  $Mutex=[Threading.Mutex]::new($false,(Get-NapCatOfflineQqMutexName -QqUserDataDir $Config.qqUserDataDir))",
      "  if (-not $Mutex.WaitOne(0)) { throw 'fixture_profile_lock_busy' }",
    ] : []),
    "  $Launch = {",
    "    $script:Launches++",
    ...(options.rescan ? [
      "    $Listener=[Diagnostics.Process]::GetProcessById(" + fixture.oneBot.pid + ")",
      "    try { $script:BeforeWorker=@{ alive=(-not $Listener.HasExited); contacted=[IO.File]::Exists(" + ps(fixture.requestLog) + "); legacy=[IO.File]::Exists(" + ps(readyPath) + ") } } finally { $Listener.Dispose() }",
    ] : []),
    ...(options.unknownSubmission ? ["    throw 'fixture_dispatch_unknown'"] : [
      ...(options.fingerprintChanged ? ["    [IO.File]::AppendAllText($ConfigPath,' ')"] : []),
      "    $Started = [Diagnostics.Process]::Start((New-NapCatQrWorkerStartInfo " + ps(workerPath) + " $Nonce $script:FixtureRequest.sha))",
      "    $script:Started = [Diagnostics.Process]::GetProcessById($Started.Id)",
      "    $null = $script:Started.Handle",
      "    $Started",
    ]),
    "  }",
    "  $Wait=" + (options.unknownSubmission || options.callerExits ? "0" : options.expired || options.fingerprintChanged ? "2" : "12"),
    ...(options.targetExclusive ? [
      "  $TargetDirectory=Join-Path " + ps(root) + " 'target-guard'",
      ...(options.rescan ? [
        "  $Approved=Get-NapCatQrConfig $ConfigPath $Desktop 'manualQrEnabled'",
        "  $Paths=Get-NapCatQrTargetPaths $Approved.value $LegacyPath",
        "  $Confirm={ param($Original,$Commit,$PriorOutcome) Invoke-NapCatQrRetirement $Original $Commit $Approved $Paths {} -PriorOutcome $PriorOutcome }",
        "  $PriorId=" + ps(options.rescan.supersede ?? ""),
        "  try { $First=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $Create $Launch $Wait " + ps(root) + " $PriorId $Confirm }",
        "  catch { $First=@{ status=$_.Exception.Message } }",
      ] : ["  $First=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $Create $Launch $Wait " + ps(root)]),
    ] : ["  $null=& $Create", "  $First=Start-NapCatQrSubmission $Directory $script:FixtureRequest $Launch $Wait"]),
    ...(options.callerExits ? [
      "  @{ directory=$Directory; outcome=$First; callerPid=$PID; launches=$script:Launches } | ConvertTo-Json -Depth 6 -Compress",
      "  return",
    ] : []),
    options.rescan && options.fingerprintChanged ? "  $Second=$null" : options.targetExclusive ?
      "  if ($null -ne $script:FixtureRequest) { $Second=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop { throw 'second_click_created_request' } { $script:Launches++ } 0 " + ps(root) + " $PriorId }" :
      "  $Second = Start-NapCatQrSubmission $Directory $script:FixtureRequest { $script:Launches++ } 0",
    "  $ActualPid=$null; $Birth=$null; $Fake=$null",
    "  if ($null -ne $script:Started) {",
    "    $ActualPid=$script:Started.Id; $Birth=[string]$script:Started.StartTime.ToFileTimeUtc()",
    ...(options.positive ? [
      "    $Limit=[DateTime]::UtcNow.AddSeconds(3)",
      "    while (-not [IO.File]::Exists(" + ps(readyPath) + ") -and [DateTime]::UtcNow -lt $Limit) { Start-Sleep -Milliseconds 100 }",
      "    if ([IO.File]::Exists(" + ps(readyPath) + ")) { $Fake = ConvertFrom-NapCatQrFile (Read-NapCatQrFile " + ps(readyPath) + ") }",
      "    [IO.File]::WriteAllText(" + ps(releasePath) + ",'release')",
    ] : []),
    "    if (-not $script:Started.WaitForExit(6500)) { throw 'fixture_worker_did_not_exit' }",
    "  }",
    "  if ($null -ne $script:FixtureRequest) {",
    "    $Last=Get-NapCatQrOutcome $Directory $script:FixtureRequest",
    "    $Claim=Read-NapCatQrBoundRecord $Directory 'claim' $script:FixtureRequest",
    "    $Admitted=Read-NapCatQrBoundRecord $Directory 'accepted' $script:FixtureRequest",
    "  }",
    "  @{ directory=$Directory; first=$First; second=$Second; last=$Last; workerPid=$ActualPid; workerBirth=$Birth; launches=$script:Launches; beforeWorker=$script:BeforeWorker; fake=$Fake; claim=$Claim; admitted=$Admitted } | ConvertTo-Json -Depth 8 -Compress",
    "} finally {",
    "  if ($null -ne $script:Started) {",
    ...(options.callerExits ? [] : [
      "    if (-not $script:Started.HasExited) { $script:Started.Kill(); $null = $script:Started.WaitForExit(3000) }",
    ]),
    "    $script:Started.Dispose()",
    "  }",
    "  if ($null -ne $Manual) { $Manual.Dispose() }",
    "  if ($null -ne $Mutex) { $Mutex.ReleaseMutex(); $Mutex.Dispose() }",
    "}",
  ];
  await writeFile(callerPath, caller.join("\r\n"), "utf8");
  const evidence = await runPs(callerPath);
  if (options.callerExits) return { ...evidence, diagnosticPath };
  const diagnostic = await readFile(diagnosticPath, "utf8").catch(() => "[]");
  evidence.workerErrors = JSON.parse(diagnostic);
  return evidence;
}

test("default Inspect and unconfigured notice are inert through the real entry points", { skip: !windows }, async () => {
  assert.deepEqual(await runPs(path.join(ops, manualName)), { status: "inspection_only", submitted: false });
  assert.deepEqual(await runPs(path.join(ops, noticeName)), { status: "notice_disabled" });
});

test("an independently verified desktop can dispatch the production worker to an isolated online endpoint", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "online");
  const entry = path.join(fixture.fixtureOps, manualName);
  const probe = path.join(fixture.root, "ordinary-desktop-probe.ps1");
  await writeFile(probe, [
    "$ErrorActionPreference='Stop'",
    ". " + ps(entry),
    "Initialize-NapCatQrPowerShell",
    "$Status=Get-NapCatQrWorkerLaunchState",
    "if ($Status -ne 'independent_sta_worker_ready') { @{ status=$Status } | ConvertTo-Json -Compress; return }",
    "try { $Desktop=Get-NapCatQrDesktopIdentity } catch { @{ status='desktop_identity_unverified' } | ConvertTo-Json -Compress; return }",
    "$ConfigPath=" + ps(fixture.configPath),
    "$Config=ConvertFrom-NapCatQrFile (Read-NapCatQrFile $ConfigPath)",
    "$Config | Add-Member computerName ([Environment]::MachineName) -Force",
    "$Config | Add-Member userSid $Desktop.sid -Force",
    "[IO.File]::WriteAllText($ConfigPath,($Config | ConvertTo-Json -Compress))",
    ". " + ps(path.join(fixture.fixtureOps, guardName)),
    "$Mutex=Get-NapCatOfflineQqMutexName -QqUserDataDir $Config.qqUserDataDir",
    "if ($Mutex -cnotmatch '^Global\\CodexNapCatQqLogin-[A-F0-9]{64}$') { throw 'fixture_mutex_unverified' }",
    "$Base=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'",
    "@{ status=$Status; base=$Base; profileHash=$Mutex.Substring($Mutex.Length-64) } | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  const identity = await runPs(probe);
  if (identity.status !== "independent_sta_worker_ready") {
    context.skip("No Job-free, verified desktop in this test host: " + identity.status);
    return;
  }
  assert.match(identity.profileHash, /^[A-F0-9]{64}$/);
  assert.equal(path.basename(identity.base).toLowerCase(), "temp");
  const target = path.join(identity.base, "napcat-manual-target-" + identity.profileHash);
  let directory;
  context.after(async () => {
    if (directory) {
      assert.equal(path.dirname(directory), identity.base);
      assert.match(path.basename(directory), /^napcat-manual-qr-[0-9a-f]{32}$/);
      await rm(directory, { recursive: true, force: true });
    }
    assert.equal(path.dirname(target), identity.base);
    await rm(target, { recursive: true, force: true });
  });
  const started = await runPs(entry, [...flag("Mode", "Start"), ...flag("ConfigPath", fixture.configPath), ...flag("WaitSeconds", "15")]);
  assert.match(started.requestId, /^[0-9a-f]{32}$/);
  directory = path.join(identity.base, "napcat-manual-qr-" + started.requestId);
  const result = await readJsonEventually(path.join(directory, "result.json"));
  assert.equal(result.status, "already_online");
  assert.equal(result.stopAttempted, false);
  assert.equal(started.workerPid, result.workerPid);
  assert.equal(await readFile(fixture.requestLog, "utf8"), "/get_status\n/get_login_info\n");
  await assert.rejects(readFile(fixture.readyPath), { code: "ENOENT" });
});

test("one real Windows worker stops only the owned fake endpoint and re-enters the old mutex on the same thread", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context);
  const evidence = await runWorkerCase(fixture, { positive: true, targetExclusive: true });
  assert.equal(evidence.launches, 1, JSON.stringify(evidence));
  assert.equal(evidence.first.status, "accepted_wait_for_login_result", JSON.stringify({
    evidence, actions: await readFile(fixture.requestLog, "utf8").catch(() => null),
  }));
  assert.equal(evidence.second.status, "accepted_wait_for_login_result");
  assert.equal(evidence.first.workerPid, evidence.workerPid);
  assert.equal(evidence.first.workerBirth, evidence.workerBirth);
  assert.equal(evidence.admitted.proof, "same-worker-guard-admitted");
  assert.equal(evidence.fake.pid, evidence.workerPid);
  assert.equal(evidence.fake.threadId, evidence.claim.threadId);
  assert.equal(evidence.fake.noQr, false);
  assert.equal(evidence.fake.manualLocked, true);
  assert.equal(evidence.last.status, "login_verified");
  assert.equal(evidence.last.stopAttempted, true);
  assert.equal(await readFile(fixture.requestLog, "utf8"), "/get_status\n/get_login_info\n/get_status\n/get_login_info\n");
  if (fixture.oneBot.exitCode === null) await once(fixture.oneBot, "exit");
});

for (const [oldStatus, drift, explicit, newInputsChanged] of [
  ["login_verified", false, false],
  ["login_verified", true, false],
  ["login_verified", true, true],
  ["blocked_by_shared_guard", true, false],
  ["login_verified", false, false, true],
]) {
  test("r6 fresh offline rescan after " + oldStatus + (explicit ? " with exact supersession" : " with ordinary Start") +
    (drift ? " after config drift" : "") + (newInputsChanged ? " with input drift after submission" : ""),
    { skip: !windows }, async (context) => {
      const fixture = await makeFixture(context, "zero");
      const loggedIn = oldStatus === "login_verified";
      const prior = await runWorkerCase(fixture, { targetExclusive: true, positive: loggedIn, manualBusy: !loggedIn });
      assert.equal(prior.last.status, oldStatus, JSON.stringify(prior));
      assert.equal(prior.launches, 1);
      if (loggedIn) {
        if (fixture.oneBot.exitCode === null && fixture.oneBot.signalCode === null) await once(fixture.oneBot, "exit");
        Object.assign(fixture, await fixture.startOneBot());
        for (const file of [fixture.readyPath, fixture.releasePath, fixture.requestLog]) await rm(file, { force: true });
      }
      const oldId = prior.last.requestId;
      const frames = ["request", "submitted", "dispatch", "claim", "result", ...(loggedIn ? ["accepted"] : [])];
      const oldBytes = await Promise.all(frames.map((name) => readFile(path.join(prior.directory, name + ".json"))));
      const oldRequest = JSON.parse(oldBytes[0]);
      if (drift) {
        const config = JSON.parse(await readFile(fixture.configPath, "utf8"));
        await json(fixture.configPath, { ...config, offlineNoticeEnabled: false });
        for (const file of [path.join(config.dataRoot, "binding.json"), path.join(config.accountStateDir, "deployment.json")]) {
          const value = JSON.parse(await readFile(file, "utf8"));
          await json(file, { ...value, fixtureRevision: 2 });
        }
      }
      await delay(Math.max(0, oldRequest.createdAt + 3050 - Date.now()));
      const next = await runWorkerCase(fixture, {
        targetExclusive: true, positive: !newInputsChanged, fingerprintChanged: newInputsChanged,
        rescan: { supersede: explicit ? oldId : null },
      });
      const status = newInputsChanged ? "recovery_refused_or_failed_before_stop" : "accepted_wait_for_login_result";
      if (newInputsChanged) assert.ok([status, "submission_unknown_do_not_retry"].includes(next.first.status), JSON.stringify(next));
      else assert.equal(next.first.status, status, JSON.stringify(next));
      assert.equal(next.launches, 1);
      assert.deepEqual(next.beforeWorker, { alive: true, contacted: false, legacy: false });
      assert.notEqual(next.first.requestId, oldId);
      if (!newInputsChanged) {
        assert.equal(next.second.requestId, next.first.requestId);
        assert.equal(next.second.status, explicit ? "superseded_request_mismatch" : status);
      }
      const nextRequest = JSON.parse(await readFile(path.join(next.directory, "request.json")));
      assert.equal(nextRequest.configSha !== oldRequest.configSha, drift);
      assert.equal(nextRequest.bindingSha !== oldRequest.bindingSha, drift);
      assert.equal(nextRequest.deploymentSha !== oldRequest.deploymentSha, drift);
      assert.equal(nextRequest.supersedesRequestId, undefined);
      assert.equal(nextRequest.supersededOffline, undefined);
      const target = path.join(fixture.root, "target-guard");
      const archive = JSON.parse(await readFile(path.join(target, "retired-" + oldId + ".json")));
      assert.equal(archive.id, oldId);
      assert.equal(archive.lastStatus, oldStatus);
      assert.equal(archive.workerPid, prior.workerPid);
      assert.equal(archive.sha, createHash("sha256").update(oldBytes[0]).digest("hex"));
      assert.equal(archive.resultSha, createHash("sha256").update(oldBytes[4]).digest("hex"));
      const current = JSON.parse(await readFile(path.join(target, "current.json")));
      assert.equal(current.id, nextRequest.id);
      assert.equal(current.phase, "launch-boundary-closed/v1");
      assert.deepEqual(await Promise.all(frames.map((name) => readFile(path.join(prior.directory, name + ".json")))), oldBytes);
      if (newInputsChanged) {
        assert.equal(next.last.status, status);
        assert.equal(next.last.stopAttempted, false);
        assert.equal(next.claim.workerPid, next.workerPid);
        assert.equal(next.admitted, null);
        assert.equal(fixture.oneBot.exitCode, null);
        for (const file of [fixture.requestLog, fixture.readyPath]) {
          await assert.rejects(readFile(file), { code: "ENOENT" });
        }
        const resultPath = path.join(next.directory, "result.json");
        const refusedBytes = await readFile(resultPath);
        await delay(Math.max(0, nextRequest.createdAt + 3050 - Date.now()));
        const retried = await runWorkerCase(fixture, { targetExclusive: true, positive: true, rescan: { supersede: null } });
        assert.equal(retried.launches, 1);
        assert.notEqual(retried.last.requestId, nextRequest.id);
        assert.equal(retried.last.status, "login_verified", JSON.stringify(retried));
        assert.deepEqual(await readFile(resultPath), refusedBytes);
      } else {
        assert.equal(next.last.status, "login_verified");
        assert.equal(next.last.stopAttempted, true);
        assert.equal(next.fake.pid, next.workerPid);
        assert.equal(next.fake.manualLocked, true);
        assert.equal(next.fake.threadId, next.admitted.threadId);
        assert.equal(await readFile(fixture.requestLog, "utf8"), "/get_status\n/get_login_info\n".repeat(2));
      }
    });
}

test("the original worker runs to a bound result after the launcher process exits", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "caller-exits");
  const evidence = await runWorkerCase(fixture, { callerExits: true });
  assert.equal(evidence.launches, 1);
  assert.notEqual(evidence.outcome.workerPid, evidence.callerPid);
  assert.match(evidence.outcome.workerBirth, /^[0-9]+$/);
  try {
    const fake = await readJsonEventually(fixture.readyPath);
    assert.equal(fake.pid, evidence.outcome.workerPid);
    assert.equal(fake.callerExited, true);
    const beforeRelease = await readJsonEventually(path.join(evidence.directory, "accepted.json"));
    assert.equal(fake.threadId, beforeRelease.threadId);
  } finally {
    await writeFile(fixture.releasePath, "release", "utf8");
  }
  const result = await readJsonEventually(path.join(evidence.directory, "result.json"));
  assert.equal(result.workerPid, evidence.outcome.workerPid);
  assert.equal(result.status, "login_verified");
  await readJsonEventually(evidence.diagnosticPath);
});

test("training desktop opt-in can launch the old script after a double connection refusal without stopping anyone", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "refused-empty", "training");
  const evidence = await runWorkerCase(fixture, { positive: true });
  assert.equal(evidence.first.status, "accepted_wait_for_login_result", JSON.stringify(evidence));
  assert.equal(evidence.last.status, "login_verified");
  assert.equal(evidence.last.stopAttempted, false);
  assert.equal(evidence.fake.pid, evidence.first.workerPid);
  await assert.rejects(readFile(fixture.requestLog), { code: "ENOENT" });
});

for (const [scenario, status] of [
  ["identity-unavailable", "login_verified"],
  ["empty-exe", "login_verified"],
  ["legacy-nonzero", "login_result_unknown_check_original_request"],
]) {
  test("owned offline endpoint and legacy contract: " + scenario, { skip: !windows }, async (context) => {
    const fixture = await makeFixture(context, scenario);
    const evidence = await runWorkerCase(fixture, { positive: true });
    assert.equal(evidence.first.status, "accepted_wait_for_login_result", JSON.stringify(evidence));
    assert.equal(evidence.last.status, status, JSON.stringify(evidence));
    assert.equal(evidence.last.stopAttempted, true);
    assert.equal(evidence.fake.profileCanonical, true);
    assert.equal(evidence.fake.timeoutSeconds, 300);
    if (scenario === "empty-exe") assert.equal(evidence.fake.qqExePath, "");
    assert.equal(await readFile(fixture.requestLog, "utf8"), "/get_status\n/get_login_info\n/get_status\n/get_login_info\n");
  });
}

for (const nested of [false, true]) {
  test("real Windows job refuses the production Start and Worker gates: " + (nested ? "outer kill, inner clean" : "immediate kill"),
    { skip: !windows }, async (context) => {
      const fixture = await makeFixture(context);
      const { root, fixtureOps } = fixture;
      const probe = path.join(root, "job-probe.ps1");
      const parent = path.join(root, "job-owner.ps1");
      const assigned = path.join(root, "jobs-assigned");
      const evidence = path.join(root, "job-result.json");
      const entry = path.join(fixtureOps, manualName);
      await writeFile(probe, [
        "$ErrorActionPreference='Stop'",
        "$Limit=[DateTime]::UtcNow.AddSeconds(15)",
        "while (-not [IO.File]::Exists(" + ps(assigned) + ")) { if ([DateTime]::UtcNow -ge $Limit) { exit 2 }; Start-Sleep -Milliseconds 50 }",
        "$Start=& " + ps(entry) + " -Mode Start -ConfigPath " + ps(path.join(root, "never-created.json")),
        "$StartExit=$global:LASTEXITCODE",
        "$Worker=& " + ps(entry) + " -Mode Worker -RequestId ('a' * 32) -RequestSha256 ('a' * 64)",
        "$WorkerExit=$global:LASTEXITCODE",
        "@" + "{ start=($Start | ConvertFrom-Json).status; startExit=$StartExit; worker=($Worker | ConvertFrom-Json).status; workerExit=$WorkerExit } | ConvertTo-Json -Compress | Set-Content -LiteralPath " + ps(evidence) + " -Encoding Ascii",
        "Start-Sleep -Seconds 15",
      ].join("\r\n"), "utf8");
      await writeFile(parent, [
        "$ErrorActionPreference='Stop'",
        ". " + ps(entry),
        "Initialize-NapCatQrNative",
        "Add-Type -TypeDefinition @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class FixtureJob {",
        "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr security, IntPtr name);",
        "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);",
        "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
        "  [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, byte[] limits, int bytes);",
        "  public static void SetKillOnClose(IntPtr job) {",
        "    byte[] limits = new byte[144];",
        "    limits[17] = 0x20;",
        "    if (IntPtr.Size != 8 || !SetInformationJobObject(job, 9, limits, limits.Length)) throw new InvalidOperationException(\"SetInformationJobObject failed: \" + Marshal.GetLastWin32Error());",
        "  }",
        "}",
        "'@",
        "$Outer=[IntPtr]::Zero; $Inner=[IntPtr]::Zero; $Child=$null",
        "try {",
        "  $Outer=[FixtureJob]::CreateJobObject([IntPtr]::Zero,[IntPtr]::Zero)",
        "  if ($Outer -eq [IntPtr]::Zero) { throw 'fixture_job_unavailable' }",
        "  [FixtureJob]::SetKillOnClose($Outer)",
        "  $Info=[Diagnostics.ProcessStartInfo]::new((Get-NapCatQrPowerShellExecutable))",
        "  $Info.Arguments=" + ps((isPwsh ? '-NoLogo -NoProfile -NonInteractive -STA -File "' : '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "') + probe + '"'),
        "  $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true",
        "  $Child=[Diagnostics.Process]::Start($Info)",
        "  if (-not [FixtureJob]::AssignProcessToJobObject($Outer,$Child.Handle)) { throw ('fixture_outer_assignment_failed_' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
        "  $InOuter=$false; $InInner=$false",
        "  if (-not [NapCatQrNative]::IsProcessInJob($Child.Handle,$Outer,[ref]$InOuter) -or -not $InOuter) { throw 'fixture_outer_membership_unverified' }",
        ...(nested ? [
          "  $Inner=[FixtureJob]::CreateJobObject([IntPtr]::Zero,[IntPtr]::Zero)",
          "  if ($Inner -eq [IntPtr]::Zero -or -not [FixtureJob]::AssignProcessToJobObject($Inner,$Child.Handle)) { throw ('fixture_inner_assignment_failed_' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }",
          "  if (-not [NapCatQrNative]::IsProcessInJob($Child.Handle,$Inner,[ref]$InInner) -or -not $InInner) { throw 'fixture_inner_membership_unverified' }",
        ] : []),
        "  [IO.File]::WriteAllText(" + ps(assigned) + ",'ready')",
        "  $Limit=[DateTime]::UtcNow.AddSeconds(12)",
        "  $Result=$null; $EvidencePath=" + ps(evidence),
        "  do {",
        "    if ([IO.File]::Exists($EvidencePath)) { try { $Result=Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json -ErrorAction Stop } catch {} }",
        "    if ($Child.HasExited -or [DateTime]::UtcNow -ge $Limit) { throw 'fixture_job_probe_no_result' }",
        "    if ($null -eq $Result) { Start-Sleep -Milliseconds 50 }",
        "  } while ($null -eq $Result)",
        "  if (-not [FixtureJob]::CloseHandle($Outer)) { throw 'fixture_outer_close_failed' }",
        "  $Outer=[IntPtr]::Zero",
        "  @{ result=$Result; outer=$InOuter; inner=$InInner; killedOnClose=$Child.WaitForExit(4000) } | ConvertTo-Json -Depth 5 -Compress",
        "} finally {",
        "  if ($Outer -ne [IntPtr]::Zero) { $null=[FixtureJob]::CloseHandle($Outer) }",
        "  if ($Inner -ne [IntPtr]::Zero) { $null=[FixtureJob]::CloseHandle($Inner) }",
        "  if ($null -ne $Child) { if (-not $Child.HasExited) { $Child.Kill(); $null=$Child.WaitForExit(3000) }; $Child.Dispose() }",
        "}",
      ].join("\r\n"), "utf8");
      const proof = await runPs(parent);
      const status = nested ? "worker_job_lifecycle_unverified" : "worker_job_kill_on_close";
      assert.deepEqual(proof, {
        result: { start: status, startExit: 1, worker: status, workerExit: 1 },
        outer: true, inner: nested, killedOnClose: true,
      });
      await assert.rejects(readFile(fixture.requestLog), { code: "ENOENT" });
    });
}

test("two simultaneous Windows callers share one target and preserve the original unknown submission", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context);
  const script = path.join(fixture.root, "fixture-double-click.ps1");
  const trace = path.join(fixture.root, "only-submission.txt");
  await writeFile(script, [
    "param([string]$PreviousId)",
    "$ErrorActionPreference='Stop'",
    ". " + ps(path.join(fixture.fixtureOps, manualName)),
    "$Process=[Diagnostics.Process]::GetCurrentProcess()",
    "$Desktop=@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; sessionId=[Math]::Max(1,$Process.SessionId); explorerId=$PID }",
    "$Root=" + ps(fixture.root),
    "$Trace=" + ps(trace),
    "Start-NapCatQrTargetSubmission (Join-Path $Root 'target-click-lock') $Desktop {",
    "  $Id=[Guid]::NewGuid().ToString('N'); $Directory=Get-NapCatQrRequestDirectory $Id $Root",
    "  $Now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  New-NapCatQrRequestDirectory $Directory $Desktop.sid",
    "  Write-NapCatQrRecord $Directory 'request' @{ schema='napcat.manual-qr/v1'; id=$Id; sid=$Desktop.sid; sessionId=$Desktop.sessionId; explorerId=$Desktop.explorerId; requesterPid=$PID; requesterBirth=$Process.StartTime.ToFileTimeUtc(); createdAt=$Now; deadlineAt=$Now+45000 }",
    "  @{ directory=$Directory; request=(Get-NapCatQrRequest $Directory $Id '' $Desktop) }",
    "} {",
    "  param($Original)",
    "  [IO.File]::AppendAllText($Trace,($Original.value.id + [Environment]::NewLine))",
    "  Start-Sleep -Milliseconds 500",
    "  throw 'fixture_native_submission_unknown'",
    "} 0 $Root -SupersedeRequestId $PreviousId -ConfirmRetirement { throw 'missing_dispatch_must_not_retire' } | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  const clicks = await Promise.all([runPs(script), runPs(script)]);
  const submitted = (await readFile(trace, "utf8")).trim().split(/\r?\n/);
  assert.equal(submitted.length, 1);
  assert.ok(clicks.some((outcome) => outcome.requestId === submitted[0]));
  assert.ok(clicks.every((outcome) => ["target_submission_in_progress_do_not_retry", "submission_unknown_do_not_retry"].includes(outcome.status)));
  const lookup = await runPs(script);
  assert.equal(lookup.status, "submission_unknown_do_not_retry");
  assert.equal(lookup.requestId, submitted[0]);
  assert.deepEqual(await runPs(script, flag("PreviousId", submitted[0])),
    { status: "previous_worker_exit_unverified", requestId: submitted[0] });
  assert.equal((await readFile(trace, "utf8")).trim(), submitted[0]);
});

test("r6 an undispatched, live, or unbound final receipt leaves the original pointer and files intact", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context);
  const script = path.join(fixture.root, "fixture-incomplete-terminal.ps1");
  const scriptWorker = path.join(fixture.root, "fixture-live-original.ps1");
  const release = path.join(fixture.root, "release-original.txt");
  await writeFile(scriptWorker, [
    "param($Mode,$RequestId,$RequestSha256)",
    "$Limit=[DateTime]::UtcNow.AddSeconds(20)",
    "while (-not [IO.File]::Exists(" + ps(release) + ") -and [DateTime]::UtcNow -lt $Limit) { Start-Sleep -Milliseconds 60 }",
  ].join("\r\n"), "utf8");
  const cases = [
    ["fresh_unsubmitted_login", "unsubmitted", "login_verified", "submission_unknown_do_not_retry", "previous_worker_exit_unverified"],
    ["fresh_unsubmitted_definite", "unsubmitted", "blocked_by_shared_guard", "submission_unknown_do_not_retry", "previous_worker_exit_unverified"],
    ["submitted_only_login", "submitted", "login_verified", "submission_unknown_do_not_retry", "previous_worker_exit_unverified"],
    ["submitted_only_definite", "submitted", "blocked_by_shared_guard", "submission_unknown_do_not_retry", "previous_worker_exit_unverified"],
    ["same_worker_live_unknown", "live", "", "submission_unknown_do_not_retry", "previous_worker_exit_unverified"],
    ["same_worker_live_definite", "live", "blocked_by_shared_guard", "previous_worker_exit_unverified", "previous_worker_exit_unverified"],
    ["exited_without_result", "exited", "", "submission_unknown_do_not_retry", "previous_login_unverified"],
    ["exited_without_claim", "exited", "blocked_by_shared_guard", "submission_unknown_do_not_retry", "previous_login_unverified"],
    ["exited_wrong_thread", "exited", "blocked_by_shared_guard", "submission_unknown_do_not_retry", "previous_login_unverified"],
    ["exited_string_birth", "exited", "blocked_by_shared_guard", "submission_unknown_do_not_retry", "previous_login_unverified"],
    ["exited_unadmitted_login", "exited", "login_verified", "submission_unknown_do_not_retry", "previous_login_unverified"],
    ["exited_unknown_status", "exited", "new_unrecognized_status", "submission_unknown_do_not_retry", "previous_login_unverified"],
  ];
  await writeFile(script, [
    "$ErrorActionPreference='Stop'",
    ". " + ps(path.join(fixture.fixtureOps, manualName)),
    "$Root=" + ps(fixture.root),
    "$Self=[Diagnostics.Process]::GetCurrentProcess()",
    "$Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$Desktop=@{sid=$Sid;sessionId=[Math]::Max(1,$Self.SessionId);explorerId=$PID}",
    "$StartedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "$Original=[Diagnostics.Process]::Start((New-NapCatQrWorkerStartInfo " + ps(scriptWorker) + " ('1'*32) ('1'*64)))",
    "try {",
    "  $null=$Original.Handle; $OriginalBirth=$Original.StartTime.ToFileTimeUtc()",
    "  $Cases=@(",
    ...cases.map(([name, stage, status]) => "    @{name=" + ps(name) + ";stage=" + ps(stage) + ";status=" + ps(status) + "}"),
    "  )",
    "  $Rows=@{}",
    "  foreach ($Case in $Cases) {",
    "    if ($Case.stage -ceq 'live') {",
    "      $Delay=$StartedAt+3050-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "      if ($Delay -gt 0) { Start-Sleep -Milliseconds $Delay }",
    "      if ($Original.HasExited) { throw 'fixture_original_not_live' }",
    "    }",
    "    if ($Case.stage -ceq 'exited' -and -not $Original.HasExited) {",
    "      [IO.File]::WriteAllText(" + ps(release) + ",'exit')",
    "      if (-not $Original.WaitForExit(5000)) { throw 'fixture_original_not_exited' }",
    "    }",
    "    $Id=[Guid]::NewGuid().ToString('N'); $OldDir=Get-NapCatQrRequestDirectory $Id $Root; $Target=Join-Path $Root $Case.name",
    "    New-NapCatQrRequestDirectory $OldDir $Sid",
    "    New-NapCatQrRequestDirectory $Target $Sid",
    "    $At=if ($Case.stage -cin @('live','exited')) { $StartedAt } else { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }",
    "    Write-NapCatQrRecord $OldDir 'request' @{schema='napcat.manual-qr/v1';id=$Id;sid=$Sid;sessionId=$Desktop.sessionId;explorerId=$PID;requesterPid=$PID;requesterBirth=$Self.StartTime.ToFileTimeUtc();createdAt=$At;deadlineAt=$At+45000}",
    "    $Request=Get-NapCatQrRequest $OldDir $Id '' $Desktop",
    "    $Bound=@{id=$Id;requestSha256=$Request.sha}",
    "    $Identity=$Bound+@{workerPid=$Original.Id;workerBirth=$OriginalBirth;parentPid=$PID}",
    "    $Receipt=$Identity+@{threadId=1}",
    "    if ($Case.stage -cne 'unsubmitted') { Write-NapCatQrRecord $OldDir 'submitted' $Bound -Claim }",
    "    if ($Case.stage -cin @('live','exited')) { Write-NapCatQrRecord $OldDir 'dispatch' $Identity }",
    "    if ($Case.name -cne 'exited_without_claim') { Write-NapCatQrRecord $OldDir 'claim' $Receipt -Claim }",
    "    if ($Case.status) {",
    "      $Result=$Receipt+@{status=$Case.status;stopAttempted=$false}",
    "      if ($Case.name -ceq 'exited_wrong_thread') { $Result.threadId=2 }",
    "      if ($Case.name -ceq 'exited_string_birth') { $Result.workerBirth=[string]$OriginalBirth }",
    "      Write-NapCatQrRecord $OldDir 'result' $Result",
    "    }",
    "    $Phase=if ($Case.stage -ceq 'unsubmitted') { 'prelaunch/v1' } else { 'launch-boundary-closed/v1' }",
    "    Write-NapCatQrRecord $Target 'current' @{id=$Id;sha=$Request.sha;phase=$Phase}",
    "    $PointerFile=Join-Path $Target 'current.json'",
    "    $Before=(Read-NapCatQrFile $PointerFile).sha",
    "    $FrameFiles=@([IO.Directory]::GetFiles($OldDir) | Sort-Object)",
    "    $FramesBefore=@($FrameFiles | ForEach-Object { (Read-NapCatQrFile $_).sha })",
    "    $Create={ throw 'fixture_must_not_create' }; $Launch={ throw 'fixture_must_not_dispatch' }; $Confirm={ throw 'fixture_must_not_ask_for_retirement' }",
    "    $Ordinary=Start-NapCatQrTargetSubmission $Target $Desktop $Create $Launch 0 $Root -ConfirmRetirement $Confirm",
    "    $Explicit=Start-NapCatQrTargetSubmission $Target $Desktop $Create $Launch 0 $Root $Id $Confirm",
    "    $FramesAfter=@([IO.Directory]::GetFiles($OldDir) | Sort-Object | ForEach-Object { (Read-NapCatQrFile $_).sha })",
    "    $Rows[$Case.name]=@{ordinary=$Ordinary.status;explicit=$Explicit.status;bound=($Ordinary.requestId -ceq $Id -and $Explicit.requestId -ceq $Id);unchanged=((Read-NapCatQrFile $PointerFile).sha -ceq $Before -and ($FramesBefore -join ',') -ceq ($FramesAfter -join ','));archived=[IO.File]::Exists((Join-Path $Target ('retired-'+$Id+'.json')))}",
    "  }",
    "  $Rows | ConvertTo-Json -Depth 4 -Compress",
    "} finally {",
    "  if (-not $Original.HasExited) { $Original.Kill(); $null=$Original.WaitForExit(3000) }",
    "  $Original.Dispose(); $Self.Dispose()",
    "}",
  ].join("\r\n"), "utf8");
  const result = await runPs(script);
  for (const [name, , , ordinary, explicit] of cases) {
    assert.deepEqual(result[name], { ordinary, explicit, bound: true, unchanged: true, archived: false }, name);
  }
  assert.equal(fixture.oneBot.exitCode, null);
  await assert.rejects(readFile(fixture.requestLog), { code: "ENOENT" });
  await assert.rejects(readFile(fixture.readyPath), { code: "ENOENT" });
});

for (const [scenario, eligible, expired, terminal, targetDrift] of [
  ["refused-empty", true], ["offline", false], ["zero", false, true], ["zero", true, true, true],
  ["late-wrong", false, true, true], ["zero", false, true, true, true],
]) {
  test("explicit historical supersession checks the real worker and target: " + scenario + (terminal ? " after terminal timeout" : "") + (targetDrift ? " with a different target fingerprint" : ""), { skip: !windows }, async (context) => {
    const fixture = await makeFixture(context, scenario);
    const { root, configPath } = fixture;
    const script = path.join(root, "fixture-retirement.ps1");
    const oldWorker = path.join(root, "fixture-old-worker.ps1");
    const oldRelease = path.join(root, "old-worker-release");
    await writeFile(oldWorker, [
      "param($Mode,$RequestId,$RequestSha256)",
      "$Limit=[DateTime]::UtcNow.AddSeconds(18)",
      "while (-not [IO.File]::Exists(" + ps(oldRelease) + ") -and [DateTime]::UtcNow -lt $Limit) { Start-Sleep -Milliseconds 70 }",
    ].join("\r\n"), "utf8");
    await writeFile(script, [
      pathsPrelude(fixture),
      ". $IdentityPath",
      ". $GuardPath",
      "$Proc=[Diagnostics.Process]::GetCurrentProcess()",
      "$Desktop=@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; sessionId=[Math]::Max(1,$Proc.SessionId); explorerId=$PID; birth=$Proc.StartTime.ToFileTimeUtc() }",
      "$ConfigJson=ConvertFrom-NapCatQrFile (Read-NapCatQrFile $ConfigPath)",
      "$ConfigJson | Add-Member computerName ([Environment]::MachineName) -Force",
      "$ConfigJson | Add-Member userSid $Desktop.sid -Force",
      "[IO.File]::WriteAllText($ConfigPath,($ConfigJson | ConvertTo-Json -Compress))",
      "$Config=Get-NapCatQrConfig $ConfigPath $Desktop 'manualQrEnabled'",
      "$Paths=Get-NapCatQrTargetPaths $Config.value $LegacyPath",
      "$Root=" + ps(root),
      "$TargetDirectory=Join-Path $Root 'retirement-target'",
      "$OldId=[Guid]::NewGuid().ToString('N'); $NextId=[Guid]::NewGuid().ToString('N')",
      "$OldDirectory=Get-NapCatQrRequestDirectory $OldId $Root",
      "New-NapCatQrRequestDirectory $OldDirectory $Desktop.sid",
      "New-NapCatQrRequestDirectory $TargetDirectory $Desktop.sid",
      "$Now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()" + (expired ? "-41000" : ""),
      "$Fields=@{ schema='napcat.manual-qr/v1'; id=$OldId; sid=$Desktop.sid; sessionId=($Desktop.sessionId+1); explorerId=($PID+1); requesterPid=$PID; requesterBirth=$Desktop.birth; createdAt=$Now; deadlineAt=$Now+45000; configPath=$Config.path; configSha=$Config.sha; bindingSha=$Config.bindingSha; loginSha=$Config.value.loginSha256 }",
      "Write-NapCatQrRecord $OldDirectory 'request' $Fields",
      "$Old=Get-NapCatQrRequest $OldDirectory $OldId '' $Desktop -Historical",
      "$CurrentSessionRejectsOld=$false",
      "try { $null=Get-NapCatQrRequest $OldDirectory $OldId $Old.sha $Desktop } catch { $CurrentSessionRejectsOld=$_.Exception.Message -eq 'request_identity_unverified' }",
      "Write-NapCatQrRecord $TargetDirectory 'current' @{ id=$OldId; sha=$Old.sha }",
      "$script:Child=$null; $script:NextLaunches=0",
      "try {",
      "  $null=Start-NapCatQrSubmission $OldDirectory $Old {",
      "    $Started=[Diagnostics.Process]::Start((New-NapCatQrWorkerStartInfo " + ps(oldWorker) + " $OldId $Old.sha))",
      "    $script:Child=[Diagnostics.Process]::GetProcessById($Started.Id); $null=$script:Child.Handle; $Started",
      "  } 0",
      "  $Dispatch=Get-NapCatQrBoundDispatch $OldDirectory $Old",
      "  if ($null -eq $Dispatch) { throw 'fixture_no_dispatch' }",
      "  $Receipt=@{ id=$OldId; requestSha256=$Old.sha; workerPid=$Dispatch.workerPid; workerBirth=$Dispatch.workerBirth; parentPid=$PID; threadId=1 }",
      "  Write-NapCatQrRecord $OldDirectory 'claim' $Receipt -Claim",
      "  $DeploymentSha=(Read-NapCatQrFile (Join-Path $Paths.accountStateDir 'deployment.json')).sha + ':' + $Config.bindingSha",
      "  $TargetSha=" + (targetDrift ? "('0'*64)" : "(Read-NapCatQrFile $Paths.privateEnvPath).sha"),
      "  Write-NapCatQrRecord $OldDirectory 'accepted' ($Receipt + @{ proof='same-worker-guard-admitted'; deploymentSha=$DeploymentSha; targetSha=$TargetSha })",
      "  $Frames=@('request','submitted','dispatch','claim','accepted','result')",
      "  $NewRequest={",
      "    param($SupersededOffline)",
      "    $NextDirectory=Get-NapCatQrRequestDirectory $NextId $Root; New-NapCatQrRequestDirectory $NextDirectory $Desktop.sid",
      "    $NewFields=$Fields.Clone(); $NewFields.id=$NextId; $NewFields.sessionId=$Desktop.sessionId; $NewFields.explorerId=$Desktop.explorerId",
      "    $NewFields.supersedesRequestId=$OldId; $NewFields.createdAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $NewFields.deadlineAt=$NewFields.createdAt+45000",
      "    if ($null -ne $SupersededOffline) { $NewFields.supersededOffline=$SupersededOffline; $script:OfflineProof=$SupersededOffline }",
      "    Write-NapCatQrRecord $NextDirectory 'request' $NewFields",
      "    @{ directory=$NextDirectory; request=(Get-NapCatQrRequest $NextDirectory $NextId '' $Desktop) }",
      "  }",
      "  $Launch={ $script:NextLaunches++; $script:BoundaryAtLaunch=(ConvertFrom-NapCatQrFile (Read-NapCatQrFile (Join-Path $TargetDirectory 'current.json'))).phase; throw 'fixture_new_dispatch_unknown' }",
      "  $Confirm={ param($Previous,$Commit,$PriorOutcome) Invoke-NapCatQrRetirement $Previous $Commit $Config $Paths { if ($PID -ne $Desktop.explorerId) { throw 'fixture_changed' } } -PriorOutcome $PriorOutcome }",
      "  $Wrong=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $NewRequest $Launch 0 $Root $NextId $Confirm",
      "  $Live=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $NewRequest $Launch 0 $Root $OldId $Confirm",
      "  [IO.File]::WriteAllText(" + ps(oldRelease) + ",'exit')",
      "  if (-not $script:Child.WaitForExit(5000)) { throw 'fixture_old_worker_not_exited' }",
      ...(expired ? ["  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $Old.value.deadlineAt) { Start-Sleep -Milliseconds 60 }"] : []),
      "  Write-NapCatQrRecord $OldDirectory 'result' ($Receipt + @{ status=" + (terminal ? "'login_timed_out'; terminalProof='legacy-timeout-after-cleanup/v1'" : "'login_result_unknown_check_original_request'") + "; stopAttempted=$true })",
      "  $Before=@($Frames | ForEach-Object { (Read-NapCatQrFile (Join-Path $OldDirectory ($_+'.json'))).sha })",
      "  $NoConsent=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $NewRequest $Launch 0 $Root",
      "  $Retried=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $NewRequest $Launch 0 $Root $OldId $Confirm",
      "  $Replay=Start-NapCatQrTargetSubmission $TargetDirectory $Desktop $NewRequest $Launch 0 $Root $OldId $Confirm",
      "  $After=@($Frames | ForEach-Object { (Read-NapCatQrFile (Join-Path $OldDirectory ($_+'.json'))).sha })",
      "  $ArchivePath=Join-Path $TargetDirectory ('retired-'+$OldId+'.json')",
      "  $Archive=$null; $ArchiveExists=[IO.File]::Exists($ArchivePath)",
      "  if ($ArchiveExists) { $Archive=ConvertFrom-NapCatQrFile (Read-NapCatQrFile $ArchivePath) }",
      "  @{ old=$OldId; next=$NextId; oldSha=$Old.sha; wrong=$Wrong; live=$Live; noConsent=$NoConsent; retried=$Retried; replay=$Replay; launches=$script:NextLaunches; boundaryAtLaunch=$script:BoundaryAtLaunch; archive=$Archive; archiveExists=$ArchiveExists; offlineProof=$script:OfflineProof; unchanged=(($Before -join ',') -ceq ($After -join ',')); historicalOnly=$CurrentSessionRejectsOld; current=(ConvertFrom-NapCatQrFile (Read-NapCatQrFile (Join-Path $TargetDirectory 'current.json'))).id } | ConvertTo-Json -Depth 7 -Compress",
      "} finally { if ($null -ne $script:Child) { if (-not $script:Child.HasExited) { $script:Child.Kill(); $null=$script:Child.WaitForExit(3000) }; $script:Child.Dispose() } }",
    ].join("\r\n"), "utf8");
    const result = await runPs(script, flag("ConfigPath", configPath));
    assert.equal(result.historicalOnly, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.wrong, { status: "superseded_request_mismatch", requestId: result.old });
    assert.deepEqual(result.live, { status: "previous_worker_exit_unverified", requestId: result.old });
    assert.equal(result.noConsent.status, terminal ? "login_timed_out" : "login_result_unknown_check_original_request");
    assert.equal(result.noConsent.requestId, result.old);
    assert.equal(Object.keys(result.noConsent).some((key) => key.startsWith("terminal")), false);
    assert.equal(result.launches, eligible ? 1 : 0);
    assert.equal(result.boundaryAtLaunch, eligible ? "launch-boundary-closed/v1" : null);
    assert.equal(result.current, eligible ? result.next : result.old);
    assert.equal(result.archiveExists, eligible);
    if (eligible) {
      assert.equal(result.archive.id, result.old);
      assert.equal(result.archive.sha, result.oldSha);
      assert.deepEqual(result.retried, { status: "submission_unknown_do_not_retry", requestId: result.next });
      assert.deepEqual(result.replay, { status: "superseded_request_mismatch", requestId: result.next });
    } else {
      assert.deepEqual(result.retried, { status: "previous_login_unverified", requestId: result.old });
    }
    if (terminal && !targetDrift) {
      assert.equal(await readFile(fixture.requestLog, "utf8"), "/get_status\n/get_login_info\n".repeat(eligible ? 2 : 3));
      if (eligible) {
        assert.equal(result.offlineProof.owner, fixture.oneBot.pid);
        assert.match(result.offlineProof.processSha, /^[0-9a-f]{64}$/);
      } else assert.equal(result.offlineProof, null);
      assert.equal(fixture.oneBot.exitCode, null);
    } else await assert.rejects(readFile(fixture.requestLog), { code: "ENOENT" });
  });
}

for (const record of [
  ["already online", "online", {}, "already_online"],
  ["wrong identity", "wrong", {}, "wrong_identity_preserved"],
  ["online without a verified login account", "online-without-identity", {}, "onebot_identity_unverified"],
  ["offline without account evidence from an unowned process", "identity-unavailable-unowned", {}, "process_identity_unverified"],
  ["new mismatched account on final offline probe", "late-wrong", {}, "wrong_identity_preserved"],
  ["explicit mismatched account in an error response", "failed-wrong", {}, "wrong_identity_preserved"],
  ["a runtime present after an operator explicitly superseded an unknown request", "offline", { supersedes: true }, "previous_login_unverified"],
  ["refused with an owned process", "refused-owned", {}, "refused_target_not_empty"],
  ["refused with another local listener", "refused-other-listener", {}, "refused_target_not_empty"],
  ["unknown OneBot status", "unknown", {}, "onebot_state_unknown"],
  ["timed out OneBot status", "timeout", {}, "onebot_state_unknown"],
  ["changed between checks", "recovered", {}, "offline_no_longer_confirmed"],
  ["manual lock held", "offline", { manualBusy: true }, "blocked_by_shared_guard"],
  ["profile mutex held by another process", "offline", { profileBusy: true }, "blocked_by_shared_guard"],
  ["expired nonce", "offline", { expired: true }, "submission_unknown_do_not_retry"],
  ["changed configuration fingerprint", "offline", { fingerprintChanged: true }, "recovery_refused_or_failed_before_stop"],
  ["dispatch exception with no receipt across two Start calls", "offline", { unknownSubmission: true, targetExclusive: true }, "submission_unknown_do_not_retry"],
]) {
  const [name, scenario, options, status] = record;
  test("preserves the fake endpoint: " + name, { skip: !windows }, async (context) => {
    const fixture = await makeFixture(context, scenario);
    const evidence = await runWorkerCase(fixture, options);
    assert.equal(evidence.launches, 1, JSON.stringify(evidence));
    assert.equal(evidence.last.status, status, JSON.stringify({
      evidence, actions: await readFile(fixture.requestLog, "utf8").catch(() => null),
    }));
    if (options.targetExclusive) assert.equal(evidence.second.requestId, evidence.first.requestId);
    assert.equal(evidence.admitted, null);
    assert.notEqual(evidence.last.stopAttempted, true);
    if (options.fingerprintChanged) {
      assert.equal(evidence.claim.workerPid, evidence.workerPid);
      assert.equal(evidence.last.stopAttempted, false);
      await assert.rejects(readFile(fixture.requestLog), { code: "ENOENT" });
    }
    assert.equal(fixture.oneBot.exitCode, null);
    await assert.rejects(readFile(fixture.readyPath), { code: "ENOENT" });
  });
}

async function runNoticeCase(fixture) {
  const script = path.join(fixture.root, "fixture-notice.ps1");
  await writeFile(script, [
    "$ErrorActionPreference='Stop'",
    ". " + ps(path.join(fixture.fixtureOps, manualName)),
    ". " + ps(path.join(fixture.fixtureOps, noticeName)),
    "$ConfigPath=" + ps(fixture.configPath),
    "$Config=ConvertFrom-NapCatQrFile (Read-NapCatQrFile $ConfigPath)",
    "$script:NoticeFixtureDesktop=@{ sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; sessionId=[Math]::Max(1,[Diagnostics.Process]::GetCurrentProcess().SessionId); explorerId=$PID }",
    "$Config | Add-Member computerName ([Environment]::MachineName) -Force",
    "$Config | Add-Member userSid $script:NoticeFixtureDesktop.sid -Force",
    "function Get-NapCatQrDesktopIdentity { $script:NoticeFixtureDesktop }",
    "$script:Shown=0",
    "function Save-Config { [IO.File]::WriteAllText($ConfigPath,($Config | ConvertTo-Json -Compress)) }",
    "Save-Config",
    "$Allowed=Invoke-NapCatOfflineNotice $ConfigPath 'fixture:valid' { $script:Shown++ }",
    "$BadKey=Invoke-NapCatOfflineNotice $ConfigPath 'bad/key' { $script:Shown++ }",
    "$Config.machineRole='training'; Save-Config",
    "$Training=Invoke-NapCatOfflineNotice $ConfigPath 'fixture:valid' { $script:Shown++ }",
    "$Config.machineRole='development'; $Config.offlineNoticeEnabled=$false; Save-Config",
    "$Disabled=Invoke-NapCatOfflineNotice $ConfigPath 'fixture:valid' { $script:Shown++ }",
    "$Config.offlineNoticeEnabled=$true; Save-Config",
    "function Get-NapCatQrDesktopIdentity { throw 'no_interactive_desktop' }",
    "$NonInteractive=Invoke-NapCatOfflineNotice $ConfigPath 'fixture:valid' { $script:Shown++ }",
    "$Events=@($Error | Select-Object -First 5 | ForEach-Object { @{ message=$_.Exception.Message; errorId=$_.FullyQualifiedErrorId; position=$_.InvocationInfo.PositionMessage } })",
    "@{ allowed=$Allowed; badKey=$BadKey; training=$Training; disabled=$Disabled; nonInteractive=$NonInteractive; shown=$script:Shown; workerErrors=$Events } | ConvertTo-Json -Depth 6 -Compress",
  ].join("\r\n"), "utf8");
  return runPs(script);
}

for (const [scenario, status, shown, role] of [
  ["offline", "notice_returned", 1],
  ["online", "notice_offline_unverified", 0],
  ["recovered", "notice_offline_unverified", 0],
  ["unknown", "notice_offline_unverified", 0],
  ["string-status", "notice_offline_unverified", 0],
  ["wrong", "notice_offline_unverified", 0],
  ["late-wrong", "notice_offline_unverified", 0],
  ["zero", "notice_returned", 1],
  ["identity-unavailable", "notice_returned", 1],
  ["offline", "notice_disabled", 0, "training"],
]) {
  test("notice requires approved desktop and a fresh matching offline result: " + (role ?? scenario), { skip: !windows }, async (context) => {
    const fixture = await makeFixture(context, scenario, role);
    if (scenario === "recovered") {
      const prior = await fetch("http://127.0.0.1:" + fixture.port + "/get_status", {
        method: "POST", headers: { authorization: "Bearer test-only-onebot-token" }, body: "{}",
      });
      assert.equal((await prior.json()).data.online, false);
    }
    const { workerErrors, ...outcome } = await runNoticeCase(fixture);
    const fallback = ["zero", "identity-unavailable"].includes(scenario);
    let expectedStatus = status;
    let expectedShown = shown;
    if (fallback && outcome.allowed === "notice_offline_unverified") {
      const observed = await probeNativeOwnership(fixture);
      assert.equal(observed.fixtureOwned, true);
      assert.ok(observed.unknown > 0, JSON.stringify(observed));
      assert.ok(workerErrors.some((error) => error.errorId === "process_identity_unverified"), JSON.stringify(workerErrors));
      expectedStatus = "notice_offline_unverified";
      expectedShown = 0;
      context.diagnostic("Ownership fallback ran and preserved " + observed.unknown + " unknown ambient process(es).");
    }
    assert.deepEqual(outcome, {
      allowed: expectedStatus, badKey: "notice_disabled", training: "notice_disabled",
      disabled: "notice_disabled", nonInteractive: "notice_disabled", shown: expectedShown,
    }, JSON.stringify({ workerErrors, actions: await readFile(fixture.requestLog, "utf8").catch(() => null) }));
    assert.equal(fixture.oneBot.exitCode, null);
  });
}

async function prepareCliConfig(fixture) {
  const script = path.join(fixture.root, "prepare-cli-config.ps1");
  await writeFile(script, [
    "$ErrorActionPreference='Stop'",
    "$ConfigPath=" + ps(fixture.configPath),
    "$Config=ConvertFrom-Json ([IO.File]::ReadAllText($ConfigPath))",
    "$Config | Add-Member computerName ([Environment]::MachineName) -Force",
    "$Config | Add-Member userSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -Force",
    "[IO.File]::WriteAllText($ConfigPath,($Config | ConvertTo-Json -Compress))",
    "@{configured=$true} | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  assert.deepEqual(await runPs(script), { configured: true });
  for (const name of [manualName, guardName, identityName, noticeName]) {
    assert.deepEqual(await readFile(path.join(fixture.fixtureOps, name)), await readFile(path.join(ops, name)));
  }
  return JSON.parse(await readFile(fixture.configPath, "utf8"));
}

async function probeNativeOwnership(fixture) {
  const script = path.join(fixture.root, "probe-native-ownership.ps1");
  await writeFile(script, [
    "$ErrorActionPreference='Stop'",
    ". " + ps(path.join(fixture.fixtureOps, manualName)),
    ". " + ps(path.join(fixture.fixtureOps, identityName)),
    "$Root=Join-Path " + ps(fixture.root) + " 'runtime'",
    "$Snapshot=Get-NapCatQrOwnedSnapshot @{paths=@{napCatRoot=$Root}}",
    "@{unknown=@($Snapshot.unknown).Count;fixtureOwned=(" + fixture.oneBot.pid + " -in @($Snapshot.owned.ProcessId))} | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  return runPs(script);
}

for (const useDeployment of [true, false]) {
  test("r5 exact notice CLI without login_info or GUI: " + (useDeployment ? "deployment" : "minimal"), { skip: !windows }, async (context) => {
    const fixture = await makeFixture(context, "notice-recovered-missing");
    const full = await prepareCliConfig(fixture);
    const inspect = await runPsStatus(path.join(fixture.fixtureOps, manualName), flag("ConfigPath", fixture.configPath));
    const { schemaVersion, machineRole, computerName, userSid, offlineNoticeEnabled, dataRoot, brokerRoot, accountStateDir } = full;
    await json(fixture.configPath, {
      schemaVersion, machineRole, computerName, userSid, offlineNoticeEnabled, dataRoot, brokerRoot,
      ...(useDeployment ? { accountStateDir } : {}),
    });
    const result = await runPs(path.join(fixture.fixtureOps, noticeName), [
      ...flag("ConfigPath", fixture.configPath), ...flag("IncidentKey", "fixture:no-popup"),
    ]);
    const requests = await readFile(fixture.requestLog, "utf8").catch((error) => {
      assert.equal(error.code, "ENOENT");
      return "";
    });
    if (["no_interactive_desktop", "explorer_identity_unverified"].includes(inspect.status)) {
      assert.deepEqual(result, { status: "notice_disabled" });
      assert.equal(requests, "");
      context.skip("The native desktop identity gate precedes the OneBot check: " + inspect.status);
      return;
    }
    assert.equal(inspect.status, "interactive_config_approved");
    assert.deepEqual(result, { status: "notice_offline_unverified" });
    const initial = "/get_status\n/get_login_info\n";
    if (useDeployment && requests === initial) {
      const observed = await probeNativeOwnership(fixture);
      assert.equal(observed.fixtureOwned, true);
      assert.ok(observed.unknown > 0, JSON.stringify(observed));
      context.diagnostic("Native notice stopped at the strict ownership gate: " + observed.unknown + " unknown ambient process(es).");
    } else {
      assert.equal(requests, initial + (useDeployment ? "/get_status\n" : ""));
    }
    assert.equal(fixture.oneBot.exitCode, null);
  });
}

test("r5 exact Start supersession never passes an unproved native Job/desktop or an online target", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "online");
  await prepareCliConfig(fixture);
  const oldId = randomUUID().replaceAll("-", "");
  const setup = path.join(fixture.root, "prepare-cli-supersession.ps1");
  await writeFile(setup, [
    "$ErrorActionPreference='Stop'",
    "$Entry=" + ps(path.join(fixture.fixtureOps, manualName)),
    ". $Entry",
    ". " + ps(path.join(fixture.fixtureOps, guardName)),
    "$ConfigPath=" + ps(fixture.configPath),
    "$File=Read-NapCatQrFile $ConfigPath",
    "$Config=ConvertFrom-NapCatQrFile $File",
    "$Session=[Diagnostics.Process]::GetCurrentProcess()",
    "$Birth=$Session.StartTime.ToFileTimeUtc()",
    "$Parent=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)).ParentProcessId",
    "$Requester=[Diagnostics.Process]::GetProcessById([int]$Parent)",
    "$RequesterBirth=$Requester.StartTime.ToFileTimeUtc()",
    "$Requester.Dispose()",
    "$Id=" + ps(oldId),
    "$Old=Get-NapCatQrRequestDirectory $Id",
    "$Mutex=Get-NapCatOfflineQqMutexName -QqUserDataDir $Config.qqUserDataDir",
    "$Target=Join-Path ([IO.Path]::GetDirectoryName($Old)) ('napcat-manual-target-'+$Mutex.Substring($Mutex.Length-64))",
    "New-NapCatQrRequestDirectory $Old $Config.userSid",
    "New-NapCatQrRequestDirectory $Target $Config.userSid",
    "$At=([DateTimeOffset][DateTime]::FromFileTimeUtc($Birth)).ToUnixTimeMilliseconds()-44998",
    "$Value=@{ schema='napcat.manual-qr/v1'; id=$Id; sid=$Config.userSid; sessionId=[Math]::Max(1,$Session.SessionId); explorerId=[int]$Parent; requesterPid=[int]$Parent; requesterBirth=$RequesterBirth; createdAt=$At; deadlineAt=$At+45000; configPath=$ConfigPath; configSha=$File.sha; bindingSha=(Read-NapCatQrFile (Join-Path $Config.dataRoot 'binding.json')).sha; loginSha=$Config.loginSha256 }",
    "Write-NapCatQrRecord $Old 'request' $Value",
    "$Sha=(Read-NapCatQrFile (Join-Path $Old 'request.json')).sha",
    "$Receipt=@{id=$Id;requestSha256=$Sha}",
    "Write-NapCatQrRecord $Old 'submitted' $Receipt -Claim",
    "Write-NapCatQrRecord $Old 'dispatch' ($Receipt+@{workerPid=$PID;workerBirth=$Birth;parentPid=[int]$Parent})",
    "Write-NapCatQrRecord $Target 'current' @{ id=$Id; sha=$Sha }",
    "@{old=$Old;target=$Target} | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  const { old, target } = await runPs(setup);
  const base = path.resolve(process.env.LOCALAPPDATA, "Temp");
  assert.equal(path.dirname(path.resolve(old)).toLowerCase(), base.toLowerCase());
  assert.equal(path.dirname(path.resolve(target)).toLowerCase(), base.toLowerCase());
  assert.equal(path.basename(old), "napcat-manual-qr-" + oldId);
  assert.match(path.basename(target), /^napcat-manual-target-[A-F0-9]{64}$/);
  context.after(async () => { await rm(old, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); });
  const current = path.join(target, "current.json");
  const before = await readFile(current);
  const result = await runPsStatus(path.join(fixture.fixtureOps, manualName), [
    ...flag("Mode", "Start"), ...flag("ConfigPath", fixture.configPath), ...flag("SupersedeRequestId", oldId),
  ]);
  assert.equal(result.requestId, oldId);
  const gated = ["worker_job_kill_on_close", "worker_job_lifecycle_unverified", "no_interactive_desktop", "explorer_identity_unverified"].includes(result.status);
  assert.equal(result.status === "previous_login_unverified" || gated, true, JSON.stringify(result));
  assert.deepEqual(await readFile(current), before);
  await assert.rejects(readFile(path.join(target, "retired-" + oldId + ".json")), { code: "ENOENT" });
  assert.equal(fixture.oneBot.exitCode, null);
  await assert.rejects(readFile(fixture.readyPath), { code: "ENOENT" });
  if (gated) context.diagnostic("Native Start gate: " + result.status + "; no retirement, launch, or login");
  else assert.equal(await readFile(fixture.requestLog, "utf8"), "/get_status\n");
});

test("r6 stale receipt proof distinguishes absent, ambiguous, live and reused Windows PIDs", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "offline");
  const script = path.join(fixture.root, "retirement-proof.ps1");
  await writeFile(script, [
    "$ErrorActionPreference='Stop'",
    "$Entry=" + ps(path.join(fixture.fixtureOps, manualName)),
    ". $Entry",
    "$Root=" + ps(fixture.root),
    "$Live=[Diagnostics.Process]::GetCurrentProcess()",
    "$LiveBirth=$Live.StartTime.ToFileTimeUtc()",
    "$Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$Desktop=@{sid=$Sid;sessionId=[Math]::Max(1,$Live.SessionId);explorerId=$PID}",
    "Initialize-NapCatQrNative",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class FixtureProcessRights {",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);",
    "  [DllImport(\"kernel32.dll\")] private static extern bool CloseHandle(IntPtr handle);",
    "  [DllImport(\"advapi32.dll\", SetLastError=true)] private static extern bool GetKernelObjectSecurity(IntPtr handle, uint info, byte[] buffer, uint size, out uint required);",
    "  [DllImport(\"advapi32.dll\", SetLastError=true)] private static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, byte[] buffer);",
    "  [DllImport(\"kernel32.dll\")] private static extern IntPtr GetCurrentProcess();",
    "  [DllImport(\"advapi32.dll\", SetLastError=true)] private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);",
    "  [DllImport(\"advapi32.dll\", SetLastError=true, CharSet=CharSet.Unicode)] private static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out long lpLuid);",
    "  [StructLayout(LayoutKind.Sequential, Pack=1)] private struct TokPriv1Luid { public int Count; public long Luid; public int Attr; }",
    "  [DllImport(\"advapi32.dll\", SetLastError=true)] private static extern bool AdjustTokenPrivileges(IntPtr tokenHandle, bool disableAll, ref TokPriv1Luid newState, int bufferLen, IntPtr prevState, IntPtr retLen);",
    "  public static void DisableDebugPrivilege() {",
    "    IntPtr tok; if (!OpenProcessToken(GetCurrentProcess(), 0x0028, out tok)) return;",
    "    try { long luid; if (!LookupPrivilegeValue(null, \"SeDebugPrivilege\", out luid)) return;",
    "      var tp = new TokPriv1Luid { Count = 1, Luid = luid, Attr = 0 }; AdjustTokenPrivileges(tok, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);",
    "    } finally { CloseHandle(tok); }",
    "  }",
    "  public static int OpenError(int processId, uint access) {",
    "    IntPtr handle = OpenProcess(access, false, processId);",
    "    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error();",
    "    CloseHandle(handle); return 0;",
    "  }",
    "  public static byte[] ReadDacl(IntPtr handle) {",
    "    uint length;",
    "    GetKernelObjectSecurity(handle, 4, null, 0, out length);",
    "    if (length == 0) throw new InvalidOperationException(\"GetKernelObjectSecurity failed: \" + Marshal.GetLastWin32Error());",
    "    byte[] bytes = new byte[length];",
    "    if (!GetKernelObjectSecurity(handle, 4, bytes, length, out length)) throw new InvalidOperationException(\"GetKernelObjectSecurity failed: \" + Marshal.GetLastWin32Error());",
    "    return bytes;",
    "  }",
    "  public static void WriteDacl(IntPtr handle, byte[] bytes) {",
    "    if (!SetKernelObjectSecurity(handle, 4, bytes)) throw new InvalidOperationException(\"SetKernelObjectSecurity failed: \" + Marshal.GetLastWin32Error());",
    "  }",
    "}",
    "'@",
    "function New-FixtureDeniedDacl {",
    "  param([byte[]]$Original,[string]$OwnerSid,[int]$Access)",
    "  $Descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Original,0)",
    "  $Ace=[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessDenied,$Access,[Security.Principal.SecurityIdentifier]::new($OwnerSid),$false,[byte[]]$null)",
    "  $Descriptor.DiscretionaryAcl.InsertAce(0,$Ace)",
    "  $Bytes=[byte[]]::new($Descriptor.BinaryLength)",
    "  $Descriptor.GetBinaryForm($Bytes,0)",
    "  return ,$Bytes",
    "}",
    "$ReleasePath=Join-Path $Root 'native-process-release'",
    "$Command='while (-not [IO.File]::Exists(' + [char]39 + $ReleasePath + [char]39 + ')) { Start-Sleep -Milliseconds 80 }'",
    "$Starter=[Diagnostics.ProcessStartInfo]::new((Get-NapCatQrPowerShellExecutable),('" + (isPwsh ? "-NoProfile -NonInteractive -Command " : "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ") + "' + [char]34 + $Command + [char]34))",
    "$Starter.UseShellExecute=$false; $Starter.CreateNoWindow=$true",
    "$Dead=[Diagnostics.Process]::Start($Starter)",
    "try {",
    "  $OwnedChildHandle=$Dead.Handle; $DeadPid=$Dead.Id; $DeadBirth=$Dead.StartTime.ToFileTimeUtc()",
    "  $LiveOriginal=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth)",
    "  $DifferentBirth=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth-1)",
    "  $OriginalDacl=[FixtureProcessRights]::ReadDacl($OwnedChildHandle)",
    "  [FixtureProcessRights]::DisableDebugPrivilege()",
    "  try {",
    "    [FixtureProcessRights]::WriteDacl($OwnedChildHandle,(New-FixtureDeniedDacl $OriginalDacl $Sid 0x00100000))",
    "    $WithoutWait=@{query=[FixtureProcessRights]::OpenError($DeadPid,0x1000);wait=[FixtureProcessRights]::OpenError($DeadPid,0x00101000);same=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth);different=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth-1)}",
    "    [FixtureProcessRights]::WriteDacl($OwnedChildHandle,(New-FixtureDeniedDacl $OriginalDacl $Sid 0x1000))",
    "    $WithoutQuery=@{query=[FixtureProcessRights]::OpenError($DeadPid,0x1000);same=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth);different=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth-1)}",
    "  } finally { [FixtureProcessRights]::WriteDacl($OwnedChildHandle,$OriginalDacl) }",
    "  [IO.File]::WriteAllText($ReleasePath,'exit')",
    "  if (-not $Dead.WaitForExit(5000)) { throw 'fixture_exit_unverified' }",
    "  $ExitedQueryError=[FixtureProcessRights]::OpenError($DeadPid,0x1000)",
    "  $ExitedOriginal=[NapCatQrNative]::WorkerHasExited($DeadPid,$DeadBirth)",
    "} finally { if (-not $Dead.HasExited) { $Dead.Kill(); $null=$Dead.WaitForExit(3000) }; $Dead.Dispose() }",
    "$Now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "$BirthDate=[DateTimeOffset][DateTime]::FromFileTimeUtc($LiveBirth)",
    "$Cases=@('unsubmitted','r4_no_marker','boundary_closed','recent','orphan','ambiguous','live','reused','exited','conflicting','unrecognized_entry')",
    "$Results=@{sameOriginalLive=$LiveOriginal;sameOriginalExited=$ExitedOriginal;exitedQueryError=$ExitedQueryError;differentBirthWhileLive=$DifferentBirth;withoutWait=$WithoutWait;withoutQuery=$WithoutQuery}",
    "foreach ($Case in $Cases) {",
    "  $Id=[Guid]::NewGuid().ToString('N'); $Directory=Get-NapCatQrRequestDirectory $Id $Root; New-NapCatQrRequestDirectory $Directory $Sid",
    "  $At=$Now-60000",
    "  if ($Case -ceq 'recent') { $At=$Now-4000 }",
    "  if ($Case -cin @('live','reused','exited','conflicting')) { $At=$BirthDate.ToUnixTimeMilliseconds()-1000 }",
    "  $Value=@{schema='napcat.manual-qr/v1';id=$Id;sid=$Sid;sessionId=$Desktop.sessionId;explorerId=$PID;requesterPid=$DeadPid;requesterBirth=([DateTimeOffset]::FromUnixTimeMilliseconds($At-100).UtcDateTime.ToFileTimeUtc());createdAt=[long]$At;deadlineAt=[long]($At+45000);entrySha=(Read-NapCatQrFile $Entry 524288).sha;deploymentSha=('1'*64)}",
    "  if ($Case -ceq 'unrecognized_entry') { $Value.entrySha='0'*64 }",
    "  if ($Case -cin @('exited','conflicting')) { $Value.requesterPid=$PID; $Value.requesterBirth=$LiveBirth }",
    "  Write-NapCatQrRecord $Directory 'request' $Value",
    "  $Request=Get-NapCatQrRequest $Directory $Id '' $Desktop",
    "  $Receipt=@{id=$Id;requestSha256=$Request.sha}",
    "  if ($Case -ceq 'orphan') { Write-NapCatQrRecord $Directory 'claim' $Receipt -Claim }",
    "  if ($Case -cin @('ambiguous','live','reused','exited','conflicting')) { Write-NapCatQrRecord $Directory 'submitted' $Receipt -Claim }",
    "  if ($Case -cin @('live','reused','exited','conflicting')) {",
    "    $WorkerPid=if ($Case -cin @('exited','conflicting')) { $DeadPid } else { $PID }",
    "    $WorkerBirth=if ($Case -ceq 'reused') { $LiveBirth-1 } elseif ($Case -cin @('exited','conflicting')) { $DeadBirth } else { $LiveBirth }",
    "    Write-NapCatQrRecord $Directory 'dispatch' ($Receipt+@{workerPid=$WorkerPid;workerBirth=$WorkerBirth;parentPid=$Value.requesterPid})",
    "  }",
    "  $Pointer=@{id=$Id;sha=$Request.sha;phase='prelaunch/v1'}",
    "  if ($Case -ceq 'r4_no_marker') { $Pointer.Remove('phase') }",
    "  if ($Case -cin @('boundary_closed','live','reused','exited')) { $Pointer.phase='launch-boundary-closed/v1' }",
    "  $Proof=Get-NapCatQrRetirementProof $Directory $Request $Pointer -AllowUnsent",
    "  $Results[$Case]=if ($null -ne $Proof) { $Proof.kind } else { 'refused' }",
    "}",
    "$Results | ConvertTo-Json -Depth 4 -Compress",
  ].join("\r\n"), "utf8");
  assert.deepEqual(await runPs(script), {
    sameOriginalLive: false, sameOriginalExited: true, exitedQueryError: 0, differentBirthWhileLive: true,
    withoutWait: { query: 0, wait: 5, same: false, different: true },
    withoutQuery: { query: 5, same: false, different: false },
    unsubmitted: "not_submitted", r4_no_marker: "refused", boundary_closed: "refused",
    recent: "refused", orphan: "refused", ambiguous: "refused", live: "refused", reused: "worker_exited",
    exited: "worker_exited", conflicting: "refused", unrecognized_entry: "refused",
  });
});

test("r5 atomic Replace retries a transient native share lock and rolls back exact bytes", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "offline");
  const holder = path.join(fixture.root, "hold-record.ps1");
  const writer = path.join(fixture.root, "replace-record.ps1");
  const target = path.join(fixture.root, "current.json");
  const ready = path.join(fixture.root, "holder-ready.json");
  const release = path.join(fixture.root, "holder-release.json");
  const oldBytes = Buffer.from('{"id":"old"}');
  await writeFile(target, oldBytes);
  await writeFile(holder, [
    "param([switch]$Transient)",
    "$ErrorActionPreference='Stop'",
    "$Root=" + ps(fixture.root),
    "$Pin=[IO.File]::Open((Join-Path $Root 'current.json'),'Open','Read','Read')",
    "try {",
    "  [IO.File]::WriteAllText((Join-Path $Root 'holder-ready.json'),'true')",
    "  $Timer=[Diagnostics.Stopwatch]::StartNew()",
    "  do {",
    "    if ($Transient -and [IO.Directory]::GetFiles($Root,'*.tmp').Length) { Start-Sleep -Milliseconds 120; break }",
    "    if ([IO.File]::Exists((Join-Path $Root 'holder-release.json'))) { break }",
    "    Start-Sleep -Milliseconds 10",
    "  } while ($Timer.ElapsedMilliseconds -lt 12000)",
    "} finally { $Pin.Dispose() }",
    "@{closed=$true} | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  await writeFile(writer, [
    "param([string]$Value)",
    "$ErrorActionPreference='Stop'",
    ". " + ps(path.join(fixture.fixtureOps, manualName)),
    "$Root=" + ps(fixture.root),
    "try { Write-NapCatQrRecord $Root 'current' @{id=$Value} -Replace; $Status='replaced' }",
    "catch { $Status='locked'; $Failure=$_.Exception.GetBaseException().HResult -band 65535 }",
    "@{status=$Status;failure=$Failure;temps=[IO.Directory]::GetFiles($Root,'*.tmp').Length} | ConvertTo-Json -Compress",
  ].join("\r\n"), "utf8");
  for (const transient of [false, true]) {
    const holding = runPs(holder, transient ? ["-Transient"] : []);
    try {
      assert.equal(await readJsonEventually(ready), true);
      const outcome = await runPs(writer, flag("Value", "new"));
      assert.equal(outcome.status, transient ? "replaced" : "locked", JSON.stringify(outcome));
      assert.equal(outcome.temps, 0);
      assert.deepEqual(await readFile(target), transient ? Buffer.from('{"id":"new"}') : oldBytes);
    } finally {
      await json(release, true);
      assert.deepEqual(await holding, { closed: true });
      await rm(ready);
      await rm(release);
    }
  }
  assert.equal((await runPs(writer, flag("Value", "old"))).status, "replaced");
  assert.deepEqual(await readFile(target), oldBytes);
});

test("New-NapCatQrWorkerStartInfo splits Core zero-Bypass and Desktop Bypass branches", { skip: !windows }, async (context) => {
  const fixture = await makeFixture(context, "offline");
  const script = path.join(fixture.root, "worker-start-info-branches.ps1");
  const entry = path.join(fixture.fixtureOps, manualName);
  const reqId = "a".repeat(32);
  const reqHash = "b".repeat(64);
  await writeFile(script, [
    "$ErrorActionPreference='Stop'",
    ". " + ps(entry),
    "$Entry=" + ps(entry),
    "$Id=" + ps(reqId),
    "$Hash=" + ps(reqHash),
    "[Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference','Bypass','Process')",
    "$Core=New-NapCatQrWorkerStartInfo $Entry $Id $Hash -Edition 'Core'",
    "$Desktop=New-NapCatQrWorkerStartInfo $Entry $Id $Hash -Edition 'Desktop'",
    "$Current=New-NapCatQrWorkerStartInfo $Entry $Id $Hash",
    "Initialize-NapCatQrPowerShell",
    "$AfterInit=[Environment]::GetEnvironmentVariable('PSExecutionPolicyPreference','Process')",
    "$AfterInitPresent=(Test-Path Env:\\PSExecutionPolicyPreference)",
    "@{",
    "  edition=$PSVersionTable.PSEdition;",
    "  afterInit=$AfterInit;",
    "  afterInitPresent=$AfterInitPresent;",
    "  core=@{ file=$Core.FileName; args=$Core.Arguments; cwd=$Core.WorkingDirectory; shell=$Core.UseShellExecute; noWindow=$Core.CreateNoWindow; hasPolicyEnv=$Core.EnvironmentVariables.ContainsKey('PSExecutionPolicyPreference') };",
    "  desktop=@{ file=$Desktop.FileName; args=$Desktop.Arguments; cwd=$Desktop.WorkingDirectory; shell=$Desktop.UseShellExecute; noWindow=$Desktop.CreateNoWindow; hasPolicyEnv=$Desktop.EnvironmentVariables.ContainsKey('PSExecutionPolicyPreference') };",
    "  current=@{ file=$Current.FileName; args=$Current.Arguments };",
    "} | ConvertTo-Json -Depth 5 -Compress",
  ].join("\r\n"), "utf8");
  const observed = await runPs(script);
  assert.equal(observed.afterInit, null);
  assert.equal(observed.afterInitPresent, false);
  assert.equal(path.win32.basename(observed.core.file).toLowerCase(), "pwsh.exe");
  assert.equal(
    observed.core.args,
    `-NoLogo -NoProfile -NonInteractive -STA -File "${entry}" -Mode Worker -RequestId ${reqId} -RequestSha256 ${reqHash}`,
  );
  assert.equal(/executionpolicy|bypass/i.test(observed.core.args), false);
  assert.equal(observed.core.shell, false);
  assert.equal(observed.core.noWindow, true);
  assert.equal(observed.core.hasPolicyEnv, false);

  assert.equal(path.win32.basename(observed.desktop.file).toLowerCase(), "powershell.exe");
  assert.equal(
    observed.desktop.args,
    `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File "${entry}" -Mode Worker -RequestId ${reqId} -RequestSha256 ${reqHash}`,
  );
  assert.equal(observed.desktop.shell, false);
  assert.equal(observed.desktop.noWindow, true);
  assert.equal(observed.desktop.hasPolicyEnv, false);

  const expectedCurrent = observed.edition === "Core" ? observed.core : observed.desktop;
  assert.equal(observed.current.file, expectedCurrent.file);
  assert.equal(observed.current.args, expectedCurrent.args);
});
