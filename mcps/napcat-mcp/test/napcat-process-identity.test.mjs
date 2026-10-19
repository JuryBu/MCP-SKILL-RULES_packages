import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyNapCatProcesses } from "../src/napcat-process-identity.mjs";

const root = String.raw`C:\FixtureApps\NapCat`;
const qqExecutable = String.raw`C:\FixtureApps\Tencent\QQ.exe`;
const profile = String.raw`C:\FixtureData\Tencent\QQ`;
const older = "2026-10-19T01:00:00.0000000Z";
const current = "2026-10-19T01:00:01.0000000Z";
const newer = "2026-10-19T01:00:02.0000000Z";
const helperPath = fileURLToPath(new URL("../ops/napcat-process-identity.ps1", import.meta.url));

function qq(processId, overrides = {}) {
  return {
    ProcessId: processId,
    ParentProcessId: 4,
    Name: "QQ.exe",
    ExecutablePath: qqExecutable,
    CommandLine: `"${qqExecutable}" --user-data-dir="${profile}"`,
    CreationDate: current,
    ModuleScanState: "ok",
    ModulePaths: [qqExecutable, String.raw`C:\Windows\System32\kernel32.dll`],
    ...overrides,
  };
}

function boot(processId, overrides = {}) {
  return {
    ProcessId: processId,
    ParentProcessId: 4,
    Name: "NapCatWinBootMain.exe",
    ExecutablePath: `${root}\\NapCatWinBootMain.exe`,
    CommandLine: `"${root}\\NapCatWinBootMain.exe"`,
    CreationDate: older,
    ...overrides,
  };
}

function renderer(processId, parentProcessId, overrides = {}) {
  return qq(processId, {
    ParentProcessId: parentProcessId,
    CommandLine: `"${qqExecutable}" --type=renderer --user-data-dir="${profile}"`,
    ...overrides,
  });
}

function processRecord(processId, name, commandLine, overrides = {}) {
  return {
    ProcessId: processId,
    ParentProcessId: 4,
    Name: name,
    ExecutablePath: `C:\\FixtureTools\\${name}`,
    CommandLine: commandLine,
    CreationDate: current,
    ...overrides,
  };
}

function groups({ owned = [], ordinary = [], unknown = [] } = {}) {
  return { owned, ordinary, unknown };
}

function ids(classification) {
  return Object.fromEntries(["owned", "ordinary", "unknown"].map((category) => {
    assert.ok(Array.isArray(classification[category]), `${category} must be an array`);
    return [category, classification[category].map((record) => Number(record.ProcessId)).sort((left, right) => left - right)];
  }));
}

const cases = [];

function addCase(name, processes, expected, napcatRoot = root) {
  cases.push({ name, processes, expected: groups(expected), napcatRoot });
}

addCase("ordinary QQ parent and child share the NapCat exe and default profile", [
  qq(100, { CreationDate: older }), renderer(101, 100), renderer(102, 101, { CreationDate: newer }),
], { ordinary: [100, 101, 102] });

addCase("BootMain descendants coexist with ordinary QQ using the same exe and profile", [
  renderer(203, 202, { CreationDate: newer }), renderer(202, 201),
  qq(201, { ParentProcessId: 200 }), boot(200), qq(210), renderer(211, 210),
], { owned: [200, 201, 202, 203], ordinary: [210, 211] });

addCase("owned cmd and node intermediate descendants propagate ownership", [
  renderer(224, 223), qq(223, { ParentProcessId: 222 }),
  processRecord(222, "node.exe", "node worker.mjs", { ParentProcessId: 221 }),
  processRecord(221, "cmd.exe", "cmd /c worker.bat", { ParentProcessId: 220 }), boot(220),
], { owned: [220, 221, 222, 223, 224] });

addCase("orphaned QQ with a loaded NapCat hook remains protected", [
  qq(300, { ParentProcessId: 999, ModulePaths: [`${root}\\NapCatWinBootHook.dll`] }),
  renderer(301, 300), qq(302),
], { owned: [300, 301], ordinary: [302] });

addCase("ordinary QQ inside NapCat directory does not inherit ownership from unrelated modules", [
  qq(303, { ExecutablePath: `${root}\\QQ\\QQ.exe`, ModulePaths: [`${root}\\QQ\\resources\\app\\qq.dll`] }),
  qq(304, { ModulePaths: [`${root}\\native.node`] }),
], { ordinary: [303, 304] });

addCase("canonical entry paths grant ownership only to actual launcher entries", [
  processRecord(305, "node.exe", `node "${root}\\sub\\..\\index.js"`),
  processRecord(306, "cmd.exe", `cmd /c "${root}\\sub\\..\\launcher-user.bat"`),
  boot(307, { ExecutablePath: null, CommandLine: `"${root}\\sub\\..\\NapCatWinBootMain.exe"` }),
], { owned: [305, 306, 307] });

for (const name of ["QQNT.exe", "QQEX.exe", "qq", "QQNT", "qqex"]) {
  addCase(`${name} supports ordinary trees and hook ownership`, [
    qq(310, { Name: name, CreationDate: older }), renderer(311, 310, { Name: name }),
    qq(312, { Name: name, ModulePaths: [`${root}\\NapCatWinBootHook.dll`] }),
  ], { owned: [312], ordinary: [310, 311] });
}

addCase("unreadable modules fail closed even when the command mentions NapCat", [
  qq(320, { CommandLine: `"${qqExecutable}" --note="${root}"`, ModuleScanState: "unknown", ModulePaths: [] }),
  renderer(321, 320),
], { unknown: [320, 321] });

addCase("missing module scan state fails closed", [qq(322, { ModuleScanState: undefined })], { unknown: [322] });
addCase("stale hook inventory with unknown state cannot grant ownership", [
  qq(323, { ModuleScanState: "unknown", ModulePaths: [`${root}\\NapCatWinBootHook.dll`] }),
], { unknown: [323] });
addCase("an unknown-module ordinary child stays unknown", [
  qq(324), renderer(325, 324, { ModuleScanState: "unknown" }),
], { ordinary: [324], unknown: [325] });
addCase("proven BootMain ancestry protects a child even when modules are unreadable", [
  boot(326), qq(327, { ParentProcessId: 326, ModuleScanState: "unknown" }),
], { owned: [326, 327] });

addCase("empty null and whitespace root commands fail closed", [
  qq(330, { CommandLine: "" }), qq(331, { CommandLine: null }), qq(332, { CommandLine: "  \t " }),
], { unknown: [330, 331, 332] });
addCase("a detached renderer stays unknown after its unobserved root exited", [renderer(333, 999)], { unknown: [333] });
addCase("missing creation time prevents ordinary classification", [qq(334, { CreationDate: null })], { unknown: [334] });
addCase("an ISO-looking creation time without a timezone fails closed", [
  qq(335, { CreationDate: "2026-10-19T01:00:01.123456" }),
], { unknown: [335] });

addCase("PID reuse cannot attach an older renderer to a newer BootMain", [
  boot(340, { CreationDate: newer }), renderer(341, 340, { CreationDate: older }),
], { owned: [340], unknown: [341] });
addCase("PID reuse cannot attach an older renderer to a newer ordinary QQ", [
  qq(342, { CreationDate: newer }), renderer(343, 342, { CreationDate: older }),
], { ordinary: [342], unknown: [343] });
addCase("unknown child or parent birth cannot establish ownership", [
  boot(344), renderer(345, 344, { CreationDate: "invalid" }),
  boot(346, { CreationDate: null }), renderer(347, 346),
], { owned: [344, 346], unknown: [345, 347] });
addCase("self-parented and cyclic renderers stay unknown", [
  renderer(348, 348), renderer(349, 350), renderer(350, 349),
], { unknown: [348, 349, 350] });
addCase("DotNet JSON dates and timezone offsets preserve process ancestry", [
  boot(351, { CreationDate: `/Date(${Date.parse(older)})/` }),
  renderer(352, 351, { CreationDate: "2026-10-19T09:00:01+08:00" }),
], { owned: [351, 352] });
addCase("a BootMain born at .0009000 cannot own a child born at .0001000", [
  boot(353, { CreationDate: "2026-10-19T04:00:00.0009000Z" }),
  renderer(354, 353, { CreationDate: "2026-10-19T04:00:00.0001000Z" }),
], { owned: [353], unknown: [354] });
addCase("ordinary QQ ancestry preserves microseconds within the same millisecond", [
  qq(355, { CreationDate: "2026-10-19T04:00:00.0009000Z" }),
  renderer(356, 355, { CreationDate: "2026-10-19T04:00:00.0001000Z" }),
], { ordinary: [355], unknown: [356] });
addCase("valid microsecond ordering still propagates BootMain ownership", [
  boot(357, { CreationDate: "2026-10-19T04:00:00.0001000Z" }),
  renderer(358, 357, { CreationDate: "2026-10-19T04:00:00.0009000Z" }),
], { owned: [357, 358] });

addCase("NapCat directory prefix collisions cannot grant hook ownership", [
  qq(360, { ModulePaths: [`${root}-backup\\NapCatWinBootHook.dll`] }),
  qq(361, { ModulePaths: [`${root}2\\native.node`] }),
], { ordinary: [360, 361] });
addCase("a sibling BootMain executable cannot own a QQ child", [
  boot(362, { ExecutablePath: `${root}-backup\\NapCatWinBootMain.exe`, CommandLine: `"${root}-backup\\NapCatWinBootMain.exe"` }),
  renderer(363, 362),
], { unknown: [363] });
addCase("module paths escaping the NapCat directory cannot grant ownership", [
  qq(364, { ModulePaths: [`${root}\\..\\OtherApp\\unrelated.dll`] }),
], { ordinary: [364] });
addCase("non-native files in the NapCat directory do not establish a loaded hook", [
  qq(365, { ModulePaths: [`${root}\\README.md`, `${root}\\config.json`] }),
], { ordinary: [365] });
addCase("same-name BootMain outside the configured root is ignored", [
  boot(366, { ExecutablePath: "C:\\Untrusted\\NapCatWinBootMain.exe" }), renderer(367, 366),
], { unknown: [367] });
addCase("similarly named QQ helpers are excluded even with hook-looking modules", [
  qq(368, { Name: "NotQQ.exe", ModulePaths: [`${root}\\NapCatWinBootHook.dll`] }),
  qq(369, { Name: "QQHelper.exe", ModulePaths: [`${root}\\NapCatWinBootHook.dll`] }),
], {});

for (const [name, command] of [
  ["cmd.exe", `cmd.exe /d /s /c ""${root}\\launcher-user.bat" --fixture"`],
  ["cmd.exe", `cmd.exe /c call "${root}\\napcat.bat"`],
  ["node.exe", `node.exe "${root}\\index.js"`],
  ["node.exe", `node.exe --inspect "${root}\\napcat.mjs"`],
  ["node.exe", `node.exe "${root}\\napcat\\napcat.mjs"`],
  ["pwsh.exe", `pwsh.exe -File C:\\FixtureTools\\start-napcat-login.ps1 -NapCatRoot "${root}"`],
]) {
  addCase(`executed launcher is owned: ${command}`, [processRecord(370, name, command)], { owned: [370] });
}

for (const [description, name, command] of [
  ["echo", "cmd.exe", `cmd.exe /c echo "${root}\\launcher-user.bat"`],
  ["type", "cmd.exe", `cmd.exe /c type "${root}\\napcat.bat"`],
  ["rem", "cmd.exe", `cmd.exe /c rem "${root}\\NapCatWinBootMain.exe"`],
  ["node diagnostic argument", "node.exe", `node.exe C:\\FixtureTools\\diagnose.mjs --target "${root}\\index.js"`],
  ["node evaluation string", "node.exe", `node.exe -e "console.log('${root.replaceAll("\\", "/")}/index.js')"`],
  ["PowerShell Get-Content", "pwsh.exe", `pwsh.exe -Command "Get-Content '${root}\\napcat.bat'"`],
  ["PowerShell printed launch command", "powershell.exe", `powershell.exe -Command "Write-Output 'pwsh -File C:/FixtureTools/start-napcat-login.ps1 -NapCatRoot ${root.replaceAll("\\", "/")}'"`],
]) {
  addCase(`diagnostic mentions without execution are ignored: ${description}`, [
    processRecord(380, name, command), renderer(381, 380),
  ], { unknown: [381] });
}

addCase("entrypoint filename prefix collisions are ignored", [
  processRecord(390, "node.exe", `node.exe "${root}\\index.js.backup"`),
  processRecord(391, "cmd.exe", `cmd.exe /c "${root}\\launcher-user.bat.old"`),
], {});
addCase("empty root cannot claim a launcher or hook", [
  boot(392), qq(393, { ModulePaths: [`${root}\\NapCatWinBootHook.dll`] }),
], { ordinary: [393] }, "");
addCase("Windows paths accept casing slash styles spaces and Unicode", [
  boot(394, { ExecutablePath: "c:/fixture apps/napcat 测试/NapCatWinBootMain.exe" }),
  qq(395, { ModulePaths: ["c:/FIXTURE APPS/NAPCAT 测试/NapCatWinBootHook.DLL"] }),
], { owned: [394, 395] }, "C:\\Fixture Apps\\NapCat 测试\\");
addCase("empty snapshot has three empty categories", [], {});
addCase("BootMain with no executable or command and its unhooked QQ child stay unknown", [
  boot(400, { ExecutablePath: null, CommandLine: null }), qq(401, { ParentProcessId: 400 }),
  renderer(402, 401),
], { unknown: [400, 401, 402] });

for (const name of [undefined, "", "  "]) {
  cases.push({
    name: `missing process name fails the whole inventory: ${JSON.stringify(name) ?? "undefined"}`,
    processes: [qq(410), qq(411, { Name: name })],
    napcatRoot: root,
    errorPattern: "NAPCAT_PROCESS_SCAN_UNKNOWN",
  });
}

const snapshotCases = [];

function addSnapshot(name, processes, handles, expected, states, options = {}) {
  snapshotCases.push({ name, processes, handles, expected: groups(expected), states, napcatRoot: root, ...options });
}

function handle(record, overrides = {}) {
  return {
    processId: record.ProcessId,
    startTime: record.CreationDate,
    modules: record.ModulePaths,
    ...overrides,
  };
}

const ordinaryRoot = qq(500, { CreationDate: older });
const ordinaryChild = renderer(501, 500);
addSnapshot("CIM snapshot keeps ordinary QQ parent and child ordinary", [ordinaryRoot, ordinaryChild], [
  handle(ordinaryRoot), handle(ordinaryChild),
], { ordinary: [500, 501] }, { 500: "ok", 501: "ok" }, { cimDateTime: true });

const orphanHook = qq(502, { ModulePaths: [`${root}\\NapCatWinBootHook.dll`] });
addSnapshot("snapshot protects a loaded orphan hook after BootMain exited", [orphanHook], [handle(orphanHook)], { owned: [502] }, { 502: "ok" });

for (const [name, overrides] of [
  ["Get-Process access denied", { lookupError: true }],
  ["empty module inventory", { modules: [] }],
  ["module getter access denied", { moduleError: true }],
  ["PID reused before module read", { startTime: newer }],
  ["PID reused after module read", { afterStartTime: newer }],
  ["process exited after module read", { hasExited: true }],
  ["Refresh failure", { refreshError: true }],
]) {
  addSnapshot(`snapshot fails closed on ${name}`, [orphanHook], [handle(orphanHook, overrides)], { unknown: [502] }, { 502: "unknown" });
}

const fractional = qq(503, { CreationDate: "2026-10-19T01:00:01.1234560Z" });
addSnapshot("CIM microseconds accept four extra DotNet ticks", [fractional], [
  handle(fractional, { startTime: "2026-10-19T01:00:01.1234564Z" }),
], { ordinary: [503] }, { 503: "ok" }, { cimDateTime: true });
addSnapshot("one microsecond creation mismatch fails closed", [fractional], [
  handle(fractional, { startTime: "2026-10-19T01:00:01.1234570Z" }),
], { unknown: [503] }, { 503: "unknown" }, { cimDateTime: true });
addSnapshot("non-QQ records never invoke Get-Process", [boot(504), processRecord(505, "diagnostic.exe", "diagnostic")], [], { owned: [504] }, {});
addSnapshot("empty CIM result remains a successful empty snapshot", [], [], {}, {});
snapshotCases.push({ name: "CIM failure is surfaced instead of becoming an empty success", cimError: true, processes: [], handles: [], napcatRoot: root });

const creationTimeCases = [
  { name: "exact microsecond", startTime: "2026-10-19T01:00:01.1234560Z", creationDate: fractional.CreationDate, expected: true },
  { name: "four extra ticks", startTime: "2026-10-19T01:00:01.1234564Z", creationDate: fractional.CreationDate, expected: true },
  { name: "nine extra ticks", startTime: "2026-10-19T01:00:01.1234569Z", creationDate: fractional.CreationDate, expected: true },
  { name: "one microsecond later", startTime: "2026-10-19T01:00:01.1234570Z", creationDate: fractional.CreationDate, expected: false },
  { name: "previous microsecond", startTime: "2026-10-19T01:00:01.1234559Z", creationDate: fractional.CreationDate, expected: false },
  { name: "invalid CIM timestamp", startTime: fractional.CreationDate, creationDate: "not-a-date", expected: false },
];

for (const fixture of cases) {
  test(`JS classification: ${fixture.name}`, () => {
    const input = structuredClone(fixture.processes);
    if (fixture.errorPattern) {
      assert.throws(() => classifyNapCatProcesses(input, fixture.napcatRoot), new RegExp(fixture.errorPattern));
      assert.deepEqual(input, fixture.processes);
      return;
    }
    assert.deepEqual(ids(classifyNapCatProcesses(input, fixture.napcatRoot)), fixture.expected);
    assert.deepEqual(input, fixture.processes, "the classifier must not mutate the snapshot");
    assert.deepEqual(ids(classifyNapCatProcesses([...input].reverse(), fixture.napcatRoot)), fixture.expected, "classification must not depend on input order");
  });
}

test("JS rejects an unavailable or malformed process inventory", () => {
  for (const invalid of [null, undefined, {}, "CIM unavailable"]) {
    assert.throws(() => classifyNapCatProcesses(invalid, root), /NAPCAT_PROCESS_SCAN_UNKNOWN/);
  }
});

function resolveExecutable(override, candidates) {
  if (override) return override;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(folder, path.basename(candidates[0]));
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(executable, expectedMajor) {
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Get-CimInstance {
  param($ClassName, $ErrorAction)
  if ($ClassName -ne 'Win32_Process') { throw 'UNEXPECTED_CIM_CLASS' }
  $script:CimCalls++
  if ($script:SnapshotFixture.cimError) { throw 'FIXTURE_CIM_UNAVAILABLE' }
  foreach ($Item in @($script:SnapshotFixture.processes)) {
    if ($script:SnapshotFixture.cimDateTime) { $Item.CreationDate = [DateTime]::Parse($Item.CreationDate, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
    $Item | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate, ExecutablePath
  }
}
function Get-Process {
  param($Id, $ErrorAction)
  $script:ProcessCalls += [int]$Id
  $Fixture = @($script:SnapshotFixture.handles | Where-Object { $_.processId -eq $Id })
  if ($Fixture.Count -ne 1) { throw 'UNEXPECTED_GET_PROCESS_ID' }
  if ($Fixture[0].lookupError) { throw 'FIXTURE_PROCESS_ACCESS_DENIED' }
  $Handle = [pscustomobject]@{ Fixture = $Fixture[0]; Refreshed = $false }
  $Handle | Add-Member -MemberType ScriptProperty -Name StartTime -Value {
    $Timestamp = $this.Fixture.startTime
    if ($this.Refreshed -and $this.Fixture.afterStartTime) { $Timestamp = $this.Fixture.afterStartTime }
    [DateTime]::Parse($Timestamp, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  }
  $Handle | Add-Member -MemberType ScriptProperty -Name Modules -Value {
    if ($this.Fixture.moduleError) { throw 'FIXTURE_MODULE_ACCESS_DENIED' }
    foreach ($Module in @($this.Fixture.modules)) { [pscustomobject]@{ FileName = $Module } }
  }
  $Handle | Add-Member -MemberType ScriptProperty -Name HasExited -Value { [bool]$this.Fixture.hasExited }
  $Handle | Add-Member -MemberType ScriptMethod -Name Refresh -Value {
    if ($this.Fixture.refreshError) { throw 'FIXTURE_REFRESH_FAILED' }
    $this.Refreshed = $true
  }
  $Handle | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $script:DisposedProcessIds += [int]$this.Fixture.processId
  }
  return $Handle
}
. ${quotePowerShell(helperPath)}
$JsonOptions = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $JsonOptions.DateKind = 'String' }
$Payload = [Console]::In.ReadToEnd() | ConvertFrom-Json @JsonOptions
$Results = @()
foreach ($Fixture in @($Payload.classifications)) {
  try {
    $Classification = Get-NapCatProcessClassification -Processes @($Fixture.processes) -NapCatRoot $Fixture.napcatRoot
    $Results += [pscustomobject]@{ name = $Fixture.name; classification = $Classification }
  } catch { $Results += [pscustomobject]@{ name = $Fixture.name; error = $_.Exception.Message } }
}
$Snapshots = @()
foreach ($Fixture in @($Payload.snapshots)) {
  $script:SnapshotFixture = $Fixture
  $script:ProcessCalls = @()
  $script:DisposedProcessIds = @()
  $script:CimCalls = 0
  try {
    $Snapshot = @(Get-NapCatOwnershipSnapshot)
    $Classification = Get-NapCatProcessClassification -Processes $Snapshot -NapCatRoot $Fixture.napcatRoot
    $Snapshots += [pscustomobject]@{ name = $Fixture.name; records = $Snapshot; classification = $Classification; processCalls = @($script:ProcessCalls); disposedProcessIds = @($script:DisposedProcessIds); cimCalls = $script:CimCalls }
  } catch { $Snapshots += [pscustomobject]@{ name = $Fixture.name; error = $_.Exception.Message; processCalls = @($script:ProcessCalls); disposedProcessIds = @($script:DisposedProcessIds); cimCalls = $script:CimCalls } }
}
$TimeChecks = @()
foreach ($Fixture in @($Payload.creationTimes)) {
  $StartTime = [DateTime]::Parse($Fixture.startTime, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  $TimeChecks += [pscustomobject]@{ name = $Fixture.name; result = (Test-NapCatCreationTime -StartTime $StartTime -CreationDate $Fixture.creationDate) }
}
$TypedDate = [DateTime]::Parse('2026-10-19T01:00:00.1234560Z', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
$TypedChecks = @(
  (Test-NapCatCreationTime -StartTime $TypedDate.AddTicks(4) -CreationDate $TypedDate),
  (Test-NapCatCreationTime -StartTime $TypedDate -CreationDate $TypedDate.ToLocalTime()),
  (Test-NapCatCreationTime -StartTime $TypedDate -CreationDate ([DateTimeOffset]$TypedDate)),
  (Test-NapCatCreationTime -StartTime $TypedDate -CreationDate ([DateTime]::SpecifyKind($TypedDate, [DateTimeKind]::Unspecified))),
  (Test-NapCatCreationTime -StartTime $TypedDate.AddTicks(10) -CreationDate $TypedDate)
)
[pscustomobject]@{ major = $PSVersionTable.PSVersion.Major; version = $PSVersionTable.PSVersion.ToString(); classifications = $Results; snapshots = $Snapshots; creationTimes = $TimeChecks; typedCreationTimes = $TypedChecks } | ConvertTo-Json -Depth 30 -Compress
`;
  const execution = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    cwd: path.dirname(helperPath),
    encoding: "utf8",
    input: JSON.stringify({ classifications: cases, snapshots: snapshotCases, creationTimes: creationTimeCases }),
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(execution.error);
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const response = JSON.parse(execution.stdout.replace(/^\uFEFF/, "").trim());
  assert.equal(response.major, expectedMajor, `wrong PowerShell runtime: ${response.version}`);
  return response;
}

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const programFiles = process.env.ProgramFiles || "C:\\Program Files";
const shells = [
  {
    name: "Windows PowerShell 5.1",
    major: 5,
    executable: process.platform === "win32" ? resolveExecutable(process.env.NAPCAT_IDENTITY_TEST_PS5, [path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]) : null,
  },
  {
    name: "PowerShell 7",
    major: 7,
    executable: process.platform === "win32" ? resolveExecutable(process.env.NAPCAT_IDENTITY_TEST_PS7 || process.env.MAINTENANCE_TEST_PWSH, [path.join(programFiles, "PowerShell", "7", "pwsh.exe")]) : null,
  },
];

for (const shell of shells) {
  test(`${shell.name}: stop refuses newly appeared owned processes and reports residuals`, {
    skip: shell.executable ? false : `${shell.name} unavailable`,
  }, () => {
    const command = `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(helperPath)}
$script:ScanCount = 0
$script:Scenario = 'new'
function Get-NapCatOwnershipSnapshot {
  $script:ScanCount++
  if ($script:Scenario -eq 'new' -or $script:ScanCount -gt 1) {
    [pscustomobject]@{ ProcessId = 999999; ParentProcessId = 4; Name = 'NapCatWinBootMain.exe'; ExecutablePath = 'C:/FixtureApps/NapCat/NapCatWinBootMain.exe'; CommandLine = 'C:/FixtureApps/NapCat/NapCatWinBootMain.exe'; CreationDate = '2026-10-19T01:00:00Z' }
  }
}
$NewError = $null
try { $null = Stop-NapCatVerifiedProcesses -Processes @() -NapCatRoot 'C:/FixtureApps/NapCat' } catch { $NewError = $_.Exception.Message }
$script:ScanCount = 0
$script:Scenario = 'residual'
$ResidualError = $null
try { $null = Stop-NapCatVerifiedProcesses -Processes @() -NapCatRoot 'C:/FixtureApps/NapCat' } catch { $ResidualError = $_.Exception.Message }
[pscustomobject]@{ newError = $NewError; residualError = $ResidualError; scans = $script:ScanCount } | ConvertTo-Json -Compress
`;
    const execution = spawnSync(shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(execution.error);
    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout.trim());
    assert.match(result.newError, /NAPCAT_PROCESS_IDENTITY_CHANGED/);
    assert.match(result.residualError, /NAPCAT_PROCESS_CLEANUP_UNVERIFIED/);
    assert.equal(result.scans, 2);
  });
}

for (const shell of shells) {
  test(`${shell.name}: classification parity and mocked ownership snapshot`, {
    skip: shell.executable ? false : `${shell.name} unavailable; provide NAPCAT_IDENTITY_TEST_PS${shell.major === 5 ? "5" : "7"}`,
  }, async (context) => {
    const response = runPowerShell(shell.executable, shell.major);
    context.diagnostic(`runtime=${response.version}; classification cases=${cases.length}; snapshot cases=${snapshotCases.length}; timestamp boundaries=${creationTimeCases.length}`);
    assert.equal(response.classifications.length, cases.length);
    assert.equal(response.snapshots.length, snapshotCases.length);
    assert.equal(response.creationTimes.length, creationTimeCases.length);
    assert.deepEqual(response.typedCreationTimes, [true, true, true, false, false]);
    for (const [index, fixture] of cases.entries()) {
      await context.test(fixture.name, () => {
        const actual = response.classifications[index];
        assert.equal(actual.name, fixture.name);
        if (fixture.errorPattern) {
          assert.match(actual.error, new RegExp(fixture.errorPattern));
          assert.equal(actual.classification, undefined);
          return;
        }
        assert.equal(actual.error, undefined, actual.error);
        assert.deepEqual(ids(actual.classification), fixture.expected);
        assert.deepEqual(ids(actual.classification), ids(classifyNapCatProcesses(fixture.processes, fixture.napcatRoot)), "JS and PowerShell must agree");
      });
    }
    for (const [index, fixture] of snapshotCases.entries()) {
      await context.test(fixture.name, () => {
        const actual = response.snapshots[index];
        assert.equal(actual.name, fixture.name);
        assert.equal(actual.cimCalls, 1, "snapshot must invoke the mocked CIM inventory");
        assert.deepEqual(actual.disposedProcessIds, fixture.handles.filter((entry) => !entry.lookupError).map((entry) => entry.processId), "every acquired process must be disposed on success and failure");
        if (fixture.cimError) {
          assert.match(actual.error, /FIXTURE_CIM_UNAVAILABLE/);
          assert.equal(actual.records, undefined);
          assert.deepEqual(actual.processCalls, []);
          return;
        }
        assert.equal(actual.error, undefined, actual.error);
        const expectedCalls = fixture.processes.filter((record) => /^(?:qq|qqnt|qqex)(?:\.exe)?$/i.test(record.Name)).map((record) => record.ProcessId);
        assert.deepEqual(actual.processCalls, expectedCalls, "only mocked QQ identities may be queried");
        assert.equal(actual.records.length, fixture.processes.length);
        const states = Object.fromEntries(actual.records.filter((record) => expectedCalls.includes(record.ProcessId)).map((record) => [record.ProcessId, record.ModuleScanState]));
        assert.deepEqual(states, fixture.states, JSON.stringify({ states, classification: ids(actual.classification), modules: actual.records.map((record) => record.ModulePaths) }));
        assert.deepEqual(ids(actual.classification), fixture.expected);
        assert.deepEqual(ids(classifyNapCatProcesses(actual.records, fixture.napcatRoot)), fixture.expected, "JS must agree on the actual PowerShell snapshot");
      });
    }
    for (const [index, fixture] of creationTimeCases.entries()) {
      await context.test(`creation time: ${fixture.name}`, () => {
        assert.equal(response.creationTimes[index].name, fixture.name);
        assert.equal(response.creationTimes[index].result, fixture.expected);
      });
    }
  });
}

function waitForChildExit(child, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned fixture PID ${child.pid} did not exit`)), timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function spawnReadyNode(children, argumentsList, cwd) {
  const child = spawn(process.execPath, argumentsList, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Isolated Node fixture did not become ready")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Isolated Node exited before readiness: ${code}/${signal}`));
    });
    child.stdout.on("data", (data) => {
      output += data.toString("utf8");
      if (output.includes("IDENTITY_FIXTURE_READY\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return child;
}

function runVerifiedStop(executable, expectedMajor, ownedProcessId, napcatRoot) {
  const command = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$script:OwnedProcessId = [int]$Fixture.processId
$script:OwnedEntry = Join-Path ([string]$Fixture.napcatRoot) 'index.js'
$script:OwnedExecutable = [string]$Fixture.nodeExecutable
$script:CimQueries = @()
$script:RealCimCommand = Get-Command Get-CimInstance -CommandType Cmdlet -ErrorAction Stop
function Get-CimInstance {
  param($ClassName, $ErrorAction)
  if ($ClassName -ne 'Win32_Process' -or $script:OwnedProcessId -le 0) { throw 'UNSAFE_REAL_CIM_QUERY' }
  $script:CimQueries += $script:OwnedProcessId
  $Observed = @(& $script:RealCimCommand -ClassName Win32_Process -Filter ('ProcessId = ' + $script:OwnedProcessId) -ErrorAction Stop)
  foreach ($Record in $Observed) {
    if ([int]$Record.ProcessId -ne $script:OwnedProcessId -or $Record.Name -ine 'node.exe' -or -not [string]::Equals([string]$Record.ExecutablePath, $script:OwnedExecutable, [StringComparison]::OrdinalIgnoreCase) -or ([string]$Record.CommandLine).IndexOf($script:OwnedEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'UNSAFE_OWNED_CIM_IDENTITY' }
    $Record
  }
}
. ${quotePowerShell(helperPath)}
$Snapshot = @(Get-NapCatOwnershipSnapshot)
if ($Snapshot.Count -ne 1 -or [int]$Snapshot[0].ProcessId -ne $script:OwnedProcessId) { throw 'UNSAFE_STOP_SNAPSHOT' }
$Classification = Get-NapCatProcessClassification -Processes $Snapshot -NapCatRoot $Fixture.napcatRoot
if ($Classification.owned.Count -ne 1 -or [int]$Classification.owned[0].ProcessId -ne $script:OwnedProcessId -or $Classification.unknown.Count -ne 0) { throw 'UNSAFE_STOP_CLASSIFICATION' }
if (-not [string]::Equals([string]$Snapshot[0].ExecutablePath, [string]$Fixture.nodeExecutable, [StringComparison]::OrdinalIgnoreCase)) { throw 'UNEXPECTED_FIXTURE_EXECUTABLE' }
$Observer = [Diagnostics.Process]::GetProcessById($script:OwnedProcessId)
try {
  $RetainedHandle = $Observer.SafeHandle
  $OriginalStartTime = $Observer.StartTime
  if ($RetainedHandle.IsInvalid -or $RetainedHandle.IsClosed) { throw 'INVALID_FIXTURE_HANDLE' }
  $WrongIdentity = $Snapshot[0].PSObject.Copy()
  $WrongIdentity.CreationDate = [DateTime]::Parse([string]$WrongIdentity.CreationDate).ToUniversalTime().AddSeconds(1).ToString('o')
  $WrongDateError = $null
  try { $null = Stop-NapCatVerifiedProcesses -Processes @($WrongIdentity) -NapCatRoot $Fixture.napcatRoot }
  catch { $WrongDateError = $_.Exception.Message }
  $Observer.Refresh()
  $SurvivedWrongDate = -not $Observer.HasExited
  if (-not $WrongDateError -or -not $SurvivedWrongDate) { throw 'WRONG_DATE_STOPPED_FIXTURE' }
  if (-not [object]::ReferenceEquals($RetainedHandle, $Observer.SafeHandle) -or $Observer.StartTime -ne $OriginalStartTime) { throw 'OBSERVER_IDENTITY_CHANGED' }
  $TypedSnapshot = $Snapshot[0].PSObject.Copy()
  $TypedSnapshot.CreationDate = [DateTime]::Parse([string]$Snapshot[0].CreationDate, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  $Stopped = Stop-NapCatVerifiedProcesses -Processes @($TypedSnapshot) -NapCatRoot $Fixture.napcatRoot
  $Exited = $Observer.WaitForExit(5000)
  [pscustomobject]@{ major = $PSVersionTable.PSVersion.Major; version = $PSVersionTable.PSVersion.ToString(); snapshot = $Snapshot; classification = $Classification; wrongDateError = $WrongDateError; survivedWrongDate = $SurvivedWrongDate; stopped = $Stopped; exited = $Exited; retainedHandleOpen = (-not $RetainedHandle.IsClosed); cimQueries = @($script:CimQueries) } | ConvertTo-Json -Depth 20 -Compress
} finally { $Observer.Dispose() }
`;
  const execution = spawnSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    cwd: napcatRoot,
    input: JSON.stringify({ processId: ownedProcessId, napcatRoot, nodeExecutable: process.execPath }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(execution.error);
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const response = JSON.parse(execution.stdout.replace(/^\uFEFF/, "").trim());
  assert.equal(response.major, expectedMajor);
  return response;
}

for (const shell of shells) {
  test(`${shell.name}: verified stop preserves a wrong-date process then stops only the owned fixture`, {
    skip: shell.executable ? false : `${shell.name} unavailable; provide NAPCAT_IDENTITY_TEST_PS${shell.major === 5 ? "5" : "7"}`,
    timeout: 40_000,
  }, async (context) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `napcat-identity-stop-${randomUUID()}-`));
    const children = [];
    context.after(async () => {
      for (const child of children) {
        if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
        if (child.pid) await waitForChildExit(child);
      }
      assert.equal(path.dirname(fixtureRoot), path.resolve(os.tmpdir()));
      assert.ok(path.basename(fixtureRoot).startsWith("napcat-identity-stop-"));
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
    const program = 'process.stdout.write("IDENTITY_FIXTURE_READY\\n"); setInterval(() => {}, 1000);\n';
    const entryPath = path.join(fixtureRoot, "index.js");
    fs.writeFileSync(entryPath, program, "utf8");
    const owned = await spawnReadyNode(children, [entryPath], fixtureRoot);
    const sentinel = await spawnReadyNode(children, ["-e", program], fixtureRoot);
    const response = runVerifiedStop(shell.executable, shell.major, owned.pid, fixtureRoot);
    assert.deepEqual(ids(response.classification), groups({ owned: [owned.pid] }));
    assert.deepEqual(ids(classifyNapCatProcesses(response.snapshot, fixtureRoot)), groups({ owned: [owned.pid] }));
    assert.match(response.wrongDateError, /NAPCAT_PROCESS_IDENTITY_CHANGED/);
    assert.equal(response.survivedWrongDate, true);
    assert.equal(response.stopped.stopped, true);
    assert.deepEqual(response.stopped.rootProcessIds, [owned.pid]);
    assert.equal(response.exited, true);
    assert.equal(response.retainedHandleOpen, true);
    assert.deepEqual(response.cimQueries, [owned.pid, owned.pid, owned.pid, owned.pid]);
    await waitForChildExit(owned);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentinel.exitCode, null, "an unrelated test-owned Node must remain alive");
    assert.equal(sentinel.signalCode, null);
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
    context.diagnostic(`runtime=${response.version}; real filtered CIM snapshots=3; wrong date rejected; owned fixture exited; retained observer handle stayed open; sentinel survived`);
  });
}
