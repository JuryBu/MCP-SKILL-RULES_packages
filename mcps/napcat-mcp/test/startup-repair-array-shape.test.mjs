import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { windowsPowerShellEnvironment } from '../src/windows-powershell-environment.mjs';

const template = fs.readFileSync(fileURLToPath(new URL('../ops/startup-repair-files.template.ps1', import.meta.url)), 'utf8');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const child = windowsPowerShellEnvironment();
const executable = process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE || child.executable;
const environment = process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE ? process.env : child.environment;
const runShell = (args, extra = {}) => spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', ...args], {
  env: { ...environment, ...extra }, encoding: 'utf8', windowsHide: true, timeout: 20000,
});

for (const layout of [[true], [false], [true, false]]) {
  test(`file transaction preserves array shape for ${JSON.stringify(layout)}`, { skip: process.platform !== 'win32', timeout: 90000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'array shape owned '));
    const targetRoot = path.join(root, 'runtime');
    const packageRoot = path.join(root, 'package');
    for (const folder of [targetRoot, packageRoot, path.join(packageRoot, 'candidate'), path.join(packageRoot, 'original')]) fs.mkdirSync(folder);
    fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ ownerId: 'startup-repair-20261012', fixtureRoot: root }));
    const files = layout.map((exists, index) => {
      const name = `item-${index}.mjs`;
      const targetPath = path.join(targetRoot, name);
      const candidate = path.join(packageRoot, 'candidate', `${index}.bin`);
      fs.writeFileSync(candidate, `export const version = 'new-${index}';\n`);
      if (exists) {
        fs.writeFileSync(targetPath, `export const version = 'old-${index}';\n`);
        fs.copyFileSync(targetPath, path.join(packageRoot, 'original', `${index}.bin`));
      }
      return { name, targetPath, candidatePath: candidate, candidateSha256: digest(fs.readFileSync(candidate)), originalExists: exists };
    });
    try {
      const snapshot = runShell(['-Command', `
$ErrorActionPreference='Stop'
$sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$items=ConvertFrom-Json $env:ARRAY_ITEMS
$rows=@(foreach($item in $items) {
  $original=@{exists=$false;sha256=$null;sddl=$null;attributes=$null}
  $reference=$item.candidatePath
  if($item.originalExists) {
    $reference=$item.targetPath
    $original=@{exists=$true;sha256=(Get-FileHash -LiteralPath $reference -Algorithm SHA256).Hash.ToLowerInvariant();sddl=(Get-Acl -LiteralPath $reference).GetSecurityDescriptorSddlForm($sections);attributes=[int][IO.File]::GetAttributes($reference)}
  }
  @{name=$item.name;targetPath=$item.targetPath;candidateSha256=$item.candidateSha256;original=$original;installed=@{exists=$true;sha256=$item.candidateSha256;sddl=(Get-Acl -LiteralPath $reference).GetSecurityDescriptorSddlForm($sections);attributes=[int][IO.File]::GetAttributes($reference)}}
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress
`], { ARRAY_ITEMS: JSON.stringify(files) });
      assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
      const states = JSON.parse(snapshot.stdout.replace(/^\uFEFF/u, ''));
      const substitutions = {
        __PRODUCTION_ROOT__: targetRoot,
        __PRODUCTION_TARGETS_JSON__: JSON.stringify(files.map(file => file.targetPath)),
        __FILE_NAMES_JSON__: JSON.stringify(files.map(file => file.name)),
        __CANDIDATE_HASHES_JSON__: JSON.stringify(files.map(file => file.candidateSha256)),
        __ORIGINAL_HASHES_JSON__: JSON.stringify(states.map(file => file.original.sha256)),
      };
      let entryText = template;
      for (const [key, value] of Object.entries(substitutions)) entryText = entryText.replaceAll(key, value.replaceAll("'", "''"));
      const entryPath = path.join(packageRoot, 'repair-files.ps1');
      fs.writeFileSync(entryPath, '\uFEFF' + entryText);
      const manifest = { schemaVersion: 1, mode: 'TempFixture', fixtureRoot: root, targetRoot, entrySha256: digest(fs.readFileSync(entryPath)), files: states };
      const manifestPath = path.join(packageRoot, 'manifest.json');
      const receiptPath = path.join(packageRoot, 'receipt.json');
      const bind = () => {
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const manifestSha = digest(fs.readFileSync(manifestPath));
        fs.writeFileSync(receiptPath, JSON.stringify({ manifestSha256: manifestSha, status: 'PREPARED', intent: null, progress: files.map(() => 'ORIGINAL') }));
        return manifestSha;
      };
      const operation = (action, hash) => runShell(['-File', entryPath, '-Action', action, '-Mode', 'TempFixture', '-ManifestPath', manifestPath, '-ManifestSha256', hash]);
      const originalName = manifest.files[0].name;
      manifest.files[0].name = 'unexpected.mjs';
      const rejected = operation('Inspect', bind());
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stdout, /EXACT_FILES_REQUIRED/u);
      assert.equal(JSON.parse(rejected.stdout).targetWrites, 0);
      manifest.files[0].name = originalName;
      const manifestSha = bind();
      const inspected = operation('Inspect', manifestSha);
      assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
      assert.equal(JSON.parse(inspected.stdout).status, 'PREPARED');
      const installed = operation('Install', manifestSha);
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      assert.equal(JSON.parse(installed.stdout).targetWrites, files.length);
      for (const file of files) assert.equal(digest(fs.readFileSync(file.targetPath)), file.candidateSha256);
      const restored = operation('Rollback', manifestSha);
      assert.equal(restored.status, 0, restored.stdout + restored.stderr);
      assert.equal(JSON.parse(restored.stdout).status, 'ROLLED_BACK');
      for (const [index, file] of files.entries()) {
        assert.equal(fs.existsSync(file.targetPath), layout[index]);
        if (layout[index]) assert.equal(digest(fs.readFileSync(file.targetPath)), states[index].original.sha256);
      }
      console.log(JSON.stringify({ executable, layout, inspect: 'PREPARED', install: 'INSTALLED', rollback: 'ROLLED_BACK', mismatchRefused: true, productionActions: 0 }));
    } finally {
      const absolute = path.resolve(root);
      assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(absolute, { recursive: true, force: true });
    }
  });
}
