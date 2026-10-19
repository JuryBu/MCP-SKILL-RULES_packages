import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "./helpers/powershell-process.mjs";

test("WinPS child preserves custom variables and loads native modules below a PS7 parent", { skip: process.platform !== "win32" }, () => {
  const executable = path.win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference='Stop'",
    "[pscustomobject]@{major=$PSVersionTable.PSVersion.Major;hashModule=(Get-Command Get-FileHash -ErrorAction Stop).ModuleName;secureModule=(Get-Command ConvertTo-SecureString -ErrorAction Stop).ModuleName;sentinel=$env:NAPCAT_MODULE_TEST_SENTINEL}|ConvertTo-Json -Compress",
  ].join("; ");
  const observed = JSON.parse(execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, PSMODULEPATH: "C:\\unavailable-ps7-modules", NAPCAT_MODULE_TEST_SENTINEL: "preserved" },
  }));
  assert.deepEqual(observed, { major: 5, hashModule: "Microsoft.PowerShell.Utility", secureModule: "Microsoft.PowerShell.Security", sentinel: "preserved" });
});
