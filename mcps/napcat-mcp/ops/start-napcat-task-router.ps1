[CmdletBinding()]
param(
  [ValidateRange(1, 3600)][int]$IntervalSeconds = 30,
  [string]$DataRoot = (if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
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

foreach ($RequiredPath in @($RunnerPath, $PrivateEnvPath, $BindingPath)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "缺少任务路由运行文件：$RequiredPath" }
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
      $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$RuntimeState.pid)" -ErrorAction SilentlyContinue
      if ($null -ne $RuntimeProcess -and [string]$RuntimeProcess.CommandLine -like "*$RunnerPath*") { break }
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
