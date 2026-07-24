[CmdletBinding()]
param(
  [string]$DataRoot = (Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp"),
  [ValidateRange(2, 60)][int]$WaitSeconds = 15,
  [switch]$ForceAfterTimeout
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $NapCatMcpRoot "src\heartbeat-runner.mjs"
$RuntimeStatePath = Join-Path $DataRoot "state\heartbeat-runtime.json"
$StopFilePath = Join-Path $DataRoot "state\heartbeat.stop"
if (-not (Test-Path -LiteralPath $RuntimeStatePath)) { throw "没有心跳运行状态：$RuntimeStatePath" }

$State = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$ProcessId = [int]$State.pid
$Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
if ($null -eq $Process) {
  [pscustomobject]@{ stopped = $true; alreadyDead = $true; pid = $ProcessId } | ConvertTo-Json
  exit 0
}
if ([string]$Process.CommandLine -notlike "*$RunnerPath*") {
  throw "PID=$ProcessId 的命令行不是 NapCat 心跳进程，拒绝停止"
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($StopFilePath, ((Get-Date).ToString("o") + "`n"), $Utf8NoBom)
$Deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
  Start-Sleep -Milliseconds 250
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
} while ($null -ne $Process -and [DateTime]::UtcNow -lt $Deadline)

if ($null -ne $Process) {
  if (-not $ForceAfterTimeout) {
    throw "心跳进程未在 $WaitSeconds 秒内响应停止文件；未强制终止，可加 -ForceAfterTimeout"
  }
  Stop-Process -Id $ProcessId -Force
}
[pscustomobject]@{ stopped = $true; alreadyDead = $false; pid = $ProcessId; forced = [bool]$ForceAfterTimeout } | ConvertTo-Json
