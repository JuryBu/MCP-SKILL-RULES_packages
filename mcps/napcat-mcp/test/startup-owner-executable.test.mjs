import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

test("owner executable accepts pinned hardlinks while writable paths stay strict", { skip: process.platform !== "win32" }, () => {
  const template = process.env.NAPCAT_OWNER_EXEC_TEMPLATE_TEST || fileURLToPath(new URL("../ops/startup-repair-files.template.ps1", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-owner-executable-"));
  const shell = windowsPowerShellEnvironment();
  const source = fs.readFileSync(template, "utf8");
  assert.match(source, /OWNER_EXECUTABLE_PATH_INVALID/u);
  assert.match(source, /CommandLine -match 'app-server\|mcp-http-broker\|sandbox-data/u);
  let succeeded = false;
  try {
    const script = `
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:OWNER_TEMPLATE,[ref]$tokens,[ref]$errors)
if ($errors.Count) {throw 'TEMPLATE_PARSE_FAILED'}
$definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Plain','OwnerExecutable')},$false) | ForEach-Object {$_.Extent.Text})
if ($definitions.Count -ne 2) {throw 'HELPER_SCOPE_CHANGED'}
. ([scriptblock]::Create(($definitions -join [char]10)))
$root=$env:OWNER_TEST_ROOT
$regular=Join-Path $root 'regular.exe'
[IO.File]::WriteAllBytes($regular,[byte[]]@(1,2,3,4))
$hash=(Get-FileHash -LiteralPath $regular -Algorithm SHA256).Hash.ToLowerInvariant()
$linked=Join-Path $root 'linked.exe'
$null=New-Item -ItemType HardLink -Path $linked -Target $regular
$accepted=0;$rejected=0
function Accept([scriptblock]$action) {& $action | Out-Null;$script:accepted++}
function Reject([scriptblock]$action,[string]$expected) {try {& $action | Out-Null;throw 'UNEXPECTED_ACCEPT'} catch {if ($_.Exception.Message -cne $expected) {throw};$script:rejected++}}
Accept {OwnerExecutable $regular $hash}
Accept {OwnerExecutable $linked $hash}
$system=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$systemHash=(Get-FileHash -LiteralPath $system -Algorithm SHA256).Hash.ToLowerInvariant()
Accept {OwnerExecutable $system $systemHash}
Reject {Plain $linked} 'PATH_LINK_FORBIDDEN'
Reject {OwnerExecutable $linked ''} 'PATH_LINK_FORBIDDEN'
Reject {OwnerExecutable $linked ('0'*64)} 'OWNER_POWERSHELL_IDENTITY_CHANGED'
Reject {OwnerExecutable (Join-Path $root '.\\linked.exe') $hash} 'OWNER_EXECUTABLE_PATH_INVALID'
$text=Join-Path $root 'script.ps1'
[IO.File]::Copy($regular,$text)
Reject {OwnerExecutable $text $hash} 'OWNER_EXECUTABLE_PATH_INVALID'
$folder=Join-Path $root 'directory.exe'
$null=New-Item -ItemType Directory -Path $folder
Reject {OwnerExecutable $folder $hash} 'PATH_LINK_FORBIDDEN'
$junction=Join-Path $root 'alias'
$null=New-Item -ItemType Junction -Path $junction -Target $root
Reject {OwnerExecutable (Join-Path $junction 'regular.exe') $hash} 'PATH_LINK_FORBIDDEN'
$ads=Join-Path $root 'ads.exe'
[IO.File]::Copy($regular,$ads)
Set-Content -LiteralPath $ads -Stream 'unexpected' -Value 'preserve guard'
Reject {OwnerExecutable $ads $hash} 'PATH_ADS_FORBIDDEN'
[ordered]@{accepted=$accepted;rejected=$rejected;systemExecutableLinkType=(Get-Item -LiteralPath $system -Force).LinkType;productionActions=0} | ConvertTo-Json -Compress
`;
    const result = spawnSync(shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...shell.environment, OWNER_TEMPLATE: template, OWNER_TEST_ROOT: root },
      encoding: "utf8", windowsHide: true, timeout: 30000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.accepted, 3);
    assert.equal(report.rejected, 8);
    assert.equal(report.productionActions, 0);
    console.log(JSON.stringify(report));
    succeeded = true;
  } finally {
    if (succeeded) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.error(JSON.stringify({ retainedFixtureRoot: root }));
  }
});
