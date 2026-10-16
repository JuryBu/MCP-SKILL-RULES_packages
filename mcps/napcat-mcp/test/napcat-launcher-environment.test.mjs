import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourcePath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
const shellPath = process.env.NAPCAT_TEST_POWERSHELL ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const environmentNames = ["NAPCAT_PATCH_PACKAGE", "NAPCAT_LOAD_PATH", "NAPCAT_INJECT_PATH", "NAPCAT_LAUNCHER_PATH", "NAPCAT_MAIN_PATH"];

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runEnvironmentCase(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat launcher 中文-"));
  const markerPath = path.join(root, "probe-started.txt");
  try {
    if (mode !== "missing") fs.writeFileSync(path.join(root, "qqnt.json"), "{}\n", "utf8");
    const childScript = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText(${quotePowerShell(markerPath)}, 'started'); $result = @{}; foreach ($name in @(${environmentNames.map(quotePowerShell).join(",")})) { $result[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }; $result | ConvertTo-Json -Compress`;
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(sourcePath)}, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -gt 0) { throw ($parseErrors | Out-String) }
$blocks = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.Contains("EnvironmentVariables['NAPCAT_PATCH_PACKAGE']") }, $true))
if ($blocks.Count -ne 1) { throw 'Expected exactly one launcher environment block' }
$NapCatRoot = ${quotePowerShell(root)}
$QqExePath = ${quotePowerShell(mode === "implicit" ? "" : path.join(root, "QQ.exe"))}
$LoaderModule = Join-Path $NapCatRoot 'loadNapCat.js'
$HookModule = Join-Path $NapCatRoot 'NapCatWinBootHook.dll'
$BootMain = Join-Path $NapCatRoot 'NapCatWinBootMain.exe'
$CoreModule = Join-Path $NapCatRoot 'napcat.mjs'
$names = @(${environmentNames.map(quotePowerShell).join(",")})
foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, 'inherited-value', 'Process') }
$StartInfo = New-Object Diagnostics.ProcessStartInfo
$StartInfo.FileName = ${quotePowerShell(shellPath)}
$StartInfo.Arguments = '-NoLogo -NoProfile -EncodedCommand ${Buffer.from(childScript, "utf16le").toString("base64")}'
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = $true
$StartInfo.RedirectStandardOutput = $true
$StartInfo.RedirectStandardError = $true
$StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
try {
  . ([scriptblock]::Create($blocks[0].Extent.Text))
  $environmentSnapshot = @{}
  foreach ($name in $names) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -ne 'inherited-value') { throw 'Parent environment changed' }
    $environmentSnapshot[$name] = $StartInfo.EnvironmentVariables[$name]
  }
  $child = [Diagnostics.Process]::Start($StartInfo)
  $stdout = $child.StandardOutput.ReadToEnd()
  $stderr = $child.StandardError.ReadToEnd()
  $child.WaitForExit()
  if ($child.ExitCode -ne 0) { throw $stderr }
  @{ state='passed'; configured=$environmentSnapshot; child=($stdout | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 5
} catch {
  @{ state='rejected'; error=$_.Exception.Message; launched=(Test-Path -LiteralPath ${quotePowerShell(markerPath)}) } | ConvertTo-Json -Compress
}
`;
    const result = spawnSync(shellPath, ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return { root, result: JSON.parse(result.stdout.trim()), launched: fs.existsSync(markerPath) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("explicit QQ launcher passes all five official paths to its child only", { skip: process.platform !== "win32" }, () => {
  const { root, result, launched } = runEnvironmentCase("explicit");
  assert.equal(result.state, "passed", result.error);
  const expected = {
    NAPCAT_PATCH_PACKAGE: path.join(root, "qqnt.json"),
    NAPCAT_LOAD_PATH: path.join(root, "loadNapCat.js"),
    NAPCAT_INJECT_PATH: path.join(root, "NapCatWinBootHook.dll"),
    NAPCAT_LAUNCHER_PATH: path.join(root, "NapCatWinBootMain.exe"),
    NAPCAT_MAIN_PATH: path.join(root, "napcat.mjs").replaceAll("\\", "/"),
  };
  assert.deepEqual(result.configured, expected);
  assert.deepEqual(result.child, expected);
  assert.equal(launched, true);
});

test("implicit launcher leaves the inherited launcher environment unchanged", { skip: process.platform !== "win32" }, () => {
  const { result } = runEnvironmentCase("implicit");
  assert.equal(result.state, "passed", result.error);
  const expected = Object.fromEntries(environmentNames.map(name => [name, "inherited-value"]));
  assert.deepEqual(result.configured, expected);
  assert.deepEqual(result.child, expected);
});

test("explicit launcher rejects a missing package template before starting a child", { skip: process.platform !== "win32" }, () => {
  const { result, launched } = runEnvironmentCase("missing");
  assert.equal(result.state, "rejected");
  assert.match(result.error, /NAPCAT_RUNTIME_INCOMPLETE/);
  assert.equal(result.launched, false);
  assert.equal(launched, false);
});
