import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function read(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function runPowerShell(scriptPath, args, env = {}) {
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      cwd: path.dirname(scriptPath),
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 120_000,
    },
  );
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

test("idle activation tolerates a stale listener only after its real process is gone", () => {
  const stopScript = read("ops/stop-codex-app-server-proxy.ps1");
  const activationScript = read("ops/activate-codex-app-server-when-idle.ps1");
  assert.match(stopScript, /\[ValidateRange\(5, 300\)\]\[int\]\$ChildTimeoutSeconds = 120/);
  assert.match(stopScript, /\$ChildListenerOwnerAlive/);
  assert.match(stopScript, /\$StaleListener = \$null -ne \$ChildListenerRemaining -and -not \$ChildListenerOwnerAlive/);
  assert.match(stopScript, /\$ChildStopped = \$null -eq \$ChildRemaining -and \(-not \$ChildListenerOwnerAlive\)/);
  assert.match(stopScript, /staleListener = \$StaleListener/);
  assert.match(stopScript, /orphanedListener = \(\$null -ne \$ChildListenerRemaining -and \$ChildListenerOwnerAlive\)/);
  assert.match(activationScript, /-ChildTimeoutSeconds 120 -AllowVerifiedForceStop/);
  assert.match(activationScript, /staleListener=\$\(\$ProxyStopResult\.staleListener\)/);
});

test("staged updates keep automatic wake paused until live activation succeeds", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  assert.match(script, /pendingActivation = \(-not \$Activated\)/);
  assert.match(script, /PACKAGE_UPDATE_PENDING_ACTIVATION/);
  assert.match(script, /if \(\$Activated\) \{/);
  assert.match(script, /Write-JsonAtomic -Path \$LastKnownGoodPointerPath/);
});

test("failed validation resumes the previous router while preserving an alert", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  const catchBlock = script.match(/} catch \{[\s\S]*?\n} finally \{/)?.[0] ?? "";
  const validationIndex = script.indexOf('Invoke-NpmChecked -Root $CandidateRoot -Arguments @("test")');
  const installIndex = script.indexOf("$CodeInstallStarted = $true");
  assert.ok(validationIndex >= 0 && installIndex > validationIndex, "candidate validation must finish before live installation starts");
  assert.match(script, /\$CodeInstallStarted = \$false/);
  assert.match(script, /\$BrokerBackendReloaded = \$false/);
  assert.match(script, /\$ProxyLifecycleTouched = \$false/);
  assert.match(catchBlock, /Set-UpdateMaintenance -Active \$false/);
  assert.match(catchBlock, /PACKAGE_UPDATE_FAILED/);
  assert.match(catchBlock, /start-napcat-task-router\.ps1/);
  assert.match(catchBlock, /\$RollbackStopScripts = @\(\)/);
  assert.match(catchBlock, /if \(\$CodeInstallStarted -or \$BrokerBackendReloaded\)/);
  assert.match(catchBlock, /if \(\$ProxyLifecycleTouched\) \{ \$RollbackStopScripts \+= "stop-codex-app-server-proxy\.ps1" \}/);
  assert.match(catchBlock, /if \(\$BrokerBackendReloaded\)/);
  assert.match(catchBlock, /\$PreviousProxyRecovered = \(-not \$ProxyLifecycleTouched\)/);
});

test("candidate validation resolves the broker MCP SDK before entering maintenance", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  const resolveIndex = script.indexOf("$ValidationMcpSdkRoot = Resolve-McpSdkRoot");
  const maintenanceIndex = script.indexOf("Set-UpdateMaintenance -Active $true");
  assert.match(script, /function Resolve-McpSdkRoot/);
  assert.match(script, /MEMORY_STORE_MCP_ROOT/);
  assert.match(script, /CODEX_TOOLKIT_MCP_ROOT/);
  assert.match(script, /CODEX_TOOLKIT_BROKER_ROOT/);
  assert.match(script, /Split-Path -Parent \(\[System\.IO\.Path\]::GetFullPath\(\[string\]\$_\)\)/);
  assert.match(script, /memory-store\\node_modules\\@modelcontextprotocol\\sdk\\dist\\esm/);
  assert.ok(resolveIndex >= 0 && maintenanceIndex > resolveIndex, "SDK resolution must finish before maintenance starts");
  for (const command of ['@("ci")', '@("run", "check")', '@("test")']) {
    assert.ok(script.includes(`-Arguments ${command} -McpSdkRoot $ValidationMcpSdkRoot`));
  }
});

test("guarded updater shares control state through the private DataRoot", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  assert.match(script, /\$ControlStatePath = Join-Path \$StateRoot "control-state\.json"/);
  assert.match(script, /function Get-ControlStateMigrationPlan/);
  assert.match(script, /migrate_legacy_code_root/);
  assert.match(script, /different content\. Preserve both files and reconcile them before activation/);
  assert.match(script, /NAPCAT_CONTROL_STATE_PATH/);
  assert.match(script, /\$ControlStateBackupPath/);
  assert.match(script, /\$LegacyControlStateBackupPath/);
  assert.match(script, /elseif \(\$ControlStateMigrated\)/);

  const indexSource = read("src/index.mjs");
  assert.match(indexSource, /path\.join\(path\.dirname\(taskRegistryStatePath\), "control-state\.json"\)/);

  const routerSource = read("src/task-router-runner.mjs");
  assert.match(routerSource, /env\.NAPCAT_CONTROL_STATE_PATH/);
  assert.match(routerSource, /path\.join\(path\.dirname\(registryPath\), "control-state\.json"\)/);
});

test("legacy control-state migration rolls back when update fails before code installation", { skip: process.platform !== "win32" }, (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-control-state-rollback-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(fixtureRoot, "source");
  const brokerRoot = path.join(fixtureRoot, "broker");
  const codeRoot = path.join(fixtureRoot, "service", "current");
  const dataRoot = path.join(fixtureRoot, "private-data");
  const sdkRoot = path.join(fixtureRoot, "memory-store", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  const legacyControlStatePath = path.join(codeRoot, "state", "control-state.json");
  const dataControlStatePath = path.join(dataRoot, "state", "control-state.json");
  const registryPath = path.join(dataRoot, "state", "task-registry.json");
  const legacyControlState = JSON.stringify({ schemaVersion: 1, deliveries: { legacy: { stage: "machine_received" } } });
  const registry = {
    schemaVersion: 1,
    tasks: {
      fixture: {
        taskId: "fixture",
        conversationId: "fixture-conversation",
        localRole: "development",
        sourceMachine: "training",
        targetMachine: "development",
        trustedPeerQq: "10000",
        generation: 1,
        status: "open",
        wakePending: true,
        activeWakeId: "fixture-wake",
        messageLedger: {},
        wakeBatches: {},
      },
    },
  };
  write(path.join(sdkRoot, "server", "index.js"), "export {};\n");
  write(path.join(sdkRoot, "types.js"), "export {};\n");
  write(path.join(brokerRoot, "broker-private.env.json"), JSON.stringify({ CODEX_TOOLKIT_BROKER_ROOT: brokerRoot }));
  write(legacyControlStatePath, legacyControlState);
  write(registryPath, JSON.stringify(registry));
  write(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({
      name: "napcat-control-state-rollback-fixture",
      version: "1.0.0",
      private: true,
      scripts: {
        check: "node -e \"process.exit(0)\"",
        test: "node -e \"process.exit(0)\"",
      },
    }),
  );
  write(
    path.join(sourceRoot, "package-lock.json"),
    JSON.stringify({
      name: "napcat-control-state-rollback-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "napcat-control-state-rollback-fixture", version: "1.0.0" } },
    }),
  );
  write(path.join(sourceRoot, "src", "index.mjs"), "export {};\n");
  write(path.join(sourceRoot, "package", "APPLY-NAPCAT-APPSERVER-UPGRADE.ps1"), "Write-Output 'portable fixture'\n");
  fs.copyFileSync(path.resolve("ops/update-codex-napcat-bridge.ps1"), path.join(sourceRoot, "update.ps1"));
  fs.copyFileSync(path.resolve("ops/resolve-napcat-data-root.ps1"), path.join(sourceRoot, "resolve-napcat-data-root.ps1"));
  const result = runPowerShell(
    path.join(sourceRoot, "update.ps1"),
    [
      "-SourceRoot", sourceRoot,
      "-CodeRoot", codeRoot,
      "-DataRoot", dataRoot,
      "-BrokerRoot", brokerRoot,
      "-SourceCommit", "fixture",
      "-PreserveActiveWakes",
    ],
    {
      USERPROFILE: fixtureRoot,
      MCP_SDK_ROOT: sdkRoot,
      MEMORY_STORE_MCP_ROOT: "",
      CODEX_TOOLKIT_MCP_ROOT: "",
      CODEX_TOOLKIT_BROKER_ROOT: "",
    },
  );
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, combinedOutput);
  assert.match(combinedOutput, /task-router stop script is missing/);
  assert.equal(fs.existsSync(dataControlStatePath), false, "failed migration must not leave a new DataRoot control-state");
  assert.equal(fs.readFileSync(legacyControlStatePath, "utf8"), legacyControlState);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, "utf8")), registry);
});

test("portable package entrypoint leaves live services untouched before guarded validation succeeds", () => {
  const script = read("package/APPLY-NAPCAT-APPSERVER-UPGRADE.ps1");
  const updaterIndex = script.lastIndexOf("$UpdateResult = & $Updater @UpdateArguments");
  const brokerProofIndex = script.search(/\r?\n\s*Assert-BrokerSnapshotCurrent\r?\n/);
  assert.ok(brokerProofIndex >= 0 && updaterIndex > brokerProofIndex, "the installed broker snapshot must be proven before invoking the guarded updater");
  assert.match(script, /Run Update-CodexMcpBroker\.ps1 before the NapCat App Server upgrade/);
  assert.match(script, /function Get-CanonicalTextSha256/);
  assert.match(script, /-not \$RawHashMatches -and -not \$CanonicalHashMatches/);
  assert.doesNotMatch(script, /stop-napcat-supervisor-watchdog\.ps1/);
  assert.doesNotMatch(script, /Copy-Item -LiteralPath \$BrokerSource -Destination \$BrokerTarget/);
  assert.doesNotMatch(script, /Start-ScheduledTask -TaskName \$SupervisorTaskName/);
  assert.match(script, /The live broker was not modified by this entrypoint/);
  assert.match(script, /function Resolve-NodeExecutable/);
  assert.match(script, /CODEX_TOOLKIT_NODE_EXE/);
  assert.match(script, /CODEX_TOOLKIT_SERVICE_MANIFEST/);
  assert.match(script, /service-manifest\.json/);
  assert.doesNotMatch(script, /Get-Command node -ErrorAction Stop/);
  assert.match(script, /NodeExecutable = \$Node/);
  assert.match(script, /function Resolve-BrokerRoot/);
  assert.match(script, /broker\.brokerScript/);
});

test("portable upgrade staging keeps its package entrypoint and uses built-in SHA256", () => {
  const updater = read("ops/update-codex-napcat-bridge.ps1");
  const entrypoint = read("package/APPLY-NAPCAT-APPSERVER-UPGRADE.ps1");
  const verifier = read("package/verify-package.ps1");
  const copyBlock = updater.match(/function Copy-CodeTree[\s\S]*?\n}/)?.[0] ?? "";
  const restoreBlock = updater.match(/function Restore-CodeTree[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(copyBlock, /"package"/);
  assert.match(restoreBlock, /"package"/);
  assert.match(updater, /function Get-FileSha256/);
  assert.match(entrypoint, /function Get-FileSha256/);
  assert.match(verifier, /function Get-PortableFileSha256/);
  assert.match(verifier, /System\.Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(updater, /Get-FileHash/);
  assert.doesNotMatch(entrypoint, /Get-FileHash/);
  assert.doesNotMatch(verifier, /Get-FileHash/);
});

test("candidate npm validation finishes before maintenance or router quiescence", () => {
  const script = read("ops/update-codex-napcat-bridge.ps1");
  const validationIndex = script.indexOf('Invoke-NpmChecked -Root $CandidateRoot -Arguments @("test")');
  const maintenanceIndex = script.indexOf("Set-UpdateMaintenance -Active $true");
  const routerStopIndex = script.indexOf("$RouterStopResult = & $RouterStopScript");
  assert.ok(validationIndex >= 0, "candidate test invocation must exist");
  assert.ok(maintenanceIndex > validationIndex, "candidate tests must finish before maintenance starts");
  assert.ok(routerStopIndex > validationIndex, "candidate tests must finish before the task router can stop");
  assert.match(script, /function Resolve-NpmInvocation/);
  assert.doesNotMatch(script, /& npm\b/);
  assert.doesNotMatch(read("ops/rollback-codex-napcat-bridge.ps1"), /& npm\b/);
});

test("portable package entrypoint resolves the managed broker root and leaves it untouched when validation fails", { skip: process.platform !== "win32" }, (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-package-entrypoint-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const packageRoot = path.join(fixtureRoot, "package");
  const brokerRoot = path.join(fixtureRoot, "installed-broker");
  const codeRoot = path.join(fixtureRoot, "installed-code");
  const dataRoot = path.join(fixtureRoot, "private-data");
  const codexHome = path.join(fixtureRoot, "codex-home");
  const stopMarker = path.join(fixtureRoot, "watchdog-stopped.txt");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(codeRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  write(
    path.join(fixtureRoot, ".codex-toolkit", "services", "infrastructure", "service-manifest.json"),
    JSON.stringify({ broker: { nodeExe: process.execPath, brokerScript: path.join(brokerRoot, "broker.mjs") } }),
  );
  fs.copyFileSync(
    path.resolve("package/APPLY-NAPCAT-APPSERVER-UPGRADE.ps1"),
    path.join(packageRoot, "APPLY-NAPCAT-APPSERVER-UPGRADE.ps1"),
  );
  fs.mkdirSync(path.join(packageRoot, "napcat-mcp", "ops"), { recursive: true });
  fs.copyFileSync(
    path.resolve("ops/resolve-napcat-data-root.ps1"),
    path.join(packageRoot, "napcat-mcp", "ops", "resolve-napcat-data-root.ps1"),
  );
  write(path.join(packageRoot, "verify-package.ps1"), "Write-Output 'fixture package verified'\n");
  write(path.join(packageRoot, "manifest.json"), JSON.stringify({ source_commits: { napcat_mcp: "fixture" } }));
  for (const brokerFile of ["broker.mjs", "endpoint-config.mjs", "request-lifecycle.mjs"]) {
    const contents = `export const fixture = ${JSON.stringify(brokerFile)};\n`;
    write(path.join(packageRoot, "broker", brokerFile), contents);
    write(path.join(brokerRoot, brokerFile), contents);
  }
  write(
    path.join(packageRoot, "napcat-mcp", "ops", "update-codex-napcat-bridge.ps1"),
    [
      "param([string]$SourceRoot,[string]$CodeRoot,[string]$DataRoot,[string]$BrokerRoot,[string]$NodeExecutable,[string]$SourceCommit,[bool]$MigrateAutostart,[bool]$ActivateNow,[switch]$PreserveActiveWakes,[switch]$BackendOnlyHotReload,[switch]$ValidateOnly)",
      "throw 'candidate validation failed'",
      "",
    ].join("\n"),
  );
  write(
    path.join(packageRoot, "napcat-mcp", "ops", "stop-napcat-supervisor-watchdog.ps1"),
    `Set-Content -LiteralPath ${JSON.stringify(stopMarker)} -Value 'stopped' -Encoding UTF8\n`,
  );
  const brokerBefore = Object.fromEntries(
    ["broker.mjs", "endpoint-config.mjs", "request-lifecycle.mjs"].map((name) => [name, fs.readFileSync(path.join(brokerRoot, name), "utf8")]),
  );
  const result = runPowerShell(
    path.join(packageRoot, "APPLY-NAPCAT-APPSERVER-UPGRADE.ps1"),
    ["-CodexHome", codexHome, "-CodeRoot", codeRoot, "-DataRoot", dataRoot],
    {
      USERPROFILE: fixtureRoot,
      CODEX_TOOLKIT_BROKER_ROOT: "",
      CODEX_TOOLKIT_SERVICE_MANIFEST: "",
      CODEX_TOOLKIT_NODE_EXE: "",
      PATH: [
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      ].join(path.delimiter),
    },
  );
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, combinedOutput);
  assert.match(combinedOutput, /candidate validation failed/);
  assert.match(combinedOutput, /live broker was not modified/i);
  assert.equal(fs.existsSync(stopMarker), false, "candidate failure must not stop the watchdog");
  for (const [name, contents] of Object.entries(brokerBefore)) {
    assert.equal(fs.readFileSync(path.join(brokerRoot, name), "utf8"), contents, `${name} must remain byte-identical`);
  }
  assert.equal(fs.existsSync(path.join(dataRoot, "state", "task-router.maintenance.json")), false);
});

test("guarded updater derives the validation SDK and managed npm without PATH node", { skip: process.platform !== "win32" }, (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-broker-sdk-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const sourceRoot = path.join(fixtureRoot, "source");
  const brokerRoot = path.join(fixtureRoot, "broker");
  const codeRoot = path.join(fixtureRoot, "service", "current");
  const dataRoot = path.join(fixtureRoot, "private-data");
  const sdkRoot = path.join(fixtureRoot, "memory-store", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  fs.mkdirSync(codeRoot, { recursive: true });
  write(path.join(codeRoot, "sentinel.txt"), "previous installation\n");
  write(path.join(sdkRoot, "server", "index.js"), "export {};\n");
  write(path.join(sdkRoot, "types.js"), "export {};\n");
  write(path.join(brokerRoot, "broker-private.env.json"), JSON.stringify({ CODEX_TOOLKIT_BROKER_ROOT: brokerRoot }));
  write(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({
      name: "napcat-sdk-fixture",
      version: "1.0.0",
      private: true,
      scripts: {
        check: "node --check src/index.mjs",
        test: "node -e \"require('node:fs').accessSync('package/APPLY-NAPCAT-APPSERVER-UPGRADE.ps1');process.exit(7)\"",
      },
    }),
  );
  write(
    path.join(sourceRoot, "package-lock.json"),
    JSON.stringify({
      name: "napcat-sdk-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "napcat-sdk-fixture", version: "1.0.0" } },
    }),
  );
  write(path.join(sourceRoot, "src", "index.mjs"), "export {};\n");
  write(path.join(sourceRoot, "package", "APPLY-NAPCAT-APPSERVER-UPGRADE.ps1"), "Write-Output 'portable fixture'\n");
  fs.copyFileSync(path.resolve("ops/update-codex-napcat-bridge.ps1"), path.join(sourceRoot, "update.ps1"));
  fs.copyFileSync(path.resolve("ops/resolve-napcat-data-root.ps1"), path.join(sourceRoot, "resolve-napcat-data-root.ps1"));
  const launcherPath = path.join(sourceRoot, "invoke-without-get-file-hash.ps1");
  write(
    launcherPath,
    [
      "function global:Get-FileHash { throw 'Get-FileHash is unavailable in this compatibility test' }",
      "& $env:TARGET_UPDATE_SCRIPT @args",
      "",
    ].join("\n"),
  );
  const result = runPowerShell(
    launcherPath,
    [
      "-SourceRoot", sourceRoot,
      "-CodeRoot", codeRoot,
      "-DataRoot", dataRoot,
      "-BrokerRoot", brokerRoot,
      "-SourceCommit", "fixture",
    ],
    {
      USERPROFILE: fixtureRoot,
      MCP_SDK_ROOT: "",
      MEMORY_STORE_MCP_ROOT: "",
      CODEX_TOOLKIT_MCP_ROOT: "",
      CODEX_TOOLKIT_BROKER_ROOT: "",
      CODEX_TOOLKIT_NODE_EXE: process.execPath,
      PATH: [
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0"),
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
      ].join(path.delimiter),
      TARGET_UPDATE_SCRIPT: path.join(sourceRoot, "update.ps1"),
    },
  );
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, combinedOutput);
  assert.match(combinedOutput, /npm test failed with exit code 7/);
  assert.doesNotMatch(combinedOutput, /Get-FileHash is unavailable/);
  assert.doesNotMatch(combinedOutput, /SDK path is unavailable/);
  assert.equal(fs.readFileSync(path.join(codeRoot, "sentinel.txt"), "utf8"), "previous installation\n");
  assert.equal(fs.existsSync(path.join(dataRoot, "state", "task-router.maintenance.json")), false);
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
  const compatibilityBlock = script.match(/function Assert-BackendOnlyCompatible[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(script, /\[switch\]\$BackendOnlyHotReload/);
  assert.match(script, /function Assert-BackendOnlyCompatible/);
  assert.match(script, /function Get-NormalizedTextHash/);
  assert.match(script, /\.Replace\("`r`n", "`n"\)\.Replace\("`r", "`n"\)/);
  assert.match(compatibilityBlock, /Get-NormalizedTextHash -Path \$PreviousPath/);
  assert.match(compatibilityBlock, /Get-NormalizedTextHash -Path \$NextPath/);
  assert.doesNotMatch(compatibilityBlock, /Get-FileHash/);
  assert.match(script, /proxy-critical file changed/);
  assert.doesNotMatch(compatibilityBlock, /src\\codex-thread-bridge\.mjs/);
  assert.match(compatibilityBlock, /src\\codex-app-server-proxy\.mjs/);
  assert.doesNotMatch(compatibilityBlock, /activate-codex-app-server-when-idle\.ps1/);
  assert.match(script, /if \(\$BackendOnlyHotReload\) \{/);
  assert.match(script, /reload-broker-backend\.ps1/);
  assert.match(script, /Existing transparent proxy did not remain healthy/);
  assert.match(script, /if \(\$CodeInstallStarted -or \$BrokerBackendReloaded\)/);
  assert.match(script, /if \(\$ProxyLifecycleTouched\) \{ \$RollbackStopScripts \+= "stop-codex-app-server-proxy\.ps1" \}/);
  assert.match(script, /foreach \(\$ScriptName in \$RollbackStopScripts\)/);
  assert.match(script, /backendOnlyHotReload = \[bool\]\$BackendOnlyHotReload/);
  assert.match(script, /restartCodexRequired = \(-not \$BackendOnlyHotReload\)/);
});
