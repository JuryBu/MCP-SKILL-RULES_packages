param(
  [ValidateSet("Start", "Stop", "Status", "InstallAutostart", "RemoveAutostart")]
  [string]$Action = "Status",
  [string]$CodeRoot = $(if ($env:WECHAT_DOCS_MCP_ROOT) { $env:WECHAT_DOCS_MCP_ROOT } else { Join-Path $env:USERPROFILE ".codex\services\wechat-docs-bridge\current" }),
  [string]$DataRoot = $(if ($env:WECHAT_DOCS_MCP_DATA_ROOT) { $env:WECHAT_DOCS_MCP_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\wechat-docs-mcp" }),
  [string]$HealthUrl = "http://127.0.0.1:14588/health?endpoint=wechat-docs&deep=1",
  [string]$TaskName = "CodexWechatDocsSupervisor",
  [int]$IntervalSeconds = 30,
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
$StateRoot = Join-Path $DataRoot "state"
$RuntimePath = Join-Path $StateRoot "supervisor-runtime.json"
$StopPath = Join-Path $StateRoot "supervisor.stop"
$Pythonw = Join-Path $CodeRoot "env\Scripts\pythonw.exe"
$ScriptPath = $MyInvocation.MyCommand.Path

function Read-Runtime {
  if (-not (Test-Path -LiteralPath $RuntimePath)) { return $null }
  try { return Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-SupervisorStatus {
  $runtime = Read-Runtime
  $process = $null
  if ($null -ne $runtime -and [int]$runtime.pid -gt 0) {
    $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
  }
  $fresh = $false
  if ($null -ne $runtime -and -not [string]::IsNullOrWhiteSpace([string]$runtime.updatedAt)) {
    $updated = [DateTimeOffset]::Parse([string]$runtime.updatedAt)
    $fresh = ([DateTimeOffset]::UtcNow - $updated).TotalSeconds -le [Math]::Max(90, $IntervalSeconds * 3)
  }
  return [ordered]@{
    alive = $null -ne $process -and $fresh -and $runtime.stopped -ne $true
    pid = if ($null -ne $process) { $process.Id } else { $null }
    healthy = if ($null -ne $runtime) { $runtime.healthy -eq $true } else { $false }
    fresh = $fresh
    consecutiveFailures = if ($null -ne $runtime) { $runtime.consecutiveFailures } else { $null }
    errorCode = if ($null -ne $runtime) { $runtime.errorCode } else { $null }
    updatedAt = if ($null -ne $runtime) { $runtime.updatedAt } else { $null }
    autostartInstalled = $null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  }
}

function Start-Supervisor {
  $status = Get-SupervisorStatus
  if ($status.alive) { return [ordered]@{ status = "already_running"; pid = $status.pid } }
  if (-not (Test-Path -LiteralPath $Pythonw)) { throw "Versioned Python runtime not found: $Pythonw" }
  New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
  if (Test-Path -LiteralPath $StopPath) { Remove-Item -LiteralPath $StopPath -Force }
  $launchStartedAt = [DateTimeOffset]::UtcNow
  $arguments = @(
    "-m", "wechat_docs_mcp.supervisor",
    "--data-root", ('"' + $DataRoot + '"'),
    "--health-url", ('"' + $HealthUrl + '"'),
    "--interval", [string][Math]::Max(5, $IntervalSeconds),
    "--timeout", [string][Math]::Max(1, $TimeoutSeconds)
  )
  $process = Start-Process -FilePath $Pythonw -ArgumentList $arguments -WindowStyle Hidden -PassThru
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 250
    $runtime = Read-Runtime
    if ($null -ne $runtime -and [int]$runtime.pid -gt 0) {
      $runtimeProcess = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
      $runtimeStartedAt = if ($runtime.startedAt) { [DateTimeOffset]::Parse([string]$runtime.startedAt) } else { [DateTimeOffset]::MinValue }
      if ($null -ne $runtimeProcess -and $runtimeStartedAt -ge $launchStartedAt.AddSeconds(-2) -and $runtime.stopped -ne $true) {
        return [ordered]@{
          status = "started"
          pid = $runtimeProcess.Id
          launcherPid = $process.Id
          healthy = $runtime.healthy -eq $true
          errorCode = $runtime.errorCode
        }
      }
    }
  } while ([DateTimeOffset]::UtcNow -lt $deadline -and -not $process.HasExited)
  throw "Supervisor did not publish a matching runtime state within 15 seconds"
}

function Stop-Supervisor {
  New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
  Set-Content -LiteralPath $StopPath -Value "stop" -Encoding UTF8
  $runtime = Read-Runtime
  if ($null -eq $runtime -or [int]$runtime.pid -le 0) { return [ordered]@{ status = "not_running" } }
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
  do {
    $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return [ordered]@{ status = "stopped"; pid = [int]$runtime.pid } }
    Start-Sleep -Milliseconds 500
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  return [ordered]@{ status = "stopping"; pid = [int]$runtime.pid; alive = $true }
}

function Backup-ScheduledTask {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $existing) { return $null }
  $stamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssZ")
  $backupRoot = Join-Path $DataRoot ("backups\supervisor-task-" + $stamp)
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $backupRoot "scheduled-task.xml") -Encoding UTF8
  return $backupRoot
}

switch ($Action) {
  "Start" { Start-Supervisor | ConvertTo-Json -Depth 4 }
  "Stop" { Stop-Supervisor | ConvertTo-Json -Depth 4 }
  "Status" { Get-SupervisorStatus | ConvertTo-Json -Depth 4 }
  "InstallAutostart" {
    if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "Supervisor management script not found: $ScriptPath" }
    $backupRoot = Backup-ScheduledTask
    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '" -Action Start -CodeRoot "' + $CodeRoot + '" -DataRoot "' + $DataRoot + '" -HealthUrl "' + $HealthUrl + '" -TaskName "' + $TaskName + '" -IntervalSeconds ' + [Math]::Max(5, $IntervalSeconds) + ' -TimeoutSeconds ' + [Math]::Max(1, $TimeoutSeconds)
    $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    [ordered]@{ status = "installed"; taskName = $TaskName; backupRoot = $backupRoot } | ConvertTo-Json -Depth 4
  }
  "RemoveAutostart" {
    $backupRoot = Backup-ScheduledTask
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    [ordered]@{ status = if ($null -ne $existing) { "removed" } else { "not_installed" }; taskName = $TaskName; backupRoot = $backupRoot } | ConvertTo-Json -Depth 4
  }
}
