# Register the per-user NapCat/Codex supervisor at interactive logon.
# Only the exact task name is changed; an existing task is exported before replacement.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $(if ($env:CODEX_TOOLKIT_BROKER_ROOT) { $env:CODEX_TOOLKIT_BROKER_ROOT } else { Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }),
  [string]$TaskName = "CodexNapCatSupervisor",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$SupervisorStartScript = Join-Path $NapCatMcpRoot "ops\start-napcat-supervisor.ps1"
$WatchdogScript = Join-Path $NapCatMcpRoot "ops\Run-NapCatSupervisorWatchdog.ps1"
$HiddenLauncher = Join-Path $NapCatMcpRoot "ops\Run-HiddenPowerShell.vbs"
$StopWatchdogScript = Join-Path $NapCatMcpRoot "ops\stop-napcat-supervisor-watchdog.ps1"
if (-not (Test-Path -LiteralPath $SupervisorStartScript)) { throw "Installed supervisor start script not found: $SupervisorStartScript" }
if (-not (Test-Path -LiteralPath $WatchdogScript)) { throw "Installed supervisor watchdog not found: $WatchdogScript" }
if (-not (Test-Path -LiteralPath $HiddenLauncher)) { throw "Hidden PowerShell launcher not found: $HiddenLauncher" }
if (-not (Test-Path -LiteralPath $StopWatchdogScript)) { throw "Supervisor watchdog stop script not found: $StopWatchdogScript" }
if ($DataRoot.Contains('"')) { throw "DataRoot cannot contain a double quote." }
if ($BrokerRoot.Contains('"')) { throw "BrokerRoot cannot contain a double quote." }
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null

$StatePath = Join-Path $DataRoot "napcat-supervisor-autostart.json"
$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$BackupDir = Join-Path $DataRoot ("backups\napcat-supervisor-" + $Stamp)
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$TaskExisted = $null -ne $ExistingTask
$TaskWasRunning = $TaskExisted -and [string]$ExistingTask.State -eq "Running"
$ExistingTaskXml = $null
$BackupDirValue = $null

$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument "//B //NoLogo `"$HiddenLauncher`" `"$WatchdogScript`" -DataRoot `"$DataRoot`" -BrokerRoot `"$BrokerRoot`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0) -MultipleInstances IgnoreNew -Hidden -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
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
  if (Test-Path -LiteralPath $BackupDir) { $BackupDirValue = $BackupDir }
  try {
    & $StopWatchdogScript -DataRoot $DataRoot -TaskName $TaskName | Out-Null
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "Keep the Codex MCP broker and fixed-account NapCat task router available after user logon." -Force | Out-Null
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $InstallState = [ordered]@{
      schemaVersion = 1
      installedAt = (Get-Date).ToString("o")
      taskName = $TaskName
      userId = $UserId
      startScript = $WatchdogScript
      supervisorStartScript = $SupervisorStartScript
      hiddenLauncher = $HiddenLauncher
      brokerRoot = $BrokerRoot
      dataRoot = $DataRoot
      previousTaskExisted = $TaskExisted
      previousTaskXml = $ExistingTaskXml
      backupDir = $BackupDirValue
    }
    [System.IO.File]::WriteAllText($StatePath, (($InstallState | ConvertTo-Json -Depth 8) + "`n"), $Utf8NoBom)
    if ($StartNow) { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
  } catch {
    $InstallFailure = $_.Exception.Message
    $RollbackFailure = $null
    try {
      if ($TaskExisted -and $ExistingTaskXml -and (Test-Path -LiteralPath $ExistingTaskXml)) {
        Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath $ExistingTaskXml -Raw -Encoding UTF8) -Force | Out-Null
        if ($TaskWasRunning) { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
      } else {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
      }
      $PreviousStatePath = if ($BackupDirValue) { Join-Path $BackupDirValue "napcat-supervisor-autostart.json" } else { $null }
      if ($PreviousStatePath -and (Test-Path -LiteralPath $PreviousStatePath)) {
        Copy-Item -LiteralPath $PreviousStatePath -Destination $StatePath -Force
      } else {
        Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
      }
    } catch {
      $RollbackFailure = $_.Exception.Message
    }
    if ($RollbackFailure) { throw "NapCat supervisor task installation failed: $InstallFailure; rollback also failed: $RollbackFailure" }
    throw "NapCat supervisor task installation failed and the previous task was restored: $InstallFailure"
  }
}

[pscustomobject]@{
  installed = (-not $WhatIfPreference)
  taskName = $TaskName
  userId = $UserId
  startScript = $WatchdogScript
  startNow = [bool]$StartNow
  previousTaskExisted = $TaskExisted
  backupDir = $BackupDirValue
  rollbackScript = Join-Path $NapCatMcpRoot "ops\remove-napcat-autostart.ps1"
} | ConvertTo-Json -Depth 8
