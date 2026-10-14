import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(project, 'ops/manage-codex-outer-adoption-window.ps1');
const literal = value => `'${value.replaceAll("'", "''")}'`;

test('owner cold restart uses actual extracted AST and preserves strict live ownership', { skip: process.platform !== 'win32' }, async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-owner-cold-restart-'));
  const driver = path.join(root, 'cold-restart-driver.ps1');
  const evidencePath = path.join(root, 'evidence.json');
  const sourceSha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  fs.writeFileSync(driver, '\uFEFF' + `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$Source=${literal(source)}
$Root=${literal(root)}
$Tokens=$null;$Errors=$null
$SourceText=[IO.File]::ReadAllText($Source)
$Ast=[Management.Automation.Language.Parser]::ParseInput($SourceText,[ref]$Tokens,[ref]$Errors)
if($Errors.Count){throw 'SOURCE_PARSE_FAILED'}
$FunctionNames=@('Resolve-OwnerColdStopIdentity','Assert-Live','Process-Identity','Live-Binding','Preserve-OriginalBeforeStop','Assert-OriginalBaseline')
$Ranges=@()
foreach($FunctionName in $FunctionNames){
  $Definition=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -ceq $FunctionName},$true)
  if(-not $Definition){throw ('SOURCE_FUNCTION_MISSING: '+$FunctionName)}
  $Ranges+=@([pscustomobject]@{name=$FunctionName;startLine=$Definition.Extent.StartLineNumber;endLine=$Definition.Extent.EndLineNumber})
  Invoke-Expression $Definition.Extent.Text
}
$State=Join-Path $Root 'state'
[void][IO.Directory]::CreateDirectory($State)
[IO.File]::WriteAllText((Join-Path $State 'codex-app-server-proxy-token.txt'),'isolated-test-token')
function Copy-Identity($Identity){return ($Identity|ConvertTo-Json -Depth 12 -Compress|ConvertFrom-Json)}
function Read-Json($Path){
  if(-not $Path.StartsWith($Root,[StringComparison]::OrdinalIgnoreCase)){throw 'TEST_NON_TEMP_READ'}
  if($Path.EndsWith('transaction-contract.json')){return $script:Contract}
  if($Path.EndsWith('codex-app-server-proxy.lock')){return [pscustomobject]@{token=$script:Runtime.instanceToken;pid=$script:Runtime.pid}}
  if(-not $Path.EndsWith('codex-app-server-proxy-runtime.json')){throw 'TEST_UNEXPECTED_JSON_READ'}
  $script:RuntimeReads++
  $Runtime=Copy-Identity $script:Runtime
  if(($script:Case -ceq 'identity-drift-retries' -and $script:RuntimeReads -eq 2) -or ($script:Case -ceq 'resample-drift-retries' -and $script:RuntimeReads -eq 3)){$Runtime.appServerPid=303}
  return $Runtime
}
function Get-CimInstance {
  param($ClassName,$Filter,$ErrorAction)
  if($ClassName -cne 'Win32_Process' -or $Filter -notmatch '^ProcessId = ([0-9]+)$'){throw 'TEST_UNEXPECTED_CIM_QUERY'}
  $ProcessId=[int]$Matches[1]
  $script:ProcessQueries+=@($ProcessId)
  if($ProcessId -eq 202 -and $script:Case -ceq 'owned-listener-before-metadata-retries' -and $script:ListenerReads -ge 1){return}
  if($ProcessId -eq 202 -and $script:Runtime.appServerPid -ne 202 -and -not $script:OldStillPresent){return}
  $Identity=$script:Identities[$ProcessId]
  if(-not $Identity){return}
  return [pscustomobject]@{ProcessId=$Identity.pid;ParentProcessId=$Identity.parentPid;ExecutablePath=$Identity.executablePath;CommandLine=$Identity.commandLine;CreationDate=([DateTime]::Parse($Identity.createdAt).ToUniversalTime())}
}
function Get-NetTCPConnection {
  param($State,$LocalPort,$ErrorAction)
  $script:ListenerReads++
  $Listeners=@()
  foreach($Port in @(12001,12002,12003)){
    if($script:Case -ceq 'listener-gap-retries' -and $script:ListenerReads -eq 1 -and $Port -eq 12001){continue}
    $Owner=101;$Address='127.0.0.1'
    if($script:Case -ceq ('foreign-listener-'+$Port)){$Owner=999}
    if($script:Case -ceq 'owned-listener-before-metadata-retries' -and $script:ListenerReads -eq 1){$Owner=302}
    if($script:Case -ceq 'known-foreign-listener' -and $Port -eq 12001){$Owner=999}
    if($script:Case -ceq 'non-loopback-listener' -and $Port -eq 12001){$Address='0.0.0.0'}
    $Listeners+=@([pscustomobject]@{LocalPort=$Port;OwningProcess=$Owner;LocalAddress=$Address})
  }
  if($script:Case -ceq 'occupied-probe-port'){$Listeners+=@([pscustomobject]@{LocalPort=12004;OwningProcess=999;LocalAddress='127.0.0.1'})}
  return $Listeners
}
function Invoke-RestMethod {
  param($Uri,$Headers,$TimeoutSec)
  if($Uri -cne 'http://127.0.0.1:12002/v1/status' -or $Headers.Authorization -cne 'Bearer isolated-test-token'){throw 'TEST_UNEXPECTED_STATUS_CALL'}
  $script:StatusReads++
  return [pscustomobject]@{ok=$true;closed=$false;clientCount=0;clients=@();outerRuntime=[pscustomobject]@{activeOperationCount=0;trackedRequestCount=0;pendingToolCount=0;busy=$false}}
}
function Start-Sleep {
  param($Milliseconds,$Seconds)
  $script:Sleeps++
  if($script:Case -ceq 'owned-listener-before-metadata-retries'){$script:Runtime.appServerPid=302}
  if($script:Sleeps -gt 8){throw 'TEST_RETRY_BUDGET_EXHAUSTED'}
}
function Save-Attempt {$script:Saves++}
function Get-Sha($Path){
  if(-not $Path.StartsWith($Root,[StringComparison]::OrdinalIgnoreCase)){throw 'TEST_NON_TEMP_HASH'}
  $script:HashReads++
  if($script:Case -ceq 'preserve-hash-drift'){return 'changed-hash'}
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-Acl {
  param($LiteralPath)
  if(-not $LiteralPath.StartsWith($Root,[StringComparison]::OrdinalIgnoreCase)){throw 'TEST_NON_TEMP_ACL'}
  $script:AclReads++
  return [pscustomobject]@{Sddl=$(if($script:Case -ceq 'preserve-acl-drift'){'changed-acl'}else{'isolated-original-acl'})}
}
function Test-Path {
  param($LiteralPath,$PathType)
  if(-not $LiteralPath.StartsWith($Root,[StringComparison]::OrdinalIgnoreCase)){throw 'TEST_NON_TEMP_PATH'}
  if($PathType -ceq 'Leaf'){return [IO.File]::Exists($LiteralPath)}
  if($script:Case -ceq 'preserve-candidate-directory' -and $LiteralPath -ceq $Plan.candidateRoot){return $true}
  if($script:Case -ceq 'preserve-stop-marker' -and $LiteralPath.EndsWith('codex-app-server-proxy.stop')){return $true}
  if($script:Case -ceq 'preserve-transaction-attempt' -and $LiteralPath.EndsWith('transaction-attempt.json')){return $true}
  return $false
}
function Get-ChildItem {
  param($LiteralPath,$Filter,[switch]$File,$ErrorAction)
  if(-not $LiteralPath.StartsWith($Root,[StringComparison]::OrdinalIgnoreCase) -or $Filter -cne 'stop-proof-*.json'){throw 'TEST_UNEXPECTED_DIRECTORY_QUERY'}
  if($script:Case -ceq 'preserve-stop-proof'){return [pscustomobject]@{Name='stop-proof-isolated.json'}}
  return @()
}
function Get-Process {throw 'TEST_UNMOCKED_PROCESS_QUERY'}
function Stop-Process {throw 'TEST_FORBIDDEN_STOP'}
function Stop-Service {throw 'TEST_FORBIDDEN_SERVICE_CALL'}
$Cases=@(
  @('original-child-kept',''),
  @('owned-child-reopened',''),
  @('birth-equals-desktop-exit',''),
  @('listener-gap-retries',''),
  @('identity-drift-retries',''),
  @('resample-drift-retries',''),
  @('non-original-unchanged',''),
  @('ordinary-profile-unchanged',''),
  @('non-original-drift','OUTER_STOP_INSTANCE_DRIFT'),
  @('ordinary-profile-drift','OUTER_STOP_INSTANCE_DRIFT'),
  @('sample-root-drift','OUTER_STOP_INSTANCE_DRIFT'),
  @('missing-desktop-exit','OUTER_STOP_INSTANCE_DRIFT'),
  @('flag-false','OUTER_STOP_INSTANCE_DRIFT'),
  @('flag-missing','OUTER_STOP_INSTANCE_DRIFT'),
  @('token-changed','OUTER_COLD_PROXY_IDENTITY_CHANGED'),
  @('proxy-pid-changed','OUTER_COLD_PROXY_IDENTITY_CHANGED'),
  @('proxy-parent-changed','OUTER_COLD_PROXY_IDENTITY_CHANGED'),
  @('proxy-executable-changed','OUTER_COLD_PROXY_IDENTITY_CHANGED'),
  @('proxy-command-changed','OUTER_COLD_PROXY_IDENTITY_CHANGED'),
  @('proxy-birth-changed','OUTER_COLD_PROXY_IDENTITY_CHANGED'),
  @('old-child-still-present','OUTER_COLD_ORIGINAL_CHILD_STILL_PRESENT'),
  @('same-child-pid-identity-changed','OUTER_COLD_ORIGINAL_CHILD_STILL_PRESENT'),
  @('child-parent-changed','OUTER_FIXED_PROCESS_BINDING_MISMATCH'),
  @('child-executable-changed','OUTER_FIXED_PROCESS_BINDING_MISMATCH'),
  @('child-relative-executable','OUTER_FIXED_PROCESS_BINDING_MISMATCH'),
  @('child-command-changed','OUTER_COLD_REPLACEMENT_CHILD_UNPROVEN'),
  @('child-born-before-exit','OUTER_COLD_REPLACEMENT_CHILD_UNPROVEN'),
  @('desktop-time-without-zone','OUTER_COLD_REPLACEMENT_CHILD_UNPROVEN'),
  @('foreign-listener-12001','OUTER_LISTENER_FOREIGN_OWNER'),
  @('foreign-listener-12002','OUTER_LISTENER_FOREIGN_OWNER'),
  @('foreign-listener-12003','OUTER_LISTENER_FOREIGN_OWNER'),
  @('occupied-probe-port','OUTER_PROBE_PORT_NOT_RELEASED'),
  @('non-loopback-listener','OUTER_LISTENER_FOREIGN_OWNER'),
  @('owned-listener-before-metadata-retries',''),
  @('known-foreign-listener','OUTER_LISTENER_FOREIGN_OWNER')
)
$Results=@()
foreach($Row in $Cases){
  $script:Case=$Row[0];$script:RuntimeReads=0;$script:ListenerReads=0;$script:StatusReads=0;$script:Sleeps=0;$script:Saves=0;$script:ProcessQueries=@();$script:OldStillPresent=$false;$script:ColdStopBinding=$null
  $Installed=Join-Path $Root 'installed'
  $Proxy=[pscustomobject]@{pid=101;parentPid=50;executablePath='C:\\fixed\\node.exe';commandLine=('node '+(Join-Path $Installed 'src/codex-app-server-proxy-runner.mjs')+' '+(Join-Path $Root 'state/codex-app-server-proxy-runtime.json'));createdAt='2026-10-11T10:00:00.0000000Z'}
  $Child=[pscustomobject]@{pid=202;parentPid=101;executablePath='C:\\fixed\\codex.exe';commandLine='C:\\fixed\\codex.exe app-server';createdAt='2026-10-11T10:20:00.0000000Z'}
  $Expected=[pscustomobject]@{instanceToken='fixed-original-token';proxy=$Proxy;child=$Child}
  $Plan=@{executionProfile='OwnerColdFirstAdoption';sampleRoot=$null;stopIdentity=$Expected;dataRoot=$Root;installedRoot=$Installed;node=@{path=$Proxy.executablePath};startup=@{CodexExecutablePath=$Child.executablePath;DownstreamPort=12001;ControlPort=12002;UpstreamPort=12003;ProbePort=12004};runtimeBundle=@{files=@()};attemptId='isolated-attempt'}
  $Window=@{acceptsOwnedDesktopEmptyRestart=$true;acceptsShortInterruption=$true;acceptsLegacyRequestCounterLimit=$true;desktopExitSha256='isolated-desktop-proof'}
  $DesktopExit=[pscustomobject]@{observedAt='2026-10-11T10:21:53.0000000Z';processesEnded=$true;rootExitCode=0}
  $PlanSha256='isolated-plan';$Attempt=[ordered]@{}
  $Replacement=Copy-Identity $Child;$Replacement.pid=302;$Replacement.createdAt='2026-10-11T10:21:55.0000000Z'
  $Alternate=Copy-Identity $Replacement;$Alternate.pid=303
  $script:Identities=@{101=(Copy-Identity $Proxy);202=(Copy-Identity $Child);302=$Replacement;303=$Alternate}
  $script:Runtime=[pscustomobject]@{state='running';instanceToken=$Expected.instanceToken;pid=101;appServerPid=302;executablePath=$Child.executablePath;controlUrl='http://127.0.0.1:12002';upstreamUrl='ws://127.0.0.1:12003'}
  $Name='original-stop';$ExpectedPid=302
  switch($script:Case){
    'original-child-kept' {$script:Runtime.appServerPid=202;$ExpectedPid=202}
    'birth-equals-desktop-exit' {$Replacement.createdAt=$DesktopExit.observedAt}
    'non-original-unchanged' {$Name='candidate-stop';$script:Runtime.appServerPid=202;$ExpectedPid=202}
    'ordinary-profile-unchanged' {$Plan.executionProfile='WarmAdoption';$script:Runtime.appServerPid=202;$ExpectedPid=202}
    'non-original-drift' {$Name='candidate-stop'}
    'ordinary-profile-drift' {$Plan.executionProfile='WarmAdoption'}
    'sample-root-drift' {$Plan.sampleRoot=$Root}
    'missing-desktop-exit' {$DesktopExit=$null}
    'flag-false' {$Window.acceptsOwnedDesktopEmptyRestart=$false}
    'flag-missing' {$Window.Remove('acceptsOwnedDesktopEmptyRestart')}
    'token-changed' {$script:Runtime.instanceToken='changed-token'}
    'proxy-pid-changed' {$Changed=Copy-Identity $Proxy;$Changed.pid=111;$script:Identities[111]=$Changed;$script:Runtime.pid=111}
    'proxy-parent-changed' {$script:Identities[101].parentPid=51}
    'proxy-executable-changed' {$script:Identities[101].executablePath='C:\\other\\node.exe'}
    'proxy-command-changed' {$script:Identities[101].commandLine+=' --changed'}
    'proxy-birth-changed' {$script:Identities[101].createdAt='2026-10-11T10:00:01.0000000Z'}
    'old-child-still-present' {$script:OldStillPresent=$true}
    'same-child-pid-identity-changed' {$script:Runtime.appServerPid=202;$script:Identities[202].createdAt=$Replacement.createdAt}
    'child-parent-changed' {$Replacement.parentPid=999}
    'child-executable-changed' {$Replacement.executablePath='C:\\other\\codex.exe'}
    'child-relative-executable' {$Replacement.executablePath='codex.exe'}
    'child-command-changed' {$Replacement.commandLine+=' --changed'}
    'child-born-before-exit' {$Replacement.createdAt='2026-10-11T10:21:52.0000000Z'}
    'desktop-time-without-zone' {$DesktopExit.observedAt='2026-10-11T10:21:53'}
    'owned-listener-before-metadata-retries' {$script:Runtime.appServerPid=202}
    'known-foreign-listener' {$Foreign=Copy-Identity $Replacement;$Foreign.pid=999;$Foreign.parentPid=888;$script:Identities[999]=$Foreign}
  }
  $Failure='';$Resolved=$null
  try{$Resolved=Resolve-OwnerColdStopIdentity $Expected $Name}catch{$Failure=$_.Exception.Message}
  $Passed=$Failure -ceq $Row[1]
  if(-not $Failure){$Passed=$Passed -and $Resolved.child.pid -eq $ExpectedPid -and $Resolved.instanceToken -ceq $Expected.instanceToken -and ($Resolved.proxy|ConvertTo-Json -Compress) -ceq ($Expected.proxy|ConvertTo-Json -Compress) -and $script:StatusReads -ge 1}
  if($script:Case -in @('listener-gap-retries','identity-drift-retries','resample-drift-retries','owned-listener-before-metadata-retries')){$Passed=$Passed -and $script:Sleeps -ge 1 -and $script:RuntimeReads -ge 4}
  if(-not $Failure -and $ExpectedPid -eq 302){$Passed=$Passed -and $null -ne $script:ColdStopBinding -and $script:ColdStopBinding.original.child.pid -eq 202 -and $script:ColdStopBinding.observed.child.pid -eq 302}
  if($script:Case -like 'foreign-listener-*' -or $script:Case -in @('occupied-probe-port','non-loopback-listener','known-foreign-listener')){$Passed=$Passed -and $script:ListenerReads -ge 1 -and $script:Sleeps -eq 0}
  $Results+=@([pscustomobject]@{name=$script:Case;passed=[bool]$Passed;expectedFailure=$Row[1];actualFailure=$Failure;resolvedPid=$(if($Resolved){$Resolved.child.pid}else{$null});runtimeReads=$script:RuntimeReads;listenerReads=$script:ListenerReads;statusReads=$script:StatusReads;sleeps=$script:Sleeps})
}
$ContractItems=@()
foreach($Index in 1..20){
  $Target=Join-Path $Root ('original-'+$Index+'.txt')
  [IO.File]::WriteAllText($Target,('isolated-original-'+$Index))
  $ContractItems+=@([pscustomobject]@{target=$Target;original=[pscustomobject]@{exists=$true;sha256=(Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant();sddl='isolated-original-acl';attributes=[int](Get-Item -LiteralPath $Target -Force).Attributes}})
}
$script:Contract=[pscustomobject]@{items=$ContractItems}
$Plan.transaction=@{contractRoot=(Join-Path $Root 'contract')};$Plan.candidateRoot=Join-Path $Root 'candidate';$Plan.ownerId='isolated-owner'
$PlanPath=Join-Path $Root 'plan.json';$Action='ExecuteWindow'
$RuntimeBaseline=Copy-Identity $script:Runtime
$PreserveCases=@(
  @('preserve-success','', $true),
  @('preserve-phase','', $false),
  @('preserve-commands','', $false),
  @('preserve-stop-lease','', $false),
  @('preserve-stop-evidence','', $false),
  @('preserve-marker-consumption','', $false),
  @('preserve-candidate-created','', $false),
  @('preserve-candidate-identity','', $false),
  @('preserve-candidate-launch','', $false),
  @('preserve-stop-proof','', $false),
  @('preserve-candidate-directory','', $false),
  @('preserve-stop-marker','', $false),
  @('preserve-transaction-attempt','', $false),
  @('preserve-hash-drift','OUTER_ORIGINAL_BASELINE_CHANGED', $false),
  @('preserve-acl-drift','OUTER_ORIGINAL_BASELINE_CHANGED', $false),
  @('preserve-cold-identity-drift','OUTER_COLD_PROXY_IDENTITY_CHANGED', $false)
)
foreach($Row in $PreserveCases){
  $script:Case=$Row[0];$script:Runtime=Copy-Identity $RuntimeBaseline;$script:RuntimeReads=0;$script:ListenerReads=0;$script:StatusReads=0;$script:Sleeps=0;$script:Saves=0;$script:HashReads=0;$script:AclReads=0;$script:ColdStopBinding=$null;$StopLease=$null
  $Attempt=[ordered]@{phase='claim';status='failed';commands=@()};$Result=[ordered]@{}
  switch($script:Case){
    'preserve-phase' {$Attempt.phase='apply'}
    'preserve-commands' {$Attempt.commands=@([pscustomobject]@{name='already-executed'})}
    'preserve-stop-lease' {$StopLease=[pscustomobject]@{OperationId='isolated-lease'}}
    'preserve-stop-evidence' {$Attempt.stopEvidence=[pscustomobject]@{path='isolated-evidence'}}
    'preserve-marker-consumption' {$Attempt.stopMarkerConsumption=[pscustomobject]@{State='Consumed'}}
    'preserve-candidate-created' {$Attempt.candidateDirectoryCreated=$true}
    'preserve-candidate-identity' {$Attempt.candidateIdentity=[pscustomobject]@{pid=777}}
    'preserve-candidate-launch' {$Attempt.candidateLaunch=[pscustomobject]@{pid=777}}
    'preserve-cold-identity-drift' {$script:Runtime.instanceToken='changed-token'}
  }
  $Failure='';$Preserved=$false
  try{$Preserved=Preserve-OriginalBeforeStop}catch{$Failure=$_.Exception.Message}
  $Passed=$Failure -ceq $Row[1] -and [bool]$Preserved -eq $Row[2]
  if($Row[2]){
    $Passed=$Passed -and $Attempt.status -ceq 'failed-original-preserved' -and $Attempt.phase -ceq 'original-baseline-preserved' -and $Result.status -ceq 'failed-original-preserved' -and $Result.originalStateVerified -eq $true -and $Attempt.preservedIdentity.child.pid -eq 302 -and $Result.preservedIdentity.child.pid -eq 302 -and $Result.preservedPlanSha256 -ceq $PlanSha256 -and $Result.preservedOwnerId -ceq $Plan.ownerId -and $Result.preservedAttemptId -ceq $Plan.attemptId -and $script:Saves -eq 1 -and $script:HashReads -eq 20 -and $script:AclReads -eq 20 -and $script:StatusReads -ge 1
  }else{
    $Passed=$Passed -and $script:Saves -eq 0 -and $Attempt.status -ceq 'failed' -and -not $Result.originalStateVerified
    if(-not $Row[1]){$Passed=$Passed -and $script:HashReads -eq 0 -and $script:AclReads -eq 0 -and $script:RuntimeReads -eq 0}
  }
  $Results+=@([pscustomobject]@{name=$script:Case;passed=[bool]$Passed;expectedFailure=$Row[1];actualFailure=$Failure;preserved=[bool]$Preserved;hashReads=$script:HashReads;aclReads=$script:AclReads;runtimeReads=$script:RuntimeReads;statusReads=$script:StatusReads;saves=$script:Saves})
}
[pscustomobject]@{sourceSha256=${literal(sourceSha256)};ranges=$Ranges;productionModified=$false;cases=$Results}|ConvertTo-Json -Depth 15 -Compress
`, 'utf8');
  const shell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', driver], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  fs.writeFileSync(path.join(root, 'driver.log'), `${result.stdout}\n${result.stderr}`, 'utf8');
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\ndriver=${driver}`);
  const evidence = JSON.parse(result.stdout.trim());
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  context.diagnostic(`sourceSha256=${sourceSha256}; evidence=${evidencePath}; functions=${JSON.stringify(evidence.ranges)}`);
  assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceSha256, 'source changed during AST test');
  assert.equal(evidence.cases.length, 51);
  assert.equal(evidence.productionModified, false);
  for (const resultCase of evidence.cases) {
    await context.test(resultCase.name, () => assert.equal(resultCase.passed, true, JSON.stringify(resultCase)));
  }
});
