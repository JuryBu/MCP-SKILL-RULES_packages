using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

internal static class AgentSecretVault
{
    private const int MaximumSecretBytes = 65536;
    private const int MaximumRequestChars = 196608;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaximumRequestChars, RecursionLimit = 8 };
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    private sealed class VaultFault : Exception
    {
        internal readonly string Code;
        internal readonly bool MayHaveStarted;

        internal VaultFault(string code, bool mayHaveStarted) { Code = code; MayHaveStarted = mayHaveStarted; }
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, out ProcessBasicInformation information, int informationLength, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool IsTokenRestricted(IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Main(string[] args)
    {
        try
        {
            Console.InputEncoding = Utf8;
            Console.OutputEncoding = Utf8;
            if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) throw new VaultFault("VAULT_PLATFORM_UNAVAILABLE", false);
            if (args.Length == 1 && args[0] == "--capabilities")
            {
                WriteSuccess(new { backend = "dpapi-current-user-v1", protocolVersion = 1, maximumSecretBytes = MaximumSecretBytes, input = "stdin-json", decryptedOutput = "parent-owned-named-pipe", parentIdentity = "os-parent-pid", unprotectRestrictedTokenAllowed = false, plaintextStdout = false });
                return 0;
            }
            if (args.Length != 0 || !Console.IsInputRedirected) throw new VaultFault("VAULT_INPUT_INVALID", false);
            Dictionary<string, object> request = ReadRequest();
            ValidateFields(request);
            string operation = RequiredString(request, "operation");
            string purpose = RequiredString(request, "purpose");
            if (purpose.Length > 512 || purpose.IndexOf('\0') >= 0) throw new VaultFault("VAULT_INPUT_INVALID", false);
            byte[] entropy = Utf8.GetBytes("sandbox-agent-secret-vault/v1\n" + purpose);
            try
            {
                if (operation == "protect") return Protect(request, entropy);
                if (operation == "unprotect") return Unprotect(request, entropy);
                throw new VaultFault("VAULT_OPERATION_UNSUPPORTED", false);
            }
            finally { Array.Clear(entropy, 0, entropy.Length); }
        }
        catch (VaultFault fault) { return WriteFailure(fault.Code, fault.MayHaveStarted); }
        catch (Exception) { return WriteFailure("VAULT_INPUT_INVALID", false); }
    }

    private static int Protect(Dictionary<string, object> request, byte[] entropy)
    {
        if (request.ContainsKey("ciphertextBase64") || request.ContainsKey("responsePipe")) throw new VaultFault("VAULT_INPUT_INVALID", false);
        byte[] plaintext = Decode(request, "secretBase64", MaximumSecretBytes);
        byte[] ciphertext = null;
        try
        {
            ciphertext = ProtectedData.Protect(plaintext, entropy, DataProtectionScope.CurrentUser);
            WriteSuccess(new { format = "dpapi-current-user-v1", scope = "CurrentUser", ciphertextBase64 = Convert.ToBase64String(ciphertext) });
            return 0;
        }
        catch (Exception) { throw new VaultFault("VAULT_PROTECT_FAILED", false); }
        finally
        {
            Array.Clear(plaintext, 0, plaintext.Length);
            if (ciphertext != null) Array.Clear(ciphertext, 0, ciphertext.Length);
        }
    }

    private static int Unprotect(Dictionary<string, object> request, byte[] entropy)
    {
        if (request.ContainsKey("secretBase64")) throw new VaultFault("VAULT_INPUT_INVALID", false);
        RequireUnrestrictedExecutionToken();
        string pipeName = RequiredString(request, "responsePipe");
        if (!Regex.IsMatch(pipeName, "\\Asandbox-agent-vault-[a-f0-9]{32}\\z", RegexOptions.CultureInvariant)) throw new VaultFault("VAULT_PARENT_CHANNEL_INVALID", false);
        byte[] ciphertext = Decode(request, "ciphertextBase64", MaximumSecretBytes + 16384);
        byte[] plaintext = null;
        bool deliveryStarted = false;
        try
        {
            using (NamedPipeClientStream pipe = OpenParentPipe(pipeName))
            {
                try { plaintext = ProtectedData.Unprotect(ciphertext, entropy, DataProtectionScope.CurrentUser); }
                catch (Exception) { throw new VaultFault("VAULT_UNPROTECT_FAILED", false); }
                if (plaintext.Length == 0 || plaintext.Length > MaximumSecretBytes) throw new VaultFault("VAULT_UNPROTECT_FAILED", false);
                using (StreamWriter writer = new StreamWriter(pipe, Utf8, 4096, true))
                {
                    string response = Json.Serialize(new { protocolVersion = 1, ok = true, data = new { secretBase64 = Convert.ToBase64String(plaintext) } });
                    deliveryStarted = true;
                    writer.WriteLine(response);
                    writer.Flush();
                }
            }
            WriteSuccess(new { scope = "CurrentUser", delivered = true, channel = "parent-owned-named-pipe" });
            return 0;
        }
        catch (VaultFault) { throw; }
        catch (Exception) { throw new VaultFault(deliveryStarted ? "VAULT_DELIVERY_UNKNOWN" : "VAULT_PARENT_CHANNEL_UNAVAILABLE", deliveryStarted); }
        finally
        {
            Array.Clear(ciphertext, 0, ciphertext.Length);
            if (plaintext != null) Array.Clear(plaintext, 0, plaintext.Length);
        }
    }

    private static void RequireUnrestrictedExecutionToken()
    {
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!OpenProcessToken(new IntPtr(-1), 0x8, out token)) throw new VaultFault("VAULT_EXECUTION_IDENTITY_UNAVAILABLE", false);
            if (IsTokenRestricted(token)) throw new VaultFault("VAULT_RESTRICTED_CALLER_UNSUPPORTED", false);
        }
        finally { if (token != IntPtr.Zero) CloseHandle(token); }
    }

    private static NamedPipeClientStream OpenParentPipe(string pipeName)
    {
        ProcessBasicInformation information;
        int returned;
        int size = Marshal.SizeOf(typeof(ProcessBasicInformation));
        if (NtQueryInformationProcess(new IntPtr(-1), 0, out information, size, out returned) != 0 || returned < size) throw new VaultFault("VAULT_PARENT_IDENTITY_UNAVAILABLE", false);
        long parentId = information.InheritedFromUniqueProcessId.ToInt64();
        if (parentId <= 0 || parentId > UInt32.MaxValue) throw new VaultFault("VAULT_PARENT_IDENTITY_UNAVAILABLE", false);
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out, PipeOptions.None, TokenImpersonationLevel.Identification);
        try
        {
            pipe.Connect(5000);
            uint serverProcessId;
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverProcessId) || serverProcessId != (uint)parentId) throw new VaultFault("VAULT_PARENT_CHANNEL_INVALID", false);
            return pipe;
        }
        catch
        {
            pipe.Dispose();
            throw;
        }
    }

    private static Dictionary<string, object> ReadRequest()
    {
        StringBuilder buffer = new StringBuilder();
        char[] chunk = new char[4096];
        int count;
        while ((count = Console.In.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (buffer.Length > MaximumRequestChars - count) throw new VaultFault("VAULT_INPUT_INVALID", false);
            buffer.Append(chunk, 0, count);
            Array.Clear(chunk, 0, count);
        }
        Dictionary<string, object> request = Json.DeserializeObject(buffer.ToString()) as Dictionary<string, object>;
        if (request == null) throw new VaultFault("VAULT_INPUT_INVALID", false);
        return request;
    }

    private static void ValidateFields(Dictionary<string, object> request)
    {
        foreach (string key in request.Keys)
        {
            if (key != "protocolVersion" && key != "operation" && key != "purpose" && key != "secretBase64" && key != "ciphertextBase64" && key != "responsePipe") throw new VaultFault("VAULT_INPUT_INVALID", false);
        }
        object version;
        if (!request.TryGetValue("protocolVersion", out version) || !(version is int) || (int)version != 1) throw new VaultFault("VAULT_PROTOCOL_UNSUPPORTED", false);
    }

    private static string RequiredString(Dictionary<string, object> request, string name)
    {
        object value;
        string result;
        if (!request.TryGetValue(name, out value) || (result = value as string) == null || result.Length == 0) throw new VaultFault("VAULT_INPUT_INVALID", false);
        return result;
    }

    private static byte[] Decode(Dictionary<string, object> request, string name, int maximumBytes)
    {
        byte[] result;
        try { result = Convert.FromBase64String(RequiredString(request, name)); }
        catch (Exception) { throw new VaultFault("VAULT_INPUT_INVALID", false); }
        if (result.Length == 0 || result.Length > maximumBytes)
        {
            Array.Clear(result, 0, result.Length);
            throw new VaultFault("VAULT_INPUT_INVALID", false);
        }
        return result;
    }

    private static void WriteSuccess(object data)
    {
        Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = true, data = data }));
        Console.Out.Flush();
    }

    private static int WriteFailure(string code, bool mayHaveStarted)
    {
        try
        {
            Console.Out.WriteLine(Json.Serialize(new { protocolVersion = 1, ok = false, error = new { code = code, message = "The protected credential operation did not complete.", retryable = false, mayHaveStarted = mayHaveStarted } }));
            Console.Out.Flush();
        }
        catch (Exception) { }
        return 1;
    }
}
