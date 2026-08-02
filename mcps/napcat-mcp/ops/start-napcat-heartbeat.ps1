[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TaskId,
  [Parameter(Mandatory = $true)][string]$RunId,
  [ValidateRange(1, 1440)][int]$IntervalMinutes = 30,
  [string]$Summary = "训练进程仍在运行",
  [string]$Progress = "",
  [string]$CheckpointAt = "",
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) { $BrokerRoot = Join-Path (Split-Path -Parent $NapCatMcpRoot) "broker" }
$RunnerPath = Join-Path $NapCatMcpRoot "src\heartbeat-runner.mjs"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$DedupeStatePath = Join-Path $DataRoot "state\dedupe.json"
$HeartbeatConfigPath = Join-Path $DataRoot "heartbeat.json"
$RuntimeStatePath = Join-Path $DataRoot "state\heartbeat-runtime.json"
$LogPath = Join-Path $DataRoot "state\heartbeat.jsonl"
$StopFilePath = Join-Path $DataRoot "state\heartbeat.stop"

foreach ($RequiredPath in @($RunnerPath, $PrivateEnvPath, $BindingPath)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "缺少心跳运行文件：$RequiredPath" }
}
New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "state") | Out-Null
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $ExistingState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExistingState.pid)" -ErrorAction SilentlyContinue
    if ($null -ne $ExistingProcess -and [string]$ExistingProcess.CommandLine -like "*$RunnerPath*") {
      throw "已有心跳进程正在运行，PID=$($ExistingState.pid)"
    }
  } catch {
    if ($_.Exception.Message -like "已有心跳进程*") { throw }
  }
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$Config = [ordered]@{
  schemaVersion = 1
  taskId = $TaskId.Trim()
  runId = $RunId.Trim()
  intervalMinutes = $IntervalMinutes
  summary = $Summary.Trim()
  progress = $Progress.Trim()
  checkpointAt = $CheckpointAt.Trim()
}
if ([string]::IsNullOrWhiteSpace($Config.taskId) -or [string]::IsNullOrWhiteSpace($Config.runId)) {
  throw "TaskId 和 RunId 不能为空"
}
[System.IO.File]::WriteAllText($HeartbeatConfigPath, (($Config | ConvertTo-Json -Depth 5) + "`n"), $Utf8NoBom)
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
function Quote-Argument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}
$Arguments = @(
  $RunnerPath,
  "--config", $HeartbeatConfigPath,
  "--private-env", $PrivateEnvPath,
  "--binding", $BindingPath,
  "--state", $DedupeStatePath,
  "--runtime-state", $RuntimeStatePath,
  "--log", $LogPath,
  "--stop-file", $StopFilePath
)
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru

$Deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
  Start-Sleep -Milliseconds 200
  if ($Process.HasExited) { throw "心跳进程启动后立即退出，exitCode=$($Process.ExitCode)" }
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$RuntimeState.pid -eq $Process.Id -and $RuntimeState.status -eq "running") { break }
  }
} while ([DateTime]::UtcNow -lt $Deadline)
if ([int]$RuntimeState.pid -ne $Process.Id -or $RuntimeState.status -ne "running") {
  throw "心跳进程未在 10 秒内写出运行状态"
}

[pscustomobject]@{
  started = $true
  pid = $Process.Id
  taskId = $TaskId
  runId = $RunId
  intervalMinutes = $IntervalMinutes
  runtimeStatePath = $RuntimeStatePath
  logPath = $LogPath
} | ConvertTo-Json -Depth 5
