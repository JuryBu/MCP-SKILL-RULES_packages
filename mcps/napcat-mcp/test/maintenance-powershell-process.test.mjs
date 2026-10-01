import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const launcherPath = fileURLToPath(new URL("../ops/invoke-maintenance-powershell.ps1", import.meta.url));
const childPath = fileURLToPath(new URL("../ops/maintenance-powershell-child.ps1", import.meta.url));
const windows = process.platform === "win32";
const evidenceRoot = windows ? fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-powershell-tests-")) : null;
const ownedPids = new Set();

function write(filePath, contents) {
  fs.writeFileSync(filePath, filePath.endsWith(".ps1") ? `\uFEFF${contents}` : contents, "utf8");
  return filePath;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandPath(name) {
  const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `[Console]::Write((Get-Command '${name}' -ErrorAction Stop).Source)`,
  ], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

const windowsPowerShell = windows ? commandPath("powershell.exe") : null;
const nodePath = windows ? commandPath("node.exe") : null;
const powerShell7 = windows ? process.env.MAINTENANCE_TEST_PWSH || commandPath("pwsh.exe") : null;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}; no process was killed.`);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

async function drainOwnedPids() {
  await waitFor(() => {
    for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(evidenceRoot, entry.name);
      const nodePidPath = path.join(directory, "node state.launched.json");
      const resultPath = path.join(directory, "stage run [literal]", "stage-result.json");
      if (fs.existsSync(nodePidPath)) ownedPids.add(Number(fs.readFileSync(nodePidPath, "utf8")));
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        if (result.childPid) ownedPids.add(result.childPid);
      }
    }
    return [...ownedPids].every((pid) => !alive(pid));
  }, "owned processes to exit naturally");
}

after(async () => {
  if (!windows) return;
  await drainOwnedPids();
  write(path.join(evidenceRoot, "process-cleanup.json"), JSON.stringify({
    observedAt: new Date().toISOString(), ownedPids: [...ownedPids], liveOwnedProcesses: [],
  }, null, 2));
  console.log(`MAINTENANCE_EVIDENCE_ROOT=${evidenceRoot}`);
});

function runPowerShell(executable, scriptPath, args, logPrefix) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath, ...args], {
      cwd: path.dirname(logPrefix), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) ownedPids.add(child.pid);
    let stdout = "";
    let stderr = "";
    let exitAt = null;
    let exitCode = null;
    let exitSignal = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => { exitAt = Date.now(); exitCode = code; exitSignal = signal; });
    child.on("close", () => {
      const closedAt = Date.now();
      const result = { code: exitCode, signal: exitSignal, stdout, stderr, closedAt, elapsedMs: closedAt - startedAt,
        exitElapsedMs: exitAt - startedAt, eofAfterExitMs: closedAt - exitAt };
      write(`${logPrefix}.stdout.log`, stdout);
      write(`${logPrefix}.stderr.log`, stderr);
      write(`${logPrefix}.process.json`, JSON.stringify(result, null, 2));
      resolve(result);
    });
  });
}

function makeCase(label) {
  const directory = fs.mkdtempSync(path.join(evidenceRoot, `${label} space [literal] ' &;-`));
  return { directory, scriptPath: path.join(directory, "fixture stage.ps1"),
    parametersPath: path.join(directory, "parameters.json"), runDirectory: path.join(directory, "stage run [literal]"),
    logPrefix: path.join(directory, "outer") };
}

async function invokeStage(executable, fixture, parameters = {}, timeout = 10_000, expectedHash = sha256(fixture.scriptPath)) {
  write(fixture.parametersPath, JSON.stringify(parameters));
  const processResult = await runPowerShell(executable, launcherPath, [
    "-ScriptPath", fixture.scriptPath, "-ScriptSha256", expectedHash,
    "-ParametersPath", fixture.parametersPath, "-RunDirectory", fixture.runDirectory,
    "-TimeoutMilliseconds", String(timeout),
  ], fixture.logPrefix);
  const result = JSON.parse(fs.readFileSync(path.join(fixture.runDirectory, "stage-result.json"), "utf8"));
  if (result.childPid) ownedPids.add(result.childPid);
  assert.deepEqual(JSON.parse(processResult.stdout.replace(/^\uFEFF/, "")), result);
  return { ...processResult, result };
}

function backgroundFixture(fixture) {
  const nodeScriptPath = write(path.join(fixture.directory, "finite node.mjs"), `
import fs from "node:fs";
const statePath = process.argv[2];
process.on("exit", (exitCode) => {
  fs.writeFileSync(statePath + ".exit.json", JSON.stringify({ pid: process.pid, exitCode, exitedAt: Date.now() }));
});
fs.writeFileSync(statePath + ".ready.json", JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
process.stdout.write("FINITE_NODE_STDOUT_READY\\n");
setTimeout(() => {
  process.stderr.write("FINITE_NODE_STDERR_EOF\\n");
  fs.writeFileSync(statePath + ".done.json", JSON.stringify({ pid: process.pid, endedAt: Date.now() }));
}, 6000);
`);
  write(fixture.scriptPath, `param([string]$NodePath, [string]$NodeScriptPath, [string]$NodeStatePath)
$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = $NodePath
$StartInfo.Arguments = '"' + $NodeScriptPath + '" "' + $NodeStatePath + '"'
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = $true
$Node = [System.Diagnostics.Process]::Start($StartInfo)
[System.IO.File]::WriteAllText($NodeStatePath + ".launched.json", ($Node.Id.ToString()))
Write-Error "FIXTURE_STAGE_STDERR" -ErrorAction Continue
Write-Output "FIXTURE_STAGE_RETURNING"
exit 0
`);
  return { NodePath: nodePath, NodeScriptPath: nodeScriptPath, NodeStatePath: path.join(fixture.directory, "node state") };
}

function registerNode(parameters) {
  const pid = Number(fs.readFileSync(`${parameters.NodeStatePath}.launched.json`, "utf8"));
  ownedPids.add(pid);
  return pid;
}

test("maintenance launcher uses one hidden child without capture, policy overrides, or tree control", () => {
  const parent = fs.readFileSync(launcherPath, "utf8");
  const child = fs.readFileSync(childPath, "utf8");
  assert.match(parent, /Start-Process -FilePath \$PowerShellPath -ArgumentList \$ArgumentLine -WindowStyle Hidden -PassThru/);
  assert.match(parent, /\.WaitForExit\(\$TimeoutMilliseconds\)/);
  assert.match(child, /Start-Transcript -LiteralPath \$LogPath/);
  assert.match(child, /& \$RequestedScriptPath @Parameters \| Out-Default/);
  for (const source of [parent, child]) {
    assert.doesNotMatch(source, /-Wait\b|-NoNewWindow|-RedirectStandard|ExecutionPolicy|Invoke-Expression|EncodedCommand|Stop-Process|\.Kill\(/i);
  }
});

test("legacy captured WinPS child waits for inherited Node EOF", { skip: !windows }, async (context) => {
  assert.ok(windowsPowerShell && nodePath, "Get-Command must locate real WinPS and Node");
  const fixture = makeCase("legacy");
  const parameters = backgroundFixture(fixture);
  const wrapperPath = write(path.join(fixture.directory, "legacy human.ps1"), `
param([string]$FixturePath, [string]$NodePath, [string]$NodeScriptPath, [string]$NodeStatePath)
$Output = & (Join-Path $PSHOME "powershell.exe") -NoLogo -NoProfile -NonInteractive -File $FixturePath -NodePath $NodePath -NodeScriptPath $NodeScriptPath -NodeStatePath $NodeStatePath 2>&1
$Output | Out-Default
exit $LASTEXITCODE
`);
  context.after(drainOwnedPids);
  const result = await runPowerShell(windowsPowerShell, wrapperPath, ["-FixturePath", fixture.scriptPath,
    ...Object.entries(parameters).flatMap(([key, value]) => [`-${key}`, value])], fixture.logPrefix);
  registerNode(parameters);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.elapsedMs >= 6000, JSON.stringify(result));
  assert.ok(fs.existsSync(`${parameters.NodeStatePath}.done.json`));
  assert.equal(JSON.parse(fs.readFileSync(`${parameters.NodeStatePath}.exit.json`, "utf8")).exitCode, 0);
  assert.match(result.stdout, /FIXTURE_STAGE_RETURNING/);
  context.diagnostic(`legacy capture=${result.elapsedMs}ms; logs=${fixture.directory}`);
});

for (const [label, executable] of [["WinPS5", windowsPowerShell], ["PS7", powerShell7]]) {
  test(`${label}: real maintenance child process contract`, { skip: !windows || !executable }, async (context) => {
    context.after(drainOwnedPids);

    await context.test("returns while finite background Node is still alive, preserving transcript stderr", async (subcontext) => {
      const fixture = makeCase(`${label}-background`);
      const parameters = backgroundFixture(fixture);
      subcontext.after(drainOwnedPids);
      const observed = await invokeStage(executable, fixture, parameters);
      const nodePid = registerNode(parameters);
      assert.equal(observed.code, 0, observed.stderr);
      assert.equal(observed.signal, null);
      assert.equal(observed.result.completed, true);
      assert.equal(observed.result.childExitCode, 0);
      assert.equal(observed.result.processSucceeded, true);
      assert.equal(observed.result.powershellPath.toLowerCase(), executable.toLowerCase());
      assert.match(observed.result.powershellVersion, label === "WinPS5" ? /^5\./ : /^7\./);
      assert.ok(observed.eofAfterExitMs < 1000, `outer EOF lag=${observed.eofAfterExitMs}ms`);
      assert.ok(alive(nodePid), "background Node must still be alive after wrapper EOF");
      assert.equal(fs.existsSync(`${parameters.NodeStatePath}.done.json`), false);
      assert.equal(alive(observed.result.childPid), false);
      assert.ok(Date.parse(observed.result.childCreatedAt));
      const transcript = fs.readFileSync(observed.result.logPath, "utf8");
      assert.match(transcript, /FIXTURE_STAGE_STDERR/);
      assert.ok(transcript.includes(`MAINTENANCE_CHILD_STARTED pid=${observed.result.childPid} version=${observed.result.powershellVersion}`));
      await waitFor(() => fs.existsSync(`${parameters.NodeStatePath}.done.json`) && !alive(nodePid), "Node natural EOF");
      const ready = JSON.parse(fs.readFileSync(`${parameters.NodeStatePath}.ready.json`, "utf8"));
      const done = JSON.parse(fs.readFileSync(`${parameters.NodeStatePath}.done.json`, "utf8"));
      assert.equal(JSON.parse(fs.readFileSync(`${parameters.NodeStatePath}.exit.json`, "utf8")).exitCode, 0);
      assert.ok(observed.closedAt - ready.startedAt < 5000, `wrapper waited ${observed.closedAt - ready.startedAt}ms after Node started`);
      assert.ok(done.endedAt - ready.startedAt >= 5900);
      subcontext.diagnostic(`stage=${observed.elapsedMs}ms, realChildExit=0, Node lifetime=${done.endedAt - ready.startedAt}ms; logs=${fixture.directory}`);
    });

    await context.test("retains explicit nonzero child exit and stderr", async () => {
      const fixture = makeCase(`${label}-nonzero`);
      write(fixture.scriptPath, 'Write-Error "EXPECTED_STAGE_STDERR" -ErrorAction Continue\nexit 17\n');
      const observed = await invokeStage(executable, fixture);
      assert.equal(observed.code, 17);
      assert.equal(observed.result.childExitCode, 17);
      assert.equal(observed.result.completed, true);
      assert.equal(observed.result.processSucceeded, false);
      assert.equal(observed.result.state, "failed");
      assert.match(fs.readFileSync(observed.result.logPath, "utf8"), /EXPECTED_STAGE_STDERR/);
    });

    await context.test("logs parse failure rather than treating outer tool success as installation success", async () => {
      const fixture = makeCase(`${label}-parse-error`);
      write(fixture.scriptPath, "param(\n");
      const observed = await invokeStage(executable, fixture);
      assert.equal(observed.code, 1);
      assert.equal(observed.result.childExitCode, 1);
      assert.equal(observed.result.completed, true);
      assert.equal(observed.result.processSucceeded, false);
      assert.match(fs.readFileSync(observed.result.logPath, "utf8"), /ParserError|MissingEndParenthesis|param\(/);
    });

    await context.test("empty output and literal JSON parameters preserve types without evaluation", async () => {
      const fixture = makeCase(`${label}-parameters`);
      const markerPath = path.join(fixture.directory, "must not exist.txt");
      const outputPath = path.join(fixture.directory, "received.json");
      const value = `空格 ' \" & ; $() \\ end\\; [System.IO.File]::WriteAllText('${markerPath.replaceAll("'", "''")}', 'bad')`;
      const parameters = { OutputPath: outputPath, Text: value, Empty: "", Enabled: true, Count: 7,
        Items: ["", value, "tail\\"], Mapping: { flag: false, nested: ["", "字"], empty: [], singleton: [""], nulls: [null], deep: [[1, 2], []] }, Nothing: null };
      write(fixture.scriptPath, `param([string]$OutputPath, [string]$Text, [string]$Empty, [switch]$Enabled, [int]$Count, [object[]]$Items, [hashtable]$Mapping, $Nothing)
$Received = @{ Text=$Text; Empty=$Empty; Enabled=[bool]$Enabled; Count=$Count; Items=$Items; Mapping=$Mapping; Nothing=$Nothing; WorkingDirectory=(Get-Location).ProviderPath }
[System.IO.File]::WriteAllText($OutputPath, ($Received | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
exit 0
`);
      const observed = await invokeStage(executable, fixture, parameters);
      assert.equal(observed.code, 0, observed.stderr);
      const { OutputPath, ...expected } = parameters;
      assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), { ...expected, WorkingDirectory: fixture.directory });
      assert.equal(fs.existsSync(markerPath), false);
      assert.equal(sha256(observed.result.requestPath), observed.result.requestSha256);
      assert.throws(() => fs.writeFileSync(observed.result.requestPath, "{}"));
    });

    await context.test("timeout records unknown identity and never retries or terminates the child", async () => {
      const fixture = makeCase(`${label}-timeout`);
      const markerPath = path.join(fixture.directory, "one invocation.txt");
      const donePath = path.join(fixture.directory, "script finished.txt");
      write(fixture.scriptPath, `param([string]$MarkerPath, [string]$DonePath)
[System.IO.File]::AppendAllText($MarkerPath, "once\n")
Start-Sleep -Milliseconds 2500
[System.IO.File]::WriteAllText($DonePath, "normal completion")
exit 0
`);
      const observed = await invokeStage(executable, fixture, { MarkerPath: markerPath, DonePath: donePath }, 1500);
      assert.equal(observed.code, 124);
      assert.equal(observed.result.state, "unknown");
      assert.equal(observed.result.completed, false);
      assert.equal(observed.result.timedOut, true);
      assert.equal(observed.result.childExitCode, null);
      assert.ok(observed.result.childPid && Date.parse(observed.result.childCreatedAt));
      assert.ok(alive(observed.result.childPid));
      const observerPath = write(path.join(fixture.directory, "observe exact child.ps1"), `param([int]$ChildPid, [string]$CreatedAt)
$ErrorActionPreference = "Stop"
$Child = [System.Diagnostics.Process]::GetProcessById($ChildPid)
try {
  $ProcessHandle = $Child.Handle
  if ($Child.StartTime.ToUniversalTime().Ticks -ne [DateTime]::Parse($CreatedAt).ToUniversalTime().Ticks) { throw "Child identity changed" }
  if (-not $Child.WaitForExit(10000)) { throw "Own fixture did not exit naturally" }
  @{ pid=$ChildPid; exitCode=$Child.ExitCode } | ConvertTo-Json
} finally { $Child.Dispose() }
`);
      const observer = await runPowerShell(windowsPowerShell, observerPath, ["-ChildPid", String(observed.result.childPid),
        "-CreatedAt", observed.result.childCreatedAt], `${fixture.logPrefix}-observer`);
      assert.equal(observer.code, 0, observer.stderr);
      assert.equal(JSON.parse(observer.stdout).exitCode, 0);
      await waitFor(() => fs.existsSync(donePath) && !alive(observed.result.childPid), "timed-out child normal completion");
      assert.equal(fs.readFileSync(markerPath, "utf8"), "once\n");
      assert.equal(JSON.parse(fs.readFileSync(observed.result.resultPath, "utf8")).state, "unknown");
      assert.match(fs.readFileSync(observed.result.logPath, "utf8"), /MAINTENANCE_SCRIPT_RETURNED exitCode=0/);
    });

    await context.test("prelaunch missing path and frozen SHA errors save launcher logs without a child", async () => {
      for (const failure of ["missing", "sha"]) {
        const fixture = makeCase(`${label}-${failure}`);
        if (failure === "sha") write(fixture.scriptPath, 'throw "must not execute"\n');
        const observed = await invokeStage(executable, fixture, {}, 10_000, "0".repeat(64));
        assert.equal(observed.code, 1);
        assert.equal(observed.result.completed, false);
        assert.equal(observed.result.childPid, null);
        assert.equal(observed.result.childExitCode, null);
        assert.equal(observed.result.state, "failed");
        assert.ok(observed.result.error);
        assert.match(fs.readFileSync(observed.result.launcherLogPath, "utf8"), /Launcher error/);
      }
    });

    await context.test("child rejects a mutated independent request before invoking its script", async () => {
      const fixture = makeCase(`${label}-request-hash`);
      write(fixture.scriptPath, 'throw "must not execute"\n');
      const requestPath = write(path.join(fixture.directory, "request.json"), JSON.stringify({ schemaVersion: 1,
        scriptPath: fixture.scriptPath, scriptSha256: sha256(fixture.scriptPath), parameters: {} }));
      const digest = sha256(requestPath);
      fs.appendFileSync(requestPath, " ");
      const observed = await runPowerShell(executable, childPath, ["-RequestPath", requestPath, "-RequestSha256", digest], fixture.logPrefix);
      assert.equal(observed.code, 1);
      assert.match(fs.readFileSync(path.join(fixture.directory, "child.log"), "utf8"), /Request SHA256 mismatch/);
    });
  });
}
