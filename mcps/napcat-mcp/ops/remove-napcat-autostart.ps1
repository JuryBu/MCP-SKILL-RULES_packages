# Remove the exact logon task created by this package and restore a backed-up predecessor.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$TaskName = "CodexNapCatSupervisor"
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$StatePath = Join-Path $DataRoot "napcat-supervisor-autostart.json"
$StopScript = Join-Path $NapCatMcpRoot "ops\stop-napcat-supervisor.ps1"
$StopWatchdogScript = Join-Path $NapCatMcpRoot "ops\stop-napcat-supervisor-watchdog.ps1"
$InstallState = $null
if (Test-Path -LiteralPath $StatePath) {
  $InstallState = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not [string]::IsNullOrWhiteSpace([string]$InstallState.taskName)) { $TaskName = [string]$InstallState.taskName }
}

$CurrentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$Removed = $false
if (-not (Test-Path -LiteralPath $StopWatchdogScript)) { throw "Supervisor watchdog stop script not found: $StopWatchdogScript" }
& $StopWatchdogScript -DataRoot $DataRoot -TaskName $TaskName | Out-Null
if ($null -ne $CurrentTask) {
  if ($PSCmdlet.ShouldProcess($TaskName, "remove NapCat/Codex logon task")) {
    $Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
    $RemovalBackup = Join-Path $DataRoot ("backups\napcat-supervisor-remove-" + $Stamp)
    New-Item -ItemType Directory -Force -Path $RemovalBackup | Out-Null
    Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $RemovalBackup "scheduled-task.xml") -Encoding UTF8
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    $Removed = $true
  }
}

if ((Test-Path -LiteralPath $StopScript) -and $PSCmdlet.ShouldProcess($TaskName, "stop NapCat/Codex supervisor")) {
  try { & $StopScript -DataRoot $DataRoot | Out-Null } catch { Write-Warning "Supervisor stop request failed: $($_.Exception.Message)" }
}

$RestoredPrevious = $false
if ($null -ne $InstallState -and $InstallState.previousTaskExisted -eq $true -and (Test-Path -LiteralPath ([string]$InstallState.previousTaskXml))) {
  if ($PSCmdlet.ShouldProcess($TaskName, "restore the pre-install scheduled task")) {
    $PreviousXml = Get-Content -LiteralPath ([string]$InstallState.previousTaskXml) -Raw -Encoding UTF8
    Register-ScheduledTask -TaskName $TaskName -Xml $PreviousXml -Force | Out-Null
    $RestoredPrevious = $true
  }
}
if ((Test-Path -LiteralPath $StatePath) -and $PSCmdlet.ShouldProcess($StatePath, "remove NapCat supervisor autostart state")) {
  Remove-Item -LiteralPath $StatePath -Force
}

[pscustomobject]@{
  removed = $Removed
  taskName = $TaskName
  restoredPreviousTask = $RestoredPrevious
} | ConvertTo-Json -Depth 6
