using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsJobRunner
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
    private const int JobObjectAssociateCompletionPortInformation = 7;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

    private enum MemoryResourceNotificationType
    {
        LowMemoryResourceNotification = 0,
        HighMemoryResourceNotification = 1,
    }

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
    private struct JOBOBJECT_ASSOCIATE_COMPLETION_PORT
    {
        public IntPtr CompletionKey;
        public IntPtr CompletionPort;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PERFORMANCE_INFORMATION
    {
        public uint cb;
        public UIntPtr CommitTotal;
        public UIntPtr CommitLimit;
        public UIntPtr CommitPeak;
        public UIntPtr PhysicalTotal;
        public UIntPtr PhysicalAvailable;
        public UIntPtr SystemCache;
        public UIntPtr KernelTotal;
        public UIntPtr KernelPaged;
        public UIntPtr KernelNonpaged;
        public UIntPtr PageSize;
        public uint HandleCount;
        public uint ProcessCount;
        public uint ThreadCount;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateIoCompletionPort(IntPtr fileHandle, IntPtr existingCompletionPort, IntPtr completionKey, uint concurrentThreads);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetQueuedCompletionStatus(IntPtr completionPort, out uint bytesTransferred, out IntPtr completionKey, out IntPtr overlapped, uint milliseconds);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateMemoryResourceNotification(MemoryResourceNotificationType notificationType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryMemoryResourceNotification(IntPtr resourceNotification, out bool resourceState);

    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetPerformanceInfo(out PERFORMANCE_INFORMATION performanceInformation, uint size);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--monitor-system") return MonitorSystem(args);
            return RunCommand(args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("WINDOWS_JOB_RUNNER_ERROR: " + error.Message);
            return 250;
        }
    }

    private static int RunCommand(string[] args)
    {
        long memoryMB = 0;
        string metadataPath = null;
        string currentDirectory = null;
        string shellCommandBase64 = null;
        int commandIndex = -1;
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--memory-mb" && index + 1 < args.Length)
            {
                memoryMB = long.Parse(args[++index], CultureInfo.InvariantCulture);
            }
            else if (args[index] == "--metadata" && index + 1 < args.Length)
            {
                metadataPath = args[++index];
            }
            else if (args[index] == "--cwd" && index + 1 < args.Length)
            {
                currentDirectory = args[++index];
            }
            else if (args[index] == "--shell-base64" && index + 1 < args.Length)
            {
                shellCommandBase64 = args[++index];
            }
            else if (args[index] == "--")
            {
                commandIndex = index + 1;
                break;
            }
        }

        bool useShellCommand = !string.IsNullOrEmpty(shellCommandBase64);
        if (memoryMB < 16 || string.IsNullOrEmpty(metadataPath) || (!useShellCommand && (commandIndex < 0 || commandIndex >= args.Length)))
        {
            throw new ArgumentException("Expected --memory-mb, --metadata, optional --cwd, and either --shell-base64 or -- command [args]");
        }

        string executable;
        StringBuilder commandLine;
        if (useShellCommand)
        {
            executable = Environment.GetEnvironmentVariable("COMSPEC");
            if (string.IsNullOrEmpty(executable)) executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe");
            string shellCommand = Encoding.UTF8.GetString(Convert.FromBase64String(shellCommandBase64));
            commandLine = new StringBuilder(QuoteArgument(executable));
            commandLine.Append(" /d /s /c \"").Append(shellCommand).Append('"');
        }
        else
        {
            executable = args[commandIndex];
            commandLine = new StringBuilder(QuoteArgument(executable));
            for (int index = commandIndex + 1; index < args.Length; index++)
            {
                commandLine.Append(' ').Append(QuoteArgument(args[index]));
            }
        }

        IntPtr job = IntPtr.Zero;
        IntPtr completionPort = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool memoryLimitHit = false;
        ulong peakBytes = 0;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) ThrowLastWin32("CreateJobObject");

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            limits.JobMemoryLimit = ToUIntPtr(checked((ulong)memoryMB * 1024UL * 1024UL));
            SetJobInformation(job, JobObjectExtendedLimitInformation, limits);

            completionPort = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1);
            if (completionPort == IntPtr.Zero) ThrowLastWin32("CreateIoCompletionPort");
            JOBOBJECT_ASSOCIATE_COMPLETION_PORT association = new JOBOBJECT_ASSOCIATE_COMPLETION_PORT();
            association.CompletionPort = completionPort;
            SetJobInformation(job, JobObjectAssociateCompletionPortInformation, association);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

            if (!CreateProcess(useShellCommand ? executable : null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, currentDirectory, ref startup, out process))
            {
                ThrowLastWin32("CreateProcess");
            }
            if (!AssignProcessToJobObject(job, process.hProcess)) ThrowLastWin32("AssignProcessToJobObject");
            if (ResumeThread(process.hThread) == UInt32.MaxValue) ThrowLastWin32("ResumeThread");
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;

            WriteMetadata(metadataPath, peakBytes, memoryLimitHit, null, true, null, null);
            DateTime nextMetadataWrite = DateTime.UtcNow;
            while (true)
            {
                uint wait = WaitForSingleObject(process.hProcess, 25);
                DrainCompletionPort(completionPort, ref memoryLimitHit);
                peakBytes = Math.Max(peakBytes, QueryPeakJobMemory(job));
                if (DateTime.UtcNow >= nextMetadataWrite)
                {
                    WriteMetadata(metadataPath, peakBytes, memoryLimitHit, null, true, null, null);
                    nextMetadataWrite = DateTime.UtcNow.AddMilliseconds(100);
                }
                if (memoryLimitHit)
                {
                    TerminateJobObject(job, 137);
                }
                if (wait == WAIT_OBJECT_0) break;
                if (wait != WAIT_TIMEOUT) ThrowLastWin32("WaitForSingleObject");
            }

            DrainCompletionPort(completionPort, ref memoryLimitHit);
            peakBytes = Math.Max(peakBytes, QueryPeakJobMemory(job));
            uint childExitCode;
            if (!GetExitCodeProcess(process.hProcess, out childExitCode)) ThrowLastWin32("GetExitCodeProcess");
            WriteMetadata(metadataPath, peakBytes, memoryLimitHit, childExitCode, true, null, null);
            return memoryLimitHit ? 137 : unchecked((int)childExitCode);
        }
        catch (Exception error)
        {
            string errorType = !Directory.Exists(currentDirectory) ? "working_directory_missing" : "payload_start_failed";
            Win32Exception win32 = error as Win32Exception;
            WriteMetadata(metadataPath, peakBytes, memoryLimitHit, null, false, errorType, win32 != null ? (int?)win32.NativeErrorCode : null);
            throw;
        }
        finally
        {
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (completionPort != IntPtr.Zero) CloseHandle(completionPort);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static int MonitorSystem(string[] args)
    {
        int intervalMs = 500;
        for (int index = 1; index < args.Length; index++)
        {
            if (args[index] == "--interval-ms" && index + 1 < args.Length)
            {
                intervalMs = Math.Max(250, int.Parse(args[++index], CultureInfo.InvariantCulture));
            }
        }

        IntPtr low = CreateMemoryResourceNotification(MemoryResourceNotificationType.LowMemoryResourceNotification);
        IntPtr high = CreateMemoryResourceNotification(MemoryResourceNotificationType.HighMemoryResourceNotification);
        try
        {
            while (true)
            {
                PERFORMANCE_INFORMATION performance;
                performance = new PERFORMANCE_INFORMATION();
                performance.cb = (uint)Marshal.SizeOf(typeof(PERFORMANCE_INFORMATION));
                if (!GetPerformanceInfo(out performance, performance.cb)) ThrowLastWin32("GetPerformanceInfo");
                bool lowState = false;
                bool highState = true;
                if (low != IntPtr.Zero) QueryMemoryResourceNotification(low, out lowState);
                if (high != IntPtr.Zero) QueryMemoryResourceNotification(high, out highState);
                ulong pageSize = performance.PageSize.ToUInt64();
                ulong physicalAvailable = performance.PhysicalAvailable.ToUInt64() * pageSize;
                ulong commitAvailable = (performance.CommitLimit.ToUInt64() - performance.CommitTotal.ToUInt64()) * pageSize;
                Console.Out.WriteLine(
                    "{\"physicalAvailableMB\":" + ToMB(physicalAvailable) +
                    ",\"commitAvailableMB\":" + ToMB(commitAvailable) +
                    ",\"highMemory\":" + (highState ? "true" : "false") +
                    ",\"lowMemory\":" + (lowState ? "true" : "false") + "}");
                Console.Out.Flush();
                Thread.Sleep(intervalMs);
            }
        }
        finally
        {
            if (low != IntPtr.Zero) CloseHandle(low);
            if (high != IntPtr.Zero) CloseHandle(high);
        }
    }

    private static void DrainCompletionPort(IntPtr completionPort, ref bool memoryLimitHit)
    {
        uint message;
        IntPtr key;
        IntPtr overlapped;
        while (GetQueuedCompletionStatus(completionPort, out message, out key, out overlapped, 0))
        {
            if (message == JOB_OBJECT_MSG_JOB_MEMORY_LIMIT) memoryLimitHit = true;
        }
    }

    private static ulong QueryPeakJobMemory(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, IntPtr.Zero))
            {
                ThrowLastWin32("QueryInformationJobObject");
            }
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = (JOBOBJECT_EXTENDED_LIMIT_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            return information.PeakJobMemoryUsed.ToUInt64();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void SetJobInformation<T>(IntPtr job, int informationClass, T information) where T : struct
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(information, buffer, false);
            if (!SetInformationJobObject(job, informationClass, buffer, (uint)size)) ThrowLastWin32("SetInformationJobObject");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static void WriteMetadata(string path, ulong peakBytes, bool memoryLimitHit, uint? childExitCode, bool commandStarted, string startErrorType, int? startErrorCode)
    {
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string json = "{\"peakMemoryBytes\":" + peakBytes.ToString(CultureInfo.InvariantCulture) +
            ",\"memoryLimitHit\":" + (memoryLimitHit ? "true" : "false") +
            ",\"childExitCode\":" + (childExitCode.HasValue ? childExitCode.Value.ToString(CultureInfo.InvariantCulture) : "null") +
            ",\"commandStarted\":" + (commandStarted ? "true" : "false") +
            ",\"startErrorType\":" + (startErrorType == null ? "null" : "\"" + startErrorType + "\"") +
            ",\"startErrorCode\":" + (startErrorCode.HasValue ? startErrorCode.Value.ToString(CultureInfo.InvariantCulture) : "null") + "}";
        File.WriteAllText(path, json, new UTF8Encoding(false));
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2).Append('"');
        return result.ToString();
    }

    private static UIntPtr ToUIntPtr(ulong value)
    {
        return UIntPtr.Size == 8 ? new UIntPtr(value) : new UIntPtr(checked((uint)value));
    }

    private static ulong ToMB(ulong bytes)
    {
        return bytes / (1024UL * 1024UL);
    }

    private static void ThrowLastWin32(string operation)
    {
        int code = Marshal.GetLastWin32Error();
        throw new Win32Exception(code, operation + " failed: " + new Win32Exception(code).Message + " (" + code + ")");
    }
}
