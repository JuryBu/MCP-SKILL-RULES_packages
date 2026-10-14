using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

internal static class HiddenPowerShellHost
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    private sealed class PinnedFile : IDisposable
    {
        internal readonly string PathValue;
        private readonly List<IDisposable> handles = new List<IDisposable>();

        internal PinnedFile(string value, string expectedHash, string extension)
        {
        try
        {
        if (!Regex.IsMatch(expectedHash ?? "", "^[a-f0-9]{64}$") ||
            !Regex.IsMatch(value ?? "", @"^[A-Za-z]:[\\/]") ||
            Regex.IsMatch(value.Substring(2), @"(^|[\\/])\.{1,2}([\\/]|$)") ||
            value.Substring(2).IndexOf(':') >= 0 ||
            value.IndexOf('"') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            throw new InvalidOperationException("PINNED_PATH_INVALID");
        string fullPath = Path.GetFullPath(value);
        if (!String.Equals(Path.GetExtension(fullPath), extension, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("PINNED_FILE_EXTENSION_INVALID");
        List<string> parents = new List<string>();
        for (DirectoryInfo parent = Directory.GetParent(fullPath); parent != null; parent = parent.Parent)
            parents.Add(parent.FullName);
        parents.Reverse();
        foreach (string parent in parents)
        {
            SafeFileHandle directory = CreateFile(parent, 0, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (directory.IsInvalid)
            {
                directory.Dispose();
                throw new InvalidOperationException("PINNED_DIRECTORY_LOCK_FAILED");
            }
            handles.Add(directory);
            if ((File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("PINNED_DIRECTORY_REPARSE_POINT");
        }
        FileAttributes attributes = File.GetAttributes(fullPath);
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new InvalidOperationException("PINNED_FILE_NOT_REGULAR");
        FileStream stream = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        handles.Add(stream);
        using (SHA256 algorithm = SHA256.Create())
        {
            string actualHash = BitConverter.ToString(algorithm.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(actualHash, expectedHash, StringComparison.Ordinal))
                throw new InvalidOperationException("PINNED_FILE_HASH_CHANGED");
        }
        PathValue = fullPath;
        }
        catch
        {
            Dispose();
            throw;
        }
        }

        public void Dispose()
        {
            for (int index = handles.Count - 1; index >= 0; index--)
                handles[index].Dispose();
            handles.Clear();
        }
    }

    private static string Quote(string value)
    {
        if (value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0)
            throw new InvalidOperationException("ARGUMENT_CONTROL_CHARACTER");
        StringBuilder quoted = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
                quoted.Append('\\', backslashes * 2 + 1);
            else
                quoted.Append('\\', backslashes);
            quoted.Append(character);
            backslashes = 0;
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    [STAThread]
    private static int Main(string[] arguments)
    {
        try
        {
            if (arguments.Length < 4)
                throw new InvalidOperationException("PINNED_POWERSHELL_AND_SCRIPT_REQUIRED");
            using (PinnedFile executablePin = new PinnedFile(arguments[0], arguments[1], ".exe"))
            using (PinnedFile scriptPin = new PinnedFile(arguments[2], arguments[3], ".ps1"))
            {
            string executable = executablePin.PathValue;
            string executableName = Path.GetFileName(executable);
            if (!String.Equals(executableName, "pwsh.exe", StringComparison.OrdinalIgnoreCase) &&
                !String.Equals(executableName, "powershell.exe", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("POWERSHELL_EXECUTABLE_REQUIRED");
            string script = scriptPin.PathValue;
            StringBuilder command = new StringBuilder("-NoLogo -NoProfile -NonInteractive -File ");
            command.Append(Quote(script));
            for (int index = 4; index < arguments.Length; index++)
            {
                command.Append(' ');
                command.Append(Quote(arguments[index]));
            }
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = executable;
            start.Arguments = command.ToString();
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process child = Process.Start(start))
            {
                if (child == null)
                    throw new InvalidOperationException("POWERSHELL_START_FAILED");
                child.WaitForExit();
                return child.ExitCode;
            }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 64;
        }
    }
}
