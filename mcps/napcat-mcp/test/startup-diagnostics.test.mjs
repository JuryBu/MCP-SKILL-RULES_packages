import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { once } from "node:events";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershell = process.env.NAPCAT_TEST_POWERSHELL ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowsOnly = { skip: process.platform !== "win32" };

function fixture({ recovery = false, plan = false, failPlan = false, oldAttempts = 0, runnerSource, ports = [], detachedOutput = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-startup-diagnostics-"));
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
  const outputHandles = detachedOutput ? [fs.openSync(path.join(root, "parent.out"), "w"), fs.openSync(path.join(root, "parent.err"), "w")] : [];
  const startedAt = Date.now();
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(packageRoot, "ops", "start-codex-app-server-proxy.ps1"), "-DataRoot", dataRoot, "-StartTimeoutMs", "1000", "-StartupTimeoutSeconds", "30", ...ports.flatMap((port, index) => [["-DownstreamPort", "-ControlPort", "-UpstreamPort", "-ProbePort"][index], String(port)]), ...(plan ? ["-StartupRecoveryMode", "Plan"] : [])], {
    windowsHide: true, encoding: "utf8", timeout: 12000, stdio: detachedOutput ? ["ignore", ...outputHandles] : "pipe", env: { ...process.env, CODEX_TOOLKIT_NODE_EXE: process.execPath },
  });
  const parentElapsedMs = Date.now() - startedAt;
  for (const handle of outputHandles) fs.closeSync(handle);
  if (detachedOutput) {
    result.stdout = fs.readFileSync(path.join(root, "parent.out"), "utf8");
    result.stderr = fs.readFileSync(path.join(root, "parent.err"), "utf8");
  }
  const records = fs.existsSync(diagnosticRoot) ? fs.readdirSync(diagnosticRoot).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(diagnosticRoot, name), "utf8"))) : [];
  return { root, stateRoot, diagnosticRoot, result, records, parentElapsedMs, current: records.find(record => record.startedAt) };
}

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
