[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ScriptPath,
  [Parameter(Mandatory = $true)][ValidatePattern("^[a-fA-F0-9]{64}$")][string]$ScriptSha256,
  [string]$ParametersPath = "",
  [string]$RunDirectory = "",
  [ValidateRange(1, 2147483647)][int]$TimeoutMilliseconds = 30000
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$StageId = [Guid]::NewGuid().ToString("N")
if ([string]::IsNullOrWhiteSpace($RunDirectory)) {
  $RunDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("maintenance-powershell-" + $StageId)
}
$RunDirectory = [System.IO.Path]::GetFullPath($RunDirectory)
if (Test-Path -LiteralPath $RunDirectory) { throw "RunDirectory must not already exist: $RunDirectory" }
[System.IO.Directory]::CreateDirectory($RunDirectory) | Out-Null
$RequestPath = Join-Path $RunDirectory "request.json"
$LogPath = Join-Path $RunDirectory "child.log"
$LauncherLogPath = Join-Path $RunDirectory "launcher.log"
$ResultPath = Join-Path $RunDirectory "stage-result.json"
$StartedAt = [DateTime]::UtcNow
$Clock = [System.Diagnostics.Stopwatch]::StartNew()
$Child = $null
$LauncherExitCode = 1
$Result = [ordered]@{
  schemaVersion = 1
  stageId = $StageId
  state = "starting"
  completed = $false
  processSucceeded = $false
  childExitCode = $null
  launcherExitCode = $null
  timedOut = $false
  childPid = $null
  childCreatedAt = $null
  startedAt = $StartedAt.ToString("o")
  observedAt = $StartedAt.ToString("o")
  elapsedMs = 0
  powershellPath = $null
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  workingDirectory = $null
  scriptPath = $ScriptPath
  scriptSha256 = $ScriptSha256.ToLowerInvariant()
  requestPath = $RequestPath
  requestSha256 = $null
  logPath = $LogPath
  launcherLogPath = $LauncherLogPath
  resultPath = $ResultPath
  error = $null
}

function Save-StageResult {
  $Result.observedAt = [DateTime]::UtcNow.ToString("o")
  $Result.elapsedMs = $Clock.ElapsedMilliseconds
  $TemporaryPath = $ResultPath + ".tmp"
  [System.IO.File]::WriteAllText($TemporaryPath, (($Result | ConvertTo-Json -Depth 20) + "`n"), $Utf8NoBom)
  if ([System.IO.File]::Exists($ResultPath)) {
    [System.IO.File]::Replace($TemporaryPath, $ResultPath, [NullString]::Value)
  } else {
    [System.IO.File]::Move($TemporaryPath, $ResultPath)
  }
}

function Write-LauncherLog {
  param([string]$Message)
  [System.IO.File]::AppendAllText($LauncherLogPath, ([DateTime]::UtcNow.ToString("o") + " " + $Message + "`n"), $Utf8NoBom)
}

function Quote-ProcessArgument {
  param([string]$Value)
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

try {
  Save-StageResult
  Write-LauncherLog -Message "Stage created; only the child PowerShell exit is observed."
  $ScriptItem = Get-Item -LiteralPath $ScriptPath
  if ($ScriptItem.PSIsContainer -or $ScriptItem.Extension -ne ".ps1") { throw "ScriptPath must be a .ps1 file." }
  $Result.scriptPath = $ScriptItem.FullName
  $ActualHash = (Get-FileHash -LiteralPath $ScriptItem.FullName -Algorithm SHA256).Hash
  if ($ActualHash -ne $ScriptSha256) { throw "Script SHA256 mismatch." }
  $Parameters = [pscustomobject]@{}
  if (-not [string]::IsNullOrWhiteSpace($ParametersPath)) {
    $ParameterJson = [System.IO.File]::ReadAllText((Get-Item -LiteralPath $ParametersPath).FullName, $Utf8NoBom)
    if (-not $ParameterJson.TrimStart().StartsWith("{")) { throw "ParametersPath must contain a JSON object." }
    $Parameters = ConvertFrom-Json -InputObject $ParameterJson
    if ($null -eq $Parameters -or $Parameters -isnot [pscustomobject]) { throw "ParametersPath must contain a JSON object." }
  }
  $PowerShellName = if ($PSVersionTable.PSEdition -eq "Core") { "pwsh.exe" } else { "powershell.exe" }
  $PowerShellPath = Join-Path $PSHOME $PowerShellName
  if (-not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf)) { throw "This launcher requires Windows PowerShell or PowerShell on Windows." }
  $Result.powershellPath = $PowerShellPath
  $WorkingDirectory = [System.Environment]::CurrentDirectory
  $Result.workingDirectory = $WorkingDirectory
  $ChildScriptPath = Join-Path $PSScriptRoot "maintenance-powershell-child.ps1"
  if (-not (Test-Path -LiteralPath $ChildScriptPath -PathType Leaf)) { throw "Child launcher script is missing." }
  $Request = [ordered]@{
    schemaVersion = 1
    stageId = $StageId
    scriptPath = $ScriptItem.FullName
    scriptSha256 = $ScriptSha256.ToLowerInvariant()
    workingDirectory = $WorkingDirectory
    parameters = $Parameters
  }
  [System.IO.File]::WriteAllText($RequestPath, (($Request | ConvertTo-Json -Depth 50) + "`n"), $Utf8NoBom)
  [System.IO.File]::SetAttributes($RequestPath, [System.IO.FileAttributes]::ReadOnly)
  $RequestHash = (Get-FileHash -LiteralPath $RequestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $Result.requestSha256 = $RequestHash
  Save-StageResult
  $ArgumentLine = (@("-NoLogo", "-NoProfile", "-NonInteractive", "-File", $ChildScriptPath, "-RequestPath", $RequestPath, "-RequestSha256", $RequestHash) | ForEach-Object { Quote-ProcessArgument -Value $_ }) -join " "
  $Child = Start-Process -FilePath $PowerShellPath -ArgumentList $ArgumentLine -WindowStyle Hidden -PassThru
  $Result.childPid = $Child.Id
  $ProcessHandle = $Child.Handle
  $Result.childCreatedAt = $Child.StartTime.ToUniversalTime().ToString("o")
  $Result.state = "running"
  Save-StageResult
  Write-LauncherLog -Message ("Child started: pid=" + $Result.childPid + "; createdAt=" + $Result.childCreatedAt)
  if ($Child.WaitForExit($TimeoutMilliseconds)) {
    $Result.childExitCode = $Child.ExitCode
    $Result.completed = $true
    $Result.processSucceeded = $Child.ExitCode -eq 0
    $Result.state = if ($Result.processSucceeded) { "completed" } else { "failed" }
    $LauncherExitCode = $Child.ExitCode
    Write-LauncherLog -Message ("Child exited: exitCode=" + $Result.childExitCode)
  } else {
    $Result.state = "unknown"
    $Result.timedOut = $true
    $Result.error = "Child exit was not observed within the timeout; no process was stopped or retried."
    $LauncherExitCode = 124
    Write-LauncherLog -Message $Result.error
  }
} catch {
  $Result.error = $_.Exception.Message
  $Result.state = if ($null -eq $Child) { "failed" } else { "unknown" }
  $LauncherExitCode = if ($null -eq $Child) { 1 } else { 125 }
  Write-LauncherLog -Message ("Launcher error: " + ($_ | Out-String))
} finally {
  $Result.launcherExitCode = $LauncherExitCode
  Save-StageResult
  if ($null -ne $Child) { $Child.Dispose() }
}

$Result | ConvertTo-Json -Depth 20
exit $LauncherExitCode
