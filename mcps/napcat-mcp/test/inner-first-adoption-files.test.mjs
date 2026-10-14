import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const enabled = process.platform === 'win32';
const entry = fileURLToPath(new URL('../ops/invoke-inner-first-adoption-files.ps1', import.meta.url));
const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = target => digest(fs.readFileSync(target));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const output = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'inner-first-adoption-files-evidence-')) : null;
const evidence = { schemaVersion: 1, productionExecuted: false, serviceActions: 0, source: entry, sourceSha256: sha(entry), commands: [], checks: [], output };
const roots = [];
let operatorSid;

function run(args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  evidence.commands.push({ command: [shell, ...args], startedAt, actualexit: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  assert.ok(!result.error, result.error?.message);
  assert.ok(result.stdout.trim(), `${result.stderr}\n${result.stdout}`);
  return { ...result, response: JSON.parse(result.stdout.trim()) };
}

function command(body) {
  return run(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${body}`]);
}

function invoke(script, values) {
  const args = Object.entries(values).flatMap(([name, value]) => value === true ? [`-${name}`] : [`-${name}`, String(value)]);
  return run(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args]);
}

function write(root, name, value) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}

const modules = {
  'src/codex-app-server-proxy-runner.mjs': 'import "./inner-managed-session.mjs"; import "./inner-runtime-profile.mjs";\n',
  'src/inner-managed-session.mjs': 'import "./inner-proxy-coordinator.mjs"; import "./inner-native-turn-source.mjs"; import "./codex-app-server-proxy.mjs";\n',
  'src/codex-app-server-proxy.mjs': 'export const fixture = "managed-control-route";\n',
  'src/inner-proxy-coordinator.mjs': 'import "./inner-runner-handoff-control.mjs"; import "./inner-handoff-compatibility.mjs";\n',
  'src/inner-native-turn-source.mjs': 'export const fixture = "native";\n',
  'src/inner-handoff-compatibility.mjs': 'export const fixture = "compatibility";\n',
  'src/inner-migration-plan.mjs': 'export const fixture = "plan";\n',
  'src/inner-runner-handoff-control.mjs': 'import "./inner-migration-plan.mjs";\n',
  'src/inner-runtime-profile.mjs': 'export const fixture = "profile";\n',
  'src/codex-model-stream-proxy-runner.mjs': 'import "./codex-model-stream-proxy.mjs";\n',
  'src/codex-model-stream-proxy.mjs': 'import "./thread-recovery-handoff.mjs";\n',
  'src/thread-recovery-handoff.mjs': 'export const fixture = "handoff";\n',
  'ops/resolve-codex-outer-runtime-startup.ps1': '$Fixture = "startup"\n',
  'ops/start-codex-app-server-proxy.ps1': '$Fixture = "entry"\n',
};

function fixture({ missing = 'src/inner-native-turn-source.mjs', dependencies = false } = {}) {
  operatorSid ??= command('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress').response;
  const base = fs.mkdtempSync(path.join(output, 'owned-'));
  roots.push(base);
  const candidateRoot = path.join(base, 'candidate');
  const installedRoot = path.join(base, 'installed');
  const dataRoot = path.join(base, 'data');
  const transactionRoot = path.join(base, 'transaction');
  const outerRuntimeRoot = path.join(dataRoot, 'outer-existing-candidate');
  const ownerId = 'fixture-owner';
  const transactionId = crypto.randomUUID();
  for (const root of [candidateRoot, installedRoot, dataRoot]) fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outerRuntimeRoot);
  for (const parent of [path.join(installedRoot, 'src'), path.join(installedRoot, 'ops'), path.join(dataRoot, 'state')]) fs.mkdirSync(parent);
  write(base, '.inner-first-adoption-fixture-owner.json', { schemaVersion: 1, scope: 'inner-first-adoption-files-v1', ownerId, transactionId, operatorSid });
  const files = Object.entries(modules).map(([name, bytes]) => {
    const value = dependencies && name === 'src/thread-recovery-handoff.mjs' ? `${bytes}import "./fixture-readonly.mjs";\n`
      : dependencies && name === 'ops/start-codex-app-server-proxy.ps1' ? `${bytes}. (Join-Path $PSScriptRoot "fixture-readonly.ps1")\n` : bytes;
    write(candidateRoot, name, value);
    if (name !== missing) write(installedRoot, name, `original ${name}\n`);
    return { name, sha256: sha(path.join(candidateRoot, name)) };
  });
  const expectedHashes = Object.fromEntries(Object.entries({ runner: 'src/codex-model-stream-proxy-runner.mjs', core: 'src/codex-model-stream-proxy.mjs', helper: 'src/thread-recovery-handoff.mjs', control: 'src/inner-runner-handoff-control.mjs' }).map(([key, name]) => [key, files.find(item => item.name === name).sha256]));
  const managedRoot = path.join(dataRoot, 'state/inner-managed');
  const checkpointRoot = path.join(managedRoot, 'checkpoints');
  const profile = { schemaVersion: 1, mode: 'production', ownerId, nativeSourceId: 'fixture-native-source', installationRoot: installedRoot, stateRoot: managedRoot, checkpointRoot, outerStateRoot: path.join(dataRoot, 'state'), initial: { runnerPath: path.join(installedRoot, 'src/codex-model-stream-proxy-runner.mjs'), expectedHashes } };
  const profilePath = write(candidateRoot, 'state/inner-managed/inner-managed-profile.json', profile);
  files.push({ name: 'state/inner-managed/inner-managed-profile.json', sha256: sha(profilePath) });
  for (const [name, kind] of [['state/inner-managed/.inner-runtime-owner.json', 'state'], ['state/inner-managed/checkpoints/.inner-runtime-owner.json', 'checkpoint']]) {
    const markerPath = write(candidateRoot, name, { schemaVersion: 1, ownerId, nativeSourceId: profile.nativeSourceId, kind });
    files.push({ name, sha256: sha(markerPath) });
  }
  const startup = { schemaVersion: 1, enabled: true, candidateRoot: outerRuntimeRoot, innerManagedProfilePath: path.join(managedRoot, 'inner-managed-profile.json'), innerManagedProfileSha256: sha(profilePath) };
  const startupPath = write(candidateRoot, 'state/codex-outer-runtime-startup.json', startup);
  files.push({ name: 'state/codex-outer-runtime-startup.json', sha256: sha(startupPath) });
  write(dataRoot, 'state/codex-outer-runtime-startup.json', { schemaVersion: 1, enabled: true, candidateRoot: outerRuntimeRoot, originalStartup: true });
  const readOnlyDependencies = [];
  if (dependencies) {
    const value = 'export const originalReadOnly = true;\n';
    write(candidateRoot, 'src/fixture-readonly.mjs', value);
    write(installedRoot, 'src/fixture-readonly.mjs', value);
    readOnlyDependencies.push({ name: 'src/fixture-readonly.mjs', sha256: sha(path.join(candidateRoot, 'src/fixture-readonly.mjs')) });
    write(candidateRoot, 'ops/fixture-readonly.ps1', '$ReadOnlyFixture = $true\n');
    write(installedRoot, 'ops/fixture-readonly.ps1', '$ReadOnlyFixture = $true\n');
    readOnlyDependencies.push({ name: 'ops/fixture-readonly.ps1', sha256: sha(path.join(candidateRoot, 'ops/fixture-readonly.ps1')) });
  }
  const manifest = { schemaVersion: 1, scope: 'inner-first-adoption-files-v1', mode: 'TempFixture', ownerId, transactionId, operatorSid, fixtureRoot: base, candidateRoot, installedRoot, dataRoot, files, readOnlyDependencies, protectedProcesses: [] };
  const manifestPath = write(base, 'freeze.json', manifest);
  const target = name => path.join(name.startsWith('state/') ? dataRoot : installedRoot, name);
  return { base, candidateRoot, installedRoot, dataRoot, outerRuntimeRoot, transactionRoot, ownerId, transactionId, manifest, manifestPath, target };
}

function prepare(context) {
  const result = invoke(entry, { Action: 'Prepare', Mode: 'TempFixture', FreezeManifestPath: context.manifestPath, FreezeManifestSha256: sha(context.manifestPath), TransactionRoot: context.transactionRoot, OwnerId: context.ownerId, TransactionId: context.transactionId });
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(result.response.status, 'PREPARED');
  assert.equal(result.response.targetWrites, 0);
  context.planSha256 = result.response.planSha256;
  context.frozenEntry = result.response.entryPath;
  assert.equal(result.response.entrySha256, evidence.sourceSha256);
  return result;
}

function act(context, action, extra = {}) {
  return invoke(context.frozenEntry, { Action: action, Mode: 'TempFixture', TransactionRoot: context.transactionRoot, PlanSha256: context.planSha256, OwnerId: context.ownerId, TransactionId: context.transactionId, OwnerConfirmation: `${context.ownerId}|${context.transactionId}|${action}|${context.planSha256}`, ...extra });
}

function snapshots(context) {
  const targets = context.manifest.files.map(item => context.target(item.name));
  const result = command(`$Sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access; @(${targets.map(target => `if (Test-Path -LiteralPath ${quote(target)}) { [pscustomobject]@{ exists=$true; sha256=(Get-FileHash -LiteralPath ${quote(target)} -Algorithm SHA256).Hash.ToLowerInvariant(); sddl=(Get-Acl -LiteralPath ${quote(target)}).GetSecurityDescriptorSddlForm($Sections); attributes=[int](Get-Item -LiteralPath ${quote(target)} -Force).Attributes } } else { [pscustomobject]@{ exists=$false; sha256=$null; sddl=$null; attributes=$null } }`).join(';')}) | ConvertTo-Json -Depth 4 -Compress`);
  assert.equal(result.status, 0, result.stderr);
  return result.response;
}

function receipt(context) { return JSON.parse(fs.readFileSync(path.join(context.transactionRoot, 'receipt.json'), 'utf8')); }
function record(label, context, details = {}) { evidence.checks.push({ label, base: context.base, planSha256: context.planSha256, ...details }); }

after(() => {
  if (!output) return;
  const evidencePath = path.join(output, 'evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`INNER_FILES_EVIDENCE=${JSON.stringify({ path: evidencePath, sha256: sha(evidencePath), sourceSha256: evidence.sourceSha256, fixtureRoots: roots.length, productionExecuted: false, serviceActions: 0 })}`);
});

test('six actual managed dependencies are frozen, applied and independently restored with original missing state', { skip: !enabled }, () => {
  const context = fixture();
  const names = ['tool-delivery-profile', 'codex-stream-recovery', 'tool-preparation-deadline',
    'reasoning-progress', 'partial-response-progress', 'model-stream-failure-diagnostics'];
  const coreName = 'src/codex-model-stream-proxy.mjs';
  const content = fs.readFileSync(path.join(context.candidateRoot, coreName), 'utf8')
    + names.map(name => `import "./${name}.mjs";\n`).join('');
  write(context.candidateRoot, coreName, content);
  context.manifest.files.find(item => item.name === coreName).sha256 = sha(path.join(context.candidateRoot, coreName));
  for (const name of names) {
    const relative = `src/${name}.mjs`;
    write(context.candidateRoot, relative, `export const dependencyIdentity = ${JSON.stringify(name)};\n`);
    if (name !== 'model-stream-failure-diagnostics') write(context.installedRoot, relative, `original ${name}\n`);
    context.manifest.files.push({ name: relative, sha256: sha(path.join(context.candidateRoot, relative)) });
  }
  const profileName = 'state/inner-managed/inner-managed-profile.json';
  const profile = JSON.parse(fs.readFileSync(path.join(context.candidateRoot, profileName), 'utf8'));
  profile.initial.expectedHashes.core = sha(path.join(context.candidateRoot, coreName));
  write(context.candidateRoot, profileName, profile);
  context.manifest.files.find(item => item.name === profileName).sha256 = sha(path.join(context.candidateRoot, profileName));
  const startupName = 'state/codex-outer-runtime-startup.json';
  const startup = JSON.parse(fs.readFileSync(path.join(context.candidateRoot, startupName), 'utf8'));
  startup.innerManagedProfileSha256 = sha(path.join(context.candidateRoot, profileName));
  write(context.candidateRoot, startupName, startup);
  context.manifest.files.find(item => item.name === startupName).sha256 = sha(path.join(context.candidateRoot, startupName));
  write(context.base, 'freeze.json', context.manifest);
  const before = snapshots(context);
  prepare(context);
  const applied = act(context, 'Apply');
  assert.equal(applied.status, 0, JSON.stringify(applied));
  assert.equal(applied.response.status, 'APPLIED');
  assert.equal(applied.response.targetWrites, context.manifest.files.length);
  for (const name of names) assert.equal(sha(context.target(`src/${name}.mjs`)), sha(path.join(context.candidateRoot, `src/${name}.mjs`)));
  fs.renameSync(context.candidateRoot, path.join(context.base, 'source-unavailable-after-apply'));
  const restored = act(context, 'Restore');
  assert.equal(restored.status, 0, JSON.stringify(restored));
  assert.equal(restored.response.status, 'RESTORED');
  assert.deepEqual(snapshots(context), before);
  assert.equal(fs.existsSync(context.target('src/model-stream-failure-diagnostics.mjs')), false);
  record('actual-six-dependency-files-and-independent-restore', context, { before, applied: applied.response, restored: restored.response });
});

test('forward slash production-shaped roots prepare apply and restore without false directory drift', { skip: !enabled }, () => {
  const context = fixture();
  context.manifest.installedRoot = context.installedRoot.replaceAll('\\', '/');
  context.manifest.dataRoot = context.dataRoot.replaceAll('\\', '/');
  const profileName = 'state/inner-managed/inner-managed-profile.json';
  const startupName = 'state/codex-outer-runtime-startup.json';
  const profile = JSON.parse(fs.readFileSync(path.join(context.candidateRoot, profileName), 'utf8'));
  profile.installationRoot = context.manifest.installedRoot;
  write(context.candidateRoot, profileName, profile);
  context.manifest.files.find(item => item.name === profileName).sha256 = sha(path.join(context.candidateRoot, profileName));
  const startup = JSON.parse(fs.readFileSync(path.join(context.candidateRoot, startupName), 'utf8'));
  startup.innerManagedProfileSha256 = sha(path.join(context.candidateRoot, profileName));
  write(context.candidateRoot, startupName, startup);
  context.manifest.files.find(item => item.name === startupName).sha256 = sha(path.join(context.candidateRoot, startupName));
  write(context.base, 'freeze.json', context.manifest);
  const before = snapshots(context);
  prepare(context);
  const applied = act(context, 'Apply');
  assert.equal(applied.status, 0, JSON.stringify(applied));
  assert.equal(applied.response.status, 'APPLIED');
  fs.renameSync(context.candidateRoot, path.join(context.base, 'candidate-unavailable'));
  const restored = act(context, 'Restore');
  assert.equal(restored.status, 0, JSON.stringify(restored));
  assert.equal(restored.response.status, 'RESTORED');
  assert.deepEqual(snapshots(context), before);
  record('forward-slash-production-shape-apply-restore', context, { before, applied: applied.response, restored: restored.response });
});

test('same frozen version applies, consumed apply is read-only, independent WinPS restores bytes ACL attributes and absent files', { skip: !enabled }, () => {
  const context = fixture();
  const before = snapshots(context);
  prepare(context);
  const applied = act(context, 'Apply');
  assert.equal(applied.status, 0, JSON.stringify(applied));
  assert.equal(applied.response.status, 'APPLIED');
  assert.equal(applied.response.serviceActions, 0);
  assert.equal(applied.response.targetWrites, context.manifest.files.length);
  assert.equal(JSON.parse(fs.readFileSync(context.target('state/codex-outer-runtime-startup.json'), 'utf8')).candidateRoot, context.outerRuntimeRoot);
  assert.notEqual(context.outerRuntimeRoot, context.installedRoot);
  for (const item of context.manifest.files) assert.equal(sha(context.target(item.name)), item.sha256);
  const consumed = act(context, 'Apply');
  assert.equal(consumed.status, 0, JSON.stringify(consumed));
  assert.equal(consumed.response.targetWrites, 0);
  assert.equal(consumed.response.alreadyConsumed, true);
  fs.renameSync(context.candidateRoot, path.join(context.base, 'unavailable-new-candidate'));
  const restored = act(context, 'Restore');
  assert.equal(restored.status, 0, JSON.stringify(restored));
  assert.equal(restored.response.status, 'RESTORED');
  assert.deepEqual(snapshots(context), before);
  assert.equal(fs.existsSync(path.join(context.dataRoot, 'state/inner-managed')), false);
  assert.ok(fs.existsSync(path.join(context.transactionRoot, 'original/0.bin')));
  const consumedRestore = act(context, 'Restore');
  assert.equal(consumedRestore.status, 0, JSON.stringify(consumedRestore));
  assert.equal(consumedRestore.response.targetWrites, 0);
  record('normal-and-independent-restore', context, { before, applied: applied.response, restored: restored.response });
});

test('known partial apply resumes the same transaction and partial restore resumes with original backups retained', { skip: !enabled }, () => {
  const context = fixture();
  const before = snapshots(context);
  prepare(context);
  const partialApply = act(context, 'Apply', { FixtureFailAfterWrites: 3 });
  assert.equal(partialApply.status, 1);
  assert.equal(partialApply.response.status, 'PARTIAL_APPLY');
  assert.equal(receipt(context).progress.filter(item => item.state === 'INSTALLED').length, 3);
  const resumed = act(context, 'Apply');
  assert.equal(resumed.status, 0, JSON.stringify(resumed));
  assert.equal(resumed.response.targetWrites, context.manifest.files.length - 3);
  const partialRestore = act(context, 'Restore', { FixtureFailAfterWrites: 2 });
  assert.equal(partialRestore.status, 1);
  assert.equal(partialRestore.response.status, 'PARTIAL_RESTORE');
  const prohibitedReplay = act(context, 'Apply');
  assert.equal(prohibitedReplay.status, 1);
  assert.equal(prohibitedReplay.response.targetWrites, 0);
  assert.match(prohibitedReplay.response.error, /APPLY_CONSUMED/);
  const restored = act(context, 'Restore');
  assert.equal(restored.status, 0, JSON.stringify(restored));
  assert.deepEqual(snapshots(context), before);
  record('partial-apply-partial-restore-resume', context, { partialApply: partialApply.response, partialRestore: partialRestore.response, restored: restored.response });
});

test('source, target SHA, ACL, attributes, original, plan and owner confirmation drift refuse without target or receipt writes', { skip: !enabled }, () => {
  for (const kind of ['source', 'target', 'acl', 'attributes', 'original', 'plan', 'confirmation', 'owner']) {
    const context = fixture();
    prepare(context);
    let extra = {};
    if (kind === 'source') fs.appendFileSync(path.join(context.candidateRoot, context.manifest.files[0].name), 'source drift');
    if (kind === 'target') fs.appendFileSync(context.target(context.manifest.files[0].name), 'target drift');
    if (kind === 'acl') command(`$Acl=Get-Acl -LiteralPath ${quote(context.target(context.manifest.files[0].name))}; $Acl.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath ${quote(context.target(context.manifest.files[0].name))} -AclObject $Acl; 'changed' | ConvertTo-Json -Compress`);
    if (kind === 'attributes') command(`[IO.File]::SetAttributes(${quote(context.target(context.manifest.files[0].name))},[IO.FileAttributes]::ReadOnly); 'changed' | ConvertTo-Json -Compress`);
    if (kind === 'original') fs.appendFileSync(path.join(context.transactionRoot, 'original/0.bin'), 'original drift');
    if (kind === 'plan') fs.appendFileSync(path.join(context.transactionRoot, 'plan.json'), ' ');
    if (kind === 'confirmation') extra = { OwnerConfirmation: 'not-the-confirmation' };
    if (kind === 'owner') extra = { OwnerId: 'another-owner' };
    const before = snapshots(context);
    const receiptSha256 = sha(path.join(context.transactionRoot, 'receipt.json'));
    const result = act(context, 'Apply', extra);
    assert.equal(result.status, 1, `${kind}: ${JSON.stringify(result)}`);
    assert.equal(result.response.targetWrites, 0, kind);
    assert.deepEqual(snapshots(context), before, kind);
    assert.equal(sha(path.join(context.transactionRoot, 'receipt.json')), receiptSha256, kind);
    record(`zero-write-${kind}-drift`, context, { response: result.response });
  }
});

test('unknown write intent is preserved and never inferred from candidate SHA or blindly replayed', { skip: !enabled }, () => {
  const context = fixture();
  prepare(context);
  const interrupted = act(context, 'Apply', { FixtureUnknownAfterWrite: true });
  assert.equal(interrupted.status, 1);
  assert.equal(interrupted.response.status, 'UNKNOWN');
  assert.ok(receipt(context).intent);
  const status = act(context, 'Status');
  assert.equal(status.status, 0, JSON.stringify(status));
  assert.equal(status.response.status, 'UNKNOWN');
  const receiptSha256 = sha(path.join(context.transactionRoot, 'receipt.json'));
  for (const action of ['Apply', 'Restore']) {
    const result = act(context, action);
    assert.equal(result.status, 1);
    assert.match(result.response.error, /UNKNOWN_PRESERVED_NO_REPLAY/);
    assert.equal(result.response.targetWrites, 0);
    assert.equal(sha(path.join(context.transactionRoot, 'receipt.json')), receiptSha256);
  }
  record('unknown-preserved', context, { response: interrupted.response });
});

test('foreign newly created file is never deleted during restore and partial installed files can restore directly', { skip: !enabled }, () => {
  const context = fixture();
  const before = snapshots(context);
  prepare(context);
  const partial = act(context, 'Apply', { FixtureFailAfterWrites: 1 });
  assert.equal(partial.response.status, 'PARTIAL_APPLY');
  const restored = act(context, 'Restore');
  assert.equal(restored.status, 0, JSON.stringify(restored));
  assert.deepEqual(snapshots(context), before);
  const other = fixture();
  prepare(other);
  assert.equal(act(other, 'Apply').status, 0);
  const foreign = other.target('state/inner-managed/inner-managed-profile.json');
  fs.writeFileSync(foreign, '{"foreign":true}\n');
  const foreignSha = sha(foreign);
  const refused = act(other, 'Restore');
  assert.equal(refused.status, 1);
  assert.equal(refused.response.targetWrites, 0);
  assert.equal(sha(foreign), foreignSha);
  record('foreign-file-preserved', other, { response: refused.response });
});

test('ADS, reparse paths, invalid allowlist and Temp escape are rejected before prepare creates transaction material', { skip: !enabled }, () => {
  for (const kind of ['ads', 'reparse', 'allowlist', 'escape']) {
    const context = fixture();
    if (kind === 'ads') command(`Set-Content -LiteralPath ${quote(path.join(context.candidateRoot, context.manifest.files[0].name))} -Stream fixture -Value 'ads'; 'changed' | ConvertTo-Json -Compress`);
    if (kind === 'reparse') {
      const old = context.candidateRoot;
      const renamed = path.join(context.base, 'junction-source');
      fs.renameSync(old, renamed);
      fs.symlinkSync(renamed, old, 'junction');
    }
    if (kind === 'allowlist') context.manifest.files.push({ name: 'config.toml', sha256: 'a'.repeat(64) });
    if (kind === 'escape') context.manifest.installedRoot = path.join(os.tmpdir(), 'not-owned-by-this-fixture');
    fs.writeFileSync(context.manifestPath, JSON.stringify(context.manifest));
    const result = invoke(entry, { Action: 'Prepare', Mode: 'TempFixture', FreezeManifestPath: context.manifestPath, FreezeManifestSha256: sha(context.manifestPath), TransactionRoot: context.transactionRoot, OwnerId: context.ownerId, TransactionId: context.transactionId });
    assert.equal(result.status, 1, `${kind}: ${JSON.stringify(result)}`);
    assert.equal(result.response.targetWrites, 0);
    assert.equal(fs.existsSync(context.transactionRoot), false);
    record(`zero-write-${kind}`, context, { response: result.response });
  }
});

test('frozen read-only imports must exist unchanged in installed files and stay outside the write plan', { skip: !enabled }, () => {
  const context = fixture({ dependencies: true });
  prepare(context);
  const dependency = path.join(context.installedRoot, 'src/fixture-readonly.mjs');
  const original = sha(dependency);
  const psDependency = path.join(context.installedRoot, 'ops/fixture-readonly.ps1');
  const originalPs = sha(psDependency);
  assert.equal(act(context, 'Apply').status, 0);
  assert.equal(sha(dependency), original);
  assert.equal(sha(psDependency), originalPs);
  assert.equal(act(context, 'Restore').status, 0);
  assert.equal(sha(dependency), original);
  assert.equal(sha(psDependency), originalPs);
  record('readonly-dependency-unchanged', context, { sha256: original, psSha256: originalPs });
});

test('manager generated worker directories are retained and shared outer state journal and tokens never enter the write set', { skip: !enabled }, () => {
  const context = fixture();
  const outer = write(context.dataRoot, 'state/codex-app-server-proxy-runtime.json', '{"oldOuter":true}\n');
  const journal = write(context.dataRoot, 'state/old-outer-journal.jsonl', '{"oldJournal":true}\n');
  const token = write(context.dataRoot, 'state/old-outer-token', 'old token fixture\n');
  const originals = [outer, journal, token].map(sha);
  prepare(context);
  assert.equal(act(context, 'Apply').status, 0);
  const worker = write(context.dataRoot, 'state/inner-managed/workers/manager-owned/actual-runtime.json', '{"fromManagerFixture":true}\n');
  const workerSha256 = sha(worker);
  const result = act(context, 'Restore');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.equal(sha(worker), workerSha256);
  assert.deepEqual([outer, journal, token].map(sha), originals);
  assert.equal(result.response.ownedDirectories.find(item => item.path === path.join(context.dataRoot, 'state/inner-managed')).state, 'RETAINED_NONEMPTY');
  assert.equal(fs.existsSync(path.join(context.dataRoot, 'state/.inner-runtime-owner.json')), false);
  record('manager-worker-and-old-outer-retained', context, { response: result.response, workerSha256, originals });
});

test('WinPS 5.1 NativeSecurity restores original non-AI DACL owner group and ReadOnly Hidden Archive attributes exactly', { skip: !enabled }, () => {
  const context = fixture();
  const target = context.target(context.manifest.files[0].name);
  const setup = command(`
    $Assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('InnerAclFixture'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $Builder=$Assembly.DefineDynamicModule('Native').DefineType('InnerAclFixture.Native',[Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
    $Setter=$Builder.DefinePInvokeMethod('SetRaw','advapi32.dll','SetFileSecurityW',[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl,[Reflection.CallingConventions]::Standard,[bool],[type[]]@([string],[uint32],[byte[]]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $Setter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig);[void]$Builder.CreateType()
    $Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $Saved='O:'+$Sid+'G:'+$Sid+'D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;'+$Sid+')'
    $Descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Saved);$Bytes=[byte[]]::new($Descriptor.BinaryLength);$Descriptor.GetBinaryForm($Bytes,0)
    if(-not [InnerAclFixture.Native]::SetRaw(${quote(target)},[uint32]536870919,$Bytes)){throw 'ACL_FIXTURE_FAILED'}
    [IO.File]::SetAttributes(${quote(target)},[IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::Archive)
    [pscustomobject]@{sddl=(Get-Acl -LiteralPath ${quote(target)}).Sddl;version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition} | ConvertTo-Json -Compress
  `);
  assert.equal(setup.status, 0, JSON.stringify(setup));
  assert.match(setup.response.version, /^5\.1\./);
  assert.match(setup.response.sddl, /D:\(A;ID;/);
  const before = snapshots(context);
  prepare(context);
  const applied = act(context, 'Apply');
  assert.equal(applied.status, 0, JSON.stringify(applied));
  const installed = snapshots(context);
  assert.equal(installed[0].sddl, before[0].sddl);
  assert.equal(installed[0].attributes, before[0].attributes);
  const restored = act(context, 'Restore');
  assert.equal(restored.status, 0, JSON.stringify(restored));
  assert.deepEqual(snapshots(context), before);
  record('original-non-ai-acl-and-attributes', context, { setup: setup.response, before, applied: applied.response, restored: restored.response });
});

test('protected pid plus creation time is checked and live or mismatched identity prevents writes', { skip: !enabled }, () => {
  const context = fixture();
  const identity = command(`$Observed=Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}'; [pscustomobject]@{role='inner';pid=[int]$Observed.ProcessId;creationTimeUtc=([DateTime]$Observed.CreationDate).ToUniversalTime().ToString('o');executablePath=$Observed.ExecutablePath} | ConvertTo-Json -Compress`).response;
  context.manifest.protectedProcesses = [identity];
  fs.writeFileSync(context.manifestPath, JSON.stringify(context.manifest));
  prepare(context);
  const result = act(context, 'Apply');
  assert.equal(result.status, 1);
  assert.match(result.response.error, /PROTECTED_PROCESS_STILL_RUNNING/);
  assert.equal(result.response.targetWrites, 0);
  const reused = fixture();
  reused.manifest.protectedProcesses = [{ ...identity, creationTimeUtc: '2000-01-01T00:00:00.0000000Z' }];
  fs.writeFileSync(reused.manifestPath, JSON.stringify(reused.manifest));
  const refused = invoke(entry, { Action: 'Prepare', Mode: 'TempFixture', FreezeManifestPath: reused.manifestPath, FreezeManifestSha256: sha(reused.manifestPath), TransactionRoot: reused.transactionRoot, OwnerId: reused.ownerId, TransactionId: reused.transactionId });
  assert.equal(refused.status, 1);
  assert.match(refused.response.error, /PROTECTED_PID_REUSED_OR_DRIFTED/);
  assert.equal(refused.response.targetWrites, 0);
  record('protected-pid-and-creation-time', context, { response: result.response, mismatch: refused.response });
});

test('all four original profile pins reject drift before creating transaction or dedicated directories', { skip: !enabled }, () => {
  for (const pin of ['runner', 'core', 'helper', 'control']) {
    const context = fixture();
    const profileName = 'state/inner-managed/inner-managed-profile.json';
    const profilePath = path.join(context.candidateRoot, profileName);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.initial.expectedHashes[pin] = 'a'.repeat(64);
    fs.writeFileSync(profilePath, JSON.stringify(profile));
    context.manifest.files.find(item => item.name === profileName).sha256 = sha(profilePath);
    const startupName = 'state/codex-outer-runtime-startup.json';
    const startupPath = path.join(context.candidateRoot, startupName);
    const startup = JSON.parse(fs.readFileSync(startupPath, 'utf8'));
    startup.innerManagedProfileSha256 = sha(profilePath);
    fs.writeFileSync(startupPath, JSON.stringify(startup));
    context.manifest.files.find(item => item.name === startupName).sha256 = sha(startupPath);
    fs.writeFileSync(context.manifestPath, JSON.stringify(context.manifest));
    const before = snapshots(context);
    const result = invoke(entry, { Action: 'Prepare', Mode: 'TempFixture', FreezeManifestPath: context.manifestPath, FreezeManifestSha256: sha(context.manifestPath), TransactionRoot: context.transactionRoot, OwnerId: context.ownerId, TransactionId: context.transactionId });
    assert.equal(result.status, 1, `${pin}: ${JSON.stringify(result)}`);
    assert.equal(result.response.error, 'PROFILE_FROZEN_HASH_MISMATCH', pin);
    assert.equal(result.response.targetWrites, 0, pin);
    assert.equal(result.response.directoryWrites, 0, pin);
    assert.equal(fs.existsSync(context.transactionRoot), false, pin);
    assert.equal(fs.existsSync(path.join(context.dataRoot, 'state/inner-managed')), false, pin);
    assert.deepEqual(snapshots(context), before, pin);
    record(`profile-pin-${pin}-zero-write`, context, { response: result.response });
  }
});

test('entry is self contained and contains no service operation or executable copying path', () => {
  const content = fs.readFileSync(entry, 'utf8');
  assert.doesNotMatch(content, /\b(?:Start-Process|Stop-Process|Stop-Service|Start-Service|taskkill|cmd\s+\/c)\b/iu);
  assert.doesNotMatch(content, /Import-Module|^\s*\.\s+.*\.ps1/gmu);
  assert.match(content, /INDEPENDENT_OWNER_TERMINAL_REQUIRED/);
  assert.match(content, /EXACT_OWNER_PREPARE_DIRECTORY_CONFIRMATION_REQUIRED/);
  assert.match(content, /serviceActions = 0/);
});
