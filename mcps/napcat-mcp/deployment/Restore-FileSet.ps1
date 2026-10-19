[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TransactionDirectory,
  [Parameter(Mandatory)][string]$ExpectedPlanSha256,
  [string]$MaintenanceGatePath,
  [string]$ExpectedGateSha256
)
. (Join-Path $PSScriptRoot 'FileSet.Common.ps1')
$TransactionDirectory = Get-FullPath $TransactionDirectory
Assert-NoReparse $TransactionDirectory
$plan = Read-FrozenJson (Join-Path $TransactionDirectory 'restore-plan.json') $ExpectedPlanSha256
if ($plan.schemaVersion -ne 1 -or $plan.mode -notin @('Shadow','LiveFiles')) { throw 'Unknown restore plan' }
if ((Get-FullPath $plan.transactionDirectory) -ine $TransactionDirectory) { throw 'Restore transaction path mismatch' }
$manifest = Read-FrozenJson (Resolve-Child $TransactionDirectory $plan.manifestSnapshot) $plan.manifestSha256
if ($manifest.schemaVersion -ne 1 -or $manifest.status -ne 'frozen' -or $manifest.candidateId -cne $plan.candidateId -or @($manifest.files).Count -ne @($plan.files).Count -or @($manifest.roots.PSObject.Properties).Count -ne @($plan.roots.PSObject.Properties).Count) { throw 'Restore manifest binding mismatch' }
foreach ($root in @($manifest.roots.PSObject.Properties)) {
  $boundRoot = @($plan.roots.PSObject.Properties | Where-Object Name -CEQ $root.Name)
  if ($boundRoot.Count -ne 1 -or (Get-FullPath $boundRoot[0].Value) -ine (Get-FullPath $root.Value)) { throw 'Restore manifest root mismatch' }
}
if ($plan.mode -eq 'LiveFiles' -and ((Get-FullPath $MaintenanceGatePath) -ine (Get-FullPath $plan.maintenanceGatePath) -or $ExpectedGateSha256 -ine $plan.maintenanceGateSha256)) { throw 'Restore gate differs from original plan' }
$roots = @($plan.roots.PSObject.Properties | ForEach-Object { Get-FullPath ([string]$_.Value) })
Assert-Gate $plan.mode $plan.shadowRoot $roots $plan.manifestSha256 $MaintenanceGatePath $ExpectedGateSha256 -ForRestore
if ($plan.mode -eq 'Shadow' -and -not (Test-Within $TransactionDirectory $plan.shadowRoot)) { throw 'Shadow restore transaction outside ShadowRoot' }
$mutex = Get-RootMutex $roots
$ownsMutex = $false
try {
  $ownsMutex = Enter-RootMutex $mutex
  if (-not $ownsMutex) { throw 'Another file-set operation owns these exact roots' }
  $destinations = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in @($plan.files)) {
    $boundFile = @($manifest.files | Where-Object { $_.root -ceq $entry.root -and $_.path -ceq $entry.path })
    if ($boundFile.Count -ne 1 -or $boundFile[0].sha256 -ine $entry.sha256 -or $boundFile[0].beforeSha256 -ine $entry.beforeSha256) { throw 'Restore manifest file mismatch' }
    $rootProperty = @($plan.roots.PSObject.Properties | Where-Object Name -CEQ $entry.root)
    if ($rootProperty.Count -ne 1) { throw 'Unknown restore target root' }
    $target = Resolve-Child ([string]$rootProperty[0].Value) $entry.path
    if ($target -ne $entry.target -or -not $destinations.Add($target)) { throw 'Duplicate or altered restore target' }
    if ($null -ne $entry.beforeSha256) {
      $backup = Resolve-Child $TransactionDirectory $entry.backup
      if ((Get-Digest $backup) -ne $entry.beforeSha256) { throw "Corrupt backup: $backup" }
    }
    $currentHash = Get-Digest $target
    if ($currentHash -ne $entry.beforeSha256 -and $currentHash -ne $entry.sha256) { throw "Restore refused concurrent or unknown content: $target" }
  }
  $restored = 0
  $removed = 0
  foreach ($entry in @($plan.files)) {
    Assert-Gate $plan.mode $plan.shadowRoot $roots $plan.manifestSha256 $MaintenanceGatePath $ExpectedGateSha256 -ForRestore
    $target = Resolve-Child ([string]$plan.roots.($entry.root)) $entry.path
    $currentHash = Get-Digest $target
    if ($currentHash -eq $entry.beforeSha256) { continue }
    if ($currentHash -ne $entry.sha256) { throw "Restore refused a new concurrent change: $target" }
    if ($null -eq $entry.beforeSha256) {
      [IO.File]::Delete($target)
      $removed++
    } else {
      Set-AtomicFile (Resolve-Child $TransactionDirectory $entry.backup) $target $entry.beforeSha256
      $restored++
    }
  }
  foreach ($entry in @($plan.files)) { if ((Get-Digest $entry.target) -ne $entry.beforeSha256) { throw "Restore verification failed: $($entry.target)" } }
  Write-JsonFile (Join-Path $TransactionDirectory 'state.json') @{status='restored-files-only'; planSha256=$ExpectedPlanSha256; restored=$restored; removed=$removed; businessHealth='not-tested'}
  [pscustomobject]@{status='restored-files-only'; restored=$restored; removed=$removed; planSha256=$ExpectedPlanSha256}
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
