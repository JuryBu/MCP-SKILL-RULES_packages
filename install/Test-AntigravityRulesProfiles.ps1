param(
    [string]$RulesParentRoot,
    [string[]]$PrivatePatterns
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolkitRoot = if ($RulesParentRoot) {
    [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RulesParentRoot))
} else {
    Split-Path -Parent $scriptDir
}
$buildScript = Join-Path $scriptDir "Build-AntigravityRulesProfile.ps1"
$installScript = Join-Path $scriptDir "Install-AntigravityRulesProfile.ps1"
$rulesRoot = Join-Path $toolkitRoot "rules\antigravity"
$installRoot = Join-Path $toolkitRoot "install"
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$maxRuleBytes = 24000
$maxHealthyGeminiBytes = 18000

$tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $tempParent ("agy-rules-test-" + [guid]::NewGuid().ToString("N"))))

$expectedManagedRelativePaths = @(
    "GEMINI.md",
    "guidance\engineering-workflow.md",
    "guidance\communication-bridges.md",
    "guidance\design-writing.md",
    "guidance\web-visual.md",
    "guidance\maintenance-upgrades.md",
    "antigravity\skills\tools-reference\SKILL.md"
)

function Assert-Contains {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )
    if (-not $Content.Contains($Expected)) {
        throw "$Context missing expected text: $Expected"
    }
}

function Assert-NotContains {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)][string]$Forbidden,
        [Parameter(Mandatory = $true)][string]$Context
    )
    if ($Content.Contains($Forbidden)) {
        throw "$Context contains forbidden text: $Forbidden"
    }
}

function Assert-FileFormatAndBudget {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Context,
        [switch]$SkipSizeLimit
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Context missing file: $Path"
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) {
        throw "$Context file is empty: $Path"
    }
    if (-not $SkipSizeLimit -and $bytes.Length -ge $maxRuleBytes) {
        throw "$Context file reaches or exceeds $maxRuleBytes bytes ($($bytes.Length) bytes): $Path"
    }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "$Context file has a UTF-8 BOM: $Path"
    }
    if ([Array]::IndexOf($bytes, [byte]0x0D) -ge 0) {
        throw "$Context file contains CR (not pure LF): $Path"
    }
    return $strictUtf8.GetString($bytes)
}

function Assert-BuiltProfileBundle {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Profile,
        [switch]$ExpectPlaceholders
    )

    $fileMap = @{}
    foreach ($rel in $expectedManagedRelativePaths) {
        $fullPath = Join-Path $Root $rel
        $content = Assert-FileFormatAndBudget -Path $fullPath -Context "$Profile ($rel)"
        if ($ExpectPlaceholders) {
            if ($rel -eq "GEMINI.md") {
                Assert-Contains $content "C:/Users/<USER>" "$Profile ($rel) template placeholder"
            }
        } else {
            Assert-NotContains $content "<USER>" "$Profile ($rel) unresolved placeholder"
        }
        $fileMap[$rel] = $content
    }

    $geminiText = $fileMap["GEMINI.md"]
    $maintenanceText = $fileMap["guidance\maintenance-upgrades.md"]
    $combinedText = ($expectedManagedRelativePaths | ForEach-Object { $fileMap[$_] }) -join "`n"

    # Anti-suffocation guard: keep always-on GEMINI.md well below 24KB to prevent telex jargon compression
    $geminiBytes = ([System.IO.File]::ReadAllBytes((Join-Path $Root "GEMINI.md"))).Length
    if ($geminiBytes -gt $maxHealthyGeminiBytes) {
        throw "$Profile GEMINI.md exceeds healthy breathing cap ($maxHealthyGeminiBytes B): got $geminiBytes B"
    }

    # Structural & hard technical invariants (non-brittle ASCII/technical anchors only)
    foreach ($marker in @("read_file", "update_steps", "communication-core", "communication_contacts", "24,000", "force push", "USER_INPUT", "push to a remote only when the user asks", "sandbox_launch", "3m0s", "10 KiB", "PyMuPDF", "150 DPI")) {
        Assert-Contains $combinedText $marker "$Profile structural technical baseline"
    }
    Assert-Contains $maintenanceText "git add -- <paths>" "$Profile maintenance-upgrades safe staging baseline"
    Assert-Contains $maintenanceText "git diff --cached" "$Profile maintenance-upgrades diff check baseline"
    if ([regex]::IsMatch($geminiText, 'file:///[^\)\s]*\s')) {
        throw "$Profile GEMINI.md contains unencoded space in file:/// URI"
    }

    # Regression guard: ensure known toxic passivity / path-whitelist blockers never come back
    $toxicRegressions = @(
        ([regex]::Unescape('\u975e\u6b64\u4ed3\u7981\u64c5\u63d0')),
        ([regex]::Unescape('\u975e\u6b64\u4ed3\u7981\u64c5\u81ea\u63d0\u9001')),
        ([regex]::Unescape('\u975e\u6b64\u4ed3\u7981\u64c5\u81ea\u63a8\u9001')),
        ([regex]::Unescape('\u666e\u901a\u975e\u5171\u4eab\u4ed3\u5e93\u672a\u7ecf')),
        ([regex]::Unescape('\u4e0d\u64c5\u81ea `git commit`/`git push`')),
        ([regex]::Unescape('\u5e38\u89c4\u5b8c\u5de5\u4e0d\u53d1\u65e0\u5173 QQ')),
        ([regex]::Unescape('\u5fc5\u62bd\u53d6\u6e05\u6670 WebP \u5173\u952e\u5e27')),
        "*/20"
    )
    foreach ($rel in $expectedManagedRelativePaths) {
        foreach ($toxic in $toxicRegressions) {
            Assert-NotContains $fileMap[$rel] $toxic "$Profile ($rel) toxic regression check"
        }
    }

    # Persona & audience conversion isolation checks
    $ownerWord = [regex]::Unescape('\u4e3b\u4eba')
    $catgirlWord = [regex]::Unescape('\u732b\u5a18')
    $meowWord = [regex]::Unescape('\u55b5')
    $kaomojiWord = [regex]::Unescape('\u989c\u6587\u5b57')
    $kaomojiSample = [regex]::Unescape('(\u30ce\u2200\u00b4)')

    if ($Profile -eq "catgirl") {
        foreach ($marker in @($ownerWord, $catgirlWord)) {
            Assert-Contains $geminiText $marker "catgirl GEMINI persona"
        }
        $badReplacements = @(
            ([regex]::Unescape('\u4e3b\u4eba\u76ee\u5f55')),
            ([regex]::Unescape('\u4e3b\u4eba\u540d')),
            ([regex]::Unescape('\u4e3b\u4eba\u6570\u636e')),
            ([regex]::Unescape('\u4e3b\u4eba\u914d\u7f6e')),
            ([regex]::Unescape('\u4e3b\u4eba\u6001')),
            ([regex]::Unescape('\u4e3b\u4eba\u7ea7')),
            ([regex]::Unescape('\u4e3b\u4eba\u754c\u9762')),
            ([regex]::Unescape('\u591a\u4e3b\u4eba')),
            ([regex]::Unescape('\u5f53\u524d\u4e3b\u4eba')),
            ([regex]::Unescape('\u7cfb\u7edf\u4e3b\u4eba')),
            ([regex]::Unescape('\u666e\u901a\u4e3b\u4eba')),
            ([regex]::Unescape('\u771f\u5b9e\u4e3b\u4eba')),
            ([regex]::Unescape('\u591a\u673a\u4e3b\u4eba')),
            ([regex]::Unescape('\u4e2a\u4eba\u4e3b\u4eba')),
            ([regex]::Unescape('\u4e3b\u4eba\u4e3b\u4eba\u4ea4\u6d41\u8fd1\u51b5.md')),
            ([regex]::Unescape('`\u4ea4\u6d41\u8fd1\u51b5_agy.md`'))
        )
        $bareRecentRegex = '(?<!' + [regex]::Escape($ownerWord) + ')' + [regex]::Unescape('\u4ea4\u6d41\u8fd1\u51b5(_agy)?\.md')
        foreach ($rel in $expectedManagedRelativePaths) {
            foreach ($bad in $badReplacements) {
                Assert-NotContains $fileMap[$rel] $bad "catgirl ($rel) audience conversion integrity"
            }
            if ([regex]::IsMatch($fileMap[$rel], $bareRecentRegex)) {
                throw "catgirl ($rel) missed audience conversion for recent-status filename"
            }
        }
    } elseif ($Profile -eq "neutral") {
        foreach ($rel in $expectedManagedRelativePaths) {
            foreach ($forbidden in @($ownerWord, $catgirlWord, $meowWord, $kaomojiWord, $kaomojiSample)) {
                Assert-NotContains $fileMap[$rel] $forbidden "neutral ($rel) persona isolation"
            }
        }
    }

    return $fileMap
}

function Assert-Sanitization {
    param(
        [Parameter(Mandatory = $true)][string]$RulesDirectory,
        [Parameter(Mandatory = $true)][string]$InstallDirectory
    )

    if (-not (Test-Path -LiteralPath $RulesDirectory -PathType Container)) {
        throw "Missing rules directory for sanitization check: $RulesDirectory"
    }

    $localFiles = @(Get-ChildItem -LiteralPath $RulesDirectory -Recurse -File -Force | Where-Object {
        $_.Name.ToLowerInvariant().EndsWith(".local.md")
    })
    if ($localFiles.Count -gt 0) {
        $names = ($localFiles | ForEach-Object { $_.FullName }) -join ", "
        throw "Sanitization failed: concrete .local.md file(s) found under rules\antigravity\: $names"
    }

    $installScripts = @()
    if (Test-Path -LiteralPath $InstallDirectory -PathType Container) {
        $installScripts = @(Get-ChildItem -LiteralPath $InstallDirectory -File -Filter "*Antigravity*.ps1")
    }
    if ($installScripts.Count -lt 3) {
        throw "Expected at least 3 install\*Antigravity*.ps1 scripts in $InstallDirectory, found $($installScripts.Count)"
    }
    foreach ($srcFile in (@(Get-ChildItem -LiteralPath $RulesDirectory -Recurse -File -Force) + $installScripts)) {
        $null = Assert-FileFormatAndBudget -Path $srcFile.FullName -Context "Source file ($($srcFile.Name))" -SkipSizeLimit
    }

    $scanFiles = @(Get-ChildItem -LiteralPath $RulesDirectory -Recurse -File -Force) + $installScripts
    $userPathRegex = '(?i)[A-Za-z]:[\\/]+Users[\\/]+(?!<user>|USERNAME|YourName|Public|ExampleUser)[^\\/\s"'']+'
    $uuidRegex = '\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b'
    $bearerRegex = '(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{16,}'
    $secretRegex = '(?i)(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["''][A-Za-z0-9_./+=-]{24,}["'']'

    $customPatterns = New-Object System.Collections.Generic.List[string]
    if ($PrivatePatterns) {
        foreach ($p in $PrivatePatterns) {
            if (-not [string]::IsNullOrWhiteSpace($p)) { $customPatterns.Add($p.Trim()) }
        }
    }
    if ($env:CODEX_TOOLKIT_PRIVATE_PATTERNS) {
        foreach ($p in $env:CODEX_TOOLKIT_PRIVATE_PATTERNS.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)) {
            if (-not [string]::IsNullOrWhiteSpace($p)) { $customPatterns.Add($p.Trim()) }
        }
    }

    foreach ($file in $scanFiles) {
        $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
        if ($null -eq $content) { continue }
        $decodedUnicode = [regex]::Replace($content, '\\u([0-9a-fA-F]{4})', { param($m) [char][Convert]::ToInt32($m.Groups[1].Value, 16) })
        $decodedUrl = $decodedUnicode
        for ($uRound = 0; $uRound -lt 3; $uRound++) {
            $nextUrl = [System.Uri]::UnescapeDataString($decodedUrl)
            if ($nextUrl -ceq $decodedUrl) { break }
            $decodedUrl = $nextUrl
        }
        foreach ($layerText in @($content, $decodedUnicode, $decodedUrl)) {
            $pathMatch = [regex]::Match($layerText, $userPathRegex)
            if ($pathMatch.Success) {
                throw "Sanitization failed: real user path matched in $($file.FullName): $($pathMatch.Value)"
            }
            $uuidMatch = [regex]::Match($layerText, $uuidRegex)
            if ($uuidMatch.Success) {
                throw "Sanitization failed: concrete UUID matched in $($file.FullName): $($uuidMatch.Value)"
            }
            if ([regex]::IsMatch($layerText, $bearerRegex) -or [regex]::IsMatch($layerText, $secretRegex)) {
                throw "Sanitization failed: credential-shaped text matched in $($file.FullName)"
            }
            foreach ($token in $customPatterns) {
                if ($layerText.IndexOf($token, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    throw "Sanitization failed: custom private pattern matched in $($file.FullName)"
                }
            }
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null

    # 1. Build both profiles (catgirl & neutral) with standard user profile
    $stdUserProfile = Join-Path ("C:" + [char]92 + "Users") "ExampleUser"
    $buildRoot = Join-Path $testRoot "build"
    foreach ($profileId in @("catgirl", "neutral")) {
        $outDir = Join-Path $buildRoot $profileId
        & $buildScript -Profile $profileId -OutputDirectory $outDir -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
        $null = Assert-BuiltProfileBundle -Root $outDir -Profile $profileId
    }

    # 2. 20-char, 30-char & 30-char-4-space username stress build tests
    $stressCases = @(
        @{ Name = "TwentyCharUser123456"; Dir = "stress-20char"; ExpectUri = $null },
        @{ Name = "ThirtyCharUserName123456789012"; Dir = "stress-30char"; ExpectUri = $null },
        @{ Name = "Thirty Char User Name 12345678"; Dir = "stress-30char-4space"; ExpectUri = "Thirty%20Char%20User%20Name%2012345678" }
    )
    foreach ($sc in $stressCases) {
        $uProfile = Join-Path ("C:" + [char]92 + "Users") $sc.Name
        foreach ($profileId in @("catgirl", "neutral")) {
            $sDir = Join-Path (Join-Path $testRoot $sc.Dir) $profileId
            & $buildScript -Profile $profileId -OutputDirectory $sDir -TargetUserProfile $uProfile -RulesParentRoot $toolkitRoot | Out-Null
            $sMap = Assert-BuiltProfileBundle -Root $sDir -Profile $profileId
            if ($sc.ExpectUri) {
                Assert-Contains $sMap["GEMINI.md"] $sc.ExpectUri "$profileId $($sc.Dir) URI encoding"
            } else {
                Assert-Contains $sMap["GEMINI.md"] $sc.Name "$profileId $($sc.Dir) username replacement"
            }
            foreach ($rel in $expectedManagedRelativePaths) {
                $bLen = ([System.IO.File]::ReadAllBytes((Join-Path $sDir $rel))).Length
                if (($maxRuleBytes - $bLen) -lt 500) {
                    throw "$profileId $($sc.Dir) headroom < 500 B for ${rel}: $bLen B"
                }
            }
        }
    }

    $localCareExamplePath = Join-Path $rulesRoot "local-care.example.md"
    $localCareExampleText = Assert-FileFormatAndBudget -Path $localCareExamplePath -Context "Public local-care.example.md"
    Assert-Contains $localCareExampleText "<your-shared-toolkit-repo>" "local-care.example.md shared-repo placeholder"
    $deploymentPath = Join-Path $rulesRoot "DEPLOYMENT.md"
    $deploymentText = Assert-FileFormatAndBudget -Path $deploymentPath -Context "Public DEPLOYMENT.md" -SkipSizeLimit
    $docToxicChecks = @(
        ([regex]::Unescape('\u975e\u6b64\u4ed3\u7981\u64c5\u63d0')),
        ([regex]::Unescape('\u666e\u901a\u975e\u5171\u4eab\u4ed3\u5e93\u672a\u7ecf')),
        ([regex]::Unescape('\u4e0d\u64c5\u81ea `git commit`/`git push`')),
        ([regex]::Unescape('\u5e38\u89c4\u5b8c\u5de5\u4e0d\u53d1\u65e0\u5173 QQ')),
        "*/20"
    )
    foreach ($toxic in $docToxicChecks) {
        Assert-NotContains $localCareExampleText $toxic "local-care.example.md toxic regression check"
        Assert-NotContains $deploymentText $toxic "DEPLOYMENT.md toxic regression check"
    }

    # 3. Verify top-level GEMINI.template.md matches catgirl -KeepTemplatePlaceholders byte-for-byte
    $templateOutDir = Join-Path $testRoot "template-drift-check"
    & $buildScript -Profile "catgirl" -OutputDirectory $templateOutDir -KeepTemplatePlaceholders -RulesParentRoot $toolkitRoot | Out-Null
    $null = Assert-BuiltProfileBundle -Root $templateOutDir -Profile "catgirl" -ExpectPlaceholders
    $topTemplatePath = Join-Path $rulesRoot "GEMINI.template.md"
    $topTemplateText = Assert-FileFormatAndBudget -Path $topTemplatePath -Context "Top-level GEMINI.template.md"
    $builtTemplateText = Assert-FileFormatAndBudget -Path (Join-Path $templateOutDir "GEMINI.md") -Context "Built catgirl template GEMINI.md"
    if ($topTemplateText -cne $builtTemplateText) {
        throw "Drift detected: rules\antigravity\GEMINI.template.md does not match Build-AntigravityRulesProfile.ps1 -Profile catgirl -KeepTemplatePlaceholders verbatim."
    }

    # 4. Isolated installation, private .local.md protection, backup & rollback verification
    $fakeGeminiHome = Join-Path $testRoot "fake-gemini-home"
    $fakeGuidanceDir = Join-Path $fakeGeminiHome "guidance"
    $fakeSkillDir = Join-Path $fakeGeminiHome "antigravity\skills\tools-reference"
    New-Item -ItemType Directory -Force -Path $fakeGuidanceDir, $fakeSkillDir | Out-Null

    $priorGemini = "prior gemini sentinel content`n"
    $priorEngineering = "prior engineering sentinel content`n"
    $priorSkill = "prior skill sentinel content`n"
    $privateCareContent = "# Private Personal Care`nkeep-personal-care-untouched-marker`n"
    $privateAccountContent = "# Private Account Status`nkeep-account-status-untouched-marker`n"

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $fakeGeminiHome "GEMINI.md"), $priorGemini, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $fakeGuidanceDir "engineering-workflow.md"), $priorEngineering, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $fakeSkillDir "SKILL.md"), $priorSkill, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $privateCareContent, $utf8NoBom)
    [System.IO.File]::WriteAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $privateAccountContent, $utf8NoBom)

    # 4a. Guardrail rejections
    $buildRejected = $false
    try { & $buildScript -Profile "catgirl" -OutputDirectory (Join-Path $testRoot "reject-build") -LocalCarePath $localCareExamplePath -RulesParentRoot $toolkitRoot | Out-Null } catch { if ($_.Exception.Message -match 'local-care\.example\.md') { $buildRejected = $true } else { throw } }
    if (-not $buildRejected) { throw "Build script did not reject direct local-care.example.md" }

    $driveRootRejected = $false
    try { & $buildScript -Profile "catgirl" -OutputDirectory (Join-Path $testRoot "reject-root") -TargetUserProfile "C:\" -RulesParentRoot $toolkitRoot | Out-Null } catch { if ($_.Exception.Message -match 'drive root') { $driveRootRejected = $true } else { throw } }
    if (-not $driveRootRejected) { throw "Build script did not reject drive-root TargetUserProfile" }

    $emptyCareFile = Join-Path $testRoot "empty-care.md"
    [System.IO.File]::WriteAllText($emptyCareFile, "   `n", $utf8NoBom)
    $emptyCareRejected = $false
    try { & $buildScript -Profile "catgirl" -OutputDirectory (Join-Path $testRoot "reject-empty-care") -LocalCarePath $emptyCareFile -RulesParentRoot $toolkitRoot | Out-Null } catch { if ($_.Exception.Message -match 'empty') { $emptyCareRejected = $true } else { throw } }
    if (-not $emptyCareRejected) { throw "Build script did not reject whitespace-only LocalCarePath" }

    $beforeRejectHash = (Get-FileHash -LiteralPath (Join-Path $fakeGeminiHome "GEMINI.md") -Algorithm SHA256).Hash
    $installRejected = $false
    try { & $installScript -Profile "catgirl" -GeminiHome $fakeGeminiHome -LocalCarePath $localCareExamplePath -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null } catch { if ($_.Exception.Message -match 'local-care\.example\.md') { $installRejected = $true } else { throw } }
    if (-not $installRejected) { throw "Install script did not reject direct local-care.example.md" }
    if ((Get-FileHash -LiteralPath (Join-Path $fakeGeminiHome "GEMINI.md") -Algorithm SHA256).Hash -ne $beforeRejectHash) { throw "Rejected installation modified target GEMINI.md" }

    # 4b. Neutral & Catgirl isolated installs + private .local.md protection + SHA256 backup + explicit -LocalCarePath
    & $installScript -Profile "neutral" -GeminiHome $fakeGeminiHome -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
    $null = Assert-BuiltProfileBundle -Root $fakeGeminiHome -Profile "neutral"
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $privateCareContent) { throw "Neutral install altered personal-care.local.md" }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) { throw "Neutral install altered account-status.local.md" }

    $firstBackupDir = (@(Get-ChildItem -LiteralPath (Join-Path $fakeGeminiHome "backups") -Directory | Sort-Object Name))[0].FullName
    $firstManifest = (Assert-FileFormatAndBudget -Path (Join-Path $firstBackupDir "manifest.json") -Context "First backup manifest.json" -SkipSizeLimit) | ConvertFrom-Json
    if ($firstManifest.fileCount -ne 3 -or @($firstManifest.files).Count -ne 3) { throw "Expected 3 backed-up files in first manifest, got $($firstManifest.fileCount)" }
    foreach ($entry in @($firstManifest.files)) {
        if (-not (Test-Path -LiteralPath $entry.backupPath -PathType Leaf)) { throw "Backup file missing: $($entry.backupPath)" }
        if ((Get-FileHash -LiteralPath $entry.backupPath -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Backup SHA256 mismatch for $($entry.relativePath)" }
    }
    if ([System.IO.File]::ReadAllText((Join-Path $firstBackupDir "GEMINI.md"), $strictUtf8) -cne $priorGemini -or
        [System.IO.File]::ReadAllText((Join-Path $firstBackupDir "guidance\engineering-workflow.md"), $strictUtf8) -cne $priorEngineering -or
        [System.IO.File]::ReadAllText((Join-Path $firstBackupDir "antigravity\skills\tools-reference\SKILL.md"), $strictUtf8) -cne $priorSkill) {
        throw "First backup files do not match prior content verbatim"
    }

    & $installScript -Profile "catgirl" -GeminiHome $fakeGeminiHome -TargetUserProfile (Join-Path ("C:" + [char]92 + "Users") "TwentyCharUser123456") -RulesParentRoot $toolkitRoot | Out-Null
    $null = Assert-BuiltProfileBundle -Root $fakeGeminiHome -Profile "catgirl"
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $privateCareContent) { throw "Catgirl install altered personal-care.local.md" }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) { throw "Catgirl install altered account-status.local.md" }
    $backupDirsAfterCatgirl = @(Get-ChildItem -LiteralPath (Join-Path $fakeGeminiHome "backups") -Directory | Sort-Object Name)
    if ($backupDirsAfterCatgirl.Count -ne 2) { throw "Expected 2 backup dirs after catgirl install, got $($backupDirsAfterCatgirl.Count)" }
    $secondManifest = (Assert-FileFormatAndBudget -Path (Join-Path $backupDirsAfterCatgirl[1].FullName "manifest.json") -Context "Second backup manifest.json" -SkipSizeLimit) | ConvertFrom-Json
    if ($secondManifest.fileCount -ne 7 -or @($secondManifest.files).Count -ne 7) { throw "Expected 7 backed-up managed files in second manifest, got $($secondManifest.fileCount)" }

    $customCareSource = Join-Path $testRoot "custom-personal-care.md"
    $customCareContent = "# Custom Private Care`ncustom-care-installed-marker`n"
    [System.IO.File]::WriteAllText($customCareSource, $customCareContent, $utf8NoBom)
    & $installScript -Profile "catgirl" -GeminiHome $fakeGeminiHome -LocalCarePath $customCareSource -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $customCareContent) { throw "Explicit -LocalCarePath did not install personal-care.local.md" }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) { throw "Explicit -LocalCarePath altered account-status.local.md" }
    $backupDirsAfterCare = @(Get-ChildItem -LiteralPath (Join-Path $fakeGeminiHome "backups") -Directory | Sort-Object Name)
    if ($backupDirsAfterCare.Count -ne 3) { throw "Expected 3 backup dirs after LocalCarePath install, got $($backupDirsAfterCare.Count)" }
    if ([System.IO.File]::ReadAllText((Join-Path $backupDirsAfterCare[2].FullName "guidance\personal-care.local.md"), $strictUtf8) -cne $privateCareContent) { throw "LocalCarePath install did not back up prior personal-care.local.md" }

    # 4c. Rollback restoration verification (full createdFiles cleanup + verbatim restoration + private .local.md preservation)
    foreach ($cFile in @($firstManifest.createdFiles)) {
        if (Test-Path -LiteralPath $cFile -PathType Leaf) { Remove-Item -LiteralPath $cFile -Force }
        if (Test-Path -LiteralPath $cFile) { throw "Rollback left created file behind: $cFile" }
    }
    foreach ($entry in @($firstManifest.files)) {
        Copy-Item -LiteralPath $entry.backupPath -Destination $entry.originalPath -Force
        if ((Get-FileHash -LiteralPath $entry.originalPath -Algorithm SHA256).Hash -ne $entry.sha256) {
            throw "Rollback SHA256 mismatch for $($entry.relativePath)"
        }
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGeminiHome "GEMINI.md"), $strictUtf8) -cne $priorGemini -or
        [System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "engineering-workflow.md"), $strictUtf8) -cne $priorEngineering -or
        [System.IO.File]::ReadAllText((Join-Path $fakeSkillDir "SKILL.md"), $strictUtf8) -cne $priorSkill) {
        throw "Rollback did not restore prior managed files verbatim"
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $customCareContent) { throw "Rollback unexpectedly altered personal-care.local.md" }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) { throw "Rollback altered account-status.local.md" }
    if (@(Get-ChildItem -LiteralPath $fakeGeminiHome -Recurse -File -Filter "*.tmp.*").Count -gt 0) { throw "Leftover .tmp.* found after atomic install" }

    # 5. Strict 3-layer sanitization scan
    Assert-Sanitization -RulesDirectory $rulesRoot -InstallDirectory $installRoot

    Write-Output "Antigravity Rules engineering checks passed (structural + breathing cap <= $maxHealthyGeminiBytes B + toxic-regression block + dual-profile + rollback + sanitization). Note: model behavior must be verified via real-scenario regression, not static text checks."
} finally {
    $resolvedRoot = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedRoot)).TrimEnd('\', '/')
    if ($resolvedParent -ne $tempParent -or -not ([System.IO.Path]::GetFileName($resolvedRoot) -match '^agy-rules-test-[0-9a-f]{32}$')) {
        throw "Refusing to remove a test directory outside its exclusive Temp root: $resolvedRoot"
    }
    if (Test-Path -LiteralPath $resolvedRoot) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
