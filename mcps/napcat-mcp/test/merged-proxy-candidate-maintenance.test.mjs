import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const scriptPath = fileURLToPath(new URL('../ops/manage-merged-proxy-candidate.ps1', import.meta.url));
const windowsRoot = process.env.SystemRoot || 'C:/Windows';
const powershellPath = process.env.MERGED_PROXY_TEST_POWERSHELL_PATH || path.join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
assert.ok(path.isAbsolute(powershellPath), 'Explicit test runtime must be an absolute path');
const fixtureParent = path.join(fs.realpathSync.native(tmpdir()), 'outer-status-hidden-prep-20261009/recovery-fixtures');
const targetPaths = [
  'src/codex-app-server-proxy.mjs',
  'src/codex-thread-bridge.mjs',
  'src/wake-visibility.mjs',
  'ops/update-codex-napcat-bridge.ps1',
];
const dependencyPath = 'src/shared-runtime-dependency.mjs';
const profiles = ['development', 'training'];
const ownedRoots = new Set();
const childEnvironment = {
  ...process.env,
  PATH: [path.join(windowsRoot, 'System32'), path.dirname(powershellPath)].join(path.delimiter),
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function quotePs(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function traceFixtureProcess(executable, args, cwd, result) {
  if (process.env.MERGED_PROXY_TEST_TRACE === '1') {
    console.log(JSON.stringify({ executable, args, cwd, status: result.status, stdout: result.stdout, stderr: result.stderr }));
  }
}

function assertNoReparseAncestors(absolutePath) {
  let current = path.resolve(absolutePath);
  while (true) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function writeFixtureFile(absolutePath, bytes) {
  const root = [...ownedRoots].find((candidate) => absolutePath.startsWith(`${candidate}${path.sep}`));
  assert.ok(root, `Not an owned fixture file: ${absolutePath}`);
  assertNoReparseAncestors(path.dirname(absolutePath));
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
}

function makeFixture() {
  assertNoReparseAncestors(fixtureParent);
  fs.mkdirSync(fixtureParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureParent, `merged-candidate-fixture-${randomUUID()}-`));
  ownedRoots.add(root);
  const packageRoot = path.join(root, 'candidate package');
  const targetRoots = Object.fromEntries(profiles.map((profile) => [profile, path.join(root, `target-${profile}`)]));
  const backupRoots = Object.fromEntries(profiles.map((profile) => [profile, path.join(root, `backup-${profile}`)]));
  const manifestPath = path.join(packageRoot, 'manifest.json');
  const manifest = { schemaVersion: 3, state: 'PREPARED_NOT_APPLIED', sourceCommit: 'a'.repeat(40), profiles: {} };
  for (const profile of profiles) {
    const targets = targetPaths.map((member) => {
      const before = `synthetic baseline ${profile} ${member}\r\n`;
      const candidate = `synthetic candidate ${profile} ${member}\n`;
      writeFixtureFile(path.join(targetRoots[profile], member), before);
      writeFixtureFile(path.join(packageRoot, 'payload', profile, member), candidate);
      return { path: member, beforeSha256: digest(before), candidateSha256: digest(candidate) };
    });
    const dependency = `synthetic unchanged dependency ${profile}\n`;
    writeFixtureFile(path.join(targetRoots[profile], dependencyPath), dependency);
    writeFixtureFile(path.join(targetRoots[profile], 'not-a-target.txt'), 'leave this file unchanged\n');
    manifest.profiles[profile] = { targets, unchangedProductionDependencies: [{ path: dependencyPath, sha256: digest(dependency) }] };
  }
  writeFixtureFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, packageRoot, targetRoots, backupRoots, manifestPath, manifest };
}

function treeSnapshot(root) {
  const snapshot = {};
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const relative = path.relative(root, absolutePath).replaceAll(path.sep, '/');
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) snapshot[relative] = { link: fs.readlinkSync(absolutePath) };
      else if (stat.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        visit(absolutePath);
      } else snapshot[relative] = { sha256: digest(fs.readFileSync(absolutePath)), mtimeMs: stat.mtimeMs };
    }
  }
  visit(root);
  return snapshot;
}

function removeOwnedFixture(root) {
  assert.ok(ownedRoots.has(root));
  assert.equal(path.dirname(root), fixtureParent);
  assert.match(path.basename(root), /^merged-candidate-fixture-/);
  assertNoReparseAncestors(root);
  function removeEntry(absolutePath) {
    assert.ok(absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`));
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) fs.unlinkSync(absolutePath);
    else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath)) removeEntry(path.join(absolutePath, name));
      fs.rmdirSync(absolutePath);
    } else fs.unlinkSync(absolutePath);
  }
  removeEntry(root);
  ownedRoots.delete(root);
  assert.equal(fs.existsSync(root), false);
}

async function withFixture(callback) {
  const fixture = makeFixture();
  try {
    return await callback(fixture);
  } finally {
    removeOwnedFixture(fixture.root);
  }
}

function runPsCommand(command, cwd) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
  const result = spawnSync(powershellPath, args, {
    cwd, env: { ...childEnvironment, TEMP: cwd, TMP: cwd }, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  traceFixtureProcess(powershellPath, args, cwd, result);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runManager(fixture, options = {}) {
  if (process.env.MERGED_PROXY_TEST_SCRIPT_SHA256) {
    assert.equal(digest(fs.readFileSync(scriptPath)), process.env.MERGED_PROXY_TEST_SCRIPT_SHA256.toLowerCase(), 'Frozen maintenance script SHA256');
  }
  const profile = options.profile || 'development';
  const argumentsList = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
    '-ManifestPath', options.manifestPath || fixture.manifestPath,
    '-MachineProfile', profile,
    '-TargetRoot', options.targetRoot || fixture.targetRoots[profile],
    '-BackupRoot', options.backupRoot || fixture.backupRoots[profile]];
  if (options.mode) argumentsList.push('-Mode', options.mode);
  if (options.acknowledged) argumentsList.push('-AcknowledgedOfflineWindow');
  if (options.isolated !== false) argumentsList.push('-IsolatedFixture');
  const result = spawnSync(powershellPath, argumentsList, {
    cwd: fixture.root, env: { ...childEnvironment, TEMP: fixture.root, TMP: fixture.root }, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  traceFixtureProcess(powershellPath, argumentsList, fixture.root, result);
  assert.ifError(result.error);
  let report;
  try { report = JSON.parse(result.stdout.trim()); }
  catch { assert.fail(`No JSON report, exit=${result.status}\n${result.stdout}\n${result.stderr}`); }
  return { ...result, report };
}

function expectSuccess(result, status) {
  assert.equal(result.status, 0, JSON.stringify(result.report));
  assert.equal(result.report.status, status);
  assert.deepEqual(result.report.cleanupErrors, []);
  return result.report;
}

function expectRefusal(fixture, options, code) {
  const before = treeSnapshot(fixture.root);
  const result = runManager(fixture, options);
  assert.equal(result.status, 1, JSON.stringify(result.report));
  assert.equal(result.report.status, 'REFUSED');
  assert.match(result.report.error, code);
  assert.deepEqual(treeSnapshot(fixture.root), before);
  return result.report;
}

function aclSnapshot(fixture, profile) {
  const pathsExpression = targetPaths.map((member) => quotePs(path.join(fixture.targetRoots[profile], member))).join(',');
  return JSON.parse(runPsCommand(`
    $ErrorActionPreference='Stop'
    $assemblyName=[Reflection.AssemblyName]::new('FixtureAclRead')
    $assembly=if($PSVersionTable.PSEdition -eq 'Core'){[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)}else{[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)}
    $module=$assembly.DefineDynamicModule('FixtureAclRead')
    $builder=$module.DefineType('FixtureAclRead',[Reflection.TypeAttributes]::Public)
    $method=$builder.DefinePInvokeMethod('Read','advapi32.dll','GetFileSecurityW',[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl,[Reflection.CallingConventions]::Standard,[bool],[type[]]@([string],[uint32],[byte[]],[uint32],([uint32]).MakeByRefType()),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    [void]$builder.CreateType()
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    $values=@(foreach($file in @(${pathsExpression})){
      [uint32]$needed=0
      [void][FixtureAclRead]::Read($file,7,$null,0,[ref]$needed)
      if($needed -eq 0){throw 'Fixture ACL size read failed'}
      $bytes=[byte[]]::new($needed)
      if(-not [FixtureAclRead]::Read($file,7,$bytes,$needed,[ref]$needed)){throw 'Fixture ACL read failed'}
      ([Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)).GetSddlForm($sections)
    })
    ConvertTo-Json -InputObject $values -Compress
  `, fixture.root));
}

function protectTargetAcls(fixture, profile) {
  const pathsExpression = targetPaths.map((member) => quotePs(path.join(fixture.targetRoots[profile], member))).join(',');
  runPsCommand(`$ErrorActionPreference='Stop'; foreach($file in @(${pathsExpression})){$security=Get-Acl -LiteralPath $file; $security.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath $file -AclObject $security}`, fixture.root);
}

const noAiLayouts = [
  { protected: false, noncanonical: false, inherited: false },
  { protected: true, noncanonical: true, inherited: false },
  { protected: false, noncanonical: true, inherited: true },
  { protected: true, noncanonical: true, inherited: true },
];

function nativeFixtureAclPrelude() {
  return `
    $ErrorActionPreference='Stop'
    $assemblyName=[Reflection.AssemblyName]::new('IndependentFixtureAcl')
    $assembly=if($PSVersionTable.PSEdition -eq 'Core'){[Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)}else{[AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)}
    $module=$assembly.DefineDynamicModule('IndependentFixtureAcl')
    $builder=$module.DefineType('IndependentFixtureAcl',[Reflection.TypeAttributes]::Public)
    $attributes=[Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
    $reader=$builder.DefinePInvokeMethod('Read','advapi32.dll','GetFileSecurityW',$attributes,[Reflection.CallingConventions]::Standard,[bool],[type[]]@([string],[uint32],[byte[]],[uint32],([uint32]).MakeByRefType()),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $writer=$builder.DefinePInvokeMethod('Write','advapi32.dll','SetFileSecurityW',$attributes,[Reflection.CallingConventions]::Standard,[bool],[type[]]@([string],[uint32],[byte[]]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $reader.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    $writer.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    [void]$builder.CreateType()
    $sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
    function Read-FixtureDescriptor([string]$file) {
      [uint32]$needed=0
      [void][IndependentFixtureAcl]::Read($file,7,$null,0,[ref]$needed)
      if($needed -eq 0){throw 'Independent fixture ACL size read failed'}
      $bytes=[byte[]]::new($needed)
      if(-not [IndependentFixtureAcl]::Read($file,7,$bytes,$needed,[ref]$needed)){throw 'Independent fixture ACL read failed'}
      return [Security.AccessControl.RawSecurityDescriptor]::new($bytes,0)
    }
    function Get-FixtureAclState($descriptor,[string]$file) {
      $aces=@(foreach($ace in $descriptor.DiscretionaryAcl){
        [ordered]@{type=$ace.AceType.ToString();flags=[int]$ace.AceFlags;mask=$ace.AccessMask;sid=$ace.SecurityIdentifier.Value}
      })
      $daclBytes=[byte[]]::new($descriptor.DiscretionaryAcl.BinaryLength)
      $descriptor.DiscretionaryAcl.GetBinaryForm($daclBytes,0)
      return [ordered]@{sddl=$descriptor.GetSddlForm($sections);controlFlags=[int]$descriptor.ControlFlags;owner=$descriptor.Owner.Value;group=$descriptor.Group.Value;dacl=[Convert]::ToBase64String($daclBytes);aces=$aces;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    function Write-FixtureDescriptor([string]$file,$descriptor) {
      $bytes=[byte[]]::new($descriptor.BinaryLength)
      $descriptor.GetBinaryForm($bytes,0)
      [uint32]$information=7
      if(($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0){$information=$information -bor [uint32]2147483648}
      else{$information=$information -bor [uint32]536870912}
      if(-not [IndependentFixtureAcl]::Write($file,$information,$bytes)){throw 'Independent fixture ACL write failed'}
      $actual=Read-FixtureDescriptor $file
      if($actual.GetSddlForm($sections) -cne $descriptor.GetSddlForm($sections) -or $actual.ControlFlags -ne $descriptor.ControlFlags){throw 'Independent fixture ACL readback differs from requested descriptor'}
      return $actual
    }
  `;
}

function nativeFixturePaths(fixture, root) {
  assert.ok(root.startsWith(`${fixture.root}${path.sep}`));
  assertNoReparseAncestors(root);
  return targetPaths.map((member) => quotePs(path.join(root, member))).join(',');
}

function seedNoAiTargetAcls(fixture, profile, mixedOuter = false) {
  const seeded = JSON.parse(runPsCommand(`${nativeFixtureAclPrelude()}
    $files=@(${nativeFixturePaths(fixture, fixture.targetRoots[profile])})
    $layouts=${quotePs(JSON.stringify(noAiLayouts))} | ConvertFrom-Json
    $mixedOuter=$${mixedOuter ? 'true' : 'false'}
    $currentUser=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $syntheticSid=[Security.Principal.SecurityIdentifier]::new('S-1-5-21-111111111-222222222-333333333-4242').Value
    $worldSid=[Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::WorldSid,$null).Value
    $values=@(for($index=0;$index -lt $files.Count;$index++){
      $file=$files[$index]
      $original=Read-FixtureDescriptor $file
      $layout=$layouts[$index]
      $flags=if($layout.protected){'P'}else{''}
      $dacl='(A;;FA;;;'+$currentUser+')'
      if($layout.noncanonical){$dacl+='(A;;0x12019f;;;'+$syntheticSid+')(D;;0x2;;;'+$syntheticSid+')'}
      if($layout.inherited){$dacl+='(A;ID;0x120089;;;'+$worldSid+')'}
      if($mixedOuter -and $index -eq 0){$expected=$original;$actual=$original}
      else{
        $expected=[Security.AccessControl.RawSecurityDescriptor]::new('O:'+$original.Owner.Value+'G:'+$original.Group.Value+'D:'+$flags+$dacl)
        $actual=Write-FixtureDescriptor $file $expected
      }
      $expectedBackup=[Security.AccessControl.RawSecurityDescriptor]::new($expected.GetSddlForm($sections))
      $expectedBackup.SetFlags($expectedBackup.ControlFlags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
      foreach($ace in $expectedBackup.DiscretionaryAcl){$ace.AceFlags=[Security.AccessControl.AceFlags]([int]$ace.AceFlags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited))}
      [ordered]@{expected=(Get-FixtureAclState $expected $file);actual=(Get-FixtureAclState $actual $file);backup=(Get-FixtureAclState $expectedBackup $file)}
    })
    ConvertTo-Json -InputObject $values -Depth 8 -Compress
  `, fixture.root));
  for (const [index, entry] of seeded.entries()) {
    const layout = noAiLayouts[index];
    assert.deepEqual(entry.actual, entry.expected, `Initial native descriptor ${targetPaths[index]}`);
    if (mixedOuter && index === 0) {
      assert.equal(entry.actual.controlFlags & 0x0400, 0x0400, 'Mixed outer retains its valid inherited AI descriptor');
      assert.equal(entry.actual.controlFlags & 0x1000, 0);
      assert.ok(entry.actual.aces.some((ace) => (ace.flags & 0x10) !== 0));
      assert.equal(entry.actual.sha256, fixture.manifest.profiles[profile].targets[index].beforeSha256);
      continue;
    }
    assert.equal(entry.actual.controlFlags, 0x8004 | (layout.protected ? 0x1000 : 0));
    assert.equal(entry.actual.controlFlags & 0x0400, 0, 'Initial descriptor must have no AI');
    assert.equal(entry.actual.aces.length, 1 + (layout.noncanonical ? 2 : 0) + (layout.inherited ? 1 : 0));
    assert.equal(entry.actual.aces[0].type, 'AccessAllowed');
    assert.equal(entry.actual.aces[0].flags, 0);
    if (layout.noncanonical) {
      assert.equal(entry.actual.aces[1].type, 'AccessAllowed');
      assert.equal(entry.actual.aces[2].type, 'AccessDenied');
      assert.equal(entry.actual.aces[1].sid, entry.actual.aces[2].sid);
      assert.equal(entry.actual.aces[1].mask & entry.actual.aces[2].mask, entry.actual.aces[2].mask);
    }
    assert.deepEqual(entry.actual.aces.map((ace) => ace.flags), entry.actual.aces.map((_, aceIndex) => layout.inherited && aceIndex === entry.actual.aces.length - 1 ? 0x10 : 0));
    assert.equal(entry.actual.sha256, fixture.manifest.profiles[profile].targets[index].beforeSha256);
  }
  return seeded;
}

function nativeAclStates(fixture, root) {
  return JSON.parse(runPsCommand(`${nativeFixtureAclPrelude()}
    $values=@(foreach($file in @(${nativeFixturePaths(fixture, root)})){Get-FixtureAclState (Read-FixtureDescriptor $file) $file})
    ConvertTo-Json -InputObject $values -Depth 8 -Compress
  `, fixture.root));
}

function rewriteFixtureSddl(fixture, file, sddl) {
  assert.ok(file.startsWith(`${fixture.root}${path.sep}`));
  assertNoReparseAncestors(file);
  runPsCommand(`${nativeFixtureAclPrelude()}
    $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new(${quotePs(sddl)})
    [void](Write-FixtureDescriptor ${quotePs(file)} $descriptor)
  `, fixture.root);
}

function assertNativePhase(context, fixture, profile, seeded, hashField, phase) {
  assertTargets(fixture, profile, hashField);
  const targetStates = nativeAclStates(fixture, fixture.targetRoots[profile]);
  assert.deepEqual(targetStates, seeded.map((entry, index) => ({ ...entry.actual, sha256: fixture.manifest.profiles[profile].targets[index][hashField] })));
  const backupStates = nativeAclStates(fixture, path.join(fixture.backupRoots[profile], 'original'));
  assert.deepEqual(backupStates, seeded.map((entry) => entry.backup));
  context.diagnostic(JSON.stringify({ profile, phase, targets: targetStates, backups: backupStates }));
  assertNoMaintenanceResidue(fixture);
}

function expectNativeRefusal(fixture, profile, options, code) {
  const targetsBefore = nativeAclStates(fixture, fixture.targetRoots[profile]);
  const backupsBefore = nativeAclStates(fixture, path.join(fixture.backupRoots[profile], 'original'));
  const report = expectRefusal(fixture, { ...options, profile }, code);
  assert.deepEqual(nativeAclStates(fixture, fixture.targetRoots[profile]), targetsBefore);
  assert.deepEqual(nativeAclStates(fixture, path.join(fixture.backupRoots[profile], 'original')), backupsBefore);
  return report;
}

function assertTargets(fixture, profile, hashField) {
  for (const target of fixture.manifest.profiles[profile].targets) {
    assert.equal(digest(fs.readFileSync(path.join(fixture.targetRoots[profile], target.path))), target[hashField], target.path);
  }
  const dependency = fixture.manifest.profiles[profile].unchangedProductionDependencies[0];
  assert.equal(digest(fs.readFileSync(path.join(fixture.targetRoots[profile], dependency.path))), dependency.sha256);
  assert.equal(fs.readFileSync(path.join(fixture.targetRoots[profile], 'not-a-target.txt'), 'utf8'), 'leave this file unchanged\n');
}

function receiptEvents(report) {
  assert.ok(report.receiptPath);
  return fs.readFileSync(report.receiptPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

function assertNoMaintenanceResidue(fixture) {
  for (const relative of Object.keys(treeSnapshot(fixture.root))) {
    assert.doesNotMatch(relative, /(?:^|\/)\.merged-|(?:^|\/)maintenance\.lock$/);
  }
}

async function startHelper(fixture, command) {
  const child = spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: fixture.root, env: { ...childEnvironment, TEMP: fixture.root, TMP: fixture.root }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.stdin.end(); reject(new Error(`Helper readiness timeout: ${errors}`)); }, 15000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('FIXTURE_READY')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!output.includes('FIXTURE_READY')) reject(new Error(`Helper exited ${code}: ${errors}`));
    });
  });
  return async () => {
    child.stdin.end('\n');
    const status = await exited;
    traceFixtureProcess(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], fixture.root, { status, stdout: output, stderr: errors });
    assert.equal(status, 0, errors);
  };
}

test('native no-AI fixtures retain their requested control bits and ACE order before maintenance', { skip: !windows }, async (context) => withFixture(async (fixture) => {
  for (const profile of profiles) {
    const seeded = seedNoAiTargetAcls(fixture, profile);
    assert.deepEqual(nativeAclStates(fixture, fixture.targetRoots[profile]), seeded.map((entry) => entry.actual));
    context.diagnostic(JSON.stringify({ profile, initialNativeDescriptors: seeded }));
  }
  await withFixture(async (mixedFixture) => {
    const seeded = seedNoAiTargetAcls(mixedFixture, 'development', true);
    assert.deepEqual(nativeAclStates(mixedFixture, mixedFixture.targetRoots.development), seeded.map((entry) => entry.actual));
    context.diagnostic(JSON.stringify({ profile: 'development', mixedAiAndNoAiInitialDescriptors: seeded }));
  });
}));

test('selected runtime rejects noninteger and incorrect manifest and recovery schemas', { skip: !windows }, async () => withFixture(async (fixture) => {
  const manifestText = JSON.stringify(fixture.manifest);
  for (const invalidVersion of ['"3"', '3.0', '3.5', '4', 'true', 'null']) {
    writeFixtureFile(fixture.manifestPath, manifestText.replace('"schemaVersion":3', `"schemaVersion":${invalidVersion}`));
    expectRefusal(fixture, {}, /UNKNOWN_SCHEMA: manifest/);
  }
  writeFixtureFile(fixture.manifestPath, manifestText);
  expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
  const recoveryPath = path.join(fixture.backupRoots.development, 'recovery-manifest.json');
  const recoveryText = JSON.stringify(JSON.parse(fs.readFileSync(recoveryPath, 'utf8')));
  for (const invalidVersion of ['"1"', '1.0', '1.5', '2', 'true', 'null']) {
    const invalidRecovery = recoveryText.replace('"schemaVersion":1', `"schemaVersion":${invalidVersion}`);
    writeFixtureFile(recoveryPath, invalidRecovery);
    writeFixtureFile(path.join(fixture.backupRoots.development, 'recovery-manifest.sha256'), digest(invalidRecovery));
    expectRefusal(fixture, {}, /UNKNOWN_SCHEMA: recovery/);
  }
}));

test('selected runtime native ACL roundtrip on both profiles', { skip: !windows, timeout: 180000 }, async (context) => {
  for (const profile of profiles) await withFixture(async (fixture) => {
    const seeded = seedNoAiTargetAcls(fixture, profile);
    expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
    assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'prepared');
    expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'APPLIED');
    assertNativePhase(context, fixture, profile, seeded, 'candidateSha256', 'applied');
    expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
    assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'restored');
  });
});

test('merged candidate maintenance: standalone selected PowerShell fixture acceptance', { skip: !windows, timeout: 600000 }, async (context) => {
  const frozenScriptSha256 = digest(fs.readFileSync(scriptPath));
  context.diagnostic(`Maintenance script SHA256 ${frozenScriptSha256}`);
  await context.test('environment has the selected supported PowerShell and no Node on the child PATH', async () => withFixture(async (fixture) => {
    const environment = JSON.parse(runPsCommand("$info=[ordered]@{powershell=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;nodeAvailable=($null -ne (Get-Command node -ErrorAction SilentlyContinue))}; $info | ConvertTo-Json -Compress", fixture.root));
    assert.match(environment.powershell, process.env.MERGED_PROXY_TEST_POWERSHELL_PATH ? /^7\./ : /^5\.1\./);
    assert.equal(environment.edition, process.env.MERGED_PROXY_TEST_POWERSHELL_PATH ? 'Core' : 'Desktop');
    assert.equal(environment.nodeAvailable, false);
    context.diagnostic(`Node ${process.version}; Windows PowerShell ${environment.powershell}; child Node PATH absent`);
  }));

  await context.test('default Inspect creates no files and changes no targets, backups or ACLs', async () => withFixture(async (fixture) => {
    const before = treeSnapshot(fixture.root);
    const acls = aclSnapshot(fixture, 'development');
    const report = expectSuccess(runManager(fixture), 'INSPECTED');
    assert.equal(report.backupPrepared, false);
    assert.equal(report.receiptPath, null);
    assert.deepEqual(treeSnapshot(fixture.root), before);
    assert.deepEqual(aclSnapshot(fixture, 'development'), acls);
    assert.equal(fs.existsSync(fixture.backupRoots.development), false);
  }));

  for (const profile of profiles) {
    await context.test(`${profile}: Prepare is immutable; four-file Apply/Restore retains protected ACLs`, async () => withFixture(async (fixture) => {
      protectTargetAcls(fixture, profile);
      const acls = aclSnapshot(fixture, profile);
      for (const member of targetPaths) {
        const development = fixture.manifest.profiles.development.targets.find((entry) => entry.path === member);
        const training = fixture.manifest.profiles.training.targets.find((entry) => entry.path === member);
        assert.notEqual(development.candidateSha256, training.candidateSha256);
      }
      const productionBefore = treeSnapshot(fixture.targetRoots[profile]);
      const prepared = expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
      assert.deepEqual(treeSnapshot(fixture.targetRoots[profile]), productionBefore);
      const recoveryPath = path.join(fixture.backupRoots[profile], 'recovery-manifest.json');
      const recovery = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
      assert.equal(recovery.schemaVersion, 1);
      assert.equal(recovery.machineProfile, profile);
      assert.deepEqual(recovery.targets.map((entry) => entry.path), targetPaths);
      assert.deepEqual(recovery.targets.map((entry) => entry.aclSddl), acls);
      const backupBefore = treeSnapshot(path.join(fixture.backupRoots[profile], 'original'));
      const recoveryBefore = fs.readFileSync(recoveryPath, 'utf8');
      expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'ALREADY_PREPARED');
      assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
      assert.equal(fs.readFileSync(recoveryPath, 'utf8'), recoveryBefore);
      assert.equal(receiptEvents(prepared).at(-1).data.status, 'PREPARED');
      const applied = expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'APPLIED');
      assertTargets(fixture, profile, 'candidateSha256');
      assert.deepEqual(aclSnapshot(fixture, profile), acls);
      assert.deepEqual(receiptEvents(applied).filter((event) => event.event === 'replaceCompleted').map((event) => event.data.path), targetPaths);
      const appliedBefore = treeSnapshot(fixture.targetRoots[profile]);
      expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'ALREADY_APPLIED');
      assert.deepEqual(treeSnapshot(fixture.targetRoots[profile]), appliedBefore);
      expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
      assertTargets(fixture, profile, 'beforeSha256');
      assert.deepEqual(aclSnapshot(fixture, profile), acls);
      assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
      assertNoMaintenanceResidue(fixture);
    }));
  }

  await context.test('Apply and Restore both require a separately acknowledged offline window', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    for (const mode of ['Apply', 'Restore']) expectRefusal(fixture, { mode }, /OFFLINE_WINDOW_REQUIRED/);
  }));

  await context.test('a wrong machine profile cannot reuse another baseline or backup', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    expectRefusal(fixture, { mode: 'Apply', profile: 'training', targetRoot: fixture.targetRoots.development, backupRoot: fixture.backupRoots.development, acknowledged: true }, /DEPENDENCY_DRIFT|TARGET_DRIFT|BACKUP_PROFILE_MISMATCH/);
    expectRefusal(fixture, { mode: 'Restore', profile: 'training', backupRoot: fixture.backupRoots.development, acknowledged: true }, /BACKUP_PROFILE_MISMATCH/);
  }));

  await context.test('fixture switch rejects outside-Temp, unnamed, mismatched and non-canonical roots', async () => withFixture(async (fixture) => {
    const outside = path.join(path.parse(tmpdir()).root, `merged-candidate-fixture-${randomUUID()}`, 'target');
    expectRefusal(fixture, { targetRoot: outside }, /FIXTURE_OUTSIDE_SYSTEM_TEMP/);
    expectRefusal(fixture, { targetRoot: fixtureParent }, /FIXTURE_ANCHOR_REQUIRED/);
    expectRefusal(fixture, { targetRoot: `${fixture.targetRoots.development}${path.sep}..${path.sep}target-training` }, /NON_CANONICAL_PATH/);
    expectRefusal(fixture, { backupRoot: path.join(fixture.targetRoots.development, 'backup') }, /OVERLAPPING_ROOTS/);
    await withFixture(async (other) => {
      expectRefusal(fixture, { backupRoot: other.backupRoots.development }, /FIXTURE_ROOT_MISMATCH/);
      assert.equal(fs.existsSync(other.backupRoots.development), false);
    });
  }));

  const invalidManifests = [
    ['unknown schema', (manifest) => { manifest.schemaVersion = 4; }, /UNKNOWN_SCHEMA/],
    ['unknown state', (manifest) => { manifest.state = 'APPLIED'; }, /UNKNOWN_STATE/],
    ['invalid commit', (manifest) => { manifest.sourceCommit = 'not-a-commit'; }, /INVALID_SOURCE_COMMIT/],
    ['missing profile', (manifest) => { delete manifest.profiles.training; }, /INVALID_KEYS/],
    ['missing target', (manifest) => { manifest.profiles.development.targets.pop(); }, /TARGET_SET_MISMATCH/],
    ['extra target', (manifest) => { manifest.profiles.development.targets.push({ ...manifest.profiles.development.targets[0], path: 'src/not-allowed.mjs' }); }, /TARGET_SET_MISMATCH/],
    ['duplicate target', (manifest) => { manifest.profiles.training.targets[1] = { ...manifest.profiles.training.targets[0] }; }, /TARGET_SET_MISMATCH/],
    ['absolute member', (manifest) => { manifest.profiles.training.targets[0].path = 'C:/outside.mjs'; }, /INVALID_MEMBER_PATH/],
    ['traversal member', (manifest) => { manifest.profiles.development.targets[0].path = '../outside.mjs'; }, /INVALID_MEMBER_PATH/],
    ['dependency traversal', (manifest) => { manifest.profiles.training.unchangedProductionDependencies[0].path = 'src/../../outside.mjs'; }, /INVALID_MEMBER_PATH/],
    ['dependency alias', (manifest) => { manifest.profiles.development.unchangedProductionDependencies[0].path = 'src\\dependency.mjs'; }, /INVALID_MEMBER_PATH/],
    ['empty dependencies', (manifest) => { manifest.profiles.development.unchangedProductionDependencies = []; }, /DEPENDENCIES_REQUIRED/],
    ['dependency overlaps target', (manifest) => { manifest.profiles.training.unchangedProductionDependencies[0].path = targetPaths[0]; }, /DUPLICATE_OR_TARGET_DEPENDENCY/],
    ['wrong profile payload hash', (manifest) => { manifest.profiles.training.targets[0].candidateSha256 = manifest.profiles.development.targets[0].candidateSha256; }, /CANDIDATE_DRIFT/],
    ['malformed SHA', (manifest) => { manifest.profiles.development.targets[0].beforeSha256 = 'bad'; }, /INVALID_SHA256/],
  ];
  await context.test('schema and whitelist validation reject every malformed manifest without writes', async (cases) => withFixture(async (fixture) => {
    for (const [name, mutate, code] of invalidManifests) {
      await cases.test(name, () => {
        const manifest = structuredClone(fixture.manifest);
        mutate(manifest);
        writeFixtureFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
        expectRefusal(fixture, {}, code);
      });
    }
  }));

  const reparseCases = [
    ['target root', (fixture) => fixture.targetRoots.development, 'Prepare'],
    ['target ancestor', (fixture) => path.join(fixture.targetRoots.development, 'src'), 'Prepare'],
    ['payload ancestor', (fixture) => path.join(fixture.packageRoot, 'payload/development/src'), 'Prepare'],
    ['manifest root', (fixture) => fixture.packageRoot, 'Prepare'],
    ['backup root', (fixture) => fixture.backupRoots.development, 'Apply'],
    ['backup ancestor', (fixture) => path.join(fixture.backupRoots.development, 'original/src'), 'Apply'],
  ];
  for (const [name, location, mode] of reparseCases) {
    await context.test(`reparse rejection: ${name}`, async () => withFixture(async (fixture) => {
      if (mode === 'Apply') expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
      const junction = location(fixture);
      const stashed = `${junction}-original`;
      assert.ok(junction.startsWith(`${fixture.root}${path.sep}`));
      fs.renameSync(junction, stashed);
      fs.symlinkSync(stashed, junction, 'junction');
      expectRefusal(fixture, { mode, acknowledged: true }, /REPARSE_PATH/);
      fs.unlinkSync(junction);
      fs.renameSync(stashed, junction);
    }));
  }

  const driftCases = [
    ['candidate', (fixture) => path.join(fixture.packageRoot, 'payload/development', targetPaths[2]), /CANDIDATE_DRIFT/],
    ['other profile candidate', (fixture) => path.join(fixture.packageRoot, 'payload/training', targetPaths[2]), /CANDIDATE_DRIFT/],
    ['dependency', (fixture) => path.join(fixture.targetRoots.development, dependencyPath), /DEPENDENCY_DRIFT/],
    ['backup', (fixture) => path.join(fixture.backupRoots.development, 'original', targetPaths[2]), /BACKUP_DRIFT/],
    ['target', (fixture) => path.join(fixture.targetRoots.development, targetPaths[2]), /TARGET_DRIFT/],
    ['recovery manifest', (fixture) => path.join(fixture.backupRoots.development, 'recovery-manifest.json'), /RECOVERY_MANIFEST_DRIFT/],
  ];
  for (const [name, location, code] of driftCases) {
    await context.test(`${name} SHA drift is rejected before any target write`, async () => withFixture(async (fixture) => {
      expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
      fs.appendFileSync(location(fixture), '\nfixture corruption\n');
      for (const mode of ['Inspect', 'Prepare', 'Apply']) expectRefusal(fixture, { mode, acknowledged: true }, code);
      if (['candidate', 'other profile candidate', 'dependency'].includes(name)) {
        expectSuccess(runManager(fixture, { mode: 'Restore', acknowledged: true }), 'RESTORED');
        assertNoMaintenanceResidue(fixture);
      } else {
        expectRefusal(fixture, { mode: 'Restore', acknowledged: true }, code);
      }
    }));
  }

  const independentRecoveryCases = [
    ['other-profile candidate corruption', 'development', (fixture) => {
      fs.appendFileSync(path.join(fixture.packageRoot, 'payload/training', targetPaths[0]), 'corrupted unrelated candidate');
    }, /CANDIDATE_DRIFT/, null],
    ['same-profile candidate corruption', 'training', (fixture) => {
      fs.appendFileSync(path.join(fixture.packageRoot, 'payload/training', targetPaths[0]), 'corrupted selected candidate');
    }, /CANDIDATE_DRIFT/, null],
    ['all candidate bodies missing', 'development', (fixture) => {
      for (const profile of profiles) {
        for (const member of targetPaths) fs.unlinkSync(path.join(fixture.packageRoot, 'payload', profile, member));
      }
    }, /payload/, null],
    ['unchanged dependency SHA drift', 'development', (fixture) => {
      fs.appendFileSync(path.join(fixture.targetRoots.development, dependencyPath), 'corrupted unchanged dependency');
    }, /DEPENDENCY_DRIFT/, 'DEPENDENCY_DRIFT'],
    ['unchanged dependency missing', 'training', (fixture) => {
      fs.unlinkSync(path.join(fixture.targetRoots.training, dependencyPath));
    }, /shared-runtime-dependency/, 'DEPENDENCY_MISSING'],
  ];
  for (const [name, profile, damage, refusalCode, warningCode] of independentRecoveryCases) {
    await context.test(`Prepare -> Apply -> ${name}: Restore uses healthy originals and leaves dependencies untouched`, async () => withFixture(async (fixture) => {
      protectTargetAcls(fixture, profile);
      const acls = aclSnapshot(fixture, profile);
      expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
      const backupBefore = treeSnapshot(path.join(fixture.backupRoots[profile], 'original'));
      expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'APPLIED');
      assertTargets(fixture, profile, 'candidateSha256');
      damage(fixture);
      for (const mode of ['Inspect', 'Prepare', 'Apply']) expectRefusal(fixture, { mode, profile, acknowledged: true }, refusalCode);
      const packageBefore = treeSnapshot(fixture.packageRoot);
      const untouchedBefore = treeSnapshot(fixture.targetRoots[profile]);
      for (const member of targetPaths) delete untouchedBefore[member];
      const restored = expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
      for (const target of fixture.manifest.profiles[profile].targets) {
        assert.equal(digest(fs.readFileSync(path.join(fixture.targetRoots[profile], target.path))), target.beforeSha256, target.path);
      }
      assert.equal(restored.fourFileResult, 'RESTORED_SHA256_AND_ACL_VERIFIED');
      assert.equal(restored.chainValidation, 'PENDING');
      assert.deepEqual(aclSnapshot(fixture, profile), acls);
      assert.deepEqual(treeSnapshot(fixture.packageRoot), packageBefore);
      assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
      const untouchedAfter = treeSnapshot(fixture.targetRoots[profile]);
      for (const member of targetPaths) delete untouchedAfter[member];
      assert.deepEqual(untouchedAfter, untouchedBefore);
      assert.deepEqual(restored.dependencyWarnings.map((warning) => warning.code), warningCode ? [warningCode] : []);
      if (warningCode) {
        const warning = restored.dependencyWarnings[0];
        assert.equal(warning.path, dependencyPath);
        assert.equal(warning.expectedSha256, fixture.manifest.profiles[profile].unchangedProductionDependencies[0].sha256);
        assert.match(warning.message, /left untouched/);
        if (warningCode === 'DEPENDENCY_MISSING') assert.equal(warning.actualSha256, null);
        else assert.equal(warning.actualSha256, digest(fs.readFileSync(path.join(fixture.targetRoots[profile], dependencyPath))));
        assert.deepEqual(receiptEvents(restored).find((event) => event.event === 'restoreDependencyWarnings').data, restored.dependencyWarnings);
      }
      assert.deepEqual(receiptEvents(restored).at(-1).data.dependencyWarnings, restored.dependencyWarnings);
      assert.equal(receiptEvents(restored).at(-1).data.chainValidation, 'PENDING');
      assertNoMaintenanceResidue(fixture);
    }));
  }

  await context.test('source manifest and target ACL drift are pinned to the first Prepare', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    const originalManifest = fs.readFileSync(fixture.manifestPath, 'utf8');
    const changed = structuredClone(fixture.manifest);
    changed.sourceCommit = 'b'.repeat(40);
    writeFixtureFile(fixture.manifestPath, JSON.stringify(changed));
    expectRefusal(fixture, { mode: 'Apply', acknowledged: true }, /SOURCE_MANIFEST_DRIFT/);
    expectRefusal(fixture, { mode: 'Restore', acknowledged: true }, /SOURCE_MANIFEST_DRIFT/);
    writeFixtureFile(fixture.manifestPath, originalManifest);
    protectTargetAcls(fixture, 'development');
    expectRefusal(fixture, { mode: 'Restore', acknowledged: true }, /TARGET_ACL_DRIFT/);
  }));

  await context.test('Restore repairs known partial application; Apply and Prepare preserve its healthy backup', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    const acls = aclSnapshot(fixture, 'development');
    const backupBefore = treeSnapshot(path.join(fixture.backupRoots.development, 'original'));
    for (const member of targetPaths.slice(0, 2)) {
      writeFixtureFile(path.join(fixture.targetRoots.development, member), fs.readFileSync(path.join(fixture.packageRoot, 'payload/development', member)));
    }
    writeFixtureFile(path.join(fixture.backupRoots.development, 'maintenance.lock'), 'synthetic abandoned lock\n');
    expectRefusal(fixture, { mode: 'Prepare' }, /BASELINE_REQUIRED/);
    expectRefusal(fixture, { mode: 'Apply', acknowledged: true }, /PARTIAL_APPLICATION_REQUIRES_RESTORE/);
    expectSuccess(runManager(fixture, { mode: 'Restore', acknowledged: true }), 'RESTORED');
    assertTargets(fixture, 'development', 'beforeSha256');
    assert.deepEqual(aclSnapshot(fixture, 'development'), acls);
    assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots.development, 'original')), backupBefore);
    assertNoMaintenanceResidue(fixture);
  }));

  await context.test('an active backup lock excludes concurrent maintenance and an abandoned lock is reusable', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    const lockFile = path.join(fixture.backupRoots.development, 'maintenance.lock');
    writeFixtureFile(lockFile, 'synthetic abandoned lock\n');
    const before = treeSnapshot(fixture.root);
    const release = await startHelper(fixture, `$ErrorActionPreference='Stop'; $stream=[IO.File]::Open(${quotePs(lockFile)},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try {Write-Output 'FIXTURE_READY'; [void][Console]::ReadLine()} finally {$stream.Dispose()}`);
    try {
      const result = runManager(fixture, { mode: 'Restore', acknowledged: true });
      assert.equal(result.status, 1);
      assert.equal(result.report.status, 'REFUSED');
      assert.equal(result.report.phase, 'lock');
      assert.equal(result.report.receiptPath, null);
      assert.match(result.report.error, /maintenance\.lock/);
    } finally { await release(); }
    assert.deepEqual(treeSnapshot(fixture.root), before);
    expectSuccess(runManager(fixture, { mode: 'Restore', acknowledged: true }), 'RESTORED');
    assertTargets(fixture, 'development', 'beforeSha256');
    assertNoMaintenanceResidue(fixture);
  }));

  await context.test('a real third-file sharing violation rolls back the first two replacements and records the failure', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    const acls = aclSnapshot(fixture, 'development');
    const lockedFile = path.join(fixture.targetRoots.development, targetPaths[2]);
    const release = await startHelper(fixture, `$ErrorActionPreference='Stop'; $stream=[IO.File]::Open(${quotePs(lockedFile)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try {Write-Output 'FIXTURE_READY'; [void][Console]::ReadLine()} finally {$stream.Dispose()}`);
    try {
      const result = runManager(fixture, { mode: 'Apply', acknowledged: true });
      assert.equal(result.status, 1, JSON.stringify(result.report));
      assert.equal(result.report.status, 'FAILED_ROLLED_BACK', JSON.stringify(result.report));
      assert.equal(result.report.failedTarget, targetPaths[2]);
      assert.equal(result.report.failurePhase, 'replace');
      const events = receiptEvents(result.report);
      assert.deepEqual(events.filter((event) => event.event === 'replaceCompleted').map((event) => event.data.path), targetPaths.slice(0, 2));
      assert.deepEqual(events.filter((event) => event.event === 'rollbackCompleted').map((event) => event.data.path), targetPaths.slice(0, 2).reverse());
      assert.equal(events.at(-1).data.status, 'FAILED_ROLLED_BACK');
      assert.deepEqual(result.report.cleanupErrors, []);
      assertTargets(fixture, 'development', 'beforeSha256');
      assert.deepEqual(aclSnapshot(fixture, 'development'), acls);
      assertNoMaintenanceResidue(fixture);
    } finally { await release(); }
  }));

  await context.test('non-fixture mode refuses running Codex or runner processes without stopping anything', async () => withFixture(async (fixture) => {
    expectSuccess(runManager(fixture, { mode: 'Prepare' }), 'PREPARED');
    const release = await startHelper(fixture, "Write-Output 'task-router-runner FIXTURE_READY'; [void][Console]::ReadLine()");
    try {
      for (const mode of ['Apply', 'Restore']) expectRefusal(fixture, { mode, acknowledged: true, isolated: false }, /OFFLINE_PROCESSES_RUNNING/);
    } finally { await release(); }
    assertTargets(fixture, 'development', 'beforeSha256');
  }));

  for (const profile of profiles) {
    await context.test(`${profile}: native no-AI descriptors survive Inspect, Prepare, Apply, Restore and repeated recovery exactly`, async () => withFixture(async (fixture) => {
      const seeded = seedNoAiTargetAcls(fixture, profile);
      const otherProfile = profiles.find((member) => member !== profile);
      const otherBefore = treeSnapshot(fixture.targetRoots[otherProfile]);
      const otherAcls = aclSnapshot(fixture, otherProfile);
      const packageBefore = treeSnapshot(fixture.packageRoot);
      const baselineBefore = treeSnapshot(fixture.targetRoots[profile]);
      const inspectBefore = treeSnapshot(fixture.root);
      const inspected = expectSuccess(runManager(fixture, { profile }), 'INSPECTED');
      assert.equal(inspected.receiptPath, null);
      assert.equal(inspected.backupPrepared, false);
      assert.deepEqual(treeSnapshot(fixture.root), inspectBefore);
      assert.deepEqual(nativeAclStates(fixture, fixture.targetRoots[profile]), seeded.map((entry) => entry.actual));
      const prepared = expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
      assert.deepEqual(treeSnapshot(fixture.targetRoots[profile]), baselineBefore);
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'Prepare');
      const recoveryPath = path.join(fixture.backupRoots[profile], 'recovery-manifest.json');
      const recoveryBytes = fs.readFileSync(recoveryPath);
      const recovery = JSON.parse(recoveryBytes);
      assert.equal(recovery.machineProfile, profile);
      assert.deepEqual(recovery.targets.map((entry) => entry.path), targetPaths);
      assert.deepEqual(recovery.targets.map((entry) => entry.aclSddl), seeded.map((entry) => entry.actual.sddl));
      assert.deepEqual(recovery.targets.map((entry) => entry.backupAclSddl), seeded.map((entry) => entry.backup.sddl));
      assert.equal(fs.readFileSync(path.join(fixture.backupRoots[profile], 'recovery-manifest.sha256'), 'utf8').trim(), digest(recoveryBytes));
      assert.equal(receiptEvents(prepared).at(-1).data.status, 'PREPARED');
      const backupBefore = treeSnapshot(path.join(fixture.backupRoots[profile], 'original'));
      expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'ALREADY_PREPARED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'repeated Prepare');
      assert.deepEqual(fs.readFileSync(recoveryPath), recoveryBytes);
      const preparedInspectBefore = treeSnapshot(fixture.root);
      expectSuccess(runManager(fixture, { profile }), 'INSPECTED');
      assert.deepEqual(treeSnapshot(fixture.root), preparedInspectBefore);
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'prepared Inspect');
      const applyResult = runManager(fixture, { mode: 'Apply', profile, acknowledged: true });
      if (applyResult.report.status === 'FAILED_ROLLED_BACK') assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'unexpected Apply failure independently verified');
      const applied = expectSuccess(applyResult, 'APPLIED');
      assert.deepEqual(receiptEvents(applied).filter((event) => event.event === 'replaceCompleted').map((event) => event.data.path), targetPaths);
      assertNativePhase(context, fixture, profile, seeded, 'candidateSha256', 'Apply');
      const appliedBefore = treeSnapshot(fixture.targetRoots[profile]);
      expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'ALREADY_APPLIED');
      assert.deepEqual(treeSnapshot(fixture.targetRoots[profile]), appliedBefore);
      assertNativePhase(context, fixture, profile, seeded, 'candidateSha256', 'repeated Apply');
      const appliedInspectBefore = treeSnapshot(fixture.root);
      expectSuccess(runManager(fixture, { profile }), 'INSPECTED');
      assert.deepEqual(treeSnapshot(fixture.root), appliedInspectBefore);
      assertNativePhase(context, fixture, profile, seeded, 'candidateSha256', 'applied Inspect');
      for (const phase of ['Restore', 'repeated Restore']) {
        const restored = expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
        assert.equal(restored.fourFileResult, 'RESTORED_SHA256_AND_ACL_VERIFIED');
        assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', phase);
        assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
        assert.deepEqual(fs.readFileSync(recoveryPath), recoveryBytes);
      }
      assert.deepEqual(treeSnapshot(fixture.packageRoot), packageBefore);
      assert.deepEqual(treeSnapshot(fixture.targetRoots[otherProfile]), otherBefore);
      assert.deepEqual(aclSnapshot(fixture, otherProfile), otherAcls);
    }));

    await context.test(`${profile}: no-AI maintenance keeps offline, SHA, control-bit, ACE-order and backup-lock refusals strict`, async () => withFixture(async (fixture) => {
      const seeded = seedNoAiTargetAcls(fixture, profile);
      expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'refusal fixture prepared');
      for (const mode of ['Apply', 'Restore']) expectNativeRefusal(fixture, profile, { mode }, /OFFLINE_WINDOW_REQUIRED/);
      const lockFile = path.join(fixture.backupRoots[profile], 'maintenance.lock');
      writeFixtureFile(lockFile, 'synthetic abandoned lock\n');
      const lockTreeBefore = treeSnapshot(fixture.root);
      const lockTargetsBefore = nativeAclStates(fixture, fixture.targetRoots[profile]);
      const lockBackupsBefore = nativeAclStates(fixture, path.join(fixture.backupRoots[profile], 'original'));
      const release = await startHelper(fixture, `$ErrorActionPreference='Stop'; $stream=[IO.File]::Open(${quotePs(lockFile)},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try {Write-Output 'FIXTURE_READY'; [void][Console]::ReadLine()} finally {$stream.Dispose()}`);
      try {
        for (const mode of ['Apply', 'Restore']) {
          const result = runManager(fixture, { mode, profile, acknowledged: true });
          assert.equal(result.status, 1, JSON.stringify(result.report));
          const report = result.report;
          assert.equal(report.status, 'REFUSED');
          assert.match(report.error, /maintenance\.lock/);
          assert.equal(report.phase, 'lock');
          assert.equal(report.receiptPath, null);
          assert.deepEqual(nativeAclStates(fixture, fixture.targetRoots[profile]), lockTargetsBefore);
          assert.deepEqual(nativeAclStates(fixture, path.join(fixture.backupRoots[profile], 'original')), lockBackupsBefore);
        }
      } finally { await release(); }
      assert.deepEqual(treeSnapshot(fixture.root), lockTreeBefore);
      fs.unlinkSync(lockFile);
      for (const location of ['target', 'backup']) {
        const root = location === 'target' ? fixture.targetRoots[profile] : path.join(fixture.backupRoots[profile], 'original');
        const file = path.join(root, targetPaths[2]);
        const original = fs.readFileSync(file);
        fs.appendFileSync(file, '\nsynthetic no-AI SHA drift\n');
        for (const mode of ['Apply', 'Restore']) expectNativeRefusal(fixture, profile, { mode, acknowledged: true }, location === 'target' ? /TARGET_DRIFT/ : /BACKUP_DRIFT/);
        writeFixtureFile(file, original);
      }
      const explicitFile = path.join(fixture.targetRoots[profile], targetPaths[0]);
      rewriteFixtureSddl(fixture, explicitFile, seeded[0].actual.sddl.replace('D:', 'D:P'));
      for (const mode of ['Apply', 'Restore']) expectNativeRefusal(fixture, profile, { mode, acknowledged: true }, /TARGET_ACL_DRIFT/);
      rewriteFixtureSddl(fixture, explicitFile, seeded[0].actual.sddl);
      const noncanonicalFile = path.join(fixture.targetRoots[profile], targetPaths[2]);
      const noncanonicalSddl = seeded[2].actual.sddl;
      const aces = noncanonicalSddl.match(/\([^)]*\)/g);
      const reordered = noncanonicalSddl.slice(0, noncanonicalSddl.indexOf('(')) + [aces[0], aces[2], aces[1], ...aces.slice(3)].join('');
      rewriteFixtureSddl(fixture, noncanonicalFile, reordered);
      for (const mode of ['Apply', 'Restore']) expectNativeRefusal(fixture, profile, { mode, acknowledged: true }, /TARGET_ACL_DRIFT/);
      rewriteFixtureSddl(fixture, noncanonicalFile, noncanonicalSddl);
      const backupFile = path.join(fixture.backupRoots[profile], 'original', targetPaths[2]);
      rewriteFixtureSddl(fixture, backupFile, seeded[2].backup.sddl.replace('D:P', 'D:'));
      for (const mode of ['Apply', 'Restore']) expectNativeRefusal(fixture, profile, { mode, acknowledged: true }, /BACKUP_ACL_DRIFT/);
      rewriteFixtureSddl(fixture, backupFile, seeded[2].backup.sddl);
      expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'healthy recovery after refusals');
    }));

    await context.test(`${profile}: a real no-AI third-file sharing violation restores full descriptors and SHA in reverse order`, async () => withFixture(async (fixture) => {
      const seeded = seedNoAiTargetAcls(fixture, profile);
      expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'sharing fixture prepared');
      const backupBefore = treeSnapshot(path.join(fixture.backupRoots[profile], 'original'));
      const lockedFile = path.join(fixture.targetRoots[profile], targetPaths[2]);
      const release = await startHelper(fixture, `$ErrorActionPreference='Stop'; $stream=[IO.File]::Open(${quotePs(lockedFile)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); try {Write-Output 'FIXTURE_READY'; [void][Console]::ReadLine()} finally {$stream.Dispose()}`);
      try {
        const result = runManager(fixture, { mode: 'Apply', profile, acknowledged: true });
        assert.equal(result.status, 1, JSON.stringify(result.report));
        assert.equal(result.report.status, 'FAILED_ROLLED_BACK', JSON.stringify(result.report));
        assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'sharing failure independently verified');
        assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
        assert.equal(result.report.failedTarget, targetPaths[2]);
        assert.equal(result.report.failurePhase, 'replace');
        assert.deepEqual(result.report.cleanupErrors, []);
        const events = receiptEvents(result.report);
        assert.deepEqual(events.filter((event) => event.event === 'replaceCompleted').map((event) => event.data.path), targetPaths.slice(0, 2));
        assert.deepEqual(events.filter((event) => event.event === 'rollbackCompleted').map((event) => event.data.path), targetPaths.slice(0, 2).reverse());
        assert.equal(events.at(-1).data.status, 'FAILED_ROLLED_BACK');
        assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'third-file failure rolled back');
        assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
      } finally { await release(); }
      expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'recovery after sharing lock released');
      expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'repeated recovery after sharing lock released');
    }));
  }

  await context.test('development: valid inherited AI outer and no-AI bridge/wake/updater select independent write paths in one operation', async () => withFixture(async (fixture) => {
    const profile = 'development';
    const seeded = seedNoAiTargetAcls(fixture, profile, true);
    const baselineBefore = treeSnapshot(fixture.targetRoots[profile]);
    const otherBefore = treeSnapshot(fixture.targetRoots.training);
    const otherAcls = aclSnapshot(fixture, 'training');
    expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
    assert.deepEqual(treeSnapshot(fixture.targetRoots[profile]), baselineBefore);
    assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'mixed AI/no-AI Prepare');
    const backupBefore = treeSnapshot(path.join(fixture.backupRoots[profile], 'original'));
    expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'APPLIED');
    assertNativePhase(context, fixture, profile, seeded, 'candidateSha256', 'mixed AI/no-AI Apply');
    for (const phase of ['mixed AI/no-AI Restore', 'mixed AI/no-AI repeated Restore']) {
      expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
      assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', phase);
      assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
    }
    assert.deepEqual(treeSnapshot(fixture.targetRoots.training), otherBefore);
    assert.deepEqual(aclSnapshot(fixture, 'training'), otherAcls);
  }));

  assert.equal(ownedRoots.size, 0);
  assert.equal(digest(fs.readFileSync(scriptPath)), frozenScriptSha256, 'Maintenance script changed during the fixture run');
  context.diagnostic('All synthetic fixture roots and helper processes cleaned; no candidate payload, updater, production service or shared source executed');
});

test('WinPS5 long atomic staging preserves original target roots and full native permissions', { skip: !windows, timeout: 600000 }, async (context) => {
  const names = await withFixture(async (fixture) => JSON.parse(runPsCommand(`
$parseTokens=$null
$parseErrors=$null
$syntax=[Management.Automation.Language.Parser]::ParseFile(${quotePs(scriptPath)},[ref]$parseTokens,[ref]$parseErrors)
if($parseErrors.Count -ne 0){throw 'Maintenance entry did not parse'}
$nameFunction=$syntax.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'New-TemporaryFileName'},$true)
if($null -eq $nameFunction){throw 'Bounded temporary filename function is missing'}
. ([scriptblock]::Create($nameFunction.Extent.Text))
[ordered]@{newName=(New-TemporaryFileName '.new');oldName=(New-TemporaryFileName '.old');anotherNewName=(New-TemporaryFileName '.new')} | ConvertTo-Json -Compress
`, fixture.root)));
  assert.equal(new Set(Object.values(names)).size, 3);
  for (const temporaryName of Object.values(names)) {
    assert.match(temporaryName, /^\.merged-[a-f0-9]{32}\.(?:new|old)$/);
    assert.equal(temporaryName.length, 44);
  }
  for (const profile of profiles) {
    for (const historicalLength of [260, 263]) {
      await context.test(`${profile}: historical temporary path length ${historicalLength}`, async () => withFixture(async (fixture) => {
        const historicalName = `.merged-${'1'.repeat(32)}-${'2'.repeat(32)}.new`;
        const minimumPath = path.join(fixture.root, 't', 'src', historicalName);
        const paddingLength = historicalLength - minimumPath.length;
        assert.ok(paddingLength >= 0, 'The fixture parent must allow the exact historical path length');
        const nextTargetRoot = path.join(fixture.root, `t${'p'.repeat(paddingLength)}`);
        assert.equal(path.dirname(path.resolve(nextTargetRoot)), path.resolve(fixture.root));
        assertNoReparseAncestors(fixture.targetRoots[profile]);
        assertNoReparseAncestors(nextTargetRoot);
        fs.renameSync(fixture.targetRoots[profile], nextTargetRoot);
        fixture.targetRoots[profile] = nextTargetRoot;
        assert.equal(path.join(nextTargetRoot, 'src', historicalName).length, historicalLength);
        assert.equal(path.join(nextTargetRoot, 'src', names.newName).length, historicalLength - 33);
        assert.equal(path.join(nextTargetRoot, 'src', names.oldName).length, historicalLength - 33);
        const targetRootsBefore = { ...fixture.targetRoots };
        const seeded = seedNoAiTargetAcls(fixture, profile);
        const otherProfile = profiles.find((candidate) => candidate !== profile);
        const otherBefore = treeSnapshot(fixture.targetRoots[otherProfile]);
        const baselineBefore = treeSnapshot(nextTargetRoot);
        expectSuccess(runManager(fixture, { mode: 'Inspect', profile }), 'INSPECTED');
        assert.deepEqual(treeSnapshot(nextTargetRoot), baselineBefore);
        expectSuccess(runManager(fixture, { mode: 'Prepare', profile }), 'PREPARED');
        assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', 'long-path Prepare');
        const backupBefore = treeSnapshot(path.join(fixture.backupRoots[profile], 'original'));
        expectSuccess(runManager(fixture, { mode: 'Apply', profile, acknowledged: true }), 'APPLIED');
        assertNativePhase(context, fixture, profile, seeded, 'candidateSha256', 'long-path Apply');
        for (const phase of ['long-path Restore', 'long-path repeated Restore']) {
          expectSuccess(runManager(fixture, { mode: 'Restore', profile, acknowledged: true }), 'RESTORED');
          assertNativePhase(context, fixture, profile, seeded, 'beforeSha256', phase);
          assert.deepEqual(treeSnapshot(path.join(fixture.backupRoots[profile], 'original')), backupBefore);
        }
        assert.deepEqual(fixture.targetRoots, targetRootsBefore);
        assert.deepEqual(treeSnapshot(fixture.targetRoots[otherProfile]), otherBefore);
        assertNoMaintenanceResidue(fixture);
      }));
    }
  }
  assert.equal(ownedRoots.size, 0);
});
