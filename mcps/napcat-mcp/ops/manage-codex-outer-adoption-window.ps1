[CmdletBinding()]
param(
  [ValidateSet('Inspect', 'Prepare', 'VerifyOnly', 'ObserveDesktopExit', 'TempApply', 'TempRestore', 'ExecuteWindow', 'RecoverWindow')][string]$Action = 'Inspect',
  [string]$PreparationRoot = '',
  [string]$PreparationSha256 = '',
  [string]$OwnerId = '',
  [string]$SampleRoot = '',
  [string]$PlanRoot = '',
  [string]$PlanPath = '',
  [string]$PlanSha256 = '',
  [string]$StartupParametersPath = '',
  [string]$PowerShellPath = '',
  [string]$NodePath = '',
  [string]$WindowPath = '',
  [string]$WindowSha256 = '',
  [ValidateSet('LegacyHotProof', 'OwnerColdFirstAdoption')][string]$ExecutionProfile = 'LegacyHotProof',
  [string]$DesktopExecutablePath = '',
  [ValidateRange(5, 300)][int]$DesktopExitTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$Utf8 = New-Object Text.UTF8Encoding($false)
$Journal = $null
$Attempt = $null
$InitialFailure = $null
$StopLease = $null
$StopBoundary = $null
$DesktopExit = $null
$ExitCode = 0
$Result = [ordered]@{ action = $Action; status = 'refused'; productionModified = $false; productionReady = $false; productionTransactionPrepared = $false; error = $null }
$Names = @(
  'ops/codex-outer-runtime.mjs', 'ops/start-codex-app-server-proxy.ps1', 'ops/resolve-napcat-data-root.ps1', 'ops/resolve-codex-outer-runtime-startup.ps1',
  'src/atomic-file.mjs', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs', 'src/codex-request-metadata.mjs', 'src/codex-display-policy.mjs', 'src/codex-runtime-bundle.mjs',
  'src/observability-utils.mjs', 'src/outer-engine.mjs', 'src/outer-runtime-contract.mjs', 'src/outer-runtime-host.mjs', 'src/outer-runtime-selection.mjs',
  'src/outer-runtime.mjs', 'src/reasoning-placeholder.mjs', 'src/turn-observability.mjs', 'src/wake-visibility.mjs'
)

function Get-PlainPath([string]$Value, [switch]$TempOnly) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':')) { throw 'OUTER_ABSOLUTE_PLAIN_PATH_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
  if ($TempOnly -and -not $Full.StartsWith([IO.Path]::GetTempPath().TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTER_TEMP_MAPPING_REQUIRED' }
  $Current = $Full
  while ($Current) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      $OriginalPowerShellHardLink = -not $TempOnly -and $Current -ieq $Full -and $Full -ieq (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -and $Item.LinkType -eq 'HardLink'
      $ReadOnlyBundleManifestHardLink = $false
      if (-not $TempOnly -and $Plan -and $Plan.codex -and $Current -ieq $Full -and $Item.LinkType -eq 'HardLink') {
        $BundleRoot = Split-Path -Parent $Plan.codex.path
        $ReadOnlyBundleManifestHardLink = $Full -ieq (Join-Path $BundleRoot '.codex-runtime-manifest.json') -and (Split-Path -Leaf $BundleRoot) -cmatch '^[a-f0-9]{64}$' -and (Split-Path -Parent $BundleRoot) -ieq (Join-Path $Plan.dataRoot 'state/codex-runtime-bundles')
      }
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($Item.LinkType -and -not $OriginalPowerShellHardLink -and -not $ReadOnlyBundleManifestHardLink)) { throw 'OUTER_LINK_REJECTED' }
    }
    $Current = Split-Path -Parent $Current
  }
  return $Full
}

function Get-Sha([string]$Value) {
  return (Get-FileHash -LiteralPath (Get-PlainPath $Value) -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Json([string]$Value) {
  $Full = Get-PlainPath $Value
  if ((Get-Item -LiteralPath $Full).Length -gt 1048576) { throw 'OUTER_INPUT_TOO_LARGE' }
  return Get-Content -LiteralPath $Full -Encoding UTF8 -Raw | ConvertFrom-Json
}

function Write-NewJson([string]$Value, $Object) {
  $Full = Get-PlainPath $Value -TempOnly
  $Stream = [IO.File]::Open($Full, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $Bytes = $Utf8.GetBytes(($Object | ConvertTo-Json -Depth 16)); $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) }
  finally { $Stream.Dispose() }
}

function Publish-ReadyJson([string]$Value, $Object) {
  $Temporary = $Value + '.' + [Guid]::NewGuid().ToString('N') + '.pending'
  Write-NewJson $Temporary $Object
  [IO.File]::Move($Temporary, $Value)
}

function Save-Attempt {
  $Bytes = $Utf8.GetBytes(($Attempt | ConvertTo-Json -Depth 16))
  $Journal.Position = 0
  $Journal.Write($Bytes, 0, $Bytes.Length)
  $Journal.SetLength($Bytes.Length)
  $Journal.Flush($true)
}

function Read-Preparation([string]$Root, [string]$Sha, [string]$Owner) {
  $Root = Get-PlainPath $Root
  if ($Sha -cnotmatch '^[a-f0-9]{64}$' -or $Owner -notmatch '^[A-Za-z0-9_.:-]{1,128}$' -or (Get-Sha (Join-Path $Root 'preparation.json')) -cne $Sha) { throw 'OUTER_PREPARATION_IDENTITY_MISMATCH' }
  $Manifest = Read-Json (Join-Path $Root 'preparation.json')
  if ($Manifest.schemaVersion -ne 1 -or $Manifest.mode -cne 'PREPARE_ONLY' -or $Manifest.ownerId -cne $Owner -or $Manifest.readyForProduction -ne $false -or $Manifest.productionChanged -ne $false) { throw 'OUTER_PREPARE_ONLY_REQUIRED' }
  if (@($Manifest.files).Count -ne 19 -or (($Manifest.files.name | Sort-Object) -join '|') -cne (($Names | Sort-Object) -join '|')) { throw 'OUTER_FIXED_19_PLUS_1_REQUIRED' }
  $Installed = Get-PlainPath $Manifest.installedRoot
  $Data = Get-PlainPath $Manifest.dataRoot
  if ($Manifest.startup.target -ine (Join-Path $Data 'state/codex-outer-runtime-startup.json') -or $Manifest.startup.candidate.candidateRoot -ine (Join-Path $Data 'state/codex-outer-runtime-candidates')) { throw 'OUTER_STARTUP_CONTRACT_MISMATCH' }
  foreach ($Entry in @($Manifest.files) + @($Manifest.dependency.files)) {
    $Name = $Entry.name.Replace('\', '/')
    if ($Name.Contains('..') -or $Name.StartsWith('/') -or $Name.Contains(':')) { throw 'OUTER_PACKAGE_PATH_REJECTED' }
    foreach ($Side in @('candidate', 'original')) {
      if ($Entry.$Side.exists -and (Get-Sha (Join-Path $Root ($Side + '/' + $Name))) -cne $Entry.$Side.sha256) { throw 'OUTER_PACKAGE_CHANGED' }
    }
  }
  if ((Get-Sha (Join-Path $Root 'candidate-startup.json')) -cne $Manifest.startup.sha256) { throw 'OUTER_STARTUP_PACKAGE_CHANGED' }
  if ($Manifest.startup.original.exists -and (Get-Sha (Join-Path $Root 'original-startup.json')) -cne $Manifest.startup.original.sha256) { throw 'OUTER_ORIGINAL_STARTUP_CHANGED' }
  return $Manifest
}

function Assert-Stopped {
  $RuntimePath = Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json'
  if (Test-Path -LiteralPath $RuntimePath) {
    $Runtime = Read-Json $RuntimePath
    $BoundMetadata = $StopBoundary -and $StopBoundary.instanceToken -ceq $Runtime.instanceToken -and $StopBoundary.metadataState -ceq $Runtime.state -and [int]$StopBoundary.proxy.pid -eq [int]$Runtime.pid -and $StopBoundary.marker.PathState -ceq 'Missing' -and $StopBoundary.marker.DispositionApplied -eq $true -and $StopBoundary.marker.State -ceq 'Consumed' -and $StopBoundary.marker.LeaseReleased -eq $true
    $LaunchTerminal = $false
    if ($Attempt -and $Attempt.PSObject.Properties['candidateLaunch'] -and $Attempt.candidateLaunch -and $Runtime.instanceToken -ceq $Attempt.candidateLaunch.instanceToken -and (Test-Path -LiteralPath $Attempt.candidateLaunch.receiptPath)) {
      $Launch = Read-Json $Attempt.candidateLaunch.receiptPath
      $LaunchTerminal = $Launch.instanceToken -ceq $Runtime.instanceToken -and [int]$Launch.pid -eq [int]$Runtime.pid -and $Runtime.startupTerminalClean -eq $true -and -not $Runtime.appServerPid -and -not (Test-Path -LiteralPath (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy.lock')) -and -not (Test-Path -LiteralPath (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy.stop'))
      foreach ($ProcessId in @($Runtime.startupChildPids)) { if (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue) { $LaunchTerminal = $false } }
    }
    if (($Runtime.state -cne 'stopped' -and -not ($Runtime.state -ceq 'stopping' -and $BoundMetadata) -and -not ($Runtime.state -ceq 'degraded' -and $LaunchTerminal)) -or ($Runtime.pid -and (Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue))) { throw 'OUTER_RUNTIME_NOT_PROVEN_STOPPED' }
    if ($Runtime.appServerPid -and (Get-Process -Id ([int]$Runtime.appServerPid) -ErrorAction SilentlyContinue)) { throw 'OUTER_CHILD_NOT_PROVEN_STOPPED' }
  }
}

function Wait-CandidateStartupTermination {
  if (-not $Attempt -or -not $Attempt.candidateLaunch) { return }
  $RuntimePath = Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json'
  if (-not (Test-Path -LiteralPath $RuntimePath)) { return }
  $Runtime = Read-Json $RuntimePath
  if ($Runtime.instanceToken -cne $Attempt.candidateLaunch.instanceToken) {
    $PublicationDeadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    do {
      $Launchers = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction Stop)
      if (@($Launchers | Where-Object { -not $_.ExecutablePath -or ($_.ExecutablePath -ieq $Plan.powerShell.path -and -not $_.CommandLine) }).Count) { throw 'OUTER_START_LAUNCHER_QUERY_INCOMPLETE' }
      $ActiveLaunchers = @($Launchers | Where-Object { $_.CommandLine -and $_.CommandLine.Contains([string]$Attempt.candidateLaunch.instanceToken) })
      foreach ($Launcher in $ActiveLaunchers) {
        if ($Launcher.ExecutablePath -ine $Plan.powerShell.path -or -not $Launcher.CommandLine.Contains((Join-Path $Plan.installedRoot 'ops/start-codex-app-server-proxy.ps1')) -or -not $Launcher.CommandLine.Contains([string]$Attempt.candidateLaunch.receiptPath)) { throw 'OUTER_START_LAUNCHER_IDENTITY_UNKNOWN' }
      }
      if ($ActiveLaunchers.Count) { Start-Sleep -Milliseconds 100; continue }
      $Nodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
      if (@($Nodes | Where-Object { -not $_.ExecutablePath -or ($_.ExecutablePath -ieq $Plan.node.path -and -not $_.CommandLine) }).Count) { throw 'OUTER_UNPUBLISHED_START_QUERY_INCOMPLETE' }
      $Waiting = @($Nodes | Where-Object { $_.CommandLine -and $_.CommandLine.Contains([string]$Attempt.candidateLaunch.instanceToken) })
      foreach ($Process in $Waiting) {
        if ($Process.ExecutablePath -ine $Plan.node.path -or -not $Process.CommandLine.Contains((Join-Path $Plan.installedRoot 'src/codex-app-server-proxy-runner.mjs')) -or -not $Process.CommandLine.Contains([string]$Attempt.candidateLaunch.receiptPath)) { throw 'OUTER_UNPUBLISHED_START_IDENTITY_UNKNOWN' }
      }
      if (-not $Waiting.Count) { return }
      Start-Sleep -Milliseconds 100
    } while ([DateTimeOffset]::UtcNow -lt $PublicationDeadline)
    throw 'OUTER_UNPUBLISHED_START_TERMINATION_UNKNOWN'
  }
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
  do {
    $Runtime = Read-Json $RuntimePath
    if ($Runtime.instanceToken -cne $Attempt.candidateLaunch.instanceToken) { throw 'OUTER_FAILED_START_INSTANCE_CHANGED' }
    if ($Runtime.startupTerminalClean -eq $true -and -not (Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTimeOffset]::UtcNow -lt $Deadline)
  throw 'OUTER_FAILED_START_TERMINATION_UNKNOWN'
}

function Assert-IndependentTerminalOrigin([int]$InitialProcessId) {
  $ProcessId = $InitialProcessId
  $Seen = New-Object 'Collections.Generic.HashSet[int]'
  $ChildCreated = $null
  $SessionId = $null
  $ExplorerPath = [IO.Path]::Combine([Environment]::GetFolderPath('Windows'), 'explorer.exe')
  for ($Depth = 0; $Depth -lt 32 -and $ProcessId; $Depth++) {
    if (-not $Seen.Add($ProcessId)) { throw 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Matches = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
    if ($Matches.Count -ne 1) { throw 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Process = $Matches[0]
    if ([int]$Process.ProcessId -ne $ProcessId -or -not $Process.ExecutablePath -or -not $Process.CommandLine -or -not $Process.CreationDate -or $null -eq $Process.SessionId -or [string]$Process.CommandLine -match 'app-server|mcp-http-broker|sandbox-data|codex-command-runner|codex-windows-sandbox|WindowsJobRunner' -or [string]$Process.Name -match '^(ChatGPT|codex|codex-command-runner|codex-windows-sandbox-setup|WindowsJobRunner)\.exe$') { throw 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Created = ([DateTime]$Process.CreationDate).ToUniversalTime()
    if ($ChildCreated -and $Created -gt $ChildCreated) { throw 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ($null -eq $SessionId) { $SessionId = [int]$Process.SessionId }
    if ([int]$Process.SessionId -ne $SessionId) { throw 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ([string]$Process.Name -ieq 'explorer.exe' -and [string]$Process.ExecutablePath -ieq $ExplorerPath) {
      return [pscustomobject]@{ shellPid = $InitialProcessId; explorerPid = $ProcessId; sessionId = $SessionId; explorerCreatedUtc = $Created.ToString('o'); verifiedDepth = $Depth }
    }
    $ChildCreated = $Created
    $ProcessId = [int]$Process.ParentProcessId
  }
  throw 'OUTER_INDEPENDENT_OWNER_TERMINAL_REQUIRED'
}

function Assert-IndependentTerminal {
  [void](Assert-IndependentTerminalOrigin $PID)
}

function Process-Identity([int]$ProcessId) {
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  if (-not $Process -or -not $Process.CommandLine -or -not $Process.ExecutablePath -or -not $Process.CreationDate) { throw 'OUTER_PROCESS_IDENTITY_UNKNOWN' }
  return [pscustomobject]@{ pid = $ProcessId; parentPid = [int]$Process.ParentProcessId; executablePath = $Process.ExecutablePath; commandLine = $Process.CommandLine; createdAt = $Process.CreationDate.ToUniversalTime().ToString('o') }
}

function Live-Binding($Runtime, [string]$Installed, [string]$Data, $Node, $Startup) {
  if ($Runtime.state -cne 'running' -or -not $Runtime.instanceToken -or -not $Runtime.appServerPid) { throw 'OUTER_RUNNING_INSTANCE_REQUIRED' }
  $Proxy = Process-Identity ([int]$Runtime.pid); $Child = Process-Identity ([int]$Runtime.appServerPid)
  $Runner = Join-Path $Installed 'src/codex-app-server-proxy-runner.mjs'; $StatePath = Join-Path $Data 'state/codex-app-server-proxy-runtime.json'
  if ($Proxy.executablePath -ine $Node.path -or $Proxy.commandLine.IndexOf($Runner, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $Proxy.commandLine.IndexOf($StatePath, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $Child.parentPid -ne $Proxy.pid -or $Child.executablePath -ine $Runtime.executablePath -or $Child.commandLine -notmatch 'app-server' -or $Runtime.executablePath -ine $Startup.CodexExecutablePath -or $Runtime.controlUrl -cne ('http://127.0.0.1:' + $Startup.ControlPort) -or $Runtime.upstreamUrl -cne ('ws://127.0.0.1:' + $Startup.UpstreamPort)) { throw 'OUTER_FIXED_PROCESS_BINDING_MISMATCH' }
  $Lock = Read-Json (Join-Path $Data 'state/codex-app-server-proxy.lock')
  if ($Lock.token -cne $Runtime.instanceToken -or [int]$Lock.pid -ne $Proxy.pid) { throw 'OUTER_INSTANCE_LOCK_MISMATCH' }
  return [pscustomobject]@{ instanceToken = $Runtime.instanceToken; proxy = $Proxy; child = $Child }
}

function Assert-Live($Expected, [switch]$ReadOnly) {
  $Runtime = Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')
  $Observed = Live-Binding $Runtime $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup
  if (($Expected | ConvertTo-Json -Depth 8 -Compress) -cne ($Observed | ConvertTo-Json -Depth 8 -Compress)) { throw 'OUTER_STOP_INSTANCE_DRIFT' }
  $AllListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
  foreach ($Port in @($Plan.startup.DownstreamPort, $Plan.startup.ControlPort, $Plan.startup.UpstreamPort, $Plan.startup.ProbePort)) {
    $Listeners = @($AllListeners | Where-Object { [int]$_.LocalPort -eq [int]$Port })
    if ($Port -eq $Plan.startup.ProbePort) {
      if ($Listeners.Count) { throw 'OUTER_PROBE_PORT_NOT_RELEASED' }
    } elseif (@($Listeners | Where-Object { $_.OwningProcess -notin @($Expected.proxy.pid, $Expected.child.pid) -or $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count) {
      $ListenerError = New-Object InvalidOperationException('OUTER_LISTENER_FOREIGN_OWNER')
      $ListenerError.Data['listeners'] = @($Listeners)
      throw $ListenerError
    }
    elseif (-not $Listeners.Count) { throw ('OUTER_LISTENER_OWNER_UNKNOWN: ' + $Port) }
  }
  $Token = [IO.File]::ReadAllText((Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-token.txt')).Trim()
  if (-not $Token) { throw 'OUTER_CONTROL_TOKEN_REQUIRED' }
  $Status = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Plan.startup.ControlPort + '/v1/status') -Headers @{ Authorization = 'Bearer ' + $Token } -TimeoutSec 5
  if ($Status.ok -ne $true -or $Status.closed -ne $false -or $null -eq $Status.clientCount) { throw 'OUTER_PENDING_OR_UNKNOWN_ACTIVITY' }
  if (-not $ReadOnly) {
  if ($null -eq $Status.outerRuntime) {
    if (-not $Plan.sampleRoot) {
      if ($Plan.executionProfile -cne 'OwnerColdFirstAdoption' -or -not $DesktopExit -or $Window.acceptsShortInterruption -ne $true -or $Window.acceptsLegacyRequestCounterLimit -ne $true -or $Status.clientCount -ne 0 -or $null -eq $Status.clients -or @($Status.clients).Count -ne 0) { throw 'OUTER_LEGACY_ACTIVITY_COUNTERS_UNAVAILABLE' }
    } elseif ($null -eq $Status.clients -or $Status.clientCount -ne @($Status.clients).Count) { throw 'OUTER_LEGACY_ACTIVITY_COUNTERS_UNAVAILABLE' }
    if ($Plan.sampleRoot -and $Status.clientCount -gt 0) {
      if (-not $Plan.legacyRehearsal -or (Get-Sha $Plan.legacyRehearsal.path) -cne $Plan.legacyRehearsal.sha256 -or $Status.clientCount -ne 1 -or $Status.clients[0].connectedAt -cne $Plan.legacyRehearsal.connectedAt -or ($Plan.legacyRehearsal.actor | ConvertTo-Json -Compress) -cne ((Process-Identity ([int]$Plan.legacyRehearsal.actor.pid)) | ConvertTo-Json -Compress)) { throw 'OUTER_LEGACY_READONLY_REHEARSAL_ACTOR_UNKNOWN' }
    }
    foreach ($Client in $Status.clients) {
      foreach ($Field in @('pendingInjectionCount', 'queuedMessageCount', 'queuedBytes', 'downstreamBufferedBytes', 'upstreamBufferedBytes')) { if ($null -eq $Client.$Field -or $Client.$Field -ne 0) { throw 'OUTER_PENDING_OR_UNKNOWN_ACTIVITY' } }
    }
  } elseif ($Status.clientCount -ne 0 -or $null -eq $Status.outerRuntime.activeOperationCount -or $Status.outerRuntime.activeOperationCount -ne 0 -or $null -eq $Status.outerRuntime.trackedRequestCount -or $Status.outerRuntime.trackedRequestCount -ne 0 -or $null -eq $Status.outerRuntime.pendingToolCount -or $Status.outerRuntime.pendingToolCount -ne 0 -or $Status.outerRuntime.busy -eq $true) { throw 'OUTER_PENDING_OR_UNKNOWN_ACTIVITY' }
  }
  foreach ($File in $Plan.runtimeBundle.files) { if ((Get-Sha $File.path) -cne $File.sha256 -or [int](Get-Item -LiteralPath $File.path -Force).Attributes -ne $File.attributes -or (Get-Acl -LiteralPath $File.path).Sddl -cne $File.sddl) { throw 'OUTER_RUNTIME_BUNDLE_DRIFT' } }
}

function Resolve-OwnerColdStopIdentity($Expected, [string]$Name) {
  if ($Name -cne 'original-stop' -or $Plan.sampleRoot -or $Plan.executionProfile -cne 'OwnerColdFirstAdoption' -or -not $DesktopExit -or $Window.acceptsOwnedDesktopEmptyRestart -ne $true) { Assert-Live $Expected; return $Expected }
  $Baseline = $Plan.stopIdentity
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
  do {
    $Runtime = Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')
    $Proxy = Process-Identity ([int]$Runtime.pid)
    if ($Runtime.instanceToken -cne $Baseline.instanceToken -or ($Proxy | ConvertTo-Json -Depth 8 -Compress) -cne ($Baseline.proxy | ConvertTo-Json -Depth 8 -Compress)) { throw 'OUTER_COLD_PROXY_IDENTITY_CHANGED' }
    try {
      $Observed = Live-Binding $Runtime $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup
      if (($Observed.child | ConvertTo-Json -Depth 8 -Compress) -cne ($Baseline.child | ConvertTo-Json -Depth 8 -Compress)) {
        if ([int]$Observed.child.pid -eq [int]$Baseline.child.pid -or @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Baseline.child.pid) -ErrorAction Stop).Count) { throw 'OUTER_COLD_ORIGINAL_CHILD_STILL_PRESENT' }
        if ($Observed.child.parentPid -ne $Baseline.proxy.pid -or $Observed.child.executablePath -ine $Baseline.child.executablePath -or $Observed.child.commandLine -cne $Baseline.child.commandLine -or $Observed.child.createdAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or $DesktopExit.observedAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or [DateTimeOffset]::Parse($Observed.child.createdAt) -lt [DateTimeOffset]::Parse($DesktopExit.observedAt)) { throw 'OUTER_COLD_REPLACEMENT_CHILD_UNPROVEN' }
      }
      Assert-Live $Observed
      $Verified = Live-Binding (Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')) $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup
      if (($Verified | ConvertTo-Json -Depth 8 -Compress) -cne ($Observed | ConvertTo-Json -Depth 8 -Compress)) { throw 'OUTER_STOP_INSTANCE_DRIFT' }
      if (($Observed.child | ConvertTo-Json -Depth 8 -Compress) -cne ($Baseline.child | ConvertTo-Json -Depth 8 -Compress)) { $script:ColdStopBinding = [ordered]@{ original = $Baseline; observed = $Observed; desktopExitSha256 = $Window.desktopExitSha256; parentAttemptId = $Plan.attemptId; planSha256 = $PlanSha256; observedAt = [DateTimeOffset]::UtcNow.ToString('o') } }
      return $Observed
    } catch {
      if ($_.Exception.Message -ceq 'OUTER_LISTENER_FOREIGN_OWNER') {
        $OriginalError = $_
        $RestartListeners = @($OriginalError.Exception.Data['listeners'])
        foreach ($Listener in $RestartListeners) {
          if ($Listener.LocalAddress -notin @('127.0.0.1', '::1')) { throw $OriginalError }
          if ([int]$Listener.OwningProcess -eq [int]$Baseline.proxy.pid) { continue }
          try { $RestartChild = Process-Identity ([int]$Listener.OwningProcess) } catch { throw $OriginalError }
          if ($RestartChild.parentPid -ne $Baseline.proxy.pid -or $RestartChild.executablePath -ine $Baseline.child.executablePath -or $RestartChild.commandLine -cne $Baseline.child.commandLine -or [DateTimeOffset]::Parse($RestartChild.createdAt) -lt [DateTimeOffset]::Parse($DesktopExit.observedAt) -or @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Baseline.child.pid) -ErrorAction Stop).Count) { throw $OriginalError }
        }
        if (-not $RestartListeners.Count -or [DateTimeOffset]::UtcNow -ge $Deadline) { throw $OriginalError }
      } elseif ($_.Exception.Message -notmatch '^OUTER_(LISTENER_OWNER_UNKNOWN|STOP_INSTANCE_DRIFT|PROCESS_IDENTITY_UNKNOWN|RUNNING_INSTANCE_REQUIRED)(:|$)' -or [DateTimeOffset]::UtcNow -ge $Deadline) { throw }
      Start-Sleep -Milliseconds 100
    }
  } while ([DateTimeOffset]::UtcNow -lt $Deadline)
  throw 'OUTER_COLD_RESTART_NOT_STABLE'
}

function Stop-BoundEntry($Identity, [string]$Name) {
  $Identity = Resolve-OwnerColdStopIdentity $Identity $Name
  if ($Name -ceq 'original-stop' -and $ColdStopBinding) { $Attempt.coldStopBinding = $ColdStopBinding; Save-Attempt }
  foreach ($File in $Plan.stopFiles) { if ((Get-Sha $File.path) -cne $File.sha256) { throw 'OUTER_FROZEN_STOP_CHANGED' } }
  . (Join-Path (Split-Path -Parent $PlanPath) 'stop-recovery/ops/owned-stop-marker.ps1')
  $StopPath = Join-Path $Plan.dataRoot 'state/codex-app-server-proxy.stop'
  if (Test-Path -LiteralPath $StopPath) { throw 'OUTER_FOREIGN_STOP_MARKER_PRESERVED' }
  $script:StopLease = New-OwnedStopMarker -Path $StopPath -Component 'proxy' -AttemptId $Plan.attemptId -LifetimeSeconds 1800
  $Proof = Export-OwnedStopMarkerProof -Lease $StopLease -Path $StopPath -Component 'proxy' -AttemptId $Plan.attemptId
  $ProofPath = Join-Path (Split-Path -Parent $PlanPath) ('stop-proof-' + $StopLease.OperationId + '.json')
  Write-NewJson $ProofPath ($Proof | ConvertFrom-Json)
  $Stopped = Invoke-Step $Name $Plan.powerShell.path @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', (Join-Path (Split-Path -Parent $PlanPath) 'stop-recovery/ops/stop-codex-app-server-proxy.ps1'), '-DataRoot', $Plan.dataRoot, '-TimeoutSeconds', '20', '-ChildTimeoutSeconds', '30', '-StopMarkerProofPath', $ProofPath, '-StopMarkerAttemptId', $Plan.attemptId, '-StopMarkerOperationId', $StopLease.OperationId)
  $Runtime = Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')
  if ($Stopped.stopped -ne $true -or $Stopped.clean -ne $true -or [int]$Stopped.pid -ne [int]$Identity.proxy.pid -or $Runtime.instanceToken -cne $Identity.instanceToken -or [int]$Runtime.pid -ne [int]$Identity.proxy.pid -or $Runtime.state -notin @('stopped', 'stopping')) { throw 'OUTER_STOP_TERMINAL_EVIDENCE_UNKNOWN' }
  foreach ($ProcessId in @($Identity.proxy.pid, $Identity.child.pid)) { if (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue) { throw 'OUTER_BOUND_STOP_PROCESS_STILL_ALIVE' } }
  $Marker = Consume-OwnedStopMarker -Lease $StopLease -Path $StopPath -Component 'proxy' -AttemptId $Plan.attemptId
  $script:StopLease = $null
  $Attempt.stopMarkerConsumption = $Marker; Save-Attempt
  if ($Marker.PathState -cne 'Missing' -or $Marker.State -cne 'Consumed' -or $Marker.DispositionApplied -ne $true -or $Marker.LeaseReleased -ne $true -or (Test-Path -LiteralPath $StopPath)) { throw 'OUTER_STOP_MARKER_TERMINAL_UNKNOWN' }
  $script:StopBoundary = [ordered]@{ schemaVersion = 1; scope = $Plan.scope; ownerId = $Plan.ownerId; parentAttemptId = $Plan.attemptId; parentSha256 = $Plan.inputs[0].sha256; contractSha256 = $Plan.transaction.contractSha256; instanceToken = $Identity.instanceToken; metadataState = $Runtime.state; proxy = $Identity.proxy; child = $Identity.child; normalStop = $Stopped; marker = $Marker; desktopExitSha256 = $(if ($DesktopExit) { $Window.desktopExitSha256 } else { $null }); coldStopBinding = $(if ($Name -ceq 'original-stop') { $ColdStopBinding } else { $null }) }
  if ($StopBoundary.coldStopBinding) { if (Get-Process -Id ([int]$Plan.stopIdentity.child.pid) -ErrorAction SilentlyContinue) { throw 'OUTER_COLD_ORIGINAL_CHILD_STILL_PRESENT' }; $StopBoundary.originalChildEnded = $true }
  $EvidencePath = Join-Path $Plan.transaction.contractRoot ('stop-boundary-' + $Marker.OperationId + '.json')
  Write-NewJson $EvidencePath $StopBoundary
  $Attempt.stopEvidence = [pscustomobject]@{ path = $EvidencePath; sha256 = (Get-Sha $EvidencePath); instanceToken = $Identity.instanceToken; metadataState = $Runtime.state }
  Assert-Stopped
  $Attempt.ownedStopRemoved = $true; Save-Attempt
}

function Preserve-OriginalBeforeStop {
  if (-not $Attempt -or $Action -cne 'ExecuteWindow' -or $Attempt.phase -cne 'claim' -or @($Attempt.commands).Count -or $StopLease -or $Attempt.stopEvidence -or $Attempt.stopMarkerConsumption -or $Attempt.candidateDirectoryCreated -or $Attempt.candidateIdentity -or $Attempt.candidateLaunch -or @(Get-ChildItem -LiteralPath (Split-Path -Parent $PlanPath) -Filter 'stop-proof-*.json' -File -ErrorAction Stop).Count -or (Test-Path -LiteralPath $Plan.candidateRoot) -or (Test-Path -LiteralPath (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy.stop')) -or (Test-Path -LiteralPath (Join-Path $Plan.transaction.contractRoot 'transaction-attempt.json'))) { return $false }
  Assert-OriginalBaseline
  $Identity = Resolve-OwnerColdStopIdentity $Plan.stopIdentity 'original-stop'
  $Attempt.status = 'failed-original-preserved'
  $Attempt.phase = 'original-baseline-preserved'
  $Attempt.preservedIdentity = $Identity
  Save-Attempt
  $Result.status = 'failed-original-preserved'
  $Result.originalStateVerified = $true
  $Result.preservedPlanSha256 = $PlanSha256
  $Result.preservedOwnerId = $Plan.ownerId
  $Result.preservedAttemptId = $Plan.attemptId
  $Result.preservedIdentity = $Identity
  return $true
}

function Clear-OwnedStop {
  $StopPath = Join-Path $Plan.dataRoot 'state/codex-app-server-proxy.stop'
  if (-not (Test-Path -LiteralPath $StopPath)) { return }
  if (-not $Plan.stopMarker -or (Get-Sha $StopPath) -cne $Plan.stopMarker.sha256) { throw 'OUTER_FOREIGN_STOP_MARKER_PRESERVED' }
  $Marker = Read-Json $StopPath
  if ($Marker.ownerId -cne $Plan.ownerId -or $Marker.attemptId -cne $Plan.attemptId) { throw 'OUTER_STOP_OWNER_MISMATCH' }
  Remove-Item -LiteralPath (Get-PlainPath $StopPath -TempOnly)
  $Attempt.ownedStopRemoved = $true
  Save-Attempt
}

function Invoke-Step([string]$Name, [string]$Executable, [string[]]$Arguments) {
  $Attempt.phase = $Name
  Save-Attempt
  $Started = [DateTimeOffset]::UtcNow
  $PreviousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $Raw = @(& $Executable @Arguments 2>&1); $Code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $PreviousPreference }
  $Text = ($Raw | ForEach-Object { [string]$_ }) -join "`n"
  $Response = $null
  try { $Response = $Text | ConvertFrom-Json } catch {}
  $Step = [ordered]@{ name = $Name; command = @($Executable) + $Arguments; startedAt = $Started.ToString('o'); elapsedMs = [int]([DateTimeOffset]::UtcNow - $Started).TotalMilliseconds; exitCode = $Code; output = $Text; response = $Response }
  $Attempt.commands += $Step
  Save-Attempt
  if ($Code -ne 0 -or $null -eq $Response) { throw ('OUTER_CHILD_FAILED_OR_UNKNOWN: ' + $Name + ': exit=' + $Code) }
  return $Response
}

function Start-BoundEntry([string]$Name) {
  Clear-OwnedStop
  if ($Name -ceq 'original-start-after-recovery') {
    foreach ($File in $Plan.oldStartGuardFiles) { if ((Get-Sha $File.path) -cne $File.sha256) { throw 'OUTER_FROZEN_ORIGINAL_START_GUARD_CHANGED' } }
    return Invoke-Step $Name $Plan.powerShell.path @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Plan.oldStartGuardFiles[0].path, '-PlanPath', $PlanPath, '-PlanSha256', $PlanSha256)
  }
  $Arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', (Join-Path $Plan.installedRoot 'ops/start-codex-app-server-proxy.ps1'), '-DataRoot', $Plan.dataRoot)
  $Supported = if ($Name -ceq 'original-start-after-recovery') { @($Plan.oldStartupParameters) } else { @($Plan.candidateStartupParameters) }
  foreach ($Property in $Plan.startup.PSObject.Properties) { if ($Property.Name -cin $Supported -and $Property.Name -cne 'RequestMetadataEnabled') { $Arguments += @(('-' + $Property.Name), ([string]$Property.Value)) } }
  if ($Plan.startup.RequestMetadataEnabled -eq $true) {
    if ('RequestMetadataEnabled' -cnotin $Supported) { throw 'OUTER_REQUEST_METADATA_SWITCH_UNSUPPORTED' }
    $Arguments += '-RequestMetadataEnabled'
  }
  if ('RequireNoStopMarker' -cin $Supported) { $Arguments += '-RequireNoStopMarker' }
  else { throw 'OUTER_CANDIDATE_STOP_GUARD_UNAVAILABLE' }
  if ($Name -ceq 'candidate-start' -and $Attempt.candidateLaunch) {
    if ('ExpectedInstanceToken' -cnotin $Supported -or 'LaunchReceiptPath' -cnotin $Supported) { throw 'OUTER_CANDIDATE_LAUNCH_RECEIPT_UNSUPPORTED' }
    $Arguments += @('-ExpectedInstanceToken', $Attempt.candidateLaunch.instanceToken, '-LaunchReceiptPath', $Attempt.candidateLaunch.receiptPath)
  }
  return Invoke-Step $Name $Plan.powerShell.path $Arguments
}

function Assert-WrittenState([string]$State) {
  foreach ($Entry in @($Manifest.files) + @([pscustomobject]@{ name = 'startup'; original = $Manifest.startup.original; candidate = [pscustomobject]@{ exists = $true; sha256 = $Manifest.startup.sha256 } })) {
    $Target = if ($Entry.name -eq 'startup') { $Manifest.startup.target } else { Join-Path $Plan.installedRoot $Entry.name }
    $Record = if ($State -eq 'applied') { $Entry.candidate } else { $Entry.original }
    if ((Test-Path -LiteralPath $Target -PathType Leaf) -ne [bool]$Record.exists) { throw 'OUTER_WRITTEN_EXISTENCE_CHANGED' }
    if ($Record.exists -and (Get-Sha $Target) -cne $Record.sha256) { throw 'OUTER_WRITTEN_BYTES_CHANGED' }
    if ($State -eq 'restored' -and $Record.exists -and (Get-Acl -LiteralPath $Target).Sddl -cne $Record.sddl) { throw 'OUTER_RESTORED_ACL_CHANGED' }
  }
  $Contract = Read-Json (Join-Path $Plan.transaction.contractRoot 'transaction-contract.json')
  $Receipt = Read-Json (Join-Path $Plan.transaction.contractRoot 'transaction-attempt.json')
  foreach ($Entry in $Contract.items) {
    $Accepted = @($Receipt.accepted | Where-Object { $_.name -ceq $Entry.name })
    if ($Accepted.Count -ne 1 -or (Test-Path -LiteralPath $Entry.target -PathType Leaf) -ne [bool]$Accepted[0].state.exists) { throw 'OUTER_WRITTEN_ACCEPTED_STATE_UNKNOWN' }
    if ($Accepted[0].state.exists -and ((Get-Sha $Entry.target) -cne $Accepted[0].state.sha256 -or (Get-Acl -LiteralPath $Entry.target).Sddl -cne $Accepted[0].state.sddl -or [int](Get-Item -LiteralPath $Entry.target -Force).Attributes -ne $Accepted[0].state.attributes)) { throw 'OUTER_WRITTEN_BYTES_ACL_ATTRIBUTES_DRIFT' }
  }
}

function Assert-OriginalBaseline {
  $Contract = Read-Json (Join-Path $Plan.transaction.contractRoot 'transaction-contract.json')
  if (@($Contract.items).Count -ne 20) { throw 'OUTER_ORIGINAL_CONTRACT_SCOPE_CHANGED' }
  foreach ($Entry in $Contract.items) {
    $Target = $Entry.target
    if ((Test-Path -LiteralPath $Target -PathType Leaf) -ne [bool]$Entry.original.exists) { throw 'OUTER_ORIGINAL_BASELINE_EXISTENCE_CHANGED' }
    if ($Entry.original.exists -and ((Get-Sha $Target) -cne $Entry.original.sha256 -or (Get-Acl -LiteralPath $Target).Sddl -cne $Entry.original.sddl -or [int](Get-Item -LiteralPath $Target -Force).Attributes -ne $Entry.original.attributes)) { throw 'OUTER_ORIGINAL_BASELINE_CHANGED' }
  }
}

try {
  if ($Action -in @('Inspect', 'Prepare')) {
    $Manifest = Read-Preparation $PreparationRoot $PreparationSha256 $OwnerId
    $Result.status = 'inspected'
    $Result.scope = 'outer-first-adoption-19+1'
    $Result.required = @('independent production transaction adapter', 'new unexpired owner window', 'independent Windows terminal', 'live identities and Desktop/Windows evidence')
    if ($Action -eq 'Inspect') { $Result.files = 19; $Result.recoveryItems = 20 }
    else {
      $PlanRoot = Get-PlainPath $PlanRoot -TempOnly
      if (Test-Path -LiteralPath $PlanRoot) { throw 'OUTER_NEW_PLAN_ROOT_REQUIRED' }
      foreach ($Root in @($PreparationRoot, $Manifest.installedRoot, $Manifest.dataRoot, $Manifest.sourceRoot)) {
        $Root = Get-PlainPath $Root
        if ($PlanRoot -ieq $Root -or $PlanRoot.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) -or $Root.StartsWith($PlanRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTER_PLAN_OVERLAPS_INPUT' }
      }
      $PowerShellPath = Get-PlainPath $PowerShellPath
      if ($PowerShellPath -ine (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')) { throw 'OUTER_ORIGINAL_WINDOWS_POWERSHELL_REQUIRED' }
      $NodePath = Get-PlainPath $NodePath
      if ([IO.Path]::GetFileName($NodePath) -ine 'node.exe') { throw 'OUTER_ABSOLUTE_NODE_REQUIRED' }
      $Startup = Read-Json $StartupParametersPath
      $Allowed = @('DownstreamPort', 'ControlPort', 'UpstreamPort', 'ProbePort', 'ResumeTimeoutMs', 'StartTimeoutMs', 'StartupTimeoutSeconds', 'CodexExecutablePath')
      $StartupNames = @($Startup.PSObject.Properties.Name | Where-Object { $_ -cne 'RequestMetadataEnabled' })
      if ((($StartupNames | Sort-Object) -join '|') -cne (($Allowed | Sort-Object) -join '|') -or ($Startup.PSObject.Properties.Name -ccontains 'RequestMetadataEnabled' -and $Startup.RequestMetadataEnabled -isnot [bool])) { throw 'OUTER_EXACT_STARTUP_PARAMETERS_REQUIRED' }
      if ($Startup.StartupTimeoutSeconds -lt 30 -or $Startup.StartupTimeoutSeconds -gt 300 -or $Startup.StartTimeoutMs -lt 1000 -or $Startup.StartTimeoutMs -gt 120000 -or $Startup.StartTimeoutMs -gt ($Startup.StartupTimeoutSeconds * 1000 - 15000)) { throw 'OUTER_STARTUP_READINESS_BUDGET_INVALID' }
      $Codex = Get-PlainPath $Startup.CodexExecutablePath
      $Ports = @($Startup.DownstreamPort, $Startup.ControlPort, $Startup.UpstreamPort, $Startup.ProbePort)
      if (@($Ports | Select-Object -Unique).Count -ne 4 -or @($Ports | Where-Object { $_ -lt 1 -or $_ -gt 65535 }).Count) { throw 'OUTER_STARTUP_PORTS_INVALID' }
      $AttemptId = [Guid]::NewGuid().ToString('N')
      $StopMarker = $null
      $AnchorSha = $null
      if ($SampleRoot) {
        $SampleRoot = Get-PlainPath $SampleRoot -TempOnly
        if ($Manifest.installedRoot -ine (Join-Path $SampleRoot 'installed') -or $Manifest.dataRoot -ine (Join-Path $SampleRoot 'data')) { throw 'OUTER_SAMPLE_MAPPING_MISMATCH' }
        $AnchorPath = Join-Path $SampleRoot '.outer-adoption-isolated-owner.json'
        $Anchor = Read-Json $AnchorPath
        if ($Anchor.ownerId -cne $OwnerId -or $Anchor.preparationSha256 -cne $PreparationSha256 -or $Anchor.preparationRoot -ine $PreparationRoot -or $Anchor.sampleRoot -ine $SampleRoot -or $Anchor.mode -cne 'TEMP_ISOLATED_RECOVERY') { throw 'OUTER_SAMPLE_OWNER_MISMATCH' }
        $AnchorSha = Get-Sha $AnchorPath
        $StopPath = Join-Path $Manifest.dataRoot 'state/codex-app-server-proxy.stop'
        if (Test-Path -LiteralPath $StopPath) {
          $Marker = Read-Json $StopPath
          if ($Marker.ownerId -cne $OwnerId -or $Marker.attemptId -notmatch '^[a-f0-9]{32}$') { throw 'OUTER_STOP_OWNER_MISMATCH' }
          $AttemptId = $Marker.attemptId
          $StopMarker = [ordered]@{ path = $StopPath; sha256 = (Get-Sha $StopPath) }
        }
      }
      $Inputs = @(
        [ordered]@{ path = $PSCommandPath; sha256 = (Get-Sha $PSCommandPath) },
        [ordered]@{ path = (Join-Path $PSScriptRoot 'apply-codex-outer-adoption-isolated.ps1'); sha256 = '56b0846510a2156ccd82f769e7748d18112391b02c0a1bfd24a8546b26cf2394' },
        [ordered]@{ path = (Join-Path $PSScriptRoot 'restore-codex-outer-adoption-isolated.ps1'); sha256 = '14bf22ad876d7aa129e93cb87e6d985d22cb3b7d8478e48445779a4c0d86fdeb' },
        [ordered]@{ path = (Join-Path $PSScriptRoot 'codex-outer-adoption-window-transaction.ps1'); sha256 = (Get-Sha (Join-Path $PSScriptRoot 'codex-outer-adoption-window-transaction.ps1')) }
      )
      foreach ($Input in $Inputs) { if ((Get-Sha $Input.path) -cne $Input.sha256) { throw 'OUTER_DEPENDENCY_BUILD_CHANGED' } }
      $Plan = [ordered]@{ schemaVersion = 1; mode = 'PREPARE_ONLY'; scope = 'outer-first-adoption-19+1'; productionReady = $false; productionTransactionPrepared = $false; ownerId = $OwnerId; attemptId = $AttemptId; preparationRoot = (Get-PlainPath $PreparationRoot); preparationSha256 = $PreparationSha256; sampleRoot = $SampleRoot; anchorSha256 = $AnchorSha; installedRoot = $Manifest.installedRoot; dataRoot = $Manifest.dataRoot; candidateRoot = $Manifest.startup.candidate.candidateRoot; inputs = $Inputs; stopMarker = $StopMarker; startup = $Startup; powerShell = @{ path = $PowerShellPath; sha256 = (Get-Sha $PowerShellPath) }; node = @{ path = $NodePath; sha256 = (Get-Sha $NodePath) }; codex = @{ path = $Codex; sha256 = (Get-Sha $Codex) } }
      $CandidateDirectory = Get-PlainPath $Plan.candidateRoot
      $Plan.candidateDirectoryOriginallyExists = Test-Path -LiteralPath $CandidateDirectory
      if (-not $SampleRoot -and $Plan.candidateDirectoryOriginallyExists) { throw 'OUTER_NEW_OWNED_CANDIDATE_DIRECTORY_REQUIRED' }
      $Plan.startStopPrepared = $false; $Plan.stopIdentity = $null; $Plan.runtimeBundle = $null; $Plan.stopFiles = @()
      $OldAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Plan.preparationRoot 'original/ops/start-codex-app-server-proxy.ps1'), [ref]$null, [ref]$null)
      $CandidateAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Plan.preparationRoot 'candidate/ops/start-codex-app-server-proxy.ps1'), [ref]$null, [ref]$null)
      $Plan.oldStartupParameters = @($OldAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
      $Plan.candidateStartupParameters = @($CandidateAst.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
      $Plan.originalRecoveryStopGuardPrepared = 'RequireNoStopMarker' -cin $Plan.oldStartupParameters
      $Plan.executionProfile = $ExecutionProfile; $Plan.desktop = $null
      $Plan.legacyRehearsal = $null
      if ($SampleRoot -and (Test-Path -LiteralPath (Join-Path $SampleRoot '.legacy-readonly-rehearsal.json'))) {
        $RehearsalPath = Join-Path $SampleRoot '.legacy-readonly-rehearsal.json'; $Proof = Read-Json $RehearsalPath
        $Actor = Process-Identity ([int]$Proof.actorPid)
        $TestPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'test/outer-adoption-window.test.mjs'
        if ($Proof.ownerId -cne $OwnerId -or $Proof.scope -cne 'outer-parent-readonly-legacy-rehearsal' -or $Proof.pendingRequests -ne 0 -or $Proof.mutatingRequests -ne 0 -or ($Proof.methodsCompleted -join '|') -cne 'initialize|thread/list' -or $Actor.executablePath -ine $NodePath -or $Actor.commandLine -notmatch 'outer-adoption-window\.test\.mjs' -or (Get-Sha $TestPath) -cne $Proof.actorSourceSha256 -or -not $Proof.connectedAt) { throw 'OUTER_KNOWN_READONLY_REHEARSAL_REQUIRED' }
        $Plan.legacyRehearsal = @{ path = $RehearsalPath; sha256 = (Get-Sha $RehearsalPath); actor = $Actor; connectedAt = $Proof.connectedAt }
      }
      if ($ExecutionProfile -ceq 'OwnerColdFirstAdoption') {
        $DesktopExecutablePath = Get-PlainPath $DesktopExecutablePath
        if ([IO.Path]::GetFileName($DesktopExecutablePath) -notin @('Codex.exe', 'ChatGPT.exe') -or $DesktopExecutablePath -ieq $Codex) { throw 'OUTER_DESKTOP_EXECUTABLE_BINDING_REQUIRED' }
        $DesktopProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -ieq $DesktopExecutablePath -and $_.CommandLine -notmatch 'app-server' })
        if (-not $DesktopProcesses.Count) { throw 'OUTER_LIVE_DESKTOP_SNAPSHOT_REQUIRED' }
        $DesktopIds = @($DesktopProcesses.ProcessId)
        $DesktopRoots = @($DesktopProcesses | Where-Object { $_.ParentProcessId -notin $DesktopIds })
        if ($DesktopRoots.Count -ne 1) { throw 'OUTER_UNIQUE_DESKTOP_ROOT_REQUIRED' }
        $Plan.desktop = [ordered]@{ executablePath = $DesktopExecutablePath; sha256 = (Get-Sha $DesktopExecutablePath); rootPid = [int]$DesktopRoots[0].ProcessId; processes = @($DesktopProcesses | ForEach-Object { Process-Identity ([int]$_.ProcessId) }) }
      }
      $RuntimePath = Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json'
      if (Test-Path -LiteralPath $RuntimePath) {
        $Runtime = Read-Json $RuntimePath
        if ($Runtime.state -ceq 'running') {
          $Plan.stopIdentity = Live-Binding $Runtime $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup
          $BundleRoot = Get-PlainPath (Split-Path -Parent $Runtime.executablePath)
          if ((Split-Path -Parent $BundleRoot) -ine (Join-Path $Plan.dataRoot 'state/codex-runtime-bundles')) { throw 'OUTER_FIXED_RUNTIME_BUNDLE_REQUIRED' }
          $BundleManifest = Read-Json (Join-Path $BundleRoot '.codex-runtime-manifest.json')
          if ((Split-Path -Leaf $BundleRoot) -cne $BundleManifest.digest -or $BundleManifest.digest -cnotmatch '^[a-f0-9]{64}$') { throw 'OUTER_RUNTIME_BUNDLE_DIGEST_REQUIRED' }
          $BundleFiles = @()
          foreach ($Name in @('.codex-runtime-manifest.json', 'codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')) {
            $Path = Join-Path $BundleRoot $Name
            $BundleFiles += [pscustomobject]@{ path = $Path; sha256 = (Get-Sha $Path); sddl = (Get-Acl -LiteralPath $Path).Sddl; attributes = [int](Get-Item -LiteralPath $Path -Force).Attributes }
          }
          $Plan.runtimeBundle = @{ digest = $BundleManifest.digest; files = $BundleFiles }; $Plan.startStopPrepared = $true
        }
      }
      New-Item -ItemType Directory -Path $PlanRoot | Out-Null
      New-Item -ItemType Directory -Path (Join-Path $PlanRoot 'stop-recovery/ops') | Out-Null
      foreach ($Name in @('stop-codex-app-server-proxy.ps1', 'owned-stop-marker.ps1', 'resolve-napcat-data-root.ps1')) {
        $Source = Join-Path $PSScriptRoot $Name; $Target = Join-Path $PlanRoot ('stop-recovery/ops/' + $Name)
        Copy-Item -LiteralPath $Source -Destination $Target
        $Plan.stopFiles += [pscustomobject]@{ sourcePath = $Source; path = $Target; sha256 = (Get-Sha $Source) }
      }
      $GuardPath = Join-Path $PlanRoot 'original-start-stop-guard.cjs'
      $GuardNode = @'
const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(process.env.OUTER_ORIGINAL_STOP_GUARD_PATH).toLowerCase();
function guarded(original) {
  return function(value, ...args) {
    if (path.resolve(String(value)).toLowerCase() === target && fs.existsSync(value)) throw new Error('OUTER_FOREIGN_STOP_MARKER_PRESERVED');
    return original.call(this, value, ...args);
  };
}
fs.rmSync = guarded(fs.rmSync);
fs.unlinkSync = guarded(fs.unlinkSync);
require('node:module').syncBuiltinESMExports();
'@
      $GuardPsPath = Join-Path $PlanRoot 'original-start-guard.ps1'
      $GuardPs = @'
[CmdletBinding()]
param([string]$PlanPath,[string]$PlanSha256)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
if((Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PlanSha256){throw 'OUTER_GUARD_PLAN_CHANGED'}
$Binding=Get-Content -LiteralPath $PlanPath -Encoding UTF8 -Raw|ConvertFrom-Json
if($Binding.scope -cne 'outer-first-adoption-19+1' -or $Binding.mode -cne 'PREPARE_ONLY'){throw 'OUTER_GUARD_FIXED_BINDING_REQUIRED'}
foreach($File in @($Binding.oldStartGuardFiles)+@($Binding.node)){if((Get-FileHash -LiteralPath $File.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $File.sha256){throw 'OUTER_GUARD_BYTES_CHANGED'}}
$Manifest=Get-Content -LiteralPath (Join-Path $Binding.preparationRoot 'preparation.json') -Encoding UTF8 -Raw|ConvertFrom-Json
$Start=Join-Path $Binding.installedRoot 'ops/start-codex-app-server-proxy.ps1'
$Saved=@($Manifest.files|Where-Object {$_.name -ceq 'ops/start-codex-app-server-proxy.ps1'})[0]
if((Get-FileHash -LiteralPath $Start -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Saved.original.sha256){throw 'OUTER_ORIGINAL_ENTRY_NOT_RESTORED'}
$script:ProtectedStop=Join-Path $Binding.dataRoot 'state/codex-app-server-proxy.stop'
function Remove-Item {
  [CmdletBinding()]param([string[]]$LiteralPath,[string[]]$Path,[switch]$Force,[switch]$Recurse)
  foreach($Value in @($LiteralPath)+@($Path)){if($Value -and [IO.Path]::GetFullPath($Value) -ieq $script:ProtectedStop){throw 'OUTER_FOREIGN_STOP_MARKER_PRESERVED'}}
  Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
}
if(Test-Path -LiteralPath $ProtectedStop){throw 'OUTER_FOREIGN_STOP_MARKER_PRESERVED'}
if($env:NODE_OPTIONS){throw 'OUTER_EXISTING_NODE_OPTIONS_REJECTED'}
$env:CODEX_TOOLKIT_NODE_EXE=$Binding.node.path
$env:OUTER_ORIGINAL_STOP_GUARD_PATH=$ProtectedStop
$env:NODE_OPTIONS='--require "'+$Binding.oldStartGuardFiles[1].path.Replace('\','/')+'"'
$Values=@{DataRoot=$Binding.dataRoot}
foreach($Property in $Binding.startup.PSObject.Properties){if($Property.Name -cin @($Binding.oldStartupParameters)){$Values[$Property.Name]=$Property.Value}}
if('RequireNoStopMarker' -cin @($Binding.oldStartupParameters)){$Values.RequireNoStopMarker=$true}
& $Start @Values
'@
      [IO.File]::WriteAllText($GuardPath, $GuardNode, $Utf8); [IO.File]::WriteAllText($GuardPsPath, $GuardPs, $Utf8)
      $Plan.oldStartGuardFiles = @([pscustomobject]@{ path = $GuardPsPath; sha256 = (Get-Sha $GuardPsPath) }, [pscustomobject]@{ path = $GuardPath; sha256 = (Get-Sha $GuardPath) })
      $Plan.originalRecoveryStopGuardPrepared = $true
      $TransactionMode = if ($SampleRoot) { 'TempMapping' } else { 'Production' }
      $TransactionRoot = Join-Path $PlanRoot 'transaction'
      $TransactionArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Inputs[3].path, '-Action', 'Prepare', '-Mode', $TransactionMode, '-PreparationRoot', $Plan.preparationRoot, '-PreparationSha256', $PreparationSha256, '-OwnerId', $OwnerId, '-ContractRoot', $TransactionRoot, '-PowerShellPath', $PowerShellPath, '-NodePath', $NodePath)
      if ($SampleRoot) { $TransactionArguments += @('-SampleRoot', $SampleRoot) }
      $TransactionArguments += @('-ParentEntrySha256', $Plan.inputs[0].sha256, '-ParentAttemptId', $Plan.attemptId, '-ExecutionProfile', $ExecutionProfile)
      $TransactionOutput = @(& $PowerShellPath @TransactionArguments) -join "`n"
      $TransactionExit = $LASTEXITCODE
      $TransactionPrepared = $TransactionOutput | ConvertFrom-Json
      if ($TransactionExit -ne 0 -or $TransactionPrepared.status -cne 'prepared-only') { throw ('OUTER_TRANSACTION_PREPARATION_FAILED: ' + $TransactionOutput) }
      $Plan.transaction = $TransactionPrepared
      $Plan.productionTransactionPrepared = $true
      $PlanPath = Join-Path $PlanRoot 'window-plan.json'
      Write-NewJson $PlanPath $Plan
      $Result.status = 'prepared-only'
      $Result.planPath = $PlanPath
      $Result.planSha256 = Get-Sha $PlanPath
    }
  } else {
    $PlanPath = Get-PlainPath $PlanPath -TempOnly
    if ($PlanSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-Sha $PlanPath) -cne $PlanSha256) { throw 'OUTER_PLAN_SHA_MISMATCH' }
    $Plan = Read-Json $PlanPath
    if ($Plan.schemaVersion -ne 1 -or $Plan.mode -cne 'PREPARE_ONLY' -or $Plan.scope -cne 'outer-first-adoption-19+1' -or $Plan.productionReady -ne $false -or $Plan.productionTransactionPrepared -ne $true) { throw 'OUTER_PLAN_CONTRACT_INVALID' }
    $ExpectedInputs = @($PSCommandPath, (Join-Path $PSScriptRoot 'apply-codex-outer-adoption-isolated.ps1'), (Join-Path $PSScriptRoot 'restore-codex-outer-adoption-isolated.ps1'), (Join-Path $PSScriptRoot 'codex-outer-adoption-window-transaction.ps1'))
    if (@($Plan.inputs).Count -ne 4 -or $Plan.powerShell.path -ine (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe')) { throw 'OUTER_FIXED_DEPENDENCIES_REQUIRED' }
    for ($Index = 0; $Index -lt 4; $Index++) { if ($Plan.inputs[$Index].path -ine $ExpectedInputs[$Index]) { throw 'OUTER_FIXED_DEPENDENCIES_REQUIRED' } }
    foreach ($Input in @($Plan.inputs) + @($Plan.powerShell, $Plan.node, $Plan.codex)) { if ((Get-Sha $Input.path) -cne $Input.sha256) { throw 'OUTER_DEPENDENCY_BUILD_CHANGED' } }
    if ($Plan.inputs[0].path -ine $PSCommandPath) { throw 'OUTER_PARENT_ENTRY_MISMATCH' }
    $Manifest = Read-Preparation $Plan.preparationRoot $Plan.preparationSha256 $Plan.ownerId
    if ($Plan.installedRoot -ine $Manifest.installedRoot -or $Plan.dataRoot -ine $Manifest.dataRoot -or $Plan.candidateRoot -ine $Manifest.startup.candidate.candidateRoot) { throw 'OUTER_PLAN_ROOT_BINDING_MISMATCH' }
    $ExpectedTransactionRoot = Join-Path (Split-Path -Parent $PlanPath) 'transaction'
    if ($Plan.transaction.contractRoot -ine $ExpectedTransactionRoot -or $Plan.transaction.recoveryEntry -ine (Join-Path $ExpectedTransactionRoot 'transaction.ps1') -or (Get-Sha $Plan.transaction.recoveryEntry) -cne $Plan.inputs[3].sha256 -or (Get-Sha (Join-Path $ExpectedTransactionRoot 'transaction-contract.json')) -cne $Plan.transaction.contractSha256) { throw 'OUTER_FROZEN_TRANSACTION_CHANGED' }
    $Result.productionTransactionPrepared = $true
    $AttemptPath = Join-Path (Split-Path -Parent $PlanPath) 'attempt.json'
    if ($Action -eq 'ObserveDesktopExit') {
      Assert-IndependentTerminal
      if ($Plan.executionProfile -cne 'OwnerColdFirstAdoption' -or -not $Plan.desktop -or (Get-Sha $Plan.desktop.executablePath) -cne $Plan.desktop.sha256) { throw 'OUTER_COLD_DESKTOP_BINDING_REQUIRED' }
      $Handles = @()
      foreach ($Identity in $Plan.desktop.processes) {
        if (($Identity | ConvertTo-Json -Compress) -cne ((Process-Identity ([int]$Identity.pid)) | ConvertTo-Json -Compress)) { throw 'OUTER_DESKTOP_IDENTITY_CHANGED' }
        $Handle = Get-Process -Id ([int]$Identity.pid) -ErrorAction Stop
        [void]$Handle.Handle
        $Handles += $Handle
      }
      Publish-ReadyJson (Join-Path (Split-Path -Parent $PlanPath) 'desktop-normal-observer-ready.json') ([ordered]@{ schemaVersion = 1; ownerId = $Plan.ownerId; planSha256 = $PlanSha256; observerPid = $PID; handlesPinned = $true; preparedAt = [DateTimeOffset]::UtcNow.ToString('o') })
      $Deadline = [DateTimeOffset]::UtcNow.AddSeconds($DesktopExitTimeoutSeconds)
      while (@($Handles | Where-Object { -not $_.HasExited }).Count) { if ([DateTimeOffset]::UtcNow -ge $Deadline) { throw 'OUTER_DESKTOP_NORMAL_EXIT_NOT_OBSERVED' }; Start-Sleep -Milliseconds 250 }
      $RootHandle = @($Handles | Where-Object { $_.Id -eq $Plan.desktop.rootPid })[0]
      if ($RootHandle.ExitCode -ne 0) { throw 'OUTER_DESKTOP_NORMAL_EXIT_CODE_REQUIRED' }
      $DesktopRecord = [ordered]@{ schemaVersion = 1; ownerId = $Plan.ownerId; operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; planSha256 = $PlanSha256; parentSha256 = $Plan.inputs[0].sha256; executablePath = $Plan.desktop.executablePath; executableSha256 = $Plan.desktop.sha256; rootPid = $Plan.desktop.rootPid; rootExitCode = $RootHandle.ExitCode; processesEnded = $true; observedAt = [DateTimeOffset]::UtcNow.ToString('o') }
      $DesktopPath = Join-Path (Split-Path -Parent $PlanPath) 'desktop-normal-exit.json'
      Write-NewJson $DesktopPath $DesktopRecord
      $Result.status = 'desktop-normal-exit-observed'; $Result.desktopExitPath = $DesktopPath; $Result.desktopExitSha256 = Get-Sha $DesktopPath
    } elseif ($Action -in @('ExecuteWindow', 'RecoverWindow') -and -not $Plan.sampleRoot) {
      if (-not $WindowPath -or $WindowSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'OUTER_NEW_OWNER_WINDOW_REQUIRED' }
      if ((Get-Sha $WindowPath) -cne $WindowSha256) { throw 'OUTER_WINDOW_SHA_MISMATCH' }
      $Window = Read-Json $WindowPath
      if ($Window.scope -cne $Plan.scope -or $Window.ownerId -cne $Plan.ownerId -or $Window.planSha256 -cne $PlanSha256 -or $Window.preparationSha256 -cne $Plan.preparationSha256 -or $Window.parentSha256 -cne $Plan.inputs[0].sha256) { throw 'OUTER_WINDOW_BINDING_MISMATCH' }
      if ($Window.expiresAt -notmatch '(Z|[+-]\d\d:\d\d)$') { throw 'OUTER_OWNER_WINDOW_EXPIRED' }
      if ([DateTimeOffset]::Parse($Window.expiresAt) -le [DateTimeOffset]::UtcNow) {
        if ($Action -cne 'RecoverWindow' -or $Window.recoveryAfterExpiry -ne $true -or -not (Test-Path -LiteralPath $AttemptPath) -or (Read-Json $AttemptPath).windowSha256 -cne $WindowSha256) { throw 'OUTER_OWNER_WINDOW_EXPIRED' }
      }
      $Contract = Read-Json (Join-Path $ExpectedTransactionRoot 'transaction-contract.json')
      if ($Plan.sampleRoot -or $Plan.startStopPrepared -ne $true -or $Plan.originalRecoveryStopGuardPrepared -ne $true -or $Window.mode -cne 'OWNER_APPROVED_PRODUCTION_WINDOW' -or $Window.authorizedByOwner -ne $true -or -not $Window.approvalRef -or $Window.contractSha256 -cne $Plan.transaction.contractSha256 -or $Window.operatorSid -cne $Contract.operatorSid -or $Window.operatorSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $Window.installedRoot -ine $Plan.installedRoot -or $Window.dataRoot -ine $Plan.dataRoot -or $Window.entrySha256 -cne $Plan.inputs[3].sha256 -or $Window.stopIdentity.instanceToken -cne $Plan.stopIdentity.instanceToken -or $Window.startsAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or [DateTimeOffset]::Parse($Window.startsAt) -gt [DateTimeOffset]::UtcNow) { throw 'OUTER_EXACT_NEW_OWNER_WINDOW_REQUIRED' }
      if ($Plan.executionProfile -ceq 'OwnerColdFirstAdoption') {
        $DesktopPath = Join-Path (Split-Path -Parent $PlanPath) 'desktop-normal-exit.json'
        if ($Window.executionProfile -cne 'OwnerColdFirstAdoption' -or $Window.acceptsShortInterruption -ne $true -or $Window.acceptsLegacyRequestCounterLimit -ne $true -or (Get-Sha $DesktopPath) -cne $Window.desktopExitSha256) { throw 'OUTER_COLD_IMPACT_AND_DESKTOP_EXIT_WINDOW_REQUIRED' }
        $DesktopExit = Read-Json $DesktopPath
        if ($DesktopExit.planSha256 -cne $PlanSha256 -or $DesktopExit.parentSha256 -cne $Plan.inputs[0].sha256 -or $DesktopExit.ownerId -cne $Plan.ownerId -or $DesktopExit.operatorSid -cne $Window.operatorSid -or $DesktopExit.executablePath -ine $Plan.desktop.executablePath -or $DesktopExit.executableSha256 -cne $Plan.desktop.sha256 -or $DesktopExit.rootPid -ne $Plan.desktop.rootPid -or $DesktopExit.rootExitCode -ne 0 -or $DesktopExit.processesEnded -ne $true) { throw 'OUTER_NORMAL_DESKTOP_EXIT_RECORD_REQUIRED' }
        if (@(Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -ieq $Plan.desktop.executablePath }).Count) { throw 'OUTER_DESKTOP_STILL_RUNNING_OR_REOPENED' }
      }
      Assert-IndependentTerminal
    }
    if ($Action -eq 'ObserveDesktopExit') { }
    elseif ($Action -eq 'VerifyOnly') {
      if ($Plan.sampleRoot) { [void](Get-PlainPath $Plan.sampleRoot -TempOnly); if ((Get-Sha (Join-Path $Plan.sampleRoot '.outer-adoption-isolated-owner.json')) -cne $Plan.anchorSha256) { throw 'OUTER_TEMP_BINDING_CHANGED' } }
      if (Test-Path -LiteralPath $AttemptPath) {
        $Saved = Read-Json $AttemptPath
        if ($Saved.planSha256 -cne $PlanSha256 -or $Saved.ownerId -cne $Plan.ownerId) { throw 'OUTER_ATTEMPT_BINDING_MISMATCH' }
        if ($Saved.status -in @('applied', 'restored')) { Assert-WrittenState $Saved.status; $Result.writtenState = $Saved.status }
        else { throw 'OUTER_ATTEMPT_STATE_UNKNOWN_OR_FAILED' }
      } else {
        Assert-OriginalBaseline
        if ($Plan.stopIdentity) { Assert-Live $Plan.stopIdentity -ReadOnly } else { Assert-Stopped }
      }
      $Result.status = 'verified-only'
    } else {
      if ($Action -ne 'ExecuteWindow' -and -not ($Action -ceq 'RecoverWindow' -and -not $Plan.sampleRoot)) {
        [void](Get-PlainPath $Plan.sampleRoot -TempOnly)
        foreach ($Root in @($Plan.preparationRoot, $Plan.installedRoot, $Plan.dataRoot)) { [void](Get-PlainPath $Root -TempOnly) }
        if ($Plan.installedRoot -ine (Join-Path $Plan.sampleRoot 'installed') -or $Plan.dataRoot -ine (Join-Path $Plan.sampleRoot 'data') -or (Get-Sha (Join-Path $Plan.sampleRoot '.outer-adoption-isolated-owner.json')) -cne $Plan.anchorSha256) { throw 'OUTER_TEMP_BINDING_CHANGED' }
      }
      if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop' -or (Get-ExecutionPolicy) -ne 'RemoteSigned' -or (Get-ExecutionPolicy -Scope Process) -ne 'Undefined') { throw 'OUTER_ORDINARY_WINDOWS_TERMINAL_REQUIRED' }
      $TransactionArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Plan.transaction.recoveryEntry, '-Mode', 'TempMapping', '-Action', 'Apply', '-ContractRoot', $Plan.transaction.contractRoot, '-ContractSha256', $Plan.transaction.contractSha256)
      if ($Action -eq 'ExecuteWindow' -or ($Action -ceq 'RecoverWindow' -and -not $Plan.sampleRoot)) { $TransactionArgs[6] = 'Production'; $TransactionArgs += @('-WindowPath', $WindowPath, '-WindowSha256', $WindowSha256) }
      if ($Action -eq 'ExecuteWindow' -and -not (Test-Path -LiteralPath $AttemptPath)) {
        $GateArguments = @($TransactionArgs); $GateArguments[8] = 'VerifyOwnerGate'
        $GateOutput = @(& $Plan.powerShell.path @GateArguments) -join "`n"
        $GateExit = $LASTEXITCODE
        $GateResult = $GateOutput | ConvertFrom-Json
        if ($GateExit -ne 0 -or $GateResult.status -cne 'owner-gate-verified' -or $GateResult.productionModified -ne $false) { throw ('OUTER_TRANSACTION_OWNER_PREFLIGHT_FAILED: ' + $GateResult.error) }
        $Result.ownerGateVerified = $true
      }
      if (Test-Path -LiteralPath $AttemptPath) {
        $Saved = Read-Json $AttemptPath
        if ($Saved.planSha256 -cne $PlanSha256 -or $Saved.ownerId -cne $Plan.ownerId -or $Saved.attemptId -cne $Plan.attemptId) { throw 'OUTER_ATTEMPT_BINDING_MISMATCH' }
        if ($Action -in @('TempApply', 'ExecuteWindow')) {
          if ($Saved.status -cne 'applied') { throw 'OUTER_ATTEMPT_STATE_UNKNOWN_OR_TERMINAL' }
          Assert-WrittenState 'applied'
          $Result.status = 'already-written-verified'
        } else {
          $Attempt = $Saved
          if ($Action -ceq 'RecoverWindow' -and -not $Plan.sampleRoot -and ($Saved.windowSha256 -cne $WindowSha256 -or $Saved.windowPath -ine $WindowPath)) { throw 'OUTER_RECOVERY_ORIGINAL_WINDOW_REQUIRED' }
          $Journal = [IO.File]::Open($AttemptPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
          if ($Attempt.status -ceq 'restored') {
            Assert-OriginalBaseline
            if ($Action -ceq 'RecoverWindow') {
              $RuntimePath = Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json'
              $Current = Read-Json $RuntimePath
              if ($Current.state -ceq 'running') {
                if (-not $Attempt.recoveredIdentity) { throw 'OUTER_RECOVERED_RUNNING_IDENTITY_UNKNOWN' }
                Assert-Live $Attempt.recoveredIdentity
              } else {
                if ($Attempt.recoveredIdentity -and $Current.state -ceq 'stopping') {
                  if ($Current.instanceToken -cne $Attempt.recoveredIdentity.instanceToken -or [int]$Current.pid -ne [int]$Attempt.recoveredIdentity.proxy.pid -or ($Current.appServerPid -and [int]$Current.appServerPid -ne [int]$Attempt.recoveredIdentity.child.pid)) { throw 'OUTER_RECOVERED_STOPPED_IDENTITY_CHANGED' }
                  foreach ($Identity in @($Attempt.recoveredIdentity.proxy, $Attempt.recoveredIdentity.child)) { if (Get-Process -Id ([int]$Identity.pid) -ErrorAction SilentlyContinue) { throw 'OUTER_RECOVERED_PROCESS_STILL_PRESENT' } }
                  foreach ($Port in @($Plan.startup.DownstreamPort, $Plan.startup.ControlPort, $Plan.startup.UpstreamPort, $Plan.startup.ProbePort)) {
                    $Listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$Port)
                    try { $Listener.Start() } finally { $Listener.Stop() }
                  }
                } else { Assert-Stopped }
                $OldStart = Start-BoundEntry 'original-start-after-recovery'
                if ($OldStart.state -cne 'running') { throw 'OUTER_ORIGINAL_START_HEALTH_UNKNOWN' }
                $Attempt | Add-Member -MemberType NoteProperty -Name recoveredIdentity -Value (Live-Binding (Read-Json $RuntimePath) $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup) -Force
                Save-Attempt
              }
            }
            $Result.status = 'already-restored-verified'
          } else {
          if ($Attempt.stopEvidence) { $StopBoundary = Read-Json $Attempt.stopEvidence.path }
          if ($Attempt.candidateIdentity -and (Get-Process -Id ([int]$Attempt.candidateIdentity.proxy.pid) -ErrorAction SilentlyContinue)) { Stop-BoundEntry $Attempt.candidateIdentity 'candidate-stop-before-restore' }
          if (-not $Attempt.candidateIdentity) { Wait-CandidateStartupTermination }
          Assert-Stopped
          $TransactionArgs[8] = 'Restore'
          if ($Attempt.stopEvidence) { $TransactionArgs += @('-StopEvidencePath', $Attempt.stopEvidence.path, '-StopEvidenceSha256', $Attempt.stopEvidence.sha256) }
          if (Test-Path -LiteralPath (Join-Path $Plan.transaction.contractRoot 'transaction-attempt.json')) {
            $Recovery = Invoke-Step 'independent-restore' $Plan.powerShell.path $TransactionArgs
            if ($Recovery.status -cne 'restored' -or @($Recovery.completed).Count -ne 20) { throw 'OUTER_RECOVERY_INCOMPLETE' }
            Assert-WrittenState 'restored'
          } else { Assert-OriginalBaseline }
          if ($Action -ceq 'RecoverWindow') {
            $OldStart = Start-BoundEntry 'original-start-after-recovery'
            if ($OldStart.state -cne 'running') { throw 'OUTER_ORIGINAL_START_HEALTH_UNKNOWN' }
            $Attempt | Add-Member -MemberType NoteProperty -Name recoveredIdentity -Value (Live-Binding (Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')) $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup) -Force
          }
          $Attempt.status = 'restored'
          Save-Attempt
          $Result.status = if ($Action -ceq 'RecoverWindow') { 'window-restored' } else { 'restored' }
          }
        }
      } else {
        if ($Action -in @('TempRestore', 'RecoverWindow')) { throw 'OUTER_ORIGINAL_ATTEMPT_REQUIRED' }
        if ($Plan.stopIdentity) { $ResolvedStopIdentity = Resolve-OwnerColdStopIdentity $Plan.stopIdentity 'original-stop' } else { Assert-Stopped }
        $CandidateRoot = Get-PlainPath $Plan.candidateRoot
        if ($Action -ne 'ExecuteWindow') { [void](Get-PlainPath $CandidateRoot -TempOnly) }
        if ($Action -eq 'ExecuteWindow' -and ($Plan.candidateDirectoryOriginallyExists -ne $false -or (Test-Path -LiteralPath $CandidateRoot))) { throw 'OUTER_NEW_OWNED_CANDIDATE_DIRECTORY_REQUIRED' }
        if ((Test-Path -LiteralPath $CandidateRoot) -and @(Get-ChildItem -LiteralPath $CandidateRoot -Force).Count) { throw 'OUTER_EMPTY_CANDIDATE_DIRECTORY_REQUIRED' }
        $Journal = [IO.File]::Open($AttemptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        $Attempt = [ordered]@{ schemaVersion = 1; mode = $(if ($Action -eq 'ExecuteWindow') { 'OWNER_WINDOW' } else { 'TEMP_PARENT_MAPPING' }); ownerId = $Plan.ownerId; attemptId = $Plan.attemptId; planSha256 = $PlanSha256; windowPath = $WindowPath; windowSha256 = $WindowSha256; status = 'in-progress'; phase = 'claim'; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); commands = @(); initialFailure = $null; recoveryFailure = $null; ownedStopRemoved = $false; candidateDirectoryCreated = $false; candidateIdentity = $null; stopEvidence = $null }
        Save-Attempt
        $PreviousNode = $env:CODEX_TOOLKIT_NODE_EXE
        try {
          $env:CODEX_TOOLKIT_NODE_EXE = $Plan.node.path
          if ($Plan.stopIdentity) { Stop-BoundEntry $ResolvedStopIdentity 'original-stop'; Assert-Stopped }
          if ($Attempt.stopEvidence) { $TransactionArgs += @('-StopEvidencePath', $Attempt.stopEvidence.path, '-StopEvidenceSha256', $Attempt.stopEvidence.sha256) }
          if (-not (Test-Path -LiteralPath $CandidateRoot)) { New-Item -ItemType Directory -Path $CandidateRoot -ErrorAction Stop | Out-Null; $Attempt.candidateDirectoryCreated = $true; $Attempt.candidateDirectory = [pscustomobject]@{ path = $CandidateRoot; parentAttemptId = $Plan.attemptId; owner = (Get-Acl -LiteralPath $CandidateRoot).Owner; sddl = (Get-Acl -LiteralPath $CandidateRoot).Sddl; attributes = [int](Get-Item -LiteralPath $CandidateRoot -Force).Attributes; initiallyEmpty = (@(Get-ChildItem -LiteralPath $CandidateRoot -Force).Count -eq 0) }; Save-Attempt; if (-not $Attempt.candidateDirectory.initiallyEmpty) { throw 'OUTER_CANDIDATE_DIRECTORY_OWNERSHIP_UNKNOWN' } }
          $Applied = Invoke-Step 'window-transaction-apply' $Plan.powerShell.path $TransactionArgs
          if ($Applied.status -cne 'applied' -or @($Applied.completed).Count -ne 20) { throw 'OUTER_APPLY_INCOMPLETE' }
          Assert-WrittenState 'applied'
          if ('ExpectedInstanceToken' -cin $Plan.candidateStartupParameters -and 'LaunchReceiptPath' -cin $Plan.candidateStartupParameters) {
            $LaunchArguments = @($TransactionArgs); $LaunchArguments[8] = 'BindCandidateLaunch'
            $LaunchArguments += @('-CandidateLaunchToken', ([Guid]::NewGuid().ToString()), '-CandidateLaunchReceiptPath', (Join-Path (Split-Path -Parent $PlanPath) 'candidate-launch.json'))
            $LaunchBound = Invoke-Step 'bind-candidate-launch' $Plan.powerShell.path $LaunchArguments
            if ($LaunchBound.status -cne 'candidate-launch-bound') { throw 'OUTER_CANDIDATE_LAUNCH_NOT_BOUND' }
            $Attempt | Add-Member -MemberType NoteProperty -Name candidateLaunch -Value $LaunchBound.candidateLaunch -Force
            Save-Attempt
          } elseif (-not $Plan.sampleRoot) { throw 'OUTER_CANDIDATE_LAUNCH_RECEIPT_REQUIRED' }
          $Started = Start-BoundEntry 'candidate-start'
          if ($Started.state -cne 'running') { throw 'OUTER_STARTUP_HEALTH_UNKNOWN' }
          if ($Plan.startStopPrepared) { $Attempt.candidateIdentity = Live-Binding (Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')) $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup; Save-Attempt }
          if ($Attempt.candidateIdentity) { $BindArguments = @($TransactionArgs); $BindArguments[8] = 'BindCandidateInstance'; $Bound = Invoke-Step 'bind-candidate-instance' $Plan.powerShell.path $BindArguments; if ($Bound.status -cne 'candidate-instance-bound' -or $Bound.candidateInstance.instanceToken -cne $Attempt.candidateIdentity.instanceToken) { throw 'OUTER_CANDIDATE_RECEIPT_INSTANCE_NOT_BOUND' } }
          $Control = Invoke-Step 'candidate-management-status' $Plan.node.path @((Join-Path $Plan.installedRoot 'ops/codex-outer-runtime.mjs'), '--runtime-state', (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json'), '--token-file', (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-token.txt'), '--action', 'status')
          if ($Control.ok -ne $true -or $Control.enabled -ne $true -or $Control.closed -ne $false) { throw 'OUTER_MANAGEMENT_HEALTH_UNKNOWN' }
          $Attempt.status = 'applied'
          Save-Attempt
          $Result.status = if ($Action -eq 'ExecuteWindow') { 'window-applied' } else { 'temp-applied' }
        } catch {
          $InitialFailure = $_.Exception.Message
          $Attempt.initialFailure = $InitialFailure
          $Attempt.status = 'failed'
          Save-Attempt
          try {
            if (Preserve-OriginalBeforeStop) { }
            else {
            if ($Attempt.candidateIdentity -and (Get-Process -Id ([int]$Attempt.candidateIdentity.proxy.pid) -ErrorAction SilentlyContinue)) { Stop-BoundEntry $Attempt.candidateIdentity 'candidate-stop-after-failure' }
            if (-not $Attempt.candidateIdentity) { Wait-CandidateStartupTermination }
            Assert-Stopped
            $TransactionArgs[8] = 'Restore'
            $Recovery = Invoke-Step 'independent-restore' $Plan.powerShell.path $TransactionArgs
            if ($Recovery.status -cne 'restored' -or @($Recovery.completed).Count -ne 20) { throw 'OUTER_RECOVERY_INCOMPLETE' }
            Assert-WrittenState 'restored'
            $OldStart = Start-BoundEntry 'original-start-after-recovery'
            if ($OldStart.state -cne 'running') { throw 'OUTER_ORIGINAL_START_HEALTH_UNKNOWN' }
            $Attempt | Add-Member -MemberType NoteProperty -Name recoveredIdentity -Value (Live-Binding (Read-Json (Join-Path $Plan.dataRoot 'state/codex-app-server-proxy-runtime.json')) $Plan.installedRoot $Plan.dataRoot $Plan.node $Plan.startup) -Force
            $Attempt.status = 'restored'
            $Result.status = 'failed-restored'
            }
          } catch { $Attempt.recoveryFailure = $_.Exception.Message; $Attempt.status = 'recovery-required'; $Result.status = 'recovery-required' }
          Save-Attempt
          $Result.initialFailure = $InitialFailure
          $Result.recoveryFailure = $Attempt.recoveryFailure
          $ExitCode = 1
        } finally { $env:CODEX_TOOLKIT_NODE_EXE = $PreviousNode }
      }
      $Result.attemptPath = $AttemptPath
    }
  }
} catch { $Result.error = $_.Exception.Message; $ExitCode = 1 }
finally {
  if ($StopLease) { try { [void][NapCat.OwnedStopMarker.Native]::Close($StopLease) } catch { $Result.stopLeaseCloseFailure = $_.Exception.Message; $ExitCode = 1 } }
  if ($Journal) { $Journal.Dispose() }
  $Result | ConvertTo-Json -Depth 16 -Compress
}
if ($ExitCode) { exit $ExitCode }
