$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$updaterPath = Join-Path $installRoot "Update-CodexMcpBroker.ps1"
$startScriptPath = Join-Path $installRoot "Start-CodexMcpBroker.ps1"
$stopScriptPath = Join-Path $installRoot "Stop-CodexMcpBroker.ps1"
$testRoot = Join-Path $env:TEMP ("codex-broker-lifecycle-test-" + [guid]::NewGuid())
$processIds = [System.Collections.Generic.List[int]]::new()

function Resolve-NodeExecutable {
    $configuredNodeExe = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", "Process")
    if (-not [string]::IsNullOrWhiteSpace([string]$configuredNodeExe)) {
        $configuredNodeExe = [System.IO.Path]::GetFullPath([string]$configuredNodeExe)
        if (-not (Test-Path -LiteralPath $configuredNodeExe -PathType Leaf)) {
            throw "Configured Node executable is missing: $configuredNodeExe"
        }
        return [pscustomobject]@{ path = $configuredNodeExe; source = "CODEX_TOOLKIT_NODE_EXE" }
    }

    $explicitServiceManifest = -not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST)
    $serviceManifestPath = if ($explicitServiceManifest) {
        [string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST
    } else {
        Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
    }
    $serviceManifestPath = [System.IO.Path]::GetFullPath($serviceManifestPath)
    if (Test-Path -LiteralPath $serviceManifestPath -PathType Leaf) {
        try {
            $serviceManifest = Get-Content -LiteralPath $serviceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $manifestNodeExe = [string]$serviceManifest.broker.nodeExe
            if ([string]::IsNullOrWhiteSpace($manifestNodeExe)) {
                throw "Managed broker service manifest does not record broker.nodeExe."
            }
            $manifestNodeExe = [System.IO.Path]::GetFullPath($manifestNodeExe)
            if (-not (Test-Path -LiteralPath $manifestNodeExe -PathType Leaf)) {
                throw "Managed broker Node executable is missing: $manifestNodeExe"
            }
            return [pscustomobject]@{ path = $manifestNodeExe; source = "managed-service-manifest" }
        } catch {
            throw "Cannot resolve Node executable from $serviceManifestPath. $($_.Exception.Message)"
        }
    }
    if ($explicitServiceManifest) {
        throw "Managed broker service manifest is missing: $serviceManifestPath"
    }

    $pathNodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pathNodeCommand -and -not [string]::IsNullOrWhiteSpace([string]$pathNodeCommand.Source)) {
        return [pscustomobject]@{ path = [System.IO.Path]::GetFullPath([string]$pathNodeCommand.Source); source = "PATH" }
    }
    throw "Node executable was not found in CODEX_TOOLKIT_NODE_EXE, the managed broker service manifest, or PATH."
}

$previousNodeExe = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", "Process")
$nodeResolution = Resolve-NodeExecutable
$nodeExePath = [string]$nodeResolution.path
[Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $nodeExePath, "Process")
Write-Output "Codex MCP broker lifecycle Node source: $($nodeResolution.source)"

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

function Get-ShortPathIfAvailable {
    param([string]$Path)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $shortPath = @(& cmd.exe /d /c "for %I in (`"$fullPath`") do @echo %~sI" 2>$null) | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace([string]$shortPath)) { return $fullPath }
    return [string]$shortPath
}

function Get-StaticTargetSnapshot {
    param([string]$Root)
    $snapshot = [ordered]@{}
    foreach ($name in @(
        "broker.mjs",
        "endpoint-config.mjs",
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
    param([string]$Root, [ValidateSet("healthy", "unhealthy", "transient-deep", "router-volatile", "router-identity-failure")][string]$Mode)
    New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root "test") | Out-Null
    $broker = @'
import fs from "node:fs";
import http from "node:http";
const mode = "__MODE__";
const port = Number(process.env.CODEX_MCP_BROKER_PORT);
const probe = process.env.BROKER_PROBE_FILE;
const routerRuntimePath = process.env.BROKER_TEST_ROUTER_RUNTIME;
let deepAttempts = 0;
if (routerRuntimePath && fs.existsSync(routerRuntimePath)) {
  const runtime = JSON.parse(fs.readFileSync(routerRuntimePath, "utf8").replace(/^\uFEFF/, ""));
  if (mode === "router-volatile") {
    runtime.lastScanAt = "2026-08-12T00:00:01.000Z";
    runtime.nextScanAt = "2026-08-12T00:00:31.000Z";
    runtime.updatedAt = "2026-08-12T00:00:01.000Z";
    runtime.openTaskCount = Number(runtime.openTaskCount || 0) + 1;
    runtime.keepAlive = false;
    fs.writeFileSync(routerRuntimePath, JSON.stringify(runtime, null, 2));
  } else if (mode === "router-identity-failure") {
    runtime.instanceToken = "unexpected-router-instance";
    fs.writeFileSync(routerRuntimePath, JSON.stringify(runtime, null, 2));
  }
}
if (mode === "unhealthy") {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const deep = url.searchParams.get("deep") === "1";
    if (probe) fs.appendFileSync(probe, deep ? "deep\n" : "health\n");
    if (mode === "transient-deep" && deep && ++deepAttempts < 3) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, healthy: false, pid: process.pid, error: "MCP error -32000: Connection closed" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, healthy: deep, pid: process.pid, endpoint: deep ? url.searchParams.get("endpoint") : undefined, toolCount: deep ? 22 : undefined }));
  });
  server.listen(port, "127.0.0.1");
}
'@
    $fixtureMarker = [System.IO.Path]::GetFileName($Root)
    Set-Content -LiteralPath (Join-Path $Root "broker.mjs") -Encoding UTF8 -Value ($broker.Replace("__MODE__", $Mode) + "`n// fixture: $fixtureMarker")
    Set-Content -LiteralPath (Join-Path $Root "endpoint-config.mjs") -Encoding UTF8 -Value "export const endpointConfig = '$fixtureMarker';"
    Set-Content -LiteralPath (Join-Path $Root "request-lifecycle.mjs") -Encoding UTF8 -Value "export const lifecycle = true;"
    Set-Content -LiteralPath (Join-Path $Root "test\request-lifecycle.test.mjs") -Encoding UTF8 -Value 'import test from "node:test"; import assert from "node:assert/strict"; test("fixture", () => assert.equal(1, 1));'
}

function Write-TaskRouterRuntimeState {
    param(
        [string]$Path,
        [int]$ProcessId,
        [string]$LockPath,
        [string]$InstanceToken = "router-instance-stable"
    )
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [ordered]@{
        schemaVersion = 1
        pid = $ProcessId
        startedAt = "2026-08-12T00:00:00.000Z"
        lastScanAt = "2026-08-12T00:00:00.000Z"
        nextScanAt = "2026-08-12T00:00:30.000Z"
        openTaskCount = 2
        lastError = $null
        state = "running"
        stopFilePath = (Join-Path $testRoot "router.stop")
        lockPath = $LockPath
        scanIntervalMs = 30000
        stoppedAt = $null
        stopReason = $null
        inFlightScan = $false
        maintenance = $null
        instanceToken = $InstanceToken
        updatedAt = "2026-08-12T00:00:00.000Z"
        keepAlive = $true
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Start-MockTaskRouter {
    param(
        [string]$RuntimePath,
        [string]$LockPath,
        [string]$InstanceToken = "router-instance-stable"
    )
    $runnerRoot = Join-Path $testRoot "mock-task-router"
    $runnerPath = Join-Path $runnerRoot "task-router-runner.mjs"
    New-Item -ItemType Directory -Force -Path $runnerRoot | Out-Null
    if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
        Set-Content -LiteralPath $runnerPath -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    }
    Set-Content -LiteralPath $RuntimePath -Encoding UTF8 -Value "{}"
    Set-Content -LiteralPath $LockPath -Encoding UTF8 -Value "{}"
    $runnerArgument = Get-ShortPathIfAvailable -Path $runnerPath
    $runtimeArgument = Get-ShortPathIfAvailable -Path $RuntimePath
    $lockArgument = Get-ShortPathIfAvailable -Path $LockPath
    $arguments = @($runnerArgument, "--runtime-state", $runtimeArgument, "--lock", $lockArgument)
    $argumentLine = ($arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join " "
    $process = Start-Process -FilePath $nodeExePath -ArgumentList $argumentLine -PassThru -WindowStyle Hidden
    $processIds.Add($process.Id)
    [ordered]@{
        pid = $process.Id
        token = $InstanceToken
        startedAt = "2026-08-12T00:00:00.000Z"
    } | ConvertTo-Json | Set-Content -LiteralPath $LockPath -Encoding UTF8
    Write-TaskRouterRuntimeState -Path $RuntimePath -ProcessId $process.Id -LockPath $LockPath -InstanceToken $InstanceToken
    return $process.Id
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
    if (Test-Path -LiteralPath (Join-Path $OldSource "endpoint-config.mjs") -PathType Leaf) {
        Copy-Item -LiteralPath (Join-Path $OldSource "endpoint-config.mjs") -Destination (Join-Path $Root "endpoint-config.mjs") -Force
    }
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
    $transientDeepSource = Join-Path $testRoot "source-transient-deep"
    $routerVolatileSource = Join-Path $testRoot "source-router-volatile"
    $routerIdentityFailureSource = Join-Path $testRoot "source-router-identity-failure"
    $oldSource = Join-Path $testRoot "source-old"
    Write-MockSource -Root $healthySource -Mode healthy
    Write-MockSource -Root $unhealthySource -Mode unhealthy
    Write-MockSource -Root $transientDeepSource -Mode transient-deep
    Write-MockSource -Root $routerVolatileSource -Mode router-volatile
    Write-MockSource -Root $routerIdentityFailureSource -Mode router-identity-failure
    Write-MockSource -Root $oldSource -Mode healthy
    Remove-Item -LiteralPath (Join-Path $oldSource "endpoint-config.mjs") -Force

    $flatRoot = Join-Path $testRoot "process-match"
    New-Item -ItemType Directory -Force -Path $flatRoot | Out-Null
    Copy-Item -LiteralPath $startScriptPath -Destination (Join-Path $flatRoot "Start-CodexMcpBroker.ps1") -Force
    Copy-Item -LiteralPath $stopScriptPath -Destination (Join-Path $flatRoot "Stop-CodexMcpBroker.ps1") -Force
    Set-Content -LiteralPath (Join-Path $flatRoot "broker.mjs") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    Set-Content -LiteralPath (Join-Path $flatRoot "broker.mjs.backup") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    Set-Content -LiteralPath (Join-Path $flatRoot "decoy.mjs") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"
    $decoyScript = Start-Process -FilePath $nodeExePath -ArgumentList @((Join-Path $flatRoot "broker.mjs.backup")) -PassThru -WindowStyle Hidden
    $decoyArgument = Start-Process -FilePath $nodeExePath -ArgumentList @((Join-Path $flatRoot "decoy.mjs"), (Join-Path $flatRoot "broker.mjs")) -PassThru -WindowStyle Hidden
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

    $updaterTokens = $null
    $updaterErrors = $null
    $updaterAst = [System.Management.Automation.Language.Parser]::ParseFile($updaterPath, [ref]$updaterTokens, [ref]$updaterErrors)
    if ($updaterErrors.Count -gt 0) { throw "Cannot parse updater for port-release regression coverage." }
    foreach ($functionName in @("Test-TcpPortAccepting", "Wait-BrokerPortReleased")) {
        $functionAst = $updaterAst.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName
        }, $true)
        if (-not $functionAst) { throw "Updater is missing $functionName." }
        Invoke-Expression $functionAst.Extent.Text
    }
    $portHolderScript = Join-Path $testRoot "temporary-port-holder.mjs"
    $portHolderReady = Join-Path $testRoot "temporary-port-holder.ready"
    Set-Content -LiteralPath $portHolderScript -Encoding UTF8 -Value @'
import fs from "node:fs";
import net from "node:net";
const port = Number(process.argv[2]);
const ready = process.argv[3];
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(port, "127.0.0.1", () => {
  fs.writeFileSync(ready, "ready");
  setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
  }, 500);
});
'@
    $portHolder = Start-Process -FilePath $nodeExePath -ArgumentList @($portHolderScript, "19479", $portHolderReady) -PassThru -WindowStyle Hidden
    $processIds.Add($portHolder.Id)
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(2)
    while (-not (Test-Path -LiteralPath $portHolderReady) -and [DateTime]::UtcNow -lt $readyDeadline) { Start-Sleep -Milliseconds 25 }
    if (-not (Test-Path -LiteralPath $portHolderReady)) { throw "Temporary port holder did not start." }
    $portWait = [System.Diagnostics.Stopwatch]::StartNew()
    Wait-BrokerPortReleased -Port 19479 -TimeoutSeconds 2
    $portWait.Stop()
    if ($portWait.ElapsedMilliseconds -lt 250) { throw "Port release guard did not wait for a lingering listener." }

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
        $oldEndpointConfigHash = Get-Sha256 (Join-Path $root "endpoint-config.mjs")
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
        if ((Get-Sha256 (Join-Path $root "endpoint-config.mjs")) -ne $oldEndpointConfigHash) { throw "Rollback case $caseIndex did not restore endpoint-config.mjs state." }
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
    if ((Get-Sha256 (Join-Path $successRoot "endpoint-config.mjs")) -ne (Get-Sha256 (Join-Path $healthySource "endpoint-config.mjs"))) { throw "Successful update did not install candidate endpoint-config.mjs." }
    foreach ($name in @("Start-CodexMcpBroker.ps1", "Stop-CodexMcpBroker.ps1")) {
        if (-not (Test-Path -LiteralPath (Join-Path $successRoot $name) -PathType Leaf)) { throw "Successful update did not retain $name." }
    }
    Stop-FlatBroker -Root $successRoot

    $routerStateRoot = Join-Path $testRoot "router-state"
    Initialize-Target -Root $routerStateRoot -OldSource $oldSource -Port 19494 -StartExists $true -StopExists $true
    $stableLedgerPath = Join-Path $routerStateRoot "task-registry.json"
    $routerRuntimePath = Join-Path $routerStateRoot "task-router-runtime.json"
    $routerLockPath = Join-Path $routerStateRoot "task-router.lock"
    Set-Content -LiteralPath $stableLedgerPath -Encoding UTF8 -Value '{"stable":true}'
    [ordered]@{ pid = $PID; token = "wrong-process"; startedAt = "2026-08-12T00:00:00.000Z" } | ConvertTo-Json | Set-Content -LiteralPath $routerLockPath -Encoding UTF8
    Write-TaskRouterRuntimeState -Path $routerRuntimePath -ProcessId $PID -LockPath $routerLockPath -InstanceToken "wrong-process"
    $wrongProcessFailed = $false
    try {
        & $updaterPath -SourceBrokerRoot $routerVolatileSource -BrokerRoot $routerStateRoot -BrokerPort 19494 -DeepHealthEndpoints @() -TaskRouterRuntimeStatePaths @($routerRuntimePath) -WhatIf | Out-Null
    } catch {
        $wrongProcessFailed = $_.Exception.Message.Contains("not a running Node process")
    }
    if (-not $wrongProcessFailed) { throw "Updater accepted a non-router process from runtime state." }
    $null = Start-MockTaskRouter -RuntimePath $routerRuntimePath -LockPath $routerLockPath
    $misclassifiedFailed = $false
    try {
        & $updaterPath -SourceBrokerRoot $routerVolatileSource -BrokerRoot $routerStateRoot -BrokerPort 19494 -DeepHealthEndpoints @() -ProtectedStatePaths @($routerRuntimePath) -WhatIf | Out-Null
    } catch {
        $misclassifiedFailed = $_.Exception.Message.Contains("cannot use byte-for-byte ProtectedStatePaths")
    }
    if (-not $misclassifiedFailed) { throw "Updater did not reject volatile task router state from byte protection." }
    $unhealthyRuntime = Get-Content -LiteralPath $routerRuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $unhealthyRuntime.inFlightScan = $true
    $unhealthyRuntime | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $routerRuntimePath -Encoding UTF8
    $inFlightFailed = $false
    try {
        & $updaterPath -SourceBrokerRoot $routerVolatileSource -BrokerRoot $routerStateRoot -BrokerPort 19494 -DeepHealthEndpoints @() -TaskRouterRuntimeStatePaths @($routerRuntimePath) -WhatIf | Out-Null
    } catch {
        $inFlightFailed = $_.Exception.Message.Contains("in-flight scan")
    }
    if (-not $inFlightFailed) { throw "Updater accepted an in-flight task router scan." }
    $unhealthyRuntime.inFlightScan = $false
    $unhealthyRuntime | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $routerRuntimePath -Encoding UTF8
    $stableLedgerHash = Get-Sha256 $stableLedgerPath
    $runtimeBefore = Get-Content -LiteralPath $routerRuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $previousRouterRuntime = [Environment]::GetEnvironmentVariable("BROKER_TEST_ROUTER_RUNTIME", "Process")
    try {
        [Environment]::SetEnvironmentVariable("BROKER_TEST_ROUTER_RUNTIME", $routerRuntimePath, "Process")
        & $updaterPath -SourceBrokerRoot $routerVolatileSource -BrokerRoot $routerStateRoot -BrokerPort 19494 -DeepHealthEndpoints @() -ProtectedStatePaths @($stableLedgerPath) -TaskRouterRuntimeStatePaths @($routerRuntimePath) -StartupTimeoutSeconds 2 | Out-Null
    } finally {
        [Environment]::SetEnvironmentVariable("BROKER_TEST_ROUTER_RUNTIME", $previousRouterRuntime, "Process")
    }
    $runtimeAfter = Get-Content -LiteralPath $routerRuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($runtimeAfter.instanceToken -ne $runtimeBefore.instanceToken -or $runtimeAfter.pid -ne $runtimeBefore.pid) { throw "Volatile router update changed stable identity fields." }
    if ($runtimeAfter.updatedAt -eq $runtimeBefore.updatedAt -or $runtimeAfter.openTaskCount -eq $runtimeBefore.openTaskCount -or $runtimeAfter.keepAlive -ne $false) { throw "Volatile router fixture did not exercise semantic protection." }
    if ((Get-Sha256 $stableLedgerPath) -ne $stableLedgerHash) { throw "Byte-protected stable ledger changed during router semantic test." }
    Stop-FlatBroker -Root $routerStateRoot

    $routerFailureRoot = Join-Path $testRoot "router-identity-rollback"
    Initialize-Target -Root $routerFailureRoot -OldSource $oldSource -Port 19495 -StartExists $true -StopExists $true
    $routerFailureRuntimePath = Join-Path $routerFailureRoot "task-router-runtime.json"
    $routerFailureLockPath = Join-Path $routerFailureRoot "task-router.lock"
    $null = Start-MockTaskRouter -RuntimePath $routerFailureRuntimePath -LockPath $routerFailureLockPath
    $routerFailureBrokerHash = Get-Sha256 (Join-Path $routerFailureRoot "broker.mjs")
    $previousRouterRuntime = [Environment]::GetEnvironmentVariable("BROKER_TEST_ROUTER_RUNTIME", "Process")
    $routerIdentityFailed = $false
    try {
        [Environment]::SetEnvironmentVariable("BROKER_TEST_ROUTER_RUNTIME", $routerFailureRuntimePath, "Process")
        try {
            & $updaterPath -SourceBrokerRoot $routerIdentityFailureSource -BrokerRoot $routerFailureRoot -BrokerPort 19495 -DeepHealthEndpoints @() -TaskRouterRuntimeStatePaths @($routerFailureRuntimePath) -StartupTimeoutSeconds 2 | Out-Null
        } catch {
            $routerIdentityFailed = $_.Exception.Message.Contains("rollback was incomplete") -and $_.Exception.Message.Contains("lock identity does not match")
        }
    } finally {
        [Environment]::SetEnvironmentVariable("BROKER_TEST_ROUTER_RUNTIME", $previousRouterRuntime, "Process")
    }
    if (-not $routerIdentityFailed) { throw "Router identity failure did not expose the incomplete runtime rollback boundary." }
    Wait-Health -Port 19495
    if ((Get-Sha256 (Join-Path $routerFailureRoot "broker.mjs")) -ne $routerFailureBrokerHash) { throw "Router identity failure did not restore broker.mjs." }
    $routerFailureAfter = Get-Content -LiteralPath $routerFailureRuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($routerFailureAfter.instanceToken -ne "unexpected-router-instance") { throw "Router identity failure unexpectedly rewrote volatile runtime state." }
    Stop-FlatBroker -Root $routerFailureRoot

    $deepRetryRoot = Join-Path $testRoot "deep-retry"
    Initialize-Target -Root $deepRetryRoot -OldSource $oldSource -Port 19493 -StartExists $true -StopExists $true
    & $updaterPath -SourceBrokerRoot $transientDeepSource -BrokerRoot $deepRetryRoot -BrokerPort 19493 -DeepHealthEndpoints @("napcat") -StartupTimeoutSeconds 3 | Out-Null
    $deepAttemptCount = @((Get-Content -LiteralPath (Join-Path $deepRetryRoot "probe.log") -Encoding UTF8) | Where-Object { $_ -eq "deep" }).Count
    if ($deepAttemptCount -lt 3) { throw "Updater did not retry transient deep health failures." }
    Stop-FlatBroker -Root $deepRetryRoot

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
        if ((Get-Sha256 (Join-Path $managedRoot "endpoint-config.mjs")) -ne (Get-Sha256 (Join-Path $healthySource "endpoint-config.mjs"))) { throw "Managed update did not install endpoint-config.mjs at the manifest path." }
        $managedBrokerHash = Get-Sha256 (Join-Path $managedRoot "broker.mjs")
        $managedEndpointConfigHash = Get-Sha256 (Join-Path $managedRoot "endpoint-config.mjs")
        $managedLifecycleHash = Get-Sha256 (Join-Path $managedRoot "request-lifecycle.mjs")
        $managedStartHash = Get-Sha256 $managedStartScript
        $managedStopHash = Get-Sha256 $managedStopScript
        $managedRuntimeRoot = Join-Path $testRoot "managed-data\mcp-http-broker"
        Set-Content -LiteralPath (Join-Path $managedRuntimeRoot "broker.log") -Encoding UTF8 -Value '{"message":"candidate diagnostic evidence"}'
        $managedRollbackFailed = $false
        try {
            & $updaterPath -SourceBrokerRoot $unhealthySource -BrokerPort 19491 -DeepHealthEndpoints @() -StartupTimeoutSeconds 1 | Out-Null
        } catch {
            $managedRollbackFailed = $_.Exception.Message.Contains("previous code was restored")
        }
        if (-not $managedRollbackFailed) { throw "Managed release rollback case unexpectedly succeeded or did not verify restoration." }
        $managedBackupRoot = Get-ChildItem -LiteralPath (Join-Path $managedRoot "backups") -Directory |
            Sort-Object LastWriteTimeUtc |
            Select-Object -Last 1
        foreach ($evidenceName in @("candidate-start-output.txt", "candidate-process.json", "candidate-broker-stdout.log", "candidate-broker-stderr.log", "candidate-broker.log")) {
            if (-not (Test-Path -LiteralPath (Join-Path $managedBackupRoot.FullName $evidenceName) -PathType Leaf)) {
                throw "Managed rollback did not preserve startup evidence: $evidenceName"
            }
        }
        Wait-Health -Port 19491
        if ((Get-Sha256 (Join-Path $managedRoot "broker.mjs")) -ne $managedBrokerHash) { throw "Managed rollback did not restore broker.mjs." }
        if ((Get-Sha256 (Join-Path $managedRoot "endpoint-config.mjs")) -ne $managedEndpointConfigHash) { throw "Managed rollback did not restore endpoint-config.mjs." }
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
    if (Test-Path -LiteralPath (Join-Path $oldSource "endpoint-config.mjs") -PathType Leaf) {
        Copy-Item -LiteralPath (Join-Path $oldSource "endpoint-config.mjs") -Destination (Join-Path $wrongRoot "endpoint-config.mjs") -Force
    }
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

    Write-Output "Codex MCP broker lifecycle portability, WhatIf, deep-health retry, stable and volatile state protection, rollback, managed release, identity guard, and success tests passed."
} finally {
    foreach ($processId in $processIds) {
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            & taskkill.exe /PID $processId /T /F | Out-Null
        }
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable("CODEX_TOOLKIT_NODE_EXE", $previousNodeExe, "Process")
}
