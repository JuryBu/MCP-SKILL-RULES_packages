$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$flatBrokerPath = Join-Path $scriptDirectory "broker.mjs"
$isFlatInstallation = Test-Path -LiteralPath $flatBrokerPath -PathType Leaf
$toolkitRoot = Split-Path -Parent $scriptDirectory
$brokerDir = if ($isFlatInstallation) { $scriptDirectory } else { Join-Path $toolkitRoot "mcps\broker" }
$brokerScript = [System.IO.Path]::GetFullPath((Join-Path $brokerDir "broker.mjs"))
$privateEnvPath = Join-Path $brokerDir "broker-private.env.json"

if ($isFlatInstallation -and (Test-Path -LiteralPath $privateEnvPath -PathType Leaf)) {
    $privateEnv = Get-Content -LiteralPath $privateEnvPath -Encoding UTF8 -Raw | ConvertFrom-Json
    foreach ($property in $privateEnv.PSObject.Properties) {
        if ($property.Name -and $null -ne $property.Value -and [string]$property.Value -ne "") {
            Set-Item -LiteralPath "Env:$($property.Name)" -Value ([string]$property.Value)
        }
    }
}

$dataRoot = if ($env:CODEX_TOOLKIT_DATA_ROOT) { $env:CODEX_TOOLKIT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit" }
$brokerDataDir = if ($isFlatInstallation) { $brokerDir } else { Join-Path $dataRoot "mcp-http-broker" }
$stdoutPath = Join-Path $brokerDataDir "broker-stdout.log"
$stderrPath = Join-Path $brokerDataDir "broker-stderr.log"
$pidPath = Join-Path $brokerDataDir "broker.pid"
$statePath = Join-Path $brokerDataDir "broker-state.json"

New-Item -ItemType Directory -Force -Path $brokerDataDir | Out-Null

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

function Find-BrokerProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { ([string]$_.CommandLine).IndexOf($brokerScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        Select-Object -First 1
}

if (Test-Path -LiteralPath $pidPath) {
    $existingPid = Get-Content -LiteralPath $pidPath -Encoding UTF8 | Select-Object -First 1
    $brokerProcess = Get-BrokerProcessFromPid -PidValue $existingPid
    if ($brokerProcess) {
        Write-Output "Codex MCP broker already running: PID $existingPid"
        Write-Output "Data root: $dataRoot"
        exit 0
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

$existingBroker = Find-BrokerProcess
if ($existingBroker) {
    Set-Content -LiteralPath $pidPath -Value $existingBroker.ProcessId -Encoding UTF8
    Write-Output "Codex MCP broker already running: PID $($existingBroker.ProcessId)"
    Write-Output "Data root: $dataRoot"
    exit 0
}

$previousEnv = @{}
$envVars = if ($isFlatInstallation) {
    @{}
} else {
    @{
        CODEX_TOOLKIT_MCP_ROOT = (Join-Path $toolkitRoot "mcps")
        CODEX_TOOLKIT_DATA_ROOT = $dataRoot
        CODEX_MCP_BROKER_LOG = (Join-Path $brokerDataDir "broker.log")
        CODEX_MCP_BROKER_STATE = $statePath
        MEMORY_STORE_DATA_ROOT = (Join-Path $dataRoot "memory-store")
        SANDBOX_DATA_ROOT = (Join-Path $dataRoot "sandbox-data")
        WEB_FETCHER_PROFILE_BASE_DIR = (Join-Path $dataRoot "web-fetcher-profiles")
    }
}
foreach ($entry in $envVars.GetEnumerator()) {
    $previousEnv[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, "Process")
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}
try {
    $process = Start-Process -FilePath "node" `
        -ArgumentList @($brokerScript) `
        -WorkingDirectory $brokerDir `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru
} finally {
    foreach ($entry in $previousEnv.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
}

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding UTF8
Write-Output "Codex MCP broker started: PID $($process.Id)"
Write-Output "Data root: $dataRoot"
