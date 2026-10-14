[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigurationPath,
  [Parameter(Mandatory)][string]$ConfigurationSha256,
  [ValidateSet('Inspect','Recover')][string]$Action='Inspect',
  [string]$FixtureConfirmation=''
)
$ErrorActionPreference='Stop'
$Utf8=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$Utf8
function Sha([string]$Path) {(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Read-JsonText([string]$Text) {
  $Arguments=@{InputObject=$Text}
  if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {$Arguments.DateKind='String'}
  ConvertFrom-Json @Arguments
}
function Json([string]$Path) {Read-JsonText (Get-Content -LiteralPath $Path -Raw -Encoding UTF8)}
function Write-NewJson([string]$Path,$Value) {
  $Bytes=$Utf8.GetBytes(($Value | ConvertTo-Json -Depth 40 -Compress))
  $Stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  try {$Stream.Write($Bytes,0,$Bytes.Length);$Stream.Flush($true)} finally {$Stream.Dispose()}
}
if ((Sha $ConfigurationPath) -cne $ConfigurationSha256) {throw 'COLD_RECOVERY_CONFIGURATION_CHANGED'}
$Configuration=Json $ConfigurationPath
foreach ($Pin in $Configuration.pins) {if ((Sha $Pin.path) -cne $Pin.sha256) {throw ('COLD_RECOVERY_PIN_CHANGED:'+$Pin.path)}}
if ([IO.Path]::GetFullPath($PSCommandPath) -ine [IO.Path]::GetFullPath($Configuration.entryPath)) {throw 'COLD_RECOVERY_ENTRY_CHANGED'}
$Fixture=$Configuration.mode -ceq 'TempFixture'
if (-not $Fixture -and $FixtureConfirmation) {throw 'COLD_RECOVERY_FIXTURE_ARGUMENT_FORBIDDEN'}
$InputConfiguration=Json $Configuration.inputPath
$Profile=Json $InputConfiguration.profilePath
$Owner=Json $Configuration.ownerConfigurationPath
$StateRoot=Join-Path $Owner.dataRoot 'state'
$Result=[ordered]@{status='NOT_STARTED';action=$Action;servicesReady=$false;filesReplaced=0;error=$null;retryAllowed=$false}
$Leases=@{}
$Attempt=[Guid]::NewGuid().ToString()
$TaskDisabled=$false
$ArchivePath=$null
$SavedNode=$env:CODEX_TOOLKIT_NODE_EXE
$SavedRealNode=$env:CODEX_REAL_NODE_EXE
$SavedModules=$env:PSModulePath
function Check([string]$Step,[string]$SnapshotPath='',[string]$ProofPath='') {
  $Text=& $Configuration.nodePath $Configuration.ioPath $ConfigurationPath $ConfigurationSha256 $Step $SnapshotPath $ProofPath 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {throw ('COLD_RECOVERY_CHECK_'+$Step+':'+$Text.Trim())}
  return Read-JsonText $Text
}
function Task-Read {
  if ($Fixture) {return Json (Join-Path $Configuration.fixtureRoot 'watchdog-state.json')}
  $Task=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
  if (@($Task.Actions).Count -ne 1) {throw 'COLD_RECOVERY_TASK_ACTION_COUNT'}
  return [pscustomobject]@{execute=$Task.Actions[0].Execute;arguments=$Task.Actions[0].Arguments;enabled=[bool]$Task.Settings.Enabled;state=[string]$Task.State}
}
function Task-Set([bool]$Enabled) {
  $Task=Task-Read
  if ($Task.execute -cne $Owner.watchdogExecute -or $Task.arguments -cne $Owner.watchdogArguments) {throw 'COLD_RECOVERY_TASK_CHANGED'}
  if ($Fixture) {$Task.enabled=$Enabled;[IO.File]::WriteAllText((Join-Path $Configuration.fixtureRoot 'watchdog-state.json'),($Task | ConvertTo-Json -Compress),$Utf8)}
  elseif ($Enabled) {Enable-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' | Out-Null}
  else {Disable-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\' | Out-Null}
  if ($Fixture -and -not $Enabled -and (Test-Path -LiteralPath (Join-Path $Configuration.fixtureRoot 'disable-readback-fault'))) {throw 'FIXTURE_DISABLE_READBACK_FAILED'}
  if ((Task-Read).enabled -ne $Enabled) {throw 'COLD_RECOVERY_TASK_ENABLED_NOT_CONFIRMED'}
}
function Snapshot([string]$Path) {
  if ($Fixture) {
    $FixtureSnapshot=Join-Path $Configuration.fixtureRoot 'snapshot.json'
    $SecondFixture=Join-Path $Configuration.fixtureRoot 'second-snapshot.json'
    if ((Split-Path -Leaf $Path) -ceq 'before-proxy-stop.json' -and (Test-Path -LiteralPath $SecondFixture)) {
      $FixtureValue=Json $SecondFixture
      [IO.File]::WriteAllText($FixtureSnapshot,($FixtureValue | ConvertTo-Json -Depth 30),$Utf8)
    }
    $Value=Json $FixtureSnapshot;$Value.now=[DateTime]::UtcNow.ToString('o')
  }
  else {
    $Processes=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.ProcessId -gt 0} | ForEach-Object {
      [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name;creationDate=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''});executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}
    })
    $Listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {[pscustomobject]@{localPort=[int]$_.LocalPort;owningProcess=[int]$_.OwningProcess;state='Listen'}})
    $Runtime=Json $InputConfiguration.runtimePath
    $Managed=Json $Profile.managedStatePath
    $Value=[pscustomobject]@{processes=$Processes;listeners=$Listeners;runtime=$Runtime;managed=$Managed;now=[DateTime]::UtcNow.ToString('o')}
  }
  Write-NewJson $Path $Value
}
function Operation([string]$Name,[hashtable]$Arguments) {
  $Text=& (Join-Path $Owner.serviceOps $Name) @Arguments | Out-String
  if (-not $?) {throw ('COLD_RECOVERY_OPERATION_FAILED:'+$Name)}
  return Read-JsonText $Text
}
function Consume([string]$Component,[string]$Path) {
  if ($Leases.ContainsKey($Component)) {
    Consume-OwnedStopMarker -Lease $Leases[$Component] -Path $Path -Component $Component -AttemptId $Attempt | Out-Null
    $Leases.Remove($Component)
  }
}
function Fresh-Proof($Value) {
  if ([DateTime]::UtcNow -ge [DateTime]::Parse($Value.expiresAt).ToUniversalTime()) {throw 'COLD_RECOVERY_PROOF_EXPIRED'}
}
try {
  Check 'Inspect' | Out-Null
  if ($Action -eq 'Inspect') {$Result.status='RECOVERY_MATERIAL_PREPARED_NOT_EXECUTED';return}
  $Binding=Check 'Bind'
  $Task=Task-Read
  if ($Task.execute -cne $Owner.watchdogExecute -or $Task.arguments -cne $Owner.watchdogArguments -or $Task.enabled -ne $Owner.originalWatchdogEnabled) {throw 'COLD_RECOVERY_TASK_CHANGED'}
  Write-Host 'Close Codex normally on this machine. This restores the CURRENT installed version; it does not uninstall the upgrade.'
  $Consent=if ($Fixture) {$FixtureConfirmation} else {Read-Host 'After closing Codex, type RECOVER-CURRENT-RUNTIME'}
  if ($Consent -cne 'RECOVER-CURRENT-RUNTIME') {throw 'COLD_RECOVERY_CANCELLED'}
  $Work=Join-Path (Split-Path -Parent $ConfigurationPath) ('cold-recovery-'+$Attempt)
  New-Item -ItemType Directory -Path $Work -ErrorAction Stop | Out-Null
  $SnapshotPath=Join-Path $Work 'before.json'
  Snapshot $SnapshotPath
  $Proof=Check 'Quiescent' $SnapshotPath
  $ProofPath=Join-Path $Work 'proof.json'
  Write-NewJson $ProofPath $Proof
  $Intent=Join-Path (Split-Path -Parent $ConfigurationPath) 'cold-recovery-attempt.json'
  Write-NewJson $Intent ([ordered]@{attemptId=$Attempt;configurationSha256=$ConfigurationSha256;inputSha256=$Configuration.inputSha256;work=$Work;state='STARTED';binding=$Binding})
  $Result['work']=$Work
  $env:CODEX_TOOLKIT_NODE_EXE=$Owner.nodePath
  $env:CODEX_REAL_NODE_EXE=$Owner.nodePath
  $env:PSModulePath="$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules;$env:ProgramFiles\WindowsPowerShell\Modules"
  . (Join-Path $Owner.stopOps 'owned-stop-marker.ps1')
  $StopPaths=@{watchdog=(Join-Path $StateRoot 'supervisor-watchdog.stop');supervisor=(Join-Path $StateRoot 'supervisor.stop');proxy=(Join-Path $StateRoot 'codex-app-server-proxy.stop')}
  foreach ($Path in $StopPaths.Values) {if (Test-Path -LiteralPath $Path) {throw 'COLD_RECOVERY_FOREIGN_STOP_PRESERVED'}}
  if (Test-Path -LiteralPath (Join-Path $StateRoot 'task-router.stop')) {throw 'COLD_RECOVERY_ROUTER_STOP_PRESERVED'}
  Fresh-Proof $Proof
  $TaskDisabled=$true
  Task-Set $false
  foreach ($Component in @('watchdog','supervisor')) {$Leases[$Component]=New-OwnedStopMarker -Path $StopPaths[$Component] -Component $Component -AttemptId $Attempt -LifetimeSeconds 600}
  $SupervisorRuntime=Json (Join-Path $StateRoot 'supervisor-runtime.json')
  if (-not $Fixture) {
    $SupervisorDeadline=[DateTime]::UtcNow.AddSeconds(30)
    do {
      $Supervisor=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$SupervisorRuntime.pid)" -ErrorAction Stop
      if (-not $Supervisor) {break}
      if ($Supervisor.CommandLine -notlike "*$(Join-Path $StateRoot 'supervisor-runtime.json')*" -or $Supervisor.CommandLine -notmatch 'supervisor-runner\.mjs') {throw 'COLD_RECOVERY_SUPERVISOR_CHANGED'}
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $SupervisorDeadline)
    if ($Supervisor) {throw 'COLD_RECOVERY_SUPERVISOR_DID_NOT_EXIT'}
  }
  $SecondSnapshot=Join-Path $Work 'before-proxy-stop.json'
  Snapshot $SecondSnapshot
  $SecondProof=Check 'Quiescent' $SecondSnapshot $ProofPath
  $ProofPath=Join-Path $Work 'combined-proof.json'
  Write-NewJson $ProofPath $SecondProof
  Fresh-Proof $SecondProof
  $Leases['proxy']=New-OwnedStopMarker -Path $StopPaths.proxy -Component 'proxy' -AttemptId $Attempt -LifetimeSeconds 600
  $MarkerProofPath=Join-Path $Work 'stop-marker-proof.json'
  [IO.File]::WriteAllText($MarkerProofPath,(Export-OwnedStopMarkerProof -Lease $Leases.proxy -Path $StopPaths.proxy -Component 'proxy' -AttemptId $Attempt),$Utf8)
  Fresh-Proof $SecondProof
  $StoppedText=& (Join-Path $Owner.stopOps 'stop-codex-app-server-proxy.ps1') -DataRoot $Owner.dataRoot -TimeoutSeconds 30 -ChildTimeoutSeconds 30 -StopMarkerProofPath $MarkerProofPath -StopMarkerAttemptId $Attempt -StopMarkerOperationId $Leases.proxy.OperationId | Out-String
  $Stopped=Read-JsonText $StoppedText
  if (-not $Stopped.clean -or -not $Stopped.stopped -or -not $Stopped.childStopped -or $Stopped.forced -or $Stopped.childForced) {throw 'COLD_RECOVERY_NORMAL_EXIT_INCOMPLETE'}
  $ExitedSnapshot=Join-Path $Work 'after-stop.json'
  Snapshot $ExitedSnapshot
  Check 'Exited' $ExitedSnapshot $ProofPath | Out-Null
  $Deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
    if ((Task-Read).state -cne 'Running') {break}
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  if ((Task-Read).state -ceq 'Running') {throw 'COLD_RECOVERY_WATCHDOG_DID_NOT_EXIT'}
  Check 'Bind' | Out-Null
  $ArchivePath=Join-Path $Work 'inner-candidate-approvals.original.json'
  if (Test-Path -LiteralPath $ArchivePath) {throw 'COLD_RECOVERY_ARCHIVE_ALREADY_EXISTS'}
  Move-Item -LiteralPath $Binding.registryPath -Destination $ArchivePath -ErrorAction Stop
  if ((Sha $ArchivePath) -cne $Binding.registrySha256 -or (Test-Path -LiteralPath $Binding.registryPath)) {throw 'COLD_RECOVERY_ARCHIVE_NOT_CONFIRMED'}
  $Result['registryArchive']=$ArchivePath
  if ($Binding.baselineRegistryPath) {
    if ((Sha $Binding.baselineRegistryPath) -cne $Binding.baselineRegistrySha256) {throw 'COLD_RECOVERY_BASELINE_CHANGED'}
    [IO.File]::Copy($Binding.baselineRegistryPath,$Binding.registryPath,$false)
    if ((Sha $Binding.registryPath) -cne $Binding.baselineRegistrySha256) {throw 'COLD_RECOVERY_BASELINE_RESTORE_FAILED'}
    $Result['restoredRegistrySha256']=$Binding.baselineRegistrySha256
  }
  Check 'Inspect' | Out-Null
  Consume 'proxy' $StopPaths.proxy
  $Started=Operation 'start-codex-model-stream-proxy.ps1' @{DataRoot=$Owner.dataRoot;CodexExecutablePath=$Owner.codexExecutablePath}
  if (-not $Started.running -or $Started.mode -cne 'managed' -or $Started.outer.state -cne 'running') {throw 'COLD_RECOVERY_MANAGED_START_FAILED'}
  $RestartedSnapshot=Join-Path $Work 'after-start.json'
  Snapshot $RestartedSnapshot
  $Result['runtimeHealth']=Check 'Restarted' $RestartedSnapshot $ProofPath
  $Router=Operation 'start-napcat-task-router.ps1' @{DataRoot=$Owner.dataRoot;BrokerRoot=$Owner.brokerRoot}
  if (-not $Router.started -and $Router.reason -cne 'already_running') {throw 'COLD_RECOVERY_ROUTER_START_FAILED'}
  Consume 'supervisor' $StopPaths.supervisor
  $StartedSupervisor=Operation 'start-napcat-supervisor.ps1' @{DataRoot=$Owner.dataRoot;BrokerRoot=$Owner.brokerRoot;NapCatRoot=$Owner.napCatRoot;QqExePath=$Owner.qqExePath}
  if (-not $StartedSupervisor.started -and $StartedSupervisor.reason -cne 'already_running') {throw 'COLD_RECOVERY_SUPERVISOR_START_FAILED'}
  Consume 'watchdog' $StopPaths.watchdog
  Task-Set ([bool]$Owner.originalWatchdogEnabled)
  $TaskDisabled=$false
  if (-not $Fixture -and $Owner.originalWatchdogEnabled) {Start-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'}
  $Result.servicesReady=$true
  $Result.status='CURRENT_FILES_RETAINED_SERVICES_STARTED_OPEN_SHORTCUT_MANUALLY'
} catch {$Result.status='FAILED_PRESERVED';$Result.error=$_.Exception.Message}
finally {
  foreach ($Component in @('proxy','supervisor','watchdog')) {
    if ($Leases.ContainsKey($Component)) {
      try {Consume $Component $StopPaths[$Component]} catch {$Result['markerCleanupError_'+$Component]=$_.Exception.Message;try {Close-OwnedStopMarker -Lease $Leases[$Component] | Out-Null} catch {}}
    }
  }
  if ($TaskDisabled -and $Leases.Count -eq 0) {try {Task-Set ([bool]$Owner.originalWatchdogEnabled)} catch {$Result['taskRestoreError']=$_.Exception.Message}}
  $env:CODEX_TOOLKIT_NODE_EXE=$SavedNode
  $env:CODEX_REAL_NODE_EXE=$SavedRealNode
  $env:PSModulePath=$SavedModules
  if ($Result.work) {try {Write-NewJson (Join-Path $Result.work 'result.json') $Result} catch {}}
  $Result | ConvertTo-Json -Depth 10
}
if ($Result.error) {exit 1}
