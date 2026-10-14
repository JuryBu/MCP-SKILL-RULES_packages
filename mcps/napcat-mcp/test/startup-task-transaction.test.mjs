import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const taskXml = command => `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task" version="1.2"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Enabled>true</Enabled></Settings><Actions Context="Author"><Exec><Command>${command}</Command><Arguments>fixture only</Arguments></Exec></Actions></Task>`;

test("Task ACL permits only stable allow-ACE canonicalization and the automatic-inheritance marker", {
  skip: process.platform !== "win32", timeout: 30000,
}, () => {
  const shell = windowsPowerShellEnvironment();
  const script = `. $env:TASK_LIBRARY
$Expected='O:BAG:S-1-5-21-1111111111-2222222222-3333333333-513D:(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;BA)(A;;FR;;;LA)'
$Normalized='O:BAG:S-1-5-21-1111111111-2222222222-3333333333-513D:AI(A;;FR;;;LA)(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)(A;ID;FA;;;BA)'
Assert-StartupTaskSecurityDescriptor $Expected $Expected
Assert-StartupTaskSecurityDescriptor $Expected $Normalized
$Changes=@($Normalized.Replace('FR;;;LA','FA;;;LA'),$Normalized.Replace('FR;;;LA','FR;;;BU'),$Normalized.Replace('O:BA','O:SY'),$Normalized.Replace('-513D:','-514D:'),$Normalized.Replace('D:AI','D:PAI'),$Normalized.Replace('(A;ID;FA;;;BA)',''),$Normalized.Replace('(A;ID;FA;;;BA)','(A;ID;FA;;;BA)(A;ID;FA;;;BA)'),$Normalized.Replace('(A;ID;FA;;;BA)','(A;;FA;;;BA)'),$Normalized.Replace('(A;ID;0x1f019f;;;BA)(A;ID;0x1f019f;;;SY)','(A;ID;0x1f019f;;;SY)(A;ID;0x1f019f;;;BA)'),$Normalized.Replace('(A;;FR;;;LA)','(D;;FR;;;LA)'))
foreach($Changed in $Changes){try{Assert-StartupTaskSecurityDescriptor $Expected $Changed;throw 'UNEXPECTED_PERMISSION_CHANGE_ACCEPTED'}catch{if($_.Exception.Message -cne 'TASK_SECURITY_DESCRIPTOR_CHANGED'){throw}}}
$WithDeny=$Expected.Replace('(A;;FR;;;LA)','(D;;FR;;;LA)')
try{Assert-StartupTaskSecurityDescriptor $WithDeny $Normalized.Replace('(A;;FR;;;LA)','(D;;FR;;;LA)');throw 'DENY_REORDER_ACCEPTED'}catch{if($_.Exception.Message -cne 'TASK_SECURITY_DESCRIPTOR_CHANGED'){throw}}
[pscustomobject]@{accepted=2;refused=11;productionActions=0}|ConvertTo-Json -Compress`;
  const result = spawnSync(shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...shell.environment, TASK_LIBRARY: fileURLToPath(new URL("../ops/startup-task-transaction.ps1", import.meta.url)) },
    encoding: "utf8", windowsHide: true, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { accepted: 2, refused: 11, productionActions: 0 });
});

test("Task stages preserve UTF16 input, disabled restoration, permissions and post-file phase gates without Windows registration", {
  skip: process.platform !== "win32", timeout: 30000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "Task联合 owned "));
  try {
    fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ ownerId: "startup-repair-20261012", fixtureRoot: root }));
    const originalXmlPath = path.join(root, "original.xml");
    const candidateXmlPath = path.join(root, "candidate.xml");
    fs.writeFileSync(originalXmlPath, taskXml("old.exe"));
    fs.writeFileSync(candidateXmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml("new.exe"), "utf16le")]));
    const fixtureXmlPath = path.join(root, "current.xml");
    const fixtureStatePath = path.join(root, "state.json");
    const fixtureLogPath = path.join(root, "actions.log");
    fs.copyFileSync(originalXmlPath, fixtureXmlPath);
    fs.writeFileSync(fixtureStatePath, JSON.stringify({ enabled: true, state: "Ready", securityDescriptor: "fixture-acl" }));
    const dependency = path.join(root, "candidate.bin");
    fs.writeFileSync(dependency, "complete candidate");
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ files: [{ targetPath: dependency, original: { exists: true, sha256: digest(fs.readFileSync(dependency)) }, candidateSha256: digest(fs.readFileSync(dependency)) }] }));
    const configuration = { mode: "TempFixture", fixtureRoot: root, originalWatchdogEnabled: true, manifestPath,
      taskUpgrade: { taskName: "CodexNapCatSupervisor", originalXmlPath, candidateXmlPath,
        originalXmlSha256: digest(fs.readFileSync(originalXmlPath)), candidateXmlSha256: digest(fs.readFileSync(candidateXmlPath)),
        fixtureXmlPath, fixtureStatePath, fixtureLogPath, securityDescriptor: "fixture-acl",
        postInstallPins: [{ path: dependency, sha256: digest(fs.readFileSync(dependency)) }] } };
    const configurationPath = path.join(root, "config.json");
    fs.writeFileSync(configurationPath, JSON.stringify(configuration));
    const shell = windowsPowerShellEnvironment();
    const script = `function Sha([string]$Path){(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function FixtureRootIdentity([string]$Path){[IO.Path]::GetFullPath($Path).TrimEnd('\\','/')}
. $env:TASK_LIBRARY
$Settings=Get-Content -LiteralPath $env:TASK_CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
if((Get-StartupTaskPhase $Settings).phase -cne 'original'){throw 'ORIGINAL_PHASE'}
try{Set-StartupTaskPhase $Settings 'candidate';throw 'ENABLED_WAS_ACCEPTED'}catch{if($_.Exception.Message -cne 'TASK_MUST_BE_DISABLED_AND_STOPPED'){throw}}
Disable-StartupTask $Settings | Out-Null
$OriginalCandidate=$Settings.taskUpgrade.candidateXmlSha256
$OriginalXml=[IO.File]::ReadAllText($Settings.taskUpgrade.candidateXmlPath)
[IO.File]::WriteAllText($Settings.taskUpgrade.candidateXmlPath,$OriginalXml.Replace('ServiceAccount','InteractiveToken'))
$Settings.taskUpgrade.candidateXmlSha256=Sha $Settings.taskUpgrade.candidateXmlPath
try{Set-StartupTaskPhase $Settings 'candidate';throw 'PRINCIPAL_DRIFT_ACCEPTED'}catch{if($_.Exception.Message -cne 'TASK_NON_ACTION_CONFIGURATION_CHANGED'){throw}}
[IO.File]::WriteAllText($Settings.taskUpgrade.candidateXmlPath,$OriginalXml,[Text.UnicodeEncoding]::new($false,$true))
$Settings.taskUpgrade.candidateXmlSha256=$OriginalCandidate
$OriginalPin=$Settings.taskUpgrade.postInstallPins[0].sha256
$Settings.taskUpgrade.postInstallPins[0].sha256='0'*64
try{Set-StartupTaskPhase $Settings 'candidate';throw 'MISSING_FILE_GATE'}catch{if($_.Exception.Message -notlike 'TASK_POST_INSTALL_DEPENDENCY_CHANGED:*'){throw}}
$Settings.taskUpgrade.postInstallPins[0].sha256=$OriginalPin
Set-StartupTaskPhase $Settings 'candidate' | Out-Null
Restore-StartupTaskEnabled $Settings 'candidate' | Out-Null
Disable-StartupTask $Settings | Out-Null
Set-StartupTaskPhase $Settings 'original' | Out-Null
if((Get-StartupTaskPhase $Settings).enabled){throw 'TASK_RAN_BEFORE_FILE_RESTORE'}
[IO.File]::AppendAllText($Settings.taskUpgrade.fixtureLogPath,'FILES_ROLLED_BACK'+[Environment]::NewLine)
Restore-StartupTaskEnabled $Settings 'original' | Out-Null
if((Get-StartupTaskPhase $Settings).phase -cne 'original'){throw 'RESTORE_PHASE'}
[pscustomobject]@{stages=6;windowsTaskActions=0;permissionsPreserved=$true;taskBeforeFiles=$true}|ConvertTo-Json -Compress`;
    const result = spawnSync(shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...shell.environment, TASK_LIBRARY: fileURLToPath(new URL("../ops/startup-task-transaction.ps1", import.meta.url)), TASK_CONFIG: configurationPath },
      encoding: "utf8", windowsHide: true, timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).windowsTaskActions, 0);
    assert.deepEqual(fs.readFileSync(fixtureLogPath, "utf8").trim().split(/\r?\n/u), ["TASK_DISABLED", "TASK_CANDIDATE_DISABLED", "TASK_ENABLE_CANDIDATE", "TASK_DISABLED", "TASK_ORIGINAL_DISABLED", "FILES_ROLLED_BACK", "TASK_ENABLE_ORIGINAL"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
