import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const napcatRoot = path.resolve(testRoot, "..");
const repositoryRoot = path.resolve(napcatRoot, "..", "..");
const lifecycleInstallRoot = process.env.CODEX_NAPCAT_LIFECYCLE_INSTALL_ROOT
  ? path.resolve(process.env.CODEX_NAPCAT_LIFECYCLE_INSTALL_ROOT)
  : path.join(repositoryRoot, "install");
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runPowerShell(args, env = {}, timeout = 30_000) {
  return spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout,
    },
  );
}

function removeSpawnFixture(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    const transientWindowsLock = process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
    if (!transientWindowsLock) throw error;
    process.emitWarning(`Deferred locked test fixture cleanup: ${root}`, { code: "NAPCAT_TEST_TEMP_LOCKED" });
  }
}

function pathIdentity(value) {
  const tail = [];
  let existing = path.resolve(value);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalBase = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
  const canonical = path.join(canonicalBase, ...tail);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function resolveDataRoot({ helperPath, explicit = "", processRoot = "", brokerRoot, userProfile }) {
  const command = [
    `. '${helperPath.replaceAll("'", "''")}'`,
    `$env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT='${processRoot.replaceAll("'", "''")}'`,
    `Resolve-NapCatDataRoot -ExplicitDataRoot '${explicit.replaceAll("'", "''")}' -BrokerRoot '${brokerRoot.replaceAll("'", "''")}' -UserProfile '${userProfile.replaceAll("'", "''")}'`,
  ].join("; ");
  return runPowerShell(["-Command", command]);
}

test("DataRoot resolver follows one precedence chain without creating a split-brain root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-data-root-"));
  try {
    const helperPath = path.join(napcatRoot, "ops", "resolve-napcat-data-root.ps1");
    const brokerRoot = path.join(root, "broker");
    const userProfile = path.join(root, "profile");
    const legacyRoot = path.join(brokerRoot, "napcat-mcp");
    const canonicalRoot = path.join(userProfile, ".codex-toolkit", "napcat-mcp");
    const explicitRoot = path.join(root, "explicit");
    const processRoot = path.join(root, "process");
    const privateRoot = path.join(root, "private");
    fs.mkdirSync(brokerRoot, { recursive: true });

    let result = resolveDataRoot({ helperPath, explicit: explicitRoot, processRoot, brokerRoot, userProfile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pathIdentity(result.stdout.trim()), pathIdentity(explicitRoot));

    result = resolveDataRoot({ helperPath, processRoot, brokerRoot, userProfile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pathIdentity(result.stdout.trim()), pathIdentity(processRoot));

    writeJson(path.join(brokerRoot, "broker-private.env.json"), { CODEX_TOOLKIT_NAPCAT_DATA_ROOT: privateRoot });
    result = resolveDataRoot({ helperPath, brokerRoot, userProfile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pathIdentity(result.stdout.trim()), pathIdentity(privateRoot));

    fs.rmSync(path.join(brokerRoot, "broker-private.env.json"));
    writeJson(path.join(legacyRoot, "state", "task-registry.json"), { schemaVersion: 1, tasks: {} });
    result = resolveDataRoot({ helperPath, brokerRoot, userProfile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(pathIdentity(result.stdout.trim()), pathIdentity(legacyRoot));
    assert.equal(fs.existsSync(canonicalRoot), false, "manual discovery must not create the canonical root");

    writeJson(path.join(canonicalRoot, "state", "task-registry.json"), { schemaVersion: 1, tasks: {} });
    result = resolveDataRoot({ helperPath, brokerRoot, userProfile });
    assert.notEqual(result.status, 0, "two registries must fail closed");
    assert.match(`${result.stdout}\n${result.stderr}`, /multiple NapCat task registries/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("activation timeout remains retryable and cancellation restores router automation", () => {
  const script = fs.readFileSync(path.join(napcatRoot, "ops", "activate-codex-app-server-when-idle.ps1"), "utf8");
  assert.match(script, /CancelPendingActivation/);
  assert.match(script, /retryable_timeout/);
  assert.match(script, /Restore-AutomationAfterDeferredActivation/);
  assert.match(script, /StopFilePath[^\r\n]+task-router\.stop/);
  assert.match(script, /Remove-Item[^\r\n]+StopFilePath/);
  assert.doesNotMatch(script, /Set-ActivationMaintenance -Active \$true -Code "PENDING_ACTIVATION_FAILED"/);
});

function createActivatorFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-activator-"));
  const opsRoot = path.join(root, "service", "current", "ops");
  const dataRoot = path.join(root, "data");
  const brokerRoot = path.join(root, "broker");
  fs.mkdirSync(opsRoot, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "state"), { recursive: true });
  fs.mkdirSync(brokerRoot, { recursive: true });
  for (const name of ["activate-codex-app-server-when-idle.ps1", "resolve-napcat-data-root.ps1"]) {
    fs.copyFileSync(path.join(napcatRoot, "ops", name), path.join(opsRoot, name));
  }
  const scripts = {
    "stop-napcat-supervisor-watchdog.ps1": 'param([string]$DataRoot,[string]$TaskName); @{ stopped=$true } | ConvertTo-Json',
    "get-codex-app-server-proxy-status.ps1": 'param([string]$DataRoot); $count=if($env:TEST_PROXY_BUSY -eq "1"){1}else{0}; @{ ok=$true; control=@{clientCount=$count}; runtime=@{state="running";automationEnabled=$true;pid=101;appServerPid=102;downstreamUrl="http://127.0.0.1";upstreamUrl="http://127.0.0.1"} } | ConvertTo-Json -Depth 6',
    "start-codex-app-server-proxy.ps1": 'param([string]$DataRoot); @{ pid=101; appServerPid=102 } | ConvertTo-Json',
    "start-napcat-supervisor.ps1": 'param([string]$DataRoot,[string]$BrokerRoot); @{ pid=201 } | ConvertTo-Json',
    "start-napcat-task-router.ps1": 'param([string]$DataRoot,[string]$BrokerRoot); @{ pid=301 } | ConvertTo-Json',
    "stop-napcat-task-router.ps1": 'param([string]$DataRoot); @{ stopped=$true } | ConvertTo-Json',
    "stop-napcat-supervisor.ps1": 'param([string]$DataRoot); @{ stopped=$true } | ConvertTo-Json',
    "stop-codex-app-server-proxy.ps1": 'param([string]$DataRoot,[int]$ChildTimeoutSeconds,[switch]$AllowVerifiedForceStop); @{ stopped=$true;clean=$true;childStopped=$true } | ConvertTo-Json',
    "reload-broker-backend.ps1": 'param([string]$Endpoint,[string]$BrokerRoot,[switch]$AllowLegacyChildRecycle); if($env:TEST_RELOAD_FAIL -eq "1"){throw "injected reload failure"}; @{ ok=$true } | ConvertTo-Json',
    "get-napcat-supervisor-status.ps1": 'param([string]$DataRoot,[string]$TaskName); @{ alive=$true } | ConvertTo-Json',
  };
  for (const [name, source] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(opsRoot, name), source, "utf8");
  }
  writeJson(path.join(dataRoot, "state", "task-registry.json"), { schemaVersion: 1, tasks: {} });
  writeJson(path.join(dataRoot, "state", "napcat-bridge-last-update.json"), {
    activated: false,
    pendingActivation: true,
    restartCodexRequired: true,
  });
  writeJson(path.join(dataRoot, "state", "task-router.maintenance.json"), {
    schemaVersion: 1,
    reasons: { packageUpdate: { code: "PACKAGE_UPDATE_PENDING_ACTIVATION" } },
  });
  fs.writeFileSync(path.join(dataRoot, "state", "task-router.stop"), "stop\n", "utf8");
  return { root, opsRoot, dataRoot, brokerRoot };
}

test("activation timeout preserves staging and restores automation", () => {
  const fixture = createActivatorFixture();
  try {
    const result = runPowerShell(
      ["-File", path.join(fixture.opsRoot, "activate-codex-app-server-when-idle.ps1"), "-DataRoot", fixture.dataRoot, "-BrokerRoot", fixture.brokerRoot, "-TimeoutSeconds", "1", "-IdleConfirmMilliseconds", "500"],
      { TEST_PROXY_BUSY: "1" },
      10_000,
    );
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    const activationState = JSON.parse(fs.readFileSync(path.join(fixture.dataRoot, "state", "codex-app-server-pending-activation.json"), "utf8"));
    const updateState = JSON.parse(fs.readFileSync(path.join(fixture.dataRoot, "state", "napcat-bridge-last-update.json"), "utf8"));
    assert.equal(activationState.state, "retryable_timeout");
    assert.equal(updateState.pendingActivation, true);
    assert.equal(updateState.activated, false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "task-router.stop")), false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "task-router.maintenance.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("activation cancellation and repeated finalization are idempotent", () => {
  const fixture = createActivatorFixture();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runPowerShell(["-File", path.join(fixture.opsRoot, "activate-codex-app-server-when-idle.ps1"), "-DataRoot", fixture.dataRoot, "-BrokerRoot", fixture.brokerRoot, "-CancelPendingActivation"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    const activationState = JSON.parse(fs.readFileSync(path.join(fixture.dataRoot, "state", "codex-app-server-pending-activation.json"), "utf8"));
    assert.equal(activationState.state, "cancelled");
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "task-router.stop")), false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "task-router.maintenance.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("activation failure rolls automation back without clearing pending staging", () => {
  const fixture = createActivatorFixture();
  try {
    const result = runPowerShell(
      ["-File", path.join(fixture.opsRoot, "activate-codex-app-server-when-idle.ps1"), "-DataRoot", fixture.dataRoot, "-BrokerRoot", fixture.brokerRoot, "-TimeoutSeconds", "2", "-IdleConfirmMilliseconds", "500"],
      { TEST_RELOAD_FAIL: "1" },
      10_000,
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const activationState = JSON.parse(fs.readFileSync(path.join(fixture.dataRoot, "state", "codex-app-server-pending-activation.json"), "utf8"));
    const updateState = JSON.parse(fs.readFileSync(path.join(fixture.dataRoot, "state", "napcat-bridge-last-update.json"), "utf8"));
    assert.equal(activationState.state, "failed");
    assert.equal(updateState.pendingActivation, true);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "task-router.stop")), false);
    assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "task-router.maintenance.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("managed broker start uses manifest Node when PATH has no node", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-broker-node-"));
  let brokerPid = null;
  try {
    const brokerRoot = path.join(root, "broker");
    const dataRoot = path.join(root, "data");
    const markerPath = path.join(root, "started.json");
    const manifestPath = path.join(root, "service-manifest.json");
    const brokerPort = 20000 + Math.floor(Math.random() * 20000);
    fs.mkdirSync(brokerRoot, { recursive: true });
    fs.copyFileSync(path.join(lifecycleInstallRoot, "Start-CodexMcpBroker.ps1"), path.join(brokerRoot, "Start-CodexMcpBroker.ps1"));
    fs.writeFileSync(
      path.join(brokerRoot, "broker.mjs"),
      `import fs from "node:fs"; import http from "node:http"; fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ pid: process.pid })); http.createServer((request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, pid: process.pid })); }).listen(Number(process.env.CODEX_MCP_BROKER_PORT), "127.0.0.1");\n`,
      "utf8",
    );
    writeJson(manifestPath, {
      broker: {
        nodeExe: process.execPath,
        brokerScript: path.join(brokerRoot, "broker.mjs"),
        startScript: path.join(brokerRoot, "Start-CodexMcpBroker.ps1"),
      },
    });

    const result = runPowerShell(
      ["-File", path.join(brokerRoot, "Start-CodexMcpBroker.ps1")],
      {
        PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
        CODEX_TOOLKIT_NODE_EXE: "",
        CODEX_TOOLKIT_SERVICE_MANIFEST: manifestPath,
        CODEX_TOOLKIT_DATA_ROOT: dataRoot,
        CODEX_MCP_BROKER_PORT: String(brokerPort),
        CODEX_MCP_BROKER_STARTUP_TIMEOUT_SECONDS: "5",
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(markerPath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(fs.existsSync(markerPath), true, "managed Node did not start the broker");
    brokerPid = JSON.parse(fs.readFileSync(markerPath, "utf8")).pid;
  } finally {
    if (brokerPid) {
      spawnSync("taskkill.exe", ["/PID", String(brokerPid), "/T", "/F"], { encoding: "utf8" });
    }
    removeSpawnFixture(root);
  }
});

test("portable package entrypoint defaults to backend-only hot reload", () => {
  const script = fs.readFileSync(path.join(napcatRoot, "package", "APPLY-NAPCAT-APPSERVER-UPGRADE.ps1"), "utf8");
  assert.match(script, /\[switch\]\$BackendOnlyHotReload\s*=\s*\$true/);
  assert.match(script, /ActivateNow\s*=\s*\[bool\]\$BackendOnlyHotReload/);
});
