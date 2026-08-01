[CmdletBinding()]
param(
  [ValidateRange(1, 120)][int]$WaitSeconds = 15,
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" })
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$StateDirectory = Join-Path $DataRoot "state"
$RuntimeStatePath = Join-Path $StateDirectory "task-router-runtime.json"
$StopFilePath = Join-Path $StateDirectory "task-router.stop"
$RunnerPath = Join-Path $NapCatMcpRoot "src\task-router-runner.mjs"

New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($StopFilePath, ((Get-Date).ToUniversalTime().ToString("o") + "`n"), $Utf8NoBom)

$PidValue = 0
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $PidValue = [int]$RuntimeState.pid
  } catch { }
}
$Deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
  $Process = if ($PidValue -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction SilentlyContinue } else { $null }
  $Alive = $null -ne $Process -and [string]$Process.CommandLine -like "*$RunnerPath*"
  if (-not $Alive) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $Deadline)

$OutputPid = if ($PidValue -gt 0) { $PidValue } else { $null }
$OutputNote = if ($Alive) { "Router is still shutting down; no force kill was used" } else { "Task router stopped" }
[pscustomobject]@{
  stopRequested = $true
  stopped = (-not $Alive)
  pid = $OutputPid
  stopFilePath = $StopFilePath
  note = $OutputNote
} | ConvertTo-Json -Depth 6
