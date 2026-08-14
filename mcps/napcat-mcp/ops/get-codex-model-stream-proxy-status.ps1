[CmdletBinding()]
param([string]$DataRoot = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }
$RuntimePath = Join-Path $DataRoot "state\codex-model-stream-proxy-runtime.json"
if (-not (Test-Path -LiteralPath $RuntimePath)) {
  [pscustomobject]@{ running = $false; healthy = $false; reason = "runtime_state_missing" } | ConvertTo-Json
  return
}
$Runtime = Get-Content -LiteralPath $RuntimePath -Encoding UTF8 -Raw | ConvertFrom-Json
$Process = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
$Health = $null
if ($null -ne $Process) {
  try { $Health = Invoke-RestMethod -Uri ("{0}/health" -f [string]$Runtime.endpoint) -TimeoutSec 2 } catch {}
}
[pscustomobject]@{
  running = $null -ne $Process
  healthy = $null -ne $Health -and $Health.ok -eq $true
  pid = [int]$Runtime.pid
  endpoint = [string]$Runtime.endpoint
  livenessAt = [string]$Runtime.livenessAt
  activeRequests = $Runtime.activeRequests
  counters = $Runtime.counters
  processPath = if ($null -ne $Process) { $Process.Path } else { $null }
} | ConvertTo-Json -Depth 8
