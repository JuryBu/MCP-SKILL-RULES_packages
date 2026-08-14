[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [ValidateRange(1, 30)][int]$TimeoutSeconds = 10,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }
$StateRoot = Join-Path $DataRoot "state"
$RuntimePath = Join-Path $StateRoot "codex-model-stream-proxy-runtime.json"
$StopPath = Join-Path $StateRoot "codex-model-stream-proxy.stop"
if (-not (Test-Path -LiteralPath $RuntimePath)) {
  [pscustomobject]@{ changed = $false; running = $false; stopped = $true; clean = $true; reason = "runtime_state_missing" } | ConvertTo-Json
  return
}
$Runtime = Get-Content -LiteralPath $RuntimePath -Encoding UTF8 -Raw | ConvertFrom-Json
$Process = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
if ($null -eq $Process) {
  [pscustomobject]@{ changed = $false; running = $false; stopped = $true; clean = $true; reason = "process_not_running" } | ConvertTo-Json
  return
}
Set-Content -LiteralPath $StopPath -Encoding UTF8 -Value ([datetime]::UtcNow.ToString("o"))
$Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $Deadline -and $null -ne (Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 200
}
$Remaining = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
if ($null -ne $Remaining -and $Force) {
  Stop-Process -Id ([int]$Runtime.pid) -Force
  $Remaining = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
}
if ($null -ne $Remaining) { throw "Model stream proxy did not stop within $TimeoutSeconds seconds." }
if (Test-Path -LiteralPath $StopPath) { Remove-Item -LiteralPath $StopPath -Force }
[pscustomobject]@{ changed = $true; running = $false; stopped = $true; clean = $true; pid = [int]$Runtime.pid } | ConvertTo-Json
