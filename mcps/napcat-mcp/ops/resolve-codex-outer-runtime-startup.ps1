function Assert-CodexStartupPathWithoutReparsePoint {
  param([string]$Path)

  $CurrentPath = [System.IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($CurrentPath)) {
    $Item = Get-Item -LiteralPath $CurrentPath -Force -ErrorAction Stop
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "OUTER_STARTUP_REPARSE_POINT: $CurrentPath"
    }
    $ParentPath = [System.IO.Path]::GetDirectoryName($CurrentPath.TrimEnd('\', '/'))
    if ($ParentPath -eq $CurrentPath) { break }
    $CurrentPath = $ParentPath
  }
}

function Resolve-CodexOuterRuntimeStartup {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$DataRoot)

  $ResolvedDataRoot = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\', '/')
  $ConfigurationPath = Join-Path $ResolvedDataRoot "state\codex-outer-runtime-startup.json"
  $ConfigurationItem = $null
  try {
    $ConfigurationItem = Get-Item -LiteralPath $ConfigurationPath -Force -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException] {}
  if ($null -eq $ConfigurationItem) {
    return [pscustomobject]@{
      configurationPath = $ConfigurationPath
      configured = $false
      enabled = $false
      candidateRoot = $null
      innerManagedProfilePath = $null
      innerManagedProfileSha256 = $null
    }
  }
  if (-not (Test-Path -LiteralPath $ConfigurationPath -PathType Leaf)) {
    throw "OUTER_STARTUP_CONFIG_NOT_FILE: $ConfigurationPath"
  }
  Assert-CodexStartupPathWithoutReparsePoint -Path $ConfigurationPath
  try {
    $ConfigurationText = Get-Content -LiteralPath $ConfigurationPath -Raw -Encoding UTF8
    if (-not $ConfigurationText.TrimStart().StartsWith('{')) { throw "JSON object required" }
    $Configuration = $ConfigurationText | ConvertFrom-Json
  } catch {
    throw "OUTER_STARTUP_CONFIG_INVALID_JSON: $ConfigurationPath"
  }
  if ($Configuration -isnot [System.Management.Automation.PSCustomObject] -or
      ($Configuration.schemaVersion -isnot [int] -and $Configuration.schemaVersion -isnot [long]) -or
      $Configuration.schemaVersion -ne 1 -or $Configuration.enabled -isnot [bool] -or
      $Configuration.candidateRoot -isnot [string]) {
    throw "OUTER_STARTUP_CONFIG_INVALID_SCHEMA: $ConfigurationPath"
  }
  $CandidatePath = [string]$Configuration.candidateRoot
  if ($CandidatePath -notmatch '^[A-Za-z]:[\\/]' -and $CandidatePath -notmatch '^\\\\[^\\/]+[\\/][^\\/]+[\\/]') {
    throw "OUTER_STARTUP_CANDIDATE_NOT_ABSOLUTE: $CandidatePath"
  }
  if ($CandidatePath -match '^\\\\[?.][\\/]' -or $CandidatePath.Substring(2).Contains(':')) {
    throw "OUTER_STARTUP_CANDIDATE_PATH_INVALID: $CandidatePath"
  }
  $CandidatePath = [System.IO.Path]::GetFullPath($CandidatePath).TrimEnd('\', '/')
  if (-not $CandidatePath.StartsWith($ResolvedDataRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OUTER_STARTUP_CANDIDATE_OUTSIDE_DATA_ROOT: $CandidatePath"
  }
  if (-not (Test-Path -LiteralPath $CandidatePath -PathType Container)) {
    throw "OUTER_STARTUP_CANDIDATE_NOT_DIRECTORY: $CandidatePath"
  }
  Assert-CodexStartupPathWithoutReparsePoint -Path $CandidatePath
  $ProfilePath = $null
  $ProfileSha256 = $null
  $HasProfilePath = $Configuration.PSObject.Properties.Name -contains 'innerManagedProfilePath'
  $HasProfileSha256 = $Configuration.PSObject.Properties.Name -contains 'innerManagedProfileSha256'
  if ($HasProfilePath -or $HasProfileSha256) {
    if (-not $HasProfilePath -or -not $HasProfileSha256 -or
        $Configuration.innerManagedProfilePath -isnot [string] -or
        $Configuration.innerManagedProfileSha256 -isnot [string] -or
        $Configuration.innerManagedProfileSha256 -cnotmatch '^[a-f0-9]{64}$') {
      throw 'INNER_STARTUP_PROFILE_BINDING_REQUIRED'
    }
    $ProfilePath = [string]$Configuration.innerManagedProfilePath
    if ($ProfilePath -notmatch '^[A-Za-z]:[\\/]' -or $ProfilePath.Substring(2).Contains(':')) {
      throw 'INNER_STARTUP_PROFILE_PATH_INVALID'
    }
    $ProfilePath = [System.IO.Path]::GetFullPath($ProfilePath)
    $ExpectedStateRoot = Join-Path $ResolvedDataRoot 'state'
    if (-not $ProfilePath.StartsWith($ExpectedStateRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'INNER_STARTUP_PROFILE_OUTSIDE_STATE_ROOT'
    }
    if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) { throw 'INNER_STARTUP_PROFILE_NOT_FILE' }
    Assert-CodexStartupPathWithoutReparsePoint -Path $ProfilePath
    $ProfileItem = Get-Item -LiteralPath $ProfilePath -Force -ErrorAction Stop
    if ($ProfileItem.Length -gt 65536) { throw 'INNER_STARTUP_PROFILE_TOO_LARGE' }
    $ProfileSha256 = (Get-FileHash -LiteralPath $ProfilePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ProfileSha256 -cne $Configuration.innerManagedProfileSha256) { throw 'INNER_STARTUP_PROFILE_HASH_MISMATCH' }
  }
  return [pscustomobject]@{
    configurationPath = $ConfigurationPath
    configured = $true
    enabled = [bool]$Configuration.enabled
    candidateRoot = $CandidatePath
    innerManagedProfilePath = $ProfilePath
    innerManagedProfileSha256 = $ProfileSha256
  }
}

function Get-CodexInnerManagedStartupProfile {
  param([Parameter(Mandatory = $true)]$Startup, [Parameter(Mandatory = $true)][string]$DataRoot)

  if ([string]::IsNullOrWhiteSpace([string]$Startup.innerManagedProfilePath)) { return $null }
  $ProfileBytes = [System.IO.File]::ReadAllBytes([string]$Startup.innerManagedProfilePath)
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $Digest = ([System.BitConverter]::ToString($Hasher.ComputeHash($ProfileBytes))).Replace('-', '').ToLowerInvariant() }
  finally { $Hasher.Dispose() }
  if ($Digest -cne [string]$Startup.innerManagedProfileSha256) { throw 'INNER_STARTUP_PROFILE_HASH_MISMATCH' }
  $Profile = ([System.Text.Encoding]::UTF8.GetString($ProfileBytes)).TrimStart([char]0xFEFF) | ConvertFrom-Json
  if ($Profile.schemaVersion -ne 1 -or $Profile.mode -cne 'production' -or
      [string]$Profile.ownerId -cnotmatch '^[A-Za-z0-9._-]{1,128}$' -or
      [string]$Profile.nativeSourceId -cnotmatch '^[A-Za-z0-9._-]{1,128}$') {
    throw 'INNER_STARTUP_PROFILE_SCHEMA_INVALID'
  }
  $PortValues = @()
  foreach ($PortName in @('inner', 'downstream', 'control', 'upstream', 'probe')) {
    $PortValue = $Profile.ports.$PortName
    if (($PortValue -isnot [int] -and $PortValue -isnot [long]) -or $PortValue -lt 1 -or $PortValue -gt 65535) {
      throw 'INNER_STARTUP_PROFILE_PORTS_INVALID'
    }
    $PortValues += [int]$PortValue
  }
  if (@($PortValues | Select-Object -Unique).Count -ne 5 -or $Profile.innerPort -ne $Profile.ports.inner) {
    throw 'INNER_STARTUP_PROFILE_PORTS_INVALID'
  }
  $ExpectedStateRoot = Join-Path ([System.IO.Path]::GetFullPath($DataRoot)) 'state'
  foreach ($PathName in @('stateRoot', 'managedStatePath')) {
    $ProfilePath = [string]$Profile.$PathName
    if ($ProfilePath -notmatch '^[A-Za-z]:[\\/]' -or $ProfilePath.Substring(2).Contains(':') -or
        -not ([System.IO.Path]::GetFullPath($ProfilePath)).StartsWith($ExpectedStateRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'INNER_STARTUP_PROFILE_STATE_PATH_INVALID'
    }
  }
  $OwnStateRoot = [System.IO.Path]::GetFullPath([string]$Profile.stateRoot).TrimEnd('\', '/')
  if (-not ([System.IO.Path]::GetFullPath([string]$Profile.managedStatePath)).StartsWith($OwnStateRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'INNER_STARTUP_PROFILE_STATE_PATH_INVALID'
  }
  return $Profile
}
