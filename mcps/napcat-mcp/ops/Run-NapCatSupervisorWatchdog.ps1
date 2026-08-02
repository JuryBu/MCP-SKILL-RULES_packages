[CmdletBinding()]
param(
  [ValidateRange(10, 300)][int]$IntervalSeconds = 30,
  [string]$DataRoot = $(if ($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT) { $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT } else { Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }),
  [string]$BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT
)

$ErrorActionPreference = "Stop"
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-napcat-supervisor.ps1"
$ProxyStartScript = Join-Path $PSScriptRoot "start-codex-app-server-proxy.ps1"
$ProxyFallbackPath = Join-Path $DataRoot "state\codex-app-server-proxy-fallback.json"
$WatchdogStatePath = Join-Path $DataRoot "supervisor-watchdog.json"
$WatchdogLogPath = Join-Path $DataRoot "supervisor-watchdog.jsonl"
$NormalizedDataRoot = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\').ToLowerInvariant()
$HashProvider = [System.Security.Cryptography.SHA256]::Create()
try {
  $HashBytes = $HashProvider.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($NormalizedDataRoot))
  $MutexSuffix = ([System.BitConverter]::ToString($HashBytes)).Replace("-", "").Substring(0, 16)
} finally {
  $HashProvider.Dispose()
}
$Mutex = New-Object System.Threading.Mutex($false, "Local\CodexNapCatSupervisorWatchdog-$MutexSuffix")
$OwnsMutex = $false
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-WatchdogRecord {
  param([string]$Status, [string]$Message)

  if ((Test-Path -LiteralPath $WatchdogLogPath) -and (Get-Item -LiteralPath $WatchdogLogPath).Length -gt 1048576) {
    Move-Item -LiteralPath $WatchdogLogPath -Destination "$WatchdogLogPath.previous" -Force
  }
  $Record = [ordered]@{
    at = (Get-Date).ToString("o")
    pid = $PID
    status = $Status
    message = $Message
  }
  $Line = ($Record | ConvertTo-Json -Compress -Depth 5)
  [System.IO.File]::AppendAllText($WatchdogLogPath, "$Line`n", $Utf8NoBom)
  [System.IO.File]::WriteAllText($WatchdogStatePath, (($Record | ConvertTo-Json -Depth 5) + "`n"), $Utf8NoBom)
}

function Apply-ProxyFallbackRequest {
  if (-not (Test-Path -LiteralPath $ProxyFallbackPath)) { return }
  try {
    $Fallback = Get-Content -LiteralPath $ProxyFallbackPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Fallback.pending -ne $true) { return }
    $CurrentValue = [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "User")
    $ExpectedValue = [string]$Fallback.expectedProxyUrl
    $Cleared = $false
    if (-not [string]::IsNullOrWhiteSpace($ExpectedValue) -and $CurrentValue -eq $ExpectedValue) {
      [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $null, "User")
      $Cleared = $true
    }
    $Fallback | Add-Member -NotePropertyName pending -NotePropertyValue $false -Force
    $Fallback | Add-Member -NotePropertyName handledAt -NotePropertyValue ((Get-Date).ToString("o")) -Force
    $Fallback | Add-Member -NotePropertyName previousUserValue -NotePropertyValue $CurrentValue -Force
    $Fallback | Add-Member -NotePropertyName userValueCleared -NotePropertyValue $Cleared -Force
    [System.IO.File]::WriteAllText($ProxyFallbackPath, (($Fallback | ConvertTo-Json -Depth 10) + "`n"), $Utf8NoBom)
    $FallbackMessage = if ($Cleared) { "Cleared CODEX_APP_SERVER_WS_URL for the next Codex launch." } else { "Fallback request recorded; user environment already differed." }
    Write-WatchdogRecord -Status "fallback" -Message $FallbackMessage
  } catch {
    Write-WatchdogRecord -Status "fallback_error" -Message $_.Exception.Message
  }
}

try {
  $OwnsMutex = $Mutex.WaitOne(0)
  if (-not $OwnsMutex) { exit 0 }
  if (-not (Test-Path -LiteralPath $StartScript)) {
    throw "NapCat supervisor start script is missing: $StartScript"
  }
  if (-not (Test-Path -LiteralPath $ProxyStartScript)) {
    throw "Codex App Server proxy start script is missing: $ProxyStartScript"
  }
  if (-not (Test-Path -LiteralPath $NapCatMcpRoot)) {
    throw "NapCat MCP root is missing: $NapCatMcpRoot"
  }

  New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
  while ($true) {
    try {
      & $ProxyStartScript -DataRoot $DataRoot | Out-Null
      Apply-ProxyFallbackRequest
      $StartArguments = @{ DataRoot = $DataRoot }
      if (-not [string]::IsNullOrWhiteSpace($BrokerRoot)) {
        $StartArguments.BrokerRoot = $BrokerRoot
      }
      & $StartScript @StartArguments | Out-Null
      Write-WatchdogRecord -Status "healthy" -Message "Supervisor verified."
    } catch {
      Write-WatchdogRecord -Status "retrying" -Message $_.Exception.Message
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  if ($OwnsMutex) { $Mutex.ReleaseMutex() }
  $Mutex.Dispose()
}
