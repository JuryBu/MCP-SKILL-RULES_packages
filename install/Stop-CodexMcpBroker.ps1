$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$brokerScript = [System.IO.Path]::GetFullPath((Join-Path $toolkitRoot "mcps\broker\broker.mjs"))
$dataRoot = if ($env:CODEX_TOOLKIT_DATA_ROOT) { $env:CODEX_TOOLKIT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit" }
$pidPath = Join-Path $dataRoot "mcp-http-broker\broker.pid"

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

if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Output "Codex MCP broker pid file not found."
    exit 0
}

$pidValue = Get-Content -LiteralPath $pidPath -Encoding UTF8 | Select-Object -First 1
$brokerProcess = Get-BrokerProcessFromPid -PidValue $pidValue
if ($brokerProcess) {
    & taskkill.exe /PID $pidValue /T /F | Out-Null
    Write-Output "Stopped Codex MCP broker process tree: PID $pidValue"
} else {
    $process = if ($pidValue) { Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue } else { $null }
    if ($process) {
        Write-Output "Codex MCP broker was not stopped: PID $pidValue is $($process.ProcessName), not this broker"
    } else {
        Write-Output "Broker process not running: PID $pidValue"
    }
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
