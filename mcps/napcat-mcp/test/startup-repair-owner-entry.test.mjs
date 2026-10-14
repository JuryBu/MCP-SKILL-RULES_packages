import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";
import { restoreFixtureBaseline } from "./startup-repair-baseline.mjs";
import { buildProxyParentLiveBundle } from "../src/proxy-live-build.mjs";
import { createQqCanonicalFixture } from "./qq-canonical-fixture.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

for (const { scope, partialTaskRegistration, withoutTaskReplacement = false, originalWatchdogEnabled = true } of [
  { scope: "startup-notification-only", partialTaskRegistration: false },
  { scope: "full-runtime-and-startup", partialTaskRegistration: false },
  { scope: "full-runtime-and-startup", partialTaskRegistration: true },
  { scope: "full-runtime-and-startup", partialTaskRegistration: false, withoutTaskReplacement: true, originalWatchdogEnabled: true },
  { scope: "full-runtime-and-startup", partialTaskRegistration: false, withoutTaskReplacement: true, originalWatchdogEnabled: false },
]) {
const title = withoutTaskReplacement ? `owner entry restores original watchdog enabled=${originalWatchdogEnabled} without Task replacement` : partialTaskRegistration ? "owner entry recovers all files and original Task after partial Task registration failure" : `owner entry restores ${scope}, owned stop cleanup, scanner and supervisor in its bounded Windows fixture`;
test(title, { timeout: 240000, skip: process.platform !== "win32" || (scope === "full-runtime-and-startup" && !process.env.CODEX_LIVE_ESBUILD_MODULE) }, async () => {
  const installedRoot = process.env.NAPCAT_INSTALLED_TEST_ROOT;
  assert.ok(installedRoot, "NAPCAT_INSTALLED_TEST_ROOT_REQUIRED");
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "主人入口 owned "));
  const targetRoot = path.join(root, "runtime");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(targetRoot);
  fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ ownerId: "startup-repair-20261012", fixtureRoot: root }));
  const child = windowsPowerShellEnvironment();
  const ownerShell = process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE || child.executable;
  if (process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE) {
    child.executable = ownerShell;
    child.environment = { ...process.env };
  }
  const shell = (script, extra = {}) => spawnSync(child.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...child.environment, ...extra }, encoding: "utf8", windowsHide: true, timeout: 90000,
  });
  let succeeded = false;
  try {
    for (const folder of ["src", "ops"]) {
      fs.mkdirSync(path.join(targetRoot, folder));
      for (const entry of fs.readdirSync(path.join(installedRoot, folder), { withFileTypes: true })) {
        if (entry.isFile() && /\.(?:mjs|ps1)$/u.test(entry.name)) fs.copyFileSync(path.join(installedRoot, folder, entry.name), path.join(targetRoot, folder, entry.name));
      }
    }
    restoreFixtureBaseline(installedRoot, targetRoot);
    let fullEnvironment = {};
    let fullArguments = "";
    if (scope === "full-runtime-and-startup") {
      const compiler = createRequire(import.meta.url)(process.env.CODEX_LIVE_ESBUILD_MODULE);
      const bundle = await buildProxyParentLiveBundle({ sourceRoot: path.join(sourceRoot, "src"), destinationRoot: path.join(root, "bundle"), version: "full-owner-wrapper", compiler });
      const privateRoot = path.join(targetRoot, "state");
      fs.mkdirSync(privateRoot);
      const profilePath = path.join(privateRoot, "profile.json");
      const startupPath = path.join(privateRoot, "startup.json");
      const workerNames = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs", helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
      const workerHashes = Object.fromEntries(Object.entries(workerNames).map(([key, name]) => [key, digest(fs.readFileSync(path.join(targetRoot, "src", name)))]));
      fs.writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, mode: "production", installationRoot: targetRoot, initial: { runnerPath: path.join(targetRoot, "src", workerNames.runner), expectedHashes: workerHashes }, protectedConfiguration: { unknownRequests: ["preserve"] } }));
      fs.writeFileSync(startupPath, JSON.stringify({ schemaVersion: 1, innerManagedProfilePath: profilePath, innerManagedProfileSha256: digest(fs.readFileSync(profilePath)), retained: true }));
      fullArguments = " -WholeRuntimeManifestPath $env:REPAIR_BUNDLE -WholeRuntimeManifestSha256 $env:REPAIR_BUNDLE_SHA -InnerProfilePath $env:REPAIR_PROFILE -OuterStartupPath $env:REPAIR_STARTUP";
      fullEnvironment = { REPAIR_BUNDLE: bundle.manifestPath, REPAIR_BUNDLE_SHA: bundle.manifestSha256, REPAIR_PROFILE: profilePath, REPAIR_STARTUP: startupPath };
      if (!withoutTaskReplacement) {
        const qq = createQqCanonicalFixture({ root, installedRoot: targetRoot, stateRoot: privateRoot, ownerShell, sourceRoot });
        fullArguments += " -QqCanonicalManifestPath $env:QQ_MANIFEST -QqCanonicalManifestSha256 $env:QQ_SHA -QqStateRoot $env:QQ_STATE";
        Object.assign(fullEnvironment, { QQ_MANIFEST: qq.qqCanonicalManifestPath, QQ_SHA: qq.qqCanonicalManifestSha256, QQ_STATE: qq.qqStateRoot });
      }
    }
    const launcherPath = path.join(targetRoot, "desktop-launcher.ps1");
    fs.writeFileSync(launcherPath, "function Start-RequiredRuntime {\n    try {\n      $MpPath=Join-Path $Plan.dataRoot 'state\\inner-managed'\n      $reason='gate_resolved_unclean_exit';$backup='.crash-'\n    } catch {}\n    $StartModelArgs=@{DataRoot=$Plan.dataRoot}\n}\n");
    const prepared = shell("& $env:REPAIR_PREPARE -SourceRoot $env:REPAIR_SOURCE -InstalledRoot $env:REPAIR_TARGET -DesktopLauncherPath $env:REPAIR_LAUNCHER -PackageRoot $env:REPAIR_PACKAGE -NodePath $env:REPAIR_NODE -Mode TempFixture -FixtureRoot $env:REPAIR_FIXTURE -OwnerPowerShellPath $env:REPAIR_OWNER_SHELL" + fullArguments, {
      REPAIR_PREPARE: path.join(sourceRoot, "ops", "prepare-startup-repair.ps1"), REPAIR_SOURCE: sourceRoot,
      REPAIR_TARGET: targetRoot, REPAIR_LAUNCHER: launcherPath, REPAIR_PACKAGE: packageRoot, REPAIR_NODE: process.execPath, REPAIR_FIXTURE: root, REPAIR_OWNER_SHELL: ownerShell,
      ...fullEnvironment,
    });
    if (scope === "startup-notification-only" && prepared.status !== 0 && /STARTUP_ONLY_REQUIRES_FULL_RUNTIME_PACKAGE/u.test(prepared.stdout + prepared.stderr)) {
      assert.equal(fs.existsSync(path.join(packageRoot, "payload")), false);
      assert.equal(fs.existsSync(path.join(packageRoot, "manifest.json")), false);
      console.log(JSON.stringify({ scope, requiresWholeRuntime: true, targetWrites: 0, productionActions: 0 }));
      succeeded = true;
      return;
    }
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const preparation = JSON.parse(prepared.stdout);
    const manifest = JSON.parse(fs.readFileSync(preparation.manifestPath));
    const originals = manifest.files.map(entry => entry.original.exists ? fs.readFileSync(entry.targetPath) : null);
    const stateRoot = path.join(root, "data", "state");
    fs.mkdirSync(path.join(stateRoot, "inner-managed"), { recursive: true });
    const managedPath = path.join(stateRoot, "inner-managed", "managed-runtime.json");
    const managed = { controlBusy: false, coordinator: { transactionActive: false, threads: [{ phase: "terminal", activeHttp: 0 }] } };
    fs.writeFileSync(managedPath, JSON.stringify(managed));
    fs.writeFileSync(path.join(stateRoot, "codex-app-server-proxy-runtime.json"), JSON.stringify({ pid: 999999999, appServerPid: null }));
    const supervisorStop = path.join(stateRoot, "supervisor.stop");
    fs.writeFileSync(supervisorStop, "fixture original stop");
    const stopSha = digest(fs.readFileSync(supervisorStop));
    const serviceOps = path.join(root, "fake-ops");
    fs.mkdirSync(serviceOps);
    const actionLog = path.join(root, "actions.log");
    const record = "$StateRoot=Join-Path $DataRoot 'state'; [IO.File]::AppendAllText((Join-Path (Split-Path -Parent $DataRoot) 'actions.log'),$MyInvocation.MyCommand.Name+[Environment]::NewLine); ";
    const parameterBlock = "param([string]$DataRoot,[string]$CodexExecutablePath,[string]$BrokerRoot,[string]$NapCatRoot,[string]$QqExePath)\n";
    fs.writeFileSync(path.join(serviceOps, "start-codex-model-stream-proxy.ps1"), parameterBlock + record + "if(Test-Path -LiteralPath (Join-Path $StateRoot 'codex-app-server-proxy.stop')) {throw 'OWNED_STOP_LEAKED'}; @{running=$true;mode='managed';outer=@{state='running'}}|ConvertTo-Json -Compress\n");
    for (const name of ["start-napcat-task-router.ps1", "start-napcat-supervisor.ps1"]) {
      fs.writeFileSync(path.join(serviceOps, name), parameterBlock + record + "@{started=$true}|ConvertTo-Json -Compress\n");
    }
    const wrapper = path.join(packageRoot, "continue-startup-repair.ps1");
    fs.copyFileSync(path.join(sourceRoot, "ops", "continue-startup-repair.ps1"), wrapper);
    const watchdogStatePath = path.join(root, "watchdog-state.json");
    fs.writeFileSync(watchdogStatePath, JSON.stringify({ execute: "fixture-watchdog.exe", arguments: "fixture only", enabled: originalWatchdogEnabled }));
    const configuration = {
      watchdogExecute: "fixture-watchdog.exe", watchdogArguments: "fixture only", originalWatchdogEnabled,
      schemaVersion: 1, mode: "TempFixture", fixtureRoot: root, ownerEntrySha256: digest(fs.readFileSync(wrapper)),
      fileEntry: path.join(packageRoot, "repair-files.ps1"), manifestPath: preparation.manifestPath, manifestSha256: preparation.manifestSha256,
      serviceOps, stopOps: path.join(packageRoot, "recovery", "ops"), dataRoot: path.dirname(stateRoot), brokerRoot: path.join(root, "broker"),
      napCatRoot: path.join(root, "napcat"), qqExePath: path.join(root, "qq.exe"), codexExecutablePath: path.join(root, "codex.exe"),
      nodePath: process.execPath, supervisorStopSha256: stopSha, pins: [], ownerPowerShell: JSON.parse(fs.readFileSync(preparation.manifestPath)).ownerPowerShell,
      upgradeScope: scope,
    };
    if (manifest.taskUpgrade) {
      const taskXml = path.join(root, "current-task.xml");
      const taskState = path.join(root, "current-task.json");
      fs.copyFileSync(manifest.taskUpgrade.originalXmlPath, taskXml);
      fs.writeFileSync(taskState, JSON.stringify({ enabled: true, state: "Ready", securityDescriptor: "fixture-acl" }));
      configuration.taskUpgrade = { ...manifest.taskUpgrade, fixtureXmlPath: taskXml, fixtureStatePath: taskState, fixtureLogPath: actionLog, securityDescriptor: "fixture-acl" };
      configuration.originalWatchdogEnabled = true;
      configuration.taskHelperPath = path.join(packageRoot, "recovery", "ops", "startup-task-transaction.ps1");
      fs.copyFileSync(path.join(sourceRoot, "ops", "startup-task-transaction.ps1"), configuration.taskHelperPath);
    }
    const configurationPath = path.join(packageRoot, "configuration.json");
    fs.writeFileSync(configurationPath, JSON.stringify(configuration));
    const configurationSha = digest(fs.readFileSync(configurationPath));
    const consent = scope === "full-runtime-and-startup" ? "APPLY_FULL_RUNTIME_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG" : "APPLY_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG";
    const invoke = (action, confirmation = consent, configurationDigest = configurationSha) => shell("& $env:OWNER_ENTRY -ConfigurationPath $env:OWNER_CONFIG -ConfigurationSha256 $env:OWNER_SHA -Action $env:OWNER_ACTION -OwnerConfirmation $env:OWNER_CONSENT -FixtureCloseConfirmation CLOSE-CODEX", {
      OWNER_ENTRY: wrapper, OWNER_CONFIG: configurationPath, OWNER_SHA: configurationDigest, OWNER_ACTION: action, OWNER_CONSENT: confirmation,
    });
    const markerPath = path.join(root, "owner.json");
    const markerBytes = fs.readFileSync(markerPath);
    for (const [marker, expected] of [
      [{ ownerId: "wrong-owner", fixtureRoot: root }, /FIXTURE_OWNER_CONFLICT/u],
      [{ ownerId: "startup-repair-20261012", fixtureRoot: "relative-root" }, /FIXTURE_PATH_ESCAPE/u],
    ]) {
      fs.writeFileSync(markerPath, JSON.stringify(marker));
      const refused = invoke("Apply");
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout + refused.stderr, expected);
      assert.equal(fs.existsSync(actionLog), false);
    }
    const linkedRoot = path.join(root, "owner-link");
    fs.symlinkSync(root, linkedRoot, "junction");
    fs.writeFileSync(markerPath, JSON.stringify({ ownerId: "startup-repair-20261012", fixtureRoot: linkedRoot }));
    const linked = invoke("Apply");
    assert.notEqual(linked.status, 0);
    assert.match(linked.stdout + linked.stderr, /FIXTURE_PATH_LINK_FORBIDDEN/u);
    assert.equal(fs.existsSync(actionLog), false);
    fs.unlinkSync(linkedRoot);
    fs.writeFileSync(markerPath, markerBytes);
    if (scope === "full-runtime-and-startup") {
      const wrongConsent = invoke("Apply", "APPLY_STARTUP_NOTIFY_AND_STOP_IDLE_WATCHDOG");
      assert.notEqual(wrongConsent.status, 0);
      assert.match(wrongConsent.stdout + wrongConsent.stderr, /OWNER_CONFIRMATION_REQUIRED/u);
      assert.equal(fs.existsSync(actionLog), false);
      fs.writeFileSync(configurationPath, JSON.stringify({ ...configuration, upgradeScope: "startup-notification-only" }));
      const wrongScope = invoke("Apply", consent, digest(fs.readFileSync(configurationPath)));
      assert.notEqual(wrongScope.status, 0);
      assert.match(wrongScope.stdout + wrongScope.stderr, /OWNER_MANIFEST_SCOPE_CHANGED/u);
      assert.equal(fs.existsSync(actionLog), false);
      fs.writeFileSync(configurationPath, JSON.stringify(configuration));
    }
    if (partialTaskRegistration) {
      const originalHelper = fs.readFileSync(configuration.taskHelperPath, "utf8");
      fs.writeFileSync(configuration.taskHelperPath, originalHelper + `\n$script:FixtureOriginalTaskPhase=(Get-Command Set-StartupTaskPhase).ScriptBlock\nfunction Set-StartupTaskPhase {param($Settings,[string]$Phase);$Verified=& $script:FixtureOriginalTaskPhase $Settings $Phase;if($Phase -ceq 'candidate'){throw 'FIXTURE_REGISTER_PARTIAL_FAILURE'};return $Verified}\n`);
      const failedRegistration = invoke("Apply");
      assert.notEqual(failedRegistration.status, 0, failedRegistration.stdout + failedRegistration.stderr);
      const failureResult = JSON.parse(fs.readFileSync(path.join(packageRoot, "owner-result.json")));
      assert.equal(failureResult.error, "FIXTURE_REGISTER_PARTIAL_FAILURE", failedRegistration.stdout + failedRegistration.stderr);
      assert.equal(failureResult.status, "JOINT_ROLLED_BACK_OPEN_SHORTCUT_MANUALLY", JSON.stringify(failureResult));
      assert.equal(failureResult.filesInstalled, false);
      assert.equal(failureResult.taskPhase, "original");
      assert.equal(JSON.parse(fs.readFileSync(configuration.taskUpgrade.fixtureStatePath)).enabled, true);
      for (const [index, entry] of manifest.files.entries()) {
        if (originals[index]) assert.deepEqual(fs.readFileSync(entry.targetPath), originals[index]);
        else assert.equal(fs.existsSync(entry.targetPath), false);
      }
      assert.deepEqual(fs.readFileSync(actionLog, "utf8").trim().split(/\r?\n/u), ["TASK_DISABLED", "TASK_CANDIDATE_DISABLED", "TASK_DISABLED", "TASK_ORIGINAL_DISABLED", "TASK_ENABLE_ORIGINAL"]);
      assert.equal(fs.existsSync(path.join(stateRoot, "codex-app-server-proxy.stop")), false);
      assert.equal(fs.existsSync(path.join(stateRoot, "supervisor-watchdog.stop")), false);
      console.log(JSON.stringify({ partialTaskRegistrationRestored: true, allFileOriginalsRestored: true, files: manifest.files.length, windowsTaskActions: 0, productionActions: 0 }));
      succeeded = true;
      return;
    }
    const applied = invoke("Apply");
    assert.equal(applied.status, 0, applied.stdout + applied.stderr);
    const appliedResult = JSON.parse(fs.readFileSync(path.join(packageRoot, "owner-result.json")));
    assert.equal(appliedResult.status, "FILES_INSTALLED_SERVICES_STARTED_OPEN_SHORTCUT_MANUALLY", applied.stdout + applied.stderr);
    assert.equal(appliedResult.filesInstalled, true);
    if (!manifest.taskUpgrade) assert.equal(JSON.parse(fs.readFileSync(watchdogStatePath)).enabled, originalWatchdogEnabled);
    assert.equal(fs.existsSync(path.join(stateRoot, "codex-app-server-proxy.stop")), false);
    assert.equal(fs.existsSync(supervisorStop), false);
    assert.equal(fs.existsSync(path.join(stateRoot, 'supervisor-watchdog.stop')), false);
    assert.equal(digest(fs.readFileSync(path.join(packageRoot, "retired-supervisor.stop"))), stopSha);
    assert.deepEqual(fs.readFileSync(actionLog, "utf8").trim().split(/\r?\n/u), manifest.taskUpgrade
      ? ["TASK_DISABLED", "TASK_CANDIDATE_DISABLED", "start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1", "TASK_ENABLE_CANDIDATE"]
      : ["start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1"]);
    if (manifest.taskUpgrade && scope === "full-runtime-and-startup") {
      const taskState = JSON.parse(fs.readFileSync(configuration.taskUpgrade.fixtureStatePath));
      taskState.enabled = false;
      fs.writeFileSync(configuration.taskUpgrade.fixtureStatePath, JSON.stringify(taskState));
      const installedBeforeResume = manifest.files.map(entry => ({ bytes: fs.readFileSync(entry.targetPath), modified: fs.statSync(entry.targetPath).mtimeMs }));
      const resumed = invoke("ResumeInstalled");
      assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
      const resumeResult = JSON.parse(fs.readFileSync(path.join(packageRoot, "owner-result.json")));
      assert.equal(resumeResult.filesInstalled, true);
      assert.equal(resumeResult.servicesReady, true);
      assert.equal(resumeResult.taskPhase, "candidate");
      assert.deepEqual(fs.readFileSync(actionLog, "utf8").trim().split(/\r?\n/u).slice(-5), ["TASK_DISABLED", "start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1", "TASK_ENABLE_CANDIDATE"]);
      for (const [index, entry] of manifest.files.entries()) {
        assert.deepEqual(fs.readFileSync(entry.targetPath), installedBeforeResume[index].bytes);
        assert.equal(fs.statSync(entry.targetPath).mtimeMs, installedBeforeResume[index].modified);
      }
    }
    const restored = invoke("RestoreFiles");
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const restoreResult = JSON.parse(fs.readFileSync(path.join(packageRoot, "owner-result.json")));
    assert.equal(restoreResult.status, "ROLLED_BACK", restored.stdout + restored.stderr);
    if (!manifest.taskUpgrade) assert.equal(JSON.parse(fs.readFileSync(watchdogStatePath)).enabled, originalWatchdogEnabled);
    for (const [index, entry] of manifest.files.entries()) {
      if (originals[index]) assert.deepEqual(fs.readFileSync(entry.targetPath), originals[index]);
      else assert.equal(fs.existsSync(entry.targetPath), false);
    }
    if (manifest.taskUpgrade) {
      assert.deepEqual(fs.readFileSync(actionLog, "utf8").trim().split(/\r?\n/u).slice(-3), ["TASK_DISABLED", "TASK_ORIGINAL_DISABLED", "TASK_ENABLE_ORIGINAL"]);
      assert.equal(JSON.parse(fs.readFileSync(configuration.taskUpgrade.fixtureStatePath)).enabled, true);
      assert.equal(restoreResult.taskPhase, "original");
    }
    console.log(JSON.stringify({ scope, files: manifest.files.length, ownerEntry: appliedResult.status, rollback: restoreResult.status, ownedStopRemoved: true, originalSupervisorStopArchived: true, windowsTaskActions: 0, productionActions: 0 }));
    succeeded = true;
  } finally {
    if (succeeded) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.error(JSON.stringify({ failedFixtureRoot: root, retainedForDiagnosis: true }));
  }
});
}
