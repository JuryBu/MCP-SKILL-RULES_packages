import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

test("legacy manifest owner preparation pins its fallback shell identity", { skip: process.platform !== "win32" }, () => {
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-legacy-owner-"));
  const serviceRoot = path.join(root, "runtime");
  const packageRoot = path.join(root, "package");
  const serviceOps = path.join(serviceRoot, "ops");
  const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    fs.mkdirSync(serviceOps, { recursive: true });
    fs.mkdirSync(packageRoot);
    for (const name of ["start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1",
      "resolve-napcat-data-root.ps1", "Run-NapCatSupervisorWatchdog.ps1", "Run-HiddenPowerShell.vbs"]) {
      fs.writeFileSync(path.join(serviceOps, name), "fixture");
    }
    fs.writeFileSync(path.join(packageRoot, "repair-files.ps1"), "fixture");
    fs.writeFileSync(path.join(packageRoot, "manifest.json"), JSON.stringify({ mode: "ManualProduction", targetRoot: serviceRoot, files: [] }));
    const child = windowsPowerShellEnvironment();
    const result = spawnSync(child.executable, ["-NoProfile", "-NonInteractive", "-Command",
      "function Get-ScheduledTask { [pscustomobject]@{Actions=@([pscustomobject]@{Execute='fixture';Arguments='fixture'});Settings=[pscustomobject]@{Enabled=$true}} }; function Export-ScheduledTask { '<fixture />' }; & $env:OWNER_PREPARE -SourceRoot $env:OWNER_SOURCE -PackageRoot $env:OWNER_PACKAGE -ServiceRoot $env:OWNER_SERVICE -DataRoot $env:OWNER_DATA -BrokerRoot $env:OWNER_DATA -NapCatRoot $env:OWNER_DATA -QqExePath $env:OWNER_EXE -NodePath $env:OWNER_EXE -CodexExecutablePath $env:OWNER_EXE"],
      { env: { ...child.environment, OWNER_PREPARE: path.join(sourceRoot, "ops", "prepare-startup-owner.ps1"),
        OWNER_SOURCE: sourceRoot, OWNER_PACKAGE: packageRoot, OWNER_SERVICE: serviceRoot,
        OWNER_DATA: path.join(root, "data"), OWNER_EXE: child.executable }, encoding: "utf8", windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const configuration = JSON.parse(fs.readFileSync(path.join(packageRoot, "owner-configuration.json"), "utf8"));
    assert.equal(configuration.ownerPowerShell.path.toLowerCase(), child.executable.toLowerCase());
    assert.equal(configuration.ownerPowerShell.sha256, digest(fs.readFileSync(child.executable)));
    assert.equal(configuration.ownerPowerShell.major, 5);
    assert.equal(configuration.ownerPowerShell.edition, "Desktop");
    assert.ok(configuration.pins.some(pin => pin.path === configuration.ownerPowerShell.path && pin.sha256 === configuration.ownerPowerShell.sha256));
    console.log(JSON.stringify({ legacyManifest: true, fallbackShaPinned: true, productionActions: 0 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
