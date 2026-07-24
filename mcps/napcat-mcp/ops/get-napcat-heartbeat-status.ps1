[CmdletBinding()]
param(
  [string]$DataRoot = (Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp")
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $NapCatMcpRoot "src\heartbeat-runner.mjs"
$RuntimeStatePath = Join-Path $DataRoot "state\heartbeat-runtime.json"
if (-not (Test-Path -LiteralPath $RuntimeStatePath)) {
  [pscustomobject]@{ exists = $false; alive = $false; runtimeStatePath = $RuntimeStatePath } | ConvertTo-Json
  exit 0
}

$State = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$State.pid)" -ErrorAction SilentlyContinue
$CommandMatches = $null -ne $Process -and [string]$Process.CommandLine -like "*$RunnerPath*"
$LastSuccessAgeMinutes = $null
if (-not [string]::IsNullOrWhiteSpace([string]$State.lastSuccessAt)) {
  $LastSuccessAgeMinutes = [math]::Round(([DateTimeOffset]::Now - [DateTimeOffset]::Parse([string]$State.lastSuccessAt)).TotalMinutes, 2)
}
[pscustomobject]@{
  exists = $true
  alive = $CommandMatches
  pid = [int]$State.pid
  recordedStatus = [string]$State.status
  taskId = [string]$State.taskId
  runId = [string]$State.runId
  intervalMinutes = $State.intervalMinutes
  startedAt = $State.startedAt
  lastAttemptAt = $State.lastAttemptAt
  lastSuccessAt = $State.lastSuccessAt
  lastSuccessAgeMinutes = $LastSuccessAgeMinutes
  nextAttemptAt = $State.nextAttemptAt
  lastError = $State.lastError
  runtimeStatePath = $RuntimeStatePath
} | ConvertTo-Json -Depth 8
