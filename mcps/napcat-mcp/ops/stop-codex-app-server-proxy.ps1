[CmdletBinding()]
param(
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [ValidateRange(1, 120)][int]$TimeoutSeconds = 20
)

$ErrorActionPreference = "Stop"
$StateRoot = Join-Path $DataRoot "state"
$RuntimeStatePath = Join-Path $StateRoot "codex-app-server-proxy-runtime.json"
$StopFilePath = Join-Path $StateRoot "codex-app-server-proxy.stop"
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
[System.IO.File]::WriteAllText($StopFilePath, ((Get-Date).ToString("o") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

$PidValue = $null
if (Test-Path -LiteralPath $RuntimeStatePath) {
  try { $PidValue = [int](Get-Content -LiteralPath $RuntimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json).pid } catch { $PidValue = $null }
}
$Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
do {
  $Process = if ($null -ne $PidValue) { Get-Process -Id $PidValue -ErrorAction SilentlyContinue } else { $null }
  if ($null -eq $Process) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $Deadline)

$RemainingProcess = if ($null -ne $PidValue) { Get-Process -Id $PidValue -ErrorAction SilentlyContinue } else { $null }
[pscustomobject]@{
  stopped = ($null -eq $RemainingProcess)
  pid = $PidValue
  stopFilePath = $StopFilePath
} | ConvertTo-Json -Depth 6
