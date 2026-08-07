[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SourceBrokerRoot = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "mcps\broker"),
    [string]$BrokerRoot = (Join-Path $env:USERPROFILE ".codex\mcp-http-broker"),
    [string[]]$DeepHealthEndpoints = @("napcat", "sandbox"),
    [string[]]$ProtectedStatePaths = @(),
    [ValidateRange(5, 120)][int]$StartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$SourceBrokerRoot = [System.IO.Path]::GetFullPath($SourceBrokerRoot)
$BrokerRoot = [System.IO.Path]::GetFullPath($BrokerRoot)
$SourceBrokerPath = Join-Path $SourceBrokerRoot "broker.mjs"
$SourceLifecyclePath = Join-Path $SourceBrokerRoot "request-lifecycle.mjs"
$InstalledBrokerPath = Join-Path $BrokerRoot "broker.mjs"
$InstalledLifecyclePath = Join-Path $BrokerRoot "request-lifecycle.mjs"
$StopScript = Join-Path $BrokerRoot "Stop-CodexMcpBroker.ps1"
$StartScript = Join-Path $BrokerRoot "Start-CodexMcpBroker.ps1"
$HealthUrl = "http://127.0.0.1:14588/health"
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

function Wait-BrokerHealth {
    param([int]$TimeoutSeconds)
    $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $Health = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 3
            if ($Health.ok -eq $true) { return $Health }
        } catch {}
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "Broker did not become healthy within $TimeoutSeconds seconds."
}

foreach ($Path in @($SourceBrokerPath, $SourceLifecyclePath, $StopScript, $StartScript)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
}

Push-Location $SourceBrokerRoot
try {
    & node --check $SourceBrokerPath
    if ($LASTEXITCODE -ne 0) { throw "Source broker syntax validation failed." }
    & node --check $SourceLifecyclePath
    if ($LASTEXITCODE -ne 0) { throw "Source request lifecycle syntax validation failed." }
    & node --test (Join-Path $SourceBrokerRoot "test\request-lifecycle.test.mjs")
    if ($LASTEXITCODE -ne 0) { throw "Source request lifecycle tests failed." }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
Copy-Item -LiteralPath $InstalledBrokerPath -Destination (Join-Path $BackupRoot "broker.mjs") -Force
Copy-Item -LiteralPath $InstalledLifecyclePath -Destination (Join-Path $BackupRoot "request-lifecycle.mjs") -Force
$ProtectedBefore = [ordered]@{}
foreach ($Path in $ProtectedStatePaths) { $ProtectedBefore[$Path] = Get-FileHashOrNull -Path $Path }

$BeforeHealth = $null
try { $BeforeHealth = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 3 } catch {}
$Activated = $false
try {
    if ($PSCmdlet.ShouldProcess($BrokerRoot, "install validated broker code and restart broker")) {
        Copy-Item -LiteralPath $SourceBrokerPath -Destination $InstalledBrokerPath -Force
        Copy-Item -LiteralPath $SourceLifecyclePath -Destination $InstalledLifecyclePath -Force
        & $StopScript | Out-Host
        & $StartScript | Out-Host
        $AfterHealth = Wait-BrokerHealth -TimeoutSeconds $StartupTimeoutSeconds
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
            endpoints = @($DeepHealth | ForEach-Object { [pscustomobject]@{ endpoint = $_.endpoint; toolCount = $_.toolCount; recovered = $_.recovered } })
            protectedState = $ProtectedBefore
        } | ConvertTo-Json -Depth 10
    }
} catch {
    $Failure = $_.Exception.Message
    if (-not $Activated) {
        $RollbackFailure = $null
        try {
            & $StopScript | Out-Null
            Copy-Item -LiteralPath (Join-Path $BackupRoot "broker.mjs") -Destination $InstalledBrokerPath -Force
            Copy-Item -LiteralPath (Join-Path $BackupRoot "request-lifecycle.mjs") -Destination $InstalledLifecyclePath -Force
            & $StartScript | Out-Null
            $null = Wait-BrokerHealth -TimeoutSeconds $StartupTimeoutSeconds
            foreach ($Path in $ProtectedStatePaths) {
                $RollbackHash = Get-FileHashOrNull -Path $Path
                if ($ProtectedBefore[$Path] -ne $RollbackHash) {
                    throw "Protected state changed during update and rollback: $Path"
                }
            }
        } catch {
            $RollbackFailure = $_.Exception.Message
        }
        if ($RollbackFailure) {
            throw "Broker update failed and rollback did not restore a healthy broker. Update error: $Failure Rollback error: $RollbackFailure Backup: $BackupRoot"
        }
    }
    throw "Broker update failed; previous code was restored and verified healthy: $Failure"
}
