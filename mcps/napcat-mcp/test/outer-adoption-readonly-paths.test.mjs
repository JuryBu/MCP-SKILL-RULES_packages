import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(project, 'ops/manage-codex-outer-adoption-window.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

test('only pinned read-only runtime manifest permits a file hard link', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-readonly-paths-'));
  try {
    const bundle = path.join(root, 'data/state/codex-runtime-bundles', 'a'.repeat(64));
    fs.mkdirSync(bundle, { recursive: true });
    const original = path.join(root, 'original.json');
    fs.writeFileSync(original, '{}');
    fs.linkSync(original, path.join(bundle, '.codex-runtime-manifest.json'));
    fs.linkSync(original, path.join(bundle, 'other.json'));
    fs.symlinkSync(bundle, path.join(root, 'junction'), 'junction');
    const script = path.join(root, 'probe.ps1');
    fs.writeFileSync(script, `param([string]$Source,[string]$Root)
$ErrorActionPreference='Stop'
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw 'SOURCE_PARSE_FAILED'}
$Function=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Get-PlainPath'},$true)
Invoke-Expression $Function.Extent.Text
$Bundle=Join-Path $Root ('data/state/codex-runtime-bundles/'+('a'*64))
$Manifest=Join-Path $Bundle '.codex-runtime-manifest.json'
$Results=@()
$Plan=$null
try{Get-PlainPath $Manifest|Out-Null;$Results+='unexpected'}catch{$Results+=$_.Exception.Message}
$Plan=@{dataRoot=(Join-Path $Root 'data');codex=@{path=(Join-Path $Bundle 'codex.exe')}}
Get-PlainPath $Manifest|Out-Null;$Results+='pinned-read-only'
try{Get-PlainPath $Manifest -TempOnly|Out-Null;$Results+='unexpected'}catch{$Results+=$_.Exception.Message}
try{Get-PlainPath (Join-Path $Bundle 'other.json')|Out-Null;$Results+='unexpected'}catch{$Results+=$_.Exception.Message}
$Plan.codex.path=Join-Path $Root 'junction/codex.exe'
try{Get-PlainPath (Join-Path $Root 'junction/.codex-runtime-manifest.json')|Out-Null;$Results+='unexpected'}catch{$Results+=$_.Exception.Message}
$Results|ConvertTo-Json -Compress
`);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psexecutionpolicypreference'));
    const run = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Source', source, '-Root', root], { encoding: 'utf8', windowsHide: true, env: environment });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['OUTER_LINK_REJECTED', 'pinned-read-only', 'OUTER_LINK_REJECTED', 'OUTER_LINK_REJECTED', 'OUTER_LINK_REJECTED']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
