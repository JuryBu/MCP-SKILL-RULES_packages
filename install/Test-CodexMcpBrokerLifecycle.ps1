$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$updaterPath = Join-Path $installRoot "Update-CodexMcpBroker.ps1"
$startScriptPath = Join-Path $installRoot "Start-CodexMcpBroker.ps1"
$stopScriptPath = Join-Path $installRoot "Stop-CodexMcpBroker.ps1"
$testRoot = Join-Path $env:TEMP ("codex-broker-lifecycle-test-" + [guid]::NewGuid())
$processIds = [System.Collections.Generic.List[int]]::new()
$nodeExePath = (Get-Command node -ErrorAction Stop).Source

function Get-Sha256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Get-FileHash { throw "Get-FileHash is unavailable in this compatibility test." }

function Get-StaticTargetSnapshot {
    param([string]$Root)
    $snapshot = [ordered]@{}
    foreach ($name in @(
        "broker.mjs",
        "request-lifecycle.mjs",
        "broker-private.env.json",
        "Start-CodexMcpBroker.ps1",
        "Stop-CodexMcpBroker.ps1"
    )) {
        $snapshot[$name] = Get-Sha256 (Join-Path $Root $name)
    }
    $snapshot["backups.exists"] = Test-Path -LiteralPath (Join-Path $Root "backups")
    return ($snapshot | ConvertTo-Json -Compress)
}

function Write-MockSource {
    param([string]$Root, [ValidateSet("healthy", "unhealthy")][string]$Mode)
    New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root "test") | Out-Null
    $broker = @'
import fs from "node:fs";
import http from "node:http";
const mode = "__MODE__";
const port = Number(process.env.CODEX_MCP_BROKER_PORT);
const probe = process.env.BROKER_PROBE_FILE;
if (mode === "unhealthy") {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((request, response) => {
    if (probe) fs.appendFileSync(probe, "health\n");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, pid: process.pid }));
  });
  server.listen(port, "127.0.0.1");
}
'@
    $fixtureMarker = [System.IO.Path]::GetFileName($Root)
    Set-Content -LiteralPath (Join-Path $Root "broker.mjs") -Encoding UTF8 -Value ($broker.Replace("__MODE__", $Mode) + "`n// fixture: $fixtureMarker")
    Set-Content -LiteralPath (Join-Path $Root "request-lifecycle.mjs") -Encoding UTF8 -Value "export const lifecycle = true;"
    Set-Content -LiteralPath (Join-Path $Root "test\request-lifecycle.test.mjs") -Encoding UTF8 -Value 'import test from "node:test"; import assert from "node:assert/strict"; test("fixture", () => assert.equal(1, 1));'
}

function Start-FlatBroker {
    param([string]$Root)
    $temporaryStart = Join-Path $Root "Start-CodexMcpBroker.ps1"
    if (-not (Test-Path -LiteralPath $temporaryStart -PathType Leaf)) {
        Copy-Item -LiteralPath $startScriptPath -Destination $temporaryStart -Force
        $removeAfter = $true
    }
    & $temporaryStart | Out-Null
    $pidValue = [int](Get-Content -LiteralPath (Join-Path $Root "broker.pid") -Encoding UTF8 | Select-Object -First 1)
    $processIds.Add($pidValue)
    if ($removeAfter) { Remove-Item -LiteralPath $temporaryStart -Force }
    return $pidValue
}

function Stop-FlatBroker {
    param([string]$Root)
    $temporaryStop = Join-Path $Root "Stop-CodexMcpBroker.ps1"
    if (-not (Test-Path -LiteralPath $temporaryStop -PathType Leaf)) {
        Copy-Item -LiteralPath $stopScriptPath -Destination $temporaryStop -Force
        $removeAfter = $true
    }
    & $temporaryStop | Out-Null
    if ($removeAfter) { Remove-Item -LiteralPath $temporaryStop -Force }
}

function Wait-Health {
    param([int]$Port)
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        try {
            $result = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
            if ($result.ok -eq $true) { return }
        } catch {}
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Mock broker on port $Port did not become healthy."
}

function Initialize-Target {
    param(
        [string]$Root,
        [string]$OldSource,
        [int]$Port,
        [bool]$StartExists,
        [bool]$StopExists
    )
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    Copy-Item -LiteralPath (Join-Path $OldSource "broker.mjs") -Destination (Join-Path $Root "broker.mjs") -Force
    Copy-Item -LiteralPath (Join-Path $OldSource "request-lifecycle.mjs") -Destination (Join-Path $Root "request-lifecycle.mjs") -Force
    [ordered]@{
        CODEX_MCP_BROKER_PORT = [string]$Port
        BROKER_PROBE_FILE = (Join-Path $Root "probe.log")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Root "broker-private.env.json") -Encoding UTF8
    if ($StartExists) { Copy-Item -LiteralPath $startScriptPath -Destination (Join-Path $Root "Start-CodexMcpBroker.ps1") -Force }
    if ($StopExists) { Copy-Item -LiteralPath $stopScriptPath -Destination (Join-Path $Root "Stop-CodexMcpBroker.ps1") -Force }
    $null = Start-FlatBroker -Root $Root
    Wait-Health -Port $Port
}

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    $healthySource = Join-Path $testRoot "source-healthy"
    $unhealthySource = Join-Path $testRoot "source-unhealthy"
    $oldSource = Join-Path $testRoot "source-old"
    Write-MockSource -Root $healthySource -Mode healthy
    Write-MockSource -Root $unhealthySource -Mode unhealthy
    Write-MockSource -Root $oldSource -Mode healthy

    $flatRoot = Join-Path $testRoot "process-match"
    New-Item -ItemType Directory -Force -Path $flatRoot | Out-Null
    Copy-Item -LiteralPath $startScriptPath -Destination (Join-Path $flatRoot "Start-CodexMcpBroker.ps1") -Force
    Copy-Item -LiteralPath $stopScriptPath -Destination (Join-Path $flatRoot "Stop-CodexMcpBroker.ps1") -Force
    Set-Content -LiteralPath (Join-Path $flatRoot "broker.mjs") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    Set-Content -LiteralPath (Join-Path $flatRoot "broker.mjs.backup") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    Set-Content -LiteralPath (Join-Path $flatRoot "decoy.mjs") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    $decoyScript = Start-Process -FilePath "node" -ArgumentList @((Join-Path $flatRoot "broker.mjs.backup")) -PassThru -WindowStyle Hidden
    $decoyArgument = Start-Process -FilePath "node" -ArgumentList @((Join-Path $flatRoot "decoy.mjs"), (Join-Path $flatRoot "broker.mjs")) -PassThru -WindowStyle Hidden
    $processIds.Add($decoyScript.Id)
    $processIds.Add($decoyArgument.Id)
    $realPid = Start-FlatBroker -Root $flatRoot
    & (Join-Path $flatRoot "Stop-CodexMcpBroker.ps1") | Out-Null
    if (Get-Process -Id $realPid -ErrorAction SilentlyContinue) { throw "Stop did not terminate the real broker." }
    foreach ($decoyPid in @($decoyScript.Id, $decoyArgument.Id)) {
        if (-not (Get-Process -Id $decoyPid -ErrorAction SilentlyContinue)) { throw "Lifecycle scripts matched a decoy process: PID $decoyPid" }
    }

    $whatIfRoot = Join-Path $testRoot "what-if"
    Initialize-Target -Root $whatIfRoot -OldSource $oldSource -Port 19480 -StartExists $false -StopExists $false
    $whatIfSideEffectPath = Join-Path $testRoot "what-if-test-ran.txt"
    $whatIfSideEffectLiteral = $whatIfSideEffectPath.Replace("\", "\\").Replace("'", "\'")
    Set-Content -LiteralPath (Join-Path $healthySource "test\request-lifecycle.test.mjs") -Encoding UTF8 -Value "import fs from 'node:fs'; fs.writeFileSync('$whatIfSideEffectLiteral', 'ran');"
    $probePath = Join-Path $whatIfRoot "probe.log"
    $beforeProbeCount = if (Test-Path -LiteralPath $probePath) { @(Get-Content -LiteralPath $probePath -Encoding UTF8).Count } else { 0 }
    $beforeTree = Get-StaticTargetSnapshot -Root $whatIfRoot
    $whatIfOutput = & $updaterPath -SourceBrokerRoot $healthySource -BrokerRoot $whatIfRoot -BrokerPort 19480 -DeepHealthEndpoints @() -WhatIf 2>&1 | Out-String
    $afterProbeCount = if (Test-Path -LiteralPath $probePath) { @(Get-Content -LiteralPath $probePath -Encoding UTF8).Count } else { 0 }
    $afterTree = Get-StaticTargetSnapshot -Root $whatIfRoot
    if (-not $whatIfOutput.Contains('"lifecycleBootstrap":  true')) { throw "WhatIf did not report lifecycle bootstrap support." }
    if ($beforeProbeCount -ne $afterProbeCount) { throw "WhatIf contacted the running broker health endpoint." }
    if ($beforeTree -ne $afterTree) { throw "WhatIf modified the target tree." }
    if (Test-Path -LiteralPath $whatIfSideEffectPath) { throw "WhatIf executed candidate test code." }
    Stop-FlatBroker -Root $whatIfRoot
    Write-MockSource -Root $healthySource -Mode healthy

    $incompleteManifestPath = Join-Path $testRoot "incomplete-service-manifest.json"
    [ordered]@{ broker = [ordered]@{ brokerScript = (Join-Path $whatIfRoot "broker.mjs"); startScript = ""; stopScript = "" } } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $incompleteManifestPath -Encoding UTF8
    $incompleteManifestFailed = $false
    try {
        & $updaterPath -SourceBrokerRoot $healthySource -ServiceManifestPath $incompleteManifestPath -BrokerPort 19480 -DeepHealthEndpoints @() -WhatIf | Out-Null
    } catch {
        $incompleteManifestFailed = $_.Exception.Message.Contains("broker.stopScript")
    }
    if (-not $incompleteManifestFailed) { throw "Updater did not fail closed for an incomplete managed broker manifest." }

    $caseIndex = 0
    foreach ($state in @(
        @{ start = $false; stop = $false },
        @{ start = $true; stop = $false },
        @{ start = $false; stop = $true },
        @{ start = $true; stop = $true }
    )) {
        $caseIndex++
        $root = Join-Path $testRoot "rollback-$caseIndex"
        $port = 19480 + $caseIndex
        Initialize-Target -Root $root -OldSource $oldSource -Port $port -StartExists $state.start -StopExists $state.stop
        $oldBrokerHash = Get-Sha256 (Join-Path $root "broker.mjs")
        $oldLifecycleHash = Get-Sha256 (Join-Path $root "request-lifecycle.mjs")
        $oldStartHash = Get-Sha256 (Join-Path $root "Start-CodexMcpBroker.ps1")
        $oldStopHash = Get-Sha256 (Join-Path $root "Stop-CodexMcpBroker.ps1")
        $failed = $false
        try {
            & $updaterPath -SourceBrokerRoot $unhealthySource -BrokerRoot $root -BrokerPort $port -DeepHealthEndpoints @() -StartupTimeoutSeconds 1 | Out-Null
        } catch { $failed = $true }
        if (-not $failed) { throw "Rollback case $caseIndex unexpectedly succeeded." }
        Wait-Health -Port $port
        if ((Get-Sha256 (Join-Path $root "broker.mjs")) -ne $oldBrokerHash) { throw "Rollback case $caseIndex did not restore broker.mjs." }
        if ((Get-Sha256 (Join-Path $root "request-lifecycle.mjs")) -ne $oldLifecycleHash) { throw "Rollback case $caseIndex did not restore request-lifecycle.mjs." }
        if ((Get-Sha256 (Join-Path $root "Start-CodexMcpBroker.ps1")) -ne $oldStartHash) { throw "Rollback case $caseIndex did not restore Start script state." }
        if ((Get-Sha256 (Join-Path $root "Stop-CodexMcpBroker.ps1")) -ne $oldStopHash) { throw "Rollback case $caseIndex did not restore Stop script state." }
        Stop-FlatBroker -Root $root
    }

    $successRoot = Join-Path $testRoot "success"
    Initialize-Target -Root $successRoot -OldSource $oldSource -Port 19490 -StartExists $false -StopExists $false
    $successPidBefore = [int](Get-Content -LiteralPath (Join-Path $successRoot "broker.pid") -Encoding UTF8 | Select-Object -First 1)
    & $updaterPath -SourceBrokerRoot $healthySource -BrokerRoot $successRoot -BrokerPort 19490 -DeepHealthEndpoints @() -StartupTimeoutSeconds 2 | Out-Null
    Wait-Health -Port 19490
    $successPidAfter = [int](Get-Content -LiteralPath (Join-Path $successRoot "broker.pid") -Encoding UTF8 | Select-Object -First 1)
    if ($successPidAfter -eq $successPidBefore) { throw "Successful update did not replace the broker PID." }
    if ((Get-Sha256 (Join-Path $successRoot "broker.mjs")) -ne (Get-Sha256 (Join-Path $healthySource "broker.mjs"))) { throw "Successful update did not install candidate broker.mjs." }
    foreach ($name in @("Start-CodexMcpBroker.ps1", "Stop-CodexMcpBroker.ps1")) {
        if (-not (Test-Path -LiteralPath (Join-Path $successRoot $name) -PathType Leaf)) { throw "Successful update did not retain $name." }
    }
    Stop-FlatBroker -Root $successRoot

    $managedReleaseRoot = Join-Path $testRoot "managed-release"
    $managedRoot = Join-Path $managedReleaseRoot "mcps\broker"
    $managedInstallRoot = Join-Path $managedReleaseRoot "install"
    Initialize-Target -Root $managedRoot -OldSource $oldSource -Port 19491 -StartExists $true -StopExists $true
    New-Item -ItemType Directory -Force -Path $managedInstallRoot | Out-Null
    $managedStartScript = Join-Path $managedInstallRoot "Start-CodexMcpBroker.ps1"
    $managedStopScript = Join-Path $managedInstallRoot "Stop-CodexMcpBroker.ps1"
    Copy-Item -LiteralPath (Join-Path $managedRoot "Start-CodexMcpBroker.ps1") -Destination $managedStartScript -Force
    Copy-Item -LiteralPath (Join-Path $managedRoot "Stop-CodexMcpBroker.ps1") -Destination $managedStopScript -Force
    Add-Content -LiteralPath $managedStartScript -Encoding UTF8 -Value "# old managed start"
    Add-Content -LiteralPath $managedStopScript -Encoding UTF8 -Value "# old managed stop"
    Remove-Item -LiteralPath (Join-Path $managedRoot "Start-CodexMcpBroker.ps1"), (Join-Path $managedRoot "Stop-CodexMcpBroker.ps1") -Force
    $managedManifestPath = Join-Path $testRoot "service-manifest.json"
    [ordered]@{
        broker = [ordered]@{
            nodeExe = $nodeExePath
            startScript = $managedStartScript
            stopScript = $managedStopScript
            brokerScript = (Join-Path $managedRoot "broker.mjs")
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $managedManifestPath -Encoding UTF8
    $managedPidBefore = [int](Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:19491/health" -TimeoutSec 1).pid
    $previousBrokerPort = [Environment]::GetEnvironmentVariable("CODEX_MCP_BROKER_PORT", "Process")
    $previousDataRoot = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_DATA_ROOT", "Process")
    $previousServiceManifest = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_SERVICE_MANIFEST", "Process")
    try {
        [Environment]::SetEnvironmentVariable("CODEX_MCP_BROKER_PORT", "19491", "Process")
        [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_DATA_ROOT", (Join-Path $testRoot "managed-data"), "Process")
        [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_SERVICE_MANIFEST", $managedManifestPath, "Process")
        function node { throw "PATH node must not be used for a managed broker update." }
        & $updaterPath -SourceBrokerRoot $healthySource -BrokerPort 19491 -DeepHealthEndpoints @() -StartupTimeoutSeconds 2 | Out-Null
        Wait-Health -Port 19491
        $managedPidAfter = [int](Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:19491/health" -TimeoutSec 1).pid
        if ($managedPidAfter -eq $managedPidBefore) { throw "Managed update did not replace the broker PID." }
        if ((Get-Sha256 $managedStartScript) -ne (Get-Sha256 $startScriptPath)) { throw "Managed update did not install the source Start script at the manifest path." }
        if ((Get-Sha256 $managedStopScript) -ne (Get-Sha256 $stopScriptPath)) { throw "Managed update did not install the source Stop script at the manifest path." }
        if ((Get-Sha256 (Join-Path $managedRoot "broker.mjs")) -ne (Get-Sha256 (Join-Path $healthySource "broker.mjs"))) { throw "Managed update did not install the candidate broker at the manifest path." }
        $managedBrokerHash = Get-Sha256 (Join-Path $managedRoot "broker.mjs")
        $managedLifecycleHash = Get-Sha256 (Join-Path $managedRoot "request-lifecycle.mjs")
        $managedStartHash = Get-Sha256 $managedStartScript
        $managedStopHash = Get-Sha256 $managedStopScript
        $managedRollbackFailed = $false
        try {
            & $updaterPath -SourceBrokerRoot $unhealthySource -BrokerPort 19491 -DeepHealthEndpoints @() -StartupTimeoutSeconds 1 | Out-Null
        } catch {
            $managedRollbackFailed = $_.Exception.Message.Contains("previous code was restored")
        }
        if (-not $managedRollbackFailed) { throw "Managed release rollback case unexpectedly succeeded or did not verify restoration." }
        Wait-Health -Port 19491
        if ((Get-Sha256 (Join-Path $managedRoot "broker.mjs")) -ne $managedBrokerHash) { throw "Managed rollback did not restore broker.mjs." }
        if ((Get-Sha256 (Join-Path $managedRoot "request-lifecycle.mjs")) -ne $managedLifecycleHash) { throw "Managed rollback did not restore request-lifecycle.mjs." }
        if ((Get-Sha256 $managedStartScript) -ne $managedStartHash) { throw "Managed rollback did not restore the Start script." }
        if ((Get-Sha256 $managedStopScript) -ne $managedStopHash) { throw "Managed rollback did not restore the Stop script." }
        & $managedStopScript | Out-Null
    } finally {
        Remove-Item -LiteralPath Function:\node -Force -ErrorAction SilentlyContinue
        [Environment]::SetEnvironmentVariable("CODEX_MCP_BROKER_PORT", $previousBrokerPort, "Process")
        [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_DATA_ROOT", $previousDataRoot, "Process")
        [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_SERVICE_MANIFEST", $previousServiceManifest, "Process")
    }

    $actualRoot = Join-Path $testRoot "actual-running"
    $wrongRoot = Join-Path $testRoot "wrong-target"
    Initialize-Target -Root $actualRoot -OldSource $oldSource -Port 19492 -StartExists $true -StopExists $true
    New-Item -ItemType Directory -Force -Path $wrongRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $oldSource "broker.mjs") -Destination (Join-Path $wrongRoot "broker.mjs") -Force
    Copy-Item -LiteralPath (Join-Path $oldSource "request-lifecycle.mjs") -Destination (Join-Path $wrongRoot "request-lifecycle.mjs") -Force
    $wrongSnapshotBefore = Get-StaticTargetSnapshot -Root $wrongRoot
    $wrongTargetFailed = $false
    try {
        & $updaterPath -SourceBrokerRoot $healthySource -BrokerRoot $wrongRoot -BrokerPort 19492 -DeepHealthEndpoints @() -StartupTimeoutSeconds 1 | Out-Null
    } catch {
        $wrongTargetFailed = $_.Exception.Message.Contains("different script")
    }
    if (-not $wrongTargetFailed) { throw "Updater did not reject a healthy broker from a different target path." }
    if ((Get-StaticTargetSnapshot -Root $wrongRoot) -ne $wrongSnapshotBefore) { throw "Wrong target changed before broker identity validation." }
    Wait-Health -Port 19492
    Stop-FlatBroker -Root $actualRoot

    Write-Output "Codex MCP broker lifecycle portability, WhatIf, flat and managed rollback, managed release, identity guard, and success tests passed."
} finally {
    foreach ($processId in $processIds) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID $processId /T /F | Out-Null
        }
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
