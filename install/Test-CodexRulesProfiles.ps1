$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$buildScript = Join-Path $toolkitRoot "install\Build-CodexRulesProfile.ps1"
$installScript = Join-Path $toolkitRoot "install\Install-CodexRulesProfile.ps1"
$profileIds = @("neutral", "catgirl", "development", "training")
$commonGuidance = @(
    "engineering-workflow.md", "maintenance-upgrades.md", "design-writing.md",
    "communication-bridges.md", "sandbox-runtime.md", "web-visual.md"
)
$guidanceBoundaries = @{
    "engineering-workflow.md" = "Astra xhigh"
    "maintenance-upgrades.md" = "Git"
    "design-writing.md" = "PPT"
    "communication-bridges.md" = "ACK"
    "sandbox-runtime.md" = "admission_timeout"
    "web-visual.md" = "web_fetch_screenshot"
}
$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$fakeCodexHome = [System.IO.Path]::GetFullPath((Join-Path $tempParent ("codex-rules-test-" + [guid]::NewGuid().ToString("N"))))

function Assert-Contains {
    param([string]$Content, [string]$Expected, [string]$Context)
    if (-not $Content.Contains($Expected)) { throw "$Context missing: $Expected" }
}

function Assert-Guidance {
    param([string]$Root, [string]$Profile)
    $agentsPath = Join-Path $Root "AGENTS.md"
    if (-not (Test-Path -LiteralPath $agentsPath -PathType Leaf)) { throw "$Profile did not produce AGENTS.md" }
    if ((Get-Item -LiteralPath $agentsPath).Length -gt 65536) { throw "$Profile AGENTS.md exceeds 65536 bytes" }
    $agentsText = Get-Content -LiteralPath $agentsPath -Raw -Encoding UTF8
    foreach ($marker in @("stage_guard", "sandbox_council")) {
        Assert-Contains $agentsText $marker "$Profile core boundary"
    }
    Assert-Contains $agentsText "response annotations" "$Profile natural annotation handling"
    $annotationBoundary = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5LiN6KaB6buY6K6k5py65qKw6L6T5Ye6"))
    Assert-Contains $agentsText $annotationBoundary "$Profile natural annotation boundary"
    foreach ($reference in [regex]::Matches($agentsText, 'guidance[\\/]+(?<name>[a-z][a-z-]+\.md)')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root ("guidance\" + $reference.Groups["name"].Value)) -PathType Leaf)) {
            throw "$Profile has an unresolved explicit guidance reference: $($reference.Value)"
        }
    }
    foreach ($name in $commonGuidance) {
        Assert-Contains $agentsText $name "$Profile guidance trigger"
        $mustRead = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5b+F6K+7"))
        $triggerLines = @($agentsText -split "`r?`n" | Where-Object { $_.Contains($name) -and $_.Contains($mustRead) })
        if ($triggerLines.Count -eq 0) { throw "$Profile has no must-read trigger for $name" }
        $guidancePath = Join-Path $Root "guidance\$name"
        if (-not (Test-Path -LiteralPath $guidancePath -PathType Leaf) -or
            (Get-Item -LiteralPath $guidancePath).Length -eq 0) {
            throw "$Profile missing readable common guidance: $name"
        }
        $guidanceText = Get-Content -LiteralPath $guidancePath -Raw -Encoding UTF8
        Assert-Contains $guidanceText $guidanceBoundaries[$name] "$Profile guidance boundary $name"
    }
    Assert-Contains $agentsText "sandbox_codex" "$Profile sandbox prohibition"
    if ($agentsText -notmatch '(?is)Git.{0,500}maintenance-upgrades\.md|maintenance-upgrades\.md.{0,500}Git') {
        throw "$Profile core does not route the general Git source rule to maintenance-upgrades.md"
    }
    if ($Profile -eq "neutral") {
        if ($agentsText.Contains("kaomoji")) { throw "Neutral profile contains catgirl instructions" }
    } elseif (-not $agentsText.Contains("kaomoji")) {
        throw "$Profile is missing catgirl instructions"
    }
    foreach ($role in @("development", "training")) {
        $rolePath = Join-Path $Root "guidance\$role-machine.md"
        if ($Profile -eq $role) {
            Assert-Contains $agentsText "local_role=$role" "$Profile role overlay"
            Assert-Contains $agentsText "$role-machine.md" "$Profile role guidance trigger"
            if (-not (Test-Path -LiteralPath $rolePath -PathType Leaf) -or
                (Get-Item -LiteralPath $rolePath).Length -eq 0) {
                throw "$Profile missing role guidance: $role-machine.md"
            }
        } else {
            if ($agentsText.Contains("local_role=$role") -or (Test-Path -LiteralPath $rolePath)) {
                throw "$Profile includes unselected $role role"
            }
        }
    }
    return $agentsText
}

function Assert-Backup {
    param([string]$RelativePath, [string]$Expected)
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $fakeCodexHome "backups") -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName.EndsWith($RelativePath, [System.StringComparison]::OrdinalIgnoreCase) })
    foreach ($backup in $backups) {
        if ((Get-Content -LiteralPath $backup.FullName -Raw -Encoding UTF8) -eq $Expected) { return }
    }
    throw "Missing backup of prior $RelativePath content"
}

try {
    New-Item -ItemType Directory -Path $fakeCodexHome -Force | Out-Null
    $buildRoot = Join-Path $fakeCodexHome "build"
    foreach ($role in @("development", "training")) {
        $overlayPath = Join-Path $toolkitRoot "rules\codex\components\$role.template.md"
        if ((Get-Item -LiteralPath $overlayPath).Length -gt 4096) {
            throw "$role role overlay is no longer short"
        }
    }
    foreach ($profileId in $profileIds) {
        $outputRoot = Join-Path $buildRoot $profileId
        & $buildScript -Profile $profileId -OutputDirectory $outputRoot | Out-Null
        $null = Assert-Guidance $outputRoot $profileId
    }

    $reuseRoot = Join-Path $buildRoot "reuse"
    $privateGuidance = Join-Path $reuseRoot "guidance\private-note.md"
    foreach ($profileId in @("development", "training", "catgirl", "neutral")) {
        & $buildScript -Profile $profileId -OutputDirectory $reuseRoot | Out-Null
        if ($profileId -eq "development") {
            Set-Content -LiteralPath $privateGuidance -Value "private guidance marker" -Encoding UTF8
        }
        $null = Assert-Guidance $reuseRoot $profileId
        if ((Get-Content -LiteralPath $privateGuidance -Raw -Encoding UTF8).Trim() -ne "private guidance marker") {
            throw "Reused build directory discarded unknown private guidance"
        }
    }

    $overridePath = Join-Path $fakeCodexHome "private-override.md"
    Set-Content -LiteralPath $overridePath -Value "private override test marker" -Encoding UTF8
    $existingAgents = "prior AGENTS marker`n"
    $existingGuidance = "prior guidance marker`n"
    $existingPrompt = "prior prompt marker`n"
    $agentsPath = Join-Path $fakeCodexHome "AGENTS.md"
    $guidanceRoot = Join-Path $fakeCodexHome "guidance"
    $promptPath = Join-Path $fakeCodexHome "prompts\system-prompt.md"
    $configPath = Join-Path $fakeCodexHome "config.toml"
    New-Item -ItemType Directory -Path $guidanceRoot, (Split-Path -Parent $promptPath) -Force | Out-Null
    Set-Content -LiteralPath $agentsPath -Value $existingAgents -NoNewline -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $guidanceRoot "engineering-workflow.md") -Value $existingGuidance -NoNewline -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $guidanceRoot "private-note.md") -Value "private guidance marker" -Encoding UTF8
    Set-Content -LiteralPath $promptPath -Value $existingPrompt -NoNewline -Encoding UTF8
    $existingConfig = "[mcp_servers.private]`nurl = 'http://127.0.0.1:19999/mcp'`n"
    Set-Content -LiteralPath $configPath -Value $existingConfig -NoNewline -Encoding UTF8

    & $installScript -Profile "neutral" -CodexHome $fakeCodexHome | Out-Null
    $null = Assert-Guidance $fakeCodexHome "neutral"
    $neutralConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    Assert-Contains $neutralConfig "[mcp_servers.private]" "existing config"
    if ($neutralConfig -notmatch '(?m)^project_doc_max_bytes\s*=\s*65536\s*$') {
        throw "Neutral install did not set the minimum project document limit"
    }
    if ((Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8) -ne $existingPrompt -or
        $neutralConfig.Contains("model_instructions_file")) {
        throw "InstallSystemPrompt opt-in was not respected"
    }
    Assert-Backup "AGENTS.md" $existingAgents
    Assert-Backup "guidance\engineering-workflow.md" $existingGuidance
    Assert-Backup "config.toml" $existingConfig

    Set-Content -LiteralPath $configPath -Value "project_doc_max_bytes = 131_072`n$existingConfig" -NoNewline -Encoding UTF8
    & $installScript -Profile "development" -LocalOverridePath $overridePath -CodexHome $fakeCodexHome -InstallSystemPrompt -InstallRecommendedDesktopFeatures | Out-Null
    $installedAgents = Assert-Guidance $fakeCodexHome "development"
    Assert-Contains $installedAgents "private override test marker" "LocalOverridePath"
    $developmentConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    foreach ($marker in @("project_doc_max_bytes = 131_072", "[mcp_servers.private]", 'model_instructions_file = "~/.codex/prompts/system-prompt.md"', "[features.current_time_reminder]", "reminder_interval_seconds = 120")) {
        Assert-Contains $developmentConfig $marker "development config"
    }
    if ([regex]::Matches($developmentConfig, '(?m)^project_doc_max_bytes\s*=').Count -ne 1) {
        throw "Repeated install duplicated project_doc_max_bytes"
    }
    if ((Get-Content -LiteralPath $promptPath -Raw -Encoding UTF8) -eq $existingPrompt) {
        throw "Requested system prompt was not installed"
    }
    Assert-Backup "prompts\system-prompt.md" $existingPrompt
    Assert-Backup "config.toml" "project_doc_max_bytes = 131_072`n$existingConfig"

    & $installScript -Profile "training" -LocalOverridePath $overridePath -CodexHome $fakeCodexHome | Out-Null
    $trainingAgents = Assert-Guidance $fakeCodexHome "training"
    Assert-Contains $trainingAgents "private override test marker" "training private override"
    Assert-Backup "guidance\development-machine.md" (Get-Content -LiteralPath (Join-Path $buildRoot "development\guidance\development-machine.md") -Raw -Encoding UTF8)
    & $installScript -Profile "catgirl" -LocalOverridePath $overridePath -CodexHome $fakeCodexHome | Out-Null
    $catgirlAgents = Assert-Guidance $fakeCodexHome "catgirl"
    Assert-Contains $catgirlAgents "private override test marker" "catgirl private override"
    if (-not (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8).Contains("project_doc_max_bytes = 131_072") -or
        -not (Test-Path -LiteralPath $promptPath)) {
        throw "Profile switch discarded preserved config or opted-in system prompt"
    }
    if ((Get-Content -LiteralPath (Join-Path $guidanceRoot "private-note.md") -Raw -Encoding UTF8).Trim() -ne "private guidance marker") {
        throw "Install discarded unknown private guidance"
    }
    Assert-Backup "guidance\training-machine.md" (Get-Content -LiteralPath (Join-Path $buildRoot "training\guidance\training-machine.md") -Raw -Encoding UTF8)
    Write-Output "Codex Rules profiles passed: four builds, four installs, guidance, isolation, overrides, config, and backups."
} finally {
    $resolvedRoot = [System.IO.Path]::GetFullPath($fakeCodexHome).TrimEnd('\', '/')
    $resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedRoot)).TrimEnd('\', '/')
    if ($resolvedParent -ne $tempParent -or
        -not ([System.IO.Path]::GetFileName($resolvedRoot) -match '^codex-rules-test-[0-9a-f]{32}$')) {
        throw "Refusing to remove a test directory outside its exclusive Temp root: $resolvedRoot"
    }
    if (Test-Path -LiteralPath $resolvedRoot) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
