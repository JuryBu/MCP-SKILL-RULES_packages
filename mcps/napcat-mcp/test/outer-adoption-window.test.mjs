import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.join(project, 'ops/manage-codex-outer-adoption-window.ps1');
const prepare = path.join(project, 'ops/prepare-codex-outer-adoption.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const seed = process.env.OUTER_PARENT_SOURCE_PREPARATION;
const seedSha = process.env.OUTER_PARENT_SOURCE_SHA256;
const enabled = process.platform === 'win32' && Boolean(seed && seedSha);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psexecutionpolicypreference'));
const sha = value => crypto.createHash('sha256').update(fs.readFileSync(value)).digest('hex');
const output = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'outer-parent-0800-')) : null;
const evidence = { startedAt: new Date().toISOString(), productionModified: false, paidModelCalls: false, serviceProcessesCreated: [], listenerPortsCreated: [], launchEvidenceKind: 'synthetic Temp launch/control contract; real Apply/Restore', commands: [], fixtures: [] };

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return target;
}

function invoke(script, values) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...Object.entries(values).flatMap(([name, value]) => [`-${name}`, String(value)])];
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const run = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true, timeout: 150000, env: environment });
  const record = { command: [shell, ...args], startedAt, elapsedMs: Date.now() - started, exitCode: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr };
  evidence.commands.push(record);
  assert.ok(!run.error, `${run.error?.message}\n${run.stderr}\n${run.stdout}`);
  let response;
  try { response = JSON.parse(run.stdout.trim()); } catch { assert.fail(`${run.stderr}\n${run.stdout}`); }
  record.response = response;
  return { ...run, response };
}

function launchFixture(fail = false) {
  return `[CmdletBinding()]\nparam([string]$DataRoot,[int]$DownstreamPort,[int]$ControlPort,[int]$UpstreamPort,[int]$ProbePort,[int]$ResumeTimeoutMs,[int]$StartTimeoutMs,[int]$StartupTimeoutSeconds,[string]$CodexExecutablePath,[switch]$RequireNoStopMarker)\n$ErrorActionPreference='Stop'\nif(Test-Path -LiteralPath (Join-Path $DataRoot 'state/codex-app-server-proxy.stop')){throw 'FIXTURE_STOP_PRESERVED'}\n${fail ? "throw 'MAPPED_INITIAL_START_FAILURE'" : "[pscustomobject]@{started=$true;state='running';fixture='synthetic-launch-contract'} | ConvertTo-Json -Compress"}\n`;
}

function fixture(label, { failStart = false, unknownControl = false, foreignStop = false } = {}) {
  const base = fs.mkdtempSync(path.join(output, `${label}-`));
  const sample = path.join(base, 'sample');
  const installed = path.join(sample, 'installed');
  const data = path.join(sample, 'data');
  const source = path.join(base, 'source-runtime-files');
  const prepared = path.join(base, 'prepared');
  const owner = 'outer-parent-0800-test';
  fs.cpSync(path.join(seed, 'original'), installed, { recursive: true, errorOnExist: true });
  fs.cpSync(path.join(seed, 'candidate'), source, { recursive: true, errorOnExist: true });
  write(installed, 'ops/start-codex-app-server-proxy.ps1', launchFixture());
  write(source, 'ops/start-codex-app-server-proxy.ps1', launchFixture(failStart));
  write(source, 'ops/codex-outer-runtime.mjs', `${foreignStop ? "import fs from 'node:fs';import path from 'node:path';const runtime=process.argv[process.argv.indexOf('--runtime-state')+1];fs.writeFileSync(path.join(path.dirname(runtime),'codex-app-server-proxy.stop'),JSON.stringify({ownerId:'another-owner',attemptId:'foreign'}));" : ''}\nprocess.stdout.write(JSON.stringify(${unknownControl || foreignStop ? "{ok:false,operationState:'unknown',error:{code:'MAPPED_UNKNOWN_CONTROL'}}" : "{ok:true,enabled:true,closed:false,moduleCount:1,fixture:'synthetic-control-contract'}"})+'\\n');${unknownControl || foreignStop ? 'process.exitCode=1;' : ''}\n`);
  fs.mkdirSync(path.join(data, 'state/codex-outer-runtime-candidates'), { recursive: true });
  for (const name of ['codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json']) write(data, `state/${name}`, `preserved ${name}\n`);
  const attemptId = crypto.randomUUID().replaceAll('-', '');
  const stopPath = write(data, 'state/codex-app-server-proxy.stop', { ownerId: owner, attemptId });
  const preparation = invoke(prepare, { SourceRoot: source, InstalledRoot: installed, DataRoot: data, PreparationRoot: prepared, OwnerId: owner });
  assert.equal(preparation.status, 0, preparation.stderr);
  const preparationSha256 = sha(path.join(prepared, 'preparation.json'));
  write(sample, '.outer-adoption-isolated-owner.json', { schemaVersion: 1, mode: 'TEMP_ISOLATED_RECOVERY', ownerId: owner, sampleRoot: sample, preparationRoot: prepared, preparationSha256 });
  const executable = write(base, 'codex.exe', 'unexecuted executable-path fixture\n');
  const parameters = write(base, 'startup-parameters.json', { DownstreamPort: 52101, ControlPort: 52102, UpstreamPort: 52103, ProbePort: 52104, ResumeTimeoutMs: 5000, StartTimeoutMs: 1000, StartupTimeoutSeconds: 30, CodexExecutablePath: executable });
  const planRoot = path.join(base, 'parent-plan');
  const planning = invoke(parent, { Action: 'Prepare', PreparationRoot: prepared, PreparationSha256: preparationSha256, OwnerId: owner, SampleRoot: sample, PlanRoot: planRoot, StartupParametersPath: parameters, PowerShellPath: shell, NodePath: process.execPath });
  assert.equal(planning.status, 0, JSON.stringify(planning.response));
  const binding = { PlanPath: planning.response.planPath, PlanSha256: planning.response.planSha256 };
  const record = { label, base, sample, preparationSha256, binding, originalStopSha256: sha(stopPath), syntheticLaunch: true };
  evidence.fixtures.push(record);
  return { base, sample, installed, data, prepared, owner, planRoot, binding, record, stopPath };
}

const parentBefore = sha(parent);
const originalHashes = ['ops/apply-codex-outer-adoption-isolated.ps1', 'ops/restore-codex-outer-adoption-isolated.ps1', 'ops/prepare-codex-outer-adoption.ps1', 'ops/start-codex-app-server-proxy.ps1', 'ops/codex-outer-runtime.mjs'].map(name => [name, sha(path.join(project, name))]);

async function actualParentCycle(fault) {
  const executable = process.env.OUTER_PARENT_OFFICIAL_EXECUTABLE;
  assert.equal(sha(executable), 'd13914ced6c7af174d8d638db938284231227312104b06a25e9608c632a7daec');
  const base = fs.mkdtempSync(path.join(output, fault === 'after-runtime' ? 'native-failed-after-runtime-' : fault ? 'native-failed-start-' : 'native-success-'));
  const sample = path.join(base, 'sample'); const installed = path.join(sample, 'installed'); const data = path.join(sample, 'data');
  const state = path.join(data, 'state'); const prepared = path.join(base, 'prepared'); const owner = 'outer-parent-native-0800';
  fs.cpSync(path.join(seed, 'original'), installed, { recursive: true, errorOnExist: true });
  fs.mkdirSync(state, { recursive: true });
  const home = path.join(sample, 'home'); const local = path.join(sample, 'local-app-data'); const bin = path.join(local, 'OpenAI/Codex/bin');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  for (const name of ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']) fs.copyFileSync(path.join(path.dirname(executable), name), path.join(bin, name));
  const ownEnv = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(CODEX|OPENAI|MCP)_/.test(name)));
  Object.assign(ownEnv, { CODEX_HOME: home, LOCALAPPDATA: local, CODEX_TOOLKIT_NODE_EXE: process.execPath, NO_PROXY: '127.0.0.1,localhost' });
  const blocker = http.createServer((request, response) => { response.writeHead(503); response.end('isolated no paid upstream'); });
  blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) ownEnv[name] = `http://127.0.0.1:${blocker.address().port}`;
  const ports = {};
  for (const name of ['DownstreamPort', 'ControlPort', 'UpstreamPort', 'ProbePort']) {
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); ports[name] = listener.address().port; await new Promise(resolve => listener.close(resolve));
  }
  const record = { label: fault ? 'actual-parent-start-failure' : 'actual-parent-success', base, sample, syntheticLaunch: false, ports, processes: [], productionModified: false, paidModelCalls: false };
  evidence.fixtures.push(record); evidence.listenerPortsCreated.push(...Object.values(ports), blocker.address().port);
  const run = async (script, values) => {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...Object.entries(values).flatMap(([name, value]) => [`-${name}`, String(value)])];
    const command = { command: [shell, ...args], startedAt: new Date().toISOString(), stdout: '', stderr: '' }; evidence.commands.push(command);
    const started = Date.now(); const child = spawn(shell, args, { env: ownEnv, windowsHide: true, cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
    command.pid = child.pid; child.stdout.on('data', bytes => command.stdout += bytes.toString('utf8')); child.stderr.on('data', bytes => command.stderr += bytes.toString('utf8'));
    const [exitCode, signal] = await once(child, 'close'); Object.assign(command, { exitCode, signal, elapsedMs: Date.now() - started });
    let response; try { response = JSON.parse(command.stdout.trim()); } catch { assert.fail(JSON.stringify(command)); }
    command.response = response; return { exitCode, response, command };
  };
  const runtimePath = path.join(state, 'codex-app-server-proxy-runtime.json'); const stopPath = path.join(state, 'codex-app-server-proxy.stop');
  const runtime = () => JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async predicate => { const deadline = Date.now() + 45000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('ACTUAL_PARENT_WAIT_TIMEOUT'); };
  let heldSocket;
  const readBusiness = async (keepOpen = false) => {
    const { WebSocket } = createRequire(path.join(installed, 'package.json'))('ws'); const socket = new WebSocket(runtime().downstreamUrl); await once(socket, 'open');
    const rpc = async (id, method, params) => { socket.send(JSON.stringify({ id, method, params })); for (;;) { const [bytes] = await once(socket, 'message', { signal: AbortSignal.timeout(15000) }); const message = JSON.parse(bytes.toString()); if (message.id === id) { assert.ok(!message.error, JSON.stringify(message)); return message.result; } } };
    try { const initialized = await rpc(1, 'initialize', { clientInfo: { name: 'outer_parent_native', version: '1' }, capabilities: { experimentalApi: true } }); assert.match(initialized.userAgent, /0\.162\.0-alpha\.17\.2/); socket.send(JSON.stringify({ method: 'initialized', params: {} })); const listed = await rpc(2, 'thread/list', { limit: 1 }); assert.ok(Array.isArray(listed.data)); record.lastBusinessRead = initialized.userAgent; }
    finally { if (keepOpen) heldSocket = socket; else { const closing = once(socket, 'close'); socket.close(); await closing; } }
  };
  let watcher;
  try {
    const baseline = await run(path.join(installed, 'ops/start-codex-app-server-proxy.ps1'), { DataRoot: data, ...ports, ResumeTimeoutMs: 5000, StartTimeoutMs: 15000, StartupTimeoutSeconds: 60 });
    assert.equal(baseline.exitCode, 0, JSON.stringify(baseline)); record.processes.push(runtime().pid, runtime().appServerPid); await readBusiness(true);
    record.knownReadOnlyRehearsalClient = { pendingRequests: 0, methodsCompleted: ['initialize', 'thread/list'], socketHeldUntilOwnedStop: true };
    let candidateSource = path.join(seed, 'candidate');
    const publicationFault = fault === 'missing-receipt' || fault === 'partial-receipt';
    if (fault === 'after-runtime') {
      candidateSource = path.join(base, 'post-runtime-fault-artifact');
      fs.cpSync(path.join(seed, 'candidate'), candidateSource, { recursive: true, errorOnExist: true });
      const runnerScript = path.join(candidateSource, 'src/codex-app-server-proxy-runner.mjs');
      const source = fs.readFileSync(runnerScript, 'utf8');
      const point = /    persist\(\);\r?\n    const journal =/;
      assert.equal(point.test(source), true);
      fs.writeFileSync(runnerScript, source.replace(point, "    persist();\n    throw new Error('TEST_AFTER_RUNTIME_BEFORE_LIVE_BINDING');\n    const journal ="));
      record.postRuntimeExceptionInjectedOnlyInFixture = true;
    }
    if (publicationFault) {
      candidateSource = path.join(base, 'publication-fault-artifact');
      fs.cpSync(path.join(seed, 'candidate'), candidateSource, { recursive: true, errorOnExist: true });
      const launchScript = path.join(candidateSource, 'ops/start-codex-app-server-proxy.ps1');
      const proofPath = path.join(base, 'actual-start-before-publication.json');
      const partialWrite = fault === 'partial-receipt' ? "[IO.File]::WriteAllText($LaunchReceiptPath, '{', (New-Object Text.UTF8Encoding($false)))" : '';
      const injection = `[pscustomobject]@{pid=$Process.Id;createdAt=$Process.StartTime.ToUniversalTime().ToString('o');instanceToken=$ExpectedInstanceToken} | ConvertTo-Json -Compress | Set-Content -LiteralPath '${proofPath}' -Encoding UTF8\n  ${partialWrite}\n  throw 'TEST_AFTER_REAL_START_BEFORE_PUBLICATION'\n`;
      const source = fs.readFileSync(launchScript, 'utf8');
      assert.equal(source.includes('  $ReceiptStream = [IO.File]::Open('), true);
      fs.writeFileSync(launchScript, source.replace('  $ReceiptStream = [IO.File]::Open(', injection + '  $ReceiptStream = [IO.File]::Open('));
      record.publicationFaultProofPath = proofPath;
    }
    const preparation = await run(prepare, { SourceRoot: candidateSource, InstalledRoot: installed, DataRoot: data, PreparationRoot: prepared, OwnerId: owner }); assert.equal(preparation.exitCode, 0, JSON.stringify(preparation));
    const preparationSha256 = sha(path.join(prepared, 'preparation.json'));
    write(sample, '.outer-adoption-isolated-owner.json', { schemaVersion: 1, mode: 'TEMP_ISOLATED_RECOVERY', ownerId: owner, sampleRoot: sample, preparationRoot: prepared, preparationSha256 });
    const status = await fetch(runtime().controlUrl + '/v1/status', { headers: { authorization: 'Bearer ' + fs.readFileSync(path.join(state, 'codex-app-server-proxy-token.txt'), 'utf8').trim() }, signal: AbortSignal.timeout(5000) }).then(response => response.json());
    assert.equal(status.clientCount, 1);
    write(sample, '.legacy-readonly-rehearsal.json', { ownerId: owner, scope: 'outer-parent-readonly-legacy-rehearsal', actorPid: process.pid, actorSourceSha256: sha(fileURLToPath(import.meta.url)), connectedAt: status.clients[0].connectedAt, pendingRequests: 0, mutatingRequests: 0, methodsCompleted: ['initialize', 'thread/list'] });
    const parameters = write(base, 'startup-parameters.json', { ...ports, ResumeTimeoutMs: 5000, StartTimeoutMs: 15000, StartupTimeoutSeconds: 60, CodexExecutablePath: runtime().executablePath });
    const planRoot = path.join(base, 'parent-plan');
    const planning = await run(parent, { Action: 'Prepare', PreparationRoot: prepared, PreparationSha256: preparationSha256, OwnerId: owner, SampleRoot: sample, PlanRoot: planRoot, StartupParametersPath: parameters, PowerShellPath: shell, NodePath: process.execPath }); assert.equal(planning.exitCode, 0, JSON.stringify(planning));
    const binding = { PlanPath: planning.response.planPath, PlanSha256: planning.response.planSha256 }; record.binding = binding;
    const protectedBytes = ['codex-app-server-proxy-token.txt', 'codex-app-server-wake-journal.json'].filter(name => fs.existsSync(path.join(state, name))).map(name => [name, sha(path.join(state, name))]);
    let faulted = false;
    const originalInstanceToken = runtime().instanceToken;
    if (fault === 'after-runtime') watcher = fs.watch(state, (event, filename) => {
      if (String(filename) !== 'codex-app-server-proxy-runtime.json' || !fs.existsSync(runtimePath)) return;
      let current; try { current = runtime(); } catch { return; }
      if (current.instanceToken === originalInstanceToken) return;
      if (!faulted && ['starting', 'degraded'].includes(current.state)) {
        record.failedStartupInstanceToken = current.instanceToken;
        record.processes.push(current.pid);
        faulted = true;
      }
      if (faulted && current.instanceToken === record.failedStartupInstanceToken && current.startupTerminalClean === true) {
        record.failedStartupTerminal = { state: current.state, pid: current.pid, instanceToken: current.instanceToken, clean: current.startupTerminalClean, childPids: current.startupChildPids };
        record.processes.push(...(current.startupChildPids ?? []));
      }
    });
    else if (publicationFault) faulted = true;
    else if (fault) watcher = fs.watch(state, (event, filename) => { if (!faulted && String(filename) === 'codex-outer-runtime-startup.json' && fs.existsSync(path.join(state, String(filename)))) { const saved = JSON.parse(fs.readFileSync(path.join(state, String(filename)), 'utf8')); if (saved.enabled === true && fs.existsSync(saved.candidateRoot)) { fs.renameSync(saved.candidateRoot, saved.candidateRoot + '-owned-fault'); faulted = true; } } });
    const applied = await run(parent, { Action: 'TempApply', ...binding }); record.parent = applied.response;
    if (fault) { assert.equal(applied.exitCode, 1, JSON.stringify(applied)); assert.equal(applied.response.status, 'failed-restored', JSON.stringify(applied)); assert.equal(faulted, true); assert.match(applied.response.initialFailure, /candidate-start/); }
    else { assert.equal(applied.exitCode, 0, JSON.stringify(applied)); assert.equal(applied.response.status, 'temp-applied'); }
    record.processes.push(runtime().pid, runtime().appServerPid); await readBusiness();
    if (fault) {
      if (publicationFault) {
        const proof = JSON.parse(fs.readFileSync(record.publicationFaultProofPath, 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(alive(proof.pid), false);
        const attempt = JSON.parse(fs.readFileSync(applied.response.attemptPath, 'utf8'));
        assert.equal(attempt.candidateLaunch.instanceToken, proof.instanceToken);
        assert.equal(attempt.candidateIdentity, null);
        assert.notEqual(runtime().instanceToken, proof.instanceToken);
        record.processes.push(proof.pid);
        record.realStartUnpublishedRuntimePreservedAndRestored = true;
      }
      if (fault === 'after-runtime') {
        const attempt = JSON.parse(fs.readFileSync(applied.response.attemptPath, 'utf8'));
        assert.notEqual(record.failedStartupInstanceToken, originalInstanceToken);
        assert.equal(attempt.candidateIdentity, null);
        assert.equal(attempt.candidateLaunch.instanceToken, record.failedStartupInstanceToken);
        assert.equal(record.failedStartupTerminal.clean, true);
        assert.equal(record.failedStartupTerminal.state, 'degraded');
        record.failedAfterRuntimeBeforeLiveBindingRecoveryPassed = true;
      }
      const recoveredIdentity = runtime();
      const repeatedRecovery = await run(parent, { Action: 'RecoverWindow', ...binding });
      assert.equal(repeatedRecovery.exitCode, 0, JSON.stringify(repeatedRecovery));
      assert.equal(repeatedRecovery.response.status, 'already-restored-verified');
      assert.equal(runtime().pid, recoveredIdentity.pid);
      record.automaticRecoveryReentryPassed = true;
    } else {
      record.candidateHealthy = true;
      const plan = JSON.parse(fs.readFileSync(binding.PlanPath, 'utf8'));
      const receipt = JSON.parse(fs.readFileSync(path.join(plan.transaction.contractRoot, 'transaction-attempt.json'), 'utf8'));
      record.candidateInstance = receipt.candidateInstance;
      assert.equal(receipt.candidateInstance.instanceToken, runtime().instanceToken);
      const restored = await run(parent, { Action: 'RecoverWindow', ...binding }); record.explicitRestore = restored.response;
      assert.equal(restored.exitCode, 0, JSON.stringify(restored)); assert.equal(restored.response.status, 'window-restored');
      record.processes.push(runtime().pid, runtime().appServerPid);
      await readBusiness();
      const attempt = JSON.parse(fs.readFileSync(path.join(planRoot, 'attempt.json'), 'utf8'));
      const stopEvidence = JSON.parse(fs.readFileSync(attempt.stopEvidence.path, 'utf8'));
      assert.equal(stopEvidence.instanceToken, receipt.candidateInstance.instanceToken);
      assert.equal(stopEvidence.parentAttemptId, plan.attemptId);
      assert.equal(stopEvidence.marker.PathState, 'Missing');
      record.restoredCandidateStopEvidence = stopEvidence;
      const healthyIdentity = runtime();
      const verifiedRestore = await run(parent, { Action: 'RecoverWindow', ...binding });
      assert.equal(verifiedRestore.exitCode, 0, JSON.stringify(verifiedRestore));
      assert.equal(verifiedRestore.response.status, 'already-restored-verified');
      assert.equal(runtime().pid, healthyIdentity.pid);
      const cleanupMarker = JSON.stringify({ ownerId: owner, cleanup: true });
      fs.writeFileSync(stopPath, cleanupMarker, { flag: 'wx' });
      await until(() => !alive(healthyIdentity.pid) && !alive(healthyIdentity.appServerPid));
      assert.equal(fs.readFileSync(stopPath, 'utf8'), cleanupMarker);
      fs.unlinkSync(stopPath);
      const restartedRestore = await run(parent, { Action: 'RecoverWindow', ...binding });
      assert.equal(restartedRestore.exitCode, 0, JSON.stringify(restartedRestore));
      assert.equal(restartedRestore.response.status, 'already-restored-verified');
      record.processes.push(runtime().pid, runtime().appServerPid);
      await readBusiness();
      record.restoredStoppedServiceRestartPassed = true;
    }
    for (const [name, digest] of protectedBytes) assert.equal(sha(path.join(state, name)), digest);
    record.normalParentChainPassed = true;
  } finally {
    watcher?.close();
    if (heldSocket && heldSocket.readyState < 2) { const closing = once(heldSocket, 'close'); heldSocket.close(); await closing; }
    if (fs.existsSync(runtimePath) && runtime().state === 'running') {
      const owned = runtime(); assert.ok(record.processes.includes(owned.pid));
      const cleanup = JSON.stringify({ ownerId: owner, cleanup: true });
      if (!fs.existsSync(stopPath)) fs.writeFileSync(stopPath, cleanup, { flag: 'wx' });
      else assert.equal(fs.readFileSync(stopPath, 'utf8'), cleanup);
      await until(() => ['stopped', 'stopping'].includes(runtime().state) && !alive(owned.pid) && !alive(owned.appServerPid));
      if (fs.existsSync(stopPath)) assert.equal(fs.readFileSync(stopPath, 'utf8'), cleanup);
      record.cleanup = { proxyPid: owned.pid, childPid: owned.appServerPid, metadataState: runtime().state, stopPreserved: fs.existsSync(stopPath) };
    }
    await new Promise(resolve => blocker.close(resolve));
    record.processesEnded = record.processes.every(pid => !alive(pid)); assert.equal(record.processesEnded, true);
    try {
      const { cleanupOwnedRuntimeCopies } = await import('./owned-runtime-copy-cleanup.mjs');
      const bundleRoot = path.join(state, 'codex-runtime-bundles');
      const runtimeDirectories = [bin, ...(fs.existsSync(bundleRoot) ? fs.readdirSync(bundleRoot, { withFileTypes: true })
        .filter(item => item.isDirectory()).map(item => path.join(bundleRoot, item.name)) : [])];
      record.runtimeCopyCleanup = cleanupOwnedRuntimeCopies({ ownedRoot: base, processIds: record.processes,
        copies: runtimeDirectories.flatMap(directory => ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
          .map(name => ({ targetPath: path.join(directory, name), sourcePath: path.join(path.dirname(executable), name) }))) });
    } catch (error) {
      record.runtimeCopyCleanup = { state: 'preserved-cleanup-failure', error: error.message };
    }
    evidence.serviceProcessesCreated.push(...record.processes);
  }
}

test('actual alpha17.2 parent Apply and independent RecoverWindow normal old Start read', { skip: !enabled || !process.env.OUTER_PARENT_OFFICIAL_EXECUTABLE }, () => actualParentCycle(false));
test('actual alpha17.2 parent candidate Start failure independent Restore old Start read', { skip: !enabled || !process.env.OUTER_PARENT_OFFICIAL_EXECUTABLE }, () => actualParentCycle(true));
test('actual alpha17.2 new runtime before live binding failure restores old Start read', { skip: !enabled || !process.env.OUTER_PARENT_OFFICIAL_EXECUTABLE }, () => actualParentCycle('after-runtime'));
test('actual alpha17.2 missing launch receipt restores old Start read', { skip: !enabled || !process.env.OUTER_PARENT_OFFICIAL_EXECUTABLE }, () => actualParentCycle('missing-receipt'));
test('actual alpha17.2 partial launch receipt restores old Start read', { skip: !enabled || !process.env.OUTER_PARENT_OFFICIAL_EXECUTABLE }, () => actualParentCycle('partial-receipt'));

if (enabled) {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(seed));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(sha(path.join(seed, 'preparation.json')), seedSha);
  const manifest = JSON.parse(fs.readFileSync(path.join(seed, 'preparation.json'), 'utf8'));
  for (const entry of [...manifest.files, ...manifest.dependency.files]) for (const side of ['original', 'candidate']) if (entry[side].exists) assert.equal(sha(path.join(seed, side, entry.name)), entry[side].sha256);
}

test('default Inspect refuses missing identity before writes', { skip: process.platform !== 'win32' }, () => {
  const run = invoke(parent, {});
  assert.equal(run.status, 1);
  assert.equal(run.response.productionModified, false);
  assert.match(run.response.error, /OUTER_ABSOLUTE_PLAIN_PATH_REQUIRED/);
});

test('frozen guardian preserves a foreign stop in original PowerShell and Node cleanup', { skip: !enabled }, () => {
  const example = fixture('frozen-stop-guardian');
  const plan = JSON.parse(fs.readFileSync(example.binding.PlanPath, 'utf8'));
  write(example.data, 'state/codex-app-server-proxy.stop', { ownerId: 'external-test-owner', nonce: crypto.randomUUID() });
  const before = sha(example.stopPath);
  const guarded = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', plan.oldStartGuardFiles[0].path, '-PlanPath', example.binding.PlanPath, '-PlanSha256', example.binding.PlanSha256], { encoding: 'utf8', windowsHide: true, env: environment });
  assert.equal(guarded.status, 1);
  assert.equal(sha(example.stopPath), before);
  const nodeGuard = spawnSync(process.execPath, ['--require', plan.oldStartGuardFiles[1].path, '-e', 'require("node:fs").rmSync(process.argv[1],{force:true})', example.stopPath], { encoding: 'utf8', windowsHide: true, env: { ...environment, OUTER_ORIGINAL_STOP_GUARD_PATH: example.stopPath } });
  assert.equal(nodeGuard.status, 1);
  assert.match(nodeGuard.stderr, /OUTER_FOREIGN_STOP_MARKER_PRESERVED/);
  assert.equal(sha(example.stopPath), before);
  const guardSource = fs.readFileSync(plan.oldStartGuardFiles[0].path, 'utf8');
  const nodeOptionsAssignment = guardSource.match(/^\$env:NODE_OPTIONS=.+$/m)?.[0];
  assert.ok(nodeOptionsAssignment);
  const spacedPreload = write(example.base, 'preload with spaces/stop guard.cjs', fs.readFileSync(plan.oldStartGuardFiles[1].path, 'utf8'));
  const loadProbe = write(example.base, 'preload with spaces/load probe.cjs', 'process.stdout.write("OUTER_GUARD_LOADED");\n');
  const removalProbe = write(example.base, 'preload with spaces/removal probe.cjs', 'require("node:fs").rmSync(process.env.OUTER_ORIGINAL_STOP_GUARD_PATH,{force:true});\n');
  for (const preloadPath of [plan.oldStartGuardFiles[1].path, spacedPreload]) {
    const script = `$ErrorActionPreference='Stop'; $Binding=Get-Content -LiteralPath $env:OUTER_GUARD_TEST_PLAN -Encoding UTF8 -Raw|ConvertFrom-Json; $Binding.oldStartGuardFiles[1].path=$env:OUTER_GUARD_TEST_PRELOAD; ${nodeOptionsAssignment}; & $env:OUTER_GUARD_TEST_NODE $env:OUTER_GUARD_TEST_PROBE; exit $LASTEXITCODE`;
    const preloadRun = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...environment, NODE_OPTIONS: '', OUTER_GUARD_TEST_PLAN: example.binding.PlanPath, OUTER_GUARD_TEST_PRELOAD: preloadPath, OUTER_GUARD_TEST_NODE: process.execPath, OUTER_GUARD_TEST_PROBE: loadProbe, OUTER_ORIGINAL_STOP_GUARD_PATH: example.stopPath } });
    assert.equal(preloadRun.status, 0, preloadRun.stderr);
    assert.equal(preloadRun.stdout, 'OUTER_GUARD_LOADED');
    const preloadRemoval = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...environment, NODE_OPTIONS: '', OUTER_GUARD_TEST_PLAN: example.binding.PlanPath, OUTER_GUARD_TEST_PRELOAD: preloadPath, OUTER_GUARD_TEST_NODE: process.execPath, OUTER_GUARD_TEST_PROBE: removalProbe, OUTER_ORIGINAL_STOP_GUARD_PATH: example.stopPath } });
    assert.equal(preloadRemoval.status, 1);
    assert.match(preloadRemoval.stderr, /OUTER_FOREIGN_STOP_MARKER_PRESERVED/);
    assert.equal(sha(example.stopPath), before);
    example.record.nodeOptionsPreloads ??= [];
    example.record.nodeOptionsPreloads.push({ preloadPath, loadExit: preloadRun.status, foreignStopExit: preloadRemoval.status, stopSha256: before });
  }
  example.record.frozenGuardianPreservedForeignStop = { powershellExit: guarded.status, nodeExit: nodeGuard.status, sha256: before };
  evidence.commands.push({ command: [shell, '-File', plan.oldStartGuardFiles[0].path], exitCode: guarded.status, stdout: guarded.stdout, stderr: guarded.stderr }, { command: [process.execPath, '--require', plan.oldStartGuardFiles[1].path], exitCode: nodeGuard.status, stdout: nodeGuard.stdout, stderr: nodeGuard.stderr });
});

test('parent maps success, already-written verification, production refusal and independent restoration', { skip: !enabled }, () => {
  const example = fixture('success');
  const verify = invoke(parent, { Action: 'VerifyOnly', ...example.binding });
  assert.equal(verify.status, 0, JSON.stringify(verify.response));
  assert.equal(fs.existsSync(path.join(example.planRoot, 'attempt.json')), false);
  const refusal = invoke(parent, { Action: 'ExecuteWindow', ...example.binding });
  assert.equal(refusal.status, 1);
  assert.equal(refusal.response.error, 'OUTER_NEW_OWNER_WINDOW_REQUIRED');
  assert.equal(fs.existsSync(path.join(example.planRoot, 'attempt.json')), false);
  const plan = JSON.parse(fs.readFileSync(example.binding.PlanPath, 'utf8'));
  const expiredFixture = write(example.base, 'expired-window-test-input.json', { testFixture: true, authorization: false, scope: plan.scope, ownerId: plan.ownerId, planSha256: example.binding.PlanSha256, preparationSha256: plan.preparationSha256, parentSha256: plan.inputs[0].sha256, expiresAt: '2000-01-01T00:00:00Z' });
  const expired = invoke(parent, { Action: 'ExecuteWindow', ...example.binding, WindowPath: expiredFixture, WindowSha256: sha(expiredFixture) });
  assert.equal(expired.status, 1);
  assert.equal(expired.response.error, 'OUTER_OWNER_WINDOW_EXPIRED');
  assert.equal(fs.existsSync(path.join(example.planRoot, 'attempt.json')), false);
  const apply = invoke(parent, { Action: 'TempApply', ...example.binding });
  assert.equal(apply.status, 0, JSON.stringify(apply.response));
  assert.equal(apply.response.status, 'temp-applied');
  const attemptPath = path.join(example.planRoot, 'attempt.json');
  const saved = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
  assert.equal(saved.commands[0].response.completed.length, 20);
  assert.equal(saved.ownedStopRemoved, true);
  assert.equal(saved.commands.length, 3);
  assert.ok(saved.commands[1].command.includes('-DownstreamPort'));
  assert.ok(saved.commands[1].command.includes('52101'));
  const attemptSha = sha(attemptPath);
  const duplicate = invoke(parent, { Action: 'TempApply', ...example.binding });
  assert.equal(duplicate.status, 0, JSON.stringify(duplicate.response));
  assert.equal(duplicate.response.status, 'already-written-verified');
  assert.equal(sha(attemptPath), attemptSha);
  const restored = invoke(parent, { Action: 'TempRestore', ...example.binding });
  assert.equal(restored.status, 0, JSON.stringify(restored.response));
  assert.equal(restored.response.status, 'restored');
  assert.equal(invoke(parent, { Action: 'VerifyOnly', ...example.binding }).status, 0);
  example.record.successAndIndependentRestore = true;
});

test('initial startup failure remains exit1 after all20 and original-entry recovery', { skip: !enabled }, () => {
  const example = fixture('start-failure', { failStart: true });
  const run = invoke(parent, { Action: 'TempApply', ...example.binding });
  assert.equal(run.status, 1, JSON.stringify(run.response));
  assert.equal(run.response.status, 'failed-restored');
  assert.match(run.response.initialFailure, /candidate-start.*exit=1/);
  const saved = JSON.parse(fs.readFileSync(path.join(example.planRoot, 'attempt.json'), 'utf8'));
  assert.match(saved.commands[1].output, /MAPPED_INITIAL_START_FAILURE/);
  assert.equal(saved.commands[2].response.completed.length, 20);
  assert.equal(saved.commands[3].name, 'original-start-after-recovery');
  assert.equal(saved.commands[3].exitCode, 0);
  assert.equal(saved.status, 'restored');
  assert.equal(invoke(parent, { Action: 'TempApply', ...example.binding }).status, 1);
  example.record.initialFailurePreserved = true;
});

test('unknown management result and a foreign stop marker retain distinct recovery-required state', { skip: !enabled }, () => {
  const example = fixture('unknown-foreign', { foreignStop: true });
  const run = invoke(parent, { Action: 'TempApply', ...example.binding });
  assert.equal(run.status, 1, JSON.stringify(run.response));
  assert.equal(run.response.status, 'recovery-required');
  assert.match(run.response.initialFailure, /candidate-management-status/);
  assert.equal(run.response.recoveryFailure, 'OUTER_FOREIGN_STOP_MARKER_PRESERVED');
  assert.equal(JSON.parse(fs.readFileSync(example.stopPath, 'utf8')).ownerId, 'another-owner');
  const before = sha(path.join(example.planRoot, 'attempt.json'));
  const repeat = invoke(parent, { Action: 'TempApply', ...example.binding });
  assert.equal(repeat.status, 1);
  assert.equal(sha(path.join(example.planRoot, 'attempt.json')), before);
  example.record.foreignMarkerPreserved = true;
});

test('in-progress attempt never repeats child execution', { skip: !enabled }, () => {
  const example = fixture('interrupted');
  const plan = JSON.parse(fs.readFileSync(example.binding.PlanPath, 'utf8'));
  const attempt = write(example.planRoot, 'attempt.json', { schemaVersion: 1, ownerId: example.owner, attemptId: plan.attemptId, planSha256: example.binding.PlanSha256, status: 'in-progress', phase: 'candidate-start', commands: [] });
  const before = sha(attempt);
  const run = invoke(parent, { Action: 'TempApply', ...example.binding });
  assert.equal(run.status, 1);
  assert.equal(run.response.error, 'OUTER_ATTEMPT_STATE_UNKNOWN_OR_TERMINAL');
  assert.equal(sha(attempt), before);
});

after(() => {
  evidence.finishedAt = new Date().toISOString();
  evidence.parentSha256 = sha(parent);
  evidence.testSha256 = sha(fileURLToPath(import.meta.url));
  evidence.originalSourcesUnchanged = originalHashes.every(([name, hash]) => sha(path.join(project, name)) === hash);
  evidence.parentUnchanged = sha(parent) === parentBefore;
  evidence.originalSourceHashes = originalHashes;
  if (output) {
    const result = write(output, 'result.json', evidence);
    process.stdout.write(`PARENT_EVIDENCE ${JSON.stringify({ result, sha256: sha(result), fixtures: evidence.fixtures.length, originalSourcesUnchanged: evidence.originalSourcesUnchanged })}\n`);
  }
});
