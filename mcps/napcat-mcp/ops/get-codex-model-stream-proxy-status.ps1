[CmdletBinding()]
param([string]$DataRoot = "")

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }
. (Join-Path $PSScriptRoot 'resolve-codex-outer-runtime-startup.ps1')
$ManagedStartup = Resolve-CodexOuterRuntimeStartup -DataRoot $DataRoot
$ManagedProfile = Get-CodexInnerManagedStartupProfile -Startup $ManagedStartup -DataRoot $DataRoot
if ($null -ne $ManagedProfile) {
  if (-not (Test-Path -LiteralPath $ManagedProfile.managedStatePath -PathType Leaf)) {
    [pscustomobject]@{ running = $false; healthy = $false; mode = 'managed'; reason = 'managed_runtime_missing' } | ConvertTo-Json
    return
  }
  Assert-CodexStartupPathWithoutReparsePoint -Path $ManagedProfile.managedStatePath
  $ManagedItem = Get-Item -LiteralPath $ManagedProfile.managedStatePath -Force
  if ($ManagedItem.Length -gt 16777216) { throw 'INNER_MANAGED_RUNTIME_TOO_LARGE' }
  $ManagedRuntime = Get-Content -LiteralPath $ManagedProfile.managedStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ManagedRuntime.schemaVersion -ne 1 -or $ManagedRuntime.ownerId -cne $ManagedProfile.ownerId -or
      $ManagedRuntime.nativeSourceId -cne $ManagedProfile.nativeSourceId -or $ManagedRuntime.front.pid -ne $ManagedRuntime.pid -or
      $ManagedRuntime.front.host -cne '127.0.0.1' -or $ManagedRuntime.front.port -ne $ManagedProfile.ports.inner) {
    throw 'INNER_MANAGED_RUNTIME_IDENTITY_MISMATCH'
  }
  $ManagedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$ManagedRuntime.pid)" -ErrorAction SilentlyContinue
  $ExpectedRunner = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'src\codex-app-server-proxy-runner.mjs'))
  $ExpectedProfile = '"--inner-managed-profile" "' + [string]$ManagedStartup.innerManagedProfilePath + '"'
  $ExpectedInstance = '"--instance-token" "' + [string]$ManagedRuntime.instanceToken + '"'
  $CommandLine = if ($null -ne $ManagedProcess) { [string]$ManagedProcess.CommandLine } else { '' }
  $IdentityMatches = $CommandLine.IndexOf($ExpectedRunner, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $CommandLine.IndexOf($ExpectedProfile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $CommandLine.IndexOf($ExpectedInstance, [System.StringComparison]::Ordinal) -ge 0
  $Listener = Get-NetTCPConnection -State Listen -LocalPort ([int]$ManagedProfile.ports.inner) -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq [int]$ManagedRuntime.pid }
  $Fresh = $false
  try { $Age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$ManagedRuntime.livenessAt).TotalSeconds; $Fresh = $Age -ge -2 -and $Age -le 15 } catch {}
  $Health = $null
  $ControlIdentityMatches = $false
  $ReadyForDesktop = $false
  $TokenMatches = $false
  if ($IdentityMatches -and $null -ne $Listener) {
    try {
      $TokenPath = [string]$ManagedProfile.outerPaths.tokenFilePath
      if ($TokenPath -ine (Join-Path $DataRoot 'state/codex-app-server-proxy-token.txt')) { throw 'INNER_CONTROL_TOKEN_PATH_MISMATCH' }
      Assert-CodexStartupPathWithoutReparsePoint -Path $TokenPath
      $TokenItem = Get-Item -LiteralPath $TokenPath -Force
      if ($TokenItem.Length -lt 1 -or $TokenItem.Length -gt 4096 -or
          (Get-FileHash -LiteralPath $TokenPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ManagedProfile.controlTokenSha256) { throw 'INNER_CONTROL_TOKEN_IDENTITY_MISMATCH' }
      $TokenMatches = $true
      $Headers = @{ Authorization = 'Bearer ' + [IO.File]::ReadAllText($TokenPath).Trim();
        'x-inner-owner-id' = [string]$ManagedProfile.ownerId; 'x-inner-native-source-id' = [string]$ManagedProfile.nativeSourceId;
        'x-inner-instance-token' = [string]$ManagedRuntime.instanceToken }
      $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$($ManagedProfile.ports.control)/v1/inner/status" -Headers $Headers -TimeoutSec 2
      $ControlIdentityMatches = $Health.ok -eq $true -and $Health.ownerId -ceq $ManagedProfile.ownerId -and
        $Health.nativeSourceId -ceq $ManagedProfile.nativeSourceId -and $Health.instanceToken -ceq $ManagedRuntime.instanceToken -and
        $Health.coordinator.running -eq $true -and $Health.coordinator.nativeHealthy -eq $true -and
        @($Health.coordinator.workers | Where-Object { $_.workerId -ceq $Health.selectedWorkerId -and $_.alive -eq $true }).Count -eq 1
    } catch {}
  }
  if ($IdentityMatches -and $null -ne $Listener -and $Fresh -and $TokenMatches -and $ManagedRuntime.state -ceq 'running' -and -not $ControlIdentityMatches) {
    try {
      $OuterStatus = & (Join-Path $PSScriptRoot 'get-codex-app-server-proxy-status.ps1') -DataRoot $DataRoot | ConvertFrom-Json
      $OuterAge = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$OuterStatus.runtime.livenessAt).TotalSeconds
      $ReadyForDesktop = $OuterStatus.ok -eq $true -and $OuterAge -ge -2 -and $OuterAge -le 15 -and
        $OuterStatus.runtime.pid -eq $ManagedRuntime.pid -and $OuterStatus.runtime.instanceToken -ceq $ManagedRuntime.instanceToken -and
        $OuterStatus.runtime.state -ceq 'waiting_for_desktop' -and $OuterStatus.runtime.waitingForDesktop -eq $true -and
        $null -eq $OuterStatus.runtime.appServerPid -and $OuterStatus.control.closed -eq $false -and
        $OuterStatus.control.outerRuntime.instanceId -ceq $ManagedRuntime.instanceToken
    } catch {}
  }
  [pscustomobject]@{ running = $IdentityMatches -and $null -ne $Listener;
    healthy = $IdentityMatches -and $null -ne $Listener -and $Fresh -and $ManagedRuntime.state -ceq 'running' -and $ControlIdentityMatches;
    readyForDesktop = $ReadyForDesktop;
    mode = 'managed'; state = $ManagedRuntime.state; pid = $ManagedRuntime.pid; instanceToken = $ManagedRuntime.instanceToken;
    endpoint = "http://127.0.0.1:$($ManagedProfile.ports.inner)"; livenessAt = $ManagedRuntime.livenessAt;
    ownerId = $ManagedRuntime.ownerId; nativeSourceId = $ManagedRuntime.nativeSourceId;
    selectedWorkerId = if ($ControlIdentityMatches) { $Health.selectedWorkerId } else { $ManagedRuntime.coordinator.defaultWorkerId };
    activeRequests = if ($ControlIdentityMatches) { ($Health.coordinator.threads | Measure-Object -Property activeHttp -Sum).Sum } else { $null };
    innerManagedProfileSha256 = $ManagedStartup.innerManagedProfileSha256 } | ConvertTo-Json -Depth 8
  return
}
$RuntimePath = Join-Path $DataRoot "state\codex-model-stream-proxy-runtime.json"
if (-not (Test-Path -LiteralPath $RuntimePath)) {
  [pscustomobject]@{ running = $false; healthy = $false; reason = "runtime_state_missing" } | ConvertTo-Json
  return
}
$Runtime = Get-Content -LiteralPath $RuntimePath -Encoding UTF8 -Raw | ConvertFrom-Json
$Process = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
$Health = $null
if ($null -ne $Process) {
  try { $Health = Invoke-RestMethod -Uri ("{0}/health" -f [string]$Runtime.endpoint) -TimeoutSec 2 } catch {}
}
[pscustomobject]@{
  running = $null -ne $Process
  healthy = $null -ne $Health -and $Health.ok -eq $true
  pid = [int]$Runtime.pid
  endpoint = [string]$Runtime.endpoint
  livenessAt = [string]$Runtime.livenessAt
  activeRequests = $Runtime.activeRequests
  counters = $Runtime.counters
  processPath = if ($null -ne $Process) { $Process.Path } else { $null }
} | ConvertTo-Json -Depth 8
