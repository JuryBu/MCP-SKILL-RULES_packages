# Verify package delivery files. plans and manifest are excluded from self-validation.

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $PackageRoot "manifest.json"

if (-not (Test-Path -LiteralPath $ManifestPath)) {
  throw "Package manifest.json is missing."
}

$Manifest = ([System.IO.File]::ReadAllText($ManifestPath)) | ConvertFrom-Json
if ([int]$Manifest.schema_version -ne 2) {
  throw "Unsupported manifest schema_version=$($Manifest.schema_version)."
}

function Get-PortableFileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

$Declared = @{}
foreach ($Property in $Manifest.files.PSObject.Properties) {
  $Declared[$Property.Name] = $Property.Value
}

$Actual = @{}
Get-ChildItem -LiteralPath $PackageRoot -Recurse -File | ForEach-Object {
  $Relative = $_.FullName.Substring($PackageRoot.Length + 1).Replace("\", "/")
  if ($Relative -ne "manifest.json" -and -not $Relative.StartsWith("plans/")) {
    $Actual[$Relative] = $_.FullName
  }
}

$Missing = @($Declared.Keys | Where-Object { -not $Actual.ContainsKey($_) } | Sort-Object)
$Unexpected = @($Actual.Keys | Where-Object { -not $Declared.ContainsKey($_) } | Sort-Object)
if ($Missing.Count -gt 0 -or $Unexpected.Count -gt 0) {
  throw "Package file set mismatch. Missing: $($Missing -join ', '); unexpected: $($Unexpected -join ', ')."
}

foreach ($Relative in ($Declared.Keys | Sort-Object)) {
  $File = Get-Item -LiteralPath $Actual[$Relative]
  $Expected = $Declared[$Relative]
  $ActualHash = Get-PortableFileSha256 -Path $File.FullName
  if ([long]$File.Length -ne [long]$Expected.bytes -or $ActualHash -ne [string]$Expected.sha256) {
    throw "File verification failed: $Relative"
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($Property in $Manifest.zip_metadata.PSObject.Properties) {
  $Relative = $Property.Name
  $ArchivePath = Join-Path $PackageRoot $Relative
  $Archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    if ($Archive.Entries.Count -ne [int]$Property.Value.entries) {
      throw "ZIP entry count mismatch: $Relative"
    }
  } finally {
    $Archive.Dispose()
  }
}

Write-Host "Package verification passed: $($Declared.Count) delivery files; SHA256 and ZIP metadata match."
