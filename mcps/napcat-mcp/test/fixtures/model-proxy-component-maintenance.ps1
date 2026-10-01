[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RuntimeSourceRoot,
  [Parameter(Mandatory)][string]$OperatorPath,
  [string]$NodePath='',
  [string]$InvocationPath='',
  [string[]]$Scenarios=@('busy-then-idle','preparation-failure-after-stop','startup-failure','release-drift'),
  [string]$OutputRoot=''
)
$ErrorActionPreference='Stop'
$RuntimeSourceRoot=[IO.Path]::GetFullPath($RuntimeSourceRoot)
$OperatorPath=[IO.Path]::GetFullPath($OperatorPath)
if([string]::IsNullOrWhiteSpace($OutputRoot)){$OutputRoot=Join-Path $env:TEMP ('model-proxy-maintenance-'+[guid]::NewGuid().ToString('N'))}
$OutputRoot=[IO.Path]::GetFullPath($OutputRoot)
if(-not $OutputRoot.StartsWith(([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture output must be inside TEMP'}
if(Test-Path -LiteralPath $OutputRoot){throw 'Fixture output root must be fresh'}
New-Item -ItemType Directory -Path $OutputRoot|Out-Null
$Node=if([string]::IsNullOrWhiteSpace($NodePath)){(Get-Command node.exe -ErrorAction Stop).Source}else{[IO.Path]::GetFullPath($NodePath)}
if(-not(Test-Path -LiteralPath $Node -PathType Leaf)){throw 'Fixture Node executable missing'}
$NodeVersion=& $Node --version
if(-not [string]::IsNullOrWhiteSpace($InvocationPath)){$InvocationPath=[IO.Path]::GetFullPath($InvocationPath)}
$env:CODEX_TOOLKIT_NODE_EXE=$Node
$Utf8=[Text.UTF8Encoding]::new($false)
$Files=@('src\codex-model-stream-proxy.mjs','src\adaptive-delivery.mjs','src\request-wait-budget.mjs','src\request-body-buffer.mjs','src\request-body-inspector.mjs')
$ParseTokens=$null;$ParseErrors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($OperatorPath,[ref]$ParseTokens,[ref]$ParseErrors)
if($ParseErrors){throw 'Operator parser failure'}
$Normalizer=$Ast.Find({param($AstNode)$AstNode -is [Management.Automation.Language.FunctionDefinitionAst] -and $AstNode.Name -ceq 'Normalize-Acl'},$true)
. ([scriptblock]::Create($Normalizer.Extent.Text))
function Snapshot([string]$Code){
  @(foreach($Relative in $Files){$Target=Join-Path $Code $Relative;@{relative=$Relative;sha=(Get-FileHash -LiteralPath $Target).Hash;acl=(Normalize-Acl (Get-Acl -LiteralPath $Target).Sddl)}})
}
function Assert-Original([string]$Code,$Before){
  $After=Snapshot $Code
  for($Index=0;$Index -lt $Before.Count;$Index++){if($Before[$Index].sha -cne $After[$Index].sha -or $Before[$Index].acl -cne $After[$Index].acl){throw 'Original target bytes or ACL changed'}}
}
function Invoke-Business([int]$Port,[string]$Version){
  $Health=Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
  if($Health.implementationVersion -cne $Version){throw 'Business version mismatch'}
  $Response=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/v1/responses" -Method Post -ContentType 'application/json' -Body '{"model":"owned-fixture","input":[],"stream":true}' -TimeoutSec 8
  if($Response.StatusCode -ne 200 -or $Response.Content -notmatch 'MAINTENANCE_FIXTURE_OK' -or $Response.Content -notmatch 'response.completed'){throw 'Loopback business failed'}
  @{version=$Version;pid=$Health.pid;completed=$true}
}
function Assert-Released([string]$Data){
  if(Test-Path -LiteralPath (Join-Path $Data 'state\codex-model-stream-proxy.maintenance.json')){throw 'Maintenance lease retained'}
  if(Test-Path -LiteralPath (Join-Path $Data 'state\codex-model-stream-proxy.stop')){throw 'Stop marker retained'}
}
function Invoke-ComponentOperator([string]$Operation,[hashtable]$OperationArguments,[string]$OperationLog){
  if([string]::IsNullOrWhiteSpace($InvocationPath)){
    & $OperatorPath -Action $Operation @OperationArguments|Out-File -LiteralPath $OperationLog -Encoding UTF8
    return
  }
  $InputParameters=$OperationArguments.Clone()
  $InputParameters.Action=$Operation
  $InputPath=$OperationLog+'.parameters.json'
  [IO.File]::WriteAllText($InputPath,($InputParameters|ConvertTo-Json -Depth 8),$Utf8)
  $RunDirectory=$OperationLog+'.stage-'+[guid]::NewGuid().ToString('N')
  $PowerShellName=if($PSVersionTable.PSEdition -eq 'Core'){'pwsh.exe'}else{'powershell.exe'}
  $PowerShell=Join-Path $PSHOME $PowerShellName
  & $PowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $InvocationPath -ScriptPath $OperatorPath -ScriptSha256 (Get-FileHash -LiteralPath $OperatorPath).Hash -ParametersPath $InputPath -RunDirectory $RunDirectory -TimeoutMilliseconds 60000|Out-File -LiteralPath $OperationLog -Encoding UTF8
  $InvocationExit=$LASTEXITCODE
  $StageResult=Get-Content -LiteralPath (Join-Path $RunDirectory 'stage-result.json') -Encoding UTF8 -Raw|ConvertFrom-Json
  if($InvocationExit -ne 0 -or -not $StageResult.completed -or -not $StageResult.processSucceeded){
    $ChildLog=Get-Content -LiteralPath $StageResult.logPath -Encoding UTF8 -Raw -ErrorAction SilentlyContinue
    throw ('Independent operator invocation failed: '+$StageResult.state+'; '+$ChildLog)
  }
}
$Results=@()
foreach($Scenario in $Scenarios){
  Write-Output ('SCENARIO_START='+$Scenario)
  $Branch=Join-Path $OutputRoot $Scenario
  $Code=Join-Path $Branch 'code';$Candidate=Join-Path $Branch 'candidate';$Data=Join-Path $Branch 'data';$Backup=Join-Path $Branch 'backup'
  New-Item -ItemType Directory -Path $Code,(Join-Path $Candidate 'src'),(Join-Path $Data 'state'),$Backup|Out-Null
  Copy-Item -LiteralPath (Join-Path $RuntimeSourceRoot 'src'),(Join-Path $RuntimeSourceRoot 'ops') -Destination $Code -Recurse
  foreach($Relative in $Files){Copy-Item -LiteralPath (Join-Path $Code $Relative) -Destination (Join-Path $Candidate $Relative)}
  $Core=Join-Path $Code 'src\codex-model-stream-proxy.mjs'
  $CoreText=[IO.File]::ReadAllText($Core)
  $VersionMatch=[regex]::Match($CoreText,'const IMPLEMENTATION_VERSION = "([0-9.\-]+)";')
  if(-not $VersionMatch.Success){throw 'Fixture runtime implementation version not found'}
  $OldVersion=$VersionMatch.Groups[1].Value
  $VersionParts=$OldVersion.Split('.')
  $NewVersion=$VersionParts[0]+'.'+([int]$VersionParts[1]+1)
  $CandidateCore=[regex]::Replace($CoreText,'const IMPLEMENTATION_VERSION = "([0-9.\-]+)";',('const IMPLEMENTATION_VERSION = "'+$NewVersion+'";'))
  [IO.File]::WriteAllText((Join-Path $Candidate 'src\codex-model-stream-proxy.mjs'),$CandidateCore,$Utf8)
  $ReleasePath=Join-Path $Candidate 'release.json'
  $Release=@{schema=1;implementationVersion=$NewVersion;files=$Files;maxBufferedRequestMiB=128;maxDecodedRequestMiB=192}|ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText($ReleasePath,$Release,$Utf8)
  $Before=Snapshot $Code
  $Before|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $Branch 'before.json') -Encoding UTF8
  $Listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$Listener.Start();$Port=$Listener.LocalEndpoint.Port;$Listener.Stop()
  $Info=[Diagnostics.ProcessStartInfo]::new();$Info.FileName=$Node;$Info.Arguments='"'+(Join-Path $PSScriptRoot 'model-proxy-maintenance-upstream.mjs')+'"';$Info.UseShellExecute=$false;$Info.CreateNoWindow=$true;$Info.RedirectStandardOutput=$true;$Info.RedirectStandardInput=$true
  $Upstream=[Diagnostics.Process]::Start($Info);$null=$Upstream.Handle
  $UpstreamPort=[int]$Upstream.StandardOutput.ReadLine()
  $Parameters=@{CodeRoot=$Code;CandidateRoot=$Candidate;DataRoot=$Data;BackupRoot=$Backup;Port=$Port;NodePath=$Node}
  $Start=Join-Path $Code 'ops\start-codex-model-stream-proxy.ps1';$Stop=Join-Path $Code 'ops\stop-codex-model-stream-proxy.ps1'
  $HoldClient=$null
  try{
    & $Start -DataRoot $Data -Port $Port -UpstreamOrigin "http://127.0.0.1:$UpstreamPort"|Out-File -LiteralPath (Join-Path $Branch 'old-start.log') -Encoding UTF8
    $OldBusiness=Invoke-Business $Port $OldVersion
    Invoke-ComponentOperator 'Prepare' $Parameters (Join-Path $Branch 'prepare.log')
    $BackupBefore=@(Get-ChildItem -LiteralPath $Backup -File|ForEach-Object {$_.Name+':'+(Get-FileHash -LiteralPath $_.FullName).Hash}) -join '|'
    Invoke-ComponentOperator 'Inspect' $Parameters (Join-Path $Branch 'inspect.log')
    $BackupAfter=@(Get-ChildItem -LiteralPath $Backup -File|ForEach-Object {$_.Name+':'+(Get-FileHash -LiteralPath $_.FullName).Hash}) -join '|'
    if($BackupBefore -cne $BackupAfter){throw 'Inspect changed prepared backup state'}
    $Failure=$null
    $ApplyParameters=$Parameters.Clone();$ApplyParameters.CoordinatedWindow=$true
    if($Scenario -eq 'busy-then-idle'){
      $ClientInfo=[Diagnostics.ProcessStartInfo]::new();$ClientInfo.FileName=$Node;$ClientInfo.Arguments='"'+(Join-Path $PSScriptRoot 'model-proxy-maintenance-hold-client.mjs')+'" '+$Port;$ClientInfo.UseShellExecute=$false;$ClientInfo.CreateNoWindow=$true
      $HoldClient=[Diagnostics.Process]::Start($ClientInfo);$null=$HoldClient.Handle
      $BusyDeadline=[DateTimeOffset]::UtcNow.AddSeconds(5)
      while((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3).activeRequests -eq 0){if([DateTimeOffset]::UtcNow -gt $BusyDeadline){throw 'Owned request did not become busy'};Start-Sleep -Milliseconds 100}
      try{Invoke-ComponentOperator 'Apply' $ApplyParameters (Join-Path $Branch 'busy.log')}catch{$Failure=$_.Exception.Message;$_|Out-String|Out-File -LiteralPath (Join-Path $Branch 'busy-error.log') -Encoding UTF8}
      if($Failure -notmatch 'Busy model proxy'){throw 'Expected real busy refusal missing'}
      Assert-Original $Code $Before
      Assert-Released $Data
      if(@(Get-ChildItem -LiteralPath $Backup -Filter 'intent-*').Count -ne 0 -or @(Get-ChildItem -LiteralPath (Join-Path $Code 'src') -Filter '*.tmp').Count -ne 0){throw 'Busy refusal left replacement intents or stages'}
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$UpstreamPort/release" -TimeoutSec 3|Out-Null
      if(-not $HoldClient.WaitForExit(5000) -or $HoldClient.ExitCode -ne 0){throw 'Owned hold client failed to complete'}
      $Failure=$null
      $StopRefusalParameters=$ApplyParameters.Clone();$StopRefusalParameters.InjectStopRefusal=$true
      try{Invoke-ComponentOperator 'Apply' $StopRefusalParameters (Join-Path $Branch 'last-stop-refusal.log')}catch{$Failure=$_.Exception.Message}
      if($Failure -notmatch 'INJECTED_STOP_REFUSAL' -or @(Get-ChildItem -LiteralPath $Backup -Filter 'intent-*').Count -ne 0){throw 'Final stop refusal left replacement state'}
      Assert-Original $Code $Before
      Assert-Released $Data
      Invoke-ComponentOperator 'Apply' $ApplyParameters (Join-Path $Branch 'apply.log')
      $CandidateBusiness=Invoke-Business $Port $NewVersion
      Assert-Released $Data
      Invoke-ComponentOperator 'Rollback' $ApplyParameters (Join-Path $Branch 'rollback.log')
    }elseif($Scenario -eq 'release-drift'){
      [IO.File]::AppendAllText($ReleasePath,[Environment]::NewLine,$Utf8)
      try{Invoke-ComponentOperator 'Apply' $ApplyParameters (Join-Path $Branch 'drift.log')}catch{$Failure=$_.Exception.Message}
      if($Failure -notmatch 'Release input changed after Prepare'){throw 'Release identity drift was not refused'}
      Assert-Original $Code $Before
      Assert-Released $Data
      if(@(Get-ChildItem -LiteralPath $Backup -Filter 'intent-*').Count -ne 0){throw 'Release drift left intents'}
    }else{
      $Fault=@{}
      if($Scenario -eq 'preparation-failure-after-stop'){$Fault.InjectIntentWriteFailure=$true;$ExpectedFailure='INJECTED_INTENT_WRITE_FAILURE'}
      elseif($Scenario -eq 'startup-failure'){$Fault.InjectFailureAfterStart=$true;$ExpectedFailure='INJECTED_AFTER_START_FAILURE'}
      else{throw 'Unknown fixture scenario'}
      foreach($FaultKey in $Fault.Keys){$ApplyParameters[$FaultKey]=$Fault[$FaultKey]}
      try{Invoke-ComponentOperator 'Apply' $ApplyParameters (Join-Path $Branch 'apply.log')}catch{$Failure=$_.Exception.Message;$_|Out-String|Out-File -LiteralPath (Join-Path $Branch 'apply-error.log') -Encoding UTF8}
      if($Failure -notmatch $ExpectedFailure){throw 'Expected transaction failure missing'}
      $Transition=Get-Content -LiteralPath (Join-Path $Backup 'transition.json') -Encoding UTF8 -Raw|ConvertFrom-Json
      if($Transition.state -cne 'rolled_back'){throw 'Failed transaction did not complete restoration'}
    }
    $RestoredBusiness=Invoke-Business $Port $OldVersion
    Assert-Original $Code $Before
    Assert-Released $Data
    $Results+=@{scenario=$Scenario;passed=$true;expectedFailure=$Failure;old=$OldBusiness;restored=$RestoredBusiness;targetBytesAndAclRestored=$true;leaseReleased=$true}
  }finally{
    if($HoldClient -and -not $HoldClient.HasExited){Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$UpstreamPort/release" -TimeoutSec 3|Out-Null;if(-not $HoldClient.WaitForExit(5000)){throw 'Owned hold client did not exit normally'}}
    & $Stop -DataRoot $Data -TimeoutSeconds 10|Out-File -LiteralPath (Join-Path $Branch 'final-stop.log') -Encoding UTF8
    $Upstream.StandardInput.Close()
    if(-not $Upstream.WaitForExit(5000)){throw 'Owned upstream did not exit normally'}
    $Upstream.Dispose()
    if($HoldClient){$HoldClient.Dispose()}
  }
  Write-Output ('SCENARIO_PASSED='+$Scenario)
}
$Result=@{root=$OutputRoot;passed=$true;powerShellVersion=$PSVersionTable.PSVersion.ToString();nodeVersion=$NodeVersion;nodePath=$Node;invocationPath=$InvocationPath;operatorSha=(Get-FileHash -LiteralPath $OperatorPath).Hash;helperSha=(Get-FileHash -LiteralPath (Join-Path (Split-Path $OperatorPath) 'model-proxy-recovery-intent.ps1')).Hash;results=$Results;scope='owned TEMP actual runtime, original PowerShell startup and stop, controlled loopback, no production writes'}
$Result|ConvertTo-Json -Depth 8|Tee-Object -FilePath (Join-Path $OutputRoot 'result.json')
