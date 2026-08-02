[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT,
  [ValidateRange(10, 900)][int]$TimeoutSeconds = 600,
  [ValidateRange(500, 10000)][int]$IdleConfirmMilliseconds = 1500
)

$ErrorActionPreference = "Stop"
$OpsRoot = $PSScriptRoot
$StateRoot = Join-Path $DataRoot "state"
$ActivationStatePath = Join-Path $StateRoot "codex-app-server-pending-activation.json"
$AlertPath = Join-Path $StateRoot "automation-alert.json"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

function Write-State {
  param([string]$State, [string]$Message, $Details = $null)
  $Value = [ordered]@{
    schemaVersion = 1
    state = $State
    message = $Message
    updatedAt = (Get-Date).ToString("o")
    details = $Details
  }
  [System.IO.File]::WriteAllText($ActivationStatePath, (($Value | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
}

try {
  Write-State -State "waiting_for_idle" -Message "Waiting for Codex Desktop to disconnect from the managed proxy."
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $IdleSince = $null
  do {
    $Status = & (Join-Path $OpsRoot "get-codex-app-server-proxy-status.ps1") -DataRoot $DataRoot | ConvertFrom-Json
    $ClientCount = if ($Status.ok -eq $true -and $null -ne $Status.control) { [int]$Status.control.clientCount } else { 0 }
    if ($ClientCount -eq 0) {
      if ($null -eq $IdleSince) { $IdleSince = [DateTime]::UtcNow }
      if (([DateTime]::UtcNow - $IdleSince).TotalMilliseconds -ge $IdleConfirmMilliseconds) { break }
    } else {
      $IdleSince = $null
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $Deadline)
  if ($null -eq $IdleSince -or ([DateTime]::UtcNow - $IdleSince).TotalMilliseconds -lt $IdleConfirmMilliseconds) {
    throw "Codex Desktop did not disconnect before the activation timeout."
  }

  Write-State -State "activating" -Message "Codex Desktop is idle; activating the staged NapCat bridge."
  $StopResult = & (Join-Path $OpsRoot "stop-codex-app-server-proxy.ps1") -DataRoot $DataRoot -AllowVerifiedForceStop | ConvertFrom-Json
  if ($StopResult.stopped -ne $true -or $StopResult.clean -ne $true) {
    throw "The managed proxy or App Server did not stop cleanly."
  }
  if (-not [string]::IsNullOrWhiteSpace($BrokerRoot)) {
    & (Join-Path $OpsRoot "reload-broker-backend.ps1") -Endpoint napcat -BrokerRoot $BrokerRoot -AllowLegacyChildRecycle | Out-Null
  }
  & (Join-Path $OpsRoot "start-codex-app-server-proxy.ps1") -DataRoot $DataRoot | Out-Null
  $FinalStatus = & (Join-Path $OpsRoot "get-codex-app-server-proxy-status.ps1") -DataRoot $DataRoot | ConvertFrom-Json
  if ($FinalStatus.ok -ne $true -or $FinalStatus.runtime.state -ne "running" -or $FinalStatus.runtime.automationEnabled -ne $true) {
    throw "The staged proxy did not become healthy after activation."
  }
  Write-State -State "ready" -Message "NapCat bridge activation completed; Codex may be opened normally." -Details ([ordered]@{
    proxyPid = $FinalStatus.runtime.pid
    appServerPid = $FinalStatus.runtime.appServerPid
    downstreamUrl = $FinalStatus.runtime.downstreamUrl
    upstreamUrl = $FinalStatus.runtime.upstreamUrl
  })
} catch {
  $Message = $_.Exception.Message
  Write-State -State "failed" -Message $Message
  $Alert = [ordered]@{
    schemaVersion = 1
    pending = $true
    status = "pending"
    createdAt = (Get-Date).ToString("o")
    source = "codex-app-server-pending-activation"
    incidentKey = "codex-app-server-pending-activation-failed"
    code = "PENDING_ACTIVATION_FAILED"
    message = $Message
    text = "[Codex automatic wake upgrade failed]`n$Message`nCodex Desktop was not terminated; inspect the local activation state."
  }
  [System.IO.File]::WriteAllText($AlertPath, (($Alert | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
  exit 1
}
