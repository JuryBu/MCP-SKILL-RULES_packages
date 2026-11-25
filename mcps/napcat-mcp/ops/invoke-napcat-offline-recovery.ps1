[CmdletBinding()]
param([switch]$AwaitDurableCommit)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function New-NapCatOfflineRecoveryResult {
  param([string]$Status, [string]$Reason, $Changed, [bool]$NativeQuickLoginVerified = $false)
  $Result = [ordered]@{ status = $Status; reason = $Reason; nativeQuickLoginVerified = $NativeQuickLoginVerified }
  if ($Changed -is [bool]) { $Result.changed = $Changed }
  return [pscustomobject]$Result
}

function Get-NapCatOfflineLoginTimeout {
  param([long]$DeadlineAt, [int]$RequestedSeconds)
  $Remaining = Get-NapCatOfflineRemainingMilliseconds $DeadlineAt
  return [int][Math]::Min($RequestedSeconds, [Math]::Floor(($Remaining - 15000) / 1000))
}

function Invoke-NapCatOfflineRecoveryRequest {
  param($Request, [ref]$CleanupFailed)
  if ($Request -isnot [pscustomobject] -or $Request.schema -cne 'napcat.offline-recovery-request/v1' -or
      $Request.action -cnotin @('recover-reachable-offline', 'stop-stale-offline', 'quick-login') -or
      $Request.processes -isnot [array] -or $Request.processes.Count -gt 256 -or $Request.paths -isnot [pscustomobject] -or
      $Request.deadlineAt -isnot [long] -or ($Request.timeoutSeconds -isnot [int] -and $Request.timeoutSeconds -isnot [long]) -or
      $Request.timeoutSeconds -lt 1 -or $Request.timeoutSeconds -gt 900) {
    return New-NapCatOfflineRecoveryResult 'deferred' 'invalid_request' $false
  }
  $Action = $Request.action
  $DeadlineAt = $Request.deadlineAt
  $MayStop = $Action -cne 'quick-login'
  $MayLogin = $Action -cne 'stop-stale-offline'
  $NeedsProof = $Action -ceq 'recover-reachable-offline'
  if (($MayStop -and ($Request.root -isnot [pscustomobject] -or $Request.processes.Count -eq 0)) -or
      (-not $MayStop -and ($null -ne $Request.root -or $Request.processes.Count -ne 0))) {
    return New-NapCatOfflineRecoveryResult 'deferred' 'invalid_request' $false
  }
  if ($NeedsProof -and ($Request.quickLoginProof -isnot [pscustomobject] -or
      [string]::IsNullOrWhiteSpace([string]$Request.quickLoginProof.fileSha256))) {
    return New-NapCatOfflineRecoveryResult 'deferred' 'quick_login_proof_missing' $false
  }
  if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) {
    return New-NapCatOfflineRecoveryResult 'deferred' 'deadline_expired' $false
  }
  if ($MayLogin -and (Get-NapCatOfflineLoginTimeout $DeadlineAt $Request.timeoutSeconds) -lt 30) {
    return New-NapCatOfflineRecoveryResult 'deferred' 'login_budget_insufficient' $false
  }

  $Guard = Enter-NapCatOfflineRecoveryGuard -Paths $Request.paths
  if (-not $Guard.acquired) { return New-NapCatOfflineRecoveryResult 'deferred' $Guard.reason $false }
  $Paths = $Guard.paths
  $MutationAttempted = $false
  $LoginDispatched = $false
  $StopConfirmed = $false
  $Handles = @()
  $Failure = 'onebot_unverified'
  try {
    $Target = Get-NapCatOfflineOneBotTarget -Guard $Guard
    $InitialState = $null
    if ($MayStop) {
      $InitialState = Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $DeadlineAt -Target $Target
      if ($InitialState -ceq 'online') { return New-NapCatOfflineRecoveryResult 'deferred' 'onebot_online' $false }
      if ($InitialState -cne 'offline' -and ($NeedsProof -or $InitialState -cne 'connection_refused')) {
        return New-NapCatOfflineRecoveryResult 'deferred' 'onebot_unverified' $false
      }
    }

    $Failure = 'process_identity_unverified'
    $Classification = Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $Paths.napcatRoot
    if (@($Classification.unknown).Count -ne 0) { return New-NapCatOfflineRecoveryResult 'deferred' 'process_identity_unverified' $false }
    if ($MayStop) {
      $Verified = @(Get-NapCatOfflineExactOwnedProcesses -Classification $Classification -Root $Request.root -Expected $Request.processes)
      $Handles = @(Open-NapCatOfflineProcessHandles -Processes $Verified)
      Initialize-NapCatOfflineStopApi
    } elseif (@($Classification.owned).Count -ne 0) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'owned_process_present' $false
    }
    if ($NeedsProof -and -not (Test-NapCatOfflineQuickLoginProof -Guard $Guard -Proof $Request.quickLoginProof -RetainFiles)) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'quick_login_proof_changed' $false
    }
    $Failure = 'maintenance_unverified'
    if ((Get-NapCatOfflinePathPresence ([IO.Path]::Combine($Paths.dataStateDir, 'supervisor.stop'))) -or
        (Test-NapCatOfflineRecoveryInhibited -Paths $Paths)) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'maintenance_active' $false
    }
    $Failure = 'profile_unverified'
    if ((Get-NapCatOfflineQqMutexName -QqUserDataDir $Paths.qqUserDataDir) -cne $Guard.profile.mutexName) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'profile_unverified' $false
    }
    if ($MayLogin -and (Get-NapCatOfflineLoginTimeout $DeadlineAt $Request.timeoutSeconds) -lt 30) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'login_budget_insufficient' $false
    }

    $ListenerBefore = $null
    if ($MayStop) {
      $Failure = 'onebot_owner_unverified'
      $ListenerBefore = Confirm-NapCatOfflineListener -Target $Target -State $InitialState -Owned $Verified
    }
    $State = Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $DeadlineAt -Target $Target
    if ($State -ceq 'online') { return New-NapCatOfflineRecoveryResult 'deferred' 'onebot_online' $false }
    if (($MayStop -and $State -cne $InitialState) -or ($State -cnotin @('offline','connection_refused'))) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'onebot_unverified' $false
    }
    $Failure = 'onebot_target_changed'
    if ((Get-NapCatOfflineOneBotTarget -Guard $Guard).sha -cne $Target.sha) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'onebot_target_changed' $false
    }
    if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) {
      return New-NapCatOfflineRecoveryResult 'deferred' 'deadline_expired' $false
    }

    if ($MayStop) {
      $Failure = 'process_identity_unverified'
      $Current = Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $Paths.napcatRoot
      $Exact = @($Verified | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; identityKey = Get-NapCatOfflineProcessIdentityKey $_ } })
      $Fresh = @(Get-NapCatOfflineExactOwnedProcesses -Classification $Current -Root $Request.root -Expected $Exact)
      $Failure = 'onebot_owner_unverified'
      $null = Confirm-NapCatOfflineListener -Target $Target -State $State -Owned $Fresh -ExpectedOwner $ListenerBefore
      $Failure = 'onebot_target_changed'
      if ((Get-NapCatOfflineOneBotTarget -Guard $Guard).sha -cne $Target.sha) { throw $Failure }
      $Failure = 'maintenance_unverified'
      if ((Get-NapCatOfflinePathPresence ([IO.Path]::Combine($Paths.dataStateDir, 'supervisor.stop'))) -or
          (Test-NapCatOfflineRecoveryInhibited -Paths $Paths)) {
        return New-NapCatOfflineRecoveryResult 'deferred' 'maintenance_active' $false
      }
      if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 3000) {
        return New-NapCatOfflineRecoveryResult 'deferred' 'deadline_expired' $false
      }
      if ($MayLogin -and (Get-NapCatOfflineLoginTimeout ($DeadlineAt - 3000) $Request.timeoutSeconds) -lt 30) {
        return New-NapCatOfflineRecoveryResult 'deferred' 'login_budget_insufficient' $false
      }
      Stop-NapCatOfflineRetainedProcesses -Handles $Handles -DeadlineAt $DeadlineAt -MutationAttempted ([ref]$MutationAttempted)
      $Remaining = Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $Paths.napcatRoot
      if (@($Remaining.owned).Count -ne 0 -or @($Remaining.unknown).Count -ne 0) {
        return New-NapCatOfflineRecoveryResult 'unknown' 'stop_unverified'
      }
      $StopConfirmed = $true
      if (-not $MayLogin) { return New-NapCatOfflineRecoveryResult 'stopped' 'owned_processes_stopped' $true }
      if (Test-NapCatOfflineRecoveryInhibited -Paths $Paths) {
        return New-NapCatOfflineRecoveryResult 'needs-manual' 'maintenance_after_stop' $true
      }
      if (-not (Test-NapCatOfflineQuickLoginProof -Guard $Guard -Proof $Request.quickLoginProof)) {
        return New-NapCatOfflineRecoveryResult 'needs-manual' 'quick_login_proof_changed_after_stop' $true
      }
    } else {
      $Failure = 'process_identity_unverified'
      $Current = Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $Paths.napcatRoot
      if (@($Current.unknown).Count -ne 0 -or @($Current.owned).Count -ne 0) {
        return New-NapCatOfflineRecoveryResult 'deferred' 'process_identity_unverified' $false
      }
      if ((Get-NapCatOfflinePathPresence ([IO.Path]::Combine($Paths.dataStateDir, 'supervisor.stop'))) -or
          (Test-NapCatOfflineRecoveryInhibited -Paths $Paths)) {
        return New-NapCatOfflineRecoveryResult 'deferred' 'maintenance_active' $false
      }
    }

    $LoginTimeout = Get-NapCatOfflineLoginTimeout $DeadlineAt $Request.timeoutSeconds
    if ($LoginTimeout -lt 30) {
      if ($StopConfirmed) { return New-NapCatOfflineRecoveryResult 'needs-manual' 'login_budget_after_stop' $true }
      return New-NapCatOfflineRecoveryResult 'deferred' 'login_budget_insufficient' $false
    }
    $Arguments = @{
      DataRoot = $Paths.dataRoot; BrokerRoot = $Paths.brokerRoot; NapCatRoot = $Paths.napcatRoot
      QqExePath = $Paths.qqExePath; QqUserDataDir = $Guard.profile.normalizedPath; TimeoutSeconds = $LoginTimeout
      NoQr = $true; NoPasswordFallback = $true
    }
    Release-NapCatOfflineLoginAttemptFile -Guard $Guard
    $Arguments.TimeoutSeconds = Get-NapCatOfflineLoginTimeout $DeadlineAt $Request.timeoutSeconds
    if ($Arguments.TimeoutSeconds -lt 30) {
      if ($StopConfirmed) { return New-NapCatOfflineRecoveryResult 'needs-manual' 'login_budget_after_stop' $true }
      return New-NapCatOfflineRecoveryResult 'deferred' 'login_budget_insufficient' $false
    }
    $LoginDispatched = $true
    $global:LASTEXITCODE = 0
    $LoginText = & $Paths.loginScriptPath @Arguments 2>$null 3>$null 4>$null 5>$null 6>$null
    if ($LASTEXITCODE -ne 0 -or $LoginText -isnot [string]) { return New-NapCatOfflineRecoveryResult 'unknown' 'login_unverified' }
    $Result = ConvertFrom-Json -InputObject $LoginText -ErrorAction Stop
    if ([string]$Result.userId -cne $Guard.account -or $Result.launched -isnot [bool]) {
      return New-NapCatOfflineRecoveryResult 'unknown' 'login_unverified'
    }
    if ($Result.state -ceq 'online' -and $Result.launched -and (ConvertTo-NapCatOfflineProcessId $Result.processId) -ge 2) {
      if ($StopConfirmed) { return New-NapCatOfflineRecoveryResult 'recovered' 'verified_online' $true $true }
      return New-NapCatOfflineRecoveryResult 'started' 'verified_online' $true $true
    }
    if ($Result.state -cin @('already_online', 'online_existing') -and -not $Result.launched) {
      if ($StopConfirmed) { return New-NapCatOfflineRecoveryResult 'recovered' 'verified_online' $true }
      return New-NapCatOfflineRecoveryResult 'deferred' 'legacy_already_online' $false
    }
    return New-NapCatOfflineRecoveryResult 'unknown' 'login_unverified'
  } catch {
    if ($LoginDispatched) {
      if ($_.Exception.Message.StartsWith('[NAPCAT_MANUAL_LOGIN_REQUIRED]', [StringComparison]::Ordinal)) {
        if ($StopConfirmed) { return New-NapCatOfflineRecoveryResult 'needs-manual' 'manual_login_required' $true }
        return New-NapCatOfflineRecoveryResult 'needs-manual' 'manual_login_required'
      }
      return New-NapCatOfflineRecoveryResult 'unknown' 'login_unverified'
    }
    if ($MutationAttempted) { return New-NapCatOfflineRecoveryResult 'unknown' 'stop_unverified' }
    if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) { $Failure = 'deadline_expired' }
    return New-NapCatOfflineRecoveryResult 'deferred' $Failure $false
  } finally {
    try { Close-NapCatOfflineProcessHandles -Handles $Handles } catch { if ($CleanupFailed) { $CleanupFailed.Value = $true } }
    try { Exit-NapCatOfflineRecoveryGuard -Guard $Guard } catch { if ($CleanupFailed) { $CleanupFailed.Value = $true } }
  }
}

[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  . (Join-Path $PSScriptRoot 'napcat-offline-recovery-guard.ps1')
  . (Join-Path $PSScriptRoot 'napcat-process-identity.ps1')
  if ($AwaitDurableCommit) {
    [Console]::Out.WriteLine('NAPCAT_OFFLINE_GUARD_READY_V1')
    [Console]::Out.Flush()
  }
  $Buffer = [char[]]::new(262145)
  $Length = [Console]::In.ReadBlock($Buffer, 0, $Buffer.Length)
  $Request = $null
  if ($Length -gt 0 -and $Length -lt $Buffer.Length) {
    try {
      $RawInput = [string]::new($Buffer, 0, $Length)
      $Request = if ($PSVersionTable.PSEdition -ceq 'Core') { ConvertFrom-Json -InputObject $RawInput -NoEnumerate -ErrorAction Stop } else { ConvertFrom-Json -InputObject $RawInput -ErrorAction Stop }
    } catch {}
  }
  $CleanupFailed = $false
  $Result = Invoke-NapCatOfflineRecoveryRequest -Request $Request -CleanupFailed ([ref]$CleanupFailed)
  if ($CleanupFailed) { $Result | Add-Member -NotePropertyName cleanupFailed -NotePropertyValue $true }
} catch {
  $Result = New-NapCatOfflineRecoveryResult 'unknown' 'guard_unverified'
}
[Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress))
