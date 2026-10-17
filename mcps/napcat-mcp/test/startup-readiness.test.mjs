import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));
const powershell = process.env.NAPCAT_TEST_POWERSHELL ?? "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const entry = path.join(repository, "ops/start-codex-app-server-proxy.ps1");
const source = fs.readFileSync(entry, "utf8");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const identityFunctions = source.slice(source.indexOf("function Test-ExpectedProxyIdentity"), source.indexOf("function Get-OuterRuntimeStartupStatus"));
const loop = /\$RuntimeState = \$null\r?\n\$Deadline = [\s\S]+?\} while \(\[DateTime\]::UtcNow -lt \$Deadline\)/u.exec(source)[0];
const records = [];

function exercise(scenario, { legacy = false, existing = false, selected = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-readiness-"));
  const stateRoot = path.join(root, "state");
  const managedRoot = path.join(stateRoot, "inner-managed");
  fs.mkdirSync(managedRoot, { recursive: true });
  const tokenPath = path.join(stateRoot, "codex-app-server-proxy-token.txt");
  fs.writeFileSync(tokenPath, "fixture-token");
  const hashes = Object.fromEntries(["runner", "core", "helper", "control"].map(name => [name, "a".repeat(64)]));
  const profile = { schemaVersion: 1, mode: "production", ownerId: "fixture-owner", nativeSourceId: "fixture-native",
    stateRoot: managedRoot, managedStatePath: path.join(managedRoot, "managed-runtime.json"), innerPort: 41435,
    ports: { inner: 41435, control: 41431, downstream: 41432, upstream: 41433, probe: 41434 }, controlTokenSha256: digest("fixture-token"), initial: { expectedHashes: hashes } };
  const profilePath = path.join(stateRoot, "profile.json");
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  fs.writeFileSync(path.join(stateRoot, "codex-outer-runtime-startup.json"), JSON.stringify({ schemaVersion: 1, enabled: false, candidateRoot: stateRoot,
    innerManagedProfilePath: profilePath, innerManagedProfileSha256: digest(fs.readFileSync(profilePath)) }));
  const runtimePath = path.join(stateRoot, "codex-app-server-proxy-runtime.json");
  const desktop = scenario.endsWith("desktop");
  const runtime = { pid: 54321, instanceToken: "fixture-instance", state: desktop ? "waiting_for_desktop" : "running",
    waitingForDesktop: desktop, appServerPid: desktop ? null : 54322 };
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  fs.writeFileSync(path.join(stateRoot, "codex-app-server-proxy.lock"), JSON.stringify({ pid: runtime.pid, token: runtime.instanceToken }));
  fs.writeFileSync(path.join(stateRoot, "codex-app-server-wake-journal.json"), "preserve-unknown-history");
  fs.writeFileSync(profile.managedStatePath, JSON.stringify({ ...runtime, state: "running", ownerId: profile.ownerId,
    nativeSourceId: profile.nativeSourceId, livenessAt: new Date().toISOString(),
    coordinator: { defaultWorkerId: "worker", workers: [{ workerId: "worker", alive: true, sourceHashes: hashes }] } }));
  const registryPath = path.join(managedRoot, "inner-candidate-approvals.json");
  let manifestHash = null;
  if (selected) {
    const installationRoot = path.join(root, "candidate");
    fs.mkdirSync(path.join(installationRoot, "src"), { recursive: true });
    const manifestPath = path.join(installationRoot, "src/manifest.json");
    fs.writeFileSync(manifestPath, "{}");
    manifestHash = digest("{}");
    fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId,
      candidates: [{ id: "fixture-candidate", installationRoot, expectedHashes: hashes }], selection: { candidateId: "fixture-candidate", manifestPath, manifestSha256: manifestHash } }));
  }
  const preserved = new Map([runtimePath, tokenPath, profilePath, profile.managedStatePath,
    path.join(stateRoot, "codex-app-server-proxy.lock"), path.join(stateRoot, "codex-app-server-wake-journal.json"),
    ...(selected ? [registryPath] : [])].map(filename => [filename, fs.readFileSync(filename)]));
  const mocks = `
$global:Calls=0;$global:InnerCalls=0
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) [pscustomobject]@{CommandLine=('codex-app-server-proxy-runner.mjs '+$RuntimeStatePath+' '+$LockPath)} }
function Get-NetTCPConnection { param($State,$LocalPort,$ErrorAction) [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=54321} }
function Start-Process { throw 'UNEXPECTED_RESTART' }
function Invoke-RestMethod { param($Uri,$Headers,$TimeoutSec)
  if ($Headers.Authorization -cne 'Bearer fixture-token') {throw 'AUTH_REQUIRED'}
  $hashes=[pscustomobject]@{runner=('a'*64);core=('a'*64);helper=('a'*64);control=('a'*64)}
  if($env:READY_SCENARIO -like 'worker-drift*'){$hashes.core='b'*64}
  if ($Uri.EndsWith('/v1/status')) { return [pscustomobject]@{closed=$false;outerRuntime=[pscustomobject]@{instanceId='fixture-instance';enabled=$false}} }
  if ($Uri.EndsWith('/v1/full-runtime')) {
    $global:Calls++
    $pending=($env:READY_SCENARIO -in @('slow','failed','timeout','wrong-manifest','busy','original-drift') -and ($global:Calls -lt 4 -or $env:READY_SCENARIO -notin @('slow','failed'))) -or ($env:READY_SCENARIO -eq 'ready-then-busy' -and $global:Calls -gt 1)
    return [pscustomobject]@{ok=$true;instanceId=$(if($env:READY_SCENARIO -eq 'wrong-instance'){'foreign'}else{'fixture-instance'});busy=($pending -and $env:READY_SCENARIO -ne 'wrong-manifest');failed=($env:READY_SCENARIO -eq 'failed' -and $global:Calls -ge 4);candidateRegistrySha256=$(if($env:READY_REGISTRY_HASH){$env:READY_REGISTRY_HASH}else{$null});
      selected=[pscustomobject]@{id=$(if($pending -or -not $env:READY_MANIFEST_HASH){'original'}else{'fixture-candidate'});manifestSha256=$(if($pending -or -not $env:READY_MANIFEST_HASH){$null}else{$env:READY_MANIFEST_HASH})};modelWorker=$(if($env:READY_MANIFEST_HASH){[pscustomobject]@{workerId='worker';sourceHashes=$hashes}}else{$null})}
  }
  $global:InnerCalls++
  if($env:READY_SCENARIO -eq 'desktop'){throw 'DESKTOP_NATIVE_NOT_AVAILABLE'}
  [pscustomobject]@{ok=$true;ownerId='fixture-owner';nativeSourceId='fixture-native';instanceToken='fixture-instance';selectedWorkerId='worker';selectedSourceHashes=$hashes;coordinator=[pscustomobject]@{running=$true;nativeHealthy=($env:READY_SCENARIO -ne 'unhealthy');workers=@([pscustomobject]@{workerId='worker';alive=$true;sourceHashes=$hashes})}}
}
`;
  const functions = legacy ? identityFunctions.replace(/return Test-CodexManagedStartupReadiness[^\r\n]+/u, "return $true") : identityFunctions;
  const script = `$ErrorActionPreference='Stop';. '${path.join(repository, "ops/resolve-codex-outer-runtime-startup.ps1")}';. '${path.join(repository, "ops/test-codex-startup-readiness.ps1")}';
$DataRoot=$env:READY_ROOT;$RuntimeStatePath=Join-Path $DataRoot 'state/codex-app-server-proxy-runtime.json';$LockPath=Join-Path $DataRoot 'state/codex-app-server-proxy.lock';$TokenFilePath=Join-Path $DataRoot 'state/codex-app-server-proxy-token.txt';$ControlPort=41431;$DownstreamPort=41432;
$OuterRuntimeStartup=Resolve-CodexOuterRuntimeStartup -DataRoot $DataRoot;
${functions}
${mocks}
try {
${existing ? `& '${entry}' -DataRoot $DataRoot -DownstreamPort 41432 -ControlPort 41431 -UpstreamPort 41433 -ProbePort 41434 -StartTimeoutMs 1000 -StartupTimeoutSeconds 30 | Out-Null;$outcome='EXISTING_READY'` : `$StartupTimeoutSeconds=$(if($env:READY_SCENARIO -in @('slow','failed')){5}else{1.2});$Process=[pscustomobject]@{Id=54321;HasExited=$false};${loop};$outcome=if($null -eq $RuntimeState){'TIMEOUT'}else{'READY'}`}
} catch { $outcome=$_.Exception.Message }
[pscustomobject]@{outcome=$outcome;fullCalls=$global:Calls;innerCalls=$global:InnerCalls;psVersion=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json`;
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 12000,
    env: { ...process.env, READY_ROOT: root, READY_SCENARIO: scenario, READY_MANIFEST_HASH: manifestHash ?? "",
      READY_REGISTRY_HASH: selected ? digest(fs.readFileSync(registryPath)) : "", CODEX_TOOLKIT_NODE_EXE: process.execPath } });
  try {
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    for (const [filename, bytes] of preserved) assert.deepEqual(fs.readFileSync(filename), bytes);
    records.push({ scenario, legacy, existing, selected, ...value });
    console.log(JSON.stringify(records.at(-1)));
    return value;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("old readiness reproduces early success while persistent recovery is still pending", () => {
  const value = exercise("slow", { legacy: true });
  assert.equal(value.outcome, "READY"); assert.equal(value.fullCalls, 0);
});
test("slow persistent recovery waits for selection and inner health", () => {
  const value = exercise("slow"); assert.equal(value.outcome, "READY"); assert.ok(value.fullCalls >= 4);
});
test("failed recovery preserves registry, runtime, lease and UNKNOWN journal", () => {
  assert.match(exercise("failed").outcome, /FULL_RUNTIME_STARTUP_FAILED_PRESERVED/u);
});
test("existing instance waits without launching a second process", () => {
  const value = exercise("slow", { existing: true }); assert.equal(value.outcome, "EXISTING_READY"); assert.ok(value.fullCalls >= 4);
});
test("an existing ready instance cannot fall through into a duplicate start after a second readiness check", () => {
  const value = exercise("ready-then-busy", { existing: true }); assert.equal(value.outcome, "EXISTING_READY");
});
test("no registry accepts the original runtime", () => { assert.equal(exercise("ready", { selected: false }).outcome, "READY"); });
test("original waiting for Desktop accepts null full model worker with verified initial worker", () => {
  const value = exercise("desktop", { selected: false }); assert.equal(value.outcome, "READY"); assert.equal(value.innerCalls, 0);
});
test("waiting for Desktop needs settled recovery but no native-source request", () => {
  const value = exercise("desktop"); assert.equal(value.outcome, "READY"); assert.equal(value.innerCalls, 0);
});
for (const scenario of ["timeout", "busy", "wrong-manifest", "unhealthy", "worker-drift-running", "worker-drift-desktop"]) test(`${scenario} never returns ready`, () => {
  assert.equal(exercise(scenario).outcome, "TIMEOUT");
});
test("a different control instance is rejected", () => { assert.match(exercise("wrong-instance").outcome, /INSTANCE_CHANGED_PRESERVED/u); });
