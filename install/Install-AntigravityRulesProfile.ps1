param(
    [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')]
    [string]$Profile = "catgirl",
    [string]$GeminiHome = (Join-Path $env:USERPROFILE ".gemini"),
    [string]$LocalCarePath,
    [string]$TargetUserProfile = $env:USERPROFILE,
    [string]$RulesParentRoot
)

$ErrorActionPreference = "Stop"

function Resolve-PSFullPath {
    param([Parameter(Mandatory = $true)][string]$InputPath)
    return [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InputPath))
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$builder = Join-Path $scriptDir "Build-AntigravityRulesProfile.ps1"
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) {
    throw "Missing Antigravity Rules builder script: $builder"
}

$resolvedGeminiHome = Resolve-PSFullPath -InputPath $GeminiHome
$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempParent ("agy-rules-install-" + [guid]::NewGuid().ToString("N"))))
$stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$backupRoot = Join-Path $resolvedGeminiHome "backups\rules-profile-$stamp"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Install-FileAtomically {
    param([Parameter(Mandatory = $true)][string]$SourcePath, [Parameter(Mandatory = $true)][string]$TargetPath)
    $targetDir = Split-Path -Parent $TargetPath
    if ($targetDir) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
    $tmpPath = "$TargetPath.tmp.$PID"
    try {
        if (Test-Path -LiteralPath $tmpPath -PathType Leaf) { Remove-Item -LiteralPath $tmpPath -Force }
        [System.IO.File]::Copy($SourcePath, $tmpPath, $true)
        if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
            [System.IO.File]::Replace($tmpPath, $TargetPath, [NullString]::Value, $true)
        } else {
            [System.IO.File]::Move($tmpPath, $TargetPath)
        }
    } catch {
        if (Test-Path -LiteralPath $tmpPath -PathType Leaf) {
            Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

try {
    $buildArgs = @{
        Profile = $Profile
        OutputDirectory = $tempRoot
        TargetUserProfile = $TargetUserProfile
    }
    if ($LocalCarePath) { $buildArgs.LocalCarePath = (Resolve-PSFullPath -InputPath $LocalCarePath) }
    if ($RulesParentRoot) { $buildArgs.RulesParentRoot = (Resolve-PSFullPath -InputPath $RulesParentRoot) }

    & $builder @buildArgs

    $builtGeminiPath = Join-Path $tempRoot "GEMINI.md"
    if (-not (Test-Path -LiteralPath $builtGeminiPath -PathType Leaf)) {
        throw "Antigravity Rules profile build failed: missing GEMINI.md"
    }

    $resolvedTempWithSep = $tempRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $builtFiles = @(Get-ChildItem -LiteralPath $tempRoot -Recurse -File | Sort-Object FullName)
    $copies = New-Object System.Collections.Generic.List[object]

    foreach ($file in $builtFiles) {
        $relative = $file.FullName.Substring($resolvedTempWithSep.Length)
        $relativeLower = ($relative -replace '/', '\').ToLowerInvariant()
        if ($relativeLower.EndsWith(".local.md")) {
            if ($relativeLower -ne "guidance\personal-care.local.md" -or -not $LocalCarePath) {
                throw "Refusing to overwrite protected private file without explicit opt-in: $relative"
            }
        }
        $copies.Add([pscustomobject]@{
            Relative = $relative
            Source = $file.FullName
            Target = (Join-Path $resolvedGeminiHome $relative)
        })
    }

    New-Item -ItemType Directory -Force -Path $resolvedGeminiHome | Out-Null

    $existingTargets = @($copies | Where-Object { Test-Path -LiteralPath $_.Target -PathType Leaf })
    $createdTargets = @($copies | Where-Object { -not (Test-Path -LiteralPath $_.Target -PathType Leaf) } | ForEach-Object { $_.Target })
    $backupCreated = $false
    if ($existingTargets.Count -gt 0 -or $createdTargets.Count -gt 0) {
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        $manifestEntries = New-Object System.Collections.Generic.List[object]
        foreach ($entry in $existingTargets) {
            $backupPath = Join-Path $backupRoot $entry.Relative
            $backupParent = Split-Path -Parent $backupPath
            if ($backupParent) { New-Item -ItemType Directory -Force -Path $backupParent | Out-Null }
            Copy-Item -LiteralPath $entry.Target -Destination $backupPath -Force
            $hash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
            $size = (Get-Item -LiteralPath $backupPath).Length
            $manifestEntries.Add([pscustomobject]@{
                relativePath = ($entry.Relative -replace '\\', '/')
                originalPath = $entry.Target
                backupPath = $backupPath
                sha256 = $hash
                bytes = $size
            })
        }

        $manifest = [pscustomobject]@{
            createdAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", [System.Globalization.CultureInfo]::InvariantCulture)
            profile = $Profile
            geminiHome = $resolvedGeminiHome
            backupRoot = $backupRoot
            fileCount = $manifestEntries.Count
            files = $manifestEntries.ToArray()
            createdFiles = $createdTargets
        }
        $manifestJson = ($manifest | ConvertTo-Json -Depth 6).Replace("`r`n", "`n").TrimEnd("`n") + "`n"
        $manifestPath = Join-Path $backupRoot "manifest.json"
        [System.IO.File]::WriteAllText($manifestPath, $manifestJson, $utf8NoBom)
        $backupCreated = $true
    }

    $geminiTarget = Join-Path $resolvedGeminiHome "GEMINI.md"
    foreach ($entry in @($copies | Where-Object { $_.Target -ne $geminiTarget })) {
        Install-FileAtomically -SourcePath $entry.Source -TargetPath $entry.Target
    }
    Install-FileAtomically -SourcePath $builtGeminiPath -TargetPath $geminiTarget

    Write-Output "Installed Antigravity Rules profile: $Profile"
    Write-Output "Gemini home: $resolvedGeminiHome"
    Write-Output "Installed managed files: $($copies.Count)"
    if ($backupCreated) {
        Write-Output "Backup: $backupRoot"
        Write-Output "Backup manifest: $(Join-Path $backupRoot 'manifest.json')"
    }
} finally {
    $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd('\', '/')
    $resolvedTempParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedTempRoot)).TrimEnd('\', '/')
    if ($resolvedTempParent -ne $tempParent -or
        -not ([System.IO.Path]::GetFileName($resolvedTempRoot) -match '^agy-rules-install-[0-9a-f]{32}$')) {
        throw "Refusing to remove a temp directory outside its exclusive Temp root: $resolvedTempRoot"
    }
    if (Test-Path -LiteralPath $resolvedTempRoot) {
        Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
    }
}
