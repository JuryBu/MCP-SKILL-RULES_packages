import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { prepareStartupStatic, startupStaticFiles } from "../ops/prepare-startup-static.mjs";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

test("startup-only replacement preserves state and independently restores bytes, including a partial locked-file failure", { skip: process.platform !== "win32", timeout: 60000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-static-owned-"));
  const installed = path.join(root, "installed");
  const packageRoot = path.join(root, "package");
  const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
  try {
    for (const filename of startupStaticFiles) {
      const target = path.join(installed, filename);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "original:" + filename);
    }
    const ledger = path.join(installed, "private-state.json");
    fs.writeFileSync(ledger, '{"unknown":"keep","active":"keep"}');
    const desktopLauncherPath = path.join(root, "desktop-launcher.ps1");
    fs.writeFileSync(desktopLauncherPath, "if(-not $ModelStatus.healthy) {throw 'MODEL_PROXY_NOT_READY'}");
    const prepared = prepareStartupStatic({ sourceRoot, installedRoot: installed, packageRoot, desktopLauncherPath });
    const manifest = JSON.parse(fs.readFileSync(prepared.manifestPath));
    assert.equal(prepared.targetWrites, 0);
    const child = windowsPowerShellEnvironment();
    const execute = (action, lock = false) => spawnSync(child.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop';$handle=$null;try {if($env:STATIC_LOCK){$handle=[IO.File]::Open($env:STATIC_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)};& $env:STATIC_ENTRY -ManifestPath $env:STATIC_MANIFEST -ManifestSha256 $env:STATIC_HASH -Action $env:STATIC_ACTION}finally{if($handle){$handle.Dispose()}}"],
    { windowsHide: true, encoding: "utf8", timeout: 15000, env: { ...child.environment, STATIC_ENTRY: path.join(packageRoot, "update-startup-static.ps1"),
      STATIC_MANIFEST: prepared.manifestPath, STATIC_HASH: prepared.manifestSha256, STATIC_ACTION: action,
      STATIC_LOCK: lock ? manifest.files.at(-1).target : "" } });
    const inspect = execute("Inspect");
    assert.equal(inspect.status, 0, inspect.stderr);
    const failed = execute("Update", true);
    assert.notEqual(failed.status, 0);
    for (const file of manifest.files) assert.deepEqual(fs.readFileSync(file.target), fs.readFileSync(path.join(packageRoot, file.original)));
    const updated = execute("Update");
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(JSON.parse(updated.stdout).targetWrites, startupStaticFiles.length + 1);
    for (const file of manifest.files) assert.deepEqual(fs.readFileSync(file.target), fs.readFileSync(path.join(packageRoot, file.candidate)));
    const rollback = execute("Rollback");
    assert.equal(rollback.status, 0, rollback.stderr);
    for (const file of manifest.files) assert.deepEqual(fs.readFileSync(file.target), fs.readFileSync(path.join(packageRoot, file.original)));
    assert.equal(fs.readFileSync(ledger, "utf8"), '{"unknown":"keep","active":"keep"}');
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
