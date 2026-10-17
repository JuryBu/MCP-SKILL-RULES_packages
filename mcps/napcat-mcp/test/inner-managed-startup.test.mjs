import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = process.env.NAPCAT_TEST_POWERSHELL ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const resolver = path.join(repository, "ops", "resolve-codex-outer-runtime-startup.ps1");
const entry = path.join(repository, "ops", "start-codex-app-server-proxy.ps1");
const innerEntry = path.join(repository, "ops", "start-codex-model-stream-proxy.ps1");
const innerStatus = path.join(repository, "ops", "get-codex-model-stream-proxy-status.ps1");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-inner-startup-"));
const windowsOnly = { skip: process.platform !== "win32" };
const outputs = [];

function fixture(name) {
  const dataRoot = path.join(root, name);
  const stateRoot = path.join(dataRoot, "state");
  const candidateRoot = path.join(dataRoot, "candidates");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(candidateRoot);
  const profilePath = path.join(stateRoot, "inner profile.json");
  fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, fixtureOnly: true }));
  return { dataRoot, stateRoot, candidateRoot, profilePath,
    configurationPath: path.join(stateRoot, "codex-outer-runtime-startup.json"), capturePath: path.join(dataRoot, "capture.json") };
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function configure(context, overrides = {}) {
  fs.writeFileSync(context.configurationPath, JSON.stringify({ schemaVersion: 1, enabled: true,
    candidateRoot: context.candidateRoot, innerManagedProfilePath: context.profilePath,
    innerManagedProfileSha256: digest(context.profilePath), ...overrides }));
}

function execute(context, script, environment = {}) {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script];
  const result = spawnSync(powershell, args, { cwd: repository, windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, INNER_TEST_ROOT: context.dataRoot, INNER_TEST_RESOLVER: resolver,
      INNER_TEST_ENTRY: entry, INNER_TEST_INNER_ENTRY: innerEntry, INNER_TEST_INNER_STATUS: innerStatus,
      INNER_TEST_CAPTURE: context.capturePath, CODEX_TOOLKIT_NODE_EXE: process.execPath, ...environment } });
  outputs.push({ root: context.dataRoot, command: [powershell, ...args], exitCode: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null });
  fs.writeFileSync(path.join(root, "powershell-results.json"), JSON.stringify(outputs, null, 2));
  return result;
}

const resolveScript = ". $env:INNER_TEST_RESOLVER; Resolve-CodexOuterRuntimeStartup -DataRoot $env:INNER_TEST_ROOT | ConvertTo-Json -Depth 8";
const stubbedEntry = `
$global:InnerMockPid=54321
$global:InnerMockCommand=''
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) [pscustomobject]@{CommandLine=$global:InnerMockCommand} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=$global:InnerMockPid} }
function Invoke-RestMethod { param($Uri,$Headers,$TimeoutSec)
  $hashes=[pscustomobject]@{runner=('a'*64);core=('a'*64);helper=('a'*64);control=('a'*64)}
  if ($Uri.EndsWith('/v1/full-runtime')) { return [pscustomobject]@{ok=$true;instanceId=$global:InnerMockToken;busy=$false;failed=$false;candidateRegistrySha256=$null;selected=[pscustomobject]@{id='original';manifestSha256=$null}} }
  if ($Uri.EndsWith('/v1/inner/status')) { return [pscustomobject]@{ok=$true;ownerId='startup-fixture';nativeSourceId='startup-native';instanceToken=$global:InnerMockToken;selectedWorkerId='worker-one';selectedSourceHashes=$hashes;coordinator=[pscustomobject]@{running=$true;nativeHealthy=$true;workers=@([pscustomobject]@{workerId='worker-one';alive=$true;sourceHashes=$hashes})}} }
  throw 'STUB_CONTROL_UNAVAILABLE'
}
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
  $global:InnerMockCommand=$ArgumentList
  $tokenMatch=[regex]::Match($ArgumentList,'"--instance-token"\\s+"([^"]+)"')
  $token=if($tokenMatch.Success){$tokenMatch.Groups[1].Value}else{'fixture-token'}
  $global:InnerMockToken=$token
  $profile=Get-Content -LiteralPath (Join-Path $env:INNER_TEST_ROOT 'state/inner profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($profile.managedStatePath) { [pscustomobject]@{state='running';pid=$global:InnerMockPid;instanceToken=$token;ownerId=$profile.ownerId;nativeSourceId=$profile.nativeSourceId;livenessAt=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $profile.managedStatePath -Encoding UTF8 }
  [pscustomobject]@{argumentLine=$ArgumentList;token=$token;windowStyle=$WindowStyle} | ConvertTo-Json | Set-Content -LiteralPath $env:INNER_TEST_CAPTURE -Encoding UTF8
  [pscustomobject]@{state='running';pid=$global:InnerMockPid;instanceToken=$token;proxy=[pscustomobject]@{outerRuntime=[pscustomobject]@{enabled=$true;instanceId=$token}}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $env:INNER_TEST_ROOT 'state\\codex-app-server-proxy-runtime.json') -Encoding UTF8
  [pscustomobject]@{pid=$global:InnerMockPid;token=$token} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:INNER_TEST_ROOT 'state\\codex-app-server-proxy.lock') -Encoding UTF8
  [pscustomobject]@{Id=$global:InnerMockPid;HasExited=$false;StartTime=[DateTime]::UtcNow;Handle=0}
}
& $env:INNER_TEST_ENTRY -DataRoot $env:INNER_TEST_ROOT -DownstreamPort 41432 -ControlPort 41431 -UpstreamPort 41433 -ProbePort 41434 -StartTimeoutMs 1000 -StartupTimeoutSeconds 30
`;

test("managed profile remains absent for the existing startup configuration", windowsOnly, () => {
  const context = fixture("omitted");
  fs.writeFileSync(context.configurationPath, JSON.stringify({ schemaVersion: 1, enabled: true, candidateRoot: context.candidateRoot }));
  const result = execute(context, resolveScript);
  assert.equal(result.status, 0, result.stderr);
  const configuration = JSON.parse(result.stdout);
  assert.equal(configuration.innerManagedProfilePath, null);
  assert.equal(configuration.innerManagedProfileSha256, null);
});

test("managed profile validates its paired absolute path and bytes", windowsOnly, () => {
  const context = fixture("paired");
  configure(context);
  const result = execute(context, resolveScript);
  assert.equal(result.status, 0, result.stderr);
  const configuration = JSON.parse(result.stdout);
  assert.equal(configuration.innerManagedProfilePath, context.profilePath);
  assert.equal(configuration.innerManagedProfileSha256, digest(context.profilePath));
});

test("managed startup rejects either missing half of the profile binding", windowsOnly, () => {
  for (const missing of ["innerManagedProfilePath", "innerManagedProfileSha256"]) {
    const context = fixture(`missing-${missing}`);
    configure(context);
    const configuration = JSON.parse(fs.readFileSync(context.configurationPath, "utf8"));
    delete configuration[missing];
    fs.writeFileSync(context.configurationPath, JSON.stringify(configuration));
    const result = execute(context, resolveScript);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INNER_STARTUP_PROFILE_BINDING_REQUIRED/u);
  }
});

test("managed startup rejects byte drift and a profile outside the state root", windowsOnly, () => {
  const changed = fixture("changed");
  configure(changed);
  fs.appendFileSync(changed.profilePath, " ");
  const drift = execute(changed, resolveScript);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /INNER_STARTUP_PROFILE_HASH_MISMATCH/u);
  const escaped = fixture("escaped");
  const externalProfile = path.join(escaped.dataRoot, "external.json");
  fs.copyFileSync(escaped.profilePath, externalProfile);
  configure(escaped, { innerManagedProfilePath: externalProfile, innerManagedProfileSha256: digest(externalProfile) });
  const escape = execute(escaped, resolveScript);
  assert.notEqual(escape.status, 0);
  assert.match(escape.stderr, /INNER_STARTUP_PROFILE_OUTSIDE_STATE_ROOT/u);
});

test("managed startup keeps an existing stop requirement before dispatch", windowsOnly, () => {
  const context = fixture("stop");
  configure(context);
  const stopPath = path.join(context.stateRoot, "codex-app-server-proxy.stop");
  fs.writeFileSync(stopPath, "foreign-stop-requirement");
  const result = execute(context, stubbedEntry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXISTING_STOP_REQUIREMENT_PRESERVED/u);
  assert.equal(fs.readFileSync(stopPath, "utf8"), "foreign-stop-requirement");
  assert.equal(fs.existsSync(context.capturePath), false);
});

test("normal managed startup dispatch binds the profile and generates a fresh launch each time", windowsOnly, () => {
  const tokens = [];
  for (const attempt of ["first", "second"]) {
    const context = fixture(`dispatch-${attempt}`);
    configureManaged(context);
    const result = execute(context, stubbedEntry);
    assert.equal(result.status, 0, result.stderr);
    const capture = JSON.parse(fs.readFileSync(context.capturePath, "utf8").replace(/^\uFEFF/u, ""));
    assert.equal(capture.windowStyle, "Hidden");
    assert.ok(capture.argumentLine.includes(`"--inner-managed-profile" "${context.profilePath}"`));
    assert.ok(capture.argumentLine.includes(`"--inner-managed-profile-sha256" "${digest(context.profilePath)}"`));
    assert.match(capture.token, /^[a-f0-9-]{36}$/u);
    const receipt = /"--launch-receipt"\s+"([^"]+)"/u.exec(capture.argumentLine)?.[1];
    assert.ok(receipt);
    assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).instanceToken, capture.token);
    assert.equal(fs.existsSync(`${receipt}.ready`), true);
    tokens.push(capture.token);
    const startup = JSON.parse(result.stdout).outerRuntimeStartup;
    assert.equal(startup.loadedInnerManagedProfilePath, context.profilePath);
    assert.equal(startup.configurationMatchesRunning, true);
  }
  assert.notEqual(tokens[0], tokens[1]);
});

function configureManaged(context) {
  const tokenPath = path.join(context.stateRoot, "codex-app-server-proxy-token.txt");
  fs.writeFileSync(tokenPath, "owned-status-fixture-token");
  const profile = { schemaVersion: 1, mode: "production", ownerId: "startup-fixture", nativeSourceId: "startup-native",
    initial: { expectedHashes: Object.fromEntries(["runner", "core", "helper", "control"].map(name => [name, "a".repeat(64)])) },
    innerPort: 41435, upstreamOrigin: "http://127.0.0.1:41436", stateRoot: path.join(context.stateRoot, "inner-managed"),
    managedStatePath: path.join(context.stateRoot, "inner-managed", "managed-runtime.json"),
    ports: { inner: 41435, downstream: 41432, control: 41431, upstream: 41433, probe: 41434 },
    outerPaths: { tokenFilePath: tokenPath }, controlTokenSha256: digest(tokenPath) };
  fs.mkdirSync(profile.stateRoot);
  fs.writeFileSync(context.profilePath, JSON.stringify(profile));
  configure(context);
  return profile;
}

const stubbedInnerEntry = stubbedEntry.slice(0, stubbedEntry.lastIndexOf("& $env:INNER_TEST_ENTRY"))
  + "& $env:INNER_TEST_INNER_ENTRY -DataRoot $env:INNER_TEST_ROOT";

test("normal inner startup delegates a bound managed profile instead of spawning the legacy worker", windowsOnly, () => {
  const context = fixture("inner-delegate");
  configureManaged(context);
  const result = execute(context, stubbedInnerEntry);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.mode, "managed");
  assert.equal(value.endpoint, "http://127.0.0.1:41435");
  const capture = JSON.parse(fs.readFileSync(context.capturePath, "utf8").replace(/^\uFEFF/u, ""));
  assert.ok(capture.argumentLine.includes("codex-app-server-proxy-runner.mjs"));
  assert.equal(capture.argumentLine.includes("codex-model-stream-proxy-runner.mjs"), false);
});

test("inner startup preserves a foreign inner stop requirement without dispatch", windowsOnly, () => {
  const context = fixture("inner-stop");
  configureManaged(context);
  const stopPath = path.join(context.stateRoot, "codex-model-stream-proxy.stop");
  fs.writeFileSync(stopPath, "foreign-inner-stop");
  const result = execute(context, stubbedInnerEntry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INNER_MANAGED_EXISTING_STOP_REQUIREMENT_PRESERVED/u);
  assert.equal(fs.readFileSync(stopPath, "utf8"), "foreign-inner-stop");
  assert.equal(fs.existsSync(context.capturePath), false);
});

test("inner startup rejects an explicit legacy port that conflicts with the bound profile", windowsOnly, () => {
  const context = fixture("inner-port-drift");
  configureManaged(context);
  const result = execute(context, stubbedInnerEntry + " -Port 42435");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INNER_MANAGED_REQUESTED_PORT_MISMATCH/u);
  assert.equal(fs.existsSync(context.capturePath), false);
});

test("managed inner status requires actual manager identity, fresh publication and authenticated control health", windowsOnly, () => {
  for (const scenario of ["healthy", "stale", "wrong-command", "wrong-token", "wrong-control-instance", "dead-worker"]) {
    const context = fixture(`inner-status-${scenario}`);
    const profile = configureManaged(context);
    fs.writeFileSync(profile.managedStatePath, JSON.stringify({ schemaVersion: 1, state: "running",
      ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, pid: 98765, instanceToken: "fixture-instance",
      livenessAt: new Date(Date.now() - (scenario === "stale" ? 60000 : 0)).toISOString(),
      front: { pid: 98765, host: "127.0.0.1", port: profile.ports.inner }, coordinator: { defaultWorkerId: "worker-one" } }));
    const commandLine = scenario === "wrong-command" ? "foreign-process" : `"${path.join(repository, "src", "codex-app-server-proxy-runner.mjs")}" "--inner-managed-profile" "${context.profilePath}" "--instance-token" "fixture-instance"`;
    if (scenario === "wrong-token") fs.writeFileSync(profile.outerPaths.tokenFilePath, "foreign-token");
    const result = execute(context, `
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) [pscustomobject]@{CommandLine=$env:INNER_TEST_PROCESS_COMMAND} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=98765} }
function Invoke-RestMethod {
  param($Uri,$Headers,$TimeoutSec)
  if ($Uri -cne 'http://127.0.0.1:41431/v1/inner/status' -or $Headers.Authorization -cne 'Bearer owned-status-fixture-token' -or $Headers['x-inner-owner-id'] -cne 'startup-fixture' -or $Headers['x-inner-native-source-id'] -cne 'startup-native' -or $Headers['x-inner-instance-token'] -cne 'fixture-instance') { throw 'EXACT_AUTHENTICATED_CONTROL_REQUIRED' }
  [pscustomobject]@{ok=$true;ownerId='startup-fixture';nativeSourceId='startup-native';instanceToken=$(if($env:INNER_TEST_STATUS_SCENARIO -eq 'wrong-control-instance'){'foreign-instance'}else{'fixture-instance'});selectedWorkerId='worker-one';
    coordinator=[pscustomobject]@{running=$true;nativeHealthy=$true;threads=@([pscustomobject]@{activeHttp=0});workers=@([pscustomobject]@{workerId='worker-one';alive=($env:INNER_TEST_STATUS_SCENARIO -ne 'dead-worker')})}}
}
& $env:INNER_TEST_INNER_STATUS -DataRoot $env:INNER_TEST_ROOT
`, { INNER_TEST_PROCESS_COMMAND: commandLine, INNER_TEST_STATUS_SCENARIO: scenario });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.healthy, scenario === "healthy");
    assert.equal(status.running, scenario !== "wrong-command");
    assert.equal(status.selectedWorkerId, "worker-one");
  }
});

test("unconfigured legacy status remains read-only and reports its original missing runtime", windowsOnly, () => {
  const context = fixture("legacy-status");
  const result = execute(context, "& $env:INNER_TEST_INNER_STATUS -DataRoot $env:INNER_TEST_ROOT");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, "runtime_state_missing");
  assert.equal(fs.existsSync(path.join(context.stateRoot, "codex-model-stream-proxy-runtime.json")), false);
});
