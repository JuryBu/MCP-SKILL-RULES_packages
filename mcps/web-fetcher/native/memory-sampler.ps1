param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [ValidateRange(250, 2000)][int]$IntervalMs = 500
)

$ErrorActionPreference = 'Stop'
$parent = [System.Diagnostics.Process]::GetProcessById($ParentProcessId)
$parentStart = $parent.StartTime.ToUniversalTime().Ticks

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public sealed class WebFetcherMemoryProbe : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct PerformanceInformation {
        public uint Size;
        public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable;
        public UIntPtr SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
        public uint HandleCount, ProcessCount, ThreadCount;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetPerformanceInfo(ref PerformanceInformation info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateMemoryResourceNotification(int notificationType);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryMemoryResourceNotification(IntPtr notification, [MarshalAs(UnmanagedType.Bool)] out bool state);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr low = CreateMemoryResourceNotification(0);
    private IntPtr high = CreateMemoryResourceNotification(1);
    private long sequence;

    public object Read() {
        long sampledAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        double sourceTime = Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency;
        PerformanceInformation info = new PerformanceInformation();
        info.Size = (uint)Marshal.SizeOf(typeof(PerformanceInformation));
        bool performanceValid = GetPerformanceInfo(ref info, info.Size);
        bool lowState = false, highState = false;
        bool lowValid = low != IntPtr.Zero && QueryMemoryResourceNotification(low, out lowState);
        bool highValid = high != IntPtr.Zero && QueryMemoryResourceNotification(high, out highState);
        bool valid = performanceValid && lowValid && highValid && info.PageSize.ToUInt64() > 0
            && info.CommitLimit.ToUInt64() >= info.CommitTotal.ToUInt64();
        double pageMB = info.PageSize.ToUInt64() / 1048576.0;
        return new {
            sequence = ++sequence,
            sampledAtUnixMs = sampledAt,
            sourceMonotonicMs = sourceTime,
            valid = valid,
            physicalAvailableMB = valid ? (double?)(info.PhysicalAvailable.ToUInt64() * pageMB) : null,
            commitAvailableMB = valid ? (double?)((info.CommitLimit.ToUInt64() - info.CommitTotal.ToUInt64()) * pageMB) : null,
            lowMemory = valid ? (bool?)lowState : null,
            highMemory = valid ? (bool?)highState : null,
            reason = valid ? null : (!performanceValid ? "GetPerformanceInfo_failed" : "memory_notification_or_sample_invalid")
        };
    }

    public void Dispose() {
        if (low != IntPtr.Zero) { CloseHandle(low); low = IntPtr.Zero; }
        if (high != IntPtr.Zero) { CloseHandle(high); high = IntPtr.Zero; }
    }
}
'@

$probe = New-Object WebFetcherMemoryProbe
try {
    while ($true) {
        $parent.Refresh()
        if ($parent.HasExited -or $parent.StartTime.ToUniversalTime().Ticks -ne $parentStart) { break }
        [Console]::Out.WriteLine(($probe.Read() | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds $IntervalMs
    }
} finally {
    $probe.Dispose()
    $parent.Dispose()
}
