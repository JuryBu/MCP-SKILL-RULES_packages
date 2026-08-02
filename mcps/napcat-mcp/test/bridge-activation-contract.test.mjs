import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

test("update, activation, and rollback share one lifecycle lock", () => {
  for (const scriptPath of [
    "ops/update-codex-napcat-bridge.ps1",
    "ops/activate-codex-app-server-when-idle.ps1",
    "ops/rollback-codex-napcat-bridge.ps1",
  ]) {
    assert.match(read(scriptPath), /napcat-bridge-update\.lock/);
  }
});

test("idle activation fails closed and replaces every managed component", () => {
  const script = read("ops/activate-codex-app-server-when-idle.ps1");
  assert.match(script, /\$Status\.ok -ne \$true -or \$null -eq \$Status\.control/);
  assert.match(script, /continue/);
  for (const scriptName of [
    "stop-napcat-task-router.ps1",
    "stop-napcat-supervisor.ps1",
    "stop-codex-app-server-proxy.ps1",
    "start-codex-app-server-proxy.ps1",
    "start-napcat-supervisor.ps1",
    "start-napcat-task-router.ps1",
  ]) {
    assert.ok(script.includes(scriptName), `activation must call ${scriptName}`);
  }
  assert.match(script, /Start-ScheduledTask -TaskName \$SupervisorTaskName/);
});

test("staged updates keep automatic wake paused until live activation succeeds", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  assert.match(script, /pendingActivation = \(-not \$Activated\)/);
  assert.match(script, /PACKAGE_UPDATE_PENDING_ACTIVATION/);
  assert.match(script, /if \(\$Activated\) \{/);
  assert.match(script, /Write-JsonAtomic -Path \$LastKnownGoodPointerPath/);
});

test("successful idle activation resolves the persisted pending-update metadata", () => {
  const script = read("ops/activate-codex-app-server-when-idle.ps1");
  assert.match(script, /napcat-bridge-last-update\.json/);
  assert.match(script, /activated[^\r\n]+\$true/);
  assert.match(script, /pendingActivation[^\r\n]+\$false/);
  assert.match(script, /restartCodexRequired[^\r\n]+\$false/);
  assert.match(script, /activatedProxyUrl/);
  assert.match(script, /activationCompletedAt/);
});

test("task router startup accepts the intentional maintenance state", () => {
  const script = read("ops/start-napcat-task-router.ps1");
  assert.match(script, /state -notin @\("running", "maintenance"\)/);
});

test("guarded update can explicitly preserve active wakes without acknowledging them", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  assert.match(script, /\[switch\]\$PreserveActiveWakes/);
  assert.match(script, /stop-napcat-task-router\.ps1/);
  assert.match(script, /messageLedger = \$_\.messageLedger/);
  assert.match(script, /wakeBatches = \$_\.wakeBatches/);
  assert.match(script, /Protected task routing, message ledger, or wake state changed/);
  assert.match(script, /preservedActiveWakeCount = \$PreservedActiveWakeCount/);
});

test("backend-only hot reload proves proxy files unchanged and never stops the proxy", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  assert.match(script, /\[switch\]\$BackendOnlyHotReload/);
  assert.match(script, /function Assert-BackendOnlyCompatible/);
  assert.match(script, /proxy-critical file changed/);
  assert.match(script, /if \(\$BackendOnlyHotReload\) \{/);
  assert.match(script, /reload-broker-backend\.ps1/);
  assert.match(script, /Existing transparent proxy did not remain healthy/);
  assert.match(script, /\$RollbackStopScripts = @\("stop-napcat-task-router\.ps1", "stop-napcat-supervisor\.ps1"\)/);
  assert.match(script, /if \(-not \$BackendOnlyHotReload\) \{ \$RollbackStopScripts \+= "stop-codex-app-server-proxy\.ps1" \}/);
  assert.match(script, /foreach \(\$ScriptName in \$RollbackStopScripts\)/);
  assert.match(script, /backendOnlyHotReload = \[bool\]\$BackendOnlyHotReload/);
  assert.match(script, /restartCodexRequired = \(-not \$BackendOnlyHotReload\)/);
});
