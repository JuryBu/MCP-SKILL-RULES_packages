param(
    [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')]
    [string]$Profile = "catgirl",
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$TargetUserProfile = $env:USERPROFILE,
    [switch]$KeepTemplatePlaceholders,
    [string]$LocalCarePath,
    [string]$RulesParentRoot
)

$ErrorActionPreference = "Stop"

function Resolve-PSFullPath {
    param([Parameter(Mandatory = $true)][string]$InputPath)
    return [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InputPath))
}

function Get-JsonPropertyValue {
    param([object]$Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -ne $prop -and $null -ne $prop.Value) { return $prop.Value }
    return $Default
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolkitRoot = if ($RulesParentRoot) {
    Resolve-PSFullPath -InputPath $RulesParentRoot
} else {
    Split-Path -Parent $scriptDir
}
$rulesRoot = Join-Path $toolkitRoot "rules\antigravity"
$resolvedRulesRoot = [System.IO.Path]::GetFullPath($rulesRoot)
$resolvedRulesRootWithSep = $resolvedRulesRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$profilePath = Join-Path $rulesRoot "variants\$Profile.profile.json"
$outputRoot = Resolve-PSFullPath -InputPath $OutputDirectory
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$maxRuleBytes = 24000

if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) {
    throw "Missing Antigravity Rules profile: $profilePath"
}

$rawProfileJson = [string](Get-Content -LiteralPath $profilePath -Raw -Encoding UTF8)
if ([string]::IsNullOrWhiteSpace($rawProfileJson)) {
    throw "Empty Antigravity Rules profile: $profilePath"
}
$profileData = $rawProfileJson | ConvertFrom-Json
$profileIdVal = [string](Get-JsonPropertyValue -Object $profileData -Name "id" -Default "")
if ($profileIdVal -ne $Profile) {
    throw "Profile id mismatch in $profilePath (expected '$Profile', got '$profileIdVal')"
}
$audienceMode = [string](Get-JsonPropertyValue -Object $profileData -Name "audienceMode" -Default $Profile)
if ($audienceMode -notin @("catgirl", "neutral")) {
    throw "Unsupported audienceMode '$audienceMode' in $profilePath"
}
$componentsRaw = @(Get-JsonPropertyValue -Object $profileData -Name "components" -Default @())
if ($componentsRaw.Count -eq 0) {
    throw "Profile has no components: $profilePath"
}

function Convert-AntigravityAudienceText {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text,
        [Parameter(Mandatory = $true)]
        [ValidateSet("catgirl", "neutral")]
        [string]$AudienceMode
    )

    if ($AudienceMode -eq "neutral") {
        return $Text
    }

    $protectedTechTerms = @(
        ([regex]::Unescape('\u7528\u6237\u76ee\u5f55')),
        ([regex]::Unescape('\u7528\u6237\u540d')),
        ([regex]::Unescape('\u7528\u6237\u6570\u636e')),
        ([regex]::Unescape('\u7528\u6237\u914d\u7f6e')),
        ([regex]::Unescape('\u7528\u6237\u6001')),
        ([regex]::Unescape('\u7528\u6237\u7ea7')),
        ([regex]::Unescape('\u7528\u6237\u754c\u9762')),
        ([regex]::Unescape('\u591a\u7528\u6237')),
        ([regex]::Unescape('\u5f53\u524d\u7528\u6237')),
        ([regex]::Unescape('\u7cfb\u7edf\u7528\u6237'))
    )
    $ordinaryUserWord = [regex]::Unescape('\u666e\u901a\u7528\u6237')
    $ordinaryReaderWord = [regex]::Unescape('\u666e\u901a\u4f7f\u7528\u8005')
    $realUserWord = [regex]::Unescape('\u771f\u5b9e\u7528\u6237')
    $realReaderWord = [regex]::Unescape('\u771f\u5b9e\u4f7f\u7528\u8005')
    $multiMachineUserWord = [regex]::Unescape('\u591a\u673a\u7528\u6237')
    $multiMachineReaderWord = [regex]::Unescape('\u591a\u673a\u4f7f\u7528\u8005')
    $userWord = [regex]::Unescape('\u7528\u6237')
    $ownerWord = [regex]::Unescape('\u4e3b\u4eba')
    $recentFileWord = [regex]::Unescape('\u4ea4\u6d41\u8fd1\u51b5.md')
    $ownerRecentFileWord = [regex]::Unescape('\u4e3b\u4eba\u4ea4\u6d41\u8fd1\u51b5.md')
    $recentAgyWord = [regex]::Unescape('\u4ea4\u6d41\u8fd1\u51b5_agy.md')
    $ownerRecentAgyWord = [regex]::Unescape('\u4e3b\u4eba\u4ea4\u6d41\u8fd1\u51b5_agy.md')
    $recentTickWord = [regex]::Unescape('`\u4ea4\u6d41\u8fd1\u51b5`')
    $ownerRecentTickWord = [regex]::Unescape('`\u4e3b\u4eba\u4ea4\u6d41\u8fd1\u51b5`')

    $result = $Text
    for ($i = 0; $i -lt $protectedTechTerms.Count; $i++) {
        $result = $result.Replace($protectedTechTerms[$i], "__AGY_KEEP_TECH_${i}__")
    }
    $result = $result.Replace($ownerRecentFileWord, "__AGY_KEEP_OWNER_RECENT__")
    $result = $result.Replace($ownerRecentAgyWord, "__AGY_KEEP_OWNER_RECENT_AGY__")
    $result = $result.Replace($ownerRecentTickWord, "__AGY_KEEP_OWNER_RECENT_TICK__")
    $result = $result.Replace($ordinaryUserWord, $ordinaryReaderWord)
    $result = $result.Replace($realUserWord, $realReaderWord)
    $result = $result.Replace($multiMachineUserWord, $multiMachineReaderWord)
    $result = $result.Replace($userWord, $ownerWord)
    $result = $result.Replace($ownerRecentFileWord, "__AGY_KEEP_OWNER_RECENT__")
    $result = $result.Replace($ownerRecentAgyWord, "__AGY_KEEP_OWNER_RECENT_AGY__")
    $result = $result.Replace($recentFileWord, $ownerRecentFileWord)
    $result = $result.Replace($recentAgyWord, $ownerRecentAgyWord)
    $result = $result.Replace($recentTickWord, $ownerRecentTickWord)
    $result = $result.Replace("__AGY_KEEP_OWNER_RECENT_TICK__", $ownerRecentTickWord)
    $result = $result.Replace("__AGY_KEEP_OWNER_RECENT_AGY__", $ownerRecentAgyWord)
    $result = $result.Replace("__AGY_KEEP_OWNER_RECENT__", $ownerRecentFileWord)
    for ($i = 0; $i -lt $protectedTechTerms.Count; $i++) {
        $result = $result.Replace("__AGY_KEEP_TECH_${i}__", $protectedTechTerms[$i])
    }
    return $result
}

function Convert-AntigravityTemplatePlaceholders {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text,
        [switch]$KeepPlaceholders,
        [string]$UserProfileSlash,
        [string]$UserProfileUriSlash,
        [string]$UserProfileBackslash,
        [string]$ProfileLeaf
    )

    if ($KeepPlaceholders) {
        return $Text
    }
    $res = $Text.Replace("file:///C:/Users/<USER>", "file:///$UserProfileUriSlash")
    $res = $res.Replace("C:/Users/<USER>", $UserProfileSlash).Replace("C:\Users\<USER>", $UserProfileBackslash).Replace("<USER>", $ProfileLeaf)
    return $res
}

function Resolve-SafeRuleSourcePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath, [Parameter(Mandatory = $true)][string]$Label)
    if ([string]::IsNullOrWhiteSpace($RelativePath)) { throw "$Label path is empty in $profilePath" }
    if ([System.IO.Path]::IsPathRooted($RelativePath)) { throw "$Label path must be relative to rules root: $RelativePath" }
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedRulesRoot $RelativePath))
    if (-not $fullPath.StartsWith($resolvedRulesRootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes the Antigravity Rules root: $RelativePath"
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Missing ${Label}: $fullPath" }
    return $fullPath
}

function Resolve-SafeOutputPath {
    param([Parameter(Mandatory = $true)][string]$BaseDirectory, [Parameter(Mandatory = $true)][string]$RelativeTarget, [Parameter(Mandatory = $true)][string]$Label)
    if ([string]::IsNullOrWhiteSpace($RelativeTarget)) { throw "$Label target is empty in $profilePath" }
    if ([System.IO.Path]::IsPathRooted($RelativeTarget)) { throw "$Label target must be relative: $RelativeTarget" }
    $resolvedBase = [System.IO.Path]::GetFullPath($BaseDirectory)
    $resolvedBaseWithSep = $resolvedBase.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedBase $RelativeTarget))
    if (-not $fullPath.StartsWith($resolvedBaseWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label target escapes allowed output directory: $RelativeTarget"
    }
    return $fullPath
}

function Write-AntigravityRuleFile {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content, [Parameter(Mandatory = $true)][System.Text.UTF8Encoding]$Encoding)
    $normalized = $Content.Replace("`r`n", "`n").Replace("`r", "`n")
    $byteCount = $Encoding.GetByteCount($normalized)
    if ($byteCount -eq 0 -or [string]::IsNullOrWhiteSpace($normalized)) {
        throw "Generated Antigravity rule file is empty: $Path"
    }
    if ($byteCount -ge $maxRuleBytes) {
        throw "Generated Antigravity rule file reaches or exceeds $maxRuleBytes UTF-8 bytes ($byteCount bytes): $Path"
    }
    $parentDir = Split-Path -Parent $Path
    if ($parentDir) { New-Item -ItemType Directory -Force -Path $parentDir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $normalized, $Encoding)
    return $byteCount
}

$resolvedUserProfile = ""
$userProfileSlash = ""
$userProfileUriSlash = ""
$profileLeaf = ""
if (-not $KeepTemplatePlaceholders) {
    if ([string]::IsNullOrWhiteSpace($TargetUserProfile)) {
        throw "TargetUserProfile cannot be empty unless -KeepTemplatePlaceholders is specified."
    }
    $resolvedUserProfile = (Resolve-PSFullPath -InputPath $TargetUserProfile).TrimEnd('\', '/')
    $rootCandidate = [System.IO.Path]::GetPathRoot($resolvedUserProfile)
    if ([string]::IsNullOrWhiteSpace($resolvedUserProfile) -or
        ($null -ne $rootCandidate -and $resolvedUserProfile.TrimEnd('\', '/') -ieq $rootCandidate.TrimEnd('\', '/'))) {
        throw "TargetUserProfile cannot be a drive root: $TargetUserProfile"
    }
    $userProfileSlash = $resolvedUserProfile -replace '\\', '/'
    $userProfileUriSlash = $userProfileSlash.Replace(" ", "%20")
    $profileLeaf = [System.IO.Path]::GetFileName($resolvedUserProfile)
    if ([string]::IsNullOrWhiteSpace($profileLeaf)) {
        throw "Cannot determine user leaf name from TargetUserProfile: $TargetUserProfile"
    }
}

$resolvedLocalCare = $null
if ($LocalCarePath) {
    $candidateCare = Resolve-PSFullPath -InputPath $LocalCarePath
    if (-not (Test-Path -LiteralPath $candidateCare -PathType Leaf)) {
        throw "Missing local care file: $LocalCarePath"
    }
    $resolvedLocalCare = $candidateCare
    if ([System.IO.Path]::GetFileName($resolvedLocalCare) -ieq "local-care.example.md") {
        throw "Copy local-care.example.md to a private path outside the repository before passing -LocalCarePath."
    }
}

$componentPaths = New-Object System.Collections.Generic.List[string]
foreach ($relativePath in $componentsRaw) {
    $componentPaths.Add((Resolve-SafeRuleSourcePath -RelativePath ([string]$relativePath) -Label "Profile component"))
}

$guidanceRoot = Join-Path $outputRoot "guidance"
$guidanceCopies = New-Object System.Collections.Generic.List[object]
$guidanceRaw = @(Get-JsonPropertyValue -Object $profileData -Name "guidance" -Default @())
foreach ($item in $guidanceRaw) {
    if ($null -eq $item) { continue }
    $sourceRel = [string](Get-JsonPropertyValue -Object $item -Name "source" -Default "")
    $rawTarget = [string](Get-JsonPropertyValue -Object $item -Name "target" -Default "")
    $sourcePath = Resolve-SafeRuleSourcePath -RelativePath $sourceRel -Label "Guidance source"
    if ([string]::IsNullOrWhiteSpace($rawTarget)) { throw "Guidance target is empty for source: $sourceRel" }
    $normTarget = ($rawTarget -replace '/', '\').TrimStart('\')
    if ($normTarget -match '^guidance\\(.+)$') { $normTarget = $Matches[1] }
    if ([System.IO.Path]::GetFileName($normTarget) -ne $normTarget) {
        throw "Guidance target must be a file name under guidance/: $rawTarget"
    }
    if ($normTarget.ToLowerInvariant().EndsWith(".local.md")) {
        throw "Guidance target in profile cannot target a protected .local.md file: $normTarget"
    }
    $targetPath = Resolve-SafeOutputPath -BaseDirectory $guidanceRoot -RelativeTarget $normTarget -Label "Guidance"
    $guidanceCopies.Add([pscustomobject]@{ Source = $sourcePath; Target = $targetPath })
}

$skillsBaseDir = Join-Path $outputRoot "antigravity\skills"
$skillCopies = New-Object System.Collections.Generic.List[object]
$skillsRaw = @(Get-JsonPropertyValue -Object $profileData -Name "skills" -Default @())
foreach ($item in $skillsRaw) {
    if ($null -eq $item) { continue }
    $sourceRel = [string](Get-JsonPropertyValue -Object $item -Name "source" -Default "")
    $rawTarget = [string](Get-JsonPropertyValue -Object $item -Name "target" -Default "")
    $sourcePath = Resolve-SafeRuleSourcePath -RelativePath $sourceRel -Label "Skill source"
    if ([string]::IsNullOrWhiteSpace($rawTarget)) { throw "Skill target is empty for source: $sourceRel" }
    $normTarget = ($rawTarget -replace '/', '\').TrimStart('\')
    $targetPath = if ($normTarget -match '^antigravity\\skills\\(.+)$') {
        Resolve-SafeOutputPath -BaseDirectory $skillsBaseDir -RelativeTarget $Matches[1] -Label "Skill"
    } elseif ($normTarget -match '^skills\\(.+)$') {
        Resolve-SafeOutputPath -BaseDirectory $skillsBaseDir -RelativeTarget $Matches[1] -Label "Skill"
    } else {
        Resolve-SafeOutputPath -BaseDirectory $skillsBaseDir -RelativeTarget $normTarget -Label "Skill"
    }
    $skillCopies.Add([pscustomobject]@{ Source = $sourcePath; Target = $targetPath })
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$parts = New-Object System.Collections.Generic.List[string]
foreach ($componentPath in $componentPaths) {
    $rawText = ([string](Get-Content -LiteralPath $componentPath -Raw -Encoding UTF8)).Replace("`r`n", "`n").Replace("`r", "`n")
    $audienceText = Convert-AntigravityAudienceText -Text $rawText -AudienceMode $audienceMode
    $renderedText = Convert-AntigravityTemplatePlaceholders -Text $audienceText -KeepPlaceholders:$KeepTemplatePlaceholders -UserProfileSlash $userProfileSlash -UserProfileUriSlash $userProfileUriSlash -UserProfileBackslash $resolvedUserProfile -ProfileLeaf $profileLeaf
    $parts.Add($renderedText.Trim())
}

$geminiPath = Join-Path $outputRoot "GEMINI.md"
$geminiText = ($parts -join "`n`n").Trim() + "`n"
$geminiBytes = Write-AntigravityRuleFile -Path $geminiPath -Content $geminiText -Encoding $utf8NoBom

foreach ($copy in $guidanceCopies) {
    $rawText = ([string](Get-Content -LiteralPath $copy.Source -Raw -Encoding UTF8)).Replace("`r`n", "`n").Replace("`r", "`n")
    $audienceText = Convert-AntigravityAudienceText -Text $rawText -AudienceMode $audienceMode
    $renderedText = Convert-AntigravityTemplatePlaceholders -Text $audienceText -KeepPlaceholders:$KeepTemplatePlaceholders -UserProfileSlash $userProfileSlash -UserProfileUriSlash $userProfileUriSlash -UserProfileBackslash $resolvedUserProfile -ProfileLeaf $profileLeaf
    $renderedText = $renderedText.TrimEnd("`n") + "`n"
    $null = Write-AntigravityRuleFile -Path $copy.Target -Content $renderedText -Encoding $utf8NoBom
}

foreach ($copy in $skillCopies) {
    $rawText = ([string](Get-Content -LiteralPath $copy.Source -Raw -Encoding UTF8)).Replace("`r`n", "`n").Replace("`r", "`n")
    $audienceText = Convert-AntigravityAudienceText -Text $rawText -AudienceMode $audienceMode
    $renderedText = Convert-AntigravityTemplatePlaceholders -Text $audienceText -KeepPlaceholders:$KeepTemplatePlaceholders -UserProfileSlash $userProfileSlash -UserProfileUriSlash $userProfileUriSlash -UserProfileBackslash $resolvedUserProfile -ProfileLeaf $profileLeaf
    $renderedText = $renderedText.TrimEnd("`n") + "`n"
    $null = Write-AntigravityRuleFile -Path $copy.Target -Content $renderedText -Encoding $utf8NoBom
}

$localCareInstalled = $false
if ($resolvedLocalCare) {
    $rawLocalCare = ([string](Get-Content -LiteralPath $resolvedLocalCare -Raw -Encoding UTF8)).Replace("`r`n", "`n").Replace("`r", "`n")
    $renderedCare = Convert-AntigravityTemplatePlaceholders -Text $rawLocalCare -KeepPlaceholders:$KeepTemplatePlaceholders -UserProfileSlash $userProfileSlash -UserProfileUriSlash $userProfileUriSlash -UserProfileBackslash $resolvedUserProfile -ProfileLeaf $profileLeaf
    $renderedCare = $renderedCare.TrimEnd("`n") + "`n"
    $localCareTarget = Join-Path $guidanceRoot "personal-care.local.md"
    $null = Write-AntigravityRuleFile -Path $localCareTarget -Content $renderedCare -Encoding $utf8NoBom
    $localCareInstalled = $true
}

Write-Output "Antigravity Rules profile built: $Profile (audience=$audienceMode)"
Write-Output "GEMINI: $geminiPath ($geminiBytes bytes)"
Write-Output "Guidance files: $($guidanceCopies.Count)"
Write-Output "Skill files: $($skillCopies.Count)"
if ($localCareInstalled) {
    Write-Output "Local care file included: guidance\personal-care.local.md"
}
