using System;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

internal static class WindowsAgentRunner
{
    private const int MaximumRequestChars = 131072;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumRequestChars, RecursionLimit = 12 };

    public static int Main(string[] args)
    {
        bool executionDispatched = false;
        try
        {
            Console.InputEncoding = new UTF8Encoding(false, true);
            Console.OutputEncoding = new UTF8Encoding(false, true);
            if (args.Length == 1 && args[0] == "--capabilities") return Capabilities();
            if (args.Length != 0 || !Console.IsInputRedirected) return Failure("RUNNER_INPUT_INVALID");
            Dictionary<string, object> request = ReadRequest();
            object version;
            object operation;
            if (!request.TryGetValue("protocolVersion", out version) || !(version is int) || (int)version != 1) return Failure("RUNNER_PROTOCOL_UNSUPPORTED");
            if (!request.TryGetValue("operation", out operation) || !(operation is string)) return Failure("RUNNER_INPUT_INVALID");
            if ((string)operation == "capabilities") return Capabilities();
            if ((string)operation == "run")
            {
                object developmentOnly;
                if (!request.TryGetValue("developmentOnly", out developmentOnly) || !(developmentOnly is bool) || !(bool)developmentOnly) return Failure("COMMAND_CAPABILITY_UNAVAILABLE");
                executionDispatched = true;
                return RestrictedAgentExecution.Run(request);
            }
            if ((string)operation == "status") return RestrictedAgentExecution.Status(request);
            if ((string)operation == "inspect-acl") return RestrictedAgentExecution.InspectAcl(request);
            return Failure("RUNNER_OPERATION_UNSUPPORTED");
        }
        catch (Exception) { return Failure(executionDispatched ? "RUNNER_RESULT_UNAVAILABLE" : "RUNNER_INPUT_INVALID", executionDispatched); }
    }

    private static object CapabilityData()
    {
        return new
        {
            protocolVersion = 1,
            available = false,
            commandCapability = "controlled_files_only",
            reason = "Production command acceptance is pending. Explicit development-only launches diagnose initialization; control-material read protection, server-side authorization and write-boundary acceptance remain required.",
            reads = "os-user-access-without-directory-allowlist",
            networkPolicy = "allow",
            writes = "agent-file-commit-only",
            ordinaryProcessFallback = false,
            processCreationImplemented = true,
            productionAcceptance = "pending",
            observedBlocker = new { stage = "child_process_initialization", ntStatus = "0xC0000142", requirement = "normal-command-body-and-complete-production-security-acceptance" },
            productionBlockingRequirements = new[] { "protected-control-material-and-process-objects", "broker-side-agent-authorization", "approved-write-boundary-acceptance" },
            developmentExecution = "requires-explicit-developmentOnly-true-in-native-request",
            nativeOperations = new[] { "run", "status", "inspect-acl" },
            controlTransport = "stdin-ndjson-with-open-parent-channel",
            outputTransport = "one-final-json-with-base64-command-output",
            restrictingSidSet = "task-and-current-logon",
            restrictingSidCount = 2,
            developmentLowIntegritySidSet = "task-current-logon-and-world",
            developmentLowIntegritySidCount = 3,
            jobObject = new
            {
                implemented = true,
                normalUseVerified = false,
                requiredLimits = new[] { "JOB_OBJECT_LIMIT_JOB_MEMORY", "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE" },
                requiredLaunchOrder = new[] { "restricted-token-and-approved-root-acls", "non-default-owned-desktop", "private-temp-and-clean-environment", "inherited-handle-allowlist", "create-suspended", "assign-job", "resume" },
                requiredCleanup = new[] { "terminate-job-on-cancel-or-deadline", "confirm-zero-active-processes", "close-job-on-owner-exit", "restore-only-owned-acl-entries", "close-owned-desktop-and-window-station" }
            },
            commandStarted = false,
            cleanupState = "released"
        };
    }

    private static int Capabilities()
    {
        Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = true, data = CapabilityData() }));
        Console.Out.Flush();
        return 0;
    }

    private static int Failure(string code, bool mayHaveStarted = false)
    {
        try
        {
            object details = mayHaveStarted ? (object)new { commandStarted = (bool?)null, cleanupState = "unresolved", commandCapability = "controlled_files_only" } : CapabilityData();
            Console.Out.WriteLine(Json.Serialize(new
            {
                protocolVersion = 1,
                ok = false,
                error = new
                {
                    code = code,
                    message = "Agent command execution is unavailable; controlled file operations remain available.",
                    retryable = false,
                    mayHaveStarted = mayHaveStarted,
                    details = details
                }
            }));
            Console.Out.Flush();
        }
        catch (Exception) { }
        return 1;
    }

    private static Dictionary<string, object> ReadRequest()
    {
        StringBuilder buffer = new StringBuilder();
        int count;
        while ((count = Console.In.Read()) >= 0)
        {
            if (count == '\n') break;
            if (buffer.Length >= MaximumRequestChars) throw new InvalidDataException();
            buffer.Append((char)count);
        }
        Dictionary<string, object> request = Json.DeserializeObject(buffer.ToString()) as Dictionary<string, object>;
        if (request == null) throw new InvalidDataException();
        return request;
    }
}

internal static class RestrictedAgentExecution
{
    private const uint ReadControl = 0x00020000;
    private const uint WriteDacl = 0x00040000;
    private const uint OpenReparse = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint AttributeDirectory = 0x10;
    private const uint AttributeReparse = 0x400;
    private const int GrantMask = 0x001301ff;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024, RecursionLimit = 24 };

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public uint X;
        public uint Y;
        public uint Width;
        public uint Height;
        public uint XChars;
        public uint YChars;
        public uint FillAttribute;
        public uint Flags;
        public short ShowWindow;
        public short ReservedLength;
        public IntPtr ReservedBytes;
        public IntPtr Stdin;
        public IntPtr Stdout;
        public IntPtr Stderr;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr Process; public IntPtr Thread; public uint ProcessId; public uint ThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime;
        public long JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet;
        public UIntPtr MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong ReadOperations; public ulong WriteOperations; public ulong OtherOperations; public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory;
        public UIntPtr JobMemory;
        public UIntPtr PeakProcessMemory;
        public UIntPtr PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccounting
    {
        public long UserTime;
        public long KernelTime;
        public long PeriodUserTime;
        public long PeriodKernelTime;
        public uint PageFaults;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CompletionAssociation { public IntPtr Key; public IntPtr Port; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low; public uint High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdentity
    {
        public uint Attributes;
        public FileTime Created;
        public FileTime Accessed;
        public FileTime Written;
        public uint Volume;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
        internal string Id { get { return Volume.ToString("x8", CultureInfo.InvariantCulture) + ":" + IndexHigh.ToString("x8", CultureInfo.InvariantCulture) + IndexLow.ToString("x8", CultureInfo.InvariantCulture); } }
    }

    private sealed class RunnerFault : Exception
    {
        internal readonly string Stage;
        internal readonly int Win32Code;
        internal RunnerFault(string stage, int win32Code) { Stage = stage; Win32Code = win32Code; }
    }

    private sealed class RootGrant
    {
        internal string Path;
        internal SafeFileHandle Handle;
        internal string Identity;
        internal string Before;
        internal string Applied;
        internal Mutex Mutex;
        internal bool Locked;
        internal bool Granted;
        internal bool Restored;
        internal bool Conflict;
        internal byte[] BeforeLabel;
        internal byte[] AppliedLabel;
        internal bool LabelChanged;
        internal bool LabelRestored;
        internal bool DeleteDenyAdded;
    }

    private sealed class Configuration
    {
        internal string ResourceId;
        internal string Application;
        internal string[] Arguments;
        internal string Cwd;
        internal string[] Roots;
        internal string ControlRoot;
        internal string ApprovalId;
        internal string DesktopMode;
        internal bool DiagnosticTrace;
        internal bool LowIntegrity;
        internal string LowLabelApprovalId;
        internal int MemoryMb;
        internal int TimeoutMs;
        internal int LeaseMs;
        internal int OutputLimit;
        internal byte[] Input;
    }

    private sealed class RunState
    {
        internal Configuration Config;
        internal SecurityIdentifier TaskSid;
        internal string PrivateRoot;
        internal string LedgerPath;
        internal string TempRoot;
        internal string TempIdentity;
        internal string Phase = "preparing";
        internal readonly List<RootGrant> Grants = new List<RootGrant>();
        internal bool Started;
        internal bool Terminal;
        internal bool AclRestored;
        internal bool AclConflict;
        internal string CleanupState = "unresolved";
        internal uint ProcessId;
        internal string CreatedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
        internal string StopReason;
        internal uint ExitCode;
        internal ulong PeakBytes;
        internal uint PeakActiveProcesses;
        internal uint TotalProcesses;
        internal string ErrorStage;
        internal int ErrorCode;
        internal object InitializationPermissions;
        internal object StartupObjectResult;
        internal readonly List<object> DebugEvents = new List<object>();
        internal bool DebugEventsTruncated;
        internal bool DebugExited;
        internal long LeaseUntil;
        internal volatile bool Cancel;
        internal volatile bool StopControl;
        internal readonly object LedgerLock = new object();
    }

    private sealed class Capture
    {
        internal readonly MemoryStream Output = new MemoryStream();
        internal readonly MemoryStream Error = new MemoryStream();
        internal readonly object Gate = new object();
        internal int Remaining;
        internal bool Truncated;
        internal bool ReadFailed;
        internal long TotalBytes;
    }

    [DllImport("advapi32.dll", EntryPoint = "OpenProcessToken", SetLastError = true)] private static extern bool OpenToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, IntPtr disabled, uint removedCount, IntPtr removed, uint restrictedCount, IntPtr restricted, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returned);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool SetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool IsTokenRestricted(IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool RevertToSelf();
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder commandLine, ref SecurityAttributes processAttributes, ref SecurityAttributes threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint GetSecurityInfo(SafeFileHandle handle, int objectType, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern uint SetSecurityInfo(SafeFileHandle handle, int objectType, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileIdentity information);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetVolumeInformation(string root, StringBuilder name, uint nameLength, out uint serial, out uint maxLength, out uint flags, StringBuilder fileSystem, uint fsLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveType(string root);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, IntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out IntPtr key, out IntPtr overlapped, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenEvent(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WaitForDebugEvent(IntPtr debugEvent, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ContinueDebugEvent(uint processId, uint threadId, uint status);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint DebugFilePath(IntPtr file, StringBuilder path, uint length, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes attributes);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowStation(string name, uint flags, uint access, ref SecurityAttributes attributes);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint returned);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetUserObjectSecurity(IntPtr handle, ref uint requested, IntPtr descriptor, uint length, out uint returned);

    internal static int Run(Dictionary<string, object> request)
    {
        RunState state = new RunState();
        Capture capture = new Capture();
        IntPtr token = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr completionPort = IntPtr.Zero;
        IntPtr desktop = IntPtr.Zero;
        IntPtr windowStation = IntPtr.Zero;
        IntPtr descriptor = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        IntPtr stderrWrite = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        Thread outputReader = null;
        Thread errorReader = null;
        Thread inputWriter = null;
        bool attributesInitialized = false;
        bool jobAssigned = false;
        try
        {
            state.Config = Parse(request);
            capture.Remaining = state.Config.OutputLimit;
            state.TaskSid = NewTaskSid();
            PreparePrivateRoot(state);
            foreach (string root in state.Config.Roots) state.Grants.Add(PrepareRoot(root, state.Config.LowIntegrity));
            WriteLedger(state);
            foreach (RootGrant root in state.Grants)
            {
                ApplyGrant(state, root);
                WriteLedger(state);
                if (state.Config.LowIntegrity)
                {
                    root.LabelChanged = true;
                    root.AppliedLabel = LowMandatoryLabel(true);
                    WriteLedger(state);
                    WriteMandatoryLabel(root.Handle, root.AppliedLabel);
                    root.AppliedLabel = ReadMandatoryLabel(root.Handle);
                    WriteLedger(state);
                }
            }
            state.TempRoot = Path.Combine(state.Config.Roots[0], ".sandbox-agent-temp-" + state.Config.ResourceId);
            if (Directory.Exists(state.TempRoot) || File.Exists(state.TempRoot)) throw new RunnerFault("private_temp_exists", 0);
            Directory.CreateDirectory(state.TempRoot, PrivateDirectorySecurity(state.TaskSid, state.Config.LowIntegrity));
            using (SafeFileHandle temp = OpenIdentity(state.TempRoot, false)) state.TempIdentity = Identity(temp).Id;
            WriteLedger(state);
            token = RestrictedToken(state.TaskSid, state.Config.LowIntegrity);
            if (state.Config.DiagnosticTrace) state.StartupObjectResult = VerifyOwnedStartupObject(token, state.Config.ResourceId);
            descriptor = SecurityDescriptor(state.TaskSid, state.Config.LowIntegrity);
            SecurityAttributes security = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = false };
            IntPtr originalStation = GetProcessWindowStation();
            if (originalStation == IntPtr.Zero) ThrowWin32("own_window_station");
            StringBuilder stationName = new StringBuilder(256);
            uint stationNameBytes;
            string desktopName = "SandboxAgent-" + state.Config.ResourceId;
            if (state.Config.DesktopMode == "private_station")
            {
                windowStation = CreateWindowStation("SandboxAgent-" + state.Config.ResourceId, 1, 0x10000000, ref security);
                if (windowStation == IntPtr.Zero) ThrowWin32("private_window_station");
                if (!GetUserObjectInformation(windowStation, 2, stationName, (uint)(stationName.Capacity * 2), out stationNameBytes)) ThrowWin32("private_window_station_name");
                try
                {
                    if (!SetProcessWindowStation(windowStation)) ThrowWin32("select_private_window_station");
                    desktop = CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, ref security);
                    if (desktop == IntPtr.Zero) ThrowWin32("private_desktop");
                }
                finally { if (!SetProcessWindowStation(originalStation)) ThrowWin32("restore_own_window_station"); }
            }
            else
            {
                if (!GetUserObjectInformation(originalStation, 2, stationName, (uint)(stationName.Capacity * 2), out stationNameBytes)) ThrowWin32("inherited_window_station_name");
                desktop = CreateDesktop(desktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x10000000, ref security);
                if (desktop == IntPtr.Zero) ThrowWin32("private_desktop");
            }
            state.InitializationPermissions = new { station = UserObjectPermissions(windowStation == IntPtr.Zero ? originalStation : windowStation, state.TaskSid), privateDesktop = UserObjectPermissions(desktop, state.TaskSid) };
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowWin32("create_job");
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000 | 0x200 | 0x8;
            limits.Basic.ActiveProcessLimit = 32;
            limits.JobMemory = new UIntPtr(checked((ulong)state.Config.MemoryMb * 1024UL * 1024UL));
            SetJob(job, 9, limits);
            completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
            if (completionPort == IntPtr.Zero) ThrowWin32("create_completion_port");
            SetJob(job, 7, new CompletionAssociation { Key = IntPtr.Zero, Port = completionPort });
            security.Inherit = true;
            if (!CreatePipe(out stdinRead, out stdinWrite, ref security, 0) || !CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0) || !CreatePipe(out stderrRead, out stderrWrite, ref security, 0)) ThrowWin32("stdio_pipes");
            if (!SetHandleInformation(stdinWrite, 1, 0) || !SetHandleInformation(stdoutRead, 1, 0) || !SetHandleInformation(stderrRead, 1, 0)) ThrowWin32("stdio_parent_handles");
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, stdinRead);
            Marshal.WriteIntPtr(handles, IntPtr.Size, stdoutWrite);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderrWrite);
            IntPtr attributeSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
            if (attributeSize == IntPtr.Zero) ThrowWin32("attribute_list_size");
            attributes = Marshal.AllocHGlobal(attributeSize);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)) ThrowWin32("attribute_list_init");
            attributesInitialized = true;
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) ThrowWin32("handle_allowlist");
            StartupInfoEx startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.Startup.Desktop = stationName.ToString() + "\\" + desktopName;
            startup.Startup.Flags = 0x100;
            startup.Startup.Stdin = stdinRead;
            startup.Startup.Stdout = stdoutWrite;
            startup.Startup.Stderr = stderrWrite;
            startup.Attributes = attributes;
            environment = EnvironmentBlock(state.Config, state.TempRoot);
            security.Inherit = false;
            StringBuilder commandLine = new StringBuilder(Quote(state.Config.Application));
            foreach (string argument in state.Config.Arguments) commandLine.Append(' ').Append(Quote(argument));
            if (commandLine.Length >= 32760) throw new RunnerFault("command_line_limit", 0);
            if (GetConsoleWindow() != IntPtr.Zero) throw new RunnerFault("controller_console_must_be_unattached", 0);
            uint creationFlags = 0x00080000 | 0x00000400 | 4;
            if (state.Config.DiagnosticTrace) creationFlags |= 2;
            if (!CreateProcessAsUser(token, state.Config.Application, commandLine, ref security, ref security, true, creationFlags, environment, state.Config.Cwd, ref startup, out process)) ThrowWin32("create_restricted_process");
            state.ProcessId = process.ProcessId;
            if (!AssignProcessToJobObject(job, process.Process)) ThrowWin32("assign_job");
            jobAssigned = true;
            bool inJob;
            if (!IsProcessInJob(process.Process, job, out inJob) || !inJob) ThrowWin32("confirm_job_assignment");
            Close(ref stdinRead);
            Close(ref stdoutWrite);
            Close(ref stderrWrite);
            outputReader = StartReader(stdoutRead, capture, false);
            stdoutRead = IntPtr.Zero;
            errorReader = StartReader(stderrRead, capture, true);
            stderrRead = IntPtr.Zero;
            inputWriter = StartInput(stdinWrite, state.Config.Input);
            stdinWrite = IntPtr.Zero;
            state.Phase = "suspended_in_job";
            WriteLedger(state);
            Interlocked.Exchange(ref state.LeaseUntil, DateTime.UtcNow.AddMilliseconds(state.Config.LeaseMs).Ticks);
            StartControlReader(state);
            if (ResumeThread(process.Thread) == UInt32.MaxValue) ThrowWin32("resume_restricted_process");
            state.Started = true;
            state.Phase = "running";
            WriteLedger(state);
            Monitor(state, process.Process, job, completionPort);
        }
        catch (RunnerFault fault) { state.ErrorStage = fault.Stage; state.ErrorCode = fault.Win32Code; }
        catch (Exception) { state.ErrorStage = "runner_internal_failure"; }
        finally
        {
            state.StopControl = true;
            if (process.Process != IntPtr.Zero)
            {
                if (jobAssigned)
                {
                    if (!state.Terminal) TerminateJobObject(job, 130);
                    state.Terminal = WaitEmpty(job, 5000, state);
                }
                else
                {
                    TerminateProcess(process.Process, 130);
                    state.Terminal = WaitForSingleObject(process.Process, 5000) == 0;
                }
            }
            else { state.Terminal = true; }
            Close(ref stdinRead); Close(ref stdinWrite); Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite);
            Close(ref process.Thread); Close(ref process.Process); Close(ref job); Close(ref completionPort); Close(ref token);
            bool streamsReleased = Join(outputReader) & Join(errorReader) & Join(inputWriter);
            if (capture.ReadFailed && state.ErrorStage == null) state.ErrorStage = "output_capture_failed";
            bool desktopReleased = desktop == IntPtr.Zero || CloseDesktop(desktop);
            bool stationReleased = windowStation == IntPtr.Zero || CloseWindowStation(windowStation);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (descriptor != IntPtr.Zero) Marshal.FreeHGlobal(descriptor);
            bool tempReleased = state.Terminal && ReleaseTemp(state);
            state.AclRestored = true;
            for (int index = state.Grants.Count - 1; index >= 0; index--)
            {
                RootGrant root = state.Grants[index];
                try { if (root.LabelChanged) RestoreOwnedLabels(root); }
                catch (Exception) { state.AclRestored = false; }
                try { if (root.Granted) RestoreGrant(root, state.TaskSid); }
                catch (Exception) { state.AclRestored = false; }
                if ((root.Granted && !root.Restored) || (root.LabelChanged && !root.LabelRestored)) state.AclRestored = false;
                state.AclConflict |= root.Conflict;
                if (root.Handle != null) root.Handle.Dispose();
                if (root.Locked) root.Mutex.ReleaseMutex();
                if (root.Mutex != null) root.Mutex.Dispose();
            }
            state.CleanupState = state.Terminal && state.AclRestored && !state.AclConflict && streamsReleased && desktopReleased && stationReleased && tempReleased ? "released" : "unresolved";
            state.Phase = state.ErrorStage == null ? "finished" : "failed";
            try { if (state.LedgerPath != null) WriteLedger(state); }
            catch (Exception) { state.CleanupState = "unresolved"; }
        }
        object data = new
        {
            resourceId = state.Config == null ? null : state.Config.ResourceId,
            developmentOnly = true,
            productionAcceptance = "pending",
            commandStarted = state.Started,
            processId = state.ProcessId,
            childExitCode = state.Started ? (uint?)state.ExitCode : null,
            stopReason = state.StopReason,
            terminalConfirmed = state.Terminal,
            cleanupState = state.CleanupState,
            aclRestored = state.AclRestored,
            aclConflict = state.AclConflict,
            peakMemoryBytes = state.PeakBytes,
            peakActiveProcesses = state.PeakActiveProcesses,
            totalProcesses = state.TotalProcesses,
            stdoutBase64 = Convert.ToBase64String(capture.Output.ToArray()),
            stderrBase64 = Convert.ToBase64String(capture.Error.ToArray()),
            outputTruncated = capture.Truncated,
            outputReadFailed = capture.ReadFailed,
            totalOutputBytes = capture.TotalBytes,
            receiptPath = state.LedgerPath,
            stage = state.ErrorStage,
            win32Code = state.ErrorCode,
            commandCapability = state.Started ? "write_restricted_job" : "controlled_files_only",
            ordinaryProcessFallback = false,
            tokenFlags = state.Started ? 13 : 0,
            restrictingSidSet = state.Started ? (state.Config.LowIntegrity ? "task-current-logon-and-world" : "task-and-current-logon") : null,
            restrictingSidCount = state.Started ? (state.Config.LowIntegrity ? 3 : 2) : 0,
            integrityLevel = state.Started && state.Config.LowIntegrity ? "low" : null,
            lowLabelsRestored = state.AclRestored && state.Config != null && state.Config.LowIntegrity,
            defaultObjectDaclPrincipal = state.Started ? "current_logon" : null,
            consoleMode = "unattached-controller-piped-stdio",
            desktopMode = state.Config == null ? null : state.Config.DesktopMode,
            windowStationOwned = windowStation != IntPtr.Zero,
            windowStationAclChanged = false,
            defaultDesktopAclChanged = false,
            initializationPermissions = state.InitializationPermissions,
            startupObjectResult = state.StartupObjectResult,
            diagnosticTrace = state.Config != null && state.Config.DiagnosticTrace,
            debugEvents = state.DebugEvents,
            debugEventsTruncated = state.DebugEventsTruncated,
            jobAssigned = jobAssigned,
            inheritedHandleCount = state.Started ? 3 : 0,
            cleanEnvironment = state.Started,
            activeProcessesAtRelease = state.Terminal ? (int?)0 : null
        };
        bool ok = state.ErrorStage == null && state.CleanupState == "released";
        Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = ok, data = data, error = ok ? null : new { code = state.Started ? "COMMAND_EXECUTION_FAILED" : "COMMAND_CAPABILITY_UNAVAILABLE", message = "Restricted command setup or cleanup did not complete.", retryable = false, mayHaveStarted = state.Started, details = data } }));
        Console.Out.Flush();
        return ok ? 0 : 1;
    }

    internal static int Status(Dictionary<string, object> request)
    {
        try
        {
            string root = Canonical(Text(request, "controlRoot"));
            string resourceId = Uuid(Text(request, "resourceId"));
            string path = Path.Combine(root, "agent-run-" + resourceId, "ledger.json");
            RequirePlainPath(path);
            if (new FileInfo(path).Length > 262144) throw new RunnerFault("ledger_size", 0);
            object receipt = Json.DeserializeObject(File.ReadAllText(path, Utf8));
            Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = true, data = receipt }));
            return 0;
        }
        catch (Exception)
        {
            Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = false, error = new { code = "RESOURCE_UNRESOLVED", message = "The original command receipt is unavailable.", retryable = false, mayHaveStarted = true } }));
            return 1;
        }
    }

    internal static int InspectAcl(Dictionary<string, object> request)
    {
        try
        {
            string[] paths = TextArray(request, "paths", 64, false);
            object sidObject;
            SecurityIdentifier sid = request.TryGetValue("taskSid", out sidObject) ? new SecurityIdentifier(sidObject as string) : null;
            List<object> result = new List<object>();
            foreach (string raw in paths)
            {
                string path = Canonical(raw);
                RequirePlainPath(path);
                using (SafeFileHandle handle = OpenIdentity(path, false))
                {
                    RawSecurityDescriptor descriptor = ReadDescriptor(handle);
                    bool present = false;
                    if (descriptor.DiscretionaryAcl != null)
                    {
                        foreach (GenericAce generic in descriptor.DiscretionaryAcl)
                        {
                            QualifiedAce ace = generic as QualifiedAce;
                            if (sid != null && ace != null && ace.SecurityIdentifier == sid) present = true;
                        }
                    }
                    byte[] label = ReadMandatoryLabel(handle);
                    result.Add(new { path = path, daclSha256 = Sha(Utf8.GetBytes(descriptor.GetSddlForm(AccessControlSections.Access))), taskSidPresent = present, mandatoryLabel = MandatoryLabelSummary(label) });
                }
            }
            Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = true, data = new { paths = result } }));
            return 0;
        }
        catch (Exception)
        {
            Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = false, error = new { code = "ACL_INSPECTION_UNAVAILABLE", message = "The requested ACL metadata could not be inspected.", retryable = false, mayHaveStarted = false } }));
            return 1;
        }
    }

    private static Configuration Parse(Dictionary<string, object> request)
    {
        string[] allowed = { "protocolVersion", "operation", "developmentOnly", "resourceId", "application", "args", "cwd", "writeRoots", "approvedAclRoots", "aclApprovalId", "controlRoot", "desktopMode", "diagnosticTrace", "integrityMode", "lowLabelApprovalId", "maxMemoryMB", "timeoutMs", "leaseMs", "maxOutputBytes", "stdinBase64" };
        foreach (string key in request.Keys) if (Array.IndexOf(allowed, key) < 0) throw new RunnerFault("request_field", 0);
        Configuration config = new Configuration();
        config.ResourceId = Uuid(Text(request, "resourceId"));
        config.Application = Canonical(Text(request, "application"));
        config.Arguments = TextArray(request, "args", 256, true);
        config.Cwd = Canonical(Text(request, "cwd"));
        config.Roots = TextArray(request, "writeRoots", 16, false);
        string[] approved = TextArray(request, "approvedAclRoots", 16, false);
        if (approved.Length != config.Roots.Length) throw new RunnerFault("acl_approval_roots", 0);
        for (int index = 0; index < config.Roots.Length; index++)
        {
            config.Roots[index] = Canonical(config.Roots[index]);
            approved[index] = Canonical(approved[index]);
            if (!String.Equals(config.Roots[index], approved[index], StringComparison.OrdinalIgnoreCase)) throw new RunnerFault("acl_approval_roots", 0);
            if (config.Roots[index].Length <= 3) throw new RunnerFault("write_root_scope", 0);
            for (int previous = 0; previous < index; previous++) if (Within(config.Roots[index], config.Roots[previous]) || Within(config.Roots[previous], config.Roots[index])) throw new RunnerFault("overlapping_write_roots", 0);
        }
        config.ControlRoot = Canonical(Text(request, "controlRoot"));
        foreach (string root in config.Roots) if (Within(config.ControlRoot, root) || Within(root, config.ControlRoot)) throw new RunnerFault("control_root_scope", 0);
        config.ApprovalId = Uuid(Text(request, "aclApprovalId"));
        config.DesktopMode = request.ContainsKey("desktopMode") ? Text(request, "desktopMode") : "private_desktop";
        if (config.DesktopMode != "private_desktop" && config.DesktopMode != "private_station") throw new RunnerFault("desktop_mode", 0);
        string integrityMode = request.ContainsKey("integrityMode") ? Text(request, "integrityMode") : "medium";
        if (integrityMode != "medium" && integrityMode != "low") throw new RunnerFault("integrity_mode", 0);
        config.LowIntegrity = integrityMode == "low";
        if (config.LowIntegrity) config.LowLabelApprovalId = Uuid(Text(request, "lowLabelApprovalId"));
        object trace;
        if (request.TryGetValue("diagnosticTrace", out trace))
        {
            if (!(trace is bool)) throw new RunnerFault("diagnostic_trace", 0);
            config.DiagnosticTrace = (bool)trace;
        }
        config.MemoryMb = Number(request, "maxMemoryMB", 256, 16, 4096);
        config.TimeoutMs = Number(request, "timeoutMs", 30000, 100, 3600000);
        config.LeaseMs = Number(request, "leaseMs", 90000, 1000, 90000);
        config.OutputLimit = Number(request, "maxOutputBytes", 1048576, 1024, 1048576);
        object input;
        config.Input = request.TryGetValue("stdinBase64", out input) ? Convert.FromBase64String(input as string ?? "!") : new byte[0];
        if (config.Input.Length > 16384) throw new RunnerFault("stdin_limit", 0);
        if (!Directory.Exists(config.Cwd) || !Directory.Exists(config.ControlRoot) || !File.Exists(config.Application)) throw new RunnerFault("required_path_missing", 0);
        RequirePlainPath(config.Application);
        RequirePlainPath(config.Cwd);
        RequirePlainPath(config.ControlRoot);
        foreach (string root in config.Roots) if (Within(config.Cwd, root)) return config;
        throw new RunnerFault("cwd_scope", 0);
    }

    private static void PreparePrivateRoot(RunState state)
    {
        state.PrivateRoot = Path.Combine(state.Config.ControlRoot, "agent-run-" + state.Config.ResourceId);
        if (Directory.Exists(state.PrivateRoot) || File.Exists(state.PrivateRoot)) throw new RunnerFault("resource_already_exists", 0);
        Directory.CreateDirectory(state.PrivateRoot, PrivateDirectorySecurity(null));
        state.LedgerPath = Path.Combine(state.PrivateRoot, "ledger.json");
    }

    private static RootGrant PrepareRoot(string path, bool lowIntegrity)
    {
        RootGrant root = new RootGrant();
        root.Path = path;
        try
        {
            root.Mutex = new Mutex(false, "Local\\SandboxAgentAcl-" + Sha(Utf8.GetBytes(path.ToUpperInvariant())));
            try { root.Locked = root.Mutex.WaitOne(0); }
            catch (AbandonedMutexException) { root.Locked = true; throw new RunnerFault("acl_recovery_required", 0); }
            if (!root.Locked) throw new RunnerFault("write_root_busy", 0);
            RequirePlainPath(path);
            string drive = Path.GetPathRoot(path);
            uint serial;
            uint maximum;
            uint flags;
            StringBuilder fileSystem = new StringBuilder(64);
            if (GetDriveType(drive) != 3 || !GetVolumeInformation(drive, null, 0, out serial, out maximum, out flags, fileSystem, 64) || fileSystem.ToString() != "NTFS") throw new RunnerFault("root_filesystem", 0);
            root.Handle = OpenIdentity(path, true, lowIntegrity);
            FileIdentity identity = Identity(root.Handle);
            if ((identity.Attributes & AttributeDirectory) == 0 || (identity.Attributes & AttributeReparse) != 0) throw new RunnerFault("root_identity", 0);
            root.Identity = identity.Id;
            root.Before = ReadDescriptor(root.Handle).GetSddlForm(AccessControlSections.Access);
            root.BeforeLabel = ReadMandatoryLabel(root.Handle);
            if (lowIntegrity && root.BeforeLabel.Length != 0) throw new RunnerFault("existing_root_label_unsupported", 0);
            InspectAclCoverage(path, lowIntegrity);
            return root;
        }
        catch
        {
            if (root.Handle != null) root.Handle.Dispose();
            if (root.Locked) root.Mutex.ReleaseMutex();
            if (root.Mutex != null) root.Mutex.Dispose();
            throw;
        }
    }

    private static void InspectAclCoverage(string root, bool requireUnlabelled)
    {
        Stack<string> directories = new Stack<string>();
        directories.Push(root);
        int inspected = 0;
        while (directories.Count > 0)
        {
            foreach (string path in Directory.EnumerateFileSystemEntries(directories.Pop()))
            {
                if (++inspected > 10000) throw new RunnerFault("acl_coverage_limit", 0);
                using (SafeFileHandle handle = OpenIdentity(path, false))
                {
                    FileIdentity identity = Identity(handle);
                    if ((identity.Attributes & AttributeReparse) != 0 || ((identity.Attributes & AttributeDirectory) == 0 && identity.Links != 1)) throw new RunnerFault("acl_path_unsupported", 0);
                    RawSecurityDescriptor descriptor = ReadDescriptor(handle);
                    if ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0) throw new RunnerFault("protected_descendant_acl", 0);
                    if (requireUnlabelled && ReadMandatoryLabel(handle).Length != 0) throw new RunnerFault("existing_descendant_label_unsupported", 0);
                    if ((identity.Attributes & AttributeDirectory) != 0) directories.Push(path);
                }
            }
        }
    }

    private static void ApplyGrant(RunState state, RootGrant root)
    {
        SecurityIdentifier sid = state.TaskSid;
        bool lowIntegrity = state.Config.LowIntegrity;
        RawSecurityDescriptor descriptor = ReadDescriptor(root.Handle);
        if (descriptor.DiscretionaryAcl == null || descriptor.GetSddlForm(AccessControlSections.Access) != root.Before) throw new RunnerFault("acl_changed_before_grant", 0);
        foreach (GenericAce generic in descriptor.DiscretionaryAcl)
        {
            QualifiedAce ace = generic as QualifiedAce;
            if (ace != null && ace.SecurityIdentifier == sid) throw new RunnerFault("task_sid_already_present", 0);
        }
        if (lowIntegrity)
        {
            SecurityIdentifier world = new SecurityIdentifier("S-1-1-0");
            bool existing = false;
            foreach (GenericAce generic in descriptor.DiscretionaryAcl)
            {
                CommonAce ace = generic as CommonAce;
                if (ace != null && ace.SecurityIdentifier == world && ace.AceQualifier == AceQualifier.AccessDenied && ace.AccessMask == 0x40 && ace.AceFlags == (AceFlags.ContainerInherit | AceFlags.ObjectInherit)) existing = true;
            }
            if (!existing)
            {
                descriptor.DiscretionaryAcl.InsertAce(0, new CommonAce(AceFlags.ContainerInherit | AceFlags.ObjectInherit, AceQualifier.AccessDenied, 0x40, world, false, null));
                root.DeleteDenyAdded = true;
            }
        }
        int grantPosition = 0;
        while (grantPosition < descriptor.DiscretionaryAcl.Count && (descriptor.DiscretionaryAcl[grantPosition].AceFlags & AceFlags.Inherited) == 0) grantPosition++;
        descriptor.DiscretionaryAcl.InsertAce(grantPosition, new CommonAce(AceFlags.ContainerInherit | AceFlags.ObjectInherit, AceQualifier.AccessAllowed, GrantMask, sid, false, null));
        root.Granted = true;
        root.Applied = descriptor.GetSddlForm(AccessControlSections.Access);
        WriteLedger(state);
        WriteDescriptor(root.Handle, descriptor);
        if (ReadDescriptor(root.Handle).GetSddlForm(AccessControlSections.Access) != root.Applied) throw new RunnerFault("acl_apply_unverified", 0);
    }

    private static void RestoreGrant(RootGrant root, SecurityIdentifier sid)
    {
        FileIdentity identity = Identity(root.Handle);
        if (identity.Id != root.Identity || (identity.Attributes & AttributeReparse) != 0) throw new RunnerFault("acl_root_identity_changed", 0);
        RawSecurityDescriptor descriptor = ReadDescriptor(root.Handle);
        string current = descriptor.GetSddlForm(AccessControlSections.Access);
        root.Conflict |= root.Applied != null && current != root.Applied;
        bool removed = false;
        bool deleteDenyRemoved = false;
        if (descriptor.DiscretionaryAcl == null) throw new RunnerFault("acl_missing_dacl", 0);
        for (int index = descriptor.DiscretionaryAcl.Count - 1; index >= 0; index--)
        {
            CommonAce ace = descriptor.DiscretionaryAcl[index] as CommonAce;
            if (root.DeleteDenyAdded && !deleteDenyRemoved && ace != null && ace.SecurityIdentifier.Value == "S-1-1-0" && ace.AceQualifier == AceQualifier.AccessDenied && ace.AccessMask == 0x40 && ace.AceFlags == (AceFlags.ContainerInherit | AceFlags.ObjectInherit))
            {
                descriptor.DiscretionaryAcl.RemoveAce(index);
                removed = true;
                deleteDenyRemoved = true;
                continue;
            }
            if (ace == null || ace.SecurityIdentifier != sid) continue;
            if (ace.AceQualifier != AceQualifier.AccessAllowed || ace.AccessMask != GrantMask || ace.AceFlags != (AceFlags.ContainerInherit | AceFlags.ObjectInherit)) { root.Conflict = true; continue; }
            descriptor.DiscretionaryAcl.RemoveAce(index);
            removed = true;
        }
        if (removed) WriteDescriptor(root.Handle, descriptor);
        RawSecurityDescriptor after = ReadDescriptor(root.Handle);
        foreach (GenericAce generic in after.DiscretionaryAcl)
        {
            QualifiedAce ace = generic as QualifiedAce;
            if (ace != null && ace.SecurityIdentifier == sid) throw new RunnerFault("acl_owned_entry_unresolved", 0);
        }
        VerifyGrantRemoved(root.Path, sid);
        root.Restored = true;
    }

    private static void VerifyGrantRemoved(string root, SecurityIdentifier sid)
    {
        Stack<string> directories = new Stack<string>();
        directories.Push(root);
        int inspected = 0;
        while (directories.Count > 0)
        {
            foreach (string path in Directory.EnumerateFileSystemEntries(directories.Pop()))
            {
                if (++inspected > 10000) throw new RunnerFault("acl_cleanup_coverage_limit", 0);
                using (SafeFileHandle handle = OpenIdentity(path, false))
                {
                    FileIdentity identity = Identity(handle);
                    if ((identity.Attributes & AttributeReparse) != 0) throw new RunnerFault("acl_cleanup_path_unverified", 0);
                    RawSecurityDescriptor descriptor = ReadDescriptor(handle);
                    if (descriptor.DiscretionaryAcl == null) throw new RunnerFault("acl_cleanup_dacl_unverified", 0);
                    foreach (GenericAce generic in descriptor.DiscretionaryAcl)
                    {
                        QualifiedAce ace = generic as QualifiedAce;
                        if (ace != null && ace.SecurityIdentifier == sid) throw new RunnerFault("acl_descendant_entry_unresolved", 0);
                    }
                    if ((identity.Attributes & AttributeDirectory) != 0) directories.Push(path);
                }
            }
        }
    }

    private static IntPtr RestrictedToken(SecurityIdentifier sid, bool lowIntegrity)
    {
        IntPtr original = IntPtr.Zero;
        IntPtr token = IntPtr.Zero;
        IntPtr entries = IntPtr.Zero;
        List<IntPtr> sidAllocations = new List<IntPtr>();
        try
        {
            if (!OpenToken(new IntPtr(-1), 0x0001 | 0x0002 | 0x0008 | 0x0080, out original)) ThrowWin32("open_own_token");
            SecurityIdentifier logonSid = CurrentLogonSid(original);
            SecurityIdentifier[] restrictions = lowIntegrity ? new[] { sid, logonSid, new SecurityIdentifier("S-1-1-0") } : new[] { sid, logonSid };
            int entrySize = Marshal.SizeOf(typeof(SidAndAttributes));
            entries = Marshal.AllocHGlobal(entrySize * restrictions.Length);
            for (int index = 0; index < restrictions.Length; index++)
            {
                byte[] binary = new byte[restrictions[index].BinaryLength];
                restrictions[index].GetBinaryForm(binary, 0);
                IntPtr allocation = Marshal.AllocHGlobal(binary.Length);
                sidAllocations.Add(allocation);
                Marshal.Copy(binary, 0, allocation, binary.Length);
                Marshal.StructureToPtr(new SidAndAttributes { Sid = allocation, Attributes = 0 }, IntPtr.Add(entries, index * entrySize), false);
            }
            if (!CreateRestrictedToken(original, 0x1 | 0x4 | 0x8, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrictions.Length, entries, out token)) ThrowWin32("create_write_restricted_token");
            if (!IsTokenRestricted(token)) throw new RunnerFault("confirm_restricted_token", 0);
            ConfirmRestrictingSids(token, restrictions);
            if (CurrentLogonSid(token) != logonSid) throw new RunnerFault("restricted_logon_identity", 0);
            SetDefaultDacl(token, logonSid);
            if (lowIntegrity) LowerTokenIntegrity(token);
            return token;
        }
        catch { Close(ref token); throw; }
        finally
        {
            Close(ref original);
            if (entries != IntPtr.Zero) Marshal.FreeHGlobal(entries);
            foreach (IntPtr allocation in sidAllocations) Marshal.FreeHGlobal(allocation);
        }
    }

    private static SecurityIdentifier CurrentLogonSid(IntPtr token)
    {
        int length;
        GetTokenInformation(token, 2, IntPtr.Zero, 0, out length);
        if (length < 8 || length > 65536) ThrowWin32("own_token_groups_size");
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(token, 2, buffer, length, out length)) ThrowWin32("own_token_groups");
            int count = Marshal.ReadInt32(buffer);
            int entrySize = Marshal.SizeOf(typeof(SidAndAttributes));
            if (count < 1 || count > (length - 8) / entrySize) throw new RunnerFault("own_token_groups_format", 0);
            SecurityIdentifier result = null;
            for (int index = 0; index < count; index++)
            {
                SidAndAttributes group = (SidAndAttributes)Marshal.PtrToStructure(IntPtr.Add(buffer, 8 + index * entrySize), typeof(SidAndAttributes));
                if ((group.Attributes & 0xC0000000U) != 0xC0000000U) continue;
                if (result != null || (group.Attributes & 0x10) != 0 || (group.Attributes & 0x4) == 0) throw new RunnerFault("own_logon_sid_ambiguous", 0);
                result = new SecurityIdentifier(group.Sid);
            }
            if (result == null) throw new RunnerFault("own_logon_sid_missing", 0);
            return result;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void ConfirmRestrictingSids(IntPtr token, SecurityIdentifier[] expected)
    {
        int length;
        GetTokenInformation(token, 11, IntPtr.Zero, 0, out length);
        if (length < 8 || length > 65536) ThrowWin32("restricted_sids_size");
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetTokenInformation(token, 11, buffer, length, out length)) ThrowWin32("restricted_sids_query");
            int count = Marshal.ReadInt32(buffer);
            int entrySize = Marshal.SizeOf(typeof(SidAndAttributes));
            if (count != expected.Length || count > (length - 8) / entrySize) throw new RunnerFault("restricted_sids_count", 0);
            HashSet<string> remaining = new HashSet<string>();
            foreach (SecurityIdentifier sid in expected) remaining.Add(sid.Value);
            for (int index = 0; index < count; index++)
            {
                SidAndAttributes group = (SidAndAttributes)Marshal.PtrToStructure(IntPtr.Add(buffer, 8 + index * entrySize), typeof(SidAndAttributes));
                if (!remaining.Remove(new SecurityIdentifier(group.Sid).Value)) throw new RunnerFault("restricted_sids_mismatch", 0);
            }
            if (remaining.Count != 0) throw new RunnerFault("restricted_sids_mismatch", 0);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void SetDefaultDacl(IntPtr token, SecurityIdentifier sid)
    {
        int length;
        GetTokenInformation(token, 6, IntPtr.Zero, 0, out length);
        if (length < IntPtr.Size || length > 65536) ThrowWin32("default_dacl_size");
        IntPtr buffer = Marshal.AllocHGlobal(length);
        IntPtr aclBytes = IntPtr.Zero;
        IntPtr information = IntPtr.Zero;
        try
        {
            if (!GetTokenInformation(token, 6, buffer, length, out length)) ThrowWin32("default_dacl_read");
            IntPtr existing = Marshal.ReadIntPtr(buffer);
            if (existing == IntPtr.Zero) throw new RunnerFault("default_dacl_missing", 0);
            int aclLength = (ushort)Marshal.ReadInt16(existing, 2);
            byte[] binary = new byte[aclLength];
            Marshal.Copy(existing, binary, 0, aclLength);
            RawAcl acl = new RawAcl(binary, 0);
            acl.InsertAce(acl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x001F01FF, sid, false, null));
            binary = new byte[acl.BinaryLength];
            acl.GetBinaryForm(binary, 0);
            aclBytes = Marshal.AllocHGlobal(binary.Length);
            Marshal.Copy(binary, 0, aclBytes, binary.Length);
            information = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(information, aclBytes);
            if (!SetTokenInformation(token, 6, information, IntPtr.Size)) ThrowWin32("default_dacl_write");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
            if (aclBytes != IntPtr.Zero) Marshal.FreeHGlobal(aclBytes);
            if (information != IntPtr.Zero) Marshal.FreeHGlobal(information);
        }
    }

    private static object VerifyOwnedStartupObject(IntPtr token, string resourceId)
    {
        IntPtr created = IntPtr.Zero;
        IntPtr reopened = IntPtr.Zero;
        bool impersonating = false;
        try
        {
            if (!ImpersonateLoggedOnUser(token)) ThrowWin32("startup_object_own_token");
            impersonating = true;
            string name = "Local\\SandboxAgentStartup-" + resourceId + "-" + Guid.NewGuid().ToString("N");
            created = CreateEvent(IntPtr.Zero, false, false, name);
            if (created == IntPtr.Zero) ThrowWin32("startup_object_create");
            if (Marshal.GetLastWin32Error() == 183) throw new RunnerFault("startup_object_already_exists", 183);
            reopened = OpenEvent(0x00100002, false, name);
            if (reopened == IntPtr.Zero) ThrowWin32("startup_object_reopen");
            if (!SetEvent(reopened)) ThrowWin32("startup_object_update");
            return new { created = true, reopened = true, updated = true, scope = "own-unique-local-event" };
        }
        finally
        {
            if (impersonating && !RevertToSelf()) ThrowWin32("startup_object_restore_own_context");
            Close(ref reopened);
            Close(ref created);
        }
    }

    private static void Monitor(RunState state, IntPtr process, IntPtr job, IntPtr completionPort)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(state.Config.TimeoutMs);
        while (true)
        {
            PumpDebugEvents(state);
            uint message;
            IntPtr key;
            IntPtr overlapped;
            bool memoryLimit = false;
            while (GetQueuedCompletionStatus(completionPort, out message, out key, out overlapped, 0)) if (message == 10) memoryLimit = true;
            state.PeakBytes = Math.Max(state.PeakBytes, QueryJob<ExtendedLimits>(job, 9).PeakJobMemory.ToUInt64());
            SampleProcessAccounting(job, state);
            if (memoryLimit) { state.StopReason = "memory_limit"; state.ExitCode = 137; break; }
            if (state.Cancel) { state.StopReason = "cancelled"; state.ExitCode = 130; break; }
            if (DateTime.UtcNow.Ticks >= Interlocked.Read(ref state.LeaseUntil)) { state.StopReason = "lease_expired"; state.ExitCode = 130; break; }
            if (DateTime.UtcNow >= deadline) { state.StopReason = "timeout"; state.ExitCode = 124; break; }
            uint wait = WaitForSingleObject(process, 25);
            if (wait == 0)
            {
                if (!GetExitCodeProcess(process, out state.ExitCode)) ThrowWin32("read_exit_code");
                state.StopReason = "exited";
                break;
            }
            if (wait != 258) ThrowWin32("wait_process");
        }
        if (!TerminateJobObject(job, state.ExitCode)) ThrowWin32("terminate_owned_job");
        state.Terminal = WaitEmpty(job, 5000, state);
        if (!state.Terminal) throw new RunnerFault("job_release_pending", 0);
    }

    private static void StartControlReader(RunState state)
    {
        Thread reader = new Thread(delegate()
        {
            try
            {
                while (!state.StopControl)
                {
                    StringBuilder line = new StringBuilder();
                    int character;
                    while ((character = Console.In.Read()) >= 0 && character != '\n')
                    {
                        if (line.Length >= 4096) throw new InvalidDataException();
                        line.Append((char)character);
                    }
                    if (character < 0) { state.Cancel = true; return; }
                    Dictionary<string, object> control = new JavaScriptSerializer { MaxJsonLength = 4096, RecursionLimit = 4 }.DeserializeObject(line.ToString()) as Dictionary<string, object>;
                    if (control == null || Text(control, "resourceId") != state.Config.ResourceId) throw new InvalidDataException();
                    string operation = Text(control, "operation");
                    if (operation == "cancel") { state.Cancel = true; return; }
                    if (operation != "renew") throw new InvalidDataException();
                    Interlocked.Exchange(ref state.LeaseUntil, DateTime.UtcNow.AddMilliseconds(state.Config.LeaseMs).Ticks);
                }
            }
            catch (Exception) { state.Cancel = true; }
        });
        reader.IsBackground = true;
        reader.Start();
    }

    private static Thread StartReader(IntPtr handle, Capture capture, bool error)
    {
        Thread reader = new Thread(delegate()
        {
            try
            {
                using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 16384, false))
                {
                    byte[] bytes = new byte[16384];
                    int count;
                    while ((count = stream.Read(bytes, 0, bytes.Length)) > 0)
                    {
                        lock (capture.Gate)
                        {
                            int keep = Math.Min(count, capture.Remaining);
                            (error ? capture.Error : capture.Output).Write(bytes, 0, keep);
                            capture.Remaining -= keep;
                            capture.TotalBytes += count;
                            capture.Truncated |= keep != count;
                        }
                    }
                }
            }
            catch (Exception) { capture.ReadFailed = true; }
        });
        reader.IsBackground = true;
        reader.Start();
        return reader;
    }

    private static Thread StartInput(IntPtr handle, byte[] input)
    {
        Thread writer = new Thread(delegate()
        {
            try { using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Write, 4096, false)) { stream.Write(input, 0, input.Length); stream.Flush(); } }
            catch (Exception) { }
        });
        writer.IsBackground = true;
        writer.Start();
        return writer;
    }

    private static bool Join(Thread thread) { return thread == null || thread.Join(5000); }

    private static void PumpDebugEvents(RunState state)
    {
        if (state.Config == null || !state.Config.DiagnosticTrace || state.ProcessId == 0 || state.DebugExited) return;
        IntPtr buffer = Marshal.AllocHGlobal(256);
        try
        {
            while (WaitForDebugEvent(buffer, 0))
            {
                uint kind = unchecked((uint)Marshal.ReadInt32(buffer, 0));
                uint processId = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                uint threadId = unchecked((uint)Marshal.ReadInt32(buffer, 8));
                if (processId != state.ProcessId) throw new RunnerFault("debug_process_identity", 0);
                uint status = 0x00010002;
                object item;
                if (kind == 1)
                {
                    uint code = unchecked((uint)Marshal.ReadInt32(buffer, 16));
                    bool firstChance = Marshal.ReadInt32(buffer, 168) != 0;
                    item = new { kind = "exception", code = "0x" + code.ToString("x8", CultureInfo.InvariantCulture), firstChance = firstChance, address = Marshal.ReadIntPtr(buffer, 32).ToInt64().ToString("x", CultureInfo.InvariantCulture) };
                    if (code != 0x80000003 && code != 0x80000004) status = 0x80010001;
                }
                else if (kind == 3 || kind == 6)
                {
                    IntPtr file = Marshal.ReadIntPtr(buffer, 16);
                    string name = null;
                    if (file != IntPtr.Zero && file != new IntPtr(-1))
                    {
                        try
                        {
                            StringBuilder path = new StringBuilder(512);
                            uint length = DebugFilePath(file, path, (uint)path.Capacity, 0);
                            if (length > 0 && length < path.Capacity) name = Path.GetFileName(path.ToString());
                        }
                        finally { CloseHandle(file); }
                    }
                    item = new { kind = kind == 3 ? "process_image" : "dll_load", name = name };
                }
                else if (kind == 5)
                {
                    state.DebugExited = true;
                    item = new { kind = "process_exit", code = "0x" + unchecked((uint)Marshal.ReadInt32(buffer, 16)).ToString("x8", CultureInfo.InvariantCulture) };
                }
                else if (kind == 8) item = new { kind = "debug_string_available", characters = (ushort)Marshal.ReadInt16(buffer, 26) };
                else item = new { kind = "event", eventCode = kind };
                if (state.DebugEvents.Count < 128) state.DebugEvents.Add(item);
                else state.DebugEventsTruncated = true;
                if (!ContinueDebugEvent(processId, threadId, status)) ThrowWin32("continue_owned_debug_event");
                if (state.DebugExited) break;
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool WaitEmpty(IntPtr job, int timeoutMs, RunState state)
    {
        if (job == IntPtr.Zero) return true;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        try
        {
            do { PumpDebugEvents(state); if (SampleProcessAccounting(job, state) == 0) return true; Thread.Sleep(20); } while (DateTime.UtcNow < deadline);
        }
        catch (Exception) { }
        return false;
    }

    private static uint SampleProcessAccounting(IntPtr job, RunState state)
    {
        BasicAccounting accounting = QueryJob<BasicAccounting>(job, 1);
        state.PeakActiveProcesses = Math.Max(state.PeakActiveProcesses, accounting.ActiveProcesses);
        state.TotalProcesses = Math.Max(state.TotalProcesses, accounting.TotalProcesses);
        return accounting.ActiveProcesses;
    }

    private static void SetJob<T>(IntPtr job, int informationClass, T value) where T : struct
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(value, buffer, false); if (!SetInformationJobObject(job, informationClass, buffer, (uint)size)) ThrowWin32("job_limits"); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static T QueryJob<T>(IntPtr job, int informationClass) where T : struct
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try { if (!QueryInformationJobObject(job, informationClass, buffer, (uint)size, IntPtr.Zero)) ThrowWin32("query_job"); return (T)Marshal.PtrToStructure(buffer, typeof(T)); }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void WriteLedger(RunState state)
    {
        lock (state.LedgerLock)
        {
            List<object> roots = new List<object>();
            foreach (RootGrant root in state.Grants) roots.Add(new { path = root.Path, identity = root.Identity, beforeDacl = root.Before, appliedDacl = root.Applied, granted = root.Granted, restored = root.Restored, conflict = root.Conflict, deleteDenyAdded = root.DeleteDenyAdded, beforeLabel = root.BeforeLabel == null ? null : Convert.ToBase64String(root.BeforeLabel), appliedLabel = root.AppliedLabel == null ? null : Convert.ToBase64String(root.AppliedLabel), labelChanged = root.LabelChanged, labelRestored = root.LabelRestored });
            string body = Json.Serialize(new { protocolVersion = 1, resourceId = state.Config.ResourceId, controllerProcessId = GetCurrentProcessId(), createdAt = state.CreatedAt, taskSid = state.TaskSid.Value, aclApprovalId = state.Config.ApprovalId, developmentOnly = true, productionAcceptance = "pending", integrityMode = state.Config.LowIntegrity ? "low" : "medium", lowLabelApprovalId = state.Config.LowLabelApprovalId, phase = state.Phase, commandStarted = state.Started, processId = state.ProcessId, terminalConfirmed = state.Terminal, cleanupState = state.CleanupState, aclRestored = state.AclRestored, aclConflict = state.AclConflict, stopReason = state.StopReason, childExitCode = state.ExitCode, peakActiveProcesses = state.PeakActiveProcesses, totalProcesses = state.TotalProcesses, roots = roots, privateTemp = state.TempRoot, privateTempIdentity = state.TempIdentity, initializationPermissions = state.InitializationPermissions, debugEvents = state.DebugEvents, stage = state.ErrorStage, win32Code = state.ErrorCode });
            string staging = Path.Combine(state.PrivateRoot, "ledger-" + Guid.NewGuid().ToString("N") + ".new");
            File.WriteAllText(staging, body, Utf8);
            if (File.Exists(state.LedgerPath)) File.Replace(staging, state.LedgerPath, null);
            else File.Move(staging, state.LedgerPath);
        }
    }

    private static bool ReleaseTemp(RunState state)
    {
        if (state.TempRoot == null) return true;
        try
        {
            using (SafeFileHandle temp = OpenIdentity(state.TempRoot, false))
            {
                FileIdentity identity = Identity(temp);
                if (identity.Id != state.TempIdentity || (identity.Attributes & AttributeReparse) != 0) return false;
            }
            DeleteOwnedDirectory(state.TempRoot);
            return true;
        }
        catch (Exception) { return false; }
    }

    private static void DeleteOwnedDirectory(string path)
    {
        foreach (string entry in Directory.EnumerateFileSystemEntries(path))
        {
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.Directory) != 0)
            {
                if ((attributes & FileAttributes.ReparsePoint) != 0) Directory.Delete(entry, false);
                else DeleteOwnedDirectory(entry);
            }
            else { File.Delete(entry); }
        }
        Directory.Delete(path, false);
    }

    private static IntPtr EnvironmentBlock(Configuration config, string temp)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        SortedDictionary<string, string> values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        values["SystemRoot"] = windows;
        values["WINDIR"] = windows;
        values["COMSPEC"] = Path.Combine(windows, "System32", "cmd.exe");
        values["PATH"] = Path.GetDirectoryName(config.Application) + ";" + Path.Combine(windows, "System32") + ";" + windows + ";" + Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0");
        values["PATHEXT"] = ".COM;.EXE;.BAT;.CMD";
        values["TEMP"] = temp;
        values["TMP"] = temp;
        values["USERPROFILE"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        values["HOME"] = values["USERPROFILE"];
        values["APPDATA"] = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        values["LOCALAPPDATA"] = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        values["PYTHONDONTWRITEBYTECODE"] = "1";
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> value in values) block.Append(value.Key).Append('=').Append(value.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static RawSecurityDescriptor ReadDescriptor(SafeFileHandle handle)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint error = GetSecurityInfo(handle, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new RunnerFault("read_root_dacl", (int)error);
        try
        {
            uint size = GetSecurityDescriptorLength(descriptor);
            if (size == 0 || size > 65536) throw new RunnerFault("root_dacl_size", 0);
            byte[] binary = new byte[size];
            Marshal.Copy(descriptor, binary, 0, (int)size);
            return new RawSecurityDescriptor(binary, 0);
        }
        finally { LocalFree(descriptor); }
    }

    private static byte[] ReadMandatoryLabel(SafeFileHandle handle)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor;
        uint error = GetSecurityInfo(handle, 1, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new RunnerFault("read_mandatory_label", (int)error);
        try { return CopyMandatoryAcl(sacl); }
        finally { LocalFree(descriptor); }
    }

    private static byte[] CopyMandatoryAcl(IntPtr acl)
    {
        if (acl == IntPtr.Zero) return new byte[0];
        int size = (ushort)Marshal.ReadInt16(acl, 2);
        int count = (ushort)Marshal.ReadInt16(acl, 4);
        if (size < 8 || size > 65535) throw new RunnerFault("mandatory_acl_size", 0);
        if (count == 0) return new byte[0];
        byte[] binary = new byte[size];
        Marshal.Copy(acl, binary, 0, size);
        int used = 8;
        for (int index = 0; index < count; index++)
        {
            if (used > size - 8 || binary[used] != 0x11) throw new RunnerFault("mandatory_acl_format", 0);
            int aceSize = BitConverter.ToUInt16(binary, used + 2);
            if (aceSize < 12 || aceSize > size - used) throw new RunnerFault("mandatory_ace_size", 0);
            SecurityIdentifier sid = new SecurityIdentifier(binary, used + 8);
            if (!sid.Value.StartsWith("S-1-16-", StringComparison.Ordinal)) throw new RunnerFault("mandatory_ace_identity", 0);
            used += aceSize;
        }
        byte[] normalized = new byte[used];
        Array.Copy(binary, normalized, used);
        normalized[1] = 0;
        normalized[2] = (byte)used;
        normalized[3] = (byte)(used >> 8);
        normalized[6] = 0;
        normalized[7] = 0;
        return normalized;
    }

    private static object MandatoryLabelSummary(byte[] binary)
    {
        List<object> labels = new List<object>();
        if (binary.Length != 0)
        {
            int offset = 8;
            int count = BitConverter.ToUInt16(binary, 4);
            for (int index = 0; index < count; index++)
            {
                labels.Add(new { sid = new SecurityIdentifier(binary, offset + 8).Value, policy = BitConverter.ToUInt32(binary, offset + 4), flags = binary[offset + 1] });
                offset += BitConverter.ToUInt16(binary, offset + 2);
            }
        }
        return new { present = binary.Length != 0, sha256 = Sha(binary), entries = labels };
    }

    private static byte[] LowMandatoryLabel(bool inherited)
    {
        IntPtr descriptor = IntPtr.Zero;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(inherited ? "S:(ML;OICI;NW;;;LW)" : "S:(ML;;NW;;;LW)", 1, out descriptor, out size)) ThrowWin32("prepare_low_label");
        try
        {
            bool present;
            bool defaulted;
            IntPtr sacl;
            if (!GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted) || !present) ThrowWin32("prepare_low_label_acl");
            return CopyMandatoryAcl(sacl);
        }
        finally { LocalFree(descriptor); }
    }

    private static void WriteMandatoryLabel(SafeFileHandle handle, byte[] label)
    {
        byte[] binary = label;
        if (binary.Length == 0) binary = new byte[] { 2, 0, 8, 0, 0, 0, 0, 0 };
        IntPtr buffer = Marshal.AllocHGlobal(binary.Length);
        try
        {
            Marshal.Copy(binary, 0, buffer, binary.Length);
            uint error = SetSecurityInfo(handle, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, buffer);
            if (error != 0) throw new RunnerFault("write_mandatory_label", (int)error);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void RestoreOwnedLabels(RootGrant root)
    {
        byte[] current = ReadMandatoryLabel(root.Handle);
        if (root.AppliedLabel == null || Sha(current) != Sha(root.AppliedLabel))
        {
            if (root.BeforeLabel == null || Sha(current) != Sha(root.BeforeLabel))
            {
                root.Conflict = true;
                throw new RunnerFault("root_label_changed_externally", 0);
            }
        }
        else WriteMandatoryLabel(root.Handle, root.BeforeLabel);
        Stack<string> directories = new Stack<string>();
        directories.Push(root.Path);
        int inspected = 0;
        while (directories.Count > 0)
        {
            foreach (string path in Directory.EnumerateFileSystemEntries(directories.Pop()))
            {
                if (++inspected > 10000) throw new RunnerFault("label_restore_coverage_limit", 0);
                using (SafeFileHandle handle = OpenIdentity(path, false, true))
                {
                    FileIdentity identity = Identity(handle);
                    if ((identity.Attributes & AttributeReparse) != 0) throw new RunnerFault("label_restore_path_unverified", 0);
                    byte[] label = ReadMandatoryLabel(handle);
                    if (label.Length != 0)
                    {
                        if (BitConverter.ToUInt16(label, 4) != 1 || (label[9] & 0x10) == 0 || new SecurityIdentifier(label, 16).Value != "S-1-16-4096" || BitConverter.ToUInt32(label, 12) != 1) { root.Conflict = true; throw new RunnerFault("descendant_label_changed_externally", 0); }
                        WriteMandatoryLabel(handle, new byte[0]);
                    }
                    if (ReadMandatoryLabel(handle).Length != 0) throw new RunnerFault("descendant_label_restore_unverified", 0);
                    if ((identity.Attributes & AttributeDirectory) != 0) directories.Push(path);
                }
            }
        }
        if (Sha(ReadMandatoryLabel(root.Handle)) != Sha(root.BeforeLabel)) throw new RunnerFault("root_label_restore_unverified", 0);
        root.LabelRestored = true;
    }

    private static void LowerTokenIntegrity(IntPtr token)
    {
        SecurityIdentifier low = new SecurityIdentifier("S-1-16-4096");
        int header = Marshal.SizeOf(typeof(SidAndAttributes));
        int size = header + low.BinaryLength;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            byte[] binary = new byte[low.BinaryLength];
            low.GetBinaryForm(binary, 0);
            IntPtr sid = IntPtr.Add(buffer, header);
            Marshal.Copy(binary, 0, sid, binary.Length);
            Marshal.StructureToPtr(new SidAndAttributes { Sid = sid, Attributes = 0x20 }, buffer, false);
            if (!SetTokenInformation(token, 25, buffer, size)) ThrowWin32("lower_own_restricted_token_integrity");
            Marshal.WriteInt32(buffer, 1);
            if (!SetTokenInformation(token, 27, buffer, 4)) ThrowWin32("restricted_token_no_write_up_policy");
            int returned;
            if (!GetTokenInformation(token, 25, buffer, size, out returned) || returned < header || returned > size) ThrowWin32("restricted_token_integrity_query");
            SidAndAttributes actual = (SidAndAttributes)Marshal.PtrToStructure(buffer, typeof(SidAndAttributes));
            if (new SecurityIdentifier(actual.Sid) != low || (actual.Attributes & 0x20) == 0) throw new RunnerFault("restricted_token_integrity_mismatch", 0);
            if (!GetTokenInformation(token, 27, buffer, size, out returned) || returned != 4) ThrowWin32("restricted_token_policy_query");
            if (Marshal.ReadInt32(buffer) != 1) throw new RunnerFault("restricted_token_policy_mismatch", 0);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static object UserObjectPermissions(IntPtr handle, SecurityIdentifier taskSid)
    {
        uint requested = 4;
        uint length;
        GetUserObjectSecurity(handle, ref requested, IntPtr.Zero, 0, out length);
        if (length == 0 || length > 65536) return new { available = false, win32Code = Marshal.GetLastWin32Error() };
        IntPtr buffer = Marshal.AllocHGlobal((int)length);
        IntPtr ownToken = IntPtr.Zero;
        try
        {
            if (!GetUserObjectSecurity(handle, ref requested, buffer, length, out length)) return new { available = false, win32Code = Marshal.GetLastWin32Error() };
            byte[] bytes = new byte[length];
            Marshal.Copy(buffer, bytes, 0, (int)length);
            RawSecurityDescriptor descriptor = new RawSecurityDescriptor(bytes, 0);
            if (!OpenToken(new IntPtr(-1), 0x8, out ownToken)) ThrowWin32("own_identity_for_initialization");
            SecurityIdentifier logon = CurrentLogonSid(ownToken);
            SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
            List<object> entries = new List<object>();
            if (descriptor.DiscretionaryAcl != null)
            {
                foreach (GenericAce generic in descriptor.DiscretionaryAcl)
                {
                    QualifiedAce ace = generic as QualifiedAce;
                    if (ace == null) continue;
                    string role = ace.SecurityIdentifier == taskSid ? "task" : ace.SecurityIdentifier == logon ? "current_logon" : ace.SecurityIdentifier == user ? "current_user" : ace.SecurityIdentifier.Value == "S-1-1-0" ? "everyone" : ace.SecurityIdentifier.Value == "S-1-5-33" ? "write_restricted_code" : ace.SecurityIdentifier.Value == "S-1-5-12" ? "restricted_code" : "other_system_group";
                    KnownAce known = ace as KnownAce;
                    entries.Add(new { role = role, qualifier = ace.AceQualifier.ToString(), mask = known == null ? 0 : known.AccessMask, flags = ace.AceFlags.ToString() });
                }
            }
            return new { available = true, nullDacl = descriptor.DiscretionaryAcl == null, entries = entries };
        }
        finally { Close(ref ownToken); Marshal.FreeHGlobal(buffer); }
    }

    private static void WriteDescriptor(SafeFileHandle handle, RawSecurityDescriptor descriptor)
    {
        byte[] binary = new byte[descriptor.DiscretionaryAcl.BinaryLength];
        descriptor.DiscretionaryAcl.GetBinaryForm(binary, 0);
        IntPtr buffer = Marshal.AllocHGlobal(binary.Length);
        try
        {
            Marshal.Copy(binary, 0, buffer, binary.Length);
            uint flags = 4 | ((descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? 0x80000000U : 0x20000000U);
            uint error = SetSecurityInfo(handle, 1, flags, IntPtr.Zero, IntPtr.Zero, buffer, IntPtr.Zero);
            if (error != 0) throw new RunnerFault("write_root_dacl", (int)error);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static SafeFileHandle OpenIdentity(string path, bool writeDacl, bool writeLabel = false)
    {
        SafeFileHandle handle = CreateFile(path, ReadControl | 0x80 | (writeDacl ? WriteDacl : 0) | (writeLabel ? 0x00080000U : 0), 1 | 2, IntPtr.Zero, 3, BackupSemantics | OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new RunnerFault(writeDacl ? "root_write_dacl_access" : "path_identity_access", error); }
        return handle;
    }

    private static FileIdentity Identity(SafeFileHandle handle) { FileIdentity identity; if (!GetFileInformationByHandle(handle, out identity)) ThrowWin32("path_identity"); return identity; }

    private static SecurityIdentifier NewTaskSid()
    {
        byte[] bytes = new byte[16];
        using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
        return new SecurityIdentifier("S-1-5-21-" + BitConverter.ToUInt32(bytes, 0).ToString(CultureInfo.InvariantCulture) + "-" + BitConverter.ToUInt32(bytes, 4).ToString(CultureInfo.InvariantCulture) + "-" + BitConverter.ToUInt32(bytes, 8).ToString(CultureInfo.InvariantCulture) + "-" + BitConverter.ToUInt32(bytes, 12).ToString(CultureInfo.InvariantCulture));
    }

    private static DirectorySecurity PrivateDirectorySecurity(SecurityIdentifier sid, bool lowIntegrity = false)
    {
        DirectorySecurity security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        if (user == null) throw new RunnerFault("current_user_identity", 0);
        security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        if (sid != null) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Modify | (lowIntegrity ? 0 : FileSystemRights.DeleteSubdirectoriesAndFiles), InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        if (sid != null && lowIntegrity) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.DeleteSubdirectoriesAndFiles, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Deny));
        return security;
    }

    private static IntPtr SecurityDescriptor(SecurityIdentifier sid, bool lowIntegrity)
    {
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        if (user == null) throw new RunnerFault("current_user_identity", 0);
        IntPtr ownToken = IntPtr.Zero;
        SecurityIdentifier logon;
        try
        {
            if (!OpenToken(new IntPtr(-1), 0x8, out ownToken)) ThrowWin32("own_logon_identity_for_objects");
            logon = CurrentLogonSid(ownToken);
        }
        finally { Close(ref ownToken); }
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor("O:" + user.Value + "G:" + user.Value + "D:P(A;;GA;;;" + user.Value + ")(A;;GA;;;SY)(A;;GA;;;" + sid.Value + ")(A;;GA;;;" + logon.Value + ")" + (lowIntegrity ? "S:(ML;;NW;;;LW)" : ""));
        byte[] binary = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(binary, 0);
        IntPtr result = Marshal.AllocHGlobal(binary.Length);
        Marshal.Copy(binary, 0, result, binary.Length);
        return result;
    }

    private static void RequirePlainPath(string path)
    {
        string current = path;
        while (current != null)
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new RunnerFault("path_unsupported", 0);
            current = Path.GetDirectoryName(current);
        }
    }

    private static string Canonical(string path)
    {
        path = path.Replace('/', '\\');
        if (path.Length > 200 || !Regex.IsMatch(path, "\\A[A-Za-z]:\\\\", RegexOptions.CultureInvariant) || path.IndexOf('\0') >= 0) throw new RunnerFault("path_format", 0);
        foreach (string component in path.Substring(3).Split('\\'))
        {
            if (component.Length == 0 || component == "." || component == ".." || component.EndsWith(".", StringComparison.Ordinal) || component.EndsWith(" ", StringComparison.Ordinal) || component.IndexOfAny(new[] { ':', '*', '?', '"', '<', '>', '|' }) >= 0) throw new RunnerFault("path_format", 0);
        }
        return Path.GetFullPath(path).TrimEnd('\\');
    }

    private static bool Within(string path, string root) { return String.Equals(path, root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase); }
    private static string Text(Dictionary<string, object> request, string name) { object value; string text; if (!request.TryGetValue(name, out value) || (text = value as string) == null || text.Length == 0) throw new RunnerFault("request_" + name, 0); return text; }
    private static string Uuid(string text) { Guid value; if (!Guid.TryParseExact(text, "D", out value)) throw new RunnerFault("request_uuid", 0); return value.ToString("D"); }
    private static int Number(Dictionary<string, object> request, string name, int fallback, int minimum, int maximum) { object value; if (!request.TryGetValue(name, out value)) return fallback; if (!(value is int) || (int)value < minimum || (int)value > maximum) throw new RunnerFault("request_" + name, 0); return (int)value; }
    private static string[] TextArray(Dictionary<string, object> request, string name, int maximum, bool empty)
    {
        object value;
        object[] array;
        if (!request.TryGetValue(name, out value) || (array = value as object[]) == null || array.Length > maximum || (!empty && array.Length == 0)) throw new RunnerFault("request_" + name, 0);
        string[] result = new string[array.Length];
        for (int index = 0; index < array.Length; index++) { result[index] = array[index] as string; if (result[index] == null || result[index].IndexOf('\0') >= 0) throw new RunnerFault("request_" + name, 0); }
        return result;
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"') { result.Append('\\', backslashes * 2 + 1).Append('"'); backslashes = 0; continue; }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        return result.Append('\\', backslashes * 2).Append('"').ToString();
    }

    private static string Sha(byte[] bytes) { using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    private static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    private static void ThrowWin32(string stage) { throw new RunnerFault(stage, Marshal.GetLastWin32Error()); }
}
