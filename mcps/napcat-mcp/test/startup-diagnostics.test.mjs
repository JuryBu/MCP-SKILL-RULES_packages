import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { once } from "node:events";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = process.env.NAPCAT_TEST_POWERSHELL ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowsOnly = { skip: process.platform !== "win32" };

function fixture({ recovery = false, plan = false, failPlan = false, oldAttempts = 0, runnerSource, ports = [], detachedOutput = false, publication } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "napcat-startup-diagnostics-")));
  const packageRoot = path.join(root, "package");
  const dataRoot = path.join(root, "data");
  const stateRoot = path.join(dataRoot, "state");
  const diagnosticRoot = path.join(stateRoot, "startup-diagnostics");
  fs.mkdirSync(path.join(packageRoot, "ops"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "src"));
  fs.mkdirSync(stateRoot, { recursive: true });
  for (const name of ["start-codex-app-server-proxy.ps1", "test-codex-startup-readiness.ps1", "resolve-napcat-data-root.ps1", "resolve-codex-outer-runtime-startup.ps1"]) {
    fs.copyFileSync(path.join(repository, "ops", name), path.join(packageRoot, "ops", name));
  }
  fs.writeFileSync(path.join(packageRoot, "src", "codex-app-server-proxy-runner.mjs"), runnerSource ?? "process.stdout.write('runner-started\\n');process.stderr.write('FIXTURE_RUNNER_CAUSE: missing dependency\\n');process.exitCode=17;\n");
  fs.writeFileSync(path.join(packageRoot, "ops", "recover-inner-startup.mjs"), `if(process.argv[2]==='Plan'&&!${failPlan}){console.log(JSON.stringify({planned:true}))}else{console.error('FIXTURE_RECOVERY_CAUSE: stale lease');process.exitCode=23}\n`);
  if (recovery) {
    const profilePath = path.join(stateRoot, "profile.json");
    fs.writeFileSync(profilePath, "{}");
    fs.writeFileSync(path.join(stateRoot, "codex-outer-runtime-startup.json"), JSON.stringify({ schemaVersion: 1, enabled: false, candidateRoot: stateRoot, innerManagedProfilePath: profilePath, innerManagedProfileSha256: createHash("sha256").update("{}").digest("hex") }));
    fs.writeFileSync(path.join(stateRoot, "codex-app-server-proxy.lock"), "preserve-fixture-lock");
  }
  if (oldAttempts) {
    fs.mkdirSync(diagnosticRoot);
    for (let index = 0; index < oldAttempts; index += 1) {
      const attemptId = randomUUID();
      const attemptPath = path.join(diagnosticRoot, `${attemptId}.json`);
      fs.writeFileSync(attemptPath, JSON.stringify({ schemaVersion: 1, attemptId, status: "ready", runnerPid: null, observedRunnerPid: process.pid }));
      fs.writeFileSync(path.join(diagnosticRoot, `${attemptId}.stderr.log`), "retained old fixture");
      fs.utimesSync(attemptPath, 1000 + index, 1000 + index);
    }
  }
  const entryPath = path.join(packageRoot, "ops", "start-codex-app-server-proxy.ps1");
  const publicationEnv = {};
  let invocationPath = entryPath;
  if (publication) {
    const nodePath = path.join(root, "node.exe");
    fs.copyFileSync(process.execPath, nodePath);
    const runnerModule = fs.readFileSync(path.join(repository, "src", "codex-app-server-proxy-runner.mjs"), "utf8");
    const waitSource = /export async function waitForLaunchPublication\(options = \{\}\) \{[\s\S]+?(?=\r?\nexport const proxyServiceDependencies)/u.exec(runnerModule)?.[0];
    assert.ok(waitSource, "public launch publication wait export must be present");
    const waitModulePath = path.join(root, "wait-for-launch-publication.mjs");
    fs.writeFileSync(waitModulePath, `import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';\n${waitSource}`);
    if (publication.entrySource) fs.writeFileSync(entryPath, publication.entrySource);
    invocationPath = path.join(root, "invoke.ps1");
    fs.writeFileSync(invocationPath, publicationWrapper);
    Object.assign(publicationEnv, {
      CODEX_TOOLKIT_NODE_EXE: nodePath,
      NAPCAT_PUBLICATION_ENTRY: entryPath,
      NAPCAT_PUBLICATION_ROOT: root,
      NAPCAT_PUBLICATION_RUNNER: path.join(packageRoot, "src", "codex-app-server-proxy-runner.mjs"),
      NAPCAT_PUBLICATION_DELAY: String(publication.delayMs ?? 11000),
      NAPCAT_PUBLICATION_FAIL_HASH: publication.failHash ? "1" : "0",
      NAPCAT_PUBLICATION_MODULE: pathToFileURL(waitModulePath).href,
    });
    fs.writeFileSync(path.join(stateRoot, "codex-app-server-proxy.lock"), "preserve-publication-lock");
    fs.writeFileSync(path.join(stateRoot, "codex-app-server-proxy-runtime.json"), JSON.stringify({ fixture: "preserve-publication-runtime" }));
  }
  const outputHandles = detachedOutput ? [fs.openSync(path.join(root, "parent.out"), "w"), fs.openSync(path.join(root, "parent.err"), "w")] : [];
  const startedAt = Date.now();
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", invocationPath, "-DataRoot", dataRoot, "-StartTimeoutMs", "1000", "-StartupTimeoutSeconds", "30", ...ports.flatMap((port, index) => [["-DownstreamPort", "-ControlPort", "-UpstreamPort", "-ProbePort"][index], String(port)]), ...(plan ? ["-StartupRecoveryMode", "Plan"] : []), ...(publication ? ["-ExpectedInstanceToken", publication.token, "-LaunchReceiptPath", path.join(root, "launch.json")] : [])], {
    windowsHide: true, encoding: "utf8", timeout: publication ? 45000 : 12000, stdio: detachedOutput ? ["ignore", ...outputHandles] : "pipe", env: { ...process.env, CODEX_TOOLKIT_NODE_EXE: process.execPath, ...publicationEnv },
  });
  const parentElapsedMs = Date.now() - startedAt;
  for (const handle of outputHandles) fs.closeSync(handle);
  if (detachedOutput) {
    result.stdout = fs.readFileSync(path.join(root, "parent.out"), "utf8");
    result.stderr = fs.readFileSync(path.join(root, "parent.err"), "utf8");
  }
  const records = fs.existsSync(diagnosticRoot) ? fs.readdirSync(diagnosticRoot).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(diagnosticRoot, name), "utf8"))) : [];
  return { root, stateRoot, diagnosticRoot, result, records, parentElapsedMs, publication, ports, current: records.find(record => record.startedAt) };
}

const publicationWrapper = `
param([string]$DataRoot, [int]$StartTimeoutMs, [int]$StartupTimeoutSeconds,
  [int]$DownstreamPort, [int]$ControlPort, [int]$UpstreamPort, [int]$ProbePort,
  [string]$ExpectedInstanceToken, [string]$LaunchReceiptPath)
Import-Module Microsoft.PowerShell.Utility
function Write-FixtureEvent($Value) {
  $Value.at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [IO.File]::AppendAllText((Join-Path $env:NAPCAT_PUBLICATION_ROOT 'events.jsonl'), (($Value | ConvertTo-Json -Compress) + [Environment]::NewLine))
}
$script:FixtureHashCount = 0
function Get-FileHash {
  [CmdletBinding(DefaultParameterSetName='Path')]
  param([Parameter(ParameterSetName='Path')][string[]]$LiteralPath,
    [Parameter(ParameterSetName='Stream')][IO.Stream]$InputStream, [string]$Algorithm='SHA256')
  $script:FixtureHashCount++
  $SourcePath = if ($PSCmdlet.ParameterSetName -eq 'Stream') { $InputStream.Name } else { $LiteralPath[0] }
  Write-FixtureEvent @{ kind='hash_start'; path=$SourcePath; stream=($PSCmdlet.ParameterSetName -eq 'Stream') }
  if ($script:FixtureHashCount -eq 1) {
    foreach ($Source in @($env:CODEX_TOOLKIT_NODE_EXE, $env:NAPCAT_PUBLICATION_RUNNER, $env:NAPCAT_PUBLICATION_ENTRY)) {
      $Writable = $false
      try { $Probe = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $Writable=$true; $Probe.Dispose() } catch {}
      Write-FixtureEvent @{ kind='write_probe'; path=$Source; writable=$Writable }
    }
    Start-Sleep -Milliseconds ([int]$env:NAPCAT_PUBLICATION_DELAY)
    if ($env:NAPCAT_PUBLICATION_FAIL_HASH -eq '1') { throw 'FIXTURE_LAUNCH_HASH_FAILED' }
  }
  if ($SourcePath -eq (Join-Path $env:NAPCAT_PUBLICATION_ROOT 'launch.json')) {
    foreach ($Source in @($env:CODEX_TOOLKIT_NODE_EXE, $env:NAPCAT_PUBLICATION_RUNNER, $env:NAPCAT_PUBLICATION_ENTRY)) {
      $Writable = $false
      try { $Probe = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $Writable=$true; $Probe.Dispose() } catch {}
      Write-FixtureEvent @{ kind='publication_write_probe'; path=$Source; writable=$Writable }
    }
  }
  if ($PSCmdlet.ParameterSetName -eq 'Stream') { $Digest = Microsoft.PowerShell.Utility\\Get-FileHash -InputStream $InputStream -Algorithm $Algorithm }
  else { $Digest = Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm }
  Write-FixtureEvent @{ kind='hash_complete'; path=$SourcePath; sha256=$Digest.Hash.ToLowerInvariant() }
  $Digest
}
function Start-Process {
  [CmdletBinding()]
  param([string]$FilePath, [string[]]$ArgumentList, [string]$WindowStyle, [switch]$PassThru,
    [string]$RedirectStandardOutput, [string]$RedirectStandardError)
  Write-FixtureEvent @{ kind='spawn'; path=$FilePath }
  $Child = Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters
  Write-FixtureEvent @{ kind='spawned'; pid=$Child.Id }
  $Child
}
try { & $env:NAPCAT_PUBLICATION_ENTRY @PSBoundParameters }
finally {
  foreach ($Source in @($env:CODEX_TOOLKIT_NODE_EXE, $env:NAPCAT_PUBLICATION_RUNNER, $env:NAPCAT_PUBLICATION_ENTRY)) {
    $Writable = $false
    try { $Probe = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $Writable=$true; $Probe.Dispose() } catch {}
    Write-FixtureEvent @{ kind='released_probe'; path=$Source; writable=$Writable }
  }
}`;

const publicationRunner = `import fs from 'node:fs';import net from 'node:net';import path from 'node:path';
const root=process.env.NAPCAT_PUBLICATION_ROOT;
process.on('exit',()=>fs.writeFileSync(path.join(root,'child-exited'),'yes'));
fs.writeFileSync(path.join(root,'child-pid'),String(process.pid));
const cleanup=setInterval(()=>{if(fs.existsSync(path.join(root,'shutdown')))process.exit(0)},25);
setTimeout(()=>process.exit(90),40000).unref();
const {waitForLaunchPublication}=await import(process.env.NAPCAT_PUBLICATION_MODULE);
const args=Object.fromEntries(process.argv.slice(2).reduce((all,value,index,values)=>index%2===0?[...all,[value,values[index+1]]]:all,[]));
const startedAt=Date.now();
const published=await waitForLaunchPublication({launchReceiptPath:args['--launch-receipt'],instanceToken:args['--instance-token'],runtimeStatePath:args['--runtime-state']});
fs.writeFileSync(path.join(root,'child-observation.json'),JSON.stringify({pid:process.pid,startedAt,published,waitMs:Date.now()-startedAt}));
if(!published){console.error('FIXTURE_START_LAUNCH_NOT_PUBLISHED');process.exit(29)}
const servers=['--downstream-port','--control-port'].map(key=>net.createServer().listen(Number(args[key]),'127.0.0.1'));
await Promise.all(servers.map(server=>new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})));
fs.writeFileSync(args['--lock'],JSON.stringify({pid:process.pid,token:args['--instance-token']}));
fs.writeFileSync(args['--runtime-state'],JSON.stringify({pid:process.pid,instanceToken:args['--instance-token'],state:'running'}));
console.log('FIXTURE_PUBLICATION_READY');`;

async function publicationPorts() {
  const listeners = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const listener = net.createServer().listen(0, "127.0.0.1");
      listeners.push(listener);
      await once(listener, "listening");
    }
    return listeners.map(listener => listener.address().port);
  } finally {
    await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve))));
  }
}

function publicationEvents(observed) {
  return fs.readFileSync(path.join(observed.root, "events.jsonl"), "utf8").trim().split(/\r?\n/u).map(line => JSON.parse(line));
}

async function disposePublication(observed, failure) {
  const pidPath = path.join(observed.root, "child-pid");
  const childPid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, "utf8")) : null;
  const childAlive = () => {
    if (!childPid) return false;
    try { process.kill(childPid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  fs.writeFileSync(path.join(observed.root, "shutdown"), "stop-owned-fixture");
  const deadline = Date.now() + 5000;
  while (childAlive() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const childStopped = !childAlive();
  const evidence = { shell: powershell, parentElapsedMs: observed.parentElapsedMs, status: observed.result.status,
    error: observed.result.error?.message, stdout: observed.result.stdout, stderr: observed.result.stderr,
    events: fs.existsSync(path.join(observed.root, "events.jsonl")) ? publicationEvents(observed) : [],
    diagnostics: observed.records, childStopped, failure: failure?.stack,
    diagnosticLogs: observed.records.map(record => Object.fromEntries(["stderrPath", "stdoutPath"].filter(key => record[key] && fs.existsSync(record[key])).map(key => [key, fs.readFileSync(record[key], "utf8")]))),
    child: fs.existsSync(path.join(observed.root, "child-observation.json")) ? JSON.parse(fs.readFileSync(path.join(observed.root, "child-observation.json"), "utf8")) : null,
    files: Object.fromEntries(["launch.json", "launch.json.ready"].filter(name => fs.existsSync(path.join(observed.root, name))).map(name => [name, fs.readFileSync(path.join(observed.root, name), "utf8")])) };
  if (process.env.NAPCAT_TEST_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.NAPCAT_TEST_EVIDENCE_DIR, { recursive: true });
    const target = path.join(process.env.NAPCAT_TEST_EVIDENCE_DIR, `${path.basename(observed.root)}.json`);
    fs.writeFileSync(target, JSON.stringify(evidence, null, 2));
    for (const record of observed.records) {
      for (const key of ["stderrPath", "stdoutPath"]) {
        if (record[key] && fs.existsSync(record[key])) fs.copyFileSync(record[key], `${target}.${key}.log`);
      }
    }
    console.log(`publication evidence: ${target}`);
  } else {
    console.log(JSON.stringify(evidence));
  }
  assert.ok(childStopped, `owned fixture child still running; retained ${observed.root}`);
  const releaseDeadline = Date.now() + 5000;
  for (const sourcePath of [path.join(observed.root, "node.exe"), path.join(observed.root, "package", "src", "codex-app-server-proxy-runner.mjs"), path.join(observed.root, "package", "ops", "start-codex-app-server-proxy.ps1")]) {
    while (true) {
      try {
        const handle = fs.openSync(sourcePath, "r+");
        fs.closeSync(handle);
        break;
      } catch (error) {
        if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || Date.now() >= releaseDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  fs.rmSync(observed.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("launch publication hashes before spawn despite an 11 second first hash", windowsOnly, async () => {
  const observed = fixture({ publication: { token: randomUUID() }, runnerSource: publicationRunner, ports: await publicationPorts(), detachedOutput: true });
  let failure;
  try {
    assert.equal(observed.result.error, undefined);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.current.status, "ready");
    const events = publicationEvents(observed);
    const spawnIndex = events.findIndex(event => event.kind === "spawn");
    const sourceHashes = events.filter(event => event.kind === "hash_complete").slice(0, 3);
    assert.equal(sourceHashes.length, 3);
    for (const event of sourceHashes) assert.ok(events.indexOf(event) < spawnIndex, `${event.path} hashed after spawn`);
    assert.equal(events.filter(event => event.kind === "hash_start" && event.stream).length, 3);
    assert.deepEqual(events.filter(event => event.kind === "write_probe").map(event => event.writable), [false, false, false]);
    assert.deepEqual(events.filter(event => event.kind === "publication_write_probe").map(event => event.writable), [false, false, false]);
    assert.ok(events.filter(event => event.kind === "released_probe" && event.path !== path.join(observed.root, "node.exe")).every(event => event.writable));
    const receiptBytes = fs.readFileSync(path.join(observed.root, "launch.json"));
    const receipt = JSON.parse(receiptBytes);
    const ready = JSON.parse(fs.readFileSync(path.join(observed.root, "launch.json.ready"), "utf8"));
    const child = JSON.parse(fs.readFileSync(path.join(observed.root, "child-observation.json"), "utf8"));
    const runtime = JSON.parse(fs.readFileSync(path.join(observed.stateRoot, "codex-app-server-proxy-runtime.json"), "utf8"));
    assert.equal(ready.receiptSha256, createHash("sha256").update(receiptBytes).digest("hex"));
    assert.equal(ready.instanceToken, receipt.instanceToken);
    assert.equal(receipt.instanceToken, observed.publication.token);
    assert.equal(receipt.instanceToken, runtime.instanceToken);
    assert.equal(receipt.pid, runtime.pid);
    assert.equal(receipt.pid, child.pid);
    assert.equal(receipt.pid, observed.current.runnerPid);
    assert.equal(receipt.runtimeStatePath, path.join(observed.stateRoot, "codex-app-server-proxy-runtime.json"));
    assert.equal(receipt.nodePath, path.join(observed.root, "node.exe"));
    assert.equal(receipt.runnerPath, path.join(observed.root, "package", "src", "codex-app-server-proxy-runner.mjs"));
    assert.deepEqual(receipt.ports, observed.ports);
    for (const [hashKey, sourcePath] of [["nodeSha256", receipt.nodePath], ["runnerSha256", receipt.runnerPath], ["entrySha256", path.join(observed.root, "package", "ops", "start-codex-app-server-proxy.ps1")]]) {
      assert.equal(receipt[hashKey], createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"));
    }
    assert.equal(child.published, true);
    assert.ok(child.waitMs < 10000);
    assert.ok(observed.current.phaseTimings.launchHashMs >= 11000);
    for (const phase of ["launchProcessMs", "launchPublicationMs", "launchToPublicationMs"]) assert.ok(Number.isFinite(observed.current.phaseTimings[phase]) && observed.current.phaseTimings[phase] >= 0, phase);
    assert.ok(observed.current.phaseTimings.launchToPublicationMs < 10000);
    for (const stage of ["launch_hash", "launch_publication", "ready"]) assert.ok(observed.current.events.some(event => event.stage === stage), stage);
  } catch (error) { failure = error; throw error; }
  finally { await disposePublication(observed, failure); }
});

test("launch publication hash failure does not spawn or replace incumbent state", windowsOnly, async () => {
  const observed = fixture({ publication: { token: randomUUID(), delayMs: 0, failHash: true }, runnerSource: publicationRunner, ports: await publicationPorts(), detachedOutput: true });
  let failure;
  try {
    assert.equal(observed.result.error, undefined);
    assert.notEqual(observed.result.status, 0);
    assert.match(observed.result.stderr, /FIXTURE_LAUNCH_HASH_FAILED/u);
    assert.equal(publicationEvents(observed).some(event => event.kind === "spawn"), false);
    assert.equal(fs.existsSync(path.join(observed.root, "launch.json")), false);
    assert.equal(fs.existsSync(path.join(observed.root, "launch.json.ready")), false);
    assert.equal(fs.readFileSync(path.join(observed.stateRoot, "codex-app-server-proxy.lock"), "utf8"), "preserve-publication-lock");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(observed.stateRoot, "codex-app-server-proxy-runtime.json"), "utf8")), { fixture: "preserve-publication-runtime" });
    assert.equal(observed.current.stage, "launch_hash");
    assert.equal(observed.current.status, "failed");
    assert.deepEqual(publicationEvents(observed).filter(event => event.kind === "released_probe").map(event => event.writable), [true, true, true]);
  } catch (error) { failure = error; throw error; }
  finally { await disposePublication(observed, failure); }
});

test("launch publication counterfactual baseline exceeds the unchanged 10 second child wait", { skip: process.platform !== "win32" || !process.env.NAPCAT_TEST_BASELINE_ENTRY }, async () => {
  const entrySource = fs.readFileSync(process.env.NAPCAT_TEST_BASELINE_ENTRY, "utf8");
  const observed = fixture({ publication: { token: randomUUID(), entrySource }, runnerSource: publicationRunner, ports: await publicationPorts(), detachedOutput: true });
  let failure;
  try {
    assert.equal(observed.result.error, undefined);
    assert.notEqual(observed.result.status, 0);
    const events = publicationEvents(observed);
    assert.ok(events.findIndex(event => event.kind === "spawn") < events.findIndex(event => event.kind === "hash_start"));
    const child = JSON.parse(fs.readFileSync(path.join(observed.root, "child-observation.json"), "utf8"));
    assert.equal(child.published, false);
    assert.ok(child.waitMs >= 10000);
    const receipt = JSON.parse(fs.readFileSync(path.join(observed.root, "launch.json"), "utf8"));
    assert.ok(Date.parse(receipt.recordedAt) - Date.parse(receipt.createdAt) > 10000);
    assert.match(fs.readFileSync(observed.current.stderrPath, "utf8"), /FIXTURE_START_LAUNCH_NOT_PUBLISHED/u);
  } catch (error) { failure = error; throw error; }
  finally { await disposePublication(observed, failure); }
});

function dispose(observed) {
  if (observed.result.error) throw new Error(`fixture retained: ${observed.root}: ${observed.result.error.message}`);
  fs.rmSync(observed.root, { recursive: true, force: true });
}

test("startup diagnostics retain a real runner exit cause and startup stage", windowsOnly, () => {
  const observed = fixture();
  try {
    assert.equal(observed.result.error, undefined);
    assert.notEqual(observed.result.status, 0);
    assert.match(observed.result.stderr, /exited immediately, exitCode=17/u);
    assert.equal(observed.current.status, "failed");
    assert.equal(observed.current.stage, "runner_wait");
    assert.ok(observed.current.elapsedMs > 0);
    assert.ok(observed.current.runnerPid > 0);
    assert.match(fs.readFileSync(observed.current.stderrPath, "utf8"), /FIXTURE_RUNNER_CAUSE: missing dependency/u);
    assert.match(fs.readFileSync(observed.current.stdoutPath, "utf8"), /runner-started/u);
    assert.deepEqual(observed.current.events.map(event => event.stage), ["configuration", "ports", "runner_launch", "runner_wait", "runner_wait"]);
  } finally { dispose(observed); }
});

test("startup diagnostics preserve the recovery subprocess error and incumbent state", windowsOnly, () => {
  const observed = fixture({ recovery: true });
  try {
    assert.equal(observed.result.error, undefined);
    assert.notEqual(observed.result.status, 0);
    assert.match(observed.result.stderr, /INNER_STARTUP_RECOVERY_REFUSED/u);
    assert.equal(observed.current.stage, "recovery");
    assert.equal(observed.current.status, "failed");
    assert.match(fs.readFileSync(observed.current.recoveryOutputPath, "utf8"), /FIXTURE_RECOVERY_CAUSE: stale lease/u);
    assert.equal(fs.readFileSync(path.join(observed.stateRoot, "codex-app-server-proxy.lock"), "utf8"), "preserve-fixture-lock");
    assert.equal(fs.existsSync(observed.current.stderrPath), false);
  } finally { dispose(observed); }
});

test("startup plan remains read-only and retains its JSON result", windowsOnly, () => {
  const observed = fixture({ recovery: true, plan: true });
  try {
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.deepEqual(JSON.parse(observed.result.stdout), { planned: true });
    assert.equal(fs.existsSync(observed.diagnosticRoot), false);
  } finally { dispose(observed); }
});

test("a failed startup plan returns its original recovery error without writing logs", windowsOnly, () => {
  const observed = fixture({ recovery: true, plan: true, failPlan: true });
  try {
    assert.notEqual(observed.result.status, 0);
    assert.match(observed.result.stderr, /FIXTURE_RECOVERY_CAUSE: stale lease/u);
    assert.equal(fs.existsSync(observed.diagnosticRoot), false);
  } finally { dispose(observed); }
});

test("startup diagnostic retention limits completed attempts to 32", windowsOnly, () => {
  const observed = fixture({ oldAttempts: 34 });
  try {
    assert.equal(observed.records.length, 32);
    assert.match(fs.readFileSync(observed.current.stderrPath, "utf8"), /FIXTURE_RUNNER_CAUSE/u);
    assert.equal(fs.readdirSync(observed.diagnosticRoot).filter(name => name.endsWith(".stderr.log")).length, 32);
  } finally { dispose(observed); }
});

test("diagnostic retention enumeration failures leave startup available", windowsOnly, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-diagnostic-enumeration-"));
  const source = fs.readFileSync(path.join(repository, "ops", "start-codex-app-server-proxy.ps1"), "utf8");
  const cleanup = /function Remove-OldStartupDiagnostics \{[\s\S]+?(?=\r?\nWrite-StartupDiagnostic -Stage 'configuration')/u.exec(source)?.[0];
  assert.ok(cleanup);
  try {
    const script = `$ErrorActionPreference='Stop';$StartupRecoveryMode='Auto';$DiagnosticRoot=$env:DIAG_TEST_ROOT;
${cleanup}
function Get-ChildItem { throw [IO.IOException]::new('fixture directory enumeration failure') }
Remove-OldStartupDiagnostics
'CONTINUED'`;
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", timeout: 5000, env: { ...process.env, DIAG_TEST_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CONTINUED/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repeated successful health checks do not displace failure evidence", windowsOnly, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-diagnostic-reuse-"));
  const source = fs.readFileSync(path.join(repository, "ops", "start-codex-app-server-proxy.ps1"), "utf8");
  const writer = /function Write-StartupDiagnostic \{[\s\S]+?(?=\r?\nfunction Remove-OldStartupDiagnostics)/u.exec(source)?.[0];
  assert.ok(writer);
  assert.match(source, /Write-StartupDiagnostic -Stage 'configuration'\r?\ntry \{/u);
  const originalNames = Array.from({ length: 32 }, () => `${randomUUID()}.json`);
  for (const name of originalNames) fs.writeFileSync(path.join(root, name), "preserved failure");
  try {
    const script = `$ErrorActionPreference='Stop';$StartupRecoveryMode='Auto';$DiagnosticRoot=$env:DIAG_TEST_ROOT;
${writer}
foreach($iteration in 1..40){
  $AttemptId=[guid]::NewGuid().ToString();$AttemptPath=Join-Path $DiagnosticRoot ($AttemptId+'.json');
  $StartupClock=[Diagnostics.Stopwatch]::StartNew();$StartupDiagnostic=[ordered]@{attemptId=$AttemptId;stage='configuration';status='running';elapsedMs=0;error=$null;events=@()};
  Write-StartupDiagnostic -Stage 'configuration';Write-StartupDiagnostic -Stage 'existing_runtime' -Status 'ready'
}`;
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", timeout: 10000, env: { ...process.env, DIAG_TEST_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readdirSync(root).length, 33);
    for (const name of originalNames) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), "preserved failure");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "latest-existing-runtime.json"), "utf8")).status, "ready");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a ready runner outlives the launcher and keeps its redirected output", windowsOnly, async () => {
  const listeners = [];
  for (let index = 0; index < 4; index += 1) {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    listeners.push(listener);
  }
  const ports = listeners.map(listener => listener.address().port);
  await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve))));
  const runnerSource = `import fs from 'node:fs';import net from 'node:net';
const args=Object.fromEntries(process.argv.slice(2).reduce((all,value,index,values)=>index%2===0?[...all,[value,values[index+1]]]:all,[]));
const servers=['--downstream-port','--control-port'].map(key=>net.createServer().listen(Number(args[key]),'127.0.0.1'));
fs.writeFileSync(args['--lock'],JSON.stringify({pid:process.pid,token:'fixture-instance'}));
fs.writeFileSync(args['--runtime-state'],JSON.stringify({pid:process.pid,instanceToken:'fixture-instance',state:'running'}));
setTimeout(()=>{console.error('AFTER_PARENT_EXIT');console.log('LATE_STDOUT');for(const server of servers)server.close();},8000);`;
  const observed = fixture({ runnerSource, ports, detachedOutput: true });
  const cleanupAt = Date.now() + Math.max(0, 9000 - observed.parentElapsedMs);
  try {
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(JSON.parse(observed.result.stdout).started, true);
    assert.equal(observed.current.status, "ready");
    assert.ok(observed.parentElapsedMs < 7500, `launcher took ${observed.parentElapsedMs}ms`);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, cleanupAt - Date.now())));
    assert.match(fs.readFileSync(observed.current.stderrPath, "utf8"), /AFTER_PARENT_EXIT/u);
    assert.match(fs.readFileSync(observed.current.stdoutPath, "utf8"), /LATE_STDOUT/u);
  } finally {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, cleanupAt - Date.now())));
    dispose(observed);
  }
});
