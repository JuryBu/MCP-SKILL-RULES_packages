[CmdletBinding()]
param(
  [ValidateSet('Inspect','Install','Rollback')][string]$Action = 'Inspect',
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$ManifestSha256,
  [ValidateSet('TempFixture','ManualProduction')][string]$Mode = 'TempFixture',
  [int]$FixtureFailAfterWrites = -1,
  [switch]$VerifyOwner
)
$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8
$Sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$ProductionRoot = '__PRODUCTION_ROOT__'
$ProductionTargets = ConvertFrom-Json '__PRODUCTION_TARGETS_JSON__'
$Names = ConvertFrom-Json '__FILE_NAMES_JSON__'
$Hashes = ConvertFrom-Json '__CANDIDATE_HASHES_JSON__'
$OldHashes = ConvertFrom-Json '__ORIGINAL_HASHES_JSON__'
$ProductionTargets = @($ProductionTargets)
$Names = @($Names)
$Hashes = @($Hashes)
$OldHashes = @($OldHashes)
$ReceiptStream = $null
$Receipt = $null
$Writes = 0
$ExitCode = 0
$Result = [ordered]@{action=$Action; mode=$Mode; status='REFUSED'; targetWrites=0; serviceActions=0; error=$null}
function Plain([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':') -or $Value -match '[*?\x00]' -or @($Value -split '[\\/]' | Where-Object {$_ -eq '..' -or $_ -eq '.'}).Count) { throw 'PATH_NOT_PLAIN_ABSOLUTE' }
  $Full = [IO.Path]::GetFullPath($Value).TrimEnd('\','/')
  if ($Full.Length -le 3) { throw 'DRIVE_ROOT_FORBIDDEN' }
  $Current = $Full
  while ($Current) {
    if (Test-Path -LiteralPath $Current) {
      $Item = Get-Item -LiteralPath $Current -Force
      if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $Item.LinkType) { throw 'PATH_LINK_FORBIDDEN' }
      if (-not $Item.PSIsContainer -and @(Get-Item -LiteralPath $Current -Stream * -Force | Where-Object {$_.Stream -notin @(':$DATA','$DATA')}).Count) { throw 'PATH_ADS_FORBIDDEN' }
    }
    $Current = Split-Path -Parent $Current
  }
  return $Full
}
function OwnerExecutable([string]$Value,[string]$ExpectedSha256) {
  if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') {return (Plain $Value)}
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value.Substring(2).Contains(':') -or $Value -match '[*?\x00]' -or @($Value -split '[\\/]' | Where-Object {$_ -eq '..' -or $_ -eq '.'}).Count) {throw 'OWNER_EXECUTABLE_PATH_INVALID'}
  $Full=[IO.Path]::GetFullPath($Value).TrimEnd('\','/')
  if ([IO.Path]::GetExtension($Full) -ine '.exe') {throw 'OWNER_EXECUTABLE_PATH_INVALID'}
  $null=Plain (Split-Path -Parent $Full)
  $Item=Get-Item -LiteralPath $Full -Force
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($Item.LinkType -and $Item.LinkType -ine 'HardLink')) {throw 'PATH_LINK_FORBIDDEN'}
  if (@(Get-Item -LiteralPath $Full -Stream * -Force | Where-Object {$_.Stream -notin @(':$DATA','$DATA')}).Count) {throw 'PATH_ADS_FORBIDDEN'}
  if ((Get-FileHash -LiteralPath $Full -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) {throw 'OWNER_POWERSHELL_IDENTITY_CHANGED'}
  return $Full
}
function Sha([string]$Path) { return (Get-FileHash -LiteralPath (Plain $Path) -Algorithm SHA256).Hash.ToLowerInvariant() }
function Json([string]$Path) {
  $Path = Plain $Path
  if ((Get-Item -LiteralPath $Path).Length -gt 1048576) { throw 'JSON_TOO_LARGE' }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Sddl([string]$Path) { return (Get-Acl -LiteralPath (Plain $Path)).GetSecurityDescriptorSddlForm($Sections) }
function Snapshot([string]$Path) {
  $Path = Plain $Path
  if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{exists=$false; sha256=$null; sddl=$null; attributes=$null} }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'REGULAR_FILE_REQUIRED' }
  return [pscustomobject]@{exists=$true; sha256=(Sha $Path); sddl=(Sddl $Path); attributes=[int][IO.File]::GetAttributes($Path)}
}
function AssertState($Expected,[string]$Path) {
  $Observed = Snapshot $Path
  if ($Expected.exists -ne $Observed.exists -or $Expected.sha256 -cne $Observed.sha256 -or $Expected.sddl -cne $Observed.sddl -or $Expected.attributes -ne $Observed.attributes) { throw ('TARGET_SHA_ACL_ATTRIBUTES_DRIFT:'+$Path) }
}
function NativeSecurity([string]$Path,[string]$Saved) {
  if (-not ('TwoFiles.NativeSecurity' -as [type])) {
    $Assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('TwoFiles.NativeSecurity'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $Builder = $Assembly.DefineDynamicModule('NativeSecurity').DefineType('TwoFiles.NativeSecurity',[Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Abstract -bor [Reflection.TypeAttributes]::Sealed)
    $Attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
    $Setter = $Builder.DefinePInvokeMethod('Set','advapi32.dll','SetNamedSecurityInfoW',$Attributes,[Reflection.CallingConventions]::Standard,[uint32],[type[]]@([string],[int],[uint32],[byte[]],[byte[]],[byte[]],[IntPtr]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    $RawSetter = $Builder.DefinePInvokeMethod('SetRaw','advapi32.dll','SetFileSecurityW',$Attributes,[Reflection.CallingConventions]::Standard,[bool],[type[]]@([string],[uint32],[byte[]]),[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
    foreach ($Method in @($Setter,$RawSetter)) { $Method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig) }
    [void]$Builder.CreateType()
  }
  $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Saved)
  if (-not $Descriptor.Owner -or -not $Descriptor.Group -or $null -eq $Descriptor.DiscretionaryAcl -or $Descriptor.SystemAcl) { throw 'OWNER_GROUP_DACL_REQUIRED' }
  [uint32]$Information = 7
  $Information = $Information -bor $(if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0) {[uint32]2147483648} else {[uint32]536870912})
  if (($Descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited) -ne 0) {
    $OwnerBytes = [byte[]]::new($Descriptor.Owner.BinaryLength); $GroupBytes = [byte[]]::new($Descriptor.Group.BinaryLength); $DaclBytes = [byte[]]::new($Descriptor.DiscretionaryAcl.BinaryLength)
    $Descriptor.Owner.GetBinaryForm($OwnerBytes,0); $Descriptor.Group.GetBinaryForm($GroupBytes,0); $Descriptor.DiscretionaryAcl.GetBinaryForm($DaclBytes,0)
    if ([TwoFiles.NativeSecurity]::Set($Path,1,$Information,$OwnerBytes,$GroupBytes,$DaclBytes,[IntPtr]::Zero) -ne 0) { throw 'ACL_RESTORE_FAILED' }
  } else {
    $Bytes = [byte[]]::new($Descriptor.BinaryLength); $Descriptor.GetBinaryForm($Bytes,0)
    if (-not [TwoFiles.NativeSecurity]::SetRaw($Path,$Information,$Bytes)) { throw 'ACL_RESTORE_FAILED' }
  }
  if ((Sddl $Path) -cne $Saved) { throw 'ACL_RESTORE_MISMATCH' }
}
function AssertIndependentTerminal {
  $ExpectedShell=if ($Manifest.ownerPowerShell) {$Manifest.ownerPowerShell} else {[pscustomobject]@{path=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');major=5;edition='Desktop';sha256=$null}}
  $Supported=($ExpectedShell.major -eq 5 -and $ExpectedShell.edition -ceq 'Desktop') -or ($ExpectedShell.major -eq 7 -and $ExpectedShell.edition -ceq 'Core' -and $ExpectedShell.sha256 -cmatch '^[a-f0-9]{64}$')
  if (-not $Supported -or $PSVersionTable.PSVersion.Major -ne $ExpectedShell.major -or $PSVersionTable.PSEdition -cne $ExpectedShell.edition -or (Get-ExecutionPolicy -Scope Process) -ne 'Undefined' -or (Get-ExecutionPolicy) -cnotin @('RemoteSigned','AllSigned','Unrestricted')) { throw 'ORDINARY_WINDOWS_POWERSHELL_REQUIRED' }
  $Self=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID))
  $ExpectedExecutable=OwnerExecutable ([string]$ExpectedShell.path) ([string]$ExpectedShell.sha256)
  if ($Self.Count -ne 1 -or [string]$Self[0].ExecutablePath -ine $ExpectedExecutable) { throw 'OWNER_POWERSHELL_IDENTITY_CHANGED' }
  $ProcessId = $PID; $Seen = @{}; $ChildCreated = $null; $Session = $null
  for ($Depth=0; $Depth -lt 32 -and $ProcessId; $Depth++) {
    if ($Seen.ContainsKey([string]$ProcessId)) { throw 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Seen[[string]$ProcessId]=$true
    $Matches=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$ProcessId))
    if ($Matches.Count -ne 1) { throw 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Observed=$Matches[0]
    if (-not $Observed.ExecutablePath -or -not $Observed.CommandLine -or -not $Observed.CreationDate -or $null -eq $Observed.SessionId -or [string]$Observed.CommandLine -match 'app-server|mcp-http-broker|sandbox-data|codex-command-runner|codex-windows-sandbox|WindowsJobRunner' -or [string]$Observed.Name -match '^(ChatGPT|codex|WindowsJobRunner)\.exe$') { throw 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    $Created=([DateTime]$Observed.CreationDate).ToUniversalTime()
    if ($ChildCreated -and $Created -gt $ChildCreated) { throw 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ($null -eq $Session) { $Session=[int]$Observed.SessionId }
    if ([int]$Observed.SessionId -ne $Session) { throw 'INDEPENDENT_OWNER_TERMINAL_REQUIRED' }
    if ([string]$Observed.Name -ieq 'explorer.exe' -and [string]$Observed.ExecutablePath -ieq (Join-Path $env:SystemRoot 'explorer.exe')) { return }
    $ChildCreated=$Created; $ProcessId=[int]$Observed.ParentProcessId
  }
  throw 'INDEPENDENT_OWNER_TERMINAL_REQUIRED'
}
function SaveReceipt {
  $Bytes=$Utf8.GetBytes(($Receipt | ConvertTo-Json -Depth 12))
  $ReceiptStream.Position=0; $ReceiptStream.Write($Bytes,0,$Bytes.Length); $ReceiptStream.SetLength($Bytes.Length); $ReceiptStream.Flush($true)
}
function AssertFiles {
  foreach ($Index in 0..($Names.Count-1)) {
    $Entry=$Manifest.files[$Index]
    if ($Entry.name -cne $Names[$Index] -or $Entry.candidateSha256 -cne $Hashes[$Index]) { throw 'EXACT_FILES_REQUIRED' }
    if ($Mode -eq 'ManualProduction' -and ($Entry.original.sha256 -cne $OldHashes[$Index])) { throw 'EXACT_PRODUCTION_ORIGINAL_REQUIRED' }
    $Target=Plain ([string]$ProductionTargets[$Index])
    if (-not $Entry.installed.exists -or $Entry.installed.sha256 -cne $Entry.candidateSha256) { throw 'INSTALLED_STATE_CHANGED' }
    $Expected=if ($Receipt.progress[$Index] -eq 'INSTALLED') { $Entry.installed } else {$Entry.original}
    AssertState $Expected $Target
    if ($Action -eq 'Install' -and (Sha (Join-Path $PackageRoot ('candidate/'+$Index+'.bin'))) -cne $Entry.candidateSha256) { throw 'CANDIDATE_CHANGED' }
    if ($Entry.original.exists -and (Sha (Join-Path $PackageRoot ('original/'+$Index+'.bin'))) -cne $Entry.original.sha256) { throw 'SAVED_ORIGINAL_CHANGED' }
  }
}
try {
  $ManifestPath=Plain $ManifestPath; $PackageRoot=Plain (Split-Path -Parent $ManifestPath)
  if ($ManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Sha $ManifestPath) -cne $ManifestSha256) { throw 'MANIFEST_CHANGED' }
  $Manifest=Json $ManifestPath
  if ($Manifest.schemaVersion -ne 1 -or $Manifest.mode -cne $Mode -or @($Manifest.files).Count -ne $Names.Count -or $Manifest.entrySha256 -cne (Sha $PSCommandPath)) { throw 'ENTRY_OR_MANIFEST_CHANGED' }
  $TargetRoot=Plain $Manifest.targetRoot
  if ($TargetRoot -ine $ProductionRoot) {throw 'ENTRY_TARGET_ROOT_CHANGED'}
  if ($Mode -eq 'TempFixture') {
    $FixtureRoot=Plain $Manifest.fixtureRoot
    $Temp=[IO.Path]::GetTempPath().TrimEnd('\','/')
    if (-not $FixtureRoot.StartsWith($Temp+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $TargetRoot.StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or -not $PackageRoot.StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'TEMP_FIXTURE_ESCAPE' }
    foreach ($TargetPath in $ProductionTargets) {
      if (-not (Plain ([string]$TargetPath)).StartsWith($FixtureRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {throw 'TEMP_TARGET_ESCAPE'}
    }
    $Marker=Json (Join-Path $FixtureRoot 'owner.json')
    if ($Marker.ownerId -cne 'startup-repair-20261012' -or (Plain ([string]$Marker.fixtureRoot)) -ine $FixtureRoot) { throw 'TEMP_OWNER_CONFLICT' }
  } else {
    if ($TargetRoot -ine $ProductionRoot -or $FixtureFailAfterWrites -ge 0) { throw 'PRODUCTION_BINDING_REQUIRED' }
    if ($Action -ne 'Inspect' -or $VerifyOwner) { AssertIndependentTerminal }
  }
  $ReceiptPath=Join-Path $PackageRoot 'receipt.json'
  if ($Action -eq 'Inspect') { $Receipt=Json $ReceiptPath } else {
    $ReceiptStream=[IO.File]::Open($ReceiptPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $Reader=[IO.StreamReader]::new($ReceiptStream,$Utf8,$true,4096,$true)
    try { $Receipt=$Reader.ReadToEnd() | ConvertFrom-Json } finally {$Reader.Dispose()}
  }
  if ($Receipt.manifestSha256 -cne $ManifestSha256 -or @($Receipt.progress).Count -ne $Names.Count -or $Receipt.status -cnotin @('PREPARED','INSTALLING','PARTIAL_INSTALL','INSTALLED','ROLLING_BACK','PARTIAL_ROLLBACK','ROLLED_BACK','UNKNOWN') -or @($Receipt.progress | Where-Object {$_ -cnotin @('ORIGINAL','INSTALLED','RESTORED')}).Count) { throw 'RECEIPT_CHANGED' }
  if ($Receipt.intent -or $Receipt.status -ceq 'UNKNOWN') { throw 'UNKNOWN_PRESERVED_NO_REPLAY' }
  AssertFiles
  if ($Action -eq 'Inspect') { $Result.status=$Receipt.status } else {
    if ($Action -eq 'Install' -and $Receipt.status -cin @('ROLLED_BACK','ROLLING_BACK','PARTIAL_ROLLBACK')) { throw 'INSTALL_CONSUMED' }
    $Receipt.status=if ($Action -eq 'Install') {'INSTALLING'} else {'ROLLING_BACK'}; SaveReceipt
    foreach ($Index in 0..($Names.Count-1)) {
      if (($Action -eq 'Install' -and $Receipt.progress[$Index] -ceq 'INSTALLED') -or ($Action -eq 'Rollback' -and $Receipt.progress[$Index] -cne 'INSTALLED')) { continue }
      if ($FixtureFailAfterWrites -ge 0 -and $Writes -ge $FixtureFailAfterWrites) { throw 'FIXTURE_FAILURE_BETWEEN_WRITES' }
      AssertFiles
      $Entry=$Manifest.files[$Index]; $Target=Plain ([string]$ProductionTargets[$Index])
      $Desired=if ($Action -eq 'Install') {$Entry.installed} else {$Entry.original}
      $Stage=$null
      if ($Desired.exists) {
        $Source=Join-Path $PackageRoot ($(if ($Action -eq 'Install') {'candidate/'} else {'original/'})+$Index+'.bin')
        $Stage=Plain (Join-Path (Split-Path -Parent $Target) ([Guid]::NewGuid().ToString('N')+'.stage'))
        [IO.File]::Copy($Source,$Stage,$false)
        if ((Sha $Stage) -cne $Desired.sha256) { throw 'STAGE_CHANGED' }
      }
      $Receipt.intent=[pscustomobject]@{index=$Index;action=$Action;target=$Target;stage=$Stage}; SaveReceipt
      if ($Desired.exists) {
        [IO.File]::SetAttributes($Stage,[IO.FileAttributes]::Normal)
        if (Test-Path -LiteralPath $Target) { [IO.File]::SetAttributes($Target,[IO.FileAttributes]::Normal); [IO.File]::Replace($Stage,$Target,[NullString]::Value) } else {[IO.File]::Move($Stage,$Target)}
        $Writes++; NativeSecurity $Target $Desired.sddl; [IO.File]::SetAttributes($Target,[IO.FileAttributes]$Desired.attributes)
      } else { [IO.File]::SetAttributes($Target,[IO.FileAttributes]::Normal); [IO.File]::Delete($Target); $Writes++ }
      AssertState $Desired $Target
      $Receipt.progress[$Index]=if ($Action -eq 'Install') {'INSTALLED'} else {'RESTORED'}
      $Receipt.intent=$null; SaveReceipt
    }
    $Receipt.status=if ($Action -eq 'Install') {'INSTALLED'} else {'ROLLED_BACK'}; SaveReceipt
    $Result.status=$Receipt.status
  }
} catch {
  $ExitCode=1; $Result.error=$_.Exception.Message
  if ($ReceiptStream -and $Receipt -and $Receipt.status -cin @('INSTALLING','ROLLING_BACK')) {
    $Receipt.status=if ($Receipt.intent) {'UNKNOWN'} elseif ($Action -eq 'Install') {'PARTIAL_INSTALL'} else {'PARTIAL_ROLLBACK'}
    try { SaveReceipt } catch { $Result['receiptError']=$_.Exception.Message }
    $Result.status=$Receipt.status
  }
} finally {
  if ($ReceiptStream) {$ReceiptStream.Dispose()}
  $Result.targetWrites=$Writes
  $Result | ConvertTo-Json -Depth 12 -Compress
}
exit $ExitCode
