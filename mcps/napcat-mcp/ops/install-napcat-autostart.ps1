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
if (-not (Test-Path -LiteralPath $SupervisorStartScript)) { throw "Installed supervisor start script not found: $SupervisorStartScript" }
if (-not (Test-Path -LiteralPath $WatchdogScript)) { throw "Installed supervisor watchdog not found: $WatchdogScript" }
if (-not (Test-Path -LiteralPath $HiddenLauncher)) { throw "Hidden PowerShell launcher not found: $HiddenLauncher" }
if ($DataRoot.Contains('"')) { throw "DataRoot cannot contain a double quote." }
if ($BrokerRoot.Contains('"')) { throw "BrokerRoot cannot contain a double quote." }

$StatePath = Join-Path $DataRoot "napcat-supervisor-autostart.json"
$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$BackupDir = Join-Path $DataRoot ("backups\napcat-supervisor-" + $Stamp)
$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$TaskExisted = $null -ne $ExistingTask
$ExistingTaskXml = $null
$BackupDirValue = $null

function Stop-TaskInstance {
  param([string]$Name)

  $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($null -eq $Task -or [string]$Task.State -ne "Running") { return }
  Stop-ScheduledTask -TaskName $Name -ErrorAction Stop
  $Deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $Task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  } while ($null -ne $Task -and [string]$Task.State -eq "Running" -and [DateTime]::UtcNow -lt $Deadline)
  if ($null -ne $Task -and [string]$Task.State -eq "Running") {
    throw "Scheduled task is still running after the stop request: $Name"
  }
}

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
  if ($TaskExisted) { Stop-TaskInstance -Name $TaskName }
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
    previousTaskExisted = $TaskExisted
    previousTaskXml = $ExistingTaskXml
    backupDir = $BackupDirValue
  }
  [System.IO.File]::WriteAllText($StatePath, (($InstallState | ConvertTo-Json -Depth 8) + "`n"), $Utf8NoBom)
  if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }
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
