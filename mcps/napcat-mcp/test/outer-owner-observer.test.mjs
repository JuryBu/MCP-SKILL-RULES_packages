import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(project, 'ops/invoke-codex-outer-owner-window.ps1');
const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

test('actual owner observer reads zero and nonzero native child exits after redirect and refresh', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-owner-observer-'));
  try {
    const child = path.join(root, 'observer-child.ps1');
    fs.writeFileSync(child, '\uFEFF' + `
param([string]$Action,[string]$PlanPath,[string]$PlanSha256)
$ErrorActionPreference='Stop'
$Values=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json
$Root=Split-Path -Parent $PlanPath
$Utf8=New-Object Text.UTF8Encoding($false)
$Ready=@{ownerId=$Values.ownerId;planSha256=$PlanSha256;observerPid=$PID;handlesPinned=$true}|ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $Root 'desktop-normal-observer-ready.json'),$Ready,$Utf8)
Start-Sleep -Milliseconds 500
@{action=$Action;status='desktop-normal-exit-observed';productionModified=$false;error=$null}|ConvertTo-Json -Compress
exit $Values.exitCode
`, 'utf8');
    const driver = path.join(root, 'observer-driver.ps1');
    fs.writeFileSync(driver, '\uFEFF' + `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw 'SOURCE_PARSE_FAILED'}
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq 'Observe-Desktop'},$true)
if(-not $Definition){throw 'OBSERVER_FUNCTION_MISSING'}
Invoke-Expression $Definition.Extent.Text
function Save-Claim([string]$Phase){$script:ObservedPhase=$Phase}
function Json([string]$Path){Get-Content -LiteralPath $Path -Encoding UTF8 -Raw|ConvertFrom-Json}
function Write-Host([string]$Message){$script:ExitPrompt=$Message}
$Outcomes=@()
foreach($Code in @(0,17)){
  $script:Root=Join-Path ${quote(root)} ('case-'+$Code)
  New-Item -ItemType Directory -Path $Root|Out-Null
  $PlanPath=Join-Path $Root 'plan.json'
  [IO.File]::WriteAllText($PlanPath,(@{ownerId='observer-owned-temp';exitCode=$Code}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
  $script:Plan=@{ownerId='observer-owned-temp';powerShell=@{path=${quote(shell)}}}
  $script:Config=@{parentPath=${quote(child)};planPath=$PlanPath;planSha256=(Get-FileHash -LiteralPath $PlanPath).Hash.ToLowerInvariant()}
  $script:Result=@{parentResults=@()}
  $script:ExitPrompt=$null
  $Actual=Observe-Desktop
  if($null-eq$Actual.code -or $Actual.code-ne$Code -or $Result.parentResults[0].exitCode-ne$Code -or $Actual.result.status-cne'desktop-normal-exit-observed' -or -not$ExitPrompt){throw 'ACTUAL_OBSERVER_EXIT_CONTRACT_FAILED'}
  $Observed=$Actual
  $CallerGate=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.IfStatementAst] -and $Node.Extent.Text -match '^if \\(\\$Observed\\.code' -and $Node.Extent.Text -match 'OWNER_NORMAL_DESKTOP_EXIT_REQUIRED'},$true)
  if(-not$CallerGate){throw 'OBSERVER_CALLER_GATE_MISSING'}
  $Rejected=$false
  try{Invoke-Expression $CallerGate.Extent.Text}catch{if($_.Exception.Message-cne'OWNER_NORMAL_DESKTOP_EXIT_REQUIRED'){throw};$Rejected=$true}
  if($Rejected-ne($Code-ne0)){throw 'OBSERVER_CALLER_GATE_FAILED'}
  $Outcomes+=@{expected=$Code;actual=$Actual.code;promptAfterReady=[bool]$ExitPrompt;phase=$ObservedPhase}
}
@{passed=$Outcomes.Count;outcomes=$Outcomes;productionModified=$false;sourceSha256=(Get-FileHash -LiteralPath ${quote(source)}).Hash.ToLowerInvariant()}|ConvertTo-Json -Depth 5 -Compress
`, 'utf8');
    const run = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', driver], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const evidence = JSON.parse(run.stdout.trim());
    assert.equal(evidence.passed, 2);
    assert.deepEqual(evidence.outcomes.map(item => item.actual), [0, 17]);
    process.stdout.write(`OBSERVER_EVIDENCE ${JSON.stringify(evidence)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
