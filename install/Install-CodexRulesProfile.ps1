param(
    [ValidateSet("neutral", "catgirl", "development", "training")]
    [string]$Profile = "catgirl",
    [string]$LocalOverridePath,
    [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
    [switch]$InstallSystemPrompt,
    [switch]$InstallRecommendedDesktopFeatures
)

$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $toolkitRoot "install\\CodexConfigHelpers.ps1")
$builder = Join-Path $toolkitRoot "install\Build-CodexRulesProfile.ps1"
$resolvedCodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-rules-profile-" + [guid]::NewGuid().ToString("N"))
$stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$backupRoot = Join-Path $resolvedCodexHome "backups\rules-profile-$stamp"

try {
    $buildArgs = @{
        Profile = $Profile
        OutputDirectory = $tempRoot
    }
    if ($LocalOverridePath) {
        $buildArgs.LocalOverridePath = $LocalOverridePath
    }
    & $builder @buildArgs
    if (-not (Test-Path -LiteralPath (Join-Path $tempRoot "AGENTS.md"))) {
        throw "Codex Rules profile build failed."
    }
    $agentsBytes = (Get-Item -LiteralPath (Join-Path $tempRoot "AGENTS.md")).Length
    $requiredProjectDocBytes = [Math]::Max(65536, $agentsBytes + 8192)

    $configPath = Join-Path $resolvedCodexHome "config.toml"
    $currentConfig = if (Test-Path -LiteralPath $configPath) {
        Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    } else {
        ""
    }
    $candidatePrompt = Get-Content -LiteralPath (Join-Path $tempRoot "prompts\system-prompt.md") -Raw -Encoding UTF8
    $baselinePattern = '(?m)^\u901a\u7528\u57fa\u7ebf\u7248\u672c\uff1a(?<version>\d{4}-\d{2}-\d{2}\.\d+)\u3002\r?$'
    $baselineMatch = [regex]::Match($candidatePrompt, $baselinePattern)
    if (-not $baselineMatch.Success) {
        throw "The bundled common prompt has no valid baseline version. No target files were changed."
    }
    if (-not $InstallSystemPrompt) {
        $firstTable = [regex]::Match($currentConfig, '(?m)^\s*\[')
        $rootConfig = if ($firstTable.Success) { $currentConfig.Substring(0, $firstTable.Index) } else { $currentConfig }
        $pointerMatches = [regex]::Matches($rootConfig, '(?m)^\s*model_instructions_file\s*=\s*(["''])(?<path>[^"''\r\n]+)\1\s*(?:#.*)?$')
        $existingPromptPath = Join-Path $resolvedCodexHome "prompts\system-prompt.md"
        $compatible = $pointerMatches.Count -eq 1 -and
            $pointerMatches[0].Groups['path'].Value -eq '~/.codex/prompts/system-prompt.md' -and
            (Test-Path -LiteralPath $existingPromptPath -PathType Leaf)
        if ($compatible) {
            $existingPrompt = Get-Content -LiteralPath $existingPromptPath -Raw -Encoding UTF8
            $existingBaseline = [regex]::Match($existingPrompt, $baselinePattern)
            $compatible = $existingBaseline.Success -and
                $existingBaseline.Groups['version'].Value -eq $baselineMatch.Groups['version'].Value -and
                ($existingPrompt -replace "`r`n", "`n").Trim() -eq ($candidatePrompt -replace "`r`n", "`n").Trim()
        }
        if (-not $compatible) {
            throw "This AGENTS profile requires common baseline $($baselineMatch.Groups['version'].Value). No target files were changed. Use -InstallSystemPrompt with consent to update the prompt and pointer, or manually merge and verify a custom prompt before migrating AGENTS."
        }
    }
    New-Item -ItemType Directory -Force -Path $resolvedCodexHome | Out-Null
    $nextConfig = Set-CodexProjectDocMaxBytes -Content $currentConfig -MinimumBytes $requiredProjectDocBytes
    if ($InstallSystemPrompt) {
        $nextConfig = Set-CodexModelInstructionsFile -Content $nextConfig
    }
    if ($InstallRecommendedDesktopFeatures) {
        $nextConfig = Set-CodexRecommendedDesktopFeatures -Content $nextConfig
    }
    $configNeedsUpdate = $nextConfig -ne $currentConfig
    $copies = @(
        [pscustomobject]@{
            Source = (Join-Path $tempRoot "AGENTS.md")
            Target = (Join-Path $resolvedCodexHome "AGENTS.md")
        }
    )

    $guidanceRoot = Join-Path $tempRoot "guidance"
    if (Test-Path -LiteralPath $guidanceRoot) {
        foreach ($guidance in Get-ChildItem -LiteralPath $guidanceRoot -File) {
            $copies += [pscustomobject]@{
                Source = $guidance.FullName
                Target = (Join-Path $resolvedCodexHome "guidance\$($guidance.Name)")
            }
        }
    }

    if ($InstallSystemPrompt) {
        $copies += [pscustomobject]@{
            Source = (Join-Path $tempRoot "prompts\system-prompt.md")
            Target = (Join-Path $resolvedCodexHome "prompts\system-prompt.md")
        }
    }

    $managedGuidanceTargets = @(
        (Join-Path $resolvedCodexHome "guidance\development-machine.md"),
        (Join-Path $resolvedCodexHome "guidance\training-machine.md")
    )
    $selectedGuidanceTargets = @($copies | ForEach-Object { $_.Target })
    $staleGuidanceTargets = @(
        $managedGuidanceTargets |
            Where-Object { $_ -notin $selectedGuidanceTargets -and (Test-Path -LiteralPath $_) }
    )
    $existingTargets = @($copies | Where-Object { Test-Path -LiteralPath $_.Target })
    $existingTargets += @(
        $staleGuidanceTargets | ForEach-Object {
            [pscustomobject]@{ Source = $null; Target = $_ }
        }
    )
    if ($configNeedsUpdate -and (Test-Path -LiteralPath $configPath)) {
        $existingTargets += [pscustomobject]@{ Source = $null; Target = $configPath }
    }
    if ($existingTargets.Count -gt 0) {
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        foreach ($copy in $existingTargets) {
            $relative = $copy.Target.Substring($resolvedCodexHome.Length).TrimStart("\")
            $backupPath = Join-Path $backupRoot $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
            Copy-Item -LiteralPath $copy.Target -Destination $backupPath -Force
        }
    }

    foreach ($staleTarget in $staleGuidanceTargets) {
        Remove-Item -LiteralPath $staleTarget -Force
    }

    $agentsTarget = Join-Path $resolvedCodexHome "AGENTS.md"
    foreach ($copy in @($copies | Where-Object { $_.Target -ne $agentsTarget })) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy.Target) | Out-Null
        Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Force
    }
    if ($configNeedsUpdate) {
        Set-Content -LiteralPath $configPath -Value $nextConfig -Encoding UTF8 -NoNewline
    }
    Copy-Item -LiteralPath (Join-Path $tempRoot "AGENTS.md") -Destination $agentsTarget -Force

    Write-Output "Installed Codex Rules profile: $Profile"
    Write-Output "Codex home: $resolvedCodexHome"
    Write-Output "Ensured project_doc_max_bytes is at least $requiredProjectDocBytes."
    Write-Output "Removed stale role guidance: $($staleGuidanceTargets.Count)"
    if ($existingTargets.Count -gt 0) {
        Write-Output "Backup: $backupRoot"
    }
    if ($InstallSystemPrompt) {
        Write-Output 'Installed system prompt and configured model_instructions_file = "~/.codex/prompts/system-prompt.md".'
    }
    if ($InstallRecommendedDesktopFeatures) {
        Write-Output "Enabled the recommended Codex Desktop time reminder, structured input, reasoning summary, and idle-sleep settings."
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
