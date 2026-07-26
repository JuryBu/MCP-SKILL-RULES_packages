param(
    [ValidateSet("neutral", "catgirl", "development", "training")]
    [string]$Profile = "catgirl",
    [string]$LocalOverridePath,
    [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
    [switch]$InstallSystemPrompt
)

$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
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

    New-Item -ItemType Directory -Force -Path $resolvedCodexHome | Out-Null
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

    foreach ($copy in $copies) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy.Target) | Out-Null
        Copy-Item -LiteralPath $copy.Source -Destination $copy.Target -Force
    }

    Write-Output "Installed Codex Rules profile: $Profile"
    Write-Output "Codex home: $resolvedCodexHome"
    Write-Output "Removed stale role guidance: $($staleGuidanceTargets.Count)"
    if ($existingTargets.Count -gt 0) {
        Write-Output "Backup: $backupRoot"
    }
    if ($InstallSystemPrompt) {
        Write-Output 'Ensure config.toml contains: model_instructions_file = "~/.codex/prompts/system-prompt.md"'
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
