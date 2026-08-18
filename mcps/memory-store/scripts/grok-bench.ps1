# Grok model benchmark for memory-store
# 6 models x 2 prompts x 3 runs = 36 API calls
# Optional env:
#   MEMORY_STORE_GROK_PROXY_URL    (default: http://127.0.0.1:18645)
#   MEMORY_STORE_GROK_API_KEY      (default: grok-local-proxy)
#   MEMORY_STORE_GROK_BENCH_MODELS (comma-separated model list)

$proxyUrl = if ($env:MEMORY_STORE_GROK_PROXY_URL) { $env:MEMORY_STORE_GROK_PROXY_URL } else { 'http://127.0.0.1:18645' }
$apiKey = if ($env:MEMORY_STORE_GROK_API_KEY) { $env:MEMORY_STORE_GROK_API_KEY } else { 'grok-local-proxy' }

Write-Host "Waiting 15s for progrok to stabilize..."
Start-Sleep -Seconds 15

function Get-EnvList {
    param([string]$Value, [string[]]$Default)
    if (-not $Value) { return $Default }
    $items = $Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($items.Count -eq 0) { return $Default }
    return $items
}

$defaultModels = @(
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-0309-reasoning',
    'grok-4.20-multi-agent-0309',
    'grok-4.3',
    'grok-4.5',
    'grok-build-0.1'
)

$models = Get-EnvList $env:MEMORY_STORE_GROK_BENCH_MODELS $defaultModels

$lightPrompt = 'MCP memory-store v1.18.0 Grok 模型链路集成。auto 模型路由优先探测本机 progrok proxy，失败后 fallback 到 Antigravity LS、Codex 模型桥或允许的 Claude Code CLI。Record、Stage Guard 和 smart search 会按任务选择不同 Grok 模型，并保留实际模型链路证据。请为以上内容生成50-100字搜索优化摘要含关键词，直接输出不要前缀。'

$heavyPrompt = '你是对话记录生成器。生成结构化过程日志Markdown，包含阶段标题用户操作AI行动决策产出验证风险。对话摘要：用户为 MCP memory-store 集成 Grok/progrok 模型链路，实现 chain=grok 模型快捷写法、Grok HTTP client、auto fallback、Record 大上下文预算、checkpoint/cache 隔离、schema/README 更新，并通过单元测试和真实 MCP smoke。只输出Markdown。'

function Call-Grok {
    param([string]$Model, [string]$Prompt, [int]$TimeoutSec = 60)
    $bodyObj = @{
        model = $Model
        messages = @(@{role='user'; content=$Prompt})
        temperature = 0.3
        max_tokens = 800
    }
    $body = $bodyObj | ConvertTo-Json -Depth 3

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod -Uri "$proxyUrl/v1/chat/completions" -Method Post -Headers @{Authorization="Bearer $apiKey"} -ContentType 'application/json' -Body $body -TimeoutSec $TimeoutSec
        $sw.Stop()
        return @{ Ok = $true; Elapsed = $sw.ElapsedMilliseconds; Content = $r.choices[0].message.content; Tokens = $r.usage.completion_tokens; Error = '' }
    } catch {
        $sw.Stop()
        $errMsg = $_.Exception.Message
        if ($_.ErrorDetails) { $errMsg = $_.ErrorDetails.Message }
        return @{ Ok = $false; Elapsed = $sw.ElapsedMilliseconds; Content = ''; Tokens = 0; Error = $errMsg }
    }
}

# Connectivity check
Write-Host "`n=== Connectivity check ==="
$checkModel = $models[0]
$check = Call-Grok -Model $checkModel -Prompt 'Say ok' -TimeoutSec 30
if ($check.Ok) {
    Write-Host "Proxy OK! Response: $($check.Content) in $($check.Elapsed)ms`n"
} else {
    Write-Host "Proxy NOT ready: $($check.Error)"
    Write-Host "Waiting 20 more seconds..."
    Start-Sleep -Seconds 20
    $check2 = Call-Grok -Model $checkModel -Prompt 'Say ok' -TimeoutSec 30
    if ($check2.Ok) {
        Write-Host "Proxy recovered! $($check2.Content) in $($check2.Elapsed)ms`n"
    } else {
        Write-Host "Proxy still down: $($check2.Error)"
        exit 1
    }
}

# Light prompt
Write-Host "=== Prompt 1: autoSummary (6 models x 3 runs) ===`n"
$lightResults = @()
foreach ($model in $models) {
    $lats = @()
    $okCount = 0
    $sample = ''
    $tok = 0
    for ($i = 0; $i -lt 3; $i++) {
        $r = Call-Grok -Model $model -Prompt $lightPrompt -TimeoutSec 45
        $lats += $r.Elapsed
        if ($r.Ok) { $okCount++; if (-not $sample) { $sample = $r.Content; $tok = $r.Tokens } }
    }
    $sorted = $lats | Sort-Object
    $med = $sorted[1]
    $st = if ($okCount -eq 3) { 'OK' } elseif ($okCount -gt 0) { 'PART' } else { 'FAIL' }
    Write-Host ("{0,-35} med={1,6}ms ok={2}/3 tok={3} len={4} [{5}]" -f $model, $med, $okCount, $tok, $sample.Length, $st)
    $lightResults += @{ Model=$model; Median=$med; Ok=$okCount; Tokens=$tok; Content=$sample; Error=$(if($okCount -eq 0){'all failed'}else{''}) }
}

# Heavy prompt
Write-Host "`n=== Prompt 2: Record gen (6 models x 3 runs) ===`n"
$heavyResults = @()
foreach ($model in $models) {
    $lats = @()
    $okCount = 0
    $sample = ''
    $tok = 0
    for ($i = 0; $i -lt 3; $i++) {
        $r = Call-Grok -Model $model -Prompt $heavyPrompt -TimeoutSec 90
        $lats += $r.Elapsed
        if ($r.Ok) { $okCount++; if (-not $sample) { $sample = $r.Content; $tok = $r.Tokens } }
    }
    $sorted = $lats | Sort-Object
    $med = $sorted[1]
    $st = if ($okCount -eq 3) { 'OK' } elseif ($okCount -gt 0) { 'PART' } else { 'FAIL' }
    Write-Host ("{0,-35} med={1,6}ms ok={2}/3 tok={3} len={4} [{5}]" -f $model, $med, $okCount, $tok, $sample.Length, $st)
    $heavyResults += @{ Model=$model; Median=$med; Ok=$okCount; Tokens=$tok; Content=$sample; Error=$(if($okCount -eq 0){'all failed'}else{''}) }
}

# Summary
Write-Host "`n=== SUMMARY (sorted by light median) ===`n"
Write-Host ("{0,-35} {1,15} {2,15} {3,10}" -f 'Model', 'Light', 'Heavy', 'Stability')
Write-Host ("{0,-35} {1,15} {2,15} {3,10}" -f ('-'*35), ('-'*15), ('-'*15), ('-'*10))
$allSorted = $lightResults | Sort-Object { $_.Median }
foreach ($r in $allSorted) {
    $h = $heavyResults | Where-Object { $_.Model -eq $r.Model } | Select-Object -First 1
    $lStr = "$($r.Median)ms ($($r.Ok)/3)"
    $hStr = if ($h) { "$($h.Median)ms ($($h.Ok)/3)" } else { 'N/A' }
    $stable = if ($r.Ok -eq 3 -and $h.Ok -eq 3) { 'STABLE' } elseif ($r.Ok -gt 0 -or $h.Ok -gt 0) { 'PARTIAL' } else { 'FAILED' }
    Write-Host ("{0,-35} {1,15} {2,15} {3,10}" -f $r.Model, $lStr, $hStr, $stable)
}

# Quality - Light
Write-Host "`n=== QUALITY: autoSummary ===`n"
foreach ($r in $lightResults) {
    Write-Host "--- $($r.Model) ($($r.Median)ms, $($r.Tokens)tok) ---"
    if ($r.Content) { Write-Host $r.Content.Substring(0, [Math]::Min(400, $r.Content.Length)) }
    else { Write-Host "FAILED: $($r.Error)" }
    Write-Host ""
}

# Quality - Heavy
Write-Host "=== QUALITY: Record gen (first 500 chars) ===`n"
foreach ($r in $heavyResults) {
    Write-Host "--- $($r.Model) ($($r.Median)ms, $($r.Tokens)tok) ---"
    if ($r.Content) { Write-Host $r.Content.Substring(0, [Math]::Min(500, $r.Content.Length)) }
    else { Write-Host "FAILED: $($r.Error)" }
    Write-Host ""
}
