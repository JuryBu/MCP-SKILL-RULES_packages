import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repository, "ops", "start-codex-app-server-proxy.ps1");
const runner = path.join(repository, "src", "codex-app-server-proxy-runner.mjs");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowsOnly = { skip: process.platform !== "win32" };
const source = fs.readFileSync(entry, "utf8");
const loop = /\$RuntimeState = \$null\r?\n\$Deadline = [\s\S]+?\} while \(\[DateTime\]::UtcNow -lt \$Deadline\)/u.exec(source)?.[0];
const exitCheck = 'if ($Process.HasExited -and $null -eq $RuntimeState) { throw "Codex App Server proxy exited immediately, exitCode=$($Process.ExitCode)" }';

function execute(script, environment = {}, timeout = 10000) {
  return spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: repository, windowsHide: true, encoding: "utf8", timeout,
    env: { ...process.env, CODEX_TOOLKIT_NODE_EXE: process.execPath, ...environment },
  });
}

function exerciseLoop(state, { exited = true, legacy = false } = {}) {
  assert.ok(loop, "original entry readiness loop is available");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-timeout-loop-"));
  const runtimePath = path.join(root, "runtime.json");
  if (state !== undefined) fs.writeFileSync(runtimePath, typeof state === "string" ? state : JSON.stringify(state));
  let selectedLoop = loop;
  if (legacy) selectedLoop = selectedLoop.replace(exitCheck, "").replace("} while", `${exitCheck}\n} while`);
  const script = `$ErrorActionPreference='Stop';
    $RuntimeStatePath=$env:STARTUP_TEST_RUNTIME;
    $StartupTimeoutSeconds=0.25;
    $Process=[pscustomobject]@{Id=54321;HasExited=${exited ? "$true" : "$false"};ExitCode=17};
    function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) [pscustomobject]@{CommandLine='isolated-fixture'} }
    function Test-ExpectedProxyRuntime { param($RuntimeState,$ProcessInfo) return $RuntimeState.state -eq 'running' }
    try { ${selectedLoop}; if ($null -eq $RuntimeState) { 'TIMED_OUT' } else { 'READY' } }
    catch { $_.Exception.Message }`;
  try {
    const result = execute(script, { STARTUP_TEST_RUNTIME: runtimePath });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("legacy PID-mismatch continue reproduces the false timeout", windowsOnly, () => {
  assert.equal(exerciseLoop({ pid: 11111, state: "running" }, { legacy: true }), "TIMED_OUT");
});

test("an exited launcher fails immediately before every stale-state branch", windowsOnly, () => {
  for (const state of [undefined, "{invalid", {}, { pid: 11111, state: "running" }, { pid: null, state: "degraded" }]) {
    assert.equal(exerciseLoop(state), "Codex App Server proxy exited immediately, exitCode=17");
  }
});

test("a live mismatched PID keeps waiting without accepting stale readiness", windowsOnly, () => {
  assert.equal(exerciseLoop({ pid: 11111, state: "running" }, { exited: false }), "TIMED_OUT");
});

test("matching live readiness and degraded failure retain their behavior", windowsOnly, () => {
  assert.equal(exerciseLoop({ pid: 54321, state: "running" }, { exited: false }), "READY");
  assert.equal(exerciseLoop({ pid: 54321, state: "degraded", lastError: { message: "fixture failure" } }, { exited: false }),
    "Codex App Server proxy entered degraded mode: fixture failure");
});

async function reservePorts() {
  const listeners = [];
  try {
    for (const index of [0, 1, 2, 3]) {
      const listener = net.createServer();
      listeners[index] = listener;
      listener.listen(0, "127.0.0.1");
      await once(listener, "listening");
    }
    return listeners.map(listener => listener.address().port);
  } finally {
    await Promise.all(listeners.map(listener => new Promise(resolve => listener.close(resolve))));
  }
}

test("original entry reports real duplicate-runner exit with stale PID, preserving the incumbent lock and state", windowsOnly, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-startup-owned-"));
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot);
  const runtimePath = path.join(stateRoot, "codex-app-server-proxy-runtime.json");
  const lockPath = path.join(stateRoot, "codex-app-server-proxy.lock");
  const token = randomUUID();
  const ports = await reservePorts();
  const holderCode = `const fs=require('node:fs');
    const [runner,runtimePath,lockPath,token]=process.argv.slice(1);
    const startedAt=new Date().toISOString();
    fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,token,startedAt}),{flag:'wx'});
    fs.writeFileSync(runtimePath,JSON.stringify({pid:process.pid,instanceToken:token,startedAt,state:'running'}));
    process.stdout.write('READY\\n');
    setInterval(()=>{},1000);`;
  const holder = spawn(process.execPath, ["-e", holderCode, runner, runtimePath, lockPath, token], {
    cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let launchedPid = null;
  let observedGone = false;
  try {
    await Promise.race([
      once(holder.stdout, "data"),
      once(holder, "exit").then(([code]) => { throw new Error(`fixture holder exited: ${code}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("fixture holder readiness timeout")), 5000); timer.unref(); }),
    ]);
    const originalState = fs.readFileSync(runtimePath);
    const originalLock = fs.readFileSync(lockPath);
    const receiptPath = path.join(root, "launch.json");
    const startToken = randomUUID();
    const script = `$ErrorActionPreference='Stop';
      & $env:STARTUP_TEST_ENTRY -DataRoot $env:STARTUP_TEST_ROOT -DownstreamPort ${ports[0]} -ControlPort ${ports[1]} -UpstreamPort ${ports[2]} -ProbePort ${ports[3]} -StartTimeoutMs 1000 -StartupTimeoutSeconds 120 -RequireNoStopMarker -ExpectedInstanceToken $env:STARTUP_TEST_TOKEN -LaunchReceiptPath $env:STARTUP_TEST_RECEIPT`;
    const startedAt = Date.now();
    const result = execute(script, { STARTUP_TEST_ENTRY: entry, STARTUP_TEST_ROOT: root,
      STARTUP_TEST_TOKEN: startToken, STARTUP_TEST_RECEIPT: receiptPath }, 20000);
    const elapsedMs = Date.now() - startedAt;
    if (fs.existsSync(receiptPath)) launchedPid = JSON.parse(fs.readFileSync(receiptPath, "utf8")).pid;
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined, result.error?.message);
    assert.match(result.stderr, /Codex App Server proxy exited immediately, exitCode=0/u);
    assert.doesNotMatch(result.stderr, /did not become ready within/u);
    assert.ok(elapsedMs < 20000, `exit detection took ${elapsedMs}ms`);
    assert.deepEqual(fs.readFileSync(runtimePath), originalState);
    assert.deepEqual(fs.readFileSync(lockPath), originalLock);
    assert.ok(launchedPid > 0);
    const check = execute("Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:STARTUP_TEST_PID) | Select-Object -ExpandProperty ProcessId", {
      STARTUP_TEST_PID: String(launchedPid),
    });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.stdout.trim(), "");
    observedGone = true;
    console.log(JSON.stringify({ entry, shell: "Windows PowerShell 5.1", elapsedMs, timeoutSeconds: 120,
      holderPid: holder.pid, launchedPid, launchedProcessAbsent: observedGone,
      preserved: ["runtime", "lock"], fixtureRoot: root, ports, productionActions: 0 }));
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, "exit");
      holder.kill();
      await exited;
    }
    if (launchedPid === null || observedGone) fs.rmSync(root, { recursive: true, force: true });
    else console.error(JSON.stringify({ retainedFixtureRoot: root, launchedPid, reason: "launched process absence not proven" }));
  }
});
