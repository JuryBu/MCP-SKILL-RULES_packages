[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ManifestPath,
  [Parameter(Mandatory)][string]$ManifestSha256,
  [ValidateSet('Inspect','Update','Rollback')][string]$Action = 'Inspect'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function PlainFile([string]$Value) {
  if (-not [IO.Path]::IsPathRooted($Value)) { throw 'ABSOLUTE_PATH_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Value)
  $Item = Get-Item -LiteralPath $Full -Force
  if ($Item.PSIsContainer -or $Item.Length -gt 1048576) { throw 'PLAIN_BOUNDED_FILE_REQUIRED' }
  $Current = $Full
  while ($Current) {
    $Part = Get-Item -LiteralPath $Current -Force
    if ($Part.LinkType -or ($Part.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'LINK_FORBIDDEN' }
    $Current = Split-Path -Parent $Current
  }
  return $Full
}
function Sha([string]$Value) { (Get-FileHash -LiteralPath (PlainFile $Value) -Algorithm SHA256).Hash.ToLowerInvariant() }
if ((Sha $ManifestPath) -cne $ManifestSha256) { throw 'MANIFEST_CHANGED' }
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Manifest.schemaVersion -ne 1 -or $Manifest.scope -cne 'next-startup-files-only' -or $Manifest.serviceActions -ne 0 -or $Manifest.stateWrites -ne 0) { throw 'STARTUP_ONLY_MANIFEST_REQUIRED' }
$Allowed = @('src/inner-runtime-profile.mjs','src/inner-startup-residual-recovery.mjs','ops/recover-inner-startup.mjs','ops/start-codex-app-server-proxy.ps1','ops/start-codex-model-stream-proxy.ps1','ops/get-codex-model-stream-proxy-status.ps1')
$Root = Split-Path -Parent ([IO.Path]::GetFullPath($ManifestPath))
$Files = @($Manifest.files)
if ($Files.Count -gt ($Allowed.Count + 1) -or @($Files.name | Select-Object -Unique).Count -ne $Files.Count) { throw 'EXACT_STARTUP_FILES_REQUIRED' }
$Changes = @()
$Lock = $null
try {
  if ($Manifest.desktopLauncherPath) {
    $Gate = Join-Path (Split-Path -Parent (PlainFile $Manifest.desktopLauncherPath)) 'desktop-startup.lock'
    $Lock = [IO.File]::Open($Gate,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  }
  foreach ($File in $Files) {
    if ($File.name -ceq 'desktop-launcher.ps1') { $Expected = $Manifest.desktopLauncherPath }
    elseif ($Allowed -ccontains [string]$File.name) { $Expected = Join-Path $Manifest.installedRoot $File.name }
    else { throw 'STARTUP_FILE_OUTSIDE_SCOPE' }
    if ([IO.Path]::GetFullPath($File.target) -ine [IO.Path]::GetFullPath($Expected)) { throw 'STARTUP_TARGET_MISMATCH' }
    if ($File.original -cnotmatch '^\d+\.original$' -or $File.candidate -cnotmatch '^\d+\.candidate$') { throw 'PACKAGE_FILE_INVALID' }
    $Original = Join-Path $Root $File.original
    $Candidate = Join-Path $Root $File.candidate
    if ((Sha $Original) -cne $File.beforeSha256 -or (Sha $Candidate) -cne $File.afterSha256) { throw 'PACKAGE_BYTES_CHANGED' }
    $ExpectedSha = if ($Action -eq 'Rollback') { $File.afterSha256 } else { $File.beforeSha256 }
    if ((Sha $File.target) -cne $ExpectedSha) { throw ('STARTUP_TARGET_CHANGED: '+$File.name) }
  }
  if ($Action -ne 'Inspect') {
    foreach ($File in $Files) {
      $ExpectedSha = if ($Action -eq 'Rollback') { $File.afterSha256 } else { $File.beforeSha256 }
      $NextSha = if ($Action -eq 'Rollback') { $File.beforeSha256 } else { $File.afterSha256 }
      $Payload = Join-Path $Root $(if ($Action -eq 'Rollback') { $File.original } else { $File.candidate })
      $Temporary = $File.target + '.startup-' + [Guid]::NewGuid().ToString('N')
      try {
        [IO.File]::Copy($Payload,$Temporary,$false)
        if ((Sha $File.target) -cne $ExpectedSha -or (Sha $Temporary) -cne $NextSha) { throw 'STARTUP_CAS_CHANGED' }
        [IO.File]::Replace($Temporary,$File.target,[NullString]::Value)
        $Changes += [pscustomobject]@{file=$File;installedSha=$NextSha;originalSha=$ExpectedSha}
        if ((Sha $File.target) -cne $NextSha) { throw 'STARTUP_WRITE_VERIFY_FAILED' }
      } finally {
        if (Test-Path -LiteralPath $Temporary) { [IO.File]::Delete($Temporary) }
      }
    }
  }
  [pscustomobject]@{status='STARTUP_FILES_VERIFIED';action=$Action;files=$Files.Count;targetWrites=$Changes.Count;serviceActions=0;stateWrites=0} | ConvertTo-Json -Compress
} catch {
  for ($Index=$Changes.Count-1; $Index -ge 0; $Index--) {
    $Change = $Changes[$Index]
    if ((Sha $Change.file.target) -cne $Change.installedSha) { throw 'STARTUP_ROLLBACK_TARGET_CHANGED_KEEP_BACKUP' }
    $Previous = Join-Path $Root $(if ($Action -eq 'Rollback') { $Change.file.candidate } else { $Change.file.original })
    $Temporary = $Change.file.target + '.startup-restore-' + [Guid]::NewGuid().ToString('N')
    [IO.File]::Copy($Previous,$Temporary,$false)
    [IO.File]::Replace($Temporary,$Change.file.target,[NullString]::Value)
    if ((Sha $Change.file.target) -cne $Change.originalSha) { throw 'STARTUP_ROLLBACK_VERIFY_FAILED' }
  }
  throw
} finally {
  if ($null -ne $Lock) { $Lock.Dispose() }
}
