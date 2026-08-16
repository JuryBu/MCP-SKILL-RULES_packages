[CmdletBinding()]
param(
  [ValidateRange(0, 3600)][int]$IntervalSeconds = 0,
  [string]$DataRoot = "",
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT,
  [string]$NapCatRoot = "",
  [string]$QqExePath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$NapCatParent = Split-Path -Parent $NapCatMcpRoot
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) {
  $PortableBrokerRoot = Join-Path $NapCatParent "broker"
  $FlatBrokerRoot = $NapCatParent
  $PortablePrivateEnvPath = Join-Path $PortableBrokerRoot "broker-private.env.json"
  $FlatPrivateEnvPath = Join-Path $FlatBrokerRoot "broker-private.env.json"
  $BrokerRoot = if (Test-Path -LiteralPath $PortablePrivateEnvPath) {
    $PortableBrokerRoot
  } elseif (Test-Path -LiteralPath $FlatPrivateEnvPath) {
    $FlatBrokerRoot
  } elseif (Test-Path -LiteralPath (Join-Path $PortableBrokerRoot "broker.mjs")) {
    $PortableBrokerRoot
  } else {
    $FlatBrokerRoot
  }
}
$RuntimeStateFile = Join-Path $DataRoot "napcat-runtime.json"
$RuntimeConfiguration = $null
if (Test-Path -LiteralPath $RuntimeStateFile) {
  try { $RuntimeConfiguration = Get-Content -LiteralPath $RuntimeStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $RuntimeConfiguration = $null }
}
if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  if ($null -ne $RuntimeConfiguration) { $NapCatRoot = [string]$RuntimeConfiguration.napCatRoot }
  if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
    $NapCatRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)) "NapCat"
  }
}
if ([string]::IsNullOrWhiteSpace($QqExePath) -and $null -ne $RuntimeConfiguration) {
  $QqExePath = [string]$RuntimeConfiguration.qqExePath
}
$ToolkitRoot = Split-Path -Parent $NapCatParent
$RunnerPath = Join-Path $NapCatMcpRoot "src\supervisor-runner.mjs"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$RegistryPath = Join-Path $DataRoot "state\task-registry.json"
$RuntimeStatePath = Join-Path $DataRoot "state\supervisor-runtime.json"
$LogPath = Join-Path $DataRoot "state\supervisor.jsonl"
$StopFilePath = Join-Path $DataRoot "state\supervisor.stop"
$LockPath = Join-Path $DataRoot "state\supervisor.lock"
$AutomationMaintenancePath = Join-Path $DataRoot "state\task-router.maintenance.json"
$AutomationAlertPath = Join-Path $DataRoot "state\automation-alert.json"
$LoginScript = Join-Path $NapCatMcpRoot "ops\start-napcat-login.ps1"
$env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT = $DataRoot
$env:CODEX_TOOLKIT_BROKER_ROOT = $BrokerRoot

function Get-ServiceManifestPath {
  $ConfiguredManifestPath = [string]$env:CODEX_TOOLKIT_SERVICE_MANIFEST
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredManifestPath)) {
    return [System.IO.Path]::GetFullPath($ConfiguredManifestPath)
  }
  return Join-Path $env:USERPROFILE ".codex-toolkit\services\infrastructure\service-manifest.json"
}

function Resolve-BrokerStartScript {
  $ResolvedBrokerRoot = [System.IO.Path]::GetFullPath($BrokerRoot).TrimEnd('\')
  $ServiceManifestPath = Get-ServiceManifestPath
  if (Test-Path -LiteralPath $ServiceManifestPath -PathType Leaf) {
    try {
      $ServiceManifest = Get-Content -LiteralPath $ServiceManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $ManagedBrokerStartScript = [string]$ServiceManifest.broker.startScript
      $ManagedBrokerScript = [string]$ServiceManifest.broker.brokerScript
      if (-not [string]::IsNullOrWhiteSpace($ManagedBrokerStartScript) -or -not [string]::IsNullOrWhiteSpace($ManagedBrokerScript)) {
        if ([string]::IsNullOrWhiteSpace($ManagedBrokerStartScript) -or [string]::IsNullOrWhiteSpace($ManagedBrokerScript)) {
          throw "Managed broker service manifest must record both broker.startScript and broker.brokerScript: $ServiceManifestPath"
        }
        $ResolvedBrokerScript = [System.IO.Path]::GetFullPath($ManagedBrokerScript)
        $ManagedBrokerRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $ResolvedBrokerScript)).TrimEnd('\')
        if (-not $ManagedBrokerRoot.Equals($ResolvedBrokerRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Managed broker service manifest points to a different BrokerRoot. expected=$ResolvedBrokerRoot actual=$ManagedBrokerRoot manifest=$ServiceManifestPath"
        }
        $ResolvedStartScript = [System.IO.Path]::GetFullPath($ManagedBrokerStartScript)
        if (-not (Test-Path -LiteralPath $ResolvedStartScript -PathType Leaf)) {
          throw "Managed broker start script is missing: $ResolvedStartScript"
        }
        return $ResolvedStartScript
      }
    } catch {
      throw "Cannot resolve the managed broker start script from $ServiceManifestPath. $($_.Exception.Message)"
    }
  }

  $PortableBrokerStartScript = Join-Path $ToolkitRoot "install\Start-CodexMcpBroker.ps1"
  $FlatBrokerStartScript = Join-Path $BrokerRoot "Start-CodexMcpBroker.ps1"
  if (Test-Path -LiteralPath $PortableBrokerStartScript -PathType Leaf) { return $PortableBrokerStartScript }
  return $FlatBrokerStartScript
}

$BrokerStartScript = Resolve-BrokerStartScript

$IntervalMilliseconds = if ($IntervalSeconds -gt 0) { $IntervalSeconds * 1000 } else { 60000 }
if ($IntervalSeconds -eq 0 -and (Test-Path -LiteralPath $PrivateEnvPath)) {
  try {
    $PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ConfiguredMilliseconds = [int]$PrivateEnv.NAPCAT_SUPERVISOR_INTERVAL_MS
    if ($ConfiguredMilliseconds -ge 10000 -and $ConfiguredMilliseconds -le 3600000) {
      $IntervalMilliseconds = $ConfiguredMilliseconds
    }
  } catch {
  }
}

foreach ($RequiredPath in @($RunnerPath, $PrivateEnvPath, $BindingPath, $BrokerStartScript, $LoginScript)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "Missing supervisor runtime file: $RequiredPath" }
}

function Test-ExpectedSupervisorRuntime {
  param($RuntimeState, $ProcessInfo)
  if ($null -eq $RuntimeState -or $null -eq $ProcessInfo -or [string]$RuntimeState.state -ne "running") { return $false }
  $CommandLine = [string]$ProcessInfo.CommandLine
  if ($CommandLine.IndexOf("supervisor-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if ($CommandLine.IndexOf($LockPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
  if (-not (Test-Path -LiteralPath $LockPath)) { return $false }
  try {
    $LockState = Get-Content -LiteralPath $LockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [int]$LockState.pid -eq [int]$RuntimeState.pid -and [string]$LockState.token -eq [string]$RuntimeState.instanceToken -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeState.instanceToken)
  } catch {
    return $false
  }
}

if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $ExistingState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExistingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ExistingState.pid)" -ErrorAction SilentlyContinue
    if (Test-ExpectedSupervisorRuntime -RuntimeState $ExistingState -ProcessInfo $ExistingProcess) {
      [pscustomobject]@{
        started = $false
        reason = "already_running"
        pid = [int]$ExistingState.pid
        runtimeState = $ExistingState
      } | ConvertTo-Json -Depth 10
      return
    }
  } catch {
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "state") | Out-Null
if (Test-Path -LiteralPath $StopFilePath) { Remove-Item -LiteralPath $StopFilePath -Force }
function Resolve-NodeExecutable {
  $ConfiguredNode = [string]$env:CODEX_TOOLKIT_NODE_EXE
  if (-not [string]::IsNullOrWhiteSpace($ConfiguredNode) -and (Test-Path -LiteralPath $ConfiguredNode -PathType Leaf)) {
    return [System.IO.Path]::GetFullPath($ConfiguredNode)
  }
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $NodeCommand -and (Test-Path -LiteralPath $NodeCommand.Source -PathType Leaf)) {
    return [string]$NodeCommand.Source
  }
  $ManifestPath = Get-ServiceManifestPath
  if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    try {
      $ManagedNode = [string](Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).broker.nodeExe
      if (-not [string]::IsNullOrWhiteSpace($ManagedNode) -and (Test-Path -LiteralPath $ManagedNode -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($ManagedNode)
      }
    } catch {
    }
  }
  throw "Managed Node executable is unavailable."
}

$NodePath = Resolve-NodeExecutable

function Quote-Argument {
  param([string]$Value)
  return '"' + $Value.Replace('"', '\"') + '"'
}

$Arguments = @(
  $RunnerPath,
  "--private-env", $PrivateEnvPath,
  "--binding", $BindingPath,
  "--registry", $RegistryPath,
  "--runtime-state", $RuntimeStatePath,
  "--log", $LogPath,
  "--stop-file", $StopFilePath,
  "--lock", $LockPath,
  "--interval-ms", ([string]$IntervalMilliseconds),
  "--broker-health-url", "http://127.0.0.1:14588/health?endpoint=napcat&deep=1",
  "--broker-start-script", $BrokerStartScript,
  "--login-script", $LoginScript,
  "--napcat-root", $NapCatRoot,
  "--maintenance-file", $AutomationMaintenancePath,
  "--alert-file", $AutomationAlertPath
)
if (-not [string]::IsNullOrWhiteSpace($QqExePath)) {
  $Arguments += @("--qq-exe-path", $QqExePath)
}
$ArgumentLine = ($Arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
$Process = Start-Process -FilePath $NodePath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru

$RuntimeState = $null
$Deadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  Start-Sleep -Milliseconds 200
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    try {
      $CandidateState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $RuntimeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$CandidateState.pid)" -ErrorAction SilentlyContinue
      if (Test-ExpectedSupervisorRuntime -RuntimeState $CandidateState -ProcessInfo $RuntimeProcess) { $RuntimeState = $CandidateState; break }
      $RuntimeState = $null
    } catch {
      $RuntimeState = $null
    }
  }
  if ($Process.HasExited -and $null -eq $RuntimeState) {
    throw "Supervisor exited immediately after launch, exitCode=$($Process.ExitCode)"
  }
} while ([DateTime]::UtcNow -lt $Deadline)

if ($null -eq $RuntimeState) { throw "Supervisor did not write runtime state within 12 seconds" }
[pscustomobject]@{
  started = $true
  pid = [int]$RuntimeState.pid
  intervalSeconds = ($IntervalMilliseconds / 1000)
  runtimeStatePath = $RuntimeStatePath
  logPath = $LogPath
} | ConvertTo-Json -Depth 10
