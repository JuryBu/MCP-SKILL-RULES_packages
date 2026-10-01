[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][ValidatePattern("^[a-fA-F0-9]{64}$")][string]$RequestSha256
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$RequestPath = [System.IO.Path]::GetFullPath($RequestPath)
$LogPath = Join-Path ([System.IO.Path]::GetDirectoryName($RequestPath)) "child.log"
$RequestStream = $null
$ScriptStream = $null
$TranscriptStarted = $false
$ChildExitCode = 1

function Get-StreamSha256 {
  param([System.IO.Stream]$Stream)
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $Hash = [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace("-", "").ToLowerInvariant()
    $Stream.Position = 0
    return $Hash
  } finally {
    $Hasher.Dispose()
  }
}

function Convert-ParameterValue {
  param([AllowNull()]$Value)
  if ($Value -is [pscustomobject]) {
    $Mapping = @{}
    foreach ($Property in $Value.PSObject.Properties) { $Mapping[$Property.Name] = Convert-ParameterValue -Value $Property.Value }
    return $Mapping
  }
  if ($Value -is [System.Array]) {
    $Items = @()
    foreach ($Item in $Value) { $Items += ,(Convert-ParameterValue -Value $Item) }
    return ,$Items
  }
  return $Value
}

try {
  Start-Transcript -LiteralPath $LogPath -NoClobber | Out-Null
  $TranscriptStarted = $true
  Write-Output ("MAINTENANCE_CHILD_STARTED pid=" + $PID + " version=" + $PSVersionTable.PSVersion.ToString())
  $RequestStream = [System.IO.File]::Open($RequestPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  if ((Get-StreamSha256 -Stream $RequestStream) -ne $RequestSha256) { throw "Request SHA256 mismatch." }
  $Reader = New-Object System.IO.StreamReader($RequestStream, $Utf8NoBom, $true, 1024, $true)
  try { $Request = ConvertFrom-Json -InputObject $Reader.ReadToEnd() } finally { $Reader.Dispose() }
  if ($Request.schemaVersion -ne 1 -or $Request.parameters -isnot [pscustomobject]) { throw "Unsupported maintenance request schema." }
  $RequestedScriptPath = [string]$Request.scriptPath
  if (-not [System.IO.Path]::IsPathRooted($RequestedScriptPath) -or [System.IO.Path]::GetExtension($RequestedScriptPath) -ne ".ps1") { throw "Request scriptPath must be an absolute .ps1 path." }
  if ([string]$Request.scriptSha256 -notmatch "^[a-fA-F0-9]{64}$") { throw "Request scriptSha256 is invalid." }
  $ScriptStream = [System.IO.File]::Open($RequestedScriptPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  if ((Get-StreamSha256 -Stream $ScriptStream) -ne [string]$Request.scriptSha256) { throw "Script SHA256 mismatch." }
  if (-not [System.IO.Path]::IsPathRooted([string]$Request.workingDirectory)) { throw "Request workingDirectory must be an absolute path." }
  Set-Location -LiteralPath ([string]$Request.workingDirectory)
  [System.Environment]::CurrentDirectory = [string]$Request.workingDirectory
  $Parameters = Convert-ParameterValue -Value $Request.parameters
  $global:LASTEXITCODE = 0
  & $RequestedScriptPath @Parameters | Out-Default
  $ChildExitCode = [int]$global:LASTEXITCODE
  Write-Output ("MAINTENANCE_SCRIPT_RETURNED exitCode=" + $ChildExitCode)
} catch {
  $ChildExitCode = 1
  if ($TranscriptStarted) {
    Write-Output ("MAINTENANCE_SCRIPT_FAILED errorId=" + $_.FullyQualifiedErrorId)
    Write-Error -ErrorRecord $_ -ErrorAction Continue
  } else {
    [System.IO.File]::AppendAllText($LogPath, (($_ | Out-String) + "`n"), $Utf8NoBom)
  }
} finally {
  if ($null -ne $ScriptStream) { $ScriptStream.Dispose() }
  if ($null -ne $RequestStream) { $RequestStream.Dispose() }
  if ($TranscriptStarted) { Stop-Transcript | Out-Null }
}

exit $ChildExitCode
