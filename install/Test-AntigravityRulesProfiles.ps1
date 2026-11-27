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
    $engineeringText = $fileMap["guidance\engineering-workflow.md"]
    $commBridgesText = $fileMap["guidance\communication-bridges.md"]
    $maintenanceText = $fileMap["guidance\maintenance-upgrades.md"]
    $webVisualText = $fileMap["guidance\web-visual.md"]
    $skillText = $fileMap["antigravity\skills\tools-reference\SKILL.md"]
    $combinedText = ($expectedManagedRelativePaths | ForEach-Object { $fileMap[$_] }) -join "`n"

    $videoWord = [regex]::Unescape('\u89c6\u9891')
    $audioWord = [regex]::Unescape('\u97f3\u9891')
    $obsoleteKeyframe = [regex]::Unescape('\u5fc5\u62bd\u53d6\u6e05\u6670 WebP \u5173\u952e\u5e27')
    $liftedPrereqWord = [regex]::Unescape('\u5df2\u64a4/\u8c03\u524d\u7f6e')
    $relockPrereqWord = [regex]::Unescape('\u9501\u56de\u5df2\u64a4\u524d\u7f6e')
    $safetyGateWord = [regex]::Unescape('\u5b89\u5168\u95e8\u7981')
    $proxyEnvelopeWord = [regex]::Unescape('\u4ee3\u7406\u5c01\u5957')
    $noTagOnlyWord = [regex]::Unescape('\u4e25\u7981\u5355\u770b')
    $proxyRelayEnvelopeWord = [regex]::Unescape('\u4ee3\u7406\u8f6c\u9001\u5c01\u5957')
    $directOriginalWord = [regex]::Unescape('\u65e0\u5c01\u5957\u7684\u540c\u673a\u771f\u5b9e\u539f\u4ef6')
    $oralRelayOnlyWord = [regex]::Unescape('\u4ec5\u6709\u4ee3\u7406\u53e3\u5934\u8f6c\u8ff0')
    $agentMsgTypeWord = [regex]::Unescape('\u6765\u6e90\u7c7b\u578b\uff1aagent_message')
    $batchScopeWord = [regex]::Unescape('\u4ec5\u9650\u9002\u7528\u6279\u6b21')
    $channelWindowWord = [regex]::Unescape('\u6e20\u9053\u4e0e\u65f6\u6bb5')
    $immediateReturnWord = [regex]::Unescape('\u7acb\u523b\u56de\u6765\u914d\u5408')
    $privateRuleFirstWord = [regex]::Unescape('\u79c1\u6709\u7ea6\u5b9a\u4f18\u5148')
    $maintPubDutyWord = [regex]::Unescape('\u7ef4\u62a4\u4e0e\u516c\u5f00\u53d1\u5e03\u804c\u8d23')
    $serialWriteWindowWord = [regex]::Unescape('\u4e32\u884c\u5199\u7a97')
    $actualTurnWord = [regex]::Unescape('\u5b9e\u9645\u8f6e\u5230\u672c\u7ebf')
    $validHandoffWord = [regex]::Unescape('\u672c\u6b21\u4ea4\u68d2')
    $prevStillPushingWord = [regex]::Unescape('\u4e0a\u4e00\u68d2')
    $fromUserArrWord = [regex]::Unescape('\u5df2\u6709\u5b89\u6392\u6838\u5bf9\u672c\u7ebf')
    $autoStageCommitPushWord = [regex]::Unescape('\u81ea\u4e3b\u7cbe\u786e\u6682\u5b58\u3001\u63d0\u4ea4\u5e76\u63a8\u9001')
    $autoStagePushCleanWord = [regex]::Unescape('\u81ea\u4e3b\u7cbe\u786e\u6682\u5b58\u3001\u63d0\u4ea4\u5e76\u63a8\u9001\u8131\u654f\u5185\u5bb9')
    $noManualApproveEachWord = [regex]::Unescape('\u514d\u9010\u6b21\u4eba\u5de5\u6279\u63a8')
    $noAskApproveEachWord = [regex]::Unescape('\u514d\u9010\u6b21')
    $pushRemoteWord = [regex]::Unescape('\u63a8\u9001\u8fdc\u7aef')
    $verifyRemoteWord = [regex]::Unescape('\u6838\u67e5\u8fdc\u7aef\u7ed3\u679c')
    $keepSharedWriteStepWord = [regex]::Unescape('\u4fdd\u7559\u5171\u4eab\u5199\u5165\u8fd9\u4e00\u6b65')
    $indepVerifyNoStageWord = [regex]::Unescape('\u4e0d\u78b0\u6682\u5b58\u533a\u7684\u72ec\u7acb\u9a8c\u8bc1')
    $noAutoCommitPushWord = [regex]::Unescape('\u4e0d\u64c5\u81ea `git commit`/`git push`')
    $pushNotUpgradeWord = [regex]::Unescape('\u6e90\u7801\u63a8\u4ed3\u4e0d\u7b49\u4e8e\u81ea\u52a8\u5347\u7ea7')
    $mixOthersChangesWord = [regex]::Unescape('\u6df7\u5165\u4ed6\u4eba\u6539\u52a8')
    $wholeBlockDeliveryWord = [regex]::Unescape('\u72ec\u7acb\u9a8c\u6536\u7684\u6574\u5757\u4ea4\u4ed8')
    $helperHandWord = [regex]::Unescape('\u5e2e\u628a\u624b')
    $beforeCheckpointWord = [regex]::Unescape('\u9a8c\u6536\u70b9\u524d')
    $noStepwiseReportWord = [regex]::Unescape('\u9a8c\u6536\u70b9\u524d\u514d\u9010\u6b65\u6c47\u62a5')
    $dailyOnlyReportScopeWord = [regex]::Unescape('\u9650\u642d\u6863\u65e5\u5e38\u8fdb\u5c55')
    $agreedReportWord = [regex]::Unescape('\u7ea6\u5b9a\u6c47\u62a5')
    $onlyTrueDepWaitWord = [regex]::Unescape('\u53ea\u7b49\u771f\u4f9d\u8d56')
    $riskDeviationSyncWord = [regex]::Unescape('\u98ce\u9669/\u524d\u7f6e/\u6392\u671f\u504f\u5dee')
    $scheduleDeviationWord = [regex]::Unescape('\u6392\u671f\u504f\u5dee')
    $scheduleMutualReviewWord = [regex]::Unescape('\u6392\u671f\u4e92\u5ba1')
    $equalScheduleReviewWord = [regex]::Unescape('\u53cc\u5411\u5bf9\u7b49\u6392\u671f\u4e92\u5ba1')
    $ignoreScheduleObjectionWord = [regex]::Unescape('\u5ffd\u89c6\u5bf9\u7aef\u6392\u671f\u5f02\u8bae')
    $smallFactQueryWord = [regex]::Unescape('\u5c0f\u4e8b\u5b9e\u8be2\u95ee')
    $noForcedDualReviewWord = [regex]::Unescape('\u4e0d\u4e3a\u72ec\u7acb\u7b80\u5355\u8be2\u95ee\u786c\u6d3e\u53cc\u5ba1')
    $noPartnerMicroPlanWord = [regex]::Unescape('\u642d\u6863\u4e0d\u4ee3\u6392\u6bcf\u6b65')
    $escapePreviewWord = [regex]::Unescape('\u9884\u544a\u4e0b\u4e00\u6b65\u5f53\u4ea4\u4ed8')
    $escapeSuggestCheckWord = [regex]::Unescape('\u62ff\u5efa\u8bae\u67e5/\u7b49\u6838\u5b9e\u505c\u5de5')
    $escapeSingleWaitAllSleepWord = [regex]::Unescape('\u5355\u652f\u7ebf\u7b49\u5f85\u8fde\u5e26\u5168\u7ebf\u4f11\u7720')
    $escapeToothpasteWord = [regex]::Unescape('\u540c\u6e90\u6e90\u7801\u5728\u624b\u6324\u7259\u818f\u5fae\u6b65')
    $oldThreeHardScenesWord = [regex]::Unescape('\u4e09\u7c7b\u786c\u573a\u666f')
    $oldZeroReleaseWord = [regex]::Unescape('\u96f6\u653e\u884c')
    $fiveToTenMinWord = '5' + [regex]::Unescape('\uff5e') + '10m'
    $oldTenToThirtyMinWord = '10' + [regex]::Unescape('\uff5e') + '30m'
    $twentyToThirtyMinWord = '20' + [regex]::Unescape('\uff5e') + '30m'
    $encourageDelayCritiqueWord = [regex]::Unescape('\u9f13\u52b1\u5bf9\u7aef\u63d0\u672c\u7aef\u62d6\u5ef6')
    $transientOmitWord = [regex]::Unescape('\u77ac\u6001\u6f0f\u663e')
    $maybeTransientOmitWord = [regex]::Unescape('\u53ef\u80fd\u77ac\u6001\u6f0f\u663e')
    $noBlindStackWord = [regex]::Unescape('\u76f2\u76ee\u53e0\u6302')
    $omitStackWord = [regex]::Unescape('\u6f0f\u663e\u53e0\u6302')
    $hostDeadlockWord = [regex]::Unescape('\u5bbf\u4e3b\u7ea7\u5361\u6b7b')
    $platformDeadlockNoBypassWord = [regex]::Unescape('\u5e73\u53f0\u7ea7\u5361\u6b7b\u7f29\u95f4\u9694\u65e0\u6548')
    $soloSwitch8mWord = [regex]::Unescape('\u6539\u5355\u5e72 `*/8`')
    $cannotBypassDeadlockWord = [regex]::Unescape('\u5355\u9760\u7f29\u95f4\u9694\u65e0\u6cd5\u7ed5\u5f00')
    $nonShrinkBypassWord = [regex]::Unescape('\u975e\u7f29\u95f4\u9694\u53ef\u7ed5')
    $oldSharedGitBlockers = @(
        ([regex]::Unescape('\u4ec5\u83b7\u51c6\u5e76\u786e\u8ba4\u4e32\u884c')),
        ([regex]::Unescape('\u786e\u8ba4\u65e0\u5360\u7528\u5373\u53ef')),
        ([regex]::Unescape('\u6216\u7528\u6237\u786e\u8ba4\u4e32\u884c')),
        ([regex]::Unescape('\u6216\u4e3b\u4eba\u786e\u8ba4\u4e32\u884c')),
        ([regex]::Unescape('\u672a\u83b7\u5355\u7aef\u63d0\u4ea4\u6307\u4ee4')),
        ([regex]::Unescape('\u5df2\u83b7\u7528\u6237\u660e\u786e\u6388\u6743\u65f6\u7cbe\u786e\u63d0\u4ea4')),
        ([regex]::Unescape('\u5df2\u83b7\u4e3b\u4eba\u660e\u786e\u6388\u6743\u65f6\u7cbe\u786e\u63d0\u4ea4')),
        ([regex]::Unescape('\u5df2\u83b7\u7528\u6237\u5355\u7aef\u63d0\u4ea4\u6388\u6743')),
        ([regex]::Unescape('\u5df2\u83b7\u4e3b\u4eba\u5355\u7aef\u63d0\u4ea4\u6388\u6743'))
    )

    foreach ($marker in @("read_file", $videoWord, $audioWord, "PDF", "PyMuPDF", "150 DPI", "update_steps", "done", "skipped", "< 24,000", "10 KiB", "communication-core")) {
        Assert-Contains $combinedText $marker "$Profile core specification"
    }
    foreach ($marker in @("read_file", $videoWord, $audioWord, "PDF", "PyMuPDF", "150 DPI")) {
        Assert-Contains $webVisualText $marker "$Profile web-visual multimodal contract"
    }
    foreach ($marker in @("read_file", "update_steps", "done", "skipped", "< 24,000", "10 KiB", "communication-core", $liftedPrereqWord, $relockPrereqWord, $safetyGateWord, "USER_INPUT", $proxyEnvelopeWord, $privateRuleFirstWord, $maintPubDutyWord, $serialWriteWindowWord, $actualTurnWord, $fromUserArrWord, $autoStagePushCleanWord, $noManualApproveEachWord, $wholeBlockDeliveryWord, $helperHandWord, $beforeCheckpointWord, $noStepwiseReportWord, $dailyOnlyReportScopeWord, $agreedReportWord, $onlyTrueDepWaitWord, $riskDeviationSyncWord, $scheduleMutualReviewWord, $smallFactQueryWord, $noForcedDualReviewWord, "*/8 * * * *", $fiveToTenMinWord, "*/30 * * * *", $encourageDelayCritiqueWord, $platformDeadlockNoBypassWord, $omitStackWord)) {
        Assert-Contains $geminiText $marker "$Profile GEMINI core contract"
    }
    foreach ($marker in @($channelWindowWord, $immediateReturnWord, $maintPubDutyWord, $serialWriteWindowWord, $actualTurnWord, $validHandoffWord, $prevStillPushingWord, $fromUserArrWord, "maintenance-upgrades.md", $autoStageCommitPushWord, ".git/index.lock", "reconnect-sync.md", $keepSharedWriteStepWord, $indepVerifyNoStageWord, "worktree", $mixOthersChangesWord, $wholeBlockDeliveryWord, $helperHandWord, $beforeCheckpointWord, $noStepwiseReportWord, $dailyOnlyReportScopeWord, $agreedReportWord, $onlyTrueDepWaitWord, $riskDeviationSyncWord, $equalScheduleReviewWord, $smallFactQueryWord)) {
        Assert-Contains $commBridgesText $marker "$Profile communication-bridges external IM & shared-repo contract"
    }
    foreach ($marker in @($maintPubDutyWord, $serialWriteWindowWord, $actualTurnWord, $validHandoffWord, $prevStillPushingWord, $fromUserArrWord, $noAutoCommitPushWord, "git status", "git diff", "git fetch", "git add -- <paths>", "git add .", "git diff --cached", "force push", ".git/config", "worktree", $pushRemoteWord, $verifyRemoteWord, $noAskApproveEachWord, $pushNotUpgradeWord, ".git/index.lock", "reconnect-sync.md", $keepSharedWriteStepWord, $indepVerifyNoStageWord)) {
        Assert-Contains $maintenanceText $marker "$Profile maintenance-upgrades shared-repo publish contract"
    }
    foreach ($blocker in $oldSharedGitBlockers) {
        Assert-NotContains $geminiText $blocker "$Profile GEMINI obsolete shared-repo blocker"
        Assert-NotContains $maintenanceText $blocker "$Profile maintenance-upgrades obsolete shared-repo blocker"
        Assert-NotContains $commBridgesText $blocker "$Profile communication-bridges obsolete shared-repo blocker"
    }
    foreach ($marker in @($liftedPrereqWord, $relockPrereqWord, $safetyGateWord, $batchScopeWord, "USER_INPUT", "USER_EXPLICIT", "[COMMUNICATION_CORE", $agentMsgTypeWord, "@[Quote]", "conversation_read_original", $noTagOnlyWord, $proxyRelayEnvelopeWord, $directOriginalWord, $oralRelayOnlyWord, $wholeBlockDeliveryWord, $helperHandWord, $beforeCheckpointWord, $noStepwiseReportWord, $dailyOnlyReportScopeWord, $agreedReportWord, $scheduleDeviationWord, $onlyTrueDepWaitWord, $scheduleMutualReviewWord, $ignoreScheduleObjectionWord, $smallFactQueryWord, $noForcedDualReviewWord, $noPartnerMicroPlanWord, $escapePreviewWord, $escapeSuggestCheckWord, $escapeSingleWaitAllSleepWord, $escapeToothpasteWord, "*/8 * * * *", $fiveToTenMinWord, "*/5", "<5m", "400/503", "Error Unknown", "manage_task(list)", $maybeTransientOmitWord, $noBlindStackWord, $hostDeadlockWord, $cannotBypassDeadlockWord, $soloSwitch8mWord, "*/30 * * * *", $twentyToThirtyMinWord)) {
        Assert-Contains $engineeringText $marker "$Profile engineering-workflow recovery & USER_INPUT contract"
    }
    foreach ($marker in @("USER_INPUT", "USER_EXPLICIT", "[COMMUNICATION_CORE", $agentMsgTypeWord, "@[Quote]", "conversation_read_original", $noTagOnlyWord, $proxyRelayEnvelopeWord, $directOriginalWord, $oralRelayOnlyWord, "*/8 * * * *", $fiveToTenMinWord, "*/5", "<5m", "400/503", "Error Unknown", "manage_task(list)", $transientOmitWord, $noBlindStackWord, $nonShrinkBypassWord)) {
        Assert-Contains $skillText $marker "$Profile tools-reference USER_INPUT envelope contract"
    }

    # Round 18: four-layer living recent-status + compaction dual-anchor raw read (strict R18-exclusive anchors)
    $r18GeminiMarkers = @(
        ([regex]::Unescape('\u773c\u524d\u5148\u987e\u4ec0\u4e48\uff08\u7f6e\u9876\u8986\u76d6\u5237\u65b0\uff09')),
        ([regex]::Unescape('\u957f\u671f\u6709\u6548\u539f\u5219\u3001\u5e95\u7ebf\u4e0e\u6838\u5fc3\u5631\u6258')),
        ([regex]::Unescape('\u7edd\u4e0d\u968f `K` \u6ed1\u7a97\u6dd8\u6c70')),
        ([regex]::Unescape('\u8fc7\u7a0b/\u65e7\u72b6\u6001/\u6d41\u6c34\u6218\u62a5\u7981\u5165')),
        ([regex]::Unescape('\u5df2\u56fa\u5316\u81ea\u52a8\u95e8\u7981\u7559\u53ef\u5bfb\u7d22\u5f15')),
        ([regex]::Unescape('\u8bdd\u9898\u81ea\u7136\u7ed3\u675f\u6216\u8f6c\u5411')),
        ([regex]::Unescape('\u51fa\u7a97\u63d0\u7eaf')),
        ([regex]::Unescape('\u7ea6 `30 KB` \u76ee\u6807')),
        ([regex]::Unescape('`40 KB` \u89e6\u53d1\u7626\u8eab')),
        ([regex]::Unescape('\u9047 `Partial read` \u622a\u65ad\u6cbf\u539f `ByteOffset`/\u6e38\u6807\u7eed\u8bfb\u5168')),
        ([regex]::Unescape('\u4e25\u7981\u53ea\u8bfb\u524d\u534a\u622a\u5f00\u5e72')),
        ([regex]::Unescape('\u9996\u62cd\u5e76\u884c\u53cc\u951a\u70b9\u56de\u8bfb')),
        ([regex]::Unescape('\u538b\u7f29\u524d\u8fd1\u671f\u7eaf\u51c0\u4eba\u673a\u539f\u6587')),
        ([regex]::Unescape('\u539f\u53e5\u4ecd\u5728\u5f53\u524d\u4e0a\u4e0b\u6587\u5219\u53ea\u8865\u7f3a\u4e0d\u91cd\u8bfb\uff0c\u6458\u8981\u53ea\u5b9a\u4f4d')),
        ([regex]::Unescape('\u8bfb\u538b\u7f29\u524d `3\uff5e5` \u8f6e\u4ec5\u4f5c\u7269\u7406\u8d77\u70b9\u7a97\u53e3')),
        ([regex]::Unescape('\u5fc5\u5148\u5254\u9664\u4ee3\u7406\u5c01\u5957')),
        ([regex]::Unescape('\u9996\u6279\u88ab\u4ee3\u7406/\u5524\u9192\u5360\u6ee1\u672a\u89c1\u65e0\u5c01\u5957\u539f\u8bdd\u65f6\u5fc5\u5b9a\u70b9\u5411\u4e0a\u6269\u7a97')),
        ([regex]::Unescape('\u5f53\u8f6e\u8865\u5f55\u8fd1\u51b5\u518d\u63a8')),
        ([regex]::Unescape('\u4ec5\u6682\u7f13\u786e\u5b9e\u4f9d\u8d56\u8be5\u539f\u8bdd\u7684\u51b3\u5b9a\uff0c\u4f59\u660e\u786e\u6388\u6743\u7167\u63a8'))
    )
    foreach ($marker in $r18GeminiMarkers) {
        Assert-Contains $geminiText $marker "$Profile GEMINI Round 18 living-memory & compaction contract"
    }
    $r18EngineeringMarkers = @(
        ([regex]::Unescape('\u4e0d\u56e0\u5355\u7eaf\u538b\u7f29/\u5524\u9192\u6062\u590d\u989d\u5916\u65b0\u8d77\u53cc\u5ba1')),
        ([regex]::Unescape('\u5c06\u9a8c\u8bc1\u5de5\u5e8f\u6216\u65e9\u671f\u6838\u5fc3\u8981\u6c42\u6324\u51fa\u6392\u671f')),
        ([regex]::Unescape('\u9002\u7528\u957f\u671f\u539f\u5219\u4e0e\u6838\u5fc3\u5631\u6258\u672a\u771f\u6b63\u6539\u53d8\u67b6\u6784\u9009\u62e9\u4e0e\u771f\u5b9e\u4ea4\u4ed8\u6210\u54c1')),
        ([regex]::Unescape('\u5b64\u7acb\u5355\u6d4b/Mock')),
        ([regex]::Unescape('\u538b\u7f29\u540e\u6f0f\u8bfb\u8fd1\u671f\u7eaf\u51c0\u539f\u6587')),
        ([regex]::Unescape('\u6574\u4efd\u8fd1\u51b5\u7ea6 `30 KB` \u76ee\u6807\u3001`40 KB` \u89e6\u53d1\u7626\u8eab')),
        ([regex]::Unescape('\u9047 `Partial read` \u622a\u65ad\u5fc5\u6cbf\u539f `ByteOffset`/\u6e38\u6807\u7eed\u8bfb\u5168')),
        ([regex]::Unescape('\u4e25\u7981\u53ea\u8bfb\u524d\u534a\u622a\u5f00\u5e72')),
        ([regex]::Unescape('\u9996\u62cd\u5e76\u884c\u53cc\u951a\u70b9\u56de\u8bfb')),
        ([regex]::Unescape('\u538b\u7f29\u524d\u8fd1\u671f\u7eaf\u51c0\u4eba\u673a\u539f\u6587')),
        ([regex]::Unescape('\u6700\u8fd1\u539f\u53e5\u4ecd\u5b8c\u6574\u7559\u5728\u5f53\u524d\u4e0a\u4e0b\u6587\u5219\u53ea\u8865\u7f3a\u4e0d\u91cd\u8bfb\uff0c\u6458\u8981\u4ec5\u4f5c\u5b9a\u4f4d')),
        ([regex]::Unescape('\u4ece\u538b\u7f29\u70b9\u524d\u8bfb `3\uff5e5` \u8f6e\u4ec5\u4f5c\u7269\u7406\u8d77\u70b9\u7a97\u53e3')),
        ([regex]::Unescape('\u5fc5\u5148\u5254\u9664\u4ee3\u7406\u8f6c\u9001\u5c01\u5957')),
        ([regex]::Unescape('\u82e5\u9996\u6279\u7a97\u53e3\u5168\u88ab\u4ee3\u7406/\u5524\u9192\u5360\u6ee1\u672a\u89c1\u65e0\u5c01\u5957\u539f\u8bdd\uff0c\u5fc5\u5b9a\u70b9\u5411\u4e0a\u6269\u7a97')),
        ([regex]::Unescape('\u5f53\u8f6e\u8865\u5f55\u8fd1\u51b5\u518d\u63a8')),
        ([regex]::Unescape('\u4ec5\u6682\u7f13\u786e\u5b9e\u4f9d\u8d56\u8be5\u539f\u8bdd\u7684\u51b3\u5b9a\uff0c\u4f59\u5df2\u83b7\u660e\u786e\u6388\u6743\u5de5\u4f5c\u7167\u63a8')),
        ([regex]::Unescape('\u6309\u8bdd\u9898\u81ea\u7136\u7ed3\u675f/\u8f6c\u5411\u8ba1')),
        ([regex]::Unescape('\u5df2\u56fa\u5316\u95e8\u7981\u7559\u53ef\u5bfb\u7d22\u5f15')),
        ([regex]::Unescape('\u8de8\u5bf9\u8bdd\u6309\u539f\u6388\u6743\u540c\u6b65 `memory-store` \u5e76\u6838\u672a\u7b54\u9879'))
    )
    foreach ($marker in $r18EngineeringMarkers) {
        Assert-Contains $engineeringText $marker "$Profile engineering-workflow Round 18 dual-review & recovery contract"
    }
    $r18SkillMarkers = @(
        ([regex]::Unescape('\u81ea\u52a8/`/compact` \u538b\u7f29\u53cc\u5165\u53e3\u62bd\u8bfb')),
        ([regex]::Unescape('\u7d27\u90bb\u538b\u7f29\u70b9\u524d **`3\uff5e5` \u8f6e\u7269\u7406\u8d77\u70b9**')),
        ([regex]::Unescape('\u517c\u5bb9 `content`/`response` \u5b57\u6bb5')),
        ([regex]::Unescape('\u9047 `truncated_fields` \u5b9a\u70b9\u6309\u884c\u8865\u8bfb `transcript_full.jsonl`')),
        'lastRounds=3~5, prepareCache=false',
        ([regex]::Unescape('\u53cc\u5165\u53e3\u5747\u5fc5\u5148\u5254\u9664\u4ee3\u7406\u5c01\u5957')),
        ([regex]::Unescape('Rules \u6ce8\u5165\u4e0e\u538b\u7f29\u6458\u8981')),
        ([regex]::Unescape('\u82e5\u9996\u6279 3\uff5e5 \u8f6e\u88ab\u4ee3\u7406\u4fe1/\u5524\u9192\u5360\u6ee1\u672a\u89c1\u65e0\u5c01\u5957\u539f\u8bdd\uff0c\u5fc5\u5b9a\u70b9\u5411\u4e0a\u6269\u7a97\u6216\u6cbf\u6765\u6e90\u7ee7\u7eed\u67e5'))
    )
    foreach ($marker in $r18SkillMarkers) {
        Assert-Contains $skillText $marker "$Profile tools-reference Round 18 compaction raw-read contract"
    }

    foreach ($rel in $expectedManagedRelativePaths) {
        $text = $fileMap[$rel]
        Assert-NotContains $text $obsoleteKeyframe "$Profile ($rel) obsolete multimodal rule"
        Assert-NotContains $text "4+1" "$Profile ($rel) obsolete 4+1 rule"
        Assert-NotContains $text $oldThreeHardScenesWord "$Profile ($rel) obsolete narrowed cross-host confirmation rule"
        Assert-NotContains $text $oldZeroReleaseWord "$Profile ($rel) obsolete zero-release heading wording"
        Assert-NotContains $text "*/20" "$Profile ($rel) obsolete 20m cron interval"
        Assert-NotContains $text $oldTenToThirtyMinWord "$Profile ($rel) obsolete 10-30m fullwidth cron window"
        Assert-NotContains $text "10~30m" "$Profile ($rel) obsolete 10~30m ascii cron window"
        Assert-NotContains $text "10-30m" "$Profile ($rel) obsolete 10-30m hyphen cron window"
    }

    $ownerWord = [regex]::Unescape('\u4e3b\u4eba')
    $catgirlWord = [regex]::Unescape('\u732b\u5a18')
    $meowWord = [regex]::Unescape('\u55b5')
    $kaomojiWord = [regex]::Unescape('\u989c\u6587\u5b57')
    $kaomojiSample = [regex]::Unescape('(\u30ce\u2200\u00b4)')

    if ($Profile -eq "catgirl") {
        $ownerRecentHeading = [regex]::Unescape('`\u4e3b\u4eba\u4ea4\u6d41\u8fd1\u51b5`')
        foreach ($marker in @($ownerWord, $catgirlWord, $kaomojiWord, $ownerRecentHeading)) {
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

    # 1. Build both profiles (catgirl & neutral) with a standard example user profile
    $stdUserProfile = Join-Path ("C:" + [char]92 + "Users") "ExampleUser"
    $buildRoot = Join-Path $testRoot "build"
    foreach ($profileId in @("catgirl", "neutral")) {
        $outDir = Join-Path $buildRoot $profileId
        & $buildScript -Profile $profileId -OutputDirectory $outDir -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
        $null = Assert-BuiltProfileBundle -Root $outDir -Profile $profileId
    }

    # 2. 20-character & 30-character username expansion stress build tests (both profiles + headroom check)
    $longUserName = "TwentyCharUser123456"
    $longUserProfile = Join-Path ("C:" + [char]92 + "Users") $longUserName
    $stressRoot = Join-Path $testRoot "stress-20char"
    foreach ($profileId in @("catgirl", "neutral")) {
        $stressDir = Join-Path $stressRoot $profileId
        & $buildScript -Profile $profileId -OutputDirectory $stressDir -TargetUserProfile $longUserProfile -RulesParentRoot $toolkitRoot | Out-Null
        $stressMap = Assert-BuiltProfileBundle -Root $stressDir -Profile $profileId
        Assert-Contains $stressMap["GEMINI.md"] $longUserName "$profileId 20-char username stress test"
        foreach ($rel in $expectedManagedRelativePaths) {
            $bLen = ([System.IO.File]::ReadAllBytes((Join-Path $stressDir $rel))).Length
            if (($maxRuleBytes - $bLen) -lt 200) {
                throw "$profileId 20-char stress headroom < 200 B for ${rel}: $bLen bytes (headroom=$($maxRuleBytes - $bLen) B)"
            }
        }
    }

    $longUserName30 = "ThirtyCharUserName123456789012"
    $longUserProfile30 = Join-Path ("C:" + [char]92 + "Users") $longUserName30
    $stressRoot30 = Join-Path $testRoot "stress-30char"
    foreach ($profileId in @("catgirl", "neutral")) {
        $stressDir30 = Join-Path $stressRoot30 $profileId
        & $buildScript -Profile $profileId -OutputDirectory $stressDir30 -TargetUserProfile $longUserProfile30 -RulesParentRoot $toolkitRoot | Out-Null
        $stressMap30 = Assert-BuiltProfileBundle -Root $stressDir30 -Profile $profileId
        Assert-Contains $stressMap30["GEMINI.md"] $longUserName30 "$profileId 30-char username stress test"
        foreach ($rel in $expectedManagedRelativePaths) {
            $bLen = ([System.IO.File]::ReadAllBytes((Join-Path $stressDir30 $rel))).Length
            if (($maxRuleBytes - $bLen) -lt 200) {
                throw "$profileId 30-char stress headroom < 200 B for ${rel}: $bLen bytes (headroom=$($maxRuleBytes - $bLen) B)"
            }
        }
    }

    $longUserName30Sp = "Thirty Char User Name 12345678"
    $longUserProfile30Sp = Join-Path ("C:" + [char]92 + "Users") $longUserName30Sp
    $stressRoot30Sp = Join-Path $testRoot "stress-30char-4space"
    foreach ($profileId in @("catgirl", "neutral")) {
        $stressDir30Sp = Join-Path $stressRoot30Sp $profileId
        & $buildScript -Profile $profileId -OutputDirectory $stressDir30Sp -TargetUserProfile $longUserProfile30Sp -RulesParentRoot $toolkitRoot | Out-Null
        $stressMap30Sp = Assert-BuiltProfileBundle -Root $stressDir30Sp -Profile $profileId
        Assert-Contains $stressMap30Sp["GEMINI.md"] "Thirty%20Char%20User%20Name%2012345678" "$profileId 30-char 4-space URI encoding test"
        foreach ($rel in $expectedManagedRelativePaths) {
            $bLen = ([System.IO.File]::ReadAllBytes((Join-Path $stressDir30Sp $rel))).Length
            if (($maxRuleBytes - $bLen) -lt 200) {
                throw "$profileId 30-char 4-space stress headroom < 200 B for ${rel}: $bLen bytes (headroom=$($maxRuleBytes - $bLen) B)"
            }
        }
    }

    $localCareExamplePath = Join-Path $rulesRoot "local-care.example.md"
    $localCareExampleText = Assert-FileFormatAndBudget -Path $localCareExamplePath -Context "Public local-care.example.md"
    Assert-Contains $localCareExampleText "<your-shared-toolkit-repo>" "local-care.example.md shared-repo placeholder"
    Assert-Contains $localCareExampleText ([regex]::Unescape('\u4e0d\u64c5\u81ea commit/push')) "local-care.example.md non-shared default guardrail"
    $r18CareMarkers = @(
        ([regex]::Unescape('\u56db\u5c42\u6d3b\u8fd1\u51b5')),
        ([regex]::Unescape('\u773c\u524d\u5148\u987e\u4ec0\u4e48\uff08\u7f6e\u9876\u8986\u76d6\u5237\u65b0\uff09')),
        ([regex]::Unescape('\u957f\u671f\u6709\u6548\u539f\u5219\u3001\u5e95\u7ebf\u4e0e\u6838\u5fc3\u5631\u6258')),
        ([regex]::Unescape('\u4e0d\u968f `K` \u6ed1\u7a97\u6dd8\u6c70')),
        ([regex]::Unescape('\u5df2\u56fa\u5316\u4e3a\u81ea\u52a8\u95e8\u7981\u4ecd\u7559\u53ef\u5bfb\u7d22\u5f15')),
        ([regex]::Unescape('\u6309\u8bdd\u9898\u81ea\u7136\u7ed3\u675f/\u8f6c\u5411\u8ba1 1 \u6b21')),
        ([regex]::Unescape('\u65e7\u8bdd\u9898\u51fa\u7a97\u524d\u5148\u62bd\u63d0\u4ecd\u751f\u6548\u539f\u5219\u664b\u5347\u7b2c 2 \u5c42\u5e76\u6838\u672a\u7b54\u9879')),
        ([regex]::Unescape('\u7ea6 `30 KB` \u76ee\u6807\u3001`40 KB` \u89e6\u53d1\u7626\u8eab\u9632 `46,080 B` \u622a\u65ad')),
        ([regex]::Unescape('\u9047\u622a\u65ad\u5fc5\u7eed\u8bfb\u5168\uff0c\u538b\u7f29\u6062\u590d\u9996\u62cd\u540c\u65f6\u56de\u8bfb\u8fd1\u51b5\u4e0e\u538b\u7f29\u524d\u8fd1\u671f\u7eaf\u51c0\u539f\u6587'))
    )
    foreach ($marker in $r18CareMarkers) {
        Assert-Contains $localCareExampleText $marker "local-care.example.md Round 18 four-layer living-memory contract"
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

    # 4. Isolated installation tests (catgirl & neutral, private .local.md protection, backups + manifest, example rejection)
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

    # 4a. Direct local-care.example.md must be rejected by both Build and Install without mutating target
    $exampleCarePath = Join-Path $rulesRoot "local-care.example.md"
    if (-not (Test-Path -LiteralPath $exampleCarePath -PathType Leaf)) {
        throw "Missing local-care.example.md: $exampleCarePath"
    }
    $buildRejected = $false
    try {
        & $buildScript -Profile "catgirl" -OutputDirectory (Join-Path $testRoot "reject-build") -LocalCarePath $exampleCarePath -RulesParentRoot $toolkitRoot | Out-Null
    } catch {
        if ($_.Exception.Message -match 'local-care\.example\.md') { $buildRejected = $true } else { throw }
    }
    if (-not $buildRejected) {
        throw "Build-AntigravityRulesProfile.ps1 did not reject direct local-care.example.md"
    }

    $driveRootRejected = $false
    try {
        & $buildScript -Profile "catgirl" -OutputDirectory (Join-Path $testRoot "reject-root") -TargetUserProfile "C:\" -RulesParentRoot $toolkitRoot | Out-Null
    } catch {
        if ($_.Exception.Message -match 'drive root') { $driveRootRejected = $true } else { throw }
    }
    if (-not $driveRootRejected) {
        throw "Build-AntigravityRulesProfile.ps1 did not reject drive-root TargetUserProfile"
    }

    $spaceOut = Join-Path $testRoot "build-space-user"
    $spaceProfile = Join-Path "C:\Users" ("Example" + " Space")
    & $buildScript -Profile "catgirl" -OutputDirectory $spaceOut -TargetUserProfile $spaceProfile -RulesParentRoot $toolkitRoot | Out-Null
    $spaceMap = Assert-BuiltProfileBundle -Root $spaceOut -Profile "catgirl"
    Assert-Contains $spaceMap["GEMINI.md"] ("file:///C:/" + "Users/Example%20Space/.gemini/") "catgirl space URI %20 encoding"

    $emptyCareFile = Join-Path $testRoot "empty-care.md"
    [System.IO.File]::WriteAllText($emptyCareFile, "   `n", $utf8NoBom)
    $emptyCareRejected = $false
    try {
        & $buildScript -Profile "catgirl" -OutputDirectory (Join-Path $testRoot "reject-empty-care") -LocalCarePath $emptyCareFile -RulesParentRoot $toolkitRoot | Out-Null
    } catch {
        if ($_.Exception.Message -match 'empty') { $emptyCareRejected = $true } else { throw }
    }
    if (-not $emptyCareRejected) {
        throw "Build-AntigravityRulesProfile.ps1 did not reject whitespace-only LocalCarePath"
    }

    $beforeRejectHash = (Get-FileHash -LiteralPath (Join-Path $fakeGeminiHome "GEMINI.md") -Algorithm SHA256).Hash
    $installRejected = $false
    try {
        & $installScript -Profile "catgirl" -GeminiHome $fakeGeminiHome -LocalCarePath $exampleCarePath -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
    } catch {
        if ($_.Exception.Message -match 'local-care\.example\.md') { $installRejected = $true } else { throw }
    }
    if (-not $installRejected) {
        throw "Install-AntigravityRulesProfile.ps1 did not reject direct local-care.example.md"
    }
    if ((Get-FileHash -LiteralPath (Join-Path $fakeGeminiHome "GEMINI.md") -Algorithm SHA256).Hash -ne $beforeRejectHash) {
        throw "Rejected installation modified target GEMINI.md"
    }

    # 4b. Install neutral profile into isolated home
    & $installScript -Profile "neutral" -GeminiHome $fakeGeminiHome -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
    $null = Assert-BuiltProfileBundle -Root $fakeGeminiHome -Profile "neutral"
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $privateCareContent) {
        throw "Neutral install modified or removed existing personal-care.local.md"
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) {
        throw "Neutral install modified or removed existing account-status.local.md"
    }

    $backupDirsAfterNeutral = @(Get-ChildItem -LiteralPath (Join-Path $fakeGeminiHome "backups") -Directory | Sort-Object Name)
    if ($backupDirsAfterNeutral.Count -ne 1) {
        throw "Expected 1 backup directory after neutral install, found $($backupDirsAfterNeutral.Count)"
    }
    $firstBackupDir = $backupDirsAfterNeutral[0].FullName
    $firstManifestPath = Join-Path $firstBackupDir "manifest.json"
    if (-not (Test-Path -LiteralPath $firstManifestPath -PathType Leaf)) {
        throw "Missing backup manifest.json: $firstManifestPath"
    }
    $firstManifest = (Assert-FileFormatAndBudget -Path $firstManifestPath -Context "First backup manifest.json" -SkipSizeLimit) | ConvertFrom-Json
    if ($firstManifest.fileCount -ne 3 -or @($firstManifest.files).Count -ne 3) {
        throw "Expected 3 backed-up files in first manifest, got $($firstManifest.fileCount)"
    }
    foreach ($entry in @($firstManifest.files)) {
        if (-not (Test-Path -LiteralPath $entry.backupPath -PathType Leaf)) {
            throw "Backup file listed in manifest is missing: $($entry.backupPath)"
        }
        $actualHash = (Get-FileHash -LiteralPath $entry.backupPath -Algorithm SHA256).Hash
        if ($actualHash -ne $entry.sha256) {
            throw "Backup SHA256 mismatch for $($entry.relativePath)"
        }
    }
    if ([System.IO.File]::ReadAllText((Join-Path $firstBackupDir "GEMINI.md"), $strictUtf8) -cne $priorGemini -or
        [System.IO.File]::ReadAllText((Join-Path $firstBackupDir "guidance\engineering-workflow.md"), $strictUtf8) -cne $priorEngineering -or
        [System.IO.File]::ReadAllText((Join-Path $firstBackupDir "antigravity\skills\tools-reference\SKILL.md"), $strictUtf8) -cne $priorSkill) {
        throw "Backup contents do not match prior managed files"
    }

    # 4c. Install catgirl profile into same isolated home (without -LocalCarePath)
    & $installScript -Profile "catgirl" -GeminiHome $fakeGeminiHome -TargetUserProfile $longUserProfile -RulesParentRoot $toolkitRoot | Out-Null
    $catgirlInstalledMap = Assert-BuiltProfileBundle -Root $fakeGeminiHome -Profile "catgirl"
    Assert-Contains $catgirlInstalledMap["GEMINI.md"] $longUserName "catgirl isolated install 20-char profile"
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $privateCareContent) {
        throw "Catgirl install modified or removed existing personal-care.local.md"
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) {
        throw "Catgirl install modified or removed existing account-status.local.md"
    }
    $backupDirsAfterCatgirl = @(Get-ChildItem -LiteralPath (Join-Path $fakeGeminiHome "backups") -Directory | Sort-Object Name)
    if ($backupDirsAfterCatgirl.Count -ne 2) {
        throw "Expected 2 backup directories after catgirl install, found $($backupDirsAfterCatgirl.Count)"
    }
    $secondManifest = (Assert-FileFormatAndBudget -Path (Join-Path $backupDirsAfterCatgirl[1].FullName "manifest.json") -Context "Second backup manifest.json" -SkipSizeLimit) | ConvertFrom-Json
    if ($secondManifest.fileCount -ne 7 -or @($secondManifest.files).Count -ne 7) {
        throw "Expected 7 backed-up managed files in second manifest, got $($secondManifest.fileCount)"
    }

    # 4d. Install with explicit private -LocalCarePath updates personal-care.local.md, backs up prior version, keeps account-status.local.md
    $customCareSource = Join-Path $testRoot "custom-personal-care.md"
    $customCareContent = "# Custom Private Care`ncustom-care-installed-marker`n"
    [System.IO.File]::WriteAllText($customCareSource, $customCareContent, $utf8NoBom)
    & $installScript -Profile "catgirl" -GeminiHome $fakeGeminiHome -LocalCarePath $customCareSource -TargetUserProfile $stdUserProfile -RulesParentRoot $toolkitRoot | Out-Null
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "personal-care.local.md"), $strictUtf8) -cne $customCareContent) {
        throw "Explicit -LocalCarePath did not install personal-care.local.md"
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) {
        throw "Explicit -LocalCarePath install unexpectedly altered account-status.local.md"
    }
    $backupDirsAfterCare = @(Get-ChildItem -LiteralPath (Join-Path $fakeGeminiHome "backups") -Directory | Sort-Object Name)
    if ($backupDirsAfterCare.Count -ne 3) {
        throw "Expected 3 backup directories after LocalCarePath install, found $($backupDirsAfterCare.Count)"
    }
    $thirdBackupCarePath = Join-Path $backupDirsAfterCare[2].FullName "guidance\personal-care.local.md"
    if (-not (Test-Path -LiteralPath $thirdBackupCarePath -PathType Leaf) -or
        [System.IO.File]::ReadAllText($thirdBackupCarePath, $strictUtf8) -cne $privateCareContent) {
        throw "Explicit -LocalCarePath install did not back up previous personal-care.local.md"
    }

    # 4e. Rollback restoration verification: restoring from first backup manifest restores exact prior files while preserving private .local.md
    foreach ($cFile in @($firstManifest.createdFiles)) {
        if (Test-Path -LiteralPath $cFile -PathType Leaf) { Remove-Item -LiteralPath $cFile -Force }
        if (Test-Path -LiteralPath $cFile) { throw "Rollback left created file behind: $cFile" }
    }
    foreach ($entry in @($firstManifest.files)) {
        Copy-Item -LiteralPath $entry.backupPath -Destination $entry.originalPath -Force
        $restoredHash = (Get-FileHash -LiteralPath $entry.originalPath -Algorithm SHA256).Hash
        if ($restoredHash -ne $entry.sha256) {
            throw "Rollback restoration SHA256 mismatch for $($entry.relativePath)"
        }
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGeminiHome "GEMINI.md"), $strictUtf8) -cne $priorGemini -or
        [System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "engineering-workflow.md"), $strictUtf8) -cne $priorEngineering -or
        [System.IO.File]::ReadAllText((Join-Path $fakeSkillDir "SKILL.md"), $strictUtf8) -cne $priorSkill) {
        throw "Rollback restoration did not restore prior managed content verbatim"
    }
    if ([System.IO.File]::ReadAllText((Join-Path $fakeGuidanceDir "account-status.local.md"), $strictUtf8) -cne $privateAccountContent) {
        throw "Rollback restoration altered account-status.local.md"
    }

    # Ensure no leftover atomic .tmp.* files remain in isolated GeminiHome
    $leftoverTmp = @(Get-ChildItem -LiteralPath $fakeGeminiHome -Recurse -File -Filter "*.tmp.*")
    if ($leftoverTmp.Count -gt 0) {
        throw "Leftover temporary file(s) found after atomic install: $(($leftoverTmp | ForEach-Object { $_.FullName }) -join ', ')"
    }

    # 5. Strict sanitization scan across rules\antigravity\ and install\*Antigravity*.ps1
    Assert-Sanitization -RulesDirectory $rulesRoot -InstallDirectory $installRoot

    Write-Output "Antigravity Rules profiles passed: catgirl & neutral builds, 20/30-char username stress tests (headroom >= 200 B), GEMINI.template.md drift check, isolated installs, private .local.md protection, SHA256 backups, persona isolation, core specs, and sanitization."
} finally {
    $resolvedRoot = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\', '/')
    $resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolvedRoot)).TrimEnd('\', '/')
    if ($resolvedParent -ne $tempParent -or
        -not ([System.IO.Path]::GetFileName($resolvedRoot) -match '^agy-rules-test-[0-9a-f]{32}$')) {
        throw "Refusing to remove a test directory outside its exclusive Temp root: $resolvedRoot"
    }
    if (Test-Path -LiteralPath $resolvedRoot) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
