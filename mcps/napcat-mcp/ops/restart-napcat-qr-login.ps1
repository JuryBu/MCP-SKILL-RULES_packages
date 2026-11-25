[CmdletBinding()]
param(
  [ValidateSet('Inspect','Start','Worker')][string]$Mode = 'Inspect',
  [string]$ConfigPath,
  [string]$RequestId,
  [string]$RequestSha256,
  [ValidateRange(0,15)][int]$WaitSeconds = 8,
  [string]$SupersedeRequestId
)

function ConvertTo-NapCatQrPath {
  param([string]$Path)
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2) -match '["<>|?*:\x00-\x1f%!]' ) { throw 'invalid_path' }
  $FullPath = [IO.Path]::GetFullPath($Path)
  if ($FullPath.Length -gt 3) { return $FullPath.TrimEnd([char[]]'\/') }
  return $FullPath
}

function Initialize-NapCatQrNative {
  if ('NapCatQrNative' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class NapCatQrNative {
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint id);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, System.Text.StringBuilder name, int bytes, out int needed);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformation(IntPtr server, int session, int kind, out IntPtr buffer, out uint bytes);
    [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr buffer);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicJobLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedJobLimits {
        public BasicJobLimits Basic;
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        out ExtendedJobLimits limits, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool K32EnumProcesses([Out] int[] processes, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    public static string CurrentJobState(IntPtr process) {
        bool inJob;
        if (!IsProcessInJob(process, IntPtr.Zero, out inJob)) return "worker_job_lifecycle_unverified";
        if (!inJob) return "independent_sta_worker_ready";
        const int JobObjectExtendedLimitInformation = 9;
        const uint JobObjectLimitKillOnJobClose = 0x2000;
        ExtendedJobLimits limits;
        uint returned;
        uint size = (uint)Marshal.SizeOf(typeof(ExtendedJobLimits));
        if (QueryInformationJobObject(IntPtr.Zero, JobObjectExtendedLimitInformation, out limits, size, out returned) &&
            returned == size && (limits.Basic.LimitFlags & JobObjectLimitKillOnJobClose) != 0) {
            return "worker_job_kill_on_close";
        }
        return "worker_job_lifecycle_unverified";
    }
    private static bool ProcessIdAbsent(int processId) {
        for (int capacity = 1024; capacity <= 32768; capacity *= 2) {
            int[] processes = new int[capacity];
            uint length = (uint)(capacity * sizeof(int));
            uint returned;
            if (!K32EnumProcesses(processes, length, out returned) || returned == 0 ||
                returned > length || returned % sizeof(int) != 0) return false;
            if (returned == length) continue;
            return Array.IndexOf(processes, processId, 0, (int)(returned / sizeof(int))) < 0;
        }
        return false;
    }
    public static bool WorkerHasExited(int processId, long expectedBirth) {
        if (processId < 2 || expectedBirth <= 0) return false;
        const uint ProcessQueryLimitedInformation = 0x1000;
        const uint Synchronize = 0x00100000;
        const int ErrorInvalidParameter = 87;
        IntPtr query = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (query == IntPtr.Zero) return Marshal.GetLastWin32Error() == ErrorInvalidParameter && ProcessIdAbsent(processId);
        try {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(query, out creation, out exit, out kernel, out user) || creation <= 0) return false;
            if (creation != expectedBirth) return true;
            IntPtr wait = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, processId);
            if (wait == IntPtr.Zero) return false;
            try {
                return GetProcessTimes(wait, out creation, out exit, out kernel, out user) &&
                    creation == expectedBirth && WaitForSingleObject(wait, 0) == 0;
            } finally { CloseHandle(wait); }
        } finally { CloseHandle(query); }
    }
    public static bool IsActiveSession(int session) {
        IntPtr buffer;
        uint bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out buffer, out bytes)) return false;
        try { return buffer != IntPtr.Zero && bytes >= 4 && Marshal.ReadInt32(buffer) == 0; }
        finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
    }
    public static bool IsOnInputDesktop() {
        IntPtr input = OpenInputDesktop(0, false, 1);
        if (input == IntPtr.Zero) return false;
        try {
            var active = new System.Text.StringBuilder(128);
            var current = new System.Text.StringBuilder(128);
            int needed;
            return GetUserObjectInformation(input, 2, active, active.Capacity * 2, out needed) &&
                GetUserObjectInformation(GetThreadDesktop(GetCurrentThreadId()), 2, current, current.Capacity * 2, out needed) &&
                String.Equals(active.ToString(), "Default", StringComparison.OrdinalIgnoreCase) &&
                String.Equals(active.ToString(), current.ToString(), StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(input); }
    }
    public static bool OwnsMutex(Mutex mutex) {
        try {
            if (!mutex.WaitOne(0)) return false;
            mutex.ReleaseMutex();
        } catch (AbandonedMutexException) { mutex.ReleaseMutex(); return false; }
        bool acquired = true;
        var probe = new Thread(() => {
            try { acquired = mutex.WaitOne(0); if (acquired) mutex.ReleaseMutex(); }
            catch (AbandonedMutexException) { mutex.ReleaseMutex(); acquired = true; }
            catch { acquired = true; }
        });
        probe.IsBackground = true;
        probe.Start();
        return probe.Join(1000) && !acquired;
    }
}
'@
}

function Test-NapCatQrInt {
  param($Value)
  return (($Value -is [int]) -or ($Value -is [long] -and $Value -ge [int]::MinValue -and $Value -le [int]::MaxValue))
}

function Get-NapCatQrPowerShellExecutable {
  param([string]$Edition = $PSVersionTable.PSEdition)
  if ($Edition -ceq 'Core') { return (Join-Path $PSHOME 'pwsh.exe') }
  return (Join-Path $PSHOME 'powershell.exe')
}

function Initialize-NapCatQrPowerShell {
  $SupportedEdition = ($PSVersionTable.PSEdition -ceq 'Desktop' -and $PSVersionTable.PSVersion.Major -eq 5) -or
    ($PSVersionTable.PSEdition -ceq 'Core' -and $PSVersionTable.PSVersion.Major -ge 7)
  if (-not $SupportedEdition -or ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess)) {
    throw 'windows_powershell_required'
  }
  if ($PSVersionTable.PSEdition -ceq 'Core') {
    $env:PSModulePath = "$PSHOME\Modules;$(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules')"
  } else {
    $env:PSModulePath = "$PSHOME\Modules"
  }
  [Environment]::SetEnvironmentVariable('PSExecutionPolicyPreference', [NullString]::Value, 'Process')
}

function Get-NapCatQrDesktopIdentity {
  $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { $Sid = $Identity.User.Value } finally { $Identity.Dispose() }
  $Current = [Diagnostics.Process]::GetCurrentProcess()
  try {
    if (-not [Environment]::UserInteractive -or $Current.SessionId -lt 1) { throw 'no_interactive_desktop' }
    $Session = $Current.SessionId
    $Birth = $Current.StartTime.ToFileTimeUtc()
  } finally { $Current.Dispose() }
  Initialize-NapCatQrNative
  if (-not [NapCatQrNative]::IsActiveSession($Session) -or -not [NapCatQrNative]::IsOnInputDesktop()) {
    throw 'no_interactive_desktop'
  }
  $ShellWindow = [NapCatQrNative]::GetShellWindow()
  [uint32]$ExplorerId = 0
  if ($ShellWindow -eq [IntPtr]::Zero -or [NapCatQrNative]::GetWindowThreadProcessId($ShellWindow,[ref]$ExplorerId) -eq 0) {
    throw 'no_interactive_desktop'
  }
  $Explorer = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ExplorerId" -ErrorAction Stop
  $Windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  if ($null -eq $Explorer -or $Explorer.SessionId -ne $Session -or
      $Explorer.ExecutablePath -ine (Join-Path $Windows 'explorer.exe')) { throw 'explorer_identity_unverified' }
  $Owner = Invoke-CimMethod -InputObject $Explorer -MethodName GetOwnerSid -ErrorAction Stop
  if ($Owner.ReturnValue -ne 0 -or $Owner.Sid -cne $Sid) { throw 'explorer_identity_unverified' }
  return [pscustomobject]@{ sid=$Sid; sessionId=$Session; explorerId=[int]$ExplorerId; pid=$PID; birth=$Birth }
}

function Get-NapCatQrWorkerIdentity {
  param([int]$ProcessId)
  $Process = [Diagnostics.Process]::GetProcessById($ProcessId)
  try {
    if ($Process.HasExited -or $Process.MainModule.FileName -ine (Get-NapCatQrPowerShellExecutable)) { throw 'worker_identity_unverified' }
    $Worker = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if ($null -eq $Worker -or $Process.HasExited -or $Worker.SessionId -ne $Process.SessionId) { throw 'worker_identity_unverified' }
    return [pscustomobject]@{ pid=$Process.Id; birth=$Process.StartTime.ToFileTimeUtc(); sessionId=$Process.SessionId; parentPid=[int]$Worker.ParentProcessId }
  } finally { $Process.Dispose() }
}

function Get-NapCatQrWorkerLaunchState {
  if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { return 'independent_sta_worker_unverified' }
  Initialize-NapCatQrNative
  $Process = [Diagnostics.Process]::GetCurrentProcess()
  try {
    if ($Process.MainModule.FileName -ine (Get-NapCatQrPowerShellExecutable)) { return 'worker_identity_unverified' }
    return [NapCatQrNative]::CurrentJobState($Process.Handle)
  } finally { $Process.Dispose() }
}

function Assert-NapCatQrIndependentWorker {
  $LaunchState = Get-NapCatQrWorkerLaunchState
  if ($LaunchState -cne 'independent_sta_worker_ready') { throw $LaunchState }
}

function Read-NapCatQrFile {
  param([string]$Path, [int]$MaxBytes=16384)
  if (([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'untrusted_file' }
  $Stream = [IO.File]::Open($Path,'Open','Read','Read')
  try {
    if ($Stream.Length -lt 1 -or $Stream.Length -gt $MaxBytes) { throw 'invalid_file_size' }
    $Bytes = [byte[]]::new([int]$Stream.Length)
    $Offset = 0
    while ($Offset -lt $Bytes.Length) {
      $Count = $Stream.Read($Bytes,$Offset,$Bytes.Length-$Offset)
      if ($Count -le 0) { throw 'incomplete_file' }
      $Offset += $Count
    }
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { $Hash = [BitConverter]::ToString($Hasher.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() }
    finally { $Hasher.Dispose() }
    return [pscustomobject]@{ sha=$Hash; bytes=$Bytes }
  } finally { $Stream.Dispose() }
}

function ConvertFrom-NapCatQrFile {
  param($File)
  return ([Text.UTF8Encoding]::new($false,$true).GetString($File.bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop)
}

function Get-NapCatQrConfig {
  param([string]$Path, $Desktop, [string]$Capability)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'interactive_config_required' }
  $Path = ConvertTo-NapCatQrPath $Path
  $File = Read-NapCatQrFile $Path
  $Config = ConvertFrom-NapCatQrFile $File
  $Roles = if ($Capability -ceq 'manualQrEnabled') { @('development','training') } else { @('development') }
  if ($Config -isnot [pscustomobject] -or -not (Test-NapCatQrInt $Config.schemaVersion) -or $Config.schemaVersion -ne 1 -or
      $Config.machineRole -cnotin $Roles -or $Config.computerName -ine [Environment]::MachineName -or
      $Config.userSid -cne $Desktop.sid -or $Config.$Capability -isnot [bool] -or -not $Config.$Capability) {
    throw 'interactive_config_not_approved'
  }
  $BindingPath = [IO.Path]::Combine((ConvertTo-NapCatQrPath $Config.dataRoot),'binding.json')
  $Binding = Read-NapCatQrFile $BindingPath 65536
  if ((ConvertFrom-NapCatQrFile $Binding).controlPlane.localMachine -cne $Config.machineRole) {
    throw 'interactive_binding_role_unverified'
  }
  return [pscustomobject]@{ path=$Path; sha=$File.sha; value=$Config; bindingSha=$Binding.sha }
}

function Get-NapCatQrRequestDirectory {
  param([string]$Id, [string]$Base = ([IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'Temp')))
  if ($Id -cnotmatch '^[0-9a-f]{32}$') { throw 'invalid_request_id' }
  return [IO.Path]::Combine($Base,"napcat-manual-qr-$Id")
}

function New-NapCatQrRequestDirectory {
  param([string]$Directory,[string]$OwnerSid)
  if ([IO.Directory]::Exists($Directory) -or [IO.File]::Exists($Directory)) { throw 'request_collision' }
  $Security = [Security.AccessControl.DirectorySecurity]::new()
  $Security.SetAccessRuleProtection($true,$false)
  $Owner = [Security.Principal.SecurityIdentifier]::new($OwnerSid)
  $Security.SetOwner($Owner)
  foreach ($Sid in @($Owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $Security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($Sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
  }
  if ('System.IO.FileSystemAclExtensions' -as [type]) {
    [void][IO.FileSystemAclExtensions]::CreateDirectory($Security, $Directory)
  } else {
    [void][IO.Directory]::CreateDirectory($Directory, $Security)
  }
  Assert-NapCatQrRequestDirectory $Directory $OwnerSid
}

function Assert-NapCatQrRequestDirectory {
  param([string]$Directory,[string]$OwnerSid)
  if (([IO.File]::GetAttributes($Directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'request_directory_unverified' }
  $Access = if ('System.IO.FileSystemAclExtensions' -as [type]) {
    [IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($Directory))
  } else {
    [IO.Directory]::GetAccessControl($Directory)
  }
  if (-not $Access.AreAccessRulesProtected -or $Access.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $OwnerSid) {
    throw 'request_directory_unverified'
  }
  foreach ($Rule in $Access.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($Rule.IdentityReference.Value -cnotin @($OwnerSid,'S-1-5-18')) { throw 'request_directory_unverified' }
  }
}

function Write-NapCatQrRecord {
  param([string]$Directory,[string]$Name,$Value,[switch]$Claim,[switch]$Replace)
  $Target = [IO.Path]::Combine($Directory,"$Name.json")
  $Destination = if ($Claim) { $Target } else { [IO.Path]::Combine($Directory,([Guid]::NewGuid().ToString('N') + '.tmp')) }
  $OwnTemp = $false
  try {
    $Stream = [IO.File]::Open($Destination,'CreateNew','Write','None')
    $OwnTemp = -not $Claim
    try {
      $Bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 6 -Compress))
      $Stream.Write($Bytes,0,$Bytes.Length)
      $Stream.Flush($true)
    } finally { $Stream.Dispose() }
    if (-not $Claim) {
      if ($Replace) {
        foreach ($DelayMs in @(0,25,50,100,200)) {
          if ($DelayMs) { Start-Sleep -Milliseconds $DelayMs }
          try { [IO.File]::Replace($Destination,$Target,[NullString]::Value); break }
          catch [IO.IOException] {
            if ($DelayMs -eq 200 -or ($_.Exception.GetBaseException().HResult -band 65535) -notin @(32,33)) { throw }
          }
        }
      }
      else { [IO.File]::Move($Destination,$Target) }
      $OwnTemp = $false
    }
  } finally { if ($OwnTemp) { try { [IO.File]::Delete($Destination) } catch {} } }
}

function ConvertTo-NapCatQrOptionalExePath {
  param($Value)
  if ($null -eq $Value -or ($Value -is [string] -and [string]::IsNullOrWhiteSpace($Value))) { return '' }
  if ($Value -isnot [string]) { throw 'target_identity_unverified' }
  return ConvertTo-NapCatQrPath $Value
}

function Get-NapCatQrTargetPaths {
  param($Config,[string]$LegacyPath)
  $Paths = @{}
  foreach ($Name in @('dataRoot','accountStateDir','napCatRoot','brokerRoot','qqUserDataDir')) {
    $Paths[$Name] = ConvertTo-NapCatQrPath $Config.$Name
  }
  $Paths.qqExePath = ConvertTo-NapCatQrOptionalExePath $Config.qqExePath
  $Paths.loginScriptPath = $LegacyPath
  $Paths.bindingPath = [IO.Path]::Combine($Paths.dataRoot,'binding.json')
  $Paths.privateEnvPath = [IO.Path]::Combine($Paths.brokerRoot,'broker-private.env.json')
  $Paths.maintenancePath = [IO.Path]::Combine($Paths.dataRoot,'state','task-router.maintenance.json')
  if ([string]$Config.expectedAccount -cnotmatch '^[1-9][0-9]{4,31}$' -or $Config.loginSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      (Read-NapCatQrFile $LegacyPath 524288).sha -cne $Config.loginSha256) { throw 'target_identity_unverified' }
  return $Paths
}

function Get-NapCatQrRequest {
  param([string]$Directory,[string]$Id,[string]$Hash,$Desktop,[switch]$Historical)
  Assert-NapCatQrRequestDirectory $Directory $Desktop.sid
  $File = Read-NapCatQrFile ([IO.Path]::Combine($Directory,'request.json'))
  if ($Hash -and $File.sha -cne $Hash) { throw 'request_fingerprint_changed' }
  $Request = ConvertFrom-NapCatQrFile $File
  if ($Request -isnot [pscustomobject] -or $Request.schema -cne 'napcat.manual-qr/v1' -or
      $Request.id -isnot [string] -or $Request.id -cne $Id -or
      $Request.sid -isnot [string] -or $Request.sid -cne $Desktop.sid -or
      -not (Test-NapCatQrInt $Request.sessionId) -or $Request.sessionId -lt 1 -or
      -not (Test-NapCatQrInt $Request.explorerId) -or $Request.explorerId -lt 2 -or
      (-not $Historical -and ($Request.sessionId -ne $Desktop.sessionId -or $Request.explorerId -ne $Desktop.explorerId)) -or
      $Request.deadlineAt -isnot [long] -or $Request.createdAt -isnot [long] -or
      $Request.createdAt -lt 0 -or $Request.createdAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -or
      $Request.deadlineAt - $Request.createdAt -ne 45000 -or -not (Test-NapCatQrInt $Request.requesterPid) -or $Request.requesterPid -lt 2 -or
      $Request.requesterBirth -isnot [long] -or $Request.requesterBirth -le 0 -or
      ($null -ne $Request.deploymentSha -and $Request.deploymentSha -cnotmatch '^[0-9a-f]{64}$') -or
      ($null -ne $Request.supersedesRequestId -and ($Request.supersedesRequestId -cnotmatch '^[0-9a-f]{32}$' -or
        $Request.supersedesRequestId -ceq $Id))) { throw 'request_identity_unverified' }
  $Offline = $Request.supersededOffline
  if ($null -ne $Offline -and (-not $Request.supersedesRequestId -or $Offline -isnot [pscustomobject] -or
      -not (Test-NapCatQrInt $Offline.owner) -or $Offline.owner -lt 2 -or $Offline.processSha -cnotmatch '^[0-9a-f]{64}$' -or
      $Offline.deploymentSha -cnotmatch '^[0-9a-f]{64}:[0-9a-f]{64}$' -or $Offline.targetSha -cnotmatch '^[0-9a-f]{64}$')) {
    throw 'request_identity_unverified'
  }
  return [pscustomobject]@{ sha=$File.sha; value=$Request }
}

function Test-NapCatQrRecordPresent {
  param([string]$Path)
  try { $null = [IO.File]::GetAttributes($Path); return $true }
  catch [IO.FileNotFoundException] { return $false }
}

function Read-NapCatQrBoundRecord {
  param([string]$Directory,[string]$Name,$Request,[switch]$WithFingerprint)
  $Path = [IO.Path]::Combine($Directory,"$Name.json")
  if (-not (Test-NapCatQrRecordPresent $Path)) { return $null }
  $File = Read-NapCatQrFile $Path
  $Record = ConvertFrom-NapCatQrFile $File
  if ($Record -isnot [pscustomobject] -or $Record.id -isnot [string] -or $Record.id -cne $Request.value.id -or
      $Record.requestSha256 -isnot [string] -or $Record.requestSha256 -cne $Request.sha) { throw 'receipt_identity_unverified' }
  if ($WithFingerprint) { return @{ value=$Record; sha=$File.sha } }
  return $Record
}

function Get-NapCatQrBoundDispatch {
  param([string]$Directory,$Request)
  if ($null -eq (Read-NapCatQrBoundRecord $Directory 'submitted' $Request)) { return $null }
  $Dispatch = Read-NapCatQrBoundRecord $Directory 'dispatch' $Request
  if ($null -eq $Dispatch) { return $null }
  $Value = $Request.value
  if (-not (Test-NapCatQrInt $Dispatch.workerPid) -or $Dispatch.workerPid -lt 2 -or $Dispatch.workerPid -eq $Value.requesterPid -or
      $Dispatch.workerBirth -isnot [long] -or -not (Test-NapCatQrInt $Dispatch.parentPid) -or $Dispatch.parentPid -ne $Value.requesterPid -or
      $Dispatch.workerBirth -le $Value.requesterBirth -or
      $Dispatch.workerBirth -lt ([DateTimeOffset]::FromUnixTimeMilliseconds($Value.createdAt).UtcDateTime.ToFileTimeUtc()) -or
      $Dispatch.workerBirth -ge ([DateTimeOffset]::FromUnixTimeMilliseconds($Value.deadlineAt).UtcDateTime.ToFileTimeUtc())) {
    throw 'receipt_identity_unverified'
  }
  return $Dispatch
}

function Test-NapCatQrWorkerReceipt {
  param($Record,$Dispatch,[int]$ThreadId)
  return ((Test-NapCatQrInt $Record.workerPid) -and $Record.workerPid -eq $Dispatch.workerPid -and
    $Record.workerBirth -is [long] -and $Record.workerBirth -eq $Dispatch.workerBirth -and
    (Test-NapCatQrInt $Record.parentPid) -and $Record.parentPid -eq $Dispatch.parentPid -and
    (Test-NapCatQrInt $Record.threadId) -and $Record.threadId -gt 0 -and ($ThreadId -eq 0 -or $Record.threadId -eq $ThreadId))
}

function Get-NapCatQrOutcome {
  param([string]$Directory,$Request,[switch]$IncludeTerminalBinding)
  $Output = [ordered]@{ status='submission_unknown_do_not_retry'; requestId=$Request.value.id }
  try {
    $Dispatch = Get-NapCatQrBoundDispatch $Directory $Request
    if ($null -eq $Dispatch) { return $Output }
    $Output.workerPid = $Dispatch.workerPid
    $Output.workerBirth = [string]$Dispatch.workerBirth
    $Claim = Read-NapCatQrBoundRecord $Directory 'claim' $Request
    if (-not (Test-NapCatQrWorkerReceipt $Claim $Dispatch)) { return $Output }
    $AdmissionReceipt = Read-NapCatQrBoundRecord $Directory 'accepted' $Request -WithFingerprint
    $Accepted = $AdmissionReceipt.value
    if ($null -ne $Accepted -and (-not (Test-NapCatQrWorkerReceipt $Accepted $Dispatch $Claim.threadId) -or
        $Accepted.proof -isnot [string] -or $Accepted.proof -cne 'same-worker-guard-admitted' -or
        $Accepted.deploymentSha -isnot [string] -or $Accepted.deploymentSha -cnotmatch '^[0-9a-f]{64}:[0-9a-f]{64}$' -or
        $Accepted.targetSha -isnot [string] -or $Accepted.targetSha -cnotmatch '^[0-9a-f]{64}$' -or
        $Request.value.bindingSha -isnot [string] -or $Request.value.bindingSha -cnotmatch '^[0-9a-f]{64}$' -or
        -not $Accepted.deploymentSha.EndsWith(':' + $Request.value.bindingSha,[StringComparison]::Ordinal) -or
        ($Request.value.deploymentSha -and
          -not $Accepted.deploymentSha.StartsWith($Request.value.deploymentSha + ':',[StringComparison]::Ordinal)))) {
      return $Output
    }
    $FinalReceipt = Read-NapCatQrBoundRecord $Directory 'result' $Request -WithFingerprint
    $Result = $FinalReceipt.value
    if ($null -ne $Result) {
      if (-not (Test-NapCatQrWorkerReceipt $Result $Dispatch $Claim.threadId) -or $Result.status -isnot [string] -or
          $Result.stopAttempted -isnot [bool] -or ($null -ne $Result.cleanupFailed -and $Result.cleanupFailed -isnot [bool])) {
        return $Output
      }
      $BeforeLogin = $Result.status -cin @('guard_unavailable','blocked_by_shared_guard','target_identity_unverified',
        'previous_login_unverified','refused_target_not_empty','connection_refusal_no_longer_confirmed','onebot_state_unknown',
        'wrong_identity_preserved','onebot_identity_unverified','process_identity_unverified','offline_no_longer_confirmed',
        'recovery_budget_insufficient','request_expired','recovery_refused_or_failed_before_stop')
      $AfterAdmission = $Result.status -cin @('login_verified','login_timed_out','login_result_unverified',
        'login_result_unknown_check_original_request')
      $AfterStop = $Result.status -cin @('stop_unverified','recovery_failed_after_stop_check_original_result')
      if (-not ($BeforeLogin -or $AfterAdmission -or $AfterStop -or $Result.status -ceq 'already_online') -or
          ($BeforeLogin -and $null -ne $Accepted) -or
          ($AfterAdmission -and $null -eq $Accepted) -or ($AfterStop -and -not $Result.stopAttempted) -or
          ($Result.status -ceq 'already_online' -and $Result.stopAttempted -and $null -eq $Accepted)) {
        return $Output
      }
      $Output.status = $Result.status
      $Output.stopAttempted = $Result.stopAttempted
      if ($Result.cleanupFailed) { $Output.cleanupFailed = $true }
      if ($Result.status -ceq 'login_timed_out') {
        if ($Result.terminalProof -isnot [string] -or $Result.terminalProof -cne 'legacy-timeout-after-cleanup/v1' -or
            $null -ne $Result.cleanupFailed) {
          $Output.status = 'login_result_unknown_check_original_request'
          return $Output
        }
        if ($IncludeTerminalBinding) {
          $Output.terminalProof = $Result.terminalProof
          $Output.terminalDeploymentSha = $Accepted.deploymentSha
          $Output.terminalTargetSha = $Accepted.targetSha
        }
      }
      if ($IncludeTerminalBinding) {
        $Output.terminalResultSha = $FinalReceipt.sha
        $Output.terminalAdmissionSha = $AdmissionReceipt.sha
        $Output.terminalDefinite = -not $Result.cleanupFailed -and
          ($Result.status -cin @('login_verified','already_online') -or ($BeforeLogin -and -not $Result.stopAttempted))
      }
      return $Output
    }
    if ($null -ne $Accepted) {
      $Worker = Get-NapCatQrWorkerIdentity $Claim.workerPid
      if ($Worker.birth -eq $Claim.workerBirth -and $Worker.sessionId -eq $Request.value.sessionId -and
          $Worker.parentPid -eq $Claim.parentPid) {
        $Output.status = 'accepted_wait_for_login_result'
        $Output.proof = $Accepted.proof
      }
    }
  } catch {}
  return $Output
}

function New-NapCatQrWorkerStartInfo {
  param([string]$Entry,[string]$Id,[string]$Hash,[string]$Edition = $PSVersionTable.PSEdition)
  $Starter = [Diagnostics.ProcessStartInfo]::new((Get-NapCatQrPowerShellExecutable -Edition $Edition))
  $PolicyPrefix = if ($Edition -ceq 'Core') { '' } else { '-ExecutionPolicy Bypass ' }
  $Starter.Arguments = '-NoLogo -NoProfile -NonInteractive {0}-STA -File "{1}" -Mode Worker -RequestId {2} -RequestSha256 {3}' -f $PolicyPrefix,$Entry,$Id,$Hash
  $Starter.WorkingDirectory = [IO.Path]::GetDirectoryName($Entry)
  $Starter.UseShellExecute = $false
  $Starter.CreateNoWindow = $true
  if ($Starter.EnvironmentVariables.ContainsKey('PSExecutionPolicyPreference')) {
    $null = $Starter.EnvironmentVariables.Remove('PSExecutionPolicyPreference')
  }
  return $Starter
}

function Start-NapCatQrNativeWorker {
  param([string]$Entry,[string]$Id,[string]$Hash)
  Assert-NapCatQrIndependentWorker
  return [Diagnostics.Process]::Start((New-NapCatQrWorkerStartInfo $Entry $Id $Hash))
}

function Start-NapCatQrSubmission {
  param([string]$Directory,$Request,[scriptblock]$Launch,[int]$WaitSeconds)
  try {
    Write-NapCatQrRecord $Directory 'submitted' @{ id=$Request.value.id; requestSha256=$Request.sha } -Claim
  } catch { return (Get-NapCatQrOutcome $Directory $Request) }
  $Child = $null
  try {
    $Child = & $Launch
    if ($Child -isnot [Diagnostics.Process]) { throw 'worker_dispatch_unverified' }
    $null = $Child.Handle
    Write-NapCatQrRecord $Directory 'dispatch' @{
      id=$Request.value.id; requestSha256=$Request.sha; parentPid=$PID
      workerPid=$Child.Id; workerBirth=$Child.StartTime.ToFileTimeUtc()
    }
  } catch { return (Get-NapCatQrOutcome $Directory $Request) }
  finally { if ($Child -is [Diagnostics.Process]) { $Child.Dispose() } }
  $Timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $Outcome = Get-NapCatQrOutcome $Directory $Request
    if ($Outcome.status -ne 'submission_unknown_do_not_retry') { return $Outcome }
    if ($Timer.Elapsed.TotalSeconds -ge $WaitSeconds) { return $Outcome }
    Start-Sleep -Milliseconds 120
  } while ($true)
}

function Get-NapCatQrRetirementProof {
  param([string]$Directory,$Request,$Pointer,[switch]$AllowUnsent)
  $Dispatch = Get-NapCatQrBoundDispatch $Directory $Request
  if ($null -ne $Dispatch) {
    if ($Pointer.phase -ceq 'prelaunch/v1') { return }
    Initialize-NapCatQrNative
    if ([NapCatQrNative]::WorkerHasExited($Dispatch.workerPid,$Dispatch.workerBirth)) {
      return @{ kind='worker_exited'; workerPid=$Dispatch.workerPid; workerBirth=$Dispatch.workerBirth }
    }
    return
  }
  $Value = $Request.value
  if (-not $AllowUnsent -or $Pointer.phase -cne 'prelaunch/v1' -or $Pointer.id -cne $Value.id -or
      $Pointer.sha -cne $Request.sha -or $Value.deploymentSha -cnotmatch '^[0-9a-f]{64}$' -or
      [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt ($Value.deadlineAt + 2500) -or
      $Value.requesterBirth -gt [DateTimeOffset]::FromUnixTimeMilliseconds($Value.createdAt + 1).UtcDateTime.ToFileTimeUtc()) { return }
  $Entry = $MyInvocation.MyCommand.ScriptBlock.File
  if ($Value.entrySha -cne (Read-NapCatQrFile $Entry 524288).sha) { return }
  foreach ($Name in @('submitted','dispatch','claim','accepted','result')) {
    if (Test-NapCatQrRecordPresent ([IO.Path]::Combine($Directory,"$Name.json"))) { return }
  }
  Initialize-NapCatQrNative
  if ([NapCatQrNative]::WorkerHasExited($Value.requesterPid,$Value.requesterBirth)) { return @{ kind='not_submitted' } }
}

function Start-NapCatQrTargetSubmission {
  param([string]$TargetDirectory,$Desktop,[scriptblock]$NewRequest,[scriptblock]$Launch,[int]$WaitSeconds,[string]$RequestBase,
    [string]$SupersedeRequestId,[scriptblock]$ConfirmRetirement)
  if (-not [IO.Directory]::Exists($TargetDirectory)) {
    try { New-NapCatQrRequestDirectory $TargetDirectory $Desktop.sid }
    catch { if (-not [IO.Directory]::Exists($TargetDirectory)) { throw } }
  }
  Assert-NapCatQrRequestDirectory $TargetDirectory $Desktop.sid
  try { $Lock = [IO.File]::Open([IO.Path]::Combine($TargetDirectory,'submit.lock'),'OpenOrCreate','ReadWrite','None') }
  catch [IO.IOException] { return @{ status='target_submission_in_progress_do_not_retry' } }
  try {
    $PointerPath = [IO.Path]::Combine($TargetDirectory,'current.json')
    $Pointer = $null
    $PriorOutcome = $null
    $Definite = $false
    if (Test-NapCatQrRecordPresent $PointerPath) {
      $OriginalPointer = Read-NapCatQrFile $PointerPath
      $Pointer = ConvertFrom-NapCatQrFile $OriginalPointer
      if ($Pointer -isnot [pscustomobject] -or $Pointer.id -isnot [string] -or $Pointer.id -cnotmatch '^[0-9a-f]{32}$' -or
          $Pointer.sha -isnot [string] -or $Pointer.sha -cnotmatch '^[0-9a-f]{64}$' -or
          ($null -ne $Pointer.phase -and ($Pointer.phase -isnot [string] -or
            $Pointer.phase -cnotin @('prelaunch/v1','launch-boundary-closed/v1')))) {
        throw 'target_receipt_unverified'
      }
      if ($SupersedeRequestId -and $SupersedeRequestId -cne $Pointer.id) {
        return @{ status='superseded_request_mismatch'; requestId=$Pointer.id }
      }
      $OriginalDirectory = if ($RequestBase) { Get-NapCatQrRequestDirectory $Pointer.id $RequestBase } else { Get-NapCatQrRequestDirectory $Pointer.id }
      $Original = Get-NapCatQrRequest $OriginalDirectory $Pointer.id $Pointer.sha $Desktop -Historical
      $PriorOutcome = Get-NapCatQrOutcome $OriginalDirectory $Original -IncludeTerminalBinding
      $Definite = $PriorOutcome.terminalDefinite -eq $true
      if (-not $SupersedeRequestId -and (-not $Definite -or
          [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt ($Original.value.createdAt + 3000))) {
        return (Get-NapCatQrOutcome $OriginalDirectory $Original)
      }
      $PriorLifecycleProof = Get-NapCatQrRetirementProof $OriginalDirectory $Original $Pointer -AllowUnsent:([bool]$SupersedeRequestId)
      if ($null -eq $PriorLifecycleProof) {
        return @{ status='previous_worker_exit_unverified'; requestId=$Pointer.id }
      }
      if (($PriorLifecycleProof.kind -ceq 'worker_exited' -and -not $PriorOutcome.terminalResultSha) -or
          (-not $Definite -and $null -eq $ConfirmRetirement)) {
        return @{ status='previous_login_unverified'; requestId=$Pointer.id }
      }
    } elseif ($SupersedeRequestId) {
      return @{ status='superseded_request_mismatch' }
    }
    $Commit = {
      param($SupersededOffline)
      if ($null -ne $Pointer) {
        if ((Read-NapCatQrFile $PointerPath).sha -cne $OriginalPointer.sha) { throw 'target_receipt_unverified' }
        $OriginalNow = Get-NapCatQrRequest $OriginalDirectory $Pointer.id $Pointer.sha $Desktop -Historical
        $Again = Get-NapCatQrRetirementProof $OriginalDirectory $OriginalNow $Pointer -AllowUnsent:([bool]$SupersedeRequestId)
        if ($null -eq $Again -or $PriorLifecycleProof.kind -cne $Again.kind -or $PriorLifecycleProof.workerPid -ne $Again.workerPid -or
            $PriorLifecycleProof.workerBirth -ne $Again.workerBirth) { throw 'previous_worker_exit_unverified' }
        if ($Again.kind -ceq 'worker_exited') {
          $OutcomeNow = Get-NapCatQrOutcome $OriginalDirectory $OriginalNow -IncludeTerminalBinding
          if ($OutcomeNow.terminalResultSha -cne $PriorOutcome.terminalResultSha -or
              $OutcomeNow.terminalAdmissionSha -cne $PriorOutcome.terminalAdmissionSha -or
              $OutcomeNow.terminalDefinite -ne $Definite -or
              ($null -ne $SupersededOffline -and ($OutcomeNow.terminalProof -cne 'legacy-timeout-after-cleanup/v1' -or
                $OutcomeNow.terminalDeploymentSha -cne $SupersededOffline.deploymentSha -or
                $OutcomeNow.terminalTargetSha -cne $SupersededOffline.targetSha))) { throw 'previous_login_unverified' }
        }
      }
      $UncertainRequestId = if (-not $Definite) { $SupersedeRequestId }
      $Candidate = & $NewRequest $SupersededOffline $UncertainRequestId
      if ($null -ne $Pointer) {
        $ArchiveName = 'retired-' + $Pointer.id
        $ArchivePath = [IO.Path]::Combine($TargetDirectory,"$ArchiveName.json")
        if (Test-NapCatQrRecordPresent $ArchivePath) {
          $Archive = ConvertFrom-NapCatQrFile (Read-NapCatQrFile $ArchivePath)
          if ($Archive -isnot [pscustomobject] -or $Archive.id -cne $Pointer.id -or $Archive.sha -cne $Pointer.sha -or
              $Archive.lastStatus -cne $PriorOutcome.status -or
              ($null -ne $Archive.resultSha -and $Archive.resultSha -cne $PriorOutcome.terminalResultSha) -or
              $Archive.workerPid -ne $PriorLifecycleProof.workerPid -or $Archive.workerBirth -ne $PriorLifecycleProof.workerBirth -or
              ($PriorLifecycleProof.kind -ceq 'not_submitted' -and $Archive.retirementProof -cne $PriorLifecycleProof.kind)) {
            throw 'target_receipt_unverified'
          }
        } else {
          Write-NapCatQrRecord $TargetDirectory $ArchiveName @{
            id=$Pointer.id; sha=$Pointer.sha; lastStatus=$PriorOutcome.status; resultSha=$PriorOutcome.terminalResultSha
            workerPid=$PriorLifecycleProof.workerPid; workerBirth=$PriorLifecycleProof.workerBirth; retirementProof=$PriorLifecycleProof.kind
          }
        }
      }
      Write-NapCatQrRecord $TargetDirectory 'current' @{
        id=$Candidate.request.value.id; sha=$Candidate.request.sha; phase='prelaunch/v1'
      } -Replace:($null -ne $Pointer)
      return $Candidate
    }
    $Next = if ($null -ne $Pointer -and -not $Definite) {
      & $ConfirmRetirement $Original $Commit $PriorOutcome
    } else { & $Commit $null }
    if ($null -eq $Next) { return @{ status='previous_login_unverified'; requestId=$Pointer.id } }
    $StartWorker = $Launch
    $null = Start-NapCatQrSubmission $Next.directory $Next.request {
      $Prepared = ConvertFrom-NapCatQrFile (Read-NapCatQrFile $PointerPath)
      if ($Prepared.id -cne $Next.request.value.id -or $Prepared.sha -cne $Next.request.sha -or
          $Prepared.phase -cne 'prelaunch/v1') { throw 'target_receipt_unverified' }
      Write-NapCatQrRecord $TargetDirectory 'current' @{
        id=$Prepared.id; sha=$Prepared.sha; phase='launch-boundary-closed/v1'
      } -Replace
      $Closed = ConvertFrom-NapCatQrFile (Read-NapCatQrFile $PointerPath)
      if ($Closed.id -cne $Prepared.id -or $Closed.sha -cne $Prepared.sha -or
          $Closed.phase -cne 'launch-boundary-closed/v1') { throw 'target_receipt_unverified' }
      & $StartWorker $Next.request
    } 0
  } finally { $Lock.Dispose() }
  $Timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $Outcome = Get-NapCatQrOutcome $Next.directory $Next.request
    if ($Outcome.status -ne 'submission_unknown_do_not_retry' -or $Timer.Elapsed.TotalSeconds -ge $WaitSeconds) { return $Outcome }
    Start-Sleep -Milliseconds 120
  } while ($true)
}

function Assert-NapCatQrInputs {
  param($Request,[string]$Entry,[string]$GuardPath,[string]$IdentityPath,[string]$LegacyPath)
  if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $Request.deadlineAt) { throw 'request_expired' }
  foreach ($Pair in @(
    @{ path=$Entry; sha=$Request.entrySha },@{ path=$GuardPath; sha=$Request.guardSha },
    @{ path=$IdentityPath; sha=$Request.identitySha },@{ path=$LegacyPath; sha=$Request.loginSha },
    @{ path=$Request.configPath; sha=$Request.configSha }
  )) {
    if ((Read-NapCatQrFile $Pair.path 524288).sha -cne $Pair.sha) { throw 'input_fingerprint_changed' }
  }
}

function Assert-NapCatQrSharedGuard {
  param($Guard)
  Initialize-NapCatQrNative
  $ManualPath = [IO.Path]::Combine($Guard.paths.accountStateDir,'manual-recovery.lock')
  if (-not $Guard.acquired -or -not $Guard.ownsMutex -or $Guard.mutex -isnot [Threading.Mutex] -or
      $Guard.threadId -ne [Threading.Thread]::CurrentThread.ManagedThreadId -or
      -not [NapCatQrNative]::OwnsMutex($Guard.mutex) -or
      @($Guard.files | Where-Object { $_.Name -ieq $ManualPath -and -not $_.SafeFileHandle.IsClosed }).Count -ne 1) {
    throw 'manual_guard_ownership_unverified'
  }
  try {
    $Probe = [IO.File]::Open($ManualPath,'Open','Read','ReadWrite')
    $Probe.Dispose()
    throw 'manual_guard_ownership_unverified'
  } catch [IO.IOException] {
    if (($_.Exception.HResult -band 65535) -ne 32) { throw 'manual_guard_ownership_unverified' }
  }
}

function Assert-NapCatQrDeployment {
  param($Guard,$Config)
  $Path = [IO.Path]::Combine($Guard.paths.accountStateDir,'deployment.json')
  $File = Read-NapCatQrFile $Path 524288
  $Deployment = ConvertFrom-NapCatQrFile $File
  $Binding = Read-NapCatQrFile $Guard.paths.bindingPath 65536
  $BindingValue = ConvertFrom-NapCatQrFile $Binding
  $BoundAccount = [string]$BindingValue.expectedSelfId
  if ($Deployment.state -cne 'active' -or [string]$Deployment.account -cne [string]$Config.expectedAccount -or
      $Guard.account -cne [string]$Config.expectedAccount -or $BoundAccount -cne $Guard.account -or
      $BindingValue.controlPlane.localMachine -cne $Config.machineRole) { throw 'target_identity_unverified' }
  foreach ($Name in @('dataRoot','napCatRoot','brokerRoot','qqUserDataDir')) {
    if ((ConvertTo-NapCatQrPath $Deployment.$Name) -ine $Guard.paths.$Name) { throw 'target_identity_unverified' }
  }
  if ((ConvertTo-NapCatQrOptionalExePath $Deployment.qqExePath) -ine $Guard.paths.qqExePath) {
    throw 'target_identity_unverified'
  }
  return ($File.sha + ':' + $Binding.sha)
}

function Get-NapCatQrOwnedSnapshot {
  param($Guard)
  return Get-NapCatProcessClassification -Processes @(Get-NapCatOwnershipSnapshot) -NapCatRoot $Guard.paths.napCatRoot
}

function Get-NapCatQrOneBotTarget {
  param($Guard)
  $File = Read-NapCatQrFile $Guard.paths.privateEnvPath 524288
  $Private = ConvertFrom-NapCatQrFile $File
  $Url = ([string]$Private.NAPCAT_HTTP_URL).TrimEnd('/')
  if ($Url -cnotmatch '^https?://(127\.0\.0\.1|localhost)(:\d+)?$' -or
      [string]::IsNullOrWhiteSpace([string]$Private.NAPCAT_ACCESS_TOKEN)) { throw 'onebot_state_unknown' }
  return [pscustomobject]@{ url=$Url; port=([Uri]$Url).Port; token=[string]$Private.NAPCAT_ACCESS_TOKEN; sha=$File.sha }
}

function Get-NapCatQrAccountEvidence {
  param($Target,[long]$DeadlineAt)
  $Missing = @{ account=$null; verified=$false; malformed=$false }
  $Budget = [Math]::Min(2500,(Get-NapCatOfflineRemainingMilliseconds $DeadlineAt))
  if ($Budget -le 0) { return $Missing }
  $Response = $null
  try {
    $Request = [Net.HttpWebRequest][Net.WebRequest]::Create("$($Target.url)/get_login_info")
    $Request.Method = 'POST'
    $Request.AllowAutoRedirect = $false
    $Request.Proxy = $null
    $Request.KeepAlive = $false
    $Request.Timeout = [int]$Budget
    $Request.ReadWriteTimeout = [int]$Budget
    $Request.Headers['Authorization'] = "Bearer $($Target.token)"
    $Request.ContentType = 'application/json'
    $Request.ContentLength = 2
    $Body = $Request.GetRequestStream()
    try { $Body.Write([byte[]]@(123,125),0,2) } finally { $Body.Dispose() }
    try { $Response = $Request.GetResponse() }
    catch {
      $Failure = $_.Exception
      while ($null -ne $Failure -and $Failure -isnot [Net.WebException]) { $Failure = $Failure.InnerException }
      if ($null -eq $Failure -or $null -eq $Failure.Response) { return $Missing }
      $Response = $Failure.Response
    }
    $Buffer = [byte[]]::new(8192)
    $Count = 0
    $Stream = $Response.GetResponseStream()
    do {
      if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0 -or $Count -ge $Buffer.Length) { return $Missing }
      $Read = $Stream.Read($Buffer,$Count,$Buffer.Length-$Count)
      $Count += $Read
    } while ($Read -gt 0)
    $Value = [Text.Encoding]::UTF8.GetString($Buffer,0,$Count) | ConvertFrom-Json -ErrorAction Stop
    $Account = [string]$Value.data.user_id
    if ([string]::IsNullOrWhiteSpace($Account) -or $Account -ceq '0') { return $Missing }
    if ($Account -cnotmatch '^[1-9][0-9]{4,31}$') { return @{ account=$null; verified=$false; malformed=$true } }
    return @{
      account=$Account; malformed=$false
      verified=([int]$Response.StatusCode -eq 200 -and $Value.status -ceq 'ok' -and
        ($null -eq $Value.retcode -or (($Value.retcode -is [int] -or $Value.retcode -is [long]) -and $Value.retcode -eq 0)))
    }
  } catch { return $Missing }
  finally { if ($null -ne $Response) { try { $Response.Dispose() } catch {} } }
}

function Get-NapCatQrReportedAccount {
  param($Target,[long]$DeadlineAt)
  $Evidence = Get-NapCatQrAccountEvidence $Target $DeadlineAt
  if ($Evidence.verified) { return $Evidence.account }
  return $null
}

function Get-NapCatQrAccountRefusal {
  param($Evidence,[string]$Expected,[switch]$RequireVerified)
  if ($null -ne $Evidence.account -and $Evidence.account -cne $Expected) { return 'wrong_identity_preserved' }
  if ($Evidence.malformed -or ($RequireVerified -and -not $Evidence.verified)) { return 'onebot_identity_unverified' }
}

function Assert-NapCatQrListenerOwner {
  param($Target,[object[]]$Processes,$ExpectedOwner)
  $Owners = @(Get-NetTCPConnection -State Listen -LocalPort $Target.port -ErrorAction Stop |
    Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } |
    Select-Object -ExpandProperty OwningProcess -Unique)
  if ($Owners.Count -ne 1 -or [int]$Owners[0] -notin @($Processes | ForEach-Object { [int]$_.ProcessId }) -or
      ($null -ne $ExpectedOwner -and [int]$Owners[0] -ne $ExpectedOwner)) {
    throw 'onebot_owner_unverified'
  }
  return [int]$Owners[0]
}

function Test-NapCatQrNoExistingTarget {
  param($Guard,$Target)
  $Snapshot = Get-NapCatQrOwnedSnapshot $Guard
  if (@($Snapshot.owned).Count -ne 0 -or @($Snapshot.unknown).Count -ne 0) { return $false }
  $Listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
  return @($Listeners | Where-Object { $_.Port -eq $Target.port }).Count -eq 0
}

function Get-NapCatQrOwnedProcessSet {
  param($Snapshot)
  $Owned = @($Snapshot.owned)
  if (@($Snapshot.unknown).Count -ne 0 -or $Owned.Count -eq 0) { throw 'process_identity_unverified' }
  $ById = @{}
  foreach ($Record in $Owned) { $ById[[int]$Record.ProcessId] = $Record }
  $Roots = @($Owned | Where-Object {
    $_.Name -match '^(qq|qqnt|qqex)(\.exe)?$' -and $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type(?:[=\s]|$)'
  })
  if ($Roots.Count -eq 0) { $Roots = @($Owned | Where-Object { -not (Test-NapCatIdentityLink $_ $ById[[int]$_.ParentProcessId]) }) }
  if ($Roots.Count -ne 1) { throw 'process_identity_unverified' }
  $Root = @{ pid=[int]$Roots[0].ProcessId; CreationDate=$Roots[0].CreationDate }
  $Expected = @($Owned | ForEach-Object { @{ pid=[int]$_.ProcessId; identityKey=(Get-NapCatOfflineProcessIdentityKey $_) } })
  $Exact = @(Get-NapCatOfflineExactOwnedProcesses -Classification $Snapshot -Root $Root -Expected $Expected)
  $ProcessSha = Get-NapCatOfflineSha256 ([Text.Encoding]::UTF8.GetBytes((($Expected.identityKey | Sort-Object) -join ':')))
  return @{ root=$Root; expected=$Expected; exact=$Exact; sha=$ProcessSha }
}

function Get-NapCatQrRetirementTargetProof {
  param($Guard,$Target,[long]$DeadlineAt,[bool]$AllowOffline)
  $State = Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $DeadlineAt -Target $Target
  if ($State -ceq 'connection_refused' -and (Test-NapCatQrNoExistingTarget $Guard $Target)) { return @{ state=$State } }
  if ($State -cne 'offline' -or -not $AllowOffline -or
      (Get-NapCatQrAccountRefusal (Get-NapCatQrAccountEvidence $Target $DeadlineAt) $Guard.account)) { return }
  $View = Get-NapCatQrOwnedProcessSet (Get-NapCatQrOwnedSnapshot $Guard)
  return @{ state=$State; processSha=$View.sha; owner=(Assert-NapCatQrListenerOwner $Target $View.exact) }
}

function Invoke-NapCatQrRetirement {
  param($Original,[scriptblock]$Commit,$Config,$Paths,[scriptblock]$Revalidate,$PriorOutcome)
  if ($Original.value.configPath -ine $Config.path -or $Original.value.configSha -cne $Config.sha -or
      $Original.value.bindingSha -cne $Config.bindingSha -or $Original.value.loginSha -cne $Config.value.loginSha256) {
    throw 'previous_request_config_changed'
  }
  $Guard = Enter-NapCatOfflineRecoveryGuard -Paths $Paths
  if (-not $Guard.acquired) { return }
  $CleanupFailed = $false
  try {
    Assert-NapCatQrSharedGuard $Guard
    $DeploymentSha = Assert-NapCatQrDeployment $Guard $Config.value
    if ($Original.value.deploymentSha -and -not $DeploymentSha.StartsWith($Original.value.deploymentSha + ':',[StringComparison]::Ordinal)) {
      throw 'previous_request_config_changed'
    }
    $Target = Get-NapCatQrOneBotTarget $Guard
    $DeadlineAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 8000
    $AllowOffline = $PriorOutcome.terminalProof -ceq 'legacy-timeout-after-cleanup/v1' -and
      $PriorOutcome.terminalDeploymentSha -ceq $DeploymentSha -and $PriorOutcome.terminalTargetSha -ceq $Target.sha
    if (-not $AllowOffline -and -not (Test-NapCatQrNoExistingTarget $Guard $Target)) { return }
    $First = Get-NapCatQrRetirementTargetProof $Guard $Target $DeadlineAt $AllowOffline
    if ($null -eq $First) { return }
    & $Revalidate
    $Again = Get-NapCatQrRetirementTargetProof $Guard $Target $DeadlineAt $AllowOffline
    if ($null -eq $Again -or $Again.state -cne $First.state -or $Again.owner -ne $First.owner -or
        $Again.processSha -cne $First.processSha -or (Assert-NapCatQrDeployment $Guard $Config.value) -cne $DeploymentSha -or
        (Get-NapCatQrOneBotTarget $Guard).sha -cne $Target.sha -or (Test-NapCatOfflineRecoveryInhibited -Paths $Guard.paths) -or
        (Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) { return }
    Assert-NapCatQrSharedGuard $Guard
    $Offline = if ($First.state -ceq 'offline') {
      @{ owner=$First.owner; processSha=$First.processSha; deploymentSha=$DeploymentSha; targetSha=$Target.sha }
    }
    $Candidate = & $Commit $Offline
  } finally {
    try { Exit-NapCatOfflineRecoveryGuard -Guard $Guard } catch { $CleanupFailed = $true }
  }
  if ($CleanupFailed) { throw 'retirement_cleanup_unverified' }
  return $Candidate
}

function Test-NapCatQrLegacyTimeout {
  param([Management.Automation.ErrorRecord]$Failure,[string]$Path,[string]$Sha256)
  $ApprovedPins = @(
    '4b94a1354db22a0d736ece6ca2a76b478bb3420525cec50724a54d5f162fe843',
    '53c27b8a8752150c913d66f37df5ac9f05730060d59a0df6a9240380edfd76c0',
    'a063cc73826cedcb5db8b2995a8db9bfa7266357a954e2609a5e1897ab5a5c2b'
  )
  return $Sha256 -cin $ApprovedPins -and
    $Failure.Exception -is [Management.Automation.RuntimeException] -and
    $Failure.InvocationInfo.ScriptName -ieq $Path -and $Failure.InvocationInfo.ScriptLineNumber -eq 1047
}

function Invoke-NapCatQrManualLogin {
  param($Paths,$Config,[long]$DeadlineAt,[scriptblock]$Revalidate,[scriptblock]$OnAdmitted,[ref]$StopAttempted,[switch]$RequireEmptyTarget,
    $SupersededOffline,[ref]$CleanupFailed,[string]$ExpectedDeploymentSha)
  $Guard = Enter-NapCatOfflineRecoveryGuard -Paths $Paths
  if (-not $Guard.acquired) { return 'blocked_by_shared_guard' }
  $Handles = @()
  $LegacyPin = $null
  $LegacyRuntimePin = $null
  try {
    Assert-NapCatQrSharedGuard $Guard
    $DeploymentSha = Assert-NapCatQrDeployment $Guard $Config
    if ($ExpectedDeploymentSha -and -not $DeploymentSha.StartsWith($ExpectedDeploymentSha + ':',[StringComparison]::Ordinal)) {
      return 'target_identity_unverified'
    }
    $Target = Get-NapCatQrOneBotTarget $Guard
    if ($null -ne $SupersededOffline -and
        ($SupersededOffline.deploymentSha -cne $DeploymentSha -or $SupersededOffline.targetSha -cne $Target.sha)) {
      return 'previous_login_unverified'
    }
    $State = Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $DeadlineAt -Target $Target
    if ($State -ceq 'connection_refused') {
      if ($null -ne $SupersededOffline) { return 'previous_login_unverified' }
      if (-not (Test-NapCatQrNoExistingTarget $Guard $Target)) { return 'refused_target_not_empty' }
      $LegacyPin = [IO.File]::Open($Paths.loginScriptPath,'Open','Read','Read')
      & $Revalidate
      if ((Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $DeadlineAt -Target $Target) -cne 'connection_refused') {
        return 'connection_refusal_no_longer_confirmed'
      }
      if (-not (Test-NapCatQrNoExistingTarget $Guard $Target)) { return 'refused_target_not_empty' }
      if ((Assert-NapCatQrDeployment $Guard $Config) -cne $DeploymentSha -or
          (Get-NapCatQrOneBotTarget $Guard).sha -cne $Target.sha -or
          (Test-NapCatOfflineRecoveryInhibited -Paths $Guard.paths)) { return 'target_identity_unverified' }
    } else {
      if ($State -cnotin @('online','offline')) { return 'onebot_state_unknown' }
      $IdentityFailure = Get-NapCatQrAccountRefusal (Get-NapCatQrAccountEvidence $Target $DeadlineAt) $Guard.account -RequireVerified:($State -ceq 'online')
      if ($IdentityFailure) { return $IdentityFailure }
      if ($State -ceq 'online') {
        return 'already_online'
      }
      if ($RequireEmptyTarget -and $null -eq $SupersededOffline) { return 'previous_login_unverified' }
      $Snapshot = Get-NapCatQrOwnedSnapshot $Guard
      try { $View = Get-NapCatQrOwnedProcessSet $Snapshot } catch { return 'process_identity_unverified' }
      if ($null -ne $SupersededOffline -and $SupersededOffline.processSha -cne $View.sha) { return 'previous_login_unverified' }
      $Exact = @(Get-NapCatOfflineExactOwnedProcesses -Classification (Get-NapCatQrOwnedSnapshot $Guard) -Root $View.root -Expected $View.expected)
      $Handles = @(Open-NapCatOfflineProcessHandles -Processes $Exact)
      Initialize-NapCatOfflineStopApi
      $LegacyPin = [IO.File]::Open($Paths.loginScriptPath,'Open','Read','Read')
      & $Revalidate
      if ((Assert-NapCatQrDeployment $Guard $Config) -cne $DeploymentSha -or (Get-NapCatQrOneBotTarget $Guard).sha -cne $Target.sha -or
          (Test-NapCatOfflineRecoveryInhibited -Paths $Guard.paths)) { return 'target_identity_unverified' }
      $ListenerBefore = Assert-NapCatQrListenerOwner $Target $Exact $SupersededOffline.owner
      $FinalState = Get-NapCatOfflineOneBotState -Guard $Guard -DeadlineAt $DeadlineAt -Target $Target
      if ($FinalState -cne 'offline') { return 'offline_no_longer_confirmed' }
      $IdentityFailure = Get-NapCatQrAccountRefusal (Get-NapCatQrAccountEvidence $Target $DeadlineAt) $Guard.account
      if ($IdentityFailure) { return $IdentityFailure }
      & $Revalidate
      $Fresh = @(Get-NapCatOfflineExactOwnedProcesses -Classification (Get-NapCatQrOwnedSnapshot $Guard) -Root $View.root -Expected $View.expected)
      $null = Assert-NapCatQrListenerOwner $Target $Fresh $ListenerBefore
      if ((Assert-NapCatQrDeployment $Guard $Config) -cne $DeploymentSha -or (Get-NapCatQrOneBotTarget $Guard).sha -cne $Target.sha -or
          (Test-NapCatOfflineRecoveryInhibited -Paths $Guard.paths)) { return 'target_identity_unverified' }
      if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 3000) { return 'recovery_budget_insufficient' }
      Stop-NapCatOfflineRetainedProcesses -Handles $Handles -DeadlineAt $DeadlineAt -MutationAttempted $StopAttempted
      $Remaining = Get-NapCatQrOwnedSnapshot $Guard
      if (@($Remaining.owned).Count -ne 0 -or @($Remaining.unknown).Count -ne 0) { return 'stop_unverified' }
    }
    & $Revalidate
    Assert-NapCatQrSharedGuard $Guard
    if (-not (Test-NapCatQrNoExistingTarget $Guard $Target)) { return 'refused_target_not_empty' }
    if (-not $Guard.paths.qqExePath) {
      $LegacyRuntimePath = [IO.Path]::Combine($Guard.paths.dataRoot,'napcat-runtime.json')
      if (Get-NapCatOfflinePathPresence $LegacyRuntimePath) {
        if (([IO.File]::GetAttributes($LegacyRuntimePath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'target_identity_unverified' }
        $LegacyRuntimePin = [IO.File]::Open($LegacyRuntimePath,'Open','Read','Read')
      }
    }
    $FreshPaths = Get-NapCatOfflineRecoveryPaths -Paths $Paths
    if ($FreshPaths.qqExePath -ine $Guard.paths.qqExePath -or
        (Get-NapCatOfflineQqProfile -QqUserDataDir $FreshPaths.qqUserDataDir).normalizedPath -cne $Guard.profile.normalizedPath -or
        (Assert-NapCatQrDeployment $Guard $Config) -cne $DeploymentSha -or (Get-NapCatQrOneBotTarget $Guard).sha -cne $Target.sha -or
        (Test-NapCatOfflineRecoveryInhibited -Paths $Guard.paths)) { return 'target_identity_unverified' }
    if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) { return 'request_expired' }
    $LoginArguments = @{
      DataRoot=$Paths.dataRoot; BrokerRoot=$Paths.brokerRoot; NapCatRoot=$Paths.napCatRoot
      QqExePath=$Guard.paths.qqExePath; QqUserDataDir=$Guard.profile.normalizedPath; TimeoutSeconds=300; NoPasswordFallback=$true
    }
    Release-NapCatOfflineLoginAttemptFile -Guard $Guard
    & $OnAdmitted $DeploymentSha $Target.sha
    $global:LASTEXITCODE = 0
    try { $RawResult = (& $Paths.loginScriptPath @LoginArguments | Out-String).Trim() }
    catch {
      if (Test-NapCatQrLegacyTimeout $_ $Paths.loginScriptPath $Config.loginSha256) { return 'login_timed_out' }
      throw
    }
    if ($global:LASTEXITCODE -ne 0) { return 'login_result_unknown_check_original_request' }
    $Login = $RawResult | ConvertFrom-Json -ErrorAction Stop
    if ([string]$Login.userId -cne $Guard.account) { return 'login_result_unverified' }
    if ($Login.state -ceq 'already_online') { return 'already_online' }
    if ($Login.state -cin @('online','online_existing')) { return 'login_verified' }
    return 'login_result_unverified'
  } finally {
    $Failed = $false
    try { Close-NapCatOfflineResources -Resources @($LegacyRuntimePin,$LegacyPin) } catch { $Failed = $true }
    try { Close-NapCatOfflineProcessHandles -Handles $Handles } catch { $Failed = $true }
    try { Exit-NapCatOfflineRecoveryGuard -Guard $Guard } catch { $Failed = $true }
    if ($Failed -and $null -ne $CleanupFailed) { $CleanupFailed.Value = $true }
  }
}

function Invoke-NapCatQrWorker {
  param([string]$Directory,$Request,$Desktop,[string]$Entry,[string]$GuardPath,[string]$IdentityPath,[string]$LegacyPath,
    [scriptblock]$CheckWorkerLifetime)
  $Value = $Request.value
  & $CheckWorkerLifetime
  if ($null -eq (Read-NapCatQrBoundRecord $Directory 'submitted' $Request)) { throw 'submission_unverified' }
  $Worker = Get-NapCatQrWorkerIdentity $PID
  if ($Worker.pid -eq $Value.requesterPid -or $Worker.sessionId -ne $Value.sessionId -or $Worker.parentPid -ne $Value.requesterPid -or
      $Worker.birth -le $Value.requesterBirth -or
      $Worker.birth -lt ([DateTimeOffset]::FromUnixTimeMilliseconds($Value.createdAt).UtcDateTime.ToFileTimeUtc())) {
    throw 'worker_identity_unverified'
  }
  $DispatchWait = [Diagnostics.Stopwatch]::StartNew()
  do {
    $Dispatch = Get-NapCatQrBoundDispatch $Directory $Request
    if ($null -ne $Dispatch) { break }
    Start-Sleep -Milliseconds 75
  } while ($DispatchWait.ElapsedMilliseconds -lt 2500)
  if ($null -eq $Dispatch -or $Dispatch.workerPid -ne $Worker.pid -or $Dispatch.workerBirth -ne $Worker.birth -or
      $Dispatch.parentPid -ne $Worker.parentPid) { throw 'worker_dispatch_unverified' }
  $BaseRecord = @{
    id=$Value.id; requestSha256=$Request.sha; workerPid=$Worker.pid; workerBirth=$Worker.birth; parentPid=$Worker.parentPid
    threadId=[Threading.Thread]::CurrentThread.ManagedThreadId
  }
  try { Write-NapCatQrRecord $Directory 'claim' $BaseRecord -Claim } catch { return 'request_already_claimed_or_unknown' }
  $StopAttempted = $false
  $CleanupFailed = $false
  $Admission = @{ publicationStarted=$false }
  $Status = 'guard_unavailable'
  try {
    Assert-NapCatQrInputs $Value $Entry $GuardPath $IdentityPath $LegacyPath
    $Config = Get-NapCatQrConfig $Value.configPath $Desktop 'manualQrEnabled'
    if ($Config.bindingSha -cne $Value.bindingSha) { throw 'input_fingerprint_changed' }
    $Paths = Get-NapCatQrTargetPaths $Config.value $LegacyPath
    . $IdentityPath
    . $GuardPath
    if ((Get-Command Enter-NapCatOfflineRecoveryGuard -CommandType Function -ErrorAction SilentlyContinue) -and
        (Get-Command Stop-NapCatOfflineRetainedProcesses -CommandType Function -ErrorAction SilentlyContinue)) {
      $Revalidate = {
        & $CheckWorkerLifetime
        Assert-NapCatQrInputs $Value $Entry $GuardPath $IdentityPath $LegacyPath
        $CurrentDesktop = Get-NapCatQrDesktopIdentity
        if ($CurrentDesktop.sid -cne $Value.sid -or $CurrentDesktop.sessionId -ne $Value.sessionId -or
            $CurrentDesktop.explorerId -ne $Value.explorerId) { throw 'interactive_desktop_changed' }
        if ((Read-NapCatQrFile $Paths.bindingPath 65536).sha -cne $Value.bindingSha) { throw 'input_fingerprint_changed' }
      }
      $Admit = {
        param($AdmittedDeploymentSha,$AdmittedTargetSha)
        $Admission.publicationStarted = $true
        Write-NapCatQrRecord $Directory 'accepted' ($BaseRecord + @{
          proof='same-worker-guard-admitted'; deploymentSha=$AdmittedDeploymentSha; targetSha=$AdmittedTargetSha
        })
      }
      $Status = Invoke-NapCatQrManualLogin $Paths $Config.value $Value.deadlineAt $Revalidate $Admit ([ref]$StopAttempted) `
        -RequireEmptyTarget:([bool]$Value.supersedesRequestId) -SupersededOffline $Value.supersededOffline `
        -CleanupFailed ([ref]$CleanupFailed) -ExpectedDeploymentSha $Value.deploymentSha
    }
  } catch {
    $Status = if ($StopAttempted) { 'recovery_failed_after_stop_check_original_result' }
      elseif ($Admission.publicationStarted) { 'login_result_unknown_check_original_request' }
      else { 'recovery_refused_or_failed_before_stop' }
  }
  $Result = $BaseRecord + @{ status=$Status; stopAttempted=$StopAttempted }
  if ($CleanupFailed) { $Result.cleanupFailed = $true }
  if ($Status -ceq 'login_timed_out' -and -not $CleanupFailed) { $Result.terminalProof = 'legacy-timeout-after-cleanup/v1' }
  Write-NapCatQrRecord $Directory 'result' $Result
  return $Status
}

if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
$Entry = ConvertTo-NapCatQrPath $PSCommandPath
$GuardPath = Join-Path $PSScriptRoot 'napcat-offline-recovery-guard.ps1'
$IdentityPath = Join-Path $PSScriptRoot 'napcat-process-identity.ps1'
$LegacyPath = Join-Path $PSScriptRoot 'start-napcat-login.ps1'
try {
  Initialize-NapCatQrPowerShell
  if ($SupersedeRequestId -and ($Mode -ne 'Start' -or $SupersedeRequestId -cnotmatch '^[0-9a-f]{32}$')) {
    throw 'invalid_superseded_request'
  }
  if ($Mode -eq 'Inspect' -and -not $RequestId -and -not $ConfigPath -and -not $RequestSha256) {
    @{ status='inspection_only'; submitted=$false } | ConvertTo-Json -Compress
    return
  }
  if ($Mode -cin @('Start','Worker')) { Assert-NapCatQrIndependentWorker }
  $Desktop = Get-NapCatQrDesktopIdentity
  if ($Mode -eq 'Worker' -or ($Mode -eq 'Inspect' -and $RequestId)) {
    if ($Mode -eq 'Worker' -and ($RequestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ConfigPath)) { throw 'invalid_worker_request' }
    $Directory = Get-NapCatQrRequestDirectory $RequestId
    $Request = Get-NapCatQrRequest $Directory $RequestId $RequestSha256 $Desktop -Historical:($Mode -eq 'Inspect')
    if ($Mode -eq 'Worker') {
      $null = Invoke-NapCatQrWorker $Directory $Request $Desktop $Entry $GuardPath $IdentityPath $LegacyPath { Assert-NapCatQrIndependentWorker }
      return
    }
    Get-NapCatQrOutcome $Directory $Request | ConvertTo-Json -Compress
    return
  }
  if ($RequestId -or $RequestSha256) { throw 'explicit_start_cannot_replay_a_request' }
  $Config = Get-NapCatQrConfig $ConfigPath $Desktop 'manualQrEnabled'
  $Paths = Get-NapCatQrTargetPaths $Config.value $LegacyPath
  if ($Mode -eq 'Inspect') {
    @{ status='interactive_config_approved'; submitted=$false; desktopWorkerStatus=(Get-NapCatQrWorkerLaunchState) } | ConvertTo-Json -Compress
    return
  }
  if (-not [IO.File]::Exists($GuardPath)) { throw 'guard_unavailable' }
  $GuardSha = (Read-NapCatQrFile $GuardPath 524288).sha
  . $GuardPath
  . $IdentityPath
  $ProfileMutex = Get-NapCatOfflineQqMutexName -QqUserDataDir $Paths.qqUserDataDir
  if ($ProfileMutex -cnotmatch '^Global\\CodexNapCatQqLogin-[A-F0-9]{64}$') { throw 'profile_unverified' }
  $TargetDirectory = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'Temp',
    ('napcat-manual-target-' + $ProfileMutex.Substring($ProfileMutex.Length-64)))
  Start-NapCatQrTargetSubmission $TargetDirectory $Desktop {
    param($SupersededOffline,$UncertainRequestId)
    $Id = [Guid]::NewGuid().ToString('N')
    $Directory = Get-NapCatQrRequestDirectory $Id
    $Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $Value = @{
      schema='napcat.manual-qr/v1'; id=$Id; sid=$Desktop.sid; sessionId=$Desktop.sessionId; explorerId=$Desktop.explorerId
      requesterPid=$PID; requesterBirth=$Desktop.birth; createdAt=$Now; deadlineAt=$Now+45000
      configPath=$Config.path; configSha=$Config.sha; bindingSha=$Config.bindingSha; entrySha=(Read-NapCatQrFile $Entry 524288).sha
      guardSha=$GuardSha; identitySha=(Read-NapCatQrFile $IdentityPath 524288).sha; loginSha=$Config.value.loginSha256
      deploymentSha=(Read-NapCatQrFile ([IO.Path]::Combine($Paths.accountStateDir,'deployment.json')) 524288).sha
    }
    if ($UncertainRequestId) { $Value.supersedesRequestId = $UncertainRequestId }
    if ($null -ne $SupersededOffline) { $Value.supersededOffline = $SupersededOffline }
    New-NapCatQrRequestDirectory $Directory $Desktop.sid
    Write-NapCatQrRecord $Directory 'request' $Value
    return @{ directory=$Directory; request=(Get-NapCatQrRequest $Directory $Id '' $Desktop) }
  } {
    param($Original)
    Start-NapCatQrNativeWorker $Entry $Original.value.id $Original.sha
  } $WaitSeconds -SupersedeRequestId $SupersedeRequestId -ConfirmRetirement {
    param($Original,$Commit,$PriorOutcome)
    Invoke-NapCatQrRetirement $Original $Commit $Config $Paths {
      Assert-NapCatQrIndependentWorker
      $CurrentDesktop = Get-NapCatQrDesktopIdentity
      if ($CurrentDesktop.sid -cne $Desktop.sid -or $CurrentDesktop.sessionId -ne $Desktop.sessionId -or
          $CurrentDesktop.explorerId -ne $Desktop.explorerId) { throw 'interactive_desktop_changed' }
      $CurrentConfig = Get-NapCatQrConfig $Config.path $CurrentDesktop 'manualQrEnabled'
      if ($CurrentConfig.sha -cne $Config.sha -or $CurrentConfig.bindingSha -cne $Config.bindingSha) { throw 'input_fingerprint_changed' }
    } -PriorOutcome $PriorOutcome
  } | ConvertTo-Json -Compress
} catch {
  $Reason = $_.Exception.Message
  if ($Reason -cnotmatch '^[a-z][a-z0-9_]{0,90}$') { $Reason = 'manual_qr_precondition_unverified' }
  $ReferencedId = if ($RequestId) { $RequestId } else { $SupersedeRequestId }
  @{ status=$Reason; requestId=$ReferencedId } | ConvertTo-Json -Compress
  exit 1
}
