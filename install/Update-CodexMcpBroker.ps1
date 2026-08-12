[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SourceBrokerRoot,
    [string]$BrokerRoot,
    [string]$ServiceManifestPath,
    [string[]]$DeepHealthEndpoints = @("napcat", "sandbox"),
    [string[]]$ProtectedStatePaths = @(),
    [string[]]$TaskRouterRuntimeStatePaths = @(),
    [ValidateRange(1, 120)][int]$StartupTimeoutSeconds = 30,
    [ValidateRange(1024, 65535)][int]$BrokerPort = 14588
)

$ErrorActionPreference = "Stop"
$InstallerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BrokerRootWasBound = $PSBoundParameters.ContainsKey("BrokerRoot")
$ServiceManifestPathWasBound = $PSBoundParameters.ContainsKey("ServiceManifestPath")
if (-not $SourceBrokerRoot) {
    $FlatPackageBrokerRoot = Join-Path $InstallerRoot "broker"
    $ToolkitBrokerRoot = Join-Path (Split-Path -Parent $InstallerRoot) "mcps\broker"
    $SourceBrokerRoot = if (Test-Path -LiteralPath (Join-Path $FlatPackageBrokerRoot "broker.mjs") -PathType Leaf) {
        $FlatPackageBrokerRoot
    } else {
        $ToolkitBrokerRoot
    }
}
$SourceBrokerRoot = [System.IO.Path]::GetFullPath($SourceBrokerRoot)
$SourceBrokerPath = Join-Path $SourceBrokerRoot "broker.mjs"
$SourceEndpointConfigPath = Join-Path $SourceBrokerRoot "endpoint-config.mjs"
$SourceLifecyclePath = Join-Path $SourceBrokerRoot "request-lifecycle.mjs"
$SourceStopScript = Join-Path $InstallerRoot "Stop-CodexMcpBroker.ps1"
$SourceStartScript = Join-Path $InstallerRoot "Start-CodexMcpBroker.ps1"
$ConfiguredServiceManifestPath = if ($ServiceManifestPathWasBound) {
    $ServiceManifestPath
} elseif (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST)) {
    [string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST
} else {
    Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
}
$ConfiguredServiceManifestPath = [System.IO.Path]::GetFullPath($ConfiguredServiceManifestPath)
$ManagedStartScript = $null
$ManagedStopScript = $null
$ManagedNodeExe = $null
$ManagedBrokerPath = $null
if (-not $BrokerRootWasBound -and (Test-Path -LiteralPath $ConfiguredServiceManifestPath -PathType Leaf)) {
    try {
        $ServiceManifest = Get-Content -LiteralPath $ConfiguredServiceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $ManifestBrokerScript = [string]$ServiceManifest.broker.brokerScript
        $ManifestStartScript = [string]$ServiceManifest.broker.startScript
        $ManifestStopScript = [string]$ServiceManifest.broker.stopScript
        $ManifestNodeExe = [string]$ServiceManifest.broker.nodeExe
        if ([string]::IsNullOrWhiteSpace($ManifestBrokerScript) -or [string]::IsNullOrWhiteSpace($ManifestStartScript) -or [string]::IsNullOrWhiteSpace($ManifestStopScript)) {
            throw "Managed broker service manifest must record broker.brokerScript, broker.startScript, and broker.stopScript."
        }
        $ManagedBrokerPath = [System.IO.Path]::GetFullPath($ManifestBrokerScript)
        $ManagedStartScript = [System.IO.Path]::GetFullPath($ManifestStartScript)
        $ManagedStopScript = [System.IO.Path]::GetFullPath($ManifestStopScript)
        if (-not [string]::IsNullOrWhiteSpace($ManifestNodeExe)) {
            $ManagedNodeExe = [System.IO.Path]::GetFullPath($ManifestNodeExe)
        }
        $BrokerRoot = Split-Path -Parent $ManagedBrokerPath
    } catch {
        throw "Cannot resolve the managed broker from $ConfiguredServiceManifestPath. $($_.Exception.Message)"
    }
} elseif ($ServiceManifestPathWasBound -and -not (Test-Path -LiteralPath $ConfiguredServiceManifestPath -PathType Leaf)) {
    throw "Managed broker service manifest is missing: $ConfiguredServiceManifestPath"
}
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) {
    $BrokerRoot = Join-Path $env:USERPROFILE ".codex\mcp-http-broker"
}
$BrokerRoot = [System.IO.Path]::GetFullPath($BrokerRoot)
$InstalledBrokerPath = if ($ManagedBrokerPath) { $ManagedBrokerPath } else { Join-Path $BrokerRoot "broker.mjs" }
$InstalledEndpointConfigPath = Join-Path $BrokerRoot "endpoint-config.mjs"
$InstalledLifecyclePath = Join-Path $BrokerRoot "request-lifecycle.mjs"
$StopScript = if ($ManagedStopScript) { $ManagedStopScript } else { Join-Path $BrokerRoot "Stop-CodexMcpBroker.ps1" }
$StartScript = if ($ManagedStartScript) { $ManagedStartScript } else { Join-Path $BrokerRoot "Start-CodexMcpBroker.ps1" }
$HealthUrl = "http://127.0.0.1:$BrokerPort/health"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$BackupRoot = Join-Path $BrokerRoot "backups\broker-update-$Stamp"

function Get-FileHashOrNull {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $Stream = [System.IO.File]::OpenRead($Path)
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "")
        } finally {
            $Hasher.Dispose()
        }
    } finally {
        $Stream.Dispose()
    }
}

function Get-NormalizedFilePath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "State path cannot be empty." }
    return [System.IO.Path]::GetFullPath($Path)
}

function Get-CanonicalExistingPath {
    param([string]$Path)
    $FullPath = Get-NormalizedFilePath -Path $Path
    $Item = Get-Item -LiteralPath $FullPath -Force -ErrorAction Stop
    return [System.IO.Path]::GetFullPath([string]$Item.FullName)
}

function Get-CommandLineTokens {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    return @([regex]::Matches($CommandLine, '(?:^|\s)(?:"((?:\\.|[^"])*)"|(\S+))') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
}

function Get-UniqueCommandLineOptionValue {
    param(
        [string[]]$Tokens,
        [string]$OptionName
    )
    $Values = [System.Collections.Generic.List[string]]::new()
    for ($Index = 0; $Index -lt $Tokens.Count; $Index++) {
        if ($Tokens[$Index].Equals($OptionName, [System.StringComparison]::OrdinalIgnoreCase)) {
            if ($Index + 1 -ge $Tokens.Count) { throw "Task router command line option has no value: $OptionName" }
            $Values.Add($Tokens[$Index + 1])
        } elseif ($Tokens[$Index].StartsWith("$OptionName=", [System.StringComparison]::OrdinalIgnoreCase)) {
            $Values.Add($Tokens[$Index].Substring($OptionName.Length + 1))
        }
    }
    if ($Values.Count -ne 1 -or [string]::IsNullOrWhiteSpace($Values[0])) {
        throw "Task router command line must contain exactly one $OptionName option."
    }
    return $Values[0]
}

function Assert-EquivalentExistingPath {
    param(
        [string]$ActualPath,
        [string]$ExpectedPath,
        [string]$Description
    )
    $ActualCanonical = Get-CanonicalExistingPath -Path $ActualPath
    $ExpectedCanonical = Get-CanonicalExistingPath -Path $ExpectedPath
    if (-not $ActualCanonical.Equals($ExpectedCanonical, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description path does not match. expected=$ExpectedCanonical actual=$ActualCanonical"
    }
}

function Get-TaskRouterRuntimeSnapshot {
    param([string]$Path)
    $FullPath = Get-NormalizedFilePath -Path $Path
    if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        throw "Task router runtime state is missing: $FullPath"
    }
    try {
        $Runtime = Get-Content -LiteralPath $FullPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Cannot parse task router runtime state: $FullPath. $($_.Exception.Message)"
    }
    $ProcessId = 0
    $SchemaVersion = 0
    $ScanIntervalMs = 0
    $OpenTaskCount = 0
    $UpdatedAt = [DateTimeOffset]::MinValue
    if (-not [int]::TryParse([string]$Runtime.pid, [ref]$ProcessId) -or $ProcessId -le 0) {
        throw "Task router runtime state has an invalid PID: $FullPath"
    }
    if (-not [int]::TryParse([string]$Runtime.schemaVersion, [ref]$SchemaVersion) -or $SchemaVersion -le 0) {
        throw "Task router runtime state has an invalid schemaVersion: $FullPath"
    }
    if (-not [int]::TryParse([string]$Runtime.scanIntervalMs, [ref]$ScanIntervalMs) -or $ScanIntervalMs -le 0) {
        throw "Task router runtime state has an invalid scanIntervalMs: $FullPath"
    }
    if (-not [int]::TryParse([string]$Runtime.openTaskCount, [ref]$OpenTaskCount) -or $OpenTaskCount -lt 0) {
        throw "Task router runtime state has an invalid openTaskCount: $FullPath"
    }
    if (-not [DateTimeOffset]::TryParse([string]$Runtime.updatedAt, [ref]$UpdatedAt)) {
        throw "Task router runtime state has an invalid updatedAt: $FullPath"
    }
    if ($Runtime.keepAlive -isnot [bool]) {
        throw "Task router runtime state has an invalid keepAlive flag: $FullPath"
    }
    foreach ($RequiredField in @("startedAt", "stopFilePath", "lockPath", "instanceToken")) {
        if ([string]::IsNullOrWhiteSpace([string]$Runtime.$RequiredField)) {
            throw "Task router runtime state is missing identity field '$RequiredField': $FullPath"
        }
    }
    if (-not [System.IO.Path]::IsPathRooted([string]$Runtime.stopFilePath) -or -not [System.IO.Path]::IsPathRooted([string]$Runtime.lockPath)) {
        throw "Task router runtime state must use absolute stop and lock paths: $FullPath"
    }
    $Snapshot = [pscustomobject]@{
        path = $FullPath
        identity = [pscustomobject][ordered]@{
            schemaVersion = $SchemaVersion
            pid = $ProcessId
            startedAt = [string]$Runtime.startedAt
            stopFilePath = [System.IO.Path]::GetFullPath([string]$Runtime.stopFilePath)
            lockPath = [System.IO.Path]::GetFullPath([string]$Runtime.lockPath)
            scanIntervalMs = $ScanIntervalMs
            instanceToken = [string]$Runtime.instanceToken
        }
        health = [pscustomobject][ordered]@{
            state = [string]$Runtime.state
            lastError = $Runtime.lastError
            inFlightScan = $Runtime.inFlightScan
            maintenance = $Runtime.maintenance
        }
        volatile = [pscustomobject][ordered]@{
            lastScanAt = $Runtime.lastScanAt
            nextScanAt = $Runtime.nextScanAt
            updatedAt = $Runtime.updatedAt
            openTaskCount = $OpenTaskCount
            keepAlive = [bool]$Runtime.keepAlive
        }
    }
    if ($Snapshot.health.state -ne "running") { throw "Task router is not running: $FullPath state=$($Snapshot.health.state)" }
    if (-not [string]::IsNullOrWhiteSpace([string]$Snapshot.health.lastError)) { throw "Task router reports an error: $FullPath error=$($Snapshot.health.lastError)" }
    if ($Snapshot.health.inFlightScan -ne $false) { throw "Task router has an in-flight scan: $FullPath" }
    if ($null -ne $Snapshot.health.maintenance) { throw "Task router is in maintenance: $FullPath" }
    $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $ProcessInfo -or [string]$ProcessInfo.Name -ne "node.exe") {
        throw "Task router PID is not a running Node process: $FullPath pid=$ProcessId"
    }
    $CommandLine = [string]$ProcessInfo.CommandLine
    $CommandTokens = @(Get-CommandLineTokens -CommandLine $CommandLine)
    $RunnerPaths = @($CommandTokens | ForEach-Object {
        if ([System.IO.Path]::IsPathRooted($_)) {
            try {
                $CanonicalPath = Get-CanonicalExistingPath -Path $_
                if ([System.IO.Path]::GetFileName($CanonicalPath).Equals("task-router-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase)) {
                    $CanonicalPath
                }
            } catch {}
        }
    })
    if ($RunnerPaths.Count -ne 1) {
        throw "Task router command line does not identify exactly one task-router-runner.mjs: $FullPath pid=$ProcessId actual=$CommandLine"
    }
    $RuntimeArgument = Get-UniqueCommandLineOptionValue -Tokens $CommandTokens -OptionName "--runtime-state"
    $LockArgument = Get-UniqueCommandLineOptionValue -Tokens $CommandTokens -OptionName "--lock"
    try {
        Assert-EquivalentExistingPath -ActualPath $RuntimeArgument -ExpectedPath $FullPath -Description "Task router runtime-state"
        Assert-EquivalentExistingPath -ActualPath $LockArgument -ExpectedPath $Snapshot.identity.lockPath -Description "Task router lock"
    } catch {
        throw "Task router command line does not match its runtime identity: $FullPath pid=$ProcessId actual=$CommandLine. $($_.Exception.Message)"
    }
    if (-not (Test-Path -LiteralPath $Snapshot.identity.lockPath -PathType Leaf)) {
        throw "Task router lock file is missing: $($Snapshot.identity.lockPath)"
    }
    try {
        $LockState = Get-Content -LiteralPath $Snapshot.identity.lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Cannot parse task router lock state: $($Snapshot.identity.lockPath). $($_.Exception.Message)"
    }
    if ([int]$LockState.pid -ne $ProcessId -or [string]$LockState.token -cne $Snapshot.identity.instanceToken) {
        throw "Task router lock identity does not match runtime state: $FullPath"
    }
    return $Snapshot
}

function Assert-TaskRouterRuntimeUnchanged {
    param(
        [object]$Before,
        [object]$After
    )
    foreach ($Field in @("schemaVersion", "pid", "startedAt", "scanIntervalMs", "instanceToken")) {
        if ($Before.identity.$Field -cne $After.identity.$Field) {
            throw "Task router runtime identity changed: $($Before.path) field=$Field before=$($Before.identity.$Field) after=$($After.identity.$Field)"
        }
    }
    foreach ($Field in @("stopFilePath", "lockPath")) {
        if (-not ([string]$Before.identity.$Field).Equals([string]$After.identity.$Field, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Task router runtime identity changed: $($Before.path) field=$Field before=$($Before.identity.$Field) after=$($After.identity.$Field)"
        }
    }
}

function Get-NodeEntryScript {
    param([string]$CommandLine)
    $Tokens = @(Get-CommandLineTokens -CommandLine $CommandLine)
    if ($Tokens.Count -lt 2) { return $null }
    $Candidate = $Tokens[1]
    if (-not [System.IO.Path]::IsPathRooted($Candidate)) { return $null }
    return [System.IO.Path]::GetFullPath($Candidate)
}

function Get-BrokerProcessIdentity {
    param([int]$ProcessId)
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $Process -or $Process.ProcessName -ne "node") { return $null }
    $CimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $CimProcess) { return $null }
    [pscustomobject]@{
        pid = $ProcessId
        entryScript = Get-NodeEntryScript -CommandLine ([string]$CimProcess.CommandLine)
        commandLine = [string]$CimProcess.CommandLine
    }
}

function Assert-BrokerHealthIdentity {
    param(
        [object]$Health,
        [string]$ExpectedBrokerPath,
        [string]$Stage
    )
    if (-not $Health -or $Health.ok -ne $true -or -not $Health.pid) {
        throw "$Stage broker health did not return ok=true with a PID."
    }
    $Identity = Get-BrokerProcessIdentity -ProcessId ([int]$Health.pid)
    if (-not $Identity -or -not $Identity.entryScript) {
        throw "$Stage broker health PID $($Health.pid) is not a readable Node broker process."
    }
    $ExpectedPath = [System.IO.Path]::GetFullPath($ExpectedBrokerPath)
    if (-not $Identity.entryScript.Equals($ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Stage broker health belongs to a different script. expected=$ExpectedPath actual=$($Identity.entryScript) pid=$($Identity.pid)"
    }
    return $Identity
}

function Wait-BrokerProcessExit {
    param(
        [int]$ProcessId,
        [int]$TimeoutMilliseconds = 5000
    )
    $Deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Timed out waiting for broker process to exit: PID $ProcessId"
}

function Stop-TargetBrokerProcesses {
    param([string]$ExpectedBrokerPath)
    $ExpectedPath = [System.IO.Path]::GetFullPath($ExpectedBrokerPath)
    $Targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $EntryScript = Get-NodeEntryScript -CommandLine ([string]$_.CommandLine)
        $EntryScript -and $EntryScript.Equals($ExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($Target in $Targets) {
        & taskkill.exe /PID $Target.ProcessId /T /F | Out-Null
        Wait-BrokerProcessExit -ProcessId ([int]$Target.ProcessId)
    }
}

function Test-TcpPortAccepting {
    param([int]$Port)
    $Listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return [bool]@($Listeners | Where-Object { $_.Port -eq $Port }).Count
}

function Wait-BrokerPortReleased {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 5
    )
    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $ConsecutiveRefusals = 0
    do {
        if (Test-TcpPortAccepting -Port $Port) {
            $ConsecutiveRefusals = 0
        } else {
            $ConsecutiveRefusals++
            if ($ConsecutiveRefusals -ge 3) { return }
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Broker port did not become continuously free within $TimeoutSeconds seconds: 127.0.0.1:$Port"
}

function Save-CandidateStartupEvidence {
    param(
        [string[]]$StartOutput,
        [int]$CandidateProcessId = 0
    )
    if ($StartOutput) {
        $StartOutput | Set-Content -LiteralPath (Join-Path $BackupRoot "candidate-start-output.txt") -Encoding UTF8
    }
    if ($CandidateProcessId) {
        $Identity = Get-BrokerProcessIdentity -ProcessId $CandidateProcessId
        [pscustomobject]@{
            pid = $CandidateProcessId
            observedAt = [DateTimeOffset]::Now.ToString("o")
            alive = [bool](Get-Process -Id $CandidateProcessId -ErrorAction SilentlyContinue)
            entryScript = if ($Identity) { $Identity.entryScript } else { $null }
            commandLine = if ($Identity) { $Identity.commandLine } else { $null }
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $BackupRoot "candidate-process.json") -Encoding UTF8
    }
}

function Copy-CandidateRuntimeLogs {
    $DataRoot = if (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_DATA_ROOT)) {
        [System.IO.Path]::GetFullPath([string]$env:CODEX_TOOLKIT_DATA_ROOT)
    } else {
        Join-Path $env:USERPROFILE ".codex-toolkit"
    }
    $RuntimeRoot = if ($ManagedStartScript) { Join-Path $DataRoot "mcp-http-broker" } else { $BrokerRoot }
    foreach ($Name in @("broker-stdout.log", "broker-stderr.log", "broker.log", "broker-state.json")) {
        $SourcePath = Join-Path $RuntimeRoot $Name
        if (Test-Path -LiteralPath $SourcePath -PathType Leaf) {
            Copy-Item -LiteralPath $SourcePath -Destination (Join-Path $BackupRoot "candidate-$Name") -Force
        }
    }
}

function Wait-BrokerHealth {
    param(
        [int]$TimeoutSeconds,
        [string]$ExpectedBrokerPath,
        [int]$RejectedProcessId = 0,
        [int]$ExpectedProcessId = 0
    )
    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $LastObservation = $null
    do {
        if ($ExpectedProcessId -and -not (Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue)) {
            throw "Candidate broker process exited before becoming healthy: PID $ExpectedProcessId"
        }
        try {
            $Health = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 3
            if ($Health.ok -eq $true) {
                $Identity = Assert-BrokerHealthIdentity -Health $Health -ExpectedBrokerPath $ExpectedBrokerPath -Stage "Started"
                if ($RejectedProcessId -and $Identity.pid -eq $RejectedProcessId) {
                    throw "Started broker reused the pre-update PID $RejectedProcessId."
                }
                if ($ExpectedProcessId -and $Identity.pid -ne $ExpectedProcessId) {
                    throw "Healthy broker PID did not match the candidate process. expected=$ExpectedProcessId actual=$($Identity.pid)"
                }
                return $Health
            }
        } catch { $LastObservation = $_.Exception.Message }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Broker did not become healthy within $TimeoutSeconds seconds. Last observation: $LastObservation"
}

function Wait-BrokerDeepHealth {
    param(
        [string]$Endpoint,
        [DateTime]$Deadline,
        [string]$ExpectedBrokerPath,
        [int]$ExpectedProcessId
    )
    $LastObservation = $null
    do {
        if (-not (Get-Process -Id $ExpectedProcessId -ErrorAction SilentlyContinue)) {
            throw "Candidate broker process exited before deep health became ready: PID $ExpectedProcessId endpoint=$Endpoint"
        }
        try {
            $CurrentHealth = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 3
            $Identity = Assert-BrokerHealthIdentity -Health $CurrentHealth -ExpectedBrokerPath $ExpectedBrokerPath -Stage "Deep health"
            if ($Identity.pid -ne $ExpectedProcessId) {
                throw "Deep health broker PID did not match the candidate process. expected=$ExpectedProcessId actual=$($Identity.pid)"
            }
            $ProbeUrl = "$HealthUrl`?endpoint=$([uri]::EscapeDataString($Endpoint))&deep=1"
            $Probe = Invoke-RestMethod -Method Get -Uri $ProbeUrl -TimeoutSec 20
            if ($Probe.ok -eq $true -and $Probe.healthy -eq $true) { return $Probe }
            $LastObservation = if ($Probe.error) { [string]$Probe.error } else { $Probe | ConvertTo-Json -Compress -Depth 5 }
        } catch {
            $LastObservation = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Deep health did not become ready for endpoint '$Endpoint' before the startup deadline. Last observation: $LastObservation"
}

$ProtectedStatePaths = @($ProtectedStatePaths | ForEach-Object { Get-NormalizedFilePath -Path $_ })
$TaskRouterRuntimeStatePaths = @($TaskRouterRuntimeStatePaths | ForEach-Object { Get-NormalizedFilePath -Path $_ })
foreach ($Path in $ProtectedStatePaths) {
    if ([System.IO.Path]::GetFileName($Path).Equals("task-router-runtime.json", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "task-router-runtime.json is volatile and cannot use byte-for-byte ProtectedStatePaths. Pass it via TaskRouterRuntimeStatePaths."
    }
}
foreach ($Path in $TaskRouterRuntimeStatePaths) {
    if (-not [System.IO.Path]::GetFileName($Path).Equals("task-router-runtime.json", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "TaskRouterRuntimeStatePaths only accepts task-router-runtime.json files: $Path"
    }
    if (@($ProtectedStatePaths | Where-Object { $_.Equals($Path, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
        throw "A state path cannot use both byte and task-router semantic protection: $Path"
    }
}

foreach ($Path in @($SourceBrokerPath, $SourceEndpointConfigPath, $SourceLifecyclePath, $SourceStopScript, $SourceStartScript, $InstalledBrokerPath, $InstalledLifecyclePath)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
}
if ($ManagedStartScript -and -not (Test-Path -LiteralPath $ManagedStartScript -PathType Leaf)) {
    throw "Managed broker start script is missing: $ManagedStartScript"
}
if ($ManagedStopScript -and -not (Test-Path -LiteralPath $ManagedStopScript -PathType Leaf)) {
    throw "Managed broker stop script is missing: $ManagedStopScript"
}
if ($ManagedNodeExe -and -not (Test-Path -LiteralPath $ManagedNodeExe -PathType Leaf)) {
    throw "Managed broker Node executable is missing: $ManagedNodeExe"
}

foreach ($ScriptPath in @($SourceStopScript, $SourceStartScript)) {
    $ParserTokens = $null
    $ParserErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$ParserTokens, [ref]$ParserErrors)
    if ($ParserErrors.Count -gt 0) { throw "PowerShell syntax validation failed: $ScriptPath" }
}

Push-Location $SourceBrokerRoot
try {
    $ConfiguredNodeExe = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", "Process")
    $ValidationNodeExe = if ($ManagedNodeExe) {
        $ManagedNodeExe
    } elseif (-not [string]::IsNullOrWhiteSpace([string]$ConfiguredNodeExe)) {
        [System.IO.Path]::GetFullPath([string]$ConfiguredNodeExe)
    } else {
        "node"
    }
    if ([System.IO.Path]::IsPathRooted($ValidationNodeExe) -and -not (Test-Path -LiteralPath $ValidationNodeExe -PathType Leaf)) {
        throw "Configured Node executable is missing: $ValidationNodeExe"
    }
    & $ValidationNodeExe --check $SourceBrokerPath
    if ($LASTEXITCODE -ne 0) { throw "Source broker syntax validation failed." }
    & $ValidationNodeExe --check $SourceEndpointConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Source endpoint configuration syntax validation failed." }
    & $ValidationNodeExe --check $SourceLifecyclePath
    if ($LASTEXITCODE -ne 0) { throw "Source request lifecycle syntax validation failed." }
} finally {
    Pop-Location
}

$ProtectedBefore = [ordered]@{}
foreach ($Path in $ProtectedStatePaths) { $ProtectedBefore[$Path] = Get-FileHashOrNull -Path $Path }
$TaskRouterBefore = [ordered]@{}
foreach ($Path in $TaskRouterRuntimeStatePaths) { $TaskRouterBefore[$Path] = Get-TaskRouterRuntimeSnapshot -Path $Path }

$ShouldActivate = $PSCmdlet.ShouldProcess($BrokerRoot, "install validated broker code and lifecycle scripts, then restart broker")
if (-not $ShouldActivate) {
    [pscustomobject]@{
        ok = $true
        whatIf = $true
        sourceBrokerRoot = $SourceBrokerRoot
        brokerRoot = $BrokerRoot
        brokerPath = $InstalledBrokerPath
        serviceManifestPath = if ($ManagedStartScript) { $ConfiguredServiceManifestPath } else { $null }
        lifecycleBootstrap = $true
        endpointConfigBootstrap = -not (Test-Path -LiteralPath $InstalledEndpointConfigPath -PathType Leaf)
        protectedState = $ProtectedBefore
        taskRouterRuntimeState = @($TaskRouterBefore.Values)
    } | ConvertTo-Json -Depth 10
    return
}

$BeforeHealth = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 3
$BeforeIdentity = Assert-BrokerHealthIdentity -Health $BeforeHealth -ExpectedBrokerPath $InstalledBrokerPath -Stage "Pre-update"

Push-Location $SourceBrokerRoot
try {
    & $ValidationNodeExe --test (Join-Path $SourceBrokerRoot "test\request-lifecycle.test.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Source request lifecycle tests failed." }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
Copy-Item -LiteralPath $InstalledBrokerPath -Destination (Join-Path $BackupRoot "broker.mjs") -Force
Copy-Item -LiteralPath $InstalledLifecyclePath -Destination (Join-Path $BackupRoot "request-lifecycle.mjs") -Force
$InstalledEndpointConfigExisted = Test-Path -LiteralPath $InstalledEndpointConfigPath -PathType Leaf
if ($InstalledEndpointConfigExisted) { Copy-Item -LiteralPath $InstalledEndpointConfigPath -Destination (Join-Path $BackupRoot "endpoint-config.mjs") -Force }
$InstalledStartExisted = Test-Path -LiteralPath $StartScript -PathType Leaf
$InstalledStopExisted = Test-Path -LiteralPath $StopScript -PathType Leaf
if ($InstalledStartExisted) { Copy-Item -LiteralPath $StartScript -Destination (Join-Path $BackupRoot "Start-CodexMcpBroker.ps1") -Force }
if ($InstalledStopExisted) { Copy-Item -LiteralPath $StopScript -Destination (Join-Path $BackupRoot "Stop-CodexMcpBroker.ps1") -Force }
[pscustomobject]@{
    installedStartExisted = $InstalledStartExisted
    installedStopExisted = $InstalledStopExisted
    installedEndpointConfigExisted = $InstalledEndpointConfigExisted
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BackupRoot "lifecycle-state.json") -Encoding UTF8

$Activated = $false
try {
    Stop-TargetBrokerProcesses -ExpectedBrokerPath $InstalledBrokerPath
    if (Get-Process -Id $BeforeIdentity.pid -ErrorAction SilentlyContinue) {
        throw "Pre-update broker PID did not exit: $($BeforeIdentity.pid)"
    }
    Wait-BrokerPortReleased -Port $BrokerPort -TimeoutSeconds 5
    Copy-Item -LiteralPath $SourceStopScript -Destination $StopScript -Force
    Copy-Item -LiteralPath $SourceStartScript -Destination $StartScript -Force
    Copy-Item -LiteralPath $SourceBrokerPath -Destination $InstalledBrokerPath -Force
    Copy-Item -LiteralPath $SourceEndpointConfigPath -Destination $InstalledEndpointConfigPath -Force
    Copy-Item -LiteralPath $SourceLifecyclePath -Destination $InstalledLifecyclePath -Force
    if ((Get-FileHashOrNull -Path $InstalledBrokerPath) -ne (Get-FileHashOrNull -Path $SourceBrokerPath)) {
        throw "Installed broker hash does not match the validated source."
    }
    if ((Get-FileHashOrNull -Path $InstalledLifecyclePath) -ne (Get-FileHashOrNull -Path $SourceLifecyclePath)) {
        throw "Installed request lifecycle hash does not match the validated source."
    }
    if ((Get-FileHashOrNull -Path $InstalledEndpointConfigPath) -ne (Get-FileHashOrNull -Path $SourceEndpointConfigPath)) {
        throw "Installed endpoint configuration hash does not match the validated source."
    }
    $PreviousManagedNodeExe = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", "Process")
    $CandidateStartOutput = @()
    $CandidateProcessId = 0
    $CandidateStartFailure = $null
    try {
        if ($ManagedNodeExe) { [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $ManagedNodeExe, "Process") }
        try {
            $CandidateStartOutput = @(& $StartScript 2>&1 | ForEach-Object { [string]$_ })
        } catch {
            $CandidateStartFailure = $_
            $CandidateStartOutput += [string]$_
        }
    } finally {
        [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $PreviousManagedNodeExe, "Process")
    }
    $CandidateStartOutput | ForEach-Object { Write-Host $_ }
    foreach ($Line in $CandidateStartOutput) {
        if ($Line -match 'Codex MCP broker (?:started|already running): PID (\d+)') {
            $CandidateProcessId = [int]$Matches[1]
            break
        }
    }
    if (-not $CandidateProcessId) {
        $ExpectedCandidatePath = [System.IO.Path]::GetFullPath($InstalledBrokerPath)
        $CandidateProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
            $EntryScript = Get-NodeEntryScript -CommandLine ([string]$_.CommandLine)
            $EntryScript -and $EntryScript.Equals($ExpectedCandidatePath, [System.StringComparison]::OrdinalIgnoreCase)
        })
        if ($CandidateProcesses.Count -eq 1) { $CandidateProcessId = [int]$CandidateProcesses[0].ProcessId }
    }
    Save-CandidateStartupEvidence -StartOutput $CandidateStartOutput -CandidateProcessId $CandidateProcessId
    if ($CandidateStartFailure) { throw $CandidateStartFailure }
    if (-not $CandidateProcessId) { throw "Broker start script did not report a candidate PID." }
    $AfterHealth = Wait-BrokerHealth -TimeoutSeconds $StartupTimeoutSeconds -ExpectedBrokerPath $InstalledBrokerPath -RejectedProcessId $BeforeIdentity.pid -ExpectedProcessId $CandidateProcessId
    $DeepHealth = @()
    $DeepHealthDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    foreach ($Endpoint in $DeepHealthEndpoints) {
        $DeepHealth += Wait-BrokerDeepHealth -Endpoint $Endpoint -Deadline $DeepHealthDeadline -ExpectedBrokerPath $InstalledBrokerPath -ExpectedProcessId $CandidateProcessId
    }
    foreach ($Path in $ProtectedStatePaths) {
        $AfterHash = Get-FileHashOrNull -Path $Path
        if ($ProtectedBefore[$Path] -ne $AfterHash) {
            throw "Protected state changed during broker update: $Path"
        }
    }
    $TaskRouterAfter = [ordered]@{}
    foreach ($Path in $TaskRouterRuntimeStatePaths) {
        $TaskRouterAfter[$Path] = Get-TaskRouterRuntimeSnapshot -Path $Path
        Assert-TaskRouterRuntimeUnchanged -Before $TaskRouterBefore[$Path] -After $TaskRouterAfter[$Path]
    }
    $Activated = $true
    [pscustomobject]@{
        ok = $true
        backupRoot = $BackupRoot
        brokerPidBefore = $BeforeHealth.pid
        brokerPidAfter = $AfterHealth.pid
        brokerPath = $InstalledBrokerPath
        serviceManifestPath = if ($ManagedStartScript) { $ConfiguredServiceManifestPath } else { $null }
        lifecycleBootstrapped = (-not $InstalledStartExisted -or -not $InstalledStopExisted)
        endpointConfigBootstrapped = -not $InstalledEndpointConfigExisted
        endpoints = @($DeepHealth | ForEach-Object { [pscustomobject]@{ endpoint = $_.endpoint; toolCount = $_.toolCount; recovered = $_.recovered } })
        protectedState = $ProtectedBefore
        taskRouterRuntimeState = @($TaskRouterRuntimeStatePaths | ForEach-Object {
            [pscustomobject]@{ path = $_; before = $TaskRouterBefore[$_]; after = $TaskRouterAfter[$_] }
        })
    } | ConvertTo-Json -Depth 10
} catch {
    $Failure = $_.Exception.Message
    if (-not $Activated) {
        $RollbackErrors = [System.Collections.Generic.List[string]]::new()
        $StartupEvidenceWarning = $null
        if ($CandidateProcessId -or $CandidateStartOutput.Count -gt 0) {
            try { Copy-CandidateRuntimeLogs } catch { $StartupEvidenceWarning = $_.Exception.Message }
        }
        try {
            Stop-TargetBrokerProcesses -ExpectedBrokerPath $InstalledBrokerPath
        } catch { $RollbackErrors.Add("stop: $($_.Exception.Message)") }
        try {
            Copy-Item -LiteralPath (Join-Path $BackupRoot "broker.mjs") -Destination $InstalledBrokerPath -Force
            Copy-Item -LiteralPath (Join-Path $BackupRoot "request-lifecycle.mjs") -Destination $InstalledLifecyclePath -Force
            if ($InstalledEndpointConfigExisted) {
                Copy-Item -LiteralPath (Join-Path $BackupRoot "endpoint-config.mjs") -Destination $InstalledEndpointConfigPath -Force
            } else {
                Remove-Item -LiteralPath $InstalledEndpointConfigPath -Force -ErrorAction SilentlyContinue
            }
        } catch { $RollbackErrors.Add("code restore: $($_.Exception.Message)") }
        try {
            if ($InstalledStartExisted) {
                Copy-Item -LiteralPath (Join-Path $BackupRoot "Start-CodexMcpBroker.ps1") -Destination $StartScript -Force
            }
            if ($InstalledStopExisted) {
                Copy-Item -LiteralPath (Join-Path $BackupRoot "Stop-CodexMcpBroker.ps1") -Destination $StopScript -Force
            }
        } catch { $RollbackErrors.Add("lifecycle content restore: $($_.Exception.Message)") }
        try {
            if (Test-Path -LiteralPath $StartScript -PathType Leaf) {
                $PreviousManagedNodeExe = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", "Process")
                try {
                    if ($ManagedNodeExe) { [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $ManagedNodeExe, "Process") }
                    & $StartScript | Out-Null
                } finally {
                    [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $PreviousManagedNodeExe, "Process")
                }
                $null = Wait-BrokerHealth -TimeoutSeconds $StartupTimeoutSeconds -ExpectedBrokerPath $InstalledBrokerPath
            } else {
                $RollbackErrors.Add("restart: no start script is available")
            }
        } catch { $RollbackErrors.Add("restart: $($_.Exception.Message)") }
        try {
            if (-not $InstalledStopExisted) { Remove-Item -LiteralPath $StopScript -Force -ErrorAction Stop }
            if (-not $InstalledStartExisted) { Remove-Item -LiteralPath $StartScript -Force -ErrorAction Stop }
        } catch { $RollbackErrors.Add("lifecycle existence restore: $($_.Exception.Message)") }
        foreach ($Path in $ProtectedStatePaths) {
            try {
                $RollbackHash = Get-FileHashOrNull -Path $Path
                if ($ProtectedBefore[$Path] -ne $RollbackHash) {
                    $RollbackErrors.Add("protected state changed: $Path")
                }
            } catch { $RollbackErrors.Add("protected state check: $Path $($_.Exception.Message)") }
        }
        foreach ($Path in $TaskRouterRuntimeStatePaths) {
            try {
                $RollbackRuntime = Get-TaskRouterRuntimeSnapshot -Path $Path
                Assert-TaskRouterRuntimeUnchanged -Before $TaskRouterBefore[$Path] -After $RollbackRuntime
            } catch { $RollbackErrors.Add("task router runtime check: $Path $($_.Exception.Message)") }
        }
        if ($RollbackErrors.Count -gt 0) {
            $EvidenceSuffix = if ($StartupEvidenceWarning) { " Startup evidence warning: $StartupEvidenceWarning" } else { "" }
            throw "Broker update failed and rollback was incomplete. Update error: $Failure Rollback errors: $($RollbackErrors -join ' | ') Backup: $BackupRoot$EvidenceSuffix"
        }
    }
    $EvidenceSuffix = if ($StartupEvidenceWarning) { " Startup evidence warning: $StartupEvidenceWarning" } else { "" }
    throw "Broker update failed; previous code was restored and verified healthy: $Failure Backup: $BackupRoot$EvidenceSuffix"
}
