[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }),
  [string]$BrokerRoot = $(if ($env:CODEX_TOOLKIT_BROKER_ROOT) { $env:CODEX_TOOLKIT_BROKER_ROOT } else { "" }),
  [string]$CodeRoot = "",
  [string]$DataRoot = "",
  [switch]$PreserveActiveWakes,
  [switch]$BackendOnlyHotReload,
  [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-BrokerRoot {
  param([string]$ConfiguredBrokerRoot, [string]$ConfiguredCodexHome)
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredBrokerRoot)) {
    return [System.IO.Path]::GetFullPath($ConfiguredBrokerRoot)
  }
  $ServiceManifestPath = if (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST)) {
    [System.IO.Path]::GetFullPath([string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST)
  } else {
    Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
  }
  if (Test-Path -LiteralPath $ServiceManifestPath -PathType Leaf) {
    try {
      $ManifestBrokerScript = [string](Get-Content -LiteralPath $ServiceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).broker.brokerScript
      if (-not [string]::IsNullOrWhiteSpace($ManifestBrokerScript) -and (Test-Path -LiteralPath $ManifestBrokerScript -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath((Split-Path -Parent $ManifestBrokerScript))
      }
    } catch {
      throw "Managed broker service manifest could not be read: $ServiceManifestPath"
    }
  }
  return Join-Path $ConfiguredCodexHome "mcp-http-broker"
}

$BrokerRoot = Resolve-BrokerRoot -ConfiguredBrokerRoot $BrokerRoot -ConfiguredCodexHome $CodexHome
if ([string]::IsNullOrWhiteSpace($CodeRoot)) { $CodeRoot = Join-Path $CodexHome "services\napcat-bridge\current" }

$CodeRoot = [System.IO.Path]::GetFullPath($CodeRoot)
$NapCatSource = Join-Path $PackageRoot "napcat-mcp"
$BrokerSourceRoot = Join-Path $PackageRoot "broker"
$BrokerFiles = @("broker.mjs", "endpoint-config.mjs", "request-lifecycle.mjs")
$ManifestPath = Join-Path $PackageRoot "manifest.json"
$Updater = Join-Path $NapCatSource "ops\update-codex-napcat-bridge.ps1"
$SupervisorTaskName = "CodexNapCatSupervisor"
$PreviousUserAppServerWsUrl = [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "User")
$UpdateResult = $null

function Restore-StagedUpdate {
  param($Result)
  if ($null -eq $Result -or [string]::IsNullOrWhiteSpace([string]$Result.backupRoot)) { return }
  $UpdateBackupRoot = [string]$Result.backupRoot
  $PreviousCodeRoot = Join-Path $UpdateBackupRoot "previous-code"
  if (Test-Path -LiteralPath $PreviousCodeRoot) {
    foreach ($Name in @("src", "ops", "test", "package", "README.md", "package.json", "package-lock.json", "release-manifest.json")) {
      $Source = Join-Path $PreviousCodeRoot $Name
      if (Test-Path -LiteralPath $Source) { Copy-Item -LiteralPath $Source -Destination $CodeRoot -Recurse -Force }
    }
  }
  $PrivateEnvBackup = Join-Path $UpdateBackupRoot "broker-private.env.json"
  $PrivateEnvTarget = Join-Path $BrokerRoot "broker-private.env.json"
  if (Test-Path -LiteralPath $PrivateEnvBackup) { Copy-Item -LiteralPath $PrivateEnvBackup -Destination $PrivateEnvTarget -Force }
  $ServiceRoot = Split-Path -Parent $CodeRoot
  $PreviousPointer = Join-Path $ServiceRoot "pointers\previous.json"
  $ActivePointer = Join-Path $ServiceRoot "pointers\active.json"
  if (Test-Path -LiteralPath $PreviousPointer) { Copy-Item -LiteralPath $PreviousPointer -Destination $ActivePointer -Force }
  [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $PreviousUserAppServerWsUrl, "User")
  $MaintenancePath = Join-Path $DataRoot "state\task-router.maintenance.json"
  if (Test-Path -LiteralPath $MaintenancePath) {
    $Maintenance = Get-Content -LiteralPath $MaintenancePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Maintenance.reasons) { $Maintenance.reasons.PSObject.Properties.Remove("packageUpdate") }
    if ($Maintenance.reasons -and $Maintenance.reasons.PSObject.Properties.Count -gt 0) {
      $Maintenance | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $MaintenancePath -Encoding UTF8
    } else {
      Remove-Item -LiteralPath $MaintenancePath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-FileSha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

function Get-CanonicalTextSha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $Text = [System.IO.File]::ReadAllText($Path)
  $CanonicalText = $Text.TrimStart([char]0xFEFF).Replace("`r`n", "`n").Replace("`r", "`n")
  $Bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($CanonicalText)
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($Hasher.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $Hasher.Dispose()
  }
}

function Assert-BrokerSnapshotCurrent {
  foreach ($BrokerFile in $BrokerFiles) {
    $BrokerSource = Join-Path $BrokerSourceRoot $BrokerFile
    $BrokerTarget = Join-Path $BrokerRoot $BrokerFile
    if (-not (Test-Path -LiteralPath $BrokerTarget)) {
      throw "Installed broker file is missing: $BrokerTarget. Run Update-CodexMcpBroker.ps1 before the NapCat App Server upgrade."
    }
    $RawHashMatches = (Get-FileSha256 -Path $BrokerSource) -eq (Get-FileSha256 -Path $BrokerTarget)
    $CanonicalHashMatches = (Get-CanonicalTextSha256 -Path $BrokerSource) -eq (Get-CanonicalTextSha256 -Path $BrokerTarget)
    if (-not $RawHashMatches -and -not $CanonicalHashMatches) {
      throw "Installed broker file does not match this package: $BrokerFile. Run Update-CodexMcpBroker.ps1 first; this script will not modify a live broker before candidate validation."
    }
  }
}

& (Join-Path $PackageRoot "verify-package.ps1")
foreach ($RequiredPath in @($NapCatSource, $BrokerSourceRoot, $BrokerRoot, $ManifestPath, $Updater)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "Required package or local file is missing: $RequiredPath" }
}
foreach ($BrokerFile in $BrokerFiles) {
  $BrokerSource = Join-Path $BrokerSourceRoot $BrokerFile
  if (-not (Test-Path -LiteralPath $BrokerSource)) { throw "Required broker source is missing: $BrokerSource" }
}

$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$SourceCommit = [string]$Manifest.source_commits.napcat_mcp
if ([string]::IsNullOrWhiteSpace($SourceCommit)) { throw "manifest.json does not record the NapCat source commit" }

$LegacyDataRoot = Join-Path $BrokerRoot "napcat-mcp"
$CanonicalDataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp"
$DataRootWasExplicit = -not [string]::IsNullOrWhiteSpace($DataRoot)
if (-not $DataRootWasExplicit) {
  $ConfiguredDataRoot = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NAPCAT_DATA_ROOT", "User")
  $PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
  if ([string]::IsNullOrWhiteSpace($ConfiguredDataRoot) -and (Test-Path -LiteralPath $PrivateEnvPath)) {
    try { $ConfiguredDataRoot = [string](Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json).CODEX_TOOLKIT_NAPCAT_DATA_ROOT } catch {}
  }
  $RegistryRoots = @(@($LegacyDataRoot, $CanonicalDataRoot) | Where-Object { Test-Path -LiteralPath (Join-Path $_ "state\task-registry.json") } | Select-Object -Unique)
  if ($RegistryRoots.Count -gt 1) { throw "Multiple NapCat task registries were found. Pass -DataRoot explicitly so no task state can be selected by guesswork." }
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredDataRoot)) {
    $ConfiguredDataRoot = [System.IO.Path]::GetFullPath($ConfiguredDataRoot)
    if ($RegistryRoots.Count -eq 1 -and [System.IO.Path]::GetFullPath($RegistryRoots[0]) -ne $ConfiguredDataRoot) {
      throw "Configured NapCat DataRoot does not match the existing task registry. Pass -DataRoot explicitly after checking the private state."
    }
    $DataRoot = $ConfiguredDataRoot
  } elseif ($RegistryRoots.Count -eq 1) {
    $DataRoot = $RegistryRoots[0]
  } else {
    $DataRoot = $CanonicalDataRoot
  }
}
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)
if ($CodeRoot -eq $DataRoot) { throw "CodeRoot and DataRoot must be different" }

function Resolve-NodeExecutable {
  $ConfiguredNode = [string]$env:CODEX_TOOLKIT_NODE_EXE
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredNode) -and (Test-Path -LiteralPath $ConfiguredNode -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($ConfiguredNode)
  }
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $NodeCommand -and (Test-Path -LiteralPath $NodeCommand.Source -PathType Leaf)) {
    return [string]$NodeCommand.Source
  }
  $ManifestPath = if (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST)) {
    [System.IO.Path]::GetFullPath([string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST)
  } else {
    Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
  }
  if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    try {
      $ManagedNode = [string](Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).broker.nodeExe
      if (-not [string]::IsNullOrWhiteSpace($ManagedNode) -and (Test-Path -LiteralPath $ManagedNode -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($ManagedNode)
      }
    } catch {
    }
  }
  throw "Managed Node executable is unavailable. Configure CODEX_TOOLKIT_NODE_EXE or broker.nodeExe in the service manifest."
}

$Node = Resolve-NodeExecutable
foreach ($BrokerFile in $BrokerFiles) {
  & $Node --check (Join-Path $BrokerSourceRoot $BrokerFile)
  if ($LASTEXITCODE -ne 0) { throw "Package broker source syntax check failed: $BrokerFile" }
}
try {
  $UpdateArguments = @{
    SourceRoot = $NapCatSource
    CodeRoot = $CodeRoot
    DataRoot = $DataRoot
    BrokerRoot = $BrokerRoot
    NodeExecutable = $Node
    SourceCommit = $SourceCommit
    MigrateAutostart = [bool]$BackendOnlyHotReload
    ActivateNow = [bool]$BackendOnlyHotReload
    PreserveActiveWakes = [bool]$PreserveActiveWakes
    BackendOnlyHotReload = [bool]$BackendOnlyHotReload
    ValidateOnly = [bool]$ValidateOnly
  }
  if ($ValidateOnly) {
    $UpdateResult = & $Updater @UpdateArguments | ConvertFrom-Json
    if ($UpdateResult.candidateValidated -ne $true) { throw "The guarded updater did not return a successful candidate validation result." }
    Write-Host "NapCat candidate validation completed without modifying live services."
    Write-Host "Source commit: $SourceCommit"
    Write-Host "Source tree SHA256: $($UpdateResult.sourceTreeSha256)"
    return
  }
  Assert-BrokerSnapshotCurrent
  $UpdateResult = & $Updater @UpdateArguments | ConvertFrom-Json
  if ($BackendOnlyHotReload) {
    if ($UpdateResult.activated -ne $true -or $UpdateResult.backendOnlyHotReload -ne $true) {
      throw "The guarded updater did not complete the requested backend-only hot reload."
    }
    Write-Host "NapCat backend-only hot reload completed successfully."
    Write-Host "Public code: $CodeRoot"
    Write-Host "Private data: $DataRoot"
    Write-Host "Source commit: $SourceCommit"
    Write-Host "Backup directory: $($UpdateResult.backupRoot)"
    Write-Host "Codex Desktop and the transparent proxy were not stopped."
    return
  }
  if ($UpdateResult.pendingActivation -ne $true) { throw "The guarded updater did not return a staged activation result." }
  $InstallAutostart = Join-Path $CodeRoot "ops\install-napcat-autostart.ps1"
  if (-not (Test-Path -LiteralPath $InstallAutostart)) { throw "Installed autostart script is missing: $InstallAutostart" }
  & $InstallAutostart -DataRoot $DataRoot -BrokerRoot $BrokerRoot | Out-Null
  [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "ws://127.0.0.1:18432", "User")
  $IdleActivator = Join-Path $CodeRoot "ops\activate-codex-app-server-when-idle.ps1"
  if (-not (Test-Path -LiteralPath $IdleActivator)) { throw "Installed idle activation script is missing: $IdleActivator" }
  $PowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
  $ActivationArguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $IdleActivator + '"'),
    "-DataRoot", ('"' + $DataRoot + '"'),
    "-BrokerRoot", ('"' + $BrokerRoot + '"'),
    "-SupervisorTaskName", ('"' + $SupervisorTaskName + '"')
  ) -join " "
  Start-Process -FilePath $PowerShellPath -ArgumentList $ActivationArguments -WindowStyle Hidden | Out-Null
} catch {
  $Failure = $_.Exception.Message
  $RestoreFailure = $null
  try { Restore-StagedUpdate -Result $UpdateResult } catch { $RestoreFailure = $_.Exception.Message }
  if ($RestoreFailure) {
    throw "NapCat App Server upgrade failed and the staged public code could not be fully restored. Task data was preserved and automatic wake remains paused. Cause: $Failure; restore failure: $RestoreFailure"
  }
  throw "NapCat App Server upgrade failed. The live broker was not modified by this entrypoint; staged public code, the user App Server setting and task state were restored when applicable. Cause: $Failure"
}

Write-Host "NapCat App Server proxy upgrade staged successfully."
Write-Host "Public code: $CodeRoot"
Write-Host "Private data: $DataRoot"
Write-Host "Source commit: $SourceCommit"
Write-Host "Backup directory: $($UpdateResult.backupRoot)"
Write-Host "Exit Codex normally, wait about 10 seconds, then open Codex normally. Do not restart Windows."
Write-Host "The hidden activator waits for the current Codex proxy connection to become idle; it never terminates Codex Desktop."
Write-Host "On protocol incompatibility, automatic wakes pause, tasks stay intact, a local alert is written, and the next Codex launch falls back to the native path."
