[CmdletBinding()]
param(
  [ValidateRange(0, 3600)][int]$IntervalSeconds = 0,
  [string]$DataRoot = (if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT,
  [string]$NapCatRoot = ""
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$NapCatParent = Split-Path -Parent $NapCatMcpRoot
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) {
  $PortableBrokerRoot = Join-Path $NapCatParent "broker"
  $FlatBrokerRoot = $NapCatParent
  $PortablePrivateEnvPath = Join-Path $PortableBrokerRoot "broker-private.env.json"
  $FlatPrivateEnvPath = Join-Path $FlatBrokerRoot "broker-private.env.json"
  $BrokerRoot = if (Test-Path -LiteralPath $PortablePrivateEnvPath) {
    $PortableBrokerRoot
  } elseif (Test-Path -LiteralPath $FlatPrivateEnvPath) {
    $FlatBrokerRoot
  } elseif (Test-Path -LiteralPath (Join-Path $PortableBrokerRoot "broker.mjs")) {
    $PortableBrokerRoot
  } else {
    $FlatBrokerRoot
  }
}
if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  $RuntimeStateFile = Join-Path $DataRoot "napcat-runtime.json"
  if (Test-Path -LiteralPath $RuntimeStateFile) {
    try { $NapCatRoot = [string](Get-Content -LiteralPath $RuntimeStateFile -Raw -Encoding UTF8 | ConvertFrom-Json).napCatRoot } catch { $NapCatRoot = "" }
  }
  if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
    $NapCatRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)) "NapCat"
  }
}
$ToolkitRoot = Split-Path -Parent $NapCatParent
$RunnerPath = Join-Path $NapCatMcpRoot "src\supervisor-runner.mjs"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$RegistryPath = Join-Path $DataRoot "state\task-registry.json"
$RuntimeStatePath = Join-Path $DataRoot "state\supervisor-runtime.json"
$LogPath = Join-Path $DataRoot "state\supervisor.jsonl"
$StopFilePath = Join-Path $DataRoot "state\supervisor.stop"
$LockPath = Join-Path $DataRoot "state\supervisor.lock"
$PortableBrokerStartScript = Join-Path $ToolkitRoot "install\Start-CodexMcpBroker.ps1"
$FlatBrokerStartScript = Join-Path $BrokerRoot "Start-CodexMcpBroker.ps1"
$BrokerStartScript = if (Test-Path -LiteralPath $PortableBrokerStartScript) {
  $PortableBrokerStartScript
} else {
  $FlatBrokerStartScript
}
$LoginScript = Join-Path $NapCatMcpRoot "ops\start-napcat-login.ps1"
$env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT = $DataRoot
$env:CODEX_TOOLKIT_BROKER_ROOT = $BrokerRoot

$IntervalMilliseconds = if ($IntervalSeconds -gt 0) { $IntervalSeconds * 1000 } else { 60000 }
if ($IntervalSeconds -eq 0 -and (Test-Path -LiteralPath $PrivateEnvPath)) {
  try {
    $PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ConfiguredMilliseconds = [int]$PrivateEnv.NAPCAT_SUPERVISOR_INTERVAL_MS
    if ($ConfiguredMilliseconds -ge 10000 -and $ConfiguredMilliseconds -le 3600000) {
      $IntervalMilliseconds = $ConfiguredMilliseconds
    }
  } catch {
  }
}

foreach ($RequiredPath in @($RunnerPath, $PrivateEnvPath, $BindingPath, $BrokerStartScript, $LoginScript)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "Missing supervisor runtime file: $RequiredPath" }
}

if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $ExistingState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExistingState.pid)" -ErrorAction SilentlyContinue
    if ($null -ne $ExistingProcess -and [string]$ExistingProcess.CommandLine -like "*$RunnerPath*") {
      [pscustomobject]@{
        started = $false
        reason = "already_running"
        pid = [int]$ExistingState.pid
        runtimeState = $ExistingState
      } | ConvertTo-Json -Depth 10
      return
    }
  } catch {
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "state") | Out-Null
if (Test-Path -LiteralPath $StopFilePath) { Remove-Item -LiteralPath $StopFilePath -Force }
$NodePath = (Get-Command node -ErrorAction Stop).Source

function Quote-Argument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$Arguments = @(
  $RunnerPath,
  "--private-env", $PrivateEnvPath,
  "--binding", $BindingPath,
  "--registry", $RegistryPath,
  "--runtime-state", $RuntimeStatePath,
  "--log", $LogPath,
  "--stop-file", $StopFilePath,
  "--lock", $LockPath,
  "--interval-ms", ([string]$IntervalMilliseconds),
  "--broker-health-url", "http://127.0.0.1:14588/health",
  "--broker-start-script", $BrokerStartScript,
  "--login-script", $LoginScript,
  "--napcat-root", $NapCatRoot
)
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru

$RuntimeState = $null
$Deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  Start-Sleep -Milliseconds 200
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    try {
      $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$RuntimeState.pid)" -ErrorAction SilentlyContinue
      if ($null -ne $RuntimeProcess -and [string]$RuntimeProcess.CommandLine -like "*$RunnerPath*") { break }
    } catch {
      $RuntimeState = $null
    }
  }
  if ($Process.HasExited -and $null -eq $RuntimeState) {
    throw "Supervisor exited immediately after launch, exitCode=$($Process.ExitCode)"
  }
} while ([DateTime]::UtcNow -lt $Deadline)

if ($null -eq $RuntimeState) { throw "Supervisor did not write runtime state within 12 seconds" }
[pscustomobject]@{
  started = $true
  pid = [int]$RuntimeState.pid
  intervalSeconds = ($IntervalMilliseconds / 1000)
  runtimeStatePath = $RuntimeStatePath
  logPath = $LogPath
} | ConvertTo-Json -Depth 10
