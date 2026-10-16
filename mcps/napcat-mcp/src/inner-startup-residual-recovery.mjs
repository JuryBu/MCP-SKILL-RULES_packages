import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { windowsPowerShellEnvironment } from "./windows-powershell-environment.mjs";
import { checkedRuntimePath, readInnerRuntimeProfile, withinRuntimeRoot, approvedInnerCandidate,
  innerCandidateRegistryPath, INNER_RUNTIME_STATE_MAX_BYTES } from "./inner-runtime-profile.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function canonicalPath(value) {
  let current = checkedRuntimePath(value);
  const suffix = [];
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync.native(current), ...suffix).toLowerCase();
}

const samePath = (left, right) => canonicalPath(left) === canonicalPath(right);
const validPid = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const validWorkerId = value => {
  const match = typeof value === "string" && /^(.{36})-worker-([1-9][0-9]*)$/u.exec(value);
  return Boolean(match && uuid(match[1]) && Number.isSafeInteger(Number(match[2])));
};

function settledActivation(coordinator, interrupted = false) {
  const activation = coordinator?.activation;
  if (activation == null) return true;
  return typeof activation.active === "boolean" && uuid(activation.activationId)
    && validWorkerId(activation.sourceWorkerId) && validWorkerId(activation.targetWorkerId)
    && activation.sourceWorkerId !== activation.targetWorkerId
    && coordinator.defaultWorkerId === (activation.active ? activation.targetWorkerId : activation.sourceWorkerId)
    && Array.isArray(activation.deferredThreadIds) && (interrupted
      ? new Set(activation.deferredThreadIds).size === activation.deferredThreadIds.length
        && activation.deferredThreadIds.every(threadId => coordinator.threads?.some(thread =>
          thread.threadId === threadId && thread.pendingActivationId === activation.activationId))
      : activation.deferredThreadIds.length === 0)
    && coordinator.activeHttp === 0 && coordinator.pendingControl === 0
    && Array.isArray(coordinator.threads) && coordinator.threads.every(thread => (interrupted || thread.phase === "terminal")
      && thread.activeHttp === 0 && (thread.pendingActivationId == null || (interrupted && activation.active
        && thread.pendingActivationId === activation.activationId && activation.deferredThreadIds.includes(thread.threadId)))
      && thread.activationError == null)
    && [activation.sourceWorkerId, activation.targetWorkerId].every(workerId =>
      coordinator.workers?.some(worker => worker.workerId === workerId));
}

function record(filePath, maximum = 1048576) {
  const target = checkedRuntimePath(filePath, { existing: true });
  const stat = fs.statSync(target);
  if (stat.nlink !== 1 || stat.size > maximum) fail("STARTUP_RECOVERY_ORIGINAL_IDENTITY_REQUIRED");
  const bytes = fs.readFileSync(target);
  if (bytes.length !== stat.size || bytes.length > maximum) fail("STARTUP_RECOVERY_ORIGINAL_CHANGED");
  return { path: target, sha256: digest(bytes), bytes: bytes.length, dev: stat.dev, ino: stat.ino,
    birthtimeMs: stat.birthtimeMs, content: bytes };
}

const json = entry => {
  try { return JSON.parse(entry.content.toString("utf8").replace(/^\uFEFF/u, "")); }
  catch { fail("STARTUP_RECOVERY_INVALID_JSON"); }
};
const publicRecord = ({ content, ...identity }) => identity;

export function inspectStartupRecoveryHost() {
  if (process.platform !== "win32") fail("STARTUP_RECOVERY_WINDOWS_INVENTORY_REQUIRED");
  const child = windowsPowerShellEnvironment();
  const shell = child.executable;
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate);$l=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object LocalPort,OwningProcess,LocalAddress);[pscustomobject]@{complete=$true;processes=$p;listeners=$l}|ConvertTo-Json -Depth 5 -Compress";
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    env: child.environment, encoding: "utf8", timeout: 12000, maxBuffer: 4194304, windowsHide: true });
  if (result.error || result.status !== 0) fail("STARTUP_RECOVERY_HOST_INVENTORY_UNKNOWN");
  let observed;
  try { observed = JSON.parse(result.stdout.replace(/^\uFEFF/u, "")); }
  catch { fail("STARTUP_RECOVERY_HOST_INVENTORY_UNKNOWN"); }
  if (observed.complete !== true || !Array.isArray(observed.processes) || !Array.isArray(observed.listeners)
    || !observed.processes.length) fail("STARTUP_RECOVERY_HOST_INVENTORY_UNKNOWN");
  return observed;
}

function requireAbsent(plan, observed) {
  if (observed?.complete !== true || !Array.isArray(observed.processes) || !Array.isArray(observed.listeners)) {
    fail("STARTUP_RECOVERY_HOST_INVENTORY_UNKNOWN");
  }
  const reused = new Map();
  if (plan.allowInterruptedSnapshot && Number.isFinite(plan.snapshotAt)) {
    for (const processInfo of observed.processes) {
      const raw = processInfo.CreationDate;
      const serialized = typeof raw === "string" && /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/u.exec(raw);
      const createdAt = serialized ? Number(serialized[1]) : Date.parse(raw);
      const command = String(processInfo.CommandLine ?? "").toLowerCase();
      if (plan.pids.includes(processInfo.ProcessId) && createdAt > plan.snapshotAt + 2000 && command
        && !plan.processPaths.some(target => command.includes(target.toLowerCase()))) reused.set(processInfo.ProcessId, createdAt);
    }
  }
  for (const processInfo of observed.processes) {
    if ((plan.pids.includes(processInfo.ProcessId) && !reused.has(processInfo.ProcessId)) || plan.pids.includes(processInfo.ParentProcessId)) {
      fail("STARTUP_RECOVERY_PROCESS_STILL_PRESENT");
    }
    if (processInfo.ProcessId === process.pid) continue;
    if (/^(?:node|codex)(?:\.exe)?$/iu.test(processInfo.Name ?? "") && !processInfo.CommandLine) {
      fail("STARTUP_RECOVERY_PROCESS_IDENTITY_UNKNOWN");
    }
    const command = String(processInfo.CommandLine ?? "").toLowerCase();
    if (plan.processPaths.some(target => command.includes(target.toLowerCase()))) {
      fail("STARTUP_RECOVERY_RELATED_PROCESS_PRESENT");
    }
  }
  if (observed.listeners.some(listener => plan.ports.includes(listener.LocalPort)
    || (plan.pids.includes(listener.OwningProcess) && !reused.has(listener.OwningProcess)))) {
    fail("STARTUP_RECOVERY_LISTENER_STILL_PRESENT");
  }
}

export function planInnerStartupRecovery(input, inspectHost = inspectStartupRecoveryHost) {
  if (input.historyPolicy !== undefined && input.historyPolicy !== "preserve") fail("STARTUP_RECOVERY_HISTORY_POLICY_INVALID");
  const preserveHistory = input.historyPolicy === "preserve";
  if (input.allowInterruptedSnapshot !== undefined && typeof input.allowInterruptedSnapshot !== "boolean") fail("STARTUP_RECOVERY_INTERRUPTED_POLICY_INVALID");
  const interrupted = input.allowInterruptedSnapshot === true;
  if (interrupted && !preserveHistory) fail("STARTUP_RECOVERY_INTERRUPTED_REQUIRES_HISTORY");
  const originals = [];
  const read = (target, maximum) => { const entry = record(target, maximum); originals.push(entry); return entry; };
  const configurationEntry = read(input.configurationPath, 65536);
  const configuration = json(configurationEntry);
  if (configuration.schemaVersion !== 1 || typeof configuration.enabled !== "boolean"
    || !samePath(configuration.innerManagedProfilePath ?? "", input.profilePath)
    || configuration.innerManagedProfileSha256 !== input.profileSha256) fail("STARTUP_RECOVERY_CONFIGURATION_MISMATCH");
  const profileEntry = read(input.profilePath, 65536);
  if (profileEntry.sha256 !== input.profileSha256) fail("STARTUP_RECOVERY_PROFILE_HASH_MISMATCH");
  const profile = readInnerRuntimeProfile(configuration.innerManagedProfilePath);
  const outerRoot = checkedRuntimePath(path.join(input.dataRoot, "state"), { directory: true });
  if (!samePath(profile.outerStateRoot ?? profile.stateRoot, outerRoot)) fail("STARTUP_RECOVERY_ROOT_MISMATCH");
  for (const [name, filename] of Object.entries({ runtimeStatePath: "codex-app-server-proxy-runtime.json",
    lockPath: "codex-app-server-proxy.lock", stopFilePath: "codex-app-server-proxy.stop", tokenFilePath: "codex-app-server-proxy-token.txt",
    journalPath: "codex-app-server-wake-journal.json" })) {
    if (!samePath(profile.outerPaths?.[name] ?? "", path.join(outerRoot, filename))) fail("STARTUP_RECOVERY_PATH_MISMATCH");
  }
  if (Object.entries(input.ports ?? {}).some(([name, port]) => profile.ports[name] !== port)
    || Object.keys(input.ports ?? {}).sort().join(",") !== "control,downstream,probe,upstream") fail("STARTUP_RECOVERY_PORT_MISMATCH");
  if (fs.existsSync(profile.outerPaths.stopFilePath) || fs.existsSync(`${profile.outerPaths.lockPath}.recovery`)) {
    fail("STARTUP_RECOVERY_STOP_OR_RECOVERY_REQUIREMENT_PRESENT");
  }
  for (const target of [path.join(profile.checkpointRoot, ".inner-runtime-owner.json"),
    path.join(profile.stateRoot, ".inner-runtime-owner.json")]) read(target, 65536);
  if (read(profile.outerPaths.tokenFilePath, 4096).sha256 !== profile.controlTokenSha256) fail("STARTUP_RECOVERY_TOKEN_MISMATCH");
  const outerEntry = read(profile.outerPaths.runtimeStatePath, preserveHistory ? INNER_RUNTIME_STATE_MAX_BYTES : 65536);
  const managedEntry = read(profile.managedStatePath, preserveHistory ? INNER_RUNTIME_STATE_MAX_BYTES : 65536);
  const lockEntry = read(profile.outerPaths.lockPath, 65536);
  const outer = json(outerEntry);
  const managed = json(managedEntry);
  const lease = json(lockEntry);
  if (outer.schemaVersion !== 1 || managed.schemaVersion !== 1 || !uuid(outer.instanceToken)
    || managed.ownerId !== profile.ownerId || managed.nativeSourceId !== profile.nativeSourceId
    || managed.instanceToken !== outer.instanceToken || lease.token !== outer.instanceToken
    || !validPid(outer.pid) || managed.pid !== outer.pid || lease.pid !== outer.pid
    || typeof outer.startedAt !== "string" || !Number.isFinite(Date.parse(outer.startedAt))
    || lease.startedAt !== outer.startedAt || !samePath(managed.stopFilePath ?? "", profile.outerPaths.stopFilePath)) {
    fail("STARTUP_RECOVERY_INSTANCE_IDENTITY_MISMATCH");
  }
  if (!(preserveHistory ? ["running", "restarting", "degraded", "stopped", "waiting_for_desktop"] : ["running", "stopped"]).includes(outer.state)
    || (outer.state === "waiting_for_desktop" && (outer.waitingForDesktop !== true || outer.appServerPid !== null))
    || !(preserveHistory ? ["running", "closed"] : ["running"]).includes(managed.state) || (!preserveHistory && managed.healthy !== true)
    || managed.controlBusy !== false || !Array.isArray(managed.controlOperations) || managed.controlOperations.length
    || !managed.nativeSource || !Number.isSafeInteger(managed.nativeSource.delivered) || managed.nativeSource.delivered < 0
    || (!preserveHistory && (managed.nativeSource.healthy !== true || managed.nativeSource.delivered !== 0))
    || managed.coordinator?.transactionActive !== false || managed.coordinator.workerMaintenance !== false
    || !(preserveHistory ? settledActivation(managed.coordinator, interrupted) : managed.coordinator.activation == null)
    || (interrupted && (managed.coordinator.activeHttp !== 0 || managed.coordinator.pendingControl !== 0))
    || !Array.isArray(managed.coordinator.threads)
    || (!preserveHistory && managed.coordinator.threads.length)
    || managed.coordinator.threads.some(thread => !["active", "terminal"].includes(thread.phase)
      || thread.activeHttp !== 0 || (!interrupted && thread.pendingActivationId != null)
      || (thread.pendingActivationId != null && managed.coordinator.activation == null))
    || !Array.isArray(managed.coordinator.workers) || !managed.coordinator.workers.length
    || (interrupted && managed.coordinator.threads.some(thread => !managed.coordinator.workers.some(worker => worker.workerId === thread.workerId)))
    || !Array.isArray(outer.proxy?.clients) || outer.proxy.clientCount !== outer.proxy.clients.length
    || (!interrupted && outer.proxy.clientCount !== 0)
    || !Number.isSafeInteger(outer.proxy.journal?.unknownWakeCount) || outer.proxy.journal.unknownWakeCount < 0
    || (!preserveHistory && outer.proxy.journal.unknownWakeCount !== 0) || outer.proxy.outerRuntime?.instanceId !== outer.instanceToken
    || outer.proxy.outerRuntime.busy !== false
    || ["activeOperationCount", "trackedRequestCount", "pendingToolCount"].some(name => outer.proxy.outerRuntime[name] !== 0)) {
    fail("STARTUP_RECOVERY_IDLE_PROOF_REQUIRED");
  }
  if (fs.existsSync(profile.outerPaths.journalPath)) {
    const journal = json(read(profile.outerPaths.journalPath, preserveHistory ? 67108864 : undefined));
    if (![1, 2].includes(journal.schemaVersion) || !journal.wakes || Array.isArray(journal.wakes)
      || (!preserveHistory && Object.keys(journal.wakes).length)) {
      fail("STARTUP_RECOVERY_WAKE_RESULT_UNRESOLVED");
    }
  } else if (outer.proxy.journal.wakeCount !== 0) fail("STARTUP_RECOVERY_JOURNAL_MISSING");
  const pids = [outer.pid];
  if (outer.appServerPid !== null) {
    if (!validPid(outer.appServerPid)) fail("STARTUP_RECOVERY_CHILD_IDENTITY_UNKNOWN");
    pids.push(outer.appServerPid);
  }
  if (outer.startupChildPids !== undefined) {
    if (!Array.isArray(outer.startupChildPids) || outer.startupChildPids.some(value => !validPid(value))) fail("STARTUP_RECOVERY_CHILD_IDENTITY_UNKNOWN");
    pids.push(...outer.startupChildPids);
  }
  const ports = Object.values(profile.ports);
  const processPaths = [profile.outerPaths.runtimeStatePath, input.profilePath, profile.checkpointRoot,
    path.join(profile.installationRoot, "src", "codex-app-server-proxy-runner.mjs"), profile.initial.runnerPath];
  const registryPath = innerCandidateRegistryPath(profile);
  if (fs.existsSync(registryPath)) read(registryPath, 65536);
  const sources = [profile.initial, ...(profile.approvedCandidates ?? []).map(candidate => approvedInnerCandidate(profile, candidate.id))];
  const verifiedSources = new Set();
  const workerIds = new Set();
  for (const worker of managed.coordinator.workers) {
    const source = sources.find(candidate => Object.entries(candidate.expectedHashes).every(([name, hash]) => worker.sourceHashes?.[name] === hash));
    if (!validPid(worker.pid) || !validWorkerId(worker.workerId) || workerIds.has(worker.workerId) || !source) {
      fail("STARTUP_RECOVERY_WORKER_IDENTITY_UNKNOWN");
    }
    workerIds.add(worker.workerId);
    if (!verifiedSources.has(source.runnerPath)) {
      verifiedSources.add(source.runnerPath);
      if (source.installationRoot) read(path.join(source.installationRoot, ".inner-runtime-owner.json"), 65536);
      for (const [name, file] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
        helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
        if (read(path.join(path.dirname(source.runnerPath), file), 4194304).sha256 !== source.expectedHashes[name]) {
          fail("STARTUP_RECOVERY_SOURCE_CHANGED");
        }
      }
      processPaths.push(source.runnerPath);
    }
    pids.push(worker.pid);
    const workerRoot = checkedRuntimePath(path.join(profile.stateRoot, worker.workerId), { directory: true });
    const runtime = json(read(path.join(workerRoot, "codex-model-stream-proxy-runtime.json"), 65536));
    const workerLease = json(read(path.join(workerRoot, "codex-model-stream-proxy.lock.json"), 65536));
    if (runtime.pid !== worker.pid || !uuid(runtime.instanceToken) || workerLease.pid !== worker.pid
      || workerLease.instanceToken !== runtime.instanceToken || workerLease.startedAt !== runtime.startedAt
      || runtime.upstreamOrigin !== profile.upstreamOrigin || runtime.activeRequests !== 0
      || !Number.isSafeInteger(runtime.counters?.total) || runtime.counters.total < 0
      || (!preserveHistory && runtime.counters.total !== 0)) {
      fail("STARTUP_RECOVERY_WORKER_IDLE_OR_IDENTITY_UNKNOWN");
    }
    let endpoint;
    try { endpoint = new URL(runtime.endpoint); } catch { fail("STARTUP_RECOVERY_WORKER_ENDPOINT_UNKNOWN"); }
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !Number(endpoint.port)) fail("STARTUP_RECOVERY_WORKER_ENDPOINT_UNKNOWN");
    ports.push(Number(endpoint.port));
    const log = read(path.join(workerRoot, "codex-model-stream-proxy.jsonl"), preserveHistory ? 67108864 : undefined);
    const events = log.content.toString("utf8").trim().split(/\r?\n/u).map(line => {
      try { return JSON.parse(line); } catch { fail("STARTUP_RECOVERY_WORKER_LOG_UNKNOWN"); }
    });
    if (!events.length || (!preserveHistory && events.some(event => !["runner_started", "runner_shutdown_started", "runner_stopped"].includes(event.type)))) {
      fail("STARTUP_RECOVERY_WORKER_CALL_HISTORY_UNRESOLVED");
    }
    processPaths.push(workerRoot);
  }
  for (const [name, file] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
    if (read(path.join(profile.installationRoot, "src", file), 4194304).sha256 !== profile.initial.expectedHashes[name]) {
      fail("STARTUP_RECOVERY_SOURCE_CHANGED");
    }
  }
  const plan = { schemaVersion: 1, recoverable: true, ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId,
    instanceToken: outer.instanceToken, checkpointRoot: profile.checkpointRoot,
    pids: [...new Set(pids)], ports: [...new Set(ports)], processPaths, originals: originals.map(publicRecord),
    runtimeStatePath: outerEntry.path, managedStatePath: managedEntry.path, lockPath: lockEntry.path,
    ...(interrupted ? { allowInterruptedSnapshot: true,
      snapshotAt: Math.max(Date.parse(outer.livenessAt), Date.parse(managed.livenessAt)) } : {}),
    ...(preserveHistory ? { historyPolicy: "preserve", preservedHistory: {
      deliveredEvents: managed.nativeSource.delivered, threadCount: managed.coordinator.threads.length,
      unknownWakeCount: outer.proxy.journal.unknownWakeCount, journalReplayed: false,
    } } : {}) };
  requireAbsent(plan, inspectHost());
  return plan;
}

export function applyInnerStartupRecovery(input, expectedPlan, inspectHost = inspectStartupRecoveryHost) {
  const fresh = planInnerStartupRecovery(input, inspectHost);
  if (JSON.stringify(fresh) !== JSON.stringify(expectedPlan)) fail("STARTUP_RECOVERY_PLAN_CHANGED");
  const guardPath = `${fresh.lockPath}.recovery`;
  const guard = JSON.stringify({ ownerId: fresh.ownerId, instanceToken: fresh.instanceToken, pid: process.pid, nonce: crypto.randomUUID() });
  fs.writeFileSync(guardPath, guard, { flag: "wx" });
  let evidenceRoot;
  const written = [];
  const temporaryPaths = [];
  try {
    const originals = fresh.originals.map(identity => {
      const current = record(identity.path, Math.max(identity.bytes, 65536));
      if (JSON.stringify(publicRecord(current)) !== JSON.stringify(identity)) fail("STARTUP_RECOVERY_ORIGINAL_CHANGED");
      return current;
    });
    requireAbsent(fresh, inspectHost());
    evidenceRoot = path.join(fresh.checkpointRoot, `startup-recovery-${crypto.randomUUID()}`);
    if (!withinRuntimeRoot(fresh.checkpointRoot, evidenceRoot)) fail("STARTUP_RECOVERY_EVIDENCE_ESCAPE");
    fs.mkdirSync(evidenceRoot);
    const manifest = { ...fresh, recoveredAt: new Date().toISOString(), originals: [] };
    for (const [index, original] of originals.entries()) {
      const backupPath = path.join(evidenceRoot, `${index}.original`);
      fs.writeFileSync(backupPath, original.content, { flag: "wx" });
      if (digest(fs.readFileSync(backupPath)) !== original.sha256) fail("STARTUP_RECOVERY_BACKUP_MISMATCH");
      manifest.originals.push({ ...publicRecord(original), backupPath });
    }
    fs.writeFileSync(path.join(evidenceRoot, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    if (fs.existsSync(path.join(input.dataRoot, "state", "codex-app-server-proxy.stop"))) fail("STARTUP_RECOVERY_STOP_OR_RECOVERY_REQUIREMENT_PRESENT");
    for (const original of originals) {
      if (JSON.stringify(publicRecord(record(original.path, Math.max(original.bytes, 65536)))) !== JSON.stringify(publicRecord(original))) {
        fail("STARTUP_RECOVERY_ORIGINAL_CHANGED");
      }
    }
    requireAbsent(fresh, inspectHost());
    const replacements = [fresh.runtimeStatePath, fresh.managedStatePath].map(target => {
      const original = originals.find(entry => entry.path === target);
      const previous = json(original);
      const terminal = target === fresh.runtimeStatePath
        ? { ...previous, state: "stopped", appServerPid: null, automationEnabled: false }
        : { ...previous, state: "closed", healthy: false };
      terminal.startupRecovery = { reason: fresh.historyPolicy === "preserve" ? "verified_dead_process_history_preserved" : "verified_dead_idle_instance",
        evidenceRoot, instanceToken: fresh.instanceToken, ...(fresh.preservedHistory ? { preservedHistory: fresh.preservedHistory } : {}) };
      const content = Buffer.from(JSON.stringify(terminal));
      if (content.length > INNER_RUNTIME_STATE_MAX_BYTES) fail("STARTUP_RECOVERY_OUTPUT_TOO_LARGE");
      return { target, original, content };
    });
    for (const { target, original, content } of replacements) {
      const temporary = path.join(path.dirname(target), `.startup-recovery-${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, content, { flag: "wx" });
      temporaryPaths.push({ path: temporary, sha256: digest(content), bytes: content.length });
      if (record(target, Math.max(original.bytes, content.length)).sha256 !== original.sha256) fail("STARTUP_RECOVERY_ORIGINAL_CHANGED");
      const retiredPath = path.join(evidenceRoot, target === fresh.runtimeStatePath ? "retired-runtime.original" : "retired-managed.original");
      fs.renameSync(target, retiredPath);
      written.push({ original, sha256: digest(content), bytes: content.length, retiredPath });
      fs.renameSync(temporary, target);
    }
    const lease = originals.find(entry => entry.path === fresh.lockPath);
    if (record(fresh.lockPath).sha256 !== lease.sha256) fail("STARTUP_RECOVERY_ORIGINAL_CHANGED");
    fs.writeFileSync(path.join(evidenceRoot, "applied.json"), JSON.stringify({ instanceToken: fresh.instanceToken, written: written.map(entry => ({ path: entry.original.path, sha256: entry.sha256 })) }), { flag: "wx" });
    fs.renameSync(fresh.lockPath, path.join(evidenceRoot, "retired.lock"));
    return { recovered: true, instanceToken: fresh.instanceToken, evidenceRoot };
  } catch (error) {
    for (const entry of written.reverse()) {
      if (!fs.existsSync(entry.original.path) || record(entry.original.path, Math.max(entry.original.bytes, entry.bytes)).sha256 === entry.sha256) {
        if (fs.existsSync(entry.original.path)) fs.unlinkSync(entry.original.path);
        fs.renameSync(entry.retiredPath, entry.original.path);
      }
    }
    const retired = evidenceRoot && path.join(evidenceRoot, "retired.lock");
    if (retired && fs.existsSync(retired) && !fs.existsSync(fresh.lockPath)) fs.renameSync(retired, fresh.lockPath);
    throw error;
  } finally {
    for (const temporary of temporaryPaths) {
      if (fs.existsSync(temporary.path) && record(temporary.path, temporary.bytes).sha256 === temporary.sha256) fs.unlinkSync(temporary.path);
    }
    if (fs.existsSync(guardPath) && fs.readFileSync(guardPath, "utf8") === guard) fs.unlinkSync(guardPath);
  }
}
