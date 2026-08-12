[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [string]$TaskName = "CodexNapCatSupervisor"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$RuntimeStatePath = Join-Path $DataRoot "state\supervisor-runtime.json"

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
$ScheduledTaskPayload = $null
if ($null -ne $ScheduledTask) {
  $ScheduledTaskPayload = [ordered]@{
    name = $TaskName
    state = [string]$ScheduledTask.State
    lastRunTime = $ScheduledTaskInfo.LastRunTime
    lastTaskResult = $ScheduledTaskInfo.LastTaskResult
    nextRunTime = $ScheduledTaskInfo.NextRunTime
    actions = @($ScheduledTask.Actions | ForEach-Object { [ordered]@{ execute = $_.Execute; arguments = $_.Arguments } })
  }
}
$CommandLine = if ($null -ne $Process) { [string]$Process.CommandLine } else { "" }
$SupervisorAlive = $null -ne $Process -and
  $CommandLine.IndexOf("supervisor-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
$NormalizedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$Watchdogs = @(Get-CimInstance Win32_Process | Where-Object {
  $CandidateCommandLine = [string]$_.CommandLine
  $_.Name -in @("powershell.exe", "pwsh.exe", "wscript.exe") -and
  $CandidateCommandLine.IndexOf("Run-NapCatSupervisorWatchdog.ps1", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $CandidateCommandLine.IndexOf($NormalizedDataRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
} | Select-Object ProcessId, Name, CommandLine)
$WatchdogInstances = @($Watchdogs | Where-Object { $_.Name -in @("powershell.exe", "pwsh.exe") })
$WatchdogWrappers = @($Watchdogs | Where-Object { $_.Name -eq "wscript.exe" })

[pscustomobject]@{
  alive = $SupervisorAlive
  runtimeState = $RuntimeState
  runtimeStatePath = $RuntimeStatePath
  scheduledTask = $ScheduledTaskPayload
  watchdogCount = $WatchdogInstances.Count
  watchdogInstanceCount = $WatchdogInstances.Count
  watchdogProcessCount = $Watchdogs.Count
  watchdogWrapperCount = $WatchdogWrappers.Count
  watchdogProcesses = $Watchdogs
} | ConvertTo-Json -Depth 12
