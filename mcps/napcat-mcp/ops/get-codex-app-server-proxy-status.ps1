[CmdletBinding()]
param(
  [string]$DataRoot = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$RuntimeStatePath = Join-Path $DataRoot "state\codex-app-server-proxy-runtime.json"
$TokenFilePath = Join-Path $DataRoot "state\codex-app-server-proxy-token.txt"
$LockPath = Join-Path $DataRoot "state\codex-app-server-proxy.lock"
if (-not (Test-Path -LiteralPath $RuntimeStatePath)) {
  [pscustomobject]@{ ok = $false; state = "missing"; runtimeStatePath = $RuntimeStatePath } | ConvertTo-Json -Depth 8
  return
}
$RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Process = Get-Process -Id ([int]$RuntimeState.pid) -ErrorAction SilentlyContinue
$ProcessInfo = if ($null -ne $Process) { Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$RuntimeState.pid)" -ErrorAction SilentlyContinue } else { $null }
$CommandLine = [string]$ProcessInfo.CommandLine
$IdentityMatches = $null -ne $ProcessInfo `
  -and $CommandLine.IndexOf("codex-app-server-proxy-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 `
  -and $CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 `
  -and $CommandLine.IndexOf($LockPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
$LockMatches = $false
if (Test-Path -LiteralPath $LockPath) {
  try {
    $LockState = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $LockMatches = [int]$LockState.pid -eq [int]$RuntimeState.pid `
      -and [string]$LockState.token -eq [string]$RuntimeState.instanceToken `
      -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeState.instanceToken)
  } catch {
    $LockMatches = $false
  }
}
$PortMatches = $false
try {
  $DownstreamPort = ([uri][string]$RuntimeState.downstreamUrl).Port
  $ControlPort = ([uri][string]$RuntimeState.controlUrl).Port
  $DownstreamOwner = Get-NetTCPConnection -State Listen -LocalPort $DownstreamPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @("127.0.0.1", "::1") } | Select-Object -First 1 -ExpandProperty OwningProcess
  $ControlOwner = Get-NetTCPConnection -State Listen -LocalPort $ControlPort -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @("127.0.0.1", "::1") } | Select-Object -First 1 -ExpandProperty OwningProcess
  $PortMatches = [int]$DownstreamOwner -eq [int]$RuntimeState.pid -and [int]$ControlOwner -eq [int]$RuntimeState.pid
} catch {
  $PortMatches = $false
}
$LivenessFresh = $true
if (-not [string]::IsNullOrWhiteSpace([string]$RuntimeState.livenessAt)) {
  try { $LivenessFresh = ((Get-Date).ToUniversalTime() - ([datetime]$RuntimeState.livenessAt).ToUniversalTime()).TotalSeconds -le 90 } catch { $LivenessFresh = $false }
}
$Control = $null
$ControlError = $null
if ($IdentityMatches -and $LockMatches -and $PortMatches -and $LivenessFresh -and (Test-Path -LiteralPath $TokenFilePath)) {
  try {
    $Token = (Get-Content -LiteralPath $TokenFilePath -Raw -Encoding UTF8).Trim()
    $Control = Invoke-RestMethod -Method Get -Uri ([string]$RuntimeState.controlUrl + "/status") -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
  } catch {
    $ControlError = $_.Exception.Message
  }
}
[pscustomobject]@{
  ok = ($IdentityMatches -and $LockMatches -and $PortMatches -and $LivenessFresh -and $null -ne $Control)
  processAlive = ($null -ne $Process)
  identityMatches = $IdentityMatches
  lockMatches = $LockMatches
  portMatches = $PortMatches
  livenessFresh = $LivenessFresh
  runtimeStale = (-not $IdentityMatches -or -not $LockMatches -or -not $PortMatches -or -not $LivenessFresh)
  runtime = $RuntimeState
  control = $Control
  controlError = $ControlError
} | ConvertTo-Json -Depth 16
