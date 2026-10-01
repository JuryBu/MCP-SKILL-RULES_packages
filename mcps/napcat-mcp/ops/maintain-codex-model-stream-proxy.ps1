[CmdletBinding()]
param(
  [ValidateSet('Prepare','Inspect','Apply','Rollback')][string]$Action = 'Prepare',
  [Parameter(Mandatory)][string]$CodeRoot,
  [Parameter(Mandatory)][string]$CandidateRoot,
  [Parameter(Mandatory)][string]$DataRoot,
  [Parameter(Mandatory)][string]$BackupRoot,
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$NodePath,
  [string]$ReleasePath = '',
  [switch]$CoordinatedWindow,
  [switch]$InjectFailureAfterStart,
  [switch]$InjectJournalFailure,
  [switch]$InjectRollbackFailure,
  [switch]$InjectStopRefusal,
  [switch]$InjectAclRestoreFailure,
  [ValidateSet('codex-model-stream-proxy.mjs','request-wait-budget.mjs')][string]$InjectPauseAfterApplyLeaf,
  [switch]$InjectPauseDuringRestoreCore,
  [switch]$InjectIntentWriteFailure,
  [switch]$VerifyLoopbackBusiness
)
$ErrorActionPreference = 'Stop'
if($InjectAclRestoreFailure){throw 'Unsupported ACL restore failure injection; refusing before transaction'}
$Utf8 = [Text.UTF8Encoding]::new($false)
$CodeRoot = [IO.Path]::GetFullPath($CodeRoot)
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$BackupRoot = [IO.Path]::GetFullPath($BackupRoot)
$StateRoot = Join-Path $DataRoot 'state'
$PlanPath = Join-Path $BackupRoot 'plan.json'
$LeasePath = Join-Path $StateRoot 'codex-model-stream-proxy.maintenance.json'
$ProfilePath = Join-Path $StateRoot 'codex-model-adaptive-delivery.json'
if([string]::IsNullOrWhiteSpace($ReleasePath)){$ReleasePath=Join-Path $CandidateRoot 'release.json'}
$ReleasePath=[IO.Path]::GetFullPath($ReleasePath)
if(-not $ReleasePath.StartsWith(($CandidateRoot.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Release input must be inside the candidate root'}
$AllowedFiles=@('src\codex-model-stream-proxy.mjs','src\adaptive-delivery.mjs','src\request-wait-budget.mjs','src\request-body-buffer.mjs','src\request-body-inspector.mjs')
if($Action -eq 'Rollback'){
  $ScopePlan=Get-Content -LiteralPath $PlanPath -Encoding UTF8 -Raw|ConvertFrom-Json
  $Files=@($ScopePlan.files|ForEach-Object {[string]$_.relative})
}else{
  $Release=Get-Content -LiteralPath $ReleasePath -Encoding UTF8 -Raw|ConvertFrom-Json
  if($Release.schema -ne 1 -or $Release.implementationVersion -notmatch '^\d{4}-\d{2}-\d{2}\.\d+$'){throw 'Invalid release schema or implementation version'}
  $Files=@($Release.files)
  foreach($CapacityField in @('maxBufferedRequestMiB','maxDecodedRequestMiB')){
    $Capacity=$Release.$CapacityField
    if($Capacity -isnot [int] -and $Capacity -isnot [long]){throw 'Release capacity must be an integer MiB value'}
    if($Capacity -lt 1 -or $Capacity -gt 256){throw 'Release capacity must be between 1 and 256 MiB'}
  }
}
if($Files.Count -eq 0 -or $Files.Count -gt $AllowedFiles.Count -or @($Files|Select-Object -Unique).Count -ne $Files.Count){throw 'Invalid or duplicate release target scope'}
foreach($Relative in $Files){if($Relative -isnot [string] -or $Relative -cnotin $AllowedFiles){throw 'Unsupported release target scope'}}
$NodePath = [IO.Path]::GetFullPath($NodePath)
if(-not(Test-Path -LiteralPath $NodePath -PathType Leaf)){throw 'Node executable is missing'}
$env:CODEX_TOOLKIT_NODE_EXE = $NodePath
foreach($Location in @($CodeRoot,$CandidateRoot,$DataRoot,$BackupRoot)){
  $Existing=$Location
  while(-not(Test-Path -LiteralPath $Existing)){$Existing=[IO.Path]::GetDirectoryName($Existing)}
  $Ancestor=Get-Item -LiteralPath $Existing
  while($Ancestor){if($Ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse paths are not allowed'};$Ancestor=$Ancestor.Parent}
}
foreach($OtherRoot in @($CodeRoot,$CandidateRoot,$DataRoot)){
  if($BackupRoot -ieq $OtherRoot -or $BackupRoot.StartsWith(($OtherRoot.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase) -or $OtherRoot.StartsWith(($BackupRoot.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Backup root must be independent of code, candidate and data roots'}
}
function Hash-File([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Test-OwnerToken($Value){$Value -is [string] -and $Value -cmatch '^[0-9a-f]{32}$'}
function Normalize-Acl([string]$Sddl) {
  $Descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  $Flags=[Security.AccessControl.ControlFlags]([int]$Descriptor.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
  $Descriptor.SetFlags($Flags)
  $Acl=$Descriptor.DiscretionaryAcl
  if($Acl -and @($Acl|Where-Object {$_.AceType -ne [Security.AccessControl.AceType]::AccessAllowed}).Count -eq 0){
    $AceRows=@(foreach($Ace in $Acl){$Bytes=New-Object byte[] $Ace.BinaryLength;$Ace.GetBinaryForm($Bytes,0);[Convert]::ToBase64String($Bytes)})
    $Sorted=[Security.AccessControl.RawAcl]::new($Acl.Revision,$Acl.Count)
    foreach($Row in @($AceRows|Sort-Object)){$Sorted.InsertAce($Sorted.Count,[Security.AccessControl.GenericAce]::CreateFromBinaryForm([Convert]::FromBase64String($Row),0))}
    $Descriptor.DiscretionaryAcl=$Sorted
  }
  $Descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}
function Assert-SafePath([string]$Path) {
  $Current=[IO.Path]::GetFullPath($Path)
  while($Current){
    $Item=Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
    if($Item){
      if($Item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Reparse target path refused: '+$Current)}
      if(-not [string]::IsNullOrEmpty([string]$Item.LinkType)){throw ('Linked target refused: '+$Current)}
    }
    $Parent=[IO.Path]::GetDirectoryName($Current)
    if($Parent -eq $Current){break}
    $Current=$Parent
  }
}
foreach($Root in @($CodeRoot,$CandidateRoot,$BackupRoot)){
  Assert-SafePath (Join-Path $Root 'src')
  foreach($Relative in $Files){Assert-SafePath (Join-Path $Root $Relative)}
}
foreach($Relative in @('ops\start-codex-model-stream-proxy.ps1','ops\stop-codex-model-stream-proxy.ps1','ops\resolve-napcat-data-root.ps1')){Assert-SafePath (Join-Path $CodeRoot $Relative)}
foreach($Path in @($StateRoot,$PlanPath,$LeasePath,($LeasePath+'.operator-lock'),$ProfilePath,(Join-Path $BackupRoot 'history.jsonl'),(Join-Path $BackupRoot 'transition.json'),(Join-Path $BackupRoot 'lease-token.txt'),(Join-Path $BackupRoot 'adaptive-state.before.json'))){Assert-SafePath $Path}
function Assert-RuntimePaths {
  foreach($Leaf in @('codex-model-stream-proxy-runtime.json','codex-model-stream-proxy.lock.json','codex-model-stream-proxy.stop','codex-model-stream-proxy.jsonl','codex-model-stream-anomalies.jsonl','codex-model-stream-delivery-profiles.json','codex-model-adaptive-delivery.json')){Assert-SafePath (Join-Path $StateRoot $Leaf)}
}
Assert-RuntimePaths
Assert-SafePath $ReleasePath
function Write-Json([string]$Path,$Value){
  Assert-SafePath $Path
  $Stream=[IO.File]::Open($Path,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$Bytes=$Utf8.GetBytes(($Value|ConvertTo-Json -Depth 14));$Stream.Write($Bytes,0,$Bytes.Length);$Stream.Flush($true)}finally{$Stream.Dispose()}
}
$IntentHelper=Join-Path $PSScriptRoot 'model-proxy-recovery-intent.ps1'
Assert-SafePath $IntentHelper
. $IntentHelper
function Health { Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 }
function Journal([string]$State,$Details) {
  try {
  if($InjectJournalFailure){throw 'INJECTED_JOURNAL_FAILURE'}
  Assert-SafePath (Join-Path $BackupRoot 'history.jsonl')
  $Record=@{state=$State;at=[DateTimeOffset]::Now.ToString('o');details=$Details}
  [IO.File]::AppendAllText((Join-Path $BackupRoot 'history.jsonl'),(($Record|ConvertTo-Json -Depth 14 -Compress)+[Environment]::NewLine),$Utf8)
  Write-Json (Join-Path $BackupRoot 'transition.json') $Record
  } catch { Write-Warning "Journal unavailable; recovery is not gated by logging: $($_.Exception.Message)" -WarningAction Continue }
}
function Assert-Stopped {
  if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'Listener still exists; no replacement allowed'}
  $Runner=Join-Path $CodeRoot 'src\codex-model-stream-proxy-runner.mjs'
  $Live=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($Runner,[StringComparison]::OrdinalIgnoreCase) -ge 0})
  if($Live.Count -gt 0){throw 'Owned runner still exists; no replacement allowed'}
}
function Assert-Owner($Status) {
  $Runner = Join-Path $CodeRoot 'src\codex-model-stream-proxy-runner.mjs'
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Status.pid)"
  $Runtime = Get-Content -LiteralPath (Join-Path $StateRoot 'codex-model-stream-proxy-runtime.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  $Lock = Get-Content -LiteralPath (Join-Path $StateRoot 'codex-model-stream-proxy.lock.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  if (-not $Process -or -not $Process.CommandLine -or $Process.CommandLine.IndexOf($Runner,[StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Runner identity mismatch' }
  if(-not $Process.ExecutablePath -or [IO.Path]::GetFullPath($Process.ExecutablePath) -ine $NodePath){throw 'Running Node path mismatch'}
  if($Runtime.pid -ne $Status.pid -or $Lock.pid -ne $Status.pid -or $Runtime.instanceToken -cne $Status.instanceToken -or $Lock.instanceToken -cne $Status.instanceToken){throw 'Runtime/lock/health mismatch'}
}
function Stop-Current {
  Assert-RuntimePaths
  $Status = Health
  Assert-Owner $Status
  if($InjectStopRefusal){throw 'INJECTED_STOP_REFUSAL'}
  if($Status.activeRequests -ne 0 -or $Status.draining){throw 'Busy model proxy; no stop requested'}
  Start-Sleep -Milliseconds 500
  $Second = Health
  if($Second.pid -ne $Status.pid -or $Second.instanceToken -cne $Status.instanceToken -or $Second.activeRequests -ne 0 -or $Second.draining){throw 'Idle confirmation failed; no stop requested'}
  $script:StopRequested=$true
  $Stopped = & (Join-Path $CodeRoot 'ops\stop-codex-model-stream-proxy.ps1') -DataRoot $DataRoot -TimeoutSeconds 30 | ConvertFrom-Json
  if(-not $Stopped.clean -or -not $Stopped.stopped){throw 'Proxy did not stop cleanly'}
  Assert-Stopped
}
function Start-Current($Plan,[switch]$Candidate) {
  Assert-RuntimePaths
  $WireBytes=if($Candidate){$Plan.candidateWireBytes}else{$Plan.runtime.maxBufferedRequestBytes}
  $DecodedBytes=if($Candidate){$Plan.candidateDecodedBytes}else{$Plan.runtime.maxDecodedRequestBytes}
  $env:CODEX_MODEL_STREAM_PROXY_MAX_DECODED_REQUEST_BYTES=[string]$DecodedBytes
  $Parameters=@{DataRoot=$DataRoot;Port=$Port;MaintenanceToken=$LeaseToken;UpstreamOrigin=$Plan.runtime.upstreamOrigin;FirstProgressTimeoutSeconds=[int]($Plan.runtime.firstProgressTimeoutMs/1000);ProgressIdleTimeoutSeconds=[int]($Plan.runtime.progressIdleTimeoutMs/1000);CompactionAttemptTimeoutSeconds=[int]($Plan.runtime.compactionAttemptTimeoutMs/1000);MaxConsecutiveAttempts=[int]$Plan.runtime.maxConsecutiveAttempts;MaxBufferedRequestMiB=[int]($WireBytes/1MB)}
  if($Candidate){$Parameters.MaxDecodedRequestMiB=[int]($DecodedBytes/1MB)}
  & (Join-Path $CodeRoot 'ops\start-codex-model-stream-proxy.ps1') @Parameters | Out-Null
  $Status = Health
  Assert-Owner $Status
  if($Status.draining){throw 'Started proxy is draining'}
  $ExpectedVersion=if($Candidate){$Plan.candidateVersion}else{$Plan.runtime.implementationVersion}
  if($Status.implementationVersion -cne $ExpectedVersion){throw 'Started implementation version mismatch'}
  if($Status.maxBufferedRequestBytes -ne $WireBytes -or $Status.maxDecodedRequestBytes -ne $DecodedBytes){throw 'Request capacity verification failed'}
  foreach($Entry in $Plan.files){
    $Target=Join-Path $CodeRoot $Entry.relative
    if(-not $Candidate -and -not $Entry.existed){
      if(Test-Path -LiteralPath $Target){throw 'Originally absent module was not removed on rollback'}
      continue
    }
    $ExpectedHash=if($Candidate){$Entry.candidate}else{$Entry.previous}
    if((Hash-File $Target) -ne $ExpectedHash -or (Normalize-Acl (Get-Acl -LiteralPath $Target).Sddl) -cne (Normalize-Acl $Entry.sddl)){throw "File identity or ACL changed: $($Entry.relative)"}
  }
  return $Status
}
function Restore-Files($Plan) {
  Assert-AllRecoveryTargets
  foreach($Entry in $Plan.files){
    $Target = Join-Path $CodeRoot $Entry.relative
    Assert-SafePath $Target
    Assert-SafePath (Join-Path $BackupRoot $Entry.relative)
    if($Entry.existed){
      if((Hash-File $Target) -ceq $Entry.previous -and (Normalize-Acl (Get-Acl -LiteralPath $Target).Sddl) -ceq (Normalize-Acl $Entry.sddl)){continue}
      Replace-WithIntent 'restore' $Entry (Join-Path $BackupRoot $Entry.relative)
    }elseif(Test-Path -LiteralPath $Target){
      $Quarantine=Read-Intent 'quarantine' $Entry
      if(-not $Quarantine){
        $QuarantinePath=Join-Path $BackupRoot ('quarantined-'+[IO.Path]::GetFileName($Target)+'-'+[guid]::NewGuid().ToString('N'))
        $ApplyIntent=Read-Intent 'apply' $Entry
        $Quarantine=Write-Intent 'quarantine' $Entry $QuarantinePath (File-Identity $Target) (Hash-File $Target) (File-Identity $Target) ([bool]$ApplyIntent.fixtureFault)
      }
      Assert-RecoveryTarget $Entry
      Assert-SafePath $Quarantine.staging
      [IO.File]::Move($Target,$Quarantine.staging)
      if((File-Identity $Quarantine.staging) -cne $Quarantine.objectIdentity -or (Hash-File $Quarantine.staging) -cne $Quarantine.replacementHash){throw 'Quarantine object verification failed'}
    }
  }
}
function Verify-OldLoopback($Plan){
  if(-not $VerifyLoopbackBusiness){return}
  if(-not(Test-Path -LiteralPath $LeasePath) -or (Get-Content -LiteralPath $LeasePath -Encoding UTF8 -Raw|ConvertFrom-Json).token -cne $LeaseToken){throw 'Owned lease missing before old business verification'}
  $Upstream=[Uri]$Plan.runtime.upstreamOrigin
  if($Upstream.Scheme -cne 'http' -or $Upstream.Host -cne '127.0.0.1'){throw 'Business probe requires an owned loopback upstream'}
  $Marker='recovery-owned-fixture-'+[guid]::NewGuid().ToString('N')
  $Body=@{model='owned-fixture-model';stream=$true;fixture_marker=$Marker}|ConvertTo-Json -Compress
  $Response=Invoke-WebRequest -Uri "http://127.0.0.1:$Port/backend-api/codex/responses" -Method Post -ContentType 'application/json' -Body $Body -UseBasicParsing -TimeoutSec 5
  if($Response.StatusCode -ne 200 -or -not $Response.Content.Contains($Marker) -or -not $Response.Content.Contains('response.completed')){throw 'Old loopback business failed; owned lease retained'}
  if(-not(Test-Path -LiteralPath $LeasePath) -or (Get-Content -LiteralPath $LeasePath -Encoding UTF8 -Raw|ConvertFrom-Json).token -cne $LeaseToken){throw 'Owned lease changed during old business verification'}
  Write-Json (Join-Path $BackupRoot 'old-business-before-lease-release.json') @{passed=$true;ownedLeasePresent=(Test-Path -LiteralPath $LeasePath);version=(Health).implementationVersion;pid=(Health).pid;at=[DateTimeOffset]::UtcNow.ToString('o')}
}
if(($InjectFailureAfterStart -or $InjectJournalFailure -or $InjectRollbackFailure -or $InjectStopRefusal -or $InjectAclRestoreFailure -or $InjectPauseAfterApplyLeaf -or $InjectPauseDuringRestoreCore -or $InjectIntentWriteFailure -or $VerifyLoopbackBusiness) -and -not $CodeRoot.StartsWith(([IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Failure injection only allowed inside TEMP'}
if($Action -eq 'Prepare'){
  if(Test-Path -LiteralPath $PlanPath){throw 'Rollback plan already exists'}
  $Before = Health
  Assert-Owner $Before
  New-Item -ItemType Directory -Path (Join-Path $BackupRoot 'src') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $BackupRoot 'ops') -Force | Out-Null
  $Entries = @(foreach($Relative in $Files){
    $Target=Join-Path $CodeRoot $Relative
    $Source=Join-Path $CandidateRoot $Relative
    $Exists=Test-Path -LiteralPath $Target
    if($Exists){Copy-Item -LiteralPath $Target -Destination (Join-Path $BackupRoot $Relative)}
    if(-not $Exists -and $Relative -cne 'src\request-wait-budget.mjs'){throw 'Existing runtime target is missing'}
    $PreviousHash=if($Exists){Hash-File $Target}else{$null}
    $TargetSddl=if($Exists){(Get-Acl -LiteralPath $Target).Sddl}else{(Get-Acl -LiteralPath (Join-Path $CodeRoot 'src\codex-model-stream-proxy.mjs')).Sddl}
    @{relative=$Relative;existed=$Exists;previous=$PreviousHash;candidate=(Hash-File $Source);sddl=$TargetSddl;originalIdentity=$(if($Exists){File-Identity $Target}else{$null});backupIdentity=$(if($Exists){File-Identity (Join-Path $BackupRoot $Relative)}else{$null})}
  })
  $ProfileExists=Test-Path -LiteralPath $ProfilePath
  if($ProfileExists){Copy-Item -LiteralPath $ProfilePath -Destination (Join-Path $BackupRoot 'adaptive-state.before.json')}
  $Runtime=Get-Content -LiteralPath (Join-Path $StateRoot 'codex-model-stream-proxy-runtime.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  if($Runtime.pid -ne $Before.pid -or $Runtime.instanceToken -cne $Before.instanceToken){throw 'Runtime changed during Prepare'}
  foreach($Field in @('maxBufferedRequestBytes','maxDecodedRequestBytes')){
    if(-not $Before.$Field -or [long]$Before.$Field -le 0){throw "Missing live capacity: $Field"}
    $Runtime | Add-Member -NotePropertyName $Field -NotePropertyValue $Before.$Field -Force
  }
  foreach($Entry in $Entries){if($Entry.existed -and ((Hash-File (Join-Path $BackupRoot $Entry.relative)) -ne $Entry.previous -or (Hash-File (Join-Path $CodeRoot $Entry.relative)) -ne $Entry.previous)){throw 'Backup/source changed during Prepare'}}
  $Protected=@(Get-ChildItem -LiteralPath (Join-Path $CodeRoot 'src') -Filter '*.mjs' -File | Where-Object {('src\'+$_.Name) -notin $Files} | ForEach-Object {@{relative=('src\'+$_.Name);hash=(Hash-File $_.FullName)}})
  $Protected+=@('ops\start-codex-model-stream-proxy.ps1','ops\stop-codex-model-stream-proxy.ps1','ops\resolve-napcat-data-root.ps1') | ForEach-Object {@{relative=$_;hash=(Hash-File (Join-Path $CodeRoot $_))}}
  Initialize-RecoveryKey
  $KeyPath=Join-Path $BackupRoot 'recovery-key.dpapi'
  Write-Json $PlanPath @{codeRoot=$CodeRoot;candidateRoot=$CandidateRoot;dataRoot=$DataRoot;port=$Port;nodePath=$NodePath;nodeHash=(Hash-File $NodePath);expectedPid=$Before.pid;instanceToken=$Before.instanceToken;files=$Entries;protected=$Protected;profileExisted=$ProfileExists;runtime=$Runtime;candidateVersion=$Release.implementationVersion;candidateWireBytes=([long]$Release.maxBufferedRequestMiB*1MB);candidateDecodedBytes=([long]$Release.maxDecodedRequestMiB*1MB);releasePath=$ReleasePath;releaseSha=(Hash-File $ReleasePath);operatorSha=(Hash-File $PSCommandPath);intentHelperSha=(Hash-File $IntentHelper);recoveryKeyHash=(Hash-File $KeyPath);recoveryKeySddl=(Get-Acl -LiteralPath $KeyPath).Sddl}
  Flush-NewFile (Join-Path $BackupRoot 'plan-auth.hmac') ($Utf8.GetBytes((Hmac-Text ([IO.File]::ReadAllText($PlanPath)))))
  Journal 'prepared' @{pid=$Before.pid;version=$Before.implementationVersion;activeRequests=$Before.activeRequests}
  @{prepared=$true;productionChanged=$false;backupRoot=$BackupRoot}|ConvertTo-Json
  return
}
if($Action -ne 'Inspect' -and -not $CoordinatedWindow){throw 'A settled-turn maintenance window is required; no stop or replacement requested'}
if($Action -eq 'Rollback'){
  $PreflightTokenPath=Join-Path $BackupRoot 'lease-token.txt'
  Assert-SafePath $PreflightTokenPath
  $PreflightToken=if(Test-Path -LiteralPath $PreflightTokenPath){[IO.File]::ReadAllText($PreflightTokenPath)}else{$null}
  if(-not(Test-OwnerToken $PreflightToken)){throw 'Invalid historical maintenance token; refusing before any lock creation'}
  if(Test-Path -LiteralPath $LeasePath){
    $PreflightLease=Get-Content -LiteralPath $LeasePath -Encoding UTF8 -Raw|ConvertFrom-Json
    if(-not(Test-OwnerToken $PreflightLease.token) -or $PreflightLease.token -cne $PreflightToken){throw 'Foreign maintenance lease; refusing before any lock creation'}
  }
  $script:IntentLeaseToken=$PreflightToken
}
$OperatorLock=$null
try {
if($Action -ne 'Inspect'){$OperatorLock=[IO.File]::Open(($LeasePath+'.operator-lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
$Plan=Get-Content -LiteralPath $PlanPath -Encoding UTF8 -Raw|ConvertFrom-Json
Authenticate-Plan
if($Plan.operatorSha -cne (Hash-File $PSCommandPath) -or $Plan.intentHelperSha -cne (Hash-File $IntentHelper)){throw 'Prepared operator/helper identity changed'}
if((@($Plan.files.relative) -join '|') -cne ($Files -join '|')){throw 'Prepared target scope mismatch'}
if($Action -ne 'Rollback' -and ($Plan.releasePath -cne $ReleasePath -or $Plan.releaseSha -cne (Hash-File $ReleasePath))){throw 'Release input changed after Prepare'}
if($Plan.codeRoot -cne $CodeRoot -or $Plan.candidateRoot -cne $CandidateRoot -or $Plan.dataRoot -cne $DataRoot -or $Plan.port -ne $Port){throw 'Prepared paths mismatch'}
if($Plan.nodePath -cne $NodePath -or (Hash-File $NodePath) -ne $Plan.nodeHash){throw 'Node identity changed'}
$OwnedRecoveryLease=$false
if($Action -eq 'Rollback' -and (Test-Path -LiteralPath $LeasePath) -and (Test-Path -LiteralPath (Join-Path $BackupRoot 'lease-token.txt'))){
  $RecoveryLease=Get-Content -LiteralPath $LeasePath -Raw -Encoding UTF8|ConvertFrom-Json
  $SavedRecoveryToken=[IO.File]::ReadAllText((Join-Path $BackupRoot 'lease-token.txt'))
  $OwnedRecoveryLease=(Test-OwnerToken $RecoveryLease.token) -and (Test-OwnerToken $SavedRecoveryToken) -and $RecoveryLease.token -ceq $SavedRecoveryToken
}
foreach($Entry in $Plan.protected){if((Hash-File (Join-Path $CodeRoot $Entry.relative)) -ne $Entry.hash){throw "Protected dependency changed: $($Entry.relative)"}}
foreach($Entry in $Plan.files){
  if(($Action -eq 'Apply' -or $Action -eq 'Inspect') -and (Test-Path -LiteralPath (Join-Path $CodeRoot $Entry.relative)) -and (Normalize-Acl (Get-Acl -LiteralPath (Join-Path $CodeRoot $Entry.relative)).Sddl) -cne (Normalize-Acl $Entry.sddl)){throw 'Target ACL changed'}
  if($Entry.existed -and (Hash-File (Join-Path $BackupRoot $Entry.relative)) -ne $Entry.previous){throw 'Rollback hash changed'}
  if($Entry.existed -and (File-Identity (Join-Path $BackupRoot $Entry.relative)) -cne $Entry.backupIdentity){throw 'Rollback backup object changed'}
  if($Action -eq 'Apply' -or $Action -eq 'Inspect'){
    if((Hash-File (Join-Path $CandidateRoot $Entry.relative)) -ne $Entry.candidate){throw 'Candidate changed after Prepare'}
    $Target=Join-Path $CodeRoot $Entry.relative
    if($Entry.existed -and (Hash-File $Target) -ne $Entry.previous){throw 'Production source changed after Prepare'}
    if($Entry.existed -and (File-Identity $Target) -cne $Entry.originalIdentity){throw 'Production object changed after Prepare'}
    if(-not $Entry.existed -and (Test-Path -LiteralPath $Target)){throw 'Unexpected new production file'}
  }
  if($Action -eq 'Rollback'){
    Assert-RecoveryTarget $Entry
    $Target=Join-Path $CodeRoot $Entry.relative
    if(-not $Entry.existed -and -not(Test-Path -LiteralPath $Target)){continue}
    if($Entry.existed -and -not(Test-Path -LiteralPath $Target) -and $OwnedRecoveryLease){continue}
    if(-not(Test-Path -LiteralPath $Target) -or (Hash-File $Target) -notin @($Entry.previous,$Entry.candidate)){throw 'Target changed outside this update; refusing rollback'}
  }
}
$RecoveryValidationRequired=$Action -eq 'Rollback'
if($RecoveryValidationRequired){Assert-AllRecoveryTargets}
$Before=$null
try{$Before=Health}catch{if($Action -ne 'Rollback'){throw};Assert-Stopped}
if($Before){Assert-Owner $Before}
if(($Action -eq 'Apply' -or $Action -eq 'Inspect') -and ($Before.pid -ne $Plan.expectedPid -or $Before.instanceToken -cne $Plan.instanceToken)){throw 'Production instance changed after Prepare'}
if($Action -eq 'Inspect'){
  @{action='Inspect';materialsValidated=$true;productionChanged=$false;pid=$Before.pid;implementationVersion=$Before.implementationVersion;activeRequests=$Before.activeRequests;draining=$Before.draining;leaseAbsent=(-not(Test-Path -LiteralPath $LeasePath));stopAbsent=(-not(Test-Path -LiteralPath (Join-Path $StateRoot 'codex-model-stream-proxy.stop')));releaseSha=$Plan.releaseSha}|ConvertTo-Json
  return
}
$LeaseToken=$null
$AdoptedLease=$false
if(Test-Path -LiteralPath $LeasePath){
  $ExistingLease=Get-Content -LiteralPath $LeasePath -Encoding UTF8 -Raw|ConvertFrom-Json
  $TokenPath=Join-Path $BackupRoot 'lease-token.txt'
  $SavedToken=if(Test-Path -LiteralPath $TokenPath){[IO.File]::ReadAllText($TokenPath)}else{$null}
  if($Action -ne 'Rollback' -or -not(Test-OwnerToken $ExistingLease.token) -or -not(Test-OwnerToken $SavedToken) -or $ExistingLease.token -cne $SavedToken){throw 'Foreign maintenance lease; no modification allowed'}
  $LeaseToken=$ExistingLease.token
  $AdoptedLease=$true
}
if(-not $LeaseToken){
  if($Action -eq 'Rollback'){$LeaseToken=$script:IntentLeaseToken}
  else{$LeaseToken=[guid]::NewGuid().ToString('N');[IO.File]::WriteAllText((Join-Path $BackupRoot 'lease-token.txt'),$LeaseToken,$Utf8)}
}
$script:IntentLeaseToken=$LeaseToken
$Stopped=$false
$script:StopRequested=$false
$SafeToRelease=$false
try{
  if(-not $AdoptedLease){
    $LeaseStream=$null
    try {
      $LeaseStream=[IO.File]::Open($LeasePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
      $LeaseBytes=$Utf8.GetBytes((@{token=$LeaseToken;expiresAt=[DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o');purpose='model-proxy-component-update';backupRoot=$BackupRoot}|ConvertTo-Json))
      $LeaseStream.Write($LeaseBytes,0,$LeaseBytes.Length)
      $LeaseStream.Flush($true)
    } finally {if($LeaseStream){$LeaseStream.Dispose()}}
  }
  Journal 'stopping_idle_proxy' @{pid=$Before.pid}
  if($Before){Stop-Current}else{Assert-Stopped}
  $Stopped=$true
  if($Action -eq 'Apply'){foreach($Entry in $Plan.files){Prepare-ReplacementIntent 'apply' $Entry (Join-Path $CandidateRoot $Entry.relative)|Out-Null}}
  if($Action -eq 'Rollback'){Restore-Files $Plan}
  else{foreach($Entry in $Plan.files){Replace-WithIntent 'apply' $Entry (Join-Path $CandidateRoot $Entry.relative)}}
  $After=Start-Current $Plan -Candidate:($Action -eq 'Apply')
  if($InjectFailureAfterStart){throw 'INJECTED_AFTER_START_FAILURE'}
  $Expected=if($Action -eq 'Apply'){$Plan.candidateVersion}else{$Plan.runtime.implementationVersion}
  if($After.implementationVersion -ne $Expected){throw 'Version verification failed'}
  if($Action -eq 'Apply' -and $After.bufferedToolProfileCount -ne $Plan.runtime.bufferedToolProfileCount){throw 'Delivery profile preservation failed'}
  if($Action -eq 'Rollback'){Verify-OldLoopback $Plan}
  $SafeToRelease=$true
  Journal $(if($Action -eq 'Apply'){'active'}else{'rolled_back'}) @{previousPid=$Before.pid;pid=$After.pid;version=$After.implementationVersion;appServerRestarted=$false}
  @{changed=$true;action=$Action;pid=$After.pid;version=$After.implementationVersion;backupRoot=$BackupRoot}|ConvertTo-Json
}catch{
  $Failure=$_.Exception.Message
  $SafeToRelease=$false
  if($Stopped -and $Action -eq 'Apply'){
    Journal 'rolling_back' @{reason=$Failure}
    try{
      if($InjectRollbackFailure){throw 'INJECTED_ROLLBACK_FAILURE'}
      Assert-AllRecoveryTargets
      $Current=$null
      try{$Current=Health}catch{}
      if($Current){Stop-Current}else{Assert-Stopped}
      Restore-Files $Plan
      $Restored=Start-Current $Plan
      if($Restored.implementationVersion -ne $Plan.runtime.implementationVersion){throw "Rollback health failed: $Failure"}
      Verify-OldLoopback $Plan
      $SafeToRelease=$true
      Journal 'rolled_back' @{reason=$Failure;pid=$Restored.pid;version=$Restored.implementationVersion}
    }catch{Journal 'recovery_failed' @{reason=$_.Exception.Message;initialFailure=$Failure};throw}
  }elseif(-not $Stopped -and -not $script:StopRequested){$SafeToRelease=(-not $AdoptedLease);Journal 'not_activated' @{reason=$Failure}}
  else{Journal 'recovery_or_stop_unconfirmed' @{reason=$Failure;stopped=$Stopped;stopRequested=$script:StopRequested}}
  throw $Failure
}finally{
  if($SafeToRelease -and (Test-Path -LiteralPath $LeasePath)){
    $Lease=Get-Content -LiteralPath $LeasePath -Encoding UTF8 -Raw|ConvertFrom-Json
    if($Lease.token -ceq $LeaseToken){Remove-Item -LiteralPath $LeasePath -Force}
  }
}
} finally {if($OperatorLock){$OperatorLock.Dispose()}}
