import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const entry of ['invoke-codex-outer-owner-window.ps1', 'manage-codex-outer-adoption-window.ps1', 'codex-outer-adoption-window-transaction.ps1']) {
test(`${entry} stops at the verified Windows shell and rejects unproven origins`, { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-owner-terminal-'));
  try {
    const source = path.join(project, 'ops', entry);
    const refusal = entry.startsWith('invoke-') ? 'OWNER_INDEPENDENT_TERMINAL_REQUIRED' : entry.startsWith('manage-') ? 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED' : 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED';
    const script = path.join(root, 'terminal-contract.ps1');
    fs.writeFileSync(script, '\uFEFF' + `
$ErrorActionPreference='Stop'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw 'SOURCE_PARSE_FAILED'}
$Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq 'Assert-IndependentTerminalOrigin'},$true)
if(-not $Definition){throw 'SOURCE_FUNCTION_MISSING'}
Invoke-Expression $Definition.Extent.Text
function Get-CimInstance {
  param($ClassName,$Filter,$ErrorAction)
  $script:Calls+=@($Filter)
  if($script:Case -ceq 'query-error'){throw 'QUERY_FAILED'}
  if($script:Case -ceq 'owner-script-chain'){
    $ProcessId=[int]($Filter -replace '^ProcessId = ','')
    if($ProcessId -eq 500){return [pscustomobject]@{ProcessId=500;ParentProcessId=600;Name='explorer.exe';ExecutablePath=([IO.Path]::Combine([Environment]::GetFolderPath('Windows'),'explorer.exe'));CommandLine='explorer.exe';CreationDate=[DateTime]'2026-10-10T09:15:02Z';SessionId=1}}
    $Commands=@{100='powershell.exe -File C:\\Owner\\codex-outer-adoption-window-transaction.ps1 -Action Apply';200='powershell.exe -File C:\\Owner\\manage-codex-outer-adoption-window.ps1 -Action ExecuteWindow';300='powershell.exe -File C:\\Owner\\invoke-codex-outer-owner-window.ps1 -Mode Apply';400='powershell.exe'}
    if(-not $Commands.ContainsKey($ProcessId)){return}
    return [pscustomobject]@{ProcessId=$ProcessId;ParentProcessId=($ProcessId+100);Name='powershell.exe';ExecutablePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';CommandLine=$Commands[$ProcessId];CreationDate=([DateTime]'2026-10-11T09:22:20Z').AddSeconds(-$ProcessId);SessionId=1}
  }
  if($Filter -ceq 'ProcessId = 100'){
    return [pscustomobject]@{ProcessId=100;ParentProcessId=200;Name='powershell.exe';ExecutablePath='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';CommandLine='powershell.exe';CreationDate=[DateTime]'2026-10-11T09:22:20Z';SessionId=1}
  }
  if($Filter -cne 'ProcessId = 200' -or $script:Case -ceq 'missing-parent'){return}
  $Parent=[pscustomobject]@{ProcessId=200;ParentProcessId=300;Name='explorer.exe';ExecutablePath=([IO.Path]::Combine([Environment]::GetFolderPath('Windows'),'explorer.exe'));CommandLine='explorer.exe';CreationDate=[DateTime]'2026-10-10T09:15:02Z';SessionId=1}
  switch($script:Case){
    'model-ancestor' {$Parent.Name='node.exe';$Parent.CommandLine='node app-server mcp-http-broker'}
    'desktop-ancestor' {$Parent.Name='ChatGPT.exe';$Parent.CommandLine='ChatGPT.exe'}
    'spoofed-explorer' {$Parent.ExecutablePath='C:\\other\\explorer.exe'}
    'reused-parent' {$Parent.CreationDate=[DateTime]'2026-10-11T09:23:00Z'}
    'different-session' {$Parent.SessionId=2}
    'unknown-command' {$Parent.CommandLine=$null}
    'unknown-path' {$Parent.ExecutablePath=$null}
    'cycle' {$Parent.Name='cmd.exe';$Parent.ParentProcessId=100}
    'unrooted' {$Parent.Name='cmd.exe';$Parent.ParentProcessId=0}
  }
  return $Parent
}
$Cases=@('windows-shell-dead-ancestor','owner-script-chain','model-ancestor','desktop-ancestor','missing-parent','spoofed-explorer','reused-parent','different-session','unknown-command','unknown-path','cycle','unrooted','query-error')
foreach($Case in $Cases){
  $script:Case=$Case;$script:Calls=@();$Failure='';$Proof=$null
  try{$Proof=Assert-IndependentTerminalOrigin 100}catch{$Failure=$_.Exception.Message}
  if($Case -ceq 'windows-shell-dead-ancestor'){
    if($Failure -or $Proof.explorerPid -ne 200 -or $script:Calls.Count -ne 2){throw ('NORMAL_ORIGIN_FAILED: '+$Failure)}
  }elseif($Case -ceq 'owner-script-chain'){
    if($Failure -or $Proof.explorerPid -ne 500 -or $script:Calls.Count -ne 5){throw ('OWNER_SCRIPT_CHAIN_FAILED: '+$Failure)}
  }elseif($Case -ceq 'query-error'){
    if($Failure -cne 'QUERY_FAILED'){throw 'QUERY_ERROR_NOT_PRESERVED'}
  }elseif($Failure -cne '${refusal}'){
    throw ('REFUSAL_FAILED: '+$Case+'/'+$Failure)
  }
}
[pscustomobject]@{passed=$Cases.Count;productionModified=$false;sourceSha256=(Get-FileHash -LiteralPath '${source}' -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
`, 'utf8');
    const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.passed, 13);
    assert.equal(evidence.productionModified, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
}

test('production owner transaction is checked before the original service stop', () => {
  const source = fs.readFileSync(path.join(project, 'ops/manage-codex-outer-adoption-window.ps1'), 'utf8');
  const gate = source.indexOf("$GateArguments[8] = 'VerifyOwnerGate'");
  const stop = source.indexOf("Stop-BoundEntry $ResolvedStopIdentity 'original-stop'", gate);
  assert.ok(gate >= 0 && stop > gate);
  assert.match(source.slice(gate, stop), /owner-gate-verified/);
});
