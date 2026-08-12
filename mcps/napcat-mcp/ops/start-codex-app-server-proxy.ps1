[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [ValidateRange(1, 65535)][int]$DownstreamPort = 18432,
  [ValidateRange(1, 65535)][int]$ControlPort = 18431,
  [ValidateRange(1, 65535)][int]$UpstreamPort = 18433,
  [ValidateRange(1, 65535)][int]$ProbePort = 18434,
  [ValidateRange(250, 300000)][int]$ResumeTimeoutMs = 120000
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
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
  if ($CommandLine.IndexOf("codex-app-server-proxy-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($LockPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  $DownstreamOwner = Get-NetTCPConnection -State Listen -LocalPort $DownstreamPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @("127.0.0.1", "::1") } | Select-Object -First 1 -ExpandProperty OwningProcess
  $ControlOwner = Get-NetTCPConnection -State Listen -LocalPort $ControlPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @("127.0.0.1", "::1") } | Select-Object -First 1 -ExpandProperty OwningProcess
  if ([int]$DownstreamOwner -ne [int]$RuntimeState.pid -or [int]$ControlOwner -ne [int]$RuntimeState.pid) { return $false }
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

function Resolve-NodeExecutable {
  $ConfiguredNode = [string]$env:CODEX_TOOLKIT_NODE_EXE
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredNode) -and (Test-Path -LiteralPath $ConfiguredNode -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($ConfiguredNode)
  }
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $NodeCommand -and (Test-Path -LiteralPath $NodeCommand.Source -PathType Leaf)) {
    return [string]$NodeCommand.Source
  }
  $ManifestPath = Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
  if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    try {
      $ManagedNode = [string](Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).broker.nodeExe
      if (-not [string]::IsNullOrWhiteSpace($ManagedNode) -and (Test-Path -LiteralPath $ManagedNode -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($ManagedNode)
      }
    } catch {
    }
  }
  throw "Managed Node executable is unavailable."
}

$NodePath = Resolve-NodeExecutable

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
  "--probe-port", ([string]$ProbePort),
  "--resume-timeout-ms", ([string]$ResumeTimeoutMs)
)
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru

$RuntimeState = $null
$Deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  Start-Sleep -Milliseconds 200
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    $CandidateState = $null
    try {
      $CandidateState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $RuntimeState = $null
    }
    if ($null -ne $CandidateState) {
      if ($null -eq $CandidateState.pid -or [int]$CandidateState.pid -ne [int]$Process.Id) {
        $RuntimeState = $null
        continue
      }
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$CandidateState.pid)" -ErrorAction SilentlyContinue
      if (Test-ExpectedProxyRuntime -RuntimeState $CandidateState -ProcessInfo $RuntimeProcess) { $RuntimeState = $CandidateState; break }
      if ([string]$CandidateState.state -eq "degraded") {
        $FailureMessage = if ($CandidateState.lastError.message) { [string]$CandidateState.lastError.message } else { "unknown proxy failure" }
        throw "Codex App Server proxy entered degraded mode: $FailureMessage"
      }
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
