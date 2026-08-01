[CmdletBinding()]
param(
  [ValidateSet("napcat")][string]$Endpoint = "napcat",
  [string]$BrokerRoot = $(if ($env:CODEX_TOOLKIT_BROKER_ROOT) { $env:CODEX_TOOLKIT_BROKER_ROOT } else { Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "broker" }),
  [string]$BrokerHealthUrl = $(if ($env:CODEX_MCP_BROKER_HEALTH_URL) { $env:CODEX_MCP_BROKER_HEALTH_URL } else { "http://127.0.0.1:14588/health" }),
  [ValidateRange(1, 300)][int]$TimeoutSeconds = 30,
  [switch]$AllowLegacyChildRecycle
)

$ErrorActionPreference = "Stop"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$Token = $env:CODEX_MCP_BROKER_CONTROL_TOKEN
$LegacyToken = $null
if ([string]::IsNullOrWhiteSpace($Token) -and (Test-Path -LiteralPath $PrivateEnvPath)) {
  $PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Token = [string]$PrivateEnv.CODEX_MCP_BROKER_CONTROL_TOKEN
  $LegacyToken = [string]$PrivateEnv.NAPCAT_MCP_TOKEN
  if ([string]::IsNullOrWhiteSpace($Token)) { $Token = $LegacyToken }
} elseif (Test-Path -LiteralPath $PrivateEnvPath) {
  $PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $LegacyToken = [string]$PrivateEnv.NAPCAT_MCP_TOKEN
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "CODEX_MCP_BROKER_CONTROL_TOKEN is not configured; scoped backend reload is disabled."
}

$Before = Invoke-RestMethod -Method Get -Uri $BrokerHealthUrl -TimeoutSec 5
$ControlUrl = ([uri]$BrokerHealthUrl).GetLeftPart([System.UriPartial]::Authority) + "/__control/reload-backend"
$Body = @{ endpoint = $Endpoint; timeoutMs = $TimeoutSeconds * 1000 } | ConvertTo-Json -Compress
$Result = $null
$ControlFailure = $null
try {
  try {
    $Result = Invoke-RestMethod -Method Post -Uri $ControlUrl -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $Body -TimeoutSec ($TimeoutSeconds + 5)
  } catch {
    if ([string]::IsNullOrWhiteSpace($LegacyToken) -or $LegacyToken -eq $Token) { throw }
    $Result = Invoke-RestMethod -Method Post -Uri $ControlUrl -Headers @{ Authorization = "Bearer $LegacyToken" } -ContentType "application/json" -Body $Body -TimeoutSec ($TimeoutSeconds + 5)
  }
} catch {
  $ControlFailure = $_.Exception.Message
}
$After = Invoke-RestMethod -Method Get -Uri $BrokerHealthUrl -TimeoutSec 5

if ($null -ne $Result -and $Result.ok -eq $true) {
  if ([int]$Before.pid -ne [int]$After.pid -or [int]$After.pid -ne [int]$Result.brokerPid) {
    throw "Broker PID changed during scoped backend reload; refusing to report a safe hot reload."
  }
  [pscustomobject]@{
    ok = $true
    endpoint = $Endpoint
    brokerPid = [int]$After.pid
    mode = "control_endpoint"
    backendGenerationBefore = $Result.before.generation
    backendGenerationAfterClose = $Result.after.generation
    reloadCount = $Result.reloadCount
    reloadedAt = $Result.reloadedAt
    frontendBrokerPreserved = $true
  } | ConvertTo-Json -Depth 10
  return
}

if (-not $AllowLegacyChildRecycle) {
  throw "Scoped backend reload control call failed: $ControlFailure"
}
$BrokerStatePath = if ($PrivateEnv.CODEX_MCP_BROKER_STATE) { [string]$PrivateEnv.CODEX_MCP_BROKER_STATE } else { Join-Path $BrokerRoot "broker-state.json" }
if (-not (Test-Path -LiteralPath $BrokerStatePath)) { throw "Legacy backend recycle cannot find broker state: $BrokerStatePath" }
$BrokerState = Get-Content -LiteralPath $BrokerStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
$BackendPid = [int]$BrokerState.endpoints.$Endpoint.backend.pid
if ($BackendPid -le 0) {
  [pscustomobject]@{
    ok = $true
    endpoint = $Endpoint
    brokerPid = [int]$After.pid
    mode = "legacy_backend_already_idle"
    controlFailure = $ControlFailure
    frontendBrokerPreserved = $true
  } | ConvertTo-Json -Depth 10
  return
}
$BackendProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $BackendPid" -ErrorAction SilentlyContinue
if ($null -eq $BackendProcess -or [string]$BackendProcess.CommandLine -notlike "*napcat-mcp*index.mjs*") {
  throw "Legacy backend PID failed the NapCat command-line identity check."
}
Stop-Process -Id $BackendPid -Force -ErrorAction Stop
$Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 100
  $BackendProcess = Get-Process -Id $BackendPid -ErrorAction SilentlyContinue
} while ($null -ne $BackendProcess -and [DateTime]::UtcNow -lt $Deadline)
if ($null -ne $BackendProcess) { throw "Legacy NapCat backend did not exit before timeout." }
$After = Invoke-RestMethod -Method Get -Uri $BrokerHealthUrl -TimeoutSec 5
if ([int]$Before.pid -ne [int]$After.pid) {
  throw "Broker PID changed during scoped backend reload; refusing to report a safe hot reload."
}

[pscustomobject]@{
  ok = $true
  endpoint = $Endpoint
  brokerPid = [int]$After.pid
  mode = "legacy_child_recycle"
  recycledBackendPid = $BackendPid
  controlFailure = $ControlFailure
  frontendBrokerPreserved = $true
} | ConvertTo-Json -Depth 10
