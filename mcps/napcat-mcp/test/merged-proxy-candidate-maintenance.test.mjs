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
const powershellPath = path.join(windowsRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const fixtureParent = path.join(tmpdir(), 'outer-status-hidden-prep-20261009/recovery-fixtures');
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
  const result = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd, env: { ...childEnvironment, TEMP: cwd, TMP: cwd }, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function runManager(fixture, options = {}) {
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
    $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('FixtureAclRead'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
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
    assert.equal(await exited, 0, errors);
  };
}

test('merged candidate maintenance: standalone Windows PowerShell 5.1 fixture acceptance', { skip: !windows, timeout: 300000 }, async (context) => {
  const frozenScriptSha256 = digest(fs.readFileSync(scriptPath));
  context.diagnostic(`Maintenance script SHA256 ${frozenScriptSha256}`);
  await context.test('environment has Windows PowerShell 5.1 and no Node on the child PATH', async () => withFixture(async (fixture) => {
    const environment = JSON.parse(runPsCommand("$info=[ordered]@{powershell=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;nodeAvailable=($null -ne (Get-Command node -ErrorAction SilentlyContinue))}; $info | ConvertTo-Json -Compress", fixture.root));
    assert.match(environment.powershell, /^5\.1\./);
    assert.equal(environment.edition, 'Desktop');
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

  assert.equal(ownedRoots.size, 0);
  assert.equal(digest(fs.readFileSync(scriptPath)), frozenScriptSha256, 'Maintenance script changed during the fixture run');
  context.diagnostic('All synthetic fixture roots and helper processes cleaned; no candidate payload, updater, production service or shared source executed');
});
