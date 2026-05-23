$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$brokerScript = [System.IO.Path]::GetFullPath((Join-Path $toolkitRoot "mcps\broker\broker.mjs"))
$dataRoot = if ($env:CODEX_TOOLKIT_DATA_ROOT) { $env:CODEX_TOOLKIT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit" }
$port = if ($env:CODEX_MCP_BROKER_PORT) { $env:CODEX_MCP_BROKER_PORT } else { "14588" }
$pidPath = Join-Path $dataRoot "mcp-http-broker\broker.pid"
$statePath = Join-Path $dataRoot "mcp-http-broker\broker-state.json"

function Get-BrokerProcessFromPid {
    param([string]$PidValue)
    if (-not $PidValue) { return $null }
    $process = Get-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.ProcessName -ne "node") { return $null }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
    $commandLine = [string]$cim.CommandLine
    if ($commandLine.IndexOf($brokerScript, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $null
    }
    return $process
}

if (Test-Path -LiteralPath $pidPath) {
    $pidValue = Get-Content -LiteralPath $pidPath -Encoding UTF8 | Select-Object -First 1
    $brokerProcess = Get-BrokerProcessFromPid -PidValue $pidValue
    if ($brokerProcess) {
        Write-Output "Codex MCP broker running: PID $pidValue"
    } else {
        $process = if ($pidValue) { Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue } else { $null }
        if ($process) {
            Write-Output "Codex MCP broker pid file is stale: PID $pidValue is $($process.ProcessName), not this broker"
        } else {
            Write-Output "Codex MCP broker pid file exists, but process is not running: PID $pidValue"
        }
    }
} else {
    Write-Output "Codex MCP broker pid file not found."
}

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method Get -TimeoutSec 5 | ConvertTo-Json -Depth 6
} catch {
    Write-Output "Health check failed: $($_.Exception.Message)"
}

if (Test-Path -LiteralPath $statePath) {
    Get-Content -LiteralPath $statePath -Encoding UTF8
}
