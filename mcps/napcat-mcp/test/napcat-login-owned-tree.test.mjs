import assert from "node:assert/strict";
import { spawnSync } from "./helpers/powershell-process.mjs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourcePath = fileURLToPath(new URL("../ops/start-napcat-login.ps1", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("./fixtures/napcat-login-owned-tree/", import.meta.url));
const evidenceDirectory = process.env.NAPCAT_LOGIN_TEST_EVIDENCE_DIR;
const shellCandidates = [
  { name: "Windows PowerShell 5.1", executable: "powershell.exe", major: 5 },
  { name: "PowerShell 7", executable: process.env.NAPCAT_TEST_PWSH || "pwsh.exe", major: 7 },
];

function sourceHash() {
  return createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function dependencyHashes() {
  return Object.fromEntries([
    "start-napcat-login.ps1", "napcat-process-identity.ps1",
    "napcat-quick-login-credential.ps1", "resolve-napcat-data-root.ps1",
  ].map((name) => [name, createHash("sha256").update(fs.readFileSync(path.join(path.dirname(sourcePath), name))).digest("hex")]));
}

for (const shell of shellCandidates) {
  const probe = process.platform === "win32" ? spawnSync(shell.executable, [
    "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()",
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true }) : null;
  const available = probe?.status === 0 && Number(probe.stdout.trim().split(".")[0]) === shell.major;
  test(`${shell.name}: root-exit-before-image-capture`, {
    skip: available ? false : `${shell.executable} unavailable`,
    timeout: 20_000,
  }, () => {
    const runId = randomUUID().replaceAll("-", "");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `napcat-login-root-capture-${runId}-`));
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const command = [
      "$ErrorActionPreference='Stop'",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      `$source=${quote(sourcePath)}`,
      "$tokens=$null; $parseErrors=$null",
      "$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)",
      "if($parseErrors.Count){throw 'source parse failure'}",
      "foreach($name in @('Initialize-QqPathIdentityApi','Get-NormalizedQqPath','Get-NapCatCreationStamp','New-NapCatOwnedRecord','New-NapCatOwnedTree','Update-NapCatOwnedTree','Stop-NapCatOwnedTree','Close-NapCatOwnedTree')){$definition=$ast.Find({param($entry)$entry -is [Management.Automation.Language.FunctionDefinitionAst] -and $entry.Name -eq $name},$true);.([scriptblock]::Create($definition.Extent.Text))}",
      "$info=[Diagnostics.ProcessStartInfo]::new($env:ComSpec);$info.UseShellExecute=$false;$info.CreateNoWindow=$true",
      `$info.Arguments=${quote(`/d /c "rem ${root} & exit /b 0"`)}`,
      `$info.WorkingDirectory=${quote(root)}`,
      "$created=[Diagnostics.Process]::Start($info);$context=$null",
      "try {",
      "  $retained=$created.SafeHandle;$birth=$created.StartTime.ToUniversalTime()",
      "  if(-not $created.WaitForExit(3000)){throw 'fixture did not exit before capture'}",
      "  $snapshot=[pscustomobject]@{ProcessId=$created.Id;ParentProcessId=$PID;CreationDate=$birth;ExecutablePath=$info.FileName;CommandLine=($info.FileName+' '+$info.Arguments)}",
      "  $wrongImage=[pscustomobject]@{ProcessId=$created.Id;ParentProcessId=$PID;CreationDate=$birth;ExecutablePath=$source;CommandLine=$snapshot.CommandLine}",
      "  $wrongImageRejected=$false;try{$null=New-NapCatOwnedTree $created $wrongImage { @() }}catch{$wrongImageRejected=$true}",
      "  $wrongBirth=[pscustomobject]@{ProcessId=$created.Id;ParentProcessId=$PID;CreationDate=$birth.AddSeconds(-1);ExecutablePath=$info.FileName;CommandLine=$snapshot.CommandLine}",
      "  $wrongBirthRejected=$false;try{$null=New-NapCatOwnedTree $created $wrongBirth { @() }}catch{$wrongBirthRejected=$_.Exception.Message -eq 'owned_creation_mismatch'}",
      "  $context=New-NapCatOwnedTree $created $snapshot { @() }",
      "  $record=$context.records[$created.Id]",
      "  if(-not [object]::ReferenceEquals($record.handle,$retained)){throw 'retained root handle changed'}",
      "  $cleanup=Stop-NapCatOwnedTree $context -TimeoutMilliseconds 750",
      "  if($cleanup.state -ne 'terminated' -or $cleanup.remaining.Count -ne 0 -or -not $wrongImageRejected -or -not $wrongBirthRejected){throw 'root capture regression failed'}",
      "  Close-NapCatOwnedTree $context",
      "  [pscustomobject]@{runtime=$PSVersionTable.PSVersion.ToString();rootExitedBeforeCapture=$true;wrongImageRejected=$wrongImageRejected;wrongBirthRejected=$wrongBirthRejected;state=$cleanup.state;captured=$cleanup.captured;remaining=$cleanup.remaining.Count;handleClosed=$retained.IsClosed}|ConvertTo-Json -Compress",
      "} finally {if($null -ne $context -and -not $context.disposed){Close-NapCatOwnedTree $context};$created.Dispose()}",
    ].join("\r\n");
    const before = dependencyHashes();
    try {
      const result = spawnSync(shell.executable, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64"),
      ], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      const after = dependencyHashes();
      if (evidenceDirectory) {
        fs.mkdirSync(evidenceDirectory, { recursive: true });
        fs.writeFileSync(path.join(evidenceDirectory, `ps${shell.major}-root-capture-${runId}.json`), JSON.stringify({
          runtime: probe.stdout.trim(), runId, before, after, status: result.status,
          error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
        }, null, 2));
      }
      assert.deepEqual(after, before);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout.trim());
      assert.equal(report.rootExitedBeforeCapture, true);
      assert.equal(report.wrongImageRejected, true);
      assert.equal(report.wrongBirthRejected, true);
      assert.equal(report.handleClosed, true);
      assert.equal(report.remaining, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  for (const mode of ["owned-tree", "full-entry", "safety", "profile-guard"]) {
    test(`${shell.name}: NapCat login ${mode}`, {
      skip: available ? false : `${shell.executable} unavailable (${probe?.error?.code ?? probe?.status ?? process.platform})`,
      timeout: 35_000,
    }, () => {
      const runId = randomUUID().replaceAll("-", "");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `napcat-login-owned-tree-${runId}-`));
      const before = sourceHash();
      const dependenciesBefore = dependencyHashes();
      const startedAt = Date.now();
      let result;
      try {
        result = spawnSync(shell.executable, [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", path.join(fixtureDirectory, `${mode}.ps1`),
          "-SourcePath", sourcePath, "-NodePath", process.execPath,
          "-FixtureRoot", root, "-RunId", runId,
        ], { encoding: "utf8", timeout: 30_000, windowsHide: true });
        const after = sourceHash();
        const dependenciesAfter = dependencyHashes();
        if (evidenceDirectory) {
          fs.mkdirSync(evidenceDirectory, { recursive: true });
          fs.writeFileSync(path.join(evidenceDirectory, `ps${shell.major}-${mode}-${runId}.json`), JSON.stringify({
            shell: shell.executable,
            runtime: probe.stdout.trim(),
            mode,
            command: [shell.executable, "-File", path.join(fixtureDirectory, `${mode}.ps1`), "-SourcePath", sourcePath, "-FixtureRoot", root, "-RunId", runId],
            elapsedMs: Date.now() - startedAt,
            sourceSha256Before: before,
            sourceSha256After: after,
            dependenciesBefore,
            dependenciesAfter,
            status: result.status,
            error: result.error?.message,
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2));
        }
        assert.equal(after, before, "Login source changed during execution");
        assert.deepEqual(dependenciesAfter, dependenciesBefore, "Login dependency changed during execution");
        assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
        const report = JSON.parse(result.stdout.trim());
        assert.equal(report.sourceSha256.toLowerCase(), before);
        assert.equal(report.sourceUnchanged, true);
        assert.equal(report.productionProcessActions, 0);
        const expectedCount = { "owned-tree": 4, "full-entry": 4, safety: 7, "profile-guard": 4 }[mode];
        assert.equal(report.cases.length, expectedCount);
        for (const scenario of report.cases) assert.equal(scenario.passed, true, JSON.stringify(scenario));
        if (mode === "owned-tree") {
          assert.equal(report.ownRemainingCount, 0);
          assert.equal(report.allTrackedHandlesDisposed, true);
        }
        if (mode === "full-entry") {
          assert.equal(report.sourceExecutedUnmodified, true);
          assert.equal(report.realHttpCalls, 0);
          assert.ok(report.mockOneBotCalls > 0);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
