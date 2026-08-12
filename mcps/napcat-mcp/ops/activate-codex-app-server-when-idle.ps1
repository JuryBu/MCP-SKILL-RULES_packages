[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT,
  [string]$SupervisorTaskName = "CodexNapCatSupervisor",
  [ValidateRange(1, 900)][int]$TimeoutSeconds = 600,
  [ValidateRange(500, 10000)][int]$IdleConfirmMilliseconds = 1500,
  [switch]$CancelPendingActivation
)

$ErrorActionPreference = "Stop"
$OpsRoot = $PSScriptRoot
. (Join-Path $OpsRoot "resolve-napcat-data-root.ps1")
$BrokerRoot = Resolve-NapCatBrokerRoot -ExplicitBrokerRoot $BrokerRoot
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $BrokerRoot
$StateRoot = Join-Path $DataRoot "state"
$ActivationStatePath = Join-Path $StateRoot "codex-app-server-pending-activation.json"
$ActivationLockPath = Join-Path $StateRoot "napcat-bridge-update.lock"
$AlertPath = Join-Path $StateRoot "automation-alert.json"
$MaintenancePath = Join-Path $StateRoot "task-router.maintenance.json"
$StopFilePath = Join-Path $StateRoot "task-router.stop"
$UpdateStatePath = Join-Path $StateRoot "napcat-bridge-last-update.json"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

function Write-State {
  param([string]$State, [string]$Message, $Details = $null)
  $Value = [ordered]@{
    schemaVersion = 1
    state = $State
    message = $Message
    updatedAt = (Get-Date).ToString("o")
    details = $Details
  }
  [System.IO.File]::WriteAllText($ActivationStatePath, (($Value | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
}

function Set-ActivationMaintenance {
  param([bool]$Active, [string]$Code, [string]$Message)
  $Maintenance = if (Test-Path -LiteralPath $MaintenancePath) {
    try { Get-Content -LiteralPath $MaintenancePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { [pscustomobject]@{} }
  } else { [pscustomobject]@{} }
  $Reasons = [ordered]@{}
  if ($Maintenance.reasons) {
    foreach ($Property in $Maintenance.reasons.PSObject.Properties) { $Reasons[$Property.Name] = $Property.Value }
  }
  if ($Active) {
    $Reasons["packageUpdate"] = [ordered]@{ at = (Get-Date).ToString("o"); code = $Code; message = $Message }
  } else {
    $Reasons.Remove("packageUpdate") | Out-Null
  }
  if ($Reasons.Count -eq 0) {
    Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::WriteAllText($MaintenancePath, (([ordered]@{ schemaVersion = 1; reasons = $Reasons; updatedAt = (Get-Date).ToString("o") } | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
  }
}

function Restore-AutomationAfterDeferredActivation {
  Remove-Item -LiteralPath $StopFilePath -Force -ErrorAction SilentlyContinue
  Set-ActivationMaintenance -Active $false

  $ProxyStart = & (Join-Path $OpsRoot "start-codex-app-server-proxy.ps1") -DataRoot $DataRoot | ConvertFrom-Json
  $SupervisorStart = & (Join-Path $OpsRoot "start-napcat-supervisor.ps1") -DataRoot $DataRoot -BrokerRoot $BrokerRoot | ConvertFrom-Json
  $RouterStart = & (Join-Path $OpsRoot "start-napcat-task-router.ps1") -DataRoot $DataRoot -BrokerRoot $BrokerRoot | ConvertFrom-Json
  if ([int]$SupervisorStart.pid -le 0 -or [int]$RouterStart.pid -le 0) {
    throw "Deferred activation cleanup did not restore the supervisor and task router."
  }
  try { Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction Stop } catch {
    if ($null -ne (Get-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction SilentlyContinue)) { throw }
  }

  return [pscustomobject]@{
    proxy = $ProxyStart
    supervisor = $SupervisorStart
    router = $RouterStart
  }
}

$ActivationLockStream = $null
try {
  $ActivationLockStream = [System.IO.File]::Open($ActivationLockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  exit 0
}

try {
  if ($CancelPendingActivation) {
    $Restored = Restore-AutomationAfterDeferredActivation
    Write-State -State "cancelled" -Message "Pending activation was cancelled; staged files remain retryable and automation was restored."
    [pscustomobject]@{ ok = $true; cancelled = $true; retryable = $true; supervisorPid = $Restored.supervisor.pid; taskRouterPid = $Restored.router.pid } | ConvertTo-Json -Depth 8
    exit 0
  }

  if (Test-Path -LiteralPath $UpdateStatePath -PathType Leaf) {
    $ExistingUpdateState = Get-Content -LiteralPath $UpdateStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ExistingUpdateState.activated -eq $true -and $ExistingUpdateState.pendingActivation -ne $true) {
      $Restored = Restore-AutomationAfterDeferredActivation
      Write-State -State "ready" -Message "Activation was already complete; lifecycle finalization was applied idempotently."
      [pscustomobject]@{ ok = $true; alreadyActivated = $true; supervisorPid = $Restored.supervisor.pid; taskRouterPid = $Restored.router.pid } | ConvertTo-Json -Depth 8
      exit 0
    }
  }

  $StopWatchdogScript = Join-Path $OpsRoot "stop-napcat-supervisor-watchdog.ps1"
  if (-not (Test-Path -LiteralPath $StopWatchdogScript)) { throw "Supervisor watchdog stop script is missing: $StopWatchdogScript" }
  & $StopWatchdogScript -DataRoot $DataRoot -TaskName $SupervisorTaskName | Out-Null
  Set-ActivationMaintenance -Active $true -Code "PACKAGE_UPDATE_PENDING_ACTIVATION" -Message "Validated NapCat bridge code is staged; automatic wake remains paused until activation completes."
  Write-State -State "waiting_for_idle" -Message "Waiting for Codex Desktop to disconnect from the managed proxy."
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $IdleSince = $null
  do {
    $Status = $null
    try { $Status = & (Join-Path $OpsRoot "get-codex-app-server-proxy-status.ps1") -DataRoot $DataRoot | ConvertFrom-Json } catch {}
    if ($null -eq $Status -or $Status.ok -ne $true -or $null -eq $Status.control) {
      $IdleSince = $null
      Start-Sleep -Milliseconds 250
      continue
    }
    $ClientCount = [int]$Status.control.clientCount
    if ($ClientCount -eq 0) {
      if ($null -eq $IdleSince) { $IdleSince = [DateTime]::UtcNow }
      if (([DateTime]::UtcNow - $IdleSince).TotalMilliseconds -ge $IdleConfirmMilliseconds) { break }
    } else {
      $IdleSince = $null
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  if ($null -eq $IdleSince -or ([DateTime]::UtcNow - $IdleSince).TotalMilliseconds -lt $IdleConfirmMilliseconds) {
    $Restored = Restore-AutomationAfterDeferredActivation
    Write-State -State "retryable_timeout" -Message "Codex Desktop did not disconnect before the activation timeout; staging remains retryable and automation was restored."
    [pscustomobject]@{ ok = $false; retryable = $true; timedOut = $true; supervisorPid = $Restored.supervisor.pid; taskRouterPid = $Restored.router.pid } | ConvertTo-Json -Depth 8
    exit 2
  }

  Write-State -State "activating" -Message "Codex Desktop is idle; activating the staged NapCat bridge."
  foreach ($ScriptName in @("stop-napcat-task-router.ps1", "stop-napcat-supervisor.ps1")) {
    $StopResult = & (Join-Path $OpsRoot $ScriptName) -DataRoot $DataRoot | ConvertFrom-Json
    if ($StopResult.stopped -ne $true) { throw "$ScriptName did not stop its managed process cleanly." }
  }
  $ProxyStopResult = & (Join-Path $OpsRoot "stop-codex-app-server-proxy.ps1") -DataRoot $DataRoot -ChildTimeoutSeconds 120 -AllowVerifiedForceStop | ConvertFrom-Json
  if ($ProxyStopResult.stopped -ne $true -or $ProxyStopResult.clean -ne $true) {
    throw "The managed proxy or App Server did not stop cleanly (proxyStopped=$($ProxyStopResult.stopped), childStopped=$($ProxyStopResult.childStopped), staleListener=$($ProxyStopResult.staleListener), orphanedListener=$($ProxyStopResult.orphanedListener), appServerPid=$($ProxyStopResult.appServerPid))."
  }
  if (-not [string]::IsNullOrWhiteSpace($BrokerRoot)) {
    & (Join-Path $OpsRoot "reload-broker-backend.ps1") -Endpoint napcat -BrokerRoot $BrokerRoot -AllowLegacyChildRecycle | Out-Null
  }
  & (Join-Path $OpsRoot "start-codex-app-server-proxy.ps1") -DataRoot $DataRoot | Out-Null
  $FinalStatus = & (Join-Path $OpsRoot "get-codex-app-server-proxy-status.ps1") -DataRoot $DataRoot | ConvertFrom-Json
  if ($FinalStatus.ok -ne $true -or $FinalStatus.runtime.state -ne "running" -or $FinalStatus.runtime.automationEnabled -ne $true) {
    throw "The staged proxy did not become healthy after activation."
  }
  $Restored = Restore-AutomationAfterDeferredActivation
  $SupervisorStart = $Restored.supervisor
  $RouterStart = $Restored.router
  $SupervisorStatus = & (Join-Path $OpsRoot "get-napcat-supervisor-status.ps1") -DataRoot $DataRoot -TaskName $SupervisorTaskName | ConvertFrom-Json
  if ($SupervisorStatus.alive -ne $true -or [int]$RouterStart.pid -le 0) {
    throw "The staged supervisor or task router did not become healthy after activation."
  }
  Set-ActivationMaintenance -Active $false
  $CodeRoot = Split-Path -Parent $OpsRoot
  $ServiceRoot = Split-Path -Parent $CodeRoot
  $ActivePointerPath = Join-Path $ServiceRoot "pointers\active.json"
  $LastKnownGoodPointerPath = Join-Path $ServiceRoot "pointers\last-known-good.json"
  if (Test-Path -LiteralPath $ActivePointerPath) {
    $ActivePointer = Get-Content -LiteralPath $ActivePointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ActivePointer | Add-Member -NotePropertyName verifiedAt -NotePropertyValue ((Get-Date).ToString("o")) -Force
    [System.IO.File]::WriteAllText($LastKnownGoodPointerPath, (($ActivePointer | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
  }
  if (Test-Path -LiteralPath $UpdateStatePath) {
    $UpdateState = Get-Content -LiteralPath $UpdateStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $UpdateState | Add-Member -NotePropertyName activated -NotePropertyValue $true -Force
    $UpdateState | Add-Member -NotePropertyName pendingActivation -NotePropertyValue $false -Force
    $UpdateState | Add-Member -NotePropertyName restartCodexRequired -NotePropertyValue $false -Force
    $UpdateState | Add-Member -NotePropertyName activatedProxyUrl -NotePropertyValue ([string]$FinalStatus.runtime.downstreamUrl) -Force
    $UpdateState | Add-Member -NotePropertyName activationCompletedAt -NotePropertyValue ((Get-Date).ToString("o")) -Force
    [System.IO.File]::WriteAllText($UpdateStatePath, (($UpdateState | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
  }
  Write-State -State "ready" -Message "NapCat bridge activation completed; Codex may be opened normally." -Details ([ordered]@{
    proxyPid = $FinalStatus.runtime.pid
    appServerPid = $FinalStatus.runtime.appServerPid
    downstreamUrl = $FinalStatus.runtime.downstreamUrl
    upstreamUrl = $FinalStatus.runtime.upstreamUrl
    supervisorPid = $SupervisorStart.pid
    taskRouterPid = $RouterStart.pid
  })
} catch {
  $Message = $_.Exception.Message
  $RestoreError = $null
  try { Restore-AutomationAfterDeferredActivation | Out-Null } catch { $RestoreError = $_.Exception.Message }
  Set-ActivationMaintenance -Active $false
  Write-State -State "failed" -Message $Message
  $Alert = [ordered]@{
    schemaVersion = 1
    pending = $true
    status = "pending"
    createdAt = (Get-Date).ToString("o")
    source = "codex-app-server-pending-activation"
    incidentKey = "codex-app-server-pending-activation-failed"
    code = "PENDING_ACTIVATION_FAILED"
    message = $Message
    text = "[Codex automatic wake upgrade failed]`n$Message`nCodex Desktop was not terminated; inspect the local activation state."
    automationRestoreError = $RestoreError
  }
  [System.IO.File]::WriteAllText($AlertPath, (($Alert | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
  exit 1
} finally {
  if ($null -ne $ActivationLockStream) { $ActivationLockStream.Dispose() }
}
