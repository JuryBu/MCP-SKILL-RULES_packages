import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const entry = path.join(repository, "ops", "start-codex-app-server-proxy.ps1");
const resolver = path.join(repository, "ops", "resolve-codex-outer-runtime-startup.ps1");
const evidenceParent = path.join(os.tmpdir(), "napcat-hot-switch-20261010", "outer-startup-0440");
const windowsOnly = { skip: process.platform !== "win32" };
const records = [];
let attemptRoot;

function fixture(name) {
  if (!attemptRoot) {
    fs.mkdirSync(evidenceParent, { recursive: true });
    attemptRoot = fs.mkdtempSync(path.join(evidenceParent, "unit-"));
  }
  const dataRoot = path.join(attemptRoot, name);
  const stateRoot = path.join(dataRoot, "state");
  const candidateRoot = path.join(dataRoot, "business candidates");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(candidateRoot);
  return {
    dataRoot, stateRoot, candidateRoot,
    configurationPath: path.join(stateRoot, "codex-outer-runtime-startup.json"),
    stopPath: path.join(stateRoot, "codex-app-server-proxy.stop"),
    capturePath: path.join(dataRoot, "dispatch.json"),
  };
}

function configure(context, overrides = {}) {
  fs.writeFileSync(context.configurationPath, JSON.stringify({ schemaVersion: 1, enabled: true, candidateRoot: context.candidateRoot, ...overrides }));
}

function execute(name, script, context, extraEnv = {}) {
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$OutputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=$OutputEncoding;" + script];
  const result = spawnSync(powershell, args, {
    cwd: repository, windowsHide: true, encoding: "utf8", timeout: 25000,
    env: { ...process.env, OUTER_TEST_ROOT: context.dataRoot, OUTER_TEST_ENTRY: entry, OUTER_TEST_RESOLVER: resolver,
      OUTER_TEST_CAPTURE: context.capturePath, CODEX_TOOLKIT_NODE_EXE: process.execPath, ...extraEnv },
  });
  records.push({ name, command: [powershell, ...args], exitCode: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr });
  fs.writeFileSync(path.join(attemptRoot, "powershell-results.json"), JSON.stringify(records, null, 2));
  return result;
}

const resolveScript = "$ErrorActionPreference='Stop'; . $env:OUTER_TEST_RESOLVER; Resolve-CodexOuterRuntimeStartup -DataRoot $env:OUTER_TEST_ROOT | ConvertTo-Json -Depth 8";
const stubbedEntry = `
$ErrorActionPreference='Stop'
$global:OuterTestMockPid=54321
$global:OuterTestMockCommand='node "codex-app-server-proxy-runner.mjs" "--runtime-state" "'+(Join-Path $env:OUTER_TEST_ROOT 'state\\codex-app-server-proxy-runtime.json')+'" "--lock" "'+(Join-Path $env:OUTER_TEST_ROOT 'state\\codex-app-server-proxy.lock')+'"'
if ($env:OUTER_TEST_EXISTING_ROOT) { $global:OuterTestMockCommand += ' "--outer-runtime-root" "'+$env:OUTER_TEST_EXISTING_ROOT+'"' }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) [pscustomobject]@{CommandLine=$global:OuterTestMockCommand} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=$global:OuterTestMockPid} }
function Invoke-RestMethod { param($Uri,$Headers,$TimeoutSec)
  if ($env:OUTER_TEST_HEALTH_MODE -eq 'unavailable') { throw 'OWNED_CONTROL_UNAVAILABLE' }
  $instanceId=if($env:OUTER_TEST_HEALTH_MODE -eq 'wrong-instance'){'different-instance'}else{'isolated-token'}
  [pscustomobject]@{closed=$false;outerRuntime=[pscustomobject]@{enabled=$global:OuterTestMockCommand.Contains('--outer-runtime-root');instanceId=$instanceId;version='live-engine'}}
}
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
  if ($env:OUTER_TEST_ALREADY_RUNNING) { throw 'EXISTING_SERVICE_RESTART_ATTEMPTED' }
  [pscustomobject]@{filePath=$FilePath;argumentLine=$ArgumentList;windowStyle=$WindowStyle} | ConvertTo-Json | Set-Content -LiteralPath $env:OUTER_TEST_CAPTURE -Encoding UTF8
  $global:OuterTestMockCommand=$ArgumentList
  $enabled=$ArgumentList.Contains('--outer-runtime-root')
  [pscustomobject]@{state='running';pid=$global:OuterTestMockPid;instanceToken='isolated-token';proxy=[pscustomobject]@{outerRuntime=[pscustomobject]@{enabled=$enabled;instanceId='isolated-token';version='fixture-engine'}}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $env:OUTER_TEST_ROOT 'state\\codex-app-server-proxy-runtime.json') -Encoding UTF8
  [pscustomobject]@{pid=$global:OuterTestMockPid;token='isolated-token'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:OUTER_TEST_ROOT 'state\\codex-app-server-proxy.lock') -Encoding UTF8
  [pscustomobject]@{Id=$global:OuterTestMockPid;HasExited=$false}
}
$parameters=@{DataRoot=$env:OUTER_TEST_ROOT;DownstreamPort=41432;ControlPort=41431;UpstreamPort=41433;ProbePort=41434;StartTimeoutMs=1000;StartupTimeoutSeconds=30}
if ($env:OUTER_TEST_REQUIRE_STOP) {$parameters.RequireNoStopMarker=$true}
if ($env:OUTER_TEST_EXE) {$parameters.CodexExecutablePath=$env:OUTER_TEST_EXE}
if ($env:OUTER_TEST_METADATA) {$parameters.RequestMetadataEnabled=($env:OUTER_TEST_METADATA -eq 'true')}
& $env:OUTER_TEST_ENTRY @parameters
`;

function jsonOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
}

test("Windows PowerShell 5.1 resolves absent, enabled and disabled startup files without writing", windowsOnly, () => {
  for (const name of ["absent", "enabled", "disabled"]) {
    const context = fixture(name);
    if (name !== "absent") configure(context, { enabled: name === "enabled" });
    const before = fs.existsSync(context.configurationPath) ? fs.readFileSync(context.configurationPath) : null;
    const output = jsonOutput(execute(name, resolveScript, context));
    assert.equal(output.configured, name !== "absent");
    assert.equal(output.enabled, name === "enabled");
    assert.equal(output.candidateRoot, name === "absent" ? null : context.candidateRoot);
    if (before) assert.deepEqual(fs.readFileSync(context.configurationPath), before);
    assert.deepEqual(fs.readdirSync(context.stateRoot), name === "absent" ? [] : ["codex-outer-runtime-startup.json"]);
  }
  const context = fixture("powershell-version");
  const result = execute("powershell-version", "$PSVersionTable.PSVersion.ToString()", context);
  assert.match(result.stdout, /^5\.1\./);
});

test("invalid schema, malformed files and lexical escapes fail before removing an existing stop marker", windowsOnly, () => {
  const cases = [
    ["bad-json", "{broken", "INVALID_JSON"],
    ["array", "[]", "INVALID_JSON"],
    ["null", "null", "INVALID_JSON"],
    ["wrong-version", { schemaVersion: 2 }, "INVALID_SCHEMA"],
    ["string-version", { schemaVersion: "1" }, "INVALID_SCHEMA"],
    ["string-enabled", { enabled: "false" }, "INVALID_SCHEMA"],
    ["missing-root", { candidateRoot: null }, "INVALID_SCHEMA"],
    ["relative", { candidateRoot: "business candidates" }, "NOT_ABSOLUTE"],
    ["drive-relative", { candidateRoot: "C:business" }, "NOT_ABSOLUTE"],
    ["root-relative", { candidateRoot: "\\business" }, "NOT_ABSOLUTE"],
    ["outside", context => ({ candidateRoot: attemptRoot }), "OUTSIDE_DATA_ROOT"],
    ["prefix-sibling", context => ({ candidateRoot: `${context.dataRoot}-other` }), "OUTSIDE_DATA_ROOT"],
    ["traversal", context => ({ candidateRoot: path.join(context.dataRoot, "..", "absent", "business candidates") }), "OUTSIDE_DATA_ROOT"],
    ["absent-directory", context => ({ candidateRoot: path.join(context.dataRoot, "missing") }), "NOT_DIRECTORY"],
    ["leaf", context => ({ candidateRoot: context.stopPath }), "NOT_DIRECTORY"],
    ["disabled-invalid", { enabled: false, candidateRoot: "relative" }, "NOT_ABSOLUTE"],
    ["device-path", context => ({ candidateRoot: `\\\\?\\${context.candidateRoot}` }), "PATH_INVALID"],
  ];
  for (const [name, value, expected] of cases) {
    const context = fixture(name);
    const stop = Buffer.from(`owner=independent;case=${name}`);
    fs.writeFileSync(context.stopPath, stop);
    if (typeof value === "string") fs.writeFileSync(context.configurationPath, value);
    else configure(context, typeof value === "function" ? value(context) : value);
    const result = execute(name, stubbedEntry, context);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, new RegExp(`OUTER_STARTUP_.*${expected}`), name);
    assert.deepEqual(fs.readFileSync(context.stopPath), stop, name);
    assert.equal(fs.existsSync(context.capturePath), false, name);
    assert.equal(fs.existsSync(path.join(context.stateRoot, "codex-app-server-proxy-runtime.json")), false, name);
    assert.equal(fs.existsSync(path.join(context.dataRoot, "missing")), false, name);
  }
});

test("configuration files and candidate directory junctions cannot escape DataRoot", windowsOnly, () => {
  for (const kind of ["candidate", "ancestor", "configuration-directory"]) {
    const context = fixture(`junction-${kind}`);
    const outside = path.join(attemptRoot, `outside-${kind}`);
    fs.mkdirSync(outside);
    const link = path.join(context.dataRoot, "junction");
    fs.symlinkSync(outside, link, "junction");
    if (kind === "candidate") configure(context, { candidateRoot: link });
    if (kind === "ancestor") {
      fs.mkdirSync(path.join(outside, "child"));
      configure(context, { candidateRoot: path.join(link, "child") });
    }
    if (kind === "configuration-directory") {
      fs.rmdirSync(context.stateRoot);
      fs.symlinkSync(outside, context.stateRoot, "junction");
      configure(context);
    }
    fs.writeFileSync(context.stopPath, "independent-stop");
    const result = execute(kind, stubbedEntry, context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OUTER_STARTUP_REPARSE_POINT/);
    assert.equal(fs.readFileSync(context.stopPath, "utf8"), "independent-stop");
    assert.equal(fs.existsSync(context.capturePath), false);
    fs.unlinkSync(link);
    if (kind === "configuration-directory") fs.unlinkSync(context.stateRoot);
  }
});

test("original Windows entry keeps metadata disabled unless explicitly requested", windowsOnly, () => {
  for (const value of ["", "false", "true"]) {
    const context = fixture(`metadata-${value || "absent"}`);
    const output = jsonOutput(execute(`metadata-${value || "absent"}`, stubbedEntry, context, { OUTER_TEST_METADATA: value }));
    const capture = JSON.parse(fs.readFileSync(context.capturePath, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(capture.argumentLine.includes("--request-metadata-enabled"), value === "true");
    if (value === "true") assert.match(capture.argumentLine, /"--request-metadata-enabled" "true"/);
    assert.equal(output.state, "running");
    assert.equal(capture.windowStyle, "Hidden");
  }
});

test("original entry preserves Node, ports, budgets and opt-in dispatch", windowsOnly, () => {
  for (const name of ["dispatch-absent", "dispatch-enabled", "dispatch-disabled"]) {
    const context = fixture(name);
    if (name !== "dispatch-absent") configure(context, { enabled: name === "dispatch-enabled" });
    const result = jsonOutput(execute(name, stubbedEntry, context, name === "dispatch-enabled" ? { OUTER_TEST_EXE: powershell } : {}));
    const capture = JSON.parse(fs.readFileSync(context.capturePath, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(capture.filePath.toLowerCase(), process.execPath.toLowerCase());
    assert.equal(capture.windowStyle, "Hidden");
    for (const [option, value] of Object.entries({ "downstream-port": 41432, "control-port": 41431, "upstream-port": 41433,
      "probe-port": 41434, "start-timeout-ms": 1000, "startup-budget-ms": 15000, "resume-timeout-ms": 120000 })) {
      assert.ok(capture.argumentLine.includes(`"--${option}" "${value}"`), option);
    }
    assert.equal(capture.argumentLine.includes('"--outer-runtime-root"'), name === "dispatch-enabled");
    assert.equal(capture.argumentLine.includes('"--codex-exe"'), name === "dispatch-enabled");
    if (name === "dispatch-enabled") assert.ok(capture.argumentLine.includes(`"${context.candidateRoot}"`));
    assert.equal(result.started, true);
    assert.equal(result.outerRuntimeStartup.appliedByThisStart, name !== "dispatch-absent");
    assert.equal(result.outerRuntimeStartup.configurationMatchesRunning, true);
  }
});

test("RequireNoStopMarker and invalid explicit executable leave the stop requirement unchanged", windowsOnly, () => {
  for (const name of ["require-stop", "relative-exe", "missing-exe"]) {
    const context = fixture(name);
    configure(context);
    fs.writeFileSync(context.stopPath, "preserved-owned-stop");
    const extraEnv = name === "require-stop" ? { OUTER_TEST_REQUIRE_STOP: "1" }
      : { OUTER_TEST_EXE: name === "relative-exe" ? "codex.exe" : path.join(context.dataRoot, "missing.exe") };
    const result = execute(name, stubbedEntry, context, extraEnv);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, name === "require-stop" ? /EXISTING_STOP_REQUIREMENT_PRESERVED/ : /Codex executable|CodexExecutablePath/);
    assert.equal(fs.readFileSync(context.stopPath, "utf8"), "preserved-owned-stop");
    assert.equal(fs.existsSync(context.capturePath), false);
  }
});

test("already-running reports live configuration separately and never restarts the existing service", windowsOnly, () => {
  for (const name of ["already-matching", "already-mismatched", "already-disable-request"]) {
    const context = fixture(name);
    configure(context, { enabled: name !== "already-disable-request" });
    const loadedRoot = name === "already-mismatched" ? path.join(context.dataRoot, "previous") : context.candidateRoot;
    fs.writeFileSync(path.join(context.stateRoot, "codex-app-server-proxy-runtime.json"), JSON.stringify({
      state: "running", pid: 54321, instanceToken: "isolated-token", proxy: { outerRuntime: { enabled: true, instanceId: "isolated-token", version: "stale-snapshot" } },
    }));
    fs.writeFileSync(path.join(context.stateRoot, "codex-app-server-proxy.lock"), JSON.stringify({ pid: 54321, token: "isolated-token" }));
    fs.writeFileSync(path.join(context.stateRoot, "codex-app-server-proxy-token.txt"), "isolated-control-token");
    fs.writeFileSync(context.stopPath, "existing-stop-kept");
    const output = jsonOutput(execute(name, stubbedEntry, context, { OUTER_TEST_ALREADY_RUNNING: "1", OUTER_TEST_EXISTING_ROOT: loadedRoot }));
    assert.equal(output.started, false);
    assert.equal(output.reason, "already_running");
    assert.equal(output.outerRuntimeStartup.appliedByThisStart, false);
    assert.equal(output.outerRuntimeStartup.loadedCandidateRoot, loadedRoot);
    assert.equal(output.outerRuntimeStartup.runningStatusSource, "control_status");
    assert.equal(output.outerRuntimeStartup.runningOuterRuntime.version, "live-engine");
    assert.equal(output.outerRuntimeStartup.configurationMatchesRunning, name === "already-matching");
    assert.equal(output.outerRuntimeStartup.restartRequired, name !== "already-matching");
    assert.equal(fs.readFileSync(context.stopPath, "utf8"), "existing-stop-kept");
    assert.equal(fs.existsSync(context.capturePath), false);
  }
});

test("unavailable or unrelated control health remains explicitly a runtime snapshot", windowsOnly, () => {
  for (const name of ["unavailable", "wrong-instance", "unknown-runtime-fields"]) {
    const context = fixture(`health-${name}`);
    configure(context);
    fs.writeFileSync(path.join(context.stateRoot, "codex-app-server-proxy-runtime.json"), JSON.stringify({
      state: "running", pid: 54321, instanceToken: "isolated-token",
      ...(name === "unknown-runtime-fields" ? {} : { proxy: { outerRuntime: { enabled: true, instanceId: "isolated-token", version: "saved-engine" } } }),
    }));
    fs.writeFileSync(path.join(context.stateRoot, "codex-app-server-proxy.lock"), JSON.stringify({ pid: 54321, token: "isolated-token" }));
    fs.writeFileSync(path.join(context.stateRoot, "codex-app-server-proxy-token.txt"), "isolated-control-token");
    const output = jsonOutput(execute(name, stubbedEntry, context, { OUTER_TEST_ALREADY_RUNNING: "1",
      OUTER_TEST_EXISTING_ROOT: context.candidateRoot, OUTER_TEST_HEALTH_MODE: name === "unknown-runtime-fields" ? "unavailable" : name }));
    assert.equal(output.started, false);
    assert.equal(output.outerRuntimeStartup.appliedByThisStart, false);
    assert.equal(fs.existsSync(context.capturePath), false);
    if (name === "unknown-runtime-fields") {
      assert.equal(output.outerRuntimeStartup.runningStatusSource, "unavailable");
      assert.equal(output.outerRuntimeStartup.configurationMatchesRunning, null);
      assert.equal(output.outerRuntimeStartup.restartRequired, null);
    } else {
      assert.equal(output.outerRuntimeStartup.runningStatusSource, "runtime_state");
      assert.equal(output.outerRuntimeStartup.runningOuterRuntime.version, "saved-engine");
    }
  }
});

test("configuration directories and singleton JSON arrays fail before all startup side effects", windowsOnly, () => {
  for (const name of ["config-directory", "singleton-array"]) {
    const context = fixture(name);
    fs.writeFileSync(context.stopPath, "preserved-stop");
    if (name === "config-directory") fs.mkdirSync(context.configurationPath);
    else fs.writeFileSync(context.configurationPath, JSON.stringify([{ schemaVersion: 1, enabled: true, candidateRoot: context.candidateRoot }]));
    const result = execute(name, stubbedEntry, context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, name === "config-directory" ? /OUTER_STARTUP_CONFIG_NOT_FILE/ : /OUTER_STARTUP_CONFIG_INVALID_JSON/);
    assert.equal(fs.readFileSync(context.stopPath, "utf8"), "preserved-stop");
    assert.equal(fs.existsSync(context.capturePath), false);
  }
});
