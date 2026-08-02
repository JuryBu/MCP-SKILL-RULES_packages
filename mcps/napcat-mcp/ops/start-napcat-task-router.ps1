[CmdletBinding()]
param(
  [ValidateRange(1, 3600)][int]$IntervalSeconds = 30,
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) { $BrokerRoot = Join-Path (Split-Path -Parent $NapCatMcpRoot) "broker" }
$RunnerPath = Join-Path $NapCatMcpRoot "src\task-router-runner.mjs"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$DedupeStatePath = Join-Path $DataRoot "state\dedupe.json"
$RegistryPath = Join-Path $DataRoot "state\task-registry.json"
$RuntimeStatePath = Join-Path $DataRoot "state\task-router-runtime.json"
$LogPath = Join-Path $DataRoot "state\task-router.jsonl"
$StopFilePath = Join-Path $DataRoot "state\task-router.stop"
$LockPath = Join-Path $DataRoot "state\task-router.lock"
$MaintenanceFilePath = Join-Path $DataRoot "state\task-router.maintenance.json"
$AlertFilePath = Join-Path $DataRoot "state\automation-alert.json"

foreach ($RequiredPath in @($RunnerPath, $PrivateEnvPath, $BindingPath)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "缺少任务路由运行文件：$RequiredPath" }
}

function Test-ExpectedTaskRouterRuntime {
  param($RuntimeState, $ProcessInfo)
  if ($null -eq $RuntimeState -or $null -eq $ProcessInfo -or [string]$RuntimeState.state -ne "running") { return $false }
  $CommandLine = [string]$ProcessInfo.CommandLine
  if ($CommandLine.IndexOf("task-router-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
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
    if (Test-ExpectedTaskRouterRuntime -RuntimeState $ExistingState -ProcessInfo $ExistingProcess) {
      [pscustomobject]@{
        started = $false
        reason = "already_running"
        pid = [int]$ExistingState.pid
        runtimeState = $ExistingState
      } | ConvertTo-Json -Depth 8
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
  "--registry", $RegistryPath,
  "--binding", $BindingPath,
  "--state", $DedupeStatePath,
  "--runtime-state", $RuntimeStatePath,
  "--log", $LogPath,
  "--stop-file", $StopFilePath,
  "--lock", $LockPath,
  "--maintenance-file", $MaintenanceFilePath,
  "--alert-file", $AlertFilePath,
  "--interval-ms", ([string]($IntervalSeconds * 1000)),
  "--private-env", $PrivateEnvPath
)
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru

$RuntimeState = $null
$Deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  Start-Sleep -Milliseconds 200
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    try {
      $CandidateState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$CandidateState.pid)" -ErrorAction SilentlyContinue
      if (Test-ExpectedTaskRouterRuntime -RuntimeState $CandidateState -ProcessInfo $RuntimeProcess) { $RuntimeState = $CandidateState; break }
      $RuntimeState = $null
    } catch {
      $RuntimeState = $null
    }
  }
  if ($Process.HasExited -and $null -eq $RuntimeState) {
    throw "任务路由进程启动后立即退出，exitCode=$($Process.ExitCode)"
  }
} while ([DateTime]::UtcNow -lt $Deadline)

if ($null -eq $RuntimeState) { throw "任务路由进程未在 10 秒内写出运行状态" }
[pscustomobject]@{
  started = $true
  pid = [int]$RuntimeState.pid
  intervalSeconds = $IntervalSeconds
  runtimeStatePath = $RuntimeStatePath
  logPath = $LogPath
} | ConvertTo-Json -Depth 8
