# Grok proxy connectivity test
$proxyUrl = if ($env:MEMORY_STORE_GROK_PROXY_URL) { $env:MEMORY_STORE_GROK_PROXY_URL } else { 'http://127.0.0.1:18645' }
$apiKey = if ($env:MEMORY_STORE_GROK_API_KEY) { $env:MEMORY_STORE_GROK_API_KEY } else { 'grok-local-proxy' }
$model = if ($env:MEMORY_STORE_GROK_CHECK_MODEL) { $env:MEMORY_STORE_GROK_CHECK_MODEL } else { 'grok-4.20-0309-non-reasoning' }

Start-Sleep -Seconds 5

try {
    $body = @{
        model = $model
        messages = @(@{role='user'; content='Say ok'})
        max_tokens = 10
    } | ConvertTo-Json -Depth 3

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-RestMethod -Uri "$proxyUrl/v1/chat/completions" -Method Post -Headers @{Authorization="Bearer $apiKey"} -ContentType 'application/json' -Body $body -TimeoutSec 30
    $sw.Stop()

    Write-Host "SUCCESS: $($r.choices[0].message.content) in $($sw.ElapsedMilliseconds)ms"
    Write-Host "Tokens: $($r.usage.completion_tokens)"
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if ($_.ErrorDetails) { Write-Host $_.ErrorDetails.Message }
    exit 1
}
