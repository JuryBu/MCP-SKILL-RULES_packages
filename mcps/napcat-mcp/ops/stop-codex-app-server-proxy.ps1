[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [ValidateRange(1, 120)][int]$TimeoutSeconds = 20,
  [switch]$AllowVerifiedForceStop
)

$ErrorActionPreference = "Stop"
$StateRoot = Join-Path $DataRoot "state"
$RuntimeStatePath = Join-Path $StateRoot "codex-app-server-proxy-runtime.json"
$StopFilePath = Join-Path $StateRoot "codex-app-server-proxy.stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = [System.IO.Path]::GetFullPath((Join-Path $NapCatMcpRoot "src\codex-app-server-proxy-runner.mjs"))
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

$PidValue = $null
$AppServerPid = $null
$ExpectedExecutablePath = $null
$ExpectedUpstreamUrl = $null
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $PidValue = [int]$RuntimeState.pid
    if ($null -ne $RuntimeState.appServerPid) { $AppServerPid = [int]$RuntimeState.appServerPid }
    $ExpectedExecutablePath = [string]$RuntimeState.executablePath
    $ExpectedUpstreamUrl = [string]$RuntimeState.upstreamUrl
  } catch { $PidValue = $null }
}
[System.IO.File]::WriteAllText($StopFilePath, ((Get-Date).ToString("o") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
$Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  $Process = if ($null -ne $PidValue) { Get-Process -Id $PidValue -ErrorAction SilentlyContinue } else { $null }
  if ($null -eq $Process) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $Deadline)

$RemainingProcess = if ($null -ne $PidValue) { Get-Process -Id $PidValue -ErrorAction SilentlyContinue } else { $null }
$IdentityVerified = $false
$Forced = $false
$ChildStopped = $false
if ($null -ne $RemainingProcess -and $AllowVerifiedForceStop) {
  $ManagedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction SilentlyContinue
  $CommandLine = if ($null -ne $ManagedProcess) { [string]$ManagedProcess.CommandLine } else { "" }
  $IdentityVerified = $null -ne $ManagedProcess -and
    $CommandLine.IndexOf($RunnerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if ($IdentityVerified) {
    Stop-Process -Id $PidValue -Force -ErrorAction Stop
    $Forced = $true
    $ForceDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      $RemainingProcess = Get-Process -Id $PidValue -ErrorAction SilentlyContinue
      if ($null -eq $RemainingProcess) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $ForceDeadline)
  }
}
$RemainingProcess = if ($null -ne $PidValue) { Get-Process -Id $PidValue -ErrorAction SilentlyContinue } else { $null }
$ProxyStopped = $null -eq $RemainingProcess

$ChildIdentityVerified = $false
$ChildForced = $false
$ExpectedUpstreamPort = $null
if ($ExpectedUpstreamUrl -match ':(\d+)$') { $ExpectedUpstreamPort = [int]$Matches[1] }
if ($null -eq $AppServerPid -and $null -ne $ExpectedUpstreamPort) {
  $PortOwner = Get-NetTCPConnection -State Listen -LocalPort $ExpectedUpstreamPort -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
    Select-Object -First 1
  if ($null -ne $PortOwner) { $AppServerPid = [int]$PortOwner.OwningProcess }
}
if ($null -ne $AppServerPid) {
  $ChildProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $AppServerPid" -ErrorAction SilentlyContinue
  $ChildCommandLine = if ($null -ne $ChildProcess) { [string]$ChildProcess.CommandLine } else { "" }
  $ExecutableMatches = [string]::IsNullOrWhiteSpace($ExpectedExecutablePath) -or
    $ChildCommandLine.IndexOf($ExpectedExecutablePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $ListenMatches = [string]::IsNullOrWhiteSpace($ExpectedUpstreamUrl) -or
    $ChildCommandLine.IndexOf($ExpectedUpstreamUrl, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $ParentMatches = $ProxyStopped -or [int]$ChildProcess.ParentProcessId -eq $PidValue
  $ChildIdentityVerified = $null -ne $ChildProcess -and $ExecutableMatches -and $ListenMatches -and $ParentMatches -and
    $ChildCommandLine.IndexOf("app-server", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if ($ChildIdentityVerified -and $AllowVerifiedForceStop) {
    & taskkill.exe /PID $AppServerPid /T /F 2>$null | Out-Null
    $ChildForced = $true
  }
  $ChildDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $ChildRemaining = Get-Process -Id $AppServerPid -ErrorAction SilentlyContinue
    if ($null -eq $ChildRemaining) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $ChildDeadline)
  $ChildListenerRemaining = if ($null -ne $ExpectedUpstreamPort) {
    Get-NetTCPConnection -State Listen -LocalPort $ExpectedUpstreamPort -ErrorAction SilentlyContinue |
      Where-Object { [int]$_.OwningProcess -eq $AppServerPid } |
      Select-Object -First 1
  } else { $null }
  $ChildStopped = $null -eq $ChildRemaining -and $null -eq $ChildListenerRemaining
} else {
  $ChildStopped = $true
}
[pscustomobject]@{
  stopped = $ProxyStopped
  clean = ($ProxyStopped -and $ChildStopped)
  pid = $PidValue
  appServerPid = $AppServerPid
  stopFilePath = $StopFilePath
  identityVerified = $IdentityVerified
  forced = $Forced
  childStopped = $ChildStopped
  childIdentityVerified = $ChildIdentityVerified
  childForced = $ChildForced
  orphanedListener = (-not $ChildStopped)
} | ConvertTo-Json -Depth 6
