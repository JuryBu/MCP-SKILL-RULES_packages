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

test('actual owner wrapper retains same-transaction write evidence after malformed parent output', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-owner-write-receipt-'));
  try {
    const child = path.join(root, 'parent.ps1');
    fs.writeFileSync(child, '\uFEFF' + `
param([string]$Action,[string]$PlanPath,[string]$PlanSha256,[string]$WindowPath,[string]$WindowSha256)
$Values=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json
$Receipt=@{schemaVersion=1;ownerId=$Values.ownerId;contractSha256=$Values.contractSha256;windowSha256=$WindowSha256;mayHaveWritten=$true;written=@('owned-temp-file')}
[IO.File]::WriteAllText((Join-Path $Values.contractRoot 'transaction-attempt.json'),($Receipt|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
Write-Output 'malformed parent output'
exit 0
`, 'utf8');
    const driver = path.join(root, 'driver.ps1');
    fs.writeFileSync(driver, '\uFEFF' + `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile(${quote(source)},[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw 'SOURCE_PARSE_FAILED'}
foreach($Name in @('Invoke-Parent','Update-ProductionWriteState')){
  $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq $Name},$true)
  if(-not$Definition){throw 'SOURCE_FUNCTION_MISSING'}
  Invoke-Expression $Definition.Extent.Text
}
function Save-Claim([string]$Phase){}
function Json([string]$Path){Get-Content -LiteralPath $Path -Raw -Encoding UTF8|ConvertFrom-Json}
function Sha([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$Root=${quote(root)}
$ContractPath=Join-Path $Root 'transaction-contract.json'
[IO.File]::WriteAllText($ContractPath,(@{ownerId='owned-temp';parentAttemptId='same-attempt'}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
$ContractSha=Sha $ContractPath
$WindowPath=Join-Path $Root 'window.json'
[IO.File]::WriteAllText($WindowPath,'{}',(New-Object Text.UTF8Encoding($false)))
$PlanPath=Join-Path $Root 'plan.json'
[IO.File]::WriteAllText($PlanPath,(@{ownerId='owned-temp';contractSha256=$ContractSha;contractRoot=$Root}|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
$Plan=@{ownerId='owned-temp';attemptId='same-attempt';transaction=@{contractRoot=$Root;contractSha256=$ContractSha};powerShell=@{path=${quote(shell)}}}
$Config=@{parentPath=${quote(child)};planPath=$PlanPath;planSha256=(Sha $PlanPath)}
$Result=@{productionWritten=$null;parentResults=@()}
$WriteAttempted=$true
try{Invoke-Parent 'ExecuteWindow' $WindowPath (Sha $WindowPath)|Out-Null;throw 'MALFORMED_OUTPUT_ACCEPTED'}catch{if($_.Exception.Message-cne'OWNER_PARENT_RESULT_UNKNOWN: ExecuteWindow'){throw};$Result.error=$_.Exception.Message}finally{Update-ProductionWriteState}
if($Result.productionWritten-ne$true -or $Result.productionWriteState-cne'written'){throw 'WRITE_EVIDENCE_LOST'}
$ReceiptPath=Join-Path $Root 'transaction-attempt.json'
$Valid=Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8
$Outcomes=@(@{case='malformed-parent';state=$Result.productionWriteState})
foreach($Case in @('missing','unreadable','wrong-owner','not-written')){
  switch($Case){
    'missing'{Remove-Item -LiteralPath $ReceiptPath}
    'unreadable'{[IO.File]::WriteAllText($ReceiptPath,'broken')}
    'wrong-owner'{$Receipt=$Valid|ConvertFrom-Json;$Receipt.ownerId='foreign';[IO.File]::WriteAllText($ReceiptPath,($Receipt|ConvertTo-Json))}
    'not-written'{$Receipt=$Valid|ConvertFrom-Json;$Receipt.mayHaveWritten=$false;$Receipt.written=@();[IO.File]::WriteAllText($ReceiptPath,($Receipt|ConvertTo-Json))}
  }
  $Result=@{productionWritten=$null}
  Update-ProductionWriteState
  if($Case-ceq'not-written'){if($Result.productionWritten-ne$false -or $Result.productionWriteState-cne'not-written'){throw 'NO_WRITE_EVIDENCE_FAILED'}}elseif($null-ne$Result.productionWritten -or $Result.productionWriteState-cne'unknown'){throw 'UNKNOWN_WRITE_EVIDENCE_ACCEPTED'}
  $Outcomes+=@{case=$Case;state=$Result.productionWriteState}
}
@{passed=$Outcomes.Count;outcomes=$Outcomes;productionModified=$false;sourceSha256=(Sha ${quote(source)})}|ConvertTo-Json -Depth 5 -Compress
`, 'utf8');
    const run = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', driver], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const evidence = JSON.parse(run.stdout.trim());
    assert.equal(evidence.passed, 5);
    assert.deepEqual(evidence.outcomes.map(item => item.state), ['written', 'unknown', 'unknown', 'unknown', 'not-written']);
    process.stdout.write(`WRITE_RECEIPT_EVIDENCE ${JSON.stringify(evidence)}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
