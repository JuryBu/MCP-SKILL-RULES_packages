import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { windowsPowerShellEnvironment } from '../src/windows-powershell-environment.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));

test('watchdog exits normally on its stop requirement and permits a later fresh start', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '看守正常退出 '));
  const ops = path.join(root, 'ops');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(ops);
  fs.mkdirSync(path.join(dataRoot, 'state'), { recursive: true });
  for (const name of ['Run-NapCatSupervisorWatchdog.ps1', 'resolve-napcat-data-root.ps1']) {
    fs.copyFileSync(path.join(sourceRoot, 'ops', name), path.join(ops, name));
  }
  for (const name of ['start-codex-model-stream-proxy.ps1', 'start-codex-app-server-proxy.ps1', 'start-napcat-supervisor.ps1']) {
    fs.writeFileSync(path.join(ops, name), 'param([string]$DataRoot,[string]$BrokerRoot)\n[IO.File]::AppendAllText((Join-Path $DataRoot "calls.txt"),$MyInvocation.MyCommand.Name+[Environment]::NewLine)\n');
  }
  const stopPath = path.join(dataRoot, 'state', 'supervisor-watchdog.stop');
  const environment = windowsPowerShellEnvironment();
  let active;
  const run = () => {
    const child = spawn(environment.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(ops, 'Run-NapCatSupervisorWatchdog.ps1'), '-DataRoot', dataRoot, '-IntervalSeconds', '10'], { env: environment.environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes.toString(); });
    const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, errors })); });
    active = { child, completed };
    return active;
  };
  try {
    for (const iteration of [1, 2]) {
      const execution = run();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const statePath = path.join(dataRoot, 'supervisor-watchdog.json');
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          if (state.pid === execution.child.pid && state.status === 'healthy') break;
        }
        await delay(50);
      }
      const state = JSON.parse(fs.readFileSync(path.join(dataRoot, 'supervisor-watchdog.json'), 'utf8'));
      assert.equal(state.pid, execution.child.pid);
      assert.equal(state.status, 'healthy');
      const before = fs.readFileSync(path.join(dataRoot, 'calls.txt'), 'utf8');
      const started = Date.now();
      fs.writeFileSync(stopPath, 'fixture owned stop', { flag: 'wx' });
      const result = await execution.completed;
      assert.equal(result.code, 0, result.errors);
      assert.ok(Date.now() - started < 2500);
      assert.equal(fs.readFileSync(path.join(dataRoot, 'calls.txt'), 'utf8'), before);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, 'supervisor-watchdog.json'), 'utf8')).status, 'stopped');
      fs.unlinkSync(stopPath);
      console.log(JSON.stringify({ iteration, normalExit: result.code, postStopStarts: 0, productionActions: 0 }));
    }
  } finally {
    if (active && active.child.exitCode === null) {
      if (!fs.existsSync(stopPath)) fs.writeFileSync(stopPath, 'fixture cleanup');
      await active.completed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy idle watchdog checker rejects model descendants, changed task and missing consent', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '空闲看守核查 '));
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(dataRoot, 'state', 'inner-managed'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'state', 'inner-managed', 'managed-runtime.json'), JSON.stringify({ coordinator: { workers: [] } }));
  const wrapper = fs.readFileSync(path.join(sourceRoot, 'ops', 'continue-startup-repair.ps1'), 'utf8');
  const start = wrapper.indexOf('function Stop-IdleWatchdog {');
  const end = wrapper.indexOf('\ntry {', start);
  assert.ok(start >= 0 && end > start);
  const functionPath = path.join(root, 'function.ps1');
  fs.writeFileSync(functionPath, wrapper.slice(start, end));
  const fixture = [
    "$ErrorActionPreference='Stop'; . $env:FIXTURE_FUNCTION",
    "$Settings=[pscustomobject]@{serviceOps=$env:FIXTURE_OPS;dataRoot=$env:FIXTURE_DATA;watchdogExecute=(Join-Path $env:SystemRoot 'System32\\wscript.exe');watchdogArguments='fixture action'}",
    "$WatchScript=Join-Path $Settings.serviceOps 'Run-NapCatSupervisorWatchdog.ps1'; $HiddenScript=Join-Path $Settings.serviceOps 'Run-HiddenPowerShell.vbs'",
    "$Base=@([pscustomobject]@{Name='wscript.exe';ProcessId=40001;ParentProcessId=2;ExecutablePath=$Settings.watchdogExecute;CommandLine=('\"'+$HiddenScript+'\" \"'+$WatchScript+'\" -DataRoot \"'+$Settings.dataRoot+'\"');CreationDate='fixture-root'},[pscustomobject]@{Name='powershell.exe';ProcessId=40002;ParentProcessId=40001;ExecutablePath=(Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');CommandLine=('-File \"'+$WatchScript+'\" -DataRoot \"'+$Settings.dataRoot+'\"');CreationDate='fixture-worker'})",
    "function Get-ScheduledTask {param($TaskName,$TaskPath);[pscustomobject]@{Actions=@([pscustomobject]@{Execute=$Settings.watchdogExecute;Arguments=$script:Arguments});Settings=[pscustomobject]@{Enabled=$false};State=$script:TaskState}}",
    "function Get-CimInstance {param($ClassName,$Filter,$ErrorAction);if($Filter){$Wanted=[int]($Filter.Split('=')[1]);$script:Processes|Where-Object{$_.ProcessId -eq $Wanted}}else{$script:Processes}}",
    "function Get-NetTCPConnection {param($State,$ErrorAction);@()}",
    "function Stop-ScheduledTask {param($TaskName,$TaskPath);if($TaskName -cne 'CodexNapCatSupervisor' -or $TaskPath -cne '\\'){throw 'WRONG_TASK'};$script:Stops++;$script:Processes=@()}",
    "$Cases=@('idle','console-idle','model-child','unknown-task','unresolved','no-consent','foreign-parent','foreign-console')",
    "foreach($Case in $Cases){$script:Processes=@($Base);$script:Stops=0;$script:TaskState='Running';$script:Arguments='fixture action';$Consent='APPLY_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG'",
    "if($Case -eq 'model-child'){$script:Processes+=[pscustomobject]@{Name='node.exe';ProcessId=40003;ParentProcessId=40002;ExecutablePath='fixture node';CommandLine='fixture';CreationDate='fixture-child'}}",
    "if($Case -in @('console-idle','foreign-console')){$script:Processes+=[pscustomobject]@{Name='conhost.exe';ProcessId=40004;ParentProcessId=40002;ExecutablePath=if($Case -eq 'console-idle'){Join-Path $env:SystemRoot 'System32\\conhost.exe'}else{'fixture foreign image'};CommandLine='fixture console';CreationDate='fixture-console'}}",
    "if($Case -eq 'unknown-task'){$script:Arguments='changed action'};if($Case -eq 'unresolved'){$script:Processes=@()};if($Case -eq 'no-consent'){$Consent=''};if($Case -eq 'foreign-parent'){$script:Processes=@($Base[1])}",
    "$Failure=$null;try{Stop-IdleWatchdog -Settings $Settings -Consent $Consent}catch{$Failure=$_.Exception.Message}",
    "if($Case -in @('idle','console-idle')){if($Failure -or $script:Stops -ne 1){throw ('IDLE_TEST_FAILED:'+$Failure)}}else{if(-not $Failure -or $script:Stops -ne 0){throw ('REJECTION_TEST_FAILED:'+$Case)}}",
    "[ordered]@{case=$Case;taskStops=$script:Stops;failure=$Failure}|ConvertTo-Json -Compress}"
  ].join('\n');
  const environment = windowsPowerShellEnvironment();
  try {
    const result = spawnSync(environment.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fixture], { env: { ...environment.environment, FIXTURE_FUNCTION: functionPath, FIXTURE_OPS: path.join(root, 'ops'), FIXTURE_DATA: dataRoot }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const cases = result.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.equal(cases.length, 8);
    assert.equal(cases[0].taskStops, 1);
    assert.equal(cases[1].taskStops, 1);
    assert.ok(cases.slice(2).every(item => item.taskStops === 0 && item.failure));
    console.log(JSON.stringify({ cases, actualWindowsTaskActions: 0, productionActions: 0 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
