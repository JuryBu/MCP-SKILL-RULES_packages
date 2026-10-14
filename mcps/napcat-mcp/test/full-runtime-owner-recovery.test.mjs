import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readRecoveryConfiguration, bindAcceptanceRegistry, readRecoveryWorkerSources } from "../ops/full-runtime-owner-recovery-io.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sha = filename => digest(fs.readFileSync(filename));
const write = (filename, data) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, typeof data === "string" ? data : JSON.stringify(data)); return filename; };
const powershell = process.env.OWNER_TEST_POWERSHELL ?? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function fixture(context, fault) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-cold-owner-"));
  write(path.join(directory, "recovery-owner.json"), { ownerId: "full-runtime-recovery-test" });
  const dataRoot = path.join(directory, "data");
  const stateRoot = path.join(dataRoot, "state", "inner-managed");
  const outerStateRoot = path.dirname(stateRoot);
  const serviceOps = path.join(directory, "installed", "ops");
  const stopOps = path.join(directory, "stop", "ops");
  const installationRoot = path.dirname(serviceOps);
  const pins = [];
  const pinned = filename => { pins.push({ path: filename, sha256: sha(filename) }); return filename; };
  const entryPath = pinned(path.join(root, "ops", "recover-full-runtime-owner.ps1"));
  const ioPath = pinned(path.join(root, "ops", "full-runtime-owner-recovery-io.mjs"));
  const proofPath = pinned(path.join(root, "ops", "full-runtime-recovery-proof.mjs"));
  pinned(process.execPath); pinned(powershell);
  fs.mkdirSync(stopOps, { recursive: true });
  fs.copyFileSync(path.join(root, "ops", "owned-stop-marker.ps1"), path.join(stopOps, "owned-stop-marker.ps1"));
  pinned(path.join(stopOps, "owned-stop-marker.ps1"));
  pinned(write(path.join(stopOps, "resolve-napcat-data-root.ps1"), ""));
  const snapshotPath = path.join(directory, "snapshot.json");
  const restartedPath = path.join(directory, "restarted.json");
  const taskPath = path.join(directory, "watchdog-state.json");
  const callsPath = path.join(directory, "calls.jsonl");
  const quote = value => value.replaceAll("'", "''");
  pinned(write(path.join(stopOps, "stop-codex-app-server-proxy.ps1"), `param($DataRoot,$TimeoutSeconds,$ChildTimeoutSeconds,$StopMarkerProofPath,$StopMarkerAttemptId,$StopMarkerOperationId)
$snapshot=Json '${quote(snapshotPath)}'
$snapshot.processes=@(${fault === "child-remains" ? "$snapshot.processes | Where-Object {$_.pid -eq 103}" : fault === "late-child-remains" ? "$snapshot.processes | Where-Object {$_.pid -eq 201}" : ""})
$snapshot.listeners=@()
[IO.File]::WriteAllText('${quote(snapshotPath)}',($snapshot|ConvertTo-Json -Depth 30))
$task=Json '${quote(taskPath)}'
$task.state='Ready'
[IO.File]::WriteAllText('${quote(taskPath)}',($task|ConvertTo-Json))
[IO.File]::AppendAllText('${quote(callsPath)}',"stop\n")
'{"stopped":true,"clean":true,"childStopped":true,"forced":false,"childForced":false}'
`));
  for (const name of ["start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1", "resolve-napcat-data-root.ps1", "Run-NapCatSupervisorWatchdog.ps1", "Run-HiddenPowerShell.vbs"]) {
    const response = name === "start-codex-model-stream-proxy.ps1" ? '{"running":true,"mode":"managed","outer":{"state":"running"}}' : '{"started":true}';
    pinned(write(path.join(serviceOps, name), `param($DataRoot,$CodexExecutablePath,$BrokerRoot,$NapCatRoot,$QqExePath)
[IO.File]::AppendAllText('${quote(callsPath)}',"${name}\n")
${name === "start-codex-model-stream-proxy.ps1" ? `$next=Json '${quote(restartedPath)}'
$next.runtime.livenessAt=[DateTime]::UtcNow.ToString('o');$next.runtime.updatedAt=$next.runtime.livenessAt;$next.managed.livenessAt=$next.runtime.livenessAt
[IO.File]::WriteAllText('${quote(snapshotPath)}',($next|ConvertTo-Json -Depth 30))` : ""}
'${response}'
`));
  }
  const sourceHashes = Object.fromEntries(["runner", "core", "helper", "control"].map(name => [name, digest(name)]));
  const baselineFiles = Array.from({ length: 47 }, (_, index) => {
    const filename = write(path.join(installationRoot, "src", `runtime-${index}.mjs`), `export const identity = ${index};`);
    return { path: filename, sha256: sha(filename) };
  });
  const runtimePath = path.join(outerStateRoot, "codex-app-server-proxy-runtime.json");
  const managedStatePath = path.join(stateRoot, "managed-runtime.json");
  const tokenPath = write(path.join(outerStateRoot, "control-token.txt"), "synthetic-control-token");
  pinned(write(path.join(directory, "codex.exe"), "fixture-not-executable"));
  const profilePath = pinned(write(path.join(stateRoot, "inner-managed-profile.json"), { ownerId: "fixture-owner", nativeSourceId: "fixture-native", stateRoot,
    installationRoot, outerStateRoot, managedStatePath, outerPaths: { runtimeStatePath: runtimePath, tokenFilePath: tokenPath }, initial: { expectedHashes: sourceHashes } }));
  pinned(write(path.join(stateRoot, ".inner-runtime-owner.json"), { schemaVersion: 1, kind: "state", ownerId: "fixture-owner", nativeSourceId: "fixture-native" }));
  const now = new Date().toISOString();
  const creationDate = new Date(Date.now() - 60000).toISOString().replace(/\.\d{3}Z$/u, '.1200000Z');
  const processes = [
    { pid: 100, parentPid: 1, creationDate, executablePath: "C:\\fixture\\node.exe", commandLine: "node parent" },
    { pid: 101, parentPid: 100, creationDate, executablePath: "C:\\fixture\\codex.exe", commandLine: "codex app-server --listen fixture" },
    { pid: 102, parentPid: 100, creationDate, executablePath: "C:\\fixture\\node.exe", commandLine: "node worker" },
    { pid: 103, parentPid: 102, creationDate, executablePath: "C:\\fixture\\helper.exe", commandLine: "helper child" },
  ];
  const inputPath = write(path.join(directory, "input.json"), { schemaVersion: 1, machine: "fixture", candidateId: "same-source-proof",
    profilePath, runtimePath, tokenPath, parentPid: 100, appServerPid: 101, instanceId: "fixture-instance", controlUrl: "http://127.0.0.1:18431",
    installationRoot: path.join(directory, "candidates", "same-source-proof") });
  const runtime = { pid: 100, appServerPid: 101, instanceToken: "fixture-instance", state: "running", controlUrl: "http://127.0.0.1:18431", livenessAt: now, updatedAt: now };
  const managed = { schemaVersion: 1, state: "running", healthy: true, pid: 100, instanceToken: "fixture-instance", livenessAt: now, controlBusy: false, controlRevision: 0,
    coordinator: { running: true, nativeHealthy: true, transactionActive: false, activeHttp: fault === "busy" ? 1 : 0, pendingControl: 0, activation: null,
      workerMaintenance: false, threads: [{ phase: "terminal", activeHttp: 0 }], workers: [{ workerId: "fixture-worker", pid: 102, ready: true, alive: true,
        sourceHashes, retired: false, cleanupPending: false }] } };
  write(runtimePath, runtime); write(managedStatePath, managed);
  write(path.join(outerStateRoot, "supervisor-runtime.json"), { pid: 200 });
  write(snapshotPath, { now, runtime, managed, processes, listeners: [{ localPort: 18431, owningProcess: 100, state: "Listen" }] });
  if (["app-replaced-before", "app-replaced-between", "late-child-remains"].includes(fault)) {
    const changed = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    if (fault === "late-child-remains") {
      changed.processes.push({ ...processes[2], pid: 200, commandLine: "node replacement-worker" }, { ...processes[3], pid: 201, parentPid: 200 });
      changed.managed.coordinator.workers.push({ ...managed.coordinator.workers[0], pid: 200, workerId: "new-fixture-worker" });
    } else {
      changed.runtime.appServerPid = 201;
      changed.processes[1] = { ...changed.processes[1], pid: 201, creationDate: new Date(Date.parse(creationDate) + 1000).toISOString() };
    }
    write(fault === "app-replaced-before" ? snapshotPath : path.join(directory, "second-snapshot.json"), changed);
  }
  if (fault === "disable-readback") write(path.join(directory, "disable-readback-fault"), "synthetic failure");
  const restarted = structuredClone({ now, runtime, managed, processes, listeners: [{ localPort: 18431, owningProcess: 300, state: "Listen" }] });
  restarted.runtime.pid = 300; restarted.runtime.appServerPid = 301; restarted.runtime.instanceToken = "restarted-instance";
  restarted.managed.pid = 300; restarted.managed.instanceToken = "restarted-instance";
  restarted.managed.coordinator.workers[0].pid = 302;
  restarted.processes = restarted.processes.slice(0, 3).map((runtimeProcess, index) => ({ ...runtimeProcess, pid: 300 + index,
    parentPid: index === 0 ? 1 : 300, executablePath: index === 1 ? path.join(directory, "codex.exe") : process.execPath }));
  restarted.fullRuntime = { ok: true, instanceId: "restarted-instance", revision: fault === "wrong-restarted" ? 1 : 0,
    controlGeneration: 0, selected: { id: "original" }, candidateRegistrySha256: null, busy: false, failed: false,
    participants: Array(5).fill({ id: "fixture" }), prepared: [] };
  write(restartedPath, restarted);
  write(taskPath, { execute: "fixture-wscript", arguments: "fixture-action", enabled: true, state: "Running" });
  const ownerConfigurationPath = write(path.join(directory, "owner.json"), { serviceOps, stopOps, dataRoot, brokerRoot: path.join(directory, "broker"),
    napCatRoot: path.join(directory, "napcat"), qqExePath: path.join(directory, "qq.exe"), nodePath: process.execPath,
    codexExecutablePath: path.join(directory, "codex.exe"), originalWatchdogEnabled: true, watchdogExecute: "fixture-wscript", watchdogArguments: "fixture-action",
    ownerPowerShell: { path: powershell, sha256: sha(powershell) } });
  const registryPath = write(path.join(stateRoot, "inner-candidate-approvals.json"), { ownerId: "fixture-owner", candidate: "same-source-proof" });
  const events = [
    { phase: "started", value: { instanceId: "fixture-instance", revision: 0, selected: { id: "original" }, candidateRegistrySha256: null } },
    { phase: "candidate", value: { manifestPath: path.join(directory, "candidates", "same-source-proof", "src", "manifest.json"), manifestSha256: digest("fixture-bundle") } },
    { phase: "registered", value: { instanceId: "fixture-instance", candidateRegistrySha256: sha(registryPath) } },
  ].map(record => ({ ...record, inputSha256: sha(inputPath) }));
  write(path.join(directory, "acceptance-events.jsonl"), events.map(record => JSON.stringify(record)).join("\n") + "\n");
  const configurationPath = write(path.join(directory, "cold-config.json"), { schemaVersion: 1, mode: "TempFixture", fixtureRoot: directory,
    entryPath, ioPath, proofPath, nodePath: process.execPath, powerShellPath: powershell,
    inputPath, inputSha256: sha(inputPath), ownerConfigurationPath, ownerConfigurationSha256: sha(ownerConfigurationPath), registryPath,
    ports: [18431, 18432, 18433, 18434, 18435], baselineFiles, pins,
    processBindings: processes.slice(0, 2).map(process => ({ pid: process.pid, creationDate, executablePath: process.executablePath, commandLineSha256: digest(process.commandLine) })) });
  context.diagnostic(JSON.stringify({ directory, productionActions: 0 }));
  return { directory, configurationPath, configurationSha256: sha(configurationPath), registryPath, baselineFiles, callsPath, taskPath };
}
async function execute(value, action = "Recover", confirmation = "RECOVER-CURRENT-RUNTIME") {
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-File", path.join(root, "ops", "recover-full-runtime-owner.ps1"),
    "-ConfigurationPath", value.configurationPath, "-ConfigurationSha256", value.configurationSha256, "-Action", action,
    ...(confirmation === null ? [] : ["-FixtureConfirmation", confirmation])], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  const firstJson = stdout.indexOf("{");
  return { code, stdout, stderr, result: firstJson >= 0 ? JSON.parse(stdout.slice(firstJson)) : null };
}
test("actual cold recovery accepts a registered changed worker and restores the original runtime", async context => {
  const value = fixture(context);
  const configuration = JSON.parse(fs.readFileSync(value.configurationPath));
  const input = JSON.parse(fs.readFileSync(configuration.inputPath));
  input.candidateRoot = path.join(value.directory, "candidates");
  const installationRoot = path.join(input.candidateRoot, "same-source-proof");
  const profile = JSON.parse(fs.readFileSync(input.profilePath));
  const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
  const expectedHashes = Object.fromEntries(Object.entries(names).map(([name, filename]) => [name, sha(write(path.join(installationRoot, "src", filename), name + "-candidate"))]));
  write(path.join(installationRoot, ".inner-runtime-owner.json"), { kind: "candidate", ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId });
  write(value.registryPath, { candidates: [{ installationRoot, runnerPath: path.join(installationRoot, "src", names.runner), expectedHashes }] });
  write(configuration.inputPath, input);
  configuration.inputSha256 = sha(configuration.inputPath);
  const eventsPath = path.join(value.directory, "acceptance-events.jsonl");
  const records = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
  for (const record of records) {
    record.inputSha256 = configuration.inputSha256;
    if (record.phase === "registered") record.value.candidateRegistrySha256 = sha(value.registryPath);
  }
  write(eventsPath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const snapshotPath = path.join(value.directory, "snapshot.json");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath));
  const worker = snapshot.managed.coordinator.workers[0];
  worker.sourceHashes = expectedHashes;
  snapshot.managed.coordinator.activation = { activationId: "completed-activation", active: true,
    sourceWorkerId: worker.workerId, targetWorkerId: worker.workerId, deferredThreadIds: [] };
  write(snapshotPath, snapshot);
  write(value.configurationPath, configuration);
  value.configurationSha256 = sha(value.configurationPath);
  const result = await execute(value);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.result.servicesReady, true);
  assert.equal(fs.existsSync(value.registryPath), false);
});

test("recovery derives worker sources from a pinned registry and verifies candidate bytes", context => {
  const value = fixture(context);
  const configuration = readRecoveryConfiguration(value.configurationPath, value.configurationSha256);
  configuration.input.candidateRoot = path.join(value.directory, "candidates");
  const installationRoot = path.join(configuration.input.candidateRoot, "changed-source");
  const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
  const expectedHashes = Object.fromEntries(Object.entries(names).map(([name, filename]) => [name, sha(write(path.join(installationRoot, "src", filename), name + "-candidate"))]));
  write(path.join(installationRoot, ".inner-runtime-owner.json"), { kind: "candidate", ownerId: configuration.profile.ownerId, nativeSourceId: configuration.profile.nativeSourceId });
  write(value.registryPath, { candidates: [{ installationRoot, runnerPath: path.join(installationRoot, "src", names.runner), expectedHashes }] });
  const registrySha = sha(value.registryPath);
  assert.deepEqual(readRecoveryWorkerSources(configuration, registrySha), [configuration.profile.initial.expectedHashes, expectedHashes]);
  fs.appendFileSync(path.join(installationRoot, "src", names.control), "changed");
  assert.throws(() => readRecoveryWorkerSources(configuration, registrySha), /RECOVERY_PIN_CHANGED/);
});

test("recovery binds an already-selected baseline and rejects a different baseline", context => {
  const value = fixture(context);
  const configuration = readRecoveryConfiguration(value.configurationPath, value.configurationSha256);
  const selected = { id: "previous-version", manifestSha256: "b".repeat(64) };
  configuration.input.expectedSelection = selected;
  const eventsPath = path.join(value.directory, "acceptance-events.jsonl");
  const records = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
  records.find(record => record.phase === "started").value.selected = selected;
  write(eventsPath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(bindAcceptanceRegistry(configuration).registrySha256, sha(value.registryPath));
  configuration.input.expectedSelection = { ...selected, manifestSha256: "c".repeat(64) };
  assert.throws(() => bindAcceptanceRegistry(configuration), /RECOVERY_ATTEMPT_BINDING_CHANGED/);
});

test("recovery binds the post-activation selection and rejects later registry drift", context => {
  const value = fixture(context);
  const configuration = readRecoveryConfiguration(value.configurationPath, value.configurationSha256);
  const eventsPath = path.join(value.directory, "acceptance-events.jsonl");
  const records = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
  const candidate = records.find(record => record.phase === "candidate").value;
  write(value.registryPath, { ownerId: "fixture-owner", selection: { candidateId: "same-source-proof", manifestSha256: candidate.manifestSha256 } });
  const activatedSha = sha(value.registryPath);
  for (const record of [
    { phase: "activated", value: { revision: 1, selected: { manifestSha256: candidate.manifestSha256 } } },
    { phase: "activated_registry", value: { registryPath: value.registryPath, registrySha256: activatedSha,
      candidateId: "same-source-proof", manifestSha256: candidate.manifestSha256 } },
  ]) fs.appendFileSync(eventsPath, JSON.stringify({ ...record, inputSha256: configuration.config.inputSha256 }) + "\n");
  assert.equal(bindAcceptanceRegistry(configuration).registrySha256, activatedSha);
  fs.appendFileSync(value.registryPath, " ");
  assert.throws(() => bindAcceptanceRegistry(configuration), /RECOVERY_PIN_CHANGED/);
});

test("current baseline cold recovery validates materials and archives only the bound registry through actual PowerShell", async context => {
  const value = fixture(context);
  const inspection = await execute(value, "Inspect");
  assert.equal(inspection.code, 0, inspection.stderr + inspection.stdout);
  assert.equal(inspection.result.status, "RECOVERY_MATERIAL_PREPARED_NOT_EXECUTED");
  const registrySha = sha(value.registryPath);
  const result = await execute(value);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.result.status, "CURRENT_FILES_RETAINED_SERVICES_STARTED_OPEN_SHORTCUT_MANUALLY");
  assert.equal(sha(result.result.registryArchive), registrySha);
  assert.equal(fs.existsSync(value.registryPath), false);
  assert.ok(value.baselineFiles.every(item => sha(item.path) === item.sha256));
  assert.equal(JSON.parse(fs.readFileSync(value.taskPath)).enabled, true);
  assert.deepEqual(fs.readFileSync(value.callsPath, "utf8").trim().split("\n"), ["stop", "start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1"]);
});
test("pre-existing registry is restored byte for byte by independent cold recovery", async context => {
  const value = fixture(context);
  const configuration = JSON.parse(fs.readFileSync(value.configurationPath));
  const input = JSON.parse(fs.readFileSync(configuration.inputPath));
  const backup = write(path.join(value.directory, "baseline-registry.json"), { ownerId: "fixture-owner", candidates: [], note: "retained-before-test" });
  const baselineSha = sha(backup);
  input.expectedRegistrySha256 = baselineSha;
  input.expectedRevision = 2;
  write(configuration.inputPath, input);
  configuration.inputSha256 = sha(configuration.inputPath);
  configuration.baselineRegistryBackupPath = backup;
  configuration.pins.push({ path: backup, sha256: baselineSha });
  const eventsPath = path.join(value.directory, "acceptance-events.jsonl");
  const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const event of events) {
    event.inputSha256 = configuration.inputSha256;
    if (event.phase === "started") {
      event.value.candidateRegistrySha256 = baselineSha;
      event.value.revision = 2;
    }
  }
  write(eventsPath, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const restartedPath = path.join(value.directory, "restarted.json");
  const restarted = JSON.parse(fs.readFileSync(restartedPath));
  restarted.fullRuntime.candidateRegistrySha256 = baselineSha;
  write(restartedPath, restarted);
  write(value.configurationPath, configuration);
  value.configurationSha256 = sha(value.configurationPath);
  const candidateRegistrySha = sha(value.registryPath);
  const result = await execute(value);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.result.status, "CURRENT_FILES_RETAINED_SERVICES_STARTED_OPEN_SHORTCUT_MANUALLY");
  assert.equal(sha(value.registryPath), baselineSha);
  assert.equal(sha(result.result.registryArchive), candidateRegistrySha);
  assert.equal(sha(backup), baselineSha);
  assert.ok(value.baselineFiles.every(item => sha(item.path) === item.sha256));
});

test("pre-existing registry backup must be pinned and unchanged before any recovery action", context => {
  const value = fixture(context);
  const configuration = JSON.parse(fs.readFileSync(value.configurationPath));
  const input = JSON.parse(fs.readFileSync(configuration.inputPath));
  const backup = write(path.join(value.directory, "baseline-registry.json"), { candidates: ["baseline"] });
  input.expectedRegistrySha256 = sha(backup);
  write(configuration.inputPath, input);
  configuration.inputSha256 = sha(configuration.inputPath);
  configuration.baselineRegistryBackupPath = backup;
  write(value.configurationPath, configuration);
  assert.throws(() => readRecoveryConfiguration(value.configurationPath, sha(value.configurationPath)), /RECOVERY_REGISTRY_BASELINE_INVALID/);
  configuration.pins.push({ path: backup, sha256: input.expectedRegistrySha256 });
  write(value.configurationPath, configuration);
  write(backup, "changed");
  assert.throws(() => readRecoveryConfiguration(value.configurationPath, sha(value.configurationPath)), /RECOVERY_PIN_CHANGED/);
  assert.equal(fs.existsSync(value.callsPath), false);
  assert.ok(fs.existsSync(value.registryPath));
});

test("active business refuses before any task or service action", async context => {
  const value = fixture(context, "busy");
  const result = await execute(value);
  assert.equal(result.code, 1);
  assert.match(result.result.error, /RECOVERY_CONTROL_NOT_QUIESCENT/);
  assert.equal(fs.existsSync(value.callsPath), false);
  assert.equal(JSON.parse(fs.readFileSync(value.taskPath)).enabled, true);
  assert.ok(fs.existsSync(value.registryPath));
});
test("actual PowerShell ManualProduction Inspect accepts the full argument shape with only synthetic materials", async context => {
  const value = fixture(context);
  const config = JSON.parse(fs.readFileSync(value.configurationPath, "utf8"));
  config.mode = "ManualProduction";
  write(value.configurationPath, config);
  value.configurationSha256 = sha(value.configurationPath);
  const result = await execute(value, "Inspect", null);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.result.status, "RECOVERY_MATERIAL_PREPARED_NOT_EXECUTED");
  assert.equal(fs.existsSync(value.callsPath), false);
});
test("remaining descendant prevents registry archive and service restart after normal stop reports clean", async context => {
  const value = fixture(context, "child-remains");
  const result = await execute(value);
  assert.equal(result.code, 1, result.stdout);
  assert.ok(fs.existsSync(value.registryPath));
  assert.equal(fs.readFileSync(value.callsPath, "utf8").trim(), "stop");
  assert.equal(JSON.parse(fs.readFileSync(value.taskPath)).enabled, true);
});
test("changed registry and mixed attempt evidence refuse without mutation", context => {
  const value = fixture(context);
  const config = readRecoveryConfiguration(value.configurationPath, value.configurationSha256);
  fs.appendFileSync(value.registryPath, " ");
  assert.throws(() => bindAcceptanceRegistry(config), /RECOVERY_PIN_CHANGED/);
  assert.equal(fs.existsSync(value.callsPath), false);
});
test("owner cancellation keeps task, registry and current files unchanged", async context => {
  const value = fixture(context);
  const result = await execute(value, "Recover", "NO");
  assert.equal(result.code, 1);
  assert.match(result.result.error, /COLD_RECOVERY_CANCELLED/);
  assert.equal(fs.existsSync(value.callsPath), false);
  assert.ok(value.baselineFiles.every(item => sha(item.path) === item.sha256));
});
test("restarted runtime still selecting a candidate cannot report recovery success", async context => {
  const value = fixture(context, "wrong-restarted");
  const result = await execute(value);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.result.servicesReady, false);
  assert.match(result.result.error, /RECOVERY_NEW_CONTROL_NOT_ORIGINAL/);
  assert.ok(fs.existsSync(result.result.registryArchive));
  assert.equal(JSON.parse(fs.readFileSync(value.taskPath)).enabled, true);
});
test("existing recovery attempt refuses before task mutation", async context => {
  const value = fixture(context);
  write(path.join(value.directory, "cold-recovery-attempt.json"), { state: "UNKNOWN", owner: "earlier-attempt" });
  const result = await execute(value);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(fs.existsSync(value.callsPath), false);
  assert.equal(JSON.parse(fs.readFileSync(value.taskPath)).enabled, true);
});
test("changed current source baseline refuses before task mutation", async context => {
  const value = fixture(context);
  fs.appendFileSync(value.baselineFiles[0].path, "\n");
  const result = await execute(value);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.result.error, /RECOVERY_PIN_CHANGED/);
  assert.equal(fs.existsSync(value.callsPath), false);
});
test("executable pin verification uses bounded chunks instead of whole-file allocation", context => {
  const value = fixture(context);
  const originalRead = fs.readFileSync;
  fs.readFileSync = (filename, ...rest) => {
    if (String(filename).toLowerCase().endsWith(".exe")) throw new Error("WHOLE_EXECUTABLE_READ_FORBIDDEN");
    return originalRead(filename, ...rest);
  };
  try { assert.equal(readRecoveryConfiguration(value.configurationPath, value.configurationSha256).config.baselineFiles.length, 47); }
  finally { fs.readFileSync = originalRead; }
});
for (const fault of ["app-replaced-before", "app-replaced-between"]) {
  test(`normal same-parent App replacement is independently rebound: ${fault}`, async context => {
    const value = fixture(context, fault);
    const result = await execute(value);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.result.servicesReady, true);
    const proof = JSON.parse(fs.readFileSync(path.join(result.result.work, "combined-proof.json"), "utf8"));
    assert.ok(proof.capturedProcesses.some(process => process.pid === 201));
    if (fault === "app-replaced-between") assert.ok(proof.capturedProcesses.some(process => process.pid === 101));
  });
}
test("late worker grandchild captured by second proof cannot be omitted from exit check", async context => {
  const value = fixture(context, "late-child-remains");
  const result = await execute(value);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.result.error, /RECOVERY_CAPTURED_PROCESS_REMAINS/);
  assert.ok(fs.existsSync(value.registryPath));
  assert.equal(fs.readFileSync(value.callsPath, "utf8").trim(), "stop");
});
test("task mutation followed by readback failure still restores original enabled state", async context => {
  const value = fixture(context, "disable-readback");
  const result = await execute(value);
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.result.error, /FIXTURE_DISABLE_READBACK_FAILED/);
  assert.equal(JSON.parse(fs.readFileSync(value.taskPath, "utf8")).enabled, true);
  assert.equal(fs.existsSync(value.callsPath), false);
});
