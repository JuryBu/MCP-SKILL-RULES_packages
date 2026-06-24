param(
    [switch]$PackageClean
)


$ErrorActionPreference = "Stop"
$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$mcpRoot = Join-Path $toolkitRoot "mcps"
$port = if ($env:CODEX_MCP_BROKER_PORT) { $env:CODEX_MCP_BROKER_PORT } else { "14588" }

function Get-PrivatePatterns {
    if (-not $env:CODEX_TOOLKIT_PRIVATE_PATTERNS) { return @() }
    return $env:CODEX_TOOLKIT_PRIVATE_PATTERNS.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_.Length -gt 0 }
}

function Test-PrivatePatterns {
    $patterns = @(Get-PrivatePatterns)
    if ($patterns.Count -eq 0) {
        Write-Output "Skipping custom private pattern check. Set CODEX_TOOLKIT_PRIVATE_PATTERNS to enable it."
        return
    }

    Write-Output "Checking custom private patterns..."
    $files = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\package-lock\.json$' }
    $hits = foreach ($file in $files) {
        Select-String -LiteralPath $file.FullName -Pattern $patterns -SimpleMatch -CaseSensitive -ErrorAction SilentlyContinue
    }
    if ($hits) {
        $hits | Select-Object Path, LineNumber, Line | Format-Table -AutoSize
        throw "Custom private pattern check failed."
    }
}

function Test-ForbiddenRuntimeFiles {
    Write-Output "Checking forbidden runtime files..."
    $badFiles = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -in @("auth.json", ".cockpit_codex_auth.json", "cookies-backup.json", "localstorage-backup.json") -or
            $_.Name -like "*.sqlite" -or
            $_.Name -like "*.sqlite-wal" -or
            $_.Name -like "*.sqlite-shm" -or
            $_.Name -like "*.db" -or
            $_.Name -like "*.db-wal" -or
            $_.Name -like "*.db-shm" -or
            $_.Name -like "*.jsonl" -or
            $_.Name -like "*.har"
        }
    if ($badFiles) {
        $badFiles | Select-Object FullName | Format-Table -AutoSize
        throw "Forbidden runtime file check failed."
    }
}

function Test-ExcludedDirectories {
    param([switch]$StrictPackage)
    Write-Output "Checking excluded directories..."
    $names = @("sessions", "archived_sessions", "workspaces", "sandbox-data", ".test-data", "ms-playwright", "__pycache__", ".git", ".cache", "logs", "tmp", "temp", "playwright-report", "test-results")
    if ($StrictPackage) {
        $names += @("node_modules", "dist", "build", "coverage")
    }
    $badDirs = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in $names }
    if ($badDirs) {
        $badDirs | Select-Object FullName | Format-Table -AutoSize
        throw "Excluded directory check failed."
    }
}

Test-PrivatePatterns
Test-ForbiddenRuntimeFiles
Test-ExcludedDirectories -StrictPackage:$PackageClean

if ($PackageClean) {
    foreach ($name in @("memory-store", "web-fetcher", "sandbox", "broker", "mcp-subagent")) {
        $pkg = Join-Path $mcpRoot "$name\package.json"
        if (-not (Test-Path -LiteralPath $pkg)) {
            throw "Missing MCP source package: $pkg"
        }
    }
    Write-Output "Portable Codex toolkit package-clean check completed."
    exit 0
}

Write-Output "Checking build outputs..."
foreach ($name in @("memory-store", "web-fetcher", "sandbox")) {
    $distIndex = Join-Path $mcpRoot "$name\dist\index.js"
    if (-not (Test-Path -LiteralPath $distIndex)) {
        throw "Missing build output. Run Install-CodexToolkit.ps1 first: $distIndex"
    }
}

Push-Location (Join-Path $mcpRoot "broker")
try {
    npm run check
    if ($LASTEXITCODE -ne 0) {
        throw "Broker syntax check failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

Write-Output "Checking broker health..."
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 5 | ConvertTo-Json -Depth 6
} catch {
    throw "Broker health check failed. Start it with install\Start-CodexMcpBroker.ps1. $($_.Exception.Message)"
}

Write-Output "Checking MCP endpoints..."
if (-not $env:CODEX_TOOLKIT_MCP_BASE_URL) {
    $env:CODEX_TOOLKIT_MCP_BASE_URL = "http://127.0.0.1:$port"
}
node (Join-Path $toolkitRoot "design-tests\smoke-mcp-http.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "MCP HTTP smoke test failed with exit code $LASTEXITCODE"
}

Write-Output "Portable Codex toolkit smoke test completed."

