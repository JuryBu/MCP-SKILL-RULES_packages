import { createTrainingTemporaryDirectory } from "./training-temporary-directory.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { planInnerStartupRecovery, applyInnerStartupRecovery } from "../src/inner-startup-residual-recovery.mjs";
import { readInnerRuntimeProfile } from "../src/inner-runtime-profile.mjs";
import { parseArguments } from "../src/codex-app-server-proxy-runner.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = createTrainingTemporaryDirectory(path.join(os.tmpdir(), "ncr-owned-"));
const native = path.join(repository, "test", "inner-startup-residual-native.mjs");
const entry = path.join(repository, "ops", "start-codex-app-server-proxy.ps1");
const powershell = process.env.NAPCAT_TEST_POWERSHELL ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const evidence = [];
let base;

function generate() {
  const target = path.join(root, "old state");
  fs.mkdirSync(target);
  const result = spawnSync(process.execPath, [native, target], { encoding: "utf8", windowsHide: true, timeout: 25000 });
  evidence.push({ command: [process.execPath, native, target], status: result.status, stderr: result.stderr, stdout: result.stdout });
  assert.equal(result.status, 0, result.stderr);
  base = JSON.parse(fs.readFileSync(path.join(target, "native-evidence.json")));
  return base;
}

function shell(input, mode, continuation = "", executable = powershell) {
  const script = "$ErrorActionPreference='Stop';" + continuation + " & $env:RESIDUAL_ENTRY -DataRoot $env:RESIDUAL_ROOT -DownstreamPort " + input.ports.downstream
    + " -ControlPort " + input.ports.control + " -UpstreamPort " + input.ports.upstream + " -ProbePort " + input.ports.probe
    + " -StartTimeoutMs 1000 -StartupTimeoutSeconds 30 -StartupRecoveryMode " + mode;
  const result = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: repository, encoding: "utf8", windowsHide: true, timeout: 60000,
    env: { ...process.env, RESIDUAL_ENTRY: entry, RESIDUAL_ROOT: input.dataRoot, CODEX_TOOLKIT_NODE_EXE: process.execPath } });
  evidence.push({ command: [executable, "-Command", script], status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  return result;
}

const emptyHost = () => ({ complete: true, processes: [], listeners: [] });
const mutate = (target, modify) => {
  const saved = fs.readFileSync(target);
  const value = JSON.parse(saved);
  modify(value);
  fs.writeFileSync(target, JSON.stringify(value));
  return () => fs.writeFileSync(target, saved);
};

test("native old instance is rejected by the original profile gate; Plan traverses normal entry without changes", { skip: process.platform !== "win32" }, () => {
  const input = generate();
  const profile = JSON.parse(fs.readFileSync(input.profilePath));
  const options = parseArguments(["--runtime-state", profile.outerPaths.runtimeStatePath, "--log", profile.outerPaths.logPath,
    "--stop-file", profile.outerPaths.stopFilePath, "--lock", profile.outerPaths.lockPath, "--journal", profile.outerPaths.journalPath,
    "--token-file", profile.outerPaths.tokenFilePath, "--maintenance-file", profile.outerPaths.maintenanceFilePath,
    "--alert-file", profile.outerPaths.alertFilePath, "--fallback-file", profile.outerPaths.fallbackFilePath,
    "--instance-token", "11111111-1111-4111-8111-111111111111", "--launch-receipt", path.join(input.dataRoot, "new-launch.json"),
    ...Object.entries(input.ports).flatMap(([name, port]) => [`--${name}-port`, String(port)])]);
  assert.throws(() => readInnerRuntimeProfile(input.profilePath, { options }), /EXISTING_LEASE/u);
  const before = [profile.outerPaths.runtimeStatePath, profile.outerPaths.lockPath, profile.managedStatePath].map(target => fs.readFileSync(target));
  const result = shell(input, "Plan");
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.recoverable, true);
  assert.ok(plan.pids.includes(input.parentPid));
  [profile.outerPaths.runtimeStatePath, profile.outerPaths.lockPath, profile.managedStatePath].forEach((target, index) => assert.deepEqual(fs.readFileSync(target), before[index]));
});

test("strict plan rejects live/reused PID, orphan, listeners, missing inventory, transactions, unknown and request history", { skip: process.platform !== "win32" }, () => {
  const profile = JSON.parse(fs.readFileSync(base.profilePath));
  const plan = planInnerStartupRecovery(base, emptyHost);
  for (const observed of [
    { complete: true, processes: [{ ProcessId: base.parentPid, Name: "unrelated.exe", CommandLine: "reused" }], listeners: [] },
    { complete: true, processes: [{ ProcessId: 1, ParentProcessId: base.parentPid }], listeners: [] },
    { complete: true, processes: [], listeners: [{ LocalPort: base.ports.control, OwningProcess: 1 }] },
    { complete: false, processes: [], listeners: [] },
    { complete: true, processes: [{ Name: "node.exe", CommandLine: null }], listeners: [] },
  ]) assert.throws(() => planInnerStartupRecovery(base, () => observed), /STARTUP_RECOVERY_/u);
  const cases = [
    [profile.managedStatePath, value => { value.coordinator.transactionActive = true; }],
    [profile.managedStatePath, value => { value.controlOperations = [{ state: "unknown" }]; }],
    [profile.managedStatePath, value => { value.ownerId = "other-owner"; }],
    [profile.managedStatePath, value => { value.instanceToken = "other-instance"; }],
    [profile.outerPaths.runtimeStatePath, value => { value.proxy.outerRuntime.trackedRequestCount = 1; }],
  ];
  for (const [target, modification] of cases) {
    const restore = mutate(target, modification);
    try { assert.throws(() => planInnerStartupRecovery(base, emptyHost), /STARTUP_RECOVERY_/u); }
    finally { restore(); }
  }
  const changed = { ...plan, instanceToken: "other-instance" };
  assert.throws(() => applyInnerStartupRecovery(base, changed, emptyHost), /PLAN_CHANGED/u);
  const worker = JSON.parse(fs.readFileSync(profile.managedStatePath)).coordinator.workers[0];
  const workerRuntime = path.join(profile.stateRoot, worker.workerId, "codex-model-stream-proxy-runtime.json");
  const restore = mutate(workerRuntime, value => { value.counters.total = 1; });
  try { assert.throws(() => planInnerStartupRecovery(base, emptyHost), /WORKER_IDLE_OR_IDENTITY_UNKNOWN/u); }
  finally { restore(); }
});

test("normal Auto entry applies verified residuals and proceeds through readiness; original bytes and private data survive", { skip: process.platform !== "win32" }, () => {
  const profile = JSON.parse(fs.readFileSync(base.profilePath));
  const privatePath = path.join(base.dataRoot, "private-ledger-binding-account.json");
  fs.writeFileSync(privatePath, '{"pending":"retain","unknown":"retain"}');
  const originals = [profile.outerPaths.runtimeStatePath, profile.outerPaths.lockPath, profile.managedStatePath].map(target => ({ target, bytes: fs.readFileSync(target) }));
  const continuation = `
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) if ($Filter -match '54321') { [pscustomobject]@{CommandLine=$global:ResidualCommand} } }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=54321} }
function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
  $global:ResidualCommand=$ArgumentList
  $runtime=Join-Path $env:RESIDUAL_ROOT 'state\\codex-app-server-proxy-runtime.json'
  if ((Get-Content -LiteralPath $runtime -Raw -Encoding UTF8 | ConvertFrom-Json).state -ne 'stopped') {throw 'FIXTURE_RECOVERY_NOT_APPLIED'}
  $match=[regex]::Match($ArgumentList,'"--instance-token"\\s+"([^"]+)"');$token=$match.Groups[1].Value
  [pscustomobject]@{state='running';pid=54321;instanceToken=$token} | ConvertTo-Json | Set-Content -LiteralPath $runtime -Encoding UTF8
  [pscustomobject]@{pid=54321;token=$token} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $env:RESIDUAL_ROOT 'state\\codex-app-server-proxy.lock') -Encoding UTF8
  [pscustomobject]@{Id=54321;HasExited=$false;StartTime=[DateTime]::UtcNow;Handle=0}
}`;
  const result = shell(base, "Auto", continuation);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).started, true);
  const managed = JSON.parse(fs.readFileSync(profile.managedStatePath));
  assert.equal(managed.state, "closed");
  const manifest = JSON.parse(fs.readFileSync(path.join(managed.startupRecovery.evidenceRoot, "manifest.json")));
  for (const original of originals) {
    const archived = manifest.originals.find(value => value.path === original.target);
    assert.deepEqual(fs.readFileSync(archived.backupPath), original.bytes);
  }
  assert.deepEqual(fs.readFileSync(path.join(managed.startupRecovery.evidenceRoot, "retired.lock")), originals[1].bytes);
  assert.deepEqual(fs.readFileSync(path.join(managed.startupRecovery.evidenceRoot, "retired-runtime.original")), originals[0].bytes);
  assert.deepEqual(fs.readFileSync(path.join(managed.startupRecovery.evidenceRoot, "retired-managed.original")), originals[2].bytes);
  assert.equal(fs.readFileSync(privatePath, "utf8"), '{"pending":"retain","unknown":"retain"}');
  assert.equal(fs.existsSync(`${profile.outerPaths.lockPath}.recovery`), false);
});

after(() => {
  if (process.env.NAPCAT_RESIDUAL_EVIDENCE_PATH) fs.writeFileSync(process.env.NAPCAT_RESIDUAL_EVIDENCE_PATH, JSON.stringify({ root, evidence, generated: base, cleaned: true }, null, 2));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);
});
