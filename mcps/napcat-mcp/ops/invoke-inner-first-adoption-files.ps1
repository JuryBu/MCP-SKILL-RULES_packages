[CmdletBinding()]
param(
  [ValidateSet('Prepare', 'Status', 'Apply', 'Restore')][string]$Action = 'Status',
  [ValidateSet('Production', 'TempFixture')][string]$Mode = 'Production',
  [string]$FreezeManifestPath = '', [string]$FreezeManifestSha256 = '',
  [string]$TransactionRoot = '', [string]$PlanSha256 = '',
  [string]$OwnerId = '', [string]$TransactionId = '', [string]$OwnerConfirmation = '',
  [int]$FixtureFailAfterWrites = -1, [switch]$FixtureUnknownAfterWrite
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Utf8 = [Text.UTF8Encoding]::new($false)
$Scope = 'inner-first-adoption-files-v1'
$Sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ReceiptStream = $null
$Mutex = $null
$MutexOwned = $false
$Receipt = $null
$Plan = $null
$ExitCode = 0
$TargetWrites = 0
$DirectoryWrites = 0
$OperationStarted = $false
$Result = [ordered]@{ scope = $Scope; action = $Action; mode = $Mode; status = 'REFUSED'; serviceActions = 0; targetWrites = 0; error = $null }
$Allowed = @(
  'src/inner-runtime-profile.mjs', 'src/inner-managed-session.mjs',
  'src/inner-proxy-coordinator.mjs', 'src/inner-native-turn-source.mjs',
  'src/inner-handoff-compatibility.mjs', 'src/inner-migration-plan.mjs',
  'src/inner-runner-handoff-control.mjs',
  'src/thread-recovery-handoff.mjs', 'src/codex-model-stream-proxy.mjs',
  'src/codex-model-stream-proxy-runner.mjs', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs',
  'src/tool-delivery-profile.mjs', 'src/codex-stream-recovery.mjs', 'src/tool-preparation-deadline.mjs',
  'src/reasoning-progress.mjs', 'src/partial-response-progress.mjs', 'src/model-stream-failure-diagnostics.mjs',
  'ops/resolve-codex-outer-runtime-startup.ps1', 'ops/start-codex-app-server-proxy.ps1',
  'ops/start-codex-model-stream-proxy.ps1', 'ops/get-codex-model-stream-proxy-status.ps1',
  'state/codex-outer-runtime-startup.json', 'state/inner-managed/inner-managed-profile.json',
  'state/inner-managed/.inner-runtime-owner.json', 'state/inner-managed/checkpoints/.inner-runtime-owner.json'
)
$Required = @(
  'src/inner-runtime-profile.mjs', 'src/inner-managed-session.mjs',
  'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs', 'src/codex-model-stream-proxy-runner.mjs',
  'src/codex-model-stream-proxy.mjs', 'src/thread-recovery-handoff.mjs',
  'src/inner-runner-handoff-control.mjs', 'ops/resolve-codex-outer-runtime-startup.ps1',
  'ops/start-codex-app-server-proxy.ps1',
  'state/codex-outer-runtime-startup.json', 'state/inner-managed/inner-managed-profile.json',
  'state/inner-managed/.inner-runtime-owner.json', 'state/inner-managed/checkpoints/.inner-runtime-owner.json'
)

function Fail([string]$Code) { throw $Code }
function Plain([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':') -or $Value -match '[*?\x00]' -or @($Value -split '[\\/]' | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) { Fail 'PATH_NOT_PLAIN_ABSOLUTE' }
  $Full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
  if ($Full.Length -le 3) { Fail 'DRIVE_ROOT_FORBIDDEN' }
  $Current = $Full
  while ($Current) {
    $Attributes = $null
    try { $Attributes = [IO.File]::GetAttributes($Current) } catch [IO.FileNotFoundException] {} catch [IO.DirectoryNotFoundException] {}
    if ($null -ne $Attributes) {
      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'PATH_LINK_FORBIDDEN' }
      if (($Attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        if ((Get-Item -LiteralPath $Current -Force).LinkType) { Fail 'PATH_LINK_FORBIDDEN' }
        $Streams = @(Get-Item -LiteralPath $Current -Stream * -Force -ErrorAction Stop)
        if (@($Streams | Where-Object { $_.Stream -ne ':$DATA' -and $_.Stream -ne '$DATA' }).Count) { Fail 'PATH_ADS_FORBIDDEN' }
      }
    }
    $Current = Split-Path -Parent $Current
  }
  return $Full
}
function Within([string]$Root, [string]$Value) { return $Value.StartsWith($Root.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase) }
function Sha([string]$Path) {
  $Stream = [IO.File]::OpenRead((Plain $Path)); $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose(); $Stream.Dispose() }
}
function TextSha([string]$Value) { $Hasher = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($Hasher.ComputeHash($Utf8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() } finally { $Hasher.Dispose() } }
function ReadJson([string]$Path) {
  $Path = Plain $Path
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Item -LiteralPath $Path -Force).Length -gt 1048576) { Fail 'BOUNDED_JSON_REQUIRED' }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Sddl([string]$Path) {
  $Path = Plain $Path
  $Info = if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::Directory) -ne 0) { [IO.DirectoryInfo]::new($Path) } else { [IO.FileInfo]::new($Path) }
  return $Info.GetAccessControl($Sections).GetSecurityDescriptorSddlForm($Sections)
}
function Snapshot([string]$Path) {
  $Path = Plain $Path
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{ exists = $false; sha256 = $null; sddl = $null; attributes = $null } }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail 'REGULAR_FILE_REQUIRED' }
  return [pscustomobject]@{ exists = $true; sha256 = (Sha $Path); sddl = (Sddl $Path); attributes = [int][IO.File]::GetAttributes($Path) }
}
function EqualState($Left, $Right) { return $Left.exists -eq $Right.exists -and $Left.sha256 -ceq $Right.sha256 -and $Left.sddl -ceq $Right.sddl -and $Left.attributes -eq $Right.attributes }
function AssertState($Expected, [string]$Path) { if (-not (EqualState $Expected (Snapshot $Path))) { Fail ('TARGET_SHA_ACL_ATTRIBUTES_DRIFT:' + $Path) } }
function Target([string]$Name, $Binding) {
  $Root = if ($Name.StartsWith('state/', [StringComparison]::Ordinal)) { $Binding.dataRoot } else { $Binding.installedRoot }
  return Plain (Join-Path $Root $Name)
}
function AssertIdentity($Binding) {
  if ($Binding.schemaVersion -ne 1 -or $Binding.scope -cne $Scope -or $Binding.mode -cne $Mode -or $Binding.ownerId -cne $OwnerId -or $Binding.transactionId -cne $TransactionId -or $Binding.operatorSid -cne $Sid -or $OwnerId -cnotmatch '^[A-Za-z0-9_.:-]{1,128}$' -or $TransactionId -cnotmatch '^[A-Za-z0-9_.-]{1,128}$') { Fail 'EXACT_IDENTITY_REQUIRED' }
}
function AssertRoots($Binding) {
  $Roots = @(@($Binding.candidateRoot, $Binding.installedRoot, $Binding.dataRoot, $TransactionRoot) | ForEach-Object { Plain $_ })
  for ($Left = 0; $Left -lt $Roots.Count; $Left++) {
    for ($Right = $Left + 1; $Right -lt $Roots.Count; $Right++) {
      if ($Left -eq 1 -and $Right -eq 2 -and (Within $Roots[$Right] $Roots[$Left])) { continue }
      if ($Roots[$Left] -ieq $Roots[$Right] -or (Within $Roots[$Left] $Roots[$Right]) -or (Within $Roots[$Right] $Roots[$Left])) { Fail 'DISTINCT_NONOVERLAPPING_ROOTS_REQUIRED' }
    }
  }
  foreach ($Root in @($Binding.installedRoot, $Binding.dataRoot)) {
    if ([IO.Path]::GetPathRoot($Root) -ine [IO.Path]::GetPathRoot($TransactionRoot)) { Fail 'RECOVERY_SAME_VOLUME_REQUIRED' }
  }
  if ($Mode -eq 'TempFixture') {
    $FixtureRoot = Plain $Binding.fixtureRoot
    $Temp = [IO.Path]::GetTempPath().TrimEnd('\', '/')
    if (-not (Within $Temp $FixtureRoot)) { Fail 'OWNED_TEMP_FIXTURE_REQUIRED' }
    foreach ($Root in $Roots) { if (-not (Within $FixtureRoot $Root)) { Fail 'TEMP_FIXTURE_ESCAPE' } }
    $Marker = ReadJson (Join-Path $FixtureRoot '.inner-first-adoption-fixture-owner.json')
    if ($Marker.schemaVersion -ne 1 -or $Marker.scope -cne $Scope -or $Marker.ownerId -cne $OwnerId -or $Marker.transactionId -cne $TransactionId -or $Marker.operatorSid -cne $Sid) { Fail 'TEMP_FIXTURE_OWNER_CONFLICT' }
  } elseif ($FixtureFailAfterWrites -ge 0 -or $FixtureUnknownAfterWrite) { Fail 'PRODUCTION_FAULT_INJECTION_FORBIDDEN' }
}
function AssertNames($Items) {
  $Names = @($Items | ForEach-Object { $_.name })
  if ($Names.Count -lt $Required.Count -or $Names.Count -gt $Allowed.Count -or @($Names | Sort-Object -Unique).Count -ne $Names.Count) { Fail 'EXACT_FILE_SET_REQUIRED' }
  foreach ($Name in $Names) { if ($Allowed -cnotcontains $Name) { Fail ('FILE_NOT_ALLOWLISTED:' + $Name) } }
  foreach ($Name in $Required) { if ($Names -cnotcontains $Name) { Fail ('REQUIRED_FILE_MISSING:' + $Name) } }
}
function AssertAcl([string]$Saved) {
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Saved)
  if (-not $Descriptor.Owner -or -not $Descriptor.Group -or $null -eq $Descriptor.DiscretionaryAcl -or $Descriptor.SystemAcl) { Fail 'OWNER_GROUP_DACL_REQUIRED' }
}
function InitializeNativeSecurity {
  if (-not ('InnerFirstAdoption.NativeSecurity' -as [type])) {
    $Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('InnerFirstAdoption.NativeSecurity'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $Builder = $Assembly.DefineDynamicModule('NativeSecurity').DefineType('InnerFirstAdoption.NativeSecurity', [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
    $Attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
    $Setter = $Builder.DefinePInvokeMethod('Set', 'advapi32.dll', 'SetNamedSecurityInfoW', $Attributes, [Reflection.CallingConventions]::Standard, [uint32], [type[]]@([string], [int], [uint32], [byte[]], [byte[]], [byte[]], [IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $RawSetter = $Builder.DefinePInvokeMethod('SetRaw', 'advapi32.dll', 'SetFileSecurityW', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([string], [uint32], [byte[]]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $Creator = $Builder.DefinePInvokeMethod('OpenDirectory', 'kernel32.dll', 'CreateFileW', $Attributes, [Reflection.CallingConventions]::Standard, [IntPtr], [type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $Getter = $Builder.DefinePInvokeMethod('Information', 'kernel32.dll', 'GetFileInformationByHandle', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([IntPtr], [byte[]]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $Closer = $Builder.DefinePInvokeMethod('Close', 'kernel32.dll', 'CloseHandle', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    foreach ($Method in @($Setter, $RawSetter, $Creator, $Getter, $Closer)) { $Method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig) }
    [void]$Builder.CreateType()
  }
}
function DirectoryIdentity([string]$Path) {
  [void](Plain $Path); InitializeNativeSecurity
  $Handle = [InnerFirstAdoption.NativeSecurity]::OpenDirectory($Path, 0, 7, [IntPtr]::Zero, 3, 33554432, [IntPtr]::Zero)
  if ($Handle -eq [IntPtr]::new(-1)) { Fail 'DIRECTORY_IDENTITY_UNKNOWN' }
  try {
    $Bytes = [byte[]]::new(52)
    if (-not [InnerFirstAdoption.NativeSecurity]::Information($Handle, $Bytes)) { Fail 'DIRECTORY_IDENTITY_UNKNOWN' }
    return ([BitConverter]::ToUInt32($Bytes, 28).ToString('x8') + ':' + [BitConverter]::ToUInt32($Bytes, 44).ToString('x8') + ':' + [BitConverter]::ToUInt32($Bytes, 48).ToString('x8'))
  } finally { [void][InnerFirstAdoption.NativeSecurity]::Close($Handle) }
}
function NativeSecurity([string]$Path, [string]$Saved) {
  AssertAcl $Saved; InitializeNativeSecurity
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Saved)
  [uint32]$Information = 7
  $Information = $Information -bor $(if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) { [uint32]2147483648 } else { [uint32]536870912 })
  if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0) {
    $OwnerBytes = [byte[]]::new($Descriptor.Owner.BinaryLength); $GroupBytes = [byte[]]::new($Descriptor.Group.BinaryLength); $DaclBytes = [byte[]]::new($Descriptor.DiscretionaryAcl.BinaryLength)
    $Descriptor.Owner.GetBinaryForm($OwnerBytes, 0); $Descriptor.Group.GetBinaryForm($GroupBytes, 0); $Descriptor.DiscretionaryAcl.GetBinaryForm($DaclBytes, 0)
    if ([InnerFirstAdoption.NativeSecurity]::Set($Path, 1, $Information, $OwnerBytes, $GroupBytes, $DaclBytes, [IntPtr]::Zero) -ne 0) { Fail 'ACL_RESTORE_FAILED' }
  } else {
    $Bytes = [byte[]]::new($Descriptor.BinaryLength); $Descriptor.GetBinaryForm($Bytes, 0)
    if (-not [InnerFirstAdoption.NativeSecurity]::SetRaw($Path, $Information, $Bytes)) { Fail 'ACL_RESTORE_FAILED' }
  }
  if ((Sddl $Path) -cne $Saved) { Fail 'ACL_RESTORE_MISMATCH' }
}
function AssertProcesses($Processes, [switch]$Preparing) {
  if ($Mode -eq 'Production' -and (@($Processes | Where-Object { $_.role -ceq 'outer' }).Count -ne 1 -or @($Processes | Where-Object { $_.role -ceq 'inner' }).Count -ne 1)) { Fail 'OUTER_INNER_PROCESS_IDENTITIES_REQUIRED' }
  $Seen = @{}
  foreach ($Protected in $Processes) {
    if ($Protected.role -cnotin @('outer', 'inner', 'child') -or $Protected.pid -isnot [int] -or $Protected.pid -le 0 -or $Seen.ContainsKey([string]$Protected.pid) -or $Protected.creationTimeUtc -notmatch '(Z|[+]00:00)$' -or -not $Protected.executablePath) { Fail 'PROCESS_IDENTITY_UNKNOWN' }
    $Seen[[string]$Protected.pid] = $true
    $Matches = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $Protected.pid) -ErrorAction Stop)
    if ($Matches.Count -gt 1) { Fail 'PROCESS_IDENTITY_UNKNOWN' }
    if ($Matches.Count -eq 0) { if ($Preparing) { Fail 'PROCESS_IDENTITY_UNKNOWN' }; continue }
    $Observed = $Matches[0]
    if (-not $Observed.CreationDate -or -not $Observed.ExecutablePath) { Fail 'PROCESS_IDENTITY_UNKNOWN' }
    if (([DateTime]$Observed.CreationDate).ToUniversalTime().Ticks -ne [DateTimeOffset]::Parse($Protected.creationTimeUtc).UtcDateTime.Ticks -or [string]$Observed.ExecutablePath -ine $Protected.executablePath) { Fail 'PROTECTED_PID_REUSED_OR_DRIFTED' }
    if (-not $Preparing) { Fail ('PROTECTED_PROCESS_STILL_RUNNING:' + $Protected.role) }
  }
  if (-not $Preparing -and $Mode -eq 'Production') {
    foreach ($Observed in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'codex.exe' OR Name = 'ChatGPT.exe'" -ErrorAction Stop)) {
      if (-not $Observed.CommandLine -or -not $Observed.CreationDate) { Fail 'RUNTIME_PROCESS_STATE_UNKNOWN' }
      if ([string]$Observed.CommandLine -match 'codex-app-server-proxy|codex-model-stream-proxy|inner-managed-session' -and ([string]$Observed.CommandLine).IndexOf($Plan.installedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Fail 'ADOPTED_RUNTIME_STILL_RUNNING' }
    }
  }
}
function AssertIndependentTerminal {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -cne 'Desktop' -or (Get-ExecutionPolicy -Scope Process) -ne 'Undefined' -or (Get-ExecutionPolicy) -eq 'Bypass') { Fail 'ORDINARY_WINDOWS_POWERSHELL_REQUIRED' }
  $ProcessId = $PID; $Seen = @{}; $ChildCreated = $null; $Session = $null
  for ($Depth = 0; $Depth -lt 32 -and $ProcessId; $Depth++) {
    if ($Seen.ContainsKey([string]$ProcessId)) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Seen[[string]$ProcessId] = $true
    $Matches = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop)
    if ($Matches.Count -ne 1) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Observed = $Matches[0]
    if (-not $Observed.ExecutablePath -or -not $Observed.CommandLine -or -not $Observed.CreationDate -or $null -eq $Observed.SessionId -or [string]$Observed.CommandLine -match 'app-server|mcp-http-broker|sandbox-data|codex-command-runner|codex-windows-sandbox|WindowsJobRunner' -or [string]$Observed.Name -match '^(ChatGPT|codex|WindowsJobRunner)\.exe$') { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Created = ([DateTime]$Observed.CreationDate).ToUniversalTime()
    if ($ChildCreated -and $Created -gt $ChildCreated) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ($null -eq $Session) { $Session = [int]$Observed.SessionId }
    if ([int]$Observed.SessionId -ne $Session) { Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ([string]$Observed.Name -ieq 'explorer.exe' -and [string]$Observed.ExecutablePath -ieq (Join-Path $env:SystemRoot 'explorer.exe')) { return }
    $ChildCreated = $Created; $ProcessId = [int]$Observed.ParentProcessId
  }
  Fail 'INDEPENDENT_OWNER_TERMINAL_REQUIRED'
}
function SaveReceipt {
  $Bytes = $Utf8.GetBytes(($Receipt | ConvertTo-Json -Depth 18))
  $ReceiptStream.Position = 0; $ReceiptStream.Write($Bytes, 0, $Bytes.Length); $ReceiptStream.SetLength($Bytes.Length); $ReceiptStream.Flush($true)
}
function AssertProfile($Binding, $Items) {
  $Profile = ReadJson (Join-Path $Binding.candidateRoot 'state/inner-managed/inner-managed-profile.json')
  $Startup = ReadJson (Join-Path $Binding.candidateRoot 'state/codex-outer-runtime-startup.json')
  if ($Profile.schemaVersion -ne 1 -or $Profile.mode -cne 'production' -or $Profile.installationRoot -ine $Binding.installedRoot -or $Profile.initial.runnerPath -ine (Join-Path $Binding.installedRoot 'src/codex-model-stream-proxy-runner.mjs')) { Fail 'PROFILE_INSTALLATION_BINDING_REQUIRED' }
  $ProfileFile = @($Items | Where-Object { $_.name -ceq 'state/inner-managed/inner-managed-profile.json' })[0]
  $ManagedRoot = Join-Path $Binding.dataRoot 'state/inner-managed'; $CheckpointRoot = Join-Path $ManagedRoot 'checkpoints'
  if ($Profile.stateRoot -ine $ManagedRoot -or $Profile.checkpointRoot -ine $CheckpointRoot -or $Profile.outerStateRoot -ine (Join-Path $Binding.dataRoot 'state')) { Fail 'EXCLUSIVE_INNER_ROOTS_SHARED_OUTER_STATE_REQUIRED' }
  foreach ($Definition in @(@{ name = 'state/inner-managed/.inner-runtime-owner.json'; kind = 'state' }, @{ name = 'state/inner-managed/checkpoints/.inner-runtime-owner.json'; kind = 'checkpoint' })) {
    $Marker = ReadJson (Join-Path $Binding.candidateRoot $Definition.name)
    if ($Marker.schemaVersion -ne 1 -or $Marker.kind -cne $Definition.kind -or $Marker.ownerId -cne $Profile.ownerId -or $Marker.nativeSourceId -cne $Profile.nativeSourceId -or -not $Marker.ownerId -or -not $Marker.nativeSourceId) { Fail 'EXCLUSIVE_ROOT_MARKER_BINDING_REQUIRED' }
    $ExistingMarkerPath = Target $Definition.name $Binding
    if (Test-Path -LiteralPath $ExistingMarkerPath) {
      $ExistingMarker = ReadJson $ExistingMarkerPath
      if ($ExistingMarker.schemaVersion -ne 1 -or $ExistingMarker.ownerId -cne $Marker.ownerId -or $ExistingMarker.nativeSourceId -cne $Marker.nativeSourceId -or $ExistingMarker.kind -cne $Marker.kind) { Fail 'EXCLUSIVE_ROOT_OWNER_CONFLICT' }
    }
  }
  if ($Startup.schemaVersion -ne 1 -or $Startup.enabled -ne $true -or $Startup.innerManagedProfilePath -ine (Join-Path $ManagedRoot 'inner-managed-profile.json') -or $Startup.innerManagedProfileSha256 -cne $ProfileFile.sha256) { Fail 'STARTUP_PROFILE_BINDING_REQUIRED' }
  $OuterRuntimeRoot = Plain $Startup.candidateRoot
  if (-not (Within (Plain $Binding.dataRoot) $OuterRuntimeRoot) -or -not (Test-Path -LiteralPath $OuterRuntimeRoot -PathType Container) -or $OuterRuntimeRoot -ieq $ManagedRoot -or (Within $ManagedRoot $OuterRuntimeRoot)) { Fail 'EXISTING_OUTER_RUNTIME_ROOT_REQUIRED' }
  $OriginalStartupPath = Target 'state/codex-outer-runtime-startup.json' $Binding
  if (Test-Path -LiteralPath $OriginalStartupPath) {
    $OriginalStartup = ReadJson $OriginalStartupPath
    if ($OriginalStartup.schemaVersion -ne 1 -or $OriginalStartup.candidateRoot -ine $OuterRuntimeRoot) { Fail 'OUTER_RUNTIME_SELECTION_CHANGE_FORBIDDEN' }
  } elseif ($Mode -eq 'Production') { Fail 'ORIGINAL_OUTER_STARTUP_REQUIRED' }
  $ProfileNames = @{ runner = 'src/codex-model-stream-proxy-runner.mjs'; core = 'src/codex-model-stream-proxy.mjs'; helper = 'src/thread-recovery-handoff.mjs'; control = 'src/inner-runner-handoff-control.mjs' }
  foreach ($Key in $ProfileNames.Keys) {
    $Entry = @($Items | Where-Object { $_.name -ceq $ProfileNames[$Key] })[0]
    if ($Profile.initial.expectedHashes.$Key -cne $Entry.sha256) { Fail 'PROFILE_FROZEN_HASH_MISMATCH' }
  }
  return $OuterRuntimeRoot
}
function AssertDependencyGraph($Binding, $Items, $Dependencies) {
  $Entries = @{}; $ReadOnly = @{}; $Reached = @{}
  foreach ($Entry in $Items) { $Entries[$Entry.name] = $Entry }
  foreach ($Dependency in $Dependencies) {
    if ($Dependency.name -cnotmatch '^(?:src/[a-zA-Z0-9_-]+\.mjs|ops/[a-zA-Z0-9_-]+\.(?:ps1|mjs))$' -or $Allowed -ccontains $Dependency.name -or $ReadOnly.ContainsKey($Dependency.name) -or $Dependency.sha256 -cnotmatch '^[a-f0-9]{64}$') { Fail 'READONLY_DEPENDENCY_IDENTITY_REQUIRED' }
    if ((Sha (Join-Path $Binding.candidateRoot $Dependency.name)) -cne $Dependency.sha256 -or (Sha (Join-Path $Binding.installedRoot $Dependency.name)) -cne $Dependency.sha256) { Fail 'READONLY_DEPENDENCY_DRIFT' }
    $ReadOnly[$Dependency.name] = $Dependency
  }
  $Queue = [Collections.Generic.Queue[string]]::new()
  foreach ($Name in @('src/codex-app-server-proxy-runner.mjs', 'src/codex-model-stream-proxy-runner.mjs', 'src/inner-managed-session.mjs') + @($Items | Where-Object { $_.name.StartsWith('ops/') } | ForEach-Object { $_.name })) { $Queue.Enqueue($Name) }
  while ($Queue.Count) {
    $Name = $Queue.Dequeue()
    if ($Reached.ContainsKey($Name)) { continue }; $Reached[$Name] = $true
    if (-not $Entries.ContainsKey($Name) -and -not $ReadOnly.ContainsKey($Name)) { Fail ('DEPENDENCY_NOT_FROZEN:' + $Name) }
    $Content = Get-Content -LiteralPath (Plain (Join-Path $Binding.candidateRoot $Name)) -Encoding UTF8 -Raw
    if ($Name.EndsWith('.mjs')) {
      foreach ($Match in [regex]::Matches($Content, '(?:from\s*|import\s*\(\s*|import\s*)["''](\./[A-Za-z0-9_-]+\.mjs)["'']')) { $Queue.Enqueue(($Name.Split('/')[0] + '/') + $Match.Groups[1].Value.Substring(2)) }
    } else {
      foreach ($Match in [regex]::Matches($Content, 'Join-Path\s+\$PSScriptRoot\s+["'']([A-Za-z0-9_-]+\.(?:ps1|mjs))["'']')) { $Queue.Enqueue('ops/' + $Match.Groups[1].Value) }
      foreach ($Match in [regex]::Matches($Content, '["''](src[\\/][A-Za-z0-9_-]+\.mjs)["'']')) { $Queue.Enqueue($Match.Groups[1].Value.Replace('\', '/')) }
    }
    if ($Content -match '(?:from\s*|import\s*\(\s*)["'']\.\./') { Fail 'PARENT_MODULE_DEPENDENCY_FORBIDDEN' }
  }
  foreach ($Entry in $Items) { if ($Entry.name.StartsWith('src/') -and -not $Reached.ContainsKey($Entry.name)) { Fail ('UNUSED_SOURCE_NOT_ALLOWED:' + $Entry.name) } }
  foreach ($Dependency in $Dependencies) { if (-not $Reached.ContainsKey($Dependency.name)) { Fail 'UNUSED_READONLY_DEPENDENCY' } }
}
function AssertPlan {
  AssertIdentity $Plan; AssertRoots $Plan; AssertNames $Plan.items
  if ($Plan.transactionRoot -ine $TransactionRoot -or $Plan.entrySha256 -cne (Sha $PSCommandPath) -or $Plan.entrySha256 -cne (Sha (Join-Path $TransactionRoot 'entry.ps1'))) { Fail 'INDEPENDENT_ENTRY_DRIFT' }
  if ($Plan.powerShellPath -ine (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -or (Get-FileHash -LiteralPath $Plan.powerShellPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Plan.powerShellSha256) { Fail 'ORIGINAL_WINDOWS_POWERSHELL_DRIFT' }
  foreach ($Directory in $Plan.directories) {
    [void](Plain $Directory.path)
    $DirectoryProgress = @($Receipt.directories | Where-Object { $_.path -ieq $Directory.path })
    if ($Directory.created -and $DirectoryProgress.Count -eq 1 -and $DirectoryProgress[0].state -ceq 'REMOVED') {
      if (Test-Path -LiteralPath $Directory.path) { Fail 'FOREIGN_DIRECTORY_AFTER_RESTORE' }; continue
    }
    if ($Directory.path -ine (Plain $Directory.path) -or (Sddl $Directory.path) -cne $Directory.sddl -or [int][IO.File]::GetAttributes($Directory.path) -ne $Directory.attributes -or (DirectoryIdentity $Directory.path) -cne $Directory.fileId) { Fail 'DIRECTORY_IDENTITY_ACL_ATTRIBUTES_DRIFT' }
  }
  $Index = 0
  foreach ($Entry in $Plan.items) {
    if ($Entry.target -ine (Target $Entry.name $Plan) -or $Entry.candidatePath -ine (Join-Path $TransactionRoot ('candidate/' + $Index + '.bin')) -or $Entry.originalPath -ine (Join-Path $TransactionRoot ('original/' + $Index + '.bin'))) { Fail 'EXACT_PLAN_PATH_BINDING_REQUIRED' }
    AssertState $Entry.candidate (Join-Path $TransactionRoot ('candidate/' + $Index + '.bin'))
    if ($Entry.original.exists) { AssertAcl $Entry.original.sddl; if ((Sha $Entry.originalPath) -cne $Entry.original.sha256) { Fail 'SAVED_ORIGINAL_SHA_DRIFT' } }
    AssertAcl $Entry.installed.sddl
    if ($Entry.installed.sha256 -cne $Entry.candidate.sha256 -or $Entry.installed.exists -ne $true) { Fail 'INSTALLED_STATE_BINDING_REQUIRED' }
    if ($Action -eq 'Apply' -and (Sha (Join-Path $Plan.candidateRoot $Entry.name)) -cne $Entry.candidate.sha256) { Fail 'SOURCE_HASH_DRIFT' }
    $Index++
  }
  if ($Action -eq 'Apply') {
    foreach ($Dependency in $Plan.readOnlyDependencies) { if ((Sha (Join-Path $Plan.installedRoot $Dependency.name)) -cne $Dependency.sha256 -or (Sha (Join-Path $Plan.candidateRoot $Dependency.name)) -cne $Dependency.sha256) { Fail 'READONLY_DEPENDENCY_DRIFT' } }
  }
}
function AssertReceipt {
  if ($Receipt.schemaVersion -ne 1 -or $Receipt.scope -cne $Scope -or $Receipt.planSha256 -cne $PlanSha256 -or $Receipt.ownerId -cne $OwnerId -or $Receipt.transactionId -cne $TransactionId -or $Receipt.operatorSid -cne $Sid -or @($Receipt.progress).Count -ne @($Plan.items).Count -or $Receipt.status -cnotin @('PREPARED', 'APPLYING', 'PARTIAL_APPLY', 'APPLIED', 'RESTORING', 'PARTIAL_RESTORE', 'RESTORED', 'UNKNOWN')) { Fail 'RECEIPT_IDENTITY_OR_STATE_UNKNOWN' }
  if ($Receipt.intent -or $Receipt.status -ceq 'UNKNOWN') { Fail 'UNKNOWN_PRESERVED_NO_REPLAY' }
  $Created = @($Plan.directories | Where-Object { $_.created })
  if (@($Receipt.directories).Count -ne $Created.Count) { Fail 'DIRECTORY_OWNERSHIP_UNKNOWN' }
  foreach ($Directory in $Created) {
    $Progress = @($Receipt.directories | Where-Object { $_.path -ieq $Directory.path })
    if ($Progress.Count -ne 1 -or $Progress[0].fileId -cne $Directory.fileId -or $Progress[0].state -cnotin @('CREATED', 'REMOVED', 'RETAINED_NONEMPTY')) { Fail 'DIRECTORY_OWNERSHIP_UNKNOWN' }
  }
  for ($Index = 0; $Index -lt @($Plan.items).Count; $Index++) {
    $Progress = $Receipt.progress[$Index]; $Entry = $Plan.items[$Index]
    if ($Progress.name -cne $Entry.name -or $Progress.state -cnotin @('ORIGINAL', 'INSTALLED', 'RESTORED')) { Fail 'RECEIPT_PROGRESS_UNKNOWN' }
    $Expected = if ($Progress.state -ceq 'INSTALLED') { $Entry.installed } else { $Entry.original }
    AssertState $Expected $Entry.target
  }
  if ($Receipt.status -ceq 'APPLIED' -and @($Receipt.progress | Where-Object { $_.state -cne 'INSTALLED' }).Count) { Fail 'RECEIPT_PROGRESS_UNKNOWN' }
  if ($Receipt.status -ceq 'RESTORED' -and @($Receipt.progress | Where-Object { $_.state -ceq 'INSTALLED' }).Count) { Fail 'RECEIPT_PROGRESS_UNKNOWN' }
}
function ReplaceFile($Entry, $Desired, [string]$Source, [int]$Index) {
  $Stage = Plain (Join-Path $TransactionRoot ('work/' + $Index + '.stage'))
  if (Test-Path -LiteralPath $Stage) { Fail 'UNOWNED_STAGE_CONFLICT' }
  [IO.File]::Copy($Source, $Stage, $false)
  if ((Sha $Stage) -cne $Desired.sha256) { Fail 'STAGE_HASH_DRIFT' }
  [IO.File]::SetAttributes($Stage, [IO.FileAttributes]::Normal)
  $Receipt.intent = [pscustomobject]@{ index = $Index; action = $Action; target = $Entry.target; desiredSha256 = $Desired.sha256 }
  SaveReceipt
  if (Test-Path -LiteralPath $Entry.target) {
    [IO.File]::SetAttributes($Entry.target, [IO.FileAttributes]::Normal)
    $script:TargetWrites++
    [IO.File]::Replace($Stage, $Entry.target, [NullString]::Value)
  } else { [IO.File]::Move($Stage, $Entry.target); $script:TargetWrites++ }
  NativeSecurity $Entry.target $Desired.sddl
  [IO.File]::SetAttributes($Entry.target, [IO.FileAttributes]$Desired.attributes)
  AssertState $Desired $Entry.target
}

try {
  $TransactionRoot = Plain $TransactionRoot
  if ($Action -eq 'Prepare') {
    if ($FreezeManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $FreezeManifestPath) -cne $FreezeManifestSha256) { Fail 'FROZEN_MANIFEST_SHA_REQUIRED' }
    if ($Mode -eq 'Production') {
      if ($OwnerConfirmation -cne ($OwnerId + '|' + $TransactionId + '|Prepare|' + $FreezeManifestSha256)) { Fail 'EXACT_OWNER_PREPARE_DIRECTORY_CONFIRMATION_REQUIRED' }
      AssertIndependentTerminal
    }
    $Freeze = ReadJson $FreezeManifestPath
    AssertIdentity $Freeze; AssertRoots $Freeze; AssertNames $Freeze.files
    if (Test-Path -LiteralPath $TransactionRoot) { Fail 'TRANSACTION_ALREADY_EXISTS' }
    AssertProcesses @($Freeze.protectedProcesses) -Preparing
    $Directories = @{}; $Originals = @{}
    $ExclusiveDirectories = @((Join-Path $Freeze.dataRoot 'state/inner-managed'), (Join-Path $Freeze.dataRoot 'state/inner-managed/checkpoints'))
    foreach ($Root in @(@($Freeze.installedRoot, $Freeze.dataRoot, (Join-Path $Freeze.dataRoot 'state')) | ForEach-Object { Plain $_ })) {
      if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Fail 'EXISTING_SHARED_ROOT_REQUIRED' }
      $Directories[$Root] = $false
    }
    foreach ($Root in $ExclusiveDirectories) { $Directories[$Root] = -not (Test-Path -LiteralPath (Plain $Root)) }
    foreach ($Entry in $Freeze.files) {
      if ($Entry.sha256 -cnotmatch '^[a-f0-9]{64}$') { Fail 'FROZEN_FILE_SHA_REQUIRED' }
      $Source = Plain (Join-Path $Freeze.candidateRoot $Entry.name)
      if ((Get-Item -LiteralPath $Source -Force).Length -gt 4194304 -or (Sha $Source) -cne $Entry.sha256) { Fail 'FROZEN_SOURCE_HASH_DRIFT' }
      $Destination = Target $Entry.name $Freeze
      $Parent = Plain (Split-Path -Parent $Destination)
      if (-not (Test-Path -LiteralPath $Parent -PathType Container) -and $ExclusiveDirectories -inotcontains $Parent) { Fail 'EXISTING_TARGET_PARENT_REQUIRED' }
      if (-not $Directories.ContainsKey($Parent)) { $Directories[$Parent] = $false }
      $Originals[$Entry.name] = Snapshot $Destination
    }
    $OuterRuntimeRoot = AssertProfile $Freeze $Freeze.files
    $Directories[$OuterRuntimeRoot] = $false
    AssertDependencyGraph $Freeze $Freeze.files @($Freeze.readOnlyDependencies)
    $ExistingDirectoryStates = @($Directories.Keys | Where-Object { -not $Directories[$_] } | Sort-Object | ForEach-Object { [pscustomobject]@{ path = $_; sddl = (Sddl $_); attributes = [int](Get-Item -LiteralPath $_ -Force).Attributes; fileId = (DirectoryIdentity $_); created = $false } })
    foreach ($Root in $ExclusiveDirectories) {
      if (-not $Directories[$Root] -and -not (Test-Path -LiteralPath (Join-Path $Root '.inner-runtime-owner.json') -PathType Leaf)) { Fail 'EXISTING_EXCLUSIVE_ROOT_OWNER_UNKNOWN' }
    }
    [void][IO.Directory]::CreateDirectory($TransactionRoot)
    foreach ($Folder in @('candidate', 'original', 'work')) { [void][IO.Directory]::CreateDirectory((Join-Path $TransactionRoot $Folder)) }
    [IO.File]::Copy($PSCommandPath, (Join-Path $TransactionRoot 'entry.ps1'), $false)
    [IO.File]::WriteAllText((Join-Path $TransactionRoot 'preparation.json'), ([ordered]@{ ownerId = $OwnerId; transactionId = $TransactionId; operatorSid = $Sid; originalMissingDirectories = @($Directories.Keys | Where-Object { $Directories[$_] }); state = 'DIRECTORY_PREPARATION_PENDING' } | ConvertTo-Json -Depth 8), $Utf8)
    foreach ($Directory in $ExistingDirectoryStates) { if ((Sddl $Directory.path) -cne $Directory.sddl -or (DirectoryIdentity $Directory.path) -cne $Directory.fileId) { Fail 'PREPARATION_DIRECTORY_DRIFT' } }
    foreach ($Entry in $Freeze.files) { AssertState $Originals[$Entry.name] (Target $Entry.name $Freeze); if ((Sha (Join-Path $Freeze.candidateRoot $Entry.name)) -cne $Entry.sha256) { Fail 'FROZEN_SOURCE_HASH_DRIFT' } }
    $CreatedDirectoryStates = @()
    foreach ($Root in $ExclusiveDirectories) {
      if ($Directories[$Root]) {
        if (Test-Path -LiteralPath $Root) { Fail 'EXCLUSIVE_DIRECTORY_OWNERSHIP_CONFLICT' }
        [void][IO.Directory]::CreateDirectory($Root); $DirectoryWrites++
        $CreatedDirectoryStates += [pscustomobject]@{ path = $Root; sddl = (Sddl $Root); attributes = [int](Get-Item -LiteralPath $Root -Force).Attributes; fileId = (DirectoryIdentity $Root); created = $true }
        [IO.File]::WriteAllText((Join-Path $TransactionRoot 'preparation.json'), ([ordered]@{ ownerId = $OwnerId; transactionId = $TransactionId; operatorSid = $Sid; createdDirectories = $CreatedDirectoryStates; state = 'DIRECTORY_PREPARATION_PENDING' } | ConvertTo-Json -Depth 8), $Utf8)
      }
    }
    $DirectoryStates = @($ExistingDirectoryStates) + @($CreatedDirectoryStates)
    $Items = @(); $Index = 0
    foreach ($Entry in $Freeze.files) {
      $Source = Plain (Join-Path $Freeze.candidateRoot $Entry.name); $Destination = Target $Entry.name $Freeze
      $Original = $Originals[$Entry.name]; AssertState $Original $Destination
      $CandidatePath = Join-Path $TransactionRoot ('candidate/' + $Index + '.bin'); $OriginalPath = Join-Path $TransactionRoot ('original/' + $Index + '.bin')
      [IO.File]::Copy($Source, $CandidatePath, $false)
      $Candidate = Snapshot $CandidatePath
      if ($Candidate.sha256 -cne $Entry.sha256 -or (Sha $Source) -cne $Entry.sha256) { Fail 'FROZEN_SOURCE_CHANGED_DURING_PREPARE' }
      if ($Original.exists) { AssertAcl $Original.sddl; [IO.File]::Copy($Destination, $OriginalPath, $false); if ((Sha $OriginalPath) -cne $Original.sha256) { Fail 'ORIGINAL_CHANGED_DURING_PREPARE' } }
      AssertState $Original $Destination
      $Metadata = if ($Original.exists) { $Original } else { Snapshot $Source }
      $Installed = [pscustomobject]@{ exists = $true; sha256 = $Candidate.sha256; sddl = $Metadata.sddl; attributes = $Metadata.attributes }
      $Items += [pscustomobject]@{ name = $Entry.name; target = $Destination; candidatePath = $CandidatePath; candidate = $Candidate; originalPath = $OriginalPath; original = $Original; installed = $Installed }
      $Index++
    }
    $PowerShellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $Plan = [ordered]@{ schemaVersion = 1; scope = $Scope; mode = $Mode; ownerId = $OwnerId; transactionId = $TransactionId; operatorSid = $Sid; transactionRoot = $TransactionRoot; candidateRoot = (Plain $Freeze.candidateRoot); installedRoot = (Plain $Freeze.installedRoot); dataRoot = (Plain $Freeze.dataRoot); fixtureRoot = $(if ($Mode -eq 'TempFixture') { $Freeze.fixtureRoot } else { $null }); freezeManifestSha256 = $FreezeManifestSha256; entrySha256 = (Sha $PSCommandPath); powerShellPath = $PowerShellPath; powerShellSha256 = (Get-FileHash -LiteralPath $PowerShellPath -Algorithm SHA256).Hash.ToLowerInvariant(); preparedAtUtc = [DateTimeOffset]::UtcNow.ToString('o'); serviceActions = 0; directories = $DirectoryStates; protectedProcesses = @($Freeze.protectedProcesses); readOnlyDependencies = @($Freeze.readOnlyDependencies); items = $Items }
    [IO.File]::WriteAllText((Join-Path $TransactionRoot 'plan.json'), ($Plan | ConvertTo-Json -Depth 18), $Utf8)
    $PlanSha256 = Sha (Join-Path $TransactionRoot 'plan.json')
    $Receipt = [ordered]@{ schemaVersion = 1; scope = $Scope; ownerId = $OwnerId; transactionId = $TransactionId; operatorSid = $Sid; planSha256 = $PlanSha256; status = 'PREPARED'; applyConsumed = $false; intent = $null; directories = @($CreatedDirectoryStates | ForEach-Object { [pscustomobject]@{ path = $_.path; fileId = $_.fileId; state = 'CREATED' } }); progress = @($Items | ForEach-Object { [pscustomobject]@{ name = $_.name; state = 'ORIGINAL' } }) }
    [IO.File]::WriteAllText((Join-Path $TransactionRoot 'receipt.json'), ($Receipt | ConvertTo-Json -Depth 18), $Utf8)
    $Result.status = 'PREPARED'
  } else {
    if ($PlanSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha (Join-Path $TransactionRoot 'plan.json')) -cne $PlanSha256) { Fail 'EXACT_PLAN_SHA_REQUIRED' }
    $Plan = ReadJson (Join-Path $TransactionRoot 'plan.json')
    $Receipt = ReadJson (Join-Path $TransactionRoot 'receipt.json')
    AssertPlan
    if ($Action -eq 'Status' -and ($Receipt.intent -or $Receipt.status -ceq 'UNKNOWN')) {
      if ($Receipt.planSha256 -cne $PlanSha256 -or $Receipt.ownerId -cne $OwnerId -or $Receipt.transactionId -cne $TransactionId -or $Receipt.operatorSid -cne $Sid) { Fail 'RECEIPT_IDENTITY_OR_STATE_UNKNOWN' }
      $Result.status = 'UNKNOWN'; $Result['preservedIntent'] = $Receipt.intent
    } elseif ($Action -eq 'Status') { AssertReceipt; $Result.status = $Receipt.status }
    else {
      AssertReceipt
      if ($OwnerConfirmation -cne ($OwnerId + '|' + $TransactionId + '|' + $Action + '|' + $PlanSha256)) { Fail 'EXACT_OWNER_CONFIRMATION_REQUIRED' }
      if ($Mode -eq 'Production') { AssertIndependentTerminal }
      AssertProcesses @($Plan.protectedProcesses)
      $MutexName = 'Local\InnerFirstAdoption-' + (TextSha ($Plan.installedRoot.ToLowerInvariant() + '|' + $Plan.dataRoot.ToLowerInvariant()))
      $Mutex = [Threading.Mutex]::new($false, $MutexName)
      try { $MutexOwned = $Mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $MutexOwned = $true; Fail 'TRANSACTION_OWNERSHIP_UNKNOWN' }
      if (-not $MutexOwned) { Fail 'TRANSACTION_OWNERSHIP_CONFLICT' }
      $ReceiptStream = [IO.File]::Open((Join-Path $TransactionRoot 'receipt.json'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $Reader = [IO.StreamReader]::new($ReceiptStream, $Utf8, $true, 4096, $true)
      try { $Receipt = $Reader.ReadToEnd() | ConvertFrom-Json } finally { $Reader.Dispose() }
      AssertPlan; AssertReceipt; AssertProcesses @($Plan.protectedProcesses)
      if ($Action -eq 'Apply' -and ($Receipt.status -cin @('RESTORING', 'PARTIAL_RESTORE', 'RESTORED') -or @($Receipt.progress | Where-Object { $_.state -ceq 'RESTORED' }).Count)) { Fail 'APPLY_CONSUMED_RESTORE_STARTED' }
      if (($Action -eq 'Apply' -and $Receipt.status -ceq 'APPLIED') -or ($Action -eq 'Restore' -and $Receipt.status -ceq 'RESTORED')) { $Result.status = $Receipt.status; $Result['alreadyConsumed'] = $true }
      else {
        $Receipt.status = if ($Action -eq 'Apply') { 'APPLYING' } else { 'RESTORING' }
        if ($Action -eq 'Apply') { $Receipt.applyConsumed = $true }
        $OperationStarted = $true
        SaveReceipt
        for ($Index = 0; $Index -lt @($Plan.items).Count; $Index++) {
          $Entry = $Plan.items[$Index]; $Progress = $Receipt.progress[$Index]
          if (($Action -eq 'Apply' -and $Progress.state -ceq 'INSTALLED') -or ($Action -eq 'Restore' -and $Progress.state -cne 'INSTALLED')) { continue }
          if ($FixtureFailAfterWrites -ge 0 -and $TargetWrites -ge $FixtureFailAfterWrites) { Fail 'FIXTURE_FAILURE_BETWEEN_WRITES' }
          AssertPlan; AssertReceipt; AssertProcesses @($Plan.protectedProcesses)
          if ($Action -eq 'Restore' -and -not $Entry.original.exists) {
            $Receipt.intent = [pscustomobject]@{ index = $Index; action = $Action; target = $Entry.target; desiredSha256 = $null }; SaveReceipt
            AssertState $Entry.installed $Entry.target
            [IO.File]::SetAttributes($Entry.target, [IO.FileAttributes]::Normal)
            $TargetWrites++; [IO.File]::Delete($Entry.target)
            AssertState $Entry.original $Entry.target
          } else {
            $Desired = if ($Action -eq 'Apply') { $Entry.installed } else { $Entry.original }
            $Source = if ($Action -eq 'Apply') { $Entry.candidatePath } else { $Entry.originalPath }
            ReplaceFile $Entry $Desired $Source $Index
          }
          if ($FixtureUnknownAfterWrite) { Fail 'FIXTURE_UNKNOWN_AFTER_WRITE' }
          $Progress.state = if ($Action -eq 'Apply') { 'INSTALLED' } else { 'RESTORED' }
          $Receipt.intent = $null; SaveReceipt
        }
        if ($Action -eq 'Restore') {
          foreach ($DirectoryProgress in @($Receipt.directories | Sort-Object { $_.path.Length } -Descending)) {
            if ($DirectoryProgress.state -ceq 'REMOVED') { continue }
            $Directory = @($Plan.directories | Where-Object { $_.path -ieq $DirectoryProgress.path })[0]
            if ((DirectoryIdentity $Directory.path) -cne $Directory.fileId -or (Sddl $Directory.path) -cne $Directory.sddl) { Fail 'DIRECTORY_OWNERSHIP_CONFLICT' }
            if (@([IO.Directory]::GetFileSystemEntries($Directory.path)).Count) { $DirectoryProgress.state = 'RETAINED_NONEMPTY'; SaveReceipt; continue }
            AssertProcesses @($Plan.protectedProcesses)
            $Receipt.intent = [pscustomobject]@{ action = 'DELETE_EMPTY_OWNED_DIRECTORY'; path = $Directory.path; fileId = $Directory.fileId }; SaveReceipt
            [IO.Directory]::Delete($Directory.path, $false); $DirectoryWrites++
            $DirectoryProgress.state = 'REMOVED'; $Receipt.intent = $null; SaveReceipt
          }
        }
        $Receipt.status = if ($Action -eq 'Apply') { 'APPLIED' } else { 'RESTORED' }; SaveReceipt
        $Result.status = $Receipt.status
      }
    }
  }
  $Result['transactionRoot'] = $TransactionRoot
  $Result['planSha256'] = $PlanSha256
  $Result['entryPath'] = Join-Path $TransactionRoot 'entry.ps1'
  $Result['entrySha256'] = $Plan.entrySha256
  $Result['ownedDirectories'] = @($Receipt.directories)
  $Result['createdDirectories'] = @($Plan.directories | Where-Object { $_.created } | ForEach-Object { [pscustomobject]@{ path = $_.path; fileId = $_.fileId; originalMissing = $true } })
  $Result['files'] = @($Plan.items | ForEach-Object { [pscustomobject]@{ name = $_.name; originalExists = $_.original.exists; originalSha256 = $_.original.sha256; installedSha256 = $_.installed.sha256 } })
} catch {
  $ExitCode = 1; $Result.error = $_.Exception.Message
  if ($ReceiptStream -and $Receipt -and ($OperationStarted -or $TargetWrites -gt 0 -or $DirectoryWrites -gt 0 -or $Receipt.intent)) {
    $Receipt.status = if ($Receipt.intent) { 'UNKNOWN' } elseif ($Action -eq 'Apply') { 'PARTIAL_APPLY' } else { 'PARTIAL_RESTORE' }
    try { SaveReceipt } catch { $Result['receiptSaveError'] = $_.Exception.Message }
    $Result.status = $Receipt.status
  }
} finally {
  if ($ReceiptStream) { $ReceiptStream.Dispose() }
  if ($MutexOwned) { $Mutex.ReleaseMutex() }
  if ($Mutex) { $Mutex.Dispose() }
  $Result.targetWrites = $TargetWrites
  $Result['directoryWrites'] = $DirectoryWrites
  $Result | ConvertTo-Json -Depth 18 -Compress
}
exit $ExitCode
