[CmdletBinding()]
param(
  [string]$BrokerRoot = $(if ($env:CODEX_TOOLKIT_BROKER_ROOT) { $env:CODEX_TOOLKIT_BROKER_ROOT } else { Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "broker" }),
  [string]$BrokerHealthUrl = $(if ($env:CODEX_MCP_BROKER_HEALTH_URL) { $env:CODEX_MCP_BROKER_HEALTH_URL } else { "http://127.0.0.1:14588/health" }),
  [ValidateRange(1, 300)][int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$Endpoint = "sandbox"
$HealthUri = [uri]$BrokerHealthUrl
$AllowedLoopbackHosts = @("127.0.0.1", "localhost", "::1", "[::1]")
if ($HealthUri.Scheme -ne "http" -or $AllowedLoopbackHosts -notcontains $HealthUri.Host) {
  throw "Sandbox backend reload only accepts a loopback http broker URL."
}

$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$Token = $env:CODEX_MCP_BROKER_CONTROL_TOKEN
if ([string]::IsNullOrWhiteSpace($Token) -and (Test-Path -LiteralPath $PrivateEnvPath)) {
  $PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Token = [string]$PrivateEnv.CODEX_MCP_BROKER_CONTROL_TOKEN
}
if ([string]::IsNullOrWhiteSpace($Token)) {
  throw "CODEX_MCP_BROKER_CONTROL_TOKEN is not configured; scoped Sandbox reload is disabled."
}

$Authority = $HealthUri.GetLeftPart([System.UriPartial]::Authority)
$ControlUrl = $Authority + "/__control/reload-backend"
$McpUrl = $Authority + "/sandbox/mcp"
Add-Type -AssemblyName System.Net.Http

function ConvertFrom-McpResponseText {
  param([AllowEmptyString()][string]$Text)

  $Trimmed = $Text.Trim()
  if ([string]::IsNullOrWhiteSpace($Trimmed)) { return $null }
  if ($Trimmed.StartsWith("event:") -or $Trimmed.StartsWith("data:")) {
    $DataLine = @($Trimmed -split "`r?`n" | Where-Object { $_.StartsWith("data:") }) | Select-Object -Last 1
    if ([string]::IsNullOrWhiteSpace($DataLine)) { throw "MCP response contained no data event." }
    return ($DataLine.Substring(5).Trim() | ConvertFrom-Json)
  }
  return ($Trimmed | ConvertFrom-Json)
}

function Invoke-McpPost {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Body,
    [string]$SessionId
  )

  $Headers = @{ Accept = "application/json, text/event-stream" }
  $JsonBody = $Body | ConvertTo-Json -Depth 20 -Compress
  $Request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $McpUrl)
  $Request.Headers.Accept.ParseAdd($Headers.Accept)
  $Request.Headers.ConnectionClose = $true
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    [void]$Request.Headers.TryAddWithoutValidation("mcp-session-id", $SessionId)
  }
  $Request.Content = [System.Net.Http.StringContent]::new($JsonBody, [System.Text.Encoding]::UTF8, "application/json")
  $Client = [System.Net.Http.HttpClient]::new()
  $Client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds + 5)
  $Response = $null
  try {
    $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
    $Text = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $Response.IsSuccessStatusCode) {
      throw "Sandbox MCP HTTP $([int]$Response.StatusCode): $($Text.Substring(0, [Math]::Min(500, $Text.Length)))"
    }
    $ResponseSessionId = $null
    try { $ResponseSessionId = [string]($Response.Headers.GetValues("mcp-session-id") | Select-Object -First 1) } catch {}
    [pscustomobject]@{
      sessionId = $ResponseSessionId
      body = ConvertFrom-McpResponseText -Text $Text
    }
  } finally {
    if ($null -ne $Response) { $Response.Dispose() }
    $Request.Dispose()
    $Client.Dispose()
  }
}

$Before = Invoke-RestMethod -Method Get -Uri $BrokerHealthUrl -TimeoutSec 5
$Body = @{ endpoint = $Endpoint; timeoutMs = $TimeoutSeconds * 1000 } | ConvertTo-Json -Compress
$Result = Invoke-RestMethod -Method Post -Uri $ControlUrl -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" -Body $Body -TimeoutSec ($TimeoutSeconds + 5)
$AfterReload = Invoke-RestMethod -Method Get -Uri $BrokerHealthUrl -TimeoutSec 5

if ($Result.ok -ne $true) { throw "Scoped Sandbox backend reload did not return ok=true." }
if ([int]$Before.pid -ne [int]$AfterReload.pid -or [int]$AfterReload.pid -ne [int]$Result.brokerPid) {
  throw "Broker PID changed during scoped Sandbox backend reload; refusing to report a safe reload."
}

$SessionId = $null
try {
  $Initialize = Invoke-McpPost -Body @{
    jsonrpc = "2.0"
    id = 1
    method = "initialize"
    params = @{
      protocolVersion = "2024-11-05"
      capabilities = @{}
      clientInfo = @{ name = "sandbox-reload-smoke"; version = "1.0.0" }
    }
  }
  if ($null -ne $Initialize.body.error) { throw "Sandbox initialize failed: $($Initialize.body.error.message)" }
  $SessionId = $Initialize.sessionId
  if ([string]::IsNullOrWhiteSpace($SessionId)) { throw "Sandbox initialize returned no MCP session ID." }

  [void](Invoke-McpPost -SessionId $SessionId -Body @{
    jsonrpc = "2.0"
    method = "notifications/initialized"
  })

  $Marker = "sandbox-reload-ok"
  $ToolCall = Invoke-McpPost -SessionId $SessionId -Body @{
    jsonrpc = "2.0"
    id = 2
    method = "tools/call"
    params = @{
      name = "sandbox_exec"
      arguments = @{
        command = "echo $Marker"
        language = "cmd"
        timeout = 5000
        maxOutput = 2000
        maxLines = 20
      }
    }
  }
  if ($null -ne $ToolCall.body.error) { throw "Sandbox short call failed: $($ToolCall.body.error.message)" }
  if ($ToolCall.body.result.isError -eq $true) { throw "Sandbox short call returned isError=true." }
  $ToolText = [string]::Join("`n", @($ToolCall.body.result.content | ForEach-Object { [string]$_.text }))
  if (-not $ToolText.Contains($Marker)) { throw "Sandbox short call did not return the expected marker." }
} finally {
  if (-not [string]::IsNullOrWhiteSpace($SessionId)) {
    try {
      $DeleteRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Delete, $McpUrl)
      $DeleteRequest.Headers.Accept.ParseAdd("application/json, text/event-stream")
      $DeleteRequest.Headers.ConnectionClose = $true
      [void]$DeleteRequest.Headers.TryAddWithoutValidation("mcp-session-id", $SessionId)
      $DeleteClient = [System.Net.Http.HttpClient]::new()
      $DeleteClient.Timeout = [TimeSpan]::FromSeconds(5)
      $DeleteResponse = $null
      try {
        $DeleteResponse = $DeleteClient.SendAsync($DeleteRequest).GetAwaiter().GetResult()
        if (-not $DeleteResponse.IsSuccessStatusCode) {
          Write-Warning "Sandbox reload smoke session cleanup returned HTTP $([int]$DeleteResponse.StatusCode)."
        }
      } finally {
        if ($null -ne $DeleteResponse) { $DeleteResponse.Dispose() }
        $DeleteRequest.Dispose()
        $DeleteClient.Dispose()
      }
    } catch {
      Write-Warning "Sandbox reload smoke session cleanup failed: $($_.Exception.Message)"
    }
  }
}

$AfterSmoke = Invoke-RestMethod -Method Get -Uri $BrokerHealthUrl -TimeoutSec 5
if ([int]$Before.pid -ne [int]$AfterSmoke.pid) {
  throw "Broker PID changed while validating the reloaded Sandbox backend."
}

[pscustomobject]@{
  ok = $true
  endpoint = $Endpoint
  brokerPid = [int]$AfterSmoke.pid
  mode = "control_endpoint"
  backendGenerationBefore = $Result.before.generation
  backendGenerationAfterClose = $Result.after.generation
  reloadCount = $Result.reloadCount
  reloadedAt = $Result.reloadedAt
  frontendBrokerPreserved = $true
  realSandboxCall = $true
} | ConvertTo-Json -Depth 10
