[CmdletBinding()]
param(
  [ValidateRange(1, 120)][int]$WaitSeconds = 15,
  [string]$DataRoot = "",
  [string]$StopMarkerProofPath = "",
  [string]$StopMarkerAttemptId = "",
  [string]$StopMarkerOperationId = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$ResolverBrokerRoot = if (Get-Variable -Name BrokerRoot -ErrorAction SilentlyContinue) { [string]$BrokerRoot } else { "" }
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $ResolverBrokerRoot
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$StateDirectory = Join-Path $DataRoot "state"
$RuntimeStatePath = Join-Path $StateDirectory "task-router-runtime.json"
$StopFilePath = Join-Path $StateDirectory "task-router.stop"
$RunnerPath = Join-Path $NapCatMcpRoot "src\task-router-runner.mjs"

New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OwnedMarker = $null
$ProofRequested = -not [string]::IsNullOrWhiteSpace($StopMarkerProofPath)
if ($ProofRequested -or $StopMarkerAttemptId -or $StopMarkerOperationId) {
  if (-not $ProofRequested -or -not [IO.Path]::IsPathRooted($StopMarkerProofPath) -or -not $StopMarkerAttemptId -or -not $StopMarkerOperationId) { throw 'INVALID_OWNED_STOP_ARGUMENTS' }
  if ((Get-Item -LiteralPath $StopMarkerProofPath -ErrorAction Stop).Length -gt 65536) { throw 'STOP_MARKER_PROOF_TOO_LARGE' }
  . (Join-Path $PSScriptRoot 'owned-stop-marker.ps1')
  $ProofJson = [IO.File]::ReadAllText($StopMarkerProofPath)
  $OwnedMarker = Assert-OwnedStopMarkerProof -ProofJson $ProofJson -Path $StopFilePath -Component 'router' -AttemptId $StopMarkerAttemptId -OperationId $StopMarkerOperationId
} else {
  [System.IO.File]::WriteAllText($StopFilePath, ((Get-Date).ToUniversalTime().ToString("o") + "`n"), $Utf8NoBom)
}

$PidValue = 0
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try {
    $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $PidValue = [int]$RuntimeState.pid
  } catch { }
}
$Deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
  $Process = if ($PidValue -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId = $PidValue" -ErrorAction SilentlyContinue } else { $null }
  $CommandLine = if ($null -ne $Process) { [string]$Process.CommandLine } else { "" }
  $Alive = $null -ne $Process -and
    $CommandLine.IndexOf("task-router-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $CommandLine.IndexOf($RuntimeStatePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $CommandLine.IndexOf($StopFilePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  if (-not $Alive) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $Deadline)

$OutputPid = if ($PidValue -gt 0) { $PidValue } else { $null }
$OutputNote = if ($Alive) { "Router is still shutting down; no force kill was used" } else { "Task router stopped" }
if ($ProofRequested) { $OwnedMarker = Assert-OwnedStopMarkerProof -ProofJson $ProofJson -Path $StopFilePath -Component 'router' -AttemptId $StopMarkerAttemptId -OperationId $StopMarkerOperationId }
$Output = [pscustomobject]@{
  stopRequested = $true
  stopped = (-not $Alive)
  pid = $OutputPid
  stopFilePath = $StopFilePath
  note = $OutputNote
}
if ($ProofRequested) { $Output | Add-Member -NotePropertyName ownedStopMarker -NotePropertyValue $OwnedMarker }
$Output | ConvertTo-Json -Depth 6
