[CmdletBinding()]
param(
  [ValidateSet("Drill", "Activate")]
  [string]$Action = "Drill",
  [string]$ServiceRoot = $(Join-Path $env:USERPROFILE ".codex\services\wechat-docs-bridge"),
  [string]$DataRoot = $(Join-Path $env:USERPROFILE ".codex-toolkit\wechat-docs-mcp"),
  [string]$BrokerRoot = $(Join-Path $env:USERPROFILE ".codex\mcp-http-broker"),
  [string]$CandidateReleaseId,
  [string]$ExpectedCurrentReleaseId,
  [string]$RouteId,
  [string]$CandidateManifestPath,
  [string]$DrillRoot,
  [string]$Endpoint = "wechat-docs",
  [int]$ExpectedCurrentToolCount = 15,
  [int]$ExpectedToolCount = 29,
  [string]$ProtectedEndpoint = "napcat",
  [int]$ExpectedProtectedToolCount = 22,
  [string]$BrokerBaseUrl = "http://127.0.0.1:14588",
  [ValidateRange(5, 180)]
  [int]$TimeoutSeconds = 60,
  [string]$ProbePython,
  [switch]$ConfirmProductionActivation
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ProbeScript = Join-Path $PSScriptRoot "release_probe.py"
. (Join-Path $PSScriptRoot "release_drill.ps1")

function Get-FullPath {
  param([string]$Path)
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-ChildPath {
  param([string]$Path, [string]$Parent, [string]$Label)
  $FullPath = Get-FullPath $Path
  $FullParent = Get-FullPath $Parent
  if (-not $FullPath.StartsWith($FullParent + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside its allowed root: $FullPath"
  }
}

function Read-Json {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "JSON file not found: $Path" }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-JsonAtomic {
  param([string]$Path, $Value)
  $Parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $Parent -Force | Out-Null
  $TemporaryPath = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  [System.IO.File]::WriteAllText($TemporaryPath, (($Value | ConvertTo-Json -Depth 30) + "`n"), $Utf8NoBom)
  Move-Item -LiteralPath $TemporaryPath -Destination $Path -Force
}

function Set-JsonProperty {
  param($Object, [string]$Name, $Value)
  if ($null -eq $Object) { throw "Cannot set property $Name on null" }
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Ensure-JsonObject {
  param($Parent, [string]$Name)
  $Property = $Parent.PSObject.Properties[$Name]
  if ($null -eq $Property -or $null -eq $Property.Value -or $Property.Value -isnot [pscustomobject]) {
    $Value = [pscustomobject]@{}
    Set-JsonProperty -Object $Parent -Name $Name -Value $Value
    return $Value
  }
  return $Property.Value
}

function Get-JunctionTarget {
  param([string]$Path)
  $Item = Get-Item -LiteralPath $Path -Force
  if ($Item.LinkType -ne "Junction") { throw "Expected a Junction: $Path" }
  $Target = [string]($Item.Target | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($Target)) { throw "Junction has no target: $Path" }
  return Get-FullPath $Target
}

function Get-ReleaseIdFromPointer {
  param([string]$Path)
  return [string](Read-Json $Path).releaseId
}

function Get-LedgerState {
  param([string]$PythonPath, [string]$LedgerPath, [string]$BoundRouteId)
  if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "Probe Python not found: $PythonPath" }
  if (-not (Test-Path -LiteralPath $ProbeScript -PathType Leaf)) { throw "Ledger probe not found: $ProbeScript" }
  $Raw = & $PythonPath $ProbeScript ledger-state --ledger $LedgerPath --route-id $BoundRouteId
  if ($LASTEXITCODE -ne 0) { throw "Ledger probe failed with exit code $LASTEXITCODE" }
  return ($Raw -join "`n") | ConvertFrom-Json
}

function Get-CandidatePackageInfo {
  param([string]$PythonPath, [string]$ReleasePath)
  $Raw = & $PythonPath $ProbeScript package-info --expected-root $ReleasePath
  if ($LASTEXITCODE -ne 0) { throw "Candidate package probe failed with exit code $LASTEXITCODE" }
  return ($Raw -join "`n") | ConvertFrom-Json
}

function Compare-JsonValue {
  param($Left, $Right)
  return (($Left | ConvertTo-Json -Depth 30 -Compress) -eq ($Right | ConvertTo-Json -Depth 30 -Compress))
}

function Get-FileSha256 {
  param([string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-FixtureState {
  param([string]$Path)
  return Read-Json $Path
}

function Get-EndpointHealth {
  param([ValidateSet("Http", "Fixture")][string]$Mode, [string]$Name, [string]$FixtureStatePath)
  if ($Mode -eq "Http") {
    return Invoke-RestMethod -Method Get -Uri "$BrokerBaseUrl/health?endpoint=$Name&deep=1" -TimeoutSec 20
  }
  $State = Get-FixtureState $FixtureStatePath
  $Entry = $State.endpoints.PSObject.Properties[$Name].Value
  return [pscustomobject]@{
    ok = $true
    healthy = [bool]$Entry.healthy
    toolCount = [int]$Entry.toolCount
    pid = [int]$State.brokerPid
    backend = [pscustomobject]@{ pid = [int]$Entry.pid; generation = [int]$Entry.generation }
  }
}

function Wait-EndpointHealth {
  param(
    [ValidateSet("Http", "Fixture")][string]$Mode,
    [string]$Name,
    [int]$ToolCount,
    [string]$FixtureStatePath,
    [int]$MinimumGeneration = 0
  )
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try { $Health = Get-EndpointHealth -Mode $Mode -Name $Name -FixtureStatePath $FixtureStatePath } catch { $Health = $null }
    if ($null -ne $Health -and $Health.healthy -eq $true -and [int]$Health.toolCount -eq $ToolCount -and [int]$Health.backend.generation -ge $MinimumGeneration) {
      return $Health
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::UtcNow -lt $Deadline)
  throw "Endpoint did not become healthy: $Name"
}

function Invoke-BackendReload {
  param(
    [ValidateSet("Http", "Fixture")][string]$Mode,
    [string]$Name,
    [string]$PrivateEnvPath,
    [string]$FixtureStatePath,
    [int]$TargetToolCount,
    [switch]$FailFixtureHealth
  )
  $Before = Get-EndpointHealth -Mode $Mode -Name $Name -FixtureStatePath $FixtureStatePath
  if ($Mode -eq "Http") {
    $PrivateEnv = Read-Json $PrivateEnvPath
    $Token = [string]$PrivateEnv.CODEX_MCP_BROKER_CONTROL_TOKEN
    if ([string]::IsNullOrWhiteSpace($Token)) { throw "Broker control token is missing" }
    $Body = @{ endpoint = $Name; timeoutMs = $TimeoutSeconds * 1000 } | ConvertTo-Json -Compress
    $Result = Invoke-RestMethod -Method Post -Uri "$BrokerBaseUrl/__control/reload-backend" -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $Body -TimeoutSec ($TimeoutSeconds + 5)
    if ($Result.ok -ne $true -or [int]$Result.brokerPid -ne [int]$Before.pid) { throw "Scoped backend reload did not preserve the broker" }
    return $Result
  }
  $State = Get-FixtureState $FixtureStatePath
  $Entry = $State.endpoints.PSObject.Properties[$Name].Value
  $BeforeBackend = [pscustomobject]@{ pid = [int]$Entry.pid; generation = [int]$Entry.generation }
  Set-JsonProperty -Object $Entry -Name "pid" -Value ([int]$Entry.pid + 1)
  Set-JsonProperty -Object $Entry -Name "generation" -Value ([int]$Entry.generation + 1)
  Set-JsonProperty -Object $Entry -Name "toolCount" -Value $TargetToolCount
  Set-JsonProperty -Object $Entry -Name "healthy" -Value (-not $FailFixtureHealth)
  $Supervisor = Ensure-JsonObject -Parent $State -Name "supervisor"
  Set-JsonProperty -Object $Supervisor -Name "pid" -Value 7001
  Set-JsonProperty -Object $Supervisor -Name "healthy" -Value (-not $FailFixtureHealth)
  Set-JsonProperty -Object $Supervisor -Name "consecutiveFailures" -Value $(if ($FailFixtureHealth) { 1 } else { 0 })
  Set-JsonProperty -Object $Supervisor -Name "backendPid" -Value ([int]$Entry.pid)
  Set-JsonProperty -Object $Supervisor -Name "backendGeneration" -Value ([int]$Entry.generation)
  Write-JsonAtomic -Path $FixtureStatePath -Value $State
  return [pscustomobject]@{
    ok = $true
    brokerPid = [int]$State.brokerPid
    endpoint = $Name
    before = $BeforeBackend
    after = [pscustomobject]@{ pid = $null; generation = [int]$Entry.generation }
  }
}

function Get-SupervisorState {
  param([ValidateSet("Http", "Fixture")][string]$Mode, [string]$SupervisorPath, [string]$FixtureStatePath)
  if ($Mode -eq "Fixture") { return (Get-FixtureState $FixtureStatePath).supervisor }
  return Read-Json $SupervisorPath
}

function Wait-Supervisor {
  param(
    [ValidateSet("Http", "Fixture")][string]$Mode,
    [string]$SupervisorPath,
    [string]$FixtureStatePath,
    [int]$BackendPid,
    [int]$BackendGeneration
  )
  $Deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $State = Get-SupervisorState -Mode $Mode -SupervisorPath $SupervisorPath -FixtureStatePath $FixtureStatePath
    if ($State.healthy -eq $true -and [int]$State.consecutiveFailures -eq 0 -and [int]$State.backendPid -eq $BackendPid -and [int]$State.backendGeneration -eq $BackendGeneration) {
      return $State
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::UtcNow -lt $Deadline)
  throw "Supervisor did not converge on the expected backend"
}

function Update-ServiceManifest {
  param([string]$Path, [string]$ReleaseId, [string]$SourceCommit, $Health, $Supervisor)
  $Manifest = Read-Json $Path
  Set-JsonProperty -Object $Manifest -Name "schemaVersion" -Value 1
  Set-JsonProperty -Object $Manifest -Name "releaseId" -Value $ReleaseId
  Set-JsonProperty -Object $Manifest -Name "sourceCommit" -Value $SourceCommit
  Set-JsonProperty -Object $Manifest -Name "activated" -Value $true
  Set-JsonProperty -Object $Manifest -Name "currentSwitched" -Value $true
  Set-JsonProperty -Object $Manifest -Name "productionBrokerConnected" -Value $true
  $Validation = Ensure-JsonObject -Parent $Manifest -Name "validation"
  Set-JsonProperty -Object $Validation -Name "activeBackend" -Value ([pscustomobject]@{
    toolCount = [int]$Health.toolCount
    backendPid = [int]$Health.backend.pid
    generation = [int]$Health.backend.generation
  })
  Set-JsonProperty -Object $Validation -Name "supervisor" -Value ([pscustomobject]@{
    pid = [int]$Supervisor.pid
    healthy = [bool]$Supervisor.healthy
    consecutiveFailures = [int]$Supervisor.consecutiveFailures
  })
  Write-JsonAtomic -Path $Path -Value $Manifest
  return $Manifest
}

function New-ReleasePointer {
  param([string]$ReleaseId, [string]$ReleasePath, [string]$SourceCommit, [bool]$Activated, [string]$Reason)
  return [pscustomobject]@{
    schemaVersion = 1
    releaseId = $ReleaseId
    releasePath = $ReleasePath
    sourceCommit = $SourceCommit
    activated = $Activated
    reason = $Reason
  }
}

function Copy-ActivationBackup {
  param([string]$BackupRoot, [string]$PointersRoot, [string]$RuntimePath, [string]$PrivateEnvPath, [string]$ManifestPath, [string]$CurrentTarget)
  New-Item -ItemType Directory -Path (Join-Path $BackupRoot "pointers") -Force | Out-Null
  foreach ($Name in @("active.json", "candidate.json", "last-known-good.json")) {
    Copy-Item -LiteralPath (Join-Path $PointersRoot $Name) -Destination (Join-Path $BackupRoot "pointers\$Name")
  }
  Copy-Item -LiteralPath $RuntimePath -Destination (Join-Path $BackupRoot "service-runtime.json")
  Copy-Item -LiteralPath $PrivateEnvPath -Destination (Join-Path $BackupRoot "broker-private.env.json")
  Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $BackupRoot "candidate-manifest.json")
  [System.IO.File]::WriteAllText((Join-Path $BackupRoot "current-target.txt"), $CurrentTarget + "`n", $Utf8NoBom)
}

function Restore-ActivationFiles {
  param([string]$BackupRoot, [string]$PointersRoot, [string]$RuntimePath, [string]$PrivateEnvPath, [string]$ManifestPath)
  foreach ($Name in @("active.json", "candidate.json", "last-known-good.json")) {
    Copy-Item -LiteralPath (Join-Path $BackupRoot "pointers\$Name") -Destination (Join-Path $PointersRoot $Name) -Force
  }
  Copy-Item -LiteralPath (Join-Path $BackupRoot "service-runtime.json") -Destination $RuntimePath -Force
  Copy-Item -LiteralPath (Join-Path $BackupRoot "broker-private.env.json") -Destination $PrivateEnvPath -Force
  Copy-Item -LiteralPath (Join-Path $BackupRoot "candidate-manifest.json") -Destination $ManifestPath -Force
}

function Restore-ReleaseSwitch {
  param($Context, [switch]$Automatic)
  if (Test-Path -LiteralPath $Context.currentPath) {
    [System.IO.Directory]::Move($Context.currentPath, $Context.failedLinkPath)
  }
  if (-not (Test-Path -LiteralPath $Context.previousLinkPath)) { throw "Previous Junction is missing during rollback" }
  [System.IO.Directory]::Move($Context.previousLinkPath, $Context.currentPath)
  Restore-ActivationFiles -BackupRoot $Context.backupRoot -PointersRoot $Context.pointersRoot -RuntimePath $Context.runtimePath -PrivateEnvPath $Context.privateEnvPath -ManifestPath $Context.manifestPath
  Invoke-BackendReload -Mode $Context.mode -Name $Endpoint -PrivateEnvPath $Context.privateEnvPath -FixtureStatePath $Context.fixtureStatePath -TargetToolCount $Context.expectedCurrentToolCount | Out-Null
  $Health = Wait-EndpointHealth -Mode $Context.mode -Name $Endpoint -ToolCount $Context.expectedCurrentToolCount -FixtureStatePath $Context.fixtureStatePath
  $Supervisor = Wait-Supervisor -Mode $Context.mode -SupervisorPath $Context.supervisorPath -FixtureStatePath $Context.fixtureStatePath -BackendPid ([int]$Health.backend.pid) -BackendGeneration ([int]$Health.backend.generation)
  $ProtectedHealth = Wait-EndpointHealth -Mode $Context.mode -Name $ProtectedEndpoint -ToolCount $ExpectedProtectedToolCount -FixtureStatePath $Context.fixtureStatePath
  $Ledger = Get-LedgerState -PythonPath $Context.probePython -LedgerPath $Context.ledgerPath -BoundRouteId $Context.routeId
  $ActiveRelease = Get-ReleaseIdFromPointer (Join-Path $Context.pointersRoot "active.json")
  $CandidateRelease = Get-ReleaseIdFromPointer (Join-Path $Context.pointersRoot "candidate.json")
  $LastKnownGood = Get-ReleaseIdFromPointer (Join-Path $Context.pointersRoot "last-known-good.json")
  $RestoredFiles = @(
    [pscustomobject]@{ current = Join-Path $Context.pointersRoot "active.json"; backup = Join-Path $Context.backupRoot "pointers\active.json" }
    [pscustomobject]@{ current = Join-Path $Context.pointersRoot "candidate.json"; backup = Join-Path $Context.backupRoot "pointers\candidate.json" }
    [pscustomobject]@{ current = Join-Path $Context.pointersRoot "last-known-good.json"; backup = Join-Path $Context.backupRoot "pointers\last-known-good.json" }
    [pscustomobject]@{ current = $Context.runtimePath; backup = Join-Path $Context.backupRoot "service-runtime.json" }
    [pscustomobject]@{ current = $Context.privateEnvPath; backup = Join-Path $Context.backupRoot "broker-private.env.json" }
    [pscustomobject]@{ current = $Context.manifestPath; backup = Join-Path $Context.backupRoot "candidate-manifest.json" }
  )
  $FilesRestoredExactly = @($RestoredFiles | Where-Object { (Get-FileSha256 $_.current) -ne (Get-FileSha256 $_.backup) }).Count -eq 0
  $ProtectedBackendStable = (
    [int]$ProtectedHealth.pid -eq $Context.beforeBrokerPid -and
    [int]$ProtectedHealth.backend.pid -eq $Context.beforeProtectedBackendPid -and
    [int]$ProtectedHealth.backend.generation -eq $Context.beforeProtectedBackendGeneration
  )
  $Result = [pscustomobject]@{
    verified = ((Get-JunctionTarget $Context.currentPath) -eq $Context.previousTarget -and $ActiveRelease -eq $Context.expectedCurrentReleaseId -and $CandidateRelease -eq $Context.beforeCandidateReleaseId -and $LastKnownGood -eq $Context.expectedCurrentReleaseId -and (Compare-JsonValue $Ledger $Context.beforeLedger) -and $ProtectedBackendStable -and $FilesRestoredExactly)
    automatic = [bool]$Automatic
    currentTarget = Get-JunctionTarget $Context.currentPath
    activeReleaseId = $ActiveRelease
    candidateReleaseId = $CandidateRelease
    lastKnownGoodReleaseId = $LastKnownGood
    filesRestoredExactly = $FilesRestoredExactly
    protectedBackendStable = $ProtectedBackendStable
    ledger = $Ledger
    backendGeneration = [int]$Health.backend.generation
    supervisorGeneration = [int]$Supervisor.backendGeneration
    protectedBackendGeneration = [int]$ProtectedHealth.backend.generation
  }
  Write-JsonAtomic -Path (Join-Path $Context.backupRoot "rollback-verification.json") -Value $Result
  if ($Result.verified -ne $true) { throw "Rollback verification failed" }
  return $Result
}

function Invoke-ReleaseSwitch {
  param(
    [ValidateSet("Http", "Fixture")][string]$Mode,
    [string]$SwitchServiceRoot,
    [string]$SwitchDataRoot,
    [string]$SwitchBrokerRoot,
    [string]$SwitchCandidateReleaseId,
    [string]$SwitchExpectedCurrentReleaseId,
    [string]$SwitchRouteId,
    [string]$SwitchProbePython,
    [string]$FixtureStatePath,
    [switch]$FailFixtureHealth
  )
  $Service = Get-FullPath $SwitchServiceRoot
  $Data = Get-FullPath $SwitchDataRoot
  $ReleasesRoot = Join-Path $Service "releases"
  $PointersRoot = Join-Path $Service "pointers"
  $CurrentPath = Join-Path $Service "current"
  $CandidatePath = Join-Path $ReleasesRoot $SwitchCandidateReleaseId
  $RuntimePath = Join-Path $Data "config\service-runtime.json"
  $PrivateEnvPath = Join-Path $SwitchBrokerRoot "broker-private.env.json"
  $LedgerPath = Join-Path $Data "state\events.sqlite3"
  $SupervisorPath = Join-Path $Data "state\supervisor-runtime.json"
  $ManifestPath = Join-Path $CandidatePath "service-manifest.json"
  $Stamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMdd-HHmmss-fff") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
  $BackupRoot = Join-Path $Data "backups\release-switch-$Stamp"
  $PreviousLinkPath = Join-Path $Service "current.before-$Stamp"
  $NextLinkPath = Join-Path $Service "current.next-$Stamp"
  $FailedLinkPath = Join-Path $Service "current.failed-$Stamp"

  Assert-ChildPath -Path $CandidatePath -Parent $ReleasesRoot -Label "Candidate release"
  foreach ($Path in @($BackupRoot, $PreviousLinkPath, $NextLinkPath, $FailedLinkPath)) {
    if (Test-Path -LiteralPath $Path) { throw "Activation path already exists: $Path" }
  }
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Candidate manifest is missing: $ManifestPath" }
  $PreviousTarget = Get-JunctionTarget $CurrentPath
  Assert-ChildPath -Path $PreviousTarget -Parent $ReleasesRoot -Label "Current release"
  if ((Split-Path -Leaf $PreviousTarget) -ne $SwitchExpectedCurrentReleaseId) { throw "Current Junction does not match the expected release" }
  if ((Get-ReleaseIdFromPointer (Join-Path $PointersRoot "active.json")) -ne $SwitchExpectedCurrentReleaseId) { throw "Active pointer does not match the expected release" }
  if ((Get-ReleaseIdFromPointer (Join-Path $PointersRoot "last-known-good.json")) -ne $SwitchExpectedCurrentReleaseId) { throw "Last-known-good pointer does not match the expected release" }
  $BeforeCandidateReleaseId = Get-ReleaseIdFromPointer (Join-Path $PointersRoot "candidate.json")

  $CandidateManifest = Read-Json $ManifestPath
  $SourceCommit = [string]$CandidateManifest.sourceCommit
  if ([string]::IsNullOrWhiteSpace($SourceCommit)) { throw "Candidate sourceCommit is missing" }
  $PackageInfo = $null
  if ($Mode -eq "Http") {
    $PackageInfo = Get-CandidatePackageInfo -PythonPath $SwitchProbePython -ReleasePath $CandidatePath
    if ($PackageInfo.inside_release -ne $true -or [int]$PackageInfo.tool_count -ne $ExpectedToolCount) { throw "Candidate package does not resolve from the final release path" }
  }
  $BeforeLedger = Get-LedgerState -PythonPath $SwitchProbePython -LedgerPath $LedgerPath -BoundRouteId $SwitchRouteId
  $BeforeHealth = Wait-EndpointHealth -Mode $Mode -Name $Endpoint -ToolCount $ExpectedCurrentToolCount -FixtureStatePath $FixtureStatePath
  $BeforeProtectedHealth = Wait-EndpointHealth -Mode $Mode -Name $ProtectedEndpoint -ToolCount $ExpectedProtectedToolCount -FixtureStatePath $FixtureStatePath
  Copy-ActivationBackup -BackupRoot $BackupRoot -PointersRoot $PointersRoot -RuntimePath $RuntimePath -PrivateEnvPath $PrivateEnvPath -ManifestPath $ManifestPath -CurrentTarget $PreviousTarget

  $Context = [pscustomobject]@{
    mode = $Mode
    serviceRoot = $Service
    dataRoot = $Data
    pointersRoot = $PointersRoot
    currentPath = $CurrentPath
    runtimePath = $RuntimePath
    privateEnvPath = $PrivateEnvPath
    manifestPath = $ManifestPath
    supervisorPath = $SupervisorPath
    ledgerPath = $LedgerPath
    routeId = $SwitchRouteId
    probePython = $SwitchProbePython
    fixtureStatePath = $FixtureStatePath
    expectedCurrentReleaseId = $SwitchExpectedCurrentReleaseId
    candidateReleaseId = $SwitchCandidateReleaseId
    beforeCandidateReleaseId = $BeforeCandidateReleaseId
    candidatePath = $CandidatePath
    previousTarget = $PreviousTarget
    backupRoot = $BackupRoot
    previousLinkPath = $PreviousLinkPath
    failedLinkPath = $FailedLinkPath
    beforeLedger = $BeforeLedger
    beforeBrokerPid = [int]$BeforeHealth.pid
    beforeBackendGeneration = [int]$BeforeHealth.backend.generation
    expectedCurrentToolCount = [int]$ExpectedCurrentToolCount
    beforeProtectedBackendPid = [int]$BeforeProtectedHealth.backend.pid
    beforeProtectedBackendGeneration = [int]$BeforeProtectedHealth.backend.generation
  }

  $Switched = $false
  try {
    New-Item -ItemType Junction -Path $NextLinkPath -Target $CandidatePath | Out-Null
    [System.IO.Directory]::Move($CurrentPath, $PreviousLinkPath)
    try {
      [System.IO.Directory]::Move($NextLinkPath, $CurrentPath)
      $Switched = $true
    } catch {
      [System.IO.Directory]::Move($PreviousLinkPath, $CurrentPath)
      throw
    }

    $Runtime = Read-Json $RuntimePath
    Set-JsonProperty -Object $Runtime -Name "releaseId" -Value $SwitchCandidateReleaseId
    Set-JsonProperty -Object $Runtime -Name "sourceCommit" -Value $SourceCommit
    Write-JsonAtomic -Path $RuntimePath -Value $Runtime

    $PrivateEnv = Read-Json $PrivateEnvPath
    Set-JsonProperty -Object $PrivateEnv -Name "WECHAT_DOCS_MCP_ROOT" -Value $CurrentPath
    Set-JsonProperty -Object $PrivateEnv -Name "WECHAT_DOCS_MCP_PYTHON" -Value (Join-Path $CurrentPath "env\Scripts\python.exe")
    Write-JsonAtomic -Path $PrivateEnvPath -Value $PrivateEnv

    Invoke-BackendReload -Mode $Mode -Name $Endpoint -PrivateEnvPath $PrivateEnvPath -FixtureStatePath $FixtureStatePath -TargetToolCount $ExpectedToolCount -FailFixtureHealth:$FailFixtureHealth | Out-Null
    $Health = Wait-EndpointHealth -Mode $Mode -Name $Endpoint -ToolCount $ExpectedToolCount -FixtureStatePath $FixtureStatePath -MinimumGeneration ($Context.beforeBackendGeneration + 1)
    $Supervisor = Wait-Supervisor -Mode $Mode -SupervisorPath $SupervisorPath -FixtureStatePath $FixtureStatePath -BackendPid ([int]$Health.backend.pid) -BackendGeneration ([int]$Health.backend.generation)
    $ProtectedHealth = Wait-EndpointHealth -Mode $Mode -Name $ProtectedEndpoint -ToolCount $ExpectedProtectedToolCount -FixtureStatePath $FixtureStatePath -MinimumGeneration $Context.beforeProtectedBackendGeneration
    if ([int]$ProtectedHealth.pid -ne [int]$BeforeProtectedHealth.pid -or [int]$ProtectedHealth.backend.pid -ne [int]$BeforeProtectedHealth.backend.pid -or [int]$ProtectedHealth.backend.generation -ne [int]$BeforeProtectedHealth.backend.generation) {
      throw "Protected endpoint changed during the WeChat release switch"
    }
    $AfterLedger = Get-LedgerState -PythonPath $SwitchProbePython -LedgerPath $LedgerPath -BoundRouteId $SwitchRouteId
    if (-not (Compare-JsonValue $BeforeLedger $AfterLedger)) { throw "Ledger state changed during the release switch" }

    $UpdatedManifest = Update-ServiceManifest -Path (Join-Path $CurrentPath "service-manifest.json") -ReleaseId $SwitchCandidateReleaseId -SourceCommit $SourceCommit -Health $Health -Supervisor $Supervisor
    $Pointer = New-ReleasePointer -ReleaseId $SwitchCandidateReleaseId -ReleasePath $CandidatePath -SourceCommit $SourceCommit -Activated $true -Reason "Scoped reload, ledger persistence and supervisor health verified"
    foreach ($Name in @("active.json", "candidate.json", "last-known-good.json")) { Write-JsonAtomic -Path (Join-Path $PointersRoot $Name) -Value $Pointer }
    foreach ($Name in @("active.json", "candidate.json", "last-known-good.json")) {
      if ((Get-ReleaseIdFromPointer (Join-Path $PointersRoot $Name)) -ne $SwitchCandidateReleaseId) { throw "Pointer verification failed: $Name" }
    }

    $Result = [pscustomobject]@{
      status = "activated"
      releaseId = $SwitchCandidateReleaseId
      sourceCommit = $SourceCommit
      backupRoot = $BackupRoot
      previousLinkPath = $PreviousLinkPath
      backendPid = [int]$Health.backend.pid
      backendGeneration = [int]$Health.backend.generation
      protectedBackendGeneration = [int]$ProtectedHealth.backend.generation
      ledger = $AfterLedger
      manifestActiveBackend = $UpdatedManifest.validation.activeBackend
      packageInfo = $PackageInfo
    }
    Set-JsonProperty -Object $Context -Name "activationResult" -Value $Result
    Write-JsonAtomic -Path (Join-Path $BackupRoot "activation-verification.json") -Value $Result
    return $Context
  } catch {
    $Failure = $_.Exception.Message
    if ($Switched) {
      $Rollback = Restore-ReleaseSwitch -Context $Context -Automatic
      throw "Activation failed after verified rollback: $Failure; rollbackGeneration=$($Rollback.backendGeneration)"
    }
    throw
  }
}

if ($Action -eq "Drill") {
  Invoke-Drill | ConvertTo-Json -Depth 20
  return
}

if (-not $ConfirmProductionActivation) { throw "Activate requires -ConfirmProductionActivation" }
foreach ($Required in @($CandidateReleaseId, $ExpectedCurrentReleaseId, $RouteId)) {
  if ([string]::IsNullOrWhiteSpace($Required)) { throw "Activate requires CandidateReleaseId, ExpectedCurrentReleaseId and RouteId" }
}
if ([string]::IsNullOrWhiteSpace($ProbePython)) { $ProbePython = Join-Path $ServiceRoot "releases\$CandidateReleaseId\env\Scripts\python.exe" }
$Context = Invoke-ReleaseSwitch -Mode Http -SwitchServiceRoot $ServiceRoot -SwitchDataRoot $DataRoot -SwitchBrokerRoot $BrokerRoot -SwitchCandidateReleaseId $CandidateReleaseId -SwitchExpectedCurrentReleaseId $ExpectedCurrentReleaseId -SwitchRouteId $RouteId -SwitchProbePython $ProbePython -FixtureStatePath ""
$Context.activationResult | ConvertTo-Json -Depth 20
