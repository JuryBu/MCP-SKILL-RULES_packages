[CmdletBinding()]
param(
  [string]$Summary,
  [string]$Progress,
  [string]$CheckpointAt,
  [int]$IntervalMinutes,
  [string]$DataRoot = (Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp")
)

$ErrorActionPreference = "Stop"
$ConfigPath = Join-Path $DataRoot "heartbeat.json"
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "没有心跳配置：$ConfigPath" }

$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($PSBoundParameters.ContainsKey("Summary")) { $Config.summary = $Summary.Trim() }
if ($PSBoundParameters.ContainsKey("Progress")) { $Config.progress = $Progress.Trim() }
if ($PSBoundParameters.ContainsKey("CheckpointAt")) { $Config.checkpointAt = $CheckpointAt.Trim() }
if ($PSBoundParameters.ContainsKey("IntervalMinutes")) {
  if ($IntervalMinutes -lt 1 -or $IntervalMinutes -gt 1440) { throw "IntervalMinutes 必须在 1 到 1440 之间" }
  $Config.intervalMinutes = $IntervalMinutes
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$TemporaryPath = "$ConfigPath.tmp-$PID-$([DateTime]::UtcNow.Ticks)"
$BackupPath = "$ConfigPath.swap-backup"
[System.IO.File]::WriteAllText($TemporaryPath, (($Config | ConvertTo-Json -Depth 5) + "`n"), $Utf8NoBom)
if (Test-Path -LiteralPath $BackupPath) { Remove-Item -LiteralPath $BackupPath -Force }
[System.IO.File]::Replace($TemporaryPath, $ConfigPath, $BackupPath)
if (Test-Path -LiteralPath $BackupPath) { Remove-Item -LiteralPath $BackupPath -Force }
[pscustomobject]@{
  updated = $true
  taskId = [string]$Config.taskId
  runId = [string]$Config.runId
  intervalMinutes = [int]$Config.intervalMinutes
  summary = [string]$Config.summary
  progress = [string]$Config.progress
  checkpointAt = [string]$Config.checkpointAt
  configPath = $ConfigPath
} | ConvertTo-Json -Depth 5
