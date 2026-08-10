$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolkitRoot = Split-Path -Parent $installRoot
$sourceBrokerRoot = Join-Path $toolkitRoot "mcps\broker"
$updaterPath = Join-Path $installRoot "Update-CodexMcpBroker.ps1"
$startScriptPath = Join-Path $installRoot "Start-CodexMcpBroker.ps1"
$stopScriptPath = Join-Path $installRoot "Stop-CodexMcpBroker.ps1"
$testRoot = Join-Path $env:TEMP ("codex-broker-lifecycle-test-" + [guid]::NewGuid())
$probeRoot = Join-Path $testRoot "probe"
$flatRoot = Join-Path $testRoot "flat"
$testProcessId = $null

try {
    New-Item -ItemType Directory -Force -Path $probeRoot, $flatRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceBrokerRoot "broker.mjs") -Destination (Join-Path $probeRoot "broker.mjs") -Force
    Copy-Item -LiteralPath (Join-Path $sourceBrokerRoot "request-lifecycle.mjs") -Destination (Join-Path $probeRoot "request-lifecycle.mjs") -Force

    $probeOutput = & $updaterPath -SourceBrokerRoot $sourceBrokerRoot -BrokerRoot $probeRoot -DeepHealthEndpoints @() -WhatIf 2>&1 | Out-String
    if (-not $probeOutput.Contains('"lifecycleBootstrap":  true')) {
        throw "Updater WhatIf did not report lifecycle bootstrap support."
    }
    if (Test-Path -LiteralPath (Join-Path $probeRoot "backups")) {
        throw "Updater WhatIf created a backup directory."
    }
    if (Test-Path -LiteralPath (Join-Path $probeRoot "Stop-CodexMcpBroker.ps1")) {
        throw "Updater WhatIf modified a target that lacked lifecycle scripts."
    }

    Copy-Item -LiteralPath $startScriptPath -Destination (Join-Path $flatRoot "Start-CodexMcpBroker.ps1") -Force
    Copy-Item -LiteralPath $stopScriptPath -Destination (Join-Path $flatRoot "Stop-CodexMcpBroker.ps1") -Force
    Set-Content -LiteralPath (Join-Path $flatRoot "broker.mjs") -Encoding UTF8 -Value "setInterval(() => {}, 1000);"

    & (Join-Path $flatRoot "Start-CodexMcpBroker.ps1") | Out-Null
    Start-Sleep -Milliseconds 300
    $testProcessId = [int](Get-Content -LiteralPath (Join-Path $flatRoot "broker.pid") -Encoding UTF8 | Select-Object -First 1)
    $testProcess = Get-Process -Id $testProcessId -ErrorAction SilentlyContinue
    if (-not $testProcess -or $testProcess.ProcessName -ne "node") {
        throw "Flat lifecycle start script did not launch its sibling broker.mjs."
    }

    & (Join-Path $flatRoot "Stop-CodexMcpBroker.ps1") | Out-Null
    Start-Sleep -Milliseconds 300
    if (Get-Process -Id $testProcessId -ErrorAction SilentlyContinue) {
        throw "Flat lifecycle stop script did not stop its sibling broker.mjs."
    }
    if (Test-Path -LiteralPath (Join-Path $flatRoot "broker.pid")) {
        throw "Flat lifecycle stop script left a stale pid file."
    }

    Write-Output "Codex MCP broker lifecycle portability test passed."
} finally {
    if ($testProcessId -and (Get-Process -Id $testProcessId -ErrorAction SilentlyContinue)) {
        & taskkill.exe /PID $testProcessId /T /F | Out-Null
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
