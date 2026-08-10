[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SourceBrokerRoot,
    [string]$BrokerRoot,
    [string]$ServiceManifestPath,
    [string[]]$DeepHealthEndpoints = @("napcat", "sandbox"),
    [string[]]$ProtectedStatePaths = @(),
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

function Get-NodeEntryScript {
    param([string]$CommandLine)
    if (-not $CommandLine) { return $null }
    $Tokens = @([regex]::Matches($CommandLine, '(?:"((?:\\.|[^"])*)"|(\S+))') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
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

function Wait-BrokerHealth {
    param(
        [int]$TimeoutSeconds,
        [string]$ExpectedBrokerPath,
        [int]$RejectedProcessId = 0
    )
    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $LastObservation = $null
    do {
        try {
            $Health = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 3
            if ($Health.ok -eq $true) {
                $Identity = Assert-BrokerHealthIdentity -Health $Health -ExpectedBrokerPath $ExpectedBrokerPath -Stage "Started"
                if ($RejectedProcessId -and $Identity.pid -eq $RejectedProcessId) {
                    throw "Started broker reused the pre-update PID $RejectedProcessId."
                }
                return $Health
            }
        } catch { $LastObservation = $_.Exception.Message }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Broker did not become healthy within $TimeoutSeconds seconds. Last observation: $LastObservation"
}

foreach ($Path in @($SourceBrokerPath, $SourceLifecyclePath, $SourceStopScript, $SourceStartScript, $InstalledBrokerPath, $InstalledLifecyclePath)) {
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
    $ValidationNodeExe = if ($ManagedNodeExe) { $ManagedNodeExe } else { "node" }
    & $ValidationNodeExe --check $SourceBrokerPath
    if ($LASTEXITCODE -ne 0) { throw "Source broker syntax validation failed." }
    & $ValidationNodeExe --check $SourceLifecyclePath
    if ($LASTEXITCODE -ne 0) { throw "Source request lifecycle syntax validation failed." }
} finally {
    Pop-Location
}

$ProtectedBefore = [ordered]@{}
foreach ($Path in $ProtectedStatePaths) { $ProtectedBefore[$Path] = Get-FileHashOrNull -Path $Path }

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
        protectedState = $ProtectedBefore
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
$InstalledStartExisted = Test-Path -LiteralPath $StartScript -PathType Leaf
$InstalledStopExisted = Test-Path -LiteralPath $StopScript -PathType Leaf
if ($InstalledStartExisted) { Copy-Item -LiteralPath $StartScript -Destination (Join-Path $BackupRoot "Start-CodexMcpBroker.ps1") -Force }
if ($InstalledStopExisted) { Copy-Item -LiteralPath $StopScript -Destination (Join-Path $BackupRoot "Stop-CodexMcpBroker.ps1") -Force }
[pscustomobject]@{
    installedStartExisted = $InstalledStartExisted
    installedStopExisted = $InstalledStopExisted
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BackupRoot "lifecycle-state.json") -Encoding UTF8

$Activated = $false
try {
    Stop-TargetBrokerProcesses -ExpectedBrokerPath $InstalledBrokerPath
    if (Get-Process -Id $BeforeIdentity.pid -ErrorAction SilentlyContinue) {
        throw "Pre-update broker PID did not exit: $($BeforeIdentity.pid)"
    }
    Copy-Item -LiteralPath $SourceStopScript -Destination $StopScript -Force
    Copy-Item -LiteralPath $SourceStartScript -Destination $StartScript -Force
    Copy-Item -LiteralPath $SourceBrokerPath -Destination $InstalledBrokerPath -Force
    Copy-Item -LiteralPath $SourceLifecyclePath -Destination $InstalledLifecyclePath -Force
    if ((Get-FileHashOrNull -Path $InstalledBrokerPath) -ne (Get-FileHashOrNull -Path $SourceBrokerPath)) {
        throw "Installed broker hash does not match the validated source."
    }
    if ((Get-FileHashOrNull -Path $InstalledLifecyclePath) -ne (Get-FileHashOrNull -Path $SourceLifecyclePath)) {
        throw "Installed request lifecycle hash does not match the validated source."
    }
    $PreviousManagedNodeExe = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", "Process")
    try {
        if ($ManagedNodeExe) { [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $ManagedNodeExe, "Process") }
        & $StartScript | Out-Host
    } finally {
        [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $PreviousManagedNodeExe, "Process")
    }
    $AfterHealth = Wait-BrokerHealth -TimeoutSeconds $StartupTimeoutSeconds -ExpectedBrokerPath $InstalledBrokerPath -RejectedProcessId $BeforeIdentity.pid
    $DeepHealth = @()
    foreach ($Endpoint in $DeepHealthEndpoints) {
        $ProbeUrl = "$HealthUrl`?endpoint=$([uri]::EscapeDataString($Endpoint))&deep=1"
        $Probe = Invoke-RestMethod -Method Get -Uri $ProbeUrl -TimeoutSec 20
        if ($Probe.ok -ne $true -or $Probe.healthy -ne $true) {
            throw "Deep health failed for endpoint '$Endpoint': $($Probe.error)"
        }
        $DeepHealth += $Probe
    }
    foreach ($Path in $ProtectedStatePaths) {
        $AfterHash = Get-FileHashOrNull -Path $Path
        if ($ProtectedBefore[$Path] -ne $AfterHash) {
            throw "Protected state changed during broker update: $Path"
        }
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
        endpoints = @($DeepHealth | ForEach-Object { [pscustomobject]@{ endpoint = $_.endpoint; toolCount = $_.toolCount; recovered = $_.recovered } })
        protectedState = $ProtectedBefore
    } | ConvertTo-Json -Depth 10
} catch {
    $Failure = $_.Exception.Message
    if (-not $Activated) {
        $RollbackErrors = [System.Collections.Generic.List[string]]::new()
        try {
            Stop-TargetBrokerProcesses -ExpectedBrokerPath $InstalledBrokerPath
        } catch { $RollbackErrors.Add("stop: $($_.Exception.Message)") }
        try {
            Copy-Item -LiteralPath (Join-Path $BackupRoot "broker.mjs") -Destination $InstalledBrokerPath -Force
            Copy-Item -LiteralPath (Join-Path $BackupRoot "request-lifecycle.mjs") -Destination $InstalledLifecyclePath -Force
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
        if ($RollbackErrors.Count -gt 0) {
            throw "Broker update failed and rollback was incomplete. Update error: $Failure Rollback errors: $($RollbackErrors -join ' | ') Backup: $BackupRoot"
        }
    }
    throw "Broker update failed; previous code was restored and verified healthy: $Failure"
}
