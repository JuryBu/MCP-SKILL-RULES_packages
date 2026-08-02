[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $(if ($env:CODEX_TOOLKIT_BROKER_ROOT) { $env:CODEX_TOOLKIT_BROKER_ROOT } else { Join-Path $env:USERPROFILE ".codex\mcp-http-broker" }),
  [string]$SupervisorTaskName = "CodexNapCatSupervisor",
  [ValidateRange(10, 600)][int]$QuiesceTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$BrokerRoot = [System.IO.Path]::GetFullPath($BrokerRoot).TrimEnd('\')
$StateRoot = Join-Path $DataRoot "state"
$UpdateStatePath = Join-Path $StateRoot "napcat-bridge-last-update.json"
$RegistryPath = Join-Path $StateRoot "task-registry.json"
$MaintenancePath = Join-Path $StateRoot "task-router.maintenance.json"
$AlertPath = Join-Path $StateRoot "automation-alert.json"
$LockPath = Join-Path $StateRoot "napcat-bridge-update.lock"
$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))

function Write-JsonAtomic {
  param([string]$Path, $Value)
  $Parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $TemporaryPath = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($TemporaryPath, (($Value | ConvertTo-Json -Depth 30) + "`n"), $Utf8NoBom)
  Move-Item -LiteralPath $TemporaryPath -Destination $Path -Force
}

function Read-JsonOrNull {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-ProtectedTaskSnapshot {
  param([string]$Path)
  $Registry = Read-JsonOrNull -Path $Path
  if ($null -eq $Registry) { return @() }
  $TaskValues = if ($Registry.tasks -is [System.Array]) {
    @($Registry.tasks)
  } elseif ($null -ne $Registry.tasks) {
    @($Registry.tasks.PSObject.Properties | ForEach-Object { $_.Value })
  } else {
    @()
  }
  return @($TaskValues | ForEach-Object {
    [ordered]@{
      taskId = [string]$_.taskId
      conversationId = [string]$_.conversationId
      localRole = [string]$_.localRole
      sourceMachine = [string]$_.sourceMachine
      targetMachine = [string]$_.targetMachine
      trustedPeerQq = [string]$_.trustedPeerQq
      generation = [int]$_.generation
      status = [string]$_.status
      lastSeenSeq = $_.lastSeenSeq
      lastAckedSeq = $_.lastAckedSeq
      lastSeenAt = $_.lastSeenAt
      lastAckedAt = $_.lastAckedAt
      wakeCooldownMs = $_.wakeCooldownMs
      wakePending = [bool]$_.wakePending
      wakeSentAt = $_.wakeSentAt
      wakeMessageSeq = $_.wakeMessageSeq
      wakeMessageAt = $_.wakeMessageAt
      activeWakeId = $_.activeWakeId
      wakePromptSha256 = $_.wakePromptSha256
      lastWakeAt = $_.lastWakeAt
      createdAt = $_.createdAt
      updatedAt = $_.updatedAt
    }
  } | Sort-Object taskId)
}

function Get-SnapshotJson {
  param($Snapshot)
  return ($Snapshot | ConvertTo-Json -Compress -Depth 20)
}

function Set-RollbackMaintenance {
  param([bool]$Active, [string]$Code, [string]$Message)
  $Maintenance = Read-JsonOrNull -Path $MaintenancePath
  if ($null -eq $Maintenance) { $Maintenance = [pscustomobject]@{ schemaVersion = 1; reasons = [pscustomobject]@{} } }
  if ($null -eq $Maintenance.reasons) { $Maintenance | Add-Member -NotePropertyName reasons -NotePropertyValue ([pscustomobject]@{}) -Force }
  if ($Active) {
    $Maintenance.reasons | Add-Member -NotePropertyName packageRollback -NotePropertyValue ([pscustomobject]@{
      at = (Get-Date).ToString("o"); code = $Code; message = $Message
    }) -Force
  } else {
    $Maintenance.reasons.PSObject.Properties.Remove("packageRollback")
  }
  $Maintenance | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToString("o")) -Force
  $Maintenance | Add-Member -NotePropertyName active -NotePropertyValue ($Maintenance.reasons.PSObject.Properties.Count -gt 0) -Force
  Write-JsonAtomic -Path $MaintenancePath -Value $Maintenance
}

if (-not (Test-Path -LiteralPath $UpdateStatePath)) { throw "No completed NapCat bridge update state was found." }
$UpdateState = Read-JsonOrNull -Path $UpdateStatePath
$CodeRoot = [System.IO.Path]::GetFullPath([string]$UpdateState.codeRoot).TrimEnd('\')
$BackupRoot = [System.IO.Path]::GetFullPath([string]$UpdateState.backupRoot).TrimEnd('\')
$PreviousCodeRoot = Join-Path $BackupRoot "previous-code"
$PreviousUserEnvironmentPath = Join-Path $BackupRoot "codex-app-server-user-env.json"
$PointersRoot = Join-Path (Split-Path -Parent $CodeRoot) "pointers"
$ActivePointerPath = Join-Path $PointersRoot "active.json"
$PreviousPointerPath = Join-Path $PointersRoot "previous.json"
$LastKnownGoodPointerPath = Join-Path $PointersRoot "last-known-good.json"
$PreviousPointer = Read-JsonOrNull -Path $PreviousPointerPath
$RestoreRoot = if ($PreviousPointer -and (Test-Path -LiteralPath ([string]$PreviousPointer.releaseRoot))) { [string]$PreviousPointer.releaseRoot } else { $PreviousCodeRoot }
$PrivateEnvBackupPath = Join-Path $BackupRoot "broker-private.env.json"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$PreviousUserEnvironment = Read-JsonOrNull -Path $PreviousUserEnvironmentPath
$PreviousUserAppServerWsUrl = if ($null -ne $PreviousUserEnvironment) { [string]$PreviousUserEnvironment.codexAppServerWsUrl } else { [string]$UpdateState.previousUserAppServerWsUrl }
$ReloadHelperPath = Join-Path $BackupRoot "rollback-reload-broker-backend.ps1"
$CurrentReloadScript = Join-Path $CodeRoot "ops\reload-broker-backend.ps1"
if (-not (Test-Path -LiteralPath $RestoreRoot)) { throw "Rollback code backup is missing: $RestoreRoot" }
if (-not (Test-Path -LiteralPath $ReloadHelperPath) -and (Test-Path -LiteralPath $CurrentReloadScript)) {
  Copy-Item -LiteralPath $CurrentReloadScript -Destination $ReloadHelperPath -Force
}
if (-not (Test-Path -LiteralPath $ReloadHelperPath)) { throw "Rollback backend reload helper is missing." }

$LockStream = $null
try {
  $LockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  Set-RollbackMaintenance -Active $true -Code "PACKAGE_ROLLBACK" -Message "NapCat bridge rollback is in progress; automatic wake is paused."

  $ProxyStatusScript = Join-Path $CodeRoot "ops\get-codex-app-server-proxy-status.ps1"
  if (Test-Path -LiteralPath $ProxyStatusScript) {
    $ProxyStatus = & $ProxyStatusScript -DataRoot $DataRoot | ConvertFrom-Json
    if ($ProxyStatus.ok -eq $true -and $null -ne $ProxyStatus.control -and [int]$ProxyStatus.control.clientCount -gt 0) {
      throw "Codex Desktop is still connected to the managed proxy; exit Codex normally before rollback."
    }
  }
  $StopWatchdogScript = Join-Path $CodeRoot "ops\stop-napcat-supervisor-watchdog.ps1"
  if (Test-Path -LiteralPath $StopWatchdogScript) {
    & $StopWatchdogScript -DataRoot $DataRoot -TaskName $SupervisorTaskName | Out-Null
  }

  $Deadline = [DateTime]::UtcNow.AddSeconds($QuiesceTimeoutSeconds)
  do {
    $Current = Get-ProtectedTaskSnapshot -Path $RegistryPath
    $Busy = @($Current | Where-Object { $_.wakePending -or -not [string]::IsNullOrWhiteSpace([string]$_.activeWakeId) })
    if ($Busy.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $Deadline)
  if ($Busy.Count -gt 0) { throw "Open task wake processing did not become idle before rollback timeout." }

  foreach ($ScriptName in @("stop-napcat-task-router.ps1", "stop-napcat-supervisor.ps1", "stop-codex-app-server-proxy.ps1")) {
    $ScriptPath = Join-Path $CodeRoot "ops\$ScriptName"
    if (Test-Path -LiteralPath $ScriptPath) {
      $StopResult = if ($ScriptName -eq "stop-codex-app-server-proxy.ps1") {
        & $ScriptPath -DataRoot $DataRoot -AllowVerifiedForceStop | ConvertFrom-Json
      } else {
        & $ScriptPath -DataRoot $DataRoot | ConvertFrom-Json
      }
      if ($StopResult.stopped -ne $true) { throw "$ScriptName did not stop its managed process." }
      if ($ScriptName -eq "stop-codex-app-server-proxy.ps1" -and $StopResult.clean -ne $true) {
        throw "$ScriptName left a managed process or listener behind."
      }
    }
  }
  $BeforeSnapshot = Get-ProtectedTaskSnapshot -Path $RegistryPath

  if ($PSCmdlet.ShouldProcess($CodeRoot, "restore the previous validated NapCat bridge code")) {
    foreach ($Name in @("src", "ops", "test", "README.md", "package.json", "package-lock.json", "release-manifest.json")) {
      $Target = Join-Path $CodeRoot $Name
      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
      $Source = Join-Path $RestoreRoot $Name
      if (Test-Path -LiteralPath $Source) { Copy-Item -LiteralPath $Source -Destination $CodeRoot -Recurse -Force }
    }
    if (Test-Path -LiteralPath $PrivateEnvBackupPath) { Copy-Item -LiteralPath $PrivateEnvBackupPath -Destination $PrivateEnvPath -Force }
    Push-Location $CodeRoot
    try {
      & npm ci | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed while restoring the previous release." }
      & npm run check | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "Restored release syntax validation failed." }
    } finally { Pop-Location }
    if ($PreviousPointer) {
      Write-JsonAtomic -Path $ActivePointerPath -Value $PreviousPointer
      Write-JsonAtomic -Path $LastKnownGoodPointerPath -Value $PreviousPointer
    } else {
      Remove-Item -LiteralPath $ActivePointerPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $LastKnownGoodPointerPath -Force -ErrorAction SilentlyContinue
    }
  }

  [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $PreviousUserAppServerWsUrl, "User")
  & $ReloadHelperPath -Endpoint napcat -BrokerRoot $BrokerRoot -AllowLegacyChildRecycle | Out-Null

  $RestoredProxyStartScript = Join-Path $CodeRoot "ops\start-codex-app-server-proxy.ps1"
  if ((-not [string]::IsNullOrWhiteSpace($PreviousUserAppServerWsUrl)) -and (Test-Path -LiteralPath $RestoredProxyStartScript)) {
    & $RestoredProxyStartScript -DataRoot $DataRoot | Out-Null
  }
  $RestoredSupervisorStartScript = Join-Path $CodeRoot "ops\start-napcat-supervisor.ps1"
  if (Test-Path -LiteralPath $RestoredSupervisorStartScript) {
    & $RestoredSupervisorStartScript -DataRoot $DataRoot -BrokerRoot $BrokerRoot | Out-Null
  }

  $AfterSnapshot = Get-ProtectedTaskSnapshot -Path $RegistryPath
  if ((Get-SnapshotJson $BeforeSnapshot) -ne (Get-SnapshotJson $AfterSnapshot)) {
    throw "Protected task routing or progress fields changed during rollback."
  }
  Set-RollbackMaintenance -Active $false
  $RestoredTaskRouterScript = Join-Path $CodeRoot "ops\start-napcat-task-router.ps1"
  if (Test-Path -LiteralPath $RestoredTaskRouterScript) {
    & $RestoredTaskRouterScript -DataRoot $DataRoot | Out-Null
  }
  if ($null -ne (Get-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction SilentlyContinue)) {
    Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction Stop
  }

  [pscustomobject]@{
    ok = $true
    rolledBackAt = (Get-Date).ToString("o")
    codeRoot = $CodeRoot
    backupRoot = $BackupRoot
    restoredReleaseRoot = $RestoreRoot
    brokerPreserved = $true
    taskRegistryPreserved = $true
    previousUserAppServerWsUrl = $PreviousUserAppServerWsUrl
    restartCodexRequired = $true
  } | ConvertTo-Json -Depth 10
} catch {
  $Failure = $_.Exception.Message
  Set-RollbackMaintenance -Active $true -Code "PACKAGE_ROLLBACK_FAILED" -Message $Failure
  Write-JsonAtomic -Path $AlertPath -Value ([ordered]@{
    schemaVersion = 1
    pending = $true
    status = "pending"
    source = "napcat-bridge-rollback"
    incidentKey = "package-rollback-$Stamp"
    createdAt = (Get-Date).ToString("o")
    code = "PACKAGE_ROLLBACK_FAILED"
    message = $Failure
    text = "[Codex automation paused] NapCat bridge rollback failed. Inspect local state; the task registry remains preserved."
  })
  throw
} finally {
  try { Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction SilentlyContinue } catch {}
  if ($null -ne $LockStream) { $LockStream.Dispose() }
}
