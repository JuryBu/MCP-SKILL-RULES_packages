using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

internal static class AgentFileCommit
{
    private const int MaximumContentBytes = 8 * 1024 * 1024;
    private const int MaximumRequestChars = 12 * 1024 * 1024;
    private const long MaximumVersionBytes = 64 * 1024 * 1024;
    private const int MaximumExtendedPathChars = 32767;
    private const int MaximumPathChars = MaximumExtendedPathChars - 5;
    private const string StagingPrefix = ".sandbox-agent-commit-";
    private const string StagingSuffix = ".tmp";
    private static readonly int StagingNameChars = StagingPrefix.Length + Guid.Empty.ToString("N").Length + StagingSuffix.Length;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint DeleteAccess = 0x00010000;
    private const uint ShareRead = 1;
    private const uint ShareWrite = 2;
    private const uint ShareDelete = 4;
    private const uint OpenExisting = 3;
    private const uint CreateNew = 1;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint SequentialScan = 0x08000000;
    private const uint AttributeDirectory = 0x10;
    private const uint AttributeReparsePoint = 0x400;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumRequestChars, RecursionLimit = 16 };

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeFileTime
    {
        public uint Low;
        public uint High;
        internal ulong Value { get { return ((ulong)High << 32) | Low; } }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HandleInformation
    {
        public uint Attributes;
        public NativeFileTime CreationTime;
        public NativeFileTime AccessTime;
        public NativeFileTime WriteTime;
        public uint VolumeSerialNumber;
        public uint SizeHigh;
        public uint SizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
        internal ulong Length { get { return ((ulong)SizeHigh << 32) | SizeLow; } }
        internal string Identity { get { return (((ulong)FileIndexHigh << 32) | FileIndexLow).ToString("x16", CultureInfo.InvariantCulture); } }
        internal string Volume { get { return VolumeSerialNumber.ToString("x8", CultureInfo.InvariantCulture); } }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FindData
    {
        public uint Attributes;
        public NativeFileTime CreationTime;
        public NativeFileTime AccessTime;
        public NativeFileTime WriteTime;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Reserved0;
        public uint Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string FileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateFileName;
    }

    private sealed class FileFault : Exception
    {
        internal readonly string Code;
        internal readonly bool MayHaveStarted;
        internal readonly object Details;
        internal FileFault(string code, bool mayHaveStarted, object details) { Code = code; MayHaveStarted = mayHaveStarted; Details = details; }
    }

    private sealed class PinnedParent : IDisposable
    {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal HandleInformation ParentInformation;
        internal string Path;
        public void Dispose()
        {
            for (int index = Handles.Count - 1; index >= 0; index--) Handles[index].Dispose();
            Handles.Clear();
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileNative(string name, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    private static SafeFileHandle CreateFile(string name, uint desiredAccess, uint shareMode, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile)
    { return CreateFileNative(ExtendedPath(name), desiredAccess, shareMode, securityAttributes, creationDisposition, flagsAndAttributes, templateFile); }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out HandleInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint pathLength, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetVolumeInformation(string root, StringBuilder volumeName, uint volumeNameSize, out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder fileSystemName, uint fileSystemNameSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetDriveType(string root);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileTime(SafeFileHandle file, IntPtr creationTime, IntPtr accessTime, ref NativeFileTime writeTime);

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryNative(string path, IntPtr securityAttributes);

    private static bool CreateDirectory(string path, IntPtr securityAttributes) { return CreateDirectoryNative(ExtendedPath(path), securityAttributes); }

    [DllImport("kernel32.dll", EntryPoint = "FindFirstFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFile(string pattern, out FindData data);

    [DllImport("kernel32.dll", EntryPoint = "FindNextFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool FindNextFile(IntPtr find, out FindData data);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FindClose(IntPtr find);

    public static int Main(string[] args)
    {
        bool commitDispatched = false;
        try
        {
            Console.InputEncoding = Utf8;
            Console.OutputEncoding = Utf8;
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) throw Fault("FILE_COMMIT_CAPABILITY_UNAVAILABLE");
            if (args.Length == 1 && args[0] == "--capabilities")
            {
                WriteSuccess(new
                {
                    protocolVersion = 1,
                    available = true,
                    requiresTrustedCaller = true,
                    fileSystems = new[] { "local-fixed-NTFS" },
                    operations = new[] { "inspect", "commit", "restore_created_file", "move", "delete", "mkdir", "restore_created_directory" },
                    createdFileRestore = "absent-origin-and-exact-version-sha256-exclusive-delete",
                    atomicCreate = true,
                    atomicOverwrite = false,
                    exclusiveInPlaceOverwrite = true,
                    inPlaceOverwriteOptIn = "allowInPlace=true",
                    crashAtomicOverwrite = false,
                    versionComparison = "opaque-versionToken-from-inspect",
                    directoryIdentity = "pinned-no-reparse-no-delete-sharing",
                    fileIdentity = "volume-and-file-id-single-link-only",
                    receiptPersistence = "trusted-parent-journal-required",
                    maximumContentBytes = MaximumContentBytes,
                    textCommitValidation = "contentEncoding=utf8-strict-before-write",
                    maximumVersionBytes = MaximumVersionBytes,
                    maximumPathChars = MaximumPathChars,
                    maximumAtomicCreateParentPathChars = MaximumPathChars - StagingNameChars - 1,
                    pathNamespace = "validated-local-DOS-with-internal-extended-Win32",
                    changesSystemLongPathPolicy = false,
                    createsParentDirectories = false,
                    moves = "exclusive-source-no-replace-same-volume-rename-or-verified-copy-delete",
                    directories = "single-level-create-empty-exact-identity-restore",
                    multiFileTransaction = false
                });
                return 0;
            }
            if (args.Length != 0 || !Console.IsInputRedirected) throw Fault("FILE_INPUT_INVALID");
            Dictionary<string, object> request = ReadRequest();
            ValidateFields(request);
            string operation = RequiredString(request, "operation");
            if (operation != "inspect" && operation != "commit" && operation != "restore_created_file"
                && operation != "move" && operation != "delete" && operation != "mkdir" && operation != "restore_created_directory") throw Fault("FILE_OPERATION_UNSUPPORTED");
            string path = CanonicalPath(RequiredString(request, "path"), false);
            string allowedRoot = SelectRoot(request, path);
            RequireSupportedVolume(path);
            ValidateOperationFields(request, operation);
            using (PinnedParent parent = PinParent(path, allowedRoot))
            {
                if (operation == "inspect")
                {
                    if (request.ContainsKey("contentBase64") || request.ContainsKey("expectedVersion") || request.ContainsKey("allowInPlace")
                        || request.ContainsKey("createdFromAbsent") || request.ContainsKey("expectedSha256") || request.ContainsKey("sourceActionId")) throw Fault("FILE_INPUT_INVALID");
                    WriteSuccess(new { version = Inspect(parent) });
                }
                else if (operation == "restore_created_file") { commitDispatched = true; WriteSuccess(RestoreCreatedFile(parent, request)); }
                else if (operation == "move")
                {
                    string destination = CanonicalPath(RequiredString(request, "destinationPath"), false);
                    if (String.Equals(path, destination, StringComparison.OrdinalIgnoreCase)) throw Fault("FILE_INPUT_INVALID");
                    RequireSupportedVolume(destination);
                    using (PinnedParent target = PinParent(destination, SelectRoot(request, destination)))
                    { commitDispatched = true; WriteSuccess(Move(parent, target, request)); }
                }
                else if (operation == "delete") { commitDispatched = true; WriteSuccess(DeleteFile(parent, request)); }
                else if (operation == "mkdir") { commitDispatched = true; WriteSuccess(MakeDirectory(parent, request)); }
                else if (operation == "restore_created_directory") { commitDispatched = true; WriteSuccess(RestoreDirectory(parent, request)); }
                else
                {
                    if (request.ContainsKey("createdFromAbsent") || request.ContainsKey("expectedSha256") || request.ContainsKey("sourceActionId")) throw Fault("FILE_INPUT_INVALID");
                    commitDispatched = true; WriteSuccess(Commit(parent, request));
                }
            }
            return 0;
        }
        catch (FileFault fault) { return WriteFailure(fault.Code, fault.MayHaveStarted, fault.Details); }
        catch (Exception) { return WriteFailure("FILE_COMMIT_FAILED", commitDispatched, new { effectState = commitDispatched ? "unknown" : "not_started" }); }
    }

    private static Dictionary<string, object> Expected(Dictionary<string, object> request, string field)
    {
        object value;
        Dictionary<string, object> expected;
        object exists;
        if (!request.TryGetValue(field, out value) || (expected = value as Dictionary<string, object>) == null
            || expected.Count != 2 || !expected.TryGetValue("exists", out exists) || !(exists is bool)
            || !Regex.IsMatch(RequiredString(expected, "versionToken"), "\\A[a-f0-9]{64}\\z", RegexOptions.CultureInvariant)) throw Fault("FILE_INPUT_INVALID");
        return expected;
    }

    private static void CompareExpected(Dictionary<string, object> expected, Dictionary<string, object> current, string receiptId)
    { CompareExpected((string)expected["versionToken"], (bool)expected["exists"], current, receiptId); }

    private static object Move(PinnedParent source, PinnedParent target, Dictionary<string, object> request)
    {
        Dictionary<string, object> expected = Expected(request, "expectedVersion");
        Dictionary<string, object> expectedTarget = Expected(request, "expectedDestinationVersion");
        RequiredString(request, "sourceActionId");
        string receiptId = Guid.NewGuid().ToString("D");
        SafeFileHandle handle = CreateFile(source.Path, GenericRead | DeleteAccess, ShareRead, IntPtr.Zero, OpenExisting, OpenReparsePoint | SequentialScan, IntPtr.Zero);
        if (handle.IsInvalid) { int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new FileFault(code == 2 || code == 32 || code == 33 ? "VERSION_CONFLICT" : "FILE_OPEN_FAILED", false, new { win32Code = code }); }
        bool changed = false;
        Dictionary<string, object> destinationReceipt = null;
        try
        {
            Dictionary<string, object> before;
            Dictionary<string, object> destinationBefore = Inspect(target);
            Dictionary<string, object> destinationAfter;
            bool sameVolume;
            using (FileStream current = new FileStream(handle, FileAccess.Read, 1048576, false))
            {
                before = Snapshot(current, source.Path, source.ParentInformation);
                CompareExpected(expected, before, receiptId);
                CompareExpected(expectedTarget, destinationBefore, receiptId);
                if ((bool)destinationBefore["exists"] || !(bool)before["exists"]) throw Fault("VERSION_CONFLICT");
                sameVolume = (string)before["volumeId"] == (string)destinationBefore["volumeId"];
                if (sameVolume)
                {
                    RenameNew(handle, target.Path);
                    changed = true;
                    destinationAfter = Snapshot(current, target.Path, target.ParentInformation);
                }
                else
                {
                    if ((long)before["byteLength"] > MaximumContentBytes) throw Fault("FILE_CONTENT_LIMIT");
                    byte[] bytes = new byte[(int)(long)before["byteLength"]];
                    current.Position = 0;
                    int position = 0;
                    while (position < bytes.Length) { int count = current.Read(bytes, position, bytes.Length - position); if (count == 0) throw Fault("VERSION_UNSTABLE"); position += count; }
                    if (HashBytes(bytes) != (string)before["sha256"]) throw Fault("VERSION_UNSTABLE");
                    destinationReceipt = Json.DeserializeObject(Json.Serialize(CreateAtomic(target, destinationBefore, bytes, receiptId))) as Dictionary<string, object>;
                    changed = true;
                    destinationAfter = Inspect(target);
                    if ((string)destinationAfter["sha256"] != (string)before["sha256"]) throw Fault("CHANGE_COMMIT_UNKNOWN");
                    if (!MarkStagingForDeletion(handle)) throw Fault("CHANGE_COMMIT_UNKNOWN");
                }
            }
            Dictionary<string, object> after = Inspect(source);
            if ((bool)after["exists"]) throw Fault("CHANGE_COMMIT_UNKNOWN");
            return new { receiptId = receiptId, path = source.Path, beforeVersion = before, afterVersion = after,
                destinationPath = target.Path, destinationBeforeVersion = destinationBefore, destinationAfterVersion = destinationAfter,
                atomic = sameVolume, commitMode = sameVolume ? "exclusive_rename_no_replace" : "verified_copy_exclusive_delete", bytesWritten = sameVolume ? 0L : (long)before["byteLength"],
                effectState = "applied", cleanupState = "released", committedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
        }
        catch (Exception error)
        {
            handle.Dispose();
            FileFault fault = error as FileFault;
            if (!changed && fault != null && !fault.MayHaveStarted) throw;
            throw new FileFault("CHANGE_COMMIT_UNKNOWN", true, new { receiptId = receiptId, effectState = "unknown", cleanupState = "released", destinationReceipt = destinationReceipt });
        }
    }

    private static object DeleteFile(PinnedParent parent, Dictionary<string, object> request)
    {
        object approved;
        if (!request.TryGetValue("deletionApproved", out approved) || !(approved is bool) || !(bool)approved) throw Fault("FILE_INPUT_INVALID");
        Dictionary<string, object> expected = Expected(request, "expectedVersion");
        string actionId = RequiredString(request, "sourceActionId");
        string receiptId = Guid.NewGuid().ToString("D");
        SafeFileHandle handle = CreateFile(parent.Path, GenericRead | DeleteAccess, 0, IntPtr.Zero, OpenExisting, OpenReparsePoint | SequentialScan, IntPtr.Zero);
        if (handle.IsInvalid) { int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new FileFault(code == 2 || code == 32 || code == 33 ? "VERSION_CONFLICT" : "FILE_OPEN_FAILED", false, new { win32Code = code }); }
        bool marked = false;
        try
        {
            Dictionary<string, object> before;
            using (FileStream current = new FileStream(handle, FileAccess.Read, 1048576, false))
            {
                before = Snapshot(current, parent.Path, parent.ParentInformation);
                CompareExpected(expected, before, receiptId);
                if (!MarkStagingForDeletion(handle)) throw new FileFault("CHANGE_PREPARE_FAILED", false, new { win32Code = Marshal.GetLastWin32Error() });
                marked = true;
            }
            Dictionary<string, object> after = Inspect(parent);
            if ((bool)after["exists"]) throw Fault("CHANGE_COMMIT_UNKNOWN");
            return new { receiptId = receiptId, path = parent.Path, beforeVersion = before, afterVersion = after,
                atomic = true, commitMode = "approved_exclusive_delete", bytesWritten = 0L, effectState = "applied", cleanupState = "released",
                committedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), deletionActionId = actionId };
        }
        catch (Exception error)
        {
            handle.Dispose(); FileFault fault = error as FileFault;
            if (!marked && fault != null) throw;
            throw new FileFault(marked ? "CHANGE_COMMIT_UNKNOWN" : "CHANGE_PREPARE_FAILED", marked, new { receiptId = receiptId, effectState = marked ? "unknown" : "not_started", cleanupState = "released" });
        }
    }

    private static object MakeDirectory(PinnedParent parent, Dictionary<string, object> request)
    {
        Dictionary<string, object> expected = Expected(request, "expectedVersion");
        RequiredString(request, "sourceActionId");
        string receiptId = Guid.NewGuid().ToString("D");
        Dictionary<string, object> before = Inspect(parent);
        CompareExpected(expected, before, receiptId);
        if ((bool)before["exists"]) throw Fault("VERSION_CONFLICT");
        if (!CreateDirectory(parent.Path, IntPtr.Zero)) { int code = Marshal.GetLastWin32Error(); throw new FileFault(code == 183 ? "VERSION_CONFLICT" : "CHANGE_PREPARE_FAILED", false, new { win32Code = code }); }
        try
        {
            Dictionary<string, object> after = Inspect(parent);
            if ((string)after["kind"] != "directory") throw Fault("CHANGE_COMMIT_UNKNOWN");
            return Receipt(receiptId, parent.Path, before, after, false, "single_level_directory_create", 0);
        }
        catch { throw new FileFault("CHANGE_COMMIT_UNKNOWN", true, new { receiptId = receiptId, effectState = "unknown", cleanupState = "released" }); }
    }

    private static object RestoreDirectory(PinnedParent parent, Dictionary<string, object> request)
    {
        Dictionary<string, object> expected = Expected(request, "expectedVersion");
        object origin;
        if (!request.TryGetValue("createdFromAbsent", out origin) || !(origin is bool) || !(bool)origin) throw Fault("FILE_INPUT_INVALID");
        string sourceActionId = RequiredString(request, "sourceActionId");
        string receiptId = Guid.NewGuid().ToString("D");
        Dictionary<string, object> before = Inspect(parent);
        CompareExpected(expected, before, receiptId);
        if ((string)before["kind"] != "directory" || ((string[])before["entryNames"]).Length != 0) throw Fault("VERSION_CONFLICT");
        SafeFileHandle handle = CreateFile(parent.Path, 0x80 | 0x1 | DeleteAccess, 0, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) { int code = Marshal.GetLastWin32Error(); handle.Dispose(); throw new FileFault(code == 2 || code == 32 || code == 33 ? "VERSION_CONFLICT" : "FILE_OPEN_FAILED", false, new { win32Code = code }); }
        bool marked = false;
        try
        {
            using (handle)
            {
                HandleInformation information = Information(handle);
                RequireHandlePath(handle, parent.Path);
                string time = DateTime.FromFileTimeUtc(checked((long)information.WriteTime.Value)).ToString("o", CultureInfo.InvariantCulture);
                if ((information.Attributes & AttributeDirectory) == 0 || (information.Attributes & AttributeReparsePoint) != 0
                    || information.Identity != (string)before["fileId"] || information.Volume != (string)before["volumeId"]
                    || time != (string)before["mtime"] || (long)information.Attributes != (long)before["attributes"]) throw Fault("VERSION_CONFLICT");
                if (!MarkStagingForDeletion(handle)) throw new FileFault("VERSION_CONFLICT", false, new { win32Code = Marshal.GetLastWin32Error() });
                marked = true;
            }
            Dictionary<string, object> after = Inspect(parent);
            if ((bool)after["exists"]) throw Fault("CHANGE_COMMIT_UNKNOWN");
            return new { receiptId = receiptId, path = parent.Path, beforeVersion = before, afterVersion = after,
                atomic = true, commitMode = "restore_created_empty_directory", bytesWritten = 0L, effectState = "applied", cleanupState = "released",
                committedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), restoredCreationActionId = sourceActionId };
        }
        catch (Exception error)
        {
            handle.Dispose(); FileFault fault = error as FileFault;
            if (!marked && fault != null) throw;
            throw new FileFault(marked ? "CHANGE_COMMIT_UNKNOWN" : "CHANGE_PREPARE_FAILED", marked, new { receiptId = receiptId, effectState = marked ? "unknown" : "not_started", cleanupState = "released" });
        }
    }

    private static object Commit(PinnedParent parent, Dictionary<string, object> request)
    {
        object expectedObject;
        Dictionary<string, object> expected;
        object expectedExists;
        if (!request.TryGetValue("expectedVersion", out expectedObject) || (expected = expectedObject as Dictionary<string, object>) == null) throw Fault("FILE_INPUT_INVALID");
        if (!expected.TryGetValue("exists", out expectedExists) || !(expectedExists is bool)) throw Fault("FILE_INPUT_INVALID");
        string expectedToken = RequiredString(expected, "versionToken");
        if (!Regex.IsMatch(expectedToken, "\\A[a-f0-9]{64}\\z", RegexOptions.CultureInvariant)) throw Fault("FILE_INPUT_INVALID");
        string contentBase64 = StringField(request, "contentBase64");
        byte[] content;
        try { content = Convert.FromBase64String(contentBase64); }
        catch (FormatException) { throw Fault("FILE_INPUT_INVALID"); }
        if (content.Length > MaximumContentBytes) throw Fault("FILE_CONTENT_LIMIT");
        if (request.ContainsKey("contentEncoding"))
        {
            if (RequiredString(request, "contentEncoding") != "utf8") throw Fault("FILE_INPUT_INVALID");
            try { Utf8.GetCharCount(content); }
            catch (DecoderFallbackException) { throw new FileFault("FILE_TEXT_ENCODING_INVALID", false, new { contentEncoding = "utf8", targetUnchanged = true }); }
        }
        bool allowInPlace = false;
        object allowObject;
        if (request.TryGetValue("allowInPlace", out allowObject))
        {
            if (!(allowObject is bool)) throw Fault("FILE_INPUT_INVALID");
            allowInPlace = (bool)allowObject;
        }
        string receiptId = Guid.NewGuid().ToString("D");
        using (FileStream current = OpenTarget(parent.Path, true))
        {
            Dictionary<string, object> before = current == null ? MissingVersion(parent) : Snapshot(current, parent.Path, parent.ParentInformation);
            CompareExpected(expectedToken, (bool)expectedExists, before, receiptId);
            if (current == null) return CreateAtomic(parent, before, content, receiptId);
            if ((string)before["sha256"] == HashBytes(content)) return Receipt(receiptId, parent.Path, before, before, true, "unchanged", 0);
            if (!allowInPlace) throw new FileFault("ATOMIC_COMMIT_UNSUPPORTED", false, new { receiptId = receiptId, currentVersion = before, requiredOptIn = "allowInPlace=true", atomicOverwrite = false });
            return OverwriteExclusive(parent, current, before, content, receiptId);
        }
    }

    private static object RestoreCreatedFile(PinnedParent parent, Dictionary<string, object> request)
    {
        object origin;
        object expectedObject;
        Dictionary<string, object> expected;
        object exists;
        if (!request.TryGetValue("createdFromAbsent", out origin) || !(origin is bool) || !(bool)origin
            || request.ContainsKey("contentBase64") || request.ContainsKey("allowInPlace")
            || !request.TryGetValue("expectedVersion", out expectedObject) || (expected = expectedObject as Dictionary<string, object>) == null
            || !expected.TryGetValue("exists", out exists) || !(exists is bool) || !(bool)exists) throw Fault("FILE_INPUT_INVALID");
        string token = RequiredString(expected, "versionToken");
        string expectedHash = RequiredString(request, "expectedSha256");
        string sourceActionId = RequiredString(request, "sourceActionId");
        if (!Regex.IsMatch(token, "\\A[a-f0-9]{64}\\z", RegexOptions.CultureInvariant)
            || !Regex.IsMatch(expectedHash, "\\A[a-f0-9]{64}\\z", RegexOptions.CultureInvariant) || sourceActionId.Length > 256) throw Fault("FILE_INPUT_INVALID");
        string receiptId = Guid.NewGuid().ToString("D");
        Dictionary<string, object> before;
        SafeFileHandle handle = CreateFile(parent.Path, GenericRead | DeleteAccess, 0, IntPtr.Zero, OpenExisting, OpenReparsePoint | SequentialScan, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int errorCode = Marshal.GetLastWin32Error(); handle.Dispose();
            if (errorCode == 2 || errorCode == 32 || errorCode == 33) throw Fault("VERSION_CONFLICT");
            throw new FileFault("FILE_OPEN_FAILED", false, new { win32Code = errorCode });
        }
        bool marked = false;
        try
        {
            using (FileStream current = new FileStream(handle, FileAccess.Read, 1048576, false))
            {
                before = Snapshot(current, parent.Path, parent.ParentInformation);
                CompareExpected(token, true, before, receiptId);
                if ((string)before["sha256"] != expectedHash) throw Fault("VERSION_CONFLICT");
                if (!MarkStagingForDeletion(handle)) throw new FileFault("CHANGE_PREPARE_FAILED", false, new { receiptId = receiptId, win32Code = Marshal.GetLastWin32Error() });
                marked = true;
            }
            Dictionary<string, object> after = Inspect(parent);
            if ((bool)after["exists"]) throw Fault("CHANGE_COMMIT_UNKNOWN");
            return new { receiptId = receiptId, path = parent.Path, beforeVersion = before, afterVersion = after,
                atomic = true, commitMode = "restore_created_exclusive_delete", bytesWritten = 0L, effectState = "applied", cleanupState = "released",
                committedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), restoredCreationActionId = sourceActionId };
        }
        catch (Exception error)
        {
            handle.Dispose();
            FileFault fault = error as FileFault;
            if (!marked && fault != null) throw;
            throw new FileFault(marked ? "CHANGE_COMMIT_UNKNOWN" : "CHANGE_PREPARE_FAILED", marked,
                new { receiptId = receiptId, effectState = marked ? "unknown" : "not_started", cleanupState = "released" });
        }
    }

    private static object OverwriteExclusive(PinnedParent parent, FileStream file, Dictionary<string, object> before, byte[] content, string receiptId)
    {
        bool writeStarted = false;
        try
        {
            file.Position = 0;
            writeStarted = true;
            file.Write(content, 0, content.Length);
            file.SetLength(content.Length);
            file.Flush(true);
            FixWriteTime(file.SafeFileHandle);
            Dictionary<string, object> after = Snapshot(file, parent.Path, parent.ParentInformation);
            if ((string)after["sha256"] != HashBytes(content) || (long)after["byteLength"] != content.LongLength) throw Fault("CHANGE_COMMIT_UNKNOWN");
            return Receipt(receiptId, parent.Path, before, after, false, "exclusive_in_place", content.LongLength);
        }
        catch (Exception)
        {
            throw new FileFault(writeStarted ? "CHANGE_COMMIT_UNKNOWN" : "CHANGE_PREPARE_FAILED", writeStarted, new { receiptId = receiptId, effectState = writeStarted ? "unknown" : "not_started", cleanupState = "released", commitMode = "exclusive_in_place" });
        }
    }

    private static object CreateAtomic(PinnedParent parent, Dictionary<string, object> before, byte[] content, string receiptId)
    {
        string directory = ParentPath(parent.Path);
        if (directory.Length > MaximumPathChars - StagingNameChars - 1) throw Fault("FILE_PATH_UNSUPPORTED");
        string stagingPath = CombinePath(directory, StagingPrefix + Guid.NewGuid().ToString("N") + StagingSuffix);
        SafeFileHandle handle = CreateFile(stagingPath, GenericRead | GenericWrite | DeleteAccess, ShareRead, IntPtr.Zero, CreateNew, OpenReparsePoint | SequentialScan, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int errorCode = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new FileFault("CHANGE_PREPARE_FAILED", false, new { receiptId = receiptId, win32Code = errorCode, cleanupState = "released" });
        }
        bool published = false;
        using (FileStream staging = new FileStream(handle, FileAccess.ReadWrite, 1048576, false))
        {
            try
            {
                HandleInformation information = Information(handle);
                RequireRegularSingleLink(information);
                RequireHandlePath(handle, stagingPath);
                staging.Write(content, 0, content.Length);
                staging.Flush(true);
                FixWriteTime(handle);
                RenameNew(handle, parent.Path);
                published = true;
                Dictionary<string, object> after = Snapshot(staging, parent.Path, parent.ParentInformation);
                if ((string)after["sha256"] != HashBytes(content)) throw Fault("CHANGE_COMMIT_UNKNOWN");
                return Receipt(receiptId, parent.Path, before, after, true, "atomic_create", content.LongLength);
            }
            catch (Exception error)
            {
                bool cleaned = published || MarkStagingForDeletion(handle);
                FileFault fileFault = error as FileFault;
                string code = published ? "CHANGE_COMMIT_UNKNOWN" : (fileFault == null ? "CHANGE_PREPARE_FAILED" : fileFault.Code);
                throw new FileFault(code, published, new { receiptId = receiptId, effectState = published ? "unknown" : "not_started", cleanupState = cleaned ? "released" : "unresolved", stagingPath = cleaned ? null : stagingPath, cause = fileFault == null ? null : fileFault.Details });
            }
        }
    }

    private static object Receipt(string receiptId, string path, Dictionary<string, object> before, Dictionary<string, object> after, bool atomic, string commitMode, long bytesWritten)
    {
        return new { receiptId = receiptId, path = path, beforeVersion = before, afterVersion = after, atomic = atomic, commitMode = commitMode, bytesWritten = bytesWritten, effectState = "applied", cleanupState = "released", committedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) };
    }

    private static void CompareExpected(string token, bool exists, Dictionary<string, object> current, string receiptId)
    {
        if (exists != (bool)current["exists"] || token != (string)current["versionToken"]) throw new FileFault("VERSION_CONFLICT", false, new { receiptId = receiptId, currentVersion = current, effectState = "not_started", cleanupState = "released" });
    }

    private static Dictionary<string, object> Inspect(PinnedParent parent)
    {
        SafeFileHandle directory = CreateFile(parent.Path, 0x80, ShareRead | ShareWrite | ShareDelete, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (!directory.IsInvalid)
        {
            using (directory)
            {
                HandleInformation information = Information(directory);
                if ((information.Attributes & AttributeDirectory) != 0) return DirectorySnapshot(directory, parent.Path, parent.ParentInformation);
            }
        }
        else directory.Dispose();
        using (FileStream file = OpenTarget(parent.Path, false)) { return file == null ? MissingVersion(parent) : Snapshot(file, parent.Path, parent.ParentInformation); }
    }

    private static Dictionary<string, object> DirectorySnapshot(SafeFileHandle handle, string path, HandleInformation parent)
    {
        HandleInformation before = Information(handle);
        if ((before.Attributes & AttributeDirectory) == 0 || (before.Attributes & AttributeReparsePoint) != 0) throw Fault("FILE_PATH_UNSUPPORTED");
        RequireHandlePath(handle, path);
        List<string> names = new List<string>();
        int entryBytes = 0;
        foreach (string name in DirectoryEntries(path))
        {
            entryBytes = checked(entryBytes + Utf8.GetByteCount(name) + 4);
            if (entryBytes > MaximumContentBytes) throw Fault("FILE_VERSION_LIMIT");
            names.Add(name);
        }
        string[] entries = names.ToArray();
        Array.Sort(entries, StringComparer.Ordinal);
        string entriesHash = HashBytes(Utf8.GetBytes(Json.Serialize(entries)));
        HandleInformation after = Information(handle);
        RequireHandlePath(handle, path);
        if (before.Identity != after.Identity || before.Volume != after.Volume || before.WriteTime.Value != after.WriteTime.Value || before.Attributes != after.Attributes) throw Fault("VERSION_UNSTABLE");
        Dictionary<string, object> version = new Dictionary<string, object>();
        version["canonicalPath"] = path; version["volumeId"] = after.Volume; version["parentFileId"] = parent.Identity;
        version["fileId"] = after.Identity; version["exists"] = true; version["kind"] = "directory";
        version["sha256"] = null; version["byteLength"] = 0L;
        version["mtime"] = DateTime.FromFileTimeUtc(checked((long)after.WriteTime.Value)).ToString("o", CultureInfo.InvariantCulture);
        version["attributes"] = (long)after.Attributes; version["entryNames"] = entries;
        version["versionToken"] = VersionToken(path, after.Volume, parent.Identity, after.Identity, "directory:" + entriesHash, 0, after.WriteTime.Value, after.Attributes);
        return version;
    }

    private static FileStream OpenTarget(string path, bool exclusiveWrite)
    {
        uint access = GenericRead | (exclusiveWrite ? GenericWrite : 0);
        SafeFileHandle handle = CreateFile(path, access, exclusiveWrite ? ShareRead : ShareRead | ShareWrite | ShareDelete, IntPtr.Zero, OpenExisting, OpenReparsePoint | SequentialScan, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int errorCode = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (errorCode == 2) return null;
            if (errorCode == 32 || errorCode == 33) throw Fault("VERSION_CONFLICT");
            throw new FileFault("FILE_OPEN_FAILED", false, new { win32Code = errorCode });
        }
        try
        {
            RequireRegularSingleLink(Information(handle));
            RequireHandlePath(handle, path);
            return new FileStream(handle, exclusiveWrite ? FileAccess.ReadWrite : FileAccess.Read, 1048576, false);
        }
        catch { handle.Dispose(); throw; }
    }

    private static Dictionary<string, object> Snapshot(FileStream stream, string path, HandleInformation parent)
    {
        HandleInformation before = Information(stream.SafeFileHandle);
        RequireRegularSingleLink(before);
        RequireHandlePath(stream.SafeFileHandle, path);
        if (before.Length > MaximumVersionBytes) throw Fault("FILE_VERSION_LIMIT");
        stream.Position = 0;
        string hash;
        using (SHA256 algorithm = SHA256.Create()) { hash = Hex(algorithm.ComputeHash(stream)); }
        HandleInformation after = Information(stream.SafeFileHandle);
        RequireRegularSingleLink(after);
        if (before.Identity != after.Identity || before.Volume != after.Volume || before.Length != after.Length || before.WriteTime.Value != after.WriteTime.Value || before.Attributes != after.Attributes) throw Fault("VERSION_UNSTABLE");
        Dictionary<string, object> version = new Dictionary<string, object>();
        version["canonicalPath"] = path;
        version["volumeId"] = after.Volume;
        version["parentFileId"] = parent.Identity;
        version["fileId"] = after.Identity;
        version["exists"] = true;
        version["kind"] = "file";
        version["sha256"] = hash;
        version["byteLength"] = checked((long)after.Length);
        version["mtime"] = DateTime.FromFileTimeUtc(checked((long)after.WriteTime.Value)).ToString("o", CultureInfo.InvariantCulture);
        version["attributes"] = (long)after.Attributes;
        version["versionToken"] = VersionToken(path, after.Volume, parent.Identity, after.Identity, hash, after.Length, after.WriteTime.Value, after.Attributes);
        return version;
    }

    private static Dictionary<string, object> MissingVersion(PinnedParent parent)
    {
        Dictionary<string, object> version = new Dictionary<string, object>();
        version["canonicalPath"] = parent.Path;
        version["volumeId"] = parent.ParentInformation.Volume;
        version["parentFileId"] = parent.ParentInformation.Identity;
        version["fileId"] = null;
        version["exists"] = false;
        version["kind"] = "missing";
        version["sha256"] = null;
        version["byteLength"] = 0L;
        version["mtime"] = null;
        version["attributes"] = 0L;
        version["versionToken"] = VersionToken(parent.Path, parent.ParentInformation.Volume, parent.ParentInformation.Identity, "missing", "", 0, 0, 0);
        return version;
    }

    private static string VersionToken(string path, string volume, string parentId, string fileId, string hash, ulong length, ulong time, uint attributes)
    {
        return HashBytes(Utf8.GetBytes(String.Join("\n", new[] { "sandbox-agent-file-version/v1", path.ToUpperInvariant(), volume, parentId, fileId, hash, length.ToString(CultureInfo.InvariantCulture), time.ToString(CultureInfo.InvariantCulture), attributes.ToString(CultureInfo.InvariantCulture) })));
    }

    private static PinnedParent PinParent(string path, string allowedRoot)
    {
        PinnedParent result = new PinnedParent();
        result.Path = path;
        try
        {
            string parent = ParentPath(path);
            string drive = path.Substring(0, 3);
            string current = drive;
            bool sawRoot = String.Equals(TrimRoot(current), TrimRoot(allowedRoot), StringComparison.OrdinalIgnoreCase);
            SafeFileHandle directory = PinDirectory(current);
            result.Handles.Add(directory);
            string relative = parent.Substring(drive.Length);
            foreach (string component in relative.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
            {
                current = CombinePath(current, component);
                directory = PinDirectory(current);
                result.Handles.Add(directory);
                if (String.Equals(TrimRoot(current), TrimRoot(allowedRoot), StringComparison.OrdinalIgnoreCase)) sawRoot = true;
            }
            if (!sawRoot) throw Fault("FILE_ROOT_INVALID");
            result.ParentInformation = Information(directory);
            return result;
        }
        catch { result.Dispose(); throw; }
    }

    private static SafeFileHandle PinDirectory(string path)
    {
        SafeFileHandle handle = CreateFile(path, 0x80 | 0x20, ShareRead | ShareWrite, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int errorCode = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new FileFault("PARENT_DIRECTORY_UNAVAILABLE", false, new { win32Code = errorCode });
        }
        try
        {
            HandleInformation information = Information(handle);
            if ((information.Attributes & AttributeDirectory) == 0 || (information.Attributes & AttributeReparsePoint) != 0) throw Fault("FILE_PATH_UNSUPPORTED");
            RequireHandlePath(handle, path);
            return handle;
        }
        catch { handle.Dispose(); throw; }
    }

    private static void RequireRegularSingleLink(HandleInformation information)
    {
        if ((information.Attributes & (AttributeDirectory | AttributeReparsePoint)) != 0 || information.NumberOfLinks != 1) throw Fault("FILE_PATH_UNSUPPORTED");
    }

    private static HandleInformation Information(SafeFileHandle handle)
    {
        HandleInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw Fault("FILE_IDENTITY_UNAVAILABLE");
        return information;
    }

    private static void RequireHandlePath(SafeFileHandle handle, string expected)
    {
        StringBuilder buffer = new StringBuilder(512);
        uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length >= buffer.Capacity && length <= MaximumExtendedPathChars)
        {
            buffer = new StringBuilder(checked((int)length + 1));
            length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        }
        if (length == 0 || length >= buffer.Capacity) throw Fault("FILE_IDENTITY_UNAVAILABLE");
        string actual = buffer.ToString();
        if (actual.StartsWith("\\\\?\\", StringComparison.Ordinal)) actual = actual.Substring(4);
        if (!String.Equals(TrimRoot(actual), TrimRoot(expected), StringComparison.OrdinalIgnoreCase)) throw Fault("FILE_PATH_UNSUPPORTED");
    }

    private static void RequireSupportedVolume(string path)
    {
        string drive = path.Substring(0, 3);
        uint serial;
        uint maximumComponentLength;
        uint flags;
        StringBuilder fileSystem = new StringBuilder(64);
        if (GetDriveType(drive) != 3 || !GetVolumeInformation(drive, null, 0, out serial, out maximumComponentLength, out flags, fileSystem, (uint)fileSystem.Capacity) || fileSystem.ToString() != "NTFS") throw Fault("FILE_COMMIT_CAPABILITY_UNAVAILABLE");
        foreach (string component in path.Substring(3).Split('\\')) if (component.Length > maximumComponentLength) throw Fault("FILE_PATH_UNSUPPORTED");
    }

    private static void RenameNew(SafeFileHandle file, string path)
    {
        byte[] encoded = Encoding.Unicode.GetBytes(ExtendedPath(path));
        int size = checked(20 + encoded.Length + 2);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
            Marshal.WriteIntPtr(buffer, 8, IntPtr.Zero);
            Marshal.WriteInt32(buffer, 16, encoded.Length);
            Marshal.Copy(encoded, 0, IntPtr.Add(buffer, 20), encoded.Length);
            if (!SetFileInformationByHandle(file, 3, buffer, (uint)size))
            {
                int errorCode = Marshal.GetLastWin32Error();
                if (errorCode == 80 || errorCode == 183) throw Fault("VERSION_CONFLICT");
                throw new FileFault("CHANGE_PREPARE_FAILED", false, new { win32Code = errorCode });
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static bool MarkStagingForDeletion(SafeFileHandle file)
    {
        IntPtr buffer = Marshal.AllocHGlobal(4);
        try
        {
            Marshal.WriteInt32(buffer, 1);
            return SetFileInformationByHandle(file, 4, buffer, 4);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static void FixWriteTime(SafeFileHandle file)
    {
        ulong value = checked((ulong)DateTime.UtcNow.ToFileTimeUtc());
        NativeFileTime time = new NativeFileTime { Low = (uint)value, High = (uint)(value >> 32) };
        if (!SetFileTime(file, IntPtr.Zero, IntPtr.Zero, ref time)) throw Fault("CHANGE_COMMIT_UNKNOWN");
    }

    private static string SelectRoot(Dictionary<string, object> request, string path)
    {
        object value;
        object[] roots;
        if (!request.TryGetValue("writeRoots", out value) || (roots = value as object[]) == null || roots.Length == 0 || roots.Length > 16) throw Fault("FILE_ROOT_INVALID");
        string selected = null;
        foreach (object rootObject in roots)
        {
            string root = rootObject as string;
            if (root == null) throw Fault("FILE_ROOT_INVALID");
            root = CanonicalPath(root, true);
            string prefix = root.EndsWith("\\", StringComparison.Ordinal) ? root : root + "\\";
            if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && (selected == null || root.Length > selected.Length)) selected = root;
        }
        if (selected == null) throw Fault("FILE_ROOT_INVALID");
        return selected;
    }

    private static string CanonicalPath(string value, bool root)
    {
        if (value.Length > MaximumPathChars || value.IndexOf('\0') >= 0) throw Fault("FILE_PATH_UNSUPPORTED");
        value = value.Replace('/', '\\');
        if (!Regex.IsMatch(value, "\\A[A-Za-z]:\\\\", RegexOptions.CultureInvariant)) throw Fault("FILE_PATH_UNSUPPORTED");
        if (root) value = value.TrimEnd('\\');
        if (root && value.Length == 2) value += "\\";
        string[] components = value.Substring(3).Split('\\');
        foreach (string component in components)
        {
            if (root && value.Length == 3 && component.Length == 0) continue;
            if (component.Length == 0 || component == "." || component == ".." || component.EndsWith(".", StringComparison.Ordinal) || component.EndsWith(" ", StringComparison.Ordinal)) throw Fault("FILE_PATH_UNSUPPORTED");
            foreach (char character in component) { if (character < 32 || "<>:\"|?*".IndexOf(character) >= 0) throw Fault("FILE_PATH_UNSUPPORTED"); }
            if (Regex.IsMatch(component, "\\A(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?\\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) throw Fault("FILE_PATH_UNSUPPORTED");
        }
        string normalized = value;
        if (!root && normalized.Length <= 3) throw Fault("FILE_PATH_UNSUPPORTED");
        return root ? TrimRoot(normalized) : normalized;
    }

    private static string TrimRoot(string path) { return path.Length > 3 ? path.TrimEnd('\\') : path; }

    private static string ExtendedPath(string path) { return "\\\\?\\" + path; }
    private static string ParentPath(string path) { int separator = path.LastIndexOf('\\'); return path.Substring(0, separator == 2 ? 3 : separator); }
    private static string CombinePath(string parent, string name) { return parent.EndsWith("\\", StringComparison.Ordinal) ? parent + name : parent + "\\" + name; }

    private static IEnumerable<string> DirectoryEntries(string path)
    {
        FindData data;
        IntPtr find = FindFirstFile(CombinePath(ExtendedPath(path), "*"), out data);
        if (find == new IntPtr(-1))
        {
            int code = Marshal.GetLastWin32Error();
            if (code == 2 || code == 18) yield break;
            throw new FileFault("FILE_OPEN_FAILED", false, new { win32Code = code });
        }
        try
        {
            while (true)
            {
                if (data.FileName != "." && data.FileName != "..") yield return data.FileName;
                if (FindNextFile(find, out data)) continue;
                int code = Marshal.GetLastWin32Error();
                if (code != 18) throw new FileFault("FILE_OPEN_FAILED", false, new { win32Code = code });
                break;
            }
        }
        finally { FindClose(find); }
    }

    private static Dictionary<string, object> ReadRequest()
    {
        StringBuilder buffer = new StringBuilder();
        char[] chunk = new char[4096];
        int count;
        while ((count = Console.In.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (buffer.Length > MaximumRequestChars - count) throw Fault("FILE_INPUT_LIMIT");
            buffer.Append(chunk, 0, count);
        }
        Dictionary<string, object> request;
        try { request = Json.DeserializeObject(buffer.ToString()) as Dictionary<string, object>; }
        catch (Exception) { throw Fault("FILE_INPUT_INVALID"); }
        if (request == null) throw Fault("FILE_INPUT_INVALID");
        return request;
    }

    private static void ValidateFields(Dictionary<string, object> request)
    {
        foreach (string key in request.Keys)
        {
            if (key != "protocolVersion" && key != "operation" && key != "writeRoots" && key != "path" && key != "expectedVersion" && key != "contentBase64" && key != "contentEncoding" && key != "allowInPlace"
                && key != "createdFromAbsent" && key != "expectedSha256" && key != "sourceActionId"
                && key != "destinationPath" && key != "expectedDestinationVersion" && key != "deletionApproved") throw Fault("FILE_INPUT_INVALID");
        }
        object version;
        if (!request.TryGetValue("protocolVersion", out version) || !(version is int) || (int)version != 1) throw Fault("FILE_PROTOCOL_UNSUPPORTED");
    }

    private static void ValidateOperationFields(Dictionary<string, object> request, string operation)
    {
        string[] specific = operation == "inspect" ? new string[0]
            : operation == "commit" ? new[] { "expectedVersion", "contentBase64", "contentEncoding", "allowInPlace" }
            : operation == "move" ? new[] { "expectedVersion", "destinationPath", "expectedDestinationVersion", "sourceActionId" }
            : operation == "delete" ? new[] { "expectedVersion", "deletionApproved", "sourceActionId" }
            : operation == "mkdir" ? new[] { "expectedVersion", "sourceActionId" }
            : operation == "restore_created_directory" ? new[] { "expectedVersion", "createdFromAbsent", "sourceActionId" }
            : new[] { "expectedVersion", "createdFromAbsent", "expectedSha256", "sourceActionId" };
        foreach (string key in request.Keys)
        {
            if (key != "protocolVersion" && key != "operation" && key != "path" && key != "writeRoots" && Array.IndexOf(specific, key) < 0) throw Fault("FILE_INPUT_INVALID");
        }
    }

    private static string StringField(Dictionary<string, object> request, string name)
    {
        object value;
        string result;
        if (!request.TryGetValue(name, out value) || (result = value as string) == null) throw Fault("FILE_INPUT_INVALID");
        return result;
    }

    private static string RequiredString(Dictionary<string, object> request, string name)
    {
        string result = StringField(request, name);
        if (result.Length == 0) throw Fault("FILE_INPUT_INVALID");
        return result;
    }

    private static string HashBytes(byte[] bytes) { using (SHA256 algorithm = SHA256.Create()) { return Hex(algorithm.ComputeHash(bytes)); } }
    private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    private static FileFault Fault(string code) { return new FileFault(code, false, null); }

    private static void WriteSuccess(object data)
    {
        Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = true, data = data }));
        Console.Out.Flush();
    }

    private static int WriteFailure(string code, bool mayHaveStarted, object details)
    {
        try
        {
            string message = code == "FILE_TEXT_ENCODING_INVALID" ? "Invalid UTF-8 text was rejected before writing; read the file and use patch_file oldText/newText or appendText."
                : "The controlled file operation did not complete; inspect its receipt before retrying.";
            Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = false, error = new { code = code, message = message, retryable = false, mayHaveStarted = mayHaveStarted, details = details } }));
            Console.Out.Flush();
        }
        catch (Exception) { }
        return 1;
    }
}
