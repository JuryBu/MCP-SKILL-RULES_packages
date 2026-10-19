[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PreparationDirectory,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedPreparationSha256,
  [Parameter(Mandatory)][string]$TransactionDirectory,
  [ValidateSet('Inspect','Apply')][string]$Mode = 'Inspect',
  [string]$MaintenanceGatePath,
  [string]$ExpectedGateSha256,
  [switch]$OwnerWindowConfirmed
)
$ErrorActionPreference = 'Stop'
function Sha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
$PreparationPath = Join-Path $PreparationDirectory 'PREPARATION.private.json'
if ((Sha $PreparationPath) -ine $ExpectedPreparationSha256) { throw 'Preparation hash changed' }
$Preparation = Get-Content -LiteralPath $PreparationPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($File in $Preparation.files) {
  if ([IO.Path]::IsPathRooted($File.path) -or ($File.path -split '[/\\]') -contains '..') { throw 'Preparation relative path rejected' }
  if ((Sha (Join-Path $PreparationDirectory $File.path)) -ine $File.sha256) { throw 'Prepared input changed' }
}
if ((Sha $Preparation.settingsPath) -ine $Preparation.settingsSha256 -or (Sha $Preparation.installManifestPath) -ine $Preparation.installManifestSha256) { throw 'Bound preparation input changed' }
. (Join-Path $PreparationDirectory 'tools\FileSet.Common.ps1')
. (Join-Path $PreparationDirectory 'tools\startup-task-transaction.ps1')
function FixtureRootIdentity([string]$Path) {
  $Full = Get-FullPath $Path
  Assert-NoReparse $Full
  return $Full
}
Assert-NoReparse $PreparationDirectory
Assert-NoReparse $TransactionDirectory
$Settings = Get-Content -LiteralPath $Preparation.settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Manifest = Read-FrozenJson $Preparation.installManifestPath $Preparation.installManifestSha256
$FileMode = 'LiveFiles'
$ShadowRoot = $null
if ($Settings.mode -eq 'TempFixture') {
  if (-not $Preparation.testOnly -or -not (Test-Within $Settings.fixtureRoot ([IO.Path]::GetTempPath()))) { throw 'Fixture is outside its temporary owner scope' }
  foreach ($Root in $Manifest.roots.PSObject.Properties) {
    if (-not (Test-Within $Root.Value $Settings.fixtureRoot)) { throw 'Fixture target escapes its owner scope' }
  }
  $FileMode = 'Shadow'
  $ShadowRoot = $Settings.fixtureRoot
} elseif ($Settings.mode -ne 'ManualProduction' -or $Preparation.testOnly) { throw 'Unknown preparation mode' }
$Before = & $Preparation.recoveryEntryPath -Mode Inspect -ExpectedPreparationSha256 $ExpectedPreparationSha256 | ConvertFrom-Json
if (-not $Before.allFilesMatch -or $Before.taskPhase -ne 'original') { throw 'Original files and task do not agree' }
$Arguments = @{ManifestPath=$Preparation.installManifestPath;ExpectedManifestSha256=$Preparation.installManifestSha256;CandidateRoot=$PreparationDirectory;TransactionDirectory=$TransactionDirectory;Mode=$FileMode;ShadowRoot=$ShadowRoot;MaintenanceGatePath=$MaintenanceGatePath;ExpectedGateSha256=$ExpectedGateSha256}
$Validated = & (Join-Path $PreparationDirectory 'tools\Apply-FileSet.ps1') @Arguments -ValidateOnly
if ($Validated.status -ne 'validated-no-writes' -or $Validated.files -ne $Preparation.fileWriteCount) { throw 'Prepared file set validation failed' }
if ($Mode -eq 'Inspect') {
  [pscustomobject]@{mode='Inspect';status='validated-no-writes';fileCount=$Before.fileCount;changedFiles=$Validated.files;taskPhase=$Before.taskPhase;taskEnabled=$Before.taskEnabled;productionWrites=0;processStops=0;ownerWindowStillRequired=$Settings.mode -eq 'ManualProduction'} | ConvertTo-Json -Compress
  exit 0
}
if ($Settings.mode -eq 'ManualProduction' -and -not $OwnerWindowConfirmed) { throw 'An explicitly coordinated owner window is required' }
Assert-Gate $FileMode $ShadowRoot @($Manifest.roots.PSObject.Properties | ForEach-Object Value) $Preparation.installManifestSha256 $MaintenanceGatePath $ExpectedGateSha256
$OriginalTask = Get-StartupTaskPhase $Settings
if ($OriginalTask.phase -ne 'original' -or $OriginalTask.state -eq 'Running') { throw 'The original startup task is not quiescent' }
$Disabled = $false
try {
  $null = Disable-StartupTask $Settings
  $Disabled = $true
  $ApplyOutput = & (Join-Path $PreparationDirectory 'tools\Apply-FileSet.ps1') @Arguments
  $Applied = @($ApplyOutput | Where-Object { $_ -isnot [string] -and $_.PSObject.Properties.Name -contains 'status' })
  if ($Applied.Count -ne 1 -or $Applied[0].status -ne 'applied-files-only') { throw 'The prepared file transaction did not complete' }
  $null = Set-StartupTaskPhase $Settings 'candidate'
  $null = Restore-StartupTaskEnabled $Settings 'candidate'
  $After = & $Preparation.recoveryEntryPath -Mode Inspect -ExpectedPreparationSha256 $ExpectedPreparationSha256 | ConvertFrom-Json
  if (-not $After.allFilesMatch -or $After.taskPhase -ne 'candidate' -or $After.taskEnabled -ne $Before.taskEnabled) { throw 'Installed files and startup task verification failed' }
  [pscustomobject]@{mode='Apply';status='applied-files-and-task';files=$Applied[0].files;closureFiles=$After.fileCount;restorePlanSha256=$Applied[0].restorePlanSha256;transactionDirectory=$TransactionDirectory;taskPhase=$After.taskPhase;taskEnabled=$After.taskEnabled;processStops=0;processStarts=0;businessHealth='not-tested'} | ConvertTo-Json -Compress
} catch {
  $OriginalError = $_.Exception.Message
  if ($Disabled) {
    try {
      $PlanPath = Join-Path $TransactionDirectory 'restore-plan.json'
      if (Test-Path -LiteralPath $PlanPath -PathType Leaf) {
        $RestoreArguments = @{Mode='Restore';ExpectedPreparationSha256=$ExpectedPreparationSha256;TransactionDirectory=$TransactionDirectory;ExpectedPlanSha256=(Sha $PlanPath);MaintenanceGatePath=$MaintenanceGatePath;ExpectedGateSha256=$ExpectedGateSha256;OwnerWindowConfirmed=$OwnerWindowConfirmed}
        $null = & $Preparation.recoveryEntryPath @RestoreArguments
      } else {
        $null = Restore-StartupTaskEnabled $Settings 'original'
      }
    } catch { throw ('INSTALL_FAILED: ' + $OriginalError + '; INDEPENDENT_RECOVERY_INCOMPLETE: ' + $_.Exception.Message) }
  }
  throw ('INSTALL_FAILED_RESTORED: ' + $OriginalError)
}
