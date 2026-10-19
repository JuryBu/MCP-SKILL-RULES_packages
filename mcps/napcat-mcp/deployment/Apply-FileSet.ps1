[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ManifestPath,
  [Parameter(Mandatory)][string]$ExpectedManifestSha256,
  [Parameter(Mandatory)][string]$CandidateRoot,
  [Parameter(Mandatory)][string]$TransactionDirectory,
  [ValidateSet('Shadow','LiveFiles')][string]$Mode = 'Shadow',
  [string]$ShadowRoot,
  [string]$MaintenanceGatePath,
  [string]$ExpectedGateSha256,
  [switch]$ValidateOnly,
  [ValidateRange(0,10000)][int]$FaultAfter = 0,
  [switch]$LeaveFailureForShadowRestoreTest
)
. (Join-Path $PSScriptRoot 'FileSet.Common.ps1')
$CandidateRoot = Get-FullPath $CandidateRoot
$TransactionDirectory = Get-FullPath $TransactionDirectory
Assert-NoReparse $CandidateRoot
Assert-NoReparse $TransactionDirectory
if ($Mode -ne 'Shadow' -and ($FaultAfter -or $LeaveFailureForShadowRestoreTest)) { throw 'Fault injection is limited to Shadow mode' }
$manifest = Read-FrozenJson $ManifestPath $ExpectedManifestSha256
if ($manifest.schemaVersion -ne 1 -or $manifest.status -ne 'frozen' -or [string]::IsNullOrWhiteSpace($manifest.candidateId)) { throw 'A frozen schemaVersion=1 manifest with candidateId is required' }
$rootProperties = @($manifest.roots.PSObject.Properties)
if (-not $rootProperties.Count -or -not @($manifest.files).Count) { throw 'Empty roots or file list' }
$roots = @($rootProperties | ForEach-Object { Get-FullPath ([string]$_.Value) })
if (-not ($ValidateOnly -and $Mode -eq 'LiveFiles')) {
  Assert-Gate $Mode $ShadowRoot $roots $ExpectedManifestSha256 $MaintenanceGatePath $ExpectedGateSha256
}
if ($Mode -eq 'Shadow' -and (-not (Test-Within $CandidateRoot $ShadowRoot) -or -not (Test-Within $TransactionDirectory $ShadowRoot))) { throw 'Shadow candidate and transaction must also remain under ShadowRoot' }
if ((Test-Within $TransactionDirectory $CandidateRoot) -or (Test-Within $CandidateRoot $TransactionDirectory) -or $CandidateRoot -eq $TransactionDirectory) { throw 'Candidate and transaction directories must be separate' }
foreach ($root in $roots) {
  Assert-NoReparse $root
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Target root missing: $root" }
  if ((Test-Within $TransactionDirectory $root) -or $TransactionDirectory -eq $root -or (Test-Within $CandidateRoot $root) -or (Test-Within $root $CandidateRoot) -or $root -eq $CandidateRoot) { throw 'Candidate, transaction and target directories must be separate' }
}
if (Test-Path -LiteralPath $TransactionDirectory) { throw 'TransactionDirectory must not already exist; retain prior recovery evidence' }
$mutex = Get-RootMutex $roots
$ownsMutex = $false
$planHash = $null
$touched = $false
try {
  $ownsMutex = Enter-RootMutex $mutex
  if (-not $ownsMutex) { throw 'Another file-set operation owns these exact roots' }
  $destinations = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $entries = @()
  foreach ($file in @($manifest.files)) {
    if ($file.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not ($file.PSObject.Properties.Name -contains 'beforeSha256')) { throw 'Each entry needs sha256 and an explicit beforeSha256 (null for an absent file)' }
    if ($null -ne $file.beforeSha256 -and $file.beforeSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid beforeSha256' }
    $rootProperty = @($rootProperties | Where-Object Name -CEQ $file.root)
    if ($rootProperty.Count -ne 1) { throw "Unknown target root: $($file.root)" }
    $target = Resolve-Child ([string]$rootProperty[0].Value) $file.path
    $source = Resolve-Child $CandidateRoot $file.source
    if (-not $destinations.Add($target)) { throw "Duplicate target: $target" }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $target) -PathType Container)) { throw "Target parent must already exist: $target" }
    if ((Get-Digest $source) -ne $file.sha256) { throw "Candidate file hash mismatch: $source" }
    if ((Get-Digest $target) -ne $file.beforeSha256) { throw "Installed baseline mismatch: $target" }
    $entryIndex = $entries.Count.ToString('D4')
    $entries += [pscustomobject]@{ root=$file.root; path=$file.path; target=$target; source=$source; sha256=$file.sha256.ToLowerInvariant(); beforeSha256=$file.beforeSha256; backup="backup/$entryIndex.bin"; payload="payload/$entryIndex.bin" }
  }
  if ($ValidateOnly) { [pscustomobject]@{status='validated-no-writes'; files=$entries.Count; manifestSha256=$ExpectedManifestSha256}; return }
  [void][IO.Directory]::CreateDirectory($TransactionDirectory)
  [void][IO.Directory]::CreateDirectory((Join-Path $TransactionDirectory 'backup'))
  [void][IO.Directory]::CreateDirectory((Join-Path $TransactionDirectory 'payload'))
  foreach ($entry in $entries) {
    [IO.File]::Copy($entry.source, (Join-Path $TransactionDirectory $entry.payload), $false)
    if ((Get-Digest (Join-Path $TransactionDirectory $entry.payload)) -ne $entry.sha256) { throw 'Payload changed during snapshot' }
    if ($null -ne $entry.beforeSha256) {
      [IO.File]::Copy($entry.target, (Join-Path $TransactionDirectory $entry.backup), $false)
      if ((Get-Digest (Join-Path $TransactionDirectory $entry.backup)) -ne $entry.beforeSha256) { throw 'Baseline changed during backup' }
    }
  }
  [IO.File]::Copy($ManifestPath, (Join-Path $TransactionDirectory 'manifest.json'), $false)
  if ((Get-Digest (Join-Path $TransactionDirectory 'manifest.json')) -ne $ExpectedManifestSha256) { throw 'Manifest changed during snapshot' }
  $plan = [ordered]@{schemaVersion=1; mode=$Mode; shadowRoot=$ShadowRoot; manifestSha256=$ExpectedManifestSha256; manifestSnapshot='manifest.json'; candidateId=$manifest.candidateId; transactionDirectory=$TransactionDirectory; maintenanceGatePath=$MaintenanceGatePath; maintenanceGateSha256=$ExpectedGateSha256; roots=$manifest.roots; files=$entries; createdAtUtc=[DateTimeOffset]::UtcNow.ToString('o')}
  $planPath = Join-Path $TransactionDirectory 'restore-plan.json'
  Write-JsonFile $planPath $plan
  $planHash = Get-Digest $planPath
  [IO.File]::WriteAllText((Join-Path $TransactionDirectory 'restore-plan.sha256'), $planHash, [Text.Encoding]::ASCII)
  Write-Output ("RESTORE_PLAN_SHA256=" + $planHash)
  Write-JsonFile (Join-Path $TransactionDirectory 'state.json') @{status='prepared'; planSha256=$planHash}
  $written = 0
  foreach ($entry in $entries) {
    Assert-Gate $Mode $ShadowRoot $roots $ExpectedManifestSha256 $MaintenanceGatePath $ExpectedGateSha256
    if ((Get-Digest $entry.target) -ne $entry.beforeSha256) { throw "Concurrent baseline change: $($entry.target)" }
    $touched = $true
    Set-AtomicFile (Join-Path $TransactionDirectory $entry.payload) $entry.target $entry.sha256
    $written++
    if ($FaultAfter -eq $written) { throw "Injected shadow fault after $written file writes" }
  }
  foreach ($entry in $entries) { if ((Get-Digest $entry.target) -ne $entry.sha256) { throw 'Final installed file hash mismatch' } }
  Write-JsonFile (Join-Path $TransactionDirectory 'state.json') @{status='applied-files-only'; planSha256=$planHash; files=$written; businessHealth='not-tested'}
  [pscustomobject]@{status='applied-files-only'; files=$written; restorePlanSha256=$planHash; transactionDirectory=$TransactionDirectory}
} catch {
  $originalError = $_.Exception.Message
  if ($touched -and $planHash -and -not $LeaveFailureForShadowRestoreTest) {
    try {
      & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $TransactionDirectory -ExpectedPlanSha256 $planHash -MaintenanceGatePath $MaintenanceGatePath -ExpectedGateSha256 $ExpectedGateSha256
    } catch { throw "APPLY_FAILED: $originalError ; RESTORE_INCOMPLETE: $($_.Exception.Message) ; transaction=$TransactionDirectory ; planSha256=$planHash" }
    throw "APPLY_FAILED_RESTORED: $originalError ; transaction=$TransactionDirectory ; planSha256=$planHash"
  }
  throw
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
