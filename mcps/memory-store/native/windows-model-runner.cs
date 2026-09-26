using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsModelRunner
{
    private const uint CREATE_SUSPENDED = 4;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int id);

    private static void Win32(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }

    private static void SetLimits(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)) Win32("SetInformationJobObject");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static uint ActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) Win32("QueryInformationJobObject");
        return info.ActiveProcesses;
    }

    private static bool HasDescendants(IntPtr job, uint parentPid)
    {
        int capacity = 16;
        while (capacity <= 131072)
        {
            int length = checked(8 + capacity * IntPtr.Size);
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)length, IntPtr.Zero))
                {
                    int listed = Marshal.ReadInt32(buffer, 4);
                    if (listed < 0 || listed > capacity) throw new InvalidOperationException("Invalid Job process list");
                    for (int index = 0; index < listed; index++)
                    {
                        long pid = Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
                        if (pid != parentPid) return true;
                    }
                    return false;
                }
                if (Marshal.GetLastWin32Error() != 234) Win32("QueryInformationJobObject(process list)");
            }
            finally { Marshal.FreeHGlobal(buffer); }
            capacity *= 2;
        }
        throw new InvalidOperationException("Job process list exceeded safety limit");
    }

    private static void WaitEmpty(IntPtr job)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            if (ActiveProcesses(job) == 0) return;
            if (DateTime.UtcNow >= deadline) throw new TimeoutException("Job termination did not drain");
            Thread.Sleep(10);
        }
    }

    private static void Status(string statusPath, string value)
    {
        File.WriteAllText(statusPath, value, new UTF8Encoding(false));
    }

    private static void CleanupAfterParentExit(string statusPath, string cancelPath)
    {
        string runDirectory = Path.GetDirectoryName(statusPath);
        if (Path.GetFileName(statusPath) != "status" || Path.GetFileName(cancelPath) != "cancel"
            || Path.GetDirectoryName(cancelPath) != runDirectory
            || !Path.GetFileName(runDirectory).StartsWith("run-", StringComparison.Ordinal)
            || Path.GetFileName(Path.GetDirectoryName(runDirectory)) != "memory-store-windows-job-runner") return;
        try
        {
            File.Delete(statusPath);
            File.Delete(statusPath + ".started");
            File.Delete(cancelPath);
            Directory.Delete(runDirectory);
        }
        catch { }
    }

    public static int Main(string[] args)
    {
        if (args.Length < 5) return 250;
        string statusPath = args[0];
        string cancelPath = args[1];
        string directory = args[2];
        uint parentPid = UInt32.Parse(args[3]);
        string command = args[4];
        IntPtr job = IntPtr.Zero;
        IntPtr parent = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool assigned = false;
        bool resumed = false;
        try
        {
            parent = OpenProcess(0x00100000, false, parentPid);
            if (parent == IntPtr.Zero) Win32("OpenProcess(parent)");
            if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) throw new InvalidOperationException("Parent already exited");
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) Win32("CreateJobObject");
            SetLimits(job);
            StringBuilder commandLine = new StringBuilder(Quote(command));
            for (int index = 5; index < args.Length; index++) commandLine.Append(' ').Append(Quote(args[index]));
            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, directory, ref startup, out process)) Win32("CreateProcess");
            if (!AssignProcessToJobObject(job, process.hProcess)) Win32("AssignProcessToJobObject");
            assigned = true;
            if (File.Exists(cancelPath) || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT)
            {
                if (!TerminateJobObject(job, 137)) Win32("TerminateJobObject");
                WaitEmpty(job);
                Status(statusPath, "cancelled:" + process.dwProcessId);
                return 137;
            }
            if (ResumeThread(process.hThread) == UInt32.MaxValue) Win32("ResumeThread");
            resumed = true;
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            Status(statusPath + ".started", "started:" + process.dwProcessId);
            while (true)
            {
                if (File.Exists(cancelPath) || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT)
                {
                    if (!TerminateJobObject(job, 137)) Win32("TerminateJobObject");
                    WaitEmpty(job);
                    Status(statusPath, "cancelled:" + process.dwProcessId);
                    return 137;
                }
                uint wait = WaitForSingleObject(process.hProcess, 10);
                if (wait == WAIT_OBJECT_0) break;
                if (wait != WAIT_TIMEOUT) Win32("WaitForSingleObject");
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) Win32("GetExitCodeProcess");
            DateTime settleDeadline = DateTime.UtcNow.AddMilliseconds(100);
            bool incomplete = HasDescendants(job, process.dwProcessId);
            while (incomplete && DateTime.UtcNow < settleDeadline)
            {
                Thread.Sleep(10);
                incomplete = HasDescendants(job, process.dwProcessId);
            }
            if (!TerminateJobObject(job, 137)) Win32("TerminateJobObject");
            WaitEmpty(job);
            Status(statusPath, (incomplete ? "incomplete:" : "exited:") + exitCode);
            return incomplete ? 249 : 0;
        }
        catch (Exception error)
        {
            try { Status(statusPath, "error:" + (resumed ? "started:" : "not-started:") + error.GetType().Name + ":" + (error is Win32Exception ? ((Win32Exception)error).NativeErrorCode.ToString() : "0")); } catch { }
            return 250;
        }
        finally
        {
            if (!assigned && process.hProcess != IntPtr.Zero)
            {
                TerminateProcess(process.hProcess, 137);
                WaitForSingleObject(process.hProcess, 10000);
            }
            if (parent != IntPtr.Zero && WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) CleanupAfterParentExit(statusPath, cancelPath);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (parent != IntPtr.Zero) CloseHandle(parent);
            if (job != IntPtr.Zero)
            {
                if (assigned) TerminateJobObject(job, 137);
                CloseHandle(job);
            }
        }
    }
}
