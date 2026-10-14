import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertRecoveryQuiescent, assertRecoveryExited } from "./full-runtime-recovery-proof.mjs";

const fail = code => { throw new Error(code); };
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const read = filename => JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
function plain(filename, directory = false) {
  if (!path.isAbsolute(filename)) fail("RECOVERY_ABSOLUTE_PATH_REQUIRED");
  let current = path.resolve(filename);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("RECOVERY_LINK_FORBIDDEN");
    if (current === path.resolve(filename) && !(directory ? stat.isDirectory() : stat.isFile())) fail("RECOVERY_PATH_KIND_CHANGED");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function pin(filename, sha256) {
  plain(filename);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) fail("RECOVERY_PIN_CHANGED:" + filename);
  const descriptor = fs.openSync(filename, "r");
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytesRead));
  } finally { fs.closeSync(descriptor); }
  if (digest.digest("hex") !== sha256) fail("RECOVERY_PIN_CHANGED:" + filename);
}
function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
export function readRecoveryConfiguration(filename, sha256) {
  pin(filename, sha256);
  const config = read(filename);
  if (config.schemaVersion !== 1 || !["ManualProduction", "TempFixture"].includes(config.mode)) fail("RECOVERY_CONFIGURATION_INVALID");
  for (const item of config.pins) pin(item.path, item.sha256);
  pin(config.inputPath, config.inputSha256);
  pin(config.ownerConfigurationPath, config.ownerConfigurationSha256);
  const input = { ...read(config.inputPath), processBindings: config.processBindings };
  const owner = read(config.ownerConfigurationPath);
  const profile = read(input.profilePath);
  const pinnedPaths = config.pins.map(item => item.path);
  if (input.expectedRegistrySha256 != null) {
    if (!/^[a-f0-9]{64}$/u.test(input.expectedRegistrySha256)
      || typeof config.baselineRegistryBackupPath !== "string"
      || !inside(path.dirname(filename), config.baselineRegistryBackupPath)
      || same(config.baselineRegistryBackupPath, config.registryPath)
      || !config.pins.some(item => same(item.path, config.baselineRegistryBackupPath)
        && item.sha256 === input.expectedRegistrySha256)) fail("RECOVERY_REGISTRY_BASELINE_INVALID");
    pin(config.baselineRegistryBackupPath, input.expectedRegistrySha256);
  } else if (config.baselineRegistryBackupPath) fail("RECOVERY_REGISTRY_BASELINE_INVALID");
  for (const required of [input.profilePath, config.entryPath, config.ioPath, config.proofPath, config.nodePath, owner.codexExecutablePath,
    config.powerShellPath, path.join(owner.stopOps, "owned-stop-marker.ps1"),
    path.join(owner.stopOps, "stop-codex-app-server-proxy.ps1"), path.join(owner.stopOps, "resolve-napcat-data-root.ps1"),
    ...["start-codex-model-stream-proxy.ps1", "start-napcat-task-router.ps1", "start-napcat-supervisor.ps1",
      "resolve-napcat-data-root.ps1", "Run-NapCatSupervisorWatchdog.ps1", "Run-HiddenPowerShell.vbs"].map(name => path.join(owner.serviceOps, name))]) {
    if (!pinnedPaths.some(candidate => same(candidate, required))) fail("RECOVERY_REQUIRED_PIN_MISSING");
  }
  if (!same(config.registryPath, path.join(profile.stateRoot, "inner-candidate-approvals.json"))
    || !same(input.runtimePath, profile.outerPaths.runtimeStatePath)
    || !same(input.tokenPath, profile.outerPaths.tokenFilePath)
    || !same(owner.dataRoot, path.dirname(profile.outerStateRoot))
    || !same(config.nodePath, owner.nodePath) || !same(config.powerShellPath, owner.ownerPowerShell.path)) fail("RECOVERY_PATH_BINDING_CHANGED");
  plain(profile.stateRoot, true);
  plain(path.dirname(filename), true);
  const stateOwnerPath = path.join(profile.stateRoot, ".inner-runtime-owner.json");
  if (!pinnedPaths.some(candidate => same(candidate, stateOwnerPath))) fail("RECOVERY_STATE_OWNER_PIN_MISSING");
  const stateOwner = read(stateOwnerPath);
  if (stateOwner.kind !== "state" || stateOwner.ownerId !== profile.ownerId || stateOwner.nativeSourceId !== profile.nativeSourceId) fail("RECOVERY_STATE_OWNER_CHANGED");
  if (!Array.isArray(config.baselineFiles) || config.baselineFiles.length !== 47) fail("RECOVERY_BASELINE_INCOMPLETE");
  for (const item of config.baselineFiles) {
    if (!same(path.dirname(item.path), path.join(profile.installationRoot, "src"))) fail("RECOVERY_BASELINE_PATH_CHANGED");
    pin(item.path, item.sha256);
  }
  if (new Set(config.baselineFiles.map(item => path.resolve(item.path).toLowerCase())).size !== 47) fail("RECOVERY_BASELINE_DUPLICATE");
  if (!Array.isArray(config.ports) || config.ports.length !== 5 || config.ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) fail("RECOVERY_PORTS_INVALID");
  if (config.mode === "TempFixture") {
    plain(config.fixtureRoot, true);
    if (!inside(os.tmpdir(), config.fixtureRoot) || read(path.join(config.fixtureRoot, "recovery-owner.json")).ownerId !== "full-runtime-recovery-test") fail("RECOVERY_FIXTURE_OWNER_REQUIRED");
    for (const target of [filename, config.inputPath, config.ownerConfigurationPath, config.registryPath, profile.stateRoot,
      profile.installationRoot, input.runtimePath, profile.managedStatePath, owner.dataRoot, owner.serviceOps, owner.stopOps]) {
      if (!inside(config.fixtureRoot, target)) fail("RECOVERY_FIXTURE_PATH_ESCAPE");
    }
  }
  return { config, input, profile, owner };
}
export function bindAcceptanceRegistry(context) {
  const { config, input } = context;
  const eventsPath = path.join(path.dirname(config.inputPath), "acceptance-events.jsonl");
  plain(eventsPath);
  const text = fs.readFileSync(eventsPath, "utf8");
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) fail("RECOVERY_EVENT_LOG_TOO_LARGE");
  const lines = text.split(/\r?\n/u);
  const records = [];
  for (let index = 0; index < lines.length; index++) {
    if (index === lines.length - 1 && !lines[index]) continue;
    try { records.push(JSON.parse(lines[index])); }
    catch (error) { if (index !== lines.length - 1 || text.endsWith("\n")) throw error; }
  }
  if (records.some(record => record.inputSha256 !== config.inputSha256)) fail("RECOVERY_EVENT_IDENTITY_CHANGED");
  const unique = phase => {
    const entries = records.filter(record => record.phase === phase);
    if (entries.length !== 1) fail("RECOVERY_EVENT_NOT_UNIQUE:" + phase);
    return entries[0].value;
  };
  const started = unique("started");
  const candidate = unique("candidate");
  const registered = unique("registered");
  const baselineSelection = input.expectedSelection ?? { id: "original", manifestSha256: null };
  if (started.instanceId !== input.instanceId || started.revision !== (input.expectedRevision ?? 0) || started.selected?.id !== baselineSelection.id
    || (started.selected?.manifestSha256 ?? null) !== (baselineSelection.manifestSha256 ?? null)
    || started.candidateRegistrySha256 !== (input.expectedRegistrySha256 ?? null) || registered.instanceId !== input.instanceId
    || !/^[a-f0-9]{64}$/u.test(candidate.manifestSha256)
    || !same(candidate.manifestPath, path.join(input.installationRoot, "src", "manifest.json"))) fail("RECOVERY_ATTEMPT_BINDING_CHANGED");
  let registrySha256 = registered.candidateRegistrySha256;
  if (records.some(record => record.phase === "activated_registry")) {
    const activated = unique("activated");
    const registry = unique("activated_registry");
    if (activated.revision !== (input.expectedRevision ?? 0) + 1 || activated.selected?.manifestSha256 !== candidate.manifestSha256
      || !same(registry.registryPath, config.registryPath) || registry.candidateId !== input.candidateId
      || registry.manifestSha256 !== candidate.manifestSha256) fail("RECOVERY_ACTIVATED_REGISTRY_INVALID");
    registrySha256 = registry.registrySha256;
  }
  pin(config.registryPath, registrySha256);
  return { registryPath: config.registryPath, registrySha256,
    baselineRegistryPath: config.baselineRegistryBackupPath ?? null, baselineRegistrySha256: input.expectedRegistrySha256 ?? null,
    candidateId: input.candidateId, manifestSha256: candidate.manifestSha256,
    eventsPath, eventsSha256: hash(Buffer.from(text)), inputSha256: config.inputSha256 };
}
export function bindCurrentApp(input, snapshot) {
  if (snapshot.runtime.appServerPid === input.appServerPid) return input;
  const previous = input.processBindings.find(process => process.pid === input.appServerPid);
  const current = snapshot.processes.find(process => process.pid === snapshot.runtime.appServerPid);
  if (!previous || !current || snapshot.processes.some(process => process.pid === input.appServerPid)
    || current.parentPid !== input.parentPid || !current.commandLine
    || !same(current.executablePath, previous.executablePath)
    || hash(current.commandLine) !== previous.commandLineSha256
    || !(Date.parse(current.creationDate) > Date.parse(previous.creationDate))) fail("RECOVERY_REPLACEMENT_APP_UNPROVEN");
  return { ...input, appServerPid: current.pid, processBindings: [
    ...input.processBindings.filter(process => process.pid !== input.appServerPid),
    { pid: current.pid, creationDate: current.creationDate, executablePath: current.executablePath,
      commandLineSha256: hash(current.commandLine) },
  ] };
}
export function mergeRecoveryProof(previous, current) {
  if (previous.instanceId !== current.instanceId || previous.registry.inputSha256 !== current.registry.inputSha256
    || previous.registry.registrySha256 !== current.registry.registrySha256) fail("RECOVERY_PROOF_IDENTITY_CHANGED");
  const captured = new Map();
  for (const process of [...previous.capturedProcesses, ...current.capturedProcesses]) {
    if (captured.has(process.pid) && JSON.stringify(captured.get(process.pid)) !== JSON.stringify(process)) fail("RECOVERY_CAPTURE_IDENTITY_REUSED");
    captured.set(process.pid, process);
  }
  return { ...current, capturedProcesses: [...captured.values()], ports: [...new Set([...previous.ports, ...current.ports])] };
}
export function readRecoveryWorkerSources(context, registrySha256) {
  const { config, input, profile } = context;
  const sources = [profile.initial.expectedHashes];
  if (registrySha256 == null) return sources;
  pin(config.registryPath, registrySha256);
  const registry = read(config.registryPath);
  if (registry.candidates === undefined) return sources;
  if (!Array.isArray(registry.candidates) || registry.candidates.length > 4) fail("RECOVERY_CANDIDATES_INVALID");
  for (const candidate of registry.candidates) {
    if (!candidate || typeof candidate.installationRoot !== "string" || !input.candidateRoot
      || !inside(input.candidateRoot, candidate.installationRoot)
      || !same(candidate.runnerPath, path.join(candidate.installationRoot, "src", "codex-model-stream-proxy-runner.mjs"))) fail("RECOVERY_CANDIDATE_PATH_INVALID");
    const owner = read(path.join(candidate.installationRoot, ".inner-runtime-owner.json"));
    if (owner.kind !== "candidate" || owner.ownerId !== profile.ownerId || owner.nativeSourceId !== profile.nativeSourceId) fail("RECOVERY_CANDIDATE_OWNER_CHANGED");
    const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
    if (!candidate.expectedHashes || Object.keys(candidate.expectedHashes).length !== 4) fail("RECOVERY_CANDIDATE_HASHES_INVALID");
    for (const [name, filename] of Object.entries(names)) pin(path.join(candidate.installationRoot, "src", filename), candidate.expectedHashes[name]);
    if (!sources.some(source => Object.keys(names).every(name => source[name] === candidate.expectedHashes[name]))) sources.push(candidate.expectedHashes);
  }
  return sources;
}
export function inspectRecovery(context, action, snapshotPath, proofPath) {
  if (action === "Inspect") return { status: "RECOVERY_MATERIAL_PREPARED_NOT_EXECUTED", baselineFiles: 47 };
  if (action === "Bind") return bindAcceptanceRegistry(context);
  const snapshot = read(snapshotPath);
  if (action === "Quiescent") {
    const registry = bindAcceptanceRegistry(context);
    const proof = assertRecoveryQuiescent({ input: bindCurrentApp(context.input, snapshot), profile: context.profile,
      runtime: snapshot.runtime, managed: snapshot.managed, processes: snapshot.processes,
      listeners: snapshot.listeners, now: snapshot.now, workerSources: readRecoveryWorkerSources(context, registry.registrySha256) });
    const current = { ...proof, registry, instanceId: context.input.instanceId };
    return proofPath ? mergeRecoveryProof(read(proofPath), current) : current;
  }
  if (action === "Exited") {
    const proof = read(proofPath);
    if (proof.instanceId !== context.input.instanceId || proof.registry.inputSha256 !== context.config.inputSha256) fail("RECOVERY_PROOF_IDENTITY_CHANGED");
    return assertRecoveryExited({ capturedProcesses: proof.capturedProcesses, processes: snapshot.processes,
      listeners: snapshot.listeners, ports: [...new Set([...context.config.ports, ...proof.ports])] });
  }
  fail("RECOVERY_ACTION_INVALID");
}
export async function verifyRestartedRecovery(context, snapshotPath, proofPath) {
  const snapshot = read(snapshotPath);
  const previous = read(proofPath);
  const { config, input, profile } = context;
  if (previous.instanceId !== input.instanceId || previous.registry?.inputSha256 !== config.inputSha256) fail("RECOVERY_PROOF_IDENTITY_CHANGED");
  if (input.expectedRegistrySha256 != null) pin(config.registryPath, input.expectedRegistrySha256);
  else if (fs.existsSync(config.registryPath)) fail("RECOVERY_REGISTRY_REAPPEARED");
  const runtime = snapshot.runtime;
  if (typeof runtime?.instanceToken !== "string" || !runtime.instanceToken || runtime.instanceToken === input.instanceId
    || previous.capturedProcesses.some(process => process.pid === runtime.pid || process.pid === runtime.appServerPid)) fail("RECOVERY_NEW_INSTANCE_REQUIRED");
  const processBindings = [runtime.pid, runtime.appServerPid].map(processId => {
    const process = snapshot.processes.find(value => value.pid === processId);
    if (!process || !process.commandLine) fail("RECOVERY_NEW_PROCESS_MISSING");
    return { pid: processId, creationDate: process.creationDate, executablePath: process.executablePath, commandLineSha256: hash(process.commandLine) };
  });
  if (!same(processBindings[0].executablePath, config.nodePath) || !same(processBindings[1].executablePath, context.owner.codexExecutablePath)) fail("RECOVERY_NEW_EXECUTABLE_CHANGED");
  const proof = assertRecoveryQuiescent({ input: { ...input, parentPid: runtime.pid, appServerPid: runtime.appServerPid,
    instanceId: runtime.instanceToken, processBindings }, profile, runtime, managed: snapshot.managed,
    processes: snapshot.processes, listeners: snapshot.listeners, now: snapshot.now,
    workerSources: readRecoveryWorkerSources(context, input.expectedRegistrySha256 ?? null) });
  if (snapshot.managed.coordinator.workers.filter(worker => worker.alive && !worker.retired).length !== 1
    || snapshot.managed.controlRevision !== 0) fail("RECOVERY_NEW_WORKER_NOT_READY");
  let status;
  if (config.mode === "TempFixture") status = snapshot.fullRuntime;
  else {
    const control = new URL(input.controlUrl);
    if (control.protocol !== "http:" || control.hostname !== "127.0.0.1" || control.pathname !== "/"
      || control.search || control.hash || control.username || control.password) fail("RECOVERY_CONTROL_LOOPBACK_REQUIRED");
    const token = fs.readFileSync(input.tokenPath, "utf8").trim();
    const response = await fetch(`${input.controlUrl}/v1/full-runtime`, { method: "GET", redirect: "error",
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) fail("RECOVERY_CONTROL_HTTP_FAILED");
    status = await response.json();
  }
  const baselineSelection = input.expectedRegistrySha256 == null ? null : read(config.registryPath).selection;
  const recoveredSelection = baselineSelection ? status.selected?.manifestSha256 === baselineSelection.manifestSha256 && status.revision === 1
    : status.selected?.id === "original" && status.revision === 0;
  if (status?.ok !== true || status.instanceId !== runtime.instanceToken || !recoveredSelection
    || status.controlGeneration !== 0 || status.candidateRegistrySha256 !== (input.expectedRegistrySha256 ?? null)
    || status.busy !== false || status.failed !== false || status.participants?.length !== 5
    || status.prepared?.length !== 0) fail("RECOVERY_NEW_CONTROL_NOT_ORIGINAL");
  return { status: "CURRENT_RUNTIME_RECOVERED", instanceId: runtime.instanceToken, parentPid: runtime.pid,
    appServerPid: runtime.appServerPid, workerPids: proof.workerPids, baselineFiles: 47, participants: 5 };
}
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const [, , filename, sha256, action = "Inspect", snapshotPath, proofPath] = process.argv;
    const context = readRecoveryConfiguration(filename, sha256);
    console.log(JSON.stringify(action === "Restarted" ? await verifyRestartedRecovery(context, snapshotPath, proofPath)
      : inspectRecovery(context, action, snapshotPath, proofPath)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
