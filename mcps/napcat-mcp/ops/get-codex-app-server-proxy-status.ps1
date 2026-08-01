[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" })
)

$ErrorActionPreference = "Stop"
$RuntimeStatePath = Join-Path $DataRoot "state\codex-app-server-proxy-runtime.json"
$TokenFilePath = Join-Path $DataRoot "state\codex-app-server-proxy-token.txt"
if (-not (Test-Path -LiteralPath $RuntimeStatePath)) {
  [pscustomobject]@{ ok = $false; state = "missing"; runtimeStatePath = $RuntimeStatePath } | ConvertTo-Json -Depth 8
  return
}
$RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Process = Get-Process -Id ([int]$RuntimeState.pid) -ErrorAction SilentlyContinue
$Control = $null
$ControlError = $null
if ($null -ne $Process -and (Test-Path -LiteralPath $TokenFilePath)) {
  try {
    $Token = (Get-Content -LiteralPath $TokenFilePath -Raw -Encoding UTF8).Trim()
    $Control = Invoke-RestMethod -Method Get -Uri ([string]$RuntimeState.controlUrl + "/status") -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
  } catch {
    $ControlError = $_.Exception.Message
  }
}
[pscustomobject]@{
  ok = ($null -ne $Process -and $null -ne $Control)
  processAlive = ($null -ne $Process)
  runtime = $RuntimeState
  control = $Control
  controlError = $ControlError
} | ConvertTo-Json -Depth 16
