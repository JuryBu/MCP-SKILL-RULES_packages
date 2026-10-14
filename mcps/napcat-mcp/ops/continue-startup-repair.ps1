[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigurationPath,
  [Parameter(Mandatory)][string]$ConfigurationSha256,
  [ValidateSet('Inspect','Apply','RestoreFiles','ResumeInstalled')][string]$Action='Inspect',
  [string]$OwnerConfirmation='',
  [string]$FixtureCloseConfirmation=''
)
$ErrorActionPreference='Stop'
$Utf8=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$Utf8
function Sha([string]$Path) {(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function FixtureRootIdentity([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2).Contains(':') -or $Path -match '[*?\x00]' -or @($Path -split '[\\/]' | Where-Object {$_ -eq '..' -or $_ -eq '.'}).Count) {throw 'FIXTURE_PATH_ESCAPE'}
  $Full=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
  $Current=$Full
  while ($Current) {
    if (Test-Path -LiteralPath $Current) {
      $Item=Get-Item -LiteralPath $Current -Force
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Item.LinkType) {throw 'FIXTURE_PATH_LINK_FORBIDDEN'}
    }
    $Current=Split-Path -Parent $Current
  }
  return $Full
}
if ((Sha $ConfigurationPath) -cne $ConfigurationSha256) {throw 'OWNER_CONFIGURATION_CHANGED'}
$Configuration=Get-Content -LiteralPath $ConfigurationPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (($Configuration.PSObject.Properties.Name -contains 'upgradeScope') -and $Configuration.upgradeScope -cnotin @('startup-notification-only','full-runtime-and-startup')) {throw 'OWNER_UPGRADE_SCOPE_INVALID'}
$ExpectedConfirmation=if($Configuration.upgradeScope -ceq 'full-runtime-and-startup'){'APPLY_FULL_RUNTIME_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG'}else{'APPLY_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG'}
if ($Configuration.schemaVersion -ne 1 -or $Configuration.mode -cnotin @('ManualProduction','TempFixture') -or (Sha $PSCommandPath) -cne $Configuration.ownerEntrySha256 -or $Configuration.withdrawn) {throw 'OWNER_ENTRY_CHANGED_OR_WITHDRAWN'}
$FixtureMode=$Configuration.mode -ceq 'TempFixture'
if ($FixtureMode) {
  $FixtureRoot=FixtureRootIdentity ([string]$Configuration.fixtureRoot)
  $Temp=[IO.Path]::GetTempPath().TrimEnd('\','/')
  if (-not $FixtureRoot.StartsWith($Temp+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'FIXTURE_ROOT_ESCAPE'}
  $Marker=Get-Content -LiteralPath (Join-Path $FixtureRoot 'owner.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Marker.ownerId -cne 'startup-repair-20261012' -or (FixtureRootIdentity ([string]$Marker.fixtureRoot)) -ine $FixtureRoot) {throw 'FIXTURE_OWNER_CONFLICT'}
  foreach ($Path in @($ConfigurationPath,$Configuration.fileEntry,$Configuration.manifestPath,$Configuration.serviceOps,$Configuration.stopOps,$Configuration.dataRoot,$Configuration.brokerRoot,$Configuration.napCatRoot,$Configuration.qqExePath,$Configuration.codexExecutablePath)) {
    if (-not [IO.Path]::GetFullPath([string]$Path).StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'FIXTURE_PATH_ESCAPE'}
  }
} elseif ($FixtureCloseConfirmation) {throw 'PRODUCTION_FIXTURE_INPUT_FORBIDDEN'}
foreach ($Pin in $Configuration.pins) {if ((Sha $Pin.path) -cne $Pin.sha256) {throw ('OWNER_DEPENDENCY_CHANGED:'+$Pin.path)}}
if ((Sha $Configuration.manifestPath) -cne $Configuration.manifestSha256) {throw 'OWNER_MANIFEST_CHANGED'}
$BoundManifest=Get-Content -LiteralPath $Configuration.manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ManifestScope=if($BoundManifest.scope){[string]$BoundManifest.scope}else{'startup-notification-only'}
$ConfigurationScope=if($Configuration.upgradeScope){[string]$Configuration.upgradeScope}else{'startup-notification-only'}
if ($ManifestScope -cne $ConfigurationScope) {throw 'OWNER_MANIFEST_SCOPE_CHANGED'}
$HasTaskUpgrade=[bool]$Configuration.taskUpgrade
if ($HasTaskUpgrade -ne [bool]$BoundManifest.taskUpgrade) {throw 'OWNER_TASK_MANIFEST_CHANGED'}
if ($HasTaskUpgrade) {
  foreach ($Name in @('taskName','originalXmlPath','originalXmlSha256','candidateXmlPath','candidateXmlSha256','canonicalManifestSha256')) {
    if ($Configuration.taskUpgrade.$Name -cne $BoundManifest.taskUpgrade.$Name) {throw 'OWNER_TASK_MANIFEST_CHANGED'}
  }
  foreach ($Name in @('action','postInstallPins')) {
    if (($Configuration.taskUpgrade.$Name | ConvertTo-Json -Depth 10 -Compress) -cne ($BoundManifest.taskUpgrade.$Name | ConvertTo-Json -Depth 10 -Compress)) {throw 'OWNER_TASK_PHASE_PINS_CHANGED'}
  }
  . $Configuration.taskHelperPath
}
$PowerShell=if ($Configuration.ownerPowerShell) {[string]$Configuration.ownerPowerShell.path} else {Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'}
if ($Configuration.ownerPowerShell -and (Sha $PowerShell) -cne $Configuration.ownerPowerShell.sha256) {throw 'OWNER_POWERSHELL_IDENTITY_CHANGED'}
$SavedModulePath=$env:PSModulePath
$SavedNode=$env:CODEX_TOOLKIT_NODE_EXE
$SavedRealNode=$env:CODEX_REAL_NODE_EXE
$Lease=$null
$SupervisorLease=$null
$WatchdogLease=$null
$TaskRecoveryAllowed=$false
$Result=[ordered]@{status='PREPARED_NOT_APPLIED';action=$Action;filesInstalled=$false;servicesReady=$false;error=$null}
function Files([string]$FileAction,[bool]$VerifyOwner=$false) {
  $Arguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$Configuration.fileEntry,'-Action',$FileAction,'-Mode',$Configuration.mode,'-ManifestPath',$Configuration.manifestPath,'-ManifestSha256',$Configuration.manifestSha256)
  if ($VerifyOwner) {$Arguments+='-VerifyOwner'}
  $Text=& $PowerShell @Arguments | Out-String
  if ($LASTEXITCODE -ne 0) {throw ('FILE_TRANSACTION_REFUSED:'+$Text)}
  return $Text | ConvertFrom-Json
}
function Operation([string]$Name,[hashtable]$Arguments) {
  $Text=& (Join-Path $Configuration.serviceOps $Name) @Arguments | Out-String
  if (-not $?) {throw ('SERVICE_OPERATION_FAILED:'+$Name)}
  return $Text | ConvertFrom-Json
}
function Set-ExistingWatchdogEnabled {
  param($Settings,[bool]$Enabled)
  if ($Settings.originalWatchdogEnabled -isnot [bool]) {throw 'ORIGINAL_WATCHDOG_ENABLED_REQUIRED'}
  if ($FixtureMode) {
    $Path=Join-Path $Settings.fixtureRoot 'watchdog-state.json'
    $State=Get-Content -LiteralPath (FixtureRootIdentity $Path) -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($State.execute -cne $Settings.watchdogExecute -or $State.arguments -cne $Settings.watchdogArguments) {throw 'WATCHDOG_CONFIGURATION_CHANGED'}
    $State.enabled=$Enabled
    [IO.File]::WriteAllText($Path,($State | ConvertTo-Json -Compress),$Utf8)
    return
  }
  $Task=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  if (@($Task.Actions).Count -ne 1 -or $Task.Actions[0].Execute -cne $Settings.watchdogExecute -or $Task.Actions[0].Arguments -cne $Settings.watchdogArguments) {throw 'WATCHDOG_CONFIGURATION_CHANGED'}
  if ($Enabled) {Enable-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' | Out-Null}
  else {Disable-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' | Out-Null}
  $Observed=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  if ([bool]$Observed.Settings.Enabled -ne $Enabled) {throw 'WATCHDOG_ENABLED_RESTORE_INCOMPLETE'}
}
function Stop-IdleWatchdog {
  param($Settings,[string]$Consent)
  $ExpectedConsent=if($Settings.upgradeScope -ceq 'full-runtime-and-startup'){'APPLY_FULL_RUNTIME_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG'}else{'APPLY_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG'}
  if ($Consent -cne $ExpectedConsent) {throw 'IDLE_WATCHDOG_OWNER_CONFIRMATION_REQUIRED'}
  $Task=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  if (@($Task.Actions).Count -ne 1 -or $Task.Actions[0].Execute -cne $Settings.watchdogExecute -or $Task.Actions[0].Arguments -cne $Settings.watchdogArguments -or $Task.Settings.Enabled) {throw 'IDLE_WATCHDOG_TASK_IDENTITY_CHANGED'}
  $WatchdogScript=Join-Path $Settings.serviceOps 'Run-NapCatSupervisorWatchdog.ps1'
  $HiddenScript=Join-Path $Settings.serviceOps 'Run-HiddenPowerShell.vbs'
  $WindowsShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Snapshot=@(Get-CimInstance Win32_Process -ErrorAction Stop)
  $Workers=@($Snapshot | Where-Object {$_.Name -ieq 'powershell.exe' -and $_.CommandLine -like "*`"$WatchdogScript`"*" -and $_.CommandLine -like "*-DataRoot `"$($Settings.dataRoot)`"*"})
  $Roots=@($Snapshot | Where-Object {$_.Name -ieq 'wscript.exe' -and $_.ExecutablePath -ieq $Settings.watchdogExecute -and $_.CommandLine -like "*`"$HiddenScript`"*" -and $_.CommandLine -like "*`"$WatchdogScript`"*" -and $_.CommandLine -like "*-DataRoot `"$($Settings.dataRoot)`"*"})
  foreach ($Worker in $Workers) {
    if ($Worker.ExecutablePath -ine $WindowsShell -or @($Roots | Where-Object {$_.ProcessId -eq $Worker.ParentProcessId}).Count -ne 1) {throw 'IDLE_WATCHDOG_PROCESS_IDENTITY_CHANGED'}
  }
  $WorkerIds=@($Workers | ForEach-Object ProcessId)
  $Consoles=@($Snapshot | Where-Object {$_.ParentProcessId -in $WorkerIds -and $_.Name -ieq 'conhost.exe' -and $_.ExecutablePath -ieq (Join-Path $env:SystemRoot 'System32\conhost.exe')})
  $Allowed=@($Roots)+@($Workers)+@($Consoles)
  $AllowedIds=@($Allowed | ForEach-Object ProcessId)
  foreach ($Process in $Snapshot) {
    if ($Process.ParentProcessId -in $AllowedIds -and $Process.ProcessId -notin $AllowedIds) {throw ('WATCHDOG_HAS_LIVE_CHILD_NO_TASK_STOP:'+ $Process.Name)}
  }
  if (@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -in @(18431,18432,18433,18434,18435)}).Count -gt 0) {throw 'PROXY_LISTENER_REMAINS_NO_TASK_STOP'}
  $ManagedFile=Join-Path $Settings.dataRoot 'state\inner-managed\managed-runtime.json'
  $ManagedState=Get-Content -LiteralPath $ManagedFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $ModelPids=@($ManagedState.coordinator.workers | ForEach-Object pid)
  foreach ($ModelPid in $ModelPids) {
    if ($ModelPid -gt 0 -and @(Get-CimInstance Win32_Process -Filter "ProcessId=$ModelPid" -ErrorAction Stop).Count -gt 0) {throw 'MODEL_WORKER_REMAINS_NO_TASK_STOP'}
  }
  if ($Allowed.Count -eq 0) {
    if ($Task.State -eq 'Running') {throw 'RUNNING_TASK_PROCESS_UNRESOLVED'}
    return
  }
  foreach ($Process in $Allowed) {
    $Current=Get-CimInstance Win32_Process -Filter "ProcessId=$($Process.ProcessId)" -ErrorAction Stop
    if ($Current -and ($Current.CreationDate -ne $Process.CreationDate -or $Current.CommandLine -cne $Process.CommandLine)) {throw 'IDLE_WATCHDOG_PROCESS_CHANGED'}
  }
  $Check=@(Get-CimInstance Win32_Process -ErrorAction Stop)
  if (@($Check | Where-Object {$_.ParentProcessId -in $AllowedIds -and $_.ProcessId -notin $AllowedIds}).Count -gt 0) {throw 'WATCHDOG_CHILD_APPEARED_NO_TASK_STOP'}
  Stop-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  $Deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    $Remaining=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ProcessId -in $AllowedIds})
    if ($Remaining.Count -eq 0) {return}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw 'IDLE_WATCHDOG_DID_NOT_EXIT_FILES_UNCHANGED'
}
try {
  $env:PSModulePath="$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
  $env:CODEX_TOOLKIT_NODE_EXE=$Configuration.nodePath
  $env:CODEX_REAL_NODE_EXE=$Configuration.nodePath
  $Inspection=Files 'Inspect' ($Action -ne 'Inspect')
  if ($HasTaskUpgrade) {$TaskInspection=Get-StartupTaskPhase $Configuration;$Result['taskPhase']=$TaskInspection.phase}
  if ($Action -eq 'Inspect') {$Result.status=$Inspection.status;return}
  if ($OwnerConfirmation -cne $ExpectedConfirmation) {throw 'OWNER_CONFIRMATION_REQUIRED'}
  if ($Action -eq 'Apply' -and $Inspection.status -cne 'PREPARED') {throw 'APPLY_ALREADY_ATTEMPTED_INSPECT_OR_RESTORE_FILES'}
  if ($HasTaskUpgrade -and $Action -eq 'Apply' -and $TaskInspection.phase -cne 'original') {throw 'TASK_ALREADY_REPLACED_INSPECT_OR_RESTORE_FILES'}
  if ($Action -eq 'ResumeInstalled' -and ($Inspection.status -cne 'INSTALLED' -or -not $HasTaskUpgrade -or $TaskInspection.phase -cne 'candidate' -or $TaskInspection.enabled -or $TaskInspection.state -ceq 'Running')) {throw 'INSTALLED_CANDIDATE_REQUIRED_FOR_RESUME'}
  if (-not $FixtureMode -and -not $HasTaskUpgrade) {
    $Watchdog=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
    if (@($Watchdog.Actions).Count -ne 1 -or $Watchdog.Actions[0].Execute -cne $Configuration.watchdogExecute -or $Watchdog.Actions[0].Arguments -cne $Configuration.watchdogArguments) {throw 'WATCHDOG_CONFIGURATION_CHANGED'}
  }
  Write-Host 'Close Codex normally. Model and service processes must exit normally; only the verified idle watchdog task may be stopped.'
  $Closed=if ($FixtureMode) {$FixtureCloseConfirmation} else {Read-Host 'After Codex is closed, enter CLOSE-CODEX'}
  if ($Closed -cne 'CLOSE-CODEX') {throw 'OWNER_CLOSE_CONFIRMATION_CANCELLED'}
  $StateRoot=Join-Path $Configuration.dataRoot 'state'
  $RuntimePath=Join-Path $StateRoot 'codex-app-server-proxy-runtime.json'
  $ManagedPath=Join-Path $StateRoot 'inner-managed\managed-runtime.json'
  $Deadline=[DateTime]::UtcNow.AddSeconds(20)
  do {
    $Managed=Get-Content -LiteralPath $ManagedPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Busy=@($Managed.coordinator.threads | Where-Object {$_.phase -ne 'terminal' -or $_.activeHttp -ne 0}).Count -gt 0 -or $Managed.controlBusy -or $Managed.coordinator.transactionActive
    if (-not $Busy) {break}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  if ($Busy) {throw 'BUSINESS_STILL_ACTIVE_NO_SERVICE_STOP_OR_INSTALL'}
  $StopPath=Join-Path $StateRoot 'codex-app-server-proxy.stop'
  . (Join-Path $Configuration.stopOps 'owned-stop-marker.ps1')
  $SupervisorStop=Join-Path $StateRoot 'supervisor.stop'
  if (Test-Path -LiteralPath $SupervisorStop) {
    if (-not $Configuration.supervisorStopSha256 -or (Sha $SupervisorStop) -cne $Configuration.supervisorStopSha256) {throw 'SUPERVISOR_STOP_REQUIREMENT_CHANGED'}
    Move-Item -LiteralPath $SupervisorStop -Destination (Join-Path (Split-Path -Parent $ConfigurationPath) 'retired-supervisor.stop')
  }
  if ($HasTaskUpgrade) {Disable-StartupTask $Configuration | Out-Null}
  else {Set-ExistingWatchdogEnabled $Configuration $false}
  $WatchdogStop=Join-Path $StateRoot 'supervisor-watchdog.stop'
  $WatchdogAttempt=[Guid]::NewGuid().ToString()
  $WatchdogLease=New-OwnedStopMarker -Path $WatchdogStop -Component 'watchdog' -AttemptId $WatchdogAttempt -LifetimeSeconds 300
  $SupervisorAttempt=[Guid]::NewGuid().ToString()
  $SupervisorLease=New-OwnedStopMarker -Path $SupervisorStop -Component 'supervisor' -AttemptId $SupervisorAttempt -LifetimeSeconds 300
  $SupervisorRuntimePath=Join-Path $StateRoot 'supervisor-runtime.json'
  $SupervisorPid=if (Test-Path -LiteralPath $SupervisorRuntimePath) {[int](Get-Content -LiteralPath $SupervisorRuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json).pid} else {0}
  $SupervisorDeadline=[DateTime]::UtcNow.AddSeconds(20)
  do {
    $SupervisorProcess=if ($SupervisorPid -gt 0) {Get-CimInstance Win32_Process -Filter "ProcessId=$SupervisorPid" -ErrorAction Stop} else {$null}
    if (-not $SupervisorProcess) {break}
    if ($SupervisorProcess.CommandLine -notlike "*$SupervisorRuntimePath*" -or $SupervisorProcess.CommandLine -notmatch 'supervisor-runner\.mjs') {throw 'SUPERVISOR_PROCESS_IDENTITY_CHANGED'}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $SupervisorDeadline)
  if ($SupervisorProcess) {throw 'SUPERVISOR_NORMAL_STOP_INCOMPLETE_FILES_UNCHANGED'}
  $Attempt=[Guid]::NewGuid().ToString()
  $Lease=New-OwnedStopMarker -Path $StopPath -Component 'proxy' -AttemptId $Attempt -LifetimeSeconds 300
  $ProofPath=Join-Path (Split-Path -Parent $ConfigurationPath) ('stop-proof-'+$Attempt+'.json')
  [IO.File]::WriteAllText($ProofPath,(Export-OwnedStopMarkerProof -Lease $Lease -Path $StopPath -Component 'proxy' -AttemptId $Attempt),$Utf8)
  $StopText=& (Join-Path $Configuration.stopOps 'stop-codex-app-server-proxy.ps1') -DataRoot $Configuration.dataRoot -TimeoutSeconds 30 -ChildTimeoutSeconds 30 -StopMarkerProofPath $ProofPath -StopMarkerAttemptId $Attempt -StopMarkerOperationId $Lease.OperationId | Out-String
  $Stopped=$StopText | ConvertFrom-Json
  if (-not $Stopped.stopped -or -not $Stopped.clean -or -not $Stopped.childStopped -or $Stopped.forced -or $Stopped.childForced) {throw 'NORMAL_STOP_INCOMPLETE_FILES_UNCHANGED'}
  if ($HasTaskUpgrade -and $TaskInspection.phase -ceq 'candidate' -and -not $FixtureMode) {
    $TaskDeadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
      $CurrentTask=Get-StartupTaskPhase $Configuration
      if ($CurrentTask.state -cne 'Running') {break}
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $TaskDeadline)
    if ($CurrentTask.state -ceq 'Running') {throw 'NEW_TASK_NORMAL_EXIT_INCOMPLETE_FILES_UNCHANGED'}
  } elseif (-not $FixtureMode) {Stop-IdleWatchdog -Settings $Configuration -Consent $OwnerConfirmation}
  $TaskRecoveryAllowed=$true
  if ($Action -eq 'RestoreFiles') {
    if ($HasTaskUpgrade) {Set-StartupTaskPhase $Configuration 'original' | Out-Null}
    $Restored=Files 'Rollback' $true
    $Result.status=$Restored.status
    if ($HasTaskUpgrade) {Restore-StartupTaskEnabled $Configuration 'original' | Out-Null;$Result['taskPhase']='original'}
    else {Set-ExistingWatchdogEnabled $Configuration $Configuration.originalWatchdogEnabled}
    return
  }
  if ($Action -eq 'ResumeInstalled') {$Result.filesInstalled=$true} else {
    $Installed=Files 'Install' $true
    $Result.filesInstalled=$Installed.status -ceq 'INSTALLED'
  }
  if (-not $Result.filesInstalled) {throw 'FILE_INSTALLATION_NOT_COMPLETE'}
  if ($HasTaskUpgrade -and $Action -ne 'ResumeInstalled') {
    Set-StartupTaskPhase $Configuration 'candidate' | Out-Null
    $Result['taskPhase']='candidate'
  }
  Consume-OwnedStopMarker -Lease $Lease -Path $StopPath -Component 'proxy' -AttemptId $Attempt | Out-Null
  $Lease=$null
  $Started=Operation 'start-codex-model-stream-proxy.ps1' @{DataRoot=$Configuration.dataRoot;CodexExecutablePath=$Configuration.codexExecutablePath}
  if (-not $Started.running -or $Started.mode -cne 'managed' -or $Started.outer.state -cne 'running') {throw 'MANAGED_START_NOT_READY'}
  if (Test-Path -LiteralPath (Join-Path $StateRoot 'task-router.stop')) {throw 'ROUTER_STOP_REQUIREMENT_PRESERVED'}
  $Router=Operation 'start-napcat-task-router.ps1' @{DataRoot=$Configuration.dataRoot;BrokerRoot=$Configuration.brokerRoot}
  if (-not $Router.started -and $Router.reason -cne 'already_running') {throw 'ROUTER_START_FAILED'}
  Consume-OwnedStopMarker -Lease $SupervisorLease -Path $SupervisorStop -Component 'supervisor' -AttemptId $SupervisorAttempt | Out-Null
  $SupervisorLease=$null
  $Supervisor=Operation 'start-napcat-supervisor.ps1' @{DataRoot=$Configuration.dataRoot;BrokerRoot=$Configuration.brokerRoot;NapCatRoot=$Configuration.napCatRoot;QqExePath=$Configuration.qqExePath}
  if (-not $Supervisor.started -and $Supervisor.reason -cne 'already_running') {throw 'SUPERVISOR_START_FAILED'}
  Consume-OwnedStopMarker -Lease $WatchdogLease -Path $WatchdogStop -Component 'watchdog' -AttemptId $WatchdogAttempt | Out-Null
  $WatchdogLease=$null
  if ($HasTaskUpgrade) {Restore-StartupTaskEnabled $Configuration 'candidate' | Out-Null}
  else {Set-ExistingWatchdogEnabled $Configuration $Configuration.originalWatchdogEnabled}
  if (-not $FixtureMode -and $Configuration.originalWatchdogEnabled) {
    Start-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  }
  $Result.servicesReady=$true
  $Result.status='FILES_INSTALLED_SERVICES_STARTED_OPEN_SHORTCUT_MANUALLY'
} catch {
  $Result.status=if ($Result.filesInstalled) {'INSTALLED_RECOVERY_REQUIRED'} else {'REFUSED_PRESERVED'}
  $Result.error=$_.Exception.Message
  if ($HasTaskUpgrade -and $TaskRecoveryAllowed -and $Lease -and $Action -cin @('Apply','ResumeInstalled')) {
    try {
      Disable-StartupTask $Configuration | Out-Null
      Set-StartupTaskPhase $Configuration 'original' | Out-Null
      $Recovered=Files 'Rollback' $true
      if ($Recovered.status -cne 'ROLLED_BACK') {throw 'JOINT_FILE_ROLLBACK_INCOMPLETE'}
      Restore-StartupTaskEnabled $Configuration 'original' | Out-Null
      $Result.status='JOINT_ROLLED_BACK_OPEN_SHORTCUT_MANUALLY'
      $Result.filesInstalled=$false
      $Result['taskPhase']='original'
    } catch {$Result['jointRecoveryError']=$_.Exception.Message}
  }
} finally {
  if ($WatchdogLease) {
    try {Consume-OwnedStopMarker -Lease $WatchdogLease -Path $WatchdogStop -Component 'watchdog' -AttemptId $WatchdogAttempt | Out-Null;$WatchdogLease=$null} catch {$Result['ownedWatchdogStopError']=$_.Exception.Message}
    if ($WatchdogLease) {try {Close-OwnedStopMarker -Lease $WatchdogLease | Out-Null} catch {$Result['ownedWatchdogStopCloseError']=$_.Exception.Message}}
  }
  if ($SupervisorLease) {
    try {Consume-OwnedStopMarker -Lease $SupervisorLease -Path $SupervisorStop -Component 'supervisor' -AttemptId $SupervisorAttempt | Out-Null;$SupervisorLease=$null} catch {$Result['ownedSupervisorStopError']=$_.Exception.Message}
    if ($SupervisorLease) {try {Close-OwnedStopMarker -Lease $SupervisorLease | Out-Null} catch {$Result['ownedSupervisorStopCloseError']=$_.Exception.Message}}
  }
  if ($Lease) {
    try {Consume-OwnedStopMarker -Lease $Lease -Path $StopPath -Component 'proxy' -AttemptId $Attempt | Out-Null;$Lease=$null} catch {$Result['ownedStopError']=$_.Exception.Message}
    if ($Lease) {try {Close-OwnedStopMarker -Lease $Lease | Out-Null} catch {$Result['ownedStopCloseError']=$_.Exception.Message}}
  }
  $env:PSModulePath=$SavedModulePath
  $env:CODEX_TOOLKIT_NODE_EXE=$SavedNode
  $env:CODEX_REAL_NODE_EXE=$SavedRealNode
  $Output=$Result | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $ConfigurationPath) 'owner-result.json'),$Output,$Utf8)
  $Output
}
if ($Result.error) {exit 1}
