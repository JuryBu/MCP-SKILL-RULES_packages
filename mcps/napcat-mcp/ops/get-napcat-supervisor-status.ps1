[CmdletBinding()]
param(
  [string]$DataRoot = (if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$TaskName = "CodexNapCatSupervisor"
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RuntimeStatePath = Join-Path $DataRoot "state\supervisor-runtime.json"
$RunnerPath = Join-Path $NapCatMcpRoot "src\supervisor-runner.mjs"

$RuntimeState = $null
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try { $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}
$Process = $null
if ($null -ne $RuntimeState -and [int]$RuntimeState.pid -gt 0) {
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$RuntimeState.pid)" -ErrorAction SilentlyContinue
}
$ScheduledTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$ScheduledTaskInfo = if ($null -ne $ScheduledTask) { Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }

[pscustomobject]@{
  alive = ($null -ne $Process -and [string]$Process.CommandLine -like "*$RunnerPath*")
  runtimeState = $RuntimeState
  runtimeStatePath = $RuntimeStatePath
  scheduledTask = if ($null -eq $ScheduledTask) { $null } else {
    [ordered]@{
      name = $TaskName
      state = [string]$ScheduledTask.State
      lastRunTime = $ScheduledTaskInfo.LastRunTime
      lastTaskResult = $ScheduledTaskInfo.LastTaskResult
      nextRunTime = $ScheduledTaskInfo.NextRunTime
    }
  }
} | ConvertTo-Json -Depth 12
