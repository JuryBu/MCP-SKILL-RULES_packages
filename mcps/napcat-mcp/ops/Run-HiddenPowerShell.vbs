Option Explicit

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2
End If

Dim shell, powerShellExe, scriptPath, command, exitCode, index, argument
Set shell = CreateObject("WScript.Shell")
powerShellExe = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
scriptPath = WScript.Arguments(0)
command = Chr(34) & powerShellExe & Chr(34) & _
    " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & _
    Chr(34) & Replace(scriptPath, Chr(34), Chr(34) & Chr(34)) & Chr(34)

For index = 1 To WScript.Arguments.Count - 1
    argument = WScript.Arguments(index)
    If Left(argument, 1) = "-" And InStr(argument, " ") = 0 Then
        command = command & " " & argument
    Else
        command = command & " " & Chr(34) & Replace(argument, Chr(34), Chr(34) & Chr(34)) & Chr(34)
    End If
Next

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
