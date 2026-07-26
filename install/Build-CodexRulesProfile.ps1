param(
    [ValidateSet("neutral", "catgirl", "development", "training")]
    [string]$Profile = "catgirl",
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$LocalOverridePath
)

$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$rulesRoot = Join-Path $toolkitRoot "rules\codex"
$profilePath = Join-Path $rulesRoot "profiles\$Profile.profile.json"
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$resolvedRulesRoot = [System.IO.Path]::GetFullPath($rulesRoot)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $profilePath)) {
    throw "Missing Codex Rules profile: $profilePath"
}

$profileData = Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($profileData.id -ne $Profile) {
    throw "Profile id mismatch in $profilePath"
}
if (-not $profileData.components -or $profileData.components.Count -eq 0) {
    throw "Profile has no components: $profilePath"
}

$parts = New-Object System.Collections.Generic.List[string]
foreach ($relativePath in $profileData.components) {
    $componentPath = [System.IO.Path]::GetFullPath((Join-Path $rulesRoot $relativePath))
    if (-not $componentPath.StartsWith($resolvedRulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Profile component escapes the Codex Rules root: $relativePath"
    }
    if (-not (Test-Path -LiteralPath $componentPath)) {
        throw "Missing profile component: $componentPath"
    }
    $parts.Add((Get-Content -LiteralPath $componentPath -Raw -Encoding UTF8).Trim())
}

if ($LocalOverridePath) {
    $resolvedOverride = (Resolve-Path -LiteralPath $LocalOverridePath).Path
    if ([System.IO.Path]::GetFileName($resolvedOverride) -eq "local-overrides.example.md") {
        throw "Copy local-overrides.example.md to a private path before installing it."
    }
    $parts.Add((Get-Content -LiteralPath $resolvedOverride -Raw -Encoding UTF8).Trim())
}

$guidanceCopies = @()
foreach ($item in @($profileData.guidance)) {
    $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $rulesRoot $item.source))
    if (-not $sourcePath.StartsWith($resolvedRulesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Guidance source escapes the Codex Rules root: $($item.source)"
    }
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Missing guidance source: $sourcePath"
    }
    if ([System.IO.Path]::GetFileName($item.target) -ne $item.target) {
        throw "Guidance target must be a file name: $($item.target)"
    }
    $guidanceCopies += [pscustomobject]@{
        Source = $sourcePath
        Target = $item.target
    }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$guidanceRoot = Join-Path $outputRoot "guidance"
foreach ($managedGuidanceName in @("development-machine.md", "training-machine.md")) {
    $managedGuidancePath = Join-Path $guidanceRoot $managedGuidanceName
    if (Test-Path -LiteralPath $managedGuidancePath -PathType Leaf) {
        Remove-Item -LiteralPath $managedGuidancePath -Force
    }
}
$agentsPath = Join-Path $outputRoot "AGENTS.md"
$agentsText = ($parts -join ([Environment]::NewLine + [Environment]::NewLine)).Trim() + [Environment]::NewLine
[System.IO.File]::WriteAllText($agentsPath, $agentsText, $utf8NoBom)

if ($guidanceCopies.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $guidanceRoot | Out-Null
    foreach ($copy in $guidanceCopies) {
        $targetPath = Join-Path $guidanceRoot $copy.Target
        [System.IO.File]::WriteAllText(
            $targetPath,
            (Get-Content -LiteralPath $copy.Source -Raw -Encoding UTF8),
            $utf8NoBom
        )
    }
}

$promptSource = Join-Path $rulesRoot "system-prompt.template.md"
if (-not (Test-Path -LiteralPath $promptSource)) {
    throw "Missing Codex system prompt template: $promptSource"
}
$promptRoot = Join-Path $outputRoot "prompts"
New-Item -ItemType Directory -Force -Path $promptRoot | Out-Null
[System.IO.File]::WriteAllText(
    (Join-Path $promptRoot "system-prompt.md"),
    (Get-Content -LiteralPath $promptSource -Raw -Encoding UTF8),
    $utf8NoBom
)

Write-Output "Codex Rules profile built: $Profile"
Write-Output "AGENTS: $agentsPath"
Write-Output "Guidance files: $($guidanceCopies.Count)"
Write-Output "System prompt template: $(Join-Path $promptRoot 'system-prompt.md')"
