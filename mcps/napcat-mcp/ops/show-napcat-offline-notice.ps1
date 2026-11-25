[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$IncidentKey
)

function Read-NapCatOfflineNoticeHold {
  param([string]$DataRoot,[string]$Key)
  if ($Key -cnotmatch '^napcat-offline-([0-9]{1,16})$') { throw 'notice_hold_unverified' }
  $AttemptAt = [long]$Matches[1]
  $State = [IO.Path]::Combine($DataRoot,'state')
  $Runtime = Read-NapCatQrFile ([IO.Path]::Combine($State,'supervisor-runtime.json')) 262144
  $Barrier = Read-NapCatQrFile ([IO.Path]::Combine($State,'napcat-offline-recovery.json')) 512
  $Active = ConvertFrom-NapCatQrFile $Runtime
  $Hold = ConvertFrom-NapCatQrFile $Barrier
  $Updated = [DateTimeOffset]::MinValue
  $Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $HoldStop = $Hold.manualAfterVerifiedStopAt
  $RuntimeStop = $Active.autoOfflineRecovery.manualAfterVerifiedStopAt
  if (-not [DateTimeOffset]::TryParse([string]$Active.updatedAt,[ref]$Updated) -or
      $Updated.ToUnixTimeMilliseconds() -gt $Now -or $Now - $Updated.ToUnixTimeMilliseconds() -gt 120000 -or
      $AttemptAt -gt $Now -or $Now - $AttemptAt -gt 120000 -or
      $Active.state -cne 'running' -or $Active.login.blocked -isnot [bool] -or -not $Active.login.blocked -or
      $Active.actions.offlineNotice.incidentKey -cne $Key -or
      $Active.autoOfflineRecovery.needsManual -isnot [bool] -or -not $Active.autoOfflineRecovery.needsManual -or
      ($RuntimeStop -isnot [long] -and $RuntimeStop -isnot [int]) -or
      ($HoldStop -isnot [long] -and $HoldStop -isnot [int]) -or $HoldStop -le 0 -or $HoldStop -gt $AttemptAt -or
      $RuntimeStop -ne $HoldStop -or
      ($Active.autoOfflineRecovery.noticeAttemptAt -isnot [long] -and $Active.autoOfflineRecovery.noticeAttemptAt -isnot [int]) -or
      $Active.autoOfflineRecovery.noticeAttemptAt -ne $AttemptAt -or
      $Hold.schemaVersion -ne 1 -or $Hold.needsManual -isnot [bool] -or -not $Hold.needsManual -or
      ($Hold.noticeAttemptAt -isnot [long] -and $Hold.noticeAttemptAt -isnot [int]) -or
      $Hold.noticeAttemptAt -ne $AttemptAt -or $null -ne $Hold.noticeAt) { throw 'notice_hold_unverified' }
  return ($Runtime.sha + ':' + $Barrier.sha)
}

function Get-NapCatOfflineNoticeOwnedPaths {
  param($Config,$Paths,$DataRoot,$Account)
  if (-not $Config.accountStateDir) { return }
  $StateDir = ConvertTo-NapCatQrPath $Config.accountStateDir
  $DeploymentPath = [IO.Path]::Combine($StateDir,'deployment.json')
  $File = Read-NapCatQrFile $DeploymentPath 524288
  $Deployment = ConvertFrom-NapCatQrFile $File
  $Owned = $Paths.Clone()
  $Owned.dataRoot = $DataRoot
  $Owned.accountStateDir = $StateDir
  $Owned.brokerRoot = ConvertTo-NapCatQrPath $Config.brokerRoot
  foreach ($Name in @('napCatRoot','qqUserDataDir')) {
    $Owned[$Name] = ConvertTo-NapCatQrPath $Deployment.$Name
    if ($null -ne $Config.$Name -and (ConvertTo-NapCatQrPath $Config.$Name) -ine $Owned[$Name]) { return }
  }
  $Owned.qqExePath = ConvertTo-NapCatQrOptionalExePath $Deployment.qqExePath
  if ($null -ne $Config.qqExePath -and (ConvertTo-NapCatQrOptionalExePath $Config.qqExePath) -ine $Owned.qqExePath) { return }
  $Guard = @{ paths=$Owned; account=$Account }
  $Identity = Assert-NapCatQrDeployment $Guard @{ expectedAccount=$Account; machineRole=$Config.machineRole }
  if (-not $Identity.StartsWith($File.sha + ':',[StringComparison]::Ordinal)) { return }
  return @{ guard=$Guard; identity=$Identity }
}

function Get-NapCatOfflineNoticeOwner {
  param($Guard,$Target,$Expected)
  $Snapshot = Get-NapCatQrOwnedSnapshot $Guard
  if (@($Snapshot.unknown).Count -ne 0 -or @($Snapshot.owned).Count -eq 0) { throw 'process_identity_unverified' }
  $Owner = Confirm-NapCatOfflineListener -Target $Target -State 'offline' -Owned @($Snapshot.owned) -ExpectedOwner $Expected
  $Record = @($Snapshot.owned | Where-Object { $_.ProcessId -eq $Owner })
  if ($Record.Count -ne 1 -or [double]::IsNaN((Get-NapCatIdentityBirth $Record[0])) -or
      -not $Record[0].ExecutablePath) { throw 'process_identity_unverified' }
  return @{ pid=$Owner; sha=(Get-NapCatOfflineProcessIdentityKey $Record[0]) }
}

function Invoke-NapCatOfflineNotice {
  param([string]$Path,[string]$Key,[scriptblock]$Show)
  if (-not $Path -or $Key -cnotmatch '^[A-Za-z0-9_.:-]{1,160}$') { return 'notice_disabled' }
  try {
    $Desktop = Get-NapCatQrDesktopIdentity
    $Config = Get-NapCatQrConfig $Path $Desktop 'offlineNoticeEnabled'
  } catch { return 'notice_disabled' }
  try {
    $Ops = [IO.Path]::GetDirectoryName($MyInvocation.MyCommand.ScriptBlock.File)
    . (Join-Path $Ops 'napcat-offline-recovery-guard.ps1')
    $Paths = @{
      bindingPath = [IO.Path]::Combine((ConvertTo-NapCatQrPath $Config.value.dataRoot),'binding.json')
      privateEnvPath = [IO.Path]::Combine((ConvertTo-NapCatQrPath $Config.value.brokerRoot),'broker-private.env.json')
    }
    $DataRoot = ConvertTo-NapCatQrPath $Config.value.dataRoot
    $Binding = Read-NapCatQrFile $Paths.bindingPath 65536
    $Account = [string](ConvertFrom-NapCatQrFile $Binding).expectedSelfId
    if ($Binding.sha -cne $Config.bindingSha -or $Account -cnotmatch '^[1-9][0-9]{4,31}$' -or
        ($null -ne $Config.value.expectedAccount -and [string]$Config.value.expectedAccount -cne $Account)) { return 'notice_offline_unverified' }
    $Guard = @{ paths=$Paths; account=$Account }
    $Target = Get-NapCatQrOneBotTarget $Guard
    $Deadline = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 6000
    $OneBotState = Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $Deadline -Target $Target
    $HoldIdentity = $null
    $Owned = $null
    $Owner = $null
    if ($OneBotState -ceq 'offline') {
      $AccountEvidence = Get-NapCatQrAccountEvidence $Target $Deadline
      if (Get-NapCatQrAccountRefusal $AccountEvidence $Account) { return 'notice_offline_unverified' }
      if (-not $AccountEvidence.verified) {
        $Owned = Get-NapCatOfflineNoticeOwnedPaths $Config.value $Paths $DataRoot $Account
        if ($null -eq $Owned) { return 'notice_offline_unverified' }
        . (Join-Path $Ops 'napcat-process-identity.ps1')
        $Owner = Get-NapCatOfflineNoticeOwner $Owned.guard $Target
      }
    } elseif ($OneBotState -ceq 'connection_refused') {
      $HoldIdentity = Read-NapCatOfflineNoticeHold $DataRoot $Key
      $null = Confirm-NapCatOfflineListener -Target $Target -State $OneBotState -Owned @()
    } else {
      return 'notice_offline_unverified'
    }
    if ((Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $Deadline -Target $Target) -cne $OneBotState) {
      return 'notice_offline_unverified'
    }
    if ($HoldIdentity) {
      $null = Confirm-NapCatOfflineListener -Target $Target -State $OneBotState -Owned @() -ExpectedOwner 0
      if ((Read-NapCatOfflineNoticeHold $DataRoot $Key) -cne $HoldIdentity) { return 'notice_offline_unverified' }
    }
    if ($OneBotState -ceq 'offline' -and (Get-NapCatQrAccountRefusal (Get-NapCatQrAccountEvidence $Target $Deadline) $Account -RequireVerified:($null -eq $Owned))) {
      return 'notice_offline_unverified'
    }
    if ($Owned) {
      if ((Assert-NapCatQrDeployment $Owned.guard @{ expectedAccount=$Account; machineRole=$Config.value.machineRole }) -cne $Owned.identity -or
          (Get-NapCatOfflineNoticeOwner $Owned.guard $Target $Owner.pid).sha -cne $Owner.sha) { return 'notice_offline_unverified' }
    }
    $CurrentDesktop = Get-NapCatQrDesktopIdentity
    if ($CurrentDesktop.sid -cne $Desktop.sid -or $CurrentDesktop.sessionId -ne $Desktop.sessionId -or
        $CurrentDesktop.explorerId -ne $Desktop.explorerId -or (Read-NapCatQrFile $Config.path).sha -cne $Config.sha -or
        (Read-NapCatQrFile $Paths.bindingPath 65536).sha -cne $Binding.sha -or
        (Read-NapCatQrFile $Paths.privateEnvPath 524288).sha -cne $Target.sha -or
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $Deadline) { return 'notice_offline_unverified' }
  } catch { return 'notice_offline_unverified' }
  try {
    $null = & $Show
    return 'notice_returned'
  } catch { return 'notice_result_unknown_do_not_retry' }
}

if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
$WinPsModules = [IO.Path]::Combine($env:SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')
$env:PSModulePath = if ($PSVersionTable.PSEdition -ceq 'Core') { "$PSHOME\Modules;$WinPsModules" } else { $WinPsModules }
. (Join-Path $PSScriptRoot 'restart-napcat-qr-login.ps1') -ConfigPath $ConfigPath
try {
  Initialize-NapCatQrPowerShell
  $Status = Invoke-NapCatOfflineNotice $ConfigPath $IncidentKey {
    $Shell = New-Object -ComObject WScript.Shell
    try { $null = $Shell.Popup('NapCat 账号已离线。请从已设置的本机扫码入口重新登录。',8,'NapCat',0x30) }
    finally { try { $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($Shell) } catch {} }
  }
  @{ status=$Status } | ConvertTo-Json -Compress
} catch { @{ status='notice_disabled' } | ConvertTo-Json -Compress }
