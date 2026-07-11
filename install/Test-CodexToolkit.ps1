param(
    [switch]$PackageClean,
    [switch]$IncludeOptionalEndpoints
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

function Get-TextFiles {
    $extensions = @(".md", ".txt", ".json", ".jsonc", ".toml", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".ps1", ".cmd", ".bat", ".html", ".css", ".env")
    $extensionlessTextNames = @("LICENSE", "NOTICE", "COPYING", ".env")
    return Get-ChildItem -LiteralPath $toolkitRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\dist\\|\\build\\|\\coverage\\' -and
            $_.Length -le 5MB -and (
                $_.Extension.ToLowerInvariant() -in $extensions -or
                $_.Name -in $extensionlessTextNames -or
                $_.Name -like ".env.*"
            )
        }
}

function Test-PrivatePatterns {
    $patterns = @(Get-PrivatePatterns)
    if ($patterns.Count -eq 0) {
        Write-Output "Custom private pattern check not configured."
        return
    }

    Write-Output "Checking custom private patterns..."
    $hits = foreach ($file in Get-TextFiles) {
        Select-String -LiteralPath $file.FullName -Pattern $patterns -SimpleMatch -CaseSensitive -ErrorAction SilentlyContinue
    }
    if ($hits) {
        $hits | Select-Object Path, LineNumber, Line | Format-Table -AutoSize
        throw "Custom private pattern check failed."
    }
}

function Test-PortableText {
    Write-Output "Checking absolute user paths and credential-shaped text..."
    $regexes = @(
        'C:\\Users\\(?!<user>|USERNAME|YourName|Public)[^\\\s"'']+',
        '(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{16,}',
        '(?i)(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["''][A-Za-z0-9_./+=-]{24,}["'']'
    )
    $hits = foreach ($file in Get-TextFiles) {
        Select-String -LiteralPath $file.FullName -Pattern $regexes -ErrorAction SilentlyContinue
    }
    if ($hits) {
        $hits | Select-Object Path, LineNumber, Line | Format-Table -AutoSize
        throw "Portable text check failed."
    }
}

function Test-ForbiddenRuntimeFiles {
    Write-Output "Checking forbidden runtime and credential files..."
    $exactNames = @(
        "auth.json", ".cockpit_codex_auth.json", "cookies-backup.json", "localstorage-backup.json",
        "credentials.json", ".credentials.json", "token.json", "tokens.json", "broker-private.env.json",
        ".env", ".env.local", ".env.production", ".env.development", "cookies", "cookie",
        "web data", "login data", "local state"
    )
    $badFiles = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $lowerName = $_.Name.ToLowerInvariant()
            $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\dist\\|\\build\\|\\coverage\\' -and (
                $lowerName -in $exactNames -or
                $lowerName -like "broker-private*.json" -or
                $lowerName -like ".env.*" -or
                $lowerName -match '\.env($|\.)' -or
                $lowerName -match '\.(cookie|cookies|session)$' -or
                $_.Name -match '\.(sqlite|sqlite3|db)(-wal|-shm)?$' -or
                $_.Name -match '\.(jsonl|har|vscdb|pb|pem|key|p12|pfx|log|bak)$' -or
                $_.Name -like "*.before-*"
            )
        }
    if ($badFiles) {
        $badFiles | Select-Object FullName | Format-Table -AutoSize
        throw "Forbidden runtime file check failed."
    }
}

function Test-ExcludedDirectories {
    param([switch]$StrictPackage)
    Write-Output "Checking excluded directories..."
    $names = @(
        "sessions", "archived_sessions", "workspaces", "sandbox-data", "subagent-data", ".test-data",
        "ms-playwright", "__pycache__", ".cache", "logs", "tmp", "temp", "profiles", "browser-profile",
        "web-fetcher-profiles", "user-data-dir", "playwright-report", "test-results", "cookies",
        "localstorage", "indexeddb", "archive", "handoff", ".codex-toolkit", ".playwright-mcp",
        "council-artifacts", "council-tasks", "council-quarantine", "council-indexes",
        "council-large-inputs", "council-model-calls", "agy-runtime"
    )
    if ($StrictPackage) {
        $names += @("node_modules", "dist", "build", "coverage")
    }
    $badDirs = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\.git(\\|$)' -and $_.Name -in $names }
    if ($badDirs) {
        $badDirs | Select-Object FullName | Format-Table -AutoSize
        throw "Excluded directory check failed."
    }
}

function Test-PackageRootAllowList {
    $allowedRootEntries = @(
        ".gitignore", "LICENSE", "PACKAGE_MANIFEST.md", "PRIVATE_EXCLUDE_CHECKLIST.md", "README.md",
        "SETUP.md", "TOOLKIT_README.md", "design-tests", "install", "mcps", "rules", "skills", "templates"
    )
    $unexpected = Get-ChildItem -LiteralPath $toolkitRoot -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne ".git" -and $_.Name -notin $allowedRootEntries }
    if ($unexpected) {
        $unexpected | Select-Object FullName | Format-Table -AutoSize
        throw "Unexpected root entry outside the portable package allow-list."
    }
}

function Test-PackageStructure {
    Write-Output "Checking package structure..."
    foreach ($name in @("memory-store", "web-fetcher", "sandbox", "broker", "mcp-subagent")) {
        $pkg = Join-Path $mcpRoot "$name\package.json"
        if (-not (Test-Path -LiteralPath $pkg)) { throw "Missing MCP source package: $pkg" }
    }
    foreach ($name in @("memory-store", "web-fetcher", "sandbox")) {
        $packageJson = Get-Content -LiteralPath (Join-Path $mcpRoot "$name\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $packageJson.scripts.'test:portable') { throw "Missing portable build test script: $name" }
        $scriptText = $packageJson.scripts | ConvertTo-Json -Compress
        if ($scriptText -match 'tests[/\\]') { throw "Public package exposes an internal test path that is not bundled: $name" }
    }

    foreach ($path in @(
        "mcps\sandbox\src\council\agy-runtime.ts",
        "mcps\sandbox\src\council\artifact-gc.ts",
        "mcps\sandbox\src\council\artifact-store.ts",
        "mcps\sandbox\src\council\paths.ts"
    )) {
        $full = Join-Path $toolkitRoot $path
        if (-not (Test-Path -LiteralPath $full)) { throw "Missing Sandbox Council lifecycle source: $full" }
    }
    $sandboxPaths = Get-Content -LiteralPath (Join-Path $toolkitRoot "mcps\sandbox\src\council\paths.ts") -Raw -Encoding UTF8
    if (-not $sandboxPaths.Contains("process.env.SANDBOX_DATA_ROOT")) {
        throw "Portable Sandbox Council paths must follow SANDBOX_DATA_ROOT instead of the source tree."
    }

    foreach ($path in @(
        "rules\codex\AGENTS.template.md",
        "rules\codex\system-prompt.template.md",
        "rules\antigravity\GEMINI.template.md",
        "rules\claude-code\CLAUDE.template.md",
        "rules\windsurf\global_rules.template.md",
        "rules\windsurf\system_rules\tools.template.md",
        "rules\windsurf\system_rules\memory.template.md",
        "rules\windsurf\system_rules\collaboration.template.md",
        "rules\windsurf\system_rules\efficiency.template.md",
        "rules\windsurf\system_rules\rendering.template.md",
        "skills\skills_manifest.md",
        "templates\config.codex.toml",
        "templates\env.example.ps1"
    )) {
        $full = Join-Path $toolkitRoot $path
        if (-not (Test-Path -LiteralPath $full)) { throw "Missing required portable file: $full" }
    }

    $allowedSkills = @(
        "algorithmic-art", "brand-guidelines", "canvas-design", "frontend-design", "imagegen",
        "internal-comms", "jupyter-notebook", "mcp-builder", "pdf", "playwright", "screenshot",
        "skill-creator", "slack-gif-creator", "theme-factory", "webapp-testing", "web-artifacts-builder"
    )
    $skillDirs = @(Get-ChildItem -LiteralPath (Join-Path $toolkitRoot "skills") -Directory -Force)
    $actualSkills = @($skillDirs | ForEach-Object { $_.Name } | Sort-Object)
    $expectedSkills = @($allowedSkills | Sort-Object)
    if (Compare-Object -ReferenceObject $expectedSkills -DifferenceObject $actualSkills) {
        throw "Portable skills differ from the independent allow-list."
    }
    $manifestText = Get-Content -LiteralPath (Join-Path $toolkitRoot "skills\skills_manifest.md") -Raw -Encoding UTF8
    foreach ($skill in $skillDirs) {
        if (-not (Test-Path -LiteralPath (Join-Path $skill.FullName "SKILL.md"))) {
            throw "Portable skill missing SKILL.md: $($skill.Name)"
        }
        if ($manifestText -notmatch [regex]::Escape("| ``$($skill.Name)`` |")) {
            throw "Skill missing from manifest: $($skill.Name)"
        }
    }
    Write-Output "Portable skills verified: $($skillDirs.Count)"

    foreach ($jsonPath in @("templates\config.antigravity.example.json", "templates\config.claude.example.json", "templates\config.windsurf.example.json", "templates\config.windsurf.subagent.example.json")) {
        $jsonFullPath = Join-Path $toolkitRoot $jsonPath
        $jsonText = Get-Content -LiteralPath $jsonFullPath -Raw -Encoding UTF8
        if ($jsonText.Length -gt 0 -and [int]$jsonText[0] -eq 0xFEFF) { throw "JSON template contains a UTF-8 BOM: $jsonFullPath" }
        $jsonText | ConvertFrom-Json | Out-Null
    }
    $codexConfig = Get-Content -LiteralPath (Join-Path $toolkitRoot "templates\config.codex.toml") -Raw -Encoding UTF8
    foreach ($requiredBlock in @("[mcp_servers.memory-store]", "[mcp_servers.web-fetcher]", "[mcp_servers.sandbox]")) {
        if (-not $codexConfig.Contains($requiredBlock)) { throw "Codex config template missing block: $requiredBlock" }
    }
}

Test-PrivatePatterns
Test-PortableText
Test-ForbiddenRuntimeFiles
Test-ExcludedDirectories -StrictPackage:$PackageClean
Test-PackageStructure

if ($PackageClean) {
    Test-PackageRootAllowList
    Write-Output "Portable toolkit package-clean check completed."
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
    if ($LASTEXITCODE -ne 0) { throw "Broker syntax check failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Output "Checking broker health..."
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 5 | ConvertTo-Json -Depth 6
} catch {
    throw "Broker health check failed. Start it with install\Start-CodexMcpBroker.ps1. $($_.Exception.Message)"
}

if (-not $env:CODEX_TOOLKIT_MCP_BASE_URL) { $env:CODEX_TOOLKIT_MCP_BASE_URL = "http://127.0.0.1:$port" }
if ($IncludeOptionalEndpoints) { $env:CODEX_TOOLKIT_SMOKE_OPTIONAL = "1" }
node (Join-Path $toolkitRoot "design-tests\smoke-mcp-http.mjs")
if ($LASTEXITCODE -ne 0) { throw "MCP HTTP smoke test failed with exit code $LASTEXITCODE" }

Write-Output "Portable toolkit smoke test completed."
