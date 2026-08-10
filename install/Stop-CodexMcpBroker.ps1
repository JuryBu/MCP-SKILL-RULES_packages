$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$flatBrokerPath = Join-Path $scriptDirectory "broker.mjs"
$isFlatInstallation = Test-Path -LiteralPath $flatBrokerPath -PathType Leaf
$toolkitRoot = Split-Path -Parent $scriptDirectory
$brokerScript = if ($isFlatInstallation) {
    [System.IO.Path]::GetFullPath($flatBrokerPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $toolkitRoot "mcps\broker\broker.mjs"))
}
$dataRoot = if ($env:CODEX_TOOLKIT_DATA_ROOT) { $env:CODEX_TOOLKIT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit" }
$pidPath = if ($isFlatInstallation) { Join-Path $scriptDirectory "broker.pid" } else { Join-Path $dataRoot "mcp-http-broker\broker.pid" }

function Get-NodeEntryScript {
    param([string]$CommandLine)
    if (-not $CommandLine) { return $null }
    $tokens = @([regex]::Matches($CommandLine, '(?:"((?:\\.|[^"])*)"|(\S+))') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    if ($tokens.Count -lt 2) { return $null }
    $candidate = $tokens[1]
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { return $null }
    return [System.IO.Path]::GetFullPath($candidate)
}

function Test-BrokerCommandLine {
    param([string]$CommandLine)
    $entryScript = Get-NodeEntryScript -CommandLine $CommandLine
    return $entryScript -and $entryScript.Equals($brokerScript, [System.StringComparison]::OrdinalIgnoreCase)
}

function Find-BrokerProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { Test-BrokerCommandLine -CommandLine ([string]$_.CommandLine) }
}

function Get-BrokerProcessFromPid {
    param([string]$PidValue)
    if (-not $PidValue) { return $null }
    $process = Get-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.ProcessName -ne "node") { return $null }
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
    if (-not (Test-BrokerCommandLine -CommandLine ([string]$cim.CommandLine))) {
        return $null
    }
    return $process
}

if (-not (Test-Path -LiteralPath $pidPath)) {
    $brokerProcesses = @(Find-BrokerProcesses)
    if ($brokerProcesses.Count -eq 0) {
        Write-Output "Codex MCP broker pid file not found."
        exit 0
    }
    foreach ($brokerProcess in $brokerProcesses) {
        & taskkill.exe /PID $brokerProcess.ProcessId /T /F | Out-Null
        Write-Output "Stopped Codex MCP broker process tree by command line match: PID $($brokerProcess.ProcessId)"
    }
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
    foreach ($liveBrokerProcess in @(Find-BrokerProcesses)) {
        & taskkill.exe /PID $liveBrokerProcess.ProcessId /T /F | Out-Null
        Write-Output "Stopped Codex MCP broker process tree by command line match: PID $($liveBrokerProcess.ProcessId)"
    }
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
