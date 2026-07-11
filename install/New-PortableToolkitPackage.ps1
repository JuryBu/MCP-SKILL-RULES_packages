param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$ArchiveName = "Portable-MCP-SKILL-RULES-Toolkit.zip"
)

$ErrorActionPreference = "Stop"
$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$resolvedToolkitRoot = (Resolve-Path -LiteralPath $toolkitRoot).Path
$outputFullPath = [System.IO.Path]::GetFullPath($OutputDirectory)

if ($outputFullPath.StartsWith($resolvedToolkitRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDirectory must be outside the source repository."
}
if (Test-Path -LiteralPath $outputFullPath) {
    throw "OutputDirectory already exists. Choose an empty new path: $outputFullPath"
}

& (Join-Path $toolkitRoot "install\Test-CodexToolkit.ps1") -PackageClean
if ($LASTEXITCODE -ne 0) { throw "Package-clean verification failed." }

$allowedRootEntries = @(
    ".gitignore", "LICENSE", "PACKAGE_MANIFEST.md", "PRIVATE_EXCLUDE_CHECKLIST.md", "README.md",
    "SETUP.md", "TOOLKIT_README.md", "design-tests", "install", "mcps", "rules", "skills", "templates"
)
$excludeDirectories = @(
    ".git", "node_modules", "dist", "build", "coverage", "sandbox-data", "subagent-data", "sessions",
    "archived_sessions", "workspaces", "profiles", "browser-profile", "web-fetcher-profiles", "user-data-dir",
    "cookies", "localstorage", "indexeddb", "archive", "handoff", ".codex-toolkit", ".playwright-mcp",
    "tmp", "temp", "logs", ".cache", "__pycache__", "playwright-report", "test-results",
    "council-artifacts", "council-tasks", "council-quarantine", "council-indexes",
    "council-large-inputs", "council-model-calls", "agy-runtime"
)
$excludeNames = @(
    "broker-private.env.json", "auth.json", ".cockpit_codex_auth.json", "credentials.json",
    ".credentials.json", "token.json", "tokens.json", ".env", ".env.local", ".env.production",
    ".env.development", "cookies", "cookie", "web data", "login data", "local state"
)

New-Item -ItemType Directory -Path $outputFullPath -Force | Out-Null
foreach ($rootEntry in $allowedRootEntries) {
    $sourceEntry = Join-Path $resolvedToolkitRoot $rootEntry
    if (-not (Test-Path -LiteralPath $sourceEntry)) { throw "Missing allow-listed package entry: $sourceEntry" }
    $files = if (Test-Path -LiteralPath $sourceEntry -PathType Leaf) {
        @(Get-Item -LiteralPath $sourceEntry -Force)
    } else {
        @(Get-ChildItem -LiteralPath $sourceEntry -Recurse -File -Force)
    }
    $files | ForEach-Object {
    $relative = $_.FullName.Substring($resolvedToolkitRoot.Length).TrimStart("\")
    $parts = $relative.Split("\")
    if ($parts | Where-Object { $_ -in $excludeDirectories }) { return }
    $lowerName = $_.Name.ToLowerInvariant()
    if ($lowerName -in $excludeNames -or $lowerName -like "broker-private*.json" -or $lowerName -like ".env.*" -or $lowerName -match '\.env($|\.)' -or $lowerName -match '\.(cookie|cookies|session)$' -or $_.Name -match '\.(log|sqlite3?|db|jsonl|har|vscdb|pb|pem|key|p12|pfx|bak)$' -or $_.Name -like "*.before-*") { return }
    $target = Join-Path $outputFullPath $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target
    }
}

& (Join-Path $outputFullPath "install\Test-CodexToolkit.ps1") -PackageClean
if ($LASTEXITCODE -ne 0) { throw "Copied package verification failed." }

$archivePath = Join-Path (Split-Path -Parent $outputFullPath) $ArchiveName
if (Test-Path -LiteralPath $archivePath) { throw "Archive already exists: $archivePath" }
Compress-Archive -Path (Join-Path $outputFullPath "*") -DestinationPath $archivePath -CompressionLevel Optimal

$hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
Write-Output "Package directory: $outputFullPath"
Write-Output "Archive: $archivePath"
Write-Output "SHA256: $($hash.Hash)"
