import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("account recovery validates legacy and shared profile layouts without executing startup", { skip: process.platform !== "win32" }, () => {
  const sourcePath = fileURLToPath(new URL("../ops/start-napcat-account-recovery.ps1", import.meta.url));
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$Tokens = $null
$ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($env:NAPCAT_PROFILE_TEST_SOURCE, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw 'Source parse failed' }
$Definition = $Ast.Find({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Resolve-StartupQqProfile' }, $true)
if ($null -eq $Definition) { throw 'Profile function missing' }
. ([scriptblock]::Create($Definition.Extent.Text))
$ExpectedAccountId = '900000001'
function Test-Path { param([string]$LiteralPath, [string]$PathType) return $LiteralPath -in @('C:\Fixture\QQ', 'C:\Fixture\QQ\900000001') }
$Cases = @(
  @{ name='legacy default'; account='900000001'; qqUserDataDir='C:\Fixture\QQ' },
  @{ name='legacy explicit'; account='900000001'; qqUserDataDir='C:\Fixture\QQ'; qqProfileLayout='legacy_numeric' },
  @{ name='shared'; account='900000001'; qqUserDataDir='C:\Fixture\QQ'; qqProfileLayout='shared_root'; qqUserDataDirArgument='--user-data-dir="C:\Fixture\QQ"' },
  @{ name='shared missing argument'; account='900000001'; qqUserDataDir='C:\Fixture\QQ'; qqProfileLayout='shared_root' },
  @{ name='different argument'; account='900000001'; qqUserDataDir='C:\Fixture\QQ'; qqProfileLayout='shared_root'; qqUserDataDirArgument='--user-data-dir="C:\Other\QQ"' },
  @{ name='relative path'; account='900000001'; qqUserDataDir='relative\QQ' },
  @{ name='unknown layout'; account='900000001'; qqUserDataDir='C:\Fixture\QQ'; qqProfileLayout='unknown' },
  @{ name='wrong account'; account='900000002'; qqUserDataDir='C:\Fixture\QQ' },
  @{ name='missing profile'; account='900000001'; qqUserDataDir='C:\Missing\QQ' }
)
$Results = @(foreach ($Case in $Cases) {
  try { $Result = Resolve-StartupQqProfile ([pscustomobject]$Case); [pscustomobject]@{name=$Case.name; layout=$Result.layout; authenticationVerified=$Result.authenticationVerified} }
  catch { [pscustomobject]@{name=$Case.name; error=$_.Exception.Message} }
})
$Results | ConvertTo-Json -Compress
`;
  const output = execFileSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, NAPCAT_PROFILE_TEST_SOURCE: sourcePath },
  });
  const results = JSON.parse(output.trim());
  assert.deepEqual(results.slice(0, 3).map((result) => result.layout), ["legacy_numeric", "legacy_numeric", "shared_root"]);
  for (const result of results.slice(0, 3)) assert.equal(result.authenticationVerified, false);
  assert.deepEqual(results.slice(3).map((result) => result.error), [
    "[STARTUP_PROFILE_ARGUMENT_MISMATCH]", "[STARTUP_PROFILE_ARGUMENT_MISMATCH]", "[STARTUP_IDENTITY_DRIFT]",
    "[STARTUP_PROFILE_LAYOUT_UNKNOWN]", "[STARTUP_ACCOUNT_MISMATCH]", "[STARTUP_PROFILE_MISSING]",
  ]);
});
