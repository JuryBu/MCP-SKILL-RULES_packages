import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyNapCatProcesses } from "../src/napcat-process-identity.mjs";

const root = String.raw`C:\Fixture\NapCat`;
const helperPath = fileURLToPath(new URL("../ops/napcat-process-identity.ps1", import.meta.url));
const cases = [];
const record = (name, commandLine, overrides = {}) => ({
  ProcessId: 900001, ParentProcessId: 900000, Name: name,
  ExecutablePath: `C:\\Tools\\${name}`, CommandLine: commandLine,
  CreationDate: "2026-10-19T08:00:00Z", ...overrides,
});
const expected = (owned = [], ordinary = [], unknown = []) => ({ owned, ordinary, unknown });
const ids = (classification) => Object.fromEntries(["owned", "ordinary", "unknown"].map((group) => [group, classification[group].map((item) => item.ProcessId).sort()]));

for (const count of [1, 2, 3, 4]) {
  cases.push({ name: `unrelated Python with ${count} leading quotes`, processes: [
    record("cmd.exe", `cmd.exe /d /s /c ${'"'.repeat(count)}C:\\Tools\\Python\\python.exe" "C:\\Tools\\worker.py""`),
  ], expected: expected() });
  cases.push({ name: `NapCat launcher with ${count} leading quotes`, processes: [
    record("cmd.exe", `cmd.exe /d /s /c ${'"'.repeat(count)}${root}\\launcher-user.bat" --fixture"`),
  ], expected: expected([900001]) });
}
cases.push({ name: "quoted Python path containing spaces", processes: [record("cmd.exe", 'cmd.exe /d /s /c """C:\\Tools With Spaces\\python.exe" "C:\\Tools\\worker.py""')], expected: expected() });
cases.push({ name: "single outer quote wraps Python executable and arguments", processes: [record("cmd.exe", 'cmd.exe /d /s /c "C:\\Tools\\Python\\python.exe -b -u "C:\\Tools\\worker.py"')], expected: expected() });
cases.push({ name: "single outer quote with ambiguous unrelated spaced path", processes: [record("cmd.exe", 'cmd.exe /d /s /c "C:\\Tools With Spaces\\Python\\python.exe -b -u "C:\\Tools\\worker.py"')], expected: expected() });
cases.push({ name: "single outer quote wraps NapCat executable and arguments", processes: [record("cmd.exe", `cmd.exe /d /s /c "${root}\\launcher-user.bat --fixture "C:\\Tools\\worker.py"`)], expected: expected([900001]) });
cases.push({ name: "quoted NapCat executable with spaces remains owned", napcatRoot: "C:\\Fixture Apps\\NapCat", processes: [record("cmd.exe", 'cmd.exe /d /s /c ""C:\\Fixture Apps\\NapCat\\launcher-user.bat" --fixture"')], expected: expected([900001]) });
cases.push({ name: "ambiguous whole-command quoting around spaced NapCat path stays unknown", napcatRoot: "C:\\Fixture Apps\\NapCat", processes: [record("cmd.exe", 'cmd.exe /d /s /c "C:\\Fixture Apps\\NapCat\\launcher-user.bat --fixture "C:\\Tools\\worker.py"')], expected: expected([], [], [900001]) });

for (const invalid of ['"C:\\Tools\\QQ.exe', "C:\\Tools\\bad|name.exe", "C:\\Tools\\bad\u0000name.exe", "C:\\Tools\\bad:name.exe"]) {
  cases.push({ name: `invalid QQ executable ${JSON.stringify(invalid)}`, processes: [
    record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ExecutablePath: invalid, ModuleScanState: "ok", ModulePaths: ["C:\\Tools\\QQ.exe"] }),
  ], expected: expected([], [], [900001]) });
}
cases.push({ name: "invalid BootMain executable cannot use command fallback", processes: [record("NapCatWinBootMain.exe", `"${root}\\NapCatWinBootMain.exe"`, { ExecutablePath: '"' + root + "\\NapCatWinBootMain.exe" })], expected: expected([], [], [900001]) });
cases.push({ name: "invalid node entry remains unknown", processes: [record("node.exe", `node.exe "${root}\\bad|index.js"`)], expected: expected([], [], [900001]) });
cases.push({ name: "invalid BootMain command outside root remains unknown", processes: [record("NapCatWinBootMain.exe", '"C:\\Tools\\bad|NapCatWinBootMain.exe"')], expected: expected([], [], [900001]) });
cases.push({ name: "canonical nested launcher path remains owned", processes: [record("cmd.exe", `cmd.exe /d /s /c """${root}\\sub\\..\\launcher-user.bat" --fixture"`)], expected: expected([900001]) });
cases.push({ name: "canonical node path remains owned", processes: [record("node.exe", `node.exe --inspect "${root}\\sub\\..\\index.js"`)], expected: expected([900001]) });
cases.push({ name: "unrelated echo argument cannot grant ownership", processes: [record("cmd.exe", `cmd.exe /c echo "${root}\\launcher-user.bat"`)], expected: expected() });
cases.push({ name: "directory prefix collision cannot grant ownership", processes: [record("cmd.exe", `cmd.exe /c "${root}-backup\\launcher-user.bat"`)], expected: expected() });
cases.push({ name: "invalid cmd entry cannot use textual launcher prefix", processes: [record("cmd.exe", `cmd.exe /c "${root}\\launcher-user.bat"bad`)], expected: expected([], [], [900001]) });
cases.push({ name: "malformed cmd path under NapCat root remains unknown", processes: [record("cmd.exe", `cmd.exe /c "${root}\\bad|launcher-user.bat"`)], expected: expected([], [], [900001]) });
cases.push({ name: "invalid module inventory cannot classify QQ as ordinary", processes: [record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ModuleScanState: "ok", ModulePaths: ['"' + root + "\\NapCatWinBootHook.dll"] })], expected: expected([], [], [900001]) });
cases.push({ name: "valid hook still proves ownership alongside invalid unrelated module", processes: [record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ModuleScanState: "ok", ModulePaths: ['"C:\\Tools\\bad.dll', `${root}\\NapCatWinBootHook.dll`] })], expected: expected([900001]) });
cases.push({ name: "unknown child cannot inherit ordinary classification", processes: [
  record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ModuleScanState: "ok", ModulePaths: ["C:\\Tools\\QQ.exe"] }),
  record("QQ.exe", '"C:\\Tools\\QQ.exe" --type=renderer', { ProcessId: 900002, ParentProcessId: 900001, ModuleScanState: "ok", ModulePaths: ['"C:\\Tools\\bad.dll'] }),
], expected: expected([], [900001], [900002]) });
cases.push({ name: "unrelated nested command does not remove owned and ordinary records", processes: [
  record("cmd.exe", 'cmd.exe /d /s /c """C:\\Tools\\Python\\python.exe" "C:\\Tools\\worker.py""'),
  record("NapCatWinBootMain.exe", `"${root}\\NapCatWinBootMain.exe"`, { ProcessId: 900002, ExecutablePath: `${root}\\NapCatWinBootMain.exe` }),
  record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ProcessId: 900003, ModuleScanState: "ok", ModulePaths: ["C:\\Tools\\QQ.exe"] }),
], expected: expected([900002], [900003]) });
cases.push({ name: "proven NapCat and ordinary QQ descendants remain separate", processes: [
  record("NapCatWinBootMain.exe", `"${root}\\NapCatWinBootMain.exe"`, { ExecutablePath: `${root}\\NapCatWinBootMain.exe` }),
  record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ProcessId: 900002, ParentProcessId: 900001, ModuleScanState: "unknown" }),
  record("QQ.exe", '"C:\\Tools\\QQ.exe"', { ProcessId: 900003, ModuleScanState: "ok", ModulePaths: ["C:\\Tools\\QQ.exe"] }),
  record("QQ.exe", '"C:\\Tools\\QQ.exe" --type=renderer', { ProcessId: 900004, ParentProcessId: 900003, ModuleScanState: "ok", ModulePaths: ["C:\\Tools\\QQ.exe"] }),
], expected: expected([900001, 900002], [900003, 900004]) });

for (const fixture of cases) {
  test(`JS invalid-path regression: ${fixture.name}`, () => {
    assert.deepEqual(ids(classifyNapCatProcesses(fixture.processes, fixture.napcatRoot ?? root)), fixture.expected);
  });
}
test("JS invalid NapCat root fails closed", () => {
  assert.throws(() => classifyNapCatProcesses([], "C:\\bad|root"), /NAPCAT_PROCESS_SCAN_UNKNOWN/);
});

for (const shell of [
  { major: 5, executable: process.env.NAPCAT_IDENTITY_TEST_PS5 || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") },
  { major: 7, executable: process.env.NAPCAT_IDENTITY_TEST_PS7 || path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe") },
]) {
  test(`PS${shell.major} invalid-path regression and JS parity`, { skip: process.platform !== "win32" || !fs.existsSync(shell.executable) }, async (context) => {
    const command = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. '${helperPath.replaceAll("'", "''")}'
$Options = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $Options.DateKind = 'String' }
$Fixtures = [Console]::In.ReadToEnd() | ConvertFrom-Json @Options
$Results = foreach ($Fixture in $Fixtures) {
  try {
    $FixtureRoot = if ($Fixture.napcatRoot) { [string]$Fixture.napcatRoot } else { '${root}' }
    $Classification = Get-NapCatProcessClassification -Processes @($Fixture.processes) -NapCatRoot $FixtureRoot
    [pscustomobject]@{ name=$Fixture.name; classification=$Classification }
  } catch { [pscustomobject]@{ name=$Fixture.name; error=$_.Exception.Message; position=$_.InvocationInfo.PositionMessage } }
}
$RootError = ''
try { Get-NapCatProcessClassification -Processes @() -NapCatRoot 'C:\\bad|root' | Out-Null } catch { $RootError = $_.Exception.Message }
$script:StopSnapshot = @($Fixtures | Where-Object name -eq 'invalid node entry remains unknown')[0].processes
function Get-NapCatOwnershipSnapshot { return $script:StopSnapshot }
$StopError = ''
try { Stop-NapCatVerifiedProcesses -Processes @() -NapCatRoot '${root}' | Out-Null } catch { $StopError = $_.Exception.Message }
[pscustomobject]@{ major=$PSVersionTable.PSVersion.Major; version=$PSVersionTable.PSVersion.ToString(); results=@($Results); rootError=$RootError; stopError=$StopError } | ConvertTo-Json -Depth 20 -Compress
`;
    const execution = spawnSync(shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      input: JSON.stringify(cases), encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr);
    const response = JSON.parse(execution.stdout.replace(/^\uFEFF/, "").trim());
    assert.equal(response.major, shell.major);
    assert.match(response.rootError, /NAPCAT_PROCESS_SCAN_UNKNOWN/);
    assert.match(response.stopError, /NAPCAT_PROCESS_SCAN_UNKNOWN/);
    context.diagnostic(`runtime=${response.version}; fixtures=${cases.length}`);
    for (const fixture of cases) {
      await context.test(fixture.name, () => {
        const result = response.results.find((item) => item.name === fixture.name);
        assert.equal(result.error, undefined, `${result.error}\n${result.position}`);
        assert.deepEqual(ids(result.classification), fixture.expected);
        assert.deepEqual(ids(result.classification), ids(classifyNapCatProcesses(fixture.processes, fixture.napcatRoot ?? root)));
      });
    }
  });
}
