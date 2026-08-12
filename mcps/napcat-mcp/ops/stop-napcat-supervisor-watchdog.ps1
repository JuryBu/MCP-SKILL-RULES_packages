[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [string]$TaskName = "CodexNapCatSupervisor",
  [switch]$SkipScheduledTask
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$NormalizedDataRoot = [System.IO.Path]::GetFullPath($DataRoot)

function Test-WatchdogProcess {
  param($ProcessInfo)

  if ($null -eq $ProcessInfo -or [int]$ProcessInfo.ProcessId -eq $PID) { return $false }
  if ([string]$ProcessInfo.Name -notin @("powershell.exe", "pwsh.exe", "wscript.exe")) { return $false }
  $CommandLine = [string]$ProcessInfo.CommandLine
  if ($CommandLine.IndexOf("Run-NapCatSupervisorWatchdog.ps1", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  $DataRootMatch = [regex]::Match($CommandLine, '(?i)(?:^|\s)-DataRoot\s+(?:"([^"]+)"|(\S+))')
  if (-not $DataRootMatch.Success) { return $false }
  $CandidateDataRoot = if (-not [string]::IsNullOrWhiteSpace($DataRootMatch.Groups[1].Value)) {
    $DataRootMatch.Groups[1].Value
  } else {
    $DataRootMatch.Groups[2].Value
  }
  try {
    $NormalizedCandidateDataRoot = [System.IO.Path]::GetFullPath($CandidateDataRoot)
  } catch {
    return $false
  }
  return [string]::Equals(
    $NormalizedCandidateDataRoot.TrimEnd('\'),
    $NormalizedDataRoot.TrimEnd('\'),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

if (-not $SkipScheduledTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$Candidates = Get-CimInstance Win32_Process | Where-Object {
  Test-WatchdogProcess -ProcessInfo $_
} | Sort-Object { if ($_.Name -in @("powershell.exe", "pwsh.exe")) { 0 } else { 1 } }

$StoppedPids = @()
foreach ($ProcessInfo in $Candidates) {
  Stop-Process -Id ([int]$ProcessInfo.ProcessId) -Force -ErrorAction SilentlyContinue
  $StoppedPids += [int]$ProcessInfo.ProcessId
}

$Deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  $Remaining = Get-CimInstance Win32_Process | Where-Object {
    Test-WatchdogProcess -ProcessInfo $_
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
