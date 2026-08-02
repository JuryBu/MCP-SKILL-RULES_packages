[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$TaskName = "CodexNapCatSupervisor",
  [switch]$SkipScheduledTask
)

$ErrorActionPreference = "Stop"
$NormalizedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
if (-not $SkipScheduledTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$Candidates = Get-CimInstance Win32_Process | Where-Object {
  $CommandLine = [string]$_.CommandLine
  $_.ProcessId -ne $PID -and
  $_.Name -in @("powershell.exe", "pwsh.exe", "wscript.exe") -and
  $CommandLine.IndexOf("Run-NapCatSupervisorWatchdog.ps1", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $CommandLine.IndexOf($NormalizedDataRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
} | Sort-Object { if ($_.Name -in @("powershell.exe", "pwsh.exe")) { 0 } else { 1 } }

$StoppedPids = @()
foreach ($ProcessInfo in $Candidates) {
  Stop-Process -Id ([int]$ProcessInfo.ProcessId) -Force -ErrorAction SilentlyContinue
  $StoppedPids += [int]$ProcessInfo.ProcessId
}

$Deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $Remaining = Get-CimInstance Win32_Process | Where-Object {
    $CommandLine = [string]$_.CommandLine
    $_.ProcessId -ne $PID -and
    $_.Name -in @("powershell.exe", "pwsh.exe", "wscript.exe") -and
    $CommandLine.IndexOf("Run-NapCatSupervisorWatchdog.ps1", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $CommandLine.IndexOf($NormalizedDataRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  }
  if (@($Remaining).Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $Deadline)

if (@($Remaining).Count -gt 0) {
  throw "NapCat supervisor watchdog processes are still running: $((@($Remaining | Select-Object -ExpandProperty ProcessId) -join ','))"
}

[pscustomobject]@{
  stopped = $true
  taskName = $TaskName
  dataRoot = $NormalizedDataRoot
  stoppedPids = $StoppedPids
} | ConvertTo-Json -Depth 5
