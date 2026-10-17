[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigurationPath,
  [Parameter(Mandatory)][string]$ConfigurationSha256,
  [ValidateSet('Inspect','Switch','Resume','Undo')][string]$Action='Inspect',
  [string]$FixtureConfirmation=''
)
$ErrorActionPreference='Stop'
$Utf8=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$Utf8
$OutputEncoding=$Utf8
function Sha([string]$Path) {(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Json([string]$Path) {Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json}
function Plain-Existing([string]$Path) {
  $Current=[IO.Path]::GetFullPath($Path)
  while($Current){
    $Item=Get-Item -LiteralPath $Current -Force -ErrorAction Stop
    if(($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'OFFLINE_LINK_FORBIDDEN'}
    $Parent=[IO.Path]::GetDirectoryName($Current)
    if($Parent -eq $Current){break}
    $Current=$Parent
  }
}
function New-Bytes([string]$Path,[byte[]]$Bytes) {
  $Stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try {$Stream.Write($Bytes,0,$Bytes.Length);$Stream.Flush($true)} finally {$Stream.Dispose()}
}
function Assert-OfflineIntentMarker($Intent,$Config,[string]$ConfigurationSha256) {
  $GuidPattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  if($Intent.attemptId -isnot [string] -or $Intent.attemptId -cnotmatch $GuidPattern -or
     $Intent.nonce -isnot [string] -or $Intent.nonce -cnotmatch $GuidPattern -or
     $Intent.markerText -isnot [string] -or $Intent.markerText.Length -gt 65536){throw 'OFFLINE_INTENT_MARKER_INVALID'}
  try {$Record=$Intent.markerText | ConvertFrom-Json} catch {throw 'OFFLINE_INTENT_MARKER_INVALID'}
  if($Record -isnot [pscustomobject] -or @($Record.PSObject.Properties).Count -ne 5){throw 'OFFLINE_INTENT_MARKER_INVALID'}
  foreach($Name in @('schema','attemptId','configurationSha256','registryPath','nonce')) {
    if($Record.$Name -isnot [string]){throw 'OFFLINE_INTENT_MARKER_INVALID'}
  }
  if($Record.schema -cne 'napcat.offline-selection-stop/v1' -or
     $Record.attemptId -cne $Intent.attemptId -or $Record.nonce -cne $Intent.nonce -or
     $Record.configurationSha256 -cnotmatch '^[a-f0-9]{64}$' -or
     $Record.configurationSha256 -cne $ConfigurationSha256 -or
     $Record.registryPath -cne $Config.registryPath){throw 'OFFLINE_INTENT_MARKER_INVALID'}
}
if ((Sha $ConfigurationPath) -cne $ConfigurationSha256) {throw 'OFFLINE_CONFIGURATION_CHANGED'}
$Config=Json $ConfigurationPath
foreach($Pin in $Config.pins) {if((Sha $Pin.path) -cne $Pin.sha256){throw 'OFFLINE_PIN_CHANGED'}}
if ([IO.Path]::GetFullPath($PSCommandPath) -ine [IO.Path]::GetFullPath($Config.entryPath)) {throw 'OFFLINE_ENTRY_CHANGED'}
$Fixture=$Config.mode -ceq 'TempFixture'
if (-not $Fixture -and $FixtureConfirmation) {throw 'OFFLINE_FIXTURE_ARGUMENT_FORBIDDEN'}
function Check([switch]$Stopped) {
  if ($Stopped) {
    $Processes=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ProcessId -gt 0} | ForEach-Object {
      [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name;creationDate=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''});executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}
    })
    $Listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {[pscustomobject]@{localPort=[int]$_.LocalPort;owningProcess=[int]$_.OwningProcess;state='Listen'}})
    if ($Fixture) {
      $Processes=@($Processes | Where-Object {$_.commandLine -and $_.commandLine.IndexOf($Config.fixtureRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0})
      $Listeners=@($Listeners | Where-Object {$_.localPort -in $Config.ports})
    }
    $Snapshot=[pscustomobject]@{observedAt=[DateTime]::UtcNow.ToString('o');processes=$Processes;listeners=$Listeners}
    $Text=($Snapshot | ConvertTo-Json -Depth 8 -Compress) | & $Config.nodePath $Config.ioPath $ConfigurationPath $ConfigurationSha256 Check 2>&1 | Out-String
  } else {$Text=& $Config.nodePath $Config.ioPath $ConfigurationPath $ConfigurationSha256 Inspect 2>&1 | Out-String}
  if($LASTEXITCODE -ne 0){throw ('OFFLINE_CHECK_FAILED:'+ $Text.Trim())}
  $Text | ConvertFrom-Json
}
$State=Check
if($Action -ceq 'Inspect'){$State | ConvertTo-Json;return}
$Consent=if($Fixture){$FixtureConfirmation}else{Read-Host 'Close Codex and its failed backend normally, then type SWITCH-FULL-RUNTIME-SELECTION'}
if($Consent -cne 'SWITCH-FULL-RUNTIME-SELECTION'){throw 'OFFLINE_CANCELLED'}
$IntentPath=Join-Path (Split-Path -Parent $ConfigurationPath) 'offline-selection-attempt.json'
$IntentSealPath=$IntentPath+'.sha256'
$Gate=$null;$RecoveryMutex=$null;$Marker=$null;$IntentLock=$null;$IntentSealLock=$null;$Intent=$null;$IntentValidated=$false
$Result=[ordered]@{status='FAILED_PRESERVED';action=$Action;registryReplaced=$false;servicesStarted=$false;error=$null;intentPath=$IntentPath}
try {
  if($Config.startupProtection -ceq 'backend-stop'){
    $MutexPath=$Config.registryPath+'.offline-recovery.lock'
    if(Test-Path -LiteralPath $MutexPath){Plain-Existing $MutexPath}
    $RecoveryMutex=[IO.File]::Open($MutexPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    Plain-Existing $MutexPath
  }else{$Gate=[IO.File]::Open($Config.startupGatePath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
  if(Test-Path -LiteralPath $Config.recoveryGuardPath){throw 'OFFLINE_RECOVERY_GUARD_PRESENT'}
  Check -Stopped | Out-Null
  if($Action -ceq 'Switch'){
    if(Test-Path -LiteralPath $Config.stopPath){throw 'OFFLINE_FOREIGN_STOP_PRESERVED'}
    if($State.registrySha256 -cne $State.sourceSha256){throw 'OFFLINE_SWITCH_BASELINE_CHANGED'}
    if((Test-Path -LiteralPath $IntentPath) -or (Test-Path -LiteralPath $IntentSealPath)){throw 'OFFLINE_EXISTING_INTENT_PRESERVED'}
    $Attempt=[Guid]::NewGuid().ToString()
    $Work=Join-Path (Split-Path -Parent $ConfigurationPath) ('offline-selection-'+$Attempt)
    New-Item -ItemType Directory -Path $Work | Out-Null
    $OriginalPath=Join-Path $Work 'original-registry.json'
    New-Bytes $OriginalPath ([IO.File]::ReadAllBytes($Config.registryPath))
    if((Sha $OriginalPath) -cne $State.sourceSha256){throw 'OFFLINE_BACKUP_CHANGED'}
    $Nonce=[Guid]::NewGuid().ToString()
    $MarkerText=([ordered]@{schema='napcat.offline-selection-stop/v1';attemptId=$Attempt;configurationSha256=$ConfigurationSha256;nonce=$Nonce;registryPath=$Config.registryPath} | ConvertTo-Json -Compress)
    $Intent=[ordered]@{schemaVersion=1;attemptId=$Attempt;nonce=$Nonce;configurationSha256=$ConfigurationSha256;registryPath=$Config.registryPath;work=$Work;originalPath=$OriginalPath;sourceSha256=$State.sourceSha256;targetSha256=$State.targetSha256;markerText=$MarkerText}
    New-Bytes $IntentPath ($Utf8.GetBytes(($Intent | ConvertTo-Json -Depth 8 -Compress)))
    $IntentLock=[IO.File]::Open($IntentPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    New-Bytes $IntentSealPath ($Utf8.GetBytes((Sha $IntentPath)))
  }
  if(-not $IntentLock){$IntentLock=[IO.File]::Open($IntentPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
  Plain-Existing $IntentPath
  if(-not (Test-Path -LiteralPath $IntentSealPath -PathType Leaf)){throw 'OFFLINE_INTENT_SEAL_MISSING'}
  Plain-Existing $IntentSealPath
  $IntentSealLock=[IO.File]::Open($IntentSealPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  if($IntentSealLock.Length -ne 64){throw 'OFFLINE_INTENT_SEAL_CHANGED'}
  $IntentSeal=[IO.File]::ReadAllText($IntentSealPath,$Utf8)
  if($IntentSeal -cnotmatch '^[a-f0-9]{64}$' -or (Sha $IntentPath) -cne $IntentSeal){throw 'OFFLINE_INTENT_SEAL_CHANGED'}
  $Intent=Json $IntentPath
  if($Intent.schemaVersion -ne 1 -or $Intent.configurationSha256 -cne $ConfigurationSha256 -or $Intent.registryPath -cne $Config.registryPath -or $Intent.sourceSha256 -cne $State.sourceSha256 -or $Intent.targetSha256 -cne $State.targetSha256){throw 'OFFLINE_INTENT_CHANGED'}
  Assert-OfflineIntentMarker $Intent $Config $ConfigurationSha256
  if([IO.Path]::GetFullPath($Intent.work) -ine [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ConfigurationPath) ('offline-selection-'+$Intent.attemptId))) -or [IO.Path]::GetFullPath($Intent.originalPath) -ine [IO.Path]::GetFullPath((Join-Path $Intent.work 'original-registry.json'))){throw 'OFFLINE_INTENT_PATH_CHANGED'}
  if((Sha $Intent.originalPath) -cne $Intent.sourceSha256){throw 'OFFLINE_ORIGINAL_BACKUP_CHANGED'}
  Plain-Existing $Intent.work
  Plain-Existing $Intent.originalPath
  $IntentValidated=$true
  if(-not ('NapCat.OfflineSelectionMarker' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace NapCat {
  public static class OfflineSelectionMarker {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref int value,uint size);
    public static FileStream Open(string name,bool create) {
      SafeFileHandle handle=CreateFileW(name,0xC0010000,1,IntPtr.Zero,create?1u:3u,0x00200080,IntPtr.Zero);
      if(handle.IsInvalid){int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error);}
      return new FileStream(handle,FileAccess.ReadWrite);
    }
    public static void Consume(FileStream stream) {
      int remove=1;
      if(!SetFileInformationByHandle(stream.SafeFileHandle,4,ref remove,4))throw new Win32Exception(Marshal.GetLastWin32Error());
      stream.Dispose();
    }
  }
}
'@
  }
  $Exists=Test-Path -LiteralPath $Config.stopPath
  $Expected=$Utf8.GetBytes([string]$Intent.markerText)
  if(-not $Exists){
    $MarkerStage=Join-Path $Intent.work ([Guid]::NewGuid().ToString()+'.stop-new')
    if([IO.Path]::GetPathRoot($MarkerStage) -ine [IO.Path]::GetPathRoot($Config.stopPath)){throw 'OFFLINE_SAME_VOLUME_REQUIRED'}
    New-Bytes $MarkerStage $Expected
    [IO.File]::Move($MarkerStage,$Config.stopPath)
  }
  Plain-Existing $Config.stopPath
  $Marker=[NapCat.OfflineSelectionMarker]::Open($Config.stopPath,$false)
  if($Marker.Length -ne $Expected.Length){throw 'OFFLINE_FOREIGN_STOP_PRESERVED'}
  $Observed=New-Object byte[] $Expected.Length
  if($Marker.Read($Observed,0,$Observed.Length) -ne $Observed.Length -or [Convert]::ToBase64String($Observed) -cne [Convert]::ToBase64String($Expected)){throw 'OFFLINE_FOREIGN_STOP_PRESERVED'}
  if($Fixture -and $Config.faultAfterStop -ceq 'Pause' -and $Action -ceq 'Switch'){Start-Sleep -Seconds 3}
  Check -Stopped | Out-Null
  if(Test-Path -LiteralPath $Config.recoveryGuardPath){throw 'OFFLINE_RECOVERY_GUARD_PRESENT'}
  $Current=Check
  $Desired=if($Action -ceq 'Undo'){$Intent.sourceSha256}else{$Intent.targetSha256}
  $BytesPath=if($Action -ceq 'Undo'){$Intent.originalPath}else{$Config.targetRegistryPath}
  if($Current.registrySha256 -cne $Desired){
    $Stage=$Config.registryPath+'.offline-'+[Guid]::NewGuid().ToString()+'.new'
    New-Bytes $Stage ([IO.File]::ReadAllBytes($BytesPath))
    if((Sha $Stage) -cne $Desired){throw 'OFFLINE_STAGE_CHANGED'}
    $Backup=Join-Path $Intent.work ([Guid]::NewGuid().ToString()+'.previous')
    $Result['stagePath']=$Stage
    $Result['previousPath']=$Backup
    New-Bytes (Join-Path $Intent.work ([Guid]::NewGuid().ToString()+'.operation.json')) ($Utf8.GetBytes((@{action=$Action;stagePath=$Stage;previousPath=$Backup;expectedCurrentSha256=$Current.registrySha256;desiredSha256=$Desired} | ConvertTo-Json -Compress)))
    if([IO.Path]::GetPathRoot($Stage) -ine [IO.Path]::GetPathRoot($Backup)){throw 'OFFLINE_SAME_VOLUME_REQUIRED'}
    if((Sha $Config.registryPath) -cne $Current.registrySha256){throw 'OFFLINE_REGISTRY_DRIFT'}
    [IO.File]::Replace($Stage,$Config.registryPath,$Backup)
    $Result.registryReplaced=$true
    if((Sha $Backup) -cne $Current.registrySha256 -or (Sha $Config.registryPath) -cne $Desired){throw 'OFFLINE_REPLACE_NOT_CONFIRMED'}
    if($Fixture -and $Config.faultAfterReplace -and $Action -ceq 'Switch'){
      if(([string]$Config.faultAfterReplace) -ceq 'Pause'){Start-Sleep -Seconds 30}else{throw 'OFFLINE_FIXTURE_AFTER_REPLACE'}
    }
  }
  Check -Stopped | Out-Null
  Check | Out-Null
  if((Sha $Config.registryPath) -cne $Desired){throw 'OFFLINE_FINAL_REGISTRY_CHANGED'}
  $Result.status=if($Action -ceq 'Undo'){'OFFLINE_ORIGINAL_SELECTION_RESTORED'}else{'OFFLINE_TARGET_SELECTION_COMMITTED'}
  $Result['registrySha256']=$Desired
  New-Bytes (Join-Path $Intent.work ([Guid]::NewGuid().ToString()+'.receipt.json')) ($Utf8.GetBytes(($Result | ConvertTo-Json -Depth 8 -Compress)))
  [NapCat.OfflineSelectionMarker]::Consume($Marker);$Marker=$null
}catch{$Result.status='FAILED_PRESERVED';$Result.error=$_.Exception.Message}
finally{
  if($IntentValidated -and $IntentLock){try{New-Bytes (Join-Path $Intent.work ([Guid]::NewGuid().ToString()+'.result.json')) ($Utf8.GetBytes(($Result | ConvertTo-Json -Depth 8 -Compress)))}catch{}}
  if($Marker){$Marker.Dispose()}
  if($IntentLock){$IntentLock.Dispose()}
  if($IntentSealLock){$IntentSealLock.Dispose()}
  if($Gate){$Gate.Dispose()}
  if($RecoveryMutex){$RecoveryMutex.Dispose()}
  $Result | ConvertTo-Json -Depth 8
}
if($Result.error){exit 1}
