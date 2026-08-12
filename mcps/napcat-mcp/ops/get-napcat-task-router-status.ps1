[CmdletBinding()]
param(
  [string]$DataRoot = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RuntimeStatePath = Join-Path $DataRoot "state\task-router-runtime.json"
$RegistryPath = Join-Path $DataRoot "state\task-registry.json"
$RunnerPath = Join-Path $NapCatMcpRoot "src\task-router-runner.mjs"

$RuntimeState = $null
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try { $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
}
$Process = $null
if ($null -ne $RuntimeState -and [int]$RuntimeState.pid -gt 0) {
  $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$RuntimeState.pid)" -ErrorAction SilentlyContinue
}
$OpenTaskCount = 0
if (Test-Path -LiteralPath $RegistryPath) {
  try {
    $Registry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $OpenTaskCount = @($Registry.tasks.PSObject.Properties.Value | Where-Object { $_.status -eq "open" }).Count
  } catch { }
}

[pscustomobject]@{
  alive = ($null -ne $Process -and [string]$Process.CommandLine -like "*$RunnerPath*")
  openTaskCount = $OpenTaskCount
  runtimeState = $RuntimeState
  runtimeStatePath = $RuntimeStatePath
  registryPath = $RegistryPath
} | ConvertTo-Json -Depth 10
