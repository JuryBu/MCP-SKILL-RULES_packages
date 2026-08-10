$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$flatBrokerPath = Join-Path $scriptDirectory "broker.mjs"
$isFlatInstallation = Test-Path -LiteralPath $flatBrokerPath -PathType Leaf
$toolkitRoot = Split-Path -Parent $scriptDirectory
$brokerDir = if ($isFlatInstallation) { $scriptDirectory } else { Join-Path $toolkitRoot "mcps\broker" }
$brokerScript = [System.IO.Path]::GetFullPath((Join-Path $brokerDir "broker.mjs"))
$privateEnvPath = Join-Path $brokerDir "broker-private.env.json"
$nodeExe = if (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_NODE_EXE)) {
    [System.IO.Path]::GetFullPath([string]$env:CODEX_TOOLKIT_NODE_EXE)
} else {
    "node"
}
if ([System.IO.Path]::IsPathRooted($nodeExe) -and -not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    throw "Configured Node executable is missing: $nodeExe"
}

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

function Find-BrokerProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { Test-BrokerCommandLine -CommandLine ([string]$_.CommandLine) } |
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
    $process = Start-Process -FilePath $nodeExe `
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
