import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('unpublished startup checks complete launcher identity before a later node query', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-launcher-terminal-'));
  try {
    const parent = path.join(project, 'ops/manage-codex-outer-adoption-window.ps1');
    const script = path.join(root, 'terminal-contract.ps1');
    fs.writeFileSync(script, '\uFEFF' + `
$ErrorActionPreference='Stop'
$Root='${root}'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${parent}',[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw 'SOURCE_PARSE_FAILED'}
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq 'Wait-CandidateStartupTermination'},$true)
if(-not $Definition){throw 'SOURCE_FUNCTION_MISSING'}
Invoke-Expression $Definition.Extent.Text
$Plan=@{dataRoot=$Root;installedRoot=(Join-Path $Root 'installed');node=@{path='C:\\fixed\\node.exe'};powerShell=@{path='C:\\fixed\\powershell.exe'}}
$Attempt=@{candidateLaunch=@{instanceToken='9aeffdd7-0f7b-4348-9f0f-6429ff321349';receiptPath=(Join-Path $Root 'launch.json')}}
New-Item -ItemType Directory -Path (Join-Path $Root 'state')|Out-Null
[IO.File]::WriteAllText((Join-Path $Root 'state/codex-app-server-proxy-runtime.json'),'{}')
function Read-Json {param($Path) return [pscustomobject]@{instanceToken='old-stopped-token'}}
function Start-Sleep {param($Milliseconds) throw 'WAIT_OBSERVED'}
function Get-CimInstance {
  param($ClassName,$Filter,$ErrorAction)
  $script:Calls+=@($Filter)
  $IsLauncher=$Filter.Contains('powershell.exe')
  if($script:Case -ceq 'query-error'){throw 'QUERY_FAILED'}
  if($IsLauncher){
    if($script:Case -ceq 'launcher-path-unknown'){return [pscustomobject]@{ExecutablePath=$null;CommandLine=$null}}
    if($script:Case -ceq 'launcher-command-unknown'){return [pscustomobject]@{ExecutablePath=$Plan.powerShell.path;CommandLine=$null}}
    if($script:Case -ceq 'launcher-active'){return [pscustomobject]@{ExecutablePath=$Plan.powerShell.path;CommandLine=((Join-Path $Plan.installedRoot 'ops/start-codex-app-server-proxy.ps1')+' '+$Attempt.candidateLaunch.instanceToken+' '+$Attempt.candidateLaunch.receiptPath)}}
    return
  }
  if($script:Case -ceq 'node-path-unknown'){return [pscustomobject]@{ExecutablePath=$null;CommandLine=$null}}
  if($script:Case -ceq 'node-command-unknown'){return [pscustomobject]@{ExecutablePath=$Plan.node.path;CommandLine=$null}}
  if($script:Case -ceq 'node-active'){return [pscustomobject]@{ExecutablePath=$Plan.node.path;CommandLine=((Join-Path $Plan.installedRoot 'src/codex-app-server-proxy-runner.mjs')+' '+$Attempt.candidateLaunch.instanceToken+' '+$Attempt.candidateLaunch.receiptPath)}}
  if($script:Case -ceq 'node-identity-conflict'){return [pscustomobject]@{ExecutablePath='C:\\other\\node.exe';CommandLine=$Attempt.candidateLaunch.instanceToken}}
}
$Cases=@(
 @('launcher-path-unknown','OUTER_START_LAUNCHER_QUERY_INCOMPLETE',1),
 @('launcher-command-unknown','OUTER_START_LAUNCHER_QUERY_INCOMPLETE',1),
 @('launcher-active','WAIT_OBSERVED',1),
 @('node-path-unknown','OUTER_UNPUBLISHED_START_QUERY_INCOMPLETE',2),
 @('node-command-unknown','OUTER_UNPUBLISHED_START_QUERY_INCOMPLETE',2),
 @('node-active','WAIT_OBSERVED',2),
 @('node-identity-conflict','OUTER_UNPUBLISHED_START_IDENTITY_UNKNOWN',2),
 @('query-error','QUERY_FAILED',1),
 @('terminal-complete','',2)
)
foreach($Row in $Cases){
 $script:Case=$Row[0];$script:Calls=@();$Failure=''
 try{Wait-CandidateStartupTermination}catch{$Failure=$_.Exception.Message}
 if($Failure -cne $Row[1] -or $script:Calls.Count -ne $Row[2]){throw ('CASE_FAILED: '+$script:Case+'/'+$Failure+'/'+$script:Calls.Count)}
 if($script:Calls.Count -eq 2 -and (-not $script:Calls[0].Contains('powershell.exe') -or $script:Calls[1] -cne "Name = 'node.exe'")){throw 'QUERY_ORDER_FAILED'}
}
[pscustomobject]@{passed=$Cases.Count;productionModified=$false;sourceSha256=(Get-FileHash -LiteralPath '${parent}' -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
`, 'utf8');
    const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.passed, 9);
    assert.equal(evidence.productionModified, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
