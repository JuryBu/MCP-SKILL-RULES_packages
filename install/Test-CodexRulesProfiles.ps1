$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$buildScript = Join-Path $toolkitRoot "install\Build-CodexRulesProfile.ps1"
$installScript = Join-Path $toolkitRoot "install\Install-CodexRulesProfile.ps1"
$profileIds = @("neutral", "catgirl", "development", "training")
$commonGuidance = @(
    "engineering-workflow.md", "maintenance-upgrades.md", "design-writing.md",
    "communication-bridges.md", "web-visual.md"
)
$guidanceBoundaries = @{
    "engineering-workflow.md" = "Astra xhigh"
    "maintenance-upgrades.md" = "Git"
    "design-writing.md" = "PPT"
    "communication-bridges.md" = "ACK"
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
    $engineeringText = Get-Content -LiteralPath (Join-Path $Root "guidance\engineering-workflow.md") -Raw -Encoding UTF8
    $bridgeText = Get-Content -LiteralPath (Join-Path $Root "guidance\communication-bridges.md") -Raw -Encoding UTF8
    foreach ($modelRow in @('`gpt-6-luna` | `max`', '`gpt-6.1-sol` | `xhigh`', '`gpt-6.1-sol` | `max`', '`gpt-6-astra` | `xhigh`')) {
        Assert-Contains $agentsText $modelRow "$Profile model policy"
    }
    foreach ($encodedRow in @(
        'fCDpnIDopoHnkIbop6Plj5boiI3nmoTosIPmn6XjgIHkuIDoiKzlrp7njrDkuI7mnZDmlpnliLbkvZwgfCBgZ3B0LTYuMS1zb2xgIHwgYHhoaWdoYCB8',
        'fCDlpI3mnYLlrp7njrDjgIHnoJTnqbbliIbmnpDjgIHku6PnoIHlrqHmn6XjgIHlt6XnqIvop4TliJLkuI7op4bop4npqozmlLYgfCBgZ3B0LTYuMS1zb2xgIHwgYG1heGAgfA=='
    )) {
        Assert-Contains $agentsText ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedRow))) "$Profile task-to-effort binding"
    }
    if ($agentsText.Contains('`gpt-6-sol`')) { throw "$Profile retains the previous Sol default" }
    Assert-Contains $engineeringText 'GPT-6.1 Sol max' "$Profile routine independent reviews"
    Assert-Contains $engineeringText 'Astra xhigh' "$Profile key-point independent reviews"
    foreach ($boundary in @(
        '6aaW5qyh56Gu5a6a5aSn5pa55ZCR',
        '6YeN5aSn6Lev57q/6LCD5pW0',
        '5Y+N5aSN56Kw5aOB',
        '6buY6K6k5pyA5aSa6L+e57utIDMg6L2u5L2/55SoIFNvbA==',
        '5LiL5LiA6L2u5Lik6aG55Z2H55SoIEFzdHJhIHhoaWdoIOeLrOeri+WkjeaguA==',
        '5YWz6ZSu5LiN5Y+v6YCG5Yaz562W5YmN',
        '5bey6IO96K+G5Yir6aOO6Zmp5pe256uL5Y2z6Kem5Y+R77yM5LiN562J5bi46KeE6L2u5qyh55So5ruh',
        '5Lit5pat5oGi5aSN5oiW5pu05o2i5omn6KGM57q/56iL5LiN6YeN572u6K6h5pWw',
        '5Lik6aG55a6h5p+l5YiG5Yir5aeU5omY44CB5L2/55So54us56uL5LiK5LiL5paH'
    )) {
        Assert-Contains $engineeringText ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($boundary))) "$Profile review cadence and escalation"
    }
    Assert-Contains $engineeringText "automation_update" "$Profile persistent continuation tool"
    Assert-Contains $engineeringText "10$([char]0xff5e)30" "$Profile recurring continuation interval"
    Assert-Contains $engineeringText ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5Li757q/5a6M5oiQ5YmN5L+d5oyB5pyJ5pWI"))) "$Profile continuation lifetime"
    Assert-Contains $agentsText ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5LiN6IO95Zug5pS25Yiw5LiA5Liq5Zue5YyF"))) "$Profile reply does not end mainline"
    Assert-Contains $bridgeText ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5pS25Yiw5Zue5YyF5ZCO5pu05paw5qOA5p+l54K5"))) "$Profile bridge updates mainline checkpoint"
    foreach ($marker in @("stage_guard", "sandbox_council")) {
        Assert-Contains $agentsText $marker "$Profile core boundary"
    }
    $promptText = Get-Content -LiteralPath (Join-Path $Root "prompts\system-prompt.md") -Raw -Encoding UTF8
    foreach ($marker in @('2026-10-04.2', 'model_instructions_file', 'system-prompt.md')) {
        Assert-Contains $agentsText $marker "$Profile paired baseline entry"
    }
    Assert-Contains $promptText '2026-10-04.2' "$Profile common baseline"
    foreach ($expressionMarker in @(
        ([regex]::Unescape('K \u57285\uff5e15\u4e4b\u95f4\uff0c\u9ed8\u8ba410')),
        ([regex]::Unescape('\u7ef4\u62a4\u6709\u4e24\u4e2a\u660e\u786e\u65f6\u70b9')),
        ([regex]::Unescape('\u51c6\u5907\u5b8c\u6574\u5de5\u7a0b\u89e3\u91ca\u6216\u6c47\u62a5\u65f6')),
        ([regex]::Unescape('\u96c6\u4e2d\u56de\u6eaf\u5e76\u8865\u9f50\u6700\u8fd1K\u6b21')),
        ([regex]::Unescape('\u65e5\u5e38\u804a\u5929\u548c\u8fde\u7eed\u8ba8\u8bba\u4e0d\u9010\u8f6e\u89e6\u53d1\u8fd1\u51b5\u6587\u4ef6\u7ef4\u62a4')),
        ([regex]::Unescape('\u5230\u5b9e\u9645\u5f00\u5de5\u65f6\u7ed3\u675f')),
        ([regex]::Unescape('\u672c\u6b21\u56de\u590d\u8349\u7a3f')),
        ([regex]::Unescape('\u6807\u660e\u5c1a\u672a\u53d1\u9001')),
        ([regex]::Unescape('\u6bcf\u6bb5\u627f\u62c5\u7684\u4fe1\u606f')),
        ([regex]::Unescape('\u6392\u5e8f\u7406\u7531')),
        ([regex]::Unescape('\u8868\u8fbe\u5ba1\u7a3f\u5931\u8bef')),
        ([regex]::Unescape('\u7981\u6b62\u4efb\u4f55\u9632\u5fa1\u6027\u8868\u8ff0')),
        ([regex]::Unescape('\u80af\u5b9a\u53e5\u5305\u88c5')),
        ([regex]::Unescape('\u6bb5\u9996\u3001\u6bb5\u4e2d')),
        ([regex]::Unescape('\u4e25\u8c28\u3001\u8c28\u614e\u3001\u62c5\u5fc3\u8bef\u89e3\u5747\u4e0d\u5f97')),
        ([regex]::Unescape('\u7528\u6237\u7279\u522b\u751f\u6c14'))
    )) {
        Assert-Contains $promptText $expressionMarker "$Profile expression contract"
    }
    foreach ($visualMarker in @(
        ([regex]::Unescape('\u7528\u5408\u9002\u7684\u5f62\u5f0f\u5e2e\u52a9\u7406\u89e3')),
        ([regex]::Unescape('\u4e3b\u52a8\u4f7f\u7528\u6709\u52a9\u4e8e\u7406\u89e3\u7684\u8868\u8fbe\u5f62\u5f0f')),
        ([regex]::Unescape('\u7b80\u5355\u95ee\u9898\u4fdd\u6301\u8f7b\u91cf')),
        ([regex]::Unescape('\u6bcf\u5f20\u56fe\u96c6\u4e2d\u56de\u7b54\u4e00\u4e2a\u5b8c\u6574\u95ee\u9898')),
        ([regex]::Unescape('\u7ec6\u8282\u8fc7\u5bc6\u65f6\u7ee7\u7eed\u62c6\u56fe')),
        ([regex]::Unescape('\u5bf9\u5e94\u7684\u6570\u636e\u548c\u89e3\u91ca\u653e\u5728\u76f8\u5173\u56fe\u65c1')),
        ([regex]::Unescape('\u540e\u7eed\u8ba8\u8bba\u6cbf\u7528\u5df2\u7ecf\u5efa\u7acb\u7684\u540d\u79f0\u4e0e\u5173\u7cfb')),
        ([regex]::Unescape('\u53ef\u4f7f\u7528\u751f\u6210\u56fe\u6a21\u578b')),
        ([regex]::Unescape('\u80fd\u51c6\u786e\u6838\u5bf9\u8fd9\u4e9b\u5185\u5bb9\u7684\u56fe\u8868\u6216\u7ed8\u56fe\u5de5\u5177')),
        ([regex]::Unescape('\u56fe\u793a\u662f\u5426\u6df7\u5408\u591a\u4e2a\u95ee\u9898'))
    )) {
        Assert-Contains $promptText $visualMarker "$Profile visual explanation contract"
    }
    foreach ($triggerMarker in @(
        ([regex]::Unescape('\u4e13\u9898\u9605\u8bfb\u5165\u53e3')),
        ([regex]::Unescape('\u56de\u590d\u524d\u6821\u51c6')),
        ([regex]::Unescape('\u76f4\u63a5\u5e94\u7528\u672c\u6587\u4ef6')),
        ([regex]::Unescape('Sandbox\u7684\u4f18\u5148\u6267\u884c\u3001\u8d44\u6e90\u63a5\u7eb3')),
        ([regex]::Unescape('\u672c\u8f6e\u4e3b\u52a8\u67e5\u8be2\u76f8\u5173\u8bb0\u5fc6')),
        ([regex]::Unescape('\u5728\u672c\u8f6e\u4ea4\u56de'))
    )) {
        Assert-Contains $agentsText $triggerMarker "$Profile reading and conversation-memory contract"
    }
    foreach ($runtimeMarker in @("admission_timeout", "execution_timeout", "caller_deadline_exceeded", "broker_backend_timeout", "commandStarted=false", "mayHaveStarted", "memoryRequestMB", "maxMemoryMB", "retryAfterMs", "sandbox://guide", "background_task_status", "background_task_cancel", "waitSeconds=45")) {
        Assert-Contains $agentsText $runtimeMarker "$Profile embedded Sandbox contract"
    }
    if ($agentsText.Contains("conversation-tone.md") -or $agentsText.Contains("sandbox-runtime.md")) { throw "$Profile retains mandatory high-frequency guidance file references" }
    $annotationBoundary = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("5om55rOo"))
    Assert-Contains $promptText $annotationBoundary "$Profile annotation handling in common prompt"
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
    $loginWallMarker = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("55m75b2V5aKZ"))
    $loginTriggerLines = @($agentsText -split "`r?`n" | Where-Object {
        $_.Contains($loginWallMarker) -and $_.Contains($mustRead) -and
        $_.Contains("web-visual.md") -and $_.Contains("web-fetcher")
    })
    if ($loginTriggerLines.Count -eq 0) { throw "$Profile lacks login-wall routing before tool selection" }
    $webGuidanceText = Get-Content -LiteralPath (Join-Path $Root "guidance\web-visual.md") -Raw -Encoding UTF8
    foreach ($encodedBoundary in @("55m75b2V5aKZ", "6K6k6K+B5aSx5pWI", "6K6/6Zeu6ZmQ5Yi2", "5LuY6LS55aKZ", "5LiN5b6X57uV6L+H")) {
        $boundary = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedBoundary))
        Assert-Contains $webGuidanceText $boundary "$Profile login-state and access-control boundary"
    }
    Assert-Contains $agentsText "sandbox_codex" "$Profile sandbox prohibition"
    if ($agentsText -notmatch '(?is)Git.{0,500}maintenance-upgrades\.md|maintenance-upgrades\.md.{0,500}Git') {
        throw "$Profile core does not route the general Git source rule to maintenance-upgrades.md"
    }
    $ownerWord = [regex]::Unescape('\u4e3b\u4eba')
    $catgirlWord = [regex]::Unescape('\u732b\u5a18')
    $facesWord = [regex]::Unescape('\u989c\u6587\u5b57')
    if ($Profile -eq "neutral") {
        if ($agentsText.Contains($catgirlWord) -or $agentsText.Contains($ownerWord)) { throw "Neutral profile contains catgirl instructions or audience" }
    } elseif (-not $agentsText.Contains($catgirlWord) -or -not $agentsText.Contains($facesWord) -or -not $agentsText.Contains($ownerWord)) {
        throw "$Profile is missing catgirl persona, audience or expression density"
    }
    $audienceWord = if ($Profile -eq "neutral") { [regex]::Unescape('\u7528\u6237') } else { $ownerWord }
    $toneText = $agentsText
    Assert-Contains $toneText ($audienceWord + ([regex]::Unescape('\u8865\u5145\u4fe1\u606f\u540e\uff0c\u76f8\u5e94\u6539\u53d8\u8ba8\u8bba\u65b9\u5411'))) "$Profile embedded calibration audience"
    Assert-Contains $agentsText ([regex]::Unescape('\u957f\u671f\u5de5\u7a0b\u5f00\u5de5\u3001\u63a5\u624b\u6216\u6062\u590d')) "$Profile sustained engineering entry"
    if ($Profile -ne "neutral") {
        foreach ($densityMarker in @(
            '\u989c\u6587\u5b57\u6bcf\u6b21\u56de\u590d\u90fd\u5e94\u6709',
            '\u666e\u901a\u81ea\u7136\u6bb52\uff5e3\u4e2a\u4f5c\u4e3a\u6d53\u5ea6\u53c2\u7167',
            '\u77ed\u53e5\u611f\u53f9\u548c\u53e3\u8bed\u8fde\u63a5\u8bcd',
            '\u6280\u672f\u8ba8\u8bba\u50cf\u8ddf\u540c\u4e8b\u804a'
        )) { Assert-Contains $agentsText ([regex]::Unescape($densityMarker)) "$Profile catgirl expression contract" }
    }
    if ($promptText.Contains($ownerWord) -or $promptText.Contains($catgirlWord)) { throw "$Profile prompt contains profile-specific persona" }
    foreach ($publicGuide in @(Get-ChildItem -LiteralPath (Join-Path $Root "guidance") -File -Filter "*.md" | Where-Object { $_.Name -ne "private-note.md" })) {
        $guideContent = Get-Content -LiteralPath $publicGuide.FullName -Raw -Encoding UTF8
        if ($Profile -eq "neutral" -and $guideContent.Contains($ownerWord)) { throw "Neutral guidance has catgirl audience: $($publicGuide.Name)" }
        if ($Profile -ne "neutral" -and $guideContent.Contains([regex]::Unescape('\u666e\u901a\u4e3b\u4eba'))) { throw "$Profile guidance has malformed generic audience: $($publicGuide.Name)" }
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
        foreach ($publicFile in @(Get-Item -LiteralPath (Join-Path $outputRoot 'AGENTS.md')) + @(Get-ChildItem -LiteralPath (Join-Path $outputRoot 'guidance') -File -Filter '*.md')) {
            $publicText = Get-Content -LiteralPath $publicFile.FullName -Raw -Encoding UTF8
            if ($publicText -match 'writing-examples[\\/]index\.md|conversation-tone\.local\.md') {
                throw "$profileId public rules contain a private calibration entry: $($publicFile.Name)"
            }
        }
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
    Set-Content -LiteralPath $overridePath -Value ("private override test marker`n" + [regex]::Unescape('private original \u7528\u6237 text') + "`nOptional reference: guidance/writing-examples/index.md") -Encoding UTF8
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
    $privateExamplesRoot = Join-Path $guidanceRoot 'writing-examples'
    New-Item -ItemType Directory -Path $privateExamplesRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $privateExamplesRoot 'index.md') -Value 'receiver-private example marker' -Encoding UTF8
    Set-Content -LiteralPath $promptPath -Value $existingPrompt -NoNewline -Encoding UTF8
    $existingConfig = "[mcp_servers.private]`nurl = 'http://127.0.0.1:19999/mcp'`n"
    Set-Content -LiteralPath $configPath -Value $existingConfig -NoNewline -Encoding UTF8

    $refused = $false
    try { & $installScript -Profile "neutral" -CodexHome $fakeCodexHome | Out-Null }
    catch {
        if (-not $_.Exception.Message.Contains('requires common baseline')) { throw }
        $refused = $true
    }
    if (-not $refused) { throw "Incomplete baseline installation was not refused" }
    foreach ($entry in @(@($agentsPath, $existingAgents), @($configPath, $existingConfig), @($promptPath, $existingPrompt))) {
        if ((Get-Content -LiteralPath $entry[0] -Raw -Encoding UTF8) -ne $entry[1]) {
            throw "Refused installation changed a target: $($entry[0])"
        }
    }
    $bundledPrompt = Get-Content -LiteralPath (Join-Path $buildRoot "neutral\prompts\system-prompt.md") -Raw -Encoding UTF8
    foreach ($case in @(
        @{ Name = 'old-version'; Config = ('model_instructions_file = "~/.codex/prompts/system-prompt.md"' + "`n" + $existingConfig); Prompt = $existingPrompt },
        @{ Name = 'custom-pointer'; Config = ('model_instructions_file = "D:/private/custom-prompt.md"' + "`n" + $existingConfig); Prompt = $bundledPrompt },
        @{ Name = 'missing-prompt'; Config = ('model_instructions_file = "~/.codex/prompts/system-prompt.md"' + "`n" + $existingConfig); Prompt = $null },
        @{ Name = 'marker-only'; Config = ('model_instructions_file = "~/.codex/prompts/system-prompt.md"' + "`n" + $existingConfig); Prompt = (($bundledPrompt -split "`r?`n" | Where-Object { $_.Contains('2026-10-04.2') }) -join "`n") }
    )) {
        Set-Content -LiteralPath $configPath -Value $case.Config -NoNewline -Encoding UTF8
        if ($null -eq $case.Prompt) { Remove-Item -LiteralPath $promptPath -Force }
        else { Set-Content -LiteralPath $promptPath -Value $case.Prompt -NoNewline -Encoding UTF8 }
        $beforeHashes = @{}
        foreach ($target in @($agentsPath, $configPath, $promptPath, (Join-Path $guidanceRoot 'engineering-workflow.md'))) {
            $beforeHashes[$target] = if (Test-Path -LiteralPath $target) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash } else { 'absent' }
        }
        $refused = $false
        try { & $installScript -Profile 'neutral' -CodexHome $fakeCodexHome | Out-Null }
        catch {
            if (-not $_.Exception.Message.Contains('requires common baseline')) { throw }
            $refused = $true
        }
        if (-not $refused) { throw "Unsafe baseline accepted: $($case.Name)" }
        foreach ($target in $beforeHashes.Keys) {
            $afterHash = if (Test-Path -LiteralPath $target) { (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash } else { 'absent' }
            if ($afterHash -ne $beforeHashes[$target]) { throw "Refusal changed $target in $($case.Name)" }
        }
    }
    Set-Content -LiteralPath $configPath -Value $existingConfig -NoNewline -Encoding UTF8
    Set-Content -LiteralPath $promptPath -Value $existingPrompt -NoNewline -Encoding UTF8
    & $installScript -Profile "neutral" -CodexHome $fakeCodexHome -InstallSystemPrompt | Out-Null
    $null = Assert-Guidance $fakeCodexHome "neutral"
    $neutralConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    Assert-Contains $neutralConfig "[mcp_servers.private]" "existing config"
    if ($neutralConfig -notmatch '(?m)^project_doc_max_bytes\s*=\s*65536\s*$') {
        throw "Neutral install did not set the minimum project document limit"
    }
    Assert-Contains $neutralConfig 'model_instructions_file = "~/.codex/prompts/system-prompt.md"' "paired baseline config"
    Assert-Backup "prompts\system-prompt.md" $existingPrompt
    Assert-Backup "AGENTS.md" $existingAgents
    Assert-Backup "guidance\engineering-workflow.md" $existingGuidance
    Assert-Backup "config.toml" $existingConfig

    Set-Content -LiteralPath $configPath -Value "project_doc_max_bytes = 131_072`n$existingConfig" -NoNewline -Encoding UTF8
    & $installScript -Profile "development" -LocalOverridePath $overridePath -CodexHome $fakeCodexHome -InstallSystemPrompt -InstallRecommendedDesktopFeatures | Out-Null
    $installedAgents = Assert-Guidance $fakeCodexHome "development"
    Assert-Contains $installedAgents "private override test marker" "LocalOverridePath"
    Assert-Contains $installedAgents ([regex]::Unescape('private original \u7528\u6237 text')) "private override original audience"
    Assert-Contains $installedAgents 'guidance/writing-examples/index.md' 'private example entry'
    Assert-Contains (Get-Content -LiteralPath (Join-Path $privateExamplesRoot 'index.md') -Raw -Encoding UTF8) 'receiver-private example marker' 'private example preservation'
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
    Write-Output "Codex Rules profiles passed: four builds, four installs, paired baseline refusal, guidance, isolation, overrides, config, and backups."
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
