[CmdletBinding()]
param(
    [ValidateSet('Inspect', 'Prepare', 'Apply', 'Restore')]
    [string]$Mode = 'Inspect',
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][ValidateSet('development', 'training')][string]$MachineProfile,
    [Parameter(Mandatory = $true)][string]$TargetRoot,
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [switch]$AcknowledgedOfflineWindow,
    [switch]$IsolatedFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TargetPaths = @(
    'src/codex-app-server-proxy.mjs',
    'src/codex-thread-bridge.mjs',
    'src/wake-visibility.mjs',
    'ops/update-codex-napcat-bridge.ps1'
)
$Utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$AclSections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$OperationId = [Guid]::NewGuid().ToString('N')
$TemporaryPaths = [Collections.Generic.List[string]]::new()
$Attempted = [Collections.Generic.List[object]]::new()
$CleanupErrors = [Collections.Generic.List[string]]::new()
$LockStream = $null
$LockPath = $null
$ReceiptStream = $null
$ReceiptWriter = $null
$ReceiptPath = $null
$Recovery = $null
$Entries = @()
$ManifestHash = $null
$Phase = 'validate'
$FailedTarget = $null
$ExitCode = 1
$Result = [ordered]@{
    schemaVersion = 1
    operationId = $OperationId
    mode = $Mode
    machineProfile = $MachineProfile
    status = 'REFUSED'
    phase = $Phase
    failedTarget = $null
    error = $null
    receiptPath = $null
    cleanupErrors = @()
    dependencyWarnings = @()
}

function Fail([string]$Code, [string]$Message) {
    throw ($Code + ': ' + $Message)
}

function Assert-ObjectKeys($Value, [string[]]$Keys, [string]$Label) {
    if ($null -eq $Value -or $Value -isnot [Management.Automation.PSCustomObject]) {
        Fail 'INVALID_OBJECT' $Label
    }
    $Actual = @($Value.PSObject.Properties.Name)
    if ($Actual.Count -ne $Keys.Count) { Fail 'INVALID_KEYS' $Label }
    foreach ($Key in $Actual) {
        if ($Keys -cnotcontains $Key) { Fail 'INVALID_KEYS' ($Label + '.' + $Key) }
    }
}

function Assert-Sha($Value, [string]$Label) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-fA-F]{64}$') { Fail 'INVALID_SHA256' $Label }
}

function Get-AbsolutePath([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:[\\/]') {
        Fail 'ABSOLUTE_LOCAL_PATH_REQUIRED' $Label
    }
    $Normalized = $Value.Replace('/', '\').TrimEnd('\')
    foreach ($Segment in $Normalized.Substring(3).Split('\')) {
        if ([string]::IsNullOrEmpty($Segment) -or $Segment -eq '.' -or $Segment -eq '..' -or $Segment -match '[<>:"|?*\x00-\x1f]' -or $Segment.EndsWith('.') -or $Segment.EndsWith(' ')) {
            Fail 'NON_CANONICAL_PATH' $Label
        }
    }
    $Full = [IO.Path]::GetFullPath($Normalized).TrimEnd('\')
    if ($Full.Length -le 3 -or -not $Full.Equals($Normalized, [StringComparison]::OrdinalIgnoreCase)) {
        Fail 'NON_CANONICAL_PATH' $Label
    }
    return $Full
}

function Assert-NoReparse([string]$Path) {
    $Cursor = $Path
    while ($Cursor) {
        try {
            $Item = Get-Item -LiteralPath $Cursor -Force -ErrorAction Stop
            if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail 'REPARSE_PATH' $Cursor }
            if ($Cursor -ne $Path -and -not $Item.PSIsContainer) { Fail 'NON_DIRECTORY_ANCESTOR' $Cursor }
        } catch {
            if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw }
        }
        $Parent = [IO.Directory]::GetParent($Cursor)
        if ($null -eq $Parent) { break }
        $Cursor = $Parent.FullName
    }
}

function Assert-File([string]$Path) {
    Assert-NoReparse $Path
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($Item.PSIsContainer) { Fail 'FILE_REQUIRED' $Path }
}

function Assert-Directory([string]$Path) {
    Assert-NoReparse $Path
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (-not $Item.PSIsContainer) { Fail 'DIRECTORY_REQUIRED' $Path }
}

function Test-Within([string]$Child, [string]$Parent) {
    return $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-Disjoint([string]$First, [string]$Second) {
    if ($First.Equals($Second, [StringComparison]::OrdinalIgnoreCase) -or (Test-Within $First $Second) -or (Test-Within $Second $First)) {
        Fail 'OVERLAPPING_ROOTS' ($First + ' / ' + $Second)
    }
}

function Assert-MemberPath($Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\\:*?"<>|\x00-\x1f]' -or $Value.StartsWith('/')) {
        Fail 'INVALID_MEMBER_PATH' ([string]$Value)
    }
    foreach ($Segment in $Value.Split('/')) {
        if ([string]::IsNullOrEmpty($Segment) -or $Segment -eq '.' -or $Segment -eq '..' -or $Segment.EndsWith('.') -or $Segment.EndsWith(' ') -or $Segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            Fail 'INVALID_MEMBER_PATH' $Value
        }
    }
}

function Join-Safe([string]$Root, [string]$Member) {
    Assert-MemberPath $Member
    $Joined = Get-AbsolutePath ([IO.Path]::Combine($Root, $Member.Replace('/', '\'))) 'member'
    if (-not (Test-Within $Joined $Root)) { Fail 'PATH_ESCAPE' $Member }
    Assert-NoReparse $Joined
    return $Joined
}

function Get-FixtureAnchor([string]$Root) {
    $SystemTemp = Get-AbsolutePath ([IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'Temp')) 'systemTemp'
    Assert-Directory $SystemTemp
    if (-not (Test-Within $Root $SystemTemp)) { Fail 'FIXTURE_OUTSIDE_SYSTEM_TEMP' $Root }
    $Relative = $Root.Substring($SystemTemp.Length + 1)
    $Cursor = $SystemTemp
    foreach ($Segment in $Relative.Split('\')) {
        $Cursor = [IO.Path]::Combine($Cursor, $Segment)
        if ($Segment -cmatch '^merged-candidate-fixture-[A-Za-z0-9][A-Za-z0-9-]{7,}$') {
            Assert-Directory $Cursor
            return $Cursor
        }
    }
    Fail 'FIXTURE_ANCHOR_REQUIRED' $Root
}

function Get-Sha256([string]$Path) {
    Assert-File $Path
    $Hasher = [Security.Cryptography.SHA256]::Create()
    $Stream = $null
    try {
        $Stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($null -ne $Stream) { $Stream.Dispose() }
        $Hasher.Dispose()
    }
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Code) {
    if ((Get-Sha256 $Path) -ine $Expected) { Fail $Code $Path }
}

function Initialize-NativeAcl {
    if (-not ('MergedCandidateMaintenance.NativeAcl' -as [type])) {
        $Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('MergedCandidateMaintenance.NativeAcl'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
        $Module = $Assembly.DefineDynamicModule('NativeAcl')
        $Builder = $Module.DefineType('MergedCandidateMaintenance.NativeAcl', [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
        $Attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
        $Getter = $Builder.DefinePInvokeMethod('Get', 'advapi32.dll', 'GetFileSecurityW', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([string], [uint32], [byte[]], [uint32], ([uint32]).MakeByRefType()), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
        $Setter = $Builder.DefinePInvokeMethod('Set', 'advapi32.dll', 'SetNamedSecurityInfoW', $Attributes, [Reflection.CallingConventions]::Standard, [uint32], [type[]]@([string], [int], [uint32], [byte[]], [byte[]], [byte[]], [IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
        $RawSetter = $Builder.DefinePInvokeMethod('SetRaw', 'advapi32.dll', 'SetFileSecurityW', $Attributes, [Reflection.CallingConventions]::Standard, [bool], [type[]]@([string], [uint32], [byte[]]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
        $Getter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
        $Setter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
        $RawSetter.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
        [void]$Builder.CreateType()
    }
}

function Get-AclSddl([string]$Path) {
    Assert-File $Path
    Initialize-NativeAcl
    [uint32]$Needed = 0
    [void][MergedCandidateMaintenance.NativeAcl]::Get($Path, 7, $null, 0, [ref]$Needed)
    if ($Needed -eq 0) { Fail 'ACL_READ_FAILED' $Path }
    $Buffer = [byte[]]::new($Needed)
    if (-not [MergedCandidateMaintenance.NativeAcl]::Get($Path, 7, $Buffer, $Needed, [ref]$Needed)) { Fail 'ACL_READ_FAILED' $Path }
    $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Buffer, 0)
    if ($null -eq $Descriptor.DiscretionaryAcl) { Fail 'NULL_DACL_UNSUPPORTED' $Path }
    return $Descriptor.GetSddlForm($AclSections)
}

function Set-SavedAcl([string]$Path, [string]$Sddl) {
    Assert-File $Path
    Initialize-NativeAcl
    $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
    $OwnerBytes = [byte[]]::new($Descriptor.Owner.BinaryLength)
    $GroupBytes = [byte[]]::new($Descriptor.Group.BinaryLength)
    $DaclBytes = [byte[]]::new($Descriptor.DiscretionaryAcl.BinaryLength)
    $Descriptor.Owner.GetBinaryForm($OwnerBytes, 0)
    $Descriptor.Group.GetBinaryForm($GroupBytes, 0)
    $Descriptor.DiscretionaryAcl.GetBinaryForm($DaclBytes, 0)
    $Protect = ($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
    [uint32]$Information = 7
    if ($Protect) { $Information = $Information -bor [uint32]2147483648 } else { $Information = $Information -bor [uint32]536870912 }
    $AutoInherited = ($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0
    if ($AutoInherited) {
        $ReturnCode = [MergedCandidateMaintenance.NativeAcl]::Set($Path, 1, $Information, $OwnerBytes, $GroupBytes, $DaclBytes, [IntPtr]::Zero)
        if ($ReturnCode -ne 0) { Fail 'ACL_WRITE_FAILED' ([ComponentModel.Win32Exception]::new([int]$ReturnCode).Message) }
    } else {
        $DescriptorBytes = [byte[]]::new($Descriptor.BinaryLength)
        $Descriptor.GetBinaryForm($DescriptorBytes, 0)
        if (-not [MergedCandidateMaintenance.NativeAcl]::SetRaw($Path, $Information, $DescriptorBytes)) { Fail 'ACL_WRITE_FAILED' $Path }
    }
    if ((Get-AclSddl $Path) -cne $Sddl) { Fail 'ACL_MISMATCH' $Path }
}

function Read-Json([string]$Path) {
    Assert-File $Path
    if ((Get-Item -LiteralPath $Path).Length -gt 1048576) { Fail 'MANIFEST_TOO_LARGE' $Path }
    return ([IO.File]::ReadAllText($Path, $Utf8) | ConvertFrom-Json -ErrorAction Stop)
}

function Read-CandidateManifest {
    $script:ManifestHash = Get-Sha256 $ManifestPath
    $Document = Read-Json $ManifestPath
    Assert-ObjectKeys $Document @('schemaVersion', 'state', 'sourceCommit', 'profiles') 'manifest'
    if ($Document.schemaVersion -isnot [int] -or $Document.schemaVersion -ne 3) { Fail 'UNKNOWN_SCHEMA' 'manifest' }
    if ($Document.state -cne 'PREPARED_NOT_APPLIED') { Fail 'UNKNOWN_STATE' 'manifest' }
    if ($Document.sourceCommit -isnot [string] -or $Document.sourceCommit -cnotmatch '^[0-9a-fA-F]{40}$') { Fail 'INVALID_SOURCE_COMMIT' 'manifest' }
    Assert-ObjectKeys $Document.profiles @('development', 'training') 'profiles'
    foreach ($ProfileName in @('development', 'training')) {
        $Profile = $Document.profiles.$ProfileName
        Assert-ObjectKeys $Profile @('targets', 'unchangedProductionDependencies') $ProfileName
        if ($Profile.targets -isnot [array] -or $Profile.targets.Count -ne $TargetPaths.Count) { Fail 'TARGET_SET_MISMATCH' $ProfileName }
        $Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($Target in $Profile.targets) {
            Assert-ObjectKeys $Target @('path', 'beforeSha256', 'candidateSha256') 'target'
            Assert-MemberPath $Target.path
            if ($TargetPaths -cnotcontains $Target.path -or -not $Seen.Add($Target.path)) { Fail 'TARGET_SET_MISMATCH' $ProfileName }
            Assert-Sha $Target.beforeSha256 'beforeSha256'
            Assert-Sha $Target.candidateSha256 'candidateSha256'
            if ($Target.beforeSha256 -ieq $Target.candidateSha256) { Fail 'UNCHANGED_TARGET' $Target.path }
        }
        if ($Profile.unchangedProductionDependencies -isnot [array] -or $Profile.unchangedProductionDependencies.Count -lt 1) { Fail 'DEPENDENCIES_REQUIRED' $ProfileName }
        foreach ($Dependency in $Profile.unchangedProductionDependencies) {
            Assert-ObjectKeys $Dependency @('path', 'sha256') 'dependency'
            Assert-MemberPath $Dependency.path
            Assert-Sha $Dependency.sha256 'dependency.sha256'
            if (-not $Seen.Add($Dependency.path)) { Fail 'DUPLICATE_OR_TARGET_DEPENDENCY' $Dependency.path }
        }
    }
    Assert-Hash $ManifestPath $ManifestHash 'SOURCE_MANIFEST_DRIFT'
    return $Document
}

function Assert-PackageAndDependencies {
    Assert-Hash $ManifestPath $ManifestHash 'SOURCE_MANIFEST_DRIFT'
    foreach ($ProfileName in @('development', 'training')) {
        foreach ($Target in $Manifest.profiles.$ProfileName.targets) {
            $Payload = Join-Safe $PackageRoot ('payload/' + $ProfileName + '/' + $Target.path)
            Assert-Hash $Payload $Target.candidateSha256 'CANDIDATE_DRIFT'
        }
    }
    foreach ($Dependency in $Manifest.profiles.$MachineProfile.unchangedProductionDependencies) {
        Assert-Hash (Join-Safe $TargetRoot $Dependency.path) $Dependency.sha256 'DEPENDENCY_DRIFT'
    }
}

function Read-RestoreDependencyWarnings {
    $Warnings = @()
    foreach ($Dependency in $Manifest.profiles.$MachineProfile.unchangedProductionDependencies) {
        $DependencyFile = Join-Safe $TargetRoot $Dependency.path
        $ActualHash = $null
        $WarningCode = $null
        $Message = $null
        try {
            if (-not (Test-Path -LiteralPath $DependencyFile)) {
                $WarningCode = 'DEPENDENCY_MISSING'
                $Message = 'The unchanged production dependency is missing; its path was left untouched.'
            } elseif (-not (Test-Path -LiteralPath $DependencyFile -PathType Leaf)) {
                $WarningCode = 'DEPENDENCY_NOT_FILE'
                $Message = 'The unchanged production dependency is not a file; it was left untouched.'
            } else {
                $ActualHash = Get-Sha256 $DependencyFile
                if ($ActualHash -ine $Dependency.sha256) {
                    $WarningCode = 'DEPENDENCY_DRIFT'
                    $Message = 'The unchanged production dependency differs from the prepared SHA256; it was left untouched.'
                }
            }
        } catch {
            Assert-NoReparse $DependencyFile
            $WarningCode = 'DEPENDENCY_UNREADABLE'
            $Message = 'The unchanged production dependency could not be hashed; it was left untouched: ' + $_.Exception.Message
        }
        if ($null -ne $WarningCode) {
            $Warnings += [pscustomobject]@{ path = $Dependency.path; code = $WarningCode; expectedSha256 = $Dependency.sha256; actualSha256 = $ActualHash; message = $Message }
        }
    }
    return $Warnings
}

function Assert-MaintenanceInputs {
    if ($Mode -ne 'Restore') { Assert-PackageAndDependencies; return }
    Assert-Hash $ManifestPath $ManifestHash 'SOURCE_MANIFEST_DRIFT'
    foreach ($ProfileName in @('development', 'training')) {
        foreach ($Target in $Manifest.profiles.$ProfileName.targets) {
            [void](Join-Safe $PackageRoot ('payload/' + $ProfileName + '/' + $Target.path))
        }
    }
    $Result.dependencyWarnings = @(Read-RestoreDependencyWarnings)
}

function Read-TargetSnapshot {
    $Snapshot = @()
    foreach ($Entry in $Entries) {
        $Hash = Get-Sha256 $Entry.targetPath
        if ($Hash -ine $Entry.beforeSha256 -and $Hash -ine $Entry.candidateSha256) { Fail 'TARGET_DRIFT' $Entry.path }
        $Snapshot += [pscustomobject]@{ path = $Entry.path; sha256 = $Hash; aclSddl = (Get-AclSddl $Entry.targetPath) }
    }
    return $Snapshot
}

function Assert-Baseline($Snapshot) {
    foreach ($Current in $Snapshot) {
        $Entry = @($Entries | Where-Object { $_.path -ceq $Current.path })[0]
        if ($Current.sha256 -ine $Entry.beforeSha256) { Fail 'BASELINE_REQUIRED' $Current.path }
    }
}

function Assert-Backup {
    Assert-Directory $BackupRoot
    $RecoveryPath = Join-Safe $BackupRoot 'recovery-manifest.json'
    $DigestPath = Join-Safe $BackupRoot 'recovery-manifest.sha256'
    Assert-File $DigestPath
    $Digest = [IO.File]::ReadAllText($DigestPath, $Utf8).Trim()
    Assert-Sha $Digest 'recovery-manifest.sha256'
    Assert-Hash $RecoveryPath $Digest 'RECOVERY_MANIFEST_DRIFT'
    $Document = Read-Json $RecoveryPath
    Assert-ObjectKeys $Document @('schemaVersion', 'state', 'sourceCommit', 'manifestSha256', 'machineProfile', 'targetRoot', 'backupRoot', 'targets', 'unchangedProductionDependencies') 'recovery'
    if ($Document.schemaVersion -isnot [int] -or $Document.schemaVersion -ne 1) { Fail 'UNKNOWN_SCHEMA' 'recovery' }
    if ($Document.state -cne 'PREPARED_NOT_APPLIED') { Fail 'UNKNOWN_STATE' 'recovery' }
    if ($Document.machineProfile -cne $MachineProfile) { Fail 'BACKUP_PROFILE_MISMATCH' $MachineProfile }
    if ($Document.targetRoot -isnot [string] -or $Document.backupRoot -isnot [string] -or -not $TargetRoot.Equals($Document.targetRoot, [StringComparison]::OrdinalIgnoreCase) -or -not $BackupRoot.Equals($Document.backupRoot, [StringComparison]::OrdinalIgnoreCase)) { Fail 'BACKUP_ROOT_MISMATCH' $BackupRoot }
    if ($Document.sourceCommit -ine $Manifest.sourceCommit -or $Document.manifestSha256 -ine $ManifestHash) { Fail 'SOURCE_MANIFEST_DRIFT' $ManifestPath }
    if ($Document.targets -isnot [array] -or $Document.targets.Count -ne $Entries.Count) { Fail 'RECOVERY_TARGET_SET_MISMATCH' $BackupRoot }
    for ($Index = 0; $Index -lt $Entries.Count; $Index++) {
        $Entry = $Entries[$Index]
        $Saved = $Document.targets[$Index]
        Assert-ObjectKeys $Saved @('path', 'beforeSha256', 'candidateSha256', 'aclSddl', 'backupAclSddl') 'recovery.target'
        if ($Saved.path -cne $Entry.path -or $Saved.beforeSha256 -ine $Entry.beforeSha256 -or $Saved.candidateSha256 -ine $Entry.candidateSha256 -or $Saved.aclSddl -isnot [string] -or $Saved.backupAclSddl -isnot [string]) { Fail 'RECOVERY_TARGET_MISMATCH' $Entry.path }
        [void][Security.AccessControl.RawSecurityDescriptor]::new($Saved.aclSddl)
        [void][Security.AccessControl.RawSecurityDescriptor]::new($Saved.backupAclSddl)
        Assert-Hash $Entry.backupPath $Entry.beforeSha256 'BACKUP_DRIFT'
        if ((Get-AclSddl $Entry.backupPath) -cne $Saved.backupAclSddl) { Fail 'BACKUP_ACL_DRIFT' $Entry.path }
        $Entry.aclSddl = $Saved.aclSddl
    }
    $Dependencies = $Manifest.profiles.$MachineProfile.unchangedProductionDependencies
    if ($Document.unchangedProductionDependencies -isnot [array] -or $Document.unchangedProductionDependencies.Count -ne $Dependencies.Count) { Fail 'RECOVERY_DEPENDENCY_MISMATCH' $BackupRoot }
    for ($Index = 0; $Index -lt $Dependencies.Count; $Index++) {
        $Saved = $Document.unchangedProductionDependencies[$Index]
        Assert-ObjectKeys $Saved @('path', 'sha256') 'recovery.dependency'
        if ($Saved.path -cne $Dependencies[$Index].path -or $Saved.sha256 -ine $Dependencies[$Index].sha256) { Fail 'RECOVERY_DEPENDENCY_MISMATCH' $Saved.path }
    }
    Assert-Hash $RecoveryPath $Digest 'RECOVERY_MANIFEST_DRIFT'
    return $Document
}

function Assert-TargetAcls($Snapshot) {
    foreach ($Current in $Snapshot) {
        $Entry = @($Entries | Where-Object { $_.path -ceq $Current.path })[0]
        if ($Current.aclSddl -cne $Entry.aclSddl) { Fail 'TARGET_ACL_DRIFT' $Current.path }
    }
}

function Assert-Offline {
    if ($IsolatedFixture) {
        $First = Get-FixtureAnchor $TargetRoot
        $Second = Get-FixtureAnchor $BackupRoot
        if (-not $First.Equals($Second, [StringComparison]::OrdinalIgnoreCase)) { Fail 'FIXTURE_ROOT_MISMATCH' $BackupRoot }
        return
    }
    $Processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    if ($Processes.Count -eq 0) { Fail 'PROCESS_SCAN_INCOMPLETE' 'Win32_Process returned no processes' }
    $Blocking = @($Processes | Where-Object {
        $_.Name -ieq 'codex.exe' -or ([string]$_.CommandLine -match '(?i)codex-app-server-proxy-runner|task-router-runner')
    })
    if ($Blocking.Count -gt 0) {
        $Identities = @($Blocking | ForEach-Object { ([string]$_.ProcessId) + '/' + $_.Name })
        Fail 'OFFLINE_PROCESSES_RUNNING' ($Identities -join ', ')
    }
    $Unreadable = @($Processes | Where-Object { $_.Name -imatch '^(node|powershell|pwsh|cmd|wscript|cscript)\.exe$' -and [string]::IsNullOrWhiteSpace([string]$_.CommandLine) })
    if ($Unreadable.Count -gt 0) { Fail 'PROCESS_SCAN_INCOMPLETE' 'A possible runner command line is unreadable' }
}

function New-Directory([string]$Path) {
    Assert-NoReparse $Path
    [void][IO.Directory]::CreateDirectory($Path)
    Assert-Directory $Path
}

function Write-NewText([string]$Path, [string]$Text) {
    Assert-NoReparse $Path
    $Stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $Bytes = $Utf8.GetBytes($Text)
        $Stream.Write($Bytes, 0, $Bytes.Length)
        $Stream.Flush($true)
    } finally { $Stream.Dispose() }
}

function Write-ReceiptEvent([string]$Event, $Data) {
    if ($null -eq $ReceiptWriter) { return }
    $Record = [ordered]@{ schemaVersion = 1; operationId = $OperationId; timestampUtc = [DateTime]::UtcNow.ToString('o'); event = $Event; data = $Data }
    $ReceiptWriter.WriteLine(($Record | ConvertTo-Json -Depth 20 -Compress))
    $ReceiptWriter.Flush()
    $ReceiptStream.Flush($true)
}

function Start-Receipt($Snapshot) {
    $ReceiptDirectory = Join-Safe $BackupRoot 'receipts'
    New-Directory $ReceiptDirectory
    $script:ReceiptPath = Join-Safe $ReceiptDirectory ($OperationId + '.jsonl')
    $script:ReceiptStream = [IO.File]::Open($ReceiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $script:ReceiptWriter = [IO.StreamWriter]::new($ReceiptStream, $Utf8, 4096, $true)
    Write-ReceiptEvent 'started' ([ordered]@{ mode = $Mode; machineProfile = $MachineProfile; targetRoot = $TargetRoot; backupRoot = $BackupRoot; manifestSha256 = $ManifestHash; sourceCommit = $Manifest.sourceCommit; isolatedFixture = [bool]$IsolatedFixture; targetsBefore = @($Snapshot) })
}

function New-TemporaryFileName([ValidateSet('.new', '.old')][string]$Extension) {
    return '.merged-' + [Guid]::NewGuid().ToString('N') + $Extension
}

function New-ReplacementStage($Entry, [string]$Source, [string]$Hash) {
    Assert-File $Entry.targetPath
    Assert-Hash $Source $Hash 'REPLACEMENT_SOURCE_DRIFT'
    $Parent = [IO.Path]::GetDirectoryName($Entry.targetPath)
    $NewPath = Join-Safe $Parent (New-TemporaryFileName '.new')
    $OldPath = Join-Safe $Parent (New-TemporaryFileName '.old')
    $TemporaryPaths.Add($NewPath)
    $TemporaryPaths.Add($OldPath)
    [IO.File]::Copy($Source, $NewPath, $false)
    Set-SavedAcl $NewPath $Entry.aclSddl
    Assert-Hash $NewPath $Hash 'STAGED_FILE_DRIFT'
    if (Test-Path -LiteralPath $OldPath) { Fail 'TEMPORARY_PATH_EXISTS' $OldPath }
    return [pscustomobject]@{ entry = $Entry; newPath = $NewPath; oldPath = $OldPath; hash = $Hash }
}

function Invoke-Replacement($Stage, [string]$CurrentHash) {
    $Entry = $Stage.entry
    Assert-Hash $Entry.targetPath $CurrentHash 'TARGET_DRIFT'
    Assert-Hash $Stage.newPath $Stage.hash 'STAGED_FILE_DRIFT'
    Assert-NoReparse $Stage.oldPath
    if ((Get-AclSddl $Entry.targetPath) -cne $Entry.aclSddl) { Fail 'TARGET_ACL_DRIFT' $Entry.path }
    $Attempted.Add([pscustomobject]@{ entry = $Entry; oldPath = $Stage.oldPath; previousHash = $CurrentHash })
    Write-ReceiptEvent 'replaceStarted' ([ordered]@{ path = $Entry.path; beforeSha256 = $CurrentHash; afterSha256 = $Stage.hash })
    [IO.File]::Replace($Stage.newPath, $Entry.targetPath, $Stage.oldPath, $false)
    Assert-Hash $Entry.targetPath $Stage.hash 'REPLACED_TARGET_DRIFT'
    if ((Get-AclSddl $Entry.targetPath) -cne $Entry.aclSddl) { Set-SavedAcl $Entry.targetPath $Entry.aclSddl }
    if ((Get-AclSddl $Entry.targetPath) -cne $Entry.aclSddl) { Fail 'REPLACED_TARGET_ACL_MISMATCH' $Entry.path }
    Write-ReceiptEvent 'replaceCompleted' ([ordered]@{ path = $Entry.path; sha256 = $Stage.hash })
}

function Restore-BaselineAfterFailure {
    $script:Recovery = Assert-Backup
    Assert-Offline
    $Work = @()
    foreach ($Entry in $Entries) {
        Assert-NoReparse $Entry.targetPath
        if (-not (Test-Path -LiteralPath $Entry.targetPath)) {
            $OwnAttempt = @($Attempted | Where-Object { $_.entry.path -ceq $Entry.path -and (Test-Path -LiteralPath $_.oldPath) })
            if ($OwnAttempt.Count -ne 1) { Fail 'ROLLBACK_TARGET_MISSING' $Entry.path }
            Assert-Hash $OwnAttempt[0].oldPath $OwnAttempt[0].previousHash 'ROLLBACK_DISPLACED_FILE_DRIFT'
            $Work += [pscustomobject]@{ entry = $Entry; currentHash = $null }
            continue
        }
        $Hash = Get-Sha256 $Entry.targetPath
        if ($Hash -ine $Entry.beforeSha256 -and $Hash -ine $Entry.candidateSha256) { Fail 'ROLLBACK_TARGET_DRIFT' $Entry.path }
        if ($Hash -ine $Entry.beforeSha256 -or (Get-AclSddl $Entry.targetPath) -cne $Entry.aclSddl) {
            $Work += [pscustomobject]@{ entry = $Entry; currentHash = $Hash }
        }
    }
    [array]::Reverse($Work)
    $Errors = @()
    foreach ($Item in $Work) {
        try {
            $Entry = $Item.entry
            if ($null -eq $Item.currentHash) {
                $Parent = [IO.Path]::GetDirectoryName($Entry.targetPath)
                $NewPath = Join-Safe $Parent (New-TemporaryFileName '.new')
                $TemporaryPaths.Add($NewPath)
                [IO.File]::Copy($Entry.backupPath, $NewPath, $false)
                Set-SavedAcl $NewPath $Entry.aclSddl
                Assert-Hash $NewPath $Entry.beforeSha256 'STAGED_FILE_DRIFT'
                Assert-NoReparse $Entry.targetPath
                [IO.File]::Move($NewPath, $Entry.targetPath)
            } else {
                $Stage = New-ReplacementStage $Entry $Entry.backupPath $Entry.beforeSha256
                Assert-Hash $Entry.targetPath $Item.currentHash 'ROLLBACK_TARGET_DRIFT'
                [IO.File]::Replace($Stage.newPath, $Entry.targetPath, $Stage.oldPath, $false)
                if ((Get-AclSddl $Entry.targetPath) -cne $Entry.aclSddl) { Set-SavedAcl $Entry.targetPath $Entry.aclSddl }
            }
            Assert-Hash $Entry.targetPath $Entry.beforeSha256 'ROLLBACK_TARGET_DRIFT'
            if ((Get-AclSddl $Entry.targetPath) -cne $Entry.aclSddl) { Fail 'ROLLBACK_ACL_MISMATCH' $Entry.path }
            Write-ReceiptEvent 'rollbackCompleted' ([ordered]@{ path = $Entry.path; sha256 = $Entry.beforeSha256 })
        } catch { $Errors += ($Item.entry.path + ': ' + $_.Exception.Message) }
    }
    if ($Errors.Count -gt 0) { Fail 'ROLLBACK_INCOMPLETE' ($Errors -join '; ') }
    $Snapshot = @(Read-TargetSnapshot)
    Assert-Baseline $Snapshot
    Assert-TargetAcls $Snapshot
    return $Snapshot
}

try {
    if ($env:OS -ne 'Windows_NT' -or $PSVersionTable.PSVersion -lt [Version]'5.1') { Fail 'WINDOWS_POWERSHELL_51_REQUIRED' 'Windows PowerShell 5.1 or later is required' }
    $TargetRoot = Get-AbsolutePath $TargetRoot 'TargetRoot'
    $BackupRoot = Get-AbsolutePath $BackupRoot 'BackupRoot'
    $ManifestPath = Get-AbsolutePath $ManifestPath 'ManifestPath'
    $PackageRoot = Get-AbsolutePath ([IO.Path]::GetDirectoryName($ManifestPath)) 'PackageRoot'
    if ($IsolatedFixture) {
        $TargetFixture = Get-FixtureAnchor $TargetRoot
        $BackupFixture = Get-FixtureAnchor $BackupRoot
        if (-not $TargetFixture.Equals($BackupFixture, [StringComparison]::OrdinalIgnoreCase)) { Fail 'FIXTURE_ROOT_MISMATCH' $BackupRoot }
    }
    Assert-Directory $TargetRoot
    Assert-NoReparse $BackupRoot
    if (Test-Path -LiteralPath $BackupRoot) { Assert-Directory $BackupRoot }
    Assert-File $ManifestPath
    Assert-Disjoint $TargetRoot $BackupRoot
    Assert-Disjoint $TargetRoot $PackageRoot
    Assert-Disjoint $BackupRoot $PackageRoot
    $Manifest = Read-CandidateManifest
    foreach ($Path in $TargetPaths) {
        $Target = @($Manifest.profiles.$MachineProfile.targets | Where-Object { $_.path -ceq $Path })[0]
        $Entries += [pscustomobject]@{
            path = $Path
            beforeSha256 = $Target.beforeSha256.ToLowerInvariant()
            candidateSha256 = $Target.candidateSha256.ToLowerInvariant()
            targetPath = (Join-Safe $TargetRoot $Path)
            candidatePath = (Join-Safe $PackageRoot ('payload/' + $MachineProfile + '/' + $Path))
            backupPath = (Join-Safe $BackupRoot ('original/' + $Path))
            aclSddl = $null
        }
    }
    Assert-MaintenanceInputs
    $Snapshot = @(Read-TargetSnapshot)
    $RecoveryPath = Join-Safe $BackupRoot 'recovery-manifest.json'
    if (Test-Path -LiteralPath $RecoveryPath) {
        $Recovery = Assert-Backup
        Assert-TargetAcls $Snapshot
    } elseif ((Test-Path -LiteralPath $BackupRoot) -and @(Get-ChildItem -LiteralPath $BackupRoot -Force).Count -gt 0) {
        Fail 'INCOMPLETE_OR_UNOWNED_BACKUP' $BackupRoot
    }
    if ($Mode -eq 'Inspect') {
        $Result.status = 'INSPECTED'
        $Result['backupPrepared'] = ($null -ne $Recovery)
        $Result['targets'] = $Snapshot
        $ExitCode = 0
    } else {
        if ($Mode -eq 'Prepare') {
            Assert-Baseline $Snapshot
        } else {
            if (-not $AcknowledgedOfflineWindow) { Fail 'OFFLINE_WINDOW_REQUIRED' $Mode }
            if ($null -eq $Recovery) { Fail 'PREPARE_REQUIRED' $BackupRoot }
            if ($Mode -eq 'Apply') {
                $BaselineCount = @($Snapshot | Where-Object { $Current = $_; @($Entries | Where-Object { $_.path -ceq $Current.path -and $_.beforeSha256 -ieq $Current.sha256 }).Count -eq 1 }).Count
                if ($BaselineCount -ne 0 -and $BaselineCount -ne $Entries.Count) { Fail 'PARTIAL_APPLICATION_REQUIRES_RESTORE' $TargetRoot }
            }
            Assert-Offline
        }
        $Phase = 'lock'
        New-Directory $BackupRoot
        $LockPath = Join-Safe $BackupRoot 'maintenance.lock'
        $LockStream = [IO.FileStream]::new($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
        $Phase = 'preflight'
        Assert-MaintenanceInputs
        $LockedSnapshot = @(Read-TargetSnapshot)
        for ($Index = 0; $Index -lt $Snapshot.Count; $Index++) {
            if ($LockedSnapshot[$Index].sha256 -ine $Snapshot[$Index].sha256 -or $LockedSnapshot[$Index].aclSddl -cne $Snapshot[$Index].aclSddl) { Fail 'TARGET_DRIFT' $LockedSnapshot[$Index].path }
        }
        $Snapshot = $LockedSnapshot
        if ($null -ne $Recovery) { $Recovery = Assert-Backup; Assert-TargetAcls $Snapshot }
        if ($Mode -eq 'Prepare') { Assert-Baseline $Snapshot }
        Start-Receipt $Snapshot
        if ($Mode -eq 'Restore' -and $Result.dependencyWarnings.Count -gt 0) { Write-ReceiptEvent 'restoreDependencyWarnings' $Result.dependencyWarnings }
        if ($Mode -eq 'Prepare') {
            if ($null -ne $Recovery) {
                $Result.status = 'ALREADY_PREPARED'
            } else {
                $Phase = 'backup'
                $SavedTargets = @()
                foreach ($Entry in $Entries) {
                    $FailedTarget = $Entry.path
                    $Current = @($Snapshot | Where-Object { $_.path -ceq $Entry.path })[0]
                    $Entry.aclSddl = $Current.aclSddl
                    New-Directory ([IO.Path]::GetDirectoryName($Entry.backupPath))
                    [IO.File]::Copy($Entry.targetPath, $Entry.backupPath, $false)
                    $BackupDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Entry.aclSddl)
                    $BackupDescriptor.SetFlags($BackupDescriptor.ControlFlags -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)
                    foreach ($Ace in $BackupDescriptor.DiscretionaryAcl) { $Ace.AceFlags = [Security.AccessControl.AceFlags]([int]$Ace.AceFlags -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited)) }
                    $BackupAcl = $BackupDescriptor.GetSddlForm($AclSections)
                    Set-SavedAcl $Entry.backupPath $BackupAcl
                    Assert-Hash $Entry.backupPath $Entry.beforeSha256 'BACKUP_DRIFT'
                    $SavedTargets += [ordered]@{ path = $Entry.path; beforeSha256 = $Entry.beforeSha256; candidateSha256 = $Entry.candidateSha256; aclSddl = $Entry.aclSddl; backupAclSddl = $BackupAcl }
                }
                Assert-PackageAndDependencies
                $Snapshot = @(Read-TargetSnapshot)
                Assert-Baseline $Snapshot
                Assert-TargetAcls $Snapshot
                $NewRecovery = [ordered]@{
                    schemaVersion = 1
                    state = 'PREPARED_NOT_APPLIED'
                    sourceCommit = $Manifest.sourceCommit
                    manifestSha256 = $ManifestHash
                    machineProfile = $MachineProfile
                    targetRoot = $TargetRoot
                    backupRoot = $BackupRoot
                    targets = @($SavedTargets)
                    unchangedProductionDependencies = @($Manifest.profiles.$MachineProfile.unchangedProductionDependencies)
                }
                Write-NewText $RecoveryPath (($NewRecovery | ConvertTo-Json -Depth 20) + "`n")
                Write-NewText (Join-Safe $BackupRoot 'recovery-manifest.sha256') ((Get-Sha256 $RecoveryPath) + "`n")
                $Recovery = Assert-Backup
                $Result.status = 'PREPARED'
            }
        } else {
            $Phase = 'stage'
            $Stages = @()
            foreach ($Entry in $Entries) {
                $FailedTarget = $Entry.path
                $Current = @($Snapshot | Where-Object { $_.path -ceq $Entry.path })[0]
                $Desired = $Entry.beforeSha256
                $Source = $Entry.backupPath
                if ($Mode -eq 'Apply') { $Desired = $Entry.candidateSha256; $Source = $Entry.candidatePath }
                if ($Current.sha256 -ine $Desired) {
                    $Stages += [pscustomobject]@{ stage = (New-ReplacementStage $Entry $Source $Desired); currentHash = $Current.sha256 }
                }
            }
            $Phase = 'replace'
            Assert-MaintenanceInputs
            $Recovery = Assert-Backup
            $Latest = @(Read-TargetSnapshot)
            Assert-TargetAcls $Latest
            for ($Index = 0; $Index -lt $Snapshot.Count; $Index++) {
                if ($Latest[$Index].sha256 -ine $Snapshot[$Index].sha256) { Fail 'TARGET_DRIFT' $Latest[$Index].path }
            }
            Assert-Offline
            foreach ($Item in $Stages) {
                $FailedTarget = $Item.stage.entry.path
                Invoke-Replacement $Item.stage $Item.currentHash
            }
            $Phase = 'verify'
            $Snapshot = @(Read-TargetSnapshot)
            Assert-TargetAcls $Snapshot
            foreach ($Entry in $Entries) {
                $Desired = $Entry.beforeSha256
                if ($Mode -eq 'Apply') { $Desired = $Entry.candidateSha256 }
                Assert-Hash $Entry.targetPath $Desired 'FINAL_TARGET_DRIFT'
            }
            Assert-MaintenanceInputs
            $Result.status = 'RESTORED'
            if ($Mode -eq 'Restore') {
                $Result['fourFileResult'] = 'RESTORED_SHA256_AND_ACL_VERIFIED'
                $Result['chainValidation'] = 'PENDING'
                $Result['message'] = 'The four allowlisted files were restored and SHA256/ACL verified. Whole-chain validation is pending; production dependencies were left untouched.'
            }
            if ($Mode -eq 'Apply') {
                $Result.status = 'APPLIED'
                if ($Stages.Count -eq 0) { $Result.status = 'ALREADY_APPLIED' }
            }
        }
        $Result['targets'] = $Snapshot
        $ExitCode = 0
    }
    $FailedTarget = $null
    $Phase = 'complete'
} catch {
    $Result.error = $_.Exception.Message
    $Result['errorLine'] = $_.InvocationInfo.ScriptLineNumber
    $Result['errorStack'] = $_.ScriptStackTrace
    $Result.status = 'REFUSED'
    $Result['failurePhase'] = $Phase
    if ($Attempted.Count -gt 0) {
        try {
            $Result['targets'] = @(Restore-BaselineAfterFailure)
            $Result.status = 'FAILED_ROLLED_BACK'
        } catch {
            $Result.status = 'FAILED_RECOVERY_INCOMPLETE'
            $Result['rollbackError'] = $_.Exception.Message
        }
    }
} finally {
    foreach ($Path in $TemporaryPaths) {
        try {
            Assert-NoReparse $Path
            if (Test-Path -LiteralPath $Path) { Assert-File $Path; [IO.File]::Delete($Path) }
        } catch { $CleanupErrors.Add($Path + ': ' + $_.Exception.Message) }
    }
    if ($null -ne $LockStream) {
        try { $LockStream.Dispose() } catch { $CleanupErrors.Add($LockPath + ': ' + $_.Exception.Message) }
    }
    $Result.phase = $Phase
    $Result.failedTarget = $FailedTarget
    $Result.receiptPath = $ReceiptPath
    $Result.cleanupErrors = @($CleanupErrors.ToArray())
    if ($CleanupErrors.Count -gt 0) { $ExitCode = 1 }
    try { Write-ReceiptEvent 'finished' $Result } catch { $Result['receiptError'] = $_.Exception.Message; $ExitCode = 1 }
    if ($null -ne $ReceiptWriter) { $ReceiptWriter.Dispose() }
    if ($null -ne $ReceiptStream) { $ReceiptStream.Dispose() }
}

$Result | ConvertTo-Json -Depth 20 -Compress
exit $ExitCode
