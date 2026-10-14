[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$InstalledRoot,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][string]$PreparationRoot,
  [Parameter(Mandatory = $true)][string]$OwnerId
)

$ErrorActionPreference = 'Stop'
if ($OwnerId -notmatch '^[A-Za-z0-9_.:-]{1,128}$') { throw 'PREPARATION_OWNER_INVALID' }

function Get-AbsoluteDirectory {
  param([string]$Value)
  if (-not [System.IO.Path]::IsPathRooted($Value)) { throw 'PREPARATION_ABSOLUTE_PATH_REQUIRED' }
  $Full = [System.IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
  if (-not (Test-Path -LiteralPath $Full -PathType Container)) { throw 'PREPARATION_INPUT_DIRECTORY_MISSING' }
  return $Full
}

function Test-Inside {
  param([string]$Root, [string]$Value)
  return $Value.StartsWith($Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoChildReparsePoint {
  param([string]$Root, [string]$Value)
  if (-not (Test-Inside $Root $Value)) { throw 'PREPARATION_PATH_OUTSIDE_ROOT' }
  $Current = $Value
  while ($Current -ne $Root) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PREPARATION_REPARSE_POINT_REJECTED' }
    }
    $Current = Split-Path -Parent $Current
    if ([string]::IsNullOrEmpty($Current)) { throw 'PREPARATION_PATH_OUTSIDE_ROOT' }
  }
}

function Get-FileRecord {
  param([string]$Root, [string]$RelativePath, [switch]$Required)
  $Absolute = [System.IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
  Assert-NoChildReparsePoint $Root $Absolute
  if (-not (Test-Path -LiteralPath $Absolute -PathType Leaf)) {
    if ($Required) { throw "PREPARATION_REQUIRED_FILE_MISSING: $RelativePath" }
    if (Test-Path -LiteralPath $Absolute) { throw 'PREPARATION_FILE_EXPECTED' }
    return [pscustomobject]@{ path = $Absolute; exists = $false; sha256 = $null; length = $null; sddl = $null }
  }
  $Item = Get-Item -LiteralPath $Absolute
  return [pscustomobject]@{
    path = $Absolute
    exists = $true
    sha256 = (Get-FileHash -LiteralPath $Absolute -Algorithm SHA256).Hash.ToLowerInvariant()
    length = $Item.Length
    sddl = (Get-Acl -LiteralPath $Absolute).Sddl
  }
}

function Copy-VerifiedInput {
  param($Record, [string]$Destination)
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Copy-Item -LiteralPath $Record.path -Destination $Destination
  if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Record.sha256) { throw 'PREPARATION_COPY_CHANGED' }
}

function Get-DependencyFileNames {
  param([string]$Root, [string]$PackageRoot)
  $Pending = New-Object 'System.Collections.Generic.Queue[string]'
  $Pending.Enqueue($PackageRoot)
  $Names = @()
  while ($Pending.Count -gt 0) {
    $Directory = $Pending.Dequeue()
    Assert-NoChildReparsePoint $Root $Directory
    foreach ($Item in Get-ChildItem -LiteralPath $Directory -Force) {
      if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PREPARATION_REPARSE_POINT_REJECTED' }
      if ($Item.PSIsContainer) { $Pending.Enqueue($Item.FullName) }
      else { $Names += $Item.FullName.Substring($Root.Length + 1) }
      if ($Names.Count + $Pending.Count -gt 512) { throw 'PREPARATION_DEPENDENCY_FILE_LIMIT' }
    }
  }
  return @($Names | Sort-Object)
}

$SourceRoot = Get-AbsoluteDirectory $SourceRoot
$InstalledRoot = Get-AbsoluteDirectory $InstalledRoot
$DataRoot = Get-AbsoluteDirectory $DataRoot
if (-not [System.IO.Path]::IsPathRooted($PreparationRoot)) { throw 'PREPARATION_ABSOLUTE_PATH_REQUIRED' }
$PreparationRoot = [System.IO.Path]::GetFullPath($PreparationRoot).TrimEnd('\', '/')
$TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
if (-not (Test-Inside $TempRoot $PreparationRoot)) { throw 'PREPARATION_TEMP_OUTPUT_REQUIRED' }
Assert-NoChildReparsePoint $TempRoot $PreparationRoot
foreach ($InputRoot in @($SourceRoot, $InstalledRoot, $DataRoot)) {
  if ($PreparationRoot -eq $InputRoot -or (Test-Inside $InputRoot $PreparationRoot) -or (Test-Inside $PreparationRoot $InputRoot)) {
    throw 'PREPARATION_OUTPUT_OVERLAPS_INPUT'
  }
}
if (Test-Path -LiteralPath $PreparationRoot) { throw 'PREPARATION_NEW_OUTPUT_REQUIRED' }

$FileNames = @(
  'ops/codex-outer-runtime.mjs',
  'ops/start-codex-app-server-proxy.ps1',
  'ops/resolve-napcat-data-root.ps1',
  'ops/resolve-codex-outer-runtime-startup.ps1',
  'src/atomic-file.mjs',
  'src/codex-app-server-proxy-runner.mjs',
  'src/codex-app-server-proxy.mjs',
  'src/codex-request-metadata.mjs',
  'src/codex-display-policy.mjs',
  'src/codex-runtime-bundle.mjs',
  'src/observability-utils.mjs',
  'src/outer-engine.mjs',
  'src/outer-runtime-contract.mjs',
  'src/outer-runtime-host.mjs',
  'src/outer-runtime-selection.mjs',
  'src/outer-runtime.mjs',
  'src/reasoning-placeholder.mjs',
  'src/turn-observability.mjs',
  'src/wake-visibility.mjs'
)
$Entries = @()
$OriginalRequired = @('ops/start-codex-app-server-proxy.ps1', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs')
foreach ($Name in $FileNames) {
  $Candidate = Get-FileRecord $SourceRoot $Name -Required
  $Original = Get-FileRecord $InstalledRoot $Name -Required:($OriginalRequired -ccontains $Name)
  $Operation = if (-not $Original.exists) { 'add' } elseif ($Original.sha256 -ceq $Candidate.sha256) { 'unchanged' } else { 'replace' }
  $Entries += [pscustomobject]@{ name = $Name; operation = $Operation; candidate = $Candidate; original = $Original }
}
$StartupRelative = 'state/codex-outer-runtime-startup.json'
$OriginalStartup = Get-FileRecord $DataRoot $StartupRelative
$InstalledWs = Get-FileRecord $InstalledRoot 'node_modules/ws/package.json' -Required
$SourceWs = Get-FileRecord $SourceRoot 'node_modules/ws/package.json' -Required
if ($InstalledWs.sha256 -cne $SourceWs.sha256) { throw 'PREPARATION_WS_DEPENDENCY_DIFFERS' }
$WsFiles = @()
$WsRelativeRoot = 'node_modules\ws'
$SourceWsRoot = Join-Path $SourceRoot $WsRelativeRoot
$InstalledWsRoot = Join-Path $InstalledRoot $WsRelativeRoot
$SourceWsNames = @(Get-DependencyFileNames $SourceRoot $SourceWsRoot)
$InstalledWsNames = @(Get-DependencyFileNames $InstalledRoot $InstalledWsRoot)
if (($SourceWsNames -join "`n") -cne ($InstalledWsNames -join "`n")) { throw 'PREPARATION_WS_DEPENDENCY_DIFFERS' }
foreach ($Name in $SourceWsNames) {
  $Candidate = Get-FileRecord $SourceRoot $Name -Required
  $Original = Get-FileRecord $InstalledRoot $Name -Required
  if ($Candidate.sha256 -cne $Original.sha256) { throw 'PREPARATION_WS_DEPENDENCY_DIFFERS' }
  $WsFiles += [pscustomobject]@{ name = $Name; candidate = $Candidate; original = $Original }
}
$CandidateRoot = Join-Path $DataRoot 'state\codex-outer-runtime-candidates'
Assert-NoChildReparsePoint $DataRoot $CandidateRoot
if ((Test-Path -LiteralPath $CandidateRoot) -and -not (Test-Path -LiteralPath $CandidateRoot -PathType Container)) { throw 'PREPARATION_CANDIDATE_DIRECTORY_EXPECTED' }

New-Item -ItemType Directory -Path $PreparationRoot | Out-Null
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $PreparationRoot 'PREPARE_ONLY.txt'), 'Read-only preparation. No production action or window is authorized by this directory.', $Utf8)
foreach ($Entry in $Entries) {
  Copy-VerifiedInput $Entry.candidate (Join-Path $PreparationRoot ('candidate\' + $Entry.name))
  if ($Entry.original.exists) {
    Copy-VerifiedInput $Entry.original (Join-Path $PreparationRoot ('original\' + $Entry.name))
  }
}
foreach ($Entry in $WsFiles) {
  Copy-VerifiedInput $Entry.original (Join-Path $PreparationRoot ('original\' + $Entry.name))
  Copy-VerifiedInput $Entry.candidate (Join-Path $PreparationRoot ('candidate\' + $Entry.name))
}
foreach ($Entry in $WsFiles) {
  foreach ($Side in @('candidate', 'original')) {
    $Before = $Entry.$Side
    $Root = if ($Side -eq 'candidate') { $SourceRoot } else { $InstalledRoot }
    $After = Get-FileRecord $Root $Entry.name -Required
    if ($Before.sha256 -cne $After.sha256 -or $Before.sddl -cne $After.sddl) { throw 'PREPARATION_DEPENDENCY_DRIFT' }
  }
}
if ($OriginalStartup.exists) { Copy-VerifiedInput $OriginalStartup (Join-Path $PreparationRoot 'original-startup.json') }
$DesiredStartup = [ordered]@{ schemaVersion = 1; enabled = $true; candidateRoot = $CandidateRoot }
$DesiredPath = Join-Path $PreparationRoot 'candidate-startup.json'
[System.IO.File]::WriteAllText($DesiredPath, ($DesiredStartup | ConvertTo-Json -Depth 4), $Utf8)

foreach ($Entry in $Entries) {
  foreach ($Side in @('candidate', 'original')) {
    $Before = $Entry.$Side
    $Root = if ($Side -eq 'candidate') { $SourceRoot } else { $InstalledRoot }
    $After = Get-FileRecord $Root $Entry.name
    if ($Before.exists -ne $After.exists -or $Before.sha256 -cne $After.sha256 -or $Before.sddl -cne $After.sddl) { throw 'PREPARATION_INPUT_DRIFT' }
  }
}
$CurrentStartup = Get-FileRecord $DataRoot $StartupRelative
if ($CurrentStartup.exists -ne $OriginalStartup.exists -or $CurrentStartup.sha256 -cne $OriginalStartup.sha256 -or $CurrentStartup.sddl -cne $OriginalStartup.sddl) {
  throw 'PREPARATION_STARTUP_INPUT_DRIFT'
}
$Manifest = [ordered]@{
  schemaVersion = 1
  ownerId = $OwnerId
  preparedAt = [DateTimeOffset]::UtcNow.ToString('o')
  mode = 'PREPARE_ONLY'
  readyForProduction = $false
  productionChanged = $false
  sourceRoot = $SourceRoot
  installedRoot = $InstalledRoot
  dataRoot = $DataRoot
  files = $Entries
  startup = [ordered]@{ target = $CurrentStartup.path; original = $OriginalStartup; candidate = $DesiredStartup; sha256 = (Get-FileHash -LiteralPath $DesiredPath -Algorithm SHA256).Hash.ToLowerInvariant() }
  dependency = [ordered]@{ name = 'ws'; original = $InstalledWs; candidate = $SourceWs; files = $WsFiles; copied = $true }
  preservedState = @('codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json')
  requiredBeforeApplication = @('same-build normal PowerShell entry evidence', 'independent original-service recovery rehearsal', 'new owner window and exact live process identities', 'real Desktop and tool checks')
  recovery = [ordered]@{ originalEntryRelativePath = 'original/ops/start-codex-app-server-proxy.ps1'; restoreOriginalFiles = @($Entries | Where-Object operation -eq 'replace' | ForEach-Object name); removeOnlyMatchingAddedFiles = @($Entries | Where-Object operation -eq 'add' | ForEach-Object name); restoreOriginalFileSecurity = $true; startupOriginalExisted = $OriginalStartup.exists; preserveJournalTokenAndOtherServices = $true; executableEntryPrepared = $false }
}
$ManifestPath = Join-Path $PreparationRoot 'preparation.json'
[System.IO.File]::WriteAllText($ManifestPath, ($Manifest | ConvertTo-Json -Depth 10), $Utf8)
[pscustomobject]@{ prepared = $true; mode = 'PREPARE_ONLY'; productionChanged = $false; readyForProduction = $false; path = $ManifestPath; sha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant(); files = $Entries.Count } | ConvertTo-Json -Compress
