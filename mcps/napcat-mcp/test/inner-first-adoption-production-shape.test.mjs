import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../ops/invoke-inner-first-adoption-files.ps1', import.meta.url));
const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

for (const mode of ['Production', 'TempFixture']) {
  test(`strict plan serialization accepts ${mode} manifest shape without executing transaction`, { skip: process.platform !== 'win32' }, () => {
    const code = `Set-StrictMode -Version 2; $ErrorActionPreference='Stop';
$Tokens=$null; $Errors=$null; $Ast=[Management.Automation.Language.Parser]::ParseFile(${quote(entry)},[ref]$Tokens,[ref]$Errors);
if ($Errors.Count) { throw 'PARSE_ERROR' };
$Assignment=@($Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.AssignmentStatementAst] -and $Node.Left.Extent.Text -ceq '$Plan' -and $Node.Right.Extent.Text -match 'preparedAtUtc'},$true));
if ($Assignment.Count -ne 1) { throw 'EXACT_PLAN_ASSIGNMENT_REQUIRED' };
function Plain([string]$Value) { return $Value }; function Sha([string]$Value) { return 'readonly-test' };
$Mode=${quote(mode)}; $Scope='inner-first-adoption-files-v1'; $OwnerId='shape-test'; $TransactionId='shape-test'; $Sid='shape-test';
$TransactionRoot='C:\\shape-test'; $FreezeManifestSha256='shape-test'; $PSCommandPath=${quote(entry)}; $PowerShellPath=${quote(shell)};
$DirectoryStates=@(); $Items=@();
$Freeze=[pscustomobject]@{ candidateRoot='C:\\shape-test\\candidate'; installedRoot='C:\\shape-test\\installed'; dataRoot='C:\\shape-test\\data'; protectedProcesses=@(); readOnlyDependencies=@() };
if ($Mode -eq 'TempFixture') { $Freeze | Add-Member NoteProperty fixtureRoot 'C:\\shape-test' };
Invoke-Expression $Assignment[0].Extent.Text;
$Plan | ConvertTo-Json -Depth 5 -Compress;`;
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const plan = JSON.parse(result.stdout.trim());
    assert.equal(plan.mode, mode);
    assert.equal(plan.fixtureRoot, mode === 'TempFixture' ? 'C:\\shape-test' : null);
    assert.equal(plan.serviceActions, 0);
    assert.deepEqual(plan.items, []);
  });
}
