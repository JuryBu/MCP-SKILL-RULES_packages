import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { buildProxyParentLiveBundle } from "../src/proxy-live-build.mjs";
import { buildFullUpgradePayload } from "../ops/build-full-upgrade-payload.mjs";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";
import { createQqCanonicalFixture } from "./qq-canonical-fixture.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
  helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
const retainQqTask = process.env.NAPCAT_RETAIN_QQ_TASK === "1";

test("full frozen source payload binds worker pins and independently restores every source and private input", {
  timeout: 60000, skip: process.platform !== "win32" || !process.env.CODEX_LIVE_ESBUILD_MODULE,
}, async () => {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "完整升级 owned "));
  const installedRoot = path.join(root, "runtime");
  const packageRoot = path.join(root, "package");
  const compiler = createRequire(import.meta.url)(process.env.CODEX_LIVE_ESBUILD_MODULE);
  try {
    const bundle = await buildProxyParentLiveBundle({ sourceRoot: path.join(sourceRoot, "src"), destinationRoot: path.join(root, "bundle"), version: "full-owner-input", compiler });
    for (const directory of ["src", "ops"]) {
      const target = path.join(installedRoot, directory);
      fs.mkdirSync(target, { recursive: true });
      for (const entry of fs.readdirSync(path.join(sourceRoot, directory), { withFileTypes: true })) {
        assert.ok(entry.isFile(), "fixture sources must be flat regular files");
        fs.copyFileSync(path.join(sourceRoot, directory, entry.name), path.join(target, entry.name));
      }
    }
    const corePath = path.join(installedRoot, "src", names.core);
    fs.writeFileSync(corePath, fs.readFileSync(corePath, "utf8").replace("fastRetryThresholdMs = 8000", "fastRetryThresholdMs = 12000"));
    fs.unlinkSync(path.join(installedRoot, "src", "proxy-whole-runtime-control.mjs"));
    const state = path.join(installedRoot, "state");
    fs.mkdirSync(state);
    const innerProfilePath = path.join(state, "inner-profile.json");
    const outerStartupPath = path.join(state, "outer-startup.json");
    const initialHashes = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, digest(fs.readFileSync(path.join(installedRoot, "src", name)))]));
    const profile = { schemaVersion: 1, mode: "production", installationRoot: installedRoot,
      initial: { runnerPath: path.join(installedRoot, "src", names.runner), expectedHashes: initialHashes },
      ownerId: "full-upgrade-fixture", approvedCandidates: [], environment: { RETAIN_SENTINEL: "unchanged" },
      protectedConfiguration: { binding: "fixture-only", unknownRequests: ["keep"] } };
    fs.writeFileSync(innerProfilePath, JSON.stringify(profile));
    fs.writeFileSync(outerStartupPath, JSON.stringify({ schemaVersion: 1, enabled: true, candidateRoot: path.join(state, "candidates"),
      innerManagedProfilePath: innerProfilePath, innerManagedProfileSha256: digest(fs.readFileSync(innerProfilePath)), extra: "retained" }));
    fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ ownerId: "startup-repair-20261012", fixtureRoot: root }));
    const options = { sourceRoot, installedRoot, outputRoot: path.join(root, "probe"), runtimeManifestPath: bundle.manifestPath,
      runtimeManifestSha256: bundle.manifestSha256, innerProfilePath, outerStartupPath };
    const qqTaskPath = path.join(state, "existing-gui-task.xml");
    const qqTaskBytes = Buffer.from("<Task><Actions><Exec><Command>existing-owned-gui.exe</Command></Exec></Actions></Task>");
    fs.writeFileSync(qqTaskPath, qqTaskBytes);
    const qqInputs = retainQqTask ? {} : createQqCanonicalFixture({ root, installedRoot, stateRoot: state, ownerShell: process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE || windowsPowerShellEnvironment().executable, sourceRoot });
    if (!retainQqTask) {
    const canonical = JSON.parse(fs.readFileSync(qqInputs.qqCanonicalManifestPath));
    const planMapping = canonical.qq5Mappings.find(entry => entry.name === "plan");
    const planCandidatePath = path.join(path.dirname(qqInputs.qqCanonicalManifestPath), planMapping.candidate.path);
    const planCandidate = JSON.parse(fs.readFileSync(planCandidatePath));
    const systemShell = windowsPowerShellEnvironment().executable;
    planCandidate.inputs.push({ path: systemShell, sha256: digest(fs.readFileSync(systemShell)) });
    const planCandidateBytes = Buffer.from(JSON.stringify(planCandidate));
    fs.writeFileSync(planCandidatePath, planCandidateBytes);
    Object.assign(planMapping.candidate, { bytes: planCandidateBytes.length, sha256: digest(planCandidateBytes) });
    Object.assign(canonical.files.find(entry => entry.path === planMapping.candidate.path), planMapping.candidate);
    fs.writeFileSync(qqInputs.qqCanonicalManifestPath, JSON.stringify(canonical));
    qqInputs.qqCanonicalManifestSha256 = digest(fs.readFileSync(qqInputs.qqCanonicalManifestPath));
    Object.assign(options, qqInputs);
    }
    assert.throws(() => buildFullUpgradePayload({ ...options, runtimeManifestSha256: "0".repeat(64) }), /FULL_RUNTIME_MANIFEST_CHANGED/u);
    assert.equal(fs.existsSync(options.outputRoot), false);
    const probe = buildFullUpgradePayload(options);
    const payload = JSON.parse(fs.readFileSync(probe.payloadPath));
    assert.equal(payload.fullHotUpgradeIncluded, true);
    assert.ok(payload.sourceFiles >= 47);
    assert.equal(payload.files.filter(entry => entry.name.startsWith("qq-startup/")).length, retainQqTask ? 0 : 5);
    if (retainQqTask) assert.equal(payload.taskUpgrade, null);
    else assert.equal(payload.taskUpgrade.canonicalManifestSha256, qqInputs.qqCanonicalManifestSha256);
    const newProfileFile = payload.files.find(entry => entry.targetPath === innerProfilePath);
    const newProfile = JSON.parse(fs.readFileSync(newProfileFile.payloadPath));
    assert.deepEqual({ ...newProfile, initial: profile.initial }, profile);
    assert.notEqual(newProfile.initial.expectedHashes.core, initialHashes.core);
    const newStartup = JSON.parse(fs.readFileSync(payload.files.find(entry => entry.targetPath === outerStartupPath).payloadPath));
    assert.equal(newStartup.extra, "retained");
    assert.equal(newStartup.innerManagedProfileSha256, digest(fs.readFileSync(newProfileFile.payloadPath)));
    const shell = windowsPowerShellEnvironment();
    if (process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE) {
      shell.executable = process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE;
      shell.environment = { ...process.env };
    }
    const execute = (script, environment = {}) => spawnSync(shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...shell.environment, ...environment }, encoding: "utf8", windowsHide: true, timeout: 30000 });
    const actualShell = execute("[pscustomobject]@{major=$PSVersionTable.PSVersion.Major;edition=$PSVersionTable.PSEdition;version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress");
    assert.equal(actualShell.status, 0, actualShell.stdout + actualShell.stderr);
    const shellVersion = JSON.parse(actualShell.stdout);
    const prepareScript = "& $env:PREPARE -SourceRoot $env:SOURCE -InstalledRoot $env:TARGET -PackageRoot $env:PACKAGE -NodePath $env:NODE -Mode TempFixture -FixtureRoot $env:FIXTURE -OwnerPowerShellPath $env:OWNER_SHELL -WholeRuntimeManifestPath $env:BUNDLE -WholeRuntimeManifestSha256 $env:BUNDLE_SHA -InnerProfilePath $env:PROFILE -OuterStartupPath $env:STARTUP -QqCanonicalManifestPath $env:QQ_MANIFEST -QqCanonicalManifestSha256 $env:QQ_SHA -QqStateRoot $env:QQ_STATE";
    const prepareEnvironment = {
      PREPARE: path.join(sourceRoot, "ops", "prepare-startup-repair.ps1"), SOURCE: sourceRoot, TARGET: installedRoot, PACKAGE: packageRoot,
      NODE: process.execPath, FIXTURE: root, BUNDLE: bundle.manifestPath, BUNDLE_SHA: bundle.manifestSha256, PROFILE: innerProfilePath, STARTUP: outerStartupPath, OWNER_SHELL: shell.executable,
      QQ_MANIFEST: qqInputs.qqCanonicalManifestPath, QQ_SHA: qqInputs.qqCanonicalManifestSha256, QQ_STATE: qqInputs.qqStateRoot,
    };
    const selectedPrepareScript = retainQqTask ? prepareScript.slice(0, prepareScript.indexOf(" -QqCanonicalManifestPath")) : prepareScript;
    const prepared = execute(selectedPrepareScript, prepareEnvironment);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    let receipt = JSON.parse(prepared.stdout);
    const manifest = JSON.parse(fs.readFileSync(receipt.manifestPath));
    assert.deepEqual([...fs.readFileSync(path.join(packageRoot, "repair-files.ps1")).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(manifest.ownerPowerShell.major, shellVersion.major);
    assert.equal(manifest.ownerPowerShell.edition, shellVersion.edition);
    assert.equal(manifest.scope, "full-runtime-and-startup");
    const originals = manifest.files.map(entry => entry.original.exists ? fs.readFileSync(entry.targetPath) : null);
    const operate = (action, failAfter = -1) => execute("& $env:ENTRY -Action $env:ACTION -Mode TempFixture -ManifestPath $env:MANIFEST -ManifestSha256 $env:SHA -FixtureFailAfterWrites $env:FAIL_AFTER", {
      ENTRY: path.join(path.dirname(receipt.manifestPath), "repair-files.ps1"), ACTION: action, MANIFEST: receipt.manifestPath, SHA: receipt.manifestSha256, FAIL_AFTER: String(failAfter),
    });
    const partial = operate("Install", 2);
    assert.notEqual(partial.status, 0);
    assert.equal(JSON.parse(partial.stdout).status, "PARTIAL_INSTALL", partial.stdout + partial.stderr);
    const rollback = operate("Rollback");
    assert.equal(rollback.status, 0, rollback.stdout + rollback.stderr);
    for (const [index, entry] of manifest.files.entries()) {
      if (originals[index]) assert.deepEqual(fs.readFileSync(entry.targetPath), originals[index]);
      else assert.equal(fs.existsSync(entry.targetPath), false);
    }
    assert.equal(fs.readFileSync(innerProfilePath, "utf8"), JSON.stringify(profile));
    const completePackage = execute(selectedPrepareScript, { ...prepareEnvironment, PACKAGE: path.join(root, "complete-package") });
    assert.equal(completePackage.status, 0, completePackage.stdout + completePackage.stderr);
    receipt = JSON.parse(completePackage.stdout);
    const installed = operate("Install");
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(JSON.parse(installed.stdout).targetWrites, manifest.files.length);
    assert.deepEqual(JSON.parse(fs.readFileSync(innerProfilePath)), newProfile);
    assert.deepEqual(JSON.parse(fs.readFileSync(outerStartupPath)), newStartup);
    const restored = operate("Rollback");
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    for (const [index, entry] of manifest.files.entries()) {
      if (originals[index]) assert.deepEqual(fs.readFileSync(entry.targetPath), originals[index]);
      else assert.equal(fs.existsSync(entry.targetPath), false);
    }
    assert.deepEqual(fs.readFileSync(qqTaskPath), qqTaskBytes);
    console.log(JSON.stringify({ ownerShell: shellVersion, files: manifest.files.length, fullInstall: true, partialAndCompleteRollback: true,
      existingQqTaskRetained: true, qqTaskUpgradeIncluded: !retainQqTask, productionActions: 0 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
