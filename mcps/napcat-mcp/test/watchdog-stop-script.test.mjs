import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const stopScript = path.resolve(testRoot, "..", "ops", "stop-napcat-supervisor-watchdog.ps1");
const statusScript = path.resolve(testRoot, "..", "ops", "get-napcat-supervisor-status.ps1");

test("watchdog status separates logical instances from wrapper processes", () => {
  const source = fs.readFileSync(statusScript, "utf8");
  assert.match(source, /watchdogCount\s*=\s*\$WatchdogInstances\.Count/);
  assert.match(source, /watchdogInstanceCount\s*=\s*\$WatchdogInstances\.Count/);
  assert.match(source, /watchdogProcessCount\s*=\s*\$Watchdogs\.Count/);
  assert.match(source, /watchdogWrapperCount\s*=\s*\$WatchdogWrappers\.Count/);
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

test("watchdog stop helper removes the matching detached process only", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-watchdog-stop-test-"));
  const dataRoot = path.join(root, "data");
  const watchdogStub = path.join(root, "Run-NapCatSupervisorWatchdog.ps1");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(watchdogStub, "param([string]$DataRoot)\nStart-Sleep -Seconds 120\n", "utf8");

  const target = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", watchdogStub, "-DataRoot", dataRoot], {
    windowsHide: true,
    stdio: "ignore",
  });
  const unrelated = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 120"], {
    windowsHide: true,
    stdio: "ignore",
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(isAlive(target.pid), true);
    assert.equal(isAlive(unrelated.pid), true);

    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", stopScript, "-DataRoot", dataRoot, "-SkipScheduledTask",
    ], { windowsHide: true });
    const result = JSON.parse(stdout);

    assert.equal(result.stopped, true);
    assert.equal(result.stoppedPids.includes(target.pid), true);
    assert.equal(await waitForExit(target.pid), true);
    assert.equal(isAlive(unrelated.pid), true);
  } finally {
    if (isAlive(target.pid)) process.kill(target.pid);
    if (isAlive(unrelated.pid)) process.kill(unrelated.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
