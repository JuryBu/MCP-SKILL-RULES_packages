import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCodexRuntimeBundle } from '../src/codex-runtime-bundle.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = path.join(repo, 'ops/apply-codex-outer-adoption-isolated.ps1');
const restore = path.join(repo, 'ops/restore-codex-outer-adoption-isolated.ps1');
const prepare = path.join(repo, 'ops/prepare-codex-outer-adoption.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const source = process.env.OUTER_ISOLATED_APPLY_SOURCE_PREPARATION;
const sourceSha = process.env.OUTER_ISOLATED_APPLY_SOURCE_SHA256;
const enabled = process.platform === 'win32' && Boolean(source && sourceSha);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psexecutionpolicypreference'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const output = enabled ? path.resolve(process.env.OUTER_ISOLATED_APPLY_OUTPUT_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'outer-isolated-apply-'))) : null;
const evidence = { startedAt: new Date().toISOString(), productionModified: false, paidModelCalls: false, fixtures: [] };

function insideTemp(value) {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(value));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Temp-only test resource');
}

function powershell(command) {
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${command}`], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, env: environment,
  });
  assert.ok(!result.error, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function inventory(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const value = path.join(entry.parentPath, entry.name);
    return [path.relative(root, value), digest(fs.readFileSync(value))];
  }).sort((left, right) => left[0].localeCompare(right[0]));
}

function snapshot(example) {
  const rows = powershell(`$rows=@(foreach($root in @(${quote(example.installed)},${quote(example.data)})){Get-ChildItem -LiteralPath $root -Recurse -Force | ForEach-Object {[pscustomobject]@{path=$_.FullName;directory=$_.PSIsContainer;sha256=$(if(-not $_.PSIsContainer){(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash});sddl=(Get-Acl -LiteralPath $_.FullName).Sddl;attributes=[int]$_.Attributes}}}); ConvertTo-Json -InputObject $rows -Depth 4 -Compress`);
  return JSON.parse(rows);
}

function write(root, name, bytes) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function invoke(example, script = apply, { overrides = {}, lockedTarget } = {}) {
  const values = { SampleRoot: example.sample, PreparationRoot: example.prepared, PreparationSha256: example.sha, OwnerId: example.owner, ...overrides };
  const args = Object.entries(values).flatMap(([key, value]) => [`-${key}`, value]);
  const locked = lockedTarget ? `$hold=[IO.File]::Open(${quote(lockedTarget)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { & ${quote(script)} ${Object.entries(values).map(([key, value]) => `-${key} ${quote(value)}`).join(' ')}; $scriptExit=$LASTEXITCODE } finally {$hold.Dispose()}; exit $scriptExit` : null;
  const argumentsList = ['-NoLogo', '-NoProfile', '-NonInteractive', ...(locked ? ['-Command', `$ErrorActionPreference='Stop'; ${locked}`] : ['-File', script, ...args])];
  const started = Date.now();
  const result = spawnSync(shell, argumentsList, { encoding: 'utf8', windowsHide: true, timeout: 180000, env: environment });
  assert.ok(!result.error, result.error?.message);
  let response;
  try { response = JSON.parse(result.stdout.trim()); } catch { assert.fail(`${result.stderr}\n${result.stdout}`); }
  const record = { command: [shell, ...argumentsList], elapsedMs: Date.now() - started, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, response };
  example.record.commands.push(record);
  fs.writeFileSync(path.join(example.base, `command-${example.record.commands.length}.json`), JSON.stringify(record, null, 2));
  return { ...result, response };
}

function fixture(label) {
  const base = fs.mkdtempSync(path.join(output, `${label}-`));
  const sample = path.join(base, 'sample');
  const installed = path.join(sample, 'installed');
  const data = path.join(sample, 'data');
  const prepared = path.join(base, 'prepared');
  const owner = 'isolated-apply-0723-test';
  fs.cpSync(path.join(source, 'original'), installed, { recursive: true, errorOnExist: true });
  fs.mkdirSync(path.join(data, 'state/codex-outer-runtime-candidates'), { recursive: true });
  for (const name of ['codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json']) write(data, `state/${name}`, `isolated unchanged ${name}\n`);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', prepare, '-SourceRoot', path.join(source, 'candidate'), '-InstalledRoot', installed, '-DataRoot', data, '-PreparationRoot', prepared, '-OwnerId', owner];
  const started = Date.now();
  const preparation = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env: environment });
  assert.equal(preparation.status, 0, preparation.stderr);
  const sha = digest(fs.readFileSync(path.join(prepared, 'preparation.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(prepared, 'preparation.json'), 'utf8'));
  assert.equal(manifest.files.length, 19);
  assert.equal(manifest.dependency.files.length, 19);
  const record = { label, base, sample, prepared, preparationSha: sha, preparation: { command: [shell, ...args], elapsedMs: Date.now() - started, exitCode: preparation.status, stdout: preparation.stdout, stderr: preparation.stderr }, commands: [] };
  evidence.fixtures.push(record);
  const example = { base, sample, installed, data, prepared, owner, sha, manifest, record };
  bind(example);
  example.original = snapshot(example);
  example.packageBefore = inventory(prepared);
  return example;
}

function bind(example) {
  write(example.sample, '.outer-adoption-isolated-owner.json', JSON.stringify({ schemaVersion: 1, mode: 'TEMP_ISOLATED_RECOVERY', ownerId: example.owner, sampleRoot: example.sample, preparationRoot: example.prepared, preparationSha256: example.sha, ...(example.runtimeBundle ? { runtimeBundle: example.runtimeBundle } : {}) }));
}

async function runtimeFixture(label, fifthExecutable = false) {
  const example = fixture(label);
  const sourceRoot = path.join(example.sample, 'local-app-data/OpenAI/Codex/bin');
  const names = ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe', ...(fifthExecutable ? ['codex-code-mode-node-host.exe'] : [])];
  for (const name of names) write(sourceRoot, name, `small transaction-only executable fixture: ${name}\n`);
  const bundle = await prepareCodexRuntimeBundle(path.join(sourceRoot, 'codex.exe'), {
    bundleRoot: path.join(example.data, 'state/codex-runtime-bundles'),
    validateBundleSignature: async (_root, entries) => { assert.equal(entries.length, names.length); },
  });
  const bundleRoot = path.dirname(bundle.executablePath);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleRoot, '.codex-runtime-manifest.json'), 'utf8'));
  const rows = snapshot(example).filter(row => path.dirname(row.path) === bundleRoot && !row.directory);
  example.runtimeBundle = { schemaVersion: 1, digest: manifest.digest, sourcePath: manifest.sourcePath, sourceMetadata: manifest.sourceMetadata, files: rows.map(row => ({ name: path.basename(row.path), path: row.path, exists: true, sha256: row.sha256.toLowerCase(), length: fs.statSync(row.path).size, sddl: row.sddl, attributes: row.attributes })) };
  write(example.data, 'state/codex-app-server-proxy-runtime.json', JSON.stringify({ state: 'stopped', executablePath: bundle.executablePath, lastKnownGoodExecutablePath: bundle.executablePath }));
  write(example.data, 'state/codex-app-server-proxy.jsonl', '{"transactionFixture":true}\n');
  bind(example);
  example.original = snapshot(example);
  example.record.runtime = { bundleRoot, digest: manifest.digest, executableCount: names.length, authenticOfficialSignaturesTested: false, generatedBy: 'prepareCodexRuntimeBundle', binding: example.runtimeBundle };
  return example;
}

function repinNegativeManifest(example, modify) {
  const manifestPath = path.join(example.prepared, 'preparation.json');
  const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  modify(value);
  fs.writeFileSync(manifestPath, JSON.stringify(value));
  example.sha = digest(fs.readFileSync(manifestPath));
  bind(example);
  example.record.negativeRepinSha = example.sha;
}

function assertRefused(example, pattern, options) {
  const before = snapshot(example);
  const result = invoke(example, apply, options);
  assert.equal(result.status, 1, JSON.stringify(result.response));
  assert.match(result.response.failed.message, pattern);
  assert.equal(result.response.targetsMayHaveChanged, false);
  assert.deepEqual(result.response.written, []);
  assert.deepEqual(snapshot(example), before);
  assert.equal(fs.existsSync(path.join(example.sample, '.outer-adoption-isolated-recovery.lock')), false);
  example.record.refusedWithoutTargetChange = true;
}

if (enabled) {
  insideTemp(source);
  assert.equal(digest(fs.readFileSync(path.join(source, 'preparation.json'))), sourceSha);
  const saved = JSON.parse(fs.readFileSync(path.join(source, 'preparation.json'), 'utf8'));
  for (const entry of [...saved.files, ...saved.dependency.files]) for (const side of ['original', 'candidate']) {
    if (entry[side].exists) assert.equal(digest(fs.readFileSync(path.join(source, side, entry.name))), entry[side].sha256);
  }
  assert.equal(digest(fs.readFileSync(restore)), '1cb485ef6ee13c8f514bf8912bcf302a843aea5582b6ff2fbca915ee1c69c6aa');
  fs.mkdirSync(output, { recursive: true });
  insideTemp(output);
  evidence.source = { root: source, sha256: sourceSha, fileInventory: inventory(source) };
  evidence.scripts = Object.fromEntries([apply, prepare, restore].map(value => [path.basename(value), digest(fs.readFileSync(value))]));
}

test('ordinary WinPS5.1 RemoteSigned and same four-argument independent Restore interface', { skip: !enabled }, () => {
  evidence.environment = JSON.parse(powershell('[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;policy=(Get-ExecutionPolicy).ToString();processPolicy=(Get-ExecutionPolicy -Scope Process).ToString();inheritedPolicy=$env:PSExecutionPolicyPreference} | ConvertTo-Json -Compress'));
  assert.match(evidence.environment.version, /^5\.1\./u);
  assert.equal(evidence.environment.edition, 'Desktop');
  assert.equal(evidence.environment.policy, 'RemoteSigned');
  assert.equal(evidence.environment.processPolicy, 'Undefined');
  assert.equal(evidence.environment.inheritedPolicy, null);
});

test('real Prepare package applies 19 files plus startup and independently restores bytes, ACL and invariants', { skip: !enabled }, () => {
  const example = fixture('normal');
  const result = invoke(example);
  assert.equal(result.status, 0, JSON.stringify(result.response));
  assert.equal(result.response.status, 'applied');
  assert.equal(result.response.completed.length, 20);
  assert.equal(result.response.packageFilesVerified, 65);
  assert.equal(result.response.dependencyFilesVerified, 19);
  assert.equal(result.response.preservedStateVerified, true);
  assert.equal(result.response.lockRemoved, true);
  for (const entry of example.manifest.files) assert.equal(digest(fs.readFileSync(path.join(example.installed, entry.name))), entry.candidate.sha256);
  assert.equal(digest(fs.readFileSync(path.join(example.data, 'state/codex-outer-runtime-startup.json'))), example.manifest.startup.sha256);
  assert.deepEqual(inventory(example.prepared), example.packageBefore);
  const recovered = invoke(example, restore);
  assert.equal(recovered.status, 0, JSON.stringify(recovered.response));
  assert.equal(recovered.response.status, 'restored');
  assert.deepEqual(snapshot(example), example.original);
  assert.deepEqual(inventory(example.prepared), example.packageBefore);
  example.record.restoredExactly = true;
});

test('late locked candidate destination leaves precise successful writes and independent recovery materials', { skip: !enabled }, () => {
  const example = fixture('locked');
  const target = example.manifest.files.findLast(entry => entry.original.exists && entry.operation === 'replace');
  const result = invoke(example, apply, { lockedTarget: path.join(example.installed, target.name) });
  assert.equal(result.status, 1);
  assert.equal(result.response.status, 'partial');
  assert.ok(result.response.written.length > 0);
  assert.ok(result.response.written.length < 19);
  assert.equal(result.response.failed.target, target.name);
  assert.equal(result.response.attempted.at(-1), target.name);
  assert.equal(result.response.written.includes(target.name), false);
  assert.equal(result.response.stagingRemoved, true);
  assert.equal(result.response.lockRemoved, true);
  assert.deepEqual(inventory(example.prepared), example.packageBefore);
  assert.equal(invoke(example, restore).status, 0);
  assert.deepEqual(snapshot(example), example.original);
  example.record.partialIndependentlyRestored = true;
});

test('input, original bytes, original ACL, dependency and unknown file changes refuse before any target write', { skip: !enabled }, () => {
  const cases = [
    ['manifest', example => fs.appendFileSync(path.join(example.prepared, 'preparation.json'), '\n'), /ISOLATED_PREPARATION_SHA_MISMATCH/u],
    ['original', example => fs.appendFileSync(path.join(example.installed, example.manifest.files.findLast(entry => entry.original.exists).name), '\nforeign'), /ISOLATED_ORIGINAL_SHA_ACL_DRIFT/u],
    ['acl', example => {
      const target = path.join(example.installed, example.manifest.files.findLast(entry => entry.original.exists).name);
      example.record.aclMutation = JSON.parse(powershell(`$value=${quote(target)}; $before=(Get-Acl -LiteralPath $value).Sddl; $acl=Get-Acl -LiteralPath $value; $acl.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $value -AclObject $acl; [pscustomobject]@{before=$before;after=(Get-Acl -LiteralPath $value).Sddl} | ConvertTo-Json -Compress`));
      assert.notEqual(example.record.aclMutation.before, example.record.aclMutation.after);
    }, /ISOLATED_ORIGINAL_SHA_ACL_DRIFT/u],
    ['candidate', example => fs.appendFileSync(path.join(example.prepared, 'candidate', example.manifest.files.at(-1).name), '\nforeign'), /ISOLATED_PACKAGE_SHA_MISMATCH/u],
    ['dependency', example => fs.appendFileSync(path.join(example.installed, 'node_modules/ws/lib/websocket.js'), '\nforeign'), /ISOLATED_ORIGINAL_SHA_ACL_DRIFT/u],
    ['unknown', example => write(example.installed, 'foreign.txt', 'unknown'), /ISOLATED_UNKNOWN_OR_MISSING_FILE/u],
  ];
  for (const [label, modify, pattern] of cases) {
    const example = fixture(label);
    modify(example);
    assertRefused(example, pattern);
  }
});

test('fixed set duplicates, startup semantic drift, links and owner conflicts are fail-closed', { skip: !enabled }, () => {
  const duplicate = fixture('duplicate');
  repinNegativeManifest(duplicate, manifest => { manifest.files[17] = manifest.files[16]; });
  assertRefused(duplicate, /ISOLATED_FIXED_FILE_SET_REQUIRED/u);
  const config = fixture('startup');
  fs.appendFileSync(path.join(config.prepared, 'candidate-startup.json'), '\n');
  assertRefused(config, /ISOLATED_STARTUP_SHA_MISMATCH/u);
  const semantic = fixture('startup-semantic');
  const startupPath = path.join(semantic.prepared, 'candidate-startup.json');
  const startupValue = JSON.parse(fs.readFileSync(startupPath, 'utf8'));
  startupValue.enabled = false;
  fs.writeFileSync(startupPath, JSON.stringify(startupValue));
  repinNegativeManifest(semantic, manifest => { manifest.startup.candidate = startupValue; manifest.startup.sha256 = digest(fs.readFileSync(startupPath)); });
  assertRefused(semantic, /ISOLATED_STARTUP_SEMANTICS_MISMATCH/u);
  const directory = fixture('candidate-directory');
  fs.rmdirSync(path.join(directory.data, 'state/codex-outer-runtime-candidates'));
  assertRefused(directory, /ISOLATED_DIRECTORY_MISSING/u);
  const junction = fixture('junction');
  const original = path.join(junction.installed, 'ops');
  const moved = path.join(junction.base, 'original-ops');
  fs.renameSync(original, moved);
  fs.symlinkSync(moved, original, 'junction');
  const result = invoke(junction);
  assert.equal(result.status, 1);
  assert.match(result.response.failed.message, /ISOLATED_REPARSE_POINT_REJECTED/u);
  assert.equal(result.response.targetsMayHaveChanged, false);
  fs.unlinkSync(original);
  fs.renameSync(moved, original);
  assert.deepEqual(snapshot(junction), junction.original);
  const hardlink = fixture('hardlink');
  const linkedTarget = path.join(hardlink.installed, hardlink.manifest.files.findLast(entry => entry.original.exists).name);
  const outsideName = path.join(hardlink.base, 'foreign-linked-original');
  fs.renameSync(linkedTarget, outsideName);
  fs.linkSync(outsideName, linkedTarget);
  const linked = invoke(hardlink);
  assert.equal(linked.status, 1);
  assert.match(linked.response.failed.message, /ISOLATED_LINK_REJECTED/u);
  assert.equal(linked.response.targetsMayHaveChanged, false);
  fs.unlinkSync(linkedTarget);
  fs.renameSync(outsideName, linkedTarget);
  assert.deepEqual(snapshot(hardlink), hardlink.original);
  const locked = fixture('owner-lock');
  const lock = path.join(locked.sample, '.outer-adoption-isolated-recovery.lock');
  const foreign = JSON.stringify({ ownerId: 'foreign-owner', nonce: crypto.randomUUID() });
  fs.writeFileSync(lock, foreign, { flag: 'wx' });
  const conflict = invoke(locked);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.response.targetsMayHaveChanged, false);
  assert.equal(fs.readFileSync(lock, 'utf8'), foreign);
  assert.deepEqual(snapshot(locked), locked.original);
  fs.unlinkSync(lock);
  assertRefused(locked, /ISOLATED_OWNERSHIP_MISMATCH/u, { overrides: { OwnerId: 'foreign-owner' } });
  assertRefused(locked, /ISOLATED_TEMP_ROOT_REQUIRED/u, { overrides: { SampleRoot: repo } });
});

test('an external invariant change after the first committed candidate stops later writes and preserves foreign bytes', { skip: !enabled }, async () => {
  const example = fixture('concurrent-invariant');
  const values = { SampleRoot: example.sample, PreparationRoot: example.prepared, PreparationSha256: example.sha, OwnerId: example.owner };
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', apply, ...Object.entries(values).flatMap(([key, value]) => [`-${key}`, value])];
  const started = Date.now();
  const child = spawn(shell, args, { windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let finished = false;
  child.stdout.on('data', bytes => { stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { finished = true; resolve(code); });
  });
  const foreignPath = path.join(example.data, 'state/codex-app-server-wake-journal.json');
  let changed = false;
  while (!finished && Date.now() - started < 180000) {
    const journal = fs.readdirSync(example.sample).find(name => name.startsWith('apply-result-'));
    if (journal) {
      let state;
      try { state = JSON.parse(fs.readFileSync(path.join(example.sample, journal), 'utf8')); } catch {}
      if (state?.written.length > 0) {
        fs.appendFileSync(foreignPath, 'external invariant change\n');
        changed = true;
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  const exitCode = await closed;
  const response = JSON.parse(stdout.trim());
  const record = { command: [shell, ...args], elapsedMs: Date.now() - started, exitCode, stdout, stderr, response, externalChanged: changed };
  example.record.commands.push(record);
  fs.writeFileSync(path.join(example.base, 'command-1.json'), JSON.stringify(record, null, 2));
  assert.equal(changed, true);
  assert.equal(exitCode, 1);
  assert.equal(response.status, 'partial');
  assert.match(response.failed.message, /ISOLATED_CONCURRENT_DRIFT/u);
  assert.ok(response.written.length > 0 && response.written.length < 15);
  assert.equal(response.lockRemoved, true);
  assert.deepEqual(inventory(example.prepared), example.packageBefore);
  const foreignBytes = fs.readFileSync(foreignPath);
  const recovered = invoke(example, restore);
  assert.equal(recovered.status, 0, JSON.stringify(recovered.response));
  assert.deepEqual(fs.readFileSync(foreignPath), foreignBytes);
  assert.deepEqual(snapshot(example).filter(row => row.path !== foreignPath), example.original.filter(row => row.path !== foreignPath));
  example.record.foreignBytesPreservedAndTargetsRestored = true;
});

test('runtime bundle exact four/five executable structure remains read-only through Apply and independent Restore', { skip: !enabled }, async () => {
  for (const fifth of [false, true]) {
    const example = await runtimeFixture(`runtime-${fifth ? 'five' : 'four'}`, fifth);
    const result = invoke(example);
    assert.equal(result.status, 0, JSON.stringify(result.response));
    assert.equal(result.response.completed.length, 20);
    assert.equal(result.response.runtimeBundle.filesVerified, fifth ? 6 : 5);
    assert.equal(result.response.runtimeBundle.readOnlyHeld, true);
    assert.deepEqual(snapshot(example).filter(row => row.path.includes('codex-runtime-bundles')), example.original.filter(row => row.path.includes('codex-runtime-bundles')));
    assert.equal(invoke(example, restore).status, 0);
    assert.deepEqual(snapshot(example), example.original);
    example.record.runtimePreservedAndRestored = true;
  }
});

test('runtime bundle unbound, SHA, ACL, provenance, extra tree and original failure guards refuse before writing', { skip: !enabled }, async () => {
  const example = await runtimeFixture('runtime-guards');
  const binding = structuredClone(example.runtimeBundle);
  delete example.runtimeBundle;
  bind(example);
  assertRefused(example, /ISOLATED_RUNTIME_BINDING_REQUIRED/u);
  example.runtimeBundle = structuredClone(binding);
  example.runtimeBundle.files[0].sha256 = '0'.repeat(64);
  bind(example);
  assertRefused(example, /ISOLATED_ORIGINAL_SHA_ACL_DRIFT/u);
  example.runtimeBundle = structuredClone(binding);
  example.runtimeBundle.sourceMetadata = '0'.repeat(64);
  bind(example);
  assertRefused(example, /ISOLATED_RUNTIME_SOURCE_BINDING_MISMATCH/u);
  example.runtimeBundle = structuredClone(binding);
  bind(example);
  const extra = path.join(example.record.runtime.bundleRoot, 'foreign.exe');
  fs.writeFileSync(extra, 'foreign executable');
  assertRefused(example, /ISOLATED_RUNTIME_TREE_REJECTED/u);
  fs.unlinkSync(extra);
  const unknown = path.join(example.data, 'state/foreign-state.json');
  fs.writeFileSync(unknown, '{}');
  assertRefused(example, /ISOLATED_UNKNOWN_DATA_FILE/u);
  fs.unlinkSync(unknown);
  const original = path.join(example.installed, example.manifest.files.findLast(entry => entry.original.exists).name);
  const originalBytes = fs.readFileSync(original);
  fs.appendFileSync(original, '\nforeign original');
  assertRefused(example, /ISOLATED_ORIGINAL_SHA_ACL_DRIFT/u);
  fs.writeFileSync(original, originalBytes);
  assert.deepEqual(snapshot(example), example.original);
  const target = binding.files.find(entry => entry.name === 'codex.exe');
  powershell(`$value=${quote(target.path)}; $acl=Get-Acl -LiteralPath $value; $acl.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $value -AclObject $acl`);
  assertRefused(example, /ISOLATED_ORIGINAL_SHA_ACL_DRIFT/u);
  example.record.retainedSelfOwnedAclPerturbation = target.path;
});

after(() => {
  if (!enabled) return;
  evidence.finishedAt = new Date().toISOString();
  evidence.elapsedMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
  evidence.sourceUnchanged = digest(fs.readFileSync(path.join(source, 'preparation.json'))) === sourceSha && JSON.stringify(inventory(source)) === JSON.stringify(evidence.source.fileInventory);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidence: path.join(output, 'result.json'), sha256: digest(fs.readFileSync(path.join(output, 'result.json'))), fixtures: evidence.fixtures.length, elapsedMs: evidence.elapsedMs, sourceUnchanged: evidence.sourceUnchanged }));
  assert.equal(evidence.sourceUnchanged, true);
});
