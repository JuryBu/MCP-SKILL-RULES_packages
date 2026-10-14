import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(testPath), '..');
const entry = path.join(project, 'ops/codex-outer-adoption-window-transaction.ps1');
const prepare = path.join(project, 'ops/prepare-codex-outer-adoption.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const enabled = process.platform === 'win32';
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psexecutionpolicypreference'));
const sha = target => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const anonymize = value => String(value).replaceAll(/S-1-5-21-\d+-\d+-\d+-\d+/g, 'TEMP_OWNER');
const output = enabled ? fs.mkdtempSync(path.join(os.tmpdir(), 'outer-original-acl-')) : null;
const frozenSourceSha256 = sha(entry);
const evidence = { startedAt: new Date().toISOString(), sourcePath: entry, frozenSourceSha256, productionModified: false, serviceProcessesCreated: [], commands: [], checks: [] };
const nativeAcl = `
function Set-IsolatedSddl([string]$Target, [string]$Saved) {
  if (-not [IO.Path]::GetFullPath($Target).StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) { throw 'ISOLATED_TEMP_ONLY' }
  if (-not ('OuterAclProbe.Native' -as [type])) {
    $Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('OuterAclProbe.Native'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $Builder = $Assembly.DefineDynamicModule('Native').DefineType('OuterAclProbe.Native', [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
    $Setter = $Builder.DefinePInvokeMethod('SetRaw', 'advapi32.dll', 'SetFileSecurityW', [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([string], [uint32], [byte[]]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $Setter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    [void]$Builder.CreateType()
  }
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Saved)
  $Bytes = [byte[]]::new($Descriptor.BinaryLength)
  $Descriptor.GetBinaryForm($Bytes, 0)
  if (-not [OuterAclProbe.Native]::SetRaw($Target, [uint32]536870919, $Bytes)) { throw 'ISOLATED_ACL_SETUP_FAILED' }
  if ((Get-Acl -LiteralPath $Target).Sddl -cne $Saved) { throw 'ISOLATED_ACL_SETUP_MISMATCH' }
}
function Original-TempSddl {
  $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  return ('O:' + $Sid + 'G:' + $Sid + 'D:(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;' + $Sid + ')')
}
function Snapshot([string]$Target) {
  return [pscustomobject]@{ sha256 = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant(); sddl = (Get-Acl -LiteralPath $Target).Sddl; attributes = [int](Get-Item -LiteralPath $Target -Force).Attributes }
}
`;

function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  return target;
}

function run(args) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(shell, args, { encoding: 'utf8', windowsHide: true, timeout: 45000, env: environment });
  evidence.commands.push({ command: [shell, ...args], startedAt, exitCode: result.status, stdout: anonymize(result.stdout), stderr: anonymize(result.stderr), error: result.error?.message });
  assert.ok(!result.error, result.error?.message);
  assert.ok(result.stdout.trim(), `${result.stderr}\n${result.stdout}`);
  return { ...result, response: JSON.parse(result.stdout.trim()) };
}

function command(body) {
  return run(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${nativeAcl}\n${body}`]);
}

function invoke(script, values) {
  return run(['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...Object.entries(values).flatMap(([name, value]) => [`-${name}`, String(value)])]);
}

function snapshots(targets) {
  const result = command(`@(${targets.map(target => `Snapshot ${quote(target)}`).join(';')}) | ConvertTo-Json -Depth 5 -Compress`);
  assert.equal(result.status, 0, result.stderr);
  return result.response;
}

test('WinPS 5.1 native replacement reproduces original D to D:AI metadata failure without ACL restoration', { skip: !enabled }, () => {
  const base = fs.mkdtempSync(path.join(output, 'old-native-'));
  const target = write(base, 'original.mjs', 'old isolated bytes\n');
  const stage = write(base, 'stage.mjs', 'new isolated bytes\n');
  const originalSha256 = sha(target);
  const candidateSha256 = sha(stage);
  const result = command(`
    Set-IsolatedSddl ${quote(target)} (Original-TempSddl)
    $Before = Snapshot ${quote(target)}
    [IO.File]::Replace(${quote(stage)}, ${quote(target)}, [NullString]::Value)
    [IO.File]::SetAttributes(${quote(target)}, [IO.FileAttributes]$Before.attributes)
    $After = Snapshot ${quote(target)}
    $Failure = if ($After.sddl -cne $Before.sddl) { 'WINDOW_WRITE_VERIFICATION_FAILED' } else { $null }
    [pscustomobject]@{ powerShellVersion = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; before = $Before; after = $After; error = $Failure } | ConvertTo-Json -Depth 6 -Compress
    if ($Failure) { exit 1 }
  `);
  assert.equal(result.status, 1, JSON.stringify(result.response));
  assert.match(result.response.powerShellVersion, /^5\.1\./);
  assert.equal(result.response.edition, 'Desktop');
  assert.equal(result.response.error, 'WINDOW_WRITE_VERIFICATION_FAILED');
  assert.match(result.response.before.sddl, /D:\(A;ID;/);
  assert.match(result.response.after.sddl, /D:AI\(A;ID;/);
  assert.equal(result.response.before.sha256, originalSha256);
  assert.equal(result.response.after.sha256, candidateSha256);
  assert.equal(result.response.after.attributes, result.response.before.attributes);
  evidence.checks.push({ label: 'old-native-reproduction', base, originalSha256, candidateSha256, exitCode: result.status, response: JSON.parse(anonymize(JSON.stringify(result.response))) });
});

test('frozen real TempMapping entry preserves original ACL for changed and identical bytes through Apply and independent Restore', { skip: !enabled }, () => {
  assert.equal(sha(entry), frozenSourceSha256, 'source changed before fixture');
  const source = fs.readFileSync(entry, 'utf8');
  const namesBlock = source.match(/\$Names = @\(([\s\S]*?)\n\)/);
  assert.ok(namesBlock);
  const names = [...namesBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.equal(names.length, 19);
  const base = fs.mkdtempSync(path.join(output, 'real-entry-'));
  const sample = path.join(base, 'sample');
  const installed = path.join(sample, 'installed');
  const data = path.join(sample, 'data');
  const candidate = path.join(base, 'candidate-input');
  const prepared = path.join(base, 'prepared');
  const contractRoot = path.join(base, 'contract');
  const owner = 'outer-original-acl-isolated-test';
  const changedName = 'src/codex-runtime-bundle.mjs';
  const sameName = 'src/atomic-file.mjs';
  for (const name of names) {
    write(installed, name, `isolated original ${name}\n`);
    write(candidate, name, `isolated ${name === changedName ? 'candidate' : 'original'} ${name}\n`);
  }
  for (const root of [installed, candidate]) write(root, 'node_modules/ws/package.json', { name: 'ws', version: '0.0.0-isolated-fixture' });
  fs.mkdirSync(path.join(data, 'state/codex-outer-runtime-candidates'), { recursive: true });
  write(data, 'state/codex-outer-runtime-startup.json', { schemaVersion: 1, enabled: false });
  const protectedNames = ['codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json'];
  const protectedBefore = protectedNames.map(name => {
    const target = write(data, `state/${name}`, `isolated protected ${name}\n`);
    return [target, sha(target)];
  });
  const targets = [changedName, sameName].map(name => path.join(installed, name));
  const setup = command(`${targets.map(target => `Set-IsolatedSddl ${quote(target)} (Original-TempSddl)`).join(';')}; [pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; executionPolicy = (Get-ExecutionPolicy).ToString(); processPolicy = (Get-ExecutionPolicy -Scope Process).ToString() } | ConvertTo-Json -Compress`);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.response.version, /^5\.1\./);
  assert.equal(setup.response.executionPolicy, 'RemoteSigned');
  assert.equal(setup.response.processPolicy, 'Undefined');
  const before = snapshots(targets);
  for (const state of before) assert.match(state.sddl, /D:\(A;ID;/);
  const planning = invoke(prepare, { SourceRoot: candidate, InstalledRoot: installed, DataRoot: data, PreparationRoot: prepared, OwnerId: owner });
  assert.equal(planning.status, 0, JSON.stringify(planning.response));
  const preparationSha256 = sha(path.join(prepared, 'preparation.json'));
  write(sample, '.outer-adoption-isolated-owner.json', { schemaVersion: 1, mode: 'TEMP_ISOLATED_RECOVERY', ownerId: owner, sampleRoot: sample, preparationRoot: prepared, preparationSha256 });
  const ready = invoke(entry, { Action: 'Prepare', Mode: 'TempMapping', PreparationRoot: prepared, PreparationSha256: preparationSha256, OwnerId: owner, SampleRoot: sample, ContractRoot: contractRoot, PowerShellPath: shell, NodePath: process.execPath });
  assert.equal(ready.status, 0, JSON.stringify(ready.response));
  const recoveryEntry = ready.response.recoveryEntry;
  assert.equal(sha(recoveryEntry), frozenSourceSha256);
  const binding = { Mode: 'TempMapping', ContractRoot: contractRoot, ContractSha256: ready.response.contractSha256 };
  const apply = invoke(entry, { Action: 'Apply', ...binding });
  evidence.checks.push({ label: 'real-entry-apply', base, before: JSON.parse(anonymize(JSON.stringify(before))), sourceSha256: frozenSourceSha256, binding, exitCode: apply.status, response: apply.response });
  assert.equal(apply.status, 0, JSON.stringify(apply.response));
  assert.equal(apply.response.status, 'applied');
  assert.equal(apply.response.productionModified, false);
  assert.equal(apply.response.completed.length, 20);
  assert.ok(apply.response.written.includes(changedName));
  assert.ok(!apply.response.written.includes(sameName));
  const applied = snapshots(targets);
  for (const [index, state] of applied.entries()) {
    assert.equal(state.sha256, sha(path.join(candidate, [changedName, sameName][index])));
    assert.equal(state.sddl, before[index].sddl);
    assert.equal(state.attributes, before[index].attributes);
  }
  const restore = invoke(recoveryEntry, { Action: 'Restore', ...binding });
  evidence.checks.push({ label: 'independent-restore', base, sourceSha256: sha(recoveryEntry), exitCode: restore.status, response: restore.response });
  assert.equal(restore.status, 0, JSON.stringify(restore.response));
  assert.equal(restore.response.status, 'restored');
  assert.equal(restore.response.productionModified, false);
  assert.equal(restore.response.completed.length, 20);
  const restored = snapshots(targets);
  assert.deepEqual(restored, before);
  for (const [target, hash] of protectedBefore) assert.equal(sha(target), hash);
  assert.equal(sha(entry), frozenSourceSha256, 'source changed during real entry test');
  evidence.checks.push({ label: 'exact-metadata-and-bytes', changedName, sameName, before: JSON.parse(anonymize(JSON.stringify(before))), applied: JSON.parse(anonymize(JSON.stringify(applied))), restored: JSON.parse(anonymize(JSON.stringify(restored))), protectedStateUnchanged: true });
});

after(() => {
  evidence.finishedAt = new Date().toISOString();
  evidence.currentSourceSha256 = sha(entry);
  evidence.sourceUnchanged = evidence.currentSourceSha256 === frozenSourceSha256;
  evidence.testSha256 = sha(testPath);
  if (output) {
    const result = write(output, 'result.json', evidence);
    process.stdout.write(`ORIGINAL_ACL_EVIDENCE ${JSON.stringify({ result, sha256: sha(result), frozenSourceSha256, currentSourceSha256: evidence.currentSourceSha256, sourceUnchanged: evidence.sourceUnchanged })}\n`);
  }
});
