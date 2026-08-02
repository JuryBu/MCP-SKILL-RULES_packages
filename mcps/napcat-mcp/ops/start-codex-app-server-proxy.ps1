[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [ValidateRange(1, 65535)][int]$DownstreamPort = 18432,
  [ValidateRange(1, 65535)][int]$ControlPort = 18431,
  [ValidateRange(1, 65535)][int]$UpstreamPort = 18433,
  [ValidateRange(1, 65535)][int]$ProbePort = 18434
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $NapCatMcpRoot "src\codex-app-server-proxy-runner.mjs"
$StateRoot = Join-Path $DataRoot "state"
$RuntimeStatePath = Join-Path $StateRoot "codex-app-server-proxy-runtime.json"
$LogPath = Join-Path $StateRoot "codex-app-server-proxy.jsonl"
$StopFilePath = Join-Path $StateRoot "codex-app-server-proxy.stop"
$LockPath = Join-Path $StateRoot "codex-app-server-proxy.lock"
$JournalPath = Join-Path $StateRoot "codex-app-server-wake-journal.json"
$TokenFilePath = Join-Path $StateRoot "codex-app-server-proxy-token.txt"
$MaintenanceFilePath = Join-Path $StateRoot "task-router.maintenance.json"
$AlertFilePath = Join-Path $StateRoot "automation-alert.json"
$FallbackFilePath = Join-Path $StateRoot "codex-app-server-proxy-fallback.json"

if (-not (Test-Path -LiteralPath $RunnerPath)) { throw "Missing Codex App Server proxy runner: $RunnerPath" }
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

function Test-ExpectedProxyRuntime {
  param($RuntimeState, $ProcessInfo)
  if ($null -eq $RuntimeState -or $null -eq $ProcessInfo -or [string]$RuntimeState.state -ne "running") { return $false }
  $CommandLine = [string]$ProcessInfo.CommandLine
  if ($CommandLine.IndexOf($RunnerPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($LockPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
  try {
    $LockState = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [int]$LockState.pid -eq [int]$RuntimeState.pid -and [string]$LockState.token -eq [string]$RuntimeState.instanceToken -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeState.instanceToken)
  } catch {
    return $false
  }
}

if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $ExistingState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExistingState.pid)" -ErrorAction SilentlyContinue
    if (Test-ExpectedProxyRuntime -RuntimeState $ExistingState -ProcessInfo $ExistingProcess) {
      [pscustomobject]@{
        started = $false
        reason = "already_running"
        pid = [int]$ExistingState.pid
        runtimeState = $ExistingState
      } | ConvertTo-Json -Depth 12
      return
    }
  } catch {
  }
}

if (Test-Path -LiteralPath $StopFilePath) { Remove-Item -LiteralPath $StopFilePath -Force }
$NodePath = (Get-Command node -ErrorAction Stop).Source

function Test-LoopbackPortAvailable {
  param([int]$Port)
  $Listener = $null
  try {
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $Listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $Listener) {
      try { $Listener.Stop() } catch {}
    }
  }
}

if (-not (Test-LoopbackPortAvailable -Port $UpstreamPort)) {
  $SelectedUpstreamPort = $null
  foreach ($CandidatePort in (($UpstreamPort + 2)..([Math]::Min(65535, $UpstreamPort + 32)))) {
    if ($CandidatePort -eq $DownstreamPort -or $CandidatePort -eq $ControlPort -or $CandidatePort -eq $ProbePort) { continue }
    if (Test-LoopbackPortAvailable -Port $CandidatePort) {
      $SelectedUpstreamPort = $CandidatePort
      break
    }
  }
  if ($null -eq $SelectedUpstreamPort) {
    throw "No free loopback port is available for the managed Codex App Server."
  }
  $UpstreamPort = $SelectedUpstreamPort
}

function Quote-Argument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$Arguments = @(
  $RunnerPath,
  "--runtime-state", $RuntimeStatePath,
  "--log", $LogPath,
  "--stop-file", $StopFilePath,
  "--lock", $LockPath,
  "--journal", $JournalPath,
  "--token-file", $TokenFilePath,
  "--maintenance-file", $MaintenanceFilePath,
  "--alert-file", $AlertFilePath,
  "--fallback-file", $FallbackFilePath,
  "--downstream-port", ([string]$DownstreamPort),
  "--control-port", ([string]$ControlPort),
  "--upstream-port", ([string]$UpstreamPort),
  "--probe-port", ([string]$ProbePort)
)
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru

$RuntimeState = $null
$Deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  Start-Sleep -Milliseconds 200
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    try {
      $CandidateState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$CandidateState.pid)" -ErrorAction SilentlyContinue
       if (Test-ExpectedProxyRuntime -RuntimeState $CandidateState -ProcessInfo $RuntimeProcess) { $RuntimeState = $CandidateState; break }
       if ([string]$CandidateState.state -eq "degraded") {
         $FailureMessage = if ($CandidateState.lastError.message) { [string]$CandidateState.lastError.message } else { "unknown proxy failure" }
         throw "Codex App Server proxy entered degraded mode: $FailureMessage"
       }
       $RuntimeState = $null
    } catch {
      $RuntimeState = $null
    }
  }
  if ($Process.HasExited -and $null -eq $RuntimeState) { throw "Codex App Server proxy exited immediately, exitCode=$($Process.ExitCode)" }
} while ([DateTime]::UtcNow -lt $Deadline)

if ($null -eq $RuntimeState) { throw "Codex App Server proxy did not publish runtime state within 30 seconds" }
[pscustomobject]@{
  started = $true
  pid = [int]$RuntimeState.pid
  state = [string]$RuntimeState.state
  downstreamUrl = [string]$RuntimeState.downstreamUrl
  controlUrl = [string]$RuntimeState.controlUrl
  runtimeStatePath = $RuntimeStatePath
  tokenFilePath = $TokenFilePath
  fallbackRequired = [bool]$RuntimeState.fallbackRequired
} | ConvertTo-Json -Depth 12
