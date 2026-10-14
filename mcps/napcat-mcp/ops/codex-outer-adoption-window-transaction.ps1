[CmdletBinding()]
param(
  [ValidateSet('Prepare', 'VerifyOnly', 'VerifyOwnerGate', 'Apply', 'Restore', 'BindCandidateInstance', 'BindCandidateLaunch')][string]$Action = 'VerifyOnly',
  [ValidateSet('Production', 'TempMapping')][string]$Mode = 'Production',
  [string]$PreparationRoot = '', [string]$PreparationSha256 = '', [string]$OwnerId = '',
  [string]$SampleRoot = '', [string]$ContractRoot = '', [string]$ContractSha256 = '',
  [string]$PowerShellPath = '', [string]$NodePath = '',
  [string]$WindowPath = '', [string]$WindowSha256 = '',
  [string]$ParentEntrySha256 = '', [string]$ParentAttemptId = '',
  [ValidateSet('LegacyHotProof', 'OwnerColdFirstAdoption')][string]$ExecutionProfile = 'LegacyHotProof',
  [string]$StopEvidencePath = '', [string]$StopEvidenceSha256 = '',
  [string]$CandidateLaunchToken = '', [string]$CandidateLaunchReceiptPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$Utf8 = New-Object Text.UTF8Encoding($false)
$Sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$Stream = $null
$Receipt = $null
$ExitCode = 0
$Result = [ordered]@{ scope = 'outer-first-adoption-19+1'; status = 'refused'; mode = $Mode; productionModified = $false; error = $null }
$Names = @(
  'ops/codex-outer-runtime.mjs', 'ops/start-codex-app-server-proxy.ps1', 'ops/resolve-napcat-data-root.ps1', 'ops/resolve-codex-outer-runtime-startup.ps1',
  'src/atomic-file.mjs', 'src/codex-app-server-proxy-runner.mjs', 'src/codex-app-server-proxy.mjs', 'src/codex-request-metadata.mjs', 'src/codex-display-policy.mjs', 'src/codex-runtime-bundle.mjs',
  'src/observability-utils.mjs', 'src/outer-engine.mjs', 'src/outer-runtime-contract.mjs', 'src/outer-runtime-host.mjs', 'src/outer-runtime-selection.mjs',
  'src/outer-runtime.mjs', 'src/reasoning-placeholder.mjs', 'src/turn-observability.mjs', 'src/wake-visibility.mjs'
)

function Plain([string]$Value, [switch]$TempOnly) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':')) { throw 'WINDOW_ABSOLUTE_PLAIN_PATH_REQUIRED' }
  $Full = [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
  if ($TempOnly -and -not $Full.StartsWith([IO.Path]::GetTempPath().TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'WINDOW_TEMP_MAPPING_REQUIRED' }
  $Current = $Full
  while ($Current) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      $SystemRuntime = -not $TempOnly -and $Current -ieq $Full -and $Full -ieq (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -and $Item.LinkType -eq 'HardLink'
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($Item.LinkType -and -not $SystemRuntime)) { throw 'WINDOW_LINK_REJECTED' }
    }
    $Current = Split-Path -Parent $Current
  }
  return $Full
}

function Sha([string]$Value) { return (Get-FileHash -LiteralPath (Plain $Value) -Algorithm SHA256).Hash.ToLowerInvariant() }
function Json([string]$Value) { $Full = Plain $Value; if ((Get-Item -LiteralPath $Full).Length -gt 1048576) { throw 'WINDOW_JSON_TOO_LARGE' }; return Get-Content -LiteralPath $Full -Encoding UTF8 -Raw | ConvertFrom-Json }
function Sddl([string]$Value) { return (Get-Acl -LiteralPath (Plain $Value)).GetSecurityDescriptorSddlForm($Sections) }
function Save {
  $Bytes = $Utf8.GetBytes(($Receipt | ConvertTo-Json -Depth 14))
  $Stream.Position = 0; $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.SetLength($Bytes.Length); $Stream.Flush($true)
}
function State([string]$Value) {
  $Value = Plain $Value
  if (-not (Test-Path -LiteralPath $Value)) { return [pscustomobject]@{ exists = $false; sha256 = $null; sddl = $null; attributes = $null } }
  if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw 'WINDOW_TARGET_FILE_REQUIRED' }
  return [pscustomobject]@{ exists = $true; sha256 = (Sha $Value); sddl = (Sddl $Value); attributes = [int](Get-Item -LiteralPath $Value -Force).Attributes }
}
function Same($Before, $After) {
  if ($Before.exists -ne $After.exists -or $Before.sha256 -cne $After.sha256 -or $Before.sddl -cne $After.sddl -or $Before.attributes -ne $After.attributes) { throw 'WINDOW_TARGET_BYTES_ACL_DRIFT' }
}
function Accept-State($Entry, $Observed, [string]$Phase) {
  $Receipt.accepted = @($Receipt.accepted | Where-Object { $_.name -cne $Entry.name }) + @([pscustomobject]@{ name = $Entry.name; state = $Observed; phase = $Phase })
  Save
}
function Assert-SavedAcl([string]$Value) {
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Value)
  if (-not $Descriptor.Owner -or -not $Descriptor.Group -or $null -eq $Descriptor.DiscretionaryAcl -or $Descriptor.SystemAcl) { throw 'WINDOW_OWNER_GROUP_DACL_REQUIRED' }
}
function Restore-Acl([string]$Value, [string]$Saved) {
  if (-not ('OuterAdoptionWindow.NativeAcl' -as [type])) {
    $Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('OuterAdoptionWindow.NativeAcl'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $Builder = $Assembly.DefineDynamicModule('NativeAcl').DefineType('OuterAdoptionWindow.NativeAcl', [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
    $Attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
    $Setter = $Builder.DefinePInvokeMethod('Set', 'advapi32.dll', 'SetNamedSecurityInfoW', $Attributes, [Reflection.CallingConventions]::Standard, [uint32], [type[]]@([string], [int], [uint32], [byte[]], [byte[]], [byte[]], [IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $RawSetter = $Builder.DefinePInvokeMethod('SetRaw', 'advapi32.dll', 'SetFileSecurityW', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([string], [uint32], [byte[]]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $Setter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig); $RawSetter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig); [void]$Builder.CreateType()
  }
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Saved)
  [uint32]$Information = 7
  $Information = $Information -bor $(if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) { [uint32]2147483648 } else { [uint32]536870912 })
  if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0) {
    $OwnerBytes = [byte[]]::new($Descriptor.Owner.BinaryLength); $GroupBytes = [byte[]]::new($Descriptor.Group.BinaryLength); $DaclBytes = [byte[]]::new($Descriptor.DiscretionaryAcl.BinaryLength)
    $Descriptor.Owner.GetBinaryForm($OwnerBytes, 0); $Descriptor.Group.GetBinaryForm($GroupBytes, 0); $Descriptor.DiscretionaryAcl.GetBinaryForm($DaclBytes, 0)
    if ([OuterAdoptionWindow.NativeAcl]::Set($Value, 1, $Information, $OwnerBytes, $GroupBytes, $DaclBytes, [IntPtr]::Zero) -ne 0) { throw 'WINDOW_ACL_RESTORE_FAILED' }
  } else {
    $Bytes = [byte[]]::new($Descriptor.BinaryLength); $Descriptor.GetBinaryForm($Bytes, 0)
    if (-not [OuterAdoptionWindow.NativeAcl]::SetRaw($Value, $Information, $Bytes)) { throw 'WINDOW_ACL_RESTORE_FAILED' }
  }
  if ((Sddl $Value) -cne $Saved) { throw 'WINDOW_ACL_RESTORE_MISMATCH' }
}

function Assert-Contract {
  if ($Contract.schemaVersion -ne 1 -or $Contract.scope -cne 'outer-first-adoption-19+1' -or $Contract.mode -cne 'PREPARE_ONLY' -or $Contract.ownerId -notmatch '^[A-Za-z0-9_.:-]{1,128}$' -or $Contract.executionMode -cne $Mode -or $Contract.operatorSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'WINDOW_CONTRACT_BINDING_MISMATCH' }
  if (@($Contract.items).Count -ne 20 -or (($Contract.items.name | Sort-Object) -join '|') -cne ((@($Names) + @('state/codex-outer-runtime-startup.json') | Sort-Object) -join '|')) { throw 'WINDOW_FIXED_20_REQUIRED' }
  if ((Sha (Join-Path $Contract.preparationRoot 'preparation.json')) -cne $Contract.preparationSha256) { throw 'WINDOW_PREPARATION_CHANGED' }
  foreach ($Runtime in @($Contract.powerShell, $Contract.node)) { if ((Sha $Runtime.path) -cne $Runtime.sha256) { throw 'WINDOW_ORIGINAL_RUNTIME_CHANGED' } }
  if ($Contract.powerShell.path -ine (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -or [IO.Path]::GetFileName($Contract.node.path) -ine 'node.exe' -or (Sha (Join-Path $ContractRoot 'transaction.ps1')) -cne $Contract.entrySha256 -or (Sha $PSCommandPath) -cne $Contract.entrySha256) { throw 'WINDOW_INDEPENDENT_ENTRY_CHANGED' }
  foreach ($Root in @($Contract.installedRoot, $Contract.dataRoot)) { [void](Plain $Root); if ((Sddl $Root) -cne $Contract.rootSecurity.($Root)) { throw 'WINDOW_ROOT_SECURITY_CHANGED' } }
  foreach ($Entry in $Contract.items) {
    $Expected = if ($Entry.name -ceq 'state/codex-outer-runtime-startup.json') { Join-Path $Contract.dataRoot $Entry.name } else { Join-Path $Contract.installedRoot $Entry.name }
    if ($Entry.target -ine $Expected -or $Entry.candidatePath -ine (Join-Path $Contract.preparationRoot $(if ($Entry.name -ceq 'state/codex-outer-runtime-startup.json') { 'candidate-startup.json' } else { 'candidate/' + $Entry.name }))) { throw 'WINDOW_FIXED_TARGET_BINDING_MISMATCH' }
    if ((Sha $Entry.candidatePath) -cne $Entry.candidateSha256) { throw 'WINDOW_CANDIDATE_CHANGED' }
    if ($Entry.original.exists) { Assert-SavedAcl $Entry.original.sddl; if ((Sha $Entry.originalPath) -cne $Entry.original.sha256) { throw 'WINDOW_RECOVERY_MATERIAL_CHANGED' } }
  }
  if ($Mode -eq 'TempMapping') {
    foreach ($Root in @($Contract.installedRoot, $Contract.dataRoot, $Contract.preparationRoot, $Contract.sampleRoot)) { [void](Plain $Root -TempOnly) }
    if ($Contract.installedRoot -ine (Join-Path $Contract.sampleRoot 'installed') -or $Contract.dataRoot -ine (Join-Path $Contract.sampleRoot 'data') -or (Sha (Join-Path $Contract.sampleRoot '.outer-adoption-isolated-owner.json')) -cne $Contract.anchorSha256) { throw 'WINDOW_TEMP_OWNER_CHANGED' }
  }
}

function Assert-IndependentTerminalOrigin([int]$InitialProcessId) {
  $ProcessId = $InitialProcessId
  $Seen = New-Object 'Collections.Generic.HashSet[int]'
  $ChildCreated = $null
  $SessionId = $null
  $ExplorerPath = [IO.Path]::Combine([Environment]::GetFolderPath('Windows'), 'explorer.exe')
  for ($Depth = 0; $Depth -lt 32 -and $ProcessId; $Depth++) {
    if (-not $Seen.Add($ProcessId)) { throw 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Matches = @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop)
    if ($Matches.Count -ne 1) { throw 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Process = $Matches[0]
    if ([int]$Process.ProcessId -ne $ProcessId -or -not $Process.ExecutablePath -or -not $Process.CommandLine -or -not $Process.CreationDate -or $null -eq $Process.SessionId -or [string]$Process.CommandLine -match 'app-server|mcp-http-broker|sandbox-data|codex-command-runner|codex-windows-sandbox|WindowsJobRunner' -or [string]$Process.Name -match '^(ChatGPT|codex|codex-command-runner|codex-windows-sandbox-setup|WindowsJobRunner)\.exe$') { throw 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Created = ([DateTime]$Process.CreationDate).ToUniversalTime()
    if ($ChildCreated -and $Created -gt $ChildCreated) { throw 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ($null -eq $SessionId) { $SessionId = [int]$Process.SessionId }
    if ([int]$Process.SessionId -ne $SessionId) { throw 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ([string]$Process.Name -ieq 'explorer.exe' -and [string]$Process.ExecutablePath -ieq $ExplorerPath) {
      return [pscustomobject]@{ shellPid = $InitialProcessId; explorerPid = $ProcessId; sessionId = $SessionId; explorerCreatedUtc = $Created.ToString('o'); verifiedDepth = $Depth }
    }
    $ChildCreated = $Created
    $ProcessId = [int]$Process.ParentProcessId
  }
  throw 'WINDOW_INDEPENDENT_OWNER_TERMINAL_REQUIRED'
}

function Assert-ExecutionGate {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop' -or (Get-ExecutionPolicy) -ne 'RemoteSigned' -or (Get-ExecutionPolicy -Scope Process) -ne 'Undefined') { throw 'WINDOW_ORDINARY_WINDOWS_POWERSHELL_REQUIRED' }
  if ($Mode -eq 'Production') {
    if (-not $WindowPath -or $WindowSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $WindowPath) -cne $WindowSha256) { throw 'WINDOW_NEW_OWNER_APPROVAL_REQUIRED' }
    $script:Window = Json $WindowPath
    if ($Window.schemaVersion -ne 1 -or $Window.mode -cne 'OWNER_APPROVED_PRODUCTION_WINDOW' -or $Window.authorizedByOwner -ne $true -or -not $Window.approvalRef -or $Window.scope -cne $Contract.scope -or $Window.contractSha256 -cne $ContractSha256 -or $Window.operatorSid -cne $Contract.operatorSid -or $Window.ownerId -cne $Contract.ownerId -or $Window.installedRoot -ine $Contract.installedRoot -or $Window.dataRoot -ine $Contract.dataRoot -or $Window.entrySha256 -cne $Contract.entrySha256 -or $Window.stopIdentity.instanceToken -cne $Contract.stopIdentity.instanceToken) { throw 'WINDOW_EXACT_APPROVAL_BINDING_REQUIRED' }
    if ($Contract.executionProfile -ceq 'OwnerColdFirstAdoption' -and ($Window.executionProfile -cne 'OwnerColdFirstAdoption' -or $Window.acceptsShortInterruption -ne $true -or $Window.acceptsLegacyRequestCounterLimit -ne $true -or $Window.parentSha256 -cne $Contract.parentEntrySha256)) { throw 'WINDOW_EXPLICIT_COLD_FIRST_ADOPTION_REQUIRED' }
    $Now = [DateTimeOffset]::UtcNow
    if ($Window.startsAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or $Window.expiresAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or [DateTimeOffset]::Parse($Window.startsAt) -gt $Now -or [DateTimeOffset]::Parse($Window.expiresAt) -le $Now) {
      if ($Action -ne 'Restore' -or -not $Receipt -or $Receipt.windowSha256 -cne $WindowSha256 -or $Window.recoveryAfterExpiry -ne $true) { throw 'WINDOW_APPROVAL_NOT_CURRENT' }
    }
    [void](Assert-IndependentTerminalOrigin $PID)
  }
}

function Assert-StopBoundary {
  $RuntimePath = Join-Path $Contract.dataRoot 'state/codex-app-server-proxy-runtime.json'
  if (Test-Path -LiteralPath $RuntimePath) {
    $Runtime = Json $RuntimePath
    if (($Runtime.pid -and (Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue)) -or ($Runtime.appServerPid -and (Get-Process -Id ([int]$Runtime.appServerPid) -ErrorAction SilentlyContinue))) { throw 'WINDOW_EXACT_SERVICE_NOT_STOPPED' }
    $ExpectedToken = if ($Action -eq 'Restore' -and $Receipt.candidateInstance) { $Receipt.candidateInstance.instanceToken } elseif ($Action -eq 'Restore' -and $Receipt.candidateLaunch -and $Runtime.instanceToken -ceq $Receipt.candidateLaunch.instanceToken) { $Receipt.candidateLaunch.instanceToken } else { $Contract.stopIdentity.instanceToken }
    if ($ExpectedToken -and $Runtime.instanceToken -cne $ExpectedToken) { throw 'WINDOW_STOP_INSTANCE_CHANGED' }
    if ($Action -eq 'Restore' -and $Receipt.candidateLaunch -and -not $Receipt.candidateInstance -and $Runtime.instanceToken -ceq $Receipt.candidateLaunch.instanceToken) {
      $LaunchPath = Plain $Receipt.candidateLaunch.receiptPath -TempOnly
      if ($LaunchPath -ine (Join-Path (Split-Path -Parent $ContractRoot) 'candidate-launch.json')) { throw 'WINDOW_CANDIDATE_LAUNCH_PATH_CHANGED' }
      $Launch = Json $LaunchPath
      $Runner = @($Contract.items | Where-Object { $_.name -ceq 'src/codex-app-server-proxy-runner.mjs' })[0]
      $Entry = @($Contract.items | Where-Object { $_.name -ceq 'ops/start-codex-app-server-proxy.ps1' })[0]
      if ($Launch.instanceToken -cne $Receipt.candidateLaunch.instanceToken -or [int]$Launch.pid -ne [int]$Runtime.pid -or $Launch.nodePath -ine $Contract.node.path -or $Launch.nodeSha256 -cne $Contract.node.sha256 -or $Launch.runnerPath -ine $Runner.target -or $Launch.runnerSha256 -cne $Runner.candidateSha256 -or $Launch.entrySha256 -cne $Entry.candidateSha256 -or $Launch.runtimeStatePath -ine $RuntimePath -or $Launch.commandLine.IndexOf($Launch.instanceToken, [StringComparison]::Ordinal) -lt 0 -or $Launch.createdAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or $Runtime.startedAt -notmatch '(Z|[+-]\d\d:\d\d)$' -or [DateTimeOffset]::Parse($Runtime.startedAt) -lt [DateTimeOffset]::Parse($Launch.createdAt) -or $Runtime.startupTerminalClean -ne $true -or $Runtime.appServerPid -or $Runtime.state -notin @('degraded', 'stopped', 'stopping') -or (Test-Path -LiteralPath (Join-Path $Contract.dataRoot 'state/codex-app-server-proxy.stop')) -or (Test-Path -LiteralPath (Join-Path $Contract.dataRoot 'state/codex-app-server-proxy.lock'))) { throw 'WINDOW_CANDIDATE_LAUNCH_TERMINAL_UNKNOWN' }
      foreach ($ProcessId in @($Launch.pid) + @($Runtime.startupChildPids)) { if (-not $ProcessId -or (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)) { throw 'WINDOW_CANDIDATE_LAUNCH_PROCESS_PRESENT' } }
      if (@($Launch.ports).Count -ne 4 -or @($Launch.ports | Sort-Object -Unique).Count -ne 4 -or @($Launch.ports | Where-Object { [int]$_ -lt 1 -or [int]$_ -gt 65535 }).Count -or (@($Launch.ports | Select-Object -First 3) -join ',') -cne ((@($Runtime.downstreamUrl, $Runtime.controlUrl, $Runtime.upstreamUrl) | ForEach-Object { ([Uri]$_).Port }) -join ',')) { throw 'WINDOW_CANDIDATE_LAUNCH_PORTS_CHANGED' }
      foreach ($Port in $Launch.ports) { $Listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, [int]$Port); try { $Listener.Start() } finally { $Listener.Stop() } }
      return
    }
    if ($StopEvidencePath) {
      $EvidencePath = Plain $StopEvidencePath -TempOnly
      if ((Split-Path -Parent $EvidencePath) -ine $ContractRoot -or $StopEvidenceSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $EvidencePath) -cne $StopEvidenceSha256) { throw 'WINDOW_STOP_EVIDENCE_PATH_OR_SHA_CHANGED' }
      $Evidence = Json $EvidencePath
      if ($Evidence.scope -cne $Contract.scope -or $Evidence.ownerId -cne $Contract.ownerId -or $Evidence.parentAttemptId -cne $Contract.parentAttemptId -or $Evidence.parentSha256 -cne $Contract.parentEntrySha256 -or $Evidence.contractSha256 -cne $ContractSha256 -or $Evidence.instanceToken -cne $Runtime.instanceToken -or $Evidence.metadataState -cne $Runtime.state -or [int]$Evidence.proxy.pid -ne [int]$Runtime.pid -or $Evidence.normalStop.stopped -ne $true -or $Evidence.normalStop.clean -ne $true -or [int]$Evidence.normalStop.pid -ne [int]$Evidence.proxy.pid -or $Evidence.marker.State -cne 'Consumed' -or $Evidence.marker.DispositionApplied -ne $true -or $Evidence.marker.LeaseReleased -ne $true -or $Evidence.marker.PathState -cne 'Missing' -or (Test-Path -LiteralPath (Join-Path $Contract.dataRoot 'state/codex-app-server-proxy.stop'))) { throw 'WINDOW_EXACT_OWNED_STOP_EVIDENCE_REQUIRED' }
      foreach ($ProcessId in @($Evidence.proxy.pid, $Evidence.child.pid)) { if (-not $ProcessId -or (Get-Process -Id ([int]$ProcessId) -ErrorAction SilentlyContinue)) { throw 'WINDOW_STOP_EVIDENCE_PROCESS_NOT_ENDED' } }
      if ($Runtime.state -notin @('stopped', 'stopping')) { throw 'WINDOW_STOP_METADATA_UNKNOWN' }
      if ($Contract.executionProfile -ceq 'OwnerColdFirstAdoption' -and $Mode -eq 'Production' -and ($Evidence.desktopExitSha256 -cne $Window.desktopExitSha256 -or -not $Evidence.desktopExitSha256)) { throw 'WINDOW_COLD_DESKTOP_EXIT_EVIDENCE_REQUIRED' }
    } elseif ($Runtime.state -cne 'stopped') { throw 'WINDOW_EXACT_SERVICE_NOT_STOPPED' }
  } elseif ($Mode -eq 'Production') { throw 'WINDOW_STOP_STATE_REQUIRED' }
}

try {
  $ContractRoot = Plain $ContractRoot -TempOnly
  $ContractPath = Join-Path $ContractRoot 'transaction-contract.json'
  if ($Action -eq 'Prepare') {
    if (Test-Path -LiteralPath $ContractRoot) { throw 'WINDOW_NEW_CONTRACT_ROOT_REQUIRED' }
    $PreparationRoot = Plain $PreparationRoot -TempOnly
    if ($PreparationSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha (Join-Path $PreparationRoot 'preparation.json')) -cne $PreparationSha256) { throw 'WINDOW_PREPARATION_SHA_MISMATCH' }
    $Manifest = Json (Join-Path $PreparationRoot 'preparation.json')
    if ($Manifest.mode -cne 'PREPARE_ONLY' -or $Manifest.ownerId -cne $OwnerId -or $OwnerId -notmatch '^[A-Za-z0-9_.:-]{1,128}$' -or $Manifest.readyForProduction -ne $false -or $Manifest.productionChanged -ne $false -or @($Manifest.files).Count -ne 19 -or (($Manifest.files.name | Sort-Object) -join '|') -cne (($Names | Sort-Object) -join '|')) { throw 'WINDOW_FIXED_PREPARATION_REQUIRED' }
    $InstalledRoot = Plain $Manifest.installedRoot; $DataRoot = Plain $Manifest.dataRoot
    foreach ($Root in @($InstalledRoot, $DataRoot, $PreparationRoot)) { if ($ContractRoot -ieq $Root -or $ContractRoot.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) -or $Root.StartsWith($ContractRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'WINDOW_CONTRACT_OVERLAPS_INPUT' } }
    $Items = @()
    foreach ($Entry in $Manifest.files) {
      $Target = Join-Path $InstalledRoot $Entry.name
      $Before = State $Target
      if ($Before.exists -ne $Entry.original.exists -or $Before.sha256 -cne $Entry.original.sha256 -or $Before.sddl -cne $Entry.original.sddl) { throw 'WINDOW_PREPARE_ORIGINAL_CHANGED' }
      $Items += [pscustomobject]@{ name = $Entry.name; target = $Target; original = $Before; originalPath = (Join-Path $PreparationRoot ('original/' + $Entry.name)); candidatePath = (Join-Path $PreparationRoot ('candidate/' + $Entry.name)); candidateSha256 = $Entry.candidate.sha256 }
    }
    $StartupTarget = Join-Path $DataRoot 'state/codex-outer-runtime-startup.json'
    $Before = State $StartupTarget
    if ($Manifest.startup.target -ine $StartupTarget -or $Before.exists -ne $Manifest.startup.original.exists -or $Before.sha256 -cne $Manifest.startup.original.sha256 -or $Before.sddl -cne $Manifest.startup.original.sddl) { throw 'WINDOW_PREPARE_STARTUP_CHANGED' }
    $Items += [pscustomobject]@{ name = 'state/codex-outer-runtime-startup.json'; target = $StartupTarget; original = $Before; originalPath = (Join-Path $PreparationRoot 'original-startup.json'); candidatePath = (Join-Path $PreparationRoot 'candidate-startup.json'); candidateSha256 = $Manifest.startup.sha256 }
    $RuntimePath = Join-Path $DataRoot 'state/codex-app-server-proxy-runtime.json'
    $StopIdentity = if (Test-Path -LiteralPath $RuntimePath) { $Runtime = Json $RuntimePath; [ordered]@{ pid = $Runtime.pid; appServerPid = $Runtime.appServerPid; instanceToken = $Runtime.instanceToken; executablePath = $Runtime.executablePath; stateObserved = $Runtime.state } } else { $null }
    $AnchorSha = $null
    if ($Mode -eq 'TempMapping') {
      foreach ($Root in @($SampleRoot, $InstalledRoot, $DataRoot)) { [void](Plain $Root -TempOnly) }
      $Anchor = Json (Join-Path $SampleRoot '.outer-adoption-isolated-owner.json')
      if ($Anchor.ownerId -cne $OwnerId -or $Anchor.preparationSha256 -cne $PreparationSha256 -or $Anchor.preparationRoot -ine $PreparationRoot -or $Anchor.sampleRoot -ine $SampleRoot -or $InstalledRoot -ine (Join-Path $SampleRoot 'installed') -or $DataRoot -ine (Join-Path $SampleRoot 'data')) { throw 'WINDOW_TEMP_OWNER_REQUIRED' }
      $AnchorSha = Sha (Join-Path $SampleRoot '.outer-adoption-isolated-owner.json')
    }
    $RootSecurity = @{}; $RootSecurity[$InstalledRoot] = Sddl $InstalledRoot; $RootSecurity[$DataRoot] = Sddl $DataRoot
    $Contract = [ordered]@{ schemaVersion = 1; scope = 'outer-first-adoption-19+1'; mode = 'PREPARE_ONLY'; executionMode = $Mode; ownerId = $OwnerId; operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; installedRoot = $InstalledRoot; dataRoot = $DataRoot; rootSecurity = $RootSecurity; preparationRoot = $PreparationRoot; preparationSha256 = $PreparationSha256; sampleRoot = $SampleRoot; anchorSha256 = $AnchorSha; stopIdentity = $StopIdentity; items = $Items; entrySha256 = (Sha $PSCommandPath); powerShell = @{ path = (Plain $PowerShellPath); sha256 = (Sha $PowerShellPath) }; node = @{ path = (Plain $NodePath); sha256 = (Sha $NodePath) }; approvalCreated = $false }
    $Contract.executionProfile = $ExecutionProfile; $Contract.parentEntrySha256 = $ParentEntrySha256; $Contract.parentAttemptId = $ParentAttemptId
    New-Item -ItemType Directory -Path $ContractRoot | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $ContractRoot 'transaction.ps1')
    $Stream = [IO.File]::Open($ContractPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $Bytes = $Utf8.GetBytes(($Contract | ConvertTo-Json -Depth 14)); $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) } finally { $Stream.Dispose(); $Stream = $null }
    $Result.status = 'prepared-only'; $Result.contractRoot = $ContractRoot; $Result.contractSha256 = Sha $ContractPath; $Result.recoveryEntry = Join-Path $ContractRoot 'transaction.ps1'; $Result.recoveryItems = 20
  } else {
    if ($ContractSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $ContractPath) -cne $ContractSha256) { throw 'WINDOW_CONTRACT_SHA_MISMATCH' }
    $Contract = Json $ContractPath
    Assert-Contract
    $AttemptPath = Join-Path $ContractRoot 'transaction-attempt.json'
    if (Test-Path -LiteralPath $AttemptPath) { $Receipt = Json $AttemptPath; if ($Receipt.contractSha256 -cne $ContractSha256 -or $Receipt.ownerId -cne $Contract.ownerId) { throw 'WINDOW_ATTEMPT_OWNER_CHANGED' } }
    if ($Action -eq 'VerifyOnly') { $Result.status = 'verified-only' }
    else {
      Assert-ExecutionGate
      if ($Action -eq 'VerifyOwnerGate') {
        if ($Receipt) { throw 'WINDOW_FRESH_OWNER_GATE_REQUIRED' }
        foreach ($Entry in $Contract.items) { Same $Entry.original (State $Entry.target) }
        $Result.status = 'owner-gate-verified'
      } elseif ($Action -eq 'BindCandidateLaunch') {
        if (-not $Receipt -or $Receipt.status -cne 'applied' -or $Receipt.candidateInstance -or $Receipt.candidateLaunch -or -not $Contract.parentEntrySha256 -or -not $Contract.parentAttemptId -or $CandidateLaunchToken -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or $CandidateLaunchToken -ceq $Contract.stopIdentity.instanceToken) { throw 'WINDOW_NEW_CANDIDATE_LAUNCH_REQUIRED' }
        $LaunchPath = Plain $CandidateLaunchReceiptPath -TempOnly
        if ($LaunchPath -ine (Join-Path (Split-Path -Parent $ContractRoot) 'candidate-launch.json') -or (Test-Path -LiteralPath $LaunchPath)) { throw 'WINDOW_NEW_CANDIDATE_LAUNCH_PATH_REQUIRED' }
        foreach ($Entry in $Contract.items) { $Accepted = @($Receipt.accepted | Where-Object { $_.name -ceq $Entry.name }); if ($Accepted.Count -ne 1) { throw 'WINDOW_ACCEPTED_STATE_REQUIRED' }; Same $Accepted[0].state (State $Entry.target) }
        $Stream = [IO.File]::Open($AttemptPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        $Receipt | Add-Member -NotePropertyName candidateLaunch -NotePropertyValue ([pscustomobject]@{ instanceToken = $CandidateLaunchToken; receiptPath = $LaunchPath; parentAttemptId = $Contract.parentAttemptId; boundAt = [DateTimeOffset]::UtcNow.ToString('o') }) -Force
        Save; $Result.status = 'candidate-launch-bound'; $Result.candidateLaunch = $Receipt.candidateLaunch
      } elseif ($Action -eq 'BindCandidateInstance') {
        if (-not $Receipt -or $Receipt.status -cne 'applied' -or -not $Contract.parentEntrySha256 -or -not $Contract.parentAttemptId) { throw 'WINDOW_APPLIED_PARENT_ATTEMPT_REQUIRED' }
        $Runtime = Json (Join-Path $Contract.dataRoot 'state/codex-app-server-proxy-runtime.json')
        $Proxy = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Runtime.pid) -ErrorAction Stop
        $Child = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$Runtime.appServerPid) -ErrorAction Stop
        if ($Runtime.state -cne 'running' -or -not $Runtime.instanceToken -or -not $Proxy -or -not $Child -or $Proxy.ExecutablePath -ine $Contract.node.path -or $Proxy.CommandLine.IndexOf((Join-Path $Contract.installedRoot 'src/codex-app-server-proxy-runner.mjs'), [StringComparison]::OrdinalIgnoreCase) -lt 0 -or $Proxy.CommandLine.IndexOf((Join-Path $Contract.dataRoot 'state/codex-app-server-proxy-runtime.json'), [StringComparison]::OrdinalIgnoreCase) -lt 0 -or [int]$Child.ParentProcessId -ne [int]$Proxy.ProcessId -or $Runtime.executablePath -ine $Contract.stopIdentity.executablePath -or $Child.ExecutablePath -ine $Runtime.executablePath -or $Child.CommandLine -notmatch 'app-server') { throw 'WINDOW_CANDIDATE_LIVE_INSTANCE_UNKNOWN' }
        if ($Receipt.candidateLaunch -and $Receipt.candidateLaunch.instanceToken -cne $Runtime.instanceToken) { throw 'WINDOW_CANDIDATE_LAUNCH_TOKEN_CHANGED' }
        if ($Receipt.candidateInstance -and $Receipt.candidateInstance.instanceToken -cne $Runtime.instanceToken) { throw 'WINDOW_CANDIDATE_INSTANCE_ALREADY_BOUND' }
        $Stream = [IO.File]::Open($AttemptPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        if (-not $Receipt.PSObject.Properties['candidateInstance']) { $Receipt | Add-Member -NotePropertyName candidateInstance -NotePropertyValue $null }
        $Receipt.candidateInstance = [pscustomobject]@{ instanceToken = $Runtime.instanceToken; pid = $Runtime.pid; appServerPid = $Runtime.appServerPid; executablePath = $Runtime.executablePath; parentAttemptId = $Contract.parentAttemptId }
        Save; $Result.status = 'candidate-instance-bound'; $Result.candidateInstance = $Receipt.candidateInstance
      } elseif ($Action -eq 'Apply' -and $Receipt) {
        if ($Receipt.status -cne 'applied') { throw 'WINDOW_ATTEMPT_UNKNOWN_OR_TERMINAL' }
        foreach ($Entry in $Contract.items) { $Accepted = @($Receipt.accepted | Where-Object { $_.name -ceq $Entry.name }); if ($Accepted.Count -ne 1) { throw 'WINDOW_ACCEPTED_STATE_REQUIRED' }; Same $Accepted[0].state (State $Entry.target) }
        $Result.status = 'already-written-verified'
      } else {
        Assert-StopBoundary
        if ($Action -eq 'Restore' -and -not $Receipt) { throw 'WINDOW_ORIGINAL_ATTEMPT_REQUIRED' }
        $BeforeStates = @{}
        foreach ($Entry in $Contract.items) {
          $BeforeStates[$Entry.target] = State $Entry.target
          if ($Action -eq 'Apply') { Same $Entry.original $BeforeStates[$Entry.target] }
          else {
            $Accepted = @($Receipt.accepted | Where-Object { $_.name -ceq $Entry.name })
            if ($Accepted.Count -ne 1) { throw ('WINDOW_ACCEPTED_STATE_REQUIRED: ' + $Entry.name) }
            try { Same $Accepted[0].state $BeforeStates[$Entry.target] } catch { throw ('WINDOW_RESTORE_EXTERNAL_STATE_PRESERVED: ' + $Entry.name) }
          }
        }
        if ($Action -eq 'Apply') {
          $Stream = [IO.File]::Open($AttemptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
          $Receipt = [ordered]@{ schemaVersion = 1; ownerId = $Contract.ownerId; contractSha256 = $ContractSha256; windowSha256 = $WindowSha256; attemptId = [Guid]::NewGuid().ToString('N'); status = 'applying'; startedAt = [DateTimeOffset]::UtcNow.ToString('o'); mayHaveWritten = $false; attempted = @(); written = @(); completed = @(); accepted = @($Contract.items | ForEach-Object { [pscustomobject]@{ name = $_.name; state = $_.original; phase = 'original' } }); failure = $null }
          $Receipt.candidateInstance = $null; $Receipt.stopEvidencePath = $StopEvidencePath; $Receipt.stopEvidenceSha256 = $StopEvidenceSha256
        } else { $Stream = [IO.File]::Open($AttemptPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read); $Receipt.status = 'restoring'; $Receipt.completed = @() }
        Save
        foreach ($Entry in $Contract.items) {
          Assert-Contract
          Same $BeforeStates[$Entry.target] (State $Entry.target)
          $DesiredExists = if ($Action -eq 'Apply') { $true } else { $Entry.original.exists }
          $DesiredSha = if ($Action -eq 'Apply') { $Entry.candidateSha256 } else { $Entry.original.sha256 }
          $Current = State $Entry.target
          if ($DesiredExists -and ($Current.sha256 -cne $DesiredSha -or ($Action -eq 'Restore' -and $Current.sddl -cne $Entry.original.sddl))) {
            $Payload = if ($Action -eq 'Apply') { $Entry.candidatePath } else { $Entry.originalPath }
            $Stage = Join-Path (Split-Path -Parent $Entry.target) ('.outer-window-' + $Receipt.attemptId + '.tmp')
            [void](Plain $Stage)
            $StageStream = [IO.File]::Open($Stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $Bytes = [IO.File]::ReadAllBytes($Payload); $StageStream.Write($Bytes, 0, $Bytes.Length); $StageStream.Flush($true) } finally { $StageStream.Dispose() }
            if ((Sha $Stage) -cne $DesiredSha) { throw 'WINDOW_STAGE_CHANGED' }
            Same $BeforeStates[$Entry.target] (State $Entry.target)
            $Receipt.attempted += $Entry.name; $Receipt.mayHaveWritten = $true; Save
            try { if ($Current.exists) { [IO.File]::Replace($Stage, $Entry.target, [NullString]::Value) } else { [IO.File]::Move($Stage, $Entry.target) } }
            finally { if (Test-Path -LiteralPath $Stage) { if ((Sha $Stage) -ceq $DesiredSha) { Remove-Item -LiteralPath $Stage } else { throw 'WINDOW_STAGE_OWNERSHIP_CHANGED' } } }
            $Receipt.written += $Entry.name; Accept-State $Entry (State $Entry.target) 'atomic-write'
          } elseif (-not $DesiredExists -and $Current.exists) {
            $Receipt.attempted += $Entry.name; $Receipt.mayHaveWritten = $true; Save; Remove-Item -LiteralPath $Entry.target; $Receipt.written += $Entry.name; Accept-State $Entry (State $Entry.target) 'owned-remove'
          }
          if ($DesiredExists -and $Entry.original.exists) {
            try { Restore-Acl $Entry.target $Entry.original.sddl } finally { Accept-State $Entry (State $Entry.target) 'own-acl-result' }
            try { [IO.File]::SetAttributes($Entry.target, [IO.FileAttributes]$Entry.original.attributes) } finally { Accept-State $Entry (State $Entry.target) 'own-attributes-result' }
          }
          $After = State $Entry.target
          Accept-State $Entry $After 'write-observed'
          if ($After.exists -ne $DesiredExists -or ($DesiredExists -and $After.sha256 -cne $DesiredSha) -or ($Entry.original.exists -and $After.exists -and ($After.sddl -cne $Entry.original.sddl -or $After.attributes -ne $Entry.original.attributes))) { throw 'WINDOW_WRITE_VERIFICATION_FAILED' }
          $BeforeStates[$Entry.target] = $After
          $Receipt.completed += [pscustomobject]@{ name = $Entry.name; verified = $true }; Save
        }
        $Receipt.status = if ($Action -eq 'Apply') { 'applied' } else { 'restored' }; Save
        $Result.status = $Receipt.status
      }
      $Result.receiptPath = $AttemptPath; $Result.completed = $Receipt.completed; $Result.written = $Receipt.written
    }
  }
} catch {
  $Result.error = $_.Exception.Message; $ExitCode = 1
  if ($Receipt -and $Stream) { $Receipt.failure = $Result.error; $Receipt.status = if ($Receipt.mayHaveWritten) { 'partial' } else { 'preflight-failed' }; try { Save } catch { $Result.receiptFailure = $_.Exception.Message }; $Result.status = $Receipt.status; $Result.receiptPath = $AttemptPath; $Result.completed = $Receipt.completed; $Result.written = $Receipt.written }
} finally { if ($Stream) { $Stream.Dispose() }; if ($Mode -eq 'Production' -and $Receipt -and $Receipt.mayHaveWritten) { $Result.productionModified = $true }; $Result | ConvertTo-Json -Depth 14 -Compress }
if ($ExitCode) { exit $ExitCode }
