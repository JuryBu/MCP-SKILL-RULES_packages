import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourcePath = fileURLToPath(new URL("../ops/hidden-powershell-host.cs", import.meta.url));
const hash = async filename => crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex");

test("GUI host starts a pinned PowerShell script without a console and preserves arguments and exit status", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "napcat-hidden-host-"));
  try {
    const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const executable = path.join(root, "hidden-powershell-host.exe");
    const compiled = spawnSync(compiler, ["/nologo", "/target:winexe", `/out:${executable}`, sourcePath], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const binary = await fs.readFile(executable);
    const portableHeader = binary.readUInt32LE(0x3c);
    assert.equal(binary.readUInt16LE(portableHeader + 24 + 68), 2);
    const scriptDirectory = path.join(root, "scripts");
    await fs.mkdir(scriptDirectory);
    const script = path.join(scriptDirectory, "中文 fixture.ps1");
    const output = path.join(root, "result.json");
    await fs.writeFile(script, "\uFEFF" + [
      "param([string]$OutputPath,[string]$Value)",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ConsoleProbe { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }'",
      "$writeBlocked=$false;try {[IO.File]::WriteAllText($PSCommandPath,'replaced')} catch {$writeBlocked=$true}",
      "$renameBlocked=$false;try {[IO.Directory]::Move($PSScriptRoot,($PSScriptRoot+'-replaced'))} catch {$renameBlocked=$true}",
      "$payload=[ordered]@{consoleHandle=[ConsoleProbe]::GetConsoleWindow().ToInt64();value=$Value;processId=$PID;writeBlocked=$writeBlocked;renameBlocked=$renameBlocked;workingDirectory=[Environment]::CurrentDirectory;environment=$env:NAPCAT_HOST_ENV_FIXTURE}",
      "[IO.File]::WriteAllText($OutputPath,($payload|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))",
      "exit 7",
    ].join("\r\n"), "utf8");
    const powershell = process.env.NAPCAT_HIDDEN_HOST_TEST_POWERSHELL ?? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const shellHash = await hash(powershell);
    const scriptHash = await hash(script);
    const value = '中文 spaces "quoted" trailing\\';
    const run = spawnSync(executable, [powershell, shellHash, script, scriptHash, "-OutputPath", output, "-Value", value], { encoding: "utf8", cwd: root, env: { ...process.env, NAPCAT_HOST_ENV_FIXTURE: "inherited" }, windowsHide: false, timeout: 15_000 });
    assert.equal(run.status, 7, run.stdout + run.stderr);
    const payload = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(payload.consoleHandle, 0);
    assert.equal(payload.value, value);
    assert.equal(payload.writeBlocked, true);
    assert.equal(payload.renameBlocked, true);
    assert.equal(path.resolve(payload.workingDirectory), path.resolve(root));
    assert.equal(payload.environment, "inherited");
    await fs.rm(output);
    const wrongShell = spawnSync(executable, [powershell, "0".repeat(64), script, scriptHash], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    assert.equal(wrongShell.status, 64);
    await assert.rejects(fs.access(output));
    const wrongScript = spawnSync(executable, [powershell, shellHash, script, "0".repeat(64)], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    assert.equal(wrongScript.status, 64);
    const relativeScript = spawnSync(executable, [powershell, shellHash, "fixture.ps1", scriptHash], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    assert.equal(relativeScript.status, 64);
    await assert.rejects(fs.access(output));
    console.log(JSON.stringify({ guiSubsystem: 2, consoleHandle: payload.consoleHandle, exitStatus: run.status, writeBlocked: payload.writeBlocked, renameBlocked: payload.renameBlocked, workingDirectoryPreserved: true, environmentPreserved: true, launcherWindowsHide: false, negativeChecks: 3, productionActions: 0 }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
