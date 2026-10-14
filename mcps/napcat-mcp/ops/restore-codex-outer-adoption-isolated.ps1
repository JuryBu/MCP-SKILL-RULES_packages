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
$Result = [ordered]@{ schemaVersion = 1; mode = 'TEMP_ISOLATED_RECOVERY'; ownerId = $OwnerId; status = 'preflight-failed'; phase = 'scope'; targetsMayHaveChanged = $false; completed = @(); failed = $null; resultPath = $null }
$ReportAllowed = $false
$LockStream = $null
$LockPath = $null
$LockValue = [Guid]::NewGuid().ToString('N')
$Plans = @()

function Test-Inside([string]$Root, [string]$Value) {
  return $Value.StartsWith($Root.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-PlainPath([string]$Root, [string]$Value) {
  if (-not (Test-Inside $Root $Value) -and $Root -ine $Value) { throw 'ISOLATED_PATH_OUTSIDE_ROOT' }
  $Current = $Value
  while ($Current) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ISOLATED_REPARSE_POINT_REJECTED' }
      if ($Item.LinkType -eq 'HardLink') { throw 'ISOLATED_HARD_LINK_REJECTED' }
    }
    $Current = Split-Path -Parent $Current
  }
}

function Get-TempDirectory([string]$Value) {
  if (-not [IO.Path]::IsPathRooted($Value)) { throw 'ISOLATED_ABSOLUTE_PATH_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
  $Temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
  if (-not (Test-Inside $Temp $Full)) { throw 'ISOLATED_TEMP_ROOT_REQUIRED' }
  Assert-PlainPath $Temp $Full
  if (-not (Test-Path -LiteralPath $Full -PathType Container)) { throw 'ISOLATED_DIRECTORY_MISSING' }
  return $Full
}

function Get-Sha([string]$Value) {
  return (Get-FileHash -LiteralPath $Value -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-State([string]$Root, [string]$Value) {
  Assert-PlainPath $Root $Value
  if (-not (Test-Path -LiteralPath $Value)) { return [pscustomobject]@{ exists = $false; sha256 = $null; sddl = $null } }
  if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw 'ISOLATED_FILE_EXPECTED' }
  return [pscustomobject]@{ exists = $true; sha256 = (Get-Sha $Value); sddl = (Get-Acl -LiteralPath $Value).GetSecurityDescriptorSddlForm($Sections) }
}

function Assert-SameState($Before, $After) {
  if ($Before.exists -ne $After.exists -or $Before.sha256 -cne $After.sha256 -or $Before.sddl -cne $After.sddl) { throw 'ISOLATED_CONCURRENT_DRIFT' }
}

function Assert-SavedDescriptor([string]$Sddl) {
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  if ($null -eq $Descriptor.Owner -or $null -eq $Descriptor.Group -or $null -eq $Descriptor.DiscretionaryAcl -or $null -ne $Descriptor.SystemAcl) { throw 'ISOLATED_OWNER_GROUP_DACL_REQUIRED' }
}

function Initialize-NativeAcl {
  if ('OuterAdoptionIsolated.NativeAcl' -as [type]) { return }
  $Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('OuterAdoptionIsolated.NativeAcl'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $Module = $Assembly.DefineDynamicModule('NativeAcl')
  $Builder = $Module.DefineType('OuterAdoptionIsolated.NativeAcl', [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
  $Attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
  $Setter = $Builder.DefinePInvokeMethod('Set', 'advapi32.dll', 'SetNamedSecurityInfoW', $Attributes, [Reflection.CallingConventions]::Standard, [uint32], [type[]]@([string], [int], [uint32], [byte[]], [byte[]], [byte[]], [IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $RawSetter = $Builder.DefinePInvokeMethod('SetRaw', 'advapi32.dll', 'SetFileSecurityW', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([string], [uint32], [byte[]]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $Setter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $RawSetter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  [void]$Builder.CreateType()
}

function Set-SavedAcl([string]$Value, [string]$Sddl) {
  Initialize-NativeAcl
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  [uint32]$Information = 7
  if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) { $Information = $Information -bor [uint32]2147483648 }
  else { $Information = $Information -bor [uint32]536870912 }
  if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0) {
    $OwnerBytes = [byte[]]::new($Descriptor.Owner.BinaryLength)
    $GroupBytes = [byte[]]::new($Descriptor.Group.BinaryLength)
    $DaclBytes = [byte[]]::new($Descriptor.DiscretionaryAcl.BinaryLength)
    $Descriptor.Owner.GetBinaryForm($OwnerBytes, 0)
    $Descriptor.Group.GetBinaryForm($GroupBytes, 0)
    $Descriptor.DiscretionaryAcl.GetBinaryForm($DaclBytes, 0)
    $ReturnCode = [OuterAdoptionIsolated.NativeAcl]::Set($Value, 1, $Information, $OwnerBytes, $GroupBytes, $DaclBytes, [IntPtr]::Zero)
    if ($ReturnCode -ne 0) { throw ('ISOLATED_ACL_WRITE_FAILED: ' + $ReturnCode) }
  } else {
    $DescriptorBytes = [byte[]]::new($Descriptor.BinaryLength)
    $Descriptor.GetBinaryForm($DescriptorBytes, 0)
    if (-not [OuterAdoptionIsolated.NativeAcl]::SetRaw($Value, $Information, $DescriptorBytes)) { throw 'ISOLATED_ACL_WRITE_FAILED' }
  }
  if ((Get-Acl -LiteralPath $Value).GetSecurityDescriptorSddlForm($Sections) -cne $Sddl) { throw 'ISOLATED_ACL_RESTORE_MISMATCH' }
}

function New-RestorePlan([string]$Name, [string]$Target, [string]$Backup, $Original, [string]$CandidateSha) {
  if ($CandidateSha -notmatch '^[0-9a-f]{64}$' -or $Original.exists -isnot [bool]) { throw 'ISOLATED_RECORD_INVALID' }
  $Before = Get-State $SampleRoot $Target
  $Action = 'absent'
  if ($Original.exists) {
    if ($Original.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'ISOLATED_RECORD_INVALID' }
    Assert-SavedDescriptor $Original.sddl
    $Saved = Get-State $PreparationRoot $Backup
    if (-not $Saved.exists -or $Saved.sha256 -cne $Original.sha256 -or (Get-Item -LiteralPath $Backup).Length -ne $Original.length) { throw ('ISOLATED_BACKUP_SHA_MISMATCH: ' + $Name) }
    if ($Before.exists -and $Before.sha256 -cne $CandidateSha -and $Before.sha256 -cne $Original.sha256) { throw ('ISOLATED_TARGET_DRIFT: ' + $Name) }
    $Action = if ($Before.exists -and $Before.sha256 -ceq $Original.sha256 -and $Before.sddl -ceq $Original.sddl) { 'retained' } else { 'restore' }
  } elseif ($Before.exists) {
    if ($Before.sha256 -cne $CandidateSha) { throw ('ISOLATED_ADDED_FILE_DRIFT: ' + $Name) }
    $Action = 'remove'
  }
  return [pscustomobject]@{ name = $Name; target = $Target; backup = $Backup; original = $Original; candidateSha = $CandidateSha; before = $Before; action = $Action }
}

try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') { throw 'ISOLATED_WINDOWS_POWERSHELL_51_REQUIRED' }
  if ((Get-ExecutionPolicy).ToString() -eq 'Bypass' -or (Get-ExecutionPolicy -Scope Process).ToString() -eq 'Bypass') { throw 'ISOLATED_BYPASS_POLICY_REJECTED' }
  if ($OwnerId -notmatch '^[A-Za-z0-9_.:-]{1,128}$' -or $PreparationSha256 -notmatch '^[0-9a-f]{64}$') { throw 'ISOLATED_IDENTITY_INVALID' }
  $SampleRoot = Get-TempDirectory $SampleRoot
  $PreparationRoot = Get-TempDirectory $PreparationRoot
  if ($SampleRoot -ieq $PreparationRoot -or (Test-Inside $SampleRoot $PreparationRoot) -or (Test-Inside $PreparationRoot $SampleRoot)) { throw 'ISOLATED_ROOTS_OVERLAP' }
  $AnchorPath = Join-Path $SampleRoot '.outer-adoption-isolated-owner.json'
  Assert-PlainPath $SampleRoot $AnchorPath
  $Anchor = Get-Content -LiteralPath $AnchorPath -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($Anchor.schemaVersion -ne 1 -or $Anchor.mode -cne 'TEMP_ISOLATED_RECOVERY' -or $Anchor.ownerId -cne $OwnerId -or $Anchor.sampleRoot -ine $SampleRoot -or $Anchor.preparationRoot -ine $PreparationRoot -or $Anchor.preparationSha256 -cne $PreparationSha256) { throw 'ISOLATED_OWNERSHIP_MISMATCH' }
  $AnchorSha = Get-Sha $AnchorPath
  $ReportAllowed = $true
  $Result.resultPath = Join-Path $SampleRoot ('recovery-result-' + [Guid]::NewGuid().ToString('N') + '.json')
  $InstalledRoot = Get-TempDirectory (Join-Path $SampleRoot 'installed')
  $DataRoot = Get-TempDirectory (Join-Path $SampleRoot 'data')
  $ManifestPath = Join-Path $PreparationRoot 'preparation.json'
  Assert-PlainPath $PreparationRoot $ManifestPath
  if ((Get-Sha $ManifestPath) -cne $PreparationSha256) { throw 'ISOLATED_PREPARATION_SHA_MISMATCH' }
  $Manifest = Get-Content -LiteralPath $ManifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
  if ($Manifest.schemaVersion -ne 1 -or $Manifest.mode -cne 'PREPARE_ONLY' -or $Manifest.ownerId -cne $OwnerId -or $Manifest.readyForProduction -ne $false -or $Manifest.productionChanged -ne $false) { throw 'ISOLATED_PREPARATION_IDENTITY_MISMATCH' }
  $ExpectedNames = @(
    'ops/codex-outer-runtime.mjs', 'ops/start-codex-app-server-proxy.ps1', 'ops/resolve-napcat-data-root.ps1', 'ops/resolve-codex-outer-runtime-startup.ps1',
    'src/atomic-file.mjs', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs', 'src/codex-request-metadata.mjs', 'src/codex-display-policy.mjs', 'src/codex-runtime-bundle.mjs',
    'src/observability-utils.mjs', 'src/outer-engine.mjs', 'src/outer-runtime-contract.mjs', 'src/outer-runtime-host.mjs', 'src/outer-runtime-selection.mjs',
    'src/outer-runtime.mjs', 'src/reasoning-placeholder.mjs', 'src/turn-observability.mjs', 'src/wake-visibility.mjs'
  )
  if (@($Manifest.files).Count -ne 19 -or ((@($Manifest.files.name | Sort-Object) -join '|') -cne (@($ExpectedNames | Sort-Object) -join '|'))) { throw 'ISOLATED_FIXED_FILE_SET_REQUIRED' }
  $Result.phase = 'preflight'
  foreach ($Entry in $Manifest.files) {
    $ExpectedOperation = if (-not $Entry.original.exists) { 'add' } elseif ($Entry.original.sha256 -ceq $Entry.candidate.sha256) { 'unchanged' } else { 'replace' }
    if ($Entry.operation -cne $ExpectedOperation) { throw 'ISOLATED_OPERATION_MISMATCH' }
    $Plans += New-RestorePlan $Entry.name (Join-Path $InstalledRoot $Entry.name) (Join-Path $PreparationRoot ('original/' + $Entry.name)) $Entry.original $Entry.candidate.sha256
  }
  $Plans += New-RestorePlan 'state/codex-outer-runtime-startup.json' (Join-Path $DataRoot 'state/codex-outer-runtime-startup.json') (Join-Path $PreparationRoot 'original-startup.json') $Manifest.startup.original $Manifest.startup.sha256
  $Preserved = @()
  foreach ($Name in @('codex-app-server-wake-journal.json', 'codex-app-server-proxy-token.txt', 'task-registry.json', 'codex-model-stream-proxy-runtime.json')) {
    $Value = Join-Path $DataRoot ('state/' + $Name)
    $Preserved += [pscustomobject]@{ path = $Value; before = (Get-State $SampleRoot $Value) }
  }
  $LockPath = Join-Path $SampleRoot '.outer-adoption-isolated-recovery.lock'
  Assert-PlainPath $SampleRoot $LockPath
  $LockStream = [IO.File]::Open($LockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $LockBytes = [Text.Encoding]::UTF8.GetBytes($LockValue)
  $LockStream.Write($LockBytes, 0, $LockBytes.Length)
  $Result.phase = 'restore'
  foreach ($Plan in $Plans) {
    if ((Get-Sha $ManifestPath) -cne $PreparationSha256 -or (Get-Sha $AnchorPath) -cne $AnchorSha) { throw 'ISOLATED_INPUT_DRIFT' }
    Assert-SameState $Plan.before (Get-State $SampleRoot $Plan.target)
    if ($Plan.action -eq 'restore') {
      $Saved = Get-State $PreparationRoot $Plan.backup
      if (-not $Saved.exists -or $Saved.sha256 -cne $Plan.original.sha256) { throw 'ISOLATED_BACKUP_SHA_MISMATCH' }
      $Result.targetsMayHaveChanged = $true
      New-Item -ItemType Directory -Path (Split-Path -Parent $Plan.target) -Force | Out-Null
      Assert-PlainPath $SampleRoot $Plan.target
      Copy-Item -LiteralPath $Plan.backup -Destination $Plan.target -Force
      Set-SavedAcl $Plan.target $Plan.original.sddl
      Assert-SameState ([pscustomobject]@{ exists = $true; sha256 = $Plan.original.sha256; sddl = $Plan.original.sddl }) (Get-State $SampleRoot $Plan.target)
    } elseif ($Plan.action -eq 'remove') {
      $Result.targetsMayHaveChanged = $true
      Remove-Item -LiteralPath $Plan.target
      if (Test-Path -LiteralPath $Plan.target) { throw 'ISOLATED_REMOVE_FAILED' }
    }
    $Result.completed += [pscustomobject]@{ name = $Plan.name; action = $Plan.action; verified = $true }
  }
  $Result.phase = 'verification'
  foreach ($State in $Preserved) { Assert-SameState $State.before (Get-State $SampleRoot $State.path) }
  $Result.preservedStateVerified = $true
  $Result.status = 'restored'
} catch {
  $Result.failed = [pscustomobject]@{ message = $_.Exception.Message; phase = $Result.phase; target = $(if ($null -ne $Plan) { $Plan.name } else { $null }) }
  if ($Result.targetsMayHaveChanged) { $Result.status = 'partial' }
  $ExitCode = 1
} finally {
  if ($null -ne $LockStream) {
    $LockStream.Dispose()
    try {
      Assert-PlainPath $SampleRoot $LockPath
      if ((Get-Content -LiteralPath $LockPath -Encoding UTF8 -Raw) -cne $LockValue) { throw 'ISOLATED_LOCK_OWNERSHIP_CHANGED' }
      Remove-Item -LiteralPath $LockPath
      $Result.lockRemoved = $true
    } catch { $Result.cleanupError = $_.Exception.Message; $ExitCode = 1; if ($Result.status -eq 'restored') { $Result.status = 'cleanup-failed' } }
  }
  if ($ReportAllowed) {
    try {
      Assert-PlainPath $SampleRoot $Result.resultPath
      $Stream = [IO.File]::Open($Result.resultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $Bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Result | ConvertTo-Json -Depth 8)); $Stream.Write($Bytes, 0, $Bytes.Length) }
      finally { $Stream.Dispose() }
    } catch { $Result.reportError = $_.Exception.Message; $ExitCode = 1 }
  }
  $Result | ConvertTo-Json -Depth 8 -Compress
}
if ($ExitCode) { exit $ExitCode }
