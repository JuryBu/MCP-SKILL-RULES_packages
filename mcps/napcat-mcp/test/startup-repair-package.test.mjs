import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";
import { restoreFixtureBaseline } from "./startup-repair-baseline.mjs";

test("minimal startup package installs and independently rolls back all files, including newly absent originals", { timeout: 60000, skip: process.platform !== "win32" }, () => {
  const installedRoot = process.env.NAPCAT_INSTALLED_TEST_ROOT;
  assert.ok(installedRoot, "NAPCAT_INSTALLED_TEST_ROOT_REQUIRED");
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "启动修复 owned "));
  const targetRoot = path.join(root, "runtime");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(targetRoot);
  fs.writeFileSync(path.join(root, "owner.json"), JSON.stringify({ ownerId: "startup-repair-20261012", fixtureRoot: root }));
  try {
    for (const folder of ["src", "ops"]) {
      fs.mkdirSync(path.join(targetRoot, folder));
      for (const entry of fs.readdirSync(path.join(installedRoot, folder), { withFileTypes: true })) {
        if (entry.isFile() && /\.(?:mjs|ps1)$/u.test(entry.name)) fs.copyFileSync(path.join(installedRoot, folder, entry.name), path.join(targetRoot, folder, entry.name));
      }
    }
    restoreFixtureBaseline(installedRoot, targetRoot);
    const launcherPath = path.join(targetRoot, "desktop-launcher.ps1");
    fs.writeFileSync(launcherPath, "function Start-RequiredRuntime {\n    try {\n      $MpPath=Join-Path $Plan.dataRoot 'state\\inner-managed'\n      $reason='gate_resolved_unclean_exit';$backup='.crash-'\n    } catch {}\n    $StartModelArgs=@{DataRoot=$Plan.dataRoot}\n}\n");
    const child = windowsPowerShellEnvironment();
    const ownerShell = process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE || child.executable;
    if (process.env.NAPCAT_OWNER_POWERSHELL_TEST_EXE) {
      child.executable = ownerShell;
      child.environment = { ...process.env };
    }
    const shell = (script, extra = {}) => spawnSync(child.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...child.environment, ...extra }, encoding: "utf8", windowsHide: true, timeout: 30000,
    });
    const prepared = shell("& $env:REPAIR_PREPARE -SourceRoot $env:REPAIR_SOURCE -InstalledRoot $env:REPAIR_TARGET -DesktopLauncherPath $env:REPAIR_LAUNCHER -PackageRoot $env:REPAIR_PACKAGE -NodePath $env:REPAIR_NODE -Mode TempFixture -FixtureRoot $env:REPAIR_FIXTURE -OwnerPowerShellPath $env:REPAIR_OWNER_SHELL", {
      REPAIR_PREPARE: path.join(sourceRoot, "ops", "prepare-startup-repair.ps1"), REPAIR_SOURCE: sourceRoot,
      REPAIR_TARGET: targetRoot, REPAIR_LAUNCHER: launcherPath, REPAIR_PACKAGE: packageRoot, REPAIR_NODE: process.execPath, REPAIR_FIXTURE: root, REPAIR_OWNER_SHELL: ownerShell,
    });
    if (prepared.status !== 0 && /STARTUP_ONLY_REQUIRES_FULL_RUNTIME_PACKAGE/u.test(prepared.stdout + prepared.stderr)) {
      assert.equal(fs.existsSync(path.join(packageRoot, "payload")), false);
      assert.equal(fs.existsSync(path.join(packageRoot, "manifest.json")), false);
      console.log(JSON.stringify({ legacyScopeRejected: true, reason: "new runner requires the complete runtime graph", targetWrites: 0, productionActions: 0 }));
      return;
    }
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = JSON.parse(prepared.stdout);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
    assert.equal(result.targetWrites, 0);
    assert.ok(manifest.files.length >= 10);
    const originals = manifest.files.map(file => ({ path: path.join(targetRoot, file.name), bytes: file.original.exists ? fs.readFileSync(path.join(targetRoot, file.name)) : null }));
    const entry = path.join(packageRoot, "repair-files.ps1");
    const operation = action => shell("& $env:REPAIR_ENTRY -Action $env:REPAIR_ACTION -Mode TempFixture -ManifestPath $env:REPAIR_MANIFEST -ManifestSha256 $env:REPAIR_SHA", {
      REPAIR_ENTRY: entry, REPAIR_ACTION: action, REPAIR_MANIFEST: result.manifestPath, REPAIR_SHA: result.manifestSha256,
    });
    const inspect = operation("Inspect");
    assert.equal(inspect.status, 0, inspect.stdout + inspect.stderr);
    const markerPath = path.join(root, "owner.json");
    const markerBytes = fs.readFileSync(markerPath);
    fs.writeFileSync(markerPath, JSON.stringify({ ownerId: "startup-repair-20261012", fixtureRoot: "relative-root" }));
    const refused = operation("Inspect");
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /PATH_NOT_PLAIN_ABSOLUTE/u);
    fs.writeFileSync(markerPath, markerBytes);
    const installed = operation("Install");
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(JSON.parse(installed.stdout).targetWrites, manifest.files.length);
    for (const [index, file] of manifest.files.entries()) assert.deepEqual(fs.readFileSync(path.join(targetRoot, file.name)), fs.readFileSync(path.join(packageRoot, "candidate", `${index}.bin`)));
    const installedFiles = manifest.files.map(file => ({ path: path.join(targetRoot, file.name), bytes: fs.readFileSync(path.join(targetRoot, file.name)) }));
    assert.ok(!fs.readFileSync(launcherPath, "utf8").includes("gate_resolved_unclean_exit"));
    fs.rmSync(path.join(packageRoot, "candidate"), { recursive: true });
    const rollback = operation("Rollback");
    assert.equal(rollback.status, 0, rollback.stdout + rollback.stderr);
    for (const original of originals) {
      if (original.bytes) assert.deepEqual(fs.readFileSync(original.path), original.bytes);
      else assert.equal(fs.existsSync(original.path), false);
    }
    console.log(JSON.stringify({ files: manifest.files.length, installed: JSON.parse(installed.stdout).status,
      rollback: JSON.parse(rollback.stdout).status, candidateAbsentDuringRollback: true, productionActions: 0 }));
    for (const file of installedFiles) fs.writeFileSync(file.path, file.bytes);
    const localRequire = createRequire(import.meta.url);
    fs.mkdirSync(path.join(targetRoot, "node_modules"));
    fs.cpSync(path.dirname(localRequire.resolve("ws/package.json")), path.join(targetRoot, "node_modules", "ws"), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, "test"));
    for (const filename of ["inner-startup-history-recovery.test.mjs", "inner-startup-residual-native.mjs",
      "inner-runtime-profile-native.mjs", "inner-managed-desktop-restart.test.mjs"]) {
      fs.copyFileSync(path.join(sourceRoot, "test", filename), path.join(targetRoot, "test", filename));
    }
    const runtimeEnvironment = { ...child.environment };
    delete runtimeEnvironment.NODE_TEST_CONTEXT;
    const runtime = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "test/inner-startup-history-recovery.test.mjs", "test/inner-managed-desktop-restart.test.mjs"], {
      cwd: targetRoot, env: runtimeEnvironment, windowsHide: true, encoding: "utf8", timeout: 20000,
    });
    assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
    assert.match(runtime.stdout, /tests 2/);
    console.log(runtime.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
