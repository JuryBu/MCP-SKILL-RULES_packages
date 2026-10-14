import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(project, 'ops/codex-outer-adoption-window-transaction.ps1');
const prepare = path.join(project, 'ops/prepare-codex-outer-adoption.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const seed = process.env.OUTER_PARENT_SOURCE_PREPARATION;
const enabled = process.platform === 'win32' && Boolean(seed && process.env.OUTER_PARENT_SOURCE_SHA256);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psexecutionpolicypreference'));
const sha = value => crypto.createHash('sha256').update(fs.readFileSync(value)).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const output = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'outer-window-transaction-0800-')) : null;
const evidence = { startedAt: new Date().toISOString(), productionModified: false, paidModelCalls: false, serviceProcessesCreated: [], listenerPortsCreated: [], fixtures: [], commands: [] };
const sourceHash = sha(entry);

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}

function invoke(script, values, lockedTarget) {
  const fragments = Object.entries(values).map(([name, value]) => `-${name} ${quote(value)}`).join(' ');
  const args = lockedTarget
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $hold=[IO.File]::Open(${quote(lockedTarget)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try { & ${quote(script)} ${fragments}; $code=$LASTEXITCODE } finally { $hold.Dispose() }; exit $code`]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...Object.entries(values).flatMap(([name, value]) => [`-${name}`, String(value)])];
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const run = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true, timeout: 150000, env: environment });
  assert.ok(!run.error, `${run.error?.message}\n${run.stderr}\n${run.stdout}`);
  let response;
  try { response = JSON.parse(run.stdout.trim()); } catch { assert.fail(`${run.stderr}\n${run.stdout}`); }
  evidence.commands.push({ command: [shell, ...args], startedAt, elapsedMs: Date.now() - started, exitCode: run.status, stdout: run.stdout, stderr: run.stderr, response });
  return { ...run, response };
}

function fixture(label, mode = 'TempMapping') {
  const base = fs.mkdtempSync(path.join(output, `${label}-`));
  const sample = path.join(base, 'sample');
  const installed = path.join(sample, 'installed');
  const data = path.join(sample, 'data');
  const prepared = path.join(base, 'prepared');
  const contractRoot = path.join(base, 'contract');
  const owner = 'outer-window-transaction-0800-test';
  fs.cpSync(path.join(seed, 'original'), installed, { recursive: true, errorOnExist: true });
  fs.mkdirSync(path.join(data, 'state/codex-outer-runtime-candidates'), { recursive: true });
  for (const name of ['codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json']) write(data, `state/${name}`, `preserved ${name}\n`);
  const startup = write(data, 'state/codex-outer-runtime-startup.json', { schemaVersion: 1, enabled: false });
  const planning = invoke(prepare, { SourceRoot: path.join(seed, 'candidate'), InstalledRoot: installed, DataRoot: data, PreparationRoot: prepared, OwnerId: owner });
  assert.equal(planning.status, 0, planning.stderr);
  const preparationSha256 = sha(path.join(prepared, 'preparation.json'));
  write(sample, '.outer-adoption-isolated-owner.json', { schemaVersion: 1, mode: 'TEMP_ISOLATED_RECOVERY', ownerId: owner, sampleRoot: sample, preparationRoot: prepared, preparationSha256 });
  const ready = invoke(entry, { Action: 'Prepare', Mode: mode, PreparationRoot: prepared, PreparationSha256: preparationSha256, OwnerId: owner, SampleRoot: sample, ContractRoot: contractRoot, PowerShellPath: shell, NodePath: process.execPath });
  assert.equal(ready.status, 0, JSON.stringify(ready.response));
  const binding = { Mode: mode, ContractRoot: contractRoot, ContractSha256: ready.response.contractSha256 };
  const protectedBefore = ['codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json'].map(name => [name, sha(path.join(data, 'state', name))]);
  const record = { label, base, sample, binding, recoveryEntry: ready.response.recoveryEntry };
  evidence.fixtures.push(record);
  return { installed, data, startup, binding, record, protectedBefore };
}

if (enabled) assert.equal(sha(path.join(seed, 'preparation.json')), process.env.OUTER_PARENT_SOURCE_SHA256);

test('fresh owner gate is read-only and rejects changed original files before creating an attempt', { skip: !enabled }, () => {
  const example = fixture('fresh-owner-gate');
  const files = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(item => {
    const target = path.join(root, item.name);
    return item.isDirectory() ? files(target) : [[target, sha(target)]];
  }).sort(([left], [right]) => left.localeCompare(right));
  const before = files(example.record.base);
  const gate = invoke(entry, { Action: 'VerifyOwnerGate', ...example.binding });
  assert.equal(gate.status, 0, JSON.stringify(gate.response));
  assert.equal(gate.response.status, 'owner-gate-verified');
  assert.equal(gate.response.productionModified, false);
  assert.deepEqual(files(example.record.base), before);
  assert.equal(fs.existsSync(path.join(example.binding.ContractRoot, 'transaction-attempt.json')), false);
  const contract = JSON.parse(fs.readFileSync(path.join(example.binding.ContractRoot, 'transaction-contract.json'), 'utf8'));
  const target = contract.items.find(item => item.original.exists).target;
  fs.appendFileSync(target, '\nexternal-change\n');
  const changed = files(example.record.base);
  const refused = invoke(entry, { Action: 'VerifyOwnerGate', ...example.binding });
  assert.equal(refused.status, 1, JSON.stringify(refused.response));
  assert.deepEqual(files(example.record.base), changed);
  assert.equal(fs.existsSync(path.join(example.binding.ContractRoot, 'transaction-attempt.json')), false);
  example.record.ownerGateReadOnlyAndOriginalDriftRefused = { gate: gate.response, refused: refused.response };
});

test('production default refuses an unapproved write and preserves all input bytes', { skip: !enabled }, () => {
  const example = fixture('unapproved-production-mode', 'Production');
  const before = sha(example.startup);
  const run = invoke(entry, { Action: 'Apply', ...example.binding });
  assert.equal(run.status, 1);
  assert.equal(run.response.error, 'WINDOW_NEW_OWNER_APPROVAL_REQUIRED');
  assert.equal(sha(example.startup), before);
  assert.equal(fs.existsSync(path.join(example.binding.ContractRoot, 'transaction-attempt.json')), false);
  example.record.unapprovedNoWrites = true;
});

test('fixed20 success, repeat verification and frozen independent Restore preserve protected state', { skip: !enabled }, () => {
  const example = fixture('success');
  const apply = invoke(entry, { Action: 'Apply', ...example.binding });
  assert.equal(apply.status, 0, JSON.stringify(apply.response));
  assert.equal(apply.response.completed.length, 20);
  const attemptPath = apply.response.receiptPath;
  const before = sha(attemptPath);
  const repeat = invoke(entry, { Action: 'Apply', ...example.binding });
  assert.equal(repeat.status, 0, JSON.stringify(repeat.response));
  assert.equal(repeat.response.status, 'already-written-verified');
  assert.equal(sha(attemptPath), before);
  const restore = invoke(example.record.recoveryEntry, { Action: 'Restore', ...example.binding });
  assert.equal(restore.status, 0, JSON.stringify(restore.response));
  assert.equal(restore.response.completed.length, 20);
  for (const [name, hash] of example.protectedBefore) assert.equal(sha(path.join(example.data, 'state', name)), hash);
  example.record.all20AndIndependentRestore = true;
});

test('real final-file lock retains partial receipt; no repeat; independent Restore recovers20', { skip: !enabled }, () => {
  const example = fixture('locked-final-startup');
  const run = invoke(entry, { Action: 'Apply', ...example.binding }, example.startup);
  assert.equal(run.status, 1, JSON.stringify(run.response));
  assert.equal(run.response.status, 'partial');
  assert.equal(run.response.completed.length, 19);
  assert.ok(run.response.written.length > 0);
  const attemptSha = sha(run.response.receiptPath);
  const repeat = invoke(entry, { Action: 'Apply', ...example.binding });
  assert.equal(repeat.status, 1);
  assert.equal(repeat.response.error, 'WINDOW_ATTEMPT_UNKNOWN_OR_TERMINAL');
  assert.equal(sha(run.response.receiptPath), attemptSha);
  const restore = invoke(example.record.recoveryEntry, { Action: 'Restore', ...example.binding });
  assert.equal(restore.status, 0, JSON.stringify(restore.response));
  assert.equal(restore.response.completed.length, 20);
  for (const [name, hash] of example.protectedBefore) assert.equal(sha(path.join(example.data, 'state', name)), hash);
  example.record.partialRetainedAndRestored = true;
});

test('external attributes and SDDL on candidate bytes are preserved before any Restore write', { skip: !enabled }, () => {
  const example = fixture('external-metadata');
  const applied = invoke(entry, { Action: 'Apply', ...example.binding });
  assert.equal(applied.status, 0, JSON.stringify(applied.response));
  const receipt = JSON.parse(fs.readFileSync(applied.response.receiptPath, 'utf8'));
  assert.equal(receipt.accepted.length, 20);
  const accepted = receipt.accepted.find(item => item.name === 'ops/start-codex-app-server-proxy.ps1').state;
  const originalReceiptSha256 = sha(applied.response.receiptPath);
  const target = path.join(example.installed, 'ops/start-codex-app-server-proxy.ps1');
  const mutate = code => {
    const run = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, env: environment });
    evidence.commands.push({ command: [shell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  mutate(`[IO.File]::SetAttributes(${quote(target)},[IO.FileAttributes](${accepted.attributes} -bor 2))`);
  const changed = sha(target);
  const attributeRefusal = invoke(example.record.recoveryEntry, { Action: 'Restore', ...example.binding });
  assert.equal(attributeRefusal.status, 1);
  assert.match(attributeRefusal.response.error, /WINDOW_RESTORE_EXTERNAL_STATE_PRESERVED/);
  assert.equal(sha(target), changed);
  assert.equal(sha(applied.response.receiptPath), originalReceiptSha256);
  assert.equal(mutate(`[int](Get-Item -LiteralPath ${quote(target)} -Force).Attributes`), String(accepted.attributes | 2));
  mutate(`[IO.File]::SetAttributes(${quote(target)},[IO.FileAttributes]${accepted.attributes}); $acl=Get-Acl -LiteralPath ${quote(target)}; $acl.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath ${quote(target)} -AclObject $acl`);
  const externalSddl = mutate(`(Get-Acl -LiteralPath ${quote(target)}).Sddl`);
  assert.notEqual(externalSddl, accepted.sddl);
  const aclRefusal = invoke(example.record.recoveryEntry, { Action: 'Restore', ...example.binding });
  assert.equal(aclRefusal.status, 1);
  assert.match(aclRefusal.response.error, /WINDOW_RESTORE_EXTERNAL_STATE_PRESERVED/);
  assert.equal(mutate(`(Get-Acl -LiteralPath ${quote(target)}).Sddl`), externalSddl);
  assert.equal(sha(applied.response.receiptPath), originalReceiptSha256);
  example.record.externalMetadataPreserved = { attributes: attributeRefusal.response.error, sddl: aclRefusal.response.error, recoveryNeedsExternalOwnerDecision: true };
});

after(() => {
  evidence.finishedAt = new Date().toISOString();
  evidence.sourceSha256 = sha(entry);
  evidence.sourceUnchanged = sourceHash === sha(entry);
  evidence.testSha256 = sha(fileURLToPath(import.meta.url));
  if (output) {
    const result = write(output, 'result.json', evidence);
    process.stdout.write(`TRANSACTION_EVIDENCE ${JSON.stringify({ result, sha256: sha(result), sourceUnchanged: evidence.sourceUnchanged })}\n`);
  }
});
