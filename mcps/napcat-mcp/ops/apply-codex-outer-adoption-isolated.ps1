[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SampleRoot,
  [Parameter(Mandatory = $true)][string]$PreparationRoot,
  [Parameter(Mandatory = $true)][string]$PreparationSha256,
  [Parameter(Mandatory = $true)][string]$OwnerId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$Sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$Result = [ordered]@{ schemaVersion = 1; mode = 'TEMP_ISOLATED_APPLY'; ownerId = $OwnerId; preparationSha256 = $PreparationSha256; status = 'preflight-failed'; phase = 'scope'; targetsMayHaveChanged = $false; completed = @(); written = @(); attempted = @(); failed = $null; resultPath = $null; recoveryMaterialsRetained = $true }
$ReportAllowed = $false
$LockStream = $null
$JournalStream = $null
$StagePath = $null
$StageOwned = $false
$Plan = $null
$ExitCode = 0
$LockValue = [Guid]::NewGuid().ToString('N')
$RuntimeFiles = @{}

function Test-Inside([string]$Root, [string]$Value) {
  return $Value.StartsWith($Root.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-PlainPath([string]$Root, [string]$Value, [switch]$AllAncestors) {
  if (-not (Test-Inside $Root $Value) -and $Root -ine $Value) { throw 'ISOLATED_PATH_OUTSIDE_ROOT' }
  $Current = $Value
  while ($Current) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ISOLATED_REPARSE_POINT_REJECTED' }
      if ($Item.LinkType) { throw 'ISOLATED_LINK_REJECTED' }
    }
    if (-not $AllAncestors -and $Current -ieq $Root) { break }
    $Current = Split-Path -Parent $Current
  }
}

function Get-TempDirectory([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':')) { throw 'ISOLATED_ABSOLUTE_PLAIN_PATH_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
  $Temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
  if (-not (Test-Inside $Temp $Full)) { throw 'ISOLATED_TEMP_ROOT_REQUIRED' }
  Assert-PlainPath $Temp $Full -AllAncestors
  if (-not (Test-Path -LiteralPath $Full -PathType Container)) { throw 'ISOLATED_DIRECTORY_MISSING' }
  return $Full
}

function Get-Sha([string]$Value) {
  return (Get-FileHash -LiteralPath $Value -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-State([string]$Root, [string]$Value) {
  Assert-PlainPath $Root $Value
  if (-not (Test-Path -LiteralPath $Value)) { return [pscustomobject]@{ exists = $false; sha256 = $null; length = $null; sddl = $null; attributes = $null } }
  if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw 'ISOLATED_FILE_EXPECTED' }
  $Item = Get-Item -LiteralPath $Value -Force
  if ($RuntimeFiles.ContainsKey($Value)) {
    $Pinned = $RuntimeFiles[$Value]
    if ($Item.Length -ne $Pinned.state.length -or $Item.LastWriteTimeUtc.Ticks -ne $Pinned.modified -or $Item.CreationTimeUtc.Ticks -ne $Pinned.created) { throw 'ISOLATED_RUNTIME_FILE_DRIFT' }
    $Current = [pscustomobject]@{ exists = $true; sha256 = $Pinned.state.sha256; length = $Item.Length; sddl = (Get-Acl -LiteralPath $Value).GetSecurityDescriptorSddlForm($Sections); attributes = [int]$Item.Attributes }
    Assert-SameState $Pinned.state $Current
    return $Current
  }
  return [pscustomobject]@{ exists = $true; sha256 = (Get-Sha $Value); length = $Item.Length; sddl = (Get-Acl -LiteralPath $Value).GetSecurityDescriptorSddlForm($Sections); attributes = [int]$Item.Attributes }
}

function Bind-RuntimeBundle($Binding) {
  $BundleParent = Join-Path $DataRoot 'state/codex-runtime-bundles'
  if ($null -eq $Binding) {
    if (Test-Path -LiteralPath $BundleParent) { throw 'ISOLATED_RUNTIME_BINDING_REQUIRED' }
    return @()
  }
  if ($Binding.schemaVersion -ne 1 -or $Binding.digest -cnotmatch '^[0-9a-f]{64}$' -or $Binding.sourceMetadata -cnotmatch '^[0-9a-f]{64}$' -or $Binding.sourcePath -notmatch '^[A-Za-z]:[\\/]' -or $Binding.sourcePath.Substring(2).Contains(':') -or [IO.Path]::GetFileName($Binding.sourcePath) -cne 'codex.exe') { throw 'ISOLATED_RUNTIME_BINDING_INVALID' }
  [void](Get-TempDirectory $BundleParent)
  $BundleRoot = Get-TempDirectory (Join-Path $BundleParent $Binding.digest)
  $Children = @(Get-ChildItem -LiteralPath $BundleParent -Force)
  if ($Children.Count -ne 1 -or $Children[0].FullName -ine $BundleRoot) { throw 'ISOLATED_RUNTIME_TREE_REJECTED' }
  $Required = @('codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe', 'codex.exe')
  $Allowed = $Required + @('codex-code-mode-node-host.exe', '.codex-runtime-manifest.json')
  $Names = @($Binding.files | ForEach-Object { $_.name } | Sort-Object)
  if ($Names.Count -lt 5 -or $Names.Count -gt 6 -or @($Names | Select-Object -Unique).Count -ne $Names.Count -or @($Names | Where-Object { $Allowed -cnotcontains $_ }).Count -or @($Required | Where-Object { $Names -cnotcontains $_ }).Count -or $Names -cnotcontains '.codex-runtime-manifest.json') { throw 'ISOLATED_RUNTIME_FILE_SET_REJECTED' }
  $Actual = @(Get-ChildItem -LiteralPath $BundleRoot -Force)
  if (@($Actual | Where-Object { $_.PSIsContainer }).Count -or (($Actual.Name | Sort-Object) -join '|') -cne ($Names -join '|')) { throw 'ISOLATED_RUNTIME_TREE_REJECTED' }
  $DigestEntries = @()
  [string[]]$ContentNames = $Names.Clone()
  [Array]::Sort($ContentNames, [StringComparer]::Ordinal)
  foreach ($Name in $ContentNames) {
    $Entry = @($Binding.files | Where-Object { $_.name -ceq $Name })[0]
    $Target = Join-Path $BundleRoot $Entry.name
    Assert-PlainPath $DataRoot $Target
    Assert-Record $Entry $Target
    if (-not $Entry.exists -or $Entry.attributes -isnot [ValueType]) { throw 'ISOLATED_RUNTIME_BINDING_INVALID' }
    $Stream = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $State = Get-State $DataRoot $Target
      Assert-Original $Entry $State
      if ($Entry.attributes -ne $State.attributes) { throw 'ISOLATED_RUNTIME_ATTRIBUTE_DRIFT' }
      $Item = Get-Item -LiteralPath $Target -Force
      $RuntimeFiles[$Target] = [pscustomobject]@{ stream = $Stream; state = $State; modified = $Item.LastWriteTimeUtc.Ticks; created = $Item.CreationTimeUtc.Ticks }
      $Stream = $null
      if ($Entry.name -cne '.codex-runtime-manifest.json') {
        if ($State.length -le 0) { throw 'ISOLATED_RUNTIME_EMPTY_EXECUTABLE' }
        $DigestEntries += [ordered]@{ name = $Entry.name; size = $State.length; sha256 = $State.sha256 }
      }
    } finally { if ($null -ne $Stream) { $Stream.Dispose() } }
  }
  $Manifest = Get-Content -LiteralPath (Join-Path $BundleRoot '.codex-runtime-manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
  if ((($Manifest.PSObject.Properties.Name | Sort-Object) -join '|') -cne 'digest|sourceMetadata|sourcePath' -or $Manifest.digest -cne $Binding.digest -or $Manifest.sourcePath -cne $Binding.sourcePath -or $Manifest.sourceMetadata -cne $Binding.sourceMetadata) { throw 'ISOLATED_RUNTIME_SOURCE_BINDING_MISMATCH' }
  $Hash = [Security.Cryptography.SHA256]::Create()
  try { $Digest = ([BitConverter]::ToString($Hash.ComputeHash([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $DigestEntries -Compress -Depth 4))))).Replace('-', '').ToLowerInvariant() } finally { $Hash.Dispose() }
  if ($Digest -cne $Binding.digest) { throw 'ISOLATED_RUNTIME_DIGEST_MISMATCH' }
  $RuntimeStatePath = Join-Path $DataRoot 'state/codex-app-server-proxy-runtime.json'
  if (Test-Path -LiteralPath $RuntimeStatePath) {
    Assert-PlainPath $DataRoot $RuntimeStatePath
    $RuntimeState = Get-Content -LiteralPath $RuntimeStatePath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($RuntimeState.state -cne 'stopped' -or $RuntimeState.executablePath -ine (Join-Path $BundleRoot 'codex.exe') -or $RuntimeState.lastKnownGoodExecutablePath -ine (Join-Path $BundleRoot 'codex.exe')) { throw 'ISOLATED_RUNTIME_STATE_BINDING_MISMATCH' }
  }
  $Result.runtimeBundle = [ordered]@{ digest = $Digest; sourcePath = $Binding.sourcePath; sourceMetadata = $Binding.sourceMetadata; filesVerified = $Names.Count; readOnlyHeld = $true }
  return @($Names | ForEach-Object { 'state/codex-runtime-bundles/' + $Binding.digest + '/' + $_ }) + @('state/codex-app-server-proxy.jsonl')
}

function Assert-SameState($Before, $After) {
  if ($Before.exists -ne $After.exists -or $Before.sha256 -cne $After.sha256 -or $Before.length -ne $After.length -or $Before.sddl -cne $After.sddl -or $Before.attributes -ne $After.attributes) { throw 'ISOLATED_CONCURRENT_DRIFT' }
}

function Get-Tree([string]$Root) {
  $Tree = @{}
  $Pending = New-Object 'Collections.Generic.Queue[string]'
  $Pending.Enqueue($Root)
  while ($Pending.Count) {
    $Directory = $Pending.Dequeue()
    Assert-PlainPath $Root $Directory
    $Tree[$Directory] = [pscustomobject]@{ exists = $true; sha256 = $null; length = $null; sddl = (Get-Acl -LiteralPath $Directory).GetSecurityDescriptorSddlForm($Sections); attributes = [int](Get-Item -LiteralPath $Directory -Force).Attributes }
    foreach ($Item in Get-ChildItem -LiteralPath $Directory -Force) {
      Assert-PlainPath $Root $Item.FullName
      if ($Item.PSIsContainer) { $Pending.Enqueue($Item.FullName) }
      else { $Tree[$Item.FullName] = Get-State $Root $Item.FullName }
      if ($Tree.Count + $Pending.Count -gt 512) { throw 'ISOLATED_TREE_FILE_LIMIT' }
    }
  }
  return $Tree
}

function Assert-Tree($Before, $After) {
  if ((($Before.Keys | Sort-Object) -join '|') -cne (($After.Keys | Sort-Object) -join '|')) { throw 'ISOLATED_TREE_DRIFT' }
  foreach ($Key in $Before.Keys) { Assert-SameState $Before[$Key] $After[$Key] }
}

function Assert-FileSet([string]$Root, $Tree, [string[]]$Names) {
  $Found = @($Tree.Keys | Where-Object { $null -ne $Tree[$_].sha256 } | ForEach-Object { $_.Substring($Root.Length + 1).Replace('\', '/') } | Sort-Object)
  if (($Found -join '|') -cne (($Names | Sort-Object) -join '|')) { throw 'ISOLATED_UNKNOWN_OR_MISSING_FILE' }
}

function Assert-Record($Record, [string]$ExpectedPath) {
  if ($Record.exists -isnot [bool] -or $Record.path -ine $ExpectedPath) { throw 'ISOLATED_RECORD_BINDING_MISMATCH' }
  if ($Record.exists) {
    if ($Record.sha256 -notmatch '^[0-9a-f]{64}$' -or $Record.length -isnot [ValueType] -or $Record.length -lt 0) { throw 'ISOLATED_RECORD_INVALID' }
    $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Record.sddl)
    if ($null -eq $Descriptor.Owner -or $null -eq $Descriptor.Group -or $null -eq $Descriptor.DiscretionaryAcl -or $null -ne $Descriptor.SystemAcl) { throw 'ISOLATED_OWNER_GROUP_DACL_REQUIRED' }
  } elseif ($null -ne $Record.sha256 -or $null -ne $Record.sddl -or $null -ne $Record.length) { throw 'ISOLATED_ABSENT_RECORD_INVALID' }
}

function Assert-Original($Record, $State) {
  if ($Record.exists -ne $State.exists -or $Record.sha256 -cne $State.sha256 -or $Record.length -ne $State.length -or $Record.sddl -cne $State.sddl) { throw 'ISOLATED_ORIGINAL_SHA_ACL_DRIFT' }
}

function Assert-SavedFile([string]$Value, $Record) {
  $State = Get-State $PreparationRoot $Value
  if ($Record.exists -ne $State.exists -or $Record.sha256 -cne $State.sha256 -or $Record.length -ne $State.length) { throw 'ISOLATED_PACKAGE_SHA_MISMATCH' }
}

function Save-Journal {
  if ($null -eq $JournalStream) { return }
  $Bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Result | ConvertTo-Json -Depth 12))
  $JournalStream.Position = 0
  $JournalStream.Write($Bytes, 0, $Bytes.Length)
  $JournalStream.SetLength($Bytes.Length)
  $JournalStream.Flush($true)
}

function Assert-InputsAndState([switch]$WithStage) {
  foreach ($Root in @($SampleRoot, $PreparationRoot, $InstalledRoot, $DataRoot)) { [void](Get-TempDirectory $Root) }
  if ((Get-Sha $ManifestPath) -cne $PreparationSha256 -or (Get-Sha $AnchorPath) -cne $AnchorSha) { throw 'ISOLATED_INPUT_DRIFT' }
  Assert-Tree $PreparedTree (Get-Tree $PreparationRoot)
  $CurrentInstalledTree = Get-Tree $InstalledRoot
  $CurrentDataTree = Get-Tree $DataRoot
  if ($WithStage) {
    if (-not $StageOwned -or -not $StagePath) { throw 'ISOLATED_STAGE_NOT_OWNED' }
    Assert-SameState $StageState (Get-State $SampleRoot $StagePath)
    $CurrentInstalledTree.Remove($StagePath)
    $CurrentDataTree.Remove($StagePath)
  }
  Assert-Tree $InstalledTree $CurrentInstalledTree
  Assert-Tree $DataTree $CurrentDataTree
  if ((Get-Acl -LiteralPath $SampleRoot).GetSecurityDescriptorSddlForm($Sections) -cne $SampleSddl) { throw 'ISOLATED_SAMPLE_ACL_DRIFT' }
}

try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'ISOLATED_WINDOWS_POWERSHELL_51_REQUIRED' }
  if ((Get-ExecutionPolicy).ToString() -ne 'RemoteSigned' -or (Get-ExecutionPolicy -Scope Process).ToString() -ne 'Undefined') { throw 'ISOLATED_ORDINARY_REMOTESIGNED_REQUIRED' }
  if ($OwnerId -notmatch '^[A-Za-z0-9_.:-]{1,128}$' -or $PreparationSha256 -notmatch '^[0-9a-f]{64}$') { throw 'ISOLATED_IDENTITY_INVALID' }
  $SampleRoot = Get-TempDirectory $SampleRoot
  $PreparationRoot = Get-TempDirectory $PreparationRoot
  if ($SampleRoot -ieq $PreparationRoot -or (Test-Inside $SampleRoot $PreparationRoot) -or (Test-Inside $PreparationRoot $SampleRoot)) { throw 'ISOLATED_ROOTS_OVERLAP' }
  $AnchorPath = Join-Path $SampleRoot '.outer-adoption-isolated-owner.json'
  $AnchorState = Get-State $SampleRoot $AnchorPath
  $Anchor = Get-Content -LiteralPath $AnchorPath -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($Anchor.schemaVersion -ne 1 -or $Anchor.mode -cne 'TEMP_ISOLATED_RECOVERY' -or $Anchor.ownerId -cne $OwnerId -or $Anchor.sampleRoot -ine $SampleRoot -or $Anchor.preparationRoot -ine $PreparationRoot -or $Anchor.preparationSha256 -cne $PreparationSha256) { throw 'ISOLATED_OWNERSHIP_MISMATCH' }
  $AnchorSha = $AnchorState.sha256
  $ReportAllowed = $true
  $Result.resultPath = Join-Path $SampleRoot ('apply-result-' + $LockValue + '.json')
  $LockPath = Join-Path $SampleRoot '.outer-adoption-isolated-recovery.lock'
  Assert-PlainPath $SampleRoot $LockPath
  $LockText = ([ordered]@{ ownerId = $OwnerId; preparationSha256 = $PreparationSha256; sampleRoot = $SampleRoot; nonce = $LockValue } | ConvertTo-Json -Compress)
  $LockBytes = [Text.Encoding]::UTF8.GetBytes($LockText)
  $LockStream = [IO.FileStream]::new($LockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
  $LockStream.Write($LockBytes, 0, $LockBytes.Length)
  $LockStream.Flush($true)
  $JournalStream = [IO.File]::Open($Result.resultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $InstalledRoot = Get-TempDirectory (Join-Path $SampleRoot 'installed')
  $DataRoot = Get-TempDirectory (Join-Path $SampleRoot 'data')
  $ManifestPath = Join-Path $PreparationRoot 'preparation.json'
  Assert-PlainPath $PreparationRoot $ManifestPath
  if ((Get-Sha $ManifestPath) -cne $PreparationSha256) { throw 'ISOLATED_PREPARATION_SHA_MISMATCH' }
  $Manifest = Get-Content -LiteralPath $ManifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($Manifest.schemaVersion -ne 1 -or $Manifest.mode -cne 'PREPARE_ONLY' -or $Manifest.ownerId -cne $OwnerId -or $Manifest.readyForProduction -ne $false -or $Manifest.productionChanged -ne $false -or $Manifest.installedRoot -ine $InstalledRoot -or $Manifest.dataRoot -ine $DataRoot) { throw 'ISOLATED_PREPARATION_BINDING_MISMATCH' }
  $SourceRoot = Get-TempDirectory $Manifest.sourceRoot
  $ExpectedNames = @(
    'ops/codex-outer-runtime.mjs', 'ops/start-codex-app-server-proxy.ps1', 'ops/resolve-napcat-data-root.ps1', 'ops/resolve-codex-outer-runtime-startup.ps1',
    'src/atomic-file.mjs', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs', 'src/codex-request-metadata.mjs', 'src/codex-display-policy.mjs', 'src/codex-runtime-bundle.mjs',
    'src/observability-utils.mjs', 'src/outer-engine.mjs', 'src/outer-runtime-contract.mjs', 'src/outer-runtime-host.mjs', 'src/outer-runtime-selection.mjs',
    'src/outer-runtime.mjs', 'src/reasoning-placeholder.mjs', 'src/turn-observability.mjs', 'src/wake-visibility.mjs'
  )
  $DependencyNames = @('browser.js', 'index.js', 'LICENSE', 'package.json', 'README.md', 'wrapper.mjs', 'lib/buffer-util.js', 'lib/constants.js', 'lib/event-target.js', 'lib/extension.js', 'lib/limiter.js', 'lib/permessage-deflate.js', 'lib/receiver.js', 'lib/sender.js', 'lib/stream.js', 'lib/subprotocol.js', 'lib/validation.js', 'lib/websocket.js', 'lib/websocket-server.js') | ForEach-Object { 'node_modules/ws/' + $_ }
  if (@($Manifest.files).Count -ne 19 -or ((@($Manifest.files.name | Sort-Object) -join '|') -cne (@($ExpectedNames | Sort-Object) -join '|'))) { throw 'ISOLATED_FIXED_FILE_SET_REQUIRED' }
  $ActualDependencyNames = @($Manifest.dependency.files | ForEach-Object { $_.name.Replace('\', '/') } | Sort-Object)
  if ($Manifest.dependency.name -cne 'ws' -or $Manifest.dependency.copied -ne $true -or ($ActualDependencyNames -join '|') -cne (($DependencyNames | Sort-Object) -join '|')) { throw 'ISOLATED_FULL_DEPENDENCY_SET_REQUIRED' }
  $PreservedNames = @('codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json')
  if (($Manifest.preservedState -join '|') -cne ($PreservedNames -join '|')) { throw 'ISOLATED_PRESERVED_STATE_SET_REQUIRED' }
  $Result.phase = 'preflight'
  $Plans = @()
  $PackageNames = @('PREPARE_ONLY.txt', 'preparation.json', 'candidate-startup.json')
  $InstalledNames = @()
  foreach ($Entry in @($Manifest.files) + @($Manifest.dependency.files)) {
    $Name = $Entry.name.Replace('\', '/')
    $Target = Join-Path $InstalledRoot $Name
    Assert-Record $Entry.original $Target
    Assert-Record $Entry.candidate (Join-Path $SourceRoot $Name)
    if (-not $Entry.candidate.exists) { throw 'ISOLATED_CANDIDATE_REQUIRED' }
    Assert-Original $Entry.original (Get-State $SampleRoot $Target)
    Assert-SavedFile (Join-Path $PreparationRoot ('candidate/' + $Name)) $Entry.candidate
    Assert-SavedFile (Join-Path $PreparationRoot ('original/' + $Name)) $Entry.original
    $PackageNames += 'candidate/' + $Name
    if ($Entry.original.exists) { $PackageNames += 'original/' + $Name; $InstalledNames += $Name }
    if ($ExpectedNames -ccontains $Name) {
      $Operation = if (-not $Entry.original.exists) { 'add' } elseif ($Entry.original.sha256 -ceq $Entry.candidate.sha256) { 'unchanged' } else { 'replace' }
      if ($Entry.operation -cne $Operation) { throw 'ISOLATED_OPERATION_MISMATCH' }
      $Plans += [pscustomobject]@{ name = $Name; target = $Target; candidate = (Join-Path $PreparationRoot ('candidate/' + $Name)); sha256 = $Entry.candidate.sha256; length = $Entry.candidate.length; original = $Entry.original; action = $Operation }
    } elseif (-not $Entry.original.exists -or $Entry.original.sha256 -cne $Entry.candidate.sha256) { throw 'ISOLATED_DEPENDENCY_CHANGE_REJECTED' }
  }
  $StartupTarget = Join-Path $DataRoot 'state/codex-outer-runtime-startup.json'
  if ($Manifest.startup.target -ine $StartupTarget) { throw 'ISOLATED_STARTUP_BINDING_MISMATCH' }
  Assert-Record $Manifest.startup.original $StartupTarget
  Assert-Original $Manifest.startup.original (Get-State $SampleRoot $StartupTarget)
  Assert-SavedFile (Join-Path $PreparationRoot 'original-startup.json') $Manifest.startup.original
  if ($Manifest.startup.original.exists) { $PackageNames += 'original-startup.json' }
  $StartupPath = Join-Path $PreparationRoot 'candidate-startup.json'
  $StartupState = Get-State $PreparationRoot $StartupPath
  if ($Manifest.startup.sha256 -notmatch '^[0-9a-f]{64}$' -or $StartupState.sha256 -cne $Manifest.startup.sha256) { throw 'ISOLATED_STARTUP_SHA_MISMATCH' }
  $Startup = Get-Content -LiteralPath $StartupPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $CandidateRoot = Join-Path $DataRoot 'state/codex-outer-runtime-candidates'
  foreach ($Configuration in @($Startup, $Manifest.startup.candidate)) {
    if ((($Configuration.PSObject.Properties.Name | Sort-Object) -join '|') -cne 'candidateRoot|enabled|schemaVersion' -or $Configuration.schemaVersion -ne 1 -or $Configuration.enabled -isnot [bool] -or -not $Configuration.enabled -or $Configuration.candidateRoot -ine $CandidateRoot) { throw 'ISOLATED_STARTUP_SEMANTICS_MISMATCH' }
  }
  [void](Get-TempDirectory $CandidateRoot)
  $Plans += [pscustomobject]@{ name = 'state/codex-outer-runtime-startup.json'; target = $StartupTarget; candidate = $StartupPath; sha256 = $StartupState.sha256; length = $StartupState.length; original = $Manifest.startup.original; action = $(if ($Manifest.startup.original.exists) { 'replace' } else { 'add' }) }
  foreach ($Plan in $Plans) { if (-not (Test-Path -LiteralPath (Split-Path -Parent $Plan.target) -PathType Container)) { throw 'ISOLATED_TARGET_PARENT_REQUIRED' } }
  $RuntimeNames = @(Bind-RuntimeBundle $Anchor.runtimeBundle)
  $PreparedTree = Get-Tree $PreparationRoot
  $InstalledTree = Get-Tree $InstalledRoot
  $DataTree = Get-Tree $DataRoot
  $SampleSddl = (Get-Acl -LiteralPath $SampleRoot).GetSecurityDescriptorSddlForm($Sections)
  Assert-FileSet $PreparationRoot $PreparedTree $PackageNames
  Assert-FileSet $InstalledRoot $InstalledTree $InstalledNames
  $DataNames = @($PreservedNames | ForEach-Object { 'state/' + $_ }) + @('state/codex-app-server-proxy-runtime.json', 'state/codex-app-server-proxy.stop') + $RuntimeNames
  if ($Manifest.startup.original.exists) { $DataNames += 'state/codex-outer-runtime-startup.json' }
  foreach ($Key in $DataTree.Keys) {
    if ($null -ne $DataTree[$Key].sha256 -and $DataNames -cnotcontains $Key.Substring($DataRoot.Length + 1).Replace('\', '/')) { throw 'ISOLATED_UNKNOWN_DATA_FILE' }
  }
  $Result.packageFilesVerified = @($PackageNames | Where-Object { $_ -like 'candidate/*' -or $_ -like 'original/*' }).Count
  $Result.dependencyFilesVerified = $DependencyNames.Count
  $Result.phase = 'apply'
  $Result.status = 'applying'
  Save-Journal
  foreach ($Plan in $Plans) {
    Assert-InputsAndState
    Assert-SameState $AnchorState (Get-State $SampleRoot $AnchorPath)
    if ($Plan.action -ne 'unchanged') {
      $StagePath = Join-Path (Split-Path -Parent $Plan.target) ('.outer-apply-' + $LockValue + '.tmp')
      Assert-PlainPath $SampleRoot $StagePath
      $StageOwned = $false
      $Bytes = [IO.File]::ReadAllBytes($Plan.candidate)
      $StageStream = [IO.File]::Open($StagePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $StageOwned = $true
      try { $StageStream.Write($Bytes, 0, $Bytes.Length); $StageStream.Flush($true) } finally { $StageStream.Dispose() }
      $StageState = Get-State $SampleRoot $StagePath
      if ($StageState.sha256 -cne $Plan.sha256 -or $StageState.length -ne $Plan.length) { throw 'ISOLATED_STAGE_SHA_MISMATCH' }
      Assert-InputsAndState -WithStage
      Assert-SameState $AnchorState (Get-State $SampleRoot $AnchorPath)
      $Result.attempted += $Plan.name
      $Result.targetsMayHaveChanged = $true
      Save-Journal
      if ($Plan.original.exists) { [IO.File]::Replace($StagePath, $Plan.target, [NullString]::Value) }
      else { [IO.File]::Move($StagePath, $Plan.target) }
      $StagePath = $null
      $StageOwned = $false
      $Result.written += $Plan.name
      Save-Journal
      $After = Get-State $SampleRoot $Plan.target
      if ($After.sha256 -cne $Plan.sha256 -or $After.length -ne $Plan.length -or ($Plan.original.exists -and $After.sddl -cne $Plan.original.sddl)) { throw 'ISOLATED_APPLY_VERIFICATION_FAILED' }
      if (Test-Inside $InstalledRoot $Plan.target) { $InstalledTree[$Plan.target] = $After }
      else { $DataTree[$Plan.target] = $After }
    }
    $Result.completed += [pscustomobject]@{ name = $Plan.name; action = $Plan.action; verified = $true }
    Save-Journal
  }
  $Result.phase = 'verification'
  Assert-InputsAndState
  $Result.preservedStateVerified = $true
  $Result.status = 'applied'
} catch {
  $Result.failed = [pscustomobject]@{ message = $_.Exception.Message; phase = $Result.phase; target = $(if ($null -ne $Plan) { $Plan.name } else { $null }) }
  $Result.status = if ($Result.targetsMayHaveChanged) { 'partial' } else { 'preflight-failed' }
  $ExitCode = 1
} finally {
  foreach ($Pinned in $RuntimeFiles.Values) { $Pinned.stream.Dispose() }
  if ($StageOwned -and $StagePath -and (Test-Path -LiteralPath $StagePath)) {
    try {
      Assert-PlainPath $SampleRoot $StagePath
      if ((Get-Sha $StagePath) -cne $Plan.sha256) { throw 'ISOLATED_STAGE_OWNERSHIP_CHANGED' }
      Remove-Item -LiteralPath $StagePath
      $Result.stagingRemoved = $true
    } catch { $Result.stagingCleanupError = $_.Exception.Message; $ExitCode = 1 }
  }
  if ($null -ne $LockStream) {
    try {
      $LockStream.Position = 0
      $CheckBytes = New-Object byte[] $LockBytes.Length
      if ($LockStream.Length -ne $LockBytes.Length -or $LockStream.Read($CheckBytes, 0, $CheckBytes.Length) -ne $CheckBytes.Length -or [Text.Encoding]::UTF8.GetString($CheckBytes) -cne $LockText) { throw 'ISOLATED_LOCK_OWNERSHIP_CHANGED' }
    } catch { $Result.cleanupError = $_.Exception.Message; $ExitCode = 1 }
    finally { $LockStream.Dispose() }
    $Result.lockRemoved = -not (Test-Path -LiteralPath $LockPath)
    if (-not $Result.lockRemoved) { $Result.cleanupError = 'ISOLATED_LOCK_PATH_REOCCUPIED'; $ExitCode = 1 }
  }
  if ($ExitCode -and $Result.status -eq 'applied') { $Result.status = 'cleanup-failed' }
  if ($ReportAllowed) {
    try {
      if ($null -eq $JournalStream) {
        [void](Get-TempDirectory $SampleRoot)
        Assert-PlainPath $SampleRoot $Result.resultPath
        $JournalStream = [IO.File]::Open($Result.resultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      }
      Save-Journal
    } catch { $Result.reportError = $_.Exception.Message; $ExitCode = 1 }
    finally { if ($null -ne $JournalStream) { $JournalStream.Dispose() } }
  }
  $Result | ConvertTo-Json -Depth 12 -Compress
}
if ($ExitCode) { exit $ExitCode }
