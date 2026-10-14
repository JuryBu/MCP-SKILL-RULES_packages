import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'ops/restore-codex-outer-adoption-isolated.ps1');
const prepare = path.join(repo, 'ops/prepare-codex-outer-adoption.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const powershellEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psexecutionpolicypreference'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const names = [...fs.readFileSync(prepare, 'utf8').split('$FileNames = @(')[1].split('\n)')[0].matchAll(/'([^']+)'/gu)].map(match => match[1]);
const isWindows = process.platform === 'win32';
const output = isWindows ? path.resolve(process.env.OUTER_ISOLATED_RECOVERY_OUTPUT_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'outer-adoption-isolated-tests-'))) : null;
const evidence = [];
let environmentEvidence;
if (isWindows) {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Test output must be within Temp');
  fs.mkdirSync(output, { recursive: true });
}

function powershell(command) {
  return spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${command}`], {
    encoding: 'utf8', windowsHide: true, timeout: 20000, env: powershellEnvironment,
  });
}

function checked(command) {
  const result = powershell(command);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function write(directory, name, bytes) {
  const target = path.join(directory, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function inventory(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const full = path.join(entry.parentPath, entry.name);
    return [path.relative(directory, full), digest(fs.readFileSync(full))];
  }).sort((left, right) => left[0].localeCompare(right[0]));
}

function aclInventory(directory) {
  return JSON.parse(checked(`$rows=@(Get-ChildItem -LiteralPath ${quote(directory)} -File -Recurse | ForEach-Object {[pscustomobject]@{path=$_.FullName;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}}); ConvertTo-Json -InputObject $rows -Compress`));
}

function snapshot(example) {
  return { installed: inventory(example.installed), data: inventory(example.data), acl: [...aclInventory(example.installed), ...aclInventory(example.data)] };
}

function protectDirectory(directory, minimal = false) {
  checked(`$value=${quote(directory)}; $acl=Get-Acl -LiteralPath $value; $acl.SetAccessRuleProtection($true,${minimal ? '$false' : '$true'}); ${minimal ? "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($rule)}; foreach($sid in @([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),$identity)){$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);[void]$acl.AddAccessRule($rule)};" : ''} Set-Acl -LiteralPath $value -AclObject $acl`);
}

function fixture(label, { startup = false, existingPreparation } = {}) {
  const base = fs.mkdtempSync(path.join(output, `${label}-`));
  const sample = path.join(base, 'sample');
  const source = path.join(base, 'source');
  const installed = path.join(sample, 'installed');
  const data = path.join(sample, 'data');
  const prepared = existingPreparation ?? path.join(base, 'prepared');
  for (const directory of [sample, source, installed, data]) fs.mkdirSync(directory, { recursive: true });
  protectDirectory(sample, Boolean(existingPreparation));
  protectDirectory(installed, Boolean(existingPreparation));
  protectDirectory(data, Boolean(existingPreparation));
  const owner = existingPreparation ? JSON.parse(fs.readFileSync(path.join(prepared, 'preparation.json'), 'utf8')).ownerId : 'isolated-recovery-test';
  if (existingPreparation) {
    const original = JSON.parse(fs.readFileSync(path.join(prepared, 'preparation.json'), 'utf8'));
    for (const entry of original.files) if (entry.original.exists) write(installed, entry.name, fs.readFileSync(path.join(prepared, 'original', entry.name)));
    if (original.startup.original.exists) write(data, 'state/codex-outer-runtime-startup.json', fs.readFileSync(path.join(prepared, 'original-startup.json')));
  } else {
    for (const [index, name] of names.entries()) {
      write(source, name, `candidate ${name}\n`);
      if (index % 3) write(installed, name, index % 3 === 1 ? `original ${name}\n` : `candidate ${name}\n`);
    }
    for (const name of ['ops/start-codex-app-server-proxy.ps1', 'ops/resolve-napcat-data-root.ps1', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs']) {
      if (!fs.existsSync(path.join(installed, name))) write(installed, name, `original ${name}\n`);
    }
    for (const directory of [source, installed]) write(directory, 'node_modules/ws/package.json', '{"name":"ws","version":"isolated"}');
    if (startup) write(data, 'state/codex-outer-runtime-startup.json', '{"schemaVersion":1,"enabled":false,"original":"saved"}');
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', prepare,
      '-SourceRoot', source, '-InstalledRoot', installed, '-DataRoot', data, '-PreparationRoot', prepared, '-OwnerId', owner], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, env: powershellEnvironment,
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of ['codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json']) write(data, `state/${name}`, `preserved isolated ${name}`);
  const manifestPath = path.join(prepared, 'preparation.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestSha = digest(fs.readFileSync(manifestPath));
  const anchor = { schemaVersion: 1, mode: 'TEMP_ISOLATED_RECOVERY', ownerId: owner, sampleRoot: sample, preparationRoot: prepared, preparationSha256: manifestSha };
  write(sample, '.outer-adoption-isolated-owner.json', JSON.stringify(anchor));
  const record = { label, base, sample, prepared, manifestSha, commands: [] };
  evidence.push(record);
  const example = { base, sample, source, installed, data, prepared, owner, manifest, manifestSha, record };
  example.original = snapshot(example);
  record.original = example.original;
  for (const entry of manifest.files) write(installed, entry.name, fs.readFileSync(path.join(prepared, 'candidate', entry.name)));
  write(data, 'state/codex-outer-runtime-startup.json', fs.readFileSync(path.join(prepared, 'candidate-startup.json')));
  example.invoke = (overrides = {}, lockedTarget) => {
    const values = { SampleRoot: sample, PreparationRoot: prepared, PreparationSha256: manifestSha, OwnerId: owner, ...overrides };
    const argumentsList = Object.entries(values).flatMap(([key, value]) => [`-${key}`, value]);
    const lockedCommand = lockedTarget ? `$hold=[IO.File]::Open(${quote(lockedTarget)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { & ${quote(script)} ${Object.entries(values).map(([key, value]) => `-${key} ${quote(value)}`).join(' ')}; $scriptExit=$LASTEXITCODE } finally {$hold.Dispose()}; exit $scriptExit` : null;
    const result = lockedTarget
      ? powershell(lockedCommand)
      : spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...argumentsList], { encoding: 'utf8', windowsHide: true, timeout: 20000, env: powershellEnvironment });
    assert.ok(!result.error, result.error?.message);
    const response = JSON.parse(result.stdout.trim());
    record.commands.push({ command: lockedTarget ? [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${lockedCommand}`] : [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...argumentsList], lockedTarget, exitCode: result.status, response, stderr: result.stderr });
    fs.writeFileSync(path.join(base, `command-${record.commands.length}.json`), JSON.stringify(record.commands.at(-1), null, 2));
    return { ...result, response };
  };
  return example;
}

function changeAcl(value) {
  return JSON.parse(checked(`$value=${quote(value)}; $before=(Get-Acl -LiteralPath $value).Sddl; $acl=Get-Acl -LiteralPath $value; $acl.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $value -AclObject $acl; [pscustomobject]@{before=$before;changed=(Get-Acl -LiteralPath $value).Sddl;version=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress`));
}

function assertRestored(example, result) {
  assert.equal(result.status, 0, JSON.stringify(result.response));
  assert.equal(result.response.status, 'restored');
  assert.equal(result.response.completed.length, 20);
  assert.equal(result.response.preservedStateVerified, true);
  assert.equal(result.response.lockRemoved, true);
  for (const entry of example.manifest.files) {
    const target = path.join(example.installed, entry.name);
    assert.equal(fs.existsSync(target), entry.original.exists, entry.name);
    if (entry.original.exists) {
      assert.equal(digest(fs.readFileSync(target)), entry.original.sha256, entry.name);
      assert.equal(checked(`(Get-Acl -LiteralPath ${quote(target)}).Sddl`), entry.original.sddl, entry.name);
    }
  }
  const startup = path.join(example.data, 'state/codex-outer-runtime-startup.json');
  assert.equal(fs.existsSync(startup), example.manifest.startup.original.exists);
  if (example.manifest.startup.original.exists) {
    assert.equal(digest(fs.readFileSync(startup)), example.manifest.startup.original.sha256);
    assert.equal(checked(`(Get-Acl -LiteralPath ${quote(startup)}).Sddl`), example.manifest.startup.original.sddl);
  }
  for (const [name, sha] of example.original.data.filter(([name]) => !name.endsWith('codex-outer-runtime-startup.json'))) assert.equal(digest(fs.readFileSync(path.join(example.data, name))), sha);
  example.record.restored = { installed: inventory(example.installed), data: inventory(example.data), acl: [...aclInventory(example.installed), ...aclInventory(example.data)] };
}

test('real child uses ordinary Windows PowerShell 5.1 without an ExecutionPolicy override', { skip: !isWindows }, () => {
  environmentEvidence = JSON.parse(checked("[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;policy=(Get-ExecutionPolicy).ToString();processPolicy=(Get-ExecutionPolicy -Scope Process).ToString();nodeInheritedPolicy=$env:PSExecutionPolicyPreference} | ConvertTo-Json -Compress"));
  assert.match(environmentEvidence.version, /^5\.1\./u);
  assert.equal(environmentEvidence.edition, 'Desktop');
  assert.notEqual(environmentEvidence.policy, 'Bypass');
  assert.equal(environmentEvidence.processPolicy, 'Undefined');
  assert.equal(environmentEvidence.nodeInheritedPolicy, null);
});

test('same independent script restores 18-file bytes and full real owner/group/DACL; absent startup and idempotency', { skip: !isWindows }, () => {
  const example = fixture('absent-startup');
  const target = path.join(example.installed, example.manifest.files.find(entry => entry.original.exists).name);
  const changed = changeAcl(target);
  assert.notEqual(changed.before, changed.changed);
  assert.match(changed.version, /^5\.1\./u);
  example.record.realAclChange = changed;
  assertRestored(example, example.invoke());
  assertRestored(example, example.invoke());
});

test('saved startup bytes and complete ACL restore when original configuration existed', { skip: !isWindows }, () => {
  const example = fixture('present-startup', { startup: true });
  example.record.realAclChange = changeAcl(path.join(example.data, 'state/codex-outer-runtime-startup.json'));
  assertRestored(example, example.invoke());
});

test('one foreign added-file drift refuses every target before modification', { skip: !isWindows }, () => {
  const example = fixture('added-drift');
  const entry = example.manifest.files.findLast(entry => !entry.original.exists);
  write(example.installed, entry.name, 'foreign new-file content');
  const before = snapshot(example);
  const result = example.invoke();
  assert.equal(result.status, 1);
  assert.match(result.response.failed.message, /ISOLATED_ADDED_FILE_DRIFT/u);
  assert.equal(result.response.targetsMayHaveChanged, false);
  assert.deepEqual(snapshot(example), before);
});

test('late backup SHA failure refuses before the first eligible added file is removed', { skip: !isWindows }, () => {
  const example = fixture('backup-sha');
  const entry = example.manifest.files.findLast(entry => entry.original.exists);
  write(example.prepared, `original/${entry.name}`, 'corrupted backup');
  const before = snapshot(example);
  const result = example.invoke();
  assert.match(result.response.failed.message, /ISOLATED_BACKUP_SHA_MISMATCH/u);
  assert.equal(result.response.targetsMayHaveChanged, false);
  assert.deepEqual(snapshot(example), before);
});

test('owner, pinned manifest and non-Temp roots are refused without touching target bytes or ACLs', { skip: !isWindows }, () => {
  const example = fixture('identity');
  const before = snapshot(example);
  assert.match(example.invoke({ OwnerId: 'foreign-owner' }).response.failed.message, /ISOLATED_OWNERSHIP_MISMATCH/u);
  assert.match(example.invoke({ SampleRoot: repo }).response.failed.message, /ISOLATED_TEMP_ROOT_REQUIRED/u);
  fs.appendFileSync(path.join(example.prepared, 'preparation.json'), '\n');
  assert.match(example.invoke().response.failed.message, /ISOLATED_PREPARATION_SHA_MISMATCH/u);
  assert.deepEqual(snapshot(example), before);
});

test('root and nested target junctions are refused without following redirected writes', { skip: !isWindows }, () => {
  const example = fixture('junction');
  const alias = path.join(example.base, 'alias');
  fs.symlinkSync(example.sample, alias, 'junction');
  assert.match(example.invoke({ SampleRoot: alias }).response.failed.message, /ISOLATED_REPARSE_POINT_REJECTED/u);
  fs.unlinkSync(alias);
  const relocated = path.join(example.base, 'relocated-ops');
  fs.renameSync(path.join(example.installed, 'ops'), relocated);
  fs.symlinkSync(relocated, path.join(example.installed, 'ops'), 'junction');
  const before = inventory(relocated);
  assert.match(example.invoke().response.failed.message, /ISOLATED_REPARSE_POINT_REJECTED/u);
  assert.deepEqual(inventory(relocated), before);
  fs.unlinkSync(path.join(example.installed, 'ops'));
  fs.renameSync(relocated, path.join(example.installed, 'ops'));
});

test('backup junction and hard-linked targets are refused before modification', { skip: !isWindows }, () => {
  const example = fixture('backup-link');
  const saved = path.join(example.prepared, 'original', 'ops');
  const relocated = path.join(example.base, 'relocated-backup');
  fs.renameSync(saved, relocated);
  fs.symlinkSync(relocated, saved, 'junction');
  const before = snapshot(example);
  assert.match(example.invoke().response.failed.message, /ISOLATED_REPARSE_POINT_REJECTED/u);
  assert.deepEqual(snapshot(example), before);
  fs.unlinkSync(saved);
  fs.renameSync(relocated, saved);
  const target = path.join(example.installed, names[0]);
  fs.linkSync(target, path.join(example.base, 'hard-link'));
  assert.match(example.invoke().response.failed.message, /ISOLATED_HARD_LINK_REJECTED/u);
  fs.unlinkSync(path.join(example.base, 'hard-link'));
});

test('foreign replaced-file and startup configuration drift are preserved', { skip: !isWindows }, () => {
  const example = fixture('existing-drift', { startup: true });
  const target = example.manifest.files.find(entry => entry.operation === 'replace');
  write(example.installed, target.name, 'foreign replaced-file content');
  const before = snapshot(example);
  assert.match(example.invoke().response.failed.message, /ISOLATED_TARGET_DRIFT/u);
  assert.deepEqual(snapshot(example), before);
  write(example.installed, target.name, fs.readFileSync(path.join(example.prepared, 'candidate', target.name)));
  write(example.data, 'state/codex-outer-runtime-startup.json', 'foreign startup');
  const startupBefore = snapshot(example);
  assert.match(example.invoke().response.failed.message, /ISOLATED_TARGET_DRIFT/u);
  assert.deepEqual(snapshot(example), startupBefore);
});

test('real sharing violation leaves explicit partial result and releases only its own lock; same script can finish', { skip: !isWindows }, () => {
  const example = fixture('partial', { startup: true });
  const target = path.join(example.data, 'state/codex-outer-runtime-startup.json');
  const result = example.invoke({}, target);
  assert.equal(result.status, 1);
  assert.equal(result.response.status, 'partial');
  assert.equal(result.response.targetsMayHaveChanged, true);
  assert.equal(result.response.completed.length, 19);
  assert.equal(result.response.failed.target, 'state/codex-outer-runtime-startup.json');
  assert.equal(result.response.lockRemoved, true);
  assert.equal(fs.existsSync(result.response.resultPath), true);
  assertRestored(example, example.invoke());
});

test('read-only saved private 18-item preparation restores its exact original ACLs in Temp through the same script', { skip: !isWindows || !process.env.OUTER_ISOLATED_RECOVERY_PREPARATION }, () => {
  const prepared = path.resolve(process.env.OUTER_ISOLATED_RECOVERY_PREPARATION);
  const pinned = process.env.OUTER_ISOLATED_RECOVERY_PREPARATION_SHA256;
  assert.equal(digest(fs.readFileSync(path.join(prepared, 'preparation.json'))), pinned);
  const before = inventory(prepared);
  const example = fixture('saved-preparation', { existingPreparation: prepared });
  const entry = example.manifest.files.find(entry => entry.operation === 'replace');
  example.record.realAclChange = changeAcl(path.join(example.installed, entry.name));
  assert.notEqual(example.record.realAclChange.before, example.record.realAclChange.changed);
  assertRestored(example, example.invoke());
  assert.deepEqual(inventory(prepared), before);
  assert.equal(digest(fs.readFileSync(path.join(prepared, 'preparation.json'))), pinned);
});

after(() => {
  if (isWindows) fs.writeFileSync(path.join(output, 'suite-evidence.json'), JSON.stringify({ output, shell, node: process.version, environmentEvidence, productionTargetsUsed: false, servicesStarted: false, retainedOwnedTempEvidence: evidence }, null, 2));
});
