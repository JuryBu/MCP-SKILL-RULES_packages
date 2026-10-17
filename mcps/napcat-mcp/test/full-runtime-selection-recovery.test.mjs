import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSelectionRecovery, assertOfflineSelectionStopped, selectionFileHash } from '../ops/full-runtime-selection-recovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = process.env.OWNER_TEST_POWERSHELL ?? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(context, faultAfterReplace = false, startupProtection = 'desktop-gate') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-selection-中文 space-'));
  if (process.env.OFFLINE_PREPARE_FIXTURE !== '1') context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (filename, value) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value)); return filename; };
  write(path.join(directory, 'offline-owner.json'), { ownerId: 'offline-selection-test' });
  const state = path.join(directory, 'state');
  const inner = path.join(state, 'inner');
  const candidateRoot = path.join(directory, 'candidates');
  const backendStop = startupProtection === 'backend-stop';
  const sourceNames = { runner: 'codex-model-stream-proxy-runner.mjs', core: 'codex-model-stream-proxy.mjs', helper: 'thread-recovery-handoff.mjs', control: 'inner-runner-handoff-control.mjs' };
  const initial = backendStop ? Object.fromEntries(Object.entries(sourceNames).map(([name, filename]) => [name, selectionFileHash(path.join(root, 'src', filename))])) : { core: digest('initial'), helper: digest('helper') };
  const candidates = [];
  const selections = [];
  for (const id of ['original', 'rollback']) {
    const installationRoot = path.join(candidateRoot, id);
    const names = ['codex-model-stream-proxy-runner.mjs', 'codex-model-stream-proxy.mjs', 'thread-recovery-handoff.mjs', 'inner-runner-handoff-control.mjs', 'proxy.cjs', ...Array.from({ length: 43 }, (_, index) => `file-${index}.mjs`)];
    const files = names.map(name => ({ path: name, sha256: digest(fs.readFileSync(write(path.join(installationRoot, 'src', name), id + name))) }));
    write(path.join(installationRoot, '.inner-runtime-owner.json'), { kind: 'candidate', ownerId: 'fixture', nativeSourceId: 'native' });
    const manifestPath = write(path.join(installationRoot, 'src/manifest.json'), { schemaVersion: 1, stateSchema: 'proxy-live-state-v1', format: 'commonjs-bundle', entry: 'proxy.cjs', files });
    const expectedHashes = Object.fromEntries(['runner', 'core', 'helper', 'control'].map((name, index) => [name, files[index].sha256]));
    candidates.push({ id, installationRoot, expectedHashes });
    const manifest = { schemaVersion: 1, edges: [{ source: initial, target: { core: expectedHashes.core, helper: expectedHashes.helper }, checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: 'state-v1' }] };
    selections.push({ candidateId: id, manifestPath, manifestSha256: selectionFileHash(manifestPath), compatibility: { manifest, sha256: digest(JSON.stringify(manifest)) } });
  }
  const source = { schemaVersion: 1, ownerId: 'fixture', candidates, retainedHistory: ['UNKNOWN', 'completed'], selection: selections[0] };
  const target = { ...source, selection: selections[1] };
  const sourceRegistryPath = write(path.join(directory, 'source.json'), source);
  const targetRegistryPath = write(path.join(directory, 'target.json'), target);
  const registryPath = write(path.join(inner, 'inner-candidate-approvals.json'), source);
  const stopPath = path.join(state, backendStop ? 'codex-app-server-proxy.stop' : 'proxy.stop');
  const lockPath = path.join(state, backendStop ? 'codex-app-server-proxy.lock' : 'proxy.lock');
  const recoveryGuardPath = lockPath + '.recovery';
  const outerPaths = { stopFilePath: stopPath, lockPath };
  for (const name of ['runtimeStatePath', 'logPath', 'journalPath', 'tokenFilePath', 'maintenanceFilePath', 'alertFilePath', 'fallbackFilePath']) outerPaths[name] = path.join(state, name + '.json');
  const profile = { ownerId: 'fixture', nativeSourceId: 'native', stateRoot: inner, initial: { expectedHashes: initial }, outerPaths };
  if (backendStop) {
    const checkpointRoot = path.join(directory, 'checkpoints');
    const codexHome = path.join(directory, 'codex-home');
    fs.mkdirSync(codexHome);
    write(path.join(checkpointRoot, '.inner-runtime-owner.json'), { schemaVersion: 1, kind: 'checkpoint', ownerId: 'fixture', nativeSourceId: 'native' });
    Object.assign(profile, { schemaVersion: 1, mode: 'production', installationRoot: root, outerStateRoot: state, checkpointRoot, codexHome,
      managedStatePath: path.join(inner, 'managed.json'), upstreamOrigin: 'http://127.0.0.1:29435', innerPort: 29435,
      ports: { control: 29431, downstream: 29432, upstream: 29433, probe: 29434, inner: 29435 },
      initial: { runnerPath: path.join(root, 'src/codex-model-stream-proxy-runner.mjs'), expectedHashes: initial } });
  }
  const profilePath = write(path.join(inner, 'profile.json'), profile);
  const ownerPath = write(path.join(inner, '.inner-runtime-owner.json'), { schemaVersion: 1, kind: 'state', ownerId: 'fixture', nativeSourceId: 'native' });
  const startupGatePath = write(path.join(directory, 'desktop-startup.lock'), '');
  const fenceFiles = ['launch.ps1', 'runner.mjs', 'residual.mjs'].map(name => write(path.join(directory, 'fence', name), 'fixture'));
  const entryPath = path.join(root, 'ops/recover-full-runtime-selection.ps1');
  const ioPath = path.join(root, 'ops/full-runtime-selection-recovery.mjs');
  const proofPath = path.join(root, 'ops/full-runtime-recovery-proof.mjs');
  const pins = [entryPath, ioPath, proofPath, process.execPath, profilePath, ownerPath, sourceRegistryPath, targetRegistryPath, ...fenceFiles].map(filename => ({ path: filename, sha256: selectionFileHash(filename) }));
  const capturedProcesses = [100, 101].map((pid, index) => ({ pid, parentPid: index ? 100 : 1, creationDate: '2030-01-02T03:00:00.000Z', executablePath: 'C:/fixture/node.exe', commandLineSha256: digest('captured') }));
  const config = { schemaVersion: 1, mode: 'TempFixture', fixtureRoot: directory, entryPath, ioPath, proofPath, nodePath: process.execPath,
    profilePath, sourceRegistryPath, targetRegistryPath, registryPath, candidateRoot, stopPath, recoveryGuardPath, startupGatePath, fenceFiles,
    capturedProcesses, ports: [29431, 29432, 29433, 29434, 29435], pins, faultAfterReplace };
  if (backendStop) {
    fs.unlinkSync(startupGatePath);
    delete config.startupGatePath;
    config.startupProtection = startupProtection;
    config.backendStartup = { entryPath: path.join(root, 'ops/start-codex-app-server-proxy.ps1'),
      runnerPath: path.join(root, 'src/codex-app-server-proxy-runner.mjs'),
      configurationPath: write(path.join(state, 'codex-outer-runtime-startup.json'), { schemaVersion: 1, enabled: true, candidateRoot,
        innerManagedProfilePath: profilePath, innerManagedProfileSha256: selectionFileHash(profilePath) }) };
    for (const filename of [config.backendStartup.entryPath, config.backendStartup.runnerPath, config.backendStartup.configurationPath,
      path.join(root, 'ops/resolve-codex-outer-runtime-startup.ps1'), path.join(root, 'ops/resolve-napcat-data-root.ps1'), path.join(root, 'src/inner-runtime-profile.mjs')]) {
      pins.push({ path: filename, sha256: selectionFileHash(filename) });
    }
  }
  const configPath = write(path.join(directory, 'config.json'), config);
  context.diagnostic(JSON.stringify({ directory, productionActions: 0 }));
  return { directory, config, configPath, configSha: selectionFileHash(configPath), write, sourceSha: selectionFileHash(sourceRegistryPath), targetSha: selectionFileHash(targetRegistryPath) };
}
function start(value, action) {
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-File', value.config.entryPath, '-ConfigurationPath', value.configPath,
    '-ConfigurationSha256', value.configSha, '-Action', action, '-FixtureConfirmation', 'SWITCH-FULL-RUNTIME-SELECTION'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => {
    const start = stdout.indexOf('{');
    resolve({ code, stdout, stderr, result: start < 0 ? null : JSON.parse(stdout.slice(start)) });
  }); });
  return { child, done };
}
test('fixture prepared for a direct native shell without the Node test harness', context => {
  if (process.env.OFFLINE_PREPARE_FIXTURE !== '1') { context.skip(); return; }
  const value = fixture(context, true);
  console.log(JSON.stringify({ directFixture: true, configPath: value.configPath, configSha256: value.configSha,
    directory: value.directory, sourceSha256: value.sourceSha, targetSha256: value.targetSha }));
});
test('offline validator requires full manifest, preserves registry and refuses unknown/new startup identities', context => {
  const value = fixture(context);
  const configuration = readSelectionRecovery(value.configPath, value.configSha);
  const observedAt = new Date().toISOString();
  assert.equal(assertOfflineSelectionStopped(configuration, { observedAt, processes: [], listeners: [] }).exited, true);
  for (const observedProcess of [
    { pid: 90000, parentPid: 1, name: 'node.exe', commandLine: 'node codex-app-server-proxy-runner.mjs', executablePath: process.execPath, creationDate: observedAt },
    { pid: 90000, parentPid: 1, name: 'node.exe', commandLine: null, executablePath: process.execPath, creationDate: observedAt },
  ]) assert.throws(() => assertOfflineSelectionStopped(configuration, { observedAt, processes: [observedProcess], listeners: [] }), /OFFLINE_STARTUP_PROCESS_PRESENT|OFFLINE_PROCESS_IDENTITY_UNKNOWN/);
  const packageFile = path.join(value.config.candidateRoot, 'rollback/src/proxy.cjs');
  fs.appendFileSync(packageFile, 'drift');
  assert.throws(() => readSelectionRecovery(value.configPath, value.configSha), /OFFLINE_PIN_CHANGED/);
  assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
});
test('offline validator preserves configured ports and additional captured worker listeners', context => {
  const value = fixture(context);
  const ports = [...value.config.ports, 54848, 61153, 64971, 65185];
  value.write(value.configPath, { ...value.config, ports });
  const configuration = readSelectionRecovery(value.configPath, selectionFileHash(value.configPath));
  assert.deepEqual(configuration.config.ports, ports);
  const observedAt = new Date().toISOString();
  assert.equal(assertOfflineSelectionStopped(configuration, { observedAt, processes: [], listeners: [] }).exited, true);
  assert.throws(() => assertOfflineSelectionStopped(configuration, {
    observedAt, processes: [{ pid: 500, parentPid: 1, creationDate: '2030-01-02T03:00:00.000Z', executablePath: 'C:/fixture/other.exe', commandLine: 'other', name: 'other.exe' }],
    listeners: [{ port: 64971, pid: 500, address: '127.0.0.1' }],
  }), /RECOVERY_PORT_STILL_LISTENING/u);
  for (const invalidPorts of [ports.slice(0, 4), [...ports, ports[0]], [...ports, 65536]]) {
    value.write(value.configPath, { ...value.config, ports: invalidPorts });
    assert.throws(() => readSelectionRecovery(value.configPath, selectionFileHash(value.configPath)), /OFFLINE_PORTS_INVALID/u);
  }
});
for (const startupProtection of ['desktop-gate', 'backend-stop']) test(`native ${startupProtection} entry preserves exception state, resumes, and independently undoes with explicit previous backups`, { timeout: 120000 }, async context => {
  const value = fixture(context, true, startupProtection);
  const failed = await start(value, 'Switch').done;
  assert.equal(failed.code, 1, JSON.stringify(failed));
  assert.match(failed.result.error, /OFFLINE_FIXTURE_AFTER_REPLACE/);
  assert.equal(selectionFileHash(value.config.registryPath), value.targetSha);
  assert.equal(fs.existsSync(value.config.stopPath), true);
  const resumed = await start(value, 'Resume').done;
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.equal(fs.existsSync(value.config.stopPath), false);
  const undone = await start(value, 'Undo').done;
  assert.equal(undone.code, 0, JSON.stringify(undone));
  assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
  assert.equal(fs.existsSync(value.config.stopPath), false);
  const intent = JSON.parse(fs.readFileSync(path.join(value.directory, 'offline-selection-attempt.json')));
  assert.ok(fs.readdirSync(intent.work).filter(name => name.endsWith('.previous')).length >= 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(value.config.registryPath)).retainedHistory, ['UNKNOWN', 'completed']);
});
test('native entry refuses an actual active runner before marker or registry mutation', { timeout: 45000 }, async context => {
  const value = fixture(context);
  const runner = value.write(path.join(value.directory, 'codex-app-server-proxy-runner.mjs'), 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [runner], { windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const result = await start(value, 'Switch').done;
    assert.notEqual(result.code, 0);
    assert.match(result.result.error, /OFFLINE_STARTUP_PROCESS_PRESENT/);
    assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
    assert.equal(fs.existsSync(value.config.stopPath), false);
  } finally { child.kill(); await new Promise(resolve => child.once('close', resolve)); }
});
test('native entry survives process termination after atomic replace and resumes from durable intent', { timeout: 90000 }, async context => {
  const value = fixture(context, 'Pause');
  const running = start(value, 'Switch');
  const deadline = Date.now() + 35000;
  while (selectionFileHash(value.config.registryPath) !== value.targetSha && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  try { assert.equal(selectionFileHash(value.config.registryPath), value.targetSha); }
  finally { running.child.kill(); await running.done; }
  assert.equal(fs.existsSync(value.config.stopPath), true);
  const resumed = await start(value, 'Resume').done;
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.equal(fs.existsSync(value.config.stopPath), false);
});

for (const startupProtection of ['desktop-gate', 'backend-stop']) test(`native ${startupProtection} entry preserves a foreign stop marker without starting an intent`, { timeout: 45000 }, async context => {
  const value = fixture(context, false, startupProtection);
  fs.writeFileSync(value.config.stopPath, 'foreign-maintenance-owner');
  const result = await start(value, 'Switch').done;
  assert.notEqual(result.code, 0);
  assert.match(result.result.error, /OFFLINE_FOREIGN_STOP_PRESERVED/);
  assert.equal(fs.readFileSync(value.config.stopPath, 'utf8'), 'foreign-maintenance-owner');
  assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
  assert.equal(fs.existsSync(path.join(value.directory, 'offline-selection-attempt.json')), false);
});

test('backend-stop validates the pinned real innerManaged startup binding without a desktop gate', context => {
  const value = fixture(context, false, 'backend-stop');
  assert.equal(readSelectionRecovery(value.configPath, value.configSha).config.startupProtection, 'backend-stop');
  assert.equal(value.config.startupGatePath, undefined);
  for (const required of [value.config.backendStartup.entryPath, value.config.backendStartup.runnerPath,
    value.config.backendStartup.configurationPath, path.join(root, 'ops/resolve-codex-outer-runtime-startup.ps1'),
    path.join(root, 'ops/resolve-napcat-data-root.ps1'), path.join(root, 'src/inner-runtime-profile.mjs')]) {
    value.write(value.configPath, { ...value.config, pins: value.config.pins.filter(item => item.path !== required) });
    assert.throws(() => readSelectionRecovery(value.configPath, selectionFileHash(value.configPath)), /OFFLINE_BACKEND_PIN_MISSING/);
  }
  value.write(value.configPath, { ...value.config, startupProtection: 'fake-lock' });
  assert.throws(() => readSelectionRecovery(value.configPath, selectionFileHash(value.configPath)), /OFFLINE_STARTUP_PROTECTION_INVALID/);
  const startup = JSON.parse(fs.readFileSync(value.config.backendStartup.configurationPath));
  value.write(value.config.backendStartup.configurationPath, { ...startup, innerManagedProfileSha256: '0'.repeat(64) });
  const pins = value.config.pins.map(item => ({ ...item, sha256: selectionFileHash(item.path) }));
  value.write(value.configPath, { ...value.config, pins });
  assert.throws(() => readSelectionRecovery(value.configPath, selectionFileHash(value.configPath)), /OFFLINE_BACKEND_PROFILE_CHANGED/);
  assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
});

test('backend-stop commits Switch and repeats Resume and Undo without creating a desktop gate', { timeout: 120000 }, async context => {
  const value = fixture(context, false, 'backend-stop');
  for (const action of ['Switch', 'Resume', 'Undo']) {
    const result = await start(value, action).done;
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.result.servicesStarted, false);
    assert.equal(selectionFileHash(value.config.registryPath), action === 'Undo' ? value.sourceSha : value.targetSha);
    assert.equal(fs.existsSync(value.config.stopPath), false);
  }
  assert.equal(fs.existsSync(path.join(value.directory, 'desktop-startup.lock')), false);
  assert.equal(fs.existsSync(value.config.registryPath + '.offline-recovery.lock'), true);
});

test('backend-stop holds a unique intent mutex and its second exit check catches an already-passed startup', { timeout: 90000 }, async context => {
  const value = fixture(context, false, 'backend-stop');
  value.config.faultAfterStop = 'Pause';
  value.write(value.configPath, value.config);
  value.configSha = selectionFileHash(value.configPath);
  const running = start(value, 'Switch');
  let child;
  let closed;
  try {
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(value.config.stopPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(value.config.stopPath), true);
    const intentPath = path.join(value.directory, 'offline-selection-attempt.json');
    const intentBytes = fs.readFileSync(intentPath);
    const runner = value.write(path.join(value.directory, 'codex-app-server-proxy-runner.mjs'), 'setInterval(() => {}, 1000);');
    child = spawn(process.execPath, [runner], { windowsHide: true, stdio: 'ignore' });
    closed = new Promise(resolve => child.once('close', resolve));
    const competing = await start(value, 'Switch').done;
    assert.equal(competing.code, 1, JSON.stringify(competing));
    assert.equal(competing.result.registryReplaced, false);
    assert.deepEqual(fs.readFileSync(intentPath), intentBytes);
    const failed = await running.done;
    assert.equal(failed.code, 1, JSON.stringify(failed));
    assert.match(failed.result.error, /OFFLINE_STARTUP_PROCESS_PRESENT/);
    assert.equal(failed.result.registryReplaced, false);
    assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
    assert.equal(fs.existsSync(value.config.stopPath), true);
    assert.equal(fs.existsSync(intentPath + '.sha256'), true);
  } finally {
    if (child) { child.kill(); await closed; }
    if (running.child.exitCode === null) running.child.kill();
    await running.done;
  }
  const resumed = await start(value, 'Resume').done;
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.equal(selectionFileHash(value.config.registryPath), value.targetSha);
  assert.equal(fs.existsSync(value.config.stopPath), false);
});

test('the real pinned starter and managed runner preserve a fixture stop and exit before runtime acquisition', { timeout: 45000 }, async context => {
  const value = fixture(context, false, 'backend-stop');
  fs.writeFileSync(value.config.stopPath, 'foreign-fixture-stop');
  const profile = JSON.parse(fs.readFileSync(value.config.profilePath));
  const optionNames = { runtimeStatePath: 'runtime-state', logPath: 'log', stopFilePath: 'stop-file', lockPath: 'lock',
    journalPath: 'journal', tokenFilePath: 'token-file', maintenanceFilePath: 'maintenance-file', alertFilePath: 'alert-file', fallbackFilePath: 'fallback-file' };
  const argumentsList = Object.entries(optionNames).flatMap(([name, option]) => ['--' + option, profile.outerPaths[name]]);
  argumentsList.push('--inner-managed-profile', value.config.profilePath, '--inner-managed-profile-sha256', selectionFileHash(value.config.profilePath),
    '--instance-token', crypto.randomUUID(), '--launch-receipt', path.join(value.directory, 'unpublished-launch.json'),
    '--downstream-port', '29432', '--control-port', '29431', '--upstream-port', '29433', '--probe-port', '29434');
  for (const [executable, argumentsValue, expected] of [
    [process.execPath, [value.config.backendStartup.runnerPath, ...argumentsList], /MANAGED_SESSION_STOP_REQUIREMENT_PRESENT/],
    [shell, ['-NoLogo', '-NoProfile', '-File', value.config.backendStartup.entryPath, '-DataRoot', value.directory], /EXISTING_STOP_REQUIREMENT_PRESERVED/],
  ]) {
    const child = spawn(executable, argumentsValue, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, output);
    assert.match(output, expected);
    assert.equal(fs.readFileSync(value.config.stopPath, 'utf8'), 'foreign-fixture-stop');
    assert.equal(fs.existsSync(profile.outerPaths.lockPath), false);
    assert.equal(fs.existsSync(profile.outerPaths.runtimeStatePath), false);
    assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
  }
});

test('native entry cannot compete with an exclusive startup gate', { timeout: 45000 }, async context => {
  const value = fixture(context);
  const readyPath = path.join(value.directory, 'gate-ready');
  const holder = value.write(path.join(value.directory, 'hold-gate.ps1'), "$ErrorActionPreference='Stop';$gate=[IO.File]::Open($env:OFFLINE_GATE,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{[IO.File]::WriteAllText($env:OFFLINE_GATE_READY,'ready');Start-Sleep -Seconds 60}finally{$gate.Dispose()}");
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-File', holder], { windowsHide: true, stdio: 'ignore',
    env: { ...process.env, OFFLINE_GATE: value.config.startupGatePath, OFFLINE_GATE_READY: readyPath } });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(readyPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(readyPath), true);
    const result = await start(value, 'Switch').done;
    assert.notEqual(result.code, 0);
    assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
    assert.equal(fs.existsSync(value.config.stopPath), false);
    assert.equal(fs.existsSync(path.join(value.directory, 'offline-selection-attempt.json')), false);
  } finally { child.kill(); await closed; }
});

test('native entry seals the unique attempt against marker text and whole old attempt replay', { timeout: 120000 }, async context => {
  const value = fixture(context, true);
  try {
    const failed = await start(value, 'Switch').done;
    assert.match(failed.result?.error ?? '', /OFFLINE_FIXTURE_AFTER_REPLACE/);
    const intentPath = path.join(value.directory, 'offline-selection-attempt.json');
    const sealedBytes = fs.readFileSync(intentPath);
    const sealed = JSON.parse(sealedBytes);
    const sealPath = intentPath + '.sha256';
    const sealBytes = fs.readFileSync(sealPath);
    const registryBytes = fs.readFileSync(value.config.registryPath);
    assert.equal(sealBytes.toString(), digest(sealedBytes));
    const foreign = 'FOREIGN-MAINTENANCE-STOP-OWNED-BY-ANOTHER-TASK';
    fs.writeFileSync(value.config.stopPath, foreign);
    fs.writeFileSync(intentPath, JSON.stringify({ ...sealed, markerText: foreign }));
    const rejected = await start(value, 'Resume').done;
    assert.equal(rejected.code, 1);
    assert.match(rejected.result.error, /OFFLINE_INTENT_SEAL_CHANGED/);
    assert.deepEqual(fs.readFileSync(value.config.registryPath), registryBytes);
    assert.equal(fs.readFileSync(value.config.stopPath, 'utf8'), foreign);
    const oldAttempt = crypto.randomUUID();
    const oldNonce = crypto.randomUUID();
    const oldWork = path.join(value.directory, 'offline-selection-' + oldAttempt);
    fs.mkdirSync(oldWork);
    const oldOriginal = path.join(oldWork, 'original-registry.json');
    fs.copyFileSync(sealed.originalPath, oldOriginal);
    const oldMarker = JSON.stringify({ schema: 'napcat.offline-selection-stop/v1', attemptId: oldAttempt,
      configurationSha256: value.configSha, nonce: oldNonce, registryPath: value.config.registryPath });
    fs.writeFileSync(intentPath, JSON.stringify({ ...sealed, attemptId: oldAttempt, nonce: oldNonce,
      work: oldWork, originalPath: oldOriginal, markerText: oldMarker }));
    fs.writeFileSync(value.config.stopPath, oldMarker);
    const replay = await start(value, 'Undo').done;
    assert.equal(replay.code, 1);
    assert.match(replay.result.error, /OFFLINE_INTENT_SEAL_CHANGED/);
    assert.deepEqual(fs.readFileSync(value.config.registryPath), registryBytes);
    assert.equal(fs.readFileSync(value.config.stopPath, 'utf8'), oldMarker);
    assert.deepEqual(fs.readFileSync(sealPath), sealBytes);
    assert.deepEqual(fs.readdirSync(oldWork), ['original-registry.json']);
    fs.writeFileSync(intentPath, sealedBytes);
    fs.writeFileSync(value.config.stopPath, sealed.markerText);
    const resumed = await start(value, 'Resume').done;
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(fs.existsSync(value.config.stopPath), false);
    const undone = await start(value, 'Undo').done;
    assert.equal(undone.code, 0, JSON.stringify(undone));
    assert.equal(selectionFileHash(value.config.registryPath), value.sourceSha);
    assert.equal(fs.existsSync(value.config.stopPath), false);
    assert.deepEqual(fs.readFileSync(sealPath), sealBytes);
  } finally { fs.rmSync(value.directory, { recursive: true, force: true }); }
});

test('marker validation rejects malformed fields and inconsistent attempt identity', { timeout: 15000 }, async () => {
  const source = fs.readFileSync(path.join(root, 'ops/recover-full-runtime-selection.ps1'), 'utf8');
  const validator = source.slice(source.indexOf('function Assert-OfflineIntentMarker'), source.indexOf('\nif ((Sha $ConfigurationPath)'));
  const script = `${validator}
$ErrorActionPreference='Stop'
$configurationSha='a'*64
$config=[pscustomobject]@{registryPath='C:\\fixture\\registry.json'}
$intent=[pscustomobject]@{attemptId='12345678-1234-1234-1234-123456789abc';nonce='87654321-4321-4321-4321-cba987654321';markerText=''}
$baseline=@{schema='napcat.offline-selection-stop/v1';attemptId=$intent.attemptId;configurationSha256=$configurationSha;registryPath=$config.registryPath;nonce=$intent.nonce}
$intent.markerText=$baseline|ConvertTo-Json -Compress
Assert-OfflineIntentMarker $intent $config $configurationSha
$count=0
foreach($field in @('schema','attemptId','configurationSha256','registryPath','nonce')) {
 foreach($bad in @('foreign',123,@('value'))) {
  $record=$baseline.Clone();$record[$field]=$bad;$intent.markerText=$record|ConvertTo-Json -Compress
  $rejected=$false;try{Assert-OfflineIntentMarker $intent $config $configurationSha}catch{$rejected=$_.Exception.Message -eq 'OFFLINE_INTENT_MARKER_INVALID'}
  if(-not $rejected){throw ('MARKER_ACCEPTED_'+$field)};$count++
 }
}
foreach($badText in @('not-json','[]','null')) {
 $intent.markerText=$badText;$rejected=$false;try{Assert-OfflineIntentMarker $intent $config $configurationSha}catch{$rejected=$_.Exception.Message -eq 'OFFLINE_INTENT_MARKER_INVALID'}
 if(-not $rejected){throw 'MALFORMED_MARKER_ACCEPTED'};$count++
}
Write-Output ('MARKER_REJECTIONS='+$count)
`;
  const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /MARKER_REJECTIONS=18/);
});
