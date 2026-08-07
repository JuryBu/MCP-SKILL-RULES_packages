[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$CodeRoot = $(if ($env:NAPCAT_MCP_ROOT) { $env:NAPCAT_MCP_ROOT } else { Join-Path $env:USERPROFILE ".codex\services\napcat-bridge\current" }),
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $(if ($env:CODEX_TOOLKIT_BROKER_ROOT) { $env:CODEX_TOOLKIT_BROKER_ROOT } else { Join-Path $env:USERPROFILE ".codex\mcp-http-broker" }),
  [string]$SourceCommit = "unknown",
  [string]$SupervisorTaskName = "CodexNapCatSupervisor",
  [ValidateRange(10, 600)][int]$QuiesceTimeoutSeconds = 120,
  [bool]$ActivateNow = $true,
  [switch]$MigrateAutostart,
  [switch]$AllowLegacyMixedRoot,
  [switch]$PreserveActiveWakes,
  [switch]$BackendOnlyHotReload,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$CodeRoot = [System.IO.Path]::GetFullPath($CodeRoot).TrimEnd('\')
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$BrokerRoot = [System.IO.Path]::GetFullPath($BrokerRoot).TrimEnd('\')
$StateRoot = Join-Path $DataRoot "state"
$ServiceRoot = Split-Path -Parent $CodeRoot
$ReleasesRoot = Join-Path $ServiceRoot "releases"
$PointersRoot = Join-Path $ServiceRoot "pointers"
$ActivePointerPath = Join-Path $PointersRoot "active.json"
$PreviousPointerPath = Join-Path $PointersRoot "previous.json"
$LastKnownGoodPointerPath = Join-Path $PointersRoot "last-known-good.json"
$RegistryPath = Join-Path $StateRoot "task-registry.json"
$MaintenancePath = Join-Path $StateRoot "task-router.maintenance.json"
$AlertPath = Join-Path $StateRoot "automation-alert.json"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$BackupRoot = Join-Path $env:USERPROFILE ".codex\backups\napcat-bridge-update-$Stamp"
$CandidateRoot = Join-Path $BackupRoot "candidate"
$PreviousCodeRoot = Join-Path $BackupRoot "previous-code"
$PreviousUserEnvironmentPath = Join-Path $BackupRoot "codex-app-server-user-env.json"
$UpdateStatePath = Join-Path $StateRoot "napcat-bridge-last-update.json"
$LockPath = Join-Path $StateRoot "napcat-bridge-update.lock"
$PackageMetadata = Get-Content -LiteralPath (Join-Path $SourceRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$PackageLockHash = (Get-FileHash -LiteralPath (Join-Path $SourceRoot "package-lock.json") -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 12)
$SourceTreeFiles = @()
foreach ($Name in @("src", "ops", "test", "README.md", "package.json", "package-lock.json")) {
  $SourcePath = Join-Path $SourceRoot $Name
  if (Test-Path -LiteralPath $SourcePath -PathType Container) {
    $SourceTreeFiles += Get-ChildItem -LiteralPath $SourcePath -File -Recurse
  } elseif (Test-Path -LiteralPath $SourcePath -PathType Leaf) {
    $SourceTreeFiles += Get-Item -LiteralPath $SourcePath
  }
}
$SourceTreeDescriptor = @($SourceTreeFiles | Sort-Object FullName | ForEach-Object {
  $RelativePath = $_.FullName.Substring($SourceRoot.Length).TrimStart('\').Replace('\', '/')
  "$RelativePath`:$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
}) -join "`n"
$SourceTreeHasher = [System.Security.Cryptography.SHA256]::Create()
try {
  $SourceTreeHash = ([System.BitConverter]::ToString($SourceTreeHasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($SourceTreeDescriptor)))).Replace("-", "").ToLowerInvariant()
} finally {
  $SourceTreeHasher.Dispose()
}
$CommitLabel = ($SourceCommit -replace '[^A-Za-z0-9._-]', '-').Trim('-')
if ([string]::IsNullOrWhiteSpace($CommitLabel)) { $CommitLabel = "unknown" }
$ReleaseId = "napcat-$($PackageMetadata.version)-$CommitLabel-$PackageLockHash-$($SourceTreeHash.Substring(0, 12))"
$ReleaseRoot = Join-Path $ReleasesRoot $ReleaseId

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

function Resolve-McpSdkRoot {
  $PrivateEnv = Read-JsonOrNull -Path $PrivateEnvPath
  $BrokerRoots = @(
    [string]$env:CODEX_TOOLKIT_BROKER_ROOT,
    [string]$PrivateEnv.CODEX_TOOLKIT_BROKER_ROOT,
    [string]$BrokerRoot
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique
  $ToolkitRoots = @($BrokerRoots | ForEach-Object {
    Split-Path -Parent ([System.IO.Path]::GetFullPath([string]$_))
  } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
  $BrokerSdkCandidates = @($ToolkitRoots | ForEach-Object {
    Join-Path ([string]$_) "memory-store\node_modules\@modelcontextprotocol\sdk\dist\esm"
    Join-Path ([string]$_) "services\memory-store\node_modules\@modelcontextprotocol\sdk\dist\esm"
  })
  $Candidates = @(
    [string]$env:MCP_SDK_ROOT,
    [string]$PrivateEnv.MCP_SDK_ROOT,
    $(if (-not [string]::IsNullOrWhiteSpace([string]$PrivateEnv.MEMORY_STORE_MCP_ROOT)) { Join-Path ([string]$PrivateEnv.MEMORY_STORE_MCP_ROOT) "node_modules\@modelcontextprotocol\sdk\dist\esm" }),
    $(if (-not [string]::IsNullOrWhiteSpace([string]$PrivateEnv.CODEX_TOOLKIT_MCP_ROOT)) { Join-Path ([string]$PrivateEnv.CODEX_TOOLKIT_MCP_ROOT) "memory-store\node_modules\@modelcontextprotocol\sdk\dist\esm" })
  ) + $BrokerSdkCandidates
  foreach ($Candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace([string]$Candidate)) { continue }
    $Resolved = [System.IO.Path]::GetFullPath([string]$Candidate)
    if ((Test-Path -LiteralPath (Join-Path $Resolved "server\index.js")) -and (Test-Path -LiteralPath (Join-Path $Resolved "types.js"))) {
      return $Resolved
    }
  }
  return $null
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
      ledgerInitialized = $_.ledgerInitialized
      messageLedger = $_.messageLedger
      wakeBatches = $_.wakeBatches
      createdAt = $_.createdAt
      updatedAt = $_.updatedAt
    }
  } | Sort-Object taskId)
}

function Get-SnapshotJson {
  param($Snapshot)
  return ($Snapshot | ConvertTo-Json -Compress -Depth 20)
}

function Set-UpdateMaintenance {
  param([bool]$Active, [string]$Code, [string]$Message)
  $Maintenance = Read-JsonOrNull -Path $MaintenancePath
  if ($null -eq $Maintenance) { $Maintenance = [pscustomobject]@{ schemaVersion = 1; reasons = [pscustomobject]@{} } }
  if ($null -eq $Maintenance.reasons) { $Maintenance | Add-Member -NotePropertyName reasons -NotePropertyValue ([pscustomobject]@{}) -Force }
  if ($Active) {
    $Maintenance.reasons | Add-Member -NotePropertyName packageUpdate -NotePropertyValue ([pscustomobject]@{
      at = (Get-Date).ToString("o"); code = $Code; message = $Message
    }) -Force
  } else {
    $Maintenance.reasons.PSObject.Properties.Remove("packageUpdate")
  }
  $Maintenance | Add-Member -NotePropertyName updatedAt -NotePropertyValue ((Get-Date).ToString("o")) -Force
  $Maintenance | Add-Member -NotePropertyName active -NotePropertyValue ($Maintenance.reasons.PSObject.Properties.Count -gt 0) -Force
  Write-JsonAtomic -Path $MaintenancePath -Value $Maintenance
}

function Resolve-StaleUpdateAlert {
  $Alert = Read-JsonOrNull -Path $AlertPath
  if ($null -eq $Alert -or $Alert.pending -ne $true -or [string]$Alert.code -ne "PACKAGE_UPDATE_FAILED") { return }
  $Alert | Add-Member -NotePropertyName pending -NotePropertyValue $false -Force
  $Alert | Add-Member -NotePropertyName status -NotePropertyValue "superseded" -Force
  $Alert | Add-Member -NotePropertyName supersededAt -NotePropertyValue ((Get-Date).ToString("o")) -Force
  $Alert | Add-Member -NotePropertyName supersededBy -NotePropertyValue "package-update-$Stamp" -Force
  Write-JsonAtomic -Path $AlertPath -Value $Alert
}

function Invoke-NpmChecked {
  param([string]$Root, [string[]]$Arguments, [string]$McpSdkRoot = $null)
  Push-Location $Root
  $PreviousMcpSdkRoot = $env:MCP_SDK_ROOT
  try {
    if (-not [string]::IsNullOrWhiteSpace($McpSdkRoot)) { $env:MCP_SDK_ROOT = $McpSdkRoot }
    & npm @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
  } finally {
    $env:MCP_SDK_ROOT = $PreviousMcpSdkRoot
    Pop-Location
  }
}

function Get-NormalizedTextHash {
  param([string]$Path)
  $Text = [System.IO.File]::ReadAllText($Path)
  $Normalized = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
  $Encoding = New-Object System.Text.UTF8Encoding($false)
  $Bytes = $Encoding.GetBytes($Normalized)
  $Sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($Sha256.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $Sha256.Dispose()
  }
}

function Assert-BackendOnlyCompatible {
  param([string]$PreviousRoot, [string]$NextRoot)
  if (-not (Test-Path -LiteralPath $PreviousRoot)) {
    throw "Backend-only hot reload requires an existing installed code snapshot."
  }
  foreach ($RelativePath in @(
    "src\codex-app-server-proxy.mjs",
    "src\codex-app-server-proxy-runner.mjs",
    "ops\start-codex-app-server-proxy.ps1",
    "ops\stop-codex-app-server-proxy.ps1",
    "ops\get-codex-app-server-proxy-status.ps1"
  )) {
    $PreviousPath = Join-Path $PreviousRoot $RelativePath
    $NextPath = Join-Path $NextRoot $RelativePath
    if (-not (Test-Path -LiteralPath $PreviousPath) -or -not (Test-Path -LiteralPath $NextPath)) {
      throw "Backend-only hot reload is unsafe because a proxy-critical file is missing: $RelativePath"
    }
    $PreviousHash = Get-NormalizedTextHash -Path $PreviousPath
    $NextHash = Get-NormalizedTextHash -Path $NextPath
    if ($PreviousHash -ne $NextHash) {
      throw "Backend-only hot reload is unsafe because a proxy-critical file changed: $RelativePath"
    }
  }
}

function Copy-CodeTree {
  param([string]$From, [string]$To)
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  foreach ($Name in @("src", "ops", "test", "README.md", "package.json", "package-lock.json", "release-manifest.json")) {
    $Source = Join-Path $From $Name
    if (Test-Path -LiteralPath $Source) { Copy-Item -LiteralPath $Source -Destination $To -Recurse -Force }
  }
}

function Restore-CodeTree {
  param([string]$From, [string]$To)
  foreach ($Name in @("src", "ops", "test", "README.md", "package.json", "package-lock.json", "release-manifest.json")) {
    $Target = Join-Path $To $Name
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
  }
  Copy-CodeTree -From $From -To $To
  if (Test-Path -LiteralPath (Join-Path $To "package-lock.json")) { Invoke-NpmChecked -Root $To -Arguments @("ci") }
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot "package.json"))) { throw "NapCat MCP source root is invalid: $SourceRoot" }
if ($CodeRoot -eq $DataRoot -and -not $AllowLegacyMixedRoot) {
  throw "CodeRoot and DataRoot must be separate. Use -AllowLegacyMixedRoot only for a guarded one-time legacy migration."
}
if ($BackendOnlyHotReload -and -not $ActivateNow) {
  throw "BackendOnlyHotReload requires ActivateNow=true because it performs the complete guarded backend activation in this invocation."
}
$ValidationMcpSdkRoot = Resolve-McpSdkRoot
if ([string]::IsNullOrWhiteSpace($ValidationMcpSdkRoot)) {
  throw "Cannot validate the NapCat MCP candidate because the broker MCP SDK path is unavailable. Check MCP_SDK_ROOT, MEMORY_STORE_MCP_ROOT, or CODEX_TOOLKIT_BROKER_ROOT before entering maintenance."
}
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
try {
  Copy-CodeTree -From $SourceRoot -To $CandidateRoot
  Invoke-NpmChecked -Root $CandidateRoot -Arguments @("ci") -McpSdkRoot $ValidationMcpSdkRoot
  Invoke-NpmChecked -Root $CandidateRoot -Arguments @("run", "check") -McpSdkRoot $ValidationMcpSdkRoot
  Invoke-NpmChecked -Root $CandidateRoot -Arguments @("test") -McpSdkRoot $ValidationMcpSdkRoot
} catch {
  try { Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  throw
}
if ($ValidateOnly) {
  [pscustomobject]@{
    schemaVersion = 1
    candidateValidated = $true
    sourceCommit = $SourceCommit
    sourceRoot = $SourceRoot
    sourceTreeSha256 = $SourceTreeHash
    validationMcpSdkRoot = $ValidationMcpSdkRoot
    validatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 8
  try { Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  return
}
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
New-Item -ItemType Directory -Force -Path $ReleasesRoot | Out-Null
New-Item -ItemType Directory -Force -Path $PointersRoot | Out-Null
$LockStream = $null
$PrivateEnvBackupPath = $null
$BeforeSnapshot = $null
$Activated = $false
$CodeInstallStarted = $false
$BrokerBackendReloaded = $false
$ProxyLifecycleTouched = $false
$RouterStopped = $false
$SupervisorStopped = $false
$WatchdogStopped = $false
$PreviousPointer = Read-JsonOrNull -Path $ActivePointerPath
$PreviousUserAppServerWsUrl = [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "User")

try {
  $LockStream = [System.IO.File]::Open($LockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  if (Test-Path -LiteralPath $RegistryPath) { Copy-Item -LiteralPath $RegistryPath -Destination (Join-Path $BackupRoot "task-registry.json") -Force }
  if (Test-Path -LiteralPath $MaintenancePath) { Copy-Item -LiteralPath $MaintenancePath -Destination (Join-Path $BackupRoot "task-router.maintenance.json") -Force }
  Write-JsonAtomic -Path $PreviousUserEnvironmentPath -Value ([ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToString("o")
    codexAppServerWsUrl = $PreviousUserAppServerWsUrl
  })
  if (Test-Path -LiteralPath $PrivateEnvPath) {
    $PrivateEnvBackupPath = Join-Path $BackupRoot "broker-private.env.json"
    Copy-Item -LiteralPath $PrivateEnvPath -Destination $PrivateEnvBackupPath -Force
  }
  $BeforeSnapshot = Get-ProtectedTaskSnapshot -Path $RegistryPath
  Set-UpdateMaintenance -Active $true -Code "PACKAGE_UPDATE" -Message "NapCat bridge update is validating and switching code; automatic wake is paused."

  $Current = Get-ProtectedTaskSnapshot -Path $RegistryPath
  $Busy = @($Current | Where-Object { $_.wakePending -or -not [string]::IsNullOrWhiteSpace([string]$_.activeWakeId) })
  $PreservedActiveWakeCount = 0
  if ($Busy.Count -gt 0 -and $PreserveActiveWakes) {
    $RouterStopScript = Join-Path $CodeRoot "ops\stop-napcat-task-router.ps1"
    if (-not (Test-Path -LiteralPath $RouterStopScript)) {
      throw "Cannot preserve active wakes because the installed task-router stop script is missing: $RouterStopScript"
    }
    $RouterStopResult = & $RouterStopScript -DataRoot $DataRoot | ConvertFrom-Json
    if ($RouterStopResult.stopped -ne $true) {
      throw "Cannot preserve active wakes because the task router did not stop within the guarded timeout."
    }
    $RouterStopped = $true
    $AfterRouterStopSnapshot = Get-ProtectedTaskSnapshot -Path $RegistryPath
    if ((Get-SnapshotJson $BeforeSnapshot) -ne (Get-SnapshotJson $AfterRouterStopSnapshot)) {
      throw "Protected task routing, message ledger, or wake state changed while stopping the task router."
    }
    $BeforeSnapshot = $AfterRouterStopSnapshot
    $PreservedActiveWakeCount = $Busy.Count
  } else {
    $Deadline = [DateTime]::UtcNow.AddSeconds($QuiesceTimeoutSeconds)
    do {
      $Current = Get-ProtectedTaskSnapshot -Path $RegistryPath
      $Busy = @($Current | Where-Object { $_.wakePending -or -not [string]::IsNullOrWhiteSpace([string]$_.activeWakeId) })
      if ($Busy.Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $Deadline)
    if ($Busy.Count -gt 0) { throw "Open task wake processing did not become idle before the update timeout. Use -PreserveActiveWakes only when those durable wake records must survive the guarded switch unchanged." }
    $BeforeSnapshot = Get-ProtectedTaskSnapshot -Path $RegistryPath
  }

  if (-not (Test-Path -LiteralPath $ReleaseRoot)) {
    Copy-CodeTree -From $CandidateRoot -To $ReleaseRoot
    Write-JsonAtomic -Path (Join-Path $ReleaseRoot "release-manifest.json") -Value ([ordered]@{
      schemaVersion = 1; releaseId = $ReleaseId; version = [string]$PackageMetadata.version; sourceCommit = $SourceCommit; packageLockSha256 = $PackageLockHash; sourceTreeSha256 = $SourceTreeHash; createdAt = (Get-Date).ToString("o")
    })
  }

  if (Test-Path -LiteralPath $CodeRoot) { Copy-CodeTree -From $CodeRoot -To $PreviousCodeRoot }
  if ($BackendOnlyHotReload) { Assert-BackendOnlyCompatible -PreviousRoot $PreviousCodeRoot -NextRoot $ReleaseRoot }
  if ($PSCmdlet.ShouldProcess($CodeRoot, "install validated NapCat bridge candidate")) {
    $CodeInstallStarted = $true
    Copy-CodeTree -From $ReleaseRoot -To $CodeRoot
    Invoke-NpmChecked -Root $CodeRoot -Arguments @("ci") -McpSdkRoot $ValidationMcpSdkRoot
  }
  if ($null -ne $PreviousPointer) { Write-JsonAtomic -Path $PreviousPointerPath -Value $PreviousPointer }
  Write-JsonAtomic -Path $ActivePointerPath -Value ([ordered]@{
    schemaVersion = 1; releaseId = $ReleaseId; releaseRoot = $ReleaseRoot; codeRoot = $CodeRoot; activatedAt = (Get-Date).ToString("o"); sourceCommit = $SourceCommit
  })

  $PrivateEnv = Read-JsonOrNull -Path $PrivateEnvPath
  if ($null -eq $PrivateEnv) { $PrivateEnv = [pscustomobject]@{} }
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_MCP_ROOT -NotePropertyValue $CodeRoot -Force
  $PrivateEnv | Add-Member -NotePropertyName CODEX_TOOLKIT_NAPCAT_DATA_ROOT -NotePropertyValue $DataRoot -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_MCP_BINDING_PATH -NotePropertyValue (Join-Path $DataRoot "binding.json") -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_MCP_STATE_PATH -NotePropertyValue (Join-Path $StateRoot "dedupe.json") -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_REGISTRY_PATH -NotePropertyValue $RegistryPath -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_ROUTER_RUNTIME_PATH -NotePropertyValue (Join-Path $StateRoot "task-router-runtime.json") -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_ROUTER_LOG_PATH -NotePropertyValue (Join-Path $StateRoot "task-router.jsonl") -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_ROUTER_STOP_PATH -NotePropertyValue (Join-Path $StateRoot "task-router.stop") -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_ROUTER_LOCK_PATH -NotePropertyValue (Join-Path $StateRoot "task-router.lock") -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_ROUTER_MAINTENANCE_PATH -NotePropertyValue $MaintenancePath -Force
  $PrivateEnv | Add-Member -NotePropertyName NAPCAT_TASK_ROUTER_ALERT_PATH -NotePropertyValue $AlertPath -Force
  if ([string]::IsNullOrWhiteSpace([string]$PrivateEnv.CODEX_MCP_BROKER_CONTROL_TOKEN)) {
    [byte[]]$ControlTokenBytes = New-Object byte[] 32
    $Random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Random.GetBytes($ControlTokenBytes) } finally { $Random.Dispose() }
    $PrivateEnv | Add-Member -NotePropertyName CODEX_MCP_BROKER_CONTROL_TOKEN -NotePropertyValue ([Convert]::ToBase64String($ControlTokenBytes)) -Force
  }
  Write-JsonAtomic -Path $PrivateEnvPath -Value $PrivateEnv

  if ($ActivateNow) {
    if ($BackendOnlyHotReload) {
      $StopWatchdogScript = Join-Path $CodeRoot "ops\stop-napcat-supervisor-watchdog.ps1"
      if (-not (Test-Path -LiteralPath $StopWatchdogScript)) {
        throw "Installed watchdog stop script is missing: $StopWatchdogScript"
      }
      & $StopWatchdogScript -DataRoot $DataRoot -TaskName $SupervisorTaskName | Out-Null
      $WatchdogStopped = $true
      foreach ($ScriptName in @("stop-napcat-task-router.ps1", "stop-napcat-supervisor.ps1")) {
        $ScriptPath = Join-Path $CodeRoot "ops\$ScriptName"
        if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "Installed stop script is missing: $ScriptPath" }
        $StopResult = & $ScriptPath -DataRoot $DataRoot | ConvertFrom-Json
        if ($StopResult.stopped -ne $true) { throw "$ScriptName did not stop its managed process within the guarded timeout." }
        if ($ScriptName -eq "stop-napcat-task-router.ps1") { $RouterStopped = $true }
        if ($ScriptName -eq "stop-napcat-supervisor.ps1") { $SupervisorStopped = $true }
      }
      if ($MigrateAutostart) {
        & (Join-Path $CodeRoot "ops\install-napcat-autostart.ps1") -DataRoot $DataRoot -BrokerRoot $BrokerRoot -TaskName $SupervisorTaskName | Out-Null
      }
      $BrokerBackendReloaded = $true
      & (Join-Path $CodeRoot "ops\reload-broker-backend.ps1") -Endpoint napcat -BrokerRoot $BrokerRoot -AllowLegacyChildRecycle | Out-Null
      $ProxyStatus = & (Join-Path $CodeRoot "ops\get-codex-app-server-proxy-status.ps1") -DataRoot $DataRoot | ConvertFrom-Json
      if ($ProxyStatus.ok -ne $true -or [string]$ProxyStatus.runtime.state -ne "running") {
        throw "Existing transparent proxy did not remain healthy during the backend-only hot reload."
      }
      $Activated = $true
    } else {
    $ExistingProxyRuntimePath = Join-Path $StateRoot "codex-app-server-proxy-runtime.json"
    $ExistingProxyStatusScript = Join-Path $CodeRoot "ops\get-codex-app-server-proxy-status.ps1"
    if (Test-Path -LiteralPath $ExistingProxyRuntimePath) {
      if (-not (Test-Path -LiteralPath $ExistingProxyStatusScript)) {
        throw "Cannot prove that the current Codex proxy is idle; stage the update with -ActivateNow:`$false."
      }
      $ExistingProxyStatus = & $ExistingProxyStatusScript -DataRoot $DataRoot | ConvertFrom-Json
      if ($ExistingProxyStatus.ok -ne $true) {
        throw "Cannot prove that the current Codex proxy is idle; stage the update with -ActivateNow:`$false."
      }
      if ([int]$ExistingProxyStatus.control.clientCount -gt 0) {
        throw "Codex Desktop is still connected to the managed proxy; stage the update with -ActivateNow:`$false and activate after Codex exits normally."
      }
    }
    $StopWatchdogScript = Join-Path $CodeRoot "ops\stop-napcat-supervisor-watchdog.ps1"
    if (-not (Test-Path -LiteralPath $StopWatchdogScript)) {
      throw "Installed watchdog stop script is missing: $StopWatchdogScript"
    }
    & $StopWatchdogScript -DataRoot $DataRoot -TaskName $SupervisorTaskName | Out-Null
    $WatchdogStopped = $true
    foreach ($ScriptName in @("stop-napcat-task-router.ps1", "stop-napcat-supervisor.ps1", "stop-codex-app-server-proxy.ps1")) {
      $ScriptPath = Join-Path $CodeRoot "ops\$ScriptName"
      if (Test-Path -LiteralPath $ScriptPath) {
        $StopResult = if ($ScriptName -eq "stop-codex-app-server-proxy.ps1") {
          $ProxyLifecycleTouched = $true
          & $ScriptPath -DataRoot $DataRoot -AllowVerifiedForceStop | ConvertFrom-Json
        } else {
          & $ScriptPath -DataRoot $DataRoot | ConvertFrom-Json
        }
        if ($StopResult.stopped -ne $true) { throw "$ScriptName did not stop its managed process within the guarded timeout." }
        if ($ScriptName -eq "stop-napcat-task-router.ps1") { $RouterStopped = $true }
        if ($ScriptName -eq "stop-napcat-supervisor.ps1") { $SupervisorStopped = $true }
        if ($ScriptName -eq "stop-codex-app-server-proxy.ps1" -and $StopResult.clean -ne $true) {
          throw "$ScriptName left a managed App Server process or listener behind."
        }
      }
    }
    if ($MigrateAutostart) {
      & (Join-Path $CodeRoot "ops\install-napcat-autostart.ps1") -DataRoot $DataRoot -BrokerRoot $BrokerRoot -TaskName $SupervisorTaskName | Out-Null
    }
    $BrokerBackendReloaded = $true
    & (Join-Path $CodeRoot "ops\reload-broker-backend.ps1") -Endpoint napcat -BrokerRoot $BrokerRoot -AllowLegacyChildRecycle | Out-Null
    $ProxyLifecycleTouched = $true
    & (Join-Path $CodeRoot "ops\start-codex-app-server-proxy.ps1") -DataRoot $DataRoot | Out-Null
    $ProxyStatus = & (Join-Path $CodeRoot "ops\get-codex-app-server-proxy-status.ps1") -DataRoot $DataRoot | ConvertFrom-Json
    if ($ProxyStatus.ok -ne $true -or [string]$ProxyStatus.runtime.state -ne "running") { throw "Validated proxy did not become healthy after activation." }
    [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", [string]$ProxyStatus.runtime.downstreamUrl, "User")
    $Activated = $true
    }
  }

  $AfterSnapshot = Get-ProtectedTaskSnapshot -Path $RegistryPath
  if ((Get-SnapshotJson $BeforeSnapshot) -ne (Get-SnapshotJson $AfterSnapshot)) {
    throw "Protected task routing or progress fields changed during the guarded update."
  }
  if ($Activated) {
    Write-JsonAtomic -Path $LastKnownGoodPointerPath -Value ([ordered]@{
      schemaVersion = 1; releaseId = $ReleaseId; releaseRoot = $ReleaseRoot; codeRoot = $CodeRoot; verifiedAt = (Get-Date).ToString("o"); sourceCommit = $SourceCommit
    })
    Set-UpdateMaintenance -Active $false
    Resolve-StaleUpdateAlert
    & (Join-Path $CodeRoot "ops\start-napcat-supervisor.ps1") -DataRoot $DataRoot -BrokerRoot $BrokerRoot | Out-Null
    if ($null -ne (Get-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction SilentlyContinue)) {
      Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction Stop
    }
  } else {
    Set-UpdateMaintenance -Active $true -Code "PACKAGE_UPDATE_PENDING_ACTIVATION" -Message "Validated code is staged; automatic wake remains paused until guarded activation completes."
  }
  $ActivatedProxyUrl = if ($Activated) { [string]$ProxyStatus.runtime.downstreamUrl } else { $null }
  $Result = [ordered]@{
    schemaVersion = 1
    completedAt = (Get-Date).ToString("o")
    sourceCommit = $SourceCommit
    sourceRoot = $SourceRoot
    codeRoot = $CodeRoot
    dataRoot = $DataRoot
    brokerRoot = $BrokerRoot
    backupRoot = $BackupRoot
    releaseId = $ReleaseId
    releaseRoot = $ReleaseRoot
    activated = $Activated
    pendingActivation = (-not $Activated)
    restartCodexRequired = (-not $BackendOnlyHotReload)
    protectedTaskCount = @($AfterSnapshot).Count
    preservedActiveWakeCount = $PreservedActiveWakeCount
    backendOnlyHotReload = [bool]$BackendOnlyHotReload
    previousUserAppServerWsUrl = $PreviousUserAppServerWsUrl
    activatedProxyUrl = $ActivatedProxyUrl
  }
  Write-JsonAtomic -Path $UpdateStatePath -Value $Result
  [pscustomobject]$Result | ConvertTo-Json -Depth 12
} catch {
  $Failure = $_.Exception.Message
  try { [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $PreviousUserAppServerWsUrl, "User") } catch {}
  $RollbackStopScripts = @()
  if ($CodeInstallStarted -or $BrokerBackendReloaded) {
    $RollbackStopScripts += @("stop-napcat-task-router.ps1", "stop-napcat-supervisor.ps1")
  }
  if ($ProxyLifecycleTouched) { $RollbackStopScripts += "stop-codex-app-server-proxy.ps1" }
  foreach ($ScriptName in $RollbackStopScripts) {
    $ScriptPath = Join-Path $CandidateRoot "ops\$ScriptName"
    if (Test-Path -LiteralPath $ScriptPath) {
      try {
        if ($ScriptName -eq "stop-codex-app-server-proxy.ps1") {
          & $ScriptPath -DataRoot $DataRoot -AllowVerifiedForceStop | Out-Null
        } else {
          & $ScriptPath -DataRoot $DataRoot | Out-Null
        }
        if ($ScriptName -eq "stop-napcat-task-router.ps1") { $RouterStopped = $true }
        if ($ScriptName -eq "stop-napcat-supervisor.ps1") { $SupervisorStopped = $true }
      } catch {}
    }
  }
  if ($CodeInstallStarted) {
    if ((Test-Path -LiteralPath $PreviousCodeRoot) -and (Test-Path -LiteralPath $CodeRoot)) {
      try { Restore-CodeTree -From $PreviousCodeRoot -To $CodeRoot } catch {}
    }
    if ($null -ne $PreviousPointer) {
      try { Write-JsonAtomic -Path $ActivePointerPath -Value $PreviousPointer } catch {}
    } else {
      try { Remove-Item -LiteralPath $ActivePointerPath -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($PrivateEnvBackupPath -and (Test-Path -LiteralPath $PrivateEnvBackupPath)) {
      try { Copy-Item -LiteralPath $PrivateEnvBackupPath -Destination $PrivateEnvPath -Force } catch {}
    }
  }
  Set-UpdateMaintenance -Active $false
  Write-JsonAtomic -Path $AlertPath -Value ([ordered]@{
    schemaVersion = 1; pending = $true; incidentKey = "package-update-$Stamp"; createdAt = (Get-Date).ToString("o"); code = "PACKAGE_UPDATE_FAILED"; message = $Failure
  })
  if ($BrokerBackendReloaded) {
    $RecoveryReloadScript = Join-Path $CandidateRoot "ops\reload-broker-backend.ps1"
    if (Test-Path -LiteralPath $RecoveryReloadScript) {
      try { & $RecoveryReloadScript -Endpoint napcat -BrokerRoot $BrokerRoot -AllowLegacyChildRecycle | Out-Null } catch {}
    }
  }
  $PreviousProxyStartScript = Join-Path $CodeRoot "ops\start-codex-app-server-proxy.ps1"
  $PreviousProxyRecovered = (-not $ProxyLifecycleTouched)
  if ($ProxyLifecycleTouched -and (-not [string]::IsNullOrWhiteSpace($PreviousUserAppServerWsUrl)) -and (Test-Path -LiteralPath $PreviousProxyStartScript)) {
    try {
      & $PreviousProxyStartScript -DataRoot $DataRoot | Out-Null
      $PreviousProxyStatusScript = Join-Path $CodeRoot "ops\get-codex-app-server-proxy-status.ps1"
      if (Test-Path -LiteralPath $PreviousProxyStatusScript) {
        $PreviousProxyStatus = & $PreviousProxyStatusScript -DataRoot $DataRoot | ConvertFrom-Json
        $PreviousProxyRecovered = [bool]$PreviousProxyStatus.ok -and [bool]$PreviousProxyStatus.runtime.compatible -and [bool]$PreviousProxyStatus.runtime.automationEnabled
      }
    } catch {
      $PreviousProxyRecovered = $false
    }
  }
  if ($ProxyLifecycleTouched -and (-not [string]::IsNullOrWhiteSpace($PreviousUserAppServerWsUrl)) -and -not $PreviousProxyRecovered) {
    try { [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $null, "User") } catch {}
    try {
      Write-JsonAtomic -Path (Join-Path $StateRoot "codex-app-server-proxy-fallback.json") -Value ([ordered]@{
        schemaVersion = 1; pending = $true; requestedAt = (Get-Date).ToString("o"); code = "PACKAGE_UPDATE_PROXY_RECOVERY_FAILED"; message = $Failure
      })
    } catch {}
  }
  $PreviousSupervisorStartScript = Join-Path $CodeRoot "ops\start-napcat-supervisor.ps1"
  if ($SupervisorStopped -and (Test-Path -LiteralPath $PreviousSupervisorStartScript)) {
    try { & $PreviousSupervisorStartScript -DataRoot $DataRoot -BrokerRoot $BrokerRoot | Out-Null } catch {}
  }
  $PreviousRouterStartScript = Join-Path $CodeRoot "ops\start-napcat-task-router.ps1"
  if ($RouterStopped -and (Test-Path -LiteralPath $PreviousRouterStartScript)) {
    try { & $PreviousRouterStartScript -DataRoot $DataRoot -BrokerRoot $BrokerRoot | Out-Null } catch {}
  }
  if ($WatchdogStopped) {
    try { Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction SilentlyContinue } catch {}
  }
  throw
} finally {
  if ($null -ne $LockStream) { $LockStream.Dispose() }
}
