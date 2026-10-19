[CmdletBinding()]
param(
  [ValidateSet('Inspect','Restore')][string]$Mode = 'Inspect',
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPreparationSha256,
  [string]$TransactionDirectory,
  [string]$ExpectedPlanSha256,
  [string]$MaintenanceGatePath,
  [string]$ExpectedGateSha256,
  [switch]$OwnerWindowConfirmed
)
$ErrorActionPreference = 'Stop'
function Sha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$PreparationPath = Join-Path $PSScriptRoot 'PREPARATION.private.json'
if ((Sha $PreparationPath) -ine $ExpectedPreparationSha256) { throw 'Preparation hash changed' }
$Preparation = Get-Content -LiteralPath $PreparationPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($File in $Preparation.files) {
  if ([IO.Path]::IsPathRooted($File.path) -or ($File.path -split '[\/]') -contains '..') { throw 'Preparation relative path rejected' }
  $Path = Join-Path $PSScriptRoot $File.path
  if ((Sha $Path) -ine $File.sha256) { throw ('Preparation file changed: ' + $File.path) }
}
if ((Sha $Preparation.settingsPath) -ine $Preparation.settingsSha256 -or (Sha $Preparation.installManifestPath) -ine $Preparation.installManifestSha256) { throw 'Bound preparation input changed' }
. (Join-Path $PSScriptRoot 'tools\FileSet.Common.ps1')
. (Join-Path $PSScriptRoot 'tools\startup-task-transaction.ps1')
function FixtureRootIdentity([string]$Path) {
  $Full = Get-FullPath $Path
  Assert-NoReparse $Full
  return $Full
}
$Settings = Get-Content -LiteralPath $Preparation.settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Settings.mode -eq 'TempFixture') {
  if (-not $Preparation.testOnly -or -not (Test-Within $Settings.fixtureRoot ([IO.Path]::GetTempPath()))) { throw 'Fixture is outside its temporary owner scope' }
  $ShadowManifest = Read-FrozenJson $Preparation.installManifestPath $Preparation.installManifestSha256
  foreach ($Root in $ShadowManifest.roots.PSObject.Properties) {
    if (-not (Test-Within $Root.Value $Settings.fixtureRoot)) { throw 'Fixture root escapes its owner scope' }
  }
} elseif ($Settings.mode -ne 'ManualProduction' -or $Preparation.testOnly) { throw 'Unknown preparation mode' }
$Task = Get-StartupTaskPhase $Settings
if ($Mode -eq 'Inspect') {
  $PhaseManifest = Get-Content -LiteralPath $Settings.manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Matches = @($PhaseManifest.files | ForEach-Object {
    $Expected = if ($Task.phase -eq 'original') { $_.original.sha256 } else { $_.candidateSha256 }
    [pscustomobject]@{path=$_.targetPath;matches=(Get-Digest $_.targetPath) -eq $Expected}
  })
  [pscustomobject]@{mode='Inspect';taskPhase=$Task.phase;taskEnabled=$Task.enabled;fileCount=$Matches.Count;allFilesMatch=@($Matches | Where-Object {-not $_.matches}).Count -eq 0;productionWrites=0;processStops=0;ownerWindowStillRequired=$Settings.mode -eq 'ManualProduction'} | ConvertTo-Json -Compress
  if (@($Matches | Where-Object {-not $_.matches}).Count) { exit 1 }
  exit 0
}
if ($Settings.mode -eq 'ManualProduction' -and -not $OwnerWindowConfirmed) { throw 'An explicitly coordinated owner window is required' }
if (-not $TransactionDirectory -or $ExpectedPlanSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Original transaction directory and restore-plan SHA256 required' }
$Plan = Read-FrozenJson (Join-Path $TransactionDirectory 'restore-plan.json') $ExpectedPlanSha256
if ($Plan.manifestSha256 -ine $Preparation.installManifestSha256 -or ($Settings.mode -eq 'ManualProduction' -and $Plan.mode -ne 'LiveFiles') -or ($Settings.mode -eq 'TempFixture' -and $Plan.mode -ne 'Shadow')) { throw 'Original transaction does not belong to this preparation' }
Assert-Gate $Plan.mode $Plan.shadowRoot @($Plan.roots.PSObject.Properties | ForEach-Object Value) $Plan.manifestSha256 $MaintenanceGatePath $ExpectedGateSha256 -ForRestore
if ($Task.state -eq 'Running') { throw 'The startup task is still running' }
$null = Disable-StartupTask $Settings
& (Join-Path $PSScriptRoot 'tools\Restore-FileSet.ps1') -TransactionDirectory $TransactionDirectory -ExpectedPlanSha256 $ExpectedPlanSha256 -MaintenanceGatePath $MaintenanceGatePath -ExpectedGateSha256 $ExpectedGateSha256 | Out-Null
$null = Set-StartupTaskPhase $Settings 'original'
$Restored = Restore-StartupTaskEnabled $Settings 'original'
[pscustomobject]@{mode='Restore';taskPhase=$Restored.phase;taskEnabled=$Restored.enabled;filesRestored=$true;processStops=0;processStarts=0;businessHealth='not-tested'} | ConvertTo-Json -Compress
