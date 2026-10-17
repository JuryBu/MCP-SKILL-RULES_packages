[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [ValidateRange(1, 65535)][int]$DownstreamPort = 18432,
  [ValidateRange(1, 65535)][int]$ControlPort = 18431,
  [ValidateRange(1, 65535)][int]$UpstreamPort = 18433,
  [ValidateRange(1, 65535)][int]$ProbePort = 18434,
  [ValidateRange(250, 300000)][int]$ResumeTimeoutMs = 120000,
  [ValidateRange(1000, 120000)][int]$StartTimeoutMs = 45000,
  [ValidateRange(30, 300)][int]$StartupTimeoutSeconds = 120,
  [switch]$RequireNoStopMarker,
  [switch]$RequestMetadataEnabled,
  [string]$ExpectedInstanceToken = "",
  [string]$LaunchReceiptPath = "",
  [string]$CodexExecutablePath = "",
  [ValidateSet('Auto', 'Plan', 'Reject')][string]$StartupRecoveryMode = 'Auto'
)

$ErrorActionPreference = "Stop"
$StartupBudgetMs = ($StartupTimeoutSeconds * 1000) - 15000
if ($StartTimeoutMs -gt $StartupBudgetMs) {
  throw "StartTimeoutMs must fit within StartupTimeoutSeconds minus the 15-second readiness margin"
}
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $NapCatMcpRoot "src\codex-app-server-proxy-runner.mjs"
$StateRoot = Join-Path $DataRoot "state"
$RuntimeStatePath = Join-Path $StateRoot "codex-app-server-proxy-runtime.json"
$LogPath = Join-Path $StateRoot "codex-app-server-proxy.jsonl"
$StopFilePath = Join-Path $StateRoot "codex-app-server-proxy.stop"
$LockPath = Join-Path $StateRoot "codex-app-server-proxy.lock"
$JournalPath = Join-Path $StateRoot "codex-app-server-wake-journal.json"
$TokenFilePath = Join-Path $StateRoot "codex-app-server-proxy-token.txt"
$MaintenanceFilePath = Join-Path $StateRoot "task-router.maintenance.json"
$AlertFilePath = Join-Path $StateRoot "automation-alert.json"
$FallbackFilePath = Join-Path $StateRoot "codex-app-server-proxy-fallback.json"

$DiagnosticRoot = Join-Path $StateRoot 'startup-diagnostics'
$AttemptId = [guid]::NewGuid().ToString()
$AttemptPath = Join-Path $DiagnosticRoot ($AttemptId + '.json')
$RunnerStdoutPath = Join-Path $DiagnosticRoot ($AttemptId + '.stdout.log')
$RunnerStderrPath = Join-Path $DiagnosticRoot ($AttemptId + '.stderr.log')
$RecoveryOutputPath = Join-Path $DiagnosticRoot ($AttemptId + '.recovery.log')
$StartupClock = [Diagnostics.Stopwatch]::StartNew()
$StartupDiagnostic = [ordered]@{ schemaVersion = 1; attemptId = $AttemptId; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); launcherPid = $PID; runnerPid = $null; stage = 'configuration'; status = 'running'; elapsedMs = 0; error = $null; stdoutPath = $RunnerStdoutPath; stderrPath = $RunnerStderrPath; recoveryOutputPath = $RecoveryOutputPath; events = @() }

function Write-StartupDiagnostic {
  param([string]$Stage, [string]$Status = 'running', [string]$Message = '')
  if ($StartupRecoveryMode -eq 'Plan') { return }
  try {
    New-Item -ItemType Directory -Force -Path $DiagnosticRoot | Out-Null
    $StartupDiagnostic.stage = $Stage
    $StartupDiagnostic.status = $Status
    $StartupDiagnostic.elapsedMs = $StartupClock.ElapsedMilliseconds
    if ($Message) { $StartupDiagnostic.error = $Message.Substring(0, [Math]::Min(4096, $Message.Length)) }
    $StartupDiagnostic.events = @($StartupDiagnostic.events | Select-Object -Last 15) + @([ordered]@{ at = [DateTimeOffset]::UtcNow.ToString('o'); stage = $Stage; status = $Status; elapsedMs = $StartupClock.ElapsedMilliseconds })
    $RecordPath = if ($Stage -eq 'existing_runtime' -and $Status -eq 'ready') { Join-Path $DiagnosticRoot 'latest-existing-runtime.json' } else { $AttemptPath }
    [IO.File]::WriteAllText($RecordPath, ($StartupDiagnostic | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    if ($RecordPath -ne $AttemptPath -and (Test-Path -LiteralPath $AttemptPath -PathType Leaf)) { [IO.File]::Delete($AttemptPath) }
  } catch {
    Write-Warning ('Startup diagnostic could not be saved: ' + $_.Exception.Message)
  }
}

function Remove-OldStartupDiagnostics {
  try {
  if ($StartupRecoveryMode -eq 'Plan' -or -not (Test-Path -LiteralPath $DiagnosticRoot)) { return }
  foreach ($Old in @(Get-ChildItem -LiteralPath $DiagnosticRoot -Filter '*.json' -File | Where-Object { $_.BaseName -cmatch '^[a-f0-9-]{36}$' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 32)) {
    if ($Old.BaseName -cnotmatch '^[a-f0-9-]{36}$' -or $Old.FullName -eq $AttemptPath) { continue }
    try {
      $Previous = Get-Content -LiteralPath $Old.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($Previous.schemaVersion -ne 1 -or $Previous.attemptId -cne $Old.BaseName) { continue }
      if ($Previous.runnerPid -and (Get-Process -Id $Previous.runnerPid -ErrorAction SilentlyContinue)) { continue }
      if ($Previous.status -eq 'running' -and (Get-Process -Id $Previous.launcherPid -ErrorAction SilentlyContinue)) { continue }
      foreach ($Suffix in @('.stdout.log', '.stderr.log', '.recovery.log', '.json')) {
        $OldPath = Join-Path $DiagnosticRoot ($Old.BaseName + $Suffix)
        if (Test-Path -LiteralPath $OldPath -PathType Leaf) { [IO.File]::Delete($OldPath) }
      }
    } catch {}
  }
  } catch { Write-Warning ('Old startup diagnostics could not be rotated: ' + $_.Exception.Message) }
}

Write-StartupDiagnostic -Stage 'configuration'
try {
. (Join-Path $PSScriptRoot "resolve-codex-outer-runtime-startup.ps1")
. (Join-Path $PSScriptRoot 'test-codex-startup-readiness.ps1')
$OuterRuntimeStartup = Resolve-CodexOuterRuntimeStartup -DataRoot $DataRoot
if (-not [string]::IsNullOrWhiteSpace($CodexExecutablePath)) {
  if ($CodexExecutablePath -notmatch '^[A-Za-z]:[\\/]' -and $CodexExecutablePath -notmatch '^\\\\[^\\/]+[\\/][^\\/]+[\\/]') {
    throw "CodexExecutablePath must be an absolute existing executable path"
  }
  $CodexExecutablePath = [System.IO.Path]::GetFullPath($CodexExecutablePath)
  if (-not (Test-Path -LiteralPath $CodexExecutablePath -PathType Leaf)) {
    throw "Missing explicit Codex executable: $CodexExecutablePath"
  }
}

if (-not (Test-Path -LiteralPath $RunnerPath)) { throw "Missing Codex App Server proxy runner: $RunnerPath" }
if ($StartupRecoveryMode -ne 'Plan') { New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null }
if (($RequireNoStopMarker -or $OuterRuntimeStartup.innerManagedProfilePath) -and (Test-Path -LiteralPath $StopFilePath)) { throw 'EXISTING_STOP_REQUIREMENT_PRESERVED' }

function Test-ExpectedProxyIdentity {
  param($RuntimeState, $ProcessInfo)
  if ($null -eq $RuntimeState -or $null -eq $ProcessInfo) { return $false }
  $CommandLine = [string]$ProcessInfo.CommandLine
  if ($CommandLine.IndexOf("codex-app-server-proxy-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($LockPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
  try {
    $LockState = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [int]$LockState.pid -eq [int]$RuntimeState.pid -and [string]$LockState.token -eq [string]$RuntimeState.instanceToken -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeState.instanceToken)
  } catch {
    return $false
  }
}

function Test-ExpectedProxyRuntime {
  param($RuntimeState, $ProcessInfo)
  if (-not (Test-ExpectedProxyIdentity -RuntimeState $RuntimeState -ProcessInfo $ProcessInfo) -or [string]$RuntimeState.state -notin @('running','waiting_for_desktop')) { return $false }
  if ($RuntimeState.state -eq 'waiting_for_desktop' -and ($RuntimeState.waitingForDesktop -ne $true -or $null -ne $RuntimeState.appServerPid)) { return $false }
  $DownstreamOwner = Get-NetTCPConnection -State Listen -LocalPort $DownstreamPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } | Select-Object -First 1 -ExpandProperty OwningProcess
  $ControlOwner = Get-NetTCPConnection -State Listen -LocalPort $ControlPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } | Select-Object -First 1 -ExpandProperty OwningProcess
  if ([int]$DownstreamOwner -ne [int]$RuntimeState.pid -or [int]$ControlOwner -ne [int]$RuntimeState.pid) { return $false }
  return Test-CodexManagedStartupReadiness -Startup $OuterRuntimeStartup -DataRoot $DataRoot -RuntimeState $RuntimeState -ControlPort $ControlPort -TokenFilePath $TokenFilePath
}

function Get-OuterRuntimeStartupStatus {
  param($RuntimeState, $ProcessInfo, [bool]$AppliedByThisStart)

  $LoadedCandidateRoot = $null
  $RootArgument = [regex]::Match([string]$ProcessInfo.CommandLine, '(?:^|\s)"?--outer-runtime-root"?\s+(?:"([^"]*)"|(\S+))')
  if ($RootArgument.Success) {
    $LoadedCandidateRoot = if ($RootArgument.Groups[1].Success) { $RootArgument.Groups[1].Value } else { $RootArgument.Groups[2].Value }
  }
  $ObservedOuterRuntime = $RuntimeState.proxy.outerRuntime
  $StatusSource = if ($null -ne $ObservedOuterRuntime) { "runtime_state" } else { "unavailable" }
  if (-not $AppliedByThisStart -and $OuterRuntimeStartup.configured) {
    try {
      $ControlToken = (Get-Content -LiteralPath $TokenFilePath -Raw -Encoding UTF8).Trim()
      $LiveStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$ControlPort/v1/status" -Headers @{ Authorization = "Bearer $ControlToken" } -TimeoutSec 3
      if ([string]$LiveStatus.outerRuntime.instanceId -eq [string]$RuntimeState.instanceToken -and $LiveStatus.closed -eq $false) {
        $ObservedOuterRuntime = $LiveStatus.outerRuntime
        $StatusSource = "control_status"
      }
    } catch {}
  }
  $RequestedCandidateRoot = if ($OuterRuntimeStartup.enabled) { $OuterRuntimeStartup.candidateRoot } else { $null }
  $ProfileArgument = [regex]::Match([string]$ProcessInfo.CommandLine, '(?:^|\s)"?--inner-managed-profile"?\s+(?:"([^"]*)"|(\S+))')
  $ProfileHashArgument = [regex]::Match([string]$ProcessInfo.CommandLine, '(?:^|\s)"?--inner-managed-profile-sha256"?\s+(?:"([^"]*)"|(\S+))')
  $LoadedProfilePath = if ($ProfileArgument.Success) { if ($ProfileArgument.Groups[1].Success) { $ProfileArgument.Groups[1].Value } else { $ProfileArgument.Groups[2].Value } } else { $null }
  $LoadedProfileHash = if ($ProfileHashArgument.Success) { if ($ProfileHashArgument.Groups[1].Success) { $ProfileHashArgument.Groups[1].Value } else { $ProfileHashArgument.Groups[2].Value } } else { $null }
  $ConfigurationMatchesRunning = $null
  if ($null -ne $ObservedOuterRuntime -and $ObservedOuterRuntime.enabled -is [bool]) {
    $ConfigurationMatchesRunning = [bool]$ObservedOuterRuntime.enabled -eq [bool]$OuterRuntimeStartup.enabled -and
      [string]::Equals([string]$LoadedCandidateRoot, [string]$RequestedCandidateRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$LoadedProfilePath, [string]$OuterRuntimeStartup.innerManagedProfilePath, [System.StringComparison]::OrdinalIgnoreCase) -and
      [string]$LoadedProfileHash -ceq [string]$OuterRuntimeStartup.innerManagedProfileSha256
  }
  return [pscustomobject]@{
    configurationPath = $OuterRuntimeStartup.configurationPath
    configured = $OuterRuntimeStartup.configured
    requestedEnabled = $OuterRuntimeStartup.enabled
    requestedCandidateRoot = $RequestedCandidateRoot
    appliedByThisStart = $AppliedByThisStart -and $OuterRuntimeStartup.configured
    loadedCandidateRoot = $LoadedCandidateRoot
    requestedInnerManagedProfilePath = $OuterRuntimeStartup.innerManagedProfilePath
    loadedInnerManagedProfilePath = $LoadedProfilePath
    loadedInnerManagedProfileSha256 = $LoadedProfileHash
    runningOuterRuntime = $ObservedOuterRuntime
    runningStatusSource = $StatusSource
    configurationMatchesRunning = $ConfigurationMatchesRunning
    restartRequired = if ($null -eq $ConfigurationMatchesRunning) { $null } else { -not $ConfigurationMatchesRunning }
  }
}

if ($StartupRecoveryMode -ne 'Plan' -and (Test-Path -LiteralPath $RuntimeStatePath)) {
  Write-StartupDiagnostic -Stage 'existing_runtime'
  $ExistingState = $null
  $ExistingProcess = $null
  try {
    $ExistingState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExistingState.pid)" -ErrorAction SilentlyContinue
  } catch {}
  if (Test-ExpectedProxyIdentity -RuntimeState $ExistingState -ProcessInfo $ExistingProcess) {
    $ExistingPid = [int]$ExistingState.pid
    $ExistingToken = [string]$ExistingState.instanceToken
    $ExistingDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while (-not (Test-ExpectedProxyRuntime -RuntimeState $ExistingState -ProcessInfo $ExistingProcess)) {
      if ([string]$ExistingState.state -notin @('starting', 'restarting', 'running', 'waiting_for_desktop')) { throw 'EXISTING_PROXY_NOT_READY_PRESERVED' }
      if ([DateTime]::UtcNow -ge $ExistingDeadline) { throw 'EXISTING_PROXY_STARTUP_TIMEOUT_PRESERVED' }
      Start-Sleep -Milliseconds 200
      $ExistingState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ExistingPid" -ErrorAction SilentlyContinue
      if ([int]$ExistingState.pid -ne $ExistingPid -or [string]$ExistingState.instanceToken -cne $ExistingToken -or
          -not (Test-ExpectedProxyIdentity -RuntimeState $ExistingState -ProcessInfo $ExistingProcess)) { throw 'EXISTING_PROXY_CHANGED_PRESERVED' }
    }
    $StartupDiagnostic.observedRunnerPid = [int]$ExistingState.pid
    Write-StartupDiagnostic -Stage 'existing_runtime' -Status 'ready'
    [pscustomobject]@{
      started = $false
      reason = "already_running"
      pid = [int]$ExistingState.pid
      state = [string]$ExistingState.state
      downstreamUrl = [string]$ExistingState.downstreamUrl
      controlUrl = [string]$ExistingState.controlUrl
      runtimeStatePath = $RuntimeStatePath
      tokenFilePath = $TokenFilePath
      fallbackRequired = [bool]$ExistingState.fallbackRequired
      runtimeState = $ExistingState
      outerRuntimeStartup = Get-OuterRuntimeStartupStatus -RuntimeState $ExistingState -ProcessInfo $ExistingProcess -AppliedByThisStart $false
    } | ConvertTo-Json -Depth 12
    return
  }
}

if (Test-Path -LiteralPath $StopFilePath) {
  if ($RequireNoStopMarker -or $OuterRuntimeStartup.innerManagedProfilePath) { throw 'EXISTING_STOP_REQUIREMENT_PRESERVED' }
  Remove-Item -LiteralPath $StopFilePath -Force
}

function Resolve-NodeExecutable {
  $ConfiguredNode = [string]$env:CODEX_TOOLKIT_NODE_EXE
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredNode) -and (Test-Path -LiteralPath $ConfiguredNode -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($ConfiguredNode)
  }
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $NodeCommand -and (Test-Path -LiteralPath $NodeCommand.Source -PathType Leaf)) {
    return [string]$NodeCommand.Source
  }
  $ManifestPath = Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
  if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    try {
      $ManagedNode = [string](Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).broker.nodeExe
      if (-not [string]::IsNullOrWhiteSpace($ManagedNode) -and (Test-Path -LiteralPath $ManagedNode -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($ManagedNode)
      }
    } catch {
    }
  }
  throw "Managed Node executable is unavailable."
}

$NodePath = Resolve-NodeExecutable

if ($OuterRuntimeStartup.innerManagedProfilePath -and ($StartupRecoveryMode -eq 'Plan' -or (Test-Path -LiteralPath $LockPath))) {
  Write-StartupDiagnostic -Stage 'recovery'
  if ($StartupRecoveryMode -eq 'Reject') { throw 'INNER_PROFILE_EXISTING_LEASE' }
  $RecoveryMode = if ($StartupRecoveryMode -eq 'Plan') { 'Plan' } else { 'Apply' }
  $RecoveryErrorPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $RecoveryOutput = @(& $NodePath (Join-Path $PSScriptRoot 'recover-inner-startup.mjs') $RecoveryMode $DataRoot $OuterRuntimeStartup.configurationPath $OuterRuntimeStartup.innerManagedProfilePath $OuterRuntimeStartup.innerManagedProfileSha256 $DownstreamPort $ControlPort $UpstreamPort $ProbePort 2>&1)
    $RecoveryExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $RecoveryErrorPreference }
  if ($StartupRecoveryMode -ne 'Plan') {
    try { [IO.File]::WriteAllText($RecoveryOutputPath, (($RecoveryOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) }
    catch { Write-Warning ('Startup recovery output could not be saved: ' + $_.Exception.Message) }
  }
  if ($RecoveryExitCode -ne 0) {
    if ($StartupRecoveryMode -eq 'Plan') { throw ('INNER_STARTUP_RECOVERY_REFUSED: ' + (($RecoveryOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)) }
    throw 'INNER_STARTUP_RECOVERY_REFUSED'
  }
  if ($StartupRecoveryMode -eq 'Plan') { $RecoveryOutput; return }
}
if ($StartupRecoveryMode -eq 'Plan') { throw 'INNER_STARTUP_RECOVERY_PROFILE_REQUIRED' }

Write-StartupDiagnostic -Stage 'ports'
function Test-LoopbackPortAvailable {
  param([int]$Port)
  $Listener = $null
  try {
    $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $Listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $Listener) {
      try { $Listener.Stop() } catch {}
    }
  }
}

if (-not (Test-LoopbackPortAvailable -Port $UpstreamPort)) {
  if ($OuterRuntimeStartup.innerManagedProfilePath) { throw 'INNER_STARTUP_BOUND_UPSTREAM_PORT_BUSY' }
  $SelectedUpstreamPort = $null
  foreach ($CandidatePort in (($UpstreamPort + 2)..([Math]::Min(65535, $UpstreamPort + 32)))) {
    if ($CandidatePort -eq $DownstreamPort -or $CandidatePort -eq $ControlPort -or $CandidatePort -eq $ProbePort) { continue }
    if (Test-LoopbackPortAvailable -Port $CandidatePort) {
      $SelectedUpstreamPort = $CandidatePort
      break
    }
  }
  if ($null -eq $SelectedUpstreamPort) {
    throw "No free loopback port is available for the managed Codex App Server."
  }
  $UpstreamPort = $SelectedUpstreamPort
}

function Quote-Argument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$Arguments = @(
  $RunnerPath,
  "--runtime-state", $RuntimeStatePath,
  "--log", $LogPath,
  "--stop-file", $StopFilePath,
  "--lock", $LockPath,
  "--journal", $JournalPath,
  "--token-file", $TokenFilePath,
  "--maintenance-file", $MaintenanceFilePath,
  "--alert-file", $AlertFilePath,
  "--fallback-file", $FallbackFilePath,
  "--downstream-port", ([string]$DownstreamPort),
  "--control-port", ([string]$ControlPort),
  "--upstream-port", ([string]$UpstreamPort),
  "--probe-port", ([string]$ProbePort),
  "--start-timeout-ms", ([string]$StartTimeoutMs),
  "--startup-budget-ms", ([string]$StartupBudgetMs),
  "--resume-timeout-ms", ([string]$ResumeTimeoutMs)
)
if ($OuterRuntimeStartup.enabled) {
  $Arguments += @("--outer-runtime-root", [string]$OuterRuntimeStartup.candidateRoot)
}
if ($OuterRuntimeStartup.innerManagedProfilePath) {
  $Arguments += @('--inner-managed-profile', [string]$OuterRuntimeStartup.innerManagedProfilePath,
    '--inner-managed-profile-sha256', [string]$OuterRuntimeStartup.innerManagedProfileSha256)
  if (-not $ExpectedInstanceToken -and -not $LaunchReceiptPath) {
    $ExpectedInstanceToken = [guid]::NewGuid().ToString()
    $ManagedLaunchRoot = Join-Path ([IO.Path]::GetTempPath()) ('napcat-inner-managed-launch-' + $ExpectedInstanceToken)
    if (Test-Path -LiteralPath $ManagedLaunchRoot) { throw 'INNER_STARTUP_LAUNCH_ROOT_EXISTS' }
    New-Item -ItemType Directory -Path $ManagedLaunchRoot -ErrorAction Stop | Out-Null
    Assert-CodexStartupPathWithoutReparsePoint -Path $ManagedLaunchRoot
    $LaunchReceiptPath = Join-Path $ManagedLaunchRoot 'launch.json'
  }
}
if ($RequestMetadataEnabled) {
  $Arguments += @("--request-metadata-enabled", "true")
}
if (-not [string]::IsNullOrWhiteSpace($CodexExecutablePath)) {
  $Arguments += @("--codex-exe", $CodexExecutablePath)
}
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
if ($ExpectedInstanceToken -or $LaunchReceiptPath) {
  if ($ExpectedInstanceToken -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $LaunchReceiptPath -notmatch '^[A-Za-z]:[\\/]' -or $LaunchReceiptPath.Substring(2).Contains(':')) { throw 'START_LAUNCH_BINDING_REQUIRED' }
  $LaunchReceiptPath = [IO.Path]::GetFullPath($LaunchReceiptPath)
  if (-not $LaunchReceiptPath.StartsWith([IO.Path]::GetTempPath().TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath (Split-Path -Parent $LaunchReceiptPath) -PathType Container) -or (Test-Path -LiteralPath $LaunchReceiptPath)) { throw 'START_NEW_TEMP_LAUNCH_RECEIPT_REQUIRED' }
  if (Test-Path -LiteralPath ($LaunchReceiptPath + '.ready')) { throw 'START_NEW_TEMP_LAUNCH_READY_REQUIRED' }
  $Arguments += @('--instance-token', $ExpectedInstanceToken, '--launch-receipt', $LaunchReceiptPath)
  $ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
}
if ($RequireNoStopMarker -and (Test-Path -LiteralPath $StopFilePath)) { throw 'EXISTING_STOP_REQUIREMENT_PRESERVED' }
Write-StartupDiagnostic -Stage 'runner_launch'
$RedirectOutput = @{}
try {
  [IO.File]::WriteAllText($RunnerStdoutPath, '', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($RunnerStderrPath, '', [Text.UTF8Encoding]::new($false))
  $RedirectOutput = @{ RedirectStandardOutput = $RunnerStdoutPath; RedirectStandardError = $RunnerStderrPath }
} catch { Write-Warning ('Startup process output could not be captured: ' + $_.Exception.Message) }
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru @RedirectOutput
$PinnedHandle = $Process.Handle
$StartupDiagnostic.runnerPid = $Process.Id
Write-StartupDiagnostic -Stage 'runner_wait'
if ($LaunchReceiptPath) {
  $Launch = [ordered]@{ schemaVersion = 1; instanceToken = $ExpectedInstanceToken; pid = $Process.Id; createdAt = $Process.StartTime.ToUniversalTime().ToString('o'); nodePath = $NodePath; nodeSha256 = (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash.ToLowerInvariant(); runnerPath = $RunnerPath; runnerSha256 = (Get-FileHash -LiteralPath $RunnerPath -Algorithm SHA256).Hash.ToLowerInvariant(); entrySha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant(); runtimeStatePath = $RuntimeStatePath; commandLine = $ArgumentLine; ports = @($DownstreamPort, $ControlPort, $UpstreamPort, $ProbePort); recordedAt = [DateTimeOffset]::UtcNow.ToString('o') }
  $ReceiptStream = [IO.File]::Open($LaunchReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $ReceiptBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Launch | ConvertTo-Json -Depth 8 -Compress)); $ReceiptStream.Write($ReceiptBytes, 0, $ReceiptBytes.Length); $ReceiptStream.Flush($true) } finally { $ReceiptStream.Dispose() }
  $Ready = [ordered]@{ instanceToken = $ExpectedInstanceToken; receiptSha256 = (Get-FileHash -LiteralPath $LaunchReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  $ReadyStream = [IO.File]::Open(($LaunchReceiptPath + '.ready'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $ReadyBytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Ready | ConvertTo-Json -Compress)); $ReadyStream.Write($ReadyBytes, 0, $ReadyBytes.Length); $ReadyStream.Flush($true) } finally { $ReadyStream.Dispose() }
}

$RuntimeState = $null
$Deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
do {
  Start-Sleep -Milliseconds 200
  if ($Process.HasExited -and $null -eq $RuntimeState) { throw "Codex App Server proxy exited immediately, exitCode=$($Process.ExitCode)" }
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    $CandidateState = $null
    try {
      $CandidateState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $RuntimeState = $null
    }
    if ($null -ne $CandidateState) {
      if ($null -eq $CandidateState.pid -or [int]$CandidateState.pid -ne [int]$Process.Id) {
        $RuntimeState = $null
        continue
      }
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$CandidateState.pid)" -ErrorAction SilentlyContinue
      if (Test-ExpectedProxyRuntime -RuntimeState $CandidateState -ProcessInfo $RuntimeProcess) { $RuntimeState = $CandidateState; break }
      if ([string]$CandidateState.state -eq "degraded") {
        $FailureMessage = if ($CandidateState.lastError.message) { [string]$CandidateState.lastError.message } else { "unknown proxy failure" }
        throw "Codex App Server proxy entered degraded mode: $FailureMessage"
      }
      $RuntimeState = $null
    }
  }
} while ([DateTime]::UtcNow -lt $Deadline)

if ($null -eq $RuntimeState) { throw "Codex App Server proxy did not become ready within $StartupTimeoutSeconds seconds; runtime: $RuntimeStatePath" }
Write-StartupDiagnostic -Stage 'ready' -Status 'ready'
Remove-OldStartupDiagnostics
[pscustomobject]@{
  started = $true
  pid = [int]$RuntimeState.pid
  state = [string]$RuntimeState.state
  downstreamUrl = [string]$RuntimeState.downstreamUrl
  controlUrl = [string]$RuntimeState.controlUrl
  runtimeStatePath = $RuntimeStatePath
  tokenFilePath = $TokenFilePath
  fallbackRequired = [bool]$RuntimeState.fallbackRequired
  outerRuntimeStartup = Get-OuterRuntimeStartupStatus -RuntimeState $RuntimeState -ProcessInfo $RuntimeProcess -AppliedByThisStart $true
} | ConvertTo-Json -Depth 12
} catch {
  Write-StartupDiagnostic -Stage $StartupDiagnostic.stage -Status 'failed' -Message $_.Exception.Message
  Remove-OldStartupDiagnostics
  throw
}
