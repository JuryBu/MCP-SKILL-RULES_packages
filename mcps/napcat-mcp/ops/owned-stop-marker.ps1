$OwnedStopMarkerType = 'NapCat.OwnedStopMarker.Native' -as [type]
if ($OwnedStopMarkerType) {
    $OwnedStopMarkerRevision = $OwnedStopMarkerType.GetField('ImplementationRevision')
    if (-not $OwnedStopMarkerRevision -or $OwnedStopMarkerRevision.GetValue($null) -ne 'dcs-v2') {
        throw 'OWNED_STOP_MARKER_FRESH_PARENT_REQUIRED'
    }
}
if (-not $OwnedStopMarkerType) {
    Add-Type -AssemblyName System.Runtime.Serialization
    $OwnedStopMarkerSerializationAssembly = [System.Runtime.Serialization.Json.DataContractJsonSerializer].Assembly.Location
    if (-not [IO.File]::Exists($OwnedStopMarkerSerializationAssembly)) { throw 'OWNED_STOP_MARKER_SERIALIZATION_UNAVAILABLE' }
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $OwnedStopMarkerReferenceRoot = Join-Path $PSHOME 'ref'
        if (-not [IO.Directory]::Exists($OwnedStopMarkerReferenceRoot)) { throw 'OWNED_STOP_MARKER_REFERENCE_PACK_UNAVAILABLE' }
        $OwnedStopMarkerReferences = @([IO.Directory]::GetFiles($OwnedStopMarkerReferenceRoot, '*.dll'))
    } else {
        $OwnedStopMarkerReferences = @(
            [System.Uri].Assembly.Location,
            [System.Linq.Enumerable].Assembly.Location,
            $OwnedStopMarkerSerializationAssembly,
            [System.Xml.XmlDictionaryReader].Assembly.Location,
            [System.Xml.XmlReader].Assembly.Location
        ) | Select-Object -Unique
    }
    Add-Type -ReferencedAssemblies $OwnedStopMarkerReferences -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using Microsoft.Win32.SafeHandles;

namespace NapCat.OwnedStopMarker {
    public sealed class Evidence {
        public string Path { get; internal set; }
        public string Component { get; internal set; }
        public string AttemptId { get; internal set; }
        public string OperationId { get; internal set; }
        public string FileId { get; internal set; }
        public string RecordSha256 { get; internal set; }
        public string ExpiresUtc { get; internal set; }
        public int OwnerProcessId { get; internal set; }
        public string State { get; internal set; }
        public string PathState { get; internal set; }
        public bool DispositionApplied { get; internal set; }
        public bool LeaseReleased { get; internal set; }
    }

    public sealed class Lease : IDisposable {
        internal SafeFileHandle Handle;
        internal byte[] Bytes;
        internal Dictionary<string, object> Record;
        internal readonly object Sync = new object();
        internal string Identity;
        internal string Hash;
        internal DateTime Deadline;
        internal string CurrentState = "Held";
        public string Path { get; internal set; }
        public string Component { get { return (string)Record["component"]; } }
        public string AttemptId { get { return (string)Record["attemptId"]; } }
        public string OperationId { get { return (string)Record["operationId"]; } }
        public string State { get { return CurrentState; } }
        internal Lease() { }
        public void Dispose() { Native.DisposeLease(this); }
        public override string ToString() { return "OwnedStopMarker.Lease(" + CurrentState + ")"; }
    }

    public static class Native {
        public const string ImplementationRevision = "dcs-v2";
        const uint ReadAccess = 0x80000000, WriteAccess = 0x40000000, DeleteAccess = 0x00010000;
        const uint ShareRead = 1, ShareAll = 7, CreateNew = 1, OpenExisting = 3;
        const uint Normal = 0x80, OpenReparse = 0x00200000;
        const string RecordSchema = "napcat.owned-stop-marker/v1";
        const string ProofSchema = "napcat.owned-stop-marker-proof/v1";
        static readonly HashSet<Lease> Active = new HashSet<Lease>();
        static readonly object RegistrySync = new object();
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        static readonly int ProcessId = Process.GetCurrentProcess().Id;
        static readonly string ProcessStart = Process.GetCurrentProcess().StartTime.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

        [StructLayout(LayoutKind.Sequential)]
        struct FileIdentity { public ulong VolumeSerialNumber; public ulong Low; public ulong High; }
        [StructLayout(LayoutKind.Sequential)]
        struct FileStandard { public long AllocationSize; public long EndOfFile; public uint NumberOfLinks; public byte DeletePending; public byte Directory; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        struct FileDisposition { public byte DeleteFile; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool FlushFileBuffers(SafeFileHandle handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long position, uint origin);
        [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetIdentity(SafeFileHandle handle, int infoClass, out FileIdentity info, uint size);
        [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetStandard(SafeFileHandle handle, int infoClass, out FileStandard info, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FileDisposition info, uint size);

        static InvalidOperationException Fail(string code) { return new InvalidOperationException("OWNED_STOP_MARKER_" + code); }
        static InvalidOperationException Win32(string code) { return Fail(code + "_WIN32_" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture)); }
        static DataContractJsonSerializer Serializer() {
            return new DataContractJsonSerializer(typeof(Dictionary<string, object>), new DataContractJsonSerializerSettings { UseSimpleDictionaryFormat = true, MaxItemsInObjectGraph = 32 });
        }
        static string Serialize(Dictionary<string, object> values) {
            using (MemoryStream stream = new MemoryStream()) { Serializer().WriteObject(stream, values); return Utf8.GetString(stream.ToArray()); }
        }
        static string Hash(byte[] bytes) { using (SHA256 algorithm = SHA256.Create()) { return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); } }
        static string Text(Dictionary<string, object> values, string key) {
            object value;
            if (!values.TryGetValue(key, out value) || !(value is string) || ((string)value).Length == 0) throw Fail("INVALID_FIELD");
            return (string)value;
        }
        static void Identifier(string value) { if (value == null || !Regex.IsMatch(value, "\\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\z")) throw Fail("INVALID_IDENTIFIER"); }
        static DateTime Timestamp(string value) {
            DateTime result;
            if (!DateTime.TryParseExact(value, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out result) || result.Kind != DateTimeKind.Utc) throw Fail("INVALID_TIMESTAMP");
            return result;
        }
        static string Canonical(string path) {
            if (String.IsNullOrWhiteSpace(path)) throw Fail("INVALID_PATH");
            string value = path.Replace('/', '\\');
            if (!Regex.IsMatch(value, "\\A[A-Za-z]:\\\\") || value.Length >= 260 || value.IndexOf(':', 2) >= 0 || value.IndexOfAny(new char[] { '*', '?', '"', '<', '>', '|' }) >= 0) throw Fail("INVALID_PATH");
            string[] segments = value.Substring(3).Split('\\');
            foreach (string segment in segments) {
                if (segment.Length == 0 || segment == "." || segment == ".." || segment.EndsWith(".") || segment.EndsWith(" ") || Regex.IsMatch(segment, "\\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\\.|\\z)", RegexOptions.IgnoreCase)) throw Fail("INVALID_PATH");
            }
            try { return System.IO.Path.GetFullPath(value); } catch { throw Fail("INVALID_PATH"); }
        }
        static void ParentDirectories(string path) {
            string directory = System.IO.Path.GetDirectoryName(path);
            while (!String.IsNullOrEmpty(directory)) {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(directory); } catch { throw Fail("PARENT_UNAVAILABLE"); }
                if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) throw Fail("UNSAFE_PARENT");
                directory = System.IO.Path.GetDirectoryName(directory);
            }
        }
        static string Identity(SafeFileHandle handle) {
            FileIdentity identity;
            if (!GetIdentity(handle, 18, out identity, (uint)Marshal.SizeOf(typeof(FileIdentity)))) throw Win32("IDENTITY");
            return identity.VolumeSerialNumber.ToString("x16") + "-" + identity.High.ToString("x16") + identity.Low.ToString("x16");
        }
        static void ObjectPath(SafeFileHandle handle, string expected) {
            StringBuilder actual = new StringBuilder(1024);
            uint length = GetFinalPathNameByHandleW(handle, actual, (uint)actual.Capacity, 0);
            if (length == 0 || length >= actual.Capacity) throw Fail("PATH_UNAVAILABLE");
            string value = actual.ToString();
            if (value.StartsWith("\\\\?\\", StringComparison.Ordinal)) value = value.Substring(4);
            if (!String.Equals(value, expected, StringComparison.OrdinalIgnoreCase)) throw Fail("PATH_MISMATCH");
        }
        static byte[] Bytes(SafeFileHandle handle) {
            FileStandard standard;
            if (!GetStandard(handle, 1, out standard, (uint)Marshal.SizeOf(typeof(FileStandard)))) throw Win32("STANDARD_INFO");
            if (standard.Directory != 0 || standard.DeletePending != 0 || standard.NumberOfLinks != 1 || standard.EndOfFile <= 0 || standard.EndOfFile > 4096) throw Fail("INVALID_OBJECT");
            byte[] buffer = new byte[(int)standard.EndOfFile];
            long position;
            uint read;
            if (!SetFilePointerEx(handle, 0, out position, 0)) throw Win32("SEEK");
            if (!ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero)) throw Win32("READ");
            if (read != buffer.Length) throw Fail("SHORT_READ");
            return buffer;
        }
        static Dictionary<string, object> Parse(string json, int count) {
            if (json == null || json.Length == 0 || json.Length > 8192) throw Fail("INVALID_JSON");
            try {
                byte[] bytes = Utf8.GetBytes(json);
                XmlDictionaryReaderQuotas quotas = new XmlDictionaryReaderQuotas { MaxDepth = 4, MaxStringContentLength = 8192, MaxArrayLength = 32, MaxBytesPerRead = 4096, MaxNameTableCharCount = 2048 };
                HashSet<string> keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                using (XmlDictionaryReader reader = JsonReaderWriterFactory.CreateJsonReader(bytes, quotas)) {
                    reader.MoveToContent();
                    if (reader.Depth != 0 || reader.GetAttribute("type") != "object") throw Fail("INVALID_JSON");
                    while (reader.Read()) {
                        if (reader.NodeType != XmlNodeType.Element) continue;
                        if (reader.Depth != 1 || !keys.Add(reader.LocalName)) throw Fail("INVALID_JSON");
                        string requiredType = reader.LocalName == "ownerProcessId" ? "number" : "string";
                        if (reader.GetAttribute("type") != requiredType) throw Fail("INVALID_JSON");
                    }
                }
                if (keys.Count != count) throw Fail("INVALID_JSON");
                using (MemoryStream stream = new MemoryStream(bytes, false)) {
                    Dictionary<string, object> values = Serializer().ReadObject(stream) as Dictionary<string, object>;
                    if (values == null || values.Count != count) throw Fail("INVALID_JSON");
                    return values;
                }
            } catch { throw Fail("INVALID_JSON"); }
        }
        static void Record(Dictionary<string, object> record) {
            if (Text(record, "schema") != RecordSchema) throw Fail("SCHEMA_MISMATCH");
            Identifier(Text(record, "component")); Identifier(Text(record, "attemptId"));
            Guid operation;
            if (!Guid.TryParseExact(Text(record, "operationId"), "D", out operation) || operation == Guid.Empty) throw Fail("INVALID_OPERATION");
            if (!Regex.IsMatch(Text(record, "ownerToken"), "\\A[0-9a-f]{64}\\z")) throw Fail("INVALID_TOKEN");
            object owner;
            if (!record.TryGetValue("ownerProcessId", out owner) || !(owner is int) || (int)owner <= 0) throw Fail("INVALID_OWNER");
            Timestamp(Text(record, "ownerProcessStartedUtc"));
            DateTime created = Timestamp(Text(record, "createdUtc")), expires = Timestamp(Text(record, "expiresUtc"));
            if (expires <= created || expires - created > TimeSpan.FromDays(1) || created > DateTime.UtcNow || DateTime.UtcNow >= expires) throw Fail("EXPIRED_OR_INVALID_LIFETIME");
        }
        static Lease Resolve(object value) {
            Lease lease = value as Lease;
            if (lease == null) throw Fail("INVALID_LEASE");
            lock (RegistrySync) { if (!Active.Contains(lease)) throw Fail("INACTIVE_LEASE"); }
            if ((int)lease.Record["ownerProcessId"] != ProcessId || lease.CurrentState != "Held" || lease.Handle.IsClosed || lease.Handle.IsInvalid) throw Fail("INACTIVE_LEASE");
            return lease;
        }
        static void Binding(Lease lease, string path, string component, string attemptId, string operationId) {
            if (!String.Equals(Canonical(path), lease.Path, StringComparison.OrdinalIgnoreCase) || component != lease.Component || attemptId != lease.AttemptId || operationId != lease.OperationId) throw Fail("BINDING_MISMATCH");
        }
        static void Verify(Lease lease) {
            Resolve(lease);
            Record(lease.Record);
            ObjectPath(lease.Handle, lease.Path);
            if (Identity(lease.Handle) != lease.Identity || Hash(Bytes(lease.Handle)) != lease.Hash) throw Fail("OBJECT_MISMATCH");
        }
        static Evidence Receipt(Lease lease) {
            return new Evidence { Path = lease.Path, Component = lease.Component, AttemptId = lease.AttemptId, OperationId = lease.OperationId, FileId = lease.Identity, RecordSha256 = lease.Hash, ExpiresUtc = (string)lease.Record["expiresUtc"], OwnerProcessId = (int)lease.Record["ownerProcessId"], State = lease.CurrentState, PathState = "Held", LeaseReleased = false };
        }
        public static Dictionary<string, int> Layout() {
            return new Dictionary<string, int> { { "FileDispositionInfo", Marshal.SizeOf(typeof(FileDisposition)) }, { "FileIdInfo", Marshal.SizeOf(typeof(FileIdentity)) }, { "FileStandardInfo", Marshal.SizeOf(typeof(FileStandard)) } };
        }
        public static Lease Create(string path, string component, string attemptId, int lifetimeSeconds) {
            Identifier(component); Identifier(attemptId);
            if (lifetimeSeconds < 1 || lifetimeSeconds > 86400) throw Fail("INVALID_LIFETIME");
            string canonical = Canonical(path); ParentDirectories(canonical);
            byte[] random = new byte[32];
            using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) { generator.GetBytes(random); }
            DateTime created = DateTime.UtcNow;
            Dictionary<string, object> record = new Dictionary<string, object> {
                { "schema", RecordSchema }, { "component", component }, { "attemptId", attemptId },
                { "operationId", Guid.NewGuid().ToString("D") }, { "ownerToken", BitConverter.ToString(random).Replace("-", "").ToLowerInvariant() },
                { "ownerProcessId", ProcessId }, { "ownerProcessStartedUtc", ProcessStart },
                { "createdUtc", created.ToString("O", CultureInfo.InvariantCulture) }, { "expiresUtc", created.AddSeconds(lifetimeSeconds).ToString("O", CultureInfo.InvariantCulture) }
            };
            byte[] bytes = Utf8.GetBytes(Serialize(record));
            SafeFileHandle handle = CreateFileW(canonical, ReadAccess | WriteAccess | DeleteAccess, ShareRead, IntPtr.Zero, CreateNew, Normal | OpenReparse, IntPtr.Zero);
            if (handle.IsInvalid) { Exception error = Win32("CREATE_NEW"); handle.Dispose(); throw error; }
            try {
                ObjectPath(handle, canonical);
                uint written;
                if (!WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero)) throw Win32("WRITE");
                if (written != bytes.Length) throw Fail("SHORT_WRITE");
                if (!FlushFileBuffers(handle)) throw Win32("FLUSH");
                Lease lease = new Lease { Path = canonical, Handle = handle, Bytes = bytes, Record = record, Identity = Identity(handle), Hash = Hash(bytes), Deadline = created.AddSeconds(lifetimeSeconds) };
                lock (RegistrySync) { Active.Add(lease); }
                try { Verify(lease); } catch { DisposeLease(lease); throw; }
                return lease;
            } catch { handle.Dispose(); throw; }
        }
        public static Evidence Assert(object value, string path, string component, string attemptId, string operationId) {
            Lease lease = Resolve(value);
            lock (lease.Sync) { Binding(lease, path, component, attemptId, operationId); Verify(lease); return Receipt(lease); }
        }
        public static string ExportProof(object value, string path, string component, string attemptId, string operationId) {
            Lease lease = Resolve(value);
            lock (lease.Sync) {
                Binding(lease, path, component, attemptId, operationId); Verify(lease);
                Dictionary<string, object> proof = new Dictionary<string, object>(lease.Record);
                proof["schema"] = ProofSchema; proof["recordSchema"] = RecordSchema;
                proof["path"] = lease.Path; proof["fileId"] = lease.Identity; proof["recordSha256"] = lease.Hash;
                return Serialize(proof);
            }
        }
        static void Holder(Dictionary<string, object> record, string path) {
            try {
                using (Process owner = Process.GetProcessById((int)record["ownerProcessId"])) {
                    if (owner.HasExited || owner.StartTime.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) != Text(record, "ownerProcessStartedUtc")) throw Fail("HOLDER_UNAVAILABLE");
                }
            } catch { throw Fail("HOLDER_UNAVAILABLE"); }
            foreach (uint access in new uint[] { WriteAccess, DeleteAccess }) {
                SafeFileHandle probe = CreateFileW(path, access, ShareAll, IntPtr.Zero, OpenExisting, Normal | OpenReparse, IntPtr.Zero);
                int error = Marshal.GetLastWin32Error();
                bool blocked = probe.IsInvalid;
                probe.Dispose();
                if (!blocked || error != 32) throw Fail("HOLD_NOT_OBSERVED");
            }
        }
        public static Evidence AssertProof(string json, string path, string component, string attemptId, string operationId) {
            Dictionary<string, object> proof = Parse(json, 13);
            if (Text(proof, "schema") != ProofSchema || Text(proof, "recordSchema") != RecordSchema) throw Fail("SCHEMA_MISMATCH");
            string canonical = Canonical(path);
            if (!String.Equals(Canonical(Text(proof, "path")), canonical, StringComparison.OrdinalIgnoreCase) || Text(proof, "component") != component || (!String.IsNullOrEmpty(attemptId) && Text(proof, "attemptId") != attemptId) || (!String.IsNullOrEmpty(operationId) && Text(proof, "operationId") != operationId)) throw Fail("BINDING_MISMATCH");
            SafeFileHandle reader = CreateFileW(canonical, ReadAccess, ShareAll, IntPtr.Zero, OpenExisting, Normal | OpenReparse, IntPtr.Zero);
            if (reader.IsInvalid) { Exception error = Win32("PROOF_READ"); reader.Dispose(); throw error; }
            using (reader) {
                ObjectPath(reader, canonical);
                string identity = Identity(reader);
                byte[] bytes = Bytes(reader);
                string hash = Hash(bytes);
                if (identity != Text(proof, "fileId") || hash != Text(proof, "recordSha256")) throw Fail("OBJECT_MISMATCH");
                Dictionary<string, object> record = Parse(Utf8.GetString(bytes), 9); Record(record);
                foreach (KeyValuePair<string, object> field in record) {
                    object expected;
                    if (field.Key == "schema") expected = proof["recordSchema"];
                    else if (!proof.TryGetValue(field.Key, out expected)) throw Fail("INVALID_PROOF");
                    if (!Object.Equals(field.Value, expected)) throw Fail("RECORD_MISMATCH");
                }
                Holder(record, canonical);
                if (Identity(reader) != identity || Hash(Bytes(reader)) != hash) throw Fail("OBJECT_MISMATCH");
                return new Evidence { Path = canonical, Component = (string)record["component"], AttemptId = (string)record["attemptId"], OperationId = (string)record["operationId"], FileId = identity, RecordSha256 = hash, ExpiresUtc = (string)record["expiresUtc"], OwnerProcessId = (int)record["ownerProcessId"], State = "ReadOnlyVerified", PathState = "Held" };
            }
        }
        static string PathState(string path) {
            SafeFileHandle probe = CreateFileW(path, 0, ShareAll, IntPtr.Zero, OpenExisting, Normal | OpenReparse, IntPtr.Zero);
            int error = Marshal.GetLastWin32Error();
            bool invalid = probe.IsInvalid;
            probe.Dispose();
            if (!invalid) return "Present";
            if (error == 2 || error == 3) return "Missing";
            return "Unavailable";
        }
        public static Evidence Consume(object value, string path, string component, string attemptId, string operationId) {
            Lease lease = Resolve(value);
            lock (lease.Sync) {
                Binding(lease, path, component, attemptId, operationId); Verify(lease);
                FileDisposition disposition = new FileDisposition { DeleteFile = 1 };
                if (!SetFileInformationByHandle(lease.Handle, 4, ref disposition, (uint)Marshal.SizeOf(typeof(FileDisposition)))) throw Win32("DISPOSITION");
                lease.CurrentState = "Consumed";
                lease.Handle.Dispose();
                lock (RegistrySync) { Active.Remove(lease); }
                Evidence receipt = Receipt(lease);
                receipt.DispositionApplied = true; receipt.LeaseReleased = true; receipt.PathState = PathState(lease.Path);
                return receipt;
            }
        }
        public static Evidence Close(object value) {
            Lease lease = Resolve(value);
            lock (lease.Sync) { Resolve(lease); DisposeLease(lease); Evidence receipt = Receipt(lease); receipt.LeaseReleased = true; receipt.PathState = PathState(lease.Path); return receipt; }
        }
        internal static void DisposeLease(Lease lease) {
            lock (lease.Sync) {
                if (lease.CurrentState != "Held") return;
                lease.Handle.Dispose(); lease.CurrentState = "Preserved";
                lock (RegistrySync) { Active.Remove(lease); }
            }
        }
    }
}
'@
}

function New-OwnedStopMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [ValidateRange(1, 86400)][int]$LifetimeSeconds = 1800
    )
    [NapCat.OwnedStopMarker.Native]::Create($Path, $Component, $AttemptId, $LifetimeSeconds)
}

function Assert-OwnedStopMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Lease,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [string]$OperationId
    )
    if (-not $OperationId -and $Lease -is [NapCat.OwnedStopMarker.Lease]) { $OperationId = $Lease.OperationId }
    [NapCat.OwnedStopMarker.Native]::Assert($Lease, $Path, $Component, $AttemptId, $OperationId)
}

function Read-OwnedStopMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Lease,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [string]$OperationId
    )
    Assert-OwnedStopMarker @PSBoundParameters
}

function Export-OwnedStopMarkerProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Lease,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [string]$OperationId
    )
    if (-not $OperationId -and $Lease -is [NapCat.OwnedStopMarker.Lease]) { $OperationId = $Lease.OperationId }
    [NapCat.OwnedStopMarker.Native]::ExportProof($Lease, $Path, $Component, $AttemptId, $OperationId)
}

function Assert-OwnedStopMarkerProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProofJson,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component,
        [string]$AttemptId,
        [string]$OperationId
    )
    [NapCat.OwnedStopMarker.Native]::AssertProof($ProofJson, $Path, $Component, $AttemptId, $OperationId)
}

function Consume-OwnedStopMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Lease,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Component,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [string]$OperationId
    )
    if (-not $OperationId -and $Lease -is [NapCat.OwnedStopMarker.Lease]) { $OperationId = $Lease.OperationId }
    [NapCat.OwnedStopMarker.Native]::Consume($Lease, $Path, $Component, $AttemptId, $OperationId)
}

function Close-OwnedStopMarker {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][object]$Lease)
    [NapCat.OwnedStopMarker.Native]::Close($Lease)
}
