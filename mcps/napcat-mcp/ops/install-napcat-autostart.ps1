# Register the per-user NapCat/Codex supervisor at interactive logon.
# Only the exact task name is changed; an existing task is exported before replacement.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataRoot = (if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$TaskName = "CodexNapCatSupervisor",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $NapCatMcpRoot "ops\start-napcat-supervisor.ps1"
if (-not (Test-Path -LiteralPath $StartScript)) { throw "Installed supervisor start script not found: $StartScript" }

$StatePath = Join-Path $DataRoot "napcat-supervisor-autostart.json"
$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$BackupDir = Join-Path $DataRoot ("backups\napcat-supervisor-" + $Stamp)
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$TaskExisted = $null -ne $ExistingTask
$ExistingTaskXml = $null

$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -Hidden
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

if ($PSCmdlet.ShouldProcess($TaskName, "register hidden NapCat/Codex supervisor at user logon")) {
  if ($TaskExisted) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $ExistingTaskXml = Join-Path $BackupDir "scheduled-task.xml"
    Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $ExistingTaskXml -Encoding UTF8
  }
  if (Test-Path -LiteralPath $StatePath) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    Copy-Item -LiteralPath $StatePath -Destination (Join-Path $BackupDir "napcat-supervisor-autostart.json") -Force
  }
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "Keep the Codex MCP broker and fixed-account NapCat task router available after user logon." -Force | Out-Null
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $InstallState = [ordered]@{
    schemaVersion = 1
    installedAt = (Get-Date).ToString("o")
    taskName = $TaskName
    userId = $UserId
    startScript = $StartScript
    previousTaskExisted = $TaskExisted
    previousTaskXml = $ExistingTaskXml
    backupDir = if (Test-Path -LiteralPath $BackupDir) { $BackupDir } else { $null }
  }
  [System.IO.File]::WriteAllText($StatePath, (($InstallState | ConvertTo-Json -Depth 8) + "`n"), $Utf8NoBom)
  if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }
}

[pscustomobject]@{
  installed = (-not $WhatIfPreference)
  taskName = $TaskName
  userId = $UserId
  startNow = [bool]$StartNow
  previousTaskExisted = $TaskExisted
  backupDir = if (Test-Path -LiteralPath $BackupDir) { $BackupDir } else { $null }
  rollbackScript = Join-Path $NapCatMcpRoot "ops\remove-napcat-autostart.ps1"
} | ConvertTo-Json -Depth 8
