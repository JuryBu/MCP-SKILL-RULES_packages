param(
    [switch]$PackageClean,
    [switch]$IncludeOptionalEndpoints,
    [switch]$IncludeNapCatEndpoint
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
        '(?i)C:[\\/]+Users[\\/]+(?!<user>|USERNAME|YourName|Public|ExampleUser)[^\\/\s"'']+',
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
        "web data", "login data", "local state", "binding.json", "heartbeat.json", "local-overrides.md",
        "heartbeat-runtime.json", "heartbeat.stop", "qrcode.png", ".codex-empty-input",
        "broker-state.json", "broker.pid", "dedupe.json", "dedupe-state.json", "task-registry.json",
        "router-runtime.json", "task-router-runtime.json", "supervisor-runtime.json", "napcat-runtime.json"
    )
    $badFiles = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $lowerName = $_.Name.ToLowerInvariant()
            $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\dist\\|\\build\\|\\coverage\\' -and (
                $lowerName -in $exactNames -or
                $lowerName -like "broker-private*.json" -or
                $lowerName -like ".env.*" -or
                $lowerName -match '\.env($|\.)' -or
                $lowerName -match '\.(cookie|cookies|session|pid)$' -or
                $lowerName -match '(^|[-_.])(state|runtime)\.json$' -or
                $_.Name -match '\.(sqlite|sqlite3|db)(-wal|-shm)?$' -or
                $_.Name -match '\.(jsonl|har|vscdb|pb|pem|key|p12|pfx|log|bak|zip|7z|exe|dll)$' -or
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
        "output-artifacts", "council-artifacts", "council-tasks", "council-quarantine", "council-indexes",
        "council-large-inputs", "council-model-calls", "agy-runtime", "state", "napcat-runtime"
    )
    if ($StrictPackage) {
        $names += @("node_modules", "dist", "build", "coverage")
    }
    $badDirs = Get-ChildItem -LiteralPath $toolkitRoot -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $relative = $_.FullName.Substring($toolkitRoot.Length).TrimStart("\")
            $_.FullName -notmatch '\\.git(\\|$)' -and
                $_.Name -in $names -and
                $relative -ne "rules\codex\profiles"
        }
    if ($badDirs) {
        $badDirs | Select-Object FullName | Format-Table -AutoSize
        throw "Excluded directory check failed."
    }
}

function Test-PackageRootAllowList {
    $allowedRootEntries = @(
        ".github", ".gitignore", "LICENSE", "PACKAGE_MANIFEST.md", "PRIVATE_EXCLUDE_CHECKLIST.md", "README.md",
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
    foreach ($name in @("memory-store", "web-fetcher", "sandbox", "broker", "mcp-subagent", "napcat-mcp")) {
        $pkg = Join-Path $mcpRoot "$name\package.json"
        if (-not (Test-Path -LiteralPath $pkg)) { throw "Missing MCP source package: $pkg" }
    }
    foreach ($name in @("memory-store", "web-fetcher", "sandbox")) {
        $packageJson = Get-Content -LiteralPath (Join-Path $mcpRoot "$name\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $packageJson.scripts.'test:portable') { throw "Missing portable build test script: $name" }
        $portableScriptText = [string]$packageJson.scripts.'test:portable'
        if ($portableScriptText -match 'tests[/\\]') { throw "Portable build test exposes an internal test path that is not bundled: $name" }
    }
    $napcatPackage = Get-Content -LiteralPath (Join-Path $mcpRoot "napcat-mcp\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $napcatPackage.scripts.check -or -not $napcatPackage.scripts.test) {
        throw "NapCat source package must expose both syntax and unit-test scripts."
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
    if (-not $sandboxPaths.Contains('import { TEMP_DIR } from "../temp-store.js"') -or -not $sandboxPaths.Contains("configuredRuntimeTempRoot() || TEMP_DIR")) {
        throw "Portable Sandbox Council paths must follow the shared temp-store data root instead of the source tree."
    }

    foreach ($path in @(
        "rules\codex\components\core.template.md",
        "rules\codex\components\catgirl.template.md",
        "rules\codex\components\development.template.md",
        "rules\codex\components\training.template.md",
        "rules\codex\profiles\neutral.profile.json",
        "rules\codex\profiles\catgirl.profile.json",
        "rules\codex\profiles\development.profile.json",
        "rules\codex\profiles\training.profile.json",
        "rules\codex\guidance\development-machine.template.md",
        "rules\codex\guidance\training-machine.template.md",
        "rules\codex\local-overrides.example.md",
        "rules\codex\system-prompt.template.md",
        "rules\antigravity\GEMINI.template.md",
        "rules\claude-code\CLAUDE.template.md",
        "rules\windsurf\global_rules.template.md",
        "rules\windsurf\system_rules\tools.template.md",
        "rules\windsurf\system_rules\memory.template.md",
        "rules\windsurf\system_rules\collaboration.template.md",
        "rules\windsurf\system_rules\efficiency.template.md",
        "rules\windsurf\system_rules\rendering.template.md",
        "mcps\napcat-mcp\binding.example.json",
        "mcps\napcat-mcp\heartbeat.example.json",
        "mcps\napcat-mcp\ops\start-napcat-login.ps1",
        "mcps\napcat-mcp\ops\start-napcat-heartbeat.ps1",
        "mcps\napcat-mcp\test\core.test.mjs",
        "skills\skills_manifest.md",
        "install\Start-CodexMcpBroker.ps1",
        "install\Stop-CodexMcpBroker.ps1",
        "install\Test-CodexMcpBrokerLifecycle.ps1",
        "install\Test-NapCatLegacyRollbackCompatibility.ps1",
        "install\Update-CodexMcpBroker.ps1",
        "install\rollback-napcat-mcp.ps1",
        "templates\config.codex.toml",
        "templates\env.example.ps1"
    )) {
        $full = Join-Path $toolkitRoot $path
        if (-not (Test-Path -LiteralPath $full)) { throw "Missing required portable file: $full" }
    }

    $brokerUpdater = Get-Content -LiteralPath (Join-Path $toolkitRoot "install\Update-CodexMcpBroker.ps1") -Encoding UTF8 -Raw
    foreach ($requiredText in @("SourceStartScript", "SourceStopScript", "ServiceManifestPath", "Assert-BrokerHealthIdentity", "RejectedProcessId", "lifecycleBootstrapped", "installedStartExisted", "installedStopExisted")) {
        if (-not $brokerUpdater.Contains($requiredText)) { throw "Broker updater is missing portable lifecycle bootstrap behavior: $requiredText" }
    }
    & (Join-Path $toolkitRoot "install\Test-CodexMcpBrokerLifecycle.ps1") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Broker lifecycle regression test failed." }
    & (Join-Path $toolkitRoot "install\Test-NapCatLegacyRollbackCompatibility.ps1") | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Legacy NapCat rollback compatibility test failed." }

    foreach ($path in @(
        "mcps\\napcat-mcp\\src\\codex-thread-bridge.mjs",
        "mcps\\napcat-mcp\\src\\codex-app-server-proxy.mjs",
        "mcps\\napcat-mcp\\src\\codex-app-server-proxy-runner.mjs",
        "mcps\\napcat-mcp\\src\\supervisor-runner.mjs",
        "mcps\\napcat-mcp\\src\\task-registry.mjs",
        "mcps\\napcat-mcp\\src\\task-router-controller.mjs",
        "mcps\\napcat-mcp\\src\\task-router-runner.mjs",
        "mcps\\napcat-mcp\\src\\task-router.mjs",
        "mcps\\napcat-mcp\\ops\\get-napcat-supervisor-status.ps1",
        "mcps\\napcat-mcp\\ops\\get-codex-app-server-proxy-status.ps1",
        "mcps\\napcat-mcp\\ops\\get-napcat-task-router-status.ps1",
        "mcps\\napcat-mcp\\ops\\enable-napcat-machine-ingress.ps1",
        "mcps\\napcat-mcp\\ops\\install-napcat-autostart.ps1",
        "mcps\\napcat-mcp\\ops\\remove-napcat-autostart.ps1",
        "mcps\\napcat-mcp\\ops\\reload-broker-backend.ps1",
        "mcps\\napcat-mcp\\ops\\rollback-codex-napcat-bridge.ps1",
        "mcps\\napcat-mcp\\ops\\Run-HiddenPowerShell.vbs",
        "mcps\\napcat-mcp\\ops\\Run-NapCatSupervisorWatchdog.ps1",
        "mcps\\napcat-mcp\\ops\\start-napcat-supervisor.ps1",
        "mcps\\napcat-mcp\\ops\\start-codex-app-server-proxy.ps1",
        "mcps\\napcat-mcp\\ops\\start-napcat-task-router.ps1",
        "mcps\\napcat-mcp\\ops\\stop-napcat-supervisor.ps1",
        "mcps\\napcat-mcp\\ops\\stop-codex-app-server-proxy.ps1",
        "mcps\\napcat-mcp\\ops\\stop-napcat-task-router.ps1",
        "mcps\\napcat-mcp\\ops\\update-codex-napcat-bridge.ps1",
        "mcps\\napcat-mcp\\package-lock.json",
        "mcps\\napcat-mcp\\test\\codex-app-server-proxy.test.mjs",
        "mcps\\napcat-mcp\\test\\codex-app-server-proxy-runner.test.mjs",
        "mcps\\napcat-mcp\\test\\codex-thread-bridge.test.mjs",
        "mcps\\napcat-mcp\\test\\index-task-tools.test.mjs",
        "mcps\\napcat-mcp\\test\\supervisor-runner.test.mjs",
        "mcps\\napcat-mcp\\test\\task-registry.test.mjs",
        "mcps\\napcat-mcp\\test\\task-router-controller.test.mjs",
        "mcps\\napcat-mcp\\test\\task-router-ledger.test.mjs",
        "mcps\\napcat-mcp\\test\\task-router-runner.test.mjs",
        "mcps\\napcat-mcp\\test\\task-router.test.mjs"
    )) {
        $full = Join-Path $toolkitRoot $path
        if (-not (Test-Path -LiteralPath $full)) { throw "Missing current NapCat task-routing file: $full" }
    }
    $napcatAutostart = Get-Content -LiteralPath (Join-Path $toolkitRoot "mcps\napcat-mcp\ops\install-napcat-autostart.ps1") -Raw -Encoding UTF8
    foreach ($requiredText in @("wscript.exe", "Run-HiddenPowerShell.vbs", "Run-NapCatSupervisorWatchdog.ps1", "RestartCount", "-BrokerRoot")) {
        if (-not $napcatAutostart.Contains($requiredText)) { throw "NapCat autostart is missing hidden watchdog behavior: $requiredText" }
    }
    $napcatWatchdog = Get-Content -LiteralPath (Join-Path $toolkitRoot "mcps\napcat-mcp\ops\Run-NapCatSupervisorWatchdog.ps1") -Raw -Encoding UTF8
    if (-not $napcatWatchdog.Contains('$StartArguments.BrokerRoot')) {
        throw "NapCat watchdog must forward the explicit broker root to the supervisor start script."
    }
    $napcatSupervisorStart = Get-Content -LiteralPath (Join-Path $toolkitRoot "mcps\napcat-mcp\ops\start-napcat-supervisor.ps1") -Raw -Encoding UTF8
    foreach ($requiredText in @("PortablePrivateEnvPath", "FlatPrivateEnvPath", "FlatBrokerStartScript")) {
        if (-not $napcatSupervisorStart.Contains($requiredText)) { throw "NapCat supervisor start script is missing flat/portable layout compatibility: $requiredText" }
    }
    $napcatAutostartRemoval = Get-Content -LiteralPath (Join-Path $toolkitRoot "mcps\napcat-mcp\ops\remove-napcat-autostart.ps1") -Raw -Encoding UTF8
    $napcatWatchdogStop = Get-Content -LiteralPath (Join-Path $toolkitRoot "mcps\napcat-mcp\ops\stop-napcat-supervisor-watchdog.ps1") -Raw -Encoding UTF8
    if (-not $napcatAutostart.Contains('& $StopWatchdogScript') -or
        -not $napcatAutostartRemoval.Contains('& $StopWatchdogScript') -or
        -not $napcatWatchdogStop.Contains("Stop-ScheduledTask")) {
        throw "NapCat autostart install/remove must stop an existing watchdog task before replacement or supervisor shutdown."
    }

    $configHelperPath = Join-Path $toolkitRoot "install\\CodexConfigHelpers.ps1"
    if (-not (Test-Path -LiteralPath $configHelperPath)) {
        throw "Missing Codex config helper: $configHelperPath"
    }
    . $configHelperPath
    foreach ($highLimit in @("131072", "131_072", "+131072")) {
        $preservedHighLimit = Set-CodexProjectDocMaxBytes -Content "project_doc_max_bytes = $highLimit" -MinimumBytes 65536
        if (-not $preservedHighLimit.Contains("project_doc_max_bytes = $highLimit")) {
            throw "Codex config helper lowered or rewrote an existing higher project document limit: $highLimit"
        }
    }
    $insertedRootLimit = Set-CodexProjectDocMaxBytes -Content "[features]`r`ntest_feature = true" -MinimumBytes 65536
    if ($insertedRootLimit.IndexOf("project_doc_max_bytes") -gt $insertedRootLimit.IndexOf("[features]")) {
        throw "Codex config helper inserted project_doc_max_bytes inside a TOML table."
    }
    $featureInput = @(
        'model_instructions_file = "D:/private/prompt.md"',
        "",
        "[features]",
        "test_feature = true",
        "default_mode_request_user_input = false",
        "",
        "[features.current_time_reminder]",
        "reminder_interval_seconds = 900",
        "",
        "[mcp_servers.private]",
        'url = "http://127.0.0.1:19999/mcp"'
    ) -join "`r`n"
    $recommendedFeatures = Set-CodexRecommendedDesktopFeatures -Content $featureInput
    $recommendedFeatures = Set-CodexRecommendedDesktopFeatures -Content $recommendedFeatures
    foreach ($requiredFeature in @(
        "default_mode_request_user_input = true",
        "concurrent_reasoning_summaries = true",
        "prevent_idle_sleep = true",
        "reminder_interval_seconds = 120",
        'clock_source = "system"',
        'delivery_mode = "after_user_or_tool_output"',
        "sleep_tool = false"
    )) {
        if (-not $recommendedFeatures.Contains($requiredFeature)) {
            throw "Codex Desktop feature helper did not apply: $requiredFeature"
        }
    }
    if (-not $recommendedFeatures.Contains("test_feature = true") -or
        -not $recommendedFeatures.Contains("[mcp_servers.private]")) {
        throw "Codex Desktop feature helper overwrote unrelated private configuration."
    }
    foreach ($tableName in @("features", "features.current_time_reminder")) {
        if ([regex]::Matches($recommendedFeatures, "(?m)^\[" + [regex]::Escape($tableName) + "\]\s*$").Count -ne 1) {
            throw "Codex Desktop feature helper duplicated [$tableName]."
        }
    }
    $modelPointer = Set-CodexModelInstructionsFile -Content $recommendedFeatures
    if ([regex]::Matches($modelPointer, "(?m)^model_instructions_file\s*=").Count -ne 1 -or
        -not $modelPointer.Contains('model_instructions_file = "~/.codex/prompts/system-prompt.md"')) {
        throw "Codex system prompt helper did not maintain one canonical model_instructions_file setting."
    }

    $utf8 = [System.Text.Encoding]::UTF8
    $timeboxHeading = $utf8.GetString([Convert]::FromBase64String("IyMjIOiuoeWIkuaXtumXtOebkg=="))
    $boundedFlexibility = $utf8.GetString([Convert]::FromBase64String("5pyJ6L6555WM55qE54G15rS75oCn"))
    $noForcedCutoff = $utf8.GetString([Convert]::FromBase64String("5LiN6IO95Y+q5Zug5Yiw5pe26KKr5by66KGM5omT5pat"))
    $noPassiveWaiting = $utf8.GetString([Convert]::FromBase64String("5LiN6IO95LiA55u0562J5Yiw6aKE566X6ICX5bC9"))
    $noMechanicalAnnotationReply = $utf8.GetString([Convert]::FromBase64String("5LiN6KaB6buY6K6k5py65qKw6L6T5Ye6"))
    $profileIds = @("neutral", "catgirl", "development", "training")
    $buildScript = Join-Path $toolkitRoot "install\Build-CodexRulesProfile.ps1"
    $profileTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-rules-profile-test-" + [guid]::NewGuid().ToString("N"))
    try {
        foreach ($profileId in $profileIds) {
            $outputRoot = Join-Path $profileTestRoot $profileId
            & $buildScript -Profile $profileId -OutputDirectory $outputRoot | Out-Null
            $agentsPath = Join-Path $outputRoot "AGENTS.md"
            if (-not (Test-Path -LiteralPath $agentsPath)) { throw "Profile did not produce AGENTS.md: $profileId" }
            if ((Get-Item -LiteralPath $agentsPath).Length -gt 65536) {
                throw "Profile exceeds the default installed 64K project document limit: $profileId"
            }
            $agentsText = Get-Content -LiteralPath $agentsPath -Raw -Encoding UTF8
            if (-not ($agentsText.Contains("stage_guard")) -or -not ($agentsText.Contains("sandbox_council"))) {
                throw "Profile lost shared engineering rules: $profileId"
            }
            if (
                -not ($agentsText.Contains($timeboxHeading)) -or
                -not ($agentsText.Contains($boundedFlexibility)) -or
                -not ($agentsText.Contains($noForcedCutoff)) -or
                -not ($agentsText.Contains($noPassiveWaiting))
            ) {
                throw "Profile lost bounded planning timebox rules: $profileId"
            }
            if (
                -not ($agentsText.Contains("response annotations")) -or
                -not ($agentsText.Contains($noMechanicalAnnotationReply))
            ) {
                throw "Profile lost natural response annotation rules: $profileId"
            }
            if ($profileId -eq "neutral" -and ($agentsText.Contains("kaomoji"))) {
                throw "Neutral profile unexpectedly contains the catgirl component."
            }
            if ($profileId -ne "neutral" -and -not ($agentsText.Contains("kaomoji"))) {
                throw "Catgirl profile is missing the catgirl component: $profileId"
            }
            if ($profileId -eq "development") {
                if (-not ($agentsText.Contains("local_role=development"))) { throw "Development profile missing its component." }
                if (-not (Test-Path -LiteralPath (Join-Path $outputRoot "guidance\development-machine.md"))) {
                    throw "Development profile missing generated guidance."
                }
            }
            if ($profileId -eq "training") {
                if (-not ($agentsText.Contains("local_role=training"))) { throw "Training profile missing its component." }
                if (-not (Test-Path -LiteralPath (Join-Path $outputRoot "guidance\training-machine.md"))) {
                    throw "Training profile missing generated guidance."
                }
            }
        }

        $reuseRoot = Join-Path $profileTestRoot "reuse"
        & $buildScript -Profile "development" -OutputDirectory $reuseRoot | Out-Null
        & $buildScript -Profile "catgirl" -OutputDirectory $reuseRoot | Out-Null
        if (Test-Path -LiteralPath (Join-Path $reuseRoot "guidance\development-machine.md")) {
            throw "Reused build directory kept stale development guidance."
        }
        & $buildScript -Profile "training" -OutputDirectory $reuseRoot | Out-Null
        if (-not (Test-Path -LiteralPath (Join-Path $reuseRoot "guidance\training-machine.md"))) {
            throw "Reused build directory lost selected training guidance."
        }
        if (Test-Path -LiteralPath (Join-Path $reuseRoot "guidance\development-machine.md")) {
            throw "Reused build directory mixed development and training guidance."
        }
        & $buildScript -Profile "neutral" -OutputDirectory $reuseRoot | Out-Null
        if (
            (Test-Path -LiteralPath (Join-Path $reuseRoot "guidance\development-machine.md")) -or
            (Test-Path -LiteralPath (Join-Path $reuseRoot "guidance\training-machine.md"))
        ) {
            throw "Reused build directory kept role guidance for neutral profile."
        }
    } finally {
        if (Test-Path -LiteralPath $profileTestRoot) {
            Remove-Item -LiteralPath $profileTestRoot -Recurse -Force
        }
    }

    $installScript = Join-Path $toolkitRoot "install\Install-CodexRulesProfile.ps1"
    $profileInstallRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-rules-install-test-" + [guid]::NewGuid().ToString("N"))
    try {
        & $installScript -Profile "development" -CodexHome $profileInstallRoot -InstallSystemPrompt -InstallRecommendedDesktopFeatures | Out-Null
        $installedConfigPath = Join-Path $profileInstallRoot "config.toml"
        $installedConfig = Get-Content -LiteralPath $installedConfigPath -Raw -Encoding UTF8
        $installedLimit = [regex]::Match($installedConfig, "(?m)^project_doc_max_bytes\s*=\s*(\d+)\s*$")
        if (-not $installedLimit.Success -or [long]$installedLimit.Groups[1].Value -lt 65536) {
            throw "Rules profile install did not ensure a 64K Codex project document limit."
        }
        $developmentGuidance = Join-Path $profileInstallRoot "guidance\development-machine.md"
        if (-not (Test-Path -LiteralPath $developmentGuidance)) {
            throw "Development profile install did not create role guidance."
        }
        if (-not (Test-Path -LiteralPath (Join-Path $profileInstallRoot "prompts\system-prompt.md")) -or
            -not $installedConfig.Contains('model_instructions_file = "~/.codex/prompts/system-prompt.md"') -or
            -not $installedConfig.Contains("[features.current_time_reminder]") -or
            -not $installedConfig.Contains("reminder_interval_seconds = 120")) {
            throw "Rules profile install did not apply the requested system prompt or Desktop feature configuration."
        }

        Set-Content -LiteralPath $installedConfigPath -Encoding UTF8 -Value @(
            "project_doc_max_bytes = 131_072",
            "",
            "[features]",
            "test_feature = true"
        )
        & $installScript -Profile "catgirl" -CodexHome $profileInstallRoot | Out-Null
        $preservedInstalledConfig = Get-Content -LiteralPath $installedConfigPath -Raw -Encoding UTF8
        if (-not $preservedInstalledConfig.Contains("project_doc_max_bytes = 131_072")) {
            throw "Rules profile install did not preserve an existing higher TOML-formatted project document limit."
        }
        if (Test-Path -LiteralPath $developmentGuidance) {
            throw "Profile switch left stale development role guidance."
        }
        $backedUpGuidance = @(
            Get-ChildItem -LiteralPath (Join-Path $profileInstallRoot "backups") -Recurse -File -Filter "development-machine.md" -ErrorAction SilentlyContinue
        )
        if ($backedUpGuidance.Count -lt 1) {
            throw "Profile switch did not back up stale development role guidance."
        }
        $installedAgents = Get-Content -LiteralPath (Join-Path $profileInstallRoot "AGENTS.md") -Raw -Encoding UTF8
        if (-not ($installedAgents.Contains("kaomoji")) -or $installedAgents.Contains("local_role=development")) {
            throw "Profile switch did not replace AGENTS.md with the selected profile."
        }
        $limitCount = [regex]::Matches(
            (Get-Content -LiteralPath $installedConfigPath -Raw -Encoding UTF8),
            "(?m)^project_doc_max_bytes\s*="
        ).Count
        if ($limitCount -ne 1) {
            throw "Repeated Rules profile installs duplicated project_doc_max_bytes."
        }
    } finally {
        if (Test-Path -LiteralPath $profileInstallRoot) {
            Remove-Item -LiteralPath $profileInstallRoot -Recurse -Force
        }
    }

    $applyConfigScript = Join-Path $toolkitRoot "install\\Apply-CodexConfig.ps1"
    $configApplyRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-config-apply-test-" + [guid]::NewGuid().ToString("N"))
    try {
        $fakeUserProfile = Join-Path $configApplyRoot "user"
        $fakeCodexHome = Join-Path $fakeUserProfile ".codex"
        New-Item -ItemType Directory -Force -Path $fakeCodexHome | Out-Null
        $configApplyPath = Join-Path $fakeCodexHome "config.toml"
        Set-Content -LiteralPath $configApplyPath -Encoding UTF8 -Value @(
            "project_doc_max_bytes = 32768",
            "",
            "[features]",
            "test_feature = true"
        )
        $originalUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeUserProfile
            & $applyConfigScript | Out-Null
            & $applyConfigScript | Out-Null
        } finally {
            $env:USERPROFILE = $originalUserProfile
        }
        $appliedConfig = Get-Content -LiteralPath $configApplyPath -Raw -Encoding UTF8
        if (-not $appliedConfig.Contains("project_doc_max_bytes = 65536")) {
            throw "Apply-CodexConfig did not raise project_doc_max_bytes to 65536."
        }
        if (-not $appliedConfig.Contains("[features]") -or -not $appliedConfig.Contains("test_feature = true")) {
            throw "Apply-CodexConfig did not preserve existing Codex configuration."
        }
        if ([regex]::Matches($appliedConfig, "(?m)^project_doc_max_bytes\s*=").Count -ne 1) {
            throw "Apply-CodexConfig duplicated project_doc_max_bytes."
        }
        if ($appliedConfig.IndexOf("project_doc_max_bytes") -gt $appliedConfig.IndexOf("[features]")) {
            throw "Apply-CodexConfig placed project_doc_max_bytes inside a TOML table."
        }
        Set-Content -LiteralPath $configApplyPath -Encoding UTF8 -Value @(
            "project_doc_max_bytes = 131_072",
            "",
            "[features]",
            "test_feature = true"
        )
        $originalUserProfile = $env:USERPROFILE
        try {
            $env:USERPROFILE = $fakeUserProfile
            & $applyConfigScript | Out-Null
        } finally {
            $env:USERPROFILE = $originalUserProfile
        }
        $preservedAppliedConfig = Get-Content -LiteralPath $configApplyPath -Raw -Encoding UTF8
        if (-not $preservedAppliedConfig.Contains("project_doc_max_bytes = 131_072")) {
            throw "Apply-CodexConfig did not preserve an existing higher TOML-formatted project document limit."
        }
    } finally {
        if (Test-Path -LiteralPath $configApplyRoot) {
            Remove-Item -LiteralPath $configApplyRoot -Recurse -Force
        }
    }

    $allowedSkills = @(
        "algorithmic-art", "brand-guidelines", "canvas-design", "frontend-design", "hatch-pet", "imagegen",
        "internal-comms", "jupyter-notebook", "mcp-builder", "pdf", "playwright", "screenshot",
        "skill-creator", "slack-gif-creator", "theme-factory", "webapp-testing", "web-artifacts-builder",
        "wechat-docs-collaboration"
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

    foreach ($jsonPath in @("templates\config.antigravity.example.json", "templates\config.claude.example.json", "templates\config.windsurf.example.json", "templates\config.windsurf.subagent.example.json", "mcps\napcat-mcp\binding.example.json", "mcps\napcat-mcp\heartbeat.example.json")) {
        $jsonFullPath = Join-Path $toolkitRoot $jsonPath
        $jsonText = Get-Content -LiteralPath $jsonFullPath -Raw -Encoding UTF8
        if ($jsonText.Length -gt 0 -and [int]$jsonText[0] -eq 0xFEFF) { throw "JSON template contains a UTF-8 BOM: $jsonFullPath" }
        $jsonText | ConvertFrom-Json | Out-Null
    }
    $codexConfig = Get-Content -LiteralPath (Join-Path $toolkitRoot "templates\config.codex.toml") -Raw -Encoding UTF8
    foreach ($requiredBlock in @("[mcp_servers.memory-store]", "[mcp_servers.web-fetcher]", "[mcp_servers.sandbox]")) {
        if (-not $codexConfig.Contains($requiredBlock)) { throw "Codex config template missing block: $requiredBlock" }
    }
    if (-not $codexConfig.Contains("[mcp_servers.napcat]")) { throw "Codex config template missing optional NapCat block." }
    if (-not $codexConfig.Contains("[mcp_servers.wechat-docs]")) { throw "Codex config template missing optional WeChat Docs block." }
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
if ($IncludeNapCatEndpoint) { $env:CODEX_TOOLKIT_SMOKE_NAPCAT = "1" }
node (Join-Path $toolkitRoot "design-tests\smoke-mcp-http.mjs")
if ($LASTEXITCODE -ne 0) { throw "MCP HTTP smoke test failed with exit code $LASTEXITCODE" }

Write-Output "Portable toolkit smoke test completed."
